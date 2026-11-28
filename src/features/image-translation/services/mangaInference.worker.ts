/**
 * @file src/features/image-translation/services/mangaInference.worker.ts
 * 文件职责：在独立 Worker 中执行 PaddleOCR、气泡分析、LaMa 和可选离线 CTD 分割，保持 Offscreen 音频与消息线程响应。
 * 主要内容：按需复用已校验模型端口，真实下载和初始化阶段转发，CPU 重建锁定后端；按请求维护 AbortController 响应客户端协作取消消息，排队取消在懒加载模型前即刻退出，推理与分割在进入算子前复核取消并在中止后回报 aborted 保留温热会话，若回退期间原会话已损毁则立即清理对应端口以便后续重建；CTD 只读已导入缓存，接收有界 RGBA 快照并在本线程执行低通缩放与张量构造，验证固定模型元数据，单遍内联循环核验概率并量化独占 seg 后释放所有 ORT 张量；串行会话创建避免同一 Asyncify 运行时交错初始化。
 * 诊断：会话创建成功后报告该会话配置的执行提供程序，并通过轻量订阅实时同步 Worker 内模型下载进度与状态，标记资源下载错误为 `asset` 以避免误触发 CPU 回退；不推断混合后端中每个算子的实际设备，也不传输模型或图片内容。
 * 模块边界：不读取网页、不翻译文本、不播放音频；协作取消优先提前结束当前推理，单次同步算子超时仍由外部 owner 硬终止。
 */
import * as ort from 'onnxruntime-web/webgpu';
import {forceSingleThreadInference, localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {assertOnnxWasmRuntimeSupported, configureOnnxWasmBackend, resolveOnnxWasmAssetPaths} from '@/src/shared/onnx/wasmBinary';
import {createBrowserMangaOcr} from './mangaOcr';
import {createBrowserMangaInpainter} from './mangaInpainting';
import type {MangaInferenceMessage, MangaInferenceResponse} from './mangaInferenceClient';
import {loadMangaTextSegmentationAsset, MangaModelAssetError, subscribeMangaDownloadState} from './mangaOcrAssets';
import {createImageTextSegmentationInput,isImageTextSegmentationSource,type ImageTextSegmentationSource} from './imageTextSegmentation';

class SegmentationProtocolError extends Error {}
const SEG_SIZE=1024*1024;
const SEG_OUTPUTS=[['blk',[1,64512,7]],['seg',[1,1,1024,1024]],['det',[1,2,1024,1024]]] as const;
function shapeIs(actual:readonly(number|string)[],expected:readonly number[]):boolean{return actual.length===expected.length&&actual.every((value,index)=>value===expected[index]);}
function validMetadata(actual:readonly ort.InferenceSession.ValueMetadata[],expected:readonly(readonly[string,readonly number[]])[]):boolean{
    return Array.isArray(actual)&&actual.length===expected.length&&expected.every(([name,shape],index)=>{
        const value=actual[index];return value.name===name&&value.isTensor&&value.type==='float32'&&shapeIs(value.shape,shape);
    });
}

export function startMangaInferenceWorker(): void {
    let ocr: Awaited<ReturnType<typeof createBrowserMangaOcr>> | undefined;
    let painter: Awaited<ReturnType<typeof createBrowserMangaInpainter>> | undefined;
    let segmenter:ort.InferenceSession|undefined;
    let ocrBroken = false, painterBroken = false;
    let tail: Promise<void> = Promise.resolve(), creating: Promise<void> = Promise.resolve();
    let currentRequestId: number | undefined;
    const controllers = new Map<number, AbortController>();
    const abortError = () => new DOMException('漫画处理已取消', 'AbortError');
    const ignore = () => undefined;
    const create = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = ((...args: Parameters<typeof create>) => {
        const result = creating.then(() => paceLocalInitialization(() => create(...args)));
        creating = result.then(() => undefined, () => undefined);
        return result.then(session => {
            const options = args.at(-1) as ort.InferenceSession.SessionOptions | undefined;
            const executionProviders = options?.executionProviders?.map(value => typeof value === 'string' ? value : value.name)
                .filter((value): value is 'webgpu' | 'wasm' => value === 'webgpu' || value === 'wasm');
            if (executionProviders?.length) post({requestId: currentRequestId!, executionProviders});
            return session;
        });
    }) as typeof create;
    const scope = self as unknown as {postMessage(message: MangaInferenceResponse, transfer: Transferable[]): void};
    const post = (response: MangaInferenceResponse) => {
        const transfer:Transferable[]=[],result=response.result;
        if(result instanceof Float32Array||result instanceof Uint8Array){if(result.buffer instanceof ArrayBuffer)transfer.push(result.buffer);}
        else {
            const frames=result&&typeof result==='object'?result.imageDetectionFrames:undefined;
            if(frames?.length){
                const seen=new Set<ArrayBuffer>();
                for(const frame of frames)if(frame.bits.buffer instanceof ArrayBuffer&&!seen.has(frame.bits.buffer)){
                    seen.add(frame.bits.buffer);transfer.push(frame.bits.buffer);
                }
            }
        }
        scope.postMessage(response,transfer);
    };
    subscribeMangaDownloadState(download => { if (currentRequestId !== undefined) post({requestId: currentRequestId, download: download ?? null}); });
    async function prepareSeg(progress:(stage:'preparing'|'initializing')=>void,cpu:boolean):Promise<boolean>{
        if(segmenter)return true;
        assertOnnxWasmRuntimeSupported();
        progress('preparing');let bytes:ArrayBuffer|undefined;
        try{bytes=await loadMangaTextSegmentationAsset();}
        catch(error){throw new SegmentationProtocolError(error instanceof Error?error.message:String(error),{cause:error});}
        if(!bytes)return false;
        progress('initializing');ort.env.wasm.numThreads=localWasmThreads();
        const url=(path:string)=>typeof chrome==='undefined'?new URL(path,self.location.href).href:chrome.runtime.getURL(path);
        configureOnnxWasmBackend(ort.env.wasm,resolveOnnxWasmAssetPaths(url,{leadingSlash:true}));
        const created=await ort.InferenceSession.create(bytes,{executionProviders:!cpu&&(navigator as Navigator&{gpu?:unknown}).gpu?['webgpu','wasm']:['wasm'],graphOptimizationLevel:'all'});
        if(created.inputNames.length!==1||created.inputNames[0]!=='images'||created.outputNames.length!==3||!SEG_OUTPUTS.every(([name],index)=>created.outputNames[index]===name)||!validMetadata(created.inputMetadata,[['images',[1,3,1024,1024]]])||!validMetadata(created.outputMetadata,SEG_OUTPUTS)){
            const error=new SegmentationProtocolError('图片分割模型元数据无效');
            // 保留准入错误；释放失败不能令未知模型成为有效会话。
            await created.release().catch(()=>undefined);throw error;
        }
        segmenter=created;return true;
    }
    async function segment(source:ImageTextSegmentationSource,signal:AbortSignal):Promise<Uint8Array>{
        if(!isImageTextSegmentationSource(source))throw new SegmentationProtocolError('图片分割输入无效');
        const tensor=createImageTextSegmentationInput(source.pixels,source.width,source.height);
        const input=new ort.Tensor('float32',tensor,[1,3,1024,1024]);
        let outputs:ort.InferenceSession.ReturnType|undefined,owned:Uint8Array|undefined,failure:unknown,failed=false;
        try{
            outputs=await paceLocalInference(()=>{if(signal.aborted)throw abortError();return segmenter!.run({images:input});});
            if(signal.aborted)throw abortError();
            if(Object.keys(outputs).length!==3||!SEG_OUTPUTS.every(([name,shape])=>{const value=outputs![name];return value?.type==='float32'&&shapeIs(value.dims,shape)&&value.data instanceof Float32Array&&value.data.length===shape.reduce<number>((product,dimension)=>product*dimension,1);}))throw new SegmentationProtocolError('图片分割输出无效');
            const data=outputs.seg.data as Float32Array;
            owned=new Uint8Array(SEG_SIZE);
            for(let index=0;index<SEG_SIZE;index++){
                const value=data[index];
                if(!(value>=0&&value<=1))throw new SegmentationProtocolError('图片分割概率无效');
                owned[index]=Math.fround(value*255);
            }
        } catch(error) {
            failed=true;failure=error;
        }
        // 每个真实 ORT 张量恰好释放一次，包括未使用的 blk/det。
        // 先保存成功结果/首因再统一清理；包括 throw undefined 在内的异常均不可变成成功。
        for(const value of new Set([input,...Object.values(outputs||{})])) {
            try{value.dispose();}
            catch(error){if(!failed){failed=true;failure=error;}}
        }
        if(failed)throw failure;
        return owned!;
    }
    async function handle(message: MangaInferenceMessage, controller: AbortController) {
        const requestId = message.requestId;
        const signal = controller.signal;
        currentRequestId = requestId;
        let response: MangaInferenceResponse;
        try {
            if (message.cpu) {forceSingleThreadInference(); Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true});}
            const progress = (stage: 'preparing' | 'initializing' | 'recognizing', percent?: number) => post({requestId, stage, percent});
            let result: MangaInferenceResponse['result'];
            if (message.type === 'dispose-ocr') { await ocr?.destroy(); ocr = undefined; }
            else if (message.type === 'dispose-inpaint') { await painter?.release(); painter = undefined; }
            else if(message.type==='dispose-seg'){const current=segmenter;segmenter=undefined;await current?.release();}
            else if(message.type==='prepare-seg'||message.type==='segment'){
                if(message.type==='segment'&&signal.aborted)throw abortError();
                const ready=await prepareSeg(progress,message.cpu);
                if(message.type==='prepare-seg')result=ready;
                else {if(signal.aborted)throw abortError();if(!ready)throw new SegmentationProtocolError('图片分割模型未导入');progress('recognizing');result=await segment(message.source!,signal);}
            }
            else if (message.type === 'prepare-ocr' || message.type === 'recognize') {
                if (message.type === 'recognize' && signal.aborted) throw abortError();
                ocr ??= await createBrowserMangaOcr(undefined, progress, () => { ocrBroken = true; });
                if (message.type === 'recognize') { if(signal.aborted)throw abortError(); progress('recognizing'); result = await ocr.recognize(message.image!, {flatten: true, noCache: true, strategy: 'per-box', signal, ...(message.profile?{profile:message.profile}:{}), ...(message.imageDetectionEvidence===true?{imageDetectionEvidence:true as const}:{}),...(message.mangaParagraphGapEvidence===true?{mangaParagraphGapEvidence:true as const}:{})}); }
            } else {
                if (message.type === 'inpaint' && signal.aborted) throw abortError();
                painter ??= await createBrowserMangaInpainter(undefined, (percent, initializing) => progress(initializing ? 'initializing' : 'preparing', percent), () => { painterBroken = true; });
                if (message.type === 'inpaint') { if(signal.aborted)throw abortError(); progress('recognizing'); result = await painter.run(message.patch!, signal); }
            }
            if (signal.aborted) throw abortError();
            response = {requestId, success: true, result};
        } catch (error) {
            const aborted = signal.aborted && (error as {name?: unknown} | null | undefined)?.name === 'AbortError';
            const isSeg = ['prepare-seg','segment','dispose-seg'].includes(message.type);
            const isAsset = !isSeg && (error instanceof MangaModelAssetError || (error as {name?: unknown} | null | undefined)?.name === 'QuotaExceededError');
            response = {requestId, success: false, ...(aborted ? {aborted: true} : {}), error: error instanceof Error ? error.message : String(error),
                ...(isSeg ? {errorKind: error instanceof SegmentationProtocolError ? 'protocol' as const : 'execution' as const}
                    : isAsset ? {errorKind: 'asset' as const} : {})};
        } finally {
            if (ocrBroken) {
                ocrBroken = false;
                const broken = ocr!; ocr = undefined;
                await Promise.resolve().then(() => broken.destroy()).catch(ignore);
            }
            if (painterBroken) {
                painterBroken = false;
                const broken = painter!; painter = undefined;
                await Promise.resolve().then(() => broken.release()).catch(ignore);
            }
            controllers.delete(requestId);
        }
        post(response);
    }
    self.onmessage = (event: MessageEvent<MangaInferenceMessage>) => {
        const message = event.data;
        if (!message || !Number.isSafeInteger(message.requestId)) return;
        if (message.type === 'cancel') { controllers.get(message.requestId)?.abort(); return; }
        if (!['prepare-ocr', 'recognize', 'prepare-inpaint', 'inpaint', 'dispose-ocr', 'dispose-inpaint','prepare-seg','segment','dispose-seg'].includes(message.type)) return;
        const controller = new AbortController();
        controllers.set(message.requestId, controller);
        tail = tail.then(() => handle(message, controller));
    };
}
