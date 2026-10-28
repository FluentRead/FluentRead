import {describe, expect, it} from 'vitest';
import {groupImageParagraphs, type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import bambuLines from './fixtures/image-translation/bambu-ocr-lines.json';
import {
    getOcrImageSize,
    getAreaOcrImageSize,
    normalizeOcrLines,
    normalizeOcrLineViews,
    collectRawNumericGuards,
    restoreOcrLineCoordinates,
    selectChangedTranslations,
} from '@/src/features/image-translation/core';
import {getMangaOcrEngine, getRequiredImageOcrLanguages} from '@/src/features/image-translation/ocrLanguages';

describe('普通图片按完整段落翻译', () => {
    const line = (text: string, x0: number, y0: number, width = 200, h = 12): ImageTextRegion =>
        ({text, bbox: {x0, y0, x1: x0 + width, y1: y0 + h}});

    it('Bambu 原图的真实稀疏 OCR：两段三行说明合为整段，标题和底部链接分离', () => {
        const regions = groupImageParagraphs(bambuLines);
        expect(regions).toHaveLength(bambuLines.length - 4);
        expect(regions.filter(region => region.sourceBoxes)).toMatchObject([
            {text: 'Calculate the best filament grouping to minimize filament waste. Need to manually place filaments on the printer based on slicing results.',
                bbox: {x0: 61, y0: 78, x1: 367, y1: 118}, textAlign: 'left', sourceBoxes: [expect.anything(), expect.anything(), expect.anything()]},
            {text: 'Calculate the filament grouping based on the printers filaments, reducing the need for adjusting filaments at the printer.',
                bbox: {x0: 61, y0: 156, x1: 355, y1: 196}, textAlign: 'left'},
        ]);
        expect(regions.some(region => region.text === 'Convenient Mode')).toBe(true);
        expect(regions.some(region => region.text === 'Video tutorial')).toBe(true);
    });

    it.each([
        ["two supplementary Han", "𠀀", "𠀁", "𠀀𠀁"],
        ["BMP then supplementary", "汉", "𠀁", "汉𠀁"],
        ["supplementary then BMP", "𠀀", "字", "𠀀字"],
        ["extended G Han", "𰀀", "𠀁", "𰀀𠀁"],
        ["Latin", "alpha", "beta", "alpha beta"],
        ["emoji", "😀", "😁", "😀 😁"],
        ["closing punctuation", "hello", ")", "hello)"],
        ["opening punctuation", "(", "world", "(world"],
        ["astral then Latin", "𠀀", "word", "𠀀 word"],
        ["Latin then astral", "word", "𠀀", "word 𠀀"],
        ["astral then emoji", "𠀀", "😀", "𠀀 😀"],
        ["emoji then astral", "😀", "𠀀", "😀 𠀀"]
    ])('OCR 续行保留完整码点和两侧 CJK 边界连接策略：%s', (_name, left, right, expected) => {
        expect(groupImageParagraphs([line(left, 0, 0), line(right, 0, 14)])[0].text).toBe(expected);
    });

    it('中文换行不加入空格，英文续行、标点与断词恢复为完整句子', () => {
        expect(groupImageParagraphs([line('这是一个', 0, 0), line('完整段落。', 0, 14)])[0].text).toBe('这是一个完整段落。');
        expect(groupImageParagraphs([line('A filament-', 0, 0), line('saving mode', 0, 14), line(', with words.', 0, 28)])[0].text).toBe('A filament-saving mode, with words.');
        expect(groupImageParagraphs([line('soft\u00ad', 0, 0), line('wrap', 0, 14)])[0].text).toBe('softwrap');
        expect(groupImageParagraphs([line('Mixed 中文', 0, 0), line('and English', 0, 14)])[0].text).toBe('Mixed 中文 and English');
    });

    it('乱序识别恢复阅读顺序，独立两栏不串段且不会修改输入', () => {
        const input = [line('Right second', 250, 14), line('Left first', 0, 0), line('Right first', 250, 0), line('Left second', 0, 14)];
        const before = structuredClone(input);
        expect(groupImageParagraphs(input).map(region => region.text)).toEqual(['Left first Left second', 'Right first Right second']);
        expect(input).toEqual(before);
    });

    it('字号层级、段间留白、同一行控件和新列表项形成边界', () => {
        const inputs = [
            [line('Heading', 0, 0, 150, 20), line('Body', 0, 22)],
            [line('First paragraph.', 0, 0), line('Second paragraph.', 0, 24)],
            [line('Left button', 0, 0, 80), line('Right button', 100, 0, 80)],
            [line('1. First item', 0, 0), line('2. Second item', 0, 14)],
            [line('• First item', 0, 0), line('• Second item', 0, 14)],
        ];
        for (const input of inputs) expect(groupImageParagraphs(input)).toHaveLength(2);
        expect(groupImageParagraphs([line('• A long item', 0, 0), line('continues here.', 2, 14)])).toHaveLength(1);
    });

    it('居中和右对齐段落保留对齐，不靠横向重叠强行合并', () => {
        expect(groupImageParagraphs([line('Centered first', 0, 0, 200), line('Centered last', 50, 14, 100)])[0].textAlign).toBe('center');
        expect(groupImageParagraphs([line('Right first', 0, 0, 200), line('Right last', 100, 14, 100)])[0].textAlign).toBe('right');
        expect(groupImageParagraphs([line('First', 0, 0, 200), line('Different', 40, 14, 140)])).toHaveLength(2);
    });

    it('保留竖排和已经合并的区域，阻止跨遮挡标签合段', () => {
        const vertical = {...line('縦書き', 0, 0), vertical: true as const};
        const grouped = {...line('Existing group', 0, 0), sourceBoxes: [line('', 0, 0).bbox]};
        expect(groupImageParagraphs([vertical, line('body', 0, 14)])).toEqual([vertical, line('body', 0, 14)]);
        expect(groupImageParagraphs([grouped, line('body', 0, 14)])).toHaveLength(2);
        const input = [line('First', 0, 0), line('label', 50, 12, 50, 1), line('Second', 0, 14)];
        expect(groupImageParagraphs(input)).toHaveLength(3);
        expect(groupImageParagraphs([])).toEqual([]);
    });

    it('单图竖排列按右到左合为完整日文，保留逐列擦除框和字形宽度', () => {
        const right = {...line('今日は', 90, 20, 12, 100), vertical: true as const};
        const left = {...line('楽しかった。', 76, 21, 12, 99), vertical: true as const, fontSize: 12};
        const input = [left, right];
        const before = structuredClone(input);
        expect(groupImageParagraphs(input)).toEqual([{
            text: '今日は楽しかった。', bbox: {x0: 76, y0: 20, x1: 102, y1: 120},
            vertical: true, fontSize: 12, sourceBoxes: [right.bbox, left.bbox], textAlign: 'center',
        }]);
        expect(input).toEqual(before);
    });

    it('竖排保留独立气泡、不同字号和横排遮挡边界，预合并区域原样返回', () => {
        const column = (text: string, x: number, y = 20, width = 12) =>
            ({...line(text, x, y, width, 100), vertical: true as const});
        for (const input of [
            [column('右列', 90), column('左列', 60)],
            [column('右列', 90), column('左列', 76, 180)],
            [column('右列', 90), column('小字', 80, 20, 5)],
            [column('右列', 90), line('横排标签', 89, 50, 1, 12), column('左列', 76)],
            [column('右列', 90), {...column('已有段落', 76), sourceBoxes: [column('', 76).bbox]}, column('左列', 62)],
        ]) {
            const output = groupImageParagraphs(input);
            expect(output).toHaveLength(input.length);
            for (const original of input) expect(output).toContain(original);
        }
    });

    it('大图竖排复用遮挡索引，横排标签仍阻止跨列合并且输入不变', () => {
        const column = (text: string, x: number, y = 20) => ({...line(text, x, y, 12, 100), vertical: true as const});
        const right = column('今天', 190), next = column('很开心。', 176);
        const blockedRight = column('右列', 90), blockedLeft = column('左列', 76);
        const label = line('标签', 89, 50, 1);
        const input = [blockedLeft, right, label, next, blockedRight,
            ...Array.from({length: 80}, (_, index) => column(`独立${index}`, 200 + index * 40, 300))];
        const before = structuredClone(input);
        const output = groupImageParagraphs(input);
        expect(output.find(region => region.text === '今天很开心。')?.sourceBoxes).toEqual([right.bbox, next.bbox]);
        expect(output).toContain(blockedRight);expect(output).toContain(blockedLeft);expect(output).toContain(label);
        expect(output).toHaveLength(input.length - 1);expect(input).toEqual(before);
    });

    it('两千条连续正文的遮挡查找不反复读取后续整图横坐标', () => {
        let coordinateReads = 0;
        const input = Array.from({length: 2000}, (_, index) => {
            const region = line(`Sentence ${index}`, 0, index * 14);
            Object.defineProperty(region.bbox, 'x0', {get: () => {coordinateReads++; return 0;}, enumerable: true});
            return region;
        });
        const output = groupImageParagraphs(input);
        expect(output).toHaveLength(1);
        expect(output[0].sourceBoxes).toHaveLength(input.length);
        expect(output[0].text).toBe(input.map(region => region.text).join(' '));
        expect(coordinateReads).toBeLessThan(100_000);
    });

    it('长正文仍受起点以前的高竖排框、末行以后起始的跨栏框以及已使用正文遮挡', () => {
        const body = Array.from({length: 100}, (_, index) => line(`Body ${index}`, 0, 20 + index * 14));
        const early = {...line('vertical label', 90, 0, 20, 2000), vertical: true as const};
        const late = {...line('late overlap', 50, 37, 100, 10), sourceBoxes: []};
        expect(groupImageParagraphs([early, ...body]).every(region => !region.sourceBoxes)).toBe(true);
        const result = groupImageParagraphs([...body, late]);
        expect(result[0]).toBe(body[0]);
        expect(result[1]).toBe(body[1]);
        expect(result.find(region => region.text.startsWith('Body 2 '))?.sourceBoxes).toHaveLength(98);
        expect(result).toContain(late);
        // 已归入前一段的区域仍是另一栏/段的障碍，不能从全局索引永久删除。
        const earlierGroup = [line('First A', 120, 0, 1), line('Second A', 120, 14, 1)];
        const nextGroup = [line('First B', 125, 0, 0.5), line('Second B', 117, 14, 0.5)];
        expect(groupImageParagraphs([...earlierGroup, ...nextGroup, ...body.slice(5)]).slice(0, 3).map(region => region.text))
            .toEqual(['First A Second A', 'First B', 'Second B']);
    });

    it('多栏交错的长正文暂时排除本栏成员后，查询仍能剪掉相邻栏而不改变源框', () => {
        let coordinateReads = 0;
        const input = Array.from({length: 2000}, (_, index) => {
            const x0 = index % 2 * 250;
            const region = line(`Column ${index % 2} row ${Math.floor(index / 2)}`, x0, Math.floor(index / 2) * 14);
            Object.defineProperty(region.bbox, 'x0', {get: () => {coordinateReads++; return x0;}, enumerable: true});
            return region;
        });
        const before = structuredClone(input);
        const output = groupImageParagraphs(input);
        expect(output.map(region => region.sourceBoxes?.length)).toEqual([1000, 1000]);
        expect(output[0].bbox).toEqual({x0: 0, x1: 200, y0: 0, y1: 13998});
        expect(output[1].bbox).toEqual({x0: 250, x1: 450, y0: 0, y1: 13998});
        expect(input).toEqual(before);
        expect(coordinateReads).toBeLessThan(100_000);
    });

    it('大图中的重复对象只加入一次，源框复制与重复值对象的遮挡保持原约定', () => {
        const input = Array.from({length: 100}, (_, index) => line(`Text ${index}`, 0, index * 14));
        const duplicate = input[30];
        const before = structuredClone(input);
        const result = groupImageParagraphs([...input, duplicate, input[0]]);
        expect(result).toHaveLength(1);
        expect(result[0].sourceBoxes).toEqual(input.map(region => region.bbox));
        expect(result[0].sourceBoxes![30]).not.toBe(duplicate.bbox);
        expect(input).toEqual(before);
        const separate = {...duplicate, bbox: {...duplicate.bbox}};
        const obstructed = groupImageParagraphs([...input, separate]);
        expect(obstructed[0].sourceBoxes).toHaveLength(30);
        expect(obstructed).toContain(duplicate);
        expect(obstructed).toContain(separate);
    });

    it('千个分散标签只检查纵向邻域，避免逐标签扫描整图', () => {
        let coordinateReads = 0;
        const input = Array.from({length: 1000}, (_, index) => {
            const region = line(`Label ${index}`, index % 4 * 400, Math.floor(index / 4) * 30);
            const y0 = region.bbox.y0;
            Object.defineProperty(region.bbox, 'y0', {get: () => {coordinateReads++; return y0;}, enumerable: true});
            return region;
        });
        const output = groupImageParagraphs(input);
        expect(output).toEqual(input);
        expect(coordinateReads).toBeLessThan(30_000);
    });
});

describe('多词独立数值恢复',()=>{
    const raw=(text:string,parts:string[],confidence:number|undefined=99,lineConfidence:number|undefined=99)=>{
        let x=0;const words=parts.map(part=>{const bbox={x0:x,y0:0,x1:x+12,y1:10};x+=14;return {text:part,bbox,confidence};});
        return [{paragraphs:[{lines:[{text,bbox:{x0:0,y0:0,x1:x-2,y1:10},confidence:lineConfidence,words}]}]}];
    };
    it.each([['12:30 PM',['12',':','30','PM']],['31/12/2026',['31','/','12','/','2026']],['2026年10月28日',['2026','年','10','月','28','日']],['USD 10',['USD','10']]])('可信完整分词恢复 %s 原行而普通视图仍保留原分词语义',(text,parts)=>{
        const blocks=raw(text,parts),views=normalizeOcrLineViews(blocks);
        expect(views.manga).toMatchObject([{text,numericConfidence:99}]);
        expect(views.ordinary).toEqual(normalizeOcrLines(blocks,false));
        expect(normalizeOcrLines(blocks,true)).toEqual(views.manga);
        const guards=collectRawNumericGuards(blocks,views.manga);expect(guards.every(g=>g.guardOnly&&g.bbox.x0>=0&&g.bbox.x1<=views.manga[0].bbox.x1)).toBe(true);
    });
    it('只从数值证据视图移除能严格关联的低置信残片，保留圈选视图和原始保护框',()=>{
        const blocks=raw('12:30 PM',['12',':','30','PM'],89),views=normalizeOcrLineViews(blocks);
        expect(views.ordinary[0].text).toBe('12: 30 PM');expect(views.manga).toEqual([]);
        expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:blocks[0].paragraphs[0].lines[0].bbox,guardOnly:true});
    });
    it('原行与词不一致时保留相邻正文；非法词框无法安全消除且数值守卫明确报错',()=>{
        const mismatch=raw('12:30 PM',['12',':','30','PM','SALE'],89),views=normalizeOcrLineViews(mismatch);
        expect(views.manga.map(line=>line.text).join(' ')).toContain('SALE');
        const bad=raw('12:30 PM',['12',':','30','PM'],89),word=bad[0].paragraphs[0].lines[0].words[0];word.bbox.x1=word.bbox.x0;
        const parsed=normalizeOcrLineViews(bad);expect(parsed.manga.length).toBeGreaterThan(0);
        expect(()=>collectRawNumericGuards(bad,parsed.manga)).toThrow('保护位置无效');
    });
    it.each(['low','missing','invalid','all-low','all-invalid'] as const)('同框可信和 %s 拆词结果合并时不可升级，顺序不影响',kind=>{
        const high=raw('12:30 PM',['12',':','30','PM'],99)[0].paragraphs[0].lines[0];
        const low=structuredClone(high);low.confidence=kind==='low'?89:99;
        if(kind==='low')for(const word of low.words)word.confidence=89;
        if(kind==='missing')delete (low.words[2] as {confidence?:number}).confidence;
        if(kind==='invalid')low.words[2].confidence=NaN;
        if(kind==='all-low')for(const word of low.words)word.confidence=20;
        if(kind==='all-invalid')for(const word of low.words)word.confidence=NaN;
        for(const lines of [[high,low],[low,high]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.some(line=>line.text==='12:30 PM')).toBe(false);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:high.bbox,guardOnly:true});
        }
    });
    it('已有合行允许的中间间距不会泄漏低置信数值，也不移除不匹配的相邻正文',()=>{
        const blocks=raw('12:30 PM',['12',':','30','PM'],89),line=blocks[0].paragraphs[0].lines[0];
        line.words[3].bbox.x0+=18;line.words[3].bbox.x1+=18;line.bbox.x1+=18;
        const ordinary=normalizeOcrLineViews(blocks).ordinary;expect(ordinary[0].text).toBe('12: 30 PM');
        const parsed=normalizeOcrLineViews(blocks).manga;expect(parsed).toEqual([]);
        expect(collectRawNumericGuards(blocks,parsed)).toContainEqual({text:'',bbox:line.bbox,guardOnly:true});
        line.words.push({text:'SALE',confidence:89,bbox:{x0:line.bbox.x1+1,y0:0,x1:line.bbox.x1+13,y1:10}});line.bbox.x1+=13;
        expect(normalizeOcrLineViews(blocks).manga.map(value=>value.text).join(' ')).toContain('SALE');
    });
    it.each(['12:30 PM','₩12,000'] as const)('同框分词一致而原始数值字符串 %s 不一致时不提升可信结果',text=>{
        const parts=text.startsWith('₩')?['₩','12,000']:['12',':','30','PM'];
        const first=raw(text,parts,99)[0].paragraphs[0].lines[0],second=structuredClone(first);
        second.text=text.startsWith('₩')?'₩ 12,000':'12 :30 PM';
        for(const lines of [[first,second],[second,first]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.every(line=>line.numericConfidence===undefined)).toBe(true);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:first.bbox,guardOnly:true});
        }
    });
    it.each(['far','outside','other-line'] as const)('%s 时不能静默删除不确定的相邻内容',kind=>{
        const blocks=raw('12:30 PM',['12',':','30','PM'],89),line=blocks[0].paragraphs[0].lines[0],last=line.words[3];
        if(kind==='far'){last.bbox.x0=700;last.bbox.x1=712;line.bbox.x1=712;}
        if(kind==='outside'){line.bbox.x1=last.bbox.x0+1;}
        if(kind==='other-line'){last.bbox.y0=50;last.bbox.y1=60;line.bbox.y1=60;}
        const views=normalizeOcrLineViews(blocks);expect(views.manga.map(value=>value.text).join(' ')).toContain('PM');
    });
    it.each(['low','missing','all-low','all-invalid'] as const)('同一原框有词/无词 %s 置信合并不因输入顺序升级',kind=>{
        const low=raw('12:30 PM',['12',':','30','PM'],kind==='low'?89:99)[0].paragraphs[0].lines[0];
        if(kind==='missing')delete (low.words[2] as {confidence?:number}).confidence;
        if(kind==='all-low')for(const word of low.words)word.confidence=20;
        if(kind==='all-invalid')for(const word of low.words)word.confidence=NaN;
        const high={text:low.text,bbox:{...low.bbox},confidence:99,words:[]};
        for(const lines of [[high,low],[low,high]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.every(line=>line.numericConfidence===undefined||line.numericConfidence<90)).toBe(true);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:high.bbox,guardOnly:true});
            expect(views.ordinary).toEqual(normalizeOcrLines(blocks,false));
        }
    });
    it('同一原框出现不同可信数值时均不猜测，保留物理保护',()=>{
        const first=raw('12:30 PM',['12',':','30','PM'],99)[0].paragraphs[0].lines[0];
        const second=structuredClone(first);second.text='12:31 PM';second.words[2].text='31';
        for(const lines of [[first,second],[second,first],[first,second,structuredClone(first)]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.every(line=>line.numericConfidence===undefined)).toBe(true);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:first.bbox,guardOnly:true});
        }
    });
    it('轻微越界扩张整行守卫覆盖全部词；明显越界时保守报错',()=>{
        const blocks=raw('12:30 PM',['12',':','30','PM'],89),line=blocks[0].paragraphs[0].lines[0];
        line.bbox.x1-=1;const parsed=normalizeOcrLineViews(blocks).manga,guards=collectRawNumericGuards(blocks,parsed);
        expect(guards).toContainEqual({text:'',bbox:{...line.bbox,x1:line.bbox.x1+1},guardOnly:true});
        line.bbox.x1-=3;expect(()=>collectRawNumericGuards(blocks,normalizeOcrLineViews(blocks).manga)).toThrow('保护位置无效');
    });
    it.each(['same','different'] as const)('超宽原框中 %s 数值的独立词位置不合并，不可靠防擦报错',kind=>{
        const bbox={x0:0,y0:0,x1:200,y1:10},left={text:'90%',bbox,confidence:99,words:[{text:'90%',bbox:{x0:0,y0:0,x1:20,y1:10},confidence:99}]};
        const value=kind==='same'?'90%':'80%',right={text:value,bbox,confidence:99,words:[{text:value,bbox:{x0:180,y0:0,x1:200,y1:10},confidence:99}]};
        const center={text:'HELLO',bbox:{x0:80,y0:0,x1:120,y1:10},confidence:99};
        for(const lines of [[left,right,center],[right,left,center]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.filter(line=>line.text==='90%'||line.text==='80%')).toHaveLength(2);
            expect(views.manga.some(line=>line.text==='HELLO')).toBe(true);
            expect(()=>collectRawNumericGuards(blocks,views.manga)).toThrow('保护位置无效');
        }
    });
    it('同框有词和无词结果无法对应物理范围时保守失败',()=>{
        const bbox={x0:0,y0:0,x1:40,y1:10},without={text:'90%',bbox,confidence:99,words:[]};
        const withWords={text:'90%',bbox,confidence:89,words:[{text:'90%',bbox:{x0:0,y0:0,x1:20,y1:10},confidence:89}]};
        for(const lines of [[without,withWords],[withWords,without]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(()=>collectRawNumericGuards(blocks,views.manga)).toThrow('保护位置无效');
        }
    });
    it('无词、窄词、整行词的六种顺序一致失败，不漏掉较早的矛盾框',()=>{
        const bbox={x0:0,y0:0,x1:40,y1:10},make=(wordBox:typeof bbox|undefined)=>({text:'90%',bbox,confidence:99,
            words:wordBox?[{text:'90%',bbox:wordBox,confidence:99}]:[]});
        const narrow=make({x0:0,y0:0,x1:10,y1:10}),full=make(bbox),empty=make(undefined);
        const center={text:'HELLO',bbox:{x0:16,y0:20,x1:40,y1:30},confidence:99};
        for(const lines of [[narrow,full,empty],[narrow,empty,full],[full,narrow,empty],[full,empty,narrow],[empty,full,narrow],[empty,narrow,full]]){
            const blocks=[{paragraphs:[{lines:[...lines,center]}]}],views=normalizeOcrLineViews(blocks);
            expect(views.ordinary.some(line=>line.text==='HELLO')).toBe(true);
            expect(()=>collectRawNumericGuards(blocks,views.manga)).toThrow('保护位置无效');
        }
    });
    it('原文两侧空白忽略用于同框身份；内部空白不同不误认同一原值',()=>{
        const bbox={x0:0,y0:0,x1:40,y1:10},plain={text:'90%',bbox,confidence:99,words:[]},
            spaced={text:' 90% ',bbox,confidence:89,words:[{text:'90%',bbox:{x0:0,y0:0,x1:10,y1:10},confidence:89}]};
        for(const lines of [[plain,spaced],[spaced,plain]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(()=>collectRawNumericGuards(blocks,views.manga)).toThrow('保护位置无效');
        }
        const interior={...spaced,text:'90 %',words:[{...spaced.words[0],text:'90 %'}]};
        const blocks=[{paragraphs:[{lines:[plain,interior]}]}];
        expect(()=>collectRawNumericGuards(blocks,normalizeOcrLineViews(blocks).manga)).not.toThrow();
    });
    it('面积恰为 4 倍时允许独立词框，超过时保护失败',()=>{
        const bbox={x0:0,y0:0,x1:40,y1:10},wordBox={x0:0,y0:0,x1:10,y1:10};
        const line={text:'90%',bbox,confidence:99,words:[{text:'90%',bbox:wordBox,confidence:99}]},blocks=[{paragraphs:[{lines:[line]}]}];
        expect(()=>collectRawNumericGuards(blocks,normalizeOcrLineViews(blocks).manga)).not.toThrow();
        wordBox.x1=9.9;expect(()=>collectRawNumericGuards(blocks,normalizeOcrLineViews(blocks).manga)).toThrow('保护位置无效');
    });
    it('同框的原始数字行与分词不一致行不得相互抬高置信度',()=>{
        const high=raw('12:30 PM',['12',':','30','PM'],99)[0].paragraphs[0].lines[0];
        const other={text:'NOT THAT',bbox:{...high.bbox},confidence:99,words:[{text:'12:30 PM',bbox:{...high.bbox},confidence:99}]};
        for(const lines of [[high,other],[other,high]]){
            const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
            expect(views.manga.every(line=>line.numericConfidence===undefined)).toBe(true);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:high.bbox,guardOnly:true});
        }
    });
    it('部分重叠但不满足去重阈值时保留低置信独立物理框',()=>{
        const high=raw('12:30 PM',['12',':','30','PM'],99)[0].paragraphs[0].lines[0],low=structuredClone(high);
        low.confidence=89;low.bbox.x0+=8;low.bbox.x1+=8;for(const word of low.words){word.confidence=89;word.bbox.x0+=8;word.bbox.x1+=8;}
        const blocks=[{paragraphs:[{lines:[high,low]}]}],views=normalizeOcrLineViews(blocks);
        expect(views.manga).toMatchObject([{text:'12:30 PM',numericConfidence:99}]);
        expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:low.bbox,guardOnly:true});
    });
    it('缺词、不一致或缺失/低置信时不复活原行，原始完整数值框仍可保护',()=>{
        const variants=[raw('12:30 PM',['12',':','30','PM'],89),raw('12:30 PM',['12',':','30','PM'],undefined),
            raw('12:30 PM',['12',':','31','PM']),raw('12:30 PM',['12',':','30','PM'],99,89),raw('12:30 PM',['12',':','30','PM'],20)];
        // undefined 默认参数无法表达缺失置信度，单独删除源字段。
        for(const word of variants[1][0].paragraphs[0].lines[0].words) delete (word as {confidence?:number}).confidence;
        for(const blocks of variants){const views=normalizeOcrLineViews(blocks);expect(views.manga.some(line=>line.text==='12:30 PM'&&line.numericConfidence===99)).toBe(false);
            expect(collectRawNumericGuards(blocks,views.manga)).toContainEqual({text:'',bbox:blocks[0].paragraphs[0].lines[0].bbox,guardOnly:true});}
    });
});

describe('原始数值证据的有界保护',()=>{
    it('空识别块或不完整层级不会产生保护框',()=>{
        expect(collectRawNumericGuards(undefined)).toEqual([]);
        expect(collectRawNumericGuards([{}])).toEqual([]);
        expect(collectRawNumericGuards([{paragraphs:[{}]}])).toEqual([]);
    });
    it('一千个相同文本、不同物理框直接匹配，不应因重复比较导致整图失败',()=>{
        const lines=Array.from({length:1000},(_,i)=>{const bbox={x0:i*2,y0:0,x1:i*2+1,y1:1};
            return {text:'90%',bbox,confidence:99,words:[{text:'90%',bbox,confidence:99}]};});
        const blocks=[{paragraphs:[{lines}]}],views=normalizeOcrLineViews(blocks);
        expect(views.manga).toHaveLength(1000);expect(collectRawNumericGuards(blocks,views.manga,{trustedWorkerData:true})).toEqual([]);
    });
    it('只有完整覆盖的可信框可去掉保护；部分覆盖仍保留原物理框',()=>{
        const bbox={x0:2,y0:2,x1:20,y1:10},blocks=[{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}];
        const candidate={text:'90%',bbox:{x0:0,y0:0,x1:21,y1:11},numericConfidence:99};
        expect(collectRawNumericGuards(blocks,[candidate],{trustedWorkerData:true})).toEqual([]);
        expect(collectRawNumericGuards(blocks,[{...candidate,bbox:{...candidate.bbox,x1:19}}]))
            .toEqual([{text:'',bbox,guardOnly:true}]);
    });
    it('访问器和无法反射的对象不走几何快路径，仍按实际边界判断',()=>{
        const bbox={get x0(){return 2;},y0:2,x1:20,y1:10};
        const blocks=[{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}];
        const candidate=new Proxy({text:'90%',numericConfidence:99,bbox:{x0:0,y0:0,x1:21,y1:11}},
            {getOwnPropertyDescriptor(){throw new Error('unavailable');}});
        expect(collectRawNumericGuards(blocks,[candidate])).toEqual([]);
        expect(collectRawNumericGuards(blocks,[])).toEqual([{text:'',bbox:{x0:2,y0:2,x1:20,y1:10},guardOnly:true}]);
    });
    it('整行和词框依次校验，保留行框及前一数值词的原始首因',()=>{
        const lineError=Error('line first'),wordError=Error('word second');
        const line={text:'12:30 PM',get bbox():any {throw lineError;},words:[{text:'12',get bbox():any {throw wordError;}}]};
        expect(()=>collectRawNumericGuards([{paragraphs:[{lines:[line]}]}])).toThrow(lineError);
        const word={text:'12',get bbox():any {throw wordError;}},punctuation={text:':',get bbox():any {throw Error('later punctuation');}};
        const raw={text:'12:30 PM',bbox:{x0:0,y0:0,x1:30,y1:10},words:[word,punctuation]};
        expect(()=>collectRawNumericGuards([{paragraphs:[{lines:[raw]}]}])).toThrow(wordError);
    });
    it('原始 bbox 无法反射时保守回退，不吞掉本可证明覆盖的结果',()=>{
        const bbox=new Proxy({x0:2,y0:2,x1:20,y1:10},{getOwnPropertyDescriptor(){throw new Error('unavailable');}});
        const candidate={text:'90%',numericConfidence:99,bbox:{x0:2,y0:2,x1:20,y1:10}};
        expect(collectRawNumericGuards([{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}],[candidate],{trustedWorkerData:true})).toEqual([]);
    });
    it('可信模式遇到继承坐标及无法反射的候选时按实际覆盖结果回退',()=>{
        const bbox={x0:2,y0:2,x1:20,y1:10};
        const blocks=[{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}];
        const inherited=Object.create({x0:0,y0:0,x1:21,y1:11}) as typeof bbox;
        const candidate={text:'90%',numericConfidence:99,bbox:inherited};
        expect(collectRawNumericGuards(blocks,[candidate],{trustedWorkerData:true})).toEqual([]);
        const reflected=new Proxy({...candidate,bbox:{x0:2,y0:2,x1:19,y1:10}},
            {getOwnPropertyDescriptor(){throw new Error('unavailable');}});
        expect(collectRawNumericGuards(blocks,[reflected],{trustedWorkerData:true}))
            .toEqual([{text:'',bbox,guardOnly:true}]);
    });
    it('同文首个候选的未知 bbox getter 抛错时保留首因，不越过它命中后面的精确框',()=>{
        const failure=new Error('bbox getter first'),bbox={x0:2,y0:2,x1:20,y1:10};
        const first={text:'90%',numericConfidence:99,get bbox():never {throw failure;}};
        const exact={text:'90%',numericConfidence:99,bbox};
        for(const options of [undefined,{trustedWorkerData:true}])
            expect(()=>collectRawNumericGuards([{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}],[first,exact],options)).toThrow(failure);
    });
    it('未知输入中的 Proxy 即使伪装数据描述符，也不跳过首个 bbox 读取异常',()=>{
        const failure=new Error('bbox proxy first'),bbox={x0:2,y0:2,x1:20,y1:10};
        const deceptive=new Proxy({...bbox},{get(target,key,receiver){if(key==='x0')throw failure;return Reflect.get(target,key,receiver);}});
        const first={text:'90%',numericConfidence:99,bbox:deceptive};
        const exact={text:'90%',numericConfidence:99,bbox};
        expect(()=>collectRawNumericGuards([{paragraphs:[{lines:[{text:'90%',bbox,confidence:20}]}]}],[first,exact])).toThrow(failure);
    });
    it('非法位置和超过保护框数量上限时明确报错',()=>{
        const invalid=[{paragraphs:[{lines:[{text:'90%',bbox:{x0:NaN,y0:0,x1:2,y1:2},confidence:20}]}]}];
        expect(()=>collectRawNumericGuards(invalid)).toThrow('保护位置无效');
        const lines=Array.from({length:4097},(_,i)=>({text:'90%',bbox:{x0:i*2,y0:0,x1:i*2+1,y1:1},confidence:20}));
        expect(()=>collectRawNumericGuards([{paragraphs:[{lines}]}])).toThrow('保护区域过于复杂');
    });
    it('同文候选无法证明覆盖并超过比较预算时保留原图而不伪装成功',()=>{
        const recognized=Array.from({length:1001},(_,i)=>({text:'90%',numericConfidence:99,bbox:{x0:i*2,y0:0,x1:i*2+1,y1:1}}));
        const lines=Array.from({length:1001},(_,i)=>({text:'90%',bbox:{x0:100000+i*2,y0:0,x1:100001+i*2,y1:1},confidence:20}));
        expect(()=>collectRawNumericGuards([{paragraphs:[{lines}]}],recognized)).toThrow('保护区域过于复杂');
    });
});

describe('图片 OCR 有界尺寸和可信文本', () => {
    it('漫画按明确源语言覆盖专用字表缺口，区域代码共用语言包规则，自动模式不猜网站语言', () => {
        for (const source of ['ru', ' RU-ru ', 'ru_RU']) {
            expect(getMangaOcrEngine(source)).toBe('tesseract');
            expect(getRequiredImageOcrLanguages(source)).toEqual(['rus', 'eng']);
        }
        for (const source of ['ko', ' KO-kr ', 'ko_KR']) {
            expect(getMangaOcrEngine(source)).toBe('tesseract');
            expect(getRequiredImageOcrLanguages(source)).toEqual(['kor', 'eng']);
        }
        for (const source of ['auto', '', 'en', 'ja', 'zh-Hans', 'es', 'fr', 'uk', 'russian', 'korean']) expect(getMangaOcrEngine(source)).toBe('paddle');
    });
    it('普通图片保留原始尺寸，大图同时受像素总数和最长边约束', () => {
        expect(getOcrImageSize(320, 180)).toEqual({width: 320, height: 180});
        expect(getOcrImageSize(1920, 1080)).toEqual({width: 1920, height: 1080});
        expect(getOcrImageSize(8000, 1000)).toEqual({width: 4096, height: 512});
        expect(getOcrImageSize(4000, 3000)).toEqual({width: 2828, height: 2121});
        expect(getOcrImageSize(1, 100_000)).toEqual({width: 1, height: 4096});
    });

    it.each([[0, 10], [-1, 10], [10, 0], [10, -1], [Infinity, 10], [10, Infinity], [NaN, 10]])(
        '拒绝无效尺寸 %s × %s', (width, height) => {
            expect(() => getOcrImageSize(width, height)).toThrow('图片尺寸无效');
        },
    );

    it('圈选只放大小图，为紧贴文字预留边框，超大和极窄选区仍有像素预算', () => {
        expect(getAreaOcrImageSize(320, 180)).toEqual({width: 640, height: 360, padding: 10});
        expect(getAreaOcrImageSize(1000, 500)).toEqual({width: 2000, height: 1000, padding: 10});
        expect(getAreaOcrImageSize(1001, 500)).toEqual({width: 1001, height: 500, padding: 10});
        expect(getAreaOcrImageSize(500, 501)).toEqual({width: 500, height: 501, padding: 10});
        for (const [width, height] of [[8000, 1000], [4000, 3000], [1, 100_000], [100_000, 1]]) {
            const size = getAreaOcrImageSize(width, height);
            expect(size.width).toBeGreaterThanOrEqual(1);
            expect(size.height).toBeGreaterThanOrEqual(1);
            expect(Math.max(size.width, size.height) + size.padding * 2).toBeLessThanOrEqual(4096);
            expect((size.width + size.padding * 2) * (size.height + size.padding * 2)).toBeLessThanOrEqual(6_000_000);
        }
        expect(() => getAreaOcrImageSize(0, 50)).toThrow('图片尺寸无效');
    });

    it('圈选坐标先去边框再逆缩放，忽略白边内的伪识别并保留触边原文', () => {
        expect(restoreOcrLineCoordinates([
            {text: 'center', bbox: {x0: 30, y0: 50, x1: 110, y1: 90}},
            {text: 'edge', bbox: {x0: 5, y0: 5, x1: 215, y1: 115}},
            {text: 'border', bbox: {x0: 0, y0: 0, x1: 9, y1: 9}},
        ], 100, 50, 200, 100, 10)).toEqual([
            {text: 'center', bbox: {x0: 10, y0: 20, x1: 50, y1: 40}},
            {text: 'edge', bbox: {x0: 0, y0: 0, x1: 100, y1: 50}},
        ]);
    });

    it('将降采样框映回原图并夹紧越界框，舍弃完全落在图片外的识别', () => {
        expect(restoreOcrLineCoordinates([
            {text: 'valid', bbox: {x0: 10, y0: 20, x1: 30, y1: 40}},
            {text: 'edge', bbox: {x0: -3, y0: -2, x1: 120, y1: 120}},
            {text: 'outside', bbox: {x0: 101, y0: 1, x1: 120, y1: 2}},
            {text: 'invalid', bbox: {x0: NaN, y0: 1, x1: 120, y1: 2}},
        ], 201, 199, 100, 100)).toEqual([
            {text: 'valid', bbox: {x0: 20, y0: 39, x1: 61, y1: 80}},
            {text: 'edge', bbox: {x0: 0, y0: 0, x1: 201, y1: 199}},
        ]);
    });

    it('低置信和无效 words 全部过滤后不再回退到整行噪声', () => {
        const bbox = {x0: 0, y0: 0, x1: 50, y1: 10};
        expect(normalizeOcrLines([{paragraphs: [{lines: [
            {text: 'noise', bbox, words: [{text: 'noise', confidence: 10, bbox}]},
            {text: 'nan', bbox, words: [{text: 'nan', confidence: NaN, bbox}]},
            {text: 'infinite', bbox, words: [{text: 'infinite', confidence: Infinity, bbox}]},
            {text: 'invalid', bbox, words: [{text: 'invalid', bbox: {...bbox, x1: Infinity}}]},
            {text: 'empty', bbox, words: [{text: '  ', bbox}]},
        ]}]}])).toEqual([]);
    });

    it('无词数据时接受可信行，但拒绝低置信度或非有限行框', () => {
        const bbox = {x0: 0, y0: 0, x1: 50, y1: 10};
        expect(normalizeOcrLines([{paragraphs: [{lines: [
            {text: 'recognized', bbox, words: [], confidence: 80},
            {text: 'low', bbox, confidence: 24},
            {text: 'nan', bbox, confidence: NaN},
            {text: 'infinite', bbox: {...bbox, x1: Infinity}},
            {text: 'flat', bbox: {...bbox, y1: 0}},
        ]}]}])).toEqual([{text: 'recognized', bbox}]);
    });

    it('保留英文标点与括号空格语义，不把句子变成分隔符碎片', () => {
        const tokens = ['Hello', ',', 'world', '!', '(', 'Read', 'this', ')'];
        expect(normalizeOcrLines([{paragraphs: [{lines: [{
            text: 'Hello, world! (Read this)',
            bbox: {x0: 0, y0: 0, x1: 100, y1: 10},
            words: tokens.map((text, index) => ({
                text,
                bbox: {x0: index * 12, y0: 0, x1: index * 12 + 10, y1: 10},
            })),
        }]}]}])).toEqual([{
            text: 'Hello, world! (Read this)',
            bbox: {x0: 0, y0: 0, x1: 94, y1: 10},
        }]);
    });

    it('空白译文不会擦除原字，正常译文去掉首尾空白', () => {
        const bbox = {x0: 0, y0: 0, x1: 50, y1: 10};
        const lines = [{text: 'one', bbox}, {text: 'two', bbox}, {text: 'three', bbox}];
        expect(selectChangedTranslations(lines, ['  ', '\n', ' 三 '])).toEqual([{text: '三', bbox}]);
    });
});


describe('OCR 重复框处理', () => {
    it('去掉同位置的重复检测，保留其他位置的相同价格与数字', () => {
        const box = {x0: 10, y0: 10, x1: 110, y1: 30};
        const result = normalizeOcrLines([{paragraphs: [{lines: [
            {text: '123.45', bbox: box},
            {text: '123.45', bbox: {...box, x0: 11}},
            {text: '123.45', bbox: {...box, y0: 50, y1: 70}},
            {text: '123.46', bbox: box},
        ]}]}]);
        expect(result.map(line => line.text)).toEqual(['123.45', '123.45', '123.46']);
        expect(result[1].bbox.y0).toBe(50);
    });
    it('部分重叠的相同短词并非重复，仍分别参与识别与绘制', () => {
        expect(normalizeOcrLines([{paragraphs: [{lines: [
            {text: 'Yes', bbox: {x0: 0, y0: 0, x1: 100, y1: 20}},
            {text: 'Yes', bbox: {x0: 50, y0: 0, x1: 150, y1: 20}},
        ]}]}])).toHaveLength(2);
    });
});
