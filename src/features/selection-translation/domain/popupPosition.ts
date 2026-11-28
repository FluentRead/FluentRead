/**
 * @file src/features/selection-translation/domain/popupPosition.ts
 *
 * 文件职责：计算划词翻译卡片的锚点矩形与视口内避让定位，支持多行选区完整避让、方向锁定滞回与上侧粘性顶边约束。
 * 主要内容：导出 SelectionRect、PopupSize、ViewportSize、PopupPosition、chooseSelectionRect、getSelectionPopupAnchor 与 calculateSelectionPopupPosition。
 * 模块边界：完全独立的纯几何定位算法，不依赖 DOM 或 Vue 组件实例。
 */

export interface SelectionRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
}

export interface PopupSize {
    width: number;
    height: number;
}

export interface ViewportSize {
    width: number;
    height: number;
    left?: number;
    top?: number;
}

export interface PopupPosition {
    left: number;
    top: number;
    placement: 'top' | 'bottom';
    /** 两侧都无法容纳原高度时，返回所选一侧的可用高度，避免弹窗夹边后覆盖选区。 */
    maxHeight?: number;
}

export interface SelectionPopupPositionOptions {
    /** 锁定本次卡片已选定的展示侧；除非该侧已明显拥挤且对侧更宽裕，否则不跨选区翻边跳动。 */
    preferredPlacement?: 'top' | 'bottom' | null;
    /** 上方展示时保留已稳定的顶边，内容缩短或切标签时不向下回弹，仅在将遮挡选区时上移。 */
    stickyTop?: number | null;
    /** 首次选择上下侧时的舒适高度预算，避免加载态很矮放得下、译文返回后立刻被迫翻边。 */
    comfortHeight?: number;
}

const DEFAULT_PADDING = 12;
const DEFAULT_GAP = 10;
const MIN_COMFORT_HEIGHT = 240;
const MIN_LOCKED_SIDE_HEIGHT = 96;
const FLIP_HYSTERESIS = 48;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 选择最靠近选区焦点的视觉边缘；使用客户端矩形可以避免把入口放在多行选区中间。
 */
export function chooseSelectionRect(rects: SelectionRect[], isForward = true): SelectionRect | null {
    if (rects.length === 0) return null;
    return isForward ? rects[rects.length - 1] : rects[0];
}

/** 卡片避让完整选区的纵向范围，横向仍对齐选择方向的端点行。 */
export function getSelectionPopupAnchor(rects: SelectionRect[], isForward = true): SelectionRect | null {
    const anchor = chooseSelectionRect(rects, isForward);
    if (!anchor) return null;
    let {top, bottom} = anchor;
    for (const rect of rects) {top = Math.min(top, rect.top); bottom = Math.max(bottom, rect.bottom);}
    return {...anchor, top, bottom, height: bottom - top};
}

/**
 * 以当前选中行作为弹层锚点并限制在视口内。计算保持为纯函数，使滚动和缩放行为
 * 无需挂载 Vue、也不依赖宿主页面 CSS 即可测试。
 * 默认优先放在选区下方（顺应阅读视线且内容增长时顶栏不位移），下方空间不足时智能翻至上方；
 * 一旦选定方向并传入 preferredPlacement / stickyTop，内容加载、流式输出或切标签不会上下乱跳。
 */
export function calculateSelectionPopupPosition(
    anchor: SelectionRect,
    popup: PopupSize,
    viewport: ViewportSize,
    padding = DEFAULT_PADDING,
    gap = DEFAULT_GAP,
    options?: SelectionPopupPositionOptions,
): PopupPosition {
    const viewportLeft = viewport.left ?? 0;
    const viewportTop = viewport.top ?? 0;
    const minLeft = viewportLeft + padding;
    const minTop = viewportTop + padding;
    const maxLeft = Math.max(minLeft, viewportLeft + viewport.width - popup.width - padding);
    const left = clamp(anchor.left, minLeft, maxLeft);
    const viewportBottom = viewportTop + viewport.height - padding;
    const aboveBottom = Math.min(anchor.top - gap, viewportBottom);
    const belowTop = Math.max(anchor.bottom + gap, minTop);
    const availableAbove = Math.max(0, aboveBottom - minTop);
    const availableBelow = Math.max(0, viewportBottom - belowTop);
    const defaultComfort = Math.min(MIN_COMFORT_HEIGHT, Math.max(120, Math.floor((viewport.height - padding * 2) * 0.45)));
    const comfortHeight = options?.comfortHeight ?? defaultComfort;
    const desiredHeight = Math.max(popup.height, comfortHeight);

    let placement: 'top' | 'bottom';
    const preferred = options?.preferredPlacement ?? null;
    if (preferred === 'bottom') {
        const belowTooTight = availableBelow < Math.min(popup.height, MIN_LOCKED_SIDE_HEIGHT)
            && availableAbove > availableBelow + FLIP_HYSTERESIS;
        placement = belowTooTight ? 'top' : 'bottom';
    } else if (preferred === 'top') {
        const aboveTooTight = availableAbove < Math.min(popup.height, MIN_LOCKED_SIDE_HEIGHT)
            && availableBelow > availableAbove + FLIP_HYSTERESIS;
        placement = aboveTooTight ? 'bottom' : 'top';
    } else if (availableBelow >= desiredHeight) {
        placement = 'bottom';
    } else if (availableAbove >= desiredHeight) {
        placement = 'top';
    } else if (popup.height <= availableBelow && availableBelow >= availableAbove) {
        placement = 'bottom';
    } else if (popup.height <= availableAbove && availableAbove > availableBelow) {
        placement = 'top';
    } else {
        placement = availableBelow >= availableAbove ? 'bottom' : 'top';
    }

    const sideAvailable = Math.max(1, placement === 'top' ? availableAbove : availableBelow);
    const height = Math.min(popup.height, sideAvailable);
    const maxTop = Math.max(minTop, viewportBottom - height);
    let top: number;
    if (placement === 'top') {
        const idealTop = clamp(aboveBottom - height, minTop, maxTop);
        const stickyTop = options?.stickyTop;
        if (typeof stickyTop === 'number' && Number.isFinite(stickyTop)) {
            const clampedSticky = clamp(stickyTop, minTop, maxTop);
            // 上方展示时保留已稳定的顶边，避免切换标签/短译文时向下回弹；仅在将遮挡选区时上移。
            top = clampedSticky + height <= aboveBottom ? Math.min(clampedSticky, idealTop) : idealTop;
        } else {
            top = idealTop;
        }
    } else {
        top = clamp(belowTop, minTop, maxTop);
    }

    return {
        left,
        top,
        placement,
        ...(height < popup.height ? {maxHeight: height} : {}),
    };
}
