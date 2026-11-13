import {describe,it,expect} from 'vitest';
import {attachImageRuby} from '@/src/features/image-translation/ruby';
import {groupImageParagraphs,type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {groupMangaText,groupMangaOcrLines} from '@/src/features/image-translation/services/mangaRegions';
import {mangaMaskBoxes} from '@/src/features/image-translation/mangaPatchResult';

const line=(text:string,x0:number,y0:number,x1:number,y1:number,vertical=false):ImageTextRegion=>({text,bbox:{x0,y0,x1,y1},...(vertical?{vertical:true as const}:{})});
const main=()=>line('風の音を聞いて',100,20,140,300,true);
const ruby=()=>line('かぜ',145,22,165,62,true);

describe('正文与日文注音的唯一几何归属',()=>{
    it('注音归入正文后仍使用自己的擦除余量，不借用正文字号扩大清字范围',()=>{
        const a={...main(),fontSize:40},b={...ruby(),fontSize:20};
        const before=[...mangaMaskBoxes(a,300,400),...mangaMaskBoxes(b,300,400)];
        const [joined]=attachImageRuby([a,b]).lines;
        expect(mangaMaskBoxes(joined,300,400)).toEqual(before);
    });
    it('原样保留识别注音及两个擦除框，字号来自正文而非扩大的占用框',()=>{
        const a=main(),b=ruby(),input=[b,a],before=structuredClone(input);
        Object.freeze(a.bbox);Object.freeze(b.bbox);Object.freeze(a);Object.freeze(b);Object.freeze(input);
        const result=attachImageRuby(input),[region]=result.lines;
        expect(region).toEqual({text:a.text,vertical:true,fontSize:40,bbox:{x0:100,y0:20,x1:165,y1:300},
            sourceBoxes:[a.bbox,b.bbox],ruby:[{text:b.text,bbox:b.bbox,fontSize:20}]});
        expect(result.physical.has(region)).toBe(true);expect(input).toEqual(before);
        expect(attachImageRuby(result.lines).lines).toBe(result.lines);
    });
    it('横排注音在上方，两个读音都附着同一物理行；已有字号与对齐仍保留',()=>{
        const a={...line('東京から京都へ',20,100,300,140),fontSize:38,textAlign:'center' as const};
        const b=line('とうきょう',20,78,94,96),c=line('きょうと',170,78,230,96);
        const [result]=attachImageRuby([a,b,c]).lines;
        expect(result.text).toBe(a.text);expect(result.fontSize).toBe(38);expect(result.textAlign).toBe('center');
        expect(result.ruby?.map(r=>r.text)).toEqual([b.text,c.text]);expect(result.sourceBoxes).toEqual([a.bbox,b.bbox,c.bbox]);
    });
    it('保留原始空格与半角假名，规范化仅用于分类',()=>{
        const a=main(),b={...ruby(),text:'ｶﾞ ｾﾞ'};
        expect(attachImageRuby([a,b]).lines[0].ruby?.[0].text).toBe(b.text);
    });
    it.each([undefined,NaN,0,-1])('注音没有有效字号 %s 时按原框厚度记录，保留有效的独立字号',fontSize=>{
        expect(attachImageRuby([main(),{...ruby(),fontSize}]).lines[0].ruby?.[0].fontSize).toBe(20);
        expect(attachImageRuby([main(),{...ruby(),fontSize:18}]).lines[0].ruby?.[0].fontSize).toBe(18);
    });
    it('单一源框仍是物理行，已有多框段落不可重新归属',()=>{
        const a=main(),b=ruby();a.sourceBoxes=[{...a.bbox}];b.sourceBoxes=[{...b.bbox}];
        expect(attachImageRuby([a,b]).lines).toHaveLength(1);
        for(const sourceBoxes of [[],[a.bbox,a.bbox],[{...a.bbox,x0:101}],
            [{...a.bbox,y0:21}],[{...a.bbox,x1:141}],[{...a.bbox,y1:301}]]){
            const input=[{...a,sourceBoxes},b];expect(attachImageRuby(input).lines).toBe(input);
        }
    });
    it.each([
        ['same size',line('かぜ',145,22,185,102,true)],
        ['tiny mark',line('かぜ',145,22,150,42,true)],
        ['too far',line('かぜ',161,22,181,62,true)],
        ['wrong side',line('かぜ',75,22,95,62,true)],
        ['overlapping body',line('かぜ',135,22,155,62,true)],
        ['starts above',line('かぜ',145,9,165,49,true)],
        ['ends below',line('かぜ',145,290,165,330,true)],
        ['wrong orientation',line('かぜ',145,22,165,30)],
        ['sentence punctuation',{...ruby(),text:'かぜ。'}],
        ['Latin note',{...ruby(),text:'Wind'}],
        ['number',{...ruby(),text:'123'}],
        ['too many kana',{...ruby(),text:'あいうえおかきくけ'}],
        ['guard',{...ruby(),guardOnly:true}],
        ['invalid x',{...ruby(),bbox:{...ruby().bbox,x0:NaN}}],
        ['zero height',{...ruby(),bbox:{...ruby().bbox,y1:22}}],
        ['zero width',{...ruby(),bbox:{...ruby().bbox,x1:145}}],
    ])('保留独立或不可信小字：%s',(_name,b)=>{
        const input=[main(),b as ImageTextRegion];expect(attachImageRuby(input).lines).toBe(input);
    });
    it('纯假名正文和拉丁标题不获得汉字注音规则',()=>{
        for(const text of ['かなだけ','TITLE','2026年11月11日']){
            const input=[{...main(),text},ruby()];expect(attachImageRuby(input).lines).toBe(input);
        }
    });
    it('两个正文都吻合时拒绝猜测，不按数组顺序选最近的一个',()=>{
        const a=main(),b={...main(),text:'花の音',bbox:{...main().bbox,y0:25}},r=ruby();
        for(const input of [[a,b,r],[b,r,a]])expect(attachImageRuby(input).lines).toBe(input);
    });
    it('桥接区内数字、标记和其他文字阻止附着，远处标签不影响正文',()=>{
        for(const block of [line('12',142,30,144,40),line('か',153,40,158,50),{...line('',142,30,144,40),guardOnly:true as const}]){
            const input=[main(),ruby(),block];expect(attachImageRuby(input).lines).toBe(input);
        }
        const label=line('LABEL',142,200,160,220),[result,kept]=attachImageRuby([main(),ruby(),label]).lines;
        expect(result.ruby).toHaveLength(1);expect(kept).toBe(label);
    });
    it('较小汉字不自动成为注音；整页预算不足时全部保持原状',()=>{
        const input=[main(),{...ruby(),text:'小字'}];expect(attachImageRuby(input).lines).toBe(input);
        const large=Array.from({length:1001},()=>ruby());large.push(main());
        expect(attachImageRuby(large).lines).toBe(large);
    });
    it('紧贴墨迹允许很小的检测框重叠，原擦除框不裁切',()=>{
        const a=main(),b=line('かぜ',138,22,158,62,true),[region]=attachImageRuby([a,b]).lines;
        expect(region.sourceBoxes).toEqual([a.bbox,b.bbox]);
    });
});

describe('真实彩色图 OCR 坐标的注音与正文合段',()=>{
    // phase5/color-final-image/report.json，非人工调整的检测框；原图与旧评分不改动。
    const actual=()=>[
        line('かぜ',886,147,912,211.33333333333331,true),
        line('風の音を聞いて',830,149,880,452,true),
        line('小道で待っている',717,150,768,500,true),
        line('こみち',775,150,802,217,true),
        line('沿着花园的小路慢慢走。',102,1017,498,1049),
    ];
    it('普通模式正文按右到左合并，注音不再遮挡列间距，四个物理框完整保留',()=>{
        const input=actual(),result=groupImageParagraphs(input),body=result.find(r=>r.vertical)!;
        expect(result).toHaveLength(2);expect(body.text).toBe('風の音を聞いて小道で待っている');
        expect(body.fontSize).toBe(51);expect(body.bbox).toEqual({x0:717,y0:147,x1:912,y1:500});
        expect(body.sourceBoxes).toEqual([input[1].bbox,input[0].bbox,input[2].bbox,input[3].bbox]);
        expect(body.ruby?.map(r=>r.text)).toEqual(['かぜ','こみち']);
        expect(body.ruby?.map(r=>r.bbox)).toEqual([input[0].bbox,input[3].bbox]);
    });
    it('只有一列时保留附着，其他已有段落不再参与合并',()=>{
        const [r,a]=actual(),other=line('OTHER',10,500,90,520);other.sourceBoxes=[other.bbox];
        const result=groupImageParagraphs([r,a,other]);expect(result).toHaveLength(2);expect(result[0].ruby).toHaveLength(1);
    });
    it('横排在正文上方留出注音后仍按正文字号合段，擦除仅使用物理框',()=>{
        const a=line('東京へ向かいます',20,100,280,140),r=line('とうきょう',20,79,100,97),b=line('列車が出発します',20,160,280,200);
        const [result]=groupImageParagraphs([r,a,b]);expect(result.text).toBe(a.text+b.text);
        expect(result.sourceBoxes).toEqual([a.bbox,r.bbox,b.bbox]);expect(result.ruby).toHaveLength(1);
    });
    it.each([false,true])('漫画Paddle保护数字=%s保留注音原文，但翻译只读正文',protectNumeric=>{
        const input=actual(),items=input.map(({text,bbox:b})=>({text,confidence:.99,box:{x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0}}));
        const result=groupMangaText(items,'auto',1100,1500,'page',protectNumeric);
        const body=result.find(r=>r.vertical)!;expect(body.text).toBe('風の音を聞いて小道で待っている');
        expect(body.ruby).toHaveLength(2);expect(body.sourceBoxes).toHaveLength(4);expect(result).toHaveLength(2);
    });
    it('Tesseract漫画走同一规则，不额外加载模型',()=>{
        const result=groupMangaOcrLines(actual(),'ja',1100,1500);
        expect(result.find(r=>r.vertical)?.ruby).toHaveLength(2);expect(result).toHaveLength(2);
    });
    it('漫画只有首列带注音时仍保留另一列正文与各自物理范围',()=>{
        const input=actual().filter(line=>line.text!=='こみち');
        const items=input.map(({text,bbox:b})=>({text,confidence:.99,box:{x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0}}));
        const result=groupMangaText(items,'ja',1100,1500),body=result.find(r=>r.vertical)!;
        expect(body.text).toBe('風の音を聞いて小道で待っている');
        expect(body.ruby?.map(r=>r.text)).toEqual(['かぜ']);expect(body.sourceBoxes).toHaveLength(3);
    });
});
