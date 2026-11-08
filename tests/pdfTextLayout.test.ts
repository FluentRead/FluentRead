import {describe, expect, it, vi} from 'vitest';
import {isPdfReadingVariationSelector, paginatePdfReadingPlan, pdfReadingFont, wrapPdfReadingText} from '@/src/features/document-translation/core/pdfTextLayout';
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
    it('ignores empty boundary paragraphs while retaining every internal blank line', () => {
        const value = '\r\n \t\r\n首段\r\n\r\n \t\r\n尾段\r\n \t\r\n';
        expect(wrapPdfReadingText(value, 528, body, measure)).toEqual(['首段', '', '', '尾段']);
    });
    it('keeps a full text page on one page when its translation ends with blank paragraphs', () => {
        const text = '译文\n'.repeat(36);
        const plan = textPlan(text + ' \t\r\n\r\n');
        const before = JSON.stringify(plan);
        const pages = paginatePdfReadingPlan(plan, measure);
        expect(pages).toHaveLength(1);
        expect(pages[0].items).toHaveLength(36);
        expect(pages[0].items.every(item => item.kind === 'text' && item.text === '译文')).toBe(true);
        expect(JSON.stringify(plan)).toBe(before);
    });
    it('does not allocate pages or vertical space for whitespace-only text entries', () => {
        const text = '\r\n \t\n\u3000\r\n';
        const blank = textPlan(text);
        expect(wrapPdfReadingText(text, 528, body, measure)).toEqual([]);
        expect(paginatePdfReadingPlan(blank, measure)).toEqual([]);
        expect(paginatePdfReadingPlan(blank, measure, {compactLastPage: true})).toEqual([]);
        const content = textPlan('正文');
        expect(paginatePdfReadingPlan({...content, entries: [...blank.entries, ...content.entries, ...blank.entries]}, measure))
            .toEqual(paginatePdfReadingPlan(content, measure));
    });
    it('preserves paragraph spacing without making pages out of consecutive blank lines', () => {
        const pages = paginatePdfReadingPlan(textPlan('首段\n\n次段' + '\n'.repeat(90) + '尾段'), measure);
        expect(pages).toHaveLength(2);
        expect(pages[0].items).toMatchObject([{text: '首段', y: 42}, {text: '次段', y: 42 + 2 * body.lineHeight}]);
        expect(pages[1].items).toMatchObject([{text: '尾段', y: 42}]);
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
    it('keeps measuring repeated body glyphs once after a long distinct prefix fills the bounded cache', () => {
        const prefix = Array.from({length: 600}, (_, index) => String.fromCodePoint(0x4e00 + index)).join('');
        const value = prefix + '重复中文'.repeat(10000);
        const measured = vi.fn(measure);
        const lines = wrapPdfReadingText(value, 528, body, measured);
        expect(lines).toEqual(Array.from({length: Math.ceil(value.length / 44)}, (_, index) => value.slice(index * 44, (index + 1) * 44)));
        expect(measured).toHaveBeenCalledTimes(604);
    });
    it('keeps BMP and supplementary variation selectors with their base at word and CJK wrap boundaries, including without Segmenter', () => {
        expect([0xFDFF, 0xFE00, 0xFE0F, 0xFE10, 0xE00FF, 0xE0100, 0xE01EF, 0xE01F0].map(code =>
            isPdfReadingVariationSelector(String.fromCodePoint(code)))).toEqual([false, true, true, false, false, true, true, false]);
        const value = '𝒱︀C︀S︀葛\u{E0100}葛\u{E01EF}';
        const width = (text: string) => Array.from(text).filter(character => !isPdfReadingVariationSelector(character)).length * 12;
        const expected = ['𝒱︀', 'C︀', 'S︀', '葛\u{E0100}', '葛\u{E01EF}'];
        expect(wrapPdfReadingText(value, 12, body, width)).toEqual(expected);
        const segmenter = Intl.Segmenter;
        try {
            Object.defineProperty(Intl, 'Segmenter', {value: undefined, configurable: true});
            expect(wrapPdfReadingText(value, 12, body, width)).toEqual(expected);
            expect(wrapPdfReadingText('︀C', 12, body, width).join('')).toBe('︀C');
        } finally {Object.defineProperty(Intl, 'Segmenter', {value: segmenter, configurable: true});}
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
        expect(paginatePdfReadingPlan(narrow, measure, {compactLastPage: true})[0].height).toBe(90);
    });
    it('moves an entire fitting formula to the next page rather than clipping it to the remaining space', () => {
        const prior = textPlan('前文\n'.repeat(31)).entries[0];
        const picture = {kind: 'region' as const, id: 'formula', pageNumber: 1, role: 'formula', sourceRect: {x: 20, y: 30, width: 352, height: 80}, segmentIndexes: []};
        const pages = paginatePdfReadingPlan({pageNumber: 1, hasTranslation: true, entries: [prior, picture]}, measure);
        expect(pages).toHaveLength(2); expect(pages[0].items.every(item => item.kind === 'text')).toBe(true);
        expect(pages[1].items).toEqual([{kind: 'region', entryId: 'formula', sourceRect: picture.sourceRect, x: 42, y: 42, width: 528, height: 120}]);
        const exact = {...picture, sourceRect: {...picture.sourceRect, height: 472}};
        expect(paginatePdfReadingPlan({pageNumber: 1, hasTranslation: true, entries: [prior, exact]}, measure)[1].items[0]).toMatchObject({height: 708, sourceRect: exact.sourceRect});
    });
    it('rejects unbounded source strips and consumes subpixel tails without extra loops', () => {
        const region = (width: number, height: number): PdfReadingPlan => ({pageNumber: 1, hasTranslation: true, entries: [{kind: 'region', id: 'r', pageNumber: 1, role: 'figure', sourceRect: {x: 0, y: 0, width, height}, segmentIndexes: []}]});
        expect(() => paginatePdfReadingPlan(region(100, Number.MAX_VALUE), measure)).toThrow('合理页数');
        const pages = paginatePdfReadingPlan(region(100, 944.0000000000001), measure);
        const strips = pages.flatMap(page => page.items).filter(item => item.kind === 'region');
        expect(strips).toHaveLength(2);
        expect(strips.reduce((sum, item) => sum + item.sourceRect.height, 0)).toBeCloseTo(944.0000000000001);
        expect(paginatePdfReadingPlan(region(Number.MAX_VALUE, Number.MIN_VALUE), measure)).toEqual([]);
    });
    it.each([352, 353.1, 528, 734, 999.9, 1056])('merges only floating-point image tails at width %s while retaining every source coordinate', width => {
        const scale = Math.min(1.5, 528 / width);
        for (const count of [1, 2, 7, 31, 100, 1000]) {
            const exactHeight = 708 * count / scale;
            for (const delta of [-exactHeight * Number.EPSILON, 0, exactHeight * Number.EPSILON, 0.001, 0.5]) {
                const height = exactHeight + delta;
                const plan: PdfReadingPlan = {pageNumber: 1, hasTranslation: true, entries: [
                    {kind: 'region', id: 'image', pageNumber: 1, role: 'figure', sourceRect: {x: 13, y: 27, width, height}, segmentIndexes: []},
                ]};
                const original = JSON.stringify(plan);
                const pages = paginatePdfReadingPlan(plan, measure);
                const strips = pages.flatMap(page => page.items).filter(item => item.kind === 'region');
                expect(pages, `scale ${scale}, ${count} pages, delta ${delta}`).toHaveLength(count + Number(delta >= 0.001));
                expect(strips.every(item => item.height > 0 && item.y + item.height <= 750)).toBe(true);
                expect(strips[0].sourceRect.y).toBe(27);
                expect(strips.reduce((sum, item) => sum + item.sourceRect.height, 0)).toBeCloseTo(height, 9);
                expect(strips.at(-1)!.sourceRect.y + strips.at(-1)!.sourceRect.height).toBeCloseTo(27 + height, 9);
                for (let index = 1; index < strips.length; index += 1) {
                    expect(strips[index].sourceRect.y).toBeCloseTo(strips[index - 1].sourceRect.y + strips[index - 1].sourceRect.height, 9);
                }
                expect(JSON.stringify(plan)).toBe(original);
            }
        }
    });
    it.each([353.1, 734, 999.9])('keeps cumulative source boundaries after a partially used first page at width %s', width => {
        const scale = Math.min(1.5, 528 / width);
        for (const count of [31, 100, 1000]) {
            const exactHeight = (708 * count - body.lineHeight * 2 - 12) / scale;
            for (const delta of [-exactHeight * Number.EPSILON, 0, exactHeight * Number.EPSILON, 0.001]) {
                const height = exactHeight + delta;
                const plan: PdfReadingPlan = {...textPlan('前文\n继续'), entries: [textPlan('前文\n继续').entries[0],
                    {kind: 'region', id: 'image', pageNumber: 1, role: 'figure', sourceRect: {x: 13, y: 27, width, height}, segmentIndexes: []}]};
                const pages = paginatePdfReadingPlan(plan, measure);
                const strips = pages.flatMap(page => page.items).filter(item => item.kind === 'region');
                expect(pages, `${count} pages, delta ${delta}`).toHaveLength(count + Number(delta >= 0.001));
                expect(strips[0].y).toBeCloseTo(42 + body.lineHeight * 2 + 12);
                expect(strips.every(item => item.height > 0 && item.y + item.height <= 750)).toBe(true);
                expect(strips.reduce((sum, item) => sum + item.sourceRect.height, 0)).toBeCloseTo(height, 9);
                expect(strips.at(-1)!.sourceRect.y + strips.at(-1)!.sourceRect.height).toBeCloseTo(27 + height, 9);
                for (let index = 1; index < strips.length; index += 1) {
                    expect(strips[index].sourceRect.y).toBeCloseTo(strips[index - 1].sourceRect.y + strips[index - 1].sourceRect.height, 9);
                }
            }
        }
    });
    it('bounds continuation page allocation for an oversized text entry', () => {
        expect(() => paginatePdfReadingPlan(textPlan('line\n'.repeat(160_000)), measure)).toThrow('单页内容过长');
    });
    it.each([353.1, 734, 999.9])('accepts the exact 4096-page image limit and rejects real excess height at width %s', width => {
        const scale = Math.min(1.5, 528 / width), exactHeight = 708 * 4096 / scale;
        const plan = (height: number): PdfReadingPlan => ({pageNumber: 1, hasTranslation: true, entries: [
            {kind: 'region', id: 'limit', pageNumber: 1, role: 'figure', sourceRect: {x: 0, y: 0, width, height}, segmentIndexes: []}]});
        for (const delta of [-exactHeight * Number.EPSILON, 0, exactHeight * Number.EPSILON]) {
            const height = exactHeight + delta, pages = paginatePdfReadingPlan(plan(height), measure);
            expect(pages).toHaveLength(4096);
            const last = pages.at(-1)!.items[0];
            expect(last.kind).toBe('region');
            if (last.kind === 'region') expect(last.sourceRect.y + last.sourceRect.height).toBe(height);
        }
        expect(() => paginatePdfReadingPlan(plan(exactHeight + .001), measure)).toThrow('合理页数');
        expect(() => paginatePdfReadingPlan(plan(708 * 4097 / scale), measure)).toThrow('合理页数');
    });
    it('fails fast when a damaged geometry port changes its validated height before strip consumption', () => {
        // 防御性 fault injection：正常解析的 PDF 使用稳定数据对象；这里显式模拟读取途中损坏的端口。
        const heights = [100, 100, 100, 100, -1];
        const sourceRect = {x: 0, y: 0, width: 100, get height() {return heights.shift() ?? -1;}};
        const plan: PdfReadingPlan = {pageNumber: 1, hasTranslation: true, entries: [
            {kind: 'region', id: 'damaged', pageNumber: 1, role: 'figure', sourceRect, segmentIndexes: []},
        ]};
        expect(() => paginatePdfReadingPlan(plan, measure)).toThrow('原图分页无法继续');
    });
});
