vi.mock('@/src/shared/onnx/resources', async original => ({...await original<any>(), paceLocalInference: mocks.pace}));
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const mocks = vi.hoisted(() => ({assets:vi.fn(),remove:vi.fn(),initialize:vi.fn(),recognize:vi.fn(),retryRecognition:vi.fn(),destroy:vi.fn(),options:vi.fn(),
    gpu:vi.fn(),cpuCreate:vi.fn(),sessions:[] as any[],detectors:[] as any[],recognitors:[] as any[],recognitionProcessor:vi.fn(),recognitionRun:vi.fn(),createProcessor:vi.fn(),inpaintDispose:vi.fn(),bitmapClose:vi.fn(),contexts:[] as any[],canvases:[] as any[],
    workerPrepare:vi.fn(),workerRequest:vi.fn(),workerRelease:vi.fn(),workerDispose:vi.fn(),encode:vi.fn(),planDeskew:vi.fn(),trimDeskew:vi.fn(),detectionRun:vi.fn(),pace:vi.fn((operation:()=>Promise<unknown>)=>operation()),
    tensorConstruct:vi.fn(),wasm:{numThreads:0,wasmPaths:undefined as unknown,proxy:true}}));
vi.mock('@/src/features/image-translation/services/mangaOcrAssets', async importOriginal => ({...await importOriginal<any>(),loadMangaOcrAssets:mocks.assets,removeMangaOcrAssets:mocks.remove}));
vi.mock('onnxruntime-web/webgpu',()=>({env:{wasm:mocks.wasm},InferenceSession:{create:mocks.cpuCreate}}));
vi.mock('@/src/shared/onnx/webgpu',()=>({probeWebGpu:mocks.gpu}));
vi.mock('ppu-paddle-ocr/web',()=>({
    RecognitionService:class{platform={ort:{Tensor:class{constructor(public type:unknown,public data:unknown,public dims:unknown){mocks.tensorConstruct(this);}dispose=vi.fn();},InferenceSession:{}},canvas:{createProcessor:(canvas:unknown)=>mocks.recognitionProcessor(canvas)}};constructor(public session:unknown,public options:unknown,public debugging:unknown={}){mocks.recognitors.push(this);}async run(...args:unknown[]){return mocks.recognitionRun.apply(this,args);}},
    DetectionService:class{platform={canvas:{createProcessor:(canvas:unknown)=>mocks.createProcessor(canvas)}};constructor(public session:unknown,public options:unknown){mocks.detectors.push(this);}async run(...args:unknown[]){return mocks.detectionRun.apply(this,args);}},
    PaddleOcrService:class{constructor(public options:any){mocks.options(options)}recognitor={run:mocks.retryRecognition};detectionSession=mocks.sessions[0];recognitionSession=mocks.sessions[1];async initialize(){return mocks.initialize();}recognize=mocks.recognize;destroy=mocks.destroy;}
}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{dispose:mocks.inpaintDispose}}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient',async original=>({...await original<any>(),mangaInferenceClient:{prepare:mocks.workerPrepare,request:mocks.workerRequest,release:mocks.workerRelease,dispose:mocks.workerDispose}}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaOcrDeskew',async original=>({...await original<any>(),planMangaOcrDeskew:mocks.planDeskew,trimMangaOcrDeskew:mocks.trimDeskew}));
import {createBrowserMangaOcr, createMangaOcrRuntime, mangaOcrRuntime, removeMangaModels, disposeMangaModels,padMangaOcrDetectionBox,shouldRotateMangaOcrRetry,shouldRescanTallMangaLatin,planMangaRubyRescueCrops} from '@/src/features/image-translation/services/mangaOcr';
import * as mangaOcrColor from '@/src/features/image-translation/services/mangaOcrColor';
import {planMangaOcrTiles, mergeMangaOcrTiles,collectMangaOcrTileNumericEvidence} from '@/src/features/image-translation/services/mangaOcrTiles';
import * as mangaWhitespace from '@/src/features/image-translation/services/mangaRecognitionWhitespace';
import {collectMangaRegions} from '@/src/features/image-translation/services/mangaBubbles';
import {getMangaViewWordBoundaryProvenance} from '@/src/features/image-translation/services/mangaViewWordBoundary';
import {getImageDetectionEvidence} from '@/src/features/image-translation/services/imageDetectionEvidence';
import {getImageParagraphGapEvidence} from '@/src/features/image-translation/services/imageParagraphGapEvidence';
// 原生会话端口仍用fake推理，feeds保持SDK真实固定输入域，不以空对象绕过门禁。
const recognitionFeeds=()=>({x:{type:'float32',dims:[1,3,48,8]}});
const opaquePixels=()=>{const pixels=new Uint8ClampedArray(200*200*4);for(let index=3;index<pixels.length;index+=4)pixels[index]=255;return pixels;};
const response = {results:[{text:'Hello world',confidence:0.99,box:{x:10,y:10,width:100,height:20}}]};
const deferred = <T,>() => {let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick = async () => {for(let i=0;i<6;i++)await Promise.resolve()};
beforeEach(()=>{mocks.detectionRun.mockReset().mockResolvedValue([]);});
describe('同次原比例检测侧车生产与私有绑定',()=>{
    function detectorFixture(transparent=true){
        const probabilities=new Float32Array(224*224);probabilities[15*224+15]=.9;
        const output:Record<string,{data:Float32Array|Uint8Array;dims:number[]}>={probability:{data:probabilities,dims:[1,1,224,224]}};
        const feeds:{x?:{type:string;dims:number[]}}={x:{type:'float32',dims:[1,3,224,224]}};
        const run=vi.fn(async()=>output),session={run,outputNames:['probability']};mocks.sessions=[session];
        mocks.detectionRun.mockImplementation(async function(this:any){await this.session.run(feeds);return [];});
        mocks.recognize.mockImplementation(async function(this:any,canvas:unknown){await this.detector.run(canvas);return response;});
        if(transparent){
            const original=vi.mocked(document.createElement).getMockImplementation()!;let first=true;
            vi.mocked(document.createElement).mockImplementation(()=>{const canvas=original('canvas');if(first){first=false;const data=opaquePixels();data[3]=0;mocks.contexts.at(-1).getImageData.mockReturnValue({data});}return canvas;});
        }
        return {probabilities,output,run,session,feeds};
    }
    it('复用一次SDK推理原概率，只打包原比例内容，公开后处理与原文字保持',async()=>{
        const fixture=detectorFixture(),port=await createBrowserMangaOcr();
        const page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.results).toEqual(response.results);expect(fixture.run).toHaveBeenCalledOnce();
        expect(page.imageDetectionFrames).toHaveLength(1);const frame=page.imageDetectionFrames![0];
        expect(frame).toMatchObject({pageWidth:200,pageHeight:200,x:0,y:0,width:200,height:200});
        expect(frame.bits).toHaveLength(5000);expect(frame.bits[(15*200+15)>>3]&(1<<((15*200+15)&7))).not.toBe(0);
        expect(fixture.probabilities).toHaveLength(224*224);expect(fixture.probabilities[15*224+15]).toBeCloseTo(.9);await port.destroy();
    });
    it('普通漫画不请求侧车，不复制检测张量或更改既有推理数量',async()=>{
        const fixture=detectorFixture(),port=await createBrowserMangaOcr();
        const page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(page.imageDetectionFrames).toBeUndefined();expect(fixture.run).toHaveBeenCalledOnce();expect(page.results).toEqual(response.results);await port.destroy();
    });
    it('完全不透明图像即使选择Paddle图片模式也不打包或复制侧车',async()=>{
        const fixture=detectorFixture(false),port=await createBrowserMangaOcr();
        const page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.imageDetectionFrames).toBeUndefined();expect(fixture.run).toHaveBeenCalledOnce();expect(page.results).toEqual(response.results);await port.destroy();
    });
    it('维度不符或检测中原Canvas变更都不产生可借用侧车',async()=>{
        const fixture=detectorFixture();fixture.output.probability.dims=[1,1,192,224];
        const port=await createBrowserMangaOcr();expect((await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true})).imageDetectionFrames).toBeUndefined();
        fixture.output.probability.dims=[1,1,224,224];
        mocks.detectionRun.mockImplementation(async function(this:any,canvas:any){canvas.width++;await this.session.run({x:{type:'float32',dims:[1,3,224,224]}});return [];});
        expect((await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true})).imageDetectionFrames).toBeUndefined();await port.destroy();
    });
    it.each(['auto','missing',0] as const)('SDK公开检测选项没有可证明正数比例时仍识别，但不借检测侧车：%s',async limit=>{
        const fixture=detectorFixture();
        // 在SDK公开构造选项入口模拟auto/省略/无效数值；不触碰派生类私有缓存。
        mocks.options.mockImplementationOnce(options=>{
            if(limit==='missing')delete options.detection.maxSideLength;
            else options.detection.maxSideLength=limit;
        });
        const port=await createBrowserMangaOcr(),page=await port.recognize('unknown resize',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.results).toEqual(response.results);expect(page.imageDetectionFrames).toBeUndefined();
        expect(fixture.run).toHaveBeenCalledOnce();expect(fixture.probabilities[15*224+15]).toBeCloseTo(.9);await port.destroy();
    });
    it('明确缩小的SDK输入不冒充原比例帧，即使输入输出填充尺寸彼此相同',async()=>{
        const fixture=detectorFixture();mocks.options.mockImplementationOnce(options=>{options.detection.maxSideLength=100;});
        fixture.feeds.x!.dims=[1,3,128,128];fixture.output.probability={data:new Float32Array(128*128),dims:[1,1,128,128]};
        const port=await createBrowserMangaOcr(),page=await port.recognize('scaled detector',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.results).toEqual(response.results);expect(page.imageDetectionFrames).toBeUndefined();expect(fixture.run).toHaveBeenCalledOnce();await port.destroy();
    });
    it.each(['missing-x','input-rank','input-batch','input-channels','missing-output','output-rank','output-batch','output-channels','output-width','output-not-float32','changed-height','different-canvas'] as const)(
        '公开推理端口无法证明同一原比例平面时不发布侧车且保留原SDK结果：%s',async mismatch=>{
            const fixture=detectorFixture();
            if(mismatch==='missing-x')delete fixture.feeds.x;
            if(mismatch==='input-rank')fixture.feeds.x!.dims=[1,3,224];
            if(mismatch==='input-batch')fixture.feeds.x!.dims[0]=2;
            if(mismatch==='input-channels')fixture.feeds.x!.dims[1]=1;
            if(mismatch==='missing-output')delete fixture.output.probability;
            if(mismatch==='output-rank')fixture.output.probability.dims=[1,224,224];
            if(mismatch==='output-batch')fixture.output.probability.dims[0]=2;
            if(mismatch==='output-channels')fixture.output.probability.dims[1]=2;
            if(mismatch==='output-width')fixture.output.probability.dims[3]=192;
            if(mismatch==='output-not-float32')fixture.output.probability.data=new Uint8Array(224*224);
            if(mismatch==='changed-height')mocks.detectionRun.mockImplementation(async function(this:any,canvas:any){canvas.height++;await this.session.run(fixture.feeds);return [];});
            if(mismatch==='different-canvas')mocks.recognize.mockImplementation(async function(this:any,canvas:any){await this.detector.run({width:canvas.width,height:canvas.height});return response;});
            const port=await createBrowserMangaOcr(),page=await port.recognize('unproven detector plane',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
            expect(page.results).toEqual(response.results);expect(page.imageDetectionFrames).toBeUndefined();expect(fixture.run).toHaveBeenCalledOnce();
            expect(fixture.probabilities[15*224+15]).toBeCloseTo(.9);await port.destroy();
        },
    );
    it('session未声明首输出名时只读取SDK固定检测输出名，不执行第二次推理',async()=>{
        const fixture=detectorFixture();fixture.session.outputNames=[];
        fixture.output['sigmoid_0.tmp_0']=fixture.output.probability;delete fixture.output.probability;
        const port=await createBrowserMangaOcr(),page=await port.recognize('default output name',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.results).toEqual(response.results);expect(page.imageDetectionFrames).toHaveLength(1);
        expect(page.imageDetectionFrames![0].bits[(15*200+15)>>3]&(1<<((15*200+15)&7))).not.toBe(0);
        expect(fixture.run).toHaveBeenCalledOnce();expect(fixture.run).toHaveBeenCalledWith(fixture.feeds);await port.destroy();
    });
    it('绑定实际regions数组与同图，不把bits混进文字、阅读或结构克隆',async()=>{
        const bits=new Uint8Array(5000);bits[(15*200+15)>>3]|=1<<((15*200+15)&7);
        const port={recognize:vi.fn(async(_image:string,_options:unknown)=>({...response,imageDetectionFrames:[{pageWidth:200,pageHeight:200,x:0,y:0,width:200,height:200,bits}]})),destroy:vi.fn()};
        const runtime=createMangaOcrRuntime(async()=>port),regions=await runtime.recognize('same','en',200,200,undefined,undefined,undefined,'image');
        const evidence=getImageDetectionEvidence(regions,'same',200,200)!;
        expect(evidence.forBox({x0:14,y0:14,x1:16,y1:16},{left:6,top:6,width:18,height:18})!(15,15)).toBe(true);
        expect(getImageDetectionEvidence([...regions],'same',200,200)).toBeUndefined();expect(getImageDetectionEvidence(regions,'other',200,200)).toBeUndefined();
        expect(JSON.stringify(regions)).not.toMatch(/imageDetection|bits|core/u);
        expect(port.recognize.mock.calls[0][1]).toMatchObject({imageDetectionEvidence:true});await runtime.dispose();
    });
});
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();mocks.contexts=[];mocks.canvases=[];mocks.sessions=[];mocks.detectors=[];mocks.recognitors=[];mocks.recognitionProcessor.mockReset();mocks.createProcessor.mockReset();mocks.gpu.mockResolvedValue({available:false,info:''});mocks.assets.mockResolvedValue({charactersDictionary:new ArrayBuffer(4)});mocks.initialize.mockResolvedValue(undefined);mocks.destroy.mockResolvedValue(undefined);mocks.remove.mockResolvedValue(undefined);mocks.inpaintDispose.mockResolvedValue(undefined);mocks.recognize.mockResolvedValue(response);vi.stubGlobal('GPUDevice',class{get adapterInfo(){return {};}});vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>'chrome-extension://test'+p}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1,2,3]))));
    mocks.recognitionRun.mockReset().mockImplementation((...args:unknown[])=>mocks.retryRecognition(...args));mocks.retryRecognition.mockReset().mockResolvedValue([]);mocks.planDeskew.mockReset().mockReturnValue(undefined);mocks.trimDeskew.mockReset().mockReturnValue(undefined);mocks.workerPrepare.mockReset().mockResolvedValue(undefined);mocks.workerRequest.mockReset().mockResolvedValue(response);mocks.workerRelease.mockReset().mockResolvedValue(undefined);mocks.encode.mockReset().mockResolvedValue('data:image/png;base64,rasterized');
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:200,height:200,close:mocks.bitmapClose})));
    vi.stubGlobal('document',{createElement:vi.fn(()=>{const ctx={drawImage:vi.fn(),fillRect:vi.fn(),putImageData:vi.fn(),translate:vi.fn(),rotate:vi.fn(),getImageData:vi.fn(()=>({data:opaquePixels()}))};const canvas={width:0,height:0,getContext:vi.fn(()=>ctx)};mocks.contexts.push(ctx);mocks.canvases.push(canvas);return canvas;})});
});
beforeEach(()=>{mocks.tensorConstruct.mockReset();});
afterEach(async()=>{await mangaOcrRuntime.dispose().catch(()=>undefined);vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()});

describe('原批次结束后的检测核心接纳',()=>{
    function fixture(clone=false,transparent=false){
        const data=new Float32Array(224*224).fill(.1);data[15*224+35]=.9;
        const run=vi.fn(async()=>({probability:{dims:[1,1,224,224],data}})),session={run,outputNames:['probability']};mocks.sessions=[session];
        const regions=[10,30,50].map(x=>({bbox:{x0:x,y0:10,x1:x+10,y1:20},area:100}));
        mocks.createProcessor.mockImplementation(()=>({findRegions:vi.fn(()=>regions)}));
        let boxes:any[]=[],raw:any[]=[];
        mocks.detectionRun.mockImplementation(async function(this:any){
            await this.session.run({x:{type:'float32',dims:[1,3,224,224]}});
            const mapped=this.platform.canvas.createProcessor({width:224,height:224}).findRegions({padding:{vertical:.1,horizontal:.2},scale:1});
            boxes=mapped.map(({bbox:b}:any)=>({x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0}));return boxes;
        });
        mocks.recognize.mockImplementation(async function(this:any,canvas:unknown){
            const found=await this.detector.run(canvas);raw=found.map((box:any,index:number)=>({text:['SA','OK','17'][index],confidence:.99,box:clone?{...box}:box}));return {results:raw};
        });
        if(transparent){
            const original=vi.mocked(document.createElement).getMockImplementation()!;let first=true;
            vi.mocked(document.createElement).mockImplementation(()=>{const canvas=original('canvas');if(first){first=false;const pixels=opaquePixels();pixels[3]=0;mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});}return canvas;});
        }
        return{data,run,get boxes(){return boxes;},get raw(){return raw;}};
    }
    it('原检测框和识别批次全部保留，弱纹理不进入正文，原数字仍进入保护',async()=>{
        const f=fixture(),before=f.data.slice(),port=await createBrowserMangaOcr();const page=await port.recognize('core',{flatten:true,noCache:true,strategy:'per-box'});
        expect(f.boxes).toHaveLength(3);expect(f.raw.map(x=>x.text)).toEqual(['SA','OK','17']);expect(page.results.map(x=>x.text)).toEqual(['OK']);
        expect(page.results[0]).toBe(f.raw[1]);expect(page.numericEvidence).toEqual([f.raw[2]]);expect(f.run).toHaveBeenCalledOnce();expect(mocks.recognize).toHaveBeenCalledOnce();expect(f.data).toEqual(before);
        expect(mocks.detectors[0].detectionCore.rejects(f.boxes[0])).toBe(false);await port.destroy();
    });
    it('返回的Box克隆没有原身份时保持全部原结果',async()=>{
        const f=fixture(true),port=await createBrowserMangaOcr();const page=await port.recognize('cloned',{flatten:true,noCache:true,strategy:'per-box'});
        expect(page.results).toEqual(f.raw);expect(page.results[0].box).not.toBe(f.boxes[0]);await port.destroy();
    });
    it('低于核心门槛的检测边缘仍原样进入透明修补侧车',async()=>{
        const f=fixture(false,true),port=await createBrowserMangaOcr();const page=await port.recognize('alpha-core',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        expect(page.results.map(x=>x.text)).toEqual(['OK']);expect(page.numericEvidence?.[0].text).toBe('17');expect(page.imageDetectionFrames).toHaveLength(1);
        const frame=page.imageDetectionFrames![0],index=15*200+15;expect(frame.bits[index>>3]&(1<<(index&7))).not.toBe(0);expect(f.data[15*224+15]).toBeCloseTo(.1);await port.destroy();
    });
});

describe('原识别完成后的弱连接检测框补救',()=>{
    const options={flatten:true as const,noCache:true as const,strategy:'per-box' as const};
    function fixture(ink=true){
        const data=new Float32Array(224*224),pixels=new Uint8ClampedArray(200*200*4);
        for(let y=0;y<200;y++)for(let x=0;x<200;x++)pixels.set([245,240,221,255],(y*200+x)*4);
        for(let y=20;y<180;y++)for(let x=20;x<180;x++)data[y*224+x]=.1;
        for(let y=70;y<82;y++)for(let x=40;x<136;x++){
            data[y*224+x]=.9;
            if(ink&&(x-40)%8<4)pixels.set([30,30,30,255],(y*200+x)*4);
        }
        const run=vi.fn(async()=>({probability:{dims:[1,1,224,224],data}}));mocks.sessions=[{run,outputNames:['probability']}];
        mocks.createProcessor.mockImplementation(()=>({findRegions:vi.fn(()=>[{bbox:{x0:20,y0:20,x1:180,y1:180},area:25600}])}));
        mocks.detectionRun.mockImplementation(async function(this:any,canvas:any){
            await this.session.run({x:{type:'float32',dims:[1,3,224,224]}});
            return this.platform.canvas.createProcessor({width:224,height:224}).findRegions({padding:{vertical:.1,horizontal:.2},scale:1})
                .map(({bbox:b}:any)=>({x:b.x0,y:b.y0,width:Math.min(b.x1,canvas.width)-b.x0,height:Math.min(b.y1,canvas.height)-b.y0}));
        });
        let service:any,raw:any[]=[];
        mocks.recognize.mockImplementation(async function(this:any,canvas:any){
            service=this;raw=(await this.detector.run(canvas)).map((box:any)=>({text:'O HE C N T',confidence:.69,box}));return {results:raw};
        });
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{const canvas=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});return canvas;});
        mocks.retryRecognition.mockImplementation(async(_canvas,boxes)=>[{text:'CHECK THE SOUTH GATE',confidence:.997,box:boxes[0]}]);
        return{pixels,data,run,get raw(){return raw;},get service(){return service;}};
    }
    it('原检测与原批次不变，双裁图一致后才替换巨大错框，复用原像素且释放所有画布',async()=>{
        const f=fixture(),pixels=f.pixels.slice(),probabilities=f.data.slice(),port=await createBrowserMangaOcr();
        const page=await port.recognize('bridged title',options);
        expect(page.results).toEqual([{text:'CHECK THE SOUTH GATE',confidence:.997,box:{x:36,y:66,width:104,height:20}}]);
        expect(f.raw).toEqual([{text:'O HE C N T',confidence:.69,box:{x:0,y:4,width:200,height:192}}]);
        expect(f.run).toHaveBeenCalledOnce();expect(mocks.recognize).toHaveBeenCalledOnce();
        expect(mocks.retryRecognition.mock.calls.map(call=>[call[1],call[3],call[4]])).toEqual([
            [[{x:0,y:0,width:104,height:20}],'per-box',{recBatchSize:1}],
            [[{x:0,y:0,width:108,height:24}],'per-box',{recBatchSize:1}],
        ]);
        expect(mocks.contexts.flatMap(ctx=>ctx.getImageData.mock.calls)).toEqual([[0,0,200,200]]);
        expect(mocks.contexts[1].drawImage).toHaveBeenCalledWith(mocks.canvases[0],36,66,104,20,0,0,104,20);
        expect(mocks.contexts[2].drawImage).toHaveBeenCalledWith(mocks.canvases[0],34,64,108,24,0,0,108,24);
        expect(f.pixels).toEqual(pixels);expect(f.data).toEqual(probabilities);expect(f.service.detector.detectionCore.takeRefinements()).toEqual([]);
        expect(mocks.canvases).toHaveLength(3);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
    it('没有完整源墨迹时不发起附加推理，保留原结果及其身份',async()=>{
        const f=fixture(false),port=await createBrowserMangaOcr(),page=await port.recognize('blank source',options);
        expect(page.results[0]).toBe(f.raw[0]);expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases).toHaveLength(1);await port.destroy();
    });
    it.each([false,true])('新增数值复核仍进入保护，不丢已有保护证据：existing=%s',async existing=>{
        const f=fixture(),number={text:'18',confidence:.99,box:{x:170,y:10,width:10,height:10}},original=mocks.recognize.getMockImplementation()!;
        mocks.recognize.mockImplementation(async function(this:any,...args:unknown[]){const page=await original.apply(this,args);return {...page,...(existing?{numericEvidence:[number]}:{})};});
        mocks.retryRecognition.mockImplementation(async(_canvas,boxes)=>[{text:'42',confidence:.998,box:boxes[0]}]);
        const port=await createBrowserMangaOcr(),page=await port.recognize('bridged number',options);
        expect(page.results[0]).toMatchObject({text:'42',box:{x:36,y:66,width:104,height:20}});
        expect(page.numericEvidence).toEqual([...(existing?[number]:[]),page.results[0]]);expect(f.run).toHaveBeenCalledOnce();await port.destroy();
    });
    it('局部气泡和局部数字均阻止补救盖过已有文字，数字保护超限前不修改页对象',async()=>{
        const f=fixture(),port=await createBrowserMangaOcr();await port.recognize('capture service',options);
        const core=f.service.detector.detectionCore,record={core:{x0:40,y0:70,x1:136,y1:82},crop:{x0:36,y0:66,x1:140,y1:86},parent:{x0:0,y0:4,x1:200,y1:196},area:1152,pageWidth:200,pageHeight:200};
        vi.spyOn(core,'takeRefinements').mockImplementation(()=>[record]);
        const candidate={text:'existing',confidence:.99,box:{x:40,y:70,width:96,height:12}},canvas={width:200,height:200};
        mocks.retryRecognition.mockClear();
        for(const bubble of [{results:[candidate]},{results:[],numericEvidence:[candidate]}]){
            const page={results:f.raw};await f.service.recoverDetectionFrames(canvas,f.pixels,page,[bubble]);expect(page.results).toBe(f.raw);
        }
        expect(mocks.retryRecognition).not.toHaveBeenCalled();
        mocks.retryRecognition.mockImplementation(async(_canvas,boxes)=>[{text:'42',confidence:.998,box:boxes[0]}]);
        const numericEvidence=Array(4096).fill({text:'18',confidence:.99,box:{x:170,y:10,width:10,height:10}}),page={results:f.raw,numericEvidence};
        await expect(f.service.recoverDetectionFrames(canvas,f.pixels,page,[])).rejects.toThrow('数字保护区域过于复杂');
        expect(page.results).toBe(f.raw);expect(page.numericEvidence).toBe(numericEvidence);expect(mocks.retryRecognition).toHaveBeenCalledTimes(2);await port.destroy();
    });
    it.each(['cancel','throw','sdk-swallowed','no-context'])('补救失败仍报告首因并释放资源，同一会话下一页可重试：%s',async stage=>{
        const f=fixture(),controller=new AbortController(),failure=new Error('refinement inference failed');
        const recognitionSession={run:vi.fn().mockRejectedValue(failure),release:vi.fn()};mocks.sessions.push(recognitionSession);
        if(stage==='no-context'){
            const factory=vi.mocked(document.createElement).getMockImplementation()!;
            vi.mocked(document.createElement).mockImplementation(()=>{const canvas=factory('canvas') as HTMLCanvasElement;if(mocks.canvases.length===2)vi.mocked(canvas.getContext).mockReturnValue(null);return canvas;});
        }
        mocks.retryRecognition.mockImplementationOnce(async()=>{
            if(stage==='cancel')controller.abort();
            if(stage==='throw')throw failure;
            if(stage==='sdk-swallowed')try{await recognitionSession.run(recognitionFeeds());}catch{}
            return [];
        });
        const port=await createBrowserMangaOcr(),pending=port.recognize('failed supplement',{...options,signal:controller.signal});
        if(stage==='cancel')await expect(pending).rejects.toMatchObject({name:'AbortError'});
        else if(stage==='no-context')await expect(pending).rejects.toThrow('浏览器不支持图片处理');
        else await expect(pending).rejects.toBe(failure);
        expect(f.service.detector.detectionCore.takeRefinements()).toEqual([]);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();
        mocks.retryRecognition.mockReset().mockImplementation(async(_canvas,boxes)=>[{text:'CHECK THE SOUTH GATE',confidence:.997,box:boxes[0]}]);
        expect((await port.recognize('next page',options)).results[0].text).toBe('CHECK THE SOUTH GATE');await port.destroy();
    });
});

it('两个独立注音候选按实际墨迹量排序，不以正文左右顺序占用优先位置',()=>{
    const pixels=new Uint8ClampedArray(400*400*4).fill(255);
    for(const [x0,y0,x1,y1]of [[80,28,88,55],[280,108,284,122]])for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)pixels.set([0,0,0,255],(y*400+x)*4);
    const left={text:'天地玄黄',confidence:.99,box:{x:50,y:20,width:20,height:100}},right={text:'宇宙洪荒',confidence:.99,box:{x:250,y:100,width:20,height:100}};
    const plans=planMangaRubyRescueCrops({results:[left,right]},400,400,pixels);
    expect(plans.map(p=>p.inkPixels)).toEqual([216,56]);expect(plans.map(p=>p.side.x0)).toEqual([72,272]);
});

describe('普通图片的段落静区证明生产与实际结果绑定',()=>{
    function paragraphFixture(alpha=255){
        const pixels=new Uint8ClampedArray(200*200*4);
        for(let y=0;y<200;y++)for(let x=0;x<200;x++)pixels.set([24+(alpha===224?Math.floor(x/5):0),44,68,alpha],(y*200+x)*4);
        const results=[{text:'First complete line',confidence:.99,box:{x:40,y:40,width:90,height:14}},
            {text:'Second complete line',confidence:.99,box:{x:40,y:74,width:90,height:14}}];
        for(const item of results)for(let x=item.box.x+4;x<item.box.x+item.box.width-4;x+=8)
            for(let y=item.box.y+3;y<item.box.y+11;y++)for(let dx=0;dx<3;dx++)pixels.set([240,245,250,255],(y*200+x+dx)*4);
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});return canvas;
        });
        mocks.recognize.mockResolvedValue({results});
        return{pixels,results,options:{flatten:true as const,noCache:true as const,strategy:'per-box' as const,imageDetectionEvidence:true as const}};
    }
    it.each([255,224])('alpha=%s复用既有整图读取，证明随结果graph克隆后只绑定实际数组和原图',async alpha=>{
        const f=paragraphFixture(alpha),port=await createBrowserMangaOcr(),page=await port.recognize('source',f.options);
        expect(page.imageParagraphGapProofs).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledOnce();expect(mocks.canvases).toHaveLength(1);
        expect(mocks.contexts.flatMap(context=>context.getImageData.mock.calls)).toEqual([[0,0,200,200]]);
        expect(mocks.contexts[0].putImageData).not.toHaveBeenCalled();
        expect(mocks.contexts[0].fillRect).toHaveBeenCalledTimes(alpha===255?0:1);
        if(alpha!==255)expect(mocks.contexts[0].fillRect).toHaveBeenCalledWith(0,0,200,200);
        expect(f.pixels[3]).toBe(alpha);
        expect(page.results).toEqual(f.results);expect(page.results[0]).toBe(f.results[0]);expect(page.imageDetectionFrames).toBeUndefined();
        const cloned=structuredClone(page);
        // structured clone必须保留同一消息graph内部的原端点引用；不接受按坐标重建的替代对象。
        expect(cloned.imageParagraphGapProofs![0].previous).toBe(cloned.results[0]);
        expect(cloned.imageParagraphGapProofs![0].next).toBe(cloned.results[1]);
        const runtime=createMangaOcrRuntime(async()=>({recognize:vi.fn(async()=>cloned),destroy:vi.fn()}));
        const regions=await runtime.recognize('original-uri','en',200,200,undefined,undefined,undefined,'image');
        const evidence=getImageParagraphGapEvidence(regions,'original-uri',200,200)!;
        expect(evidence).toBeDefined();expect(evidence.successor(regions[0])).toBe(regions[1]);
        expect(getImageParagraphGapEvidence([...regions],'original-uri',200,200)).toBeUndefined();
        expect(getImageParagraphGapEvidence(regions,'different-uri',200,200)).toBeUndefined();
        expect(getImageParagraphGapEvidence(regions,'original-uri',199,200)).toBeUndefined();
        expect(getImageParagraphGapEvidence(structuredClone(regions),'original-uri',200,200)).toBeUndefined();
        expect(JSON.stringify(regions)).not.toMatch(/imageParagraph|proof|pixels|Snapshot/iu);
        expect(regions).toHaveLength(2);expect(regions.every(region=>region.sourceBoxes===undefined)).toBe(true);
        await runtime.dispose();await port.destroy();
    });
    it('漫画段落侧车复用同次原图像素，不请求普通图片检测帧',async()=>{
        paragraphFixture();const port=await createBrowserMangaOcr();
        const page=await port.recognize('manga source',{flatten:true,noCache:true,strategy:'per-box',mangaParagraphGapEvidence:true});
        expect(page.imageParagraphGapProofs).toHaveLength(1);expect(page.imageDetectionFrames).toBeUndefined();
        expect(mocks.recognize).toHaveBeenCalledOnce();expect(mocks.canvases).toHaveLength(1);
        expect(mocks.contexts.flatMap(context=>context.getImageData.mock.calls)).toEqual([[0,0,200,200]]);
        await port.destroy();
    });
    it('漫画请求不生产段落例外，不透明无候选图片也保持单次读取和原识别次数',async()=>{
        const f=paragraphFixture(),port=await createBrowserMangaOcr();
        const manga=await port.recognize('manga',{flatten:true,noCache:true,strategy:'per-box'});
        expect(manga.imageParagraphGapProofs).toBeUndefined();
        mocks.recognize.mockResolvedValue({results:[f.results[0]]});
        const image=await port.recognize('ordinary-no-pair',f.options);
        expect(image.imageParagraphGapProofs).toBeUndefined();expect(mocks.recognize).toHaveBeenCalledTimes(2);
        expect(mocks.contexts.flatMap(context=>context.getImageData.mock.calls)).toEqual([[0,0,200,200],[0,0,200,200]]);
        expect(mocks.canvases).toHaveLength(2);await port.destroy();
    });
});

it('方向复识别覆盖原数字时保留原始物理证据，避免重跑模型',async()=>{
    const source={text:'90%',confidence:.8,box:{x:30,y:20,width:20,height:100}};
    mocks.recognize.mockResolvedValueOnce({results:[source]});
    mocks.retryRecognition.mockResolvedValueOnce([{text:'SALE',confidence:.95,box:{...source.box}}]);
    const port=await createBrowserMangaOcr(),page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.results).toEqual([{text:'SALE',confidence:.95,box:source.box}]);expect(page.numericEvidence).toEqual([source]);
    const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
    expect(collectMangaRegions(page,'en',200,200,'image').filter(item=>item.guardOnly).map(item=>item.bbox))
        .toEqual([{x0:30,y0:20,x1:50,y1:120}]);
    expect(mocks.recognize).toHaveBeenCalledOnce();expect(mocks.retryRecognition).toHaveBeenCalledOnce();await port.destroy();
});
it('Worker 返回数值证据后，OCR 运行时将其保留为不可阅读的物理保护框',async()=>{
    const bbox={x:30,y:20,width:20,height:10},page={results:[{text:'SALE',confidence:.99,box:bbox}],
        numericEvidence:[{text:'90%',confidence:.8,box:bbox}]};
    const destroy=vi.fn(),port={recognize:vi.fn(async()=>page),destroy},runtime=createMangaOcrRuntime(async()=>port);
    const lines=await runtime.recognize('image','en',200,200,undefined,undefined,undefined,'image');
    expect(lines.filter(line=>!line.guardOnly).map(line=>line.text)).toEqual(['SALE']);
    expect(lines.filter(line=>line.guardOnly)).toMatchObject([{text:'',bbox:{x0:30,y0:20,x1:50,y1:30}}]);
    expect(port.recognize).toHaveBeenCalledOnce();await runtime.dispose();expect(destroy).toHaveBeenCalledOnce();
});
it('旋转复识别发现但不采用的数字，仍映回原始框作为防擦证据',async()=>{
    const source={text:'SALE',confidence:.8,box:{x:30,y:20,width:20,height:100}};
    mocks.recognize.mockResolvedValueOnce({results:[source]});
    mocks.retryRecognition.mockResolvedValueOnce([{text:'90%',confidence:.81,box:{x:0,y:0,width:20,height:100}}]);
    const port=await createBrowserMangaOcr(),page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.results).toEqual([source]);expect(page.numericEvidence).toEqual([{text:'90%',confidence:.81,box:source.box}]);
    expect(mocks.retryRecognition).toHaveBeenCalledOnce();await port.destroy();
});
it('直向复识别出现与原弱框不匹配的数字，不创建无关防擦框',async()=>{
    const source={text:'左の列',confidence:.8,box:{x:30,y:20,width:20,height:100}};
    mocks.recognize.mockResolvedValueOnce({results:[source]});
    mocks.retryRecognition.mockResolvedValueOnce([{text:'90%',confidence:.99,box:{x:70,y:20,width:20,height:100}}]);
    const port=await createBrowserMangaOcr(),page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.results).toEqual([source]);expect(page.numericEvidence).toBeUndefined();
    expect(mocks.retryRecognition).toHaveBeenCalledOnce();await port.destroy();
});
it('真实瓦片编排在全图去重前保留跨瓦片冲突数字，并映回全图坐标',async()=>{
    const first={text:'90%',confidence:.89,box:{x:900,y:20,width:40,height:10}};
    const second={text:'SALE',confidence:.99,box:{x:36,y:20,width:40,height:10}};
    mocks.recognize.mockResolvedValueOnce({results:[first]}).mockResolvedValueOnce({results:[second]});
    const source={naturalWidth:2400,naturalHeight:200} as HTMLImageElement,port=await createBrowserMangaOcr();
    const page=await port.recognize('tiles',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
    expect(page.results.map(item=>item.text)).toEqual(['SALE']);expect(page.numericEvidence).toEqual([first]);
    const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
    expect(collectMangaRegions(page,'en',2400,200,'image').filter(item=>item.guardOnly).map(item=>item.bbox))
        .toEqual([{x0:900,y0:20,x1:940,y1:30}]);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
});
it('放大气泡的数字证据按真实缩放还原为原图物理框',async()=>{
    const pixels=opaquePixels();for(let y=40;y<90;y++)for(let x=30;x<80;x++)pixels.fill(255,(y*200+x)*4,(y*200+x)*4+4);
    const original=vi.mocked(document.createElement).getMockImplementation()!;let main=true;
    vi.mocked(document.createElement).mockImplementation(()=>{const canvas=original('canvas');if(main){main=false;mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});}return canvas;});
    mocks.recognize.mockResolvedValueOnce(response).mockResolvedValueOnce({results:[{text:'90%',confidence:.8,box:{x:15,y:30,width:90,height:30}}]});
    const port=await createBrowserMangaOcr(),page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.bubbles?.[0].numericEvidence?.[0].box).toEqual({x:35,y:50,width:30,height:10});
    const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
    expect(collectMangaRegions(page,'en',200,200,'image').filter(item=>item.guardOnly).map(item=>item.bbox))
        .toEqual([{x0:35,y0:50,x1:65,y1:60}]);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
});
it.each([false,true])('瓦片去重前保留冲突数字的全图坐标且正常结果不变，数字先=%s',numberFirst=>{
    const tileA={x:0,y:0,width:100,height:100},tileB={x:50,y:0,width:100,height:100};
    const number={text:'90%',confidence:.89,box:{x:60,y:20,width:30,height:10}};
    const label={text:'SALE',confidence:.99,box:{x:10,y:20,width:30,height:10}};
    const pages=numberFirst?[{tile:tileA,results:[number]},{tile:tileB,results:[label]}]
        :[{tile:tileB,results:[label]},{tile:tileA,results:[number]}];
    expect(mergeMangaOcrTiles(pages,150,100).map(item=>item.text)).toEqual(['SALE']);
    const evidence=collectMangaOcrTileNumericEvidence(pages,150,100);expect(evidence).toEqual([number]);
    expect(collectMangaOcrTileNumericEvidence([{tile:tileB,results:[{...number,box:{x:-5,y:20,width:20,height:10}}]}],150,100)[0].box)
        .toEqual({x:50,y:20,width:15,height:10});
});
it('同文重复数值框去重，不同位置仍保留；非法坐标与超量数字明确报错',()=>{
    const tile={x:0,y:0,width:100,height:100};
    const item={text:'90%',confidence:.8,box:{x:10,y:10,width:20,height:10}};
    const other={...item,box:{...item.box,x:40}};
    expect(collectMangaOcrTileNumericEvidence([{tile,results:[item,{...item,confidence:.99},other,{...item,text:'SALE'}]}],100,100))
        .toEqual([item,other]);
    expect(()=>collectMangaOcrTileNumericEvidence([{tile,results:[{...item,box:{...item.box,x:NaN}}]}],100,100)).toThrow('保护位置无效');
    const many=Array.from({length:4097},(_,i)=>({...item,box:{x:i/100,y:10,width:.5,height:1}}));
    expect(()=>collectMangaOcrTileNumericEvidence([{tile,results:many}],100,100)).toThrow('保护区域过于复杂');
});
it.each(['conflict','weak','duplicate','both','invalid','outOfRange'] as const)('分块同框数值证据保留核对提示：%s',scenario=>{
    const tile={x:0,y:0,width:100,height:100};
    const readable={text:'90%',confidence:.99,box:{x:10,y:10,width:20,height:10}};
    const conflict={...readable,text:'80%'};
    const weak={...readable,confidence:.2};
    const rest=scenario==='conflict'?[conflict]:scenario==='weak'?[weak]:scenario==='both'?[conflict,weak]
        :scenario==='invalid'?[{...readable,confidence:NaN}]:scenario==='outOfRange'?[{...readable,confidence:1.1}]:[readable,readable];
    const all=[readable,...rest];
    const evidence=collectMangaOcrTileNumericEvidence([{tile,results:[readable],numericEvidence:all}],100,100);
    const lines=collectMangaRegions({results:[readable],numericEvidence:evidence},'en',100,100,'manga');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({text:'90%'});
    expect(lines[0].numericUncertain).toBe(scenario==='duplicate'?undefined:true);
    expect(evidence.length).toBeLessThanOrEqual(3);
    if(scenario==='duplicate')expect(evidence).toEqual([readable]);
});
it('重叠瓦片映回同一全图框后，不同顺序的三个数值和非法置信仍提示核对',()=>{
    const tiles=[{x:0,y:0,width:100,height:100},{x:50,y:0,width:100,height:100}];
    const box={x:60,y:20,width:30,height:10};
    const candidates=[{text:'90%',confidence:.99,box},{text:'80%',confidence:.98,box},{text:'70%',confidence:1.1,box}];
    const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    const toPage=(index:number,position:number)=>{
        const tile=tiles[position%2],candidate=candidates[index];
        return {tile,results:[],numericEvidence:[{...candidate,box:{...candidate.box,x:candidate.box.x-tile.x}}]};
    };
    for(const order of permutations){
        const evidence=collectMangaOcrTileNumericEvidence(order.map(toPage),150,100);
        expect(evidence.every(item=>item.box.x===60&&item.box.y===20)).toBe(true);
        expect(evidence.length).toBeLessThanOrEqual(3);
        const lines=collectMangaRegions({results:[candidates[0]],numericEvidence:evidence},'en',150,100,'manga');
        expect(lines).toHaveLength(1);expect(lines[0]).toMatchObject({text:'90%',numericUncertain:true});
    }
    const duplicate=collectMangaOcrTileNumericEvidence([toPage(0,0),toPage(0,1)],150,100);
    expect(duplicate).toEqual([candidates[0]]);
    expect(collectMangaRegions({results:[candidates[0]],numericEvidence:duplicate},'en',150,100,'manga')[0].numericUncertain).toBeUndefined();
});
it('过多首次数值证据会报错，且取消后清理识别画布，不发起重识别',async()=>{
    const many=Array.from({length:4097},(_,i)=>({text:'90%',confidence:.99,box:{x:i%100,y:1,width:1,height:1}}));
    mocks.recognize.mockResolvedValueOnce({results:many});
    const port=await createBrowserMangaOcr();
    await expect(port.recognize('too-many',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('保护区域过于复杂');
    expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    await port.destroy();
});
it('SDK 返回无文本结果时不构造数字证据，原识别结果保持不变',async()=>{
    const item={text:undefined,confidence:.99,box:{x:10,y:10,width:20,height:10}};
    mocks.recognize.mockResolvedValueOnce({results:[item]});
    const port=await createBrowserMangaOcr(),page=await port.recognize('empty-text',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.results).toEqual([item]);expect(page.numericEvidence).toBeUndefined();await port.destroy();
});
it('瓦片图外数值不构造保护框，空文本和异常瓦片位置独立处理',()=>{
    const tile={x:10,y:10,width:40,height:40},item={text:'90%',confidence:.8,box:{x:50,y:1,width:10,height:10}};
    expect(collectMangaOcrTileNumericEvidence([{tile,results:[item,{...item,text:''},{...item,text:undefined!}]}],100,100)).toEqual([]);
    expect(()=>collectMangaOcrTileNumericEvidence([{tile:{...tile,width:0},results:[item]}],100,100)).toThrow('保护位置无效');
});

describe('竖排漫画小注音的像素门控复识别',()=>{
    const main={text:'風の音',confidence:.99,box:{x:80,y:40,width:20,height:100}};
    const inked=()=>{
        const pixels=new Uint8ClampedArray(200*200*4);
        for(let offset=0;offset<pixels.length;offset+=4)pixels.set([100,200,150,255],offset);
        for(let y=45;y<61;y++)for(let x=111;x<119;x++)if((x+y)%3!==0)pixels.set([40,50,60,255],(y*200+x)*4);
        return pixels;
    };
    async function runRuby(firstResults:any[],rescue?:{results:any[]}|Error,before?:(service:any)=>void,missingContext=false){
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas') as HTMLCanvasElement;mocks.contexts.at(-1)!.getImageData.mockReturnValue({data:inked()});
            if(missingContext){const getContext=vi.mocked(canvas.getContext).getMockImplementation()!;vi.mocked(canvas.getContext).mockImplementation((...args:any[])=>
                canvas.width===108&&canvas.height===216?null:getContext(args[0] as any,args[1] as any));}
            return canvas;
        });
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){before?.(this);return Promise.resolve({results:firstResults});});
        if(rescue instanceof Error)mocks.recognize.mockRejectedValueOnce(rescue);
        else if(rescue)mocks.recognize.mockResolvedValueOnce(rescue);
        const port=await createBrowserMangaOcr(),decodedImage={width:200,height:200,close:mocks.bitmapClose};
        const page=await port.recognize('ruby-cases',{flatten:true,noCache:true,strategy:'per-box',decodedImage:decodedImage as any});
        await port.destroy();return{page,calls:mocks.recognize.mock.calls.length};
    }
    it('仅在紧邻竖列的窄侧栏存在有界高对比字迹时生成小裁框',()=>{
        const page={results:[main]},pixels=inked(),plans=planMangaRubyRescueCrops(page,200,200,pixels);
        expect(plans).toHaveLength(1);expect(plans[0]).toMatchObject({crop:{x0:102,y0:38,x1:138,y1:110},side:{x0:102,y0:38,x1:138,y1:110}});
        const partialAlpha=inked();for(const [x,y] of [[102,38],[119,38]])partialAlpha[(y*200+x)*4+3]=0;
        partialAlpha[(50*200+120)*4+3]=0;expect(planMangaRubyRescueCrops(page,200,200,partialAlpha)).toHaveLength(1);
        const insufficientAlpha=inked();for(const [x,y] of [[102,38],[119,38],[137,38],[102,73],[137,73]])insufficientAlpha[(y*200+x)*4+3]=0;
        expect(planMangaRubyRescueCrops(page,200,200,insufficientAlpha)).toEqual([]);
        expect(planMangaRubyRescueCrops(page,200,200,new Uint8ClampedArray(200*200*4).map((_,index)=>index%4===0?100:index%4===1?200:index%4===2?150:255))).toEqual([]);
        expect(planMangaRubyRescueCrops({results:[main,{text:'こみち',confidence:.99,box:{x:111,y:45,width:6,height:15}}]},200,200,pixels)).toEqual([]);
        expect(planMangaRubyRescueCrops({results:[main,{text:'こみち',confidence:.99,box:{x:111,y:150,width:6,height:15}}]},200,200,pixels)).toHaveLength(1);
        const coveredRuby={text:'こみち',confidence:.99,box:{x:100,y:45,width:20,height:15}};
        expect(planMangaRubyRescueCrops({results:[main,coveredRuby]},200,200,pixels,[main,coveredRuby],1,[main])).toEqual([]);
        const existingRuby={text:'こみち',confidence:.99,box:{x:111,y:150,width:6,height:15}};
        expect(planMangaRubyRescueCrops({results:[main,existingRuby]},200,200,pixels,[main,existingRuby],1,[main])).toHaveLength(1);
        const other={text:'風の音を',confidence:.99,box:{x:20,y:40,width:20,height:100}};
        expect(planMangaRubyRescueCrops({results:[main,other]},200,200,pixels,[main,other],1,[main,other])).toHaveLength(1);
        const combinedPixels=new Uint8ClampedArray(600*600*4);for(let offset=0;offset<combinedPixels.length;offset+=4)combinedPixels.set([100,200,150,255],offset);
        for(let y=45;y<66;y++)for(let x=250;x<265;x++)combinedPixels.set([40,50,60,255],(y*600+x)*4);
        const combined={text:'風の音を聞いて小道で待っている',confidence:.99,box:{x:80,y:40,width:160,height:350}};
        expect(planMangaRubyRescueCrops({results:[combined]},600,600,combinedPixels,[combined])).toHaveLength(1);
    });
    it('同一侧注的重复整列候选不会重复扫描，重叠侧栏保留墨迹更多的单个裁框',()=>{
        const pixels=inked(),sameGeometry=[
            {text:'風の音',confidence:.99,box:{x:80,y:40,width:20,height:100}},
            {text:'風の音を',confidence:.99,box:{x:80,y:40,width:20,height:100}},
        ];
        expect(planMangaRubyRescueCrops({results:sameGeometry},200,200,pixels)).toHaveLength(1);
        expect(planMangaRubyRescueCrops({results:[main,{...main}]},200,200,pixels)).toHaveLength(1);
        const overlapping=[
            {text:'風の音',confidence:.99,box:{x:80,y:40,width:20,height:100}},
            {text:'風の音を',confidence:.99,box:{x:75,y:40,width:30,height:100}},
        ];
        expect(planMangaRubyRescueCrops({results:overlapping},200,200,pixels)).toHaveLength(1);
    });
    it('高密度竖排页限制候选扫描量，不为第129条之后的侧注逐像素扫描',()=>{
        const width=8192,height=100,pixels=new Uint8ClampedArray(width*height*4);
        for(let offset=0;offset<pixels.length;offset+=4)pixels.set([100,200,150,255],offset);
        for(let y=20;y<36;y++)for(let x=40;x<50;x++)pixels.set([40,50,60,255],(y*width+x)*4);
        const items=Array.from({length:129},(_,index)=>({text:`風${index}音`,confidence:.99,box:{x:20+index*60,y:10,width:15,height:60}}));
        expect(planMangaRubyRescueCrops({results:items},width,height,pixels)).toEqual([]);
    });
    it('原彩色漫画的逐列与合并检测框都能定位右侧小假名，而已识别左注音不重跑',()=>{
        const pixels=new Uint8ClampedArray(gunzipSync(readFileSync(new URL('./fixtures/manga-color-quality/truth/rain-garden-vertical-ruby-sidebar.source-rgba.bin.gz',import.meta.url))));
        const right={text:'風の音を聞いて',confidence:.99,box:{x:832,y:150,width:44,height:300}},
            left={text:'小道で待っている',confidence:.99,box:{x:720,y:150,width:44,height:347}},rubyLeft={text:'こみち',confidence:.99,box:{x:778,y:154,width:18,height:52}};
        expect(planMangaRubyRescueCrops({results:[right,left]},1100,1500,pixels,[right,left,rubyLeft])).toHaveLength(1);
        const combined={text:right.text+left.text,confidence:.99,box:{x:717,y:149,width:159,height:351}};
        expect(planMangaRubyRescueCrops({results:[combined]},1100,1500,pixels,[combined,rubyLeft])).toHaveLength(1);
    });
    it('把局部放大OCR恢复的假名映回原图坐标；空白侧栏不额外推理',async()=>{
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        const unrelated={text:'caption',confidence:.99,box:{x:95,y:45,width:35,height:12}},farRuby={text:'かぜ',confidence:.99,box:{x:160,y:150,width:6,height:15}};
        vi.mocked(document.createElement).mockImplementationOnce(()=>{const canvas=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:inked()});return canvas;});
        mocks.recognize.mockResolvedValueOnce({results:[main,unrelated,farRuby]}).mockResolvedValueOnce({results:[{text:'かぜ',confidence:.96,box:{x:27,y:21,width:18,height:45}}]});
        const port=await createBrowserMangaOcr(),page=await port.recognize('ruby',{flatten:true,noCache:true,strategy:'per-box'});
        expect(planMangaRubyRescueCrops({results:[main,unrelated,farRuby]},200,200,mocks.contexts[0].getImageData.mock.results[0].value.data,[main,unrelated,farRuby])).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(page.results.map(item=>item.text)).toEqual(['風の音','caption','かぜ','かぜ']);
        expect(page.results[3].box).toEqual({x:111,y:45,width:6,height:15});expect(mocks.recognize).toHaveBeenCalledTimes(2);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });
    it('同位置已被包含该假名的完整OCR覆盖时才抑制救援结果',async()=>{
        const factory=vi.mocked(document.createElement).getMockImplementation()!,covered={text:'かぜ風',confidence:.99,box:{x:95,y:45,width:35,height:30}};
        vi.mocked(document.createElement).mockImplementationOnce(()=>{const canvas=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:inked()});return canvas;});
        mocks.recognize.mockResolvedValueOnce({results:[main,covered]}).mockResolvedValueOnce({results:[{text:'かぜ',confidence:.96,box:{x:27,y:21,width:18,height:45}}]});
        const port=await createBrowserMangaOcr(),page=await port.recognize('ruby-overlap',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(page.results.map(item=>item.text)).toEqual(['風の音','かぜ風']);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });
    it('救援失败、坏框和区域外候选均保留原页，服务预算不足时不再开新裁框',async()=>{
        const covered={text:'かぜ風',confidence:.99,box:{x:95,y:45,width:35,height:30}};
        const rejected=await runRuby([main,covered],new Error('ruby rescue failed'));
        expect(rejected.calls).toBe(2);expect(rejected.page.results.map(item=>item.text)).toEqual(['風の音','かぜ風']);

        const narrow=await runRuby([main],{results:[{text:'かぜ',confidence:.96,box:{x:27,y:21,width:18,height:15}}]});
        expect(narrow.page.results.map(item=>item.text)).toEqual(['風の音']);
        const outside=await runRuby([main],{results:[{text:'かぜ',confidence:.96,box:{x:100,y:21,width:18,height:45}}]});
        expect(outside.page.results.map(item=>item.text)).toEqual(['風の音']);

        const malformed={text:'かぜ',confidence:.99,box:{x:111,y:45,width:0,height:15}};
        const kept=await runRuby([main,malformed],{results:[{text:'かぜ',confidence:.96,box:{x:27,y:21,width:18,height:45}}]});
        expect(kept.page.results.map(item=>item.text)).toEqual(['風の音','かぜ','かぜ']);

        const noContext=await runRuby([main],undefined,undefined,true);
        expect(noContext.page.results.map(item=>item.text)).toEqual(['風の音']);
        const spent=await runRuby([main],undefined,service=>{service.remainingRubyRescues=0;expect(service.tryReserveMangaRubyRescue(0)).toBe(false);});
        expect(spent.calls).toBe(1);expect(spent.page.results.map(item=>item.text)).toEqual(['風の音']);
    });
});

describe('漫画检测平面的字行厚度 padding',()=>{
    it('长竖列按短边留白，不吞入邻列；裁边后再沿用检测平面坐标舍入',()=>{
        const box={x0:100,y0:200,x1:138,y1:578},snapshot={...box};
        expect(padMangaOcrDetectionBox(box,1280,1536,{vertical:.1,horizontal:.2})).toEqual({x0:92,y0:196,x1:146,y1:582});
        expect(box).toEqual(snapshot);
        expect(padMangaOcrDetectionBox({x0:1,y0:2,x1:10,y1:99},11,100,{vertical:.1,horizontal:.2},1.5)).toEqual({x0:0,y0:0,x1:17,y1:150});
        expect(padMangaOcrDetectionBox(box,1280,1536)).toEqual(box);
        expect(padMangaOcrDetectionBox(box,1280,1536,{})).toEqual(box);
    });
    it.each([
        {thickness:11,expected:{x0:80,y0:190,x1:131,y1:310}},
        {thickness:12,expected:{x0:98,y0:199,x1:114,y1:301}},
        {thickness:13,expected:{x0:97,y0:199,x1:116,y1:301}},
    ])('检测平面短边 $thickness px 的留白边界不删除细小框，也不按缩放后的厚度选策略',({thickness,expected})=>{
        const box=Object.freeze({x0:100,y0:200,x1:100+thickness,y1:300});
        expect(padMangaOcrDetectionBox(box,400,400,{vertical:.1,horizontal:.2})).toEqual(expected);
        expect(padMangaOcrDetectionBox(box,400,400,{vertical:.1,horizontal:.2},.5)).toEqual({x0:Math.round(expected.x0*.5),y0:Math.round(expected.y0*.5),x1:Math.round(expected.x1*.5),y1:Math.round(expected.y1*.5)});
        expect(box).toEqual({x0:100,y0:200,x1:100+thickness,y1:300});
    });
    it('水平原始框逐框保留原 SDK 的 padding、clip、round、scale 顺序，包括检测平面缩放与边缘框',()=>{
        const legacy=(box:{x0:number;y0:number;x1:number;y1:number},width:number,height:number,scale:number)=>{
            const v=Math.round((box.y1-box.y0)*.1),h=Math.round((box.y1-box.y0)*.2);
            const x0=Math.max(0,box.x0-h),y0=Math.max(0,box.y0-v),x1=Math.min(width,box.x1+h),y1=Math.min(height,box.y1+v);
            return scale===1?{x0,y0,x1,y1}:{x0:Math.max(0,Math.round(x0*scale)),y0:Math.max(0,Math.round(y0*scale)),x1:Math.round(x1*scale),y1:Math.round(y1*scale)};
        };
        for(const scale of [1,.5,1.25,1.5,2.7])for(let index=0;index<40;index++){
            const width=9+index*3,height=5+index,x0=index%2?0:100,y0=index%3?0:60,box={x0,y0,x1:x0+width,y1:y0+height};
            expect(padMangaOcrDetectionBox(box,box.x1+index%4,box.y1+index%5,{vertical:.1,horizontal:.2},scale)).toEqual(legacy(box,box.x1+index%4,box.y1+index%5,scale));
        }
    });
    it('只包装独立 SDK 实例的公开处理器，原 findRegions 只调用一次并保留 area、检测过滤和无参数行为',async()=>{
        const nativeRun=vi.fn(),session={run:nativeRun,release:vi.fn()};mocks.sessions=[session];
        const regions=[{bbox:{x0:10,y0:20,x1:18,y1:120},area:301,tag:'untouched'},{bbox:{x0:100,y0:20,x1:180,y1:40},area:99}],snapshot=JSON.stringify(regions);
        const processors:any[]=[],rawFinds:ReturnType<typeof vi.fn>[]=[];
        mocks.createProcessor.mockImplementation(()=>{
            const processor={grayscale(){return this;},threshold(){return this;},findRegions:vi.fn(function(this:unknown){expect(this).toBe(processor);return regions;})};
            processors.push(processor);rawFinds.push(processor.findRegions);return processor;
        });
        const first=await createBrowserMangaOcr(),second=await createBrowserMangaOcr();
        const [a,b]=mocks.detectors;expect(a.session).toBe(session);expect(a.options).toBe(mocks.options.mock.calls[0][0].detection);
        expect(a.platform.canvas).not.toBe(b.platform.canvas);
        expect(a.platform.canvas.createProcessor).not.toBe(b.platform.canvas.createProcessor);
        const canvas={width:200,height:150},processor=a.platform.canvas.createProcessor(canvas),options=Object.freeze({foreground:'light',minArea:20,thresh:0,padding:{vertical:.1,horizontal:.2},scale:1.5});
        expect(processor.grayscale().threshold({thresh:0})).toBe(processor);
        // 记录原函数后装饰函数仍将它绑定到同一处理器；SDK 的 area 筛选只运行一次。
        expect(processor.findRegions(options)).toEqual(regions.map(region=>({...region,bbox:padMangaOcrDetectionBox(region.bbox,200,150,options.padding,1.5)})));
        expect(rawFinds[0]).toHaveBeenCalledOnce();expect(rawFinds[0]).toHaveBeenCalledWith({...options,padding:undefined,scale:1});
        expect(JSON.stringify(regions)).toBe(snapshot);expect(options.scale).toBe(1.5);
        expect(mocks.createProcessor).toHaveBeenCalledOnce();expect(nativeRun).not.toHaveBeenCalled();
        const next=b.platform.canvas.createProcessor(canvas);expect(next.findRegions()).toEqual(regions);
        expect(processors).toHaveLength(2);expect(rawFinds[1]).toHaveBeenCalledOnce();expect(rawFinds[1]).toHaveBeenCalledWith({padding:undefined,scale:1});
        await first.destroy();await second.destroy();
    });
});

describe('漫画竖框的受限反向重试',()=>{
    const column=(text='M a p',confidence=.75)=>({text,confidence,box:{x:20,y:20,width:20,height:100}});
    it.each(['Map','mAP','Carte été','e\u0301cole','ＭＡＰ'])('仅当前模型拉丁输出可以改一次重试方向：%s',text=>{
        expect(shouldRotateMangaOcrRetry(column(text),200,200)).toBe(true);
    });
    it.each(['未来の駅','MAP未来','Mapあ','Mapカ','Map한','12345','!?','Журнал','العربية'])('CJK/混排/数字/非拉丁不猜方向：%s',text=>{
        expect(shouldRotateMangaOcrRetry(column(text),200,200)).toBe(false);
    });
    it('高置信、非竖框及无效或图外框保留原路径，不分配旋转像素',()=>{
        expect(shouldRotateMangaOcrRetry(column('Map',.9),200,200)).toBe(false);
        for(const change of [{height:36},{x:NaN},{x:-1},{y:-1},{width:.5},{x:190},{y:150}]){
            expect(shouldRotateMangaOcrRetry({...column(),box:{...column().box,...change}},200,200)).toBe(false);
        }
    });
    it('JA仍整组batch1原框识别，Latin只旋转同框，强置信和横框不改；结果顺序与物理坐标不变',async()=>{
        const latin=column(),ja={...column('未来の职',.7),box:{x:60,y:20,width:20,height:100}},strong=column('Good',.95);
        const horizontal={text:'wide',confidence:.7,box:{x:10,y:150,width:100,height:20}},page={results:[latin,ja,strong,horizontal]},snapshot=JSON.stringify(page);
        mocks.recognize.mockResolvedValueOnce(page);
        mocks.retryRecognition.mockResolvedValueOnce([{...ja,text:'未来の駅',confidence:.98}]).mockResolvedValueOnce([{text:'Map',confidence:.99,box:{x:0,y:0,width:20,height:100}}]);
        const port=await createBrowserMangaOcr(),result=await port.recognize('mixed',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.retryRecognition.mock.calls.map(call=>call[1])).toEqual([[ja.box],[{x:0,y:0,width:20,height:100}]]);
        expect(mocks.retryRecognition.mock.calls[0][0]).toBe(mocks.canvases[0]);expect(mocks.retryRecognition.mock.calls[1][0]).toBe(mocks.canvases[1]);
        expect(mocks.contexts[1].translate).toHaveBeenCalledWith(20,100);expect(mocks.contexts[1].rotate).toHaveBeenCalledWith(Math.PI);
        expect(mocks.contexts[1].drawImage).toHaveBeenCalledWith(mocks.canvases[0],20,20,20,100,0,0,20,100);
        expect(result.results.map(item=>item.text)).toEqual(['Map','未来の駅','Good','wide']);expect(result.results.map(item=>item.box)).toEqual(page.results.map(item=>item.box));
        expect(JSON.stringify(page)).toBe(snapshot);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each([{}, {x:1},{y:1},{width:21},{height:101},{confidence:.79},{confidence:.8}])('原框映回需完整匹配旋转crop，且仍需至少.05置信增益：%j',async change=>{
        const source=column();mocks.recognize.mockResolvedValueOnce({results:[source]});
        const {confidence=.99,...geometry}=change as {confidence?:number;x?:number;y?:number;width?:number;height?:number};
        mocks.retryRecognition.mockResolvedValueOnce([{text:'Map',confidence,box:{x:0,y:0,width:20,height:100,...geometry}}]);
        const port=await createBrowserMangaOcr(),result=await port.recognize('one',{flatten:true,noCache:true,strategy:'per-box'});
        expect(result.results).toEqual(Object.keys(geometry).length||confidence<.8?[source]:[{text:'Map',confidence,box:source.box}]);
        expect(mocks.retryRecognition).toHaveBeenCalledOnce();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it('空方向结果保留原文，四框total预算在瓦片之间共享且新页重置',async()=>{
        const columns=Array.from({length:6},(_,index)=>({...column('Map '+index,.7+index/100),box:{x:10+index*30,y:20,width:20,height:100}}));
        mocks.recognize.mockResolvedValue({results:columns});const source={naturalWidth:2400,naturalHeight:200} as HTMLImageElement,port=await createBrowserMangaOcr();
        for(let index=0;index<2;index++){
            const result=await port.recognize('tiles',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});expect(result.results[0].text).toBe('Map 0');
        }
        expect(mocks.recognize).toHaveBeenCalledTimes(4);expect(mocks.retryRecognition).toHaveBeenCalledTimes(8);
        expect(mocks.retryRecognition.mock.calls.every(call=>call[1].length===1)).toBe(true);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it('方向预处理的两百万像素在瓦片之间共享，超限框回原batch1且新页重置，不新增fallback画布',async()=>{
        const large=(index:number)=>({text:'Map '+index,confidence:.7+index/100,box:{x:20+index%2*710,y:20,width:700.4,height:1300.4}});
        const first={results:[large(0)]},second={results:[large(1),large(2)]};
        mocks.recognize.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const source={naturalWidth:1536,naturalHeight:2400} as HTMLImageElement,port=await createBrowserMangaOcr();
        for(let index=0;index<2;index++)await port.recognize('large columns',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        const cropBox={x:0,y:0,width:700,height:1300};
        expect(mocks.retryRecognition.mock.calls.map(call=>call[1])).toEqual([[cropBox],[second.results[1].box],[cropBox],[cropBox],[second.results[1].box],[cropBox]]);
        // 每页仅 source + tile + 两个 rotation；第三个超限框借用原 tile。
        expect(mocks.canvases).toHaveLength(8);
        expect(mocks.contexts.filter(ctx=>ctx.rotate.mock.calls.some((call:number[])=>call[0]===Math.PI))).toHaveLength(4);
        expect(mocks.retryRecognition.mock.calls[1][0]).toBe(mocks.canvases[1]);expect(mocks.retryRecognition.mock.calls[4][0]).toBe(mocks.canvases[5]);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it('斜行与反向竖框共用同一预处理像素余额，旋转超额框仍参与原框重试',async()=>{
        const horizontal={text:'slanted',confidence:.97,box:{x:10,y:10,width:500,height:200}};
        const columns=[0,1].map(index=>({text:'Map '+index,confidence:.7+index/100,box:{x:20+index*710,y:20,width:700,height:1300}}));
        mocks.recognize.mockResolvedValueOnce({results:[horizontal]}).mockResolvedValueOnce({results:columns});
        mocks.planDeskew.mockReturnValueOnce({radians:.1,width:500,height:200});mocks.trimDeskew.mockReturnValueOnce({x:0,y:0,width:500,height:200});
        const source={naturalWidth:1536,naturalHeight:2400} as HTMLImageElement,port=await createBrowserMangaOcr();
        await port.recognize('shared preprocessing',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(mocks.retryRecognition.mock.calls.map(call=>call[1])).toEqual([[{x:0,y:0,width:500,height:200}],[columns[1].box],[{x:0,y:0,width:700,height:1300}]]);
        expect(mocks.contexts.filter(ctx=>ctx.rotate.mock.calls.some((call:number[])=>call[0]===Math.PI))).toHaveLength(1);
        expect(mocks.canvases).toHaveLength(6);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each(['cancel','throw','sdk-swallowed','no-context'])('反向重试取消或失败仍保留首因并释放自身画布：%s',async stage=>{
        const controller=new AbortController(),failure=new Error('direction inference failed'),session={run:vi.fn().mockRejectedValue(failure),release:vi.fn()};
        mocks.sessions=[undefined,session];mocks.recognize.mockResolvedValueOnce({results:[column()]});
        if(stage==='no-context'){
            const factory=vi.mocked(document.createElement).getMockImplementation()!;
            vi.mocked(document.createElement).mockImplementation(()=>{const c=factory('canvas') as HTMLCanvasElement;if(mocks.canvases.length===2)vi.mocked(c.getContext).mockReturnValue(null);return c;});
        }
        mocks.retryRecognition.mockImplementationOnce(async()=>{
            if(stage==='cancel')controller.abort();
            if(stage==='throw')throw failure;
            if(stage==='sdk-swallowed')try{await session.run(recognitionFeeds());}catch{}
            return [];
        });
        const port=await createBrowserMangaOcr(),result=port.recognize('one',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal});
        if(stage==='cancel')await expect(result).rejects.toMatchObject({name:'AbortError'});
        else if(stage==='no-context')await expect(result).rejects.toThrow('浏览器不支持');
        else await expect(result).rejects.toBe(failure);
        expect(mocks.retryRecognition).toHaveBeenCalledTimes(stage==='no-context'?0:1);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
});

describe('跨页竖向拉丁OCR框的窄区复核',()=>{
    const source={text:' O X I N',confidence:.654,box:{x:746,y:148,width:98,height:876}};
    async function runTall(before?:(service:any)=>void,initial=[source]){
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas') as HTMLCanvasElement,context=mocks.contexts.at(-1)!;
            context.getImageData.mockImplementation((_x:number,_y:number,width:number,height:number)=>{
                const data=new Uint8ClampedArray(width*height*4);for(let offset=3;offset<data.length;offset+=4)data[offset]=255;return{data};
            });
            return canvas;
        });
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){before?.(this);return Promise.resolve({results:initial});});
        mocks.retryRecognition.mockReset().mockResolvedValue([]);
        const bitmap={width:1100,height:1500,close:mocks.bitmapClose},port=await createBrowserMangaOcr();
        const page=await port.recognize('tall-latin',{flatten:true,noCache:true,strategy:'per-box',decodedImage:bitmap as any});
        const calls=mocks.recognize.mock.calls.length;await port.destroy();return{page,calls};
    }
    it('只复核极高且覆盖大部分页面的拉丁框，不把正常竖排或混排文字重跑',()=>{
        const item={text:'IN D EX 0 0',confidence:.65,box:{x:746,y:148,width:98,height:876}};
        expect(shouldRescanTallMangaLatin(item,1100,1500)).toBe(true);
        expect(shouldRescanTallMangaLatin({...item,text:'INDEX未来'},1100,1500)).toBe(false);
        expect(shouldRescanTallMangaLatin({...item,confidence:.4},1100,1500)).toBe(false);
        expect(shouldRescanTallMangaLatin({...item,confidence:.95},1100,1500)).toBe(false);
        expect(shouldRescanTallMangaLatin({...item,box:{...item.box,height:500}},1100,1500)).toBe(false);
        expect(shouldRescanTallMangaLatin({...item,text:'1234'},1100,1500)).toBe(false);
    });
    it('旋转后重新检测并映回狭窄源框，避免清理整片插画',async()=>{
        vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1100,height:1500,close:mocks.bitmapClose})));
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas'),context=mocks.contexts.at(-1)!;
            context.getImageData.mockImplementation((_x:number,_y:number,width:number,height:number)=>{
                const data=new Uint8ClampedArray(width*height*4);for(let offset=3;offset<data.length;offset+=4)data[offset]=255;return {data};
            });
            return canvas;
        });
        const source={text:' O X I N',confidence:.654,box:{x:746,y:148,width:98,height:876}},
            corrected={text:'INDEX 09',confidence:.98,box:{x:259,y:35,width:100,height:17}};
        mocks.recognize.mockReset().mockResolvedValueOnce({results:[source]}).mockResolvedValueOnce({results:[corrected]});
        const port=await createBrowserMangaOcr(),page=await port.recognize('rotated-latin',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.recognize).toHaveBeenCalledTimes(2);
        expect(mocks.contexts[1].translate).toHaveBeenCalledWith(876,0);expect(mocks.contexts[1].rotate).toHaveBeenCalledWith(Math.PI/2);
        expect(page.results).toMatchObject([{text:'INDEX 09',box:{x:781,y:665,width:17,height:100}}]);
        mocks.recognize.mockReset().mockResolvedValueOnce({results:[source]}).mockResolvedValueOnce({results:[
            {text:undefined,confidence:.99,box:{x:0,y:0,width:80,height:10}},
            {text:'1234',confidence:.99,box:{x:10,y:20,width:60,height:10}},
            {text:'INDEX',confidence:.99,box:{x:870,y:10,width:20,height:10}},
        ]});
        const rejected=await port.recognize('rotated-invalid',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(rejected.results).toEqual([source]);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledTimes(2);await port.destroy();
    });
    it('窄区复核尊重重试和像素预算，并拒绝空、数字和图外识别框',async()=>{
        const noRetries=await runTall(service=>{service.remainingRetries=0;});
        expect(noRetries.calls).toBe(1);expect(noRetries.page.results).toEqual([source]);
        const noPixels=await runTall(service=>{service.remainingPreprocessingPixels=0;});
        expect(noPixels.calls).toBe(1);expect(noPixels.page.results).toEqual([source]);
    });
    it('优先复核更细长的框，再按置信选择有检测核心的窄框',async()=>{
        const weak={text:'INDEX 00',confidence:.999,box:{x:259,y:35,width:100,height:17}},good={text:'INDEX 09',confidence:.98,box:{x:259,y:35,width:100,height:17}},other={text:'INDEX 08',confidence:.95,box:{x:260,y:36,width:100,height:17}};
        mocks.sessions=[{run:vi.fn(),outputNames:[]}];
        const first={...source,box:{...source.box,width:110}},second={...source,box:{...source.box,x:500}},initial=[first,second];
        const result=await runTall(service=>{
            // 当前原数组在await期间可能被外部SDK复用；不得把迟到候选写进另一个对象。
            mocks.recognize.mockReset().mockImplementationOnce(()=>{initial.splice(initial.indexOf(second),1);return Promise.resolve({results:[weak,other,good]});});
            vi.spyOn(service.detector.detectionCore,'rejects').mockImplementation(box=>box===weak.box);
            mocks.recognize.mockResolvedValueOnce({results:[other,good]});
        },initial);
        expect(result.page.results).toMatchObject([{text:'INDEX 09',box:{x:781,y:665,width:17,height:100}}]);
        expect(mocks.recognize).toHaveBeenCalledTimes(2);
    });
    it('旋转裁框没有2D上下文时跳过复核并保留原OCR行',async()=>{
        vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1100,height:1500,close:mocks.bitmapClose})));
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas') as HTMLCanvasElement,getContext=vi.mocked(canvas.getContext).getMockImplementation()!;
            vi.mocked(canvas.getContext).mockImplementation((...args:any[])=>
                canvas.width===876&&canvas.height===98?null:getContext(args[0] as any,args[1] as any));
            const context=mocks.contexts.at(-1)!;
            context.getImageData.mockImplementation((_x:number,_y:number,width:number,height:number)=>{
                const data=new Uint8ClampedArray(width*height*4);for(let offset=3;offset<data.length;offset+=4)data[offset]=255;return{data};
            });
            return canvas;
        });
        mocks.recognize.mockResolvedValueOnce({results:[source]});mocks.retryRecognition.mockReset().mockResolvedValue([]);
        const port=await createBrowserMangaOcr(),page=await port.recognize('tall-no-context',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.recognize).toHaveBeenCalledOnce();expect(page.results).toEqual([source]);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });
});

describe('owner在全部局部映回后生成既有视图词界proof',()=>{
    function install(wholeText='AB CD',localText='ABCD',onWhole?:(owner:any)=>void){
        const pixels=new Uint8ClampedArray(200*200*4);for(let i=0;i<200*200;i++)pixels[i*4+3]=255;
        for(let y=40;y<90;y++)for(let x=30;x<80;x++)pixels.set([255,255,255,255],(y*200+x)*4);
        let x=42;for(const gap of [2,9,2,0]){for(let y=58;y<70;y++)for(let dx=0;dx<4;dx++)pixels.set([20,20,20,255],(y*200+x+dx)*4);x+=4+gap;}
        const box={x:40,y:55,width:33,height:18},whole={text:wholeText,confidence:.98,box:{...box}},number={text:'08:45',confidence:.99,box:{x:130,y:20,width:40,height:14}},localGeometry={...box};
        let localRaw:any,localSnapshot='',owner:any;
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas'),context=mocks.contexts.at(-1);
            context.getImageData.mockImplementation((_x:number,_y:number,width:number,height:number)=>{
                const draw=context.drawImage.mock.lastCall;if(draw?.length===3)return {data:pixels.slice()};
                const data=new Uint8ClampedArray(width*height*4),left=draw?.[1]??0,top=draw?.[2]??0;
                for(let y=0;y<height;y++)data.set(pixels.subarray(((top+y)*200+left)*4,((top+y)*200+left+width)*4),y*width*4);
                expect(mocks.bitmapClose).not.toHaveBeenCalled();return {data};
            });return canvas;
        });
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){owner=this;onWhole?.(this);return Promise.resolve({results:[whole,number]});})
            .mockImplementationOnce(async (canvas:any)=>{
                const context=mocks.contexts[mocks.canvases.indexOf(canvas)],draw=context.drawImage.mock.calls[0],sx=canvas.width/draw[3],sy=canvas.height/draw[4];
                localRaw={text:localText,confidence:.99,box:{x:(localGeometry.x-draw[1])*sx,y:(localGeometry.y-draw[2])*sy,width:localGeometry.width*sx,height:localGeometry.height*sy}};
                localSnapshot=JSON.stringify(localRaw);return {results:[localRaw]};
            });
        const options={flatten:true as const,noCache:true as const,strategy:'per-box' as const};
        const reads=()=>mocks.contexts.flatMap(c=>c.getImageData.mock.calls).filter((args:number[])=>args[2]===37&&args[3]===22);
        return {pixels,box,whole,number,localGeometry,options,reads,localRaw:()=>localRaw,localSnapshot:()=>localSnapshot,owner:()=>owner};
    }
    it.each(['naturalWidth','naturalHeight','src','currentSrc'] as const)('借用原图%s漂移时不读错图且不关闭借用对象',async field=>{
        const source={naturalWidth:200,naturalHeight:200,src:'original.png',currentSrc:'original.png'};
        const f=install('AB CD','ABCD',()=>{if(field==='naturalWidth'||field==='naturalHeight')source[field]++;else source[field]='different.png';});
        const port=await createBrowserMangaOcr(),page=await port.recognize('borrowed',{...f.options,decodedImage:source as HTMLImageElement});
        expect(page.wordBoundaryProofs).toBeUndefined();expect(f.reads()).toHaveLength(0);expect(mocks.bitmapClose).not.toHaveBeenCalled();
        expect(f.owner().readMangaSourceRegion({left:0,top:0,width:1,height:1})).toBeUndefined();await port.destroy();
    });
    it('稳定借用原图保持原始alpha、整数ROI边界和身份，页结束即释放reader',async()=>{
        let owner:any;
        const f=install('AB CD','ABCD',value=>{owner=value;const before=mocks.canvases.length,rect={left:0,top:0,width:1,height:1};
            for(const delta of [{left:.5},{left:-1},{top:-1},{width:0},{height:0},{width:201},{height:201}])expect(owner.readMangaSourceRegion({...rect,...delta})).toBeUndefined();
            for(const max of [0,-1,.5,131073])expect(owner.readMangaSourceRegion(rect,max)).toBeUndefined();
            expect(owner.readMangaSourceRegion({...rect,width:2,height:2},3)).toBeUndefined();expect(mocks.canvases).toHaveLength(before);
            expect(Array.from(owner.readMangaSourceRegion(rect,65536))).toEqual([64,96,144,235]);
        });
        f.pixels.set([64,96,144,235]);
        const source={naturalWidth:200,naturalHeight:200,src:'original.png',currentSrc:'original.png'} as HTMLImageElement;
        const port=await createBrowserMangaOcr(),page=await port.recognize('borrowed stable',{...f.options,decodedImage:source});
        expect(page.wordBoundaryProofs).toHaveLength(1);expect(mocks.bitmapClose).not.toHaveBeenCalled();
        expect(owner.readMangaSourceRegion({left:0,top:0,width:1,height:1})).toBeUndefined();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each(['read','draw','context','canvas'] as const)('原图%s失败按实际请求像素收费，不能重获2MP额度，新页才重置',async stage=>{
        let owner:any,first=true;
        const failure=new Error('exact source '+stage),f=install('AB CD','ABCD',value=>{owner=value;});
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            if(mocks.canvases.length===1&&first&&stage==='canvas'){first=false;throw failure;}
            const canvas=factory('canvas'),context=mocks.contexts.at(-1);
            if(mocks.canvases.length===2&&first){first=false;if(stage==='context')vi.mocked((canvas as HTMLCanvasElement).getContext).mockReturnValue(null);else context[stage==='draw'?'drawImage':'getImageData'].mockImplementation(()=>{throw failure;});}
            return canvas;
        });
        mocks.recognize.mockReset().mockImplementation(function(this:any){owner=this;const rect={left:0,top:0,width:200,height:200};
            if(first){let caught:unknown;try{this.readMangaSourceRegion(rect);}catch(error){caught=error;}
                if(stage==='context')expect(caught).toMatchObject({message:'浏览器不支持图片处理'});else expect(caught).toBe(failure);
                for(let i=0;i<49;i++)expect(this.readMangaSourceRegion(rect)).toHaveLength(160000);
                expect(this.readMangaSourceRegion({left:0,top:0,width:1,height:1})).toBeUndefined();
            }return Promise.resolve({results:[]});
        });
        const port=await createBrowserMangaOcr();await port.recognize('spent failed read',f.options);
        expect(owner.readMangaSourceRegion({left:0,top:0,width:1,height:1})).toBeUndefined();
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();mocks.bitmapClose.mockClear();
        mocks.recognize.mockImplementationOnce(function(this:any){expect(this.readMangaSourceRegion({left:0,top:0,width:200,height:200})).toHaveLength(160000);return Promise.resolve({results:[]});});
        await port.recognize('new page budget',f.options);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it('只读一次原ROI，proof绑定final whole/local/bubble refs，worker clone仍可消费且raw/numeric不改',async()=>{
        const f=install(),before=JSON.stringify([f.whole,f.number]),pixels=f.pixels.slice(),port=await createBrowserMangaOcr(),page=await port.recognize('word views',f.options);
        expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(f.reads()).toHaveLength(1);
        expect(page.wordBoundaryProofs).toHaveLength(1);const proof=page.wordBoundaryProofs![0];
        expect(proof.whole).toBe(page.results[0]);expect(proof.local).toBe(page.bubbles![0].results[0]);expect(proof.bubble).toBe(page.bubbles![0]);expect(proof.local).not.toBe(f.localRaw());expect(proof.preferred).toBe('whole');
        expect(page.numericEvidence).toEqual([f.number]);expect(JSON.stringify([f.whole,f.number])).toBe(before);expect(JSON.stringify(f.localRaw())).toBe(f.localSnapshot());expect(f.pixels).toEqual(pixels);
        const cloned=structuredClone(page);expect(cloned.wordBoundaryProofs![0].whole).toBe(cloned.results[0]);expect(cloned.wordBoundaryProofs![0].local).toBe(cloned.bubbles![0].results[0]);
        const regions=collectMangaRegions(cloned,'en',200,200,'image'),word=regions.find(r=>r.text==='AB CD')!;
        expect(word).toMatchObject({bbox:{x0:40,y0:55,x1:73,y1:73},fontSize:18});expect(getMangaViewWordBoundaryProvenance(word)?.[0].textView).toBe('whole');expect(JSON.stringify(regions)).not.toContain('word-boundary');
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
    it.each([['AB CD','AB CD'],[' AB CD ','AB CD'],['AB CD','ABCE']])('一致或不同字符%s/%s不读原ROI、不创建proof',async (whole,local)=>{
        const f=install(whole,local),port=await createBrowserMangaOcr(),page=await port.recognize('same',f.options);
        expect(page.wordBoundaryProofs).toBeUndefined();expect(f.reads()).toHaveLength(0);expect(mocks.canvases).toHaveLength(2);expect(mocks.recognize).toHaveBeenCalledTimes(2);await port.destroy();
    });
    it.each(['alpha','color'] as const)('原%s不确定仍保持local候选，不借已flatten的OCR像素冒认proof',async kind=>{
        const f=install();f.pixels.set(kind==='alpha'?[20,20,20,128]:[230,20,20,255],(60*200+43)*4);
        const port=await createBrowserMangaOcr(),page=await port.recognize('unknown',f.options);expect(f.reads()).toHaveLength(1);expect(page.wordBoundaryProofs).toBeUndefined();
        expect(collectMangaRegions(page,'en',200,200,'image').some(r=>r.text==='ABCD')).toBe(true);expect(mocks.retryRecognition).not.toHaveBeenCalled();await port.destroy();
    });
    it.each(['cancel','throw'] as const)('proof source read%s保留首因并释放原图/全部canvas，不返回半份page',async stage=>{
        const f=install(),controller=new AbortController(),failure=new Error('proof read failed'),factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{const c=factory('canvas'),context=mocks.contexts.at(-1);if(mocks.canvases.length===3){if(stage==='throw')context.getImageData.mockImplementation(()=>{throw failure;});else context.drawImage.mockImplementation(()=>controller.abort());}return c;});
        const port=await createBrowserMangaOcr(),operation=port.recognize('proof cancellation',{...f.options,signal:controller.signal});
        if(stage==='cancel')await expect(operation).rejects.toMatchObject({name:'AbortError'});else await expect(operation).rejects.toBe(failure);
        expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
    it('source reader已用完2MP后proof不能另开预算读图，仍返回两个已有raw视图',async()=>{
        const f=install();let proofs:any;
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){
            for(let i=0;i<50;i++)expect(this.readMangaSourceRegion({left:0,top:0,width:200,height:200})).toHaveLength(160000);
            const before=mocks.canvases.length,local={text:'ABCD',confidence:.99,box:{...f.box}};
            proofs=this.proveMangaWordBoundaries({results:[f.whole]},[{bbox:{x0:30,y0:40,x1:80,y1:90},results:[local]}],200,200);
            expect(mocks.canvases).toHaveLength(before);return Promise.resolve(response);
        }).mockResolvedValue({results:[]});
        const port=await createBrowserMangaOcr();await port.recognize('spent budget',f.options);
        expect(proofs).toEqual([]);expect(f.reads()).toHaveLength(0);expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.retryRecognition).not.toHaveBeenCalled();await port.destroy();
    });
    it.each(['attempts','whole','locals','bubbles','comparisons'] as const)('owner枚举%s上限失败关闭，普通一致行不消耗source read',async mode=>{
        const f=install(),local={text:'ABCD',confidence:.99,box:{...f.box}},same={...local},different={...local,text:'ABCE'},bubble={bbox:{x0:30,y0:40,x1:80,y1:90},results:[local]};let proofs:any;
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){
            const whole=mode==='whole'?[...Array(4096).fill(different),f.whole]:mode==='comparisons'?Array(4096).fill(same):mode==='attempts'?Array(4096).fill(f.whole):[f.whole];
            const bubbles=mode==='bubbles'?[...Array.from({length:256},()=>({...bubble,results:[]})),bubble]:[{...bubble,results:mode==='locals'?[...Array(4096).fill(different),local]:mode==='comparisons'?Array(5).fill(same):[local]}];
            proofs=this.proveMangaWordBoundaries({results:whole},bubbles,200,200);return Promise.resolve(response);
        }).mockResolvedValue({results:[]});
        const port=await createBrowserMangaOcr();await port.recognize('bounded',f.options);
        expect(proofs).toHaveLength(mode==='attempts'?64:0);expect(f.reads()).toHaveLength(mode==='attempts'?64:0);expect(mocks.recognize).toHaveBeenCalledTimes(2);expect(mocks.retryRecognition).not.toHaveBeenCalled();await port.destroy();
    });
    it('有限枚举先跳过65个一致pair，随后真实差异仍只读一次',async()=>{
        const f=install();let proofs:any;
        const equal=Array.from({length:65},(_,i)=>({text:'AA'+String.fromCharCode(65+Math.floor(i/26))+String.fromCharCode(65+i%26),confidence:.99,box:{...f.box}})),local={text:'ABCD',confidence:.99,box:{...f.box}};
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){proofs=this.proveMangaWordBoundaries({results:[...equal,f.whole]},[{bbox:{x0:30,y0:40,x1:80,y1:90},results:[...equal,local]}],200,200);return Promise.resolve(response);}).mockResolvedValue({results:[]});
        const port=await createBrowserMangaOcr();await port.recognize('prefilter',f.options);expect(proofs).toHaveLength(1);expect(f.reads()).toHaveLength(1);expect(mocks.retryRecognition).not.toHaveBeenCalled();await port.destroy();
    });
    it('过短或过长nonspace key在建index时拒绝，不消耗producer/read预算',async()=>{
        const f=install();let read:any;
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){read=vi.spyOn(this,'readMangaSourceRegion');const local={text:'ABCD',confidence:.99,box:{...f.box}},whole=[' A B ','X'.repeat(65)].map(text=>({...f.whole,text}));
            expect(this.proveMangaWordBoundaries({results:whole},[{bbox:{x0:30,y0:40,x1:80,y1:90},results:[local]}],200,200)).toEqual([]);return Promise.resolve(response);
        }).mockResolvedValue({results:[]});
        const port=await createBrowserMangaOcr();await port.recognize('index guards',f.options);expect(read).not.toHaveBeenCalled();await port.destroy();
    });
    it.each(['overlap','scale','wide-roi','tall-roi'] as const)('真实差异但%s几何不匹配时不先消耗64个proof/read名额',async mode=>{
        const f=install();let read:any;
        mocks.recognize.mockReset().mockImplementationOnce(function(this:any){read=vi.spyOn(this,'readMangaSourceRegion');const whole={...f.whole,box:{...f.box}},local={text:'ABCD',confidence:.99,box:{...f.box}};
            if(mode==='overlap')local.box.x=120;if(mode==='scale')local.box.height=9;
            if(mode==='wide-roi'){whole.box={x:20,y:20,width:508,height:20};local.box={x:23,y:20,width:508,height:20};}
            if(mode==='tall-roi'){whole.box={x:20,y:20,width:200,height:125};local.box={x:20,y:21,width:200,height:125};}
            expect(this.proveMangaWordBoundaries({results:[whole]},[{bbox:{x0:0,y0:0,x1:700,y1:220},results:[local]}],700,220)).toEqual([]);return Promise.resolve(response);
        }).mockResolvedValue({results:[]});
        const port=await createBrowserMangaOcr();await port.recognize('geometry guards',f.options);expect(read).not.toHaveBeenCalled();await port.destroy();
    });
});

describe('大气泡只输出布局归属',()=>{
    it.each([false,true])('单次像素扫描和page OCR，不创建大裁图；取消=%s时释放原有资源',async cancelled=>{
        const pixels=opaquePixels();for(let y=0;y<200;y++)for(let x=0;x<200;x++)if(((x-100)/70)**2+((y-100)/70)**2<=1)pixels.fill(255,(y*200+x)*4,(y*200+x)*4+4);
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{const c=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});return c;});
        const ownerPage={results:[response.results[0],
            {text:'右列',confidence:.99,box:{x:110,y:70,width:12,height:60}},
            {text:'左列',confidence:.99,box:{x:70,y:70,width:12,height:60}}]};
        const controller=new AbortController();mocks.recognize.mockImplementationOnce(async()=>{if(cancelled)controller.abort();return ownerPage;});
        const port=await createBrowserMangaOcr(),result=port.recognize('large ellipse',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal});
        if(cancelled)await expect(result).rejects.toMatchObject({name:'AbortError'});
        else {
            const page=await result;
            expect(page).toEqual({...ownerPage,bubbles:[],layoutBubbles:[{bbox:{x0:39,y0:66,x1:162,y1:135},members:[1,2]}]});
            expect(page.results[0]).toBe(ownerPage.results[0]);
            expect(page.layoutBubbles?.[0].members.map(index=>page.results[index])).toEqual([ownerPage.results[1],ownerPage.results[2]]);
        }
        expect(mocks.recognize).toHaveBeenCalledOnce();expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases).toHaveLength(1);
        expect(mocks.contexts[0].getImageData).toHaveBeenCalledOnce();expect(mocks.canvases[0]).toMatchObject({width:0,height:0});expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
});

describe('漫画原像素瓦片几何',()=>{
    it.each([[0,20],[-1,20],[NaN,20],[1.5,20],[8193,20],[4096,4097]])('拒绝无效或超像素预算的尺寸 %s × %s', (width,height)=>{
        expect(()=>planMangaOcrTiles(width,height)).toThrow('尺寸超出');
    });

    it('小图复用整图，双轴大图均匀覆盖原图且保持至少512像素重叠',()=>{
        expect(planMangaOcrTiles(1200,900)).toEqual([{x:0,y:0,width:1200,height:900}]);
        const tiles=planMangaOcrTiles(4096,4096);
        expect(tiles).toHaveLength(16);expect(tiles.at(-1)).toEqual({x:2560,y:2560,width:1536,height:1536});
        for(const axis of ['x','y'] as const){
            const starts=[...new Set(tiles.map(tile=>tile[axis]))];
            expect(starts[0]).toBe(0);
            for(let index=1;index<starts.length;index++)expect(starts[index]-starts[index-1]).toBeLessThanOrEqual(1024);
        }
        expect(planMangaOcrTiles(8192,2048)).toHaveLength(16);
        expect(planMangaOcrTiles(6000,2700)).toHaveLength(18);
        expect(planMangaOcrTiles(3585,4679)).toHaveLength(20);
    });

    it('只去重不同瓦片中的同一物理行，保留相邻行与同一瓦片的检测结果',()=>{
        const tile={x:0,y:0,width:100,height:100};
        const item=(text:string,x:number,y:number,confidence=.9)=>({text,confidence,box:{x,y,width:30,height:10}});
        expect(mergeMangaOcrTiles([
            {tile,results:[item('original',10,20),item('same tile',10,20),item('lower line',10,35)]},
            {tile:{...tile,x:5},results:[item('duplicate',5,20,.8),item('side line',55,20,.8)]},
        ],100,100).map(line=>line.text)).toEqual(['original','same tile','side line','lower line']);
        expect(mergeMangaOcrTiles([
            {tile,results:[item('small line',10,20)]},
            {tile,results:[{text:'large detector region',confidence:.99,box:{x:5,y:5,width:80,height:80}}]},
        ],100,100).map(line=>line.text)).toEqual(['large detector region','small line']);
    });

    it('边界完整行优先于高置信裁切片段，重复完整行按置信度及面积选择且不改变输入',()=>{
        const whole={text:'whole',confidence:.8,box:{x:10,y:10,width:80,height:15}};
        const source=[
            {tile:{x:0,y:0,width:60,height:100},results:[{text:'cut',confidence:.99,box:{x:10,y:10,width:50,height:15}}]},
            {tile:{x:0,y:0,width:100,height:100},results:[whole]},
            {tile:{x:0,y:0,width:100,height:100},results:[{...whole,text:'narrow',box:{...whole.box,width:70}}]},
        ];
        const snapshot=JSON.stringify(source);
        expect(mergeMangaOcrTiles(source,100,100)).toEqual([whole]);expect(JSON.stringify(source)).toBe(snapshot);
    });

    it('完整长框不能吞掉另一瓦片中的独立短标签，双边裁切也不以单向覆盖推断同一行',()=>{
        const title={text:'LEFT TITLE',confidence:.99,box:{x:100,y:100,width:500,height:20}};
        const label={text:'RIGHT',confidence:.98,box:{x:270,y:100,width:60,height:20}};
        expect(mergeMangaOcrTiles([
            {tile:{x:0,y:0,width:800,height:400},results:[title]},
            {tile:{x:80,y:0,width:800,height:400},results:[label]},
        ],1000,400)).toEqual([title,{...label,box:{...label.box,x:350}}]);
        expect(mergeMangaOcrTiles([
            {tile:{x:0,y:0,width:600,height:400},results:[{text:'left fragment',confidence:.9,box:{x:200,y:100,width:400,height:20}}]},
            {tile:{x:500,y:0,width:500,height:400},results:[{text:'right fragment',confidence:.8,box:{x:0,y:100,width:100,height:20}}]},
        ],1000,400).map(item=>item.text)).toEqual(['left fragment','right fragment']);
    });

    it('真实3600px长图检测框退边3px，仍以完整框投影的可见切片识别裁切行并只保留一份',()=>{
        // browser-long-raw/tile-raw-evidence.json：原模型无参数替换，第二瓦片底2224截断了这行。
        const tiles=planMangaOcrTiles(960,3600);
        expect(tiles.map(tile=>tile.y)).toEqual([0,688,1376,2064]);
        const complete={text:'Read beyond the next panel.',confidence:0.9920982276951825,box:{x:130,y:138,width:517,height:34}};
        const result=mergeMangaOcrTiles([
            {tile:tiles[1],results:[{text:'Read bevond the next panel',confidence:0.9901552888063284,box:{x:130,y:1512,width:518,height:21}}]},
            {tile:tiles[2],results:[{text:'Read beyond the next panel.',confidence:0.991522541752568,box:{x:130,y:826,width:516,height:34}}]},
            {tile:tiles[3],results:[complete]},
        ],960,3600);
        expect(result).toEqual([{...complete,box:{...complete.box,y:2202}}]);
    });

    it('完整行投影只能消除吻合的裁边切片，不能吞同窗口旁边的独立短标签或厚框',()=>{
        const full={text:'whole horizontal row',confidence:.9,box:{x:100,y:90,width:500,height:40}};
        const tile={x:0,y:0,width:800,height:115};
        const fragment={text:'partial row',confidence:.99,box:{x:100,y:90,width:500,height:20}};
        const label={text:'RIGHT',confidence:.99,box:{x:350,y:90,width:60,height:20}};
        const unrelated={text:'separate',confidence:.99,box:{x:650,y:90,width:60,height:20}};
        expect(mergeMangaOcrTiles([
            {tile,results:[fragment,label,unrelated]},
            {tile:{x:0,y:0,width:800,height:200},results:[full]},
        ],800,200).map(item=>item.text)).toEqual(['whole horizontal row','RIGHT','separate']);
    });

    it('另一候选完全不在本瓦片的水平或垂直可见范围时，保留各自独立文字',()=>{
        const item={text:'independent',confidence:.9,box:{x:10,y:10,width:30,height:10}};
        expect(mergeMangaOcrTiles([
            {tile:{x:0,y:0,width:100,height:100},results:[item]},
            {tile:{x:200,y:0,width:100,height:100},results:[item]},
            {tile:{x:0,y:200,width:100,height:100},results:[item]},
        ],300,300).map(line=>line.box)).toEqual([
            {x:10,y:10,width:30,height:10},{x:210,y:10,width:30,height:10},{x:10,y:210,width:30,height:10},
        ]);
    });

    it('上下左右内部裁边均可被完整结果替代，原图边缘不被误判为裁切',()=>{
        const item={text:'full',confidence:.8,box:{x:45,y:45,width:10,height:10}};
        expect(mergeMangaOcrTiles([
            {tile:{x:0,y:0,width:100,height:100},results:[item]},
            {tile:{x:45,y:0,width:55,height:100},results:[{text:'left',confidence:.99,box:{x:0,y:45,width:10,height:10}}]},
            {tile:{x:0,y:45,width:100,height:55},results:[{text:'top',confidence:.99,box:{x:45,y:0,width:10,height:10}}]},
            {tile:{x:0,y:0,width:55,height:100},results:[{text:'right',confidence:.99,box:{x:45,y:45,width:10,height:10}}]},
            {tile:{x:0,y:0,width:100,height:55},results:[{text:'bottom',confidence:.99,box:{x:45,y:45,width:10,height:10}}]},
        ],100,100)).toEqual([item]);
        const edge={text:'edge',confidence:.99,box:{x:0,y:0,width:100,height:100}};
        expect(mergeMangaOcrTiles([{tile:{x:0,y:0,width:100,height:100},results:[edge]}],100,100)).toEqual([edge]);
    });

    it('忽略非法或图外结果，夹紧映回坐标并按 y/x 排序',()=>{
        const item=(x:number,y:number,width=10,height=10,confidence=.9)=>({text:'ok',confidence,box:{x,y,width,height}});
        const lines=mergeMangaOcrTiles([{tile:{x:0,y:0,width:100,height:100},results:[
            item(NaN,0),item(0,0,0),item(0,0,10,-1),item(0,0,10,10,NaN),item(101,20),item(20,101),
            item(50,50),item(-2,-3),item(90,90,15,15),item(20,50),
        ]}],100,100);
        expect(lines.map(line=>line.box)).toEqual([
            {x:0,y:0,width:8,height:7},{x:20,y:50,width:10,height:10},{x:50,y:50,width:10,height:10},{x:90,y:90,width:10,height:10},
        ]);
        expect(mergeMangaOcrTiles([],100,100)).toEqual([]);
    });
});

describe('漫画本地神经 OCR 会话',()=>{
    const slanted=(confidence=.971)=>({text:'original line',confidence,box:{x:10,y:10,width:160,height:60}});
    const prepareDeskew=()=>{
        mocks.planDeskew.mockReturnValue({radians:Math.PI/18,width:170,height:90});
        mocks.trimDeskew.mockReturnValue({x:5,y:20,width:150,height:20});
    };
    it('按像素旋转并裁白边，单框高置信复识别仅替换原框文字，释放全部自有画布',async()=>{
        prepareDeskew();const original=slanted(),strong={...slanted(.995),text:'already confident'},page={results:[original,strong]},snapshot=JSON.stringify(page);
        mocks.recognize.mockResolvedValueOnce(page);
        mocks.retryRecognition.mockImplementationOnce(async(canvas,boxes,_dict,strategy,options)=>{
            expect(canvas).toBe(mocks.canvases[3]);expect(canvas).toMatchObject({width:150,height:20});
            expect(boxes).toEqual([{x:0,y:0,width:150,height:20}]);expect(strategy).toBe('per-box');expect(options.recBatchSize).toBe(1);
            return [{text:'actual improved model output',confidence:.995,box:boxes[0]}];
        });
        const port=await createBrowserMangaOcr(),result=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(result.results).toEqual([{...original,text:'actual improved model output',confidence:.995},strong]);
        expect(result.results[0].box).toBe(original.box);expect(JSON.stringify(page)).toBe(snapshot);
        expect(mocks.recognize).toHaveBeenCalledOnce();expect(mocks.planDeskew).toHaveBeenCalledOnce();
        expect(mocks.contexts[2].rotate).toHaveBeenCalledWith(-Math.PI/18);
        expect(mocks.contexts[3].drawImage).toHaveBeenCalledWith(mocks.canvases[2],5,20,150,20,0,0,150,20);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each([{x:1},{y:1},{width:151},{height:21},{confidence:.989},{confidence:.994},{}])('错误坐标、低置信、增益不足或空输出均保留原文：%j',async change=>{
        prepareDeskew();const source=slanted(.985);mocks.recognize.mockResolvedValueOnce({results:[source]});
        const {confidence=.999,...geometry}=change as Partial<{x:number;y:number;width:number;height:number;confidence:number}>;
        mocks.retryRecognition.mockResolvedValueOnce(Object.keys(change).length?[{text:'candidate',confidence,box:{x:0,y:0,width:150,height:20,...geometry}}]:[]);
        const port=await createBrowserMangaOcr();
        expect((await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);await port.destroy();
    });
    it('等于.99且增益.01可替换，几何或裁白边不可靠时没有额外原生调用',async()=>{
        prepareDeskew();const source=slanted(.98);mocks.recognize.mockResolvedValue({results:[source]});
        mocks.planDeskew.mockReturnValueOnce(undefined);mocks.trimDeskew.mockReturnValueOnce(undefined);
        const port=await createBrowserMangaOcr();
        expect((await port.recognize('no angle',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);
        expect((await port.recognize('no useful trim',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);
        expect(mocks.retryRecognition).not.toHaveBeenCalled();
        mocks.retryRecognition.mockResolvedValueOnce([{text:'confident',confidence:.99,box:{x:0,y:0,width:150,height:20}}]);
        expect((await port.recognize('accepted boundary',{flatten:true,noCache:true,strategy:'per-box'})).results[0].text).toBe('confident');
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it('非法、图外、短小和竖排框不分配deskew画布',async()=>{
        const changes=[{x:NaN},{x:-1},{y:-1},{x:100},{y:180},{width:119},{height:19},{width:120,height:60}];
        mocks.recognize.mockResolvedValueOnce({results:changes.map((change,i)=>({...slanted(.91+i/1000),box:{...slanted().box,...change}}))});
        const port=await createBrowserMangaOcr();await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.canvases).toHaveLength(1);expect(mocks.planDeskew).not.toHaveBeenCalled();expect(mocks.retryRecognition).not.toHaveBeenCalled();await port.destroy();
    });
    it('竖列与斜行共享整页四框预算，瓦片之间不重置；新页重新获得预算',async()=>{
        prepareDeskew();const columns=Array.from({length:3},(_,i)=>({text:'列 '+i,confidence:.7,box:{x:20+i*30,y:10,width:15,height:80}}));
        const first={results:[...columns,slanted()]},second={results:[slanted()]};
        mocks.recognize.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const source={naturalWidth:2400,naturalHeight:200} as HTMLImageElement,port=await createBrowserMangaOcr();
        for(let i=0;i<2;i++)await port.recognize('wide page',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(mocks.retryRecognition.mock.calls.map(c=>c[1].length)).toEqual([3,1,3,1]);
        expect(mocks.planDeskew).toHaveBeenCalledTimes(2);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each(['no-angle','rotation-budget'])('候选源框及旋转结果读取共受两百万像素约束：%s',async stage=>{
        if(stage==='rotation-budget')mocks.planDeskew.mockReturnValue({radians:.1,width:1536,height:1000});
        mocks.recognize.mockResolvedValue({results:[{...slanted(),box:{x:0,y:0,width:1400,height:500}}]});
        const source={naturalWidth:2400,naturalHeight:1800} as HTMLImageElement,port=await createBrowserMangaOcr();
        await port.recognize('large page',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(mocks.recognize).toHaveBeenCalledTimes(4);expect(mocks.planDeskew).toHaveBeenCalledTimes(2);
        expect(mocks.trimDeskew).not.toHaveBeenCalled();
        expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each(['before-pixels','before-native','during-native'])('斜行取消不提交迟到改字，原生调用有界且画布清空：%s',async stage=>{
        prepareDeskew();const controller=new AbortController(),source=slanted();
        mocks.recognize.mockImplementationOnce(async()=>{if(stage==='before-pixels')controller.abort();return {results:[source]};});
        if(stage==='before-native')mocks.trimDeskew.mockImplementationOnce(()=>{controller.abort();return {x:5,y:20,width:150,height:20};});
        mocks.retryRecognition.mockImplementationOnce(async()=>{controller.abort();return [{text:'late',confidence:.999,box:{x:0,y:0,width:150,height:20}}];});
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(mocks.retryRecognition).toHaveBeenCalledTimes(stage==='during-native'?1:0);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
    it.each([1,2,3])('斜行第%s块画布不可用时报告错误并清理全部临时像素',async missing=>{
        prepareDeskew();mocks.recognize.mockResolvedValueOnce({results:[slanted()]});
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{const canvas=factory('canvas') as HTMLCanvasElement;if(mocks.canvases.length===missing+1)vi.mocked(canvas.getContext).mockReturnValue(null);return canvas;});
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('浏览器不支持');
        expect(mocks.retryRecognition).not.toHaveBeenCalled();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    it.each(['throw','sdk-swallowed'])('斜行原生失败保持首因，不能伪装为没有改进：%s',async stage=>{
        prepareDeskew();const failure=new Error('deskew inference failed'),session={run:vi.fn().mockRejectedValue(failure),release:vi.fn()};
        mocks.sessions=[undefined,session];mocks.recognize.mockResolvedValueOnce({results:[slanted(),{...slanted(),text:'another row'}]});
        mocks.retryRecognition.mockImplementationOnce(async()=>{if(stage==='throw')throw failure;try{await session.run(recognitionFeeds());}catch{}return [];});
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toBe(failure);
        expect(mocks.retryRecognition).toHaveBeenCalledOnce();
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });
    it('只复识别低置信竖列的已有框，优先最弱四列，保持原顺序与坐标且不增加框',async()=>{
        const vertical=(text:string,confidence:number,x:number)=>({text:'列'+text,confidence,box:{x,y:20,width:12,height:60}});
        const source=[vertical('strong column',.92,10),
            {text:'horizontal',confidence:.7,box:{x:20,y:100,width:100,height:20}},
            {text:'aspect boundary',confidence:.7,box:{x:150,y:100,width:20,height:36}},
            vertical('fourth priority',.82,40),vertical('first priority',.65,65),
            vertical('fifth priority',.88,90),vertical('second priority',.7,115),vertical('third priority',.8,140)];
        const page={results:source},snapshot=JSON.stringify(page),dictionary=['未','来','の','駅'];
        mocks.recognize.mockResolvedValueOnce(page);
        mocks.initialize.mockImplementationOnce(async()=>{mocks.options.mock.calls[0][0].recognition.charactersDictionary=dictionary;});
        mocks.retryRecognition.mockImplementationOnce(async(canvas,boxes,dict,strategy,options)=>{
            expect(canvas).toBe(mocks.canvases[0]);expect(canvas).toMatchObject({width:200,height:200});
            expect(boxes).toEqual([source[4].box,source[6].box,source[7].box,source[3].box]);
            expect(dict).toBe(dictionary);expect(strategy).toBe('per-box');
            expect(options).toEqual({flatten:true,noCache:true,strategy:'per-box',recBatchSize:1});
            return [...boxes.map((box:typeof source[0]['box'])=>({text:'improved '+box.x,confidence:.98,box:{...box}})),
                {text:'new artwork false positive',confidence:1,box:{x:3,y:3,width:20,height:60}}];
        });
        const port=await createBrowserMangaOcr(),result=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(result.results.map(item=>item.text)).toEqual(['列strong column','horizontal','aspect boundary',
            'improved 40','improved 65','列fifth priority','improved 115','improved 140']);
        expect(result.results.map(item=>item.box)).toEqual(source.map(item=>item.box));
        expect(JSON.stringify(page)).toBe(snapshot);expect(mocks.retryRecognition).toHaveBeenCalledOnce();
        expect(mocks.recognize).toHaveBeenCalledOnce();await port.destroy();
    });

    it('复识别必须四个坐标完全相等且置信度至少提升0.05，空结果和不足增益保留原文',async()=>{
        const source={text:'未来の职',confidence:.75,box:{x:30,y:20,width:20,height:100}},snapshot=JSON.stringify(source);
        const port=await createBrowserMangaOcr();
        for(const change of [{x:31},{y:21},{width:21},{height:101}]){
            mocks.recognize.mockResolvedValueOnce({results:[source]});
            mocks.retryRecognition.mockResolvedValueOnce([{text:'wrong geometry',confidence:.99,box:{...source.box,...change}}]);
            expect((await port.recognize('geometry',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);
        }
        for(const confidence of [.74,.75,.799]){
            mocks.recognize.mockResolvedValueOnce({results:[source]});
            mocks.retryRecognition.mockResolvedValueOnce([{text:'insufficient improvement',confidence,box:{...source.box}}]);
            expect((await port.recognize('confidence',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);
        }
        mocks.recognize.mockResolvedValueOnce({results:[source]});mocks.retryRecognition.mockResolvedValueOnce([]);
        expect((await port.recognize('empty retry',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([source]);
        mocks.recognize.mockResolvedValueOnce({results:[source]});
        mocks.retryRecognition.mockResolvedValueOnce([{text:'未来の駅',confidence:.8,box:{...source.box}}]);
        expect((await port.recognize('accepted boundary',{flatten:true,noCache:true,strategy:'per-box'})).results)
            .toEqual([{text:'未来の駅',confidence:.8,box:source.box}]);
        expect(JSON.stringify(source)).toBe(snapshot);await port.destroy();
    });

    it('瓦片和局部气泡共用每页四框复识别预算，新的一页重新获得预算',async()=>{
        const pagePixels=new Uint8ClampedArray(2400*200*4);for(let index=3;index<pagePixels.length;index+=4)pagePixels[index]=255;
        for(let y=40;y<90;y++)for(let x=30;x<80;x++)pagePixels.fill(255,(y*2400+x)*4,(y*2400+x)*4+4);
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{
            const canvas=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:pagePixels});return canvas;
        });
        const columns=(count:number,prefix:string)=>Array.from({length:count},(_,index)=>({text:'列'+prefix+index,confidence:.7+index/100,
            box:{x:100+index*30,y:20,width:15,height:100}}));
        const first=columns(3,'tile one '),second=columns(3,'tile two '),bubble=columns(2,'bubble ');
        mocks.recognize.mockResolvedValueOnce({results:first}).mockResolvedValueOnce({results:second}).mockResolvedValueOnce({results:bubble});
        const source={naturalWidth:2400,naturalHeight:200,src:'long source'} as HTMLImageElement,port=await createBrowserMangaOcr();
        await port.recognize(source.src,{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(mocks.recognize).toHaveBeenCalledTimes(3);
        expect(mocks.retryRecognition.mock.calls.map(call=>call[1])).toEqual([first.map(item=>item.box),[second[0].box]]);
        expect(mocks.retryRecognition.mock.calls.flatMap(call=>call[1])).toHaveLength(4);
        mocks.recognize.mockResolvedValueOnce({results:first}).mockResolvedValueOnce({results:second}).mockResolvedValueOnce({results:bubble});
        await port.recognize(source.src,{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(mocks.retryRecognition.mock.calls.map(call=>call[1].length)).toEqual([3,1,3,1]);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });

    it.each(['before-retry','during-retry'])('竖列复识别取消不提交迟到改字且释放画布与位图：%s',async stage=>{
        const controller=new AbortController(),source={text:'元の列',confidence:.75,box:{x:20,y:20,width:20,height:100}};
        mocks.recognize.mockImplementationOnce(async()=>{if(stage==='before-retry')controller.abort();return {results:[source]};});
        mocks.retryRecognition.mockImplementationOnce(async()=>{controller.abort();return [{...source,text:'late correction',confidence:.99}];});
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(mocks.retryRecognition).toHaveBeenCalledTimes(stage==='before-retry'?0:1);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it.each(['thrown','sdk-swallowed'])('竖列复识别错误保留首因，不能把推理失败当作没有修正：%s',async stage=>{
        const original={text:'元の列',confidence:.75,box:{x:20,y:20,width:20,height:100}},failure=new Error('column retry inference failed');
        const session={run:vi.fn().mockRejectedValue(failure),release:vi.fn()};
        mocks.sessions=[undefined,session];mocks.recognize.mockResolvedValueOnce({results:[original]});
        mocks.retryRecognition.mockImplementationOnce(async()=>{
            if(stage==='thrown')throw failure;
            try{await session.run(recognitionFeeds());}catch{}return [];
        });
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toBe(failure);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);expect(mocks.bitmapClose).toHaveBeenCalledOnce();
        mocks.recognize.mockResolvedValueOnce({results:[original]});mocks.retryRecognition.mockResolvedValueOnce([]);
        expect((await port.recognize('next page',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual([original]);
        await port.destroy();
    });

    it.each(['between-runs','pacer-wait'])('CPU 四个弱框在首个复识别完成后取消，后续框不进入底层推理：%s',async stage=>{
        const controller=new AbortController(),nativeRun=vi.fn().mockResolvedValue({output:'first column'});
        const session={run:nativeRun,release:vi.fn()},columns=Array.from({length:4},(_,index)=>({
            text:'元の列 '+index,confidence:.7+index/100,box:{x:20+index*35,y:20,width:20,height:100}}));
        mocks.sessions=[undefined,session];mocks.recognize.mockResolvedValueOnce({results:columns});
        if(stage==='pacer-wait')mocks.pace.mockImplementationOnce(operation=>operation())
            .mockImplementationOnce(operation=>{controller.abort();return operation();});
        mocks.retryRecognition.mockImplementationOnce(async(_canvas,boxes)=>{
            // 复现 SDK 的单项批次与吞错行为；每个弱框都必须经过真实会话包装。
            try {
                for(let index=0;index<boxes.length;index++){
                    await session.run(recognitionFeeds());
                    if(stage==='between-runs'&&nativeRun.mock.calls.length===1)controller.abort();
                }
            }catch{}return [];
        });
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal}))
            .rejects.toMatchObject({name:'AbortError'});
        expect(mocks.retryRecognition.mock.calls[0][1]).toEqual(columns.map(item=>item.box));
        expect(nativeRun).toHaveBeenCalledOnce();expect(nativeRun).toHaveBeenCalledWith(recognitionFeeds());
        expect(mocks.pace).toHaveBeenCalledTimes(2);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it('长图使用原像素瓦片识别，跨边界完整行取代裁切片段并保留整图坐标',async()=>{
        const source={naturalWidth:2400,naturalHeight:200,src:'long-image'} as HTMLImageElement;
        mocks.recognize.mockResolvedValueOnce({results:[{text:'truncated',confidence:.99,box:{x:1450,y:40,width:86,height:24}}]})
            .mockResolvedValueOnce({results:[{text:'The complete sentence',confidence:.9,box:{x:576,y:40,width:200,height:24}},
                {text:'Separate line',confidence:.95,box:{x:100,y:90,width:150,height:24}}]});
        const port=await createBrowserMangaOcr();
        const result=await port.recognize('long-image',{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(result.results).toEqual([
            {text:'The complete sentence',confidence:.9,box:{x:1440,y:40,width:200,height:24}},
            {text:'Separate line',confidence:.95,box:{x:964,y:90,width:150,height:24}},
        ]);
        expect(mocks.options.mock.calls[0][0].recognition.maxCropSourceSideLength).toBe(8192);
        expect(mocks.contexts[1].drawImage.mock.calls).toEqual([
            [mocks.canvases[0],0,0,1536,200,0,0,1536,200],
            [mocks.canvases[0],864,0,1536,200,0,0,1536,200],
        ]);
        expect(mocks.recognize).toHaveBeenCalledTimes(2);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(source.src).toBe('long-image');expect(mocks.bitmapClose).not.toHaveBeenCalled();await port.destroy();
    });

    it.each(['abort','inference','canvas'])('瓦片识别中断后不继续处理并释放全部自有画布与位图：%s',async failureStage=>{
        vi.mocked(createImageBitmap).mockResolvedValueOnce({width:200,height:3000,close:mocks.bitmapClose} as any);
        const controller=new AbortController(),failure=new Error('tile failed');
        if(failureStage==='abort')mocks.recognize.mockImplementationOnce(async()=>{controller.abort();return response;});
        if(failureStage==='inference')mocks.recognize.mockRejectedValueOnce(failure);
        if(failureStage==='canvas'){
            const original=vi.mocked(document.createElement).getMockImplementation()!;
            vi.mocked(document.createElement).mockImplementationOnce(()=>original('canvas'))
                .mockReturnValueOnce({width:0,height:0,getContext:()=>null} as any);
        }
        const port=await createBrowserMangaOcr();
        const pending=port.recognize('long-image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal});
        if(failureStage==='abort')await expect(pending).rejects.toMatchObject({name:'AbortError'});
        else if(failureStage==='inference')await expect(pending).rejects.toBe(failure);
        else await expect(pending).rejects.toThrow('浏览器不支持');
        expect(mocks.recognize).toHaveBeenCalledTimes(failureStage==='canvas'?0:1);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it('Worker 在像素分配前拒绝超预算图并释放解码位图',async()=>{
        vi.mocked(createImageBitmap).mockResolvedValueOnce({width:8193,height:200,close:mocks.bitmapClose} as any);
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('oversized',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('尺寸超出');
        expect(mocks.contexts[0].drawImage).not.toHaveBeenCalled();expect(mocks.recognize).not.toHaveBeenCalled();
        expect(mocks.canvases[0]).toMatchObject({width:0,height:0});expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it.each([
        'data:image/svg+xml;base64,PHN2Zy8+',
        'data:IMAGE/SVG+XML;base64,PHN2Zy8+',
        'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    ])('默认 Worker 将已解码 SVG 栅格化为 PNG 后识别，保留尺寸与借用图片：%s',async image=>{
        const controller=new AbortController(),progress=vi.fn(),close=vi.fn();
        const source={naturalWidth:460,naturalHeight:250,width:230,height:125,src:image,close} as unknown as HTMLImageElement;
        mocks.encode.mockImplementationOnce(async(canvas,signal)=>{
            expect(canvas).toMatchObject({width:460,height:250});expect(signal).toBe(controller.signal);
            return 'data:image/png;base64,rasterized';
        });
        expect(await mangaOcrRuntime.recognize(image,'en',460,250,controller.signal,progress,source)).toHaveLength(1);
        expect(mocks.encode).toHaveBeenCalledOnce();expect(mocks.encode.mock.calls[0][0]).toBe(mocks.canvases[0]);
        expect(mocks.contexts[0].drawImage).toHaveBeenCalledWith(source,0,0);
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'data:image/png;base64,rasterized',mangaParagraphGapEvidence:true},controller.signal,progress);
        expect(mocks.canvases[0]).toMatchObject({width:0,height:0});
        expect(source).toMatchObject({naturalWidth:460,naturalHeight:250,width:230,height:125,src:image});expect(close).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();expect(mocks.bitmapClose).not.toHaveBeenCalled();
    });

    it.each(['data:image/png;base64,png','data:image/jpeg;base64,jpeg','data:image/webp;base64,webp'])('默认 Worker 直接转发位图，不重复编码：%s',async image=>{
        const controller=new AbortController(),progress=vi.fn();
        const source={naturalWidth:200,naturalHeight:200,src:image} as HTMLImageElement;
        expect(await mangaOcrRuntime.recognize(image,'en',200,200,controller.signal,progress,source)).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image,mangaParagraphGapEvidence:true},controller.signal,progress);
        expect(mocks.encode).not.toHaveBeenCalled();expect(document.createElement).not.toHaveBeenCalled();
        expect(source.src).toBe(image);
    });

    it('普通图片与漫画分别请求布局侧车，不把图片检测帧混进漫画OCR',async()=>{
        const image='data:image/png;base64,image-profile',controller=new AbortController(),progress=vi.fn();
        expect(await mangaOcrRuntime.recognize(image,'en',200,200,controller.signal,progress,undefined,'image')).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenLastCalledWith({type:'recognize',image,imageDetectionEvidence:true},controller.signal,progress);
        expect(mocks.encode).not.toHaveBeenCalled();expect(document.createElement).not.toHaveBeenCalled();
        expect(await mangaOcrRuntime.recognize('default manga','en',200,200)).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenLastCalledWith({type:'recognize',image:'default manga',mangaParagraphGapEvidence:true},undefined,undefined);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
    });

    it.each(['context','drawing','encoding'])('默认 Worker 的 SVG 栅格化失败不发送推理，释放画布并保留原错误和图片：%s',async failureStage=>{
        const image='data:image/svg+xml;base64,PHN2Zy8+';
        const source={naturalWidth:460,naturalHeight:250,src:image} as HTMLImageElement;
        const failure=new Error('SVG '+failureStage+' failed');
        const canvasFactory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementationOnce(()=>{
            const canvas=canvasFactory('canvas');
            if(failureStage==='context') vi.mocked((canvas as HTMLCanvasElement).getContext).mockReturnValue(null);
            if(failureStage==='drawing') mocks.contexts.at(-1).drawImage.mockImplementationOnce(()=>{throw failure;});
            return canvas;
        });
        if(failureStage==='encoding') mocks.encode.mockRejectedValueOnce(failure);
        const pending=mangaOcrRuntime.recognize(image,'en',460,250,undefined,undefined,source);
        if(failureStage==='context') await expect(pending).rejects.toThrow('浏览器不支持');
        else await expect(pending).rejects.toBe(failure);
        expect(mocks.workerRequest).not.toHaveBeenCalled();expect(mocks.canvases[0]).toMatchObject({width:0,height:0});
        expect(mocks.encode).toHaveBeenCalledTimes(failureStage==='encoding'?1:0);
        expect(source.src).toBe(image);expect(mocks.bitmapClose).not.toHaveBeenCalled();
    });

    it('默认 Worker 在 SVG 编码期间取消，丢弃迟到 PNG 并释放画布，暖端口仍可复用',async()=>{
        const image='data:image/svg+xml;base64,PHN2Zy8+',controller=new AbortController(),pending=deferred<string>();
        const source={naturalWidth:460,naturalHeight:250,src:image} as HTMLImageElement;
        mocks.encode.mockReturnValueOnce(pending.promise);
        const recognition=mangaOcrRuntime.recognize(image,'en',460,250,controller.signal,undefined,source);
        await tick();expect(mocks.encode).toHaveBeenCalledWith(mocks.canvases[0],controller.signal);
        expect(mocks.workerRequest).not.toHaveBeenCalled();
        const cancelled=expect(recognition).rejects.toMatchObject({name:'AbortError'});
        controller.abort();await cancelled;
        pending.resolve('data:image/png;base64,late');await tick();
        expect(mocks.workerRequest).not.toHaveBeenCalled();expect(mocks.canvases[0]).toMatchObject({width:0,height:0});
        expect(mocks.workerRelease).not.toHaveBeenCalled();expect(source.src).toBe(image);
        expect(await mangaOcrRuntime.recognize('data:image/png;base64,next','en',200,200)).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'data:image/png;base64,next',mangaParagraphGapEvidence:true},undefined,undefined);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
    });

    it('默认 Worker 在 SVG 编码报告取消时释放画布，保留调用方图片且不转发推理',async()=>{
        const image='data:image/svg+xml;base64,PHN2Zy8+',controller=new AbortController();
        const source={naturalWidth:460,naturalHeight:250,src:image} as HTMLImageElement;
        mocks.encode.mockImplementationOnce(async()=>{controller.abort();throw new DOMException('cancelled','AbortError');});
        await expect(mangaOcrRuntime.recognize(image,'en',460,250,controller.signal,undefined,source)).rejects.toMatchObject({name:'AbortError'});
        await tick();expect(mocks.workerRequest).not.toHaveBeenCalled();expect(mocks.workerRelease).not.toHaveBeenCalled();
        expect(mocks.canvases[0]).toMatchObject({width:0,height:0});expect(source.src).toBe(image);
    });

    it('默认 Worker 代理转发图片、取消信号与阶段，复用端口并在空闲后释放',async()=>{
        const controller=new AbortController(),progress=vi.fn();
        mocks.workerPrepare.mockImplementationOnce(async(kind,signal,notify)=>{
            expect(kind).toBe('ocr');expect(signal).toBe(controller.signal);
            notify('preparing',35);notify('initializing');
        });
        mocks.workerRequest.mockImplementationOnce(async(_message,_signal,notify)=>{notify('recognizing',72);return response;});
        expect(await mangaOcrRuntime.recognize('first','en',200,200,controller.signal,progress)).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'first',mangaParagraphGapEvidence:true},controller.signal,progress);
        expect(progress.mock.calls).toEqual([['preparing',0],['preparing',35],['initializing'],['recognizing'],['recognizing',72]]);
        await mangaOcrRuntime.recognize('second','en',200,200);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
        expect(mocks.workerRequest).toHaveBeenLastCalledWith({type:'recognize',image:'second',mangaParagraphGapEvidence:true},undefined,undefined);
        expect(mocks.assets).not.toHaveBeenCalled();expect(mocks.initialize).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(179999);expect(mocks.workerRelease).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);expect(mocks.workerRelease).toHaveBeenCalledWith('ocr');
        await mangaOcrRuntime.recognize('third','en',200,200);expect(mocks.workerPrepare).toHaveBeenCalledTimes(2);
        await mangaOcrRuntime.dispose();expect(mocks.workerRelease.mock.calls).toEqual([['ocr'],['ocr']]);
    });

    it('默认 Worker 准备或识别失败后可重新创建，释放失败保留原推理错误',async()=>{
        mocks.workerPrepare.mockRejectedValueOnce(new Error('worker prepare failed'));
        await expect(mangaOcrRuntime.recognize('download','en',200,200)).rejects.toThrow('worker prepare failed');
        expect(mocks.workerRequest).not.toHaveBeenCalled();expect(mocks.workerRelease).not.toHaveBeenCalled();
        mocks.workerRequest.mockRejectedValueOnce(new Error('worker inference failed'));
        mocks.workerRelease.mockRejectedValueOnce(new Error('worker release failed'));
        await expect(mangaOcrRuntime.recognize('failed','en',200,200)).rejects.toThrow('worker inference failed');
        expect(mocks.workerRelease).toHaveBeenCalledWith('ocr');
        expect(await mangaOcrRuntime.recognize('retry','en',200,200)).toHaveLength(1);
        expect(mocks.workerPrepare).toHaveBeenCalledTimes(3);
        await removeMangaModels();
        expect(mocks.workerRelease).toHaveBeenCalledTimes(2);expect(mocks.remove).toHaveBeenCalledOnce();
    });

    it('默认 Worker 排队取消不转发新请求，运行中取消丢弃迟到结果并保留暖模型端口',async()=>{
        const pending=deferred<typeof response>(),controller=new AbortController(),queuedController=new AbortController();
        mocks.workerRequest.mockReturnValueOnce(pending.promise);
        const first=mangaOcrRuntime.recognize('active','en',200,200,controller.signal);
        await tick();expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'active',mangaParagraphGapEvidence:true},controller.signal,undefined);
        const queued=mangaOcrRuntime.recognize('queued','en',200,200,queuedController.signal);
        const queuedCancelled=expect(queued).rejects.toMatchObject({name:'AbortError'});
        queuedController.abort();await queuedCancelled;expect(mocks.workerRequest).toHaveBeenCalledOnce();
        const cancelled=expect(first).rejects.toMatchObject({name:'AbortError'});
        controller.abort();await cancelled;expect(mocks.workerRelease).not.toHaveBeenCalled();
        pending.resolve(response);await tick();
        expect(mocks.workerRelease).not.toHaveBeenCalled();expect(mocks.workerRequest).toHaveBeenCalledOnce();
        expect(await mangaOcrRuntime.recognize('retry','en',200,200)).toHaveLength(1);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
        await mangaOcrRuntime.dispose();expect(mocks.workerRelease).toHaveBeenCalledWith('ocr');
    });

    it('Worker 正常取消错误不释放暖端口，页面销毁与模型删除硬清理共享 Worker',async()=>{
        const controller=new AbortController();
        mocks.workerRequest.mockImplementationOnce(async()=>{controller.abort();throw new DOMException('cancelled','AbortError');});
        await expect(mangaOcrRuntime.recognize('old','en',200,200,controller.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(mocks.workerRelease).not.toHaveBeenCalled();
        expect(await mangaOcrRuntime.recognize('next','en',200,200)).toHaveLength(1);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
        disposeMangaModels();expect(mocks.workerDispose).toHaveBeenCalledOnce();
        await tick();await removeMangaModels();
        expect(mocks.workerDispose).toHaveBeenCalledTimes(2);
        expect(mocks.remove).toHaveBeenCalledOnce();
    });

    it('Worker 上下文使用 OffscreenCanvas 识别整页和气泡，映射坐标并清空所有画布',async()=>{
        const pixels=opaquePixels();
        for(let y=40;y<90;y++)for(let x=30;x<80;x++)pixels.fill(255,(y*200+x)*4,(y*200+x)*4+4);
        const offscreen=vi.fn(function(width:number,height:number){
            const ctx={drawImage:vi.fn(),fillRect:vi.fn(),putImageData:vi.fn(),getImageData:vi.fn(()=>({data:mocks.canvases.length===1?pixels:opaquePixels()}))};
            const canvas={width,height,getContext:vi.fn(()=>ctx)};
            mocks.contexts.push(ctx);mocks.canvases.push(canvas);return canvas;
        });
        vi.stubGlobal('OffscreenCanvas',offscreen);vi.stubGlobal('document',undefined);
        mocks.recognize.mockResolvedValueOnce(response).mockResolvedValueOnce({results:[{text:'Dialogue',confidence:.99,box:{x:15,y:30,width:90,height:30}}]});
        const port=await createBrowserMangaOcr();
        const result=await port.recognize('worker-image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(result.results).toEqual(response.results);
        expect(result.bubbles?.[0].results[0].box).toEqual({x:35,y:50,width:30,height:10});
        expect(offscreen.mock.calls).toEqual([[0,0],[0,0]]);
        for(const canvas of mocks.canvases) expect(canvas.getContext).toHaveBeenCalledWith('2d',{willReadFrequently:true});
        expect(mocks.contexts.every(context=>context.fillRect.mock.calls.length===0)).toBe(true);
        expect(mocks.contexts[1].drawImage).toHaveBeenCalledWith(mocks.canvases[0],30,40,50,50,0,0,150,150);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it('Worker OffscreenCanvas 推理失败也清空画布并关闭自有位图',async()=>{
        vi.stubGlobal('document',undefined);
        vi.stubGlobal('OffscreenCanvas',class {
            width:number;height:number;
            constructor(width:number,height:number){this.width=width;this.height=height;mocks.canvases.push(this);}
            getContext(){return {fillRect:vi.fn(),drawImage:vi.fn(),putImageData:vi.fn(),getImageData:()=>({data:opaquePixels()})};}
        });
        const failure=new Error('worker OCR failed');mocks.recognize.mockRejectedValueOnce(failure);
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('worker-image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toBe(failure);
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(mocks.bitmapClose).toHaveBeenCalledOnce();await port.destroy();
    });

    it('CPU detection 与 recognition 会话也经过推理间歇，保持 this、参数与返回值',async()=>{
        const feeds=recognitionFeeds(),options={fetches:['output']};
        const detectionRun=vi.fn(async function(this:unknown,...args:unknown[]){expect(this).toBe(detection);expect(args).toEqual([feeds,options]);return response;});
        const recognitionRun=vi.fn(async function(this:unknown,...args:unknown[]){expect(this).toBe(recognition);expect(args).toEqual([feeds]);return response;});
        const detection={run:detectionRun,release:vi.fn()},recognition={run:recognitionRun,release:vi.fn()};
        vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
        vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('SharedArrayBuffer',class {});
        mocks.sessions=[detection,recognition];
        mocks.recognize.mockImplementationOnce(async()=>{await detection.run(feeds,options);return recognition.run(feeds);});
        const port=await createBrowserMangaOcr();
        expect((await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual(response.results);
        expect(mocks.wasm.numThreads).toBe(2);
        expect(mocks.pace).toHaveBeenCalledTimes(2);expect(detectionRun).toHaveBeenCalledOnce();expect(recognitionRun).toHaveBeenCalledOnce();
        await port.destroy();
    });

    it('识别入口固定48高度，超域feeds在GPU/CPU原调用前失败，SDK吞错也保留门禁首因',async()=>{
        const native=vi.fn().mockResolvedValue(response),recognition={run:native,release:vi.fn()};
        mocks.sessions=[undefined,recognition];mocks.gpu.mockResolvedValue({available:true,info:'hardware'});
        const port=await createBrowserMangaOcr();
        expect(mocks.options.mock.calls[0][0].recognition.imageHeight).toBe(48);
        mocks.recognize.mockImplementationOnce(async()=>{try{await recognition.run({x:{type:'float32',dims:[1,3,32,8]}});}catch{}return {results:[]};});
        await expect(port.recognize('unsupported',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('支持范围');
        expect(native).not.toHaveBeenCalled();expect(mocks.cpuCreate).not.toHaveBeenCalled();await port.destroy();
    });
    it('识别GPU失败时CPU重载沿用资源层返回的会话模型，不另取来源/改feeds或多forward',async()=>{
        const feeds=recognitionFeeds(),recognition={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};
        const cpu={run:vi.fn(async()=>response),release:vi.fn(async()=>{})},sessionModel=new ArrayBuffer(3);
        const assets={detection:new ArrayBuffer(2),recognition:sessionModel,charactersDictionary:new ArrayBuffer(4)};
        mocks.sessions=[undefined,recognition];mocks.gpu.mockResolvedValue({available:true,info:'hardware'});mocks.assets.mockResolvedValue(assets);mocks.cpuCreate.mockResolvedValue(cpu);
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>recognition.run(feeds));
        await expect(port.recognize('retry',{flatten:true,noCache:true,strategy:'per-box'})).resolves.toMatchObject(response);
        expect(mocks.assets).toHaveBeenCalledTimes(2);expect(mocks.options.mock.calls[0][0].model.recognition).toBe(sessionModel);
        expect(mocks.cpuCreate).toHaveBeenCalledOnce();expect(mocks.cpuCreate).toHaveBeenCalledWith(sessionModel,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
        expect(cpu.run).toHaveBeenCalledOnce();expect(cpu.run).toHaveBeenCalledWith(feeds);await port.destroy();
    });

    it.each([false,true])('硬件 GPU 执行失败时沿用当前请求切换 CPU，取消期间不留下新会话；释放失败=%s',async releaseFails=>{
        mocks.gpu.mockResolvedValue({available:true,info:'hardware'});
        const detection={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};
        mocks.sessions=[detection,undefined];
        const cpu={run:vi.fn(async()=>response),release:vi.fn(async()=>{})};mocks.cpuCreate.mockResolvedValue(cpu);
        const assets={detection:new ArrayBuffer(2),recognition:new ArrayBuffer(3),charactersDictionary:new ArrayBuffer(4)};mocks.assets.mockResolvedValue(assets);
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>detection.run());
        await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(mocks.options.mock.calls[0][0].session.executionProviders).toEqual(['webgpu','wasm']);
        expect(mocks.cpuCreate).toHaveBeenCalledWith(assets.detection,{executionProviders:['wasm'],graphOptimizationLevel:'all'});await port.destroy();
        const controller=new AbortController(),second={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};mocks.sessions=[undefined,second];
        const next=await createBrowserMangaOcr();mocks.cpuCreate.mockImplementationOnce(async()=>{controller.abort();return cpu;});
        if(releaseFails)cpu.release.mockRejectedValueOnce(new Error('late session cleanup failed'));
        mocks.recognize.mockImplementationOnce(async()=>second.run(recognitionFeeds()));
        await expect(next.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(cpu.release).toHaveBeenCalledOnce();
        const pending=new AbortController(),third={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};mocks.sessions=[third,third];
        const last=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>{mocks.assets.mockImplementationOnce(async()=>{pending.abort();return assets;});return third.run(recognitionFeeds());});
        await expect(last.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:pending.signal})).rejects.toMatchObject({name:'AbortError'});
    });
    it('SDK 吞掉 CPU 回退失败时仍报告真实错误，不能把失败当成没有文字',async()=>{
        mocks.gpu.mockResolvedValue({available:true,info:'hardware'});
        const session={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};mocks.sessions=[session,undefined];mocks.cpuCreate.mockRejectedValueOnce(new Error('CPU failed'));
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>{try{await session.run(recognitionFeeds());}catch{}return {results:[]};});
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('CPU failed');
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    });
    it('SDK 吞掉纯 CPU 推理失败时重抛首因，下一次识别不携带旧错误',async()=>{
        const first=new Error('CPU recognition failed'),second=new Error('subsequent CPU error');
        const session={run:vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockResolvedValue(response),release:vi.fn()};
        mocks.sessions=[session,undefined];
        const port=await createBrowserMangaOcr();
        mocks.recognize.mockImplementationOnce(async()=>{
            try{await session.run(recognitionFeeds());}catch{}
            try{await session.run(recognitionFeeds());}catch{}
            return {results:[]};
        });
        await expect(port.recognize('first',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toBe(first);
        mocks.recognize.mockImplementationOnce(async()=>session.run(recognitionFeeds()));
        expect((await port.recognize('retry',{flatten:true,noCache:true,strategy:'per-box'})).results).toEqual(response.results);
        await port.destroy();
    });
    it('不可用会话在失败后释放，立即重试创建新会话，清理失败不覆盖原错误',async()=>{
        const port={recognize:vi.fn().mockRejectedValueOnce(new Error('CPU inference')).mockResolvedValue(response),destroy:vi.fn().mockRejectedValueOnce(new Error('cleanup')).mockResolvedValue(undefined)};
        const create=vi.fn(async()=>port),runtime=createMangaOcrRuntime(create);
        await expect(runtime.recognize('first','en',200,200)).rejects.toThrow('CPU inference');
        expect(await runtime.recognize('retry','en',200,200)).toHaveLength(1);expect(create).toHaveBeenCalledTimes(2);await runtime.dispose();
    });
    it('借用已解码图片避免重复获取与解码，推理后只释放自有 Canvas，保留调用方图片',async()=>{
        const source={naturalWidth:200,naturalHeight:200,src:'data:image/png;base64,source'} as HTMLImageElement;
        const port=await createBrowserMangaOcr();await port.recognize(source.src,{flatten:true,noCache:true,strategy:'per-box',decodedImage:source});
        expect(fetch).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();expect(mocks.bitmapClose).not.toHaveBeenCalled();
        expect(mocks.contexts[0].drawImage).toHaveBeenCalledWith(source,0,0);expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
        expect(source.src).toBe('data:image/png;base64,source');
        const runtime=createMangaOcrRuntime(async()=>port);await runtime.recognize(source.src,'en',200,200,undefined,undefined,source);
        expect(fetch).not.toHaveBeenCalled();await runtime.dispose();
    });
    it.each(['png','svg+xml'].flatMap(format=>[0,255].map(shade=>({format,shade}))))('透明 $format 前景 $shade 只在识别像素合成对比底色，原图仍可透明重绘',async({format,shade})=>{
        const image=`data:image/${format};base64,transparent`,source={naturalWidth:200,naturalHeight:200,src:image} as HTMLImageElement;
        const pixels=new Uint8ClampedArray(200*200*4);pixels.set([shade,shade,shade,255],0);
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementationOnce(()=>{const canvas=factory('canvas');mocks.contexts[0].getImageData.mockReturnValue({data:pixels});return canvas;});
        mocks.recognize.mockImplementationOnce(async canvas=>{
            expect(canvas).toBe(mocks.canvases[0]);const context=mocks.contexts[0];
            expect(context.drawImage).toHaveBeenCalledWith(source,0,0);expect(context.putImageData).not.toHaveBeenCalled();
            expect(context.fillRect).toHaveBeenCalledWith(0,0,200,200);
            expect(context.drawImage.mock.invocationCallOrder[0]).toBeLessThan(context.fillRect.mock.invocationCallOrder[0]);
            expect([...pixels.slice(0,8)]).toEqual([shade,shade,shade,255,0,0,0,0]);
            expect(context.fillStyle).toBe(shade===0?'#fff':'#000');expect(context.globalCompositeOperation).toBeUndefined();
            expect(source.src).toBe(image);return response;
        });
        const port=await createBrowserMangaOcr();expect((await port.recognize(image,{flatten:true,noCache:true,strategy:'per-box',decodedImage:source})).results).toEqual(response.results);
        expect(source.src).toBe(image);expect(mocks.canvases[0]).toMatchObject({width:0,height:0});
        expect(mocks.encode).not.toHaveBeenCalled();expect(mocks.bitmapClose).not.toHaveBeenCalled();await port.destroy();
    });
    it('复用会话串行识别，阅读期间保留会话，空闲三分钟释放，随后重新创建',async()=>{
        const port={recognize:vi.fn(async()=>response),destroy:vi.fn(async()=>{})},create=vi.fn(async()=>port),runtime=createMangaOcrRuntime(create),progress=vi.fn();
        expect(await runtime.recognize('image','en',200,200,undefined,progress)).toHaveLength(1);
        await runtime.recognize('second','en',200,200);expect(create).toHaveBeenCalledOnce();expect(progress.mock.calls).toEqual([['preparing',0],['recognizing']]);
        await vi.advanceTimersByTimeAsync(60000);expect(port.destroy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120000);expect(port.destroy).toHaveBeenCalledOnce();
        await runtime.recognize('third','en',200,200);expect(create).toHaveBeenCalledTimes(2);await runtime.dispose();expect(port.destroy).toHaveBeenCalledTimes(2);
        await runtime.dispose();
    });
    it('取消排队请求立即返回且不干扰正在识别的页，迟到结果丢弃',async()=>{
        const pending=deferred<typeof response>(),port={recognize:vi.fn(()=>pending.promise),destroy:vi.fn()},create=vi.fn(async()=>port),runtime=createMangaOcrRuntime(create);
        const firstAbort=new AbortController(),queuedAbort=new AbortController();
        const first=runtime.recognize('first','en',200,200,firstAbort.signal);await tick();
        const queued=runtime.recognize('queued','en',200,200,queuedAbort.signal);const stopped=expect(queued).rejects.toMatchObject({name:'AbortError'});queuedAbort.abort();await stopped;
        const firstStopped=expect(first).rejects.toMatchObject({name:'AbortError'});firstAbort.abort();await firstStopped;
        pending.resolve(response);await tick();await runtime.dispose();expect(port.recognize).toHaveBeenCalledOnce();
    });
    it('预取消、创建失败和识别失败后队列均可继续，移除模型先释放会话',async()=>{
        const create=vi.fn(),runtime=createMangaOcrRuntime(create),aborted=new AbortController();aborted.abort();
        await expect(runtime.recognize('cancel','en',200,200,aborted.signal)).rejects.toMatchObject({name:'AbortError'});expect(create).not.toHaveBeenCalled();
        create.mockRejectedValueOnce(new Error('download failed'));await expect(runtime.recognize('fail','en',200,200)).rejects.toThrow('download failed');
        await runtime.dispose();const port={recognize:vi.fn().mockRejectedValueOnce(new Error('ocr failed')).mockResolvedValue(response),destroy:vi.fn()};create.mockResolvedValue(port);
        await expect(runtime.recognize('bad','en',200,200)).rejects.toThrow('ocr failed');expect(await runtime.recognize('good','en',200,200)).toHaveLength(1);
        await runtime.removeModels();expect(port.destroy).toHaveBeenCalledTimes(2);expect(mocks.remove).toHaveBeenCalledOnce();
    });
    it('空闲销毁失败不会成为未处理异常，也不会阻止新任务',async()=>{
        const port={recognize:vi.fn(async()=>response),destroy:vi.fn().mockRejectedValue(new Error('closed'))},runtime=createMangaOcrRuntime(async()=>port);
        await runtime.recognize('image','en',200,200);await vi.advanceTimersByTimeAsync(180000);
        expect(await runtime.recognize('next','en',200,200)).toHaveLength(1);
    });
    it('浏览器适配只加载本地 WASM 和已校验模型，图片在本地解码',async()=>{
        const progress=vi.fn();mocks.assets.mockImplementationOnce(async(_signal,notify)=>{notify(32);return {charactersDictionary:new ArrayBuffer(4)}});
        const port=await createBrowserMangaOcr(undefined,progress);await port.recognize('data:image/png;base64,aQ==',{flatten:true,noCache:true,strategy:'per-box'});await port.destroy();
        expect(progress).toHaveBeenCalledWith('preparing',32);expect(mocks.wasm).toMatchObject({numThreads:1,proxy:false,wasmPaths:{mjs:'chrome-extension://test/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs',wasm:'chrome-extension://test/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'}});
        expect(fetch).toHaveBeenCalledWith('data:image/png;base64,aQ==');expect(mocks.recognize.mock.calls[0][0]).toBe(mocks.canvases[0]);
        expect(mocks.canvases[0].width).toBe(0);expect(mocks.bitmapClose).toHaveBeenCalledOnce();
        expect(mocks.options.mock.calls[0][0]).toMatchObject({session:{executionProviders:['wasm'],graphOptimizationLevel:'all'},recognition:{minimumConfidence:0.65}});
        await createBrowserMangaOcr();
    });
    it('放大气泡分别识别并映射回原图坐标，失败和取消时释放所有画布',async()=>{
        const pixels=opaquePixels();for(let y=40;y<90;y++)for(let x=30;x<80;x++)pixels.fill(255,(y*200+x)*4,(y*200+x)*4+4);
        const original=vi.mocked(document.createElement).getMockImplementation()!;let main=true;
        vi.mocked(document.createElement).mockImplementation(()=>{const canvas=original('canvas');if(main){main=false;mocks.contexts.at(-1).getImageData.mockReturnValue({data:pixels});}return canvas;});
        mocks.recognize.mockResolvedValueOnce(response).mockResolvedValueOnce({results:[{text:'Clear dialogue',confidence:.99,box:{x:15,y:30,width:90,height:30}}]});
        const port=await createBrowserMangaOcr();const result=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(result.results).toEqual(response.results);expect(mocks.contexts[0].fillRect).not.toHaveBeenCalled();expect(mocks.contexts[0].putImageData).not.toHaveBeenCalled();
        expect(result.bubbles?.[0].results[0].box).toEqual({x:35,y:50,width:30,height:10});expect(mocks.contexts.every(context=>context.fillRect.mock.calls.length===0)).toBe(true);expect(mocks.contexts[1].drawImage).toHaveBeenCalledWith(mocks.canvases[0],30,40,50,50,0,0,150,150);
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
        // 相同输入在推理之后取消，不能返回迟到的气泡结果。
        main=true;const abort=new AbortController();mocks.recognize.mockImplementationOnce(async()=>{abort.abort();return response;});
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(mocks.bitmapClose).toHaveBeenCalledTimes(2);
        main=true;mocks.recognize.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('crop inference failed'));
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('crop inference failed');
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    });
    it('不支持 Canvas 和解码期间取消时释放位图，裁剪 Canvas 缺失也释放资源',async()=>{
        const port=await createBrowserMangaOcr();
        vi.mocked(document.createElement).mockReturnValueOnce({width:200,height:200,getContext:()=>null} as any);
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('浏览器不支持');
        const abort=new AbortController();vi.mocked(createImageBitmap).mockImplementationOnce(async()=>{abort.abort();return {width:200,height:200,close:mocks.bitmapClose} as any;});
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});
        const pixels=opaquePixels();for(let y=40;y<90;y++)for(let x=30;x<80;x++)pixels.fill(255,(y*200+x)*4,(y*200+x)*4+4);
        vi.mocked(document.createElement).mockReturnValueOnce({width:200,height:200,getContext:()=>({fillRect:vi.fn(),drawImage:vi.fn(),putImageData:vi.fn(),getImageData:()=>({data:pixels})})} as any).mockReturnValueOnce({width:0,height:0,getContext:()=>null} as any);
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('浏览器不支持');expect(mocks.bitmapClose).toHaveBeenCalledTimes(3);
        const stopped=new AbortController();stopped.abort();await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:stopped.signal})).rejects.toMatchObject({name:'AbortError'});
    });
    it('设置清理先释放背景修补和 OCR 会话，卸载期间销毁失败不会变成未处理异常',async()=>{
        await removeMangaModels();expect(mocks.inpaintDispose).toHaveBeenCalledOnce();expect(mocks.remove).toHaveBeenCalledOnce();
        const dispose=vi.spyOn(mangaOcrRuntime,'dispose').mockRejectedValue(new Error('already closed'));mocks.inpaintDispose.mockRejectedValueOnce(new Error('already closed'));
        disposeMangaModels();await tick();expect(dispose).toHaveBeenCalledOnce();expect(mocks.inpaintDispose).toHaveBeenCalledTimes(2);
    });
    it('初始化异常或初始化期间取消均销毁模型，不返回半初始化会话',async()=>{
        mocks.initialize.mockRejectedValueOnce(new Error('init failed'));await expect(createBrowserMangaOcr()).rejects.toThrow('init failed');expect(mocks.destroy).toHaveBeenCalledOnce();
        const abort=new AbortController();mocks.initialize.mockImplementationOnce(async()=>abort.abort());await expect(createBrowserMangaOcr(abort.signal)).rejects.toMatchObject({name:'AbortError'});expect(mocks.destroy).toHaveBeenCalledTimes(2);
        const cancelled=new AbortController();cancelled.abort();await expect(createBrowserMangaOcr(cancelled.signal)).rejects.toMatchObject({name:'AbortError'});
    });
});

// 公有 SDK 端口执行原 resize→toCanvas→一次 read，不把简单 recognize stub 当作真实预处理证明。
describe('识别颜色适配器的公有 SDK 接入与页生命周期',()=>{
    const recognitionOptions={flatten:true as const,noCache:true as const,strategy:'per-box' as const};
    function colorPort(width=8){
        const pixels=new Uint8ClampedArray(width*48*4).fill(255);pixels[(width+2)*4+1]=0;pixels[(width+2)*4+2]=0;
        const native=vi.fn((..._args:unknown[])=>({data:new Uint8ClampedArray(pixels)})),context={getImageData:native};
        const canvas={width,height:48,getContext:vi.fn((_type:string)=>context)},returned={toCanvas:()=>canvas};
        const resize=vi.fn(()=>returned),processor={resize};mocks.recognitionProcessor.mockImplementation(()=>({resize}));
        return {pixels,native,context,canvas,returned,resize,processor};
    }
    function watchPages(){
        const original=mangaOcrColor.createMangaOcrColorAdapter,adapters:Array<ReturnType<typeof original>>=[];
        vi.spyOn(mangaOcrColor,'createMangaOcrColorAdapter').mockImplementation(()=>{const adapter=original();vi.spyOn(adapter,'beginPage');vi.spyOn(adapter,'endPage');adapters.push(adapter);return adapter;});
        return adapters;
    }
    it('原图ROI读回保持原RGBA且不消费或覆盖仍pending的旧颜色hook',async()=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort(),adapters=watchPages();let owner:any;
        const factory=vi.mocked(document.createElement).getMockImplementation()!;
        vi.mocked(document.createElement).mockImplementation(()=>{const c=factory('canvas');if(mocks.canvases.length>1)mocks.contexts.at(-1).getImageData.mockReturnValue({data:new Uint8ClampedArray([230,20,20,128])});return c;});
        mocks.recognitionRun.mockImplementation(async function(this:any){
            const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas(),hook=sample.context.getImageData;
            expect(this.pendingColorReads.size).toBe(1);expect(hook).not.toBe(sample.native);
            expect(Array.from(owner.readMangaSourceRegion({left:0,top:0,width:1,height:1}))).toEqual([230,20,20,128]);
            expect(this.pendingColorReads.size).toBe(1);expect(sample.context.getImageData).toBe(hook);expect(sample.native).not.toHaveBeenCalled();
            expect(output.getContext('2d').getImageData(0,0,8,48).data[(8+2)*4]).toBe(76);
            expect(this.pendingColorReads.size).toBe(0);return [];
        });
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];
        mocks.recognize.mockImplementationOnce(async function(this:any){owner=this;return {results:await recognitor.run({},[])};});
        await port.recognize('separate source and color contexts',recognitionOptions);
        expect(sample.native).toHaveBeenCalledOnce();expect(sample.context.getImageData).toBe(sample.native);expect(adapters[0].endPage).toHaveBeenCalledOnce();
        expect(owner.readMangaSourceRegion({left:0,top:0,width:1,height:1})).toBeUndefined();expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);await port.destroy();
    });
    function watchWhitespace(onObserve?:()=>void){
        const original=mangaWhitespace.createMangaRecognitionWhitespace;
        let controller!:ReturnType<typeof original>;
        vi.spyOn(mangaWhitespace,'createMangaRecognitionWhitespace').mockImplementation(()=>{
            controller=original();
            if(onObserve){const observe=controller.observeOutput;controller.observeOutput=(...args)=>{onObserve();return observe(...args);};}
            for(const key of ['beginPage','endPage','beginRun','endRun','observeBorrowedRead','bindInput','observeOutput','applyToSdkResults'] as const)vi.spyOn(controller,key);
            return controller;
        });
        return ()=>controller;
    }
    it.each([false,true,'non-tensor','height-unset'] as const)('整页接入原session且在其原tensor前写BGR，不先增强R；fixedBatch=%s',async fixed=>{
        const native=vi.fn().mockResolvedValue({}),session={run:native,inputMetadata:[fixed==='non-tensor'?{}:{shape:[fixed?1:'N',3,48,'W']}]};mocks.sessions=[undefined,session];
        mocks.initialize.mockImplementationOnce(async()=>{const options=mocks.options.mock.calls[0][0];if(fixed==='height-unset')options.recognition.imageHeight=undefined;else options.recognition.imageHeight=48;});
        const sample=colorPort(),port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0],crop={x:0,y:0,width:8,height:48};
        let tensor:any;
        mocks.recognitionRun.mockImplementation(async function(this:any){
            const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas(),image=output.getContext('2d').getImageData(0,0,8,48);
            expect(image.data[(8+2)*4]).toBe(255);
            const data=new Float32Array(3*8*48);for(let c=0;c<3;c++)for(let i=0;i<8*48;i++)data[c*8*48+i]=image.data[i*4]*(1/127.5)-1;
            tensor=new this.platform.ort.Tensor('float32',data,[1,3,48,8]);
            expect(data[8+2]).toBe(-1);expect(data[8*48+8+2]).toBe(-1);expect(data[2*8*48+8+2]).toBe(1);
            await this.session.run({x:tensor});return [];
        });
        mocks.recognize.mockImplementationOnce(async canvas=>({results:await recognitor.run(canvas,[crop],[], 'per-box',fixed===true?{...recognitionOptions,recBatchSize:1}:recognitionOptions)}));
        await port.recognize('RGB',recognitionOptions);expect(native).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledWith({x:tensor});expect(sample.native).toHaveBeenCalledOnce();expect(sample.context.getImageData).toBe(sample.native);await port.destroy();
    });
    it.each(['debug','height','width-nan','height-nan','nonpositive'])('候选识别的%s配置不改旧增强输入或原run参数',async stage=>{
        mocks.sessions=[undefined,{run:vi.fn()}];
        mocks.initialize.mockImplementationOnce(async()=>{const options=mocks.options.mock.calls[0][0];options.recognition.recBatchSize=3;if(stage==='height')options.recognition.imageHeight=32;if(stage==='debug')options.debugging={debug:true};});
        const sample=colorPort(),box={x:0,y:0,width:stage==='width-nan'?NaN:stage==='nonpositive'?0:8,height:stage==='height-nan'?NaN:48};
        mocks.recognitionRun.mockImplementation(async function(this:any){const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas();expect(output.getContext('2d').getImageData(0,0,8,48).data[(8+2)*4]).toBe(76);return [];});
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run({},[box],[],'per-box')}));
        await port.recognize('known legacy',recognitionOptions);expect(sample.native).toHaveBeenCalledOnce();expect(mocks.recognitionRun.mock.calls[0][1]).toEqual([box]);await port.destroy();
    });
    it.each(['resize','toCanvas','context','read','mismatch'])('SDK吞%s异常后仍以同一首因拒绝整页，批次未进入native',async stage=>{
        const native=vi.fn(),session={run:native},failure=new Error('first '+stage);mocks.sessions=[undefined,session];const sample=colorPort();let caught:unknown;
        if(stage==='resize')sample.resize.mockImplementation(()=>{throw failure;});
        if(stage==='toCanvas')sample.returned.toCanvas=()=>{throw failure;};
        if(stage==='context')sample.canvas.getContext.mockImplementation(()=>{throw failure;});
        if(stage==='read')sample.native.mockImplementation(()=>{throw failure;});
        mocks.recognitionRun.mockImplementation(async function(this:any){
            try{
                const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas();output.getContext('2d').getImageData(0,0,8,48);
                const data=new Float32Array(3*8*48).fill(1);data[8*48]=0;
                new this.platform.ort.Tensor('float32',data,[1,3,48,8]);
            }catch(error){caught=error;}
            return [];
        });
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];
        mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run({},[{x:0,y:0,width:8,height:48}],[],'per-box')}));
        let observed:unknown;try{await port.recognize('failure',recognitionOptions);}catch(error){observed=error;}
        expect(observed).toBe(caught);expect(observed).toBeInstanceOf(Error);if(stage!=='mismatch')expect(observed).toBe(failure);
        expect(native).not.toHaveBeenCalled();expect(recognitor.pendingColorReads.size).toBe(0);expect(sample.context.getImageData).toBe(sample.native);expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });
    it('复用原 recognition session/字典/调试配置，只读取原 resize 返回的新处理器一次且不写画布或重建模型',async()=>{
        const nativeSessionRun=vi.fn(),session={run:nativeSessionRun,release:vi.fn()},dictionary=['字'],debugging={debug:false};mocks.sessions=[undefined,session];
        mocks.initialize.mockImplementationOnce(async()=>{const options=mocks.options.mock.calls[0][0];options.recognition.charactersDictionary=dictionary;options.debugging=debugging;});
        const sample=colorPort(),before=new Uint8ClampedArray(sample.pixels),seen:number[]=[];
        mocks.recognitionRun.mockImplementation(async function(this:any,...args:unknown[]){
            expect(this).toBe(mocks.recognitors[0]);const processor=this.platform.canvas.createProcessor(args[0]);
            const returned=processor.resize({width:8,height:48});expect(returned).toBe(sample.returned);
            const out=returned.toCanvas().getContext('2d').getImageData(0,0,8,48);seen.push(out.data[(8+2)*4]);return [];
        });
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];
        expect(recognitor.session).toBe(session);expect(recognitor.options).toBe(mocks.options.mock.calls[0][0].recognition);expect(recognitor.options.charactersDictionary).toBe(dictionary);expect(recognitor.debugging).toBe(debugging);
        mocks.recognize.mockImplementationOnce(async canvas=>({results:await recognitor.run(canvas,[],dictionary,'per-box',recognitionOptions)}));
        await port.recognize('color',recognitionOptions);
        expect(seen).toEqual([76]);expect(sample.native).toHaveBeenCalledOnce();expect(sample.native).toHaveBeenCalledWith(0,0,8,48);expect(sample.context.getImageData).toBe(sample.native);
        expect(sample.resize).toHaveBeenCalledOnce();expect(sample.resize).toHaveBeenCalledWith({width:8,height:48});expect(sample.pixels).toEqual(before);
        expect(mocks.canvases).toHaveLength(1);expect(mocks.contexts[0].putImageData).not.toHaveBeenCalled();expect(mocks.cpuCreate).not.toHaveBeenCalled();expect(nativeSessionRun).not.toHaveBeenCalled();expect(session.release).not.toHaveBeenCalled();
        // 外层页 finally 已结束预算，直接借用同一端口不能归一旧页面或持有旧取消信号。
        await recognitor.run({},[],dictionary);expect(seen).toEqual([76,255]);await port.destroy();expect(mocks.destroy).toHaveBeenCalledOnce();
    });
    it.each(['unused','throw','native-read'])('无读取/SDK失败/原生read失败均在run收尾恢复原描述符并保留首因：%s',async stage=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort(),failure=new Error('exact '+stage),descriptor=Object.getOwnPropertyDescriptor(sample.context,'getImageData');
        if(stage==='native-read')sample.native.mockImplementation(()=>{throw failure;});
        mocks.recognitionRun.mockImplementation(async function(this:any){this.platform.canvas.createProcessor({}).resize({width:8,height:48});expect(sample.context.getImageData).not.toBe(sample.native);if(stage==='throw')throw failure;if(stage==='native-read')sample.context.getImageData();return [];});
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run({},[])}));
        if(stage==='unused')await port.recognize('unused',recognitionOptions);else await expect(port.recognize('failure',recognitionOptions)).rejects.toBe(failure);
        expect(Object.getOwnPropertyDescriptor(sample.context,'getImageData')).toEqual(descriptor);await port.destroy();
    });
    it('原run仍pending时不提前还原；调用方abort先拒绝但等原生操作settle后才结束页面并移除hook',async()=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort(),started=deferred<void>(),pending=deferred<void>(),controller=new AbortController(),adapters=watchPages();
        mocks.recognitionRun.mockImplementation(async function(this:any){this.platform.canvas.createProcessor({}).resize({width:8,height:48});started.resolve();await pending.promise;return [];});
        const port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run({},[])}));
        const runtime=createMangaOcrRuntime(async()=>port),result=runtime.recognize('pending','en',200,200,controller.signal);await started.promise;controller.abort();await expect(result).rejects.toMatchObject({name:'AbortError'});
        expect(sample.context.getImageData).not.toBe(sample.native);expect(recognitor.pendingColorReads.size).toBe(1);expect(adapters[0].endPage).not.toHaveBeenCalled();pending.resolve();await runtime.dispose();
        expect(sample.context.getImageData).toBe(sample.native);expect(recognitor.pendingColorReads.size).toBe(0);expect(adapters[0].endPage).toHaveBeenCalledOnce();expect(adapters[0].beginPage).toHaveBeenCalledOnce();expect(adapters[0].beginPage).toHaveBeenCalledWith(controller.signal);
    });
    it('200个独立裁图在首次read前立即退出持有集合，原生推理尚pending时集合已空',async()=>{
        const started=deferred<void>(),pending=deferred<void>(),nativeInference=vi.fn(()=>pending.promise),session={run:nativeInference};mocks.sessions=[undefined,session];
        let recognitor:any,reads=0,resizes=0;
        mocks.recognitionProcessor.mockImplementation(()=>({resize:()=>{
            resizes++;const native=()=>{expect(recognitor.pendingColorReads.size).toBe(0);reads++;return {data:new Uint8ClampedArray(8*48*4).fill(255)};};
            const context={getImageData:native},canvas={width:8,height:48,getContext:()=>context};return {toCanvas:()=>canvas};
        }}));
        mocks.recognitionRun.mockImplementation(async function(this:any){
            for(let index=0;index<200;index++){
                const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas();
                expect(this.pendingColorReads.size).toBe(1);output.getContext('2d').getImageData(0,0,8,48);expect(this.pendingColorReads.size).toBe(0);
            }
            started.resolve();await this.session.run(recognitionFeeds());return [];
        });
        const port=await createBrowserMangaOcr();recognitor=mocks.recognitors[0];mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run({},[])}));
        const result=port.recognize('200 crops',recognitionOptions);await started.promise;
        expect(reads).toBe(200);expect(resizes).toBe(200);expect(nativeInference).toHaveBeenCalledOnce();expect(recognitor.pendingColorReads.size).toBe(0);
        pending.resolve();await result;expect(recognitor.pendingColorReads.size).toBe(0);await port.destroy();
    });
    it('不可装饰上下文不登记空清理函数，原生读回仍只运行一次',async()=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort();Object.freeze(sample.context);
        mocks.recognitionRun.mockImplementation(async function(this:any){const output=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas();expect(this.pendingColorReads.size).toBe(0);output.getContext('2d').getImageData(0,0,8,48);return [];});
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>({results:await mocks.recognitors[0].run({},[])}));
        await port.recognize('frozen',recognitionOptions);expect(sample.native).toHaveBeenCalledOnce();expect(sample.context.getImageData).toBe(sample.native);await port.destroy();
    });
    it('原处理器无2d上下文时保持原返回对象，不新增回读或吞掉原后续错误',async()=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort();sample.canvas.getContext.mockReturnValue(null as any);
        mocks.recognitionRun.mockImplementation(async function(this:any){expect(this.platform.canvas.createProcessor({}).resize({width:8,height:48})).toBe(sample.returned);return [];});
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>({results:await mocks.recognitors[0].run({},[])}));await port.recognize('null',recognitionOptions);expect(sample.native).not.toHaveBeenCalled();await port.destroy();
    });
    it('同一原页的两个瓦片与气泡共享2M颜色预算，超预算仍做原单读且新页重置',async()=>{
        mocks.sessions=[undefined,{run:vi.fn()}];const sample=colorPort(256),seen:number[]=[];
        const pagePixels=new Uint8ClampedArray(2400*200*4);for(let i=3;i<pagePixels.length;i+=4)pagePixels[i]=255;
        for(let y=40;y<90;y++)for(let x=30;x<80;x++)pagePixels.fill(255,(y*2400+x)*4,(y*2400+x)*4+4);
        const factory=vi.mocked(document.createElement).getMockImplementation()!;vi.mocked(document.createElement).mockImplementation(()=>{const c=factory('canvas');mocks.contexts.at(-1).getImageData.mockReturnValue({data:pagePixels});return c;});
        mocks.recognitionRun.mockImplementation(async function(this:any){const output=this.platform.canvas.createProcessor({}).resize({width:256,height:48}).toCanvas();seen.push(output.getContext('2d').getImageData(0,0,256,48).data[(256+2)*4]);return [];});
        let call=0;const adapters=watchPages(),port=await createBrowserMangaOcr(),recognitor=mocks.recognitors[0];mocks.recognize.mockImplementation(async()=>{const count=[81,81,2][call++%3];for(let i=0;i<count;i++)await recognitor.run({},[]);return {results:[]};});
        const source={naturalWidth:2400,naturalHeight:200} as HTMLImageElement;
        for(let i=0;i<2;i++)await port.recognize('tiles+bubble',{...recognitionOptions,decodedImage:source});
        expect(call).toBe(6);expect(seen).toEqual([...Array(162).fill(76),255,255,...Array(162).fill(76),255,255]);
        expect(adapters[0].beginPage).toHaveBeenCalledTimes(2);expect(adapters[0].endPage).toHaveBeenCalledTimes(2);expect(sample.native).toHaveBeenCalledTimes(328);expect(sample.context.getImageData).toBe(sample.native);await port.destroy();
    });
    it.each(['pre-aborted','fetch','bitmap','canvas'])('原页进入前/获取或解码失败也结束颜色页、清除取消信号且不遗留资源：%s',async stage=>{
        const native=vi.fn().mockResolvedValue({}),session={run:native},adapters=watchPages();mocks.sessions=[undefined,session];
        const controller=new AbortController(),failure=new Error('setup '+stage),port=await createBrowserMangaOcr();
        if(stage==='pre-aborted')controller.abort();
        if(stage==='fetch')vi.mocked(fetch).mockRejectedValueOnce(failure);
        if(stage==='bitmap')vi.mocked(createImageBitmap).mockRejectedValueOnce(failure);
        if(stage==='canvas')vi.mocked(document.createElement).mockImplementationOnce(()=>{throw failure;});
        if(stage==='pre-aborted')await expect(port.recognize('setup',{...recognitionOptions,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        else await expect(port.recognize('setup',{...recognitionOptions,signal:controller.signal})).rejects.toBe(failure);
        expect(adapters[0].endPage).toHaveBeenCalledOnce();expect(adapters[0].beginPage).toHaveBeenCalledTimes(stage==='pre-aborted'?0:1);expect(mocks.bitmapClose).toHaveBeenCalledTimes(stage==='canvas'?1:0);
        // 页取消信号不得污染原会话下一次调用；不创建第二个模型或释放共享session。
        controller.abort();await expect(session.run(recognitionFeeds())).resolves.toEqual({});expect(native).toHaveBeenCalledOnce();await port.destroy();
    });
    it('初始化中止也结束颜色控制器，初始化首因不被destroy失败覆盖',async()=>{
        const adapters=watchPages(),failure=new Error('initialize exact');mocks.initialize.mockRejectedValueOnce(failure);mocks.destroy.mockRejectedValueOnce(new Error('cleanup failed'));
        await expect(createBrowserMangaOcr()).rejects.toBe(failure);expect(adapters[0].beginPage).not.toHaveBeenCalled();expect(adapters[0].endPage).toHaveBeenCalledOnce();
    });
    it.each(['override','default','no-cap','array-buffer','too-large','zero','no-height','nonfinite','nonfinite-width','no-dictionary','recovery-off-call','recovery-off-service','recovery-default-unknown'] as const)('空格恢复只观察可证明ratio=1的原Canvas，字典及恢复选项沿用SDK实参：%s',async stage=>{
        const get=watchWhitespace(),session={run:vi.fn()},dictionary=['','model'],override=['','override'];mocks.sessions=[undefined,session];
        mocks.initialize.mockImplementationOnce(async()=>{const options=mocks.options.mock.calls[0][0].recognition;options.charactersDictionary=dictionary;if(stage==='no-cap')delete options.maxCropSourceSideLength;if(stage==='no-dictionary')delete options.charactersDictionary;if(stage==='recovery-off-service')options.spaceRecovery=false;if(stage==='recovery-default-unknown')delete options.spaceRecovery;});
        const port=await createBrowserMangaOcr(),controller=get(),recognitor=mocks.recognitors[0],boxes=[{x:0,y:0,width:8,height:48}];
        const input=stage==='array-buffer'?new ArrayBuffer(1):stage==='too-large'?{width:8193,height:10}:stage==='zero'?{width:0,height:10}:stage==='no-height'?{width:100}:stage==='nonfinite'?{width:100,height:Infinity}:stage==='nonfinite-width'?{width:NaN,height:48}:{width:100,height:48};
        const raw=[{text:'AB',confidence:.99,box:boxes[0]}],corrected=[{...raw[0],text:'A B'}];mocks.recognitionRun.mockResolvedValue(raw);
        vi.mocked(controller.applyToSdkResults).mockReturnValueOnce(corrected);
        mocks.recognize.mockImplementationOnce(async()=>({results:await recognitor.run(input,boxes,stage==='override'?override:undefined,'per-box',stage==='recovery-off-call'?{spaceRecovery:false}:undefined)}));
        const result=await port.recognize('scope',recognitionOptions);
        expect(result.results).toEqual(corrected);expect(raw[0].text).toBe('AB');
        expect(controller.beginRun).toHaveBeenCalledWith({boxes,batchSize:6,dictionary:stage==='override'?override:stage==='no-dictionary'?[]:dictionary,
            supportedPerBox:!['recovery-off-call','recovery-off-service','recovery-default-unknown'].includes(stage),
            sourceRatioOne:!['array-buffer','too-large','zero','no-height','nonfinite','nonfinite-width'].includes(stage)});
        expect(controller.beginPage).toHaveBeenCalledOnce();expect(controller.endRun).toHaveBeenCalledOnce();expect(controller.endPage).toHaveBeenCalledOnce();await port.destroy();
    });
    it.each(['first-output','no-output','undefined-output'] as const)('Tensor只在成功构造后绑定，原推理输出%s原样交回SDK且不夺取dispose所有权',async stage=>{
        let pacing=false;
        const get=watchWhitespace(()=>expect(pacing).toBe(true)),first={dims:[1,3,2],data:new Float32Array(6)},second={dims:[1,3,2],data:new Float32Array(6)},output=stage==='first-output'?{first,second}:stage==='undefined-output'?undefined:{},native=vi.fn().mockResolvedValue(output),session={run:native};mocks.sessions=[undefined,session];
        const sample=colorPort(),port=await createBrowserMangaOcr(),controller=get(),recognitor=mocks.recognitors[0],box={x:0,y:0,width:8,height:48};let tensor:any;
        mocks.pace.mockImplementationOnce(async operation=>{pacing=true;try{return await operation();}finally{pacing=false;}});
        mocks.recognitionRun.mockImplementation(async function(this:any){
            const resized=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas(),image=resized.getContext('2d').getImageData(0,0,8,48);
            const data=new Float32Array(3*8*48);for(let c=0;c<3;c++)for(let i=0;i<8*48;i++)data[c*8*48+i]=image.data[i*4]*(1/127.5)-1;
            tensor=new this.platform.ort.Tensor('float32',data,[1,3,48,8]);expect(controller.bindInput).toHaveBeenCalledWith(tensor,{readIndices:[0],resizedWidths:[8],paddedWidth:8,height:48});
            expect(await this.session.run({x:tensor})).toBe(output);return [];
        });
        mocks.recognize.mockImplementationOnce(async canvas=>({results:await recognitor.run(canvas,[box],[],'per-box')}));
        await port.recognize('observe',recognitionOptions);expect(sample.native).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledOnce();expect(tensor.dispose).not.toHaveBeenCalled();
        if(stage==='first-output'){expect(controller.observeOutput).toHaveBeenCalledOnce();expect(controller.observeOutput).toHaveBeenCalledWith(tensor,first);}else expect(controller.observeOutput).not.toHaveBeenCalled();
        expect(controller.endRun).toHaveBeenCalledOnce();expect(controller.endPage).toHaveBeenCalledOnce();await port.destroy();
    });
    it.each(['borrowed-read','tensor-constructor','bind-input','output','sdk-run'] as const)('新增观察点%s真正失败时保留同一首因，SDK吞错仍拒绝整页并释放自己持有的引用',async stage=>{
        const get=watchWhitespace(),failure=new Error('primary '+stage),native=vi.fn().mockResolvedValue({out:{dims:[1,3,2],data:new Float32Array(6)}}),session={run:native};mocks.sessions=[undefined,session];
        const sample=colorPort(),port=await createBrowserMangaOcr(),controller=get(),recognitor=mocks.recognitors[0],box={x:0,y:0,width:8,height:48};let tensor:any,caught:unknown;
        if(stage==='borrowed-read')vi.mocked(controller.observeBorrowedRead).mockImplementationOnce(()=>{throw failure;});
        if(stage==='bind-input')vi.mocked(controller.bindInput).mockImplementationOnce(()=>{throw failure;});
        if(stage==='output')vi.mocked(controller.observeOutput).mockImplementationOnce(()=>{throw failure;});
        mocks.tensorConstruct.mockImplementation(value=>{tensor=value;if(stage==='tensor-constructor')throw failure;if(stage==='bind-input')value.dispose.mockImplementation(()=>{throw new Error('cleanup secondary');});});
        mocks.recognitionRun.mockImplementation(async function(this:any){
            if(stage==='sdk-run')throw failure;
            try{
                const resized=this.platform.canvas.createProcessor({}).resize({width:8,height:48}).toCanvas(),image=resized.getContext('2d').getImageData(0,0,8,48);
                const data=new Float32Array(3*8*48);for(let c=0;c<3;c++)for(let i=0;i<8*48;i++)data[c*8*48+i]=image.data[i*4]*(1/127.5)-1;
                const created=new this.platform.ort.Tensor('float32',data,[1,3,48,8]);await this.session.run({x:created});
            }catch(error){caught=error;}
            return [];
        });
        mocks.recognize.mockImplementationOnce(async canvas=>({results:await recognitor.run(canvas,[box],[],'per-box')}));
        await expect(port.recognize('failed observer',recognitionOptions)).rejects.toBe(failure);
        if(stage!=='sdk-run')expect(caught).toBe(failure);
        if(stage==='bind-input')expect(tensor.dispose).toHaveBeenCalledOnce();else if(tensor)expect(tensor.dispose).not.toHaveBeenCalled();
        expect(sample.context.getImageData).toBe(sample.native);expect(controller.endRun).toHaveBeenCalledOnce();expect(controller.endPage).toHaveBeenCalledOnce();
        expect(mocks.canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);await port.destroy();
    });
});

it.each(['manga','image'] as const)('原始高置信数字证据在 %s 不被误标为不确定',async profile=>{
    const number={text:'08:45',confidence:.99,box:{x:30,y:20,width:80,height:20}};
    mocks.recognize.mockResolvedValueOnce({results:[number]});
    const port=await createBrowserMangaOcr();
    const page=await port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'});
    expect(page.results).toEqual([number]);expect(page.numericEvidence).toEqual([number]);
    const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
    const lines=collectMangaRegions(page,'en',200,200,profile);
    expect(lines).toHaveLength(1);expect(lines[0]).toMatchObject({text:'08:45'});expect(lines[0].numericUncertain).toBeUndefined();
    await port.destroy();
});
