import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';

import {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createDeclarativeAdapter,
    createTranslationCore,
    createTranslationSourceSnapshot,
    extractTranslationText,
    extractTranslationTextFromNodes,
    findTranslationTruncationAncestors,
    getCurrentTranslationCore,
    getOpenShadowRoots,
    hasActiveTranslationLineClamp,
    isClearlyTargetLanguage,
    isMeaningfulTranslationText,
    parseTranslationSlots,
    removeTranslationTruncation,
    selectPreferredTranslationCandidate,
    serializeTranslationSlots,
    TranslationCandidateCore,
    resolveTranslationCandidate,
    resolveTranslationCandidateAtPoint,
} from '@/src/core/translation/public';
import {
    evaluateHardGuard,
    findElementsAtPoint,
    findNodeAtPoint,
    hasHiddenMarker,
    isExtensionElement,
    maxComposedAncestorDepth,
    safeClosest,
    safeMatches,
} from '@/src/core/translation/dom';
import {
    classifyGenericCandidate,
    getDirectInlineRuns,
    hasStructuralAncestor,
    hasDirectReadableText,
    isBlockBoundary,
    isStructuralContainer,
} from '@/src/core/translation/layout';
import {
    hasMeaningfulTranslationTextInNodes,
    isTranslationTextNodeProtected,
} from '@/src/core/translation/text';
import {
    findAdapterPrunedAncestor,
    inheritCachedFlag,
    partitionInlineRunAtBarriers,
    readCachedFlagOr,
} from '@/src/core/translation/internal';
import {defaultTranslationAdapters} from '@/src/core/translation/registry';
const bilibiliAdapter = defaultTranslationAdapters.find(adapter => adapter.id === 'bilibili')!;
const redditAdapter = defaultTranslationAdapters.find(adapter => adapter.id === 'reddit')!;

function page(html: string, url = 'https://example.test/article') {
    const {document} = parseHTML(`<html><head></head><body>${html}</body></html>`);
    const core = createTranslationCore({url: new URL(url)});
    return {document, core};
}

function candidateIds(document: Document, url?: string): string[] {
    const core = createTranslationCore({url: new URL(url ?? 'https://example.test/article')});
    return core.discover(document).map((candidate) => candidate.element.id).filter(Boolean);
}

describe('translation candidate core', () => {
    it('只放行 text/plain 文档的顶层 pre，HTML 页面中的 pre 仍保持保护', () => {
        const htmlPage = page('<pre id="html-pre">const value = 1;</pre>');
        expect(htmlPage.core.discover(htmlPage.document).map((candidate) => candidate.element.id))
            .not.toContain('html-pre');

        const plainPage = page('<pre id="plain-pre">First line\nSecond line</pre>');
        Object.defineProperty(plainPage.document, 'contentType', {
            configurable: true,
            value: 'text/plain',
        });
        const plainPre = plainPage.document.querySelector('#plain-pre')!;

        expect(plainPage.core.discover(plainPage.document)).toEqual([
            expect.objectContaining({
                element: plainPre,
                kind: 'content',
                reason: 'generic-readable-block',
            }),
        ]);
        expect(extractTranslationText(plainPre)).toBe('First line Second line');
    });

    it('图标字体连字不会混入全文、悬浮和富文本请求，恢复时保留原始图标', () => {
        const {document, core} = page('<p id="prose">Open <span id="icon">settings</span> to continue.</p><p id="standalone">keyboard_return</p>');
        const view = document.defaultView!;
        const descriptor = Object.getOwnPropertyDescriptor(view, 'getComputedStyle');
        let iconFamily = '';
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: element.tagName === 'P' ? 'block' : 'inline',
                fontFamily: ['icon', 'standalone'].includes(element.id) ? iconFamily : 'Arial',
            }),
        });
        try {
            const prose = document.querySelector('#prose') as HTMLElement;
                const icon = document.querySelector('#icon') as HTMLElement;
            for (const family of [
                'Google Symbols', '"Material Icons"', "'Material Icons Outlined'",
                'Material Symbols Rounded, sans-serif', 'FontAwesome', 'Font Awesome 6 Free',
            ]) {
                iconFamily = family;
                expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual(['prose']);
                expect(core.resolve(icon)?.element).toBe(prose);
                expect(core.resolve(document.querySelector('#standalone'))).toBeNull();
                expect(hasHiddenMarker(icon)).toBe(false);
                expect(extractTranslationText(prose)).toBe('Open to continue.');
                const snapshot = createTranslationSourceSnapshot(prose);
                expect(snapshot.slots.map((slot) => slot.source)).toEqual(['Open', 'to continue.']);
                const translated = applyTranslationsToSnapshot(snapshot, ['打开', '以继续。']);
                expect(translated).not.toContain('settings');
                expect(translated).toContain('打开');
                expect(icon.textContent).toBe('settings');
            }
            for (const family of ['Arial, "Material Symbols Rounded"', 'Arial']) {
                iconFamily = family;
                expect(extractTranslationText(prose)).toBe('Open settings to continue.');
                expect(core.resolve(icon)?.element).toBe(prose);
            }
            iconFamily = 'Material IconsCustom';
            expect(extractTranslationText(prose)).toBe('Open settings to continue.');
            icon.hidden = true;
            expect(hasHiddenMarker(icon)).toBe(true);
        } finally {
            if (descriptor) Object.defineProperty(view, 'getComputedStyle', descriptor);
            else Reflect.deleteProperty(view, 'getComputedStyle');
        }
    });

    it('保留 engine 自身的祖先深度防线，并缓存实际检查过的祖先', () => {
        const ancestors = ['parent', 'grandparent', 'too-deep'];

        expect(findAdapterPrunedAncestor(
            ancestors,
            2,
            () => ({decision: {kind: 'pass'}}),
        )).toEqual({
            result: {reason: 'ancestor-depth-limit'},
            inspected: ['parent', 'grandparent'],
        });
        expect(findAdapterPrunedAncestor(
            ancestors,
            4,
            (ancestor) => ancestor === 'grandparent'
                ? {decision: {kind: 'prune-subtree', reason: ''}, adapterId: 'bounded-adapter'}
                : {decision: {kind: 'pass'}},
        )).toEqual({
            result: {reason: 'adapter-pruned', adapterId: 'bounded-adapter'},
            inspected: ['parent', 'grandparent'],
        });
        expect(findAdapterPrunedAncestor(
            ancestors.slice(0, 1),
            2,
            () => ({decision: {kind: 'pass'}}),
        )).toEqual({result: null, inspected: ['parent']});
    });

    it('直接行内序列在独立候选边界处分段，并跳过连续或首尾边界', () => {
        const barrier = Symbol('barrier');

        expect(partitionInlineRunAtBarriers(
            [barrier, 'before', barrier, barrier, 'after', barrier],
            (node) => node === barrier,
        )).toEqual([['before'], ['after']]);
        expect(partitionInlineRunAtBarriers([], () => false)).toEqual([]);
    });

    it('engine 本轮布尔缓存支持祖先继承，并只在缺失时执行后备计算', () => {
        const parent = {};
        const child = {};
        const flags = new WeakMap<object, boolean>([[parent, true], [child, false]]);
        const fallback = vi.fn(() => true);

        expect(inheritCachedFlag(parent, flags)).toBe(true);
        expect(inheritCachedFlag(child, flags)).toBe(false);
        expect(inheritCachedFlag(null, flags)).toBe(false);
        expect(readCachedFlagOr(flags, child, fallback)).toBe(false);
        expect(fallback).not.toHaveBeenCalled();
        expect(readCachedFlagOr(flags, {}, fallback)).toBe(true);
        expect(fallback).toHaveBeenCalledOnce();
    });

    it('keeps inline links and emphasis inside one paragraph candidate', () => {
        const {document, core} = page(`
            <main><p id="prose">Read <a id="link">the guide</a> with <strong>care</strong>.</p></main>
        `);
        const prose = document.querySelector('#prose')!;
        const link = document.querySelector('#link')!;

        expect(core.discover(document).map((item) => item.element)).toEqual([prose]);
        expect(core.resolve(link)?.element).toBe(prose);
    });

    it('uses the same candidate for full discovery and hover resolution', () => {
        const {document, core} = page('<main><section><p id="target"><span id="hit">A complete sentence to translate.</span></p></section></main>');
        const full = core.discover(document).find((item) => item.element.id === 'target');
        const hover = core.resolve(document.querySelector('#hit'));

        expect(full).toBeDefined();
        expect(hover?.element).toBe(full?.element);
        expect(hover?.kind).toBe(full?.kind);
    });

    it('reclassifies a candidate when its interactive role changes', () => {
        const {document, core} = page('<main><p id="target">A complete sentence to translate.</p></main>');
        const target = document.querySelector('#target')!;

        expect(core.inspect(target).candidate?.kind).toBe('content');
        target.setAttribute('role', 'button');
        expect(core.inspect(target).candidate?.kind).toBe('control');
    });

    it('does not duplicate parent containers around paragraph children', () => {
        const ids = candidateIds(parseHTML(`
            <html><body><article id="article"><div id="wrapper">
                <p id="first">First readable paragraph.</p>
                <p id="second">Second readable paragraph.</p>
            </div></article></body></html>
        `).document);

        expect(ids).toEqual(['first', 'second']);
    });

    it('segments direct inline runs around block children for full and hover', () => {
        const {document, core} = page(`
            <main><div id="mixed">Intro <strong>text</strong>
                <p id="child">Child paragraph.</p>
                Tail <em>text</em>
            </div></main>
        `);
        const mixed = document.querySelector('#mixed')!;
        const child = document.querySelector('#child')!;
        const intro = Array.from(mixed.childNodes).find((node) => node.textContent?.includes('Intro'))!;
        const tail = Array.from(mixed.childNodes).find((node) => node.textContent?.includes('Tail'))!;
        const candidates = core.discover(document);
        const runs = candidates.filter((candidate) => candidate.element === mixed && candidate.nodes);

        expect(candidates.map((candidate) => candidate.element)).toContain(child);
        expect(runs).toHaveLength(2);
        expect(runs.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()))
            .toEqual(['Intro text', 'Tail text']);
        expect(core.resolve(intro)?.nodes).toEqual(runs[0]?.nodes);
        expect(core.resolve(tail)?.nodes).toEqual(runs[1]?.nodes);
    });

    it('keeps an inline-styled semantic paragraph out of a parent run', () => {
        const {document, core} = page(`
            <main><div id="mixed">
                <p id="semantic-leaf" style="display:inline">A semantic paragraph kept in place.</p>
                <ul><li>A separate block child.</li></ul>
            </div></main>
        `);
        const paragraph = document.querySelector('#semantic-leaf')!;
        const candidates = core.discover(document);

        expect(candidates.find((candidate) => candidate.element === paragraph)).toBeDefined();
        expect(candidates.some((candidate) => candidate.nodes?.includes(paragraph as ChildNode))).toBe(false);
    });

    it('keeps an inline direct-child subtree out of an ancestor run when its descendant owns a candidate', () => {
        const {document, core} = page(`
            <main><div id="theorem">
                <h6 id="definition">Definition 2.4.</h6>
                <div id="paragraph-shell"><p id="statement">
                    A bounded operator has a unique continuous extension.
                </p></div>
            </div></main>
        `);
        const view = document.defaultView!;
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: ['paragraph-shell', 'statement'].includes(element.id)
                    ? 'inline'
                    : ['MAIN', 'DIV', 'H6'].includes(element.tagName) ? 'block' : 'inline',
            }),
        });
        const theorem = document.querySelector('#theorem')!;
        const paragraphShell = document.querySelector('#paragraph-shell')!;
        const statement = document.querySelector('#statement')!;
        const candidates = core.discover(document);

        expect(candidates.find((candidate) => candidate.element === statement)).toBeDefined();
        expect(candidates.some((candidate) => candidate.element === theorem &&
            candidate.nodes?.some((node) => node === paragraphShell ||
                (node.nodeType === 1 && (node as Element).contains(statement))))).toBe(false);
        expect(candidates.map((candidate) => candidate.element.id)).toEqual(['definition', 'statement']);
    });

    it('resolves parent direct text to the same run that full discovery splits around a candidate subtree', () => {
        const {document, core} = page(`
            <main><div id="theorem">
                <h6 id="definition">Definition 2.4.</h6>
                Context before
                <div id="paragraph-shell"><p id="statement">
                    A bounded operator has a unique continuous extension.
                </p></div>
                Context after
            </div></main>
        `);
        const view = document.defaultView!;
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: ['paragraph-shell', 'statement', 'added-shell', 'added-statement'].includes(element.id)
                    ? 'inline'
                    : ['MAIN', 'DIV', 'H6'].includes(element.tagName) ? 'block' : 'inline',
            }),
        });
        const theorem = document.querySelector('#theorem')!;
        const paragraphShell = document.querySelector('#paragraph-shell')!;
        const statement = document.querySelector('#statement')!;
        const contextBefore = Array.from(theorem.childNodes).find((node) =>
            node.nodeType === 3 && node.textContent?.includes('Context before'))!;
        const contextAfter = Array.from(theorem.childNodes).find((node) =>
            node.nodeType === 3 && node.textContent?.includes('Context after'))!;
        const parentHoverBeforeDiscovery = core.resolve(contextBefore);
        const childHoverBeforeDiscovery = core.resolve(statement.firstChild);
        const fullRuns = core.discover(document).filter((candidate) =>
            candidate.element === theorem && candidate.nodes);
        const parentHoverBefore = core.resolve(contextBefore);
        const parentHoverAfter = core.resolve(contextAfter);

        expect(fullRuns.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()))
            .toEqual(['Context before', 'Context after']);
        expect(parentHoverBeforeDiscovery?.nodes).toEqual(fullRuns[0]?.nodes);
        expect(parentHoverBeforeDiscovery?.nodes).not.toContain(paragraphShell);
        expect(childHoverBeforeDiscovery)
            .toMatchObject({element: statement, reason: 'generic-readable-block'});
        expect(parentHoverBefore).toMatchObject({element: theorem, reason: 'generic-inline-run'});
        expect(parentHoverBefore?.nodes).toEqual(fullRuns[0]?.nodes);
        expect(parentHoverAfter?.nodes).toEqual(fullRuns[1]?.nodes);
        expect(parentHoverBefore?.nodes).not.toContain(paragraphShell);

        const addedShell = document.createElement('div');
        addedShell.id = 'added-shell';
        const addedStatement = document.createElement('p');
        addedStatement.id = 'added-statement';
        addedStatement.textContent = 'A dynamically inserted statement remains independently translatable.';
        addedShell.append(addedStatement);
        theorem.append(addedShell);

        const parentHoverAfterMutation = core.resolve(contextAfter);
        expect(parentHoverAfterMutation?.nodes).toEqual(fullRuns[1]?.nodes);
        expect(parentHoverAfterMutation?.nodes).not.toContain(addedShell);
    });

    it('revalidates stale child barriers before resolving a mutated inline run', () => {
        const {document, core} = page(`
            <main><div id="parent">
                Before
                <span id="changed-shell"><p id="changed-candidate">
                    The first nested paragraph starts as its own candidate.
                </p></span>
                Middle
                <span id="live-shell"><p id="live-candidate">
                    The second nested paragraph remains independently translatable.
                </p></span>
                After
            </div></main>
        `);
        const view = document.defaultView!;
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: element.tagName === 'SPAN' ? 'inline' : 'block',
            }),
        });
        const parent = document.querySelector('#parent')!;
        const changedShell = document.querySelector('#changed-shell')!;
        const liveShell = document.querySelector('#live-shell')!;
        const liveCandidate = document.querySelector('#live-candidate')!;

        expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual([
            'changed-candidate',
            'live-candidate',
            'parent',
            'parent',
            'parent',
        ]);

        changedShell.textContent = 'The first subtree is now ordinary inline prose.';
        const changedText = changedShell.firstChild!;
        const hover = core.resolve(changedText);

        expect(hover).toMatchObject({element: parent, reason: 'generic-inline-run'});
        expect(hover?.nodes).toContain(changedShell);
        expect(hover?.nodes).not.toContain(liveShell);
        expect(
            hover?.nodes?.some((node) => node.nodeType === 1 && (node as Element).contains(liveCandidate)),
            'The refreshed parent run must not overlap the still-live descendant candidate',
        ).toBe(false);

        const dirtyCandidates = core.discover(parent);
        const dirtyRun = dirtyCandidates.find((candidate) =>
            candidate.element === parent && candidate.nodes?.includes(changedShell));
        expect(dirtyCandidates.find((candidate) => candidate.element === liveCandidate)).toBeDefined();
        expect(dirtyRun).toMatchObject({element: parent, reason: 'generic-inline-run'});
        expect(dirtyRun?.nodes).toEqual(hover?.nodes);
        expect(core.resolve(changedText)?.nodes).toEqual(dirtyRun?.nodes);
    });

    it('bounds the hover-only candidate-subtree probe before conservatively splitting a run', () => {
        const nested = `${'<span>'.repeat(600)}Deep inline text${'</span>'.repeat(600)}`;
        const {document} = parseHTML(`<html><body><main><div id="parent">
            Direct parent text <span id="deep-wrapper">${nested}</span>
        </div></main></body></html>`);
        let decisions = 0;
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [{
                id: 'hover-budget',
                matches: () => true,
                decide: () => {
                    decisions += 1;
                    return {kind: 'pass'} as const;
                },
            }],
        });
        const parent = document.querySelector('#parent')!;
        const wrapper = document.querySelector('#deep-wrapper')!;
        const directText = Array.from(parent.childNodes).find((node) =>
            node.nodeType === 3 && node.textContent?.includes('Direct parent text'))!;
        const candidate = core.resolve(directText);

        expect(candidate).toMatchObject({element: parent, reason: 'generic-inline-run'});
        expect(candidate?.nodes).toEqual([directText]);
        expect(candidate?.nodes).not.toContain(wrapper);
        expect(decisions).toBeLessThan(400);
    });

    it.each(['main', 'article', 'section', 'div'])('never reparents display:contents <%s> regions', (tag) => {
        const {document, core} = page(`
            <div id="layout">Parent before
                <${tag} id="semantic" style="display:contents">
                    Semantic before <strong id="direct">direct text</strong>
                    <p id="child">Nested paragraph.</p>
                    Semantic after
                </${tag}>
                Parent after <p id="sibling">Sibling paragraph.</p>
            </div>
        `);
        const view = document.defaultView!;
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: element.getAttribute('style')?.includes('display:contents') ? 'contents' :
                    ['P', 'DIV'].includes(element.tagName) ? 'block' : 'inline',
            }),
        });
        const semantic = document.querySelector('#semantic')!;
        const child = document.querySelector('#child')!;
        const direct = document.querySelector('#direct')!;
        const layout = document.querySelector('#layout')!;
        const candidates = core.discover(document);
        const semanticRuns = candidates.filter((candidate) => candidate.element === semantic && candidate.nodes);
        const layoutRuns = candidates.filter((candidate) => candidate.element === layout && candidate.nodes);

        expect(candidates.some((candidate) => candidate.nodes?.includes(semantic as ChildNode))).toBe(false);
        expect(candidates.find((candidate) => candidate.element === child)).toBeDefined();
        expect(layoutRuns.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()))
            .toEqual(['Parent before', 'Parent after']);
        expect(semanticRuns).toHaveLength(2);
        expect(semanticRuns.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()))
            .toEqual(['Semantic before direct text', 'Semantic after']);
        expect(core.resolve(direct)?.nodes).toEqual(semanticRuns[0]?.nodes);
        expect(core.resolve(child)?.element).toBe(child);
    });

    it('offers lazy discovery steps with the same candidates as synchronous discovery', () => {
        const {document} = parseHTML(`<html><body><main>${Array.from({length: 200}, (_, index) =>
            `<p id="p-${index}">Readable paragraph number ${index} for incremental discovery.</p>`).join('')}</main></body></html>`);
        let decisions = 0;
        const countingAdapter = {
            id: 'counting',
            matches: () => true,
            decide: () => {
                decisions += 1;
                return {kind: 'pass'} as const;
            },
        };
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [countingAdapter],
        });
        const steps = core.discoverSteps(document);
        const first = steps.next();

        expect(first.done).toBe(false);
        expect(decisions).toBeLessThan(100);

        const incremental = [first.value, ...steps]
            .flatMap((step) => step?.candidate ? [step.candidate.element.id] : []);
        expect(incremental).toEqual(core.discover(document).map((candidate) => candidate.element.id));
        expect(incremental).toHaveLength(200);
    });

    it('bounds one readability probe on an extremely wide subtree', () => {
        const {document} = parseHTML(`<html><body><div id="wide">${
            Array.from({length: 5_000}, () => '<span></span>').join('')
        }</div></body></html>`);
        const wide = document.querySelector('#wide')!;
        let inspectedElements = 0;

        expect(hasMeaningfulTranslationTextInNodes([wide], () => {
            inspectedElements += 1;
            return false;
        })).toBe(false);
        expect(inspectedElements).toBeLessThanOrEqual(2_100);
    });

    it('conservatively prunes adversarial ancestor depth without climbing the entire tree', () => {
        const {document} = parseHTML('<html><body><main id="root"></main></body></html>');
        const root = document.querySelector('#root')!;
        let parent = root;
        for (let index = 0; index < maxComposedAncestorDepth + 100; index += 1) {
            const child = document.createElement('div');
            parent.appendChild(child);
            parent = child;
        }
        parent.textContent = 'Readable text at an adversarial depth.';
        let adapterDecisions = 0;
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [{
                id: 'depth-short-circuit',
                matches: () => true,
                decide: () => {
                    adapterDecisions += 1;
                    return {kind: 'pass'} as const;
                },
            }],
        });

        expect(evaluateHardGuard(parent)).toMatchObject({
            prune: true,
            reason: 'ancestor-depth-limit',
        });
        expect(core.resolve(parent.firstChild)).toBeNull();
        expect(adapterDecisions).toBe(0);
    });

    it('shares text ancestor protection across one adversarially deep discovery', () => {
        const {document} = parseHTML('<html><body><main id="root"></main></body></html>');
        const depth = maxComposedAncestorDepth + 100;
        let parent = document.querySelector('#root')!;
        for (let index = 0; index < depth; index += 1) {
            const child = document.createElement('div');
            parent.appendChild(child);
            parent = child;
        }
        parent.textContent = 'Readable text beyond the conservative depth limit.';
        let protectionChecks = 0;
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [{
                id: 'protection-counter',
                matches: () => true,
                decide: () => ({kind: 'pass'}),
                shouldStayOriginal: () => {
                    protectionChecks += 1;
                    return false;
                },
            }],
        });

        expect(core.discover(document)).toEqual([]);
        expect(protectionChecks).toBeLessThan(depth * 4);
    });

    it('shares hover guard and adapter ancestry across one deep candidate miss', () => {
        const depth = 450;
        const {document} = parseHTML('<html><body><header id="root"></header></body></html>');
        const view = document.defaultView!;
        const originalStyleDescriptor = Object.getOwnPropertyDescriptor(view, 'getComputedStyle');
        let styleChecks = 0;
        Object.defineProperty(view, 'getComputedStyle', {
            configurable: true,
            value: () => {
                styleChecks += 1;
                return {display: 'inline', visibility: 'visible'};
            },
        });

        let parent = document.querySelector('#root')!;
        for (let index = 0; index < depth; index += 1) {
            const child = document.createElement('span');
            parent.appendChild(child);
            parent = child;
        }
        parent.textContent = 'x';

        let adapterDecisions = 0;
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [{
                id: 'hover-ancestry-counter',
                matches: () => true,
                decide: () => {
                    adapterDecisions += 1;
                    return {kind: 'pass'} as const;
                },
            }],
        });

        try {
            expect(core.resolve(parent.firstChild)).toBeNull();
        } finally {
            if (originalStyleDescriptor) {
                Object.defineProperty(view, 'getComputedStyle', originalStyleDescriptor);
            } else {
                Reflect.deleteProperty(view, 'getComputedStyle');
            }
        }
        expect(adapterDecisions).toBeLessThanOrEqual(depth + 3);
        expect(styleChecks).toBeLessThanOrEqual(depth * 2 + 6);
    });

    it('does not climb from structural chrome into an app-shell container', () => {
        const {document, core} = page(`
            <main id="app-shell"><header><p id="page-description">A header description.</p></header>
            <section><p id="article-copy">Actual article prose.</p></section></main>
        `);

        expect(core.resolve(document.querySelector('#page-description'))).toBeNull();
        expect(core.resolve(document.querySelector('#article-copy'))?.element.id).toBe('article-copy');
        expect(core.discover(document).map((item) => item.element.id)).toEqual(['article-copy']);
    });

    it('inherits translate=no and contenteditable hard guards', () => {
        const ids = candidateIds(parseHTML(`
            <html><body><main>
                <section translate="no"><p id="no-translate">Do not translate this sentence.</p></section>
                <div contenteditable="true"><p id="editor">Editable sentence.</p></div>
                <p id="allowed">Translate this ordinary sentence.</p>
            </main></body></html>
        `).document);

        expect(ids).toEqual(['allowed']);
    });

    it('keeps full-page discovery strict while allowing explicit translation through a body-level app shell', () => {
        const {document, core} = page(`
            <div id="app" class="notranslate">
                <main><article><p id="content">Readable application content.</p>
                    <div class="notranslate"><p id="protected">Protected local content.</p></div>
                </article></main>
            </div>
        `);
        const content = document.querySelector('#content') as HTMLElement;
        const source = content.firstChild;
        if (!source) throw new Error('hover fixture text is missing');

        expect(core.discover(document)).toEqual([]);
        expect(core.inspect(content).candidate).toBeNull();
        expect(core.resolve(document.querySelector('#app'))).toBeNull();
        expect(core.resolve(source)).toMatchObject({
            element: content,
            kind: 'content',
            allowTopLevelApplicationShell: true,
        });
        expect(extractTranslationText(
            content,
            core.shouldStayOriginal,
            undefined,
            {allowTopLevelApplicationShell: true, protectedElement: content},
        )).toBe('Readable application content.');

        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => content,
        });
        expect(core.resolveAtPoint(document, 1, 2)).toMatchObject({
            element: content,
            allowTopLevelApplicationShell: true,
        });

        const local = document.querySelector('#protected') as HTMLElement;
        expect(core.resolve(local.firstChild)).toBeNull();

        const {document: nestedDocument, core: nestedCore} = page(`
            <div id="outer">
                <div class="notranslate"><p id="nested">Nested protected content.</p></div>
            </div>
        `);
        expect(nestedCore.resolve(nestedDocument.querySelector('#nested')?.firstChild)).toBeNull();
    });

    it('preserves inline code/no-translate text without rejecting the outer prose', () => {
        const {document, core} = page(`
            <main><p id="issue-127">Set <code class="notranslate">xxx</code> to enable the feature safely.</p></main>
        `);
        const paragraph = document.querySelector('#issue-127')!;

        expect(core.discover(document).map((item) => item.element)).toContain(paragraph);
        expect(extractTranslationText(paragraph, core.shouldStayOriginal)).toBe('Set to enable the feature safely.');
        expect(core.resolve(document.querySelector('code'))?.element).toBe(paragraph);
    });

    it('保护 Scribble 的 Racket 代码表格并保留相邻正文和普通表格', () => {
        const {document, core} = page(`
            <main><p id="before">These definitions describe the program.</p>
                <table id="code" class="RktBlk"><tbody><tr><td id="code-line">
                    <span class="RktPn">(</span><span class="RktSym">define-type</span>
                    <span class="RktSym">MisspelledAnimal</span><span class="RktPn">)</span>
                </td></tr></tbody></table>
                <table id="ordinary"><tbody><tr><td id="ordinary-cell">Animal description in ordinary prose.</td></tr></tbody></table>
                <div id="similar" class="RktBlk">This ordinary block shares a class name.</div>
                <p id="after">The explanation continues after the example.</p>
            </main>
        `, 'https://cs.brown.edu/courses/cs173/2012/book/Introduction.html');
        const code = document.querySelector<HTMLElement>('#code')!;
        const source = code.outerHTML;
        const originalNodes = [...code.querySelectorAll('*')];
        for (let pass = 0; pass < 2; pass += 1) {
            const candidates = core.discover(document);
            expect(candidates.some((candidate) => candidate.element === code || code.contains(candidate.element)))
                .toBe(false);
            expect(core.resolve(document.querySelector('#code-line .RktSym')!.firstChild)).toBeNull();
            expect(createTranslationSourceSnapshot(code, core.shouldStayOriginal).slots).toHaveLength(0);
            const ids = candidates.map((candidate) => candidate.element.id);
            expect(ids).toEqual(expect.arrayContaining(['before', 'ordinary-cell', 'similar', 'after']));
            expect(code.outerHTML).toBe(source);
            expect([...code.querySelectorAll('*')]).toEqual(originalNodes);
        }
        code.querySelector('td')!.append(' New code token');
        expect(core.discover(code)).toEqual([]);
        expect(createTranslationSourceSnapshot(code, core.shouldStayOriginal).slots).toHaveLength(0);
    });

    it('保护 Ubuntu manpage 命令语法和任意命令名称，同时翻译解释正文', () => {
        const {document, core} = page(`
            <div id="main-content"><h1 id="command-title">apt</h1></div>
            <main><div id="manpage-content">
                <h2 id="synopsis" class="Sh">SYNOPSIS</h2>
                <section id="syntax" class="Sh mp-section"><p class="Pp HP"><b>apt</b> [<b>--help</b>] [<i>future_option</i>]</p></section>
                <h2 id="description" class="Sh">DESCRIPTION</h2>
                <section id="body" class="Sh mp-section">
                    <p id="intro" class="Pp"><b>apt</b> provides a package management interface.</p>
                    <p id="command-label" class="Pp"><b>future-command-2027</b> (<a href="tool.8.html"><b>tool</b>(8)</a>)</p>
                    <div id="explanation" class="Bd-indent">Download package information with <b>future-command-2027</b> for <i>package_name</i>.</div>
                    <p id="ordinary" class="Pp">An ordinary paragraph uses the word update naturally.</p>
                </section>
            </div></main>
            <p id="outside">Ordinary <b>bold emphasis</b> remains natural prose.</p>
        `, 'https://manpages.ubuntu.com/manpages/noble/man8/apt.8.html');
        const regions = ['command-title', 'syntax', 'command-label'].map((id) => document.getElementById(id)!);
        const originalHTML = regions.map((node) => node.outerHTML);
        const originalNodes = regions.map((node) => [...node.childNodes]);
        const candidates = core.discover(document);
        expect(candidates.map(({element}) => element.id)).toEqual(expect.arrayContaining(['intro', 'explanation', 'ordinary', 'outside']));
        for (const region of regions) {
            expect(candidates.some(({element}) => element === region || region.contains(element))).toBe(false);
            expect(core.resolve(region.firstChild)).toBeNull();
            expect(core.shouldIgnoreMutation(region)).toBe(true);
            expect(createTranslationSourceSnapshot(region, core.shouldStayOriginal).slots).toEqual([]);
        }
        const intro = document.getElementById('intro')!;
        expect(core.resolve(intro.querySelector('b')!.firstChild)?.element).toBe(intro);
        const introSnapshot = createTranslationSourceSnapshot(intro, core.shouldStayOriginal);
        expect(introSnapshot.slots.map(({source}) => source)).toEqual(['provides a package management interface.']);
        expect(applyTranslationsToSnapshot(introSnapshot, ['提供软件包管理界面。'])).toContain('<b>apt</b>');
        const explanationSnapshot = createTranslationSourceSnapshot(document.getElementById('explanation')!, core.shouldStayOriginal);
        expect(explanationSnapshot.slots.map(({source}) => source).join(' ')).not.toContain('package_name');
        expect(applyTranslationsToSnapshot(explanationSnapshot, explanationSnapshot.slots.map(() => '说明')))
            .toContain('<i>package_name</i>');
        expect(createTranslationSourceSnapshot(document.getElementById('outside')!, core.shouldStayOriginal).slots
            .map(({source}) => source)).toContain('bold emphasis');
        const bodySnapshot = createTranslationSourceSnapshot(document.getElementById('manpage-content')!,
            core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(bodySnapshot.slots.map(({source}) => source).join(' ')).not.toMatch(/future-command-2027|future_option|--help/u);
        expect(bodySnapshot.clone.querySelector('#syntax')).toBeNull();
        expect(bodySnapshot.clone.querySelector('#command-label')).toBeNull();
        expect(regions.map((node) => node.outerHTML)).toEqual(originalHTML);
        expect(regions.map((node) => [...node.childNodes])).toEqual(originalNodes);
        document.getElementById('body')!.insertAdjacentHTML('beforeend',
            '<p id="late-command" class="Pp"><b>unknown-operation</b></p><div id="late-explanation" class="Bd-indent">This operation explains a future capability.</div>');
        expect(core.discover(document).map(({element}) => element.id)).toContain('late-explanation');
        expect(core.resolve(document.getElementById('late-command')!.firstChild)).toBeNull();
    });

    it.each(['dpkg-query\n  --list', 'future-tool --unknown-option -q'])('按字面标记保留命令选项组合 %s 的 DOM 和译文，不发送给服务', (literal) => {
        const {document, core} = page(`<div id="manpage-content"><section class="Sh"><p id="body">Inspect packages with <b id="literal">${literal}</b> before continuing.</p></section></div>`,
            'https://manpages.ubuntu.com/manpages/noble/man8/apt.8.html');
        const body = document.getElementById('body')!;
        const command = document.getElementById('literal')!;
        const original = command.outerHTML;
        const snapshot = createTranslationSourceSnapshot(body, core.shouldStayOriginal);
        expect(snapshot.slots.map(({source}) => source)).toEqual(['Inspect packages with', 'before continuing.']);
        expect(core.shouldStayOriginal(command)).toBe(true);
        expect(core.shouldOmitFromTranslation(command)).toBe(false);
        const translated = applyTranslationsToSnapshot(snapshot, ['检查软件包，使用', '再继续。']);
        expect(translated).toContain(original);
        expect(command.outerHTML).toBe(original);
        expect(command.textContent).toBe(literal);
        expect(core.resolve(command.firstChild)?.element).toBe(body);
    });

    it('不因紧邻缩进块而剪掉普通说明、前置原文或带命令名的完整句子', () => {
        const introductions = [
            'The following example shows how to configure this command.',
            'Run <b>future-command</b> to continue.',
            '<b>apt</b> provides a package management interface.',
            '<b>apt</b> <a href="guide.html">provides a package management interface</a>.',
            '<span>Ordinary introduction</span>',
            '<b>This is an ordinary quoted explanation.</b>',
            '<i>这些内容是正常的中文说明。</i>',
            '<b>apt</b> <b>provides a package management interface.</b>',
            '<b>apt</b> <i>这是命令的说明文字。</i>',
            '<b>Run the command with --help for additional details.</b>',
            '<b>dpkg-query lists the installed packages.</b>',
        ];
        for (const introduction of introductions) {
            const {document, core} = page(`<div id="manpage-content"><h2 id="description">DESCRIPTION</h2><section class="Sh"><p id="intro" class="Pp">${introduction}</p><div class="Bd-indent"><b>future-command</b> --dry-run</div></section></div>`,
                'https://manpages.ubuntu.com/manpages/noble/man1/future-command.1.html');
            const intro = document.getElementById('intro')!;
            expect(core.shouldStayOriginal(intro)).toBe(false);
            expect(core.shouldOmitFromTranslation(intro)).toBe(false);
            expect(core.shouldIgnoreMutation(intro)).toBe(false);
            expect(core.discover(document).some(({element}) => element === intro), introduction).toBe(true);
            expect(createTranslationSourceSnapshot(intro, core.shouldStayOriginal).slots.length).toBeGreaterThan(0);
        }
    });

    it('仅把平衡括号的命令附注当作标签，并忽略已有扩展副本', () => {
        const labels: Array<[string, boolean]> = [
            ['<b>edit-sources</b> (work-in-progress)', true],
            ['<b>showsrc, depends</b> (summarised in <a href="apt-cache.8.html"><b>apt-cache</b>(8)</a>)', true],
            ['<b>showsrc, depends</b> (summarised in <i>the relevant manual</i>)', true],
            ['<b>future-command</b> (支持中文附注)', true],
            ['<!-- a host comment --> <i>future_option</i>', true],
            ['<b>unknown-operation</b><span data-fr-translation-owned="true">旧译文</span>', true],
            ['<b>unknown-operation</b> (unfinished note', false],
            ['<b>unknown-operation</b> )', false],
            ['<!-- empty placeholder --> ', false],
            ['<b></b>', false],
        ];
        for (const [labelHTML, protectedLabel] of labels) {
            const {document, core} = page(`<div id="manpage-content"><h2 id="description">DESCRIPTION</h2><section class="Sh"><p id="label" class="Pp">${labelHTML}</p><div class="Bd-indent">An explanation of the operation.</div></section></div>`,
                'https://manpages.ubuntu.com/manpages/noble/man8/apt.8.html');
            const label = document.getElementById('label')!;
            expect(core.shouldStayOriginal(label), labelHTML).toBe(protectedLabel);
            expect(core.shouldOmitFromTranslation(label), labelHTML).toBe(protectedLabel);
            expect(core.shouldIgnoreMutation(label), labelHTML).toBe(protectedLabel);
        }
    });

    it('不把 Ubuntu manpage 的命令规则扩散到其他站点或非手册路径', () => {
        const html = '<div id="manpage-content"><h2 id="description">Description</h2><section class="Sh"><p id="label" class="Pp"><b>unknown-command</b></p><div class="Bd-indent">A regular explanation.</div></section></div>';
        for (const url of ['https://example.test/manpages/noble/man8/apt.8.html',
            'https://manpages.ubuntu.com.example.test/manpages/noble/man8/apt.8.html',
            'https://example.manpages.ubuntu.com/manpages/noble/man8/apt.8.html',
            'https://manpages.ubuntu.com/help']) {
            const {document, core} = page(html, url);
            expect(core.shouldStayOriginal(document.getElementById('label')!)).toBe(false);
            expect(core.discover(document).map(({element}) => element.id)).toContain('label');
        }
        const {document, core} = page(html, 'https://manpages.ubuntu.com/manpages/noble/en/man8/apt.8.html');
        expect(core.shouldStayOriginal(document.getElementById('label')!)).toBe(true);
    });

    it('keeps MathJax and KaTeX render trees atomic while translating surrounding prose', () => {
        const {document, core} = page(`
            <main><p id="prose">
                Projection prose remains translatable.
                <span id="preview" class="MathJax_Preview">FORMULA_PREVIEW</span>
                <span id="display" class="MathJax_Display" role="math">
                    <span id="mathjax" class="MathJax"><span id="glyph">out=(x/w,y/w,z/w)</span></span>
                </span>
                <script id="tex-source" type="math/tex; mode=display">out = \\begin{pmatrix} x/w \\ y/w \\ z/w \\end{pmatrix}</script>
                <mjx-container id="mathjax-v3"><span>V_clip=M_projection V_local</span></mjx-container>
                <span id="katex" class="katex"><span>KATEX_RENDERED_FORMULA</span></span>
                The explanation continues.
            </p></main>
        `);
        const prose = document.querySelector('#prose') as HTMLElement;
        const protectedNodes = [
            document.querySelector('#preview')!,
            document.querySelector('#display')!,
            document.querySelector('#mathjax')!,
            document.querySelector('#mathjax-v3')!,
            document.querySelector('#katex')!,
            document.querySelector('#tex-source')!,
        ];
        const originalParents = protectedNodes.map((node) => node.parentNode);
        const candidates = core.discover(document);
        const full = candidates.find((candidate) => candidate.element === prose);

        expect(full).toBeDefined();
        expect(full?.nodes).toBeUndefined();
        expect(candidates.filter((candidate) => protectedNodes.includes(candidate.element))).toEqual([]);
        expect(core.resolve(document.querySelector('#glyph'))?.element).toBe(prose);
        expect(evaluateHardGuard(document.querySelector('#glyph')!).reason).toBe('math-renderer');
        expect(evaluateHardGuard(document.querySelector('#mathjax-v3 span')!).reason).toBe('math-renderer');
        expect(evaluateHardGuard(document.querySelector('#katex span')!).reason).toBe('math-renderer');
        expect(evaluateHardGuard(document.querySelector('#tex-source')!).reason).toBe('protected-tag:script');

        const readable = extractTranslationText(prose, core.shouldStayOriginal).replace(/\s+/gu, ' ').trim();
        const liveSlots = collectLiveTranslationTextSlots(prose, core.shouldStayOriginal);
        const snapshot = createTranslationSourceSnapshot(prose, core.shouldStayOriginal);
        const payload = snapshot.slots.map((slot) => slot.source).join(' ');

        expect(readable).toBe('Projection prose remains translatable. The explanation continues.');
        expect(liveSlots.map((slot) => slot.source).join(' ')).not.toMatch(
            /FORMULA_PREVIEW|out=|begin\{pmatrix\}|V_clip|KATEX_RENDERED_FORMULA/u,
        );
        expect(payload).not.toMatch(/FORMULA_PREVIEW|out=|begin\{pmatrix\}|V_clip|KATEX_RENDERED_FORMULA/u);

        const rendered = applyTranslationsToSnapshot(
            snapshot,
            snapshot.slots.map((slot) => `译:${slot.source}`),
        );
        const {document: renderedDocument} = parseHTML(`<html><body><p>${rendered}</p></body></html>`);
        expect(renderedDocument.querySelector('#display')?.textContent).toContain('out=(x/w,y/w,z/w)');
        expect(renderedDocument.querySelector('#tex-source')?.textContent).toContain('begin{pmatrix}');
        expect(renderedDocument.querySelector('#mathjax-v3')?.textContent).toBe('V_clip=M_projection V_local');
        expect(renderedDocument.querySelector('#katex')?.textContent).toBe('KATEX_RENDERED_FORMULA');

        // 快照和渲染只操作克隆：实时公式 renderer 的身份与父节点保持不变，
        // 以支持恢复和第二轮翻译。
        expect(protectedNodes.map((node) => document.getElementById(node.id))).toEqual(protectedNodes);
        expect(protectedNodes.map((node) => node.parentNode)).toEqual(originalParents);
        expect(core.discover(document).find((candidate) => candidate.element === prose)?.nodes).toBeUndefined();
    });

    it('keeps every nested opt-out subtree out of provider text slots', () => {
        const {document, core} = page(`
            <main><p id="target">Translate this
                <span translate="no">API_SECRET</span>
                <span data-notranslate="true">TOKEN</span>
                <span hidden>HIDDEN_TEXT</span>
                <span contenteditable="true">DRAFT_TEXT</span>
                <code>npm publish --token SECRET</code>
                <a href="/original">linked prose</a>
            </p></main>
        `);
        const target = document.querySelector('#target') as HTMLElement;
        const text = extractTranslationText(target, core.shouldStayOriginal);
        const snapshot = createTranslationSourceSnapshot(target, core.shouldStayOriginal);
        const providerPayload = snapshot.slots.map((slot) => slot.source).join('|');

        expect(text).toContain('Translate this');
        expect(text).toContain('linked prose');
        expect(text).not.toMatch(/API_SECRET|TOKEN|HIDDEN_TEXT|DRAFT_TEXT|npm publish|SECRET/u);
        expect(providerPayload).not.toMatch(/API_SECRET|TOKEN|HIDDEN_TEXT|DRAFT_TEXT|npm publish|SECRET|original/u);

        const rendered = applyTranslationsToSnapshot(
            snapshot,
            snapshot.slots.map((slot) => `译:${slot.source}`),
        );
        const {document: renderedDocument} = parseHTML(`<html><body><p>${rendered}</p></body></html>`);
        expect(renderedDocument.querySelector('code')?.textContent).toBe('npm publish --token SECRET');
        expect(renderedDocument.querySelector('a')?.getAttribute('href')).toBe('/original');
    });

    it('can re-evaluate a synthetic owner without disabling descendant safety guards', () => {
        const {document, core} = page(`
            <span id="synthetic" data-fr-translation-segment="true">
                Visible source
                <span hidden>HIDDEN_TEXT</span>
                <span translate="no">PROTECTED_TEXT</span>
            </span>
        `);
        const synthetic = document.querySelector('#synthetic') as HTMLElement;

        expect(collectLiveTranslationTextSlots(synthetic, core.shouldStayOriginal)).toEqual([]);
        const slots = collectLiveTranslationTextSlots(
            synthetic,
            core.shouldStayOriginal,
            synthetic,
        );

        expect(slots.map((slot) => slot.source)).toEqual(['Visible source']);
        expect(extractTranslationText(synthetic, core.shouldStayOriginal, synthetic)).toBe('Visible source');
    });

    it('applies provider slots to a fresh safe snapshot so current link attributes win', () => {
        const {document, core} = page(`
            <p id="target">Read <a href="/a">the current guide</a>.</p>
        `);
        const target = document.querySelector('#target') as HTMLElement;
        const initial = createTranslationSourceSnapshot(target, core.shouldStayOriginal);
        const sources = initial.slots.map((slot) => slot.source);

        target.querySelector('a')!.setAttribute('href', '/b');
        const fresh = createTranslationSourceSnapshot(target, core.shouldStayOriginal);
        const rendered = applyTranslationsToSnapshot(
            fresh,
            sources.map((source) => `译:${source}`),
        );
        const {document: renderedDocument} = parseHTML(`<html><body>${rendered}</body></html>`);

        expect(fresh.slots.map((slot) => slot.source)).toEqual(sources);
        expect(renderedDocument.querySelector('a')?.getAttribute('href')).toBe('/b');
    });

    it('evaluates provider slots against live external ancestors before cloning', () => {
        const {document} = parseHTML(`
            <html><body><div class="private"><p id="target">Translate this
                <span class="secret">EXTERNAL_SECRET</span> safely.</p></div></body></html>
        `);
        const adapter = createDeclarativeAdapter({
            id: 'external-private-boundary',
            hosts: ['example.test'],
            keepOriginal: [{selector: '.private .secret', reason: 'private'}],
        });
        const core = createTranslationCore({url: new URL('https://example.test'), adapters: [adapter]});
        const snapshot = createTranslationSourceSnapshot(
            document.querySelector('#target') as HTMLElement,
            core.shouldStayOriginal,
        );

        expect(snapshot.slots.map((slot) => slot.source).join('|')).not.toContain('EXTERNAL_SECRET');
        expect(snapshot.clone.querySelector('.secret')?.textContent).toBe('EXTERNAL_SECRET');
    });

    it('round-trips several text slots through one strict provider packet', () => {
        const packet = serializeTranslationSlots(['Click ', 'here', ' to continue.'], 'test_nonce');
        const translated = packet.starts.map((start, index) =>
            `${start}${['点击', '这里', '以继续。'][index]}${packet.ends[index]}`).join('\n');

        expect(parseTranslationSlots(packet, translated)).toEqual(['点击', '这里', '以继续。']);
        expect(parseTranslationSlots(packet, `Provider note\n${translated}`)).toBeNull();
        expect(parseTranslationSlots({...packet, ends: packet.ends.slice(1)}, translated)).toBeNull();
        expect(parseTranslationSlots(
            {payload: packet.payload, starts: ['', packet.starts[1]!, packet.starts[2]!], ends: packet.ends},
            translated,
        )).toBeNull();
        expect(serializeTranslationSlots([
            '___FLUENTREAD_test_nonce_0_BEGIN___ collision',
        ], 'test_nonce').starts[0]).toBe('___FLUENTREAD_test_nonce_1_0_BEGIN___');
        expect(serializeTranslationSlots(['Plain text'], '!!!').starts[0])
            .toBe('___FLUENTREAD_slots_0_BEGIN___');
    });

    it('keeps snapshot serialization bounded to live readable slots', () => {
        const {document, core} = page(`
            <main><p id="target">
                Leading source
                <span class="fluent-read-loading">Loading state</span>
                <span data-fr-translation-owned="true">Owned output</span>
                <span translate="no">Do not translate</span>
                trailing source
            </p></main>
        `);
        const target = document.querySelector('#target') as HTMLElement;
        const originalCreateTreeWalker = document.createTreeWalker;
        const snapshot = createTranslationSourceSnapshot(target, core.shouldStayOriginal);
        const rendered = applyTranslationsToSnapshot(snapshot, ['译:leading']);
        const truncationHost = document.createElement('section');
        const clamped = document.createElement('div');
        const leaf = document.createElement('p');
        const styleCalls: string[] = [];
        const getComputedStyle = vi.spyOn(document.defaultView!, 'getComputedStyle').mockImplementation(
            (element: Element) => ({
                webkitLineClamp: element === clamped ? '2' : '',
                getPropertyValue: (property: string) =>
                    element === clamped && property === '-webkit-line-clamp' ? '2' : '',
            }) as CSSStyleDeclaration,
        );

        expect(snapshot.slots.map((slot) => slot.source)).toEqual(['Leading source', 'trailing source']);
        expect(snapshot.clone.querySelector('.fluent-read-loading')).toBeNull();
        expect(snapshot.clone.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
        expect(rendered).toContain('译:leading');
        expect(rendered).toContain('trailing source');
        expect(rendered).toContain('Do not translate');

        Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value: undefined,
        });
        try {
            expect(collectLiveTranslationTextSlots(target, core.shouldStayOriginal)).toEqual([]);
            expect(createTranslationSourceSnapshot(target, core.shouldStayOriginal).slots).toEqual([]);
        } finally {
            Object.defineProperty(document, 'createTreeWalker', {
                configurable: true,
                value: originalCreateTreeWalker,
            });
        }

        truncationHost.append(clamped);
        clamped.append(leaf);
        document.body.append(truncationHost);
        clamped.style.setProperty('-webkit-line-clamp', '2');
        expect(hasActiveTranslationLineClamp(clamped)).toBe(true);
        expect(findTranslationTruncationAncestors(
            leaf,
            (element) => element === truncationHost,
        )).toEqual([clamped, truncationHost]);

        removeTranslationTruncation(clamped);
        for (const property of ['-webkit-line-clamp', 'line-clamp', 'max-height']) {
            styleCalls.push(`${property}:${clamped.style.getPropertyValue(property)}`);
        }
        expect(styleCalls).toEqual([
            '-webkit-line-clamp:unset',
            'line-clamp:unset',
            'max-height:unset',
        ]);
        getComputedStyle.mockRestore();
    });

    it('discovers readable content in an open shadow root', () => {
        const {document, core} = page('<main><article-card id="host"></article-card></main>');
        const host = document.querySelector('#host')!;
        const shadowRoot = host.attachShadow({mode: 'open'});
        shadowRoot.innerHTML = '<section><p id="shadow-prose">A sentence rendered by a web component.</p></section>';

        expect(core.discover(document).map((item) => item.element.id)).toContain('shadow-prose');
        expect(core.resolve(shadowRoot.querySelector('#shadow-prose'))?.element.id).toBe('shadow-prose');
    });

    it('prunes Bilibili comments across nested Shadow DOM without hiding page prose', () => {
        const {document, core} = page(`
            <main>
                <bili-comments id="comments"></bili-comments>
                <p id="page-prose">The surrounding video page remains translatable.</p>
            </main>
        `, 'https://www.bilibili.com/video/BV1ux4y1e73x/');
        const comments = document.querySelector('#comments')!;
        const commentsShadow = comments.attachShadow({mode: 'open'});
        const thread = document.createElement('bili-comment-thread-renderer');
        commentsShadow.append(thread);
        const threadShadow = thread.attachShadow({mode: 'open'});
        const renderer = document.createElement('bili-comment-renderer');
        threadShadow.append(renderer);
        const rendererShadow = renderer.attachShadow({mode: 'open'});
        const richText = document.createElement('bili-rich-text');
        rendererShadow.append(richText);
        const richTextShadow = richText.attachShadow({mode: 'open'});
        const commentText = document.createElement('p');
        commentText.id = 'comment-prose';
        commentText.textContent = 'A Bilibili comment that must remain owned by the site.';
        richTextShadow.append(commentText);

        expect(bilibiliAdapter.matches(new URL('https://www.bilibili.com/video/BV1ux4y1e73x/'))).toBe(true);
        expect(bilibiliAdapter.matches(new URL('https://example.test/video'))).toBe(false);
        expect(core.discover(document).map((candidate) => candidate.element.id)).toContain('page-prose');
        expect(core.discover(document).some((candidate) => candidate.element === commentText)).toBe(false);
        expect(core.resolve(commentText.firstChild)).toBeNull();

        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => comments,
        });
        Object.defineProperty(commentsShadow, 'elementFromPoint', {
            configurable: true,
            value: () => thread,
        });
        Object.defineProperty(threadShadow, 'elementFromPoint', {
            configurable: true,
            value: () => renderer,
        });
        Object.defineProperty(rendererShadow, 'elementFromPoint', {
            configurable: true,
            value: () => richText,
        });
        Object.defineProperty(richTextShadow, 'elementFromPoint', {
            configurable: true,
            value: () => commentText,
        });
        expect(core.resolveAtPoint(document, 10, 20)).toBeNull();
    });

    it('limits Reddit to explicit post/comment targets and preserves navigation actions', () => {
        const {document, core} = page(`
            <header id="reddit-header">
                <button id="open-menu" aria-label="Open menu">Open menu</button>
                <a id="reddit-home" href="/">Go to Reddit Home</a>
                <a id="community" href="/r/MiniMax_AI">r/MiniMax_AI</a>
                <button id="open-chat">Open chat</button>
                <button id="create-post">Create</button>
                <button id="open-inbox">Open inbox</button>
                <span id="advertise">Advertise on Reddit</span>
            </header>
            <main>
                <shreddit-post id="post">
                    <h1 id="post-title-t3_fixture">M3.1 has strong potential to be the most cost-efficient large model ahead</h1>
                    <div slot="text-body">
                        <p id="post-body">I have gone through the technical specifications and want to share my analysis here.</p>
                        <ul><li id="post-list-item">The model uses sparse attention.</li></ul>
                    </div>
                    <div id="post-actions">
                        <button id="share">Share</button>
                        <button id="reply">Reply</button>
                    </div>
                </shreddit-post>
                <shreddit-comment id="comment-host">
                    <div slot="comment"><p id="comment-body">This is a useful comment.</p></div>
                    <button id="comment-reply">Reply</button>
                </shreddit-comment>
                <p id="unscoped-copy">Open profile menu</p>
            </main>
        `, 'https://www.reddit.com/r/MiniMax_AI/comments/1v73a0r/m31_has_strong_potential_to_be_the_most/');
        const title = document.querySelector('#post-title-t3_fixture')!;
        const body = document.querySelector('#post-body')!;
        const listItem = document.querySelector('#post-list-item')!;
        const comment = document.querySelector('#comment-body')!;
        const controls = ['open-menu', 'open-chat', 'create-post', 'open-inbox', 'share', 'reply', 'comment-reply']
            .map((id) => document.querySelector(`#${id}`)!);

        expect(redditAdapter.matches(new URL('https://www.reddit.com/r/MiniMax_AI/comments/1'))).toBe(true);
        expect(redditAdapter.matches(new URL('https://example.test/article'))).toBe(false);

        const candidates = core.discover(document);
        expect(candidates.find((candidate) => candidate.element === title))
            .toMatchObject({adapterId: 'reddit', reason: 'reddit-post-title'});
        expect(candidates.find((candidate) => candidate.element === body))
            .toMatchObject({adapterId: 'reddit', reason: 'reddit-post-prose'});
        expect(candidates.find((candidate) => candidate.element === listItem))
            .toMatchObject({adapterId: 'reddit', reason: 'reddit-post-prose'});
        expect(candidates.find((candidate) => candidate.element === comment))
            .toMatchObject({adapterId: 'reddit', reason: 'reddit-comment-prose'});
        expect(candidates.some((candidate) => candidate.adapterId !== 'reddit')).toBe(false);

        for (const control of controls) {
            expect(core.resolve(control.firstChild)).toBeNull();
            expect(core.shouldStayOriginal(control)).toBe(true);
            expect(core.shouldIgnoreMutation(control)).toBe(true);
        }
        expect(core.resolve(document.querySelector('#reddit-home')?.firstChild)).toBeNull();
        expect(core.resolve(document.querySelector('#community')?.firstChild)).toBeNull();
        expect(core.resolve(document.querySelector('#advertise')?.firstChild)).toBeNull();
        expect(core.resolve(document.querySelector('#unscoped-copy')?.firstChild)).toBeNull();
    });

    it('bounds cyclic Shadow DOM coordinate lookup without overflowing the call stack', () => {
        const {document, core} = page('<main><article-card id="host"></article-card></main>');
        const host = document.querySelector('#host')!;
        const shadowRoot = host.attachShadow({mode: 'open'});

        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => host,
        });
        Object.defineProperty(shadowRoot, 'elementFromPoint', {
            configurable: true,
            value: () => host,
        });

        expect(() => core.resolveAtPoint(document, 10, 20)).not.toThrow();
        expect(core.resolveAtPoint(document, 10, 20)).toBeNull();
    });

    it('translates GitHub PR titles instead of pruning repository-content', () => {
        const {document, core} = page(`
            <main id="repo-content-pjax-container" class="repository-content">
                <div role="group" aria-label="Issues">
                    <a id="pr-title" class="markdown-title" data-hovercard-type="pull_request">
                        Fix quick search during full page translation
                    </a>
                </div>
            </main>
        `, 'https://github.com/FluentRead/FluentRead/pulls');
        const title = document.querySelector('#pr-title')!;
        const candidate = core.discover(document).find((item) => item.element === title);

        expect(candidate).toMatchObject({adapterId: 'github', reason: 'github-markdown-title'});
        expect(core.resolve(title)?.element).toBe(title);
    });

    it('保护 GitHub 仓库列表的任意技术标签和受控元数据，正文相同词仍可翻译', () => {
        const {document, core} = page(`
            <main><ul><li id="repository">
                <div data-listview-item-title-container="true"><h3><a href="/example/compiler">Compiler</a></h3>
                    <span id="visibility" data-listview-item-visibility-label="true">Public</span></div>
                <div id="description" class="repos-list-description">Java and Python support the new QuasarLang2027 compiler. Public APIs remain useful.</div>
                <div id="topics" class="ReposListItem-module__TopicsList__fixture">
                    <a href="/search?q=topic%3Ajava"><span>Java</span></a>
                    <a href="/search?q=topic%3Apython"><span>Python</span></a>
                    <a href="/topics/quasarlang2027"><span>QuasarLang2027</span></a>
                </div>
                <div id="metadata" class="ReposListItem-module__LabelsContainer__fixture">
                    <div class="ReposListItem-module__LanguageLabelContainer__fixture"><span class="ReposListItem-module__PrimaryLanguageName__fixture">Go</span></div>
                    <span>Apache License 2.0</span><a href="/example/compiler/forks">14k forks</a>
                </div>
            </li></ul>
            <article class="markdown-body"><p id="prose">Learn <a href="/topics/java">Java</a> and <a href="/topics/python">Python</a> through public examples.</p></article>
            <div id="generic-topic-class" class="TopicsList">Java and Python are discussed here.</div>
            </main>
        `, 'https://github.com/orgs/example/repositories');
        const protectedRegions = ['visibility', 'topics', 'metadata'].map((id) => document.getElementById(id)!);
        const originals = protectedRegions.map((region) => region.outerHTML);
        const originalNodes = protectedRegions.map((region) => [...region.childNodes]);
        const candidates = core.discover(document);
        const snapshot = createTranslationSourceSnapshot(document.getElementById('repository')!,
            core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(({source}) => source))
            .toEqual(['Compiler', 'Java and Python support the new QuasarLang2027 compiler. Public APIs remain useful.']);
        for (const region of protectedRegions) {
            expect(candidates.some(({element}) => element === region || region.contains(element))).toBe(false);
            expect(core.shouldStayOriginal(region)).toBe(true);
            expect(core.shouldIgnoreMutation(region)).toBe(true);
            expect(core.resolve(region.querySelector('span')?.firstChild ?? region.firstChild)).toBeNull();
            expect(createTranslationSourceSnapshot(region, core.shouldStayOriginal).slots).toEqual([]);
        }
        const description = document.getElementById('description')!;
        expect(candidates.find(({element}) => element === description))
            .toMatchObject({adapterId: 'github', reason: 'github-repository-description'});
        const prose = document.getElementById('prose')!;
        expect(core.resolve(prose.querySelector('a')!.firstChild)?.element).toBe(prose);
        expect(createTranslationSourceSnapshot(prose, core.shouldStayOriginal).slots.map(({source}) => source))
            .toEqual(['Learn', 'Java', 'and', 'Python', 'through public examples.']);
        expect(candidates.some(({element}) => element.id === 'generic-topic-class')).toBe(true);
        const translatedHTML = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '正文译文'));
        for (const region of protectedRegions) {
            expect(snapshot.clone.querySelector(`#${region.id}`)).toBeNull();
            expect(translatedHTML).not.toContain(`id="${region.id}"`);
        }
        expect(translatedHTML).toContain('正文译文');
        expect(protectedRegions.map((region) => region.outerHTML)).toEqual(originals);
        expect(protectedRegions.map((region) => [...region.childNodes])).toEqual(originalNodes);
        document.getElementById('topics')!.insertAdjacentHTML('beforeend', '<a href="/topics/future-runtime"><span>Future Runtime</span></a>');
        expect(core.discover(document.getElementById('topics')!)).toEqual([]);
        expect(createTranslationSourceSnapshot(document.getElementById('topics')!, core.shouldStayOriginal).slots).toEqual([]);
    });

    it('keeps GitHub issue-list labels and metadata original while translating titles', () => {
        const {document, core} = page(`
            <main>
                <div class="IssueRow-module__row__fixture">
                    <li id="issue-row" role="listitem">
                        <div data-listview-item-title-container="true">
                            <h3>
                                <a id="issue-title" data-testid="issue-pr-title-link" href="/Eugeny/tabby/issues/10084">
                                    right click not working
                                </a>
                            </h3>
                            <span>
                                <div data-listview-component="trailing-badge">
                                    <a href="/Eugeny/tabby/issues?q=label%3A%22T%3A%20Bug%22">
                                        <span class="prc-Token-TokenBase-te5-F prc-Token-IssueLabel-2IazM">
                                            <span>T: Bug</span>
                                        </span>
                                    </a>
                                </div>
                            </span>
                        </div>
                        <div data-testid="list-row-repo-name-and-number">
                            <span>#10084 <span class="sr-only">In Eugeny/tabby;</span></span>
                        </div>
                        <div data-testid="created-at">
                            <span>· </span>
                            <a href="/kikyoulg">kikyoulg</a>
                            <span> opened </span>
                            <relative-time>on Dec 6, 2024</relative-time>
                        </div>
                    </li>
                </div>
            </main>
        `, 'https://github.com/Eugeny/tabby/issues?q=is%3Aissue%20state%3Aopen%20macos27');
        const title = document.querySelector('#issue-title')!;
        const label = document.querySelector('.prc-Token-IssueLabel-2IazM')!;
        const repoMetadata = document.querySelector('[data-testid="list-row-repo-name-and-number"]')!;
        const createdAt = document.querySelector('[data-testid="created-at"]')!;
        const candidates = core.discover(document);

        expect(candidates.find((candidate) => candidate.element === title))
            .toMatchObject({adapterId: 'github', reason: 'github-issue-or-pr-title'});
        expect(core.resolve(label.querySelector('span')?.firstChild)).toBeNull();
        expect(core.resolve(repoMetadata.querySelector('span')?.firstChild)).toBeNull();
        expect(core.resolve(createdAt.querySelector('a')?.firstChild)).toBeNull();
        expect(core.shouldStayOriginal(label)).toBe(true);
        expect(core.shouldStayOriginal(repoMetadata)).toBe(true);
        expect(core.shouldStayOriginal(createdAt)).toBe(true);
        expect(core.shouldIgnoreMutation(label)).toBe(true);
        expect(core.shouldIgnoreMutation(repoMetadata)).toBe(true);
        expect(core.shouldIgnoreMutation(createdAt)).toBe(true);
    });

    it('keeps GitHub issue-detail labels and activity metadata original while translating body prose', () => {
        const {document, core} = page(`
            <main>
                <h1>
                    <bdi id="detail-title" class="markdown-title" data-testid="issue-title">right click not working</bdi>
                </h1>
                <div data-testid="issue-body">
                    <div class="IssueBodyHeader-module__IssueBodyHeaderContainer__fixture">
                        <a data-testid="issue-body-header-author" href="/kikyoulg">kikyoulg</a>
                        <span>opened </span>
                        <a data-testid="issue-body-header-link" href="#issue-10084">
                            <relative-time>on Dec 6, 2024</relative-time>
                        </a>
                    </div>
                    <div data-testid="issue-body-viewer">
                        <div class="markdown-body" data-testid="markdown-body">
                            <p id="issue-body-copy">Paste or menu both not working.</p>
                        </div>
                    </div>
                </div>
                <div data-testid="sidebar-labels-section">
                    <h3>Labels</h3>
                    <div data-testid="issue-labels">
                        <a href="/Eugeny/tabby/issues?q=label%3A%22T%3A%20Bug%22">
                            <span class="prc-Token-TokenBase-te5-F prc-Token-IssueLabel-2IazM">
                                <span>T: Bug</span>
                            </span>
                        </a>
                    </div>
                </div>
            </main>
        `, 'https://github.com/Eugeny/tabby/issues/10084');
        const title = document.querySelector('#detail-title')!;
        const body = document.querySelector('#issue-body-copy')!;
        const activityHeader = document.querySelector('[class*="IssueBodyHeader-module__IssueBodyHeaderContainer"]')!;
        const labels = document.querySelector('[data-testid="issue-labels"]')!;
        const candidates = core.discover(document);

        expect(candidates.find((candidate) => candidate.element === title))
            .toMatchObject({adapterId: 'github'});
        expect(candidates.find((candidate) => candidate.element === body))
            .toMatchObject({adapterId: 'github', reason: 'github-markdown-prose'});
        expect(core.resolve(activityHeader.querySelector('a')?.firstChild)).toBeNull();
        expect(core.resolve(labels.querySelector('span')?.firstChild)).toBeNull();
        expect(core.shouldStayOriginal(activityHeader)).toBe(true);
        expect(core.shouldStayOriginal(labels)).toBe(true);
        expect(core.shouldIgnoreMutation(activityHeader)).toBe(true);
        expect(core.shouldIgnoreMutation(labels)).toBe(true);
    });

    it('keeps X usernames out of full and hover translation candidates', () => {
        const {document, core} = page(`
            <main>
                <article>
                    <div id="user-name" data-testid="User-Name">
                        <a href="/example-user">
                            <span>Example User</span>
                            <span>@example_user</span>
                        </a>
                    </div>
                    <div id="tweet-text" data-testid="tweetText">Translate this X post.</div>
                </article>
            </main>
        `, 'https://x.com/home');
        const userName = document.querySelector('#user-name')!;
        const tweetText = document.querySelector('#tweet-text')!;

        expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual(['tweet-text']);
        expect(core.discover(document).find((candidate) => candidate.element === tweetText))
            .toMatchObject({adapterId: 'x', reason: 'x-post-text'});
        expect(core.resolve(userName.querySelector('span')?.firstChild)).toBeNull();
        expect(core.resolve(tweetText.firstChild)?.element).toBe(tweetText);
    });

    it('keeps an exact adapter target out of an ancestor inline run', () => {
        const {document, core} = page(`
            <main><div id="row">
                <a id="pr-title" class="markdown-title">Fix partial pull-request translation</a>
                <p>Block child that makes the row produce an inline run.</p>
            </div></main>
        `, 'https://github.com/FluentRead/FluentRead/pulls');
        const candidates = [...core.discoverSteps(document)]
            .flatMap((step) => step.candidate ? [step.candidate] : []);
        const explicit = candidates.find((candidate) => candidate.adapterId === 'github')!;
        const generic = candidates.find((candidate) =>
            candidate.nodes?.includes(document.querySelector('#pr-title') as ChildNode));
        const genericEquivalent = {...explicit, adapterId: undefined, reason: 'generic-inline-run'};

        expect(explicit).toBeDefined();
        expect(generic).toBeUndefined();
        expect(selectPreferredTranslationCandidate(explicit, genericEquivalent)).toBe(explicit);
        expect(selectPreferredTranslationCandidate(genericEquivalent, explicit)).toBe(explicit);
        expect(core.discover(document).find((candidate) => candidate.element.id === 'pr-title'))
            .toMatchObject({adapterId: 'github', reason: 'github-markdown-title'});
    });

    it('keeps ordinary inline siblings when an atomic target is the only barrier', () => {
        const {document, core} = page(`
            <main><div id="row">Readable prose before the title.
                <a id="pr-title" class="markdown-title">Fix partial pull-request translation</a>
                Readable prose after the title.</div></main>
        `, 'https://github.com/FluentRead/FluentRead/pulls');
        const row = document.querySelector('#row')!;
        const title = document.querySelector('#pr-title')!;
        const before = row.childNodes[0]!;
        const after = row.childNodes[2]!;
        const candidates = core.discover(document);
        const inlineRuns = candidates.filter((candidate) => candidate.reason === 'generic-inline-run');

        expect(candidates.find((candidate) => candidate.element === title))
            .toMatchObject({adapterId: 'github', reason: 'github-markdown-title'});
        expect(inlineRuns.map((candidate) => candidate.nodes)).toEqual([[before], [after]]);
        expect(core.resolve(before)?.nodes).toEqual([before]);
        expect(core.resolve(title)?.element).toBe(title);
        expect(core.resolve(after)?.nodes).toEqual([after]);
    });

    it('prefers an atomic self target over inline runs inside that target', () => {
        const {document} = parseHTML(`
            <html><body><main><div id="forced">Readable direct introduction.
                <p>Readable nested block.</p></div></main></body></html>
        `);
        const adapter = createDeclarativeAdapter({
            id: 'atomic-mixed-target',
            hosts: ['example.test'],
            targets: [{selector: '#forced', reason: 'atomic-mixed-target', atomic: true}],
        });
        const core = createTranslationCore({url: new URL('https://example.test'), adapters: [adapter]});
        const forced = document.querySelector('#forced')!;
        const directText = forced.firstChild!;

        expect(core.discover(document)).toEqual([
            expect.objectContaining({element: forced, adapterId: 'atomic-mixed-target'}),
        ]);
        expect(core.resolve(directText)).toMatchObject({
            element: forced,
            adapterId: 'atomic-mixed-target',
        });
        expect(core.resolve(directText)?.nodes).toBeUndefined();
    });

    it('prunes GitHub quick-search controlled UI', () => {
        const {document, core} = page(`
            <main><dialog open aria-label="Quick search"><p id="search-result">Search suggestion text.</p></dialog>
            <p id="body-copy">Repository body sentence.</p></main>
        `, 'https://github.com/FluentRead/FluentRead/pulls');

        const ids = core.discover(document).map((item) => item.element.id);
        expect(ids).not.toContain('search-result');
        expect(ids).toContain('body-copy');
        expect(core.resolve(document.querySelector('#search-result')?.firstChild)).toBeNull();
    });

    it('translates GitHub markdown prose inside live-updatable conversation containers', () => {
        const {document, core} = page(`
            <main>
                <div class="js-socket-channel js-updatable-content">
                    <div class="comment-body markdown-body">
                        <h2 id="change-heading">What changed</h2>
                        <ul><li id="change-item">Preserve Quick Search during translation.</li></ul>
                        <p id="change-reason">GitHub mounts the search interface dynamically.</p>
                    </div>
                </div>
            </main>
        `, 'https://github.com/FluentRead/FluentRead/pull/428');

        const candidates = core.discover(document);
        const ids = candidates.map((item) => item.element.id);
        expect(ids).toEqual(expect.arrayContaining(['change-heading', 'change-item', 'change-reason']));
        expect(candidates.filter((item) => item.adapterId === 'github')).toHaveLength(3);
        expect(core.shouldStayOriginal(document.querySelector('#change-heading')!)).toBe(false);
        expect(core.shouldIgnoreMutation(document.querySelector('#change-heading')!)).toBe(false);
    });

    it.each(['header', 'nav', 'aside', 'footer'])(
        'keeps a linked H1 translatable inside structural <%s> chrome',
        (containerTag) => {
            const {document, core} = page(`
                <${containerTag}>
                    <h1 id="page-heading"><a href="/guide"><span>Project setup guide</span></a></h1>
                    <p id="chrome-copy">Account navigation copy.</p>
                </${containerTag}>
            `, 'https://example.test/docs');
            const heading = document.querySelector('#page-heading')!;

            expect(core.discover(document)).toEqual([
                expect.objectContaining({element: heading, reason: 'generic-readable-block'}),
            ]);
            expect(core.resolve(document.querySelector('#page-heading span')?.firstChild)).toMatchObject({
                element: heading,
                reason: 'generic-readable-block',
            });
            expect(core.resolve(document.querySelector('#chrome-copy')?.firstChild)).toBeNull();
        },
    );

    it('keeps heading text beside an interactive control as its own inline run', () => {
        const {document, core} = page(`
            <main>
                <h1 id="page-heading">Install FluentRead <button id="copy-button">Copy</button></h1>
            </main>
        `, 'https://example.test/docs');
        const headingText = document.querySelector('#page-heading')?.firstChild;
        const button = document.querySelector('#copy-button')!;
        const candidates = core.discover(document);
        const heading = candidates.find((candidate) => candidate.element.id === 'page-heading');

        expect(candidates.map((candidate) => candidate.element.id)).toEqual(['copy-button', 'page-heading']);
        expect(heading?.nodes).toEqual([headingText]);
        expect(heading?.nodes).not.toContain(button);
        expect(core.resolve(headingText)).toMatchObject({element: document.querySelector('#page-heading')});
        expect(core.resolve(button)).toMatchObject({element: button, kind: 'control'});
    });

    it('keeps mutation exclusion separate from translation exclusion', () => {
        const {document} = parseHTML(`
            <html><body><main>
                <div id="ticker"><p id="dynamic-copy">A controlled live result.</p></div>
                <p id="static-copy">A stable article sentence.</p>
            </main></body></html>
        `);
        const adapter = createDeclarativeAdapter({
            id: 'controlled-ui',
            hosts: ['example.test'],
            mutationExclude: [{selector: '#ticker', reason: 'controlled-live-region'}],
        });
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [adapter],
        });
        const ticker = document.querySelector('#ticker')!;
        const copy = document.querySelector('#dynamic-copy')!;

        expect(core.shouldIgnoreMutation(ticker)).toBe(true);
        expect(core.shouldIgnoreMutation(copy)).toBe(true);
        expect(core.shouldStayOriginal(copy)).toBe(false);
        expect(core.discover(document).map((item) => item.element.id)).toContain('dynamic-copy');
    });

    it('keeps GNU Texinfo navigation panels original while targeting prose', () => {
        const {document, core} = page(`
            <div class="section-level-extent">
                <div class="nav-panel"><p id="navigation">Next: Definitions, Up: Introduction</p></div>
                <p id="manual-copy">Bash is a command language interpreter for the GNU operating system.</p>
            </div>
        `, 'https://www.gnu.org/software/bash/manual/html_node/What-is-Bash_003f.html');

        expect(core.discover(document).map((item) => item.element.id)).toEqual(['manual-copy']);
        expect(core.resolve(document.querySelector('#navigation'))).toBeNull();
    });

    it('handles stale or invalid site selectors without aborting discovery', () => {
        const {document} = parseHTML('<html><body><main><p id="safe">Readable fallback prose.</p></main></body></html>');
        const adapter = createDeclarativeAdapter({
            id: 'broken-selector',
            hosts: ['example.test'],
            prune: [{selector: '[invalid=', reason: 'invalid'}],
            targets: [{selector: ':not(', reason: 'invalid-target'}],
        });
        const core = createTranslationCore({url: new URL('https://example.test'), adapters: [adapter]});

        expect(core.discover(document).map((item) => item.element.id)).toEqual(['safe']);
    });

    it('drops one invalid selector without disabling valid selectors in the same rule', () => {
        const {document} = parseHTML('<html><body><main><p id="safe">Readable fallback prose.</p></main></body></html>');
        const adapter = createDeclarativeAdapter({
            id: 'partially-broken-selector',
            hosts: ['example.test'],
            targets: [{
                selector: [':not(', '#safe'],
                reason: 'valid-selector-survives',
            }],
        });
        const core = createTranslationCore({url: new URL('https://example.test'), adapters: [adapter]});

        expect(core.discover(document)[0]).toMatchObject({
            element: document.querySelector('#safe'),
            adapterId: 'partially-broken-selector',
            reason: 'valid-selector-survives',
        });
    });

    it('combines selector lists so a generic adapter miss does not repeat ancestor walks', () => {
        const {document} = parseHTML('<html><body><main><p id="safe">Readable fallback prose.</p></main></body></html>');
        const adapter = createDeclarativeAdapter({
            id: 'selector-cost',
            hosts: ['example.test'],
            prune: [{
                selector: Array.from({length: 20}, (_, index) => `.never-prune-${index}`),
                reason: 'never-prune',
            }],
            targets: [{
                selector: Array.from({length: 20}, (_, index) => `.never-target-${index}`),
                reason: 'never-target',
                match: 'closest',
            }],
        });
        const target = document.querySelector('#safe')!;
        const closest = vi.spyOn(target, 'closest');

        expect(adapter.decide(target, {url: new URL('https://example.test')})).toEqual({kind: 'pass'});
        expect(closest).toHaveBeenCalledTimes(2);
    });

    it('isolates faulty adapters and preserves registration order for equal priorities', () => {
        const {document} = parseHTML('<html><body><main><p id="safe">Readable fallback prose.</p></main></body></html>');
        const faulty = {
            id: 'faulty',
            priority: 100,
            matches: () => true,
            decide: () => { throw new Error('adapter failure'); },
            shouldStayOriginal: () => { throw new Error('adapter failure'); },
            shouldOmitFromTranslation: () => { throw new Error('adapter failure'); },
        };
        const first = createDeclarativeAdapter({
            id: 'z-first-registered',
            priority: 50,
            hosts: ['example.test'],
            targets: [{selector: '#safe', reason: 'first-wins'}],
        });
        const second = createDeclarativeAdapter({
            id: 'a-second-registered',
            priority: 50,
            hosts: ['example.test'],
            targets: [{selector: '#safe', reason: 'second-loses'}],
        });
        const core = createTranslationCore({
            url: new URL('https://example.test'),
            adapters: [faulty, first, second],
        });

        expect(core.shouldOmitFromTranslation(document.querySelector('#safe')!)).toBe(false);
        expect(core.discover(document)[0]).toMatchObject({
            adapterId: 'z-first-registered',
            reason: 'first-wins',
        });
    });

    it('continues into children when a forced target is stale or explicitly non-atomic', () => {
        const {document} = parseHTML(`
            <html><body><main><div id="wrapper">Readable direct intro.
                <p id="child">Readable child paragraph.</p></div>
            <div id="empty"></div></main></body></html>
        `);
        const stale = {
            id: 'stale-target',
            matches: () => true,
            decide: (element: Element) => element.id === 'wrapper'
                ? {kind: 'force-target' as const, target: document.querySelector('#empty')!, reason: 'stale'}
                : {kind: 'pass' as const},
        };
        const nonAtomic = {
            id: 'non-atomic-target',
            matches: () => true,
            decide: (element: Element) => element.id === 'wrapper'
                ? {kind: 'force-target' as const, reason: 'container', atomic: false}
                : {kind: 'pass' as const},
        };

        const staleCore = createTranslationCore({url: new URL('https://example.test'), adapters: [stale]});
        expect(staleCore.discover(document).map((candidate) => candidate.element.id)).toContain('child');

        const nonAtomicCore = createTranslationCore({url: new URL('https://example.test'), adapters: [nonAtomic]});
        const candidates = nonAtomicCore.discover(document);
        expect(candidates.map((candidate) => candidate.element.id)).toEqual(['child', 'wrapper']);
        expect(candidates.find((candidate) => candidate.element.id === 'wrapper')?.nodes).toHaveLength(1);
        expect(nonAtomicCore.resolve(document.querySelector('#child'))?.element.id).toBe('child');
        expect(nonAtomicCore.resolve(document.querySelector('#wrapper')?.firstChild)?.nodes)
            .toEqual(candidates.find((candidate) => candidate.element.id === 'wrapper')?.nodes);
    });

    it('allows an adapter to force the same structural target for full and hover', () => {
        const {document} = parseHTML(`
            <html><body><header id="forced"><span id="hit">Readable structural prose.</span></header></body></html>
        `);
        const adapter = createDeclarativeAdapter({
            id: 'forced-header',
            hosts: ['example.test'],
            targets: [{selector: '#forced', reason: 'explicit-header', atomic: true}],
        });
        const core = createTranslationCore({url: new URL('https://example.test'), adapters: [adapter]});

        expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual(['forced']);
        expect(core.resolve(document.querySelector('#hit'))?.element.id).toBe('forced');
    });

    it('bounds discovery work for a single huge inline subtree', () => {
        const {document} = parseHTML('<html><body><main><p id="huge"></p></main></body></html>');
        const huge = document.querySelector('#huge')!;
        for (let index = 0; index < 5000; index += 1) {
            huge.appendChild(document.createTextNode(index === 0 ? 'Readable prose.' : ' ·'));
        }
        const core = createTranslationCore({url: new URL('https://example.test')});
        const steps = core.discoverSteps(document);
        let candidate: ReturnType<typeof core.discover>[number] | undefined;
        for (const step of steps) candidate ??= step.candidate;

        expect(candidate?.element.id).toBe('huge');
    });

    it('walks deeply nested DOM iteratively without overflowing the call stack', () => {
        const {document} = parseHTML('<html><body><main id="root"></main></body></html>');
        let parent = document.querySelector('#root')!;
        for (let index = 0; index < 400; index += 1) {
            const child = document.createElement('div');
            parent.appendChild(child);
            parent = child;
        }
        const paragraph = document.createElement('p');
        paragraph.id = 'deep-prose';
        paragraph.textContent = 'A readable sentence at the deepest level.';
        parent.appendChild(paragraph);

        expect(candidateIds(document)).toEqual(['deep-prose']);
    });

    it('filters identifiers and pure numeric metadata', () => {
        const ids = candidateIds(parseHTML(`
            <html><body><main>
                <p id="hash">a1b2c3d4</p>
                <p id="number">2026-08-18</p>
                <p id="words">A meaningful release description.</p>
            </main></body></html>
        `).document);

        expect(ids).toEqual(['words']);
    });

    it('only skips short text when kana, Hangul, or Chinese-specific forms prove the target script', () => {
        expect(isClearlyTargetLanguage('今日は良い天気です。', 'ja-JP')).toBe(true);
        expect(isClearlyTargetLanguage('今日は良い天気です。', 'zh-Hans')).toBe(false);
        expect(isClearlyTargetLanguage('今日は良い天気です。', 'ko')).toBe(false);
        expect(isClearlyTargetLanguage('設定を翻訳', 'ja-JP')).toBe(true);
        expect(isClearlyTargetLanguage('設定を翻訳', 'zh-CN')).toBe(false);
        expect(isClearlyTargetLanguage('설정 번역', 'ko-KR')).toBe(true);
        expect(isClearlyTargetLanguage('설정 번역', 'zh-CN')).toBe(false);
        expect(isClearlyTargetLanguage('설정 번역', 'ja')).toBe(false);
        expect(isClearlyTargetLanguage('あ안', 'ja')).toBe(false);
        expect(isClearlyTargetLanguage('あ안', 'ko')).toBe(false);

        expect(isClearlyTargetLanguage('翻译设置', 'zh-CN')).toBe(true);
        expect(isClearlyTargetLanguage('翻译设置', 'zh-Hans')).toBe(true);
        expect(isClearlyTargetLanguage('翻译设置', 'zh-SG')).toBe(true);
        expect(isClearlyTargetLanguage('翻译设置', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('翻译设置', 'zh-TW')).toBe(false);
        expect(isClearlyTargetLanguage('翻译设置', 'zh')).toBe(true);
        expect(isClearlyTargetLanguage('翻译设置', 'ja-JP')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh-Hant')).toBe(true);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh-TW')).toBe(true);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh-HK')).toBe(true);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh-Hans')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh-CN')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文測試', 'zh')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文測試', 'ja-JP')).toBe(false);
        expect(isClearlyTargetLanguage('这是繁體中文測試', 'zh-Hans')).toBe(false);
        expect(isClearlyTargetLanguage('这是繁體中文測試', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('这是简体中文測試', 'zh-Hans')).toBe(false);
        expect(isClearlyTargetLanguage('這是繁體中文测试', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文 English', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('呢個係繁體嘅廣東話。', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('繁體中文測試', 'yue-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('日本語文章', 'zh-Hans')).toBe(false);
        expect(isClearlyTargetLanguage('日本語文章', 'ja')).toBe(false);
        expect(isClearlyTargetLanguage('時間', 'zh-Hant')).toBe(false);
        expect(isClearlyTargetLanguage('云々', 'zh-Hans')).toBe(false);

        expect(isClearlyTargetLanguage('Bonjour le monde.', 'en')).toBe(false);
        expect(isClearlyTargetLanguage('Hallo Welt.', 'en')).toBe(false);
        expect(isClearlyTargetLanguage('Settings', 'en')).toBe(false);
        expect(isClearlyTargetLanguage('Pull requests', 'zh-CN')).toBe(false);
        expect(isClearlyTargetLanguage('API', 'zh-CN')).toBe(false);
        expect(isClearlyTargetLanguage('Paramètres', 'fr')).toBe(false);
        expect(isClearlyTargetLanguage('漢字', 'en')).toBe(false);

        expect(isClearlyTargetLanguage('', 'zh-CN')).toBe(true);
        expect(isClearlyTargetLanguage('   ', 'ja')).toBe(true);
        expect(isClearlyTargetLanguage('2026-08-25', 'en')).toBe(true);
        expect(isClearlyTargetLanguage('123 / 456', 'zh-Hans')).toBe(true);
        expect(isMeaningfulTranslationText('!!!')).toBe(false);
        expect(isMeaningfulTranslationText('https://example.test/docs')).toBe(false);
        expect(isMeaningfulTranslationText('dev@example.test')).toBe(false);
        expect(isMeaningfulTranslationText('@maintainer')).toBe(false);
        expect(isMeaningfulTranslationText('u/reader')).toBe(false);
        expect(isMeaningfulTranslationText('#1234')).toBe(false);
        expect(isMeaningfulTranslationText('translationCore.ts')).toBe(false);
        expect(isMeaningfulTranslationText('Readable article summary')).toBe(true);
    });

    it('exercises URL-scoped current core wrappers without leaking cache across pages', () => {
        const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const {document} = parseHTML('<html><body><main><p id="target">Readable current page text.</p></main></body></html>');
        const target = document.querySelector('#target')!;

        try {
            Object.defineProperty(globalThis, 'location', {
                configurable: true,
                value: {href: 'https://example.test/first'},
            });
            const firstCore = getCurrentTranslationCore();
            expect(getCurrentTranslationCore()).toBe(firstCore);
            expect(resolveTranslationCandidate(target.firstChild)?.element).toBe(target);

            Object.defineProperty(globalThis, 'location', {
                configurable: true,
                value: {href: 'https://example.test/second'},
            });
            expect(getCurrentTranslationCore()).not.toBe(firstCore);

            Reflect.deleteProperty(globalThis, 'location');
            expect(getCurrentTranslationCore().url.href).toBe('https://invalid.local/');
            expect(new TranslationCandidateCore().url.href).toBe('https://invalid.local/');
            Object.defineProperty(globalThis, 'location', {
                configurable: true,
                value: {href: 'not a url'},
            });
            expect(new TranslationCandidateCore().url.href).toBe('https://invalid.local/');

            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
            else Reflect.deleteProperty(globalThis, 'document');
            expect(resolveTranslationCandidateAtPoint(1, 2)).toBeNull();

            Object.defineProperty(document, 'elementFromPoint', {
                configurable: true,
                value: () => target,
            });
            Object.defineProperty(globalThis, 'document', {
                configurable: true,
                value: document,
            });
            expect(resolveTranslationCandidateAtPoint(1, 2)?.element).toBe(target);
        } finally {
            if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
            else Reflect.deleteProperty(globalThis, 'location');
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
            else Reflect.deleteProperty(globalThis, 'document');
        }
    });

    it('keeps DOM helper fallbacks bounded and fail-closed', () => {
        const {document} = parseHTML(`
            <html><body><main>
                <div class="fluent-read-loading"><span id="owned">Owned UI</span></div>
                <article-card id="host"></article-card>
                <p id="point">Point target text.</p>
            </main></body></html>
        `);
        const owned = document.querySelector('#owned')!;
        const host = document.querySelector('#host')!;
        const point = document.querySelector('#point')!;
        const firstShadow = host.attachShadow({mode: 'open'});
        firstShadow.innerHTML = '<nested-card id="nested"></nested-card>';
        const nested = firstShadow.querySelector('#nested')!;
        const secondShadow = nested.attachShadow({mode: 'open'});
        secondShadow.innerHTML = '<p id="shadow-copy">Nested shadow text.</p>';
        const duplicateHost = document.createElement('duplicate-card');
        Object.defineProperty(duplicateHost, 'shadowRoot', {
            configurable: true,
            value: firstShadow,
        });
        document.body.append(duplicateHost);

        expect(isExtensionElement(owned)).toBe(true);
        expect(safeMatches(point, ':not(')).toBe(false);
        expect(safeClosest(point, ':not(')).toBeNull();
        expect(getOpenShadowRoots(document)).toEqual([firstShadow, secondShadow]);
        expect(getOpenShadowRoots(host)).toEqual([firstShadow, secondShadow]);
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        try {
            Reflect.deleteProperty(globalThis, 'document');
            expect(getOpenShadowRoots({nodeType: 11, ownerDocument: null} as Node)).toEqual([]);
        } finally {
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
        }

        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: () => [point],
        });
        expect(findElementsAtPoint(document, 10, 20)).toEqual([point]);

        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => point,
        });
        expect(findElementsAtPoint(document, 10, 20)).toEqual([point]);
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => null,
        });
        expect(findElementsAtPoint(document, 10, 20)).toEqual([]);
        expect(findElementsAtPoint({} as Document, 10, 20)).toEqual([]);
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => point,
        });

        Object.defineProperty(document, 'caretPositionFromPoint', {
            configurable: true,
            value: () => ({offsetNode: point.firstChild}),
        });
        expect(findNodeAtPoint(document, 10, 20)).toBe(point.firstChild);

        Object.defineProperty(document, 'caretPositionFromPoint', {
            configurable: true,
            value: () => { throw new Error('caret position unavailable'); },
        });
        Object.defineProperty(document, 'caretRangeFromPoint', {
            configurable: true,
            value: () => ({startContainer: point.firstChild}),
        });
        expect(findNodeAtPoint(document, 10, 20)).toBe(point.firstChild);

        Object.defineProperty(document, 'caretRangeFromPoint', {
            configurable: true,
            value: () => { throw new Error('caret range unavailable'); },
        });
        expect(findNodeAtPoint(document, 10, 20)).toBeNull();

        const core = createTranslationCore({url: new URL('https://example.test')});
        const shadowTarget = secondShadow.querySelector('#shadow-copy')!;
        Object.defineProperty(firstShadow, 'elementFromPoint', {
            configurable: true,
            value: () => nested,
        });
        Object.defineProperty(secondShadow, 'elementFromPoint', {
            configurable: true,
            value: () => shadowTarget,
        });
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => host,
        });
        expect(core.resolveAtPoint(document, 10, 20)?.element).toBe(shadowTarget);

        Object.defineProperty(secondShadow, 'elementFromPoint', {
            configurable: true,
            value: () => null,
        });
        Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => document.querySelector('main'),
        });
        expect(core.resolveAtPoint(document, 10, 20)).toBeNull();

        Object.defineProperty(document, 'caretPositionFromPoint', {
            configurable: true,
            value: () => ({offsetNode: point.firstChild}),
        });
        expect(core.resolveAtPoint(document, 10, 20)?.element).toBe(point);
    });

    it('rejects malformed slot packets and applies truncation style overrides directly', () => {
        const packet = serializeTranslationSlots([' Alpha ', 'Beta']);
        const translated = `${packet.starts[0]}一${packet.ends[0]}\n${packet.starts[1]}二${packet.ends[1]}`;

        expect(packet.starts[0]).toMatch(/^___FLUENTREAD_[a-z0-9_-]+_0_BEGIN___$/u);
        expect(parseTranslationSlots(packet, translated)).toEqual(['一', '二']);
        expect(parseTranslationSlots({...packet, ends: packet.ends.slice(1)}, translated)).toBeNull();
        expect(parseTranslationSlots({...packet, starts: ['', packet.starts[1]]}, translated)).toBeNull();
        expect(parseTranslationSlots(packet, `${packet.starts[0]}一${packet.starts[0]}二${packet.ends[0]}`)).toBeNull();
        expect(parseTranslationSlots(
            packet,
            `${packet.starts[0]}一${packet.starts[1]}${packet.ends[0]}${packet.starts[1]}二${packet.ends[1]}`,
        )).toBeNull();
        expect(parseTranslationSlots(packet, `${packet.starts[0]}一`)).toBeNull();
        expect(parseTranslationSlots(packet, `${translated}\nextra prose`)).toBeNull();
        expect(serializeTranslationSlots(['Gamma'], '!!!').starts[0]).toBe('___FLUENTREAD_slots_0_BEGIN___');

        const {document} = parseHTML('<html><body><p id="target">Clamped text.</p></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        removeTranslationTruncation(target);
        expect(target.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        expect(target.style.getPropertyValue('line-clamp')).toBe('unset');
        expect(target.style.getPropertyValue('max-height')).toBe('unset');

        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => { throw new Error('style failed'); },
        });
        expect(hasActiveTranslationLineClamp(target)).toBe(false);
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => null,
        });
        expect(hasActiveTranslationLineClamp(target)).toBe(false);
        for (const value of ['', 'none', 'normal', 'auto', 'unset', 'initial', 'not-a-number']) {
            Object.defineProperty(document.defaultView, 'getComputedStyle', {
                configurable: true,
                value: () => ({
                    webkitLineClamp: value,
                    getPropertyValue: () => '',
                }),
            });
            expect(hasActiveTranslationLineClamp(target)).toBe(false);
        }
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => ({
                webkitLineClamp: '',
                getPropertyValue: (property: string) => property === 'line-clamp' ? '3' : '',
            }),
        });
        expect(hasActiveTranslationLineClamp(target)).toBe(true);
        const clampedWrapper = document.createElement('section');
        clampedWrapper.append(target);
        document.body.append(clampedWrapper);
        expect(findTranslationTruncationAncestors(target)).toEqual([clampedWrapper]);

        const originalCreateTreeWalker = document.createTreeWalker;
        Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value: undefined,
        });
        expect(collectLiveTranslationTextSlots(target)).toEqual([]);
        expect(createTranslationSourceSnapshot(target).slots).toEqual([]);
        expect(extractTranslationText(target)).toBe('');
        Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value: originalCreateTreeWalker,
        });

        const nullText = document.createTextNode('Readable text hidden by null nodeValue.');
        const nullDirectHost = document.createElement('p');
        nullDirectHost.append(nullText);
        document.body.append(nullDirectHost);
        Object.defineProperty(nullText, 'nodeValue', {
            configurable: true,
            get: () => null,
        });
        const nullTextHost = document.createElement('p');
        const nullWalkerText = document.createTextNode('Walker text hidden by null nodeValue.');
        Object.defineProperty(nullWalkerText, 'nodeValue', {
            configurable: true,
            get: () => null,
        });
        nullTextHost.append(nullWalkerText);
        document.body.append(nullTextHost);
        expect(extractTranslationTextFromNodes([nullText])).toBe('');
        expect(extractTranslationText(nullTextHost)).toBe('');
        expect(collectLiveTranslationTextSlots(nullTextHost)).toEqual([]);
        expect(createTranslationSourceSnapshot(nullTextHost).slots).toEqual([]);
        expect(hasMeaningfulTranslationTextInNodes([nullTextHost])).toBe(false);
    });

    it('honors declarative path gates and fails closed for invalid pathname patterns', () => {
        const adapter = createDeclarativeAdapter({
            id: 'path-gated',
            hosts: [{hostname: 'example.test', includeSubdomains: true}],
            pathnames: [/^\/docs\//u],
            targets: [{selector: '.article-copy', reason: 'path-copy'}],
            keepOriginal: [{selector: '.token', reason: 'secret'}],
            mutationExclude: [{selector: '.live-widget', reason: 'dynamic'}],
        });
        const brokenPath = createDeclarativeAdapter({
            id: 'broken-path',
            hosts: ['example.test'],
            pathnames: [{source: '[', flags: 'u'} as RegExp],
            targets: [{selector: '.article-copy', reason: 'path-copy'}],
        });
        const {document} = parseHTML(`
            <html><body><main>
                <p class="article-copy" id="copy">Readable article text.</p>
                <code class="token" id="token">API_TOKEN</code>
                <div class="live-widget" id="widget"></div>
            </main></body></html>
        `);

        expect(adapter.matches(new URL('https://sub.example.test/docs/page'))).toBe(true);
        expect(adapter.matches(new URL('https://sub.example.test/blog'))).toBe(false);
        expect(adapter.matches(new URL('https://other.test/docs/page'))).toBe(false);
        expect(brokenPath.matches(new URL('https://example.test/docs/page'))).toBe(false);
        expect(adapter.decide(document.querySelector('#copy')!, {url: new URL('https://sub.example.test/docs/page')}))
            .toMatchObject({kind: 'force-target', reason: 'path-copy'});
        expect(adapter.shouldStayOriginal?.(document.querySelector('#token')!, {url: new URL('https://sub.example.test/docs/page')}))
            .toBe(true);
        expect(adapter.shouldIgnoreMutation?.(document.querySelector('#widget')!, {url: new URL('https://sub.example.test/docs/page')}))
            .toBe(true);
        expect(adapter.decide({ownerDocument: null} as unknown as Element, {url: new URL('https://sub.example.test/docs/page')}))
            .toEqual({kind: 'pass'});
    });

    it('covers adapter failure isolation and explicit candidate precedence', () => {
        const {document} = parseHTML(`
            <html><body><main>
                <div id="pruned"><p id="pruned-child">Pruned child text.</p></div>
                <p id="skip">Skipped self text.</p>
                <button id="forced-button">Confirm action</button>
                <div id="atomic-wrapper">Before <span id="atomic-child">Atomic child text.</span> After</div>
            </main></body></html>
        `);
        const pruned = document.querySelector('#pruned')!;
        const skip = document.querySelector('#skip')!;
        const forcedButton = document.querySelector('#forced-button')!;
        const atomicChild = document.querySelector('#atomic-child')!;
        const badMatches = {
            id: 'bad-matches',
            priority: undefined,
            matches: () => { throw new Error('matches failed'); },
            decide: () => ({kind: 'force-target' as const, reason: 'never'}),
        };
        const adapter = {
            id: 'edge-adapter',
            matches: () => true,
            decide: (element: Element) => {
                if (element === pruned) return {kind: 'prune-subtree' as const, reason: 'private'};
                if (element === skip) return {kind: 'skip-self' as const, reason: 'skip'};
                if (element === forcedButton) return {kind: 'force-target' as const, reason: 'button'};
                if (element === atomicChild) return {kind: 'force-target' as const, reason: 'atomic'};
                if (element.id === 'non-atomic-inline') {
                    return {kind: 'force-target' as const, reason: 'non-atomic-inline', atomic: false};
                }
                if (element.id === 'stale-text-target') {
                    return {
                        kind: 'force-target' as const,
                        reason: 'stale-text-target',
                        target: document.createTextNode('not an element') as unknown as Element,
                    };
                }
                return {kind: 'pass' as const};
            },
            shouldStayOriginal: () => { throw new Error('stay original failed'); },
            shouldIgnoreMutation: () => { throw new Error('ignore mutation failed'); },
        };
        const keepOriginal = {
            id: 'keep-original',
            matches: () => true,
            decide: () => ({kind: 'pass' as const}),
            shouldStayOriginal: (element: Element) => element.id === 'skip',
        };
        const stale = document.createElement('p');
        stale.id = 'stale-text-target';
        stale.textContent = 'Readable stale target text.';
        document.body.append(stale);
        const core = new TranslationCandidateCore({
            url: new URL('https://example.test'),
            adapters: [badMatches, adapter],
        });
        const noPriorityA = createDeclarativeAdapter({
            id: 'no-priority-a',
            hosts: ['example.test'],
            targets: [{selector: '#skip', reason: 'a'}],
        });
        const noPriorityB = createDeclarativeAdapter({
            id: 'no-priority-b',
            hosts: ['example.test'],
            targets: [{selector: '#skip', reason: 'b'}],
        });

        expect(core.adapters.map((item) => item.id)).toEqual(['edge-adapter']);
        expect(new TranslationCandidateCore({
            url: new URL('https://example.test'),
            adapters: [noPriorityA, noPriorityB],
        }).adapters.map((item) => item.id)).toEqual(['no-priority-a', 'no-priority-b']);
        expect(core.inspect(pruned).candidate).toBeNull();
        expect(core.resolve(pruned.querySelector('#pruned-child')?.firstChild)).toBeNull();
        expect(core.inspect(skip).candidate).toBeNull();
        expect(core.inspect(stale).candidate).toBeNull();
        expect(core.inspect(forcedButton).candidate).toMatchObject({kind: 'control', reason: 'button'});
        expect(core.shouldStayOriginal(document.querySelector('main')!)).toBe(false);
        expect(core.shouldIgnoreMutation(document.querySelector('main')!)).toBe(false);
        expect(new TranslationCandidateCore({
            url: new URL('https://example.test'),
            adapters: [keepOriginal],
        }).shouldStayOriginal(skip)).toBe(true);
        expect(selectPreferredTranslationCandidate(
            {element: skip as HTMLElement, kind: 'content', reason: 'generic'},
            {element: forcedButton as HTMLElement, kind: 'content', reason: 'forced', adapterId: 'edge-adapter'},
        )?.element).toBe(forcedButton);
        expect(selectPreferredTranslationCandidate(
            {element: skip as HTMLElement, kind: 'content', reason: 'generic'},
            {element: stale as HTMLElement, kind: 'content', reason: 'generic-2'},
        )?.element).toBe(skip);

        const candidates = core.discover(document.querySelector('#atomic-wrapper')!);
        expect(candidates.map((candidate) => candidate.element.id)).toContain('atomic-child');
        expect(candidates.filter((candidate) => candidate.element.id === 'atomic-wrapper'))
            .toHaveLength(2);
        expect(core.resolve(null)).toBeNull();
        expect(core.resolve(document.createComment('not an element'))).toBeNull();
        expect(core.resolve(document.querySelector('#atomic-wrapper'))?.element.id).toBe('atomic-wrapper');

        const directBarrier = document.createElement('div');
        const barrier = document.createElement('span');
        barrier.id = 'manual-barrier';
        barrier.textContent = 'Barrier text.';
        directBarrier.append('Before barrier.', barrier, 'After barrier.');
        expect(getDirectInlineRuns(directBarrier, undefined, true, (element) => element === barrier)
            .map((run) => run.map((node) => node.textContent).join('').trim()))
            .toEqual(['Before barrier.', 'After barrier.']);

        const mixed = document.createElement('div');
        mixed.id = 'mixed-inline-resolution';
        mixed.innerHTML = [
            'Intro ',
            '<span id="pass-inline">pass inline</span>',
            '<span id="non-atomic-inline">non atomic inline</span>',
            '<span id="redirect-inline">redirected inline</span>',
            '<span id="empty-inline"></span>',
            '<span id="second-atomic-child">second atomic child</span>',
            ' Tail',
        ].join('');
        document.body.append(mixed);
        const secondAtomic = mixed.querySelector('#second-atomic-child')!;
        const redirectInline = mixed.querySelector('#redirect-inline')!;
        const mixedAdapter = {
            id: 'mixed-adapter',
            matches: () => true,
            decide: (element: Element) => {
                if (element === secondAtomic) return {kind: 'force-target' as const, reason: 'second-atomic'};
                if (element === redirectInline) {
                    return {kind: 'force-target' as const, reason: 'redirect-inline', target: mixed};
                }
                if (element.id === 'non-atomic-inline') {
                    return {kind: 'force-target' as const, reason: 'non-atomic-inline', atomic: false};
                }
                return {kind: 'pass' as const};
            },
        };
        const mixedCore = new TranslationCandidateCore({
            url: new URL('https://example.test'),
            adapters: [mixedAdapter],
        });

        expect(mixedCore.discover(mixed).map((candidate) => candidate.element.id))
            .toContain('second-atomic-child');
        expect(mixedCore.resolve(mixed)?.element).toBe(mixed);
        expect(mixedCore.resolve(mixed.querySelector('#pass-inline')?.firstChild)?.element).toBe(mixed);
        expect(mixedCore.resolve(mixed.querySelector('#empty-inline'))?.element).toBe(mixed);

        const statefulWrapper = document.createElement('div');
        statefulWrapper.id = 'stateful-wrapper';
        statefulWrapper.innerHTML = [
            'Before ',
            '<span id="stateful-child">Stateful child text.</span>',
            '<p id="stateful-block">Block child text.</p>',
            ' After',
        ].join('');
        document.body.append(statefulWrapper);
        const statefulChild = statefulWrapper.querySelector('#stateful-child')!;
        let statefulDecisions = 0;
        const statefulCore = new TranslationCandidateCore({
            url: new URL('https://example.test'),
            adapters: [{
                id: 'stateful-barrier',
                matches: () => true,
                decide: (element: Element) => {
                    if (element !== statefulChild) return {kind: 'pass' as const};
                    statefulDecisions += 1;
                    return statefulDecisions >= 2
                        ? {kind: 'force-target' as const, reason: 'late-barrier'}
                        : {kind: 'pass' as const};
                },
            }],
        });
        const statefulCandidates = statefulCore.discover(statefulWrapper);
        const statefulRunText = statefulCandidates
            .filter((candidate) => candidate.element === statefulWrapper && candidate.nodes)
            .map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim());

        expect(statefulRunText).toEqual(['Before', 'After']);
    });

    it('keeps hover resolution inside owned wrappers and bounded stale inline probes', () => {
        const {document, core} = page(`
            <main><div id="parent">
                Intro text.
                <span data-fr-translation-segment="true" id="owned-run">Owned translated run.</span>
                <span class="fluent-read-bilingual-content" id="bilingual">Existing translation.</span>
                <span class="fluent-read-loading" id="extension-ui"><span id="extension-child">Loading</span></span>
            </div></main>
        `);
        const parent = document.querySelector('#parent')!;
        const ownedRun = document.querySelector('#owned-run')!;
        const bilingual = document.querySelector('#bilingual')!;
        const extensionUi = document.querySelector('#extension-ui')!;
        const extensionChild = document.querySelector('#extension-child')!;

        expect(core.resolve(ownedRun.firstChild)).toMatchObject({element: ownedRun, reason: 'owned-inline-run'});
        expect(core.resolve(bilingual.firstChild)?.element).toBe(parent);
        expect(core.resolve(extensionUi)?.element).toBe(parent);
        expect(core.resolve(extensionUi.firstChild)?.element).toBe(parent);
        expect(core.resolve(extensionChild.firstChild)?.element).toBe(parent);

        const budgeted = document.createElement('div');
        budgeted.id = 'budgeted';
        budgeted.append('Before budget. ');
        for (let index = 0; index < 270; index += 1) {
            const shell = document.createElement('span');
            shell.innerHTML = `<p>Nested candidate ${index} remains separate.</p>`;
            budgeted.append(shell);
        }
        budgeted.append(' After budget.');
        document.body.append(budgeted);
        const candidates = core.discover(budgeted);

        expect(candidates.length).toBeGreaterThan(200);
        expect(core.resolve(budgeted.firstChild)?.element).toBe(budgeted);
    });

    it('guards extreme text ancestry and layout edge cases without provider work', () => {
        const {document, core} = page('<main><div id="root"></div></main>');
        const root = document.querySelector('#root')!;
        let parent = root;
        for (let index = 0; index < maxComposedAncestorDepth + 2; index += 1) {
            const child = document.createElement('span');
            parent.append(child);
            parent = child;
        }
        parent.textContent = 'Deep readable text should be conservatively protected.';
        expect(hasMeaningfulTranslationTextInNodes([parent.firstChild!])).toBe(false);
        expect(isTranslationTextNodeProtected(parent.firstChild as Text)).toBe(true);
        expect(hasMeaningfulTranslationTextInNodes([document.createComment('Readable comment')])).toBe(false);
        expect(extractTranslationTextFromNodes([document.createComment('Readable comment')])).toBe('');
        const detachedText = document.createTextNode('Detached readable text.');
        expect(extractTranslationTextFromNodes([detachedText])).toBe('');

        const manyInlineChildren = document.createElement('p');
        manyInlineChildren.id = 'many-inline';
        for (let index = 0; index < 2050; index += 1) {
            const span = document.createElement('span');
            span.textContent = index === 0 ? 'Readable text.' : 'x';
            manyInlineChildren.append(span);
        }
        document.body.append(manyInlineChildren);
        expect(core.inspect(manyInlineChildren).candidate).toBeNull();
        expect(hasDirectReadableText(manyInlineChildren)).toBe(false);
        expect(getDirectInlineRuns(manyInlineChildren)).toEqual([]);

        const emptyButton = document.createElement('button');
        emptyButton.id = 'empty-button';
        document.body.append(emptyButton);
        expect(core.inspect(emptyButton).candidate).toBeNull();
        expect(classifyGenericCandidate(emptyButton)).toBeNull();

        const deepNav = document.createElement('nav');
        let structuralParent = deepNav;
        for (let index = 0; index < maxComposedAncestorDepth + 2; index += 1) {
            const child = document.createElement('span');
            structuralParent.append(child);
            structuralParent = child;
        }
        structuralParent.textContent = 'Deep structural text.';
        document.body.append(deepNav);
        expect(hasStructuralAncestor(structuralParent)).toBe(true);
        expect(core.resolve(structuralParent.firstChild)).toBeNull();

        const deepMain = document.createElement('main');
        let asideParent = deepMain;
        for (let index = 0; index < maxComposedAncestorDepth + 2; index += 1) {
            const child = document.createElement('span');
            asideParent.append(child);
            asideParent = child;
        }
        const deepAside = document.createElement('aside');
        asideParent.append(deepAside);
        document.body.append(deepMain);
        expect(isStructuralContainer(deepAside)).toBe(true);

        const hidden = document.createElement('p');
        hidden.textContent = 'Hidden text.';
        hidden.setAttribute('aria-hidden', 'true');
        document.body.append(hidden);
        expect(evaluateHardGuard(hidden)).toEqual({prune: true, reason: 'hidden'});
        hidden.removeAttribute('aria-hidden');
        hidden.className = 'sr-only';
        expect(evaluateHardGuard(hidden)).toEqual({prune: true, reason: 'hidden'});

        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                display: element.id === 'display-none' ? 'none' : '',
            }),
        });
        const displayNone = document.createElement('span');
        displayNone.id = 'display-none';
        displayNone.textContent = 'Invisible text.';
        document.body.append(displayNone);
        expect(core.inspect(displayNone).candidate).toBeNull();
        expect(isBlockBoundary(displayNone)).toBe(false);
        expect(isBlockBoundary({tagName: 'div', ownerDocument: null} as unknown as Element)).toBe(true);

        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => null,
        });
        const noStyle = document.createElement('p');
        noStyle.textContent = 'Readable when style lookup returns nothing.';
        document.body.append(noStyle);
        expect(evaluateHardGuard(noStyle)).toEqual({prune: false});

        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => { throw new Error('style unavailable'); },
        });
        const styleFallback = document.createElement('p');
        styleFallback.textContent = 'Readable after style failure.';
        document.body.append(styleFallback);
        expect(core.inspect(styleFallback).candidate?.element).toBe(styleFallback);

        const structuralNav = document.createElement('nav');
        const structuralCopy = document.createElement('p');
        structuralCopy.textContent = 'Navigation text.';
        structuralNav.append(structuralCopy);
        document.body.append(structuralNav);
        expect(hasStructuralAncestor(structuralCopy)).toBe(true);
        expect(classifyGenericCandidate(structuralCopy)).toBeNull();
    });
});

describe('X 动态正文候选形态回归', () => {
    it('含 emoji 与链接的 tweetText 仍由 X 适配器作为原子 owner，不 materialize synthetic run', () => {
        const {document, core} = page(`
            <article data-testid="tweet">
                <div id="tweet-text" data-testid="tweetText">
                    <span id="tweet-copy">Astra released itself from containment </span>
                    <img alt="😭" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
                    <a id="tweet-link" href="https://example.com"><span>more than OpenAI</span></a>
                </div>
            </article>
        `, 'https://x.com/TokenGremlin/status/2094882239763071372');
        const tweetText = document.querySelector<HTMLElement>('#tweet-text')!;
        const hit = document.querySelector<HTMLElement>('#tweet-copy')!.firstChild!;
        const discovered = core.discover(document).find((candidate) => candidate.element === tweetText);
        const hovered = core.resolve(hit);

        expect(discovered).toMatchObject({
            element: tweetText,
            adapterId: 'x',
            reason: 'x-post-text',
        });
        expect(discovered?.nodes).toBeUndefined();
        expect(hovered).toMatchObject({
            element: tweetText,
            adapterId: 'x',
            reason: 'x-post-text',
        });
        expect(hovered?.nodes).toBeUndefined();
    });
});

describe('embedded semantic chrome classification', () => {
    it('discovers and hover-resolves both Swift DocC note paragraphs without admitting a top-level aside', () => {
        const {document, core} = page(`
            <aside id="global-aside">
                <p id="global-aside-copy">Related documentation and page tools.</p>
            </aside>
            <main id="app-main">
                <div class="doc-content-wrapper">
                    <div class="primary-content">
                        <div class="content">
                            <aside class="note">
                                <p id="note-label">Note</p>
                                <p id="note-copy">The remainder operator <code>%</code> keeps the sign of the first value.</p>
                            </aside>
                        </div>
                    </div>
                </div>
            </main>
        `, 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/basicoperators/');
        const noteLabel = document.querySelector('#note-label')!;
        const noteCopy = document.querySelector('#note-copy')!;
        const globalCopy = document.querySelector('#global-aside-copy')!;
        const candidates = core.discover(document);

        expect(
            candidates.map((candidate) => candidate.element.id),
            'Swift DocC callouts must expose both the note label and prose during full-document discovery',
        ).toEqual(['note-label', 'note-copy']);
        expect(core.resolve(noteLabel.firstChild), 'Hover must resolve the Swift note label').toMatchObject({
            element: noteLabel,
            adapterId: 'swift-docs',
        });
        expect(core.resolve(noteCopy.firstChild), 'Hover must resolve the Swift note prose').toMatchObject({
            element: noteCopy,
            adapterId: 'swift-docs',
        });
        expect(
            core.resolve(globalCopy.firstChild),
            'A body-level related-tools aside must remain structural chrome',
        ).toBeNull();
    });

    it('keeps article-owned asides and role=main notes while nav and metadata chrome remain structural', () => {
        const {document, core} = page(`
            <article>
                <header><p id="article-header-copy">A contextual introduction for this chapter.</p></header>
                <aside><p id="article-aside-copy">A related explanation owned by this article.</p></aside>
                <nav><p id="article-nav-copy">Previous and next chapter links.</p></nav>
                <footer><p id="article-footer-copy">A contextual conclusion for this chapter.</p></footer>
            </article>
            <div role="main">
                <aside role="note"><p id="role-main-note-copy">A semantic note inside the main reading surface.</p></aside>
                <aside><p id="role-main-tools-copy">Related tools outside the prose flow.</p></aside>
            </div>
        `);
        const ids = core.discover(document).map((candidate) => candidate.element.id);

        expect(ids, 'Article-owned asides and role=main notes must remain readable').toEqual([
            'article-aside-copy',
            'role-main-note-copy',
        ]);
        for (const chromeId of [
            'article-header-copy',
            'article-nav-copy',
            'article-footer-copy',
            'role-main-tools-copy',
        ]) {
            expect(ids, `${chromeId} must remain structural chrome`).not.toContain(chromeId);
        }
    });
});
