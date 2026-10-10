import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {createRenderer, h, markRaw, nextTick, ref} from 'vue';
import {IDBFactory} from 'fake-indexeddb';
import {parseHTML} from 'linkedom';
import {Config} from '@/src/core/config/model';
import {parseDocument, type PdfDocumentPage} from '@/src/features/document-translation/core/document';
import * as binaryService from '@/src/features/document-translation/services/binary';
import {createDocumentHistory, documentHistoryId} from '@/src/features/document-translation/services/history';
import {acquirePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import {createDocumentDownload as createRuntimeDownload} from '@/src/app/document-translation/runtime';
import DocumentApp from '@/src/app/document-translation/DocumentApp.vue';
import DocumentSegmentEditor from '@/src/app/document-translation/DocumentSegmentEditor.vue';

const ports = vi.hoisted(() => ({tasks: [] as any[], zoomBindings: [] as any[], renderPending: undefined as any, pagePending: undefined as any, pageProvider: undefined as undefined | ((pageNumber: number, page: any) => Promise<any>), pageCount: 1, fetchPdf: vi.fn(), i18n: vi.fn(), sendMessage: vi.fn(), translate: vi.fn(), batch: vi.fn(), recognize: vi.fn(), createRecognizer: vi.fn(), actualRecognize: undefined as any, actualCreateRecognizer: undefined as any, unsubscribe: vi.fn(), observer: undefined as any, config: undefined as any}));
vi.mock('@/src/features/document-translation/services/pdfOcr', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/document-translation/services/pdfOcr')>('@/src/features/document-translation/services/pdfOcr');
    ports.actualRecognize = actual.recognizePdfDocument;
    return {...actual, recognizePdfDocument: ports.recognize};
});
vi.mock('@/src/app/document-translation/runtime', async () => {
    const actual = await vi.importActual<typeof import('@/src/app/document-translation/runtime')>('@/src/app/document-translation/runtime');
    ports.actualCreateRecognizer = actual.createPdfPageRecognizer;
    return {...actual, createPdfPageRecognizer: ports.createRecognizer};
});
vi.mock('@/src/features/document-translation/ui/documentZoom', () => ({installDocumentZoomGestures: (target: HTMLElement, options: unknown) => {
    const dispose = vi.fn(); ports.zoomBindings.push({target, options, dispose}); return dispose;
}}));
vi.mock('@/src/features/document-translation/services/pdfSource', async () => ({...await vi.importActual<typeof import('@/src/features/document-translation/services/pdfSource')>('@/src/features/document-translation/services/pdfSource'), fetchOnlinePdf: ports.fetchPdf}));
vi.mock('@/src/features/document-translation/ui/PdfReader.vue', () => ({default: {props: ['document', 'translations', 'mode', 'sourceUrl'], setup: () => () => h('div', {'data-document-reader': 'pdf'})}}));
vi.mock('@/src/app/document-translation/selectionRuntime', () => ({mountDocumentSelectionTranslation: () => ({dispose: () => {}})}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.sendMessage, getURL: (path: string) => `chrome-extension://fixture/${path}`}, tabs: {create: vi.fn()}}}));
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    const config = new Config(); ports.config = config;
    return {config, configReady: Promise.resolve(), subscribeConfig: (observer: any) => {ports.observer = observer; return ports.unsubscribe;}, requestConfigPatch: (patch: any, send: any) => send({patch})};
});
vi.mock('@/src/app/translation/client', () => ({translateText: ports.translate, translateTextBatch: ports.batch}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: (options: unknown) => options, useUiI18n: () => ({language: ref('zh-CN'), t: (key: string, values?: unknown) => {ports.i18n(key, values); return key;}, translateLegacy: (text: string) => text})}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {props: ['modelValue'], setup: (_props: any, {slots}: any) => () => h('select', slots.default?.())}}));
vi.mock('@/src/ui/components/GlossaryLibrarySelect.vue', () => ({default: {setup: () => () => h('div')}}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', () => ({ElOption: {props: ['label', 'value'], setup: (props: any) => () => h('option', {value: props.value}, props.label)}}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: (options: any) => {
    const task = {role: options.disableFontFace ? 'parse' : 'preview', destroy: vi.fn(async () => {}), page: {
        getViewport: ({scale}: {scale: number}) => ({width: 100 * scale, height: 100 * scale, transform: [1, 0, 0, 1, 0, 0]}),
        getTextContent: async () => ({items: [{str: 'Original', transform: [1, 0, 0, 12, 5, 20], width: 50, height: 12, fontName: 'body'}], styles: {}}), cleanup: vi.fn(),
        render: vi.fn(() => {const pending = ports.renderPending; return {promise: pending?.promise ?? Promise.resolve(), cancel: vi.fn(() => pending?.reject(new Error('render canceled')))};}),
    }};
    const getPage = vi.fn((pageNumber: number) => ports.pageProvider?.(pageNumber, task.page) ?? ports.pagePending?.promise ?? Promise.resolve(task.page));
    ports.tasks.push({...task, getPage});
    return {promise: Promise.resolve({numPages: ports.pageCount, getPage}), destroy: task.destroy};
}}));

type HostNode = EventTarget & {type: string; props: Record<string, any>; children: HostNode[]; parent?: HostNode; text?: string; showModal: () => void; close: () => void; style: Record<string, string>};
const node = (type: string): HostNode => Object.assign(new EventTarget(), {type, tagName: type.toUpperCase(), props: {}, children: [] as HostNode[], style: {}, showModal: vi.fn(), close: vi.fn(), getAttribute: (_name: string) => undefined});
const renderer = createRenderer<HostNode, HostNode>({
    createElement: node, createText: value => Object.assign(node('#text'), {text: value}), createComment: value => Object.assign(node('#comment'), {text: value}),
    setText: (element, text) => {element.text = text;}, setElementText: (element, text) => {element.text = text; element.children = [];},
    parentNode: element => element.parent ?? null, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert: (child, parent, anchor) => {if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, child);},
    remove: child => {if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);},
    patchProp: (element, key, _previous, value) => {element.props[key] = value;},
});
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const file = (name: string, text = 'Original') => ({name, size: text.length, text: async () => text, arrayBuffer: async () => new TextEncoder().encode('%PDF-fixture').buffer}) as File;
const flush = async () => {for (let i = 0; i < 6; i += 1) {await nextTick(); await Promise.resolve();}};
let app: any;
let state: any;
let root: HostNode;
let canvasPort: any[];
let createUrl: MockInstance<typeof URL.createObjectURL>;
let revokeUrl: MockInstance<typeof URL.revokeObjectURL>;
let win: any;
const windowTimers = new Set<ReturnType<typeof setTimeout>>();

beforeEach(async () => {
    ports.tasks = []; ports.zoomBindings = []; ports.renderPending = undefined; ports.pagePending = undefined; ports.pageProvider = undefined; ports.pageCount = 1;
    ports.fetchPdf.mockReset().mockResolvedValue(file('online.pdf')); ports.i18n.mockClear();
    ports.sendMessage.mockReset().mockResolvedValue(undefined); ports.translate.mockReset().mockResolvedValue('translated'); ports.unsubscribe.mockReset();
    ports.batch.mockReset().mockImplementation(async (sources: string[]) => sources.map(source => `译 ${source}`));
    ports.recognize.mockReset().mockImplementation(ports.actualRecognize);
    ports.createRecognizer.mockReset().mockImplementation(ports.actualCreateRecognizer);
    Object.assign(ports.config, new Config());
    win = Object.assign(new EventTarget(), {matchMedia: () => Object.assign(new EventTarget(), {matches: false}), document: {createElement: () => ({click: vi.fn()})}, location: {origin: 'chrome-extension://fixture'}, setTimeout: (callback: () => void, delay: number) => {
        const timer = setTimeout(() => {windowTimers.delete(timer); callback();}, delay); windowTimers.add(timer); return timer;
    }, clearTimeout});
    vi.stubGlobal('window', win);
    canvasPort = [];
    vi.stubGlobal('document', {createElement: () => {const canvas = {width: 0, height: 0, getContext: () => ({fillRect: vi.fn()}), toBlob: (done: any) => done(new Blob([new Uint8Array([1])]))}; canvasPort.push(canvas); return canvas;}});
    createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${createUrl.mock.calls.length}`);
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    root = node('root');
    app = renderer.createApp(DocumentApp);
    app.mount(root); state = root.children[0].parent ? (app._instance as any).setupState : undefined;
    await flush();
});
afterEach(async () => {ports.pagePending?.resolve(ports.tasks.find(value => value.role === 'preview')?.page); ports.renderPending?.resolve(); app?.unmount(); await flush(); await vi.dynamicImportSettled(); windowTimers.forEach(timer => clearTimeout(timer)); windowTimers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('documentbinaryAudit actual DocumentApp SFC ownership', () => {
    it.each(['scanned', 'mixed', 'mixed-removed-duplicate'] as const)('preserves multi-page %s PDF OCR revisions across a parsing-version upgrade and subsequent reopening', async format => {
        const base = await binaryService.parseDocumentFile(file('history.pdf'));
        if (base.binary?.kind !== 'pdf') throw new Error('expected PDF');
        const bytes = base.binary.bytes;
        const makeDocument = (native: string[]) => {
            const segments: Array<{id: number; source: string}> = [];
            const pageSources: Array<string[] | null> = format !== 'scanned' ? [native, null, null] : [null, null];
            const pages: PdfDocumentPage[] = pageSources.map((sources, index) => {
                const blocks = (sources ?? []).map((source, position) => {
                    const id = segments.length;
                    segments.push({id, source});
                    return {segmentIndex: id, x: 5, y: 10 + position * 35, width: 90, height: 12, fontSize: 11,
                        lineHeight: 12, lineCount: 1, fontFamily: 'sans-serif', fontWeight: 400 as const, textAlign: 'left' as const};
                });
                return {pageNumber: index + 1, width: 100, height: 100, blocks, segmentIndexes: blocks.map(block => block.segmentIndex),
                    ...(sources === null ? {scanned: true} : {layoutBoundaries: [{x: 5, y: 30, width: 90, height: 1}]}),
                    ...(index === pageSources.length - 1 ? {rotation: 90 as const} : {})};
            });
            return {...base, segments, binary: {kind: 'pdf' as const, bytes, pages}};
        };
        const fresh = makeDocument(['New native title', 'Stable native']);
        const oldNative = format === 'mixed-removed-duplicate' ? ['Old native title', 'Stable native', 'Repeated OCR'] : ['Old native title', 'Stable native'];
        const old = await ports.actualRecognize(makeDocument(oldNative), async ({pageNumber}: {pageNumber: number}) => [
            {text: 'Repeated OCR', x: 5, y: 10, width: 90, height: 12},
            {text: `Page ${pageNumber} paragraph`, x: 5, y: 55, width: 90, height: 12},
        ], {startPage: 1});
        let repeat = 0;
        const edits = old.segments.map(({source, id}: {source: string; id: number}) => format === 'mixed-removed-duplicate' && id === 2 ? '文字页重复原文校订不能占用扫描校订'
            : source === 'Repeated OCR' ? `第 ${++repeat} 次独立校订`
            : source === 'Old native title' ? '旧标题校订不能乱填新标题' : source === 'Stable native' ? '未变文字页校订'
                : source === `Page ${fresh.binary.pages.length} paragraph` ? '' : '扫描正文校订');
        const id = await documentHistoryId(bytes);
        const factory = new IDBFactory();
        const history = createDocumentHistory(factory);
        await history.save({id, name: 'history.pdf', format: 'pdf', size: bytes.length, total: old.segments.length,
            completed: edits.filter((value: string) => value.trim()).length, updatedAt: 1, bytes, mimeType: 'application/pdf',
            translations: edits, fingerprint: 'old-settings', parsed: old, parsedVersion: 6});
        app.unmount();
        vi.stubGlobal('indexedDB', factory);
        vi.stubGlobal('File', class extends Blob {name: string; constructor(parts: BlobPart[], name: string, options?: BlobPropertyBag) {super(parts, options); this.name = name;}});
        root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState;
        await flush();
        const parsing = deferred<typeof fresh>();
        const parse = vi.spyOn(binaryService, 'parseDocumentFile').mockReturnValueOnce(parsing.promise);
        const opening = state.openHistory({id});
        await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
        expect((await history.load(id))?.translations).toEqual(edits);
        expect((await history.load(id))?.parsedVersion).toBe(6);
        parsing.resolve(fresh); await opening; await flush();
        const expectedSources = old.segments.filter(({id}: {id: number}) => format !== 'mixed-removed-duplicate' || id !== 2)
            .map(({source}: {source: string}) => source === 'Old native title' ? 'New native title' : source);
        const expectedTranslations = edits.map((value: string, index: number) => old.segments[index].source === 'Old native title' ? '' : value)
            .filter((_value: string, index: number) => format !== 'mixed-removed-duplicate' || index !== 2);
        expect(state.parsedDocument.segments.map((segment: any) => segment.source)).toEqual(expectedSources);
        expect(state.translatedSegments).toEqual(expectedTranslations);
        expect(state.needsOcr).toBe(false);
        expect(state.parsedDocument.binary.bytes).toBe(bytes);
        expect(state.parsedDocument.binary.pages.map((page: any) => page.pageNumber)).toEqual(fresh.binary.pages.map(page => page.pageNumber));
        expect(state.parsedDocument.binary.pages.at(-1)).toMatchObject({scanned: false, sourceRotation: 90});
        if (format !== 'scanned') expect(state.parsedDocument.binary.pages[0].layoutBoundaries).toEqual(fresh.binary.pages[0].layoutBoundaries);
        for (const page of state.parsedDocument.binary.pages) {
            expect(page.blocks.filter((block: any) => block.segmentIndex >= 0).map((block: any) => block.segmentIndex)).toEqual(page.segmentIndexes);
            expect(page.segmentIndexes.every((index: number) => state.parsedDocument.segments[index].id === index)).toBe(true);
        }
        await vi.waitFor(async () => {
            const saved = await history.load(id);
            expect(saved?.parsedVersion).toBe(7);
            expect(saved?.translations).toEqual(expectedTranslations);
            expect((saved?.parsed as any).segments.map((segment: any) => segment.source)).toEqual(expectedSources);
            expect(saved?.parsed).not.toHaveProperty('segmentOrigins');
        });
        state.resetDocument(); await flush();
        await state.openHistory({id}); await flush();
        expect(state.translatedSegments).toEqual(expectedTranslations);
        expect(state.needsOcr).toBe(false);
        expect(parse).toHaveBeenCalledOnce();
        expect(ports.recognize).not.toHaveBeenCalled();
        expect(ports.createRecognizer).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
        expect(ports.batch).not.toHaveBeenCalled();
    });
    it.each(['success', 'failure', 'cancel'] as const)('releases a background PDF export worker after %s through the actual App/runtime', async outcome => {
        await state.loadFiles([file('export.pdf')]);
        state.editSegment(0, '译文需要导出'); await flush();
        const encoding = deferred<binaryService.DocumentDownload>();
        let signal: AbortSignal | undefined;
        vi.spyOn(binaryService, 'createDocumentDownload').mockImplementationOnce((_document, _translations, _mode, options) => {
            signal = options?.signal;
            signal?.addEventListener('abort', () => encoding.reject(signal!.reason), {once: true});
            return encoding.promise;
        });
        const running = state.downloadDocument();
        await vi.waitFor(() => expect(ports.tasks.filter(task => task.role === 'preview')).toHaveLength(1));
        const worker = ports.tasks.find(task => task.role === 'preview')!;
        expect(worker.destroy).not.toHaveBeenCalled();
        if (outcome === 'success') encoding.resolve({data: new Uint8Array([1]), fileName: 'export.translated.pdf', mimeType: 'application/pdf'});
        else if (outcome === 'failure') encoding.reject(new Error('encoding failed'));
        else state.cancelDownload();
        await running; await flush();
        expect(worker.destroy).toHaveBeenCalledOnce();
        expect(state.preparingDownload).toBe(false);
        if (outcome === 'success') {
            expect(createUrl).toHaveBeenCalledOnce();
            expect(state.downloadedRevision).toBe(state.editRevision);
        } else {
            expect(createUrl).not.toHaveBeenCalled();
            expect(state.downloadedRevision).toBe(0);
            expect(outcome === 'cancel' ? state.downloadProgress : state.downloadError).toBe(outcome === 'cancel' ? 'document.export.canceled' : 'encoding failed');
        }
        expect(signal?.aborted).toBe(outcome === 'cancel');
    });

    it('keeps the PDF reader worker usable when its shared export finishes, then destroys it after the reader closes', async () => {
        await state.loadFiles([file('shared.pdf')]);
        state.editSegment(0, '共享译文'); await flush();
        const reader = acquirePdfDocument(state.parsedDocument.binary.bytes);
        try {
            const pdf = await reader.promise;
            const worker = ports.tasks.find(task => task.role === 'preview')!;
            const encoding = deferred<binaryService.DocumentDownload>();
            vi.spyOn(binaryService, 'createDocumentDownload').mockReturnValueOnce(encoding.promise);
            const running = state.downloadDocument(); await flush();
            expect(ports.tasks.filter(task => task.role === 'preview')).toHaveLength(1);
            encoding.resolve({data: new Uint8Array([1]), fileName: 'shared.translated.pdf', mimeType: 'application/pdf'});
            await running; await flush();
            expect(worker.destroy).not.toHaveBeenCalled();
            expect(reader.signal.aborted).toBe(false);
            expect(await pdf.getPage(1)).toBe(worker.page);
            reader.release();
            expect(worker.destroy).toHaveBeenCalledOnce();
            expect(reader.signal.aborted).toBe(true);
        } finally {reader.release();}
    });

    it.each(['unchanged', 'custom-layout', 'custom-readable'] as const)('does not preload a browser PDF worker for %s output', async kind => {
        await state.loadFiles([file('custom.pdf')]);
        const document = state.parsedDocument;
        const translations = kind === 'unchanged' ? document.segments.map((segment: any) => segment.source) : ['独立端口译文'];
        const options: binaryService.CreateDocumentDownloadOptions = kind === 'custom-layout'
            ? {pdfPresentation: 'layout', pdfPageRasterizer: async () => new Uint8Array([1])}
            : kind === 'custom-readable' ? {pdfPresentation: 'readable', pdfReadingRasterizer: async function* () {yield {bytes: new Uint8Array([1]), width: 612, height: 792};}} : {};
        const encoding = deferred<binaryService.DocumentDownload>();
        vi.spyOn(binaryService, 'createDocumentDownload').mockReturnValueOnce(encoding.promise);
        const running = createRuntimeDownload(document, translations, 'translated', options);
        await flush();
        const workerCount = ports.tasks.filter(task => task.role === 'preview').length;
        encoding.resolve({data: new Uint8Array([1]), fileName: 'custom.translated.pdf', mimeType: 'application/pdf'});
        await running; await flush();
        expect(workerCount).toBe(0);
        expect(ports.tasks.filter(task => task.role === 'preview')).toHaveLength(0);
    });

    it('keeps the task language, service, model and document batch snapshot across delayed scanned-PDF OCR and external settings updates', async () => {
        const initial = JSON.parse(JSON.stringify(ports.config));
        Object.assign(initial, {from: 'en', to: 'zh-CN', documentService: 'openai', enableAIMultiSegment: false});
        initial.documentModel.openai = 'document-before';
        initial.token.openai = 'fixture-only-token';
        Object.assign(ports.config, initial);
        ports.observer(initial); await flush();
        await state.loadFiles([file('scanned.pdf')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: any) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned; state.documentQueue[0].document = scanned; await flush();
        expect(state.needsOcr).toBe(true);
        expect(state.documentBatchTranslation).toBe(true);
        expect(state.credentialWarning).toBeNull();
        const recognizing = deferred<any>();
        const recognizer = vi.fn();
        ports.createRecognizer.mockReturnValue(recognizer);
        ports.recognize.mockReturnValue(recognizing.promise);
        ports.sendMessage.mockClear();
        const running = state.startTranslation();
        await vi.waitFor(() => expect(ports.recognize).toHaveBeenCalledOnce());
        const fingerprint = state.taskFingerprint;
        expect(ports.createRecognizer).toHaveBeenCalledWith('en');
        expect(ports.recognize).toHaveBeenCalledWith(scanned, recognizer, expect.objectContaining({signal: expect.any(AbortSignal)}));
        expect(ports.batch).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();

        const external = JSON.parse(JSON.stringify(initial));
        Object.assign(external, {from: 'fr', to: 'de', documentService: 'google', enableAIMultiSegment: true});
        external.documentModel.openai = 'document-after';
        Object.assign(ports.config, external);
        const sharedAfterUpdate = JSON.stringify(ports.config);
        ports.observer(external); await flush();
        expect(state.config.from).toBe('fr'); expect(state.config.documentService).toBe('google');
        expect(state.translating).toBe(true);
        expect(state.taskFingerprint).toBe(fingerprint);

        const sources = ['Recognized first paragraph', 'Recognized second paragraph'];
        const recognized = {...scanned, segments: sources.map((source, id) => ({id, source})), binary: {...scanned.binary,
            pages: scanned.binary.pages.map((page: any) => ({...page, scanned: false, segmentIndexes: [0, 1]})),
        }};
        recognizing.resolve(recognized); await running; await flush();
        expect(ports.batch).toHaveBeenCalledOnce();
        expect(ports.batch).toHaveBeenCalledWith(sources, 'scanned.pdf', expect.objectContaining({
            serviceOverride: 'openai', modelOverride: 'document-before', sourceLanguage: 'en', targetLanguage: 'zh-CN', aiMultiSegment: true,
        }));
        expect(ports.translate).not.toHaveBeenCalled();
        expect(state.translationComplete).toBe(true);
        expect(state.translatedSegments).toEqual(sources.map(source => `译 ${source}`));
        expect(state.taskFingerprint).toBe(fingerprint);
        expect(state.settingsChanged).toBe(true);
        expect(state.config.documentModel.openai).toBe('document-after');
        expect(JSON.stringify(ports.config)).toBe(sharedAfterUpdate);
        expect(ports.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps rich-reader zoom through in-place translation updates and releases gestures on frame, tab and document changes', async () => {
        await state.loadFiles([file('article.txt', 'Original paragraph')]); await flush();
        const rich = parseHTML('<!doctype html><html><head></head><body><p>Original</p></body></html>').document;
        const scroller = rich.documentElement;
        Object.assign(scroller, {scrollTop: 400, scrollLeft: 0});
        Object.defineProperties(scroller, {clientWidth: {value: 800}, clientHeight: {value: 600}});
        Object.defineProperty(rich, 'scrollingElement', {value: scroller});
        rich.body.getBoundingClientRect = () => ({left: -scroller.scrollLeft, top: -scroller.scrollTop,
            width: 800 * Number(rich.body.style.getPropertyValue('zoom') || 1), height: 2000 * Number(rich.body.style.getPropertyValue('zoom') || 1)}) as DOMRect;
        vi.stubGlobal('DOMParser', class {parseFromString(html: string) {return parseHTML(html).document;}});
        state.richFrame.contentDocument = markRaw(rich); state.handleRichFrameLoad();
        expect(ports.zoomBindings).toHaveLength(1);
        const first = ports.zoomBindings[0];
        expect(first.target).toBe(scroller); expect(first.options.minScale).toBe(.5); expect(first.options.maxScale).toBe(3);
        first.options.setScale(2, {clientX: 100, clientY: 200}); await flush();
        expect(state.readerScale).toBe(2); expect(rich.body.style.getPropertyValue('zoom')).toBe('2');
        expect(scroller.scrollTop).toBeCloseTo(1000); expect(scroller.scrollLeft).toBeCloseTo(100);
        state.translatedSegments = ['新的译文']; state.settledTranslations = ['新的译文']; await flush();
        expect(rich.body.textContent).toContain('新的译文');
        expect(rich.body.style.getPropertyValue('zoom')).toBe('2'); expect(ports.zoomBindings).toHaveLength(1);
        state.handleRichFrameLoad();
        expect(first.dispose).toHaveBeenCalledOnce(); expect(ports.zoomBindings).toHaveLength(2);
        const second = ports.zoomBindings[1];
        state.readerTab = 'edit'; await flush(); expect(second.dispose).toHaveBeenCalledOnce();
        second.options.setScale(3); expect(state.readerScale).toBe(2);
        state.readerTab = 'read'; await flush(); expect(ports.zoomBindings).toHaveLength(3);
        const third = ports.zoomBindings[2];
        third.options.setScale(1.5, {clientX: 100, clientY: 200});
        const beforeResetScroll = scroller.scrollTop;
        state.resetDocument(); await flush();
        expect(third.dispose).toHaveBeenCalledOnce(); expect(state.readerScale).toBe(1);
        expect(scroller.scrollTop).toBe(beforeResetScroll);
    });

    it('offers bounded non-PDF toolbar zoom while native reading and proofreading keep separate gesture ownership', async () => {
        await state.loadFiles([file('captions.srt', '1\n00:00:01,000 --> 00:00:03,000\nOriginal caption\n')]); await flush();
        const page = parseHTML('<html><body><div class="reading-content"><div class="subtitle-table-scroll"><table data-native-zoom-content><tr><td>Caption</td></tr></table></div></div></body></html>').document;
        const domViewport = page.querySelector('.reading-content')!;
        const viewport = state.readingContent;
        Object.assign(viewport, {ownerDocument: markRaw(page), querySelector: domViewport.querySelector.bind(domViewport), contains: domViewport.contains.bind(domViewport),
            getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600})});
        state.bindReaderZoomGestures();
        const binding = ports.zoomBindings.at(-1); expect(binding.target).toBe(viewport);
        const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
        const toolbar = walk(root).find(entry => String(entry.props.class).includes('document-zoom-control'))!;
        const zoomOut = toolbar.children.find(entry => entry.props['aria-label'] === 'document.pdfReading.zoomOut')!;
        const zoomIn = toolbar.children.find(entry => entry.props['aria-label'] === 'document.pdfReading.zoomIn')!;
        const reset = toolbar.children.find(entry => entry.props['data-document-zoom'] !== undefined)!;
        zoomIn.props.onClick(); await flush(); expect(state.readerScale).toBe(1.25);
        expect(binding.dispose).toHaveBeenCalledOnce();
        expect(state.readerZoomStyle).toEqual({zoom: '1.25'});
        const beforeReset = ports.zoomBindings.at(-1);
        reset.props.onClick(); await flush(); expect(state.readerScale).toBe(1);
        expect(beforeReset.dispose).toHaveBeenCalledOnce();
        for (let index = 0; index < 10; index += 1) zoomOut.props.onClick();
        await flush(); expect(state.readerScale).toBe(.5); expect(zoomOut.props.disabled).toBe(true);
        binding.options.setScale(999); await flush(); expect(state.readerScale).toBe(3); expect(zoomIn.props.disabled).toBe(true);
        state.readerTab = 'edit'; await flush(); expect(binding.dispose).toHaveBeenCalledOnce();
        binding.options.reset(); expect(state.readerScale).toBe(3);
        state.readerTab = 'read'; await flush();
        expect(ports.zoomBindings.at(-1).target).toBe(viewport);
        app.unmount(); app = null; await flush(); expect(ports.zoomBindings.every(entry => entry.dispose.mock.calls.length === 1)).toBe(true);
    });

    it('opens a text-based formula-only PDF for source reading without provider requests or invalid progress', async () => {
        ports.pageProvider = async (_pageNumber, page) => ({...page, getTextContent: async () => ({items: [{str: 'f(x)=x', transform: [1, 0, 0, 12, 20, 50], width: 60, height: 12, fontName: 'body'}], styles: {}})});
        await state.loadFiles([file('formula-only.pdf')]); await flush();
        expect(state.parsedDocument?.fileName).toBe('formula-only.pdf');
        expect(state.parsedDocument.segments).toEqual([]);
        expect(state.effectivePreviewMode).toBe('source');
        expect(state.statusLabel).toBe('document.pdfReading.selectableSource');
        expect(state.progress).toBe(0);
        state.requestTranslation(); await state.startTranslation(); await flush();
        expect(ports.translate).not.toHaveBeenCalled();
        expect(state.translating).toBe(false);
        expect(state.errorMessage).toBe('');
    });
    it('imports the online PDF fragment on mount, retains its source metadata, and keeps translation user-triggered', async () => {
        app.unmount(); await flush();
        const source = 'https://arxiv.org/pdf/1706.03762';
        win.location.hash = '#pdf=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762';
        ports.fetchPdf.mockImplementationOnce(async (_url: string, options: any) => {options.onProgress({received: 1024, total: 2048}); return file('1706.03762.pdf');});
        root = node('fragment-root'); app = renderer.createApp(DocumentApp); app.mount(root); state = app._instance.setupState;
        await vi.waitFor(() => expect(state.documentQueue).toHaveLength(1)); await flush();
        expect(ports.fetchPdf).toHaveBeenCalledWith(source, expect.objectContaining({signal: expect.any(AbortSignal), onProgress: expect.any(Function)}));
        expect(state.onlinePdfUrl).toBe(source);
        expect(state.parsedDocument.fileName).toBe('1706.03762.pdf');
        expect(state.documentQueue[0].sourceUrl).toBe(source);
        expect(state.downloadingPdf).toBe(false); expect(state.openingFile).toBe(false); expect(state.importProgress).toBe('');
        expect(ports.i18n).toHaveBeenCalledWith('document.pdfReading.downloadProgress', {size: '0.0', percent: 50});
        expect(ports.translate).not.toHaveBeenCalled();
        expect(ports.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
    });

    it.each(['during retry', 'after retry'] as const)('keeps canceled online download ownership isolated when old completion arrives %s', async latePhase => {
        const oldDownload = deferred<File>(); const retryDownload = deferred<File>();
        ports.fetchPdf.mockReturnValueOnce(oldDownload.promise).mockReturnValueOnce(retryDownload.promise);
        state.onlinePdfUrl = 'https://example.test/old.pdf';
        const oldWork = state.openOnlinePdf(); const oldOptions = ports.fetchPdf.mock.calls[0][1];
        oldOptions.onProgress({received: 2048, total: 4096});
        expect(state.downloadingPdf).toBe(true); expect(state.queueBusy).toBe(true);
        state.cancelImport(); expect(oldOptions.signal.aborted).toBe(true); expect(state.downloadingPdf).toBe(false); expect(state.queueBusy).toBe(false);
        state.onlinePdfUrl = 'https://example.test/retry.pdf'; const retryWork = state.openOnlinePdf();
        const retryOptions = ports.fetchPdf.mock.calls[1][1]; retryOptions.onProgress({received: 4096});
        expect(state.importProgress).toBe('document.pdfReading.downloadBytes');
        oldOptions.onProgress({received: 4096, total: 4096}); expect(state.importProgress).toBe('document.pdfReading.downloadBytes');
        if (latePhase === 'during retry') {
            oldDownload.resolve(file('old.pdf')); await oldWork;
            expect(state.downloadingPdf).toBe(true); expect(state.importProgress).toBe('document.pdfReading.downloadBytes'); expect(state.documentQueue).toHaveLength(0);
        }
        retryDownload.resolve(file('retry.pdf')); await retryWork;
        expect(state.parsedDocument.fileName).toBe('retry.pdf');
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['retry.pdf']);
        expect(state.documentQueue[0].sourceUrl).toBe('https://example.test/retry.pdf');
        const parsed = state.parsedDocument; const taskCount = ports.tasks.length;
        if (latePhase === 'after retry') {oldDownload.resolve(file('old.pdf')); await oldWork;}
        expect(state.parsedDocument).toBe(parsed); expect(ports.tasks).toHaveLength(taskCount);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['retry.pdf']);
        expect(state.downloadingPdf).toBe(false); expect(state.openingFile).toBe(false); expect(state.importProgress).toBe(''); expect(state.errorMessage).toBe('');
        expect(retryOptions.signal.aborted).toBe(false);
    });

    it('cancels PDF parsing after page progress, preserves existing reviewed files, and rejects a late page after a successful retry', async () => {
        await state.loadFiles([file('reviewed.txt')]); state.editSegment(0, '保留校订');
        const reviewed = state.parsedDocument; const pagePending = deferred<any>();
        ports.pageCount = 2; ports.pageProvider = (pageNumber, page) => pageNumber === 1 ? Promise.resolve(page) : pagePending.promise;
        const work = state.loadFiles([file('pending.pdf'), file('never-started.txt')]);
        await vi.waitFor(() => expect(ports.i18n).toHaveBeenCalledWith('document.pdfReading.importPages', {completed: 1, total: 2}));
        expect(state.importProgress).toBe('document.pdfReading.importPages'); expect(state.openingFile).toBe(true);
        const oldTask = ports.tasks.at(-1); expect(oldTask.getPage).toHaveBeenLastCalledWith(2);
        state.cancelImport(); await work;
        expect(oldTask.destroy).toHaveBeenCalledOnce(); expect(state.openingFile).toBe(false); expect(state.importProgress).toBe('');
        expect(state.parsedDocument).toBe(reviewed); expect(state.translatedSegments).toEqual(['保留校订']);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['reviewed.txt']);
        ports.pageProvider = undefined; ports.pageCount = 1;
        await state.loadFiles([file('retry.pdf')]);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['reviewed.txt', 'retry.pdf']);
        const taskCount = ports.tasks.length; const cleanup = vi.fn();
        pagePending.resolve({cleanup}); await flush();
        expect(cleanup).toHaveBeenCalledOnce(); expect(ports.tasks).toHaveLength(taskCount);
        // 重试成功的 PDF 成为当前文档；先前校订过的文件连同校订留在队列里。
        expect(state.parsedDocument?.fileName).toBe('retry.pdf'); expect(state.documentQueue[0].document).toBe(reviewed); expect(state.documentQueue[0].translations).toEqual(['保留校订']);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['reviewed.txt', 'retry.pdf']);
        expect(state.errorMessage).toBe(''); expect(state.importProgress).toBe('');
    });

    it('switches documents while preserving each file and its reviewed translation', async () => {
        await state.loadFiles([file('first.pdf'), file('second.txt')]);
        state.editSegment(0, '校订译文');
        state.selectDocument(state.documentQueue[1]);
        expect(state.parsedDocument.fileName).toBe('second.txt');
        expect(state.documentQueue[0].translations[0]).toBe('校订译文');
        state.selectDocument(state.documentQueue[0]);
        expect(state.translatedSegments[0]).toBe('校订译文');
        expect(ports.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
    });

    it('cancels a pending file read, keeps completed imports and allows retry', async () => {
        await state.loadFiles([file('first.txt')]);
        const pending = deferred<ArrayBuffer>();
        const work = state.loadFiles([{...file('pending.pdf'), arrayBuffer: () => pending.promise}]);
        expect(state.openingFile).toBe(true);
        state.cancelImport();
        pending.resolve(new TextEncoder().encode('%PDF-late').buffer as ArrayBuffer);
        await work;
        expect(state.openingFile).toBe(false);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['first.txt']);
        await state.loadFiles([file('retry.pdf')]);
        expect(state.documentQueue.map((item: any) => item.name)).toEqual(['first.txt', 'retry.pdf']);
    });

    it('removes the last PDF and resets the document reader', async () => {
        await state.loadFiles([file('only.pdf')]);
        state.removeDocument(state.documentQueue[0], true);
        await flush();
        expect(state.parsedDocument).toBeNull();
        expect(state.documentQueue).toHaveLength(0);
        expect(ports.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
    });

    it('passes the import signal to actual parsing and rejects a late read after unmount', async () => {
        const pending = deferred<ArrayBuffer>();
        const input = {...file('pending.pdf'), arrayBuffer: () => pending.promise};
        const work = state.loadFiles([input]);
        expect(state.openingFile).toBe(true);
        const before = ports.tasks.length;
        app.unmount(); app = null;
        pending.resolve(new TextEncoder().encode('%PDF-late').buffer as ArrayBuffer);
        await work;
        expect(state.documentQueue).toHaveLength(0);
        expect(ports.tasks).toHaveLength(before);
        expect(state.openingFile).toBe(false);
    });

    it('ignores late config save responses and releases pending download URLs and timer on pagehide', async () => {
        await state.loadFiles([file('first.txt')]);
        const save = deferred<void>(); ports.sendMessage.mockReturnValueOnce(save.promise);
        state.config.to = 'en'; await flush();
        expect(ports.sendMessage).toHaveBeenCalledOnce();
        state.editSegment(0, '校订');
        await state.downloadDocument();
        expect(state.downloadedRevision).toBe(1);
        const url = createUrl.mock.results[0].value;
        win.dispatchEvent(new Event('pagehide'));
        expect(revokeUrl).toHaveBeenCalledWith(url);
        expect(state.pendingAction).toBeNull();
        save.reject(new Error('late save failed'));
        await flush();
        expect(state.configSaveError).toBe('');
        expect(state.documentQueue).toHaveLength(0);
    });

    it('clears canceled confirmation metadata and renders the real editor update consumer', async () => {
        await state.loadFiles([file('first.txt')]);
        state.editSegment(0, '校订');
        state.removeDocument(state.documentQueue[0]);
        expect(state.pendingAction).toBe('remove');
        await flush();
        const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
        const confirmation = walk(root).find(entry => entry.props['aria-labelledby'] === 'confirm-document-heading')!;
        confirmation.props.onClose(new Event('close'));
        expect(state.pendingAction).toBeNull();
        expect(state.pendingRemoval).toBeNull();
        state.confirmAction();
        expect(state.documentQueue).toHaveLength(1);
        state.readerTab = 'edit'; await flush();
        const textarea = walk(root).find(entry => entry.type === 'textarea')!;
        expect(textarea.props.value).toBe('校订');
        textarea.props.onInput({target: {value: 'Updated from editor'}});
        expect(state.translatedSegments).toEqual(['Updated from editor']);
        expect(state.editRevision).toBe(2);
    });
});

it('documentbinaryAudit resets editor focus identity when the document changes', async () => {
    app.unmount(); app = null;
    const current = ref(parseDocument('one.txt', 'Match\nOther'));
    const child = renderer.createApp({setup: () => () => h(DocumentSegmentEditor, {document: current.value, translations: [], disabled: false})});
    child.mount(root);
    const editor = (child._instance as any).subTree.component.setupState;
    editor.query = 'Match'; editor.editingId = 1; await flush();
    expect(editor.filteredSegments).toHaveLength(2);
    current.value = parseDocument('two.txt', 'Match\nDifferent'); await flush();
    expect(editor.editingId).toBeNull();
    expect(editor.filteredSegments).toHaveLength(1);
    child.unmount();
});

it('documentbinaryAudit keeps page config editing isolated from shared runtime config until persistence and ignores late hydration', async () => {
    const previous = ports.config.documentModel.test;
    state.config.documentModel.test = 'local edit';
    await flush();
    expect(ports.config.documentModel.test).toBe(previous);
    expect(ports.sendMessage).toHaveBeenCalled();
    const outside = {...ports.config, documentModel: {test: 'external'}};
    ports.observer(outside); await flush();
    state.config.documentModel.test = 'second local edit';
    expect(outside.documentModel.test).toBe('external');
    app.unmount(); app = null;
    const next = renderer.createApp(DocumentApp); next.mount(node('second-root'));
    const nextState = (next._instance as any).setupState;
    next.unmount(); await flush();
    expect(nextState.hydrated).toBe(false);
});

it('documentbinaryAudit selecting the active PDF preserves its task and reviewed state', async () => {
    await state.loadFiles([file('same.pdf')]);
    const parsed = state.parsedDocument;
    state.editSegment(0, '校订译文');
    state.selectDocument(state.documentQueue[0]); await flush();
    expect(state.parsedDocument).toBe(parsed);
    expect(state.translatedSegments[0]).toBe('校订译文');
    expect(ports.tasks).toHaveLength(1);
});

it('documentbinaryAudit mounts the actual page assembly with its app, document theme and i18n plugin', async () => {
    const mount = vi.fn(); const use = vi.fn();
    const onUnmount = vi.fn();
    const create = vi.fn(() => ({mount, use, onUnmount}));
    vi.doMock('vue', async () => ({...await vi.importActual<typeof import('vue')>('vue'), createApp: create}));
    const {mountDocumentTranslationApp} = await import('@/src/app/document-translation/page');
    mountDocumentTranslationApp('#document-root');
    expect(create).toHaveBeenCalledWith(DocumentApp);
    expect(use).toHaveBeenCalledWith({documentRoot: (document as any).body, documentTitleKey: 'metadata.documentTitle'});
    expect(mount).toHaveBeenCalledWith('#document-root');
    expect(onUnmount).toHaveBeenCalledWith(expect.any(Function));
    vi.doUnmock('vue');
});

// 私有候选：追加至 tests/documentAppLifecycle.test.ts；执行真实 SFC 模板事件，未在本任务运行。
it('glossary gate document settings buttons open the modal and translate back to complete 1/1', async () => {
    state.config.on = true;
    state.config.documentService = 'google';
    await state.loadFiles([file('glossary.txt', 'The agent uses FluentRead.')]);
    await flush();
    expect(state.parsedDocument.segments).toHaveLength(1);
    expect(state.credentialWarning).toBeNull();
    const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
    const text = (entry: HostNode): string => (entry.text || '') + entry.children.map(text).join('');
    const settings = walk(root).find(entry => entry.type === 'dialog' && entry.props['aria-labelledby'] === 'document-settings-heading')!;
    const open = walk(root).find(entry => entry.type === 'button' && entry.props['aria-label'] === '调整文档翻译设置')!;
    expect(settings).toBeDefined();
    expect(open).toBeDefined();
    expect(settings.showModal).not.toHaveBeenCalled();
    expect(ports.translate).not.toHaveBeenCalled();
    open.props.onClick();
    expect(settings.showModal).toHaveBeenCalledOnce();
    const start = walk(settings).find(entry => entry.type === 'button' && entry.props.class === 'translate-document-button')!;
    expect(start.props.disabled).toBe(false);
    expect(text(start)).toBe('开始翻译');
    start.props.onClick();
    expect(settings.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(state.translationComplete).toBe(true));
    await flush();
    expect(ports.translate).toHaveBeenCalledOnce();
    expect(ports.translate.mock.calls[0][0]).toBe('The agent uses FluentRead.');
    expect(state.parsedDocument.segments[0].source).toBe('The agent uses FluentRead.');
    expect(state.pendingAction).toBeNull();
    const status = walk(root).find(entry => entry.props.class === 'document-status')!;
    expect(text(status)).toMatch(/^翻译完成\s*·\s*1\s*\/\s*1$/);
    expect(walk(root).find(entry => entry.props.role === 'progressbar' && entry.props['aria-label'] === '文档翻译进度')!.props['aria-valuenow']).toBe(100);
});
