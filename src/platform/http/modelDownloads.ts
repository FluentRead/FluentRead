/**
 * @file src/platform/http/modelDownloads.ts
 * 文件职责：为按需模型数据下载提供地域提示、多来源回退与流式接收超时。
 * 主要内容：保留固定文件路径和版本，以语言提示排列可信来源；连接、断流和整体等待都有独立墙钟边界，失败切换来源，取消与磁盘不足立即结束；流式接收不构造整份模型缓冲区，每次读取独立释放取消监听，并回报实际字节与安全来源状态。
 * 模块边界：只下载模型数据，不执行远程 JS/WASM、不处理用户文本或凭据；语言仅影响尝试顺序，不推断实际所在地。
 */
import type {ModelDownloadStatus} from '@/src/core/download/progress';
import {cancelUnreadResponseBody} from './runtime';
export type {ModelDownloadStatus} from '@/src/core/download/progress';
export type ModelSourcePreference = 'auto' | 'official' | 'mirror';
const OFFICIAL = 'https://huggingface.co';
const MIRRORS = ['https://hf-mirror.com'];

export function huggingFaceDownloadOrigins(preference: ModelSourcePreference = 'auto'): string[] {
    const language = typeof navigator === 'undefined' ? '' : navigator.language;
    const preferMirror = preference === 'mirror' || (preference === 'auto' && /^zh(?:$|-CN|-Hans)/iu.test(language));
    return preferMirror ? [...MIRRORS, OFFICIAL] : [OFFICIAL, ...MIRRORS];
}

export function modelDownloadSources(url: string, preference: ModelSourcePreference = 'auto'): string[] {
    const parsed = new URL(url);
    if (parsed.origin === OFFICIAL) return huggingFaceDownloadOrigins(preference).map(origin => origin + parsed.pathname + parsed.search);
    if (parsed.origin === 'https://modelscope.cn' && parsed.pathname.startsWith('/models/')) {
        // 仅现有公开 Whisper 仓库在这两个平台使用相同仓库名、分支和文件清单。
        if (/^\/models\/onnx-community\/whisper-(?:tiny|base|small)\/resolve\/master\//u.test(parsed.pathname)) {
            const hfPath = parsed.pathname.slice('/models'.length).replace('/resolve/master/', '/resolve/main/');
            const sources = huggingFaceDownloadOrigins(preference).map(origin => origin + hfPath + parsed.search);
            return sources[0]!.startsWith(OFFICIAL) ? [...sources, url] : [url, ...sources];
        }
    }
    return [url];
}

/** 历史已缓存来源仅作精确资格校验；旧 .net 永不重新进入网络下载列表。 */
export function isModelCacheSource(canonicalUrl: string, source: unknown): boolean {
    if (typeof source !== 'string') return false;
    return modelDownloadSources(canonicalUrl).includes(source)
        || canonicalUrl.startsWith(`${OFFICIAL}/`) && source === `https://hf-mirror.net${canonicalUrl.slice(OFFICIAL.length)}`;
}

/** consume 必须在响应体完全接收并校验/写入后完成，才能将一次来源尝试视为成功。 */
export async function withModelDownload<T>(
    url: string,
    consume: (response: Response, source: string) => Promise<T>,
    options: {
        signal?: AbortSignal; timeoutMs?: number; connectTimeoutMs?: number; idleTimeoutMs?: number; preference?: ModelSourcePreference;
        /** 单文件解码后字节上限；即使没有响应长度也按实际接收字节拦截。 */
        maxBytes?: number;
        /** 每个来源从 0 开始回报已接收字节；total 仅在响应给出未经压缩编码的 Content-Length 时提供。 */
        onProgress?: (loaded: number, total?: number) => void;
        /** 只传固定来源枚举与尝试序号，不向界面暴露下载 URL、请求头或凭据。 */
        onSourceStatus?: (status: ModelDownloadStatus) => void;
    } = {},
): Promise<T> {
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) throw new Error('模型文件大小上限无效');
    const active = () => {if (options.signal?.aborted) throw new DOMException('模型下载已取消', 'AbortError');};
    let failure: unknown;
    const sources = modelDownloadSources(url, options.preference);
    for (const [index, source] of sources.entries()) {
        active();
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, {once: true});
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {clearTimeout(idle); idle = setTimeout(abort, options.idleTimeoutMs ?? 20_000);};
        const total = setTimeout(abort, options.timeoutMs ?? 300_000);
        const connecting = setTimeout(abort, options.connectTimeoutMs ?? 10_000);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let originalBody: ReadableStream<Uint8Array> | null | undefined;
        let target: ReadableStreamDefaultController<Uint8Array> | undefined;
        const interrupted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
                const error = new DOMException('模型下载超时或已取消', 'TimeoutError');
                target?.error(error);
                reject(error);
            }, {once: true});
        });
        // 取消可能早于某一阶段的 race 安装，提前接住拒绝避免未处理异常。
        void interrupted.catch(() => undefined);
        const origin = new URL(source).origin;
        const sourceId = origin === 'https://modelscope.cn' ? 'modelscope' : origin === OFFICIAL ? 'huggingface'
            : origin === MIRRORS[0] ? 'hf-mirror' : 'other';
        const status = (state: ModelDownloadStatus['state']) => {
            try {options.onSourceStatus?.({source: sourceId, attempt: index + 1, attempts: sources.length, state});} catch { /* 展示失败不改变下载。 */ }
        };
        try {
            status('connecting');
            active();
            const fetched = fetch(source, {signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer'}).then(response => {
                if (controller.signal.aborted) {cancelUnreadResponseBody(response); throw new DOMException('模型下载来源已失效', 'TimeoutError');}
                return response;
            });
            const response = await Promise.race([fetched, interrupted]);
            clearTimeout(connecting);
            originalBody = response.body;
            active();
            if (!response.ok) throw new Error(`模型文件下载失败（${response.status}）`);
            if (/text\/html/iu.test(response.headers.get('Content-Type') ?? '')) throw new Error('模型下载来源返回了网页');
            if (!response.body) throw new Error('模型文件下载缺少响应体');
            reader = response.body.getReader();
            // 压缩传输时 Content-Length 是编码后的大小，与流出的字节数不可比，此时不提供总量。
            const length = response.headers.get('Content-Encoding') ? NaN : Number(response.headers.get('Content-Length'));
            const total = Number.isFinite(length) && length > 0 ? length : undefined;
            if (options.maxBytes !== undefined && total !== undefined && total > options.maxBytes) throw new Error('模型文件超过大小上限');
            let loaded = 0;
            let receiving = false;
            const progress = () => {try {options.onProgress?.(loaded, total);} catch { /* 进度展示不能中断下载。 */ }};
            progress();
            arm();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {target = controller;},
                async pull(output) {
                    try {
                        arm();
                        let onAbort!: () => void;
                        const readInterrupted = new Promise<never>((_resolve, reject) => {
                            onAbort = () => reject(new DOMException('模型下载超时或已取消', 'TimeoutError'));
                            controller.signal.addEventListener('abort', onAbort, {once: true});
                        });
                        // 不复用整次下载的未决 Promise：每次 race 都会在它上面保留 reaction，
                        // 模型流的分块越多，下载完成前保留的回调就越多。
                        let chunk: ReadableStreamReadResult<Uint8Array>;
                        try {
                            const pending = new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => resolve(reader!.read()));
                            chunk = await Promise.race([pending, readInterrupted]);
                        } finally {
                            controller.signal.removeEventListener('abort', onAbort);
                        }
                        if (controller.signal.aborted) throw new DOMException('模型下载超时', 'TimeoutError');
                        if (chunk.done) {
                            if (total !== undefined && loaded !== total) throw new Error('模型文件响应长度不完整');
                            clearTimeout(idle); output.close();
                        } else {
                            arm(); loaded += chunk.value.byteLength;
                            if (options.maxBytes !== undefined && loaded > options.maxBytes) throw new Error('模型文件超过大小上限');
                            if (!receiving && loaded > 0) {receiving = true; status('receiving');}
                            progress(); output.enqueue(chunk.value);
                        }
                    } catch (error) {output.error(error);}
                },
                cancel: reason => reader!.cancel(reason),
            });
            const consuming = consume(new Response(stream, {status: response.status, statusText: response.statusText, headers: response.headers}), source);
            const result = await Promise.race([consuming, interrupted]);
            active();
            if (controller.signal.aborted) throw new DOMException('模型下载超时', 'TimeoutError');
            return result;
        } catch (error) {
            active();
            if (error instanceof Error && error.name === 'QuotaExceededError') throw error;
            failure = controller.signal.aborted ? new Error('模型文件下载超过等待时限', {cause: error}) : error;
        } finally {
            clearTimeout(idle); clearTimeout(total); clearTimeout(connecting); controller.abort();
            options.signal?.removeEventListener('abort', abort);
            if (reader) {
                try {void reader.cancel().catch(() => undefined);} catch { /* 清理失败不拦截回退。 */ }
                try {reader.releaseLock();} catch { /* 不等待不合作的底层读取。 */ }
            } else cancelUnreadResponseBody({body: originalBody});
        }
    }
    throw failure;
}
