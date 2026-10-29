import {beforeEach,describe,expect,it,vi} from 'vitest';
const {plan,raster,ledger}=vi.hoisted(()=>({plan:vi.fn(),raster:vi.fn(),ledger:vi.fn()}));
vi.mock('@/src/features/image-translation/services/mangaTextFlow',()=>({planMangaTextFlow:plan}));
vi.mock('@/src/features/image-translation/services/mangaGlyphRaster',()=>({rasterizeMangaGlyphs:raster,createMangaGlyphRasterLedger:ledger}));
import {drawMangaTranslations} from '@/src/features/image-translation/services/mangaRendering';
import type {MangaAlphaProtection} from '@/src/features/image-translation/services/mangaAlphaProtection';

const width=640,height=160,pixels=new Uint8ClampedArray(width*height*4).fill(255);
const region={text:'Alpha Beta café',fontSize:26,bbox:{x0:20,y0:20,x1:620,y1:85}};
const hole={x0:320,y0:20,x1:330,y1:85};
const protection=(holes=[hole]):MangaAlphaProtection=>({rectangles:holes,runs:new Uint16Array(),rowStarts:new Uint32Array()});
const backgrounds=[{uniform:false,color:'rgb(255,255,255)'}];
function context(){return {font:'',lineWidth:0,textAlign:'start',save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),fillRect:vi.fn(),strokeText:vi.fn(),fillText:vi.fn(),drawImage:vi.fn(),
    measureText:vi.fn(function(this:{font:string},text:string){const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]);return {width:Array.from(text).length*size*.6,actualBoundingBoxLeft:0,actualBoundingBoxRight:Array.from(text).length*size*.6,actualBoundingBoxAscent:size*.7,actualBoundingBoxDescent:size*.2};})};}
function accepted(){return {kind:'accepted',canvas:{},x:12,y:12,dispose:vi.fn()};}
function draw(c=context(),items=[region],p:MangaAlphaProtection|undefined=protection(),bg=items.map(()=>backgrounds[0])){
    drawMangaTranslations(c as any,pixels,width,height,items,true,bg,p);return c;
}
beforeEach(()=>{vi.clearAllMocks();plan.mockReset().mockImplementation((_text,ref)=>({accepted:true,font:`${ref.style} ${ref.fontSize}px ${ref.family}`,fontSize:ref.fontSize,lineWidth:ref.lineWidth,chunks:[]}));raster.mockReset().mockImplementation(accepted);ledger.mockReset().mockReturnValue({shared:true});});

describe('漫画绕孔位图与连续矩形编排',()=>{
    it('普通图片和框外保护区不进入额外布局或创建栅格账本',()=>{
        const a=context(),b=draw(context(),[region],protection([{x0:1,y0:1,x1:5,y1:5}]));
        drawMangaTranslations(a as any,pixels,width,height,[region],true,backgrounds);
        expect(plan).not.toHaveBeenCalled();expect(raster).not.toHaveBeenCalled();expect(ledger).not.toHaveBeenCalled();
        expect(a.fillText.mock.calls).toEqual(b.fillText.mock.calls);
    });
    it('完整整行成功后只合成同一位图，保留字号/基线并立即释放',()=>{
        const bitmap=accepted();raster.mockReturnValue(bitmap);const c=draw();
        expect(plan).toHaveBeenCalledOnce();expect(plan.mock.calls[0][4]).toBe(0);
        const [text,ref,holes,measure]=plan.mock.calls[0];expect(text).toBe(region.text);expect(ref.layout.lines.join('')).toBe(region.text);expect(ref.box).toEqual(region.bbox);expect(holes).toEqual([hole]);
        expect(measure('A')).toMatchObject({actualBoundingBoxLeft:0,actualBoundingBoxAscent:ref.fontSize*.7});
        expect(raster.mock.calls[0][3]).toEqual({fillStyle:'#111111',strokeStyle:'#ffffff'});
        expect(c.drawImage).toHaveBeenCalledOnce();expect(c.drawImage).toHaveBeenCalledWith(bitmap.canvas,12,12);expect(bitmap.dispose).toHaveBeenCalledOnce();
        expect(c.fillText).not.toHaveBeenCalled();expect(c.strokeText).not.toHaveBeenCalled();expect(c.save.mock.calls.length).toBe(c.restore.mock.calls.length);
    });
    it('仅实际像素不安全时允许固定h1，同页区域共享累计预算',()=>{
        raster.mockReturnValueOnce({kind:'unsafe'}).mockImplementation(accepted);const c=draw(context(),[region,region]);
        expect(plan.mock.calls.map(c=>c[4])).toEqual([0,1,0]);expect(plan.mock.calls[0][1]).toEqual(plan.mock.calls[1][1]);
        expect(ledger).toHaveBeenCalledOnce();expect(raster.mock.calls.every(c=>c[4]===ledger.mock.results[0].value)).toBe(true);
        expect(c.drawImage).toHaveBeenCalledTimes(2);expect(c.fillText).not.toHaveBeenCalled();
    });
    it('资源拒绝不重试，两个不安全结果或第二计划不支持均完整回到旧排版',()=>{
        for(const mode of ['budget','both-unsafe','second-plan'] as const){
            plan.mockClear();raster.mockClear();
            plan.mockImplementation((_text,ref,_holes,_measure,safety)=>mode==='second-plan'&&safety===1?{accepted:false,reason:'intact-tokens-do-not-fit'}:{accepted:true,font:'600 26px sans-serif',fontSize:ref.fontSize,lineWidth:ref.lineWidth,chunks:[]});
            raster.mockReturnValue({kind:mode==='budget'?'budget':'unsafe'});const c=draw();
            expect(plan).toHaveBeenCalledTimes(mode==='budget'?1:2);expect(raster).toHaveBeenCalledTimes(mode==='second-plan'?1:mode==='budget'?1:2);
            expect(c.drawImage).not.toHaveBeenCalled();expect(c.fillText.mock.calls.map(c=>c[0]).join('')).toBe(region.text);
        }
    });
    it('第一计划不支持时不创建Canvas，原生异常保留对象与上下文收尾',()=>{
        plan.mockReturnValue({accepted:false,reason:'unsupported-bidi-or-context-script'});const c=draw();
        expect(ledger).not.toHaveBeenCalled();expect(raster).not.toHaveBeenCalled();expect(c.fillText).toHaveBeenCalled();
        const native=new DOMException('font lost','InvalidStateError');plan.mockImplementation(()=>{throw native;});const broken=context();
        try{draw(broken);throw new Error('must throw');}catch(error){expect(error).toBe(native);}
        expect(broken.save.mock.calls.length).toBe(broken.restore.mock.calls.length);expect(broken.drawImage).not.toHaveBeenCalled();
    });
    it('栅格或最终合成抛错均不吞，合成失败仍释放已审计位图',()=>{
        const native=new Error('native bitmap failed');raster.mockImplementation(()=>{throw native;});const a=context();
        try{draw(a);throw new Error('must throw');}catch(error){expect(error).toBe(native);}expect(a.save.mock.calls.length).toBe(a.restore.mock.calls.length);
        const bitmap=accepted();raster.mockReturnValue(bitmap);const b=context();b.drawImage.mockImplementation(()=>{throw native;});
        try{draw(b);throw new Error('must throw');}catch(error){expect(error).toBe(native);}expect(bitmap.dispose).toHaveBeenCalledOnce();expect(b.save.mock.calls.length).toBe(b.restore.mock.calls.length);
        const cleanup=new Error('cleanup failed');bitmap.dispose.mockImplementation(()=>{throw cleanup;});
        try{draw(b);throw new Error('must throw');}catch(error){expect(error).toBe(native);}
        const c=context();try{draw(c);throw new Error('must throw');}catch(error){expect(error).toBe(cleanup);}
    });
    it('全页最多64段进入绕孔，后续区域保留既有完整文字排版',()=>{
        const c=draw(context(),Array.from({length:65},()=>region));expect(plan).toHaveBeenCalledTimes(64);expect(raster).toHaveBeenCalledTimes(64);
        expect(c.drawImage).toHaveBeenCalledTimes(64);expect(c.fillText.mock.calls.map(c=>c[0]).join('')).toBe(region.text);
    });
    it('超长文本、空文本、缺失ink和未fit字形不构造额外计划',()=>{
        const long={...region,text:'字'.repeat(4097)};draw(context(),[long]);expect(plan).not.toHaveBeenCalled();
        draw(context(),[{...region,text:' '}]);expect(plan).not.toHaveBeenCalled();
        const missing=context();missing.measureText.mockImplementation(function(this:{font:string},text:string){const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]);return {width:text.length*size*.6} as any;});draw(missing);expect(plan).not.toHaveBeenCalled();
        const unfit=context();unfit.measureText.mockImplementation(()=>({width:1,actualBoundingBoxLeft:0,actualBoundingBoxRight:1,actualBoundingBoxAscent:1000,actualBoundingBoxDescent:1000}));
        expect(()=>draw(unfit)).toThrow('已保留原图');expect(plan).not.toHaveBeenCalled();expect(raster).not.toHaveBeenCalled();
    });
    it('沿用原图确定的黑白笔色和均匀底描边，不使用试验固定颜色',()=>{
        draw(context(),[region],protection(),[{uniform:true,color:'rgb(0,0,0)'}]);expect(raster.mock.calls[0][3]).toEqual({fillStyle:'#ffffff',strokeStyle:'rgb(0,0,0)'});
        raster.mockClear();draw(context(),[region],protection(),[{uniform:true,color:'rgb(255,255,255)'}]);expect(raster.mock.calls[0][3]).toEqual({fillStyle:'#111111',strokeStyle:'rgb(255,255,255)'});
    });
});
