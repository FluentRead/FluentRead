vi.mock('@/src/shared/onnx/resources', async original => ({...await original<any>(), paceLocalInference: mocks.pace}));
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({assets:vi.fn(),remove:vi.fn(),initialize:vi.fn(),recognize:vi.fn(),retryRecognition:vi.fn(),destroy:vi.fn(),options:vi.fn(),
    gpu:vi.fn(),cpuCreate:vi.fn(),sessions:[] as any[],detectors:[] as any[],recognitors:[] as any[],recognitionProcessor:vi.fn(),recognitionRun:vi.fn(),createProcessor:vi.fn(),inpaintDispose:vi.fn(),bitmapClose:vi.fn(),contexts:[] as any[],canvases:[] as any[],
    workerPrepare:vi.fn(),workerRequest:vi.fn(),workerRelease:vi.fn(),workerDispose:vi.fn(),encode:vi.fn(),planDeskew:vi.fn(),trimDeskew:vi.fn(),pace:vi.fn((operation:()=>Promise<unknown>)=>operation()),
    wasm:{numThreads:0,wasmPaths:undefined as unknown,proxy:true}}));
vi.mock('@/src/features/image-translation/services/mangaOcrAssets', async importOriginal => ({...await importOriginal<any>(),loadMangaOcrAssets:mocks.assets,removeMangaOcrAssets:mocks.remove}));
vi.mock('onnxruntime-web/webgpu',()=>({env:{wasm:mocks.wasm},InferenceSession:{create:mocks.cpuCreate}}));
vi.mock('@/src/shared/onnx/webgpu',()=>({probeWebGpu:mocks.gpu}));
vi.mock('ppu-paddle-ocr/web',()=>({
    RecognitionService:class{platform={canvas:{createProcessor:(canvas:unknown)=>mocks.recognitionProcessor(canvas)}};constructor(public session:unknown,public options:unknown,public debugging:unknown){mocks.recognitors.push(this);}async run(...args:unknown[]){return mocks.recognitionRun.apply(this,args);}},
    DetectionService:class{platform={canvas:{createProcessor:(canvas:unknown)=>mocks.createProcessor(canvas)}};constructor(public session:unknown,public options:unknown){mocks.detectors.push(this);}},
    PaddleOcrService:class{constructor(public options:any){mocks.options(options)}recognitor={run:mocks.retryRecognition};detectionSession=mocks.sessions[0];recognitionSession=mocks.sessions[1];async initialize(){return mocks.initialize();}recognize=mocks.recognize;destroy=mocks.destroy;}
}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{dispose:mocks.inpaintDispose}}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient',async original=>({...await original<any>(),mangaInferenceClient:{prepare:mocks.workerPrepare,request:mocks.workerRequest,release:mocks.workerRelease,dispose:mocks.workerDispose}}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaOcrDeskew',async original=>({...await original<any>(),planMangaOcrDeskew:mocks.planDeskew,trimMangaOcrDeskew:mocks.trimDeskew}));
import {createBrowserMangaOcr, createMangaOcrRuntime, mangaOcrRuntime, removeMangaModels, disposeMangaModels,padMangaOcrDetectionBox,shouldRotateMangaOcrRetry} from '@/src/features/image-translation/services/mangaOcr';
import * as mangaOcrColor from '@/src/features/image-translation/services/mangaOcrColor';
import {planMangaOcrTiles, mergeMangaOcrTiles,collectMangaOcrTileNumericEvidence} from '@/src/features/image-translation/services/mangaOcrTiles';
const opaquePixels=()=>{const pixels=new Uint8ClampedArray(200*200*4);for(let index=3;index<pixels.length;index+=4)pixels[index]=255;return pixels;};
const response = {results:[{text:'Hello world',confidence:0.99,box:{x:10,y:10,width:100,height:20}}]};
const deferred = <T,>() => {let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick = async () => {for(let i=0;i<6;i++)await Promise.resolve()};
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();mocks.contexts=[];mocks.canvases=[];mocks.sessions=[];mocks.detectors=[];mocks.recognitors=[];mocks.recognitionProcessor.mockReset();mocks.createProcessor.mockReset();mocks.gpu.mockResolvedValue({available:false,info:''});mocks.assets.mockResolvedValue({charactersDictionary:new ArrayBuffer(4)});mocks.initialize.mockResolvedValue(undefined);mocks.destroy.mockResolvedValue(undefined);mocks.remove.mockResolvedValue(undefined);mocks.inpaintDispose.mockResolvedValue(undefined);mocks.recognize.mockResolvedValue(response);vi.stubGlobal('GPUDevice',class{get adapterInfo(){return {};}});vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>'chrome-extension://test'+p}});vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1,2,3]))));
    mocks.recognitionRun.mockReset().mockImplementation((...args:unknown[])=>mocks.retryRecognition(...args));mocks.retryRecognition.mockReset().mockResolvedValue([]);mocks.planDeskew.mockReset().mockReturnValue(undefined);mocks.trimDeskew.mockReset().mockReturnValue(undefined);mocks.workerPrepare.mockReset().mockResolvedValue(undefined);mocks.workerRequest.mockReset().mockResolvedValue(response);mocks.workerRelease.mockReset().mockResolvedValue(undefined);mocks.encode.mockReset().mockResolvedValue('data:image/png;base64,rasterized');
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:200,height:200,close:mocks.bitmapClose})));
    vi.stubGlobal('document',{createElement:vi.fn(()=>{const ctx={drawImage:vi.fn(),fillRect:vi.fn(),putImageData:vi.fn(),translate:vi.fn(),rotate:vi.fn(),getImageData:vi.fn(()=>({data:opaquePixels()}))};const canvas={width:0,height:0,getContext:vi.fn(()=>ctx)};mocks.contexts.push(ctx);mocks.canvases.push(canvas);return canvas;})});
});
afterEach(async()=>{await mangaOcrRuntime.dispose().catch(()=>undefined);vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()});

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
            if(stage==='sdk-swallowed')try{await session.run();}catch{}
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
        mocks.retryRecognition.mockImplementationOnce(async()=>{if(stage==='throw')throw failure;try{await session.run();}catch{}return [];});
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
            try{await session.run();}catch{}return [];
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
                for(const box of boxes){
                    await session.run(box);
                    if(stage==='between-runs'&&nativeRun.mock.calls.length===1)controller.abort();
                }
            }catch{}return [];
        });
        const port=await createBrowserMangaOcr();
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal}))
            .rejects.toMatchObject({name:'AbortError'});
        expect(mocks.retryRecognition.mock.calls[0][1]).toEqual(columns.map(item=>item.box));
        expect(nativeRun).toHaveBeenCalledOnce();expect(nativeRun).toHaveBeenCalledWith(columns[0].box);
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
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'data:image/png;base64,rasterized'},controller.signal,progress);
        expect(mocks.canvases[0]).toMatchObject({width:0,height:0});
        expect(source).toMatchObject({naturalWidth:460,naturalHeight:250,width:230,height:125,src:image});expect(close).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();expect(createImageBitmap).not.toHaveBeenCalled();expect(mocks.bitmapClose).not.toHaveBeenCalled();
    });

    it.each(['data:image/png;base64,png','data:image/jpeg;base64,jpeg','data:image/webp;base64,webp'])('默认 Worker 直接转发位图，不重复编码：%s',async image=>{
        const controller=new AbortController(),progress=vi.fn();
        const source={naturalWidth:200,naturalHeight:200,src:image} as HTMLImageElement;
        expect(await mangaOcrRuntime.recognize(image,'en',200,200,controller.signal,progress,source)).toHaveLength(1);
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image},controller.signal,progress);
        expect(mocks.encode).not.toHaveBeenCalled();expect(document.createElement).not.toHaveBeenCalled();
        expect(source.src).toBe(image);
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
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'data:image/png;base64,next'},undefined,undefined);
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
        expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'first'},controller.signal,progress);
        expect(progress.mock.calls).toEqual([['preparing',0],['preparing',35],['initializing'],['recognizing'],['recognizing',72]]);
        await mangaOcrRuntime.recognize('second','en',200,200);
        expect(mocks.workerPrepare).toHaveBeenCalledOnce();
        expect(mocks.workerRequest).toHaveBeenLastCalledWith({type:'recognize',image:'second'},undefined,undefined);
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
        await tick();expect(mocks.workerRequest).toHaveBeenCalledWith({type:'recognize',image:'active'},controller.signal,undefined);
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
        const feeds={input:new Float32Array([1])},options={fetches:['output']};
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

    it('硬件 GPU 执行失败时沿用当前请求切换 CPU，取消期间不留下新会话',async()=>{
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
        mocks.recognize.mockImplementationOnce(async()=>second.run());
        await expect(next.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(cpu.release).toHaveBeenCalledOnce();
        const pending=new AbortController(),third={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};mocks.sessions=[third,third];
        const last=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>{mocks.assets.mockImplementationOnce(async()=>{pending.abort();return assets;});return third.run();});
        await expect(last.recognize('image',{flatten:true,noCache:true,strategy:'per-box',signal:pending.signal})).rejects.toMatchObject({name:'AbortError'});
    });
    it('SDK 吞掉 CPU 回退失败时仍报告真实错误，不能把失败当成没有文字',async()=>{
        mocks.gpu.mockResolvedValue({available:true,info:'hardware'});
        const session={run:vi.fn().mockRejectedValue(new Error('GPU')),release:vi.fn(async()=>{})};mocks.sessions=[session,undefined];mocks.cpuCreate.mockRejectedValueOnce(new Error('CPU failed'));
        const port=await createBrowserMangaOcr();mocks.recognize.mockImplementationOnce(async()=>{try{await session.run();}catch{}return {results:[]};});
        await expect(port.recognize('image',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toThrow('CPU failed');
        expect(mocks.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    });
    it('SDK 吞掉纯 CPU 推理失败时重抛首因，下一次识别不携带旧错误',async()=>{
        const first=new Error('CPU recognition failed'),second=new Error('subsequent CPU error');
        const session={run:vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockResolvedValue(response),release:vi.fn()};
        mocks.sessions=[session,undefined];
        const port=await createBrowserMangaOcr();
        mocks.recognize.mockImplementationOnce(async()=>{
            try{await session.run();}catch{}
            try{await session.run();}catch{}
            return {results:[]};
        });
        await expect(port.recognize('first',{flatten:true,noCache:true,strategy:'per-box'})).rejects.toBe(first);
        mocks.recognize.mockImplementationOnce(async()=>session.run());
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
            expect(context.drawImage).toHaveBeenCalledWith(source,0,0);expect(context.putImageData).toHaveBeenCalledWith({data:pixels},0,0);
            expect(context.drawImage.mock.invocationCallOrder[0]).toBeLessThan(context.putImageData.mock.invocationCallOrder[0]);
            expect([...pixels.slice(0,8)]).toEqual([shade,shade,shade,255,255-shade,255-shade,255-shade,255]);
            expect(context.fillRect).not.toHaveBeenCalled();expect(source.src).toBe(image);return response;
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
            started.resolve();await this.session.run({});return [];
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
        controller.abort();await expect(session.run()).resolves.toEqual({});expect(native).toHaveBeenCalledOnce();await port.destroy();
    });
    it('初始化中止也结束颜色控制器，初始化首因不被destroy失败覆盖',async()=>{
        const adapters=watchPages(),failure=new Error('initialize exact');mocks.initialize.mockRejectedValueOnce(failure);mocks.destroy.mockRejectedValueOnce(new Error('cleanup failed'));
        await expect(createBrowserMangaOcr()).rejects.toBe(failure);expect(adapters[0].beginPage).not.toHaveBeenCalled();expect(adapters[0].endPage).toHaveBeenCalledOnce();
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
