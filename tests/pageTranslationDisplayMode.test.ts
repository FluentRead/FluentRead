import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const corrections = vi.hoisted(() => ({lookup: vi.fn()}));
vi.mock('@/src/services/config/store', () => ({config: {style: 0, to: 'zh-Hans', display: 1, on: true, personalCorrectionsEnabled: true}}));
vi.mock('@/src/services/personal-corrections/public', () => ({personalCorrections: {lookup: corrections.lookup}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
import {applyTranslationsToSnapshot, collectLiveTranslationTextSlots, createTranslationSourceSnapshot,
    getCurrentTranslationCore} from '@/src/core/translation/public';
import {appendBilingualTranslation, appendSingleTranslationSlots} from '@/src/features/full-page-translation/content/renderer';
import {createPageTranslationDisplayModeSync, refreshTranslationDisplayMode, refreshTranslationPresentation, syncPageTranslationDisplayMode, syncTranslationDisplayMode} from '@/src/features/full-page-translation/content/displayMode';
import {createMaterialId} from '@/src/core/personal-corrections/public';
import {disableVisiblePersonalCorrections, invalidateStalePersonalCorrectionContexts, readPersonalCorrectionPair,
    refreshVisiblePersonalCorrections, registerPersonalCorrectionResult, watchPersonalCorrectionContext} from '@/src/features/full-page-translation/content/personalCorrections';
import {config} from '@/src/services/config/store';
import {beginTranslation, createBilingualTranslationReplay, getTranslationState, markTranslationComplete,
    restoreAllTranslations, restoreTranslation, setBilingualContent, setLiveTranslationSourceSnapshot,
    setRenderedStyleAttribute, setSingleTextSlotHosts, type BilingualTranslationReplay} from '@/src/features/full-page-translation/content/state';
import {isTranslationArtifactCurrent, statefulSourceAndTextSlotsAreCurrent} from '@/src/features/full-page-translation/content/translationStability';
import * as translationState from '@/src/features/full-page-translation/content/state';

let document: Document;
beforeEach(() => {
    config.display = 1;
    config.translationOnlyDomains = [];
    config.on = true; config.personalCorrectionsEnabled = true;
    corrections.lookup.mockReset().mockResolvedValue({suggestions: [], conflicts: []});
    document = parseHTML('<html><head><base href="https://example.com/"></head><body><main></main></body></html>').document;
    const realm = document.defaultView as unknown as Record<string, unknown>;
    for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'ShadowRoot']) vi.stubGlobal(name, realm[name]);
    vi.stubGlobal('document', document); vi.stubGlobal('window', document.defaultView);
    vi.stubGlobal('location', {href: 'https://example.com/article'});
    vi.stubGlobal('DOMParser', class {parseFromString(source: string) {
        return parseHTML(`<html><head></head><body>${source}</body></html>`).document;
    }});
});
afterEach(() => {restoreAllTranslations(); disableVisiblePersonalCorrections(); vi.unstubAllGlobals();});

function committed(mode: 'bilingual' | 'single' = 'bilingual', overrides: Partial<BilingualTranslationReplay> = {},
    html = ' First sentence. <a href="https://example.com/before">Read details.</a><code>protected()</code> ', synthetic = false) {
    const owner = document.createElement('p'); owner.innerHTML = html;
    document.querySelector('main')!.appendChild(owner);
    const sourceHTML = owner.innerHTML;
    const core = getCurrentTranslationCore();
    const parts = collectLiveTranslationTextSlots(owner, core.shouldStayOriginal);
    const sources = parts.map(part => part.source), translations = sources.map((_, index) => `译文${index + 1}。`);
    const attempt = beginTranslation(owner, mode, 'content', synthetic, sources.join(' '), parts.map(part => part.node), false, 'frozen-identity')!;
    if (synthetic) owner.setAttribute('data-fr-translation-segment', 'true');
    const replay = {...createBilingualTranslationReplay(sources, translations, {sourceLanguage: 'en', targetLanguage: 'zh-Hans',
        service: 'microsoft', style: 0, translationBeforeOriginal: true}), ...overrides};
    expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
    if (mode === 'bilingual') {
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, synthetic ? owner : undefined);
        const content = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot, translations),
            {...replay, sourceSkeleton: snapshot.clone});
        setBilingualContent(owner, content, replay);
    } else {
        setLiveTranslationSourceSnapshot(owner, parts.map(part => part.node));
        const hosts = appendSingleTranslationSlots(owner, parts.map((part, index) => ({node: part.node,
            text: `${part.prefix}${translations[index]}${part.suffix}`})), replay);
        setSingleTextSlotHosts(owner, hosts); attempt.state.bilingualReplay = replay;
    }
    setRenderedStyleAttribute(owner);
    return {owner, state: attempt.state, sources, translations, sourceHTML, nodes: parts.map(part => part.node)};
}

describe('已提交网页译文显示切换', () => {
    it('网站偏好切换立即复用已有译文，忽略无关网站变化，移除后恢复全局模式与原文身份', () => {
        const {owner, state, nodes, sourceHTML} = committed();
        const preferences = {display: 1, translationOnlyDomains: [] as string[]};
        const sync = createPageTranslationDisplayModeSync(preferences, vi.fn());
        const generation = state.generation, controller = state.controller;
        preferences.translationOnlyDomains.push('example.com'); sync(preferences);
        expect(state.mode).toBe('single'); expect(owner.querySelector('.fluent-read-bilingual-content')).toBeNull();
        const hosts = state.singleTextSlotHosts;
        preferences.translationOnlyDomains.push('another.test'); sync(preferences);
        expect(state.singleTextSlotHosts).toBe(hosts);
        preferences.translationOnlyDomains = ['another.test']; sync(preferences);
        expect(state.mode).toBe('bilingual'); expect(state.generation).toBe(generation); expect(state.controller).toBe(controller);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        expect(restoreTranslation(owner)).toBe(true); expect(owner.innerHTML).toBe(sourceHTML);
    });
    it('整句行内代码重放贯通双语与单语，代码或原始空白变化时拒绝旧译文', () => {
        vi.stubGlobal('getComputedStyle', () => ({display: 'inline', visibility: 'visible', contentVisibility: 'visible',
            opacity: '1', whiteSpace: 'normal', fontFamily: 'Arial', position: 'static', overflow: 'visible',
            width: '20px', height: '20px', clip: 'auto', clipPath: 'none',
            getPropertyValue: () => '', getPropertyPriority: () => ''}));
        const fixture = committed('bilingual', {
            inlineCodeTexts: ['fetch()', 'parse()'], inlineCodeClasses: ['notranslate', null], inlineCodeSourceTexts: ['Use ', ' before ', ' now.'],
        }, 'Use <code class="notranslate">fetch()</code> before <code>parse()</code> now.');
        expect(statefulSourceAndTextSlotsAreCurrent(fixture.owner, fixture.state)).toBe(true);
        expect(syncTranslationDisplayMode(fixture.owner, fixture.state, 0)).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(fixture.owner, fixture.state)).toBe(true);
        expect(syncTranslationDisplayMode(fixture.owner, fixture.state, 1)).toBe(true);
        const code = Array.from(fixture.owner.children).find(child => child.localName === 'code')!;
        code.removeAttribute('class');
        expect(statefulSourceAndTextSlotsAreCurrent(fixture.owner, fixture.state)).toBe(false);
        expect(refreshTranslationDisplayMode(fixture.owner, fixture.state)).toBe(false);
        code.setAttribute('class', 'notranslate');
        code.textContent = 'changed()';
        expect(statefulSourceAndTextSlotsAreCurrent(fixture.owner, fixture.state)).toBe(false);
        expect(refreshTranslationDisplayMode(fixture.owner, fixture.state)).toBe(false);
        expect(syncTranslationDisplayMode(fixture.owner, fixture.state, 0)).toBe(false);
        code.textContent = 'fetch()';
        fixture.nodes[0]!.data = 'Use';
        expect(statefulSourceAndTextSlotsAreCurrent(fixture.owner, fixture.state)).toBe(false);
        expect(refreshTranslationDisplayMode(fixture.owner, fixture.state)).toBe(false);
    });

    function corrected(baseline = true) {
        const fixture = committed('bilingual', {}, 'The team is ready.');
        const heading = document.createElement('h2'); heading.textContent = 'Team';
        fixture.owner.before(heading);
        registerPersonalCorrectionResult(fixture.owner, fixture.state, {query: {source: fixture.sources[0],
            sourceLanguage: 'en', targetLanguage: 'zh-Hans', context: 'Team', materialId: createMaterialId(location.href)},
            ...(baseline ? {baseline: fixture.translations} : {})});
        expect(readPersonalCorrectionPair(fixture.state.bilingualContent!)!.apply('读者确认的译文。', 'saved')).toBe(true);
        expect(syncTranslationDisplayMode(fixture.owner, fixture.state, 0)).toBe(true);
        return {...fixture, heading};
    }

    it.each([false, true])('无关动态节点不枚举全页译文，已有个人校订=%s', hasCorrection => {
        const correctedPair = hasCorrection ? corrected() : undefined;
        const main = document.querySelector('main')!;
        for (let index = 0; index < 300; index++) {
            const owner = document.createElement('p'); owner.textContent = `Ordinary translated paragraph ${index}.`;
            main.appendChild(owner);
            expect(beginTranslation(owner, 'bilingual')).not.toBeNull();
        }
        let mutations!: (records: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: typeof mutations) {mutations = callback;}
            observe() {} disconnect() {}
        });
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const addedNodes = Array.from({length: 40}, () => document.createElement('div'));
        const deref = vi.spyOn(WeakRef.prototype, 'deref');
        try {
            mutations([{type: 'childList', target: document.body, addedNodes, removedNodes: []} as unknown as MutationRecord]);
            console.info(JSON.stringify({metric: 'personal-correction-unrelated-owner-dereferences', hasCorrection,
                activeOwners: 300 + Number(hasCorrection), changedElements: addedNodes.length, actual: deref.mock.calls.length}));
            expect(deref.mock.calls.length).toBe(Number(hasCorrection));
            if (correctedPair) expect(getTranslationState(correctedPair.owner)).toBe(correctedPair.state);
            expect(corrections.lookup).not.toHaveBeenCalled();
        } finally {deref.mockRestore(); controller.abort();}
    });

    it.each([false, true])('五万节点变更的索引探针有界，个人单元在子树内=%s', containsCorrection => {
        const correctedPair = corrected();
        const root = document.createElement('section'); root.innerHTML = '<i></i>'.repeat(50_000);
        const heading = document.createElement('h2'); heading.textContent = 'Another team';
        document.querySelector('main')!.append(heading, root);
        if (containsCorrection) root.appendChild(correctedPair.owner);
        let mutations!: (records: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: typeof mutations) {mutations = callback;}
            observe() {} disconnect() {}
        });
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const indexed = vi.spyOn(translationState, 'getTranslationOwnersForIndexedNode');
        const deref = vi.spyOn(WeakRef.prototype, 'deref');
        try {
            mutations([{type: 'childList', target: document.body, addedNodes: [root], removedNodes: []} as unknown as MutationRecord]);
            console.info(JSON.stringify({metric: 'personal-correction-large-subtree-probe', changedElements: 50_001,
                containsCorrection, indexedProbes: indexed.mock.calls.length, ownerDereferences: deref.mock.calls.length}));
            expect(indexed).toHaveBeenCalledTimes(64);
            if (containsCorrection) expect(getTranslationState(correctedPair.owner)).toBeUndefined();
            else {expect(deref).toHaveBeenCalledTimes(1); expect(getTranslationState(correctedPair.owner)).toBe(correctedPair.state);}
            expect(corrections.lookup).not.toHaveBeenCalled();
        } finally {deref.mockRestore(); indexed.mockRestore(); controller.abort();}
    });

    it('三百个已登记校订单元只按批次检查当前根，不随四十个无关节点重复', () => {
        const main = document.querySelector('main')!;
        for (let index = 0; index < 300; index++) {
            const owner = document.createElement('p'); owner.textContent = `Translated paragraph ${index}.`;
            main.appendChild(owner);
            const attempt = beginTranslation(owner, 'bilingual')!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
            registerPersonalCorrectionResult(owner, attempt.state, {query: {source: owner.textContent,
                sourceLanguage: 'en', targetLanguage: 'zh-Hans', context: '', materialId: createMaterialId(location.href)}});
        }
        let mutations!: (records: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: typeof mutations) {mutations = callback;}
            observe() {} disconnect() {}
        });
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const deref = vi.spyOn(WeakRef.prototype, 'deref');
        try {
            mutations([{type: 'childList', target: document.body,
                addedNodes: Array.from({length: 40}, () => document.createElement('div')), removedNodes: []} as unknown as MutationRecord]);
            console.info(JSON.stringify({metric: 'personal-correction-dense-metadata', activeOwners: 300,
                metadataOwners: 300, changedElements: 40, ownerDereferences: deref.mock.calls.length}));
            expect(deref.mock.calls.length).toBe(300);
            expect(corrections.lookup).not.toHaveBeenCalled();
        } finally {deref.mockRestore(); controller.abort();}
    });

    it.each(['closed', 'open-to-closed', 'closed-to-closed', 'nested-open'] as const)('%s 根内既有个人译文随当前 host 移动失效', placement => {
        const {owner, state, sourceHTML} = corrected();
        const main = document.querySelector('main')!;
        const shadow = (mode: ShadowRootMode, parent: ParentNode = main) => {
            const host = document.createElement('x-reader'); parent.appendChild(host);
            const root = host.attachShadow({mode});
            // linkedom 隐藏 closed root，但未提供标准 mode 属性；补齐真实浏览器的只读字段。
            Object.defineProperty(root, 'mode', {value: mode});
            return {host, root};
        };
        if (placement === 'open-to-closed') shadow('open').root.appendChild(owner);
        if (placement === 'closed-to-closed') shadow('closed').root.appendChild(owner);
        const target = shadow('closed');
        if (placement === 'nested-open') shadow('open', target.root).root.appendChild(owner);
        else target.root.appendChild(owner);
        if (placement === 'closed') registerPersonalCorrectionResult(owner, state, {query: {source: 'The team is ready.',
            sourceLanguage: 'en', targetLanguage: 'zh-Hans', context: 'Team', materialId: createMaterialId(location.href)}, recordId: 'saved'});
        let mutations!: (records: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: typeof mutations) {mutations = callback;}
            observe() {} disconnect() {}
        });
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const record = (element: Element) => [{type: 'childList', target: main, addedNodes: [element], removedNodes: []}] as unknown as MutationRecord[];
        mutations(record(document.createElement('div')));
        expect(getTranslationState(owner)).toBe(state);
        mutations(record(target.host));
        expect(getTranslationState(owner)).toBeUndefined(); expect(owner.innerHTML).toBe(sourceHTML);
        expect(corrections.lookup).not.toHaveBeenCalled(); controller.abort();
    });

    it('持续翻译、状态替换与恢复不积累弱引用壳，自有DOM短路也即时注销', () => {
        let mutations!: (records: MutationRecord[]) => void;
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: typeof mutations) {mutations = callback;}
            observe() {} disconnect() {}
        });
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        const main = document.querySelector('main')!;
        const owned = document.createElement('span'); owned.setAttribute('data-fr-translation-owned', 'true');
        for (let index = 0; index < 200; index++) {
            const owner = document.createElement('p'); owner.textContent = 'Temporary translation.'; main.appendChild(owner);
            const first = beginTranslation(owner, 'bilingual')!;
            const snapshot = {query: {source: owner.textContent, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
                context: '', materialId: createMaterialId(location.href)}};
            registerPersonalCorrectionResult(owner, first.state, snapshot);
            markTranslationComplete(owner, first.state, first.generation, false);
            const replacement = beginTranslation(owner, 'bilingual')!;
            registerPersonalCorrectionResult(owner, replacement.state, snapshot);
            restoreTranslation(owner); owner.remove();
            mutations([{type: 'childList', target: owned, addedNodes: [], removedNodes: []} as unknown as MutationRecord]);
        }
        const deref = vi.spyOn(WeakRef.prototype, 'deref');
        try {
            mutations([{type: 'childList', target: main, addedNodes: [document.createElement('div')], removedNodes: []} as unknown as MutationRecord]);
            expect(deref).not.toHaveBeenCalled();
            expect(corrections.lookup).not.toHaveBeenCalled();
        } finally {deref.mockRestore(); controller.abort();}
    });

    it.each([true, false])('仅译文期间关闭个人校订，底稿存在=%s，恢复双语不重放旧记忆', baseline => {
        const {owner, state, sourceHTML, nodes} = corrected(baseline);
        config.personalCorrectionsEnabled = false; disableVisiblePersonalCorrections();
        expect(corrections.lookup).not.toHaveBeenCalled();
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        if (baseline) {
            expect(state.mode).toBe('single');
            expect(owner.querySelector('.fluent-read-single-slot')!.getAttribute('aria-label')).toBe('译文1。');
            expect(syncTranslationDisplayMode(owner, state, 1)).toBe(true);
            expect(state.bilingualContent!.textContent).toBe('译文1。');
            expect(state.bilingualContent!.hasAttribute('data-fr-personal-correction')).toBe(false);
            expect(restoreTranslation(owner)).toBe(true);
        } else expect(getTranslationState(owner)).toBeUndefined();
        expect(owner.innerHTML).toBe(sourceHTML);
    });

    it.each([false, true])('仅译文记忆更新与删除原位重绘；显式模式覆盖=%s始终保留', async explicit => {
        const {owner, state, nodes, translations} = corrected();
        state.bilingualReplay!.displayModeOverridden = explicit || undefined;
        const controller = state.controller, generation = state.generation;
        corrections.lookup.mockResolvedValueOnce({exact: {id: 'updated', translation: '更新后的个人译文。'}});
        await refreshVisiblePersonalCorrections();
        expect(owner.querySelector('.fluent-read-single-slot')!.getAttribute('aria-label')).toBe('更新后的个人译文。');
        expect(state.mode).toBe('single'); expect(state.bilingualReplay!.displayModeOverridden).toBe(explicit || undefined);
        await refreshVisiblePersonalCorrections();
        expect(owner.querySelector('.fluent-read-single-slot')!.getAttribute('aria-label')).toBe(translations[0]);
        expect(state.bilingualReplay!.personalCorrectionId).toBeUndefined();
        expect(state.controller).toBe(controller); expect(state.generation).toBe(generation);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        expect(syncTranslationDisplayMode(owner, state, 1)).toBe(!explicit);
        expect(owner.textContent).not.toContain('个人译文');
        expect(corrections.lookup).toHaveBeenCalledTimes(2);
        expect(restoreTranslation(owner)).toBe(true); expect(owner.firstChild).toBe(nodes[0]);
    });

    it('仅译文复用记忆删除且无服务底稿时恢复原文，不保留可重放个人结果', async () => {
        const {owner, nodes, sourceHTML} = corrected(false);
        await refreshVisiblePersonalCorrections();
        expect(getTranslationState(owner)).toBeUndefined();
        syncPageTranslationDisplayMode(1);
        expect(owner.innerHTML).toBe(sourceHTML); expect(owner.firstChild).toBe(nodes[0]);
    });

    it.each(['heading', 'route', 'move'] as const)('仅译文期间%s使个人校订语境失效，恢复后切回双语也无旧结果', async reason => {
        const {owner, nodes, heading, sourceHTML} = corrected();
        const section = document.createElement('section'); section.innerHTML = '<h2>Another team</h2>';
        document.querySelector('main')!.appendChild(section);
        const controller = new AbortController(); watchPersonalCorrectionContext(controller.signal);
        if (reason === 'heading') {
            heading.textContent = 'Another team'; invalidateStalePersonalCorrectionContexts();
        }
        else if (reason === 'route') {
            vi.stubGlobal('location', {href: 'https://example.com/another'});
            document.dispatchEvent(new window.Event('fluentread-route-change'));
        } else section.appendChild(owner);
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();
        expect(getTranslationState(owner)).toBeUndefined(); syncPageTranslationDisplayMode(1);
        expect(owner.innerHTML).toBe(sourceHTML); expect(owner.firstChild).toBe(nodes[0]);
        expect(corrections.lookup).not.toHaveBeenCalled();
    });

    it.each(['single', 'bilingual'] as const)('当前%s重绘沿用显式模式覆盖；保护Google与原文节点', mode => {
        const {owner, state, nodes} = committed(mode, {displayModeOverridden: true, ...(mode === 'bilingual' ? {service: 'google'} : {})});
        state.bilingualReplay!.translations = ['新译文。', '更新。'];
        expect(refreshTranslationPresentation(owner, state)).toBe(true);
        expect(state.mode).toBe(mode); expect(state.bilingualReplay!.displayModeOverridden).toBe(true);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        if (mode === 'single') expect(owner.querySelector('.fluent-read-single-slot')!.getAttribute('aria-label')).toBe(' 新译文。 ');
        else expect(state.bilingualContent!.textContent).toContain('新译文。');
        expect(syncTranslationDisplayMode(owner, state, mode === 'single' ? 1 : 0)).toBe(false);
    });

    it('配置订阅闭包只在模式变化时同步，首次同值与其余配置回声不改写工件', () => {
        const {owner, state} = committed();
        const preferences = vi.fn(), sync = createPageTranslationDisplayModeSync({display: 1}, preferences), initial = state.bilingualContent;
        sync({display: 1}); expect(state.bilingualContent).toBe(initial);
        sync({display: 0}); const hosts = [...state.singleTextSlotHosts!];
        sync({display: 0}); expect(state.singleTextSlotHosts).toEqual(hosts);
        sync({display: 1}); expect(state.mode).toBe('bilingual'); expect(owner.contains(initial!)).toBe(false);
        expect(preferences).toHaveBeenCalledTimes(4);
        const cleanup = createPageTranslationDisplayModeSync({display: 1}, () => restoreTranslation(owner));
        cleanup({display: 0}); expect(getTranslationState(owner)).toBeUndefined();
    });
    it('上下顺序立即应用已完成的译文，并保留来源节点、请求身份和恢复能力', () => {
        const {owner, state, nodes, sourceHTML} = committed('bilingual', {translationBeforeOriginal: false});
        const controller = state.controller, generation = state.generation;
        const sync = createPageTranslationDisplayModeSync<{display: number; translationBeforeOriginal: boolean}>({display: 1, translationBeforeOriginal: false}, vi.fn());
        for (const before of [true, false, true]) {
            sync({display: 1, translationBeforeOriginal: before});
            expect(before ? owner.firstChild : owner.lastChild).toBe(state.bilingualContent);
            expect(state.bilingualReplay!.translationBeforeOriginal).toBe(before);
            expect(nodes.every(node => owner.contains(node))).toBe(true);
            expect(state.controller).toBe(controller); expect(state.generation).toBe(generation);
            expect(isTranslationArtifactCurrent(owner, state)).toBe(true);
            const content = state.bilingualContent;
            sync({display: 1, translationBeforeOriginal: before});
            expect(state.bilingualContent).toBe(content);
        }
        expect(restoreTranslation(owner)).toBe(true); expect(owner.innerHTML).toBe(sourceHTML);
    });
    it('仅译文下更改顺序不重建文本槽，恢复双语沿用新顺序', () => {
        const {owner, state, nodes} = committed('single', {translationBeforeOriginal: false});
        const slots = state.singleTextSlotHosts;
        expect(syncTranslationDisplayMode(owner, state, 0, false, true)).toBe(true);
        expect(state.singleTextSlotHosts).toBe(slots);
        expect(syncTranslationDisplayMode(owner, state, 1, false, true)).toBe(true);
        expect(owner.firstChild).toBe(state.bilingualContent);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
    });
    it.each(['google', 'explicit'] as const)('%s限制保留显示模式，同时允许上下顺序即时生效', restriction => {
        const {owner, state, nodes} = committed('bilingual', {translationBeforeOriginal: false,
            ...(restriction === 'google' ? {service: 'google'} : {displayModeOverridden: true})});
        expect(syncTranslationDisplayMode(owner, state, 0, false, true)).toBe(true);
        expect(state.mode).toBe('bilingual'); expect(owner.firstChild).toBe(state.bilingualContent);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        expect(syncTranslationDisplayMode(owner, state, 0, false, true)).toBe(false);
    });
    it('原文或翻译工件失效时不因顺序变化重放陈旧译文', () => {
        const {owner, state} = committed('bilingual', {translationBeforeOriginal: false});
        state.sourceTextNodes![0]!.data = 'Host changed this sentence.';
        const before = owner.innerHTML;
        expect(syncTranslationDisplayMode(owner, state, 1, false, true)).toBe(false);
        expect(owner.innerHTML).toBe(before); expect(state.bilingualReplay!.translationBeforeOriginal).toBe(false);
    });
    it.each(['bilingual', 'single'] as const)('从%s来回切换只重排工件，保留原文节点、链接语义、请求身份与恢复', mode => {
        const fixture = committed(mode);
        const {owner, state, nodes, sourceHTML} = fixture;
        const originalLink = nodes[1]!.parentElement!.closest('a')!, controller = state.controller, generation = state.generation;
        const first = mode === 'bilingual' ? 0 : 1, second = first === 0 ? 1 : 0;
        for (const display of [first, second, first, second]) {
            expect(syncTranslationDisplayMode(owner, state, display)).toBe(true);
            expect(getTranslationState(owner)).toBe(state);
            expect(state.controller).toBe(controller); expect(controller.signal.aborted).toBe(false);
            expect(state.generation).toBe(generation); expect(state.translationInvocationIdentity).toBe('frozen-identity');
            expect(statefulSourceAndTextSlotsAreCurrent(owner, state)).toBe(true);
            expect(isTranslationArtifactCurrent(owner, state)).toBe(true);
            expect(nodes.every(node => owner.contains(node))).toBe(true);
            expect(originalLink.getAttribute('href')).toBe('https://example.com/before');
            if (display === 0) {
                expect(owner.querySelector('.fluent-read-bilingual-content')).toBeNull();
                expect([...owner.querySelectorAll('.fluent-read-single-slot')].map(host => host.getAttribute('aria-label')))
                    .toEqual([' 译文1。 ', '译文2。']);
                expect(owner.querySelector('code')!.textContent).toBe('protected()');
            } else {
                expect(owner.firstChild).toBe(state.bilingualContent);
                expect(state.bilingualContent!.textContent).toContain('译文1。');
                expect(owner.querySelector('.fluent-read-single-slot')).toBeNull();
            }
        }
        expect(restoreTranslation(owner)).toBe(true);
        expect(owner.innerHTML).toBe(sourceHTML); expect(owner.querySelector('a')).toBe(originalLink);
    });

    it('仅译文转双语使用当前安全链接属性与冻结译文选项，随后恢复仍保留宿主修改', () => {
        const {owner, state} = committed('single', {longParagraphLineBreak: true, personalCorrectionId: 'saved'});
        const link = owner.querySelector('a')!; link.setAttribute('href', 'https://example.com/after');
        expect(syncTranslationDisplayMode(owner, state, 1)).toBe(true);
        expect(state.bilingualContent!.querySelector('a')!.getAttribute('href')).toBe('https://example.com/after');
        expect(state.bilingualContent!.getAttribute('data-fr-personal-correction')).toBe('true');
        expect(restoreTranslation(owner)).toBe(true);
        expect(link.getAttribute('href')).toBe('https://example.com/after');
    });

    it.each([
        ['immediate', false], ['late-replay', false], ['immediate', true], ['late-replay', true],
    ] as const)('安全href/title更新通过%s重放后仍能切换目标模式，合成段=%s，无需再次访问provider', (path, synthetic) => {
        const {owner, state, nodes} = committed('bilingual', {}, undefined, synthetic);
        const controller = state.controller, generation = state.generation;
        const neighbor = document.createElement('p'); neighbor.textContent = 'Untranslated neighbor.';
        owner.after(neighbor);
        const original = state.sourceTextNodes![1]!.parentElement!;
        original.setAttribute('href', 'https://example.com/current'); original.setAttribute('title', 'Current');
        config.display = 0;
        expect(path === 'immediate' ? syncTranslationDisplayMode(owner, state, 0) : refreshTranslationDisplayMode(owner, state)).toBe(true);
        expect(state.mode).toBe('single');
        expect(syncTranslationDisplayMode(owner, state, 1)).toBe(true);
        expect(state.bilingualContent!.querySelector('a')!.getAttribute('href')).toBe('https://example.com/current');
        expect(state.bilingualContent!.querySelector('a')!.getAttribute('title')).toBe('Current');
        expect(state.controller).toBe(controller); expect(state.generation).toBe(generation);
        expect(nodes.every(node => owner.contains(node))).toBe(true);
        expect(neighbor.textContent).toBe('Untranslated neighbor.');
    });

    it('真实来源变化使迟到骨架重放失败，保留宿主文本与原生命周期', () => {
        const {owner, state} = committed();
        state.sourceTextNodes![0]!.data = 'A new host sentence.';
        config.display = 0;
        expect(refreshTranslationDisplayMode(owner, state)).toBe(false);
        expect(state.mode).toBe('bilingual'); expect(owner.textContent).toContain('A new host sentence.');
    });

    it('合成行内段在切换和恢复后仍按原顺序解包，不残留扩展节点', () => {
        const {owner, state, nodes} = committed('bilingual', {translationBeforeOriginal: false}, 'First sentence.', true);
        const parent = owner.parentNode!;
        expect(syncTranslationDisplayMode(owner, state, 0)).toBe(true);
        expect(syncTranslationDisplayMode(owner, state, 1)).toBe(true);
        expect(owner.lastChild).toBe(state.bilingualContent);
        expect(restoreTranslation(owner)).toBe(true);
        expect(owner.parentNode).toBeNull(); expect(parent.firstChild).toBe(nodes[0]);
        expect((parent as Element).querySelector('[data-fr-translation-owned]')).toBeNull();
    });

    it('全页同步涵盖开放ShadowRoot内现有工件，跳过失败与未完成请求', () => {
        const first = committed();
        const second = committed('single');
        const host = document.createElement('section'); document.body.appendChild(host);
        host.attachShadow({mode: 'open'}).appendChild(second.owner);
        const pending = committed(); pending.state.phase = 'loading';
        const failed = committed(); failed.state.phase = 'error';
        syncPageTranslationDisplayMode(0);
        expect(first.state.mode).toBe('single'); expect(second.state.mode).toBe('single');
        syncPageTranslationDisplayMode(1);
        expect(second.state.mode).toBe('bilingual'); expect(pending.state.mode).toBe('bilingual');
        expect(failed.state.mode).toBe('bilingual');
    });

    it.each(['detached', 'control', 'loading', 'missing-replay', 'explicit', 'google', 'same-mode', 'source-edited',
        'artifact-removed', 'source-count', 'translation-count', 'source-mismatch'] as const)('拒绝%s时保留当前工件，不写入过期译文', reason => {
        const {owner, state} = committed();
        let display = 0;
        switch (reason) {
            case 'detached': owner.remove(); break;
            case 'control': state.kind = 'control'; break;
            case 'loading': state.phase = 'loading'; break;
            case 'missing-replay': state.bilingualReplay = undefined; break;
            case 'explicit': state.bilingualReplay!.displayModeOverridden = true; break;
            case 'google': state.bilingualReplay!.service = 'google'; break;
            case 'same-mode': display = 1; break;
            case 'source-edited': state.sourceTextNodes![0]!.data = 'Host changed source.'; break;
            case 'artifact-removed': state.bilingualContent!.remove(); break;
            case 'source-count': state.bilingualReplay!.sources = []; break;
            case 'translation-count': state.bilingualReplay!.translations = []; break;
            case 'source-mismatch': state.bilingualReplay!.sources = ['Different.', 'Read details.']; break;
        }
        const html = owner.innerHTML;
        expect(syncTranslationDisplayMode(owner, state, display)).toBe(false);
        expect(owner.innerHTML).toBe(html);
        expect(state.mode).toBe('bilingual');
    });
});
