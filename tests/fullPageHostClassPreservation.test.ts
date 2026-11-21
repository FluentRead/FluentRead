import {beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
    config: {
        animations: false,
        translationLoadingStyle: 'minimal',
        service: 'deepseek',
        customOpenAIProviders: [] as unknown[],
        style: 1,
        to: 'zh-Hans',
        longParagraphLineBreakEnabled: false,
        translationBeforeOriginal: false,
    },
    showPageNotice: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/core/config/catalog', () => ({
    options: {services: [{value: 'deepseek', label: 'DeepSeek'}], styles: []},
}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice: mocks.showPageNotice}));

import {
    insertFailedTip,
    insertLoadingSpinner,
} from '@/src/features/full-page-translation/ui/translationIndicators';
import {appendBilingualTranslation, appendSingleTranslationSlots} from '@/src/features/full-page-translation/content/renderer';
import {collectLiveTranslationTextSlots} from '@/src/core/translation/public';
import {createTranslationCore} from './helpers/translationCore';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalDOMParser = globalThis.DOMParser;
const originalRealm = {
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
};

// hms.harvard.edu 用 :not([class]) 给正文段落设定衬线字体与更大字号，
// 宿主一旦多出任何 class（哪怕是空 class 属性）就会掉回默认小字号。
const SITE_TYPOGRAPHY_SELECTOR = 'p:not([class])';

function hostParagraph(html = '<p id="target">Source paragraph.</p>'): HTMLElement {
    const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
    Object.defineProperty(globalThis, 'document', {value: document, configurable: true});
    Object.defineProperty(globalThis, 'window', {value: window, configurable: true});
    const realm = window as unknown as Record<string, unknown>;
    (['Node', 'Element', 'HTMLElement'] as const).forEach((name) => {
        Object.defineProperty(globalThis, name, {value: realm[name], configurable: true});
    });
    // renderer 用 DOMParser 净化译文；linkedom 的实例需要一个带 body 的文档。
    Object.defineProperty(globalThis, 'DOMParser', {
        configurable: true,
        value: class FixtureDOMParser {
            parseFromString(html: string): Document {
                return parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document;
            }
        },
    });
    return document.querySelector<HTMLElement>('#target')!;
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'document', {value: originalDocument, configurable: true});
    Object.defineProperty(globalThis, 'window', {value: originalWindow, configurable: true});
    Object.defineProperty(globalThis, 'DOMParser', {value: originalDOMParser, configurable: true});
    Object.entries(originalRealm).forEach(([name, value]) => {
        Object.defineProperty(globalThis, name, {value, configurable: true});
    });
    mocks.showPageNotice.mockReset();
});

describe('issue #170：翻译不得改写宿主 class 属性', () => {
    it('双语译文插入后，原本无 class 的段落仍匹配站点的 :not([class]) 排版规则', () => {
        const target = hostParagraph();

        appendBilingualTranslation(target, '译文');

        expect(target.matches(SITE_TYPOGRAPHY_SELECTOR)).toBe(true);
        expect(target.querySelector('.fluent-read-bilingual-content')).not.toBeNull();
    });

    it('加载动画不会给宿主段落添加 class', () => {
        const target = hostParagraph();

        insertLoadingSpinner(target);

        expect(target.matches(SITE_TYPOGRAPHY_SELECTOR)).toBe(true);
    });

    it('翻译失败提示改用 data 标记，失败中和重试后都不改变宿主 class', () => {
        const target = hostParagraph();
        const retry = vi.fn();

        const wrapper = insertFailedTip(target, 'quota exceeded', retry);
        expect(target.matches(SITE_TYPOGRAPHY_SELECTOR)).toBe(true);
        expect(target.getAttribute('data-fr-translation-failed')).toBe('true');

        wrapper.querySelector<HTMLElement>('.fluent-read-retry')!.click();

        expect(retry).toHaveBeenCalledOnce();
        expect(target.matches(SITE_TYPOGRAPHY_SELECTOR)).toBe(true);
        expect(target.hasAttribute('data-fr-translation-failed')).toBe(false);
    });

    it('宿主原有 class 在失败与重试后保持不变', () => {
        const target = hostParagraph('<p id="target" class="lead intro">Source paragraph.</p>');

        const wrapper = insertFailedTip(target, 'quota exceeded', vi.fn());
        wrapper.querySelector<HTMLElement>('.fluent-read-retry')!.click();

        expect(target.getAttribute('class')).toBe('lead intro');
    });
});

describe('X timeline expansion', () => {
    it.each(['content', 'all'] as const)('keeps the native expansion label attached in %s scope', scope => {
        const post = hostParagraph('<main><article data-testid="tweet"><div id="target" data-testid="tweetText">'
            + 'The first part of an English timeline post.</div>'
            + '<button data-testid="tweet-text-show-more-link">Show more</button></article></main>');
        const document = post.ownerDocument;
        const card = post.closest('article')!;
        const showMore = card.querySelector('button')!;
        const nativeLabel = showMore.firstChild!;
        const core = createTranslationCore({url: new URL('https://x.com/home'), scope});
        const translateCard = () => {
            for (const candidate of core.discover(card)) {
                if (candidate.kind === 'control') {
                    const slots = collectLiveTranslationTextSlots(candidate.element, core.shouldStayOriginal);
                    appendSingleTranslationSlots(candidate.element, slots.map(({node}) => ({node, text: '显示更多'})));
                }
                if (candidate.element === post) appendBilingualTranslation(post, '帖子译文。');
            }
        };
        // A framework holds the original label reference and removes it from its own button.
        showMore.addEventListener('click', () => {
            if (nativeLabel.parentNode !== showMore) {
                card.remove();
                return;
            }
            showMore.removeChild(nativeLabel);
            showMore.remove();
            post.textContent = 'The expanded English timeline post has more paragraphs.';
        });
        translateCard();
        expect(post.querySelector('.fluent-read-bilingual-content')).not.toBeNull();
        expect(showMore.firstChild).toBe(nativeLabel);
        showMore.click();
        expect(card.isConnected).toBe(true);
        expect(post.textContent).toContain('The expanded English timeline post');
        translateCard();
        expect(post.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        expect(document.querySelector('[data-testid="tweet-text-show-more-link"]')).toBeNull();
    });
});
