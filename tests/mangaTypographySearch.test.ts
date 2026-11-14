import {describe,expect,it,vi} from 'vitest';
import {createMangaTranslationSearch,layoutMangaTranslationText} from '@/src/features/image-translation/services/mangaTypography';
import {drawMangaTranslations} from '@/src/features/image-translation/services/mangaRendering';
import type {MangaAlphaProtection} from '@/src/features/image-translation/services/mangaAlphaProtection';

const measure=(text:string,size:number)=>Array.from(text).length*size*.6;
const ink=(_text:string,size:number)=>({ascent:size*.7,descent:size*.2});
const empty={lines:[],fontSize:0,lineHeight:0};

describe('共享分词的有界漫画候选搜索',()=>{
    it('短东亚正文的词分割只做一次，候选搜索复用；全文与token预算在调用分割器之前检查',async()=>{
        vi.resetModules();const NativeSegmenter=Intl.Segmenter,words=vi.fn();
        class ObservedSegmenter {
            private readonly native:Intl.Segmenter;private readonly word:boolean;
            constructor(locales?:string,options?:Intl.SegmenterOptions){this.native=new NativeSegmenter(locales,options);this.word=options?.granularity==='word';}
            segment(text:string){if(this.word)words(text);return this.native.segment(text);}
        }
        vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?ObservedSegmenter:Reflect.get(target,key)}));
        try{
            const {createMangaTranslationSearch:factory,layoutMangaTranslationText:layout}=await import('@/src/features/image-translation/services/mangaTypography');
            const search=factory('流畅阅读：看懂每一页漫画',measure,10,ink);
            for(const [width,height]of [[60,24],[70,30],[90,40]])search.finish(search.prepare(width,height));
            expect(words).toHaveBeenCalledOnce();words.mockClear();
            for(const text of ['甲乙'+'a'.repeat(1023),'甲'.repeat(257),'ASCII words only','甲'])layout(text,10000,100,measure,1);
            expect(words).not.toHaveBeenCalled();
            for(const text of ['甲乙'+'a'.repeat(1022),'甲'.repeat(256)]){
                const result=layout(text,10000,100,measure,1);expect(result.lines.join('')).toBe(text);
            }
            expect(words).toHaveBeenCalledTimes(2);
            const explicit=layout('保持根部\n\n露出水面。',100,100,measure,10);
            expect(explicit.lines).toEqual(['保持根部','','露出水面。']);
        }finally{vi.unstubAllGlobals();vi.resetModules();}
    });
    it('未fit的最大字号只留下数字尺寸，完成后仍与旧十二轮全文排版一致',()=>{
        const search=createMangaTranslationSearch('保留完整译文。Alpha Ågyp',measure,30,ink);
        const candidate=search.prepare(54,24);
        expect(candidate).toEqual({width:54,height:24});
        expect(Object.values(candidate).every(value=>typeof value==='number')).toBe(true);
        expect(search.finish(candidate)).toEqual(layoutMangaTranslationText('保留完整译文。Alpha Ågyp',54,24,measure,30,ink));
    });
    it('最大字号可用时立即保留完整布局，平衡与显式空段沿用旧结果',()=>{
        for(const text of ['A\n\nB','我早就确认过了。','']){
            const search=createMangaTranslationSearch(text,measure,10,ink),state=search.prepare(50,80);
            expect(state.maximum).toEqual(layoutMangaTranslationText(text,50,80,measure,10,ink));
            expect(search.finish(state)).toBe(state.maximum);
        }
    });
    it('先前索引保留同字号平局，后续索引不能替换；剪枝不损坏下次局部高低界',()=>{
        const text='完整的长译文 Alpha Beta',search=createMangaTranslationSearch(text,measure,30,ink),state=search.prepare(80,22);
        const original=layoutMangaTranslationText(text,80,22,measure,30,ink);
        expect(search.finish(state,Infinity)).toBeUndefined();
        expect(search.finish(state,original.fontSize,true)).toEqual(original);
        expect(search.finish(state,original.fontSize,false)).toBeUndefined();
        expect(search.finish(state)).toEqual(original);
    });
    it('非单调但稳定的宽高指标仍保存旧二分结果，不用面积或估算字高剔除',()=>{
        const text='ABCDEFG 你好。عَرَبِيّ';
        const width=(value:string,size:number)=>Array.from(value).length*(size*.5+Math.sin(size*3)*.15+.15);
        const glyph=(_value:string,size:number)=>({ascent:size*(.4+(Math.sin(size*4)+1)*.2),descent:size*.2});
        for(const [w,h] of [[17,6],[40,18],[83,21],[120,40]]){
            const search=createMangaTranslationSearch(text,width,30,glyph),state=search.prepare(w,h);
            const original=layoutMangaTranslationText(text,w,h,width,30,glyph);
            expect(search.finish(state)).toEqual(original);
            if(!state.maximum)expect(search.finish(state,original.fontSize,true)).toEqual(original);
        }
    });
    it('失败中点降低high后立即跳过不可能赢的后续轮次，重新完成仍保留旧结果',()=>{
        const text='完整译文',width=vi.fn(measure),search=createMangaTranslationSearch(text,width,30,ink),state=search.prepare(80,2);
        width.mockClear();expect(search.finish(state,20)).toBeUndefined();
        const prunedCalls=width.mock.calls.length;width.mockClear();
        expect(search.finish(state)).toEqual(layoutMangaTranslationText(text,80,2,measure,30,ink));
        expect(width.mock.calls.length).toBeGreaterThan(prunedCalls);
    });
    it('没有或缺少字形指标时保留行框回退，NaN和Infinity不伪造完整ink',()=>{
        for(const glyph of [undefined,()=>undefined,()=>({ascent:NaN,descent:1}),()=>({ascent:1,descent:Infinity}),()=>({ascent:Number.MAX_VALUE,descent:Number.MAX_VALUE}),()=>({ascent:-2,descent:2})]){
            const text='Hello 你好\n\nÅgyp',search=createMangaTranslationSearch(text,measure,20,glyph),state=search.prepare(45,26);
            const expected=layoutMangaTranslationText(text,45,26,measure,20,glyph);
            expect(search.finish(state)).toEqual(expected);expect(search.finish(state)?.ink).toBeUndefined();
        }
        for(const value of [NaN,Infinity]){
            const width=()=>value,search=createMangaTranslationSearch('内容',width,10,ink),state=search.prepare(30,12);
            expect(search.finish(state)).toEqual(layoutMangaTranslationText('内容',30,12,width,10,ink));
        }
    });
    it('非法尺寸与最大字号、空文本不调用度量，普通API先校验再分词',()=>{
        const spy=vi.fn(measure);
        for(const bad of [0,-1,NaN,Infinity]){
            expect(layoutMangaTranslationText('内容',bad,20,spy,10)).toEqual(empty);
            expect(layoutMangaTranslationText('内容',20,bad,spy,10)).toEqual(empty);
            expect(layoutMangaTranslationText('内容',20,20,spy,bad)).toEqual(empty);
            const search=createMangaTranslationSearch('内容',spy,10);
            expect(search.finish(search.prepare(bad,20))).toEqual(empty);
            expect(search.finish({width:20,height:bad})).toEqual(empty);
            const invalid=createMangaTranslationSearch('内容',spy,bad);
            expect(invalid.finish(invalid.prepare(20,20))).toEqual(empty);
        }
        expect(createMangaTranslationSearch(' \r\n ',spy,10).prepare(20,20).maximum).toEqual(empty);
        expect(spy).not.toHaveBeenCalled();
        const match=vi.spyOn(String.prototype,'match');
        try {layoutMangaTranslationText('先校验',NaN,20,spy,10);expect(match).not.toHaveBeenCalled();}
        finally {match.mockRestore();}
    });
    it('初始low高于极小max时不使用错误上界，仍沿用旧浮点运算',()=>{
        const width=()=>100,search=createMangaTranslationSearch('tiny',width,.1,ink),state=search.prepare(20,1);
        expect(state.maximum).toBeUndefined();
        expect(search.finish(state)).toEqual(layoutMangaTranslationText('tiny',20,1,width,.1,ink));
    });
    it('同区域候选的超宽词只分字素一次，不保留每候选分词副本',async()=>{
        vi.resetModules();const segment=vi.fn((value:string)=>Array.from(value,part=>({segment:part})));
        class Segmenter {segment=segment;}
        vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?Segmenter:Reflect.get(target,key)}));
        try {
            const {createMangaTranslationSearch:factory}=await import('@/src/features/image-translation/services/mangaTypography');
            const search=factory('abcdefgh😊abcdefgh',measure,20,ink);
            const states=[search.prepare(8,20),search.prepare(9,21),search.prepare(10,22)];
            for(const state of states)search.finish(state);
            expect(segment).toHaveBeenCalledTimes(1);
            expect(states.every(state=>Object.keys(state).join(',')==='width,height')).toBe(true);
        }finally {vi.unstubAllGlobals();vi.resetModules();}
    });
    it('预检与完成搜索的原生异常保持同一对象向上传播',()=>{
        const native=new DOMException('lost context','InvalidStateError');
        const broken=createMangaTranslationSearch('内容',()=>{throw native;},20,ink);
        expect(()=>broken.prepare(20,10)).toThrow(native);
        let fail=false;const width=(text:string,size:number)=>{if(fail)throw native;return measure(text,size);};
        const search=createMangaTranslationSearch('完整长文 ABCDEFG',width,30,ink),state=search.prepare(20,10);fail=true;
        try {search.finish(state);throw new Error('expected native error');}catch(error){expect(error).toBe(native);}
        const glyph=createMangaTranslationSearch('A',measure,20,()=>{throw native;});
        expect(()=>glyph.prepare(100,100)).toThrow(native);
    });
});

function context(){return {font:'',lineWidth:0,save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),fillRect:vi.fn(),strokeText:vi.fn(),fillText:vi.fn(),
    measureText:vi.fn(function(this:{font:string},text:string):{width:number;actualBoundingBoxAscent?:number;actualBoundingBoxDescent?:number}{const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]);return {width:measure(text,size),actualBoundingBoxAscent:size*.7,actualBoundingBoxDescent:size*.2};})};}
const protection=(rectangles:MangaAlphaProtection['rectangles']):MangaAlphaProtection=>({rectangles,runs:new Uint16Array(),rowStarts:new Uint32Array()});
describe('原生Canvas候选编排',()=>{
    const w=320,h=160,pixels=new Uint8ClampedArray(w*h*4).fill(255),region={text:'完整保留译文 Alpha Beta',fontSize:20,bbox:{x0:20,y0:20,x1:300,y1:140}},backgrounds=[{uniform:false,color:'rgb(255,255,255)'}];
    it('数值度量失败时仍归还区域及共享clip上下文，不输出部分文字',()=>{
        const c=context(),native=new DOMException('failed metrics','InvalidStateError');c.measureText.mockImplementation(()=>{throw native;});
        try {drawMangaTranslations(c as any,pixels,w,h,[region],true,backgrounds,protection([{x0:100,y0:40,x1:110,y1:70}]));throw new Error('expected');}
        catch(error){expect(error).toBe(native);}
        expect(c.save).toHaveBeenCalledTimes(2);expect(c.restore).toHaveBeenCalledTimes(2);expect(c.fillText).not.toHaveBeenCalled();
    });
    it('无孔和框外保护具有完全相同的度量调用顺序与完整绘制',()=>{
        const a=context(),b=context();
        drawMangaTranslations(a as any,pixels,w,h,[region],true,backgrounds);
        drawMangaTranslations(b as any,pixels,w,h,[region],true,backgrounds,protection([{x0:1,y0:1,x1:5,y1:5}]));
        expect(b.measureText.mock.calls).toEqual(a.measureText.mock.calls);expect(b.fillText.mock.calls).toEqual(a.fillText.mock.calls);expect(b.font).toBe(a.font);
    });
    it('空白内容的零字号不是最大字号，仍按原序扣全页额外候选预算',()=>{
        const c=context(),regions=Array.from({length:180},()=>({...region,text:' \r\n '}));
        expect(()=>drawMangaTranslations(c as any,pixels,w,h,regions,true,regions.map(()=>backgrounds[0]),protection([{x0:100,y0:40,x1:110,y1:70}]))).toThrow('过于复杂');
        expect(c.save).toHaveBeenCalledTimes(172);expect(c.restore).toHaveBeenCalledTimes(172);
        expect(c.measureText).not.toHaveBeenCalled();expect(c.fillText).not.toHaveBeenCalled();
    });
    it('极小max多候选保持旧搜索，跳过不fit窄条并在真正最大字号处原序停止',()=>{
        const c=context(),item={...region,text:'A',fontSize:.4},hole={x0:150,y0:21,x1:154,y1:139};
        drawMangaTranslations(c as any,pixels,w,h,[item],true,backgrounds,protection([hole]));
        expect(c.rect.mock.calls.at(-1)).toEqual([20,20,130,120]);expect(c.font).toContain('0.42000000000000004px');
        expect(c.fillText.mock.calls.map(args=>args[0]).join('')).toBe('A');
        const blank=context(),items=Array.from({length:180},()=>({...item,text:' '}));
        expect(()=>drawMangaTranslations(blank as any,pixels,w,h,items,true,items.map(()=>backgrounds[0]),protection([hole]))).toThrow('过于复杂');
        expect(blank.save).toHaveBeenCalledTimes(172);expect(blank.restore).toHaveBeenCalledTimes(172);
    });
    it('等面积候选先完成较大区域，字号完全相同时仍让较早原索引胜出',()=>{
        const c=context(),item={...region,text:'A'};
        c.measureText.mockImplementation(function(this:{font:string},text:string){
            const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]);
            return {width:measure(text,size),actualBoundingBoxAscent:size>10?200:5,actualBoundingBoxDescent:1};
        });
        drawMangaTranslations(c as any,pixels,w,h,[item],true,backgrounds,protection([{x0:155,y0:75,x1:165,y1:85}]));
        expect(c.rect.mock.calls.at(-1)).toEqual([20,20,280,55]);
        expect(c.fillText.mock.calls.map(args=>args[0]).join('')).toBe('A');
    });
    it('实际dock几何选择完整右侧矩形；缺失或非正ink时仍完整回退行框',()=>{
        const width=1200,height=450,p=new Uint8ClampedArray(width*height*4).fill(255);
        const item={text:'流畅阅读：看懂每一页漫画',fontSize:28,bbox:{x0:242,y0:226,x1:654,y1:254}},hole={x0:327,y0:232,x1:333,y1:250};
        for(const metric of ['valid','missing','zero'] as const){
            const c=context();
            if(metric!=='valid')c.measureText.mockImplementation(function(this:{font:string},text:string){
                const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]);return {width:measure(text,size),...(metric==='zero'?{actualBoundingBoxAscent:-2,actualBoundingBoxDescent:2}:{})};
            });
            drawMangaTranslations(c as any,p,width,height,[item],true,backgrounds,protection([hole]));
            expect(c.rect.mock.calls.at(-1)).toEqual([333,226,321,28]);
            expect(c.fillText.mock.calls.map(args=>args[0]).join('')).toBe(item.text);
        }
    });
});
