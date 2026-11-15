/**
 * @file src/features/video-subtitle/content/youtubeTimedTextBridge.ts
 * 文件职责：把通用 YouTube timedtext 拦截核心安装到当前页面 MAIN world，并返回可重复调用的清理函数供 feature 生命周期管理。
 * 主要内容：文件从 window 提取 fetch、XMLHttpRequest、CustomEvent、location 等环境端口，调用 installYoutubeTimedTextBridgeLifecycleCore 完成幂等启用、禁用和宿主方法恢复；YouTube 默认开启有界响应回放，交接先于字幕 runtime 挂载到达的时间轴。
 * 模块边界：此适配层不解析字幕、不翻译文本也不持有 UI；猴补算法位于 youtubeTimedTextBridgeCore，消费 postMessage 的逻辑位于 video runtime，宿主 prototype 必须在卸载时恢复。
 */
import {
    createYoutubeTimedTextPayload,
    isYoutubeTimedTextUrl,
    installYoutubeTimedTextBridgeLifecycleCore,
    type YoutubeTimedTextBridgeEnvironment,
    type YoutubeBridgeEventTarget,
    type YoutubeFetchPort,
    type YoutubeXhrOpenPort,
    type YoutubeXhrSendPort,
} from './youtubeTimedTextBridgeCore';

/** 将真实 Fetch/XHR 注入可测试的 YouTube timedtext bridge。 */
export function installYoutubeTimedTextBridge(resourcePolicy: YoutubeTimedTextBridgeEnvironment['resourcePolicy'] = {
    matches: isYoutubeTimedTextUrl,
    payload: createYoutubeTimedTextPayload,
    replayLatest: true,
}): () => void {
    const pageWindow = window as typeof window & Record<string, unknown>;
    return installYoutubeTimedTextBridgeLifecycleCore({
        stateHost: pageWindow,
        resourcePolicy,
        fetch: {
            get: () => window.fetch as unknown as YoutubeFetchPort,
            set: (value) => { window.fetch = value as typeof window.fetch; },
        },
        xhrOpen: {
            get: () => XMLHttpRequest.prototype.open as unknown as YoutubeXhrOpenPort,
            set: (value) => { XMLHttpRequest.prototype.open = value as typeof XMLHttpRequest.prototype.open; },
        },
        xhrSend: {
            get: () => XMLHttpRequest.prototype.send as unknown as YoutubeXhrSendPort,
            set: (value) => { XMLHttpRequest.prototype.send = value as typeof XMLHttpRequest.prototype.send; },
        },
        pageEvents: window as unknown as YoutubeBridgeEventTarget,
        documentEvents: document as unknown as YoutubeBridgeEventTarget,
        getHref: () => location.href,
        getOrigin: () => location.origin,
        postMessage: (payload, targetOrigin) => window.postMessage(payload, targetOrigin),
    });
}
