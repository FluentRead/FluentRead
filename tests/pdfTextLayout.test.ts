import {describe, expect, it, vi} from 'vitest';
import {paginatePdfReadingPlan, pdfReadingFont, wrapPdfReadingText} from '@/src/features/document-translation/core/pdfTextLayout';
import type {PdfReadingPlan} from '@/src/features/document-translation/core/pdfReadingPlan';

const body = pdfReadingFont('paragraph');
const measure = (text: string) => Array.from(text).length * 12;
const textPlan = (text: string): PdfReadingPlan => ({pageNumber: 1, hasTranslation: true, entries: [{kind: 'text', id: 's0', pageNumber: 1, segmentIndex: 0, role: 'paragraph', source: 'Source', text, translated: true, sourceRect: {x: 0, y: 0, width: 100, height: 20}}]});

describe('PDF fixed-font complete-text pagination', () => {
    it('keeps title, heading, caption, metadata and body hierarchy readable', () => {
        expect(['title', 'heading', 'caption', 'metadata', 'footer', 'note', 'paragraph'].map(role => pdfReadingFont(role).size)).toEqual([20, 16, 11.5, 11, 11, 11, 12]);
        expect(body.lineHeight).toBe(19.2);
    });
    it('preserves complete Chinese, words, emoji and blank paragraphs without shrinking', () => {
        const value = '中文。继续阅读，不截断末尾。 👩‍💻\r\n\r\nEnglish verylongunbrokenword tail';
        const lines = wrapPdfReadingText(value, 72, body, measure);
        expect(lines.join('').replace(/\s/gu, '')).toBe(value.replace(/\s/gu, ''));
        expect(lines).toContain('');
        expect(lines.some(line => line.startsWith('。'))).toBe(false);
        expect(lines.some(line => line.includes('👩‍💻'))).toBe(true);
        expect(lines.filter(Boolean).every(line => measure(line) <= 72)).toBe(true);
    });
    it('bounds repeated Chinese width measurements and handles unavailable segmentation and invalid measurements', () => {
        const measured = vi.fn(measure);
        const lines = wrapPdfReadingText('重复中文'.repeat(10000), 528, body, measured);
        expect(lines.join('')).toHaveLength(40000);
        expect(measured).toHaveBeenCalledTimes(4);
        const segmenter = Intl.Segmenter;
        try {
            Object.defineProperty(Intl, 'Segmenter', {value: undefined, configurable: true});
            expect(wrapPdfReadingText('ab', NaN, body, () => Infinity)).toEqual(['a', 'b']);
            expect(wrapPdfReadingText('a b', 10, body, () => -1)).toEqual(['a b']);
        } finally {Object.defineProperty(Intl, 'Segmenter', {value: segmenter, configurable: true});}
    });
    it('retains unique characters when the bounded measurement cache fills', () => {
        const value = Array.from({length: 600}, (_, index) => String.fromCodePoint(0x4e00 + index)).join('');
        const lines = wrapPdfReadingText(value, 100, body, measure);
        expect(lines.join('')).toBe(value);
        expect(wrapPdfReadingText('  甲 乙', 12, body, measure)).toEqual(['甲', '乙']);
    });
    it('paginates 4x paragraphs completely at 12pt with no items outside page margins', () => {
        const value = ('译文保持完整，公式和图表保留原图。'.repeat(1200)) + '【最终尾文】';
        const pages = paginatePdfReadingPlan(textPlan(value), measure);
        expect(pages.length).toBeGreaterThan(10);
        const items = pages.flatMap(page => page.items);
        expect(items.map(item => item.kind === 'text' ? item.text : '').join('')).toBe(value);
        expect(items.every(item => item.kind === 'text' && item.font.size === 12 && item.y >= 42 && item.y + item.font.lineHeight <= 750)).toBe(true);
        expect(paginatePdfReadingPlan({...textPlan(''), entries: []}, measure)).toEqual([]);
    });
    it('continues every strip of a tall image once and ignores invalid geometry', () => {
        const plan: PdfReadingPlan = {pageNumber: 1, hasTranslation: true, entries: [
            {...textPlan('前文').entries[0]},
            {kind: 'region', id: 'figure', pageNumber: 1, role: 'figure', sourceRect: {x: 10, y: 20, width: 100, height: 2000}, segmentIndexes: []},
            {kind: 'region', id: 'invalid', pageNumber: 1, role: 'figure', sourceRect: {x: 0, y: 0, width: NaN, height: -1}, segmentIndexes: []},
            {...textPlan('尾文').entries[0], id: 'last'},
        ]};
        const pages = paginatePdfReadingPlan(plan, measure);
        const strips = pages.flatMap(page => page.items).filter(item => item.kind === 'region');
        expect(strips.reduce((sum, item) => sum + item.sourceRect.height, 0)).toBeCloseTo(2000);
        expect(strips[0].sourceRect.y).toBe(20);
        expect(strips.at(-1)!.sourceRect.y + strips.at(-1)!.sourceRect.height).toBeCloseTo(2020);
        expect(strips.every(item => item.y + item.height <= 750)).toBe(true);
        const narrow = {...plan, entries: [{kind: 'region' as const, id: 'wide', pageNumber: 1, role: 'table', sourceRect: {x: 0, y: 0, width: 1000, height: 10}, segmentIndexes: []}]};
        expect(paginatePdfReadingPlan(narrow, measure)[0].items[0]).toMatchObject({width: 528, height: 5.28});
    });
    it('rejects unbounded source strips and consumes subpixel tails without extra loops', () => {
        const region = (width: number, height: number): PdfReadingPlan => ({pageNumber: 1, hasTranslation: true, entries: [{kind: 'region', id: 'r', pageNumber: 1, role: 'figure', sourceRect: {x: 0, y: 0, width, height}, segmentIndexes: []}]});
        expect(() => paginatePdfReadingPlan(region(100, Number.MAX_VALUE), measure)).toThrow('合理页数');
        const pages = paginatePdfReadingPlan(region(100, 944.0000000000001), measure);
        const strips = pages.flatMap(page => page.items).filter(item => item.kind === 'region');
        expect(strips.length).toBeLessThanOrEqual(3);
        expect(strips.reduce((sum, item) => sum + item.sourceRect.height, 0)).toBeCloseTo(944.0000000000001);
        expect(paginatePdfReadingPlan(region(Number.MAX_VALUE, Number.MIN_VALUE), measure)).toEqual([]);
    });
});
