import {describe, expect, it} from 'vitest';
import {detectPdfScanGraphics, pdfScanLayoutGraphics, type PdfScanPixels} from '@/src/features/document-translation/core/pdfScanGraphics';
import type {PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
import {analyzePdfPageLayout} from '@/src/features/document-translation/core/pdfLayoutAnalysis';

const page = (width = 240, height = 200, color = 255): PdfScanPixels => ({width, height, data: new Uint8ClampedArray(width * height * 4).fill(color)});
function paint(image: PdfScanPixels, x: number, y: number, width: number, height: number, color = 0, alpha = 255) {
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) image.data.set([color, color, color, alpha], (row * image.width + col) * 4);
}
const detect = (image: PdfScanPixels, scale = 1) => {
    const steps = detectPdfScanGraphics(image, scale); let step = steps.next();
    while (!step.done) step = steps.next(); return step.value;
};
const atom = (text: string, x: number, y: number, width = 30): PdfLayoutAtom => ({text, x, y, width, height: 8, fontSize: 8, baseline: y + 7, fontFamily: 'sans-serif'});
const grid = (header = false) => {
    const image = page();
    for (const y of [20, 50, 80, 110]) paint(image, 20, y, 181, 1);
    for (const x of [20, 80, 140, 200]) paint(image, x, 20, 1, 91);
    if (header) paint(image, 20, 20, 181, 30, 50);
    return image;
};

describe('scanned page graphic geometry', () => {
    it('finds linked colored diagram nodes while rejecting separate ordinary glyphs', () => {
        const image = page(); paint(image, 10, 20, 70, 50, 220); paint(image, 110, 20, 90, 50, 230); paint(image, 80, 44, 30, 2);
        for (let x = 10; x < 220; x += 10) paint(image, x, 140, 5, 9);
        const graphics = detect(image);
        expect(graphics).toEqual([{x: 10, y: 20, width: 190, height: 50, rules: []}]);
        const atoms = [atom('Collect data', 20, 40, 50), atom('Analyze data', 120, 40, 60),
            atom('Figure 1. The observed process.', 10, 80, 185), atom('Ordinary body text remains translatable.', 10, 140, 200)];
        const layout = analyzePdfPageLayout({atoms, graphics: pdfScanLayoutGraphics(graphics, atoms), width: image.width, height: image.height});
        expect(layout.preservedRegions).toHaveLength(1);
        expect(layout.blocks.filter(block => block.kind === 'figure-label').map(block => block.source)).toEqual(['Collect data', 'Analyze data']);
        expect(layout.blocks.find(block => block.source.startsWith('Figure'))?.preserveSource).toBe(false);
        expect(layout.blocks.find(block => block.source.startsWith('Ordinary'))?.preserveSource).toBe(false);
    });

    it.each([false, true])('recovers table rules and confirms text cells, including a dark filled header=%s', header => {
        const image = grid(header), graphics = detect(image);
        expect(graphics).toHaveLength(1); expect(graphics[0].rules.length).toBeGreaterThanOrEqual(8);
        const atoms = [atom('Group', 30, 30), atom('Count', 90, 30), atom('Rate', 150, 30),
            atom('Alpha', 30, 60), atom('128', 90, 60), atom('94%', 150, 60), atom('Beta', 30, 90), atom('256', 90, 90), atom('98%', 150, 90)];
        const shapes = pdfScanLayoutGraphics(graphics, atoms);
        expect(shapes.every(shape => shape.kind === 'path')).toBe(true);
        const layout = analyzePdfPageLayout({atoms, graphics: shapes, width: image.width, height: image.height});
        expect(layout.preservedRegions.some(region => region.kind === 'table')).toBe(true);
        const alpha = layout.blocks.find(block => block.source === 'Alpha');
        expect(alpha?.preserveSource).toBe(false); expect(alpha?.cellBounds).toBeDefined();
        expect(layout.blocks.find(block => block.source === '128')?.preserveSource).toBe(true);
    });

    it('keeps a chart grid with numeric ticks and a caption as an image instead of inventing table cells', () => {
        const graphics = detect(grid());
        const atoms = [atom('0', 5, 20, 8), atom('100', 5, 50, 12), atom('1000', 5, 80, 15), atom('Time', 85, 120), atom('Figure 1. Measurements.', 20, 145, 150)];
        expect(pdfScanLayoutGraphics(graphics, atoms)).toEqual([{x: 20, y: 20, width: 181, height: 91, kind: 'image'}]);
        expect(pdfScanLayoutGraphics(graphics, [atom('1',30,30),atom('2',90,30),atom('3',30,60),atom('4',90,60)])).toEqual([{x: 20, y: 20, width: 181, height: 91, kind: 'image'}]);
        expect(pdfScanLayoutGraphics(graphics, [atom('A',30,30),atom('B',90,30),atom('C',150,30),atom('D',30,60,170),atom('---',90,60)])).toEqual([{x: 20, y: 20, width: 181, height: 91, kind: 'image'}]);
    });

    it('does not interpret transparency, full-page borders, small glyphs, or a dark empty scan as figures', () => {
        const image = page(); paint(image, 0, 0, 240, 1); paint(image, 0, 199, 240, 1); paint(image, 0, 0, 1, 200); paint(image, 239, 0, 1, 200);
        paint(image, 10, 10, 50, 50, 0, 0); paint(image, 100, 100, 10, 40); paint(image, 130, 100, 24, 24);
        expect(detect(image)).toEqual([]);
        const dark = page(); paint(dark, 0, 0, 240, 200); expect(detect(dark)).toEqual([]);
        expect(detect(page())).toEqual([]);
    });

    it('uses the actual paper background and point scale instead of a white-only or pixel-only cutoff', () => {
        const image = page(); paint(image, 0, 0, 240, 200, 215); paint(image, 20, 30, 18, 18, 100);
        expect(detect(image)).toEqual([]);
        expect(detect(image, 2)).toEqual([{x: 20, y: 30, width: 18, height: 18, rules: []}]);
    });

    it('joins diagonal stroke contact and preserves fractional coordinates for thick grid bands', () => {
        const image = page(); paint(image, 10, 10, 30, 30); paint(image, 40, 40, 30, 30);
        expect(detect(image)).toHaveLength(1);
        const ruled = grid(); paint(ruled, 20, 49, 181, 2); paint(ruled, 139, 20, 2, 91);
        const graphic = detect(ruled)[0]; expect(graphic.rules.some(rule => rule.y === 49.5)).toBe(true);
        expect(graphic.rules.some(rule => rule.x === 139.5)).toBe(true);
    });

    it.each([
        {width: 0, height: 1, data: new Uint8ClampedArray()}, {width: 1.5, height: 1, data: new Uint8ClampedArray(4)},
        {width: 2000, height: 2000, data: new Uint8ClampedArray()}, {width: 10, height: 10, data: new Uint8ClampedArray(4)},
    ])('rejects invalid or oversized pixel inputs before allocating traversal buffers: %j', image => {
        expect(() => detect(image)).toThrow('扫描页版面预览尺寸无效');
    });
    it.each([0, -1, Infinity, NaN])('rejects invalid physical scale %s', scale => {expect(() => detect(page(), scale)).toThrow('扫描页版面预览尺寸无效');});

    it.each(['before', 'pixels', 'component'] as const)('cancels %s without returning partially detected regions', phase => {
        const image = page(700, 700); paint(image, 10, 10, 600, 600);
        const controller = new AbortController(); if (phase === 'before') controller.abort();
        const steps = detectPdfScanGraphics(image, 1, controller.signal);
        if (phase !== 'before') {
            let count = 0; while (++count < (phase === 'pixels' ? 2 : 7)) expect(steps.next().done).toBe(false);
            controller.abort();
        }
        expect(() => steps.next()).toThrow();
    });
});
