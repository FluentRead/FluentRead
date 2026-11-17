import {describe, expect, it} from 'vitest';
import type {PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {PDF_READING_THEMES, pdfReadingThemeColors, pdfReadingThemeRegions, pdfReadingThemeTransfer} from '@/src/features/document-translation/core/pdfReadingTheme';

const page = (overrides: Partial<PdfDocumentPage> = {}): PdfDocumentPage => ({pageNumber: 1, width: 600, height: 800, segmentIndexes: [0], blocks: [{segmentIndex: 0, x: 10, y: 10, width: 100, height: 20, fontSize: 12, fontFamily: 'sans', lineHeight: 14, lineCount: 1, fontWeight: 400, textAlign: 'left'}], ...overrides});
describe('PDF reading colors and original-figure protection', () => {
    it('maps white paper and black ink to every selected palette including custom colors', () => {
        for (const theme of PDF_READING_THEMES) {
            const colors = pdfReadingThemeColors(theme, '#123456', '#fedcba');
            if (theme === 'auto') {expect(colors).toBeUndefined();continue;}
            const channels = pdfReadingThemeTransfer(colors!);
            channels.forEach((channel, index) => {
                expect(Math.round(channel.intercept * 255)).toBe(parseInt(colors!.text.slice(1 + index * 2, 3 + index * 2), 16));
                expect(Math.round((channel.slope + channel.intercept) * 255)).toBe(parseInt(colors!.background.slice(1 + index * 2, 3 + index * 2), 16));
            });
        }
        expect(pdfReadingThemeColors('custom', 'url(private)', 'red')).toEqual({background: '#fff7e6', text: '#302b24'});
        expect(pdfReadingThemeColors('custom', '#AaBbCc', '#001122')).toEqual({background: '#AaBbCc', text: '#001122'});
        expect(pdfReadingThemeColors('invert', '', '')).toEqual({background: '#000000', text: '#ffffff'});
        expect(pdfReadingThemeColors('dark', '', '')).not.toEqual(pdfReadingThemeColors('invert', '', ''));
    });
    it('clips, deduplicates and preserves only valid identified figures without changing model geometry', () => {
        const source = page({preservedRegions: [{id: 'graph', kind: 'figure', x: -10, y: 20, width: 60, height: 70}, {id: 'duplicate', kind: 'figure', x: -10, y: 20, width: 60, height: 70}, {id: 'math', kind: 'formula', x: 100, y: 100, width: 80, height: 20}, {id: 'table', kind: 'table', x: 300, y: 300, width: 100, height: 50}, {id: 'bad', kind: 'figure', x: NaN, y: 1, width: 30, height: 20}, {id: 'outside', kind: 'figure', x: 900, y: 0, width: 30, height: 20}, {id: 'empty', kind: 'figure', x: 0, y: 0, width: 20, height: 0}]});
        const before = JSON.stringify(source);
        expect(pdfReadingThemeRegions(source)).toEqual([{x: 0, y: 20, width: 50, height: 70}]);
        expect(JSON.stringify(source)).toBe(before);
        expect(pdfReadingThemeRegions(page())).toEqual([]);
    });
    it.each([0, 90, 180, 270] as const)('protects complete image-only and complex-vector pages at rotation %i', rotation => {
        const source = page({rotation, scanned: true});
        const expected = [{x: 0, y: 0, width: rotation === 90 || rotation === 270 ? 800 : 600, height: rotation === 90 || rotation === 270 ? 600 : 800}];
        expect(pdfReadingThemeRegions(source)).toEqual(expected);
        expect(pdfReadingThemeRegions(page({rotation, blocks: []}))).toEqual(expected);
        expect(pdfReadingThemeRegions(page({rotation, blocks: [], preservedRegions: []}))).toEqual(expected);
        expect(pdfReadingThemeRegions(page({rotation, preservedRegions: Array.from({length: 129}, (_, i) => ({id: String(i), kind: 'figure', x: i, y: 10, width: 1, height: 1}))}))).toEqual(expected);
    });
    it('does not mistake an OCR-recognized text page with an identified figure for an image-only page', () => {
        expect(pdfReadingThemeRegions(page({ocrRecognized: true, preservedRegions: [{id: 'graph', kind: 'figure', x: 10, y: 20, width: 40, height: 30}]}))).toEqual([{x: 10, y: 20, width: 40, height: 30}]);
    });
});
