/**
 * @file src/features/full-page-translation/content/fullPageQueue.ts
 * 文件职责：维护全文翻译 pending 候选的排队元数据，并选择当前最适合启动的候选。
 * 主要内容：保留同源候选的等待时间与稳定序号，显式失败重试去重入队并保留强制刷新意图，按 drain 批次集中读取锚点布局，以线性建堆代替全量排序；共享锚点仅复用本次同步收集的成功有限读数，失败仍可重测、下一计划读取新布局；滚动期间仅派发可见候选，空闲时保持方向预取和后台公平配额。
 * 模块边界：本文件不发现候选、不修改 DOM、不调用 provider；runtime 负责生命周期与资格判断，fullPagePriority 负责纯排序规则。
 */

import {getTranslationCandidateKey, type TranslationCandidate} from '@/src/core/translation/public';
import {
    compareFullPageCandidatePriority,
    FULL_PAGE_BACKGROUND_MAX_WAIT_MS,
    FULL_PAGE_FOREGROUND_DISPATCH_QUOTA,
    FULL_PAGE_PREFETCH_MARGIN_PX,
    scoreFullPageCandidatePriority,
    type FullPageCandidatePriority,
    type FullPageScrollDirection,
} from './fullPagePriority';

export interface FullPagePendingMetadata {
    source: string;
    queuedAt: number;
    sequence: number;
    forceFailedRequest?: boolean;
    retryIsCurrent?: () => boolean;
}

export interface FullPageQueueState {
    pending: Map<Node, TranslationCandidate>;
    pendingMetadata: Map<Node, FullPagePendingMetadata>;
    inFlightCandidates: Map<Node, TranslationCandidate>;
    candidateAnchors: Map<Node, HTMLElement>;
    nextPendingSequence: number;
    foregroundDispatchesSinceBackground: number;
    scrollDirection: FullPageScrollDirection;
    lastScrollPosition: number | undefined;
}

export type FullPageQueueStorage = Omit<FullPageQueueState, 'inFlightCandidates'>;

export interface FullPageQueueSelectionOptions {
    now: number;
    viewportHeight: number;
    /** 滚动中的阅读派发不预取，也不消耗后台公平配额。 */
    visibleOnly?: boolean;
    isEligible: (candidate: TranslationCandidate) => boolean;
    resolveSource: (candidate: TranslationCandidate) => string;
}

export interface FullPagePendingSelection {
    key: Node;
    candidate: TranslationCandidate;
    priority: FullPageCandidatePriority;
}

export interface FullPageDispatchPlan {
    /** 取出下一个应启动的候选；同一计划内不再重新测量布局。 */
    next(): FullPagePendingSelection | undefined;
}

function readScrollPosition(): number | undefined {
    if (typeof window === 'undefined') return undefined;
    const value = window.scrollY ?? window.pageYOffset;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createFullPageQueueState(): FullPageQueueStorage {
    return {
        pending: new Map(),
        pendingMetadata: new Map(),
        candidateAnchors: new Map(),
        nextPendingSequence: 0,
        foregroundDispatchesSinceBackground: 0,
        scrollDirection: 'unknown',
        lastScrollPosition: readScrollPosition(),
    };
}

export function clearFullPageQueueState(state: FullPageQueueState): void {
    state.pending.clear();
    state.pendingMetadata.clear();
    state.candidateAnchors.clear();
}

export function noteFullPageScroll(
    state: FullPageQueueState,
    isActive: () => boolean,
    onScroll: () => void,
): void {
    if (!isActive()) return;
    const nextPosition = readScrollPosition();
    if (nextPosition !== undefined && state.lastScrollPosition !== undefined) {
        if (nextPosition > state.lastScrollPosition) state.scrollDirection = 'forward';
        else if (nextPosition < state.lastScrollPosition) state.scrollDirection = 'backward';
    }
    if (nextPosition !== undefined) state.lastScrollPosition = nextPosition;
    onScroll();
}

export function queueFullPageCandidate(
    state: FullPageQueueState,
    key: Node,
    candidate: TranslationCandidate,
    source: string,
    queuedAt = Date.now(),
    forceFailedRequest = false,
): void {
    const previous = state.pendingMetadata.get(key);
    if (!previous || previous.source !== source) {
        state.pendingMetadata.set(key, {
            source,
            queuedAt,
            sequence: ++state.nextPendingSequence,
        });
    }
    if (forceFailedRequest) state.pendingMetadata.get(key)!.forceFailedRequest = true;
    state.pending.set(key, candidate);
}

interface FullPageFailureQueueState extends FullPageQueueState {
    active: boolean;
    scheduled: Map<Node, TranslationCandidate>;
    candidateOwnerKeys: Map<HTMLElement, Set<Node>>;
}

/** 失败重试只登记意图；原文恢复、重新解析和请求都延后到既有受限 drain。 */
export function queueFullPageFailedCandidate(state: FullPageFailureQueueState, candidate: TranslationCandidate,
    source: string, queued: () => void, retryIsCurrent: () => boolean): boolean {
    const key = getTranslationCandidateKey(candidate);
    if (!state.active || state.pending.has(key) || state.inFlightCandidates.has(key)) return false;
    state.scheduled.set(key, candidate);
    let keys = state.candidateOwnerKeys.get(candidate.element);
    if (!keys) {
        keys = new Set();
        state.candidateOwnerKeys.set(candidate.element, keys);
    }
    keys.add(key);
    queueFullPageCandidate(state, key, candidate, source, Date.now(), true);
    state.pendingMetadata.get(key)!.retryIsCurrent = retryIsCurrent;
    queued();
    return true;
}

export function removeFullPagePending(
    state: FullPageQueueState,
    key: Node,
    candidate?: TranslationCandidate,
): boolean {
    if (candidate && state.pending.get(key) !== candidate) return false;
    const removed = state.pending.delete(key);
    if (removed) state.pendingMetadata.delete(key);
    return removed;
}

function getCandidateRect(
    state: FullPageQueueState,
    key: Node,
    candidate: TranslationCandidate,
    rects: Map<HTMLElement, {top: number; bottom: number}>,
): {top: number; bottom: number} | undefined {
    const anchor = state.candidateAnchors.get(key) ?? candidate.element;
    if (!anchor.isConnected || typeof anchor.getBoundingClientRect !== 'function') return undefined;
    if (rects.has(anchor)) return rects.get(anchor);
    try {
        const rect = anchor.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return undefined;
        const measured = {top: rect.top, bottom: rect.bottom};
        rects.set(anchor, measured);
        return measured;
    } catch {
        return undefined;
    }
}

function getCandidatePriority(
    state: FullPageQueueState,
    key: Node,
    candidate: TranslationCandidate,
    options: FullPageQueueSelectionOptions,
    rects: Map<HTMLElement, {top: number; bottom: number}>,
): FullPageCandidatePriority {
    let metadata = state.pendingMetadata.get(key);
    if (!metadata) {
        metadata = {
            source: options.resolveSource(candidate),
            queuedAt: options.now,
            sequence: ++state.nextPendingSequence,
        };
        state.pendingMetadata.set(key, metadata);
    }
    return scoreFullPageCandidatePriority({
        rect: getCandidateRect(state, key, candidate, rects),
        viewportTop: 0,
        viewportBottom: Math.max(0, Number.isFinite(options.viewportHeight) ? options.viewportHeight : 0),
        prefetchMargin: FULL_PAGE_PREFETCH_MARGIN_PX,
        direction: state.scrollDirection,
        queuedAt: metadata.queuedAt,
        now: options.now,
        sequence: metadata.sequence,
    });
}

function collectPrioritizedCandidates(
    state: FullPageQueueState,
    options: FullPageQueueSelectionOptions,
): FullPagePendingSelection[] {
    const candidates: FullPagePendingSelection[] = [];
    // 仅在本次只读收集复用成功几何；不把异常/非有限值或 Map 留到 plan.next 与下一轮。
    const rects = new Map<HTMLElement, {top: number; bottom: number}>();
    for (const [key, candidate] of state.pending) {
        if (state.inFlightCandidates.has(key) || !options.isEligible(candidate)) continue;
        const priority = getCandidatePriority(state, key, candidate, options, rects);
        if (!options.visibleOnly || priority.band === 'visible') candidates.push({key, candidate, priority});
    }
    return candidates;
}

/** 候选只在取用时出堆；序号完全相同时沿用本轮收集顺序，保持原稳定排序契约。 */
function createPendingHeap(candidates: readonly FullPagePendingSelection[], heap: number[],
    stillQueued: (entry: FullPagePendingSelection) => boolean): () => FullPagePendingSelection | undefined {
    const compare = (left: number, right: number) =>
        compareFullPageCandidatePriority(candidates[left]!.priority, candidates[right]!.priority) || left - right;
    const siftDown = (start: number) => {
        const entry = heap[start]!;
        let cursor = start;
        while (cursor * 2 + 1 < heap.length) {
            let child = cursor * 2 + 1;
            if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) < 0) child += 1;
            if (compare(entry, heap[child]!) <= 0) break;
            heap[cursor] = heap[child]!;
            cursor = child;
        }
        heap[cursor] = entry;
    };
    for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) siftDown(index);
    return () => {
        while (heap.length > 0) {
            const entry = candidates[heap[0]!]!;
            if (stillQueued(entry)) return entry;
            const last = heap.pop()!;
            if (heap.length > 0) {heap[0] = last; siftDown(0);}
        }
        return undefined;
    };
}

/**
 * 创建一次派发计划。drain 写入 loading 前仍在同一只读批次测量全部锚点；
 * 线性建堆只排列当前最优项，避免仅有少量空闲槽时同步排序整篇文档。
 * 后续 next() 只释放已失效的堆顶，不再读取布局，保持后台公平与即时资格复验。
 */
export function createFullPageDispatchPlan(
    state: FullPageQueueState,
    options: FullPageQueueSelectionOptions,
): FullPageDispatchPlan {
    const candidates = collectPrioritizedCandidates(state, options);
    const ordered = candidates.map((_entry, index) => index);

    const stillQueued = (entry: FullPagePendingSelection): boolean =>
        state.pending.get(entry.key) === entry.candidate && !state.inFlightCandidates.has(entry.key) &&
        options.isEligible(entry.candidate);
    const next = createPendingHeap(candidates, ordered, stillQueued);
    let nextAged: ReturnType<typeof createPendingHeap> | undefined;

    return {
        next(): FullPagePendingSelection | undefined {
            const entry = next();
            if (!entry) return undefined;
            // 长时间等待的离屏任务不能被当前视口永久淹没；配额未用满时仍优先前景。
            if (state.foregroundDispatchesSinceBackground >= FULL_PAGE_FOREGROUND_DISPATCH_QUOTA) {
                // 少量空闲槽通常只启动前景；只有真正轮到公平配额时才整理超龄后台项。
                if (!nextAged) {
                    const agedBackground: number[] = [];
                    candidates.forEach(({priority}, index) => {
                        if (priority.band === 'background' && priority.ageMs >= FULL_PAGE_BACKGROUND_MAX_WAIT_MS) agedBackground.push(index);
                    });
                    nextAged = createPendingHeap(candidates, agedBackground, stillQueued);
                }
                const aged = nextAged();
                // 顺向但尚未超时的后台项不能抢走超时项的公平配额。
                if (aged) return aged;
            }
            return entry;
        },
    };
}
