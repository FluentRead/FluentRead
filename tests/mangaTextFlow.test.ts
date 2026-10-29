import {describe,it,expect,vi} from 'vitest';
import {planMangaTextFlow,MANGA_TEXT_FLOW_LIMITS,type MangaTextFlowBox,type MangaTextFlowMetrics,type MangaTextFlowReference} from '@/src/features/image-translation/services/mangaTextFlow';
import {layoutMangaTranslationText,MANGA_TEXT_FONT} from '@/src/features/image-translation/services/mangaTypography';
const box={x0:0,y0:0,x1:200,y1:160};
const metrics=(text:string):MangaTextFlowMetrics=>({width:Array.from(text).length*5,actualBoundingBoxLeft:0,actualBoundingBoxRight:Array.from(text).length*5,actualBoundingBoxAscent:6,actualBoundingBoxDescent:2});
function reference(lines=['你好'],b:MangaTextFlowBox=box):MangaTextFlowReference{return{box:{...b},fontSize:10,lineWidth:1,family:MANGA_TEXT_FONT,style:'600',layout:{lines:[...lines],fontSize:10,lineHeight:12,ink:{height:10+Math.max(0,lines.length-1)*12,baselines:lines.map((_,i)=>7+i*12)}}};}
const hole=(x0:number,x1:number,y0=70,y1=90)=>({x0,x1,y0,y1});
const expectFailure=(result:ReturnType<typeof planMangaTextFlow>,reason:string)=>{expect(result.accepted).toBe(false);if(!result.accepted){expect(result.reason).toBe(reason);expect(result.chunks).toEqual([]);}return result;};

describe('漫画无孔水平流式规划',()=>{
    it('透明孔分隔时不能拆开 emoji ZWJ 字素，即使每半部分单独放得下',()=>{
        const text='👩‍㊗️',r=planMangaTextFlow(text,reference([text]),[hole(102,103)],metrics);
        if(r.accepted){expect(r.chunks.map(chunk=>chunk.text)).toEqual([text]);}
        else expect(r.chunks).toEqual([]);
    });
    it.each([
        ['（\uFE0F字',[hole(105,115)]],['漢！\uFE0F字',[hole(100,110)]],
        ['（\u200d字',[hole(105,115)]],['漢！\u0301字',[hole(100,110)]],
        ['ABC（漢字）',[hole(105,115)]],['漢!HELLO',[hole(100,110)]],['𠀀HELLO（文字）',[hole(112,122)]],
        ['漢 !HELLO',[hole(100,110)]],['漢 \t ,ABC',[hole(100,110)]],
        ['漢 \t !\uFE0FHELLO',[hole(100,110)]],['「  !HELLO',[hole(100,110)]],
    ])('带组合符的标点随相邻文字跨孔：%s',(text,holes)=>{
        const r=planMangaTextFlow(text,reference([text]),holes,metrics);
        if(!r.accepted){expect(r.chunks).toEqual([]);return;}
        expect(r.chunks.map(chunk=>chunk.text).join('')).toBe(text);
        expect(r.chunks.every(chunk=>!/[（(][\p{Mark}\u200c\u200d]*$/u.test(chunk.text)
            && !/^[！!，。?][\p{Mark}\u200c\u200d]*/u.test(chunk.text))).toBe(true);
    });
    it.each(['👩‍㊗️','㊙️‍👨','𠀀\u{E0100}HELLO','かﾞHELLO','漢🏽TEST','\u0600𠀀A','A \u0301漢'])
    ('多孔和不同框尺寸均只在完整字素边界切分：%s',text=>{
        const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
        const boundaries=new Set([0,...Array.from(segmenter.segment(text),part=>part.index+part.segment.length)]);
        for(const [w,holes] of [[200,[hole(102,103),hole(130,131)]],[100,[hole(51,53)]],[45,[hole(23,25)]]] as const){
            const r=planMangaTextFlow(text,reference([text],{...box,x1:w}),holes,metrics);
            if(!r.accepted){expect(r.chunks).toEqual([]);continue;}
            expect(r.chunks.map(chunk=>chunk.text).join('')).toBe(text);
            let offset=0;for(const chunk of r.chunks){offset+=chunk.text.length;expect(boundaries.has(offset)).toBe(true);}
        }
    });
    it.each(['Supercalifragilistic','https://x.test/3.14','3.14','AB(CD)'])
    ('绕孔不会拆开英文长词、网址或数字 %s',text=>{
        const r=planMangaTextFlow(text,reference([text],{...box,x1:45}),[hole(20,25)],metrics);
        expectFailure(r,'intact-tokens-do-not-fit');
    });
    it('无字素分段器时复杂词界拒绝绕孔并保留可恢复的完整输入',async()=>{
        vi.resetModules();vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?undefined:Reflect.get(target,key)}));
        try{
            const {planMangaTextFlow:fallback}=await import('@/src/features/image-translation/services/mangaTextFlow');
            const text='👩‍㊗️',r=fallback(text,reference([text]),[hole(102,103)],metrics);
            expectFailure(r,'grapheme-segmentation-unavailable');
            for(const [text,holes] of [['ABC（漢字）',[hole(105,115)]],['漢!HELLO',[hole(100,110)]],
                ['漢 !HELLO',[hole(100,110)]],['漢 \t ,ABC',[hole(100,110)]]] as const){
                expectFailure(fallback(text,reference([text]),holes,metrics),'grapheme-segmentation-unavailable');
            }
            const leading='  !HELLO',first=fallback(leading,reference([leading]),[],metrics);
            expect(first.accepted).toBe(true);if(first.accepted)expect(first.chunks.map(chunk=>chunk.text).join('')).toBe(leading);
            const simple='你好 HELLO';const safe=fallback(simple,reference([simple]),[],metrics);
            expect(safe.accepted).toBe(true);if(safe.accepted)expect(safe.chunks.map(chunk=>chunk.text).join('')).toBe(simple);
            // 未发生词界拆分的整词无需猜测字素边界。
            const word='e\u0301HELLO',whole=fallback(word,reference([word]),[],metrics);
            expect(whole.accepted).toBe(true);if(whole.accepted)expect(whole.chunks.map(chunk=>chunk.text).join('')).toBe(word);
        }finally{vi.unstubAllGlobals();vi.resetModules();}
    });
    it('无分段器且复杂字素跨词时，绘制链回退连续矩形而不创建绕孔画布',async()=>{
        vi.resetModules();vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?undefined:Reflect.get(target,key)}));
        const createElement=vi.fn();vi.stubGlobal('document',{createElement});
        try{
            const {drawMangaTranslations}=await import('@/src/features/image-translation/services/mangaRendering');
            const text='👩‍㊗️',pixelWidth=200,pixelHeight=160,pixels=new Uint8ClampedArray(pixelWidth*pixelHeight*4).fill(255);
            const c={font:'',lineWidth:0,textAlign:'',save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),fillRect:vi.fn(),strokeText:vi.fn(),fillText:vi.fn(),drawImage:vi.fn(),
                measureText:vi.fn(function(this:{font:string},value:string){const size=Number(this.font.match(/ ([\d.e+-]+)px/)![1]),width=Array.from(value).length*size*.6;
                    return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width,actualBoundingBoxAscent:size*.7,actualBoundingBoxDescent:size*.2};})};
            const bounds={x0:0,y0:0,x1:200,y1:160},protectedHole=hole(102,103,0,160);
            drawMangaTranslations(c as any,pixels,pixelWidth,pixelHeight,[{text,fontSize:10,bbox:bounds}],true,[{uniform:false,color:'#fff'}],
                {rectangles:[protectedHole],runs:new Uint16Array(),rowStarts:new Uint32Array()});
            expect(createElement).not.toHaveBeenCalled();expect(c.drawImage).not.toHaveBeenCalled();
            expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe(text);
            expect(c.save).toHaveBeenCalledTimes(c.restore.mock.calls.length);
            c.fillText.mockClear();
            expect(()=>drawMangaTranslations(c as any,pixels,pixelWidth,pixelHeight,[{text,fontSize:10,bbox:bounds}],true,[{uniform:false,color:'#fff'}],
                {rectangles:[hole(0,200,0,160)],runs:new Uint16Array(),rowStarts:new Uint32Array()})).toThrow('已保留原图');
            expect(createElement).not.toHaveBeenCalled();expect(c.fillText).not.toHaveBeenCalled();
        }finally{vi.unstubAllGlobals();vi.resetModules();}
    });
    it('复用既有完整排版与字体，纯measure端口不触Canvas',()=>{
        const text='你好世界';
        const layout=layoutMangaTranslationText(text,200,160,(s)=>metrics(s).width,10,()=>({ascent:7,descent:3}));
        const ref={...reference(),layout},r=planMangaTextFlow(text,ref,[],metrics);
        expect(r.accepted).toBe(true);if(!r.accepted)return;
        expect(r.chunks.map(c=>c.text).join('')).toBe(text);expect(r.font).toBe(`600 10px ${MANGA_TEXT_FONT}`);
        expect(r.fontSize).toBe(10);expect(r.lineWidth).toBe(1);expect(r.rows).toHaveLength(layout.lines.length);
    });
    it('原行内沿两侧区间顺序放完整token，不缩字号或改变垂直坐标',()=>{
        const text='漢'.repeat(26),ref=reference([text]),holes=[hole(82,102)];
        const a=planMangaTextFlow(text,ref,holes,metrics),b=planMangaTextFlow(text,ref,holes,metrics,1);
        expect(a.accepted&&b.accepted).toBe(true);if(!a.accepted||!b.accepted)return;
        for(const r of [a,b]){expect(r.chunks).toHaveLength(2);expect(r.chunks.map(c=>c.text).join('')).toBe(text);expect(r.chunks[0].tokenStart).toBe(0);expect(r.chunks.at(-1)!.tokenEnd).toBe(26);expect(r.chunks.every(c=>c.y===82)).toBe(true);expect(r.rows[0]).toMatchObject({baseline:82,band:{y0:75,y1:85}});expect(r.fontSize).toBe(10);}
        expect(b.chunks[0].x-a.chunks[0].x).toBe(1);expect(b.rows).toEqual(a.rows);
    });
    it('多个原行和显式空段完整保留，包括各自原始基线',()=>{
        const ref=reference(['Hello','','中文 OK']),r=planMangaTextFlow('Hello\n\n中文 OK',ref,[],metrics);
        expect(r.accepted).toBe(true);if(!r.accepted)return;
        expect(r.rows.map(row=>row.baseline)).toEqual([70,82,94]);expect(r.rows[1]).toEqual({row:1,empty:true,baseline:82});
        expect(r.chunks.filter(c=>c.row===0).map(c=>c.text).join('')).toBe('Hello');expect(r.chunks.filter(c=>c.row===2).map(c=>c.text).join('')).toBe('中文 OK');
    });
    it('整词无法装入任一span则完整回退，不按字符拆开英文或组合音标',()=>{
        for(const text of ['HelloWorld','e\u0301longword'])expectFailure(planMangaTextFlow(text,reference([text],{...box,x1:55}),[hole(20,35)],metrics),'intact-tokens-do-not-fit');
    });
    it.each(['「你好」。再见！','。你好','你好 。','「','（『你好』）','你好：再见'])('标点与开括号依附且原行逐字完整：%s',text=>{
        const r=planMangaTextFlow(text,reference([text]),[],metrics);expect(r.accepted).toBe(true);if(r.accepted)expect(r.chunks.map(c=>c.text).join('')).toBe(text);
    });
    it('句末符号隔着合法空白仍绑定前字，不独自跨到孔另一侧',()=>{
        const text='你好 。',r=planMangaTextFlow(text,reference([text]),[hole(107,117)],metrics);
        expect(r.accepted).toBe(true);if(!r.accepted)return;
        expect(r.chunks.map(c=>c.text)).toEqual(['你','好 。']);expect(r.chunks.map(c=>c.text).join('')).toBe(text);
        expect(r.chunks[0].bounds.x1).toBeLessThanOrEqual(107);expect(r.chunks[1].bounds.x0).toBeGreaterThanOrEqual(117);
        const spaced='你好 \t 。',tabs=planMangaTextFlow(spaced,reference([spaced]),[hole(105,115)],metrics);
        expect(tabs.accepted).toBe(true);if(tabs.accepted){expect(tabs.chunks.map(c=>c.text)).toEqual(['你','好 \t 。']);expect(tabs.chunks.map(c=>c.text).join('')).toBe(spaced);}
    });
    it('开括号跨合法空白绑定后字，不把悬空开括号留在孔前',()=>{
        const text='「 你好',r=planMangaTextFlow(text,reference([text]),[hole(102,112)],metrics);
        expect(r.accepted).toBe(true);if(!r.accepted)return;
        expect(r.chunks.map(c=>c.text)).toEqual([text]);expect(r.chunks[0].bounds.x0).toBeGreaterThanOrEqual(112);
        for(const text of ['「 \t 你好','（ 「 你好']){
            const r=planMangaTextFlow(text,reference([text]),[hole(102,112)],metrics);expect(r.accepted).toBe(true);
            if(r.accepted){expect(r.chunks.map(c=>c.text).join('')).toBe(text);expect(r.chunks.every(c=>!/[「（]\s*$/u.test(c.text))).toBe(true);}
        }
    });
    it('开括号后只有空白和闭标点时不能在正文前截断',async()=>{
        for(const noSegmenter of [false,true]){
            if(noSegmenter){vi.resetModules();vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?undefined:Reflect.get(target,key)}));}
            try{
                const {planMangaTextFlow:plan}=await import('@/src/features/image-translation/services/mangaTextFlow');
                for(const text of ['「  !HELLO','「 \t ,ABC','「  !\uFE0FHELLO']){
                    const r=plan(text,reference([text]),[hole(100,110)],metrics);
                    if(r.accepted){expect(r.chunks.map(c=>c.text).join('')).toBe(text);expect(r.chunks.every(c=>!/^「[\s!,\uFE0F]+$/u.test(c.text))).toBe(true);}
                    else expect(r.chunks).toEqual([]);
                }
            }finally{if(noSegmenter){vi.unstubAllGlobals();vi.resetModules();}}
        }
    });
    it('绑定不跨原reference行；孤立标点和没有后字的开括号空白仍原样保留',()=>{
        for(const text of ['  。你好','  。','「 \t ']){
            const r=planMangaTextFlow(text,reference([text]),[],metrics);expect(r.accepted).toBe(true);
            if(r.accepted)expect(r.chunks.map(c=>c.text).join('')).toBe(text);
        }
        const r=planMangaTextFlow('你好 \n。再见',reference(['你好 ','。再见']),[],metrics);expect(r.accepted).toBe(true);
        if(r.accepted){expect(r.chunks.filter(c=>c.row===0).map(c=>c.text).join('')).toBe('你好 ');expect(r.chunks.filter(c=>c.row===1).map(c=>c.text).join('')).toBe('。再见');}
    });
    it('ASCII冒号与既有Typography一致绑定，空格和单词内冒号均不丢失',()=>{
        const text='Alpha : ',r=planMangaTextFlow(text,reference([text]),[hole(112,122)],metrics);
        expect(r.accepted).toBe(true);if(r.accepted){expect(r.chunks.map(c=>c.text)).toEqual([text]);expect(r.chunks[0].bounds.x0).toBeGreaterThanOrEqual(122);}
        for(const text of ['Alpha : ','Alpha:Beta','Alpha:']){const r=planMangaTextFlow(text,reference([text]),[],metrics);expect(r.accepted).toBe(true);if(r.accepted)expect(r.chunks.map(c=>c.text).join('')).toBe(text);}
    });
    it('空原行不调用metrics，空白token不独自成为可绘制片段',()=>{
        const m=vi.fn(metrics),empty=planMangaTextFlow('',reference(['']),[],m);expect(empty.accepted).toBe(true);expect(m).not.toHaveBeenCalled();
        const r=planMangaTextFlow(' 你',reference([' 你']),[],metrics);expect(r.accepted).toBe(true);if(r.accepted)expect(r.chunks.map(c=>c.text).join('')).toBe(' 你');
        expectFailure(planMangaTextFlow(' ',reference([' ']),[],metrics),'intact-tokens-do-not-fit');
    });
    it('裁入区域的重复/相邻孔归并，外部孔不挡字，输入和输出无可写别名',()=>{
        const ref=reference(['你好']),holes=[hole(-10,70),hole(60,100),hole(100,110),hole(500,510),hole(10,20,300,310)];
        const before=structuredClone({ref,holes}),r=planMangaTextFlow('你好',ref,holes,metrics);expect(r.accepted).toBe(true);expect({ref,holes}).toEqual(before);if(!r.accepted)return;
        expect(r.rows[0]).toMatchObject({spans:[{x0:110,x1:200}]});r.chunks[0].span.x0=999;r.chunks[0].bounds.y0=999;expect({ref,holes}).toEqual(before);
    });
    it('中心位于孔后时跳过左span，不把原本居中行先拉到最左',()=>{
        const r=planMangaTextFlow('AB',reference(['AB']),[hole(10,40),hole(50,80)],metrics);expect(r.accepted).toBe(true);if(r.accepted)expect(r.chunks[0].bounds.x0).toBe(95);
    });
    it('真实左右overhang纳入边界，安全量只增横向pad',()=>{
        const m=(s:string)=>({...metrics(s),actualBoundingBoxLeft:3,actualBoundingBoxRight:metrics(s).width+4});
        const a=planMangaTextFlow('AB',reference(['AB']),[],m),b=planMangaTextFlow('AB',reference(['AB']),[],m,1);
        expect(a.accepted&&b.accepted).toBe(true);if(!a.accepted||!b.accepted)return;
        expect(a.chunks[0].bounds).toEqual({x0:95,x1:114,y0:75,y1:85});expect(b.chunks[0].bounds).toEqual({x0:95,x1:116,y0:75,y1:85});
        const negative=planMangaTextFlow('AB',reference(['AB']),[],s=>({...metrics(s),actualBoundingBoxLeft:-1}));expect(negative.accepted).toBe(true);
    });
    it('孔填满原框、边缘接触或留空span也不能绕到框外',()=>{
        const ref=reference(['你好']);expectFailure(planMangaTextFlow('你好',ref,[{...box}],metrics),'intact-tokens-do-not-fit');
        const r=planMangaTextFlow('你好',ref,[hole(0,100),hole(100,200)],metrics);expectFailure(r,'intact-tokens-do-not-fit');
        const vertical=planMangaTextFlow('你好',ref,[hole(0,200,85,90),hole(0,200,60,75)],metrics);expect(vertical.accepted).toBe(true);
    });
});

describe('流式规划的保守准入与有界工作量',()=>{
    it.each(['مرحبا','שלום','ภาษาไทย','हिन्दी','한글','abc\u202e','abc\u200e','abc\u200f'])('不支持的方向/上下文脚本完整回退：%s',text=>{
        const m=vi.fn(metrics);expectFailure(planMangaTextFlow(text,reference([text]),[],m),'unsupported-bidi-or-context-script');expect(m).not.toHaveBeenCalled();
    });
    it('ref行中出现不支持脚本亦不触度量',()=>expectFailure(planMangaTextFlow('abc',reference(['مرحبا']),[],metrics),'unsupported-bidi-or-context-script'));
    it('全文/原行总字符、原行数、token总量均有独立硬边界',()=>{
        expectFailure(planMangaTextFlow('x'.repeat(4097),reference(['x']),[],metrics),'input-budget');
        expectFailure(planMangaTextFlow('x',reference(['x'.repeat(4097)]),[],metrics),'input-budget');
        expectFailure(planMangaTextFlow('x',reference(Array(17).fill('x')),[],metrics),'row-budget');
        const text='漢'.repeat(257);expectFailure(planMangaTextFlow(text,reference([text],{...box,x1:2000}),[],metrics),'token-budget');
        expectFailure(planMangaTextFlow(text,reference(['漢'.repeat(130),'漢'.repeat(127)],{...box,x1:2000}),[],metrics),'token-budget');
    });
    it.each(['fontSize','lineWidth','x0','x1','y0','y1','horizontalSafety'] as const)('非有限原参数拒绝：%s',key=>{
        let ref=reference();let safety=0;if(key==='horizontalSafety')safety=NaN;else if(key==='fontSize'||key==='lineWidth')ref={...ref,[key]:NaN};else ref.box[key]=NaN;
        expectFailure(planMangaTextFlow('你好',ref,[],metrics,safety),'invalid-reference');
    });
    it('非法正负/相反范围、空字体和字号身份不匹配均不修改原行',()=>{
        const candidates=[{fontSize:0},{lineWidth:0},{lineWidth:-1},{family:''},{style:''}];for(const patch of candidates)expectFailure(planMangaTextFlow('你好',{...reference(),...patch},[],metrics),'invalid-reference');
        expectFailure(planMangaTextFlow('你好',reference(),[],metrics,-1),'invalid-reference');
        for(const b of [{...box,x1:0},{...box,y1:0}])expectFailure(planMangaTextFlow('你好',reference(['你好'],b),[],metrics),'invalid-reference');
        const ref=reference();ref.layout.fontSize=9;expectFailure(planMangaTextFlow('你好',ref,[],metrics),'invalid-reference');
    });
    it('缺少/无效的原ink范围与baseline完整回退',()=>{
        const ref=reference();delete ref.layout.ink;expectFailure(planMangaTextFlow('你好',ref,[],metrics),'incomplete-or-unfit-original-ink');
        for(const ink of [{height:NaN,baselines:[7]},{height:0,baselines:[7]},{height:200,baselines:[7]},{height:10,baselines:[]},{height:10,baselines:[NaN]}]){
            const r=reference();r.layout.ink=ink;expectFailure(planMangaTextFlow('你好',r,[],metrics),'incomplete-or-unfit-original-ink');
        }
    });
    it.each(['width','actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent'] as const)('不完整native metrics回退：%s',key=>{
        expectFailure(planMangaTextFlow('你好',reference(),[],s=>({...metrics(s),[key]:NaN})),'missing-glyph-metrics');
    });
    it('原整行字形带上下越框时回退，而非移动原baseline',()=>{
        for(const patch of [{actualBoundingBoxAscent:200},{actualBoundingBoxDescent:200}])expectFailure(planMangaTextFlow('你好',reference(),[],s=>({...metrics(s),...patch})),'original-line-band-outside-bbox');
    });
    it('候选字形比原整行更高也不能越框，真实垂直位置保持',()=>{
        for(const patch of [{actualBoundingBoxAscent:200},{actualBoundingBoxDescent:200}]){let n=0;expectFailure(planMangaTextFlow('你好',reference(),[],s=>({...metrics(s),...(n++?patch:{})})),'intact-tokens-do-not-fit');}
    });
    it('非法孔坐标与相反范围均有界拒绝',()=>{
        for(const h of [hole(NaN,10),hole(20,10),hole(10,20,90,70)])expectFailure(planMangaTextFlow('你好',reference(),[h],metrics),'invalid-hole');
    });
    it('最多32span；超过即回退，不继续寻找无限候选',()=>{
        const holes=Array.from({length:32},(_,i)=>hole(10+30*i,20+30*i));expectFailure(planMangaTextFlow('漢',reference(['漢'],{...box,x1:1000}),holes,metrics),'span-budget');
    });
    it('projection预算同时覆盖逐孔投影与每个候选的清障检查',()=>{
        const h=hole(10,20,1000,1010),ref=reference(['漢'.repeat(17)],{...box,x1:1000});
        const a=expectFailure(planMangaTextFlow('漢',reference(['漢']),Array(65537).fill(h),metrics),'projection-budget');expect(a.cost.projectionChecks).toBe(65537);
        const b=expectFailure(planMangaTextFlow('漢'.repeat(17),ref,Array(4096).fill(h),metrics),'projection-budget');expect(b.cost.projectionChecks).toBe(65537);
    });
    it('metric次数和被测UTF16预算分别限制长前缀搜索',()=>{
        const holes=Array.from({length:31},(_,i)=>hole(10+30*i,20+30*i)),large=(s:string)=>({...metrics(s),width:10000,actualBoundingBoxRight:10000});
        const a=expectFailure(planMangaTextFlow('漢'.repeat(33),reference(['漢'.repeat(33)],{...box,x1:1000}),holes,large),'metric-budget');expect(a.cost.metricCalls).toBe(1025);
        const b=expectFailure(planMangaTextFlow('A'.repeat(4096),reference(['A'.repeat(4096)],{...box,x1:1000}),holes,large),'metric-budget');expect(b.cost.metricCalls).toBeLessThan(1024);expect(b.cost.measuredUtf16).toBeGreaterThan(65536);
    });
    it.each(['metric-budget','projection-budget','missing-glyph-metrics'])('同消息真实measure异常仍原样抛，不能冒充内部回退：%s',message=>{
        const error=new Error(message);expect(()=>planMangaTextFlow('你好',reference(),[],()=>{throw error;})).toThrow(error);
        try{planMangaTextFlow('你好',reference(),[],()=>{throw error;});}catch(actual){expect(actual).toBe(error);}
    });
    it('公开预算不可被调用方改变，每次cost均独立',()=>{
        expect(Object.isFrozen(MANGA_TEXT_FLOW_LIMITS)).toBe(true);const a=planMangaTextFlow('你好',reference(),[],metrics),b=planMangaTextFlow('你好',reference(),[],metrics);a.cost.metricCalls=999;expect(b.cost.metricCalls).not.toBe(999);
    });
});
