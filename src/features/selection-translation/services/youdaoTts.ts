/**
 * @file src/features/selection-translation/services/youdaoTts.ts
 * 文件职责：实现有道词典在线发音（dictvoice）合成客户端，支持英式/美式英语及日、韩、法、中文的短句与单词高速合成，并在不支持语种或超长文本时抛出不触发熔断的不支持错误。
 * 主要内容：定义语言参数映射与 URL 构造、最多 3 段×200 字的句界分段与并发 2 拉取、8 秒请求超时控制、音频响应类型与非空校验、MP3 缓冲拼接，导出 resolveYoudaoTtsLanguageSpec、buildYoudaoTtsUrl 与 synthesizeYoudaoTts。
 * 模块边界：本文件属于划词朗读在线合成服务层，仅通过 runtimeFetch 请求有道发音端点并复用 edgeTtsPolicy 的纯分段/拼接函数；不管理播放状态机、不读写用户配置也不触发页面音频播放。
 */
import {createHttpStatusError} from '@/src/platform/http/errors';
import {
    cancelUnreadResponseBody,
    createRuntimeAbortContext,
    runtimeFetch,
} from '@/src/platform/http/runtime';
import {concatEdgeTtsAudio, splitTtsTextByChars} from './edgeTtsPolicy';

export interface YoudaoTtsAudio {
    audio: ArrayBuffer;
    contentType: string;
    voice: string;
    source: 'youdao';
}

export interface YoudaoTtsLanguageSpec {
    readonly paramKey: 'type' | 'le';
    readonly paramValue: string;
    readonly voice: string;
}

export interface SynthesizeYoudaoTtsOptions {
    readonly timeoutMs?: number;
    readonly concurrency?: number;
}

export const youdaoTtsLimits = Object.freeze({
    maxChars: 600,
    chunkChars: 200,
    maxChunks: 3,
    defaultTimeoutMs: 8_000,
    defaultConcurrency: 2,
});

const YOUDAO_TTS_BASE_URL = 'https://dict.youdao.com/dictvoice';

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

function createUnsupportedError(message: string): Error {
    return Object.assign(new Error(message), {code: 'tts-language-unsupported'});
}

function createTooLongYoudaoError(): Error {
    return createUnsupportedError('有道发音暂不支持超长文本');
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

/** 将语言码映射为有道 dictvoice 查询参数；不支持的语种返回 null。 */
export function resolveYoudaoTtsLanguageSpec(language: string): YoudaoTtsLanguageSpec | null {
    const normalized = String(language || '').replace(/_/gu, '-').trim().toLowerCase();
    if (!normalized || normalized === 'auto' || normalized === 'detect' || normalized === 'en' || normalized === 'eng') {
        return {paramKey: 'type', paramValue: '2', voice: 'Youdao (US)'};
    }
    if (normalized === 'en-gb' || normalized === 'en-uk' || normalized.startsWith('en-gb-') || normalized.startsWith('en-uk-')) {
        return {paramKey: 'type', paramValue: '1', voice: 'Youdao (UK)'};
    }
    if (normalized.startsWith('en-')) {
        return {paramKey: 'type', paramValue: '2', voice: 'Youdao (US)'};
    }
    if (normalized === 'ja' || normalized === 'jpn' || normalized.startsWith('ja-')) {
        return {paramKey: 'le', paramValue: 'jap', voice: 'Youdao (JP)'};
    }
    if (normalized === 'ko' || normalized === 'kor' || normalized.startsWith('ko-')) {
        return {paramKey: 'le', paramValue: 'ko', voice: 'Youdao (KR)'};
    }
    if (normalized === 'fr' || normalized === 'fra' || normalized.startsWith('fr-')) {
        return {paramKey: 'le', paramValue: 'fr', voice: 'Youdao (FR)'};
    }
    if (normalized === 'zh' || normalized === 'cmn' || normalized === 'zho' || normalized === 'chi' || normalized.startsWith('zh-')) {
        return {paramKey: 'le', paramValue: 'zh', voice: 'Youdao (ZH)'};
    }
    return null;
}

export function buildYoudaoTtsUrl(text: string, spec: YoudaoTtsLanguageSpec): string {
    return `${YOUDAO_TTS_BASE_URL}?audio=${encodeURIComponent(text)}&${spec.paramKey}=${encodeURIComponent(spec.paramValue)}`;
}

async function fetchYoudaoChunk(
    chunk: string,
    spec: YoudaoTtsLanguageSpec,
    signal: AbortSignal,
    timeoutMs: number,
): Promise<ArrayBuffer> {
    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const response = await runtimeFetch(buildYoudaoTtsUrl(chunk, spec), {
            method: 'GET',
            signal: abortContext.signal,
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, 'Youdao TTS request failed');
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!isAcceptableAudioContentType(contentType)) {
            cancelUnreadResponseBody(response);
            throw new Error('Youdao TTS returned non-audio response');
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) {
            throw new Error('Youdao TTS returned empty audio');
        }
        if (looksLikeHtmlOrJsonPayload(buffer)) {
            throw new Error('Youdao TTS returned non-audio response');
        }
        return buffer;
    } catch (error) {
        if (signal?.aborted) throw createAbortError();
        if (abortContext.didTimeout()) throw createTimeoutError('有道发音请求超时');
        throw error;
    } finally {
        abortContext.cleanup();
    }
}

export async function synthesizeYoudaoTts(
    text: string,
    language: string,
    signal?: AbortSignal,
    options?: SynthesizeYoudaoTtsOptions,
): Promise<YoudaoTtsAudio> {
    if (signal?.aborted) throw createAbortError();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('有道发音文本为空');

    const spec = resolveYoudaoTtsLanguageSpec(language);
    if (!spec) {
        throw createUnsupportedError('有道发音暂不支持当前语言');
    }
    if (trimmed.length > youdaoTtsLimits.maxChars) {
        throw createTooLongYoudaoError();
    }

    const chunks = splitTtsTextByChars(
        trimmed,
        youdaoTtsLimits.chunkChars,
        youdaoTtsLimits.maxChunks,
        createTooLongYoudaoError,
    );

    const timeoutMs = options?.timeoutMs ?? youdaoTtsLimits.defaultTimeoutMs;
    const concurrency = Math.max(1, options?.concurrency ?? youdaoTtsLimits.defaultConcurrency);
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
                audioBuffers[currentIndex] = await fetchYoudaoChunk(
                    chunks[currentIndex]!,
                    spec,
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
        voice: spec.voice,
        source: 'youdao',
    };
}
