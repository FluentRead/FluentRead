import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';
import {extractTranslationText, extractTranslationTextFromNodes} from '@/src/core/translation/text';
import {compileSiteRulePack, composeSiteAdapters, getSiteAdapterAttributeFilter, getSiteRuleObservedAttributes, resolveSiteRule} from '@/src/core/site-adaptation/compiler';
import {normalizeSiteAdaptationSettings, parseSiteRulePack, SITE_RULE_LIMITS, validateSelectors} from '@/src/core/site-adaptation/schema';
import type {SiteRule, SiteRulePack} from '@/src/core/site-adaptation/types';
import {asHTMLElement, createMutationRescanSelector, createTranslationMutationObserverOptions} from '@/src/features/full-page-translation/content/mutationObservation';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';

const rule = (extra: Partial<SiteRule> = {}): SiteRule => ({
    id: 'example', name: 'Example', match: {hosts: ['example.test']}, ...extra,
});
const pack = (rules: SiteRule[] = [rule()]): SiteRulePack => ({version: 1, rules});

describe('mutation rescan readiness', () => {
    function fixture() {
        const {document} = parseHTML('<html><body><section id="a"></section><section id="b"></section><section id="c"></section></body></html>');
        const roots = ['a', 'b', 'c'].map(id => document.getElementById(id)!);
        const queue = {dirtyRoots: new Set<Node>(roots), broadRescanRoots: new WeakSet<Node>(), broadRescanCooldowns: new WeakMap<Node, number>()};
        return {document, roots, queue};
    }

    it('不把缺少渲染契约的节点交给页面状态恢复', () => {
        const {document, roots: [root]} = fixture();
        expect(asHTMLElement(root)).toBe(root);
        expect(asHTMLElement(document.createTextNode('source'))).toBeNull();
        expect(asHTMLElement({nodeType: 1})).toBeNull();
        expect(asHTMLElement({nodeType: 1, tagName: 'DIV'})).toBeNull();
    });

    it('冷却根让就绪兄弟按队列顺序前进，到期后仍能扫描', () => {
        const {roots: [a, b, c], queue} = fixture();
        queue.broadRescanRoots.add(a!); queue.broadRescanCooldowns.set(a!, 1000);
        let clock = 100;
        const selection = createMutationRescanSelector(queue, () => clock, false);
        expect(selection.take()).toBe(b); expect(selection.take()).toBe(c); expect(selection.take()).toBeNull();
        expect([...queue.dirtyRoots]).toEqual([a]); expect(selection.delay()).toBe(16);
        const waiting = createMutationRescanSelector(queue, () => clock, false);
        expect(waiting.take()).toBeNull(); expect(waiting.delay()).toBe(900);
        clock = 1000;
        expect(createMutationRescanSelector(queue, () => clock, false).take()).toBe(a);
        expect(queue.dirtyRoots.size).toBe(0);
    });

    it('所有根冷却时每片只检查一轮，并等待最早期限且至少让出16毫秒', () => {
        const {roots, queue} = fixture();
        roots.forEach((root, index) => {queue.broadRescanRoots.add(root); queue.broadRescanCooldowns.set(root, [1100, 400, 700][index]!);});
        let clock = 100, clockReads = 0;
        const selection = createMutationRescanSelector(queue, () => {clockReads += 1; return clock;}, false);
        expect(selection.take()).toBeNull(); expect([...queue.dirtyRoots]).toEqual(roots);
        expect(selection.delay()).toBe(300);
        const readsAfterRound = clockReads;
        expect(selection.take()).toBeNull(); expect(clockReads).toBe(readsAfterRound);
        clock = 399; expect(selection.delay()).toBe(16);
    });

    it('冷却根选择也在八毫秒预算后让出，下一片从未检查的根继续', () => {
        const {roots: [a, b], queue} = fixture();
        queue.dirtyRoots = new Set([a!, b!]); queue.broadRescanRoots.add(a!); queue.broadRescanCooldowns.set(a!, 1000);
        let clock = 0;
        const selection = createMutationRescanSelector(queue, () => clock += 4, false);
        expect(selection.take()).toBeNull(); expect(selection.shouldYield()).toBe(true); expect(selection.delay()).toBe(16);
        expect([...queue.dirtyRoots]).toEqual([b, a]);
        expect(createMutationRescanSelector(queue, () => clock, false).take()).toBe(b);
    });

    it('删除断连根；父级归并提前清空集合和空集合均安全结束', () => {
        const {roots: [a, b, c], queue} = fixture(); a!.remove();
        const selection = createMutationRescanSelector(queue, () => 0, false);
        expect(selection.take()).toBe(b); expect([...queue.dirtyRoots]).toEqual([c]);
        queue.dirtyRoots.clear(); expect(selection.take()).toBeNull(); expect(selection.delay()).toBe(16);
        const empty = createMutationRescanSelector(queue, () => 0, false);
        expect(empty.take()).toBeNull(); expect(empty.delay()).toBe(16); expect(empty.shouldYield()).toBe(false);
    });

    it.each([false, true])('发现期间同步加入的新根下一片复查，不继承纯冷却长等待：初始发现=%s', active => {
        const {roots: [cold, ready, late], queue} = fixture();
        queue.dirtyRoots = new Set(active ? [cold!] : [cold!, ready!]);
        queue.broadRescanRoots.add(cold!); queue.broadRescanCooldowns.set(cold!, 1000);
        const selection = createMutationRescanSelector(queue, () => 100, active);
        if (!active) expect(selection.take()).toBe(ready);
        queue.dirtyRoots.add(late!);
        expect(selection.take()).toBeNull(); expect(selection.delay()).toBe(16);
        expect(createMutationRescanSelector(queue, () => 116, false).take()).toBe(late);
    });

    it.each([false, true])('非广域根不使用旧期限，广域根无期限可立即发现：广域=%s', broad => {
        const {roots: [root], queue} = fixture(); queue.dirtyRoots = new Set([root!]);
        if (broad) queue.broadRescanRoots.add(root!);
        else queue.broadRescanCooldowns.set(root!, 1000);
        expect(createMutationRescanSelector(queue, () => 0, false).take()).toBe(root);
    });
});

describe('Kagi News content-bearing buttons', () => {
    function fixture(scope: 'content' | 'all' = 'content', settings = normalizeSiteAdaptationSettings(undefined), href = 'https://news.kagi.com/world/latest') {
        const {document} = parseHTML(`<html><body><main>
            <button id="headline" aria-label="Expand story" style="display:flex"><span id="label" dir="ltr">France deploys troops to free up police for Saturday protests</span></button>
            <button id="plain-headline" aria-label="Expand story">A story title without an internal label still supports bilingual reading.</button>
            <button id="search">Search</button><button id="settings">Settings</button><button id="read">Mark as read</button>
            <p id="body">Expanded story paragraphs remain ordinary readable content.</p>
        </main><nav><button id="navigation">Choose category</button></nav></body></html>`);
        const core = new TranslationCandidateCore({url: new URL(href), scope, adapters: composeSiteAdapters(builtinSiteRulePack, settings)});
        return {document, core, headline: document.getElementById('headline')!, label: document.getElementById('label')!};
    }

    it.each(['content', 'all'] as const)('keeps headline discovery, hover and label mutation scans on one content owner in %s scope', scope => {
        const {document, core, headline, label} = fixture(scope);
        for (const ariaLabel of ['Expand story', 'Collapse story']) {
            headline.setAttribute('aria-label', ariaLabel);
            const expected = {element: label, kind: 'content', adapterId: 'kagi-news'};
            expect(core.discover(document).filter(candidate => candidate.element === label)).toEqual([expect.objectContaining(expected)]);
            expect(core.resolve(label.firstChild)).toMatchObject(expected);
            expect(core.discover(label)).toEqual([expect.objectContaining(expected)]);
            expect(core.discover(document).some(candidate => candidate.element === headline)).toBe(false);
        }
        for (const id of ['search', 'settings', 'read']) {
            const control = document.getElementById(id)!;
            expect(core.resolve(control.firstChild)).toMatchObject({element: control, kind: 'control'});
        }
        expect(core.resolve(document.getElementById('body')!.firstChild)?.kind).toBe('content');
        const navigation = document.getElementById('navigation')!;
        expect(core.resolve(navigation.firstChild)?.kind).toBe(scope === 'all' ? 'control' : undefined);
        const plain = document.getElementById('plain-headline')!;
        expect(core.resolve(plain.firstChild)).toMatchObject({element: plain, kind: 'content', adapterId: 'kagi-news'});
        expect(compileSiteRulePack(builtinSiteRulePack).find(adapter => adapter.id === 'kagi-news')?.observedAttributes).toContain('aria-label');
        // A newly inserted card must obtain the same narrow exception without rebuilding the core.
        const fresh = document.createElement('button');
        fresh.setAttribute('aria-label', 'Expand story');
        fresh.textContent = 'A newly loaded story appears after changing the news category.';
        document.querySelector('main')!.appendChild(fresh);
        expect(core.discover(fresh)).toEqual([expect.objectContaining({element: fresh, kind: 'content', adapterId: 'kagi-news'})]);
        fresh.setAttribute('aria-label', 'Mark as read');
        expect(core.resolve(fresh.firstChild)).toMatchObject({element: fresh, kind: 'control'});
    });

    it.each(['https://kagi.com/world/latest', 'https://example.test/world/latest'])('retains ordinary control ownership outside the exact host: %s', href => {
        const {core, headline, label} = fixture('content', undefined, href);
        expect(core.resolve(label.firstChild)).toMatchObject({element: headline, kind: 'control'});
    });

    it.each([
        {enabled: false},
        {disabledRuleIds: ['kagi-news']},
        {custom: pack([rule({id: 'kagi-news', match: {hosts: ['news.kagi.com']}})])},
    ])('withdraws the content exception when disabled or replaced: %j', overrides => {
        const settings = {...normalizeSiteAdaptationSettings(undefined), ...overrides};
        const {core, headline, label} = fixture('content', settings);
        expect(core.resolve(label.firstChild)).toMatchObject({element: headline, kind: 'control'});
    });

    it('retains local and custom protection boundaries for explicitly selected headline buttons', () => {
        for (const attributes of ['translate="no"', 'contenteditable="true"', 'hidden', 'class="notranslate"']) {
            const {document, core} = fixture();
            document.querySelector('main')!.innerHTML = `<button id="protected" aria-label="Expand story" ${attributes}>Protected news headline stays original.</button>`;
            const headline = document.getElementById('protected')!;
            expect(core.resolve(headline.firstChild), attributes).toBeNull();
            expect(core.discover(document), attributes).toEqual([]);
        }
        const settings = normalizeSiteAdaptationSettings({custom: pack([rule({
            id: 'private-headline', match: {hosts: ['news.kagi.com']}, protect: ['#headline'],
        })])});
        const {core, label} = fixture('content', settings);
        expect(core.resolve(label.firstChild)).toBeNull();
    });
});

describe('OpenAI community topic list titles', () => {
    it.each(['content', 'all'] as const)('keeps native topic titles translatable in %s scope while preserving their tags', scope => {
        // Reduced from the live /hot DOM: a role=heading span owns status icons and a topic link.
        const {document} = parseHTML(`<html><body><main><table class="topic-list"><tbody><tr class="topic-list-item"><td class="main-link topic-list-data">
            <span id="title" class="link-top-line" role="heading" aria-level="2"><span class="topic-statuses"><svg></svg></span><a class="title raw-link raw-topic-link" href="/t/example/123">How can readers follow this discussion?</a></span>
            <div class="link-bottom-line"><ul class="discourse-tags"><li><a id="tag" class="discourse-tag simple" href="/tag/rate-limit/77">rate-limit</a></li></ul></div>
            </td></tr></tbody></table><div class="cooked"><p id="body">The readable discussion remains available for translation.</p></div></main></body></html>`);
        const url = new URL('https://community.openai.com/hot');
        const core = new TranslationCandidateCore({url, scope, adapters: compileSiteRulePack(builtinSiteRulePack)});
        const title = document.getElementById('title')!;
        const candidate = core.resolve(title.querySelector('a')!.firstChild);
        expect(candidate).toMatchObject({element: title, adapterId: 'openai-community'});
        const candidates = core.discover(document);
        expect(candidates.some(candidate => candidate.element === title)).toBe(true);
        expect(candidates.some(candidate => candidate.element.id === 'body')).toBe(true);
        const source = candidates.map(candidate => extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal)).join('\n');
        expect(source).toContain('How can readers follow this discussion?');
        expect(source).not.toContain('rate-limit');
        expect(core.resolve(document.getElementById('tag')!.firstChild)).toBeNull();
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(adapter => adapter.id === 'openai-community')!;
        expect(adapter.matches(new URL('https://community.openai.com.example.org/hot'))).toBe(false);
        expect(adapter.matches(new URL('https://openai.com/hot'))).toBe(false);
    });
});

function reject(value: unknown, expectedPath?: string) {
    const parsed = parseSiteRulePack(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('Expected invalid rule pack');
    if (expectedPath) expect(parsed.issues.some((issue) => issue.path === expectedPath)).toBe(true);
    expect(parsed.issues.every((issue) => Boolean(issue.path && issue.message))).toBe(true);
}

describe('site adaptation JSON boundary', () => {
    it('视频与会议原生字幕始终留给字幕功能，页面正文仍可翻译', () => {
        const adapters = compileSiteRulePack(builtinSiteRulePack);
        for (const [href, attributes] of [
            ['https://meet.google.com/abc-defg-hij', 'class="ygicle VbkSUe"'],
            ['https://teams.cloud.microsoft/v2/', 'data-tid="closed-caption-text"'],
            ['https://us02web.zoom.us/wc/123', 'class="live-transcription-subtitle__item"'],
            ['https://www.udemy.com/course/demo/learn/', 'data-purpose="captions-cue-text"'],
            ['https://www.disneyplus.com/video/demo', 'class="dss-hls-subtitle-overlay"'],
        ]) {
            const {document} = parseHTML(`<html><body><p id="caption" ${attributes}>This is a native caption owned by the website player.</p><p id="prose">This is a regular paragraph outside the video player.</p></body></html>`);
            const core = new TranslationCandidateCore({url: new URL(href!), adapters});
            const ids = core.discover(document).map(candidate => candidate.element.id);
            expect(ids, href).not.toContain('caption'); expect(ids, href).toContain('prose');
        }
    });
    it('creates independent normalized data without touching browser globals', () => {
        const input = pack([rule({
            id: 'docs:example', name: ' Example ', priority: -10,
            match: {hosts: ['EXAMPLE.TEST.', 'example.test', '*.example.test'], paths: ['/docs/*'], excludePaths: ['/docs/private/*']},
            mode: 'focus', content: [{css: [' p ', 'p'], resolve: 'closest', atomic: false, key: 'prose'}],
            protect: ['code', 'code'], exclude: ['.private'], watchIgnore: ['time'],
            omit: ['.receipt', '.receipt'], literalLabels: ['.command', '.command'], literalTokens: ['b', 'b'],
        })]);
        const parsed = parseSiteRulePack(input);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error('Expected valid rule pack');
        expect(parsed.pack.rules[0]).toEqual({...input.rules[0], name: 'Example',
            match: {hosts: ['example.test', '*.example.test'], paths: ['/docs/*'], excludePaths: ['/docs/private/*']},
            content: [{css: ['p'], resolve: 'closest', atomic: false, key: 'prose'}], protect: ['code'],
            omit: ['.receipt'], literalLabels: ['.command'], literalTokens: ['b']});
        input.rules[0]!.content![0]!.css.push('aside');
        expect(parsed.pack.rules[0]!.content![0]!.css).toEqual(['p']);
        expect(parseSiteRulePack({version: 1, profiles: {}, rules: []})).toEqual({ok: true, pack: {version: 1, profiles: {}, rules: []}});
        expect(parseSiteRulePack(Object.assign(Object.create(null), {version: 1, rules: []})).ok).toBe(true);
    });

    it.each([null, false, 1, 'json', [], new Date(), new Map()])('rejects non JSON pack objects %s', (value) => reject(value, '$'));

    it('rejects unsupported versions, inherited data, executable and unknown fields', () => {
        reject({version: 2, rules: []}, '$.version');
        reject({version: 1, rules: [], script: 'alert(1)'}, '$.script');
        reject({version: 1, rules: [rule({css: 'body{}'} as never)]}, '$.rules[0].css');
        reject(Object.create({version: 1, rules: []}), '$');
        reject({...pack(), [Symbol('secret')]: 1}, '$');
        const accessor = Object.defineProperty({rules: []}, 'version', {get() { throw new Error('must not execute'); }});
        reject(accessor, '$.version');
        reject(JSON.parse('{"version":1,"rules":[],"__proto__":{"polluted":true}}'), '$.__proto__');
        for (const key of ['constructor', 'prototype', '__proto__']) {
            reject(JSON.parse(`{"version":1,"profiles":{"${key}":{}},"rules":[]}`), `$.profiles.${key}`);
        }
        expect(({} as {polluted?: boolean}).polluted).toBeUndefined();
    });

    it('bounds top level collections and rejects invalid profile records', () => {
        reject({version: 1}, '$.rules');
        reject({...pack(), rules: {}}, '$.rules');
        reject({...pack(), rules: Array.from({length: 2001}, () => rule())}, '$.rules');
        reject({...pack(), profiles: []}, '$.profiles');
        reject({...pack(), profiles: Object.fromEntries(Array.from({length: 101}, (_, index) => [`p${index}`, {}]))}, '$.profiles');
        reject({...pack(), profiles: {'bad name': {}}}, '$.profiles.bad name');
        reject({...pack(), profiles: {prose: {profile: 'nested'}}}, '$.profiles.prose.profile');
        reject(pack([null as never]), '$.rules[0]');
    });

    it('validates the explicit all-scope opt-in without coercing saved values', () => {
        for (const allScopes of [true, false]) {
            const input = pack([rule({allScopes})]);
            expect(parseSiteRulePack(input)).toEqual({ok: true, pack: input});
        }
        for (const allScopes of ['true', 1, null, {}]) {
            reject(pack([rule({allScopes: allScopes as never})]), '$.rules[0].allScopes');
        }
    });

    it('requires bounded, readable identifiers, names and valid priorities', () => {
        for (const id of ['bad id', 'constructor', 'prototype', '__proto__', '$x', 'x'.repeat(97)]) {
            reject(pack([rule({id})]), '$.rules[0].id');
        }
        reject(pack([rule(), rule()]), '$.rules[1].id');
        for (const name of ['', ' ', 7, '\u0000', 'x'.repeat(161)]) reject(pack([rule({name: name as string})]), '$.rules[0].name');
        for (const priority of [Infinity, NaN, 0.5, 10001, -10001, '1']) reject(pack([rule({priority: priority as number})]), '$.rules[0].priority');
        for (const priority of [-10000, 0, 10000]) expect(parseSiteRulePack(pack([rule({priority})])).ok).toBe(true);
    });

    it('rejects missing host lists, URL confusion and unbounded patterns', () => {
        reject(pack([rule({match: null as never})]), '$.rules[0].match');
        reject(pack([rule({match: {hosts: [], script: 'x'} as never})]), '$.rules[0].match.script');
        for (const hosts of [[], 'example.test', ['x'.repeat(256)], Array(129).fill('example.test')]) {
            reject(pack([rule({match: {hosts: hosts as string[]}})]), '$.rules[0].match.hosts' + (Array.isArray(hosts) && hosts.length === 1 ? '[0]' : ''));
        }
        for (const host of ['https://example.test', 'example.test:443', 'example.test/path', '*example.test', '**.example.test', '.example.test', '-example.test', 'example_.test', 'example.test@evil.test']) {
            reject(pack([rule({match: {hosts: [host]}})]), '$.rules[0].match.hosts[0]');
        }
        for (const path of ['docs/*', '/docs?x=*', '/docs#x', '/docs\\x']) {
            reject(pack([rule({match: {hosts: ['example.test'], paths: [path]}})]), '$.rules[0].match.paths[0]');
        }
        reject(pack([rule({match: {hosts: ['example.test'], excludePaths: []}})]), '$.rules[0].match.excludePaths');
    });

    it('checks recipe fields, selector lists and one-level profile references', () => {
        reject(pack([rule({mode: 'unsafe' as never})]), '$.rules[0].mode');
        reject(pack([rule({profile: 'missing'})]), '$.rules[0].profile');
        for (const content of [[], {}, Array(129).fill({css: ['p']})]) reject(pack([rule({content: content as never})]), '$.rules[0].content');
        reject(pack([rule({content: [null as never]})]), '$.rules[0].content[0]');
        reject(pack([rule({content: [{css: ['p'], resolve: 'xpath' as never}]})]), '$.rules[0].content[0].resolve');
        reject(pack([rule({content: [{css: ['p'], atomic: 1 as never}]})]), '$.rules[0].content[0].atomic');
        reject(pack([rule({content: [{css: ['p'], splitOnBr: 1 as never}]})]), '$.rules[0].content[0].splitOnBr');
        for (const splitOnBr of [true, false]) {
            expect(parseSiteRulePack(pack([rule({content: [{css: ['p'], splitOnBr}]})])).ok).toBe(true);
        }
        reject(pack([rule({content: [{css: ['p'], key: ''}]})]), '$.rules[0].content[0].key');
        reject(pack([rule({content: [{css: []}]})]), '$.rules[0].content[0].css');
        reject(pack([rule({protect: ['x'.repeat(1025)]})]), '$.rules[0].protect[0]');
        reject(pack([rule({protect: ['p\n']})]), '$.rules[0].protect[0]');
        for (const field of ['omit', 'literalLabels', 'literalTokens'] as const) {
            reject(pack([rule({[field]: []})]), `$.rules[0].${field}`);
            reject(pack([rule({[field]: ['x'.repeat(1025)]})]), `$.rules[0].${field}[0]`);
        }
        expect(parseSiteRulePack({...pack([rule({profile: 'prose'})]), profiles: {prose: {content: [{css: ['p'], resolve: 'self', atomic: true}]}}}).ok).toBe(true);
    });

    it('caps the UTF-8 payload size even if each individual entry is valid', () => {
        const css = Array.from({length: 128}, (_, index) => `.${'a'.repeat(1000)}${index}`);
        const large = pack(Array.from({length: 8}, (_, index) => rule({id: `r${index}`, protect: css, exclude: css, watchIgnore: css})));
        expect(JSON.stringify(large).length).toBeGreaterThan(SITE_RULE_LIMITS.bytes);
        reject(large, '$');
    });

    it('requires effective content for focus mode after resolving its profile', () => {
        reject(pack([rule({mode: 'focus'})]), '$.rules[0].content');
        reject({...pack([rule({profile: 'empty'})]), profiles: {empty: {mode: 'focus'}}}, '$.rules[0].content');
        expect(parseSiteRulePack({...pack([rule({profile: 'prose'})]), profiles: {prose: {mode: 'focus', content: [{css: ['p']}]}}}).ok).toBe(true);
        expect(parseSiteRulePack({...pack([rule({profile: 'empty', content: [{css: ['p']}]})]), profiles: {empty: {mode: 'focus'}}}).ok).toBe(true);
        expect(parseSiteRulePack({...pack([rule({profile: 'empty', mode: 'augment'})]), profiles: {empty: {mode: 'focus'}}}).ok).toBe(true);
    });

    it('normalizes persisted settings without retaining invalid custom data', () => {
        const defaults = {enabled: true, disabledRuleIds: [], custom: {version: 1, rules: []}};
        expect(normalizeSiteAdaptationSettings(undefined)).toEqual(defaults);
        expect(normalizeSiteAdaptationSettings({})).toEqual(defaults);
        expect(normalizeSiteAdaptationSettings({enabled: 'false', disabledRuleIds: {}})).toEqual(defaults);
        expect(normalizeSiteAdaptationSettings({enabled: false, disabledRuleIds: ['example', 'example', '__proto__', 'bad name', 1], custom: pack()}))
            .toEqual({enabled: false, disabledRuleIds: ['example'], custom: pack()});
        expect(normalizeSiteAdaptationSettings({custom: {version: 999, rules: []}}).custom.rules).toEqual([]);
        expect(normalizeSiteAdaptationSettings({disabledRuleIds: Array.from({length: 2001}, (_, index) => `r${index}`)}).disabledRuleIds).toHaveLength(2000);
    });

    it('reports browser selector errors at precise profile and rule paths', () => {
        const {document} = parseHTML('<html></html>');
        expect(validateSelectors(pack(), document)).toEqual([]);
        const rules: SiteRulePack = {...pack([rule({content: [{css: ['p', '[broken=']}], protect: ['[broken='], exclude: ['code'], watchIgnore: ['time']})]),
            profiles: {prose: {content: [{css: ['[broken=']}], protect: ['button']}}};
        expect(validateSelectors(rules, document).map((issue) => issue.path)).toEqual([
            '$.profiles.prose.content[0].css[0]', '$.rules[0].protect[0]', '$.rules[0].content[0].css[1]',
        ]);
        expect(compileSiteRulePack(rules)[0]!.decide(document.createElement('p'), {url: new URL('https://example.test')})).toMatchObject({kind: 'force-target'});
        expect(validateSelectors(pack([rule({omit: ['[bad='], literalLabels: ['[bad='], literalTokens: ['[bad=']})]), document).map(issue => issue.path))
            .toEqual(['$.rules[0].omit[0]', '$.rules[0].literalLabels[0]', '$.rules[0].literalTokens[0]']);
    });
});

describe('site adaptation compilation', () => {
    it('applies only explicitly opted-in rules to all scope and honors disabling and overrides', () => {
        const {document} = parseHTML('<html><body><h1 class="model-name">Model Name</h1><p>Readable description</p></body></html>');
        const title = document.querySelector('h1')!;
        const description = document.querySelector('p')!;
        for (const allScopes of [undefined, false, true]) {
            const builtin = pack([rule({omit: ['.model-name'], ...(allScopes === undefined ? {} : {allScopes})})]);
            const settings = normalizeSiteAdaptationSettings(undefined);
            const create = () => new TranslationCandidateCore({url: new URL('https://example.test'), scope: 'all', adapters: composeSiteAdapters(builtin, settings)});
            const core = create();
            expect(core.resolve(title.firstChild) === null).toBe(allScopes === true);
            expect(core.shouldStayOriginal(title)).toBe(allScopes === true);
            expect(core.shouldOmitFromTranslation(title)).toBe(allScopes === true);
            expect(core.resolve(description.firstChild)?.element).toBe(description);
            settings.disabledRuleIds = ['example'];
            expect(create().resolve(title.firstChild)?.element).toBe(title);
            settings.disabledRuleIds = [];
            settings.custom = pack([rule({protect: ['.model-name'], allScopes: false})]);
            expect(create().resolve(title.firstChild)?.element).toBe(title);
        }
    });
    it('compiles metadata omission into candidate, request and bilingual boundaries and observes dynamic selectors', () => {
        const {document} = parseHTML('<html><body><p id="body">Readable sentence <code id="literal">CODE_TOKEN</code><span id="metadata" data-receipt="no">Delivery metadata</span></p></body></html>');
        const adapters = compileSiteRulePack(pack([rule({protect: ['code'], omit: ['[data-receipt="yes"]']})]));
        expect(adapters[0]!.observedAttributes).toContain('data-receipt');
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters});
        const body = document.querySelector<HTMLElement>('#body')!;
        const metadata = document.querySelector('#metadata')!;
        const snapshot = () => createTranslationSourceSnapshot(body, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot().slots.map(slot => slot.source)).toContain('Delivery metadata');
        metadata.setAttribute('data-receipt', 'yes');
        const protectedSnapshot = snapshot();
        expect(core.resolve(metadata.firstChild)).toBeNull();
        expect(protectedSnapshot.slots.map(slot => slot.source)).toEqual(['Readable sentence']);
        expect(protectedSnapshot.clone.querySelector('#metadata')).toBeNull();
        expect(protectedSnapshot.clone.querySelector('#literal')?.textContent).toBe('CODE_TOKEN');
        expect(document.querySelector('#metadata')).toBe(metadata);
        expect(metadata.textContent).toBe('Delivery metadata');
        expect(core.shouldIgnoreMutation(metadata)).toBe(false);
        metadata.setAttribute('data-receipt', 'no');
        expect(snapshot().slots.map(slot => slot.source)).toContain('Delivery metadata');
    });

    it('retains metadata and literal boundaries through profiles, standalone export and custom replacement', () => {
        const input: SiteRulePack = {version: 1, profiles: {labels: {
            omit: ['.receipt'], literalLabels: ['.command'], literalTokens: ['b'],
        }}, rules: [rule({profile: 'labels', omit: ['.receipt', '.status'], literalLabels: ['.command', '.option'], literalTokens: ['b', 'i']})]};
        const resolved = resolveSiteRule(input, input.rules[0]!);
        expect(resolved.omit).toEqual(['.receipt', '.status']);
        expect(resolved.literalLabels).toEqual(['.command', '.option']);
        expect(resolved.literalTokens).toEqual(['b', 'i']);
        const reparsed = parseSiteRulePack(JSON.parse(JSON.stringify(pack([resolved]))));
        if (!reparsed.ok) throw new Error(JSON.stringify(reparsed.issues));
        expect(reparsed.pack.rules[0]).toEqual(resolved);
        const {document} = parseHTML('<html><body><p class="command" data-label="yes"><b>unknown-command</b> (manual)</p><p class="receipt">Delivered receipt</p><p class="command" id="prose"><b>unknown-command</b> explains ordinary prose.</p></body></html>');
        const label = document.querySelector('.command')!;
        const receipt = document.querySelector('.receipt')!;
        const prose = document.querySelector('#prose')!;
        const makeCore = (custom: SiteRulePack, disabledRuleIds: string[] = []) => new TranslationCandidateCore({url: new URL('https://example.test'),
            adapters: composeSiteAdapters(input, {enabled: true, disabledRuleIds, custom})});
        const original = makeCore(pack([]));
        for (const element of [label, receipt]) {
            expect(original.shouldStayOriginal(element)).toBe(true);
            expect(original.shouldOmitFromTranslation(element)).toBe(true);
            expect(original.resolve(element.firstChild)).toBeNull();
        }
        expect(original.shouldIgnoreMutation(label)).toBe(true);
        expect(original.shouldStayOriginal(prose)).toBe(false);
        expect(original.shouldStayOriginal(prose.querySelector('b')!)).toBe(true);
        for (const customCore of [makeCore(pack([rule()])), makeCore(pack([]), ['example'])]) {
            expect(customCore.shouldStayOriginal(label)).toBe(false);
            expect(customCore.shouldOmitFromTranslation(receipt)).toBe(false);
            expect(customCore.shouldIgnoreMutation(label)).toBe(false);
            expect(customCore.shouldStayOriginal(prose.querySelector('b')!)).toBe(false);
        }
        expect(getSiteRuleObservedAttributes({literalLabels: ['[data-label="yes"]']}))
            .toEqual(['id', 'class', 'data-fr-translation-owned', 'data-label']);
        expect(getSiteRuleObservedAttributes({literalLabels: ['p:has(+ .description)']})).toBeNull();
        expect(getSiteRuleObservedAttributes({literalTokens: ['[data-literal]']})).toContain('data-literal');
    });

    it('Codeforces countdown stays live only in the source and does not enter paragraph identity or output', () => {
        const document = parseHTML(`<html><body><div id="sidebar"><div id="card"><span class="contest-state-phase">Before contest</span><br><a href="/contests/2260">Educational round</a><br><span class="countdown">24:23:12</span><br><a href="/register">Register now</a></div></div><p>Ordinary problem statement.</p></body></html>`).document;
        const core = new TranslationCandidateCore({url: new URL('https://codeforces.com/'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        const card = document.querySelector<HTMLElement>('#card')!;
        const clock = card.querySelector<HTMLElement>('.countdown')!;
        const snapshot = () => createTranslationSourceSnapshot(card, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        const before = snapshot();
        expect(before.clone.querySelector('.countdown')).toBeNull();
        expect(before.slots.map(slot => slot.source)).toEqual(['Before contest', 'Educational round', 'Register now']);
        expect(core.shouldIgnoreMutation(clock)).toBe(true);
        expect(core.shouldIgnoreMutation(card.querySelector('.contest-state-phase')!)).toBe(false);
        expect(core.resolve(clock.firstChild)).toBeNull();
        const cardTargets = core.discover(document).filter(candidate => card.contains(candidate.element));
        expect(cardTargets.map(candidate => candidate.element.textContent)).toEqual(['Before contest', 'Educational round', 'Register now']);
        expect(cardTargets.some(candidate => candidate.element === card)).toBe(false);
        clock.textContent = '24:23:11';
        expect(snapshot().clone.innerHTML).toBe(before.clone.innerHTML);
        expect(card.querySelector('.countdown')).toBe(clock);
        expect(core.discover(document).some(candidate => candidate.element.tagName === 'P')).toBe(true);
        const other = new TranslationCandidateCore({url: new URL('https://codeforces.com.example.org/'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        expect(other.shouldOmitFromTranslation(clock)).toBe(false);
    });

    it('keeps built-in GitHub, chat, Discord and manual boundaries fully replaceable through their JSON IDs', () => {
        expect(parseSiteRulePack(builtinSiteRulePack)).toMatchObject({ok: true});
        for (const [id, url, html, selector] of [
            ['github', 'https://github.com/orgs/example/repositories', '<div class="ReposListItem-module__TopicsList"><span>unknown-language</span></div>', 'span'],
            ['github', 'https://github.com/orgs/example/repositories', '<ul data-listview-component="items-list"><li><div class="TopicsList__XBoKUv"><span>unknown-language</span></div></li></ul>', 'span'],
            ['github', 'https://github.com/orgs/example/repositories', '<ul data-listview-component="items-list"><li><div class="LabelsContainer__Bi_rOW"><span>unknown-language</span></div></li></ul>', 'span'],
            ['x-chat', 'https://chat.x.com/conversation', '<div class="flex items-center ml-auto shrink-0 gap-1">Delivered receipt</div>', 'div'],
            ['discord-messages', 'https://discord.com/channels/1/2', '<div id="message-content-1"><span class="timestamp_test">Edited receipt</span></div>', 'span'],
            ['ubuntu-manpage', 'https://manpages.ubuntu.com/manpages/noble/man8/apt.8.html', '<div id="manpage-content"><h2 id="description"></h2><section class="Sh"><p class="Pp"><b>unknown-operation</b></p><div class="Bd-indent">Explanation remains readable.</div></section></div>', 'p'],
        ]) {
            const builtin = builtinSiteRulePack.rules.find(item => item.id === id)!;
            const {document} = parseHTML(`<html><body>${html}</body></html>`);
            const element = document.querySelector(selector!)!;
            const core = (custom: SiteRulePack) => new TranslationCandidateCore({url: new URL(url!), adapters:
                composeSiteAdapters(builtinSiteRulePack, {enabled: true, disabledRuleIds: [], custom})});
            expect(core(pack([])).shouldOmitFromTranslation(element), id).toBe(true);
            expect(core(pack([{id: builtin.id, name: builtin.name, match: builtin.match}])).shouldOmitFromTranslation(element), id).toBe(false);
        }
    });

    it('computes each compiled rule observation filter on demand with the same result, including unobservable null', () => {
        const [unobservable] = compileSiteRulePack(pack([rule({content: [{css: ['p:has(+ .description)']}]})]));
        expect(unobservable!.observedAttributes).toBeNull();
        expect(unobservable!.observedAttributes).toBeNull();
        const compiled = compileSiteRulePack(builtinSiteRulePack);
        expect(compiled).toHaveLength(builtinSiteRulePack.rules.length);
        compiled.forEach((adapter, index) => {
            const expected = getSiteRuleObservedAttributes(resolveSiteRule(builtinSiteRulePack, builtinSiteRulePack.rules[index]!));
            expect(adapter.observedAttributes, adapter.id).toEqual(expected);
            expect(adapter.observedAttributes, adapter.id).toBe(adapter.observedAttributes);
        });
    });

    it('observes selector dependencies in targets, protection, exclusions and mutation exclusions', () => {
        expect(getSiteRuleObservedAttributes({})).toEqual(['id', 'class']);
        expect(getSiteRuleObservedAttributes({
            content: [{css: ['#copy.main[DATA-STATE="read"]:is(p,li):lang(en):dir(ltr)', '[data-title="a[b] c"]', "[data-tags ~= 'hello world' i]", '[lang|=en]', '[data-id^=post]']}],
            protect: ['[data-secret]'], exclude: ['[data-private="true"]'], watchIgnore: ['[data-clock]'],
        })).toEqual(['id', 'class', 'data-state', 'lang', 'dir', 'data-title', 'data-tags', 'data-id', 'data-secret', 'data-private', 'data-clock']);
        for (const css of ['[data\\-state]', 'p/* comment */[data-state]', '[svg|href]', '[属性]', '[broken=', 'p]', '::before', ':9', ':checked', ':has([data-state])']) {
            expect(getSiteRuleObservedAttributes({content: [{css: [css]}]}), css).toBeNull();
        }
        const adapter = compileSiteRulePack(pack([rule({content: [{css: ['p[data-ready]']}], protect: ['[data-secret]']})]))[0]!;
        expect(adapter.observedAttributes).toEqual(['id', 'class', 'data-ready', 'data-secret']);
        const legacy = {...adapter, observedAttributes: undefined};
        expect(getSiteAdapterAttributeFilter([legacy])).toEqual([]);
        expect(getSiteAdapterAttributeFilter([legacy, adapter], ['hidden', 'id'])).toEqual(['hidden', 'id', 'class', 'data-ready', 'data-secret']);
        expect(getSiteAdapterAttributeFilter([{...adapter, observedAttributes: null}])).toBeNull();
        expect(createTranslationMutationObserverOptions([adapter]).attributeFilter).toEqual(expect.arrayContaining(['hidden', 'data-fr-translation-owned', 'id', 'data-ready', 'data-secret']));
        expect(createTranslationMutationObserverOptions([legacy]).attributeFilter).toContain('class');
        expect(createTranslationMutationObserverOptions([{...adapter, observedAttributes: null}])).toEqual({
            childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true,
        });
    });

    it('reclassifies existing DOM when only id or custom data attributes change', () => {
        const {document} = parseHTML('<html><body><p id="draft" data-ready="no">Readable published sentence</p></body></html>');
        const target = document.querySelector('p')!;
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters: compileSiteRulePack(pack([rule({
            mode: 'focus', content: [{css: ['#published[data-ready="yes"]']}], protect: ['[data-private="true"]'],
        })]))});
        expect(core.discover(document)).toEqual([]);
        target.id = 'published';
        expect(core.discover(document)).toEqual([]);
        target.setAttribute('data-ready', 'yes');
        expect(core.discover(document).map((item) => item.element)).toEqual([target]);
        target.setAttribute('data-private', 'true');
        expect(core.resolve(target.firstChild)).toBeNull();
        expect(extractTranslationText(target, core.shouldStayOriginal)).toBe('');
        target.removeAttribute('data-private');
        expect(core.resolve(target.firstChild)?.element).toBe(target);
        target.id = 'draft';
        expect(core.resolve(target.firstChild)).toBeNull();
    });

    it('focus non-atomic containers retain only their explicit direct text runs around leaf prose', () => {
        const {document} = parseHTML('<html><body><article id="message">Front readable text <button>Reply</button><p id="body">Paragraph readable text <code>secretCode</code></p> Tail readable text <span class="secret">private metadata</span></article><div id="outside">Outside prefix<p>Unlisted child prose</p>Outside suffix</div></body></html>');
        const container = document.querySelector<HTMLElement>('#message')!;
        const body = document.querySelector('#body')!;
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters: compileSiteRulePack(pack([rule({
            mode: 'focus', content: [{css: ['#message p'], resolve: 'closest'}, {css: ['#message'], atomic: false}],
            protect: ['button', '.secret'],
        })]))});
        const candidates = core.discover(document);
        expect(candidates).toHaveLength(3);
        const textOf = (candidate: typeof candidates[number]) => candidate.nodes
            ? extractTranslationTextFromNodes(candidate.nodes, core.shouldStayOriginal)
            : extractTranslationText(candidate.element, core.shouldStayOriginal);
        expect(candidates.map(textOf)).toEqual(['Paragraph readable text', 'Front readable text', 'Tail readable text']);
        expect(core.resolve(container.firstChild)?.nodes).toEqual(candidates[1]!.nodes);
        expect(core.resolve(body.firstChild)?.element).toBe(body);
        expect(core.resolve(body.nextSibling)?.nodes).toEqual(candidates[2]!.nodes);
        expect(core.resolve(document.querySelector('#outside')!.firstChild)).toBeNull();
    });

    it('keeps a non-atomic adapter target implicit when resolving mixed direct and paragraph text', () => {
        const {document} = parseHTML('<html><body><article>Readable introduction<p>Independent paragraph text</p>Readable conclusion</article></body></html>');
        const container = document.querySelector('article')!;
        const paragraph = document.querySelector('p')!;
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters: [{
            id: 'implicit-target', genericCandidatePolicy: 'targets-only', matches: () => true,
            decide: (element) => element === container
                ? {kind: 'force-target', atomic: false, reason: 'message'}
                : element === paragraph ? {kind: 'force-target', reason: 'paragraph'} : {kind: 'pass'},
        }]});
        expect(core.discover(document).map(candidate => candidate.nodes
            ? extractTranslationTextFromNodes(candidate.nodes, core.shouldStayOriginal)
            : extractTranslationText(candidate.element, core.shouldStayOriginal)))
            .toEqual(['Independent paragraph text', 'Readable introduction', 'Readable conclusion']);
        expect(core.resolve(container.firstChild)?.nodes).toEqual([container.firstChild]);
        expect(core.resolve(paragraph.firstChild)?.element).toBe(paragraph);
    });

    it('matches exact and wildcard host boundaries, protocol and pathname scope', () => {
        const [exact, wildcard, paths] = compileSiteRulePack(pack([
            rule(), rule({id: 'wildcard', match: {hosts: ['*.example.test']}}),
            rule({id: 'paths', match: {hosts: ['example.test'], paths: ['/docs/*/page', '/read', '/literal.(a)'], excludePaths: ['/docs/private/*']}}),
        ]));
        for (const url of ['https://example.test', 'http://EXAMPLE.TEST./docs', 'https://example.test:8443/path?next=evil.test']) expect(exact!.matches(new URL(url))).toBe(true);
        for (const url of ['ftp://example.test', 'https://sub.example.test', 'https://example.test.evil.test', 'https://evil-example.test', 'https://example.test@evil.test', 'file:///example.test']) expect(exact!.matches(new URL(url))).toBe(false);
        for (const url of ['https://example.test', 'https://sub.example.test', 'https://deep.sub.example.test']) expect(wildcard!.matches(new URL(url))).toBe(true);
        expect(wildcard!.matches(new URL('https://notexample.test'))).toBe(false);
        for (const path of ['/docs/start/page', '/docs/a/b/page', '/read', '/literal.(a)', '/read?next=/private']) expect(paths!.matches(new URL(`https://example.test${path}`))).toBe(true);
        for (const path of ['/docs/private/page', '/docs/page', '/read/more', '/other', '/literal.a']) expect(paths!.matches(new URL(`https://example.test${path}`))).toBe(false);
    });

    it('matches several literal glob sections without overlap or regular-expression expansion', () => {
        const matches = (pattern: string, path: string) => compileSiteRulePack(pack([rule({match: {hosts: ['example.test'], paths: [pattern]}})]))[0]!.matches(new URL(`https://example.test${path}`));
        expect(matches('/a*b*c', '/a-middle-b-end-c')).toBe(true);
        expect(matches('/a*b*c', '/a-middle-c')).toBe(false);
        expect(matches('/a*b*c', '/a-b-tail')).toBe(false);
        expect(matches('/a**b*', '/abc')).toBe(true);
        expect(matches('/ab*ab', '/ab')).toBe(false);
        expect(matches('/.*', '/anything')).toBe(false);
        expect(matches('/x*', '/xyz')).toBe(true);
        expect(matches('/x', '/xy')).toBe(false);
        expect(matches('/x', '/x')).toBe(true);
    });

    it('places site rules before profile defaults, removes duplicates and overrides mode', () => {
        const shared = {css: ['p'], resolve: 'self' as const, atomic: true};
        const input: SiteRulePack = {
            version: 1, profiles: {prose: {mode: 'focus', content: [shared], protect: ['code'], exclude: ['aside'], watchIgnore: ['time']}},
            rules: [rule({profile: 'prose', mode: 'augment', content: [{css: ['p']}, {css: ['h1'], key: 'title'}], protect: ['code', 'button'], exclude: ['aside', 'nav'], watchIgnore: ['time', '.clock']})],
        };
        const resolved = resolveSiteRule(input, input.rules[0]!);
        expect(resolved).toEqual(rule({mode: 'augment', content: [{css: ['p']}, {css: ['h1'], key: 'title'}], protect: ['code', 'button'], exclude: ['aside', 'nav'], watchIgnore: ['time', '.clock']}));
        expect(parseSiteRulePack(pack([resolved])).ok).toBe(true);
        expect(compileSiteRulePack(input)[0]!.genericCandidatePolicy).toBe('allow');
        expect(compileSiteRulePack({...input, rules: [rule({profile: 'prose'})]})[0]!.genericCandidatePolicy).toBe('targets-only');
        resolved.content![0]!.css.push('.custom');
        resolved.match.hosts.push('other.test');
        expect(input.profiles!.prose!.content![0]!.css).toEqual(['p']);
        expect(input.rules[0]!.match.hosts).toEqual(['example.test']);
        expect(resolveSiteRule(pack(), rule())).toEqual(rule({mode: 'augment'}));
        expect(compileSiteRulePack(pack([rule({profile: 'not-present'})]))[0]!.genericCandidatePolicy).toBe('allow');
    });

    it('combines built-in and custom rules by ID, disables selected rules, preserves stable order', () => {
        const builtin = pack([rule({id: 'a', name: 'Built A'}), rule({id: 'b'}), rule({id: 'c'})]);
        const custom = pack([rule({id: 'b', name: 'Custom B', mode: 'focus'}), rule({id: 'd'})]);
        const settings = {enabled: true, disabledRuleIds: ['c'], custom};
        const adapters = composeSiteAdapters(builtin, settings);
        expect(adapters.map((adapter) => adapter.id)).toEqual(['a', 'b', 'd']);
        expect(adapters[1]!.genericCandidatePolicy).toBe('targets-only');
        expect(composeSiteAdapters(builtin, {...settings, enabled: false})).toEqual([]);
        expect(builtin.rules[1]!.mode).toBeUndefined();
        expect(composeSiteAdapters(builtin, {...settings, disabledRuleIds: ['unknown'], custom: pack([])}).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    });

    it('uses priority ordering for targets while lower-priority protection still wins', () => {
        const {document} = parseHTML('<html><body><div id="copy">Readable copy <span class="secret">Never send this secret</span></div><p class="secret" id="private">Private readable text</p></body></html>');
        const adapters = compileSiteRulePack(pack([
            rule({id: 'high', priority: 20, content: [{css: ['#copy', '#private'], resolve: 'closest', key: 'explicit'}]}),
            rule({id: 'low', priority: -1, exclude: ['.secret'], watchIgnore: ['.secret']}),
        ]));
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters});
        const copy = document.querySelector('#copy')!;
        expect(core.inspect(copy).candidate).toMatchObject({reason: 'explicit', adapterId: 'high'});
        expect(core.inspect(document.querySelector('#private')!).candidate).toBeNull();
        expect(extractTranslationText(copy, core.shouldStayOriginal)).toBe('Readable copy');
        expect(core.shouldIgnoreMutation(document.querySelector('.secret')!)).toBe(true);
        expect(core.shouldIgnoreMutation(copy)).toBe(false);
        expect(core.adapters.map((adapter) => adapter.id)).toEqual(['high', 'low']);
    });

    it('focus only selects declared prose while preserving controls inside atomic content', () => {
        const {document} = parseHTML('<html><body><div class="post" id="post">Read this sentence <button>Reply</button><span class="label">Status label</span></div><p id="generic">Unrelated ordinary text</p><div class="composer"><p>Draft prose must be skipped</p></div></body></html>');
        const adapters = compileSiteRulePack(pack([rule({mode: 'focus', content: [{css: ['.post'], resolve: 'closest', atomic: true}], protect: ['.label', 'button'], exclude: ['.composer']})]));
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters});
        expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual(['post']);
        const post = document.querySelector('#post')!;
        expect(core.resolve(post.firstChild)).toMatchObject({element: post, reason: 'example:content'});
        expect(core.resolve(document.querySelector('#generic')!.firstChild)).toBeNull();
        expect(extractTranslationText(post, core.shouldStayOriginal)).toBe('Read this sentence');
        const other = new TranslationCandidateCore({url: new URL('https://other.test'), adapters});
        expect(other.inspect(document.querySelector('#generic')!).candidate).not.toBeNull();
    });

    it('never bypasses hard guards and protects nested shadow host exclusions', () => {
        const {document} = parseHTML('<html><body><div contenteditable="true"><p id="editor">Secret draft words</p></div><p translate="no" id="native">Native protected text</p><div class="widget" id="widget"></div><p id="body">Readable article copy</p></body></html>');
        const shadow = document.querySelector('#widget')!.attachShadow({mode: 'open'});
        shadow.innerHTML = '<p id="shadow">Private component copy</p>';
        const core = new TranslationCandidateCore({url: new URL('https://example.test'), adapters: compileSiteRulePack(pack([rule({content: [{css: ['p'], resolve: 'self'}], exclude: ['.widget']})]))});
        for (const id of ['editor', 'native']) expect(core.inspect(document.getElementById(id)!).candidate).toBeNull();
        expect(core.resolve(shadow.querySelector('p')!.firstChild)).toBeNull();
        expect(core.discover(document).map((candidate) => candidate.element.id)).toEqual(['body']);
    });
});

describe('Mastodon public application shell discovery', () => {
    const create = (settings: Partial<ReturnType<typeof normalizeSiteAdaptationSettings>> = {}, url = 'https://mastodon.social/@Mastodon') => {
        // Reduced from the public production DOM captured on 2026-10-15: the site puts its entire React app in a body-level notranslate shell.
        const {document} = parseHTML('<html><body><div id="mastodon" class="notranslate app-holder"><main><article><div class="status__content"><div class="status__content__text status__content__text--visible translate"><p id="post">Readable public message with <a class="mention" href="/@alice">@alice</a> and <code>document.querySelector()</code> safely preserved.</p></div></div></article></main></div></body></html>');
        const configured = {...normalizeSiteAdaptationSettings(undefined), ...settings};
        const core = new TranslationCandidateCore({url: new URL(url), adapters: composeSiteAdapters(builtinSiteRulePack, configured)});
        return {document, core};
    };
    it('discovers the actual public paragraph and carries narrow source-protection permission into rendering', () => {
        const {document, core} = create();
        const candidates = core.discover(document);
        expect(candidates.map(candidate => candidate.element.id)).toEqual(['post']);
        expect(candidates[0]).toMatchObject({adapterId: 'mastodon', allowTopLevelApplicationShell: true,
            applicationShellPolicyId: 'mastodon'});
        const source = extractTranslationText(candidates[0]!.element, core.shouldStayOriginal, undefined,
            {allowTopLevelApplicationShell: candidates[0]!.allowTopLevelApplicationShell, protectedElement: candidates[0]!.element});
        expect(source).toBe('Readable public message with and safely preserved.');
    });
    it('revalidates automatic policy without treating a translated owner as fresh source', () => {
        const {document, core} = create();
        const post = document.getElementById('post')!;
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(true);
        // Single-text rendering hides its live source inside extension-owned slots. Policy checks
        // must remain independent from source extraction, which the lifecycle validates separately.
        post.innerHTML = '<span class="fluent-read-single-slot" data-fr-translation-owned="true" translate="no">已译正文</span>';
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(true);
        expect(core.isApplicationShellPolicyCurrent(post, 'different-policy')).toBe(false);
        expect(core.isApplicationShellPolicyCurrent(post, '')).toBe(false);
        post.remove();
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(false);
    });
    it.each(['id', 'translate', 'data-notranslate', 'app-holder', 'content', 'translate-class', 'other-shell'])
    ('revokes automatic policy when the current %s boundary changes', mutation => {
        const {document, core} = create(); const shell = document.getElementById('mastodon')!;
        const post = document.getElementById('post')!;
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(true);
        if (mutation === 'id') shell.id = 'different-app';
        if (mutation === 'translate') shell.setAttribute('translate', 'no');
        if (mutation === 'data-notranslate') shell.setAttribute('data-notranslate', 'true');
        if (mutation === 'app-holder') shell.classList.remove('app-holder');
        if (mutation === 'content') document.querySelector('.status__content')!.classList.remove('status__content');
        if (mutation === 'translate-class') document.querySelector('.translate')!.classList.remove('translate');
        if (mutation === 'other-shell') {
            const other = document.createElement('div'); other.className = 'notranslate app-holder';
            document.body.append(other); other.append(document.querySelector('main')!);
        }
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(false);
    });
    it.each([
        {enabled: false}, {disabledRuleIds: ['mastodon']},
        {custom: pack([rule({id: 'mastodon', match: {hosts: ['mastodon.social']}, content: [{css: ['p']}]})])},
        {custom: pack([rule({id: 'prefer-post', priority: 999, match: {hosts: ['mastodon.social']}, content: [{css: ['p']}]})])},
    ])('revokes a previously discovered policy under current configuration: %j', settings => {
        const {document, core} = create(); const post = document.getElementById('post')!;
        expect(core.discover(document)[0]?.applicationShellPolicyId).toBe('mastodon');
        const {core: changedCore} = create(settings);
        expect(changedCore.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(false);
    });
    it('keeps manual hover permission distinct from automatic site policy', () => {
        const {document, core} = create(); const post = document.getElementById('post')!;
        const manual = core.resolve(post);
        expect(manual).toMatchObject({element: post, allowTopLevelApplicationShell: true});
        expect(manual?.applicationShellPolicyId).toBeUndefined();
        document.getElementById('mastodon')!.id = 'different-app';
        expect(core.isApplicationShellPolicyCurrent(post, 'mastodon')).toBe(false);
        const movedManual = core.resolve(post);
        expect(movedManual).toMatchObject({element: post, allowTopLevelApplicationShell: true});
        expect(movedManual?.applicationShellPolicyId).toBeUndefined();
    });
    it('discovers appended paragraphs and dirty inline roots without nesting or duplicate owners', () => {
        const {document, core} = create();
        const container = document.querySelector('.status__content__text')!;
        container.insertAdjacentHTML('beforeend', '<p id="new">A new public post with <em>fresh readable words</em>.</p>');
        expect(core.discover(document).map(candidate => candidate.element.id)).toEqual(['post', 'new']);
        const paragraph = document.getElementById('new')!;
        for (const root of [container, paragraph, paragraph.querySelector('em')!, paragraph.querySelector('em')!.firstChild!]) {
            expect(core.discover(root).filter(candidate => candidate.element === paragraph)).toHaveLength(1);
        }
        document.getElementById('mastodon')!.classList.remove('notranslate');
        expect(core.discover(document).map(candidate => candidate.element.id)).toEqual(['post', 'new']);
    });
    it('retains local no-translate, mentions, links, code, controls and user-protected descendants', () => {
        const {document, core} = create({custom: pack([rule({id: 'extra-protection', match: {hosts: ['mastodon.social']}, protect: ['.private-copy']})])});
        const post = document.getElementById('post')!;
        post.insertAdjacentHTML('beforeend', '<span class="notranslate">Private inline text</span><span translate="no">Private translation marker</span><a translate="no" href="https://example.test">Private outbound URL</a><span class="hashtag">Private hashtag</span><span class="private-copy">User protected words</span><button>Reply now</button>');
        const candidate = core.discover(document)[0]!;
        const protection = {allowTopLevelApplicationShell: candidate.allowTopLevelApplicationShell, protectedElement: post};
        expect(extractTranslationText(post, core.shouldStayOriginal, undefined, protection)).toBe('Readable public message with and safely preserved.');
        const snapshot = createTranslationSourceSnapshot(post, core.shouldStayOriginal, undefined, protection, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toMatch(/Private|User protected|Reply|querySelector|@alice/);
        for (const attribute of ['class="notranslate"', 'translate="no"', 'data-notranslate="true"', 'contenteditable="true"', 'hidden', 'aria-hidden="true"']) {
            const wrapper = document.createElement('div'); wrapper.innerHTML = `<div ${attribute}><p id="blocked">Protected public sentence must remain original.</p></div>`;
            document.querySelector('.status__content__text')!.append(wrapper);
            expect(core.discover(document).map(item => item.element.id)).toEqual(['post']);
            wrapper.remove();
        }
    });
    it.each(['form', 'nav', 'aside', 'header', 'footer'])('does not use the app-shell exception within %s', tag => {
        const {document, core} = create();
        const status = document.querySelector('.status__content')!;
        const structural = document.createElement(tag);
        status.replaceWith(structural); structural.append(status);
        expect(core.discover(document)).toEqual([]);
    });
    it.each([
        {enabled: false}, {disabledRuleIds: ['mastodon']},
        {custom: pack([rule({id: 'mastodon', match: {hosts: ['mastodon.social']}, content: [{css: ['p']} ]})])},
        {custom: pack([rule({id: 'block-post', match: {hosts: ['mastodon.social']}, exclude: ['article']})])},
        {custom: pack([rule({id: 'protect-post', match: {hosts: ['mastodon.social']}, protect: ['article']})])},
        {custom: pack([rule({id: 'prefer-post', priority: 999, match: {hosts: ['mastodon.social']}, content: [{css: ['p']}]})])},
    ])('restores strict protection when disabled, replaced or denied by user rules: %j', settings => {
        const {document, core} = create(settings);
        expect(core.discover(document)).toEqual([]);
    });
    it('does not grant the exception to an independently compiled user rule pack', () => {
        const {document} = create();
        const core = new TranslationCandidateCore({url: new URL('https://mastodon.social/@Mastodon'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        expect(core.discover(document)).toEqual([]);
    });
    it.each(['https://example.test/@Mastodon', 'https://mastodon.online/@Mastodon', 'https://mastodon.social/settings/profile', 'https://mastodon.social/auth/sign_in', 'https://mastodon.social/explore'])('does not extend the verified public route policy to %s', url => {
        const {document, core} = create({}, url);
        expect(core.discover(document)).toEqual([]);
    });
    it.each(['translate', 'data-notranslate', 'contenteditable', 'hidden', 'inert', 'aria-hidden'])('preserves an additional %s marker on the application shell', attribute => {
        const {document, core} = create();
        document.getElementById('mastodon')!.setAttribute(attribute, attribute === 'translate' ? 'no' : 'true');
        expect(core.discover(document)).toEqual([]);
    });
    it('rejects changed shell identity, nested shells, undeclared content and unrelated scan roots', () => {
        for (const mutation of ['id', 'app-holder', 'nested', 'translate', 'content', 'unrelated']) {
            const {document, core} = create(); const shell = document.getElementById('mastodon')!;
            if (mutation === 'id') shell.id = 'different-app';
            if (mutation === 'app-holder') shell.classList.remove('app-holder');
            if (mutation === 'nested') {const wrapper = document.createElement('section'); shell.replaceWith(wrapper); wrapper.append(shell);}
            if (mutation === 'translate') document.querySelector('.translate')!.classList.remove('translate');
            if (mutation === 'content') document.querySelector('.status__content')!.classList.remove('status__content');
            const unrelated = document.createElement('span'); document.body.append(unrelated);
            expect(core.discover(mutation === 'unrelated' ? unrelated : document), mutation).toEqual([]);
        }
    });
    it.each(['translate', 'id'])('rechecks shell %s after a discovery yield and can discover again after it is restored', attribute => {
        const {document, core} = create();
        document.querySelector('.status__content__text')!.insertAdjacentHTML('beforeend', '<p id="second">Another readable public paragraph.</p>');
        const iterator = core.discoverSteps(document); let step;
        while (!(step = iterator.next()).done && !step.value.candidate) { /* reach first candidate */ }
        expect(step.value?.candidate?.element.id).toBe('post');
        const shell = document.getElementById('mastodon')!;
        shell.setAttribute(attribute, attribute === 'translate' ? 'no' : 'different-app');
        expect([...iterator].filter(item => item.candidate)).toEqual([]);
        if (attribute === 'translate') shell.removeAttribute(attribute);
        else shell.id = 'mastodon';
        expect(core.discover(document).map(candidate => candidate.element.id)).toEqual(['post', 'second']);
    });
});

describe('application shell policy capability boundaries', () => {
    function fixture() {
        const {document} = parseHTML('<html><body><div class="notranslate"><p id="post">The explicitly authorized public source remains the only translation owner.</p><p id="other">Unrelated public source cannot borrow another owner permission.</p></div></body></html>');
        const post = document.getElementById('post')!;
        const other = document.getElementById('other')!;
        const adapter: TranslationSiteAdapter = {
            id: 'verified-public-site', genericCandidatePolicy: 'targets-only', matches: () => true,
            decide: element => element === post
                ? {kind: 'force-target', reason: 'verified-public-source'} : {kind: 'pass'},
        };
        const core = new TranslationCandidateCore({url: new URL('https://example.test/public'), adapters: [adapter]});
        return {document, post, other, adapter, core};
    }

    it('ignores unrelated callback entries and deduplicates repeated explicit owners', () => {
        const {document, post, other, adapter, core} = fixture();
        adapter.discoverApplicationShellTargets = function* () { yield other; yield post; yield post; };
        expect(core.isApplicationShellPolicyCurrent(post, adapter.id)).toBe(true);
        expect(core.isApplicationShellPolicyCurrent(other, adapter.id)).toBe(false);
        const candidates = core.discover(document);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({element: post, applicationShellPolicyId: adapter.id,
            allowTopLevelApplicationShell: true});
        // When the root ceases to need an exception, normal discovery owns the paragraph.
        // Supplemental duplicates must neither create a second owner nor grant extra permission.
        post.parentElement!.classList.remove('notranslate');
        const ordinary = core.discover(document);
        expect(ordinary).toHaveLength(1);
        expect(ordinary[0]?.element).toBe(post);
        expect(ordinary[0]?.applicationShellPolicyId).toBeUndefined();
        expect(ordinary[0]?.allowTopLevelApplicationShell).toBeUndefined();
    });

    it('rejects permission when the adapter redirects the requested owner to another element', () => {
        const {document, post, other, adapter, core} = fixture();
        adapter.discoverApplicationShellTargets = function* () { yield post; };
        adapter.decide = element => element === post
            ? {kind: 'force-target', target: other, reason: 'redirected-source'} : {kind: 'pass'};
        expect(core.isApplicationShellPolicyCurrent(post, adapter.id)).toBe(false);
        expect(core.discover(document)).toEqual([]);
    });

    it('revokes policy when callback iteration fails instead of falling back to manual permission', () => {
        const {post, other, adapter, core} = fixture();
        adapter.discoverApplicationShellTargets = function* () {
            yield other;
            throw new Error('The site policy could not inspect its current application boundary');
        };
        expect(core.isApplicationShellPolicyCurrent(post, adapter.id)).toBe(false);
        const manual = core.resolve(post);
        expect(manual).toMatchObject({element: post, allowTopLevelApplicationShell: true});
        expect(manual?.applicationShellPolicyId).toBeUndefined();
    });
});
