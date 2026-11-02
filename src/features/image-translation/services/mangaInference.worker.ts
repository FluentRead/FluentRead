/**
 * @file src/features/image-translation/services/mangaInference.worker.ts
 * 文件职责：在独立 Worker 中执行 PaddleOCR、气泡分析、LaMa 和可选离线 CTD 分割，保持 Offscreen 音频与消息线程响应。
 * 主要内容：按需复用已校验模型端口，真实下载和初始化阶段转发，CPU 重建锁定后端；CTD 只读已导入缓存，验证固定输入和全部输出元数据，量化独占 seg 后释放所有 ORT 张量；串行会话创建避免同一 Asyncify 运行时交错初始化。
 * 模块边界：不读取网页、不翻译文本、不播放音频；取消和超时由 Worker 外部 owner 硬终止。
 */
import * as ort from 'onnxruntime-web/webgpu';
import {forceSingleThreadInference, localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {configureOnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {createBrowserMangaOcr} from './mangaOcr';
import {createBrowserMangaInpainter} from './mangaInpainting';
import type {MangaInferenceMessage, MangaInferenceResponse} from './mangaInferenceClient';
import {loadMangaTextSegmentationAsset} from './mangaOcrAssets';

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
    let tail: Promise<void> = Promise.resolve(), creating: Promise<void> = Promise.resolve();
    const create = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = ((...args: Parameters<typeof create>) => {
        const result = creating.then(() => paceLocalInitialization(() => create(...args)));
        creating = result.then(() => undefined, () => undefined);
        return result;
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
    async function prepareSeg(progress:(stage:'preparing'|'initializing')=>void,cpu:boolean):Promise<boolean>{
        if(segmenter)return true;
        progress('preparing');let bytes:ArrayBuffer|undefined;
        try{bytes=await loadMangaTextSegmentationAsset();}
        catch(error){throw new SegmentationProtocolError(error instanceof Error?error.message:String(error),{cause:error});}
        if(!bytes)return false;
        progress('initializing');ort.env.wasm.numThreads=localWasmThreads();
        const url=(path:string)=>typeof chrome==='undefined'?new URL(path,self.location.href).href:chrome.runtime.getURL(path);
        configureOnnxWasmBackend(ort.env.wasm,{mjs:url('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'),wasm:url('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm')});
        const created=await ort.InferenceSession.create(bytes,{executionProviders:!cpu&&(navigator as Navigator&{gpu?:unknown}).gpu?['webgpu','wasm']:['wasm'],graphOptimizationLevel:'all'});
        if(created.inputNames.length!==1||created.inputNames[0]!=='images'||created.outputNames.length!==3||!SEG_OUTPUTS.every(([name],index)=>created.outputNames[index]===name)||!validMetadata(created.inputMetadata,[['images',[1,3,1024,1024]]])||!validMetadata(created.outputMetadata,SEG_OUTPUTS)){
            const error=new SegmentationProtocolError('图片分割模型元数据无效');
            // 保留准入错误；释放失败不能令未知模型成为有效会话。
            await created.release().catch(()=>undefined);throw error;
        }
        segmenter=created;return true;
    }
    async function segment(tensor:Float32Array):Promise<Uint8Array>{
        if(!(tensor instanceof Float32Array)||tensor.length!==3*SEG_SIZE||tensor.byteOffset!==0||!(tensor.buffer instanceof ArrayBuffer)||tensor.byteLength!==tensor.buffer.byteLength||!tensor.every(value=>Number.isFinite(value)&&value>=0&&value<=1))throw new SegmentationProtocolError('图片分割输入无效');
        const input=new ort.Tensor('float32',tensor,[1,3,1024,1024]);
        let outputs:ort.InferenceSession.ReturnType|undefined,owned:Uint8Array|undefined,failure:unknown,failed=false;
        try{
            outputs=await paceLocalInference(()=>segmenter!.run({images:input}));
            if(Object.keys(outputs).length!==3||!SEG_OUTPUTS.every(([name,shape])=>{const value=outputs![name];return value?.type==='float32'&&shapeIs(value.dims,shape)&&value.data instanceof Float32Array&&value.data.length===shape.reduce<number>((product,dimension)=>product*dimension,1);}))throw new SegmentationProtocolError('图片分割输出无效');
            const data=outputs.seg.data as Float32Array;
            if(!data.every(value=>Number.isFinite(value)&&value>=0&&value<=1))throw new SegmentationProtocolError('图片分割概率无效');
            owned=new Uint8Array(SEG_SIZE);
            for(let index=0;index<SEG_SIZE;index++)owned[index]=Math.fround(data[index]*255);
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
    async function handle(message: MangaInferenceMessage) {
        const requestId = message.requestId;
        try {
            if (message.cpu) {forceSingleThreadInference(); Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true});}
            const progress = (stage: 'preparing' | 'initializing' | 'recognizing', percent?: number) => post({requestId, stage, percent});
            let result: MangaInferenceResponse['result'];
            if (message.type === 'dispose-ocr') { await ocr?.destroy(); ocr = undefined; }
            else if (message.type === 'dispose-inpaint') { await painter?.release(); painter = undefined; }
            else if(message.type==='dispose-seg'){const current=segmenter;segmenter=undefined;await current?.release();}
            else if(message.type==='prepare-seg'||message.type==='segment'){
                const ready=await prepareSeg(progress,message.cpu);
                if(message.type==='prepare-seg')result=ready;
                else {if(!ready)throw new SegmentationProtocolError('图片分割模型未导入');progress('recognizing');result=await segment(message.tensor!);}
            }
            else if (message.type === 'prepare-ocr' || message.type === 'recognize') {
                ocr ??= await createBrowserMangaOcr(undefined, progress);
                if (message.type === 'recognize') { progress('recognizing'); result = await ocr.recognize(message.image!, {flatten: true, noCache: true, strategy: 'per-box',...(message.imageDetectionEvidence===true?{imageDetectionEvidence:true as const}:{})}); }
            } else {
                painter ??= await createBrowserMangaInpainter(undefined, (percent, initializing) => progress(initializing ? 'initializing' : 'preparing', percent));
                if (message.type === 'inpaint') { progress('recognizing'); result = await painter.run(message.patch!); }
            }
            post({requestId, success: true, result});
        } catch (error) { post({requestId, success: false, error: error instanceof Error ? error.message : String(error),...(['prepare-seg','segment','dispose-seg'].includes(message.type)?{errorKind:error instanceof SegmentationProtocolError?'protocol' as const:'execution' as const}:{})}); }
    }
    self.onmessage = (event: MessageEvent<MangaInferenceMessage>) => {
        const message = event.data;
        if (!message || !Number.isSafeInteger(message.requestId) || !['prepare-ocr', 'recognize', 'prepare-inpaint', 'inpaint', 'dispose-ocr', 'dispose-inpaint','prepare-seg','segment','dispose-seg'].includes(message.type)) return;
        tail = tail.then(() => handle(message));
    };
}
