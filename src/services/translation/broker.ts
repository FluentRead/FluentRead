/**
 * @file src/services/translation/broker.ts
 *
 * 文件职责：编排翻译请求的配置快照、语言解析、缓存、请求去重、超时与 provider 调用，是后台翻译用例的中心服务。
 * 主要内容：createTranslationBroker 同时支持单条、批量和页面摘要，验证 provider 返回数量和类型，对完整多段协议逐槽修复上下文回显，以包含 Chrome auto 检测样本的完整身份构建缓存键，并按匿名额度身份、等待策略、清理代次与剩余 deadline 隔离 pending 请求。 可核对的公开符号包括 createTranslationBroker、聚合导出。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import type {
    TranslationBatchRequestMessage,
    TranslationBroker,
    TranslationBrokerDependencies,
    TranslationModelUsageObservation,
    TranslationModelUsageOutcome,
    TranslationModelUsageRecord,
    TranslationProviderConfigSnapshot,
    TranslationProvider,
    TranslationRequestMessage,
    TranslationSingleRequestMessage,
} from './types';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
    getTranslationGlossaryContext,
    getTranslationProviderConfig,
    getTranslationGlossarySourceText,
    getTranslationGlossaryTerms,
    getTranslationRequestControl,
    TRANSLATION_REMAINING_BUDGET,
    type TranslationRemainingBudgetContext,
} from './requestSnapshot';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/public';
import {buildGlossaryRevision, resolveGlossary} from '@/src/core/glossary';
import {supportsTranslationGlossary} from './capabilities';
import {
    isDefinitePageContextLeak,
    isLikelyPageContextLeak,
} from '@/src/core/translation/prompts';
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
    normalizeFreeTranslationCooldownMs,
} from '@/src/core/config/freeTranslation';
import sha256 from 'crypto-js/sha256';
import {getDeepLEndpoint} from '@/src/core/config/deepl';
import {waitForBoundedPersistence} from './persistenceBarrier';
import {
    createTranslationRequestScheduler,
    TranslationRequestSchedulerDeadlineError,
} from './requestScheduler';

export type {
    TranslationBatchRequestMessage,
    TranslationBroker,
    TranslationBrokerDependencies,
    TranslationConfigSnapshot,
    TranslationProviderConfigSnapshot,
    TranslationLanguageOverride,
    TranslationProvider,
    TranslationProviderRegistry,
    TranslationRequestMessage,
    TranslationRequestMessageBase,
    TranslationSingleRequestMessage,
} from './types';

type CacheRequestMode = 'single' | 'batch' | 'ai-multi-segment';

interface TranslationRequestExecution {
    readonly config: TranslationProviderConfigSnapshot;
    readonly service: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly enableAIContext: boolean;
    readonly thinking: boolean;
    readonly abortSignal?: AbortSignal;
    readonly ownershipKey?: string;
}

interface PendingCacheValue {
    readonly generation: number;
    readonly value: string;
}

const PAGE_SUMMARY_CACHE_SIZE = 8;
const PAGE_SUMMARY_LIMIT = 1200;
const DEFAULT_PROVIDER_TIMEOUT_MS = 45_000;

class TranslationProviderDeadlineError extends Error {
    constructor() {
        super('翻译请求超时');
        this.name = 'TranslationProviderDeadlineError';
    }
}

class AIMultiSegmentResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'AI_MULTI_SEGMENT_RESPONSE_INVALID';

    constructor() {
        super('AI 多段翻译返回格式异常，已切换为逐段翻译');
        this.name = 'AIMultiSegmentResponseError';
    }
}

class AIContextRecoveryResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'AI_CONTEXT_LEAK_AFTER_RECOVERY';

    constructor() {
        super('AI 翻译在无上下文重试后仍返回了网页参考内容，已停止展示并跳过缓存');
        this.name = 'AIContextRecoveryResponseError';
    }
}

class GlossaryRevisionChangedError extends Error {
    readonly kind = 'bad-request';
    readonly retryable = false;
    readonly code = 'GLOSSARY_REVISION_CHANGED';

    constructor() {
        super('术语库已更新，请重新翻译');
        this.name = 'GlossaryRevisionChangedError';
    }
}

export function createTranslationBroker(deps: TranslationBrokerDependencies): TranslationBroker {
    const pendingTranslations = new Map<string, Promise<string>>();
    const pendingBatches = new Map<string, Promise<string[]>>();
    const pageSummaryCache = new Map<string, string>();
    const pendingPageSummaries = new Map<string, Promise<string>>();
    const pendingCacheWrites = new Map<Promise<unknown>, number>();
    const pendingCacheValues = new Map<string, PendingCacheValue>();
    let cacheGeneration = 0;
    let cacheClearBarrier: Promise<void> | null = null;
    const now = deps.now ?? (() => Date.now());
    const logger = deps.logger ?? console;
    const requestScheduler = createTranslationRequestScheduler(
        () => deps.getConfig() as unknown as {
            maxConcurrentTranslations?: unknown;
            translationRequestsPerSecond?: unknown;
            translationRequestsPerMinute?: unknown;
        },
        {now},
    );

    function warn(message: string, error: unknown): void {
        try {
            logger.warn(message, error);
        } catch {
            // 步骤 1：诊断器是旁路依赖；自定义 logger 失败不能中断用户翻译。
        }
    }

    function config() {
        return deps.getConfig();
    }

    function getSelectedModel(
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ): string {
        return deps.resolveConfiguredModel(
            modelOverride || current.model[service],
            modelOverride || current.customModel[service],
        );
    }

    function isPromptBasedAI(
        current: TranslationProviderConfigSnapshot,
        service: string,
        modelOverride?: string,
    ): boolean {
        return deps.serviceTypes.isUseAIContext(service, getSelectedModel(current, service, modelOverride));
    }

    function isAIContextEnabled(
        execution: TranslationRequestExecution,
        modelOverride?: string,
    ): boolean {
        return execution.enableAIContext && isPromptBasedAI(
            execution.config,
            execution.service,
            modelOverride,
        );
    }

    function getProviderEndpoint(current: TranslationProviderConfigSnapshot, service: string): string {
        // 这些路径固定使用匿名端点，残留代理不能分裂缓存或在途去重。
        if (service === 'freeTranslation' || service === 'myMemory' || service === 'apertium') return '';
        if (deps.serviceTypes.isAiSdk(service)) {
            try {
                return deps.endpointResolver.resolveOpenAICompatibleEndpoint(service, current).endpoint;
            } catch {
                // 步骤 1：配置校验负责用户可见错误；缓存 key 生成必须在设置缺失时仍可完成。
                return '';
            }
        }
        if (service === 'deepL') return getDeepLEndpoint(current.deeplApiPlan, current.proxy[service]);
        if (current.proxy[service]) return current.proxy[service];
        if (service === 'custom') return current.custom;
        if (service === 'deeplx') return current.deeplx;
        if (service === 'newapi') return current.newApiUrl;
        if (service === deps.serviceIds.minimax) {
            const plan = current.minimaxBillingPlan === 'token-plan' ? 'token-plan' : 'payg';
            const region = current.minimaxRegion === 'cn' ? 'cn' : 'global';
            return deps.endpointResolver.minimaxEndpoints[plan]?.[region] || '';
        }
        if (service === deps.serviceIds.mimo) {
            return deps.endpointResolver.getMimoEndpoint(current.mimoBillingPlan, current.mimoRegion);
        }
        return '';
    }

    function buildCacheKey(
        execution: TranslationRequestExecution,
        origin: string | string[],
        context: string,
        pageContext: string,
        mode: CacheRequestMode,
        modelOverride?: string,
        sourceLanguageDetectionText?: string,
    ): string {
        const {config: current, service, sourceLanguage, targetLanguage} = execution;
        const glossaryTerms = getTranslationGlossaryTerms(current, origin);

        return deps.buildTranslationCacheKey({
            requestMode: mode,
            sourceText: origin,
            sourceLanguage,
            targetLanguage,
            service,
            model: getSelectedModel(current, service, modelOverride),
            endpoint: getProviderEndpoint(current, service),
            azureOpenaiEndpoint: service === 'azureOpenai' ? current.azureOpenaiEndpoint : undefined,
            ...(service === 'freeTranslation' ? {freeTranslationPolicy: {
                // v2 仅使用免密钥端点，旧链的私有地址和凭据不再影响此缓存。
                version: 2,
                order: current.freeTranslationOrder,
            }} : {}),
            customBody: current.customBody[service] || '',
            systemRole: current.system_role[service] || '',
            userRole: current.user_role[service] || '',
            ...(glossaryTerms.length ? {glossaryTerms} : {}),
            deepseekApiType: current.deepseekApiType,
            modelThinking: execution.thinking,
            transportProfile: deps.serviceTypes.isAiSdk(service)
                ? deps.endpointResolver.aiSdkTransportProfile
                : undefined,
            // 步骤 1：DeepL 把标题上下文直接发送给 provider；AI adapter 通过 prompt 注入页面上下文。
            context: service === 'deepL' ? context : undefined,
            pageContext: isAIContextEnabled(execution, modelOverride) ? pageContext : undefined,
            ...(service === 'chromeTranslator'
                && sourceLanguage === 'auto'
                && sourceLanguageDetectionText?.trim()
                ? {sourceLanguageDetectionText}
                : {}),
        });
    }

    function buildBatchItemCacheKey(
        execution: TranslationRequestExecution,
        origin: string,
        itemIndex: number,
        batchOrigins: readonly string[],
        context: string,
        pageContext: string,
        mode: CacheRequestMode,
        modelOverride?: string,
    ): string {
        // AI 多段结果会受同批邻段影响，不能只按当前 origin 复用到另一种组合。
        // 把槽位序号和当前项放在首位，再携带完整有序批次；同批重复原文也不会被错误折叠。
        const sourceIdentity = mode === 'ai-multi-segment'
            ? [`slot:${itemIndex}`, origin, ...batchOrigins]
            : origin;
        return buildCacheKey(
            execution,
            sourceIdentity,
            context,
            pageContext,
            mode,
            modelOverride,
        );
    }

    function isCacheEnabled(current: TranslationProviderConfigSnapshot, message: TranslationRequestMessage): boolean {
        return current.useCache && message.useCache !== false;
    }

    function normalizeTranslationComparable(value: string): string {
        return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    }

    function isCacheableResult(_origin: string, result: unknown): result is string {
        // provider 成功返回原文通常表示内容已经是目标语言；仍需缓存这个 no-op，
        // 否则短纯 Han 等无法在请求前可靠识别的文本会在每轮全文翻译中重复请求。
        return typeof result === 'string'
            && Boolean(result.trim());
    }

    function requireSingleResult(result: unknown): string {
        if (typeof result !== 'string') throw new Error('单条翻译返回格式异常');
        return result;
    }

    function requireBatchResult(result: unknown, expectedLength: number): string[] {
        if (!Array.isArray(result)) throw new Error('批量翻译返回格式异常');
        if (result.length !== expectedLength) throw new Error('批量翻译返回数量异常');
        const denseResult = Array.from({length: expectedLength}, (_, index) => result[index]);
        if (denseResult.some((value) => typeof value !== 'string')) {
            throw new Error('批量翻译返回格式异常');
        }
        return denseResult as string[];
    }

    function getTranslationService(serviceName: string): TranslationProvider {
        const service = deps.providers[serviceName]
            || (isCustomOpenAIProviderId(serviceName)
                ? deps.providers[LEGACY_CUSTOM_OPENAI_PROVIDER_ID]
                : undefined);
        if (!service) throw new Error(`未找到翻译服务适配器: ${serviceName}`);
        return service;
    }

    /** 公开请求至少保留一秒，避免调用方误传 0 导致请求永远无法启动。 */
    function normalizeExternalRequestTimeoutMs(requestTimeoutMs?: number): number | undefined {
        return typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs)
            ? Math.max(1_000, Math.floor(requestTimeoutMs))
            : undefined;
    }

    /** 内部剩余预算必须保持精确，不能再次抬高到公开请求的一秒下限。 */
    function normalizeDeadlineTimeoutMs(requestTimeoutMs: number): number {
        return Math.max(1, Math.floor(requestTimeoutMs));
    }

    function getRemainingDeadlineMs(requestDeadline: number): number {
        const remaining = Math.floor(requestDeadline - now());
        if (remaining <= 0) throw new TranslationProviderDeadlineError();
        return remaining;
    }

    async function runWithinDeadline<T>(
        operation: () => Promise<T>,
        requestDeadline: number,
        signal?: AbortSignal,
    ): Promise<T> {
        throwIfRequestAborted(signal);
        const remaining = getRemainingDeadlineMs(requestDeadline);

        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new TranslationProviderDeadlineError()), remaining);
        });
        const abortListenerCleanup = new AbortController();
        const aborted = new Promise<never>((_resolve, reject) => {
            if (!signal) return;
            signal.addEventListener(
                'abort',
                () => reject(requestAbortError()),
                {once: true, signal: abortListenerCleanup.signal},
            );
        });
        try {
            // 先注册取消监听，再启动可能同步改变 signal 的操作，关闭检查与监听之间的窗口。
            const work = operation();
            return await Promise.race([work, timeout, aborted]);
        } finally {
            clearTimeout(timer!);
            abortListenerCleanup.abort();
        }
    }

    async function waitForCacheClearBarrier(requestDeadline: number, signal?: AbortSignal): Promise<void> {
        // clear 可以在等待期间再次串联；只有观察到的 barrier 仍是最新值时，
        // 才允许缓存请求继续，避免在两个连续 clear 之间读到或写入缓存。
        while (cacheClearBarrier) {
            const barrier = cacheClearBarrier;
            await runWithinDeadline(() => barrier, requestDeadline, signal);
        }
    }

    function applyRemainingDeadline<T extends TranslationRequestMessage>(
        message: T,
        requestDeadline: number,
    ): T {
        const remaining = getRemainingDeadlineMs(requestDeadline);
        return {...message, requestTimeoutMs: remaining};
    }

    function buildPendingRequestKey(
        cacheKey: string,
        requestTimeoutMs: number,
        requestGeneration: number,
    ): string {
        const normalizedTimeoutMs = normalizeDeadlineTimeoutMs(requestTimeoutMs);
        return `${cacheKey}:generation:${requestGeneration}:timeout:${normalizedTimeoutMs}ms`;
    }

    function pendingOwnershipSuffix(execution: TranslationRequestExecution): string {
        const ownershipKey = execution.ownershipKey;
        return ownershipKey ? `:owner:${ownershipKey.length}:${ownershipKey}` : '';
    }

    function pendingAnonymousConfigSuffix(execution: TranslationRequestExecution): string {
        const {service, config: current} = execution;
        if (service !== 'freeTranslation' && service !== 'myMemory') return '';
        const usesMyMemory = service === 'myMemory'
            || normalizeFreeTranslationOrder(current.freeTranslationOrder).includes('myMemory');
        // 成功译文可跨额度身份复用；正在执行的旧邮箱/等待策略却不能替新配置决定失败。
        // 只保留实际消费的匿名配置，摘要不暴露邮箱，Key 和私有地址从不参与此身份。
        const identity = {
            ...(service === 'freeTranslation' ? {
                timeoutMs: normalizeFreeTranslationTimeoutMs(current.freeTranslationTimeoutMs),
                cooldownMs: normalizeFreeTranslationCooldownMs(current.freeTranslationCooldownMs),
            } : {}),
            ...(usesMyMemory ? {email: (current.myMemoryEmail ?? '').trim()} : {}),
        };
        return `:anonymous:${sha256(JSON.stringify(identity)).toString()}`;
    }

    function requestAbortError(): Error {
        const error = new Error('翻译请求已取消');
        error.name = 'AbortError';
        return error;
    }

    function throwIfRequestAborted(signal?: AbortSignal): void {
        if (signal?.aborted) throw requestAbortError();
    }

    /**
     * 把 requestTimeoutMs 落实为 broker 拥有的 provider 截止时间。
     *
     * content 端停止等待 runtime message 并不会取消 background 中的 fetch；如果只把
     * timeout 数字传给 provider，未实现 AbortSignal 的旧适配器会让 pending Map 永久
     * 保留。这里无论 provider 是否主动消费 abortSignal，都会在截止时间释放调用方和
     * pending 所有权；支持 AbortSignal 的适配器还能同步停止底层请求。
     */
    function modelUsagePurpose(message: TranslationRequestMessage): TranslationModelUsageRecord['purpose'] {
        return 'summaryPrompt' in message && typeof message.summaryPrompt === 'string' && message.summaryPrompt.trim()
            ? 'page-summary'
            : 'translation';
    }

    function modelUsageOutcome(error: unknown): TranslationModelUsageOutcome {
        if (error instanceof TranslationProviderDeadlineError
            || error instanceof TranslationRequestSchedulerDeadlineError) return 'timeout';
        if (error && typeof error === 'object') {
            const candidate = error as {kind?: unknown; statusCode?: unknown};
            if (candidate.kind === 'timeout' || candidate.statusCode === 408) return 'timeout';
        }
        if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
        return 'error';
    }

    function cleanModelName(value: unknown): string | undefined {
        if (typeof value !== 'string') return undefined;
        const normalized = value
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .trim()
            .slice(0, 160);
        return normalized || undefined;
    }

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

    async function callProviderWithinDeadline(
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
    ): Promise<unknown> {
        throwIfRequestAborted(execution.abortSignal);
        const timeoutMs = normalizeDeadlineTimeoutMs(message.requestTimeoutMs as number);
        const providerDeadline = now() + timeoutMs;

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
                    const remainingTimeoutMs = getRemainingDeadlineMs(providerDeadline);
                    const startedAt = now();
                    const usageGeneration = deps.captureModelUsageGeneration?.() ?? 0;
                    const observations: TranslationModelUsageObservation[] = [];
                    const providerMessage = attachTranslationModelUsageObserver({
                        ...message,
                        abortSignal: controller.signal,
                    }, (observation) => observations.push({...observation}));

                    let timer: ReturnType<typeof setTimeout>;
                    const timeout = new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(new TranslationProviderDeadlineError());
                        }, remainingTimeoutMs);
                    });
                    const operation = Promise.resolve().then(() => {
                        throwIfRequestAborted(execution.abortSignal);
                        return provider(providerMessage);
                    });
                    // 调度调用方可能已因 deadline/取消收到结果，但真实 provider transport
                    // 仍需结束后才能释放后台并发槽，避免旧请求与新请求叠加。
                    lease.holdUntil(operation);

                    try {
                        const result = await Promise.race([operation, timeout, externalAbort]);
                        clearTimeout(timer!);
                        await persistModelUsage(execution, message, observations, startedAt, 'success', usageGeneration);
                        return result;
                    } catch (error) {
                        clearTimeout(timer!);
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
                        await persistModelUsage(execution, message, observations, startedAt, outcome, usageGeneration);
                        throw error;
                    }
                } finally {
                    externalAbortListenerCleanup.abort();
                }
            }, {
                signal: execution.abortSignal,
                deadlineAt: providerDeadline,
            });
        } catch (error) {
            if (error instanceof TranslationRequestSchedulerDeadlineError) {
                throw new TranslationProviderDeadlineError();
            }
            throw error;
        }
    }

    function shouldRecoverPageContextLeak(
        execution: TranslationRequestExecution,
        origin: string,
        result: string,
        pageContext: string,
        modelOverride?: string,
    ): boolean {
        return Boolean(pageContext.trim())
            && isAIContextEnabled(execution, modelOverride)
            && isLikelyPageContextLeak(origin, result, pageContext);
    }

    function isDefiniteRecoveryPageContextLeak(
        execution: TranslationRequestExecution,
        origin: string,
        result: string,
        pageContext: string,
        modelOverride?: string,
    ): boolean {
        return Boolean(pageContext.trim())
            && isAIContextEnabled(execution, modelOverride)
            && isDefinitePageContextLeak(origin, result, pageContext);
    }

    async function callSingleProviderWithoutPageContext(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        requestDeadline: number,
        validationPageContext = '',
    ): Promise<string> {
        const result = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context: '', pageContext: ''}, requestDeadline),
        ));
        if (isDefiniteRecoveryPageContextLeak(
            execution,
            message.origin,
            result,
            validationPageContext,
            message.modelOverride,
        )) throw new AIContextRecoveryResponseError();
        return result;
    }

    async function callSingleProviderWithContextRecovery(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
    ): Promise<string> {
        const result = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context, pageContext}, requestDeadline),
        ));
        if (!shouldRecoverPageContextLeak(
            execution,
            message.origin,
            result,
            pageContext,
            message.modelOverride,
        )) return result;

        warn(
            '[FluentRead] AI page context leaked into translation; retrying once without page context:',
            new Error('AI_PAGE_CONTEXT_LEAK'),
        );
        return callSingleProviderWithoutPageContext(execution, message, requestDeadline, pageContext);
    }

    async function callPromptBasedAIBatch(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
        startWithoutPageContext: boolean,
    ): Promise<string[]> {
        if (message.origin.length === 1) {
            const singleMessage = {...message, origin: message.origin[0] ?? ''};
            return [startWithoutPageContext
                ? await callSingleProviderWithoutPageContext(
                    execution,
                    singleMessage,
                    requestDeadline,
                    pageContext,
                )
                : await callSingleProviderWithContextRecovery(
                    execution,
                    singleMessage,
                    context,
                    pageContext,
                    requestDeadline,
                )];
        }

        const packet = serializeTranslationSlots(message.origin);
        const requestContext = startWithoutPageContext ? '' : context;
        const requestPageContext = startWithoutPageContext ? '' : pageContext;
        const requestBatch = async (nextContext: string, nextPageContext: string): Promise<string> => (
            requireSingleResult(await callProviderWithinDeadline(
                execution,
                applyRemainingDeadline({
                    ...message,
                    origin: packet.payload,
                    context: nextContext,
                    pageContext: nextPageContext,
                }, requestDeadline),
            ))
        );

        let usedContextFreeRequest = startWithoutPageContext;
        let rawResult = await requestBatch(requestContext, requestPageContext);
        // 协议完整时可以精确定位异常槽。先解析，再决定是否需要整包重译，
        // 避免某一段的明确上下文标记导致已正确的其他段落也被重新发送。
        let parsed = parseTranslationSlots(packet, rawResult);
        if (!parsed && shouldRecoverPageContextLeak(
            execution,
            packet.payload,
            rawResult,
            requestPageContext,
            message.modelOverride,
        )) {
            warn(
                '[FluentRead] AI page context leaked into multi-segment translation; retrying once without page context:',
                new Error('AI_PAGE_CONTEXT_LEAK'),
            );
            rawResult = await requestBatch('', '');
            parsed = parseTranslationSlots(packet, rawResult);
            usedContextFreeRequest = true;
            if (isDefiniteRecoveryPageContextLeak(
                execution,
                packet.payload,
                rawResult,
                pageContext,
                message.modelOverride,
            )) throw new AIContextRecoveryResponseError();
        }

        if (rawResult.trim() === packet.payload.trim()) {
            throw new AIMultiSegmentResponseError();
        }

        if (!parsed || parsed.length !== message.origin.length
            || parsed.some((value, index) => !value.trim() && Boolean(message.origin[index]?.trim()))) {
            throw new AIMultiSegmentResponseError();
        }
        const nonEmptyIndexes = message.origin
            .map((origin, index) => origin.trim() ? index : -1)
            .filter((index) => index >= 0);
        if (nonEmptyIndexes.length > 0 && nonEmptyIndexes.every((index) => (
            normalizeTranslationComparable(parsed[index] ?? '')
                === normalizeTranslationComparable(message.origin[index] ?? '')
        ))) throw new AIMultiSegmentResponseError();

        // 若协议完整但只有个别段落误译了页面上下文，只对这些段落做极简单段重译，
        // 已正确的同批结果继续复用，避免整批再次消耗。
        for (let index = 0; index < parsed.length; index += 1) {
            const origin = message.origin[index] ?? '';
            const leakedPageContext = shouldRecoverPageContextLeak(
                execution,
                origin,
                parsed[index] ?? '',
                pageContext,
                message.modelOverride,
            );
            if (!leakedPageContext) continue;
            if (usedContextFreeRequest) {
                if (isDefiniteRecoveryPageContextLeak(
                    execution,
                    origin,
                    parsed[index] ?? '',
                    pageContext,
                    message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
                continue;
            }
            parsed[index] = await callSingleProviderWithoutPageContext(
                execution,
                {...message, origin},
                requestDeadline,
                pageContext,
            );
        }
        return parsed;
    }

    async function callBatchProviderWithContextRecovery(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
        startWithoutPageContext = false,
    ): Promise<string[]> {
        const promptBasedAI = isPromptBasedAI(
            execution.config,
            execution.service,
            message.modelOverride,
        );
        if (message.aiMultiSegment === true && promptBasedAI) {
            return callPromptBasedAIBatch(
                execution,
                message,
                context,
                pageContext,
                requestDeadline,
                startWithoutPageContext,
            );
        }
        const results = requireBatchResult(
            await callProviderWithinDeadline(
                execution,
                applyRemainingDeadline({
                    ...message,
                    context: startWithoutPageContext ? '' : context,
                    pageContext: startWithoutPageContext ? '' : pageContext,
                }, requestDeadline),
            ),
            message.origin.length,
        );
        if (!promptBasedAI) return results;

        for (let index = 0; index < results.length; index += 1) {
            const origin = message.origin[index] ?? '';
            const leakedPageContext = shouldRecoverPageContextLeak(
                execution,
                origin,
                results[index] ?? '',
                pageContext,
                message.modelOverride,
            );
            if (!leakedPageContext) continue;
            if (startWithoutPageContext) {
                if (isDefiniteRecoveryPageContextLeak(
                    execution,
                    origin,
                    results[index] ?? '',
                    pageContext,
                    message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
                continue;
            }
            results[index] = await callSingleProviderWithoutPageContext(
                execution,
                {...message, origin},
                requestDeadline,
                pageContext,
            );
        }
        return results;
    }

    function buildPageSummaryCacheKey(
        execution: TranslationRequestExecution,
        pageContext: string,
        modelOverride?: string,
    ): string {
        const {config: current, service} = execution;
        return deps.buildTranslationCacheKey({
            requestMode: 'page-summary',
            sourceLanguage: current.from,
            targetLanguage: '',
            sourceText: pageContext,
            service,
            model: getSelectedModel(current, service, modelOverride),
            modelThinking: execution.thinking,
            endpoint: getProviderEndpoint(current, service),
            customBody: current.customBody[service] || '',
            transportProfile: deps.serviceTypes.isAiSdk(service)
                ? deps.endpointResolver.aiSdkTransportProfile
                : undefined,
        });
    }

    function cachePageSummary(key: string, value: string): void {
        if (pageSummaryCache.size >= PAGE_SUMMARY_CACHE_SIZE) {
            const oldestKey = pageSummaryCache.keys().next().value;
            if (oldestKey) pageSummaryCache.delete(oldestKey);
        }
        pageSummaryCache.set(key, value);
    }

    function readCacheWithPendingValue(generation: number, key: string): Promise<string | null> {
        const pending = pendingCacheValues.get(key);
        if (generation === cacheGeneration && pending?.generation === generation) {
            return Promise.resolve(pending.value);
        }
        return deps.cache.get(key);
    }

    async function writeCacheIfCurrent(generation: number, key: string, value: string): Promise<void> {
        if (generation !== cacheGeneration) return;

        // 缓存写可能因 IndexedDB 事务排队超过响应宽限期。先公开本次已经验证过的值，
        // 让同 key 的紧随请求复用；持久化失败、完成或 clear 换代后再精确撤销。
        const pendingValue: PendingCacheValue = {generation, value};
        const write = Promise.resolve().then(() => deps.cache.set(key, value));
        pendingCacheValues.set(key, pendingValue);
        pendingCacheWrites.set(write, generation);
        try {
            await write;
        } finally {
            pendingCacheWrites.delete(write);
            if (pendingCacheValues.get(key) === pendingValue) pendingCacheValues.delete(key);
        }
    }

    async function persistCacheWrite(generation: number, key: string, value: string): Promise<void> {
        // MV3 service worker 可能在消息 Promise 完成后立即挂起；成功响应前必须持有写入，
        // 但只等待有限宽限期；迟到写仍留在 pendingCacheWrites 中供 clear 严格排空。
        await waitForBoundedPersistence(
            Promise.resolve().then(() => writeCacheIfCurrent(generation, key, value)),
            {
                graceMs: deps.persistenceGraceMs,
                onFailure: (error) => warn('[FluentRead] translation cache write failed:', error),
                onTimeout: (error) => warn('[FluentRead] translation cache write timed out:', error),
            },
        );
    }

    async function addPageSummary(
        execution: TranslationRequestExecution,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        modelOverride?: string,
        requestTimeoutMs?: number,
    ): Promise<string> {
        if (!isAIContextEnabled(execution, modelOverride) || !pageContext.trim()) return '';

        const key = buildPageSummaryCacheKey(execution, pageContext, modelOverride);
        if (useCache) {
            const cached = pageSummaryCache.get(key);
            if (cached) return cached;
        }

        const summaryTimeoutMs = normalizeDeadlineTimeoutMs(requestTimeoutMs as number);
        const pendingKey = `${buildPendingRequestKey(key, summaryTimeoutMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${pendingOwnershipSuffix(execution)}`;
        const existing = pendingPageSummaries.get(pendingKey);
        if (existing) return runWithinDeadline(() => existing, requestDeadline, execution.abortSignal);

        const request = (async () => {
            try {
                // 步骤 1：先读持久缓存，覆盖 MV3 service worker 重启后的重复摘要。
                if (useCache) {
                    const persisted = await runWithinDeadline(
                        () => readCacheWithPendingValue(requestGeneration, key),
                        requestDeadline,
                        execution.abortSignal,
                    );
                    if (persisted !== null) {
                        if (requestGeneration === cacheGeneration) cachePageSummary(key, persisted);
                        return persisted;
                    }
                }

                // 步骤 2：缓存未命中时生成短摘要，失败时回退到原始上下文。
                const remainingTotalMs = getRemainingDeadlineMs(requestDeadline);
                const providerTimeoutMs = Math.min(summaryTimeoutMs, remainingTotalMs);
                const result = await callProviderWithinDeadline(
                    execution,
                    attachTranslationProviderConfig({
                        origin: '',
                        context: '',
                        pageContext: '',
                        summaryPrompt: deps.promptBuilder.buildPageSummaryPrompt(pageContext),
                        summarySystemPrompt: deps.promptBuilder.buildPageSummarySystemPrompt(),
                        serviceOverride: execution.service,
                        sourceLanguage: execution.sourceLanguage,
                        targetLanguage: execution.targetLanguage,
                        modelOverride,
                        thinkingOverride: execution.thinking,
                        requestTimeoutMs: providerTimeoutMs,
                    }, execution.config),
                );
                const summary = typeof result === 'string' ? result.trim().slice(0, PAGE_SUMMARY_LIMIT) : '';
                if (!summary) {
                    if (useCache && requestGeneration === cacheGeneration) cachePageSummary(key, pageContext);
                    return pageContext;
                }

                const summarizedContext = `Page summary (AI-generated reference):\n${summary}\n\n${pageContext}`.slice(0, 4000);
                if (useCache && requestGeneration === cacheGeneration) cachePageSummary(key, summarizedContext);
                if (useCache) await persistCacheWrite(requestGeneration, key, summarizedContext);
                return summarizedContext;
            } catch (error) {
                if (execution.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw error;
                }
                warn('[FluentRead] page context summary failed; using extracted context:', error);
                // 超时只是本次摘要预算耗尽，不能把原上下文当成成功摘要缓存，否则同 key 无法重试。
                if (!(error instanceof TranslationProviderDeadlineError)
                    && useCache
                    && requestGeneration === cacheGeneration) {
                    cachePageSummary(key, pageContext);
                }
                return pageContext;
            }
        })();

        pendingPageSummaries.set(pendingKey, request);
        const releasePendingSummary = () => {
            if (pendingPageSummaries.get(pendingKey) === request) pendingPageSummaries.delete(pendingKey);
        };
        void request.then(releasePendingSummary, releasePendingSummary);
        return request;
    }

    async function translateSingleWithCache(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        context: string,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        pendingBudgetMs: number,
    ): Promise<string> {
        const key = buildCacheKey(
            execution,
            message.origin,
            context,
            pageContext,
            'single',
            message.modelOverride,
            message.sourceLanguageDetectionText,
        );
        const pendingKey = `${buildPendingRequestKey(key, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${pendingOwnershipSuffix(execution)}${pendingAnonymousConfigSuffix(execution)}`;
        const existing = pendingTranslations.get(pendingKey);
        // 共享的是 provider 工作；每个等待者仍需保留自己的取消和截止边界。
        if (existing) return runWithinDeadline(() => existing, requestDeadline, execution.abortSignal);

        const request = useCache ? (async () => {
            // 步骤 1：先读持久缓存；未命中后只发起一次 provider 请求。
            const cached = await runWithinDeadline(
                () => readCacheWithPendingValue(requestGeneration, key),
                requestDeadline,
                execution.abortSignal,
            );
            if (cached !== null) {
                getRemainingDeadlineMs(requestDeadline);
                // 缓存中的软重合可能是已经经过无上下文复验的合法译名；
                // 只用明确边界/长复制信号否定旧缓存，避免每次都重译。
                const leakedPageContext = isDefiniteRecoveryPageContextLeak(
                    execution,
                    message.origin,
                    cached,
                    pageContext,
                    message.modelOverride,
                );
                if (isCacheableResult(message.origin, cached) && !leakedPageContext) return cached;

                const recovered = leakedPageContext
                    ? await callSingleProviderWithoutPageContext(
                        execution,
                        message,
                        requestDeadline,
                        pageContext,
                    )
                    : await callSingleProviderWithContextRecovery(
                        execution,
                        message,
                        context,
                        pageContext,
                        requestDeadline,
                    );
                if (isCacheableResult(message.origin, recovered)) {
                    await persistCacheWrite(requestGeneration, key, recovered);
                }
                return recovered;
            }

            const result = await callSingleProviderWithContextRecovery(
                execution,
                message,
                context,
                pageContext,
                requestDeadline,
            );
            if (isCacheableResult(message.origin, result)) {
                await persistCacheWrite(requestGeneration, key, result);
            }
            return result;
        })() : callSingleProviderWithContextRecovery(
            execution,
            message,
            context,
            pageContext,
            requestDeadline,
        );

        pendingTranslations.set(pendingKey, request);
        void request.then(
            () => {
                if (pendingTranslations.get(pendingKey) === request) pendingTranslations.delete(pendingKey);
            },
            () => {
                if (pendingTranslations.get(pendingKey) === request) pendingTranslations.delete(pendingKey);
            },
        );
        return request;
    }

    async function translateBatchWithCache(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        useCache: boolean,
        requestGeneration: number,
        requestDeadline: number,
        pendingBudgetMs: number,
    ): Promise<string[]> {
        const cacheMode: CacheRequestMode = message.aiMultiSegment === true
            ? 'ai-multi-segment'
            : 'batch';
        const batchKey = buildCacheKey(
            execution,
            message.origin,
            context,
            pageContext,
            cacheMode,
            message.modelOverride,
        );
        const pendingKey = `${buildPendingRequestKey(batchKey, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${pendingOwnershipSuffix(execution)}${pendingAnonymousConfigSuffix(execution)}`;
        const existing = pendingBatches.get(pendingKey);
        if (existing) return runWithinDeadline(() => existing, requestDeadline, execution.abortSignal);

        const request = useCache ? (async () => {
            // 步骤 1：分项读取缓存，只把缺失且去重后的原文交给 provider。
            const cached = await runWithinDeadline(
                () => Promise.all(message.origin.map((origin, index) => {
                    const itemKey = buildBatchItemCacheKey(
                        execution,
                        origin,
                        index,
                        message.origin,
                        context,
                        pageContext,
                        cacheMode,
                        message.modelOverride,
                    );
                    return readCacheWithPendingValue(requestGeneration, itemKey);
                })),
                requestDeadline,
                execution.abortSignal,
            );
            const leakedCachedIndexes = new Set<number>();
            const validatedCached = cached.map((value, index) => {
                if (value === null || !isCacheableResult(message.origin[index] ?? '', value)) return null;
                if (!isDefiniteRecoveryPageContextLeak(
                    execution,
                    message.origin[index] ?? '',
                    value,
                    pageContext,
                    message.modelOverride,
                )) return value;
                leakedCachedIndexes.add(index);
                return null;
            });
            const missingIndexes = validatedCached
                .map((value, index) => value === null ? index : -1)
                .filter((index) => index >= 0);

            if (missingIndexes.length === 0) {
                getRemainingDeadlineMs(requestDeadline);
                return validatedCached as string[];
            }

            const missingEntries = missingIndexes.map((index) => ({index, origin: message.origin[index]}));
            const normalMissingIndexes = missingIndexes.filter((index) => !leakedCachedIndexes.has(index));
            if (cacheMode === 'ai-multi-segment' && normalMissingIndexes.length > 0) {
                // AI 合批的邻段本身就是翻译输入。只要有普通 miss，必须用完整原批次重算，
                // 否则“完整批次指纹”会缓存一份实际没看到邻段的结果。
                const translated = await callBatchProviderWithContextRecovery(
                    execution,
                    message,
                    context,
                    pageContext,
                    requestDeadline,
                );
                await Promise.all(translated.map(async (value, index) => {
                    const origin = message.origin[index] ?? '';
                    if (!isCacheableResult(origin, value)) return;
                    await persistCacheWrite(
                        requestGeneration,
                        buildBatchItemCacheKey(
                            execution,
                            origin,
                            index,
                            message.origin,
                            context,
                            pageContext,
                            cacheMode,
                            message.modelOverride,
                        ),
                        value,
                    );
                }));
                return translated;
            }
            const translatedByKey = new Map<string, string>();
            const groups = [
                {
                    entries: missingEntries.filter(({index}) => !leakedCachedIndexes.has(index)),
                    startWithoutPageContext: false,
                },
                {
                    entries: missingEntries.filter(({index}) => leakedCachedIndexes.has(index)),
                    startWithoutPageContext: true,
                },
            ];
            for (const group of groups) {
                if (group.entries.length === 0) continue;
                const uniqueEntries = [...new Map(group.entries.map(({origin, index}) => [
                    buildBatchItemCacheKey(
                        execution,
                        origin,
                        index,
                        message.origin,
                        context,
                        pageContext,
                        cacheMode,
                        message.modelOverride,
                    ),
                    origin,
                ])).entries()];
                const uniqueOrigins = uniqueEntries.map(([, origin]) => origin);
                const translated = await callBatchProviderWithContextRecovery(
                    execution,
                    {...message, origin: uniqueOrigins},
                    context,
                    pageContext,
                    requestDeadline,
                    group.startWithoutPageContext,
                );
                uniqueEntries.forEach(([key], index) => {
                    translatedByKey.set(key, translated[index] ?? '');
                });
            }

            // 步骤 2：按原请求顺序回填结果，并只缓存有效译文。
            const result = [...validatedCached] as Array<string | null>;
            const cacheWrites: Promise<void>[] = [];
            missingEntries.forEach(({index, origin}) => {
                const itemKey = buildBatchItemCacheKey(
                    execution,
                    origin,
                    index,
                    message.origin,
                    context,
                    pageContext,
                    cacheMode,
                    message.modelOverride,
                );
                const value = translatedByKey.get(itemKey);
                result[index] = value as string;
                if (isCacheableResult(origin, value)) {
                    cacheWrites.push(persistCacheWrite(
                        requestGeneration,
                        itemKey,
                        value,
                    ));
                }
            });

            await Promise.all(cacheWrites);
            return result as string[];
        })() : callBatchProviderWithContextRecovery(
            execution,
            message,
            context,
            pageContext,
            requestDeadline,
        );

        pendingBatches.set(pendingKey, request);
        void request.then(
            () => {
                if (pendingBatches.get(pendingKey) === request) pendingBatches.delete(pendingKey);
            },
            () => {
                if (pendingBatches.get(pendingKey) === request) pendingBatches.delete(pendingKey);
            },
        );
        return request;
    }

    async function translateWithCache(message: TranslationRequestMessage): Promise<string | string[]> {
        // 空请求没有 provider 语义，也不应被配置水合阻塞。
        if (Array.isArray(message.origin) && message.origin.length === 0) return [];
        if (typeof message.origin === 'string' && !message.origin.trim()) return message.origin;

        const requestControl = getTranslationRequestControl(message);
        throwIfRequestAborted(requestControl?.signal);
        // 入口选择也必须在水合/队列之前复制，防止上层原地编辑数组改变在途请求。
        const glossaryIds = message.glossaryIds ? Object.freeze([...message.glossaryIds]) : message.glossaryIds;

        // deadline 从公开入口开始计时，配置水合不能让上层剩余预算重新获得完整时长。
        const providerStartedAt = now();
        const isRemainingBudget = (message as TranslationRequestMessage & TranslationRemainingBudgetContext)
            [TRANSLATION_REMAINING_BUDGET] === true;
        const providerBudget = (isRemainingBudget
            ? normalizeDeadlineTimeoutMs(message.requestTimeoutMs as number)
            : normalizeExternalRequestTimeoutMs(message.requestTimeoutMs)) ?? DEFAULT_PROVIDER_TIMEOUT_MS;
        const providerDeadline = providerStartedAt + providerBudget;
        await runWithinDeadline(() => deps.ready, providerDeadline, requestControl?.signal);
        throwIfRequestAborted(requestControl?.signal);

        // 步骤 1：圈选等受信后台事务沿用开始时的 symbol 快照；公开请求在 cache/provider await 前复制配置。
        let current = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config()));
        const serviceOverride = message.serviceOverride;
        const selectedService = serviceOverride || current.service;
        const {sourceLanguage, targetLanguage} = deps.getTranslationLanguages({
            sourceLanguage: message.sourceLanguage?.trim() || current.from,
            targetLanguage: message.targetLanguage?.trim() || current.to,
        });
        const supportsGlossary = supportsTranslationGlossary(
            selectedService, getSelectedModel(current, selectedService, message.modelOverride), deps.serviceTypes,
        );
        if (supportsGlossary && message.glossaryRevision !== undefined
            && message.glossaryRevision !== buildGlossaryRevision(current.glossaryLibraries, current.glossaryEnabled)) {
            throw new GlossaryRevisionChangedError();
        }
        const glossarySource = getTranslationGlossaryContext(message);
        const glossaryContext = glossarySource?.context ?? message.glossaryContext ?? 'page';
        const selectedGlossaryIds = glossaryIds ?? (glossaryContext === 'document' ? current.documentGlossaryIds
            : glossaryContext === 'video' ? current.videoGlossaryIds : null);
        const glossaryTerms = supportsGlossary && current.glossaryEnabled
            ? resolveGlossary(current.glossaryLibraries!, {
                text: getTranslationGlossarySourceText(message.origin),
                sourceLanguage,
                targetLanguage,
                pageUrl: glossarySource?.pageUrl,
                glossaryIds: selectedGlossaryIds ? [...selectedGlossaryIds] : null,
            }).terms
            : [];
        // Provider 只读取命中当前原文的词对；配置原文与域规则不会进入请求 JSON。
        current = Object.freeze({...current,
            glossaryTerms: Object.freeze(glossaryTerms.map(term => Object.freeze({...term}))),
            glossaryMatchContext: Object.freeze({sourceLanguage, targetLanguage, pageUrl: glossarySource?.pageUrl,
                glossaryIds: selectedGlossaryIds ? Object.freeze([...selectedGlossaryIds]) : null}),
        });
        const execution: TranslationRequestExecution = {
            config: current,
            service: selectedService,
            sourceLanguage,
            targetLanguage,
            enableAIContext: message.enableAIContext ?? current.enableAIContext,
            thinking: message.thinkingOverride ?? isModelThinkingEnabled(
                current.modelThinking,
                selectedService,
                getSelectedModel(current, selectedService, message.modelOverride),
            ),
            abortSignal: requestControl?.signal,
            ownershipKey: requestControl?.ownershipKey,
        };
        const credentialConfig = message.modelOverride
            ? {
                ...current,
                model: {...current.model, [selectedService]: message.modelOverride},
                customModel: {...current.customModel, [selectedService]: message.modelOverride},
            }
            : current;
        const missingCredentialMessage = deps.getMissingCredentialMessage(selectedService, credentialConfig);
        if (missingCredentialMessage) throw new Error(missingCredentialMessage);
        if (serviceOverride && !deps.serviceTypes.machine.has(serviceOverride) && !deps.serviceTypes.isAI(serviceOverride)) {
            throw new Error('独立翻译服务不可用，请选择已配置的机器翻译或 AI 服务');
        }

        const context = typeof message.context === 'string' ? message.context : '';
        const rawPageContext = typeof message.pageContext === 'string' ? message.pageContext : '';
        const useCache = isCacheEnabled(current, message);
        // clear 是缓存代次的线性化边界。清理期间进入的缓存请求必须等到所有
        // 已串联 clear 完成后再取得新代次，等待时间仍计入原始 deadline 且可取消。
        if (useCache) {
            await waitForCacheClearBarrier(providerDeadline, requestControl?.signal);
        }
        const requestGeneration = cacheGeneration;
        // 步骤 2：摘要是 AI 上下文增强，只拿 provider deadline 的一小段预算。
        const summaryBudget = Math.min(10_000, Math.max(1_000, Math.floor(providerBudget / 4)));
        const pageContext = await addPageSummary(
            execution,
            rawPageContext,
            useCache,
            requestGeneration,
            providerDeadline,
            message.modelOverride,
            summaryBudget,
        );
        const remainingProviderBudget = getRemainingDeadlineMs(providerDeadline);

        // 步骤 3：检测样本只属于 Chrome auto；即使其他扩展页面手工构造该字段，
        // 也不能让重复正文扩散到任何云端 provider。
        const shouldCarryDetectionText = selectedService === 'chromeTranslator'
            && sourceLanguage === 'auto'
            && Boolean(message.sourceLanguageDetectionText?.trim());
        const providerInput = shouldCarryDetectionText
            ? message
            : (() => {
                const {sourceLanguageDetectionText: _ignored, ...withoutDetectionText} = message;
                return withoutDetectionText as TranslationRequestMessage;
            })();

        // 步骤 4：把摘要耗时从剩余 provider 请求中扣除，避免后台无限等待。
        const requestMessage = attachTranslationProviderConfig(
            {
                ...providerInput,
                glossaryIds,
                sourceLanguage,
                targetLanguage,
                thinkingOverride: execution.thinking,
                requestTimeoutMs: remainingProviderBudget,
            } as TranslationRequestMessage,
            current,
        );
        // 步骤 5：根据 origin 类型进入单条或批量管线，两者共享缓存身份与 pending 去重。
        if (Array.isArray(requestMessage.origin)) {
            return translateBatchWithCache(
                execution,
                requestMessage as TranslationBatchRequestMessage,
                context,
                pageContext,
                useCache,
                requestGeneration,
                providerDeadline,
                providerBudget,
            );
        }
        return translateSingleWithCache(
            execution,
            requestMessage as TranslationSingleRequestMessage,
            context,
            pageContext,
            useCache,
            requestGeneration,
            providerDeadline,
            providerBudget,
        );
    }

    function clearTranslationCache(): Promise<void> {
        // 步骤 1：先切换代次并断开旧请求去重；旧 provider 仍可返回给原调用者，但不能重新填充缓存。
        cacheGeneration += 1;
        const clearGeneration = cacheGeneration;
        pendingTranslations.clear();
        pendingBatches.clear();
        pendingPageSummaries.clear();
        pendingCacheValues.clear();
        pageSummaryCache.clear();

        // 步骤 2：所有 clear 严格串行。每次都等待自己代次之前已经进入存储
        // 适配器的写入，再执行最终清库；失败不会阻断后续 clear 的执行。
        const previousBarrier = cacheClearBarrier ?? Promise.resolve();
        const clearOperation = previousBarrier.then(async () => {
            const staleWrites = [...pendingCacheWrites]
                .filter(([, generation]) => generation < clearGeneration)
                .map(([write]) => write);
            await Promise.allSettled(staleWrites);
            await deps.cache.clear();
            pageSummaryCache.clear();
        });
        const settledBarrier = clearOperation.then(
            () => undefined,
            () => undefined,
        );
        cacheClearBarrier = settledBarrier;
        void settledBarrier.then(() => {
            if (cacheClearBarrier === settledBarrier) cacheClearBarrier = null;
        });
        return clearOperation;
    }

    async function cleanupTranslationCache(): Promise<void> {
        await deps.cache.cleanup();
    }

    return {
        translateWithCache,
        clearTranslationCache,
        cleanupTranslationCache,
    };
}
