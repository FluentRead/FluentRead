/**
 * @file src/services/translation/broker/telemetry.ts
 * 文件职责：封装翻译 broker 的模型用量记录与请求统计上报，保证旁路观测只交付标识与规模数值且不中断主流程。
 * 主要内容：提供用量用途与失败口径归类、模型名清洗、有界持久化写入 modelUsage、免费链线路尝试收集、上游耗时累加，以及公开请求结束后的统计事件组装与告警降级。
 * 模块边界：仅依赖 broker/protocol 共享类型及统计度量纯函数，不访问翻译缓存仓库、不发起上游请求，也不修改请求正文或业务结果。
 */

import type {
    TranslationBrokerDependencies,
    TranslationModelUsageObservation,
    TranslationModelUsageOutcome,
    TranslationModelUsageRecord,
    TranslationProviderConfigSnapshot,
    TranslationRequestMessage,
    TranslationRouteObservation,
} from '../types';
import {getTranslationImageInput} from '../requestSnapshot';
import {TranslationProviderDeadlineError} from '../requestDeadline';
import {TranslationRequestSchedulerDeadlineError} from '../requestScheduler';
import {waitForBoundedPersistence} from '../persistenceBarrier';
import {serializeTranslationError} from '../errors';
import {measureImageDataUrlBytes, measureTranslationText} from '@/src/services/translation-stats/measure';
import {
    TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS,
    type TranslationRequestOutcome,
    type TranslationRequestSource,
} from '@/src/services/translation-stats/types';
import type {TranslationRequestExecution, TranslationRequestTrace} from './protocol';

export function modelUsagePurpose(message: TranslationRequestMessage): TranslationModelUsageRecord['purpose'] {
    return 'summaryPrompt' in message && typeof message.summaryPrompt === 'string' && message.summaryPrompt.trim()
        ? 'page-summary'
        : 'translation';
}

export function modelUsageOutcome(error: unknown): TranslationModelUsageOutcome {
    if (error instanceof TranslationProviderDeadlineError
        || error instanceof TranslationRequestSchedulerDeadlineError) return 'timeout';
    if (error && typeof error === 'object') {
        const candidate = error as {kind?: unknown; statusCode?: unknown};
        if (candidate.kind === 'timeout' || candidate.statusCode === 408) return 'timeout';
    }
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    return 'error';
}

export function cleanModelName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, 160);
    return normalized || undefined;
}

function translationRequestSource(trace: TranslationRequestTrace, segmentCount: number): TranslationRequestSource {
    if (trace.shared) return 'shared';
    if (trace.cachedSegments === 0) return 'network';
    return trace.cachedSegments >= segmentCount ? 'cache' : 'partial';
}

export interface BrokerTelemetryOptions {
    readonly deps: TranslationBrokerDependencies;
    readonly now: () => number;
    readonly warn: (message: string, error: unknown) => void;
    readonly getSelectedModel: (
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ) => string;
}

export function createBrokerTelemetry(options: BrokerTelemetryOptions) {
    const {deps, now, warn, getSelectedModel} = options;

    async function persistModelUsage(
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
        observations: readonly TranslationModelUsageObservation[],
        startedAt: number,
        fallbackOutcome: TranslationModelUsageOutcome,
        generation: number,
    ): Promise<void> {
        if (
            !deps.recordModelUsage
            || !deps.serviceTypes.isAI(execution.service)
            || observations.length === 0
        ) return;

        const finishedAt = now();
        const elapsed = Math.max(0, finishedAt - startedAt);
        const configuredModel = getSelectedModel(execution.config, execution.service, message.modelOverride);
        const records: TranslationModelUsageRecord[] = observations.map((observation) => ({
            ...observation,
            startedAt: typeof observation.startedAt === 'number' && Number.isFinite(observation.startedAt)
                ? observation.startedAt
                : startedAt,
            durationMs: typeof observation.durationMs === 'number' && Number.isFinite(observation.durationMs)
                ? Math.max(0, observation.durationMs)
                : observations.length === 1 ? elapsed : 0,
            serviceId: execution.service,
            configuredModel,
            actualModel: cleanModelName(observation.actualModel),
            purpose: modelUsagePurpose(message),
            outcome: observation.outcome ?? fallbackOutcome,
        }));

        await waitForBoundedPersistence(
            Promise.resolve().then(() => deps.recordModelUsage!(records, generation)),
            {
                graceMs: deps.persistenceGraceMs,
                onFailure: (error) => warn('[FluentRead] model usage write failed:', error),
                onTimeout: (error) => warn('[FluentRead] model usage write timed out:', error),
            },
        );
    }

    /** 免费翻译链等内部线路的尝试按上限收集；未注入统计端口时不保留任何观察。 */
    function collectRouteAttempt(trace: TranslationRequestTrace, observation: TranslationRouteObservation): void {
        if (!deps.recordTranslationRequest || trace.routeAttempts.length >= TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS) return;
        trace.routeAttempts.push({
            route: observation.route,
            outcome: observation.outcome,
            durationMs: Math.max(0, observation.durationMs),
            chars: Math.max(0, observation.chars),
        });
    }

    /** 未注入统计端口时不额外读取时钟，保持既有调用路径与注入时钟的读取顺序。 */
    function addUpstreamElapsed(trace: TranslationRequestTrace, startedAt: number): void {
        if (deps.recordTranslationRequest) trace.upstreamMs += Math.max(0, now() - startedAt);
    }

    /** 统计是旁路能力：只交付数值与标识，任何异常都只告警，不影响翻译结果或错误。 */
    function recordTranslationRequest(
        message: TranslationRequestMessage,
        trace: TranslationRequestTrace,
        startedAt: number,
        generation: number,
        outcome: TranslationRequestOutcome,
        result?: string | string[],
        error?: unknown,
    ): void {
        if (!deps.recordTranslationRequest) return;
        try {
            const input = measureTranslationText(message.origin);
            const imageInput = getTranslationImageInput(message);
            const failure = outcome === 'error' || outcome === 'timeout' ? serializeTranslationError(error) : undefined;
            deps.recordTranslationRequest({
                startedAt,
                durationMs: Math.max(0, now() - startedAt),
                serviceId: trace.serviceId || message.serviceOverride || deps.getConfig().service || 'unknown',
                ...(trace.model ? {model: trace.model} : {}),
                mode: imageInput ? 'image' : Array.isArray(message.origin) ? 'batch' : 'single',
                segmentCount: input.segmentCount,
                sourceChars: input.chars,
                sourceBytes: input.bytes + measureImageDataUrlBytes(imageInput),
                ...(result !== undefined ? {resultChars: measureTranslationText(result).chars} : {}),
                source: translationRequestSource(trace, input.segmentCount),
                cachedSegments: trace.cachedSegments,
                upstreamCalls: trace.upstreamCalls,
                upstreamMs: trace.upstreamMs,
                outcome,
                ...(trace.routeAttempts.length > 0 ? {
                    routes: [...new Set(trace.routeAttempts.map((attempt) => attempt.route))],
                    routeAttempts: trace.routeAttempts,
                } : {}),
                ...(failure ? {
                    errorKind: failure.kind,
                    ...(failure.statusCode !== undefined ? {statusCode: failure.statusCode} : {}),
                } : {}),
            }, generation);
        } catch (recordError) {
            warn('[FluentRead] translation stats record failed:', recordError);
        }
    }

    return {
        persistModelUsage,
        collectRouteAttempt,
        addUpstreamElapsed,
        recordTranslationRequest,
    };
}

export type BrokerTelemetry = ReturnType<typeof createBrokerTelemetry>;
