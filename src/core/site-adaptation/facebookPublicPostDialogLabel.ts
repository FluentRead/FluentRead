/**
 * @file src/core/site-adaptation/facebookPublicPostDialogLabel.ts
 * 文件职责：保护 Facebook 公开帖子原生 modal dialog 的 IDREF 标签，避免重复翻译 UI 作者副本。
 * 主要内容：核对唯一 main article、公开 message 与 article 外 heading 的归属，并逐 token
 * 校验 aria-labelledby 指向的唯一原生 ID；只允许纯文字与普通 span，不借姓名、样式或副本推断；
 * 为同一 Facebook 适配的 metadata 模块共享只读节点工具及精确 URL/四边界装饰工厂。
 * 模块边界：仅装饰内置站点 adapter 的四个 metadata 边界，不写 DOM、不联网、不扩展 JSON 字段，
 * 用户同 ID 规则替换或停用时由既有 composition 撤销能力，不改变正文候选或通用硬保护。
 */
import type {AdapterContext, TranslationSiteAdapter} from '../translation/types';

const dialogSelector = '[role="dialog"][aria-modal="true"]';
const articleSelector = '[role="article"]';
const headingSelector = 'h2[dir="auto"]';
const messageSelector = '[data-ad-preview="message"][data-ad-comet-preview="message"]';
const ownedSelector = '[data-fr-translation-owned="true"]';
export const facebookControlSemanticAttributes = ['role', 'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby'];
const interactiveAttributes = facebookControlSemanticAttributes.slice(0, 4);
const observedAttributes = ['id', 'dir', 'role', 'aria-modal', 'aria-labelledby', 'aria-posinset',
    'data-ad-preview', 'data-ad-comet-preview', 'data-fr-translation-owned', ...interactiveAttributes];

function isOwned(element: Element): boolean {
    return element.closest(ownedSelector) !== null;
}

function nativeElements(root: Element, selector: string): Element[] {
    return [...root.querySelectorAll(selector)].filter(element => !isOwned(element));
}

function nativeText(node: Node): string {
    if (node.nodeType === 3) return node.textContent!;
    if (node.nodeType !== 1 || isOwned(node as Element)) return '';
    return [...node.childNodes].map(nativeText).join('');
}

export function facebookNativeChildren(element: Element): Element[] {
    return [...element.children].filter(child => !isOwned(child));
}

export function facebookNativeTextValue(element: Element): string {
    return nativeText(element).replace(/\s+/gu, ' ').trim();
}

export function facebookOnlyNativeChild(element: Element, tag: string): Element | null {
    const nodes = facebookNativeChildren(element);
    return nodes.length === 1 && nodes[0]!.localName === tag ? nodes[0]! : null;
}

export {isOwned as isFacebookOwned, nativeElements as facebookNativeElements};

/** heading/span 的普通包装可变化，但不能因文字相同而吞掉链接、控件、换行或引用结构。 */
function isPlainLabel(heading: Element): boolean {
    const elements = [heading, ...nativeElements(heading, '*')];
    return elements.every(element => (element === heading || element.localName === 'span')
        && !interactiveAttributes.some(attribute => element.hasAttribute(attribute)))
        && nativeText(heading).trim().length > 0;
}

export interface FacebookPublicPostContext {
    dialog: Element;
    article: Element;
    message: Element;
    heading: Element;
}

/** 返回已核实的当前原生关系，供同一帖子内的窄 metadata 组件复用，而非借保护状态推断。 */
export function getFacebookPublicPostContext(heading: Element): FacebookPublicPostContext | null {
    if (!heading.matches(headingSelector) || isOwned(heading) || heading.closest(articleSelector)) return null;
    const dialog = heading.closest(dialogSelector);
    if (!dialog) return null;
    const dialogs = [...dialog.ownerDocument.querySelectorAll(dialogSelector)].filter(candidate => !isOwned(candidate));
    if (dialogs.length !== 1 || dialogs[0] !== dialog) return null;
    const belongsToDialog = (candidate: Element) => candidate.closest(dialogSelector) === dialog;
    const articles = nativeElements(dialog, '[role="article"][aria-posinset="1"]').filter(belongsToDialog);
    const messages = nativeElements(dialog, messageSelector).filter(belongsToDialog);
    if (articles.length !== 1 || messages.length !== 1
        || messages[0]!.closest(articleSelector) !== articles[0]) return null;
    const headings = nativeElements(dialog, headingSelector).filter(candidate =>
        belongsToDialog(candidate) && !candidate.closest(articleSelector));
    if (headings.length !== 1 || headings[0] !== heading) return null;
    const tokens = (dialog.getAttribute('aria-labelledby') || '').trim().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0 || new Set(tokens).size !== tokens.length) return null;
    const ids = [...dialog.ownerDocument.querySelectorAll('[id]')].filter(candidate => !isOwned(candidate));
    const targets: Element[] = [];
    for (const token of tokens) {
        const matches = ids.filter(candidate => candidate.id === token);
        if (matches.length !== 1 || !belongsToDialog(matches[0]!)) return null;
        targets.push(matches[0]!);
    }
    const labelTargets = targets.filter(target => target === heading
        || (target.localName === 'span' && heading.contains(target)));
    return labelTargets.length === 1 && isPlainLabel(heading)
        ? {dialog, article: articles[0]!, message: messages[0]!, heading} : null;
}

export function isFacebookPublicPostDialogLabel(element: Element): boolean {
    const heading = element.closest(headingSelector);
    return Boolean(heading && !isOwned(element) && getFacebookPublicPostContext(heading));
}

/** 只服务这些内置 Facebook 语义边界，不给自定义 JSON 增加新的通用判定能力。 */
export function withFacebookPublicPostProtection(
    adapter: TranslationSiteAdapter,
    predicate: (element: Element) => boolean,
    reason: string,
    extraAttributes: readonly string[] = [],
): TranslationSiteAdapter {
    const matches = (element: Element, context: AdapterContext) => adapter.matches(context.url)
        && context.url.hostname === 'www.facebook.com' && /^\/[^/]+\/posts\/[^/]+(?:\/[^/]+)*\/?$/u.test(context.url.pathname)
        && predicate(element);
    const wrapped = Object.create(Object.getPrototypeOf(adapter), Object.getOwnPropertyDescriptors(adapter)) as TranslationSiteAdapter;
    Object.defineProperty(wrapped, 'observedAttributes', {enumerable: true, get() {
        const attributes = adapter.observedAttributes;
        return attributes === null ? null : [...new Set([...(attributes ?? []), ...observedAttributes,
            ...facebookControlSemanticAttributes, ...extraAttributes])];
    }});
    wrapped.decide = (element, context) => matches(element, context)
        ? {kind: 'prune-subtree', reason} : adapter.decide(element, context);
    wrapped.shouldStayOriginal = (element, context) => matches(element, context)
        || adapter.shouldStayOriginal?.(element, context) === true;
    wrapped.shouldOmitFromTranslation = (element, context) => matches(element, context)
        || adapter.shouldOmitFromTranslation?.(element, context) === true;
    wrapped.shouldIgnoreMutation = (element, context) => matches(element, context)
        || adapter.shouldIgnoreMutation?.(element, context) === true;
    return wrapped;
}

export function withFacebookPublicPostDialogLabelProtection(adapter: TranslationSiteAdapter): TranslationSiteAdapter {
    return withFacebookPublicPostProtection(adapter, isFacebookPublicPostDialogLabel, 'facebook-public-post:dialog-label');
}
