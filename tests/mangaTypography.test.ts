import {describe,expect,it,vi} from 'vitest';
import {createMangaTranslationSearch,layoutMangaTranslationText,MANGA_TEXT_FONT} from '@/src/features/image-translation/services/mangaTypography';
import {drawMangaTranslations,sampleMangaBackgrounds} from '@/src/features/image-translation/services/mangaRendering';
import type {MangaAlphaProtection} from '@/src/features/image-translation/services/mangaAlphaProtection';
const measure = (text: string,size: number) => Array.from(text).length * size;
function context() {return {save:vi.fn(),restore:vi.fn(),fillRect:vi.fn(),font:'',fillStyle:'',strokeStyle:'',lineWidth:0,
    beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),measureText:vi.fn(function(this:{font:string},text:string){return {width:measure(text,Number(this.font.match(/ ([\d.]+)px/)![1]))};}),strokeText:vi.fn(),fillText:vi.fn()};}
function inkContext(){const c=context();c.measureText.mockImplementation(function(this:{font:string},text:string){
    const size=Number(this.font.match(/ ([\d.]+)px/)![1]);return {width:measure(text,size),actualBoundingBoxAscent:size*.7,actualBoundingBoxDescent:size*.2};
});return c;}
function protection(rectangles:MangaAlphaProtection['rectangles']):MangaAlphaProtection{return {rectangles,runs:new Uint16Array(),rowStarts:new Uint32Array()};}

describe('透明图案与完整译文共同排版',()=>{
    const width=320,height=160,pixels=new Uint8ClampedArray(width*height*4).fill(255);
    const region={text:'完整保留每个字',fontSize:20,bbox:{x0:20,y0:20,x1:300,y1:140}};
    it('任何清字前只构建一次全局减孔clip，选择孔侧完整高度并保留全部文字',()=>{
        const c=inkContext(),hole={x0:100,y0:40,x1:110,y1:70};
        drawMangaTranslations(c as any,pixels,width,height,[{...region,sourceBoxes:[region.bbox]}],true,[{uniform:true,color:'#fff'}],protection([hole]));
        expect(c.clip.mock.calls.filter(args=>args[0]==='evenodd')).toHaveLength(1);
        expect(c.clip.mock.invocationCallOrder[0]).toBeLessThan(c.fillRect.mock.invocationCallOrder[0]);
        expect(c.rect.mock.calls[0]).toEqual([0,0,width,height]);
        const [x,y,w,h]=c.rect.mock.calls.at(-1)!;
        expect(w>0&&h>0).toBe(true);expect(x+w<=hole.x0||x>=hole.x1||y+h<=hole.y0||y>=hole.y1).toBe(true);
        expect(c.fillText.mock.calls.map(args=>args[0]).join('')).toBe(region.text);
        expect(c.save).toHaveBeenCalledTimes(2);expect(c.restore).toHaveBeenCalledTimes(2);
    });
    it('多个区域共用一次clip，框外孔不改变既有布局，异常仍恢复两层上下文',()=>{
        const p=protection([{x0:1,y0:1,x1:8,y1:8}]),c=inkContext();
        drawMangaTranslations(c as any,pixels,width,height,[region,region],true,undefined,p);
        expect(c.clip.mock.calls.filter(args=>args[0]==='evenodd')).toHaveLength(1);
        expect(c.save).toHaveBeenCalledTimes(3);expect(c.restore).toHaveBeenCalledTimes(3);
        const failed=inkContext();failed.strokeText.mockImplementationOnce(()=>{throw new Error('draw failed');});
        expect(()=>drawMangaTranslations(failed as any,pixels,width,height,[region],true,undefined,p)).toThrow('draw failed');
        expect(failed.restore).toHaveBeenCalledTimes(2);
    });
    it('保护遮满区域或只剩一像素时明确失败，不能把带全文的绘制调用当作可读成功',()=>{
        for(const hole of [region.bbox,{...region.bbox,y0:21}]){
            const c=inkContext();
            expect(()=>drawMangaTranslations(c as any,pixels,width,height,[region],true,undefined,protection([hole]))).toThrow('已保留原图');
            expect(c.fillText).not.toHaveBeenCalled();expect(c.restore).toHaveBeenCalledTimes(2);
        }
    });
    it('整页额外候选超过预算会失败，不无限重复完整长文排版或静默截断',()=>{
        const c=inkContext(),item={text:'完整长译文'.repeat(30),fontSize:20,bbox:{x0:20,y0:20,x1:300,y1:140}};
        const p=protection([{x0:100,y0:40,x1:110,y1:70}]);
        expect(()=>drawMangaTranslations(c as any,pixels,width,height,Array(200).fill(item),true,undefined,p)).toThrow('过于复杂');
        expect(c.restore.mock.calls.length).toBe(c.save.mock.calls.length);
    });
});
describe('漫画专用完整排版',()=>{
    it.each(['你好！！再见……','A（（文字））B','「「对白？！」」\n……旁白！！','）？！开始','结尾（（'])
    ('连续标点场景 %s 保留全文与可用宽度，直接排版与搜索一致',text=>{
        const widthOf=(value:string,size:number)=>Array.from(value).length*size;
        for(const width of [3,6,12]){
            const layout=layoutMangaTranslationText(text,width,100,widthOf,1);
            expect(layout.lines.join('')).toBe(text.replace('\n',''));
            expect(layout.lines.every(line=>widthOf(line,layout.fontSize)<=width)).toBe(true);
            const search=createMangaTranslationSearch(text,widthOf,1);
            expect(search.finish(search.prepare(width,100))).toEqual(layout);
        }
    });
    it.each(['東京𠀀HELLO（文字）','𠀀HELLO(文字)','𠀀HELLO[文字]','𠀀HELLO“文字”',
        '𠀀!HELLO','ｶﾞ?WORLD','𠀀,HELLO','𠀀.HELLO','𠀀)HELLO','𠀀]HELLO','𠀀!?HELLO'])
    ('混排 %s 的标点不落在错误的行首或行尾',text=>{
        const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
        const textMeasure=(value:string,size:number)=>Array.from(segmenter.segment(value)).length*size;
        for(const width of [2,3,4,5,6,7]) {
            const layout=layoutMangaTranslationText(text,width,100,textMeasure,1);
            expect(layout.lines.join('')).toBe(text);
            expect(layout.lines.slice(0,-1).every(line=>!/[（【「『《〈“‘(\[]$/u.test(line))).toBe(true);
            expect(layout.lines.slice(1).every(line=>!/^[，。！？、；：）】」』》〉”’….,!?;)\]]/u.test(line))).toBe(true);
            const search=createMangaTranslationSearch(text,textMeasure,1);
            expect(search.finish(search.prepare(width,100))).toEqual(layout);
        }
    });
    it.each(['𠀀3.14','𠀀example.com','𠀀https://example.com/x','𠀀HELLO-WORLD'])
    ('可容纳时混排完整保留拉丁词 %s',text=>{
        const measure=(value:string,size:number)=>Array.from(value).length*size;
        const word=Array.from(text).slice(1).join('');
        expect(layoutMangaTranslationText(text,word.length,100,measure,1).lines).toEqual(['𠀀',word]);
    });
    it.each(['𠀀HELLO（\u0301文字）','𠀀HELLO（\uFE0F文字）','𠀀HELLO（🏽文字）','𠀀HELLO（\u200d文字）','𠀀HELLO\u0600（文字）'])
    ('含组合标记的开括号 %s 与后文共同换行',text=>{
        const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
        const measure=(value:string,size:number)=>Array.from(segmenter.segment(value)).length*size;
        for(const width of [2,3,4,5,6,7]){
            const layout=layoutMangaTranslationText(text,width,100,measure,1);
            expect(layout.lines.join('')).toBe(text);
            for(const line of layout.lines.slice(0,-1)) {
                const graphemes=Array.from(segmenter.segment(line),item=>item.segment);
                expect(graphemes.at(-1)).not.toMatch(/[（【「『《〈“‘(\[]/u);
            }
        }
    });
    it.each(['𠀀!\u0301HELLO','𠀀\u0600!HELLO','𠀀\u0d4e!HELLO'])
    ('带组合标记或前置字符的闭标点 %s 不在行首',text=>{
        const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
        const measure=(value:string,size:number)=>Array.from(segmenter.segment(value)).length*size;
        for(const width of [2,3,4,5,6,7]){
            const layout=layoutMangaTranslationText(text,width,100,measure,1);
            expect(layout.lines.join('')).toBe(text);
            for(const line of layout.lines.slice(1)){
                const first=segmenter.segment(line)[Symbol.iterator]().next().value?.segment;
                expect(first).not.toMatch(/[，。！？、；：）】」』》〉”’….,!?;:)\]]/u);
            }
        }
    });
    it('开括号后的普通或全角空格被归一化并随下一字换行',()=>{
        const measure=(value:string,size:number)=>Array.from(value).length*size;
        for(const text of ['A（ 文字）','A（　文字）']){
            const layout=layoutMangaTranslationText(text,3,100,measure,1);
            expect(layout.lines.join('')).toBe('A（ 文字）');
            expect(layout.lines.slice(0,-1).every(line=>!/[（【「『《〈“‘(\[]\s*$/u.test(line))).toBe(true);
        }
    });
    it('段首闭括号及段尾开括号在没有相邻文字时仍完整保留',()=>{
        const measure=(value:string,size:number)=>Array.from(value).length*size;
        for(const text of [')HELLO','HELLO（','A（\n文字']){
            const layout=layoutMangaTranslationText(text,3,100,measure,1);
            expect(layout.lines.join('')).toBe(text.replace('\n',''));
        }
    });
    it('扩展东亚文字与英文相邻时保持完整英文词',()=>{
        const graphemeMeasure=(text:string,size:number)=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)).length*size;
        for(const eastAsian of ['𠀀','𠀀\u{E0100}','𛀁','𛄠','ｶﾞ']) {
            const layout=layoutMangaTranslationText(`${eastAsian}HELLO`,5,2.5,graphemeMeasure,1);
            expect(layout.lines).toEqual([eastAsian,'HELLO']);
            const search=createMangaTranslationSearch(`${eastAsian}HELLO`,graphemeMeasure,1);
            expect(search.finish(search.prepare(5,2.5))?.lines).toEqual(layout.lines);
        }
    });
    it.each(['かﾞ','ｶﾞﾞ','漢🏽','㊗️🏽','\u0600𠀀','\u0d4e𠀀','각','👩‍㊗️'])
    ('组合字素 %s 跨词界时不被换行拆散',cluster=>{
        const graphemeMeasure=(text:string,size:number)=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)).length*size;
        const text=`${cluster}HELLO`,layout=layoutMangaTranslationText(text,1,20,graphemeMeasure,1);
        expect(layout.lines[0]).toBe(cluster);expect(layout.lines.join('')).toBe(text);
    });
    it('组合字素邻接文本与显式换行时仍保留完整译文',()=>{
        const graphemeMeasure=(text:string,size:number)=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)).length*size;
        const text='x👩‍㊗️HELLO\n「𠀀HELLO」';
        const layout=layoutMangaTranslationText(text,2,20,graphemeMeasure,1);
        expect(layout.lines.join('')).toBe(text.replace('\n',''));
        expect(layout.lines.filter(line=>line.includes('👩‍㊗️'))).toHaveLength(1);
        expect(layout.lines.every(line=>!line.startsWith('\u200d'))).toBe(true);
    });
    it('前置字符紧邻空格时，空白归一化仍保留前置字符与后文',()=>{
        const text='𠀀\u0600 HELLO';
        expect(layoutMangaTranslationText(text,100,10,measure,1).lines).toEqual([text]);
    });
    it('单行按实际字形上下界适配，行距不再重复挤掉识别框高度',()=>{
        const layout=layoutMangaTranslationText('你好',100,10,measure,10,(_text,size)=>({ascent:size*.7,descent:size*.2}));
        expect(layout).toEqual({lines:['你好'],fontSize:10,lineHeight:12,ink:{height:9,baselines:[7]}});
        expect(layout.lineHeight).toBeGreaterThan(10);
        expect(layoutMangaTranslationText('下划线',100,6,measure,10,()=>({ascent:-2,descent:8})).ink)
            .toEqual({height:6,baselines:[-2]});
    });
    it('真实高字形、显式空段与不同上下行均保留基线间距和完整字形范围',()=>{
        const layout=layoutMangaTranslationText('A\n\nB',100,48,measure,10,text=>text==='A'?{ascent:8,descent:2}:{ascent:12,descent:4});
        expect(layout).toEqual({lines:['A','','B'],fontSize:10,lineHeight:16,ink:{height:44,baselines:[8,24,40]}});
        const text='行\n'.repeat(1999)+'末',many=layoutMangaTranslationText(text,100,24000,measure,10,()=>({ascent:8,descent:2}));
        expect(many.lines).toHaveLength(2000);expect(many.ink?.height).toBe(23998);expect(many.ink?.baselines).toHaveLength(2000);
    });
    it('缺少或非法字形指标时整段保守使用行框，不混用不完整基线',()=>{
        for(const metric of [undefined,{ascent:NaN,descent:1},{ascent:1,descent:Infinity},{ascent:Number.MAX_VALUE,descent:Number.MAX_VALUE},{ascent:-2,descent:2}]){
            const layout=layoutMangaTranslationText('内容',100,12,measure,20,()=>metric);
            expect(layout.ink).toBeUndefined();expect(layout.fontSize).toBeLessThanOrEqual(10);expect(layout.fontSize).toBeGreaterThan(9.9);
        }
        const mixed=layoutMangaTranslationText('好\n坏',100,24,measure,10,text=>text==='好'?{ascent:8,descent:2}:undefined);
        expect(mixed.ink).toBeUndefined();expect(mixed.lines).toEqual(['好','坏']);
    });
    it('中途缺少指标时丢弃此前放大的行距，仍按顺序完成原有字形回调',()=>{
        const calls:string[]=[];
        const layout=layoutMangaTranslationText('A\nB\nC',100,36,measure,10,line=>{
            calls.push(line);return line==='A'?{ascent:100,descent:100}:line==='B'?undefined:{ascent:8,descent:2};
        });
        expect(calls).toEqual(['A','B','C']);expect(layout).toEqual({lines:['A','B','C'],fontSize:10,lineHeight:12});
    });
    it('先完成所有字形回调再读取指标，复用或后续修改同一对象时保持既有布局',()=>{
        const shared={ascent:0,descent:0},calls:string[]=[];
        const layout=layoutMangaTranslationText('A\nB',100,24,measure,10,line=>{
            calls.push(line);shared.ascent=line==='A'?100:8;shared.descent=line==='A'?100:2;return shared;
        });
        expect(calls).toEqual(['A','B']);
        expect(layout).toEqual({lines:['A','B'],fontSize:10,lineHeight:12,ink:{height:22,baselines:[8,20]}});
    });
    it('完整译文按真实字形高度缩小，平衡换行也不得增加字形高度越界',()=>{
        const fitted=layoutMangaTranslationText('你好',100,15,measure,30,(_text,size)=>({ascent:size*.8,descent:size*.2}));
        expect(fitted.fontSize).toBeGreaterThan(14.9);expect(fitted.ink!.height).toBeLessThanOrEqual(15);expect(fitted.lines.join('')).toBe('你好');
        const balanced=layoutMangaTranslationText('abcdefgh',70,14,measure,10,text=>text.length>1&&text.length<7?{ascent:12,descent:12}:{ascent:1,descent:1});
        expect(balanced.lines).toEqual(['abcdefg','h']);expect(balanced.ink!.height).toBe(14);
    });
    it('闭标点不会独自挤到下一行，开标点跟随下一字',()=>{
        const layout=layoutMangaTranslationText('你好。再见！「好的」',30,150,measure,10);
        expect(layout.lines.join('')).toBe('你好。再见！「好的」');
        expect(layout.lines.every(line=>!/^([。！？」])/u.test(line))).toBe(true);
        expect(layout.lines).toEqual(['你好。','再见！','「好','的」']);
        expect(layoutMangaTranslationText('你好.再见',20,100,measure,10).lines).toEqual(['你','好.','再见']);
    });
    it('末行很短时平衡气泡行宽，字号和行数保持不变',()=>{
        expect(layoutMangaTranslationText('我早就确认过了。',70,50,measure,10))
            .toEqual({lines:['我早就确','认过了。'],fontSize:10,lineHeight:12});
        expect(layoutMangaTranslationText('x Hello',60,100,measure,10).lines).toEqual(['x','Hello']);
        expect(layoutMangaTranslationText('你好\n再见',20,40,measure,10).lines).toEqual(['你好','再见']);
    });
    it('缺少字素分段器时仍按 Unicode 码点保留长词',async()=>{
        vi.resetModules();
        vi.stubGlobal('Intl',new Proxy(Intl,{get:(target,key)=>key==='Segmenter'?undefined:Reflect.get(target,key)}));
        try {const {layoutMangaTranslationText: fallback,createMangaTranslationSearch: fallbackSearch}=await import('@/src/features/image-translation/services/mangaTypography');
            expect(fallback('abc😊def',20,100,measure,10).lines.join('')).toBe('abc😊def');
            // 精确对照主线：缺少分段器时继续沿用原来的分词、标点绑定与码点回退。
            for(const [text,width,height,expected] of [
                ['𠀀HELLO',5,2.5,['𠀀HE','LLO']], ['𠀀!HELLO',5,100,['𠀀!HE','LLO']],
                ['𠀀HELLO（文字）',7,100,['𠀀HELL','O（文字）']], ['𠀀！？HELLO',6,100,['𠀀！？H','ELLO']],
                ['𠀀!école',6,100,['𠀀!éc','ole']], ['𠀀HELLOé（文字）',8,100,['𠀀HELLO','é（文字）']],
                ['𠀀!\u0301HELLO',3,100,['𠀀!\u0301','HEL','LO']], ['𠀀\u0600!HELLO',5,100,['𠀀\u0600!HE','LLO']],
                ['A\n\nB',10,100,['A','','B']],
            ] as const){
                const layout=fallback(text,width,height,measure,1);
                expect(layout.lines).toEqual(expected);
                const search=fallbackSearch(text,measure,1);
                expect(search.finish(search.prepare(width,height))).toEqual(layout);
            }}
        finally {vi.unstubAllGlobals();vi.resetModules();}
    });
    it('英文单词、混排空格、长单词和显式空行均保留',()=>{
        const layout=layoutMangaTranslationText('Hello world\r\n\r中文 OK',60,160,measure,10);
        expect(layout.lines).toEqual(['Hello','world','','中文 OK']);
        expect(layoutMangaTranslationText('Supercalifragilistic',40,160,measure,10).lines.join('')).toBe('Supercalifragilistic');
    });
    it('适配超长译文与极窄区域，不截字或压扁，保留开标点结尾',()=>{
        const text='非常完整的长译文。'.repeat(100),layout=layoutMangaTranslationText(text,80,80,measure,30);
        expect(layout.lines.join('')).toBe(text);expect(layout.lines.length*layout.lineHeight).toBeLessThanOrEqual(80);
        expect(layout.lines.every(line=>measure(line,layout.fontSize)<=80)).toBe(true);
        expect(layoutMangaTranslationText('「',5,5,measure,20).lines.join('')).toBe('「');
        expect(layoutMangaTranslationText('（「你好」）',20,80,measure,10).lines.join('')).toBe('（「你好」）');
    });
    it('组合音标和 emoji 的字素在必须拆长词时仍完整',()=>{
        const text='e\u0301👨‍👩‍👧‍👦e\u0301👨‍👩‍👧‍👦';
        const layout=layoutMangaTranslationText(text,12,180,(text,size)=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)).length*size,10);
        expect(layout.lines).toEqual(['e\u0301','👨‍👩‍👧‍👦','e\u0301','👨‍👩‍👧‍👦']);
    });
    it('空段、首标点及无效预算不会丢内容或产生无效字形',()=>{
        expect(layoutMangaTranslationText('。你好',100,100,measure,10).lines.join('')).toBe('。你好');
        for(const args of [['',10,10,10],['x',0,10,10],['x',10,NaN,10],['x',10,10,Infinity]] as const)
            expect(layoutMangaTranslationText(args[0],args[1],args[2],measure,args[3])).toEqual({lines:[],fontSize:0,lineHeight:0});
    });
});
describe('原图背景与字体层次',()=>{
    const width=1000,height=400,pixels=new Uint8ClampedArray(width*height*4).fill(255);
    const region={text:'你好世界',fontSize:70,bbox:{x0:100,y0:100,x1:400,y1:250}};
    it.each([128,180,254,255])('沿用原图 alpha=%i 的分类，修补后半透明边缘不再追加不透明 fillRect',alpha=>{
        const w=64,h=48,source=new Uint8ClampedArray(w*h*4).fill(255);
        for(let offset=3;offset<source.length;offset+=4)source[offset]=alpha;
        const item={text:'译文',fontSize:8,bbox:{x0:16,y0:12,x1:48,y1:36}},backgrounds=sampleMangaBackgrounds(source,w,h,[item]),c=context();
        expect(backgrounds).toEqual([{color:'rgb(255,255,255)',uniform:alpha===255}]);
        drawMangaTranslations(c as any,source,w,h,[item],true,backgrounds);
        expect(c.fillRect).toHaveBeenCalledTimes(alpha===255?1:0);
        expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('译文');
        if(alpha===255){
            const previous=context();
            drawMangaTranslations(previous as any,source,w,h,[item],true,[{color:'rgb(255,255,255)',uniform:true}]);
            expect(c.fillRect.mock.calls).toEqual(previous.fillRect.mock.calls);
            expect(c.strokeText.mock.calls).toEqual(previous.strokeText.mock.calls);
            expect(c.fillText.mock.calls).toEqual(previous.fillText.mock.calls);
            expect(c.font).toBe(previous.font);expect(c.lineWidth).toBe(previous.lineWidth);
        }else expect(c.strokeStyle).toBe('#ffffff');
    });
    it('紧贴字形的单行使用真实上下界及描边居中，不扩大清字和裁剪范围',()=>{
        for(const height of [7,8,13.333333,16]){
            const c=Object.assign(context(),{textBaseline:''}),bbox={x0:40,y0:40,x1:276,y1:40+height};
            c.measureText.mockImplementation(function(this:{font:string},text:string){const size=Number(this.font.match(/ ([\d.]+)px/)![1]);return {width:measure(text,size),actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.15,fontBoundingBoxAscent:size,fontBoundingBoxDescent:size*.3};});
            drawMangaTranslations(c as any,pixels,width,400,[{text:'完整译文',fontSize:height,bbox}],true,[{color:'rgb(255,255,255)',uniform:true}]);
            const size=Number(c.font.match(/ ([\d.]+)px/)![1]),y=c.fillText.mock.calls[0][2],padding=c.lineWidth/2+.5;
            expect(size).toBeGreaterThan(height*.8);expect(size).toBeLessThanOrEqual(height*1.05);
            expect(y-size*.8-padding).toBeGreaterThanOrEqual(bbox.y0-1e-9);expect(y+size*.15+padding).toBeLessThanOrEqual(bbox.y1+1e-9);
            expect(c.textBaseline).toBe('alphabetic');expect(c.rect).toHaveBeenCalledWith(40,40,236,bbox.y1-bbox.y0);
            expect(c.fillRect).toHaveBeenCalledWith(40,40,236,bbox.y1-bbox.y0);expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('完整译文');
        }
    });
    it('混合表情和下伸字形按实际整行上下界适配，缺少真实指标时退回完整行距',()=>{
        for(const actualBounds of [true,false]){
            const c=Object.assign(context(),{textBaseline:''});
            c.measureText.mockImplementation(function(this:{font:string},text:string){const size=Number(this.font.match(/ ([\d.]+)px/)![1]);return {width:measure(text,size),fontBoundingBoxAscent:size*.6,fontBoundingBoxDescent:size*.1,...(actualBounds?{actualBoundingBoxAscent:size,actualBoundingBoxDescent:size*.3}:{})};});
            drawMangaTranslations(c as any,pixels,width,height,[{text:'Go! 😊',fontSize:20,bbox:{x0:40,y0:40,x1:276,y1:60}}],true,[{color:'rgb(255,255,255)',uniform:true}]);
            const size=Number(c.font.match(/ ([\d.]+)px/)![1]);
            expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('Go! 😊');
            if(actualBounds){expect(c.textBaseline).toBe('alphabetic');expect(size*1.3+c.lineWidth+1).toBeLessThanOrEqual(20+1e-9);}
            else {expect(c.textBaseline).toBe('middle');expect(size*1.2).toBeLessThanOrEqual(20);}
        }
    });
    it('零字形或非有限 Canvas 指标退回行框，复杂底色和竖框仍保留完整内容及原界',()=>{
        for(const invalid of [{actualBoundingBoxAscent:0,actualBoundingBoxDescent:0},{actualBoundingBoxAscent:NaN,actualBoundingBoxDescent:2}]){
            const c=Object.assign(context(),{textBaseline:''});c.measureText.mockImplementation(function(this:{font:string},text:string){return {width:measure(text,Number(this.font.match(/ ([\d.]+)px/)![1])),...invalid};});
            const bbox={x0:100,y0:10,x1:118,y1:390},text='明日は駅で会いましょう。';
            drawMangaTranslations(c as any,pixels,width,height,[{text,fontSize:18,bbox,vertical:true}],true,[{color:'#444',uniform:false}]);
            expect(c.textBaseline).toBe('middle');expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe(text);
            expect(c.fillRect).not.toHaveBeenCalled();expect(c.rect).toHaveBeenCalledWith(100,10,18,380);
        }
    });
    it('无效画布或框外区域不读取字形，合法部分继续保持原画布裁剪边界',()=>{
        const c=context();
        for(const [w,h,data] of [[0,height,pixels],[width,.5,pixels],[width,height,new Uint8ClampedArray(1)]] as const)
            drawMangaTranslations(c as any,data,w,h,[region]);
        drawMangaTranslations(c as any,pixels,width,height,[{...region,bbox:{x0:width+1,y0:1,x1:width+20,y1:30}},{...region,bbox:{x0:1,y0:height+1,x1:20,y1:height+30}}]);
        expect(c.save).not.toHaveBeenCalled();expect(c.measureText).not.toHaveBeenCalled();
        drawMangaTranslations(c as any,pixels,width,height,[{...region,bbox:{x0:-10,y0:-10,x1:100,y1:60}}],true,[{uniform:true,color:'#fff'}]);
        expect(c.rect).toHaveBeenCalledWith(0,0,100,60);expect(c.restore).toHaveBeenCalledOnce();
    });
    it('均匀气泡按源行和描边余量清字，段落空隙保留原图而不整块铺白', () => {
        const c=context(), boxes=[{x0:100,y0:100,x1:220,y1:120},{x0:100,y0:160,x1:220,y1:180}];
        drawMangaTranslations(c as any,pixels,width,height,[{text:'完整译文',fontSize:20,bbox:{x0:100,y0:100,x1:220,y1:180},sourceBoxes:boxes}],true,[{color:'rgb(255,255,255)',uniform:true}]);
        expect(c.fillRect.mock.calls).toEqual([[96,96,128,28],[96,156,128,28]]);
        expect(c.fillRect).not.toHaveBeenCalledWith(100,100,120,80);
        expect(c.rect).toHaveBeenCalledWith(100,100,120,80);
        expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('完整译文');
    });
    it('七八像素高的短行不会被固定内边距挤成三像素，仍裁剪在原始识别范围',()=>{
        for(const height of [7,8]){
            const c=context(),bbox={x0:40,y0:40,x1:132,y1:40+height};
            drawMangaTranslations(c as any,pixels,width,400,[{text:'已准备好。',fontSize:height,bbox}],true,[{color:'rgb(255,255,255)',uniform:true}]);
            const size=Number(c.font.match(/ ([\d.]+)px/)![1]);
            expect(size).toBeGreaterThan(height*.65);expect(size*1.2).toBeLessThanOrEqual(height);
            expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe('已准备好。');
            expect(c.rect).toHaveBeenCalledWith(40,40,92,height);expect(c.fillRect).toHaveBeenCalledWith(40,40,92,height);
        }
    });
    it('对白适度粗体且短译文不放大，标题使用源字号与白色描边',()=>{
        const c=context();drawMangaTranslations(c as any,pixels,width,height,[region],true,[{color:'rgb(255,255,255)',uniform:true}]);
        expect(c.font).toMatch(/^600 34px /);expect(c.fillStyle).toBe('#111111');expect(c.lineWidth).toBeCloseTo(1.19);
        drawMangaTranslations(c as any,pixels,width,height,[region],true,[{color:'rgb(100,100,100)',uniform:false}]);
        expect(c.font).toMatch(/^800 /);expect(c.strokeStyle).toBe('#ffffff');expect(c.lineWidth).toBeGreaterThan(5);
        drawMangaTranslations(c as any,pixels,width,height,[{...region,vertical:true}],true,[{color:'rgb(100,100,100)',uniform:false}]);
        expect(c.font).toMatch(/^600 /);
    });
    it('修补后像素均匀也沿用原图复杂背景分类，禁止重新铺白底',()=>{
        const c=context();drawMangaTranslations(c as any,pixels,width,height,[region],true,[{color:'rgb(170,140,100)',uniform:false}]);
        expect(c.fillRect).not.toHaveBeenCalled();
        drawMangaTranslations(c as any,pixels,width,height,[region],false,[{color:'rgb(170,140,100)',uniform:false}]);expect(c.fillRect).toHaveBeenCalledOnce();
        expect(sampleMangaBackgrounds(pixels,width,height,[region])).toEqual([{color:'rgb(255,255,255)',uniform:true}]);
    });
    it('黑底保留白字，空译文不绘字，异常 Canvas 仍恢复状态',()=>{
        const c=context();drawMangaTranslations(c as any,pixels,width,height,[region],true,[{color:'rgb(0,0,0)',uniform:true}]);expect(c.fillStyle).toBe('#ffffff');
        const empty=context();drawMangaTranslations(empty as any,pixels,width,height,[{...region,text:''}]);expect(empty.fillText).not.toHaveBeenCalled();expect(empty.restore).toHaveBeenCalledOnce();
        c.measureText.mockImplementationOnce(()=>{throw new Error('canvas failed');});
        expect(()=>drawMangaTranslations(c as any,pixels,width,height,[region])).toThrow('canvas failed');expect(c.restore).toHaveBeenCalledTimes(2);
    });
    it('相同字体和字号的度量仅在本次绘制内复用',()=>{
        const c=context();drawMangaTranslations(c as any,pixels,width,height,[region,region]);
        const count=c.measureText.mock.calls.length;expect(c.fillText).toHaveBeenCalledTimes(2);
        drawMangaTranslations(c as any,pixels,width,height,[region]);expect(c.measureText.mock.calls.length).toBe(count*2);
    });
    it('短键仍区分字重字号及全文，不把不同背景的描边度量混入缓存',()=>{
        const items=[{text:'Aa|界',fontSize:20,bbox:{x0:30,y0:30,x1:230,y1:54}},
            {text:'Aa|界',fontSize:70,bbox:{x0:30,y0:30,x1:330,y1:130}},
            {text:'Aa|界',fontSize:20,bbox:{x0:30,y0:30,x1:230,y1:54}}];
        const backgrounds=[{uniform:true,color:'#fff'},{uniform:false,color:'#777'},{uniform:false,color:'#777'}];
        const make=()=>{const c=Object.assign(context(),{textBaseline:''});
            c.measureText.mockImplementation(function(this:{font:string},text:string){const size=Number(this.font.match(/ ([\d.]+)px/)![1]);return {width:measure(text,size)*(this.font.startsWith('800')?1.2:1),actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};});return c;};
        const shared=make();drawMangaTranslations(shared as any,pixels,width,height,items,true,backgrounds);
        expect(shared.fillText.mock.calls).toEqual(items.flatMap((item,index)=>{
            const separate=make();drawMangaTranslations(separate as any,pixels,width,height,[item],true,[backgrounds[index]]);return separate.fillText.mock.calls;
        }));
    });
    it('短键节约字符串也仍按原完整字体键计费，缓存容量不因缩键扩大',()=>{
        const caches:Array<Map<string,{width:number;ascent:number;descent:number}>>=[];
        class ObservedMap extends Map<string,any>{override set(key:string,value:any){
            if(value&&typeof value==='object'&&'width'in value&&'ascent'in value&&'descent'in value&&!caches.includes(this))caches.push(this);
            return super.set(key,value);
        }}
        const c=context(),text=Array.from({length:160},(_,index)=>`段${index}完整译文。`).join('');
        vi.stubGlobal('Map',ObservedMap);
        try{drawMangaTranslations(c as any,pixels,width,height,[{...region,text}]);}finally{vi.unstubAllGlobals();}
        expect(caches).toHaveLength(1);const cache=caches[0];let logicalCharacters=0,storedCharacters=0;
        for(const key of cache.keys()){
            const match=/^(600|800)\|([^|]+)\|/u.exec(key)!;
            logicalCharacters+=`${match[1]} ${match[2]}px ${MANGA_TEXT_FONT}|${key.slice(match[0].length)}`.length;storedCharacters+=key.length;
        }
        expect(logicalCharacters).toBeGreaterThan(130000);expect(logicalCharacters).toBeLessThanOrEqual(131072);
        expect(cache.size).toBeLessThanOrEqual(8192);expect(storedCharacters).toBeLessThan(logicalCharacters/2);
        expect(c.measureText.mock.calls.length).toBeGreaterThan(cache.size);
        expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe(text);
    });
    it('大段译文超出临时度量预算仍完整绘制',()=>{
        const c=context(),text='完整译文。'.repeat(120);
        drawMangaTranslations(c as any,pixels,width,height,[{...region,text}]);
        expect(c.fillText.mock.calls.map(call=>call[0]).join('')).toBe(text);
    });
});
