/**
 * @file tests/fullPageRuntimeHelpers.test.ts
 * 文件职责：针对全文翻译运行时拆分出的事件接线（runtimeSessionEvents）与变更归属判定（runtimeMutationOwnership）提供直接分支单元测试。
 * 主要内容：覆盖开放 ShadowRoot 发现、滚动回调、扩展自有 transition/animation 过滤、close/toggle 立即刷新与 rAF 合并及取消；以及候选遗忘、节点归属匹配、错误兜底提取、用户取消记忆、加载期合成子列表校验与错误/加载/单语态 MutationRecord 归属判定。
 * 模块边界：仅操作 linkedom DOM 与最小 FullPageSession 内存对象，不触发真实翻译网络或后台消息通道。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    attachFullPageSessionEvents,
} from '@/src/features/full-page-translation/content/runtimeSessionEvents';
import {
    candidateLifecycleSource,
    forgetScheduledCandidate,
    isIntactLoadingSyntheticChildList,
    isOwnTranslationMutation,
    rememberUserCancelledCandidate,
    removeScheduledForStateTarget,
} from '@/src/features/full-page-translation/content/runtimeMutationOwnership';
import {normalizeOrphanedTranslationOwner} from '@/src/features/full-page-translation/content/orphanArtifacts';
import {createFullPageQueueState} from '@/src/features/full-page-translation/content/fullPageQueue';
import {
    beginTranslation,
    getTranslationState,
    markTranslationComplete,
    markTranslationError,
    restoreAllTranslations,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';
import type {FullPageSession} from '@/src/features/full-page-translation/content/fullPageSession';
import type {TranslationCandidate} from '@/src/core/translation/public';

function installDom(html = '<!doctype html><html><body><div id="root"><p id="p1">Hello world</p></div></body></html>') {
    const dom = parseHTML(html);
    const {window, document} = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('Text', window.Text);
    return {window, document};
}

function createMinimalSession(): FullPageSession {
    return {
        ...createFullPageQueueState(),
        active: true,
        modalDirty: false,
        shadowEventController: new AbortController(),
        scrollController: {note: vi.fn(), isScrolling: () => false, reset: vi.fn()},
        scheduled: new Map(),
        candidateAnchors: new Map(),
        observedCandidates: new Map(),
        candidateOwnerKeys: new Map(),
        observer: {observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()},
        userCancelledCandidates: new WeakMap(),
    } as unknown as FullPageSession;
}

function dispatchDocEvent(window: Window & {Event: typeof Event}, document: Document, type: string, target: EventTarget) {
    const ev = new window.Event(type, {bubbles: true});
    if (target === document) {
        document.dispatchEvent(ev);
    } else {
        target.dispatchEvent(ev);
    }
}

afterEach(() => {
    try {restoreAllTranslations();} catch { /* ignore */ }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('runtimeSessionEvents 完整事件分支', () => {
    it('覆盖 shadowRoot 发现、滚动、自有过渡过滤、rAF 合并、close/toggle 立即刷新与 abort 取消', () => {
        const {window, document} = installDom();
        let nextFrameId = 1;
        const frames = new Map<number, FrameRequestCallback>();
        window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
            const id = nextFrameId++;
            frames.set(id, cb);
            return id;
        });
        window.cancelAnimationFrame = vi.fn((id: number) => {
            frames.delete(id);
        });

        const session = createMinimalSession();
        let current = true;
        const callbacks = {
            isCurrentSession: () => current,
            observeRoot: vi.fn(),
            enqueueRescan: vi.fn(),
            refreshModal: vi.fn(),
            scheduleDrain: vi.fn(),
        };

        attachFullPageSessionEvents(session, callbacks);

        // 1. shadow root 事件：非 Element 目标（document）、无 shadowRoot 目标、有效 shadowRoot 目标
        dispatchDocEvent(window, document, 'fluentread-open-shadow-root', document);
        expect(callbacks.observeRoot).not.toHaveBeenCalled();

        const hostWithoutShadow = document.createElement('div');
        document.body.appendChild(hostWithoutShadow);
        dispatchDocEvent(window, document, 'fluentread-open-shadow-root', hostWithoutShadow);
        expect(callbacks.observeRoot).not.toHaveBeenCalled();

        const hostWithShadow = document.createElement('div');
        const fakeShadow = document.createElement('div');
        Object.defineProperty(hostWithShadow, 'shadowRoot', {configurable: true, value: fakeShadow});
        document.body.appendChild(hostWithShadow);
        dispatchDocEvent(window, document, 'fluentread-open-shadow-root', hostWithShadow);
        expect(callbacks.observeRoot).toHaveBeenCalledWith(session, fakeShadow);
        expect(callbacks.enqueueRescan).toHaveBeenCalledWith(session, fakeShadow);
        expect(callbacks.refreshModal).toHaveBeenCalledTimes(1);

        // 2. scroll 事件
        document.dispatchEvent(new window.Event('scroll'));
        expect(session.scrollController.note).toHaveBeenCalled();
        expect(callbacks.scheduleDrain).toHaveBeenCalled();

        // 3. transitionend / animationend：扩展自有节点被过滤；普通节点与非 Element 节点安排 rAF
        const owned = document.createElement('div');
        owned.setAttribute('data-fr-translation-owned', 'true');
        document.body.appendChild(owned);
        dispatchDocEvent(window, document, 'transitionend', owned);
        expect(frames.size).toBe(0);

        const plain = document.createElement('div');
        document.body.appendChild(plain);
        dispatchDocEvent(window, document, 'animationend', plain);
        expect(session.modalDirty).toBe(true);
        expect(frames.size).toBe(1);

        // 重复 resize 合并到同一帧
        window.dispatchEvent(new window.Event('resize'));
        expect(frames.size).toBe(1);

        // 非 Element 目标触发 transitionend（覆盖 isElementNode false 分支）
        dispatchDocEvent(window, document, 'transitionend', document);

        // rAF 回调执行（活跃态）
        const [[firstId, firstCb]] = Array.from(frames.entries());
        frames.delete(firstId);
        firstCb(16);
        expect(callbacks.refreshModal).toHaveBeenCalledTimes(2);

        // 4. close 与 toggle 取消已有 rAF 并立即刷新（以及无挂起帧时的 toggle）
        window.dispatchEvent(new window.Event('resize'));
        expect(frames.size).toBe(1);
        dispatchDocEvent(window, document, 'close', plain);
        expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
        expect(callbacks.refreshModal).toHaveBeenCalledTimes(3);

        dispatchDocEvent(window, document, 'toggle', plain);
        expect(callbacks.refreshModal).toHaveBeenCalledTimes(4);

        // 5. rAF 回调触发时会话已失活 -> 不再刷新
        window.dispatchEvent(new window.Event('resize'));
        const [[secondId, secondCb]] = Array.from(frames.entries());
        frames.delete(secondId);
        current = false;
        secondCb(32);
        expect(callbacks.refreshModal).toHaveBeenCalledTimes(4);

        // 失活态事件全部短路
        window.dispatchEvent(new window.Event('resize'));
        dispatchDocEvent(window, document, 'fluentread-open-shadow-root', hostWithShadow);

        // 6. 活跃态排帧后 abort 取消 rAF
        current = true;
        window.dispatchEvent(new window.Event('resize'));
        expect(frames.size).toBe(1);
        session.shadowEventController.abort();
        expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2);
    });
});

describe('runtimeMutationOwnership 边界与变更归属判定', () => {
    it('覆盖候选遗忘、过期 owner key、节点包含匹配、异常回退提取与用户取消记录', () => {
        const {document} = installDom();
        const session = createMinimalSession();
        const p1 = document.getElementById('p1') as HTMLElement;
        const innerSpan = document.createElement('span');
        innerSpan.textContent = 'Inner';
        p1.appendChild(innerSpan);
        const otherDiv = document.createElement('div');
        otherDiv.textContent = 'Other';
        document.body.appendChild(otherDiv);

        const onProgress = vi.fn();
        const candA: TranslationCandidate = {element: p1, scope: 'main', nodes: [innerSpan]} as unknown as TranslationCandidate;
        const candB: TranslationCandidate = {element: otherDiv, scope: 'main', nodes: [otherDiv]} as unknown as TranslationCandidate;

        // 1. session 为 undefined 时直接返回
        forgetScheduledCandidate(undefined, candA, onProgress);
        expect(onProgress).not.toHaveBeenCalled();

        // 2. 不在 scheduled 中但在 pending 中 -> 触发 onProgressChange
        session.pending.set(innerSpan, candA);
        forgetScheduledCandidate(session, candA, onProgress);
        expect(onProgress).toHaveBeenCalledTimes(1);

        // 3. removeScheduledForStateTarget：包含已失效 key（!candidate）、仅靠 candidate.nodes 命中、以及不命中分支
        const staleKey = document.createTextNode('stale');
        const candByNode: TranslationCandidate = {element: otherDiv, scope: 'main', nodes: [innerSpan]} as unknown as TranslationCandidate;
        session.scheduled.set(innerSpan, candByNode);
        session.scheduled.set(otherDiv, candB);
        session.candidateOwnerKeys.set(p1, new Set<Node>([staleKey, innerSpan, otherDiv]));
        removeScheduledForStateTarget(session, p1, onProgress);
        expect(session.scheduled.has(innerSpan)).toBe(false);
        expect(session.scheduled.has(otherDiv)).toBe(true);

        // 4. candidateLifecycleSource 异常回退（非空与 null textContent）
        const throwingEl = document.createElement('p');
        throwingEl.textContent = 'Fallback text';
        const badCand = {element: throwingEl, scope: 'main', get nodes() {throw new Error('boom');}} as unknown as TranslationCandidate;
        expect(candidateLifecycleSource(badCand)).toBe('Fallback text');
        Object.defineProperty(throwingEl, 'textContent', {configurable: true, value: null});
        expect(candidateLifecycleSource(badCand)).toBe('');

        // 5. rememberUserCancelledCandidate: 空 state.sourceText 回退 + null 节点忽略
        rememberUserCancelledCandidate(
            session,
            {element: p1, scope: 'main'} as unknown as TranslationCandidate,
            p1,
            {sourceText: '', syntheticSourceNodes: [null as unknown as Node]} as never,
        );
        expect(session.userCancelledCandidates.get(p1)).toBeDefined();
    });

    it('覆盖合成加载期子列表校验与 isOwnTranslationMutation 全部状态分支', () => {
        const {document} = installDom();
        const root = document.getElementById('root') as HTMLElement;
        const p1 = document.getElementById('p1') as HTMLElement;
        const checks = new WeakMap<TranslationState, boolean>();

        // 1. 孤儿 owner class mutation 消费返回 true
        const orphanOwner = document.createElement('div');
        orphanOwner.className = 'keep fluent-read-bilingual';
        const orphanArt = document.createElement('span');
        orphanArt.className = 'fluent-read-bilingual-content';
        orphanArt.setAttribute('data-fr-translation-owned', 'true');
        orphanOwner.appendChild(orphanArt);
        root.appendChild(orphanOwner);
        normalizeOrphanedTranslationOwner(orphanOwner);
        expect(isOwnTranslationMutation({
            type: 'attributes',
            target: orphanOwner,
            attributeName: 'class',
            oldValue: null,
            addedNodes: [],
            removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);

        // 2. 非 childList 且落在非 bilingual-content 的扩展自有节点 -> true
        const ownedSpinner = document.createElement('span');
        ownedSpinner.setAttribute('data-fr-translation-owned', 'true');
        root.appendChild(ownedSpinner);
        expect(isOwnTranslationMutation({
            type: 'attributes',
            target: ownedSpinner,
            attributeName: 'style',
            oldValue: null,
            addedNodes: [],
            removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);

        // 3. mutationElement 为 null（孤立文本节点） -> false
        const detachedText = document.createTextNode('orphan');
        expect(isOwnTranslationMutation({
            type: 'characterData',
            target: detachedText,
            oldValue: null,
            addedNodes: [],
            removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(false);

        // 4. isIntactLoadingSyntheticChildList：缺失 syntheticSourceNodes、伪造额外产物、缺失 sourceTextNodes
        const synth = document.createElement('span');
        synth.setAttribute('data-fr-translation-segment', 'true');
        const txt = document.createTextNode('abc');
        synth.appendChild(txt);
        root.appendChild(synth);
        expect(isIntactLoadingSyntheticChildList(synth, {syntheticSegment: true} as never)).toBe(false);

        const fakeArt = document.createElement('span');
        fakeArt.className = 'fluent-read-loading';
        fakeArt.setAttribute('data-fr-translation-owned', 'true');
        synth.appendChild(fakeArt);
        expect(isIntactLoadingSyntheticChildList(synth, {
            syntheticSegment: true,
            syntheticSourceNodes: [txt, fakeArt],
            sourceHTML: synth.innerHTML,
        } as never)).toBe(false);
        fakeArt.remove();
        expect(isIntactLoadingSyntheticChildList(synth, {
            syntheticSegment: true,
            syntheticSourceNodes: [txt],
            sourceHTML: 'abc',
            sourceTextNodes: undefined,
        } as never)).toBe(false);

        // 5. loading 态 class attribute mutation
        const loadingAttempt = beginTranslation(p1, 'bilingual')!;
        expect(isOwnTranslationMutation({
            type: 'attributes',
            target: p1,
            attributeName: 'class',
            oldValue: 'old',
            addedNodes: [],
            removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);

        // 6. error 态 class / style / childList / characterData
        expect(markTranslationError(p1, loadingAttempt.state, loadingAttempt.generation, false)).toBe(true);
        const errorState = getTranslationState(p1)!;
        const retryEl = document.createElement('span');
        retryEl.className = 'fluent-read-retry-wrapper';
        retryEl.setAttribute('data-fr-translation-owned', 'true');
        p1.appendChild(retryEl);
        errorState.retryWrapper = retryEl;
        errorState.renderedClassAttribute = p1.getAttribute('class');
        errorState.renderedStyleAttribute = p1.getAttribute('style');
        expect(isOwnTranslationMutation({
            type: 'attributes', target: p1, attributeName: 'class', oldValue: 'other', addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);
        expect(isOwnTranslationMutation({
            type: 'attributes', target: p1, attributeName: 'style', oldValue: 'color:red', addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);
        expect(isOwnTranslationMutation({
            type: 'childList', target: p1, oldValue: null, addedNodes: [retryEl], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);
        // error 态非产物 / 子元素节点分支
        expect(isOwnTranslationMutation({
            type: 'childList', target: p1, oldValue: null, addedNodes: [document.createElement('i')], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(false);
        expect(isOwnTranslationMutation({
            type: 'characterData', target: p1.firstChild!, oldValue: null, addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(false);

        // 7. 非 error/loading/translated 阶段 -> false
        (errorState as unknown as {phase: string}).phase = 'restored';
        expect(isOwnTranslationMutation({
            type: 'characterData', target: p1.firstChild!, oldValue: null, addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(false);
        restoreAllTranslations();

        // 8. translated + single 模式 characterData（textSlotsApplied true/false + nodeValue 为 null 与字符串）
        const p2 = document.createElement('p');
        const singleText = document.createTextNode('Original');
        p2.appendChild(singleText);
        root.appendChild(p2);
        const singleAttempt = beginTranslation(p2, 'single')!;
        expect(markTranslationComplete(p2, singleAttempt.state, singleAttempt.generation, false)).toBe(true);
        singleAttempt.state.textSlotsApplied = true;
        singleAttempt.state.translatedTextValues = new Map([[singleText, 'Original']]);
        expect(isOwnTranslationMutation({
            type: 'characterData', target: singleText, oldValue: 'Old', addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);

        singleAttempt.state.translatedTextValues = new Map([[singleText, '']]);
        Object.defineProperty(singleText, 'nodeValue', {configurable: true, value: null});
        expect(isOwnTranslationMutation({
            type: 'characterData', target: singleText, oldValue: 'Old', addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord, checks)).toBe(true);
    });
});
