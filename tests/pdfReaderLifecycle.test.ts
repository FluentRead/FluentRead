import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRenderer, h, markRaw, nextTick, ref} from 'vue';
import PdfReader from '@/src/features/document-translation/ui/PdfReader.vue';
import type {ParsedDocument, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {createPdfReaderRenderPort, PDF_READER_MAX_CANVAS_EDGE, PDF_READER_MAX_PAGE_PIXELS, PDF_READER_MAX_RESIDENT_PAGES, pdfReaderCanvasSize, pdfReaderDisplayRect, pdfReaderPageHasTranslation, pdfReaderPageKey, pdfReaderPageWindow, PdfReaderScheduler, type PdfReaderPageState, type PdfReaderRenderedPage, type PdfReaderSettings} from '@/src/features/document-translation/ui/pdfReader';
import {acquirePdfDocument, releasePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES} from '@/src/core/config/informationHighlight';
import {scoreInformationKeywords} from '@/src/features/information-highlight/domain/keywords';
import {INFORMATION_HIGHLIGHT_NAME} from '@/src/features/information-highlight/public';

const ports = vi.hoisted(() => ({getDocument: vi.fn(), textLayers: [] as any[], textPending: undefined as any}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string, params?: {page?: number}) => params?.page ? `${key}:${params.page}` : key})}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: ports.getDocument, TextLayer: class {
    container: HTMLElement;
    viewport: any;
    textContentSource: any;
    textContentItemsStr = ['Original PDF words'];
    cancel = vi.fn();
    constructor(options: any) {this.container = options.container; this.viewport = options.viewport; this.textContentSource = options.textContentSource; ports.textLayers.push(this);}
    render() {const span = this.container.ownerDocument.createElement('span'); span.textContent = 'Original PDF words'; this.container.append(span); return ports.textPending?.promise ?? Promise.resolve();}
}}));

const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const pageModel = (pageNumber: number, width = 612, height = 792): PdfDocumentPage => ({pageNumber, width, height, segmentIndexes: [pageNumber - 1], blocks: [{segmentIndex: pageNumber - 1, x: 50, y: 70, width: 200, height: 40, fontSize: 12, lineHeight: 14, lineCount: 2, fontFamily: 'sans', fontWeight: 400, textAlign: 'left'}]});
const documentModel = (pages = 1): ParsedDocument => ({fileName: 'fixture.pdf', format: 'pdf', label: 'PDF', parts: [], segments: Array.from({length: pages}, (_, index) => ({id: index, source: `Source ${index + 1}`})), binary: {kind: 'pdf', bytes: new TextEncoder().encode(`%PDF-reader-${Math.random()}`), pages: Array.from({length: pages}, (_, index) => pageModel(index + 1))}});
const output = (): PdfReaderRenderedPage => ({dispose: vi.fn()});
const settings = (key = 'source', scale = 1, mode: PdfReaderSettings['mode'] = 'source'): PdfReaderSettings => ({key, scale, mode});
const settle = async () => {for (let index = 0; index < 8; index += 1) await Promise.resolve();};
let win: EventTarget & {location: {origin: string}; devicePixelRatio: number};
let pdfPage: any;
let destroy: ReturnType<typeof vi.fn>;
let canvases: any[];
let models: ParsedDocument[];
let selection: any;
let frames: Map<number, FrameRequestCallback>;
let resizeCallback: ResizeObserverCallback | undefined;
let disconnect: ReturnType<typeof vi.fn>;
let mountedApp: any;
let storage: Map<string, string>;

beforeEach(() => {
    ports.getDocument.mockReset(); ports.textLayers = []; ports.textPending = undefined;
    models = []; canvases = []; selection = undefined; frames = new Map(); resizeCallback = undefined; mountedApp = undefined;
    const {document} = parseHTML('<html><body></body></html>');
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const element = markRaw(createElement(tag));
        if (tag !== 'canvas') return element;
        const context: any = {drawImage: vi.fn(), fillRect: vi.fn(), measureText: vi.fn((value: string) => ({width: value.length * 8})), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({data: new Uint8ClampedArray(width * height * 4).fill(255)}))};
        context.canvas = element;
        Object.assign(element, {width: 0, height: 0, getContext: () => context, toBlob: vi.fn()});
        canvases.push(element); return element;
    });
    let nextFrame = 1;
    win = Object.assign(new EventTarget(), {location: {origin: 'chrome-extension://fixture'}, devicePixelRatio: 3, getSelection: () => selection, requestAnimationFrame: (callback: FrameRequestCallback) => {const id = nextFrame++; frames.set(id, callback); return id;}, cancelAnimationFrame: (id: number) => {frames.delete(id);}});
    disconnect = vi.fn();
    // 译文样式保存在本机；每个用例使用独立的内存存储。
    storage = new Map(); vi.stubGlobal('localStorage', {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);}});
    vi.stubGlobal('ResizeObserver', class {constructor(callback: ResizeObserverCallback) {resizeCallback = callback;} observe = vi.fn(); unobserve = vi.fn(); disconnect = disconnect;});
    vi.stubGlobal('document', document); vi.stubGlobal('window', win);
    pdfPage = {getViewport: vi.fn(({scale}: {scale: number}) => ({width: 612 * scale, height: 792 * scale, scale, transform: [scale, 0, 0, -scale, 0, 792 * scale]})), cleanup: vi.fn(), streamTextContent: vi.fn(() => ({fixture: 'text stream'})), render: vi.fn(() => ({promise: Promise.resolve(), cancel: vi.fn()}))};
    destroy = vi.fn(async () => {});
    ports.getDocument.mockImplementation(() => ({promise: Promise.resolve({getPage: vi.fn(async () => pdfPage)}), destroy}));
});
afterEach(async () => {mountedApp?.unmount(); ports.textPending?.resolve(); win.dispatchEvent(new Event('pagehide')); models.forEach(model => {if (model.binary?.kind === 'pdf') releasePdfDocument(model.binary.bytes);}); await vi.dynamicImportSettled(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
const model = (count = 1) => {const value = documentModel(count); models.push(value); return value;};

describe('PDF reader visible page scheduling and memory bounds', () => {
    it('keys readable source work by scale, mode, blocks and preserved regions only, and maps all preserved-region rotations', () => {
        const page = pageModel(1);
        expect(pdfReaderPageKey(page, 1, 'bilingual', 'readable')).toBe(JSON.stringify([1, 'bilingual', 'readable', page.blocks, undefined]));
        expect(pdfReaderPageKey(page, 1, 'bilingual', 'readable')).toBe(pdfReaderPageKey(pageModel(1), 1, 'bilingual', 'readable'));
        expect(pdfReaderPageKey(page, 1.5, 'bilingual', 'readable')).not.toBe(pdfReaderPageKey(page, 1, 'bilingual', 'readable'));
        expect(pdfReaderPageKey(page, 1, 'translated', 'readable')).not.toBe(pdfReaderPageKey(page, 1, 'bilingual', 'readable'));
        expect(pdfReaderPageKey(pageModel(2), 1, 'bilingual', 'readable')).not.toBe(pdfReaderPageKey(page, 1, 'bilingual', 'readable'));
        expect(pdfReaderPageKey({...page, preservedRegions: [{id: 'graph', kind: 'figure', x: 1, y: 2, width: 3, height: 4}]}, 1, 'bilingual', 'readable')).not.toBe(pdfReaderPageKey(page, 1, 'bilingual', 'readable'));
        expect(pdfReaderPageKey(page, 1, 'bilingual', 'readable')).not.toBe(pdfReaderPageKey(page, 1, 'bilingual', 'layout'));
        const rect = {x: 10, y: 20, width: 30, height: 40};
        expect(pdfReaderDisplayRect(rect, page)).toBe(rect);
        expect(pdfReaderDisplayRect(rect, {...page, rotation: 90})).toEqual({x: 552, y: 10, width: 40, height: 30});
        expect(pdfReaderDisplayRect(rect, {...page, rotation: 180})).toEqual({x: 572, y: 732, width: 30, height: 40});
        expect(pdfReaderDisplayRect(rect, {...page, rotation: 270})).toEqual({x: 20, y: 752, width: 40, height: 30});
    });
    it('prioritizes visible pages and caps nearby work in first, middle, and last positions', () => {
        expect(pdfReaderPageWindow(120, 50, [49, 50, 51])).toEqual([50, 49, 51, 52, 48]);
        expect(pdfReaderPageWindow(120, 0)).toEqual([0, 1, 2, 3, 4]);
        expect(pdfReaderPageWindow(120, 119)).toEqual([119, 118, 117, 116, 115]);
        expect(pdfReaderPageWindow(0, 0)).toEqual([]);
        expect(pdfReaderPageWindow(2, 100, [-1, 100, 0, 0])).toEqual([0, 1]);
        expect(pdfReaderPageWindow(120, 50, [40, 41, 42, 43, 44, 45, 46])).toHaveLength(PDF_READER_MAX_RESIDENT_PAGES);
    });

    it('bounds pixels and edges for high DPI, bilingual, poster, and extremely long pages', () => {
        for (const [width, height, ratio, count] of [[612, 792, 3, 1], [918, 1188, 4, 2], [50000, 50000, 2, 2], [20, 2000000, 2, 1], [NaN, Infinity, NaN, 1]]) {
            const size = pdfReaderCanvasSize(width, height, ratio, count);
            expect(size.width).toBeGreaterThan(0); expect(size.height).toBeGreaterThan(0);
            expect(size.width).toBeLessThanOrEqual(PDF_READER_MAX_CANVAS_EDGE);
            expect(size.height).toBeLessThanOrEqual(PDF_READER_MAX_CANVAS_EDGE);
            expect(size.width * size.height * count).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS);
        }
        for (const [width, height, budget] of [[1000000, 1, 1], [1, 1000000, 1], [612, 792, 19], [612, 792, 2500000 - 15000]]) {
            const size = pdfReaderCanvasSize(width, height, 2, 1, budget);
            expect(size.width * size.height).toBeLessThanOrEqual(budget);
        }
        expect(() => pdfReaderCanvasSize(600, 800, 2, 1, 0)).toThrow('像素预算不足');
        expect(() => pdfReaderCanvasSize(600, 800, 2, 1, NaN)).toThrow('像素预算不足');
    });

    it('keys layout pages by scale and mode alone, so a scheduler never redraws a ready page when only translations change', async () => {
        const first = pageModel(1); const second = pageModel(2); const doc = model(2);
        expect(pdfReaderPageKey(first, 1, 'bilingual')).toBe(JSON.stringify([1, 'bilingual']));
        expect(pdfReaderPageKey(first, 1, 'bilingual', 'layout')).toBe(JSON.stringify([1, 'bilingual']));
        expect(pdfReaderPageKey(second, 1, 'bilingual', 'layout')).toBe(pdfReaderPageKey(first, 1, 'bilingual', 'layout'));
        expect(pdfReaderPageKey({...first, blocks: []}, 1, 'bilingual', 'layout')).toBe(pdfReaderPageKey(first, 1, 'bilingual', 'layout'));
        expect(pdfReaderPageKey(first, 1.5, 'bilingual', 'layout')).toBe(JSON.stringify([1.5, 'bilingual']));
        expect(pdfReaderPageKey(first, 1, 'translated', 'layout')).toBe(JSON.stringify([1, 'translated']));
        expect(pdfReaderPageKey(first, 1, 'source', 'layout')).toBe(JSON.stringify([1, 'source']));
        expect(pdfReaderPageHasTranslation(doc, first, ['Source 1'])).toBe(false);
        expect(pdfReaderPageHasTranslation(doc, first, [''])).toBe(false);
        expect(pdfReaderPageHasTranslation(doc, first, ['译文'])).toBe(true);
        expect(pdfReaderPageHasTranslation({...doc, segments: []}, first, ['译文'])).toBe(true);
        // 译文在阅读器外部流式变化；调度器每次拿到的页面键相同，已就绪的页不得重绘或释放。
        const outputs: PdfReaderRenderedPage[] = [];
        const render = vi.fn(async () => {const value = output(); outputs.push(value); return value;});
        const scheduler = new PdfReaderScheduler([first, second], {render, dispose: vi.fn()}, () => undefined);
        const keyed = (scale: number, mode: PdfReaderSettings['mode']) => (index: number): PdfReaderSettings => ({scale, mode, presentation: 'layout', key: pdfReaderPageKey([first, second][index], scale, mode, 'layout')});
        scheduler.update([0, 1], keyed(1, 'bilingual')); await settle(); expect(render).toHaveBeenCalledTimes(2);
        scheduler.update([0, 1], keyed(1, 'bilingual')); scheduler.update([1, 0], keyed(1, 'bilingual')); await settle();
        expect(render).toHaveBeenCalledTimes(2); expect(outputs.every(value => vi.mocked(value.dispose).mock.calls.length === 0)).toBe(true);
        scheduler.update([0, 1], keyed(1, 'translated')); await settle();
        expect(render).toHaveBeenCalledTimes(4); expect(outputs[0].dispose).toHaveBeenCalledOnce(); expect(outputs[1].dispose).toHaveBeenCalledOnce();
        scheduler.update([0, 1], keyed(1.25, 'translated')); await settle(); expect(render).toHaveBeenCalledTimes(6);
        scheduler.dispose();
    });

    it('preempts obsolete work on a far jump, releases stale late output, and keeps two renders concurrent', async () => {
        const jobs: Array<{page: number; pending: ReturnType<typeof deferred<PdfReaderRenderedPage>>; signal: AbortSignal}> = [];
        const port = {dispose: vi.fn(), render: vi.fn((page: PdfDocumentPage, _options: unknown, signal: AbortSignal) => {const pending = deferred<PdfReaderRenderedPage>(); jobs.push({page: page.pageNumber, pending, signal}); return pending.promise;})};
        const changes = new Map<number, PdfReaderPageState>();
        const scheduler = new PdfReaderScheduler(Array.from({length: 120}, (_, index) => pageModel(index + 1)), port, (page, state) => {if (state) changes.set(page, state); else changes.delete(page);});
        scheduler.update([0, 1, 2, 3, 4, 5], () => settings());
        expect(jobs.map(job => job.page)).toEqual([1, 2]);
        scheduler.update([90, 91, 89, 92, 88], () => settings());
        expect(jobs.every(job => job.signal.aborted)).toBe(true);
        const late = output(); jobs[0].pending.resolve(late); jobs[1].pending.reject(new Error('cancelled')); await settle();
        expect(late.dispose).toHaveBeenCalledOnce();
        expect(jobs.slice(2).map(job => job.page)).toEqual([91, 92]);
        expect(changes.size).toBe(2);
        const first = output(); const second = output(); jobs[2].pending.resolve(first); jobs[3].pending.resolve(second); await settle();
        expect(jobs.slice(4).map(job => job.page)).toEqual([90, 93]);
        scheduler.dispose(); scheduler.dispose();
        expect(first.dispose).toHaveBeenCalledOnce(); expect(second.dispose).toHaveBeenCalledOnce();
        expect(port.dispose).toHaveBeenCalledOnce();
        const last = output(); jobs[4].pending.resolve(last); jobs[5].pending.resolve(output()); await settle();
        expect(last.dispose).toHaveBeenCalledOnce(); expect(changes.size).toBe(0); expect(jobs).toHaveLength(6);
    });

    it('evicts old zoom output, retries individual failures, and prevents unrelated ready pages rerendering', async () => {
        const outputs: PdfReaderRenderedPage[] = [];
        const render = vi.fn(async (page: PdfDocumentPage) => {if (page.pageNumber === 1 && render.mock.calls.length === 1) throw new Error('recoverable'); const value = output(); outputs.push(value); return value;});
        const states = new Map<number, PdfReaderPageState>();
        const scheduler = new PdfReaderScheduler([pageModel(1), pageModel(2)], {render, dispose: vi.fn()}, (page, state) => {if (state) states.set(page, state); else states.delete(page);});
        scheduler.update([0, 1], index => settings(`page-${index}`)); await settle();
        expect(states.get(1)).toEqual({status: 'error', message: 'recoverable'});
        scheduler.update([0, 1], index => settings(`page-${index}`)); await settle(); expect(render).toHaveBeenCalledTimes(2);
        scheduler.retry(0); await settle(); expect(render).toHaveBeenCalledTimes(3); expect(states.get(1)?.status).toBe('ready');
        scheduler.update([0, 1], index => settings(index === 0 ? 'changed' : 'page-1')); await settle();
        expect(render).toHaveBeenCalledTimes(4); expect(outputs[1].dispose).toHaveBeenCalledOnce(); expect(outputs[0].dispose).not.toHaveBeenCalled();
        scheduler.update([0, 1], index => settings(`zoom-${index}`, 1.5)); await settle(); expect(render).toHaveBeenCalledTimes(6);
        scheduler.dispose(); scheduler.update([0], () => settings()); scheduler.retry(0); expect(render).toHaveBeenCalledTimes(6);
    });
});

describe('PDF reader actual PDF.js resource adapter', () => {
    it.each([90, 180, 270])('preserves the %i degree page viewport in the source Canvas and official TextLayer', async rotation => {
        pdfPage.getViewport.mockImplementation(({scale}: {scale: number}) => ({width: (rotation === 180 ? 612 : 792) * scale, height: (rotation === 180 ? 792 : 612) * scale, scale, rotation}));
        const reader = createPdfReaderRenderPort(model());
        const result = await reader.render(pageModel(1), settings('rotated', 1.25), new AbortController().signal);
        expect(pdfPage.render.mock.calls[0][0].viewport.rotation).toBe(rotation);
        expect(ports.textLayers[0].viewport).toBe(pdfPage.render.mock.calls[0][0].viewport);
        expect(result.sourceCanvas?.style.width).toBe(`${ports.textLayers[0].viewport.width}px`);
        expect(result.sourceCanvas?.style.height).toBe(`${ports.textLayers[0].viewport.height}px`);
        result.dispose(); reader.dispose();
    });

    it('renders a direct source Canvas with the official streamed TextLayer and never encodes PNG', async () => {
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        const result = await reader.render(pageModel(1), settings(), new AbortController().signal);
        expect(result.sourceText?.textContent).toBe('Original PDF words');
        expect(result.sourceText?.getAttribute('data-fluentread-pdf-text')).toBe('');
        expect(result.sourceText?.style.getPropertyValue('--scale-factor')).toBe('1');
        expect(ports.textLayers[0].textContentSource).toEqual({fixture: 'text stream'});
        expect(ports.textLayers[0].viewport.scale).toBe(1);
        expect(pdfPage.render.mock.calls[0][0].transform).toEqual([2, 0, 0, 2, 0, 0]);
        expect(canvases[0].toBlob).not.toHaveBeenCalled();
        expect(pdfPage.cleanup).toHaveBeenCalledOnce();
        result.dispose(); result.dispose(); reader.dispose(); reader.dispose();
        expect(canvases[0]).toMatchObject({width: 0, height: 0}); expect(ports.textLayers[0].cancel).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
        await expect(reader.render(pageModel(1), settings(), new AbortController().signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('shares a file lease across page cancellation and preserves a second active reader', async () => {
        const doc = model(); const other = acquirePdfDocument(doc.binary!.bytes);
        const reader = createPdfReaderRenderPort(doc); const pending = deferred<void>();
        pdfPage.render.mockImplementationOnce(() => ({promise: pending.promise, cancel: vi.fn()}));
        const controller = new AbortController(); const work = reader.render(pageModel(1), settings(), controller.signal); void work.catch(() => undefined);
        await vi.waitFor(() => expect(canvases).toHaveLength(1)); controller.abort(new Error('page changed'));
        await expect(work).rejects.toThrow('page changed');
        expect(canvases[0]).toMatchObject({width: 0, height: 0}); expect(destroy).not.toHaveBeenCalled();
        expect(ports.textLayers[0].cancel).toHaveBeenCalledOnce(); pending.resolve();
        const result = await reader.render(pageModel(1), settings(), new AbortController().signal); result.dispose();
        expect(ports.getDocument).toHaveBeenCalledOnce(); reader.dispose(); expect(destroy).not.toHaveBeenCalled(); other.release(); expect(destroy).toHaveBeenCalledOnce();
    });

    it('releases pending page/text work on close and cleans late pages without allocating stale pixels', async () => {
        const doc = model(); const pagePending = deferred<any>();
        const getPage = vi.fn(() => pagePending.promise);
        ports.getDocument.mockReturnValueOnce({promise: Promise.resolve({getPage}), destroy});
        const reader = createPdfReaderRenderPort(doc); const work = reader.render(pageModel(1), settings(), new AbortController().signal); void work.catch(() => undefined);
        await vi.waitFor(() => expect(getPage).toHaveBeenCalledOnce()); reader.dispose(); await expect(work).rejects.toMatchObject({name: 'AbortError'});
        const cleanup = vi.fn(); pagePending.resolve({cleanup}); await settle(); expect(cleanup).toHaveBeenCalledOnce(); expect(canvases).toHaveLength(0);
        const next = createPdfReaderRenderPort(doc); ports.textPending = deferred<void>();
        const textWork = next.render(pageModel(1), settings(), new AbortController().signal); void textWork.catch(() => undefined);
        await vi.waitFor(() => expect(ports.textLayers).toHaveLength(1)); next.dispose(); await expect(textWork).rejects.toMatchObject({name: 'AbortError'});
        expect(ports.textLayers[0].cancel).toHaveBeenCalledOnce(); expect(canvases[0]).toMatchObject({width: 0, height: 0}); ports.textPending.resolve();
    });

    it('retries failed document loads and canvas initialization, with bounded bilingual and translated canvases', async () => {
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        ports.getDocument.mockReturnValueOnce({promise: Promise.reject(new Error('loading failed')), destroy});
        await expect(reader.render(pageModel(1), settings(), new AbortController().signal)).rejects.toThrow('loading failed');
        const bilingual = await reader.render(pageModel(1), settings('bilingual', 1.5, 'bilingual'), new AbortController().signal);
        expect(canvases).toHaveLength(2); expect(bilingual.sourceCanvas).toBe(canvases[0]); expect(bilingual.translatedCanvas).toBe(canvases[1]); expect(bilingual.sourceText).toBeTruthy();
        expect(bilingual.sourceCanvas!.getAttribute('data-pdf-resource')).toBe('source'); expect(bilingual.translatedCanvas!.getAttribute('data-pdf-resource')).toBe('translation');
        expect(bilingual.translatedCanvas).toMatchObject({width: bilingual.sourceCanvas!.width, height: bilingual.sourceCanvas!.height});
        expect(bilingual.translatedCanvas!.style.width).toBe('918px'); expect(bilingual.translatedCanvas!.style.height).toBe('1188px');
        expect((bilingual.sourceCanvas!.width * bilingual.sourceCanvas!.height) + (bilingual.translatedCanvas!.width * bilingual.translatedCanvas!.height)).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS);
        // 译文页只是原页像素的一次复制，文字由阅读器的译文层叠加，不在 Canvas 上绘制。
        const copy = bilingual.translatedCanvas!.getContext('2d')! as any;
        expect(copy.drawImage).toHaveBeenCalledOnce(); expect(copy.drawImage).toHaveBeenCalledWith(bilingual.sourceCanvas, 0, 0);
        expect(copy.fillText).not.toHaveBeenCalled(); expect(copy.fillRect).not.toHaveBeenCalled(); expect(pdfPage.render).toHaveBeenCalledOnce();
        bilingual.dispose();
        const translated = await reader.render(pageModel(1), settings('translated', 1.5, 'translated'), new AbortController().signal);
        expect(canvases).toHaveLength(3); expect(translated.translatedCanvas).toBe(canvases[2]);
        expect(translated.sourceCanvas).toBeUndefined(); expect(translated.sourceText).toBeUndefined(); expect(ports.textLayers).toHaveLength(1);
        expect(translated.translatedCanvas!.getAttribute('data-pdf-resource')).toBe('translation'); expect(translated.translatedCanvas!.width).toBeGreaterThan(0);
        expect((translated.translatedCanvas!.getContext('2d') as any).drawImage).not.toHaveBeenCalled(); expect((translated.translatedCanvas!.getContext('2d') as any).fillText).not.toHaveBeenCalled();
        const source = await reader.render(pageModel(1), settings('source', 1, 'source'), new AbortController().signal);
        expect(canvases).toHaveLength(4); expect(source.sourceCanvas).toBe(canvases[3]); expect(source.sourceText).toBeTruthy(); expect(source.translatedCanvas).toBeUndefined();
        expect(source.sourceCanvas!.getAttribute('data-pdf-resource')).toBe('source');
        translated.dispose(); source.dispose(); reader.dispose(); expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(() => createPdfReaderRenderPort({...doc, binary: undefined})).toThrow('PDF 文档状态无效');
    });

    it('rejects preaborted and synchronous page cancellation, then reacquires an externally released file on retry', async () => {
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        const alreadyAborted = new AbortController(); alreadyAborted.abort('before render');
        await expect(reader.render(pageModel(1), settings(), alreadyAborted.signal)).rejects.toBe('before render');
        expect(ports.getDocument).not.toHaveBeenCalled();
        const controller = new AbortController();
        ports.getDocument.mockReturnValueOnce({promise: Promise.resolve({getPage: () => {controller.abort('synchronous page cancellation'); return Promise.resolve(pdfPage);}}), destroy});
        await expect(reader.render(pageModel(1), settings(), controller.signal)).rejects.toBe('synchronous page cancellation');
        await settle(); expect(pdfPage.cleanup).toHaveBeenCalledOnce();
        releasePdfDocument(doc.binary!.bytes);
        const result = await reader.render(pageModel(1), settings(), new AbortController().signal);
        expect(ports.getDocument).toHaveBeenCalledTimes(2); result.dispose(); reader.dispose();
        const neverUsed = createPdfReaderRenderPort(doc); neverUsed.dispose();
    });

    it('releases source and translated Canvas allocation failures and never paints translation text onto a page canvas', async () => {
        const create = vi.mocked(document.createElement).getMockImplementation()!;
        let failAt = 1;
        vi.mocked(document.createElement).mockImplementation((tag: string) => {const element = create(tag); if (tag === 'canvas' && canvases.length === failAt) Object.assign(element, {getContext: () => null}); return element;});
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        await expect(reader.render(pageModel(1), settings(), new AbortController().signal)).rejects.toThrow('Canvas 初始化失败');
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        failAt = 3;
        await expect(reader.render(pageModel(1), settings('bilingual', 1, 'bilingual'), new AbortController().signal)).rejects.toThrow('Canvas 初始化失败');
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        failAt = -1;
        const page = {...pageModel(1), segmentIndexes: [0, 1, 2], blocks: []};
        const multi = await reader.render(page, settings('multiple', 1, 'bilingual'), new AbortController().signal);
        expect(multi.translatedCanvas).not.toBe(multi.sourceCanvas); expect(multi.translatedCanvas!.getAttribute('data-pdf-resource')).toBe('translation');
        for (const canvas of [multi.sourceCanvas!, multi.translatedCanvas!]) expect((canvas.getContext('2d') as any).fillText).not.toHaveBeenCalled();
        multi.dispose(); reader.dispose();
        const messages: PdfReaderPageState[] = [];
        const scheduler = new PdfReaderScheduler([pageModel(1)], {render: async () => {throw 'string failure';}, dispose: vi.fn()}, (_page, state) => {if (state) messages.push(state);});
        scheduler.update([0, 9], () => settings()); await settle(); expect(messages.at(-1)).toEqual({status: 'error', message: 'string failure'}); scheduler.dispose();
    });

    it('releases a completed page if cleanup fails, so a rejected result cannot retain pixels or text', async () => {
        const reader = createPdfReaderRenderPort(model());
        pdfPage.cleanup.mockImplementationOnce(() => {throw new Error('cleanup failed');});
        await expect(reader.render(pageModel(1), settings(), new AbortController().signal)).rejects.toThrow('cleanup failed');
        expect(canvases[0]).toMatchObject({width: 0, height: 0}); expect(ports.textLayers[0].container.textContent).toBe('');
        reader.dispose();
    });

    it('preserves source graphics as independent region crops within the page budget without painting translation into the original', async () => {
        const doc = model();
        const page = {...pageModel(1), preservedRegions: [
            {id: 'architecture', kind: 'figure' as const, x: 40, y: 200, width: 450, height: 300},
            {id: 'math', kind: 'formula' as const, x: 40, y: 600, width: 350, height: 50},
        ]};
        const reader = createPdfReaderRenderPort(doc);
        const result = await reader.render(page, {...settings('readable', 1.5, 'bilingual'), presentation: 'readable'}, new AbortController().signal);
        expect(result.sourceCanvas).toBeTruthy(); expect(result.sourceText).toBeTruthy(); expect(result.translatedCanvas).toBeUndefined();
        expect([...result.regions!.keys()]).toEqual(['pdf-1-region-architecture', 'pdf-1-region-math']);
        expect(canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS);
        expect(result.sourceCanvas!.getContext('2d')!.fillText).not.toHaveBeenCalled();
        for (const canvas of result.regions!.values()) {
            expect(canvas.getAttribute('data-pdf-resource')).toBe('region');
            expect(canvas.getContext('2d')!.drawImage).toHaveBeenCalledWith(result.sourceCanvas, expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), 0, 0, canvas.width, canvas.height);
        }
        result.dispose(); expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true); reader.dispose();
    });

    it.each([90, 180, 270] as const)('returns %i degree formula crops to canonical orientation without rotating the original page', async rotation => {
        win.devicePixelRatio = 1;
        const doc = model();
        const page = {...pageModel(1, rotation === 180 ? 612 : 792, rotation === 180 ? 792 : 612), rotation, preservedRegions: [{id: 'formula', kind: 'formula' as const, x: 50, y: 300, width: 200, height: 30}]};
        pdfPage.getViewport.mockImplementation(({scale}: {scale: number}) => ({width: page.width * scale, height: page.height * scale, scale, rotation}));
        const reader = createPdfReaderRenderPort(doc);
        const result = await reader.render(page, {...settings('canonical-crop', 1, 'bilingual'), presentation: 'readable'}, new AbortController().signal);
        const crop = [...result.regions!.values()][0]; const context = crop.getContext('2d')!;
        const rect = pdfReaderDisplayRect(page.preservedRegions[0], page);
        // 画布固定按 2 倍像素比渲染，即使窗口报告的像素比是 1。
        expect(crop).toMatchObject({width: 400, height: 60});
        expect(context.translate).toHaveBeenCalledWith(...(rotation === 90 ? [0, 60] : rotation === 180 ? [400, 60] : [400, 0]));
        expect(context.rotate).toHaveBeenCalledWith(rotation === 90 ? -Math.PI / 2 : rotation === 180 ? -Math.PI : Math.PI / 2);
        expect(context.drawImage).toHaveBeenCalledWith(result.sourceCanvas, rect.x * 2, rect.y * 2, rect.width * 2, rect.height * 2, 0, 0, rotation === 180 ? 400 : 60, rotation === 180 ? 60 : 400);
        expect(context.save).toHaveBeenCalledOnce(); expect(context.restore).toHaveBeenCalledOnce();
        expect(pdfPage.render.mock.calls[0][0].viewport.rotation).toBe(rotation);
        expect(ports.textLayers[0].viewport.rotation).toBe(rotation);
        expect(result.sourceCanvas!.getContext('2d')!.rotate).not.toHaveBeenCalled();
        expect(canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS);
        result.dispose(); reader.dispose();
    });

    it('reserves every thin region pixel and keeps the combined source/crop budget bounded after integer rounding', async () => {
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        const page = {...pageModel(1), preservedRegions: Array.from({length: 250}, (_, index) => ({id: `thin-${index}`, kind: 'formula' as const, x: 50, y: 100 + index * 2.5, width: 500, height: .0001}))};
        const result = await reader.render(page, {...settings('thin-crops', 1.5, 'bilingual'), presentation: 'readable'}, new AbortController().signal);
        expect(result.regions!.size).toBe(250);
        expect([...result.regions!.values()].every(canvas => canvas.width >= 1 && canvas.height >= 1)).toBe(true);
        expect(canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS);
        result.dispose(); expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true); reader.dispose();
    });

    it('releases the temporary original canvas in translated readable mode and cleans every crop if a later crop allocation fails', async () => {
        const doc = model(); const reader = createPdfReaderRenderPort(doc);
        const page = {...pageModel(1), preservedRegions: [{id: 'formula', kind: 'formula' as const, x: 50, y: 300, width: 200, height: 30}]};
        const result = await reader.render(page, {...settings('translated-readable', 1, 'translated'), presentation: 'readable'}, new AbortController().signal);
        expect(result.sourceCanvas).toBeUndefined(); expect(result.sourceText).toBeUndefined(); expect(result.translatedCanvas).toBeUndefined();
        expect(canvases[0]).toMatchObject({width: 0, height: 0});
        expect([...result.regions!.values()][0].width).toBeGreaterThan(0); result.dispose();
        const create = vi.mocked(document.createElement).getMockImplementation()!;
        const failAt = canvases.length + 2;
        vi.mocked(document.createElement).mockImplementation(tag => {const element = create(tag); if (tag === 'canvas' && canvases.length === failAt) Object.assign(element, {getContext: () => null}); return element;});
        await expect(reader.render(page, {...settings('failure', 1, 'bilingual'), presentation: 'readable'}, new AbortController().signal)).rejects.toThrow('Canvas 初始化失败');
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true); reader.dispose();
    });
});

function mountReader(value: ParsedDocument, mode = 'source' as PdfReaderSettings['mode'], translations: readonly string[] = [], options: {presentation?: 'readable' | 'layout'; translating?: boolean; outlineTarget?: HTMLElement; information?: {preferences: typeof DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES; scoreLocal: (text: string, signal: AbortSignal) => Promise<any>; available: boolean}} = {}) {
    const currentDocument = ref(value); const currentMode = ref(mode); const currentTranslations = ref(translations);
    // 不传 presentation 时使用组件默认的原版排版。
    const currentPresentation = ref<'readable' | 'layout' | undefined>(options.presentation); const presentations: string[] = [];
    const currentTranslating = ref(options.translating ?? false); const pageChanges: number[] = [];
    const currentInformation = ref(options.information);
    const renderer = createRenderer<any, any>({
        createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
        setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
        patchProp: (element, key, previous, value) => {
            if (key.startsWith('on')) {if (key.includes(':')) return; const name = key.slice(2).replace(/(?:Once|Passive|Capture)+$/, '').toLowerCase(); if (previous) element.removeEventListener(name, previous); if (value) element.addEventListener(name, value);}
            else if (key === 'style') {for (const [name, entry] of Object.entries(value || {})) element.style.setProperty(name, String(entry));}
            else if (key === 'value') element.value = value;
            else if (value == null || (value === false && !key.startsWith('aria-'))) element.removeAttribute(key);
            else element.setAttribute(key, String(value));
        },
    });
    const root = document.createElement('div'); document.body.append(root);
    mountedApp = renderer.createApp({setup: () => () => h(PdfReader, {document: currentDocument.value, translations: currentTranslations.value, mode: currentMode.value, presentation: currentPresentation.value, translating: currentTranslating.value, outlineTarget: options.outlineTarget ?? null,
        'onUpdate:presentation': (value: 'readable' | 'layout') => {presentations.push(value); currentPresentation.value = value;}, onPageChange: (page: number) => {pageChanges.push(page);}, sourceUrl: 'https://arxiv.org/pdf/1706.03762', informationHighlight: currentInformation.value})});
    mountedApp.mount(root);
    const state = mountedApp._instance.subTree.component.setupState;
    const viewport = root.querySelector('[data-pdf-scroll]') as HTMLElement;
    Object.defineProperties(viewport, {clientWidth: {value: 920, writable: true}, clientHeight: {value: 600, writable: true}});
    return {root, viewport, state, currentDocument, currentMode, currentTranslations, currentPresentation, currentTranslating, presentations, pageChanges, currentInformation};
}
async function componentFlush(): Promise<void> {for (let index = 0; index < 12; index += 1) {await nextTick(); await Promise.resolve();}}
const click = (element: Element | null | undefined): void => {element!.dispatchEvent(new document.defaultView!.Event('click'));};
const classes = (element: Element | null | undefined): string[] => (element!.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
function flushFrames(): void {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));}

function nativeInformationPaint() {
    const original = document.defaultView!; const registry = new Map<string, Set<Range>>();
    Object.defineProperty(document, 'defaultView', {configurable: true, value: new Proxy(original, {get(target, key) {
        if (key === 'CSS') return {highlights: registry}; if (key === 'Highlight') return Set;
        if (key === 'requestAnimationFrame' || key === 'cancelAnimationFrame') return (win as any)[key];
        if (key === 'innerHeight') return 720;
        if (key === 'getComputedStyle') return (element: HTMLElement) => ({display: element.style.display || 'inline', visibility: 'visible'});
        return Reflect.get(target, key);
    }})});
    document.createRange = () => {let text: Text, start = 0, end = 0; return {setStart(node: Text, value: number) {text = node; start = value;}, setEnd(_node: Text, value: number) {end = value;}, toString() {return text.data.slice(start, end);}} as unknown as Range;};
    return registry;
}
function clickInformation(root: HTMLElement): void {const event = document.createEvent('Event'); event.initEvent('click', true, true); root.querySelector('.pdf-information-highlight')!.dispatchEvent(event);}

describe('PDF reader information highlight composition', () => {
    it('rescores an already active PDF with the selected model identity', async () => {
        nativeInformationPaint();
        const score = vi.fn(async (text: string, _signal: AbortSignal, _modelId?: string) => scoreInformationKeywords(text));
        const reader = mountReader(model(2), 'source', [], {information: {preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, enabled: true, mode: 'surprisal-local'}, scoreLocal: score, available: true}});
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        expect(score.mock.calls.length).toBeGreaterThan(0);
        expect(score.mock.calls.every(([, , modelId]) => modelId === 'qwen2.5-0.5b')).toBe(true);
        score.mockClear();
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...reader.currentInformation.value!.preferences, model: 'qwen3-0.6b'}};
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(score.mock.calls.length).toBeGreaterThan(0); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        expect(score.mock.calls.every(([, , modelId]) => modelId === 'qwen3-0.6b')).toBe(true);
        expect(reader.state.informationState.enabled).toBe(true);
    });
    it('starts by explicit action, independently scores selectable original and translated text, and cleans paint across zoom and document replacement', async () => {
        const registry = nativeInformationPaint(), score = vi.fn(async (text: string) => scoreInformationKeywords(text));
        const reader = mountReader(model(8), 'bilingual', Array(8).fill('Translated paragraphs preserve readable scientific vocabulary.'), {information: {preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, mode: 'surprisal-local', style: 'background'}, scoreLocal: score, available: true}});
        await componentFlush(); flushFrames(); await componentFlush();
        expect(score).not.toHaveBeenCalled(); expect(reader.root.querySelector('.pdf-information-highlight')!.getAttribute('aria-pressed')).toBe('false');
        const before = reader.viewport.innerHTML;
        clickInformation(reader.root);
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        expect(score.mock.calls.some(([text]) => text === 'Original PDF words')).toBe(true);
        expect(score.mock.calls.some(([text]) => text.includes('Translated paragraphs'))).toBe(true);
        expect(registry.get(INFORMATION_HIGHLIGHT_NAME)!.size).toBeGreaterThan(0); expect(reader.viewport.innerHTML).toBe(before);
        reader.state.zoom = '1.5'; await componentFlush(); expect(registry.get(INFORMATION_HIGHLIGHT_NAME)?.size ?? 0).toBe(0);
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        reader.currentInformation.value = {...reader.currentInformation.value!, available: false}; await componentFlush(); expect(reader.state.informationState.enabled).toBe(false); expect(registry.has(INFORMATION_HIGHLIGHT_NAME)).toBe(false);
        reader.currentInformation.value = {...reader.currentInformation.value!, available: true}; await componentFlush(); clickInformation(reader.root); await componentFlush();
        reader.currentDocument.value = model(2); await componentFlush(); expect(reader.state.informationState.enabled).toBe(false); expect(registry.has(INFORMATION_HIGHLIGHT_NAME)).toBe(false);
        mountedApp.unmount(); mountedApp = undefined; await componentFlush(); expect(document.querySelector('[data-fr-information-highlight-style]')).toBeNull();
    });
    it('follows the saved switch on open and on document replacement while the toolbar still toggles the current document', async () => {
        const registry = nativeInformationPaint(), score = vi.fn(async (text: string) => scoreInformationKeywords(text));
        const painted = () => [...registry].filter(([name]) => name.startsWith(INFORMATION_HIGHLIGHT_NAME)).reduce((total, [, paint]) => total + paint.size, 0);
        const reader = mountReader(model(2), 'source', [], {information: {preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, enabled: true}, scoreLocal: score, available: true}});
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        expect(reader.root.querySelector('.pdf-information-highlight')!.getAttribute('aria-pressed')).toBe('true'); expect(painted()).toBeGreaterThan(0);
        expect(score).not.toHaveBeenCalled();
        clickInformation(reader.root); await componentFlush(); expect(reader.state.informationState.enabled).toBe(false); expect(painted()).toBe(0);
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...reader.currentInformation.value!.preferences, color: 'mint'}}; await componentFlush();
        expect(reader.state.informationState.enabled).toBe(false);
        reader.currentDocument.value = model(2);
        await vi.waitFor(async () => {flushFrames(); await componentFlush(); expect(reader.state.informationState.phase).toBe('active');}, {timeout: 3000});
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...reader.currentInformation.value!.preferences, enabled: false}}; await componentFlush();
        expect(reader.state.informationState.enabled).toBe(false); expect(painted()).toBe(0);
        mountedApp.unmount(); mountedApp = undefined; await componentFlush();
    });
    it('toggles the current document with the configured shortcut and ignores it when disabled, repeated, untrusted or unavailable', async () => {
        nativeInformationPaint(); const score = vi.fn(async (text: string) => scoreInformationKeywords(text));
        const reader = mountReader(model(2), 'source', [], {information: {preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES}, scoreLocal: score, available: true}});
        await componentFlush(); flushFrames(); await componentFlush();
        const press = (init: Record<string, unknown> = {}, trusted = true) => {
            const event = document.createEvent('Event'); event.initEvent('keydown', true, true);
            Object.assign(event, {key: 'h', code: 'KeyH', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, ...init});
            Object.defineProperty(event, 'isTrusted', {value: trusted}); document.dispatchEvent(event); return event;
        };
        expect(press().defaultPrevented).toBe(false); await componentFlush(); expect(reader.state.informationState.enabled).toBe(false); expect(score).not.toHaveBeenCalled();
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, hotkeyEnabled: true}}; await componentFlush();
        expect(press().defaultPrevented).toBe(true); await componentFlush(); expect(reader.state.informationState.enabled).toBe(true);
        for (const ignored of [press({}, false), press({repeat: true}), press({key: 'j', code: 'KeyJ'})]) expect(ignored.defaultPrevented).toBe(false);
        expect(reader.state.informationState.enabled).toBe(true);
        press(); await componentFlush(); expect(reader.state.informationState.enabled).toBe(false);
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, hotkeyEnabled: false}}; await componentFlush();
        expect(press().defaultPrevented).toBe(false); expect(reader.state.informationState.enabled).toBe(false);
        reader.currentInformation.value = {...reader.currentInformation.value!, preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, hotkeyEnabled: true}, available: false}; await componentFlush();
        expect(press().defaultPrevented).toBe(false);
        mountedApp.unmount(); mountedApp = undefined; await componentFlush(); expect(press().defaultPrevented).toBe(false);
    });
    it('aborts pending model scoring on document change and rejects stale text-layer results', async () => {
        const registry = nativeInformationPaint(), pending = deferred<any>(), signals: AbortSignal[] = [];
        const score = vi.fn((_text: string, signal: AbortSignal) => {signals.push(signal); return pending.promise;});
        const reader = mountReader(model(), 'source', [], {information: {preferences: {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, mode: 'surprisal-local', style: 'background'}, scoreLocal: score, available: true}});
        await componentFlush(); flushFrames(); await componentFlush(); clickInformation(reader.root);
        await vi.waitFor(() => {flushFrames(); expect(score).toHaveBeenCalledOnce();});
        reader.currentDocument.value = model(); await componentFlush(); expect(signals[0].aborted).toBe(true);
        pending.resolve(scoreInformationKeywords('Original PDF words')); await componentFlush(); flushFrames(); await componentFlush();
        expect(registry.has(INFORMATION_HIGHLIGHT_NAME)).toBe(false); expect(reader.state.informationState.enabled).toBe(false);
        reader.currentInformation.value = undefined; await componentFlush(); expect(reader.root.querySelector('.pdf-information-highlight')).toBeNull();
    });
});

describe('PDF reader actual Vue component reading interaction', () => {
    it.each([60, 120])('preserves page %i through narrow 120-page reading mode switches before the browser clamps a shorter document', async pageNumber => {
        const translations = Array.from({length: 120}, () => '完整长译文。'.repeat(200));
        const {root, viewport, state, currentMode, currentPresentation} = mountReader(model(120), 'bilingual', translations, {presentation: 'readable'});
        await componentFlush();
        // 窄屏下原文页高约 474px，短于 600px 视口；滚动到底时页码仍须报告末页。
        Object.assign(viewport, {clientWidth: 390});
        const extent = () => Math.max(0, Number.parseFloat((root.querySelector('.pdf-page-list') as HTMLElement).style.height) - viewport.clientHeight);
        let top = 0;
        // 模拟浏览器对布局更新后的 scrollTop 自动限制；Linkedom 不提供真实滚动几何。
        Object.defineProperty(viewport, 'scrollTop', {configurable: true, get: () => {top = Math.max(0, Math.min(top, extent())); return top;}, set: value => {top = Math.max(0, Math.min(Number(value), extent()));}});
        resizeCallback!([{target: viewport, contentRect: {} as DOMRectReadOnly, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: []}], {} as ResizeObserver);
        const measureResidentText = async () => {
            const sheets = [...root.querySelectorAll('[data-pdf-reading-page]')];
            for (const sheet of sheets) sheet.getBoundingClientRect = () => ({height: 1500} as DOMRect);
            resizeCallback!(sheets.map(target => ({target, contentRect: {} as DOMRectReadOnly, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: []})), {} as ResizeObserver);
            await componentFlush(); flushFrames(); await componentFlush();
        };
        await measureResidentText();
        state.jumpTo(pageNumber); await componentFlush(); await measureResidentText();
        expect(state.currentPage).toBe(pageNumber);
        const before = viewport.scrollTop;
        currentMode.value = 'translated'; await componentFlush(); flushFrames(); await componentFlush();
        if (pageNumber === 120) expect(extent()).toBeLessThan(before);
        expect(state.currentPage).toBe(pageNumber);
        expect(root.querySelector(`.pdf-page-row[data-page-number="${pageNumber}"]`)).toBeTruthy();
        for (const mode of ['bilingual', 'source', 'translated', 'source', 'bilingual'] as const) {
            currentMode.value = mode; await componentFlush(); flushFrames(); await componentFlush();
            expect(state.currentPage, mode).toBe(pageNumber);
            expect((root.querySelector('.pdf-page-navigation input') as HTMLInputElement).value).toBe(String(pageNumber));
            expect(root.querySelector(`.pdf-page-row[data-page-number="${pageNumber}"]`)).toBeTruthy();
        }
        for (const presentation of ['layout', 'readable'] as const) {
            currentPresentation.value = presentation; await componentFlush(); flushFrames(); await componentFlush();
            expect(state.currentPage).toBe(pageNumber);
            expect(root.querySelector(`.pdf-page-row[data-page-number="${pageNumber}"]`)).toBeTruthy();
        }
        expect(root.querySelectorAll('.pdf-page-row').length).toBeLessThanOrEqual(5);
    });

    it('displays a rotated formula with its canonical aspect and readable natural width', async () => {
        const doc = model();
        if (doc.binary?.kind === 'pdf') Object.assign(doc.binary.pages[0], {rotation: 90, width: 792, height: 612, preservedRegions: [{id: 'formula', kind: 'formula', x: 50, y: 300, width: 200, height: 30}]});
        pdfPage.getViewport.mockImplementation(({scale}: {scale: number}) => ({width: 792 * scale, height: 612 * scale, scale, rotation: 90}));
        const {root, state} = mountReader(doc, 'bilingual', ['译文'], {presentation: 'readable'});
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-region-id="pdf-1-region-formula"] canvas')).toBeTruthy());
        const host = root.querySelector('.pdf-region-canvas') as HTMLElement;
        expect(host.style.width).toBe('300px'); expect(host.style.getPropertyValue('aspectRatio')).toBe('200 / 30');
        state.zoom = '1.5'; await componentFlush();
        expect(host.style.width).toBe('450px'); expect(host.style.getPropertyValue('aspectRatio')).toBe('200 / 30');
        expect(root.querySelector('[data-pdf-resource="source"]')).toBeTruthy();
    });

    it('keeps the same visible paragraph at the same viewport offset when an earlier paragraph expands and when zoom changes', async () => {
        const doc = model();
        doc.segments = [...doc.segments, {id: 1, source: 'Second original paragraph'}];
        if (doc.binary?.kind === 'pdf') {doc.binary.pages[0].blocks.push({...pageModel(2).blocks[0], segmentIndex: 1}); doc.binary.pages[0].segmentIndexes.push(1);}
        const {root, viewport, state, currentTranslations} = mountReader(doc, 'translated', ['short', 'Reading this second paragraph'], {presentation: 'readable'});
        await componentFlush();
        const sheet = root.querySelector('[data-pdf-reading-page="1"]') as HTMLElement;
        const first = root.querySelector('[data-pdf-segment-index="0"]') as HTMLElement;
        const second = root.querySelector('[data-pdf-segment-index="1"]') as HTMLElement;
        const factor = () => Number.parseFloat(sheet.style.getPropertyValue('--pdf-reading-font-size')) / 16;
        const firstHeight = () => (first.textContent!.length > 100 ? 400 : 40) * factor();
        viewport.getBoundingClientRect = () => ({top: 0, bottom: 600, height: 600} as DOMRect);
        sheet.getBoundingClientRect = () => ({top: 80 - viewport.scrollTop, height: firstHeight() + 264} as DOMRect);
        first.getBoundingClientRect = () => ({top: 100 - viewport.scrollTop, bottom: 100 + firstHeight() - viewport.scrollTop, height: firstHeight()} as DOMRect);
        second.getBoundingClientRect = () => ({top: 120 + firstHeight() - viewport.scrollTop, bottom: 220 + firstHeight() - viewport.scrollTop, height: 100} as DOMRect);
        resizeCallback!([{target: sheet, contentRect: {} as DOMRectReadOnly, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: []}], {} as ResizeObserver);
        await componentFlush(); viewport.scrollTop = 110; state.scheduleViewport(); flushFrames(); await componentFlush();
        const before = second.getBoundingClientRect().top; expect(before).toBe(50);
        currentTranslations.value = ['首段增加到原来数倍长。'.repeat(100), 'Reading this second paragraph'];
        await componentFlush(); flushFrames(); await componentFlush();
        expect(second.getBoundingClientRect().top).toBe(before); expect(state.currentPage).toBe(1);
        state.zoom = '1.5'; await componentFlush(); flushFrames(); await componentFlush();
        expect(second.getBoundingClientRect().top).toBe(before); expect(state.currentPage).toBe(1);
        mountedApp.unmount(); mountedApp = undefined; await componentFlush(); expect(frames.size).toBe(0);
    });

    it('renders complete selectable HTML, preserves original graph regions and updates translations without redrawing original PDF pages', async () => {
        const doc = model(2);
        if (doc.binary?.kind === 'pdf') doc.binary.pages[0].preservedRegions = [{id: 'graph', kind: 'figure', x: 20, y: 200, width: 400, height: 300}];
        const full = '长译文完整显示，不缩小也不裁剪。'.repeat(200);
        const {root, viewport, state, currentTranslations} = mountReader(doc, 'bilingual', [full, 'second translation'], {presentation: 'readable'});
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-region-id="pdf-1-region-graph"] canvas')).toBeTruthy());
        const paragraph = root.querySelector('[data-pdf-segment-index="0"]')!;
        expect(paragraph.textContent).toBe(full); expect(paragraph.getAttribute('data-pdf-source-text')).toBe('Source 1');
        expect(root.querySelectorAll('[data-fluentread-pdf-text]')).toHaveLength(2);
        const draws = pdfPage.render.mock.calls.length;
        const original = root.querySelector('[data-pdf-resource="source"]');
        currentTranslations.value = [full + '末尾仍然可读。', 'second translation'];
        await componentFlush(); flushFrames(); await componentFlush();
        expect(root.querySelector('[data-pdf-segment-index="0"]')!.textContent).toBe(full + '末尾仍然可读。');
        expect(pdfPage.render).toHaveBeenCalledTimes(draws); expect(root.querySelector('[data-pdf-resource="source"]')).toBe(original);
        const sheet = root.querySelector('[data-pdf-reading-page="1"]') as HTMLElement;
        let height = 1500; sheet.getBoundingClientRect = () => ({height} as DOMRect);
        resizeCallback!([{target: sheet, contentRect: {} as DOMRectReadOnly, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: []}], {} as ResizeObserver); await componentFlush();
        // 重排阅读的行高取实测的阅读页高度：首行 12 + 1500，第二页顶部 1524，跳页停在页顶上方 6px。
        expect(state.layouts[0]).toMatchObject({top: 12, rowHeight: 1500}); expect(state.layouts[1].top).toBe(1524);
        state.jumpTo(2); await componentFlush(); expect(viewport.scrollTop).toBe(1518);
        height = 3000; resizeCallback!([{target: sheet, contentRect: {} as DOMRectReadOnly, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: []}], {} as ResizeObserver); await componentFlush();
        expect(state.layouts[0]).toMatchObject({top: 12, rowHeight: 3000}); expect(state.layouts[1].top).toBe(3024);
        expect(state.currentPage).toBe(2); expect(viewport.scrollTop).toBe(3024);
        expect(canvases.filter(canvas => canvas.width > 0).reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS * 2);
    });

    it('overlays positioned selectable translation blocks on the original layout, shows spinners only while translating, and updates text without redrawing any page', async () => {
        const doc = model();
        doc.segments = [...doc.segments, {id: 1, source: 'Second original paragraph'}];
        if (doc.binary?.kind === 'pdf') {doc.binary.pages[0].blocks.push({...pageModel(2).blocks[0], y: 300}); doc.binary.pages[0].segmentIndexes.push(1);}
        const {root, currentTranslations, currentTranslating, state} = mountReader(doc, 'bilingual', ['第一段译文', ''], {translating: true});
        await vi.waitFor(() => expect(root.querySelector('.pdf-page-column.translated [data-pdf-resource="translation"]')).toBeTruthy());
        await componentFlush();
        // 920px 视口并排两栏：缩放 = (920 − 三道 12px 间距) / 2 / 612；译文层使用页面内容坐标乘以缩放。
        const s = (920 - 36) / 2 / 612; const px = (value: number) => `${Math.round(value * 100) / 100}px`;
        expect(state.scale).toBeCloseTo(s, 12); expect(root.querySelector('.pdf-layout-viewer')!.getAttribute('data-pdf-presentation')).toBe('layout');
        expect(root.querySelector('.pdf-reading-sheet')).toBeNull(); expect(root.querySelector('.pdf-reading-continuation')).toBeNull(); expect(root.querySelector('.pdf-selection-hint')).toBeNull();
        expect(root.querySelector('.pdf-page-row-heading')).toBeNull(); expect(root.querySelector('figcaption')).toBeNull();
        const row = root.querySelector('.pdf-page-row[data-page-number="1"]') as HTMLElement;
        expect(row.style.top).toBe('12px'); expect(Number.parseFloat(row.style.height)).toBeCloseTo(792 * s, 8);
        expect(Number.parseFloat((root.querySelector('.pdf-page-list') as HTMLElement).style.height)).toBeCloseTo(12 + 792 * s + 12, 8);
        const layer = root.querySelector('.pdf-page-column.translated .pdf-translation-layer[data-fluentread-pdf-translation][data-pdf-reading-page="1"]') as HTMLElement;
        expect(layer.style.width).toBe('442px'); expect(layer.style.height).toBe(px(792 * s)); expect(layer.style.getPropertyValue('transform') || '').toBe('');
        const block = (index: number) => layer.querySelector(`.pdf-translation-block[data-pdf-segment-index="${index}"]`) as HTMLElement | null;
        const spinner = (index: number) => layer.querySelector(`.pdf-translation-spinner[data-pdf-pending-segment="${index}"]`) as HTMLElement | null;
        const first = block(0)!;
        expect(first.getAttribute('data-pdf-source-id')).toBe('pdf-1-segment-0'); expect(first.getAttribute('data-pdf-source-text')).toBe('Source 1'); expect(first.getAttribute('data-pdf-role')).toBe('text');
        expect(first.textContent).toBe('第一段译文');
        expect([...first.querySelectorAll('.pdf-translation-text > span')].map(line => line.textContent)).toEqual(['第一段译文']);
        // 两行段落保持原栏宽；高度可借用到下一段（y=300）上方 1.5pt 处。
        expect(first.style.left).toBe(px(50 * s)); expect(first.style.top).toBe(px(70 * s)); expect(first.style.width).toBe(px(200 * s)); expect(first.style.height).toBe(px((300 - 70 - 1.5) * s));
        expect((first.querySelector('.pdf-translation-text') as HTMLElement).style.getPropertyValue('fontSize')).toBe(px(12 * s));
        expect(first.querySelectorAll('.pdf-translation-erase')).toHaveLength(1);
        expect(block(1)).toBeNull(); expect(layer.querySelectorAll('.pdf-translation-block')).toHaveLength(1);
        const pending = spinner(1)!;
        expect(pending.getAttribute('role')).toBe('status'); expect(spinner(0)).toBeNull(); expect(layer.querySelectorAll('.pdf-translation-spinner')).toHaveLength(1);
        expect(pending.style.left).toBe(px(250 * s + 2)); expect(pending.style.top).toBe(px(320 * s - 8));
        currentTranslating.value = false; await componentFlush(); expect(layer.querySelector('.pdf-translation-spinner')).toBeNull(); expect(block(0)).toBe(first);
        currentTranslating.value = true; await componentFlush(); expect(spinner(1)).toBeTruthy();
        // 译文页是原页像素的一次复制；悬停译文段落时在原文页同一矩形上高亮。
        const source = root.querySelector('.pdf-page-column:not(.translated) [data-pdf-resource="source"]') as HTMLCanvasElement;
        const translation = root.querySelector('.pdf-page-column.translated [data-pdf-resource="translation"]') as HTMLCanvasElement;
        expect(translation).not.toBe(source); expect(translation.getContext('2d')!.drawImage).toHaveBeenCalledWith(source, 0, 0); expect(translation.getContext('2d')!.fillText).not.toHaveBeenCalled();
        first.dispatchEvent(new document.defaultView!.Event('pointerenter')); await componentFlush();
        const mark = root.querySelector('.pdf-page-column:not(.translated) .pdf-source-highlight') as HTMLElement;
        expect(mark.style.left).toBe(px(50 * s - 3)); expect(mark.style.top).toBe(px(70 * s - 3)); expect(mark.style.width).toBe(px(200 * s + 6)); expect(mark.style.height).toBe(px(40 * s + 6));
        layer.dispatchEvent(new document.defaultView!.Event('pointerleave')); await componentFlush(); expect(root.querySelector('.pdf-source-highlight')).toBeNull();
        const draws = pdfPage.render.mock.calls.length, viewports = pdfPage.getViewport.mock.calls.length, textLayers = ports.textLayers.length, allocated = canvases.length;
        expect(draws).toBe(1);
        currentTranslations.value = ['第一段译文已经更新', '第二段译文']; await componentFlush(); flushFrames(); await componentFlush();
        expect(block(0)).toBe(first); expect(first.textContent).toBe('第一段译文已经更新');
        expect(block(1)!.textContent).toBe('第二段译文'); expect(block(1)!.getAttribute('data-pdf-source-id')).toBe('pdf-1-segment-1'); expect(block(1)!.getAttribute('data-pdf-source-text')).toBe('Second original paragraph');
        expect(block(1)!.style.top).toBe(px(300 * s)); expect(block(1)!.style.height).toBe(px((792 - 300 - 1.5) * s)); expect(layer.querySelector('.pdf-translation-spinner')).toBeNull();
        // 与原文相同的“译文”既不替换段落，也不算等待中。
        currentTranslations.value = ['Source 1', '第二段译文再次更新']; await componentFlush(); flushFrames(); await componentFlush();
        expect(block(0)).toBeNull(); expect(spinner(0)).toBeNull(); expect(block(1)!.textContent).toBe('第二段译文再次更新');
        expect(pdfPage.render).toHaveBeenCalledTimes(draws); expect(pdfPage.getViewport).toHaveBeenCalledTimes(viewports); expect(ports.textLayers).toHaveLength(textLayers); expect(canvases).toHaveLength(allocated);
        expect(ports.getDocument).toHaveBeenCalledOnce();
        expect(root.querySelector('.pdf-page-column.translated [data-pdf-resource="translation"]')).toBe(translation); expect(root.querySelector('.pdf-page-column:not(.translated) [data-pdf-resource="source"]')).toBe(source);
        expect(translation.width).toBeGreaterThan(0); expect(translation.getContext('2d')!.fillText).not.toHaveBeenCalled(); expect(root.querySelector('.pdf-page-row')!.getAttribute('data-render-state')).toBe('ready');
    });

    it('lays out layout-presentation rows with 12px gutters, side by side from 900px and stacked below it', async () => {
        const {root, viewport, state, currentMode} = mountReader(model(3), 'bilingual', ['甲', '乙', '丙']); await componentFlush();
        const resize = async (clientWidth: number) => {Object.assign(viewport, {clientWidth}); resizeCallback!([], {} as ResizeObserver); await componentFlush(); flushFrames(); await componentFlush();};
        const stage = () => (root.querySelector('.pdf-page-row[data-page-number="1"] .pdf-page-stage') as HTMLElement).getAttribute('class')!.split(/\s+/);
        const total = () => Number.parseFloat((root.querySelector('.pdf-page-list') as HTMLElement).style.height);
        const expectRows = (rowHeight: number) => state.layouts.forEach((layout: {top: number; rowHeight: number}, index: number) => {expect(layout.top).toBeCloseTo(12 + index * (rowHeight + 12), 8); expect(layout.rowHeight).toBeCloseTo(rowHeight, 8);});
        await resize(900);
        const wide = (900 - 36) / 2 / 612;
        expect(state.stackedBilingual).toBe(false); expect(state.scale).toBeCloseTo(wide, 12); expect(stage()).not.toContain('stacked'); expect(stage()).not.toContain('single');
        expectRows(792 * wide); expect(total()).toBeCloseTo(3 * 792 * wide + 48, 8);
        const second = root.querySelector('.pdf-page-row[data-page-number="2"]') as HTMLElement;
        expect(second.style.top).toBe(`${state.layouts[1].top}px`); expect(second.style.height).toBe(`${state.layouts[1].rowHeight}px`);
        expect((second.querySelector('.pdf-page-stage') as HTMLElement).style.getPropertyValue('--pdf-page-width')).toBe(`${612 * wide}px`);
        await resize(899);
        const narrow = (899 - 24) / 612;
        expect(state.stackedBilingual).toBe(true); expect(state.scale).toBeCloseTo(narrow, 12); expect(stage()).toContain('stacked');
        expectRows(792 * narrow * 2 + 12); expect(total()).toBeCloseTo(3 * (792 * narrow * 2 + 12) + 48, 8);
        currentMode.value = 'translated'; await componentFlush(); flushFrames(); await componentFlush();
        expect(state.stackedBilingual).toBe(false); expect(stage()).toContain('single'); expect(state.scale).toBeCloseTo(narrow, 12);
        expectRows(792 * narrow); expect(total()).toBeCloseTo(3 * 792 * narrow + 48, 8);
        currentMode.value = 'source'; await componentFlush(); flushFrames(); await componentFlush();
        expectRows(792 * narrow); expect(total()).toBeCloseTo(3 * 792 * narrow + 48, 8);
    });

    it('defaults to the original layout, emits the presentation choice, keeps long translations whole in both presentations and reports page changes', async () => {
        const full = '完整译文'.repeat(1000);
        const {root, currentMode, currentPresentation, presentations, pageChanges, state} = mountReader(model(3), 'translated', [full, '', ''], {translating: true});
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-resource="translation"]')).toBeTruthy()); await componentFlush();
        expect(currentPresentation.value).toBeUndefined(); expect(state.presentation).toBe('layout'); expect(root.querySelector('.pdf-layout-viewer')!.getAttribute('data-pdf-presentation')).toBe('layout');
        const menu = () => root.querySelector('.pdf-presentation-control.pdf-menu') as HTMLElement;
        expect(root.querySelector('select')).toBeNull(); expect(menu().querySelector('.pdf-menu-list')).toBeNull();
        expect(menu().querySelector('.pdf-menu-button')!.textContent).toBe('document.pdfReading.layoutPresentation');
        click(menu().querySelector('.pdf-menu-button')); await componentFlush();
        expect([...menu().querySelectorAll('ul.pdf-menu-list[role="listbox"] > li[role="option"]')].map(option => option.getAttribute('data-value'))).toEqual(['layout', 'readable']);
        click(menu().querySelector('.pdf-menu-button')); await componentFlush(); expect(menu().querySelector('.pdf-menu-list')).toBeNull();
        // 仅译文：译文画布就是页面画布，没有原文栏与原文文字层；放不下的长译文标记溢出但文字完整。
        expect(root.querySelector('[data-pdf-resource="source"]')).toBeNull(); expect(root.querySelector('[data-fluentread-pdf-text]')).toBeNull(); expect(root.querySelectorAll('.pdf-page-column')).toHaveLength(root.querySelectorAll('.pdf-page-column.translated').length);
        const overlay = root.querySelector('.pdf-translation-layer[data-pdf-reading-page="1"] .pdf-translation-block[data-pdf-segment-index="0"]') as HTMLElement;
        expect(overlay.textContent).toBe(full); expect(overlay.getAttribute('class')!.split(/\s+/)).toContain('overflowing');
        expect(root.querySelector('.pdf-translation-layer[data-pdf-reading-page="2"] .pdf-translation-spinner[data-pdf-pending-segment="1"]')).toBeTruthy();
        expect(root.querySelector('.pdf-translation-layer[data-pdf-reading-page="2"] .pdf-translation-block')).toBeNull();
        expect(pageChanges).toEqual([1]);
        state.jumpTo(3); await componentFlush(); state.jumpTo(3); await componentFlush();
        expect(pageChanges).toEqual([1, 3]); expect(state.currentPage).toBe(3);
        state.jumpTo(1); await componentFlush(); expect(pageChanges).toEqual([1, 3, 1]);
        const choose = async (value: string) => {click(menu().querySelector('.pdf-menu-button')); await componentFlush(); click(menu().querySelector(`li[data-value="${value}"]`)); await componentFlush(); flushFrames(); await componentFlush(); expect(menu().querySelector('.pdf-menu-list')).toBeNull();};
        // 选择当前已选的显示方式只收起菜单，不重复发出事件。
        await choose('layout'); expect(presentations).toEqual([]);
        await choose('readable'); expect(menu().querySelector('.pdf-menu-button')!.textContent).toBe('document.pdfReading.readablePresentation');
        expect(presentations).toEqual(['readable']); expect(currentPresentation.value).toBe('readable'); expect(root.querySelector('.pdf-layout-viewer')!.getAttribute('data-pdf-presentation')).toBe('readable');
        expect(root.querySelector('.pdf-translation-layer')).toBeNull(); expect(root.querySelector('.pdf-reading-continuation')).toBeNull();
        expect(root.querySelector('.pdf-reading-sheet[data-pdf-reading-page="1"] [data-pdf-segment-index="0"]')!.textContent).toBe(full);
        expect(root.querySelector('.pdf-reading-sheet[data-pdf-reading-page="2"] [data-pdf-segment-index="1"] .pdf-translation-spinner.inline')).toBeTruthy();
        await choose('layout');
        expect(presentations).toEqual(['readable', 'layout']); expect(currentPresentation.value).toBe('layout'); expect(root.querySelector('.pdf-reading-sheet')).toBeNull();
        await vi.waitFor(() => expect(root.querySelector('.pdf-page-row[data-page-number="1"] [data-pdf-resource="translation"]')).toBeTruthy());
        expect(root.querySelector('.pdf-translation-block[data-pdf-segment-index="0"]')!.textContent).toBe(full);
        currentPresentation.value = 'readable'; await componentFlush(); flushFrames(); await componentFlush();
        expect(state.presentation).toBe('readable'); expect(presentations).toEqual(['readable', 'layout']); expect(root.querySelector('.pdf-reading-sheet')).toBeTruthy();
        currentMode.value = 'source'; await componentFlush(); flushFrames(); await componentFlush();
        expect(root.querySelector('.pdf-presentation-control')).toBeNull(); expect(root.querySelector('.pdf-reading-sheet')).toBeNull(); expect(root.querySelector('.pdf-translation-layer')).toBeNull(); expect(root.querySelector('.pdf-page-column.translated')).toBeNull();
        expect(pageChanges).toEqual([1, 3, 1]);
    });

    it('preserves a page-number draft across queued scrolling, then resumes the visible counter after commit', async () => {
        const {root, viewport, state} = mountReader(model(120)); await componentFlush();
        const input = root.querySelector('.pdf-page-navigation input') as HTMLInputElement;
        const event = (name: string, key?: string) => {const value = new document.defaultView!.Event(name); if (key) Object.assign(value, {key}); input.dispatchEvent(value);};
        state.jumpTo(60); state.jumpTo(120); await componentFlush();
        event('focus'); input.value = '1'; event('input');
        viewport.dispatchEvent(new document.defaultView!.Event('scroll')); flushFrames(); await componentFlush();
        expect(state.currentPage).toBe(120); expect(input.value).toBe('1');
        event('keydown', 'Enter'); await componentFlush();
        expect(state.currentPage).toBe(1); expect(input.value).toBe('1'); expect(viewport.scrollTop).toBe(6);
        viewport.scrollTop = state.layouts[59].top; viewport.dispatchEvent(new document.defaultView!.Event('scroll')); flushFrames(); await componentFlush();
        expect(state.currentPage).toBe(60); expect(input.value).toBe('60');
        for (const [draft, commit, expected] of [['0', 'change', 1], ['999', 'blur', 120], ['not-a-page', 'keydown', 120]] as const) {
            input.value = draft; event('input'); event(commit, commit === 'keydown' ? 'Enter' : undefined); await componentFlush();
            expect(state.currentPage).toBe(expected); expect(input.value).toBe(String(expected));
        }
    });

    it('recovers a failed page through its retry button and handles native page and zoom controls without losing a drag origin', async () => {
        const getPage = vi.fn(async () => pdfPage).mockRejectedValueOnce(new Error('temporary page failure'));
        ports.getDocument.mockReturnValueOnce({promise: Promise.resolve({getPage}), destroy});
        const {root, state} = mountReader(model(10));
        await vi.waitFor(() => expect(root.querySelector('.pdf-page-error')).toBeTruthy());
        expect(root.querySelector('.pdf-page-error')!.textContent).toContain('temporary page failure');
        root.querySelector('.pdf-page-error button')!.dispatchEvent(new document.defaultView!.Event('click'));
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-page-number="1"] span')).toBeTruthy());
        const buttons = root.querySelectorAll('.pdf-page-navigation button');
        buttons[1].dispatchEvent(new document.defaultView!.Event('click')); await componentFlush(); expect(state.currentPage).toBe(2);
        buttons[0].dispatchEvent(new document.defaultView!.Event('click')); await componentFlush(); expect(state.currentPage).toBe(1);
        const input = root.querySelector('.pdf-page-navigation input') as HTMLInputElement;
        input.value = '3'; input.dispatchEvent(new document.defaultView!.Event('input')); input.dispatchEvent(new document.defaultView!.Event('change'));
        await componentFlush(); expect(state.currentPage).toBe(3);
        const menu = root.querySelector('.pdf-zoom-control .pdf-menu') as HTMLElement; const menuButton = menu.querySelector('.pdf-menu-button') as HTMLElement;
        const pick = async (value: string) => {click(menuButton); await componentFlush(); click(menu.querySelector(`li[data-value="${value}"]`)); await componentFlush();};
        expect(root.querySelector('select')).toBeNull(); expect(menu.querySelector('.pdf-menu-list')).toBeNull(); expect(menuButton.getAttribute('aria-label')).toBe('document.pdfReading.zoomLabel');
        click(menuButton); await componentFlush();
        expect([...menu.querySelectorAll('ul.pdf-menu-list[role="listbox"] > li[role="option"]')].map(option => option.getAttribute('data-value'))).toEqual(['fit', 'page', '0.5', '0.75', '1', '1.25', '1.5', '2', '3']);
        click(menuButton); await componentFlush(); expect(menu.querySelector('.pdf-menu-list')).toBeNull();
        expect(root.querySelector('.pdf-selection-hint')).toBeNull(); expect(root.querySelector('.pdf-presentation-control')).toBeNull(); expect(root.querySelector('.pdf-style')).toBeNull();
        // 适合宽度：(920 − 24) / 612 ≈ 1.46；＋ 进到下一档 150%，− 退到 125%；适合页面受 600px 视口高度限制。
        const [zoomOut, zoomIn] = Array.from(root.querySelectorAll('.pdf-zoom-control > button'));
        expect(state.zoom).toBe('fit'); expect(state.scale).toBeCloseTo((920 - 24) / 612, 12); expect(menuButton.textContent).toBe('document.pdfReading.fitWidth');
        click(zoomIn); await componentFlush(); expect(state.zoom).toBe('1.5'); expect(menuButton.textContent).toBe('150%');
        click(zoomOut); await componentFlush(); expect(state.zoom).toBe('1.25'); expect(state.currentPage).toBe(3);
        resizeCallback!([], {} as ResizeObserver); await componentFlush();
        await pick('page'); expect(menu.querySelector('.pdf-menu-list')).toBeNull(); expect(menuButton.textContent).toBe('document.pdfReading.fitPage');
        expect(state.zoom).toBe('page'); expect(state.scale).toBeCloseTo((600 - 24) / 792, 12); expect(state.layouts[0].height).toBeCloseTo(576, 8); expect(state.currentPage).toBe(3);
        await pick('1.25'); expect(state.zoom).toBe('1.25'); expect(menuButton.textContent).toBe('125%'); expect(state.currentPage).toBe(3);
        state.jumpTo(1); await componentFlush(); await vi.waitFor(() => expect(root.querySelector('[data-pdf-page-number="1"] span')).toBeTruthy());
        const span = root.querySelector('[data-pdf-page-number="1"] span')!;
        const textLayer = span.closest('[data-fluentread-pdf-text]') as HTMLElement;
        expect(textLayer.querySelector('[data-fluentread-pdf-selection-guard]')).toBeNull();
        // 主键在文字层内按下：层尾追加一块选区垫片并进入拖选状态；松开后垫片留在层尾、尺寸复位。
        span.dispatchEvent(Object.assign(new document.defaultView!.Event('pointerdown', {bubbles: true}), {button: 0}));
        const guard = textLayer.querySelector('[data-fluentread-pdf-selection-guard]') as HTMLElement;
        expect(guard.getAttribute('class')).toBe('fluentread-pdf-selection-guard'); expect(textLayer.lastElementChild).toBe(guard); expect(textLayer.getAttribute('class')!.split(/\s+/)).toContain('selecting');
        span.dispatchEvent(Object.assign(new document.defaultView!.Event('pointerdown', {bubbles: true}), {button: 0})); expect(textLayer.querySelectorAll('[data-fluentread-pdf-selection-guard]')).toHaveLength(1);
        state.jumpTo(8); await componentFlush(); expect(root.querySelector('[data-pdf-page-number="1"]')).toBeTruthy();
        document.body.dispatchEvent(new document.defaultView!.Event('pointerup', {bubbles: true}));
        expect(textLayer.getAttribute('class')!.split(/\s+/)).not.toContain('selecting'); expect(textLayer.lastElementChild).toBe(guard); expect(guard.style.width).toBe('');
        flushFrames(); await componentFlush(); expect(root.querySelector('[data-pdf-page-number="1"]')).toBeNull();
        document.body.dispatchEvent(new document.defaultView!.Event('pointerdown', {bubbles: true}));
        const heading = root.querySelector('.pdf-page-frame')!;
        heading.dispatchEvent(Object.assign(new document.defaultView!.Event('pointerdown', {bubbles: true}), {button: 0}));
        expect(root.querySelectorAll('[data-fluentread-pdf-text]').length).toBeGreaterThan(0); expect(root.querySelector('[data-fluentread-pdf-text].selecting')).toBeNull();
        selection = {rangeCount: 1, isCollapsed: false, getRangeAt: () => ({startContainer: heading, endContainer: heading})};
        document.dispatchEvent(new document.defaultView!.Event('selectionchange')); flushFrames();
        selection = {rangeCount: 1, isCollapsed: true}; document.dispatchEvent(new document.defaultView!.Event('selectionchange')); flushFrames();
    });

    it('keeps page 60 and its position through fit, 100%, 150%, resize, and translated mode while mounting at most five page shells', async () => {
        const {root, viewport, state, currentMode, currentTranslations} = mountReader(model(120));
        await vi.waitFor(() => expect([...state.states.values()]).toEqual(Array.from({length: 5}, () => expect.objectContaining({status: 'ready'}))));
        expect(root.getAttribute('data-document-reader')).toBeNull();
        expect(root.querySelector('[data-fluentread-pdf-title]')!.getAttribute('data-fluentread-pdf-source-url')).toBe('https://arxiv.org/pdf/1706.03762');
        state.jumpTo(60); await componentFlush();
        expect(state.currentPage).toBe(60); expect(root.querySelector('.pdf-page-row[data-page-number="60"]')).toBeTruthy();
        const before = viewport.scrollTop;
        state.zoom = '1'; await componentFlush(); expect(state.currentPage).toBe(60); expect(viewport.scrollTop).toBeLessThan(before);
        state.zoom = '1.5'; await componentFlush(); expect(state.currentPage).toBe(60);
        state.zoom = 'fit'; await componentFlush();
        Object.assign(viewport, {clientWidth: 500}); resizeCallback!([], {} as ResizeObserver); await componentFlush(); expect(state.currentPage).toBe(60);
        currentTranslations.value = Array.from({length: 120}, () => '译文'); currentMode.value = 'bilingual'; await componentFlush(); expect(state.currentPage).toBe(60);
        expect(root.querySelectorAll('.pdf-page-row').length).toBeLessThanOrEqual(5);
        await vi.waitFor(() => {
            const originalReady = canvases.filter(canvas => canvas.width > 0);
            expect(originalReady.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0), JSON.stringify(originalReady.map(canvas => ({width: canvas.width, height: canvas.height, page: canvas.closest('.pdf-page-row')?.getAttribute('data-page-number')})))).toBeLessThanOrEqual(PDF_READER_MAX_PAGE_PIXELS * 5);
        });
        currentMode.value = 'translated'; await componentFlush(); expect(state.currentPage).toBe(60); expect(root.querySelectorAll('.pdf-page-column:not(.translated)')).toHaveLength(0);
        state.pageInput = 1000; state.commitPageInput(); await componentFlush(); expect(state.currentPage).toBe(120);
        state.jumpTo(NaN); expect(state.currentPage).toBe(120);
        state.jumpTo(-50); await componentFlush(); expect(state.currentPage).toBe(1);
    });

    it('pins native and card selections across scrolling but prioritizes a far jump even when five pages are selected', async () => {
        const {root, state} = mountReader(model(120));
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-page-number="5"] span')).toBeTruthy());
        const first = root.querySelector('[data-pdf-page-number="1"] span')!.firstChild!;
        const second = root.querySelector('[data-pdf-page-number="2"] span')!.firstChild!;
        const fifth = root.querySelector('[data-pdf-page-number="5"] span')!.firstChild!;
        const range = {startContainer: first, endContainer: second};
        selection = {rangeCount: 1, isCollapsed: false, getRangeAt: () => range};
        document.dispatchEvent(new document.defaultView!.Event('selectionchange')); flushFrames();
        state.jumpTo(60); await componentFlush(); expect(root.querySelector('[data-pdf-page-number="1"]')).toBeTruthy(); expect(root.querySelector('[data-pdf-page-number="2"]')).toBeTruthy();
        document.body.dispatchEvent(new document.defaultView!.CustomEvent('fluentread-pdf-selection-range-change', {detail: {range}})); flushFrames();
        selection = undefined; document.dispatchEvent(new document.defaultView!.Event('selectionchange')); flushFrames();
        state.jumpTo(80); await componentFlush(); expect(root.querySelector('[data-pdf-page-number="1"]')).toBeTruthy();
        document.body.dispatchEvent(new document.defaultView!.CustomEvent('fluentread-pdf-selection-range-change', {detail: {range: {startContainer: first, endContainer: fifth}}})); flushFrames();
        state.jumpTo(120); await componentFlush(); expect(root.querySelector('.pdf-page-row[data-page-number="120"]')).toBeTruthy(); expect(state.residentIndexes.length).toBe(5);
        document.body.dispatchEvent(new document.defaultView!.CustomEvent('fluentread-pdf-selection-range-change', {detail: {range: null}})); flushFrames();
        await componentFlush(); expect(root.querySelector('[data-pdf-page-number="1"]')).toBeNull();
    });

    it('renders every visible short page before old selection pins when several pages fit in the viewport', async () => {
        const doc = model(120);
        // 适合宽度封顶 300%：每页 300×240px、行距 252px，600px 视口内同时可见三页。
        if (doc.binary?.kind === 'pdf') doc.binary.pages = doc.binary.pages.map(page => ({...page, width: 100, height: 80}));
        pdfPage.getViewport.mockImplementation(({scale}: {scale: number}) => ({width: 100 * scale, height: 80 * scale, scale}));
        const {root, viewport, state} = mountReader(doc);
        await vi.waitFor(() => expect(root.querySelector('[data-pdf-page-number="4"] span')).toBeTruthy());
        const range = {startContainer: root.querySelector('[data-pdf-page-number="1"] span')!.firstChild!, endContainer: root.querySelector('[data-pdf-page-number="4"] span')!.firstChild!};
        document.body.dispatchEvent(new document.defaultView!.CustomEvent('fluentread-pdf-selection-range-change', {detail: {range}})); flushFrames();
        expect(state.scale).toBe(3); expect(state.layouts.slice(0, 3).map((layout: {top: number}) => layout.top)).toEqual([12, 264, 516]);
        state.jumpTo(50); await componentFlush();
        expect(viewport.scrollTop).toBe(12 + 49 * 252 - 6);
        expect(state.residentIndexes).toEqual([49, 50, 51, 0, 1]);
        for (const page of [50, 51, 52]) await vi.waitFor(() => expect(root.querySelector(`.pdf-page-row[data-page-number="${page}"][data-render-state="ready"]`)).toBeTruthy());
        expect(root.querySelectorAll('.pdf-page-row')).toHaveLength(5);
    });

    it('handles keyboard page navigation, live document replacement, retry, and releases listeners, frame, observer and canvases on unmount', async () => {
        const {root, viewport, state, currentDocument} = mountReader(model(10)); await componentFlush();
        const key = (value: string, target: EventTarget = viewport, ctrlKey = false) => {const event = {key: value, target, altKey: false, ctrlKey, metaKey: false, preventDefault: vi.fn()}; state.handleViewportKey(event); return event;};
        key('PageDown'); await componentFlush(); expect(state.currentPage).toBe(2); key('PageUp'); await componentFlush(); expect(state.currentPage).toBe(1); key('End'); await componentFlush(); expect(state.currentPage).toBe(10); key('Home'); await componentFlush(); expect(state.currentPage).toBe(1);
        expect(key('Home', root).preventDefault).not.toHaveBeenCalled(); expect(key('Home', viewport, true).preventDefault).not.toHaveBeenCalled(); expect(key('ArrowDown').preventDefault).not.toHaveBeenCalled();
        const priorIdentity = root.querySelector('[data-fluentread-pdf-document-id]')!.getAttribute('data-fluentread-pdf-document-id');
        currentDocument.value = model(2); await componentFlush(); expect(state.currentPage).toBe(1); expect(root.querySelector('[data-fluentread-pdf-document-id]')!.getAttribute('data-fluentread-pdf-document-id')).not.toBe(priorIdentity);
        state.scheduleViewport(); state.scheduleViewport(); expect(frames.size).toBe(1);
        mountedApp.unmount(); mountedApp = undefined; flushFrames(); await componentFlush();
        expect(disconnect).toHaveBeenCalledOnce(); expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        document.dispatchEvent(new document.defaultView!.Event('selectionchange')); expect(frames.size).toBe(0);
    });
    it('opens one toolbar menu at a time and closes it on an outside pointerdown or Escape, never on a press inside the menu', async () => {
        const {root, state} = mountReader(model(), 'bilingual', ['译文']); await componentFlush();
        const zoom = root.querySelector('.pdf-zoom-control .pdf-menu') as HTMLElement; const presentation = root.querySelector('.pdf-presentation-control.pdf-menu') as HTMLElement;
        const zoomButton = zoom.querySelector('.pdf-menu-button') as HTMLElement; const presentationButton = presentation.querySelector('.pdf-menu-button') as HTMLElement;
        const open = () => ['zoom', 'presentation', 'search', 'style'].filter((_name, index) => classes([zoom, presentation, root.querySelector('.pdf-search'), root.querySelector('.pdf-style')][index]).includes('open'));
        const press = (target: EventTarget) => target.dispatchEvent(new document.defaultView!.Event('pointerdown', {bubbles: true}));
        const key = (value: string) => document.dispatchEvent(Object.assign(new document.defaultView!.Event('keydown', {bubbles: true}), {key: value}));
        expect(open()).toEqual([]); expect(root.querySelectorAll('.pdf-menu-list, .pdf-menu-panel')).toHaveLength(0); expect(zoomButton.getAttribute('aria-expanded')).toBe('false');
        click(zoomButton); await componentFlush();
        expect(open()).toEqual(['zoom']); expect(zoomButton.getAttribute('aria-expanded')).toBe('true'); expect(zoom.querySelector('.pdf-menu-list')!.getAttribute('aria-label')).toBe('document.pdfReading.zoomLabel');
        const selected = () => [...zoom.querySelectorAll('li')].filter(option => option.getAttribute('aria-selected') === 'true' && classes(option).includes('selected')).map(option => option.getAttribute('data-value'));
        expect(selected()).toEqual(['fit']); expect([...zoom.querySelectorAll('li')].map(option => option.textContent)).toEqual(['document.pdfReading.fitWidth', 'document.pdfReading.fitPage', '50%', '75%', '100%', '125%', '150%', '200%', '300%']);
        click(presentationButton); await componentFlush();
        expect(open()).toEqual(['presentation']); expect(zoom.querySelector('.pdf-menu-list')).toBeNull(); expect(root.querySelectorAll('.pdf-menu-list')).toHaveLength(1);
        expect([...presentation.querySelectorAll('li')].filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.getAttribute('data-value'))).toEqual(['layout']);
        click(root.querySelector('.pdf-search .pdf-tool-button')); await componentFlush(); expect(open()).toEqual(['search']); expect(root.querySelector('.pdf-search-panel')).toBeTruthy(); expect(root.querySelector('.pdf-menu-list')).toBeNull();
        click(root.querySelector('.pdf-style .pdf-tool-button')); await componentFlush(); expect(open()).toEqual(['style']); expect(root.querySelector('.pdf-style-panel')).toBeTruthy(); expect(root.querySelector('.pdf-search-panel')).toBeNull();
        click(zoomButton); await componentFlush(); expect(open()).toEqual(['zoom']);
        // 菜单内部的按下不收起；按下阅读区或页面其他位置才收起。
        press(zoom.querySelector('li[data-value="2"]')!); await componentFlush(); expect(open()).toEqual(['zoom']);
        press(zoomButton); await componentFlush(); expect(open()).toEqual(['zoom']);
        key('Enter'); await componentFlush(); expect(open()).toEqual(['zoom']);
        press(root.querySelector('[data-pdf-scroll]')!); await componentFlush(); expect(open()).toEqual([]); expect(root.querySelector('.pdf-menu-list')).toBeNull(); expect(state.zoom).toBe('fit');
        click(presentationButton); await componentFlush(); expect(open()).toEqual(['presentation']);
        press(document.body); await componentFlush(); expect(open()).toEqual([]);
        click(zoomButton); await componentFlush(); key('Escape'); await componentFlush(); expect(open()).toEqual([]); expect(zoomButton.getAttribute('aria-expanded')).toBe('false');
        key('Escape'); press(document.body); await componentFlush(); expect(open()).toEqual([]);
        click(zoomButton); await componentFlush(); click(zoom.querySelector('li[data-value="2"]')); await componentFlush();
        expect(open()).toEqual([]); expect(state.zoom).toBe('2'); expect(state.scale).toBe(2); expect(zoomButton.textContent).toBe('200%');
        click(zoomButton); await componentFlush(); expect(selected()).toEqual(['2']);
        mountedApp.unmount(); mountedApp = undefined; key('Escape'); press(document.body);
    });

    it('searches source and translation text case-insensitively, steps through hits with wrap-around, jumps to the hit and highlights it while the panel is open', async () => {
        const {root, viewport, state, pageChanges} = mountReader(model(3), 'bilingual', ['Alpha 译文', 'beta ALPHA', '']); await componentFlush();
        const s = (920 - 36) / 2 / 612; const px = (value: number) => `${Math.round(value * 100) / 100}px`; const rowTop = (index: number) => 12 + index * (792 * s + 12);
        const tool = root.querySelector('.pdf-search .pdf-tool-button') as HTMLElement;
        expect(root.querySelector('.pdf-search-panel')).toBeNull(); expect(classes(tool)).not.toContain('active');
        click(tool); await componentFlush();
        const panel = root.querySelector('.pdf-search-panel[role="dialog"]') as HTMLElement; const input = panel.querySelector('input') as HTMLInputElement;
        const [previous, next] = Array.from(panel.querySelectorAll('button')); const count = () => panel.querySelector('.pdf-search-count')!.textContent;
        const type = async (value: string) => {input.value = value; input.dispatchEvent(new document.defaultView!.Event('input')); await componentFlush(); flushFrames(); await componentFlush();};
        const enter = async (shiftKey = false) => {const event = Object.assign(new document.defaultView!.Event('keydown'), {key: 'Enter', shiftKey, preventDefault: vi.fn()}); input.dispatchEvent(event); await componentFlush(); return event;};
        const marks = (page: number) => [...root.querySelectorAll(`.pdf-page-row[data-page-number="${page}"] .pdf-source-highlight.search`)] as HTMLElement[];
        expect(count()).toBe(''); expect(previous.hasAttribute('disabled')).toBe(true); expect(next.hasAttribute('disabled')).toBe(true);
        click(next); await enter(); expect(viewport.scrollTop).toBe(0); expect(root.querySelector('.pdf-source-highlight')).toBeNull();
        await type('zzz'); expect(count()).toBe('0'); expect(next.hasAttribute('disabled')).toBe(true); expect(classes(tool)).toContain('active');
        await type('   '); expect(count()).toBe('');
        // “alpha” 只出现在第 1、2 页的译文里；命中段落位于页内 y=70，跳转停在其上方 24px。
        await type('alpha');
        expect(count()).toBe('1 / 2'); expect(previous.hasAttribute('disabled')).toBe(false); expect(next.hasAttribute('disabled')).toBe(false);
        expect(viewport.scrollTop).toBeCloseTo(rowTop(0) + 70 * s - 24, 8); expect(state.currentPage).toBe(1);
        // 双语对照时原文页和译文层各标一处，位置与段落矩形一致（四周各留 3px）。
        expect(marks(1)).toHaveLength(2); expect(marks(1)[0].closest('.pdf-page-column:not(.translated)')).toBeTruthy(); expect(marks(1)[1].closest('.pdf-translation-layer')).toBeTruthy();
        for (const mark of marks(1)) {expect(mark.style.left).toBe(px(50 * s - 3)); expect(mark.style.top).toBe(px(70 * s - 3)); expect(mark.style.width).toBe(px(200 * s + 6)); expect(mark.style.height).toBe(px(40 * s + 6));}
        click(next); await componentFlush();
        expect(count()).toBe('2 / 2'); expect(viewport.scrollTop).toBeCloseTo(rowTop(1) + 70 * s - 24, 8); expect(state.currentPage).toBe(2); expect(marks(2)).toHaveLength(2); expect(marks(1)).toHaveLength(0);
        click(next); await componentFlush(); expect(count()).toBe('1 / 2'); expect(state.currentPage).toBe(1); expect(marks(1)).toHaveLength(2);
        click(previous); await componentFlush(); expect(count()).toBe('2 / 2'); expect(state.currentPage).toBe(2);
        expect((await enter()).preventDefault).toHaveBeenCalledOnce(); expect(count()).toBe('1 / 2'); expect(state.currentPage).toBe(1);
        expect((await enter(true)).preventDefault).toHaveBeenCalledOnce(); expect(count()).toBe('2 / 2'); expect(state.currentPage).toBe(2);
        expect(pageChanges).toEqual([1, 2, 1, 2, 1, 2]);
        // 原文同样参与匹配；换词后回到第一处。
        await type('SOURCE'); expect(count()).toBe('1 / 3'); expect(state.currentPage).toBe(1);
        await enter(true); expect(count()).toBe('3 / 3'); expect(state.currentPage).toBe(3); expect(viewport.scrollTop).toBeCloseTo(rowTop(2) + 70 * s - 24, 8); expect(marks(3)).toHaveLength(2);
        await type('source 2'); expect(count()).toBe('1 / 1'); expect(state.currentPage).toBe(2); await enter(); expect(count()).toBe('1 / 1'); expect(marks(2)).toHaveLength(2);
        // 收起面板后不再标出命中位置，工具按钮仍提示有搜索结果。
        document.dispatchEvent(Object.assign(new document.defaultView!.Event('keydown', {bubbles: true}), {key: 'Escape'})); await componentFlush();
        expect(root.querySelector('.pdf-search-panel')).toBeNull(); expect(root.querySelector('.pdf-source-highlight')).toBeNull(); expect(classes(tool)).toContain('active');
        click(tool); await componentFlush(); expect(root.querySelector('.pdf-search-count')!.textContent).toBe('1 / 1'); expect(marks(2)).toHaveLength(2);
    });

    it('scales and restyles overlay translation text from the style panel without redrawing pages, and restores the stored choice on the next mount', async () => {
        const SERIF = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, Georgia, "Times New Roman", serif'; const SANS = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';
        const s = (920 - 36) / 2 / 612; const px = (value: number) => `${Math.round(value * 100) / 100}px`; const stored = () => JSON.parse(storage.get('fluentread.pdfReader.textStyle') ?? 'null');
        const text = (root: Element) => root.querySelector('.pdf-translation-block[data-pdf-segment-index="0"] .pdf-translation-text') as HTMLElement;
        const font = (root: Element) => ({size: text(root).style.getPropertyValue('fontSize'), family: text(root).style.getPropertyValue('fontFamily')});
        const first = mountReader(model(), 'bilingual', ['第一段译文']);
        await vi.waitFor(() => expect(first.root.querySelector('[data-pdf-resource="translation"]')).toBeTruthy()); await componentFlush();
        const root = first.root; const draws = pdfPage.render.mock.calls.length;
        expect(font(root)).toEqual({size: px(12 * s), family: SANS}); expect(stored()).toBeNull(); expect(root.querySelector('.pdf-style-panel')).toBeNull();
        click(root.querySelector('.pdf-style .pdf-tool-button')); await componentFlush();
        const [smaller, larger] = Array.from(root.querySelectorAll('.pdf-style-stepper button')); const percent = () => root.querySelector('.pdf-style-stepper output')!.textContent;
        const fonts = Array.from(root.querySelectorAll('.pdf-style-fonts button')); const pressed = () => fonts.map(button => button.getAttribute('aria-pressed') === 'true' && classes(button).includes('selected'));
        expect(fonts.map(button => button.textContent)).toEqual(['document.pdfReading.styleFont.auto', 'document.pdfReading.styleFont.serif', 'document.pdfReading.styleFont.sans']);
        expect(percent()).toBe('100%'); expect(pressed()).toEqual([true, false, false]); expect(smaller.hasAttribute('disabled')).toBe(false); expect(larger.hasAttribute('disabled')).toBe(false);
        click(larger); await componentFlush();
        expect(percent()).toBe('105%'); expect(font(root).size).toBe(px(12 * s * 1.05)); expect(stored()).toEqual({scale: 1.05, font: 'auto', highlight: true});
        for (let step = 0; step < 5; step += 1) {click(larger); await componentFlush();}
        expect(percent()).toBe('130%'); expect(font(root).size).toBe(px(12 * s * 1.3)); expect(larger.hasAttribute('disabled')).toBe(true); expect(stored()).toEqual({scale: 1.3, font: 'auto', highlight: true});
        click(larger); await componentFlush(); expect(percent()).toBe('130%');
        for (let step = 0; step < 10; step += 1) {click(smaller); await componentFlush();}
        expect(percent()).toBe('80%'); expect(font(root).size).toBe(px(12 * s * 0.8)); expect(smaller.hasAttribute('disabled')).toBe(true); expect(larger.hasAttribute('disabled')).toBe(false);
        click(smaller); await componentFlush(); expect(percent()).toBe('80%'); expect(stored()).toEqual({scale: 0.8, font: 'auto', highlight: true});
        click(fonts[1]); await componentFlush(); expect(pressed()).toEqual([false, true, false]); expect(font(root)).toEqual({size: px(12 * s * 0.8), family: SERIF}); expect(stored()).toEqual({scale: 0.8, font: 'serif', highlight: true});
        click(fonts[2]); await componentFlush(); expect(pressed()).toEqual([false, false, true]); expect(font(root).family).toBe(SANS); expect(stored()).toEqual({scale: 0.8, font: 'sans', highlight: true});
        click(fonts[1]); await componentFlush();
        expect(text(root).textContent).toBe('第一段译文'); expect(pdfPage.render).toHaveBeenCalledTimes(draws);
        first.currentMode.value = 'source'; await componentFlush(); expect(root.querySelector('.pdf-style')).toBeNull(); expect(root.querySelector('.pdf-style-panel')).toBeNull();
        mountedApp.unmount(); await componentFlush();
        // 下次打开沿用保存的字号与字体；越界或无法解析的记录回到可用范围与默认值。
        const second = mountReader(model(), 'translated', ['第一段译文']);
        await vi.waitFor(() => expect(second.root.querySelector('[data-pdf-resource="translation"]')).toBeTruthy()); await componentFlush();
        const single = (920 - 24) / 612;
        expect(font(second.root)).toEqual({size: px(12 * single * 0.8), family: SERIF});
        click(second.root.querySelector('.pdf-style .pdf-tool-button')); await componentFlush();
        expect(second.root.querySelector('.pdf-style-stepper output')!.textContent).toBe('80%'); expect(Array.from(second.root.querySelectorAll('.pdf-style-fonts button')).map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
        mountedApp.unmount(); await componentFlush();
        storage.set('fluentread.pdfReader.textStyle', JSON.stringify({scale: 9, font: 'comic'}));
        const clamped = mountReader(model(), 'translated', ['第一段译文']); await componentFlush();
        expect(clamped.state.textScale).toBe(1.3); expect(clamped.state.textFont).toBe('auto'); expect(font(clamped.root)).toEqual({size: px(12 * single * 1.3), family: SANS});
        mountedApp.unmount(); await componentFlush();
        storage.set('fluentread.pdfReader.textStyle', 'not json');
        const fallback = mountReader(model(), 'translated', ['第一段译文']); await componentFlush();
        expect(fallback.state.textScale).toBe(1); expect(fallback.state.textFont).toBe('auto'); expect(font(fallback.root)).toEqual({size: px(12 * single), family: SANS}); expect(storage.get('fluentread.pdfReader.textStyle')).toBe('not json');
    });

    it('lists headings in reading order with numbering-depth indentation, switches title language with a source fallback, jumps on click and marks the current section', async () => {
        const doc = model(2);
        const sources = ['1 Introduction', '1.1 Background', 'Body paragraph', '2.3.4.5 Deep dive', 'Appendix', 'L'.repeat(141), '   '];
        const block = (segmentIndex: number, y: number, kind?: 'heading', x = 50) => ({...pageModel(1).blocks[0], segmentIndex, x, y, ...(kind ? {kind} : {})});
        doc.segments = sources.map((source, id) => ({id, source}));
        // 第 2 页是双栏：右栏的 Appendix 纵坐标更小，但阅读顺序在左栏的 Deep dive 之后；过长或空白的标题不进目录。
        if (doc.binary?.kind === 'pdf') {
            Object.assign(doc.binary.pages[0], {segmentIndexes: [0, 1, 2], blocks: [block(0, 70, 'heading'), block(1, 300, 'heading'), block(2, 400)]});
            Object.assign(doc.binary.pages[1], {segmentIndexes: [3, 4, 5, 6], blocks: [block(3, 400, 'heading'), block(4, 100, 'heading', 320), block(5, 600, 'heading'), block(6, 700, 'heading')]});
        }
        const {root, viewport, state, currentTranslations} = mountReader(doc, 'bilingual', ['1 引言', '1.1 Background', '正文', '2.3.4.5 深入', '', '', '']); await componentFlush();
        const s = (920 - 36) / 2 / 612; const secondTop = 12 + 792 * s + 12;
        const toggle = root.querySelector('.pdf-outline-toggle') as HTMLElement;
        expect(root.querySelector('.pdf-reader-outline')).toBeNull(); expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(toggle.getAttribute('aria-label')).toBe('document.pdfReading.outline');
        click(toggle); await componentFlush(); flushFrames(); await componentFlush();
        const nav = root.querySelector('nav.pdf-reader-outline#pdf-reader-outline') as HTMLElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('true'); expect(toggle.getAttribute('aria-label')).toBe('document.pdfReading.outline'); expect(classes(toggle)).toContain('active'); expect(classes(nav)).not.toContain('hosted');
        const items = () => [...nav.querySelectorAll('.pdf-outline-item')] as HTMLElement[];
        const titles = () => items().map(item => item.querySelector('span')!.textContent);
        const current = () => items().filter(item => classes(item).includes('current') && item.getAttribute('aria-current') === 'location').map(item => item.getAttribute('title'));
        const languages = Array.from(nav.querySelectorAll('.pdf-outline-language button'));
        expect(languages.map(button => button.textContent)).toEqual(['document.pdfReading.original', 'document.pdfReading.translated']);
        expect(languages.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        // 默认显示译文标题；与原文相同或尚未译出的标题先显示原文。
        expect(titles()).toEqual(['1 引言', '1.1 Background', '2.3.4.5 深入', 'Appendix']);
        expect(items().map(item => item.getAttribute('title'))).toEqual(['1 Introduction', '1.1 Background', '2.3.4.5 Deep dive', 'Appendix']);
        expect(items().map(item => item.querySelector('small')!.textContent)).toEqual(['1', '1', '2', '2']);
        expect(items().map(item => item.style.getPropertyValue('paddingLeft'))).toEqual(['12px', '26px', '40px', '12px']);
        expect(current()).toEqual(['1 Introduction']);
        click(languages[0]); await componentFlush();
        expect(titles()).toEqual(['1 Introduction', '1.1 Background', '2.3.4.5 Deep dive', 'Appendix']); expect(languages.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']); expect(classes(languages[0])).toContain('selected');
        click(languages[1]); await componentFlush(); expect(titles()).toEqual(['1 引言', '1.1 Background', '2.3.4.5 深入', 'Appendix']);
        currentTranslations.value = ['1 引言', '1.1 背景', '正文', '2.3.4.5 深入', '附录', '', '']; await componentFlush(); flushFrames(); await componentFlush();
        expect(titles()).toEqual(['1 引言', '1.1 背景', '2.3.4.5 深入', '附录']);
        // 点击跳到标题上方 24px；阅读线（顶部下方 120px）之上最靠下的标题是当前章节。
        click(items()[1]); await componentFlush();
        expect(viewport.scrollTop).toBeCloseTo(12 + 300 * s - 24, 8); expect(state.currentPage).toBe(1); expect(current()).toEqual(['1.1 Background']);
        click(items()[2]); await componentFlush();
        expect(viewport.scrollTop).toBeCloseTo(secondTop + 400 * s - 24, 8); expect(state.currentPage).toBe(2); expect(current()).toEqual(['2.3.4.5 Deep dive']);
        click(items()[3]); await componentFlush();
        expect(viewport.scrollTop).toBeCloseTo(secondTop + 100 * s - 24, 8); expect(state.currentPage).toBe(2); expect(current()).toEqual(['Appendix']);
        click(items()[0]); await componentFlush(); expect(viewport.scrollTop).toBeCloseTo(12 + 70 * s - 24, 8); expect(state.currentPage).toBe(1); expect(current()).toEqual(['1 Introduction']);
        // 滚动同样更新当前章节；第一处标题之前没有当前项。
        viewport.scrollTop = 12 + 300 * s - 100; viewport.dispatchEvent(new document.defaultView!.Event('scroll')); flushFrames(); await componentFlush(); expect(current()).toEqual(['1.1 Background']);
        click(toggle); await componentFlush(); expect(root.querySelector('.pdf-reader-outline')).toBeNull(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('falls back to one outline item per page without headings and renders the outline into a host target without its own toggle', async () => {
        const plain = mountReader(model(3)); await componentFlush();
        click(plain.root.querySelector('.pdf-outline-toggle')); await componentFlush(); flushFrames(); await componentFlush();
        const pageItems = () => [...plain.root.querySelectorAll('.pdf-reader-outline .pdf-outline-item')] as HTMLElement[];
        expect(plain.root.querySelector('.pdf-outline-language')).toBeNull();
        expect(pageItems().map(item => item.querySelector('span')!.textContent)).toEqual(['document.pdfReading.pageNumber:1', 'document.pdfReading.pageNumber:2', 'document.pdfReading.pageNumber:3']);
        expect(pageItems().map(item => item.querySelector('small')!.textContent)).toEqual(['1', '2', '3']); expect(pageItems().map(item => item.style.getPropertyValue('paddingLeft'))).toEqual(['12px', '12px', '12px']);
        expect(pageItems().map(item => item.getAttribute('aria-current'))).toEqual(['location', null, null]);
        // 原文单栏：缩放 (920 − 24) / 612；跳到第 2 页页顶上方 24px 处。
        const scale = (920 - 24) / 612; const top = 12 + 792 * scale + 12;
        click(pageItems()[1]); await componentFlush();
        expect(plain.viewport.scrollTop).toBeCloseTo(top - 24, 8); expect(plain.state.currentPage).toBe(2); expect(pageItems().map(item => item.getAttribute('aria-current'))).toEqual([null, 'location', null]);
        mountedApp.unmount(); await componentFlush();
        const host = document.createElement('aside'); document.body.append(host);
        const doc = model(2); doc.segments = [doc.segments[0], {id: 1, source: '2 Method'}];
        if (doc.binary?.kind === 'pdf') doc.binary.pages[1].blocks[0].kind = 'heading';
        const hosted = mountReader(doc, 'source', [], {outlineTarget: host}); await componentFlush(); flushFrames(); await componentFlush();
        expect(hosted.root.querySelector('.pdf-outline-toggle')).toBeNull(); expect(hosted.root.querySelector('.pdf-reader-outline')).toBeNull(); expect(hosted.state.outlineOpen).toBe(false);
        const nav = host.querySelector('nav.pdf-reader-outline') as HTMLElement;
        expect(classes(nav)).toContain('hosted'); expect(nav.querySelector('.pdf-outline-language')).toBeTruthy();
        const item = nav.querySelector('.pdf-outline-item') as HTMLElement;
        expect(nav.querySelectorAll('.pdf-outline-item')).toHaveLength(1); expect(item.querySelector('span')!.textContent).toBe('2 Method'); expect(item.querySelector('small')!.textContent).toBe('2'); expect(item.getAttribute('aria-current')).toBeNull();
        click(item); await componentFlush();
        expect(hosted.viewport.scrollTop).toBeCloseTo(top + 70 * scale - 24, 8); expect(hosted.state.currentPage).toBe(2); expect(item.getAttribute('aria-current')).toBe('location'); expect(classes(item)).toContain('current');
        mountedApp.unmount(); mountedApp = undefined; await componentFlush(); expect(host.querySelector('.pdf-reader-outline')).toBeNull();
    });
});
