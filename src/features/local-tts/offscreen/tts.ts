/**
 * @file src/features/local-tts/offscreen/tts.ts
 * 文件职责：编排本地 Kokoro TTS 模型缓存、Worker 生命周期、下载状态和合成请求。
 * 主要内容：朗读不自动下载模型，串行复用一个 Worker，并按设备内存保留有界空闲会话；GPU 生命周期失败按总预算重建一次 CPU Worker，资源重建与显式取消分别校验代次；释放时取消在途及排队任务，模型操作互斥，真实下载字节进度原样发布。
 * 模块边界：只负责扩展自有 Offscreen 运行时，Worker 回复先经共享协议校验；不决定在线/本地策略，也不直接操作网页 UI。
 */

import {readWorkerRequestId} from '@/src/core/messaging/validation';
import type {InferenceBackend} from '@/src/core/messaging/inference';
import {createLocalInferenceBudget, withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';
import {
    LOCAL_TTS_MODEL,
    LOCAL_TTS_MODEL_ID,
    LOCAL_TTS_MODEL_DTYPE,
    LOCAL_TTS_MODEL_REVISION,
    LOCAL_TTS_MODEL_STATE_KEY,
    localTtsVoiceForLanguage,
    supportsLocalTtsLanguage,
} from '@/src/core/config/localTts';
import {
    cacheLocalTtsModelFiles,
    isLocalTtsModelCached,
    removeLocalTtsModelFiles,
} from './modelCache';
import type {DownloadProgress} from '@/src/core/download/progress';
import {
    LocalTtsLanguageUnsupportedError,
    LocalTtsModelNotDownloadedError,
    type LocalTtsAudio,
    parseLocalTtsWorkerResponse,
    type LocalTtsWorkerRequest as WorkerRequest,
    type LocalTtsWorkerResponse as WorkerResponse,
} from '../protocol';

type LocalTtsWorkerBackend = InferenceBackend;

interface PendingWorkerRequest {
    resolve: (response: WorkerResponse) => void;
    reject: (error: unknown) => void;
    timeout: number;
    signal?: AbortSignal;
    onAbort?: () => void;
}

type WorkerLifecycleError = Error & {retryableWorkerFailure?: true};

const SYNTHESIS_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let workerGeneration = 0;
let workerRequestId = 0;
let pendingRequests = new Map<number, PendingWorkerRequest>();
let idleDisposeTimer: number | undefined;
const runInTtsQueue = createLocalInferenceBudget(1);
// Worker 重建允许 CPU 回退；显式释放才作废整批在途/排队的调用。
let cancellationGeneration = 0;
let synthesisLifetime = new AbortController();
let activeSyntheses = 0;
let preparingModels = 0;
let removingModel = false;

function createWorkerLifecycleError(message: string): WorkerLifecycleError {
    const error = new Error(message) as WorkerLifecycleError;
    error.retryableWorkerFailure = true;
    return error;
}

function isWorkerLifecycleError(error: unknown): error is WorkerLifecycleError {
    return error instanceof Error && (error as WorkerLifecycleError).retryableWorkerFailure === true;
}

function toError(value: unknown, fallback: string): Error {
    return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback);
}

function createAbortError(): Error {
    const error = new Error('本地 TTS 请求已取消');
    error.name = 'AbortError';
    return error;
}

/** 释放调用者的等待；不声称中断 Cache Storage 等底层操作。 */
function awaitCancellable<T>(promise: Promise<T>, signal: AbortSignal | undefined, lifetime: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            lifetime.removeEventListener('abort', onAbort);
            action();
        };
        const onAbort = () => finish(() => reject(createAbortError()));
        // 即使等待已取消，也必须消费底层任务的迟到失败。
        void promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        if (signal?.aborted || lifetime.aborted) {onAbort();return;}
        signal?.addEventListener('abort', onAbort, {once: true});
        lifetime.addEventListener('abort', onAbort, {once: true});
    });
}

function clearIdleDispose(): void {
    if (idleDisposeTimer !== undefined) {
        window.clearTimeout(idleDisposeTimer);
        idleDisposeTimer = undefined;
    }
}

function scheduleIdleDispose(): void {
    clearIdleDispose();
    idleDisposeTimer = window.setTimeout(() => {
        idleDisposeTimer = undefined;
        if (pendingRequests.size === 0 && activeSyntheses === 0) terminateWorker();
    }, localModelIdleMs());
}

function rejectPending(error: Error): void {
    for (const [requestId, pending] of pendingRequests) {
        window.clearTimeout(pending.timeout);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        pending.reject(error);
        pendingRequests.delete(requestId);
    }
}

function terminateWorker(error?: Error): void {
    workerGeneration++;
    clearIdleDispose();
    const current = worker;
    worker = null;
    current?.terminate();
    if (error) rejectPending(error);
}

function getWorker(): Worker {
    if (worker) return worker;
    const getUrl = (globalThis as typeof globalThis & {
        chrome?: {runtime?: {getURL?: (value: string) => string}};
    }).chrome?.runtime?.getURL;
    const workerUrl = getUrl?.('localTtsWorker.js')
        || new URL('localTtsWorker.js', window.location.href).toString();
    const next = new Worker(workerUrl, {type: 'module'});
    next.onmessage = (event: MessageEvent<unknown>) => {
        if (worker !== next) return;
        const requestId = readWorkerRequestId(event.data);
        if (requestId === undefined) return;
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        window.clearTimeout(pending.timeout);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        let response: WorkerResponse;
        try { response = parseLocalTtsWorkerResponse(event.data); }
        catch (error) { pending.reject(error); return; }
        if (response.success) pending.resolve(response);
        else if (response.retryWithCpu === true) {
            const error = createWorkerLifecycleError(response.error || '本地 TTS GPU Worker 失败，准备使用 CPU 重试');
            // The current request was removed above, so terminateWorker cannot
            // lose its reject path; reject it explicitly after tearing down.
            terminateWorker(error);
            pending.reject(error);
        }
        else pending.reject(new Error(response.error || '本地 TTS Worker 失败'));
    };
    next.onerror = (event) => {
        if (worker !== next) return;
        terminateWorker(createWorkerLifecycleError(event.message || '本地 TTS Worker 已停止'));
    };
    worker = next;
    return next;
}

function requestWorker(message: Omit<WorkerRequest, 'requestId'>, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResponse> {
    clearIdleDispose();
    const generation = workerGeneration;
    return withLocalInferenceBudget(() => {
        if (generation !== workerGeneration) throw createAbortError();
        return requestWorkerNow(message, timeoutMs, signal);
    }, signal);
}

function requestWorkerNow(
    message: Omit<WorkerRequest, 'requestId'>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    clearIdleDispose();
    const currentWorker = getWorker();
    const requestId = ++workerRequestId;
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            terminateWorker(createWorkerLifecycleError(`本地 TTS Worker 超过 ${timeoutMs / 1000} 秒，已终止以保护浏览器性能`));
        }, timeoutMs);
        const onAbort = () => terminateWorker(createAbortError());
        pendingRequests.set(requestId, {resolve, reject, timeout, signal, onAbort});
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, {once: true});
        try {
            currentWorker.postMessage({requestId, ...message});
        } catch (error) {
            window.clearTimeout(timeout);
            if (signal) signal.removeEventListener('abort', onAbort);
            pendingRequests.delete(requestId);
            const workerError = toError(error, '无法启动本地 TTS Worker');
            terminateWorker(workerError);
            reject(workerError);
        }
    });
}

async function requestWorkerWithCpuFallback(
    message: Omit<WorkerRequest, 'requestId'>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<WorkerResponse> {
    const deadlineAt = Date.now() + timeoutMs;
    const generation = cancellationGeneration;
    const firstAttemptTimeout = Math.max(1, Math.floor(timeoutMs / 2));
    try {
        return await requestWorker(message, firstAttemptTimeout, signal);
    } catch (error) {
        if (signal?.aborted || generation !== cancellationGeneration) throw createAbortError();
        const remainingMs = deadlineAt - Date.now();
        if (!isWorkerLifecycleError(error) || message.device === 'wasm' || remainingMs <= 0) throw error;
        return requestWorker({...message, device: 'wasm'}, remainingMs, signal);
    }
}

function runSerial<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, lifetime: AbortSignal): Promise<T> {
    const linked = new AbortController();
    const onAbort = () => linked.abort();
    // 上游已在同一同步调用栈中验证两种取消状态。
    signal?.addEventListener('abort', onAbort, {once: true});
    lifetime.addEventListener('abort', onAbort, {once: true});
    // 排队取消会从共享的 FIFO 中移除，已启动的任务也把取消传给推理预算和 Worker。
    return runInTtsQueue(() => operation(linked.signal), linked.signal).finally(() => {
        signal?.removeEventListener('abort', onAbort);
        lifetime.removeEventListener('abort', onAbort);
    });
}

export async function prepareLocalTtsModel(
    _keepWarm = false,
    onProgress?: (progress: DownloadProgress) => void,
): Promise<{
    model: typeof LOCAL_TTS_MODEL_ID;
    dtype: typeof LOCAL_TTS_MODEL_DTYPE;
    revision: typeof LOCAL_TTS_MODEL_REVISION;
    warm: boolean;
    backend?: LocalTtsWorkerBackend;
}> {
    if (removingModel) throw new Error('正在清除本地 TTS 模型，请稍后重试');
    preparingModels += 1;
    try {
        await cacheLocalTtsModelFiles(onProgress);
        if (!(await isLocalTtsModelCached())) throw new Error('本地 TTS 模型缓存不完整');
        return {
            model: LOCAL_TTS_MODEL_ID,
            dtype: LOCAL_TTS_MODEL_DTYPE,
            revision: LOCAL_TTS_MODEL_REVISION,
            // 设置页的下载动作只确认文件完整性；首次真正朗读时再加载推理 Worker。
            warm: false,
        };
    } finally {
        preparingModels -= 1;
    }
}

export async function getLocalTtsModelStatus(): Promise<{
    models: Array<{
        model: typeof LOCAL_TTS_MODEL_ID;
        downloaded: boolean;
        downloadSizeMb: number;
        dtype: typeof LOCAL_TTS_MODEL_DTYPE;
        revision: typeof LOCAL_TTS_MODEL_REVISION;
    }>;
}> {
    return {
        models: [{
            model: LOCAL_TTS_MODEL_ID,
            downloaded: await isLocalTtsModelCached(),
            downloadSizeMb: LOCAL_TTS_MODEL.downloadSizeMb,
            dtype: LOCAL_TTS_MODEL_DTYPE,
            revision: LOCAL_TTS_MODEL_REVISION,
        }],
    };
}

export async function synthesizeLocalTts(
    text: string,
    language: string,
    preferredVoice: unknown,
    signal?: AbortSignal,
): Promise<LocalTtsAudio> {
    if (signal?.aborted) throw createAbortError();
    if (removingModel) throw new Error('正在清除本地 TTS 模型，请稍后重试');
    if (!supportsLocalTtsLanguage(language)) throw new LocalTtsLanguageUnsupportedError(language);
    // 文件校验和共享预算等待也属于本次请求，先撤销上一轮空闲回收。
    clearIdleDispose();
    const generation = cancellationGeneration;
    const lifetime = synthesisLifetime.signal;
    activeSyntheses += 1;
    try {
        if (!(await awaitCancellable(isLocalTtsModelCached(), signal, lifetime))) throw new LocalTtsModelNotDownloadedError();
        if (signal?.aborted || generation !== cancellationGeneration) throw createAbortError();

        const voice = localTtsVoiceForLanguage(language, preferredVoice);
        const response = await runSerial(linkedSignal => {
            return requestWorkerWithCpuFallback({
                type: 'synthesize',
                text,
                voice,
                speed: 1,
            }, SYNTHESIS_TIMEOUT_MS, linkedSignal);
        }, signal, lifetime);
        if (signal?.aborted || generation !== cancellationGeneration) throw createAbortError();
        if (!response.audio) throw new Error('本地 TTS 未返回音频');
        return {
            audio: response.audio,
            ...(response.timings === undefined ? {} : {timings: response.timings}),
            contentType: 'audio/wav',
            voice,
            backend: response.backend,
        };
    } finally {
        activeSyntheses -= 1;
        if (worker && pendingRequests.size === 0 && activeSyntheses === 0) scheduleIdleDispose();
    }
}

export async function removeLocalTtsModel(): Promise<void> {
    if (pendingRequests.size > 0 || activeSyntheses > 0) throw new Error('本地 TTS 正在运行，请完成后再清除模型');
    if (preparingModels > 0) throw new Error('本地 TTS 模型正在下载，请完成后再清除模型');
    if (removingModel) throw new Error('正在清除本地 TTS 模型，请稍后重试');
    removingModel = true;
    try {
        terminateWorker();
        await removeLocalTtsModelFiles();
    } finally {
        removingModel = false;
    }
}

export function disposeLocalTtsWorker(): void {
    cancellationGeneration += 1;
    const previousLifetime = synthesisLifetime;
    synthesisLifetime = new AbortController();
    previousLifetime.abort();
    terminateWorker(createAbortError());
}

export {LOCAL_TTS_MODEL_STATE_KEY};
