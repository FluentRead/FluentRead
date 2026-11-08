/**
 * @file src/app/popup/embedded.ts
 * 文件职责：在默认 Popup 被网页嵌入时，先兑换后台一次性授权，再建立只传递尺寸和关闭事件的独立通道。
 * 主要内容：验证父窗口连接、固定已授权来源标签页、取消退出后的异步挂载；菜单先按父端实际宽度完成布局，再以有效尺寸通知显示并观察后续变化。
 * 模块边界：授权前不导入配置、Vue 或 Popup 业务；凭据不进入 URL 或 DOM，父网页不会收到用户配置或扩展动作接口。
 */
type PopupRuntime = {
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
    lastError?: {message?: string};
};

let sourceTabId: number | null = null;
let preparation: Promise<boolean> | undefined;
let disposeEmbedded: ((notifyParent: boolean) => void) | undefined;
let embeddedPort: MessagePort | undefined;
let disposed = false;
let stopSizeObservation: (() => void) | undefined;
let confirmPopupPlacement: ((placement: {width?: unknown; requestedWidth?: unknown; shown?: unknown}) => void) | undefined;

export function isEmbeddedPopup(): boolean {
    return typeof window !== 'undefined' && window.parent !== undefined && window.parent !== window;
}

/** 只返回后台兑换的身份；URL 查询参数不能建立页内面板的网页授权。 */
export function getEmbeddedPopupTabId(): number | null {
    return sourceTabId;
}

export function isPopupSurfaceActive(): boolean {
    return !disposed;
}

function authorize(token: string): Promise<unknown> {
    const globals = globalThis as typeof globalThis & {
        browser?: {runtime?: PopupRuntime}; chrome?: {runtime?: PopupRuntime};
    };
    const message = {type: 'authorizeFloatingPopup', token};
    if (globals.browser?.runtime) return Promise.resolve(globals.browser.runtime.sendMessage(message));
    return new Promise((resolve, reject) => {
        const runtime = globals.chrome?.runtime;
        if (!runtime) { reject(new Error('扩展消息端口不可用')); return; }
        runtime.sendMessage(message, response => {
            if (runtime.lastError) reject(new Error(runtime.lastError.message));
            else resolve(response);
        });
    });
}

/** 任意 iframe 都必须等待父端持有的凭据，不接受仅靠地址参数进入 privileged Popup。 */
export function preparePopupSurface(): Promise<boolean> {
    if (!isEmbeddedPopup()) return Promise.resolve(true);
    if (preparation) return preparation;
    preparation = new Promise(resolve => {
        let pendingPort: MessagePort | undefined;
        const finish = (notifyParent: boolean) => {
            if (disposed) return;
            disposed = true;
            sourceTabId = null;
            clearTimeout(timeout);
            window.removeEventListener('message', connect);
            window.removeEventListener('pagehide', pagehide);
            window.removeEventListener('keydown', keydown);
            stopSizeObservation?.();
            if (notifyParent) embeddedPort?.postMessage({type: 'close'});
            embeddedPort?.close();
            pendingPort?.close();
            embeddedPort = undefined;
            // 关闭的是实际扩展页面；先让已有的配置和挂载生命周期收到退出信号。
            window.dispatchEvent(new Event('pagehide'));
            resolve(false);
        };
        const pagehide = () => finish(false);
        const keydown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            closePopupSurface();
        };
        const connect = async (event: MessageEvent) => {
            const data = event.data as {type?: unknown; token?: unknown} | null;
            if (disposed || pendingPort || event.source !== window.parent
                || data?.type !== 'fluentread-floating-popup-connect'
                || typeof data.token !== 'string' || !data.token || data.token.length > 256
                || event.ports.length !== 1) return;
            const port = event.ports[0];
            pendingPort = port;
            try {
                const response = await authorize(data.token) as {success?: boolean; sourceTabId?: unknown} | null;
                if (disposed) return;
                if (response?.success !== true || typeof response.sourceTabId !== 'number'
                    || !Number.isSafeInteger(response.sourceTabId) || response.sourceTabId < 0) return;
                sourceTabId = response.sourceTabId;
                embeddedPort = port;
                pendingPort = undefined;
                document.documentElement.dataset.fluentreadEmbeddedPopup = 'true';
                clearTimeout(timeout);
                window.removeEventListener('message', connect);
                // 让 Popup 内部先处理返回，未消费的 Escape 再关闭整个面板。
                window.addEventListener('keydown', keydown);
                port.onmessage = message => {
                    if (message.data?.type === 'close') finish(false);
                    else if (message.data?.type === 'placed') confirmPopupPlacement?.(message.data);
                };
                port.start();
                resolve(true);
            } catch {
                // 验证失败保持未挂载，可由真正的父端在剩余授权时间内重试。
            } finally {
                if (embeddedPort !== port) port.close();
                pendingPort = undefined;
            }
        };
        const timeout = setTimeout(() => finish(false), 15_000);
        disposeEmbedded = finish;
        window.addEventListener('message', connect);
        window.addEventListener('pagehide', pagehide);
    });
    return preparation;
}

/** 页面动作与 Escape 共用此出口，普通工具栏继续使用浏览器自带的 window.close。 */
export function closePopupSurface(): void {
    if (isEmbeddedPopup()) disposeEmbedded?.(true);
    else window.close();
}

/** 首次先请求父端设置宽度，在实际视口宽度确认后才发送 ready；探针解析 CSS 期望宽度，后续继续观察自然尺寸。 */
export function observeEmbeddedPopupSize(): void {
    if (!embeddedPort || disposed || stopSizeObservation) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:0;contain:strict;width:var(--fluentread-localized-popup-width,var(--interface-popup-width,320px));';
    document.body.append(probe);
    let lastWidth = 0, lastHeight = 0;
    let requestedWidth = 0, placedWidth = 0;
    let ready = false;
    let placementShown = false;
    let placementRetry: ReturnType<typeof setTimeout> | undefined;
    const stopPlacementRetry = () => {clearTimeout(placementRetry); placementRetry = undefined;};
    const measure = () => {
        if (!embeddedPort || disposed) return;
        const content = document.querySelector<HTMLElement>('.popup-shell[data-config-ready="true"]');
        if (!content) return;
        const width = Math.ceil(parseFloat(getComputedStyle(probe).width));
        const height = Math.ceil(Math.min(560, Math.max(content.offsetHeight, content.scrollHeight, content.getBoundingClientRect().height)));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        if (!ready) {
            if (width !== requestedWidth) {
                requestedWidth = width; placedWidth = 0;
                placementShown = false;
                lastWidth = 0; lastHeight = 0; stopPlacementRetry();
                embeddedPort.postMessage({type: 'resize', width, height});
                return;
            }
            // 本地化宽度或父网页窄屏裁剪会改变换行；不能用旧视口的高度显示首帧。
            if (placedWidth === 0) return;
            if (window.innerWidth !== placedWidth) {
                // 隐藏 iframe 的视口变化未必触发 resize；只在等待这次布局时短暂重试。
                placementRetry ??= setTimeout(() => {placementRetry = undefined; measure();}, 16);
                return;
            }
            // 父端可能已显示首个 ready，随后又调整视口或语言宽度；跟随最新显示确认恢复普通观察。
            if (placementShown) ready = true;
        }
        stopPlacementRetry();
        if (width === lastWidth && height === lastHeight) return;
        const type = ready ? 'resize' : 'ready';
        lastWidth = width; lastHeight = height;
        embeddedPort.postMessage(ready ? {type, width, height} : {type, width, height, actualWidth: window.innerWidth});
    };
    confirmPopupPlacement = placement => {
        const {width, shown} = placement;
        if (ready || placement.requestedWidth !== requestedWidth || typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return;
        if (typeof shown !== 'boolean') return;
        placedWidth = width; placementShown = shown;
        if (!shown) {lastWidth = 0; lastHeight = 0;}
        measure();
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(document.documentElement);
    observer?.observe(document.body);
    observer?.observe(probe);
    const content = document.querySelector('.popup-shell[data-config-ready="true"]');
    if (content) observer?.observe(content);
    window.addEventListener('resize', measure);
    stopSizeObservation = () => {
        confirmPopupPlacement = undefined;
        stopPlacementRetry();
        observer?.disconnect();
        window.removeEventListener('resize', measure);
        probe.remove();
    };
    measure();
}
