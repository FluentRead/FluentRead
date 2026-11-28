/**
 * @file src/shared/onnx/wasmBinary.ts
 * 文件职责：为 ONNX Runtime 提供扩展内置原始 WASM 的加载及旧 gzip 资源的受控解压和短生命周期注入。
 * 主要内容：绑定静态 GPU/CPU runtime MJS/WASM 路径、限制加载重试，并在模型初始化结束后清空二进制引用。
 * 模块边界：只处理 ONNX WASM 资源，不决定模型、设备、缓存或 Worker 生命周期。
 */

declare const __FLUENTREAD_ONNX_WASM_VARIANT__: 'jspi' | 'asyncify' | undefined;

export type OnnxWasmVariant = 'jspi' | 'asyncify';

/** 按构建目标返回打包的 ONNX WASM 变体：Chrome/Edge/Firefox 使用体积更小且无栈改写开销的 JSPI，Safari 保留 Asyncify。 */
export function resolveOnnxWasmVariant(): OnnxWasmVariant {
    return typeof __FLUENTREAD_ONNX_WASM_VARIANT__ === 'string' && __FLUENTREAD_ONNX_WASM_VARIANT__ === 'asyncify'
        ? 'asyncify'
        : 'jspi';
}

export function resolveOnnxWasmAssetPaths(
    resolveUrl: (path: string) => string,
    options: {leadingSlash?: boolean; variant?: OnnxWasmVariant} = {},
): {mjs: string; wasm: string} {
    const variant = options.variant ?? resolveOnnxWasmVariant();
    const prefix = options.leadingSlash ? '/fluent-read-ai' : 'fluent-read-ai';
    return {
        mjs: resolveUrl(`${prefix}/ort-wasm-simd-threaded.${variant}.mjs`),
        wasm: resolveUrl(`${prefix}/ort-wasm-simd-threaded.${variant}.wasm`),
    };
}

export interface OnnxWasmBackend {
    numThreads?: number;
    proxy?: boolean;
    wasmPaths?: string | {mjs?: string | URL; wasm?: string | URL};
    wasmBinary?: ArrayBufferLike | Uint8Array;
}

export interface CompressedWasmLoadOptions {
    fetchImpl?: typeof fetch;
    maxAttempts?: number;
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ALLOWED_ATTEMPTS = 3;
const initializedBackends = new WeakSet<object>();
const backendQueues = new WeakMap<object, Promise<void>>();

function boundedAttempts(value: number | undefined): number {
    if (!Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
    return Math.min(MAX_ALLOWED_ATTEMPTS, Math.max(1, Math.floor(value!)));
}

function isWasmBinary(value: Uint8Array): boolean {
    return value.byteLength >= WASM_HEADER.length
        && WASM_HEADER.every((byte, index) => value[index] === byte);
}

function loadError(url: string, cause: unknown): Error {
    return new Error(`ONNX_WASM_BINARY_LOAD_FAILED:${url}`, {cause});
}

function nonRetryableError(message: string): Error & {retryable: false} {
    return Object.assign(new Error(message), {retryable: false as const});
}

function isNonRetryable(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as {retryable?: unknown}).retryable === false;
}

async function decompressResponse(response: Response, url: string): Promise<Uint8Array> {
    if (!response.ok) {
        const error = new Error(`HTTP_${response.status}`) as Error & {retryable?: boolean};
        error.retryable = response.status >= 500;
        throw error;
    }
    if (url.split(/[?#]/, 1)[0]!.endsWith('.wasm')) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!isWasmBinary(bytes)) throw nonRetryableError(`ONNX_WASM_BINARY_INVALID:${url}`);
        return bytes;
    }
    if (typeof DecompressionStream === 'undefined') throw nonRetryableError('ONNX_WASM_DECOMPRESSION_UNSUPPORTED');
    if (!response.body) throw nonRetryableError('ONNX_WASM_BINARY_BODY_MISSING');
    let bytes: Uint8Array;
    try {
        const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        throw nonRetryableError(`ONNX_WASM_BINARY_DECOMPRESSION_FAILED:${url}`);
    }
    if (!isWasmBinary(bytes)) throw nonRetryableError(`ONNX_WASM_BINARY_INVALID:${url}`);
    return bytes;
}

/** 读取扩展内置原始或 gzip WASM；默认尝试两次、最多三次，损坏资源不重试。 */
export async function loadCompressedWasmBinary(
    url: string,
    options: CompressedWasmLoadOptions = {},
): Promise<Uint8Array> {
    const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    const attempts = boundedAttempts(options.maxAttempts);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetchImpl(url, {cache: 'no-store'});
            return await decompressResponse(response, url);
        } catch (error) {
            lastError = error;
            if (isNonRetryable(error)) break;
        }
    }
    throw loadError(url, lastError);
}

export function configureOnnxWasmBackend(
    backend: OnnxWasmBackend,
    paths: {mjs: string; wasm: string},
): void {
    backend.proxy = false;
    backend.wasmPaths = {mjs: paths.mjs, wasm: paths.wasm};
}

/** 仅在一次初始化调用期间挂载解压结果，成功或失败后都释放二进制引用。 */
export async function withCompressedWasmBinary<T>(
    backend: OnnxWasmBackend,
    url: string,
    initialize: () => Promise<T>,
    options?: CompressedWasmLoadOptions,
): Promise<T> {
    const previous = backendQueues.get(backend) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    backendQueues.set(backend, queued);
    await previous;

    try {
        if (initializedBackends.has(backend)) return await initialize();
        backend.wasmBinary = await loadCompressedWasmBinary(url, options);
        const result = await initialize();
        initializedBackends.add(backend);
        return result;
    } finally {
        try {
            backend.wasmBinary = undefined;
        } finally {
            // 清理属性失败也必须释放队列，否则后续初始化会永久等待。
            release();
            if (backendQueues.get(backend) === queued) backendQueues.delete(backend);
        }
    }
}
