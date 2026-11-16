/**
 * @file src/app/document-translation/hypothesisRuntime.ts
 * 文件职责：把扩展弹窗的协作批注命令准确路由到指定 PDF 阅读标签页。
 * 主要内容：绑定浏览器返回的当前标签页，拒绝其他来源和标签页，卸载时撤销监听并忽略迟到的初始化。
 * 模块边界：不接触 PDF、账户或服务网络，开关由文档应用公开端口处理；后台对该扩展页面专用消息不应答。
 */
interface HypothesisDocumentPorts {
    currentTab(): Promise<{id?: number} | undefined>;
    runtimeId: string;
    popupUrl: string;
    add(listener: (message: unknown, sender: {id?: string; url?: string}) => unknown): void;
    remove(listener: (message: unknown, sender: {id?: string; url?: string}) => unknown): void;
    toggle(): Promise<unknown>;
}
export function installDocumentHypothesisRuntime(ports: HypothesisDocumentPorts): () => void {
    let disposed = false, listener: ((message: unknown, sender: {id?: string; url?: string}) => unknown) | undefined;
    void ports.currentTab().then(tab => {
        if (disposed || !Number.isInteger(tab?.id) || tab!.id! < 0) return;
        listener = (message, sender) => {
            const request = message as {type?: unknown; tabId?: unknown} | null;
            if (disposed || request?.type !== 'toggleDocumentHypothesis' || request.tabId !== tab!.id || sender.id !== ports.runtimeId
                || sender.url?.split(/[?#]/u)[0] !== ports.popupUrl) return undefined;
            return ports.toggle();
        };
        ports.add(listener);
    }).catch(() => { /* 标签页在初始化期间关闭时无需留下监听器。 */ });
    return () => {disposed = true; if (listener) {ports.remove(listener); listener = undefined;}};
}
