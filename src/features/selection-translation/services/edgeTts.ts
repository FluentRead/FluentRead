/**
 * @file src/features/selection-translation/services/edgeTts.ts
 * 文件职责：实现 Microsoft Edge 在线语音合成协议客户端，负责 HMAC-SHA256 密钥复用、并发合并与会话级缓存的短期 endpoint token 获取、有界超时与退避重试、并发 2 分段 SSML 合成及音频拼接。
 * 主要内容：封装 HMAC 密钥缓存、single-flight token 获取与 401/403 单次刷新、按 classifyTtsError 区分瞬态限流/服务异常与单音色失效、结构化 HTTP 状态错误构造以及 resetEdgeTtsStateForTests，导出 synthesizeEdgeTts 与策略层相关符号。
 * 模块边界：该服务只负责 Edge 远程合成，不播放 Audio、不处理 tab 路由也不读取用户设置；语言与 SSML 策略来自 edgeTtsPolicy，错误分类与退避来自 core/tts/backoff，播放编排由后台 handler 与 Offscreen 适配器承担。
 */
/**
 * FluentRead 的轻量 Edge TTS 适配器。
 *
 * 只在扩展后台调用 Microsoft 的公开 consumer TTS endpoint。音色按用户
 * 选择和当前语言形成有序候选链；播放端优先交给扩展 Offscreen 文档，
 * 避免把 Blob 音频交给宿主网页的 CSP。
 */

import {
    classifyTtsError,
    computeTtsBackoffMs,
    type TtsCircuitBreaker,
} from '@/src/core/tts/backoff';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {
    cancelUnreadResponseBody,
    createRuntimeAbortContext,
    runtimeFetch,
} from '@/src/platform/http/runtime';
import {
    buildEdgeTtsSsml,
    concatEdgeTtsAudio,
    edgeTtsTokenExpiry,
    edgeTtsVoiceCandidatesForLanguage,
    formatEdgeTtsRate,
    splitEdgeTtsText,
} from './edgeTtsPolicy';

export interface EdgeTtsAudio {
    audio: ArrayBuffer;
    contentType: string;
    voice: string;
    source: 'edge';
}

export interface EdgeTtsSessionStorage {
    get(key: string): Promise<Record<string, unknown>> | Record<string, unknown>;
    set(items: Record<string, unknown>): Promise<void> | void;
    remove?(key: string): Promise<void> | void;
}

export interface SynthesizeEdgeTtsOptions {
    readonly rate?: number;
    readonly breaker?: Pick<TtsCircuitBreaker, 'orderVoices' | 'recordVoiceFailure'>;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    readonly sessionStorage?: EdgeTtsSessionStorage | null;
    readonly tokenTimeoutMs?: number;
    readonly chunkTimeoutMs?: number;
}

const SIGNATURE_SECRET_BASE64 = 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==';
const SIGNATURE_APP_ID = 'MSTranslatorAndroidApp';
const ENDPOINT_URL = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0';
const SESSION_TOKEN_STORAGE_KEY = 'fluentReadEdgeTtsEndpointToken';
const TOKEN_REFRESH_MARGIN_MS = 3 * 60 * 1_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 8_000;
const DEFAULT_CHUNK_TIMEOUT_MS = 15_000;
const CHUNK_CONCURRENCY = 2;
const VALID_REGION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/iu;

interface EndpointToken {
    region: string;
    token: string;
    expiresAt: number;
}

let endpointToken: EndpointToken | null = null;
let pendingTokenPromise: Promise<EndpointToken> | null = null;
let cachedHmacKeyPromise: Promise<CryptoKey> | null = null;

/** 重置模块内的 token、并发合并与 HMAC 密钥缓存，仅供单元测试隔离状态。 */
export function resetEdgeTtsStateForTests(): void {
    endpointToken = null;
    pendingTokenPromise = null;
    cachedHmacKeyPromise = null;
}

function createAbortError(): Error {
    try {
        return new DOMException('语音合成已取消', 'AbortError');
    } catch {
        const error = new Error('语音合成已取消');
        error.name = 'AbortError';
        return error;
    }
}

function createTimeoutError(message: string): Error {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function randomId(): string {
    return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/gu, '');
}

function getHmacKey(): Promise<CryptoKey> {
    if (!cachedHmacKeyPromise) {
        const key = base64ToBytes(SIGNATURE_SECRET_BASE64);
        const keyBuffer = new ArrayBuffer(key.byteLength);
        new Uint8Array(keyBuffer).set(key);
        cachedHmacKeyPromise = crypto.subtle
            .importKey('raw', keyBuffer, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
            .catch((error) => {
                cachedHmacKeyPromise = null;
                throw error;
            });
    }
    return cachedHmacKeyPromise;
}

async function createSignature(): Promise<string> {
    const formattedDate = `${new Date().toUTCString().replace('GMT', '').trim().toLowerCase()} GMT`;
    const encodedUrl = encodeURIComponent(ENDPOINT_URL.split('://')[1]!);
    const requestId = randomId();
    const payload = `${SIGNATURE_APP_ID}${encodedUrl}${formattedDate}${requestId}`.toLowerCase();
    const cryptoKey = await getHmacKey();
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload));
    return `${SIGNATURE_APP_ID}::${bytesToBase64(new Uint8Array(signature))}::${formattedDate}::${requestId}`;
}

function resolveSessionStorage(override?: EdgeTtsSessionStorage | null): EdgeTtsSessionStorage | null {
    if (override !== undefined) return override;
    const candidate = (globalThis as {chrome?: {storage?: {session?: EdgeTtsSessionStorage}}}).chrome?.storage?.session;
    return candidate && typeof candidate.get === 'function' && typeof candidate.set === 'function'
        ? candidate
        : null;
}

function isFreshEndpointToken(value: unknown, now = Date.now()): value is EndpointToken {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record.token === 'string' && Boolean(record.token.trim())
        && typeof record.region === 'string' && VALID_REGION_PATTERN.test(record.region)
        && typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        && now < record.expiresAt - TOKEN_REFRESH_MARGIN_MS;
}

async function readCachedSessionToken(storage: EdgeTtsSessionStorage | null): Promise<EndpointToken | null> {
    if (!storage) return null;
    try {
        const stored = await storage.get(SESSION_TOKEN_STORAGE_KEY);
        const candidate = stored?.[SESSION_TOKEN_STORAGE_KEY];
        return isFreshEndpointToken(candidate) ? candidate : null;
    } catch {
        return null;
    }
}

async function writeCachedSessionToken(storage: EdgeTtsSessionStorage | null, token: EndpointToken): Promise<void> {
    if (!storage) return;
    try {
        await storage.set({[SESSION_TOKEN_STORAGE_KEY]: token});
    } catch {
        // MV3 session storage 不可用或配额受限时不影响内存态合成。
    }
}

async function invalidateEndpointToken(failedToken: string, storage: EdgeTtsSessionStorage | null): Promise<void> {
    const matched = endpointToken === null || endpointToken.token === failedToken;
    if (endpointToken?.token === failedToken) {
        endpointToken = null;
    }
    if (!matched || !storage || typeof storage.remove !== 'function') return;
    try {
        await storage.remove(SESSION_TOKEN_STORAGE_KEY);
    } catch {
        // 清理会话缓存失败不阻断强制刷新 token。
    }
}

/** 在等待共享 Promise 期间独立响应单个调用方的 AbortSignal，而不中断其他并发调用方。 */
function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };
        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
        };
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

async function waitWithAbort(
    delayMs: number,
    signal?: AbortSignal,
    customSleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
    throwIfAborted(signal);
    if (customSleep) {
        await customSleep(delayMs, signal);
        throwIfAborted(signal);
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, {once: true});
    });
}

async function fetchEndpointToken(
    timeoutMs: number,
    storage: EdgeTtsSessionStorage | null,
): Promise<EndpointToken> {
    const signature = await createSignature();
    const abortContext = createRuntimeAbortContext(timeoutMs);
    try {
        const response = await runtimeFetch(ENDPOINT_URL, {
            method: 'POST',
            headers: {
                'Accept-Language': 'zh-Hans',
                'X-ClientVersion': '4.0.530a 5fe1dc6c',
                'X-UserId': '0f04d16a175c411e',
                'X-HomeGeographicRegion': 'zh-Hans-CN',
                'X-ClientTraceId': randomId(),
                'X-MT-Signature': signature,
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: '',
            signal: abortContext.signal,
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, 'Edge TTS endpoint failed');
        }
        const payload = await readJsonResponse<{t?: unknown; r?: unknown} | null>(
            response,
            'Edge TTS endpoint returned invalid JSON',
            abortContext.signal,
        );
        // region 只能形成 Microsoft 的单个区域子域；异常 JSON 不得进入缓存，
        // 更不能把 endpoint token 发送到由斜杠等字符改写的主机。
        if (!payload || typeof payload.t !== 'string' || !payload.t.trim()
            || typeof payload.r !== 'string' || !VALID_REGION_PATTERN.test(payload.r)) {
            throw new Error('Edge TTS endpoint returned an invalid token');
        }
        const fresh: EndpointToken = {
            token: payload.t,
            region: payload.r,
            expiresAt: edgeTtsTokenExpiry(payload.t),
        };
        endpointToken = fresh;
        await writeCachedSessionToken(storage, fresh);
        return fresh;
    } catch (error) {
        if (abortContext.didTimeout()) throw createTimeoutError('Edge TTS endpoint 请求超时');
        throw error;
    } finally {
        abortContext.cleanup();
    }
}

async function getEndpointToken(
    signal?: AbortSignal,
    options?: SynthesizeEdgeTtsOptions,
): Promise<EndpointToken> {
    throwIfAborted(signal);
    if (isFreshEndpointToken(endpointToken)) return endpointToken;

    const storage = resolveSessionStorage(options?.sessionStorage);
    const fromSession = await awaitWithSignal(readCachedSessionToken(storage), signal);
    if (fromSession) {
        endpointToken = fromSession;
        return fromSession;
    }

    if (!pendingTokenPromise) {
        const timeoutMs = options?.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
        pendingTokenPromise = fetchEndpointToken(timeoutMs, storage).finally(() => {
            pendingTokenPromise = null;
        });
        // 防止所有调用方提前取消后，共享 token 请求失败产生未处理拒绝。
        void pendingTokenPromise.catch(() => undefined);
    }
    return awaitWithSignal(pendingTokenPromise, signal);
}

function isAcceptableEdgeAudioContentType(contentType: string): boolean {
    const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    return !normalized || normalized.startsWith('audio/') || normalized === 'application/octet-stream';
}

function looksLikeEdgeNonAudioPayload(buffer: ArrayBuffer): boolean {
    const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 32))).trimStart().toLowerCase();
    return head.startsWith('<!doctype')
        || head.startsWith('<html')
        || head.startsWith('<?xml')
        || head.startsWith('{')
        || head.startsWith('[');
}

async function synthesizeChunk(
    chunk: string,
    voice: string,
    endpoint: EndpointToken,
    rate: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
): Promise<ArrayBuffer> {
    throwIfAborted(signal);
    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const response = await runtimeFetch(`https://${endpoint.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
            method: 'POST',
            headers: {
                Authorization: endpoint.token,
                'Content-Type': 'application/ssml+xml',
                'User-Agent': USER_AGENT,
                'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
            },
            body: buildEdgeTtsSsml(chunk, voice, rate),
            signal: abortContext.signal,
        });
        if (!response.ok) {
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, `Edge TTS synthesis failed (${voice})`);
        }
        const contentType = response.headers?.get('content-type') ?? '';
        if (!isAcceptableEdgeAudioContentType(contentType)) {
            cancelUnreadResponseBody(response);
            throw new Error(`Edge TTS synthesis returned non-audio response (${voice})`);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) {
            throw new Error(`Edge TTS synthesis returned empty audio (${voice})`);
        }
        if (looksLikeEdgeNonAudioPayload(buffer)) {
            throw new Error(`Edge TTS synthesis returned non-audio response (${voice})`);
        }
        return buffer;
    } catch (error) {
        if (signal?.aborted) throw createAbortError();
        if (abortContext.didTimeout()) throw createTimeoutError(`Edge TTS 合成请求超时 (${voice})`);
        throw error;
    } finally {
        abortContext.cleanup();
    }
}

async function synthesizeWithVoice(
    voice: string,
    endpoint: EndpointToken,
    chunks: readonly string[],
    rate: string,
    signal?: AbortSignal,
    options?: SynthesizeEdgeTtsOptions,
): Promise<EdgeTtsAudio> {
    const timeoutMs = options?.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
    const audioBuffers = new Array<ArrayBuffer>(chunks.length);
    const batchController = new AbortController();
    const onCallerAbort = () => batchController.abort(signal?.reason);
    if (signal?.aborted) throw createAbortError();
    signal?.addEventListener('abort', onCallerAbort, {once: true});

    let nextIndex = 0;
    let firstError: unknown;
    let hasError = false;
    const workerCount = Math.min(CHUNK_CONCURRENCY, chunks.length);

    const runWorker = async (): Promise<void> => {
        while (!hasError) {
            if (batchController.signal.aborted) return;
            const currentIndex = nextIndex++;
            if (currentIndex >= chunks.length) return;
            try {
                audioBuffers[currentIndex] = await synthesizeChunk(
                    chunks[currentIndex]!,
                    voice,
                    endpoint,
                    rate,
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
        voice,
        source: 'edge',
    };
}

function isStopLoopTransientKind(kind: ReturnType<typeof classifyTtsError>['kind']): boolean {
    return kind === 'rate-limit' || kind === 'server' || kind === 'timeout' || kind === 'network';
}

export async function synthesizeEdgeTts(
    text: string,
    language: string,
    preferredVoices: unknown = [],
    signal?: AbortSignal,
    options?: SynthesizeEdgeTtsOptions,
): Promise<EdgeTtsAudio> {
    throwIfAborted(signal);
    if (!text.trim()) throw new Error('Edge TTS 文本为空');
    const rawVoices = edgeTtsVoiceCandidatesForLanguage(language, preferredVoices);
    if (rawVoices.length === 0) throw new Error('Edge TTS voice is unavailable for this language');
    const voices = options?.breaker ? options.breaker.orderVoices(rawVoices) : rawVoices;

    const chunks = splitEdgeTtsText(text);
    const rate = formatEdgeTtsRate(options?.rate);
    const storage = resolveSessionStorage(options?.sessionStorage);
    let endpoint = await getEndpointToken(signal, options);
    let tokenRefreshed = false;
    let transientRetried = false;
    const failures: string[] = [];

    for (let index = 0; index < voices.length; index++) {
        const voice = voices[index]!;
        while (true) {
            try {
                return await synthesizeWithVoice(voice, endpoint, chunks, rate, signal, options);
            } catch (error) {
                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw createAbortError();
                }
                const classified = classifyTtsError(error);
                if (classified.kind === 'auth') {
                    if (!tokenRefreshed) {
                        tokenRefreshed = true;
                        await invalidateEndpointToken(endpoint.token, storage);
                        endpoint = await getEndpointToken(signal, options);
                        continue;
                    }
                    throw error;
                }
                if (isStopLoopTransientKind(classified.kind)) {
                    if (!transientRetried) {
                        transientRetried = true;
                        const delayMs = computeTtsBackoffMs(
                            0,
                            classified.kind,
                            classified.retryAfterMs,
                            options?.random,
                        );
                        if (delayMs > 0) await waitWithAbort(delayMs, signal, options?.sleep);
                        // 若仍有下一个候选音色，本次唯一有界重试切到下一个音色以绕过单音色分片抖动；
                        // 若重试后仍遇到瞬态错误，则立即停止遍历剩余音色并抛出。
                        if (index + 1 < voices.length) break;
                        continue;
                    }
                    throw error;
                }
                if (classified.tripsVoice) {
                    options?.breaker?.recordVoiceFailure(voice);
                }
                failures.push(`${voice}: ${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }
    }

    throw new Error(`Edge TTS 音色均不可用（${failures.join('；')}）`);
}
