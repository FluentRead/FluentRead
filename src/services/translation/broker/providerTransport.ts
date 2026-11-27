/**
 * @file src/services/translation/broker/providerTransport.ts
 * 文件职责：封装翻译 broker 对单个 provider 的调度入场、超时取消、API Key 轮换、隐私与术语保护及观测采集。
 * 主要内容：实现 provider 适配器解析（含自定义 OpenAI 兼容回退）、多 Key 轮换与 B站/硅基流动 Hunyuan-MT-7B 字面 emoji 严格校验重试、调度租约持有、紧凑 JSON 批次封装解析，以及成功/失败后的模型用量口径校准与持久化。
 * 模块边界：负责单次上游调用的传输生命周期，依赖 broker/protocol 与 broker/telemetry 及翻译调度器，不处理持久化翻译缓存、在途去重或语义级上下文泄漏重译。
 */

import {
    TRANSLATION_COMPACT_BATCH,
    type TranslationBrokerDependencies,
    type TranslationModelUsageObservation,
    type TranslationProvider,
    type TranslationRequestMessage,
} from '../types';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestScheduler,
    attachTranslationRouteObserver,
    getTranslationImageInput,
    getTranslationProviderConfig,
} from '../requestSnapshot';
import {parseCompactBatch} from '../compactBatch';
import {normalizeDeadlineTimeoutMs, TranslationProviderDeadlineError} from '../requestDeadline';
import {prepareGlossaryRequest, prepareLiteralEmojiRetry} from '../glossaryProtection';
import {runWithApiKeyRotation} from '../apiKeyRotation';
import {
    type TranslationRequestScheduler,
    TranslationRequestSchedulerDeadlineError,
} from '../requestScheduler';
import {serializeTranslationError} from '../errors';
import {preparePrivacyRequest} from '../privacyProtection';
import {currentConfiguredModel} from '../templates';
import type {createTranslationIdentityPolicy} from '../requestIdentity';
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {services} from '@/src/core/config/catalog';
import {isDoubaoSeedTranslationModel} from '@/src/core/config/doubaoSeedTranslation';
import {
    getRemainingDeadlineMs,
    requestAbortError,
    throwIfRequestAborted,
    type TranslationRequestExecution,
} from './protocol';
import {modelUsageOutcome, type BrokerTelemetry} from './telemetry';

type IdentityPolicy = Pick<
    ReturnType<typeof createTranslationIdentityPolicy>,
    'getSelectedModel' | 'getEffectiveRequestModel'
>;

export interface BrokerProviderTransportOptions {
    readonly deps: TranslationBrokerDependencies;
    readonly now: () => number;
    readonly requestScheduler: TranslationRequestScheduler;
    readonly identity: IdentityPolicy;
    readonly quotaDigest: (execution: TranslationRequestExecution, model: string, transport?: boolean) => string;
    readonly telemetry: BrokerTelemetry;
}

export function createBrokerProviderTransport(options: BrokerProviderTransportOptions) {
    const {deps, now, requestScheduler, identity, quotaDigest, telemetry} = options;
    const {getSelectedModel, getEffectiveRequestModel} = identity;

    function getTranslationService(serviceName: string): TranslationProvider {
        const service = deps.providers[serviceName]
            || (isCustomOpenAIProviderId(serviceName)
                ? deps.providers[LEGACY_CUSTOM_OPENAI_PROVIDER_ID]
                : undefined);
        if (!service) throw new Error(`未找到翻译服务适配器: ${serviceName}`);
        return service;
    }

    /**
     * 把 requestTimeoutMs 落实为 broker 拥有的 provider 截止时间。
     *
     * content 端停止等待 runtime message 并不会取消 background 中的 fetch；如果只把
     * timeout 数字传给 provider，未实现 AbortSignal 的旧适配器会让 pending Map 永久
     * 保留。这里无论 provider 是否主动消费 abortSignal，都会在截止时间释放调用方和
     * pending 所有权；支持 AbortSignal 的适配器还能同步停止底层请求。
     */
    async function callProviderAttemptWithinDeadline(
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
        compactBatch: boolean,
        restoreLiteralEmoji?: (result: unknown) => string,
    ): Promise<unknown> {
        throwIfRequestAborted(execution.abortSignal);
        const timeoutMs = normalizeDeadlineTimeoutMs(message.requestTimeoutMs as number);
        const providerDeadline = now() + timeoutMs;
        const model = getTranslationImageInput(message)
            ? getEffectiveRequestModel({...execution.config, customBody: {}}, execution.service, message.modelOverride)
            : getEffectiveRequestModel(execution.config, execution.service, message.modelOverride);
        const isAiSdk = deps.serviceTypes.isAiSdk(execution.service)
            && !(execution.service === services.doubao && isDoubaoSeedTranslationModel(
                currentConfiguredModel(execution.config, execution.service, message.modelOverride),
            ));
        const identityScope = {
            service: execution.service, model,
            ...(deps.serviceTypes.isAI(execution.service) ? {quotaScope: quotaDigest(execution, model, true)} : {}),
        };

        try {
            return await requestScheduler.schedule(async (lease) => {
                const controller = new AbortController();
                const externalAbortListenerCleanup = new AbortController();
                const externalAbort = new Promise<never>((_resolve, reject) => {
                    if (!execution.abortSignal) return;
                    execution.abortSignal.addEventListener(
                        'abort',
                        () => {
                            controller.abort();
                            reject(requestAbortError());
                        },
                        {once: true, signal: externalAbortListenerCleanup.signal},
                    );
                });

                try {
                    // 外部取消先取得监听所有权，再执行可能同步触发依赖回调的 provider 准备步骤。
                    const provider = getTranslationService(execution.service);
                    const remainingTimeoutMs = getRemainingDeadlineMs(providerDeadline, now);
                    const startedAt = now();
                    execution.trace.upstreamCalls += 1;
                    const usageGeneration = deps.captureModelUsageGeneration?.() ?? 0;
                    const observations: TranslationModelUsageObservation[] = [];
                    const providerMessage = attachTranslationRequestScheduler(attachTranslationRouteObserver(
                        attachTranslationModelUsageObserver({
                            ...message,
                            // 外层排队已消费预算；传给内部 freepool/数组 worker 的只能是入场后剩余值。
                            requestTimeoutMs: remainingTimeoutMs,
                            abortSignal: controller.signal,
                        }, (observation) => observations.push({...observation})),
                        (observation) => telemetry.collectRouteAttempt(execution.trace, observation),
                    ), requestScheduler, identityScope, isAiSdk ? undefined : lease, providerDeadline);

                    let timer: ReturnType<typeof setTimeout>;
                    const timeout = new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(new TranslationProviderDeadlineError());
                        }, remainingTimeoutMs);
                    });
                    const operation = Promise.resolve().then(async () => {
                        throwIfRequestAborted(execution.abortSignal);
                        const privacy = preparePrivacyRequest(providerMessage, execution.config);
                        try {
                            if (restoreLiteralEmoji) return restoreLiteralEmoji(privacy.restore(await provider({...privacy.message})));
                            const protectedRequest = prepareGlossaryRequest(privacy.message, privacy.config);
                            const sources = protectedRequest.message.origin;
                            if (compactBatch && Array.isArray(sources)) {
                                const compact = attachTranslationProviderConfig({
                                    ...protectedRequest.message, origin: JSON.stringify(sources),
                                }, Object.freeze({
                                    ...getTranslationProviderConfig(protectedRequest.message, privacy.config),
                                    [TRANSLATION_COMPACT_BATCH]: true as const,
                                }));
                                const translated = parseCompactBatch(await provider(compact), sources.length);
                                return privacy.restore(protectedRequest.restore(translated));
                            }
                            return privacy.restore(protectedRequest.restore(await provider({...protectedRequest.message})));
                        } finally {privacy.dispose();}
                    });
                    // 调度调用方可能已因 deadline/取消收到结果，但真实 provider transport
                    // 仍需结束后才能释放后台并发槽，避免旧请求与新请求叠加。
                    lease.holdUntil(operation);

                    try {
                        const result = await Promise.race([operation, timeout, externalAbort]);
                        clearTimeout(timer!);
                        telemetry.addUpstreamElapsed(execution.trace, startedAt);
                        await telemetry.persistModelUsage(execution, message, observations, startedAt, 'success', usageGeneration);
                        return result;
                    } catch (error) {
                        clearTimeout(timer!);
                        telemetry.addUpstreamElapsed(execution.trace, startedAt);
                        const lastObservation = observations.at(-1);
                        const errorOutcome = modelUsageOutcome(error);
                        const outcome = errorOutcome === 'error' && lastObservation?.statusCode === 408
                            ? 'timeout'
                            : errorOutcome;
                        // Broker 自有 deadline 会先 abort transport；HTTP 408 也可能被第三方适配器先记为普通失败。
                        // 两者都校准为 timeout，避免同一种超时被拆成不同统计口径。
                        // 不覆盖更早的 success：批量下一项可能在真正 fetch 前就耗尽预算。
                        if (
                            outcome === 'timeout'
                            && (lastObservation?.outcome === 'cancelled' || lastObservation?.outcome === 'error')
                        ) {
                            lastObservation.outcome = 'timeout';
                        }
                        await telemetry.persistModelUsage(execution, message, observations, startedAt, outcome, usageGeneration);
                        throw error;
                    }
                } finally {
                    externalAbortListenerCleanup.abort();
                }
            }, {
                signal: execution.abortSignal,
                deadlineAt: providerDeadline,
                identity: identityScope,
                countRate: !isAiSdk,
                countConcurrency: !isAiSdk,
            });
        } catch (error) {
            if (error instanceof TranslationRequestSchedulerDeadlineError) {
                throw new TranslationProviderDeadlineError();
            }
            throw error;
        }
    }

    async function callProviderWithinDeadline(
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
        compactBatch = false,
    ): Promise<unknown> {
        const deadlineAt = now() + normalizeDeadlineTimeoutMs(message.requestTimeoutMs as number);
        const model = getSelectedModel(execution.config, execution.service, message.modelOverride);
        const invoke = (restoreLiteralEmoji?: (result: unknown) => string) => runWithApiKeyRotation(
            execution.config, execution.service,
            (selected, attempt) => callProviderAttemptWithinDeadline({...execution, config: selected}, attachTranslationProviderConfig({
                ...message,
                enableNativeBatch: message.enableNativeBatch ?? execution.nativeBatchEnabled,
                requestTimeoutMs: attempt.attemptTimeoutMs ?? getRemainingDeadlineMs(deadlineAt, now),
            }, selected), compactBatch, restoreLiteralEmoji),
            {signal: execution.abortSignal, deadlineAt, now, model},
        );
        try {
            return await invoke();
        } catch (error) {
            // B站也可能删除正文内 emoji 的占位符；仅在已有严格字面校验允许时重试一次。
            if ((execution.service !== services.bilibili && (execution.service !== services.siliconCloud
                || getEffectiveRequestModel(execution.config, execution.service, message.modelOverride) !== 'tencent/Hunyuan-MT-7B'))
                || serializeTranslationError(error).code !== 'GLOSSARY_PLACEHOLDER_INVALID'
                || getTranslationImageInput(message)) throw error;
            const restoreLiteralEmoji = prepareLiteralEmojiRetry(message, execution.config);
            if (!restoreLiteralEmoji) throw error;
            return invoke(restoreLiteralEmoji);
        }
    }

    return {
        callProviderWithinDeadline,
    };
}
