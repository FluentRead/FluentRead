/**
 * @file src/features/image-translation/services/ocrWorkerRuntime.ts
 * 文件职责：实现与具体 OCR 引擎无关的 Worker 生命周期和串行任务队列，保证识别、参数设置、语言切换及销毁不会在并发请求间交叉污染。
 * 主要内容：定义 OcrWorkerPort、依赖与 runtime 契约，复用 Worker 并串行重新初始化语言与分割参数；累计模型超过五个时重建以限制内存，按设备内存限制空闲驻留；排队取消及时移除待处理任务并清理所有权，仍在运行的识别和模型清理保持互斥；显式销毁立即取消全部任务，迟到的语言切换不得污染后续任务；提供任务隔离的真实进度、识别和语言预加载。
 * 模块边界：此层不依赖 Tesseract.js 类型、浏览器 storage 或图片翻译 UI；具体 worker 工厂由 ocrRuntime 注入，语言状态记录和 Offscreen 消息编排位于其他模块。
 */
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';
import {createLocalInferenceBudget} from '@/src/shared/onnx/resources';

/**
 * OCR Worker 的最小能力边界。
 *
 * 这里不依赖 Tesseract.js 或 Chrome API，便于单测完整覆盖 Worker 的并发与切换语义。
 */
export interface OcrWorkerPort<TResult> {
    setParameters(parameters: Record<string, string | number>): Promise<unknown>;
    recognize(image: string, options: Record<string, never>, output: {blocks: true}, jobId?: string): Promise<TResult>;
    terminate(): Promise<unknown>;
    reinitialize?(languages: string): Promise<unknown>;
}

export type OcrWorkerRuntimeDependencies<TResult> = {
    createWorker: (languages: string, onProgress: (progress: number, jobId: string) => void) => Promise<OcrWorkerPort<TResult>>;
    sparseTextMode: string | number;
};

function normalizeLanguages(languages: string): string {
    const normalized = languages
        .split('+')
        .map(language => language.trim())
        .filter(Boolean);
    if (normalized.length === 0 || normalized.some(language => !/^[a-z][a-z0-9_]*$/iu.test(language))) {
        throw new Error('图片 OCR 语言包配置无效，请重新下载语言包');
    }
    return [...new Set(normalized)].join('+');
}

export type OcrWorkerRuntime<TResult> = {
    recognize: (image: string, languages: string, signal?: AbortSignal, pageSegmentationMode?: string | number, onProgress?: (percent: number) => void) => Promise<TResult>;
    clearModels: (remove: () => Promise<void>) => Promise<void>;
    ensureLanguages: (languages: string[], signal?: AbortSignal) => Promise<void>;
    dispose: () => void;
};

function createOcrAbortError(): Error {
    const error = new Error('图片 OCR 请求已取消');
    error.name = 'AbortError';
    return error;
}

/**
 * 串行化所有 Worker 操作，避免语言切换终止仍在识别的 Worker，也避免同一
 * Worker 的 setParameters/recognize 被另一次请求交叉覆盖。
 */
export function createOcrWorkerRuntime<TResult>(
    dependencies: OcrWorkerRuntimeDependencies<TResult>,
): OcrWorkerRuntime<TResult> {
    let workerPromise: Promise<OcrWorkerPort<TResult>> | null = null;
    let workerLanguages = '';
    let loadedLanguages = new Set<string>();
    let configuredWorker: OcrWorkerPort<TResult> | null = null;
    let configuredMode: string | number | undefined;
    let workerOwnershipGeneration = 0;
    const runInOcrQueue = createLocalInferenceBudget(1);
    let jobSequence = 0;
    let activeProgress: {jobId: string; last: number; signal: AbortSignal; notify?: (percent: number) => void} | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const operations = new Set<AbortController>();
    function clearIdle(): void {clearTimeout(idleTimer); idleTimer = undefined;}
    function keepWarm(): void {
        if (disposed || operations.size || !workerPromise) return;
        const timer = setTimeout(() => {
            if (idleTimer !== timer) return;
            idleTimer = undefined;
            terminateCurrentWorker();
        }, localModelIdleMs());
        idleTimer = timer;
    }
    const reportWorkerProgress = (progress: number, jobId: string) => {
        const active = activeProgress;
        if (!active || active.jobId !== jobId || active.signal.aborted
            || !Number.isFinite(progress) || progress < 0 || progress > 1) return;
        const percent = Math.floor(progress * 100);
        if (percent <= active.last) return;
        active.last = percent;
        try { active.notify?.(percent); } catch { /* 进度展示不能中断识别主链。 */ }
    };

    function terminateCurrentWorker(): void {
        clearIdle();
        const current = workerPromise;
        workerPromise = null;
        workerLanguages = '';
        loadedLanguages.clear();
        configuredWorker = null;
        workerOwnershipGeneration += 1;
        // terminate 本身也可能等待底层 Worker；取消请求不能继续阻塞串行尾链。
        void current?.then(worker => worker.terminate()).catch(() => undefined);
    }

    function runAbortable<T>(operation: Promise<T>, signal: AbortSignal, ownsWorker = true): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const cleanup = () => signal.removeEventListener('abort', handleAbort);
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            const handleAbort = () => finish(() => {
                if (ownsWorker) terminateCurrentWorker();
                reject(createOcrAbortError());
            });

            // 即使 signal 已取消，也接住底层迟到的拒绝，避免遗留未处理 Promise。
            void operation.then(
                value => finish(() => resolve(value)),
                error => finish(() => reject(error)),
            );
            if (signal.aborted) {
                handleAbort();
                return;
            }
            signal.addEventListener('abort', handleAbort, {once: true});
        });
    }

    function runExclusive<T>(operation: (operationSignal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (disposed) return Promise.reject(createOcrAbortError());
        clearIdle();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, {once: true});
        if (signal?.aborted) cancel();
        operations.add(controller);
        const execute = async () => {
            if (controller.signal.aborted) throw createOcrAbortError();
            return operation(controller.signal);
        };
        // 已取消的等待者从队列移除；在运行的 OCR 或模型清理仍持槽直到退出。
        // 保留下一微任务启动，避免与既有调用时序和同步取消重入产生变化。
        const result = runInOcrQueue(() => Promise.resolve().then(execute), controller.signal).finally(() => {
            signal?.removeEventListener('abort', cancel);
            operations.delete(controller);
            keepWarm();
        });
        // 运行中的底层操作可能还在退出，调用方取消时仍须立即停止等待。
        return runAbortable(result, controller.signal, false);
    }

    async function getWorker(languages: string): Promise<OcrWorkerPort<TResult>> {
        if (workerPromise && workerLanguages === languages) return workerPromise;

        if (workerPromise) {
            const previousWorkerPromise = workerPromise;
            const ownershipGeneration = workerOwnershipGeneration;
            const assertTransitionOwnership = () => {
                if (workerOwnershipGeneration !== ownershipGeneration
                    || workerPromise !== previousWorkerPromise) {
                    throw createOcrAbortError();
                }
            };
            const previousWorker = await previousWorkerPromise.catch(() => null);
            assertTransitionOwnership();
            const nextLanguages = new Set([...loadedLanguages, ...languages.split('+')]);
            if (previousWorker?.reinitialize && nextLanguages.size <= 5) {
                configuredWorker = null;
                try {
                    // Tesseract 保留原 OEM 和初始化配置，只加载尚未存在于 Worker 的模型。
                    await previousWorker.reinitialize(languages);
                    assertTransitionOwnership();
                    workerLanguages = languages;
                    loadedLanguages = nextLanguages;
                    return previousWorker;
                } catch (error) {
                    // 旧操作取消后恢复时，不得销毁下一项已创建的 Worker。
                    if (workerPromise === previousWorkerPromise) terminateCurrentWorker();
                    throw error;
                }
            }
            await previousWorker?.terminate().catch(() => undefined);
            // 调用方 abort 会立即放行队列中的下一项；旧切换恢复后只能
            // 清理自己当时拥有的 Worker，不得覆盖新请求已安装的实例。
            assertTransitionOwnership();
            workerPromise = null;
            workerLanguages = '';
            configuredWorker = null;
        }

        const nextWorkerPromise = dependencies.createWorker(languages, reportWorkerProgress);
        workerPromise = nextWorkerPromise;
        workerLanguages = languages;
        loadedLanguages = new Set(languages.split('+'));

        try {
            return await nextWorkerPromise;
        } catch (error) {
            if (workerPromise === nextWorkerPromise) {
                workerPromise = null;
                workerLanguages = '';
                loadedLanguages.clear();
            }
            throw error;
        }
    }

    return {
        clearModels(remove) {
            return runExclusive(async signal => {
                const current = workerPromise;
                workerPromise = null;
                workerLanguages = '';
                loadedLanguages.clear();
                configuredWorker = null;
                workerOwnershipGeneration += 1;
                await current?.then(worker => worker.terminate());
                if (signal.aborted) throw createOcrAbortError();
                await remove();
            });
        },
        recognize(image, languages, signal, pageSegmentationMode = dependencies.sparseTextMode, onProgress) {
            return runExclusive(async signal => {
                const worker = await runAbortable(getWorker(normalizeLanguages(languages)), signal);
                if (configuredWorker !== worker || configuredMode !== pageSegmentationMode) {
                    // 设置失败时不再认为旧参数可信；下一任务必须重新配置。
                    configuredWorker = null;
                    await runAbortable(worker.setParameters({
                        tessedit_pageseg_mode: pageSegmentationMode,
                        preserve_interword_spaces: '1',
                        // 识别期诊断（分辨率估计、缺少可选 osd 模型等）不进控制台；失败仍以异常返回。
                        debug_file: '/dev/null',
                    }), signal);
                    configuredWorker = worker;
                    configuredMode = pageSegmentationMode;
                }
                const jobId = `fluent-read-ocr-${++jobSequence}`;
                activeProgress = {jobId, last: -1, signal, notify: onProgress};
                try {
                    return await runAbortable(worker.recognize(image, {}, {blocks: true}, jobId), signal);
                } finally {
                    activeProgress = null;
                }
            }, signal);
        },
        ensureLanguages(languages, signal) {
            if (languages.length === 0) return Promise.resolve();
            return runExclusive(async signal => {
                const normalized = normalizeLanguages(languages.join('+'));
                if (workerPromise && normalized.split('+').every(language => loadedLanguages.has(language))) {
                    // 预下载只保证模型已存在，不改变活跃识别语言，也不重复初始化已准备的包。
                    await runAbortable(workerPromise, signal);
                    return;
                }
                await runAbortable(getWorker(normalized), signal);
            }, signal);
        },
        dispose() {
            disposed = true;
            for (const operation of operations) operation.abort();
            terminateCurrentWorker();
        },
    };
}
