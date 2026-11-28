/**
 * @file src/features/full-page-translation/content/requestCache.ts
 * 文件职责：负责全文翻译会话的配置快照冻结、调用身份键构建、会话级槽缓存与在途请求复用及宽限取消管理。
 * 主要内容：捕获并冻结服务、模型、显示模式、术语版本与排除语种快照；提供可取消的等待包装、有界请求缓存淘汰、重挂载宽限计时与失败请求归档清理。
 * 模块边界：仅管理配置快照与请求缓存状态，不执行底层翻译批处理调度、行内代码试探或 DOM 渲染操作。
 */
import {discourseRequestIdentity} from '@/src/services/translation/context/discourse';
import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {getCompositeTranslationConfigFingerprint, hasCompositeTranslationAIContext} from '@/src/core/config/compositeTranslation';
import {styles} from '@/src/core/config/constants';
import {config} from '@/src/services/config/store';
import {resolveSiteTranslationDisplay} from '@/src/core/site-rules/domain';
import {normalizeMaxConcurrentTranslations} from '@/src/core/config/scheduling';
import {normalizeAiMultiSegmentMaxCharacters, normalizeAiMultiSegmentMaxSegments} from '@/src/core/config/aiMultiSegment';
import {normalizeExcludedLanguages} from '@/src/core/config/pageTranslation';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {createGlossaryRevisionMemoizer} from '@/src/core/glossary';
import type {TranslateOptions} from '@/src/services/translation/client';
import {supportsNativeTranslationBatch} from '@/src/services/translation/capabilities';
import {
    cancelTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';
import type {FullPageTranslationConfigSnapshot, PageTranslationConfigOverrides} from './translationConfigSnapshot';

const FULL_PAGE_TRANSLATION_CACHE_LIMIT = 512;
const FULL_PAGE_TRANSLATION_REQUEST_CACHE_LIMIT = 512;
const FULL_PAGE_TRANSLATION_REMOUNT_GRACE_MS = 250;
const LOCAL_TRANSLATION_CANDIDATE_CONCURRENCY_CAP = 2;

// 悬浮手势的每次配置捕获仍同步冻结字段；只有全库摘要经原始标量复验后复用。
export const readGlossaryRevision = createGlossaryRevisionMemoizer();

export function getAIMultiSegmentLimits(snapshot: FullPageTranslationConfigSnapshot) {
    if (!snapshot.enableAIMultiSegment || supportsNativeTranslationBatch(snapshot.service)
        || !servicesType.isUseAIContext(snapshot.service, snapshot.model)) return undefined;
    return {
        maxSegments: normalizeAiMultiSegmentMaxSegments(snapshot.aiMultiSegmentMaxSegments),
        maxCharacters: normalizeAiMultiSegmentMaxCharacters(snapshot.aiMultiSegmentMaxCharacters),
    };
}

/** 候选准备容量须容纳一批；串行本地模型上限为 2（1 执行 + 1 预取）以避免滚动后旧段落积压；真正的 provider 请求并发仍由 client 队列与后台调度器约束。 */
export function getFullPageTranslationCandidateConcurrency(
    snapshot: FullPageTranslationConfigSnapshot,
    configuredConcurrency: unknown,
): number {
    const concurrency = normalizeMaxConcurrentTranslations(configuredConcurrency);
    if (snapshot.service === services.localTranslation) {
        return Math.min(concurrency, LOCAL_TRANSLATION_CANDIDATE_CONCURRENCY_CAP);
    }
    const aiLimits = getAIMultiSegmentLimits(snapshot);
    return aiLimits ? Math.max(concurrency, aiLimits.maxSegments) : concurrency;
}

export function getTranslationInvocationIdentity(snapshot: FullPageTranslationConfigSnapshot): string {
    return JSON.stringify([
        snapshot.profileId ?? '', snapshot.service, snapshot.model, snapshot.thinking,
        snapshot.sourceLanguage, snapshot.targetLanguage, snapshot.displayMode, snapshot.style,
        snapshot.longParagraphLineBreak ?? false, snapshot.translationBeforeOriginal ?? false,
        snapshot.enableAIContext, snapshot.enableAIMultiSegment, snapshot.enableNativeBatch !== false,
        getAIMultiSegmentLimits(snapshot),
        snapshot.glossaryRevision, snapshot.glossaryIds,
        snapshot.excludedLanguages,
        ...(snapshot.compositeConnectionFingerprint ? [snapshot.compositeConnectionFingerprint] : []),
    ]);
}

export interface FullPageTranslationCacheEntry {
    promise: Promise<string | undefined>;
    settled: boolean;
}

export interface FullPageTranslationRequestCacheEntry {
    promise: Promise<string[]>;
    settled: boolean;
    failed: boolean;
    cancelled: boolean;
    waiters: number;
    cancelTimer: ReturnType<typeof setTimeout> | null;
    settledExpiryTimer: ReturnType<typeof setTimeout> | null;
    controller: AbortController;
    queueSession: TranslationQueueSession;
}

export type SnapshotTranslateExecutionOptions = Pick<
    TranslateOptions,
    'aiMultiSegment' | 'queueSession' | 'signal' | 'skipLanguageDetection'
    | 'sourceLanguageDetectionText' | 'useCache' | 'validateTranslationSlots' | 'validateInlineCodeTranslation' | 'discourseContext'
>;

export interface FullPageTranslationSessionCache {
    active: boolean;
    translationSlotCache: Map<string, FullPageTranslationCacheEntry>;
    translationRequestCache?: Map<string, FullPageTranslationRequestCacheEntry>;
    requestSignal?: AbortSignal;
    requestQueueSessions?: Set<TranslationQueueSession>;
    requestControllers?: Set<AbortController>;
    pageContextGeneration?: number;
    /** 只有页面路由/生命周期边界递增；普通上下文 mutation 不得使在途结果失效。 */
    renderCommitGeneration?: number;
    /** 悬停请求只复用仍在途的同一工作，不长期保留已结算结果。 */
    retainSettledResults?: boolean;
    /** 全文会话可跨候选合批；悬停瞬时会话保持既有逐候选语义。 */
    allowAIMultiSegment?: boolean;
    /** 悬停会话不参与跨候选原生数组合批。 */
    allowNativeBatch?: boolean;
}

export function captureFullPageTranslationConfig(
    overrides: PageTranslationConfigOverrides = {},
): FullPageTranslationConfigSnapshot {
    const service = overrides.service?.trim() || config.service;
    const configuredModel = overrides.model?.trim();
    const model = configuredModel || resolveConfiguredModel(config.model[service], config.customModel[service]);
    const profileId = overrides.profileId?.trim();
    const requestOverridesApplied = Object.keys(overrides).length > 0;
    return {
        glossaryRevision: readGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
        glossaryIds: overrides.glossaryIds ? Object.freeze([...overrides.glossaryIds]) : null,
        service,
        compositeConnectionFingerprint: getCompositeTranslationConfigFingerprint(config, service),
        compositeAIContext: hasCompositeTranslationAIContext(config, service),
        model,
        thinking: isModelThinkingEnabled(config.modelThinking, service, model),
        sourceLanguage: config.from,
        targetLanguage: overrides.targetLanguage?.trim() || config.to,
        excludedLanguages: Object.freeze(normalizeExcludedLanguages(config.excludedLanguages)),
        useCache: config.useCache,
        enableAIContext: config.enableAIContext,
        enableAIMultiSegment: config.enableAIMultiSegment,
        aiMultiSegmentMaxSegments: normalizeAiMultiSegmentMaxSegments(config.aiMultiSegmentMaxSegments),
        aiMultiSegmentMaxCharacters: normalizeAiMultiSegmentMaxCharacters(config.aiMultiSegmentMaxCharacters),
        enableNativeBatch: isNativeTranslationBatchEnabled(service, config.nativeBatchTranslationEnabled),
        displayMode: overrides.displayMode
            ?? (resolveSiteTranslationDisplay(config, typeof location === 'undefined' ? '' : location.href) === styles.bilingualTranslation ? 'bilingual' : 'single'),
        ...(overrides.displayMode ? {displayModeOverridden: true as const} : {}),
        style: config.style,
        longParagraphLineBreak: Boolean(config.longParagraphLineBreakEnabled),
        translationBeforeOriginal: Boolean(config.translationBeforeOriginal),
        ...(profileId ? {profileId} : {}),
        ...(requestOverridesApplied ? {requestOverridesApplied: true as const} : {}),
    };
}

export function createSnapshotTranslateOptions(
    snapshot: FullPageTranslationConfigSnapshot,
    options: SnapshotTranslateExecutionOptions = {},
): TranslateOptions {
    return {
        ...options,
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        serviceOverride: snapshot.service,
        modelOverride: snapshot.model || undefined,
        thinkingOverride: snapshot.thinking,
        sourceLanguage: snapshot.sourceLanguage,
        targetLanguage: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        enableAIContext: snapshot.enableAIContext,
        enableNativeBatch: snapshot.enableNativeBatch !== false,
        // 显式调用偏好优先，否则沿用冻结值；前端短期复用与后台持久缓存独立。
        useCache: options.useCache ?? snapshot.useCache,
    };
}

export function createAbortError(): Error {
    try {
        return new DOMException('翻译已取消', 'AbortError');
    } catch {
        const error = new Error('翻译已取消');
        error.name = 'AbortError';
        return error;
    }
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export function createCacheKey(origin: string, snapshot: FullPageTranslationConfigSnapshot): string {
    return JSON.stringify({
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        service: snapshot.service,
        compositeConnectionFingerprint: snapshot.compositeConnectionFingerprint,
        model: snapshot.model,
        thinking: snapshot.thinking,
        from: snapshot.sourceLanguage,
        to: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        enableAIContext: snapshot.enableAIContext,
        enableNativeBatch: snapshot.enableNativeBatch !== false,
        origin,
    });
}

export function createRequestCacheKey(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    pageContextGeneration: number,
    aiBatchOwnerIdentity?: number,
    discourseContext?: string,
): string {
    return JSON.stringify({
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        service: snapshot.service,
        compositeConnectionFingerprint: snapshot.compositeConnectionFingerprint,
        model: snapshot.model,
        thinking: snapshot.thinking,
        from: snapshot.sourceLanguage,
        to: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        useCache: snapshot.useCache,
        enableAIContext: snapshot.enableAIContext,
        enableAIMultiSegment: snapshot.enableAIMultiSegment,
        aiMultiSegmentLimits: getAIMultiSegmentLimits(snapshot),
        enableNativeBatch: snapshot.enableNativeBatch !== false,
        context: document.title,
        pageUrl: document.location?.href ?? document.URL ?? '',
        pageContextGeneration,
        aiBatchOwnerIdentity,
        discourseContext: discourseRequestIdentity(discourseContext, origins),
        origins,
    });
}

/** 可取消地等待异步工作，调用者退出时及时解除监听且消费迟到的结果。 */
export function waitForCaller<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
        // 调用方可能在创建 result 的同步过程里取消；仍需消费已创建任务的迟到拒绝。
        void result.catch(() => undefined);
        return Promise.reject(createAbortError());
    }
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(createAbortError()));
        signal.addEventListener('abort', onAbort, {once: true});
        void result.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
        );
    });
}

function clearTranslationRequestCancelTimer(entry: FullPageTranslationRequestCacheEntry): void {
    if (entry.cancelTimer === null) return;
    globalThis.clearTimeout(entry.cancelTimer);
    entry.cancelTimer = null;
}

function clearTranslationRequestSettledExpiryTimer(entry: FullPageTranslationRequestCacheEntry): void {
    if (entry.settledExpiryTimer === null) return;
    globalThis.clearTimeout(entry.settledExpiryTimer);
    entry.settledExpiryTimer = null;
}

function cancelTranslationRequest(entry: FullPageTranslationRequestCacheEntry): void {
    if (entry.settled || entry.cancelled) return;
    entry.cancelled = true;
    entry.controller.abort();
    cancelTranslationQueueSession(entry.queueSession, createAbortError());
}

export function retireTranslationRequest(
    cache: Map<string, FullPageTranslationRequestCacheEntry>,
    key: string,
    entry: FullPageTranslationRequestCacheEntry,
): void {
    cache.delete(key);
    clearTranslationRequestCancelTimer(entry);
    clearTranslationRequestSettledExpiryTimer(entry);
    if (entry.waiters === 0) cancelTranslationRequest(entry);
}

export function rememberTranslationRequest(
    session: FullPageTranslationSessionCache,
    key: string,
    failureKey: string,
    result: Promise<string[]>,
    expectedLength: number,
    controller: AbortController,
    queueSession: TranslationQueueSession,
    retainSettledResult: boolean,
    reuseSettledSuccess = true,
): FullPageTranslationRequestCacheEntry {
    const cache = session.translationRequestCache ??= new Map();
    const entry: FullPageTranslationRequestCacheEntry = {
        promise: result,
        settled: false,
        failed: false,
        cancelled: false,
        waiters: 0,
        cancelTimer: null,
        settledExpiryTimer: null,
        controller,
        queueSession,
    };
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > FULL_PAGE_TRANSLATION_REQUEST_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value as string;
        retireTranslationRequest(cache, oldestKey, cache.get(oldestKey)!);
    }
    void result.then(
        (translations) => {
            entry.settled = true;
            clearTranslationRequestCancelTimer(entry);
            if (cache.get(key) !== entry) return;
            if (translations.length !== expectedLength
                || Array.from(translations).some((translation) => typeof translation !== 'string')
                || !reuseSettledSuccess) {
                cache.delete(key);
            } else if (!retainSettledResult) {
                entry.settledExpiryTimer = globalThis.setTimeout(() => {
                    entry.settledExpiryTimer = null;
                    if (cache.get(key) === entry) cache.delete(key);
                }, FULL_PAGE_TRANSLATION_REMOUNT_GRACE_MS);
            }
        },
        (error) => {
            entry.settled = true;
            clearTranslationRequestCancelTimer(entry);
            if (cache.get(key) !== entry) return;
            if (entry.cancelled || isAbortError(error)) cache.delete(key);
            else if (!retainSettledResult) cache.delete(key);
            else {
                entry.failed = true;
                cache.delete(key);
                cache.delete(failureKey);
                cache.set(failureKey, entry);
            }
        },
    );
    return entry;
}

export function waitForTranslationRequest(
    cache: Map<string, FullPageTranslationRequestCacheEntry>,
    key: string,
    entry: FullPageTranslationRequestCacheEntry,
    signal?: AbortSignal,
): Promise<string[]> {
    entry.waiters += 1;
    clearTranslationRequestCancelTimer(entry);
    return Promise.resolve()
        .then(() => waitForCaller(entry.promise, signal))
        .finally(() => {
            entry.waiters -= 1;
            if (entry.waiters > 0 || entry.settled || entry.cancelled) return;
            entry.cancelTimer = globalThis.setTimeout(() => {
                entry.cancelTimer = null;
                if (cache.get(key) === entry) cache.delete(key);
                cancelTranslationRequest(entry);
            }, FULL_PAGE_TRANSLATION_REMOUNT_GRACE_MS);
        });
}

/** 清空会话级结果；仍有调用方的在途请求可完成，但不再参与后续重挂复用。 */
export function clearFullPageTranslationRequestCache(
    session: Pick<FullPageTranslationSessionCache, 'translationRequestCache'>,
    preserveFailedRequests = false,
): void {
    const cache = session.translationRequestCache;
    if (!cache) return;
    for (const [key, entry] of cache) {
        if (preserveFailedRequests && entry.failed) continue;
        retireTranslationRequest(cache, key, entry);
    }
}

export function rememberTranslation(
    session: FullPageTranslationSessionCache,
    key: string,
    result: Promise<string | undefined>,
): void {
    const entry: FullPageTranslationCacheEntry = {promise: result, settled: false};
    session.translationSlotCache.delete(key);
    session.translationSlotCache.set(key, entry);
    while (session.translationSlotCache.size > FULL_PAGE_TRANSLATION_CACHE_LIMIT) {
        const oldestKey = session.translationSlotCache.keys().next().value as string;
        session.translationSlotCache.delete(oldestKey);
    }
    void result.then(
        () => {
            if (session.translationSlotCache.get(key) === entry) entry.settled = true;
        },
        () => {
            if (session.translationSlotCache.get(key) === entry) session.translationSlotCache.delete(key);
        },
    );
}
