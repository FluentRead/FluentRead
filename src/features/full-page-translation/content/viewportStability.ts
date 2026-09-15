/**
 * @file src/features/full-page-translation/content/viewportStability.ts
 * 文件职责：隔离全文翻译对页面滚动稳定性的辅助逻辑，避免动态页面在插入译文时发生视觉跳动或重复重排。
 * 主要内容：仅为视口上方的已知 DOM 变化提供可嵌套锚点补偿，并提供滚动空闲门控；不参与候选发现、翻译请求或节点状态机。
 * 模块边界：本文件只管理可逆的浏览器视口状态与延迟回调，具体重启目标仍由全文 runtime 决定。
 */

const TRANSLATION_ARTIFACT_SELECTOR = [
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
    '.fluent-read-bilingual-content',
].join(',');

const FULL_PAGE_SCROLL_IDLE_MS = 220;

function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === 'function');
}

function asHTMLElement(node: unknown): HTMLElement | null {
    if (!node || typeof node !== 'object' || (node as Node).nodeType !== 1) return null;
    const element = node as HTMLElement;
    return typeof element.tagName === 'string' && typeof element.style === 'object' ? element : null;
}

interface FullPageViewportAnchor {
    element: HTMLElement;
    top: number;
    scrollContainer: HTMLElement | null;
}

function isExcluded(element: HTMLElement, excludedNodes: readonly Node[]): boolean {
    return excludedNodes.some((excluded) => excluded === element ||
        (isElementNode(excluded) && (excluded.contains(element) || element.contains(excluded))));
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
    let current = element.parentElement;
    while (current && current !== document.body) {
        try {
            // 先做便宜的溢出量比较：绝大多数祖先都不滚动，可以跳过
            // getComputedStyle 带来的样式重算。两个条件仍是与关系，语义不变。
            if (current.scrollHeight > current.clientHeight) {
                const style = document.defaultView?.getComputedStyle(current);
                if (style && /(auto|scroll|overlay)/u.test(style.overflowY)) return current;
            }
        } catch {
            // Host custom elements can throw while their layout is being rebuilt.
        }
        current = current.parentElement;
    }
    return null;
}

function viewportTopOf(scrollContainer: HTMLElement | null): number {
    return scrollContainer
        ? scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop
        : 0;
}

function changedElement(node: Node): HTMLElement | null {
    const element = asHTMLElement(node) ?? asHTMLElement(node.parentElement);
    return element?.isConnected ? element : null;
}

/** 变化元素完全位于给定滚动面视口上沿之上时才会推动该滚动面中的阅读位置。 */
function isAboveViewportTop(element: HTMLElement, scrollContainer: HTMLElement | null): boolean {
    const rect = element.getBoundingClientRect();
    return (rect.width > 0 || rect.height > 0) && rect.bottom <= viewportTopOf(scrollContainer);
}

/**
 * 译文在可见段落后展开时，下面的内容自然下移；这不是需要滚动抵消的偏移。
 * 只有变化完全发生在当前滚动面的视口上方时，才主动维持阅读位置。
 * 页首必须保持在页首；整页恢复则用视口上沿的内容锚点保护阅读位置。
 */
function shouldCompensateViewportChange(
    scrollContainer: HTMLElement | null,
    changedNodes: readonly Node[],
): boolean {
    if ((scrollContainer?.scrollTop ?? window.scrollY) === 0) return false;
    if (changedNodes.length === 0) return true;
    return changedNodes.some((node) => {
        const element = changedElement(node);
        return Boolean(element && findScrollableAncestor(element) === scrollContainer &&
            isAboveViewportTop(element, scrollContainer));
    });
}

/**
 * 命中测试需要最新布局与绘制属性，在逐段写入译文时代价最高。局部变化只有落在
 * 自身已离开顶部的滚动面视口上方时才可能补偿；这是任一锚点返回补偿的必要条件，
 * 全部不满足时结果必然为空，因此跳过命中测试。读取异常时回到完整路径处理。
 */
function mayCompensateLocalViewportChange(changedNodes: readonly Node[]): boolean {
    try {
        return changedNodes.some((node) => {
            const element = changedElement(node);
            if (!element) return false;
            const scrollContainer = findScrollableAncestor(element);
            return (scrollContainer?.scrollTop ?? window.scrollY) !== 0 &&
                isAboveViewportTop(element, scrollContainer);
        });
    } catch {
        return true;
    }
}

function captureViewportAnchor(excludedNodes: readonly Node[] = []): FullPageViewportAnchor | null {
    if (typeof document === 'undefined' || typeof window === 'undefined' ||
        typeof document.elementFromPoint !== 'function') return null;
    if (excludedNodes.length > 0 && !mayCompensateLocalViewportChange(excludedNodes)) return null;

    // 整页恢复同时移除屏幕上下方的译文，保住中部会把下方收缩也算作滚动量。
    const anchorRatios = excludedNodes.length === 0 ? [0.01, 0.02, 0.04] : [0.5, 0.33, 0.66];
    for (const ratio of anchorRatios) {
        const x = Math.max(0, Math.floor((window.innerWidth || 0) / 2));
        const y = Math.max(0, Math.min((window.innerHeight || 1) - 1,
            Math.floor((window.innerHeight || 1) * ratio)));
        let element = asHTMLElement(document.elementFromPoint(x, y));
        while (element && isExcluded(element, excludedNodes)) element = element.parentElement;
        if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
        try {
            const rect = element.getBoundingClientRect();
            if (!(rect.width || rect.height)) continue;
            const scrollContainer = findScrollableAncestor(element);
            if (!shouldCompensateViewportChange(scrollContainer, excludedNodes)) continue;
            return {element, top: rect.top, scrollContainer};
        } catch {
            // The page may detach the candidate between hit testing and layout.
        }
    }
    return null;
}

function restoreViewportAnchor(anchor: FullPageViewportAnchor | null): void {
    if (!anchor?.element.isConnected) return;
    try {
        const offset = anchor.element.getBoundingClientRect().top - anchor.top;
        if (Math.abs(offset) <= 0.5) return;
        if (anchor.scrollContainer?.isConnected) anchor.scrollContainer.scrollTop += offset;
        else if (typeof window.scrollBy === 'function') window.scrollBy(0, offset);
    } catch {
        // Scroll anchoring is a best-effort visual safeguard and must not break translation.
    }
}

let anchorDepth = 0;

/**
 * 锚点捕获要做命中测试、边界矩形和滚动祖先查找，成本等同一次强制重排。
 * 嵌套调用复用最外层锚点：内层写入仍被同一次补偿覆盖，而每个 DOM 写入
 * 不再各自付一遍测量开销。
 */
export function withFullPageViewportAnchor<T>(callback: () => T, excludedNodes: readonly Node[] = []): T {
    if (anchorDepth > 0) return callback();
    const anchor = captureViewportAnchor(excludedNodes);
    anchorDepth += 1;
    try {
        return callback();
    } finally {
        anchorDepth -= 1;
        restoreViewportAnchor(anchor);
    }
}

export interface FullPageScrollController {
    readonly isScrolling: boolean;
    note(): void;
    defer(target: HTMLElement): boolean;
    dispose(): void;
}

export function createFullPageScrollController(options: {
    isActive: () => boolean;
    onIdle: (targets: readonly HTMLElement[]) => void;
    afterIdle: () => void;
}): FullPageScrollController {
    let scrolling = false;
    let idleTimer: number | null = null;
    const deferredTargets = new Set<HTMLElement>();

    const settle = (): void => {
        idleTimer = null;
        if (!options.isActive()) return;
        scrolling = false;
        const targets = [...deferredTargets];
        deferredTargets.clear();
        options.onIdle(targets);
        options.afterIdle();
    };

    return {
        get isScrolling(): boolean { return scrolling; },
        note(): void {
            if (!options.isActive()) return;
            scrolling = true;
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(settle, FULL_PAGE_SCROLL_IDLE_MS);
        },
        defer(target: HTMLElement): boolean {
            if (!scrolling || !target.isConnected) return false;
            deferredTargets.add(target);
            return true;
        },
        dispose(): void {
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            idleTimer = null;
            scrolling = false;
            deferredTargets.clear();
        },
    };
}
