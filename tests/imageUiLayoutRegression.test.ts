import {describe, expect, it} from 'vitest';
import {
    getOcrLanguages,
    normalizeOcrLines,
    normalizeOcrLineViews,
} from '@/src/features/image-translation/core';
import {groupImageParagraphs, type ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {
    bindImageParagraphGapEvidence,
    createImageParagraphGapConsumer,
    getImageParagraphGapEvidence,
    produceImageParagraphGapProofs,
} from '@/src/features/image-translation/services/imageParagraphGapEvidence';
import {numericInformation, numericProtection} from '@/src/features/image-translation/services/mangaNumeric';
import type {MangaOcrPage} from '@/src/features/image-translation/services/mangaBubbles';

function region(
    text: string,
    x0: number,
    y0: number,
    width: number,
    height = 14,
    extra: Partial<ImageTextRegion> = {},
): ImageTextRegion {
    return {
        text,
        bbox: {x0, y0, x1: x0 + width, y1: y0 + height},
        fontSize: height,
        ...extra,
    };
}

function drawRect(
    pixels: Uint8ClampedArray,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: [number, number, number, number],
) {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            pixels.set(color, (y * width + x) * 4);
        }
    }
}

function drawBorderedRect(
    pixels: Uint8ClampedArray,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fill: [number, number, number, number],
    border: [number, number, number, number],
) {
    drawRect(pixels, width, x0, y0, x1, y1, fill);
    for (let x = x0; x < x1; x++) {
        pixels.set(border, (y0 * width + x) * 4);
        pixels.set(border, ((y1 - 1) * width + x) * 4);
    }
    for (let y = y0; y < y1; y++) {
        pixels.set(border, (y * width + x0) * 4);
        pixels.set(border, (y * width + (x1 - 1)) * 4);
    }
}

function drawInkStripes(
    pixels: Uint8ClampedArray,
    width: number,
    box: {x: number; y: number; width: number; height: number},
    color: [number, number, number, number] = [30, 35, 42, 255],
) {
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x + 2; x < box.x + box.width - 2; x += 4) {
            pixels.set(color, (y * width + x) * 4);
        }
    }
}

function runGapPipeline(page: MangaOcrPage, width: number, height: number, pixels: Uint8ClampedArray) {
    const proofs = produceImageParagraphGapProofs(page, width, height, pixels);
    const withProofs: MangaOcrPage = {...page, imageParagraphGapProofs: proofs};
    const consumer = createImageParagraphGapConsumer(withProofs, width, height);
    const regions: ImageTextRegion[] = withProofs.results.map(item => ({
        text: item.text,
        fontSize: item.box.height,
        bbox: {x0: item.box.x, y0: item.box.y, x1: item.box.x + item.box.width, y1: item.box.y + item.box.height},
    }));
    regions.forEach((line, index) => consumer.record(withProofs.results[index], line));
    consumer.seal(regions);
    bindImageParagraphGapEvidence(regions, 'ui-regression', width, height);
    const support = getImageParagraphGapEvidence(regions, 'ui-regression', width, height);
    return {proofs, regions, support, grouped: groupImageParagraphs(regions, support)};
}

describe('SI / 物理 / 计算计量单位数值保护', () => {
    it.each([
        '4.87 m', '14.75 g', '0.00 m', '0.00 g', '0.20 mm', '12 min', '1h 23m',
        '1h 23m 45s', '12m 30s', '4m32s', '12h45m', '12h50m', '1h23m45s', '100 mm/s', '2.4 kg', '256 MB', '60 Hz',
        '220 V', '65 W', '10 Ω', '10 Ω', '10g', '5m', '30s', '2h', '220V', '65W',
        '10 mm²', '10 mm³', '25 cm²', '12.5 cm³', '1.24 g/cm³',
        '12 cm', '3.5 km', '50 um', '50 µm', '400 nm', '500 mg', '250 ml', '250 mL',
        '16 ms', '50 ns', '20 us', '20 µs', '2 hr', '3 hrs', '45 sec',
        '48 kHz', '2.4 MHz', '3.6 GHz', '500 mW', '1.5 kW', '10 MW',
        '330 mV', '12 kV', '500 mA', '16 px', '12pt', '300 dpi', '400 ppi',
        '60 fps', '3600 rpm', '-3 dB', '64 kB', '128 KB', '16 GB', '2 TB',
        '512 KiB', '256 MiB', '4 GiB', '9.8 m/s', '120 km/h', '65 mph',
        '1.5 L', '2L', '3.3 V', '2.5 A', '5A', '293.15 K', '300K',
        '9.8 N', '50N', '4.2 J', '10J', '4.7 Ω', '8Ω', '1.5 s', '2.5 h', '65.5 W',
    ])('识别精确计量数值 %s 为受保护数字信息', text => {
        expect(numericInformation(text)).toBe(true);
        expect(numericProtection(text)).toBe(true);
    });

    it.each([
        '2 in stock', '3 to 5', '1 a day', 'Layer 2', 'Page 1 of 3', '5 items',
        '10 m', '5 g', '30 s', '2 h', '2 A', '1 L', '5 N', '10 J', '300 K',
        '4.87 M', '14.75 G', '10G', '30S', '220 v', '65 w', '256 mb', '60 hz', '12 MIN',
        '1²', '2³', '²³', '1h 60m', '12m 99s',
    ])('不把英文正文、错误大小写或无单位上标 %s 误判为计量数值', text => {
        expect(numericInformation(text)).toBe(false);
        expect(numericProtection(text)).toBe(false);
    });
});

describe('Tesseract 横排合词收紧与低置信中间符号边界', () => {
    it('被过滤的低置信下拉箭头 v 或分栏竖线 | 阻止同行相邻词跨控件合并', () => {
        const chevronLine = [{
            paragraphs: [{
                lines: [{
                    text: 'to v End',
                    bbox: {x0: 100, y0: 20, x1: 165, y1: 34},
                    words: [
                        {text: 'to', confidence: 95, bbox: {x0: 100, y0: 20, x1: 118, y1: 34}},
                        {text: 'v', confidence: 12, bbox: {x0: 122, y0: 24, x1: 130, y1: 30}},
                        {text: 'End', confidence: 95, bbox: {x0: 136, y0: 20, x1: 165, y1: 34}},
                    ],
                }],
            }],
        }];
        const chevronViews = normalizeOcrLineViews(chevronLine);
        expect(chevronViews.ordinary.map(line => line.text)).toEqual(['to', 'End']);
        expect(chevronViews.manga.map(line => line.text)).toEqual(['to', 'End']);

        const pipeLine = [{
            paragraphs: [{
                lines: [{
                    text: 'Filament | Model',
                    bbox: {x0: 20, y0: 20, x1: 135, y1: 34},
                    words: [
                        {text: 'Filament', confidence: 96, bbox: {x0: 20, y0: 20, x1: 80, y1: 34}},
                        {text: '|', confidence: 15, bbox: {x0: 86, y0: 18, x1: 88, y1: 36}},
                        {text: 'Model', confidence: 96, bbox: {x0: 94, y0: 20, x1: 135, y1: 34}},
                    ],
                }],
            }],
        }];
        expect(normalizeOcrLineViews(pipeLine).ordinary.map(line => line.text)).toEqual(['Filament', 'Model']);
    });

    it('非数值横排词距收紧至 1.8 倍行高，仅数值/时间语法保留 4 倍宽距并忽略非同行低置信噪声', () => {
        // 高度 14，间距 30 > 14 * 1.8 = 25.2 -> 跨列保持独立；间距 12 <= 25.2 -> 正常合词。
        const wideColumns = [{
            paragraphs: [{
                lines: [{
                    text: 'Plate type Default',
                    bbox: {x0: 20, y0: 20, x1: 200, y1: 34},
                    words: [
                        {text: 'Plate', confidence: 96, bbox: {x0: 20, y0: 20, x1: 55, y1: 34}},
                        {text: 'type', confidence: 96, bbox: {x0: 63, y0: 20, x1: 95, y1: 34}},
                        {text: 'Default', confidence: 96, bbox: {x0: 125, y0: 20, x1: 180, y1: 34}},
                    ],
                }],
            }],
        }];
        expect(normalizeOcrLineViews(wideColumns).ordinary.map(line => line.text)).toEqual(['Plate type', 'Default']);

        // 非同行或不在中间的低置信词，以及重叠词，不影响正常合词。
        const nonIntervening = [{
            paragraphs: [{
                lines: [{
                    text: 'Hello world',
                    bbox: {x0: 20, y0: 20, x1: 120, y1: 34},
                    words: [
                        {text: 'noise', confidence: 10, bbox: {x0: 62, y0: 60, x1: 66, y1: 68}},
                        {text: 'leftNoise', confidence: 10, bbox: {x0: 5, y0: 20, x1: 10, y1: 34}},
                        {text: 'Hello', confidence: 96, bbox: {x0: 20, y0: 20, x1: 60, y1: 34}},
                        {text: 'world', confidence: 96, bbox: {x0: 68, y0: 20, x1: 112, y1: 34}},
                        {text: '!', confidence: 96, bbox: {x0: 110, y0: 20, x1: 118, y1: 34}},
                    ],
                }],
            }],
        }];
        expect(normalizeOcrLineViews(nonIntervening).ordinary.map(line => line.text)).toEqual(['Hello world!']);

        // 行内时间语法 12:30 + PM 仍保留 4 倍行高阈值（高度 10，间距 25 <= 40）。
        const inlineTime = [{
            paragraphs: [{
                lines: [{
                    text: 'Starts 12:30 PM',
                    bbox: {x0: 10, y0: 20, x1: 150, y1: 30},
                    words: [
                        {text: 'Starts', confidence: 95, bbox: {x0: 10, y0: 20, x1: 45, y1: 30}},
                        {text: '12:30', confidence: 95, bbox: {x0: 52, y0: 20, x1: 82, y1: 30}},
                        {text: 'PM', confidence: 95, bbox: {x0: 107, y0: 20, x1: 125, y1: 30}},
                    ],
                }],
            }],
        }];
        expect(normalizeOcrLineViews(inlineTime).ordinary.map(line => line.text)).toEqual(['Starts 12:30 PM']);
    });

    it('竖排多词与同列纵向片段仍按原规则合列，且 OCR 语言助手返回预期语言包', () => {
        const verticalLine = [{
            paragraphs: [{
                lines: [
                    {
                        text: 'あいう',
                        bbox: {x0: 60, y0: 20, x1: 74, y1: 120},
                        baseline: {x0: 67, y0: 20, x1: 67, y1: 120},
                        words: [
                            {text: 'あ', confidence: 95, bbox: {x0: 60, y0: 20, x1: 74, y1: 40}},
                            {text: 'x', confidence: 10, bbox: {x0: 60, y0: 44, x1: 74, y1: 50}},
                            {text: 'い', confidence: 95, bbox: {x0: 60, y0: 55, x1: 74, y1: 75}},
                        ],
                    },
                    {
                        text: 'う',
                        bbox: {x0: 60, y0: 85, x1: 74, y1: 105},
                        baseline: {x0: 67, y0: 85, x1: 67, y1: 105},
                        words: [{text: 'う', confidence: 95, bbox: {x0: 60, y0: 85, x1: 74, y1: 105}}],
                    },
                ],
            }],
        }];
        expect(normalizeOcrLines(verticalLine)).toMatchObject([{text: 'あいう', vertical: true}]);
        expect(getOcrLanguages('en')).toEqual(['eng']);

        // 三个相互邻接竖列与同页横排行共存时，合并成单气泡并保留横排行。
        const mixedCluster = [{
            paragraphs: [{
                lines: [
                    {text: '水平标题', bbox: {x0: 10, y0: 10, x1: 90, y1: 26}},
                    {text: '一', bbox: {x0: 120, y0: 40, x1: 134, y1: 70}, baseline: {x0: 127, y0: 40, x1: 127, y1: 70}},
                    {text: '二', bbox: {x0: 120, y0: 76, x1: 134, y1: 106}, baseline: {x0: 127, y0: 76, x1: 127, y1: 106}},
                    {text: '三', bbox: {x0: 104, y0: 45, x1: 118, y1: 100}, baseline: {x0: 111, y0: 45, x1: 111, y1: 100}},
                ],
            }],
        }];
        expect(normalizeOcrLines(mixedCluster).map(l => l.text)).toEqual(['水平标题', '一二三']);
    });
});

describe('设置表单与锐角矩形弹窗的像素间隙分离', () => {
    function buildSettingsDialog(options: {
        withBubble?: boolean;
        darkHeaderBar?: boolean;
        tightGap?: boolean;
        leftWidgets?: boolean;
        numericPeers?: boolean;
        touchingPeers?: boolean;
        midGapBorder?: boolean;
        plainTwoColumn?: boolean;
        ellipticalBubble?: boolean;
    } = {}) {
        const width = 520, height = 240;
        const pixels = new Uint8ClampedArray(width * height * 4);
        drawRect(pixels, width, 0, 0, width, height, [220, 224, 230, 255]);
        const dialogBg: [number, number, number, number] = [255, 255, 255, 255];
        if (options.ellipticalBubble) {
            for (let y = 10; y < 220; y++) {
                for (let x = 10; x < 510; x++) {
                    if (((x - 260) / 245) ** 2 + ((y - 115) / 100) ** 2 <= 1) {
                        pixels.set(dialogBg, (y * width + x) * 4);
                    }
                }
            }
        } else {
            drawRect(pixels, width, 10, 10, 510, 220, dialogBg);
        }
        if (options.darkHeaderBar) {
            drawRect(pixels, width, 10, 10, 510, 15, [45, 50, 58, 255]);
        }

        const gap = options.tightGap ? 11 : 22;
        const y1 = options.ellipticalBubble ? 62 : 44, y2 = y1 + 14 + gap, y3 = y2 + 14 + gap;
        const labelX = options.leftWidgets ? 260 : options.ellipticalBubble ? 110 : 36;
        const peerX = options.leftWidgets ? 40 : 250;

        const labels = options.tightGap || options.touchingPeers
            ? [
                {text: 'Plate type', confidence: 0.99, box: {x: labelX, y: y1, width: 76, height: 14}},
                {text: 'Spiral vase', confidence: 0.99, box: {x: labelX, y: y2, width: 78, height: 14}},
            ]
            : [
                {text: 'Plate type', confidence: 0.99, box: {x: labelX, y: y1, width: 74, height: 14}},
                {text: 'Print sequence', confidence: 0.99, box: {x: labelX, y: y2, width: 96, height: 14}},
                {text: 'Spiral vase', confidence: 0.99, box: {x: labelX, y: y3, width: 78, height: 14}},
            ];

        const peerTexts = options.numericPeers
            ? ['4.87 m', '14.75 g', '0.00 m']
            : ['Same as Global Plate Type', 'Same as Global Print Sequence', 'Same as Global'];

        const peers = labels.map((label, index) => {
            const box = options.touchingPeers
                ? {x: peerX, y: index === 0 ? y1 : y1 + 14, width: options.leftWidgets ? 170 : 210, height: index === 0 ? 14 : 14 + gap}
                : {x: peerX, y: label.box.y, width: options.leftWidgets ? 170 : 210, height: 14};
            return {text: peerTexts[index], confidence: 0.99, box};
        });

        for (const item of labels) drawInkStripes(pixels, width, item.box);
        for (const [index, peer] of peers.entries()) {
            if (!options.plainTwoColumn && !options.numericPeers) {
                if (options.midGapBorder) {
                    drawRect(pixels, width, peer.box.x - 10, peer.box.y - 2, peer.box.x + peer.box.width + 10, peer.box.y + peer.box.height + 2, dialogBg);
                    if (index < peers.length - 1) {
                        const midY = peer.box.y + peer.box.height + Math.floor(gap / 2);
                        drawRect(pixels, width, peer.box.x - 10, midY, peer.box.x + peer.box.width + 10, midY + 1, [190, 194, 200, 255]);
                    }
                } else {
                    drawBorderedRect(
                        pixels,
                        width,
                        peer.box.x - 12,
                        peer.box.y - 4,
                        peer.box.x + peer.box.width + 12,
                        peer.box.y + peer.box.height + 4,
                        [246, 248, 250, 255],
                        [185, 190, 198, 255],
                    );
                }
            }
            drawInkStripes(pixels, width, peer.box);
        }

        // 附加远处插画使单框 matte 失败或侧窗失败以触发 flat-owner / tight-field 路径。
        if (options.withBubble && (options.numericPeers || options.plainTwoColumn || options.ellipticalBubble || options.midGapBorder)) {
            drawRect(pixels, width, 16, y1 + 2, 24, y1 + 10, [30, 35, 42, 255]);
        }

        const page: MangaOcrPage = {
            results: [...labels, ...peers],
            ...(options.withBubble ? {bubbles: [{bbox: {x0: 10, y0: 10, x1: 510, y1: 220}, results: []}]} : {}),
        };
        return {page, width, height, pixels, labels, peers};
    }

    it('设置表单左列标签在无气泡和锐角矩形气泡下均被右列带边框下拉框阻断，不纵向合并', () => {
        const plainDialog = buildSettingsDialog({withBubble: false});
        const plainOut = runGapPipeline(plainDialog.page, plainDialog.width, plainDialog.height, plainDialog.pixels);
        expect(plainOut.proofs).toEqual([]);
        expect(plainOut.grouped.map(r => r.text)).toEqual([
            'Plate type', 'Same as Global Plate Type',
            'Print sequence', 'Same as Global Print Sequence',
            'Spiral vase', 'Same as Global',
        ]);

        const rectBubble = buildSettingsDialog({withBubble: true});
        const rectOut = runGapPipeline(rectBubble.page, rectBubble.width, rectBubble.height, rectBubble.pixels);
        expect(rectOut.proofs).toEqual([]);
        expect(rectOut.grouped).toHaveLength(6);
    });

    it('顶栏非纯色但密度超 0.92 的矩形弹窗、居中紧邻行 tight-field、左侧控件、行间中线与受保护数字同行均否决合段', () => {
        for (const variant of [
            {withBubble: true, darkHeaderBar: true},
            {withBubble: false, tightGap: true},
            {withBubble: true, leftWidgets: true},
            {withBubble: true, numericPeers: true},
            {withBubble: true, midGapBorder: true},
            {withBubble: true, touchingPeers: true},
        ]) {
            const fixture = buildSettingsDialog(variant);
            const proofs = produceImageParagraphGapProofs(fixture.page, fixture.width, fixture.height, fixture.pixels);
            expect(proofs, JSON.stringify(variant)).toEqual([]);
        }
    });

    it('远距无关行不裁剪候选行的左右探测窗口；曲边漫画气泡和无边框双栏正文仍允许续行', () => {
        // 远距行位于 y=170，不影响 y=40..88 候选对的左右探测范围。
        const width = 320, height = 220;
        const pixels = new Uint8ClampedArray(width * height * 4);
        drawRect(pixels, width, 0, 0, width, height, [255, 255, 255, 255]);
        const page: MangaOcrPage = {
            results: [
                {text: 'FIRST LINE', confidence: 0.99, box: {x: 40, y: 40, width: 80, height: 14}},
                {text: 'SECOND LINE', confidence: 0.99, box: {x: 40, y: 74, width: 80, height: 14}},
                // 远距右侧同行不阻挡，但同带内的右控件边框位于 x=200，必须仍被看到。
                {text: 'FAR FOOTER', confidence: 0.99, box: {x: 150, y: 175, width: 80, height: 14}},
            ],
        };
        for (const item of page.results) drawInkStripes(pixels, width, item.box);
        drawBorderedRect(pixels, width, 195, 36, 260, 60, [240, 242, 245, 255], [160, 165, 175, 255]);
        expect(produceImageParagraphGapProofs(page, width, height, pixels)).toEqual([]);

        // 曲边椭圆形漫画气泡与无边框纯正文双栏仍可续行。
        const oval = buildSettingsDialog({withBubble: true, ellipticalBubble: true});
        expect(produceImageParagraphGapProofs(oval.page, oval.width, oval.height, oval.pixels).length).toBeGreaterThan(0);

        const plainTwoCol = buildSettingsDialog({withBubble: true, plainTwoColumn: true});
        expect(produceImageParagraphGapProofs(plainTwoCol.page, plainTwoCol.width, plainTwoCol.height, plainTwoCol.pixels).length).toBeGreaterThan(0);

        // 重叠但左右均未对齐的对端与紧贴 3px 的对端仍按真实像素判断，不误触发或越界。
        const overlapPeers = buildSettingsDialog({withBubble: true, plainTwoColumn: true});
        overlapPeers.peers[0].box.x = 250; overlapPeers.peers[0].box.width = 160;
        overlapPeers.peers[1].box.x = 270; overlapPeers.peers[1].box.width = 100;
        overlapPeers.peers[2].box.x = 390; overlapPeers.peers[2].box.width = 50;
        // 紧贴标签（间隔 3px）使水平 gutter 宽度 <= 0，覆盖无水平 gutter 分支。
        const tightPeer = buildSettingsDialog({withBubble: true, plainTwoColumn: true});
        tightPeer.labels.pop(); tightPeer.peers.pop();
        tightPeer.labels[1].box.width = tightPeer.labels[0].box.width;
        tightPeer.page.results = [...tightPeer.labels, ...tightPeer.peers];
        const tightX = tightPeer.labels[0].box.x + tightPeer.labels[0].box.width + 3;
        tightPeer.peers[0].box.x = tightX; tightPeer.peers[1].box.x = tightX;
        tightPeer.peers[0].box.width = 90; tightPeer.peers[1].box.width = 90;
        // 无气泡图片模式（bubbles: []）下：多行换行卡片正文（左侧有图标阻断侧窗、行距 1.0x <= 1.2x）仍可通过 flat-owner 续行合段，
        // 而同样 bubbles: [] 的设置表单（同行右列有带边框下拉框、行距 1.0x）仍被否决。
        for (const bg of [[255, 255, 255, 255], [32, 36, 42, 255]] as Array<[number, number, number, number]>) {
            const ink: [number, number, number, number] = bg[0] > 128 ? [25, 30, 38, 255] : [230, 236, 244, 255];
            const cardW = 420, cardH = 180;
            const cardPixels = new Uint8ClampedArray(cardW * cardH * 4);
            drawRect(cardPixels, cardW, 0, 0, cardW, cardH, bg);
            // 卡片左侧状态图标破坏单行侧窗清晰性，迫使进入 flat-owner 路径。
            drawRect(cardPixels, cardW, 20, 42, 34, 56, [40, 120, 220, 255]);
            const cardPage: MangaOcrPage = {
                bubbles: [],
                results: [
                    {text: 'Calculate the best filament grouping', confidence: 0.99, box: {x: 48, y: 40, width: 250, height: 14}},
                    {text: 'to minimize waste across spools', confidence: 0.99, box: {x: 48, y: 68, width: 220, height: 14}},
                    {text: 'during multi-color printing.', confidence: 0.99, box: {x: 48, y: 96, width: 180, height: 14}},
                ],
            };
            for (const item of cardPage.results) drawInkStripes(cardPixels, cardW, item.box, ink);
            const cardOut = runGapPipeline(cardPage, cardW, cardH, cardPixels);
            expect(cardOut.proofs).toHaveLength(2);
            expect(cardOut.proofs.some(p => p.mode === 'flat-owner')).toBe(true);
            expect(cardOut.grouped.map(r => r.text)).toEqual([
                'Calculate the best filament grouping to minimize waste across spools during multi-color printing.',
            ]);
        }

        // 无气泡图片模式（bubbles: []）下的设置表单（行距 1.0x <= 1.2x 且非居中，进入 flat-owner）仍被同行带边框下拉框否决。
        const noBubbleForm = buildSettingsDialog({withBubble: false});
        noBubbleForm.page.bubbles = [];
        // 将行距调整为 14px（1.0x <= 1.2x），且左右宽度差 > 0.3*14 避免触发 tight-field，直接命中 flat-owner 无气泡否决。
        noBubbleForm.labels[1].box.y = 72;
        noBubbleForm.labels[2].box.y = 100;
        noBubbleForm.peers[1].box.y = 72;
        noBubbleForm.peers[2].box.y = 100;
        drawRect(noBubbleForm.pixels, noBubbleForm.width, 10, 10, 510, 220, [255, 255, 255, 255]);
        for (const item of noBubbleForm.labels) drawInkStripes(noBubbleForm.pixels, noBubbleForm.width, item.box);
        for (const peer of noBubbleForm.peers) {
            drawBorderedRect(noBubbleForm.pixels, noBubbleForm.width, peer.box.x - 12, peer.box.y - 4, peer.box.x + peer.box.width + 12, peer.box.y + peer.box.height + 4, [246, 248, 250, 255], [185, 190, 198, 255]);
            drawInkStripes(noBubbleForm.pixels, noBubbleForm.width, peer.box);
        }
        expect(produceImageParagraphGapProofs(noBubbleForm.page, noBubbleForm.width, noBubbleForm.height, noBubbleForm.pixels)).toEqual([]);

        // 存在 layoutBubbles 但目标行在气泡之外时，不走无气泡短续行回退。
        const layoutBubblePage: MangaOcrPage = {
            bubbles: [],
            layoutBubbles: [{bbox: {x0: 300, y0: 10, x1: 410, y1: 120}, members: []}],
            results: [
                {text: 'OUTSIDE FIRST LINE', confidence: 0.99, box: {x: 48, y: 40, width: 170, height: 14}},
                {text: 'OUTSIDE SECOND LINE', confidence: 0.99, box: {x: 48, y: 68, width: 150, height: 14}},
            ],
        };
        const layoutPixels = new Uint8ClampedArray(420 * 140 * 4);
        drawRect(layoutPixels, 420, 0, 0, 420, 140, [255, 255, 255, 255]);
        drawRect(layoutPixels, 420, 20, 42, 34, 56, [40, 120, 220, 255]);
        for (const item of layoutBubblePage.results) drawInkStripes(layoutPixels, 420, item.box);
        expect(produceImageParagraphGapProofs(layoutBubblePage, 420, 140, layoutPixels)).toEqual([]);

        expect(produceImageParagraphGapProofs(overlapPeers.page, overlapPeers.width, overlapPeers.height, overlapPeers.pixels).length).toBeGreaterThan(0);
        expect(produceImageParagraphGapProofs(tightPeer.page, tightPeer.width, tightPeer.height, tightPeer.pixels).length).toBeGreaterThan(0);
    });
});

describe('紧凑数据表与表单行的段落否决及正文护栏', () => {
    it('深色五列数据表（含受保护数值 4.87 m / 14.75 g）与三列纯文本表保持单元格独立', () => {
        const darkTable: ImageTextRegion[] = [
            region('Filament', 20, 20, 60), region('Model', 120, 20, 50), region('Flushed', 210, 20, 55), region('Tower', 300, 20, 48), region('Total', 385, 20, 45),
            region('PLA', 20, 40, 32),
            region('4.87 m', 120, 40, 48, 14, {sourceBoxes: [{x0: 120, y0: 40, x1: 168, y1: 54}]}),
            region('0.00 m', 210, 40, 48, 14, {sourceBoxes: [{x0: 210, y0: 40, x1: 258, y1: 54}]}),
            region('0.00 m', 300, 40, 48, 14, {sourceBoxes: [{x0: 300, y0: 40, x1: 348, y1: 54}]}),
            region('4.87 m', 385, 40, 48, 14, {sourceBoxes: [{x0: 385, y0: 40, x1: 433, y1: 54}]}),
            region('PETG', 20, 60, 40),
            region('14.75 g', 120, 60, 52, 14, {sourceBoxes: [{x0: 120, y0: 60, x1: 172, y1: 74}]}),
            region('0.00 g', 210, 60, 46, 14, {sourceBoxes: [{x0: 210, y0: 60, x1: 256, y1: 74}]}),
            region('0.00 g', 300, 60, 46, 14, {sourceBoxes: [{x0: 300, y0: 60, x1: 346, y1: 74}]}),
            region('14.75 g', 385, 60, 52, 14, {sourceBoxes: [{x0: 385, y0: 60, x1: 437, y1: 74}]}),
        ];
        expect(groupImageParagraphs(darkTable)).toHaveLength(darkTable.length);

        const textTable: ImageTextRegion[] = [
            region('Name', 20, 20, 50), region('Type', 170, 20, 45), region('Status', 320, 20, 55),
            region('Alpha', 20, 40, 48), region('Local', 170, 40, 46), region('Active', 320, 40, 52),
            region('Beta', 20, 60, 42), region('Remote', 170, 60, 56), region('Paused', 320, 60, 54),
        ];
        expect(groupImageParagraphs(textTable)).toHaveLength(textTable.length);

        // 左列为受保护数值、右列为标签的紧凑两列表单也保持分离。
        const leftNumericForm: ImageTextRegion[] = [
            region('4.87 m', 20, 20, 48, 14, {sourceBoxes: [{x0: 20, y0: 20, x1: 68, y1: 34}]}),
            region('Length', 120, 20, 55),
            region('14.75 g', 20, 40, 52, 14, {sourceBoxes: [{x0: 20, y0: 40, x1: 72, y1: 54}]}),
            region('Weight', 120, 40, 55),
        ];
        expect(groupImageParagraphs(leftNumericForm)).toHaveLength(4);
    });

    it.each([false, true])('紧凑两列表单的短标签（含中英文）配非连续右栏控件时否决合段，大规模索引结果一致：%s', large => {
        const far = large ? Array.from({length: 64}, (_, i) => region(`Far ${i}`, 600, 400 + i * 30, 80)) : [];
        // 右栏因字号/列表起点无法连续成段。
        const formNonContinuing: ImageTextRegion[] = [
            region('Plate type', 20, 20, 65), region('Default', 220, 20, 60, 14),
            region('Print sequence', 20, 40, 82), region('2. By object', 220, 40, 90, 14),
            ...far,
        ];
        expect(groupImageParagraphs(formNonContinuing)).toHaveLength(4 + far.length);

        // 右栏被同行间小控件/符号遮挡，同时覆盖中文短标签首字宽度估算。
        const formObstructedPeer: ImageTextRegion[] = [
            region('热床类型', 20, 20, 56), region('全局默认', 220, 20, 60, 14),
            region('v', 235, 35, 8, 4),
            region('螺旋花瓶', 20, 40, 56), region('自动关闭', 220, 40, 60, 14),
            ...far,
        ];
        const obstructedResult = groupImageParagraphs(formObstructedPeer);
        expect(obstructedResult.some(r => r.text === '热床类型')).toBe(true);
        expect(obstructedResult.some(r => r.text === '螺旋花瓶')).toBe(true);

        // 右栏本身可连续成段时，即使左栏较短也不误拆双栏。
        const twoColProse: ImageTextRegion[] = [
            region('Short A', 20, 20, 50), region('Right column first line', 220, 20, 160),
            region('Short B', 20, 40, 50), region('Right column second line', 220, 40, 160),
            ...far,
        ];
        const proseResult = groupImageParagraphs(twoColProse);
        expect(proseResult.some(r => r.text === 'Short A Short B')).toBe(true);
        expect(proseResult.some(r => r.text === 'Right column first line Right column second line')).toBe(true);
    });

    it('护栏：双栏卡片换行说明、长首词换行、错列三项及注音归属均保持正常合并', () => {
        // 双栏卡片换行说明（宽行，不可被表单否决拆开）。
        const cards: ImageTextRegion[] = [
            region('Calculate the best filament', 20, 20, 175), region('Manually assign filament to', 240, 20, 175),
            region('grouping to minimize waste.', 20, 40, 170), region('the left or right nozzle.', 240, 40, 160),
        ];
        expect(groupImageParagraphs(cards).map(r => r.text)).toEqual([
            'Calculate the best filament grouping to minimize waste.',
            'Manually assign filament to the left or right nozzle.',
        ]);

        // 三栏并排特性卡片的多行换行说明（含第三栏右侧末列、末行短尾行与长首词换行）不能被三栏网格误拆。
        const threeCardLayout: ImageTextRegion[] = [
            region('Fast setup wizard for', 20, 20, 175), region('Smart filament tracking', 240, 20, 180), region('Cloud sync across all', 460, 20, 175),
            region('beginners and pros in', 20, 40, 170), region('for every spool slot in', 240, 40, 175), region('your desktop devices', 460, 40, 170),
            region('seconds.', 20, 60, 65), region('real time.', 240, 60, 72), region('seamlessly.', 460, 60, 80),
        ];
        expect(groupImageParagraphs(threeCardLayout).map(r => r.text)).toEqual([
            'Fast setup wizard for beginners and pros in seconds.',
            'Smart filament tracking for every spool slot in real time.',
            'Cloud sync across all your desktop devices seamlessly.',
        ]);

        // 首词无法放入第一行尾部剩余空间（不满足 1.5*small 边距），或第二行本身宽于 55% 栏宽时，按真实换行合并。
        const tightWrap: ImageTextRegion[] = [
            region('Intro', 20, 20, 48), region('1. Right', 150, 20, 60),
            region('Configuration', 20, 40, 68), region('2. Right', 150, 40, 60),
        ];
        expect(groupImageParagraphs(tightWrap).some(r => r.text === 'Intro Configuration')).toBe(true);

        const wideSecondLine: ImageTextRegion[] = [
            region('Note:', 20, 20, 42), region('1. Right', 240, 20, 60),
            region('with a full continuation line here.', 20, 40, 140), region('2. Right', 240, 40, 60),
        ];
        expect(groupImageParagraphs(wideSecondLine).some(r => r.text === 'Note: with a full continuation line here.')).toBe(true);

        // 三项存在但第三列完全不对齐，短单元不触发三栏网格否决。
        const unalignedThird: ImageTextRegion[] = [
            region('Left', 20, 20, 40), region('Mid', 180, 20, 40), region('Far A', 340, 20, 40),
            region('Next', 20, 40, 40), region('Col', 180, 40, 40), region('Far B', 500, 40, 40),
        ];
        expect(groupImageParagraphs(unalignedThird).some(r => r.text === 'Left Next')).toBe(true);

        // 存在竖排干扰和 guardOnly 干扰时，同行 peer 忽略它们且不阻塞正常合并。
        const withGuards: ImageTextRegion[] = [
            region('Left one', 20, 20, 50),
            {text: '', bbox: {x0: 150, y0: 20, x1: 180, y1: 34}, guardOnly: true},
            {text: '縦', bbox: {x0: 200, y0: 20, x1: 214, y1: 60}, vertical: true},
            region('Left two', 20, 40, 50),
            {text: '', bbox: {x0: 150, y0: 40, x1: 180, y1: 54}, guardOnly: true},
        ];
        expect(groupImageParagraphs(withGuards).some(r => r.text === 'Left one Left two')).toBe(true);

        // 横排与竖排附带日文注音时正常保留 ruby 元数据与物理归属。
        const rubyHorizontal: ImageTextRegion[] = [
            region('漢字', 40, 30, 60, 20),
            region('かんじ', 46, 16, 48, 10),
            region('続き', 40, 56, 60, 20),
        ];
        const groupedH = groupImageParagraphs(rubyHorizontal);
        expect(groupedH).toHaveLength(1);
        expect(groupedH[0].ruby).toHaveLength(1);

        const rubyVertical: ImageTextRegion[] = [
            {text: '漢字', bbox: {x0: 100, y0: 20, x1: 120, y1: 100}, vertical: true, fontSize: 20},
            {text: 'かんじ', bbox: {x0: 122, y0: 24, x1: 130, y1: 96}, vertical: true, fontSize: 8},
            {text: '続き', bbox: {x0: 74, y0: 20, x1: 94, y1: 100}, vertical: true, fontSize: 20},
        ];
        const groupedV = groupImageParagraphs(rubyVertical);
        expect(groupedV).toHaveLength(1);
        expect(groupedV[0].text).toBe('漢字続き');
    });
});
