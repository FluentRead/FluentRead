/**
 * @file src/features/selection-translation/services/googleTts.ts
 * 文件职责：实现 Google Translate TTS 在线分段合成客户端，解决单次 200 字符上限导致的长文本朗读失败，作为广泛语种覆盖的免费兜底来源。
 * 主要内容：提供语言码到 Google tl 参数的规范化、按句界/子句/空格切分的 ≤180 字×8 段分段策略、10 秒有界超时与并发 2 拉取、响应音频校验及 MP3 拼接，导出 normalizeGoogleTtsLanguage、splitGoogleTtsText、buildGoogleTtsUrl 与 synthesizeGoogleTts。
 * 模块边界：本文件仅负责 Google TTS 音频拉取与拼接，复用 core/language/chinese 与 edgeTtsPolicy 纯函数及 platform/http 运行时；不处理 Offscreen 播放、缓存路由或配置读取。
 */
import {getChineseScript} from '@/src/core/language/chinese';
import {createHttpStatusError} from '@/src/platform/http/errors';
import {
    cancelUnreadResponseBody,
    createRuntimeAbortContext,
    runtimeFetch,
} from '@/src/platform/http/runtime';
import {concatEdgeTtsAudio, splitTtsTextByChars} from './edgeTtsPolicy';

export interface GoogleTtsAudio {
    audio: ArrayBuffer;
    contentType: string;
    voice: string;
    source: 'google';
}

export interface SynthesizeGoogleTtsOptions {
    readonly timeoutMs?: number;
    readonly concurrency?: number;
}

export const googleTtsLimits = Object.freeze({
    chunkChars: 180,
    maxChunks: 8,
    defaultTimeoutMs: 10_000,
    defaultConcurrency: 2,
});

const REGIONAL_GOOGLE_TTS_LOCALE: Readonly<Record<string, string>> = {
    'en-us': 'en-US',
    'en-gb': 'en-GB',
    'en-uk': 'en-GB',
    'en-au': 'en-AU',
    'en-ca': 'en-CA',
    'pt-br': 'pt-BR',
    'pt-pt': 'pt-PT',
    'es-es': 'es-ES',
    'es-mx': 'es-MX',
    'fr-fr': 'fr-FR',
    'fr-ca': 'fr-CA',
};

function createAbortError(): Error {
    const error = new Error('语音合成已取消');
    error.name = 'AbortError';
    return error;
}

function createTimeoutError(message: string): Error {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

function isAcceptableAudioContentType(contentType: string): boolean {
    const normalized = contentType.split(';')[0]!.trim().toLowerCase();
    return !normalized
        || normalized.startsWith('audio/')
        || normalized === 'application/octet-stream';
}

function looksLikeHtmlOrJsonPayload(buffer: ArrayBuffer): boolean {
    const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 32))).trimStart().toLowerCase();
    return head.startsWith('<!doctype')
        || head.startsWith('<html')
        || head.startsWith('<?xml')
        || head.startsWith('{')
        || head.startsWith('[');
}

/** 将应用语言码规范化为 Google translate_tts 可接受的 tl 参数。 */
export function normalizeGoogleTtsLanguage(language: string): string {
    const normalized = String(language || '').replace(/_/gu, '-').trim();
    const lower = normalized.toLowerCase();
    if (!normalized || ['auto', 'detect', 'unknown', 'und'].includes(lower)) return 'en';

    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';
    if (['cmn', 'zho', 'chi'].includes(lower)) return 'zh-CN';
    if (Object.hasOwn(REGIONAL_GOOGLE_TTS_LOCALE, lower)) {
        return REGIONAL_GOOGLE_TTS_LOCALE[lower]!;
    }
    const base = lower.split('-')[0] || '';
    if (/^[a-z]{2,3}$/u.test(base)) return base;
    return 'en';
}

/** 按句界、子句和空格切分为不超过 180 字符、最多 8 段的请求切片。 */
export function splitGoogleTtsText(text: string): string[] {
    return splitTtsTextByChars(
        text,
        googleTtsLimits.chunkChars,
        googleTtsLimits.maxChunks,
        () => new Error('Google TTS text is too long'),
    );
}

export function buildGoogleTtsUrl(chunk: string, language: string): string {
    const tl = normalizeGoogleTtsLanguage(language);
    return `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(tl)}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
}

async function fetchGoogleChunk(
    chunk: string,
    tl: string,
    signal: AbortSignal,
    timeoutMs: number,
): Promise<ArrayBuffer> {
    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(tl)}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
        const response = await runtimeFetch(url, {
            method: 'GET',
            signal: abortContext.signal,
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, 'Google TTS request failed');
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!isAcceptableAudioContentType(contentType)) {
            cancelUnreadResponseBody(response);
            throw new Error('Google TTS returned non-audio response');
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) {
            throw new Error('Google TTS returned empty audio');
        }
        if (looksLikeHtmlOrJsonPayload(buffer)) {
            throw new Error('Google TTS returned non-audio response');
        }
        return buffer;
    } catch (error) {
        if (signal?.aborted) throw createAbortError();
        if (abortContext.didTimeout()) throw createTimeoutError('Google 朗读请求超时');
        throw error;
    } finally {
        abortContext.cleanup();
    }
}

export async function synthesizeGoogleTts(
    text: string,
    language: string,
    signal?: AbortSignal,
    options?: SynthesizeGoogleTtsOptions,
): Promise<GoogleTtsAudio> {
    if (signal?.aborted) throw createAbortError();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Google TTS 文本为空');

    const tl = normalizeGoogleTtsLanguage(language);
    const chunks = splitGoogleTtsText(trimmed);
    const timeoutMs = options?.timeoutMs ?? googleTtsLimits.defaultTimeoutMs;
    const concurrency = Math.max(1, options?.concurrency ?? googleTtsLimits.defaultConcurrency);

    const audioBuffers = new Array<ArrayBuffer>(chunks.length);
    const batchController = new AbortController();
    const onCallerAbort = () => batchController.abort(signal?.reason);
    signal?.addEventListener('abort', onCallerAbort, {once: true});

    let nextIndex = 0;
    let firstError: unknown;
    let hasError = false;
    const workerCount = Math.min(concurrency, chunks.length);

    const runWorker = async (): Promise<void> => {
        while (!hasError && !batchController.signal.aborted) {
            const currentIndex = nextIndex++;
            if (currentIndex >= chunks.length) return;
            try {
                audioBuffers[currentIndex] = await fetchGoogleChunk(
                    chunks[currentIndex]!,
                    tl,
                    batchController.signal,
                    timeoutMs,
                );
            } catch (error) {
                if (!hasError) {
                    hasError = true;
                    firstError = error;
                    batchController.abort();
                }
                return;
            }
        }
    };

    try {
        await Promise.all(Array.from({length: workerCount}, () => runWorker()));
    } finally {
        signal?.removeEventListener('abort', onCallerAbort);
    }

    if (signal?.aborted) throw createAbortError();
    if (hasError) throw firstError;
    return {
        audio: concatEdgeTtsAudio(audioBuffers),
        contentType: 'audio/mpeg',
        voice: 'Google TTS',
        source: 'google',
    };
}
