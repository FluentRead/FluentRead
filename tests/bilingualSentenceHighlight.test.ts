import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {alignBilingualSentences, sentenceSpans} from '@/src/core/translation/sentenceAlignment';
import {BILINGUAL_HIGHLIGHT_NAME, installBilingualSentenceHighlight} from '@/src/features/full-page-translation/content/sentenceHighlight';
import {BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID, syncBilingualSentenceHighlight} from '@/src/app/content/bilingualSentenceHighlight';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE, MAX_SENTENCE_HIGHLIGHT_PROFILES, SENTENCE_HIGHLIGHT_STYLES, buildSentenceHighlightAppearanceCss, getSentenceHighlightAppearanceStyle, normalizeSentenceHighlightAppearance, normalizeSentenceHighlightProfiles, parseSentenceHighlightCustomCss, resolveSentenceHighlightAppearance} from '@/src/core/config/sentenceHighlight';
import {beginTranslation, getTranslationState, markTranslationComplete, resetTranslationPresentation, restoreTranslation, setBilingualContent} from '@/src/features/full-page-translation/content/state';

describe('sentence highlight custom appearance', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('restores the enabled marker after the page replaces its root without reinstalling the document controller', () => {
        const f = fixture();
        syncBilingualSentenceHighlight(f.document, true, 'mint');
        const originalRegistry = f.registry.get(BILINGUAL_HIGHLIGHT_NAME);
        const root = f.document.createElement('html');
        root.innerHTML = '<head></head><body><p>Next page</p></body>';
        f.document.documentElement.replaceWith(root);
        syncBilingualSentenceHighlight(f.document, true, 'mint');
        expect(root.getAttribute('data-fr-bilingual-sentence-highlight')).toBe('true');
        expect(root.getAttribute('data-fr-bilingual-sentence-highlight-style')).toBe('mint');
        expect(f.registry.get(BILINGUAL_HIGHLIGHT_NAME)).toBe(originalRegistry);
        syncBilingualSentenceHighlight(f.document, false);
        expect(root.hasAttribute('data-fr-bilingual-sentence-highlight')).toBe(false);
    });
    it('migrates old settings without changing the preset or enabled state, and keeps defaults independent', () => {
        for (const value of [undefined, null, false, 42, '', 'broken', [], {}]) {
            expect(normalizeSentenceHighlightAppearance(value)).toEqual(DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE);
            const config = normalizeConfig({bilingualSentenceHighlightEnabled: true, bilingualSentenceHighlightStyle: 'mint', bilingualSentenceHighlightAppearance: value});
            expect(config).toMatchObject({bilingualSentenceHighlightEnabled: true, bilingualSentenceHighlightStyle: 'mint', bilingualSentenceHighlightAppearance: DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE});
        }
        const first = new Config(); first.bilingualSentenceHighlightAppearance.lineColor = '#112233';
        expect(new Config().bilingualSentenceHighlightAppearance).toEqual(DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE);
    });
    it('normalizes imported colors and bounds numeric overrides without accepting CSS injection or nonfinite values', () => {
        expect(normalizeSentenceHighlightAppearance({backgroundColor: 'red', lineColor: '#AbC', backgroundOpacity: '33.7', lineOpacity: 200, lineThickness: -1, lineStyle: 'wavy'}))
            .toEqual({backgroundColor: '#ff0000', backgroundOpacity: 34, lineColor: '#aabbcc', lineOpacity: 100, lineThickness: 1, lineStyle: 'wavy', customCss: ''});
        expect(normalizeSentenceHighlightAppearance({backgroundOpacity: -2, lineOpacity: 0, lineThickness: 10})).toMatchObject({backgroundOpacity: 0, lineOpacity: 0, lineThickness: 4});
        for (const value of [true, {}, [], null, undefined, '', ' ', 'bad', NaN, Infinity]) {
            expect(normalizeSentenceHighlightAppearance({backgroundOpacity: value, lineOpacity: value, lineThickness: value}))
                .toMatchObject({backgroundOpacity: null, lineOpacity: null, lineThickness: null});
        }
        expect(normalizeSentenceHighlightAppearance({backgroundColor: 'red; } body { display: none', lineColor: 'url(https://example.com)', lineStyle: 'hidden'}))
            .toEqual(DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE);
    });
    it('shares paint-only styles between preview and native highlights, including fill-only and line-only choices', () => {
        expect(buildSentenceHighlightAppearanceCss('rose', {})).toBe('');
        expect(getSentenceHighlightAppearanceStyle('mint', undefined)).toEqual({});
        for (const preset of SENTENCE_HIGHLIGHT_STYLES) {
            const {value, label, labelKey, ...appearance} = preset;
            expect(resolveSentenceHighlightAppearance(value, undefined)).toEqual(appearance);
        }
        expect(resolveSentenceHighlightAppearance('invalid', undefined).backgroundColor).toBe('#ef4776');
        const custom = {backgroundColor: '#123456', backgroundOpacity: 34, lineColor: '#abcdef', lineOpacity: 67, lineStyle: 'dashed', lineThickness: 3};
        expect(getSentenceHighlightAppearanceStyle('mint', custom)).toEqual({
            'background-color': 'rgba(18, 52, 86, 0.34)', 'text-decoration-line': 'underline', 'text-decoration-style': 'dashed',
            'text-decoration-color': 'rgba(171, 205, 239, 0.67)', 'text-decoration-thickness': '3px',
        });
        const css = buildSentenceHighlightAppearanceCss('rose', custom);
        expect(css).toContain('::highlight(fluentread-bilingual-sentence)');
        expect(css).not.toMatch(/\n\s+(?:color|opacity|font-size|position|padding):/u);
        expect(getSentenceHighlightAppearanceStyle('sky', {lineStyle: 'none'})).toMatchObject({'text-decoration-line': 'none', 'text-decoration-style': 'solid'});
        expect(getSentenceHighlightAppearanceStyle('rose', {backgroundOpacity: 0})).toMatchObject({'background-color': 'rgba(239, 71, 118, 0)'});
        expect(getSentenceHighlightAppearanceStyle('dotted', {lineOpacity: 50})).toMatchObject({'text-decoration-style': 'dotted', 'text-decoration-thickness': '2px'});
        const saved = normalizeConfig({bilingualSentenceHighlightEnabled: false, bilingualSentenceHighlightAppearance: custom});
        expect(normalizeConfig(JSON.parse(JSON.stringify(saved))).bilingualSentenceHighlightAppearance).toEqual({...custom, customCss: ''});
    });
    it('updates one style node without reinstallation or host changes and removes it on reset, disable and re-enable', () => {
        const f = fixture(); const owner = f.document.querySelector('#owner')!; const original = owner.innerHTML;
        const custom = {backgroundColor: '#123456', lineStyle: 'wavy'};
        syncBilingualSentenceHighlight(f.document, true, 'mint', custom); f.move();
        const element = f.document.getElementById(BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID)!;
        const rangeSet = f.registry.get(BILINGUAL_HIGHLIGHT_NAME);
        expect(element.textContent).toContain('wavy');
        syncBilingualSentenceHighlight(f.document, true, 'mint', custom);
        syncBilingualSentenceHighlight(f.document, true, 'sky', {...custom, lineThickness: 4});
        expect(f.document.getElementById(BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID)).toBe(element);
        expect(element.textContent).toContain('4px');
        expect(f.registry.get(BILINGUAL_HIGHLIGHT_NAME)).toBe(rangeSet);
        expect(owner.innerHTML).toBe(original);
        syncBilingualSentenceHighlight(f.document, true, 'sky');
        expect(f.document.getElementById(BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID)).toBeNull();
        syncBilingualSentenceHighlight(f.document, true, 'mint', custom);
        syncBilingualSentenceHighlight(f.document, false, 'mint', custom);
        expect(f.document.getElementById(BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID)).toBeNull();
        expect(f.highlighted()).toEqual([]);
        Object.defineProperty(f.document, 'head', {value: null});
        syncBilingualSentenceHighlight(f.document, true, 'mint', custom); f.move();
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        syncBilingualSentenceHighlight(f.document, false);
    });
});

describe('sentence highlight CSS and saved profiles', () => {
    it('accepts highlight declarations, maps background to its supported longhand, and rejects host selectors and layout properties', () => {
        expect(parseSentenceHighlightCustomCss('background: rgba(255, 220, 100, .3); color: navy; text-decoration-line: underline; text-decoration: underline wavy red;')).toEqual({
            declarations: [
                {property: 'background-color', value: 'rgba(255, 220, 100, .3)'}, {property: 'color', value: 'navy'},
                {property: 'text-decoration-line', value: 'underline'}, {property: 'text-decoration', value: 'underline wavy red'},
            ], invalidCount: 0,
        });
        const rejected = parseSentenceHighlightCustomCss('color: red; font-size: 18px; padding: 1px; background: url(https://example.com/a); } body { color: blue;');
        expect(rejected).toEqual({declarations: [{property: 'color', value: 'red'}], invalidCount: 4});
        expect(parseSentenceHighlightCustomCss(undefined)).toEqual({declarations: [], invalidCount: 0});
        expect(normalizeSentenceHighlightAppearance({customCss: 'color: red;\u0000'}).customCss).toBe('color: red;');
        expect(normalizeSentenceHighlightAppearance({customCss: 'a'.repeat(3000)}).customCss).toHaveLength(2000);
        expect(normalizeSentenceHighlightAppearance({customCss: 42}).customCss).toBe('');
    });
    it('preserves shorthand/longhand order and gives CSS precedence over controls in both rendering paths', () => {
        const appearance = {backgroundColor: '#123456', customCss: 'background: gold; text-decoration: underline wavy red; text-decoration-color: navy;'};
        const style = getSentenceHighlightAppearanceStyle('mint', appearance);
        expect(style['background-color']).toBe('gold');
        expect(Object.keys(style).indexOf('text-decoration-color')).toBeGreaterThan(Object.keys(style).indexOf('text-decoration'));
        const css = buildSentenceHighlightAppearanceCss('mint', appearance);
        expect(css.indexOf('text-decoration-color: navy')).toBeGreaterThan(css.indexOf('text-decoration: underline wavy red'));
        expect(css).toContain('background-color: gold !important;');
        const reverse = getSentenceHighlightAppearanceStyle('mint', {customCss: 'text-decoration-color: navy; text-decoration: underline wavy red;'});
        expect(Object.keys(reverse).indexOf('text-decoration-color')).toBeLessThan(Object.keys(reverse).indexOf('text-decoration'));
    });
    it('normalizes imported snapshots, rejects duplicate IDs and invalid presets, and preserves each CSS independently', () => {
        const source = [null, 42, {name: 'Missing id'}, {id: 'night', name: '  夜读\u0000  ', style: 'mint', appearance: {customCss: 'color: navy;', backgroundColor: '#ABC'}},
            {id: 'night', name: 'Duplicate', style: 'rose'}, {id: 'bad id', name: 'Bad id', style: 'rose'},
            {id: 'empty', name: ' ', style: 'rose'}, {id: 'nonstring', name: 42, style: 'rose'}, {id: 'invalid', name: 'Invalid', style: 'missing'},
            {id: 'paper', name: '纸张', style: 'amber'}];
        const profiles = normalizeSentenceHighlightProfiles(source);
        expect(profiles).toEqual([
            {id: 'night', name: '夜读', style: 'mint', appearance: {...DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE, backgroundColor: '#aabbcc', customCss: 'color: navy;'}},
            {id: 'paper', name: '纸张', style: 'amber', appearance: DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE},
        ]);
        profiles[0].appearance.customCss = 'color: red;';
        expect(profiles[1].appearance.customCss).toBe('');
        expect(normalizeSentenceHighlightProfiles('broken')).toEqual([]);
        expect(normalizeSentenceHighlightProfiles([{id: 'long', name: 'x'.repeat(50), style: 'rose'}])[0].name).toHaveLength(30);
        const config = normalizeConfig({bilingualSentenceHighlightProfiles: source, activeSentenceHighlightProfileId: 'night'});
        expect(config.activeSentenceHighlightProfileId).toBe('night');
        expect(normalizeConfig(JSON.parse(JSON.stringify(config))).bilingualSentenceHighlightProfiles).toEqual(config.bilingualSentenceHighlightProfiles);
        expect(normalizeConfig({...config, activeSentenceHighlightProfileId: 'missing'}).activeSentenceHighlightProfileId).toBe('');
        expect(normalizeConfig({...config, activeSentenceHighlightProfileId: 42}).activeSentenceHighlightProfileId).toBe('');
        expect(new Config().bilingualSentenceHighlightProfiles).toEqual([]);
        expect(new Config().activeSentenceHighlightProfileId).toBe('');
    });
    it('bounds imported snapshots and the scan of invalid data while keeping unique IDs', () => {
        const profiles = Array.from({length: MAX_SENTENCE_HIGHLIGHT_PROFILES + 1}, (_, i) => ({id: `saved-${i}`, name: `Style ${i}`, style: 'rose'}));
        expect(normalizeSentenceHighlightProfiles(profiles)).toHaveLength(MAX_SENTENCE_HIGHLIGHT_PROFILES);
        expect(normalizeSentenceHighlightProfiles([...Array(100).fill(null), ...profiles])).toEqual([]);
    });
});

const texts = (text: string) => sentenceSpans(text).map(span => text.slice(span.start, span.end));

describe('bilingual sentence coordinates and ordered alignment', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('keeps punctuation, decimals, abbreviations and quotes inside their sentence', () => {
        expect(texts('  Dr. Smith paid 3.14 dollars. “Is it ready?” Yes!  '))
            .toEqual(['Dr. Smith paid 3.14 dollars.', '“Is it ready?”', 'Yes!']);
        expect(texts('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？']);
        expect(texts('')).toEqual([]);
        expect(texts('  \n ')).toEqual([]);
    });
    it('falls back without Intl.Segmenter and preserves character offsets', () => {
        vi.stubGlobal('Intl', {...Intl, Segmenter: undefined});
        expect(texts('Dr. Smith paid 3.14 dollars. Next sentence.')).toEqual(['Dr. Smith paid 3.14 dollars.', 'Next sentence.']);
    });
    it('pairs equal counts and groups a split middle sentence in either direction', () => {
        const source = 'Start. This long sentence has two equally important parts. End.';
        const translated = '开始。这个很长的句子有两部分。两部分都同样重要。结束。';
        const pairs = alignBilingualSentences(source, translated);
        expect(pairs.map(pair => [source.slice(pair.source.start, pair.source.end), translated.slice(pair.translation.start, pair.translation.end)]))
            .toEqual([['Start.', '开始。'], ['This long sentence has two equally important parts.', '这个很长的句子有两部分。两部分都同样重要。'], ['End.', '结束。']]);
        expect(alignBilingualSentences(translated, source)).toEqual(pairs.map(pair => ({source: pair.translation, translation: pair.source})));
        expect(alignBilingualSentences('One. Two.', '一句。二句。')).toHaveLength(2);
        expect(alignBilingualSentences('One sentence.', '第一句。第二句。')).toHaveLength(1);
    });
    it('reserves nonempty groups when sentence lengths differ greatly and bounds pathological input', () => {
        for (const [source, target] of [['A. B. C.', '很长'.repeat(30) + '。短。短。短。'], ['A. B.', '甲。乙。丙。']]) {
            const pairs = alignBilingualSentences(source, target);
            expect(pairs).toHaveLength(sentenceSpans(source).length);
            expect(pairs.every(pair => pair.source.end > pair.source.start && pair.translation.end > pair.translation.start)).toBe(true);
            expect(pairs.at(-1)?.translation.end).toBe(target.length);
        }
        expect(alignBilingualSentences('', '译文。')).toEqual([]);
        expect(alignBilingualSentences('Source.', ' ')).toEqual([]);
        expect(alignBilingualSentences('Sentence. '.repeat(257), '译文。')).toEqual([]);
    });
});

describe('bilingual sentence hard breaks', () => {
    afterEach(() => vi.unstubAllGlobals());
    it.each(['native', 'fallback'] as const)('preserves line breaks, abbreviations and UTF-16 offsets with %s segmentation', backend => {
        if (backend === 'fallback') vi.stubGlobal('Intl', {...Intl, Segmenter: undefined});
        const text = ' \n Dr. 🧪 Smith uses Fig.\r\n\r\n Second line\u2028 Third line\u2029 ';
        const expected = ['Dr. 🧪 Smith uses Fig.', 'Second line', 'Third line'];
        expect(texts(text)).toEqual(expected);
        expect(sentenceSpans(text, 3)).toEqual(expected.map(sentence => ({
            start: text.indexOf(sentence),
            end: text.indexOf(sentence) + sentence.length,
        })));
        expect(sentenceSpans(text, 2)).toEqual([]);
    });
    it('checks the full word boundary when repairing an abbreviation', () => {
        expect(texts('ImageProf. Next sentence. Prof. Chen stayed.'))
            .toEqual(['ImageProf.', 'Next sentence.', 'Prof. Chen stayed.']);
    });
});

function registerBilingual(owner: HTMLElement, wrapper: HTMLElement, synthetic = false) {
    const attempt = beginTranslation(owner, 'bilingual', 'content', synthetic)!;
    expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
    setBilingualContent(owner, wrapper);
}

function fixture(html = '<p id="owner" data-row="10">First. Second.<span data-row="30" class="fluent-read-bilingual-content" data-fr-translation-owned="true">一句。二句。</span></p>', synthetic = false) {
    const {document, window} = parseHTML(`<html><body>${html}<aside id="outside">Outside.</aside></body></html>`);
    const registry = new Map<string, Set<Range>>();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    let collapsed = true;
    let geometryReads = 0;
    const callback: {value?: MutationCallback} = {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('CSS', {highlights: registry});
    vi.stubGlobal('Highlight', Set);
    const Observer = class {constructor(cb: MutationCallback) {callback.value = cb;} observe = observe; disconnect = disconnect;};
    Object.defineProperty(document, 'defaultView', {value: new Proxy(window, {get: (target, name) => name === 'MutationObserver' ? Observer : Reflect.get(target, name)})});
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {frames.set(++frameId, cb); return frameId;});
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({
        display: element.style.display,
        visibility: element.style.visibility,
        whiteSpace: element.style.whiteSpace,
        whiteSpaceCollapse: element.style.getPropertyValue('white-space-collapse'),
    }));
    // 手写 DOM 仅提供排版夹具；所有权与请求阶段沿用生产状态机，公开标记不代表真实译文。
    const wrappers = document.querySelectorAll<HTMLElement>('.fluent-read-bilingual-content[data-fr-translation-owned="true"]');
    const owners = new Map<HTMLElement, HTMLElement>();
    for (const wrapper of wrappers) owners.set(wrapper.parentElement!, wrapper);
    for (const [owner, wrapper] of owners) registerBilingual(owner, wrapper, synthetic);
    document.getSelection = () => ({isCollapsed: collapsed} as Selection);
    document.createRange = () => {
        let node: Text; let start: number; let end: number;
        return {
            setStart(n: Text, s: number) {node = n; start = s;},
            setEnd(_n: Text, e: number) {end = e;},
            get startContainer() {return node;},
            get startOffset() {return start;},
            get endOffset() {return end;},
            toString: () => node.data.slice(start, end),
            getClientRects: () => {
                geometryReads++;
                const top = Number(node.parentElement!.closest('[data-row]')?.getAttribute('data-row') || 50);
                return [{left: start * 10, right: end * 10, top, bottom: top + 10, width: (end - start) * 10, height: 10}];
            },
        } as unknown as Range;
    };
    const flush = () => {const work = [...frames.values()]; frames.clear(); work.forEach(cb => cb(0));};
    const move = (selector = '#owner', x = 20, y = 15, buttons = 0, immediate = true) => {
        const event = new window.Event('pointermove', {bubbles: true});
        Object.assign(event, {clientX: x, clientY: y, buttons});
        document.querySelector(selector)!.dispatchEvent(event);
        if (immediate) flush();
    };
    const highlighted = () => [...(registry.get(BILINGUAL_HIGHLIGHT_NAME) ?? [])].map(range => range.toString());
    const mutate = (target: Node = document.querySelector('#owner')!) => callback.value?.([{target} as MutationRecord], {} as MutationObserver);
    return {document, window, registry, move, flush, highlighted, mutate, disconnect, observe, frames,
        geometryReads: () => geometryReads, select: () => {collapsed = false;}};
}

describe('paint-only bilingual hover lifecycle', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('bounds untranslated sibling lookup across different pointer targets', () => {
        const f = fixture('<main>' + Array.from({length: 5000}, (_, index) => `<p id="row-${index}">Readable source.</p>`).join('') + '</main>');
        const dispose = installBilingualSentenceHighlight(f.document);
        const matches = vi.spyOn(f.window.Element.prototype, 'matches');
        try {
            const started = performance.now();
            for (let frame = 0; frame < 60; frame++) f.move(`#row-${frame}`);
            if (process.env.FLUENTREAD_MEASURE_SENTENCE_LOOKUP === '1') console.info('sentence-highlight-lookup', JSON.stringify({siblings: 5000, frames: 60,
                selectorChecks: matches.mock.calls.length, elapsedMs: Math.round(performance.now() - started)}));
            // 工作量必须与祖先深度相关；换 60 个命中节点不能退回扫描 5,000 个兄弟。
            expect(matches.mock.calls.length).toBeLessThanOrEqual(60 * 8);
            expect(f.highlighted()).toEqual([]);
        } finally {matches.mockRestore(); dispose();}
    });

    it('requires a completed content owner and the current direct bilingual artifact on every pointer frame', () => {
        const f = fixture(); const owner = f.document.querySelector<HTMLElement>('#owner')!;
        const state = getTranslationState(owner)!; const wrapper = state.bilingualContent!;
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        for (const phase of ['loading', 'error'] as const) {
            state.phase = phase; f.move(); expect(f.highlighted()).toEqual([]);
            state.phase = 'translated'; f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        }
        state.mode = 'single'; f.move(); expect(f.highlighted()).toEqual([]); state.mode = 'bilingual';
        state.kind = 'control'; f.move(); expect(f.highlighted()).toEqual([]); state.kind = 'content';
        state.bilingualContent = undefined; f.move(); expect(f.highlighted()).toEqual([]); state.bilingualContent = wrapper;
        for (const attribute of ['class', 'data-fr-translation-owned']) {
            const value = wrapper.getAttribute(attribute)!;
            wrapper.removeAttribute(attribute); f.move(); expect(f.highlighted()).toEqual([]);
            wrapper.setAttribute(attribute, value); f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        }
        const copy = wrapper.cloneNode(true) as HTMLElement; copy.id = 'unowned-copy'; owner.append(copy);
        f.move('#unowned-copy', 20, 35); expect(f.highlighted()).toEqual([]);
        copy.remove();
        f.document.querySelector('#outside')!.append(wrapper);
        f.move(); expect(f.highlighted()).toEqual([]);
        f.move('.fluent-read-bilingual-content', 20, 35); expect(f.highlighted()).toEqual([]);
        owner.append(wrapper); f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        dispose();
    });

    it('rebuilds the same owner after registered wrapper replacement, display switching and restore-retranslate', () => {
        const f = fixture(); const owner = f.document.querySelector<HTMLElement>('#owner')!;
        const state = getTranslationState(owner)!; const wrapper = state.bilingualContent!;
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        const replacement = wrapper.cloneNode(true) as HTMLElement; replacement.textContent = '新句。二句。';
        wrapper.replaceWith(replacement); setBilingualContent(owner, replacement);
        // 不依赖 MutationObserver 的异步通知：登记工件换代后，同一命中节点也不能重用旧文字映射。
        f.move(); expect(f.highlighted()).toEqual(['First.', '新句。']);
        resetTranslationPresentation(owner, state, 'single'); f.move(); expect(f.highlighted()).toEqual([]);
        resetTranslationPresentation(owner, state, 'bilingual'); owner.append(replacement); setBilingualContent(owner, replacement);
        f.move(); expect(f.highlighted()).toEqual(['First.', '新句。']);
        expect(restoreTranslation(owner)).toBe(true); f.move(); expect(f.highlighted()).toEqual([]);
        const retranslated = wrapper.cloneNode(true) as HTMLElement; owner.append(retranslated); registerBilingual(owner, retranslated);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        dispose();
    });

    it('uses registered synthetic owners and ignores detached owners or artifacts and unregistered copied markup', () => {
        const f = fixture('<div id="outer" data-row="10"><span id="owner">First. Second.<span data-row="30" class="fluent-read-bilingual-content" data-fr-translation-owned="true">一句。二句。</span></span></div>', true);
        const owner = f.document.querySelector<HTMLElement>('#owner')!; const wrapper = getTranslationState(owner)!.bilingualContent!;
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        const detachedMove = (target: Element) => {
            const event = new f.window.Event('pointermove');
            Object.assign(event, {clientX: 20, clientY: 15, buttons: 0, composedPath: () => [target, f.document]});
            f.document.dispatchEvent(event); f.flush();
        };
        owner.remove(); detachedMove(owner); expect(f.highlighted()).toEqual([]);
        wrapper.remove(); detachedMove(wrapper); expect(f.highlighted()).toEqual([]);
        owner.append(wrapper); f.document.querySelector('#outer')!.append(owner);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        expect(restoreTranslation(owner)).toBe(true);
        expect(f.document.getElementById('owner')).toBeNull();
        f.move('#outer'); expect(f.highlighted()).toEqual([]);
        const copy = f.document.createElement('p'); copy.id = 'copied-owner'; copy.setAttribute('data-row', '10');
        copy.innerHTML = 'First. Second.'; copy.append(wrapper); f.document.body.append(copy);
        f.move('#copied-owner'); expect(f.highlighted()).toEqual([]);
        f.move('.fluent-read-bilingual-content', 20, 35); expect(f.highlighted()).toEqual([]);
        dispose();
    });

    it('实时改变高亮外观不重新安装监听器，关闭时清理绘制与外观属性', () => {
        const f = fixture();
        syncBilingualSentenceHighlight(f.document, true, 'mint');
        f.move();
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        const paint = f.registry.get(BILINGUAL_HIGHLIGHT_NAME);
        syncBilingualSentenceHighlight(f.document, true, 'sky');
        expect(f.document.documentElement.getAttribute('data-fr-bilingual-sentence-highlight-style')).toBe('sky');
        expect(f.registry.get(BILINGUAL_HIGHLIGHT_NAME)).toBe(paint);
        syncBilingualSentenceHighlight(f.document, false);
        expect(f.document.documentElement.hasAttribute('data-fr-bilingual-sentence-highlight-style')).toBe(false);
        expect(f.highlighted()).toEqual([]);
    });
    it('moves both directions sentence by sentence without writing host DOM or disturbing other highlights', () => {
        const f = fixture(); const foreign = new Set<Range>(); f.registry.set('host-search', foreign);
        const before = f.document.body.innerHTML;
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        const paint = f.registry.get(BILINGUAL_HIGHLIGHT_NAME);
        f.move('#owner', 25); expect(f.registry.get(BILINGUAL_HIGHLIGHT_NAME)).toBe(paint);
        f.move('.fluent-read-bilingual-content', 45, 35); expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.move('#owner', 95); expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.move('#owner', 300); expect(f.highlighted()).toEqual([]);
        f.move(); f.move('#outside'); expect(f.highlighted()).toEqual([]);
        expect(f.document.body.innerHTML).toBe(before);
        dispose(); expect(f.registry.get('host-search')).toBe(foreign);
        expect(f.registry.has(BILINGUAL_HIGHLIGHT_NAME)).toBe(false);
        f.move(); expect(f.highlighted()).toEqual([]);
    });
    it('maps rich text and translation-first order while excluding hidden and protected fragments', () => {
        const f = fixture('<p id="owner" data-row="10"><span class="fluent-read-bilingual-content" data-fr-translation-owned="true" data-row="30">第一句。<b>第二句。</b></span>First <a id="link">linked</a> sentence.<br>Second sentence.<i hidden>Hidden.</i><i style="display:none">Invisible.</i><i style="visibility:hidden">Invisible.</i><i style="visibility:collapse">Invisible.</i><span translate="no">Protected.</span><!--comment--></p>');
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move('#link'); expect(f.highlighted()).toEqual(['First ', 'linked', ' sentence.', '第一句。']);
        f.move('[hidden]'); expect(f.highlighted()).toEqual([]);
        f.move('[translate="no"]'); expect(f.highlighted()).toEqual([]);
        dispose();
    });
    it('allows document-level translate guards while preserving local protected text', () => {
        const f = fixture('<p id="owner" data-row="10">First. <span id="protected" data-row="20" translate="NO">Protected.</span>Second.' +
            '<span id="translation" class="fluent-read-bilingual-content" data-fr-translation-owned="true" data-row="30">一句。二句。</span></p>');
        f.document.documentElement.setAttribute('translate', 'no');
        f.document.body.setAttribute('translate', 'no');
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        f.move('#translation', 40, 35); expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.move('#protected', 20, 25); expect(f.highlighted()).toEqual([]);
        dispose();
    });
    it('highlights the same complete sentence across collapsed source and translation newlines', () => {
        const f = fixture('<p id="owner" data-row="10">One. The full\r\n' +
            '<a id="link" data-row="20" href="/project">sentence\nruns</a><span id="tail" data-row="30"> to here. Next.</span>' +
            '<span class="fluent-read-bilingual-content" data-fr-translation-owned="true" data-row="40">开始。完整的\n' +
            '<strong id="translated-link" data-row="50">句子\r\n延续</strong>到这里。结束。</span></p>');
        const before = f.document.body.innerHTML;
        const dispose = installBilingualSentenceHighlight(f.document);
        const fullSentence = ['The full\r\n', 'sentence\nruns', ' to here.', '完整的\n', '句子\r\n延续', '到这里。'];
        for (const [selector, x, y] of [['#owner', 80, 15], ['#link', 20, 25], ['#tail', 20, 35], ['#translated-link', 20, 55]] as const) {
            f.move(selector, x, y);
            expect(f.highlighted()).toEqual(fullSentence);
        }
        f.move('#owner', 20, 15); expect(f.highlighted()).toEqual(['One.', '开始。']);
        f.move('#tail', 115, 35); expect(f.highlighted()).toEqual(['Next.', '结束。']);
        expect(f.document.body.innerHTML).toBe(before);
        dispose();
    });
    it('preserves BR and CSS-preserved line breaks while respecting an inline collapse override', () => {
        const f = fixture('<p id="owner" data-row="10">See Fig.<br>' +
            '<span id="lines" data-row="20" style="white-space: pre-line">second line\nthird line ' +
            '<b id="collapsed" data-row="30" style="white-space: pre-line; white-space-collapse: collapse">continues\nhere. Final words.</b></span>' +
            '<span class="fluent-read-bilingual-content" data-fr-translation-owned="true" data-row="40">第一行。第二行。第三行接着写。最后一行仍是独立的内容。</span></p>');
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move('#owner', 20, 15); expect(f.highlighted()).toEqual(['See Fig.', '第一行。']);
        f.move('#lines', 20, 25); expect(f.highlighted()).toEqual(['second line', '第二行。']);
        f.move('#collapsed', 20, 35); expect(f.highlighted()).toEqual(['third line ', 'continues\nhere.', '第三行接着写。']);
        f.move('#collapsed', 180, 35); expect(f.highlighted()).toEqual(['Final words.', '最后一行仍是独立的内容。']);
        dispose();
    });
    it('coalesces pointer input and cancels pending frames on all clear paths', () => {
        const f = fixture(); const dispose = installBilingualSentenceHighlight(f.document);
        f.move('#owner', 20, 15, 0, false); f.move('#owner', 95, 15, 0, false);
        expect(f.frames.size).toBe(1); f.flush(); expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.move('#owner', 20, 15, 1); expect(f.highlighted()).toEqual([]);
        for (const [surface, type] of [[f.document, 'scroll'], [f.document, 'selectionchange'], [f.window, 'blur'], [f.window, 'resize'], [f.window, 'pagehide']] as const) {
            f.move(); surface.dispatchEvent(new f.window.Event(type)); expect(f.highlighted()).toEqual([]);
        }
        f.move(); const out = new f.window.Event('pointerout'); Object.assign(out, {relatedTarget: f.document.body});
        f.document.dispatchEvent(out); expect(f.highlighted()).not.toEqual([]);
        f.document.dispatchEvent(new f.window.Event('pointerout')); expect(f.highlighted()).toEqual([]);
        f.document.dispatchEvent(new f.window.Event('pointermove')); f.flush(); expect(f.highlighted()).toEqual([]);
        f.select(); f.move(); expect(f.highlighted()).toEqual([]);
        f.move('#owner', 20, 15, 0, false); dispose(); expect(f.frames.size).toBe(0);
    });
    it('observes the actual ShadowRoot and clears stale sentence ranges after its text changes', () => {
        const f = fixture();
        const owner = f.document.querySelector('#owner')!;
        const host = f.document.createElement('div');
        f.document.body.appendChild(host);
        const outerShadow = host.attachShadow({mode: 'open'});
        const innerHost = f.document.createElement('section');
        outerShadow.appendChild(innerHost);
        const shadow = innerHost.attachShadow({mode: 'open'});
        shadow.appendChild(owner);
        const dispose = installBilingualSentenceHighlight(f.document);
        const point = new f.window.Event('pointermove');
        Object.assign(point, {clientX: 20, clientY: 15, buttons: 0, composedPath: () => [owner, shadow, host, f.document]});
        f.document.dispatchEvent(point); f.flush();
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        expect(f.observe.mock.calls.some(([root]) => root === shadow)).toBe(true);
        expect(f.observe.mock.calls.some(([root]) => root === outerShadow)).toBe(true);
        owner.firstChild!.textContent = 'Changed. Second.';
        f.mutate(owner.firstChild!);
        expect(f.highlighted()).toEqual([]);
        f.document.dispatchEvent(point); f.flush();
        expect(f.highlighted()).toEqual(['Changed.', '一句。']);
        f.mutate(host);
        expect(f.highlighted()).toEqual([]);
        dispose();
        expect(f.highlighted()).toEqual([]);
    });
    it('invalidates changed sentences and detached owners, but ignores unrelated mutations', () => {
        const f = fixture(); const dispose = installBilingualSentenceHighlight(f.document);
        f.mutate(); f.move(); f.mutate(f.document.querySelector('#outside')!); expect(f.highlighted()).not.toEqual([]);
        f.document.querySelector('#owner')!.firstChild!.textContent = 'Changed. Second.';
        f.mutate(); expect(f.highlighted()).toEqual([]);
        f.move(); expect(f.highlighted()).toEqual(['Changed.', '一句。']);
        f.mutate(f.document.body); expect(f.highlighted()).toEqual([]);
        f.move(); f.document.querySelector('#owner')!.remove(); f.mutate(f.document.body); expect(f.highlighted()).toEqual([]);
        dispose();
    });
    it('rejects duplicate wrappers, missing text, oversized owners and nontranslation content', () => {
        for (const html of [
            '<p id="owner">First.</p>',
            '<p id="owner"><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span></p>',
            '<p id="owner">' + 'x'.repeat(100_001) + '<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span></p>',
            '<p id="owner">First.<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">重复。</span></p>',
        ]) {
            const f = fixture(html); const dispose = installBilingualSentenceHighlight(f.document); f.move(); expect(f.highlighted()).toEqual([]); dispose();
        }
    });
    it('stays inert without native Highlight support or a view and sync is idempotent', () => {
        const f = fixture(); vi.stubGlobal('Highlight', undefined);
        installBilingualSentenceHighlight(f.document)(); f.move(); expect(f.highlighted()).toEqual([]);
        vi.stubGlobal('Highlight', Set); vi.stubGlobal('CSS', undefined); installBilingualSentenceHighlight(f.document)();
        installBilingualSentenceHighlight({defaultView: null} as Document)();
        vi.stubGlobal('CSS', {highlights: f.registry});
        syncBilingualSentenceHighlight({documentElement: null} as unknown as Document, true);
        syncBilingualSentenceHighlight(f.document, false);
        syncBilingualSentenceHighlight(f.document, true); syncBilingualSentenceHighlight(f.document, true);
        f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        syncBilingualSentenceHighlight(f.document, false); expect(f.highlighted()).toEqual([]);
        syncBilingualSentenceHighlight(f.document, true); f.move(); expect(f.highlighted()).toEqual(['First.', '一句。']);
        f.registry.set(BILINGUAL_HIGHLIGHT_NAME, new Set());
        syncBilingualSentenceHighlight(f.document, false); expect(f.registry.has(BILINGUAL_HIGHLIGHT_NAME)).toBe(true);
    });
});

describe('bilingual sentence hover geometry', () => {
    afterEach(() => vi.unstubAllGlobals());
    const caretPosition = (offsetNode: Node, offset: number): CaretPosition => ({offsetNode, offset, getClientRect: () => null});
    it('uses bounded geometry reads for a late sentence on either side of a long paragraph', () => {
        const source = Array.from({length: 200}, (_, index) => `Line ${index + 1}.`).join(' ');
        const translation = Array.from({length: 200}, (_, index) => `第${index + 1}句。`).join('');
        const f = fixture(`<p id="owner" data-row="10">${source}<span id="translation" data-row="30" class="fluent-read-bilingual-content" data-fr-translation-owned="true">${translation}</span></p>`);
        const sourceNode = f.document.querySelector('#owner')!.firstChild!;
        const translationNode = f.document.querySelector('#translation')!.firstChild!;
        const sourceOffset = source.lastIndexOf('Line 200.') + 2;
        const translationOffset = translation.lastIndexOf('第200句。') + 2;
        f.document.caretPositionFromPoint = (_x, y) => y < 30
            ? caretPosition(sourceNode, sourceOffset)
            : caretPosition(translationNode, translationOffset);
        const dispose = installBilingualSentenceHighlight(f.document);
        for (let frame = 0; frame < 5; frame++) {
            f.move('#owner', sourceOffset * 10 + frame, 15);
            expect(f.highlighted()).toEqual(['Line 200.', '第200句。']);
            f.move('#translation', translationOffset * 10 + frame, 35);
            expect(f.highlighted()).toEqual(['Line 200.', '第200句。']);
        }
        expect(f.geometryReads()).toBeLessThanOrEqual(20);
        dispose();
    });
    it('bounds geometry reads when one sentence spans many inline text nodes', () => {
        const fragments = Array.from({length: 119}, (_, index) => `<span data-row="${index * 20 + 10}">word </span>`).join('');
        const f = fixture(`<p id="owner">${fragments}<span id="tail" data-row="2400">ends here.</span><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">这是完整译文。</span></p>`);
        const tail = f.document.querySelector('#tail')!;
        f.document.caretPositionFromPoint = () => caretPosition(tail.firstChild!, 2);
        const dispose = installBilingualSentenceHighlight(f.document);
        for (const x of [20, 22]) {
            f.move('#tail', x, 2405);
            expect(f.highlighted().join('')).toBe('word '.repeat(119) + 'ends here.这是完整译文。');
        }
        expect(f.geometryReads()).toBeLessThanOrEqual(4);
        dispose();
    });
    it('checks both sides of a caret boundary and verifies current geometry before painting', () => {
        const moreSource = ' Sentence.'.repeat(32);
        const moreTranslation = '后一句。'.repeat(32);
        const f = fixture(`<p id="owner" data-row="10">First. Second.${moreSource}<span data-row="30" class="fluent-read-bilingual-content" data-fr-translation-owned="true">一句。二句。${moreTranslation}</span></p>`);
        const owner = f.document.querySelector('#owner')!;
        const translation = owner.querySelector('.fluent-read-bilingual-content')!;
        let point: CaretPosition | null = caretPosition(translation.firstChild!, 3);
        const caret = vi.fn(() => point);
        f.document.caretPositionFromPoint = caret;
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move('.fluent-read-bilingual-content', 29, 35);
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        f.move('.fluent-read-bilingual-content', 31, 35);
        expect(f.highlighted()).toEqual(['Second.', '二句。']);
        expect(caret).toHaveBeenCalledTimes(2);
        for (const unavailablePoint of [null, caretPosition(owner.firstChild!, 2), caretPosition(translation, 0)]) {
            point = unavailablePoint;
            f.move('.fluent-read-bilingual-content', 20, 35);
            expect(f.highlighted()).toEqual(['First.', '一句。']);
            f.move('.fluent-read-bilingual-content', 45, 35);
            expect(f.highlighted()).toEqual(['Second.', '二句。']);
        }
        // 即使光标 API 指向另一句，实际命中的文字仍应走几何回退。
        point = caretPosition(owner.firstChild!, 2);
        f.move('#owner', 90, 15);
        expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.move('#owner', 65, 15);
        expect(f.highlighted()).toEqual([]);
        f.move('#owner', 20, 15);
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        // 不发送 mutation，模拟外部排版变化，下一帧仍须使用实时几何。
        owner.setAttribute('data-row', '100');
        f.move('#owner', 20, 15);
        expect(f.highlighted()).toEqual([]);
        f.move('#owner', 20, 105);
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        dispose();
    });
});

describe('large bilingual owners through the public hover lifecycle', () => {
    afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
    function deepFixture(depth = 20_000) {
        const f = fixture();
        const owner = f.document.querySelector('#owner')!;
        const text = owner.firstChild!;
        const root = f.document.createElement('span');
        let leaf = root;
        for (let i = 0; i < depth; i++) {
            const next = f.document.createElement('span'); leaf.append(next); leaf = next;
        }
        leaf.append(text); owner.prepend(root);
        return f;
    }
    function finish(f: ReturnType<typeof fixture>) {
        let frames = 0;
        while (f.frames.size) {expect(++frames).toBeLessThan(1000); f.flush();}
        return frames;
    }
    it('highlights 20,000 nested elements without recursion and yields before completing the owner', () => {
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const f = deepFixture(); const dispose = installBilingualSentenceHighlight(f.document);
        const text = f.document.querySelector('#owner')!.textContent;
        expect(() => f.move()).not.toThrow();
        expect(f.highlighted()).toEqual([]);
        expect(f.frames.size).toBe(1);
        expect(finish(f)).toBeGreaterThanOrEqual(1);
        expect(f.highlighted()).toEqual(['First.', '一句。']);
        expect(f.document.querySelector('#owner')!.textContent).toBe(text);
        dispose();
    });
    it('yields over empty text nodes without creating zero-length ranges or losing readable text', () => {
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const f = fixture(); const owner = f.document.querySelector('#owner')!;
        const nodes = f.document.createDocumentFragment();
        for (let i = 0; i < 20_000; i++) nodes.append(f.document.createTextNode(''));
        owner.prepend(nodes);
        const ranges = vi.spyOn(f.document, 'createRange');
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.frames.size).toBe(1);
        finish(f); expect(f.highlighted()).toEqual(['First.', '一句。']);
        expect(ranges).toHaveBeenCalledTimes(4);
        f.move('.fluent-read-bilingual-content', 45, 35);
        expect(f.highlighted()).toEqual(['Second.', '二句。']);
        expect(ranges).toHaveBeenCalledTimes(4);
        dispose();
    });
    it('skips repeated oversized collection until the source changes', () => {
        const f = fixture('<p id="owner" data-row="10">' + 'x'.repeat(100_001) + '<b id="tail">Unvisited.</b><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span></p>');
        const style = vi.mocked(f.window.getComputedStyle);
        const read = vi.fn(style);
        vi.stubGlobal('getComputedStyle', read);
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); finish(f);
        f.move(); f.move('.fluent-read-bilingual-content', 20, 55); finish(f);
        expect(f.highlighted()).toEqual([]);
        // 超过上限后，既不读取段尾和译文，也不因同段内移动而重扫。
        expect(read.mock.calls.map(([element]) => (element as Element).id)).toEqual(['owner']);
        const owner = f.document.querySelector('#owner')!;
        owner.firstChild!.textContent = 'Source.';
        f.document.querySelector('#tail')!.remove();
        f.mutate(owner);
        f.move(); finish(f);
        expect(f.highlighted()).toEqual(['Source.', '译文。']);
        dispose();
    });
    it('yields while collecting a sparse translation and invalidates both maps when it changes', () => {
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const f = fixture(); const wrapper = f.document.querySelector('.fluent-read-bilingual-content')!;
        const nodes = f.document.createDocumentFragment();
        for (let i = 0; i < 20_000; i++) nodes.append(f.document.createTextNode(''));
        wrapper.prepend(nodes);
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.frames.size).toBe(1); expect(f.highlighted()).toEqual([]);
        f.mutate(wrapper); expect(f.frames.size).toBe(0);
        f.move('.fluent-read-bilingual-content', 45, 35); finish(f);
        expect(f.highlighted()).toEqual(['Second.', '二句。']); dispose();
    });
    it('counts line breaks against the shared limit and rejects excess translation text', () => {
        for (const html of [
            '<p id="owner">' + 'x'.repeat(100_000) + '<br><span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span></p>',
            '<p id="owner">' + 'x'.repeat(99_999) + '<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文。</span></p>',
        ]) {
            const f = fixture(html); const dispose = installBilingualSentenceHighlight(f.document);
            f.move(); finish(f); expect(f.highlighted()).toEqual([]); dispose();
        }
    });
    it('cancels partial work on mutation, scroll and disable, then rebuilds from the latest source', () => {
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const f = deepFixture();
        syncBilingualSentenceHighlight(f.document, true);
        for (const cancel of [() => f.mutate(), () => f.document.dispatchEvent(new f.window.Event('scroll'))]) {
            f.move(); expect(f.frames.size).toBe(1); cancel(); expect(f.frames.size).toBe(0);
        }
        f.move(); syncBilingualSentenceHighlight(f.document, false);
        expect(f.frames.size).toBe(0); expect(f.highlighted()).toEqual([]);
        let leaf = f.document.querySelector('#owner > span')!;
        while (leaf.firstElementChild) leaf = leaf.firstElementChild;
        leaf.firstChild!.textContent = 'Changed. Second.';
        syncBilingualSentenceHighlight(f.document, true); f.move(); finish(f);
        expect(f.highlighted()).toEqual(['Changed.', '一句。']);
        syncBilingualSentenceHighlight(f.document, false);
    });
    it('uses the latest side and pointer while collecting, and abandons work when the pointer leaves', () => {
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const f = deepFixture();
        const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); f.move('.fluent-read-bilingual-content', 45, 35); finish(f);
        expect(f.highlighted()).toEqual(['Second.', '二句。']);
        f.mutate(); f.move(); f.move('#outside');
        expect(f.frames.size).toBe(0); expect(f.highlighted()).toEqual([]);
        dispose();
    });
    it('yields when a style read uses the frame time budget and finishes both sides on later frames', () => {
        let time = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => time += 5);
        const f = deepFixture(256); const dispose = installBilingualSentenceHighlight(f.document);
        f.move(); expect(f.frames.size).toBe(1); expect(f.highlighted()).toEqual([]);
        expect(finish(f)).toBeGreaterThan(1);
        expect(f.highlighted()).toEqual(['First.', '一句。']); dispose(); dispose();
    });
});


describe('bounded sentence iteration before alignment', () => {
    afterEach(() => vi.unstubAllGlobals());
    function segmentFixture(chunks: Map<string, string[]>) {
        const reads = new Map<string, number>();
        const closed = new Set<string>();
        class Segmenter {
            segment(text: string) {
                return {
                    *[Symbol.iterator]() {
                        try {
                            for (const segment of chunks.get(text) ?? []) {
                                reads.set(text, (reads.get(text) ?? 0) + 1);
                                yield {segment};
                            }
                        } finally {closed.add(text);}
                    },
                };
            }
        }
        vi.stubGlobal('Intl', {...Intl, Segmenter});
        return {reads, closed};
    }
    it('stops an oversized source at the first rejected sentence and never segments its translation', () => {
        const parts = Array<string>(5000).fill('Sentence. '); const source = parts.join('');
        const f = segmentFixture(new Map([[source, parts], ['译文。', ['译文。']]]));
        expect(alignBilingualSentences(source, '译文。')).toEqual([]);
        expect(f.reads.get(source)).toBe(257); expect(f.closed.has(source)).toBe(true);
        expect(f.reads.has('译文。')).toBe(false);
    });
    it('stops an oversized translation and releases its iterator after accepting a short source', () => {
        const parts = Array<string>(5000).fill('句子。'); const translation = parts.join('');
        const f = segmentFixture(new Map([['Source.', ['Source.']], [translation, parts]]));
        expect(alignBilingualSentences('Source.', translation)).toEqual([]);
        expect(f.reads.get('Source.')).toBe(1); expect(f.reads.get(translation)).toBe(257);
        expect(f.closed.has(translation)).toBe(true);
    });
    it('keeps the unrestricted public span result and rejects rather than truncates a bounded result', () => {
        const parts = Array<string>(300).fill('Sentence. '); const source = parts.join('');
        segmentFixture(new Map([[source, parts]]));
        expect(sentenceSpans(source)).toHaveLength(300);
        expect(sentenceSpans(source, 256)).toEqual([]);
        expect(sentenceSpans(source, 300)).toHaveLength(300);
    });
    it('counts trimmed sentences after abbreviation merging, not raw native segments', () => {
        const parts = [...Array<string>(255).fill('Done. '), 'Dr. ', 'Smith left.  ', '  '];
        const source = parts.join(''); const translation = '句子。'.repeat(256);
        const f = segmentFixture(new Map([[source, parts], [translation, Array<string>(256).fill('句子。')]]));
        const pairs = alignBilingualSentences(source, translation);
        expect(pairs).toHaveLength(256);
        expect(source.slice(pairs.at(-1)!.source.start, pairs.at(-1)!.source.end)).toBe('Dr. Smith left.');
        expect(pairs.at(-1)!.translation.end).toBe(translation.length);
        expect(f.reads.get(source)).toBe(parts.length);
    });
    it('rejects the next genuine sentence after an abbreviation merged at the cap', () => {
        const parts = [...Array<string>(255).fill('Done. '), 'Dr. ', 'Smith left. ', ...Array<string>(500).fill('Extra. ')];
        const source = parts.join(''); const f = segmentFixture(new Map([[source, parts]]));
        expect(sentenceSpans(source, 256)).toEqual([]);
        expect(f.reads.get(source)).toBe(258); expect(f.closed.has(source)).toBe(true);
    });
    it('preserves the exact native cap and UTF16 coordinates at both ends', () => {
        const source = '  🧪 Sentence. '.repeat(256); const translation = '  句子。 '.repeat(256);
        const pairs = alignBilingualSentences(source, translation);
        expect(pairs).toHaveLength(256);
        expect(source.slice(pairs[0].source.start, pairs[0].source.end)).toBe('🧪 Sentence.');
        expect(pairs.at(-1)!.source.end).toBe(source.trimEnd().length);
        expect(pairs.at(-1)!.translation.end).toBe(translation.trimEnd().length);
    });
    it('applies the same cap in the fallback and preserves short quoted sentence coordinates', () => {
        vi.stubGlobal('Intl', {...Intl, Segmenter: undefined});
        expect(alignBilingualSentences('Sentence. '.repeat(5000), '译文。')).toEqual([]);
        expect(sentenceSpans('句子。'.repeat(5000), 256)).toEqual([]);
        const text = '  🧪 Dr. Smith paid 3.14 dollars. “Ready?” Next!  ';
        expect(sentenceSpans(text).map(span => text.slice(span.start, span.end)))
            .toEqual(['🧪 Dr. Smith paid 3.14 dollars.', '“Ready?”', 'Next!']);
    });
});
