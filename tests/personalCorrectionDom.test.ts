import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const fixture = vi.hoisted(() => ({lookup: vi.fn(), states: new Map<HTMLElement, any>(),
    config: {on: true, personalCorrectionsEnabled: true}, artifact: true, source: true, refresh: vi.fn(), restore: vi.fn(), set: vi.fn(), indexedOwners: vi.fn(), stateListeners: new Set<(...args: any[]) => void>()}));
vi.mock('@/src/services/config/store', () => ({config: fixture.config}));
vi.mock('@/src/services/personal-corrections/public', () => ({personalCorrections: {lookup: fixture.lookup}}));
vi.mock('@/src/features/full-page-translation/content/state', () => ({
    getTranslationState: (node: HTMLElement) => fixture.states.get(node), setBilingualContent: fixture.set,
    getTranslationOwnersWithin: (root: Node) => [...fixture.states.keys()].filter(node => {
        for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parentNode ?? (ancestor as ShadowRoot).host ?? null) {
            if (ancestor === root) return true;
        }
        return false;
    }),
    getTranslationOwnersForIndexedNode: (node: Node) => fixture.indexedOwners(node),
    subscribeTranslationStateChanges: (listener: (...args: any[]) => void) => {
        fixture.stateListeners.add(listener); return () => {fixture.stateListeners.delete(listener);};
    },
    restoreTranslation: fixture.restore,
}));
vi.mock('@/src/features/full-page-translation/content/translationStability', () => ({
    statefulSourceAndTextSlotsAreCurrent: () => fixture.source, isTranslationArtifactCurrent: () => fixture.artifact,
}));
vi.mock('@/src/features/full-page-translation/content/displayMode', () => ({refreshTranslationPresentation: fixture.refresh}));
vi.mock('@/src/features/full-page-translation/content/viewportStability', () => ({withFullPageViewportAnchor: (action: () => unknown) => action()}));
import {createMaterialId} from '@/src/core/personal-corrections/public';
import {listVisiblePersonalCorrectionPairs, lookupPersonalCorrection, personalCorrectionIsCurrent, readPersonalCorrectionContext,
    readPersonalCorrectionPair, refreshVisiblePersonalCorrections, registerPersonalCorrectionResult,
    invalidateStalePersonalCorrectionContexts, watchPersonalCorrectionContext, disableVisiblePersonalCorrections} from '@/src/features/full-page-translation/content/personalCorrections';

const href = 'https://example.test/article?edition=1';
const query = {source: 'The team is ready.', sourceLanguage: 'en', targetLanguage: 'zh', context: 'Team', materialId: createMaterialId(href)};
function pair(baseline: boolean = true, recordId?: string) {
    const node = document.querySelector('p')!;
    const content = node.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
    const state = {phase: 'translated', mode: 'bilingual', kind: 'content', bilingualContent: content,
        bilingualReplay: {sourceLanguage: 'en', targetLanguage: 'zh', sources: [query.source], translations: ['团队准备好了。'], personalCorrectionId: undefined as string | undefined}};
    fixture.states.set(node, state);
    const snapshot = {query, recordId, ...(baseline ? {baseline: ['团队准备好了。']} : {})};
    registerPersonalCorrectionResult(node, state as any, snapshot);
    return {node, content, state, snapshot};
}
beforeEach(() => {
    const {document} = parseHTML('<html><body><h2>Team</h2><p>The team is ready.<span class="fluent-read-bilingual-content">团队准备好了。</span></p></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('location', {href});
    fixture.states = new Map(); fixture.artifact = true; fixture.source = true;
    Object.assign(fixture.config, {on: true, personalCorrectionsEnabled: true});
    fixture.lookup.mockReset().mockResolvedValue({suggestions: [], conflicts: []});
    fixture.refresh.mockReset().mockImplementation((_node, state) => {
        if (state.bilingualReplay.personalCorrectionId) state.bilingualContent.setAttribute('data-fr-personal-correction', 'true');
        else state.bilingualContent.removeAttribute('data-fr-personal-correction');
        return true;
    });
    fixture.restore.mockReset(); fixture.set.mockReset();
    fixture.indexedOwners.mockReset().mockImplementation(node => fixture.states.has(node) ? [node] : []);
    fixture.stateListeners.clear();
});
afterEach(() => {disableVisiblePersonalCorrections(); vi.unstubAllGlobals(); vi.unstubAllEnvs();});
describe('个人校订的网页所有权端口', () => {
    it('初查预取消不发查询；查询失败时已取消不能当作普通翻译降级', async () => {
        const node = document.querySelector('p')!;
        const controller = new AbortController();
        controller.abort();
        await expect(lookupPersonalCorrection(node, query.source, 'en', 'zh', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fixture.lookup).not.toHaveBeenCalled();
        const inFlight = new AbortController();
        let reject!: (reason: unknown) => void;
        fixture.lookup.mockReturnValueOnce(new Promise((_resolve, fail) => {reject = fail;}));
        const pending = lookupPersonalCorrection(node, query.source, 'en', 'zh', inFlight.signal);
        inFlight.abort();
        reject(new Error('late failure'));
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    });
    it('关闭时零记忆查询；关闭再开启也丢弃上一启用代次的查询和提交', async () => {
        const node = document.querySelector('p')!;
        fixture.config.personalCorrectionsEnabled = false;
        pair(); expect(readPersonalCorrectionPair(node.querySelector('span')!)).toBeNull();
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        expect(await personalCorrectionIsCurrent({query, recordId: 'saved'})).toBe(false);
        expect(fixture.lookup).not.toHaveBeenCalled(); expect(fixture.set).not.toHaveBeenCalled();
        fixture.config.personalCorrectionsEnabled = true; fixture.config.on = false;
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        fixture.config.on = true;
        let resolve!: (value: unknown) => void;
        fixture.lookup.mockReturnValueOnce(new Promise(done => {resolve = done;}));
        const pending = lookupPersonalCorrection(node, query.source, 'en', 'zh');
        fixture.config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections(); fixture.config.personalCorrectionsEnabled = true;
        resolve({exact: {id: 'old', revision: 1, translation: '迟到'}}); expect(await pending).toBeUndefined();
        fixture.lookup.mockResolvedValueOnce({exact: {id: 'saved', revision: 1, translation: '已确认'}});
        const saved = await lookupPersonalCorrection(node, query.source, 'en', 'zh');
        fixture.lookup.mockReturnValueOnce(new Promise(done => {resolve = done;}));
        const checking = personalCorrectionIsCurrent(saved, node);
        fixture.config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections(); fixture.config.personalCorrectionsEnabled = true;
        resolve({exact: {id: 'saved', revision: 1}}); expect(await checking).toBe(false);
        expect(await personalCorrectionIsCurrent(saved)).toBe(false);
    });
    it('关闭恢复服务底稿或原文，解除编辑对；宿主改写后不再重放旧个人译文', () => {
        const confirmed = pair(true, 'saved'); const editorPair = readPersonalCorrectionPair(confirmed.content)!;
        fixture.config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections();
        expect(confirmed.state.bilingualReplay.personalCorrectionId).toBeUndefined();
        expect(confirmed.state.bilingualReplay.translations).toEqual(['团队准备好了。']); expect(editorPair.isCurrent()).toBe(false);
        fixture.config.personalCorrectionsEnabled = true;
        const reused = pair(false, 'saved'); fixture.config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections();
        expect(fixture.restore).toHaveBeenCalledWith(reused.node);
        fixture.config.personalCorrectionsEnabled = true;
        const changedContext = pair(true, 'saved'); document.querySelector('h2')!.textContent = 'New context'; disableVisiblePersonalCorrections();
        expect(fixture.restore).toHaveBeenCalledWith(changedContext.node); document.querySelector('h2')!.textContent = 'Team';
        const hostEdited = pair(true, 'saved'); fixture.artifact = false; disableVisiblePersonalCorrections();
        expect(hostEdited.state.bilingualReplay.personalCorrectionId).toBeUndefined();
        expect(hostEdited.state.bilingualReplay.translations).toEqual(['团队准备好了。']);
        fixture.artifact = true; const noBaseline = pair(false, 'saved'); fixture.source = false; disableVisiblePersonalCorrections();
        expect(noBaseline.state.bilingualReplay).toBeUndefined();
        fixture.source = true; pair(); fixture.refresh.mockClear(); disableVisiblePersonalCorrections(); expect(fixture.refresh).not.toHaveBeenCalled();
        fixture.states = new Map(); disableVisiblePersonalCorrections();
        const orphan = document.createElement('span'); orphan.className = 'fluent-read-bilingual-content';
        vi.spyOn(document, 'querySelectorAll').mockReturnValueOnce([orphan] as any); disableVisiblePersonalCorrections();
    });
    it('关闭的刷新零 IO，在途刷新也不能在关闭后采用返回的个人结果', async () => {
        fixture.config.personalCorrectionsEnabled = false; await refreshVisiblePersonalCorrections(); expect(fixture.lookup).not.toHaveBeenCalled();
        fixture.config.personalCorrectionsEnabled = true; const {state} = pair(true, 'saved');
        let resolve!: (value: unknown) => void; fixture.lookup.mockReturnValueOnce(new Promise(done => {resolve = done;}));
        const pending = refreshVisiblePersonalCorrections(); fixture.config.personalCorrectionsEnabled = false;
        resolve({exact: {id: 'late', translation: '迟到'}}); await pending;
        expect(state.bilingualReplay.translations).toEqual(['团队准备好了。']); expect(state.bilingualReplay.personalCorrectionId).toBeUndefined();
    });
    it.each(['new-refresh', 'disable', 'ordinary-failure'] as const)(
        '校订刷新遇到失败时按 %s 的所有权决定是否继续读取', async scenario => {
            const first = pair(true, 'saved');
            const secondNode = first.node.cloneNode(true) as HTMLElement;
            document.body.append(secondNode);
            const secondContent = secondNode.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
            const secondState = {...first.state, bilingualContent: secondContent,
                bilingualReplay: {...first.state.bilingualReplay, translations: [...first.state.bilingualReplay.translations]}};
            fixture.states.set(secondNode, secondState);
            registerPersonalCorrectionResult(secondNode, secondState as any, {...first.snapshot});
            let rejectOld!: (reason: unknown) => void;
            fixture.lookup.mockReturnValueOnce(new Promise((_resolve, reject) => {rejectOld = reject;}));
            const oldRefresh = refreshVisiblePersonalCorrections();
            expect(fixture.lookup).toHaveBeenCalledTimes(1);
            if (scenario === 'new-refresh') await refreshVisiblePersonalCorrections();
            if (scenario === 'disable') disableVisiblePersonalCorrections();
            const callsBeforeReject = fixture.lookup.mock.calls.length;
            rejectOld(new Error('lookup unavailable'));
            await oldRefresh;
            expect(fixture.lookup).toHaveBeenCalledTimes(callsBeforeReject + (scenario === 'ordinary-failure' ? 1 : 0));
        });
    it('主动开启后按原请求语言校订现有服务译文，准备编辑对不查询记忆或改译文', () => {
        fixture.config.personalCorrectionsEnabled = false; const {content, state} = pair();
        fixture.config.personalCorrectionsEnabled = true;
        const current = readPersonalCorrectionPair(content)!;
        expect(current).toMatchObject({source: query.source, sourceLanguage: 'en', targetLanguage: 'zh', translation: '团队准备好了。'});
        expect(state.bilingualReplay.translations).toEqual(['团队准备好了。']);
        expect(fixture.lookup).not.toHaveBeenCalled(); expect(fixture.refresh).not.toHaveBeenCalled();
        expect(readPersonalCorrectionPair(content)).toMatchObject({source: query.source});
    });
    it('关闭再开启期间完成的普通服务译文仍可按新启用代次校订', async () => {
        const node = document.querySelector('p')!;
        const pendingProvider = await lookupPersonalCorrection(node, query.source, 'en', 'zh');
        fixture.config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections();
        const {state, content} = pair(); fixture.config.personalCorrectionsEnabled = true;
        expect(await personalCorrectionIsCurrent(pendingProvider, node)).toBe(true);
        registerPersonalCorrectionResult(node, state as any, pendingProvider);
        expect(fixture.set).not.toHaveBeenCalled();
        const current = readPersonalCorrectionPair(content)!;
        expect(current).toMatchObject({source: query.source, translation: '团队准备好了。'});
        expect(current.isCurrent()).toBe(true);
        expect(fixture.lookup).toHaveBeenCalledTimes(1);
    });
    it('开启现有译文仍拒绝不安全结构和槽不一致，安全多槽保留整体原句', () => {
        const node = document.querySelector('p')!;
        const attach = (html: string, sources: string[], options: Record<string, unknown> = {}) => {
            node.innerHTML = `${html}<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">旧译文</span>`;
            const content = node.querySelector('span.fluent-read-bilingual-content')!;
            const state = {phase: 'translated', mode: 'bilingual', kind: 'content', bilingualContent: content,
                bilingualReplay: {sources, translations: sources.map((_, i) => i ? '' : '旧译文'), sourceLanguage: 'en', targetLanguage: 'zh'}, ...options};
            fixture.states.set(node, state); return content;
        };
        expect(readPersonalCorrectionPair(attach('Use <code>team.ready</code> now.', ['Use ', ' now.']))).toBeNull();
        expect(readPersonalCorrectionPair(attach('The team is ready.', ['Mismatched source']))).toBeNull();
        expect(readPersonalCorrectionPair(attach('', []))).toBeNull();
        const inline = attach('The <strong>team</strong> is ready.', ['The', 'team', 'is ready.'], {allowTopLevelApplicationShell: true, syntheticSegment: true});
        vi.stubGlobal('getComputedStyle', () => ({whiteSpace: 'pre-wrap'}));
        expect(readPersonalCorrectionPair(inline)).toMatchObject({source: query.source});
        const normal = attach('The <strong>team</strong> is ready.', ['The', 'team', 'is ready.']);
        vi.stubGlobal('getComputedStyle', () => ({whiteSpace: 'normal'}));
        expect(readPersonalCorrectionPair(normal)).toMatchObject({source: query.source});
        expect(fixture.lookup).not.toHaveBeenCalled();
    });
    it('userscript 构建边界不查记忆或注册个人结果，既有翻译保持可提交', async () => {
        vi.stubEnv('BROWSER', 'userscript');
        const node = document.querySelector('p')!;
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        expect(await personalCorrectionIsCurrent({query, recordId: 'saved'})).toBe(true);
        registerPersonalCorrectionResult(node, {} as any, {query, recordId: 'saved'});
        expect(fixture.lookup).not.toHaveBeenCalled(); expect(fixture.set).not.toHaveBeenCalled();
    });
    it('只识别 HTTP 材料；读取失败降级，精确结果携带版本并检查取消', async () => {
        const node = document.querySelector('p')!;
        vi.stubGlobal('location', undefined);
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        vi.stubGlobal('location', {href: 'file:///tmp/a'});
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        vi.stubGlobal('location', {href});
        fixture.lookup.mockRejectedValueOnce(Error('offline'));
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toBeUndefined();
        expect(await lookupPersonalCorrection(node, query.source, 'en', 'zh')).toEqual({query, enableGeneration: expect.any(Number)});
        fixture.lookup.mockResolvedValue({exact: {id: 'record', revision: 2, translation: '小组已就绪。'}});
        const saved = await lookupPersonalCorrection(node, query.source, 'en', 'zh');
        expect(saved).toEqual({query, enableGeneration: expect.any(Number), recordId: 'record', recordRevision: 2, translation: '小组已就绪。'});
        expect(await personalCorrectionIsCurrent(saved)).toBe(true);
        expect(await personalCorrectionIsCurrent(saved, node)).toBe(true);
        document.querySelector('h2')!.textContent = 'Changed while matching';
        expect(await personalCorrectionIsCurrent(saved, node)).toBe(false);
        document.querySelector('h2')!.textContent = 'Team'; vi.stubGlobal('location', {href: href + 'changed'});
        expect(await personalCorrectionIsCurrent(saved, node)).toBe(false);
        vi.stubGlobal('location', {href});
        fixture.lookup.mockResolvedValueOnce({exact: {id: 'record', revision: 3}});
        expect(await personalCorrectionIsCurrent(saved)).toBe(false);
        fixture.lookup.mockResolvedValueOnce({}); expect(await personalCorrectionIsCurrent(saved)).toBe(false);
        fixture.lookup.mockRejectedValueOnce(Error('offline')); expect(await personalCorrectionIsCurrent(saved)).toBe(false);
        expect(await personalCorrectionIsCurrent()).toBe(true);
        expect(await personalCorrectionIsCurrent({query})).toBe(true);
        const controller = new AbortController(); controller.abort();
        await expect(lookupPersonalCorrection(node, query.source, 'en', 'zh', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
    it('标题语境有界向前查找；无标题和孤立单元使用空语境', () => {
        const node = document.querySelector('p')!;
        expect(readPersonalCorrectionContext(node)).toBe('Team');
        const heading = document.querySelector('h2')!;
        heading.innerHTML = 'Team<span data-fr-translation-owned="true">团队</span>';
        expect(readPersonalCorrectionContext(node)).toBe('Team');
        fixture.states.set(heading, {sourceText: 'Team'});
        expect(readPersonalCorrectionContext(node)).toBe('Team');
        fixture.source = false; expect(readPersonalCorrectionContext(node)).toBe('Team'); fixture.source = true;
        const emptyClone = document.createElement('h2'); Object.defineProperty(emptyClone, 'textContent', {get: () => null});
        const clone = vi.spyOn(heading, 'cloneNode').mockReturnValueOnce(emptyClone); fixture.source = false;
        expect(readPersonalCorrectionContext(node)).toBe(''); clone.mockRestore(); fixture.source = true;
        document.body.innerHTML = '<section><h3> Details </h3><div>unrelated</div><div><p>text</p></div></section>';
        expect(readPersonalCorrectionContext(document.querySelector('p')!)).toBe('Details');
        document.querySelector('h3')!.textContent = null;
        expect(readPersonalCorrectionContext(document.querySelector('p')!)).toBe('');
        document.body.innerHTML = `<h1>too far</h1>${'<div>x</div>'.repeat(51)}<p>text</p>`;
        expect(readPersonalCorrectionContext(document.querySelector('p')!)).toBe('');
        document.body.innerHTML = `<h1>too deep</h1>${'<div>'.repeat(22)}<p>text</p>${'</div>'.repeat(22)}`;
        expect(readPersonalCorrectionContext(document.querySelector('p')!)).toBe('');
        expect(readPersonalCorrectionContext(document.createElement('p'))).toBe('');
    });
    it('标记与撤销在受控译文上更新，空草稿、断连及来源改写不得提交', () => {
        expect(readPersonalCorrectionPair(document.body)).toBeNull();
        const {node, content, state} = pair();
        const current = readPersonalCorrectionPair(content)!;
        expect(current.translation).toBe('团队准备好了。'); expect(current.isCurrent()).toBe(true);
        expect(current.apply(' ')).toBe(false); expect(current.apply('小组已就绪。', 'saved')).toBe(true);
        expect(state.bilingualReplay.translations).toEqual(['小组已就绪。']);
        expect(content.getAttribute('data-fr-personal-correction')).toBe('true');
        fixture.source = false; expect(current.isCurrent()).toBe(false); expect(current.apply('迟到')).toBe(false);
        fixture.source = true; fixture.artifact = false; expect(readPersonalCorrectionPair(content)).toBeNull();
        fixture.artifact = true; document.querySelector('h2')!.textContent = 'Different context'; expect(current.isCurrent()).toBe(false);
        document.querySelector('h2')!.textContent = 'Team'; vi.stubGlobal('location', {href: `${href}2`}); expect(current.isCurrent()).toBe(false);
        vi.stubGlobal('location', {href}); fixture.states.delete(node); expect(current.isCurrent()).toBe(false);
        fixture.states.set(node, state); node.remove(); expect(current.isCurrent()).toBe(false);
        registerPersonalCorrectionResult(node, state as any, undefined);
        registerPersonalCorrectionResult(node, {} as any, {query});
    });
    it('受影响单元按来源、材料、语言及上下文精确预览；多槽只向首槽写整段', () => {
        const {content, state} = pair();
        state.bilingualReplay.sources = [query.source, 'second'];
        expect(readPersonalCorrectionPair(content)!.apply('新译文')).toBe(true);
        expect(state.bilingualReplay.translations).toEqual(['新译文', '']);
        expect(listVisiblePersonalCorrectionPairs(query)).toHaveLength(1);
        for (const field of ['source', 'sourceLanguage', 'targetLanguage', 'context', 'materialId']) {
            expect(listVisiblePersonalCorrectionPairs({...query, [field]: 'different'})).toHaveLength(0);
        }
        fixture.states = new Map(); expect(listVisiblePersonalCorrectionPairs(query)).toHaveLength(0);
        const orphan = document.createElement('span'); orphan.className = 'fluent-read-bilingual-content'; expect(readPersonalCorrectionPair(orphan)).toBeNull();
    });
    it('删除或范围退出回滚服务底稿；复用而无底稿的单元恢复原文', async () => {
        const {state} = pair(true, 'saved');
        fixture.lookup.mockResolvedValueOnce({exact: {id: 'updated', translation: '新版'}});
        await refreshVisiblePersonalCorrections(); expect(state.bilingualReplay.translations).toEqual(['新版']);
        await refreshVisiblePersonalCorrections(); expect(state.bilingualReplay.translations).toEqual(['团队准备好了。']);
        expect(state.bilingualReplay.personalCorrectionId).toBeUndefined();
        await refreshVisiblePersonalCorrections(); expect(fixture.restore).not.toHaveBeenCalled();
        const reused = pair(false, 'saved'); await refreshVisiblePersonalCorrections(); expect(fixture.restore).toHaveBeenCalledWith(reused.node);
        fixture.lookup.mockRejectedValueOnce(Error('unavailable')); await refreshVisiblePersonalCorrections();
        fixture.states = new Map(); await refreshVisiblePersonalCorrections();
        const unattached = document.createElement('span'); unattached.className = 'fluent-read-bilingual-content';
        const queryAll = vi.spyOn(document, 'querySelectorAll').mockReturnValueOnce([] as any).mockReturnValueOnce([unattached] as any);
        await refreshVisiblePersonalCorrections(); queryAll.mockRestore();
    });
    it('变更广播重复或在途页面改变时丢弃旧刷新', async () => {
        const {node, state} = pair(true, 'saved');
        let resolve!: (value: unknown) => void;
        fixture.lookup.mockReturnValueOnce(new Promise(done => {resolve = done;}));
        const first = refreshVisiblePersonalCorrections(); await refreshVisiblePersonalCorrections();
        resolve({exact: {id: 'old', translation: '迟到'}}); await first;
        expect(state.bilingualReplay.translations).not.toContain('迟到');
        fixture.lookup.mockImplementationOnce(async () => {fixture.states.delete(node); return {};});
        await refreshVisiblePersonalCorrections();
    });
    it('标题与 SPA 材料变化立即恢复旧个人结果；宿主来源已改写时保留原有所有权修复路径', async () => {
        const {node, content} = pair(true, 'saved');
        document.querySelector('h2')!.textContent = 'New context';
        invalidateStalePersonalCorrectionContexts(); expect(fixture.restore).toHaveBeenCalledWith(node);
        fixture.restore.mockClear(); fixture.source = false;
        invalidateStalePersonalCorrectionContexts(); expect(fixture.restore).not.toHaveBeenCalled();
        fixture.source = true; document.querySelector('h2')!.textContent = 'Team';
        vi.stubGlobal('location', {href: href + '#/new-material'});
        await refreshVisiblePersonalCorrections(); expect(fixture.restore).toHaveBeenCalledWith(node);
        expect(fixture.lookup).not.toHaveBeenCalled();
        fixture.states = new Map(); invalidateStalePersonalCorrectionContexts();
        const unattached = document.createElement('span'); unattached.setAttribute('data-fr-personal-correction', 'true');
        const queryAll = vi.spyOn(document, 'querySelectorAll').mockReturnValueOnce([unattached] as any);
        invalidateStalePersonalCorrectionContexts(); queryAll.mockRestore();
        content.remove();
    });
    it('窄标题结构观察不触发 IO，忽略扩展自有 DOM，并在取消后释放路由和观察者', () => {
        let callback!: (mutations: MutationRecord[]) => void;
        const observe = vi.fn(), disconnect = vi.fn();
        const construct = vi.fn();
        vi.stubGlobal('MutationObserver', class {constructor(handler: typeof callback) {construct(); callback = handler;} observe = observe; disconnect = disconnect;});
        const canceled = new AbortController(); canceled.abort(); watchPersonalCorrectionContext(canceled.signal)();
        expect(construct).not.toHaveBeenCalled();
        const controller = new AbortController(); const dispose = watchPersonalCorrectionContext(controller.signal);
        expect(observe).toHaveBeenCalledWith(document, {subtree: true, childList: true, characterData: true});
        const {node, content} = pair(true, 'saved');
        content.setAttribute('data-fr-translation-owned', 'true');
        const record = (target: Node, type: string = 'childList', addedNodes: Node[] = [], removedNodes: Node[] = []) => ({target, type, addedNodes, removedNodes}) as unknown as MutationRecord;
        callback([record(content), record(content.firstChild!, 'characterData')]);
        callback([record(node.firstChild!, 'characterData'), record(document.createTextNode('detached'), 'characterData')]);
        callback([record(document.body, 'childList', [document.createTextNode('text'), content, document.createElement('div')])]);
        expect(fixture.restore).not.toHaveBeenCalled();
        document.querySelector('h2')!.textContent = 'Changed';
        callback([record(document.querySelector('h2')!.firstChild!, 'characterData')]);
        expect(fixture.restore).toHaveBeenCalledWith(node); fixture.restore.mockClear();
        callback([record(document.body, 'childList', [document.createElement('h1')])]);
        const section = document.createElement('section'); section.innerHTML = '<h3>Added heading</h3>';
        callback([record(document.body, 'childList', [], [section])]);
        callback([record(document.querySelector('h2')!)]);
        expect(fixture.restore).toHaveBeenCalledTimes(3); fixture.restore.mockClear();
        document.querySelector('h2')!.textContent = 'Team'; vi.stubGlobal('location', {href: href + '?new'});
        document.dispatchEvent(new document.defaultView!.Event('fluentread-route-change'));
        expect(fixture.restore).toHaveBeenCalledWith(node); fixture.restore.mockClear();
        dispose(); document.dispatchEvent(new document.defaultView!.Event('fluentread-route-change'));
        expect(fixture.restore).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce();
        const second = new AbortController(); watchPersonalCorrectionContext(second.signal); second.abort();
        expect(disconnect).toHaveBeenCalledTimes(2); expect(fixture.lookup).not.toHaveBeenCalled();
    });

    it('局部索引排除无校订和仅租用祖先的外部分支，开放 ShadowRoot 内的移动仍失效', () => {
        let callback!: (mutations: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {constructor(handler: typeof callback) {callback = handler;} observe() {} disconnect() {}});
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        expect(fixture.stateListeners.size).toBe(1);
        const {node, state} = pair(true, 'saved');
        const changed = document.createElement('div'); changed.innerHTML = '<span>Unrelated content</span>';
        document.body.appendChild(changed);
        const record = (element: Element) => [{type: 'childList', target: document.body, addedNodes: [element], removedNodes: []}] as unknown as MutationRecord[];
        fixture.indexedOwners.mockImplementation(indexed => indexed === changed ? [node] : []);
        callback(record(changed)); expect(fixture.restore).not.toHaveBeenCalled();
        const noMetadata = document.createElement('p'); changed.appendChild(noMetadata);
        fixture.states.set(noMetadata, {});
        fixture.indexedOwners.mockImplementation(indexed => indexed === noMetadata ? [noMetadata] : []);
        callback(record(changed)); expect(fixture.restore).not.toHaveBeenCalled();
        fixture.states.delete(noMetadata);
        const shadow = changed.attachShadow({mode: 'open'}); shadow.appendChild(node);
        fixture.indexedOwners.mockImplementation(indexed => indexed === node ? [node] : []);
        callback(record(changed));
        expect(fixture.restore).toHaveBeenCalledWith(node);
        expect(fixture.states.get(node)).toBe(state);
        controller.abort(); expect(fixture.stateListeners.size).toBe(0); expect(fixture.lookup).not.toHaveBeenCalled();
    });

    it('登记复用弱引用，状态替换、取消与回收不会保留过期校订单元', () => {
        let callback!: (mutations: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {constructor(handler: typeof callback) {callback = handler;} observe() {} disconnect() {}});
        const references: Array<{value: HTMLElement; live: boolean}> = [];
        const deref = vi.fn();
        vi.stubGlobal('WeakRef', class {
            reference: {value: HTMLElement; live: boolean};
            constructor(value: HTMLElement) {this.reference = {value, live: true}; references.push(this.reference);}
            deref() {deref(); return this.reference.live ? this.reference.value : undefined;}
        });
        const {node} = pair(); pair();
        expect(references).toHaveLength(1); expect(references[0].value).toBe(node);
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const record = [{type: 'childList', target: document.body, addedNodes: [document.createElement('div')], removedNodes: []}] as unknown as MutationRecord[];
        callback(record); expect(deref).toHaveBeenCalledOnce(); deref.mockClear();
        document.createDocumentFragment().appendChild(node);
        callback(record); expect(deref).toHaveBeenCalledOnce(); deref.mockClear();
        document.body.appendChild(node);
        fixture.states.set(node, {});
        callback(record); expect(deref).toHaveBeenCalledOnce(); deref.mockClear();
        callback(record); expect(deref).not.toHaveBeenCalled();
        pair(); references[0].live = false;
        callback(record); expect(deref).toHaveBeenCalledOnce(); deref.mockClear();
        callback(record); expect(deref).not.toHaveBeenCalled();
        pair(); disableVisiblePersonalCorrections();
        callback(record); expect(deref).not.toHaveBeenCalled();
        controller.abort(); expect(fixture.lookup).not.toHaveBeenCalled();
    });
});
