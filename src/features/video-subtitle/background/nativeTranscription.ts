/**
 * @file src/features/video-subtitle/background/nativeTranscription.ts
 * 文件职责：将字幕采集的 PCM 音频提交到本机 vLLM 标准转写接口。
 * 主要内容：限制回环地址，单遍校验规范 Base64 并直接解码封装 WAV，按音频时长动态缩放超时，对 429/502/503/504 与网络瞬时故障执行有界抖动重试并尊重 Retry-After 与取消信号，约束响应大小。
 * 模块边界：只执行传输；不启动服务或加载模型，不持有字幕会话，不推断字级时间戳或推理设备。
 */
import {normalizeNativeAsrBaseUrl} from '@/src/core/config/nativeAsr';
import {NATIVE_QWEN_ASR_MODEL, type VideoTranscriptionResult} from '@/src/core/messaging/video';
import {abortErrorFromSignal, cancelResponseReader, cancelUnreadResponseBody, createRuntimeAbortContext} from '@/src/platform/http/runtime';

const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = 30 * SAMPLE_RATE * 2;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MIN_NATIVE_TIMEOUT_MS = 20_000;
const MAX_NATIVE_TIMEOUT_MS = 90_000;
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = [400, 1_200] as const;
const MAX_RETRY_AFTER_MS = 10_000;
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);

const BASE64_LOOKUP = (() => {
    const table = new Int8Array(128).fill(-1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let index = 0; index < alphabet.length; index += 1) {
        table[alphabet.charCodeAt(index)] = index;
    }
    return table;
})();

export interface NativeTranscriptionOptions {
    baseUrl: string;
    signal: AbortSignal;
    sourceLanguage?: string;
}

function endpoint(baseUrl: string): string {
    const normalized = normalizeNativeAsrBaseUrl(baseUrl);
    if (!normalized) {
        throw new Error('原生转写地址必须是本机回环地址，不接受凭据、远程地址或额外路径');
    }
    return `${normalized}/v1/audio/transcriptions`;
}

function decodeBase64Code(code: number): number {
    return code < 128 ? BASE64_LOOKUP[code] : -1;
}

function pcmWav(encoded: string): {blob: Blob; durationMs: number} {
    if (!encoded || encoded.length > Math.ceil(MAX_PCM_BYTES / 3) * 4 || encoded.length % 4 !== 0) {
        throw new Error('原生转写需要不超过30秒的16kHz单声道PCM16数据');
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const pcmLength = (encoded.length / 4) * 3 - padding;
    // The encoded-length bound above already implies 0 < pcmLength <= MAX_PCM_BYTES.
    if (pcmLength % 2 !== 0) {
        throw new Error('原生转写PCM16数据无效');
    }
    const bytes = new Uint8Array(44 + pcmLength);
    let out = 44;
    const fullGroups = padding ? (encoded.length / 4) - 1 : encoded.length / 4;
    for (let group = 0; group < fullGroups; group += 1) {
        const offset = group * 4;
        const c0 = decodeBase64Code(encoded.charCodeAt(offset));
        const c1 = decodeBase64Code(encoded.charCodeAt(offset + 1));
        const c2 = decodeBase64Code(encoded.charCodeAt(offset + 2));
        const c3 = decodeBase64Code(encoded.charCodeAt(offset + 3));
        if ((c0 | c1 | c2 | c3) < 0) throw new Error('原生转写PCM16数据无效');
        bytes[out++] = (c0 << 2) | (c1 >> 4);
        bytes[out++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
        bytes[out++] = ((c2 & 0x03) << 6) | c3;
    }
    if (padding === 1) {
        const offset = encoded.length - 4;
        const c0 = decodeBase64Code(encoded.charCodeAt(offset));
        const c1 = decodeBase64Code(encoded.charCodeAt(offset + 1));
        const c2 = decodeBase64Code(encoded.charCodeAt(offset + 2));
        if ((c0 | c1 | c2) < 0 || (c2 & 0x03) !== 0) throw new Error('原生转写PCM16数据无效');
        bytes[out++] = (c0 << 2) | (c1 >> 4);
        bytes[out++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    } else if (padding === 2) {
        const offset = encoded.length - 4;
        const c0 = decodeBase64Code(encoded.charCodeAt(offset));
        const c1 = decodeBase64Code(encoded.charCodeAt(offset + 1));
        if ((c0 | c1) < 0 || (c1 & 0x0f) !== 0) throw new Error('原生转写PCM16数据无效');
        bytes[out++] = (c0 << 2) | (c1 >> 4);
    }
    const header = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    header.setUint32(4, pcmLength + 36, true);
    ascii(8, 'WAVEfmt ');
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, SAMPLE_RATE, true);
    header.setUint32(28, SAMPLE_RATE * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    ascii(36, 'data');
    header.setUint32(40, pcmLength, true);
    return {blob: new Blob([bytes], {type: 'audio/wav'}), durationMs: pcmLength / (SAMPLE_RATE * 2) * 1000};
}

function parseRetryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(Number(trimmed) * 1_000)));
    }
    if (!/[A-Za-z]{3}/.test(trimmed)) return null;
    const timestamp = Date.parse(trimmed);
    if (Number.isFinite(timestamp)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now()));
    }
    return null;
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfter = parseRetryAfterMs(retryAfterHeader);
    if (retryAfter !== null) return retryAfter;
    const base = RETRY_BACKOFF_MS[attempt];
    return Math.round(base * (0.85 + Math.random() * 0.3));
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('本地 ASR 请求已取消'));
    if (delayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortErrorFromSignal(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener('abort', onAbort, {once: true});
    });
}

async function responseText(response: Response): Promise<string> {
    if (!response.body) throw new Error('原生转写响应为空');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let size = 0;
    let text = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error('原生转写响应超过大小限制');
            text += decoder.decode(value, {stream: true});
        }
        text += decoder.decode();
    } catch (error) {
        cancelResponseReader(reader);
        throw error;
    }
    reader.releaseLock();
    return text;
}

/** Input: canonical base64 of mono 16000Hz PCM16LE. Duration is derived from input bytes.
 * Settling closes the client body; it is not proof that remote model computation has stopped. */
export async function transcribeNativeQwenPcm16(
    encoded: string,
    options: NativeTranscriptionOptions,
): Promise<VideoTranscriptionResult> {
    if (options.signal.aborted) throw abortErrorFromSignal(options.signal);
    const url = endpoint(options.baseUrl);
    const language = options.sourceLanguage?.trim();
    if (language && language !== 'auto' && !/^[a-z]{2}$/.test(language)) {
        throw new Error('原生转写源语言必须是ISO 639-1代码或auto');
    }
    const {blob, durationMs} = pcmWav(encoded);
    const buildForm = () => {
        const form = new FormData();
        form.append('file', blob, 'audio.wav');
        form.append('model', NATIVE_QWEN_ASR_MODEL);
        form.append('response_format', 'json');
        form.append('stream', 'false');
        if (language && language !== 'auto') form.append('language', language);
        return form;
    };
    const timeoutMs = Math.min(MAX_NATIVE_TIMEOUT_MS, Math.max(MIN_NATIVE_TIMEOUT_MS, Math.round(durationMs * 4)));
    const abort = createRuntimeAbortContext(timeoutMs, options.signal);
    let transcription: VideoTranscriptionResult;
    try {
        let response!: Response;
        for (let attempt = 0; ; attempt += 1) {
            try {
                // Local audio requires native Fetch redirect/credential semantics, not a userscript transport.
                response = await globalThis.fetch(url, {
                    method: 'POST', body: buildForm(), signal: abort.signal,
                    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
                });
            } catch (error) {
                if (abort.signal.aborted || attempt >= MAX_TRANSIENT_RETRIES) throw error;
                await waitForRetry(retryDelayMs(attempt, null), abort.signal);
                continue;
            }
            if (response.ok) break;
            const retryAfter = response.headers.get('retry-after');
            cancelUnreadResponseBody(response);
            if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < MAX_TRANSIENT_RETRIES) {
                await waitForRetry(retryDelayMs(attempt, retryAfter), abort.signal);
                continue;
            }
            throw new Error(`原生转写服务返回HTTP ${response.status}`);
        }
        const result: unknown = JSON.parse(await responseText(response));
        if (abort.signal.aborted) throw abortErrorFromSignal(abort.signal);
        if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
            throw new Error('原生转写响应缺少text字符串');
        }
        // Standard Qwen ASR JSON supplies text only, not word timing or device evidence.
        transcription = {text: result.text, model: NATIVE_QWEN_ASR_MODEL, audioDurationMs: durationMs};
    } catch (error) {
        if (abort.didTimeout()) throw new Error('原生转写超时');
        if (abort.signal.aborted) throw abortErrorFromSignal(abort.signal);
        throw error;
    } finally {
        abort.cleanup();
    }
    return transcription;
}
