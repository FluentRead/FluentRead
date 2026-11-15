import {describe, expect, it} from 'vitest';
import {buildPdfReadingPlan} from '@/src/features/document-translation/core/pdfReadingPlan';
import type {ParsedDocument, PdfDocumentBlock, PdfDocumentPage} from '@/src/features/document-translation/core/document';

const block = (segmentIndex: number, overrides: Partial<PdfDocumentBlock> = {}): PdfDocumentBlock => ({segmentIndex, x: 20, y: 20 + segmentIndex * 50, width: 150, height: 30, fontSize: 12, fontFamily: 'sans-serif', lineHeight: 14, lineCount: 2, textAlign: 'left', fontWeight: 400, ...overrides});
const page = (blocks: PdfDocumentBlock[], overrides: Partial<PdfDocumentPage> = {}): PdfDocumentPage => ({pageNumber: 3, width: 600, height: 800, blocks, segmentIndexes: blocks.map(entry => entry.segmentIndex), ...overrides});
const document = (sources: Array<{source: string; role?: 'heading' | 'paragraph'}>): ParsedDocument => ({fileName: 'paper.pdf', format: 'pdf', label: 'PDF', parts: [], segments: sources.map((entry, id) => ({id, ...entry}))});

describe('PDF canonical complete reading plan', () => {
    it('places a preserved table before its translated cells using explicit order even when the source block array is reversed', () => {
        const sourcePage = page([block(1, {kind: 'table', readingOrder: 20, y: 125}), block(0, {kind: 'table', readingOrder: 10, y: 100}), block(2, {kind: 'text', readingOrder: 30, y: 220})], {
            preservedRegions: [{id: 'table', kind: 'table', x: 10, y: 90, width: 200, height: 90}],
        });
        const plan = buildPdfReadingPlan(document([{source: 'First cell'}, {source: 'Second cell'}, {source: 'After the table'}]), sourcePage, ['第一单元格', '第二单元格', '表后正文']);
        expect(plan.entries.map(entry => entry.id)).toEqual(['pdf-3-region-table', 'pdf-3-segment-0', 'pdf-3-segment-1', 'pdf-3-segment-2']);
        expect(plan.entries[0]).toMatchObject({kind: 'region', segmentIndexes: [0, 1]});
    });
    it('retains source array order when legacy blocks share the same explicit reading order', () => {
        const sourcePage = page([block(1, {readingOrder: 4}), block(0, {readingOrder: 4})]);
        const plan = buildPdfReadingPlan(document([{source: 'Second'}, {source: 'First'}]), sourcePage, []);
        expect(plan.entries.map(entry => entry.id)).toEqual(['pdf-3-segment-1', 'pdf-3-segment-0']);
    });
    it('retains list structure in source and translated reading without changing source text or segment identity', () => {
        const doc = document([{source: 'First list item'}, {source: 'Second list item'}]);
        const sourcePage = page([block(0, {listMarker: '•'}), block(1, {listMarker: '▪'})]);
        const before = JSON.stringify({doc, sourcePage});
        const plan = buildPdfReadingPlan(doc, sourcePage, ['第一项']);
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text)).toEqual(['• 第一项', '▪ Second list item']);
        expect(plan.entries[0]).toMatchObject({id: 'pdf-3-segment-0', source: 'First list item', translated: true});
        expect(JSON.stringify({doc, sourcePage})).toBe(before);
    });
    it('renders legacy and translated discretionary soft hyphens as continuous searchable words while retaining source identity', () => {
        const doc = document([{source: 'co\u00ADoperate'}, {source: 'another source'}]);
        const plan = buildPdfReadingPlan(doc, page([block(0), block(1)]), ['', 'inter\u00ADnational']);
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text)).toEqual(['cooperate', 'international']);
        expect(plan.entries[0]).toMatchObject({source: 'co\u00ADoperate', id: 'pdf-3-segment-0', translated: false});
    });
    it('retains parser source-only bylines and running text with unique stable block IDs', () => {
        const byline = {...block(-1, {kind: 'metadata', preserveSource: true, readingOrder: 0}), source: 'Ada Example · ada@example.org'};
        const footer = {...block(-1, {kind: 'footer', preserveSource: true, readingOrder: 2}), source: 'Example report · 2026'};
        const sourcePage = page([byline, block(0, {readingOrder: 1}), footer]);
        const plan = buildPdfReadingPlan(document([{source: 'Body paragraph'}]), sourcePage, ['正文']);
        expect(plan.entries.map(entry => entry.kind === 'text' && entry.text)).toEqual(['Ada Example · ada@example.org', '正文', 'Example report · 2026']);
        expect(new Set(plan.entries.map(entry => entry.id)).size).toBe(3);
        expect(plan.entries.filter(entry => entry.kind === 'text' && entry.segmentIndex < 0).every(entry => entry.kind === 'text' && !entry.translated)).toBe(true);
        expect(buildPdfReadingPlan(document([{source: 'Body paragraph'}]), sourcePage, ['正文'])).toEqual(plan);
    });
    it('retains unsegmented static text reconstructed from source lines with stable block identities', () => {
        const sourcePage = page([block(-1, {kind: 'metadata', y: 10, lines: [{x: 20, y: 10, width: 100, height: 12, text: 'Ada'}, {x: 20, y: 23, width: 100, height: 12, text: 'Example'}]}), block(-1, {kind: 'footer', y: 740, lines: []})]);
        const texts = buildPdfReadingPlan(document([]), sourcePage, []).entries.filter(entry => entry.kind === 'text');
        expect(texts).toHaveLength(1); expect(texts[0]).toMatchObject({id: 'pdf-3-block-0', segmentIndex: -1, source: 'Ada Example', text: 'Ada Example', translated: false});
    });
    it('does not confuse source-only math and controls with unrelated source-only metadata', () => {
        const sourcePage = page([
            {...block(-1, {kind: 'metadata', y: 10}), source: 'Ada Example'},
            {...block(-1, {kind: 'formula', y: 100, preserveSource: true}), source: 'x = y'},
            {...block(-1, {kind: 'footer', y: 740}), source: 'Footer source'},
            {...block(-1, {kind: 'metadata', y: 40}), source: 'Legacy\u0001'},
        ]);
        const plan = buildPdfReadingPlan(document([]), sourcePage, []);
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text)).toEqual(['Ada Example', 'Footer source']);
        expect(plan.entries.filter(entry => entry.kind === 'region')).toHaveLength(2);
        expect(plan.entries.filter(entry => entry.kind === 'region').every(entry => entry.segmentIndexes.length === 0)).toBe(true);
        expect(new Set(plan.entries.map(entry => entry.id)).size).toBe(plan.entries.length);
    });
    it('retains full long translations with stable segment links and explicit multi-column reading order', () => {
        const doc = document([{source: 'right'}, {source: 'left', role: 'heading'}]);
        const sourcePage = page([block(0, {readingOrder: 4, kind: 'text'}), block(1, {readingOrder: 1})]);
        const long = '完整译文，保留每个字。'.repeat(1000);
        const before = JSON.stringify({doc, sourcePage});
        const plan = buildPdfReadingPlan(doc, sourcePage, [long, '标题']);
        expect(plan.pageNumber).toBe(3); expect(plan.hasTranslation).toBe(true);
        expect(plan.entries.map(entry => entry.kind === 'text' && entry.segmentIndex)).toEqual([1, 0]);
        expect(plan.entries[0]).toMatchObject({id: 'pdf-3-segment-1', role: 'heading', source: 'left', text: '标题', translated: true});
        expect(plan.entries[1]).toMatchObject({role: 'text', text: long, sourceRect: {x: 20, y: 20, width: 150, height: 30}});
        expect(JSON.stringify({doc, sourcePage})).toBe(before);
    });

    it('retains unchanged and missing translations, empty sources with a valid translation and legacy blocks without metadata', () => {
        const sourcePage = page([block(0), block(1), block(2), block(3), block(7)]);
        const plan = buildPdfReadingPlan(document([{source: 'same'}, {source: 'missing'}, {source: ''}, {source: ''}]), sourcePage, [' same ', '', '有内容']);
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text)).toEqual(['same', 'missing', '有内容']);
        expect(plan.entries[0]).toMatchObject({role: 'paragraph', translated: false});
        expect(plan.hasTranslation).toBe(true);
        expect(buildPdfReadingPlan(document([]), page([]), []).entries).toEqual([]);
        expect(buildPdfReadingPlan(document([{source: 'same'}]), page([block(0)]), ['same']).hasTranslation).toBe(false);
    });

    it('preserves explicit formula and table regions once, adds complete translated annotations, and avoids plain text copies of untranslatable math', () => {
        const sourcePage = page([block(0, {kind: 'formula', preserveSource: true}), block(1, {kind: 'table'}), block(2, {kind: 'figure-label'}), block(3, {preserveSource: true})], {
            preservedRegions: [{id: 'equation', kind: 'formula', x: 10, y: 10, width: 180, height: 45}],
        });
        const plan = buildPdfReadingPlan(document([{source: 'x²'}, {source: 'a b'}, {source: 'Source label'}, {source: 'unknown'}]), sourcePage, ['', '表格完整注释', '图形标签完整译文']);
        expect(plan.entries.filter(entry => entry.kind === 'region')).toHaveLength(4);
        expect(plan.entries[0]).toMatchObject({id: 'pdf-3-region-equation', role: 'formula', segmentIndexes: [0]});
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.segmentIndex)).toEqual([1, 2]);
        expect(plan.entries.some(entry => entry.kind === 'region' && entry.role === 'figure')).toBe(true);
    });

    it('clips negative and page-edge source geometry, rejects empty/nonfinite regions and keeps malformed text geometry readable', () => {
        const sourcePage = page([block(0, {x: NaN}), block(1, {x: -5, y: -4, width: 20, height: 15})], {preservedRegions: [
            {id: 'invalid', kind: 'figure', x: Infinity, y: 0, width: 20, height: 20},
            {id: 'outside', kind: 'figure', x: 900, y: 0, width: 20, height: 20},
            {id: 'edge', kind: 'figure', x: 590, y: 790, width: 50, height: 50},
        ]});
        const plan = buildPdfReadingPlan(document([{source: 'still readable'}, {source: 'negative'}]), sourcePage, []);
        expect(plan.entries.find(entry => entry.kind === 'text' && entry.segmentIndex === 0)?.sourceRect).toEqual({x: 0, y: 0, width: 1, height: 1});
        expect(plan.entries.find(entry => entry.kind === 'text' && entry.segmentIndex === 1)?.sourceRect).toEqual({x: 0, y: 0, width: 15, height: 11});
        expect(plan.entries.filter(entry => entry.kind === 'region')).toEqual([expect.objectContaining({sourceRect: {x: 590, y: 790, width: 10, height: 10}})]);
    });

    it('uses canonical dimensions for quarter turns and places unlinked regions by adjacent source paragraphs', () => {
        const sourcePage = page([block(0), block(1)], {rotation: 90, width: 800, height: 600, preservedRegions: [
            {id: 'middle', kind: 'figure', x: 300, y: 55, width: 50, height: 10},
            {id: 'tail', kind: 'figure', x: 590, y: 790, width: 30, height: 30},
        ]});
        const plan = buildPdfReadingPlan(document([{source: 'first'}, {source: 'second'}]), sourcePage, []);
        expect(plan.entries.map(entry => entry.id)).toEqual(['pdf-3-segment-0', 'pdf-3-region-middle', 'pdf-3-segment-1', 'pdf-3-region-tail']);
        expect(plan.entries.find(entry => entry.id === 'pdf-3-region-tail')?.sourceRect).toEqual({x: 590, y: 790, width: 10, height: 10});
    });

    it('keeps author names, emails and footers as compact original text instead of enlarging source crops or translating them', () => {
        const sourcePage = page([block(0, {kind: 'metadata', preserveSource: true}), block(1, {kind: 'footer', preserveSource: true}), block(2, {kind: 'metadata'})]);
        const plan = buildPdfReadingPlan(document([{source: 'Ashish Vaswani · ashish@google.com'}, {source: 'arXiv:1706.03762'}, {source: 'Google Brain'}]), sourcePage, ['作者译文应忽略', '页脚译文应忽略', '机构译文应忽略']);
        expect(plan.entries).toHaveLength(3); expect(plan.hasTranslation).toBe(false);
        expect(plan.entries.map(entry => entry.kind === 'text' && entry.text)).toEqual(['Ashish Vaswani · ashish@google.com', 'arXiv:1706.03762', 'Google Brain']);
        expect(plan.entries.every(entry => entry.kind === 'text' && !entry.translated)).toBe(true);
    });

    it('preserves unchanged source control encodings as exact original regions without rewriting source or translations', () => {
        const doc = document([{source: 'before'}, {source: '\u0093idΓ'}, {source: 'after'}]);
        const sourcePage = page([block(0), block(1, {x: 184.05846, y: 659.8628, width: 24.53219, height: 14.6201, kind: 'text'}), block(2)]);
        const translations = ['前文', '\u0093idΓ', '后文'];
        const before = JSON.stringify({doc, sourcePage, translations});
        const plan = buildPdfReadingPlan(doc, sourcePage, translations);
        expect(plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text)).toEqual(['前文', '后文']);
        expect(plan.entries.filter(entry => entry.kind === 'region')).toEqual([expect.objectContaining({
            segmentIndexes: [1], role: 'text', sourceRect: expect.objectContaining({x: 184.05846, y: 659.8628}),
        })]);
        const rect = plan.entries.find(entry => entry.kind === 'region')!.sourceRect;
        expect(rect.width).toBeCloseTo(24.53219); expect(rect.height).toBeCloseTo(14.6201);
        expect(plan.hasTranslation).toBe(true);
        expect(JSON.stringify({doc, sourcePage, translations})).toBe(before);
    });

    it('limits source preservation to C0, DEL and C1 while keeping tabs, newlines and normal Unicode as text', () => {
        const codes = [0x00, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x1F, 0x20, 0x7E, 0x7F, 0x80, 0x9F, 0xA0];
        const expected = [true, true, false, false, true, true, false, true, true, false, false, true, true, true, false];
        expect(codes.map(code => {
            const source = `A${String.fromCodePoint(code)}B`;
            const plan = buildPdfReadingPlan(document([{source}]), page([block(0)]), [source]);
            return plan.entries.some(entry => entry.kind === 'region');
        })).toEqual(expected);
    });

    it('retains changed translations containing controls for strict font rejection and avoids losing invalid source geometry', () => {
        const doc = document([{source: '\u0093idΓ'}, {source: 'normal source'}, {source: '\u0093bad geometry'}, {source: ''}]);
        const sourcePage = page([block(0), block(1), block(2, {x: NaN}), block(3)]);
        const plan = buildPdfReadingPlan(doc, sourcePage, ['明确译文\u0093', '\u0000translated', '', '']);
        expect(plan.entries.every(entry => entry.kind === 'text')).toBe(true);
        expect(plan.entries.map(entry => entry.kind === 'text' && entry.text)).toEqual(['明确译文\u0093', '\u0000translated', '\u0093bad geometry']);
    });

    it('preserves unchanged control-bearing metadata and footers once, while retaining normal metadata behavior', () => {
        const doc = document([{source: 'author\u0001'}, {source: 'footer\u0080'}]);
        const sourcePage = page([block(0, {kind: 'metadata'}), block(1, {kind: 'footer'})], {preservedRegions: [
            {id: 'existing', kind: 'figure', x: 10, y: 10, width: 180, height: 45},
        ]});
        const plan = buildPdfReadingPlan(doc, sourcePage, []);
        expect(plan.entries.every(entry => entry.kind === 'region')).toBe(true);
        expect(plan.entries).toHaveLength(2);
        expect(plan.hasTranslation).toBe(false);
    });
});
