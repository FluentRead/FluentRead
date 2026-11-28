/**
 * @file src/features/local-translation/offscreen/artifactStore.ts
 *
 * 文件职责：保存本地翻译模型的分块文件并执行可恢复的多源下载。
 * 主要内容：预索引工件查表、流式边下边算 SHA-256 校验与断点续传盘面复验、有界并发分块读写与字节计数、来源回退和离线读取，下载内存有明确上限；拒绝响应立即释放未读正文，清理不阻塞镜像回退。
 * 模块边界：只操作专属 Cache Storage，不保存页面状态、不初始化推理引擎，也不向下载源发送翻译文本。
 */
import {huggingFaceDownloadOrigins} from '@/src/platform/http/modelDownloads';
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';
import {sha256} from '@noble/hashes/sha256';
import frozenArtifacts from '@/src/core/config/localTranslationArtifacts.json';
import {getLocalTranslationModel} from '@/src/core/config/localTranslation';

export interface TranslationArtifact {
    repo: string;
    revision: string;
    path: string;
    size: number;
    sha256: string;
}
export const LOCAL_MODEL_CACHE = 'fluent-read-local-models-v2';
export const MODEL_CHUNK_SIZE = 4 * 1024 * 1024;
const CACHE_BATCH_CONCURRENCY = 16;
const OFFICIAL_ORIGIN = 'https://huggingface.co';
const metadata = frozenArtifacts as Record<string, {revision: string; files: Omit<TranslationArtifact, 'repo' | 'revision'>[]}>;

export function getTranslationArtifacts(model: unknown): TranslationArtifact[] {
    return getLocalTranslationModel(model).repositories.flatMap((repo) => {
        const entry = metadata[repo];
        return entry ? entry.files.map((file) => ({...file, repo, revision: entry.revision})) : [];
    });
}

export function artifactUrl(file: TranslationArtifact): string {
    return `${OFFICIAL_ORIGIN}/${file.repo}/resolve/${file.revision}/${file.path}`;
}

const artifactsByUrl = new Map<string, TranslationArtifact>();
for (const [repo, entry] of Object.entries(metadata)) {
    for (const file of entry.files) {
        const artifact: TranslationArtifact = {...file, repo, revision: entry.revision};
        artifactsByUrl.set(artifactUrl(artifact), artifact);
    }
}

function chunkKey(file: TranslationArtifact, index: number): string {
    return `${artifactUrl(file)}?fluent-read-part=${index}`;
}
function receiptKey(file: TranslationArtifact): string {
    return `${artifactUrl(file)}?fluent-read-verified=${file.sha256}`;
}
function abortIfNeeded(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Download paused', 'AbortError');
}
function formatSha256(digest: ReturnType<typeof sha256.create>): string {
    return Array.from(digest.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
}
async function allChunksPresent(cache: Cache, file: TranslationArtifact): Promise<boolean> {
    // 单次列举该文件的分块键，不读模型内容，也不遍历其他模型。
    const keys = new Set((await cache.keys(artifactUrl(file), {ignoreSearch: true})).map(request => request.url));
    for (let index = 0; index < Math.ceil(file.size / MODEL_CHUNK_SIZE); index++) {
        if (!keys.has(chunkKey(file, index))) return false;
    }
    return true;
}

/** 收据只能证明写入时校验成功；分块后来被清理时必须重新下载。 */
export async function artifactComplete(file: TranslationArtifact): Promise<boolean> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const receipt = await cache.match(receiptKey(file));
    if (!receipt) return false;
    cancelUnreadResponseBody(receipt);
    return allChunksPresent(cache, file);
}

export async function artifactDownloadedBytes(file: TranslationArtifact): Promise<number> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const chunkCount = Math.ceil(file.size / MODEL_CHUNK_SIZE);
    const keys = new Set((await cache.keys(artifactUrl(file), {ignoreSearch: true})).map(request => request.url));
    let contiguous = 0;
    while (contiguous < chunkCount && keys.has(chunkKey(file, contiguous))) contiguous++;
    if (contiguous === 0) return 0;
    let bytes = 0;
    for (let start = 0; start < contiguous; start += CACHE_BATCH_CONCURRENCY) {
        const end = Math.min(start + CACHE_BATCH_CONCURRENCY, contiguous);
        const settled = await Promise.allSettled(
            Array.from({length: end - start}, (_, offset) => cache.match(chunkKey(file, start + offset))),
        );
        let firstRejection: unknown;
        let hasRejection = false;
        const parts: Array<Response | undefined> = [];
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                if (result.value) cancelUnreadResponseBody(result.value);
                parts.push(result.value);
            } else if (!hasRejection) {
                hasRejection = true;
                firstRejection = result.reason;
            }
        }
        if (hasRejection) throw firstRejection;
        for (const part of parts) {
            const expected = Math.min(MODEL_CHUNK_SIZE, file.size - bytes);
            if (!part || Number(part.headers.get('Content-Length')) !== expected) return bytes;
            bytes += expected;
        }
    }
    return bytes;
}

/** 撤销单文件收据但保留全部分块，供显式重试重新计算哈希。 */
export async function invalidateTranslationArtifactReceipt(file: TranslationArtifact): Promise<void> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    await cache.delete(receiptKey(file));
}

export async function removeTranslationArtifact(file: TranslationArtifact): Promise<void> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    await cache.delete(receiptKey(file));
    for (let index = 0; index < Math.ceil(file.size / MODEL_CHUNK_SIZE); index++) {
        await cache.delete(chunkKey(file, index));
    }
}

async function readArtifactChunks(cache: Cache, file: TranslationArtifact): Promise<Blob> {
    const chunkCount = Math.ceil(file.size / MODEL_CHUNK_SIZE);
    const parts = new Array<Blob>(chunkCount);
    for (let start = 0; start < chunkCount; start += CACHE_BATCH_CONCURRENCY) {
        const end = Math.min(start + CACHE_BATCH_CONCURRENCY, chunkCount);
        const batch = await Promise.all(
            Array.from({length: end - start}, async (_, offset) => {
                const part = await cache.match(chunkKey(file, start + offset));
                if (!part) throw new Error('LOCAL_TRANSLATION_NOT_DOWNLOADED');
                return part.blob();
            }),
        );
        for (let offset = 0; offset < batch.length; offset++) parts[start + offset] = batch[offset]!;
    }
    const blob = new Blob(parts, {type: file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream'});
    if (blob.size !== file.size) throw new Error('LOCAL_TRANSLATION_INTEGRITY');
    return blob;
}

/** Reconstruct a file from disk-backed blobs, avoiding a model-sized JS buffer. */
export async function translationArtifactBlob(file: TranslationArtifact): Promise<Blob> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const receipt = await cache.match(receiptKey(file));
    if (!receipt) throw new Error('LOCAL_TRANSLATION_NOT_DOWNLOADED');
    cancelUnreadResponseBody(receipt);
    return readArtifactChunks(cache, file);
}

/** Transformers.js can only read our verified files; it cannot download on inference. */
export async function matchTranslationArtifact(request: string | Request): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request.url;
    const artifact = artifactsByUrl.get(key);
    if (!artifact) return undefined;
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const receipt = await cache.match(receiptKey(artifact));
    if (!receipt) return undefined;
    cancelUnreadResponseBody(receipt);
    return new Response(await readArtifactChunks(cache, artifact), {headers: {'Content-Length': String(artifact.size)}});
}

async function writeVerifiedReceipt(cache: Cache, file: TranslationArtifact, signal: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    await cache.put(receiptKey(file), new Response(JSON.stringify({size: file.size, sha256: file.sha256})));
    abortIfNeeded(signal);
}

async function verifyArtifact(file: TranslationArtifact, signal: AbortSignal): Promise<void> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const digest = sha256.create();
    for (let index = 0; index < Math.ceil(file.size / MODEL_CHUNK_SIZE); index++) {
        abortIfNeeded(signal);
        const part = await cache.match(chunkKey(file, index));
        if (!part) throw new Error('LOCAL_TRANSLATION_INTEGRITY');
        digest.update(new Uint8Array(await part.arrayBuffer()));
    }
    if (formatSha256(digest) !== file.sha256) {
        await removeTranslationArtifact(file);
        throw new Error('LOCAL_TRANSLATION_INTEGRITY');
    }
    await writeVerifiedReceipt(cache, file, signal);
}

async function verifyStreamingArtifact(
    cache: Cache,
    file: TranslationArtifact,
    digest: ReturnType<typeof sha256.create>,
    signal: AbortSignal,
): Promise<void> {
    abortIfNeeded(signal);
    if (formatSha256(digest) !== file.sha256 || !await allChunksPresent(cache, file)) {
        await removeTranslationArtifact(file);
        throw new Error('LOCAL_TRANSLATION_INTEGRITY');
    }
    await writeVerifiedReceipt(cache, file, signal);
}

async function receiveArtifact(
    file: TranslationArtifact,
    origin: string,
    signal: AbortSignal,
    progress: (bytes: number, verifying: boolean) => void,
): Promise<void> {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    let offset = await artifactDownloadedBytes(file);
    if (offset === file.size) {
        progress(offset, true);
        await verifyArtifact(file, signal);
        return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once: true});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(abort, ms);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
        abortIfNeeded(signal);
        armTimeout(15_000);
        response = await fetch(artifactUrl(file).replace(OFFICIAL_ORIGIN, origin), {
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: offset ? {Range: `bytes=${offset}-`} : {},
        });
        if (!response.ok || !response.body) throw new Error('LOCAL_TRANSLATION_NETWORK');
        if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('Content-Range') || '');
            if (!range || Number(range[1]) !== offset || Number(range[2]) !== file.size - 1 || Number(range[3]) !== file.size) {
                throw new Error('LOCAL_TRANSLATION_INTEGRITY');
            }
        } else if (response.status === 200 && offset) {
            // Some sources ignore Range. Replacing chunks from zero keeps the cache coherent.
            await removeTranslationArtifact(file);
            offset = 0;
        } else if (response.status !== 200) {
            throw new Error('LOCAL_TRANSLATION_NETWORK');
        }
        const streamingDigest = offset === 0 ? sha256.create() : undefined;
        reader = response.body.getReader();
        let buffer = new Uint8Array(Math.min(MODEL_CHUNK_SIZE, file.size - offset));
        let filled = 0;
        let index = offset / MODEL_CHUNK_SIZE;
        while (true) {
            abortIfNeeded(signal);
            armTimeout(45_000);
            const {done, value} = await reader.read();
            clearTimeout(timer);
            if (done) break;
            if (offset + filled + value.byteLength > file.size) throw new Error('LOCAL_TRANSLATION_INTEGRITY');
            streamingDigest?.update(value);
            let cursor = 0;
            while (cursor < value.byteLength) {
                const count = Math.min(buffer.byteLength - filled, value.byteLength - cursor);
                buffer.set(value.subarray(cursor, cursor + count), filled);
                cursor += count;
                filled += count;
                if (filled === buffer.byteLength) {
                    abortIfNeeded(signal);
                    await cache.put(chunkKey(file, index++), new Response(buffer, {
                        headers: {'Content-Length': String(filled)},
                    }));
                    offset += filled;
                    filled = 0;
                    buffer = new Uint8Array(Math.min(MODEL_CHUNK_SIZE, file.size - offset));
                }
            }
            progress(offset + filled, false);
        }
        if (offset !== file.size) throw new Error('LOCAL_TRANSLATION_NETWORK');
        progress(offset, true);
        if (streamingDigest) await verifyStreamingArtifact(cache, file, streamingDigest, signal);
        else await verifyArtifact(file, signal);
    } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
        else if (response) cancelUnreadResponseBody(response);
        reader?.releaseLock();
        signal.removeEventListener('abort', abort);
    }
}

export async function downloadTranslationArtifact(
    file: TranslationArtifact,
    signal: AbortSignal,
    progress: (bytes: number, verifying: boolean) => void,
): Promise<void> {
    abortIfNeeded(signal);
    const complete = await artifactComplete(file);
    abortIfNeeded(signal);
    if (complete) { progress(file.size, false); return; }
    // 旧收据可能指向缺块；修复期间不能让其他读取者看到未经重新校验的文件。
    await invalidateTranslationArtifactReceipt(file);
    abortIfNeeded(signal);
    const sources = huggingFaceDownloadOrigins();
    let lastError: unknown;
    for (const origin of sources) {
        abortIfNeeded(signal);
        try {
            await receiveArtifact(file, origin, signal, progress);
            return;
        } catch (error) {
            abortIfNeeded(signal);
            if (error instanceof Error && error.name === 'QuotaExceededError') throw error;
            lastError = error;
        }
    }
    throw lastError;
}
