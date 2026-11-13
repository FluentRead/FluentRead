/**
 * @file src/features/image-translation/services/mangaInferenceClient.ts
 * 文件职责：在 Offscreen 外部看守独立漫画推理 Worker，隔离 GPU 初始化挂起与原生推理阻塞。
 * 主要内容：串行请求和真实阶段转发；取消立即结束调用方等待，已开始的模型准备继续暖机、推理仅允许短暂收尾；错误与超时仍硬终止并仅重建一次 CPU Worker，复用共享并行预算；可选缓存分割先准备再按次借读有界 RGBA，由消息克隆快照，缩放与张量构造归 Worker；CPU 重试重新核对原图归属，分割端口独立三分钟空闲释放，旧消息不能影响新请求。
 * 后端选择：CPU 偏好从首次消息采用单线程 WASM 与 CPU 超时预算；偏好变化在串行边界重建 Worker，保留逻辑端口；仅记录当前阶段和最近成功会话的执行提供程序，不记录图片或文字。
 * 模块边界：不处理图片像素、不下载模型、不操作宿主页；静态 Worker 只读取同源缓存和包内代码。
 */
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {withMangaModelAdmission} from './mangaOcrAssets';
import type {MangaOcrPage} from './mangaBubbles';
import {isImageTextSegmentationSource,type ImageTextSegmentationSource} from './imageTextSegmentation';
export interface MangaPatch {image: Float32Array; mask: Float32Array; width: number; height: number}

export type MangaInferenceProgress = (stage: 'preparing' | 'initializing' | 'recognizing', percent?: number) => void;
export type MangaInferenceRequest = {type: 'prepare-ocr' | 'recognize' | 'prepare-inpaint' | 'inpaint' | 'dispose-ocr' | 'dispose-inpaint' | 'prepare-seg' | 'segment' | 'dispose-seg'; image?: string; patch?: MangaPatch;imageDetectionEvidence?:true;mangaParagraphGapEvidence?:true; source?:ImageTextSegmentationSource};
export type MangaInferenceMessage = MangaInferenceRequest & {requestId: number; cpu: boolean};
export interface MangaInferenceResponse {requestId: number; stage?: Parameters<MangaInferenceProgress>[0]; percent?: number; executionProviders?: Array<'webgpu' | 'wasm'>; success?: boolean; result?: MangaOcrPage | Float32Array | Uint8Array | boolean; error?: string; errorKind?:'protocol'|'execution'}
export interface MangaInferenceDiagnostics {
    preference: 'auto' | 'cpu';
    cpuFallback: boolean;
    stage: Parameters<MangaInferenceProgress>[0] | 'idle' | 'completed' | 'canceled' | 'error';
    executionProviders: Array<'webgpu' | 'wasm'>;
}

/** 协议/缓存完整性错误不能被误判为 GPU 故障后重复读取或分配输入。 */
export class MangaSegmentationProtocolError extends Error { override name='MangaSegmentationProtocolError'; }

const CANCEL_DRAIN_MS = 1_500;
const WARM_IDLE_MS = 180_000;

export function mangaExtensionUrl(path: string): string {
    return typeof chrome === 'undefined' ? new URL(path, self.location.href).href : chrome.runtime.getURL(path);
}

export function createMangaInferenceClient(createWorker: () => Worker) {
    let worker: Worker | undefined, cpu = false, sequence = 0;
    let preference: 'auto' | 'cpu' = 'auto';
    let workerPreference: 'auto' | 'cpu' = 'auto';
    let stage: MangaInferenceDiagnostics['stage'] = 'idle';
    let executionProviders: MangaInferenceDiagnostics['executionProviders'] = [];
    let tail: Promise<void> = Promise.resolve();
    let active: {reject(error: Error): void} | undefined;
    let generation = 0;
    let warmIdle: ReturnType<typeof setTimeout> | undefined;
    let orphanWarm = false;
    let segIdle:ReturnType<typeof setTimeout>|undefined,segEpoch=0;
    const ports = new Set<string>();
    function clearSegIdle(){clearTimeout(segIdle);segIdle=undefined;segEpoch++;}
    function clearWarmIdle() { clearTimeout(warmIdle); warmIdle = undefined; }
    function admitted<T>(owner:number,operation:()=>Promise<T>):Promise<T>{
        return withMangaModelAdmission(()=>{
            if(owner!==generation)throw new DOMException('漫画处理已取消','AbortError');
            return operation();
        });
    }
    function terminate() { clearWarmIdle();clearSegIdle();ports.delete('seg'); orphanWarm = false; const current = worker; worker = undefined; executionProviders = []; current?.terminate(); }
    function keepSegWarm(){
        clearSegIdle();const current=worker,epoch=segEpoch;
        if(!current||!ports.has('seg'))return;
        segIdle=setTimeout(()=>{
            const result=tail.then(()=>withLocalInferenceBudget(async()=>{
                if(worker!==current||segEpoch!==epoch)return;
                ports.delete('seg');await attempt<void>({type:'dispose-seg'});
                if(!ports.size){terminate();cpu=false;}
            }));
            tail=result.then(()=>undefined,()=>undefined);
            // 无调用方的定时释放故障仍报告；attempt 已硬终止失败 owner，不保留失效会话。
            void result.catch(error=>console.warn('图片分割空闲释放失败',error));
        },WARM_IDLE_MS);
    }
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
        if (!worker) { cpu = cpu || preference === 'cpu'; workerPreference = preference; }
        const current = worker ??= createWorker(), requestId = ++sequence;
        if (ports.has('seg') && !segIdle) keepSegWarm();
        if (!message.type.startsWith('dispose')) stage = message.type.startsWith('prepare') ? 'preparing' : 'initializing';
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
                    if(message.type==='prepare-seg'&&result===true||message.type==='segment'){ports.add('seg');keepSegWarm();}
                    keepWarm(current);
                }
                if (canceled) error = new DOMException('漫画处理已取消', 'AbortError');
                if (!message.type.startsWith('dispose')) stage = canceled ? 'canceled' : error ? 'error' : 'completed';
                error ? reject(error) : resolve(result as T);
            }
            const abort = () => {
                canceled = true;
                stage = 'canceled';
                // prepare 没有页面推理，可复用正在进行的下载和初始化；原有阶段看守仍生效。
                // 原生推理无法中断，仅给已执行任务短暂收尾，不能一直阻挡新页面。
                if (!message.type.startsWith('prepare')) drain = setTimeout(() => finish(undefined, true), CANCEL_DRAIN_MS);
            };
            active = {reject: error => finish(error, true)};
            current.onmessage = (event: MessageEvent<MangaInferenceResponse>) => {
                if (settled || worker !== current || event.data?.requestId !== requestId) return;
                const response = event.data;
                if (response.executionProviders) {
                    executionProviders = response.executionProviders.filter(value => value === 'webgpu' || value === 'wasm');
                    if (!response.stage && response.success === undefined) return;
                }
                if (response.stage) {
                    if (!canceled) stage = response.stage;
                    // 下载是网络等待；不能因为大模型超过 15 秒就误判为 GPU 挂起并重复下载。
                    watch(response.stage === 'preparing' ? 120_000 : cpu ? 120_000 : response.stage === 'initializing' ? 15_000 : 60_000);
                    if (!canceled) progress?.(response.stage, response.percent); return;
                }
                const segmentation=message.type==='segment'||message.type==='prepare-seg';
                if(response.success&&segmentation&&!(message.type==='prepare-seg'?typeof response.result==='boolean':response.result instanceof Uint8Array&&response.result.length===1024*1024&&response.result.byteOffset===0&&response.result.buffer instanceof ArrayBuffer&&response.result.byteLength===response.result.buffer.byteLength)){
                    finish(new MangaSegmentationProtocolError('图片分割返回值无效'),true);return;
                }
                finish(response.success ? undefined : response.errorKind==='protocol'?new MangaSegmentationProtocolError(response.error || '图片分割协议错误'):new Error(response.error || '漫画推理失败'), !response.success, response.result as T);
            };
            current.onerror = event => { if (worker === current) finish(new Error(event.message || '漫画推理 Worker 已停止'), true); };
            signal?.addEventListener('abort', abort, {once: true});
            watch(message.type.startsWith('dispose') ? 10_000 : cpu || message.type.startsWith('prepare') ? 120_000 : 60_000);
            // RGBA 仍供原图保护和绘字使用；消息克隆快照，不能转移它的 buffer。
            try { current.postMessage({...message,requestId,cpu}); }
            catch (error) { finish(error instanceof Error ? error : new Error(String(error)), true); }
        });
    }
    function request<T>(message: MangaInferenceRequest, signal?: AbortSignal, progress?: MangaInferenceProgress,inputFactory?:()=>ImageTextSegmentationSource): Promise<T> {
        const owner = generation;
        const result = tail.then(() => withLocalInferenceBudget(async () => {
            if(owner !== generation) throw new DOMException('漫画处理已取消','AbortError');
            if (workerPreference !== preference) {
                // 只在上一请求结束后切换；已有代理端口由新 Worker 按需重建真实会话。
                const segmented = ports.has('seg');
                terminate();
                if (segmented) ports.add('seg');
                cpu = preference === 'cpu'; workerPreference = preference;
            }
            // 工厂异常保持原对象，且不进入设备重试；排队取消/代次失效不读取原图。
            const input=()=>{
                if(!inputFactory)return message;
                if(signal?.aborted)throw new DOMException('漫画处理已取消','AbortError');
                const source=inputFactory();
                if(!isImageTextSegmentationSource(source))throw new MangaSegmentationProtocolError('图片分割输入无效');
                return {...message,source};
            };
            const initial=input();
            try { return await attempt<T>(initial, signal, progress); }
            catch (error) {
                if (owner !== generation || cpu || signal?.aborted || message.type.startsWith('dispose')||error instanceof MangaSegmentationProtocolError) throw error;
                cpu = true; progress?.('initializing');
                return await attempt<T>(input(), signal, progress);
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
        setBackend(value: 'auto' | 'cpu') { preference = value; },
        getDiagnostics(): MangaInferenceDiagnostics {
            return {preference, cpuFallback: preference === 'auto' && cpu, stage, executionProviders: [...executionProviders]};
        },
        async prepare(kind: 'ocr' | 'inpaint', signal?: AbortSignal, progress?: MangaInferenceProgress) {
            const owner = generation;
            await request({type: `prepare-${kind}`}, signal, progress);
            if (owner !== generation || signal?.aborted) throw new DOMException('漫画处理已取消', 'AbortError');
            ports.add(kind); orphanWarm = false; clearWarmIdle();
        },
        request,
        async prepareTextSegmentation(signal?:AbortSignal,progress?:MangaInferenceProgress):Promise<boolean>{
            clearSegIdle();const owner=generation;
            try{
                const ready=await admitted(owner,()=>request<boolean>({type:'prepare-seg'},signal,progress));
                if(owner!==generation||signal?.aborted)throw new DOMException('漫画处理已取消','AbortError');
                if(ready){ports.add('seg');orphanWarm=false;clearWarmIdle();}
                return ready;
            }finally{if(owner===generation)keepSegWarm();}
        },
        async segmentText(inputFactory:()=>ImageTextSegmentationSource,signal?:AbortSignal,progress?:MangaInferenceProgress):Promise<Uint8Array>{
            clearSegIdle();
            if(!ports.has('seg'))throw new MangaSegmentationProtocolError('图片分割尚未准备');
            const owner=generation;
            try{return await admitted(owner,()=>request<Uint8Array>({type:'segment'},signal,progress,inputFactory));}
            finally{if(owner===generation)keepSegWarm();}
        },
        async release(kind: 'ocr' | 'inpaint'|'seg') { if(kind==='seg')clearSegIdle();ports.delete(kind); if (worker) await request({type: `dispose-${kind}`});if(kind==='seg')ports.delete(kind); if (!ports.size) { terminate(); cpu = false; } },
        dispose() { generation++; active?.reject(new DOMException('漫画处理已取消', 'AbortError')); terminate(); ports.clear(); cpu = false; stage = 'idle'; },
    };
}

export const mangaInferenceClient = createMangaInferenceClient(() => new Worker(mangaExtensionUrl('mangaInferenceWorker.js'), {type: 'module'}));
