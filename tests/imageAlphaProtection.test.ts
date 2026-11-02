/**
 * @file tests/imageAlphaProtection.test.ts
 * 普通图片 alpha 的真实修补/绘制编排回归；仅 OCR、RPC、编码和 Canvas 是受控端口。
 * 固定源孔/艺术坐标是 oracle。Canvas 使用整数像素 source-over 与确定字形 stamp，
 * 不代表浏览器字体、颜色管理或低 alpha 的实际 premultiplication 精度。
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';

const mocks=vi.hoisted(()=>({recognize:vi.fn(),encode:vi.fn(),mangaRecognize:vi.fn(),repair:vi.fn()}));
vi.mock('@/src/features/image-translation/services/ocrRuntime',()=>({recognizeImage:mocks.recognize}));
vi.mock('@/src/features/image-translation/services/mangaOcr',()=>({mangaOcrRuntime:{recognize:mocks.mangaRecognize}}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{repair:mocks.repair}}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
import {translateImageInOffscreen} from '@/src/features/image-translation/services/offscreenRuntime';
import * as imageInpainting from '@/src/features/image-translation/services/inpainting';

const Pixels=Uint8ClampedArray;
type Rgba=readonly [number,number,number,number];
type Rect={x0:number;y0:number;x1:number;y1:number};
type Surface={width:number;height:number;pixels:Uint8ClampedArray};
const levels=[0,1,32,96,128,254,255] as const;
const background:Rgba=[232,219,191,255];
const art:Rect={x0:1,y0:72,x1:127,y1:78};
const bbox={x0:12,y0:12,x1:116,y1:64};
const originalLine:ImageTextRegion={text:'SOURCE',bbox,fontSize:16,sourceBoxes:[bbox]};
const inside=(r:Rect,x:number,y:number)=>x>=r.x0&&x<r.x1&&y>=r.y0&&y<r.y1;
const at=(p:Uint8ClampedArray,width:number,x:number,y:number)=>Array.from(p.subarray((y*width+x)*4,(y*width+x)*4+4));
function fill(p:Uint8ClampedArray,width:number,r:Rect,rgba:Rgba){
    for(let y=r.y0;y<r.y1;y++)for(let x=r.x0;x<r.x1;x++)p.set(rgba,(y*width+x)*4);
}
function scene(alpha=255,withHoles=true){
    const width=128,height=80,pixels=new Pixels(width*height*4);
    fill(pixels,width,{x0:0,y0:0,x1:width,y1:height},[...background.slice(0,3),alpha] as unknown as Rgba);
    fill(pixels,width,art,[63,143,207,96]);
    // Two fixed original-ink strokes: the output must actually erase/replace something.
    fill(pixels,width,{x0:20,y0:20,x1:24,y1:31},[11,23,31,255]);
    fill(pixels,width,{x0:29,y0:20,x1:33,y1:31},[11,23,31,255]);
    const holes=withHoles?levels.map((a,i)=>({x0:20+i*13,y0:46,x1:23+i*13,y1:50,rgba:[17+i*7,53,191-i*11,a] as Rgba})):[];
    for(const h of holes)fill(pixels,width,h,h.rgba);
    return {width,height,pixels,holes};
}
let source=scene();
let translations=['FULL TEXT'];
let canvases:PixelCanvas[]=[];
let images:PixelImage[]=[];
let encoded:Uint8ClampedArray[]=[];
let fills:Array<{text:string;attempted:number;painted:number}>=[];
let action:((stage:string,canvas:PixelCanvas)=>void)|undefined;
let metrics:'complete'|'missing'|'zero'='complete';
let glyphSupport=new Set<number>();

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
            const size=this.fontSize(),width=text.length*size*.45;
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
        putImageData:(image:{data:Uint8ClampedArray;width:number;height:number},x:number,y:number)=>{
            action?.('write',this);this.writes++;
            for(let row=0;row<image.height;row++)for(let col=0;col<image.width;col++)this.pixels.set(image.data.subarray((row*image.width+col)*4,(row*image.width+col+1)*4),((y+row)*this.w+x+col)*4);
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

const translate=(signal?:AbortSignal)=>translateImageInOffscreen('fixture-alpha','en','Alpha fixture',signal);
function completeGlyphs(text='FULL TEXT'){
    expect(fills.map(f=>f.text).join(' ')).toBe(text);
    expect(fills.every(f=>f.attempted>0&&f.painted===f.attempted)).toBe(true);
}
function released(){
    expect(canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
    expect(images.every(i=>i.src===''&&i.onload===null&&i.onerror===null)).toBe(true);
}
function assertArt(pixels:Uint8ClampedArray){
    for(let y=art.y0;y<art.y1;y++)for(let x=art.x0;x<art.x1;x++)expect(at(pixels,source.width,x,y)).toEqual([63,143,207,96]);
}
beforeEach(()=>{
    vi.clearAllMocks();source=scene();translations=['FULL TEXT'];canvases=[];images=[];encoded=[];fills=[];action=undefined;metrics='complete';glyphSupport=new Set<number>();
    mocks.recognize.mockResolvedValue([{...originalLine}]);mocks.mangaRecognize.mockResolvedValue([]);
    mocks.encode.mockImplementation(async(canvas:PixelCanvas,signal?:AbortSignal)=>{
        action?.('encode',canvas);if(signal?.aborted)throw new DOMException('cancelled','AbortError');
        encoded.push(new Pixels(canvas.pixels));return 'data:image/png;base64,alpha-final';
    });
    vi.stubGlobal('Image',PixelImage);vi.stubGlobal('document',{createElement:()=>new PixelCanvas()});
    vi.stubGlobal('chrome',{runtime:{sendMessage:(message:{type:string},callback:(value?:unknown)=>void)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations}:undefined)}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('普通译图真实修补与绘制保留原始 alpha 证据',()=>{
    it('完整alpha阶梯孔逐RGBA保留，255控制区能修补且整段译文真实绘入',async()=>{
        const before=new Pixels(source.pixels),result=await translate();
        expect(result.image).toBe('data:image/png;base64,alpha-final');expect(encoded).toHaveLength(1);
        for(const h of source.holes)if(h.rgba[3]<255)for(let y=h.y0;y<h.y1;y++)for(let x=h.x0;x<h.x1;x++){
            expect(at(encoded[0],source.width,x,y)).toEqual(h.rgba[3]===0?[0,0,0,0]:Array.from(h.rgba));
        }
        expect(at(encoded[0],source.width,99,47)).toEqual(Array.from(background));
        expect(at(encoded[0],source.width,20,25)).not.toEqual([11,23,31,255]);
        assertArt(encoded[0]);completeGlyphs();expect(source.pixels).toEqual(before);released();
    });
    it('均匀半透明底只保护更低alpha孔，合法新glyph可提高未保护底的alpha',async()=>{
        source=scene(128);source.holes=source.holes.filter(h=>h.rgba[3]<128);
        // Restore high-alpha controls to the uniform translucent background.
        fill(source.pixels,source.width,{x0:70,y0:44,x1:108,y1:52},[232,219,191,128]);
        const result=await translate();expect(result.image).toBeTruthy();expect(encoded).toHaveLength(1);
        for(const h of source.holes)for(let y=h.y0;y<h.y1;y++)for(let x=h.x0;x<h.x1;x++)expect(at(encoded[0],source.width,x,y)).toEqual(h.rgba[3]===0?[0,0,0,0]:Array.from(h.rgba));
        expect(encoded[0].some((v,i)=>i%4===3&&v===255)).toBe(true);
        expect(at(encoded[0],source.width,112,56)[3]).toBe(128);assertArt(encoded[0]);completeGlyphs();released();
    });
    it('完整alpha0底不是全图禁止绘字，允许完整新glyph并保持框外透明艺术',async()=>{
        source=scene(0,false);fill(source.pixels,source.width,art,[0,0,0,0]);
        const result=await translate();expect(result.image).toBeTruthy();completeGlyphs();
        expect(encoded[0].some((v,i)=>i%4===3&&v===255)).toBe(true);
        expect(at(encoded[0],source.width,1,1)).toEqual([0,0,0,0]);released();
    });
    it.each(['mixed-perimeter','touch-page-edge'] as const)('不确定%s且写足迹含透明像素时原子保留原图与完整阅读文字',async mode=>{
        // Repair [8,8,120,68] also reads context [7,7,121,69]; this is its true outside ring.
        if(mode==='mixed-perimeter')fill(source.pixels,source.width,{x0:6,y0:6,x1:7,y1:7},[232,219,191,254]);
        else mocks.recognize.mockResolvedValue([{...originalLine,bbox:{x0:0,y0:12,x1:116,y1:64},sourceBoxes:[{x0:0,y0:12,x1:116,y1:64}]}]);
        const result=await translate();
        expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'SOURCE',text:'FULL TEXT',renderSkipped:true}]});
        expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);released();
    });
    it('原repair环已被完整读取上下文包住时按内部保护处理，不误认未知外部环',async()=>{
        fill(source.pixels,source.width,{x0:7,y0:7,x1:8,y1:8},[232,219,191,254]);
        expect((await translate()).image).toBeTruthy();completeGlyphs();
        expect(at(encoded[0],source.width,7,7)).toEqual([232,219,191,254]);
        for(const h of source.holes)if(h.rgba[3]<255)expect(at(encoded[0],source.width,h.x0,h.y0)).toEqual(h.rgba[3]===0?[0,0,0,0]:Array.from(h.rgba));
        released();
    });
    it('同一孔位于两个实际重叠区域仍不累积覆盖，两条完整译文都可读',async()=>{
        const first={text:'FIRST',fontSize:12,bbox:{x0:12,y0:12,x1:78,y1:56},sourceBoxes:[{x0:12,y0:12,x1:78,y1:56}]};
        const second={text:'SECOND',fontSize:12,bbox:{x0:54,y0:30,x1:116,y1:64},sourceBoxes:[{x0:54,y0:30,x1:116,y1:64}]};
        source=scene(255,false);fill(source.pixels,source.width,{x0:62,y0:46,x1:65,y1:50},[17,53,191,32]);
        translations=['ONE','TWO'];mocks.recognize.mockResolvedValue([first,second]);
        const result=await translate();expect(result.lines.map(l=>l.text)).toEqual(['ONE','TWO']);expect(result.image).toBeTruthy();
        for(let y=46;y<50;y++)for(let x=62;x<65;x++)expect(at(encoded[0],source.width,x,y)).toEqual([17,53,191,32]);
        completeGlyphs('ONE TWO');assertArt(encoded[0]);released();
    });
    it.each(['paragraph-gap','draw-y-padding','draw-y-padding-unknown'] as const)('保护实际%s内的孔，不把原inpaint矩形当完整绘字足迹',async mode=>{
        source=scene(255,false);
        const hole=mode==='paragraph-gap'?{x0:22,y0:42,x1:24,y1:44}:{x0:21,y0:36,x1:23,y1:37};
        fill(source.pixels,source.width,hole,[17,53,191,32]);
        const line=mode==='paragraph-gap'
            ?{...originalLine,sourceBoxes:[{x0:12,y0:12,x1:116,y1:24},{x0:12,y0:52,x1:116,y1:64}]}
            :{...originalLine,fontSize:40,bbox:{x0:12,y0:30,x1:116,y1:34},sourceBoxes:[{x0:12,y0:30,x1:116,y1:34}]};
        if(mode==='paragraph-gap')translations=['AA\nBB'];
        // For the padding pair the write envelope is [10,23,118,41]. Its top
        // outer ring differs only in the negative control; the repair ring is internal.
        if(mode==='draw-y-padding-unknown')fill(source.pixels,source.width,{x0:10,y0:22,x1:11,y1:23},[232,219,191,254]);
        mocks.recognize.mockResolvedValue([line]);
        const result=await translate();
        if(mode==='draw-y-padding-unknown'){
            expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{text:'FULL TEXT',renderSkipped:true}]});
            expect(canvases[0].writes).toBe(0);expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);released();return;
        }
        expect(result.image).toBeTruthy();
        for(let y=hole.y0;y<hole.y1;y++)for(let x=hole.x0;x<hole.x1;x++)expect(at(encoded[0],source.width,x,y)).toEqual([17,53,191,32]);
        completeGlyphs(mode==='paragraph-gap'?'AA BB':'FULL TEXT');assertArt(encoded[0]);released();
    });
    it.each(['missing','zero'] as const)('受孔影响的译文缺少可靠%s墨迹指标时不靠clip裁字伪造成功',async kind=>{
        metrics=kind;const result=await translate();
        expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{text:'FULL TEXT',renderSkipped:true}]});
        expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);released();
    });
    it.each(['missing','zero'] as const)('opaque原路径不因%s墨迹指标触发alpha预检或丢完整译文',async kind=>{
        source=scene(255,false);metrics=kind;
        expect((await translate()).image).toBeTruthy();completeGlyphs();
        expect(canvases[0].context.measureText).toHaveBeenCalledTimes(2);released();
    });
    it('空白行保留合法留白，不能按空墨迹拒绝整段译文或挤掉两端完整行',async()=>{
        translations=['A\n\nB'];const result=await translate();expect(result.image).toBeTruthy();
        expect(fills.map(f=>f.text)).toEqual(['A','','B']);
        expect(fills.filter(f=>f.text).every(f=>f.attempted>0&&f.attempted===f.painted)).toBe(true);
        for(const h of source.holes)if(h.rgba[3]<255)expect(at(encoded[0],source.width,h.x0,h.y0)).toEqual(h.rgba[3]===0?[0,0,0,0]:Array.from(h.rgba));
        released();
    });
    it('保留原文与候选重叠时不为保护孔而擦除原文，也不丢弃译文阅读结果',async()=>{
        const retained={text:'KEEP',fontSize:16,bbox:{x0:40,y0:30,x1:76,y1:50},sourceBoxes:[{x0:40,y0:30,x1:76,y1:50}]};
        translations=['FULL TEXT','KEEP'];mocks.recognize.mockResolvedValue([{...originalLine},retained]);
        const result=await translate();expect(result.image).toBe('');expect(result.imageUnchanged).toBe(true);
        expect(result.lines.map(l=>({text:l.text,skipped:l.renderSkipped}))).toEqual([{text:'FULL TEXT',skipped:true},{text:'KEEP',skipped:undefined}]);
        expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);released();
    });
    it.each(['read','write','glyph','encode'] as const)('%s故障保留原错误、释放全部资源，随后同图可重试',async stage=>{
        const failure=new Error('exact fixture '+stage);let failed=false;
        action=point=>{if(point===stage&&!failed){failed=true;throw failure;}};
        await expect(translate()).rejects.toBe(failure);expect(encoded).toHaveLength(0);released();
        action=undefined;fills=[];expect((await translate()).image).toBeTruthy();completeGlyphs();released();
    });
    it.each(['read','write','glyph','encode'] as const)('%s后取消不发布迟到译图且同源重试没有旧保护证据污染',async stage=>{
        const controller=new AbortController();action=point=>{if(point===stage)controller.abort();};
        await expect(translate(controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(encoded).toHaveLength(0);released();
        action=undefined;fills=[];source=scene(255,false);
        expect((await translate()).image).toBeTruthy();completeGlyphs();released();
    });
    it('opaque路径只使用已有整页读写，不额外复制整页RGBA或为alpha再创建Canvas',async()=>{
        source=scene(255,false);fill(source.pixels,source.width,art,[63,143,207,255]);
        const copies:number[]=[];
        vi.stubGlobal('Uint8ClampedArray',class extends Pixels {
            constructor(value:number|ArrayLike<number>){if(typeof value==='number')super(value);else super(value);copies.push(this.length);}
        });
        expect((await translate()).image).toBeTruthy();completeGlyphs();
        expect(canvases).toHaveLength(1);expect(canvases[0].reads).toEqual([[0,0,128,80]]);expect(canvases[0].writes).toBe(1);
        expect(canvases[0].context.measureText).toHaveBeenCalledTimes(2);
        expect(copies.filter(n=>n===128*80*4)).toEqual([]);released();
    });
    it.each([255,96])('已知matte=%i在孔附近不被RGBA扩散稀释，原ink及新glyph之外逐像素保持实心底',async matte=>{
        source=scene(matte,false);
        const bg:Rgba=[232,219,191,matte],hole={x0:21,y0:36,x1:23,y1:37};
        // Keep all original ink inside the declared source box, away from the real outer ring.
        fill(source.pixels,source.width,{x0:20,y0:20,x1:24,y1:31},bg);
        fill(source.pixels,source.width,{x0:29,y0:20,x1:33,y1:31},bg);
        const ink={x0:40,y0:30,x1:44,y1:34};
        fill(source.pixels,source.width,ink,[11,23,31,255]);
        fill(source.pixels,source.width,hole,[17,53,191,32]);
        mocks.recognize.mockResolvedValue([{...originalLine,fontSize:40,bbox:{x0:12,y0:30,x1:116,y1:34},sourceBoxes:[{x0:12,y0:30,x1:116,y1:34}]}]);
        expect((await translate()).image).toBeTruthy();completeGlyphs();
        expect(glyphSupport.has(35*source.width+21)).toBe(false);
        expect(at(encoded[0],source.width,21,35)).toEqual(Array.from(bg));
        const changed:Array<{x:number;y:number;rgba:number[]}>=[];
        for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
            if(inside(art,x,y)||inside(ink,x,y)||inside(hole,x,y)||glyphSupport.has(y*source.width+x))continue;
            expect(at(source.pixels,source.width,x,y)).toEqual(Array.from(bg));
            const rgba=at(encoded[0],source.width,x,y);
            if(rgba.some((v,i)=>v!==bg[i]))changed.push({x,y,rgba});
        }
        expect(changed,'Authored constant matte, not the legacy diffusion output').toEqual([]);
        expect(at(encoded[0],source.width,21,36)).toEqual([17,53,191,32]);assertArt(encoded[0]);released();
    });
    it('repair仅读取的一像素上下文孔也不能污染写入区，不能只保护写入足迹',async()=>{
        source=scene(255,false);
        fill(source.pixels,source.width,art,background);
        fill(source.pixels,source.width,{x0:20,y0:20,x1:24,y1:31},background);
        fill(source.pixels,source.width,{x0:29,y0:20,x1:33,y1:31},background);
        const ink={x0:40,y0:40,x1:44,y1:50};fill(source.pixels,source.width,ink,[11,23,31,255]);
        fill(source.pixels,source.width,{x0:120,y0:50,x1:121,y1:51},[17,53,191,32]);
        mocks.recognize.mockResolvedValue([{text:'SOURCE',fontSize:10,bbox:{x0:12,y0:30,x1:116,y1:70},sourceBoxes:[{x0:12,y0:30,x1:116,y1:70}]}]);
        // Repair ends at x120; drawing ends at x118. The hole is outside both writes,
        // but x119's eight-neighbor diffusion reads it. Source geometry is fixed here.
        expect((await translate()).image).toBeTruthy();completeGlyphs();
        expect(glyphSupport.has(50*source.width+119)).toBe(false);
        expect(at(encoded[0],source.width,119,50)).toEqual(Array.from(background));
        expect(at(encoded[0],source.width,120,50)).toEqual([17,53,191,32]);released();
    });
    it('透明保护环封死待修原字岛时原子保留原图与完整阅读，不留下旧字再叠新字',async()=>{
        source=scene(255,false);
        fill(source.pixels,source.width,{x0:20,y0:20,x1:24,y1:31},background);
        fill(source.pixels,source.width,{x0:29,y0:20,x1:33,y1:31},background);
        const hole:Rgba=[17,53,191,0];
        for(const r of [{x0:30,y0:36,x1:98,y1:37},{x0:30,y0:49,x1:98,y1:50},{x0:30,y0:37,x1:31,y1:49},{x0:97,y0:37,x1:98,y1:49}])fill(source.pixels,source.width,r,hole);
        fill(source.pixels,source.width,{x0:60,y0:40,x1:64,y1:46},[11,23,31,255]);
        mocks.recognize.mockResolvedValue([{text:'SOURCE',fontSize:80,bbox:{x0:12,y0:30,x1:116,y1:54},sourceBoxes:[{x0:12,y0:30,x1:116,y1:54}]}]);
        const repair=vi.spyOn(imageInpainting,'inpaintTextRegions'),before=new Pixels(source.pixels);
        const result=await translate();
        // The upper clear drawing rectangle is large enough for a whole line. This
        // fallback must come from the unreachable repair island, not a font-fit failure.
        expect(repair).toHaveBeenCalledOnce();
        expect(result).toMatchObject({image:'',imageUnchanged:true,lines:[{sourceText:'SOURCE',text:'FULL TEXT',renderSkipped:true}]});
        expect(canvases[0].writes).toBe(0);expect(encoded).toHaveLength(0);expect(fills).toHaveLength(0);
        expect(source.pixels).toEqual(before);released();
    });
});
