/**
 * @file tests/imageMatteAvailability.test.ts
 * 严格alpha撤回后完整RGBA背景救援的独立编排回归；仅 OCR、RPC、编码和 Canvas 是受控端口。
 * 固定源孔/艺术坐标是 oracle。Canvas 使用整数像素 source-over 与确定字形 stamp，
 * 不代表浏览器字体、颜色管理或低 alpha 的实际 premultiplication 精度。
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';

const mocks=vi.hoisted(()=>({recognize:vi.fn(),encode:vi.fn(),mangaRecognize:vi.fn(),repair:vi.fn(),prepareSeg:vi.fn(),segment:vi.fn()}));
vi.mock('@/src/features/image-translation/services/ocrRuntime',()=>({recognizeImage:mocks.recognize}));
vi.mock('@/src/features/image-translation/services/mangaOcr',()=>({mangaOcrRuntime:{recognize:mocks.mangaRecognize}}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{repair:mocks.repair}}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient',()=>({mangaInferenceClient:{prepareTextSegmentation:mocks.prepareSeg,segmentText:mocks.segment}}));
import {translateImageInOffscreen} from '@/src/features/image-translation/services/offscreenRuntime';
import * as imageInpainting from '@/src/features/image-translation/services/inpainting';
import * as mattePage from '@/src/features/image-translation/services/imageMattePage';
import {ImageAlphaProtectionUnavailableError} from '@/src/features/image-translation/services/mangaAlphaProtection';

const Pixels=Uint8ClampedArray;
// Actual static128x80 transparent PNG bytes exercise the source-format identity
// gate. PixelImage supplies explicit test pixels; this port does not claim that
// the PNG dataURI was really decoded into each authored fixture by a browser.
const STATIC_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAYAAADRAH3kAAAAPklEQVR4nO3BMQEAAADCoPVP7W8GoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA3oFAAAZvnUfcAAAAASUVORK5CYII=';
let inputImage=STATIC_PNG;
type Rgba=readonly [number,number,number,number];
type Rect={x0:number;y0:number;x1:number;y1:number};
type Surface={width:number;height:number;pixels:Uint8ClampedArray};
const box={x0:28,y0:24,x1:100,y1:52};
const originalLine:ImageTextRegion={text:'SOURCE',bbox:box,fontSize:16,sourceBoxes:[box]};
const inside=(r:Rect,x:number,y:number)=>x>=r.x0&&x<r.x1&&y>=r.y0&&y<r.y1;
const at=(p:Uint8ClampedArray,width:number,x:number,y:number)=>Array.from(p.subarray((y*width+x)*4,(y*width+x)*4+4));
function fill(p:Uint8ClampedArray,width:number,r:Rect,rgba:Rgba){for(let y=r.y0;y<r.y1;y++)for(let x=r.x0;x<r.x1;x++)p.set(rgba,(y*width+x)*4);}
const mattes:Record<number,Rgba>={224:[48,104,124,224],208:[48,104,124,208],0:[0,0,0,0],255:[10,19,29,255]};
// Literal source-over bytes, independently frozen from the source-layer analysis/Pillow;
// expected output below is the observed matte itself, never a production planner result.
const aa:Record<number,readonly Rgba[]>={
 224:[[49,105,125,224],[77,125,142,228],[131,165,177,236],[158,184,193,239],[254,254,255,255],[255,255,255,255]],
 208:[[49,105,125,208],[79,127,144,214],[135,168,179,226],[162,187,196,231],[254,255,255,255],[255,255,255,255]],
 0:[[255,255,255,1],[255,255,255,32],[255,255,255,95],[255,255,255,127],[255,255,255,254],[255,255,255,255]],
 255:[[11,20,30,255],[41,49,57,255],[101,107,113,255],[132,137,142,255],[254,254,254,255],[255,255,255,255]],
};
interface Fixture extends Surface {matte:Rgba;line:ImageTextRegion;art:Array<Rect&{rgba:Rgba}>;ink:Set<number>}
function fixture(alpha=224):Fixture {
 const width=128,height=80,matte=mattes[alpha],pixels=new Pixels(width*height*4),ink=new Set<number>();
 fill(pixels,width,{x0:0,y0:0,x1:width,y1:height},matte);
 for(const r of [{x0:40,y0:40,x1:44,y1:48},{x0:54,y0:40,x1:58,y1:48}]){
  fill(pixels,width,r,[255,255,255,255]);for(let y=r.y0;y<r.y1;y++)for(let x=r.x0;x<r.x1;x++)ink.add(y*width+x);
 }
 for(let i=0;i<6;i++){pixels.set(aa[alpha][i],((40+i)*width+39)*4);ink.add((40+i)*width+39);}
 // Two differently colored external pieces connect to the observation ROI's top,
 // remain outside source bbox, and reach old repair/read geometry. No author BG
 // or mask is ever passed to the product; these literal shapes only score output.
 const lowAlpha=alpha===255?224:alpha===224?96:alpha===208?128:32;
 const art:Array<Rect&{rgba:Rgba}>=[{x0:24,y0:16,x1:26,y1:22,rgba:[48,104,124,lowAlpha]},{x0:26,y0:16,x1:27,y1:22,rgba:[130,220,224,255]}];
 for(const r of art)fill(pixels,width,r,r.rgba);
 return{width,height,pixels,matte,line:{...originalLine,bbox:{...box},sourceBoxes:[{...box}]},art,ink};
}
let source:Surface=fixture();
let translations=['FULL TEXT'];
let canvases:PixelCanvas[]=[];
let images:PixelImage[]=[];
let encoded:Uint8ClampedArray[]=[];
let fills:Array<{text:string;attempted:number;painted:number}>=[];
let action:((stage:string,canvas:PixelCanvas)=>void)|undefined;
let metrics:'complete'|'missing'|'zero'='complete';
let glyphSupport=new Set<number>();
let measureWidth:((text:string,size:number)=>number)|undefined;

class PixelImage implements Surface {
    width=source.width;height=source.height;naturalWidth=source.width;naturalHeight=source.height;
    readonly pixels=new Pixels(source.pixels);
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    private value='';
    constructor(){images.push(this);}
    get src(){return this.value;}
    set src(value:string){this.value=value;if(value)queueMicrotask(()=>this.onload?.());}
}
function color(value:string):Rgba {
    if(/^#[\da-f]{6}$/iu.test(value))return [parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16),255];
    const values=value.match(/[\d.]+/gu)?.map(Number);
    if(value.startsWith('rgb')&&values&&values.length>=3)return [values[0],values[1],values[2],values.length===4?Math.round(values[3]*255):255];
    throw new Error('Unsupported fixture color: '+value);
}

/** Small explicit Canvas port, extending the existing compositor test's source-over fake. */
class PixelCanvas implements Surface {
    private w=0;private h=0;
    pixels=new Pixels();
    private path:Rect[]=[];
    private allowed=(_x:number,_y:number)=>true;
    private stack:Array<{values:Record<string,unknown>;allowed:(x:number,y:number)=>boolean}>=[];
    reads:Array<[number,number,number,number]>=[];
    writes=0;
    uploads:Array<Rect&{args:3|7}>=[];
    readonly context={
        font:'10px sans-serif',fillStyle:'#000000',strokeStyle:'#000000',lineWidth:1,
        textAlign:'left',textBaseline:'alphabetic',lineJoin:'round',
        save:()=>{
            const values:Record<string,unknown>={};
            for(const key of ['font','fillStyle','strokeStyle','lineWidth','textAlign','textBaseline','lineJoin'] as const)values[key]=this.context[key];
            this.stack.push({values,allowed:this.allowed});
        },
        restore:()=>{const state=this.stack.pop();if(!state)throw new Error('Unbalanced fixture restore');Object.assign(this.context,state.values);this.allowed=state.allowed;},
        beginPath:()=>{this.path=[];},
        rect:(x:number,y:number,w:number,h:number)=>{this.path.push({x0:x,y0:y,x1:x+w,y1:y+h});},
        clip:(rule?:CanvasFillRule)=>{
            const rectangles=this.path.slice(),previous=this.allowed;
            this.allowed=(x,y)=>previous(x,y)&&(rule==='evenodd'?rectangles.filter(r=>inside(r,x,y)).length%2===1:rectangles.some(r=>inside(r,x,y)));
        },
        measureText:vi.fn((text:string)=>{
            action?.('measure',this);const size=this.fontSize(),width=measureWidth?.(text,size)??text.length*size*.45;
            const left=this.context.textAlign==='center'?width/2:this.context.textAlign==='right'?width:0;
            if(metrics==='missing')return {width};
            if(metrics==='zero')return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:0,actualBoundingBoxAscent:0,actualBoundingBoxDescent:0};
            return {width,actualBoundingBoxLeft:left,actualBoundingBoxRight:width-left,actualBoundingBoxAscent:size*.45,actualBoundingBoxDescent:size*.15};
        }),
        getImageData:(x:number,y:number,width:number,height:number)=>{
            action?.('read',this);this.reads.push([x,y,width,height]);
            const data=new Pixels(width*height*4);
            for(let row=0;row<height;row++)for(let col=0;col<width;col++)data.set(this.pixels.subarray(((y+row)*this.w+x+col)*4,((y+row)*this.w+x+col+1)*4),(row*width+col)*4);
            return {data,width,height};
        },
        putImageData:(image:{data:Uint8ClampedArray;width:number;height:number},x:number,y:number,dirtyX?:number,dirtyY?:number,dirtyWidth?:number,dirtyHeight?:number)=>{
            action?.('write',this);this.writes++;
            const left=Math.max(0,dirtyX??0),top=Math.max(0,dirtyY??0);
            const right=Math.min(image.width,left+(dirtyWidth??image.width)),bottom=Math.min(image.height,top+(dirtyHeight??image.height));
            this.uploads.push({x0:x+left,y0:y+top,x1:x+right,y1:y+bottom,args:dirtyWidth===undefined?3:7});
            for(let row=top;row<bottom;row++)for(let col=left;col<right;col++)this.pixels.set(image.data.subarray((row*image.width+col)*4,(row*image.width+col+1)*4),((y+row)*this.w+x+col)*4);
        },
        fillRect:(x:number,y:number,width:number,height:number)=>{this.rectangle(x,y,width,height,color(this.context.fillStyle));},
        clearRect:(x:number,y:number,width:number,height:number)=>{
            for(let row=Math.ceil(y);row<y+height;row++)for(let col=Math.ceil(x);col<x+width;col++)if(this.allowed(col,row))this.pixels.fill(0,(row*this.w+col)*4,(row*this.w+col+1)*4);
        },
        strokeText:(text:string,x:number,y:number)=>{this.glyphs(text,x,y,color(this.context.strokeStyle),false);},
        fillText:(text:string,x:number,y:number)=>{action?.('glyph',this);this.glyphs(text,x,y,color(this.context.fillStyle),true);},
        drawImage:(image:Surface,...args:number[])=>{
            action?.('draw',this);
            const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length===8?args:[0,0,image.width,image.height,args[0],args[1],args[2]??image.width,args[3]??image.height];
            for(let row=0;row<dh;row++)for(let col=0;col<dw;col++){
                const from=((sy+Math.floor(row*sh/dh))*image.width+sx+Math.floor(col*sw/dw))*4;
                this.blend(dx+col,dy+row,image.pixels.subarray(from,from+4));
            }
        },
    };
    constructor(){canvases.push(this);}
    get width(){return this.w;}set width(value:number){this.w=value;this.pixels=new Pixels(this.w*this.h*4);}
    get height(){return this.h;}set height(value:number){this.h=value;this.pixels=new Pixels(this.w*this.h*4);}
    getContext(){return this.context;}
    private fontSize(){return Number(/([\d.e+-]+)px/u.exec(this.context.font)?.[1]??10);}
    private blend(x:number,y:number,rgba:ArrayLike<number>){
        if(x<0||y<0||x>=this.w||y>=this.h||!this.allowed(x,y))return false;
        const offset=(y*this.w+x)*4,a=rgba[3]/255,b=this.pixels[offset+3]/255,out=a+b*(1-a);
        for(let c=0;c<3;c++)this.pixels[offset+c]=out?Math.round((rgba[c]*a+this.pixels[offset+c]*b*(1-a))/out):0;
        this.pixels[offset+3]=Math.round(out*255);return true;
    }
    private rectangle(x:number,y:number,width:number,height:number,rgba:Rgba){
        for(let row=Math.max(0,Math.ceil(y));row<Math.min(this.h,y+height);row++)for(let col=Math.max(0,Math.ceil(x));col<Math.min(this.w,x+width);col++)this.blend(col,row,rgba);
    }
    private glyphs(text:string,x:number,y:number,rgba:Rgba,record:boolean){
        const size=this.fontSize(),advance=size*.45,width=text.length*advance;
        const left=this.context.textAlign==='center'?x-width/2:this.context.textAlign==='right'?x-width:x;
        const top=this.context.textBaseline==='middle'?y-size*.3:y-size*.45;
        let attempted=0,painted=0;
        // A deterministic nonempty rectangular glyph for each nonspace character.
        for(let i=0;i<text.length;i++)if(!/\s/u.test(text[i])){
            for(let row=Math.ceil(top);row<top+size*.6;row++)for(let col=Math.ceil(left+i*advance);col<left+i*advance+size*.3;col++){
                glyphSupport.add(row*this.width+col);attempted++;if(this.blend(col,row,rgba))painted++;
            }
        }
        if(record)fills.push({text,attempted,painted});
    }
}

const translate=(signal?:AbortSignal)=>translateImageInOffscreen(inputImage,'en','Matte fixture',signal,undefined,false,'paddle');
function completeGlyphs(text='FULL TEXT'){
    expect(fills.map(f=>f.text).join(' ')).toBe(text);
    expect(fills.every(f=>f.attempted>0&&f.painted===f.attempted)).toBe(true);
}
function released(){
    expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    expect(images.every(i=>i.src===''&&i.onload===null&&i.onerror===null)).toBe(true);
}
// Explicit fake detector output, independent of the author ink/art oracle. Four
// sparse probability peaks support the two source strokes with the consumer's2px
// model-neighborhood rule; every other model cell is0, never an always-one mask.
const MODEL_CORE:ReadonlyArray<readonly[number,number,number]>=[[41,41,.91],[41,45,.83],[55,41,.88],[55,45,.94]];
let detectorCore:ReadonlyArray<readonly[number,number,number]>=MODEL_CORE;
let evidenceMode:'valid'|'missing'|'wrong-image'|'empty'='valid';
let recognized:ImageTextRegion[]=[];
function setRegions(regions:ImageTextRegion[]){recognized=regions;}
async function detectionEvidence(regions:ImageTextRegion[],image:string,width:number,height:number,marks:ReadonlyArray<readonly[number,number,number]>,mode:'valid'|'missing'|'wrong-image'|'empty'='valid'){
    if(mode==='missing')return;
    const {createImageDetectionEvidenceBudget,bindImageDetectionEvidence,getImageDetectionEvidence}=await import('@/src/features/image-translation/services/imageDetectionEvidence');
    // The model pads each side to a multiple of32; only the original content
    // plane supplies support. Padding remains explicit zero probability.
    const modelWidth=Math.ceil(width/32)*32,modelHeight=Math.ceil(height/32)*32;
    const budget=createImageDetectionEvidenceBudget(),raw=new Float32Array(modelWidth*modelHeight);
    if(mode!=='empty')for(const[x,y,probability]of marks)raw[y*modelWidth+x]=probability;
    budget.capture(raw,modelWidth,modelHeight,{pageWidth:width,pageHeight:height,x:0,y:0,width,height,resizeRatio:1});
    bindImageDetectionEvidence(regions,mode==='wrong-image'?image+'-wrong':image,width,height,budget.frames());
    return getImageDetectionEvidence(regions,image,width,height);
}
beforeEach(()=>{
    vi.clearAllMocks();source=fixture();translations=['FULL TEXT'];canvases=[];images=[];encoded=[];fills=[];action=undefined;metrics='complete';glyphSupport=new Set<number>();detectorCore=MODEL_CORE;evidenceMode='valid';inputImage=STATIC_PNG;measureWidth=undefined;
    mocks.prepareSeg.mockReset().mockResolvedValue(false);mocks.segment.mockReset();
    setRegions([{...originalLine}]);mocks.recognize.mockResolvedValue([]);mocks.mangaRecognize.mockImplementation(async(image:string)=>{const regions=recognized.map(r=>({...r,bbox:{...r.bbox},...(r.sourceBoxes?{sourceBoxes:r.sourceBoxes.map(b=>({...b}))}:{})}));await detectionEvidence(regions,image,source.width,source.height,detectorCore,evidenceMode);return regions;});
    mocks.encode.mockImplementation(async(canvas:PixelCanvas,signal?:AbortSignal)=>{
        action?.('encode',canvas);if(signal?.aborted)throw new DOMException('cancelled','AbortError');
        encoded.push(new Pixels(canvas.pixels));return 'data:image/png;base64,matte-final';
    });
    vi.stubGlobal('Image',PixelImage);vi.stubGlobal('document',{createElement:()=>new PixelCanvas()});
    vi.stubGlobal('chrome',{runtime:{sendMessage:(message:{type:string},callback:(value?:unknown)=>void)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations}:undefined)}});
});

describe('RGBA救援全文预算和原始源相位边界',()=>{
    it('真实DB已覆盖时不准备可选模型或分配分割张量',async()=>{
        const f=install(fixture(224));expect((await translate()).image).toBeTruthy();completeGlyphs();checkFrame(f);
        expect(mocks.prepareSeg).not.toHaveBeenCalled();expect(mocks.segment).not.toHaveBeenCalled();
    });
    it('DB未覆盖但整页/全文已成立时才检查缓存，缺失时保留完整阅读结果',async()=>{
        install(fixture(224));evidenceMode='empty';
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines[0].text).toBe('FULL TEXT');
        expect(mocks.prepareSeg).toHaveBeenCalledOnce();expect(mocks.segment).not.toHaveBeenCalled();
        expect(canvases[0].context.measureText).toHaveBeenCalled();preserved();
    });
    it('可选受控模型的量化输出经真实局部投影和全页授权后，只上传已证明源墨而不擦外部图案',async()=>{
        const f=install(fixture(224));evidenceMode='empty';mocks.prepareSeg.mockResolvedValue(true);
        // This controlled runtime returns broad learned support, not an erasure
        // mask. Real color/component/page gates must still preserve every art pixel.
        mocks.segment.mockImplementation(async(factory:()=>Float32Array)=>{
            expect(canvases[0].context.measureText).toHaveBeenCalled();expect(canvases[0].writes).toBe(0);
            const tensor=factory();expect(tensor.length).toBe(3*1024*1024);expect(tensor.buffer.byteLength).toBe(12_582_912);
            return new Uint8Array(1024*1024).fill(255);
        });
        expect((await translate()).image).toBeTruthy();expect(mocks.prepareSeg).toHaveBeenCalledOnce();expect(mocks.segment).toHaveBeenCalledOnce();
        completeGlyphs();checkFrame(f);expect(canvases[0].reads).toEqual([[0,0,f.width,f.height]]);
        for(const rect of canvases[0].uploads)for(let y=rect.y0;y<rect.y1;y++)for(let x=rect.x0;x<rect.x1;x++)expect(f.ink.has(y*f.width+x)).toBe(true);
    });
    it('分割仍不能支持全部源墨时原子撤回，不发布部分译图',async()=>{
        install(fixture(224));evidenceMode='empty';mocks.prepareSeg.mockResolvedValue(true);mocks.segment.mockResolvedValue(new Uint8Array(1024*1024));
        expect((await translate()).imageUnchanged).toBe(true);expect(mocks.segment).toHaveBeenCalledOnce();preserved();
    });
    it.each(['prepare','segment']as const)('可选分割%s未知错误保留首因，不冒充未导入缓存',async stage=>{
        install(fixture(224));evidenceMode='empty';const failure=new Error('segmentation '+stage);
        if(stage==='prepare')mocks.prepareSeg.mockRejectedValue(failure);
        else {mocks.prepareSeg.mockResolvedValue(true);mocks.segment.mockRejectedValue(failure);}
        await expect(translate()).rejects.toBe(failure);preserved();
    });
    it.each(['prepare','input','result']as const)('可选分割%s阶段取消保持零上传并释放本次提案',async stage=>{
        install(fixture(224));evidenceMode='empty';const controller=new AbortController();
        mocks.prepareSeg.mockImplementation(async()=>{if(stage==='prepare')controller.abort();return true;});
        mocks.segment.mockImplementation(async(factory:()=>Float32Array)=>{
            if(stage==='input')controller.abort();factory();if(stage==='result')controller.abort();return new Uint8Array(1024*1024).fill(255);
        });
        await expect(translate(controller.signal)).rejects.toMatchObject({name:'AbortError'});preserved();
    });
    it.each(['pre-layout','first-width','call-count']as const)('完整译文的%s预算不足时无像素发布，阅读文本不截断',async mode=>{
        install(fixture(224));
        const text=mode==='pre-layout'?'X'.repeat(4_194_305):mode==='first-width'?'X'.repeat(2_097_153):Array.from({length:12_000},(_,index)=>'W'+index.toString(36).padStart(4,'0')).join(' ');
        translations=[text];
        const result=await translate();
        expect(result.imageUnchanged).toBe(true);expect(result.lines).toHaveLength(1);
        expect(result.lines[0].text.length).toBe(text.length);expect(result.lines[0].text===text).toBe(true);expect(result.lines[0].renderSkipped).toBe(true);
        expect(canvases[0].context.measureText).toHaveBeenCalledTimes(mode==='call-count'?8191:0);preserved();
        expect(mocks.prepareSeg).not.toHaveBeenCalled();expect(mocks.segment).not.toHaveBeenCalled();
    });
    it('重复长组合字素的全文指标也预付字符工作，度量中途耗尽时整页保留完整阅读结果',async()=>{
        const f=install(fixture(224));f.line.fontSize=100;f.line.textAlign='center';setRegions([f.line]);
        // A plus combining acute marks is one visible grapheme. This controlled
        // Canvas port gives marks zero extra advance, as ordinary text metrics do;
        // hundreds of equal paragraphs reuse width cache but still owe every final
        // metrics call its full UTF-16 work. No product planner/layout is replaced.
        const paragraph='A'+'\u0301'.repeat(4095),text=Array.from({length:700},()=>paragraph).join('\n');translations=[text];
        measureWidth=(value,size)=>Array.from(value).filter(character=>!/\p{Mark}/u.test(character)).length*size*.45;
        const measuredFonts:string[]=[];action=(stage,canvas)=>{if(stage==='measure')measuredFonts.push(canvas.context.font);};
        const result=await translate();
        expect(result.imageUnchanged).toBe(true);expect(result.lines[0].text===text).toBe(true);expect(result.lines[0].renderSkipped).toBe(true);
        expect(new Set(measuredFonts).size).toBeGreaterThan(1);expect(new Set(measuredFonts).size).toBeLessThan(20);
        expect(measuredFonts.filter(font=>font===measuredFonts.at(-1)).length).toBeGreaterThan(100);expect(measuredFonts.length).toBeLessThan(8192);preserved();
    });
    it.each(['left','right','center','vertical','implicit-font']as const)('真实matte救援保留%s对齐/字号语义并完整绘字',async mode=>{
        const f=install(fixture(224));
        if(mode==='vertical')f.line.vertical=true;
        else if(mode==='implicit-font')delete f.line.fontSize;
        else f.line.textAlign=mode;
        setRegions([f.line]);expect((await translate()).image).toBeTruthy();completeGlyphs();checkFrame(f);released();
    });
    it.each(['alpha-unavailable','unexpected']as const)('真实清字完成后%s首因不能将已改源像素送回matte救援',async mode=>{
        const f=install(fixture(224));for(const r of f.art)fill(f.pixels,f.width,r,f.matte);
        const perform=imageInpainting.inpaintTextRegions,plan=vi.spyOn(mattePage,'proposeImageMattePage');
        const failure=mode==='alpha-unavailable'?new ImageAlphaProtectionUnavailableError('after real inpaint'):new Error('after real inpaint');
        let changed=false;
        const repair=vi.spyOn(imageInpainting,'inpaintTextRegions').mockImplementation((...args:Parameters<typeof perform>)=>{
            const pixels=perform(...args);changed=at(pixels,f.width,40,40).some((value,index)=>value!==f.pixels[(40*f.width+40)*4+index]);throw failure;
        });
        if(mode==='alpha-unavailable'){
            const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines[0]).toMatchObject({text:'FULL TEXT',renderSkipped:true});
        }else await expect(translate()).rejects.toBe(failure);
        const regions=await mocks.mangaRecognize.mock.results[0].value;
        const {getImageDetectionEvidence}=await import('@/src/features/image-translation/services/imageDetectionEvidence');
        const {imageMatteObservationBox}=await import('@/src/features/image-translation/services/imageMatteRepair');
        const {isSingleFrameImageData}=await import('@/src/features/image-translation/services/imageDetectionSnapshot');
        const support=getImageDetectionEvidence(regions,inputImage,f.width,f.height);
        expect(isSingleFrameImageData(inputImage)).toBe(true);expect(support?.forBox(f.line.bbox,imageMatteObservationBox(f.width,f.height,f.line.bbox)!)?.(40,40)).toBe(true);
        expect(repair).toHaveBeenCalledOnce();expect(changed).toBe(true);expect(plan).not.toHaveBeenCalled();preserved();
    });
    it('全文度量后排队的取消在首次墨迹回写前生效，同源后续重试仍完整',async()=>{
        install(fixture(224));const controller=new AbortController();let queued=false;
        action=stage=>{if(stage==='measure'&&!queued){queued=true;setTimeout(()=>controller.abort(),0);}};
        await expect(translate(controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(queued).toBe(true);preserved();
        action=undefined;expect((await translate()).image).toBeTruthy();completeGlyphs();released();
    });
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

function install(f:Fixture){source=f;setRegions([f.line]);return f;}
function preserved(){expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);expect(canvases.every(c=>c.writes===0)).toBe(true);released();}
function checkFrame(f:Fixture){
    const different:Array<{x:number;y:number;expected:number[];actual:number[]}>=[];
    for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
        const art=f.art.find(r=>inside(r,x,y));if(!art&&glyphSupport.has(y*f.width+x))continue;
        const expected=Array.from(art?.rgba??f.matte),actual=at(encoded[0],f.width,x,y);
        if(expected.some((v,i)=>v!==actual[i]))different.push({x,y,expected,actual});
    }
    expect(different,'Full authored matte/art oracle outside actual new glyph stamps').toEqual([]);
}
function pair(){
    const first=fixture(224),second=fixture(208),width=240,height=160,pixels=new Pixels(width*height*4),expected=new Pixels(width*height*4);
    fill(pixels,width,{x0:0,y0:0,x1:width,y1:height},first.matte);expected.set(pixels);
    fill(expected,width,{x0:110,y0:60,x1:238,y1:140},second.matte);
    for(const[f,dx,dy]of [[first,0,0],[second,110,60]]as const)for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)pixels.set(f.pixels.subarray((y*f.width+x)*4,(y*f.width+x+1)*4),((y+dy)*width+x+dx)*4);
    const move=(b:Rect)=>({x0:b.x0+110,y0:b.y0+60,x1:b.x1+110,y1:b.y1+60});
    const lines=[first.line,{...second.line,text:'SECOND',bbox:move(second.line.bbox),sourceBoxes:second.line.sourceBoxes!.map(move)}];
    const art=[...first.art,...second.art.map(r=>({...move(r),rgba:r.rgba}))];
    source={width,height,pixels};setRegions(lines);detectorCore=[...MODEL_CORE,...MODEL_CORE.map(([x,y,p])=>[x+110,y+60,p]as const)];translations=['FULL TEXT','FULL TEXT'];
    return{width,height,pixels,expected,lines,art};
}

describe('完整RGBA matte救援只在已证源墨上写入，整页通过才发布',()=>{
    it('独立pure负控：白moat不能授权吞掉灰牌并遗漏灰牌上的完整白字',async()=>{
        // Exact peer counterexample. The physical source box stays two pixels larger
        // than the card; no hidden author background/mask is passed into the planner.
        const width=64,height=48,pixels=new Pixels(width*height*4).fill(255);
        fill(pixels,width,{x0:20,y0:16,x1:44,y1:32},[128,128,128,255]);
        fill(pixels,width,{x0:26,y0:20,x1:29,y1:28},[0,0,0,255]);
        fill(pixels,width,{x0:35,y0:20,x1:38,y1:28},[255,255,255,255]);
        fill(pixels,width,{x0:10,y0:10,x1:18,y1:11},[130,220,224,96]);
        const {planImageMatteRepair,imageMatteObservationBox}=await import('@/src/features/image-translation/services/imageMatteRepair');
        const bbox={x0:18,y0:14,x1:46,y1:34},regions:ImageTextRegion[]=[{text:'SOURCE',bbox}];
        const evidence=await detectionEvidence(regions,STATIC_PNG,width,height,[[27,21,.9],[27,25,.86],[36,21,.92],[36,25,.88]]);
        const support=evidence!.forBox(bbox,imageMatteObservationBox(width,height,bbox)!);
        expect(support?.(27,21)).toBe(true);expect(support?.(36,25)).toBe(true);expect(support?.(20,16)).toBe(false);
        expect(planImageMatteRepair(pixels,width,height,bbox,support!,{remaining:4_194_304})).toBeUndefined();
    });
    it('独立pure负控：透明底alpha1的白红绿三点不能用宽量化区间伪称同一前景',async()=>{
        const width=32,height=32,pixels=new Pixels(width*height*4);
        pixels.set([255,255,255,1],(14*width+14)*4);pixels.set([255,0,0,1],(14*width+15)*4);pixels.set([0,255,0,1],(14*width+16)*4);
        const {planImageMatteRepair,imageMatteObservationBox}=await import('@/src/features/image-translation/services/imageMatteRepair');
        const bbox={x0:12,y0:12,x1:20,y1:20},regions:ImageTextRegion[]=[{text:'SOURCE',bbox}];
        const evidence=await detectionEvidence(regions,STATIC_PNG,width,height,[[14,14,.9],[15,14,.86],[16,14,.94]]);
        const support=evidence!.forBox(bbox,imageMatteObservationBox(width,height,bbox)!);
        for(const x of [14,15,16])expect(support?.(x,14)).toBe(true);
        // A common foreground has a fixed cross-channel order. Coverage/roundtrip
        // intervals cannot reverse red>green at one point and green>red at another.
        expect(planImageMatteRepair(pixels,width,height,bbox,support!,{remaining:4_194_304})).toBeUndefined();
    });
    it.each([224,208,0,255])('真实背景alpha=%i与opaque/半透明外边框共存，旧字含same-alpha RGB-AA也完整清除',async alpha=>{
        const f=install(fixture(alpha)),before=new Pixels(f.pixels);
        expect((await translate()).image).toBeTruthy();expect(encoded).toHaveLength(1);completeGlyphs();checkFrame(f);
        expect(at(encoded[0],f.width,39,40)).toEqual(Array.from(f.matte));
        if(alpha===224||alpha===208){expect(at(f.pixels,f.width,39,40)[3]).toBe(alpha);expect(at(f.pixels,f.width,39,40).slice(0,3)).not.toEqual(Array.from(f.matte).slice(0,3));}
        expect(canvases[0].uploads.length).toBeGreaterThan(0);
        for(const r of canvases[0].uploads){expect(r.args).toBe(7);for(let y=r.y0;y<r.y1;y++)for(let x=r.x0;x<r.x1;x++)expect(f.ink.has(y*f.width+x),'Dirty upload must contain only authored old ink').toBe(true);}
        expect(canvases[0].reads).toEqual([[0,0,f.width,f.height]]);expect(f.pixels).toEqual(before);released();
    });
    it('合法空白行不丢字；原字alpha不作为新glyph透明底位置的裁剪平面',async()=>{
        const f=install(fixture(0));translations=['A\n\nB'];expect((await translate()).image).toBeTruthy();
        expect(fills.map(f=>f.text)).toEqual(['A','','B']);expect(fills.filter(f=>f.text).every(f=>f.attempted>0&&f.attempted===f.painted)).toBe(true);
        checkFrame(f);released();
    });
    it.each(['missing','wrong-image','empty']as const)('受控Paddle端口的%s DB证据不授权RGBA救援，不把颜色闭环当source身份',async mode=>{
        install(fixture(224));evidenceMode=mode;
        const result=await translate();expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{text:'FULL TEXT',renderSkipped:true}]});preserved();
        expect(mocks.mangaRecognize).toHaveBeenCalledOnce();expect(mocks.recognize).not.toHaveBeenCalled();
    });
    it.each(['svg','unknown-uri']as const)('同一URI不能证明%s来源只有单帧时，即使DB端口有支持也不救援',async kind=>{
        install(fixture(224));
        inputImage=kind==='svg'?'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=':'https://example.test/mutable.png';
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines[0]).toMatchObject({text:'FULL TEXT',renderSkipped:true});preserved();
        expect(mocks.mangaRecognize).toHaveBeenCalledOnce();
    });
    it('源组件只有一处DB锚点不足以授权其余笔画，每个旧墨像素都必须在真实支持2px内',async()=>{
        const f=install(fixture(224));fill(f.pixels,f.width,{x0:41,y0:47,x1:42,y1:51},[255,255,255,255]);
        // Fixed detector peaks end at y45. The connected y48..50 continuation is
        // physically inside bbox, same valid ink color, but lacks model support.
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines[0]).toMatchObject({text:'FULL TEXT',renderSkipped:true});preserved();
    });
    it.each(['cross-roi','disconnected-aa','multiple-ink','lower-alpha','gradient-outside','page-edge','missing-metrics','sealed-island','no-glyph-space']as const)('无完整证据%s时原子保留原图和全文，不擦坏图案或残留旧字后叠绘',async mode=>{
        const f=install(fixture(224));
        if(mode==='cross-roi')fill(f.pixels,f.width,{x0:40,y0:16,x1:42,y1:43},[255,255,255,255]);
        if(mode==='disconnected-aa')f.pixels.set([49,105,125,224],(30*f.width+24)*4);
        if(mode==='multiple-ink')fill(f.pixels,f.width,{x0:54,y0:40,x1:58,y1:48},[255,40,80,255]);
        if(mode==='lower-alpha')f.pixels.set([17,53,191,96],(43*f.width+41)*4);
        if(mode==='gradient-outside')for(let y=16;y<60;y++)for(let x=20;x<108;x++)if(!inside(box,x,y)&&!f.art.some(r=>inside(r,x,y)))f.pixels.set([48+(x+y)%5,104,124,224],(y*f.width+x)*4);
        if(mode==='page-edge'){f.line.bbox={...box,x0:0};f.line.sourceBoxes=[f.line.bbox];}
        if(mode==='missing-metrics')metrics='missing';
        if(mode==='sealed-island')for(const r of [{x0:50,y0:37,x1:62,y1:38},{x0:50,y0:50,x1:62,y1:51},{x0:50,y0:38,x1:51,y1:50},{x0:61,y0:38,x1:62,y1:50}])fill(f.pixels,f.width,r,[17,53,191,0]);
        if(mode==='no-glyph-space'){
            fill(f.pixels,f.width,{x0:20,y0:16,x1:108,y1:60},[130,220,224,255]);
            fill(f.pixels,f.width,{x0:27,y0:29,x1:101,y1:35},f.matte);
            fill(f.pixels,f.width,{x0:40,y0:31,x1:44,y1:33},[255,255,255,255]);
            f.pixels.set([49,105,125,224],(31*f.width+39)*4);
            f.pixels.set([48,104,124,96],(16*f.width+24)*4);
            f.line={text:'SOURCE',fontSize:80,bbox:{x0:28,y0:30,x1:100,y1:34},sourceBoxes:[{x0:28,y0:30,x1:100,y1:34}]};
        }
        setRegions([f.line]);const before=new Pixels(f.pixels),result=await translate();
        expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'SOURCE',text:'FULL TEXT',renderSkipped:true}]});
        expect(f.pixels).toEqual(before);preserved();expect(mocks.prepareSeg).not.toHaveBeenCalled();expect(mocks.segment).not.toHaveBeenCalled();
    });
    it('同页两处真实matte224/208各自取观测背景，不把某一alpha或颜色推广全页',async()=>{
        const f=pair();expect((await translate()).image).toBeTruthy();completeGlyphs('FULL TEXT FULL TEXT');
        const differences=[];
        for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
            const art=f.art.find(r=>inside(r,x,y));if(!art&&glyphSupport.has(y*f.width+x))continue;
            const expected=art?Array.from(art.rgba):at(f.expected,f.width,x,y),actual=at(encoded[0],f.width,x,y);
            if(expected.some((v,i)=>v!==actual[i]))differences.push({x,y,expected,actual});
        }
        expect(differences).toEqual([]);released();
    });
    it('后一行颜色证明失败时前行即使可修也不上传或发布半页，全部译文仍可读',async()=>{
        const f=pair();f.pixels.set([17,53,191,96],(103*f.width+151)*4);
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines).toHaveLength(2);expect(result.lines.every(l=>l.text==='FULL TEXT'&&l.renderSkipped)).toBe(true);preserved();
    });
    it('两个非重叠draw计划把同一源组件分别认作ink/art时拒绝整页',async()=>{
        const a=fixture(224),b=fixture(224),width=192,height=80,pixels=new Pixels(width*height*4);fill(pixels,width,{x0:0,y0:0,x1:width,y1:height},a.matte);
        for(const[f,dx]of [[a,0],[b,62]]as const)for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){
            const value=at(f.pixels,f.width,x,y);if(value.some((v,i)=>v!==f.matte[i]))pixels.set(value,(y*width+x+dx)*4);
        }
        fill(pixels,width,{x0:78,y0:40,x1:87,y1:44},[255,255,255,255]);
        const first={...a.line,bbox:{x0:28,y0:24,x1:80,y1:52},sourceBoxes:[{x0:28,y0:24,x1:80,y1:52}]};
        const second={...b.line,text:'SECOND',bbox:{x0:90,y0:24,x1:142,y1:52},sourceBoxes:[{x0:90,y0:24,x1:142,y1:52}]};
        source={width,height,pixels};setRegions([first,second]);detectorCore=[...MODEL_CORE,...MODEL_CORE.map(([x,y,p])=>[x+62,y,p]as const),[79,41,.92],[83,41,.89],[85,41,.86]];translations=['FULL TEXT','FULL TEXT'];
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines).toHaveLength(2);preserved();
    });
    it('邻近保留原文不能为matte rescue让路，也不能丢失译文阅读结果',async()=>{
        const f=install(fixture(224));setRegions([f.line,{text:'KEEP',bbox:{x0:80,y0:30,x1:108,y1:48},sourceBoxes:[{x0:80,y0:30,x1:108,y1:48}],fontSize:16}]);translations=['FULL TEXT','KEEP'];
        const result=await translate();expect(result.imageUnchanged).toBe(true);expect(result.lines.map(l=>l.text)).toEqual(['FULL TEXT','KEEP']);preserved();
    });
    it.each(['read','measure','write','glyph','encode']as const)('rescue的%s故障保留首因并释放，随后同图重试不复用旧计划',async stage=>{
        install(fixture(224));const failure=new Error('matte '+stage);let fired=false;action=point=>{if(point===stage&&!fired){fired=true;throw failure;}};
        await expect(translate()).rejects.toBe(failure);expect(encoded).toHaveLength(0);released();
        action=undefined;fills=[];glyphSupport=new Set();expect((await translate()).image).toBeTruthy();completeGlyphs();released();
    });
    it.each(['read','measure','write','glyph','encode']as const)('rescue的%s后取消不发布迟到位图，同源随后可重试',async stage=>{
        install(fixture(224));const controller=new AbortController();action=point=>{if(point===stage)controller.abort();};
        await expect(translate(controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(encoded).toHaveLength(0);released();
        action=undefined;fills=[];glyphSupport=new Set();expect((await translate()).image).toBeTruthy();completeGlyphs();released();
    });
    it('opaque旧路径不为rescue增加整页副本/回读/画布/字体预排，保持原上传方式',async()=>{
        const f=install(fixture(255));for(const r of f.art)fill(f.pixels,f.width,r,f.matte);
        f.line={text:'SOURCE',fontSize:16,bbox:{x0:12,y0:12,x1:116,y1:64},sourceBoxes:[{x0:12,y0:12,x1:116,y1:64}]};setRegions([f.line]);
        const fullCopies:number[]=[];vi.stubGlobal('Uint8ClampedArray',class extends Pixels{constructor(value:number|ArrayLike<number>){if(typeof value==='number')super(value);else super(value);if(this.length===f.width*f.height*4)fullCopies.push(this.length);}});
        expect((await translate()).image).toBeTruthy();completeGlyphs();expect(canvases).toHaveLength(1);expect(canvases[0].reads).toEqual([[0,0,128,80]]);expect(canvases[0].uploads).toHaveLength(1);expect(canvases[0].uploads[0].args).toBe(3);expect(canvases[0].context.measureText).toHaveBeenCalledTimes(2);expect(fullCopies).toEqual([]);released();
    });
});

