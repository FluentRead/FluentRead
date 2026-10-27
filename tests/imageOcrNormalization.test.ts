import {describe, expect, it} from 'vitest';
import {groupImageParagraphs, type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {endsEastAsianText, startsEastAsianText} from '@/src/features/image-translation/textBoundary';
import bambuLines from './fixtures/image-translation/bambu-ocr-lines.json';
import {
    getOcrImageSize,
    getAreaOcrImageSize,
    normalizeOcrLines,
    restoreOcrLineCoordinates,
    selectChangedTranslations,
} from '@/src/features/image-translation/core';
import {getMangaOcrEngine, getRequiredImageOcrLanguages} from '@/src/features/image-translation/ocrLanguages';

describe('普通图片按完整段落翻译', () => {
    const line = (text: string, x0: number, y0: number, width = 200, h = 12): ImageTextRegion =>
        ({text, bbox: {x0, y0, x1: x0 + width, y1: y0 + h}});

    it('东亚边界只逆向读取完整码点及选择符，不把孤立标记或 emoji 当作续行文字', () => {
        for (const text of ['漢', '𠀀\u{E0100}', 'あ\uFE0E', 'ｶﾞ', 'ｶﾞ\uFE0F', '。', '한국어', '字'+'\u{E0100}'.repeat(32)])
            expect(endsEastAsianText(text), text).toBe(true);
        for (const text of ['', '\uFE0F', '\u{E0100}', '\uFE0F\u{E0100}', 'A', '😀\uFE0F', '㊙\uFE0F', '〽\uFE0E', '。\uFE0E', '字'+'\u{E0100}'.repeat(33), 'ﾞ', 'Aﾞ', '\uD800', '\uDC00'])
            expect(endsEastAsianText(text), text).toBe(false);
        expect(endsEastAsianText('。\uFE00')).toBe(true);
        expect(endsEastAsianText('、\uFE01')).toBe(true);
        expect(endsEastAsianText('字'+'\u{E0100}'.repeat(1024))).toBe(false);
        for (const text of ['字', '𠀀', '𛀁', 'ｶ', '한글']) expect(startsEastAsianText(text), text).toBe(true);
        for (const text of ['', 'word', '😀', '\uD800', '\uDC00']) expect(startsEastAsianText(text), text).toBe(false);
    });

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
        ["supplementary Han with IVS", "第一𠀀\u{E0100}", "𠀁世界", "第一𠀀\u{E0100}𠀁世界"],
        ["BMP Han with variation selector", "漢\uFE00", "字", "漢\uFE00字"],
        ["halfwidth kana with voiced mark", "こんにちはｶﾞ", "ｷﾞ世界", "こんにちはｶﾞｷﾞ世界"],
        ["supplementary kana", "古い𛀁", "𛀂文字", "古い𛀁𛀂文字"],
        ["halfwidth kana without voiced mark", "あｶ", "ﾅ文字", "あｶﾅ文字"],
        ["Latin", "alpha", "beta", "alpha beta"],
        ["Korean then Latin", "한국어 단어", "words", "한국어 단어 words"],
        ["Latin then Korean", "word", "한글 문장", "word 한글 문장"],
        ["emoji variation then Han", "😀\uFE0F", "字", "😀\uFE0F 字"],
        ["CJK-range emoji presentation then Han", "秘密㊙\uFE0F", "文字", "秘密㊙\uFE0F 文字"],
        ["CJK-range text presentation then Han", "案内〽\uFE0E", "文字", "案内〽\uFE0E 文字"],
        ["kana text presentation", "あ\uFE0E", "文字", "あ\uFE0E文字"],
        ["halfwidth voiced kana with variation selector", "ｶﾞ\uFE0F", "文字", "ｶﾞ\uFE0F文字"],
        ["CJK punctuation with text selector retains prior boundary", "案内。\uFE0E", "文字", "案内。\uFE0E 文字"],
        ["standardized Japanese full stop variation", "案内。\uFE00", "文字", "案内。\uFE00文字"],
        ["standardized Japanese comma variation", "案内、\uFE01", "文字", "案内、\uFE01文字"],
        ["Japanese punctuation before supplementary kana", "日本語。", "𛀂文字", "日本語。𛀂文字"],
        ["Korean continuation keeps existing boundary", "한국어", "문장", "한국어문장"],
        ["Han with IVS then emoji", "𠀀\u{E0100}", "😀", "𠀀\u{E0100} 😀"],
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

    it('竖排续列保留扩展字符和逐列来源框，不改变输入或列序', () => {
        const right = {...line('𠀀\u{E0100}', 90, 20, 12, 100), vertical: true as const};
        const left = {...line('ｶﾞ𛀁', 76, 21, 12, 99), vertical: true as const};
        const input = [left, right], before = structuredClone(input);
        expect(groupImageParagraphs(input)).toEqual([{
            text: '𠀀\u{E0100}ｶﾞ𛀁', bbox: {x0: 76, y0: 20, x1: 102, y1: 120},
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
