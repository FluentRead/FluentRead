/**
 * @file src/features/local-translation/offscreen/translation.ts
 *
 * 文件职责：在 Offscreen Document 中管理本地翻译 Worker、模型缓存和请求取消。
 * 主要内容：串行复用模型 Worker，排队和模型状态读取期间可取消并释放请求，按设备内存保温并保护仍有效的任务，显式释放使旧代状态等待和队列失效；按模型切换时终止旧实例，隔离旧实例的迟到错误，并提供下载、状态、清除和文本翻译能力。
 * 模块边界：Worker 回复先经 feature 公共协议校验，不读取配置、不访问宿主网页 DOM；模型目录和语言码解析由 core 负责。
 */
import {createLocalInferenceBudget, withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';
import {
    LOCAL_TRANSLATION_MODELS,
    normalizeLocalTranslationModel,
    type LocalTranslationModelId,
} from '@/src/core/config/localTranslation';
import {resolveLocalTranslationLanguageCode} from '@/src/core/language/localTranslation';
import {createLocalTranslationDownloadManager} from './downloads';
import type {LocalTranslationDownloadSnapshot} from '@/src/core/config/localTranslation';
import {readWorkerRequestId} from '@/src/core/messaging/validation';
import {parseLocalTranslationWorkerResponse, type LocalTranslationWorkerCommand as WorkerCommand, type LocalTranslationWorkerResponse as WorkerResponse} from '../workerProtocol';

interface PendingWorkerRequest {
    readonly resolve: (response: WorkerResponse) => void;
    readonly reject: (error: unknown) => void;
    readonly timeout: number;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
}

export interface LocalTranslationRequest {
    readonly model?: unknown;
    readonly text: string;
    readonly sourceLanguage?: unknown;
    readonly targetLanguage?: unknown;
    readonly sourceLanguageDetectionText?: unknown;
}

const TRANSLATION_TIMEOUT_MS = 120_000;

let translationWorker: Worker | null = null;
let workerGeneration = 0;
let translationWorkerModel: LocalTranslationModelId | '' = '';
let workerRequestId = 0;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();
const runInTranslationQueue = createLocalInferenceBudget(1);
let cancellationGeneration = 0;
let translationLifetime = new AbortController();
let activeTranslations = 0;
let idleDisposeTimer: number | undefined;
let notifyDownloads: ((state: LocalTranslationDownloadSnapshot) => Promise<void>) | undefined;
const downloads = createLocalTranslationDownloadManager({
    onChange: (state) => notifyDownloads?.(state) || Promise.resolve(),
    beforeRemove: (model) => {
        if (translationWorkerModel === model) {
            clearIdleDispose();
            terminateWorker(new Error('LOCAL_TRANSLATION_MODEL_REMOVED'));
        }
    },
});

export function configureLocalTranslationDownloadNotifications(notify: (state: LocalTranslationDownloadSnapshot) => Promise<void>): void {
    notifyDownloads = notify;
}

function createAbortError(): Error {
    const error = new Error('本地翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

/** 状态读取不拥有 Worker；取消时释放串行槽，但不声称中止底层 Cache Storage。 */
function readStatus(signal: AbortSignal | undefined, lifetime: AbortSignal): Promise<LocalTranslationDownloadSnapshot> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            lifetime.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(createAbortError()));
        if (signal?.aborted || lifetime.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, {once: true});
        lifetime.addEventListener('abort', onAbort, {once: true});
        void Promise.resolve().then(() => {
            if (signal?.aborted || lifetime.aborted) throw createAbortError();
            return downloads.status();
        }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}

function toError(value: unknown, fallback: string): Error {
    return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback);
}

function clearIdleDispose(): void {
    if (idleDisposeTimer === undefined) return;
    window.clearTimeout(idleDisposeTimer);
    idleDisposeTimer = undefined;
}

function rejectPending(error: Error): void {
    const pending = [...pendingWorkerRequests.values()];
    pendingWorkerRequests.clear();
    pending.forEach((item) => {
        window.clearTimeout(item.timeout);
        if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        item.reject(error);
    });
}

function terminateWorker(error?: Error): void {
    workerGeneration++;
    clearIdleDispose();
    const current = translationWorker;
    translationWorker = null;
    translationWorkerModel = '';
    current?.terminate();
    if (error) rejectPending(error);
}

function scheduleIdleDispose(): void {
    clearIdleDispose();
    if (!translationWorker || activeTranslations > 0) return;
    idleDisposeTimer = window.setTimeout(() => {
        idleDisposeTimer = undefined;
        if (pendingWorkerRequests.size === 0 && activeTranslations === 0) terminateWorker();
    }, localModelIdleMs());
}

function getWorker(): Worker {
    if (translationWorker) return translationWorker;
    const getUrl = (globalThis as typeof globalThis & {
        chrome?: {runtime?: {getURL?: (value: string) => string}};
    }).chrome?.runtime?.getURL;
    const workerUrl = getUrl?.('localTranslationWorker.js')
        || new URL('localTranslationWorker.js', window.location.href).toString();
    const worker = new Worker(workerUrl, {type: 'module'});
    worker.onmessage = (event: MessageEvent<unknown>) => {
        if (translationWorker !== worker) return;
        const requestId = readWorkerRequestId(event.data);
        if (requestId === undefined) return;
        const pending = pendingWorkerRequests.get(requestId);
        if (!pending) return;
        pendingWorkerRequests.delete(requestId);
        window.clearTimeout(pending.timeout);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        let response: WorkerResponse;
        try { response = parseLocalTranslationWorkerResponse(event.data); }
        catch (error) { pending.reject(error); return; }
        if (response.success || response.retrySingleThread) pending.resolve(response);
        else pending.reject(new Error(response.error || '本地翻译 Worker 失败'));
    };
    worker.onerror = (event) => {
        if (translationWorker !== worker) return;
        terminateWorker(new Error(event.message || '本地翻译 Worker 已停止'));
    };
    translationWorker = worker;
    return worker;
}

function requestWorker(message: WorkerCommand, timeoutMs: number, signal?: AbortSignal): Promise<WorkerResponse> {
    clearIdleDispose();
    const generation = workerGeneration;
    const cancellation = cancellationGeneration;
    return withLocalInferenceBudget(async () => {
        if (generation !== workerGeneration) throw createAbortError();
        const deadline=Date.now()+timeoutMs;
        const response=await requestWorkerNow(message,timeoutMs,signal);
        if (cancellation !== cancellationGeneration || signal?.aborted) throw createAbortError();
        if (!response.retrySingleThread) return response;
        if (response.error === 'LOCAL_TRANSLATION_NOT_DOWNLOADED' || response.error === 'LOCAL_TRANSLATION_INTEGRITY') {
            throw new Error(response.error);
        }
        terminateWorker();
        return requestWorkerNow({...message,singleThread:true},Math.max(1,deadline-Date.now()),signal);
    }, signal);
}

function requestWorkerNow(
    message: WorkerCommand,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<WorkerResponse> {
    clearIdleDispose();
    const requestedModel = normalizeLocalTranslationModel(message.model);
    if (translationWorker && translationWorkerModel && translationWorkerModel !== requestedModel) {
        terminateWorker(new Error('本地翻译模型已切换'));
    }

    const worker = getWorker();
    translationWorkerModel = requestedModel;
    const requestId = ++workerRequestId;
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            terminateWorker(new Error(`本地翻译 Worker 超过 ${timeoutMs / 1000} 秒，已终止以保护浏览器性能`));
        }, timeoutMs);
        const onAbort = () => terminateWorker(createAbortError());
        const pending: PendingWorkerRequest = {resolve, reject, timeout, signal, onAbort};
        pendingWorkerRequests.set(requestId, pending);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, {once: true});
        try {
            worker.postMessage({
                ...message,
                requestId,
                model: requestedModel,
            });
        } catch (error) {
            window.clearTimeout(timeout);
            if (signal) signal.removeEventListener('abort', onAbort);
            pendingWorkerRequests.delete(requestId);
            const workerError = toError(error, '无法启动本地翻译 Worker');
            terminateWorker(workerError);
            reject(workerError);
        }
    });
}

function modelResult(response: WorkerResponse, fallback: string): string {
    if (!response.success || typeof response.result !== 'string' || !response.result.trim()) {
        throw new Error(response.error || fallback);
    }
    return response.result;
}

export async function translateLocalText(
    request: LocalTranslationRequest,
    signal?: AbortSignal,
): Promise<string> {
    if (signal?.aborted) throw createAbortError();
    const generation = cancellationGeneration;
    const lifetime = translationLifetime.signal;
    activeTranslations++;
    clearIdleDispose();
    const run = async (): Promise<string> => {
        if (generation !== cancellationGeneration || signal?.aborted) throw createAbortError();
        if (typeof request.text !== 'string' || !request.text.trim()) return request.text || '';
        if (signal?.aborted) throw createAbortError();
        const model = normalizeLocalTranslationModel(request.model);
        const detectionText = typeof request.sourceLanguageDetectionText === 'string'
            && request.sourceLanguageDetectionText.trim() ? request.sourceLanguageDetectionText : request.text;
        const sourceLanguage = resolveLocalTranslationLanguageCode(model, request.sourceLanguage, detectionText);
        const targetLanguage = resolveLocalTranslationLanguageCode(model, request.targetLanguage);
        if (sourceLanguage === targetLanguage) return request.text;
        const state = await readStatus(signal, lifetime);
        if (generation !== cancellationGeneration || signal?.aborted) throw createAbortError();
        const modelState = state.tasks.find((task) => task.model === model);
        if (modelState?.phase !== 'ready') {
            throw new Error('LOCAL_TRANSLATION_NOT_DOWNLOADED');
        }

        try {
            const response = await requestWorker({
                type: 'translate', model, text: request.text, sourceLanguage, targetLanguage,
            }, TRANSLATION_TIMEOUT_MS, signal);
            if (generation !== cancellationGeneration || signal?.aborted) throw createAbortError();
            return modelResult(response, '本地翻译未返回有效译文');
        } catch (error) {
            if (error instanceof Error && ['LOCAL_TRANSLATION_NOT_DOWNLOADED', 'LOCAL_TRANSLATION_INTEGRITY'].includes(error.message)
                && generation === cancellationGeneration && !signal?.aborted) {
                terminateWorker();
                // 状态复验不能阻塞请求取消；迟到结果需在管理器内校验原状态版本。
                void downloads.reconcileUnavailable(model, modelState.updatedAt, error.message === 'LOCAL_TRANSLATION_INTEGRITY' ? 'integrity' : 'missing').catch(() => undefined);
            }
            throw error;
        }
    };
    try { return await runInTranslationQueue(run, signal); }
    finally { activeTranslations--; scheduleIdleDispose(); }
}

export async function prepareLocalTranslationModel(modelValue: unknown): Promise<LocalTranslationDownloadSnapshot> {
    return downloads.start(modelValue);
}

export async function getLocalTranslationModelStatus(): Promise<{
    models: Array<{model: LocalTranslationModelId; downloaded: boolean; downloadSizeMb: number}>;
} & LocalTranslationDownloadSnapshot> {
    const state = await downloads.status();
    return {
        ...state,
        models: LOCAL_TRANSLATION_MODELS.map((item) => ({
            model: item.value,
            downloaded: state.tasks.some((task) => task.model === item.value && task.phase === 'ready'),
            downloadSizeMb: item.downloadSizeMb,
        })),
    };
}

export async function removeLocalTranslationModel(modelValue: unknown): Promise<void> {
    await downloads.remove(modelValue);
}

export async function pauseLocalTranslationModelDownload(modelValue: unknown): Promise<LocalTranslationDownloadSnapshot> {
    return downloads.pause(modelValue);
}

export function disposeLocalTranslationWorker(): void {
    cancellationGeneration++;
    const previousLifetime = translationLifetime;
    translationLifetime = new AbortController();
    previousLifetime.abort();
    clearIdleDispose();
    terminateWorker(createAbortError());
}
