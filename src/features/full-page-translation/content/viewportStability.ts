/**
 * @file src/features/full-page-translation/content/viewportStability.ts
 * 文件职责：隔离全文翻译对页面滚动稳定性的辅助逻辑，避免动态页面在插入译文时发生视觉跳动或重复重排。
 * 主要内容：局部变化只补偿同一滚动面上方的内容并在面内命中，全量恢复按已知 owner 保护各滚动面上沿；同步只读捕获共享祖先与几何，写入后复验滚动面并重新测量，按实际滚动响应有界校正缩放单位与取整，另提供滚动空闲门控。
 * 模块边界：本文件只管理可逆的浏览器视口状态与延迟回调，具体重启目标仍由全文 runtime 决定。
 */
import {getComposedParent, maxComposedAncestorDepth} from '@/src/core/translation/public';
import {asHTMLElement, isElementNode} from './mutationObservation';

const TRANSLATION_ARTIFACT_SELECTOR = [
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
    '.fluent-read-bilingual-content',
].join(',');

const FULL_PAGE_SCROLL_IDLE_MS = 220;

interface FullPageViewportAnchor {
    element: HTMLElement;
    top: number;
    scrollContainer: HTMLElement | null;
    relativeToScrollContainer?: boolean;
}

function isExcluded(element: HTMLElement, excludedNodes: readonly Node[]): boolean {
    return excludedNodes.some((excluded) => excluded === element ||
        (isElementNode(excluded) && (excluded.contains(element) || element.contains(excluded))));
}

interface ViewportCaptureMeasurements {
    scrollContainers: Map<HTMLElement, HTMLElement | null | undefined>;
    rects: Map<HTMLElement, DOMRect>;
}

function captureRect(element: HTMLElement, measurements: ViewportCaptureMeasurements): DOMRect {
    if (measurements.rects.has(element)) return measurements.rects.get(element)!;
    const rect = element.getBoundingClientRect();
    measurements.rects.set(element, rect);
    return rect;
}

function findScrollableAncestor(element: HTMLElement, measurements: ViewportCaptureMeasurements): HTMLElement | null | undefined {
    let current = asHTMLElement(getComposedParent(element));
    const path: HTMLElement[] = [];
    let container: HTMLElement | null | undefined = null;
    while (current && current !== document.body) {
        if (measurements.scrollContainers.has(current)) {
            container = measurements.scrollContainers.get(current);
            break;
        }
        if (path.length >= maxComposedAncestorDepth) {
            container = undefined;
            break;
        }
        path.push(current);
        try {
            // scrollHeight/clientHeight 会在每次译文写入后强制整页布局。先排除普通的
            // overflow:visible 祖先，只对实际允许滚动的容器测量几何；两项条件仍需同时成立。
            const style = current.ownerDocument.defaultView?.getComputedStyle(current);
            if (style && /(auto|scroll|overlay)/u.test(style.overflowY) &&
                current.scrollHeight > current.clientHeight) {
                container = current;
                break;
            }
        } catch {
            // Host custom elements can throw while their layout is being rebuilt.
        }
        current = asHTMLElement(getComposedParent(current));
    }
    for (const ancestor of path) measurements.scrollContainers.set(ancestor, container);
    return container;
}

function viewportTopOf(scrollContainer: HTMLElement | null, measurements: ViewportCaptureMeasurements): number {
    return scrollContainer
        ? captureRect(scrollContainer, measurements).top + scrollContainer.clientTop
        : 0;
}

function changedElement(node: Node): HTMLElement | null {
    const element = asHTMLElement(node) ?? asHTMLElement(node.parentElement);
    return element?.isConnected ? element : null;
}

/** 变化元素完全位于给定滚动面视口上沿之上时才会推动该滚动面中的阅读位置。 */
function isAboveViewportTop(element: HTMLElement, scrollContainer: HTMLElement | null,
    measurements: ViewportCaptureMeasurements): boolean {
    const rect = captureRect(element, measurements);
    return (rect.width > 0 || rect.height > 0) && rect.bottom <= viewportTopOf(scrollContainer, measurements);
}

/** 只为视口上方变化涉及的滚动面命中；窄容器不必覆盖文档中点。 */
function captureLocalViewportAnchors(changedNodes: readonly Node[]): Array<FullPageViewportAnchor | null> {
    if (typeof document === 'undefined' || typeof window === 'undefined' ||
        typeof document.elementFromPoint !== 'function') return [];
    const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
    const surfaces = new Set<HTMLElement | null>();
    for (const node of changedNodes) {
        try {
            const element = changedElement(node);
            if (!element) continue;
            const surface = findScrollableAncestor(element, measurements);
            if (surface === undefined || (surface?.scrollTop ?? window.scrollY) === 0 || surfaces.has(surface)) continue;
            if (isAboveViewportTop(element, surface, measurements)) surfaces.add(surface);
        } catch { /* 几何不可读的变化不能推测其滚动面，继续处理其它已知变化。 */ }
    }
    return [...surfaces].map(surface => captureSurfaceAnchor(surface, measurements, [0.5, 0.33, 0.66], changedNodes));
}

function captureViewportAnchor(): FullPageViewportAnchor | null {
    if (typeof document === 'undefined' || typeof window === 'undefined' ||
        typeof document.elementFromPoint !== 'function') return null;
    const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
    for (const ratio of [0.01, 0.02, 0.04]) {
        const x = Math.max(0, Math.floor((window.innerWidth || 0) / 2));
        const y = Math.max(0, Math.min((window.innerHeight || 1) - 1,
            Math.floor((window.innerHeight || 1) * ratio)));
        try {
            const element = asHTMLElement(document.elementFromPoint(x, y));
            if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
            const rect = captureRect(element, measurements);
            if (!(rect.width || rect.height)) continue;
            const scrollContainer = findScrollableAncestor(element, measurements);
            if (scrollContainer === undefined) continue;
            if ((scrollContainer?.scrollTop ?? window.scrollY) === 0) continue;
            return {element, top: rect.top, scrollContainer};
        } catch {
            // The page may detach the candidate between hit testing and layout.
        }
    }
    return null;
}

/** 读取浏览器实际采用的滚动量；仅对亚像素取整试一次修正，更差时回到首个结果。 */
function applyScrollCompensation(scrollContainer: HTMLElement | null, offset: number): number {
    const read = () => scrollContainer ? scrollContainer.scrollTop : window.scrollY;
    const apply = (delta: number) => {
        if (scrollContainer) scrollContainer.scrollTop += delta;
        else window.scrollBy(0, delta);
    };
    const initial = read();
    apply(offset);
    if (!Number.isFinite(initial)) return NaN;
    const desired = initial + offset;
    const first = read();
    const error = desired - first;
    // 大差值可能来自边界夹紧、滚动吸附或异步平滑滚动，不能追加推测性的滚动。
    if (Math.abs(error) > 0.01 && Math.abs(error) < 1) {
        apply(desired + error - read());
        if (Math.abs(read() - desired) > Math.abs(error)) apply(first - read());
    }
    return read() - initial;
}

function anchorTop(anchor: FullPageViewportAnchor, measurements: ViewportCaptureMeasurements): number {
    const surfaceTop = anchor.relativeToScrollContainer ? viewportTopOf(anchor.scrollContainer, measurements) : 0;
    return captureRect(anchor.element, measurements).top - surfaceTop;
}

function restoreViewportAnchor(anchor: FullPageViewportAnchor | null): void {
    if (!anchor?.element.isConnected) return;
    try {
        const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
        // 页面同步重挂锚点后，其新位置不再是原滚动面的位移证据；无论使用
        // 视口绝对坐标还是容器相对坐标，都不能向旧容器或文档追加滚动。
        if (findScrollableAncestor(anchor.element, measurements) !== anchor.scrollContainer) return;
        const offset = anchorTop(anchor, measurements) - anchor.top;
        if (Math.abs(offset) <= 0.5) return;
        const surface = anchor.scrollContainer;
        if (!surface && typeof window.scrollBy !== 'function') return;
        const applied = applyScrollCompensation(surface, offset);
        if (!Number.isFinite(applied) || applied === 0 || !anchor.element.isConnected) return;
        // rect 使用视口坐标，scrollTop 使用布局坐标。缩放下从本次真实滚动响应
        // 求换算，最多再补一次；夹紧/平滑滚动尚未移动或没有响应时直接结束。
        const remaining = anchorTop(anchor, {scrollContainers: new Map(), rects: new Map()}) - anchor.top;
        const response = (offset - remaining) / applied;
        if (Math.abs(remaining) > 0.5 && Number.isFinite(response) && response !== 0 && response !== 1) {
            applyScrollCompensation(surface, remaining / response);
        }
    } catch {
        // Scroll anchoring is a best-effort visual safeguard and must not break translation.
    }
}

/** 命中滚动面的可见区域；整体恢复使用上沿，局部上方变化使用面内中部。 */
function captureSurfaceAnchor(scrollContainer: HTMLElement | null, measurements: ViewportCaptureMeasurements,
    ratios: readonly number[], excludedNodes: readonly Node[] = []): FullPageViewportAnchor | null {
    if ((scrollContainer?.scrollTop ?? window.scrollY) === 0) return null;
    try {
        const rect = scrollContainer ? captureRect(scrollContainer, measurements) : null;
        const left = Math.max(0, rect?.left ?? 0);
        const right = Math.min(window.innerWidth, rect?.right ?? window.innerWidth);
        const top = Math.max(0, viewportTopOf(scrollContainer, measurements));
        const bottom = Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight);
        if (right <= left || bottom <= top) return null;
        for (const ratio of ratios) {
            const x = Math.floor((left + right) / 2), y = Math.floor(top + (bottom - top) * ratio);
            let element = asHTMLElement(document.elementFromPoint(x, y));
            while (element?.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
                const inner = asHTMLElement(element.shadowRoot.elementFromPoint(x, y));
                if (!inner || inner === element) break;
                element = inner;
            }
            while (element && (element.matches(TRANSLATION_ARTIFACT_SELECTOR) || isExcluded(element, excludedNodes))) {
                element = asHTMLElement(getComposedParent(element));
            }
            if (!element || findScrollableAncestor(element, measurements) !== scrollContainer) continue;
            const anchorRect = captureRect(element, measurements);
            if (!(anchorRect.width || anchorRect.height)) continue;
            return {element, top: anchorRect.top - viewportTopOf(scrollContainer, measurements),
                scrollContainer, relativeToScrollContainer: true};
        }
    } catch { /* 局部布局或命中测试不可读时，不能阻断其它滚动面与恢复。 */ }
    return null;
}

let anchorDepth = 0;

/**
 * 锚点捕获要做命中测试、边界矩形和滚动祖先查找，成本等同一次强制重排。
 * 嵌套调用复用最外层锚点：内层写入仍被同一次补偿覆盖，而每个 DOM 写入
 * 不再各自付一遍测量开销。
 */
export function withFullPageViewportAnchor<T>(callback: () => T, excludedNodes: readonly Node[] = []): T {
    if (anchorDepth > 0) return callback();
    const anchors = excludedNodes.length > 0 ? captureLocalViewportAnchors(excludedNodes) : [captureViewportAnchor()];
    anchorDepth += 1;
    try {
        return callback();
    } finally {
        anchorDepth -= 1;
        anchors.forEach(restoreViewportAnchor);
    }
}

/** 使用待恢复 owner 的祖先发现滚动面，不扫描整页；补偿采用面内相对位置。 */
export function withFullPageRestorationAnchors<T>(callback: () => T, changedNodes: readonly Node[]): T {
    if (anchorDepth > 0 || changedNodes.length === 0 || typeof document === 'undefined' ||
        typeof window === 'undefined' || typeof document.elementFromPoint !== 'function') return callback();
    const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
    const surfaces = new Set<HTMLElement | null>([null]);
    for (const node of changedNodes) {
        const element = changedElement(node);
        if (!element) continue;
        for (let container = findScrollableAncestor(element, measurements); container;
            container = findScrollableAncestor(container, measurements)) surfaces.add(container);
    }
    const anchors = [...surfaces].map(surface => captureSurfaceAnchor(surface, measurements, [0.01, 0.02, 0.04]));
    anchorDepth += 1;
    try { return callback(); }
    finally {
        anchorDepth -= 1;
        anchors.forEach(restoreViewportAnchor);
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
