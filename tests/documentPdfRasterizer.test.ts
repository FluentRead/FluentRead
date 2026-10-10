import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createPdfPagePreview, paintPdfTranslation, rasterizePdfReadingPages, rasterizePdfTranslationPage, renderPdfReadingPages} from '@/src/features/document-translation/ui/pdfPreview';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';

const pdf = vi.hoisted(() => ({width: 600, height: 800, render: vi.fn(), cleanup: vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({promise: Promise.resolve({getPage: async () => ({
        getViewport: ({scale}: {scale: number}) => ({width: pdf.width * scale, height: pdf.height * scale}),
        render: pdf.render, cleanup: pdf.cleanup,
    })})}),
}));

let canvases: any[];
let sizes: Array<[number, number]>;
let paintedTextCountsAtEncoding: number[];
let failEncoding: boolean;
const input = () => ({sourceBytes: new Uint8Array([1]), pageNumber: 1, width: pdf.width, height: pdf.height, blocks: [], translations: []});
const previewDocument = (): ParsedDocument => ({
    fileName: 'sample.pdf', format: 'pdf', label: 'PDF 文件', parts: [],
    segments: [{id: 0, source: 'Original text', contextLabel: '第 1 页', role: 'paragraph'}],
    binary: {kind: 'pdf', bytes: new Uint8Array([1]), pages: [{
        pageNumber: 1, width: pdf.width, height: pdf.height, segmentIndexes: [0],
        blocks: [{segmentIndex: 0, x: 20, y: 30, width: 200, height: 12,
            fontSize: 12, lineHeight: 12, lineCount: 1, fontFamily: 'sans-serif', fontWeight: 600, textAlign: 'left'}],
    }]},
});

beforeEach(() => {
    canvases = [];
    sizes = [];
    paintedTextCountsAtEncoding = [];
    failEncoding = false;
    pdf.width = 600;
    pdf.height = 800;
    pdf.cleanup.mockReset();
    pdf.render.mockReset().mockReturnValue({promise: Promise.resolve(), cancel: vi.fn()});
    vi.stubGlobal('window', {location: {origin: 'chrome-extension://fixture'}});
    vi.stubGlobal('document', {createElement: () => {
        const canvas = {width: 0, height: 0,
            getContext: (): object => context,
            toBlob: (done: (value: Blob | null) => void) => {
                sizes.push([canvas.width, canvas.height]);
                paintedTextCountsAtEncoding.push(context.fillText.mock.calls.length);
                done(failEncoding ? null : new Blob([new Uint8Array([1])]));
            },
        };
        const context = {canvas, fillRect: vi.fn(), fillText: vi.fn(),
            measureText: vi.fn((value: string) => ({width: value.length * 8})),
            getImageData: vi.fn((_x: number, _y: number, width: number, height: number) =>
                ({data: new Uint8ClampedArray(width * height * 4).fill(255)})),
            save: vi.fn(), restore: vi.fn(), transform: vi.fn(), scale: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
        };
        canvases.push(canvas);
        return canvas;
    }});
});
afterEach(() => vi.unstubAllGlobals());

describe('PDF visible-text renderer resource lifecycle', () => {
    const text = {kind: 'text' as const, id: 't', pageNumber: 1, segmentIndex: 0, role: 'paragraph',
        source: 'source', text: '中文可复制。'.repeat(1000), translated: true, sourceRect: {x: 20, y: 30, width: 100, height: 20}};
    const region = {kind: 'region' as const, id: 'r', pageNumber: 1, role: 'figure', segmentIndexes: [],
        sourceRect: {x: 20, y: 30, width: 100, height: 750}};
    const rendererInput = (regions = true) => ({...input(), measureText: (value: string) => value.length * 12,
        plan: {pageNumber: 1, hasTranslation: true, entries: regions ? [region, text] : [text]},
    });

    it('does not create Canvas or rasterize any text for text-only continuation pages', async () => {
        const pages = [];
        for await (const page of renderPdfReadingPages(rendererInput(false))) pages.push(page);
        expect(pages.length).toBeGreaterThan(1);
        expect(pages.every(page => !page.regionImage && page.items.every(item => item.kind === 'text'))).toBe(true);
        expect(canvases).toHaveLength(0);
        expect(pdf.render).not.toHaveBeenCalled();
    });

    it('keeps two bounded canvases for many continuation pages and releases pixel memory', async () => {
        const pages = [];
        for await (const page of renderPdfReadingPages(rendererInput())) pages.push(page);
        expect(pages.length).toBeGreaterThan(4);
        expect(pages.some(page => page.regionImage)).toBe(true);
        expect(pages.some(page => page.items.some(item => item.kind === 'text'))).toBe(true);
        expect(canvases).toHaveLength(2);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(paintedTextCountsAtEncoding.every(count => count === 0)).toBe(true);
        expect(sizes.every(([width, height]) => width === 1224 && height === 1584)).toBe(true);
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });

    it.each(['break', 'cancel', 'encoding failure'] as const)('releases source and region canvases after %s', async reason => {
        const controller = new AbortController();
        const run = async () => {
            if (reason === 'encoding failure') failEncoding = true;
            for await (const _page of renderPdfReadingPages({...rendererInput(), signal: controller.signal})) {
                if (reason === 'break') break;
                controller.abort(new Error('Canceled region export'));
            }
        };
        if (reason === 'cancel') await expect(run()).rejects.toThrow('Canceled region export');
        else if (reason === 'encoding failure') await expect(run()).rejects.toThrow('无法生成');
        else await run();
        expect(canvases).toHaveLength(2);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
});

describe('PDF translation painter rotated geometry', () => {
    const block = {segmentIndex: 0, x: 10, y: 20, width: 30, height: 40, fontSize: 12, lineHeight: 12, lineCount: 1, fontFamily: 'sans-serif', fontWeight: 400 as const, textAlign: 'left' as const};
    it.each([
        {rotation: 90 as const, size: [200, 100], transform: [0, 1, -1, 0, 200, 0], sample: [140, 10, 40, 30]},
        {rotation: 180 as const, size: [100, 200], transform: [-1, 0, 0, -1, 100, 200], sample: [60, 140, 30, 40]},
        {rotation: 270 as const, size: [200, 100], transform: [0, -1, 1, 0, 0, 100], sample: [20, 60, 40, 30]},
    ])('samples actual pixel coordinates and paints virtual content at $rotation degrees without a second Canvas', ({rotation, size, transform, sample}) => {
        const canvas = document.createElement('canvas'); canvas.width = size[0]; canvas.height = size[1];
        const context = canvases[0].getContext(); const originalBlock = JSON.stringify(block);
        expect(paintPdfTranslation(canvas, {...input(), rotation, width: size[0], height: size[1], blocks: [block], translations: ['译文']})).toBe(canvas);
        expect(context.transform).toHaveBeenCalledWith(...transform);
        expect(context.getImageData).toHaveBeenLastCalledWith(...sample);
        expect(context.rect).toHaveBeenCalledWith(10, 20, 30, 40);
        expect(context.fillRect).toHaveBeenCalledWith(8, 18, 34, 44);
        expect(context.fillText).toHaveBeenCalledWith('译文', 10, expect.any(Number), 27);
        expect(context.save).toHaveBeenCalledTimes(2); expect(context.restore).toHaveBeenCalledTimes(2);
        expect(canvases).toHaveLength(1); expect(canvas.width).toBe(size[0]); expect(canvas.height).toBe(size[1]);
        expect(JSON.stringify(block)).toBe(originalBlock);
    });

    it.each(['sampling', 'transform', 'painting'] as const)('restores Canvas state when rotated %s fails', phase => {
        const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
        const context = canvases[0].getContext();
        const fail = () => {throw new Error(`${phase} failed`);};
        if (phase === 'sampling') context.getImageData.mockImplementationOnce(fail);
        else if (phase === 'transform') context.transform.mockImplementationOnce(fail);
        else context.fillText.mockImplementationOnce(fail);
        expect(() => paintPdfTranslation(canvas, {...input(), rotation: 90, width: 200, height: 100, blocks: [block], translations: ['译文']})).toThrow(`${phase} failed`);
        expect(context.restore.mock.calls.length).toBe(context.save.mock.calls.length);
        expect(context.restore).toHaveBeenCalled(); expect(canvases).toHaveLength(1);
    });

    it('keeps original text when a page-edge box cannot hold a readable translation', () => {
        const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), rotation: 90, width: 200, height: 100, blocks: [{...block, x: 99, y: 199}], translations: ['译文']});
        expect(context.getImageData).toHaveBeenLastCalledWith(0, 99, 1, 1);
        expect(context.rect).not.toHaveBeenCalled();
        expect(context.fillRect).not.toHaveBeenCalled();
        expect(context.fillText).not.toHaveBeenCalled();
    });

    it('preserves formulas and graphics, and erases only original glyph runs for fitting text', () => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
        const context = canvases[0].getContext();
        const fitting = {...block, width: 80, lines: [{x: 10, y: 20, width: 50, height: 12, text: 'Original', runs: [{x: 10, y: 20, width: 20, height: 12, text: 'One'}]}]};
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200, blocks: [fitting, {...block, segmentIndex: 1, preserveSource: true}], translations: ['译文', '公式']});
        expect(context.fillRect).toHaveBeenCalledWith(8, 18, 24, 16);
        expect(context.fillText).toHaveBeenCalledOnce();
        expect(context.font).toContain('sans-serif');
        context.fillText.mockClear(); context.fillRect.mockClear();
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200, blocks: [fitting], preservedRegions: [{id: 'r', kind: 'figure', x: 10, y: 20, width: 50, height: 50}], translations: ['译文']});
        expect(context.fillRect).not.toHaveBeenCalled(); expect(context.fillText).not.toHaveBeenCalled();
    });
    it('never trusts original leading beyond the visible page bounds to fit translation', () => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200,
            blocks: [{...block, y: 199, width: 80, height: 12, lineHeight: 80, lineCount: 3}], translations: ['甲']});
        expect(context.fillText).not.toHaveBeenCalled(); expect(context.fillRect).not.toHaveBeenCalled();
    });
    it.each([{width: 8, x: 10}, {width: 30, x: 99}])('preserves source when a single Chinese glyph is wider than the actual remaining box $width/$x', geometry => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200,
            blocks: [{...block, ...geometry, height: 80}], translations: ['甲']});
        expect(context.fillText).not.toHaveBeenCalled(); expect(context.fillRect).not.toHaveBeenCalled();
    });
});

describe('PDF readable export complete content and resource lifecycle', () => {
    const plan = (text = '完整译文'.repeat(1000) + '最终尾文') => ({pageNumber: 1, hasTranslation: true, entries: [{kind: 'text' as const, id: 's0', pageNumber: 1, segmentIndex: 0, role: 'paragraph', source: 'Original', text, translated: true, sourceRect: {x: 0, y: 0, width: 100, height: 20}}]});
    it('streams fixed-size pages with every character and releases pixels when the consumer ends early', async () => {
        const expected = plan();
        const pages = [];
        for await (const page of rasterizePdfReadingPages({...input(), plan: expected})) pages.push(page);
        expect(pages.length).toBeGreaterThan(1);
        expect(pages.every(page => page.width === 612 && page.height === 792)).toBe(true);
        expect(canvases[0].getContext().fillText.mock.calls.map((args: any[]) => args[0]).join('')).toBe(expected.entries[0].text);
        expect(canvases).toHaveLength(1);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        for await (const _page of rasterizePdfReadingPages({...input(), plan: expected})) break;
        expect(canvases[1]).toMatchObject({width: 0, height: 0});
    });
    it('releases all canvases after encoding failure or cancellation', async () => {
        failEncoding = true;
        await expect(async () => {for await (const _page of rasterizePdfReadingPages({...input(), plan: plan('内容')})) {}}).rejects.toThrow('无法生成');
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        failEncoding = false;
        const controller = new AbortController();
        await expect(async () => {for await (const _page of rasterizePdfReadingPages({...input(), plan: plan(), signal: controller.signal})) controller.abort(new Error('cancel'));}).rejects.toThrow('cancel');
        expect(canvases[1]).toMatchObject({width: 0, height: 0});
    });
    it.each([0, 90, 180, 270] as const)('copies original graphic pixels and releases source at rotation %s', async rotation => {
        const expected = {...plan('前文'), entries: [{kind: 'region' as const, id: 'r', pageNumber: 1, role: 'figure', sourceRect: {x: 10, y: 20, width: 100, height: 200}, segmentIndexes: []}]};
        for await (const _page of rasterizePdfReadingPages({...input(), rotation, plan: expected})) {}
        expect(canvases).toHaveLength(2);
        expect(canvases[0].getContext().drawImage).toHaveBeenCalledOnce();
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
});

describe('PDF rasterizer resource lifecycle', () => {
    it('uses one canvas and releases its pixels after successful export', async () => {
        await rasterizePdfTranslationPage(input());
        expect(canvases).toHaveLength(1);
        expect(sizes).toEqual([[1440, 1920]]);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });

    it.each([[20_000, 30_000], [600, 100_000]])('bounds oversized %s x %s pages', async (width, height) => {
        pdf.width = width;
        pdf.height = height;
        await rasterizePdfTranslationPage(input());
        expect(sizes[0][0] * sizes[0][1]).toBeLessThanOrEqual(4_000_000);
        expect(Math.max(...sizes[0])).toBeLessThanOrEqual(8192);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });

    it('releases the canvas when encoding fails', async () => {
        failEncoding = true;
        await expect(rasterizePdfTranslationPage(input())).rejects.toThrow('无法生成');
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });

    it('cancels an active PDF.js render and releases the canvas on rejection', async () => {
        const controller = new AbortController();
        let reject!: (reason: Error) => void;
        const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
        const cancel = vi.fn(() => reject(new Error('Rendering cancelled')));
        pdf.render.mockReturnValue({promise: pending, cancel});
        const work = rasterizePdfTranslationPage({...input(), signal: controller.signal});
        await vi.waitFor(() => expect(pdf.render).toHaveBeenCalledOnce());
        controller.abort();
        await expect(work).rejects.toThrow('Rendering cancelled');
        expect(cancel).toHaveBeenCalledOnce();
        expect(pdf.cleanup).toHaveBeenCalledOnce();
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(sizes).toHaveLength(0);
    });

    it('encodes the original preview before painting translation and releases the shared canvas', async () => {
        const preview = await createPdfPagePreview(previewDocument(), 1, ['Translated text']);
        expect(preview.original).toEqual(new Uint8Array([1]));
        expect(preview.translated).toEqual(new Uint8Array([1]));
        expect(sizes).toHaveLength(2);
        expect(paintedTextCountsAtEncoding).toEqual([0, 1]);
        expect(canvases).toHaveLength(1);
        expect(canvases[0].getContext().fillText).toHaveBeenCalledWith('Translated text', expect.any(Number), expect.any(Number), expect.any(Number));
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });

    it.each(['Original text', ' \nOriginal   text\t '])('keeps only the original preview without repainting an equivalent translation %j', async translation => {
        const preview = await createPdfPagePreview(previewDocument(), 1, [translation]);
        expect(preview).toEqual({original: new Uint8Array([1])});
        expect(sizes).toEqual([[1440, 1920]]);
        expect(paintedTextCountsAtEncoding).toEqual([0]);
        expect(canvases).toHaveLength(1);
        expect(canvases[0].getContext().fillText).not.toHaveBeenCalled();
        expect(canvases[0].getContext().fillRect).toHaveBeenCalledOnce();
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });
});
