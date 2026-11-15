/**
 * @file src/platform/offscreen/extensionPageMessaging.ts
 * 文件职责：在 Safari 的同源后台页面与子 iframe 之间传递现有扩展消息。
 * 主要内容：注册文档私有接收端，将 callback 或 Promise 回复适配为共享 Offscreen client 使用的 callback/lastError 契约，缺失接收端交给原有握手重试和重建。
 * 模块边界：只通过浏览器同源 Window 属性访问传输消息，不使用网页 postMessage，不解释业务协议；真实扩展 ID 与发送页面 URL 由调用方的 runtime 和 location 提供。
 */
import type {OffscreenRuntimeApi} from './client';

type PageMessageListener = (message: unknown, sender: {id?: string; url: string}, reply: (response: unknown) => void) => boolean | void | Promise<unknown>;
export interface ExtensionPageMessageTarget {
    __fluentReadExtensionPageMessage?: PageMessageListener;
}

export function installExtensionPageMessageListener(target: ExtensionPageMessageTarget, listener: PageMessageListener): () => void {
    target.__fluentReadExtensionPageMessage = listener;
    return () => {
        if (target.__fluentReadExtensionPageMessage === listener) delete target.__fluentReadExtensionPageMessage;
    };
}

export function createExtensionPageRuntime(
    getRuntime: () => {readonly id?: string},
    getTarget: () => ExtensionPageMessageTarget | undefined,
    getSenderUrl: () => string,
): OffscreenRuntimeApi {
    let lastError: {message: string} | undefined;
    return {
        get lastError() { return lastError; },
        sendMessage(message, callback) {
            let replied = false;
            const reply = (response: unknown) => {
                if (replied) return;
                replied = true;
                callback(response);
            };
            const fail = (error: unknown) => {
                const previous = lastError;
                lastError = {message: error instanceof Error ? error.message : String(error)};
                try { reply(undefined); } finally { lastError = previous; }
            };
            try {
                // 跨源 Window 的属性读取由浏览器拒绝；只有同源扩展文档能够取得接收函数。
                const listener = getTarget()?.__fluentReadExtensionPageMessage;
                if (!listener) {
                    fail(new Error('Could not establish connection. Receiving end does not exist.'));
                    return;
                }
                const result = listener(message, {id: getRuntime().id, url: getSenderUrl()}, reply);
                if (result && typeof result !== 'boolean') void result.then(reply, fail);
                else if (result !== true) reply(undefined);
            } catch (error) { fail(error); }
        },
    };
}
