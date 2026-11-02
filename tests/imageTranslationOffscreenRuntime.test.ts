import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mangaMaskBoxes} from '@/src/features/image-translation/mangaPatchResult';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {recordMangaBubblePlacement,bindMangaBubblePlacements} from '@/src/features/image-translation/services/mangaBubblePlacement';
import type {MangaRegion} from '@/src/features/image-translation/services/mangaRegions';
import type {ImageViewport} from '@/src/shared/image/types';

const mocks = vi.hoisted(() => ({recognize: vi.fn(), inpaint: vi.fn(), background: vi.fn(), draw: vi.fn(), mangaRecognize:vi.fn(), repair:vi.fn(), mangaDraw:vi.fn(), sampleManga:vi.fn(), alphaProtection:vi.fn(), encode:vi.fn()}));
vi.mock('@/src/features/image-translation/services/mangaAlphaProtection',async importOriginal=>({...await importOriginal<typeof import('@/src/features/image-translation/services/mangaAlphaProtection')>(),planMangaAlphaProtection:mocks.alphaProtection}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaOcr',()=>({mangaOcrRuntime:{recognize:mocks.mangaRecognize}}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{repair:mocks.repair}}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient',()=>({mangaInferenceClient:{prepareTextSegmentation:vi.fn(async()=>false),segmentText:vi.fn()}}));
vi.mock('@/src/features/image-translation/services/mangaRendering',async importOriginal=>({...await importOriginal<typeof import('@/src/features/image-translation/services/mangaRendering')>(),drawMangaTranslations:mocks.mangaDraw,sampleMangaBackgrounds:mocks.sampleManga}));
vi.mock('@/src/features/image-translation/services/ocrRuntime', () => ({recognizeImage: mocks.recognize}));
vi.mock('@/src/features/image-translation/services/inpainting', async importOriginal => ({...(await importOriginal()), inpaintTextRegions: mocks.inpaint}));
vi.mock('@/src/features/image-translation/services/rendering', async importOriginal => ({...await importOriginal<typeof import('@/src/features/image-translation/services/rendering')>(),
    getImageTextBackgroundColor: mocks.background, drawTranslatedImageText: mocks.draw,
}));

import {
    cropAreaInOffscreen,
    translateAreaInOffscreen,
    translateImageInOffscreen,
    translateImageTextsInExtension,
} from '@/src/features/image-translation/services/offscreenRuntime';

interface ImageOptions {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    mode?: 'load' | 'error' | 'pending' | 'throw';
}

const imageOptions: ImageOptions[] = [];
const images: TestImage[] = [];
class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    private value = '';
    private options: ImageOptions;
    constructor() {
        this.options = imageOptions.shift() || {};
        this.width = this.options.width ?? 32;
        this.height = this.options.height ?? 16;
        this.naturalWidth = this.options.naturalWidth ?? this.width;
        this.naturalHeight = this.options.naturalHeight ?? this.height;
        images.push(this);
    }
    get src() { return this.value; }
    set src(value: string) {
        this.value = value;
        if (!value || this.options.mode === 'pending') return;
        if (this.options.mode === 'throw') throw new Error('source rejected');
        queueMicrotask(() => this.options.mode === 'error' ? this.onerror?.() : this.onload?.());
    }
}

const canvases: ReturnType<typeof createCanvasStub>[] = [];
let nullContext = false;
function createCanvasStub() {
    const canvas = {
        width: 0,
        height: 0,
        context: {
            font:'',textAlign:'left',textBaseline:'alphabetic',save:vi.fn(),restore:vi.fn(),
            measureText:vi.fn((text:string)=>{
                const size=Number(/^400 ([\d.e+-]+)px/u.exec(canvas.context.font)?.[1]??10),width=text.length*size*.5;
                const left=canvas.context.textAlign==='center'?width/2:canvas.context.textAlign==='right'?width:0;
                return {width,actualBoundingBoxLeft:left-1,actualBoundingBoxRight:width-left-1,actualBoundingBoxAscent:size*.45,actualBoundingBoxDescent:size*.45};
            }),
            drawImage: vi.fn(),
            // 生命周期用例的普通已解码图为不透明底；透明准入另用显式原像素fixture。
            getImageData: vi.fn(() => ({data: opaqueAlphaPixels(canvas.width,canvas.height)})),
            putImageData: vi.fn(),
        },
        getContext: vi.fn(() => nullContext ? null : canvas.context),
        toDataURL: vi.fn(() => 'data:image/png;base64,translated'),
    };
    return canvas;
}

function makeCanvas() {
    const canvas = createCanvasStub();
    canvases.push(canvas);
    return canvas;
}

const sendMessage = vi.fn();
const runtime: {sendMessage: typeof sendMessage; lastError?: {message: string}} = {sendMessage};
const lines = [{text: 'Hello', bbox: {x0: 3, y0: 3, x1: 29, y1: 13}}];
const selection = {left: 0, top: 0, width: 20, height: 10, viewportWidth: 40, viewportHeight: 20};

async function flushMicrotasks() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

function ordinaryAlphaCanvas(width:number,height:number,pixels:ReturnType<typeof opaqueAlphaPixels>,configure?:(canvas:ReturnType<typeof createCanvasStub>)=>void) {
    imageOptions.push({width,height});
    vi.stubGlobal('document',{createElement:vi.fn(()=>{
        const canvas=makeCanvas();canvas.context.getImageData.mockReturnValue({data:pixels});configure?.(canvas);return canvas;
    })});
}
function opaqueAlphaPixels(width:number,height:number,alpha=255) {
    const pixels=new Uint8ClampedArray(width*height*4);
    for(let offset=0;offset<pixels.length;offset+=4)pixels.set([255,250,230,alpha],offset);
    return pixels;
}
function ordinaryFitFixture(configure?:(canvas:ReturnType<typeof createCanvasStub>)=>void,lineOptions:Partial<ImageTextRegion>={},text='FIT') {
    const pixels=opaqueAlphaPixels(200,80);pixels.set([17,53,191,96],(30*200+62)*4);
    ordinaryAlphaCanvas(200,80,pixels,configure);
    mocks.recognize.mockResolvedValueOnce([{text:'ORIGINAL',bbox:{x0:20,y0:20,x1:180,y1:50},fontSize:30,...lineOptions}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:[text]}:undefined));
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.encode.mockResolvedValue('data:image/png;base64,translated');
    mocks.sampleManga.mockReturnValue([{color:'rgb(255,255,255)',uniform:false}]);
    imageOptions.length = 0;
    images.length = 0;
    canvases.length = 0;
    nullContext = false;
    runtime.lastError = undefined;
    mocks.recognize.mockResolvedValue(lines);
    mocks.inpaint.mockImplementation((pixels, _width, _height, _lines, inPlace) => inPlace ? pixels : new Uint8ClampedArray(pixels));
    mocks.background.mockReturnValue('rgb(240,240,240)');
    sendMessage.mockImplementation((message, callback) => {
        callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['你好']} : undefined);
    });
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('document', {createElement: vi.fn(() => makeCanvas())});
    vi.stubGlobal('chrome', {runtime});
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([128,255])('普通图外周alpha=%s时保护原孔RGBA与明确matte，完整译文在单个无孔框内绘制',async backgroundAlpha=>{
    const width=64,height=48,pixels=opaqueAlphaPixels(width,height,backgroundAlpha);
    const holes=[{x0:24,y0:15,x1:26,y1:20,rgba:[17,53,191,0]},{x0:38,y0:20,x1:40,y1:24,rgba:[255,250,230,96]}];
    for(const hole of holes)for(let y=hole.y0;y<hole.y1;y++)for(let x=hole.x0;x<hole.x1;x++)pixels.set(hole.rgba,(y*width+x)*4);
    const before=pixels.slice(),line={text:'ORIGINAL',bbox:{x0:8,y0:10,x1:56,y1:30},fontSize:20},translation='完整翻译不得裁掉';
    ordinaryAlphaCanvas(width,height,pixels);mocks.recognize.mockResolvedValueOnce([line]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:[translation]}:undefined));
    const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
    mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
    const result=await translateImageInOffscreen('ordinary-alpha','en','Page');
    expect(result.lines).toMatchObject([{sourceText:'ORIGINAL',text:translation}]);expect(mocks.draw).toHaveBeenCalledOnce();
    const [,text,x,y,w,h]=mocks.draw.mock.calls[0];expect(text).toBe(translation);
    expect(x).toBeGreaterThanOrEqual(6);expect(y).toBeGreaterThanOrEqual(6);expect(x+w).toBeLessThanOrEqual(58);expect(y+h).toBeLessThanOrEqual(34);
    for(const hole of holes)expect(x+w<=hole.x0||x>=hole.x1||y+h<=hole.y0||y>=hole.y1).toBe(true);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const hole=holes.find(h=>x>=h.x0&&x<h.x1&&y>=h.y0&&y<h.y1),offset=(y*width+x)*4;
        expect(Array.from(pixels.subarray(offset,offset+4))).toEqual(hole?Array.from(before.subarray(offset,offset+4)):[255,250,230,backgroundAlpha]);
    }
    expect(canvases[0].context.getImageData).toHaveBeenCalledOnce();expect(canvases[0].context.putImageData).toHaveBeenCalledOnce();expect(mocks.encode).toHaveBeenCalledOnce();
    expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
});

it('普通opaque图沿用原修补和原绘字坐标，不因alpha保护增加裁剪或改译文',async()=>{
    const pixels=opaqueAlphaPixels(64,48),line={text:'ORIGINAL',bbox:{x0:8,y0:10,x1:56,y1:30},fontSize:20};
    ordinaryAlphaCanvas(64,48,pixels);mocks.recognize.mockResolvedValueOnce([line]);
    await translateImageInOffscreen('ordinary-opaque','en','Page');
    expect(mocks.draw.mock.calls[0].slice(1)).toEqual(['你好',6,6,52,28,'rgb(240,240,240)',24,'left']);
    expect(mocks.inpaint).toHaveBeenCalledWith(pixels,64,48,[{...line,text:'你好'}],true);
});

it.each([
    {name:'非有限字号',options:{fontSize:NaN}},
    {name:'图外合并框但源框在图内',options:{bbox:{x0:100,y0:12,x1:120,y1:30},sourceBoxes:[{x0:12,y0:12,x1:40,y1:30}]}},
    {name:'图下合并框但源框在图内',options:{bbox:{x0:12,y0:100,x1:40,y1:120},sourceBoxes:[{x0:12,y0:12,x1:40,y1:30}]}},
])('普通图$name不发布擦除后无法完整绘字的结果',async({options})=>{
    ordinaryAlphaCanvas(64,48,opaqueAlphaPixels(64,48));
    mocks.recognize.mockResolvedValueOnce([{text:'ORIGINAL',fontSize:20,bbox:{x0:12,y0:12,x1:40,y1:30},...options}]);
    const result=await translateImageInOffscreen('invalid-write-footprint','en','Page');
    expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'ORIGINAL',text:'你好',renderSkipped:true}]});
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    expect(canvases[0].context.putImageData).not.toHaveBeenCalled();
});

it('普通图无字号元数据时透明完整预检沿用原框高度，不引入猜测字号',async()=>{
    ordinaryFitFixture(undefined,{fontSize:undefined});
    const result=await translateImageInOffscreen('alpha-fallback-size','en','Page');
    expect(result.image).toBeTruthy();expect(mocks.draw.mock.calls[0][7]).toBe(36);
    expect(mocks.draw.mock.calls[0][9].lines).toEqual(['FIT']);
});

it('普通图完全被已确认透明孔覆盖时原子保留原图和完整译文，不编码部分译图',async()=>{
    const pixels=opaqueAlphaPixels(64,48),line={text:'ORIGINAL',bbox:{x0:8,y0:10,x1:56,y1:30},fontSize:10};
    for(let y=8;y<32;y++)for(let x=6;x<58;x++)pixels.set([0,0,0,0],(y*64+x)*4);
    ordinaryAlphaCanvas(64,48,pixels);mocks.recognize.mockResolvedValueOnce([line]);
    const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
    mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
    const result=await translateImageInOffscreen('ordinary-no-space','en','Page');
    expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'ORIGINAL',text:'你好',renderSkipped:true}]});
    expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);expect(images[0].src).toBe('');
});

it('普通图后续区域共用alpha布局预算，整页预检失败时不启动修补或绘字',async()=>{
    const width=64,height=150,pixels=opaqueAlphaPixels(width,height);
    const rows=[{text:'FIRST',bbox:{x0:8,y0:10,x1:56,y1:30},fontSize:20},{text:'SECOND',bbox:{x0:8,y0:60,x1:56,y1:80},fontSize:20},{text:'KEEP',bbox:{x0:8,y0:110,x1:56,y1:130},fontSize:20}];
    pixels.set([0,0,0,0],(20*width+28)*4);pixels.set([17,53,191,96],(70*width+28)*4);
    ordinaryAlphaCanvas(width,height,pixels);mocks.recognize.mockResolvedValueOnce(rows);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['完整第一段','完整第二段','KEEP']}:undefined));
    const imported=await import('@/src/features/image-translation/services/mangaAlphaProtection');
    const actual=await vi.importActual<typeof imported>('@/src/features/image-translation/services/mangaAlphaProtection');
    let shared:{remaining:number}|undefined;
    vi.spyOn(imported,'mangaAlphaClearRects').mockImplementation((protection,bounds,budget)=>{
        if(!shared){shared=budget!;const result=actual.mangaAlphaClearRects(protection,bounds,budget);shared.remaining=0;return result;}
        expect(budget).toBe(shared);return actual.mangaAlphaClearRects(protection,bounds,budget);
    });
    const result=await translateImageInOffscreen('ordinary-alpha-budget','en','Page');
    expect(result).toMatchObject({image:'',imageUnchanged:true});
    expect(result.lines.map(line=>[line.sourceText,line.text,line.renderSkipped===true])).toEqual([['FIRST','完整第一段',true],['SECOND','完整第二段',true],['KEEP','KEEP',false]]);
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);expect(images[0].src).toBe('');
});

it('普通图alpha规划超预算仍保留完整文本，取消在保护修补后仍优先于文本回退',async()=>{
    const line={text:'ORIGINAL',bbox:{x0:8,y0:10,x1:56,y1:30},fontSize:20};
    ordinaryAlphaCanvas(64,48,opaqueAlphaPixels(64,48));mocks.recognize.mockResolvedValueOnce([{...line,sourceBoxes:Array(8193).fill(line.bbox)}]);
    await expect(translateImageInOffscreen('ordinary-plan-budget','en','Page')).resolves.toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'ORIGINAL',text:'你好',renderSkipped:true}]});
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    const pixels=opaqueAlphaPixels(64,48),offset=(20*64+28)*4,controller=new AbortController();pixels.set([17,53,191,96],offset);
    ordinaryAlphaCanvas(64,48,pixels);mocks.recognize.mockResolvedValueOnce([line]);
    const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
    mocks.inpaint.mockImplementation((data,w,h,lines,inPlace,protection)=>{const result=actual.inpaintTextRegions(data,w,h,lines,inPlace,protection);controller.abort();return result;});
    await expect(translateImageInOffscreen('ordinary-alpha-cancel','en','Page',controller.signal)).rejects.toThrow('已取消');
    expect(Array.from(pixels.subarray(offset,offset+4))).toEqual([17,53,191,96]);expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
});

it.each([
    {name:'left',textAlign:'left' as const},{name:'right',textAlign:'right' as const},
    {name:'center',textAlign:'center' as const},{name:'vertical-middle',vertical:true as const},
])('alpha预检按原$name对齐和middle基线验证，负bearing及空行不误丢译文',async options=>{
    ordinaryFitFixture(undefined,options,'AB\n\nCD');
    const result=await translateImageInOffscreen('alpha-bearing','en','Page');
    expect(result.image).toBeTruthy();expect(mocks.draw).toHaveBeenCalledOnce();
    const prepared=mocks.draw.mock.calls[0][9];expect(prepared.lines).toEqual(['AB','','CD']);
    expect(mocks.draw.mock.calls[0][8]).toBe('vertical' in options?'center':options.textAlign);
    expect(canvases[0].context.textBaseline).toBe('middle');
});

it('alpha只校验孔确实改变的行，prepared复用后未受影响行仍用原绘字参数',async()=>{
    const pixels=opaqueAlphaPixels(200,150);pixels.set([17,53,191,96],(30*200+62)*4);ordinaryAlphaCanvas(200,150,pixels);
    mocks.recognize.mockResolvedValueOnce([{text:'FIRST',bbox:{x0:20,y0:20,x1:180,y1:50},fontSize:30},{text:'SECOND',bbox:{x0:20,y0:100,x1:180,y1:130},fontSize:30}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['AB','CD']}:undefined));
    const rendering=await import('@/src/features/image-translation/services/rendering');
    const original=await vi.importActual<typeof rendering>('@/src/features/image-translation/services/rendering');
    const layout=vi.spyOn(rendering,'layoutImageTranslationText').mockImplementation(original.layoutImageTranslationText);
    await translateImageInOffscreen('alpha-unchanged-bounds','en','Page');
    expect(layout).toHaveBeenCalledOnce();expect(mocks.draw.mock.calls[0]).toHaveLength(10);expect(mocks.draw.mock.calls[1]).toHaveLength(9);
});

it('面积更大的400×6细带不能只凭完整metadata放行，实际字形不fit时保留完整文本',async()=>{
    const pixels=opaqueAlphaPixels(450,60);
    for(let y=12;y<54;y++)for(let x=20;x<412;x++)pixels.set([0,0,0,0],(y*450+x)*4);
    ordinaryAlphaCanvas(450,60,pixels,canvas=>{
        const native=canvas.context.measureText.getMockImplementation()!;
        canvas.context.measureText.mockImplementation(text=>({...native(text),actualBoundingBoxAscent:6,actualBoundingBoxDescent:6}));
    });
    mocks.recognize.mockResolvedValueOnce([{text:'ORIGINAL',bbox:{x0:10,y0:10,x1:410,y1:50},fontSize:20}]);
    const rendering=await import('@/src/features/image-translation/services/rendering'),original=await vi.importActual<typeof rendering>('@/src/features/image-translation/services/rendering');
    const layout=vi.spyOn(rendering,'layoutImageTranslationText').mockImplementation(original.layoutImageTranslationText);
    const result=await translateImageInOffscreen('alpha-thin-strip','en','Page');
    expect(layout).toHaveBeenCalledOnce();expect(layout.mock.calls[0][1]).toBe(400);expect(layout.mock.calls[0][2]).toBe(5.4);
    expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'ORIGINAL',text:'你好',renderSkipped:true}]});
    expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
});

it.each([
    {name:'missing metrics',change:{actualBoundingBoxAscent:NaN}},
    {name:'inverted horizontal ink',change:{actualBoundingBoxLeft:-20,actualBoundingBoxRight:10}},
    {name:'inverted vertical ink',change:{actualBoundingBoxAscent:-20,actualBoundingBoxDescent:10}},
    {name:'advance over width',change:{width:1000}},
    {name:'left overhang',change:{actualBoundingBoxLeft:200}},
    {name:'right overhang',change:{actualBoundingBoxRight:200}},
    {name:'top overhang',change:{actualBoundingBoxAscent:200}},
    {name:'bottom overhang',change:{actualBoundingBoxDescent:200}},
])('alpha $name 明确回退原图和全译文，不发布裁切glyph',async({change})=>{
    ordinaryFitFixture(canvas=>{
        const native=canvas.context.measureText.getMockImplementation()!;
        canvas.context.measureText.mockImplementation(text=>({...native(text),...change}));
    });
    const rendering=await import('@/src/features/image-translation/services/rendering');
    vi.spyOn(rendering,'layoutImageTranslationText').mockReturnValue({lines:['FIT'],fontSize:10,lineHeight:12});
    const result=await translateImageInOffscreen('alpha-ink-failed','en','Page');
    expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'ORIGINAL',text:'FIT',renderSkipped:true}]});
    expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
});
it.each([
    {name:'empty layout',layout:{lines:[],fontSize:10,lineHeight:12}},
    {name:'nonfinite font',layout:{lines:['FIT'],fontSize:NaN,lineHeight:12}},
    {name:'zero font',layout:{lines:['FIT'],fontSize:0,lineHeight:0}},
    {name:'nonfinite line height',layout:{lines:['FIT'],fontSize:10,lineHeight:NaN}},
    {name:'rows exceed height',layout:{lines:['FIT','FIT','FIT','FIT'],fontSize:10,lineHeight:12}},
])('alpha $name 不以layout best元数据当作fit证明',async({layout})=>{
    ordinaryFitFixture();const rendering=await import('@/src/features/image-translation/services/rendering');
    vi.spyOn(rendering,'layoutImageTranslationText').mockReturnValue(layout);
    await expect(translateImageInOffscreen('alpha-layout-failed','en','Page')).resolves.toMatchObject({image:'',imageUnchanged:true,lines:[{text:'FIT',renderSkipped:true}]});
    expect(mocks.encode).not.toHaveBeenCalled();
});
it.each([true,false])('alpha已知限额和未知异常均保持取消/传播优先，cancel=%s',async cancel=>{
    const controller=new AbortController();ordinaryFitFixture();
    const alpha=await import('@/src/features/image-translation/services/mangaAlphaProtection');
    const error=cancel?new alpha.MangaAlphaProtectionLimitError('limit'):new Error('unexpected alpha failure');
    vi.spyOn(alpha,'mangaAlphaClearRects').mockImplementation(()=>{if(cancel)queueMicrotask(()=>controller.abort());throw error;});
    const result=translateImageInOffscreen('alpha-failure-priority','en','Page',controller.signal);
    if(cancel)await expect(result).rejects.toThrow('已取消');else await expect(result).rejects.toBe(error);
    expect(mocks.encode).not.toHaveBeenCalled();expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
});

describe('Offscreen 图片完整操作生命周期', () => {
    it('漫画绘制拒绝后不编码或返回部分图块，并释放原图与画布',async()=>{
        const error=new Error('漫画透明图案遮挡译文区域，已保留原图');
        mocks.mangaRecognize.mockResolvedValueOnce(lines);
        mocks.repair.mockImplementationOnce(async pixels=>pixels);
        mocks.mangaDraw.mockImplementationOnce(()=>{throw error;});
        await expect(translateImageInOffscreen('manga','en','Page',undefined,'manga-flow-failed',true)).rejects.toBe(error);
        expect(mocks.mangaDraw).toHaveBeenCalledOnce();expect(mocks.encode).not.toHaveBeenCalled();
        expect(canvases).toHaveLength(1);expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
        expect(images).toHaveLength(1);expect(images[0].src).toBe('');
    });
    it.each(['ru-RU', 'ko'])('漫画 %s 采用已有 Tesseract，清字、排版和局部结果仍使用漫画链路', async sourceLanguage => {
        if (sourceLanguage === 'ko') imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        const controller = new AbortController();
        mocks.repair.mockImplementationOnce(async pixels => pixels);
        const result = await translateImageInOffscreen('manga', sourceLanguage, 'Page', controller.signal, 'language-manga', true, 'paddle');
        expect(mocks.recognize).toHaveBeenCalledWith('manga', sourceLanguage, controller.signal, expect.objectContaining({decodedImage: images[0]}));
        expect(mocks.mangaRecognize).not.toHaveBeenCalled();expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
        expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.mangaDraw).toHaveBeenCalledOnce();
        expect(mocks.repair.mock.calls[0][3][0]).toMatchObject({fontSize: 10, sourceBoxes: [lines[0].bbox]});
        expect(result.image).toBe('');expect(result.mangaPatches).toMatchObject({width: 32, height: 16});
        expect(result.lines[0]).toMatchObject({sourceText: 'Hello', text: '你好'});
        expect(images[0].src).toBe('');expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
    it('单图选择 PaddleOCR 只替换识别引擎，仍返回完整译图与文本，不启动漫画修补', async () => {
        mocks.mangaRecognize.mockResolvedValue(lines);
        const result=await translateImageInOffscreen('image','en','Page',undefined,'single-paddle',false,'paddle');
        expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.mangaRecognize).toHaveBeenCalled();
        expect(result.image).toBe('data:image/png;base64,translated');expect(result.mangaPatches).toBeUndefined();
        expect(result.lines[0].sourceText).toBe('Hello');expect(mocks.repair).not.toHaveBeenCalled();
    });

    it('漫画整段识别走专用模型与局部修补，保留对照并报告准备阶段',async()=>{
        const regions=[{...lines[0],fontSize:10,sourceBoxes:[lines[0].bbox]}];
        mocks.mangaRecognize.mockImplementationOnce(async(_image,_language,_w,_h,_signal,progress)=>{progress('preparing',23);progress('recognizing');return regions;});
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_lines,_signal,onPreparing,onRepair)=>{onPreparing();onPreparing(undefined,true);onRepair(1,2);return pixels;});
        const result=await translateImageInOffscreen('manga','en','Page',undefined,'manga-page',true);
        expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
        expect(mocks.mangaDraw).toHaveBeenCalledWith(canvases[0].context,expect.any(Uint8ClampedArray),32,16,[expect.objectContaining({text:'你好',sourceBoxes:regions[0].sourceBoxes})],true,[{color:'rgb(255,255,255)',uniform:false}],undefined);
        expect(mocks.sampleManga.mock.invocationCallOrder[0]).toBeLessThan(mocks.repair.mock.invocationCallOrder[0]);
        expect(mocks.repair.mock.calls[0][7]).toBe(mocks.mangaDraw.mock.calls[0][6]);
        expect(result.lines[0]).toMatchObject({text:'你好',sourceText:'Hello'});
        expect(mocks.encode).toHaveBeenCalledWith(canvases[1],undefined);
        expect(result.image).toBe(''); expect(result.mangaPatches).toMatchObject({width:32,height:16,patches:[{x:1,y:1,width:30,height:14}]});
        expect(canvases[1].context.drawImage).toHaveBeenCalledWith(canvases[0],1,1,30,14,0,0,30,14);expect(canvases[0].toDataURL).not.toHaveBeenCalled();
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageProgress').map(([m])=>m.stage)).toEqual(['preparing','recognizing','translating','cleaning','preparing','initializing','cleaning','rendering']);
        expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadImageProgress',requestId:'manga-page',stage:'cleaning',progress:50},expect.any(Function));
        expect(images[0].src).toBe('');expect(canvases[0].width).toBe(0);
    });
    it('漫画在原像素拷回前冻结同一保护计划，修补与所有绘字共用而不重新推断',async()=>{
        ordinaryAlphaCanvas(32,16,new Uint8ClampedArray(32*16*4));
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        const protection=Object.freeze({originalPixels:true});
        let source:Uint8ClampedArray|undefined;
        mocks.alphaProtection.mockImplementationOnce((pixels,width,height,regions)=>{
            expect([width,height]).toEqual([32,16]);expect(regions[0].text).toBe('你好');
            expect(pixels[0]).toBe(0);source=pixels;return protection;
        });
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_regions,_signal,_preparing,_repair,_backgrounds,options)=>{
            expect(pixels).toBe(source);expect(options.protection).toBe(protection);
            return new Uint8ClampedArray(pixels.length).fill(31);
        });
        await translateImageInOffscreen('manga','en','Page',undefined,'shared-protection',true);
        expect(mocks.alphaProtection).toHaveBeenCalledOnce();
        expect(mocks.alphaProtection.mock.invocationCallOrder[0]).toBeLessThan(mocks.repair.mock.invocationCallOrder[0]);
        expect(mocks.mangaDraw.mock.calls[0][1]).toBe(source);expect(source![0]).toBe(31);
        expect(mocks.mangaDraw.mock.calls[0][7]).toBe(protection);
    });
    it('保护计划失败时不启动模型或发布部分译图，并清理原图和画布',async()=>{
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        mocks.alphaProtection.mockImplementationOnce(()=>{throw new Error('透明孔保护超出预算');});
        await expect(translateImageInOffscreen('manga','en','Page',undefined,'protection-failed',true)).rejects.toThrow('透明孔保护超出预算');
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it('漫画修补完成后取消，不能编码或返回迟到译图',async()=>{
        const controller=new AbortController();mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        mocks.repair.mockImplementationOnce(async pixels=>{controller.abort();return pixels;});
        await expect(translateImageInOffscreen('manga','en','',controller.signal,'cancel-manga',true)).rejects.toThrow('已取消');
        expect(canvases[0].toDataURL).not.toHaveBeenCalled();expect(images[0].src).toBe('');
    });
    it.each([true,false])('漫画独占ImageData启用均匀复用，仅独立修补结果需要拷回：%s',async reuse=>{
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        const input=new Uint8ClampedArray(32*16*4).fill(91),set=vi.spyOn(input,'set');
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();if(canvases.length===1)canvas.context.getImageData.mockReturnValue({data:input});return canvas;
        })});
        mocks.sampleManga.mockReturnValue([{color:'rgb(255,255,255)',uniform:reuse}]);
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_regions,_signal,_preparing,_repair,backgrounds,options)=>{
            expect(pixels).toBe(input);expect(backgrounds[0].uniform).toBe(reuse);expect(options).toEqual({reuseUniformPixels:true,protection:undefined});
            if(reuse)return pixels;const result=new Uint8ClampedArray(pixels);result[0]=173;return result;
        });
        await translateImageInOffscreen('manga','en','',undefined,'owned-pixels',true);
        expect(set).toHaveBeenCalledTimes(reuse?0:1);expect(input[0]).toBe(reuse?91:173);
        expect(mocks.mangaDraw.mock.calls[0][1]).toBe(input);
        expect(canvases[0].context.putImageData).toHaveBeenCalledOnce();expect(canvases[0].context.putImageData).toHaveBeenCalledWith({data:input},0,0);
        expect(mocks.encode).toHaveBeenCalledOnce();expect(images[0].src).toBe('');expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it.each([false, true])('漫画进度按请求所有权投递，解码宽高可安全回退，带信号=%s', async withSignal => {
        imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        const controller = new AbortController();let notify!: (stage: string, progress?: number) => void;
        mocks.mangaRecognize.mockImplementationOnce(async (_image, _language, width, height, _signal, progress) => {
            expect([width, height]).toEqual([32, 16]);notify = progress;notify('recognizing', 37);
            return [{...lines[0], fontSize: 10}];
        });
        mocks.repair.mockImplementationOnce(async pixels => pixels);
        await translateImageInOffscreen('manga', 'en', '', withSignal ? controller.signal : undefined, 'manga-progress', true);
        const calls = sendMessage.mock.calls.length;controller.abort();notify('recognizing', 98);
        expect(sendMessage).toHaveBeenCalledTimes(calls + (withSignal ? 0 : 1));
    });
    it.each([false, true])('OCR 百分比只在请求仍有效时发出，带取消信号=%s', async withSignal => {
        const controller = new AbortController(); let notify!: (percent: number) => void;
        mocks.recognize.mockImplementationOnce(async (_image, _source, _signal, options) => {
            notify = options.onProgress; notify(37); return lines;
        });
        await translateImageInOffscreen('image','en','Page',withSignal ? controller.signal : undefined,'progress');
        expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadImageProgress',requestId:'progress',stage:'recognizing',progress:37},expect.any(Function));
        if (withSignal) {
            const calls = sendMessage.mock.calls.length; controller.abort(); notify(98);
            expect(sendMessage).toHaveBeenCalledTimes(calls);
        }
    });

    it('预检和渲染复用同一次解码，阶段通知、完整译文与原尺寸一致并释放资源', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const result = await translateImageInOffscreen('original-image', 'en', 'Page', controller.signal, 'image-1');
        expect(result).toEqual({image: 'data:image/png;base64,translated', lines: [{...lines[0], text: '你好', sourceText: 'Hello', backgroundColor: 'transparent'}]});
        expect(images).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledWith('original-image', 'en', controller.signal, {decodedImage:images[0], includeMangaNumericConfidence:true, onProgress:expect.any(Function)});
        expect(canvases[0].context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 32, 16);
        expect(mocks.background).toHaveBeenCalledOnce();
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageProgress').map(([message]) => message.stage))
            .toEqual(['recognizing', 'translating', 'rendering']);
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
        expect(canvases[0].width).toBe(0);
        expect(canvases[0].height).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it.each([[4097, 4096], [8193, 1]])('超预算 %i×%i 图片在 OCR 和翻译前失败', async (width, height) => {
        imageOptions.push({width, height});
        await expect(translateImageInOffscreen('oversized', 'en', 'Page', undefined, 'large')).rejects.toThrow('图片过大');
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(canvases).toHaveLength(0);
        expect(images[0].src).toBe('');
    });

    it('竖排区域只留最小边距，普通横排不按段落总高外扩 (#654)', async () => {
        imageOptions.push({width: 900, height: 700});
        mocks.recognize.mockResolvedValueOnce([
            {text: '第三話', bbox: {x0: 60, y0: 50, x1: 320, y1: 90}},
            {text: '今日は本当に楽しかったね。', bbox: {x0: 598, y0: 101, x1: 762, y1: 290}, vertical: true},
        ]);
        sendMessage.mockImplementation((message, callback) => {
            callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['第三话', '今天真的很开心。']} : undefined);
        });
        const result = await translateImageInOffscreen('manga', 'ja', 'Page');
        expect(result.lines[1]).toMatchObject({text: '今天真的很开心。', vertical: true});
        expect(mocks.draw).toHaveBeenNthCalledWith(1, expect.anything(), '第三话', 58, 43, 264, 54, 'rgb(240,240,240)', 48, 'left');
        expect(mocks.draw).toHaveBeenNthCalledWith(2, expect.anything(), '今天真的很开心。', 595, 99, 170, 193, 'rgb(240,240,240)', Infinity, 'center');
    });

    it.each(['tesseract', 'paddle'] as const)('%s 普通图片将跨行说明整段送翻译，擦除和字号保持源行粒度', async engine => {
        imageOptions.push({width: 390, height: 300});
        const source = [
            {text: 'Calculate the best filament grouping to minimize', bbox: {x0: 61, y0: 78, x1: 325, y1: 90}},
            {text: 'filament waste. Need to manually place filaments on the', bbox: {x0: 61, y0: 92, x1: 367, y1: 104}},
            {text: 'printer based on slicing results.', bbox: {x0: 62, y0: 106, x1: 227, y1: 118}},
        ];
        mocks.recognize.mockResolvedValue(source); mocks.mangaRecognize.mockResolvedValue(source);
        const result = await translateImageInOffscreen('bambu', 'en', 'Bambu', undefined, 'paragraph', false, engine);
        const request = sendMessage.mock.calls.find(([m]) => m.type === 'fluentReadImageTranslateTexts')![0];
        expect(request.texts).toEqual([source.map(line => line.text).join(' ')]);
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].sourceText).toBe(request.texts[0]);
        expect(mocks.inpaint.mock.calls[0][3][0].sourceBoxes).toEqual(source.map(line => line.bbox));
        expect(mocks.draw).toHaveBeenCalledWith(expect.anything(), '你好', 59, 76, 310, 44, 'rgb(240,240,240)', 12 * 1.2, 'left');
        if (engine === 'paddle') expect(mocks.mangaRecognize.mock.calls[0][7]).toBe('image');
    });

    it('Paddle 单图竖排列整段翻译一次，清字仍仅传入原始列框', async () => {
        imageOptions.push({width: 240, height: 200});
        const right = {text: '今日は', bbox: {x0: 90, y0: 20, x1: 102, y1: 120}, vertical: true as const};
        const left = {text: '楽しかった。', bbox: {x0: 76, y0: 21, x1: 88, y1: 120}, vertical: true as const};
        mocks.mangaRecognize.mockResolvedValue([left, right]);
        sendMessage.mockImplementation((message, callback) => callback(message.type === 'fluentReadImageTranslateTexts'
            ? {success: true, translations: ['今天玩得很开心。']} : undefined));
        const result = await translateImageInOffscreen('vertical', 'ja', 'Page', undefined, 'vertical-image', false, 'paddle');
        expect(sendMessage.mock.calls.find(([message]) => message.type === 'fluentReadImageTranslateTexts')![0].texts)
            .toEqual(['今日は楽しかった。']);
        expect(mocks.inpaint.mock.calls[0][3][0]).toMatchObject({sourceBoxes: [right.bbox, left.bbox], fontSize: 12, vertical: true});
        expect(result.lines).toMatchObject([{text: '今天玩得很开心。', sourceText: '今日は楽しかった。'}]);
        expect(mocks.repair).not.toHaveBeenCalled();
    });

    it('允许预算边界图像继续 OCR，natural 尺寸不可用时使用已解码尺寸', async () => {
        imageOptions.push({width: 4096, height: 4096});
        mocks.recognize.mockRejectedValueOnce(new Error('OCR reached'));
        await expect(translateImageInOffscreen('boundary', 'en', '')).rejects.toThrow('OCR reached');
        expect(mocks.recognize).toHaveBeenCalledOnce();
        imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        await expect(translateImageInOffscreen('fallback-size', 'en', '')).resolves.toHaveProperty('image');
    });

    it.each([[0, 16], [32, 0], [NaN, 16], [32, 1.5]])('拒绝无效尺寸 %s×%s 并释放图像', async (width, height) => {
        imageOptions.push({width, height});
        await expect(translateImageInOffscreen('invalid', 'en', '')).rejects.toThrow('图片尺寸无效');
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('已取消请求不开始解码，解码中取消会清理监听并忽略迟到事件', async () => {
        const preCancelled = new AbortController();
        preCancelled.abort();
        await expect(translateImageInOffscreen('unused', 'en', '', preCancelled.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(images).toHaveLength(0);

        imageOptions.push({mode: 'pending'});
        const controller = new AbortController();
        const operation = translateImageInOffscreen('pending', 'en', '', controller.signal);
        const rejection = expect(operation).rejects.toMatchObject({name: 'AbortError'});
        const lateLoad = images[0].onload!;
        const lateError = images[0].onerror!;
        controller.abort();
        lateLoad();
        lateError();
        await rejection;
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('解码没有事件时按预算超时，清除计时器并终止图片加载', async () => {
        vi.useFakeTimers();
        imageOptions.push({mode: 'pending'});
        const operation = translateImageInOffscreen('pending', 'en', '');
        const rejection = expect(operation).rejects.toThrow('图片解码超时');
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
    });

    it.each(['error', 'throw'] as const)('解码 %s 路径失败也会清理图像', async mode => {
        imageOptions.push({mode});
        await expect(translateImageInOffscreen('broken', 'en', '')).rejects.toThrow('图片数据无法解码');
        expect(images[0].src).toBe('');
        expect(images[0].onerror).toBeNull();
    });

    it.each([{translations: []}, {translations: ['   ']}])('空缺译文保留原文供核对，不擦除文字或绘制空白 %j', async ({translations}) => {
        sendMessage.mockImplementation((_, callback) => callback({success: true, translations}));
        const result = await translateImageInOffscreen('unchanged', 'en', '');
        expect(result.lines).toEqual([{...lines[0], sourceText: 'Hello', backgroundColor: 'transparent'}]);
        expect(canvases).toHaveLength(0);
    });

    it.each(['tesseract','paddle'] as const)('普通图片 %s 真正空识别时保留原图，不翻译、修补、绘制或分配 Canvas，且释放源图', async engine => {
        const recognize=engine==='paddle'?mocks.mangaRecognize:mocks.recognize;
        recognize.mockResolvedValueOnce([]);
        await expect(translateImageInOffscreen('empty', 'en', '',undefined,undefined,false,engine)).resolves.toEqual({image:'',imageUnchanged:true,lines:[]});
        expect(recognize).toHaveBeenCalledOnce();
        if(engine==='paddle') {
            expect(recognize.mock.calls[0][7]).toBe('image');expect(mocks.recognize).not.toHaveBeenCalled();
        } else expect(mocks.mangaRecognize).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();
        expect(mocks.draw).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
        expect(canvases).toHaveLength(0);expect(images).toHaveLength(1);
        expect(images[0].src).toBe('');expect(images[0].onload).toBeNull();expect(images[0].onerror).toBeNull();
    });

    it('原样译文仍返回可复制原文且不分配 Canvas', async () => {
        sendMessage.mockImplementation((_, callback) => callback({success: true, translations: ['Hello']}));
        await expect(translateImageInOffscreen('unchanged', 'en', '')).resolves.toEqual({image: '', imageUnchanged: true, lines: [{...lines[0], sourceText: 'Hello', backgroundColor: 'transparent'}]});
        expect(canvases).toHaveLength(0);
        expect(images.every(image => image.src === '')).toBe(true);
    });

    it('漫画没有检测到文字时保留原图，不发送翻译请求，也不创建译图或修补', async () => {
        mocks.mangaRecognize.mockResolvedValueOnce([]);
        await expect(translateImageInOffscreen('no-text','ja','',undefined,undefined,true)).resolves.toEqual({image:'no-text',lines:[]});
        expect(sendMessage).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);expect(mocks.repair).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
    });
    it.each([false, true])('漫画已识别但译文无需变化时只返回轻量结果，尺寸回退=%s', async fallback => {
        if (fallback) imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        mocks.mangaRecognize.mockResolvedValueOnce(lines);
        sendMessage.mockImplementation((message, callback) => callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['Hello']} : undefined));
        const result = await translateImageInOffscreen('same-text', 'en', '', undefined, 'unchanged', true);
        expect(result).toMatchObject({image: '', mangaPatches: {width: 32, height: 16, patches: []}, lines: [{sourceText: 'Hello', text: 'Hello'}]});
        expect(canvases).toHaveLength(0);expect(mocks.repair).not.toHaveBeenCalled();expect(images[0].src).toBe('');
    });
    it('漫画局部画布无法创建上下文时不返回半成品并释放所有图像', async () => {
        mocks.mangaRecognize.mockResolvedValueOnce(lines);mocks.repair.mockImplementationOnce(async pixels => pixels);
        vi.stubGlobal('document', {createElement: () => {
            const canvas = makeCanvas();if (canvases.length === 2) canvas.getContext.mockReturnValue(null);return canvas;
        }});
        await expect(translateImageInOffscreen('patch-failed', 'en', '', undefined, 'patch-failed', true)).rejects.toThrow('浏览器不支持图片处理');
        expect(canvases).toHaveLength(2);expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(images[0].src).toBe('');expect(mocks.encode).not.toHaveBeenCalled();
    });
    it('文字翻译失败原因穿过 Offscreen 文本客户端', async () => {
        sendMessage.mockImplementation((_message,callback)=>callback({success:false,error:'model not ready',errorCode:'notDownloaded'}));
        await expect(translateImageTextsInExtension(['Hello'],'Page','model-error')).rejects.toMatchObject({errorCode:'notDownloaded'});
    });

    it('OCR 返回时已取消，不再发送翻译请求', async () => {
        const controller = new AbortController();
        mocks.recognize.mockImplementation(async () => {controller.abort(); return lines;});
        await expect(translateImageInOffscreen('image', 'en', '', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
    });

    it('翻译等待中取消通知后台，迟到译文不会生成图片', async () => {
        const controller = new AbortController();
        let complete!: (result: unknown) => void;
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageTranslateTexts') complete = callback;
            else callback();
        });
        const operation = translateImageInOffscreen('image', 'en', '', controller.signal, 'cancel-text');
        const rejection = expect(operation).rejects.toMatchObject({name: 'AbortError'});
        await flushMicrotasks();
        controller.abort();
        complete({success: true, translations: ['迟到的译文']});
        await rejection;
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageCancel')).toEqual([
            [{type: 'fluentReadImageCancel', requestId: 'cancel-text'}, expect.any(Function)],
        ]);
        expect(canvases).toHaveLength(0);
        expect(images[0].src).toBe('');
    });

    it.each(['render-stage', 'pixel-read', 'inpainting', 'draw-event', 'encoding'] as const)(
        '取消发生在 %s 时不返回生成结果并释放 Canvas', async stage => {
            const controller = new AbortController();
            if (stage === 'render-stage') sendMessage.mockImplementation((message, callback) => {
                if (message.stage === 'rendering') controller.abort();
                callback({success: true, translations: ['你好']});
            });
            if (stage === 'inpainting') mocks.inpaint.mockImplementation(pixels => {controller.abort(); return pixels;});
            if (stage === 'draw-event') mocks.draw.mockImplementation(() => {setTimeout(() => controller.abort(), 0);});
            if (stage === 'encoding') mocks.encode.mockImplementationOnce(async () => {controller.abort(); return 'cancelled-image';});
            if (stage === 'pixel-read') vi.stubGlobal('document', {createElement: () => {
                const canvas = makeCanvas();
                canvas.context.getImageData.mockImplementation(() => {
                    controller.abort(); return {data: new Uint8ClampedArray(32 * 16 * 4)};
                });
                return canvas;
            }});
            await expect(translateImageInOffscreen('image', 'en', '', controller.signal, 'cancel-render')).rejects.toMatchObject({name: 'AbortError'});
            expect(images[0].src).toBe('');
            expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
            if (stage !== 'encoding') expect(mocks.encode).not.toHaveBeenCalled();
            expect(canvases.every(canvas => canvas.toDataURL.mock.calls.length === 0)).toBe(true);
        },
    );

    it('Canvas 不可用时仍清理原图和分配的画布', async () => {
        nullContext = true;
        await expect(translateImageInOffscreen('image', 'en', '')).rejects.toThrow('浏览器不支持图片处理');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });

    it('进度消息发送失败不阻断主链，编码失败也会释放资源', async () => {
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageProgress') throw new Error('page closed');
            callback({success: true, translations: ['你好']});
        });
        mocks.encode.mockRejectedValueOnce(new Error('encode failed'));
        await expect(translateImageInOffscreen('image', 'en', '', undefined, 'progress')).rejects.toThrow('encode failed');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });

    it('普通图片复用独占像素，等待异步编码时保留画布，完成后释放', async () => {
        let finish!: (value: string) => void;
        let started!: () => void;
        const encoding = new Promise<void>(resolve => {started = resolve;});
        mocks.encode.mockImplementationOnce(() => new Promise<string>(resolve => {finish = resolve; started();}));
        const operation = translateImageInOffscreen('image', 'en', '');
        await encoding;
        const canvas = canvases[0];
        const source = canvas.context.getImageData.mock.results[0].value;
        expect(mocks.inpaint).toHaveBeenCalledWith(source.data, 32, 16, expect.any(Array), true);
        expect(canvas.context.putImageData).toHaveBeenCalledWith(source, 0, 0);
        expect(canvas.width).toBe(32);
        expect(mocks.encode).toHaveBeenCalledWith(canvas, undefined);
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        finish('encoded-image');
        await expect(operation).resolves.toHaveProperty('image', 'encoded-image');
        expect([canvas.width, canvas.height]).toEqual([0, 0]);
    });
});

describe('Offscreen 圈选裁剪生命周期', () => {
    it.each([false, true])('圈选 OCR=%s 等待可取消的异步 PNG，不同步压缩或提前开始识别', async withOcr => {
        imageOptions.push({width: 40, height: 20});
        let complete!: (image: string) => void;
        mocks.encode.mockImplementationOnce(() => new Promise<string>(resolve => {complete = resolve;}));
        const controller = new AbortController();
        const operation = withOcr ? translateAreaInOffscreen('image', 'en', '', selection, controller.signal)
            : cropAreaInOffscreen('image', selection, controller.signal);
        const outcome = operation.then(result => ({result}), error => ({error}));
        await flushMicrotasks();
        expect(mocks.encode).toHaveBeenCalledWith(canvases[0], controller.signal);
        expect(canvases[0].toDataURL).not.toHaveBeenCalled();
        expect([canvases[0].width, canvases[0].height]).toEqual([20, 10]);
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
        controller.abort(); complete('late-encoded-crop');
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect([canvases[0].width, canvases[0].height]).toEqual([0, 0]);
    });
    it('crop-only 不调用 OCR，并在取消时释放图像与画布', async () => {
        imageOptions.push({width: 40, height: 20, naturalWidth: 40, naturalHeight: 20});
        const result = await cropAreaInOffscreen('image', selection);
        expect(result).toEqual({image: 'data:image/png;base64,translated', lines: []});
        expect(mocks.recognize).not.toHaveBeenCalled();
        const controller = new AbortController(); controller.abort();
        await expect(cropAreaInOffscreen('image', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
    it('圈选只裁剪和本地OCR，保留原图原文且从不重绘或调用图片翻译RPC', async () => {
        imageOptions.push({width: 40, height: 20, naturalWidth: 0, naturalHeight: 0}, {width: 20, height: 10});
        await expect(translateAreaInOffscreen('screenshot', 'en', '', selection)).resolves.toHaveProperty('image');
        expect(images).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledWith('data:image/png;base64,translated', 'en', undefined, {profile: 'area'});
        expect(mocks.inpaint).not.toHaveBeenCalled();
        expect(mocks.draw).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(canvases[0].context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 20, 10, 0, 0, 20, 10);
        expect(images.every(image => image.src === '')).toBe(true);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });

    it('无OCR结果与识别中取消均不返回迟到文本', async () => {
        mocks.recognize.mockResolvedValueOnce([]);
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('没有识别到圈选区域文字');
        const controller = new AbortController();
        mocks.recognize.mockImplementationOnce(async () => {controller.abort(); return lines;});
        await expect(translateAreaInOffscreen('image', 'en', '', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('裁剪 Canvas 不可用时释放截图且不开始 OCR', async () => {
        nullContext = true;
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('浏览器不支持区域截图处理');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('裁剪画布创建异常也会释放已解码截图', async () => {
        vi.stubGlobal('document', {createElement: () => {throw new Error('canvas allocation failed');}});
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('canvas allocation failed');
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it.each(['draw', 'encode'] as const)('裁剪 %s 时取消不继续识别', async stage => {
        const controller = new AbortController();
        vi.stubGlobal('document', {createElement: () => {
            const canvas = makeCanvas();
            if (stage === 'draw') canvas.context.drawImage.mockImplementation(() => controller.abort());
            else mocks.encode.mockImplementationOnce(async () => {controller.abort(); return 'cancelled-crop';});
            return canvas;
        }});
        await expect(translateAreaInOffscreen('image', 'en', '', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });
});

describe('Offscreen 图片文本 RPC 预算', () => {
    it('没有请求 ID 时生成独立请求标识，已取消请求只通知取消', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(translateImageTextsInExtension(['text'], '', undefined, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'fluentReadImageCancel', requestId: expect.stringContaining('legacy-image-text-')}), expect.any(Function));
    });

    it('后台没有回调时本地预算超时并通知取消，迟到回调不重复完成', async () => {
        vi.useFakeTimers();
        let complete!: (result: unknown) => void;
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageTranslateTexts') complete = callback;
            else callback();
        });
        const operation = translateImageTextsInExtension(['text'], '', 'timeout');
        const rejection = expect(operation).rejects.toThrow('图片文字翻译超时');
        await vi.advanceTimersByTimeAsync(120_000);
        complete({success: true, translations: ['迟到']});
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageCancel')).toHaveLength(1);
    });

    it('runtime 错误、同步发送异常和取消通知失败均不留下挂起请求', async () => {
        runtime.lastError = {message: 'runtime error'};
        await expect(translateImageTextsInExtension(['text'], '', 'runtime')).rejects.toThrow('runtime error');
        runtime.lastError = undefined;
        sendMessage.mockImplementation(() => {throw new Error('context destroyed');});
        await expect(translateImageTextsInExtension(['text'], '', 'throw')).rejects.toThrow('context destroyed');
        const controller = new AbortController();
        controller.abort();
        await expect(translateImageTextsInExtension(['text'], '', 'abort', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it.each([undefined, {success: false, error: 'provider failed'}, {success: true, translations: null}])(
        '拒绝不完整响应 %j', async response => {
            sendMessage.mockImplementation((_, callback) => callback(response));
            await expect(translateImageTextsInExtension(['text'], '', 'response')).rejects.toThrow(response?.error || '图片文字翻译失败');
        },
    );
});

describe('漫画数字证据：保留源文且不发送或重绘独立数字',()=>{
    const numeric={text:'12:34',bbox:{x0:3,y0:7,x1:27,y1:13},numericConfidence:96};
    it.each(['ru','ko'])('纯数字 %s 返回阅读行和空 patches，不访问翻译服务或画布',async language=>{
        mocks.recognize.mockResolvedValueOnce([numeric]);
        const result=await translateImageInOffscreen('numbers',language,'Page',undefined,'numbers-only',true,'paddle');
        expect(mocks.recognize).toHaveBeenCalledWith('numbers',language,undefined,expect.objectContaining({includeMangaNumericConfidence:true}));
        expect(result).toEqual({image:'',mangaPatches:{width:32,height:16,patches:[]},lines:[{text:'12:34',sourceText:'12:34',bbox:numeric.bbox,fontSize:6,sourceBoxes:[numeric.bbox],backgroundColor:'transparent'}]});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it('数字与正文相邻时独立保留，provider 和清字只接收文字行，返回顺序对应原行',async()=>{
        const label={text:'안녕',bbox:{x0:3,y0:1,x1:24,y1:5}};
        mocks.recognize.mockResolvedValueOnce([label,numeric]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('mixed','ko','Page',undefined,'numeric-mixed',true,'paddle');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['안녕']);
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([['안녕','你好'],['12:34','12:34']]);
        expect(result.lines[0]).toMatchObject({renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();
        expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it('数字在文字之前仍按原顺序返回，多个数字均不送 provider',async()=>{
        const first={...numeric,text:'09:15',bbox:{x0:3,y0:0,x1:15,y1:3}};
        const label={text:'안녕',bbox:{x0:3,y0:5,x1:24,y1:8}};
        mocks.recognize.mockResolvedValueOnce([first,label,numeric]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('ordered','ko','Page',undefined,'numeric-order',true,'paddle');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['안녕']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['09:15','안녕','12:34']);
    });
    it('取消后不返回数字阅读结果，也不启动网络和修补',async()=>{
        const controller=new AbortController();mocks.recognize.mockImplementationOnce(async()=>{controller.abort();return [numeric];});
        await expect(translateImageInOffscreen('cancel-numbers','ko','Page',controller.signal,'cancel-numbers',true,'paddle')).rejects.toThrow('已取消');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);expect(mocks.repair).not.toHaveBeenCalled();
    });
});


describe('漫画数字保护的绘制边界',()=>{
    it.each(['ru','ja'])('%s 的相邻修补框与数字相交时只返回可读译文',async language=>{
        const text={text:language==='ru'?'Привет':'こんにちは',bbox:{x0:2,y0:2,x1:11,y1:6},fontSize:4,sourceBoxes:[{x0:2,y0:2,x1:11,y1:6}]};
        const number={text:'12:34',bbox:{x0:12,y0:2,x1:27,y1:6},fontSize:4,sourceBoxes:[{x0:12,y0:2,x1:27,y1:6}]};
        if(language==='ru') mocks.recognize.mockResolvedValueOnce([{...text},{...number,numericConfidence:97}]);
        else mocks.mangaRecognize.mockResolvedValueOnce([text,number]);
        const result=await translateImageInOffscreen('collision',language,'Page',undefined,'collision',true);
        expect(result.lines.map(line=>line.sourceText)).toEqual(expect.arrayContaining([text.text,number.text]));
        expect(result.lines.find(line=>line.sourceText===text.text)).toMatchObject({text:'你好',renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
        expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual([text.text]);
    });
    it('间距足够时只绘制非数字区域',async()=>{
        imageOptions.push({width:100,height:80});
        const text={text:'안녕',bbox:{x0:2,y0:2,x1:25,y1:10}};
        const number={text:'12:34',bbox:{x0:50,y0:40,x1:80,y1:50},numericConfidence:98};
        mocks.recognize.mockResolvedValueOnce([text,number]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('separate','ko','Page',undefined,'separate',true);
        expect(mocks.repair.mock.calls[0][3]).toHaveLength(1);
        expect(mocks.mangaDraw.mock.calls[0][4][0].text).toBe('你好');
        expect(result.lines.every(line=>!line.renderSkipped)).toBe(true);
    });
});


it('相邻数字与远处正文同时存在时，模拟修补像素只触及远处正文',async()=>{
    ordinaryAlphaCanvas(100,80,new Uint8ClampedArray(100*80*4));
    const close={text:'Привет',bbox:{x0:2,y0:2,x1:19,y1:10}};
    const numeric={text:'12:34',bbox:{x0:20,y0:2,x1:40,y1:10},numericConfidence:98};
    const distant={text:'Пока',bbox:{x0:4,y0:50,x1:35,y1:60}};
    mocks.recognize.mockResolvedValueOnce([close,numeric,distant]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','再见']}:undefined));
    let raster:Uint8ClampedArray|undefined;
    mocks.repair.mockImplementationOnce(async(pixels,width,height,regions)=>{
        raster=pixels;for(const region of regions)for(const b of mangaMaskBoxes(region,width,height))
            for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)pixels[(y*width+x)*4]=255;
        return pixels;
    });
    const result=await translateImageInOffscreen('pixel-conflict','ru','Page',undefined,'pixels',true);
    expect(result.lines.find(line=>line.sourceText===close.text)).toMatchObject({renderSkipped:true});
    expect(result.lines.find(line=>line.sourceText===distant.text)).not.toHaveProperty('renderSkipped');
    expect(raster).toBeDefined();
    for(let y=numeric.bbox.y0;y<numeric.bbox.y1;y++)for(let x=numeric.bbox.x0;x<numeric.bbox.x1;x++)
        expect(raster![(y*100+x)*4]).toBe(0);
    expect(raster![(55*100+10)*4]).toBe(255);
});


describe('漫画与普通图片数值保护',()=>{
    const box={x0:50,y0:40,x1:80,y1:50};
    it('密集数值重复框不提前耗尽预算，远处真实修补仍不触及数字像素',async()=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const numbers=Array.from({length:600},(_,i)=>({text:'90%',confidence:.99,
            box:{x:100+(i%30)*20,y:100+Math.floor(i/30)*20,width:10,height:10}}));
        const regions=collectMangaRegions({results:numbers,numericEvidence:numbers},'en',1000,1000,'manga');
        expect(regions).toHaveLength(600);expect(regions.some(line=>line.guardOnly)).toBe(false);
        const bbox={x0:2,y0:2,x1:10,y1:10};
        const label={text:'Hello',bbox,fontSize:8,sourceBoxes:Array.from({length:900},()=>({...bbox}))};
        imageOptions.push({width:1000,height:1000});mocks.mangaRecognize.mockResolvedValueOnce([label,...regions]);
        let pixels:Uint8ClampedArray<ArrayBuffer>|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
            pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);pixels[(5*1000+5)*4]=0;pixels[(105*1000+105)*4]=0;return {data:pixels};
        });return canvas;})});
        const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/mangaInpainting')>('@/src/features/image-translation/services/mangaInpainting');
        mocks.repair.mockImplementationOnce(async(data,width,height,translated)=>{
            for(const region of translated){const patch=actual.createMangaPatch(data,width,height,region);
                actual.applyMangaPatch(data,width,region,patch,new Float32Array(patch.patch.width*patch.patch.height*3).fill(1));}
            return data;
        });
        const result=await translateImageInOffscreen('dense','en','Page',undefined,'dense-numbers',true,'paddle');
        expect(result.lines[0]).toMatchObject({sourceText:'Hello',text:'你好'});expect(result.lines[0]).not.toHaveProperty('renderSkipped');
        expect(mocks.repair).toHaveBeenCalledOnce();expect(pixels![(5*1000+5)*4]).toBe(255);
        expect(pixels![(105*1000+105)*4]).toBe(0);
    });
    it('保护比较预算耗尽时即使数字并不邻近也保守跳过绘制并返回阅读译文',async()=>{
        imageOptions.push({width:100,height:80});
        const bbox={x0:2,y0:2,x1:10,y1:10};
        const text={text:'Hello',bbox,fontSize:8,sourceBoxes:Array.from({length:1001},()=>({...bbox}))};
        const numbers=Array.from({length:1000},(_,index)=>{const x=40+index%50,y=20+Math.floor(index/50);return {text:'90%',bbox:{x0:x,y0:y,x1:x+1,y1:y+1},fontSize:1};});
        mocks.mangaRecognize.mockResolvedValueOnce([text,...numbers]);
        const result=await translateImageInOffscreen('budget','en','Page',undefined,'numeric-budget',true,'paddle');
        expect(result.lines[0]).toMatchObject({sourceText:'Hello',text:'你好',renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it.each(['12/31/2026','31/12/2026','2026年10月28日','10:30 AM','USD 10','+¥100','١٢','١٢:٣٠','۱۲','۱۲:۳۰','02/29/2024','29/02/2024','2024年2月29日','12:30 PM','EUR 1.234,56','−¥100','90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图从 Tesseract 原始单词结果提取 %s 并保护原值',async text=>{
        const {normalizeOcrLineViews}=await import('@/src/features/image-translation/core');
        const raw=[{paragraphs:[{lines:[{text,bbox:box,confidence:99,words:[{text,bbox:box,confidence:99}]}]}]}];
        const recognized=normalizeOcrLineViews(raw).manga;
        expect(recognized).toMatchObject([{text,bbox:box,numericConfidence:99}]);
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce(recognized);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-raw',false,'tesseract');
        expect(result.lines.map(line=>line.text)).toEqual([text]);expect(result).toMatchObject({image:'',imageUnchanged:true});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
    });
    it.each(['12/31/2026','31/12/2026','2026年10月28日','10:30 AM','USD 10','+¥100','١٢','١٢:٣٠','۱۲','۱۲:۳۰','02/29/2024','29/02/2024','2024年2月29日','12:30 PM','EUR 1.234,56','−¥100','42','08:45','$19.99','90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图 Paddle 数值 %s 只读原文，不发翻译和画布',async text=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const recognized=collectMangaRegions({results:[{text,confidence:.99,box:{x:50,y:40,width:30,height:10}}]},'ja',100,80,'image');
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-paddle',false,'paddle');
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([[text,text]]);
        expect(result).toMatchObject({image:'',imageUnchanged:true});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it.each(['12/31/2026','31/12/2026','2026年10月28日','10:30 AM','USD 10','+¥100','١٢','١٢:٣٠','۱۲','۱۲:۳۰','02/29/2024','29/02/2024','2024年2月29日','12:30 PM','EUR 1.234,56','−¥100','1','７','42','08:45','$19.99','90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图 Tesseract 数值 %s 只读原文，不发翻译和画布',async text=>{
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([{text,bbox:box,numericConfidence:99}]);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-tesseract',false,'tesseract');
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([[text,text]]);
        expect(result).toMatchObject({image:'',imageUnchanged:true});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it.each([['12:30 PM',['12',':','30','PM']],['31/12/2026',['31','/','12','/','2026']],['2026年10月28日',['2026','年','10','月','28','日']]])('Tesseract 多词 %s 在漫画和普通图中保留原行且不发送翻译',async(text,parts)=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');let x=2;
        const words=parts.map(part=>{const bbox={x0:x,y0:2,x1:x+8,y1:12};x+=9;return {text:part,bbox,confidence:99};});
        const raw=[{paragraphs:[{lines:[{text,bbox:{x0:2,y0:2,x1:x-1,y1:12},confidence:99,words}]}]}];
        const parsed=normalizeOcrLineViews(raw).manga;const recognized=[...parsed,...collectRawNumericGuards(raw,parsed)];
        expect(recognized.filter(line=>!line.guardOnly)).toMatchObject([{text,numericConfidence:99}]);
        for(const manga of [false,true]){
            imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce(recognized);
            const result=await translateImageInOffscreen('numbers','ko','Page',undefined,`split-${manga}`,manga,'tesseract');
            expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([[text,text]]);
            expect(result.lines[0].numericUncertain).toBeUndefined();
        }
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it.each(['90  %','90\t%','90　%','1  000','1\t000'])('空白形态 %s 保留精确原文且不与邻近正文合段送翻',async text=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        for(const split of [false,true]){
            const parts=text.includes('%')?['90','%']:['1','000'];let x=20;
            const words=split?parts.map(part=>{const bbox={x0:x,y0:2,x1:x+8,y1:12};x+=9;return {text:part,bbox,confidence:99};}):[];
            const number={text,bbox:{x0:20,y0:2,x1:38,y1:12},confidence:99,words},close={text:'SALE',bbox:{x0:2,y0:2,x1:19,y1:12},confidence:99};
            const away={text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60},confidence:99},blocks=[{paragraphs:[{lines:[number,close,away]}]}];
            const parsed=normalizeOcrLineViews(blocks).manga,guards=collectRawNumericGuards(blocks,parsed);
            imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
            sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
            const result=await translateImageInOffscreen('spaces','en','Page',undefined,`spaces-${split}`,false,'tesseract');
            expect(result.lines.find(line=>line.sourceText===text)?.text).toBe(text);
            const calls=sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts');
            expect(calls.at(-1)![0].texts).toEqual(['SALE','Away']);
        }
    });
    it.each(['90  %','90\t%','90　%','1  000','1\t000'])('Paddle 普通图片完整保留 %s，正文仍按原规则规范空白',async text=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const items=[{text,confidence:.99,box:{x:20,y:2,width:18,height:10}},
            {text:'Hello  world',confidence:.99,box:{x:2,y:30,width:60,height:10}}];
        const recognized=collectMangaRegions({results:items},'en',100,80,'image');
        expect(recognized.map(line=>line.text)).toEqual([text,'Hello world']);
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']} :undefined));
        const result=await translateImageInOffscreen('paddle-spaces','en','Page',undefined,'paddle-spaces',false,'paddle');
        expect(result.lines.find(line=>line.sourceText===text)?.text).toBe(text);
        expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Hello world']);
    });
    it.each(['paddle','tesseract'] as const)('漫画 %s 保留数值内部空白且不把其送翻',async engine=>{
        const text='90\t%',bbox={x0:20,y0:2,x1:38,y1:12},close={text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:12}},away={text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60}};
        const lines=[{text,bbox,numericConfidence:99},close,away];imageOptions.push({width:100,height:80});
        if(engine==='paddle'){
            const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
            const items=lines.map(line=>({text:line.text,confidence:.99,box:{x:line.bbox.x0,y:line.bbox.y0,width:line.bbox.x1-line.bbox.x0,height:line.bbox.y1-line.bbox.y0}}));
            mocks.mangaRecognize.mockResolvedValueOnce(collectMangaRegions({results:items},'ja',100,80,'manga'));
        } else mocks.recognize.mockResolvedValueOnce(lines);
        mocks.repair.mockImplementationOnce(async pixels=>pixels);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const result=await translateImageInOffscreen('spaces',engine==='paddle'?'ja':'ko','Page',undefined,`spaces-manga-${engine}`,true,engine);
        expect(result.lines.find(line=>line.sourceText===text)?.text).toBe(text);
        expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Hello','Away']);
    });
    it.each(['paddle','tesseract'] as const)('单图 %s 将邻近冲突对白保留为阅读译文，只对远处正文执行真实修补',async engine=>{
        const close={text:'Close',bbox:{x0:2,y0:2,x1:19,y1:10}};
        const numeric={text:'90%',bbox:{x0:20,y0:2,x1:40,y1:10}};
        const distant={text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60}};
        imageOptions.push({width:100,height:80});
        if(engine==='tesseract')mocks.recognize.mockResolvedValueOnce([close,{...numeric,numericConfidence:99},distant]);
        else {
            const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
            const items=[close,numeric,distant].map(({text,bbox})=>({text,confidence:.99,box:{x:bbox.x0,y:bbox.y0,width:bbox.x1-bbox.x0,height:bbox.y1-bbox.y0}}));
            mocks.mangaRecognize.mockResolvedValueOnce(collectMangaRegions({results:items},'en',100,80,'image'));
        }
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
        let pixels:Uint8ClampedArray<ArrayBuffer>|undefined;let original:Uint8ClampedArray|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
                pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);
                for(let y=2;y<10;y++)for(let x=20;x<40;x++)pixels[(y*100+x)*4]=0;
                for(let y=50;y<60;y++)for(let x=4;x<35;x++)pixels[(y*100+x)*4]=0;
                original=pixels.slice();return {data:pixels};
            });return canvas;
        })});
        mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
        const result=await translateImageInOffscreen('mixed','en','Page',undefined,'collision',false,engine);
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Close','Away']);
        expect(result.lines.find(line=>line.sourceText==='90%')).toMatchObject({text:'90%'});
        expect(result.lines.find(line=>line.sourceText==='Close')).toMatchObject({text:'近',renderSkipped:true});
        expect(result.lines.find(line=>line.sourceText==='Away')).toMatchObject({text:'远'});
        expect(mocks.inpaint.mock.calls[0][3]).toHaveLength(1);expect(mocks.inpaint.mock.calls[0][3][0].text).toBe('远');
        expect(mocks.draw).toHaveBeenCalledOnce();expect(pixels).toBeDefined();
        for(let y=2;y<10;y++)for(let x=20;x<40;x++) {const i=(y*100+x)*4;expect(pixels!.slice(i,i+4)).toEqual(original!.slice(i,i+4));}
        expect(pixels![(55*100+10)*4]).not.toBe(original![(55*100+10)*4]);
    });
});


describe('Tesseract 数值重叠提示',()=>{
    it.each([false,true])('真实解析的重叠、同值和相离证据在漫画模式 %s 中保持正确提示',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const high={text:'90%',bbox:{x0:10,y0:10,x1:110,y1:30},confidence:99,words:[]};
        for(const scenario of ['conflict','same','disjoint'] as const) for(const reverse of [false,true]){
            const low={text:scenario==='same'?'90%':'70%',bbox:{x0:scenario==='disjoint'?110:90,y0:10,x1:190,y1:30},confidence:20,words:[]};
            const raw=[{paragraphs:[{lines:reverse?[low,high]:[high,low]}]}];
            const parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
            imageOptions.push({width:240,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
            const result=await translateImageInOffscreen('overlap',manga?'ko':'en','Page',undefined,`overlap-${manga}-${scenario}-${reverse}`,manga,'tesseract');
            expect(result.lines.map(line=>line.sourceText)).toEqual(['90%']);
            expect(result.lines[0].numericUncertain).toBe(scenario==='conflict'?true:undefined);
        }
        expect(sendMessage.mock.calls.some(([message])=>message.type==='fluentReadImageTranslateTexts')).toBe(false);
    });
    it.each([false,true])('同值可信结果覆盖原始证据仍提示其他部分相交的可信数值，漫画模式 %s',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const high={text:'90%',bbox:{x0:10,y0:10,x1:110,y1:30},confidence:99,words:[]};
        const other={text:'80%',bbox:{x0:90,y0:10,x1:190,y1:30},confidence:99,words:[]};
        const low={...high,confidence:20};
        for(const rawLines of [[high,other],[other,high],[high,other,low],[low,other,high]]){
            const raw=[{paragraphs:[{lines:rawLines}]}];
            const parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
            imageOptions.push({width:240,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
            const result=await translateImageInOffscreen('overlap',manga?'ko':'en','Page',undefined,'covered',manga,'tesseract');
            expect(result.lines.map(line=>line.sourceText).sort()).toEqual(rawLines.includes(low)?['80%']:['80%','90%']);
            expect(result.lines.every(line=>line.numericUncertain)).toBe(true);
            expect(result.lines.every(line=>!('numericGuardText' in line))).toBe(true);
        }
    });
    it.each([false,true])('真实 OCR 数值只忽略百分号前空白，漫画模式 %s',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        for(const [highText,lowText,uncertain] of [
            ['90%','90 %',false],['90％','90   ％',false],['90%','80 %',true],
            ['$1000','$1 000',true],
        ] as const) for(const reverse of [false,true]) {
            const high={text:highText,bbox:{x0:10,y0:10,x1:110,y1:30},confidence:99,words:[]};
            const low={text:lowText,bbox:{x0:90,y0:10,x1:190,y1:30},confidence:20,words:[]};
            const raw=[{paragraphs:[{lines:reverse?[low,high]:[high,low]}]}];
            const parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
            imageOptions.push({width:240,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
            const result=await translateImageInOffscreen('percent',manga?'ko':'en','Page',undefined,'percent',manga,'tesseract');
            expect(result.lines.map(line=>line.sourceText)).toEqual([highText]);
            expect(result.lines[0].numericUncertain).toBe(uncertain?true:undefined);
        }
    });
    it.each([false,true])('同框可信百分号空白差异在真实归一化后不丢失且不误报，漫画模式 %s',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        for(const [first,second] of [['90%','90 %'],['90％','90   ％']] as const) for(const reverse of [false,true]) {
            const bbox={x0:10,y0:10,x1:110,y1:30};
            const items=[first,second].map(text=>({text,bbox,confidence:99,words:[]}));
            const raw=[{paragraphs:[{lines:reverse?items.reverse():items}]}];
            const parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
            imageOptions.push({width:240,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
            const result=await translateImageInOffscreen('percent-same-box',manga?'ko':'en','Page',undefined,'percent-same-box',manga,'tesseract');
            expect(result.lines).toHaveLength(1);
            expect(result.lines[0].numericUncertain).toBeUndefined();
            expect(result.lines[0].sourceText).toBe(reverse?second:first);
        }
    });
    it.each([false,true])('原始同框冲突保护证据在真实识别流程提示相交数值，漫画模式 %s',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const box={x0:90,y0:10,x1:190,y1:30};
        const raw=[{paragraphs:[{lines:[
            {text:'90%',bbox:{x0:10,y0:10,x1:110,y1:30},confidence:99,words:[]},
            {text:'70%',bbox:box,confidence:20,words:[]},
            {text:'80%',bbox:box,confidence:20,words:[]},
        ]}]}];
        const parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
        expect(guards).toContainEqual(expect.objectContaining({bbox:box,numericGuardConflict:true}));
        imageOptions.push({width:240,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
        const result=await translateImageInOffscreen('conflict-guard',manga?'ko':'en','Page',undefined,'conflict-guard',manga,'tesseract');
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0]).toMatchObject({sourceText:'90%',numericUncertain:true});
    });
    it('原始保护框比较超过预算时保守提示未验证数值',async()=>{
        const numbers=Array.from({length:1001},(_,i)=>({text:'90%',bbox:{x0:i,y0:0,x1:i+1,y1:1},numericConfidence:99}));
        const {collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const raw=Array.from({length:1000},(_,i)=>({text:'90%',bbox:{x0:i,y0:10,x1:i+1,y1:11},confidence:20,words:[]}));
        const guards=collectRawNumericGuards([{paragraphs:[{lines:raw}]}]);
        imageOptions.push({width:1200,height:20});mocks.recognize.mockResolvedValueOnce([...numbers,...guards]);
        const result=await translateImageInOffscreen('guard-budget','en','Page',undefined,'guard-budget',false,'tesseract');
        expect(result.lines).toHaveLength(1001);
        expect(result.lines.every(line=>line.numericUncertain)).toBe(true);
    });
    it.each([1413,1414])('数字和保护框比较预算边界：%s 个数字',async count=>{
        const numbers=Array.from({length:count},(_,i)=>({text:'90%',bbox:{x0:i,y0:0,x1:i+1,y1:1},numericConfidence:99}));
        const guards=[{text:'',bbox:{x0:0,y0:10,x1:1,y1:11},guardOnly:true,numericGuardText:'90%'}];
        imageOptions.push({width:1600,height:20});mocks.recognize.mockResolvedValueOnce([...numbers,...guards]);
        const result=await translateImageInOffscreen('budget','en','Page',undefined,'budget',false,'tesseract');
        expect(result.lines).toHaveLength(count);
        expect(result.lines.every(line=>line.numericUncertain === (count===1414?true:undefined))).toBe(true);
    });
});

describe('低置信数值物理保护',()=>{
    it.each([false,true])('低置信多词原行仅作物理保护，%s 漫画模式不阅读和送翻残片',async manga=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');let x=20;
        const words=['12',':','30','PM'].map(text=>{const bbox={x0:x,y0:2,x1:x+5,y1:10};x+=6;return {text,bbox,confidence:89};});
        const raw=[{text:'12:30 PM',bbox:{x0:20,y0:2,x1:x-1,y1:10},confidence:89,words},
            {text:'Close',bbox:{x0:2,y0:2,x1:19,y1:10},confidence:99},
            {text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60},confidence:99}];
        const blocks=[{paragraphs:[{lines:raw}]}],parsed=normalizeOcrLineViews(blocks).manga,guards=collectRawNumericGuards(blocks,parsed);
        expect(parsed.map(line=>line.text)).toEqual(['Close','Away']);expect(guards).toContainEqual(expect.objectContaining({text:'',bbox:raw[0].bbox,guardOnly:true}));
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
        if(manga)mocks.repair.mockImplementationOnce(async pixels=>pixels);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const result=await translateImageInOffscreen('low-split',manga?'ko':'en','Page',undefined,`low-split-${manga}`,manga,'tesseract');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Close','Away']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['Close','Away']);expect(result.lines[0]).toMatchObject({renderSkipped:true});
    });
    it.each(['low-split','conflicting-values'] as const)('同一原框 %s 不进入阅读或翻译，远处正文仍正常翻译',async kind=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');let x=20;
        const words=['12',':','30','PM'].map(text=>{const bbox={x0:x,y0:2,x1:x+5,y1:10};x+=6;return {text,bbox,confidence:kind==='low-split'?89:99};});
        const bbox={x0:20,y0:2,x1:x-1,y1:10},first={text:'12:30 PM',bbox,confidence:99,words:[]},
            second={text:kind==='low-split'?'12:30 PM':'12:31 PM',bbox,confidence:kind==='low-split'?89:99,words};
        if(kind==='conflicting-values')second.words[2].text='31';
        const away={text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60},confidence:99};
        const raw=[{paragraphs:[{lines:[first,second,away]}]}],parsed=normalizeOcrLineViews(raw).manga,guards=collectRawNumericGuards(raw,parsed);
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([...parsed,...guards]);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['远']}:undefined));
        const result=await translateImageInOffscreen('duplicate-values','en','Page',undefined,`same-box-${kind}`,false,'tesseract');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Away']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['Away']);
    });
    it.each(['same','different'] as const)('超宽原框内 %s 数值的位置无法确认时整图报错，中间正文不被擦除',async kind=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const bbox={x0:0,y0:2,x1:100,y1:12},left={text:'90%',bbox,confidence:99,words:[{text:'90%',bbox:{x0:0,y0:2,x1:10,y1:12},confidence:99}]};
        const value=kind==='same'?'90%':'80%',right={text:value,bbox,confidence:99,words:[{text:value,bbox:{x0:90,y0:2,x1:100,y1:12},confidence:99}]};
        const center={text:'HELLO',bbox:{x0:40,y0:2,x1:60,y1:12},confidence:99};
        for(const lines of [[left,right,center],[right,left,center]]){
            const raw=[{paragraphs:[{lines}]}];imageOptions.push({width:100,height:80});
            mocks.recognize.mockImplementationOnce(async()=>{const parsed=normalizeOcrLineViews(raw).manga;return [...parsed,...collectRawNumericGuards(raw,parsed)];});
            await expect(translateImageInOffscreen('wide-source','en','Page',undefined,`wide-${kind}`,false,'tesseract')).rejects.toThrow('保护位置无效');
        }
        expect(sendMessage.mock.calls.some(([message])=>message.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
    });
    it('Tesseract 混排行低分数值词被过滤时，保留物理框并阻止邻近文字擦图',async()=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const label={x0:2,y0:2,x1:19,y1:10},number={x0:20,y0:2,x1:40,y1:10};
        const raw=[{text:'SALE 90%',bbox:{x0:2,y0:2,x1:40,y1:10},confidence:99,
            words:[{text:'SALE',bbox:label,confidence:99},{text:'90%',bbox:number,confidence:20}]},
            {text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60},confidence:99}];
        const blocks=[{paragraphs:[{lines:raw}]}],parsed=normalizeOcrLineViews(blocks).manga;
        const recognized=[...parsed,...collectRawNumericGuards(blocks,parsed)];
        expect(recognized.filter(line=>line.guardOnly)).toEqual([expect.objectContaining({text:'',bbox:number,guardOnly:true})]);
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['促销','远']}:undefined));
        const result=await translateImageInOffscreen('mixed-word','en','Page',undefined,'mixed-word',false,'tesseract');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['SALE','Away']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['SALE','Away']);
        expect(result.lines[0]).toMatchObject({text:'促销',renderSkipped:true});expect(result.lines[1]).not.toHaveProperty('renderSkipped');
        expect(mocks.inpaint.mock.calls[0][3]).toHaveLength(1);expect(mocks.inpaint.mock.calls[0][3][0].text).toBe('远');
    });
    it.each(['paddle-manga-low','paddle-manga-missing','paddle-image-low','paddle-image-missing','paddle-image-single','tesseract-manga-low','tesseract-manga-missing','tesseract-image-below-threshold'] as const)('%s 仅保护疑似数值，保留远处译文且不向服务发送数字',async scenario=>{
        const manga=scenario.includes('manga'),engine=scenario.startsWith('paddle')?'paddle':'tesseract';
        const sourceLanguage=engine==='tesseract'&&manga?'ko':'en';
        const close={text:sourceLanguage==='ko'?'안녕':'Close',bbox:{x0:2,y0:2,x1:19,y1:10}};
        const number={text:scenario.endsWith('single')?'1':'90%',bbox:{x0:20,y0:2,x1:40,y1:10}};
        const distant={text:sourceLanguage==='ko'?'다음':'Away',bbox:{x0:4,y0:50,x1:35,y1:60}};
        imageOptions.push({width:100,height:80});
        if(engine==='paddle'){
            const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
            const items=[close,number,distant].map(({text,bbox},i)=>({text,confidence:i===1?(scenario.endsWith('missing')?undefined!:scenario.endsWith('single')?.99:.89):.99,box:{x:bbox.x0,y:bbox.y0,width:bbox.x1-bbox.x0,height:bbox.y1-bbox.y0}}));
            const recognized=collectMangaRegions({results:items},sourceLanguage,100,80,manga?'manga':'image');
            expect(recognized.filter(line=>!line.guardOnly).map(line=>line.text)).toEqual([close.text,distant.text]);
            expect(recognized.some(line=>line.guardOnly)).toBe(true);mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        }else {
            const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
            const numberConfidence=scenario.endsWith('missing')?undefined:scenario.endsWith('threshold')?20:89;
            const raw=[close,number,distant].map(({text,bbox},i)=>({text,bbox,confidence:i===1?numberConfidence:99,words:[{text,bbox,confidence:i===1?numberConfidence:99}]}));
            const blocks=[{paragraphs:[{lines:raw}]}];
            const recognized=[...normalizeOcrLineViews(blocks).manga,...collectRawNumericGuards(blocks)];
            mocks.recognize.mockResolvedValueOnce(recognized);
        }
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        let pixels:Uint8ClampedArray<ArrayBuffer>|undefined;let original:Uint8ClampedArray|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
                pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);
                pixels[(5*100+20)*4]=0;
                for(let y=50;y<60;y++)for(let x=4;x<35;x++)pixels[(y*100+x)*4]=0;
                original=pixels.slice();return {data:pixels};
            });return canvas;
        })});
        if(manga){
            const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/mangaInpainting')>('@/src/features/image-translation/services/mangaInpainting');
            mocks.repair.mockImplementationOnce(async(pixels,width,height,regions)=>{
                for(const region of regions){const patch=actual.createMangaPatch(pixels,width,height,region);const white=new Float32Array(patch.patch.width*patch.patch.height*3).fill(1);actual.applyMangaPatch(pixels,width,region,patch,white);}return pixels;
            });
        }else {
            const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
            mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
        }
        const result=await translateImageInOffscreen('mixed',sourceLanguage,'Page',undefined,'numeric-negative',manga,engine);
        expect(result.lines.map(line=>line.sourceText)).toEqual([close.text,distant.text]);
        expect(result.lines[0]).toMatchObject({renderSkipped:true});
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual([close.text,distant.text]);
        expect(pixels).toBeDefined();
        expect(pixels![(5*100+20)*4]).toBe(original![(5*100+20)*4]);
        expect(pixels![(55*100+10)*4]).not.toBe(original![(55*100+10)*4]);
    });
    it('低分数字形态的绘画噪声只参与保护，但会保守跳过邻近译文',async()=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const close={text:'Close',confidence:.99,box:{x:2,y:2,width:17,height:8}};
        const artifact={text:'90%',confidence:.2,box:{x:20,y:2,width:20,height:8}};
        const far={text:'Away',confidence:.99,box:{x:4,y:50,width:31,height:10}};
        const recognized=collectMangaRegions({results:[close,artifact,far]},'en',100,80,'image');
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const result=await translateImageInOffscreen('art-noise','en','Page',undefined,'art-noise',false,'paddle');
        expect(result.lines.map(line=>line.sourceText)).toEqual(['Close','Away']);
        expect(result.lines[0]).toMatchObject({text:'近',renderSkipped:true});
        expect(result.lines[1]).not.toHaveProperty('renderSkipped');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Close','Away']);
    });
    it.each(['invalid','too-many'] as const)('保护框 %s 时明确报错，不请求翻译或发布部分图片',async problem=>{
        imageOptions.push({width:100,height:80});
        const label={text:'Hello',bbox:{x0:1,y0:1,x1:10,y1:8},fontSize:7};
        const guards=problem==='invalid'?[{text:'',bbox:{x0:NaN,y0:1,x1:10,y1:8},guardOnly:true}]
            :Array.from({length:4097},(_,i)=>({text:'',bbox:{x0:i/100,y0:10,x1:i/100+.5,y1:11},guardOnly:true}));
        mocks.mangaRecognize.mockResolvedValueOnce([label,...guards]);
        await expect(translateImageInOffscreen('guard-error','en','Page',undefined,'guard-error',true,'paddle'))
            .rejects.toThrow(problem==='invalid'?'图片数字保护位置无效':'图片数字保护区域过于复杂');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it('完全位于原图外的疑似框不阻止正文翻译',async()=>{
        const label={text:'Hello',bbox:{x0:2,y0:2,x1:10,y1:8},fontSize:6};
        const outside={text:'',bbox:{x0:200,y0:200,x1:210,y1:210},guardOnly:true};
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce([label,outside]);
        mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('outside-guard','en','Page',undefined,'outside-guard',true,'paddle');
        expect(result.lines).toHaveLength(1);expect(result.lines[0]).not.toHaveProperty('renderSkipped');
        expect(mocks.repair).toHaveBeenCalledOnce();
    });
    it('含疑似数值的识别结果在取消后不发翻译也不发布图像',async()=>{
        const controller=new AbortController();
        mocks.mangaRecognize.mockImplementationOnce(async()=>{controller.abort();return [{text:'',bbox:{x0:1,y0:1,x1:10,y1:8},guardOnly:true}];});
        await expect(translateImageInOffscreen('guard-cancel','en','Page',controller.signal,'guard-cancel',true,'paddle')).rejects.toMatchObject({name:'AbortError'});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);expect(mocks.repair).not.toHaveBeenCalled();
    });
});

describe('重叠数字候选跨识别与阅读链路',()=>{
    it.each(['manga','image'] as const)('%s 保留冲突候选、标记核对且不翻译或绘制数字',async profile=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const box={x:80,y:80,width:100,height:20};
        const recognized=collectMangaRegions({results:[{text:'08:45',confidence:.99,box}],bubbles:[{bbox:{x0:40,y0:40,x1:250,y1:180},results:[{text:'12:34',confidence:.99,box}]}]},'en',400,400,profile);
        imageOptions.push({width:400,height:400});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        const result=await translateImageInOffscreen('fixture','en','Page',undefined,'numeric-conflict',profile==='manga','paddle');
        expect(result.lines.map(line=>line.text).sort()).toEqual(['08:45','12:34']);
        expect(result.lines.every(line=>line.numericUncertain)).toBe(true);
        expect(sendMessage.mock.calls.some(([message])=>message.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
        if(profile==='manga')expect(result.mangaPatches?.patches).toEqual([]);else expect(result).toMatchObject({image:'',imageUnchanged:true});
    });
});

it('未变化的品牌原文与相邻译文冲突时保留品牌，远处对白仍可绘制',async()=>{
    ordinaryAlphaCanvas(100,80,new Uint8ClampedArray(100*80*4));
    const close={text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8,sourceBoxes:[{x0:2,y0:2,x1:19,y1:10}]};
    const brand={text:'KEEP',bbox:{x0:20,y0:2,x1:40,y1:10},fontSize:8,sourceBoxes:[{x0:20,y0:2,x1:40,y1:10}]};
    const distant={text:'Goodbye',bbox:{x0:4,y0:50,x1:35,y1:60},fontSize:10,sourceBoxes:[{x0:4,y0:50,x1:35,y1:60}]};
    mocks.mangaRecognize.mockResolvedValueOnce([close,brand,distant]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','KEEP','再见']}:undefined));
    let raster:Uint8ClampedArray|undefined;
    mocks.repair.mockImplementationOnce(async(pixels,width,height,regions)=>{
        raster=pixels;for(const region of regions)for(const b of mangaMaskBoxes(region,width,height))
            for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)pixels[(y*width+x)*4]=255;
        return pixels;
    });
    const result=await translateImageInOffscreen('brand-conflict','en','Page',undefined,'brand-conflict',true);
    expect(raster).toBeDefined();
    expect(raster![(5*100+20)*4]).toBe(0);
    expect(raster![(55*100+10)*4]).toBe(255);
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result.lines.find(line=>line.sourceText==='KEEP')).toMatchObject({text:'KEEP'});
});

it.each(['forward','reverse'] as const)('一处需保留原文使相邻译文跳过后，继续保护该译文的原文直至稳定（%s）',async order=>{
    imageOptions.push({width:100,height:80});
    const box=(x0:number,x1:number,y0=2,y1=10)=>({x0,y0,x1,y1});
    const a={text:'FIRST',bbox:box(2,20),fontSize:8,sourceBoxes:[box(2,20)]};
    const b={text:'SECOND',bbox:box(22,40),fontSize:8,sourceBoxes:[box(22,40)]};
    const original={text:'BRAND',bbox:box(42,60),fontSize:8,sourceBoxes:[box(42,60)]};
    const far={text:'DISTANT',bbox:box(5,25,50,60),fontSize:10,sourceBoxes:[box(5,25,50,60)]};
    const rows=order==='forward'?[a,b,original,far]:[b,a,original,far];
    mocks.mangaRecognize.mockResolvedValueOnce(rows);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:order==='forward'?['一','二','BRAND','远']:['二','一','BRAND','远']}:undefined));
    mocks.repair.mockImplementationOnce(async pixels=>pixels);
    const result=await translateImageInOffscreen('chain','en','Page',undefined,'chain',true);
    expect(result.lines.map(line=>line.renderSkipped===true)).toEqual([true,true,false,false]);
    expect(mocks.repair.mock.calls[0][3].map((line:ImageTextRegion)=>line.text)).toEqual(['远']);
});

it('保留原文同时检查合并框和全部源框，包括源框超出合并框的防御情形',async()=>{
    imageOptions.push({width:100,height:80});
    const close={text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8,sourceBoxes:[{x0:2,y0:2,x1:19,y1:10}]};
    const original={text:'BRAND',bbox:{x0:60,y0:40,x1:80,y1:50},fontSize:10,sourceBoxes:[{x0:70,y0:40,x1:80,y1:50},{x0:20,y0:2,x1:30,y1:10}]};
    mocks.mangaRecognize.mockResolvedValueOnce([close,original]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','BRAND']}:undefined));
    const result=await translateImageInOffscreen('source-box','en','Page',undefined,'source-box',true);
    expect(result.lines[0]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
    expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it('翻译服务缺少相邻行结果时保留回退原文',async()=>{
    imageOptions.push({width:100,height:80});
    const close={text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8,sourceBoxes:[{x0:2,y0:2,x1:19,y1:10}]};
    const fallback={text:'BRAND',bbox:{x0:20,y0:2,x1:40,y1:10},fontSize:8,sourceBoxes:[{x0:20,y0:2,x1:40,y1:10}]};
    mocks.mangaRecognize.mockResolvedValueOnce([close,fallback]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']}:undefined));
    const result=await translateImageInOffscreen('missing','en','Page',undefined,'missing',true);
    expect(result.lines[0]).toMatchObject({text:'你好',renderSkipped:true});expect(result.lines[1]).toMatchObject({text:'BRAND',sourceText:'BRAND'});
    expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('通用 OCR 在对角相邻时保留未变俄文及可读译文',async()=>{
    imageOptions.push({width:100,height:80});
    const close={text:'Привет',bbox:{x0:2,y0:2,x1:22,y1:22}};
    const original={text:'БРЕНД',bbox:{x0:25,y0:25,x1:45,y1:45}};
    mocks.recognize.mockResolvedValueOnce([close,original]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','БРЕНД']}:undefined));
    const result=await translateImageInOffscreen('tesseract-original','ru','Page',undefined,'tesseract-original',true);
    expect(result.lines.find(line=>line.sourceText==='Привет')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result.lines.find(line=>line.sourceText==='БРЕНД')).toMatchObject({text:'БРЕНД'});
    expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('候选缺少源框时仍用原框余量检查，并保护未变化的相邻原文',async()=>{
    imageOptions.push({width:100,height:80});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8},
        {text:'BRAND',bbox:{x0:21,y0:2,x1:40,y1:10},fontSize:8}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','BRAND']}:undefined));
    const result=await translateImageInOffscreen('default-source','en','Page',undefined,'default-source',true);
    expect(result.lines[0]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('候选源框无效时不继续绘制，避免依据无效几何判断原文安全',async()=>{
    imageOptions.push({width:100,height:80});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8,sourceBoxes:[null]},
        {text:'12:34',bbox:{x0:60,y0:50,x1:80,y1:60},fontSize:10}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']}:undefined));
    const result=await translateImageInOffscreen('invalid-source','en','Page',undefined,'invalid-source',true);
    expect(result.lines[0]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('完全位于图外的保留框不阻断其他可安全绘制区域',async()=>{
    imageOptions.push({width:100,height:80});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:19,y1:10},fontSize:8},
        {text:'12:34',bbox:{x0:150,y0:10,x1:160,y1:20},fontSize:10,sourceBoxes:[]}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']}:undefined));
    mocks.repair.mockImplementationOnce(async pixels=>pixels);
    const result=await translateImageInOffscreen('outside-original','en','Page',undefined,'outside-original',true);
    expect(result.lines[0].renderSkipped).toBeUndefined();expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.mangaDraw).toHaveBeenCalledOnce();
});

it('比较预算耗尽时保留全部原图并标记所有未绘制译文',async()=>{
    imageOptions.push({width:100,height:80});
    const changed=Array.from({length:1000},(_,index)=>({text:`WORD${index}`,bbox:{x0:2,y0:2,x1:10,y1:10},fontSize:8,sourceBoxes:[{x0:2,y0:2,x1:10,y1:10}]}));
    const originals=Array.from({length:600},(_,index)=>{const x=40+index%50,y=20+Math.floor(index/50);return {text:'12:34',bbox:{x0:x,y0:y,x1:x+1,y1:y+1},fontSize:1};});
    mocks.mangaRecognize.mockResolvedValueOnce([...changed,...originals]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:Array.from({length:changed.length},()=> '译文')}:undefined));
    const result=await translateImageInOffscreen('budget','en','Page',undefined,'budget',true);
    expect(result.lines.slice(0,changed.length).every(line=>line.renderSkipped===true)).toBe(true);
    expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it('待保留框超出有界集合时保留原图而非漏掉后续原文',async()=>{
    imageOptions.push({width:200,height:200});
    const changed={text:'TEXT',bbox:{x0:2,y0:150,x1:20,y1:160},fontSize:10,sourceBoxes:[{x0:2,y0:150,x1:20,y1:160}]};
    const originals=Array.from({length:8193},(_,index)=>{const x=4+index%100,y=4+Math.floor(index/100);return {text:'12:34',bbox:{x0:x,y0:y,x1:x+1,y1:y+1},fontSize:1};});
    mocks.mangaRecognize.mockResolvedValueOnce([changed,...originals]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文']}:undefined));
    const result=await translateImageInOffscreen('many-boxes','en','Page',undefined,'many-boxes',true);
    expect(result.lines[0]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('巨大源框列表逐项计入预算，传播耗尽时远处译文也保留原图',async()=>{
    imageOptions.push({width:100,height:80});
    const repeated={x0:2,y0:2,x1:19,y1:10},sources=Array.from({length:250_001},()=>repeated);
    const near=Array.from({length:4},(_,index)=>({text:`TEXT${index}`,bbox:repeated,fontSize:8,sourceBoxes:sources}));
    const original={text:'BRAND',bbox:{x0:20,y0:2,x1:40,y1:10},fontSize:8,sourceBoxes:[{x0:20,y0:2,x1:40,y1:10}]};
    const far={text:'DISTANT',bbox:{x0:5,y0:50,x1:25,y1:60},fontSize:10,sourceBoxes:[{x0:5,y0:50,x1:25,y1:60}]};
    mocks.mangaRecognize.mockResolvedValueOnce([...near,original,far]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['一','二','三','四','BRAND','远']}:undefined));
    const result=await translateImageInOffscreen('many-sources','en','Page',undefined,'many-sources',true);
    expect(result.lines.slice(0,4).every(line=>line.renderSkipped===true)).toBe(true);
    expect(result.lines[5]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('大量已跳过候选的后续访问也计入预算，不能让队列空遍历失控',async()=>{
    imageOptions.push({width:100,height:80});
    const box={x0:2,y0:2,x1:19,y1:10};
    const near=Array.from({length:1000},(_,index)=>({text:`TEXT${index}`,bbox:box,fontSize:8,sourceBoxes:[box]}));
    const original={text:'BRAND',bbox:{x0:20,y0:2,x1:40,y1:10},fontSize:8,sourceBoxes:[{x0:20,y0:2,x1:40,y1:10}]};
    const far={text:'DISTANT',bbox:{x0:2,y0:60,x1:20,y1:70},fontSize:10,sourceBoxes:[{x0:2,y0:60,x1:20,y1:70}]};
    const others=Array.from({length:1100},(_,index)=>{const x=40+index%50,y=20+Math.floor(index/50);return {text:'12:34',bbox:{x0:x,y0:y,x1:x+1,y1:y+1},fontSize:1};});
    mocks.mangaRecognize.mockResolvedValueOnce([...near,original,far,...others]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:[...Array.from({length:near.length},()=> '译文'),'BRAND','远']}:undefined));
    const result=await translateImageInOffscreen('skipped-queue','en','Page',undefined,'skipped-queue',true);
    expect(result.lines[near.length+1]).toMatchObject({renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.repair).not.toHaveBeenCalled();
});

it('翻译期间取消时保留全部原图且不执行碰撞后的修补',async()=>{
    const controller=new AbortController();
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:11,y1:6},fontSize:4},{text:'BRAND',bbox:{x0:12,y0:2,x1:27,y1:6},fontSize:4}]);
    sendMessage.mockImplementation((message,callback)=>{if(message.type==='fluentReadImageTranslateTexts'){controller.abort();callback({success:true,translations:['你好','BRAND']});}else callback(undefined);});
    await expect(translateImageInOffscreen('cancel-original','en','Page',controller.signal,'cancel-original',true)).rejects.toThrow('已取消');
    expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it('碰撞扫描进行中收到取消时在有界检查点退出，不启动修补',async()=>{
    imageOptions.push({width:100,height:80});
    const controller=new AbortController(),box={x0:2,y0:2,x1:10,y1:10};let scanning=false;
    const sources=new Proxy(Array.from({length:40_000},()=>box),{get(target,key,receiver){
        if(key==='1000'&&!scanning){scanning=true;setTimeout(()=>controller.abort(),0);}
        return Reflect.get(target,key,receiver);
    }});
    const translated={text:'Hello',bbox:box,fontSize:8,sourceBoxes:sources};
    const original={text:'12:34',bbox:{x0:60,y0:50,x1:80,y1:60},fontSize:10};
    mocks.mangaRecognize.mockResolvedValueOnce([translated,original]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']}:undefined));
    await expect(translateImageInOffscreen('scan-cancel','en','Page',controller.signal,'scan-cancel',true)).rejects.toThrow('已取消');
    expect(scanning).toBe(true);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it('碰撞传播完成前收到取消时，即使无译图也不能返回成功结果',async()=>{
    const controller=new AbortController(),box={x0:12,y0:2,x1:27,y1:6};let scheduled=false;
    const sources=new Proxy([box],{get(target,key,receiver){if(key==='0'&&!scheduled){scheduled=true;queueMicrotask(()=>controller.abort());}return Reflect.get(target,key,receiver);}});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:11,y1:6},fontSize:4},
        {text:'BRAND',bbox:box,fontSize:4,sourceBoxes:sources}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','BRAND']}:undefined));
    await expect(translateImageInOffscreen('last-cancel','en','Page',controller.signal,'last-cancel',true)).rejects.toThrow('已取消');
    expect(scheduled).toBe(true);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it('保护框预算耗尽时收到取消仍以取消结束，不把空译图当成功',async()=>{
    imageOptions.push({width:200,height:200});const controller=new AbortController();let scheduled=false;
    const changed={text:'TEXT',bbox:{x0:2,y0:150,x1:20,y1:160},fontSize:10};
    const originals=Array.from({length:8193},(_,index)=>{const x=4+index%100,y=4+Math.floor(index/100);return {text:'12:34',bbox:{x0:x,y0:y,x1:x+1,y1:y+1},fontSize:1};});
    const last=originals[8192],lastBox=last.bbox;Object.defineProperty(last,'bbox',{get(){if(!scheduled){scheduled=true;queueMicrotask(()=>controller.abort());}return lastBox;}});
    mocks.mangaRecognize.mockResolvedValueOnce([changed,...originals]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文']}:undefined));
    await expect(translateImageInOffscreen('budget-cancel','en','Page',controller.signal,'budget-cancel',true)).rejects.toThrow('已取消');
    expect(scheduled).toBe(true);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
});

it.each(['tesseract','paddle'] as const)('普通图片 %s 修补与译文框不能覆盖保留的相邻品牌，远处仍绘制',async engine=>{
    imageOptions.push({width:100,height:80});
    const near={text:'Hello',bbox:{x0:4,y0:12,x1:19,y1:20}};
    const brand={text:'KEEP',bbox:{x0:20,y0:12,x1:40,y1:20}};
    const far={text:'Goodbye',bbox:{x0:4,y0:50,x1:35,y1:60}};
    if(engine==='paddle')mocks.mangaRecognize.mockResolvedValueOnce([near,brand,far]);
    else mocks.recognize.mockResolvedValueOnce([near,brand,far]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','KEEP','再见']}:undefined));
    const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
    let pixels:Uint8ClampedArray|undefined;
    mocks.inpaint.mockImplementationOnce((data,width,height,regions,inPlace)=>{pixels=data;return actual.inpaintTextRegions(data,width,height,regions,inPlace);});
    vi.stubGlobal('document',{createElement:vi.fn(()=>{const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
        const data=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);
        for(let y=12;y<20;y++)for(let x=20;x<40;x++){const offset=(y*100+x)*4;data[offset]=data[offset+1]=data[offset+2]=0;}
        return {data};});return canvas;})});
    const result=await translateImageInOffscreen('single-original','en','Page',undefined,'single-original',false,engine);
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result.lines.find(line=>line.sourceText==='Goodbye')).not.toHaveProperty('renderSkipped');
    expect(mocks.inpaint.mock.calls[0][3].map((line:ImageTextRegion)=>line.text)).toEqual(['再见']);
    expect(pixels![(12*100+20)*4]).toBe(0);expect(mocks.draw).toHaveBeenCalledOnce();
});

it('普通图片译文字形扩展框与保留原文相交时也保留原图',async()=>{
    imageOptions.push({width:100,height:80});
    const near={text:'Hello',bbox:{x0:4,y0:10,x1:25,y1:30}};
    const brand={text:'KEEP',bbox:{x0:4,y0:35,x1:25,y1:43}};
    mocks.recognize.mockResolvedValueOnce([near,brand]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','KEEP']}:undefined));
    const result=await translateImageInOffscreen('draw-conflict','en','Page');
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result.image).toBe('');expect(result).toMatchObject({imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});

it('普通图片按自身修补边距传播保护，缺译原文不受后续译文覆盖',async()=>{
    imageOptions.push({width:120,height:80});
    const box=(x0:number,x1:number)=>({x0,y0:12,x1,y1:20});
    const first={text:'FIRST',bbox:box(2,10)},second={text:'SECOND',bbox:box(13,24)};
    const kept={text:'KEEP',bbox:box(27,40)},far={text:'FAR',bbox:{x0:4,y0:50,x1:35,y1:60}};
    mocks.recognize.mockResolvedValueOnce([first,second,kept,far]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['一','二','','远']}:undefined));
    const result=await translateImageInOffscreen('single-chain','en','Page');
    expect(result.lines.map(line=>[line.sourceText,line.renderSkipped===true])).toEqual([['FIRST',true],['SECOND',true],['KEEP',false],['FAR',false]]);
    expect(mocks.inpaint.mock.calls[0][3].map((line:ImageTextRegion)=>line.text)).toEqual(['远']);expect(mocks.draw).toHaveBeenCalledOnce();
});

it('普通图片合段的后续物理源框与保留原文相邻时不清除该原文',async()=>{
    imageOptions.push({width:100,height:80});
    const first={text:'Hello',bbox:{x0:4,y0:10,x1:19,y1:18}},second={text:'world',bbox:{x0:4,y0:20,x1:19,y1:28}};
    const kept={text:'KEEP',bbox:{x0:20,y0:20,x1:40,y1:28}};
    mocks.recognize.mockResolvedValueOnce([first,second,kept]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好世界','KEEP']}:undefined));
    const result=await translateImageInOffscreen('paragraph-source','en','Page');
    const line=result.lines.find(item=>item.sourceText==='Hello world') as ImageTextRegion & {renderSkipped?:true};
    expect(line?.sourceBoxes).toEqual([first.bbox,second.bbox]);expect(line).toMatchObject({text:'你好世界',renderSkipped:true});
    expect(result).toMatchObject({image:'',imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});

it('普通图片真实合段的物理源框清字边距大于绘制框时仍保护相邻原文',async()=>{
    imageOptions.push({width:120,height:130});
    const first={text:'Hello',bbox:{x0:4,y0:10,x1:19,y1:50}},second={text:'world',bbox:{x0:4,y0:52,x1:19,y1:92}};
    const kept={text:'KEEP',bbox:{x0:24,y0:52,x1:40,y1:92}};
    mocks.recognize.mockResolvedValueOnce([first,second,kept]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好世界','KEEP']}:undefined));
    const result=await translateImageInOffscreen('paragraph-mask-margin','en','Page');
    const line=result.lines.find(item=>item.sourceText==='Hello world') as ImageTextRegion & {renderSkipped?:true};
    expect(line?.sourceBoxes).toEqual([first.bbox,second.bbox]);
    expect(line.bbox.x1+2).toBeLessThan(kept.bbox.x0-2); // 保留框本身也外扩 2px。
    expect(second.bbox.x1+4).toBeGreaterThan(kept.bbox.x0-2); // 40px 字行的清字边距为 4px。
    expect(line).toMatchObject({renderSkipped:true});
    expect(result).toMatchObject({image:'',imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();
});

it('普通图片保护扫描中收到取消时不修补、不绘制或返回成功',async()=>{
    imageOptions.push({width:100,height:80});
    const controller=new AbortController(),box={x0:2,y0:2,x1:10,y1:10};let scanning=false;
    const sources=new Proxy(Array.from({length:40_000},()=>box),{get(target,key,receiver){
        if(key==='1000'&&!scanning){scanning=true;setTimeout(()=>controller.abort(),0);}
        return Reflect.get(target,key,receiver);
    }});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:box,fontSize:8,sourceBoxes:sources},
        {text:'12:34',bbox:{x0:60,y0:50,x1:80,y1:60},fontSize:10}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好']}:undefined));
    await expect(translateImageInOffscreen('single-scan-cancel','en','Page',controller.signal,'single-scan-cancel',false,'paddle')).rejects.toThrow('已取消');
    expect(scanning).toBe(true);expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});

it.each([{vertical:false,bbox:{x0:0,y0:0,x1:12,y1:20},brand:{x0:15,y0:0,x1:22,y1:7}},
    {vertical:true,bbox:{x0:0,y0:0,x1:12,y1:20},brand:{x0:16,y0:0,x1:23,y1:7}}])('普通图片贴左上边缘的译文裁剪框也必须保护原文 %j',async ({vertical,bbox,brand})=>{
    imageOptions.push({width:100,height:80});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox,vertical},{text:'KEEP',bbox:brand}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','KEEP']}:undefined));
    const result=await translateImageInOffscreen('edge-conflict','en','Page',undefined,'edge-conflict',false,'paddle');
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result).toMatchObject({image:'',imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});

it('普通图片包含越界段落源框时也保护整条保留原文',async()=>{
    imageOptions.push({width:100,height:80});
    const changed={text:'Hello',bbox:{x0:2,y0:2,x1:18,y1:10},sourceBoxes:[{x0:50,y0:2,x1:60,y1:10}]};
    const kept={text:'KEEP',bbox:{x0:61,y0:2,x1:75,y1:10}};
    mocks.mangaRecognize.mockResolvedValueOnce([changed,kept]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','KEEP']}:undefined));
    const result=await translateImageInOffscreen('source-box-conflict','en','Page',undefined,'source-box-conflict',false,'paddle');
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({renderSkipped:true});
    expect(result).toMatchObject({image:'',imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();
});

it('普通图片保留框超出预算时仍提供译文但不绘制任何区域',async()=>{
    imageOptions.push({width:200,height:200});
    const boxes=Array.from({length:8193},(_,index)=>{const x=index%100,y=Math.floor(index/100);return {x0:x,y0:y,x1:x+1,y1:y+1};});
    const kept={text:'KEEP',bbox:{x0:0,y0:0,x1:1,y1:1},sourceBoxes:boxes};
    const changed={text:'Hello',bbox:{x0:150,y0:150,x1:180,y1:170},sourceBoxes:[{x0:150,y0:150,x1:180,y1:170}]};
    mocks.mangaRecognize.mockResolvedValueOnce([kept,changed]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['KEEP','你好']}:undefined));
    const result=await translateImageInOffscreen('many-boxes','en','Page',undefined,'many-boxes',false,'paddle');
    expect(result.lines.find(line=>line.sourceText==='Hello')).toMatchObject({text:'你好',renderSkipped:true});
    expect(result).toMatchObject({image:'',imageUnchanged:true});expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});

it.each(['tesseract','paddle'] as const)('普通图片 %s 只有隐藏数字证据时仍报无文字而不返回空的原图保留结果',async engine=>{
    imageOptions.push({width:100,height:80});
    const guard={text:'',guardOnly:true as const,numericGuardText:'90%',bbox:{x0:10,y0:10,x1:30,y1:20}};
    if(engine==='paddle')mocks.mangaRecognize.mockResolvedValueOnce([guard]);else mocks.recognize.mockResolvedValueOnce([guard]);
    await expect(translateImageInOffscreen('guards-only','en','Page',undefined,'guards-only',false,engine)).rejects.toThrow('没有识别到图片文字');
    expect(sendMessage.mock.calls.some(([message])=>message.type==='fluentReadImageTranslateTexts')).toBe(false);
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
});
it('普通图片只有低置信数字时仍保留无文字闸门',async()=>{
    imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([{text:'90%',numericConfidence:20,bbox:{x0:10,y0:10,x1:30,y1:20}}]);
    await expect(translateImageInOffscreen('uncertain-only','en','Page')).rejects.toThrow('没有识别到图片文字');
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});
it.each([false,true])('退化候选几何不能擦写保留原文，漫画=%s',async manga=>{
    imageOptions.push({width:100,height:80});
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox:{x0:2,y0:2,x1:20,y1:10},fontSize:NaN},
        {text:'BRAND',bbox:{x0:50,y0:40,x1:70,y1:50},fontSize:10}]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','BRAND']}:undefined));
    const result=await translateImageInOffscreen('invalid-font','en','Page',undefined,'invalid-font',manga,'paddle');
    expect(result.lines[0]).toMatchObject({text:'你好',renderSkipped:true});
    if(manga)expect(result.mangaPatches?.patches).toEqual([]);else expect(result).toMatchObject({image:'',imageUnchanged:true});
    expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});
it('普通图片绘字边界读取时变为无效几何，保守保留原图而不绘制',async()=>{
    imageOptions.push({width:100,height:80});let armed=false,reads=0;
    const bbox={get x0(){return armed&&++reads>=3?NaN:4;},y0:12,x1:19,y1:20};
    mocks.mangaRecognize.mockResolvedValueOnce([{text:'Hello',bbox,fontSize:8},{text:'BRAND',bbox:{x0:60,y0:50,x1:80,y1:60},fontSize:10}]);
    sendMessage.mockImplementation((message,callback)=>{if(message.type==='fluentReadImageTranslateTexts'){armed=true;callback({success:true,translations:['你好','BRAND']});}else callback(undefined);});
    const result=await translateImageInOffscreen('unstable-bounds','en','Page',undefined,'unstable-bounds',false,'paddle');
    expect(result.lines[0]).toMatchObject({text:'你好',renderSkipped:true});expect(result).toMatchObject({image:'',imageUnchanged:true});
    expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
});


describe('漫画原文冲突后的纯白空处补绘',()=>{
    function fixture(key='blank-placement',targetOptions:Partial<MangaRegion>={}){
        const width=400,height=160,owner={x0:11,y0:11,x1:89,y1:129};
        const pixels=new Uint8ClampedArray(width*height*4).fill(255);
        const ink=(x0:number,y0:number,x1:number,y1:number)=>{for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)pixels.set([0,0,0,255],(y*width+x)*4);};
        ink(10,10,90,11);ink(10,129,90,130);ink(10,10,11,130);ink(89,10,90,130);ink(20,70,80,100);
        const target:MangaRegion={text:'SOURCE TARGET',bbox:{x0:20,y0:70,x1:80,y1:100},fontSize:10,sourceBoxes:[{x0:20,y0:70,x1:80,y1:100}],...targetOptions};
        const retained:MangaRegion={text:'KEEP',bbox:{x0:20,y0:90,x1:80,y1:110},fontSize:20};
        const rows=[target,retained];
        recordMangaBubblePlacement(target,owner,width,height);bindMangaBubblePlacements(rows,key,width,height);
        ordinaryAlphaCanvas(width,height,pixels,canvas=>canvas.context.measureText.mockImplementation((text:string)=>{
            const size=Number(/([\d.e+-]+)px/u.exec(canvas.context.font)?.[1]??10),advance=Array.from(text).length*size;
            return{width:advance,actualBoundingBoxLeft:0,actualBoundingBoxRight:advance,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};
        }));
        mocks.mangaRecognize.mockResolvedValueOnce(rows);mocks.repair.mockImplementation(async data=>data);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文完整','KEEP']}:undefined));
        return{width,height,pixels,owner,target,retained,rows,ink,run:(signal?:AbortSignal,mangaViewport?:ImageViewport)=>translateImageInOffscreen(key,'en','Page',signal,key,true,'paddle',mangaViewport)};
    }
    it('完整译文另画在源纯白空处，不清原文、不启修补且阅读坐标不移动',async()=>{
        const f=fixture(),before=f.pixels.slice(),result=await f.run();
        expect(result.lines[0]).toMatchObject({text:'译文完整',sourceText:'SOURCE TARGET',bbox:f.target.bbox,sourceBoxes:f.target.sourceBoxes});
        expect(result.lines[0].renderSkipped).toBeUndefined();expect(result.lines[1]).toMatchObject({text:'KEEP',sourceText:'KEEP'});
        expect(mocks.mangaDraw).toHaveBeenCalledOnce();const [context,pixels,width,height,regions,repaired,backgrounds]=mocks.mangaDraw.mock.calls[0];
        expect(context).toBe(canvases[0].context);expect(pixels).toBe(f.pixels);expect([width,height]).toEqual([f.width,f.height]);expect(repaired).toBe(true);
        expect(backgrounds).toEqual([{color:'rgb(255,255,255)',uniform:true}]);expect(regions).toHaveLength(1);
        const placed=regions[0] as MangaRegion;expect(placed).toMatchObject({text:'译文完整',fontSize:10,sourceBoxes:[]});
        expect(placed.bbox.y1).toBeLessThanOrEqual(67);expect(placed.bbox).not.toEqual(f.target.bbox);
        for(let y=placed.bbox.y0;y<placed.bbox.y1;y++)for(let x=placed.bbox.x0;x<placed.bbox.x1;x++)expect(Array.from(before.subarray((y*f.width+x)*4,(y*f.width+x)*4+4))).toEqual([255,255,255,255]);
        expect(f.pixels).toEqual(before);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.sampleManga).not.toHaveBeenCalled();expect(mocks.alphaProtection).not.toHaveBeenCalled();
        expect(canvases[0].context.getImageData).toHaveBeenCalledOnce();expect(canvases[0].context.putImageData).not.toHaveBeenCalled();
        expect(mocks.encode).toHaveBeenCalledOnce();expect(result.mangaPatches?.patches).toHaveLength(1);expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
        expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')).toHaveLength(1);
        expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);expect(images[0].src).toBe('');
    });
    it('同值clone不能继承气泡提示，无提示的旧快路径仍不分配画布',async()=>{
        const f=fixture('blank-clone');f.rows[0]={...f.target,bbox:{...f.target.bbox},sourceBoxes:f.target.sourceBoxes?.map(box=>({...box}))};
        const result=await f.run();expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(canvases).toHaveLength(0);expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it('源框失效撤回提示，不借用旧气泡补绘',async()=>{
        const f=fixture('blank-stale');f.target.bbox={...f.target.bbox};
        const result=await f.run();expect(result.lines[0].renderSkipped).toBe(true);expect(canvases).toHaveLength(0);
    });
    it('浅灰245虽属亮组件也不是可写空白，完整译文继续保留在阅读结果',async()=>{
        const f=fixture('blank-gray');for(let p=0;p<f.pixels.length;p+=4)if(f.pixels[p]===255)f.pixels.set([245,245,245,255],p);
        const result=await f.run();expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(canvases).toHaveLength(1);expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    });
    it('全文无法以源字号放入时不缩成小字、不发布部分图块',async()=>{
        const f=fixture('blank-too-long');sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文'.repeat(256),'KEEP']}:undefined));
        const result=await f.run();expect(result.lines[0].text).toBe('译文'.repeat(256));expect(result.lines[0].renderSkipped).toBe(true);
        expect(result.mangaPatches?.patches).toEqual([]);expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    });
    it('原文全部保留时绘字失败仍传播首因并释放自有画布',async()=>{
        const f=fixture('blank-draw-error'),error=new Error('native glyph draw failed');mocks.mangaDraw.mockImplementation(()=>{throw error;});
        await expect(f.run()).rejects.toBe(error);expect(mocks.encode).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();
        expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);expect(images[0].src).toBe('');
    });
    it('原像素读回后取消不绘字或发布补绘图块',async()=>{
        const f=fixture('blank-cancel'),controller=new AbortController(),make=document.createElement.bind(document);
        vi.stubGlobal('document',{createElement:vi.fn((...args:Parameters<typeof document.createElement>)=>{const canvas=make(...args) as unknown as ReturnType<typeof createCanvasStub>;canvas.context.getImageData.mockImplementation(()=>{controller.abort();return{data:f.pixels};});return canvas;})});
        await expect(f.run(controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
        expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it('正常清字译文与另放译文共存，各用自己的绘制范围且不把原文冲突交给修补',async()=>{
        const f=fixture('blank-with-normal'),far:MangaRegion={text:'DISTANT',bbox:{x0:220,y0:30,x1:270,y1:45},fontSize:10};
        f.rows.push(far);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文完整','KEEP','远处译文']}:undefined));
        const result=await f.run();
        expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.repair.mock.calls[0][3]).toEqual([expect.objectContaining({text:'远处译文',bbox:far.bbox})]);
        expect(mocks.mangaDraw).toHaveBeenCalledTimes(2);
        expect(mocks.mangaDraw.mock.calls[0][4]).toEqual([expect.objectContaining({text:'远处译文',bbox:far.bbox})]);
        expect(mocks.mangaDraw.mock.calls[1][4]).toEqual([expect.objectContaining({text:'译文完整',sourceBoxes:[]})]);
        expect(result.lines.map(line=>[line.sourceText,line.text,line.renderSkipped===true])).toEqual([['SOURCE TARGET','译文完整',false],['KEEP','KEEP',false],['DISTANT','远处译文',false]]);
        expect(canvases[0].context.putImageData).toHaveBeenCalledOnce();expect(result.mangaPatches?.patches).toHaveLength(2);
        expect(mocks.mangaRecognize).toHaveBeenCalledOnce();expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')).toHaveLength(1);
    });
    it('同一气泡连续补绘避开已选矩形及其余量，不重叠也不复用原文框',async()=>{
        const key='blank-two',f=fixture(key),second:MangaRegion={...f.target,text:'SECOND TARGET',bbox:{...f.target.bbox},sourceBoxes:f.target.sourceBoxes?.map(box=>({...box}))};
        f.ink(14,40,87,42);f.rows.splice(1,0,second);recordMangaBubblePlacement(second,f.owner,f.width,f.height);bindMangaBubblePlacements(f.rows,key,f.width,f.height);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['完整第一','完整第二','KEEP']}:undefined));
        const result=await f.run(),placed=mocks.mangaDraw.mock.calls[0][4] as MangaRegion[];
        expect(placed).toHaveLength(2);expect(placed.map(line=>line.text)).toEqual(['完整第一','完整第二']);
        const [a,b]=placed.map(line=>line.bbox);expect(a.x1+2<=b.x0||b.x1+2<=a.x0||a.y1+2<=b.y0||b.y1+2<=a.y0).toBe(true);
        expect(result.lines.map(line=>line.renderSkipped===true)).toEqual([false,false,false]);expect(result.lines[0].bbox).toEqual(f.target.bbox);expect(result.lines[1].bbox).toEqual(second.bbox);
        expect(mocks.repair).not.toHaveBeenCalled();expect(canvases[0].context.getImageData).toHaveBeenCalledOnce();expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
    });
    it('数字保护即使框内看似纯白也完整避让，guard不占阅读索引或送翻译',async()=>{
        const f=fixture('blank-numeric'),guard={x0:12,y0:12,x1:88,y1:43};
        f.rows.unshift({text:'99',bbox:guard,fontSize:10,guardOnly:true});
        f.rows.push({text:'42',bbox:{x0:300,y0:30,x1:320,y1:40},fontSize:10});
        const result=await f.run(),placed=(mocks.mangaDraw.mock.calls[0][4] as MangaRegion[])[0];
        expect(placed.bbox.y0).toBeGreaterThanOrEqual(guard.y1+3);expect(result.lines.map(line=>line.sourceText)).toEqual(['SOURCE TARGET','KEEP','42']);
        expect(result.lines[0].renderSkipped).toBeUndefined();expect(result.lines[2]).toMatchObject({sourceText:'42',text:'42'});
        expect(sendMessage.mock.calls.find(([message])=>message.type==='fluentReadImageTranslateTexts')?.[0].texts).toEqual(['SOURCE TARGET','KEEP']);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
    });
    it.each([NaN,0])('保留原文的无效字号 %s 撤回补绘，但完整阅读译文不丢失',async fontSize=>{
        const f=fixture(`blank-invalid-font-${fontSize}`);f.retained.fontSize=fontSize;
        const result=await f.run();expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
    });
    it('完全在图外的保留框裁空后不占原图空白，也不改变全文顺序',async()=>{
        const f=fixture('blank-clipped-original');f.rows.push({text:'OUTSIDE',bbox:{x0:450,y0:30,x1:470,y1:40},fontSize:10});
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文完整','KEEP','OUTSIDE']}:undefined));
        const result=await f.run();expect(result.lines.map(line=>line.sourceText)).toEqual(['SOURCE TARGET','KEEP','OUTSIDE']);expect(result.lines[0].renderSkipped).toBeUndefined();
        expect(mocks.mangaDraw).toHaveBeenCalledOnce();expect(mocks.repair).not.toHaveBeenCalled();
    });
    it('像素读回期间原对象变化后再次核对身份，撤回迟到的旧位置提示',async()=>{
        const f=fixture('blank-changed-during-read'),make=document.createElement.bind(document);
        vi.stubGlobal('document',{createElement:vi.fn((...args:Parameters<typeof document.createElement>)=>{const canvas=make(...args) as unknown as ReturnType<typeof createCanvasStub>;canvas.context.getImageData.mockImplementation(()=>{f.target.bbox={...f.target.bbox};return{data:f.pixels};});return canvas;})});
        const result=await f.run();expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it.each([8188,8189])('原文障碍达上限附近（额外 %s 源框）时有界结束，不发布未准入的下一处补绘',async sourceCount=>{
        const key=`blank-obstacle-cap-${sourceCount}`,f=fixture(key),second:MangaRegion={...f.target,text:'SECOND TARGET',bbox:{...f.target.bbox},sourceBoxes:f.target.sourceBoxes?.map(box=>({...box}))};
        f.rows.splice(1,0,second);recordMangaBubblePlacement(second,f.owner,f.width,f.height);bindMangaBubblePlacements(f.rows,key,f.width,f.height);
        f.rows.push({text:'DISTANT',bbox:{x0:220,y0:140,x1:270,y1:150},fontSize:10,sourceBoxes:Array.from({length:sourceCount},(_,index)=>{
            const x=100+index%281,y=3+Math.floor(index/281);return{x0:x,y0:y,x1:x+1,y1:y+1};
        })});
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['完整第一','完整第二','KEEP','远处译文']}:undefined));
        const result=await f.run(),drawn=mocks.mangaDraw.mock.calls.flatMap(call=>(call[4] as MangaRegion[]).map(line=>line.text));
        expect(drawn).toContain('远处译文');expect(drawn).not.toContain('完整第二');
        expect(result.lines[0].renderSkipped===true).toBe(sourceCount===8189);expect(result.lines[1].renderSkipped).toBe(true);
        expect(drawn.includes('完整第一')).toBe(sourceCount===8188);expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
    });
    it.each([{x:0,y:50,width:400,height:100},{x:15,y:50,width:100,height:80}])('分段核心 %j 不再裁断原本位于上方padding的补绘，改用完整可见空处',async viewport=>{
        const f=fixture(`blank-viewport-${viewport.x}`),result=await f.run(undefined,viewport);
        expect(result.lines[0].renderSkipped).toBeUndefined();expect(result.lines[0].bbox).toEqual(f.target.bbox);
        expect(mocks.mangaDraw).toHaveBeenCalledOnce();const placed=mocks.mangaDraw.mock.calls[0][4][0] as MangaRegion;
        expect(placed.bbox.x0).toBeGreaterThanOrEqual(viewport.x);expect(placed.bbox.y0).toBeGreaterThanOrEqual(viewport.y);
        expect(placed.bbox.x1).toBeLessThanOrEqual(viewport.x+viewport.width);expect(placed.bbox.y1).toBeLessThanOrEqual(viewport.y+viewport.height);
        expect(placed.bbox.y0).toBeGreaterThanOrEqual(51);expect(placed.text).toBe('译文完整');expect(placed.sourceBoxes).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
    });
    it('完整图像viewport与未分段路径同样保留原文并显示完整补绘',async()=>{
        const f=fixture('blank-full-viewport'),result=await f.run(undefined,{x:0,y:0,width:f.width,height:f.height});
        expect(result.lines[0].renderSkipped).toBeUndefined();expect(mocks.mangaDraw).toHaveBeenCalledOnce();expect(result.mangaPatches?.patches).toHaveLength(1);
    });
    it('没有独立sourceBoxes的有效源段也按整个bbox遵守可见核心',async()=>{
        const f=fixture('blank-viewport-no-source-boxes',{sourceBoxes:undefined}),result=await f.run(undefined,{x:0,y:50,width:400,height:100});
        expect(result.lines[0].renderSkipped).toBeUndefined();expect(mocks.mangaDraw).toHaveBeenCalledOnce();
        const placed=mocks.mangaDraw.mock.calls[0][4][0] as MangaRegion;expect(placed.bbox.y0).toBeGreaterThanOrEqual(50);expect(placed.bbox.y1).toBeLessThanOrEqual(150);
    });
    it.each([
        {x:21,y:0,width:100,height:160},{x:0,y:71,width:400,height:89},
        {x:0,y:0,width:79,height:160},{x:0,y:0,width:400,height:99},
        {x:0,y:110,width:400,height:50},
    ])('源段跨边界或只在padding时不能把全文搬进邻段核心 %j',async viewport=>{
        const f=fixture(`blank-outside-core-${viewport.x}-${viewport.y}-${viewport.width}-${viewport.height}`),result=await f.run(undefined,viewport);
        expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(canvases).toHaveLength(0);expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();
    });
    it('段落bbox在核心内但其中物理源框越界时仍保留完整阅读译文',async()=>{
        const f=fixture('blank-physical-outside-core',{sourceBoxes:[{x0:20,y0:40,x1:80,y1:60},{x0:20,y0:70,x1:80,y1:100}]}),result=await f.run(undefined,{x:0,y:50,width:400,height:100});
        expect(result.lines[0].renderSkipped).toBe(true);expect(result.mangaPatches?.patches).toEqual([]);expect(canvases).toHaveLength(0);
    });
    it.each([
        null,false,0,'', 'invalid',[],{},
        {x:.5,y:0,width:400,height:160},{x:-1,y:0,width:400,height:160},
        {x:0,y:-1,width:400,height:160},{x:0,y:0,width:0,height:160},
        {x:0,y:0,width:400,height:0},{x:0,y:0,width:401,height:160},
        {x:0,y:0,width:400,height:161},
    ])('明确提供的非法viewport %j 仅撤回补绘，不能退回全图权限',async viewport=>{
        const f=fixture(`blank-malformed-core-${JSON.stringify(viewport)}`),result=await f.run(undefined,viewport as ImageViewport);
        expect(result.lines[0]).toMatchObject({text:'译文完整',renderSkipped:true});expect(result.mangaPatches?.patches).toEqual([]);
        expect(canvases).toHaveLength(0);expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.repair).not.toHaveBeenCalled();
    });
    it('非法补绘viewport不影响原本可绘制的正常漫画段落',async()=>{
        const f=fixture('blank-invalid-normal'),other:MangaRegion={text:'OTHER',bbox:{x0:120,y0:70,x1:170,y1:90},fontSize:10};f.rows.push(other);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['译文完整','KEEP','正常译文']}:undefined));
        const result=await f.run(undefined,null as unknown as ImageViewport);
        expect(result.lines[0].renderSkipped).toBe(true);expect(result.lines[2]).toMatchObject({text:'正常译文'});expect(result.lines[2].renderSkipped).toBeUndefined();
        expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.repair.mock.calls[0][3]).toMatchObject([{text:'正常译文',bbox:other.bbox}]);
        expect(mocks.mangaDraw).toHaveBeenCalledOnce();expect(mocks.mangaDraw.mock.calls[0][4]).toMatchObject([{text:'正常译文'}]);
    });

});
