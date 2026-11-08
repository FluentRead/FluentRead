/**
 * @file src/services/harness/usage.ts
 * 文件职责：把 AI SDK 文本/工具调用结果的用量转换为 FluentRead 本地模型用量事件。
 * 主要内容：固定 reading 用途，保留 provider 报告的缓存与 reasoning 明细，并在用量不完整时省略所有 Token 数值。
 * 模块边界：本文件只做纯数据转换，不写数据库、不读取配置、不发送请求；调用方负责把事件交给模型用量仓库。
 */
import type {LanguageModelUsage} from 'ai';
import type {ModelUsageEvent, ModelUsageOutcome} from '@/src/services/model-usage/types';

function optionalToken(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 将 AI SDK 的缺省 undefined 保持为缺省，避免把未知用量错误记为 0。 */
export function createHarnessUsageEvent(input: {
    service: string;
    model: string;
    actualModel?: string;
    startedAt: number;
    durationMs: number;
    usage?: LanguageModelUsage & {cachedInputTokens?: number; reasoningTokens?: number};
    outcome: ModelUsageOutcome;
}): ModelUsageEvent {
    const usage = input.usage;
    const inputTokens = optionalToken(usage?.inputTokens);
    const outputTokens = optionalToken(usage?.outputTokens);
    const totalTokens = optionalToken(usage?.totalTokens);
    const reported = inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined;
    if (!reported) {
        return {
            startedAt: input.startedAt,
            durationMs: input.durationMs,
            serviceId: input.service,
            configuredModel: input.model,
            purpose: 'reading',
            outcome: input.outcome,
            usageAvailability: usage ? 'malformed' : 'unreported',
        };
    }
    const cacheReadTokens = optionalToken(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens);
    const cacheWriteTokens = optionalToken(usage?.inputTokenDetails?.cacheWriteTokens);
    const reasoningTokens = optionalToken(usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens);
    return {
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        serviceId: input.service,
        configuredModel: input.model,
        ...(input.actualModel?.trim() ? {actualModel: input.actualModel.trim()} : {}),
        purpose: 'reading',
        outcome: input.outcome,
        usageAvailability: 'reported',
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cacheReadTokens !== undefined ? {cachedInputTokens: cacheReadTokens} : {}),
        ...(cacheWriteTokens !== undefined ? {cacheWriteTokens} : {}),
        ...(reasoningTokens !== undefined ? {reasoningTokens} : {}),
    };
}
