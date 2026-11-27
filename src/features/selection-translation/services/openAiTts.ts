/**
 * @file src/features/selection-translation/services/openAiTts.ts
 * 文件职责：实现 OpenAI 及兼容协议（含本地自托管 /v1/audio/speech 端点）的在线语音合成客户端，安全处理密钥、代理路径归一化、语速参数、超时控制与非敏感状态报错。
 * 主要内容：提供纯端点地址解析器 resolveOpenAiTtsUrl 与本地端点判定 isLocalOpenAiTtsEndpoint，校验非本地端点的密钥缺失并归类为不触发熔断的 unsupported 错误，经 runtimeFetch 发送 JSON 合成请求并校验音频正文，导出 synthesizeOpenAiTts。
 * 模块边界：本文件属于划词朗读在线合成服务层，只依赖 core/config/selectionTts 的语速与默认模型/音色规范和 platform/http 边界；不直接读取扩展配置、不记录密钥日志也不管理播放状态。
 */
import {
    DEFAULT_SELECTION_TTS_OPENAI_MODEL,
    DEFAULT_SELECTION_TTS_OPENAI_VOICE,
    normalizeSelectionTtsRate,
} from '@/src/core/config/selectionTts';
import {createHttpStatusError} from '@/src/platform/http/errors';
import {
    cancelUnreadResponseBody,
    createRuntimeAbortContext,
    runtimeFetch,
} from '@/src/platform/http/runtime';

export interface OpenAiTtsAudio {
    audio: ArrayBuffer;
    contentType: string;
    voice: string;
    source: 'openai';
}

export interface OpenAiTtsOptions {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly model?: string;
    readonly voice?: string;
    readonly rate?: number;
    readonly customHeaders?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
}

const DEFAULT_OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_OPENAI_TTS_TIMEOUT_MS = 15_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
    return Object.assign(new Error(message), {code: 'tts-openai-key-missing'});
}

function looksLikeHtmlOrJsonPayload(buffer: ArrayBuffer): boolean {
    const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 32))).trimStart().toLowerCase();
    return head.startsWith('<!doctype')
        || head.startsWith('<html')
        || head.startsWith('<?xml')
        || head.startsWith('{')
        || head.startsWith('[');
}

function isAcceptableAudioContentType(contentType: string): boolean {
    const normalized = contentType.split(';')[0]!.trim().toLowerCase();
    return !normalized
        || normalized.startsWith('audio/')
        || normalized === 'application/octet-stream';
}

/** 从官方默认地址、代理基址或已有 /v1/chat/completions 地址归一化出 /audio/speech 端点。 */
export function resolveOpenAiTtsUrl(baseUrl?: string): string {
    const trimmed = String(baseUrl ?? '').trim();
    if (!trimmed) return DEFAULT_OPENAI_TTS_URL;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error('OpenAI TTS 接口地址无效');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('OpenAI TTS 接口地址仅支持 HTTP/HTTPS 协议');
    }

    const cleanPath = parsed.pathname.replace(/\/+$/u, '');
    if (/\/audio\/speech$/iu.test(cleanPath)) {
        parsed.pathname = cleanPath;
    } else if (/\/(?:chat\/completions|completions|responses)$/iu.test(cleanPath)) {
        parsed.pathname = cleanPath.replace(/\/(?:chat\/completions|completions|responses)$/iu, '/audio/speech');
    } else if (/\/v\d+$/iu.test(cleanPath)) {
        parsed.pathname = `${cleanPath}/audio/speech`;
    } else if (!cleanPath) {
        parsed.pathname = '/v1/audio/speech';
    } else {
        parsed.pathname = `${cleanPath}/v1/audio/speech`;
    }
    return parsed.toString();
}

/** 判断端点是否指向本机自托管服务（localhost / 127.0.0.1 / ::1），允许无密钥调用。 */
export function isLocalOpenAiTtsEndpoint(url: string): boolean {
    try {
        return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
    } catch {
        return false;
    }
}

export async function synthesizeOpenAiTts(
    text: string,
    options: OpenAiTtsOptions = {},
    signal?: AbortSignal,
): Promise<OpenAiTtsAudio> {
    if (signal?.aborted) throw createAbortError();
    const trimmedText = text.trim();
    if (!trimmedText) throw new Error('OpenAI TTS 文本为空');

    const endpointUrl = resolveOpenAiTtsUrl(options.baseUrl);
    const apiKey = String(options.apiKey ?? '').trim();
    if (!apiKey && !isLocalOpenAiTtsEndpoint(endpointUrl)) {
        throw createUnsupportedError('OpenAI TTS 暂不支持无密钥调用，请先配置 API Key 或本地端点');
    }

    const model = String(options.model ?? '').trim() || DEFAULT_SELECTION_TTS_OPENAI_MODEL;
    const voice = String(options.voice ?? '').trim() || DEFAULT_SELECTION_TTS_OPENAI_VOICE;
    const speed = normalizeSelectionTtsRate(options.rate);
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TTS_TIMEOUT_MS;

    const headers: Record<string, string> = {};
    if (options.customHeaders) {
        for (const [key, value] of Object.entries(options.customHeaders)) {
            const cleanKey = key.trim();
            const cleanValue = value.trim();
            if (!cleanKey || !cleanValue) continue;
            headers[cleanKey] = cleanValue;
        }
    }
    headers['Content-Type'] = 'application/json';
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const response = await runtimeFetch(endpointUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                input: trimmedText,
                voice,
                speed,
                response_format: 'mp3',
            }),
            signal: abortContext.signal,
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, 'OpenAI TTS request failed');
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!isAcceptableAudioContentType(contentType)) {
            cancelUnreadResponseBody(response);
            throw new Error('OpenAI TTS returned non-audio response');
        }
        const audio = await response.arrayBuffer();
        if (audio.byteLength === 0) {
            throw new Error('OpenAI TTS returned empty audio');
        }
        if (looksLikeHtmlOrJsonPayload(audio)) {
            throw new Error('OpenAI TTS returned non-audio response');
        }
        return {
            audio,
            contentType: 'audio/mpeg',
            voice: `OpenAI · ${voice}`,
            source: 'openai',
        };
    } catch (error) {
        if (signal?.aborted) throw createAbortError();
        if (abortContext.didTimeout()) throw createTimeoutError('OpenAI TTS 请求超时');
        throw error;
    } finally {
        abortContext.cleanup();
    }
}
