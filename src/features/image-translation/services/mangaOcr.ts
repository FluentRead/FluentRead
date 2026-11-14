/**
 * @file src/features/image-translation/services/mangaOcr.ts
 * 文件职责：在扩展独立 Worker 中按需运行 PaddleOCR 漫画识别，并隔离排队、取消、失败和空闲释放。
 * 主要内容：延迟导入浏览器 OCR 和本地 ONNX WASM，用频繁读取的画布完成 OCR 预处理，透明像素仅在识别画布上按前景亮度合成对比底色，读取已校验模型并融合 ONNX 执行图，硬件可用时加速识别，GPU 故障有界切换 CPU；SVG 复用已解码原图异步转为无损 PNG 后进入 Worker，取消或失败释放自有画布且保留借用原图；大图以有重叠的原像素瓦片识别并按物理行去重，整页原文与放大的独立气泡共同参与可靠性回退，竖列与纯像素估角的浅底斜行共用每页四框复识别预算，斜行只以高置信且有增益的原框结果替换，预处理另有像素预算，普通图片保留物理行供严格段落策略使用；滚动取消保留轻量模型端口，Worker owner 有界收尾，GPU 挂起重建一次 CPU 后端，空闲三分钟释放会话，统一清理 OCR 与修补会话。
 * 检测裁切：通过 SDK 公开处理器入口按原始字行短边计算留白，检测平面短边不足十二像素时保留原高度留白，不丢弃细小框；沿用原裁边、舍入与缩放顺序，水平框保持原语义，竖列不因列长吞入邻列和注音；复用原会话和一次区域检测。低置信纯拉丁竖框用原配额尝试反向，CJK 保留原批次复识别，反向与斜行共用整页两百万预处理像素预算，超额框回原框识别；同一次气泡扫描额外输出大型曲边气泡的布局归属，不创建大型局部识别裁图。
 * 识别颜色：仅装饰原生识别缩放副本的一次既有读回，在完整不透明端点边缘和原页像素预算内补足红通道缺失对比；复用原会话，不改裁切、原图或检测输入，推理收尾恢复上下文，页级 finally 清理取消信号。
 * 模型形状：资源层仅在原文件完整校验与入库后生成固定识别图的内存副本，CPU 重载同样处理；本入口固定识别高度48，并在每次原生调用前核对正 batch、三通道和至少八像素宽度，不把未证明输入交给优化图。
 * 视图词界：所有局部框映回后，仅对同字符且空格边界不同的重叠拉丁行生成有界原像素证明；索引、比较和尝试均有限，保持最终页面与气泡对象引用，原文字、数字证据与几何不改；原图回读与已有方向和斜行预处理共用两百万像素余额，独立于既有识别颜色读回适配。
 * 普通图片旁证：复用既有透明度扫描，仅透明图片按需捕获同次检测原概率的有界位图；依锁定SDK及实际检测配置核对原比例帧和填充张量，不借放大气泡概率；自有位图只在Worker私有响应传输，按结果数组、原图和尺寸绑定后供修补查询，不进入文字、阅读或缓存。
 * 段落间距：普通图片与漫画均在全部物理框映回后借用仍存活的既有识别像素，生成有界局部静区关系；不新增画布读回、整图副本或推理。漫画只请求轻量段落侧车，不开启普通图片检测帧；关系随同一结果对象图传输，漫画收集器只采用仍为单原框的整页物理行，不授予擦除权限。
 * 气泡补绘：仅漫画结果将收集阶段记录的局部气泡提示绑定到当前原图与尺寸，不向公开行属性附加坐标，也不增加 Worker 消息或模型调用；提示只供后续纯白空处复核。
 * 检测核心：借用同次原概率与未加留白组件，将完全没有0.3响应的候选绑定到原SDK Box；保留原检测和识别批次，原数字证据先进入保护，再在识别重试结束后排除弱结果。反向重检的新候选仍按其自身检测旁证核对，不改弱边缘修补侧车；页内有界观察，取消和失败清除引用。
 * 弱连接复核：仅原像素视图记录大框内的完整紧凑核心，原整页、瓦片、气泡及既有重试全部结束后，独立复核有限双裁图；两次高置信文字一致且实际墨迹完整才替换低置信父框或补充漏行。复用原会话和原像素，不重跑检测、不改变原批次或复识别预算，其他原文和数值始终作为障碍。
 * 模块边界：不访问宿主 DOM、不翻译文本、不处理译图；仅漫画及显式选择 PaddleOCR 的单张图片使用本模型；通用识别与圈选继续由 Tesseract 负责。
 */
import {localWasmThreads, paceLocalInference} from '@/src/shared/onnx/resources';
import {mangaInferenceClient, mangaExtensionUrl, type MangaInferenceProgress} from './mangaInferenceClient';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {protectMangaSession} from './mangaSessionFallback';
import {configureOnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {assertMangaOcrActive, loadMangaOcrAssets, removeMangaOcrAssets, withMangaModelAdmission, withMangaModelRemoval} from './mangaOcrAssets';
import type {MangaOcrItem,MangaRegion} from './mangaRegions';
import {findMangaBubbleLayout,assignMangaLayoutBubbles,collectMangaRegions,type MangaOcrPage} from './mangaBubbles';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {getOcrAlphaProfile} from './ocrPixels';
import {collectMangaOcrTileNumericEvidence,mergeMangaOcrTiles, planMangaOcrTiles, type MangaOcrTileResult} from './mangaOcrTiles';
import {numericProtection} from './mangaNumeric';
import {withMangaOcrColorRead} from './mangaOcrColor';
import {createMangaRecognitionInput} from './mangaRecognitionInput';
import {createMangaRecognitionWhitespace} from './mangaRecognitionWhitespace';
import {MANGA_DESKEW_PIXEL_BUDGET,planMangaOcrDeskew,trimMangaOcrDeskew} from './mangaOcrDeskew';
import {assertMangaRecognitionInput} from './mangaRecognitionShapes';
import {createMangaViewWordBoundaryBudget,hasMangaViewWordBoundaryDifference,type MangaViewWordBoundaryProof} from './mangaViewWordBoundary';
import {bindImageDetectionEvidence,createImageDetectionEvidenceBudget,type ImageDetectionFrameSource} from './imageDetectionEvidence';
import {bindImageParagraphGapEvidence,produceImageParagraphGapProofs} from './imageParagraphGapEvidence';
import {bindMangaBubblePlacements} from './mangaBubblePlacement';
import {createMangaDetectionCore} from './mangaDetectionCore';
import {planMangaDetectionRecovery,recoverMangaDetectionRegions} from './mangaDetectionRecovery';

interface MangaOcrPort {
    recognize(image: string, options: {flatten: true; noCache: true; strategy: 'per-box';signal?:AbortSignal; decodedImage?: HTMLImageElement; progress?: MangaInferenceProgress;imageDetectionEvidence?:true;mangaParagraphGapEvidence?:true}): Promise<MangaOcrPage>;
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

/** Huge, extremely tall Latin boxes are rescanned after a quarter turn so a false full-page box cannot erase artwork. */
export function shouldRescanTallMangaLatin(item:{text:string;confidence:number;box:{x:number;y:number;width:number;height:number}},width:number,height:number):boolean {
    if(!item||typeof item.text!=='string'||!item.box)return false;
    const box=item.box,compact=item.text.normalize('NFKC').replace(/[^A-Za-z0-9]/gu,'');
    return /^[A-Za-z0-9\s.,!?;:'’"()\-…]+$/u.test(item.text)&&Number.isFinite(item.confidence)&&item.confidence>=.65&&item.confidence<.9
        &&compact.length>=4&&compact.length<=32
        &&(compact.match(/[A-Za-z]/gu)?.length??0)>=4&&box.height>=Math.max(256,height*.55)&&box.height>=box.width*4
        &&[box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>=1
        &&box.x+box.width<=width&&box.y+box.height<=height;
}

interface MangaRubyRescueCrop {crop:{x0:number;y0:number;x1:number;y1:number};side:{x0:number;y0:number;x1:number;y1:number};fontSize:number;inkPixels:number}
const rubyKana=/^[\p{Script=Hiragana}\p{Script=Katakana}ー]{2,8}$/u;
const MAX_MANGA_RUBY_CANDIDATES=128;
/** Only high-contrast kana-like side gutters beside an existing vertical CJK line qualify for a bounded rescue OCR crop. */
export function planMangaRubyRescueCrops(page:MangaOcrPage,width:number,height:number,pixels:Uint8ClampedArray,
    knownItems:readonly MangaOcrItem[]=page.results,limit=2,candidateItems:readonly MangaOcrItem[]=page.results):MangaRubyRescueCrop[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>2||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)
        ||width<=0||height<=0||pixels.length!==width*height*4||!Array.isArray(page.results)||page.results.length>4096||candidateItems.length>4096)return [];
    const valid=(item:MangaOcrItem)=>!!item&&typeof item.text==='string'&&!!item.box
        &&[item.box.x,item.box.y,item.box.width,item.box.height,item.confidence].every(Number.isFinite)
        &&item.confidence>=.65&&item.confidence<=1&&item.box.x>=0&&item.box.y>=0&&item.box.width>0&&item.box.height>0
        &&item.box.x+item.box.width<=width&&item.box.y+item.box.height<=height;
    const vertical:MangaOcrItem[]=[],seen=new Set<string>();
    for(const item of candidateItems){
        if(!valid(item)||item.box.height<item.box.width*1.8
            ||!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.text)
            ||Array.from(item.text.trim()).length<3||Array.from(item.text.trim()).length>96)continue;
        const key=JSON.stringify([item.text,item.box.x,item.box.y,item.box.width,item.box.height]);if(seen.has(key))continue;seen.add(key);
        vertical.push(item);
    }
    vertical.sort((a,b)=>b.box.x-a.box.x||a.box.y-b.box.y);
    vertical.length=Math.min(vertical.length,MAX_MANGA_RUBY_CANDIDATES);
    const plans:MangaRubyRescueCrop[]=[];
    for(const main of vertical){
        if(plans.length>=limit)break;
        const glyphs=Array.from(main.text.trim()).length,fontSize=Math.min(main.box.width,main.box.height/glyphs);
        if(!Number.isFinite(fontSize)||fontSize<12||fontSize>128)continue;
        const y0=Math.max(0,Math.floor(main.box.y)-2),y1=Math.min(height,Math.ceil(main.box.y+Math.min(main.box.height,fontSize*3.5)));
        const x0=Math.min(width,Math.ceil(main.box.x+main.box.width+2));let x1=Math.min(width,x0+Math.ceil(fontSize*1.8));
        for(const other of knownItems){
            if(other===main||!valid(other))continue;
            const b=other.box;
            if(b.x>x0&&b.x<x1&&b.y<y1&&b.y+b.height>y0)x1=Math.min(x1,Math.floor(b.x)-2);
        }
        const side={x0,y0,x1,y1};
        if(x1-x0<Math.max(8,fontSize*.5)||y1-y0<fontSize*1.5||(x1-x0)*(y1-y0)>32_768)continue;
        if(knownItems.some(item=>valid(item)&&rubyKana.test(item.text.trim())
            &&Math.min(x1,item.box.x+item.box.width)>Math.max(x0,item.box.x)
            &&Math.min(y1,item.box.y+item.box.height)>Math.max(y0,item.box.y)))continue;
        const signature=`${x0},${y0},${x1},${y1}`;
        if(plans.some(plan=>{
            const overlap=Math.max(0,Math.min(plan.side.x1,x1)-Math.max(plan.side.x0,x0))
                *Math.max(0,Math.min(plan.side.y1,y1)-Math.max(plan.side.y0,y0));
            return signature===`${plan.side.x0},${plan.side.y0},${plan.side.x1},${plan.side.y1}`||overlap>=Math.min((plan.side.x1-plan.side.x0)*(plan.side.y1-plan.side.y0),(x1-x0)*(y1-y0))*.6;
        }))continue;
        const samples=[[x0,y0],[Math.floor((x0+x1-1)/2),y0],[x1-1,y0],[x0,Math.floor((y0+y1-1)/2)],
            [x1-1,Math.floor((y0+y1-1)/2)],[x0,y1-1],[Math.floor((x0+x1-1)/2),y1-1],[x1-1,y1-1]];
        const colors=[[],[],[]] as number[][];
        for(const [x,y] of samples){const offset=(y*width+x)*4;if(pixels[offset+3]<128)continue;
            for(let channel=0;channel<3;channel++)colors[channel].push(pixels[offset+channel]);}
        if(colors.some(channel=>channel.length<4))continue;
        const median=(values:number[])=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];};
        const background=colors.map(median);let inkPixels=0,left=x1,top=y1,right=x0,bottom=y0;
        for(let y=y0+1;y<y1-1;y++)for(let x=x0+1;x<x1-1;x++){
            const offset=(y*width+x)*4;if(pixels[offset+3]<128)continue;
            const difference=Math.abs(pixels[offset]-background[0])+Math.abs(pixels[offset+1]-background[1])+Math.abs(pixels[offset+2]-background[2]);
            if(difference<120)continue;
            inkPixels++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
        }
        if(inkPixels<14||right-left<3||bottom-top<6)continue;
        const crop={...side};
        plans.push({crop,side,fontSize,inkPixels});
    }
    return plans.sort((a,b)=>b.inkPixels-a.inkPixels).slice(0,limit);
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
                        const response = await service.recognize(image, {flatten: true, noCache: true, strategy: 'per-box',signal, decodedImage, progress,
                            ...(profile==='image'?{imageDetectionEvidence:true as const}:{mangaParagraphGapEvidence:true as const})});
                        assertMangaOcrActive(signal);
                        const regions=collectMangaRegions(response, language, width, height, profile,profile==='manga'?image:undefined);
                        if(profile==='manga')bindMangaBubblePlacements(regions,image,width,height);
                        if(profile==='image'&&response.imageDetectionFrames)bindImageDetectionEvidence(regions,image,width,height,response.imageDetectionFrames);
                        if(profile==='image')bindImageParagraphGapEvidence(regions,image,width,height);
                        return regions;
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
    const whitespace=createMangaRecognitionWhitespace();
    const recognitionInput=createMangaRecognitionInput('bgr',whitespace),colorAdapter=recognitionInput.adapter;
    class MangaRecognition extends RecognitionService {
        private pendingColorReads=new Set<()=>void>();
        constructor(...args:ConstructorParameters<typeof RecognitionService>){
            super(...args);
            // platform 为本 RecognitionService 新建；ort 本身是共享模块，只替换本 provider 的 facade。
            const nativeOrt=this.platform.ort;
            this.platform.ort={...nativeOrt,Tensor:new Proxy(nativeOrt.Tensor,{
                construct(target,args,newTarget){
                    try{
                        const receipt=recognitionInput.patchInput(args),tensor=Reflect.construct(target,args,newTarget);
                        try{if(receipt)whitespace.bindInput(tensor,receipt);return tensor;}
                        catch(error){try{tensor.dispose();}catch{/* 尚未交给 SDK 的 Tensor 仍须释放，清理不能覆盖首因。 */}throw error;}
                    }
                    catch(error){recognitionInput.fail(error);throw error;}
                },
            })};
            const createProcessor=this.platform.canvas.createProcessor.bind(this.platform.canvas);
            this.platform.canvas.createProcessor=canvas=>{
                const processor=createProcessor(canvas),resize=processor.resize.bind(processor);
                processor.resize=options=>{
                    try{
                    // 返回值才是 SDK 后续读取的处理器；不假定 resize 一定返回原对象。
                    const resized=resize(options),output=resized.toCanvas(),context=output.getContext('2d');
                    if(context){
                        const restore=withMangaOcrColorRead(context,output.width,output.height,colorAdapter,
                            consumed=>this.pendingColorReads.delete(consumed),recognitionInput.fail);
                        if(restore)this.pendingColorReads.add(restore);
                    }
                    return resized;
                    }catch(error){recognitionInput.fail(error);throw error;}
                };
                return processor;
            };
        }
        async run(...args:Parameters<InstanceType<typeof RecognitionService>['run']>){
            const metadata=this.session.inputMetadata?.[0];
            const batchDimension=metadata&&'shape' in metadata?metadata.shape[0]:undefined;
            const requestedBatch=args[4]?.recBatchSize??this.options.recBatchSize??6;
            let cropCount=0,finiteBoxes=true;
            for(const box of args[1]){
                if(box.width>0&&box.height>0)cropCount++;
                if(!Number.isFinite(box.width)||!Number.isFinite(box.height))finiteBoxes=false;
            }
            const batchSize=typeof batchDimension==='number'&&!(batchDimension<0)?1:Math.max(1,requestedBatch);
            const enabled=(args[3]??'per-line')==='per-box'&&!this.debugging.debug&&(this.options.imageHeight??48)===48&&finiteBoxes;
            recognitionInput.beginRun({cropCount,batchSize,enabled});
            let completed=false;
            try{
                const source=args[0],cap=this.options.maxCropSourceSideLength??2000;
                whitespace.beginRun({boxes:args[1],batchSize,dictionary:args[2]??this.options.charactersDictionary??[],
                    supportedPerBox:enabled&&(args[4]?.spaceRecovery??this.options.spaceRecovery??false),
                    sourceRatioOne:'width' in source&&'height' in source&&Number.isFinite(source.width)&&Number.isFinite(source.height)
                        &&source.width>0&&source.height>0&&Math.max(source.width,source.height)<=cap});
                const result=await super.run(...args);completed=true;return whitespace.applyToSdkResults(result);
            }
            finally{
                try{for(const restore of this.pendingColorReads)restore();}
                finally{
                    this.pendingColorReads.clear();
                    try{recognitionInput.endRun(completed);}finally{whitespace.endRun();}
                }
            }
        }
    }
    let detectionBudget:ReturnType<typeof createImageDetectionEvidenceBudget>|undefined;
    let detectionObservation:{canvas:HTMLCanvasElement|OffscreenCanvas;frame:Omit<ImageDetectionFrameSource,'resizeRatio'>}|undefined;
    let activeDetectionFrame:(ImageDetectionFrameSource&{canvas:HTMLCanvasElement|OffscreenCanvas})|undefined;
    class MangaDetection extends DetectionService {
        private readonly evidenceSideLimit:number|undefined;
        readonly detectionCore=createMangaDetectionCore();
        constructor(session:ConstructorParameters<typeof DetectionService>[0],options:ConstructorParameters<typeof DetectionService>[1]){
            super(session,options);
            this.evidenceSideLimit=typeof options?.maxSideLength==='number'?options.maxSideLength:undefined;
            // 只装饰本实例公开的处理器入口，不改 SDK 私有后处理，也不创建第二个模型会话。
            const createProcessor=this.platform.canvas.createProcessor.bind(this.platform.canvas);
            this.platform.canvas.createProcessor=canvas=>{
                const processor=createProcessor(canvas),findRegions=processor.findRegions.bind(processor);
                const ticket=this.detectionCore.ticket;
                // grayscale()/threshold() 的公开契约均返回 this，保留原检测平面与原 area 过滤。
                processor.findRegions=(options={})=>findRegions({...options,padding:undefined,scale:1}).map(region=>{
                    const bbox=padMangaOcrDetectionBox(region.bbox,canvas.width,canvas.height,options.padding,options.scale);
                    this.detectionCore.observeRegion(ticket,canvas.width,canvas.height,region.bbox,bbox);
                    return {...region,bbox};
                });
                return processor;
            };
        }
        async run(image:Parameters<InstanceType<typeof DetectionService>['run']>[0]){
            const observation=detectionObservation,limit=this.evidenceSideLimit;
            const ticket=this.detectionCore.beginFrame((image as HTMLCanvasElement)?.width,(image as HTMLCanvasElement)?.height,limit,
                observation&&image===observation.canvas?observation.frame:undefined);
            // 锁定SDK6.6仅在长边超maxSideLength时缩小；auto未知时不推测比例。
            if(detectionBudget&&observation&&image===observation.canvas&&typeof limit==='number'&&limit>0){
                const frame=observation.frame;
                activeDetectionFrame={...frame,canvas:observation.canvas,resizeRatio:Math.min(1,limit/Math.max(frame.width,frame.height))};
            }
            try{const boxes=await super.run(image);this.detectionCore.bindBoxes(ticket,boxes);return boxes;}
            finally{this.detectionCore.endFrame(ticket);activeDetectionFrame=undefined;}
        }
    }
    class MangaService extends PaddleOcrService {
        private checks:Array<()=>void>=[];
        private inferenceFailure: {error: unknown} | undefined;
        private remainingRetries=4;
        private remainingRubyRescues=2;
        private remainingPreprocessingPixels=MANGA_DESKEW_PIXEL_BUDGET;
        private originalSource:{image:ImageBitmap|HTMLImageElement;width:number;height:number;identity?:{src:string;currentSrc:string}}|undefined;
        async recoverDetectionFrames(canvas:HTMLCanvasElement|OffscreenCanvas,pixels:Uint8ClampedArray,page:MangaOcrPage,bubbles:NonNullable<MangaOcrPage['bubbles']>):Promise<void>{
            const records=this.detector instanceof MangaDetection?this.detector.detectionCore.takeRefinements():[];
            if(!records.length)return;
            const protectedGroups=[page.numericEvidence??[],...bubbles.flatMap(bubble=>[bubble.results,bubble.numericEvidence??[]])];
            const prepared=planMangaDetectionRecovery(pixels,canvas.width,canvas.height,records,page.results,protectedGroups);
            if(!prepared.plans.length)return;
            const recovered=await recoverMangaDetectionRegions(page.results,prepared,async bounds=>{
                const crop=createOcrCanvas();
                try{
                    crop.width=bounds.x1-bounds.x0;crop.height=bounds.y1-bounds.y0;
                    const context=crop.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('浏览器不支持图片处理');
                    context.drawImage(canvas,bounds.x0,bounds.y0,crop.width,crop.height,0,0,crop.width,crop.height);
                    const results=await this.recognitor!.run(crop,[{x:0,y:0,width:crop.width,height:crop.height}],
                        this.options.recognition!.charactersDictionary,'per-box',{recBatchSize:1});
                    this.checkInferenceFailure();return results;
                }finally{crop.width=0;crop.height=0;}
            },()=>assertMangaOcrActive(activeSignal));
            if(recovered.numericEvidence.length){
                const numericEvidence=[...(page.numericEvidence??[]),...recovered.numericEvidence];
                if(numericEvidence.length>4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
                page.numericEvidence=numericEvidence;
            }
            page.results=recovered.results;
        }
        beginMangaPage(): void {this.remainingRetries=4;this.remainingRubyRescues=2;this.remainingPreprocessingPixels=MANGA_DESKEW_PIXEL_BUDGET;this.originalSource=undefined;colorAdapter.beginPage(activeSignal);whitespace.beginPage(activeSignal);if(this.detector instanceof MangaDetection)this.detector.detectionCore.beginPage(activeSignal);}
        tryReserveMangaRubyRescue(sourcePixels:number):boolean {
            if(this.remainingRubyRescues<=0||!Number.isSafeInteger(sourcePixels)||sourcePixels<=0||sourcePixels>this.remainingPreprocessingPixels)return false;
            this.remainingRubyRescues--;this.remainingPreprocessingPixels-=sourcePixels;return true;
        }
        bindMangaSource(image:ImageBitmap|HTMLImageElement,width:number,height:number):void {
            this.originalSource={image,width,height,...('naturalWidth' in image?{identity:{src:image.src,currentSrc:image.currentSrc}}:{})};
        }
        clearMangaSource():void {this.originalSource=undefined;if(this.detector instanceof MangaDetection)this.detector.detectionCore.endPage();}
        /** 供本页私有质量规划共用原图/预算；不保留整页alpha副本，失败尝试也不返还已扣读回成本。 */
        readMangaSourceRegion(region:{left:number;top:number;width:number;height:number},maxPixels=131072):Uint8ClampedArray|undefined {
            const source=this.originalSource;if(!source)return;
            const {left,top,width,height}=region,image=source.image;
            const actualWidth='naturalWidth' in image?image.naturalWidth:image.width,actualHeight='naturalHeight' in image?image.naturalHeight:image.height;
            const sameIdentity=!source.identity||('naturalWidth' in image&&image.src===source.identity.src&&image.currentSrc===source.identity.currentSrc);
            if(![left,top,width,height,maxPixels].every(Number.isSafeInteger)||left<0||top<0||width<=0||height<=0||maxPixels<=0||maxPixels>131072
                ||left+width>source.width||top+height>source.height||width*height>maxPixels||width*height>this.remainingPreprocessingPixels
                ||actualWidth!==source.width||actualHeight!==source.height||!sameIdentity)return;
            this.remainingPreprocessingPixels-=width*height;
            assertMangaOcrActive(activeSignal);
            const crop=createOcrCanvas();
            try {
                crop.width=width;crop.height=height;
                const context=crop.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('浏览器不支持图片处理');
                context.drawImage(image,left,top,width,height,0,0,width,height);
                assertMangaOcrActive(activeSignal);
                return context.getImageData(0,0,width,height).data;
            }finally{crop.width=0;crop.height=0;}
        }
        /** 两个已有视图完成全页映射后才比较；一致行不读原图，也不占producer的64次尝试。 */
        proveMangaWordBoundaries(page:MangaOcrPage,bubbles:NonNullable<MangaOcrPage['bubbles']>,width:number,height:number):MangaViewWordBoundaryProof[] {
            if(!page.results.length||!bubbles.length)return [];
            type Item=MangaOcrPage['results'][number];
            const valid=(item:Item)=>typeof item.text==='string'&&item.text.length>=4&&item.text.length<=128
                &&Number.isFinite(item.confidence)&&item.confidence>=.65&&item.confidence<=1
                &&!!item.box
                &&[item.box.x,item.box.y,item.box.width,item.box.height].every(Number.isFinite)
                &&item.box.x>=0&&item.box.y>=0&&item.box.width>0&&item.box.height>0
                &&item.box.x+item.box.width<=width&&item.box.y+item.box.height<=height&&item.box.width>=item.box.height*1.5;
            const indexed=new Map<string,Item[]>();let wholeCount=0;
            for(const whole of page.results){
                if(wholeCount++>=4096)break;
                if(!valid(whole))continue;
                const key=whole.text.replaceAll(' ','');if(key.length<4||key.length>64)continue;
                const matches=indexed.get(key);
                if(matches)matches.push(whole);else indexed.set(key,[whole]);
            }
            const budget=createMangaViewWordBoundaryBudget({width,height,read:(roi,max)=>this.readMangaSourceRegion(roi,max)},activeSignal);
            const proofs:MangaViewWordBoundaryProof[]=[];let bubbleCount=0,localCount=0,comparisons=0,attempts=0;
            pairs:for(const bubble of bubbles){
                if(bubbleCount++>=256)break;
                for(const local of bubble.results){
                    if(localCount++>=4096)break pairs;
                    if(!valid(local))continue;
                    const matches=indexed.get(local.text.replaceAll(' ',''));if(!matches)continue;
                    for(const whole of matches){
                        if(comparisons++>=16384)break pairs;
                        if(!hasMangaViewWordBoundaryDifference(whole.text,local.text))continue;
                        const a=whole.box,b=local.box;
                        const overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
                        const left=Math.max(0,Math.floor(Math.min(a.x,b.x))-2),top=Math.max(0,Math.floor(Math.min(a.y,b.y))-2);
                        const right=Math.min(width,Math.ceil(Math.max(a.x+a.width,b.x+b.width))+2),bottom=Math.min(height,Math.ceil(Math.max(a.y+a.height,b.y+b.height))+2);
                        if(overlap<Math.max(a.width*a.height,b.width*b.height)*.5||Math.max(a.height,b.height)>Math.min(a.height,b.height)*1.8||right-left>512||bottom-top>128)continue;
                        if(attempts++>=64)break pairs;
                        const proof=budget.prove(whole,local,bubble);if(proof)proofs.push(proof);
                    }
                }
            }
            return proofs;
        }
        private checkInferenceFailure(): void {
            if(this.inferenceFailure)throw this.inferenceFailure.error;
        }
        async recognizeManga(canvas:HTMLCanvasElement | OffscreenCanvas,options:{flatten:true;noCache:true;strategy:'per-box'}) {
            this.inferenceFailure=undefined;
            const detectionCore=this.detector instanceof MangaDetection?this.detector.detectionCore:undefined;
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
                const rotatedLatin=page.results.filter(item=>shouldRescanTallMangaLatin(item,canvas.width,canvas.height))
                    .sort((a,b)=>b.box.height/b.box.width-a.box.height/a.box.width).slice(0,2);
                for(const item of rotatedLatin){
                    if(!this.remainingRetries)break;
                    const box=item.box,sourceWidth=Math.max(1,Math.round(box.width)),sourceHeight=Math.max(1,Math.round(box.height)),sourcePixels=sourceWidth*sourceHeight;
                    if(sourcePixels>this.remainingPreprocessingPixels)continue;
                    this.remainingRetries--;this.remainingPreprocessingPixels-=sourcePixels;
                    const rotated=createOcrCanvas();
                    try{
                        rotated.width=sourceHeight;rotated.height=sourceWidth;
                        const ctx=rotated.getContext('2d',{willReadFrequently:true});if(!ctx)continue;
                        ctx.translate(rotated.width,0);ctx.rotate(Math.PI/2);
                        ctx.drawImage(canvas,box.x,box.y,box.width,box.height,0,0,sourceWidth,sourceHeight);
                        assertMangaOcrActive(activeSignal);
                        const rescanned=await this.recognize(rotated,options);
                        assertMangaOcrActive(activeSignal);this.checkInferenceFailure();
                        const compact=(text:string)=>text.normalize('NFKC').replace(/[^A-Za-z0-9]/gu,'').toUpperCase();
                        const candidate=rescanned.results.filter(result=>{
                            if(detectionCore?.rejects(result.box))return false;
                            const text=result.text?.trim()??'',candidateCompact=compact(text);
                            const candidateBox=result.box;
                            if(!/^[A-Za-z0-9\s.,!?;:'’"()\-…]+$/u.test(text)||!Number.isFinite(result.confidence)
                                ||result.confidence<.9||result.confidence<item.confidence+.15||candidateCompact.length<4||candidateCompact.length>32
                                ||(candidateCompact.match(/[A-Za-z]/gu)?.length??0)<4
                                ||!candidateBox||![candidateBox.x,candidateBox.y,candidateBox.width,candidateBox.height].every(Number.isFinite)
                                ||candidateBox.width<=candidateBox.height*1.5||candidateBox.x<0||candidateBox.y<0
                                ||candidateBox.x+candidateBox.width>rotated.width||candidateBox.y+candidateBox.height>rotated.height)return false;
                            return candidateBox.width*candidateBox.height<=rotated.width*rotated.height*.4;
                        }).sort((a,b)=>b.confidence-a.confidence)[0];
                        if(candidate){
                            const mapped={...candidate,box:{x:box.x+candidate.box.y,y:box.y+sourceHeight-candidate.box.x-candidate.box.width,
                                width:candidate.box.height,height:candidate.box.width}};
                            const index=page.results.indexOf(item);if(index>=0)page.results[index]=mapped;
                            preserve(mapped);
                        }
                    }finally{rotated.width=0;rotated.height=0;}
                }
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
                return {...page,results:page.results.map(item=>replacements.get(item)??item).filter(item=>!detectionCore?.rejects(item.box)),...(numericEvidence.length?{numericEvidence}:{})};
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
                        const detector=key==='detection'&&this.detector instanceof MangaDetection?this.detector:undefined,ticket=detector?.detectionCore.ticket;
                        try{
                            if(key==='recognition')assertMangaRecognitionInput(args[0]);
                            const result=await paceLocalInference(async()=>{
                                assertMangaOcrActive(activeSignal);
                                const output=await invoke(...args);
                                if(detector&&output&&typeof output==='object')detector.detectionCore.observe(ticket,args[0]?.x,output[session.outputNames?.[0]||'sigmoid_0.tmp_0']);
                                if(key==='recognition'&&args[0]?.x&&output&&typeof output==='object'){
                                    const first=Object.keys(output)[0];
                                    if(first)whitespace.observeOutput(args[0].x,output[first]);
                                }
                                return output;
                            });
                            if(key==='detection'&&detectionBudget&&activeDetectionFrame){
                                const frame=activeDetectionFrame,input=args[0]?.x,output=result[session.outputNames[0]||'sigmoid_0.tmp_0'];
                                if(frame.canvas.width===frame.width&&frame.canvas.height===frame.height&&input?.dims.length===4
                                    &&input.dims[0]===1&&input.dims[1]===3&&output?.dims.length===4&&output.dims[0]===1&&output.dims[1]===1
                                    &&input.dims[2]===output.dims[2]&&input.dims[3]===output.dims[3]&&output.data instanceof Float32Array)
                                    detectionBudget.capture(output.data,output.dims[3],output.dims[2],frame);
                            }
                            return result;
                        }
                        catch(error){this.inferenceFailure??={error};if(key==='recognition')recognitionInput.fail(error);throw error;}
                    }) as typeof session.run;
                }
            }
        }
    }
    const service = new MangaService({model, detection: {maxSideLength:1536,paddingVertical:0.1,paddingHorizontal:0.2},
        recognition: {charactersDictionary: [], imageHeight:48,minimumConfidence:0.65,strategy:'per-box',spaceRecovery:true,mainThreadYieldMs:1,maxCropSourceSideLength:8192},
        session: {executionProviders: gpu.available?['webgpu','wasm']:['wasm'], graphOptimizationLevel: 'all'}});
    try {
        await service.initialize(); assertMangaOcrActive(signal);
        return {
            recognize: async (image, options) => {
                activeSignal=options.signal;
                try {
                assertMangaOcrActive(options.signal);
                service.beginMangaPage();
                let remainingRubyRescues=2;
                detectionBudget=undefined;
                const recognizeFrame=async(canvas:HTMLCanvasElement|OffscreenCanvas,frame:Omit<ImageDetectionFrameSource,'resizeRatio'>)=>{
                    detectionObservation={canvas,frame};
                    try{return await service.recognizeManga(canvas,{flatten:true,noCache:true,strategy:'per-box'});}
                    finally{detectionObservation=undefined;}
                };
                const bitmap=options.decodedImage ?? await createImageBitmap(new Blob([await (await fetch(image)).arrayBuffer()]));
                try {
                const canvas=createOcrCanvas();
                try {
                    assertMangaOcrActive(options.signal);
                    const width='naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width,height='naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
                    service.bindMangaSource(bitmap,width,height);
                    const tiles=planMangaOcrTiles(width,height);
                    canvas.width=width;canvas.height=height;
                    const context=canvas.getContext('2d', {willReadFrequently: true});if(!context)throw new Error('浏览器不支持图片处理');
                    context.drawImage(bitmap,0,0);
                    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
                    // Paddle 的 RGB 张量忽略 alpha；只在识别 Canvas 后方合成对比底色，
                    // 保留这次既有 RGBA 读回的原像素，供透明页段落旁证复用，不复制整图。
                    const alphaProfile=getOcrAlphaProfile(pixels.data),alphaBackground=alphaProfile.background;
                    if(alphaBackground!==undefined){
                        const previousComposite=context.globalCompositeOperation;
                        try{
                            context.globalCompositeOperation='destination-over';
                            context.fillStyle=alphaBackground===0?'#000':'#fff';
                            context.fillRect(0,0,canvas.width,canvas.height);
                        }finally{context.globalCompositeOperation=previousComposite;}
                        // 复用原有alpha扫描结果；整张不透明图片不捕获或复制任何新检测侧车。
                        if(options.imageDetectionEvidence===true)detectionBudget=createImageDetectionEvidenceBudget();
                    }
                    const {recognition:boxes,ownership}=findMangaBubbleLayout(pixels.data,canvas.width,canvas.height);
                    const sdkOptions={flatten:true as const,noCache:true as const,strategy:'per-box' as const};
                    // 整页保留气泡原文，局部识别为空、低置信或漏行时仍有回退证据。
                    // 超出检测边长的图按原像素切片，不能为长图把所有小字缩到不可辨认。
                    let page: MangaOcrPage;
                    if(tiles.length===1) page=await recognizeFrame(canvas,{pageWidth:width,pageHeight:height,x:0,y:0,width,height});
                    else {
                        const tileCanvas=createOcrCanvas(),pages:MangaOcrTileResult[]=[];
                        try {
                            const tileContext=tileCanvas.getContext('2d',{willReadFrequently:true});
                            if(!tileContext)throw new Error('浏览器不支持图片处理');
                            for(const tile of tiles){
                                assertMangaOcrActive(options.signal);
                                tileCanvas.width=tile.width;tileCanvas.height=tile.height;
                                tileContext.drawImage(canvas,tile.x,tile.y,tile.width,tile.height,0,0,tile.width,tile.height);
                                const result=await recognizeFrame(tileCanvas,{pageWidth:width,pageHeight:height,x:tile.x,y:tile.y,width:tile.width,height:tile.height});
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
                    const knownItems=[...page.results,...bubbles.flatMap(bubble=>bubble.results)];
                    const rubyRescues=planMangaRubyRescueCrops(page,width,height,pixels.data,knownItems,remainingRubyRescues,knownItems);
                    for(const rescue of rubyRescues){
                        assertMangaOcrActive(options.signal);
                        const sourceWidth=rescue.crop.x1-rescue.crop.x0,sourceHeight=rescue.crop.y1-rescue.crop.y0,sourcePixels=sourceWidth*sourceHeight;
                        if(!remainingRubyRescues||!service.tryReserveMangaRubyRescue(sourcePixels))break;
                        remainingRubyRescues--;
                        const crop=createOcrCanvas();
                        try{
                            const scale=Math.min(3,1536/Math.max(sourceWidth,sourceHeight));
                            crop.width=Math.max(1,Math.round(sourceWidth*scale));crop.height=Math.max(1,Math.round(sourceHeight*scale));
                            const ctx=crop.getContext('2d',{willReadFrequently:true});if(!ctx)continue;
                            ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
                            ctx.drawImage(canvas,rescue.crop.x0,rescue.crop.y0,sourceWidth,sourceHeight,0,0,crop.width,crop.height);
                            let recovered:MangaOcrPage;
                            try{
                                recovered=await service.recognizeManga(crop,sdkOptions);
                                assertMangaOcrActive(options.signal);
                            }catch(error){assertMangaOcrActive(options.signal);continue;}
                            const sx=crop.width/sourceWidth,sy=crop.height/sourceHeight;
                            for(const candidate of recovered.results){
                                const text=candidate.text.trim();if(!rubyKana.test(text)||candidate.confidence<.8
                                    ||![candidate.box.x,candidate.box.y,candidate.box.width,candidate.box.height].every(Number.isFinite)
                                    ||candidate.box.width<=0||candidate.box.height<=candidate.box.width*1.2)continue;
                                const box={x:rescue.crop.x0+candidate.box.x/sx,y:rescue.crop.y0+candidate.box.y/sy,
                                    width:candidate.box.width/sx,height:candidate.box.height/sy};
                                if(box.x<rescue.side.x0-1||box.y<rescue.side.y0-1||box.x+box.width>rescue.side.x1+1
                                    ||box.y+box.height>rescue.side.y1+1||box.width>rescue.fontSize*1.05||box.height>rescue.fontSize*3.5)continue;
                                const duplicate=knownItems.some(item=>{
                                    if(typeof item.text!=='string'||!item.text.replace(/\s+/gu,'').includes(text))return false;
                                    const other=item.box;if(!other||![other.x,other.y,other.width,other.height].every(Number.isFinite)||other.width<=0||other.height<=0)return false;
                                    const intersection=Math.max(0,Math.min(box.x+box.width,other.x+other.width)-Math.max(box.x,other.x))
                                        *Math.max(0,Math.min(box.y+box.height,other.y+other.height)-Math.max(box.y,other.y));
                                    return intersection>=Math.min(box.width*box.height,other.width*other.height)*.4;
                                });
                                if(duplicate)continue;
                                const restored={...candidate,text,box};page.results.push(restored);knownItems.push(restored);
                            }
                        }finally{crop.width=0;crop.height=0;}
                    }
                    assertMangaOcrActive(options.signal);
                    await service.recoverDetectionFrames(canvas,pixels.data,page,bubbles);
                    assertMangaOcrActive(options.signal);
                    const layoutBubbles=assignMangaLayoutBubbles(pixels.data,canvas.width,canvas.height,ownership,page.results);
                    const hasLargeAlphaHoles=alphaProfile.totalPixels>0&&alphaProfile.transparentPixels/alphaProfile.totalPixels>=.2;
                    const finalPage:MangaOcrPage={results:page.results,bubbles,...(page.numericEvidence?.length?{numericEvidence:page.numericEvidence}:{}),...(layoutBubbles.length?{layoutBubbles}:{}),...(hasLargeAlphaHoles?{largeAlphaHoles:true as const}:{})};
                    const frames=detectionBudget?.frames();
                    if(frames?.length)finalPage.imageDetectionFrames=[...frames];
                    const wordBoundaryProofs=service.proveMangaWordBoundaries(finalPage,bubbles,canvas.width,canvas.height);
                    if(wordBoundaryProofs.length)finalPage.wordBoundaryProofs=wordBoundaryProofs;
                    if(options.imageDetectionEvidence===true||options.mangaParagraphGapEvidence===true){
                        const proofs=produceImageParagraphGapProofs(finalPage,canvas.width,canvas.height,pixels.data,()=>assertMangaOcrActive(options.signal));
                        if(proofs.length)finalPage.imageParagraphGapProofs=proofs;
                    }
                    return finalPage;
                }finally{canvas.width=0;canvas.height=0;}
                }finally{if ('close' in bitmap)bitmap.close();}
                }finally{try{service.clearMangaSource();}finally{try{colorAdapter.endPage();}finally{try{whitespace.endPage();}finally{activeSignal=undefined;detectionBudget=undefined;detectionObservation=undefined;activeDetectionFrame=undefined;}}}}
            },
            destroy: () => service.destroy(),
        };
    } catch (error) { colorAdapter.endPage();whitespace.endPage();activeSignal=undefined;await Promise.resolve().then(()=>service.destroy()).catch(()=>undefined);throw error; }
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
            const result=await mangaInferenceClient.request<MangaOcrPage>({type:'recognize', image: workerImage,
                ...(options.imageDetectionEvidence===true?{imageDetectionEvidence:true as const}:{}),
                ...(options.mangaParagraphGapEvidence===true?{mangaParagraphGapEvidence:true as const}:{})}, options.signal, options.progress);
            return result;
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
