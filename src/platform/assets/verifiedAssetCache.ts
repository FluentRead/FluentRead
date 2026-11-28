/**
 * @file src/platform/assets/verifiedAssetCache.ts
 * 文件职责：为扩展按需下载的固定版本纯数据资产提供统一的流式体积限制、SHA-256 校验、多镜像故障转移与 CacheStorage 持久化。
 * 主要内容：支持缓存读取与损坏自愈、同资产并发下载去重、逐源超时中断、会话优选镜像记忆，以及可注入测试依赖的通用读取端口。
 * 模块边界：本文件属于 platform 层，只处理固定哈希纯数据（JSON、字体、字形映射、词典等），绝不加载或执行远程 JavaScript 或 WASM。
 */

import {orderMirrorUrls, rememberPreferredMirrorOrigin} from '@/src/core/assets/mirrors';
import {cancelResponseReader, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';

export interface VerifiedAssetSpec {
    readonly id: string;
    readonly cacheName: string;
    readonly cacheKey: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentType: string;
    readonly urls: readonly string[];
    readonly timeoutMs?: number;
}

export interface VerifiedAssetCacheDependencies {
    readonly fetch?: typeof fetch;
    readonly openCache?: (cacheName: string) => Promise<Pick<Cache, 'match' | 'put' | 'delete'>>;
    readonly digest?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
}

const DEFAULT_SOURCE_TIMEOUT_MS = 15_000;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const inFlightDownloads = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

function assertSafeAssetSpec(spec: VerifiedAssetSpec): void {
    if (!spec.id || !spec.cacheName || !spec.cacheKey
        || !Number.isSafeInteger(spec.bytes) || spec.bytes <= 0
        || !HEX_SHA256_PATTERN.test(spec.sha256)
        || spec.urls.length === 0) {
        throw new Error(`Invalid verified asset spec: ${spec.id || 'unknown'}`);
    }
    for (const url of spec.urls) {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`Invalid verified asset mirror URL: ${spec.id}`);
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            throw new Error(`Unsafe verified asset mirror URL: ${spec.id}`);
        }
    }
}

export function canUseVerifiedAssetCache(): boolean {
    return typeof globalThis.caches?.open === 'function'
        && typeof globalThis.crypto?.subtle?.digest === 'function';
}

function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return Promise.resolve().then(operation);
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        void Promise.resolve()
            .then(() => {
                signal.throwIfAborted();
                return operation();
            })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

async function computeSha256Hex(
    bytes: Uint8Array<ArrayBuffer>,
    digest: (data: ArrayBuffer) => Promise<ArrayBuffer>,
    signal?: AbortSignal,
): Promise<string> {
    const hashBuffer = await withAbort(() => digest(bytes.buffer), signal);
    return Array.from(new Uint8Array(hashBuffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readBoundedAndVerified(
    response: Response,
    spec: VerifiedAssetSpec,
    digest: (data: ArrayBuffer) => Promise<ArrayBuffer>,
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    const contentType = response.headers?.get?.('Content-Type') || '';
    if (!response.ok || !response.body || /text\/html/iu.test(contentType)) {
        cancelUnreadResponseBody(response);
        throw new Error(`Asset ${spec.id} unavailable: HTTP ${response.status}`);
    }
    const contentEncoding = response.headers?.get?.('Content-Encoding');
    const declaredLength = Number(response.headers?.get?.('Content-Length'));
    if (!contentEncoding && Number.isFinite(declaredLength) && declaredLength > spec.bytes) {
        cancelUnreadResponseBody(response);
        throw new Error(`Asset ${spec.id} exceeds expected size`);
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(spec.bytes);
    let offset = 0;
    try {
        while (true) {
            signal?.throwIfAborted();
            const chunk = await withAbort(() => reader.read(), signal);
            if (chunk.done) break;
            if (offset + chunk.value.byteLength > spec.bytes) {
                throw new Error(`Asset ${spec.id} exceeds expected size`);
            }
            bytes.set(chunk.value, offset);
            offset += chunk.value.byteLength;
        }
    } finally {
        cancelResponseReader(reader);
    }
    if (offset !== spec.bytes) {
        throw new Error(`Asset ${spec.id} response incomplete`);
    }
    const actualSha256 = await computeSha256Hex(bytes, digest, signal);
    if (actualSha256 !== spec.sha256) {
        throw new Error(`Asset ${spec.id} integrity mismatch`);
    }
    signal?.throwIfAborted();
    return bytes;
}

/** 仅读取经过字节长度与 SHA-256 校验的本地缓存副本；损坏条目会自动清除。 */
export async function readVerifiedCachedAsset(
    spec: VerifiedAssetSpec,
    deps: VerifiedAssetCacheDependencies = {},
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
    assertSafeAssetSpec(spec);
    const openCache = deps.openCache ?? (typeof globalThis.caches?.open === 'function'
        ? (name: string) => globalThis.caches.open(name)
        : undefined);
    const digest = deps.digest ?? (typeof globalThis.crypto?.subtle?.digest === 'function'
        ? (data: ArrayBuffer) => globalThis.crypto.subtle.digest('SHA-256', data)
        : undefined);
    if (!openCache || !digest) return null;

    let cache: Pick<Cache, 'match' | 'put' | 'delete'>;
    try {
        cache = await withAbort(() => openCache(spec.cacheName), signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
    let response: Response | undefined;
    try {
        response = await withAbort(() => cache.match(spec.cacheKey), signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
    if (!response) return null;
    try {
        return await readBoundedAndVerified(response, spec, digest, signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        await cache.delete(spec.cacheKey).catch(() => undefined);
        return null;
    }
}

/** 直接按国内/海外多镜像顺序下载固定版本纯数据并校验后持久化，供调用方已检查缓存或自行管理去重时使用。 */
export async function downloadVerifiedAsset(
    spec: VerifiedAssetSpec,
    deps: VerifiedAssetCacheDependencies = {},
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    assertSafeAssetSpec(spec);
    signal?.throwIfAborted();

    const digest = deps.digest ?? (typeof globalThis.crypto?.subtle?.digest === 'function'
        ? (data: ArrayBuffer) => globalThis.crypto.subtle.digest('SHA-256', data)
        : undefined);
    if (!digest) throw new Error(`Asset ${spec.id} crypto digest unavailable`);

    const fetchImpl = deps.fetch ?? runtimeFetch;
    const openCache = deps.openCache ?? (typeof globalThis.caches?.open === 'function'
        ? (name: string) => globalThis.caches.open(name)
        : undefined);

    const timeoutMs = spec.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    let lastError: unknown;
    for (const url of orderMirrorUrls(spec.urls)) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(() => controller.abort(new DOMException(`Asset ${spec.id} timeout`, 'TimeoutError')), timeoutMs);
        try {
            const response = await withAbort(() => fetchImpl(url, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: 'no-store',
                signal: controller.signal,
            }), controller.signal);
            const bytes = await readBoundedAndVerified(response, spec, digest, controller.signal);
            rememberPreferredMirrorOrigin(url);
            if (openCache) {
                try {
                    const cache = await openCache(spec.cacheName);
                    await cache.put(spec.cacheKey, new Response(bytes, {
                        headers: {
                            'Content-Type': spec.contentType,
                            'Content-Length': String(spec.bytes),
                        },
                    }));
                } catch {
                    // 持久化失败不影响本次已校验数据的使用。
                }
            }
            return bytes;
        } catch (error) {
            if (signal?.aborted) throw error;
            lastError = error;
        } finally {
            clearTimeout(timer);
            controller.abort();
            signal?.removeEventListener('abort', abort);
        }
    }
    throw new Error(`Asset ${spec.id} sources unavailable`, {cause: lastError});
}

/** 读取缓存或按国内/海外多镜像顺序下载固定版本纯数据并校验后持久化；同一资产的并发下载自动合并。 */
export async function fetchVerifiedAsset(
    spec: VerifiedAssetSpec,
    deps: VerifiedAssetCacheDependencies = {},
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    assertSafeAssetSpec(spec);
    signal?.throwIfAborted();
    const cached = await readVerifiedCachedAsset(spec, deps, signal);
    if (cached) return cached;

    // 仅在默认依赖且无私有取消信号时跨调用方共享在途请求，避免自定义 mock/取消信号互相干扰。
    const canDeduplicate = !deps.fetch && !deps.openCache && !deps.digest && !signal;
    if (!canDeduplicate) return downloadVerifiedAsset(spec, deps, signal);

    const dedupeKey = `${spec.cacheName}::${spec.cacheKey}`;
    const existing = inFlightDownloads.get(dedupeKey);
    if (existing) return existing;
    const pending = downloadVerifiedAsset(spec, deps, signal).finally(() => {
        inFlightDownloads.delete(dedupeKey);
    });
    inFlightDownloads.set(dedupeKey, pending);
    return pending;
}
