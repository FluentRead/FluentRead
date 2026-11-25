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
import {
    appendBilingualTranslation,
    appendSingleTranslationSlots,
    materializeCandidate,
} from '@/src/features/full-page-translation/content/renderer';
import {
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
} from '@/src/core/translation/public';
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

    it.each(['content', 'all'] as const)(
        'keeps modern inline Show more controls and React children intact inside div[dir="auto"] in %s scope',
        scope => {
            const post = hostParagraph(
                '<main><article><div id="target" class="max-w-full text-body font-normal text-primary line-clamp-5 whitespace-pre-wrap wrap-break-word" dir="auto">'
                + '<span class="max-w-full text-[length:inherit]">SILENT BOXY OBJECT OVER CANADA’S CF-18 BASE...</span> '
                + '<button class="max-w-full text-[length:inherit] font-normal text-brand hover:underline" type="button">Show more</button>'
                + '</div></article></main>',
            );
            const card = post.closest('article')!;
            const originalSpan = post.querySelector('span')!;
            const spaceText = originalSpan.nextSibling!;
            const showMore = post.querySelector('button')!;
            const nativeLabel = showMore.firstChild!;
            const core = createTranslationCore({url: new URL('https://x.com/home'), scope});

            const discovered = core.discover(card);
            expect(discovered.map(candidate => ({element: candidate.element, kind: candidate.kind, nodes: candidate.nodes})))
                .toEqual([{element: post, kind: 'content', nodes: undefined}]);

            const materialized = materializeCandidate(discovered[0]!, true);
            expect(materialized).toEqual({node: post, synthetic: false});
            expect(originalSpan.parentNode).toBe(post);
            expect(spaceText.parentNode).toBe(post);
            expect(showMore.parentNode).toBe(post);
            expect(showMore.firstChild).toBe(nativeLabel);

            const snapshot = createTranslationSourceSnapshot(
                post,
                core.shouldStayOriginal,
                undefined,
                undefined,
                core.shouldOmitFromTranslation,
            );
            expect(snapshot.slots.map(slot => slot.source)).toEqual(['SILENT BOXY OBJECT OVER CANADA’S CF-18 BASE...']);
            expect(snapshot.clone.textContent).not.toContain('Show more');

            appendBilingualTranslation(post, '加拿大基地上空的静默方形物体……');

            // React reconciles direct children of div[dir="auto"] on expansion; reparenting any child throws and unmounts the card.
            showMore.addEventListener('click', () => {
                if (
                    originalSpan.parentNode !== post
                    || spaceText.parentNode !== post
                    || showMore.parentNode !== post
                    || nativeLabel.parentNode !== showMore
                ) {
                    card.remove();
                    return;
                }
                post.removeChild(showMore);
                post.removeChild(spaceText);
                post.removeChild(originalSpan);
                const expanded = post.ownerDocument.createElement('span');
                expanded.textContent = 'SILENT BOXY OBJECT OVER CANADA’S CF-18 BASE with the complete expanded report.';
                post.insertBefore(expanded, post.firstChild);
            });

            showMore.click();
            expect(card.isConnected).toBe(true);
            expect(post.textContent).toContain('complete expanded report');
            expect(post.querySelector('button')).toBeNull();

            appendBilingualTranslation(post, '加拿大基地上空的静默方形物体以及完整展开报告。');
            expect(post.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        },
    );

    it.each(['content', 'all'] as const)(
        'omits modal testid links, role="button" inline toggles, and adjacent brand expand buttons in %s scope',
        scope => {
            const post = hostParagraph(
                '<div role="dialog"><article>'
                + '<div id="target" dir="auto"><span>A long timeline post in a modal dialog.</span> '
                + '<span id="role-toggle" role="button">Show more</span></div>'
                + '<button id="adjacent-toggle" class="max-w-full font-normal text-brand hover:underline" type="button">Show more</button>'
                + '<button id="modal-testid" data-testid="tweet-text-show-more-link" type="button">Show more</button>'
                + '<button id="other-action" type="button">Translate post</button>'
                + '</article></div>',
            );
            const card = post.closest('article')!;
            const core = createTranslationCore({url: new URL('https://x.com/home'), scope});
            const discovered = core.discover(card);

            const postCandidate = discovered.find(candidate => candidate.element === post);
            expect(postCandidate).toMatchObject({
                element: post,
                kind: 'content',
            });
            expect(postCandidate?.nodes).toBeUndefined();
            for (const id of ['role-toggle', 'adjacent-toggle', 'modal-testid']) {
                const control = card.querySelector(`#${id}`)!;
                expect(core.shouldOmitFromTranslation(control), id).toBe(true);
                expect(discovered.some(candidate => candidate.element === control), id).toBe(false);
            }
            const otherAction = card.querySelector('#other-action')!;
            expect(core.shouldOmitFromTranslation(otherAction)).toBe(false);
            expect(discovered.some(candidate => candidate.element === otherAction)).toBe(true);
        },
    );
});
