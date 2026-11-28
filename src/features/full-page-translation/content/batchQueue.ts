/**
 * @file src/features/full-page-translation/content/batchQueue.ts
 * 文件职责：管理全文翻译的跨候选原生数组与 AI 多段合批队列、DOM 相邻排序、协议熔断与逐槽独立降级回退。
 * 主要内容：按会话维护原生微任务合批与 AI 定时收集窗口队列，约束段数/字符上限与相邻节点归属，确保部分取消不影响同批活跃任务并在协议异常后自动熔断回退。
 * 模块边界：仅编排跨候选合批调度与结果分发，单候选执行委托 slotExecution，快照与缓存管理委托 requestCache。
 */
import {discourseScope, mergeDiscourseContexts} from '@/src/services/translation/context/discourse';
import {normalizeAiMultiSegmentMaxCharacters, normalizeAiMultiSegmentMaxSegments} from '@/src/core/config/aiMultiSegment';
import {translateTextBatch} from '@/src/services/translation/client';
import {supportsNativeTranslationBatch} from '@/src/services/translation/capabilities';
import {validateNativeBatchResults} from '@/src/core/translation/nativeBatch';
import {hasTranslationContent} from '@/src/core/translation/result';
import {
    cancelTranslationQueueSession,
    createTranslationQueueSession,
    type TranslationQueueSession,
} from '@/src/services/translation/queue';
import type {FullPageTranslationConfigSnapshot} from './translationConfigSnapshot';
import {
    createAbortError,
    createSnapshotTranslateOptions,
    getAIMultiSegmentLimits,
    isAbortError,
    throwIfAborted,
    type FullPageTranslationSessionCache,
} from './requestCache';
import {translateSlotsIndividually, translateTextSlotsDirectly} from './slotExecution';

const NATIVE_BATCH_MAX_TEXT_SLOTS = 4;
const NATIVE_BATCH_MAX_CHARACTERS = 2_000;
const AI_BATCH_COLLECTION_MS = 32;

interface TranslationBatchTask {
    batchKey: string;
    aiCircuitKey: string;
    context: string;
    discourseContext?: string;
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
    flushTimer?: ReturnType<typeof setTimeout>;
    disabledAIKeys: Set<string>;
}

const translationBatchQueues = new WeakMap<FullPageTranslationSessionCache, TranslationBatchQueue>();
const nativeTranslationBatchQueues = new WeakMap<FullPageTranslationSessionCache, TranslationBatchQueue>();
const aiBatchOwnerIds = new WeakMap<Element, number>();
let nextAIBatchOwnerId = 0;

export function getAIBatchOwnerIdentity(owner?: Element): number | undefined {
    if (!owner) return undefined;
    let id = aiBatchOwnerIds.get(owner);
    if (id === undefined) {
        id = ++nextAIBatchOwnerId;
        aiBatchOwnerIds.set(owner, id);
    }
    return id;
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
        compositeConnectionFingerprint: snapshot.compositeConnectionFingerprint,
        model: snapshot.model,
        thinking: snapshot.thinking,
        from: snapshot.sourceLanguage,
        to: snapshot.targetLanguage,
        excludedLanguages: snapshot.excludedLanguages,
        useCache: snapshot.useCache,
        enableAIContext: snapshot.enableAIContext,
        aiMultiSegmentLimits: getAIMultiSegmentLimits(snapshot),
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
        const nativeBatch = supportsNativeTranslationBatch(next.snapshot.service);
        const maxTextSlots = nativeBatch ? NATIVE_BATCH_MAX_TEXT_SLOTS
            : normalizeAiMultiSegmentMaxSegments(next.snapshot.aiMultiSegmentMaxSegments);
        const maxCharacters = nativeBatch ? NATIVE_BATCH_MAX_CHARACTERS
            : normalizeAiMultiSegmentMaxCharacters(next.snapshot.aiMultiSegmentMaxCharacters);
        if (batch.length > 0 && (
            textSlots + nextTextSlots > maxTextSlots
            || characters + nextCharacters > maxCharacters
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
    // 逐槽请求相互独立，保留每个候选自己的取消与结果交付时序。
    await Promise.all(activeTasks.map(async task => {
        try {
            const translations = await translateSlotsIndividually(
                task.origins, task.snapshot, task.signal, task.queueSession, task.context, task.discourseContext,
            );
            resolveTranslationBatchTask(task, translations);
        } catch (error) {
            rejectTranslationBatchTask(task, error);
        }
    }));
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
                task.discourseContext,
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
                discourseContext: mergeDiscourseContexts(activeTasks.map(task => task.discourseContext ?? '')) || undefined,
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

/** 异步预检可能乱序完成；同配置、章节与父节点内恢复阅读顺序后再检查直接相邻。 */
function orderAITranslationBatchTasks(tasks: readonly TranslationBatchTask[]): TranslationBatchTask[] {
    const scopes = new Map<string, Map<Node | undefined, TranslationBatchTask[]>>();
    for (const task of tasks) {
        if (task.settled || task.signal?.aborted) continue;
        let parents = scopes.get(task.batchKey);
        if (!parents) scopes.set(task.batchKey, parents = new Map());
        const parent = task.owner?.parentNode ?? task.owner;
        let siblings = parents.get(parent);
        if (!siblings) parents.set(parent, siblings = []);
        siblings.push(task);
    }
    return [...scopes.values()].flatMap(parents => [...parents.values()].flatMap(siblings => {
        // 无 DOM owner 的显式调用保持提交顺序；同父元素的比较关系始终可传递。
        if (siblings[0]!.owner) siblings.sort((left, right) => {
            const position = left.owner!.compareDocumentPosition(right.owner!);
            return position & 4 ? -1 : position & 2 ? 1 : 0;
        });
        return siblings;
    }));
}

function flushTranslationBatchQueue(queue: TranslationBatchQueue, native: boolean): void {
    queue.flushScheduled = false;
    queue.flushTimer = undefined;
    if (!native) queue.pending = orderAITranslationBatchTasks(queue.pending);
    while (queue.pending.length > 0) {
        const batch = takeTranslationBatch(queue);
        if (batch.length === 0) continue;
        void executeTranslationBatch(batch, queue);
    }
}

export function enqueueTranslationBatchTask(
    origins: readonly string[],
    snapshot: FullPageTranslationConfigSnapshot,
    signal: AbortSignal | undefined,
    queueSession: TranslationQueueSession | undefined,
    session: FullPageTranslationSessionCache,
    owner?: Element,
    discourseContext?: string,
): Promise<string[]> {
    throwIfAborted(signal);
    const native = supportsNativeTranslationBatch(snapshot.service);
    const queues = native ? nativeTranslationBatchQueues : translationBatchQueues;
    let queue = queues.get(session);
    if (!queue) {
        queue = {pending: [], flushScheduled: false, disabledAIKeys: new Set()};
        queues.set(session, queue);
    }

    // 同配置的协议已熔断时无需再凑批；逐槽请求仍使用本次快照与取消作用域。
    if (!native && queue.disabledAIKeys.has(createAIBatchCircuitKey(snapshot))) {
        return translateSlotsIndividually(origins, snapshot, signal, queueSession, document.title, discourseContext);
    }

    return new Promise<string[]>((resolve, reject) => {
        const task: TranslationBatchTask = {
            batchKey: JSON.stringify([createBatchScopeKey(snapshot, session), discourseScope(discourseContext)]),
            aiCircuitKey: createAIBatchCircuitKey(snapshot),
            context: document.title,
            discourseContext,
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
            if (queue!.flushTimer !== undefined && queue!.pending.every(pending => pending.settled)) {
                clearTimeout(queue!.flushTimer);
                queue!.flushTimer = undefined;
                queue!.flushScheduled = false;
                queue!.pending = [];
            }
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, {once: true});
            task.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        queue!.pending.push(task);
        if (!queue!.flushScheduled) {
            queue!.flushScheduled = true;
            if (native) {
                const schedule = globalThis.queueMicrotask
                    ?? ((callback: VoidFunction) => void Promise.resolve().then(callback));
                schedule(() => flushTranslationBatchQueue(queue!, true));
            } else {
                // 富文本校订查询、语言预检及全文 8ms 分片会跨微任务/浏览器任务完成。
                // 从首个候选开始固定计时，后续入队不续期，孤立段落也能及时发出。
                queue!.flushTimer = setTimeout(() => flushTranslationBatchQueue(queue!, false), AI_BATCH_COLLECTION_MS);
            }
        }
    });
}
