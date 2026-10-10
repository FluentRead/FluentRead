/**
 * @file src/features/full-page-translation/content/translationRequest.ts
 * 文件职责：为单次全文翻译会话冻结请求配置，并执行文本槽的批量、原生数组和显式 AI 跨候选合并、分包、回退与会话级结果复用。
 * 主要内容：冻结调用时的长段落换行与译文位置，操作身份区分展示设置而 provider 结果键仍只包含请求维度；在调用入口复制原文与服务/模型/语言/术语/排除列表快照，先过滤排除语言的文本槽再合批，在本地保留尚未排版的三美元公式源码，构造显式 client 参数，按服务选择批译策略；标记内部单条槽协议，由 broker 按冻结术语和同一截止时间逐槽校验；为本地模型只构造一次整段语言样本，为 Chrome auto 逐槽翻译保留无哨兵整段检测样本，按冻结服务偏好自动原生数组合批，关闭后保留逐项请求，完整结构校验后才分发，AI 只合并同父直接相邻候选并在协议失败后停用同快照合批，严格隔离取消归属并维护有界会话缓存。
 * 模块边界：本文件不发现候选、不持有 DOM 翻译状态也不渲染译文；runtime 提供会话缓存和取消作用域，client 负责后台协议与队列执行。
 */
import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {styles} from '@/src/core/config/constants';
import {
    parseTranslationSlots,
    serializeTranslationSlots,
} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {normalizeMaxConcurrentTranslations} from '@/src/core/config/scheduling';
import {normalizeExcludedLanguages} from '@/src/core/config/pageTranslation';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {createGlossaryRevisionMemoizer} from '@/src/core/glossary';
import {translateText, translateTextBatch, type TranslateOptions} from '@/src/app/translation/client';
import {supportsNativeTranslationBatch, supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {validateNativeBatchResults} from '@/src/core/translation/nativeBatch';
import {hasTranslationContent} from '@/src/core/translation/result';
import {
    cancelTranslationQueueSession,
    createTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';

import {copyFullPageTranslationConfigSnapshot, type FullPageTranslationConfigSnapshot, type PageTranslationConfigOverrides} from './translationConfigSnapshot';

const FULL_PAGE_TRANSLATION_CACHE_LIMIT = 512;
const FULL_PAGE_TRANSLATION_REQUEST_CACHE_LIMIT = 512;
const FULL_PAGE_TRANSLATION_REMOUNT_GRACE_MS = 250;
const CROSS_CANDIDATE_MAX_TEXT_SLOTS = 4;
const CROSS_CANDIDATE_MAX_CHARACTERS = 2_000;
// 悬浮手势的每次配置捕获仍同步冻结字段；只有全库摘要经原始标量复验后复用。
const readGlossaryRevision = createGlossaryRevisionMemoizer();

export type {FullPageTranslationConfigSnapshot, PageTranslationConfigOverrides} from './translationConfigSnapshot';

export function getTranslationInvocationIdentity(snapshot: FullPageTranslationConfigSnapshot): string {
    return JSON.stringify([
        snapshot.profileId ?? '', snapshot.service, snapshot.model, snapshot.thinking,
        snapshot.sourceLanguage, snapshot.targetLanguage, snapshot.displayMode, snapshot.style,
        snapshot.longParagraphLineBreak ?? false, snapshot.translationBeforeOriginal ?? false,
        snapshot.enableAIContext, snapshot.enableAIMultiSegment, snapshot.enableNativeBatch !== false,
        snapshot.glossaryRevision, snapshot.glossaryIds,
        snapshot.excludedLanguages,
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

type SnapshotTranslateExecutionOptions = Pick<
    TranslateOptions,
    'aiMultiSegment' | 'queueSession' | 'signal' | 'skipLanguageDetection'
    | 'sourceLanguageDetectionText' | 'useCache' | 'validateTranslationSlots'
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

interface TranslationBatchTask {
    batchKey: string;
    aiCircuitKey: string;
    context: string;
    owner?: Element;
    origins: readonly string[];
    snapshot: FullPageTranslationConfigSnapshot;
    signal?: AbortSignal;
    queueSession?: TranslationQueueSession;
    settled: boolean;
    resolve: (translations: string[]) => void;
    reject: (error: unknown) => void;
    removeAbortListener: () => void;
    abortSharedBatch?: () => void;
}

interface TranslationBatchQueue {
    pending: TranslationBatchTask[];
    flushScheduled: boolean;
    disabledAIKeys: Set<string>;
}

const translationBatchQueues = new WeakMap<FullPageTranslationSessionCache, TranslationBatchQueue>();
const aiBatchOwnerIds = new WeakMap<Element, number>();
let nextAIBatchOwnerId = 0;

function getAIBatchOwnerIdentity(owner?: Element): number | undefined {
    if (!owner) return undefined;
    let id = aiBatchOwnerIds.get(owner);
    if (id === undefined) {
        id = ++nextAIBatchOwnerId;
        aiBatchOwnerIds.set(owner, id);
    }
    return id;
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
        model,
        thinking: isModelThinkingEnabled(config.modelThinking, service, model),
        sourceLanguage: config.from,
        targetLanguage: overrides.targetLanguage?.trim() || config.to,
        excludedLanguages: Object.freeze(normalizeExcludedLanguages(config.excludedLanguages)),
        useCache: config.useCache,
        enableAIContext: config.enableAIContext,
        enableAIMultiSegment: config.enableAIMultiSegment,
        enableNativeBatch: isNativeTranslationBatchEnabled(service, config.nativeBatchTranslationEnabled),
        displayMode: overrides.displayMode
            ?? (config.display === styles.bilingualTranslation ? 'bilingual' : 'single'),
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
        enableAIContext: snapshot.enableAIContext,
        enableNativeBatch: snapshot.enableNativeBatch !== false,
        // 非会话 batch 需要显式禁用 broker 缓存；其余调用继续使用冻结的会话值。
        useCache: options.useCache ?? snapshot.useCache,
    };
}

function createAbortError(): Error {
    try {
        return new DOMException('翻译已取消', 'AbortError');
    } catch {
        const error = new Error('翻译已取消');
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

/** 文本槽与整段候选、标题使用同一目标/排除语言判断；是否配置排除语言不改变识别深度。 */
function shouldKeepOriginalSlot(origin: string, snapshot: FullPageTranslationConfigSnapshot): boolean {
    return Boolean(origin.trim())
        && shouldSkipTranslationForTarget(origin, snapshot.targetLanguage, snapshot.excludedLanguages);
}

function restoreSkippedSlots(
    origins: readonly string[],
    translatedIndexes: readonly number[],
    translations: readonly string[],
): string[] {
    if (translations.length !== translatedIndexes.length) return [];
    const result = origins.map((origin) => origin ?? '');
    translatedIndexes.forEach((originIndex, translationIndex) => {
        result[originIndex] = translations[translationIndex] ?? '';
    });
    return result;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

async function translateSlotsIndividually(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    context = document.title,
): Promise<string[]> {
    throwIfAborted(signal);
    const translations = new Array<string>(origins.length);
    let nextIndex = 0;
    const workerCount = Math.min(
        normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations),
        origins.length,
    );
    // 本地自动检测沿用整段来源；Chrome 槽协议损坏后也不能退回不可靠的短标题检测。
    const sourceLanguageDetectionText = snapshot.sourceLanguage === 'auto'
        && (snapshot.service === services.localTranslation || snapshot.service === services.chromeTranslator)
        ? origins.join('\n') : undefined;
    let failed = false;
    let firstError: unknown;
    let hasFirstError = false;
    const siblingController = new AbortController();
    const abortSiblings = () => {
        siblingController.abort();
        if (queueSession) cancelTranslationQueueSession(queueSession, createAbortError());
    };
    signal?.addEventListener('abort', abortSiblings, {once: true});
    const workers = Array.from({length: workerCount}, async () => {
        while (!failed && nextIndex < origins.length) {
            throwIfAborted(siblingController.signal);
            const index = nextIndex++;
            try {
                translations[index] = await translateText(origins[index] ?? '', context,
                    createSnapshotTranslateOptions(snapshot, {
                        signal: siblingController.signal,
                        queueSession,
                        ...(sourceLanguageDetectionText !== undefined
                            ? {sourceLanguageDetectionText}
                            : {}),
                    }));
            } catch (error) {
                if (!hasFirstError) {
                    hasFirstError = true;
                    firstError = error;
                }
                failed = true;
                siblingController.abort();
                if (queueSession) cancelTranslationQueueSession(queueSession, firstError);
                throw error;
            }
        }
    });
    try {
        const outcomes = await Promise.allSettled(workers);
        if (hasFirstError) throw firstError;
        const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (rejected) throw rejected.reason;
        return translations;
    } finally {
        signal?.removeEventListener('abort', abortSiblings);
    }
}

function createCacheKey(origin: string, snapshot: FullPageTranslationConfigSnapshot): string {
    return JSON.stringify({
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        service: snapshot.service,
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

function createRequestCacheKey(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    pageContextGeneration: number,
    aiBatchOwnerIdentity?: number,
): string {
    return JSON.stringify({
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        service: snapshot.service,
        model: snapshot.model,
        thinking: snapshot.thinking,
        from: snapshot.sourceLanguage,
        to: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        useCache: snapshot.useCache,
        enableAIContext: snapshot.enableAIContext,
        enableAIMultiSegment: snapshot.enableAIMultiSegment,
        enableNativeBatch: snapshot.enableNativeBatch !== false,
        context: document.title,
        pageUrl: document.location?.href ?? document.URL ?? '',
        pageContextGeneration,
        aiBatchOwnerIdentity,
        origins,
    });
}

function waitForCaller<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
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

function rememberTranslationRequest(
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

function retireTranslationRequest(
    cache: Map<string, FullPageTranslationRequestCacheEntry>,
    key: string,
    entry: FullPageTranslationRequestCacheEntry,
): void {
    if (cache.get(key) === entry) cache.delete(key);
    clearTranslationRequestCancelTimer(entry);
    clearTranslationRequestSettledExpiryTimer(entry);
    if (entry.waiters === 0) cancelTranslationRequest(entry);
}

function waitForTranslationRequest(
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

function rememberTranslation(
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

function resolveTranslationBatchTask(task: TranslationBatchTask, translations: string[]): void {
    if (task.settled) return;
    task.settled = true;
    task.removeAbortListener();
    task.resolve(translations);
}

function rejectTranslationBatchTask(task: TranslationBatchTask, error: unknown): void {
    if (task.settled) return;
    task.settled = true;
    task.removeAbortListener();
    task.reject(error);
}

function shouldFallbackAITranslationBatch(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {kind?: unknown; code?: unknown};
    return candidate.kind === 'response'
        && (candidate.code === 'AI_MULTI_SEGMENT_RESPONSE_INVALID'
            || candidate.code === 'TRANSLATION_SLOT_RESPONSE_INVALID');
}

function createTranslationBatchSnapshotKey(snapshot: FullPageTranslationConfigSnapshot): string {
    return JSON.stringify({
        glossaryRevision: snapshot.glossaryRevision,
        glossaryIds: snapshot.glossaryIds,
        service: snapshot.service,
        model: snapshot.model,
        thinking: snapshot.thinking,
        from: snapshot.sourceLanguage,
        to: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        useCache: snapshot.useCache,
        enableAIContext: snapshot.enableAIContext,
        enableNativeBatch: snapshot.enableNativeBatch !== false,
    });
}

function createBatchScopeKey(snapshot: FullPageTranslationConfigSnapshot, session: FullPageTranslationSessionCache): string {
    return JSON.stringify([createTranslationBatchSnapshotKey(snapshot), document.title,
        document.location?.href ?? document.URL ?? '', session.pageContextGeneration ?? 0]);
}

function createAIBatchCircuitKey(snapshot: FullPageTranslationConfigSnapshot): string {
    // 正文变动需要隔离分组和缓存，却不能让同会话、同配置重新试用已经失败的协议。
    return JSON.stringify([createTranslationBatchSnapshotKey(snapshot), document.title,
        document.location?.href ?? document.URL ?? '']);
}

function createInvalidAIResponse(): Error {
    return Object.assign(new Error('批量翻译返回结构异常'), {
        kind: 'response',
        code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID',
    });
}

function takeTranslationBatch(queue: TranslationBatchQueue): TranslationBatchTask[] {
    const batch: TranslationBatchTask[] = [];
    let characters = 0;
    let textSlots = 0;
    let snapshotKey = '';
    while (queue.pending.length > 0) {
        const next = queue.pending[0]!;
        if (next.settled || next.signal?.aborted) {
            queue.pending.shift();
            continue;
        }
        const nextSnapshotKey = next.batchKey;
        if (batch.length > 0 && nextSnapshotKey !== snapshotKey) break;
        const previous = batch.at(-1);
        // 只有真实 DOM 相邻候选才共享 AI 上下文；数组接口的各项由 provider 独立翻译。
        if (previous && !supportsNativeTranslationBatch(next.snapshot.service)
            && (previous.owner || next.owner)
            && (!previous.owner || !next.owner || previous.owner.parentElement !== next.owner.parentElement
                || next.owner.previousElementSibling !== previous.owner)) break;
        const nextCharacters = next.origins.reduce((total, origin) => total + (origin?.length ?? 0), 0);
        const nextTextSlots = next.origins.length;
        if (batch.length > 0 && (
            textSlots + nextTextSlots > CROSS_CANDIDATE_MAX_TEXT_SLOTS
            || characters + nextCharacters > CROSS_CANDIDATE_MAX_CHARACTERS
        )) break;
        queue.pending.shift();
        batch.push(next);
        snapshotKey = nextSnapshotKey;
        textSlots += nextTextSlots;
        characters += nextCharacters;
    }
    return batch;
}

async function fallbackTranslationBatchTasks(tasks: readonly TranslationBatchTask[]): Promise<void> {
    const activeTasks = tasks.filter((task) => !task.settled && !task.signal?.aborted);
    // 多段协议已失败时直接逐槽降级，不再为每个候选重试一次相同结构化协议。
    const outcomes = await Promise.allSettled(activeTasks.map((task) => translateSlotsIndividually(
        task.origins,
        task.snapshot,
        task.signal,
        task.queueSession,
        task.context,
    )));
    outcomes.forEach((outcome, index) => {
        const task = activeTasks[index];
        if (!task) return;
        if (outcome.status === 'fulfilled') resolveTranslationBatchTask(task, outcome.value);
        else rejectTranslationBatchTask(task, outcome.reason);
    });
}

async function executeTranslationBatch(tasks: TranslationBatchTask[], queue: TranslationBatchQueue): Promise<void> {
    const activeTasks = tasks.filter((task) => !task.settled && !task.signal?.aborted);
    if (activeTasks.length === 0) return;
    const native = supportsNativeTranslationBatch(activeTasks[0]!.snapshot.service);
    if (!native && queue.disabledAIKeys.has(activeTasks[0]!.aiCircuitKey)) {
        await fallbackTranslationBatchTasks(activeTasks);
        return;
    }
    if (activeTasks.length === 1) {
        const task = activeTasks[0]!;
        try {
            resolveTranslationBatchTask(task, await translateTextSlotsDirectly(
                task.origins,
                task.snapshot,
                task.signal,
                task.queueSession,
                undefined,
                () => queue.disabledAIKeys.add(task.aiCircuitKey),
                task.context,
            ));
        } catch (error) {
            if (!native && shouldFallbackAITranslationBatch(error)) {
                queue.disabledAIKeys.add(task.aiCircuitKey);
                await fallbackTranslationBatchTasks([task]);
                return;
            }
            rejectTranslationBatchTask(task, error);
        }
        return;
    }

    const snapshot = activeTasks[0]!.snapshot;
    const controller = new AbortController();
    const sharedQueueSession = createTranslationQueueSession();
    const abortSharedBatchIfUnused = () => {
        if (activeTasks.some((task) => !task.settled && !task.signal?.aborted)) return;
        if (!controller.signal.aborted) controller.abort();
        cancelTranslationQueueSession(sharedQueueSession, createAbortError());
    };
    activeTasks.forEach((task) => {
        task.abortSharedBatch = abortSharedBatchIfUnused;
    });

    const origins = activeTasks.flatMap((task) => [...task.origins]);
    try {
        const response = await translateTextBatch(
            origins,
            activeTasks[0]!.context,
            createSnapshotTranslateOptions(snapshot, {
                ...(native ? {} : {aiMultiSegment: true}),
                signal: controller.signal,
                queueSession: sharedQueueSession,
            }),
        );
        const translations = native
            ? validateNativeBatchResults(origins, response, '批量翻译返回结构异常')
            : Array.isArray(response) ? Array.from(response) : [];
        if (translations.length !== origins.length
            || translations.some((translation, index) => typeof translation !== 'string'
                || (hasTranslationContent(origins[index] ?? '') && !hasTranslationContent(translation)))) {
            throw createInvalidAIResponse();
        }
        let offset = 0;
        activeTasks.forEach((task) => {
            const nextOffset = offset + task.origins.length;
            resolveTranslationBatchTask(task, translations.slice(offset, nextOffset));
            offset = nextOffset;
        });
    } catch (error) {
        if (!native && shouldFallbackAITranslationBatch(error)) {
            queue.disabledAIKeys.add(activeTasks[0]!.aiCircuitKey);
            await fallbackTranslationBatchTasks(activeTasks);
        } else if (!isAbortError(error) || activeTasks.some((task) => !task.settled)) {
            activeTasks.forEach((task) => rejectTranslationBatchTask(task, error));
        }
    } finally {
        activeTasks.forEach((task) => {
            task.abortSharedBatch = undefined;
        });
    }
}

function flushTranslationBatchQueue(queue: TranslationBatchQueue): void {
    queue.flushScheduled = false;
    while (queue.pending.length > 0) {
        const batch = takeTranslationBatch(queue);
        if (batch.length === 0) continue;
        void executeTranslationBatch(batch, queue);
    }
}

function enqueueTranslationBatchTask(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal: AbortSignal | undefined,
    queueSession: TranslationQueueSession | undefined,
    session: FullPageTranslationSessionCache,
    owner?: Element,
): Promise<string[]> {
    throwIfAborted(signal);
    let queue = translationBatchQueues.get(session);
    if (!queue) {
        queue = {pending: [], flushScheduled: false, disabledAIKeys: new Set()};
        translationBatchQueues.set(session, queue);
    }

    return new Promise<string[]>((resolve, reject) => {
        const task: TranslationBatchTask = {
            batchKey: createBatchScopeKey(snapshot, session),
            aiCircuitKey: createAIBatchCircuitKey(snapshot),
            context: document.title,
            owner,
            origins,
            snapshot,
            signal,
            queueSession,
            settled: false,
            resolve,
            reject,
            removeAbortListener: () => undefined,
        };
        const onAbort = () => {
            rejectTranslationBatchTask(task, createAbortError());
            task.abortSharedBatch?.();
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, {once: true});
            task.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        queue!.pending.push(task);
        if (!queue!.flushScheduled) {
            queue!.flushScheduled = true;
            const schedule = globalThis.queueMicrotask
                ?? ((callback: VoidFunction) => void Promise.resolve().then(callback));
            schedule(() => flushTranslationBatchQueue(queue!));
        }
    });
}

async function translateArrayWithValidation(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    options: SnapshotTranslateExecutionOptions,
    context = document.title,
): Promise<string[]> {
    const translations = await translateTextBatch([...origins], context,
        createSnapshotTranslateOptions(snapshot, options));
    // 原生响应恢复只由 broker 在同一总 deadline 内执行；最终失败不得在前端重获预算。
    return supportsNativeTranslationBatch(snapshot.service)
        ? validateNativeBatchResults(origins, translations, '批量翻译返回结构异常')
        : translations;
}

async function translateTextSlotsDirectly(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    onSlotProtocolInvalid?: () => void,
    context = document.title,
): Promise<string[]> {
    throwIfAborted(signal);
    // 小模型直接翻译各槽，不要求模型复述结构标记；短链接借用段落正文检测语言。
    if (snapshot.service === services.localTranslation) {
        return translateSlotsIndividually(origins, snapshot, signal, queueSession, context);
    }
    const batchFriendly = supportsNativeTranslationBatch(snapshot.service)
        || snapshot.service === services.freeTranslation
        || snapshot.service === services.bilibili
        || (servicesType.isMachine(snapshot.service) && supportsTranslationBatch(snapshot.service));
    if (batchFriendly) {
        if (!fullPageSession?.active || fullPageSession.retainSettledResults === false) {
            return translateArrayWithValidation(origins, snapshot, {useCache: false, signal, queueSession}, context);
        }

        const resultPromises = new Array<Promise<string | undefined>>(origins.length);
        const missing = new Map<string, {origin: string; indexes: number[]}>();
        for (const [index, origin] of origins.entries()) {
            const key = createCacheKey(origin, snapshot);
            const cached = fullPageSession.translationSlotCache.get(key);
            // 未结算的逐槽 promise 仍属于创建它的整请求取消域。只复用稳定结果；
            // 完全相同的重挂请求由外层 request cache 安全合并并统计 waiter。
            if (cached?.settled) {
                resultPromises[index] = cached.promise;
                continue;
            }
            const entry = missing.get(key);
            if (entry) entry.indexes.push(index);
            else missing.set(key, {origin, indexes: [index]});
        }

        if (missing.size > 0) {
            const entries = [...missing.values()];
            const providerRequest = translateArrayWithValidation(
                entries.map(({origin}) => origin),
                snapshot,
                {signal, queueSession},
                context,
            ).then((translations) =>
                Array.isArray(translations) && translations.length === entries.length
                && Array.from(translations).every((translation) => typeof translation === 'string')
                    ? translations
                    : null,
            );
            entries.forEach(({origin, indexes}, entryIndex) => {
                const key = createCacheKey(origin, snapshot);
                const result = providerRequest.then((translations) => translations?.[entryIndex]);
                rememberTranslation(fullPageSession, key, result);
                indexes.forEach((index) => {
                    resultPromises[index] = result;
                });
            });
        }

        const translations = await Promise.all(resultPromises);
        if (translations.some((translation) => typeof translation !== 'string')) {
            fullPageSession.translationSlotCache.clear();
            return [];
        }
        return translations as string[];
    }
    if (origins.length === 1) {
        return [await translateText(origins[0] ?? '', context,
            createSnapshotTranslateOptions(snapshot, {signal, queueSession}))];
    }

    // 只有支持通用提示词的模型使用内部槽协议；单串机器接口不得承担标记分界。
    if (servicesType.isMachine(snapshot.service)
        || (servicesType.isAI(snapshot.service) && !servicesType.isUseAIContext(snapshot.service, snapshot.model))) {
        return translateSlotsIndividually(origins, snapshot, signal, queueSession, context);
    }
    const packet = serializeTranslationSlots(origins);
    const combined = await translateText(packet.payload, context, createSnapshotTranslateOptions(snapshot, {
        skipLanguageDetection: true,
        validateTranslationSlots: true,
        signal,
        queueSession,
    }));
    throwIfAborted(signal);
    const parsed = parseTranslationSlots(packet, combined);
    if (parsed?.length === origins.length) return parsed;
    onSlotProtocolInvalid?.();
    return translateSlotsIndividually(origins, snapshot, signal, queueSession, context);
}

export async function translateTextSlots(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    fullPageSession?: FullPageTranslationSessionCache,
    forceFailedRequest = false,
    batchOwner?: Element,
): Promise<string[]> {
    if (origins.length === 0) return [];
    throwIfAborted(signal);
    // 缓存身份、微任务合批、协议回退与跳过槽回填都必须使用同一次调用的值。
    origins = Array.from(origins);
    snapshot = copyFullPageTranslationConfigSnapshot(snapshot);
    const requestContext = document.title;
    // Codeforces 在 MathJax 排版前使用 $$$...$$$。公式源码留在本地，
    // 只把两侧正文交给现有槽请求；回填不依赖模型保留占位符，也不改宿主 DOM。
    // 仅处理完整的三美元定界符，不把普通价格或未闭合片段猜成公式。
    const formulaPattern = /(?<!\$)\${3}(?!\$)[^$]+?\${3}(?!\$)/gu;
    if (origins.some(origin => /(?<!\$)\${3}(?!\$)[^$]+?\${3}(?!\$)/u.test(origin ?? ''))) {
        const prose: string[] = [];
        const parts = origins.map(origin => {
            const text = origin ?? '';
            const pieces: Array<string | number> = [];
            const addProse = (value: string) => {
                if (!value.trim()) pieces.push(value);
                else {
                    const match = /^(\s*)([\s\S]*?\S)(\s*)$/u.exec(value)!;
                    pieces.push(match[1], prose.length, match[3]);
                    prose.push(match[2]);
                }
            };
            let cursor = 0;
            for (const match of text.matchAll(formulaPattern)) {
                addProse(text.slice(cursor, match.index));
                pieces.push(match[0]);
                cursor = match.index + match[0].length;
            }
            addProse(text.slice(cursor));
            return pieces;
        });
        const translations = await translateTextSlots(prose, snapshot, signal, queueSession, fullPageSession, forceFailedRequest, batchOwner);
        if (translations.length !== prose.length) return [];
        return parts.map(pieces => pieces.map(piece => typeof piece === 'number' ? translations[piece] : piece).join(''));
    }
    const translatedIndexes = origins
        .map((origin, index) => shouldKeepOriginalSlot(origin ?? '', snapshot) ? -1 : index)
        .filter((index) => index >= 0);
    if (translatedIndexes.length === 0) return [...origins];
    // 全量路径复用入口自己的快照；只有跳过语言槽时才创建回填所需的子集。
    const requestOrigins = translatedIndexes.length === origins.length
        ? origins
        : translatedIndexes.map((index) => origins[index] ?? '');
    const isAICrossCandidateRequest = snapshot.enableAIMultiSegment
        && !supportsNativeTranslationBatch(snapshot.service)
        && servicesType.isUseAIContext(snapshot.service, snapshot.model)
        && fullPageSession?.active && fullPageSession.allowAIMultiSegment !== false;
    const execute = (
        executionSignal: AbortSignal | undefined,
        executionQueueSession: TranslationQueueSession | undefined,
    ) => {
        const canCombineNativeParagraphs = supportsNativeTranslationBatch(snapshot.service)
            && snapshot.enableNativeBatch !== false
            && fullPageSession?.active && fullPageSession.allowNativeBatch !== false;
        const canCombineAIParagraphs = isAICrossCandidateRequest;
        const request = (canCombineNativeParagraphs || canCombineAIParagraphs)
            ? enqueueTranslationBatchTask(
                requestOrigins,
                snapshot,
                executionSignal,
                executionQueueSession,
                fullPageSession!,
                batchOwner,
            )
            : translateTextSlotsDirectly(
                requestOrigins,
                snapshot,
                executionSignal,
                executionQueueSession,
                fullPageSession,
                undefined,
                requestContext,
            );
        return translatedIndexes.length === origins.length
            ? request
            : request.then((translations) => restoreSkippedSlots(origins, translatedIndexes, translations));
    };

    // 候选节点会因虚拟列表或前端框架重挂载而更换自己的 AbortSignal。
    // 将相同请求归属到全文会话后，旧候选取消只停止等待，不会终止新候选
    // 正在复用的 provider 请求；会话结束仍会统一中止底层工作。
    if (fullPageSession?.active && fullPageSession.requestSignal) {
        const aiOwnerIdentity = isAICrossCandidateRequest ? getAIBatchOwnerIdentity(batchOwner) : undefined;
        const key = createRequestCacheKey(origins, snapshot, fullPageSession.pageContextGeneration ?? 0, aiOwnerIdentity);
        const failureKey = createRequestCacheKey(origins, snapshot, -1, aiOwnerIdentity);
        const requestCache = fullPageSession.translationRequestCache ??= new Map();
        const failed = requestCache.get(failureKey);
        if (failed) {
            if (!forceFailedRequest) return waitForTranslationRequest(requestCache, failureKey, failed, signal);
            retireTranslationRequest(requestCache, failureKey, failed);
        }
        const cached = requestCache.get(key);
        if (cached) return waitForTranslationRequest(requestCache, key, cached, signal);
        // 每个底层请求保留独立 queue session，避免某次逐槽降级失败时取消
        // 全文会话里其他无关请求；AbortSignal 仍由会话统一持有和结束。
        const requestQueueSession = createTranslationQueueSession();
        fullPageSession.requestQueueSessions?.add(requestQueueSession);
        const requestController = new AbortController();
        fullPageSession.requestControllers?.add(requestController);
        if (fullPageSession.requestSignal.aborted) requestController.abort();
        const result = execute(requestController.signal, requestQueueSession);
        const releaseQueueSession = () => {
            fullPageSession.requestControllers?.delete(requestController);
            fullPageSession.requestQueueSessions?.delete(requestQueueSession);
        };
        void result.then(releaseQueueSession, releaseQueueSession);
        const entry = rememberTranslationRequest(
            fullPageSession,
            key,
            failureKey,
            result,
            origins.length,
            requestController,
            requestQueueSession,
            fullPageSession.retainSettledResults !== false,
            !isAICrossCandidateRequest,
        );
        return waitForTranslationRequest(requestCache, key, entry, signal);
    }

    return execute(signal, queueSession);
}
