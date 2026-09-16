import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({
    config: {style: 1, to: 'zh-Hans'},
}));
vi.mock('@/src/core/config/catalog', () => ({
    options: {styles: []},
}));

import {
    CJK_TRANSLATION_FONT_STACKS,
    detectTranslationTextScript,
    resolveTargetTranslationScript,
    resolveTranslationFontFamily,
} from '@/src/core/translation/font';
import {
    appendBilingualTranslation,
    appendSingleTranslationSlots,
} from '@/src/features/full-page-translation/content/renderer';

const JAPANESE_SOURCE = 'これはテストです。スレッドの説明を読んでください。';
const SIMPLIFIED_SOURCE = '这些线程可以互相发送信号，并让对象继续运行。';

function fixture(html: string) {
    const {document} = parseHTML(`<html><body>${html}</body></html>`);
    return document;
}

/**
 * 渲染层在真实浏览器中依赖 DOMParser 与 document 全局；linkedom 文档需要临时
 * 注入同一 realm 的绑定，测试结束后恢复，避免污染其他用例。
 */
function withDocumentRealm<T>(document: Document, callback: () => T): T {
    const realm = document.defaultView as unknown as Record<string, unknown>;
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const bindings: Record<string, unknown> = {
        document,
        window: document.defaultView,
        DOMParser: class FixtureDOMParser {
            parseFromString(source: string): Document {
                return parseHTML(`<html><head></head><body>${source}</body></html>`).document;
            }
        },
        Element: realm.Element,
        HTMLElement: realm.HTMLElement,
        Node: realm.Node,
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    Object.entries(bindings).forEach(([name, value]) => {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalRecord, name, {configurable: true, writable: true, value});
    });
    try {
        return callback();
    } finally {
        previous.forEach((descriptor, name) => {
            if (descriptor) Object.defineProperty(globalRecord, name, descriptor);
            else delete globalRecord[name];
        });
    }
}

function stubComputedFontFamily(document: Document, fontFamily: string | (() => never)): void {
    const view = document.defaultView as unknown as Record<string, unknown>;
    view.getComputedStyle = typeof fontFamily === 'function'
        ? fontFamily
        : () => ({fontFamily});
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('译文书写体系识别', () => {
    it('假名判定日文，谚文判定韩文，汉字沿用保守的简繁判定', () => {
        expect(detectTranslationTextScript(JAPANESE_SOURCE)).toBe('Jpan');
        expect(detectTranslationTextScript('カタカナのみ')).toBe('Jpan');
        expect(detectTranslationTextScript('한국어 문장입니다')).toBe('Kore');
        expect(detectTranslationTextScript(SIMPLIFIED_SOURCE)).toBe('Hans');
        expect(detectTranslationTextScript('這些執行緒會互相發送訊號並繼續運作')).toBe('Hant');
    });

    it('纯拉丁与无法确认的汉字文本不给出结论', () => {
        expect(detectTranslationTextScript('More interesting is that QObjects can be used.')).toBeUndefined();
        expect(detectTranslationTextScript('')).toBeUndefined();
        expect(detectTranslationTextScript('日本語')).toBeUndefined();
    });
});

describe('目标语言书写体系解析', () => {
    it('只接受明确声明 CJK 书写体系的目标语言', () => {
        expect(resolveTargetTranslationScript('zh-Hans')).toBe('Hans');
        expect(resolveTargetTranslationScript('zh-TW')).toBe('Hant');
        expect(resolveTargetTranslationScript('ja')).toBe('Jpan');
        expect(resolveTargetTranslationScript('ja-JP')).toBe('Jpan');
        expect(resolveTargetTranslationScript('KO')).toBe('Kore');
        expect(resolveTargetTranslationScript('ko_KR')).toBe('Kore');
    });

    it('拉丁语言、auto 与空值不改写字体', () => {
        expect(resolveTargetTranslationScript('en')).toBeUndefined();
        expect(resolveTargetTranslationScript('auto')).toBeUndefined();
        expect(resolveTargetTranslationScript('')).toBeUndefined();
    });
});

describe('译文字体族解析', () => {
    it('跨书写体系时把目标字体族前置到宿主字体栈', () => {
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'zh-Hans', '"Yu Gothic", Meiryo, sans-serif'))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, "Yu Gothic", Meiryo, sans-serif`);
        expect(resolveTranslationFontFamily('한국어 문장입니다', 'zh-Hant', 'Malgun Gothic'))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hant}, Malgun Gothic`);
        expect(resolveTranslationFontFamily(SIMPLIFIED_SOURCE, 'ja', 'PingFang SC'))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Jpan}, PingFang SC`);
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'ko', 'Meiryo'))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Kore}, Meiryo`);
    });

    it('拿不到宿主字体栈时补一个通用字体，并裁掉末尾分隔符', () => {
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'zh-Hans'))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, sans-serif`);
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'zh-Hans', '   '))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, sans-serif`);
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'zh-Hans', 'Meiryo, '))
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, Meiryo`);
    });

    it('同书写体系、非 CJK 目标与无法识别的原文都保持网页原有排版', () => {
        expect(resolveTranslationFontFamily(SIMPLIFIED_SOURCE, 'zh-Hans', 'PingFang SC')).toBeUndefined();
        expect(resolveTranslationFontFamily(JAPANESE_SOURCE, 'en', 'Meiryo')).toBeUndefined();
        expect(resolveTranslationFontFamily('More interesting is that QObjects can be used.', 'zh-Hans', 'Georgia'))
            .toBeUndefined();
    });
});

describe('译文节点字体渲染', () => {
    it('日文段落译成简体中文时，双语译文改用简体字体族', () => {
        const document = fixture('<p id="host">これはテストです。</p>');
        stubComputedFontFamily(document, '"Yu Gothic", Meiryo, sans-serif');
        const node = document.querySelector<HTMLElement>('#host')!;

        const content = withDocumentRealm(document, () => appendBilingualTranslation(node, '这是一个测试。', {
            targetLanguage: 'zh-Hans',
            sourceText: JAPANESE_SOURCE,
        }));

        expect(content.style.fontFamily)
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, "Yu Gothic", Meiryo, sans-serif`);
    });

    it('宿主视图缺失或计算样式不可用时，仍只前置目标字体族', () => {
        const detached = fixture('<p id="host">これはテストです。</p>');
        Object.defineProperty(detached, 'defaultView', {configurable: true, value: null});
        const withoutView = detached.querySelector<HTMLElement>('#host')!;
        const rendered = withDocumentRealm(fixture(''), () =>
            appendBilingualTranslation(withoutView, '这是一个测试。', {
                targetLanguage: 'zh-Hans',
                sourceText: JAPANESE_SOURCE,
            }));
        expect(rendered.style.fontFamily).toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, sans-serif`);

        const throwing = fixture('<p id="host">これはテストです。</p>');
        stubComputedFontFamily(throwing, () => {
            throw new Error('computed style unavailable');
        });
        const node = throwing.querySelector<HTMLElement>('#host')!;
        const content = withDocumentRealm(throwing, () => appendBilingualTranslation(node, '这是一个测试。', {
            targetLanguage: 'zh-Hans',
            sourceText: JAPANESE_SOURCE,
        }));
        expect(content.style.fontFamily).toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, sans-serif`);
    });

    it('英文原文、缺少原文与同语言译文都不写入字体样式', () => {
        const document = fixture('<p id="english">Hello</p><p id="missing">Hello</p>');
        const computedStyle = vi.fn(() => ({fontFamily: 'Georgia, serif'}));
        (document.defaultView as unknown as Record<string, unknown>).getComputedStyle = computedStyle;
        const english = document.querySelector<HTMLElement>('#english')!;
        const missing = document.querySelector<HTMLElement>('#missing')!;

        const [englishContent, missingContent] = withDocumentRealm(document, () => [
            appendBilingualTranslation(english, '你好', {
                targetLanguage: 'zh-Hans',
                sourceText: 'Hello, this is an ordinary English paragraph.',
            }),
            appendBilingualTranslation(missing, '你好', {targetLanguage: 'zh-Hans'}),
        ]);

        expect(englishContent.getAttribute('style')).toBeNull();
        expect(missingContent.getAttribute('style')).toBeNull();
        // 无需改写字体时不读取宿主计算样式，避免逐段提交触发同步样式重算。
        expect(computedStyle).not.toHaveBeenCalled();
    });

    it('仅译文模式的文本槽同样改用目标书写体系的字体', () => {
        const document = fixture('<p id="host">これはテストです。</p>');
        stubComputedFontFamily(document, '"Yu Gothic", Meiryo');
        const owner = document.querySelector<HTMLElement>('#host')!;
        const source = owner.firstChild as Text;

        const created: HTMLElement[] = [];
        const createElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
            const element = createElement(tag) as HTMLElement;
            created.push(element);
            return element;
        }) as typeof document.createElement);

        const hosts = withDocumentRealm(document, () => appendSingleTranslationSlots(
            owner,
            [{node: source, text: '这是一个测试。'}],
            {targetLanguage: 'zh-Hans'},
        ));

        expect(hosts).toHaveLength(1);
        const translated = created[1]!;
        expect(translated.textContent).toBe('这是一个测试。');
        expect(translated.style.fontFamily)
            .toBe(`${CJK_TRANSLATION_FONT_STACKS.Hans}, "Yu Gothic", Meiryo`);
    });

    it('空原文与纯空白原文都不触发字体判定', () => {
        const document = fixture('<p id="empty"></p><p id="blank"> </p>');
        stubComputedFontFamily(document, '"Yu Gothic"');
        const empty = document.querySelector<HTMLElement>('#empty')!;
        const blank = document.querySelector<HTMLElement>('#blank')!;
        const emptySource = document.createTextNode('');
        empty.appendChild(emptySource);

        const created: HTMLElement[] = [];
        const createElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
            const element = createElement(tag) as HTMLElement;
            created.push(element);
            return element;
        }) as typeof document.createElement);

        withDocumentRealm(document, () => {
            appendSingleTranslationSlots(empty, [{node: emptySource, text: ''}], {targetLanguage: 'zh-Hans'});
            appendSingleTranslationSlots(blank, [{node: blank.firstChild as Text, text: ' '}], {targetLanguage: 'zh-Hans'});
        });

        expect(created[1]!.getAttribute('style')).toBeNull();
        expect(created[3]!.getAttribute('style')).toBeNull();
    });
});
