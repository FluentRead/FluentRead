/**
 * @file src/core/site-adaptation/xVideoMutationRescan.ts
 * 文件职责：计算 X 播放器身份节点变化所影响的局部全文重扫根。
 * 主要内容：仅对头像、GIF 缩略图或播放器直属 video 的增删返回原生覆盖层；所有祖先、变更子树与兄弟节点均有界。
 * 模块边界：纯只读 DOM，不创建观察器、计时器或修改宿主；只由内置 X 适配器启用，超限与歧义均放弃额外重扫。
 */
const maxAncestors = 128;
const maxChangedNodes = 512;
const maxPlayerNodes = 512;
const overlaySelector = '[data-slot="xds-context-menu-trigger"]';
const ownedSelector = '[data-fr-translation-owned="true"]';
const thumbnail = 'https://pbs.twimg.com/tweet_video_thumb/';

/** 常见纯文本变更不读取祖先；合计超限时也不推测。 */
function hasChangedElement(mutation: MutationRecord): boolean {
    if (mutation.addedNodes.length + mutation.removedNodes.length > maxChangedNodes) return false;
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
        for (const node of list) if (node.nodeType === 1 || node.nodeType === 11) return true;
    }
    return false;
}

/** 非覆盖层变更只可能通过直属 video 改变作者保护，绝不扫描其子树。 */
function changedDirectVideo(mutation: MutationRecord): boolean {
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
        for (const node of list) {
            if (node.nodeType === 1 && (node as Element).localName === 'video' &&
                !(node as Element).matches(ownedSelector)) return true;
        }
    }
    return false;
}

/** 扫描覆盖层的被增删子树；扩展自身子树不触发站点扫描。 */
function changedIdentityImage(mutation: MutationRecord): boolean {
    const pending: Node[] = [];
    let count = 0;
    for (const list of [mutation.addedNodes, mutation.removedNodes]) {
        for (const node of list) pending.push(node);
    }
    while (pending.length) {
        const node = pending.pop()!;
        count += 1;
        if (node.nodeType === 1) {
            const element = node as Element;
            if (element.matches(ownedSelector)) continue;
            if (element.localName === 'img' && (element.getAttribute('alt')?.startsWith('@') ||
                element.getAttribute('src')?.startsWith(thumbnail))) return true;
        }
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (pending.length + count >= maxChangedNodes) return false;
            pending.push(child);
        }
    }
    return false;
}

/** 验证目标及播放器来自当前文档的 main/article，不能穿过扩展自己的节点。 */
function ancestry(target: Element): {overlay: Element | null; valid: boolean} {
    let node: Element | null = target, overlay: Element | null = null;
    let article = false, main = false, depth = 0;
    while (node) {
        if (++depth > maxAncestors || node.matches(ownedSelector)) return {overlay: null, valid: false};
        if (!overlay && node.matches(overlaySelector)) overlay = node;
        if (node.localName === 'article') article = true;
        if (article && node.localName === 'main') main = true;
        node = node.parentElement;
    }
    return {overlay, valid: main};
}

/** 播放器直属子节点必须在预算内；不对模糊或多个覆盖层猜测。 */
function playerChildren(player: Element): {video: boolean; overlay: Element | null} | null {
    let node = player.firstChild, count = 0, video = false, overlay: Element | null = null;
    while (node) {
        if (++count > maxPlayerNodes) return null;
        if (node.nodeType === 1) {
            const element = node as Element;
            if (!element.matches(ownedSelector)) {
                if (element.localName === 'video') video = true;
                if (element.matches(overlaySelector)) {
                    if (overlay) return null;
                    overlay = element;
                }
            }
        }
        node = node.nextSibling;
    }
    return {video, overlay};
}

export function xVideoChildListRescanRoot(mutation: MutationRecord): Element | null {
    if (mutation.type !== 'childList' || mutation.target.nodeType !== 1) return null;
    const target = mutation.target as Element;
    if (!target.isConnected || target.getRootNode() !== target.ownerDocument) return null;
    if (!hasChangedElement(mutation)) return null;
    const {overlay, valid} = ancestry(target);
    if (!valid) return null;
    if (overlay) {
        if (!changedIdentityImage(mutation)) return null;
        const player = overlay.parentElement!;
        const children = playerChildren(player);
        return children?.video && children.overlay === overlay ? overlay : null;
    }
    if (!changedDirectVideo(mutation)) return null;
    const children = playerChildren(target);
    return children?.overlay ?? null;
}
