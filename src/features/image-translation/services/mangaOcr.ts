/**
 * @file src/features/image-translation/services/mangaOcr.ts
 * 文件职责：在扩展独立 Worker 中按需运行 PaddleOCR 漫画识别，并隔离排队、取消、失败和空闲释放。
 * 主要内容：延迟导入浏览器 OCR 和本地 ONNX WASM，用频繁读取的画布完成 OCR 预处理，透明像素仅在识别画布上按前景亮度合成对比底色，读取已校验模型并融合 ONNX 执行图，硬件可用时加速识别，GPU 故障有界切换 CPU；SVG 复用已解码原图异步转为无损 PNG 后进入 Worker，取消或失败释放自有画布且保留借用原图；大图以有重叠的原像素瓦片识别并按物理行去重，整页原文与放大的独立气泡共同参与可靠性回退，竖列与纯像素估角的浅底斜行共用每页四框复识别预算，斜行只以高置信且有增益的原框结果替换，预处理另有像素预算，普通图片保留物理行供严格段落策略使用；滚动取消保留轻量模型端口，Worker owner 有界收尾，GPU 挂起重建一次 CPU 后端，空闲三分钟释放会话，统一清理 OCR 与修补会话。
 * 检测裁切：通过 SDK 公开处理器入口按原始字行短边计算留白，检测平面短边不足十二像素时保留原高度留白，不丢弃细小框；沿用原裁边、舍入与缩放顺序，水平框保持原语义，竖列不因列长吞入邻列和注音；复用原会话和一次区域检测。低置信纯拉丁竖框用原配额尝试反向，CJK 保留原批次复识别，反向与斜行共用整页两百万预处理像素预算，超额框回原框识别；同一次气泡扫描额外输出大型曲边气泡的布局归属，不创建大型局部识别裁图。
 * 识别颜色：仅装饰原生识别缩放副本的一次既有读回，在完整不透明端点边缘和原页像素预算内补足红通道缺失对比；复用原会话，不改裁切、原图或检测输入，推理收尾恢复上下文，页级 finally 清理取消信号。
 * 模块边界：不访问宿主 DOM、不翻译文本、不处理译图；仅漫画及显式选择 PaddleOCR 的单张图片使用本模型；通用识别与圈选继续由 Tesseract 负责。
 */
import {localWasmThreads, paceLocalInference} from '@/src/shared/onnx/resources';
import {mangaInferenceClient, mangaExtensionUrl, type MangaInferenceProgress} from './mangaInferenceClient';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {protectMangaSession} from './mangaSessionFallback';
import {configureOnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {assertMangaOcrActive, loadMangaOcrAssets, removeMangaOcrAssets, withMangaModelAdmission, withMangaModelRemoval} from './mangaOcrAssets';
import type {MangaRegion} from './mangaRegions';
import {findMangaBubbleLayout,assignMangaLayoutBubbles,collectMangaRegions,type MangaOcrPage} from './mangaBubbles';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {flattenOcrAlpha} from './ocrPixels';
import {collectMangaOcrTileNumericEvidence,mergeMangaOcrTiles, planMangaOcrTiles, type MangaOcrTileResult} from './mangaOcrTiles';
import {numericProtection} from './mangaNumeric';
import {createMangaOcrColorAdapter,withMangaOcrColorRead} from './mangaOcrColor';
import {MANGA_DESKEW_PIXEL_BUDGET,planMangaOcrDeskew,trimMangaOcrDeskew} from './mangaOcrDeskew';

interface MangaOcrPort {
    recognize(image: string, options: {flatten: true; noCache: true; strategy: 'per-box';signal?:AbortSignal; decodedImage?: HTMLImageElement; progress?: MangaInferenceProgress}): Promise<MangaOcrPage>;
    destroy(): Promise<void>;
}
type Progress = MangaInferenceProgress;

/** 检测平面先按字行厚度留白，再沿用 SDK 的裁边、舍入和缩放顺序；不足十二像素的细框保留原高度留白及识别路径，不作小字过滤。 */
export function padMangaOcrDetectionBox(box:{x0:number;y0:number;x1:number;y1:number},width:number,height:number,
    padding?:{vertical?:number;horizontal?:number},scale=1) {
    let {x0,y0,x1,y1}=box;
    if(padding){
        const shortSide=Math.min(x1-x0,y1-y0),thickness=shortSide>=12?shortSide:y1-y0;
        const vertical=Math.round(thickness*(padding.vertical??0)),horizontal=Math.round(thickness*(padding.horizontal??0));
        x0=Math.max(0,x0-horizontal);y0=Math.max(0,y0-vertical);
        x1=Math.min(width,x1+horizontal);y1=Math.min(height,y1+vertical);
    }
    if(scale!==1){x0=Math.max(0,Math.round(x0*scale));y0=Math.max(0,Math.round(y0*scale));x1=Math.round(x1*scale);y1=Math.round(y1*scale);}
    return {x0,y0,x1,y1};
}

/** 只给模型已读到拉丁字母且不混 CJK 的低置信竖框尝试反向；数字、注音和日文仍走原批次复识别。 */
export function shouldRotateMangaOcrRetry(item:{text:string;confidence:number;box:{x:number;y:number;width:number;height:number}},width:number,height:number):boolean {
    const box=item.box;
    return item.confidence<.9&&box.height>box.width*1.8&&/\p{Script=Latin}/u.test(item.text)
        &&!/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u.test(item.text)
        &&[box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>=1
        &&box.x+box.width<=width&&box.y+box.height<=height;
}

/** 单队列持有模型会话，取消排队请求不能终止其他页正在使用的模型。 */
export function createMangaOcrRuntime(create: (signal?: AbortSignal, progress?: Progress) => Promise<MangaOcrPort>) {
    let service: MangaOcrPort | undefined;
    let tail: Promise<void> = Promise.resolve();
    let idle: ReturnType<typeof setTimeout> | undefined;
    function clearIdle() { clearTimeout(idle); idle = undefined; }
    async function release() {
        clearIdle(); const current = service; service = undefined;
        await current?.destroy();
    }
    function queue<T>(operation: () => Promise<T>): Promise<T> {
        const result = tail.then(operation);
        tail = result.then(() => undefined, () => undefined);
        return result;
    }
    return {
        recognize(image: string, language: string, width: number, height: number, signal?: AbortSignal, progress?: Progress, decodedImage?: HTMLImageElement, profile: 'manga' | 'image' = 'manga'): Promise<MangaRegion[]> {
            const result = withMangaModelAdmission(() => queue(async () => {
                assertMangaOcrActive(signal); clearIdle();
                try {
                    return await (async () => {
                        if (!service) {
                            progress?.('preparing', 0);
                            service = await create(signal, progress);
                        }
                        assertMangaOcrActive(signal); progress?.('recognizing');
                        const response = await service.recognize(image, {flatten: true, noCache: true, strategy: 'per-box',signal, decodedImage, progress});
                        assertMangaOcrActive(signal);
                        return collectMangaRegions(response, language, width, height, profile);
                    })().catch(async error => {
                        // 滚动取消只丢弃本页结果；端口仍可复用，由 Worker owner 看守原生推理收尾。
                        if (signal?.aborted && (error as Error | undefined)?.name === 'AbortError') throw error;
                        const current=service;service=undefined;
                        await Promise.resolve().then(()=>current?.destroy()).catch(()=>undefined);
                        throw error;
                    });
                } finally {
                    // 不把输入图或结果缓存在库内；跨页结果缓存仍由 content 的像素预算管理。
                    idle = setTimeout(() => { void queue(release).catch(() => undefined); }, 180_000);
                }
            }));
            if (!signal) return result;
            return new Promise((resolve, reject) => {
                const abort = () => reject(new DOMException('漫画识别已取消', 'AbortError'));
                signal.addEventListener('abort', abort, {once: true});
                if (signal.aborted) abort();
                void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
            });
        },
        dispose: () => queue(release),
        removeModels: () => queue(async () => { try { await release(); } finally { await removeMangaOcrAssets(); } }),
    };
}

export async function createBrowserMangaOcr(signal?: AbortSignal, progress?: Progress): Promise<MangaOcrPort> {
    const model = await loadMangaOcrAssets(signal, percent => progress?.('preparing', percent));
    assertMangaOcrActive(signal); progress?.('initializing');
    // 两个包共享同一 ONNX 实例；在导入 SDK 前覆盖其 CDN 默认路径，符合扩展 CSP。
    const ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.numThreads = localWasmThreads();
    configureOnnxWasmBackend(ort.env.wasm, {
        mjs: mangaExtensionUrl('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'),
        wasm: mangaExtensionUrl('/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'),
    });
    const {PaddleOcrService,DetectionService,RecognitionService} = await import('ppu-paddle-ocr/web');
    const gpu=await probeWebGpu();
    let activeSignal=signal;
    const colorAdapter=createMangaOcrColorAdapter();
    class MangaRecognition extends RecognitionService {
        private pendingColorReads=new Set<()=>void>();
        constructor(...args:ConstructorParameters<typeof RecognitionService>){
            super(...args);
            const createProcessor=this.platform.canvas.createProcessor.bind(this.platform.canvas);
            this.platform.canvas.createProcessor=canvas=>{
                const processor=createProcessor(canvas),resize=processor.resize.bind(processor);
                processor.resize=options=>{
                    // 返回值才是 SDK 后续读取的处理器；不假定 resize 一定返回原对象。
                    const resized=resize(options),output=resized.toCanvas(),context=output.getContext('2d');
                    if(context){
                        const restore=withMangaOcrColorRead(context,output.width,output.height,colorAdapter,
                            consumed=>this.pendingColorReads.delete(consumed));
                        if(restore)this.pendingColorReads.add(restore);
                    }
                    return resized;
                };
                return processor;
            };
        }
        async run(...args:Parameters<InstanceType<typeof RecognitionService>['run']>){
            try{return await super.run(...args);}
            finally{for(const restore of this.pendingColorReads)restore();this.pendingColorReads.clear();}
        }
    }
    class MangaDetection extends DetectionService {
        constructor(session:ConstructorParameters<typeof DetectionService>[0],options:ConstructorParameters<typeof DetectionService>[1]){
            super(session,options);
            // 只装饰本实例公开的处理器入口，不改 SDK 私有后处理，也不创建第二个模型会话。
            const createProcessor=this.platform.canvas.createProcessor.bind(this.platform.canvas);
            this.platform.canvas.createProcessor=canvas=>{
                const processor=createProcessor(canvas),findRegions=processor.findRegions.bind(processor);
                // grayscale()/threshold() 的公开契约均返回 this，保留原检测平面与原 area 过滤。
                processor.findRegions=(options={})=>findRegions({...options,padding:undefined,scale:1}).map(region=>({...region,
                    bbox:padMangaOcrDetectionBox(region.bbox,canvas.width,canvas.height,options.padding,options.scale)}));
                return processor;
            };
        }
    }
    class MangaService extends PaddleOcrService {
        private checks:Array<()=>void>=[];
        private inferenceFailure: {error: unknown} | undefined;
        private remainingRetries=4;
        private remainingPreprocessingPixels=MANGA_DESKEW_PIXEL_BUDGET;
        beginMangaPage(): void {this.remainingRetries=4;this.remainingPreprocessingPixels=MANGA_DESKEW_PIXEL_BUDGET;colorAdapter.beginPage(activeSignal);}
        private checkInferenceFailure(): void {
            if(this.inferenceFailure)throw this.inferenceFailure.error;
        }
        async recognizeManga(canvas:HTMLCanvasElement | OffscreenCanvas,options:{flatten:true;noCache:true;strategy:'per-box'}) {
            this.inferenceFailure=undefined;
            try {
                const page=await this.recognize(canvas,options);
                // 替换、瓦片去重和局部候选之间可能丢失原始数值；仅保留物理证据，不增加推理。
                const numericEvidence:typeof page.results=[];
                const preserve=(item:(typeof page.results)[number])=>{
                    if(!numericProtection(item.text?.replace(/\s+/gu,' ').trim()??''))return;
                    if(numericEvidence.length>=4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
                    numericEvidence.push(item);
                };
                page.results.forEach(preserve);
                // 批量裁切会把不同宽度补齐；只对已有低置信竖列有界复识别，不再运行检测或新增框。
                const weak=page.results.filter(item=>item.confidence<.9&&item.box.height>item.box.width*1.8)
                    .sort((a,b)=>a.confidence-b.confidence).slice(0,this.remainingRetries);
                const replacements=new Map<(typeof page.results)[number],(typeof page.results)[number]|undefined>();
                if(weak.length){
                    assertMangaOcrActive(activeSignal);
                    this.remainingRetries-=weak.length;
                    const rotating=weak.filter(item=>{
                        if(!shouldRotateMangaOcrRetry(item,canvas.width,canvas.height))return false;
                        const pixels=Math.round(item.box.width)*Math.round(item.box.height);
                        if(pixels>this.remainingPreprocessingPixels)return false;
                        this.remainingPreprocessingPixels-=pixels;return true;
                    });
                    const straight=weak.filter(item=>!rotating.includes(item));
                    const retried=straight.length?await this.recognitor!.run(canvas,straight.map(item=>item.box),
                        this.options.recognition!.charactersDictionary,'per-box',{...options,recBatchSize:1}):[];
                    assertMangaOcrActive(activeSignal);
                    this.checkInferenceFailure();
                    // SDK 对高窄框只固定转一侧；另一侧拉丁边注复用原框的一次重试，不增加页预算。
                    for(const item of rotating){
                        const box=item.box,crop=createOcrCanvas();
                        try{
                            assertMangaOcrActive(activeSignal);crop.width=Math.round(box.width);crop.height=Math.round(box.height);
                            const ctx=crop.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('浏览器不支持图片处理');
                            ctx.translate(crop.width,crop.height);ctx.rotate(Math.PI);
                            ctx.drawImage(canvas,box.x,box.y,box.width,box.height,0,0,crop.width,crop.height);
                            const candidates=await this.recognitor!.run(crop,[{x:0,y:0,width:crop.width,height:crop.height}],
                                this.options.recognition!.charactersDictionary,'per-box',{...options,recBatchSize:1});
                            assertMangaOcrActive(activeSignal);this.checkInferenceFailure();
                            for(const candidate of candidates)if(candidate.box.x===0&&candidate.box.y===0&&candidate.box.width===crop.width&&candidate.box.height===crop.height)
                                retried.push({...candidate,box:item.box});
                        }finally{crop.width=0;crop.height=0;}
                    }
                    // 只接受映回本次待重试原框的证据；异常无关框不能阻挡其他文字。
                    retried.forEach(candidate=>{
                        if(weak.some(item=>candidate.box.x===item.box.x&&candidate.box.y===item.box.y
                            &&candidate.box.width===item.box.width&&candidate.box.height===item.box.height))preserve(candidate);
                    });
                    for(const item of weak)replacements.set(item,retried.find(candidate=>
                        candidate.box.x===item.box.x&&candidate.box.y===item.box.y&&candidate.box.width===item.box.width
                        &&candidate.box.height===item.box.height&&candidate.confidence>=item.confidence+.05));
                }
                // 浅底长行的倾斜会把真实字高压到48px输入的一小部分；只按像素估角，不猜字或重跑检测。
                for(const item of page.results.filter(item=>item.confidence<.99).sort((a,b)=>a.confidence-b.confidence)){
                    if(!this.remainingRetries)break;
                    const box=item.box,width=Math.round(box.width),height=Math.round(box.height),pixels=width*height;
                    if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0
                        ||box.x+box.width>canvas.width||box.y+box.height>canvas.height||width<120||height<20||width/height<2.5
                        ||pixels>this.remainingPreprocessingPixels)continue;
                    this.remainingPreprocessingPixels-=pixels;
                    assertMangaOcrActive(activeSignal);
                    const crop=createOcrCanvas(),rotated=createOcrCanvas(),trimmed=createOcrCanvas();
                    try {
                        crop.width=width;crop.height=height;
                        const ctx=crop.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('浏览器不支持图片处理');
                        ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.drawImage(canvas,box.x,box.y,box.width,box.height,0,0,width,height);
                        const plan=planMangaOcrDeskew(ctx.getImageData(0,0,width,height).data,width,height);if(!plan)continue;
                        const rotatedPixels=plan.width*plan.height;if(rotatedPixels>this.remainingPreprocessingPixels)continue;
                        this.remainingPreprocessingPixels-=rotatedPixels;
                        rotated.width=plan.width;rotated.height=plan.height;
                        const rc=rotated.getContext('2d',{willReadFrequently:true});if(!rc)throw new Error('浏览器不支持图片处理');
                        rc.fillStyle='white';rc.fillRect(0,0,rotated.width,rotated.height);
                        rc.translate(rotated.width/2,rotated.height/2);rc.rotate(-plan.radians);rc.drawImage(crop,-width/2,-height/2);
                        const trim=trimMangaOcrDeskew(rc.getImageData(0,0,rotated.width,rotated.height).data,rotated.width,rotated.height,height);
                        if(!trim)continue;
                        trimmed.width=trim.width;trimmed.height=trim.height;
                        const tc=trimmed.getContext('2d');if(!tc)throw new Error('浏览器不支持图片处理');
                        tc.fillStyle='white';tc.fillRect(0,0,trim.width,trim.height);
                        tc.drawImage(rotated,trim.x,trim.y,trim.width,trim.height,0,0,trim.width,trim.height);
                        assertMangaOcrActive(activeSignal);this.remainingRetries--;
                        const [candidate]=await this.recognitor!.run(trimmed,[{x:0,y:0,width:trim.width,height:trim.height}],
                            this.options.recognition!.charactersDictionary,'per-box',{...options,recBatchSize:1});
                        assertMangaOcrActive(activeSignal);
                        this.checkInferenceFailure();
                        if(candidate&&candidate.box.x===0&&candidate.box.y===0&&candidate.box.width===trim.width&&candidate.box.height===trim.height)
                            preserve({...candidate,box:item.box});
                        if(candidate&&candidate.box.x===0&&candidate.box.y===0&&candidate.box.width===trim.width&&candidate.box.height===trim.height
                            &&candidate.confidence>=.99&&candidate.confidence>=item.confidence+.01){
                            replacements.set(item,{...candidate,box:item.box});
                        }
                    }finally{crop.width=0;crop.height=0;rotated.width=0;rotated.height=0;trimmed.width=0;trimmed.height=0;}
                }
                return {...page,results:page.results.map(item=>replacements.get(item)??item),...(numericEvidence.length?{numericEvidence}:{})};
            }
            finally {
                this.checks.forEach(check=>check());
                // SDK 的识别阶段可能记录错误后返回空数组；CPU 也必须向调用方报告首因，允许正常重试。
                this.checkInferenceFailure();
            }
        }
        async initialize() {
            await super.initialize();
            if(this.detectionSession)this.detector=new MangaDetection(this.detectionSession,this.options.detection);
            if(this.recognitionSession)this.recognitor=new MangaRecognition(this.recognitionSession,this.options.recognition,this.options.debugging);
            for(const [key,session] of [['detection',this.detectionSession],['recognition',this.recognitionSession]] as const) {
                if(session && gpu.available)this.checks.push(protectMangaSession(session,async()=>{
                    assertMangaOcrActive(activeSignal);
                    const assets=await loadMangaOcrAssets(activeSignal);
                    assertMangaOcrActive(activeSignal);
                    const cpu=await ort.InferenceSession.create(assets[key],{executionProviders:['wasm'],graphOptimizationLevel:'all'});
                    try {assertMangaOcrActive(activeSignal);}catch(error){await Promise.resolve().then(()=>cpu.release()).catch(()=>undefined);throw error;}
                    return cpu;
                },()=>activeSignal));
                if(session){
                    const run=session.run.bind(session),invoke=run as (...args:Parameters<typeof run>)=>ReturnType<typeof run>;
                    session.run=(async(...args:Parameters<typeof run>)=>{
                        try{return await paceLocalInference(()=>{assertMangaOcrActive(activeSignal);return invoke(...args);});}
                        catch(error){this.inferenceFailure??={error};throw error;}
                    }) as typeof session.run;
                }
            }
        }
    }
    const service = new MangaService({model, detection: {maxSideLength:1536,paddingVertical:0.1,paddingHorizontal:0.2},
        recognition: {charactersDictionary: [], minimumConfidence:0.65,strategy:'per-box',spaceRecovery:true,mainThreadYieldMs:1,maxCropSourceSideLength:8192},
        session: {executionProviders: gpu.available?['webgpu','wasm']:['wasm'], graphOptimizationLevel: 'all'}});
    try {
        await service.initialize(); assertMangaOcrActive(signal);
        return {
            recognize: async (image, options) => {
                activeSignal=options.signal;
                try {
                assertMangaOcrActive(options.signal);
                service.beginMangaPage();
                const bitmap=options.decodedImage ?? await createImageBitmap(new Blob([await (await fetch(image)).arrayBuffer()]));
                try {
                const canvas=createOcrCanvas();
                try {
                    assertMangaOcrActive(options.signal);
                    const width='naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width,height='naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
                    const tiles=planMangaOcrTiles(width,height);
                    canvas.width=width;canvas.height=height;
                    const context=canvas.getContext('2d', {willReadFrequently: true});if(!context)throw new Error('浏览器不支持图片处理');
                    context.drawImage(bitmap,0,0);
                    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
                    // Paddle 的 RGB 张量忽略 alpha；只在识别像素上合成对比底色，
                    // 后续重绘仍借用保留透明度的原图，不重复回读或复制整图。
                    if(flattenOcrAlpha(pixels.data))context.putImageData(pixels,0,0);
                    const {recognition:boxes,ownership}=findMangaBubbleLayout(pixels.data,canvas.width,canvas.height);
                    const sdkOptions={flatten:true as const,noCache:true as const,strategy:'per-box' as const};
                    // 整页保留气泡原文，局部识别为空、低置信或漏行时仍有回退证据。
                    // 超出检测边长的图按原像素切片，不能为长图把所有小字缩到不可辨认。
                    let page: MangaOcrPage;
                    if(tiles.length===1) page=await service.recognizeManga(canvas,sdkOptions);
                    else {
                        const tileCanvas=createOcrCanvas(),pages:MangaOcrTileResult[]=[];
                        try {
                            const tileContext=tileCanvas.getContext('2d',{willReadFrequently:true});
                            if(!tileContext)throw new Error('浏览器不支持图片处理');
                            for(const tile of tiles){
                                assertMangaOcrActive(options.signal);
                                tileCanvas.width=tile.width;tileCanvas.height=tile.height;
                                tileContext.drawImage(canvas,tile.x,tile.y,tile.width,tile.height,0,0,tile.width,tile.height);
                                const result=await service.recognizeManga(tileCanvas,sdkOptions);
                                assertMangaOcrActive(options.signal);
                                pages.push({tile,results:result.results,numericEvidence:result.numericEvidence});
                            }
                        const numericEvidence=collectMangaOcrTileNumericEvidence(pages,width,height);
                        page={results:mergeMangaOcrTiles(pages,width,height),...(numericEvidence.length?{numericEvidence}:{})};
                        }finally{tileCanvas.width=0;tileCanvas.height=0;}
                    }
                    const bubbles:NonNullable<MangaOcrPage['bubbles']>=[];
                    for(const bbox of boxes){
                        assertMangaOcrActive(options.signal);
                        const width=bbox.x1-bbox.x0,height=bbox.y1-bbox.y0;
                        const scale=Math.min(3,1536/Math.max(width,height));
                        const crop=createOcrCanvas();crop.width=Math.round(width*scale);crop.height=Math.round(height*scale);
                        try {
                            const ctx=crop.getContext('2d', {willReadFrequently: true});if(!ctx)throw new Error('浏览器不支持图片处理');
                            ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
                            ctx.drawImage(canvas,bbox.x0,bbox.y0,width,height,0,0,crop.width,crop.height);
                            const result=await service.recognizeManga(crop,sdkOptions);
                            const sx=crop.width/width,sy=crop.height/height;
                            const restore=(item:(typeof result.results)[number])=>({...item,box:{x:bbox.x0+item.box.x/sx,y:bbox.y0+item.box.y/sy,width:item.box.width/sx,height:item.box.height/sy}});
                            bubbles.push({bbox,results:result.results.map(restore),...(result.numericEvidence?.length?{numericEvidence:result.numericEvidence.map(restore)}:{})});
                        }finally{crop.width=0;crop.height=0;}
                    }
                    assertMangaOcrActive(options.signal);
                    const layoutBubbles=assignMangaLayoutBubbles(pixels.data,canvas.width,canvas.height,ownership,page.results);
                    return {results:page.results,bubbles,...(page.numericEvidence?.length?{numericEvidence:page.numericEvidence}:{}),...(layoutBubbles.length?{layoutBubbles}:{})};
                }finally{canvas.width=0;canvas.height=0;}
                }finally{if ('close' in bitmap)bitmap.close();}
                }finally{try{colorAdapter.endPage();}finally{activeSignal=undefined;}}
            },
            destroy: () => service.destroy(),
        };
    } catch (error) { colorAdapter.endPage();activeSignal=undefined;await Promise.resolve().then(()=>service.destroy()).catch(()=>undefined);throw error; }
}

function createOcrCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return typeof document === 'undefined' ? new OffscreenCanvas(0, 0) : document.createElement('canvas');
}

async function createWorkerMangaOcr(signal?: AbortSignal, progress?: Progress): Promise<MangaOcrPort> {
    await mangaInferenceClient.prepare('ocr', signal, progress);
    return {
        recognize: async (image, options) => {
            let workerImage = image;
            // Worker 的 Blob 位图解码器不能解码 SVG；DOM 预检已解码并限制了尺寸，
            // 借用此源转 PNG，避免重抓原图或让 GPU/CPU 重试重复同一次解码错误。
            if (options.decodedImage && /^data:image\/svg\+xml[;,]/iu.test(image)) {
                assertMangaOcrActive(options.signal);
                const source = options.decodedImage;
                const canvas = document.createElement('canvas');
                try {
                    canvas.width = source.naturalWidth;
                    canvas.height = source.naturalHeight;
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('浏览器不支持图片处理');
                    context.drawImage(source, 0, 0);
                    workerImage = await encodeImageCanvas(canvas, options.signal);
                    assertMangaOcrActive(options.signal);
                } finally {
                    canvas.width = 0;
                    canvas.height = 0;
                }
            }
            return mangaInferenceClient.request({type:'recognize', image: workerImage}, options.signal, options.progress);
        },
        destroy: () => mangaInferenceClient.release('ocr'),
    };
}

export const mangaOcrRuntime = createMangaOcrRuntime(createWorkerMangaOcr);

/** 设置清理和页面销毁共用模型会话生命周期。 */
export function removeMangaModels():Promise<void>{
    return withMangaModelRemoval(async () => {
        // 先等修补队列退出，再由 OCR 队列清除缓存；释放失败仍须尝试剩余清理。
        try { await mangaInpaintingRuntime.dispose(); }
        finally {
            try { await mangaOcrRuntime.dispose(); }
            finally {
                // 两个运行队列退出后，清除取消准备留下的无人端口，避免删除后重新写入模型缓存。
                mangaInferenceClient.dispose();
                await mangaOcrRuntime.removeModels();
            }
        }
    });
}
export function disposeMangaModels():void{mangaInferenceClient.dispose();void mangaOcrRuntime.dispose().catch(()=>undefined);void mangaInpaintingRuntime.dispose().catch(()=>undefined);}
