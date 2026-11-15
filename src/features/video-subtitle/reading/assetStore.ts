/**
 * @file src/features/video-subtitle/reading/assetStore.ts
 * 文件职责：为字幕读音引擎按需下载固定版本的纯数据文件，校验后持久保存并离线复用。
 * 主要内容：固定大小与 SHA-256 校验、逐文件可信缓存、来源回退、有界流读取与超时、有限并发及重复初始化合并。
 * 模块边界：仅处理本 feature 提供的不可变数据清单，不下载或执行代码，不接收字幕，也不修改共享模型下载层。
 */
import {sha256} from '@noble/hashes/sha256';

export interface ReadingAssetFile {name: string; size: number; sha256: string; urls: readonly string[]}
type AssetCache = Pick<Cache, 'match' | 'put' | 'delete'>;
export interface ReadingAssetStoreOptions {
    cacheName: string;
    files: readonly ReadingAssetFile[];
    sourceTimeoutMs?: number;
    totalTimeoutMs?: number;
    concurrency?: number;
    fetch?: typeof fetch;
    openCache?: () => Promise<AssetCache>;
}

function active(signal: AbortSignal): void {signal.throwIfAborted();}

/** 即使底层端口未及时响应 abort，调用者的等待仍由同一个有界信号结算。 */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    active(signal);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        Promise.resolve().then(() => {active(signal); return operation();}).then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

async function readVerified(response: Response, file: ReadingAssetFile, signal: AbortSignal, received: () => void = () => undefined): Promise<ArrayBuffer> {
    const body = response.body;
    if (response.status !== 200 || !body || Number(response.headers.get('Content-Length')) > file.size) {
        if (body) void body.cancel().catch(() => undefined);
        throw new Error(`Reading data response invalid: ${file.name}`);
    }
    const bytes = new Uint8Array(file.size), reader = body.getReader();
    let offset = 0;
    try {
        while (true) {
            active(signal);
            const {done, value} = await abortable(() => reader.read(), signal);
            if (done) break;
            if (offset + value.byteLength > file.size) throw new Error(`Reading data exceeds expected size: ${file.name}`);
            bytes.set(value, offset); offset += value.byteLength;
            if (value.byteLength) received();
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
    active(signal);
    if (offset !== file.size || Array.from(sha256(bytes), value => value.toString(16).padStart(2, '0')).join('') !== file.sha256) {
        throw new Error(`Reading data integrity mismatch: ${file.name}`);
    }
    return bytes.buffer;
}

export function createReadingAssetStore(options: ReadingAssetStoreOptions) {
    const {files, cacheName} = options;
    const sourceTimeoutMs = options.sourceTimeoutMs ?? 20_000;
    const totalTimeoutMs = options.totalTimeoutMs ?? 120_000;
    const concurrency = options.concurrency ?? 3;
    if (!cacheName || !Number.isFinite(sourceTimeoutMs) || sourceTimeoutMs <= 0 || !Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0
        || !Number.isInteger(concurrency) || concurrency < 1 || new Set(files.map(file => file.name)).size !== files.length
        || files.some(file => !/^[a-zA-Z0-9_.-]+$/u.test(file.name) || !Number.isSafeInteger(file.size) || file.size <= 0
            || !/^[a-f0-9]{64}$/u.test(file.sha256) || !file.urls.length
            || file.urls.some(url => !/^https:\/\/[^/@]+\//u.test(url)))) throw new Error('Invalid reading data manifest');
    const openCache = options.openCache ?? (() => caches.open(cacheName));
    const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    // 摘要属于缓存键；同名的未来版本不能命中旧内容。命中后仍核对实际字节，避免损坏缓存被视为就绪。
    const key = (file: ReadingAssetFile) => `${file.urls[0]}?fluent-read-verified=${file.sha256}`;
    let pending: Promise<ReadonlyMap<string, ArrayBuffer>> | undefined;

    const load = async (cache: AssetCache, file: ReadingAssetFile, signal: AbortSignal): Promise<ArrayBuffer> => {
        active(signal);
        const cached = await cache.match(key(file));
        if (cached) {
            try {return await readVerified(cached, file, signal);}
            catch {active(signal); await cache.delete(key(file));}
        }
        let failure: unknown;
        for (const url of file.urls) {
            active(signal);
            const source = new AbortController(), abort = () => source.abort(signal.reason);
            signal.addEventListener('abort', abort, {once: true});
            let timer: ReturnType<typeof setTimeout> | undefined;
            const arm = () => {
                clearTimeout(timer);
                timer = setTimeout(() => source.abort(new DOMException('Reading data download stalled', 'TimeoutError')), sourceTimeoutMs);
            };
            // 限制首包及后续相邻数据块之间的空闲；持续传输不受单文件二十秒硬截止限制，总预算仍由 run 管理。
            arm();
            try {
                const operation = async () => {
                    const response = await fetchData(url, {credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: source.signal});
                    const bytes = await readVerified(response, file, source.signal, arm);
                    active(signal); active(source.signal);
                    return bytes;
                };
                const bytes = await abortable(operation, source.signal);
                clearTimeout(timer);
                active(signal);
                await cache.put(key(file), new Response(bytes, {headers: {'Content-Length': String(file.size)}}));
                active(signal);
                return bytes;
            } catch (error) {active(signal); failure = error;}
            finally {clearTimeout(timer); signal.removeEventListener('abort', abort); source.abort();}
        }
        throw new Error(`Reading data sources unavailable: ${file.name}`, {cause: failure});
    };

    const run = async (): Promise<ReadonlyMap<string, ArrayBuffer>> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException('Reading data preparation timed out', 'TimeoutError')), totalTimeoutMs);
        const operation = async () => {
            const cache = await openCache(), result = new Map<string, ArrayBuffer>();
            let index = 0;
            const worker = async () => {
                while (index < files.length) {
                    active(controller.signal);
                    const file = files[index++];
                    result.set(file.name, await load(cache, file, controller.signal));
                }
            };
            await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, worker));
            return result;
        };
        try {return await abortable(operation, controller.signal);}
        finally {clearTimeout(timer); controller.abort();}
    };

    const ensure = (): Promise<ReadonlyMap<string, ArrayBuffer>> => {
        if (!pending) {
            const current = run();
            pending = current;
            // pending 非空时 ensure 只复用当前任务，结算回调是唯一释放入口。
            void current.then(() => {pending = undefined;}, () => {pending = undefined;});
        }
        return pending;
    };
    return {ensure, async get(name: string): Promise<ArrayBuffer> {
        if (!files.some(file => file.name === name)) throw new Error('Unknown reading data file');
        return (await ensure()).get(name)!;
    }};
}
