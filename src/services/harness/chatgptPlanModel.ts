/**
 * @file src/services/harness/chatgptPlanModel.ts
 * 文件职责：将 ChatGPT 套餐 Responses 协议适配为现有阅读和写作使用的轻量模型端口。
 * 主要内容：保留系统指令、完整多轮文本/图片和本地工具调用历史，将函数分组为 namespace；实时转发文字进度，完整完成后提交工具调用和用量，拒绝截断或失败生成。
 * 模块边界：不另建阅读会话或工具执行器，不接触 OAuth 令牌，不依赖第三方 AI SDK；传输由固定本机助手负责，本地工具继续交由现有 Harness 执行。
 */
import {ChatGPTPlanError, requestChatGPTPlanResponse, type ChatGPTPlanPayload} from '@/src/platform/chatgpt-plan/bridge';
import {readChatGPTPlanStream, streamChatGPTPlanEvents} from '@/src/platform/chatgpt-plan/events';
export type ChatGPTPlanToolResultOutput =
    | {type: 'text'; value: string}
    | {type: 'error-text'; value: string}
    | {type: 'json'; value: unknown}
    | {type: 'error-json'; value: unknown}
    | {type: 'execution-denied'; reason?: string}
    | {type: string; value?: unknown; reason?: string};
export type ChatGPTPlanPromptPart =
    | {type: 'text'; text: string}
    | {type: 'file'; data: string | URL | Uint8Array; mediaType: string}
    | {type: 'tool-call'; toolCallId: string; toolName: string; input: unknown}
    | {type: 'tool-result'; toolCallId: string; toolName?: string; output: ChatGPTPlanToolResultOutput}
    | {type: 'reasoning'; text?: string};
export type ChatGPTPlanPromptMessage =
    | {role: 'system'; content: string}
    | {role: 'user' | 'assistant' | 'tool'; content: readonly ChatGPTPlanPromptPart[]};
export interface ChatGPTPlanModelCall {
    prompt: readonly ChatGPTPlanPromptMessage[];
    tools?: readonly ({type: 'function'; name: string; description?: string; inputSchema: Record<string, unknown>} | {type: 'provider'; name?: string})[];
    toolChoice?: {type: 'auto' | 'none' | 'required' | 'tool'; toolName?: string};
    abortSignal?: AbortSignal;
}
export type ChatGPTPlanResultPart =
    | {type: 'text'; text: string}
    | {type: 'tool-call'; toolCallId: string; toolName: string; input: string};
export interface ChatGPTPlanUsage {
    inputTokens: {total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: undefined};
    outputTokens: {total: number | undefined; text: number | undefined; reasoning: number | undefined};
}
export interface ChatGPTPlanFinishReason {unified: 'stop' | 'tool-calls'; raw: string}
export interface ChatGPTPlanModelResult {
    content: ChatGPTPlanResultPart[];
    finishReason: ChatGPTPlanFinishReason;
    usage: ChatGPTPlanUsage;
    warnings: unknown[];
    response: {id: string | undefined; modelId: string | undefined};
}
export type ChatGPTPlanStreamPart =
    | {type: 'stream-start'; warnings: unknown[]}
    | {type: 'text-start'; id: string}
    | {type: 'text-delta'; id: string; delta: string}
    | {type: 'text-end'; id: string}
    | {type: 'tool-call'; toolCallId: string; toolName: string; input: string}
    | {type: 'finish'; usage: ChatGPTPlanUsage; finishReason: ChatGPTPlanFinishReason};
export interface ChatGPTPlanHarnessModel {
    specificationVersion: 'v3';
    provider: 'fluentread-chatgpt-plan';
    modelId: string;
    supportedUrls: Record<string, RegExp[]>;
    doGenerate(options: ChatGPTPlanModelCall): Promise<ChatGPTPlanModelResult>;
    doStream(options: ChatGPTPlanModelCall): Promise<{stream: ReadableStream<ChatGPTPlanStreamPart>}>;
}
type Model = ChatGPTPlanHarnessModel;
type Call = ChatGPTPlanModelCall;
type Result = ChatGPTPlanModelResult;
type StreamPart = ChatGPTPlanStreamPart;
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function bytesBase64(value: Uint8Array): string {
    let data = '';
    for (let index = 0; index < value.length; index += 8192) data += String.fromCharCode(...value.subarray(index, index + 8192));
    return btoa(data);
}
/** 套餐路由不接受 system item、自定义 HTTP 参数或服务端会话引用。 */
export function buildChatGPTPlanHarnessPayload(model: string, options: Call): ChatGPTPlanPayload {
    const input: unknown[] = [];
    const instructions: string[] = [];
    for (const message of options.prompt) {
        if (message.role === 'system') {instructions.push(message.content); continue;}
        let parts: unknown[] = [];
        const flush = () => {if (parts.length) {input.push({role: message.role, content: parts}); parts = [];}};
        for (const part of message.content) {
            if (part.type === 'text') parts.push({type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text});
            else if (part.type === 'file') {
                if (!part.mediaType.startsWith('image/') || message.role !== 'user') throw new ChatGPTPlanError('invalid_response');
                const url = part.data instanceof URL ? part.data.href : `data:${part.mediaType};base64,${typeof part.data === 'string' ? part.data : bytesBase64(part.data)}`;
                parts.push({type: 'input_image', image_url: url});
            } else if (part.type === 'tool-call') {
                flush();
                input.push({type: 'function_call', call_id: part.toolCallId, name: part.toolName, namespace: 'fluentread', arguments: JSON.stringify(part.input)});
            } else if (part.type === 'tool-result') {
                flush();
                const output = part.output;
                const text = output.type === 'text' || output.type === 'error-text' ? output.value
                    : output.type === 'execution-denied' ? output.reason || 'Tool execution was declined.'
                    : JSON.stringify(output.type === 'json' || output.type === 'error-json' ? output.value : output);
                input.push({type: 'function_call_output', call_id: part.toolCallId, output: text});
            } else if (part.type !== 'reasoning') throw new ChatGPTPlanError('invalid_response');
        }
        flush();
    }
    if (!input.length) throw new ChatGPTPlanError('invalid_response');
    const functionTools = options.tools?.filter(tool => tool.type === 'function');
    if (options.tools?.some(tool => tool.type !== 'function')) throw new ChatGPTPlanError('invalid_response');
    const tools = options.toolChoice?.type === 'none' ? [] : functionTools?.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
    }));
    if (options.toolChoice?.type === 'tool' || options.toolChoice?.type === 'required') throw new ChatGPTPlanError('invalid_response');
    return {model, input, ...(instructions.length ? {instructions: instructions.join('\n\n')} : {}),
        ...(tools?.length ? {tools: [{type: 'namespace', name: 'fluentread', description: 'FluentRead local reading and writing tools.', tools}]} : {})};
}
function count(value: unknown): number | undefined {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;}
export function readChatGPTPlanHarnessResult(response: Record<string, unknown>): Result {
    const content: Result['content'] = [];
    if (!Array.isArray(response.output)) throw new ChatGPTPlanError('invalid_response');
    for (const raw of response.output) {
        const item = record(raw);
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const rawPart of item.content) {
                const part = record(rawPart);
                if (part.type === 'output_text' && typeof part.text === 'string') content.push({type: 'text', text: part.text});
                if (part.type === 'refusal') throw new ChatGPTPlanError('invalid_response');
            }
        } else if (item.type === 'function_call') {
            if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string'
                || item.namespace !== undefined && item.namespace !== 'fluentread') throw new ChatGPTPlanError('invalid_response');
            content.push({type: 'tool-call', toolCallId: item.call_id, toolName: item.name.replace(/^fluentread\./u, ''), input: item.arguments});
        }
    }
    if (!content.length) throw new ChatGPTPlanError('invalid_response');
    const usage = record(response.usage);
    const inputDetails = record(usage.input_tokens_details);
    const outputDetails = record(usage.output_tokens_details);
    const inputTotal = count(usage.input_tokens);
    const cached = count(inputDetails.cached_tokens);
    const outputTotal = count(usage.output_tokens);
    const reasoning = count(outputDetails.reasoning_tokens);
    return {content, finishReason: {unified: content.some(item => item.type === 'tool-call') ? 'tool-calls' : 'stop', raw: 'completed'},
        usage: {inputTokens: {total: inputTotal, noCache: inputTotal !== undefined ? Math.max(0, inputTotal - (cached ?? 0)) : undefined, cacheRead: cached, cacheWrite: undefined},
            outputTokens: {total: outputTotal, text: outputTotal !== undefined ? Math.max(0, outputTotal - (reasoning ?? 0)) : undefined, reasoning}},
        warnings: [], response: {id: typeof response.id === 'string' ? response.id : undefined, modelId: typeof response.model === 'string' ? response.model : undefined}};
}
export function createChatGPTPlanHarnessModel(model: string, respond = requestChatGPTPlanResponse): Model {
    if (!model.trim()) throw new ChatGPTPlanError('invalid_response');
    const requestedModel = model.trim();
    return {specificationVersion: 'v3', provider: 'fluentread-chatgpt-plan', modelId: requestedModel, supportedUrls: {},
        async doGenerate(options) {return readChatGPTPlanHarnessResult(await readChatGPTPlanStream(await respond(buildChatGPTPlanHarnessPayload(requestedModel, options), options.abortSignal), options.abortSignal));},
        async doStream(options) {
            const controller = new AbortController();
            const onAbort = () => controller.abort(options.abortSignal?.reason);
            if (options.abortSignal?.aborted) onAbort();
            else options.abortSignal?.addEventListener('abort', onAbort, {once: true});
            const cleanup = () => options.abortSignal?.removeEventListener('abort', onAbort);
            let response: Response;
            try { response = await respond(buildChatGPTPlanHarnessPayload(requestedModel, options), controller.signal); }
            catch (error) {cleanup();throw error;}
            const iterator = streamChatGPTPlanEvents(response, controller.signal);
            let hasText = false;
            let deltas = '';
            const stream = new ReadableStream<StreamPart>({
                async start(controller) {
                    controller.enqueue({type: 'stream-start', warnings: []});
                    try {
                        for await (const event of iterator) {
                            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                                if (!hasText) {hasText = true; controller.enqueue({type: 'text-start', id: 'text'});}
                                deltas += event.delta;
                                controller.enqueue({type: 'text-delta', id: 'text', delta: event.delta});
                            }
                            if (event.type === 'response.completed') {
                                const result = readChatGPTPlanHarnessResult(record(event.response));
                                const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
                                if (deltas && text !== deltas) throw new ChatGPTPlanError('invalid_response');
                                if (!hasText && text) {hasText = true; controller.enqueue({type: 'text-start', id: 'text'}); controller.enqueue({type: 'text-delta', id: 'text', delta: text});}
                                if (hasText) controller.enqueue({type: 'text-end', id: 'text'});
                                for (const part of result.content) if (part.type === 'tool-call') controller.enqueue(part);
                                controller.enqueue({type: 'finish', usage: result.usage, finishReason: result.finishReason});
                            }
                        }
                        controller.close();
                    } catch (error) {controller.error(error);}
                    finally {cleanup();}
                },
                async cancel() {controller.abort(); cleanup(); await iterator.return(undefined);},
            });
            return {stream};
        },
    };
}
