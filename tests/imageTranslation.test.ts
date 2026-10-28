import { describe, expect, it } from 'vitest';
import { getOcrLanguages, normalizeOcrLines, selectChangedTranslations } from '@/src/features/image-translation/core';
import { inpaintTextRegions } from '@/src/features/image-translation/services/inpainting';
import { getImageOcrModelLanguages, IMAGE_OCR_LANGUAGE_PACKS, IMAGE_OCR_RECOMMENDED_LANGUAGES, normalizeImageOcrLanguageCodes } from '@/src/features/image-translation/ocrLanguages';
import { getImageTextBackgroundColor, getImageTextColor } from '@/src/features/image-translation/services/rendering';

describe('图片翻译 OCR 工具', () => {
    it.each([
        ["two supplementary Han", "𠀀", "𠀁", "𠀀𠀁"],
        ["BMP then supplementary", "汉", "𠀁", "汉𠀁"],
        ["supplementary then BMP", "𠀀", "字", "𠀀字"],
        ["extended G Han", "𰀀", "𠀁", "𰀀𠀁"],
        ["Latin", "alpha", "beta", "alpha beta"],
        ["emoji", "😀", "😁", "😀 😁"],
        ["closing punctuation", "hello", ")", "hello)"],
        ["opening punctuation", "(", "world", "(world"],
        ["astral then Latin", "𠀀", "word", "𠀀word"],
        ["Latin then astral", "word", "𠀀", "word𠀀"],
        ["astral then emoji", "𠀀", "😀", "𠀀😀"],
        ["emoji then astral", "😀", "𠀀", "😀𠀀"]
    ])('OCR 词保留完整码点和任一 CJK 边界连接策略：%s', (_name, left, right, expected) => {
        const words = [left, right].map((text, index) => ({text,
            bbox: {x0: index * 11, y0: 0, x1: index * 11 + 10, y1: 10}}));
        const input = [{paragraphs: [{lines: [{text: left + right, words,
            bbox: {x0: 0, y0: 0, x1: 21, y1: 10}}]}]}];
        expect(normalizeOcrLines(input).map(line => line.text)).toEqual([expected]);
    });

    it('按源语言选择最小 OCR 语言集', () => {
        for (const source of ['es', 'es-ES', 'es-MX', ' ES_ar ']) expect(getOcrLanguages(source)).toEqual(['spa', 'eng']);
        expect(getOcrLanguages('esperanto')).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
        for (const source of ['en', 'en-US', ' EN_gb ']) expect(getOcrLanguages(source)).toEqual(['eng']);
        for (const [language, code] of [['ko', 'kor'], ['fr', 'fra'], ['ru', 'rus'], ['ja', 'jpn']]) {
            for (const source of [language, `${language}-XX`, ` ${language.toUpperCase()}_xx `]) expect(getOcrLanguages(source)).toEqual([code, 'eng']);
        }
        expect(getOcrLanguages('constructor')).toEqual(IMAGE_OCR_RECOMMENDED_LANGUAGES);
        expect(normalizeImageOcrLanguageCodes(['kor', 'fra', 'rus', 'kor'])).toEqual(['kor', 'fra', 'rus']);
        expect(getOcrLanguages('zh-Hans')).toEqual(['chi_sim', 'eng']);
        expect(getOcrLanguages('zh-Hant')).toEqual(['chi_tra', 'eng']);
        expect(getOcrLanguages('zh-TW')).toEqual(['chi_tra', 'eng']);
        expect(getOcrLanguages('zh-Hans-TW')).toEqual(['chi_sim', 'eng']);
        expect(getOcrLanguages('ja')).toEqual(['jpn', 'eng']);
        expect(IMAGE_OCR_RECOMMENDED_LANGUAGES).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
        expect(IMAGE_OCR_LANGUAGE_PACKS.filter(pack => pack.recommended).map(pack => pack.code)).toEqual(IMAGE_OCR_RECOMMENDED_LANGUAGES);
        expect(getOcrLanguages('auto')).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn']);
    });

    it('日文语言包附带竖排模型，竖排模型紧跟横排模型且不改变主语言 (#654)', () => {
        expect(getImageOcrModelLanguages(['jpn', 'eng'])).toEqual(['jpn', 'jpn_vert', 'eng']);
        expect(getImageOcrModelLanguages(IMAGE_OCR_RECOMMENDED_LANGUAGES)).toEqual(['chi_sim', 'chi_tra', 'eng', 'jpn', 'jpn_vert']);
        expect(getImageOcrModelLanguages(['chi_sim', 'eng'])).toEqual(['chi_sim', 'eng']);
        expect(getImageOcrModelLanguages(['jpn', 'jpn'])).toEqual(['jpn', 'jpn_vert']);
        expect(getImageOcrModelLanguages([])).toEqual([]);
    });

    it('按竖直基线识别竖排列：列内按 y 排序，同一气泡的列从右到左合并，不跨气泡或改动横排行 (#654)', () => {
        const box = (x0: number, y0: number, x1: number, y1: number) => ({x0, y0, x1, y1});
        const column = (text: string, bbox: ReturnType<typeof box>, words: Array<[string, number, ReturnType<typeof box>]>) => ({
            text, bbox, baseline: box(bbox.x0 + 2, bbox.y0, bbox.x0 + 3, bbox.y1),
            words: words.map(([wordText, confidence, wordBox]) => ({text: wordText, confidence, bbox: wordBox})),
        });
        // 精简自 jpn+jpn_vert、PSM 12 对竖排气泡的真实输出：首个 word 框常覆盖整列，后续 word 横向更宽。
        const blocks = [{paragraphs: [
            {lines: [column('お前はもう', box(222, 113, 254, 279), [
                ['お', 96, box(222, 113, 254, 152)], ['前', 96, box(225, 160, 251, 204)], ['は', 96, box(215, 203, 258, 228)],
                ['も', 86, box(227, 227, 248, 252)], ['う', 92, box(228, 256, 245, 279)],
            ])]},
            {lines: [column('死んでいる。', box(171, 111, 203, 291), [
                ['死ん', 95, box(171, 111, 203, 291)], ['で', 96, box(162, 208, 207, 228)],
                ['いる', 93, box(162, 227, 207, 271)], ['。', 90, box(162, 270, 207, 296)],
            ])]},
            {lines: [column("覚悟しろ'", box(119, 111, 151, 268), [
                ['覚悟', 93, box(119, 111, 151, 268)], ['し', 92, box(104, 221, 155, 235)],
                ['ろ', 93, box(104, 234, 155, 251)], ["'", 8, box(104, 250, 155, 270)],
            ])]},
            // 同一列被切成两段，仍按上下顺序并入同一气泡。
            {lines: [column('今', box(733, 401, 762, 435), [['今', 92, box(733, 401, 762, 435)]])]},
            {lines: [column('日は', box(734, 462, 761, 520), [['日', 96, box(736, 462, 760, 487)], ['は', 93, box(734, 491, 761, 520)]])]},
            {lines: [column('楽しい', box(689, 401, 716, 500), [['楽しい', 95, box(689, 401, 716, 500)]])]},
            {lines: [{text: '第三話', bbox: box(61, 58, 137, 82), baseline: box(61, 82, 137, 82), words: [
                {text: '第', confidence: 92, bbox: box(61, 58, 85, 82)}, {text: '三話', confidence: 93, bbox: box(96, 58, 137, 82)},
            ]}]},
        ]}];
        expect(normalizeOcrLines(blocks)).toEqual([
            {text: 'お前はもう死んでいる。覚悟しろ', bbox: box(104, 111, 258, 296), vertical: true},
            {text: '今日は楽しい', bbox: box(689, 401, 762, 520), vertical: true},
            {text: '第三話', bbox: box(61, 58, 137, 82)},
        ]);
        // 单独一列同样标记为竖排，只有 word 数据缺失时回退整行文本。
        expect(normalizeOcrLines([{paragraphs: [{lines: [{text: 'ドキドキ', bbox: box(27, 14, 74, 245), baseline: box(30, 14, 31, 245)}]}]}]))
            .toEqual([{text: 'ドキドキ', bbox: box(27, 14, 74, 245), vertical: true}]);
        // 两个相隔很远的竖排气泡各自保持原列，不应被合并成一条译文。
        expect(normalizeOcrLines([{paragraphs: [{lines: [
            column('右边', box(600, 20, 630, 130), []),
            column('左边', box(100, 20, 130, 130), []),
        ]}]}])).toEqual([
            {text: '右边', bbox: box(600, 20, 630, 130), vertical: true},
            {text: '左边', bbox: box(100, 20, 130, 130), vertical: true},
        ]);
    });

    it('乱序竖列经后到的桥接列连接后，保留首个原始位置与从右到左的整段顺序', () => {
        const columns = [0, 5, 4, 3, 2, 1].map((position, index) => ({text: String.fromCharCode(65 + index),
            bbox: {x0: position * 100, x1: position * 100 + 60, y0: 0, y1: 100},
            baseline: {x0: position * 100, x1: position * 100, y0: 0, y1: 100}}));
        const input = [{paragraphs: [{lines: columns}]}];
        const before = structuredClone(input);
        expect(normalizeOcrLines(input)).toEqual([{text: 'B C D E F A', bbox: {x0: 0, y0: 0, x1: 560, y1: 100}, vertical: true}]);
        expect(input).toEqual(before);
    });

    it('只接受支持的语言包并去重，保证下载状态可持久化', () => {
        expect(normalizeImageOcrLanguageCodes(['eng', 'jpn', 'eng', 'unsupported', null])).toEqual(['eng', 'jpn']);
        expect(normalizeImageOcrLanguageCodes(['chi_tra', 'eng', 'chi_tra'])).toEqual(['chi_tra', 'eng']);
        expect(normalizeImageOcrLanguageCodes(['spa', 'eng', 'spa'])).toEqual(['spa', 'eng']);
        expect(normalizeImageOcrLanguageCodes('eng')).toEqual([]);
    });

    it('过滤空 OCR 行并保留文本框', () => {
        expect(normalizeOcrLines(null)).toEqual([]);
        expect(normalizeOcrLines([{paragraphs: undefined}, {paragraphs: [{lines: undefined}]}])).toEqual([]);
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [
                        { text: ' Hello   world ', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } },
                        { text: '   ', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } },
                    ],
                }],
            } as never,
        ]);

        expect(lines).toEqual([{ text: 'Hello world', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } }]);
    });

    it('不为微软原样返回的 OCR 行生成翻译覆盖层', () => {
        const lines = [
            { text: '中文标题', bbox: { x0: 0, y0: 0, x1: 40, y1: 12 } },
            { text: 'Hello world', bbox: { x0: 0, y0: 20, x1: 80, y1: 32 } },
            { text: 'Missing translation', bbox: { x0: 0, y0: 40, x1: 80, y1: 52 } },
        ];

        expect(selectChangedTranslations(lines, ['中文标题', '你好世界'])).toEqual([{
            text: '你好世界',
            bbox: { x0: 0, y0: 20, x1: 80, y1: 32 },
        }]);
    });

    it('优先使用紧凑的 OCR word 框，避免整行控件被合并成一个大框', () => {
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [{
                        text: 'ignored wide line',
                        bbox: { x0: 0, y0: 0, x1: 200, y1: 30 },
                        words: [
                            { text: 'Translate', confidence: 90, bbox: { x0: 20, y0: 8, x1: 75, y1: 20 } },
                            { text: 'the', confidence: 90, bbox: { x0: 80, y0: 8, x1: 100, y1: 20 } },
                            { text: 'following', confidence: 90, bbox: { x0: 106, y0: 8, x1: 164, y1: 20 } },
                            { text: 'button', confidence: 90, bbox: { x0: 240, y0: 8, x1: 280, y1: 20 } },
                        ],
                    }],
                }],
            },
        ]);

        expect(lines).toEqual([
            { text: 'Translate the following', bbox: { x0: 20, y0: 8, x1: 164, y1: 20 } },
            { text: 'button', bbox: { x0: 240, y0: 8, x1: 280, y1: 20 } },
        ]);
    });

    it('过滤低置信度和无效 word，并按 CJK 连写规则合并同一行', () => {
        const lines = normalizeOcrLines([
            {
                paragraphs: [{
                    lines: [{
                        text: 'ignored',
                        bbox: { x0: 0, y0: 0, x1: 80, y1: 20 },
                        words: [
                            { text: ' 你 ', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
                            { text: ' 好 ', confidence: 90, bbox: { x0: 11, y0: 0, x1: 21, y1: 10 } },
                            { text: 'bad', confidence: 10, bbox: { x0: 22, y0: 0, x1: 32, y1: 10 } },
                            { text: 'flat', confidence: 90, bbox: { x0: 33, y0: 0, x1: 33, y1: 10 } },
                        ],
                    }],
                }],
            },
        ]);

        expect(lines).toEqual([
            {text: '你好', bbox: {x0: 0, y0: 0, x1: 21, y1: 10}},
        ]);
    });

    it('对无效输入原样复制，并为无法扩散的整图遮罩保留原像素', () => {
        const source = new Uint8ClampedArray([12, 34, 56, 255]);
        const line = {text: 'x', bbox: {x0: 0, y0: 0, x1: 1, y1: 1}};

        expect(inpaintTextRegions(source, 0, 1, [line])).toEqual(source);
        expect(inpaintTextRegions(source, 1, 0, [line])).toEqual(source);
        expect(inpaintTextRegions(new Uint8ClampedArray([1, 2, 3]), 1, 1, [line])).toEqual(new Uint8ClampedArray([1, 2, 3]));
        expect(inpaintTextRegions(source, 1, 1, [])).toEqual(source);
        expect(inpaintTextRegions(source, 1, 1, [line])).toEqual(source);
    });

    it('从 OCR 框外围选择主背景色并自动选择可读文字颜色', () => {
        const pixels = new Uint8ClampedArray(3 * 3 * 4);
        for (let index = 0; index < pixels.length; index += 4) {
            pixels[index] = 245;
            pixels[index + 1] = 245;
            pixels[index + 2] = 245;
            pixels[index + 3] = 255;
        }
        // 放入一个少数深色像素，确保主色选择不会被单个噪点覆盖。
        pixels[0] = 16;
        pixels[1] = 16;
        pixels[2] = 16;

        expect(getImageTextBackgroundColor(pixels, 3, 3, {x0: 1, y0: 1, x1: 2, y1: 2}))
            .toBe('rgb(240,240,240)');
        expect(getImageTextBackgroundColor(new Uint8ClampedArray(), 0, 0, {x0: 0, y0: 0, x1: 0, y1: 0}))
            .toBe('rgb(255,255,255)');
        expect(getImageTextColor('rgb(240,240,240)')).toBe('#111827');
        expect(getImageTextColor('rgb(16,16,16)')).toBe('#ffffff');
        expect(getImageTextColor('invalid')).toBe('#111827');
    });

    it('用周边像素修复文字区域，而不是用整块纯色覆盖', () => {
        const width = 9;
        const height = 5;
        const source = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const offset = (y * width + x) * 4;
                source[offset] = x * 20;
                source[offset + 1] = y * 30;
                source[offset + 2] = 100;
                source[offset + 3] = 255;
            }
        }
        // 模拟文字像素：修复后不应继续保留这个明显的黑色残影。
        const textPixel = (2 * width + 4) * 4;
        source[textPixel] = 0;
        source[textPixel + 1] = 0;
        source[textPixel + 2] = 0;
        const result = inpaintTextRegions(source, width, height, [{
            text: 'text',
            bbox: { x0: 3, y0: 1, x1: 6, y1: 4 },
        }]);

        const centre = textPixel;
        expect(result[centre]).toBeGreaterThan(source[centre]);
        expect(result[centre + 1]).toBeGreaterThan(source[centre + 1]);
        expect(result[centre + 2]).toBe(100);
        expect(result[centre + 3]).toBe(255);
    });
});

describe('漫画数字证据：OCR 规范化', () => {
    const bbox={x0:10,y0:10,x1:80,y1:30};
    const normalized=(text:string, words:Array<{text:string;confidence?:number;bbox:typeof bbox}>,confidence?:number) =>
        normalizeOcrLines([{paragraphs:[{lines:[{text,bbox,words,...(confidence===undefined?{}:{confidence})}]}]}],true);
    it('仅按原始显式词置信记录，不改变普通 OCR 返回结构',()=>{
        const blocks=[{paragraphs:[{lines:[{text:'12:34',bbox,words:[{text:'12:34',bbox,confidence:97}]}]}]}];
        expect(normalizeOcrLines(blocks)).toEqual([{text:'12:34',bbox}]);
        expect(normalizeOcrLines(blocks,true)).toEqual([{text:'12:34',bbox,numericConfidence:97}]);
    });
    it.each([undefined,NaN,Infinity,-1,101])('缺失或无效词置信 %s 不创建数字证据',confidence=>{
        const result=normalized('12:34',[{text:'12:34',bbox,confidence}]);
        if(result.length) expect(result[0]).not.toHaveProperty('numericConfidence');
    });
    it('同一行多个词采用最低可靠度，显式行级置信更低时也不能抬高',()=>{
        const words=[{text:'₩',bbox:{x0:10,y0:10,x1:20,y1:30},confidence:97},{text:'12,000',bbox:{x0:21,y0:10,x1:80,y1:30},confidence:91}];
        expect(normalized('₩12,000',words)[0]).toMatchObject({text:'₩ 12,000',numericConfidence:91});
        expect(normalized('₩12,000',words,89)[0]).toMatchObject({numericConfidence:89});
        expect(normalized('₩12,000',[words[0],{...words[1],confidence:undefined}])[0]).not.toHaveProperty('numericConfidence');
    });
    it('低置信词、坏框或行文字与词序不一致均不能把残片升级成可信数字',()=>{
        const a={text:'12',bbox:{x0:10,y0:10,x1:25,y1:30},confidence:97};
        for(const b of [{text:'.34',bbox:{x0:26,y0:10,x1:80,y1:30},confidence:24},{text:'.34',bbox:{x0:26,y0:10,x1:26,y1:30},confidence:97}]) {
            const line=normalized('12.34',[a,b]);expect(line[0]).not.toHaveProperty('numericConfidence');
        }
        expect(normalized('12.34',[a])[0]).not.toHaveProperty('numericConfidence');
    });
    it('没有词对象时只接受显式有效行置信，不将缺失值默认为证据',()=>{
        const lines=[{text:'09:15',bbox,words:[],confidence:93},{text:'09:16',bbox:{...bbox,y0:40,y1:60},words:[]}];
        const result=normalizeOcrLines([{paragraphs:[{lines}]}],true);
        expect(result[0]).toMatchObject({numericConfidence:93});expect(result[1]).not.toHaveProperty('numericConfidence');
    });
    it('完全重叠重复结果只要任何副本没有可信证据就不能升级，顺序不影响',()=>{
        const high={text:'12:34',bbox,words:[{text:'12:34',bbox,confidence:97}]};
        const unknown={text:'12:34',bbox,words:[{text:'12:34',bbox}]};
        for(const lines of [[high,unknown],[unknown,high]]) {
            const result=normalizeOcrLines([{paragraphs:[{lines}]}],true);
            expect(result).toHaveLength(1);expect(result[0]).not.toHaveProperty('numericConfidence');
        }
    });
    it('同文重叠数字保守并入全部检测框且与输入顺序无关',()=>{
        const first={text:'12:34',bbox,words:[{text:'12:34',bbox,confidence:97}]};
        const shifted={x0:11,y0:10,x1:81,y1:30};
        const second={text:'12:34',bbox:shifted,words:[{text:'12:34',bbox:shifted,confidence:94}]};
        for(const lines of [[first,second],[second,first]]){
            const result=normalizeOcrLines([{paragraphs:[{lines}]}],true);
            expect(result).toMatchObject([{bbox:{x0:10,y0:10,x1:81,y1:30},numericConfidence:94}]);
            expect(normalizeOcrLines([{paragraphs:[{lines}]}])[0].bbox).toEqual(lines[0].bbox);
        }
    });
    it('重复数字有一份低于阈值时按较低分数保守保留',()=>{
        const make=(confidence:number)=>({text:'12:34',bbox,words:[{text:'12:34',bbox,confidence}]});
        for(const lines of [[make(94),make(80)],[make(80),make(94)]])
            expect(normalizeOcrLines([{paragraphs:[{lines}]}],true)).toMatchObject([{numericConfidence:80}]);
    });
    it('漫画视图不把相邻独立数字拼成未经识别的新数字',()=>{
        const a={text:'12',bbox:{x0:70,y0:10,x1:90,y1:70},baseline:{x0:80,y0:10,x1:81,y1:70},words:[{text:'12',bbox:{x0:70,y0:10,x1:90,y1:70},confidence:98}]};
        const b={text:'34',bbox:{x0:45,y0:10,x1:65,y1:70},baseline:{x0:55,y0:10,x1:56,y1:70},words:[{text:'34',bbox:{x0:45,y0:10,x1:65,y1:70},confidence:99}]};
        const result=normalizeOcrLines([{paragraphs:[{lines:[a,b]}]}],true);
        expect(result).toHaveLength(2);expect(result.map(row=>row.text)).toEqual(['12','34']);
        expect(normalizeOcrLines([{paragraphs:[{lines:[a,b]}]}])).toHaveLength(1);
    });
    it('不同顺序与缺失置信的竖排文字都不吸收独立数字',()=>{
        const make=(text:string,x:number,confidence?:number)=>{const bbox={x0:x,y0:10,x1:x+20,y1:70};return {text,bbox,baseline:{x0:x+10,y0:10,x1:x+11,y1:70},words:[{text,bbox,confidence}]};};
        const number=make('12:34',70,98),label=make('你好',45),confident=make('世界',20,98);
        for(const lines of [[number,label,confident],[confident,label,number]]){
            const result=normalizeOcrLines([{paragraphs:[{lines}]}],true);
            expect(result.find(row=>row.text==='12:34')).toMatchObject({numericConfidence:98});
        }
    });
    it('数字经符号桥接也不能与竖排对白合列',()=>{
        const make=(text:string,x:number,confidence:number)=>{const bbox={x0:x,y0:10,x1:x+20,y1:70};return {text,bbox,baseline:{x0:x+10,y0:10,x1:x+11,y1:70},words:[{text,bbox,confidence}]};};
        const a=make('12:34',100,98),b=make('1',75,98),c=make('你好',50,98);
        for(const lines of [[a,b,c],[c,b,a],[b,a,c]]){
            const result=normalizeOcrLines([{paragraphs:[{lines}]}],true);
            expect(result.find(row=>row.text==='12:34')).toMatchObject({numericConfidence:98});
            expect(result.some(row=>row.text.includes('12:34')&&row.text.includes('你好'))).toBe(false);
        }
    });
});
