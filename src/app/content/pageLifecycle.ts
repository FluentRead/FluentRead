/**
 * @file src/app/content/pageLifecycle.ts
 * 文件职责：绑定文档真正离开与往返缓存生命周期，并等待可挂载的页面基础 DOM，避免过晚建立翻译入口或过早挂载 UI。
 * 主要内容：仅接受浏览器可信的页面生命周期，在配置等待前记录暂停状态；上下文检查在后台降频、往返缓存内停止，恢复前核查重载失效并释放自己的监听，基础 DOM 等待不依赖整页资源完成。
 * 模块边界：只管理页面生命周期和基础 DOM 就绪，不访问配置、不启动翻译，具体暂停、恢复、销毁和功能挂载由组合根注入。
 */
export function installContentPageLifecycle(
    target: EventTarget,
    signal: AbortSignal,
    actions: {suspend(): void; resume(): void; dispose(): void},
    context?: {readonly isInvalid: boolean; onInvalidated?(callback: () => void): (() => void) | void},
    pageDocument?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
    pollContext = true,
): {isSuspended(): boolean} {
    let suspended = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeContextListener: (() => void) | undefined;
    const stopChecking = (): void => { clearTimeout(timer); timer = undefined; };
    const cleanup = (): void => {
        stopChecking();
        target.removeEventListener('pagehide', pagehide);
        target.removeEventListener('pageshow', pageshow);
        pageDocument?.removeEventListener('visibilitychange', visibilitychange);
        signal.removeEventListener('abort', abort);
        removeContextListener?.(); removeContextListener = undefined;
    };
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        cleanup();
        actions.dispose();
    };
    // WXT 0.20 只有读取 isInvalid 才检查 runtime.id；getter 也可能同步中止 lifetime。
    const checkContext = (): boolean => {
        const invalid = context?.isInvalid === true;
        if (disposed || signal.aborted) return false;
        if (invalid) { dispose(); return false; }
        return true;
    };
    const scheduleCheck = (): void => {
        stopChecking();
        if (!context || !pollContext || suspended || disposed || signal.aborted) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (checkContext()) scheduleCheck();
        }, pageDocument?.visibilityState === 'hidden' ? 5000 : 1000);
    };
    const abort = (): void => { disposed = true; cleanup(); };
    const pagehide = (event: Event): void => {
        if (!event.isTrusted || disposed) return;
        if ((event as PageTransitionEvent).persisted) {
            if (suspended) return;
            suspended = true;
            stopChecking();
            actions.suspend();
        } else dispose();
    };
    const pageshow = (event: Event): void => {
        if (!event.isTrusted || disposed || !suspended || !(event as PageTransitionEvent).persisted) return;
        if (!checkContext()) return;
        suspended = false;
        actions.resume();
        scheduleCheck();
    };
    const visibilitychange = (event: Event): void => {
        if (!event.isTrusted || disposed || suspended) return;
        if (pageDocument?.visibilityState === 'visible' && !checkContext()) return;
        scheduleCheck();
    };
    if (!signal.aborted) {
        target.addEventListener('pagehide', pagehide);
        target.addEventListener('pageshow', pageshow);
        pageDocument?.addEventListener('visibilitychange', visibilitychange);
        signal.addEventListener('abort', abort, {once: true});
        removeContextListener = context?.onInvalidated?.(dispose) ?? undefined;
        scheduleCheck();
    } else disposed = true;
    return {isSuspended: () => suspended};
}

function isConnectedNode(node: Node | null | undefined): boolean {
    return Boolean(node && (node as Node & {isConnected?: boolean}).isConnected !== false);
}

function hasPageMountRoot(pageDocument: Document): boolean {
    return isConnectedNode(pageDocument.documentElement) && isConnectedNode(pageDocument.body);
}

/** 等待页面具备可挂载的基础 DOM，但不把整页资源加载完成当作翻译前提。 */
export function waitForContentDocument(pageDocument: Document, signal: AbortSignal): Promise<boolean> {
    if (hasPageMountRoot(pageDocument)) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
        let settled = false;
        let observer: MutationObserver | null = null;
        const check = (): void => {
            if (hasPageMountRoot(pageDocument)) finish(true);
        };
        const abort = (): void => finish(false);
        const cleanup = (): void => {
            observer?.disconnect();
            pageDocument.removeEventListener('readystatechange', check);
            pageDocument.removeEventListener('DOMContentLoaded', check);
            signal.removeEventListener('abort', abort);
        };
        const finish = (available: boolean): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(available);
        };

        pageDocument.addEventListener('readystatechange', check);
        pageDocument.addEventListener('DOMContentLoaded', check, {once: true});
        if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(check);
            observer.observe(pageDocument, {childList: true, subtree: true});
        }
        signal.addEventListener('abort', abort, {once: true});
        check();
    });
}
