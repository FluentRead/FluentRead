import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createPdfPagePreview, paintPdfTranslation, rasterizePdfReadingPages, rasterizePdfTranslationPage, renderPdfReadingPages, renderPdfPageImage} from '@/src/features/document-translation/ui/pdfPreview';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';

const pdf = vi.hoisted(() => ({width: 600, height: 800, render: vi.fn(), cleanup: vi.fn()}));
vi.mock('@/src/features/document-translation/ui/pdfScanPreview', () => ({readPdfScanGraphics: async () => [], cropPdfScanRegions: () => []}));
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
let encodings: Array<{type?: string; quality?: number}>;
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
    encodings = [];
    pdf.width = 600;
    pdf.height = 800;
    pdf.cleanup.mockReset();
    pdf.render.mockReset().mockReturnValue({promise: Promise.resolve(), cancel: vi.fn()});
    vi.stubGlobal('window', {location: {origin: 'chrome-extension://fixture'}});
    vi.stubGlobal('document', {createElement: () => {
        const canvas = {width: 0, height: 0,
            getContext: (): object => context,
            toDataURL: vi.fn((type: string) => {
                sizes.push([canvas.width, canvas.height]);
                if (failEncoding) throw new Error('fixture canvas encoding failure');
                return `data:${type};base64,AQID`;
            }),
            toBlob: (done: (value: Blob | null) => void, type?: string, quality?: number) => {
                encodings.push({type, quality});
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
        const pixels = new Uint8ClampedArray(size[0] * size[1] * 4).fill(255);
        for (let y = sample[1]; y < sample[1] + sample[3]; y += 1) for (let x = sample[0]; x < sample[0] + sample[2]; x += 1) {
            const at = (y * size[0] + x) * 4; pixels.set([10, 30, 50, 255], at);
        }
        context.getImageData.mockReturnValue({data: pixels});
        expect(paintPdfTranslation(canvas, {...input(), rotation, width: size[0], height: size[1], blocks: [block], translations: ['译文']})).toBe(canvas);
        expect(context.transform).toHaveBeenCalledWith(...transform);
        expect(context.getImageData).toHaveBeenCalledOnce();
        expect(context.getImageData).toHaveBeenCalledWith(0, 0, ...size);
        expect(context.fillStyle).toBe('rgb(10, 30, 50)');
        expect(context.rect).toHaveBeenCalledWith(10, 20, 74, 178.5);
        expect(context.fillRect).toHaveBeenCalledWith(8, 18, 34, 44);
        expect(context.fillText).toHaveBeenCalledWith('译文', 10, 20, 74 * 0.985);
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

    it('marks a page-edge translation with an ellipsis rather than silently keeping original prose', () => {
        const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), rotation: 90, width: 200, height: 100, blocks: [{...block, x: 99, y: 199}], translations: ['译文']});
        expect(context.getImageData).toHaveBeenCalledOnce();
        expect(context.getImageData).toHaveBeenCalledWith(0, 0, 200, 100);
        expect(context.rect).toHaveBeenCalledWith(99, 199, 1, 1);
        expect(context.fillRect).toHaveBeenCalled();
        expect(context.fillText).toHaveBeenCalledWith('…', 99, 199, 1);
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
        // 过大的图形包围盒不能把普通正文误判为保护区域；与阅读器相同，仍然替换正文。
        expect(context.fillRect).toHaveBeenCalled(); expect(context.fillText).toHaveBeenCalledOnce();
    });
    it('never trusts original leading beyond the visible page bounds to fit translation', () => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200,
            blocks: [{...block, y: 199, width: 80, height: 12, lineHeight: 80, lineCount: 3}], translations: ['甲']});
        expect(context.fillText).toHaveBeenCalledWith(expect.stringMatching(/…$/u), 10, 199, expect.any(Number));
        expect(context.fillRect).toHaveBeenCalled();
    });
    it.each([0, 90, 180, 270] as const)('clips table glyph erasure and translation within the physical cell at rotation %s', rotation => {
        const quarterTurn = rotation === 90 || rotation === 270;
        const canvas = document.createElement('canvas'); canvas.width = quarterTurn ? 200 : 100; canvas.height = quarterTurn ? 100 : 200;
        const context = canvases[0].getContext();
        const cell = {...block, height: 12, kind: 'table' as const, cellBounds: {x: 9, y: 19.5, width: 32, height: 11},
            lines: [{x: 10, y: 20, width: 30, height: 12, text: 'Source'}]};
        const original = structuredClone(cell);
        paintPdfTranslation(canvas, {...input(), rotation, width: canvas.width, height: canvas.height, blocks: [cell], translations: ['译文']});
        expect(context.fillRect).toHaveBeenCalledWith(10, 20, 30, 10);
        expect(context.rect).toHaveBeenCalledWith(10, 20, 30, 10);
        expect(context.fillText).toHaveBeenCalledOnce();
        expect(context.restore.mock.calls.length).toBe(context.save.mock.calls.length);
        expect(cell).toEqual(original);
    });
    it.each([0, 90, 180, 270] as const)('fully erases descender edge pixels at rotation %s without crossing table borders', rotation => {
        const quarterTurn = rotation === 90 || rotation === 270;
        const canvas = document.createElement('canvas'); canvas.width = quarterTurn ? 1900 : 1469; canvas.height = quarterTurn ? 1469 : 1900;
        const context = canvases[0].getContext();
        // Actual source-page 58 monospace `target`: the g outline fits geometrically,
        // but the old fractional bottom leaves only 0.13 physical pixels of margin.
        const run = {x: 420.76614, y: 611.61159875, width: 28.8984384, height: 8, text: 'target'};
        const cell = {x: 410, y: 607, width: 100, height: 17.53738};
        const source = {...block, x: run.x, y: run.y, width: 60, height: 8, fontSize: 8, lineHeight: 8,
            kind: 'table' as const, cellBounds: cell, lines: [{...run, runs: [run]}]};
        const original = structuredClone(source);
        paintPdfTranslation(canvas, {...input(), rotation, width: quarterTurn ? 792 : 612, height: quarterTurn ? 612 : 792,
            blocks: [source], translations: ['译文']});
        const [left, top, width, height] = context.fillRect.mock.calls[0];
        const scaleX = 1469 / 612, scaleY = 1900 / 792;
        const outlineBottom = 620.75613 * scaleY;
        expect([left, top, width, height].every(Number.isInteger)).toBe(true);
        expect(top + height).toBeGreaterThanOrEqual(Math.ceil(outlineBottom));
        expect(left).toBeGreaterThanOrEqual((cell.x + 0.5) * scaleX);
        expect(left + width).toBeLessThanOrEqual((cell.x + cell.width - 0.5) * scaleX);
        expect(top).toBeGreaterThanOrEqual((cell.y + 0.5) * scaleY);
        expect(top + height).toBeLessThanOrEqual((cell.y + cell.height - 0.5) * scaleY);
        expect(source).toEqual(original);
    });
    it.each([{width: 8, x: 10}, {width: 30, x: 99}])('replaces prose even at a narrow page-edge box $width/$x', geometry => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 200;
        const context = canvases[0].getContext();
        paintPdfTranslation(canvas, {...input(), width: 100, height: 200,
            blocks: [{...block, ...geometry, height: 80}], translations: ['甲']});
        expect(context.fillText).toHaveBeenCalled(); expect(context.fillRect).toHaveBeenCalled();
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
    it('does not encode a PDF OCR image when cancellation arrives after rendering resolves', async () => {
        let rendered!: () => void;
        pdf.render.mockReturnValue({promise: new Promise<void>(resolve => {rendered = resolve;}), cancel: vi.fn()});
        const controller = new AbortController(), reason = new Error('document changed after page rendering');
        const work = renderPdfPageImage(new Uint8Array([1]), 1, 300, controller.signal);
        await vi.waitFor(() => expect(pdf.render).toHaveBeenCalledOnce());
        rendered(); queueMicrotask(() => controller.abort(reason));
        await expect(work).rejects.toBe(reason);
        expect(canvases[0].toDataURL).not.toHaveBeenCalled();
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });
    it.each([false, true])('encodes an OCR page at its rendered dimensions and releases its canvas when encoding fails=%s', async fails => {
        failEncoding = fails;
        const work = renderPdfPageImage(new Uint8Array([1]), 1, 300);
        if (fails) await expect(work).rejects.toThrow('fixture canvas encoding failure');
        else await expect(work).resolves.toMatchObject({image: 'data:image/png;base64,AQID', width: 2500, height: 3333});
        expect(canvases[0].toDataURL).toHaveBeenCalledWith('image/png');
        expect(sizes).toEqual([[2500, 3333]]); expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(pdf.cleanup).toHaveBeenCalledOnce();
    });
    it.each([[6000, 8000], [500, 20000]])('bounds the OCR canvas for an oversized %s x %s page', async (width, height) => {
        pdf.width = width; pdf.height = height;
        const result = await renderPdfPageImage(new Uint8Array([1]), 1, width);
        expect(result.width * result.height).toBeLessThanOrEqual(9_000_000);
        expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(4096);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });
    it.each(['短译文\n', '\n短译文\r\n \t\r\n'])('does not add a continuation note for boundary blank lines: %j', async text => {
        const model = previewDocument();
        if (model.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const original = model.binary.pages[0].blocks[0];
        // 紧贴下方的保留块限制借位；旧算法会把首尾空行算进 10pt 的单行区域并误判溢出。
        const blocks = [{...original, height: 10, fontSize: 10, lineHeight: 10},
            {...original, segmentIndex: -1, y: original.y + 10, preserveSource: true}];
        const result = await rasterizePdfTranslationPage({...input(), blocks, translations: [text]});
        if (result instanceof Uint8Array) throw new Error('PDF raster metadata expected');
        expect(result.overflowNotes).toEqual([]);
        expect(result.textItems?.map(item => item.text)).toEqual(['短译文']);
    });
    it('exports a readable excerpt and full overflow note using one JPEG canvas and one pixel readback', async () => {
        const model = previewDocument();
        const binary = model.binary;
        const original = binary?.kind === 'pdf' ? binary.pages[0].blocks[0] : undefined;
        if (!original) throw new Error('block expected');
        const full = '完整译文 中文 👩‍💻 '.repeat(1000);
        const blocks = [{...original, width: 80}, {...original, segmentIndex: 1, y: 60, width: 80, preserveSource: true}];
        const result = await rasterizePdfTranslationPage({...input(), blocks, translations: [full, '公式'], imageFormat: 'jpeg'});
        expect(result).toMatchObject({format: 'jpeg', data: new Uint8Array([1]), overflowNotes: [{segmentIndex: 0, text: full}]});
        const context = canvases[0].getContext();
        expect(context.fillRect).toHaveBeenCalled();
        expect(context.fillText.mock.calls.map((call: any[]) => call[0]).join('')).toMatch(/…$/u);
        expect(context.fillText.mock.calls.map((call: any[]) => call[0]).join('').length).toBeLessThan(full.length);
        expect(context.getImageData).toHaveBeenCalledOnce();
        expect(encodings).toEqual([{type: 'image/jpeg', quality: 0.95}]);
        expect(canvases).toHaveLength(1);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });

    it('yields during many-block layout so cancellation restores rotated state and frees pixels before encoding', async () => {
        const model = previewDocument();
        const binary = model.binary;
        const block = binary?.kind === 'pdf' ? binary.pages[0].blocks[0] : undefined;
        if (!block) throw new Error('block expected');
        const controller = new AbortController();
        const blocks = Array.from({length: 40}, (_, index) => ({...block, segmentIndex: index, y: 10 + index * 15}));
        pdf.render.mockImplementationOnce(() => {
            const context = canvases[0].getContext();
            context.getImageData.mockImplementationOnce((_x: number, _y: number, width: number, height: number) => {
                setTimeout(() => controller.abort(new Error('layout canceled')), 0);
                return {data: new Uint8ClampedArray(width * height * 4).fill(255)};
            });
            return {promise: Promise.resolve(), cancel: vi.fn()};
        });
        const work = rasterizePdfTranslationPage({...input(), rotation: 180, blocks, translations: blocks.map(() => '译文'), signal: controller.signal, imageFormat: 'jpeg'});
        void work.catch(() => undefined);
        await expect(work).rejects.toThrow('layout canceled');
        const context = canvases[0].getContext();
        expect(context.restore.mock.calls.length).toBe(context.save.mock.calls.length);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect(encodings).toEqual([]);
    });

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

describe('PDF searchable raster metadata', () => {
    it.each(['left', 'center', 'right'] as const)('exports actual painted line position for %s alignment without retaining pixel memory', async textAlign => {
        const block = {segmentIndex: 0, x: 20, y: 30, width: 200, height: 40, fontSize: 12, lineHeight: 14, lineCount: 1, fontFamily: 'sans', fontWeight: 400 as const, textAlign};
        const result = await rasterizePdfTranslationPage({...input(), blocks: [block], translations: ['Searchable line']});
        expect(result).not.toBeInstanceOf(Uint8Array);
        if (result instanceof Uint8Array) throw new Error('Missing searchable metadata');
        expect(result.textItems).toHaveLength(1);
        const item = result.textItems![0];
        const painted = canvases[0].getContext().fillText.mock.calls[0];
        const scale = 2.4;
        const width = Math.min('Searchable line'.length * 8, painted[3]);
        expect(item).toMatchObject({segmentIndex: 0, text: 'Searchable line', y: 30});
        expect(item.width).toBeCloseTo(width / scale);
        expect(item.x).toBeCloseTo((painted[1] - (textAlign === 'center' ? width / 2 : textAlign === 'right' ? width : 0)) / scale);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });

    it('keeps complete selectable lines and source page footer in offline continuation raster pages', async () => {
        const text = 'Offline continuation 🦄 🔬 text. '.repeat(200) + '\n'.repeat(90) + 'Exact final line.';
        const plan = {pageNumber: 3, hasTranslation: true, entries: [{kind: 'text' as const, id: 'long', pageNumber: 3,
            segmentIndex: 0, role: 'paragraph', source: 'Source', text, translated: true, sourceRect: {x: 20, y: 30, width: 200, height: 40}}]};
        const results = [];
        for await (const result of rasterizePdfReadingPages({...input(), pageNumber: 3, plan, footerLabel: 'Source page 3'})) results.push(result);
        expect(results.length).toBeGreaterThan(1);
        const content = results.flatMap(result => result.textItems!.filter(item => item.segmentIndex === 0).map(item => item.text)).join('').replace(/\s/gu, '');
        expect(content).toBe(text.replace(/\s/gu, ''));
        expect(results.every((result, index) => result.textItems!.at(-1)!.text === `Source page 3 · ${index + 1}/${results.length}`)).toBe(true);
        expect(results.every(result => result.textItems!.some(item => item.segmentIndex === 0 && item.text))).toBe(true);
        expect(results.slice(0, -1).every(result => result.height === 792)).toBe(true);
        expect(results.at(-1)).toMatchObject({width: 612, height: 104, textItems: [{text: 'Exact final line.', y: 42}, {segmentIndex: -1, y: 79}]});
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
});
