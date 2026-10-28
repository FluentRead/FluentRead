/**
 * @file src/core/site-adaptation/xGifLabel.ts
 * 文件职责：保护 X 公开帖子播放器中的纯 GIF 类型标签，保留可阅读的说明和字幕。
 * 主要内容：有界核验直属视频、GIF 缩略图及本地文字标签结构，只接受完整原生文本 GIF；自有译文不参与判断。
 * 模块边界：只组合内置 X 适配器的候选和快照保护，不改变宿主 DOM；同名自定义规则替换时不继承此能力。
 */
import type {AdapterContext, TranslationSiteAdapter} from '../translation/types';
import {xVideoChildListRescanRoot} from './xVideoMutationRescan';

const owned = '[data-fr-translation-owned="true"]';
const labelSelector = 'div.bg-black-80.text-on-color.text-subtext3.font-bold';
const interaction = ['role', 'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby'];
const maxLabelNodes = 64;
const maxLabelTextLength = 64;
const maxAncestors = 128;
const maxPlayerNodes = 512;
const maxOverlayNodes = 4096;

/** 深度优先遍历每个节点最多一次；超预算不推测存在或不存在缩略图。 */
function hasGifThumbnail(overlay: Element, thumbnail: string): boolean {
    let node: Node | null = overlay.firstChild;
    let visited = 0;
    while (node && node !== overlay) {
        if (++visited > maxOverlayNodes) return false;
        if (node.nodeType === 1) {
            const element = node as Element;
            if (element.localName === 'img' && element.getAttribute('src')?.startsWith(thumbnail)) return true;
        }
        if (node.firstChild) {node = node.firstChild; continue;}
        while (node && node !== overlay && !node.nextSibling) node = node.parentNode;
        node = node && node !== overlay ? node.nextSibling : null;
    }
    return false;
}

/** 仅接受已观察到的播放器标识；不把相同样式的说明、字幕或其他标签一起保护。 */
export function isXGifLabel(element: Element): boolean {
    if (!element.matches(labelSelector) || interaction.some(attribute => element.hasAttribute(attribute))) return false;
    let text = '', labelNodes = 0;
    for (const node of element.childNodes) {
        if (++labelNodes > maxLabelNodes) return false;
        if (node.nodeType === 3) {
            if (text.length + (node as Text).length > maxLabelTextLength) return false;
            const part = node.textContent!;
            text += part;
        }
        else if (node.nodeType !== 1 || !(node as Element).matches(owned)) return false;
    }
    if (text.trim() !== 'GIF') return false;
    // 与 closest 等价地查找最近覆盖层、main 内 article 和任一保护祖先；超限时放弃匹配。
    let ancestor: Element | null = element, overlay: Element | null = null;
    let ancestorCount = 0, playerReached = false, articleReached = false, inMainArticle = false;
    while (ancestor) {
        if (++ancestorCount > maxAncestors || ancestor.matches(owned) || ancestor.matches('[dir="auto"]')) return false;
        if (!overlay && ancestor.matches('[data-slot="xds-context-menu-trigger"]')) overlay = ancestor;
        if (overlay && ancestor === overlay.parentElement) playerReached = true;
        if (playerReached && ancestor.localName === 'article') articleReached = true;
        if (articleReached && ancestor.localName === 'main') inMainArticle = true;
        ancestor = ancestor.parentElement;
    }
    const player = overlay?.parentElement;
    if (!overlay || !player || !inMainArticle) return false;
    const thumbnail = 'https://pbs.twimg.com/tweet_video_thumb/';
    let child = player.firstChild, playerNodes = 0, hasGifVideo = false;
    while (child) {
        if (++playerNodes > maxPlayerNodes) return false;
        if (child.nodeType === 1) {
            const element = child as Element;
            if (element.localName === 'video' && element.getAttribute('src')?.startsWith('https://video.twimg.com/tweet_video/')) {
                hasGifVideo = true;
                if (element.getAttribute('poster')?.startsWith(thumbnail)) return true;
            }
        }
        child = child.nextSibling;
    }
    return hasGifVideo && hasGifThumbnail(overlay, thumbnail);
}

/** 内置保护仅裁剪标签本身，祖先译文骨架保留原始标签。 */
export function withXGifLabelProtection(adapter: TranslationSiteAdapter): TranslationSiteAdapter {
    const matches = (element: Element, context: AdapterContext) => adapter.matches(context.url) && isXGifLabel(element);
    const wrapped = Object.create(Object.getPrototypeOf(adapter), Object.getOwnPropertyDescriptors(adapter)) as TranslationSiteAdapter;
    wrapped.decide = (element, context) => matches(element, context)
        ? {kind: 'prune-subtree', reason: 'x:gif-label'} : adapter.decide(element, context);
    wrapped.shouldStayOriginal = (element, context) => matches(element, context) || adapter.shouldStayOriginal?.(element, context) === true;
    wrapped.childListRescanRoot = (mutation, context) => adapter.matches(context.url) ? xVideoChildListRescanRoot(mutation) : null;
    return wrapped;
}
