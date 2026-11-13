import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import type {PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {updatePdfOcrTextLayer} from '@/src/features/document-translation/ui/pdfOcrTextLayer';

const page = (): PdfDocumentPage => ({pageNumber: 2, width: 600, height: 800, ocrRecognized: true, segmentIndexes: [0], blocks: [{
    segmentIndex: 0, x: 40, y: 60, width: 200, height: 40, fontSize: 12, lineHeight: 14, lineCount: 2, fontFamily: 'serif', fontWeight: 400, textAlign: 'left',
    lines: [{text: 'First line <safe>', x: 40, y: 60, width: 180, height: 10}, {text: '第二行 3,700', x: 40, y: 74, width: 120, height: 11, fontSize: 13, fontFamily: 'sans-serif'}],
}]});
function setup(measured: number | null = 60) {
    const {document} = parseHTML('<html><body><div data-main-rotation="90"><span>previous</span></div></body></html>');
    const element = document.querySelector('div') as HTMLElement;
    const create = document.createElement.bind(document), canvases: HTMLCanvasElement[] = [];
    const context = {font: '', measureText: vi.fn(() => ({width: measured}))};
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const node = create(tag);
        if (tag === 'canvas') {canvases.push(node as HTMLCanvasElement); Object.assign(node, {width: 1, height: 1, getContext: () => measured === null ? null : context});}
        return node;
    });
    return {element, canvases, context, document};
}

describe('selectable scanned PDF source', () => {
    it('positions transparent text from OCR line geometry, resets source rotation and keeps source text safe', () => {
        const {element, canvases, context} = setup(), model = page(), original = structuredClone(model);
        updatePdfOcrTextLayer(element, model);
        const spans = [...element.querySelectorAll<HTMLElement>('span')];
        expect(spans.map(span => span.textContent)).toEqual(['First line <safe>', '第二行 3,700']);
        expect(element.querySelector('safe')).toBeNull(); expect(element.querySelectorAll('br')).toHaveLength(2);
        expect(spans[0].style.left).toBe('40px'); expect(spans[0].style.top).toBe('60px');
        expect(spans[0].style.transform).toBe('scaleX(3)'); expect(spans[0].style.fontSize).toBe('12px');
        expect(spans[1].style.fontFamily).toBe('sans-serif'); expect(spans[1].style.fontSize).toBe('13px');
        expect(element.getAttribute('data-fluentread-pdf-page-text')).toBe('First line <safe> 第二行 3,700');
        expect(element.getAttribute('data-pdf-page-number')).toBe('2'); expect(element.hasAttribute('data-main-rotation')).toBe(false);
        expect(element.style.width).toBe('600px'); expect(element.style.height).toBe('800px');
        expect(context.measureText).toHaveBeenCalledTimes(2); expect(canvases.every(canvas => !canvas.width && !canvas.height)).toBe(true);
        expect(model).toEqual(original);
    });

    it('retains exact nodes through equivalent checkpoints and refreshes only changed OCR contents', () => {
        const {element, canvases} = setup(), model = page();
        updatePdfOcrTextLayer(element, model); const first = element.firstChild;
        updatePdfOcrTextLayer(element, structuredClone(model));
        expect(element.firstChild).toBe(first); expect(canvases).toHaveLength(1);
        model.blocks[0].lines![0].text = 'Corrected source'; updatePdfOcrTextLayer(element, model);
        expect(element.firstChild).not.toBe(first); expect(element.firstChild?.textContent).toBe('Corrected source');
        expect(canvases).toHaveLength(2);
    });

    it('supports earlier OCR snapshots but leaves native or still-pending pages untouched', () => {
        const {element, canvases} = setup(), model = page(), previous = element.firstChild;
        delete model.ocrRecognized; updatePdfOcrTextLayer(element, model); expect(element.firstChild).toBe(previous);
        model.ocrReviewRegions = []; model.scanned = true; updatePdfOcrTextLayer(element, model); expect(element.firstChild).toBe(previous);
        delete model.scanned; updatePdfOcrTextLayer(element, model); expect(element.firstChild).not.toBe(previous);
        expect(canvases).toHaveLength(1);
    });

    it.each([null, 0, -1, NaN, Infinity])('uses bounded estimated widths when canvas measurement is unavailable (%s)', width => {
        const {element, canvases} = setup(width), model = page(); model.blocks[0].fontFamily = '';
        model.blocks[0].fontSize = .001; model.blocks[0].lines = [{text: 'x', x: 1, y: 1, width: 5, height: 1}];
        updatePdfOcrTextLayer(element, model);
        const span = element.querySelector('span')!;
        expect(span.style.transform).toBe('scaleX(5)'); expect(span.style.fontFamily).toBe('sans-serif');
        expect(canvases[0].width).toBe(0);
    });

    it.each([
        {text: ' '}, {x: NaN}, {x: -1}, {y: -1}, {width: 0}, {height: 0}, {fontSize: 0}, {x: 590, width: 20}, {y: 795, height: 10},
    ])('omits invalid OCR line geometry without replacing an existing layer (%j)', patch => {
        const {element, canvases} = setup(), model = page(), before = element.firstChild;
        model.blocks[0].lines = [{...model.blocks[0].lines![0], ...patch}];
        updatePdfOcrTextLayer(element, model);
        expect(element.firstChild).toBe(before); expect(canvases).toHaveLength(0);
    });

    it('keeps pages without positioned OCR lines unchanged', () => {
        const {element} = setup(), model = page(), before = element.firstChild;
        delete model.blocks[0].lines; updatePdfOcrTextLayer(element, model); expect(element.firstChild).toBe(before);
    });

    it('releases measurement resources on failure without publishing a partial layer', () => {
        const {element, context, canvases} = setup(), before = element.firstChild;
        context.measureText.mockImplementationOnce(() => ({width: 60})).mockImplementationOnce(() => {throw new Error('measure failed');});
        expect(() => updatePdfOcrTextLayer(element, page())).toThrow('measure failed');
        expect(element.firstChild).toBe(before); expect(canvases[0].width).toBe(0);
    });
});
