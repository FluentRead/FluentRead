import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    compareFullPageCandidatePriority,
    scoreFullPageCandidatePriority,
} from '@/src/features/full-page-translation/content/fullPagePriority';
import {
    clearFullPageQueueState,
    createFullPageQueueState,
    noteFullPageScroll,
    queueFullPageCandidate,
    queueFullPageFailedCandidate,
    createFullPageDispatchPlan,
    removeFullPagePending,
    type FullPageQueueState,
} from '@/src/features/full-page-translation/content/fullPageQueue';
import type {TranslationCandidate} from '@/src/core/translation/public';

function priority(overrides: Partial<Parameters<typeof scoreFullPageCandidatePriority>[0]> = {}) {
    return scoreFullPageCandidatePriority({
        viewportTop: 0,
        viewportBottom: 600,
        prefetchMargin: 600,
        direction: 'unknown',
        queuedAt: 0,
        now: 1_000,
        sequence: 0,
        ...overrides,
    });
}

describe('全文翻译候选优先级', () => {
    it('当前可见候选优先于视口附近和离屏候选', () => {
        const visible = priority({rect: {top: 80, bottom: 160}, sequence: 3});
        const near = priority({rect: {top: 720, bottom: 800}, sequence: 1});
        const background = priority({rect: {top: 2_000, bottom: 2_080}, sequence: 0});

        expect(compareFullPageCandidatePriority(visible, near)).toBeLessThan(0);
        expect(compareFullPageCandidatePriority(near, background)).toBeLessThan(0);
    });

    it('同一视口内保持从上到下的阅读顺序，不因入队时间反转', () => {
        const top = priority({rect: {top: 40, bottom: 100}, queuedAt: 0, sequence: 9});
        const bottom = priority({rect: {top: 420, bottom: 480}, queuedAt: 900, sequence: 1});

        expect(compareFullPageCandidatePriority(top, bottom)).toBeLessThan(0);
    });

    it('按滚动方向优先预取前方内容', () => {
        const forward = priority({
            direction: 'forward',
            rect: {top: 760, bottom: 820},
            sequence: 5,
        });
        const behind = priority({
            direction: 'forward',
            rect: {top: -220, bottom: -160},
            sequence: 1,
        });
        const backward = priority({
            direction: 'backward',
            rect: {top: -220, bottom: -160},
            sequence: 5,
        });
        const backwardBehind = priority({
            direction: 'backward',
            rect: {top: 760, bottom: 820},
            sequence: 1,
        });

        expect(compareFullPageCandidatePriority(forward, behind)).toBeLessThan(0);
        expect(compareFullPageCandidatePriority(backward, backwardBehind)).toBeLessThan(0);
    });

    it('没有可读布局时仍按稳定序号保持确定性', () => {
        const first = priority({sequence: 2});
        const second = priority({sequence: 4});

        expect(first.band).toBe('background');
        expect(compareFullPageCandidatePriority(first, second)).toBeLessThan(0);
    });

    it('离屏任务按等待时间排序，支持后台公平推进', () => {
        const older = priority({rect: {top: 2_000, bottom: 2_080}, queuedAt: 0, sequence: 9});
        const newer = priority({rect: {top: 2_000, bottom: 2_080}, queuedAt: 900, sequence: 1});

        expect(compareFullPageCandidatePriority(older, newer)).toBeLessThan(0);
    });

    it('非有限输入回退到稳定的安全值，并覆盖方向优先比较的两侧', () => {
        const invalid = priority({
            viewportTop: Number.NaN,
            viewportBottom: Number.POSITIVE_INFINITY,
            prefetchMargin: Number.NaN,
            now: Number.NaN,
            queuedAt: Number.POSITIVE_INFINITY,
            sequence: Number.POSITIVE_INFINITY,
            rect: {top: Number.NaN, bottom: 20},
        });
        const forward = priority({direction: 'forward', rect: {top: 760, bottom: 820}, sequence: 3});
        const unknown = priority({direction: 'unknown', rect: {top: 760, bottom: 820}, sequence: 3});

        expect(invalid.band).toBe('background');
        expect(invalid.ageMs).toBe(0);
        expect(compareFullPageCandidatePriority(forward, unknown)).toBeLessThan(0);
        expect(compareFullPageCandidatePriority(unknown, forward)).toBeGreaterThan(0);
    });
});

function candidate(element: HTMLElement): TranslationCandidate {
    return {element, kind: 'content', reason: 'priority-test'};
}

function state(): FullPageQueueState {
    return {
        pending: new Map(),
        pendingMetadata: new Map(),
        inFlightCandidates: new Map(),
        candidateAnchors: new Map(),
        nextPendingSequence: 0,
        foregroundDispatchesSinceBackground: 0,
        scrollDirection: 'unknown',
        lastScrollPosition: undefined,
    };
}

function setRect(element: HTMLElement, top: number, bottom = top + 80): void {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top}),
    });
}

function withGlobalWindow<T>(value: unknown, callback: () => T): T {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    if (value === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', {configurable: true, value});
    try {
        return callback();
    } finally {
        if (previous) Object.defineProperty(globalThis, 'window', previous);
        else Reflect.deleteProperty(globalThis, 'window');
    }
}

describe('全文翻译候选队列', () => {
    it('显式失败重试只登记一次，保留强制刷新意图和 owner 索引，关闭会话不再入队', () => {
        const {document} = parseHTML('<html><body><p>Retry source</p></body></html>');
        const element = document.querySelector('p')!;
        const first = candidate(element);
        const queue = {...state(), active: true, scheduled: new Map<Node, TranslationCandidate>(), candidateOwnerKeys: new Map<HTMLElement, Set<Node>>()};
        const queued = vi.fn();
        const retryIsCurrent = () => true;
        expect(queueFullPageFailedCandidate(queue, first, 'Retry source', queued, retryIsCurrent)).toBe(true);
        expect(queueFullPageFailedCandidate(queue, first, 'Retry source', queued, retryIsCurrent)).toBe(false);
        expect(queued).toHaveBeenCalledOnce();
        expect(queue.pending.get(element)).toBe(first); expect(queue.scheduled.get(element)).toBe(first);
        expect(queue.candidateOwnerKeys.get(element)?.has(element)).toBe(true);
        expect(queue.pendingMetadata.get(element)?.forceFailedRequest).toBe(true);
        expect(queue.pendingMetadata.get(element)?.retryIsCurrent).toBe(retryIsCurrent);
        queueFullPageCandidate(queue, element, first, 'Retry source');
        expect(queue.pendingMetadata.get(element)?.forceFailedRequest).toBe(true);
        removeFullPagePending(queue, element, first);
        queue.inFlightCandidates.set(element, first);
        expect(queueFullPageFailedCandidate(queue, first, 'Retry source', queued, retryIsCurrent)).toBe(false);
        queue.inFlightCandidates.clear();
        expect(queueFullPageFailedCandidate(queue, first, 'Retry source', queued, retryIsCurrent)).toBe(true);
        expect(queue.candidateOwnerKeys.get(element)?.size).toBe(1);
        queueFullPageCandidate(queue, element, first, 'New source');
        expect(queue.pendingMetadata.get(element)?.forceFailedRequest).toBeUndefined();
        expect(queue.pendingMetadata.get(element)?.retryIsCurrent).toBeUndefined();
        removeFullPagePending(queue, element);
        queue.active = false;
        expect(queueFullPageFailedCandidate(queue, first, 'New source', queued, retryIsCurrent)).toBe(false);
        expect(queued).toHaveBeenCalledTimes(2);
    });
    it('创建、更新、移除和清理 pending 元数据时保留来源代次边界', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const element = document.createElement('p');
        const other = document.createElement('p');
        const first = candidate(element);
        const replacement = candidate(other);
        const queue = state();

        queueFullPageCandidate(queue, element, first, 'source-a', 10);
        queueFullPageCandidate(queue, element, first, 'source-a', 20);
        expect(queue.pendingMetadata.get(element)).toMatchObject({source: 'source-a', queuedAt: 10, sequence: 1});
        queueFullPageCandidate(queue, element, replacement, 'source-b', 30);
        expect(queue.pendingMetadata.get(element)).toMatchObject({source: 'source-b', queuedAt: 30, sequence: 2});

        expect(removeFullPagePending(queue, element, first)).toBe(false);
        expect(removeFullPagePending(queue, element, replacement)).toBe(true);
        expect(removeFullPagePending(queue, element)).toBe(false);

        queue.pending.set(element, replacement);
        queue.pendingMetadata.set(element, {source: 'source-b', queuedAt: 30, sequence: 2});
        queue.candidateAnchors.set(element, element);
        clearFullPageQueueState(queue);
        expect(queue.pending.size).toBe(0);
        expect(queue.pendingMetadata.size).toBe(0);
        expect(queue.candidateAnchors.size).toBe(0);
    });

    it('记录前后滚动方向、无窗口和非活动会话时保持安全回退', () => {
        const queue = state();
        const onScroll = () => undefined;

        withGlobalWindow(undefined, () => {
            const created = createFullPageQueueState();
            expect(created.lastScrollPosition).toBeUndefined();
            noteFullPageScroll(queue, () => true, onScroll);
        });

        withGlobalWindow({scrollY: undefined, pageYOffset: 100}, () => {
            queue.lastScrollPosition = 50;
            noteFullPageScroll(queue, () => true, onScroll);
            expect(queue.lastScrollPosition).toBe(100);
            expect(queue.scrollDirection).toBe('forward');
            noteFullPageScroll(queue, () => true, onScroll);
            expect(queue.scrollDirection).toBe('forward');
        });

        withGlobalWindow({scrollY: 20, pageYOffset: 20}, () => {
            noteFullPageScroll(queue, () => true, onScroll);
            expect(queue.scrollDirection).toBe('backward');
            noteFullPageScroll(queue, () => false, () => { throw new Error('inactive scroll callback'); });
        });
        withGlobalWindow({scrollY: NaN}, () => {
            expect(createFullPageQueueState().lastScrollPosition).toBeUndefined();
            noteFullPageScroll(queue, () => true, onScroll);
            expect(queue.lastScrollPosition).toBe(20);
        });
    });

    it('跳过不合格或已在途候选，并能处理缺失、无效和异常布局 rect', () => {
        const {document} = parseHTML('<html><body><p id="valid"></p><p id="broken"></p><p id="invalid"></p><p id="throwing"></p></body></html>');
        const valid = document.querySelector<HTMLElement>('#valid')!;
        const broken = document.querySelector<HTMLElement>('#broken')!;
        const invalid = document.querySelector<HTMLElement>('#invalid')!;
        const throwing = document.querySelector<HTMLElement>('#throwing')!;
        setRect(valid, 100);
        Object.defineProperty(broken, 'getBoundingClientRect', {configurable: true, value: undefined});
        Object.defineProperty(invalid, 'getBoundingClientRect', {configurable: true, value: () => ({top: Number.NaN, bottom: 10})});
        Object.defineProperty(throwing, 'getBoundingClientRect', {configurable: true, value: () => { throw new Error('layout'); }});
        const queue = state();
        const validCandidate = candidate(valid);
        const brokenCandidate = candidate(broken);
        const invalidCandidate = candidate(invalid);
        const throwingCandidate = candidate(throwing);
        queue.pending.set(valid, validCandidate);
        queue.pending.set(broken, brokenCandidate);
        queue.pending.set(invalid, invalidCandidate);
        queue.pending.set(throwing, throwingCandidate);
        queue.inFlightCandidates.set(valid, validCandidate);

        expect(createFullPageDispatchPlan(queue, {
            now: 1_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'resolved-source',
        }).next()).toMatchObject({candidate: brokenCandidate});

        const disconnected = document.createElement('p');
        const disconnectedCandidate = candidate(disconnected);
        queue.pending.clear();
        queue.pending.set(disconnected, disconnectedCandidate);
        expect(createFullPageDispatchPlan(queue, {
            now: 1_000,
            viewportHeight: NaN,
            isEligible: () => true,
            resolveSource: () => 'disconnected-source',
        }).next()).toMatchObject({candidate: disconnectedCandidate});
    });

    it('缺失元数据时补建序号，并在后台任务达到等待阈值后执行公平配额', () => {
        const {document} = parseHTML('<html><body><p id="visible"></p><p id="background"></p></body></html>');
        const visible = document.querySelector<HTMLElement>('#visible')!;
        const background = document.querySelector<HTMLElement>('#background')!;
        setRect(visible, 100);
        setRect(background, 2_000, 2_080);
        const visibleCandidate = candidate(visible);
        const backgroundCandidate = candidate(background);
        const queue = state();
        queue.pending.set(visible, visibleCandidate);
        expect(createFullPageDispatchPlan(queue, {
            now: 1_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'visible-source',
        }).next()).toMatchObject({candidate: visibleCandidate});

        queue.pending.clear();
        queue.pendingMetadata.clear();
        queue.pending.set(visible, visibleCandidate);
        queue.pending.set(background, backgroundCandidate);
        queue.pendingMetadata.set(background, {source: 'background-source', queuedAt: 0, sequence: 1});
        queue.pendingMetadata.set(visible, {source: 'visible-source', queuedAt: 900, sequence: 2});
        queue.foregroundDispatchesSinceBackground = 8;
        expect(createFullPageDispatchPlan(queue, {
            now: 9_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'fallback-source',
        }).next()).toMatchObject({candidate: backgroundCandidate});

        queue.pending.clear();
        expect(createFullPageDispatchPlan(queue, {
            now: 9_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'empty-source',
        }).next()).toBeUndefined();
    });
    it('派发计划只测量一次布局，按序取出候选并跳过已离队的条目', () => {
        const {document} = parseHTML('<html><body><p id="a"></p><p id="b"></p><p id="c"></p></body></html>');
        const first = document.querySelector<HTMLElement>('#a')!;
        const second = document.querySelector<HTMLElement>('#b')!;
        const third = document.querySelector<HTMLElement>('#c')!;
        const measured: HTMLElement[] = [];
        const measure = (element: HTMLElement, top: number) => {
            Object.defineProperty(element, 'getBoundingClientRect', {
                configurable: true,
                value: () => {
                    measured.push(element);
                    return {top, bottom: top + 40};
                },
            });
        };
        measure(first, 40);
        measure(second, 200);
        measure(third, 360);

        const queue = state();
        const candidates = [first, second, third].map((element) => candidate(element));
        [first, second, third].forEach((element, index) => {
            queueFullPageCandidate(queue, element, candidates[index]!, `source-${index}`, 0);
        });

        const plan = createFullPageDispatchPlan(queue, {
            now: 1_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'unused',
        });
        // 三个候选各测量一次；drain 循环中的后续取出不再触发布局读取。
        expect(measured).toHaveLength(3);

        const firstPick = plan.next();
        expect(firstPick).toMatchObject({candidate: candidates[0]});
        removeFullPagePending(queue, firstPick!.key, firstPick!.candidate);
        queue.inFlightCandidates.set(firstPick!.key, firstPick!.candidate);

        // 计划外的退队（宿主移除、用户取消）不会让后续取出返回失效条目。
        removeFullPagePending(queue, second, candidates[1]!);

        expect(plan.next()).toMatchObject({candidate: candidates[2]});
        expect(measured).toHaveLength(3);

        removeFullPagePending(queue, third, candidates[2]!);
        expect(plan.next()).toBeUndefined();
    });

    it('派发前复验资格和候选身份，取消过期后台项后不让新后台项抢占前景', () => {
        const {document} = parseHTML('<html><body><p id="visible"></p><p id="old"></p><p id="new"></p></body></html>');
        const elements = [...document.querySelectorAll<HTMLElement>('p')];
        elements.forEach((element, index) => setRect(element, index ? 2_000 + index * 100 : 100));
        const candidates = elements.map(element => candidate(element));
        const queue = state();
        elements.forEach((element, index) => queueFullPageCandidate(queue, element, candidates[index]!, `s-${index}`, index === 1 ? 0 : 8_999));
        queue.foregroundDispatchesSinceBackground = 8;
        let eligible = true;
        const plan = createFullPageDispatchPlan(queue, {
            now: 9_000, viewportHeight: 600, isEligible: () => eligible, resolveSource: () => 'source',
        });
        removeFullPagePending(queue, elements[1]!, candidates[1]!);
        expect(plan.next()?.candidate).toBe(candidates[0]);
        // 同 key 换成新的候选后，旧计划不得派发旧对象。
        queue.pending.set(elements[0]!, candidate(elements[0]!));
        expect(plan.next()?.candidate).toBe(candidates[2]);
        eligible = false;
        expect(plan.next()).toBeUndefined();
    });

    it.each(['forward', 'backward'] as const)('公平配额补偿超时后台候选，不被年轻的顺向后台候选抢占（%s）', (direction) => {
        const {document} = parseHTML('<html><body><p id="visible"></p><p id="aged"></p><p id="young"></p></body></html>');
        const [visible, aged, young] = [...document.querySelectorAll<HTMLElement>('p')];
        setRect(visible!, 100);
        setRect(aged!, direction === 'forward' ? -3_000 : 3_000);
        setRect(young!, direction === 'forward' ? 2_000 : -2_000);
        const queue = state();
        queue.scrollDirection = direction;
        const visibleCandidate = candidate(visible!);
        const agedCandidate = candidate(aged!);
        const youngCandidate = candidate(young!);
        queueFullPageCandidate(queue, visible!, visibleCandidate, 'visible', 8_999);
        queueFullPageCandidate(queue, aged!, agedCandidate, 'aged', 0);
        queueFullPageCandidate(queue, young!, youngCandidate, 'young', 8_999);
        queue.foregroundDispatchesSinceBackground = 8;
        const plan = createFullPageDispatchPlan(queue, {
            now: 9_000, viewportHeight: 600, isEligible: () => true, resolveSource: () => 'unused',
        });
        expect(plan.next()?.candidate).toBe(agedCandidate);
        removeFullPagePending(queue, aged!, agedCandidate);
        queue.foregroundDispatchesSinceBackground = 0;
        expect(plan.next()?.candidate).toBe(visibleCandidate);
    });

    it.each(['remove', 'invalid', 'inflight'] as const)('超时后台候选在计划创建后失效时跳过，并继续补偿或回到前景（%s）', (invalidation) => {
        const {document} = parseHTML('<html><body><p id="visible"></p><p id="stale"></p><p id="aged"></p></body></html>');
        const [visible, stale, aged] = [...document.querySelectorAll<HTMLElement>('p')];
        setRect(visible!, 100);
        setRect(stale!, 2_000);
        setRect(aged!, 3_000);
        const queue = state();
        const visibleCandidate = candidate(visible!);
        const staleCandidate = candidate(stale!);
        const agedCandidate = candidate(aged!);
        queueFullPageCandidate(queue, visible!, visibleCandidate, 'visible', 8_999);
        queueFullPageCandidate(queue, stale!, staleCandidate, 'stale', 0);
        queueFullPageCandidate(queue, aged!, agedCandidate, 'aged', 1);
        queue.foregroundDispatchesSinceBackground = 8;
        let staleEligible = true;
        const plan = createFullPageDispatchPlan(queue, {
            now: 9_000, viewportHeight: 600,
            isEligible: (item) => item !== staleCandidate || staleEligible,
            resolveSource: () => 'unused',
        });
        if (invalidation === 'remove') removeFullPagePending(queue, stale!, staleCandidate);
        else if (invalidation === 'invalid') staleEligible = false;
        else queue.inFlightCandidates.set(stale!, staleCandidate);
        expect(plan.next()?.candidate).toBe(agedCandidate);
        removeFullPagePending(queue, aged!, agedCandidate);
        // 保持配额已用满：超时项全部失效时也必须回到仍有效的前景。
        expect(plan.next()?.candidate).toBe(visibleCandidate);
        removeFullPagePending(queue, visible!, visibleCandidate);
        expect(plan.next()).toBeUndefined();
    });

    it('后台候选耗尽时退回最佳前景候选，不让 drain 空转', () => {
        const {document} = parseHTML('<html><body><p id="visible"></p><p id="stale"></p></body></html>');
        const visible = document.querySelector<HTMLElement>('#visible')!;
        const stale = document.querySelector<HTMLElement>('#stale')!;
        setRect(visible, 100);
        setRect(stale, 2_000, 2_080);
        const visibleCandidate = candidate(visible);
        const staleCandidate = candidate(stale);
        const queue = state();
        queue.pending.set(visible, visibleCandidate);
        queue.pending.set(stale, staleCandidate);
        queue.pendingMetadata.set(stale, {source: 'stale', queuedAt: 0, sequence: 1});
        queue.pendingMetadata.set(visible, {source: 'visible', queuedAt: 0, sequence: 2});
        queue.foregroundDispatchesSinceBackground = 8;

        const plan = createFullPageDispatchPlan(queue, {
            now: 9_000,
            viewportHeight: 600,
            isEligible: () => true,
            resolveSource: () => 'unused',
        });
        // 配额用满时先补上等待过久的后台候选。
        expect(plan.next()).toMatchObject({candidate: staleCandidate});
        removeFullPagePending(queue, stale, staleCandidate);
        queue.inFlightCandidates.set(stale, staleCandidate);
        // 后台候选已用尽，仍应继续派发可见候选而不是提前结束本轮 drain。
        expect(plan.next()).toMatchObject({candidate: visibleCandidate});
    });
});
