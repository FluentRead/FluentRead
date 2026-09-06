/**
 * @file src/platform/offscreen/firefoxDocument.ts
 * 文件职责：在 Firefox MV2 后台页面中按需承载扩展自有 DOM 运行时。
 * 主要内容：创建、查询和移除唯一隐藏 iframe；iframe 加载与 Chrome 相同的 offscreen.html，接收端就绪、取消和重建由共享 client 管理。
 * 模块边界：只拥有 Firefox 文档容器，不实现 OCR、翻译、音频、模型或消息协议；不向宿主网页插入节点，也不声明 Chrome offscreen 权限。
 */
import type {OffscreenDocumentApi} from './client';

export function createFirefoxBackgroundDocument(
    getDocument: () => Document | undefined,
    getUrl: (path: string) => string,
): OffscreenDocumentApi & {getContexts(): Promise<unknown[]>} {
    let frame: HTMLIFrameElement | undefined;
    return {
        async getContexts() {
            return frame?.isConnected ? [{url: frame.src}] : [];
        },
        async createDocument({url}) {
            if (frame?.isConnected) return;
            const document = getDocument();
            if (!document?.body) throw new Error('Firefox 后台页面尚未就绪');
            const nextFrame = document.createElement('iframe');
            nextFrame.id = 'fluent-read-background-dom-runtime';
            nextFrame.hidden = true;
            nextFrame.src = getUrl(url);
            document.body.append(nextFrame);
            frame = nextFrame;
        },
        async closeDocument() {
            frame?.remove();
            frame = undefined;
        },
    };
}
