import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createPdfPagePreview, rasterizePdfTranslationPage} from '@/src/features/document-translation/ui/pdfPreview';
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
let failEncoding: boolean;
const input = () => ({sourceBytes: new Uint8Array([1]), pageNumber: 1, width: pdf.width, height: pdf.height, blocks: [], translations: []});

beforeEach(() => {
    canvases = [];
    sizes = [];
    failEncoding = false;
    pdf.width = 600;
    pdf.height = 800;
    pdf.cleanup.mockReset();
    pdf.render.mockReset().mockReturnValue({promise: Promise.resolve(), cancel: vi.fn()});
    vi.stubGlobal('window', {location: {origin: 'chrome-extension://fixture'}});
    vi.stubGlobal('document', {createElement: () => {
        const canvas = {width: 0, height: 0,
            getContext: () => ({fillRect: vi.fn()}),
            toBlob: (done: (value: Blob | null) => void) => {
                sizes.push([canvas.width, canvas.height]);
                done(failEncoding ? null : new Blob([new Uint8Array([1])]));
            },
        };
        canvases.push(canvas);
        return canvas;
    }});
});
afterEach(() => vi.unstubAllGlobals());

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
        const page = input();
        const document = {binary: {kind: 'pdf', bytes: page.sourceBytes, pages: [page]}} as unknown as ParsedDocument;
        const preview = await createPdfPagePreview(document, 1, []);
        expect(preview.original).toEqual(new Uint8Array([1]));
        expect(preview.translated).toEqual(new Uint8Array([1]));
        expect(sizes).toHaveLength(2);
        expect(canvases).toHaveLength(1);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });
});
