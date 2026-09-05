/**
 * @file src/app/content/pageLifecycle.ts
 * 文件职责：绑定文档真正离开与往返缓存生命周期，避免取消导航后永久卸载扩展。
 * 主要内容：pagehide 持久化时暂停功能、pageshow 恢复，实际销毁时清理；所有监听受运行时信号约束。
 * 模块边界：仅管理页面生命周期事件，不访问配置或 DOM，具体暂停、恢复和销毁由组合根注入。
 */
export function installContentPageLifecycle(
    target: EventTarget,
    signal: AbortSignal,
    actions: {suspend(): void; resume(): void; dispose(): void},
): void {
    let suspended = false;
    let disposed = false;
    target.addEventListener('pagehide', event => {
        if (disposed) return;
        if ((event as PageTransitionEvent).persisted) {
            if (suspended) return;
            suspended = true;
            actions.suspend();
        } else {
            disposed = true;
            actions.dispose();
        }
    }, {signal});
    target.addEventListener('pageshow', event => {
        if (disposed || !suspended || !(event as PageTransitionEvent).persisted) return;
        suspended = false;
        actions.resume();
    }, {signal});
}
