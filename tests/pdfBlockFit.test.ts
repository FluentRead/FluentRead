/**
 * @file tests/pdfBlockFit.test.ts
 * 文件职责：验证“原版排版”阅读把译文放回原文段落矩形时的取舍、可用空白和字号收缩。
 * 主要内容：受保护内容与图表区域内的文字不被替换；段落下方与右侧的空白按相邻内容和旋转页尺寸计算；译文放得下时保持原字号，放不下时逐步收缩到下限并如实标记溢出。
 * 模块边界：只测试纯几何与分行，字宽由测试注入；不创建 DOM、Canvas 或 PDF。
 */
import {describe, expect, it} from 'vitest';
import type {PdfDocumentBlock, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {fitPdfBlockText, pdfOverlayBlocks} from '@/src/features/document-translation/core/pdfBlockFit';

const block = (segmentIndex: number, x: number, y: number, width: number, height: number, extra: Partial<PdfDocumentBlock> = {}): PdfDocumentBlock => ({segmentIndex, x, y, width, height, fontSize: 10, lineHeight: 12, lineCount: 2, fontFamily: 'serif', fontWeight: 400, textAlign: 'left', kind: 'text', ...extra});
const page = (blocks: PdfDocumentBlock[], extra: Partial<PdfDocumentPage> = {}): PdfDocumentPage => ({pageNumber: 1, width: 600, height: 800, segmentIndexes: blocks.map(entry => entry.segmentIndex), blocks, ...extra});
/** 每个字符一个字号宽，便于手算分行。 */
const monospace = (text: string, fontSize: number) => Array.from(text).length * fontSize;

describe('PDF layout overlay block selection', () => {
    it('replaces ordinary prose only and keeps protected kinds, preserved regions and empty geometry as source pixels', () => {
        const blocks = [
            block(0, 40, 40, 200, 24),
            block(1, 40, 80, 200, 24, {preserveSource: true}),
            block(2, 40, 120, 200, 12, {kind: 'formula'}), block(3, 40, 140, 200, 12, {kind: 'table'}), block(4, 40, 160, 200, 12, {kind: 'figure-label'}),
            block(5, 40, 180, 200, 12, {kind: 'metadata'}), block(6, 40, 200, 200, 12, {kind: 'footer'}),
            block(7, 310, 310, 100, 12), block(8, 40, 400, 0, 12), block(9, 40, 420, 100, 0),
            block(10, 40, 500, 200, 24, {kind: undefined}),
        ];
        const result = pdfOverlayBlocks(page(blocks, {preservedRegions: [{id: 'figure-1', kind: 'figure', x: 300, y: 300, width: 200, height: 100}]}));
        // 含词语的表格单元格（未标记保留）可以替换，数字单元格由版面分析标记为保留。
        expect(result.map(entry => entry.block.segmentIndex)).toEqual([0, 3, 7, 10]);
        const table = page([block(0, 50, 100, 60, 10, {kind: 'table'}), block(1, 300, 100, 30, 10, {kind: 'table', preserveSource: true}), block(2, 50, 130, 200, 10)], {preservedRegions: [{id: 'table-1', kind: 'table', x: 40, y: 90, width: 400, height: 60}]});
        expect(pdfOverlayBlocks(table).map(entry => entry.block.segmentIndex)).toEqual([0, 2]);
        expect(pdfOverlayBlocks(page([block(0, 40, 40, 200, 24)])).map(entry => entry.block.segmentIndex)).toEqual([0]);
    });
    it('leaves the figure/prose decision to layout analysis: prose inside an oversized figure box is still replaced', () => {
        // 跨栏的图形包围盒会圈入下方正文；只有被标记为图内标签（figure-label）的块保留原样。
        const blocks = [block(0, 318, 75, 242, 70), block(1, 100, 100, 200, 40), block(2, 250, 150, 100, 30, {kind: 'figure-label', preserveSource: true})];
        const result = pdfOverlayBlocks(page(blocks, {preservedRegions: [{id: 'figure-1', kind: 'figure', x: 0, y: 0, width: 600, height: 185}]}));
        expect(result.map(entry => entry.block.segmentIndex)).toEqual([0, 1]);
    });
    it('measures the free space below and to the right up to the nearest neighbouring content', () => {
        const blocks = [block(0, 40, 40, 200, 24), block(1, 40, 80, 200, 24), block(2, 320, 40, 200, 24), block(3, 320, 300, 200, 24)].map(entry => ({...entry, lineCount: 1}));
        const [first, second, third, fourth] = pdfOverlayBlocks(page(blocks, {preservedRegions: [{id: 'figure-1', kind: 'figure', x: 40, y: 130, width: 200, height: 60}]}));
        // 下方最近的是同栏的下一段；右侧最近的是同一行高度上的右栏。
        expect(first.spaceBelow).toBeCloseTo(80 - 64 - 1.5); expect(first.spaceRight).toBeCloseTo(320 - 240 - 6);
        // 图形区域同样限制可用高度；右侧没有同高内容时按对称页边距。
        expect(second.spaceBelow).toBeCloseTo(130 - 104 - 1.5); expect(second.spaceRight).toBeCloseTo(600 - 40 - 240 - 6);
        expect(third.spaceBelow).toBeCloseTo(300 - 64 - 1.5); expect(third.spaceRight).toBeCloseTo(0);
        expect(fourth.spaceBelow).toBeCloseTo(800 - 324 - 1.5);
    });
    it('uses the unrotated content size for quarter-turn pages and never reports negative space', () => {
        const rotated = pdfOverlayBlocks(page([block(0, 40, 560, 500, 30, {lineCount: 1})], {rotation: 90, width: 800, height: 600}))[0];
        // 旋转 90 度时内容坐标的高度是展示宽度 800，宽度是展示高度 600。
        expect(rotated.spaceBelow).toBeCloseTo(800 - 590 - 1.5); expect(rotated.spaceRight).toBeCloseTo(600 - 40 - 540 - 6);
        const reversed = pdfOverlayBlocks(page([block(0, 40, 560, 500, 30)], {rotation: 270, width: 800, height: 600}))[0];
        expect(reversed.spaceBelow).toBeCloseTo(208.5);
        const tight = pdfOverlayBlocks(page([block(0, -20, 40, 700, 790), block(1, 40, 829.5, 100, 10)]))[0];
        expect(tight.spaceBelow).toBe(0); expect(tight.spaceRight).toBe(0);
    });
    it('stops expanded copyright and centred titles before the real Attention page-one rules', () => {
        const copyright = block(0, 124.313, 73.8573744, 363.5815424, 39.8502, {lineCount: 3});
        const title = block(1, 204, 150.164, 204, 17.215, {lineCount: 1, textAlign: 'center'});
        const [first, second] = pdfOverlayBlocks(page([copyright, title], {width: 612, height: 792, layoutBoundaries: [
            {x: 108, y: 128.197, width: 396, height: 3.985}, {x: 108, y: 178.148, width: 396, height: 0},
        ]}));
        expect(first.block.y + first.block.height + first.spaceBelow).toBeLessThan(128.197);
        expect(second.block.y + second.block.height + second.spaceBelow).toBeLessThan(178.148);
        expect(second.spaceRight).toBe(0);
    });
    it('checks the expanded one-line width against lower content before borrowing vertical space', () => {
        const first = pdfOverlayBlocks(page([block(0, 40, 40, 100, 12, {lineCount: 1}), block(1, 240, 65, 200, 24)]))[0];
        expect(first.spaceRight).toBeGreaterThan(100);
        expect(first.block.y + first.block.height + first.spaceBelow).toBeLessThan(65);
        expect(pdfOverlayBlocks(page([block(0, 40, 40, 100, 12, {lineCount: 1, textAlign: 'right'})]))[0].spaceRight).toBe(0);
    });
    it('keeps a paragraph beside its preserved QED mark without changing source line erasure geometry', () => {
        const source = block(0, 70.86614, 686.88898, 455.55796, 26.87523, {lines: [{text: 'Source line', x: 70.86614, y: 686.88898, width: 455.55796, height: 11}]});
        const mark = block(-1, 515.85144, 701.88421, 8.558, 11, {kind: 'formula', preserveSource: true});
        const overlay = pdfOverlayBlocks(page([source, mark]))[0];
        expect(overlay.block.x + overlay.block.width).toBeLessThan(mark.x);
        expect(overlay.block.lines).toBe(source.lines);
        expect(source.width).toBe(455.55796);
    });
});

describe('PDF layout overlay text fitting', () => {
    it('keeps the source size and leading when the translation fits', () => {
        const fit = fitPdfBlockText({text: '一二三四五六七八九十', width: 100, height: 24, fontSize: 10, lineHeight: 13, minFontSize: 6, weight: 400}, monospace);
        expect(fit).toEqual({fontSize: 10, lineHeight: 13, lines: ['一二三四五六七八九十'], overflow: false});
    });
    it('clamps the leading ratio for single-line and very loose sources', () => {
        expect(fitPdfBlockText({text: '标题', width: 100, height: 10, fontSize: 10, lineHeight: 10, minFontSize: 6, weight: 700}, monospace).lineHeight).toBe(12.5);
        expect(fitPdfBlockText({text: '正文', width: 100, height: 40, fontSize: 10, lineHeight: 30, minFontSize: 6, weight: 400}, monospace).lineHeight).toBe(16);
    });
    it('shrinks step by step until every line fits within the available height', () => {
        // 30 个字在 100 宽、10 号字下需要 3 行共 39 高，只有 28 高可用。
        const fit = fitPdfBlockText({text: '字'.repeat(30), width: 100, height: 28, fontSize: 10, lineHeight: 13, minFontSize: 6, weight: 400}, monospace);
        expect(fit.overflow).toBe(false); expect(fit.fontSize).toBeLessThan(10); expect(fit.fontSize).toBeGreaterThanOrEqual(6);
        expect(fit.lines.join('')).toBe('字'.repeat(30));
        expect(fit.lines.length * fit.lineHeight).toBeLessThanOrEqual(28 + fit.lineHeight * 0.25);
        expect(fit.lines.every(line => monospace(line, fit.fontSize) <= 100)).toBe(true);
    });
    it('stops at the readable floor and reports overflow without dropping text', () => {
        const fit = fitPdfBlockText({text: '字'.repeat(200), width: 100, height: 20, fontSize: 10, lineHeight: 13, minFontSize: 8, weight: 400}, monospace);
        expect(fit.fontSize).toBe(8); expect(fit.overflow).toBe(true); expect(fit.lines.join('')).toBe('字'.repeat(200));
    });
    it('tolerates degenerate geometry and a floor above the source size', () => {
        const zero = fitPdfBlockText({text: '译文', width: 0, height: 0, fontSize: 0, lineHeight: 0, minFontSize: 0, weight: 400}, monospace);
        expect(zero.fontSize).toBe(1); expect(zero.overflow).toBe(true); expect(zero.lines.join('')).toBe('译文');
        const floorAbove = fitPdfBlockText({text: '字'.repeat(50), width: 50, height: 10, fontSize: 5, lineHeight: 6, minFontSize: 9, weight: 400}, monospace);
        expect(floorAbove.fontSize).toBe(5); expect(floorAbove.overflow).toBe(true);
    });
    it('gives up after a bounded number of steps when a measure never lets the text fit', () => {
        let calls = 0;
        // 字宽随字号缩小而反向增大，任何字号都放不下；循环必须有界。
        const fit = fitPdfBlockText({text: '字'.repeat(40), width: 100, height: 12, fontSize: 100, lineHeight: 120, minFontSize: 1, weight: 400}, (text, fontSize) => {calls += 1; return Array.from(text).length * 1000 / fontSize;});
        expect(fit.overflow).toBe(true); expect(fit.fontSize).toBeGreaterThan(1); expect(calls).toBeGreaterThan(0);
    });
    it('bounds fitting for invalid dimensions and reports a single glyph wider than the floor box', () => {
        const invalid = fitPdfBlockText({text: '尾文', width: Infinity, height: NaN, fontSize: Infinity, lineHeight: NaN, minFontSize: Infinity, weight: 400}, monospace);
        expect(Number.isFinite(invalid.fontSize)).toBe(true); expect(invalid.overflow).toBe(true);
        expect(invalid.lines.join('')).toBe('尾文');
        const narrow = fitPdfBlockText({text: '字', width: 2, height: 200, fontSize: 12, lineHeight: 12, minFontSize: 6, weight: 400}, monospace);
        expect(narrow.fontSize).toBe(6); expect(narrow.overflow).toBe(true);
    });
    it('tightens the leading once the text has shrunk, so a doubled translation fits two small lines into a one-line box', () => {
        const measure = (text: string, size: number) => text.length * size * 0.5;
        // 原文一行（高 20、字号 20、宽 200），译文六十多个字符：缩到一半字号后仍需两行，收紧行距后两行小字恰好排进原来的一行高。
        const fit = fitPdfBlockText({text: 'abcdefgh ijklmnop qrstuvwx yzabcdef ghijklmn opqrstuv wxyzabcd', width: 200, height: 20, fontSize: 20, lineHeight: 20, minFontSize: 10, weight: 400}, measure);
        expect(fit.overflow).toBe(false);
        expect(fit.lines).toHaveLength(2);
        expect(fit.lineHeight / fit.fontSize).toBeCloseTo(1.12, 5);
        // 没有缩小时保持原来的行距比例。
        const roomy = fitPdfBlockText({text: 'short', width: 200, height: 40, fontSize: 20, lineHeight: 30, minFontSize: 10, weight: 400}, measure);
        expect(roomy.lineHeight / roomy.fontSize).toBeCloseTo(1.5, 5);
    });
});
