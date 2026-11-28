/**
 * @file src/features/local-translation/offscreen/downloads.ts
 *
 * 文件职责：持有独立于设置页和后台 Service Worker 生命周期的模型下载任务。
 * 主要内容：模型间串行排队、单模型多文件有界并发下载与失败联停、并发初始化盘面恢复、即时任务回执、限频进度、暂停和删除互斥；重开页面仅订阅已有状态。
 * 模块边界：模型文件读写交给 artifactStore，旧缓存交给 modelCache，推理释放和状态通知由应用组合根注入。
 */
import {
    LOCAL_TRANSLATION_MODELS, getLocalTranslationModel, isLocalTranslationModel,
    type LocalTranslationDownloadOptions, type LocalTranslationDownloadSnapshot, type LocalTranslationDownloadState, type LocalTranslationModelId,
} from '@/src/core/config/localTranslation';
import {
    LOCAL_MODEL_CACHE, artifactComplete, artifactDownloadedBytes, downloadTranslationArtifact,
    getTranslationArtifacts, invalidateTranslationArtifactReceipt, removeTranslationArtifact,
    type TranslationArtifact,
} from './artifactStore';
import {isLocalTranslationModelCached, removeLocalTranslationModelFiles} from './modelCache';
import {supportsHunyuanTranslation, supportsOpusTranslation} from '@/src/platform/browser/localTranslationSupport';

const STATE_URL = 'https://fluentread.invalid/local-translation-downloads-v2';
const DOWNLOAD_FILE_CONCURRENCY = 3;
type StoredDownloadState = LocalTranslationDownloadState & {needsReverification?: boolean};
export interface LocalTranslationDownloadDependencies {
    onChange?(state: LocalTranslationDownloadSnapshot): Promise<void>;
    beforeRemove?(model: LocalTranslationModelId): void;
}

export function createLocalTranslationDownloadManager(dependencies: LocalTranslationDownloadDependencies = {}) {
    const states = new Map<LocalTranslationModelId, StoredDownloadState>();
    const jobs = new Map<LocalTranslationModelId, {controller: AbortController; done: Promise<void>; started: boolean}>();
    const removals = new Set<LocalTranslationModelId>();
    const rechecks = new Map<LocalTranslationModelId, {updatedAt: number}>();
    let initialized: Promise<void> | undefined;
    let queue = Promise.resolve();
    let writes = Promise.resolve();
    let lastProgress = 0;

    const snapshot = (): LocalTranslationDownloadSnapshot => ({version: 2, tasks: [...states.values()].map(({needsReverification: _internal, ...task}) => ({...task}))});
    const persist = (): Promise<void> => {
        const state = snapshot();
        const stored = {version: 2, tasks: [...states.values()].map(task => ({...task}))};
        const write = writes.then(async () => {
            const cache = await caches.open(LOCAL_MODEL_CACHE);
            await cache.put(STATE_URL, new Response(JSON.stringify(stored)));
            await dependencies.onChange?.(state).catch(() => undefined);
        });
        writes = write.catch(() => undefined);
        return write;
    };
    const update = (model: LocalTranslationModelId, patch: Partial<StoredDownloadState>) => {
        Object.assign(states.get(model)!, patch, {updatedAt: Math.max(Date.now(), states.get(model)!.updatedAt + 1)});
    };
    const initialize = (): Promise<void> => {
        if (initialized) return initialized;
        initialized = (async () => {
            const cache = await caches.open(LOCAL_MODEL_CACHE);
            const response = await cache.match(STATE_URL);
            const saved = await response?.json().catch(() => undefined) as {version: 2; tasks: StoredDownloadState[]} | undefined;
            const resolved = await Promise.all(LOCAL_TRANSLATION_MODELS.map(async (model) => {
                const artifacts = getTranslationArtifacts(model.value);
                let downloadedBytes = 0;
                let complete = artifacts.length > 0;
                if (model.legacy) {
                    complete = await isLocalTranslationModelCached(model.value);
                    downloadedBytes = complete ? model.downloadSizeMb * 1_000_000 : 0;
                } else {
                    const checked = await Promise.all(artifacts.map(async (file) => {
                        const verified = await artifactComplete(file);
                        return {verified, bytes: verified ? file.size : await artifactDownloadedBytes(file)};
                    }));
                    for (const item of checked) {
                        downloadedBytes += item.bytes;
                        complete &&= item.verified;
                    }
                }
                const previous = saved?.version === 2 && Array.isArray(saved.tasks)
                    ? saved.tasks.find((state) => state.model === model.value) : undefined;
                // 重验中断后即使所有键都存在，也不能丢掉尚未完成的哈希校验意图。
                const reverify = !model.legacy && previous?.phase !== 'idle'
                    && (previous?.needsReverification === true || previous?.error === 'integrity');
                return {
                    model: model.value,
                    state: {
                        model: model.value,
                        phase: reverify ? 'paused' : complete ? 'ready' : downloadedBytes || previous && previous.phase !== 'idle' ? 'paused' : 'idle',
                        downloadedBytes,
                        totalBytes: artifacts.reduce((sum, file) => sum + file.size, 0) || model.downloadSizeMb * 1_000_000,
                        bytesPerSecond: 0,
                        updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1),
                        ...(reverify ? {needsReverification: true} : {}),
                    } satisfies StoredDownloadState,
                };
            }));
            for (const entry of resolved) states.set(entry.model, entry.state);
            await persist();
        })().catch((error) => { initialized = undefined; throw error; });
        return initialized;
    };
    const requireModel = (value: unknown): LocalTranslationModelId => {
        if (!isLocalTranslationModel(value)) throw new Error('LOCAL_TRANSLATION_INVALID_MODEL');
        return value;
    };

    const run = async (model: LocalTranslationModelId, controller: AbortController, reverify: boolean, options?: LocalTranslationDownloadOptions): Promise<void> => {
        try {
            if (controller.signal.aborted) return;
            const files = getTranslationArtifacts(model);
            const remaining = states.get(model)!.totalBytes - states.get(model)!.downloadedBytes;
            const quota = await navigator.storage?.estimate?.();
            if (quota?.quota && quota.quota - (quota.usage || 0) < remaining + 32 * 1024 * 1024) {
                throw new DOMException('Insufficient storage', 'QuotaExceededError');
            }
            update(model, {phase: 'downloading', error: undefined});
            await persist();
            const progressByFile = new Map<string, number>(
                await Promise.all(files.map(async (file) => [`${file.repo}/${file.path}`, await artifactDownloadedBytes(file)] as const)),
            );
            const verifyingFiles = new Set<string>();
            let remainingFiles = files.length;
            let lastBytes = states.get(model)!.downloadedBytes;
            let lastAt = Date.now();
            if (controller.signal.aborted) throw new DOMException('Paused', 'AbortError');
            const abortOnWriteFailure = () => controller.abort();
            const runController = new AbortController();
            const abortRun = () => runController.abort();
            controller.signal.addEventListener('abort', abortRun, {once: true});
            const downloadFile = async (file: TranslationArtifact, signal: AbortSignal): Promise<void> => {
                const fileKey = `${file.repo}/${file.path}`;
                if (reverify) {
                    await invalidateTranslationArtifactReceipt(file);
                    if (signal.aborted) throw new DOMException('Paused', 'AbortError');
                }
                let wasVerifying = false;
                try {
                    const hasDownloadOptions = Boolean(options?.preference || options?.mirrorUrl);
                    const onFileProgress = (bytes: number, verifying: boolean) => {
                        if (signal.aborted) return;
                        const now = Date.now();
                        progressByFile.set(fileKey, bytes);
                        if (verifying) verifyingFiles.add(fileKey);
                        else verifyingFiles.delete(fileKey);
                        const total = [...progressByFile.values()].reduce((sum, value) => sum + value, 0);
                        const elapsed = now - lastAt;
                        if (elapsed >= 500) {
                            update(model, {bytesPerSecond: Math.max(0, (total - lastBytes) * 1000 / elapsed)});
                            lastBytes = total;
                            lastAt = now;
                        }
                        update(model, {phase: verifyingFiles.size > 0 ? 'verifying' : 'downloading', downloadedBytes: total});
                        if (now - lastProgress >= 500) {
                            lastProgress = now;
                            void persist().catch(abortOnWriteFailure);
                        }
                    };
                    await (hasDownloadOptions
                        ? downloadTranslationArtifact(file, signal, onFileProgress, options)
                        : downloadTranslationArtifact(file, signal, onFileProgress));
                } finally {
                    remainingFiles--;
                    wasVerifying = verifyingFiles.delete(fileKey);
                }
                if (signal.aborted) throw new DOMException('Paused', 'AbortError');
                if (wasVerifying && verifyingFiles.size === 0 && remainingFiles > 0) {
                    update(model, {phase: 'downloading'});
                    void persist().catch(abortOnWriteFailure);
                }
            };
            let firstError: unknown;
            let hasError = false;
            let cursor = 0;
            try {
                const workerCount = Math.min(DOWNLOAD_FILE_CONCURRENCY, files.length);
                await Promise.all(Array.from({length: workerCount}, async () => {
                    while (cursor < files.length && !runController.signal.aborted) {
                        const file = files[cursor++]!;
                        try {
                            await downloadFile(file, runController.signal);
                        } catch (error) {
                            if (!hasError) {
                                hasError = true;
                                firstError = error;
                            }
                            runController.abort();
                            return;
                        }
                    }
                }));
            } finally {
                controller.signal.removeEventListener('abort', abortRun);
            }
            if (hasError) throw firstError;
            if (controller.signal.aborted) throw new DOMException('Paused', 'AbortError');
            update(model, {phase: 'ready', downloadedBytes: states.get(model)!.totalBytes, bytesPerSecond: 0, error: undefined, needsReverification: undefined});
        } catch (error) {
            const code = error instanceof Error && error.name === 'QuotaExceededError' ? 'storage'
                : error instanceof Error && error.message === 'LOCAL_TRANSLATION_INTEGRITY' ? 'integrity' : 'network';
            update(model, {phase: controller.signal.aborted ? 'paused' : 'error', bytesPerSecond: 0, error: controller.signal.aborted ? undefined : code});
        } finally {
            // 同模型的新任务须等当前 job 退出后才能入队，运行期间不会被替换。
            jobs.delete(model);
            if (removals.has(model)) update(model, {phase: 'removing'});
            await persist();
        }
    };

    const manager = {
        async status(): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            return snapshot();
        },
        // 只在 Worker 报告模型文件缺失时核查，避免每次翻译都扫描大模型分块。
        async reconcileUnavailable(value: unknown, expectedUpdatedAt: number, reason: 'missing' | 'integrity' = 'missing'): Promise<void> {
            await initialize();
            const model = requireModel(value);
            const current = states.get(model)!;
            if (current.phase !== 'ready' || current.updatedAt !== expectedUpdatedAt || jobs.has(model) || removals.has(model)) return;
            if (reason === 'integrity') {
                update(model, {phase: 'error', error: 'integrity', bytesPerSecond: 0, needsReverification: true});
                await persist();
                return;
            }
            // 相同模型和状态版本最多保留一次复验；调用方无需等待可能挂起的缓存。
            if (rechecks.get(model)?.updatedAt === expectedUpdatedAt) return;
            const owner = {updatedAt: expectedUpdatedAt};
            rechecks.set(model, owner);
            try {
                const files = getTranslationArtifacts(model);
                if (!files.length) return;
                let bytes = 0, incomplete = false;
                for (const file of files) {
                    const complete = await artifactComplete(file);
                    if (!complete) incomplete = true;
                    bytes += complete ? file.size : await artifactDownloadedBytes(file);
                }
                if (!incomplete || current.phase !== 'ready' || current.updatedAt !== expectedUpdatedAt
                    || jobs.has(model) || removals.has(model)) return;
                update(model, {phase: 'paused', downloadedBytes: bytes, bytesPerSecond: 0, error: undefined});
                await persist();
            } finally {
                if (rechecks.get(model) === owner) rechecks.delete(model);
            }
        },
        async start(value: unknown, options?: LocalTranslationDownloadOptions): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            const descriptor = getLocalTranslationModel(model);
            if (descriptor.legacy) throw new Error('LOCAL_TRANSLATION_LEGACY_MODEL');
            if ((descriptor.engine === 'hunyuan' && !supportsHunyuanTranslation())
                || (descriptor.engine === 'opus' && !supportsOpusTranslation())) {
                throw new Error('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED');
            }
            if (removals.has(model)) throw new Error('LOCAL_TRANSLATION_REMOVING');
            const existing = jobs.get(model);
            if (existing?.controller.signal.aborted) {
                await existing.done;
                return manager.start(model, options);
            }
            if (existing || states.get(model)!.phase === 'ready') return snapshot();
            const reverify = states.get(model)!.needsReverification === true;
            const controller = new AbortController();
            update(model, {phase: 'queued', error: undefined, bytesPerSecond: 0});
            const saved = persist();
            const job = {controller, done: Promise.resolve(), started: false};
            const done = queue.then(() => saved).then(() => {
                if (jobs.get(model) !== job) return;
                job.started = true;
                return run(model, controller, reverify, options);
            }).catch(async () => {
                if (jobs.get(model) !== job) return;
                jobs.delete(model);
                update(model, {phase: 'error', error: 'storage', bytesPerSecond: 0});
                await persist().catch(() => undefined);
            });
            job.done = done;
            jobs.set(model, job);
            // done 已在上方统一处理下载及持久化失败；后续任务只等待其清理完成。
            queue = done;
            await saved;
            return snapshot();
        },
        async pause(value: unknown): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            const job = jobs.get(model);
            job?.controller.abort();
            if (job) {
                update(model, {phase: 'paused', bytesPerSecond: 0});
                if (!job.started) jobs.delete(model);
            }
            await persist();
            return snapshot();
        },
        async remove(value: unknown): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            if (removals.has(model)) return snapshot();
            removals.add(model);
            const job = jobs.get(model);
            job?.controller.abort();
            update(model, {phase: 'removing', bytesPerSecond: 0});
            try {
                // 状态写入也是删除操作的一部分；写入失败仍须释放互斥并允许重试。
                await persist();
                if (job?.started) await job.done;
                else if (job) jobs.delete(model);
                dependencies.beforeRemove?.(model);
                if (getLocalTranslationModel(model).legacy) await removeLocalTranslationModelFiles(model);
                else for (const file of getTranslationArtifacts(model)) await removeTranslationArtifact(file);
                update(model, {phase: 'idle', downloadedBytes: 0, error: undefined, needsReverification: undefined});
            } catch (error) {
                update(model, {phase: 'error', error: 'storage'});
                throw error;
            } finally {
                removals.delete(model);
                await persist();
            }
            return snapshot();
        },
    };
    return manager;
}
