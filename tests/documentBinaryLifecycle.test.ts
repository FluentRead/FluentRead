import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import {createServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DOCUMENT_MAX_BYTES, PDF_MAX_BYTES, parseDocument, type ParsedDocument, type PdfDocumentBlock} from '@/src/features/document-translation/core/document';
import {assertArchiveSafety, createDocumentDownload, parseBinaryDocument, parseDocumentFile, pdfTextBlocks, pdfTextLines} from '@/src/features/document-translation/services/binary';
import {generateDocumentArchive} from '@/src/features/document-translation/services/archive';
import {createPdfPagePreview, rasterizePdfTranslationPage, releasePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import * as documentPublic from '@/src/features/document-translation/public';

const port = vi.hoisted(() => ({getDocument: vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: port.getDocument}));
const pendingCompletions: Array<() => void> = [];
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); pendingCompletions.push(() => resolve({numPages: 0, getPage: async () => page} as unknown as T)); return {promise, resolve, reject};};
const sourceBytes = () => new TextEncoder().encode('%PDF-fixture');
const block = (overrides: Partial<PdfDocumentBlock> = {}): PdfDocumentBlock => ({segmentIndex: 0, x: 5, y: 5, width: 80, height: 30, fontSize: 12, lineHeight: 12, lineCount: 1, fontFamily: 'sans', fontWeight: 400, textAlign: 'left', ...overrides});
const input = (bytes = sourceBytes(), blocks: PdfDocumentBlock[] = []) => ({sourceBytes: bytes, pageNumber: 1, width: 100, height: 100, blocks, translations: ['译文']});
const model = (bytes = sourceBytes(), blocks: PdfDocumentBlock[] = []) => ({fileName: 'sample.pdf', format: 'pdf', segments: [], parts: [], binary: {kind: 'pdf', bytes, pages: [{...input(bytes, blocks), segmentIndexes: []}]}} as unknown as ParsedDocument);
let windowPort: EventTarget;
let canvases: any[];
let context: any;
let encode: (done: (blob: Blob | null) => void) => void;
let page: any;
let destroy: ReturnType<typeof vi.fn>;
let resourceBytes: Uint8Array[];

beforeEach(() => {
    resourceBytes = []; pendingCompletions.length = 0;
    windowPort = Object.assign(new EventTarget(), {location: {origin: 'chrome-extension://fixture'}});
    vi.stubGlobal('window', windowPort);
    canvases = [];
    context = {fillRect: vi.fn(), measureText: vi.fn((value: string) => ({width: value.length * 8})), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({data: new Uint8ClampedArray(width * height * 4).fill(255)}))};
    encode = done => done(new Blob([new Uint8Array([1, 2, 3])]));
    vi.stubGlobal('document', {createElement: () => {
        const canvas = {width: 0, height: 0, getContext: () => {context.canvas = canvas; return context;}, toBlob: (done: (blob: Blob | null) => void) => encode(done)};
        canvases.push(canvas); return canvas;
    }});
    page = {getViewport: ({scale}: {scale: number}) => ({width: 100 * scale, height: 100 * scale, transform: [1, 0, 0, 1, 0, 0]}), cleanup: vi.fn(), render: vi.fn(() => ({promise: Promise.resolve(), cancel: vi.fn()})), getTextContent: vi.fn(async () => ({items: [{str: 'Body', transform: [1, 0, 0, 12, 5, 20], width: 60, height: 12, fontName: 'body'}], styles: {}}))};
    destroy = vi.fn(async () => {});
    port.getDocument.mockReset().mockImplementation(() => ({promise: Promise.resolve({numPages: 1, getPage: async () => page}), destroy}));
});
afterEach(async () => {pendingCompletions.forEach(complete => complete()); windowPort.dispatchEvent(new Event('pagehide')); resourceBytes.forEach(bytes => {if (typeof releasePdfDocument === 'function') releasePdfDocument(bytes);}); await vi.dynamicImportSettled(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

async function epub(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('OPS/ch.xhtml', '<html><head><title>Title</title></head><body><p>Original text</p></body></html>');
    zip.file('META-INF/container.xml', '<container><rootfile full-path="OPS/content.opf"/></container>');
    zip.file('OPS/content.opf', '<package><manifest><item id="one" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
    zip.file('OPS/asset.bin', new Uint8Array([7, 8, 9]));
    zip.file('1', 'numeric resource');
    zip.file('mimetype', 'application/epub+zip');
    return generateDocumentArchive(zip, {compression: 'DEFLATE'});
}

describe('documentbinaryAudit actual import and package boundaries', () => {
    it('uses actual bytes even when the file size port lies, and validates metadata before reading', async () => {
        const read = vi.fn(async () => new ArrayBuffer(DOCUMENT_MAX_BYTES + 1));
        await expect(parseDocumentFile({name: 'fake.docx', size: 1, arrayBuffer: read, text: async () => ''})).rejects.toThrow('文件大小超过');
        await expect(parseDocumentFile({name: 'big.txt', size: DOCUMENT_MAX_BYTES + 1, text: vi.fn(), arrayBuffer: vi.fn()})).rejects.toThrow('文件大小超过');
        // PDF 使用更宽的上限：超过通用上限的文件照常进入解析，超过 PDF 上限才按大小拒绝。
        await expect(parseBinaryDocument('big.pdf', new Uint8Array(DOCUMENT_MAX_BYTES + 1))).rejects.toThrow('PDF 文件签名无效');
        await expect(parseBinaryDocument('big.pdf', new Uint8Array(PDF_MAX_BYTES + 1))).rejects.toThrow('文件大小超过 50 MB');
        await expect(parseDocumentFile({name: 'utf8.txt', text: async () => '汉'.repeat(Math.ceil(DOCUMENT_MAX_BYTES / 3)), arrayBuffer: vi.fn()})).rejects.toThrow('文件大小超过');
        await expect(parseDocumentFile({name: 'invalid.txt', size: NaN, text: vi.fn(), arrayBuffer: vi.fn()})).rejects.toThrow('大小无效');
    });

    it('blocks early and late canceled File reads without parsing or committing results', async () => {
        const controller = new AbortController();
        const pending = deferred<string>();
        const file = {name: 'sample.txt', text: vi.fn(() => pending.promise), arrayBuffer: vi.fn()};
        const work = parseDocumentFile(file, {signal: controller.signal});
    void work.catch(() => undefined);
        controller.abort(new Error('stale file'));
        pending.resolve('Visible');
        await expect(work).rejects.toThrow('stale file');
        file.text.mockClear();
        await expect(parseDocumentFile(file, {signal: controller.signal})).rejects.toThrow('stale file');
        expect(file.text).not.toHaveBeenCalled();
        await expect(parseBinaryDocument('sample.pdf', sourceBytes(), {signal: controller.signal})).rejects.toThrow('stale file');
        expect(port.getDocument).not.toHaveBeenCalled();
    });

    it('rejects invalid central directory sizes without allowing negative totals to offset large entries', () => {
        for (const size of [NaN, -1, Infinity, 0.5]) expect(() => assertArchiveSafety({files: {bad: {_data: {uncompressedSize: size}}}} as unknown as JSZip, 'DOCX')).toThrow('大小无效');
    });

    it.each(['translated', 'bilingual'] as const)('exports edited ePub as a real ZIP with first stored mimetype and unchanged resources in %s mode', async mode => {
        const bytes = await epub();
        const before = new Uint8Array(bytes);
        const document = await parseBinaryDocument('sample.epub', bytes, {signal: new AbortController().signal});
        const download = await createDocumentDownload(document, ['UI 校订 & <tag>'], mode);
        const output = download.data as Uint8Array;
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        expect(view.getUint32(0, true)).toBe(0x04034b50);
        expect(view.getUint16(8, true)).toBe(0);
        expect(new TextDecoder().decode(output.subarray(30, 30 + view.getUint16(26, true)))).toBe('mimetype');
        const zip = await JSZip.loadAsync(output);
        expect(await zip.file('1')!.async('string')).toBe('numeric resource');
        expect(await zip.file('OPS/asset.bin')!.async('uint8array')).toEqual(new Uint8Array([7, 8, 9]));
        expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
        expect(await zip.file('OPS/ch.xhtml')!.async('string')).toContain('UI 校订 &amp; &lt;tag&gt;');
        expect(zip.file('META-INF/container.xml')).not.toBeNull();
        expect(zip.file('OPS/content.opf')).not.toBeNull();
        expect(bytes).toEqual(before);
    });

    it('cleans the current PDF page after extraction failure and destroys the loading task once', async () => {
        page.getTextContent.mockRejectedValue(new Error('text failed'));
        await expect(parseBinaryDocument('bad.pdf', sourceBytes())).rejects.toThrow('text failed');
        expect(page.cleanup).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('destroys a pending PDF import on cancellation and rejects its late completion', async () => {
        const pending = deferred<any>();
        port.getDocument.mockReturnValue({promise: pending.promise, destroy});
        const controller = new AbortController();
        const work = parseBinaryDocument('pending.pdf', sourceBytes(), {signal: controller.signal});
    void work.catch(() => undefined);
        await vi.waitFor(() => expect(port.getDocument).toHaveBeenCalledOnce());
        controller.abort(new Error('closed import'));
        expect(destroy).toHaveBeenCalledOnce();
        pending.resolve({numPages: 1, getPage: vi.fn()});
        await expect(work).rejects.toThrow('closed import');
        expect(destroy).toHaveBeenCalledOnce();
    });

    it.each(['page', 'text'] as const)('settles canceled PDF %s extraction promptly and releases the late page', async stage => {
        const pending = deferred<any>();
        const getPage = vi.fn(() => stage === 'page' ? pending.promise : Promise.resolve(page));
        if (stage === 'text') page.getTextContent.mockReturnValueOnce(pending.promise);
        port.getDocument.mockReturnValueOnce({promise: Promise.resolve({numPages: 1, getPage}), destroy});
        const controller = new AbortController();
        const work = parseBinaryDocument('pending.pdf', sourceBytes(), {signal: controller.signal});
        void work.catch(() => undefined);
        await vi.waitFor(() => expect(stage === 'page' ? getPage : page.getTextContent).toHaveBeenCalledOnce());
        controller.abort(new Error('extraction stopped'));
        await expect(work).rejects.toThrow('extraction stopped');
        expect(destroy).toHaveBeenCalledOnce();
        pending.resolve(stage === 'page' ? page : {items: [], styles: {}});
        await Promise.resolve();
        expect(page.cleanup).toHaveBeenCalledOnce();
        if (stage === 'page') expect(page.getTextContent).not.toHaveBeenCalled();
    });

    it('preserves synchronous PDF page cancellation when its late cleanup port fails', async () => {
        const controller = new AbortController();
        page.cleanup.mockImplementationOnce(() => {throw new Error('cleanup failed');});
        port.getDocument.mockReturnValueOnce({promise: Promise.resolve({numPages: 1, getPage: () => {
            controller.abort('page stopped'); return Promise.resolve(page);
        }}), destroy});
        await expect(parseBinaryDocument('stopped.pdf', sourceBytes(), {signal: controller.signal})).rejects.toBe('page stopped');
        expect(page.cleanup).toHaveBeenCalledOnce();
        expect(page.getTextContent).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('does not create an archive stream for a preaborted operation and exposes the actual public API', async () => {
        const controller = new AbortController(); controller.abort('stopped');
        const generateInternalStream = vi.fn(() => ({on: vi.fn(), pause: vi.fn(), resume: vi.fn()}));
        await expect(generateDocumentArchive({generateInternalStream} as unknown as JSZip, {}, {signal: controller.signal})).rejects.toBe('stopped');
        expect(generateInternalStream).not.toHaveBeenCalled();
        expect(documentPublic.parseDocumentFile).toBe(parseDocumentFile);
        expect(documentPublic.createPdfPagePreview).toBe(createPdfPagePreview);
        expect(documentPublic.generateDocumentArchive).toBe(generateDocumentArchive);
        expect(documentPublic.parseDocument).toBe(parseDocument);
    });
});

describe('documentbinaryAudit PDF resource consumers', () => {
    it('reuses an active file resource, releases it on pagehide and loads again on retry', async () => {
        const bytes = sourceBytes(); resourceBytes.push(bytes);
        await createPdfPagePreview(model(bytes), 1);
        await createPdfPagePreview(model(bytes), 1, []);
        expect(port.getDocument).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
        windowPort.dispatchEvent(new Event('pagehide'));
        expect(destroy).toHaveBeenCalledOnce();
        await createPdfPagePreview(model(bytes), 1);
        expect(port.getDocument).toHaveBeenCalledTimes(2);
        releasePdfDocument(bytes); releasePdfDocument(bytes);
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(canvases.every(c => c.width === 0 && c.height === 0)).toBe(true);
    });

    it('cancels a pending preview load promptly, destroys it and prevents a late canvas', async () => {
        const pending = deferred<any>();
        port.getDocument.mockReturnValueOnce({promise: pending.promise, destroy});
        const bytes = sourceBytes(); resourceBytes.push(bytes);
        const controller = new AbortController();
        const work = createPdfPagePreview(model(bytes), 1, [], controller.signal);
    void work.catch(() => undefined);
        await vi.waitFor(() => expect(port.getDocument).toHaveBeenCalledOnce());
        controller.abort(new Error('closed preview'));
        await expect(work).rejects.toThrow('closed preview');
        expect(destroy).toHaveBeenCalledOnce();
        pending.resolve({getPage: async () => page});
        await Promise.resolve();
        expect(canvases).toHaveLength(0);
        await createPdfPagePreview(model(bytes), 1);
        expect(port.getDocument).toHaveBeenCalledTimes(2);
    });

    it('isolates cancellation of one shared waiter from another and releases a failed load for retry', async () => {
        const pending = deferred<any>();
        port.getDocument.mockReturnValueOnce({promise: pending.promise, destroy});
        const bytes = sourceBytes(); resourceBytes.push(bytes);
        const controller = new AbortController();
        const canceled = createPdfPagePreview(model(bytes), 1, [], controller.signal);
        const active = createPdfPagePreview(model(bytes), 1);
        controller.abort();
        await expect(canceled).rejects.toMatchObject({name: 'AbortError'});
        expect(destroy).not.toHaveBeenCalled();
        pending.resolve({getPage: async () => page});
        await expect(active).resolves.toHaveProperty('original');
        expect(port.getDocument).toHaveBeenCalledOnce();
        releasePdfDocument(bytes);
        port.getDocument.mockImplementationOnce(() => ({promise: Promise.reject(new Error('load failed')), destroy}));
        await expect(createPdfPagePreview(model(bytes), 1)).rejects.toThrow('load failed');
        await expect(createPdfPagePreview(model(bytes), 1)).resolves.toHaveProperty('original');
    });

    it('releases pixels and rejects encoding canceled before a late blob callback', async () => {
        let callback!: (blob: Blob | null) => void;
        encode = done => {callback = done;};
        const bytes = sourceBytes(); resourceBytes.push(bytes);
        const controller = new AbortController();
        const work = rasterizePdfTranslationPage({...input(bytes), signal: controller.signal});
    void work.catch(() => undefined);
        await vi.waitFor(() => expect(callback).toBeTypeOf('function'));
        controller.abort(new Error('encoding stopped'));
        await expect(work).rejects.toThrow('encoding stopped');
        const arrayBuffer = vi.fn();
        callback({arrayBuffer} as unknown as Blob);
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });

    it('paints clipped layouts, center/right alignments, foreground colors and long words without source mutation', async () => {
        const bytes = sourceBytes(); resourceBytes.push(bytes);
        const blocks = [block(), block({segmentIndex: 1, textAlign: 'center', fontFamily: 'serif'}), block({segmentIndex: 2, textAlign: 'right', width: 2, height: 2, fontSize: 5}), block({segmentIndex: 3})];
        context.getImageData.mockImplementation((_x: number, _y: number, width: number, height: number) => {const data = new Uint8ClampedArray(width * height * 4).fill(255); if (width > 1) {for (let i = 0; i < data.length; i += 4) {data[i] = data[i + 1] = data[i + 2] = 0;}} return {data};});
        const before = JSON.stringify(blocks);
        await rasterizePdfTranslationPage({...input(bytes, blocks), translations: ['First paragraph\r\n\nsecond paragraph', 'center', 'LongUnbrokenWord'.repeat(10), '  ']});
        expect(context.fillText).toHaveBeenCalled();
        // 普通正文不会因原框较小而回退原文：借用空白后绘制；不足时显示省略号并把全文交给批注。
        expect(context.rect).toHaveBeenCalledTimes(3);
        expect(context.save).toHaveBeenCalledTimes(3);
        expect(context.restore).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(blocks)).toBe(before);
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
    });
});

it('documentbinaryAudit bounds actual decompression before forged directory sizes can allocate the entire entry', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', 'A'.repeat(25 * 1024 * 1024));
    const bytes = await generateDocumentArchive(zip, {compression: 'DEFLATE'});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 46 < bytes.length; offset += 1) {
        if (view.getUint32(offset, true) !== 0x02014b50) continue;
        const nameLength = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (name === 'word/document.xml') {view.setUint32(offset + 24, 1, true); break;}
    }
    await expect(parseBinaryDocument('forged.docx', bytes)).rejects.toThrow('实际解压内容过大');
});

it('documentbinaryAudit cancels a live archive text stream, ignores its late events and permits retry', async () => {
    const zip = new JSZip().file('[Content_Types].xml', '<Types/>').file('word/document.xml', '<w:p><w:r><w:t>Original</w:t></w:r></w:p>');
    const entry = zip.file('word/document.xml')!;
    const callbacks: Record<string, (...args: any[]) => void> = {};
    const stream = {on: (event: string, callback: (...args: any[]) => void) => {callbacks[event] = callback; return stream;}, pause: vi.fn(), resume: vi.fn()};
    vi.spyOn(entry as any, 'internalStream').mockReturnValueOnce(stream as any);
    const loader = vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(zip);
    const controller = new AbortController();
    const work = parseBinaryDocument('stream.docx', new Uint8Array([1]), {signal: controller.signal});
    void work.catch(() => undefined);
    await vi.waitFor(() => expect(stream.resume).toHaveBeenCalledOnce());
    callbacks.data(new TextEncoder().encode('<w:p>'));
    controller.abort(new Error('read canceled'));
    callbacks.error(new Error('late stream error')); callbacks.data(new Uint8Array([1])); callbacks.end();
    await expect(work).rejects.toThrow('read canceled');
    expect(stream.pause).toHaveBeenCalledOnce();
    loader.mockRestore();
    const retry = await parseBinaryDocument('retry.epub', await epub());
    expect(retry.segments[0].source).toBe('Original text');
});

it('documentbinaryAudit destroys a failed preview without retaining an unload listener or a stale result', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    Object.assign(windowPort, {
        requestAnimationFrame(callback: FrameRequestCallback) {
            const id = ++frameId;
            frames.set(id, callback);
            queueMicrotask(() => {
                const pending = frames.get(id);
                frames.delete(id);
                pending?.(performance.now());
            });
            return id;
        },
        cancelAnimationFrame(id: number) {frames.delete(id);},
    });
    type PdfApi = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const workerUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
    const actualPdf = await vi.importActual<PdfApi>('pdfjs-dist/legacy/build/pdf.mjs');
    const apiId = '\0document-lifecycle-real-pdf', workerId = '\0document-lifecycle-worker';
    const tasks: Array<ReturnType<PdfApi['getDocument']>> = [];
    const destroyed: Array<{mock: {calls: unknown[][]}}> = [];
    const pages: number[] = [];
    const load = vi.fn((options: Parameters<PdfApi['getDocument']>[0]) => {
        const task = actualPdf.getDocument(options);
        tasks.push(task); destroyed.push(vi.spyOn(task, 'destroy'));
        void task.promise.then(pdf => {pages.push(pdf.numPages);}, () => undefined);
        return task;
    });
    vi.stubGlobal('__fluentreadDocumentLifecyclePdfLoad', load);
    vi.stubGlobal('__fluentreadDocumentLifecyclePdfOptions', actualPdf.GlobalWorkerOptions);
    // Load the entire production module with the native SDK; observe real loading tasks and control asset/Canvas ports.
    // Native PDF.js imports workerSrc itself, so Vite's browser-only /@fs/ URL is not a Node import target.
    const root = resolve(__dirname, '..');
    const source = await PDFDocument.create(); source.addPage([100, 100]);
    const bytes = await source.save(), originalBytes = new Uint8Array(bytes);
    const server = await createServer({root, configFile: false, appType: 'custom', logLevel: 'silent',
        resolve: {alias: {'@': root}}, server: {middlewareMode: true, hmr: false, watch: null},
        optimizeDeps: {noDiscovery: true, include: []}, ssr: {noExternal: ['pdfjs-dist']},
        plugins: [{name: 'document-lifecycle-native-pdf-ports', enforce: 'pre', resolveId(id) {
            if (id === apiId || id === workerId) return id;
            if (id === 'pdfjs-dist/legacy/build/pdf.mjs') return apiId;
            if (id === 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url') return workerId;
            return null;
        }, load(id) {
            if (id === apiId) return `export const GlobalWorkerOptions = globalThis.__fluentreadDocumentLifecyclePdfOptions;
                export const getDocument = options => globalThis.__fluentreadDocumentLifecyclePdfLoad(options);`;
            if (id === workerId) return `export default ${JSON.stringify(workerUrl)};`;
            return null;
        }}]});
    let preview: typeof import('../src/features/document-translation/ui/pdfPreview') | undefined;
    let workerOptions: PdfApi['GlobalWorkerOptions'] | undefined;
    let previousWorkerSrc: string | undefined;
    try {
        workerOptions = (await server.ssrLoadModule(apiId)).GlobalWorkerOptions;
        previousWorkerSrc = workerOptions!.workerSrc;
        preview = await server.ssrLoadModule(resolve(root, 'src/features/document-translation/ui/pdfPreview.ts')) as typeof import('../src/features/document-translation/ui/pdfPreview');
        const work = preview!.createPdfPagePreview(model(bytes), 1);
        void work.catch(() => undefined);
        preview!.releasePdfDocument(bytes);
        await expect(work).rejects.toMatchObject({name: 'AbortError'});
        expect(load).not.toHaveBeenCalled();
        const add = vi.spyOn(windowPort, 'addEventListener'), remove = vi.spyOn(windowPort, 'removeEventListener');
        // A load failure invalidates the cached document. A Canvas failure may
        // reuse a valid parsed document, so exercise the real SDK's load failure.
        bytes.fill(0);
        await expect(preview!.createPdfPagePreview(model(bytes), 1)).rejects.toThrow('Invalid PDF structure');
        expect(load).toHaveBeenCalledOnce(); expect(pages).toEqual([]);
        expect(destroyed[0]).toHaveBeenCalledOnce();
        expect(canvases).toHaveLength(0);
        expect(workerOptions!.workerSrc).toBe(workerUrl);
        expect(remove).toHaveBeenCalledWith('pagehide', add.mock.calls[0][1]);
        windowPort.dispatchEvent(new Event('pagehide'));
        expect(destroyed[0]).toHaveBeenCalledOnce();
        bytes.set(originalBytes);
        Object.assign(context, {transform: vi.fn(), setLineDash: vi.fn(), getTransform: vi.fn(() => ({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}))});
        await expect(preview!.createPdfPagePreview(model(bytes), 1)).resolves.toHaveProperty('original');
        expect(load).toHaveBeenCalledTimes(2); expect(pages).toEqual([1]);
        expect(destroyed[1]).not.toHaveBeenCalled();
        windowPort.dispatchEvent(new Event('pagehide'));
        expect(destroyed.every(spy => spy.mock.calls.length === 1)).toBe(true);
        expect(bytes).toEqual(originalBytes);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(frames.size).toBe(0);
    } finally {
        preview?.releasePdfDocument(bytes);
        await Promise.allSettled(tasks.map(task => task.destroy()));
        frames.clear();
        if (workerOptions && previousWorkerSrc !== undefined) workerOptions.workerSrc = previousWorkerSrc;
        await server.close();
    }
});

it.each(['blob-null', 'blob-reject', 'blob-throw', 'canvas-throw'] as const)('documentbinaryAudit settles %s encoding failure and releases canvas pixels', async kind => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    encode = done => {
        if (kind === 'canvas-throw') throw new Error('encode sync failed');
        if (kind === 'blob-null') done(null);
        else done({arrayBuffer: () => {if (kind === 'blob-throw') throw new Error('encode sync failed'); return Promise.reject(new Error('encode failed'));}} as unknown as Blob);
    };
    await expect(createPdfPagePreview(model(bytes), 1)).rejects.toThrow(kind === 'blob-null' ? '无法生成' : 'encode');
    expect(canvases[0]).toMatchObject({width: 0, height: 0});
});

it('documentbinaryAudit rejects invalid preview requests and unavailable or failed Canvas ports', async () => {
    await expect(createPdfPagePreview(parseDocument('a.txt', 'Text'), 1)).rejects.toThrow('状态无效');
    await expect(createPdfPagePreview(model(), 2)).rejects.toThrow('不存在');
    const controller = new AbortController(); controller.abort();
    await expect(createPdfPagePreview(model(), 1, [], controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    vi.stubGlobal('document', undefined);
    await expect(createPdfPagePreview(model(), 1)).rejects.toThrow('无法渲染');
    vi.stubGlobal('document', {createElement: () => ({width: 0, height: 0, getContext: () => null})});
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    await expect(createPdfPagePreview(model(bytes), 1)).rejects.toThrow('初始化失败');
});

it('documentbinaryAudit handles transparent samples, absent translations and a failing second context', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    context.getImageData.mockImplementation((_x: number, _y: number, width: number, height: number) => ({data: new Uint8ClampedArray(width * height * 4)}));
    await rasterizePdfTranslationPage({...input(bytes, [block(), block({segmentIndex: 1})]), translations: ['Visible']});
    expect(context.fillText).toHaveBeenCalled();
    let calls = 0;
    vi.stubGlobal('document', {createElement: () => ({width: 100, height: 100, getContext: () => ++calls === 1 ? context : null})});
    await expect(rasterizePdfTranslationPage(input(bytes))).rejects.toThrow('初始化失败');
});

it('documentbinaryAudit retains PDF grouping output with bounded geometry reads on long rows and paragraphs', () => {
    let paragraphReads = 0;
    const count = 2_000;
    const lines = Array.from({length: count}, (_, index) => {
        const value = {text: `Line ${index}`, x: 0, y: index * 12, width: 100, height: 10, fontFamily: 'sans'};
        return new Proxy(value, {get: (target, key, receiver) => {if (['x', 'y', 'width', 'height'].includes(String(key))) paragraphReads += 1; return Reflect.get(target, key, receiver);}});
    });
    const blocks = pdfTextBlocks(lines, 100);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({source: lines.map(line => line.text).join(' '), x: 0, y: 0, width: 100, height: 23_998, lineCount: count});
    let atomReads = 0;
    const atoms = Array.from({length: count}, (_, index) => new Proxy({text: 'word', x: index * 5, y: 10, width: 5, height: 10, fontFamily: 'sans'}, {get: (target, key, receiver) => {if (['y', 'height'].includes(String(key))) atomReads += 1; return Reflect.get(target, key, receiver);}}));
    const output = pdfTextLines(atoms, count * 5);
    expect(output).toHaveLength(1);
    expect(output[0].text).toBe('word'.repeat(count));
    console.info('documentbinaryAudit-perf:' + JSON.stringify({count, paragraphReads, atomReads, readLimit: count * 40, outputHash: createHash('sha256').update(JSON.stringify({blocks, output})).digest('hex')}));
    expect(paragraphReads).toBeLessThan(count * 40);
    expect(atomReads).toBeLessThan(count * 40);
});

it('documentbinaryAudit observes an abort that occurs while the archive stream is being constructed', async () => {
    const controller = new AbortController();
    const stream = {on: vi.fn(), pause: vi.fn(), resume: vi.fn()};
    const zip = {generateInternalStream: () => {controller.abort('constructor abort'); return stream;}} as unknown as JSZip;
    await expect(generateDocumentArchive(zip, {}, {signal: controller.signal})).rejects.toBe('constructor abort');
    expect(stream.pause).toHaveBeenCalledOnce();
    expect(stream.resume).not.toHaveBeenCalled();
});

it.each(['epub', 'docx'] as const)('documentbinaryAudit preserves cancellation reason while %s ZIP loading is pending', async extension => {
    const pending = deferred<JSZip>();
    vi.spyOn(JSZip, 'loadAsync').mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const work = parseBinaryDocument(`pending.${extension}`, new Uint8Array([1]), {signal: controller.signal});
    void work.catch(() => undefined);
    await vi.waitFor(() => expect(JSZip.loadAsync).toHaveBeenCalledOnce());
    controller.abort(new Error('zip load stopped'));
    await expect(work).rejects.toThrow('zip load stopped');
    pending.resolve(new JSZip());
});

it('documentbinaryAudit rejects synchronously canceled File reads before interpreting their returned text', async () => {
    const controller = new AbortController();
    const file = {name: 'sync.txt', text: () => {controller.abort('sync stop'); return Promise.resolve('not committed');}, arrayBuffer: vi.fn()};
    await expect(parseDocumentFile(file, {signal: controller.signal})).rejects.toBe('sync stop');
});

it('documentbinaryAudit rejects a canceled archive between the ZIP lookup and starting the decompression stream', async () => {
    const controller = new AbortController();
    const zip = new JSZip().file('[Content_Types].xml', '<Types/>').file('word/document.xml', '<w:p><w:t>Text</w:t></w:p>');
    const originalFile = zip.file.bind(zip);
    vi.spyOn(zip, 'file').mockImplementation(((path: string) => {const entry = originalFile(path); if (path === 'word/document.xml') controller.abort('lookup stopped'); return entry;}) as any);
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(zip);
    await expect(parseBinaryDocument('lookup.docx', new Uint8Array([1]), {signal: controller.signal})).rejects.toBe('lookup stopped');
});

it('documentbinaryAudit wraps words across lines and handles whitespace-only translations without unnecessary draw calls', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    await rasterizePdfTranslationPage({...input(bytes, [block({width: 20, height: 90, lineCount: 2})]), translations: ['aa bb cc dd']});
    expect(context.fillText.mock.calls.length).toBeGreaterThan(1);
    context.fillText.mockClear();
    await rasterizePdfTranslationPage({...input(bytes, [block()]), translations: ['  ']});
    expect(context.fillText).not.toHaveBeenCalled();
    vi.stubGlobal('document', undefined);
    await expect(rasterizePdfTranslationPage(input())).rejects.toThrow('无法生成');
});

it('documentbinaryAudit handles synchronous render cancellation and late cleanup failure without an unhandled rejection', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    const controller = new AbortController();
    const cancel = vi.fn();
    page.render.mockImplementationOnce(() => {controller.abort('render start stopped'); return {promise: Promise.resolve(), cancel};});
    await expect(rasterizePdfTranslationPage({...input(bytes), signal: controller.signal})).rejects.toBe('render start stopped');
    expect(cancel).toHaveBeenCalledOnce();
    const late = deferred<any>();
    const second = new AbortController();
    port.getDocument.mockImplementationOnce(() => ({promise: Promise.resolve({getPage: () => {second.abort('getPage stopped'); return late.promise;}}), destroy}));
    await expect(createPdfPagePreview(model(bytes), 1, undefined, second.signal)).rejects.toBe('getPage stopped');
    late.resolve({cleanup: () => {throw new Error('late cleanup failed');}});
    await vi.dynamicImportSettled();
    destroy.mockRejectedValueOnce(new Error('destroy failed'));
    await createPdfPagePreview(model(bytes), 1);
    releasePdfDocument(bytes);
    await Promise.resolve();
});

it('documentbinaryAudit releases a canvas and retries when active page cleanup fails while preserving the render error', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    page.render.mockImplementationOnce(() => ({promise: Promise.reject(new Error('render failed')), cancel: vi.fn()}));
    page.cleanup.mockImplementationOnce(() => {throw new Error('cleanup failed');});
    await expect(createPdfPagePreview(model(bytes), 1)).rejects.toThrow('render failed');
    expect(destroy).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    page.cleanup.mockImplementationOnce(() => {throw new Error('cleanup failed');});
    await expect(createPdfPagePreview(model(bytes), 1)).rejects.toThrow('cleanup failed');
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    await createPdfPagePreview(model(bytes), 1);
    expect(port.getDocument).toHaveBeenCalledTimes(3);
});

it('documentbinaryAudit cancels pending PNG byte reads and rejects cancellation during synchronous paint before encoding', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    const pending = deferred<ArrayBuffer>();
    const read = vi.fn(() => pending.promise);
    encode = done => done({arrayBuffer: read} as unknown as Blob);
    const controller = new AbortController();
    const work = rasterizePdfTranslationPage({...input(bytes), signal: controller.signal});
    void work.catch(() => undefined);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort('png bytes stopped');
    await expect(work).rejects.toBe('png bytes stopped');
    pending.resolve(new ArrayBuffer(3));
    await Promise.resolve();
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    const paintController = new AbortController();
    const encoded = vi.fn((done: (blob: Blob | null) => void) => done(new Blob([new Uint8Array([1])])));
    encode = encoded;
    context.measureText.mockImplementationOnce((value: string) => {paintController.abort('paint stopped'); return {width: value.length * 8};});
    await expect(rasterizePdfTranslationPage({...input(bytes, [block()]), signal: paintController.signal})).rejects.toBe('paint stopped');
    expect(encoded).not.toHaveBeenCalled();
    await rasterizePdfTranslationPage({...input(bytes), signal: new AbortController().signal});
    expect(encoded).toHaveBeenCalledOnce();
});

it('documentbinaryAudit preserves whitespace-only interior lines in reviewed PDF text', async () => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    await rasterizePdfTranslationPage({...input(bytes, [block({height: 90})]), translations: ['first\n   \nlast']});
    const [first, last] = context.fillText.mock.calls.filter((call: unknown[]) => call[0]);
    expect(first[0]).toBe('first'); expect(last[0]).toBe('last');
    const withBlankLine = last[2] - first[2];
    context.fillText.mockClear();
    await rasterizePdfTranslationPage({...input(bytes, [block({height: 90})]), translations: ['first\nlast']});
    const withoutBlankLine = context.fillText.mock.calls[1][2] - context.fillText.mock.calls[0][2];
    expect(withBlankLine).toBeCloseTo(withoutBlankLine * 2);
});

it.each(['preview', 'rasterizer'] as const)('documentbinaryAudit rejects %s canceled by page cleanup before encoding and releases its file for retry', async consumer => {
    const bytes = sourceBytes(); resourceBytes.push(bytes);
    const originalBytes = new Uint8Array(bytes);
    const controller = new AbortController();
    const reason = new Error('file closed during page cleanup');
    const encoded = vi.fn((done: (blob: Blob | null) => void) => done(new Blob([new Uint8Array([1, 2, 3])])));
    encode = encoded;
    page.cleanup.mockImplementationOnce(() => controller.abort(reason));
    const work = consumer === 'preview'
        ? documentPublic.createPdfPagePreview(model(bytes), 1, ['Reviewed translation'], controller.signal)
        : rasterizePdfTranslationPage({...input(bytes, [block()]), signal: controller.signal});
    await expect(work).rejects.toBe(reason);
    expect(page.render).toHaveBeenCalledOnce();
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(encoded).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({width: 0, height: 0});
    expect(bytes).toEqual(originalBytes);
    await expect(documentPublic.createPdfPagePreview(model(bytes), 1)).resolves.toHaveProperty('original');
    expect(port.getDocument).toHaveBeenCalledTimes(2);
    expect(encoded).toHaveBeenCalledOnce();
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
