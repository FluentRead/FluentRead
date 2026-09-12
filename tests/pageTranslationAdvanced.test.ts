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
    DEFAULT_EAGER_TRANSLATION_CHARACTERS,
    DEFAULT_MIN_TRANSLATION_TEXT_LENGTH,
    EAGER_TRANSLATION_CHARACTERS_MAX,
    MIN_TRANSLATION_TEXT_LENGTH_MAX,
    normalizeEagerTranslationCharacters,
    normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';
import {
    LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH,
    applyLongParagraphLineBreaks,
    splitTranslationSentences,
} from '@/src/core/translation/lineBreak';
import {
    candidateTextLength,
    consumeEagerTranslationBudget,
    getEagerTranslationBudget,
} from '@/src/features/full-page-translation/content/eagerTranslation';
import {
    createTranslationCore,
    extractTranslationText,
    getCurrentTranslationCore,
    getMinimumTranslationTextLength,
    isMeaningfulTranslationText,
    setCurrentTranslationSidebarRegions,
    setMinimumTranslationTextLength,
} from '@/src/core/translation/public';
import {getCurrentTranslationSidebarRegions} from '@/src/core/translation/current';
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
        expect(getMinimumTranslationTextLength()).toBe(DEFAULT_MIN_TRANSLATION_TEXT_LENGTH);
        expect(isMeaningfulTranslationText('ok')).toBe(true);
        expect(isMeaningfulTranslationText('a1')).toBe(false);

        expect(setMinimumTranslationTextLength(6)).toBe(6);
        expect(getMinimumTranslationTextLength()).toBe(6);
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
    const html = `
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

        const opened = page(html);
        const openedSources = sources(createTranslationCore({
            scope: 'content',
            includeSidebarRegions: true,
            url: opened.url,
        }).discover(opened.document));
        expect(openedSources).toContain('Related reading for this article.');
        expect(openedSources).toContain('Documentation home for the project.');
        expect(openedSources).not.toContain('Copyright notice for the whole site.');
    });

    it('共享核心按注入的开关重建，重复注入同一取值不会浪费缓存', () => {
        expect(getCurrentTranslationSidebarRegions()).toBe(false);
        expect(getCurrentTranslationCore('content').includeSidebarRegions).toBe(false);

        setCurrentTranslationSidebarRegions(true);
        expect(getCurrentTranslationSidebarRegions()).toBe(true);
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

    it('重新绑定同一候选不会二次扣减，预算为零时直接放行给视口调度', () => {
        const {document} = page('');
        configMock.eagerTranslationCharacters = 50;
        const active = session();
        const pending = candidate(document, '0123456789');
        active.pending.set(pending.element, pending);
        expect(consumeEagerTranslationBudget(active, pending.element, pending)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(50);

        const scheduled = candidate(document, '0123456789');
        active.scheduled.set(scheduled.element, scheduled);
        expect(consumeEagerTranslationBudget(active, scheduled.element, scheduled)).toBe(true);
        expect(getEagerTranslationBudget(active)).toBe(50);

        configMock.eagerTranslationCharacters = 0;
        const disabled = session();
        const only = candidate(document, 'text');
        expect(consumeEagerTranslationBudget(disabled, only.element, only)).toBe(false);
    });
});
