/**
 * @file userscript/readingGeneration.ts
 * 文件职责：在独立 userscript 中执行阅读专用流式生成，不引入完整 AI SDK 编排器。
 * 主要内容：复用 Harness 的模型配置、Key 轮转及可见正文规则，将 OpenAI 兼容、Claude 和 Gemini 的流映射为同一工具/消息合同；有界读取、取消和凭据脱敏。
 * 模块边界：只适配已授权的文本与 read_context 工具；提示词、引用校验、工具次数、会话与记忆仍由共享 Harness 执行。不调用普通翻译入口或注入翻译提示词。
 */
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {mergeCustomHeaders, parseCustomHeaders} from '@/src/core/config/customHeaders';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import type {HarnessGenerate, HarnessGenerateInput, HarnessGenerateResult, HarnessToolCall, HarnessToolDefinition} from '@/src/core/harness/loop';
import type {HarnessMessage} from '@/src/core/harness/surface';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {runtimeFetch, cancelUnreadResponseBody} from '@/src/platform/http/runtime';
import {runWithApiKeyRotation, withServiceApiKey, redactApiKeyError} from '@/src/services/translation/apiKeyRotation';
import {endpointFor, zhipuBearer, serviceHeaders, transformBody, snapshotHarnessConfig, normalizeHarnessTransportError} from '@/src/services/harness/modelConfig';
import {createBilibiliVisibleStream} from '@/src/services/harness/visibleStream';
import {normalizeLlmTransportError, LlmTransportError} from '@/src/providers/translation/ai-sdk/transport-errors';
import {resolveOfficialMimoModel} from '@/src/providers/translation/ai-sdk/endpoints';
import {createHarnessUsageEvent} from '@/src/services/harness/usage';
import {normalizeOpenAICompatibleUsage, normalizeClaudeUsage, normalizeGeminiUsage} from '@/src/providers/translation/usage';
import {READ_CONTEXT_INPUT_SCHEMA} from '@/src/services/harness/readContext';

export const normalizeHarnessModelError = normalizeHarnessTransportError;
type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parts = (message: HarnessMessage): RecordValue[] => typeof message.content === 'string' ? [{type: 'text', text: message.content}]
    : Array.isArray(message.content) ? message.content : [];
const text = (message: HarnessMessage) => parts(message).filter(part => part.type === 'text').map(part => part.text).join('');
const output = (part: RecordValue) => part.output?.value ?? '';
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const scalar = (value: unknown): string => {
    if (value == null) return '';
    if (typeof value !== 'string') throw new Error('阅读服务返回了无效字符串字段');
    return value;
};
const array = (value: unknown): any[] => {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error('阅读服务返回了无效列表字段');
    return value;
};
// 此生成端口只承接 Harness 当前唯一的只读工具；约束由共享 validator 再次校验。
const toolSchema = {...READ_CONTEXT_INPUT_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#'};
const googleToolSchema = {type: 'object', properties: {reason: {type: 'string'}}};

function openaiMessages(input: HarnessGenerateInput): RecordValue[] {
    return [{role: 'system', content: input.system}, ...input.messages.flatMap<RecordValue>(message => {
        if (message.role === 'user') return [{role: 'user', content: text(message)}];
        if (message.role === 'tool') return parts(message).map(part => ({role: 'tool', tool_call_id: part.toolCallId, content: output(part)}));
        const calls = parts(message).filter(part => part.type === 'tool-call');
        const reasoning = parts(message).filter(part => part.type === 'reasoning').map(part => part.text).join('');
        return [{role: 'assistant', content: calls.length ? text(message) || null : text(message),
            ...(reasoning ? {reasoning_content: reasoning} : {}), ...(calls.length ? {tool_calls: calls.map(part => ({
                id: part.toolCallId, type: 'function', function: {name: part.toolName, arguments: JSON.stringify(part.input)},
                ...(part.providerOptions?.google?.thoughtSignature ? {extra_content: {google: {thought_signature: part.providerOptions.google.thoughtSignature}}} : {}),
            }))} : {})}];
    })];
}
function claudeMessages(input: HarnessGenerateInput): RecordValue[] {
    const messages: RecordValue[] = [];
    for (const message of input.messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content = parts(message).flatMap<RecordValue>(part => {
            if (part.type === 'text') return [{type: 'text', text: part.text}];
            if (part.type === 'tool-call') return [{type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input}];
            if (part.type === 'tool-result') return [{type: 'tool_result', tool_use_id: part.toolCallId, content: output(part)}];
            if (part.type === 'reasoning') {
                const metadata = part.providerOptions?.anthropic;
                if (metadata?.signature != null) return [{type: 'thinking', thinking: part.text, signature: metadata.signature}];
                if (metadata?.redactedData != null) return [{type: 'redacted_thinking', data: metadata.redactedData}];
            }
            return [];
        });
        const previous = messages.at(-1);
        if (previous?.role === role) previous.content.push(...content);
        else messages.push({role, content});
    }
    return messages;
}
function geminiMessages(input: HarnessGenerateInput, model: string): RecordValue {
    const needsSignature = /(^|\/)gemini-/iu.test(model)
        && !/(^|\/)gemini-(?:[12](?:[.-]|$)|pro(?:-vision)?$|robotics-er-1\.5(?:[.-]|$))/iu.test(model);
    const contents = input.messages.map(message => {
        let signedFunction = false;
        return {role: message.role === 'assistant' ? 'model' : 'user', parts: parts(message).flatMap<RecordValue>(part => {
        const signature = part.providerOptions?.google?.thoughtSignature;
        const signed = signature ? {thoughtSignature: signature} : {};
        if (part.type === 'text') return part.text ? [{text: part.text, ...signed}] : [];
        if (part.type === 'reasoning') return [{text: part.text, thought: true, ...signed}];
        if (part.type === 'tool-call') {
            const effective = signature || (needsSignature && !signedFunction ? 'skip_thought_signature_validator' : undefined);
            if (signature) signedFunction = true;
            return [{functionCall: {name: part.toolName, args: part.input, id: part.toolCallId}, ...(effective ? {thoughtSignature: effective} : {})}];
        }
        if (part.type === 'tool-result') return [{functionResponse: {name: part.toolName, response: {name: part.toolName, content: output(part)}, id: part.toolCallId}}];
        return [];
    })};});
    if (model.toLowerCase().startsWith('gemma-') && contents[0]?.role === 'user') {
        contents[0].parts.unshift({text: input.system});return {contents};
    }
    return {contents, systemInstruction: {parts: [{text: input.system}]}};
}
function prepare(config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[], input: HarnessGenerateInput) {
    const key = config.token[service]?.trim() || '';
    const headers = new Headers({'content-type': 'application/json'});
    if (service === services.claude) {
        if (key) headers.set('x-api-key', key);
        headers.set('anthropic-version', '2023-06-01');headers.set('anthropic-dangerous-direct-browser-access', 'true');
        return {url: config.proxy[service]?.trim() || 'https://api.anthropic.com/v1/messages', headers,
            body: {model, stream: true, max_tokens: 1200, system: [{type: 'text', text: input.system}], messages: claudeMessages(input),
                ...(tools.length ? {tools: tools.map(tool => ({name: tool.name, description: tool.description, input_schema: toolSchema, eager_input_streaming: true})), tool_choice: {type: 'auto'}} : {})}};
    }
    if (service === services.gemini) {
        if (key) headers.set('x-goog-api-key', key);
        // 与共享 gateway 一致：显式代理是完整 endpoint，不追加路径或 query。
        return {url: config.proxy[service]?.trim() || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, headers,
            body: {...geminiMessages(input, model), generationConfig: {maxOutputTokens: 1200},
                ...(tools.length ? {tools: [{functionDeclarations: tools.map(tool => ({name: tool.name, description: tool.description, parameters: googleToolSchema}))}], toolConfig: {functionCallingConfig: {mode: 'AUTO'}}} : {})}};
    }
    if (service === services.bilibili) return {
        url: `https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1/chat/completions`, headers,
        body: {model: BILIBILI_FREE_TRANSLATION_MODEL, messages: openaiMessages(input), stream: true, max_tokens: 1200, temperature: 0, chat_template_kwargs: {enable_thinking: false}},
    };
    const endpoint = endpointFor(config, service, model);
    const url = new URL(endpoint.exactEndpoint || `${endpoint.baseURL.replace(/\/$/u, '')}/chat/completions`);
    if (!endpoint.exactEndpoint && endpoint.queryParams) url.search = new URLSearchParams(endpoint.queryParams).toString();
    if (key && service !== services.azureOpenai) headers.set('authorization', `Bearer ${service === services.zhipu ? zhipuBearer(key) : key}`);
    Object.entries(serviceHeaders(service, key) ?? {}).forEach(([name, value]) => headers.set(name, value));
    const customHeaders = parseCustomHeaders(isCustomOpenAIProviderId(service) ? config.customHeaders[service] : undefined);
    if (!customHeaders) throw new Error('自定义请求头必须是有效的 JSON 对象，头名称和值必须符合 HTTP 格式。');
    return {url: url.toString(), headers: mergeCustomHeaders(headers, customHeaders), body: transformBody(service, config, model, {
        model: resolveOfficialMimoModel(endpoint.endpoint, model), messages: openaiMessages(input), stream: true, max_tokens: 1200,
        ...(tools.length ? {tools: tools.map(tool => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: toolSchema}})), tool_choice: 'auto'} : {}),
    }, endpoint.endpoint)};
}

/** SSE 的 CR/LF 和多行 data 均按事件边界组装；读取上限与 abort 清理不依赖 provider 配合。 */
async function consumeEvents(response: Response, signal: AbortSignal, receive: (value: unknown) => void): Promise<void> {
    if (!response.body) throw new Error('阅读服务返回了空响应');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffered = '', data: string[] = [], size = 0;
    const abort = () => {void reader.cancel().catch(() => undefined);};
    signal.addEventListener('abort', abort, {once: true});
    const dispatch = () => {
        const body = data.join('\n');data = [];
        if (!body || body === '[DONE]') return;
        let value: unknown;try {value = JSON.parse(body);} catch {throw new Error('阅读服务返回了无效的流式数据');}
        // 读后检查至此只有同步解析；receive/onText 才能由外部回调同步取消。
        receive(value);
        if (signal.aborted) throw new DOMException('Reading cancelled', 'AbortError');
    };
    const line = (value: string) => {
        if (value === '') {dispatch();return;}
        if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /u, ''));
    };
    try {
        for (;;) {
            if (signal.aborted) throw new DOMException('Reading cancelled', 'AbortError');
            const chunk = await reader.read();
            if (signal.aborted) throw new DOMException('Reading cancelled', 'AbortError');
            if (chunk.done) {buffered += decoder.decode();break;}
            size += chunk.value.byteLength;if (size > MAX_STREAM_BYTES) throw new Error('阅读服务响应过大');
            buffered += decoder.decode(chunk.value, {stream: true});
            for (;;) {
                const match = /\r\n|\r|\n/u.exec(buffered);if (!match) break;
                // CR 可能位于两个网络块的交界，等待后续字节再消费 CRLF。
                if (match[0] === '\r' && match.index === buffered.length - 1) break;
                line(buffered.slice(0, match.index));buffered = buffered.slice(match.index + match[0].length);
            }
        }
        if (buffered) line(buffered.replace(/\r$/u, ''));
        dispatch();
    } finally {
        signal.removeEventListener('abort', abort);
        // 远端取消握手可能永久挂起；先交还锁，调用方不等待其完成。
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

type PendingCall = {id: string; name: string; input: string; value?: unknown; signature?: string; part?: RecordValue};
async function generate(config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[], input: HarnessGenerateInput,
    captureUsage?: (event: ModelUsageEvent) => void, connected?: () => void): Promise<HarnessGenerateResult> {
    const prepared = prepare(config, service, model, tools, input);
    const startedAt = Date.now();
    const secrets = [...getServiceApiKeys(config, service), ...Object.values(parseCustomHeaders(config.customHeaders[service]) ?? {})];
    try {
    const response = await runtimeFetch(prepared.url, {method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body),
        signal: input.signal, redirect: 'error', ...(service === services.bilibili ? {credentials: 'omit' as const} : {})});
    if (!response.ok) {
        cancelUnreadResponseBody(response);
        throw normalizeLlmTransportError(service, new Error(response.statusText), secrets, input.signal.aborted, {
            message: response.statusText, statusCode: response.status, responseHeaders: Object.fromEntries(response.headers.entries()),
            isRetryable: response.status === 429 || response.status >= 500,
        });
    }
    connected?.();
    let visible = '', reasoning = '', finish = '', actualModel = model, usage: any;
    const calls = new Map<number, PendingCall>();const assistant: RecordValue[] = [];
    const claudeBlocks = new Map<number, RecordValue>();
    let geminiText: RecordValue | undefined, geminiReasoning: RecordValue | undefined, geminiCall: PendingCall | undefined;
    const bili = service === services.bilibili ? createBilibiliVisibleStream() : undefined;
    const append = (value: unknown) => {
        if (value == null) return;if (typeof value !== 'string') throw new Error('阅读服务返回了无效正文');
        const next = bili ? bili.append(value) : visible + value;if (next !== visible) {visible = next;input.onText?.(visible);}
    };
    const pending = (index: unknown) => {
        if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 16) throw new Error('阅读服务返回了无效工具编号');
        let call = calls.get(index as number);if (!call) {call = {id: '', name: '', input: ''};calls.set(index as number, call);}return call;
    };
    await consumeEvents(response, input.signal, raw => {
        if (!object(raw)) throw new Error('阅读服务返回了无效事件');
        if (raw.error || raw.type === 'error') throw new Error('阅读服务返回错误，请重试');
        if (service === services.claude) {
            if (!['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'ping'].includes(scalar(raw.type))) throw new Error('阅读服务返回了未知事件');
            if (raw.type === 'message_start') {actualModel = scalar(raw.message?.model) || model;usage = raw.message?.usage;}
            else if (raw.type === 'content_block_start') {
                const part = raw.content_block;
                if (part?.type === 'tool_use') {const call = pending(raw.index);call.id = part.id;call.name = part.name;call.value = part.input;call.part = {};assistant.push(call.part);}
                else if (part?.type === 'text' || part?.type === 'thinking' || part?.type === 'redacted_thinking') {
                    const block: RecordValue = {type: part.type === 'text' ? 'text' : 'reasoning', text: '',
                        ...(part.type === 'redacted_thinking' ? {providerOptions: {anthropic: {redactedData: part.data}}} : {})};
                    claudeBlocks.set(raw.index, block);assistant.push(block);
                }
            } else if (raw.type === 'content_block_delta') {
                if (raw.delta?.type === 'text_delta' || raw.delta?.type === 'thinking_delta' || raw.delta?.type === 'signature_delta') {
                    const block = claudeBlocks.get(raw.index);if (!block) throw new Error('阅读服务返回了未知正文块');
                    if (raw.delta.type === 'signature_delta') block.providerOptions = {anthropic: {signature: raw.delta.signature}};
                    else {const delta = raw.delta.type === 'text_delta' ? raw.delta.text : raw.delta.thinking;
                        if (typeof delta !== 'string') throw new Error('阅读服务返回了无效正文');
                        block.text += delta;if (raw.delta.type === 'text_delta') append(delta);
                    }
                } else if (raw.delta?.type === 'input_json_delta') pending(raw.index).input += raw.delta.partial_json;
            } else if (raw.type === 'message_delta') {finish = scalar(raw.delta?.stop_reason) || finish;usage = {...usage, ...raw.usage};}
        } else if (service === services.gemini) {
            actualModel = scalar(raw.modelVersion) || actualModel;usage = raw.usageMetadata || usage;
            const candidate = array(raw.candidates)[0];finish = scalar(candidate?.finishReason) || finish;
            for (const part of array(candidate?.content?.parts)) {
                if (!object(part)) throw new Error('阅读服务返回了无效正文块');
                if (part.functionCall) {
                    const fn = part.functionCall;
                    if (!object(fn)) throw new Error('阅读服务工具调用无效');
                    if (fn.partialArgs != null || fn.willContinue === true) {
                        if (fn.name != null) {geminiCall = pending(calls.size);geminiCall.id = fn.id || crypto.randomUUID();geminiCall.name = fn.name;geminiCall.value = {};}
                        if (!geminiCall || fn.partialArgs != null && !Array.isArray(fn.partialArgs)) throw new Error('阅读服务流式工具参数无效');
                        for (const arg of fn.partialArgs ?? []) {
                            // 本端口唯一工具只允许一个可选字符串，拒绝额外/嵌套路径，避免把 JSONPath 当可执行赋值。
                            if (!object(arg) || arg.jsonPath !== '$.reason' || typeof arg.stringValue !== 'string') throw new Error('read_context 工具参数无效');
                            const value = geminiCall.value as {reason?: string};value.reason = (value.reason || '') + arg.stringValue;
                        }
                        geminiCall.signature ||= part.thoughtSignature;
                        if (fn.willContinue !== true && fn.partialArgs.every((arg: RecordValue) => arg.willContinue !== true)) geminiCall = undefined;
                    } else if (fn.name == null && fn.args == null && geminiCall) {geminiCall = undefined;}
                    else {
                        const call = pending(calls.size);call.id = fn.id || crypto.randomUUID();call.name = fn.name;call.signature = part.thoughtSignature;
                        if (typeof fn.args === 'string') call.input = fn.args;else call.value = fn.args;
                    }
                } else if (part.text !== undefined) {
                    if (typeof part.text !== 'string') throw new Error('阅读服务返回了无效正文');
                    let target: RecordValue | undefined;
                    if (!part.text) target = geminiText;
                    else if (part.thought === true) {
                        geminiText = undefined;
                        if (!geminiReasoning) {geminiReasoning = {type: 'reasoning', text: ''};assistant.push(geminiReasoning);}
                        target = geminiReasoning;target.text += part.text;
                    } else {
                        geminiReasoning = undefined;append(part.text);
                        if (!geminiText) {geminiText = {type: 'text', text: ''};assistant.push(geminiText);}
                        target = geminiText;target.text += part.text;
                    }
                    if (target && part.thoughtSignature) target.providerOptions = {google: {thoughtSignature: part.thoughtSignature}};
                }
            }
        } else {
            if (!Array.isArray(raw.choices)) throw new Error('阅读服务返回了无效 choices');
            actualModel = scalar(raw.model) || actualModel;usage = raw.usage || usage;
            const choice = raw.choices[0];finish = scalar(choice?.finish_reason) || finish;
            const delta = choice?.delta;
            if (delta) {
                if (!object(delta)) throw new Error('阅读服务返回了无效 delta');
                append(delta.content);reasoning += scalar(delta.reasoning_content ?? delta.reasoning);
                for (const part of array(delta.tool_calls)) {
                    if (!object(part)) throw new Error('阅读服务返回了无效工具调用');
                    const call = pending(part.index ?? calls.size);
                    if (part.id != null) {if (typeof part.id !== 'string' || call.id && call.id !== part.id) throw new Error('阅读服务工具标识冲突');call.id = part.id;}
                    if (part.function?.name != null) {if (typeof part.function.name !== 'string' || call.name && call.name !== part.function.name) throw new Error('阅读服务工具名称冲突');call.name = part.function.name;}
                    if (part.function?.arguments != null) {if (typeof part.function.arguments !== 'string') throw new Error('阅读服务工具参数无效');call.input += part.function.arguments;}
                    call.signature ||= part.extra_content?.google?.thought_signature;
                }
            }
        }
    });
    if (!finish) throw new Error('阅读服务响应未完成，请重试');
    if (bili) {
        if (finish === 'length') throw new Error('B站讲解已截断，请缩短选文后重试');
        if (finish !== 'stop') throw new Error('B站没有返回完整有效的讲解，请重试');
        visible = bili.finish();
    }
    const toolCalls: HarnessToolCall[] = [...calls.values()].map(call => {
        if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name) throw new Error('阅读服务工具调用缺少标识');
        let value = call.value;
        if (call.input) {try {value = JSON.parse(call.input);} catch {throw new Error('阅读服务工具参数不是有效 JSON');}}
        // 缺省参数使用空对象；显式 null 必须原样交给共享严格校验，不能被转换成合法输入。
        const input = value === undefined ? {} : value;
        const part = {type: 'tool-call', toolCallId: call.id, toolName: call.name, input,
            ...(call.signature ? {providerOptions: {google: {thoughtSignature: call.signature}}} : {})};
        if (call.part) Object.assign(call.part, part);else assistant.push(part);
        return {id: call.id, name: call.name, input};
    });
    if (service !== services.gemini && service !== services.claude) {
        if (visible) assistant.unshift({type: 'text', text: visible});
        if (reasoning && !bili) assistant.unshift({type: 'reasoning', text: reasoning});
    }
    // 私有 generate 的两个调用点只传入本文件的赋值闭包；对外统计回调由工厂 finally 统一隔离。
    if (captureUsage) {
        const normalized = service === services.claude ? normalizeClaudeUsage(usage, actualModel)
            : service === services.gemini ? normalizeGeminiUsage(usage, actualModel) : normalizeOpenAICompatibleUsage(usage, actualModel);
        captureUsage({serviceId: service, configuredModel: model, startedAt, durationMs: Date.now() - startedAt,
            purpose: 'reading', outcome: 'success', ...normalized});
    }

    return {text: visible, assistant: {role: 'assistant', content: assistant}, toolCalls};
    } catch (error) {
        captureUsage?.(createHarnessUsageEvent({service, model, startedAt, durationMs: Date.now() - startedAt,
            outcome: input.signal.aborted ? input.signal.reason instanceof Error && /超时/u.test(input.signal.reason.message) ? 'timeout' : 'cancelled' : 'error'}));
        throw error;
    }
}


export function createHarnessGenerator(config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[], recordUsage?: (event: ModelUsageEvent) => void): HarnessGenerate {
    if (tools.some(tool => tool.name !== 'read_context')) throw new Error('不支持的阅读助手工具');
    if (service !== services.bilibili) {
        model = model.trim();
        if (!model) throw new Error('请先为阅读助手选择一个模型');
        if (!isHarnessService(service, config.customOpenAIProviders)) throw new Error(`阅读助手尚未适配这个服务: ${service}`);
    }
    const frozen = snapshotHarnessConfig(config);
    return async input => {
        const startedAt = Date.now();
        let event: ModelUsageEvent | undefined;
        const capture = recordUsage ? (value: ModelUsageEvent) => {event = value;} : undefined;
        try {
        if (service === services.bilibili) return await generate(frozen, service, model, tools, input, capture);
        const keys = getServiceApiKeys(frozen, service);
        const run = async (selected: Config): Promise<{value: HarnessGenerateResult} | {error: Error}> => {
            let connected = false;
            try {return {value: await generate(selected, service, model, tools, input, capture, () => {connected = true;})};}
            catch (error) {
                const normalized = normalizeHarnessTransportError(error, service, '', frozen.customHeaders[service],
                    (provider, failure, headers) => failure instanceof LlmTransportError
                        ? redactApiKeyError(failure, [...keys, ...headers]) : normalizeLlmTransportError(provider, failure, [...keys, ...headers], input.signal.aborted));
                // 与原 SDK doStream 的轮转边界一致：建连失败可换 Key，已经收到响应后不重放已开始的生成。
                if (connected) return {error: normalized};
                throw normalized;
            }
        };
        const result = keys.length < 2 ? await run(withServiceApiKey(frozen, service, keys[0] ?? ''))
            : await runWithApiKeyRotation(frozen, service, run, {signal: input.signal, model});
        if ('error' in result) throw result.error;
        return result.value;
        } finally {
            if (event) {try {recordUsage?.({...event, startedAt, durationMs: Date.now() - startedAt});} catch { /* 保持原一次生成一条统计，失败回调不影响正文。 */ }}
        }
    };
}
