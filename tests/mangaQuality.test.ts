import {describe, expect, it, vi} from 'vitest';
import {groupMangaText, groupMangaOcrLines, type MangaOcrItem} from '@/src/features/image-translation/services/mangaRegions';
import {drawMangaTranslations,mangaRegionBackground} from '@/src/features/image-translation/services/mangaRendering';
import {layoutImageTranslationText} from '@/src/features/image-translation/services/rendering';

const item = (text: string, x = 20, y = 20, width = 80, height = 20, confidence = 0.99): MangaOcrItem =>
    ({text, box: {x, y, width, height}, confidence});

describe('漫画整段识别与噪声边界', () => {
    it('俄语和韩语通用 OCR 补足修补字号，合并连续对白，原框与原文不被修改', () => {
        const lines = [
            {text: '  Что-то\n ', bbox: {x0: 20, y0: 20, x1: 100, y1: 40}},
            {text: 'забыл', bbox: {x0: 20, y0: 44, x1: 100, y1: 64}},
            {text: 'Другой', bbox: {x0: 220, y0: 20, x1: 300, y1: 40}},
        ];
        const original = structuredClone(lines), regions = groupMangaOcrLines(lines, ' RU_ru ', 400, 300);
        expect(regions.map(region => region.text)).toEqual(['Другой', 'Что-то забыл']);
        expect(regions[1]).toMatchObject({fontSize: 20, bbox: {x0: 20, y0: 20, x1: 100, y1: 64}, sourceBoxes: [lines[0].bbox, lines[1].bbox]});
        expect(lines).toEqual(original);regions[1].sourceBoxes![0].x0 = 0;expect(lines).toEqual(original);
        expect(groupMangaOcrLines([{text: '시작했다고?', bbox: lines[0].bbox}], 'ko-KR', 400, 300)[0].fontSize).toBe(20);
    });
    it('通用漫画识别拒绝无效尺寸、越界框和短异文噪声，保留合法单字、长英文与竖排字号', () => {
        const box = {x0: 20, y0: 20, x1: 100, y1: 40};
        for (const [width, height] of [[0, 20], [20, NaN], [10.5, 20]]) expect(groupMangaOcrLines([], 'ru', width, height)).toEqual([]);
        const noisy = ['', '--', 'a!', 'N', 'ㅁ2'].map(text => ({text, bbox: box}));
        expect(groupMangaOcrLines(noisy, 'ko', 400, 300)).toEqual([]);
        expect(groupMangaOcrLines([{text: 'Я', bbox: box}], 'ru', 400, 300)[0].text).toBe('Я');
        expect(groupMangaOcrLines([{text: 'HELLO', bbox: box}], 'ko', 400, 300)[0].text).toBe('HELLO');
        expect(groupMangaOcrLines([{text: '通用', bbox: {x0: -5, y0: -5, x1: 10, y1: 60}, vertical: true}], 'auto', 400, 300)[0]).toMatchObject({fontSize: 10, vertical: true});
        for (const bbox of [{...box, x0: NaN}, {...box, x0: 401}, {...box, y0: 301}, {...box, x1: 0}]) expect(groupMangaOcrLines([{text: 'слово', bbox}], 'ru', 400, 300)).toEqual([]);
    });
    it('韩文 OCR 保留分解音节、连续兼容及扩展字母，不改原文或源框', () => {
        const bbox = {x0: 20, y0: 20, x1: 100, y1: 40};
        const texts = ['안녕하세요'.normalize('NFD'), 'ㅋㅋㅋ', 'ㅇㅋ', '\uA960\uD7B0', '안녕하세요'];
        for (const source of ['ko', ' KO_kr ']) for (const text of texts) {
            const input = [{text, bbox: {...bbox}}], original = structuredClone(input);
            const result = groupMangaOcrLines(input, source, 400, 300);
            expect(result).toMatchObject([{text, bbox, fontSize: 20, sourceBoxes: [bbox]}]);
            result[0].sourceBoxes![0].x0 = 1;
            expect(input).toEqual(original);
        }
        for (const text of ['ㅁ2', 'ㅁ〮', 'ㅁ㉠', '\u115F\u1160', '\u3164\uFFA0', 'abc', '漢', '😀', '12:34'])
            expect(groupMangaOcrLines([{text, bbox}], 'ko', 400, 300)).toEqual([]);
        expect(groupMangaOcrLines([{text:'HELLO',bbox}], 'ko',400,300)[0].text).toBe('HELLO');
    });
    it('韩文分解文字跨行保留现有词间空格，不把英文及汉字邻接当作韩文', () => {
        const first = '나는'.normalize('NFD'), second = '학생이다'.normalize('NFD');
        const lines = [{text:first,bbox:{x0:20,y0:20,x1:100,y1:40}}, {text:second,bbox:{x0:20,y0:44,x1:100,y1:64}}];
        expect(groupMangaOcrLines(lines,'ko',400,300).map(row=>row.text)).toEqual([`${first} ${second}`]);
        expect(groupMangaOcrLines(lines,'ko',400,300)[0].sourceBoxes).toEqual(lines.map(line=>line.bbox));
        expect(groupMangaOcrLines([{text:'안녕 Hi',bbox:lines[0].bbox}], 'ko',400,300)[0].text).toBe('안녕 Hi');
    });
    it('英文源语言一致过滤预组、分解、兼容和扩展韩文，保留英文与数字', () => {
        for (const source of ['en','en-US']) {
            for (const text of ['Hi한','Hi'+'한'.normalize('NFD'),'Hiㅋㅋ','Hi\uA960','Hi\uD7B0'])
                expect(groupMangaText([item(text)],source,400,300)).toEqual([]);
            expect(groupMangaText([item('Hello')],source,400,300).map(row=>row.text)).toEqual(['Hello']);
            expect(groupMangaText([item('42')],source,400,300).map(row=>row.text)).toEqual(['42']);
        }
    });
    it('日文页排除绘画上误识别的短拉丁片段，保留日文对白和完整拉丁词', () => {
        const fragments=[item('A'),item('HU'),item('B ou'),item('Q')];
        expect(groupMangaText(fragments,'ja',400,400)).toEqual([]);
        expect(groupMangaText([item('やった'),item('口',220,100,20,20),item('HELLO',100,200)],'jpn',400,400).map(r=>r.text)).toEqual(['やった','口','HELLO']);
    });
    it('将同一旁白的多行整句合并，旁边和远处的气泡保持独立', () => {
        const result = groupMangaText([item('THIS', 60, 20, 40), item('STORY', 20, 43, 120),
            item('CONTINUES.', 30, 67, 100), item('Another bubble', 180, 44, 100), item('Next panel', 20, 220)], 'en', 400, 500);
        expect(result.map(line => line.text)).toEqual(['THIS STORY CONTINUES.', 'Another bubble', 'Next panel']);
        expect(result[0].bbox).toEqual({x0: 20, y0: 20, x1: 140, y1: 87});
    });
    it('已定位气泡中的大写行按实际字形高度容许正常留白，整页和远距行仍独立', () => {
        const first=item('THE TRAIN',145,215,201,27),next=item('LEAVES AT NINE',105,280,298,26);
        const regions=groupMangaText([first,next],'en',1000,1400,'bubble');
        expect(regions.map(region=>region.text)).toEqual(['THE TRAIN LEAVES AT NINE']);
        expect(regions[0].sourceBoxes).toEqual([{x0:145,y0:215,x1:346,y1:242},{x0:105,y0:280,x1:403,y1:306}]);
        expect(groupMangaText([first,next],'en',1000,1400)).toHaveLength(2);
        expect(groupMangaText([first,{...next,box:{...next.box,y:283}}],'en',1000,1400,'bubble')).toHaveLength(2);
        expect(groupMangaText([item('First',40,40,60,8),item('Distant',40,80,60,8)],'en',400,400,'bubble')).toHaveLength(2);
    });
    it('同一行分词按从左到右排序，并按行合并完整对白', () => {
        const result = groupMangaText([item('world', 82, 19, 50), item('Hello', 20, 20, 55), item('again', 50, 44)], 'en', 300, 200);
        expect(result[0].text).toBe('Hello world again');
    });
    it('横排日文和中文跨行合句不插入模型原文中没有的空格，英文保留词间空格', () => {
        expect(groupMangaText([item('そう',20,20),item('だね！',20,44)],'ja',400,300)[0].text).toBe('そうだね！');
        expect(groupMangaText([item('そう。',20,20),item('ですね！',20,44)],'ja',400,300)[0].text).toBe('そう。ですね！');
        expect(groupMangaOcrLines([{text:'原来',bbox:{x0:20,y0:20,x1:100,y1:40}},{text:'如此。',bbox:{x0:20,y0:44,x1:100,y1:64}}],'zh',400,300)[0].text).toBe('原来如此。');
        expect(groupMangaText([item('Hello',20,20),item('again',20,44)],'en',400,300)[0].text).toBe('Hello again');
    });
    it.each([
        ['扩展 B 两侧', '你好𠀀', '𠀁世界', '你好𠀀𠀁世界'],
        ['基本区到扩展 B', '你好', '𠀁世界', '你好𠀁世界'],
        ['扩展 G 到基本区', '你好𰀀', '世界', '你好𰀀世界'],
        ['全角句号到扩展 B', '你好。', '𠀁世界', '你好。𠀁世界'],
        ['补充平面汉字后接 IVS', '你好𠀀\u{E0100}', '𠀁世界', '你好𠀀\u{E0100}𠀁世界'],
        ['基本区汉字后接 IVS', '你好字\u{E0101}', '𠀁世界', '你好字\u{E0101}𠀁世界'],
        ['emoji 变体不当作东亚文字', 'hello☕\uFE0F', '𠀁世界', 'hello☕\uFE0F 𠀁世界'],
        ['半角假名到补充假名', 'ｶﾅ', '𛀁𛀂', 'ｶﾅ𛀁𛀂'],
        ['半角浊音到补充假名', 'ｶﾞ', '𛀁𛀂', 'ｶﾞ𛀁𛀂'],
        ['分解浊音', 'それか\u3099', 'なです', 'それか\u3099なです'],
        ['分解半浊音', 'それは\u309A', 'なです', 'それは\u309Aなです'],
        ['扩展 B 到拉丁词', '你好𠀀', 'again', '你好𠀀 again'],
        ['拉丁词到扩展 B', 'again', '𠀁世界', 'again 𠀁世界'],
        ['扩展 B 到 emoji 和拉丁词', '你好𠀀', '😀again', '你好𠀀 😀again'],
        ['emoji 和拉丁词到扩展 B', 'again😀', '𠀁世界', 'again😀 𠀁世界'],
        ['英文及连字符', 'some-', 'thing', 'some-thing'],
        ['英文常规空格', 'Hello', 'again', 'Hello again'],
    ])('漫画跨行边界按完整 Unicode 码点处理（%s）', (_label, first, second, expected) => {
        const items = [item(first,20,20), item(second,20,44)];
        const ocr = items.map(({text,box}) => ({text,bbox:{x0:box.x,y0:box.y,x1:box.x+box.width,y1:box.y+box.height}}));
        for (const context of ['page', 'bubble'] as const) {
            for (const protectNumeric of [false, true]) {
                const result = groupMangaText(items, 'zh', 400, 300, context, protectNumeric);
                expect(result.map(region=>region.text)).toEqual([expected]);
                expect(result[0].sourceBoxes).toEqual(ocr.map(line=>line.bbox));
            }
        }
        const result = groupMangaOcrLines(ocr, 'zh', 400, 300);
        expect(result.map(region=>region.text)).toEqual([expected]);
        expect(result[0].sourceBoxes).toEqual(ocr.map(line=>line.bbox));
    });
    it('日文源语言保留补充平面汉字，同时继续过滤短拉丁噪声', () => {
        for (const source of ['ja', 'jpn']) {
            expect(groupMangaText([item('𠀀𠀁')],source,400,300).map(region=>region.text)).toEqual(['𠀀𠀁']);
            expect(groupMangaText([item('𰀀字')],source,400,300).map(region=>region.text)).toEqual(['𰀀字']);
            expect(groupMangaText([item('A𠀀')],source,400,300).map(region=>region.text)).toEqual(['A𠀀']);
            expect(groupMangaText([item('ｶﾅ')],source,400,300).map(region=>region.text)).toEqual(['ｶﾅ']);
            expect(groupMangaText([item('𛀁𛀂')],source,400,300).map(region=>region.text)).toEqual(['𛀁𛀂']);
            expect(groupMangaText([item('HU')],source,400,300)).toEqual([]);
        }
    });
    it('通用 OCR 的扩展汉字行也保留完整码点并连写', () => {
        const lines = [
            {text:'你好𠀀', bbox:{x0:20,y0:20,x1:100,y1:40}},
            {text:'𠀁世界', bbox:{x0:20,y0:44,x1:100,y1:64}},
        ];
        const result=groupMangaOcrLines(lines,'ja',400,300);
        expect(result.map(region=>region.text)).toEqual(['你好𠀀𠀁世界']);
        expect(result[0].sourceBoxes).toEqual(lines.map(line=>line.bbox));
    });
    it('英文源语言对基本区与补充平面汉字一致过滤，保留英文和数字例外', () => {
        for (const source of ['en', 'en-US']) {
            for (const text of ['Hi漢', 'Hi𠀀', 'Hi𰀀', 'Hiｶ', 'Hi𛀁']) expect(groupMangaText([item(text)],source,400,300)).toEqual([]);
            expect(groupMangaText([item('Hello')],source,400,300).map(region=>region.text)).toEqual(['Hello']);
            expect(groupMangaText([item('I')],source,400,300).map(region=>region.text)).toEqual(['I']);
            expect(groupMangaText([item('42')],source,400,300).map(region=>region.text)).toEqual(['42']);
        }
    });
    it('不同字号标题和正文、横排和竖排不被合并', () => {
        const result = groupMangaText([item('TITLE', 20, 20, 100, 50), item('body', 20, 65, 80, 20),
            item('縦書き', 100, 20, 15, 80)], 'auto', 300, 300);
        expect(result).toHaveLength(3);
    });
    it('竖排按右到左、同列从上到下合段，保留高置信度小气泡单字', () => {
        const result = groupMangaText([item('左列', 100, 20, 20, 70), item('右列', 124, 20, 20, 70),
            item('続き', 124, 97, 20, 70), item('啊', 220, 200, 20, 20)], 'ja', 400, 400);
        expect(result[0]).toMatchObject({text: '右列続き左列', vertical: true});
        expect(result[1].text).toBe('啊');
    });
    it('宽竖列仅在同一已定位气泡内合段，仍限制列距、纵向覆盖与字号，横排行距不扩大',()=>{
        const right=item('右の列',200,20,40,240),left=item('左の列',20,20,40,240);
        expect(groupMangaText([left,right],'ja',500,500,'bubble')[0].text).toBe('右の列左の列');
        expect(groupMangaText([left,right],'ja',500,500)).toHaveLength(2);
        for(const separate of [item('遠い列',201,20,40,240),item('低い列',200,150,40,240),item('小さな注音',200,20,20,100)]){
            expect(groupMangaText([left,separate],'ja',500,500,'bubble')).toHaveLength(2);
        }
        expect(groupMangaText([item('First',20,20,100,20),item('Second',20,71,100,20)],'en',500,500,'bubble')).toHaveLength(2);
    });
    it('过滤低置信度、符号、数字艺术碎片和英文漫画里的错误汉字，不丢掉合法 I/A 短句', () => {
        const bad = [item('noise', 20, 20, 80, 20, 0.64), item('nan', 20, 20, 80, 20, NaN),
            item(''), item('=='), item('3 3'), item('才', 200, 200, 100, 200), item('noise才'), item('j')];
        expect(groupMangaText(bad, 'en', 500, 500)).toEqual([]);
        expect(groupMangaText([item('I'), item('A', 200, 200)], 'en', 500, 500).map(line => line.text)).toEqual(['I', 'A']);
        expect(groupMangaText([item('才', 20, 20, 150, 200), item('啊', 20, 20, 20, 20, 0.85)], 'auto', 500, 500)).toEqual([]);
    });
    it.each(['en','ja','jpn','auto','zh','ko','ru'])('高置信数字信息不受源语言限制，判定可用 NFKC 但原文与框不变：%s', language => {
        for(const text of ['42','123456','23:59','7:05','00:00:59','2024-02-29','2026/10/25','2026.1.3',
            '$8','-£9.50','¥1,280.50','12.99€','１２３４','０９：１７','￥１２８０','２０２４／０２／２９']) {
            const source=item(text,20,30,90,18,.9),original=structuredClone(source);
            const result=groupMangaText([source],language,500,500);
            expect(result).toEqual([{text,bbox:{x0:20,y0:30,x1:110,y1:48},fontSize:18,sourceBoxes:[{x0:20,y0:30,x1:110,y1:48}]}]);
            expect(source).toEqual(original);
        }
    });
    it('数字支路不放开低置信、孤立数字、无效日期时间与金额及空格艺术碎片', () => {
        const noise=['1','７','3 3','123 456','①②','²³','..',':','$','09::17','24:00','12:60','9:5','99:99',
            '2023-02-29','2024-02-30','2026-13-01','2026-00-01','2026-01-00','0000-01-01','2026-1-32','2026/01-02',
            '$1,23','$1.234','$1,2345','12 34€','123--'];
        for(const language of ['en','ja','auto']) {
            expect(groupMangaText(noise.map(text=>item(text)),language,500,500,'bubble')).toEqual([]);
            for(const text of ['42','23:59','2024-02-29','$8','￥１２８０']) {
                expect(groupMangaText([item(text,20,20,80,20,.899999)],language,500,500,'bubble')).toEqual([]);
            }
        }
        expect(groupMangaText([item('hello',20,20,80,20,.65)],'en',500,500)[0].text).toBe('hello');
        for(const bad of [item('12:34',NaN),item('12:34',20,20,0),item('12:34',600),item('12:34',20,600)]) {
            expect(groupMangaText([bad],'en',500,500)).toEqual([]);
        }
    });
    it('实际聊天截图 SDK 的高置信时间框进入结果，不改变识别原文或几何', () => {
        const actual=item('08:45',878,42,76,24,.998395),original=structuredClone(actual);
        expect(groupMangaText([actual],'en',1024,1536)).toEqual([{text:'08:45',bbox:{x0:878,y0:42,x1:954,y1:66},
            fontSize:24,sourceBoxes:[{x0:878,y0:42,x1:954,y1:66}]}]);
        expect(actual).toEqual(original);
    });
    it('拒绝坏坐标、无效尺寸、图外框，夹紧可用区域且规范化空白', () => {
        for (const [width, height] of [[0, 20], [20, Infinity], [10.5, 20]]) expect(groupMangaText([item('text')], 'en', width, height)).toEqual([]);
        expect(groupMangaText([item('bad', NaN), item('bad', 20, 20, 0), item('bad', 20, 20, 10, -1),
            item('outside', 600), item('outside', 20, 600), item('outside', -120, 20)], 'en', 500, 500)).toEqual([]);
        expect(groupMangaText([item('  Hello\n world  ', -5, -5, 100, 30)], 'en', 80, 20)[0])
            .toMatchObject({text: 'Hello world', bbox: {x0: 0, y0: 0, x1: 80, y1: 20}});
    });
    it('同高区域按右到左保留漫画阅读顺序', () => {
        expect(groupMangaText([item('left'), item('right', 200)], 'en', 400, 300).map(line => line.text)).toEqual(['right', 'left']);
    });
    it('只删除明确的行末软连字符，保留复合词的硬连字符与口吃前缀',()=>{
        expect(groupMangaText([item('UNDER\u00ad',20,20),item('STOOD...',20,44)],'en',400,300)[0].text).toBe('UNDERSTOOD...');
        expect(groupMangaText([item('A-ABSO\u00ad',20,20),item('LUTELY NOT!',20,44)],'en',400,300)[0].text).toBe('A-ABSOLUTELY NOT!');
        expect(groupMangaText([item('well-',20,20),item('known',20,44)],'en',400,300)[0].text).toBe('well-known');
        expect(groupMangaText([item('part-',20,20),item('2nd line',20,44)],'en',400,300)[0].text).toBe('part- 2nd line');
    });
    it('只在已定位气泡保留高置信度大单字，整页与低置信度绘画噪声保持过滤', () => {
        const single=item('え',40,40,70,70);
        expect(groupMangaText([single],'ja',400,400)).toEqual([]);
        expect(groupMangaText([single],'ja',400,400,'bubble').map(r=>r.text)).toEqual(['え']);
        expect(groupMangaText([{...single,confidence:.85}],'ja',400,400,'bubble')).toEqual([]);
    });
});

describe('漫画字号和安全绘制', () => {
    it.each([128,180,254,255])('同 RGB 边缘的 alpha=%i 仅完全不透明时才可作为均匀清字依据', alpha => {
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4);
        for(let offset=0;offset<pixels.length;offset+=4)pixels.set([160,176,192,alpha],offset);
        const before=pixels.slice(),bbox={x0:16,y0:12,x1:48,y1:36};
        expect(mangaRegionBackground(pixels,width,height,bbox)).toEqual({color:'rgb(160,176,192)',uniform:alpha===255});
        expect(pixels).toEqual(before);
    });
    it.each([0,254])('单个 alpha=%i 的已采样边缘点否决均匀底色，不套用 RGB 的九成容差', alpha => {
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4).fill(255),bbox={x0:16,y0:12,x1:48,y1:36};
        pixels[(11*width+16)*4+3]=alpha;
        expect(mangaRegionBackground(pixels,width,height,bbox)).toEqual({color:'rgb(255,255,255)',uniform:false});
    });
    it('混合半透明与不透明边缘仍走复杂背景，纯不透明边缘保留既有 RGB 噪声容差',()=>{
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4).fill(255),bbox={x0:16,y0:12,x1:48,y1:36};
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels[(y*width+x)*4+3]=(x+y)%2?180:255;
        expect(mangaRegionBackground(pixels,width,height,bbox).uniform).toBe(false);
        for(let offset=3;offset<pixels.length;offset+=4)pixels[offset]=255;
        pixels[(11*width+16)*4]=0;
        expect(mangaRegionBackground(pixels,width,height,bbox)).toEqual({color:'rgb(255,255,255)',uniform:true});
    });
    it('边缘采样不能证明框内透明孔洞安全，保留该局限而不新增内部扫描',()=>{
        const width=64,height=48,pixels=new Uint8ClampedArray(width*height*4).fill(255),bbox={x0:16,y0:12,x1:48,y1:36};
        for(let y=20;y<28;y++)for(let x=24;x<40;x++)pixels[(y*width+x)*4+3]=0;
        expect(mangaRegionBackground(pixels,width,height,bbox)).toEqual({color:'rgb(255,255,255)',uniform:true});
    });
    it('短译文限制为统一字号，长译文继续完整换行', () => {
        const measure = (text: string, size: number) => Array.from(text).length * size;
        expect(layoutImageTranslationText('你好', 300, 500, measure, 26).fontSize).toBe(26);
        const text = '完整译文'.repeat(30), layout = layoutImageTranslationText(text, 60, 60, measure, 26);
        expect(layout.lines.join('')).toBe(text); expect(layout.fontSize).toBeLessThan(26);
    });
    it('均匀气泡保持原色，复杂区域使用可读底色并恢复 Canvas 状态', () => {
        const width = 100, height = 100;
        const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
        const context = {save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillStyle: '', font: '',
            beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), measureText: vi.fn(() => ({width: 1})), strokeText: vi.fn(), fillText: vi.fn()};
        drawMangaTranslations(context as any, pixels, width, height, [{text:'译文',fontSize:20,bbox:{x0:20,y0:20,x1:80,y1:60}}]);
        expect(context.fillRect).toHaveBeenCalledWith(20,20,60,40); expect(context.fillStyle).toBe('#111111');
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4; pixels[offset] = (x+y)%2 ? 0 : 255;
        }
        drawMangaTranslations(context as any, pixels, width, height, [{text:'译文',fontSize:20,bbox:{x0:20,y0:20,x1:80,y1:60}}]);
        expect(context.save).toHaveBeenCalledTimes(2); expect(context.restore).toHaveBeenCalledTimes(2);
        expect(context.fillRect).toHaveBeenCalledTimes(2);
        drawMangaTranslations(context as any,pixels,width,height,[{text:'译文',fontSize:20,bbox:{x0:20,y0:20,x1:80,y1:60}}],true);
        expect(context.fillRect).toHaveBeenCalledTimes(2); // 已修补画面不再铺白底。
    });
    it('无效像素预算和区域不进入绘图，贴边小区域仍可读', () => {
        const context = {save:vi.fn(),restore:vi.fn(),fillRect:vi.fn(),measureText:vi.fn(()=>({width:1})),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),strokeText:vi.fn(),fillText:vi.fn()};
        for (const [width,height] of [[0,10],[10,NaN],[10,10]]) drawMangaTranslations(context as any,new Uint8ClampedArray(4),width,height,[]);
        const p=new Uint8ClampedArray(4*4*4);
        drawMangaTranslations(context as any,p,4,4,[{text:'x',fontSize:10,bbox:{x0:5,y0:0,x1:8,y1:2}},
            {text:'x',fontSize:10,bbox:{x0:0,y0:5,x1:2,y1:8}}, {text:'x',fontSize:10,bbox:{x0:-1,y0:-1,x1:2,y1:2}}]);
        expect(context.fillRect).toHaveBeenCalledOnce();
    });
});

describe('漫画数字证据：Tesseract 数字保留与分组',()=>{
    const bbox={x0:20,y0:20,x1:100,y1:40};
    it.each(['ru','ko'])('高置信独立数字信息在 %s 中保留原文和物理框',language=>{
        for(const text of ['42','23:59','2024-02-29','₩12,000','￥１２８０']) {
            const line={text,bbox,numericConfidence:90};expect(groupMangaOcrLines([line],language,400,300)).toEqual([{text,bbox,fontSize:20,sourceBoxes:[bbox]}]);
        }
    });
    it('缺失/低值/非法置信和非法数字形态仍不作为可读数字',()=>{
        for(const confidence of [undefined,89.999,NaN,Infinity,-1,101]) {
            expect(groupMangaOcrLines([{text:'12:34',bbox,numericConfidence:confidence}],'ko',400,300)).toEqual([]);
        }
        for(const text of ['1','3 3','①②','24:00','2023-02-29','$1,23']) {
            expect(groupMangaOcrLines([{text,bbox,numericConfidence:99}],'ko',400,300)).toEqual([]);
        }
    });
    it('数字与近邻正文及其他数字始终独立，正文之间的现有合段不受影响',()=>{
        const a={text:'안녕',bbox:{x0:20,y0:20,x1:100,y1:40}},n={text:'12:34',bbox:{x0:20,y0:44,x1:100,y1:64},numericConfidence:99};
        const b={text:'반가워',bbox:{x0:20,y0:68,x1:100,y1:88}},n2={text:'2024-02-29',bbox:{x0:20,y0:92,x1:100,y1:112},numericConfidence:99};
        expect(groupMangaOcrLines([a,n,b,n2],'ko',400,300).map(x=>x.text)).toEqual(['안녕','12:34','반가워','2024-02-29']);
    });
});


describe('漫画数字与对白分组',()=>{
    it('Paddle 漫画保留高置信数字且不与对白合段，普通分组契约不变',()=>{
        const samples=[item('Hello',20,20,80,20),item('12:34',20,42,80,20),item('again',20,64,80,20)];
        expect(groupMangaText(samples,'en',400,400,'bubble',true).map(row=>row.text)).toEqual(['Hello again','12:34']);
        expect(groupMangaText(samples,'en',400,400,'bubble').map(row=>row.text)).toEqual(['Hello 12:34 again']);
        expect(groupMangaText([item('12:34',20,20,80,20,.89)],'en',400,400,'bubble',true)).toEqual([]);
    });
});
