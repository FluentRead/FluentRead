/**
 * @file src/shared/dom/shadowQuery.ts
 * 文件职责：提供可穿透开放 Shadow DOM 的轻量级只读选择器查询、存在性判定与包含关系检测工具。
 * 主要内容：支持 O(1) 轻 DOM 短路的 hasSelectorDeep、使用 TreeWalker 在分支级剪枝 FluentRead 自有子树（data-fluent-read-owned / data-fluent-read-ui / .fluent-read-video-ui）的 querySelectorAllDeep，以及跨开放 ShadowRoot 边界的 containsDeep。
 * 模块边界：仅执行只读 DOM 查询，不修改页面节点、不依赖浏览器扩展 API 或业务配置，供媒体定位与字幕运行时按需复用。
 */

const OWNED_NODE_SELECTOR = '[data-fluent-read-owned="true"], [data-fluent-read-ui], .fluent-read-video-ui';
const SHOW_ELEMENT = 1;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

function isOwnedElement(node: unknown): boolean {
    const element = node as Partial<Element> | null;
    return typeof element?.closest === 'function' && Boolean(element.closest(OWNED_NODE_SELECTOR));
}

function forEachShadowRoot(node: ParentNode, visitShadow: (shadowRoot: ShadowRoot) => boolean): boolean {
    const doc = (typeof (node as Partial<Document>).createTreeWalker === 'function'
        ? node
        : (node as Partial<Node>).ownerDocument) as Partial<Document> | null | undefined;
    if (typeof doc?.createTreeWalker === 'function') {
        const walker = doc.createTreeWalker(node, SHOW_ELEMENT, {
            acceptNode: (candidate: Node) => {
                const element = candidate as Element;
                if (element.matches(OWNED_NODE_SELECTOR)) return FILTER_REJECT;
                return element.shadowRoot ? FILTER_ACCEPT : FILTER_SKIP;
            },
        });
        let current = walker.nextNode();
        while (current) {
            const element = current as Element;
            if (element.shadowRoot && !isOwnedElement(element) && visitShadow(element.shadowRoot)) {
                return true;
            }
            current = walker.nextNode();
        }
        return false;
    }
    for (const element of Array.from(node.querySelectorAll('*'))) {
        if (element.shadowRoot && !isOwnedElement(element) && visitShadow(element.shadowRoot)) {
            return true;
        }
    }
    return false;
}

/** 快速判定轻 DOM 或有界深度内开放 Shadow DOM 是否存在匹配选择器的非自有元素；轻 DOM 优先 O(1) 短路。 */
export function hasSelectorDeep(
    root: ParentNode,
    selector: string,
    maxDepth = 4,
): boolean {
    if (isOwnedElement(root)) return false;

    const visit = (node: ParentNode, depth: number): boolean => {
        const first = node.querySelector(selector);
        if (first) {
            if (!isOwnedElement(first)) return true;
            if (Array.from(node.querySelectorAll(selector)).some(match => !isOwnedElement(match))) return true;
        }
        if (depth >= maxDepth) return false;
        const hostRoot = (node as Partial<Element>).shadowRoot;
        if (hostRoot && visit(hostRoot, depth + 1)) return true;
        return forEachShadowRoot(node, shadowRoot => visit(shadowRoot, depth + 1));
    };

    return visit(root, 0);
}

/** 跨开放 Shadow DOM 边界判定 ancestor 是否包含 descendant（含自身相等）。 */
export function containsDeep(ancestor: Node, descendant: Node | null): boolean {
    if (!descendant) return false;
    if (ancestor === descendant || ancestor.contains(descendant)) return true;
    let current: Node | null = descendant;
    while (current) {
        if (current === ancestor) return true;
        current = current.parentNode || (current as Partial<ShadowRoot>).host || null;
    }
    return false;
}

/** 收集轻 DOM 与有界深度内开放 Shadow DOM 中匹配选择器的非自有元素并去重。 */
export function querySelectorAllDeep<T extends Element = Element>(
    root: ParentNode,
    selector: string,
    maxDepth = 4,
): T[] {
    if (isOwnedElement(root)) return [];
    const results: T[] = [];
    const seen = new Set<T>();

    const visit = (node: ParentNode, depth: number): void => {
        for (const match of Array.from(node.querySelectorAll<T>(selector))) {
            if (seen.has(match) || isOwnedElement(match)) continue;
            seen.add(match);
            results.push(match);
        }
        if (depth >= maxDepth) return;
        const hostRoot = (node as Partial<Element>).shadowRoot;
        if (hostRoot) visit(hostRoot, depth + 1);
        forEachShadowRoot(node, shadowRoot => {
            visit(shadowRoot, depth + 1);
            return false;
        });
    };

    visit(root, 0);
    return results;
}
