/**
 * @file src/features/image-translation/services/mangaInferenceClient.ts
 * 文件职责：在 Offscreen 外部看守独立漫画推理 Worker，隔离 GPU 初始化挂起与原生推理阻塞。
 * 主要内容：串行请求和真实阶段转发；取消立即结束调用方等待，已开始的模型准备继续暖机、推理仅允许短暂收尾；错误与超时仍硬终止并仅重建一次 CPU Worker，复用共享并行预算；无人持有的暖机 Worker 空闲三分钟后释放，旧消息不能影响新请求。
 * 模块边界：不处理图片像素、不下载模型、不操作宿主页；静态 Worker 只读取同源缓存和包内代码。
 */
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import type {MangaOcrPage} from './mangaBubbles';
export interface MangaPatch {image: Float32Array; mask: Float32Array; width: number; height: number}

export type MangaInferenceProgress = (stage: 'preparing' | 'initializing' | 'recognizing', percent?: number) => void;
export type MangaInferenceRequest = {type: 'prepare-ocr' | 'recognize' | 'prepare-inpaint' | 'inpaint' | 'dispose-ocr' | 'dispose-inpaint'; image?: string; patch?: MangaPatch;imageDetectionEvidence?:true};
export type MangaInferenceMessage = MangaInferenceRequest & {requestId: number; cpu: boolean};
export interface MangaInferenceResponse {requestId: number; stage?: Parameters<MangaInferenceProgress>[0]; percent?: number; success?: boolean; result?: MangaOcrPage | Float32Array; error?: string}

const CANCEL_DRAIN_MS = 1_500;
const WARM_IDLE_MS = 180_000;

export function mangaExtensionUrl(path: string): string {
    return typeof chrome === 'undefined' ? new URL(path, self.location.href).href : chrome.runtime.getURL(path);
}

export function createMangaInferenceClient(createWorker: () => Worker) {
    let worker: Worker | undefined, cpu = false, sequence = 0;
    let tail: Promise<void> = Promise.resolve();
    let active: {reject(error: Error): void} | undefined;
    let generation = 0;
    let warmIdle: ReturnType<typeof setTimeout> | undefined;
    let orphanWarm = false;
    const ports = new Set<string>();
    function clearWarmIdle() { clearTimeout(warmIdle); warmIdle = undefined; }
    function terminate() { clearWarmIdle(); orphanWarm = false; const current = worker; worker = undefined; current?.terminate(); }
    function keepWarm(current: Worker) {
        if (!orphanWarm || ports.size || worker !== current) return;
        clearWarmIdle();
        warmIdle = setTimeout(() => {
            // 新任务会在启动时清除此计时器；过期回调不得关闭另一代 Worker。
            if (worker === current && !active && !ports.size) { terminate(); cpu = false; }
        }, WARM_IDLE_MS);
    }
    function attempt<T>(message: MangaInferenceRequest, signal?: AbortSignal, progress?: MangaInferenceProgress): Promise<T> {
        if (signal?.aborted) return Promise.reject(new DOMException('漫画处理已取消', 'AbortError'));
        clearWarmIdle();
        const current = worker ??= createWorker(), requestId = ++sequence;
        return new Promise<T>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout>;
            let drain: ReturnType<typeof setTimeout> | undefined;
            let canceled = false, settled = false;
            function watch(ms: number) {
                clearTimeout(timeout);
                timeout = setTimeout(() => finish(new Error('漫画推理超时，已停止以保护浏览器性能'), true), ms);
            }
            function finish(error?: Error, reset = false, result?: T) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout); clearTimeout(drain); signal?.removeEventListener('abort', abort);
                current.onmessage = null; current.onerror = null; active = undefined;
                if (reset) terminate();
                else {
                    // prepare 的成功回复与调用方拿到端口之间，也可能发生取消或销毁。
                    if (canceled || message.type.startsWith('prepare')) orphanWarm = true;
                    keepWarm(current);
                }
                if (canceled) error = new DOMException('漫画处理已取消', 'AbortError');
                error ? reject(error) : resolve(result as T);
            }
            const abort = () => {
                canceled = true;
                // prepare 没有页面推理，可复用正在进行的下载和初始化；原有阶段看守仍生效。
                // 原生推理无法中断，仅给已执行任务短暂收尾，不能一直阻挡新页面。
                if (!message.type.startsWith('prepare')) drain = setTimeout(() => finish(undefined, true), CANCEL_DRAIN_MS);
            };
            active = {reject: error => finish(error, true)};
            current.onmessage = (event: MessageEvent<MangaInferenceResponse>) => {
                if (settled || worker !== current || event.data?.requestId !== requestId) return;
                const response = event.data;
                if (response.stage) {
                    // 下载是网络等待；不能因为大模型超过 15 秒就误判为 GPU 挂起并重复下载。
                    watch(response.stage === 'preparing' ? 120_000 : cpu ? 120_000 : response.stage === 'initializing' ? 15_000 : 60_000);
                    if (!canceled) progress?.(response.stage, response.percent); return;
                }
                finish(response.success ? undefined : new Error(response.error || '漫画推理失败'), !response.success, response.result as T);
            };
            current.onerror = event => { if (worker === current) finish(new Error(event.message || '漫画推理 Worker 已停止'), true); };
            signal?.addEventListener('abort', abort, {once: true});
            watch(message.type.startsWith('dispose') ? 10_000 : cpu || message.type.startsWith('prepare') ? 120_000 : 60_000);
            try { current.postMessage({...message, requestId, cpu}); }
            catch (error) { finish(error instanceof Error ? error : new Error(String(error)), true); }
        });
    }
    function request<T>(message: MangaInferenceRequest, signal?: AbortSignal, progress?: MangaInferenceProgress): Promise<T> {
        const owner = generation;
        const result = tail.then(() => withLocalInferenceBudget(async () => {
            if(owner !== generation) throw new DOMException('漫画处理已取消','AbortError');
            try { return await attempt<T>(message, signal, progress); }
            catch (error) {
                if (owner !== generation || cpu || signal?.aborted || message.type.startsWith('dispose')) throw error;
                cpu = true; progress?.('initializing');
                return await attempt<T>(message, signal, progress);
            }
        }, signal));
        tail = result.then(() => undefined, () => undefined);
        if(!signal) return result;
        return new Promise<T>((resolve,reject)=>{
            const abort=()=>reject(new DOMException('漫画处理已取消','AbortError'));
            signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
            void result.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
        });
    }
    return {
        async prepare(kind: 'ocr' | 'inpaint', signal?: AbortSignal, progress?: MangaInferenceProgress) {
            const owner = generation;
            await request({type: `prepare-${kind}`}, signal, progress);
            if (owner !== generation || signal?.aborted) throw new DOMException('漫画处理已取消', 'AbortError');
            ports.add(kind); orphanWarm = false; clearWarmIdle();
        },
        request,
        async release(kind: 'ocr' | 'inpaint') { ports.delete(kind); if (worker) await request({type: `dispose-${kind}`}); if (!ports.size) { terminate(); cpu = false; } },
        dispose() { generation++; active?.reject(new DOMException('漫画处理已取消', 'AbortError')); terminate(); ports.clear(); cpu = false; },
    };
}

export const mangaInferenceClient = createMangaInferenceClient(() => new Worker(mangaExtensionUrl('mangaInferenceWorker.js'), {type: 'module'}));
