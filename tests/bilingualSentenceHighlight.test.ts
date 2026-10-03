import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {alignBilingualSentences, sentenceSpans} from '@/src/core/translation/sentenceAlignment';
import {BILINGUAL_HIGHLIGHT_NAME, installBilingualSentenceHighlight} from '@/src/features/full-page-translation/content/sentenceHighlight';
import {BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID, syncBilingualSentenceHighlight} from '@/src/app/content/bilingualSentenceHighlight';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE, MAX_SENTENCE_HIGHLIGHT_PROFILES, SENTENCE_HIGHLIGHT_STYLES, buildSentenceHighlightAppearanceCss, getSentenceHighlightAppearanceStyle, normalizeSentenceHighlightAppearance, normalizeSentenceHighlightProfiles, parseSentenceHighlightCustomCss, resolveSentenceHighlightAppearance} from '@/src/core/config/sentenceHighlight';

describe('sentence highlight custom appearance', () => {
    afterEach(() => vi.unstubAllGlobals());
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

function fixture(html = '<p id="owner" data-row="10">First. Second.<span data-row="30" class="fluent-read-bilingual-content" data-fr-translation-owned="true">一句。二句。</span></p>') {
    const {document, window} = parseHTML(`<html><body>${html}<aside id="outside">Outside.</aside></body></html>`);
    const registry = new Map<string, Set<Range>>();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    let collapsed = true;
    const callback: {value?: MutationCallback} = {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('CSS', {highlights: registry});
    vi.stubGlobal('Highlight', Set);
    const Observer = class {constructor(cb: MutationCallback) {callback.value = cb;} observe = observe; disconnect = disconnect;};
    Object.defineProperty(document, 'defaultView', {value: new Proxy(window, {get: (target, name) => name === 'MutationObserver' ? Observer : Reflect.get(target, name)})});
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {frames.set(++frameId, cb); return frameId;});
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({display: element.style.display, visibility: element.style.visibility}));
    document.getSelection = () => ({isCollapsed: collapsed} as Selection);
    document.createRange = () => {
        let node: Text; let start: number; let end: number;
        return {
            setStart(n: Text, s: number) {node = n; start = s;},
            setEnd(_n: Text, e: number) {end = e;},
            toString: () => node.data.slice(start, end),
            getClientRects: () => {
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
    return {document, window, registry, move, flush, highlighted, mutate, disconnect, observe, frames, select: () => {collapsed = false;}};
}

describe('paint-only bilingual hover lifecycle', () => {
    afterEach(() => vi.unstubAllGlobals());
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
