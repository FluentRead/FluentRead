import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeElement {
    id: string;
    parentElement: FakeElement | null;
    textContent: string;
    rect: {top: number; bottom: number};
    getBoundingClientRect(): {top: number; bottom: number};
}

interface FakeCandidate {
    element: FakeElement;
    nodes?: {textContent: string; nodeType?: number; parentElement?: FakeElement | null; owner?: unknown}[];
    kind: 'content' | 'control';
    reason: string;
}

const harness = vi.hoisted(() => ({
    config: {translationScope: 'content' as 'content' | 'all', maxConcurrentTranslations: 10},
    checkConfig: vi.fn(() => true),
    capture: vi.fn((overrides = {}) => ({displayMode: 'bilingual', ...overrides})),
    identity: vi.fn((snapshot: unknown) => JSON.stringify(snapshot)),
    translateTarget: vi.fn(),
    restoreTranslationOwner: vi.fn((_owner: unknown) => true),
    states: new Map<unknown, Record<string, unknown>>(),
    owners: [] as unknown[],
    ownersWithin: vi.fn(),
    discoveries: {content: [] as unknown[], all: [] as unknown[]},
    structural: vi.fn(() => false),
    scopesUsed: [] as string[],
    requestSession: {requestSignal: new AbortController().signal, renderCommitGeneration: 0},
    stateListeners: new Set<(owner: unknown, state: Record<string, unknown> | undefined, previousState?: Record<string, unknown>) => void>(),
}));

vi.mock('@/src/services/config/store', () => ({config: harness.config}));
vi.mock('@/src/app/translation/check', () => ({checkConfig: harness.checkConfig}));
vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({
    captureFullPageTranslationConfig: harness.capture,
    getTranslationInvocationIdentity: harness.identity,
}));
vi.mock('@/src/features/full-page-translation/content/runtime', () => ({
    translateTarget: harness.translateTarget,
    restoreTranslationOwner: harness.restoreTranslationOwner,
}));
vi.mock('@/src/features/full-page-translation/content/requestSession', () => ({
    getHoverTranslationRequestSession: () => harness.requestSession,
}));
vi.mock('@/src/features/full-page-translation/content/state', () => ({
    getTranslationState: (node: unknown) => harness.states.get(node),
    getTranslationOwnersWithin: harness.ownersWithin,
    resolveTranslationStateNode: (candidate: FakeCandidate) => candidate.nodes?.length
        ? (candidate.nodes[0] as unknown as {owner?: unknown}).owner ?? null
        : candidate.element,
    subscribeTranslationStateChanges: (listener: (owner: unknown, state: Record<string, unknown> | undefined, previousState?: Record<string, unknown>) => void) => {
        harness.stateListeners.add(listener);
        return () => {harness.stateListeners.delete(listener);};
    },
}));
vi.mock('@/src/core/translation/public', () => ({
    getComposedParent: (element: FakeElement & {shadowHost?: FakeElement}) => element.parentElement ?? element.shadowHost ?? null,
    maxComposedAncestorDepth: 512,
    getTranslationCandidateKey: (candidate: FakeCandidate) => candidate.nodes?.find(node => node.nodeType === 1 || node.nodeType === 3) ?? candidate.element,
    getTranslatableControlValueAttribute: (element: {getAttribute?: (name: string) => string}) => element.getAttribute ? 'value' : null,
    selectPreferredTranslationCandidate: (existing: unknown, incoming: unknown) => existing ?? incoming,
    getCurrentTranslationCore: (scope: 'content' | 'all') => ({
        isWithinStructuralRegion: harness.structural,
        *discoverSteps() {
            harness.scopesUsed.push(scope);
            for (const step of harness.discoveries[scope]) yield step;
        },
    }),
}));

import {
    SECTION_PREVIEW_DISCOVERY_STEPS,
    inspectTranslationSection,
    toggleTranslationSection,
} from '@/src/features/full-page-translation/content/sectionTranslation';

function element(id: string, top = 0, parent: FakeElement | null = null, text = `text ${id}`): FakeElement {
    const rect = {top, bottom: top + 20};
    return {id, parentElement: parent, textContent: text, rect, getBoundingClientRect: () => rect};
}

function candidate(el: FakeElement, nodes?: FakeCandidate['nodes']): FakeCandidate {
    nodes?.forEach(node => {
        if (!('parentElement' in node)) node.parentElement = node.owner as FakeElement | undefined ?? el;
        if (!('nodeType' in node)) node.nodeType = 3;
    });
    return {element: el, kind: 'content', reason: 'test', ...(nodes ? {nodes} : {})};
}

function steps(candidates: FakeCandidate[], extraSteps = 0): unknown[] {
    return [
        ...Array.from({length: extraSteps}, () => ({phase: 'enter'})),
        ...candidates.map((item) => ({phase: 'exit', element: item.element, candidate: item})),
    ];
}

const root = element('root');

function own(target: unknown, phase: string, extra: Record<string, unknown> = {}): void {
    const state = {phase, kind: 'content', ...extra};
    harness.states.set(target, state);
    harness.owners.push(target);
    harness.stateListeners.forEach(listener => listener(target, state));
}

beforeEach(() => {
    vi.clearAllMocks();
    harness.config.translationScope = 'content';
    harness.config.maxConcurrentTranslations = 10;
    harness.requestSession = {requestSignal: new AbortController().signal, renderCommitGeneration: 0};
    harness.checkConfig.mockReturnValue(true);
    harness.restoreTranslationOwner.mockReturnValue(true);
    harness.states.clear();
    harness.owners = [];
    harness.ownersWithin.mockImplementation(() => [...harness.owners]);
    harness.discoveries.content = [];
    harness.discoveries.all = [];
    harness.structural.mockReturnValue(false);
    harness.scopesUsed.length = 0;
    vi.stubGlobal('window', {innerHeight: 600});
});

afterEach(() => {
    expect(harness.stateListeners.size).toBe(0);
    vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('局部翻译区域盘点', () => {
    it('区分已翻译、失败待重试和未翻译段落，失败段落计入待翻译', () => {
        const translated = candidate(element('translated', 0, root));
        const failed = candidate(element('failed', 40, root));
        const fresh = candidate(element('fresh', 80, root));
        own(translated.element, 'translated');
        own(failed.element, 'error');
        harness.discoveries.content = steps([translated, failed, fresh]);

        expect(inspectTranslationSection(root as unknown as Element)).toEqual({
            total: 3, active: 1, pending: 2, truncated: false, action: 'translate',
        });
        expect(SECTION_PREVIEW_DISCOVERY_STEPS).toBeGreaterThan(1000);
    });

    it('全部已翻译或翻译中时点击恢复原文，没有候选时说明无可翻译文字', () => {
        const done = candidate(element('done', 0, root));
        const loading = candidate(element('loading', 40, root));
        own(done.element, 'translated');
        own(loading.element, 'loading');
        harness.discoveries.content = steps([done, loading]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 2, active: 2, pending: 0, action: 'restore'});

        harness.owners = [];
        harness.discoveries.content = [];
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 0, action: 'empty'});
        // 正文范围为空时再用全部节点范围确认一次，两次都为空才算没有文字。
        expect(harness.scopesUsed).toEqual(['content', 'content', 'all']);
    });

    it('预览步数用尽时标记为下限，没有已知状态时仍按翻译提示', () => {
        const first = candidate(element('first', 0, root));
        harness.discoveries.content = steps([first], 5);
        expect(inspectTranslationSection(root as unknown as Element, 3)).toEqual({
            total: 0, active: 0, pending: 0, truncated: true, action: 'translate',
        });
        own(first.element, 'translated');
        harness.discoveries.content = steps([first, candidate(element('later', 40, root))]);
        expect(inspectTranslationSection(root as unknown as Element, 1)).toMatchObject({truncated: true, active: 1, action: 'restore'});
    });

    it('页面框架内或全局设置为全部节点时直接使用全部节点范围', () => {
        const item = candidate(element('nav-item', 0, root));
        harness.discoveries.all = steps([item]);
        harness.structural.mockReturnValue(true);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, pending: 1});
        expect(harness.scopesUsed).toEqual(['all']);

        harness.structural.mockReturnValue(false);
        harness.config.translationScope = 'all';
        harness.scopesUsed.length = 0;
        inspectTranslationSection(root as unknown as Element);
        expect(harness.scopesUsed).toEqual(['all']);
        expect(harness.structural).toHaveBeenCalledOnce();
    });

    it('同一候选键只保留一个候选，合成文本段按首个来源节点识别状态', () => {
        const owner = element('segment-owner', 0, root);
        const node = {textContent: 'inline run', owner};
        const segment = candidate(element('host', 0, root), [node]);
        own(owner, 'translated');
        harness.discoveries.content = steps([segment, segment]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, active: 1, action: 'restore'});
        // 找不到状态宿主的合成段按未翻译处理。
        const orphan = candidate(element('orphan', 0, root), [{textContent: 'orphan run'}]);
        harness.owners = [];
        harness.discoveries.content = steps([orphan]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({pending: 1, action: 'translate'});
    });

    it('点选范围在已翻译的更大段落内部时，整段视为该区域并可恢复', async () => {
        const owner = element('owner', 0);
        const inner = element('inner', 0, owner);
        harness.states.set(owner, {phase: 'translated'});
        expect(inspectTranslationSection(inner as unknown as Element)).toEqual({
            total: 1, active: 1, pending: 0, truncated: false, action: 'restore',
        });
        expect(harness.scopesUsed).toEqual([]);

        await expect(toggleTranslationSection(inner as unknown as Element)).resolves.toMatchObject({action: 'restored', restored: 1});
        expect(harness.restoreTranslationOwner).toHaveBeenCalledWith(owner);
    });
});

describe('局部翻译切换', () => {
    it('按阅读位置翻译待处理段落：先视口内，再下方，最后上方', async () => {
        const above = candidate(element('above', -300, root));
        const below = candidate(element('below', 900, root));
        const farBelow = candidate(element('far-below', 1800, root));
        const visibleLower = candidate(element('visible-lower', 400, root));
        const visibleTop = candidate(element('visible-top', 10, root));
        const nearAbove = candidate(element('near-above', -60, root));
        // 同一行并排的两个段落保持发现顺序。
        const besideTop = candidate(element('beside-top', 10, root));
        harness.discoveries.content = steps([above, below, farBelow, visibleLower, visibleTop, besideTop, nearAbove]);
        harness.translateTarget.mockResolvedValue({status: 'committed'});

        const result = await toggleTranslationSection(root as unknown as Element);

        expect(harness.translateTarget.mock.calls.map(([item]) => (item as FakeCandidate).element.id)).toEqual([
            'visible-top', 'beside-top', 'visible-lower', 'below', 'far-below', 'near-above', 'above',
        ]);
        expect(harness.translateTarget).toHaveBeenCalledWith(visibleTop, 'bilingual', false, undefined, {displayMode: 'bilingual'}, false);
        expect(result).toEqual({action: 'translated', translated: 7, failed: 0, unchanged: 0, restored: 0});
    });

    it('统计成功、失败与无需翻译的段落，并记住无需翻译的段落供下次切换', async () => {
        const committed = candidate(element('committed', 0, root));
        const failed = candidate(element('failed', 30, root));
        const same = candidate(element('same', 60, root));
        const blank = candidate(element('blank', 90, root));
        const thrown = candidate(element('thrown', 120, root));
        const owned = candidate(element('owned', 150, root));
        harness.discoveries.content = steps([committed, failed, same, blank, thrown, owned]);
        harness.translateTarget.mockImplementation(async (item: FakeCandidate) => {
            if (item === failed) {
                own(item.element, 'error');
                return {status: 'failed'};
            }
            if (item === same) return {status: 'unchanged', source: 'text'};
            if (item === blank) return {status: 'empty'};
            if (item === thrown) throw new Error('boom');
            if (item === owned) return {status: 'owned'};
            own(item.element, 'translated');
            return {status: 'committed'};
        });

        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'translated', translated: 1, failed: 2, unchanged: 2, restored: 0,
        });

        // 目标语言段落不再算作待翻译；失败、异常与被占用的段落仍可再次点选重试。
        own(owned.element, 'loading');
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({active: 2, pending: 2, total: 6, action: 'translate'});

        // 原文变化后，之前“无需翻译”的记忆失效。
        same.element.textContent = 'changed text';
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({pending: 3});
    });

    it('区域全部为目标语言时切换结果为 settled，不再重复请求', async () => {
        const only = candidate(element('only', 0, root), [{textContent: 'inline'}]);
        harness.discoveries.content = steps([only]);
        harness.translateTarget.mockResolvedValue({status: 'unchanged', source: 'inline'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'translated', unchanged: 1});

        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, pending: 0, action: 'settled'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'settled', translated: 0, failed: 0, unchanged: 0, restored: 0,
        });
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('失败的合成行内段不在候选发现中，也会按其状态重建候选并重试', async () => {
        const segment = element('failed-segment', 0, root);
        const source = {textContent: 'inline source', owner: segment, parentElement: segment, nodeType: 3};
        own(segment, 'error', {syntheticSegment: true, sourceTextNodes: [source], scope: 'all', allowTopLevelApplicationShell: true});
        const plain = element('failed-block', 30, root);
        own(plain, 'error');
        harness.translateTarget.mockResolvedValue({status: 'committed'});

        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 2, pending: 2, active: 0, action: 'translate'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'translated', translated: 2});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([
            {element: segment, kind: 'content', reason: 'section-retry', scope: 'all', nodes: [source], allowTopLevelApplicationShell: true},
            {element: plain, kind: 'content', reason: 'section-retry'},
        ]);
    });

    it('配置检查未通过时不发出任何请求', async () => {
        harness.discoveries.content = steps([candidate(element('blocked', 0, root))]);
        harness.checkConfig.mockReturnValue(false);
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'blocked'});
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('没有候选时返回 empty；全部已翻译时只恢复该区域内的译文', async () => {
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'empty'});

        const done = candidate(element('done', 0, root));
        own(done.element, 'translated');
        harness.discoveries.content = steps([done]);
        // 仅译文槽不会出现在候选发现里，只能通过所有者索引找到并恢复。
        const extra = element('translation-only-owner', 0, root);
        own(extra, 'translated');
        harness.restoreTranslationOwner.mockImplementation((owner: unknown) => owner === done.element);

        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'restored', translated: 0, failed: 0, unchanged: 0, restored: 1,
        });
        expect(harness.ownersWithin).toHaveBeenCalledWith(root);
        expect(harness.restoreTranslationOwner).toHaveBeenCalledWith(extra);
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });
});


describe('局部快捷方案请求隔离', () => {
    it('全部候选使用同一独立快照，而非全局默认服务和显示方式', async () => {
        const first = candidate(element('profile-first', 0, root));
        const second = candidate(element('profile-second', 50, root));
        harness.discoveries.content = steps([first, second]);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const overrides = {profileId: 'section-1', service: 'openai', model: 'chosen', targetLanguage: 'ja', displayMode: 'single' as const};
        await toggleTranslationSection(root as unknown as Element, overrides);
        expect(harness.checkConfig).toHaveBeenCalledWith(overrides);
        for (const item of [first, second]) {
            expect(harness.translateTarget).toHaveBeenCalledWith(item, 'single', false, undefined, overrides, false);
        }
    });

    it('换目标语言时重新判断先前无需翻译的段落', async () => {
        const item = candidate(element('settled-profile', 0, root));
        harness.discoveries.content = steps([item]);
        harness.translateTarget.mockResolvedValue({status: 'unchanged'});
        const japanese = {profileId: 'section-ja', targetLanguage: 'ja'};
        await toggleTranslationSection(root as unknown as Element, japanese);
        expect(inspectTranslationSection(root as unknown as Element, undefined, japanese).action).toBe('settled');
        const chinese = {profileId: 'section-zh', targetLanguage: 'zh-Hans'};
        expect(inspectTranslationSection(root as unknown as Element, undefined, chinese).action).toBe('translate');
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        expect((await toggleTranslationSection(root as unknown as Element, chinese)).translated).toBe(1);
    });

    it('同一方案恢复已有容器，另一方案重新翻译该容器', async () => {
        const el = element('translated-profile', 0, root);
        const overrides = {profileId: 'section-ja', targetLanguage: 'ja'};
        own(el, 'translated', {translationInvocationIdentity: JSON.stringify({displayMode: 'bilingual', ...overrides})});
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides).action).toBe('restore');
        const alternate = {profileId: 'section-zh', targetLanguage: 'zh-Hans'};
        expect(inspectTranslationSection(root as unknown as Element, undefined, alternate).action).toBe('translate');
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        expect((await toggleTranslationSection(root as unknown as Element, alternate)).translated).toBe(1);
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
        expect((await toggleTranslationSection(root as unknown as Element, overrides)).restored).toBe(1);
    });
});


it('在已有译文段落内部换方案时，按原文所有者重建候选并使用新请求', async () => {
    const owner = element('ancestor-profile', 0, root);
    const inner = element('inside-profile', 0, owner);
    own(owner, 'translated', {translationInvocationIdentity: 'old-profile', sourceTextNodes: [{textContent: 'original'}]});
    const overrides = {profileId: 'section-new', targetLanguage: 'fr'};
    expect(inspectTranslationSection(inner as unknown as Element, undefined, overrides)).toMatchObject({action: 'translate', pending: 1, active: 0});
    harness.translateTarget.mockResolvedValue({status: 'committed'});
    expect((await toggleTranslationSection(inner as unknown as Element, overrides)).translated).toBe(1);
    expect(harness.translateTarget).toHaveBeenCalledWith(expect.objectContaining({element: owner}), 'bilingual', false, undefined, expect.objectContaining(overrides), false);
});

describe('局部盘点快照和迟到无需翻译结果', () => {
    it.each(['element', 'nodes'] as const)('旧结果不会把新原文记为无需翻译：%s', async mode => {
        const el = element(`late-source-${mode}`, 0, root, '已经是目标语言');
        const nodes = [{textContent: '已经是目标语言'}];
        const item = candidate(el, mode === 'nodes' ? nodes : undefined); harness.discoveries.content = steps([item]);
        let finish!: (value: unknown) => void; harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        el.textContent = nodes[0].textContent = 'New foreign source'; finish({status: 'unchanged', source: '已经是目标语言'}); await task;
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({action: 'translate', pending: 1});
        harness.translateTarget.mockResolvedValueOnce({status: 'committed'}); await toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, {profileId: 'section-lazy', targetLanguage: 'ja'}])('新候选预览不读取全文文本或重建请求快照：%s', overrides => {
        const el = element('fresh-lazy', 0, root), readText = vi.fn(() => 'Fresh text');
        Object.defineProperty(el, 'textContent', {get: readText}); harness.discoveries.content = steps([candidate(el)]);
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides)).toMatchObject({action: 'translate', pending: 1});
        expect(harness.capture).not.toHaveBeenCalled(); expect(harness.identity).not.toHaveBeenCalled(); expect(readText).not.toHaveBeenCalled();
    });
    it('同方案已有译文默认预览不构造快照，比较方案时仅构造一次', () => {
        const overrides = {profileId: 'section-lazy', targetLanguage: 'ja'};
        const first = element('first-owner-lazy', 0, root), second = element('second-owner-lazy', 20, root);
        const identity = JSON.stringify({displayMode: 'bilingual', ...overrides});
        own(first, 'translated', {translationInvocationIdentity: identity}); own(second, 'translated', {translationInvocationIdentity: identity});
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('restore'); expect(harness.capture).not.toHaveBeenCalled();
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides).action).toBe('restore');
        expect(harness.capture).toHaveBeenCalledOnce(); expect(harness.identity).toHaveBeenCalledOnce();
    });
});

describe('区域批次响应、取消和精确所有权', () => {
    function pendingTargets(count = 3): FakeCandidate[] {
        const items = Array.from({length: count}, (_, index) => candidate(element(`batch-${index}`, index * 30, root)));
        harness.discoveries.content = steps(items);
        return items;
    }

    function ownRequest(item: FakeCandidate): Record<string, unknown> {
        const state = {phase: 'loading', kind: 'content', controller: new AbortController()};
        harness.states.set(item.element, state);
        harness.owners.push(item.element);
        harness.stateListeners.forEach(listener => listener(item.element, state));
        return state;
    }

    function restoreRequests(): void {
        harness.restoreTranslationOwner.mockImplementation((owner: unknown) => {
            const state = harness.states.get(owner);
            (state?.controller as AbortController | undefined)?.abort();
            harness.states.delete(owner);
            harness.owners = harness.owners.filter(value => value !== owner);
            harness.stateListeners.forEach(listener => listener(owner, undefined, state));
            return Boolean(state);
        });
    }

    it('小区域首次确认同步派发可见段落，遵守在途上限并给下一批让帧', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets();
        const finishes: ((value: unknown) => void)[] = [];
        harness.translateTarget.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).toHaveBeenCalledTimes(1);
        expect(harness.translateTarget.mock.calls[0][0]).toBe(items[0]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({action: 'restore', total: 3, active: 3, pending: 0});
        finishes[0]({status: 'committed'}); await Promise.resolve();
        expect(harness.translateTarget).toHaveBeenCalledTimes(1);
        await vi.runOnlyPendingTimersAsync();
        expect(harness.translateTarget).toHaveBeenCalledTimes(2);
        finishes[1]({status: 'not-current'}); await vi.runOnlyPendingTimersAsync();
        expect(harness.translateTarget).toHaveBeenCalledTimes(3);
        finishes[2]({status: 'committed'});
        await expect(task).resolves.toMatchObject({action: 'translated', translated: 2, failed: 0});
    });

    it('超大区域扫描让帧且可在扫描期间取消，不发出任何请求', async () => {
        vi.useFakeTimers();
        pendingTargets(700);
        const controller = new AbortController();
        const task = toggleTranslationSection(root as unknown as Element, undefined, controller.signal);
        expect(harness.translateTarget).not.toHaveBeenCalled();
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({action: 'restore', truncated: true});
        controller.abort();
        await expect(task).resolves.toMatchObject({action: 'cancelled'});
        expect(vi.getTimerCount()).toBe(0);
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('完整扫描与位置测量分片后仍先翻译视口，并缓存同宿主位置读数', async () => {
        vi.useFakeTimers();
        const items = pendingTargets(450);
        items[0].element.rect = {top: 20000, bottom: 20020};
        items[0].element.getBoundingClientRect = () => items[0].element.rect;
        const host = items[1].element;
        const measure = vi.fn(() => host.rect);
        host.getBoundingClientRect = measure;
        items.push(candidate(host, [{textContent: 'inline other run'}]));
        harness.discoveries.content = steps(items);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'translated', translated: 451});
        expect(harness.translateTarget.mock.calls[0][0]).toBe(items[1]);
        expect(harness.translateTarget.mock.calls.at(-1)?.[0]).toBe(items[0]);
        expect(measure).toHaveBeenCalledOnce();
    });

    it('provider 不结算也能返回 cancelled，取消精确 loading 请求并保留已提交译文', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 2;
        const items = pendingTargets();
        let finishFirst!: (value: unknown) => void;
        harness.translateTarget.mockImplementation((item: FakeCandidate) => {
            ownRequest(item);
            return item === items[0] ? new Promise(resolve => {finishFirst = resolve;}) : new Promise(() => {});
        });
        restoreRequests();
        const controller = new AbortController();
        const task = toggleTranslationSection(root as unknown as Element, undefined, controller.signal);
        harness.states.get(items[0].element)!.phase = 'translated';
        finishFirst({status: 'committed'}); await Promise.resolve();
        controller.abort();
        await expect(task).resolves.toMatchObject({action: 'cancelled', translated: 1, restored: 1});
        expect(harness.states.get(items[0].element)?.phase).toBe('translated');
        expect(harness.restoreTranslationOwner).toHaveBeenCalledWith(items[1].element);
        expect(harness.translateTarget).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['translated', 'replaced', 'removed'] as const)('取消不恢复后来接管或已结算的状态：%s', async mode => {
        const [item] = pendingTargets(1);
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockImplementation(() => { ownRequest(item); return new Promise(resolve => {finish = resolve;}); });
        restoreRequests();
        const controller = new AbortController();
        const task = toggleTranslationSection(root as unknown as Element, undefined, controller.signal);
        if (mode === 'translated') harness.states.get(item.element)!.phase = 'translated';
        else if (mode === 'replaced') harness.states.set(item.element, {phase: 'loading', kind: 'content'});
        else harness.states.delete(item.element);
        controller.abort();
        await expect(task).resolves.toMatchObject({action: 'cancelled', restored: 0});
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
        finish({status: 'unchanged'}); await Promise.resolve();
        // 迟到结果不能写入无需翻译记忆，也不能恢复替代状态。
        harness.owners = []; harness.states.clear();
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('translate');
    });

    it('同区域再次确认取消扫描并恢复，而新方案接管后旧收尾不会清除新操作', async () => {
        vi.useFakeTimers();
        pendingTargets(500);
        const same = {profileId: 'profile-one', targetLanguage: 'ja'};
        const old = toggleTranslationSection(root as unknown as Element, same);
        expect(inspectTranslationSection(root as unknown as Element, undefined, same).action).toBe('restore');
        await expect(toggleTranslationSection(root as unknown as Element, same)).resolves.toMatchObject({action: 'restored'});
        await expect(old).resolves.toMatchObject({action: 'cancelled'});
        const first = toggleTranslationSection(root as unknown as Element, same);
        const alternate = {profileId: 'profile-two', targetLanguage: 'fr'};
        expect(inspectTranslationSection(root as unknown as Element, undefined, alternate).action).toBe('translate');
        const second = toggleTranslationSection(root as unknown as Element, alternate);
        await expect(first).resolves.toMatchObject({action: 'cancelled'});
        expect(inspectTranslationSection(root as unknown as Element, undefined, alternate).action).toBe('restore');
        await toggleTranslationSection(root as unknown as Element, alternate);
        await expect(second).resolves.toMatchObject({action: 'cancelled'});
        expect(vi.getTimerCount()).toBe(0);
    });

    it('全页恢复的请求生命周期信号终止未派发项，不等 provider 请求结束', async () => {
        harness.config.maxConcurrentTranslations = 1;
        pendingTargets();
        harness.translateTarget.mockReturnValue(new Promise(() => {}));
        const lifecycle = new AbortController();
        harness.requestSession.requestSignal = lifecycle.signal;
        const task = toggleTranslationSection(root as unknown as Element);
        lifecycle.abort();
        await expect(task).resolves.toMatchObject({action: 'cancelled'});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it.each(['generation', 'session', 'detach'] as const)('发现让帧后拒绝旧页面任务：%s', async mode => {
        vi.useFakeTimers();
        const region = element(`route-${mode}`);
        pendingTargets(450);
        const task = toggleTranslationSection(region as unknown as Element);
        if (mode === 'generation') harness.requestSession.renderCommitGeneration += 1;
        else if (mode === 'session') harness.requestSession = {requestSignal: new AbortController().signal, renderCommitGeneration: 0};
        else Object.assign(region, {isConnected: false});
        expect(inspectTranslationSection(region as unknown as Element).action).toBe('translate');
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'cancelled'});
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('让帧后被另一翻译接管的候选不会由旧方案翻译或恢复', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets();
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;})).mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        harness.states.set(items[1].element, {phase: 'translated', kind: 'content', translationInvocationIdentity: 'other'});
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'translated', translated: 2});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([items[0], items[2]]);
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
    });

    it('子区域后续翻译又恢复后，父区域的旧未派发计划不重译它', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets();
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;})).mockResolvedValue({status: 'committed'});
        restoreRequests();
        const parent = toggleTranslationSection(root as unknown as Element);
        own(items[1].element, 'translated');
        harness.discoveries.content = steps([items[1]]);
        await expect(toggleTranslationSection(items[1].element as unknown as Element)).resolves.toMatchObject({action: 'restored', restored: 1});
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(parent).resolves.toMatchObject({translated: 2});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([items[0], items[2]]);
    });

    it.each(['element-first', 'text-first'] as const)('合成行内段的共享状态变化按原始首节点取消旧父计划：%s', async mode => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets(2);
        const host = items[1].element;
        const direct = {textContent: 'inline source', parentElement: host};
        const text = mode === 'text-first' ? direct : {textContent: 'inline source', parentElement: host};
        items[1] = candidate(host, [direct]);
        harness.discoveries.content = steps(items);
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        restoreRequests();
        const parent = toggleTranslationSection(root as unknown as Element);
        const synthetic = element('new-segment-owner', 0, host);
        own(synthetic, 'translated', {syntheticSegment: true, syntheticSourceNodes: [direct], sourceTextNodes: [text]});
        harness.discoveries.content = [];
        await expect(toggleTranslationSection(host as unknown as Element)).resolves.toMatchObject({action: 'restored', restored: 1});
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(parent).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it.each(['plain', 'element-first', 'text-first'] as const)('共享状态通知拦截悬浮翻译后恢复，即使回到 undefined：%s', async mode => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets(2);
        const host = items[1].element;
        const direct = {textContent: 'inline source', parentElement: host};
        const text = mode === 'text-first' ? direct : {textContent: 'inline source', parentElement: host};
        if (mode !== 'plain') {items[1] = candidate(host, [direct]); harness.discoveries.content = steps(items);}
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        const owner = mode === 'plain' ? host : element('hover-synthetic-owner', 0, host);
        own(owner, 'loading', mode === 'plain' ? {} : {syntheticSegment: true, syntheticSourceNodes: [direct], sourceTextNodes: [text]});
        // 模拟共享 runtime 悬浮恢复的 clear 通知；不经过区域恢复接口。
        harness.states.delete(owner);
        harness.owners = harness.owners.filter(value => value !== owner);
        harness.stateListeners.forEach(listener => listener(owner, undefined));
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
    });

    it('前缀 Comment 的合法行内候选复用共享 Element/Text key 拦截后来接管', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets(2);
        const host = items[1].element;
        const comment = {textContent: '', nodeType: 8, parentElement: host};
        const bold = {textContent: 'Bold source', nodeType: 1, parentElement: host};
        const text = {textContent: 'Trailing source', nodeType: 3, parentElement: host};
        items[1] = candidate(host, [comment, bold, text]);
        harness.discoveries.content = steps(items);
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        const owner = element('comment-prefixed-segment', 0, host);
        own(owner, 'loading', {syntheticSegment: true, syntheticSourceNodes: [comment, bold, text], sourceTextNodes: [text]});
        harness.states.delete(owner);
        harness.owners = harness.owners.filter(value => value !== owner);
        harness.stateListeners.forEach(listener => listener(owner, undefined));
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('进行中盘点保留总段落数，但不把已确认无需翻译的来源算作 active', async () => {
        const items = pendingTargets(2);
        harness.discoveries.content = steps([items[0]]);
        harness.translateTarget.mockResolvedValueOnce({status: 'unchanged'});
        await toggleTranslationSection(root as unknown as Element);
        harness.discoveries.content = steps(items);
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 2, active: 1, pending: 0, action: 'restore'});
        finish({status: 'committed'});
        await expect(task).resolves.toMatchObject({translated: 1, unchanged: 0});
    });

    it('候选冻结之前的合法 owner 换代使用新状态重试，之后的接管才使旧计划失效', async () => {
        vi.useFakeTimers();
        const owners = Array.from({length: 450}, (_, index) => element(`freeze-owner-${index}`, index * 20, root));
        owners.forEach(owner => own(owner, 'error'));
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        // 首个时间片尚未盘点第 300 个 owner；同一页面的状态变化是它的最新合法快照。
        own(owners[300], 'error', {generation: 2});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 450});
        expect(harness.translateTarget.mock.calls.some(([item]) => item.element === owners[300])).toBe(true);
    });

    it('发现尚未冻结候选时发生悬浮翻译后恢复，旧区域计划仍尊重恢复结果', async () => {
        vi.useFakeTimers();
        const items = pendingTargets(2);
        harness.discoveries.content = steps(items, 250);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).not.toHaveBeenCalled();
        own(items[1].element, 'loading');
        const previous = harness.states.get(items[1].element);
        harness.states.delete(items[1].element);
        harness.owners = harness.owners.filter(value => value !== items[1].element);
        harness.stateListeners.forEach(listener => listener(items[1].element, undefined, previous));
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([items[0]]);
    });

    it('操作开始前已有合成 owner 在发现期间恢复，用 clear 的旧来源身份排除旧计划', async () => {
        vi.useFakeTimers();
        const items = pendingTargets(2);
        const host = items[1].element;
        const comment = {textContent: '', nodeType: 8, parentElement: host};
        const bold = {textContent: 'Bold source', nodeType: 1, parentElement: host};
        const text = {textContent: 'Trailing source', nodeType: 3, parentElement: host};
        items[1] = candidate(host, [comment, bold, text]);
        const owner = element('pre-existing-segment', 0, host);
        own(owner, 'translated', {syntheticSegment: true, syntheticSourceNodes: [comment, bold, text], sourceTextNodes: [text]});
        const previous = harness.states.get(owner);
        harness.discoveries.content = steps(items, 250);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).not.toHaveBeenCalled();
        // 本区域订阅未见过旧 owner 的 begin，只能依靠 clear 同时提供的 previousState。
        harness.states.delete(owner);
        harness.owners = [];
        harness.stateListeners.forEach(listener => listener(owner, undefined, previous));
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([items[0]]);
    });

    it.each(['element', 'inline', 'shadow'] as const)('等待期间移到区域外的来源保持宿主权威：%s', async mode => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const outside = element('outside-region');
        const items = pendingTargets(2);
        const source = {textContent: 'inline original', parentElement: mode === 'shadow' ? null : items[1].element};
        if (mode !== 'element') {
            if (mode === 'shadow') Object.assign(source, {shadowHost: items[1].element});
            items[1] = candidate(items[1].element, [source]);
            harness.discoveries.content = steps(items);
        }
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;})).mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        if (mode === 'element') items[1].element.parentElement = outside;
        else if (mode === 'inline') source.parentElement = outside;
        else Object.assign(source, {shadowHost: outside});
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
    });

    it('仍在原选区的 Shadow 来源可翻译，祖先深度越界则保守跳过', async () => {
        const host = element('shadow-in-section', 0, root);
        const source = {textContent: 'shadow source', parentElement: null, shadowHost: host};
        harness.discoveries.content = steps([candidate(host, [source])]);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({translated: 1});
        let parent = root;
        for (let index = 0; index < 513; index += 1) parent = element(`deep-${index}`, 0, parent);
        harness.discoveries.content = steps([candidate(parent)]);
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({translated: 0});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('原选区让帧期间离开已有祖先 owner，显式祖先例外也不再放行', async () => {
        const owner = element('ancestor-moved', 0, root);
        const selected = element('selected-moved', 0, owner);
        own(owner, 'translated', {translationInvocationIdentity: 'old'});
        owner.getBoundingClientRect = () => {selected.parentElement = element('new-outside-parent'); return owner.rect;};
        await expect(toggleTranslationSection(selected as unknown as Element, {profileId: 'new'})).resolves.toMatchObject({translated: 0});
        expect(harness.translateTarget).not.toHaveBeenCalled();
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
    });

    it('发现已登记的原文在位置测量期间被悬浮接管时，不覆盖它的新状态', async () => {
        vi.useFakeTimers();
        const items = pendingTargets(450);
        const takenOver = items[300];
        const translated = {phase: 'translated', kind: 'content', translationInvocationIdentity: 'hover-new'};
        items[0].element.getBoundingClientRect = () => {
            harness.states.set(takenOver.element, translated);
            return items[0].element.rect;
        };
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 449});
        expect(harness.translateTarget.mock.calls.some(([item]) => item === takenOver)).toBe(false);
        expect(harness.states.get(takenOver.element)).toBe(translated);
    });

    it('已有 owner 列表让帧期间被恢复时，换方案不会重建它的旧状态', async () => {
        vi.useFakeTimers();
        const owners = Array.from({length: 450}, (_, index) => element(`old-owner-${index}`, index * 20, root));
        owners.forEach(owner => own(owner, 'translated', {translationInvocationIdentity: 'old-profile'}));
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element, {profileId: 'new-profile', targetLanguage: 'ja'});
        harness.states.delete(owners[300]);
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 449});
        expect(harness.translateTarget.mock.calls.some(([item]) => item.element === owners[300])).toBe(false);
    });

    it('单次 DOM 测量超过时间片时让帧，不必等够 200 个步骤', async () => {
        vi.useFakeTimers();
        const items = pendingTargets();
        let elapsed = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        items.forEach(item => { item.element.getBoundingClientRect = () => {elapsed += 9; return item.element.rect;}; });
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({translated: 3});
        clock.mockRestore();
    });

    it('显式重试错误段落要求绕过同会话失败缓存，普通候选沿用缓存', async () => {
        const items = pendingTargets(2);
        own(items[0].element, 'error');
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        await toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget.mock.calls.map(args => args[5])).toEqual([true, false]);
    });

    it('按钮 input 标签变化后无需翻译记忆失效，移除 value 后也重新判断', async () => {
        const el = element('control-label', 0, root);
        let value: string | null = 'Already target';
        Object.assign(el, {getAttribute: () => value});
        const item: FakeCandidate = {...candidate(el), kind: 'control'};
        harness.discoveries.content = steps([item]);
        harness.translateTarget.mockResolvedValue({status: 'unchanged'});
        await toggleTranslationSection(root as unknown as Element);
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('settled');
        value = 'Foreign label';
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('translate');
        value = null;
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('translate');
    });

    it('入口已取消或区域已移除时不扫描或构造请求配置', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(toggleTranslationSection(root as unknown as Element, undefined, controller.signal)).resolves.toMatchObject({action: 'cancelled'});
        const detached = {...element('detached'), isConnected: false};
        await expect(toggleTranslationSection(detached as unknown as Element)).resolves.toMatchObject({action: 'cancelled'});
        expect(harness.capture).not.toHaveBeenCalled();
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('位置测量时取消立即返回，不派发第一批请求', async () => {
        const items = pendingTargets();
        const controller = new AbortController();
        items[0].element.getBoundingClientRect = () => {controller.abort(); return items[0].element.rect;};
        await expect(toggleTranslationSection(root as unknown as Element, undefined, controller.signal)).resolves.toMatchObject({action: 'cancelled'});
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('位置测量已让帧后取消也移除 timer，不派发或留下悬空等待', async () => {
        vi.useFakeTimers();
        const items = pendingTargets(450);
        const controller = new AbortController();
        items[250].element.getBoundingClientRect = () => {controller.abort(); return items[250].element.rect;};
        const task = toggleTranslationSection(root as unknown as Element, undefined, controller.signal);
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'cancelled'});
        expect(harness.translateTarget).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('路由在下一次派发之前变化时，旧计划取消而不开始下一个请求', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        pendingTargets();
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        finish({status: 'committed'}); await Promise.resolve();
        harness.requestSession.renderCommitGeneration += 1;
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'cancelled', translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('所有未派发项已被后来操作接管时正常完成，不等待不存在的请求', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets();
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        items.slice(1).forEach(item => harness.states.set(item.element, {phase: 'translated', kind: 'content'}));
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'translated', translated: 1});
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('派发预处理超过时间片后先让帧，再继续使用共享并发上限', async () => {
        vi.useFakeTimers();
        pendingTargets();
        let elapsed = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        harness.translateTarget.mockImplementation(() => {elapsed += 9; return Promise.resolve({status: 'committed'});});
        const task = toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        await expect(task).resolves.toMatchObject({action: 'translated', translated: 3});
        clock.mockRestore();
    });

    it.each([0, 250])('同步或让帧后的候选发现异常清理区域操作：%s 步', async extraSteps => {
        vi.useFakeTimers();
        const broken = {get candidate(): never {throw new Error('host discovery unavailable');}};
        harness.discoveries.content = [...steps([], extraSteps), broken];
        const task = toggleTranslationSection(root as unknown as Element);
        const rejection = expect(task).rejects.toThrow('host discovery unavailable');
        await vi.runAllTimersAsync();
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        harness.discoveries.content = [];
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('empty');
    });

    it('后续派发的 DOM 读取异常会拒绝任务并清理 timer，不留下悬空区域操作', async () => {
        vi.useFakeTimers();
        harness.config.maxConcurrentTranslations = 1;
        const items = pendingTargets(2);
        Object.defineProperty(items[1].element, 'textContent', {get: () => {throw new Error('host text unavailable');}});
        let finish!: (value: unknown) => void;
        harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        const rejection = expect(task).rejects.toThrow('host text unavailable');
        finish({status: 'committed'});
        await vi.runAllTimersAsync();
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        harness.discoveries.content = [];
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('empty');
    });

    it.each([undefined, [], [{textContent: 'inline source'}]])('已有合成 owner 无论来源快照为空还是完整都能恢复：%s', async sourceTextNodes => {
        const owner = element('synthetic-restore');
        const inner = element('synthetic-inner', 0, owner);
        own(owner, 'translated', {syntheticSegment: true, sourceTextNodes});
        await expect(toggleTranslationSection(inner as unknown as Element)).resolves.toMatchObject({restored: 1});
        own(owner, 'translated', {syntheticSegment: true, sourceTextNodes});
        await expect(toggleTranslationSection(inner as unknown as Element)).resolves.toMatchObject({restored: 1});
    });

    it('盘点后已失去状态的恢复 owner 不计为恢复成功', async () => {
        const owner = element('restore-disappeared', 0, root);
        own(owner, 'translated');
        harness.ownersWithin.mockImplementationOnce(() => [owner]).mockImplementationOnce(() => {
            harness.states.delete(owner); return [owner];
        });
        harness.restoreTranslationOwner.mockReturnValue(false);
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'restored', restored: 0});
    });
});
