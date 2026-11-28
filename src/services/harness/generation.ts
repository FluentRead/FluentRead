/**
 * @file src/services/harness/generation.ts
 * 文件职责：为扩展阅读与写作内核装配流式模型生成端口，覆盖常规 AI 服务、B站免费入口与 ChatGPT 套餐通道。
 * 主要内容：提供只读上下文参数校验器，将 ChatGPT 套餐 Responses 流式协议适配为统一 HarnessGenerate 端口，其余服务统一交由轻量 HTTP/SSE modelGateway 执行。
 * 模块边界：不引入第三方 AI SDK 或 Zod；脚本构建通过 userscript/readingGeneration.ts 仅复用轻量 modelGateway，避免携带扩展专用的 ChatGPT 套餐桥接。
 */
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {isTranslationServiceDisabled, TRANSLATION_SERVICE_DISABLED_MESSAGE} from '@/src/core/config/serviceAvailability';
import {getTranslationServiceUnavailableMessage} from '@/src/services/translation/capabilities';
import type {HarnessMessage} from '@/src/core/harness/surface';
import type {HarnessGenerate, HarnessGenerateResult, HarnessToolCall, HarnessToolDefinition} from '@/src/core/harness/loop';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {createChatGPTPlanHarnessModel, type ChatGPTPlanPromptMessage, type ChatGPTPlanPromptPart, type ChatGPTPlanUsage} from './chatgptPlanModel';
import {createHarnessStreamExecutor, type HarnessStreamOptions} from './modelGateway';
import {createHarnessUsageEvent, type HarnessUsage} from './usage';
import {isReadContextInput, READ_CONTEXT_INPUT_SCHEMA} from './readContext';
export {normalizeHarnessModelError} from './modelGateway';

export const readContextInputSchema = {
    jsonSchema: {...READ_CONTEXT_INPUT_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#'},
    safeParse(value: unknown): {success: true; data: {reason?: string}} | {success: false} {
        return isReadContextInput(value) ? {success: true, data: value as {reason?: string}} : {success: false};
    },
} as const;

type UsageSink = (event: ModelUsageEvent) => void;

function toPlanPrompt(system: string, messages: readonly HarnessMessage[]): ChatGPTPlanPromptMessage[] {
    const prompt: ChatGPTPlanPromptMessage[] = system ? [{role: 'system', content: system}] : [];
    for (const message of messages) {
        const content = typeof message.content === 'string'
            ? [{type: 'text', text: message.content} satisfies ChatGPTPlanPromptPart]
            : Array.isArray(message.content) ? message.content as ChatGPTPlanPromptPart[] : [];
        prompt.push({role: message.role, content});
    }
    return prompt;
}

function toHarnessUsage(usage: ChatGPTPlanUsage): HarnessUsage {
    const inputTokens = usage.inputTokens.total;
    const outputTokens = usage.outputTokens.total;
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
        inputTokenDetails: {noCacheTokens: usage.inputTokens.noCache, cacheReadTokens: usage.inputTokens.cacheRead, cacheWriteTokens: usage.inputTokens.cacheWrite},
        outputTokenDetails: {textTokens: usage.outputTokens.text, reasoningTokens: usage.outputTokens.reasoning},
    };
}

function createChatGPTPlanGenerator(
    model: string, tools: readonly HarnessToolDefinition[], recordUsage?: UsageSink, options: HarnessStreamOptions = {},
): HarnessGenerate {
    const planModel = createChatGPTPlanHarnessModel(model);
    const purpose = options.purpose ?? 'reading';
    const planTools = tools.map(tool => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) && 'properties' in tool.input
            ? tool.input : READ_CONTEXT_INPUT_SCHEMA) as Record<string, unknown>,
    }));
    return async input => {
        const startedAt = Date.now();
        const record = (event: ModelUsageEvent) => {
            try {recordUsage?.({...event, purpose});} catch { /* 本地统计故障不能影响生成。 */ }
        };
        let text = '';
        const toolCalls: HarnessToolCall[] = [];
        const assistantParts: Record<string, unknown>[] = [];
        let finishReason = '';
        let usage: HarnessUsage | undefined;
        try {
            const {stream} = await planModel.doStream({
                prompt: toPlanPrompt(input.system, input.messages),
                ...(planTools.length ? {tools: planTools} : {}),
                abortSignal: input.signal,
            });
            const reader = stream.getReader();
            try {
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    const part = next.value;
                    if (part.type === 'text-delta') {
                        text += part.delta;
                        input.onText?.(text);
                    } else if (part.type === 'tool-call') {
                        let parsedInput: unknown;
                        try {parsedInput = JSON.parse(part.input);} catch {throw new Error('阅读服务工具参数不是有效 JSON');}
                        toolCalls.push({id: part.toolCallId, name: part.toolName, input: parsedInput});
                        assistantParts.push({type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: parsedInput});
                    } else if (part.type === 'finish') {
                        usage = toHarnessUsage(part.usage);
                        finishReason = part.finishReason.unified;
                    }
                }
            } finally {
                reader.releaseLock();
            }
            if (text) assistantParts.unshift({type: 'text', text});
            options.validateStep?.({text, toolCalls, actualModel: planModel.modelId, finishReason});
            record(createHarnessUsageEvent({
                service: services.chatgptPlan, model: planModel.modelId, actualModel: planModel.modelId,
                startedAt, durationMs: Date.now() - startedAt, usage, outcome: 'success',
            }));
            return {assistant: {role: 'assistant', content: assistantParts}, text, toolCalls} satisfies HarnessGenerateResult;
        } catch (error) {
            record(createHarnessUsageEvent({
                service: services.chatgptPlan, model: planModel.modelId, startedAt, durationMs: Date.now() - startedAt,
                outcome: input.signal.aborted ? (input.signal.reason instanceof Error && /超时/u.test(input.signal.reason.message) ? 'timeout' : 'cancelled') : 'error',
            }));
            throw error;
        }
    };
}

export function createHarnessGenerator(
    config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[],
    recordUsage?: UsageSink, options: HarnessStreamOptions = {},
): HarnessGenerate {
    if (service === services.chatgptPlan) {
        if (isTranslationServiceDisabled(config.disabledTranslationServices, service)) throw new Error(TRANSLATION_SERVICE_DISABLED_MESSAGE);
        const allowedTools = options.allowedTools ?? ['read_context'];
        if (tools.some(tool => !allowedTools.includes(tool.name))) throw new Error('不支持的阅读助手工具');
        const unavailable = getTranslationServiceUnavailableMessage(service);
        if (unavailable) throw Object.assign(new Error(unavailable), {kind: 'bad-request', retryable: false});
        return createChatGPTPlanGenerator(model, tools, recordUsage, options);
    }
    return createHarnessStreamExecutor(config, service, model, tools, recordUsage, options);
}
