import {describe, expect, it} from 'vitest';
import {PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, degrees} from 'pdf-lib';
import {normalizePdfAnnotations, PDF_ANNOTATION_LIMIT, pdfHypothesisUrl, type PdfAnnotation} from '@/src/features/document-translation/core/pdfAnnotations';
import {exportPdfAnnotations} from '@/src/features/document-translation/services/pdfAnnotationExport';
import {restoreDocumentHistoryRevisions} from '@/src/features/document-translation/services/history';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';

const mark = (changes: Partial<PdfAnnotation> = {}): PdfAnnotation => ({id: 'mark-1', page: 1, kind: 'highlight', color: 'yellow', quote: 'Selected words', note: '翻译备注', rects: [{x: .1, y: .2, width: .3, height: .04}], ...changes});

describe('PDF annotation history boundary', () => {
    it('clones valid annotations, clips rectangles, preserves reflow identity and bounds stored text', () => {
        const input = mark({quote: 'a'.repeat(5000), note: '中'.repeat(5000), sourceId: 'pdf-1-segment-0', rects: [{x: -.1, y: -.1, width: .4, height: .4}, {x: .8, y: .8, width: .5, height: .5}]});
        const output = normalizePdfAnnotations([input], 1);
        expect(output[0]).toMatchObject({sourceId: input.sourceId, quote: 'a'.repeat(4000), note: '中'.repeat(4000)});
        expect(output[0].rects[0]).toEqual({x: 0, y: 0, width: .30000000000000004, height: .30000000000000004});
        expect(output[0].rects[1].width).toBeCloseTo(.2);
        expect(output[0]).not.toBe(input); expect(output[0].rects).not.toBe(input.rects);
        expect(input.rects[0].x).toBe(-.1);
    });
    it('rejects malformed, duplicate, out-of-page, empty and oversized selections', () => {
        expect(normalizePdfAnnotations(null, 1)).toEqual([]);
        const invalid = [null, 1, {}, mark({id: ''}), mark({id: 'x'.repeat(101)}), mark({page: 0}), mark({page: 2}), mark({page: .5}), mark({kind: 'bad' as any}), mark({color: '__proto__' as any}), mark({quote: ''}), mark({quote: 3 as any}), mark({note: 1 as any}), mark({rects: undefined as any}), mark({rects: []}), mark({rects: Array(129).fill({x: 0, y: 0, width: 1, height: 1})}), mark({rects: [null as any, {x: NaN, y: 0, width: .1, height: .1}, {x: '0' as any, y: 0, width: .1, height: .1}, {x: 2, y: 0, width: 1, height: 1}, {x: 0, y: 0, width: 0, height: 1}]})];
        expect(normalizePdfAnnotations(invalid, 1)).toEqual([]);
        expect(normalizePdfAnnotations([mark(), mark({note: 'duplicate'})], 1)).toEqual([mark()]);
        expect(normalizePdfAnnotations([mark({sourceId: 'x'.repeat(101)})], 1)[0].sourceId).toBeUndefined();
        expect(normalizePdfAnnotations(Array.from({length: 1200}, (_, index) => mark({id: String(index)})), 1)).toHaveLength(PDF_ANNOTATION_LIMIT);
    });
    it('restores annotations with the same document history and ignores them on non-PDF documents', () => {
        const document: ParsedDocument = {fileName: 'test.pdf', format: 'pdf', label: 'PDF', parts: [], segments: [{id: 0, source: 'source'}], binary: {kind: 'pdf', bytes: new Uint8Array(), pages: [{pageNumber: 1, width: 100, height: 100, blocks: [], segmentIndexes: [0]}]}};
        const record = {total: 1, translations: ['target'], parsedVersion: 1, pdfAnnotations: [mark(), mark({page: 4})]};
        expect(restoreDocumentHistoryRevisions(record, document, 1).pdfAnnotations).toEqual([mark()]);
        expect(restoreDocumentHistoryRevisions(record, {...document, binary: undefined}, 1).pdfAnnotations).toBeUndefined();
        expect(restoreDocumentHistoryRevisions({...record, pdfAnnotations: undefined}, document, 1).pdfAnnotations).toBeUndefined();
    });
});

describe('explicit Hypothesis navigation', () => {
    it('uses the official proxy for a public source and removes only the fragment', () => {
        expect(pdfHypothesisUrl('https://arxiv.org/pdf/1706.03762#page=2')).toBe('https://via.hypothes.is/https://arxiv.org/pdf/1706.03762');
        expect(pdfHypothesisUrl('http://example.org/a.pdf')).toBe('https://via.hypothes.is/http://example.org/a.pdf');
    });
    it.each(['', 'not a URL', 'file:///private/paper.pdf', 'blob:https://example.org/id', 'javascript:alert(1)', 'chrome-extension://id/file.pdf', 'https://name:password@example.org/a.pdf', 'https://example.org/a.pdf?token=private', 'http://localhost/a.pdf', 'http://wiki.local/a.pdf', 'http://a.localhost/a.pdf', 'http://intranet/a.pdf', 'http://127.0.0.1/a.pdf', 'http://[::1]/a.pdf', 'https://via.hypothes.is/https://example.org/a.pdf'])('does not forward %s', url => {expect(pdfHypothesisUrl(url)).toBeUndefined();});
});

describe('native PDF annotation export', () => {
    it.each([0, 90, 180, 270, -90])('preserves the source and existing annotations and maps a cropped %i degree page', async angle => {
        const original = await PDFDocument.create();
        const page = original.addPage([600, 800]); page.setCropBox(30, 50, 500, 700); page.setRotation(degrees(angle));
        page.drawText('Original selectable text');
        const prior = original.context.register(original.context.obj({Type: 'Annot', Subtype: 'Text', Rect: [30, 50, 40, 60], Contents: PDFHexString.fromText('Existing note')}));
        page.node.addAnnot(prior);
        const bytes = await original.save(), before = bytes.slice();
        const output = await exportPdfAnnotations(bytes, [mark(), mark({id: 'underline', kind: 'underline', color: 'green', note: ''}), mark({page: 100})]);
        expect(bytes).toEqual(before);
        const exported = await PDFDocument.load(output), restored = exported.getPages()[0];
        expect(restored.getCropBox()).toEqual(page.getCropBox()); expect(restored.getRotation()).toEqual(page.getRotation());
        expect(restored.node.Annots()!.size()).toBe(3);
        const annotation = restored.node.Annots()!.lookup(1, PDFDict);
        expect(annotation.lookup(PDFName.of('Subtype'), PDFName).toString()).toBe('/Highlight');
        expect(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Selected words\n\n翻译备注');
        const quads = annotation.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber());
        const normalized = ((angle % 360) + 360) % 360;
        const point = normalized === 0 ? [80, 610] : normalized === 90 ? [130, 120] : normalized === 180 ? [480, 190] : [430, 680];
        expect(quads.slice(0, 2)).toEqual(point); expect(quads).toHaveLength(8);
        const appearance = annotation.lookup(PDFName.of('AP'), PDFDict); expect(appearance.has(PDFName.of('N'))).toBe(true);
        const underline = restored.node.Annots()!.lookup(2, PDFDict);
        expect(underline.lookup(PDFName.of('Subtype'), PDFName).toString()).toBe('/Underline');
        expect(underline.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Selected words');
    });
    it('handles multiline marks, crop/media intersection and invalid crop fallbacks without dropping original pages', async () => {
        const original = await PDFDocument.create(); const a = original.addPage([100, 200]); a.setCropBox(-10, 20, 150, 150);
        const b = original.addPage([200, 100]); b.setCropBox(300, 300, 10, 10);
        const bytes = await original.save();
        const output = await exportPdfAnnotations(bytes, [mark({rects: [{x: 0, y: 0, width: .2, height: .1}, {x: .1, y: .5, width: .3, height: .1}]}), mark({id: 'two', page: 2, color: 'pink'})]);
        const saved = await PDFDocument.load(output); expect(saved.getPageCount()).toBe(2);
        const quad = (index: number) => saved.getPages()[index].node.Annots()!.lookup(0, PDFDict).lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map(n => (n as PDFNumber).asNumber());
        expect(quad(0)).toHaveLength(16); expect(quad(0).slice(0, 2)).toEqual([0, 170]);
        expect(quad(1).slice(0, 2)).toEqual([20, 80]);
        const empty = await PDFDocument.load(await exportPdfAnnotations(bytes, [])); expect(empty.getPageCount()).toBe(2); expect(empty.getPages()[0].node.Annots()).toBeUndefined();
        await expect(exportPdfAnnotations(new Uint8Array([0, 1, 2]), [mark()])).rejects.toThrow();
    });
});
