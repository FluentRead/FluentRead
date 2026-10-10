/**
 * @file src/features/information-highlight/offscreen/runtime.ts
 * 文件职责：在共享离屏文档看守信息高亮模型下载、独立评分 Worker 和有界暖机复用。
 * 主要内容：每种模型独立管理下载与状态，显式准备才下载；所有评分共用串行队列，切换时释放旧模型 Worker，任意时刻只暖驻一个模型；取消、短收尾看守及 180 秒空闲释放沿用共享资源预算。
 * 模块边界：不访问宿主 DOM、不持有页面偏好、不另建 offscreen 文档；仅消费模型清单与 platform 缓存。
 */
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {getInformationHighlightArtifacts, getInformationHighlightArtifactStore, informationHighlightArtifactStore} from './artifacts';
import type {InformationHighlightModelErrorCode, InformationHighlightModelStatus, InformationHighlightResult} from '../protocol';
import type {InformationHighlightWorkerRequest, InformationHighlightWorkerResponse} from './worker';
const RECOVERABLE_INPUT_ERRORS = new Set(['INFORMATION_HIGHLIGHT_TOKEN_LIMIT', 'INFORMATION_HIGHLIGHT_TEXT_LIMIT', 'INFORMATION_HIGHLIGHT_ALIGNMENT']);
export interface InformationHighlightCapability {supported: boolean; reason?: string}
export async function probeInformationHighlightWebGpu(): Promise<InformationHighlightCapability> {
    const gpu = (navigator as unknown as {gpu?: {requestAdapter(): Promise<{features: ReadonlySet<string>} | null>}}).gpu;
    if (!gpu) return {supported: false, reason: 'INFORMATION_HIGHLIGHT_WEBGPU_UNAVAILABLE'};
    try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) return {supported: false, reason: 'INFORMATION_HIGHLIGHT_WEBGPU_UNAVAILABLE'};
        return adapter.features.has('shader-f16') ? {supported: true} : {supported: false, reason: 'INFORMATION_HIGHLIGHT_F16_UNAVAILABLE'};
    } catch {return {supported: false, reason: 'INFORMATION_HIGHLIGHT_WEBGPU_UNAVAILABLE'};}
}
export interface InformationHighlightRuntimeDependencies {
    modelId?: InformationHighlightModelId;
    store: typeof informationHighlightArtifactStore;
    createWorker(): Worker;
    probe(): Promise<InformationHighlightCapability>;
    notify(progress?: {loaded: number; total: number}): void;
    budget: typeof withLocalInferenceBudget;
}
function downloadErrorCode(error: unknown): InformationHighlightModelErrorCode {
    const detail = error as {name?: string; message?: string} | null;
    if (detail?.name === 'QuotaExceededError') return 'INFORMATION_HIGHLIGHT_STORAGE_QUOTA';
    if (detail?.message === 'MODEL_INTEGRITY') return 'INFORMATION_HIGHLIGHT_MODEL_INTEGRITY';
    if (detail?.message === 'MODEL_NETWORK' || detail?.name === 'TypeError' || detail?.name === 'AbortError') return 'INFORMATION_HIGHLIGHT_MODEL_NETWORK';
    return 'INFORMATION_HIGHLIGHT_DOWNLOAD_FAILED';
}
export function createInformationHighlightModelRuntime(dependencies: InformationHighlightRuntimeDependencies) {
    const model = getInformationHighlightModel(dependencies.modelId), artifacts = getInformationHighlightArtifacts(model.id);
    let phase: InformationHighlightModelStatus['phase'] = 'absent', errorCode: InformationHighlightModelErrorCode | undefined;
    let capability: Promise<InformationHighlightCapability> | undefined;
    let job: {controller: AbortController; done: Promise<void>} | undefined;
    let removing = false, worker: Worker | undefined, initialized = false, sequence = 0, generation = 0;
    let tail: Promise<void> = Promise.resolve(), warmTimer: ReturnType<typeof setTimeout> | undefined;
    let fileSnapshot: Promise<Array<{complete: boolean; bytes: number}>> | undefined, snapshotAt = 0;
    let pending: {reject(error: Error): void} | undefined;
    const abortError = () => new DOMException('信息高亮已取消', 'AbortError');
    const support = () => capability ??= dependencies.probe();
    const stop = () => {clearTimeout(warmTimer); generation++; const current = worker; worker = undefined; initialized = false; current?.terminate(); pending?.reject(abortError());};
    const status = async (): Promise<InformationHighlightModelStatus> => {
        // 就绪文件变化只发生在显式管理动作或外部驱逐；冷加载还会逐块复核，状态轮询不重读整套权重。
        if (!fileSnapshot || Date.now() - snapshotAt >= (phase === 'ready' ? 60_000 : 1_000)) {
            snapshotAt = Date.now();
            fileSnapshot = Promise.all(artifacts.map(async file => {
                const complete = await dependencies.store.complete(file);
                return {complete, bytes: complete ? file.size : await dependencies.store.downloaded(file)};
            })).catch(error => {fileSnapshot = undefined; throw error;});
        }
        const files = await fileSnapshot;
        const downloaded = files.every(file => file.complete), downloadedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
        if (!job && !removing && phase !== 'error') phase = downloaded ? 'ready' : downloadedBytes ? 'paused' : 'absent';
        return {modelId: model.id, phase: removing ? 'removing' : phase, downloaded, initialized, downloadedBytes, totalBytes: model.bytes, downloadSizeBytes: model.bytes, modelName: model.name, ...await support(), ...(errorCode ? {errorCode} : {})};
    };
    const prepare = async () => {
        const current = await status();
        if (!current.supported) throw new Error(current.reason);
        if (removing) throw new Error('INFORMATION_HIGHLIGHT_REMOVING');
        if (job) return current;
        if (current.downloaded) {phase = 'ready'; errorCode = undefined; return {...current, phase, errorCode};}
        const controller = new AbortController(); phase = 'queued'; errorCode = undefined;
        const run = async () => {
            const bytes = new Map<string, number>();
            try {
                const quota = await navigator.storage?.estimate?.();
                if (quota?.quota && quota.quota - (quota.usage || 0) < current.totalBytes - current.downloadedBytes + 32 * 1024 * 1024) throw new DOMException('模型存储空间不足', 'QuotaExceededError');
                for (const file of artifacts) bytes.set(file.url, await dependencies.store.downloaded(file));
                for (const file of artifacts) {
                    phase = 'downloading';
                    await dependencies.store.download(file, controller.signal, (loaded, verifying) => {
                        bytes.set(file.url, loaded); phase = verifying ? 'verifying' : 'downloading';
                        fileSnapshot = undefined;
                        dependencies.notify({loaded: [...bytes.values()].reduce((sum, value) => sum + value, 0), total: model.bytes});
                    });
                }
                phase = 'ready';
            } catch (error) {
                phase = controller.signal.aborted ? 'paused' : 'error';
                errorCode = controller.signal.aborted ? undefined : downloadErrorCode(error);
            } finally {if (job?.controller === controller) job = undefined; fileSnapshot = undefined; dependencies.notify();}
        };
        job = {controller, done: Promise.resolve().then(run)};
        return {...current, phase: 'queued' as const};
    };
    const pause = async () => {job?.controller.abort(); if (job) phase = 'paused'; return status();};
    const remove = async () => {
        if (removing) return status();
        removing = true; phase = 'removing'; job?.controller.abort();
        try {await job?.done; stop(); for (const file of artifacts) await dependencies.store.remove(file); phase = 'absent'; errorCode = undefined;}
        catch (error) {phase = 'error'; errorCode = 'INFORMATION_HIGHLIGHT_REMOVE_FAILED'; throw error;}
        finally {removing = false; fileSnapshot = undefined;}
        return status();
    };
    const attempt = (text: string, signal: AbortSignal): Promise<InformationHighlightResult> => {
        if (signal.aborted) return Promise.reject(abortError());
        clearTimeout(warmTimer); const current = worker ??= dependencies.createWorker(), requestId = ++sequence;
        return new Promise((resolve, reject) => {
            let drain: ReturnType<typeof setTimeout> | undefined, settled = false, initializing = !initialized;
            let timer: ReturnType<typeof setTimeout>;
            const watch = (ms: number) => {clearTimeout(timer); timer = setTimeout(() => {phase = 'error'; errorCode = 'INFORMATION_HIGHLIGHT_MODEL_TIMEOUT'; finish(new Error('INFORMATION_HIGHLIGHT_TIMEOUT')); stop();}, ms);};
            const finish = (error?: Error, result?: InformationHighlightResult) => {
                if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drain); signal.removeEventListener('abort', cancel);
                current.onmessage = null; current.onerror = null; pending = undefined;
                if (error && !signal.aborted && !RECOVERABLE_INPUT_ERRORS.has(error.message)) fileSnapshot = undefined;
                if (worker === current) warmTimer = setTimeout(() => {if (worker === current && !pending) stop();}, 180_000);
                if (signal.aborted) reject(abortError()); else if (error) reject(error); else resolve(result!);
            };
            const cancel = () => {
                try {current.postMessage({type: 'cancel', requestId} satisfies InformationHighlightWorkerRequest);}
                catch {finish(abortError()); stop(); return;}
                // 初始化没有页面推理：保留进行中的暖机，其阶段看守仍限制等待；已开始评分只给一个短块收尾。
                if (!initializing) drain = setTimeout(() => {finish(abortError()); stop();}, 1_500);
            };
            pending = {reject: error => finish(error)};
            current.onmessage = (event: MessageEvent<InformationHighlightWorkerResponse>) => {
                if (worker !== current || event.data?.requestId !== requestId) return;
                const response = event.data; initialized = response.initialized;
                if (response.stage) {initializing = response.stage === 'initializing'; watch(initializing ? 30_000 : 120_000); if (!initializing && signal.aborted) cancel(); return;}
                const failure = !response.success || !response.result;
                const recoverable = RECOVERABLE_INPUT_ERRORS.has(response.error!);
                if (failure && !signal.aborted && !recoverable) {
                    phase = 'error'; errorCode = response.initialized ? 'INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED' : 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED';
                }
                if (!failure && !signal.aborted && !removing && !settled) {phase = 'ready'; errorCode = undefined;}
                finish(failure ? new Error(response.error || 'INFORMATION_HIGHLIGHT_FAILED') : undefined, response.result);
                // 初始化失败后释放 Worker 中 ONNX 可能已分配的部分资源；输入限额和正常取消仍保留有效暖模型。
                if (failure && (!response.initialized || (!signal.aborted && !recoverable))) stop();
            };
            current.onerror = event => {if (worker === current) {phase = 'error'; errorCode = 'INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED'; finish(new Error(event.message)); stop();}};
            signal.addEventListener('abort', cancel, {once: true});
            watch(initializing ? 30_000 : 120_000);
            try {current.postMessage({type: 'score', requestId, text, modelId: model.id} satisfies InformationHighlightWorkerRequest);}
            catch (error) {phase = 'error'; errorCode = 'INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED'; finish(error instanceof Error ? error : new Error('INFORMATION_HIGHLIGHT_WORKER_FAILED')); stop();}
        });
    };
    const score = (text: string, signal: AbortSignal): Promise<InformationHighlightResult> => {
        const owner = generation;
        const result = tail.then(() => dependencies.budget(async () => {
            if (signal.aborted || owner !== generation) throw abortError();
            const current = await status();
            if (removing) throw new Error('INFORMATION_HIGHLIGHT_REMOVING');
            if (!current.supported) throw new Error(current.reason);
            if (!current.downloaded) throw new Error('INFORMATION_HIGHLIGHT_NOT_DOWNLOADED');
            return attempt(text, signal);
        }, signal));
        tail = result.then(() => undefined, () => undefined);
        return new Promise((resolve, reject) => {
            const abort = () => reject(abortError()); signal.addEventListener('abort', abort, {once: true});
            if (signal.aborted) abort();
            void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    };
    return {status, prepare, pause, remove, score, releaseWorker: stop, dispose: () => {job?.controller.abort(); stop();}};
}

export interface InformationHighlightModelsRuntimeDependencies extends Omit<InformationHighlightRuntimeDependencies, 'store' | 'modelId' | 'notify'> {
    notify(progress: {loaded: number; total: number} | undefined, modelId: InformationHighlightModelId): void;
    store?(modelId: InformationHighlightModelId): typeof informationHighlightArtifactStore;
}

/** 状态查询不加载权重；每个模型独立下载，GPU 会话只在评分队列切换时交接。 */
export function createInformationHighlightModelsRuntime(dependencies: InformationHighlightModelsRuntimeDependencies) {
    const models = new Map<InformationHighlightModelId, ReturnType<typeof createInformationHighlightModelRuntime>>();
    let active: InformationHighlightModelId | undefined, disposed = false;
    let tail: Promise<void> = Promise.resolve();
    const runtime = (modelId: InformationHighlightModelId) => {
        if (disposed) throw new Error('INFORMATION_HIGHLIGHT_DISPOSED');
        let model = models.get(modelId);
        if (!model) {
            model = createInformationHighlightModelRuntime({...dependencies, modelId,
                store: dependencies.store?.(modelId) ?? getInformationHighlightArtifactStore(modelId),
                notify: progress => dependencies.notify(progress, modelId)});
            models.set(modelId, model);
        }
        return model;
    };
    return {
        status: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => runtime(modelId).status(),
        prepare: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => runtime(modelId).prepare(),
        pause: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => runtime(modelId).pause(),
        remove: (modelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID) => runtime(modelId).remove(),
        score(text: string, signal: AbortSignal, modelId: InformationHighlightModelId = DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID): Promise<InformationHighlightResult> {
            const result = tail.then(() => {
                if (signal.aborted) throw new DOMException('信息高亮已取消', 'AbortError');
                const selected = runtime(modelId);
                if (active !== modelId) {if (active) models.get(active)!.releaseWorker(); active = modelId;}
                return selected.score(text, signal);
            });
            tail = result.then(() => undefined, () => undefined);
            return new Promise((resolve, reject) => {
                const abort = () => reject(new DOMException('信息高亮已取消', 'AbortError'));
                signal.addEventListener('abort', abort, {once: true});
                if (signal.aborted) abort();
                void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
            });
        },
        dispose() {disposed = true; for (const model of models.values()) model.dispose(); models.clear();},
    };
}
