import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({
    config: {
        style: 1,
        to: 'zh-Hans',
        longParagraphLineBreakEnabled: false,
        translationBeforeOriginal: false,
        eagerTranslationCharacters: 4999,
    },
}));
vi.mock('@/src/core/config/catalog', () => ({
    options: {styles: []},
}));

import {config as configMock} from '@/src/services/config/store';

import {
    COMMON_EXCLUDED_TAG_OPTIONS,
    DEFAULT_EAGER_TRANSLATION_CHARACTERS,
    DEFAULT_MIN_TRANSLATION_TEXT_LENGTH,
    EAGER_TRANSLATION_CHARACTERS_MAX,
    EXCLUDED_TAGS_MAX,
    EXCLUDED_TAG_MAX_LENGTH,
    MIN_TRANSLATION_TEXT_LENGTH_MAX,
    normalizeEagerTranslationCharacters,
    normalizeExcludedLanguages,
    normalizeExcludedTagEntry,
    normalizeExcludedTags,
    normalizeMinTranslationTextLength,
    splitExcludedTagInput,
    validateExcludedTagSelector,
} from '@/src/core/config/pageTranslation';
import {
    LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH,
    applyLongParagraphLineBreaks,
    iterateTranslationSentences,
    splitTranslationSentences,
} from '@/src/core/translation/lineBreak';
import {
    candidateTextLength,
    consumeEagerTranslationBudget,
    getEagerTranslationBudget,
} from '@/src/features/full-page-translation/content/eagerTranslation';
import {
    collectLiveTranslationTextSlots,
    createDeclarativeAdapter,
    createTranslationSourceSnapshot,
    extractTranslationText,
    extractTranslationTextFromNodes,
    getCurrentTranslationCore,
    isMeaningfulTranslationText,
    setCurrentTranslationExcludedSelectors,
    setCurrentTranslationSidebarRegions,
    setMinimumTranslationTextLength,
} from '@/src/core/translation/public';
import {createTranslationCore} from './helpers/translationCore';
import type {TranslationCandidate} from '@/src/core/translation/public';
import {appendBilingualTranslation} from '@/src/features/full-page-translation/content/renderer';

function page(html: string, url = 'https://example.test/article') {
    const {document} = parseHTML(`<html><head></head><body>${html}</body></html>`);
    return {document, url: new URL(url)};
}

function sources(candidates: readonly TranslationCandidate[]): string[] {
    return candidates.map((candidate) => extractTranslationText(candidate.element));
}

afterEach(() => {
    setMinimumTranslationTextLength(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
    setCurrentTranslationSidebarRegions(false);
    setCurrentTranslationExcludedSelectors([]);
    configMock.longParagraphLineBreakEnabled = false;
    configMock.translationBeforeOriginal = false;
    configMock.eagerTranslationCharacters = DEFAULT_EAGER_TRANSLATION_CHARACTERS;
});

describe('进阶设置的取值范围', () => {
    it('把最少字符数和预翻译字符数收敛到合法范围，并对无效输入回到默认值', () => {
        expect(normalizeMinTranslationTextLength(undefined)).toBe(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
        expect(normalizeMinTranslationTextLength('abc')).toBe(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
        expect(normalizeMinTranslationTextLength('')).toBe(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
        expect(normalizeMinTranslationTextLength(Number.NaN)).toBe(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
        expect(normalizeMinTranslationTextLength('8')).toBe(8);
        expect(normalizeMinTranslationTextLength(4.4)).toBe(4);
        expect(normalizeMinTranslationTextLength(0)).toBe(1);
        expect(normalizeMinTranslationTextLength(9_999)).toBe(MIN_TRANSLATION_TEXT_LENGTH_MAX);

        expect(normalizeEagerTranslationCharacters(undefined)).toBe(DEFAULT_EAGER_TRANSLATION_CHARACTERS);
        expect(normalizeEagerTranslationCharacters('  ')).toBe(DEFAULT_EAGER_TRANSLATION_CHARACTERS);
        expect(normalizeEagerTranslationCharacters('1200')).toBe(1200);
        expect(normalizeEagerTranslationCharacters(-5)).toBe(0);
        expect(normalizeEagerTranslationCharacters(10 ** 9)).toBe(EAGER_TRANSLATION_CHARACTERS_MAX);
    });
});

describe('翻译段落所需的最少字符数', () => {
    it('按设定长度过滤短段落，并保留原有的标识符与纯符号防护', () => {
        expect(isMeaningfulTranslationText('ok')).toBe(true);
        expect(isMeaningfulTranslationText('a1')).toBe(false);

        expect(setMinimumTranslationTextLength(6)).toBe(6);
        expect(isMeaningfulTranslationText('hello')).toBe(false);
        expect(isMeaningfulTranslationText('hello there')).toBe(true);
        expect(isMeaningfulTranslationText('   ')).toBe(false);
        expect(isMeaningfulTranslationText('https://example.test/a/b')).toBe(false);
    });

    it('把阈值应用到候选发现，短标签不再进入全文翻译队列', () => {
        const {document, url} = page(`
            <main><article>
                <p id="short">Hi all</p>
                <p id="long">This paragraph is long enough to translate.</p>
            </article></main>
        `);
        setMinimumTranslationTextLength(10);
        const candidates = createTranslationCore({scope: 'content', url}).discover(document);
        expect(sources(candidates)).toEqual(['This paragraph is long enough to translate.']);
    });
});

describe('侧边栏翻译', () => {
    it.each(['nav', 'aside'])('开启侧边栏后 %s 的直属正文与独立子段落都可发现及悬浮翻译', tag => {
        const {document, url} = page(`<header><${tag} id="mixed">Direct sidebar description.<p>Independent sidebar paragraph.</p></${tag}></header>`);
        const container = document.querySelector('#mixed')!;
        const direct = container.firstChild!;
        const closed = createTranslationCore({scope: 'content', url});
        expect(closed.discover(document)).toEqual([]);
        expect(closed.resolve(direct)).toBeNull();
        const opened = createTranslationCore({scope: 'content', includeSidebarRegions: true, url});
        const candidates = opened.discover(document);
        expect(candidates.map(candidate => candidate.nodes
            ? extractTranslationTextFromNodes(candidate.nodes)
            : extractTranslationText(candidate.element))).toEqual([
            'Independent sidebar paragraph.', 'Direct sidebar description.',
        ]);
        expect(opened.resolve(direct)?.nodes).toEqual([direct]);
    });

    const html = `
        <header id="site-header"><div><nav id="header-menu"><ul><li id="header-menu-item">Header navigation remains translatable.</li></ul></nav><p id="header-meta">Header metadata remains a page-shell detail.</p></div></header>
        <main><article><p id="prose">The main article body stays translatable.</p></article></main>
        <aside id="sidebar"><p id="aside-text">Related reading for this article.</p></aside>
        <nav id="menu"><p id="menu-text">Documentation home for the project.</p></nav>
        <footer id="foot"><p id="foot-text">Copyright notice for the whole site.</p></footer>
    `;

    it('默认跳过侧边栏与导航，开启后把它们纳入正文范围但仍保留页脚边界', () => {
        const closed = page(html);
        const closedSources = sources(createTranslationCore({scope: 'content', url: closed.url}).discover(closed.document));
        expect(closedSources).toContain('The main article body stays translatable.');
        expect(closedSources).not.toContain('Related reading for this article.');
        expect(closedSources).not.toContain('Documentation home for the project.');
        expect(closedSources).not.toContain('Header navigation remains translatable.');
        expect(closedSources).not.toContain('Header metadata remains a page-shell detail.');

        const opened = page(html);
        const openedSources = sources(createTranslationCore({
            scope: 'content',
            includeSidebarRegions: true,
            url: opened.url,
        }).discover(opened.document));
        expect(openedSources).toContain('Related reading for this article.');
        expect(openedSources).toContain('Documentation home for the project.');
        expect(openedSources).toContain('Header navigation remains translatable.');
        expect(openedSources).not.toContain('Copyright notice for the whole site.');
        expect(openedSources).not.toContain('Header metadata remains a page-shell detail.');
    });

    it('共享核心按注入的开关重建，重复注入同一取值不会浪费缓存', () => {
        expect(getCurrentTranslationCore('content').includeSidebarRegions).toBe(false);

        setCurrentTranslationSidebarRegions(true);
        const opened = getCurrentTranslationCore('content');
        expect(opened.includeSidebarRegions).toBe(true);

        setCurrentTranslationSidebarRegions(true);
        expect(getCurrentTranslationCore('content')).toBe(opened);
    });

    it('按节点解析时同样遵循侧边栏开关', () => {
        const {document, url} = page(html);
        const asideText = document.querySelector('#aside-text')!;
        expect(createTranslationCore({scope: 'content', url}).resolve(asideText)).toBeNull();
        const candidate = createTranslationCore({scope: 'content', includeSidebarRegions: true, url}).resolve(asideText);
        expect(candidate && extractTranslationText(candidate.element)).toBe('Related reading for this article.');

        const headerMenuItem = document.querySelector('#header-menu-item')!;
        expect(createTranslationCore({scope: 'content', url}).resolve(headerMenuItem)).toBeNull();
        expect(createTranslationCore({scope: 'content', includeSidebarRegions: true, url}).resolve(headerMenuItem)?.element)
            .toBe(headerMenuItem);
    });

    it('ignores attribute payload size when discovering ordinary paragraphs', () => {
        const {document, url} = page(`<main><p id="wikipedia-paragraph" data-mw="${'x'.repeat(6000)}">A normal paragraph remains readable despite noisy reference attributes.</p></main>`);
        const paragraph = document.querySelector('#wikipedia-paragraph')!;
        expect(createTranslationCore({scope: 'content', url}).discover(document).map(({element}) => element))
            .toContain(paragraph);
    });
});

describe('长段落自动换行', () => {
    const long = '第一句话已经足够长了，用来测试换行行为。第二句话继续补充上下文，让整段超过换行门槛。第三句话结束整个段落。';

    it('按句末标点切分，并忽略缩写、小数和段落末尾标点', () => {
        expect(splitTranslationSentences('')).toEqual(['']);
        expect(splitTranslationSentences('只有一句话。')).toEqual(['只有一句话。']);
        expect(splitTranslationSentences('第一句。第二句。')).toEqual(['第一句。', '第二句。']);
        expect(splitTranslationSentences('Ends here. And continues.')).toEqual(['Ends here. ', 'And continues.']);
        expect(splitTranslationSentences('Version 1.5 stays together in one sentence')).toHaveLength(1);
        expect(splitTranslationSentences('Dr. Smith wrote it')).toHaveLength(1);
        expect(splitTranslationSentences('他说“好的。”然后离开了。')).toHaveLength(2);
        expect(splitTranslationSentences('句子结束。   ')).toEqual(['句子结束。   ']);
    });

    it('按需读取兼容分句，两个迭代器及完整数组调用不会相互移动游标', () => {
        const first = iterateTranslationSentences('First. \t　Second! Third?');
        const second = iterateTranslationSentences('甲。乙。');
        expect(first.next()).toEqual({done: false, value: 'First. \t　'});
        expect(second.next()).toEqual({done: false, value: '甲。'});
        expect(splitTranslationSentences('Other! Sentence?')).toEqual(['Other! ', 'Sentence?']);
        expect(Array.from(first)).toEqual(['Second! ', 'Third?']);
        expect(Array.from(second)).toEqual(['乙。']);
        expect(Array.from(iterateTranslationSentences(''))).toEqual(['']);
    });

    it('提前关闭迭代器后仍保持后续分句、尾随空白和原文重组契约', () => {
        const source = 'One! Two? Three。 \t　';
        const iterator = iterateTranslationSentences(source);
        expect(iterator.next().value).toBe('One! ');
        iterator.return?.();
        expect(iterator.next().done).toBe(true);
        expect(splitTranslationSentences(source)).toEqual(['One! ', 'Two? ', 'Three。 \t　']);
        for (const value of ['\t　', 'One。\r\nTwo。', 'One。\u00a0Two。', 'One。Two。 \t', 'Last。　', 'One。 \t　Two!']) {
            expect(splitTranslationSentences(value).join('')).toBe(value);
            expect(Array.from(iterateTranslationSentences(value))).toEqual(splitTranslationSentences(value));
        }
    });

    it('只改写超过长度门槛且确实多句的译文，短段落保持原样', () => {
        const {document} = page('<p id="target"></p>');
        const shortContainer = document.createElement('span');
        shortContainer.textContent = '短句。另一句。';
        expect(applyLongParagraphLineBreaks(shortContainer)).toBe(false);
        expect(shortContainer.querySelectorAll('br')).toHaveLength(0);
        expect(applyLongParagraphLineBreaks(document.createElement('span'))).toBe(false);

        const container = document.createElement('span');
        container.textContent = long;
        expect(applyLongParagraphLineBreaks(container, 20)).toBe(true);
        expect(container.querySelectorAll('br')).toHaveLength(2);
        expect(container.textContent).toBe(long);
    });

    it('深层译文按句换行不会递归耗尽调用栈，也不丢失内联顺序', () => {
        const depth = 16384;
        const translated = '这是第一句长段落译文。这是第二句长段落译文。'.repeat(8);
        const {document} = page('<span id="deep">' + '<span>'.repeat(depth) + translated + '</span>'.repeat(depth) + '</span>');
        const container = document.querySelector<HTMLElement>('#deep')!;
        expect(() => applyLongParagraphLineBreaks(container)).not.toThrow();
        expect(container.querySelectorAll('span')).toHaveLength(depth);
        expect(container.querySelectorAll('br').length).toBeGreaterThan(0);
        expect(container.textContent).toBe(translated);
    });

    it('保留内联结构，只在文本节点内部插入换行', () => {
        const {document} = page('<p id="target"></p>');
        const container = document.createElement('span');
        container.innerHTML = `<a href="/a">链接</a> ${long}<em> </em>`;
        expect(LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH).toBe(120);
        expect(applyLongParagraphLineBreaks(container, 20)).toBe(true);
        expect(container.querySelector('a')?.textContent).toBe('链接');
        expect(container.querySelectorAll('br').length).toBeGreaterThan(0);
    });
});

describe('译文位置与换行的渲染开关', () => {
    it('默认把译文追加在原文之后，开启后放到原文之前', () => {
        const {document} = page('<p id="host">Original text</p>');
        const globalRecord = globalThis as unknown as Record<string, unknown>;
        const previous = new Map<string, PropertyDescriptor | undefined>();
        const realm = document.defaultView as unknown as Record<string, unknown>;
        const bindings: Record<string, unknown> = {
            document,
            Node: realm.Node,
            Element: realm.Element,
            HTMLElement: realm.HTMLElement,
            DOMParser: class FixtureDOMParser {
                parseFromString(html: string): Document {
                    return parseHTML(`<html><head></head><body>${html}</body></html>`).document;
                }
            },
        };
        Object.entries(bindings).forEach(([name, value]) => {
            previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalRecord, name, {configurable: true, writable: true, value});
        });
        try {
            const host = document.querySelector('#host') as HTMLElement;
            appendBilingualTranslation(host, '译文内容');
            expect(host.lastElementChild?.classList.contains('fluent-read-bilingual-content')).toBe(true);

            configMock.translationBeforeOriginal = true;
            appendBilingualTranslation(host, '译文内容');
            expect(host.firstElementChild?.classList.contains('fluent-read-bilingual-content')).toBe(true);
            expect(host.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);

            configMock.longParagraphLineBreakEnabled = true;
            appendBilingualTranslation(host, '第一句话已经足够长了，用来测试渲染时的换行行为，并且补充更多描述性的文字。第二句话继续补充上下文，让整段译文的总长度稳定超过长段落换行的字符门槛。第三句话再补充一些内容，确保这一段在任何运行环境下都会被视为长段落处理。第四句话结束整个段落，并让字符总数明显高于门槛。');
            expect(host.querySelectorAll('.fluent-read-bilingual-content br').length).toBe(3);
        } finally {
            previous.forEach((descriptor, name) => {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalRecord[name];
            });
        }
    });
});

describe('免滚动预翻译字符预算', () => {
    function session() {
        return {pending: new Map<Node, TranslationCandidate>(), scheduled: new Map<Node, TranslationCandidate>()};
    }

    function candidate(document: Document, text: string, inline = false): TranslationCandidate {
        const element = document.createElement('p');
        element.textContent = text;
        document.body.appendChild(element);
        return inline
            ? {element, nodes: Array.from(element.childNodes), kind: 'content', reason: 'test'}
            : {element, kind: 'content', reason: 'test'};
    }

    it('统计宿主与内联 run 的字符量', () => {
        const {document} = page('');
        expect(candidateTextLength(candidate(document, 'abcde'))).toBe(5);
        expect(candidateTextLength(candidate(document, 'abcde', true))).toBe(5);
        const empty = document.createElement('p');
        expect(candidateTextLength({element: empty, nodes: [], kind: 'content', reason: 'test'})).toBe(0);
        // 没有文本内容的宿主或节点按 0 计，不影响后续候选的预算。
        expect(candidateTextLength({
            element: {textContent: null} as unknown as HTMLElement,
            kind: 'content',
            reason: 'test',
        })).toBe(0);
        expect(candidateTextLength({
            element: empty,
            nodes: [{textContent: null} as unknown as ChildNode],
            kind: 'content',
            reason: 'test',
        })).toBe(0);

        configMock.eagerTranslationCharacters = 1;
        const nullTextCandidate = {
            element: empty,
            nodes: [{textContent: null} as unknown as ChildNode],
            kind: 'content' as const,
            reason: 'test',
        };
        expect(consumeEagerTranslationBudget(session(), empty, nullTextCandidate)).toBe(true);

        const nullElementCandidate = {
            element: {textContent: null} as unknown as HTMLElement,
            kind: 'content' as const,
            reason: 'test',
        };
        expect(consumeEagerTranslationBudget(session(), empty, nullElementCandidate)).toBe(true);
    });

    it('按发现顺序扣减预算，用尽后交还视口门禁', () => {
        const {document} = page('');
        configMock.eagerTranslationCharacters = 12;
        const active = session();
        const first = candidate(document, '0123456789');
        expect(getEagerTranslationBudget(active)).toBe(12);
        expect(consumeEagerTranslationBudget(active, first.element, first)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(2);

        const second = candidate(document, '0123456789');
        expect(consumeEagerTranslationBudget(active, second.element, second)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(0);

        const third = candidate(document, 'more text');
        expect(consumeEagerTranslationBudget(active, third.element, third)).toBe(false);
    });

    it('scheduled/pending 不会冒充预算账本，同一原文重绑定不二次扣减，换代会重新扣减', () => {
        const {document} = page('');
        configMock.eagerTranslationCharacters = 50;
        const active = session();
        const pending = candidate(document, '0123456789', true);
        active.pending.set(pending.element, pending);
        expect(consumeEagerTranslationBudget(active, pending.element, pending)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(40);

        expect(consumeEagerTranslationBudget(active, pending.element, pending)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(40);

        pending.element.textContent = 'changed source';
        const scheduled = {...pending, nodes: Array.from(pending.element.childNodes)};
        active.scheduled.set(pending.element, scheduled);
        expect(consumeEagerTranslationBudget(active, scheduled.element, scheduled)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(26);

        pending.element.textContent = '01234567890123456789012345';
        const exhausted = {...scheduled, nodes: Array.from(pending.element.childNodes)};
        expect(consumeEagerTranslationBudget(active, exhausted.element, exhausted)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(0);

        pending.element.textContent = '01234567890123456789012345';
        expect(consumeEagerTranslationBudget(active, pending.element, exhausted)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(0);

        pending.element.textContent = 'new source after exhaustion';
        const changedAfterExhaustion = {...exhausted, nodes: Array.from(pending.element.childNodes)};
        expect(consumeEagerTranslationBudget(active, pending.element, changedAfterExhaustion)).toBe(false);

        configMock.eagerTranslationCharacters = 0;
        const disabled = session();
        const only = candidate(document, 'text');
        expect(consumeEagerTranslationBudget(disabled, only.element, only)).toBe(false);
    });
});


describe('排除语言配置归一化', () => {
    it('缺省、非法值与空列表保留不额外排除的默认行为', () => {
        for (const value of [undefined, null, 'en', 1, {}, []]) expect(normalizeExcludedLanguages(value)).toEqual([]);
    });
    it('归一别名、去重、拒绝目录外语言并隔离传入数组', () => {
        const input = ['zh_TW', ' EN ', 'zh-Hant', 'auto', 'unknown', 'yue', 'de', false, null, 'zh-CN'];
        const result = normalizeExcludedLanguages(input);
        expect(result).toEqual(['zh-Hans', 'zh-Hant', 'en', 'de']);
        result.push('fr');
        expect(input).not.toContain('fr');
    });
});

describe('不翻译标签与选择器配置归一化', () => {
    it('清洗、规范标签大小写、去重、拒绝根选择器与超限条目', () => {
        expect(COMMON_EXCLUDED_TAG_OPTIONS.length).toBeGreaterThan(0);
        for (const value of [undefined, null, 'blockquote', 1, {}, []]) expect(normalizeExcludedTags(value)).toEqual([]);
        expect(normalizeExcludedTagEntry(123)).toBeNull();
        expect(normalizeExcludedTagEntry('   ')).toBeNull();
        expect(normalizeExcludedTagEntry('a\u0000b')).toBeNull();
        expect(normalizeExcludedTagEntry('a'.repeat(EXCLUDED_TAG_MAX_LENGTH + 1))).toBeNull();
        for (const root of ['html', 'HTML', 'body', 'BODY', '*', ':root']) {
            expect(normalizeExcludedTagEntry(root)).toBeNull();
        }
        const normalized = normalizeExcludedTags([
            ' BLOCKQUOTE ', 'blockquote', '.NoTrans', '[data-Role="Badge"]', 'H1', 'html', 'body', '*', '', null,
        ]);
        expect(normalized).toEqual(['blockquote', '.NoTrans', '[data-Role="Badge"]', 'h1']);

        const overflowing = Array.from({length: EXCLUDED_TAGS_MAX + 10}, (_, index) => `.item-${index}`);
        expect(normalizeExcludedTags(overflowing)).toHaveLength(EXCLUDED_TAGS_MAX);
    });

    it('按非嵌套分隔符拆分用户输入并校验选择器语法', () => {
        expect(splitExcludedTagInput(
            'blockquote, .ad，#toc; [data-a="1,2\\"3"]；:is(h1, h2)\n[data-b=\'x;y\']  ) ]',
        )).toEqual([
            'blockquote',
            '.ad',
            '#toc',
            '[data-a="1,2\\"3"]',
            ':is(h1, h2)',
            "[data-b='x;y']  ) ]",
        ]);
        const {document} = page('');
        expect(validateExcludedTagSelector('BLOCKQUOTE', document)).toEqual({ok: true, selector: 'blockquote'});
        expect(validateExcludedTagSelector('.no-trans', document)).toEqual({ok: true, selector: '.no-trans'});
        expect(validateExcludedTagSelector('body', document)).toEqual({ok: false, reason: 'disallowed'});
        expect(validateExcludedTagSelector('*', document)).toEqual({ok: false, reason: 'disallowed'});
        expect(validateExcludedTagSelector('   ', document)).toEqual({ok: false, reason: 'invalid'});
        expect(validateExcludedTagSelector('div[unclosed', document)).toEqual({ok: false, reason: 'invalid'});
        expect(validateExcludedTagSelector('blockquote')).toEqual({ok: true, selector: 'blockquote'});
    });

    it('在全文发现、悬浮解析、行内保护、全部范围和站点适配器中一致跳过不翻译标签', () => {
        const {document, url} = page(`
            <main>
                <article>
                    <h1 id="title">Main article heading</h1>
                    <p id="mixed">Read the <mark id="inline-mark">highlighted term</mark> carefully today.</p>
                    <p id="only-excluded"><mark>Only excluded content here.</mark></p>
                    <blockquote id="quote"><p id="quoted-p">Quoted paragraph should stay original.</p></blockquote>
                    <div class="ad-box"><p id="ad-p">Sponsored advertisement text.</p></div>
                </article>
                <nav id="site-nav"><a id="nav-link" href="/docs">Navigation link text</a></nav>
            </main>
        `);
        const adapter = createDeclarativeAdapter({
            id: 'test-force-h1',
            hosts: ['example.test'],
            targets: [{selector: 'h1', reason: 'forced-heading'}],
        });
        const core = createTranslationCore({
            url,
            adapters: [adapter],
            excludedSelectors: ['blockquote', 'mark', '.ad-box', 'h1', 'div[broken'],
        });
        const candidates = core.discover(document.body);
        expect(candidates.map(item => item.element.id)).toEqual(['mixed']);

        const mixed = document.getElementById('mixed') as HTMLElement;
        expect(extractTranslationText(mixed, core.shouldStayOriginal, undefined, core.textOptions())).toBe('Read the carefully today.');
        const slots = collectLiveTranslationTextSlots(mixed, core.shouldStayOriginal, undefined, core.textOptions());
        expect(slots.map(slot => slot.source)).toEqual(['Read the', 'carefully today.']);
        const snapshot = createTranslationSourceSnapshot(mixed, core.shouldStayOriginal, undefined, core.textOptions());
        expect(snapshot.slots.map(slot => slot.source)).toEqual(['Read the', 'carefully today.']);

        expect(core.resolve(document.getElementById('quoted-p')!.firstChild)).toBeNull();
        expect(core.resolve(document.getElementById('ad-p')!.firstChild)).toBeNull();
        expect(core.resolve(document.getElementById('inline-mark')!.firstChild)).toBeNull();
        expect(core.resolve(mixed.firstChild)?.element.id).toBe('mixed');

        const mark = document.getElementById('inline-mark')!;
        (document as unknown as {elementsFromPoint?: (x: number, y: number) => Element[]}).elementsFromPoint = () => [mark, mixed, document.body];
        expect(core.resolveAtPoint(document, 10, 10)).toBeNull();
        expect(core.shouldStayOriginal(document.body)).toBe(false);

        const allScopeCore = createTranslationCore({
            url,
            scope: 'all',
            includeSidebarRegions: true,
            excludedSelectors: ['nav', 'blockquote', '.ad-box', 'h1', 'mark'],
        });
        expect(allScopeCore.discover(document.body).map(item => item.element.id)).toEqual(['mixed']);

        const brokenOnlyCore = createTranslationCore({url, excludedSelectors: ['div[broken']});
        expect(brokenOnlyCore.discover(document.body).some(item => item.element.id === 'quote' || item.element.id === 'quoted-p')).toBe(true);
        expect(core.shouldStayOriginal({ownerDocument: null} as unknown as Element)).toBe(false);

        const forceAndExcludeCore = createTranslationCore({
            url,
            adapters: [{...adapter, forceTranslate: ['#mixed']}],
            excludedSelectors: ['mark'],
        });
        expect(forceAndExcludeCore.textOptions()?.allowNoTranslate).toBeTypeOf('function');
        expect(forceAndExcludeCore.textOptions()?.isExcludedElement).toBeTypeOf('function');
    });

    it('通过 setCurrentTranslationExcludedSelectors 注入共享核心并仅在变化时重建缓存', () => {
        const before = getCurrentTranslationCore('content');
        expect(setCurrentTranslationExcludedSelectors([])).toEqual([]);
        expect(getCurrentTranslationCore('content')).toBe(before);

        expect(setCurrentTranslationExcludedSelectors(['BLOCKQUOTE', '.ad'])).toEqual(['blockquote', '.ad']);
        const updated = getCurrentTranslationCore('content');
        expect(updated).not.toBe(before);
        expect(updated.excludedSelectors).toEqual(['blockquote', '.ad']);

        expect(setCurrentTranslationExcludedSelectors(['blockquote', '.ad'])).toEqual(['blockquote', '.ad']);
        expect(getCurrentTranslationCore('content')).toBe(updated);

        expect(setCurrentTranslationExcludedSelectors(['blockquote', '#toc'])).toEqual(['blockquote', '#toc']);
        expect(getCurrentTranslationCore('content')).not.toBe(updated);
    });
});
