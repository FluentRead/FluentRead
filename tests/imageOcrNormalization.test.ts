import {describe, expect, it} from 'vitest';
import {groupImageParagraphs, type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import bambuLines from './fixtures/image-translation/bambu-ocr-lines.json';
import {
    getOcrImageSize,
    getAreaOcrImageSize,
    normalizeOcrLines,
    restoreOcrLineCoordinates,
    selectChangedTranslations,
} from '@/src/features/image-translation/core';

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
