import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Both Vitest configurations compile these SFC imports as client templates.
// All three target SFCs execute their actual client templates via Vue runtime-dom.
// Controlled ports: DOM events, Element Plus public controls, i18n labels, PDF.js.
// No target setupState, private exports, extracted script, VM, or copied business logic.
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent'];
    const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {
        configurable: true, get() {return this.constructor.name;},
    });
    for (const name of names) {
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: (window as any)[name]});
    }
    // PDF import only needs the extension asset origin; no worker or HTTP is used.
    Object.defineProperty(globalThis, 'window', {configurable: true, writable: true,
        value: {document, location: {origin: 'chrome-extension://final-coverage-A'}}});
    // linkedom's select.value is getter-only; the native select port needs writes.
    const values = new WeakMap<object, string>();
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() {return values.get(this) ?? '';},
        set(value: string) {values.set(this, String(value));},
    });
    return {document: document as unknown as Document, window, originals};
});
const ports = vi.hoisted(() => ({tooltips: [] as any[], getPdfDocument: vi.fn()}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({
    translateLegacy: (value: string) => value,
    t: (key: string, values?: Record<string, unknown>) => key + (values ? JSON.stringify(values) : ''),
})}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', async () => {
    const {defineComponent, h, Teleport} = await import('vue');
    const ElOption = defineComponent({props: ['value', 'label'],
        setup: props => () => h('option', {value: props.value}, props.label)});
    const ElSelect = defineComponent({inheritAttrs: false, props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        setup(props, {attrs, slots, emit, expose}) {
            expose({focus: vi.fn(), blur: vi.fn()});
            return () => h('select', {...attrs, value: props.modelValue, disabled: props.disabled,
                onChange: (event: Event) => emit('update:modelValue', Number((event.target as HTMLSelectElement).value))},
            slots.default?.());
        },
    });
    // Stub only the library's documented instance methods and hide event.
    // FieldHelp's focus/hover/blur/Escape logic and its content slot stay real.
    const ElTooltip = defineComponent({
        props: ['content', 'teleported', 'trigger', 'showAfter', 'hideAfter', 'enterable', 'placement', 'popperClass'],
        emits: ['hide'],
        setup(props, {slots, expose, emit}) {
            const onOpen = vi.fn(), onClose = vi.fn(), hide = vi.fn(() => emit('hide'));
            ports.tooltips.push({props, onOpen, onClose, hide});
            expose({onOpen, onClose, hide});
            return () => h('div', {'data-tooltip-port': ''}, [slots.default?.(),
                h(Teleport, {to: dom.document.body, disabled: !props.teleported},
                    h('aside', {class: props.popperClass}, slots.content?.())),
            ]);
        },
    });
    return {ClickOutside: {}, ElOption, ElSelect, ElTooltip};
});
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: ports.getPdfDocument}));

import {createApp, h, markRaw, nextTick, reactive, type App, type Component} from 'vue';
import {PDFDocument} from 'pdf-lib';
import DocumentSegmentEditor from '@/src/app/document-translation/DocumentSegmentEditor.vue';
import FieldHelp from '@/src/features/settings/ui/components/FieldHelp.vue';
import PopupLayoutPreviewItem from '@/src/features/settings/ui/components/PopupLayoutPreviewItem.vue';
import {usePopupLayoutReorder} from '@/src/features/settings/ui/usePopupLayoutReorder';
import {parseDocument} from '@/src/features/document-translation/core/document';
import {createDocumentDownload, parseBinaryDocument, type PdfPageRasterizer} from '@/src/features/document-translation/services/binary';
import {
    AREA_CANCEL_MESSAGE_TYPE, AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
    createAreaTranslationBackgroundHandlers,
} from '@/src/features/area-translation/background/handlers';
import type {ImageOperationOptions} from '@/src/features/image-translation/protocol';
import {edgeTtsLimits, splitEdgeTtsText} from '@/src/features/selection-translation/services/edgeTtsPolicy';

const apps = new Set<App>();
async function settle() {await nextTick(); await nextTick();}
async function mount(component: Component, initial: Record<string, any>, listeners: Record<string, unknown> = {},
    slots?: Record<string, () => ReturnType<typeof h>>) {
    const root = dom.document.createElement('div'); dom.document.body.append(root);
    const props = reactive(initial);
    const app = createApp({setup: () => () => h(component, {...props, ...listeners}, slots)});
    apps.add(app); app.mount(root); await settle();
    return {root, props};
}
function event(target: Element, type: string, fields: Record<string, unknown> = {}) {
    const value = new dom.window.Event(type, {bubbles: true, cancelable: true});
    Object.assign(value, {_vts: Date.now() + 1, ...fields}); target.dispatchEvent(value);
    return value;
}
function row(root: Element, index: number): HTMLElement {
    const result = root.querySelector<HTMLElement>(`[data-segment-id="${index}"]`);
    expect(result).not.toBeNull(); return result!;
}
function textarea(root: Element, index: number): HTMLTextAreaElement {
    const result = row(root, index).querySelector<HTMLTextAreaElement>('textarea');
    expect(result).not.toBeNull(); return result!;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {resolve = yes;});
    return {promise, resolve};
}
beforeEach(() => {dom.document.body.replaceChildren(); ports.tooltips.length = 0; ports.getPdfDocument.mockReset();});
afterEach(async () => {
    for (const app of apps) app.unmount(); apps.clear(); await settle();
    dom.document.body.replaceChildren(); vi.restoreAllMocks();
});
afterAll(() => {
    for (const [name, descriptor] of dom.originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

describe('final boundary A: document editor public props and DOM emits', () => {
    it('reveals a collapsed equivalent translation and emits an exact manual correction without mutating props', async () => {
        const document = parseDocument('review.txt', 'Café');
        const translations = ['  Cafe\u0301  '], update = vi.fn();
        const before = JSON.stringify(document);
        const mounted = await mount(DocumentSegmentEditor, {document, translations, disabled: false}, {onUpdate: update});
        expect((DocumentSegmentEditor as any).render).toBeTypeOf('function');
        expect((DocumentSegmentEditor as any).ssrRender).toBeUndefined();
        expect(row(mounted.root, 0).querySelector('textarea')).toBeNull();
        const reveal = row(mounted.root, 0).querySelector<HTMLButtonElement>('button')!;
        expect(reveal.textContent).toBe('校订译文'); event(reveal, 'click'); await settle();
        const input = textarea(mounted.root, 0);
        expect(input.value).toBe(translations[0]);
        event(input, 'focus'); input.value = '  人工校订\n保留空白  '; event(input, 'input');
        event(input, 'blur'); await settle();
        expect(update.mock.calls).toEqual([[0, '  人工校订\n保留空白  ']]);
        expect(translations).toEqual(['  Cafe\u0301  ']); expect(JSON.stringify(document)).toBe(before);
        // v-for row identity and the explicitly opened editor persist on blur.
        expect(textarea(mounted.root, 0)).toBe(input);
    });

    it('renders missing, empty, whitespace and distinct results with bounded textarea rows and a real page select slot', async () => {
        const sources = ['Missing', 'Empty', 'Whitespace', 'Distinct', 'Long ' + 'x'.repeat(800),
            ...Array.from({length: 36}, (_, index) => `Other ${index}`)];
        const document = parseDocument('states.json', JSON.stringify(sources));
        const translations: string[] = new Array(sources.length);
        translations[1] = ''; translations[2] = ' \t '; translations[3] = '独立译文';
        const mounted = await mount(DocumentSegmentEditor, {document, translations, disabled: false});
        expect(mounted.root.querySelectorAll('.segment-edit-row')).toHaveLength(40);
        expect(textarea(mounted.root, 0).value).toBe(''); expect(textarea(mounted.root, 1).value).toBe('');
        expect(textarea(mounted.root, 2).value).toBe(' \t '); expect(textarea(mounted.root, 3).value).toBe('独立译文');
        expect(textarea(mounted.root, 0).getAttribute('rows')).toBe('3');
        expect(textarea(mounted.root, 4).getAttribute('rows')).toBe('12');
        expect(row(mounted.root, 0).querySelector('small')!.textContent).toBe('未翻译');
        expect(row(mounted.root, 3).querySelector('small')!.textContent).toBe('已有译文');
        const select = mounted.root.querySelector<HTMLSelectElement>('select[aria-label="校订页码"]')!;
        expect(select.querySelectorAll('option')).toHaveLength(2);
        select.value = '2'; event(select, 'change'); await settle();
        expect(mounted.root.querySelectorAll('.segment-edit-row')).toHaveLength(1);
        expect(row(mounted.root, 40).querySelector('.document-source')!.textContent).toBe('Other 35');
    });

    it('updates the editable and collapsed states as public translations become empty, missing, distinct and equivalent', async () => {
        const document = parseDocument('updates.md', '**Source**');
        const update = vi.fn();
        const mounted = await mount(DocumentSegmentEditor,
            {document, translations: ['**Source**'], disabled: false}, {onUpdate: update});
        const source = row(mounted.root, 0).querySelector('.document-source')!;
        expect(source.textContent).toBe('Source');
        expect(row(mounted.root, 0).querySelector('textarea')).toBeNull();

        mounted.props.translations[0] = '';
        await settle();
        expect(textarea(mounted.root, 0).value).toBe('');
        expect(row(mounted.root, 0).querySelector('small')!.textContent).toBe('未翻译');

        delete mounted.props.translations[0];
        await settle();
        expect(textarea(mounted.root, 0).value).toBe('');

        mounted.props.translations[0] = '**译文**';
        await settle();
        expect(textarea(mounted.root, 0).value).toBe('**译文**');
        expect(row(mounted.root, 0).querySelector('small')!.textContent).toBe('已有译文');

        mounted.props.translations[0] = '  Source  ';
        await settle();
        expect(row(mounted.root, 0).querySelector('textarea')).toBeNull();
        expect(row(mounted.root, 0).querySelector('button')!.textContent).toBe('校订译文');
        expect(row(mounted.root, 0).querySelector('.document-source')).toBe(source);
        expect(source.textContent).toBe('Source');
        expect(update).not.toHaveBeenCalled();
    });

    it('keeps collapsed edits disabled while busy and resets their expansion on a document replacement with reused IDs', async () => {
        const document = parseDocument('first.txt', 'Same');
        const mounted = await mount(DocumentSegmentEditor, {document, translations: ['Same'], disabled: true});
        let reveal = row(mounted.root, 0).querySelector<HTMLButtonElement>('button')!;
        expect(reveal.disabled).toBe(true); expect(mounted.root.textContent).toContain('暂停后即可校订');
        mounted.props.disabled = false; await settle();
        expect(reveal.disabled).toBe(false); event(reveal, 'click'); await settle();
        expect(textarea(mounted.root, 0).value).toBe('Same');
        mounted.props.disabled = true; await settle(); expect(textarea(mounted.root, 0).disabled).toBe(true);
        mounted.props.document = parseDocument('second.txt', 'Same'); mounted.props.disabled = false; await settle();
        expect(row(mounted.root, 0).querySelector('textarea')).toBeNull();
        reveal = row(mounted.root, 0).querySelector<HTMLButtonElement>('button')!;
        expect(reveal.disabled).toBe(false);
    });
});

describe('final boundary A: help focus and tooltip-content events', () => {
    it('opens on keyboard focus but does not reopen when focus returns from a descendant of the help popper', async () => {
        const mounted = await mount(FieldHelp, {content: 'Copyable help', label: 'About this field'}, {},
            {content: () => h('a', {href: '#help'}, 'Details')});
        const button = mounted.root.querySelector('button')!, tooltip = ports.tooltips[0];
        const fromOutside = dom.document.createElement('span'); dom.document.body.append(fromOutside);
        const nullFocus = event(button, 'focus', {relatedTarget: null});
        const outsideFocus = event(button, 'focus', {relatedTarget: fromOutside});
        const textFocus = event(button, 'focus', {relatedTarget: dom.document.createTextNode('outside')});
        expect(tooltip.onOpen.mock.calls).toEqual([[nullFocus], [outsideFocus], [textFocus]]);
        const link = dom.document.querySelector('.fluentread-field-help-popper a')!;
        event(button, 'focus', {relatedTarget: link});
        expect(tooltip.onOpen).toHaveBeenCalledTimes(3);
        expect(button.getAttribute('aria-label')).toBe('About this field');
        expect(tooltip.props).toMatchObject({trigger: 'hover', showAfter: 200, hideAfter: 600, enterable: true, placement: 'top'});
    });

    it('keeps content available across hovered blur, resumes closing after leave, and Escape stops propagation and resets hover via hide', async () => {
        const mounted = await mount(FieldHelp, {content: 'Copyable help', placement: 'bottom-end'});
        const button = mounted.root.querySelector('button')!, tooltip = ports.tooltips[0];
        expect(tooltip.props.placement).toBe('bottom-end');
        const content = dom.document.querySelector('.fluentread-field-help-popper > div')!;
        const bubbled = vi.fn(); mounted.root.addEventListener('keydown', bubbled);
        event(content, 'mouseenter'); event(button, 'blur'); expect(tooltip.onClose).not.toHaveBeenCalled();
        event(content, 'mouseleave'); event(button, 'blur'); expect(tooltip.onClose).toHaveBeenCalledOnce();
        event(content, 'mouseenter'); event(button, 'keydown', {key: 'Escape'});
        expect(tooltip.hide).toHaveBeenCalledOnce(); expect(bubbled).not.toHaveBeenCalled();
        // The library's documented hide event clears the real parent's hover state.
        event(button, 'blur'); expect(tooltip.onClose).toHaveBeenCalledTimes(2);
    });
});

describe('final boundary A: preview Escape respects editing ownership', () => {
    it.each(['disabled', 'controller-removed'] as const)('lets Escape bubble without finishing another drag when %s', async state => {
        const update = vi.fn();
        const controller = usePopupLayoutReorder({order: () => ['a', 'b'], visibleIds: () => ['a', 'b'], onUpdate: update});
        const mounted = await mount(PopupLayoutPreviewItem, {
            item: {id: 'a', label: 'Alpha'}, editable: true, controller: markRaw(controller),
        });
        const item = mounted.root.firstElementChild!;
        event(item, 'dragstart'); expect(controller.draggedItem.value).toBe('a');
        if (state === 'disabled') mounted.props.editable = false;
        else mounted.props.controller = undefined;
        await settle();
        const bubbled = vi.fn(); mounted.root.addEventListener('keydown', bubbled);
        event(item, 'keydown', {key: 'Escape'});
        expect(bubbled).toHaveBeenCalledOnce(); expect(controller.draggedItem.value).toBe('a');
        expect(item.querySelector('.layout-preview-drag-handle')).toBeNull(); expect(update).not.toHaveBeenCalled();
        controller.finish();
    });
});

describe('final boundary A: async area route progress through the public handler', () => {
    const selection = {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100};
    it.each([false, true])('publishes recognizing before the capability port settles; cancelled=%s', async cancelled => {
        const route = deferred<{mode: 'vision'}>(), started = deferred<ImageOperationOptions>();
        const progress: string[] = [], order: string[] = [];
        const languages = vi.fn(async () => undefined), ocr = vi.fn(async () => ({image: 'ocr', lines: []}));
        const vision = vi.fn(async () => {order.push('vision'); return {image: 'vision', lines: [], recognitionMethod: 'vision'};});
        const [, translate, cancel] = createAreaTranslationBackgroundHandlers({
            captureVisibleTab: async () => '', getDefaultSourceLanguage: () => 'en',
            assertLanguagesDownloaded: languages, translateArea: ocr,
            prepareVisionTranslation: () => vision,
            prepareVisionRoute: () => options => {order.push('route'); started.resolve(options); return route.promise;},
            sendProgress: async (_context, message) => {progress.push(message.stage); order.push(message.stage);},
        });
        const requestId = `final-A-route-${cancelled}`;
        const job = translate.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, requestId,
            timeoutMs: 5_000, image: 'data:image/png,fixture', selection}, {});
        // Attach a rejection consumer before cancellation; release every port in finally.
        const outcome = job.then(value => ({value}), error => ({error}));
        try {
            const options = await started.promise;
            expect(order).toEqual(['recognizing', 'route']); expect(progress).toEqual(['recognizing']);
            expect(vision).not.toHaveBeenCalled(); expect(ocr).not.toHaveBeenCalled();
            if (cancelled) {
                await expect(cancel.handle({type: AREA_CANCEL_MESSAGE_TYPE, requestId}, {}))
                    .resolves.toEqual({success: true, cancelled: true, requestId});
                expect(options.signal.aborted).toBe(true);
            }
            route.resolve({mode: 'vision'});
            const result = await outcome;
            if (cancelled) {expect(result).toMatchObject({error: {name: 'AbortError'}}); expect(vision).not.toHaveBeenCalled();}
            else {expect(result).toMatchObject({value: {success: true, recognitionMethod: 'vision'}}); expect(vision).toHaveBeenCalledOnce();}
            expect(languages).not.toHaveBeenCalled(); expect(ocr).not.toHaveBeenCalled();
            expect(progress).toEqual(['recognizing']);
        } finally {route.resolve({mode: 'vision'}); await outcome; await Promise.resolve();}
    });
});

describe('final boundary A: two-byte UTF-8 speech budgets', () => {
    it.each([1798, 1799])('keeps U+00E9 intact after %s ASCII bytes and reconstructs every code point', asciiBytes => {
        const prefix = 'a'.repeat(asciiBytes), text = prefix + 'éz';
        const chunks = splitEdgeTtsText(text);
        expect(chunks).toEqual(asciiBytes === 1798 ? [prefix + 'é', 'z'] : [prefix, 'éz']);
        expect(chunks.join('')).toBe(text);
        for (const chunk of chunks) {
            const encoded = new TextEncoder().encode(chunk);
            expect(encoded.byteLength).toBeLessThanOrEqual(edgeTtsLimits.chunkBytes);
            expect(new TextDecoder().decode(encoded)).toBe(chunk);
        }
    });
});

it('reports the unchanged source page before a changed PDF page, preserves order, and rasterizes only the changed page', async () => {
    // Real PDF source/output with an ordinary external PDF.js text-extraction port.
    // No mutated ParsedDocument, out-of-range IDs, synthetic private renderer or SDK internals.
    const texts = ['Same first page', 'Second page'];
    const pdf = await PDFDocument.create();
    for (const text of texts) pdf.addPage([400, 600]).drawText(text);
    const sourceBytes = await pdf.save(), destroy = vi.fn(async () => undefined), cleanups: Array<ReturnType<typeof vi.fn>> = [];
    ports.getPdfDocument.mockImplementation(() => ({
        promise: Promise.resolve({numPages: 2, getPage: async (pageNumber: number) => {
            const cleanup = vi.fn(); cleanups.push(cleanup);
            return {cleanup, getViewport: () => ({width: 400, height: 600, transform: [1, 0, 0, 1, 0, 0]}),
                getTextContent: async () => ({items: [{str: texts[pageNumber - 1], dir: 'ltr',
                    transform: [1, 0, 0, 12, 10, 50], width: 120, height: 12, fontName: 'body', hasEOL: true}], styles: {}})};
        }}), destroy,
    }));
    const parsed = await parseBinaryDocument('mixed.pdf', sourceBytes);
    expect(parsed.segments.map(segment => segment.source)).toEqual(texts);
    expect(destroy).toHaveBeenCalledOnce(); for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
    const before = JSON.stringify(parsed), translations = [' Same first page ', '第二页'];
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
    const rasterize = vi.fn<PdfPageRasterizer>(async () => png);
    const progress: Array<{phase: string; completedPages: number; totalPages: number}> = [];
    const download = await createDocumentDownload(parsed, translations, 'bilingual', {
        pdfPageRasterizer: rasterize, onPdfProgress: value => progress.push(value),
    });
    expect(progress).toEqual([
        {phase: 'rendering', completedPages: 0, totalPages: 2},
        {phase: 'rendering', completedPages: 1, totalPages: 2},
        {phase: 'rendering', completedPages: 2, totalPages: 2},
        {phase: 'saving', completedPages: 2, totalPages: 2},
    ]);
    expect(rasterize).toHaveBeenCalledOnce();
    expect(rasterize.mock.calls[0][0]).toMatchObject({pageNumber: 2, translations: ['', '第二页']});
    const result = await PDFDocument.load(download.data as Uint8Array);
    // 默认双语导出保持两栏页宽；未改原页同样在左右两栏各绘制一次。
    expect(result.getPages().map(page => page.getSize())).toEqual([{width: 810, height: 600}, {width: 810, height: 600}]);
    expect(download).toMatchObject({fileName: 'mixed.bilingual.pdf', mimeType: 'application/pdf'});
    expect(JSON.stringify(parsed)).toBe(before); expect(translations).toEqual([' Same first page ', '第二页']);
});

// Append to the existing A12 file; uses its imports, PDF.js port and cleanup hooks.
// Only the returned public model's segments property changes, in the public progress callback.
it('exports readable bilingual PDF source pages when rendering progress releases the parsed segments', async () => {
    const {PDFArray, PDFDict, PDFName, PDFNumber, PDFStream} = await import('pdf-lib');
    const texts = ['First source page', 'Second source page'];
    const sourcePdf = await PDFDocument.create();
    for (const text of texts) sourcePdf.addPage([400, 600]).drawText(text);
    const sourceBytes = await sourcePdf.save(), originalBytes = sourceBytes.slice();
    const destroy = vi.fn(async () => undefined), cleanups: Array<ReturnType<typeof vi.fn>> = [];
    // PDF.js text extraction is the ordinary external SDK port; pdf-lib source/output stay real.
    ports.getPdfDocument.mockImplementation(() => ({
        promise: Promise.resolve({numPages: 2, getPage: async (pageNumber: number) => {
            const cleanup = vi.fn(); cleanups.push(cleanup);
            return {cleanup, getViewport: () => ({width: 400, height: 600, transform: [1, 0, 0, 1, 0, 0]}),
                getTextContent: async () => ({items: [{str: texts[pageNumber - 1], dir: 'ltr',
                    transform: [1, 0, 0, 12, 10, 50], width: 120, height: 12, fontName: 'body', hasEOL: true}], styles: {}})};
        }}), destroy,
    }));
    const parsed = await parseBinaryDocument('released-segments.pdf', sourceBytes);
    expect(parsed.segments.map(segment => segment.source)).toEqual(texts);
    const binary = parsed.binary;
    if (!binary || binary.kind !== 'pdf') throw new Error('Expected the public parser to return a PDF model');
    expect(binary.pages.map(page => page.segmentIndexes)).toEqual([[0], [1]]);
    expect(binary.bytes).toEqual(originalBytes);
    expect(ports.getPdfDocument.mock.calls[0][0].data).toEqual(originalBytes);
    expect(destroy).toHaveBeenCalledOnce(); expect(cleanups).toHaveLength(2);
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
    const originalPages = JSON.stringify(binary.pages);
    const translations = [' First source page ', '第二页'];
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
    const rasterize = vi.fn<PdfPageRasterizer>(async () => png);
    const progress: Array<{phase: string; completedPages: number; totalPages: number}> = [];
    let releases = 0;
    const download = await createDocumentDownload(parsed, translations, 'bilingual', {
        pdfPageRasterizer: rasterize,
        onPdfProgress: value => {
            progress.push(value);
            if (value.phase === 'rendering' && value.completedPages === 0) {
                expect(parsed.segments.map(segment => segment.source)).toEqual(texts);
                expect(rasterize).not.toHaveBeenCalled();
                // ParsedDocument.segments is an assignable public property; no cast/getter or index mutation.
                parsed.segments = [];
                releases += 1;
            }
        },
    });
    expect(releases).toBe(1); expect(parsed.segments).toEqual([]);
    expect(progress).toEqual([
        {phase: 'rendering', completedPages: 0, totalPages: 2},
        {phase: 'rendering', completedPages: 1, totalPages: 2},
        {phase: 'rendering', completedPages: 2, totalPages: 2},
        {phase: 'saving', completedPages: 2, totalPages: 2},
    ]);
    expect(rasterize).toHaveBeenCalledTimes(2);
    expect(rasterize.mock.calls.map(([input]) => input.pageNumber)).toEqual([1, 2]);
    for (const [input] of rasterize.mock.calls) {
        expect(input.translations).toEqual(['First source page', '第二页']);
        expect(input.sourceBytes).toBe(binary.bytes); expect(input.sourceBytes).toEqual(originalBytes);
        expect(input.blocks).toBe(binary.pages[input.pageNumber - 1].blocks);
    }
    expect(download).toMatchObject({fileName: 'released-segments.bilingual.pdf', mimeType: 'application/pdf'});
    expect(download.data).toBeInstanceOf(Uint8Array);
    const output = await PDFDocument.load(download.data as Uint8Array);
    expect(output.getPages().map(page => page.getSize())).toEqual([{width: 810, height: 600}, {width: 810, height: 600}]);
    for (const page of output.getPages()) {
        // Read the actual saved artifact with exported pdf-lib classes, without faking SDK objects.
        // Each output page keeps its embedded source Form alongside the rasterizer's translation Image.
        const objects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).entries()
            .map(([, reference]) => output.context.lookup(reference, PDFStream));
        expect(objects.map(object => object.dict.lookup(PDFName.of('Subtype'), PDFName).asString()).sort())
            .toEqual(['/Form', '/Image']);
        const source = objects.find(object => object.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'))!;
        const box = source.dict.lookup(PDFName.of('BBox'), PDFArray);
        expect(Array.from({length: box.size()}, (_, index) => box.lookup(index, PDFNumber).asNumber()))
            .toEqual([0, 0, 400, 600]);
        expect(source.getContents().byteLength).toBeGreaterThan(0);
    }
    expect(parsed.binary).toBe(binary); expect(JSON.stringify(binary.pages)).toBe(originalPages);
    expect(binary.bytes).toEqual(originalBytes); expect(sourceBytes).toEqual(originalBytes);
    expect(translations).toEqual([' First source page ', '第二页']);
});
