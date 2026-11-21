import './helpers/vueDomFixture';
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRenderer, h, nextTick, ref} from 'vue';
import PdfAnnotations from '@/src/features/document-translation/ui/PdfAnnotations.vue';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';
import type {PdfAnnotation} from '@/src/features/document-translation/core/pdfAnnotations';

const ports = vi.hoisted(() => ({export: vi.fn()}));
vi.mock('@/src/features/document-translation/services/pdfAnnotationExport', () => ({exportPdfAnnotations: ports.export}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
let app: any, selection: any, removed: ReturnType<typeof vi.spyOn>;
const doc = (): ParsedDocument => ({fileName: 'paper.pdf', format: 'pdf', label: 'PDF', segments: [{id: 0, source: 'Original source'}], parts: [], binary: {kind: 'pdf', bytes: new Uint8Array([1, 2]), pages: [{pageNumber: 1, width: 100, height: 200, segmentIndexes: [0], blocks: [{segmentIndex: 0, x: 10, y: 20, width: 60, height: 30, fontSize: 12, lineHeight: 14, lineCount: 2, fontFamily: 'sans', fontWeight: 400, textAlign: 'left'}]}]}});
const mark = (): PdfAnnotation => ({id: 'existing', page: 1, color: 'pink', kind: 'underline', quote: 'Old quote', note: 'Old note', rects: [{x: .1, y: .1, width: .6, height: .15}]});
const flush = async () => {for (let i = 0; i < 10; i++) {await nextTick(); await Promise.resolve();}};
const click = (element: Element) => element.dispatchEvent(new document.defaultView!.Event('click'));
const submitNote = (root: Element) => root.querySelector('form')!.dispatchEvent(new document.defaultView!.Event('submit', {cancelable: true}));

beforeEach(() => {
    const {document, window} = parseHTML('<html><body><main><div class="pdf-page-frame"><div data-fluentread-pdf-text data-pdf-page-number="1"><span>Original source</span></div></div><article data-pdf-reading-page="1"><p class="pdf-reading-paragraph" data-pdf-source-id="pdf-1-segment-0"><span>Reflow source</span></p></article></main></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', {getSelection: () => selection});
    vi.stubGlobal('Document', window.Document); vi.stubGlobal('ShadowRoot', window.ShadowRoot);
    removed = vi.spyOn(document, 'removeEventListener');
    ports.export.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70])); selection = undefined;
});
afterEach(() => {app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

function mount() {
    const current = ref(doc()), annotations = ref<PdfAnnotation[]>([]), open = ref(false), storageUnavailable = ref(false), jumps: PdfAnnotation[] = [];
    const translations = ref(['本段译文']);
    const renderer = createRenderer<any, any>({
        createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
        setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
        patchProp: (node, key, old, value) => {
            if (key.startsWith('on')) {if (key.includes(':')) return; const event = key.slice(2).replace(/Capture$/, '').toLowerCase(); if (old) node.removeEventListener(event, old); if (value) node.addEventListener(event, value);}
            else if (key === 'style') {for (const [name, entry] of Object.entries(value || {})) node.style.setProperty(name, String(entry));}
            else if (key === 'value') node.value = value;
            else if (value == null || value === false && !key.startsWith('aria-')) node.removeAttribute(key);
            else node.setAttribute(key, String(value));
        },
    });
    const root = document.createElement('aside'); document.body.append(root);
    app = renderer.createApp({setup: () => () => h(PdfAnnotations, {document: current.value, annotations: annotations.value, open: open.value,
        root: document.querySelector('main')!, storageUnavailable: storageUnavailable.value, translations: translations.value,
        onToggle: () => {open.value = !open.value;}, 'onUpdate:annotations': (value: PdfAnnotation[]) => {annotations.value = value;},
        onJump: (annotation: PdfAnnotation) => {jumps.push(annotation);}})});
    app.mount(root);
    return {root, current, annotations, open, storageUnavailable, jumps, translations, state: app._instance.subTree.component.setupState};
}
function select(selector: string, quote = 'Selected source', offset = 0) {
    const node = document.querySelector(selector)!.firstChild!;
    selection = {isCollapsed: false, rangeCount: 1, getRangeAt: () => ({startContainer: node, startOffset: offset, endContainer: node,
        endOffset: offset + quote.length, toString: () => quote, getClientRects: () => [{left: 25, top: 60, width: 45, height: 20}, {left: 25, top: 80, width: 30, height: 20}]}), toString: () => quote};
}

describe('actual PDF annotation controls', () => {
    it('captures reflow before opening, adds translation notes, changes color, jumps and deletes', async () => {
        const view = mount(); await flush();
        select('.pdf-reading-paragraph span'); document.dispatchEvent(new document.defaultView!.Event('selectionchange'));
        click(view.root.querySelector('.pdf-menu-button')!); await flush();
        expect(view.root.querySelector('blockquote')!.textContent).toBe('Selected source');
        expect(view.root.textContent).toContain('document.pdfReading.annotationReflowHint');
        expect(view.root.querySelector('textarea')).toBeNull();
        const colors = view.root.querySelectorAll('.pdf-annotation-colors button'); click(colors[1]); await flush();
        click(view.root.querySelector('.pdf-annotation-note-toggle')!); await flush();
        view.state.note = 'My note'; view.state.includeTranslation = true;
        click(view.root.querySelectorAll('.pdf-annotation-actions > button')[1]); await flush();
        expect(view.annotations.value).toEqual([]);
        expect(view.root.querySelectorAll('.pdf-annotation-actions > button')[1].getAttribute('aria-pressed')).toBe('true');
        submitNote(view.root); await flush();
        expect(view.annotations.value).toHaveLength(1);
        expect(view.annotations.value[0]).toMatchObject({page: 1, kind: 'underline', color: 'green', sourceId: 'pdf-1-segment-0', note: 'My note\n\n本段译文', rects: [{x: .1, y: .1, width: .6, height: .15}]});
        expect(view.root.querySelector('.pdf-annotation-primary')?.textContent).toBe('My note\n\n本段译文');
        expect(view.root.querySelector('.pdf-annotation-excerpt')?.textContent).toBe('Selected source');
        view.state.captureSelection(); await flush();
        expect(view.root.querySelector('.pdf-annotation-composer')).toBeNull();
        expect(view.root.textContent).not.toContain('document.pdfReading.annotationUnsaved');
        view.storageUnavailable.value = true; await flush();
        expect(view.root.textContent).toContain('document.pdfReading.annotationUnsaved');
        click(view.root.querySelector('.pdf-annotation-location')!); expect(view.jumps).toEqual(view.annotations.value);
        expect(view.root.querySelector('.pdf-annotation-delete')).toBeNull();
        click(view.root.querySelector('.pdf-annotation-more')!); await flush();
        click(view.root.querySelector('.pdf-annotation-delete')!); await flush();
        expect(view.annotations.value).toEqual([]);
        expect(view.root.querySelector('.pdf-annotation-download')).toBeNull();
    });
    it('captures precise multiline original coordinates, ignores cross-layer and foreign selections, and clears on a new file', async () => {
        const view = mount(); await flush();
        document.querySelector('.pdf-page-frame')!.getBoundingClientRect = () => ({left: 10, top: 20, width: 150, height: 400} as DOMRect);
        select('[data-fluentread-pdf-text] span'); view.state.captureSelection();
        expect(view.state.candidate.rects).toEqual([{x: .1, y: .1, width: .3, height: .05}, {x: .1, y: .15, width: .2, height: .05}]);
        view.state.add('underline'); await flush(); expect(view.annotations.value[0]).toMatchObject({kind: 'underline', note: '', quote: 'Selected source'});
        select('[data-fluentread-pdf-text] span'); view.state.captureSelection();
        const source = selection.getRangeAt(0); selection.getRangeAt = () => ({...source, endContainer: document.querySelector('.pdf-reading-paragraph span')!.firstChild});
        view.state.captureSelection(); expect(view.state.candidate).toBeUndefined();
        selection.getRangeAt = () => ({...source, startContainer: document.createTextNode('outside')}); view.state.captureSelection();
        expect(view.annotations.value).toHaveLength(1);
        select('.pdf-reading-paragraph span'); view.state.captureSelection(); expect(view.state.candidate).toBeTruthy();
        view.current.value = doc(); await flush(); expect(view.state.candidate).toBeUndefined(); expect(view.state.note).toBe('');
    });
    it('keeps an open draft bound to its original selection when the panel closes or the reader changes selection', async () => {
        const view = mount(); click(view.root.querySelector('.pdf-menu-button')!); await flush();
        expect(view.root.textContent).toContain('document.pdfReading.annotationEmpty');
        expect(view.root.querySelector('.pdf-annotation-composer')).toBeNull();
        expect(view.root.querySelector('.pdf-annotation-download')).toBeNull();
        select('.pdf-reading-paragraph span'); view.state.captureSelection(); await flush();
        click(view.root.querySelector('.pdf-annotation-note-toggle')!); await flush();
        view.state.note = 'Draft for selection 1';
        view.state.includeTranslation = true;
        view.state.captureSelection();
        expect(view.state.note).toBe('Draft for selection 1');
        view.open.value = false; await flush();
        document.querySelector('main')!.dispatchEvent(new document.defaultView!.Event('pointerdown', {bubbles: true}));
        select('.pdf-reading-paragraph span', 'New text', 2); view.state.captureSelection(); await flush();
        view.open.value = true; await flush();
        expect(view.state.note).toBe('Draft for selection 1');
        expect(view.root.querySelector('blockquote')?.textContent).toBe('Selected source');
        click(view.root.querySelector('.pdf-annotation-note-actions button')!); await flush();
        expect(view.state.note).toBe('');
        expect(view.state.includeTranslation).toBe(false);
        expect(view.root.querySelector('textarea')).toBeNull();
        expect(view.root.querySelector('blockquote')?.textContent).toBe('New text');
        document.querySelector('main')!.dispatchEvent(new document.defaultView!.Event('pointerdown', {bubbles: true}));
        expect(view.state.candidate).toBeUndefined();
        app.unmount(); app = undefined;
        expect(removed.mock.calls.map((call: any[]) => call[0])).toEqual(expect.arrayContaining(['selectionchange', 'pointerup', 'pointerdown']));
    });
    it('lets the user read and edit the full saved note without creating a second mark', async () => {
        const view = mount(), existing = mark();
        existing.note = 'Full note\n'.repeat(20);
        view.annotations.value = [existing]; view.open.value = true; await flush();
        click(view.root.querySelector('.pdf-annotation-more')!); await flush();
        click(view.root.querySelector('.pdf-annotation-row-actions button')!); await flush();
        expect(view.state.note).toBe(existing.note);
        expect(view.root.querySelector('.pdf-annotation-footer')).toBeNull();
        view.state.note = 'Revised note';
        submitNote(view.root); await flush();
        expect(view.annotations.value).toEqual([{...existing, note: 'Revised note'}]);
        expect(view.root.querySelector('.pdf-annotation-primary')?.textContent).toBe('Revised note');
    });
    it('attaches the current translation only when the original selection belongs to one segment', async () => {
        const view = mount();
        const binary = view.current.value.binary!;
        if (binary.kind !== 'pdf') throw new Error('PDF fixture expected');
        binary.pages[0].blocks.push({...binary.pages[0].blocks[0], y: 100, segmentIndex: 1});
        document.querySelector('.pdf-page-frame')!.getBoundingClientRect = () => ({left: 10, top: 20, width: 150, height: 400} as DOMRect);
        select('[data-fluentread-pdf-text] span'); view.state.captureSelection();
        view.translations.value = ['', 'Second translation']; view.open.value = true; await flush();
        click(view.root.querySelector('.pdf-annotation-note-toggle')!); await flush();
        expect(view.root.querySelector('.pdf-annotation-translation')).toBeNull();
        view.translations.value = ['Ready translation', 'Second translation']; await flush();
        expect(view.root.querySelector('.pdf-annotation-translation')).toBeTruthy();
        click(view.root.querySelector('.pdf-annotation-note-actions button')!); await flush();
        select('[data-fluentread-pdf-text] span', 'Two paragraphs', 1);
        const range = selection.getRangeAt(0);
        selection.getRangeAt = () => ({...range, getClientRects: () => [...range.getClientRects(), {left: 25, top: 230, width: 45, height: 20}]});
        view.state.captureSelection(); await flush();
        click(view.root.querySelector('.pdf-annotation-note-toggle')!); await flush();
        expect(view.root.querySelector('.pdf-annotation-translation')).toBeNull();
    });
    it('downloads an annotation snapshot, releases the URL and reports export failures without losing marks', async () => {
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:annotation'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const view = mount(); view.annotations.value = [mark()]; view.open.value = true; await flush();
        await view.state.download(); await flush();
        expect(ports.export).toHaveBeenCalledWith(view.current.value.binary!.bytes, expect.arrayContaining([expect.objectContaining({id: 'existing'})]));
        expect(create).toHaveBeenCalledOnce(); expect(view.root.textContent).toContain('document.pdfReading.annotationDownloaded');
        ports.export.mockRejectedValueOnce(new Error('encrypted PDF')); await view.state.download(); await flush();
        expect(view.root.textContent).toContain('document.pdfReading.annotationExportFailed'); expect(view.annotations.value).toHaveLength(1);
        expect(revoke).toHaveBeenCalledWith('blob:annotation');
    });
    it('discards an export completed after document switching or unmounting', async () => {
        const create = vi.spyOn(URL, 'createObjectURL');
        const view = mount(); view.annotations.value = [mark()]; await flush();
        let finish!: (value: Uint8Array) => void;
        ports.export.mockImplementationOnce(() => new Promise<Uint8Array>(resolve => {finish = resolve;}));
        const pending = view.state.download(); await vi.dynamicImportSettled(); await flush();
        expect(view.state.downloading).toBe(true);
        view.current.value = doc(); await flush(); finish(new Uint8Array([1])); await pending;
        expect(create).not.toHaveBeenCalled(); expect(view.state.downloading).toBe(false);
        ports.export.mockImplementationOnce(() => new Promise<Uint8Array>(resolve => {finish = resolve;}));
        const disposed = view.state.download(); await vi.dynamicImportSettled(); await flush();
        app.unmount(); app = undefined; finish(new Uint8Array([1])); await disposed;
        expect(create).not.toHaveBeenCalled();
    });
});

it('adds directly from a captured toolbar Range and refuses disconnected, collapsed or overlong geometry without truncating', async () => {
    const view = mount(); await flush();
    document.querySelector('.pdf-page-frame')!.getBoundingClientRect = () => ({left: 10, top: 20, width: 150, height: 400} as DOMRect);
    select('[data-fluentread-pdf-text] span'); const selected = selection.getRangeAt(0);
    expect(view.state.markSelection({...selected, collapsed: true}, 'highlight')).toBe(false);
    expect(view.state.markSelection({...selected, startContainer: document.createTextNode('Detached')}, 'highlight')).toBe(false);
    expect(view.state.markSelection({...selected, getClientRects: () => Array(129).fill({left:25,top:60,width:45,height:20})}, 'highlight')).toBe(false);
    expect(view.annotations.value).toHaveLength(0);
    view.state.note = 'Old selection note'; view.state.includeTranslation = true;
    expect(view.state.markSelection(selected, 'highlight')).toBe(true); await flush();
    expect(view.annotations.value).toHaveLength(1); expect(view.annotations.value[0].quote).toBe('Selected source'); expect(view.annotations.value[0].note).toBe('');
    expect(view.annotations.value[0].rects).toHaveLength(2);
});
