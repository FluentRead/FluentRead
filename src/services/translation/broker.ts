/**
 * @file src/services/translation/broker.ts
 *
 * 文件职责：编排翻译请求的配置快照、语言解析、缓存、请求去重、超时与 provider 调用，是后台翻译用例的中心服务。
 * 主要内容：createTranslationBroker 同时支持单条、批量和页面摘要，验证 provider 返回数量、类型及明显的原文回显或错语种，图片文字的内部策略接受有效原样结果并隔离缓存，空来源在本地保留，仅在原生批次响应结构异常时以相同取消所有权和剩余 deadline 逐段恢复，整批完成前不发布缓存；对完整多段协议逐槽修复上下文回显并拒绝空译文，以包含 Chrome auto 检测样本的完整身份构建缓存键，并按实际消费的云地域和凭据摘要、匿名额度身份、等待策略、清理代次与剩余 deadline 隔离 pending 请求；入口在等待前复制消息，ready 采用有界水合等待，之后按最终服务解析 AI 配置预算并扣除已等待时间，取消检查后沿用可信配置快照，仅未附着的公开请求复制备用配置；批次摘要与分项缓存键只构建一次并复用，重复身份只读写一次；每次公开请求累计缓存复用、上游调用次数、耗时与免费链线路尝试，结束后向注入的统计端口交付只含规模数值、服务与线路标识的事件。 可核对的公开符号包括 createTranslationBroker、聚合导出。
 * 无痕专用模型仅由可信隐私上下文启用，在缓存、摘要、调度和 provider 前生成独立有效快照，并把配置拒绝归属到尝试的专用服务。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；文本槽编码与解析复用 core/translation/slotProtocol.ts 纯协议，不初始化 DOM 候选或网站规则；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {resolvePrivateTranslation} from './privateRouting';
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
    attachTranslationRouteObserver,
    attachTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
    createTranslationRequestSnapshot,
    getTranslationGlossaryContext,
    getTranslationProviderConfig,
    getTranslationGlossarySourceText,
    getTranslationRequestControl,
    attachTranslationRequestControl,
    getTranslationImageInput,
    attachTranslationImageInput,
    isUnchangedTranslationResultAllowed,
} from './requestSnapshot';
import {TRANSLATION_REMAINING_BUDGET, type TranslationRouteObservation} from './types';
import {DEFAULT_PROVIDER_TIMEOUT_MS, getExplicitTranslationBudget, normalizeDeadlineTimeoutMs,
    startTranslationRequest, TranslationProviderDeadlineError} from './requestDeadline';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse, isUnchangedTranslationResponse} from '@/src/core/translation/resultValidation';
import {hasTranslationContent} from '@/src/core/translation/result';
import {isNativeBatchResponseError, validateNativeBatchResults} from '@/src/core/translation/nativeBatch';
import {buildGlossaryRevision, resolveGlossary} from '@/src/core/glossary';
import {supportsNativeTranslationBatch, supportsTranslationBatch, supportsTranslationGlossary, getTranslationServiceUnavailableMessage} from './capabilities';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {isGlossaryOnlyResult, prepareGlossaryRequest} from './glossaryProtection';
import {
    isDefinitePageContextLeak,
    isLikelyPageContextLeak,
} from '@/src/core/translation/prompts';
import {isCustomOpenAIProviderId, LEGACY_CUSTOM_OPENAI_PROVIDER_ID} from '@/src/core/config/customOpenAI';
import {getCompositeTranslationProvider, isCompositeTranslationProviderId} from '@/src/core/config/compositeTranslation';
import {createCompositeTranslationRoutingState} from './compositeRouting';
import {resolveCloudRegion, services} from '@/src/core/config/catalog';
import {resolveTranslationRequestModel} from '@/src/core/config/requestModel';
import {isValidInlineCodeSource, isValidInlineCodeTranslation} from '@/src/core/translation/inlineCodeMarkers';
import {getServiceApiKeys} from '@/src/core/config/apiKeys';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {supportsVisionTransport} from '@/src/core/config/vision';
import {
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
    normalizeFreeTranslationCooldownMs,
} from '@/src/core/config/freeTranslation';
import {sha256Hex} from '@/src/shared/function/sha256';
import {waitForBoundedPersistence} from './persistenceBarrier';
import {runWithApiKeyRotation} from './apiKeyRotation';
import {
    createTranslationRequestScheduler,
    TranslationRequestSchedulerDeadlineError,
} from './requestScheduler';
import {serializeTranslationError} from './errors';
import {createTranslationIdentityPolicy, type CacheRequestMode, type TranslationRequestIdentityContext} from './requestIdentity';
import {currentConfiguredModel} from './templates';
import {normalizeTranslationMaxRetries} from '@/src/core/config/scheduling';
import {isDoubaoSeedTranslationModel} from '@/src/core/config/doubaoSeedTranslation';
import {measureImageDataUrlBytes, measureTranslationText} from '@/src/services/translation-stats/measure';
import {
    TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS,
    type TranslationRequestOutcome,
    type TranslationRequestSource,
    type TranslationRouteAttempt,
} from '@/src/services/translation-stats/types';

export type {
    TranslationBatchRequestMessage,
    TranslationBroker,
    TranslationBrokerDependencies,
    TranslationProviderConfigSnapshot,
    TranslationProvider,
    TranslationRequestMessage,
    TranslationSingleRequestMessage,
} from './types';

/** 单次公开翻译请求的观测累加器，只记录服务标识与数值，随 execution 传入缓存和 provider 路径。 */
interface TranslationRequestTrace {
    serviceId?: string;
    model?: string;
    cachedSegments: number;
    shared: boolean;
    upstreamCalls: number;
    upstreamMs: number;
    routeAttempts: TranslationRouteAttempt[];
}

interface TranslationRequestExecution extends TranslationRequestIdentityContext {
    readonly acceptUnchangedResult: boolean;
    readonly compositeMember?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly ownershipKey?: string;
    readonly privateContext: boolean | undefined;
    readonly trace: TranslationRequestTrace;
}

interface PendingCacheValue {
    readonly generation: number;
    readonly value: string;
}

const PAGE_SUMMARY_CACHE_SIZE = 8;
const PAGE_SUMMARY_LIMIT = 1200;

class AIMultiSegmentResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'AI_MULTI_SEGMENT_RESPONSE_INVALID';

    constructor() {
        super('AI 多段翻译返回格式异常，已切换为逐段翻译');
        this.name = 'AIMultiSegmentResponseError';
    }
}

class TranslationSlotResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'TRANSLATION_SLOT_RESPONSE_INVALID';

    constructor() {
        super('翻译服务返回空译文，请重试或切换服务');
        this.name = 'TranslationSlotResponseError';
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

class UntranslatedResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'UNTRANSLATED_RESPONSE';

    constructor() {
        super('翻译服务连续返回未翻译的原文，请尝试切换服务；使用 AI 时也可调整提示词');
        this.name = 'UntranslatedResponseError';
    }
}

class WrongLanguageResponseError extends Error {
    readonly kind = 'response';
    readonly retryable = false;
    readonly code = 'WRONG_LANGUAGE_RESPONSE';

    constructor() {
        super('翻译服务连续返回与目标语言不符的译文，请尝试切换服务');
        this.name = 'WrongLanguageResponseError';
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

/** 保留既有 broker 公共入口，模型规则由设置页与后台共用的 core 函数维护。 */
export {resolveTranslationRequestModel};

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
    const compositeRouting = createCompositeTranslationRoutingState({now});
    const logger = deps.logger ?? console;
    const requestScheduler = deps.requestScheduler ?? createTranslationRequestScheduler(
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

    const {getSelectedModel, getEffectiveRequestModel, isPromptBasedAI, isAIContextEnabled,
        getProviderEndpoint, buildCacheKey} = createTranslationIdentityPolicy(deps);

    function buildBatchItemCacheKey(
        execution: TranslationRequestExecution,
        origin: string,
        itemIndex: number,
        batchFingerprint: string,
        context: string,
        pageContext: string,
        mode: CacheRequestMode,
        modelOverride?: string,
    ): string {
        // AI 多段结果会受同批邻段影响，不能只按当前 origin 复用到另一种组合。
        // 把槽位序号和当前项放在首位，再携带完整有序批次的摘要；同批重复原文也不会被错误折叠。
        const sourceIdentity = mode === 'ai-multi-segment'
            ? [`slot:${itemIndex}`, origin, `batch:${batchFingerprint}`]
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

    function isCacheableResult(origin: string, result: unknown, execution: TranslationRequestExecution): result is string {
        // 图片文字的有效原样结果仅在独立策略缓存中复用；其他入口继续拒绝外语原文和明确错语种。
        return typeof result === 'string'
            && hasTranslationContent(result)
            && (isGlossaryOnlyResult(execution.config, origin, result)
            || (execution.acceptUnchangedResult && isUnchangedTranslationResponse(origin, result))
            || (!isLikelyUntranslatedResponse(origin, result, execution.targetLanguage)
            && !isClearlyWrongLanguageResponse(origin, result, execution.targetLanguage)));
    }

    /** 标记与原始载荷必须同时符合内部协议；普通原文中的相似标记没有逐槽语义。 */
    function getSingleSlotProtocol(message: TranslationSingleRequestMessage) {
        if (message.validateTranslationSlots !== true) return null;
        const sources = getTranslationGlossarySourceText(message.origin);
        if (!Array.isArray(sources)) return null;
        const packet = serializeTranslationSlots(sources);
        return packet.payload === message.origin ? {sources, packet} : null;
    }

    function isCacheableSingleResult(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        result: string,
    ): boolean {
        if (message.validateInlineCodeTranslation === true) {
            return isValidInlineCodeTranslation(message.origin, result, execution.targetLanguage)
                && isCacheableResult(message.origin, result, execution);
        }
        if (message.validateTranslationSlots !== true) {
            return isCacheableResult(message.origin, result, execution);
        }
        const protocol = getSingleSlotProtocol(message);
        const parsed = protocol && parseTranslationSlots(protocol.packet, result);
        return Boolean(parsed && parsed.every((translation, index) =>
            isCacheableResult(protocol!.sources[index]!, translation, execution)));
    }

    function requireSingleResult(result: unknown): string {
        if (typeof result !== 'string') throw new Error('单条翻译返回格式异常');
        return result;
    }

    /** 单条响应和逐槽恢复共用内容防御；恢复后的最后检查仍必须拒绝空译文。 */
    function requireTranslationContent(value: string): void {
        if (!hasTranslationContent(value)) throw new TranslationSlotResponseError();
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

    /** 同一冻结配置派生 transport 的实际 key 与 pending 的有效 key 集合；摘要不进入成功缓存身份。 */
    function quotaDigest(execution: TranslationRequestExecution, model: string, transport = false): string {
        const current = execution.config;
        if (!deps.serviceTypes.isAI(execution.service)) return sha256Hex(JSON.stringify([execution.privateContext]));
        return sha256Hex(JSON.stringify([
            execution.service, model, getProviderEndpoint(current, execution.service),
            transport ? current.token[execution.service]?.trim() || ''
                : [getServiceApiKeys(current, execution.service), current.apiKeyRotationEnabled?.[execution.service] !== false, current.apiKeyRecoveryMs],
            current.customHeaders?.[execution.service] || '', current.requestHeaderRules, execution.privateContext,
        ]));
    }

    function pendingIdentitySuffix(execution: TranslationRequestExecution, modelOverride?: string): string {
        const ownershipKey = execution.ownershipKey;
        const {config: current, service} = execution;
        const sdk = deps.serviceTypes.isAiSdk(service) && !(service === services.doubao
            && isDoubaoSeedTranslationModel(currentConfiguredModel(current, service, modelOverride)));
        const rotates = current.apiKeyRotationEnabled?.[service] !== false
            && getServiceApiKeys(current, service).length > 1;
        const retries = rotates ? 0 : current.translationMaxRetries === undefined
            ? 2 : normalizeTranslationMaxRetries(current.translationMaxRetries);
        return (ownershipKey ? `:owner:${ownershipKey.length}:${ownershipKey}` : '')
            + `:quota:${quotaDigest(execution, getEffectiveRequestModel(current, service, modelOverride))}`
            + (sdk ? `:sdk-retries:${retries}` : '');
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
        return `:anonymous:${sha256Hex(JSON.stringify(identity))}`;
    }

    /** 成功译文可跨凭据复用；新凭据/地域请求不能继承旧鉴权失败，摘要只用于内存 pending。 */
    function pendingCloudConfigSuffix(execution: TranslationRequestExecution): string {
        const {service, config: current} = execution;
        let credentials: unknown;
        if (service === services.youdao) {
            credentials = [current.youdaoAppKey, current.youdaoAppSecret];
        } else if (service === services.tencent || service === services.huanYuanTranslation) {
            credentials = [current.tencentSecretId?.trim(), current.tencentSecretKey?.trim()];
        } else if (service === services.baiduTranslation || service === services.googleCloudTranslation
            || service === services.azureTranslator || service === services.aliyunTranslation
            || service === services.volcTranslation || service === services.xiaoniu) {
            const keys = getServiceApiKeys(current, service);
            const usesSecret = service === services.baiduTranslation || service === services.aliyunTranslation
                || service === services.volcTranslation;
            const rotationEnabled = current.apiKeyRotationEnabled?.[service] !== false;
            credentials = [keys, ...(usesSecret ? [current.secret?.[service]?.trim()] : []),
                ...(keys.length > 1 ? [rotationEnabled] : [])];
        } else return '';
        return `:cloud:${sha256Hex(JSON.stringify({credentials,
            region: resolveCloudRegion(service, current.serviceRegion?.[service]),
        }))}`;
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
        const deadlineAt = now() + normalizeDeadlineTimeoutMs(message.requestTimeoutMs as number);
        return runWithApiKeyRotation(execution.config, execution.service, (selected, attempt) => (
            callProviderAttemptWithinDeadline({...execution, config: selected}, attachTranslationProviderConfig({
                ...message,
                enableNativeBatch: message.enableNativeBatch ?? execution.nativeBatchEnabled,
                requestTimeoutMs: attempt.attemptTimeoutMs ?? getRemainingDeadlineMs(deadlineAt),
            }, selected))
        ), {signal: execution.abortSignal, deadlineAt, now,
            model: getSelectedModel(execution.config, execution.service, message.modelOverride)});
    }

    async function callProviderAttemptWithinDeadline(
        execution: TranslationRequestExecution,
        message: TranslationRequestMessage,
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
        const identity = {
            service: execution.service, model,
            ...(isAiSdk ? {quotaScope: quotaDigest(execution, model, true)} : {}),
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
                    const remainingTimeoutMs = getRemainingDeadlineMs(providerDeadline);
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
                        (observation) => collectRouteAttempt(execution.trace, observation),
                    ), requestScheduler, identity, isAiSdk ? undefined : lease);

                    let timer: ReturnType<typeof setTimeout>;
                    const timeout = new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(new TranslationProviderDeadlineError());
                        }, remainingTimeoutMs);
                    });
                    const operation = Promise.resolve().then(async () => {
                        throwIfRequestAborted(execution.abortSignal);
                        const protectedRequest = prepareGlossaryRequest(providerMessage, execution.config);
                        return protectedRequest.restore(await provider({...protectedRequest.message}));
                    });
                    // 调度调用方可能已因 deadline/取消收到结果，但真实 provider transport
                    // 仍需结束后才能释放后台并发槽，避免旧请求与新请求叠加。
                    lease.holdUntil(operation);

                    try {
                        const result = await Promise.race([operation, timeout, externalAbort]);
                        clearTimeout(timer!);
                        addUpstreamElapsed(execution.trace, startedAt);
                        await persistModelUsage(execution, message, observations, startedAt, 'success', usageGeneration);
                        return result;
                    } catch (error) {
                        clearTimeout(timer!);
                        addUpstreamElapsed(execution.trace, startedAt);
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
                identity,
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

    /** 第一次误返原文或明显错语种时只重试当前槽；再次异常则显式失败。 */
    async function recoverInvalidResult(
        execution: TranslationRequestExecution,
        message: TranslationSingleRequestMessage,
        result: string,
        requestDeadline: number,
        context = '',
        validationPageContext = '',
        usedContextFreeRequest = false,
    ): Promise<string> {
        const protocol = getSingleSlotProtocol(message);
        if (protocol) {
            const parsed = parseTranslationSlots(protocol.packet, result);
            // 保留前端既有的协议失败回退，但绝不能把损坏包写入缓存。
            if (!parsed) return result;
            for (let index = 0; index < parsed.length; index++) {
                const slotMessage = {...message, origin: protocol.sources[index]!, validateTranslationSlots: false};
                if (!hasTranslationContent(slotMessage.origin)) {
                    parsed[index] = slotMessage.origin;
                    continue;
                }
                const translation = parsed[index]!;
                // 整包已经无上下文重译时，每槽仍检查明确泄漏；软信号不能再次触发逐槽请求。
                // 按槽比较也能识别另一来源槽包含相同字面标记而被整包检测豁免的泄漏。
                if (usedContextFreeRequest && isDefiniteRecoveryPageContextLeak(
                    execution, slotMessage.origin, translation, validationPageContext, message.modelOverride,
                )) throw new AIContextRecoveryResponseError();
                if (isGlossaryOnlyResult(execution.config, slotMessage.origin, translation)) continue;
                parsed[index] = !hasTranslationContent(translation) || (!usedContextFreeRequest && shouldRecoverPageContextLeak(
                    execution, slotMessage.origin, translation, validationPageContext, message.modelOverride,
                ))
                    ? await callSingleProviderWithoutPageContext(execution, slotMessage, requestDeadline, validationPageContext)
                    : await recoverInvalidResult(execution, slotMessage, translation, requestDeadline, context, validationPageContext, usedContextFreeRequest);
                requireTranslationContent(parsed[index]!);
            }
            return parsed.map((translation, index) =>
                `${protocol.packet.starts[index]}${translation}${protocol.packet.ends[index]}`).join('\n');
        }
        if (!hasTranslationContent(message.origin) && !getTranslationImageInput(message)) return message.origin;
        requireTranslationContent(result);
        if (execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin, result)) return result;
        if (isGlossaryOnlyResult(execution.config, message.origin, result)) return result;
        if (!isLikelyUntranslatedResponse(message.origin, result, execution.targetLanguage)
            && !isClearlyWrongLanguageResponse(message.origin, result, execution.targetLanguage)) return result;
        const retried = requireSingleResult(await callProviderWithinDeadline(
            execution,
            applyRemainingDeadline({...message, context, pageContext: ''}, requestDeadline),
        ));
        if (isDefiniteRecoveryPageContextLeak(
            execution, message.origin, retried, validationPageContext, message.modelOverride,
        )) throw new AIContextRecoveryResponseError();
        if (!hasTranslationContent(retried)) throw new TranslationSlotResponseError();
        if (execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin, retried)) return retried;
        if (isGlossaryOnlyResult(execution.config, message.origin, retried)) return retried;
        if (isLikelyUntranslatedResponse(message.origin, retried, execution.targetLanguage)) {
            throw new UntranslatedResponseError();
        }
        if (isClearlyWrongLanguageResponse(message.origin, retried, execution.targetLanguage)) {
            throw new WrongLanguageResponseError();
        }
        return retried;
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
        return recoverInvalidResult(execution, message, result, requestDeadline, '', validationPageContext, true);
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
        if (getSingleSlotProtocol(message) || !shouldRecoverPageContextLeak(
            execution,
            message.origin,
            result,
            pageContext,
            message.modelOverride,
        )) return recoverInvalidResult(execution, message, result, requestDeadline, context, pageContext);

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
            const singleMessage = {...message, origin: message.origin[0]!};
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

        if (!parsed || parsed.length !== message.origin.length
            || parsed.some((value, index) => !hasTranslationContent(value) && Boolean(message.origin[index]?.trim()))) {
            throw new AIMultiSegmentResponseError();
        }

        // 若协议完整但只有个别段落误译了页面上下文，只对这些段落做极简单段重译，
        // 已正确的同批结果继续复用，避免整批再次消耗。
        for (let index = 0; index < parsed.length; index += 1) {
            const origin = message.origin[index];
            const leakedPageContext = shouldRecoverPageContextLeak(
                execution,
                origin,
                parsed[index],
                pageContext,
                message.modelOverride,
            );
            if (!leakedPageContext) continue;
            if (usedContextFreeRequest) {
                if (isDefiniteRecoveryPageContextLeak(
                    execution,
                    origin,
                    parsed[index],
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
        const finalized = Array.from(parsed);
        if (finalized.some((result, index) => !(execution.acceptUnchangedResult && isUnchangedTranslationResponse(message.origin[index], result))
            && !isGlossaryOnlyResult(execution.config, message.origin[index], result) && isLikelyUntranslatedResponse(
            message.origin[index], result, execution.targetLanguage,
        ))) throw new AIMultiSegmentResponseError();
        for (let index = 0; index < finalized.length; index += 1) {
            const origin = message.origin[index];
            if ((execution.acceptUnchangedResult && isUnchangedTranslationResponse(origin, finalized[index]))
                || isGlossaryOnlyResult(execution.config, origin, finalized[index])
                || !isClearlyWrongLanguageResponse(origin, finalized[index], execution.targetLanguage)) continue;
            finalized[index] = await recoverInvalidResult(
                execution, {...message, origin}, finalized[index], requestDeadline, '', pageContext,
            );
        }
        return finalized;
    }

    async function callBatchProviderWithContextRecovery(
        execution: TranslationRequestExecution,
        message: TranslationBatchRequestMessage,
        context: string,
        pageContext: string,
        requestDeadline: number,
        startWithoutPageContext = false,
    ): Promise<string[]> {
        // 空白没有上游翻译语义；保留原始位置与空白，不能让空响应伪装成完成的正文。
        const nonEmptyIndexes = message.origin.map((origin, index) => origin && hasTranslationContent(origin) ? index : -1)
            .filter(index => index >= 0);
        if (nonEmptyIndexes.length !== message.origin.length) {
            const origins = [...message.origin];
            if (nonEmptyIndexes.length === 0) return origins.map(origin => origin ?? '');
            const translated = await callBatchProviderWithContextRecovery(
                execution,
                {...message, origin: nonEmptyIndexes.map(index => origins[index]!)},
                context, pageContext, requestDeadline, startWithoutPageContext,
            );
            let ordinal = 0;
            return origins.map(origin => origin && hasTranslationContent(origin) ? translated[ordinal++]! : origin ?? '');
        }
        const promptBasedAI = isPromptBasedAI(
            execution.config,
            execution.service,
            message.modelOverride,
        );
        const nativeBatch = supportsNativeTranslationBatch(execution.service);
        if (nativeBatch && !execution.nativeBatchEnabled) {
            // 显式数组继续原子返回；关闭合批只改变上游请求形态，不提前发布或缓存任何槽。
            const translated: string[] = [];
            for (const origin of message.origin) {
                const single = {...message, origin, enableNativeBatch: false};
                translated.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return validateNativeBatchResults(message.origin, translated);
        }
        if (message.aiMultiSegment === true && promptBasedAI && !nativeBatch) {
            return callPromptBasedAIBatch(
                execution,
                message,
                context,
                pageContext,
                requestDeadline,
                startWithoutPageContext,
            );
        }
        if (execution.compositeMember && !supportsTranslationBatch(execution.service)) {
            // 单条协议的成员逐段执行，仍只在整批校验成功后发布组合批次缓存。
            const translated: string[] = [];
            for (const origin of message.origin) {
                const single = {...message, origin};
                translated.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return requireBatchResult(translated, message.origin.length);
        }
        const nativeOrigins = nativeBatch ? [...message.origin] : message.origin;
        let results: string[];
        try {
            const result = await callProviderWithinDeadline(
                execution,
                applyRemainingDeadline({
                    ...message,
                    origin: nativeBatch ? [...nativeOrigins] : message.origin,
                    context: startWithoutPageContext ? '' : context,
                    pageContext: startWithoutPageContext ? '' : pageContext,
                }, requestDeadline),
            );
            results = nativeBatch ? validateNativeBatchResults(nativeOrigins, result)
                : requireBatchResult(result, message.origin.length);
        } catch (error) {
            // 网络、鉴权与限流沿现有失败链路返回；只有响应结构损坏才允许拆批，避免放大上游请求。
            if (!nativeBatch || !isNativeBatchResponseError(error)) throw error;
            const recovered: string[] = [];
            for (const origin of nativeOrigins) {
                // 恢复必须是真正的单项请求，不能被 Google 的 scalar 收集窗重新合成坏批次。
                const single = {...message, origin, enableNativeBatch: false};
                recovered.push(startWithoutPageContext
                    ? await callSingleProviderWithoutPageContext(execution, single, requestDeadline, pageContext)
                    : await callSingleProviderWithContextRecovery(execution, single, context, pageContext, requestDeadline));
            }
            return recovered;
        }
        if (!promptBasedAI) {
            const finalized = Array.from(results, value => value ?? '');
            for (let index = 0; index < finalized.length; index += 1) {
                finalized[index] = await recoverInvalidResult(
                    execution, {...message, origin: message.origin[index] ?? ''}, finalized[index],
                    requestDeadline, context, pageContext,
                );
            }
            return finalized;
        }

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
        const finalized = Array.from(results, value => value ?? '');
        for (let index = 0; index < finalized.length; index += 1) {
            finalized[index] = await recoverInvalidResult(
                execution, {...message, origin: message.origin[index] ?? ''}, finalized[index] ?? '',
                requestDeadline, startWithoutPageContext ? '' : context, pageContext,
            );
        }
        return finalized;
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
            ...(current.customHeaders?.[service] ? {customHeaders: current.customHeaders[service]} : {}),
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
        const pendingKey = `${buildPendingRequestKey(key, summaryTimeoutMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${pendingIdentitySuffix(execution, modelOverride)}`;
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
        recoverSharedDeadline = true,
    ): Promise<string> {
        const key = buildCacheKey(
            execution,
            message.origin,
            context,
            pageContext,
            message.validateInlineCodeTranslation === true ? 'inline-code-v1'
                : message.validateTranslationSlots === true ? 'slot-protocol' : 'single',
            message.modelOverride,
            message.sourceLanguageDetectionText,
        );
        const imageInput = getTranslationImageInput(message);
        const imageSuffix = imageInput ? `:image:${sha256Hex(imageInput)}` : '';
        const pendingKey = `${buildPendingRequestKey(key, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${imageSuffix}${pendingIdentitySuffix(execution, message.modelOverride)}${pendingAnonymousConfigSuffix(execution)}${pendingCloudConfigSuffix(execution)}${recoverSharedDeadline ? '' : `:recovery-deadline:${requestDeadline}ms`}`;
        const existing = pendingTranslations.get(pendingKey);
        // 共享的是 provider 工作；每个等待者仍需保留自己的取消和截止边界。
        if (existing) {
            execution.trace.shared = true;
            try {
                return await runWithinDeadline(() => existing, requestDeadline, execution.abortSignal);
            } catch (error) {
                // 仅恢复早于自身截止时间的共享 transport 超时；普通失败和自身取消仍原样返回。
                if (!recoverSharedDeadline || !(error instanceof TranslationProviderDeadlineError) || now() >= requestDeadline) throw error;
                // 恢复轮按原绝对截止时间去重；相同等待者共享一次重发，仍最多恢复一轮。
                execution.trace.shared = false;
                return translateSingleWithCache(execution, message, context, pageContext, useCache,
                    requestGeneration, requestDeadline, pendingBudgetMs, false);
            }
        }

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
                if (isCacheableSingleResult(execution, message, cached) && !leakedPageContext) {
                    execution.trace.cachedSegments = 1;
                    return cached;
                }

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
                if (isCacheableSingleResult(execution, message, recovered)) {
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
            if (isCacheableSingleResult(execution, message, result)) {
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
        recoverSharedDeadline = true,
    ): Promise<string[]> {
        const cacheMode: CacheRequestMode = message.aiMultiSegment === true && !supportsNativeTranslationBatch(execution.service)
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
        // 完整批次身份只计算一次；AI 分项用定长摘要保留邻段和槽位语义，避免逐项携带整个批次。
        const batchFingerprint = cacheMode === 'ai-multi-segment' ? sha256Hex(batchKey) : '';
        const pendingKey = `${buildPendingRequestKey(batchKey, pendingBudgetMs, requestGeneration)}:cache:${useCache ? 'on' : 'off'}${pendingIdentitySuffix(execution, message.modelOverride)}${pendingAnonymousConfigSuffix(execution)}${pendingCloudConfigSuffix(execution)}${import.meta.env.BROWSER !== 'userscript' && message.documentBatch === true ? ':document-batch' : ''}${recoverSharedDeadline ? '' : `:recovery-deadline:${requestDeadline}ms`}`;
        const existing = pendingBatches.get(pendingKey);
        if (existing) {
            execution.trace.shared = true;
            try {
                return await runWithinDeadline(() => existing, requestDeadline, execution.abortSignal);
            } catch (error) {
                // 仅恢复早于自身截止时间的共享 transport 超时；普通失败和自身取消仍原样返回。
                if (!recoverSharedDeadline || !(error instanceof TranslationProviderDeadlineError) || now() >= requestDeadline) throw error;
                // 恢复轮按原绝对截止时间去重；相同等待者共享一次重发，仍最多恢复一轮。
                execution.trace.shared = false;
                return translateBatchWithCache(execution, message, context, pageContext, useCache,
                    requestGeneration, requestDeadline, pendingBudgetMs, false);
            }
        }

        const request = useCache ? (async () => {
            const itemKeys = message.origin.map((origin, index) => buildBatchItemCacheKey(
                execution, origin, index, batchFingerprint, context, pageContext, cacheMode, message.modelOverride,
            ));
            const reads = new Map<string, Promise<string | null>>();
            // 步骤 1：分项读取缓存，只把缺失且去重后的原文交给 provider。
            const cached = await runWithinDeadline(
                () => Promise.all(itemKeys.map(itemKey => {
                    let read = reads.get(itemKey);
                    if (!read) {
                        read = readCacheWithPendingValue(requestGeneration, itemKey);
                        reads.set(itemKey, read);
                    }
                    return read;
                })),
                requestDeadline,
                execution.abortSignal,
            );
            const leakedCachedIndexes = new Set<number>();
            const validatedCached = cached.map((value, index) => {
                if (!hasTranslationContent(message.origin[index] ?? '')) return message.origin[index] ?? '';
                if (value === null || !isCacheableResult(message.origin[index]!, value, execution)) return null;
                if (!isDefiniteRecoveryPageContextLeak(
                    execution,
                    message.origin[index]!,
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
                execution.trace.cachedSegments = message.origin.length;
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
                    const origin = message.origin[index];
                    if (!isCacheableResult(origin, value, execution)) return;
                    await persistCacheWrite(
                        requestGeneration,
                        itemKeys[index],
                        value,
                    );
                }));
                return translated;
            }
            // 只有逐项补齐时缓存结果才会被使用；AI 合批整包重算不计入缓存命中。
            execution.trace.cachedSegments = message.origin.length - missingIndexes.length;
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
                    itemKeys[index],
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
                    translatedByKey.set(key, translated[index]);
                });
            }

            // 步骤 2：按原请求顺序回填结果，并只缓存有效译文。
            const result = [...validatedCached] as Array<string | null>;
            const cacheWrites: Promise<void>[] = [];
            const writtenKeys = new Set<string>();
            missingEntries.forEach(({index, origin}) => {
                const itemKey = itemKeys[index];
                const value = translatedByKey.get(itemKey);
                result[index] = value as string;
                if (!writtenKeys.has(itemKey) && isCacheableResult(origin, value, execution)) {
                    writtenKeys.add(itemKey);
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

    function translationRequestSource(trace: TranslationRequestTrace, segmentCount: number): TranslationRequestSource {
        if (trace.shared) return 'shared';
        if (trace.cachedSegments === 0) return 'network';
        return trace.cachedSegments >= segmentCount ? 'cache' : 'partial';
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
                serviceId: trace.serviceId || message.serviceOverride || config().service || 'unknown',
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

    async function translateWithCache(message: TranslationRequestMessage): Promise<string | string[]> {
        // 此标志可经公开 runtime 协议进入后台；即使调用方绕过 parser，缓存边界也必须拒绝不兼容形态。
        if (message.validateInlineCodeTranslation !== undefined && typeof message.validateInlineCodeTranslation !== 'boolean') {
            throw new TypeError('翻译请求字段 validateInlineCodeTranslation 必须是布尔值');
        }
        if (message.validateInlineCodeTranslation === true && (
            typeof message.origin !== 'string' || !isValidInlineCodeSource(message.origin) ||
            message.validateTranslationSlots === true || message.aiMultiSegment === true || message.documentBatch === true ||
            message.enableAIContext !== false || Boolean(message.context) || Boolean(message.pageContext) ||
            Boolean(message.discourseContext) || (message.glossaryContext !== undefined && message.glossaryContext !== 'page') ||
            Boolean(getTranslationImageInput(message)) || (getTranslationGlossaryContext(message)?.context ?? 'page') !== 'page'
        )) throw new TypeError('行内代码翻译请求格式无效');
        // 空请求没有 provider 语义，也不应被配置水合阻塞或计入统计。
        if (Array.isArray(message.origin) && message.origin.length === 0) return [];
        if (Array.isArray(message.origin) && Array.from(message.origin).every(origin =>
            typeof origin === 'string' && !hasTranslationContent(origin))) return [...message.origin];
        if (typeof message.origin === 'string' && !message.origin.trim()) return message.origin;

        message = createTranslationRequestSnapshot(message);

        const trace: TranslationRequestTrace = {cachedSegments: 0, shared: false, upstreamCalls: 0, upstreamMs: 0, routeAttempts: []};
        const startedAt = startTranslationRequest(message, now);
        const statsGeneration = deps.captureTranslationStatsGeneration?.() ?? 0;
        try {
            const result = await executeTranslation(message, trace, startedAt);
            recordTranslationRequest(message, trace, startedAt, statsGeneration, 'success', result);
            return result;
        } catch (error) {
            recordTranslationRequest(message, trace, startedAt, statsGeneration, modelUsageOutcome(error), undefined, error);
            throw error;
        }
    }

    async function executeTranslation(
        message: TranslationRequestMessage,
        trace: TranslationRequestTrace,
        providerStartedAt: number,
        compositeMember = false,
    ): Promise<string | string[]> {
        const requestControl = getTranslationRequestControl(message);
        throwIfRequestAborted(requestControl?.signal);
        // 入口选择也必须在水合/队列之前复制，防止上层原地编辑数组改变在途请求。
        const glossaryIds = message.glossaryIds ? Object.freeze([...message.glossaryIds]) : message.glossaryIds;

        // deadline 从公开入口开始计时（与统计开始时间共用一次时钟读取），配置水合不能让上层剩余预算重新获得完整时长。
        const explicitProviderBudget = getExplicitTranslationBudget(message);
        // 水合仍有独立的有界等待；不得先读取未就绪的服务/设置决定此次 AI 默认。
        await runWithinDeadline(() => deps.ready,
            providerStartedAt + (explicitProviderBudget ?? DEFAULT_PROVIDER_TIMEOUT_MS), requestControl?.signal);
        throwIfRequestAborted(requestControl?.signal);

        // 步骤 1：圈选等受信后台事务沿用开始时的 symbol 快照；未附着的公开请求才在 cache/provider await 前复制配置。
        let current = getTranslationProviderConfig(message, () => createTranslationProviderConfigSnapshot(config()));
        // 配置拒绝也归属于尝试的无痕路由，不能在失败统计中冒用普通服务身份。
        if (current.privateTranslation?.enabled) {
            const identity = getTranslationGlossaryContext(message)?.privateContext;
            if (identity !== false) {
                trace.serviceId = identity === true ? current.privateTranslation.service || 'private-translation' : 'private-identity-unknown';
                trace.model = identity === true ? current.privateTranslation.model : undefined;
            }
        }
        ({config: current, request: message} = resolvePrivateTranslation(current, message));
        const serviceOverride = message.serviceOverride;
        const selectedService = serviceOverride || current.service;
        const providerBudget = explicitProviderBudget ?? (deps.serviceTypes.isAI(selectedService)
            ? normalizeAiRequestTimeoutMs(current.aiRequestTimeoutMs) : DEFAULT_PROVIDER_TIMEOUT_MS);
        const providerDeadline = providerStartedAt + providerBudget;
        trace.serviceId = selectedService;
        if (selectedService === services.chatgptPlan) {
            const unavailable = getTranslationServiceUnavailableMessage(selectedService);
            if (unavailable) throw Object.assign(new Error(unavailable), {kind: 'bad-request', retryable: false});
        }
        if (isCompositeTranslationProviderId(selectedService)) {
            const profile = getCompositeTranslationProvider(current.compositeTranslationProviders, selectedService);
            if (!profile) throw new Error('组合翻译服务已被删除，请重新选择服务');
            if (!profile.services.length) throw new Error('请先为组合翻译添加至少一个服务');
            let lastError: unknown;
            for (const member of compositeRouting.order(profile)) {
                throwIfRequestAborted(requestControl?.signal);
                // 即使受信快照含未规范化的旧配置，也不允许递归组合或自引用。
                if (isCompositeTranslationProviderId(member)) continue;
                const startedAt = now();
                const remaining = Math.min(profile.timeoutMs, getRemainingDeadlineMs(providerDeadline));
                const child = attachTranslationProviderConfig({
                    ...message,
                    serviceOverride: member,
                    requestTimeoutMs: remaining,
                    [TRANSLATION_REMAINING_BUDGET]: true,
                }, current);
                // 组合使用成员各自的模型、Thinking 和合批偏好，入口模型不能覆盖整组。
                delete child.modelOverride;
                delete child.thinkingOverride;
                delete child.enableNativeBatch;
                if (requestControl) attachTranslationRequestControl(child, requestControl);
                const memberTrace: TranslationRequestTrace = {
                    cachedSegments: 0, shared: false, upstreamCalls: 0, upstreamMs: 0, routeAttempts: [],
                };
                try {
                    const result = await executeTranslation(child, memberTrace, startedAt, true);
                    throwIfRequestAborted(requestControl?.signal);
                    // 缓存和共享请求不代表上游响应速度，不能让它们污染智能选择。
                    if (memberTrace.upstreamCalls > 0 && !memberTrace.shared) {
                        compositeRouting.record(profile.id, member, true, now() - startedAt);
                    }
                    trace.cachedSegments = memberTrace.cachedSegments;
                    trace.shared = memberTrace.shared;
                    trace.model = memberTrace.model;
                    collectRouteAttempt(trace, {route: member, outcome: 'success',
                        durationMs: now() - startedAt, chars: measureTranslationText(message.origin).chars});
                    return result;
                } catch (error) {
                    throwIfRequestAborted(requestControl?.signal);
                    if (error instanceof GlossaryRevisionChangedError
                        || (error instanceof Error && error.name === 'AbortError')) throw error;
                    lastError = error;
                    compositeRouting.record(profile.id, member, false, now() - startedAt);
                    collectRouteAttempt(trace, {route: member, outcome: modelUsageOutcome(error),
                        durationMs: now() - startedAt, chars: measureTranslationText(message.origin).chars});
                } finally {
                    trace.upstreamCalls += memberTrace.upstreamCalls;
                    trace.upstreamMs += memberTrace.upstreamMs;
                    for (const attempt of memberTrace.routeAttempts) collectRouteAttempt(trace, attempt);
                }
            }
            throw lastError ?? new Error('组合翻译没有可用的成员服务');
        }
        if (deps.serviceTypes.isAI(selectedService)) {
            trace.model = cleanModelName(getEffectiveRequestModel(current, selectedService, message.modelOverride));
        }
        const imageInput = getTranslationImageInput(message);
        if (imageInput && Array.isArray(message.origin) && message.origin.length > 0) {
            throw new Error('图片识别请求必须使用单条原文');
        }
        const selectedModel = getSelectedModel(current, selectedService, message.modelOverride);
        if (imageInput && (!deps.serviceTypes.isAI(selectedService)
            || !supportsVisionTransport(selectedService, selectedModel))) {
            throw new Error('图片识别需要支持视觉输入的 AI 翻译服务');
        }
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
        // 文档合批只接受受信入口的数组；保留同一分项译文缓存，pending 则按执行策略隔离。
        if (import.meta.env.BROWSER !== 'userscript' && message.documentBatch !== undefined
            && (message.documentBatch !== true || !Array.isArray(message.origin) || glossarySource?.context !== 'document')) {
            const {documentBatch: _ignored, ...withoutDocumentBatch} = message;
            message = withoutDocumentBatch as TranslationRequestMessage;
        }
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
            glossaryMatchContext: Object.freeze({context: glossaryContext, sourceLanguage, targetLanguage, pageUrl: glossarySource?.pageUrl,
                glossaryIds: selectedGlossaryIds ? Object.freeze([...selectedGlossaryIds]) : null}),
        });
        const execution: TranslationRequestExecution = {
            config: current,
            service: selectedService,
            sourceLanguage,
            targetLanguage,
            enableAIContext: message.enableAIContext ?? current.enableAIContext,
            nativeBatchEnabled: supportsNativeTranslationBatch(selectedService) && (message.enableNativeBatch
                ?? isNativeTranslationBatchEnabled(selectedService, current.nativeBatchTranslationEnabled)),
            acceptUnchangedResult: isUnchangedTranslationResultAllowed(message),
            compositeMember,
            thinking: message.thinkingOverride ?? isModelThinkingEnabled(
                current.modelThinking,
                selectedService,
                getSelectedModel(current, selectedService, message.modelOverride),
            ),
            abortSignal: requestControl?.signal,
            ownershipKey: requestControl?.ownershipKey,
            privateContext: glossarySource?.privateContext,
            trace,
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
        // 共享持久译文与摘要键不携带隐私身份；所有可信无痕请求均不得读写，开关只控制模型路由。
        const useCache = !imageInput && execution.privateContext !== true && isCacheEnabled(current, message);
        // clear 是缓存代次的线性化边界。清理期间进入的缓存请求必须等到所有
        // 已串联 clear 完成后再取得新代次，等待时间仍计入原始 deadline 且可取消。
        if (useCache) {
            await waitForCacheClearBarrier(providerDeadline, requestControl?.signal);
        }
        const requestGeneration = cacheGeneration;
        // 步骤 2：摘要是 AI 上下文增强，只拿 provider deadline 的一小段预算。
        const summaryBudget = Math.min(10_000, Math.max(1_000, Math.floor(providerBudget / 4)));
        const summarizedPageContext = imageInput ? '' : await addPageSummary(
            execution,
            rawPageContext,
            useCache,
            requestGeneration,
            providerDeadline,
            message.modelOverride,
            summaryBudget,
        );
        // 篇章证据不进入摘要缓存：每段只复用原有页面摘要，且总参考预算保持 4,000。
        const discourse = !imageInput && isAIContextEnabled(execution, message.modelOverride)
            && typeof message.discourseContext === 'string' ? message.discourseContext.slice(0, 2400) : '';
        const pageContext = discourse
            ? `${summarizedPageContext.slice(0, Math.max(0, 4000 - discourse.length - 48))}\n<discourse_evidence>\n${discourse}\n</discourse_evidence>`.slice(0, 4000)
            : summarizedPageContext;
        const remainingProviderBudget = getRemainingDeadlineMs(providerDeadline);

        // 步骤 3：检测样本只属于本地翻译 auto；即使其他扩展页面手工构造该字段，
        // 也不能让重复正文扩散到任何云端 provider。
        const shouldCarryDetectionText = (selectedService === 'chromeTranslator' || selectedService === 'localTranslation')
            && sourceLanguage === 'auto'
            && Boolean(message.sourceLanguageDetectionText?.trim());
        const {discourseContext: _rawDiscourse, ...withoutDiscourse} = message;
        const providerInput = shouldCarryDetectionText
            ? withoutDiscourse as TranslationRequestMessage
            : (() => {
                const {sourceLanguageDetectionText: _ignored, ...withoutDetectionText} = withoutDiscourse;
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
                enableNativeBatch: execution.nativeBatchEnabled,
                requestTimeoutMs: remainingProviderBudget,
            } as TranslationRequestMessage,
            current,
        );
        if (imageInput) attachTranslationImageInput(requestMessage, imageInput);
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
