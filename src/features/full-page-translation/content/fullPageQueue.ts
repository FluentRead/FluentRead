/**
 * @file src/features/full-page-translation/content/fullPageQueue.ts
 * 文件职责：维护全文翻译 pending 候选的排队元数据，并选择当前最适合启动的候选。
 * 主要内容：保留同源候选的等待时间与稳定序号，显式失败重试去重入队并保留强制刷新意图，按 drain 批次一次性读取候选锚点布局并排序，执行视口优先、方向预取和后台公平配额。
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
): {top: number; bottom: number} | undefined {
    const anchor = state.candidateAnchors.get(key) ?? candidate.element;
    if (!anchor.isConnected || typeof anchor.getBoundingClientRect !== 'function') return undefined;
    try {
        const rect = anchor.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return undefined;
        return {top: rect.top, bottom: rect.bottom};
    } catch {
        return undefined;
    }
}

function getCandidatePriority(
    state: FullPageQueueState,
    key: Node,
    candidate: TranslationCandidate,
    options: FullPageQueueSelectionOptions,
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
        rect: getCandidateRect(state, key, candidate),
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
    for (const [key, candidate] of state.pending) {
        if (state.inFlightCandidates.has(key) || !options.isEligible(candidate)) continue;
        candidates.push({key, candidate, priority: getCandidatePriority(state, key, candidate, options)});
    }
    return candidates;
}

/**
 * 创建一次派发计划。drain 循环每启动一个候选都会插入 spinner/wrapper 并使布局失效，
 * 因此逐次重新挑选会让每个 pick 触发一次整篇文档的强制重排；这里把全部锚点测量
 * 集中在一个只读批次里完成并排序，之后的 next() 只做 O(1) 的有效性推进。
 */
export function createFullPageDispatchPlan(
    state: FullPageQueueState,
    options: FullPageQueueSelectionOptions,
): FullPageDispatchPlan {
    const ordered = collectPrioritizedCandidates(state, options)
        .sort((left, right) => compareFullPageCandidatePriority(left.priority, right.priority));
    const agedBackground = ordered.filter(({priority}) =>
        priority.band === 'background' && priority.ageMs >= FULL_PAGE_BACKGROUND_MAX_WAIT_MS);
    let cursor = 0;
    let agedCursor = 0;

    const stillQueued = (entry: FullPagePendingSelection): boolean =>
        state.pending.get(entry.key) === entry.candidate && !state.inFlightCandidates.has(entry.key) &&
        options.isEligible(entry.candidate);
    const advance = (list: readonly FullPagePendingSelection[], from: number): number => {
        let index = from;
        while (index < list.length && !stillQueued(list[index]!)) index += 1;
        return index;
    };

    return {
        next(): FullPagePendingSelection | undefined {
            cursor = advance(ordered, cursor);
            if (cursor >= ordered.length) return undefined;
            agedCursor = advance(agedBackground, agedCursor);
            // 长时间等待的离屏任务不能被当前视口永久淹没；配额未用满时仍优先前景。
            if (agedCursor < agedBackground.length &&
                state.foregroundDispatchesSinceBackground >= FULL_PAGE_FOREGROUND_DISPATCH_QUOTA) {
                // 顺向但尚未超时的后台项不能抢走超时项的公平配额。
                return agedBackground[agedCursor];
            }
            return ordered[cursor];
        },
    };
}
