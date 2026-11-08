/**
 * @file src/services/harness/generation.ts
 * 文件职责：将阅读内核的生成端口接入扩展环境使用的 AI SDK 与真实供应商模型。
 * 主要内容：转换历史消息和只读工具声明，消费文本、工具调用及错误流，收集实际用量，并在 B站讲解中验证正文与结束原因。
 * 模块边界：保留 SDK 的供应商协议和取消语义；脚本构建在此自有端口替换轻量传输，阅读循环、权限检查与工具执行继续共享。
 */
import {streamText, tool, type LanguageModel, type ModelMessage, type ToolSet} from 'ai';
import {z} from 'zod';
import type {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import type {HarnessMessage} from '@/src/core/harness/surface';
import type {HarnessGenerate, HarnessGenerateResult, HarnessToolCall, HarnessToolDefinition} from '@/src/core/harness/loop';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {createHarnessLanguageModel} from './modelGateway';
import {createHarnessUsageEvent} from './usage';
import {createBilibiliVisibleStream} from './visibleStream';
export {normalizeHarnessModelError} from './modelGateway';
const READ_CONTEXT_INPUT = z.object({reason: z.string().max(200).optional()}).strict();

function toModelMessages(messages: readonly HarnessMessage[]): ModelMessage[] {
    return messages.map(message => ({role: message.role, content: message.content} as ModelMessage));
}

type UsageSink = (event: ModelUsageEvent) => void;

function makeGenerate(model: LanguageModel, toolSet: ToolSet, service: string, modelId: string, recordUsage?: UsageSink): HarnessGenerate {
    return async input => {
        const startedAt = Date.now();
        const record = (event: ModelUsageEvent) => {
            try { recordUsage?.(event); } catch { /* 本地统计故障不能影响阅读。 */ }
        };
        let text = '';
        const bilibiliText = service === services.bilibili ? createBilibiliVisibleStream() : undefined;
        const toolCalls: HarnessToolCall[] = [];
        try {
            // SDK 默认记录原始 provider 错误；统一交给下方统计及外层脱敏错误路径。
            const result = await streamText({model, instructions: input.system, messages: toModelMessages(input.messages), tools: toolSet, maxRetries: 0, maxOutputTokens: 1200, abortSignal: input.signal, onError: () => {}});
            for await (const part of result.stream) {
                if (part.type === 'text-delta') {
                    if (bilibiliText) {
                        const visible = bilibiliText.append(part.text);
                        if (visible !== text) { text = visible; input.onText?.(text); }
                    } else {
                        text += part.text;
                        input.onText?.(text);
                    }
                } else if (part.type === 'tool-call') {
                    toolCalls.push({id: part.toolCallId, name: part.toolName, input: part.input});
                } else if (part.type === 'error') {
                    throw part.error;
                }
            }
            const {response} = await result.finalStep;
            if (service === services.bilibili) {
                const finishReason = await result.finishReason;
                if (finishReason === 'length') throw new Error('B站讲解已截断，请缩短选文后重试');
                if (finishReason !== 'stop') throw new Error('B站没有返回完整有效的讲解，请重试');
                text = bilibiliText!.finish();
            }
            const usage = await result.usage;
            record(createHarnessUsageEvent({service, model: modelId, actualModel: response.modelId, startedAt, durationMs: Date.now() - startedAt, usage, outcome: 'success'}));
            const assistant = (await result.responseMessages).find(message => message.role === 'assistant');
            return {assistant: {role: 'assistant', content: service === services.bilibili ? [{type: 'text', text}] : assistant?.content ?? [{type: 'text', text}]}, text, toolCalls} satisfies HarnessGenerateResult;
        } catch (error) {
            record(createHarnessUsageEvent({service, model: modelId, startedAt, durationMs: Date.now() - startedAt, outcome: input.signal.aborted ? (input.signal.reason instanceof Error && /超时/u.test(input.signal.reason.message) ? 'timeout' : 'cancelled') : 'error'}));
            throw error;
        }
    };
}

export function createHarnessGenerator(
    config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[], recordUsage?: UsageSink,
): HarnessGenerate {
    const toolSet: ToolSet = Object.fromEntries(tools.map(definition => [definition.name, tool({
        description: definition.description,
        inputSchema: READ_CONTEXT_INPUT,
    })]));
    return makeGenerate(createHarnessLanguageModel(config, service, model), toolSet, service, model, recordUsage);
}
