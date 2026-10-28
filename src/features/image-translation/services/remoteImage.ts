/**
 * @file src/features/image-translation/services/remoteImage.ts
 * 文件职责：为网页 CORS 与 Offscreen 读取图片提供统一的有界响应处理，把图片字节转换为 OCR 可消费的 data URL。
 * 主要内容：扩展读取仅允许公网 HTTPS 域名、拒绝凭据、端口和重定向；共享 MIME、16 MiB、取消与总时限校验，每次流读取后释放取消监听，区分网络失败和不可重试的响应错误。
 * 模块边界：本文件不监听 runtime 消息、不读取页面 DOM；消息路由和 Offscreen 生命周期由 app 层负责，内容脚本只能拿到最终 data URL。
 */

export const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024;
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

/** 已收到响应后的状态、内容或读取失败，不能当作 CORS 拒绝再次联网。 */
export class ImageReadError extends Error {}

export interface RemoteImageResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly url?: string;
    readonly headers: {
        get(name: string): string | null;
    };
    readonly body?: ReadableStream<Uint8Array> | null;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type RemoteImageRequest = (
    url: string,
    init: {credentials: 'omit'; redirect: 'error'; signal: AbortSignal},
) => Promise<RemoteImageResponse>;

function isPublicImageHost(hostname: string): boolean {
    const host = hostname.replace(/\.$/u, '').toLowerCase();
    // URL 已把十进制、八进制和十六进制 IPv4 规范化；不接受任何 IP、单标签或保留本地域。
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(host)
        && !/(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|corp|test|invalid|example)$/u.test(host)
        && !host.endsWith('.home.arpa');
}

function createRemoteImageAbortError(): Error {
    const error = new Error('远程图片读取已取消');
    error.name = 'AbortError';
    return error;
}

/** 公网 HTTPS 图片策略；后台还须核验发起页面中当前图片任务的独立授权。 */
export function normalizeRemoteImageUrl(source: string): string {
    let url: URL;
    try {
        url = new URL(source);
    } catch {
        throw new Error('图片地址无效');
    }

    if (url.protocol !== 'https:') throw new Error('跨域图片读取只支持 HTTPS');
    if (url.username || url.password || url.port) throw new Error('图片地址不能包含凭据或自定义端口');
    if (!isPublicImageHost(url.hostname)) throw new Error('不支持本地或内网图片地址');
    url.hash = '';
    return url.href;
}

/** 在读取响应体前复核最终地址；拒绝由适配器或服务器引入的未授权第二跳。 */
export function validateRemoteImageResponseUrl(initialUrl: string, responseUrl?: string): string {
    const normalizedInitial = normalizeRemoteImageUrl(initialUrl);
    const normalizedFinal = normalizeRemoteImageUrl(responseUrl || normalizedInitial);
    if (normalizedInitial !== normalizedFinal) throw new ImageReadError('跨域图片不允许重定向');
    return normalizedFinal;
}

export function normalizeRemoteImageMimeType(contentType: string): string {
    const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase();
    if (!mimeType?.startsWith('image/')) throw new ImageReadError('远程地址不是图片');
    return mimeType;
}

export function imageBufferToDataUrl(buffer: ArrayBuffer, contentType: string): string {
    if (buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new ImageReadError('图片文件过大');

    const mimeType = normalizeRemoteImageMimeType(contentType);
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
}

function discardResponseBody(response: RemoteImageResponse, reason: unknown): void {
    if (response.body) void response.body.cancel(reason).catch(() => undefined);
}

async function readResponseBuffer(
    response: RemoteImageResponse,
    abortPromise: Promise<never>,
    signal: AbortSignal,
    abortReason: () => Error,
): Promise<ArrayBuffer> {
    if (!response.body) return Promise.race([response.arrayBuffer(), abortPromise]);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            if (signal.aborted) throw abortReason();
            let onAbort!: () => void;
            const interrupted = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(abortReason());
                signal.addEventListener('abort', onAbort, {once: true});
            });
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                const pending = new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => resolve(reader.read()));
                chunk = await Promise.race([pending, interrupted]);
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
            const {done, value} = chunk;
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            byteLength += value.byteLength;
            if (byteLength > MAX_REMOTE_IMAGE_BYTES) throw new ImageReadError('图片文件过大');
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        throw error;
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // 取消中的 reader 可能仍有未完成 read；底层 fetch signal 已负责终止传输。
        }
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes.buffer;
}

/** 两种读取路径共享 deadline，连响应头等待与悬挂 body 都会被主动终止。 */
async function fetchImageForOcr(
    source: string,
    request: RemoteImageRequest,
    callerSignal?: AbortSignal,
    timeoutMs = REMOTE_IMAGE_TIMEOUT_MS,
    validateResponse?: (response: RemoteImageResponse) => void,
): Promise<string> {
    if (callerSignal?.aborted) throw createRemoteImageAbortError();

    const controller = new AbortController();
    const timeoutError = new ImageReadError('图片读取超时');
    timeoutError.name = 'TimeoutError';
    let abortReason: Error | null = null;
    let rejectAbort!: (reason: Error) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const abortWith = (reason: Error): void => {
        if (abortReason) return;
        abortReason = reason;
        controller.abort();
        rejectAbort(reason);
    };
    const onCallerAbort = () => abortWith(createRemoteImageAbortError());
    callerSignal?.addEventListener('abort', onCallerAbort, {once: true});
    const timer = setTimeout(() => abortWith(timeoutError), timeoutMs);

    try {
        const responseWork = request(source, {
            credentials: 'omit',
            // Fetch 的 manual 模式无法安全检查 Location；error 模式会在第二跳前失败。
            redirect: 'error',
            signal: controller.signal,
        });
        void responseWork.then((lateResponse) => {
            if (controller.signal.aborted) discardResponseBody(lateResponse, abortReason!);
        }, () => undefined);
        const response = await Promise.race([responseWork, abortPromise]);
        try {
            validateResponse?.(response);
        } catch (error) {
            discardResponseBody(response, error);
            throw error;
        }
        if (!response.ok) {
            const error = new ImageReadError(`图片服务器返回 ${response.status}`);
            discardResponseBody(response, error);
            throw error;
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > MAX_REMOTE_IMAGE_BYTES) {
            const error = new ImageReadError('图片文件过大');
            discardResponseBody(response, error);
            throw error;
        }

        let mimeType: string;
        try {
            mimeType = normalizeRemoteImageMimeType(response.headers.get('content-type') || '');
        } catch (error) {
            discardResponseBody(response, error);
            throw error;
        }
        try {
            const buffer = await readResponseBuffer(response, abortPromise, controller.signal, () => abortReason!);
            if (controller.signal.aborted) throw abortReason!;
            return imageBufferToDataUrl(buffer, mimeType);
        } catch (error) {
            // 有响应后的流错误不是 CORS 拒绝，保留原因且不触发扩展重抓。
            if (controller.signal.aborted) throw abortReason!;
            throw error instanceof ImageReadError ? error : new ImageReadError(error instanceof Error ? error.message : '图片数据读取失败');
        }
    } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
    }
}

/** 网页 CORS 读取使用网页权限；响应验证与超时清理和扩展读取保持一致。 */
export function fetchPageImageForOcr(source: string, signal?: AbortSignal, timeoutMs = REMOTE_IMAGE_TIMEOUT_MS): Promise<string> {
    return fetchImageForOcr(source, (url, init) => fetch(url, {...init, mode: 'cors', redirect: 'follow'}), signal, timeoutMs);
}

/** Offscreen 只读取已授权的公网 HTTPS 图片；error 模式在第二跳前中断。 */
export async function fetchRemoteImageForOcr(source: string, request: RemoteImageRequest, callerSignal?: AbortSignal): Promise<string> {
    const url = normalizeRemoteImageUrl(source);
    return fetchImageForOcr(url, request, callerSignal, REMOTE_IMAGE_TIMEOUT_MS,
        response => { validateRemoteImageResponseUrl(url, response.url); });
}

/** Offscreen 的真实网络端口；调用方只接收已校验的 data URL。 */
export function fetchImageInOffscreen(source: string, signal: AbortSignal): Promise<string> {
    return fetchRemoteImageForOcr(source, (url, init) => fetch(url, init), signal);
}
