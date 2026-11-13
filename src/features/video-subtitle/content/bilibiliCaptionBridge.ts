/**
 * @file src/features/video-subtitle/content/bilibiliCaptionBridge.ts
 * 文件职责：在隔离世界与 B 站播放器之间只读传递当前分 P 的媒体身份。
 * 主要内容：请求和应答校验来源、请求编号及分 P；播放器尚未切换时有界等待，取消和超时释放监听与轮询。
 * 模块边界：不拦截 fetch/XHR、不返回账号数据或执行页面指令；字幕资源由隔离世界独立校验并读取。
 */
import {captionRecord} from './courseCaptionData';
const REQUEST = 'fluent-read:bilibili-caption-manifest:request';
const RESPONSE = 'fluent-read:bilibili-caption-manifest:response';
const STATE = '__fluentReadCaptionManifestBridge';

export function installBilibiliCaptionBridge(page: Window): () => void {
    const host = page as unknown as Record<string, unknown>;
    if (typeof host[STATE] === 'function') return host[STATE] as () => void;
    const listener = (event: MessageEvent) => {
        const data = captionRecord(event.data);
        if (event.source !== page || event.origin !== page.location.origin || data.type !== REQUEST
            || typeof data.requestId !== 'string' || data.requestId.length > 100 || typeof data.part !== 'string') return;
        try {
            const player = host.player as {getManifest?(): unknown} | undefined;
            const manifest = captionRecord(player?.getManifest?.());
            const part = `${manifest.bvid}:${manifest.p}`, avPart = `av${manifest.aid}:${manifest.p}`;
            if (![part, avPart].includes(data.part as string) || !Number.isSafeInteger(manifest.cid) || Number(manifest.cid) <= 0) return;
            page.postMessage({type: RESPONSE, requestId: data.requestId, part: data.part, cid: manifest.cid}, page.location.origin);
        } catch { /* 播放器尚未就绪，客户端在自己的有界预算内重试。 */ }
    };
    const dispose = () => {
        page.removeEventListener('message', listener);
        page.removeEventListener('pagehide', leave);
        page.removeEventListener('pageshow', resume);
        delete host[STATE];
    };
    const leave = (event: PageTransitionEvent) => {
        if (event.persisted) page.removeEventListener('message', listener);
        else dispose();
    };
    const resume = () => page.addEventListener('message', listener);
    host[STATE] = dispose;
    page.addEventListener('message', listener);
    page.addEventListener('pagehide', leave);
    page.addEventListener('pageshow', resume);
    return dispose;
}

export function requestBilibiliCaptionManifest(page: Window, part: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const finish = (cid?: number) => {
            clearInterval(poll); clearTimeout(timeout);
            page.removeEventListener('message', listener); signal.removeEventListener('abort', abort);
            if (cid !== undefined) resolve(cid);
            else reject(signal.aborted ? signal.reason : new Error('字幕播放器身份读取超时'));
        };
        const listener = (event: MessageEvent) => {
            const data = captionRecord(event.data);
            if (event.source === page && event.origin === page.location.origin && data.type === RESPONSE
                && data.requestId === requestId && data.part === part && Number.isSafeInteger(data.cid) && Number(data.cid) > 0) finish(Number(data.cid));
        };
        const send = () => page.postMessage({type: REQUEST, requestId, part}, page.location.origin);
        const abort = () => finish();
        const poll = setInterval(send, 250), timeout = setTimeout(() => finish(), 5000);
        page.addEventListener('message', listener); signal.addEventListener('abort', abort, {once: true});
        send();
    });
}
