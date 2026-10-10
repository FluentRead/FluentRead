import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRenderer, h, nextTick, ref, type App} from 'vue';
import JSZip from 'jszip';
import {Config} from '@/src/core/config/model';
import {customModelString, models} from '@/src/core/config/catalog';
import {parseDocument, type ParsedDocument} from '@/src/features/document-translation/core/document';
import type {CreateDocumentDownloadOptions, DocumentDownload} from '@/src/features/document-translation/services/binary';
import {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';
import DocumentApp from '@/src/app/document-translation/DocumentApp.vue';
import {documentRetryBackoff} from '@/src/app/document-translation/runtime';
import DocumentSegmentEditor from '@/src/app/document-translation/DocumentSegmentEditor.vue';

// Only external ports are controlled. Both original client SFC templates, the app adapter,
// parsing, segment translator, text export and (unless explicitly delayed) ZIP writer run.
const ports = vi.hoisted(() => ({
    config: undefined as unknown as Config,
    ready: Promise.resolve() as Promise<unknown>,
    observer: undefined as undefined | ((config: Config) => void),
    unsubscribe: vi.fn(), send: vi.fn(), tabs: vi.fn(), single: vi.fn(), batch: vi.fn(),
    download: vi.fn(), archive: vi.fn(),
}));
vi.mock('@/src/features/document-translation/ui/PdfReader.vue', () => ({default: {setup: () => () => h('div')}}));
vi.mock('webextension-polyfill', () => ({default: {
    runtime: {sendMessage: ports.send, getURL: (path: string) => `chrome-extension://document-actions/${path}`},
    tabs: {create: ports.tabs},
}}));
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    ports.config = new Config();
    return {
        config: ports.config,
        configReady: {then: (yes: (value: unknown) => unknown, no: (error: unknown) => unknown) => ports.ready.then(yes, no)},
        subscribeConfig: (observer: (config: Config) => void) => {ports.observer = observer; return ports.unsubscribe;},
        requestConfigPatch: (patch: unknown, send: (message: unknown) => Promise<unknown>) => send({patch}),
    };
});
vi.mock('@/src/app/translation/client', () => ({translateText: ports.single, translateTextBatch: ports.batch}));
vi.mock('@/src/features/document-translation/services/binary', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/document-translation/services/binary')>('@/src/features/document-translation/services/binary');
    ports.download.mockImplementation(actual.createDocumentDownload);
    return {...actual, createDocumentDownload: ports.download};
});
vi.mock('@/src/features/document-translation/services/archive', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/document-translation/services/archive')>('@/src/features/document-translation/services/archive');
    ports.archive.mockImplementation(actual.generateDocumentArchive);
    return {...actual, generateDocumentArchive: ports.archive};
});
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({
    language: ref('zh-CN'), translateLegacy: (text: string) => text,
    t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key,
})}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {
    props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'],
    setup: (props: {modelValue: unknown; disabled: boolean}, {slots, emit}: any) => () => h('select', {
        value: props.modelValue, disabled: props.disabled,
        onChange: (event: any) => {emit('update:modelValue', event.target.value); emit('change', event.target.value);},
    }, slots.default?.()),
}}));
vi.mock('@/src/ui/components/GlossaryLibrarySelect.vue', () => ({default: {
    props: ['modelValue'], emits: ['update:modelValue'],
    setup: (_props: unknown, {emit}: any) => () => h('button', {
        'aria-label': 'document glossary port', onClick: () => emit('update:modelValue', []),
    }, '停用文档术语'),
}}));
vi.mock('element-plus', () => ({ElOption: {
    props: ['label', 'value', 'disabled'],
    setup: (props: any) => () => h('option', {value: props.value, disabled: props.disabled}, props.label),
}}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));

// A host implementing Vue's element/directive/event contract; no setup-state access,
// SFC extraction, replacement business functions, or native browser/App operations.
type Host = EventTarget & {
    tag: string; tagName: string; type: string; props: Record<string, any>; children: Host[];
    parent?: Host; text: string; style: Record<string, unknown>; value: any; checked: boolean;
    files?: File[]; open: boolean; click: ReturnType<typeof vi.fn>; showModal: () => void; close: () => void;
    getAttribute: (name: string) => unknown;
};
function host(tag: string): Host {
    const entry = Object.assign(new EventTarget(), {
        tag, tagName: tag.toUpperCase(), type: '', props: {} as Record<string, any>, children: [] as Host[],
        text: '', style: {}, value: '', checked: false, open: false, click: vi.fn(),
        getAttribute: (name: string) => entry.props[name],
        showModal: () => {entry.open = true;},
        close: () => {if (entry.open) {entry.open = false; void fire(entry, 'close');}},
    });
    return entry;
}
const renderer = createRenderer<Host, Host>({
    createElement: host, createText: text => Object.assign(host('#text'), {text}),
    createComment: text => Object.assign(host('#comment'), {text}),
    setText: (node, text) => {node.text = text;},
    setElementText: (node, text) => {node.text = text; node.children = [];},
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert: (node, parent, anchor) => {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = parent;
        const index = anchor ? parent.children.indexOf(anchor) : -1;
        parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    },
    remove: node => {if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = undefined;},
    patchProp: (node, key, _old, value) => {
        node.props[key] = value;
        if (key === 'value' || key === 'checked' || key === 'type') (node as any)[key] = value;
    },
});
const walk = (node: Host): Host[] => [node, ...node.children.flatMap(walk)];
const textOf = (node: Host): string => node.tag === '#comment' ? '' : node.text + node.children.map(textOf).join('');
let root: Host;
let apps: App[];
let win: EventTarget;
let media: EventTarget & {matches: boolean};
let anchors: Array<{href: string; download: string; click: ReturnType<typeof vi.fn>}>;
let blobs: Blob[];
let revoked: string[];
let cleanups: Array<() => void>;
let actions: Promise<unknown>[];
let browserTimers: Set<ReturnType<typeof setTimeout>>;
const flush = async () => {for (let i = 0; i < 10; i += 1) {await Promise.resolve(); await nextTick();}};
async function fire(node: Host, eventName: string, changes: Record<string, unknown> = {}): Promise<void> {
    Object.assign(node, changes);
    const event = new Event(eventName, {cancelable: true});
    node.dispatchEvent(event);
    const handler = node.props[`on${eventName[0].toUpperCase()}${eventName.slice(1)}`];
    for (const fn of handler ? Array.isArray(handler) ? handler : [handler] : []) {
        const result = fn(event);
        if (result?.then) actions.push(result);
    }
    await flush();
}
function find(predicate: (node: Host) => boolean, within = root): Host {
    const found = walk(within).find(predicate);
    expect(found, `rendered element absent; text: ${textOf(within).slice(0, 1200)}`).toBeTruthy();
    return found!;
}
const labelled = (label: string, within = root) => find(node => node.props['aria-label'] === label, within);
const dialog = (heading: string) => find(node => node.tag === 'dialog' && node.props['aria-labelledby'] === heading);
const button = (label: string, within = root) => find(node => node.tag === 'button' && textOf(node) === label, within);
const taskbar = () => find(node => node.props['aria-label'] === '当前文档与翻译任务');
const translateButton = () => find(node => node.tag === 'button' && String(node.props.class).includes('translate-document-button'), taskbar());
const editor = () => labelled('全量译文校订');
const textarea = (id: number) => find(node => node.tag === 'textarea', find(node => node.props['data-segment-id'] === id, editor()));
const search = () => find(node => node.tag === 'input' && node.type === 'search', editor());
const pendingFilter = () => find(node => node.tag === 'input' && node.type === 'checkbox', editor());
// Node's Event has a read-only legacy returnValue; the browser BeforeUnloadEvent
// port has a writable one. Preserve the actual consumer assignment and prevention.
const beforeUnload = () => Object.defineProperty(new Event('beforeunload', {cancelable: true}), 'returnValue', {value: undefined, writable: true});
const file = (name: string, content = 'Original text.') => ({name, size: content.length,
    text: async () => content, arrayBuffer: async () => new TextEncoder().encode(content).buffer}) as File;
function deferred<T>(fallback: T) {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    cleanups.push(() => resolve(fallback));
    return {promise, resolve, reject};
}
function mount(component: any = DocumentApp, props?: Record<string, unknown>) {
    root = host('root');
    const app = renderer.createApp(component, props);
    app.mount(root); apps.push(app);
    return app;
}
async function importFiles(...inputs: File[]) {
    const input = find(node => node.tag === 'input' && node.type === 'file');
    await fire(input, 'change', {files: inputs, value: 'fake-path'});
    expect(input.value).toBe('');
    await vi.waitFor(() => expect(walk(root).some(node => node.tag === 'h1' && textOf(node) === inputs[0].name)).toBe(true));
}
async function edit(id: number, value: string) {
    await fire(button('校订译文'), 'click');
    await fire(textarea(id), 'input', {value});
}
async function selectFile(name: string) {
    await fire(find(node => node.tag === 'button' && String(node.props.class).includes('batch-file') && textOf(node.children[0]) === name), 'click');
}
function broadcast(patch: Partial<Config>) {
    const next = Object.assign(new Config(), JSON.parse(JSON.stringify(ports.config)), patch);
    Object.assign(ports.config, next);
    ports.observer!(next);
}
async function downloadReady() {
    await fire(button('下载文件 ↓'), 'click');
    return dialog('download-document-heading');
}
beforeEach(async () => {
    cleanups = []; actions = []; apps = []; anchors = []; blobs = []; revoked = []; browserTimers = new Set();
    // 既有用例验证“失败即停止并可手动重试”；自动退避由专门的用例打开。
    Object.assign(documentRetryBackoff, {maxWaitMs: 0, sleep: undefined});
    Object.assign(ports.config, new Config(), {service: 'microsoft'});
    ports.ready = Promise.resolve(); ports.observer = undefined;
    ports.send.mockReset().mockResolvedValue(undefined); ports.unsubscribe.mockReset(); ports.tabs.mockReset().mockResolvedValue(undefined);
    ports.single.mockReset().mockImplementation(async (source: string) => `T:${source}`);
    ports.batch.mockReset().mockImplementation(async (sources: string[]) => sources.map(source => `T:${source}`));
    const binary = await vi.importActual<typeof import('@/src/features/document-translation/services/binary')>('@/src/features/document-translation/services/binary');
    const archive = await vi.importActual<typeof import('@/src/features/document-translation/services/archive')>('@/src/features/document-translation/services/archive');
    ports.download.mockReset().mockImplementation(binary.createDocumentDownload);
    ports.archive.mockReset().mockImplementation(archive.generateDocumentArchive);
    media = Object.assign(new EventTarget(), {matches: false});
    win = Object.assign(new EventTarget(), {matchMedia: () => media, location: {origin: 'chrome-extension://document-actions'},
        setTimeout: (callback: () => void, delay: number) => {
            const timer = setTimeout(() => {browserTimers.delete(timer); callback();}, delay);
            browserTimers.add(timer); return timer;
        },
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => {browserTimers.delete(timer); clearTimeout(timer);},
        document: {createElement: () => {
            const anchor = {href: '', download: '', click: vi.fn()}; anchors.push(anchor); return anchor;
        }},
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {activeElement: null});
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {blobs.push(blob as Blob); return `blob:actions-${blobs.length}`;});
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => {revoked.push(url);});
    mount(); await flush();
});
afterEach(async () => {
    apps.reverse().forEach(app => app.unmount());
    cleanups.forEach(cleanup => cleanup());
    await flush(); await Promise.allSettled(actions); await vi.dynamicImportSettled();
    browserTimers.forEach(timer => clearTimeout(timer)); browserTimers.clear();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('document user actions: configuration consumers', () => {
    it('defaults to batching for each document and retains a local opt-out without saving global settings', async () => {
        const globalBatching = ports.config.enableAIMultiSegment;
        await importFiles(file('batch-first.txt', 'First passage.\n\nSecond passage.'), file('batch-second.txt', 'Third passage.\n\nFourth passage.'));
        const localToggle = () => find(node => node.tag === 'input' && node.type === 'checkbox', find(node => String(node.props.class).includes('document-batch-translation')));
        expect(localToggle().checked).toBe(true);
        await fire(localToggle(), 'change', {checked: false});
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(ports.single).toHaveBeenCalledTimes(2));
        expect(ports.batch).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(button('下载文件 ↓', taskbar()).props.disabled).toBe(false));
        await selectFile('batch-second.txt');
        expect(localToggle().checked).toBe(true);
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(ports.batch).toHaveBeenCalledOnce());
        expect(ports.batch.mock.calls[0][0]).toEqual(['Third passage.', 'Fourth passage.']);
        await flush();
        await selectFile('batch-first.txt');
        expect(localToggle().checked).toBe(false);
        expect(ports.config.enableAIMultiSegment).toBe(globalBatching);
        expect(ports.send).not.toHaveBeenCalled();
    });

    it('retains the latest successful language after an older failed save and its authoritative current-state rollback broadcast', async () => {
        await importFiles(file('late-save.txt'));
        const old = deferred<unknown>(undefined); ports.send.mockReturnValueOnce(old.promise);
        await fire(labelled('文档目标语言'), 'change', {value: 'ja'});
        await fire(labelled('文档目标语言'), 'change', {value: 'fr'});
        broadcast({to: 'fr'}); await flush();
        old.reject(new Error('old request failed')); await flush();
        broadcast({to: 'fr'}); await flush();
        expect(labelled('文档目标语言').value).toBe('fr');
        expect(textOf(root)).not.toContain('设置未能保存');
        expect(ports.send).toHaveBeenCalledTimes(2);
        await fire(translateButton(), 'click');
        expect(ports.batch.mock.calls[0][2].targetLanguage).toBe('fr');
    });

    it('saves document service, language and explicit empty glossary selection through the rendered form and uses them in translation', async () => {
        broadcast({glossaryEnabled: true}); await flush();
        await importFiles(file('form.txt'));
        await fire(button('翻译设置', taskbar()), 'click');
        expect(dialog('document-settings-heading').open).toBe(true);
        await fire(labelled('文档翻译服务'), 'change', {value: 'freeTranslation'});
        await fire(labelled('文档源语言'), 'change', {value: 'en'});
        await fire(labelled('document glossary port'), 'click');
        expect(ports.send.mock.calls.map(([message]) => message.patch)).toEqual([
            {documentService: 'freeTranslation'}, {from: 'en'}, {documentGlossaryIds: []},
        ]);
        await fire(button('开始翻译', dialog('document-settings-heading')), 'click');
        expect(dialog('document-settings-heading').open).toBe(false);
        expect(ports.batch).toHaveBeenCalledWith(['Original text.'], 'form.txt', expect.objectContaining({
            serviceOverride: 'freeTranslation', sourceLanguage: 'en', glossaryIds: [], glossaryContext: 'document',
        }));
    });

    it('keeps translation disabled during hydration, then consumes external pause and settings navigation without echo-saving', async () => {
        apps.pop()!.unmount();
        const ready = deferred<unknown>(undefined); ports.ready = ready.promise;
        mount();
        await importFiles(file('hydration.txt'));
        expect(translateButton().props.disabled).toBe(true);
        ready.resolve(undefined); await flush();
        expect(translateButton().props.disabled).toBe(false);
        broadcast({on: false}); await flush();
        expect(translateButton().props.disabled).toBe(true);
        await fire(button('通用设置'), 'click');
        expect(ports.tabs).toHaveBeenCalledWith({url: 'chrome-extension://document-actions/options.html#settings-general'});
        await fire(labelled('调整文档翻译设置'), 'click');
        expect(dialog('document-settings-heading').open).toBe(true);
        await fire(button('返回文档', dialog('document-settings-heading')), 'click');
        expect(dialog('document-settings-heading').open).toBe(false);
        await fire(button('服务连接设置 ↗'), 'click');
        expect(ports.tabs).toHaveBeenLastCalledWith({url: 'chrome-extension://document-actions/options.html#settings-services'});
        expect(ports.send).not.toHaveBeenCalled();
    });

    it('shows local save failure, consumes authoritative rollback, and dismisses the error after a later successful edit', async () => {
        await importFiles(file('save.txt'));
        ports.send.mockRejectedValueOnce(new Error('storage unavailable'));
        await fire(labelled('文档目标语言'), 'change', {value: 'fr'});
        expect(ports.send).toHaveBeenCalledWith({patch: {to: 'fr'}});
        expect(textOf(root)).toContain('设置未能保存');
        await fire(button('调整设置', taskbar()), 'click');
        expect(dialog('document-settings-heading').open).toBe(true);
        broadcast({to: 'zh-CN'}); await flush();
        expect(labelled('文档目标语言').value).toBe('zh-CN');
        expect(ports.send).toHaveBeenCalledOnce();
        await fire(labelled('文档目标语言'), 'change', {value: 'ja'});
        expect(textOf(root)).not.toContain('设置未能保存');
        expect(ports.config.to).toBe('zh-CN');
    });

    it('keeps a newer failure visible when an older save succeeds late', async () => {
        await importFiles(file('save-order.txt'));
        const older = deferred<unknown>(undefined);
        ports.send.mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error('new failure'));
        await fire(labelled('文档源语言'), 'change', {value: 'en'});
        await fire(labelled('文档目标语言'), 'change', {value: 'fr'});
        expect(textOf(root)).toContain('设置未能保存');
        older.resolve(undefined); await flush();
        expect(textOf(root)).toContain('设置未能保存');
        broadcast({from: 'en', to: 'de'}); await flush();
        expect(labelled('文档目标语言').value).toBe('de');
        expect(ports.send).toHaveBeenCalledTimes(2);
    });

    it('saves custom model sentinel and value together while preserving another service mapping', async () => {
        broadcast({documentService: 'openai', token: {openai: 'fixture-key'}, customModels: {openai: ['local-model']}, documentModel: {openai: 'gpt-5-mini'},
            documentCustomModel: {openai: '', deepseek: 'retained'}}); await flush();
        await importFiles(file('model.txt'));
        expect(walk(labelled('文档翻译模型')).some(node => node.tag === 'option' && node.props.value === 'local-model')).toBe(true);
        await fire(labelled('文档翻译模型'), 'change', {value: 'local-model'});
        expect(ports.send).toHaveBeenLastCalledWith({patch: {
            documentModel: {openai: customModelString}, documentCustomModel: {openai: 'local-model', deepseek: 'retained'},
        }});
        expect(ports.config.documentModel.openai).toBe('gpt-5-mini');
        await fire(labelled('文档翻译模型'), 'change', {value: models.get('openai')![0]});
        expect(ports.send.mock.calls.at(-1)![0].patch.documentModel.openai).toBe(models.get('openai')![0]);
        await fire(translateButton(), 'click');
        expect(ports.batch).toHaveBeenCalledWith(['Original text.'], 'model.txt', expect.objectContaining({modelOverride: models.get('openai')![0], aiMultiSegment: true}));
    });
});

describe('document user actions: download consumers', () => {
    it('cancels a queued file export before ZIP encoding and ignores both late named-file progress callbacks', async () => {
        await importFiles(file('zip-progress-first.txt'), file('zip-progress-second.txt'));
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":2}'));
        await fire(button('document.batch.queue · 2+'), 'click');
        const late = deferred<DocumentDownload>({data: 'late', fileName: 'late.txt', mimeType: 'text/plain'});
        ports.download.mockReturnValueOnce(late.promise);
        await fire(button('document.batch.zip'), 'click');
        await vi.waitFor(() => expect(ports.download).toHaveBeenCalledOnce());
        const controls = ports.download.mock.calls[0][3] as CreateDocumentDownloadOptions;
        controls.onPdfProgress!({phase: 'rendering', completedPages: 1, totalPages: 4}); await flush();
        expect(textOf(root)).toContain('zip-progress-first.txt · document.export.pages {"completed":1,"total":4}');
        controls.onPdfProgress!({phase: 'saving', completedPages: 4, totalPages: 4}); await flush();
        expect(textOf(root)).toContain('zip-progress-first.txt · document.export.saving');
        controls.onArchiveProgress!(20.8); await flush();
        expect(textOf(root)).toContain('zip-progress-first.txt · document.export.packaging {"percent":20}');
        await fire(button('document.export.cancel'), 'click');
        controls.onPdfProgress!({phase: 'rendering', completedPages: 4, totalPages: 4});
        controls.onArchiveProgress!(99); await flush();
        expect(textOf(root)).not.toContain('"completed":4');
        expect(textOf(root)).not.toContain('"percent":99');
        late.resolve({data: 'late', fileName: 'late.txt', mimeType: 'text/plain'}); await flush();
        expect(textOf(root)).toContain('document.export.canceled');
        expect(ports.archive).not.toHaveBeenCalled();
        expect(ports.download).toHaveBeenCalledOnce();
        expect(blobs).toHaveLength(0);
        await selectFile('zip-progress-first.txt');
        expect(textarea(0).value).toBe('T:Original text.');
    });

    it('requires partial-export acknowledgement and includes reviewed subtitle bytes and unchanged timestamps', async () => {
        await importFiles(file('episode.srt', '1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n'));
        await edit(0, '第一段校订');
        const download = await downloadReady();
        const submit = button('下载双语文件', download);
        expect(submit.props.disabled).toBe(true);
        await fire(find(node => node.tag === 'input' && node.type === 'checkbox', download), 'change', {checked: true});
        await fire(button('仅译文适合直接阅读和分享', download), 'click');
        expect(button('下载译文文件', download).props.disabled).toBe(false);
        await fire(button('下载译文文件', download), 'click');
        await vi.waitFor(() => expect(blobs).toHaveLength(1));
        const content = await blobs[0].text();
        expect(content).toContain('00:00:01,000 --> 00:00:02,000\n第一段校订');
        expect(content).toContain('00:00:03,000 --> 00:00:04,000\nSecond');
        expect(content).not.toContain('\nFirst');
        expect(anchors[0].download).toBe('episode.translated.srt');
        expect(anchors[0].click).toHaveBeenCalledOnce();
        expect(download.open).toBe(false);
        await fire(button('下载文件 ↓'), 'click');
        expect(find(node => node.tag === 'input' && node.type === 'checkbox', download).checked).toBe(false);
        expect(button('下载双语文件', download).props.disabled).toBe(true);
    });

    it('preserves the translated reading choice on download and keeps the previous output choice when reading source', async () => {
        await importFiles(file('reading.txt')); await edit(0, '校订');
        await fire(button('阅读'), 'click');
        await fire(button('译文', labelled('阅读方式')), 'click');
        const download = await downloadReady();
        expect(textOf(download)).toContain('reading.translated.txt');
        expect(textOf(find(node => node.tag === 'pre', download))).toBe('校订');
        await fire(button('返回文档', download), 'click');
        await fire(button('原文', labelled('阅读方式')), 'click');
        await fire(button('下载文件 ↓'), 'click');
        expect(textOf(download)).toContain('reading.translated.txt');
        await fire(button('双语对照同时保留原文和译文', download), 'click');
        expect(textOf(find(node => node.tag === 'pre', download))).toContain('Original text.');
        expect(textOf(find(node => node.tag === 'pre', download))).toContain('校订');
    });

    it('blocks Escape during export, discards late progress and bytes after cancel, then hands off exactly one retry URL', async () => {
        await importFiles(file('cancel-export.txt')); await edit(0, 'reviewed');
        const download = await downloadReady();
        const late = deferred<DocumentDownload>({data: 'late', fileName: 'late.txt', mimeType: 'text/plain'});
        ports.download.mockReturnValueOnce(late.promise);
        await fire(button('下载双语文件', download), 'click');
        const controls = ports.download.mock.calls[0][3] as CreateDocumentDownloadOptions;
        controls.onPdfProgress!({phase: 'rendering', completedPages: 1, totalPages: 3}); await flush();
        expect(textOf(download)).toContain('document.export.pages {"completed":1,"total":3}');
        const cancelEvent = new Event('cancel', {cancelable: true});
        download.props.onCancel(cancelEvent);
        expect(cancelEvent.defaultPrevented).toBe(true);
        await fire(button('document.export.cancel', download), 'click');
        expect(controls.signal!.aborted).toBe(true);
        controls.onPdfProgress!({phase: 'saving', completedPages: 3, totalPages: 3});
        controls.onArchiveProgress!(99); await flush();
        expect(textOf(download)).not.toContain('document.export.saving');
        expect(textOf(download)).not.toContain('document.export.packaging');
        late.resolve({data: 'late', fileName: 'late.txt', mimeType: 'text/plain'}); await flush();
        expect(textOf(download)).toContain('document.export.canceled');
        expect(blobs).toHaveLength(0);
        expect(textarea(0).value).toBe('reviewed');
        const guard = beforeUnload(); win.dispatchEvent(guard);
        expect(guard.defaultPrevented).toBe(true);
        await fire(button('下载双语文件', download), 'click');
        await vi.waitFor(() => expect(anchors).toHaveLength(1));
        expect(anchors[0].click).toHaveBeenCalledOnce();
        const after = beforeUnload(); win.dispatchEvent(after);
        expect(after.defaultPrevented).toBe(false);
        apps.pop()!.unmount(); await flush();
        expect(revoked).toEqual(['blob:actions-1']);
    });

    it.each([new Error('encode failed'), 'encode failed'])('renders export rejection %s and clears it on retry', async error => {
        await importFiles(file('export-error.txt')); await edit(0, 'reviewed');
        const download = await downloadReady();
        ports.download.mockRejectedValueOnce(error);
        await fire(button('下载双语文件', download), 'click');
        expect(textOf(download)).toContain('encode failed');
        expect(download.open).toBe(true);
        expect(blobs).toHaveLength(0);
        await fire(button('下载双语文件', download), 'click');
        await vi.waitFor(() => expect(blobs).toHaveLength(1));
        expect(textOf(download)).not.toContain('encode failed');
    });

    it('revokes a failed anchor handoff once and permits a later successful handoff', async () => {
        await importFiles(file('anchor.txt')); await edit(0, 'reviewed');
        const download = await downloadReady();
        const createAnchor = (window as any).document.createElement;
        (window as any).document.createElement = () => ({click: () => {throw new Error('download blocked');}});
        await fire(button('下载双语文件', download), 'click');
        await vi.waitFor(() => expect(textOf(download)).toContain('download blocked'));
        expect(revoked).toEqual(['blob:actions-1']);
        const before = beforeUnload(); win.dispatchEvent(before);
        expect(before.defaultPrevented).toBe(true);
        (window as any).document.createElement = createAnchor;
        await fire(button('下载双语文件', download), 'click');
        await vi.waitFor(() => expect(anchors).toHaveLength(1));
        apps.pop()!.unmount(); await flush();
        expect(revoked).toEqual(['blob:actions-1', 'blob:actions-2']);
    });

    it('releases the handed-off URL at its timeout and does not revoke it again on unmount', async () => {
        await importFiles(file('url.txt')); await edit(0, 'reviewed');
        const download = await downloadReady();
        vi.useFakeTimers();
        ports.download.mockResolvedValueOnce({data: 'reviewed', fileName: 'url.txt', mimeType: 'text/plain'});
        await fire(button('下载双语文件', download), 'click');
        expect(anchors[0].click).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(999);
        expect(revoked).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(revoked).toEqual(['blob:actions-1']);
        apps.pop()!.unmount(); await flush();
        expect(revoked).toEqual(['blob:actions-1']);
    });

    it('cancels ZIP encoding, ignores its late progress and retries using the real ZIP writer with separate duplicate-name entries', async () => {
        await importFiles(file('same.txt', 'First'), file('same.txt', 'Second'));
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":2}'));
        await fire(button('document.batch.queue · 2+'), 'click');
        const late = deferred<Uint8Array>(new Uint8Array([1])); ports.archive.mockReturnValueOnce(late.promise);
        await fire(button('document.batch.zip'), 'click');
        await vi.waitFor(() => expect(ports.archive).toHaveBeenCalledOnce());
        const controls = ports.archive.mock.calls[0][2];
        controls.onProgress(25.8); await flush();
        expect(textOf(root)).toContain('document.export.packaging {"percent":25}');
        await fire(button('document.export.cancel'), 'click');
        controls.onProgress(99.9); await flush();
        expect(textOf(root)).not.toContain('"percent":99');
        late.resolve(new Uint8Array([1])); await flush();
        expect(textOf(root)).toContain('document.export.canceled');
        expect(blobs).toHaveLength(0);
        const guard = beforeUnload(); win.dispatchEvent(guard);
        expect(guard.defaultPrevented).toBe(true);
        await fire(button('document.batch.zip'), 'click');
        await vi.waitFor(() => expect(blobs).toHaveLength(1));
        expect(anchors[0].download).toBe('FluentRead-documents.zip');
        const zip = await JSZip.loadAsync(await blobs[0].arrayBuffer());
        expect(await zip.file('1/same.bilingual.txt')!.async('string')).toContain('T:First');
        expect(await zip.file('2/same.bilingual.txt')!.async('string')).toContain('T:Second');
        const after = beforeUnload(); win.dispatchEvent(after);
        expect(after.defaultPrevented).toBe(false);
        expect(anchors[0].click).toHaveBeenCalledOnce();
    });

    it('renders per-file ZIP export failure and permits a retry without changing either document', async () => {
        await importFiles(file('zip-first.txt'), file('zip-second.txt'));
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":2}'));
        await fire(button('document.batch.queue · 2+'), 'click');
        ports.download.mockRejectedValueOnce(new Error('file encode failed'));
        await fire(button('document.batch.zip'), 'click');
        expect(textOf(root)).toContain('document.batch.downloadFailed {"error":"file encode failed"}');
        expect(blobs).toHaveLength(0);
        await fire(labelled('document.batch.output'), 'change', {value: 'translated'});
        await fire(button('document.batch.zip'), 'click');
        await vi.waitFor(() => expect(blobs).toHaveLength(1));
        const zip = await JSZip.loadAsync(await blobs[0].arrayBuffer());
        expect(await zip.file('1/zip-first.translated.txt')!.async('string')).toBe('T:Original text.');
        await selectFile('zip-first.txt');
        expect(textarea(0).value).toBe('T:Original text.');
    });
});

describe('document user actions: real editor events and parent consumers', () => {
    it('clamps a pending-only last page after its focused final row is translated and blurred', async () => {
        await importFiles(file('clamp.json', JSON.stringify(Array.from({length: 41}, (_, i) => `Source ${i}`))));
        await fire(button('校订译文'), 'click');
        await fire(pendingFilter(), 'change', {checked: true});
        await fire(button('下一页', labelled('校订分页')), 'click');
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        const final = textarea(40);
        await fire(final, 'focus'); await fire(final, 'input', {value: 'Reviewed final row'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        await fire(final, 'blur');
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(40);
        expect(walk(editor()).some(node => node.props['aria-label'] === '校订分页')).toBe(false);
        expect(walk(editor()).find(node => node.props['data-segment-id'] === 0)).toBeTruthy();
        expect(textOf(editor())).toContain('40 个片段');
        await fire(pendingFilter(), 'change', {checked: false});
        await fire(button('下一页', labelled('校订分页')), 'click');
        expect(textarea(40).value).toBe('Reviewed final row');
    });

    it('pages all 81 JSON strings, resets page on search, searches paths and translation, and clamps after pending edits', async () => {
        await importFiles(file('large.json', JSON.stringify(Object.fromEntries(Array.from({length: 81}, (_, i) => [`key${i}`, `Source ${i}`])))));
        await fire(button('校订译文'), 'click');
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(40);
        expect(button('上一页', labelled('校订分页')).props.disabled).toBe(true);
        await fire(button('下一页', labelled('校订分页')), 'click');
        expect(textarea(40).value).toBe('');
        await fire(labelled('校订页码'), 'change', {value: 3});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        expect(button('下一页', labelled('校订分页')).props.disabled).toBe(true);
        await fire(search(), 'input', {value: 'key7'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(11);
        expect(walk(editor()).some(node => node.props['aria-label'] === '校订分页')).toBe(false);
        await fire(search(), 'input', {value: 'Source 80'});
        await fire(textarea(80), 'focus');
        await fire(textarea(80), 'input', {value: 'Unique reviewed text'});
        await fire(textarea(80), 'blur');
        await fire(search(), 'input', {value: 'unique REVIEWED'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        expect(textarea(80).value).toBe('Unique reviewed text');
        await fire(pendingFilter(), 'change', {checked: true});
        expect(textOf(editor())).toContain('没有找到匹配内容');
        await fire(search(), 'input', {value: ''});
        expect(textOf(editor())).toContain('80 个片段');
        await fire(labelled('校订页码'), 'change', {value: 2});
        expect(textOf(labelled('校订分页'))).toContain('第 2 / 2 页');
        await fire(button('上一页', labelled('校订分页')), 'click');
        expect(textOf(labelled('校订分页'))).toContain('第 1 / 2 页');
    });

    it('keeps the focused row during pending-only edits until blur, then shows the all-translated message', async () => {
        await importFiles(file('focus.txt', 'First\n\nSecond'));
        await edit(0, 'First reviewed');
        await fire(pendingFilter(), 'change', {checked: true});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        const active = textarea(1);
        await fire(active, 'focus'); await fire(active, 'input', {value: 'Second reviewed'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        await fire(active, 'blur');
        expect(textOf(editor())).toContain('所有片段都已有译文。');
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(0);
        expect(textOf(taskbar())).toContain('翻译完成');
        await fire(button('阅读'), 'click');
        const download = await downloadReady();
        expect(textOf(find(node => node.tag === 'pre', download))).toContain('Second reviewed');
    });

    it('clears search, pending filter, page and editing focus on parent document switch, then restores only the first file translations', async () => {
        await importFiles(file('editor-first.json', JSON.stringify({one: 'First', two: 'Second'})), file('editor-second.json', JSON.stringify({one: 'First', two: 'Other'})));
        await edit(0, 'Saved first');
        await fire(search(), 'input', {value: 'Second'});
        await fire(pendingFilter(), 'change', {checked: true});
        await fire(textarea(1), 'focus');
        await selectFile('editor-second.json');
        expect(search().value).toBe('');
        expect(pendingFilter().checked).toBe(false);
        await fire(button('校订译文'), 'click');
        await fire(search(), 'input', {value: 'First'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        await selectFile('editor-first.json');
        expect(textarea(0).value).toBe('Saved first');
        expect(textarea(1).value).toBe('');
    });

    it('clears focused identity when a standalone real editor receives a new document with reused segment IDs', async () => {
        apps.pop()!.unmount();
        const current = ref<ParsedDocument>(parseDocument('first.txt', 'Match\n\nOther'));
        mount({setup: () => () => h(DocumentSegmentEditor, {document: current.value, translations: [], disabled: false})});
        await fire(textarea(1), 'focus');
        await fire(search(), 'input', {value: 'Match'});
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(2);
        current.value = parseDocument('second.txt', 'Match\n\nDifferent'); await flush();
        expect(walk(editor()).filter(node => node.tag === 'textarea')).toHaveLength(1);
        expect(walk(editor()).find(node => node.props['data-segment-id'] === 1)).toBeUndefined();
    });

    it('shows the original wording for whole-sentence segments and explains the markers only where a translation carries them', async () => {
        apps.pop()!.unmount();
        const current = parseDocument('note.md', 'Read the [setup guide](https://example.com/setup) first.\n\nPlain sentence.', {markdownSentences: true});
        expect(current.segments[0].source).toBe('Read the <g1>setup guide</g1> first.');
        mount({setup: () => () => h(DocumentSegmentEditor, {document: current, translations: ['先读<g1>安装指南</g1>。', '普通句子。'], disabled: false})});
        const nodes = () => walk(editor());
        const sourceTexts = nodes().filter(node => node.props.class === 'document-source').map(node => walk(node).map(child => child.text ?? '').join(''));
        expect(sourceTexts).toEqual(['Read the setup guide first.', 'Plain sentence.']);
        expect(textarea(0).value).toBe('先读<g1>安装指南</g1>。');
        expect(nodes().filter(node => node.props.class === 'segment-placeholder-hint')).toHaveLength(1);
    });

    it('says so when the finished translation is the same as the original, but not for short files or real translations', async () => {
        const lines = ['第一行已经是中文。', '第二行也是中文。', '第三行还是中文。', '第四行同样是中文。', '第五行仍然是中文。', '第六行是中文。'];
        // 服务把每一段都原样返回：文档多半已经是目标语言。
        ports.batch.mockImplementation(async (sources: string[]) => sources);
        await importFiles(file('same.txt', lines.join('\n\n')));
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(textOf(taskbar())).toContain('译文与原文相同，可换目标语言'));
        // 片段很少时不下这个判断。
        await importFiles(file('short.txt', lines.slice(0, 2).join('\n\n')));
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(textOf(taskbar())).toContain('翻译完成'));
        expect(textOf(taskbar())).not.toContain('译文与原文相同');
        // 大部分片段有了不同的译文时照常显示完成。
        ports.batch.mockImplementation(async (sources: string[]) => sources.map(source => `T:${source}`));
        await importFiles(file('real.txt', lines.join('\n\n')));
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(textOf(taskbar())).toContain('翻译完成'));
        expect(textOf(taskbar())).not.toContain('译文与原文相同');
    });

    it('disables editing while translating and enables it after an external global pause with no late result commit', async () => {
        await importFiles(file('editor-busy.txt'));
        const late = deferred<string[]>(['late']); ports.batch.mockReturnValueOnce(late.promise);
        await fire(translateButton(), 'click');
        await fire(button('校订译文'), 'click');
        expect(textarea(0).props.disabled).toBe(true);
        expect(textOf(editor())).toContain('暂停后即可校订');
        broadcast({on: false}); await flush();
        expect(ports.batch.mock.calls[0][2].signal.aborted).toBe(true);
        expect(textarea(0).props.disabled).toBe(false);
        await fire(textarea(0), 'input', {value: 'manual after pause'});
        late.resolve(['late']); await flush();
        expect(textarea(0).value).toBe('manual after pause');
    });

    it('paginates subtitle reading independently from editor search and returns to page one on document switch', async () => {
        const subtitles = Array.from({length: 81}, (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:02,000\nCaption ${i}`).join('\n\n');
        await importFiles(file('long.srt', subtitles), file('short.srt', '1\n00:00:01,000 --> 00:00:02,000\nShort'));
        const pagination = labelled('文档阅读分页');
        await fire(button('下一页', pagination), 'click');
        expect(textOf(labelled('字幕时间轴翻译表格'))).toContain('Caption 80');
        expect(textOf(labelled('字幕时间轴翻译表格'))).not.toContain('Caption 0');
        await fire(button('上一页', pagination), 'click');
        expect(textOf(labelled('字幕时间轴翻译表格'))).toContain('Caption 0');
        await fire(button('下一页', pagination), 'click');
        await selectFile('short.srt'); await selectFile('long.srt');
        expect(textOf(labelled('文档阅读分页'))).toContain('第 1 / 2 页');
    });
});

describe('document user actions: confirmation and task consumers', () => {
    it('opens the actual file-input port from landing and add-file actions while preserving the selected document', async () => {
        const input = find(node => node.tag === 'input' && node.type === 'file');
        await fire(button('选择文件'), 'click');
        expect(input.click).toHaveBeenCalledOnce();
        await importFiles(file('picked-first.txt'));
        await fire(button('添加文件'), 'click');
        expect(input.click).toHaveBeenCalledTimes(2);
        await fire(input, 'change', {files: [file('picked-second.txt')], value: 'fake-path'});
        expect(input.value).toBe('');
        await vi.waitFor(() => expect(textOf(root)).toContain('picked-second.txt'));
        // 新添加的文件立即成为当前文档；先前的文件留在侧栏文件列表里，可以随时切回。
        expect(textOf(taskbar())).toContain('picked-second.txt');
        expect(textOf(taskbar())).not.toContain('picked-first.txt');
        await selectFile('picked-first.txt');
        expect(textOf(taskbar())).toContain('picked-first.txt');
    });

    it('continues the queue after a file fails and retries only that file through the batch action', async () => {
        await importFiles(file('failed.txt'), file('succeeded.txt'));
        ports.batch.mockRejectedValueOnce(new Error('offline'));
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":1}'));
        expect(ports.batch.mock.calls.map(call => call[1])).toEqual(['failed.txt', 'succeeded.txt']);
        await selectFile('failed.txt');
        expect(textOf(taskbar())).toContain('翻译中断');
        expect(textOf(taskbar())).toContain('offline');
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":2}'));
        expect(ports.batch.mock.calls.map(call => call[1])).toEqual(['failed.txt', 'succeeded.txt', 'failed.txt']);
        expect(textOf(taskbar())).not.toContain('offline');
        await selectFile('succeeded.txt');
        expect(textarea(0).value).toBe('T:Original text.');
    });

    it('protects a partial reviewed file from batch retranslation after a language change', async () => {
        await importFiles(file('partial.txt', 'First\n\nSecond'), file('pending.txt'));
        await edit(0, 'reviewed first');
        await fire(labelled('文档目标语言'), 'change', {value: 'fr'});
        await fire(button('document.batch.start'), 'click');
        expect(textOf(root)).toContain('document.batch.settingsChanged');
        expect(ports.batch).not.toHaveBeenCalled();
        expect(textarea(0).value).toBe('reviewed first');
        await selectFile('pending.txt');
        expect(textarea(0).value).toBe('');
    });

    it('imports via real drag events, reports an unsupported queue entry and removes it without harming the valid file', async () => {
        const zone = labelled('文档拖放区域');
        await fire(zone, 'dragover');
        expect(String(zone.props.class)).toContain('dragging');
        await fire(zone, 'dragleave');
        expect(String(zone.props.class)).not.toContain('dragging');
        const drop = new Event('drop', {cancelable: true});
        Object.defineProperty(drop, 'dataTransfer', {value: {files: [file('invalid.exe'), file('valid.txt')]}});
        zone.props.onDrop(drop); await flush();
        await vi.waitFor(() => expect(textOf(root)).toContain('valid.txt'));
        expect(drop.defaultPrevented).toBe(true);
        expect(textOf(root)).toContain('暂不支持该文件格式');
        await fire(labelled('document.batch.remove invalid.exe'), 'click');
        expect(textOf(root)).not.toContain('invalid.exe');
        expect(textOf(taskbar())).toContain('valid.txt');
        expect(translateButton().props.disabled).toBe(false);
    });

    it('cancels removal, then confirms the new target without removing the old edited file', async () => {
        await importFiles(file('first.txt'), file('second.txt'));
        await edit(0, 'first reviewed');
        await fire(labelled('document.batch.remove first.txt'), 'click');
        const confirmation = dialog('confirm-document-heading');
        expect(confirmation.open).toBe(true);
        await fire(button('返回文档', confirmation), 'click');
        expect(confirmation.open).toBe(false);
        await selectFile('second.txt'); await edit(0, 'second reviewed');
        await fire(labelled('document.batch.remove second.txt'), 'click');
        await fire(button('document.batch.remove', confirmation), 'click');
        expect(textOf(root)).not.toContain('second.txt');
        expect(textarea(0).value).toBe('first reviewed');
    });

    it('closes a reset confirmation without discarding work, then accepts reset through the real settings dialog', async () => {
        await importFiles(file('reset.txt')); await edit(0, 'keep until confirmed');
        await fire(labelled('调整文档翻译设置'), 'click');
        await fire(button('更换文件', dialog('document-settings-heading')), 'click');
        const confirmation = dialog('confirm-document-heading');
        await fire(button('返回文档', confirmation), 'click');
        expect(textarea(0).value).toBe('keep until confirmed');
        await fire(labelled('调整文档翻译设置'), 'click');
        await fire(button('更换文件', dialog('document-settings-heading')), 'click');
        await fire(button('打开新文件', confirmation), 'click');
        expect(textOf(root)).toContain('把文件拖到这里');
        expect(walk(root).some(node => node.tag === 'textarea')).toBe(false);
        await importFiles(file('new.txt'));
        expect(textarea(0).value).toBe('');
    });

    it('restarts only after accepting the settings confirmation and replaces the reviewed result with the new language', async () => {
        await importFiles(file('restart.txt')); await edit(0, 'reviewed');
        await fire(labelled('文档目标语言'), 'change', {value: 'fr'});
        await fire(translateButton(), 'click');
        const confirmation = dialog('confirm-document-heading');
        expect(ports.batch).not.toHaveBeenCalled();
        await fire(button('返回文档', confirmation), 'click');
        expect(textarea(0).value).toBe('reviewed');
        await fire(translateButton(), 'click');
        await fire(button('重新翻译', confirmation), 'click');
        expect(ports.batch).toHaveBeenCalledWith(['Original text.'], 'restart.txt', expect.objectContaining({targetLanguage: 'fr'}));
        expect(textarea(0).value).toBe('T:Original text.');
        expect(textOf(taskbar())).toContain('翻译完成');
    });

    it('pauses a single document after one real batch, rejects late completion and resumes only unfinished segments', async () => {
        const content = Array.from({length: 18}, (_, i) => `Paragraph ${i}`).join('\n\n');
        await importFiles(file('resume.txt', content));
        const late = deferred<string[]>(['late 16', 'late 17']);
        // 一批 16 段完成并保留，余下两段在暂停之后才返回。
        ports.batch.mockResolvedValueOnce(Array.from({length: 16}, (_, i) => `kept ${i}`)).mockReturnValueOnce(late.promise);
        await fire(translateButton(), 'click');
        expect(ports.batch).toHaveBeenCalledTimes(2);
        expect(ports.batch.mock.calls.map(call => call[0].length)).toEqual([16, 2]);
        expect(labelled('文档翻译进度').props['aria-valuenow']).toBe(88);
        await fire(button('暂停翻译'), 'click');
        const signal = ports.batch.mock.calls[1][2].signal;
        expect(signal.aborted).toBe(true);
        late.resolve(['late 16', 'late 17']); await flush();
        expect(textOf(taskbar())).toContain('已暂停');
        expect(textarea(16).value).toBe('');
        await edit(0, 'manual kept');
        await fire(translateButton(), 'click');
        expect(ports.batch.mock.calls.at(-1)![0]).toEqual(['Paragraph 16', 'Paragraph 17']);
        expect(textarea(0).value).toBe('manual kept');
        expect(labelled('文档翻译进度').props['aria-valuenow']).toBe(100);
    });

    it('renders a retryable service failure and retries the actual missing document segment', async () => {
        await importFiles(file('retry.txt'));
        ports.batch.mockRejectedValueOnce(new Error('provider offline'));
        await fire(translateButton(), 'click');
        expect(textOf(taskbar())).toContain('第 1 段文档翻译失败：provider offline');
        expect(textOf(translateButton())).toBe('重试翻译');
        await fire(translateButton(), 'click');
        expect(textOf(taskbar())).toContain('翻译完成');
        expect(textOf(taskbar())).not.toContain('provider offline');
        expect(ports.batch).toHaveBeenCalledTimes(2);
    });

    it('waits and retries by itself when the service is briefly unavailable, showing why, and only stops with the reason once the budget is spent', async () => {
        let release: (() => void) | undefined; const waits: number[] = [];
        Object.assign(documentRetryBackoff, {maxWaitMs: 120_000, sleep: (milliseconds: number) => new Promise<void>(resolve => {waits.push(milliseconds); release = resolve;})});
        await importFiles(file('busy.txt'));
        ports.batch.mockRejectedValueOnce(new Error('429 rate limited'));
        await fire(translateButton(), 'click');
        // 没有点击任何按钮：页面仍在翻译，并说明正在等待重试及原因。
        await vi.waitFor(() => expect(textOf(taskbar())).toContain('429 rate limited'));
        expect(textOf(taskbar())).toContain('翻译服务暂时没有响应，将自动重试'); expect(textOf(taskbar())).toContain('2s'); expect(textOf(taskbar())).toContain('正在翻译');
        expect(waits).toEqual([2000]); expect(ports.batch).toHaveBeenCalledTimes(1);
        release!(); await vi.waitFor(() => expect(textOf(taskbar())).toContain('翻译完成'));
        expect(ports.batch).toHaveBeenCalledTimes(2); expect(textOf(taskbar())).not.toContain('429 rate limited');
        // 预算用尽后停下，并给出最后一次失败的原因。
        Object.assign(documentRetryBackoff, {maxWaitMs: 6000, sleep: async (milliseconds: number) => {waits.push(milliseconds);}});
        await importFiles(file('down.txt'));
        ports.batch.mockReset().mockRejectedValue(new Error('service unavailable'));
        await fire(translateButton(), 'click');
        await vi.waitFor(() => expect(textOf(taskbar())).toContain('第 1 段文档翻译失败：service unavailable'));
        expect(waits.slice(1)).toEqual([2000, 4000]); expect(textOf(taskbar())).toContain('翻译中断'); expect(textOf(taskbar())).not.toContain('将自动重试');
    });

    it('turns a typed disabled-service result into pause before the configuration broadcast arrives', async () => {
        await importFiles(file('disabled.txt'));
        ports.batch.mockRejectedValueOnce(new TranslationRequestError(serializeTranslationError({
            code: 'TRANSLATION_DISABLED', message: 'paused remotely', retryable: false,
        })));
        await fire(translateButton(), 'click');
        expect(textOf(taskbar())).toContain('已暂停');
        expect(textOf(taskbar())).not.toContain('翻译失败');
        broadcast({on: false}); await flush();
        expect(translateButton().props.disabled).toBe(true);
    });

    it('preserves each file status through queue pause, switching and a real resume', async () => {
        await importFiles(file('queue-first.txt'), file('queue-second.txt'));
        await fire(button('document.batch.queue · 2+'), 'click');
        const pending = deferred<string[]>(['late']); ports.batch.mockReturnValueOnce(pending.promise);
        await fire(button('document.batch.start'), 'click');
        expect(labelled('document.batch.remove queue-first.txt').props.disabled).toBe(true);
        await fire(button('document.batch.pause'), 'click');
        await selectFile('queue-second.txt');
        pending.resolve(['late']); await flush();
        expect(textarea(0).value).toBe('');
        await selectFile('queue-first.txt');
        expect(textOf(taskbar())).toContain('已暂停');
        await fire(button('document.batch.start'), 'click');
        await vi.waitFor(() => expect(textOf(root)).toContain('document.batch.completed {"count":2}'));
        await selectFile('queue-first.txt');
        expect(textOf(taskbar())).toContain('翻译完成');
        expect(textarea(0).value).toBe('T:Original text.');
        expect(ports.batch).toHaveBeenCalledTimes(3);
    });

    it('finishes the in-flight file with its settings snapshot and stops the queue on an external language change', async () => {
        await importFiles(file('snapshot-first.txt'), file('snapshot-second.txt'));
        const pending = deferred<string[]>(['first snapshot']); ports.batch.mockReturnValueOnce(pending.promise);
        await fire(button('document.batch.start'), 'click');
        const language = ports.batch.mock.calls[0][2].targetLanguage;
        broadcast({to: 'fr'}); await flush(); pending.resolve(['first snapshot']); await flush();
        expect(textOf(root)).toContain('document.batch.externalSettings');
        expect(ports.batch).toHaveBeenCalledOnce();
        expect(language).not.toBe('fr');
        expect(textarea(0).value).toBe('first snapshot');
        await selectFile('snapshot-second.txt');
        expect(textOf(taskbar())).toContain('准备就绪');
        await fire(translateButton(), 'click');
        expect(ports.batch.mock.calls.at(-1)![2].targetLanguage).toBe('fr');
    });
});
