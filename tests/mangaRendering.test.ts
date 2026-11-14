import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createMangaBlankLayoutBudget,drawMangaTranslations,planMangaBlankTranslation,sampleMangaBackgrounds} from '@/src/features/image-translation/services/mangaRendering';
import {findMangaBlankSpaces} from '@/src/features/image-translation/services/mangaBlankSpaces';
import type {MangaRegion} from '@/src/features/image-translation/services/mangaRegions';
import {mangaMaskBoxes} from '@/src/features/image-translation/mangaPatchResult';
import {page,word} from './helpers/imageTypographyFixture';

const W=1000,H=300;
const region=(text='whole translated sentence'):MangaRegion=>({text,fontSize:20,bbox:{x0:500,y0:100,x1:800,y1:160},sourceBoxes:[{x0:500,y0:100,x1:800,y1:120}]});
const box=(x0=10,y0=10,x1=410,y1=70)=>({x0,y0,x1,y1});
function context(){
    const stack:Array<Record<string,unknown>>=[];
    const c={font:'italic 17px serif',direction:'inherit',textAlign:'right',textBaseline:'bottom',lineWidth:7,fillStyle:'orange',strokeStyle:'purple',lineJoin:'bevel',
        save:vi.fn(function(){stack.push(Object.fromEntries(['font','direction','textAlign','textBaseline','lineWidth','fillStyle','strokeStyle','lineJoin'].map(key=>[key,c[key as keyof typeof c]])));}),
        restore:vi.fn(function(){Object.assign(c,stack.pop());}),
        measureText:vi.fn(function(text:string){const size=Number(c.font.match(/ ([\d.e+-]+)px/)![1]);return {width:Array.from(text).length*size*.6,actualBoundingBoxAscent:text?size*.7:0,actualBoundingBoxDescent:text?size*.2:0,actualBoundingBoxLeft:0,actualBoundingBoxRight:Array.from(text).length*size*.6};}),
        beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),transform:vi.fn(),fillRect:vi.fn(),strokeText:vi.fn(),
        fillText:vi.fn(function(text:string,x:number,y:number){return {text,x,y,font:c.font};}),
    };
    return c;
}
const plan=(c:ReturnType<typeof context>,r=region(),spaces=[box()],width=W,height=H)=>planMangaBlankTranslation(c as unknown as CanvasRenderingContext2D,r,width,height,spaces);
const snapshot=(c:ReturnType<typeof context>)=>({font:c.font,direction:c.direction,textAlign:c.textAlign,textBaseline:c.textBaseline,lineWidth:c.lineWidth,fillStyle:c.fillStyle,strokeStyle:c.strokeStyle,lineJoin:c.lineJoin});
function draw(c:ReturnType<typeof context>,r:MangaRegion){drawMangaTranslations(c as unknown as CanvasRenderingContext2D,new Uint8ClampedArray(W*H*4).fill(255),W,H,[r],true,[{color:'rgb(255,255,255)',uniform:true}]);}
function fragmentedSpaces(){
    const pixels=new Uint8ClampedArray(220*220*4),set=(x:number,y:number,value:number)=>pixels.set([value,value,value,255],(y*220+x)*4);
    for(let y=0;y<220;y++)for(let x=0;x<220;x++)set(x,y,x>=10&&x<210&&y>=10&&y<210?245:0);
    for(let i=0;i<32;i++)for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++)set(14+i%8*23+dx,14+Math.floor(i/8)*23+dy,255);
    const spaces=findMangaBlankSpaces(pixels,220,220,{x0:10,y0:10,x1:210,y1:210},[],{remainingPixels:2_000_000});
    expect(spaces).toHaveLength(32);expect(spaces.every(b=>b.x1-b.x0===3&&b.y1-b.y0===3)).toBe(true);return spaces;
}

describe('只在已证明白底放置完整漫画译文',()=>{
    it('有方向的源字样式在修补前观察，原清字盒不随译文倾角改变',()=>{
        const p=page(),source={...word(p),fontSize:21},c=context(),native=c.measureText.getMockImplementation()!;
        c.measureText.mockImplementation(text=>c.font.includes('100px Arial')?{width:600,actualBoundingBoxLeft:0,actualBoundingBoxRight:600,actualBoundingBoxAscent:105,actualBoundingBoxDescent:0}:native(text));
        const before=p.pixels.slice(),original=structuredClone(source),backgrounds=sampleMangaBackgrounds(p.pixels,p.width,p.height,[source],c as never);
        expect(backgrounds[0].sourceTypography?.owner).toBe(source);expect(backgrounds[0].sourceFontSize).toBeGreaterThan(19);expect(backgrounds[0].sourceFontSize).toBeLessThan(22);
        drawMangaTranslations(c as never,p.pixels,p.width,p.height,[{...source,text:'完整译文'}],true,backgrounds);
        expect(c.transform).toHaveBeenCalledOnce();expect(c.clip.mock.invocationCallOrder[0]).toBeLessThan(c.transform.mock.invocationCallOrder[0]);expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('完整译文');expect(source).toEqual(original);expect(p.pixels).toEqual(before);
    });
    it('旋转绘制保持源色/左右对齐并传播原生异常，缺指标或过期几何回退原布局',()=>{
        for(const mode of ['left','right','flat','unknown-metrics','invalid-plane','stale-box','stale-physical','stale-text','long','throw'] as const){
            const c=context(),r={...region(mode==='long'?'A'.repeat(4097):'完整译文')},g={owner:r,sourceText:r.text,radians:Math.PI/36,originX:650,originY:130,bounds:{x0:-100,y0:-10,x1:100,y1:10},width:200,height:20,count:1,heightGain:10};
            if(mode==='unknown-metrics')c.measureText.mockImplementation(text=>({width:text.length*Number(c.font.match(/ ([\d.e+-]+)px/)![1])*.6} as never));
            if(mode==='invalid-plane')g.originX=NaN;
            if(mode==='stale-box')g.owner={...r,bbox:{...r.bbox}};
            if(mode==='stale-physical')g.owner={...r,sourceBoxes:[]};
            if(mode==='stale-text')g.sourceText='PREVIOUS';
            const failure=new Error('transform failed');if(mode==='throw')c.transform.mockImplementation(()=>{throw failure;});
            const draw=()=>drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[r],true,[{uniform:mode==='flat',color:'white',sourceFontSize:20,sourceTypography:g,...(['left','right'].includes(mode)?{textAlign:mode as 'left'|'right',foreground:'#aabbcc'}:{})}]);
            if(mode==='throw')expect(draw).toThrow(failure);else {draw();expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe(r.text);}
            expect(c.transform.mock.calls.length).toBe(['left','right','flat','throw'].includes(mode)?1:0);expect(snapshot(c)).toEqual(snapshot(context()));
        }
    });
    it('可靠原字尺度替换页面统一字号上限，清字仍按原fontSize和原物理框',()=>{
        const c=context(),r={text:'短标题',fontSize:50,bbox:{x0:100,y0:100,x1:900,y1:160},sourceBoxes:[{x0:100,y0:100,x1:900,y1:160}]},before=structuredClone(r);
        drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[r],true,[{uniform:true,color:'#ffffff',sourceFontSize:40}]);
        expect(c.fillText.mock.results.map(v=>(v.value as {font:string}).font)).toEqual([expect.stringContaining(' 40px ')]);
        expect(c.fillRect.mock.calls).toEqual(mangaMaskBoxes(before,W,H).map(b=>[b.x0,b.y0,b.x1-b.x0,b.y1-b.y0]));expect(r).toEqual(before);
    });
    it.each([NaN,Infinity,0,-1,151])('非法或超出源区域物理比例的字号%s保持旧上限',sourceFontSize=>{
        const c=context(),r=region('短标题');
        drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[r],true,[{uniform:true,color:'#ffffff',sourceFontSize}]);
        expect(c.fillText.mock.results.every(v=>(v.value as {font:string}).font.startsWith('600 21px '))).toBe(true);
    });
    it('冻结招牌的两个渐变标题保留共同左边线，独立平色标签不猜测对齐',()=>{
        const pixels=new Uint8ClampedArray(gunzipSync(readFileSync(new URL('./fixtures/manga-color-quality/truth/prism-platform-gradient-signs.source-rgba.bin.gz',import.meta.url))));
        const rows=[{text:'沿着东方的轨道',fontSize:37,bbox:{x0:181,y0:130,x1:1003,y1:167}},
            {text:'下一班火车马上就到了。',fontSize:28,bbox:{x0:179,y0:205,x1:894,y1:233}},
            {text:'九号站台已开放',fontSize:27,bbox:{x0:831,y0:480,x1:1306,y1:507}}].map(r=>({...r,sourceBoxes:[{...r.bbox}]}));
        const sampled=sampleMangaBackgrounds(pixels,1600,900,rows);
        expect(sampled.map(b=>b.textAlign)).toEqual(['left','left',undefined]);
        expect(sampled.map(b=>b.foreground)).toEqual(['rgb(245,245,250)','rgb(18,26,45)','rgb(248,215,80)']);
    });
    it.each(['left','right'] as const)('单行 %s 对齐以真实墨迹边缘放置，包含描边且恢复画布状态',alignment=>{
        for(const text of ['短标题','مرحبا','שלום'])for(const bearing of [2,-3]){
            const c=context(),before=snapshot(c),base=c.measureText.getMockImplementation()!;
            c.measureText.mockImplementation(value=>{const m=base(value);return {...m,actualBoundingBoxLeft:bearing,actualBoundingBoxRight:m.width-bearing};});
            const seen:any[]=[];c.fillText.mockImplementation((value,x,y)=>{seen.push({value,x,y,font:c.font,align:c.textAlign,direction:c.direction,lineWidth:c.lineWidth});return {text:value,x,y,font:c.font};});
            const r=region(text);drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[r],true,[{uniform:false,color:'#ffffff',foregroundOutline:'#111827',textAlign:alignment}]);
            expect(seen).toHaveLength(1);expect(seen[0].align).toBe('left');expect(seen[0].direction).toBe(text==='短标题'?'ltr':'rtl');
            const size=Number(seen[0].font.match(/ ([\d.e+-]+)px/)![1]),inset=Math.min(4,21*.1),padding=seen[0].lineWidth/2+.5,width=Array.from(text).length*size*.6;
            const expected=alignment==='left'?500+inset+padding+bearing:800-inset-padding-(width-bearing);
            expect(seen[0].x).toBeCloseTo(expected);expect(seen[0].x-bearing-padding).toBeGreaterThanOrEqual(500+inset-1e-9);
            expect(seen[0].x+width-bearing+padding).toBeLessThanOrEqual(800-inset+1e-9);expect(snapshot(c)).toEqual(before);expect(c.fillRect).not.toHaveBeenCalled();
        }
    });
    it('缺少字形边界、宽字形无法完整容纳及多行译文仍保持居中',()=>{
        for(const ink of [{actualBoundingBoxLeft:NaN},{actualBoundingBoxRight:NaN},{actualBoundingBoxLeft:0,actualBoundingBoxRight:0},{actualBoundingBoxLeft:500,actualBoundingBoxRight:500}]){
            const c=context(),base=c.measureText.getMockImplementation()!;c.measureText.mockImplementation(value=>({...base(value),...ink}));
            drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[region('短标题')],true,[{uniform:true,color:'#ffffff',textAlign:'left'}]);
            expect(c.fillText.mock.calls.map(c=>c[1])).toEqual([650]);
        }
        const c=context();drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,[region('第一行\n第二行')],true,[{uniform:true,color:'#ffffff',textAlign:'right'}]);
        expect(c.fillText.mock.calls).toHaveLength(2);expect(c.fillText.mock.calls.map(c=>c[1])).toEqual([650,650]);
    });
    it('渐变只提供字色与细对比描边，不把原复杂背景降成纯色清字',()=>{
        const pixels=new Uint8ClampedArray(W*H*4),r=region('SOURCE');
        for(let y=0;y<H;y++)for(let x=0;x<W;x++)pixels.set([20+x*.15,30+y*.1,70,255],(y*W+x)*4);
        for(let y=105;y<115;y++)for(let x=520;x<570;x++)pixels.set([245,245,250,255],(y*W+x)*4);
        const sampled=sampleMangaBackgrounds(pixels,W,H,[r]);
        expect(sampled[0]).toMatchObject({uniform:false,foreground:'rgb(245,245,250)',foregroundOutline:'#111827'});expect(sampled[0]).not.toHaveProperty('textBackground');
        const c=context(),styles:unknown[]=[];c.fillText.mockImplementation((text,x,y)=>{styles.push([c.fillStyle,c.strokeStyle,c.lineWidth]);return {text,x,y,font:c.font};});
        drawMangaTranslations(c as never,pixels,W,H,[r],true,sampled);
        expect(c.fillRect).not.toHaveBeenCalled();expect(styles).toEqual([['rgb(245,245,250)','#111827',.7350000000000001]]);
    });
    it.each([['(2.0) مرحبا بكم!','rtl'],['(42) שלום לכם!','rtl'],['(2.0) Hello world!','ltr']])('整段 %s 的度量和绘制不继承错误画布方向',(text,direction)=>{
        const c=context(),before=snapshot(c),measured:string[]=[],drawn:string[]=[],base=c.measureText.getMockImplementation()!;
        c.measureText.mockImplementation(value=>{measured.push(c.direction);return base(value);});
        c.fillText.mockImplementation((value,x,y)=>{drawn.push(c.direction);return {text:value,x,y,font:c.font};});
        const selected=plan(c,region(text));expect(selected).toBeDefined();expect(snapshot(c)).toEqual(before);
        draw(c,selected!);expect(measured.length).toBeGreaterThan(0);expect(measured.every(value=>value===direction)).toBe(true);
        expect(drawn.length).toBeGreaterThan(0);expect(drawn.every(value=>value===direction)).toBe(true);expect(snapshot(c)).toEqual(before);
    });
    it('同页弱方向数字行按各自段落方向分别度量，不串用另一方向的缓存',()=>{
        const c=context(),seen=new Set<string>(),base=c.measureText.getMockImplementation()!;
        c.measureText.mockImplementation(text=>{if(text==='2026 (2.0)')seen.add(c.direction);const result=base(text);return {...result,width:result.width+(c.direction==='rtl'?7:0)};});
        const items=[region('Hello\n2026 (2.0)'),region('مرحبا\n2026 (2.0)')];
        drawMangaTranslations(c as never,new Uint8ClampedArray(W*H*4).fill(255),W,H,items,true,items.map(()=>({uniform:true,color:'rgb(255,255,255)'})));
        expect(seen).toEqual(new Set(['ltr','rtl']));expect(c.direction).toBe('inherit');
    });
    it('源色与实际文字底色独立于原清字分类，绘字采用细底色描边',()=>{
        const pixels=new Uint8ClampedArray(W*H*4).fill(255),r=region('SOURCE');
        for(let y=105;y<115;y++)for(let x=520;x<570;x++)pixels.set([25,48,75,255],(y*W+x)*4);
        const sampled=sampleMangaBackgrounds(pixels,W,H,[r]);
        expect(sampled[0]).toMatchObject({foreground:'rgb(25,48,75)',textBackground:'rgb(255,255,255)'});
        const c=context(),styles:Array<unknown>=[];c.fillText.mockImplementation((text,x,y)=>{styles.push({fill:c.fillStyle,stroke:c.strokeStyle,lineWidth:c.lineWidth});return {text,x,y,font:c.font};});
        drawMangaTranslations(c as never,pixels,W,H,[r],true,[{...sampled[0],uniform:false}]);
        expect(styles[0]).toMatchObject({fill:'rgb(25,48,75)',stroke:'rgb(255,255,255)'});expect((styles[0] as {lineWidth:number}).lineWidth).toBeLessThan(1);
        for(let y=105;y<115;y++)for(let x=520;x<570;x++)pixels.set([190,190,190,255],(y*W+x)*4);
        expect(sampleMangaBackgrounds(pixels,W,H,[r])[0]).toMatchObject({textBackground:'rgb(255,255,255)'});
        expect(sampleMangaBackgrounds(pixels,W,H,[r])[0]).not.toHaveProperty('foreground');
    });
    it('返回独立位置且清空清字源框，全文和源字号基准不变，度量后恢复context且不绘制',()=>{
        const c=context(),before=snapshot(c),r=region(),spaces=[box()],original=structuredClone(r);
        Object.freeze(r.bbox);Object.freeze(r.sourceBoxes![0]);Object.freeze(r.sourceBoxes);Object.freeze(r);Object.freeze(spaces[0]);Object.freeze(spaces);
        const placed=plan(c,r,spaces)!;
        expect(placed).toEqual({...original,bbox:spaces[0],sourceBoxes:[]});expect(placed).not.toBe(r);expect(placed.bbox).not.toBe(spaces[0]);expect(r).toEqual(original);
        expect(snapshot(c)).toEqual(before);expect(c.save).toHaveBeenCalledOnce();expect(c.restore).toHaveBeenCalledOnce();
        expect(c.measureText).toHaveBeenCalled();expect(c.fillRect).not.toHaveBeenCalled();expect(c.fillText).not.toHaveBeenCalled();expect(c.strokeText).not.toHaveBeenCalled();expect(c.clip).not.toHaveBeenCalled();
        const drawn=context();draw(drawn,placed);
        expect(drawn.fillRect.mock.calls).toEqual([[10,10,400,60]]);expect(drawn.fillText.mock.results.map(x=>(x.value as {text:string}).text).join('')).toBe(r.text);
        expect(drawn.fillText.mock.results.every(x=>(x.value as {font:string}).font.startsWith('600 21px '))).toBe(true);
    });
    it('全文不fit或只能缩到源字号以下时拒绝，不能把前半句当成功',()=>{
        const c=context();expect(plan(c,region(),[box(10,10,80,24)])).toBeUndefined();expect(c.fillText).not.toHaveBeenCalled();expect(c.restore).toHaveBeenCalledOnce();
        const a=context(),partial=plan(a,region('KEEP ALL THESE WORDS AND THE FINAL END'),[box(10,10,110,30)]);
        expect(partial).toBeUndefined();expect(snapshot(a)).toEqual(snapshot(context()));
    });
    it('按实际最大字号选候选，平局保持原候选顺序并在最大字号时不读后项',()=>{
        const first=box(10,10,310,30.1),larger=box(10,50,310,70.5),tie={...larger,y0:100,y1:120.5};
        const chosen=plan(context(),region('whole text'),[first,larger,tie])!;expect(chosen.bbox).toEqual(larger);
        const drawn=context();draw(drawn,chosen);const font=(drawn.fillText.mock.results[0].value as {font:string}).font;
        expect(Number(font.match(/ ([\d.e+-]+)px/)![1])).toBeGreaterThan(20.4);
        const candidates=[box(),box(10,90,410,150)];Object.defineProperty(candidates,1,{get(){throw new Error('must stop at maximum');}});
        expect(plan(context(),region(),candidates)!.bbox).toEqual(candidates[0]);
    });
    it('最多尝试前32项，不读取第33个较大空白区',()=>{
        const candidates=Array.from({length:33},()=>box(1,1,2,2));Object.defineProperty(candidates,32,{get(){throw new Error('candidate cap');}});
        const c=context();expect(plan(c,region('complete'),candidates)).toBeUndefined();expect(c.restore).toHaveBeenCalledOnce();
    });
    it('跳过非法候选但不改它的坐标，保留合法的完整候选',()=>{
        const invalid={x0:NaN,y0:0,x1:40,y1:40},c=context();expect(plan(c,region(),[invalid,box()])!.bbox).toEqual(box());expect(Number.isNaN(invalid.x0)).toBe(true);
        expect(plan(context(),region(),[{x0:1,y0:1,x1:1,y1:10}])).toBeUndefined();
    });
    it('显式换行和空行仍作为完整正文排版，并与实际白底绘制采用相同布局',()=>{
        const r=region('first\n\nlast'),placed=plan(context(),r,[box(10,10,410,100)])!,drawn=context();draw(drawn,placed);
        expect(placed.text).toBe(r.text);expect(drawn.fillText.mock.calls.map(call=>call[0])).toEqual(['first','','last']);
        expect(drawn.fillText.mock.results.every(x=>(x.value as {font:string}).font.startsWith('600 21px '))).toBe(true);
    });
    it.each([[0,H],[-1,H],[1.5,H],[NaN,H],[8193,H],[4097,4096],[W,0],[W,8193]])('无效尺寸%s×%s在任何Canvas操作前拒绝',(width,height)=>{
        const c=context();expect(plan(c,region(),[box()],width,height)).toBeUndefined();expect(c.save).not.toHaveBeenCalled();expect(c.measureText).not.toHaveBeenCalled();
    });
    it.each([
        null,{...region(),vertical:true},{...region(),text:1},{...region(),text:' \r\n '},{...region(),text:'字'.repeat(4097)},
        {...region(),fontSize:NaN},{...region(),fontSize:0},{...region(),fontSize:-1},{...region(),fontSize:40},
        {...region(),bbox:undefined},{...region(),bbox:{x0:-1,y0:0,x1:40,y1:40}},{...region(),bbox:{x0:0,y0:-1,x1:40,y1:40}},
        {...region(),bbox:{x0:0,y0:0,x1:W+1,y1:40}},{...region(),bbox:{x0:0,y0:0,x1:40,y1:H+1}},
        {...region(),bbox:{x0:0,y0:10,x1:40,y1:10}},{...region(),bbox:{x0:40,y0:0,x1:0,y1:40}},
    ])('不支持的源形状在度量前拒绝 %#',r=>{
        const c=context();expect(plan(c,r as MangaRegion)).toBeUndefined();expect(c.save).not.toHaveBeenCalled();
    });
    it.each([[],undefined,{}])('无候选列表时不操作Canvas %#',spaces=>{
        const c=context();expect(planMangaBlankTranslation(c as any,region(),W,H,spaces as any)).toBeUndefined();expect(c.save).not.toHaveBeenCalled();
    });
    it.each([
        {width:NaN,actualBoundingBoxAscent:14,actualBoundingBoxDescent:4},
        {width:-1,actualBoundingBoxAscent:14,actualBoundingBoxDescent:4},
        {width:20,actualBoundingBoxAscent:undefined,actualBoundingBoxDescent:4},
        {width:20,actualBoundingBoxAscent:0,actualBoundingBoxDescent:0},
        {width:20,actualBoundingBoxAscent:Number.MAX_VALUE,actualBoundingBoxDescent:Number.MAX_VALUE},
    ])('不完整/非法原生字形度量不被当作fit %#',metrics=>{
        const c=context();c.measureText.mockReturnValue(metrics as any);expect(plan(c)).toBeUndefined();expect(snapshot(c)).toEqual(snapshot(context()));expect(c.restore).toHaveBeenCalledOnce();
    });
    it('原生度量/恢复异常原样传播；首个度量错误不被随后恢复错误替换',()=>{
        const native=new DOMException('font lost','InvalidStateError'),cleanup=new Error('restore failed'),c=context();c.measureText.mockImplementation(()=>{throw native;});
        expect(()=>plan(c)).toThrow(native);expect(snapshot(c)).toEqual(snapshot(context()));expect(c.restore).toHaveBeenCalledOnce();
        const both=context();both.measureText.mockImplementation(()=>{throw native;});both.restore.mockImplementation(()=>{throw cleanup;});expect(()=>plan(both)).toThrow(native);
        const restore=context();restore.restore.mockImplementation(()=>{throw cleanup;});expect(()=>plan(restore)).toThrow(cleanup);
        const save=context();save.save.mockImplementation(()=>{throw native;});expect(()=>plan(save)).toThrow(native);expect(save.restore).not.toHaveBeenCalled();
    });
    it.each(['字'.repeat(4096),'如果多点服务，那就更好了！'])('实际像素planner的32个小白区只能在页级度量/字符账本内拒绝：%#',text=>{
        const c=context(),budget=createMangaBlankLayoutBudget(),r={...region(text),fontSize:7,bbox:box(20,120,150,160)};
        const sizes:number[]=[],base=c.measureText.getMockImplementation()!;c.measureText.mockImplementation(text=>{sizes.push(Number(c.font.match(/ ([\d.e+-]+)px/)![1]));return base(text);});
        expect(planMangaBlankTranslation(c as any,r,220,220,fragmentedSpaces(),budget)).toBeUndefined();
        expect(c.measureText.mock.calls.length).toBeLessThanOrEqual(1024);expect(c.measureText.mock.calls.reduce((sum,[text])=>sum+text.length,0)).toBeLessThanOrEqual(65_536);
        expect(snapshot(c)).toEqual(snapshot(context()));expect(c.restore).toHaveBeenCalledOnce();
        expect(sizes.every(size=>size>=r.fontSize)).toBe(true);
    });
    it('累计UTF16预算也独立生效，不只限制短文本度量次数',()=>{
        const c=context(),budget=createMangaBlankLayoutBudget();c.measureText.mockReturnValue({width:0,actualBoundingBoxAscent:50,actualBoundingBoxDescent:10} as any);
        expect(planMangaBlankTranslation(c as any,region('A'.repeat(4096)),W,H,Array.from({length:32},()=>box(1,1,4,4)),budget)).toBeUndefined();
        expect(c.measureText.mock.calls.length).toBeLessThan(1024);expect(c.measureText.mock.calls.reduce((sum,[text])=>sum+text.length,0)).toBeLessThanOrEqual(65_536);
        expect(budget.remainingMeasurements).toBe(0);expect(budget.remainingCharacters).toBe(0);
    });
    it('同一不可抬高的页余额跨plan共享，耗尽后不再操作Canvas',()=>{
        const c=context(),budget=createMangaBlankLayoutBudget();expect(Object.isFrozen(budget)).toBe(true);
        expect(()=>{(budget as any).remainingMeasurements=999999;}).toThrow();
        for(let i=0;i<200;i++)planMangaBlankTranslation(c as any,region('whole text'),W,H,[box()],budget);
        expect(budget.remainingMeasurements).toBe(0);expect(c.measureText.mock.calls.length).toBeLessThanOrEqual(1024);
        const saved=c.save.mock.calls.length;expect(planMangaBlankTranslation(c as any,region(),W,H,[box()],budget)).toBeUndefined();expect(c.save).toHaveBeenCalledTimes(saved);
    });
    it.each([null,{}, {remainingMeasurements:1024,remainingCharacters:65536},{remainingMeasurements:1e9,remainingCharacters:1e9}])('伪造或抬高的预算没有权限 %#',budget=>{
        const c=context();expect(planMangaBlankTranslation(c as any,region(),W,H,[box()],budget as any)).toBeUndefined();expect(c.save).not.toHaveBeenCalled();
    });
    it('实际十三字在106×40最大字号提前返回，100×34保持源字号下限',()=>{
        const r={...region('如果多点服务，那就更好了！'),fontSize:40/3},c=context(),budget=createMangaBlankLayoutBudget();
        const measure=function(text:string){const size=Number(c.font.match(/ ([\d.e+-]+)px/)![1]);return {width:Array.from(text).length*size,actualBoundingBoxAscent:text?size*.7:0,actualBoundingBoxDescent:text?size*.2:0,actualBoundingBoxLeft:0,actualBoundingBoxRight:Array.from(text).length*size};};
        c.measureText.mockImplementation(measure);const spaces=[box(10,10,116,50),box()];Object.defineProperty(spaces,1,{get(){throw Error('maximum-size stops later candidates');}});
        const result=planMangaBlankTranslation(c as any,r,W,H,spaces,budget)!;expect(result.bbox).toEqual(spaces[0]);expect(result.fontSize).toBe(r.fontSize);expect(budget.remainingMeasurements).toBeGreaterThan(900);
        const small=context();small.measureText.mockImplementation(function(text:string){const size=Number(small.font.match(/ ([\d.e+-]+)px/)![1]);return {width:Array.from(text).length*size,actualBoundingBoxLeft:0,actualBoundingBoxRight:Array.from(text).length*size,actualBoundingBoxAscent:size*.7,actualBoundingBoxDescent:size*.2};});
        expect(planMangaBlankTranslation(small as any,r,W,H,[box(10,10,110,44)])?.text).toBe(r.text);
    });
    it('只有新高字号的原生指标失效时撤回，且预算退出后的restore异常仍传播',()=>{
        const c=context(),base=c.measureText.getMockImplementation()!;c.measureText.mockImplementation(text=>Number(c.font.match(/ ([\d.e+-]+)px/)![1])>20?{width:NaN,actualBoundingBoxAscent:14,actualBoundingBoxDescent:4} as any:base(text));
        expect(plan(c)).toBeUndefined();expect(c.restore).toHaveBeenCalledOnce();
        const cleanup=new Error('restore after budget failed'),limited=context();limited.restore.mockImplementation(()=>{throw cleanup;});
        expect(()=>planMangaBlankTranslation(limited as any,{...region('字'.repeat(4096)),fontSize:7,bbox:box(20,120,150,160)},220,220,fragmentedSpaces(),createMangaBlankLayoutBudget())).toThrow(cleanup);
    });
});
