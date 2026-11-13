import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {observeImageSourceAppearances,expandImageTextBounds} from '@/src/features/image-translation/services/sourceAppearance';
import {observeImageMattePalette,planImageMatteCandidate} from '@/src/features/image-translation/services/imageMatteRepair';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';

type Box=ImageTextRegion['bbox'];
const box=(x0:number,y0:number,x1:number,y1:number):Box=>({x0,y0,x1,y1});
const rgba=(w=160,h=120,color=[255,255,255,255])=>{const pixels=new Uint8ClampedArray(w*h*4);for(let i=0;i<pixels.length;i+=4)pixels.set(color,i);return pixels;};
const paint=(pixels:Uint8ClampedArray,width:number,b:Box,color:number[])=>{for(let y=Math.floor(b.y0);y<Math.ceil(b.y1);y++)for(let x=Math.floor(b.x0);x<Math.ceil(b.x1);x++)pixels.set(color,(y*width+x)*4);};
const line=(b=box(30,30,130,50)):ImageTextRegion=>({text:'SOURCE TEXT',bbox:b,fontSize:b.y1-b.y0});
function fixture(color=[25,48,75,255]){const pixels=rgba(),region=line();paint(pixels,160,box(38,34,47,46),color);paint(pixels,160,box(64,34,74,46),color);return {pixels,region};}

describe('只读取原图的文字色与背景证据',()=>{
    it('保留源深蓝，返回独立颜色记录且不改源像素或框',()=>{
        const {pixels,region}=fixture(),before=pixels.slice();Object.freeze(region.bbox);Object.freeze(region);
        const appearance=observeImageSourceAppearances(pixels,160,120,[region]).get(region);
        expect(appearance).toEqual({foreground:'rgb(25,48,75)',background:[255,255,255,255]});expect(pixels).toEqual(before);
    });
    it('低对比源色只提供背景，绘字沿用高对比选择',()=>{
        const {pixels,region}=fixture([190,190,190,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).get(region)).toEqual({background:[255,255,255,255]});
    });
    it('同段多行颜色一致才采用，行间图案不能被当成同色背景',()=>{
        const a=box(30,30,130,50),b=box(30,75,130,95),region={...line(box(30,30,130,95)),sourceBoxes:[a,b]},pixels=rgba();
        paint(pixels,160,box(40,35,70,45),[25,48,75,255]);paint(pixels,160,box(40,80,70,90),[25,48,75,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).get(region)?.foreground).toBe('rgb(25,48,75)');
        paint(pixels,160,box(50,60,90,65),[220,80,20,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).size).toBe(0);
    });
    it.each(['ink','background'])('同段不同%s不强行重绘成一种源样式',kind=>{
        const a=box(30,30,130,50),b=box(30,75,130,95),region={...line(box(30,30,130,95)),sourceBoxes:[a,b]},pixels=rgba();
        if(kind==='background')paint(pixels,160,box(0,62,160,120),[240,240,240,255]);
        paint(pixels,160,box(40,35,70,45),[25,48,75,255]);paint(pixels,160,box(40,80,70,90),kind==='ink'?[90,25,70,255]:[25,48,75,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).size).toBe(0);
    });
    it('画布预留区域也要验证，不能只验证源框内部',()=>{
        const {pixels,region}=fixture();paint(pixels,160,box(24,0,26,120),[220,80,20,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).size).toBe(1);
        expect(observeImageSourceAppearances(pixels,160,120,[region],()=>box(22,25,134,55)).size).toBe(0);
        expect(observeImageSourceAppearances(pixels,160,120,[region],()=>box(-1,25,134,55)).size).toBe(0);
    });
    it('合并和嵌套的物理源框仍覆盖正确行区间，不漏检尾部留白',()=>{
        const pixels=rgba(),region={...line(box(20,20,120,80)),sourceBoxes:[box(30,30,80,60),box(40,35,65,55)]};
        paint(pixels,160,box(45,40,55,48),[25,48,75,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).size).toBe(1);
        paint(pixels,160,box(111,20,113,80),[250,250,250,255]);
        expect(observeImageSourceAppearances(pixels,160,120,[region]).size).toBe(0);
    });
    it('真实日文竖排源像素沿用梅红正文，蓝灰注音不决定字色',()=>{
        const raw=gunzipSync(readFileSync(new URL('./fixtures/manga-color-quality/truth/rain-garden-vertical-ruby-sidebar.source-rgba.bin.gz',import.meta.url)));
        const pixels=new Uint8ClampedArray(raw.buffer,raw.byteOffset,raw.byteLength);
        const main=[box(830,149,880,452),box(717,150,768,500)],annotations=[box(886,147,912,211+1/3),box(775,150,802,217)];
        const region:ImageTextRegion={text:'風の音を聞いて小道で待っている',vertical:true,fontSize:51,bbox:box(717,147,912,500),sourceBoxes:[main[0],annotations[0],main[1],annotations[1]],ruby:annotations.map((bbox,i)=>({text:i?'こみち':'かぜ',bbox}))};
        expect(observeImageSourceAppearances(pixels,1100,1500,[region]).get(region)).toEqual({foreground:'rgb(137,40,90)',background:[137,224,196,255]});
    });
    it('调色板观察不会授予清字权限，宽灰色组件仍不能通过原修补准入',()=>{
        const pixels=rgba(),region=line(box(30,25,130,95));
        paint(pixels,160,box(40,35,50,45),[20,20,20,255]);paint(pixels,160,box(60,35,110,85),[128,128,128,255]);
        const palette=observeImageMattePalette(pixels,160,120,region.bbox,{remaining:100000});
        expect(palette?.ink).toEqual([20,20,20,255]);expect(palette).not.toHaveProperty('mask');expect(palette).not.toHaveProperty('artMask');
        expect(planImageMatteCandidate(pixels,160,120,region.bbox,{remaining:100000})).toBeUndefined();
    });
    it('透明、渐变、多色笔画、空白及不完整静区仍不猜字色',()=>{
        const source=fixture();
        for(const p of [rgba(),rgba(160,120,[255,255,255,100]),new Uint8ClampedArray(160*120*4)])expect(observeImageSourceAppearances(p,160,120,[source.region]).size).toBe(0);
        paint(source.pixels,160,box(90,34,100,46),[220,50,100,255]);expect(observeImageSourceAppearances(source.pixels,160,120,[source.region]).size).toBe(0);
        const gradient=rgba();for(let x=0;x<160;x++)paint(gradient,160,box(x,0,x+1,120),[100+x/2,120,180,255]);
        expect(observeImageSourceAppearances(gradient,160,120,[source.region]).size).toBe(0);
        expect(observeImageSourceAppearances(source.pixels,160,120,[line(box(0,0,130,50))]).size).toBe(0);
    });
    it('全透明底的隐藏RGB不参与颜色合成，原修补仍保留这些源字节而样式保持未知',()=>{
        const pixels=rgba(160,120,[77,33,99,0]),region=line();paint(pixels,160,box(40,35,50,45),[25,48,75,255]);const before=pixels.slice();
        expect(planImageMatteCandidate(pixels,160,120,region.bbox,{remaining:100000})?.background).toEqual([77,33,99,0]);
        expect(observeImageMattePalette(pixels,160,120,region.bbox,{remaining:100000})).toBeUndefined();expect(pixels).toEqual(before);
    });
    it('调色板共享预算不足、非法预算和尺寸不产生样式',()=>{
        const {pixels,region}=fixture();
        for(const budget of [undefined,{remaining:NaN},{remaining:-1},{remaining:0}])expect(observeImageMattePalette(pixels,160,120,region.bbox,budget as never)).toBeUndefined();
        expect(observeImageSourceAppearances(pixels,160,120,Array(1500).fill(region)).size).toBe(0);
        for(const [w,h,p] of [[0,120,pixels],[NaN,120,pixels],[160.5,120,pixels],[8193,1,pixels],[8192,8192,pixels],[160,120,new Uint8ClampedArray(3)]] as const)
            expect(observeImageSourceAppearances(p,w,h,[region]).size).toBe(0);
        expect(observeImageSourceAppearances(pixels,160,120,Array(4097).fill(region)).size).toBe(0);
    });
    it('全页行框比较预算在分析前拒绝，不让前半页先换颜色',()=>{
        const pixels=rgba(100,4100),region={...line(box(20,20,70,4020)),sourceBoxes:Array(128).fill(box(30,40,40,50))};
        expect(observeImageSourceAppearances(pixels,100,4100,[region,region]).size).toBe(0);
    });
    it('越界或过大的观察区、整段范围以及空/损坏源框保持原路径',()=>{
        const {pixels,region}=fixture();
        const bad=[null,{...region,guardOnly:true},{...region,sourceBoxes:[]},{...region,sourceBoxes:{}},{...region,sourceBoxes:Array(129).fill(region.bbox)},
            {...region,sourceBoxes:new Array(2)},{...region,sourceBoxes:[box(0,0,NaN,50)]},{...region,ruby:{}},{...region,ruby:Array(129).fill({text:'か',bbox:region.bbox})},
            {...region,ruby:[null]},{...region,ruby:[{text:'か',bbox:box(-1,10,20,30)}]},
            {...region,ruby:[{text:'か',bbox:region.bbox}]}];
        for(const input of bad)expect(observeImageSourceAppearances(pixels,160,120,[input as never]).size).toBe(0);
        expect(observeImageSourceAppearances(rgba(1000,400),1000,400,[line(box(20,20,950,390))]).size).toBe(0);
        const large={...line(box(10,10,990,390)),sourceBoxes:[box(30,30,80,50)]};
        expect(observeImageSourceAppearances(rgba(1000,400),1000,400,[large]).size).toBe(0);
    });
});

describe('新增绘字像素的空白与邻文验证',()=>{
    const original=box(20,40,120,70),appearance={background:[255,255,255,255] as const};
    it('只在足够空间中对称补充行高，已有内容和源对象不变',()=>{
        const pixels=rgba();paint(pixels,160,box(30,45,80,65),[20,40,60,255]);const before=pixels.slice(),budget={remaining:600};
        expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[],budget)).toEqual(box(20,37,120,73));
        expect(budget.remaining).toBe(0);expect(pixels).toEqual(before);expect(original).toEqual(box(20,40,120,70));
    });
    it.each([[20,37],[119,72],[70,38],[65,71]])('新增范围的任意图案像素阻止扩展 %j',(x,y)=>{
        const pixels=rgba();pixels.set([255,254,255,255],(y*160+x)*4);
        expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[],{remaining:10000})).toBe(original);
    });
    it('透明孔及部分覆盖的边界像素也不能作为空白',()=>{
        const pixels=rgba();pixels[(38*160+50)*4+3]=254;
        expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[],{remaining:10000})).toBe(original);
        const fractional=box(20.5,40.25,120.5,69.75);pixels.fill(255);pixels[(40*160+20)*4]=254;
        expect(expandImageTextBounds(pixels,160,120,fractional,36,appearance,[],{remaining:10000})).toBe(fractional);
    });
    it('相邻文字或既有扩展框阻止覆盖，恰好接边仍可使用',()=>{
        const pixels=rgba();
        for(const obstacle of [box(40,35,60,38),box(50,72,80,74),box(50,50,80,55),box(0,0,NaN,20)])
            expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[obstacle],{remaining:10000})).toBe(original);
        expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[box(20,20,120,37)],{remaining:10000})).toEqual(box(20,37,120,73));
    });
    it('邻文也消耗共享工作预算，按需迭代避免展开巨大物理框列表',()=>{
        const pixels=rgba();let observed=0;
        function* obstacles(){while(true){observed++;yield box(130,90,150,100);}}
        expect(expandImageTextBounds(pixels,160,120,original,36,appearance,obstacles(),{remaining:602})).toBe(original);
        expect(observed).toBe(3);observed=0;
        expect(expandImageTextBounds(pixels,160,120,original,30,appearance,obstacles(),{remaining:10000})).toBe(original);
        expect(observed).toBe(0);
    });
    it('无需扩展、预算不足、未知底色或超过边界时保持同一原框',()=>{
        const pixels=rgba();
        for(const height of [30,20,55,NaN,Infinity])expect(expandImageTextBounds(pixels,160,120,original,height,appearance,[],{remaining:10000})).toBe(original);
        for(const remaining of [599,-1,NaN])expect(expandImageTextBounds(pixels,160,120,original,36,appearance,[],{remaining})).toBe(original);
        for(const background of [[255,255,255],[255,255,255,128]])expect(expandImageTextBounds(pixels,160,120,original,36,{background} as never,[],{remaining:10000})).toBe(original);
        const edge=box(20,1,120,31);expect(expandImageTextBounds(pixels,160,120,edge,36,appearance,[],{remaining:10000})).toBe(edge);
        const invalid=box(-1,40,120,70);expect(expandImageTextBounds(pixels,160,120,invalid,36,appearance,[],{remaining:10000})).toBe(invalid);
        expect(expandImageTextBounds(pixels,160.5,120,original,36,appearance,[],{remaining:10000})).toBe(original);
        expect(expandImageTextBounds(new Uint8ClampedArray(4),160,120,original,36,appearance,[],{remaining:10000})).toBe(original);
    });
});
