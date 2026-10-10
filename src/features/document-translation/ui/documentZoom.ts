/**
 * @file src/features/document-translation/ui/documentZoom.ts
 * 文件职责：为 PDF 与富文本阅读视口安装统一的文档缩放手势，让触控板捏合与键盘缩放只改变当前文档的阅读比例。
 * 主要内容：识别 Ctrl/Cmd 修饰的 wheel，按像素、行和页归一增量并逐次累计有界缩放，每个动画帧只提交一次比例与最近的指针锚点；处理视口内 Ctrl/Cmd 加减和复位，避开编辑控件与划词卡，卸载时取消待提交帧并移除监听。
 * 模块边界：只管理目标视口的标准浏览器事件，不修改布局、不发起翻译、不接管普通滚动或宿主页面快捷键；具体比例与锚点定位由调用方维护，跨 iframe 的元素判断不依赖全局构造器。
 */

export interface DocumentZoomPoint {
    clientX: number;
    clientY: number;
}

export interface DocumentZoomOptions {
    getScale: () => number;
    setScale: (scale: number, point?: DocumentZoomPoint) => void;
    minScale?: number;
    maxScale?: number;
    reset: () => void;
}

const WHEEL_ZOOM_SPEED = 0.002;
const KEYBOARD_ZOOM_FACTOR = 1.1;
const EDITABLE_OR_CARD = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-fluent-read-ui]';

/** 标准 wheel 事件支持桌面触控板捏合；返回的释放函数可重复调用。 */
export function installDocumentZoomGestures(target: HTMLElement, options: DocumentZoomOptions): () => void {
    const ownerView = target.ownerDocument.defaultView;
    const view = ownerView && typeof ownerView.requestAnimationFrame === 'function' && typeof ownerView.cancelAnimationFrame === 'function' ? ownerView : window;
    const minimum = Number.isFinite(options.minScale) && options.minScale! > 0 ? options.minScale! : 0.25;
    const maximum = Number.isFinite(options.maxScale) && options.maxScale! >= minimum ? options.maxScale! : Math.max(3, minimum);
    const clamp = (scale: number) => Math.min(maximum, Math.max(minimum, scale));
    const currentScale = () => {
        const scale = options.getScale();
        return clamp(Number.isFinite(scale) && scale > 0 ? scale : 1);
    };
    let frame: number | undefined;
    let pendingScale: number | undefined;
    let pendingPoint: DocumentZoomPoint | undefined;
    let disposed = false;

    // Shadow DOM 的事件会重定向 target，composedPath 保留真实编辑控件和划词卡宿主；截断在视口处，避免外层应用标记屏蔽整个阅读器。
    const excluded = (event: Event, selector: string) => {
        for (const node of event.composedPath()) {
            const element = node as Element | null;
            if (element?.nodeType === 1 && element.matches(selector)) return true;
            if (node === target) break;
        }
        return false;
    };
    const clearPending = () => {
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        frame = undefined;
        pendingScale = undefined;
        pendingPoint = undefined;
    };
    const commitWheel = () => {
        frame = undefined;
        const scale = pendingScale;
        const point = pendingPoint;
        pendingScale = undefined;
        pendingPoint = undefined;
        if (!disposed && scale !== undefined) options.setScale(scale, point);
    };
    const onWheel = (event: WheelEvent) => {
        if (disposed || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || excluded(event, EDITABLE_OR_CARD)) return;
        // 先读取单位，部分浏览器根据 deltaMode 是否被读取来选择返回的 delta 单位。
        const mode = event.deltaMode;
        const delta = event.deltaY * (mode === 1 ? 16 : mode === 2 ? Math.max(1, target.clientHeight) : 1);
        if (!Number.isFinite(delta)) return;
        event.preventDefault();
        // 逐事件限制范围，达到边界后反向捏合立即生效；RAF 前的连续手势共享 pendingScale。
        pendingScale = clamp((pendingScale ?? currentScale()) * Math.exp(-delta * WHEEL_ZOOM_SPEED));
        pendingPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
            ? {clientX: event.clientX, clientY: event.clientY} : undefined;
        if (frame === undefined) frame = view.requestAnimationFrame(commitWheel);
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (disposed || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || excluded(event, EDITABLE_OR_CARD)) return;
        const direction = event.key === '+' || event.key === '=' ? 1 : event.key === '-' || event.key === '_' ? -1 : 0;
        if (!direction && event.key !== '0') return;
        event.preventDefault();
        const base = pendingScale ?? currentScale();
        clearPending();
        if (event.key === '0') options.reset();
        else options.setScale(clamp(base * Math.pow(KEYBOARD_ZOOM_FACTOR, direction)));
    };

    target.addEventListener('wheel', onWheel, {passive: false});
    target.addEventListener('keydown', onKeyDown);
    return () => {
        if (disposed) return;
        disposed = true;
        clearPending();
        target.removeEventListener('wheel', onWheel);
        target.removeEventListener('keydown', onKeyDown);
    };
}
