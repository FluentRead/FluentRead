/**
 * @file src/features/writing-assistant/client.ts
 * 文件职责：连接写作面板与后台流式端口，并将断连统一为可重试错误。
 * 主要内容：匹配请求身份、消费进度和结果，取消时释放监听与端口。
 * 模块边界：仅负责浏览器通信；不读取页面、密钥，不构建提示词。
 */
import browser from 'webextension-polyfill';
import type {WritingRequest, WritingResponse, WritingProgress, WritingStreamMessage} from './types';
export function streamWriting(request: WritingRequest, handlers: {
    progress(value: WritingProgress): void; result(value: WritingResponse): void;
}): () => void {
    const port = browser.runtime.connect({name: 'fluentReadWritingStream'});
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        port.onMessage.removeListener(onMessage); port.onDisconnect.removeListener(onDisconnect);
        try { port.disconnect(); } catch { /* 端口可能已经关闭。 */ }
    };
    const onMessage = (raw: unknown) => {
        const message = raw as WritingStreamMessage;
        if (closed || message.requestId !== request.requestId) return;
        if (message.type === 'progress') handlers.progress(message.progress);
        else { close(); handlers.result(message.response); }
    };
    const onDisconnect = () => {
        if (closed) return;
        close(); handlers.result({success: false, error: '写作助手连接中断，请重试'});
    };
    port.onMessage.addListener(onMessage); port.onDisconnect.addListener(onDisconnect);
    try { port.postMessage(request); } catch { onDisconnect(); }
    return close;
}
