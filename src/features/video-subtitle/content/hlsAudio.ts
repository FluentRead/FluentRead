/**
 * @file src/features/video-subtitle/content/hlsAudio.ts
 * 文件职责：从 X 播放器已请求的 HLS 清单读取完整音轨，避免按视频时长实时扫描。
 * 主要内容：优先音频 rendition、保留同清单内的备用变体，先校验 fMP4 初始化段中的音频轨，再按原顺序并发读取媒体段；响应头拒绝即释放未读流，读取取消不依赖底层清理完成，并严格限制大小与取消范围。
 * 模块边界：不解密媒体、不访问页面凭据、不操作播放器；fetch 由调用方注入，解码由独立浏览器音频适配器执行。
 */
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';

export interface HlsAudioManifest {next?: string; alternatives?: string[]; segments?: string[]; durationMs: number}
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** 沿 moov/trak/mdia/hdlr 检查真实音频轨，避免下载只有画面的高清分片。 */
export function hasMp4AudioTrack(bytes: Uint8Array): boolean {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const path = [0x6d6f6f76, 0x7472616b, 0x6d646961, 0x68646c72];
    const find = (start: number, end: number, depth: number): boolean => {
        for (let offset = start; offset + 8 <= end;) {
            let size = view.getUint32(offset);
            const type = view.getUint32(offset + 4);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end) return false;
                size = Number(view.getBigUint64(offset + 8));
                header = 16;
            } else if (size === 0) size = end - offset;
            if (!Number.isSafeInteger(size) || size < header || size > end - offset) return false;
            if (type === path[depth]) {
                if (depth < 3 && find(offset + header, offset + size, depth + 1)) return true;
                if (depth === 3 && size >= header + 12 && view.getUint32(offset + header + 8) === 0x736f756e) return true;
            }
            offset += size;
        }
        return false;
    };
    return find(0, bytes.length, 0);
}

export interface ReadBoundedMediaResponseOptions {
    /** Reserve bytes in a caller-owned budget before retaining each stream chunk. */
    consumeBytes?: (count: number) => boolean;
}

export function isXMediaUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'video.twimg.com' && !url.username && !url.password;
    } catch { return false; }
}

function resource(value: string, base: string): string {
    const url = new URL(value, base).href;
    if (!isXMediaUrl(url)) throw new Error('视频音轨地址不属于 X');
    return url;
}

/** 只接受完整、无加密、无 byte-range 的有限 fMP4 音轨，其他格式交回播放器采集。 */
export function parseHlsAudioManifest(text: string, base: string): HlsAudioManifest | null {
    if (!isXMediaUrl(base) || text.length > 1_000_000 || !text.trim().startsWith('#EXTM3U')) return null;
    const lines = text.trim().split(/\r?\n/).map(line => line.trim());
    if (lines.some(line => /^#EXT-X-(?:BYTERANGE|DISCONTINUITY)/.test(line)
        || (/^#EXT-X-KEY:/.test(line) && !/METHOD=NONE(?:,|$)/.test(line)))) return null;
    const audios = lines.filter(line => /^#EXT-X-MEDIA:/.test(line) && /(?:^|,)TYPE=AUDIO(?:,|$)/.test(line.replace('#EXT-X-MEDIA:', '')));
    const audioUrls = audios.sort((a, b) => Number(/DEFAULT=YES/.test(b)) - Number(/DEFAULT=YES/.test(a)))
        .flatMap(line => {
            const uri = line.match(/URI="([^"]+)"/)?.[1];
            return uri ? [resource(uri, base)] : [];
        });
    const variants = lines.flatMap((line, index) => {
        if (!line.startsWith('#EXT-X-STREAM-INF:')) return [];
        const uri = lines[index + 1];
        if (!uri || uri.startsWith('#')) return [];
        return [{url: resource(uri, base), bandwidth: Number(line.match(/(?:^|[:,])BANDWIDTH=(\d+)/)?.[1]) || Infinity}];
    });
    const nextUrls = [...new Set([...audioUrls, ...variants.sort((a, b) => a.bandwidth - b.bandwidth).map(variant => variant.url)])].slice(0, 6);
    if (nextUrls.length) return {
        next: nextUrls[0], ...(nextUrls.length > 1 ? {alternatives: nextUrls.slice(1)} : {}), durationMs: 0,
    };
    if (!lines.includes('#EXT-X-ENDLIST')) return null;
    const init = lines.find(line => line.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1];
    if (!init) return null;
    const uris = lines.filter(line => line && !line.startsWith('#'));
    if (!uris.length || uris.length > 256) return null;
    const durationMs = lines.reduce((sum, line) => sum + (Number(line.match(/^#EXTINF:([\d.]+)/)?.[1]) || 0) * 1000, 0);
    if (durationMs <= 0 || durationMs > 20 * 60_000) return null;
    return {segments: [resource(init, base), ...uris.map(uri => resource(uri, base))], durationMs};
}

export async function readBoundedMediaResponse(
    response: Response,
    limit: number,
    signal: AbortSignal,
    options: ReadBoundedMediaResponseOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.ok || Number(response.headers.get('content-length')) > limit) {
        cancelUnreadResponseBody(response);
        throw new Error('视频音轨响应无效或过大');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('视频音轨响应为空');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, {once: true});
    try {
        while (!signal.aborted) {
            const part = await reader.read();
            if (part.done) break;
            if (options.consumeBytes && !options.consumeBytes(part.value.length)) {
                throw new Error('视频音轨超过读取上限');
            }
            length += part.value.length;
            if (length > limit) throw new Error('视频音轨超过读取上限');
            chunks.push(part.value);
        }
        if (signal.aborted) throw new Error('视频音轨读取已取消');
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
    } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}

export async function readXHlsAudio(
    url: string,
    initialManifest: string,
    signal: AbortSignal,
    fetchResource: (url: string, options: {signal: AbortSignal; credentials: 'omit'}) => Promise<Response>,
): Promise<{bytes: Uint8Array; durationMs: number} | null> {
    const scope = new AbortController();
    const abort = () => scope.abort();
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, 30_000);
    const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        scope.abort();
    };
    const visited = new Set<string>();
    let attempts = 0;
    const readHeaderResource = async (resourceUrl: string, parent: AbortSignal, options: ReadBoundedMediaResponseOptions = {}) => {
        const requestScope = new AbortController();
        const cancelRequest = () => requestScope.abort();
        parent.addEventListener('abort', cancelRequest, {once: true});
        // 清单/初始化段应很小；某个地址卡住不应占满整段音轨的预算。
        // 媒体分片仍共用完整 30 秒读取预算，不因这个阶段上限被缩短。
        const requestTimer = setTimeout(cancelRequest, 5000);
        try {
            const response = await fetchResource(resourceUrl, {signal: requestScope.signal, credentials: 'omit'});
            return await readBoundedMediaResponse(response, 1_000_000, requestScope.signal, options);
        } finally {
            clearTimeout(requestTimer);
            parent.removeEventListener('abort', cancelRequest);
            requestScope.abort();
        }
    };
    const readManifest = async (manifestUrl: string, text: string, depth: number): Promise<{bytes: Uint8Array; durationMs: number} | null> => {
        if (scope.signal.aborted || depth > 3 || visited.has(manifestUrl) || attempts >= 12) return null;
        visited.add(manifestUrl);
        attempts += 1;
        const manifest = parseHlsAudioManifest(text, manifestUrl);
        if (manifest?.next) {
            if (depth >= 3) return null;
            let lastError: unknown;
            for (const next of [manifest.next, ...manifest.alternatives || []]) {
                if (scope.signal.aborted || attempts >= 12) return null;
                if (visited.has(next)) continue;
                // 一个默认 rendition 过期或没有音轨时，仍可使用同主清单内
                // 尚未被播放器请求的备用音轨；不能依赖 resource timing 恰好收录它。
                try {
                    const bytes = await readHeaderResource(next, scope.signal);
                    const result = await readManifest(next, new TextDecoder().decode(bytes), depth + 1);
                    if (result) return result;
                } catch (error) { lastError = error; }
            }
            if (lastError && !scope.signal.aborted) throw lastError;
            return null;
        }
        if (!manifest?.segments || scope.signal.aborted) return null;
        const mediaScope = new AbortController();
        const cancelMedia = () => mediaScope.abort();
        scope.signal.addEventListener('abort', cancelMedia, {once: true});
        try {
            const segments = manifest.segments;
            const results: Uint8Array[] = [];
            let index = 1;
            let total = 0;
            const consumeBytes = (count: number): boolean => {
                if (!Number.isSafeInteger(count) || count < 0 || total > MAX_AUDIO_BYTES - count) return false;
                total += count;
                return true;
            };
            // 清单时长匹配只能证明属于同一视频，不能证明包含音轨。
            // 先读取小型初始化段；纯视频清单直接交回上层尝试其他候选。
            results[0] = await readHeaderResource(segments[0], mediaScope.signal, {consumeBytes});
            if (!hasMp4AudioTrack(results[0]) || mediaScope.signal.aborted) return null;
            const worker = async () => {
                while (index < segments.length && !mediaScope.signal.aborted) {
                    const next = index++;
                    const response = await fetchResource(segments[next], {signal: mediaScope.signal, credentials: 'omit'});
                    const bytes = await readBoundedMediaResponse(response, MAX_AUDIO_BYTES, mediaScope.signal, {consumeBytes});
                    results[next] = bytes;
                }
            };
            try { await Promise.all([worker(), worker(), worker()]); }
            catch (error) { mediaScope.abort(); throw error; }
            if (mediaScope.signal.aborted) return null;
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const segment of results) { bytes.set(segment, offset); offset += segment.length; }
            return {bytes, durationMs: manifest.durationMs};
        } finally {
            scope.signal.removeEventListener('abort', cancelMedia);
            mediaScope.abort();
        }
    };
    try {
        return await readManifest(url, initialManifest, 0).catch(error => {
            if (scope.signal.aborted) return null;
            throw error;
        });
    } finally { cleanup(); }
}
