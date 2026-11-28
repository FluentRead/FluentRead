/**
 * @file src/features/video-subtitle/content/subtitleTransport.ts
 * 文件职责：为 X 与 YouTube 的字幕读取提供同一有界网络和响应流生命周期。
 * 主要内容：十五秒总预算覆盖响应头及全部正文，按调用方传入的字节上限拒绝大响应；非 2xx 响应回收未读正文并在错误上附加 statusCode 与可选 retryAfterMs 供退避状态机分类；外部取消保留原因并立即释放等待，迟到响应回收未读正文，清理失败不覆盖原始错误。
 * 模块边界：只获取字幕文本，不解析或选择轨道、不提交字幕；调用方拥有媒体代次、凭据策略和失败重试。
 */
import {readRetryAfterMs} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';
import {readBoundedMediaResponse} from './hlsAudio';

type CaptionRequest = (url: string, init: {signal: AbortSignal; credentials: RequestCredentials}) => Promise<Response>;
interface CaptionRequestOptions {
    signal?: AbortSignal;
    credentials: RequestCredentials;
    maxBytes?: number;
}

export async function readVideoCaptionText(url: string, request: CaptionRequest, options: CaptionRequestOptions): Promise<string> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal!.reason);
    const canceled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {once: true});
    });
    options.signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(new DOMException('字幕资源读取超时', 'TimeoutError')), 15_000);
    try {
        const work = (async () => {
            const response = await request(url, {signal: controller.signal, credentials: options.credentials});
            if (controller.signal.aborted) {
                cancelUnreadResponseBody(response);
                controller.signal.throwIfAborted();
            }
            if (!response.ok) {
                cancelUnreadResponseBody(response);
                const retryAfterMs = response.headers ? readRetryAfterMs(response.headers) : undefined;
                throw Object.assign(new Error(`字幕轨道请求失败（${response.status}）`), {
                    statusCode: response.status,
                    ...(retryAfterMs ? {retryAfterMs} : {}),
                });
            }
            // YouTube 的长讲座保留 8 MB 文本预算；X 清单仍由调用方限定为 1 MB。
            return new TextDecoder().decode(await readBoundedMediaResponse(response, options.maxBytes ?? 8_000_000, controller.signal));
        })();
        return await Promise.race([work, canceled]);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}
