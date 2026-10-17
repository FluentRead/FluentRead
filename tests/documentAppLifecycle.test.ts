import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {readFileSync} from 'node:fs';
import JSZip from 'jszip';
import {createRenderer, h, markRaw, nextTick, ref} from 'vue';
import {IDBFactory} from 'fake-indexeddb';
import {parseHTML} from 'linkedom';
import {Config} from '@/src/core/config/model';
import {getDocumentMimeType, parseDocument, type ParsedDocument, type PdfDocumentPage} from '@/src/features/document-translation/core/document';
import * as binaryService from '@/src/features/document-translation/services/binary';
import {createDocumentHistory, documentHistoryId} from '@/src/features/document-translation/services/history';
import {acquirePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import {createDocumentDownload as createRuntimeDownload} from '@/src/app/document-translation/runtime';
import DocumentApp from '@/src/app/document-translation/DocumentApp.vue';
import {getDocumentDownloadCopy} from '@/src/app/document-translation/downloadCopy';
import DocumentSegmentEditor from '@/src/app/document-translation/DocumentSegmentEditor.vue';

const ports = vi.hoisted(() => ({privateContext: false, tasks: [] as any[], zoomBindings: [] as any[], renderPending: undefined as any, pagePending: undefined as any, pageProvider: undefined as undefined | ((pageNumber: number, page: any) => Promise<any>), pageCount: 1, fetchPdf: vi.fn(), i18n: vi.fn(), sendMessage: vi.fn(), translate: vi.fn(), batch: vi.fn(), recognize: vi.fn(), createRecognizer: vi.fn(), actualRecognize: undefined as any, actualCreateRecognizer: undefined as any, unsubscribe: vi.fn(), observer: undefined as any, config: undefined as any}));
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
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.sendMessage, getURL: (path: string) => `chrome-extension://fixture/${path}`}, tabs: {create: vi.fn()}, extension: {get inIncognitoContext() {return ports.privateContext;}}}}));
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    const config = new Config(); ports.config = config;
    return {config, configReady: Promise.resolve(), subscribeConfig: (observer: any) => {ports.observer = observer; return ports.unsubscribe;}, requestConfigPatch: (patch: any, send: any) => send({patch})};
});
vi.mock('@/src/services/translation/client', () => ({translateText: ports.translate, translateTextBatch: ports.batch}));
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
let downloadAnchors: Array<{click: ReturnType<typeof vi.fn>; href?: string; download?: string}>;
const walkHost = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walkHost)];
const hostText = (entry: HostNode): string => (entry.text || '') + entry.children.map(hostText).join('');
const windowTimers = new Set<ReturnType<typeof setTimeout>>();

beforeEach(async () => {
    ports.privateContext = false;
    ports.tasks = []; ports.zoomBindings = []; ports.renderPending = undefined; ports.pagePending = undefined; ports.pageProvider = undefined; ports.pageCount = 1;
    ports.fetchPdf.mockReset().mockResolvedValue(file('online.pdf')); ports.i18n.mockClear();
    ports.sendMessage.mockReset().mockResolvedValue(undefined); ports.translate.mockReset().mockResolvedValue('translated'); ports.unsubscribe.mockReset();
    ports.batch.mockReset().mockImplementation(async (sources: string[]) => sources.map(source => `译 ${source}`));
    ports.recognize.mockReset().mockImplementation(ports.actualRecognize);
    ports.createRecognizer.mockReset().mockImplementation(ports.actualCreateRecognizer);
    Object.assign(ports.config, new Config());
    downloadAnchors = [];
    win = Object.assign(new EventTarget(), {matchMedia: () => Object.assign(new EventTarget(), {matches: false}), document: {createElement: () => {const anchor = {click: vi.fn()}; downloadAnchors.push(anchor); return anchor;}}, location: {origin: 'chrome-extension://fixture'}, setTimeout: (callback: () => void, delay: number) => {
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
    it('reuses the reading priority identity until rich-text scroll crosses a segment or document length changes', async () => {
        await state.loadFiles([file('priority.txt', Array.from({length: 10}, (_, index) => `Paragraph ${index}`).join('\n\n'))]); await flush();
        const scroller = {scrollHeight: 1_000, scrollTop: 0};
        state.richFrame = {contentDocument: {scrollingElement: scroller}};
        const initial = state.readingPriorityKey();
        expect(initial).toMatchObject({start: 0, total: 10, pages: null});
        expect(state.readingPriorityKey()).toBe(initial);
        scroller.scrollTop = 20; expect(state.readingPriorityKey()).toBe(initial);
        scroller.scrollTop = 150;
        const moved = state.readingPriorityKey();
        expect(moved).not.toBe(initial); expect(moved.start).toBe(1);
        expect(state.prioritizeReadingPosition(state.parsedDocument.segments)[0].id).toBe(1);
        expect(state.readingPriorityKey()).toBe(moved);
        const parsed = state.parsedDocument;
        state.parsedDocument = markRaw({...parsed, segments: [...parsed.segments, {id: 10, source: 'Additional paragraph'}]});
        const expanded = state.readingPriorityKey();
        expect(expanded).not.toBe(moved); expect(expanded.total).toBe(11);
        state.richFrame = null;
    });

    it('includes PDF page selection and page-to-segment mapping in the reading priority identity', async () => {
        ports.pageCount = 3;
        await state.loadFiles([file('priority.pdf')]); await flush();
        const initial = state.readingPriorityKey();
        expect(initial.pages.count).toBe(3); expect(state.readingPriorityKey()).toBe(initial);
        state.pdfPage = 2;
        const moved = state.readingPriorityKey();
        expect(moved).not.toBe(initial); expect(moved.start).toBe(1);
        const parsed = state.parsedDocument;
        expect(state.prioritizeReadingPosition(parsed.segments)[0].id).toBe(parsed.binary.pages[1].segmentIndexes[0]);
        state.parsedDocument = markRaw({...parsed, binary: {...parsed.binary, pages: [...parsed.binary.pages].reverse()}});
        const remapped = state.readingPriorityKey();
        expect(remapped).not.toBe(moved); expect(remapped.pages).not.toBe(moved.pages);
        expect(state.readingPriorityKey()).toBe(remapped);
    });

    it('derives keyed priority from native DOCX parts, EPUB chapters, and paginated reader anchors', async () => {
        await state.loadFiles([new File([readFileSync('examples/document-translation/sample.docx')], 'priority.docx', {type: getDocumentMimeType('docx')})]); await flush();
        const body = state.readingPriorityKey();
        state.docxPartIndex = 1; await flush();
        const part = state.readingPriorityKey();
        expect(part).not.toBe(body); expect(part.start).toBe(state.currentDocxPart.paragraphSegments[0].segmentIndex);
        expect(state.readingPriorityKey()).toBe(part);
        await state.loadFiles([new File([readFileSync('examples/document-translation/sample.epub')], 'priority.epub', {type: getDocumentMimeType('epub')})]); await flush();
        const chapter = state.readingPriorityKey();
        state.epubChapterIndex = 1; await flush();
        expect(state.readingPriorityKey()).not.toBe(chapter);
        expect(state.readingPriorityKey().start).toBe(state.currentEpubChapter.segmentOffset);
        await state.loadFiles([file('priority.json', JSON.stringify(Array.from({length: 90}, (_, index) => `Visible sentence ${index}`)))]); await flush();
        const firstPage = state.readingPriorityKey();
        state.readerPage = 2;
        const secondPage = state.readingPriorityKey();
        expect(secondPage).not.toBe(firstPage); expect(secondPage.start).toBe(80);
        expect(state.prioritizeReadingPosition(state.parsedDocument.segments)[0].id).toBe(80);
        expect(state.readingPriorityKey()).toBe(secondPage);
    });

    it('independent material entry renders and saves while vocabulary and reading AI are both off', async () => {
        state.config.vocabularyBookEnabled = false; state.config.harness.enabled = false; state.config.on = true;
        await state.loadFiles([file('same-title.txt', 'Original learning paragraph')]); await flush();
        state.documentQueue[0].historyId = 'a'.repeat(32);
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials'
            ? {success: true, data: message.action === 'generation' ? 3 : {id: 'document-material'}} : undefined);
        await flush();
        const button = walkHost(root).find(entry => entry.type === 'button' && hostText(entry) === '加入学习材料');
        expect(button).toBeDefined(); expect(button!.props.disabled).toBe(false);
        await button!.props.onClick(); await flush();
        const capture = ports.sendMessage.mock.calls.find(([message]) => message.type === 'fluentReadMaterials' && message.action === 'capture')?.[0];
        expect(capture.input).toMatchObject({source: {kind: 'document', fingerprint: 'a'.repeat(32), title: 'same-title.txt'}, locator: {kind: 'document', page: 1, quote: 'Original learning paragraph'}, generation: 3});
        expect(capture.input.capturedAt).toEqual(expect.any(Number)); expect(state.documentMaterialId).toBe('document-material');
        expect(capture.input.reference).toBeUndefined();
        expect(hostText(button!)).toBe('更新学习位置'); expect(state.config.vocabularyBookEnabled).toBe(false); expect(state.config.harness.enabled).toBe(false);
    });
    it.each(['off', 'private'])('independent material entry remains restricted when global context is %s', async mode => {
        if (mode === 'private') {
            app.unmount(); ports.privateContext = true; root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState; await flush();
        } else state.config.on = false;
        await state.loadFiles([file('restricted.txt', 'Private material')]); await flush(); state.documentQueue[0].historyId = 'restricted-fingerprint'; await flush();
        expect(walkHost(root).some(entry => entry.type === 'button' && hostText(entry) === '加入学习材料')).toBe(false);
        await state.saveDocumentMaterial();
        expect(ports.sendMessage.mock.calls.some(([message]) => message.type === 'fluentReadMaterials')).toBe(false);
    });
    it('keeps missing local materials recoverable and clears the restoring shell when an old session exists', async () => {
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials' ? {success: true, data: {id: 'missing-material', kind: 'document', source: {kind: 'document', fingerprint: 'b'.repeat(32)}, locator: {kind: 'document', page: 2}}} : undefined);
        state.restoring = true; await state.restoreMaterialDocument('missing-material'); await flush();
        expect(state.restoring).toBe(false); expect(state.importError).toContain('请选择原文件');
        await state.loadFiles([file('same-title.txt', 'Different file')]); await flush();
        state.documentQueue[0].historyId = 'c'.repeat(32); await state.applyMaterialResume();
        expect(state.importError).toContain('内容指纹不一致'); expect(state.documentMaterialId).toBe('');
        state.documentQueue[0].historyId = 'b'.repeat(32); await state.applyMaterialResume(); await flush();
        expect(state.documentMaterialId).toBe('missing-material');
    });
    it('cancels pending material saves when the document changes and preserves the newly active file', async () => {
        await state.loadFiles([file('first.txt'), file('second.txt')]); await flush();
        state.documentQueue[0].historyId = 'first-file'; state.documentQueue[1].historyId = 'second-file';
        const pending = deferred<{success: boolean; data: number}>();
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials' && message.action === 'generation' ? pending.promise : undefined);
        const save = state.saveDocumentMaterial(); state.selectDocument(state.documentQueue[1]); await flush();
        pending.resolve({success: true, data: 3}); await save; await flush();
        expect(ports.sendMessage.mock.calls.some(([message]) => message.type === 'fluentReadMaterials' && message.action === 'capture')).toBe(false);
        expect(state.documentMaterialId).toBe(''); expect(state.parsedDocument.fileName).toBe('second.txt');
    });
    it('material section mapping captures and restores the second DOCX part on its second reader page', async () => {
        const zip = await JSZip.loadAsync(readFileSync('examples/document-translation/sample.docx'));
        zip.file('word/header1.xml', `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${Array.from({length: 85}, (_, index) => `<w:p><w:r><w:t>Second part unique paragraph ${index + 1}.</w:t></w:r></w:p>`).join('')}</w:hdr>`);
        const bytes = await zip.generateAsync({type: 'uint8array'});
        const fingerprint = await documentHistoryId(bytes); expect(fingerprint).toMatch(/^[a-f\d]{32}$/u);
        await state.loadFiles([new File([bytes], 'material-sections.docx', {type: getDocumentMimeType('docx')})]); await flush();
        state.documentQueue[0].historyId = fingerprint;
        expect(state.docxParts[1].path).toBe('word/header1.xml');
        state.docxPartIndex = 1; await flush(); state.readerPage = 2; await flush();
        const position = state.documentMaterialSelection();
        expect(position.locator).toMatchObject({kind: 'document', fingerprint, section: 'docx:1', page: 2, quote: 'Second part unique paragraph 81.'});
        expect(walkHost(root).find(entry => entry.props['data-fluentread-material-fingerprint'] === fingerprint)?.props['data-fluentread-material-section']).toBe('docx:1');
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials'
            ? {success: true, data: message.action === 'generation' ? 3 : {id: 'docx-section-material', kind: 'document', ...position}} : undefined);
        await state.saveDocumentMaterial();
        expect(ports.sendMessage.mock.calls.find(([message]) => message.type === 'fluentReadMaterials' && message.action === 'capture')?.[0].input.locator).toMatchObject({section: 'docx:1', page: 2, quote: 'Second part unique paragraph 81.'});
        state.docxPartIndex = 0; await flush(); expect(state.readerPage).toBe(1);
        await state.restoreMaterialDocument('docx-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.docxPartIndex).toBe(1); expect(state.currentDocxPart.path).toBe('word/header1.xml'); expect(state.readerPage).toBe(2);
        expect(state.documentMaterialSelection().locator).toMatchObject(position.locator);
        const parsed = state.parsedDocument;
        const reorderedParts = [...parsed.binary.parts]; [reorderedParts[1], reorderedParts[2]] = [reorderedParts[2], reorderedParts[1]];
        state.parsedDocument = markRaw({...parsed, binary: {...parsed.binary, parts: reorderedParts}}); await flush();
        await state.restoreMaterialDocument('docx-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.docxPartIndex).toBe(2); expect(state.currentDocxPart.path).toBe('word/header1.xml'); expect(state.readerPage).toBe(2);
        state.parsedDocument = markRaw({...parsed, segments: parsed.segments.map((segment: any, index: number) => index === 0 ? {...segment, source: position.locator.quote} : segment)}); await flush();
        await state.restoreMaterialDocument('docx-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.docxPartIndex).toBe(1); expect(state.readerPage).toBe(2); expect(state.downloadNotice).toBe('');
        // 相同文字出现在另一原生位置不影响精确引用；真正原段落变化才保留待修复定位。
        const originalIndex = parsed.binary.parts[1].paragraphSegments[80].segmentIndex;
        state.parsedDocument = markRaw({...parsed, segments: parsed.segments.map((segment: any, index: number) => index === originalIndex ? {...segment, source: 'Reparsed original differs'} : segment)}); await flush();
        await state.restoreMaterialDocument('docx-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.downloadNotice).toContain('原文位置已变化或无法唯一匹配');
    });
    it('material section mapping captures and restores the second EPUB chapter with its real segment offset', async () => {
        const bytes = new Uint8Array(readFileSync('examples/document-translation/sample.epub'));
        const fingerprint = await documentHistoryId(bytes); expect(fingerprint).toMatch(/^[a-f\d]{32}$/u);
        await state.loadFiles([new File([bytes], 'material-chapters.epub', {type: getDocumentMimeType('epub')})]); await flush();
        state.documentQueue[0].historyId = fingerprint;
        expect(state.epubChapters).toHaveLength(2);
        const second = state.epubChapters[1]; const firstQuote = state.parsedDocument.segments[state.epubChapters[0].segmentOffset].source;
        const secondQuote = state.parsedDocument.segments[second.segmentOffset].source;
        expect(second.segmentOffset).toBeGreaterThan(0); expect(secondQuote).not.toBe(firstQuote);
        state.epubChapterIndex = 1; await flush();
        const position = state.documentMaterialSelection();
        expect(position.locator).toMatchObject({kind: 'document', fingerprint, section: 'epub:1', page: 1, quote: secondQuote});
        expect(walkHost(root).find(entry => entry.props['data-fluentread-material-fingerprint'] === fingerprint)?.props['data-fluentread-material-section']).toBe('epub:1');
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials'
            ? {success: true, data: message.action === 'generation' ? 3 : {id: 'epub-section-material', kind: 'document', ...position}} : undefined);
        await state.saveDocumentMaterial();
        expect(ports.sendMessage.mock.calls.find(([message]) => message.type === 'fluentReadMaterials' && message.action === 'capture')?.[0].input.locator).toMatchObject({section: 'epub:1', page: 1, quote: secondQuote});
        state.epubChapterIndex = 0; await flush(); expect(state.currentEpubChapter.path).not.toBe(second.path);
        await state.restoreMaterialDocument('epub-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.epubChapterIndex).toBe(1); expect(state.currentEpubChapter.path).toBe(second.path); expect(state.readerPage).toBe(1);
        expect(state.documentMaterialSelection().locator).toMatchObject(position.locator);
        const parsed = state.parsedDocument;
        state.parsedDocument = markRaw({...parsed, binary: {...parsed.binary, chapters: [...parsed.binary.chapters].reverse()}}); await flush();
        await state.restoreMaterialDocument('epub-section-material'); await state.applyMaterialResume(); await flush();
        expect(state.epubChapterIndex).toBe(0); expect(state.currentEpubChapter.path).toBe(second.path); expect(state.readerPage).toBe(1);
    });
    it('material resume ownership retains pending position when activation invalidates the early apply', async () => {
        await state.loadFiles([file('first.txt'), file('second.srt', Array.from({length: 81}, (_, index) => `${index + 1}\n00:00:01,000 --> 00:00:02,000\nCaption ${index + 1}.`).join('\n\n'))]); await flush();
        state.documentQueue[0].historyId = 'd'.repeat(32); state.documentQueue[1].historyId = 'e'.repeat(32);
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials' ? {success: true, data: {id: 'resume-second', kind: 'document', source: {kind: 'document', fingerprint: 'e'.repeat(32)}, locator: {kind: 'document', page: 2}}} : undefined);
        await state.restoreMaterialDocument('resume-second');
        state.selectDocument(state.documentQueue[1]);
        // 故意在 activeDocumentId 的 pre watcher 更新代次之前调用，复现生产历史恢复中的两次 apply。
        await state.applyMaterialResume(); await flush();
        expect(state.parsedDocument.fileName).toBe('second.srt'); expect(state.readerPage).toBe(2); expect(state.documentMaterialId).toBe('resume-second');
    });
    it('material resume ownership waits for the asynchronous PDF public ref before consuming the saved page', async () => {
        ports.pageCount = 3;
        await state.loadFiles([file('async-reader.pdf')]); await flush(); state.documentQueue[0].historyId = 'f'.repeat(32);
        ports.sendMessage.mockImplementation(async (message: any) => message.type === 'fluentReadMaterials' ? {success: true, data: {id: 'async-reader-material', kind: 'document', source: {kind: 'document', fingerprint: 'f'.repeat(32)}, locator: {kind: 'document', page: 2}}} : undefined);
        // 生产公共出口 defineAsyncComponent 先挂占位节点；chunk 到达前不存在 resumePage。
        state.materialPdfReader = null;
        await state.restoreMaterialDocument('async-reader-material'); await state.applyMaterialResume(); await flush();
        expect(state.documentMaterialId).toBe(''); expect(state.pdfPage).toBe(1);
        const resumePage = vi.fn(async (page: number) => {state.pdfPage = page;});
        state.materialPdfReader = {resumePage}; await flush();
        expect(resumePage).toHaveBeenCalledOnce(); expect(resumePage).toHaveBeenCalledWith(2);
        expect(state.documentMaterialId).toBe('async-reader-material'); expect(state.pdfPage).toBe(2);
    });
    it('uses each queued task as the immediate source of truth for edits and switches', async () => {
        await state.loadFiles([file('first.txt'), file('second.txt')]); await flush();
        const first = state.documentQueue[0];
        state.editSegment(0, 'Reader correction'); await flush();
        expect(first.translations).toEqual(['Reader correction']);
        expect(first.confirmedTranslationIds).toEqual([0]);
        expect(first.revision).toBe(state.editRevision);
        expect(state.batchCompletedCount).toBe(1);
        state.documentBatchTranslation = false;
        expect(first.batchTranslation).toBe(false);
        state.selectDocument(state.documentQueue[1]); await flush();
        state.editSegment(0, 'Second correction'); await flush();
        expect(first.translations).toEqual(['Reader correction']);
        state.selectDocument(first); await flush();
        expect(state.translatedSegments).toBe(first.translations);
        expect(state.confirmedTranslationIds).toBe(first.confirmedTranslationIds);
        expect(state.documentBatchTranslation).toBe(false);
        expect(state.batchCompletedCount).toBe(2);
    });
    it('preserves unavailable ChatGPT names, direct slugs and manual translations without starting public requests', async () => {
        state.config.service = 'chatgptPlan';state.config.model.chatgptPlan = 'account-default';
        await state.loadFiles([file('account.txt', 'First paragraph\n\nSecond paragraph')]);await flush();
        expect(state.documentModelOptions).toEqual(['account-default']);expect(state.selectedDocumentModel).toBe('account-default');
        state.config.documentService = 'chatgptPlan';await flush();
        expect(state.documentModelOptions).toEqual(['account-default']);expect(state.selectedDocumentModel).toBe('account-default');
        expect(state.unavailableDocumentServiceLabel).toBe('ChatGPT 套餐');
        expect(state.followDefaultLabel).toContain('ChatGPT 套餐');
        const retainedOptions = walkHost(root).filter(entry => entry.type === 'option' && entry.props.value === 'chatgptPlan');
        expect(retainedOptions.length).toBeGreaterThan(0);
        expect(retainedOptions.every(entry => hostText(entry) === 'ChatGPT 套餐')).toBe(true);
        state.selectedDocumentModel = 'account-default';await flush();
        expect(state.config.documentModel.chatgptPlan).toBe('account-default');expect(state.config.documentCustomModel.chatgptPlan).toBeUndefined();
        state.config.documentModel.chatgptPlan = 'account-document';state.config.documentCustomModel.chatgptPlan = 'obsolete-custom-value';await flush();
        expect(state.documentModelOptions).toEqual(['account-default', 'account-document']);expect(state.selectedDocumentModel).toBe('account-document');
        state.editSegment(0, '人工保留译文');state.selectedDocumentModel = 'account-default';await flush();
        expect(state.translatedSegments[0]).toBe('人工保留译文');expect(state.config.documentModel.chatgptPlan).toBe('account-default');expect(state.config.documentCustomModel.chatgptPlan).toBeUndefined();
        await state.startTranslation();await flush();expect(state.translationComplete).toBe(false);expect(state.translatedSegments[0]).toBe('人工保留译文');
        expect(state.credentialWarning).toMatch(/ChatGPT.*尚未开放/);
        expect(ports.batch).not.toHaveBeenCalled();expect(ports.translate).not.toHaveBeenCalled();
        state.config.documentService = 'google';await flush();await state.startTranslation();await flush();
        expect(state.translationComplete).toBe(true);expect(state.translatedSegments[0]).toBe('人工保留译文');
        expect(ports.batch).toHaveBeenCalledOnce();
        expect(ports.batch).toHaveBeenCalledWith(['Second paragraph'], 'account.txt', expect.objectContaining({serviceOverride: 'google'}));
        expect(ports.translate).not.toHaveBeenCalled();
        state.config.documentService = 'chatgptPlan';await flush();
        expect(state.selectedDocumentModel).toBe('account-default');expect(state.config.documentModel.chatgptPlan).toBe('account-default');
    });
    it('exposes a service switch immediately after failure even while another request is pending', async () => {
        const paragraphs = Array.from({length: 18}, (_, index) => `Paragraph ${index}`);
        await state.loadFiles([file('failure.txt', paragraphs.join('\n\n'))]); await flush();
        const late = deferred<string[]>();
        ports.batch.mockReturnValueOnce(late.promise).mockRejectedValueOnce(Object.assign(new Error('invalid model'), {retryable: false}));
        const running = state.startTranslation();
        await vi.waitFor(() => expect(state.runState).toBe('failed')); await flush();
        expect(state.translating).toBe(true);
        expect(state.statusLabel).toBe('document.translationProgress.collectingAfterFailure');
        expect(state.errorMessage).toContain('invalid model');
        const alert = walkHost(root).find(entry => entry.props['data-testid'] === 'document-translation-recovery')!;
        const actions = walkHost(alert).filter(entry => entry.type === 'button');
        expect(hostText(actions[0])).toBe('document.translationRecovery.switchService');
        expect(actions).toHaveLength(1);
        expect(walkHost(alert).find(entry => entry.type === 'details')!.props.open).toBeUndefined();
        expect(walkHost(alert).find(entry => entry.props.class === 'recovery-message')!.text).toBe('document.translationRecovery.unavailable');
        actions[0].props.onClick(); await flush();
        expect(state.runState).toBe('paused');
        expect(ports.batch.mock.calls[0][2].signal.aborted).toBe(true);
        const settings = walkHost(root).find(entry => entry.type === 'dialog' && entry.props.class === 'document-dialog document-settings-dialog')!;
        expect(settings.showModal).toHaveBeenCalledOnce();
        state.config.documentService = 'google';
        await state.startTranslation(); await flush();
        expect(state.translationComplete).toBe(true);
        late.resolve(paragraphs.slice(0, 16).map(source => `late ${source}`));
        await running; await flush();
        expect(state.translatedSegments).toEqual(paragraphs.map(source => `译 ${source}`));
        expect(state.errorMessage).toBe('');
    });

    it('renders zero and completed progress, exposes failure recovery, and resumes with another service', async () => {
        await state.loadFiles([file('progress.txt', 'First.\n\nSecond.')]); await flush();
        const progress = () => walkHost(root).find(entry => entry.props['data-testid'] === 'document-translation-progress')!;
        expect(progress().props['aria-valuenow']).toBe(0);
        expect(progress().props['aria-valuetext']).toBe('document.translationProgress.count');
        expect(ports.i18n).toHaveBeenCalledWith('document.translationProgress.count', {completed: 0, total: 2, percent: 0});
        state.documentBatchTranslation = false;
        const pending = deferred<string>();
        ports.translate.mockImplementation((source: string) => source.startsWith('First') ? Promise.resolve('第一段') : pending.promise);
        const running = state.startTranslation();
        await vi.waitFor(() => expect(state.completedSegments).toBe(1)); await flush();
        expect(progress().props['aria-valuenow']).toBe(50);
        pending.reject(Object.assign(new Error('Model unavailable'), {retryable: false}));
        await running; await flush();
        expect(state.runState).toBe('failed');
        const alert = walkHost(root).find(entry => entry.props['data-testid'] === 'document-translation-recovery')!;
        const actions = walkHost(alert).filter(entry => entry.type === 'button');
        expect(actions.map(hostText)).toEqual(['document.translationRecovery.switchService']);
        const primaryActions = walkHost(root).find(entry => entry.props.class === 'translation-actions')!;
        const retryButtons = walkHost(primaryActions).filter(entry => entry.type === 'button' && hostText(entry) === 'document.translationRecovery.retry');
        expect(retryButtons).toHaveLength(1);
        expect(walkHost(alert).find(entry => entry.type === 'details')!.props.open).toBeUndefined();
        expect(walkHost(alert).find(entry => entry.props.class === 'recovery-error-detail')!.text).toContain('Model unavailable');
        const settings = walkHost(root).find(entry => entry.type === 'dialog' && entry.props.class === 'document-dialog document-settings-dialog')!;
        actions[0].props.onClick();
        expect(settings.showModal).toHaveBeenCalledOnce();
        state.config.documentService = 'google';
        expect(state.settingsChanged).toBe(false);
        expect(state.progress).toBe(50);
        ports.translate.mockResolvedValue('第二段');
        retryButtons[0].props.onClick();
        await vi.waitFor(() => expect(state.translationComplete).toBe(true)); await flush();
        expect(ports.translate).toHaveBeenCalledTimes(3);
        expect(ports.translate.mock.calls[2][0]).toBe('Second.');
        expect(state.translatedSegments).toEqual(['第一段', '第二段']);
        expect(progress().props['aria-valuenow']).toBe(100);
    });

    it('preserves glossary and AI context for combinations and invalidates saved document settings after member edits', async () => {
        const service = 'composite:document';
        Object.assign(state.config, {from: 'en', to: 'zh-Hans', documentService: service, enableAIContext: true,
            compositeTranslationProviders: [{id: service, name: 'Document combination', strategy: 'sequential', services: ['openai', 'google'], timeoutMs: 12000}]});
        state.config.model.openai = 'gpt-4.1-mini';
        state.config.customModel.openai = '';
        state.config.token.openai = 'fixture-document-composite';
        await state.loadFiles([file('combined.txt', 'The first paragraph explains translation.\n\nThe next paragraph explains caching.')]);
        await flush();
        expect(state.documentSupportsGlossary).toBe(true);
        expect(state.credentialWarning).toBeNull();
        ports.translate.mockImplementation(async (source: string) => `译 ${source}`);
        await state.startTranslation(); await flush();
        expect(ports.translate).toHaveBeenCalledTimes(2);
        expect(ports.batch).not.toHaveBeenCalled();
        for (const [, , options] of ports.translate.mock.calls) {
            expect(options).toMatchObject({serviceOverride: service, enableAIContext: true});
            expect(options.modelOverride).toBeFalsy();
        }
        expect(state.settingsChanged).toBe(false);
        const translatedFingerprint = state.taskFingerprint;
        state.config.compositeTranslationProviders[0].strategy = 'smart'; await flush();
        expect(state.settingsChanged).toBe(true);
        expect(state.translationActionLabel).toBe('按新设置翻译');
        state.config.compositeTranslationProviders[0].strategy = 'sequential'; await flush();
        expect(state.currentFingerprint).toBe(translatedFingerprint);
        state.config.token.openai = 'changed-member-credential'; await flush();
        expect(state.settingsChanged).toBe(true);
    });
    it.each([
        ['google', 'composite:first'], ['composite:first', 'google'], ['composite:first', 'composite:second'],
    ])('resumes unfinished segments from %s to %s without discarding manual revisions', async (before, after) => {
        Object.assign(state.config, {documentService: before, enableAIContext: false,
            compositeTranslationProviders: [
                {id: 'composite:first', name: 'First combination', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000},
                {id: 'composite:second', name: 'Second combination', strategy: 'smart', services: ['microsoft', 'google'], timeoutMs: 15000},
            ]});
        await state.loadFiles([file('combined-resume.txt', 'First.\n\nSecond.')]); await flush();
        state.documentBatchTranslation = false;
        state.editSegment(0, '保留人工校订');
        ports.translate.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), {retryable: false}));
        await state.startTranslation(); await flush();
        expect(state.runState).toBe('failed'); expect(state.progress).toBe(50);
        state.config.documentService = after; await flush();
        expect(state.settingsChanged).toBe(false);
        expect(state.translatedSegments[0]).toBe('保留人工校订');
        expect(state.translatedSegments[1] || '').toBe('');
        ports.translate.mockResolvedValue('第二段');
        state.requestTranslation();
        await vi.waitFor(() => expect(state.translationComplete).toBe(true)); await flush();
        expect(state.translatedSegments).toEqual(['保留人工校订', '第二段']);
        expect(state.confirmedTranslationIds).toEqual([0]);
        expect(ports.translate.mock.calls.map(([source]) => source)).toEqual(['Second.', 'Second.']);
        expect(ports.translate.mock.calls[1][2].serviceOverride).toBe(after);
        expect(state.progress).toBe(100);
        state.config.to = 'fr'; await flush();
        expect(state.settingsChanged).toBe(true);
    });

    it('keeps the exact original download copy localized and reacts to the shared language selection', async () => {
        for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
            const copy = getDocumentDownloadCopy(language);
            expect(Object.keys(copy)).toEqual(Object.keys(getDocumentDownloadCopy('zh-CN')));
            expect(Object.values(copy).every(value => value.trim())).toBe(true);
        }
        expect(getDocumentDownloadCopy('unsupported-language')).toBe(getDocumentDownloadCopy('zh-CN'));
        expect(getDocumentDownloadCopy(undefined)).toBe(getDocumentDownloadCopy('zh-CN'));
        await state.loadFiles([new File(['Original'], 'article.txt')]);
        state.openDownload(); await flush();
        expect(hostText(root)).toContain('下载原文');
        state.language = 'en-US'; await flush();
        expect(hostText(root)).toContain('Download original');
        expect(hostText(root)).toContain('Keeps the original file without translation or edits.');
    });
    it.each(['pdf', 'epub', 'docx', 'html', 'md', 'txt', 'json', 'srt', 'vtt', 'ass', 'ssa', 'lrc'])('downloads the exact original %s file before translation without another read or export', async extension => {
        const bytes = readFileSync(`examples/document-translation/sample.${extension}`);
        const name = `sample.${extension}`;
        const input = new File([bytes], name, {type: getDocumentMimeType(extension === 'md' ? 'markdown' : extension as any)});
        const read = vi.spyOn(input, 'arrayBuffer');
        const encode = vi.spyOn(binaryService, 'createDocumentDownload');
        await state.loadFiles([input]); await flush();
        const initialReads = read.mock.calls.length;
        expect(state.hasTranslation).toBe(false);
        expect(state.documentQueue[0].bytes).toBeUndefined();
        expect(state.originalDownloadSource.blob).toBe(input);
        const open = walkHost(root).find(entry => entry.props.class === 'download-button')!;
        expect(open.props.disabled).toBe(false);
        open.props.onClick(); await flush();
        const dialog = walkHost(root).find(entry => entry.props['aria-labelledby'] === 'download-document-heading')!;
        const original = walkHost(dialog).find(entry => entry.type === 'button' && hostText(entry) === '下载原文')!;
        expect(dialog.showModal).toHaveBeenCalledOnce();
        expect(original.props.disabled).toBe(false);
        expect(walkHost(dialog).some(entry => entry.props.class === 'partial-export')).toBe(false);
        original.props.onClick();
        expect(createUrl).toHaveBeenCalledWith(input);
        expect(read).toHaveBeenCalledTimes(initialReads);
        expect(new Uint8Array(await (createUrl.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(new Uint8Array(bytes));
        expect(downloadAnchors[0].download).toBe(name);
        expect(downloadAnchors[0].click).toHaveBeenCalledOnce();
        expect(encode).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
        expect(ports.batch).not.toHaveBeenCalled();
        expect(state.downloadedRevision).toBe(0);
        expect(state.partialExportAcknowledged).toBe(false);
    });

    it('saves an online PDF from the loaded response without refetching its URL or changing edits', async () => {
        const input = new File(['%PDF-exact-original\r\n'], '论文 原稿.pdf', {type: 'application/pdf'});
        ports.fetchPdf.mockResolvedValueOnce(input);
        const read = vi.spyOn(input, 'arrayBuffer');
        state.onlinePdfUrl = 'https://example.org/original.pdf?download=1';
        await state.openOnlinePdf();
        state.editSegment(0, '保留校订');
        state.partialExportAcknowledged = true;
        const initialReads = read.mock.calls.length;
        state.downloadOriginalDocument();
        expect(ports.fetchPdf).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledTimes(initialReads);
        expect(createUrl).toHaveBeenCalledWith(input);
        expect(downloadAnchors[0].download).toBe('论文 原稿.pdf');
        expect(state.translatedSegments).toEqual(['保留校订']);
        expect(state.downloadedRevision).toBe(0);
        expect(state.editRevision).toBe(1);
        expect(state.partialExportAcknowledged).toBe(true);
    });

    it.each(['text/plain', ''])('downloads stored original bytes after reopening history with MIME %j', async mimeType => {
        const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Original\r\n')]);
        const parsed = parseDocument('history.txt', 'Original\n');
        const id = await documentHistoryId(bytes);
        const factory = new IDBFactory();
        const history = createDocumentHistory(factory);
        await history.save({id, name: 'history.txt', format: parsed.format, size: bytes.length, total: parsed.segments.length,
            completed: 0, updatedAt: 1, bytes, mimeType, translations: [], fingerprint: '', parsed, parsedVersion: 17});
        app.unmount();
        vi.stubGlobal('indexedDB', factory);
        root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState;
        await flush(); await state.openHistory({id});
        expect(state.documentQueue[0].originalFile).toBeUndefined();
        state.downloadOriginalDocument();
        const saved = createUrl.mock.calls[0][0] as Blob;
        expect(new Uint8Array(await saved.arrayBuffer())).toEqual(bytes);
        expect(saved.type).toBe(mimeType || 'text/plain;charset=utf-8');
        expect(downloadAnchors[0].download).toBe('history.txt');
        expect(state.downloadedRevision).toBe(0);
    });

    it('saves the original during translation and PDF export without interrupting either task', async () => {
        const input = new File(['%PDF-original'], 'original.pdf', {type: 'application/pdf'});
        await state.loadFiles([input]);
        state.translating = true;
        state.openDownload(); await flush();
        expect(state.downloadOpen).toBe(true);
        state.downloadOriginalDocument();
        expect(state.translating).toBe(true);
        state.translating = false;
        state.editSegment(0, '译文校订');
        state.downloadOpen = false;
        state.partialExportAcknowledged = true;
        const encoding = deferred<binaryService.DocumentDownload>();
        const encode = vi.spyOn(binaryService, 'createDocumentDownload').mockReturnValueOnce(encoding.promise);
        const exporting = state.downloadDocument(); await flush();
        await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());
        const options = encode.mock.calls[0][3]!;
        options.onPdfProgress?.({phase: 'rendering', completedPages: 1, totalPages: 2});
        const progress = state.downloadProgress;
        state.previewMode = 'translated';
        state.openDownload(); await flush();
        state.downloadOriginalDocument();
        expect(state.preparingDownload).toBe(true);
        expect(options.signal?.aborted).toBe(false);
        expect(state.outputMode).toBe('bilingual');
        expect(state.partialExportAcknowledged).toBe(true);
        expect(state.downloadProgress).toBe(progress);
        expect(state.downloadPdfProgress).toEqual({phase: 'rendering', completedPages: 1, totalPages: 2});
        expect(state.downloadedRevision).toBe(0);
        expect(encode).toHaveBeenCalledOnce();
        expect(downloadAnchors.map(anchor => anchor.download)).toEqual(['original.pdf', 'original.pdf']);
        encoding.resolve({data: new Uint8Array([1]), fileName: 'original.bilingual.pdf', mimeType: 'application/pdf'});
        await exporting;
        expect(state.downloadedRevision).toBe(1);
        expect(downloadAnchors.at(-1)?.download).toBe('original.bilingual.pdf');
    });

    it('keeps failed original downloads separate from translation export and releases their URLs on replacement', async () => {
        state.downloadOriginalDocument();
        expect(createUrl).not.toHaveBeenCalled();
        const input = new File(['Original\r\n'], 'first.txt', {type: 'text/plain'});
        await state.loadFiles([input]);
        state.editSegment(0, '校订保留');
        state.downloadError = 'translation export error';
        win.document.createElement = () => ({click: () => {throw new Error('original save failed');}});
        state.downloadOriginalDocument();
        expect(state.originalDownloadError).toBe('original save failed');
        expect(state.downloadError).toBe('translation export error');
        expect(state.downloadedRevision).toBe(0);
        expect(revokeUrl).toHaveBeenCalledWith('blob:fixture-1');
        win.document.createElement = () => ({click: vi.fn()});
        state.downloadOriginalDocument();
        const url = createUrl.mock.results[1].value;
        state.resetDocument();
        expect(revokeUrl).toHaveBeenCalledWith(url);
        expect(state.originalDownloadSource).toBeNull();
        expect(state.originalDownloadError).toBe('');
        expect(state.originalDownloadNotice).toBe('');
        const replacement = new File(['Replacement'], 'second.txt');
        await state.loadFiles([replacement]);
        state.downloadOriginalDocument();
        expect(createUrl).toHaveBeenLastCalledWith(replacement);
    });

    it.each(['scanned', 'mixed', 'mixed-removed-duplicate', 'mixed-formula-labels', 'mixed-diagram-labels'] as const)('preserves multi-page %s PDF OCR revisions across a parsing-version upgrade and subsequent reopening', async format => {
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
                    const run = {text: source, x: 5, y: 10 + position * 35, width: 90, height: 12};
                    return {segmentIndex: id, x: run.x, y: run.y, width: run.width, height: run.height, fontSize: 11,
                        lineHeight: 12, lineCount: 1, fontFamily: 'sans-serif', fontWeight: 400 as const, textAlign: 'left' as const,
                        lines: [{...run, runs: [{...run}]}]};
                });
                return {pageNumber: index + 1, width: 100, height: 100, blocks, segmentIndexes: blocks.map(block => block.segmentIndex),
                    ...(sources === null ? {scanned: true} : {layoutBoundaries: [{x: 5, y: 30, width: 90, height: 1}]}),
                    ...(index === pageSources.length - 1 ? {rotation: 90 as const} : {})};
            });
            return {...base, segments, binary: {kind: 'pdf' as const, bytes, pages}};
        };
        const fresh = makeDocument(format === 'mixed' ? ['Stable native', 'New native title'] : ['New native title', 'Stable native']);
        const oldNative = format === 'mixed-removed-duplicate' ? ['Old native title', 'Stable native', 'Repeated OCR']
            : format === 'mixed-formula-labels' ? ['Old native title', 'trackΓ', 'Stable native']
            : format === 'mixed-diagram-labels' ? ['Old native title', 'track', 'Stable native'] : ['Old native title', 'Stable native'];
        const old = await ports.actualRecognize(makeDocument(oldNative), async ({pageNumber}: {pageNumber: number}) => [
            {text: 'Repeated OCR', x: 5, y: 10, width: 90, height: 12},
            {text: `Page ${pageNumber} paragraph`, x: 5, y: 55, width: 90, height: 12},
        ], {startPage: 1});
        if (format === 'mixed') {
            // Version 12 native snapshots predate complete font descent bounds. They must be reparsed,
            // while recognized scanned pages and exact-source revisions remain recoverable.
            for (const block of old.binary.pages[0].blocks) {
                block.lines = block.lines?.map((line: any) => ({...line, height: 1, runs: line.runs?.map((run: any) => ({...run, height: 1}))}));
            }
        }
        let repeat = 0;
        const edits = old.segments.map(({source, id}: {source: string; id: number}) => format === 'mixed-removed-duplicate' && id === 2 ? '文字页重复原文校订不能占用扫描校订'
            : source === 'trackΓ' || source === 'track' ? '旧公式误译不能回填为正文'
            : source === 'Repeated OCR' ? `第 ${++repeat} 次独立校订`
            : source === 'Old native title' ? '旧标题校订不能乱填新标题' : source === 'Stable native' ? '未变文字页校订'
                : source === `Page ${fresh.binary.pages.length} paragraph` ? '' : '扫描正文校订');
        const id = await documentHistoryId(bytes);
        const factory = new IDBFactory();
        const history = createDocumentHistory(factory);
        const oldVersion = format === 'scanned' ? 10 : format === 'mixed-removed-duplicate' ? 7 : format === 'mixed-formula-labels' ? 13 : format === 'mixed-diagram-labels' ? 14 : 12;
        await history.save({id, name: 'history.pdf', format: 'pdf', size: bytes.length, total: old.segments.length,
            completed: edits.filter((value: string) => value.trim()).length, updatedAt: 1, bytes, mimeType: 'application/pdf',
            translations: edits, fingerprint: 'old-settings', parsed: old, parsedVersion: oldVersion});
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
        expect((await history.load(id))?.parsedVersion).toBe(oldVersion);
        parsing.resolve(fresh); await opening; await flush();
        const oldScannedOffset = format === 'scanned' ? 0 : oldNative.length;
        const expectedSources = [...fresh.segments.map((segment: any) => segment.source),
            ...old.segments.slice(oldScannedOffset).map((segment: any) => segment.source)];
        const expectedTranslations = [...fresh.segments.map((segment: any) => segment.source === 'Stable native' ? '未变文字页校订' : ''),
            ...edits.slice(oldScannedOffset)];
        expect(state.parsedDocument.segments.map((segment: any) => segment.source)).toEqual(expectedSources);
        expect(state.translatedSegments).toEqual(expectedTranslations);
        expect(state.needsOcr).toBe(false);
        expect(state.parsedDocument.binary.bytes).toBe(bytes);
        expect(state.parsedDocument.binary.pages.map((page: any) => page.pageNumber)).toEqual(fresh.binary.pages.map(page => page.pageNumber));
        expect(state.parsedDocument.binary.pages.at(-1)).toMatchObject({scanned: false, sourceRotation: 90});
        if (format !== 'scanned') {
            expect(state.parsedDocument.binary.pages[0].layoutBoundaries).toEqual(fresh.binary.pages[0].layoutBoundaries);
            expect(state.parsedDocument.binary.pages[0].blocks.map((block: any) => block.lines)).toEqual(fresh.binary.pages[0].blocks.map(block => block.lines));
        }
        if (format === 'mixed') {
            expect(state.parsedDocument.binary.pages[0].blocks[0].lines[0].runs[0].width).toBe(90);
            expect(state.parsedDocument.binary.pages[0].blocks[0].lines[0].runs[0].height).toBeGreaterThan(1);
            expect(old.binary.pages[0].blocks[0].lines[0].runs[0].height).toBe(1);
        }
        for (const page of state.parsedDocument.binary.pages) {
            expect(page.blocks.filter((block: any) => block.segmentIndex >= 0).map((block: any) => block.segmentIndex)).toEqual(page.segmentIndexes);
            expect(page.segmentIndexes.every((index: number) => state.parsedDocument.segments[index].id === index)).toBe(true);
        }
        await vi.waitFor(async () => {
            const saved = await history.load(id);
            expect(saved?.parsedVersion).toBe(17);
            expect(saved?.translations).toEqual(expectedTranslations);
            expect((saved?.parsed as any).segments.map((segment: any) => segment.source)).toEqual(expectedSources);
            expect(saved?.parsed).not.toHaveProperty('segmentOrigins');
        });
        state.resetDocument(); await flush();
        await state.openHistory({id}); await flush();
        expect(state.translatedSegments).toEqual(expectedTranslations);
        expect(state.needsOcr).toBe(false);
        if (format !== 'scanned') expect(state.parsedDocument.binary.pages[0].blocks.map((block: any) => block.lines)).toEqual(fresh.binary.pages[0].blocks.map(block => block.lines));
        expect(parse).toHaveBeenCalledOnce();
        expect(ports.recognize).not.toHaveBeenCalled();
        expect(ports.createRecognizer).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
        expect(ports.batch).not.toHaveBeenCalled();
    });

    it('reparses version 15 native PDF glyph bounds while preserving revisions and progress, then reuses the refreshed snapshot', async () => {
        ports.pageProvider = async (_pageNumber, page) => ({...page, getTextContent: async () => ({
            items: [
                {str: 'A full native paragraph with text.', transform: [12, 0, 0, 12, 5, 20], width: 80, height: 12, fontName: 'body'},
                {str: 'Another full native paragraph follows here.', transform: [12, 0, 0, 12, 5, 60], width: 80, height: 12, fontName: 'body'},
            ], styles: {body: {ascent: 0, descent: 0, fontFamily: 'serif'}},
        })});
        const fresh = await binaryService.parseDocumentFile(file('native-metrics.pdf'));
        if (fresh.binary?.kind !== 'pdf') throw new Error('expected PDF');
        expect(fresh.segments).toHaveLength(2);
        const old = structuredClone(fresh);
        if (old.binary?.kind !== 'pdf') throw new Error('expected PDF');
        // 旧解析把 0/0 字体的顶边直接放在基线上；缓存旧几何会让新版遮罩仍漏出原文。
        for (const block of old.binary.pages[0].blocks) {
            block.y += 9.6;
            block.lines = block.lines?.map(line => ({...line, y: line.y + 9.6,
                runs: line.runs?.map(run => ({...run, y: run.y + 9.6})),
            }));
        }
        const bytes = fresh.binary.bytes, id = await documentHistoryId(bytes);
        const translations = ['保留第一段人工校订', ''];
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        await history.save({id, name: 'native-metrics.pdf', format: 'pdf', size: bytes.length, total: 2, completed: 1,
            updatedAt: 1, bytes, mimeType: 'application/pdf', translations, fingerprint: '', parsed: old, parsedVersion: 15});
        app.unmount();
        vi.stubGlobal('indexedDB', factory);
        vi.stubGlobal('File', class extends Blob {name: string; constructor(parts: BlobPart[], name: string, options?: BlobPropertyBag) {super(parts, options); this.name = name;}});
        root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState;
        await flush();
        const parsing = deferred<typeof fresh>();
        const parse = vi.spyOn(binaryService, 'parseDocumentFile').mockReturnValueOnce(parsing.promise);
        const opening = state.openHistory({id});
        await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
        expect(parse.mock.calls[0][0].name).toBe('native-metrics.pdf');
        expect(new Uint8Array(await parse.mock.calls[0][0].arrayBuffer())).toEqual(bytes);
        expect((await history.load(id))?.parsedVersion).toBe(15);
        expect((await history.load(id))?.translations).toEqual(translations);
        parsing.resolve(fresh); await opening; await flush();
        expect(state.translatedSegments).toEqual(translations);
        expect(state.completedSegments).toBe(1); expect(state.progress).toBe(50);
        expect(state.parsedDocument.binary.pages[0].blocks).toEqual(fresh.binary.pages[0].blocks);
        expect(state.parsedDocument.binary.pages[0].blocks[0].lines[0].runs[0].y)
            .toBeLessThan(old.binary.pages[0].blocks[0].lines![0].runs![0].y);
        await vi.waitFor(async () => {
            const saved = await history.load(id);
            expect(saved?.parsedVersion).toBe(17);
            expect(saved?.completed).toBe(1); expect(saved?.total).toBe(2);
            expect(saved?.translations).toEqual(translations);
            expect((saved?.parsed as typeof fresh).binary).toEqual(fresh.binary);
        });
        state.resetDocument(); await flush();
        await state.openHistory({id}); await flush();
        expect(parse).toHaveBeenCalledOnce();
        expect(state.translatedSegments).toEqual(translations);
        expect(state.completedSegments).toBe(1); expect(state.progress).toBe(50);
        expect(state.parsedDocument.binary.pages[0].blocks).toEqual(fresh.binary.pages[0].blocks);
        expect(ports.recognize).not.toHaveBeenCalled(); expect(ports.createRecognizer).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled(); expect(ports.batch).not.toHaveBeenCalled();
    });

    it('retains an old condition revision after native PDF reparsing, persists it separately and keeps it recoverable on reopening', async () => {
        const fresh = await binaryService.parseDocumentFile(file('protected-condition.pdf'));
        if (fresh.binary?.kind !== 'pdf') throw new Error('expected PDF');
        const old = {...structuredClone(fresh), segments: [...fresh.segments, {id: 1, source: 'otherwise.', contextLabel: '第 16 页'}]};
        if (old.binary?.kind !== 'pdf') throw new Error('expected PDF');
        old.binary.pages[0].segmentIndexes.push(1);
        old.binary.pages[0].blocks.push({...old.binary.pages[0].blocks[0], segmentIndex: 1, y: 60});
        fresh.binary.pages[0].blocks.push({...fresh.binary.pages[0].blocks[0], segmentIndex: -1, y: 60, kind: 'formula', preserveSource: true});
        const bytes = fresh.binary.bytes, id = await documentHistoryId(bytes);
        const previousRetained = {source: 'Earlier removed wording', translation: '先前保留的校订', contextLabel: '第 15 页'};
        const conditionRetained = {source: 'otherwise.', translation: '用户已校订：否则保留此前结果。', contextLabel: '第 16 页'};
        const factory = new IDBFactory(), history = createDocumentHistory(factory);
        await history.save({id, name: 'protected-condition.pdf', format: 'pdf', size: bytes.length, total: 2, completed: 2,
            updatedAt: 1, bytes, mimeType: 'application/pdf', translations: ['保留正文校订', conditionRetained.translation],
            retainedRevisions: [previousRetained], fingerprint: '', parsed: old, parsedVersion: 15});
        app.unmount();
        vi.stubGlobal('indexedDB', factory);
        vi.stubGlobal('File', class extends Blob {name: string; constructor(parts: BlobPart[], name: string, options?: BlobPropertyBag) {super(parts, options); this.name = name;}});
        root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState;
        await flush();
        const parse = vi.spyOn(binaryService, 'parseDocumentFile').mockResolvedValueOnce(fresh);
        await state.openHistory({id}); await flush();
        expect(parse).toHaveBeenCalledOnce();
        expect(state.parsedDocument.segments).toHaveLength(1);
        expect(state.translatedSegments).toEqual(['保留正文校订']);
        expect(state.completedSegments).toBe(1); expect(state.progress).toBe(100);
        expect(state.documentQueue[0].retainedRevisions).toEqual([previousRetained, conditionRetained]);
        const retained = walkHost(root).find(entry => entry.type === 'details' && entry.props.class === 'editor-retained')!;
        expect(retained).toBeDefined(); expect(retained.props.open).toBe(false);
        expect(hostText(retained)).toContain('document.retainedRevisions.title');
        expect(hostText(retained)).not.toContain(conditionRetained.translation);
        await vi.waitFor(async () => {
            const saved = await history.load(id);
            expect(saved?.parsedVersion).toBe(17);
            expect(saved?.translations).toEqual(['保留正文校订']);
            expect(saved?.retainedRevisions).toEqual([previousRetained, conditionRetained]);
            expect(saved?.completed).toBe(1); expect(saved?.total).toBe(1);
        });
        state.resetDocument(); await flush();
        await state.openHistory({id}); await flush();
        expect(parse).toHaveBeenCalledOnce();
        expect(state.documentQueue[0].retainedRevisions).toEqual([previousRetained, conditionRetained]);
        expect(state.translatedSegments).toEqual(['保留正文校订']);
        expect(state.completedSegments).toBe(1); expect(state.progress).toBe(100);
        expect(ports.recognize).not.toHaveBeenCalled(); expect(ports.translate).not.toHaveBeenCalled(); expect(ports.batch).not.toHaveBeenCalled();
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

    it.each(['unchanged', 'custom-layout', 'custom-readable', 'custom-text-readable'] as const)('does not preload a browser PDF worker for %s output', async kind => {
        await state.loadFiles([file('custom.pdf')]);
        const document = state.parsedDocument;
        const translations = kind === 'unchanged' ? document.segments.map((segment: any) => segment.source) : ['独立端口译文'];
        const options: binaryService.CreateDocumentDownloadOptions = kind === 'custom-layout'
            ? {pdfPresentation: 'layout', pdfPageRasterizer: async () => new Uint8Array([1])}
            : kind === 'custom-readable' ? {pdfPresentation: 'readable', pdfReadingRasterizer: async function* () {yield {bytes: new Uint8Array([1]), width: 612, height: 792};}}
                : kind === 'custom-text-readable' ? {pdfPresentation: 'readable', pdfReadingRenderer: async function* () {yield {items: [], width: 612, height: 792};}} : {};
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

    it.each(['layout', 'readable'] as const)('downloads the selected %s PDF presentation with matching dialog guidance', async presentation => {
        await state.loadFiles([file('presentation.pdf')]);
        state.editSegment(0, '可复制的实际校订文字');
        if (presentation === 'readable') state.pdfPresentation = presentation;
        state.openDownload(); await flush();
        const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
        const text = (entry: HostNode): string => (entry.text || '') + entry.children.map(text).join('');
        const dialog = walk(root).find(entry => entry.type === 'dialog' && entry.props['aria-labelledby'] === 'download-document-heading')!;
        const summary = walk(dialog).find(entry => entry.props.class === 'pdf-export-summary')!;
        expect(summary.props['data-pdf-export-presentation']).toBe(presentation);
        expect(text(dialog)).toContain(presentation === 'readable' ? 'document.pdfReading.exportReadableHint' : 'document.pdfReading.exportHint');
        if (presentation === 'readable') {
            expect(text(dialog)).toContain('document.pdfReading.exportReadableBilingualHint');
            expect(text(summary)).toContain('document.pdfReading.exportReadablePageHint');
            expect(text(dialog)).not.toContain('document.pdfReading.exportPageCount');
            expect(text(dialog)).not.toContain('document.pdfReading.exportHint');
            expect(walk(summary).some(entry => String(entry.props.class).includes('pdf-export-page-pair'))).toBe(false);
        } else expect(text(summary)).toContain('document.pdfReading.exportPageCount');
        const download = vi.spyOn(binaryService, 'createDocumentDownload').mockResolvedValueOnce({data: new Uint8Array([1]), fileName: 'presentation.pdf', mimeType: 'application/pdf'});
        await state.downloadDocument(); await flush();
        expect(download).toHaveBeenCalledWith(state.parsedDocument, ['可复制的实际校订文字'], 'bilingual', expect.objectContaining({pdfPresentation: presentation}));
    });

    it('keeps batch PDF downloads in layout presentation after selecting readable for the current file', async () => {
        await state.loadFiles([file('first.pdf'), file('second.pdf')]);
        for (const item of [...state.documentQueue]) {state.selectDocument(item); state.editSegment(0, `译文 ${item.name}`);}
        state.pdfPresentation = 'readable';
        const download = vi.spyOn(binaryService, 'createDocumentDownload').mockResolvedValue({data: new Uint8Array([1]), fileName: 'paired.pdf', mimeType: 'application/pdf'});
        await state.downloadBatch(); await flush();
        expect(download).toHaveBeenCalledTimes(2);
        expect(download.mock.calls.every(([, , , options]) => options?.pdfPresentation === 'layout')).toBe(true);
    });

    it.each(['pause', 'switch', 'reset'] as const)('clears an in-flight OCR status on %s and ignores progress from the abandoned request', async action => {
        await state.loadFiles([file('scanned.pdf'), file('other.txt', 'Other document')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: any) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned; state.documentQueue[0].document = scanned;
        const recognizing = deferred<any>();
        ports.recognize.mockReturnValue(recognizing.promise);
        const running = state.startTranslation();
        await vi.waitFor(() => expect(ports.recognize).toHaveBeenCalledOnce());
        const options = ports.recognize.mock.calls[0][2];
        options.onProgress({completed: 1, total: 3}); await flush();
        expect(state.statusLabel).toBe('document.pdfReading.recognizing');
        if (action === 'reset') {
            state.resetDocument();
            await state.loadFiles([file('replacement.txt', 'Replacement document')]);
        } else {
            state.pauseTranslation();
            expect(state.statusLabel).toBe('已暂停');
            if (action === 'switch') state.selectDocument(state.documentQueue[1]);
        }
        await flush();
        const current = state.parsedDocument;
        expect(state.recognitionProgress).toBe('');
        expect(state.statusLabel).toBe(action === 'pause' ? '已暂停' : '准备就绪');
        expect(options.signal.aborted).toBe(true);
        options.onProgress({completed: 2, total: 3});
        recognizing.resolve({...scanned, segments: [{id: 0, source: 'Late OCR result'}]});
        await running; await flush();
        expect(state.parsedDocument).toBe(current);
        expect(state.recognitionProgress).toBe('');
        expect(state.statusLabel).toBe(action === 'pause' ? '已暂停' : '准备就绪');
        expect(ports.batch).not.toHaveBeenCalled(); expect(ports.translate).not.toHaveBeenCalled();
    });

    it('shows an OCR failure and a retry action instead of the static scanned-document status', async () => {
        await state.loadFiles([file('scanned.pdf')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: any) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned; state.documentQueue[0].document = scanned;
        const recognizing = deferred<any>(); ports.recognize.mockReturnValue(recognizing.promise);
        const running = state.startTranslation();
        await vi.waitFor(() => expect(ports.recognize).toHaveBeenCalledOnce());
        ports.recognize.mock.calls[0][2].onProgress({completed: 1, total: 3}); await flush();
        recognizing.reject(new Error('OCR temporarily unavailable')); await running; await flush();
        expect(state.statusLabel).toBe('翻译中断'); expect(state.recognitionProgress).toBe('');
        expect(state.errorMessage).toBe('OCR temporarily unavailable'); expect(state.translationActionLabel).toBe('document.translationRecovery.retry');
        expect(state.needsOcr).toBe(true);
    });

    it('keeps an empty OCR result readable and shows its failure without requesting translation or repeating OCR', async () => {
        await state.loadFiles([file('scanned.pdf')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: PdfDocumentPage) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned;
        const recognized = {...scanned, binary: {...scanned.binary,
            pages: scanned.binary.pages.map((page: PdfDocumentPage) => ({...page, scanned: false})),
        }};
        ports.recognize.mockResolvedValueOnce(recognized);

        await state.startTranslation(); await flush();

        expect(state.runState).toBe('failed');
        expect(state.documentQueue[0].state).toBe('failed');
        expect(state.errorMessage).toBe('document.pdfReading.ocrEmpty');
        expect(state.documentQueue[0].error).toBe(state.errorMessage);
        expect(state.parsedDocument).toBe(recognized);
        expect(state.documentQueue[0].document).toBe(recognized);
        expect(state.parsedDocument.binary.bytes).toBe(original.binary.bytes);
        expect(state.needsOcr).toBe(false);
        expect(state.translating).toBe(false);
        expect(state.recognitionProgress).toBe('');
        expect(state.batchCompletedCount).toBe(0);
        const recovery = walkHost(root).find(entry => entry.props['data-testid'] === 'document-translation-recovery')!;
        expect(walkHost(recovery).find(entry => entry.props.class === 'recovery-error-detail')!.text).toBe('document.pdfReading.ocrEmpty');
        expect(walkHost(root).some(entry => entry.props['data-document-reader'] === 'pdf')).toBe(true);
        await state.startTranslation(); await flush();
        expect(ports.recognize).toHaveBeenCalledOnce();
        expect(ports.batch).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
        expect(state.runState).toBe('failed');
        expect(state.errorMessage).toBe('document.pdfReading.ocrEmpty');
    });

    it('ignores a canceled empty OCR result after switching to another document', async () => {
        await state.loadFiles([file('scanned.pdf'), file('other.txt', 'Other document')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: PdfDocumentPage) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned;
        const recognizing = deferred<unknown>();
        ports.recognize.mockReturnValueOnce(recognizing.promise);
        const running = state.startTranslation();
        await flush();
        expect(ports.recognize).toHaveBeenCalledOnce();
        const signal = ports.recognize.mock.calls[0][2].signal;
        state.pauseTranslation();
        state.selectDocument(state.documentQueue[1]);
        state.editSegment(0, 'Reader correction');
        const current = state.parsedDocument;
        recognizing.resolve({...scanned, binary: {...scanned.binary,
            pages: scanned.binary.pages.map((page: PdfDocumentPage) => ({...page, scanned: false})),
        }});
        await running; await flush();

        expect(signal.aborted).toBe(true);
        expect(state.parsedDocument).toBe(current);
        expect(state.runState).toBe('ready');
        expect(state.errorMessage).toBe('');
        expect(state.translatedSegments).toEqual(['Reader correction']);
        expect(state.documentQueue[0].document).toBe(scanned);
        expect(state.documentQueue[0].state).toBe('paused');
        expect(state.documentQueue[0].error).toBe('');
        expect(state.documentQueue[0].document.binary.pages[0].scanned).toBe(true);
        expect(ports.batch).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
    });

    it.each([false, true])('uses accurate import and change-file guidance with local history available=%s', async available => {
        app.unmount(); vi.stubGlobal('indexedDB', available ? new IDBFactory() : undefined);
        root = node('root'); app = renderer.createApp(DocumentApp); app.mount(root); state = (app._instance as any).setupState;
        await flush();
        const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
        expect(walk(root).find(entry => entry.props.class === 'local-processing-note')?.text).toBe('document.localProcessingNote');
        await state.loadFiles([file('guide.txt', 'Source paragraph')]);
        state.editSegment(0, '人工校订'); state.changeDocument(); await flush();
        expect(state.pendingAction).toBe('reset');
        expect(walk(root).some(entry => entry.text === `document.changeDocument.${available ? 'historyHint' : 'downloadHint'}`)).toBe(true);
    });

    it.each([false, true])('keeps the task language, service, model, document batch and AI context snapshot across delayed scanned-PDF OCR with context=%s', async enableAIContext => {
        const initial = JSON.parse(JSON.stringify(ports.config));
        Object.assign(initial, {from: 'en', to: 'zh-CN', documentService: 'openai', enableAIMultiSegment: false, enableAIContext});
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
        Object.assign(external, {from: 'fr', to: 'de', documentService: 'google', enableAIMultiSegment: true, enableAIContext: !enableAIContext});
        external.documentModel.openai = 'document-after';
        Object.assign(ports.config, external);
        const sharedAfterUpdate = JSON.stringify(ports.config);
        ports.observer(external); await flush();
        expect(state.config.from).toBe('fr'); expect(state.config.documentService).toBe('google');
        expect(state.translating).toBe(true);
        expect(state.taskFingerprint).toBe(fingerprint);

        const sources = ['Recognized first paragraph', 'Recognized second paragraph'];
        ports.translate.mockImplementation(async (source: string) => `译 ${source}`);
        const recognized = {...scanned, segments: sources.map((source, id) => ({id, source})), binary: {...scanned.binary,
            pages: scanned.binary.pages.map((page: any) => ({...page, scanned: false, segmentIndexes: [0, 1]})),
        }};
        recognizing.resolve(recognized); await running; await flush();
        const frozenSettings = {serviceOverride: 'openai', modelOverride: 'document-before', sourceLanguage: 'en', targetLanguage: 'zh-CN', enableAIContext};
        if (enableAIContext) {
            expect(ports.batch).not.toHaveBeenCalled();
            expect(ports.translate).toHaveBeenCalledTimes(2);
            for (const [source, context, options] of ports.translate.mock.calls) {
                expect(sources).toContain(source);
                expect(context).toBe('scanned.pdf');
                expect(options).toEqual(expect.objectContaining({...frozenSettings, discourseContext: expect.any(String)}));
            }
        } else {
            expect(ports.batch).toHaveBeenCalledOnce();
            expect(ports.batch).toHaveBeenCalledWith(sources, 'scanned.pdf', expect.objectContaining({...frozenSettings, aiMultiSegment: true}));
            expect(ports.translate).not.toHaveBeenCalled();
        }
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

    it('keeps manually confirmed translations in the current file session and clears them on restart', async () => {
        state.config.documentService = 'google';
        await state.loadFiles([file('first.txt', 'First paragraph\n\nSecond paragraph')]); await flush();
        state.editSegment(0, '人工确认译文');
        expect(state.confirmedTranslationIds).toEqual([0]);
        await state.loadFiles([file('second.txt', 'Another paragraph')]); await flush();
        expect(state.confirmedTranslationIds).toEqual([]);
        state.selectDocument(state.documentQueue[0]); await flush();
        expect(state.confirmedTranslationIds).toEqual([0]);
        state.editSegment(0, '  ');
        expect(state.confirmedTranslationIds).toEqual([]);
        state.editSegment(0, '再次确认');
        await state.startTranslation(true); await flush();
        expect(state.confirmedTranslationIds).toEqual([]);
        state.editSegment(0, '确认后重置');
        state.resetDocument(); await flush();
        expect(state.confirmedTranslationIds).toEqual([]);
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
    it('preserves failed task recovery through another import and isolates online import failures', async () => {
        await state.loadFiles([file('first.txt', 'First.\n\nSecond.')]);
        state.editSegment(0, 'Reviewed first passage');
        const task = state.documentQueue[0];
        ports.batch.mockRejectedValueOnce(Object.assign(new Error('HTTP 400 invalid model'), {retryable: false}));
        await state.startTranslation(); await flush();
        const taskError = state.errorMessage;
        expect(task.state).toBe('failed'); expect(taskError).toContain('HTTP 400');
        await state.loadFiles([file('second.txt')]);
        state.selectDocument(task); await flush();
        expect(state.errorMessage).toBe(taskError); expect(state.progress).toBe(50);
        expect(state.translatedSegments[0]).toBe('Reviewed first passage');
        expect(walkHost(root).some(entry => entry.props['data-testid'] === 'document-translation-recovery')).toBe(true);
        ports.fetchPdf.mockRejectedValueOnce(new Error('Online PDF unavailable'));
        state.onlinePdfUrl = 'https://example.test/unavailable.pdf';
        await state.openOnlinePdf(); await flush();
        expect(state.importError).toBe('Online PDF unavailable');
        expect(walkHost(root).some(entry => entry.props.role === 'alert' && hostText(entry) === 'Online PDF unavailable')).toBe(true);
        expect(state.errorMessage).toBe(taskError); expect(task.state).toBe('failed');
        await state.openOnlinePdf();
        expect(state.importError).toBe('');
        state.selectDocument(task); await flush();
        expect(state.errorMessage).toBe(taskError); expect(state.confirmedTranslationIds).toEqual([0]);
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

    it.each(['reset', 'switch'] as const)('invalidates a pending parser on %s without allowing its late task into the current queue', async action => {
        await state.loadFiles([file('first.txt'), file('second.txt')]);state.editSegment(0, 'First correction');
        const first = state.documentQueue[0], second = state.documentQueue[1];
        const parsing = deferred<ParsedDocument>();
        const read = vi.spyOn(binaryService, 'parseDocumentFile').mockReturnValueOnce(parsing.promise);
        const running = state.loadFiles([file('late.txt')]);const signal = read.mock.calls[0][1]!.signal!;
        if (action === 'reset') {state.resetDocument();await state.loadFiles([file('replacement.txt')]);}
        else state.selectDocument(second);
        state.editSegment(0, 'Current correction');const current = state.parsedDocument;
        const count = state.documentQueue.length;
        parsing.resolve(parseDocument('late.txt', 'Late source.'));await running;await flush();
        expect(signal.aborted).toBe(true);expect(state.documentQueue).toHaveLength(count);
        expect(state.parsedDocument).toBe(current);expect(state.translatedSegments).toEqual(['Current correction']);
        expect(first.translations).toEqual(['First correction']);expect(first.downloaded).toBe(0);
        expect(state.documentQueue.some((item: {name: string}) => item.name === 'late.txt')).toBe(false);
    });

    it.each(['switch', 'unmount'] as const)('revokes a captured OCR session directly on %s without committing its late result or failure', async action => {
        await state.loadFiles([file('scanned.pdf'), file('other.txt')]);
        const original = state.parsedDocument;
        const scanned = markRaw({...original, segments: [], binary: {...original.binary,
            pages: original.binary.pages.map((page: PdfDocumentPage) => ({...page, scanned: true, segmentIndexes: [], blocks: []})),
        }});
        state.parsedDocument = scanned;
        const recognizing = deferred<typeof scanned>();ports.recognize.mockReturnValueOnce(recognizing.promise);
        const running = state.startTranslation();await flush();const controls = ports.recognize.mock.calls[0][2];
        if (action === 'switch') {state.selectDocument(state.documentQueue[1]);state.editSegment(0, 'Other correction');}
        else {app.unmount();app = null;}
        const current = state.parsedDocument;
        controls.onProgress({completed: 99, total: 100});
        if (action === 'switch') recognizing.resolve({...scanned, segments: [{id: 0, source: 'late OCR'}]});
        else recognizing.reject(new Error('late OCR failure'));
        await running;await flush();
        expect(controls.signal.aborted).toBe(true);expect(state.parsedDocument).toBe(current);
        expect(state.recognitionProgress).toBe('');expect(state.errorMessage).toBe('');
        expect(ports.translate).not.toHaveBeenCalled();expect(ports.batch).not.toHaveBeenCalled();
        if (action === 'switch') expect(state.translatedSegments).toEqual(['Other correction']);
    });

    it.each(['switch', 'reset', 'unmount'] as const)('revokes pending export on %s before late encoding can download or ACK another task', async action => {
        await state.loadFiles([file('first.txt'), file('second.txt')]);state.editSegment(0, 'First correction');
        const first = state.documentQueue[0];
        const encoding = deferred<binaryService.DocumentDownload>();
        const encode = vi.spyOn(binaryService, 'createDocumentDownload').mockReturnValueOnce(encoding.promise);
        const running = state.downloadDocument();const controls = encode.mock.calls[0][3]!;
        if (action === 'switch') {state.selectDocument(state.documentQueue[1]);state.editSegment(0, 'Current correction');}
        else if (action === 'reset') {state.resetDocument();await state.loadFiles([file('replacement.txt')]);state.editSegment(0, 'Current correction');}
        else {app.unmount();app = null;}
        const current = state.parsedDocument, progress = state.downloadProgress;
        controls.onArchiveProgress!(99);controls.onPdfProgress!({phase: 'saving', completedPages: 1, totalPages: 1});
        encoding.resolve({data: 'old export', fileName: 'old.txt', mimeType: 'text/plain'});await running;await flush();
        expect(controls.signal!.aborted).toBe(true);expect(createUrl).not.toHaveBeenCalled();
        expect(state.parsedDocument).toBe(current);expect(state.downloadProgress).toBe(progress);
        expect(first.translations).toEqual(['First correction']);expect(first.downloaded).toBe(0);
        if (action !== 'unmount') {expect(state.translatedSegments).toEqual(['Current correction']);expect(state.downloadedRevision).toBe(0);}
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
    expect(ports.translate).not.toHaveBeenCalled();
    expect(ports.batch).toHaveBeenCalledOnce();
    expect(ports.batch.mock.calls[0][0]).toEqual(['The agent uses FluentRead.']);
    expect(state.parsedDocument.segments[0].source).toBe('The agent uses FluentRead.');
    expect(state.pendingAction).toBeNull();
    const status = walk(root).find(entry => entry.props.class === 'document-status')!;
    expect(text(status)).toContain('翻译完成');
    expect(ports.i18n).toHaveBeenCalledWith('document.translationProgress.count', {completed: 1, total: 1, percent: 100});
    expect(walk(root).find(entry => entry.props['data-testid'] === 'document-translation-progress')!.props['aria-valuenow']).toBe(100);
});

it('saves the reader current visible paragraph and preserves the saved target when the PDF layout becomes unavailable', async () => {
    await state.loadFiles([file('visible-material.pdf')]); await flush();
    state.documentQueue[0].historyId = 'a'.repeat(32);
    const parsed = state.parsedDocument;
    state.parsedDocument = markRaw({...parsed, segments: [...parsed.segments, {id: 1, source: '  Later Cafe\u0301\noriginal paragraph  '}], binary: {...parsed.binary, pages: [{...parsed.binary.pages[0], segmentIndexes: [0, 1], blocks: [...parsed.binary.pages[0].blocks, {...parsed.binary.pages[0].blocks[0], segmentIndex: 1, y: 300, lines: [{x: 5, y: 300, baseline: 310, width: 50, height: 12, text: '  Later Cafe\u0301\noriginal paragraph  '}]}]}]}});
    await flush();
    const captureMaterialLocation = vi.fn(() => 1), resumeLocation = vi.fn(async () => true);
    state.materialPdfReader = {captureMaterialLocation, resolveMaterialSelection: () => 1, resumePage: async () => {}, resumeLocation, cancelMaterialResume() {}};
    let saved: any;
    ports.sendMessage.mockImplementation(async (message: any) => {
        if (message.type !== 'fluentReadMaterials') return;
        if (message.action === 'generation') return {success: true, data: 3};
        if (message.action === 'capture') {saved = {id: 'visible-material', kind: 'document', ...message.input}; return {success: true, data: saved};}
        return {success: true, data: saved};
    });
    await state.saveDocumentMaterial();
    expect(saved.locator.documentReference.locator.source).toBe('  Later Cafe\u0301\noriginal paragraph  ');
    expect(saved.locator.documentReference.locator.position).toBe('[5,310]');
    expect(saved.locator.documentReference.materialId).toBe('a'.repeat(32));
    expect(state.captureDocumentMaterialSelection({} as Range, 'before public ref')).toBeUndefined();
    state.materialPdfReader = {captureMaterialLocation, resolveMaterialSelection: () => 1, resumePage: async () => {}, resumeLocation, cancelMaterialResume() {}};
    const selected = state.captureDocumentMaterialSelection({} as Range, 'selected translated word');
    expect(selected.locator.quote).toBe('selected translated word'); expect(selected.locator.documentReference.locator.source).toBe(saved.locator.documentReference.locator.source);
    await state.restoreMaterialDocument(saved.id); await state.applyMaterialResume(); await flush();
    state.materialPdfReader = {captureMaterialLocation, resolveMaterialSelection: () => 1, resumePage: async () => {}, resumeLocation, cancelMaterialResume() {}}; await flush();
    expect(resumeLocation).toHaveBeenCalledWith(1);
    captureMaterialLocation.mockReturnValue(undefined as any); ports.sendMessage.mockClear();
    await state.saveDocumentMaterial(); expect(state.downloadNotice).toContain('原阅读位置已保留');
    expect(ports.sendMessage.mock.calls.some(([message]) => message.action === 'capture')).toBe(false);
});

it.each([
    ['reader-controls-slot', 'onPointerdownCapture'],
    ['sidebar-outline', 'onKeydownCapture'],
])('resumed material accepts trusted navigation intent from external %s and records the new visible paragraph', async (containerClass, eventName) => {
    ports.pageCount = 3; await state.loadFiles([file('navigation-material.pdf')]); await flush();
    const fingerprint = 'a'.repeat(32); state.documentQueue[0].historyId = fingerprint;
    const saved = {id: 'navigation-material', kind: 'document', source: {kind: 'document', fingerprint}, locator: {kind: 'document', page: 1}};
    const captures: any[] = [];
    ports.sendMessage.mockImplementation(async (message: any) => {
        if (message.type !== 'fluentReadMaterials') return;
        if (message.action === 'capture') {captures.push(message.input); return {success: true, data: saved};}
        return {success: true, data: message.action === 'generation' ? 3 : saved};
    });
    let visibleSegment = 0;
    const api = {resumePage: async (page: number) => {state.pdfPage = page;}, resumeLocation: async () => true, cancelMaterialResume() {},
        captureMaterialLocation: () => visibleSegment, resolveMaterialSelection: () => visibleSegment};
    await state.restoreMaterialDocument(saved.id); await flush(); state.materialPdfReader = api; await flush();
    expect(state.documentMaterialId).toBe(saved.id);
    const container = walkHost(root).find(entry => entry.props.class?.split?.(' ').includes(containerClass) && typeof entry.props[eventName] === 'function')!;
    expect(container).toBeDefined();
    vi.useFakeTimers();
    try {
        // 恢复和程序事件不会开启位置写回；执行真实 SFC 绑定，可信事件位由事件端口提供。
        container.props[eventName]({isTrusted: false}); visibleSegment = 1; state.pdfPage = 2; await flush(); state.materialPdfReader = api;
        state.queueMaterialPositionCapture(); await vi.advanceTimersByTimeAsync(1100); expect(captures).toHaveLength(0);
        // 下一页/目录点击的 pointer 或键盘事件先到外部导航容器，再由阅读器通知新视口。
        container.props[eventName]({isTrusted: true}); visibleSegment = 2; state.pdfPage = 3; await flush(); state.materialPdfReader = api;
        state.queueMaterialPositionCapture(); await vi.advanceTimersByTimeAsync(1100);
        expect(captures).toHaveLength(1); expect(captures[0].positionOnly).toBe(true);
        expect(captures[0].locator.page).toBe(3); expect(captures[0].locator.documentReference.locator.scope).toBe('pdf:3');
    } finally {vi.useRealTimers();}
});

it('trusted reading gestures preempt only an active exact resume while unresolved saved references remain protected', async () => {
    await state.loadFiles([file('interrupt-material.pdf')]); await flush(); state.documentQueue[0].historyId = 'a'.repeat(32);
    const paused = deferred<boolean>();
    const cancelMaterialResume = vi.fn(() => paused.resolve(false));
    const api = {captureMaterialLocation: () => 0, resolveMaterialSelection: () => 0, resumePage: async () => {}, resumeLocation: vi.fn(() => paused.promise), cancelMaterialResume};
    state.materialPdfReader = api;
    const captured = state.documentMaterialSelection(); let record = {id: 'interrupt-material', kind: 'document', ...captured};
    const writes: any[] = [];
    ports.sendMessage.mockImplementation(async (message: any) => {
        if (message.type !== 'fluentReadMaterials') return;
        if (message.action === 'capture') writes.push(message.input);
        return {success: true, data: message.action === 'generation' ? 3 : record};
    });
    await state.restoreMaterialDocument(record.id); await flush(); state.materialPdfReader = api;
    const restoring = state.applyMaterialResume(); await flush(); expect(api.resumeLocation).toHaveBeenCalled();
    const reading = walkHost(root).find(entry => typeof entry.props.onWheelPassive === 'function' && String(entry.props.class).includes('reading-content'))!;
    reading.props.onWheelPassive({isTrusted: false}); expect(cancelMaterialResume).not.toHaveBeenCalled();
    reading.props.onWheelPassive({isTrusted: true}); await restoring; await flush();
    expect(cancelMaterialResume).toHaveBeenCalledOnce(); expect(state.downloadNotice).toContain('已停止自动定位');
    vi.useFakeTimers();
    try {state.materialPdfReader = api; state.queueMaterialPositionCapture(); await vi.advanceTimersByTimeAsync(1100); expect(writes).toHaveLength(1);}
    finally {vi.useRealTimers();}
    // 无法唯一匹配不属于正在执行的恢复，不能被一次普通滚动变成自动覆盖授权。
    record = {...record, locator: {...record.locator, documentReference: {...record.locator.documentReference, locator: {...record.locator.documentReference.locator, source: 'Unavailable original'}}}};
    await state.restoreMaterialDocument(record.id); await state.applyMaterialResume(); await flush();
    expect(state.downloadNotice).toContain('原文位置已变化或无法唯一匹配');
    vi.useFakeTimers();
    try {state.materialPdfReader = api; reading.props.onWheelPassive({isTrusted: true}); state.queueMaterialPositionCapture(); await vi.advanceTimersByTimeAsync(1100); expect(writes).toHaveLength(1);}
    finally {vi.useRealTimers();}
    expect(cancelMaterialResume).toHaveBeenCalledOnce();
});
