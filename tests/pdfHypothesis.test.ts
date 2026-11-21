import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {installPdfHypothesisAdapter, type PdfHypothesisPorts} from '@/src/features/document-translation/ui/pdfHypothesis';
function setup(count = 2, text?: string[]) {
    const {window, document} = parseHTML('<html><body><section style="width:90%"><main id="old-id"><div id="pages"><article data-page-number="1"><div>Original text</div></article></div></main></section></body></html>');
    const viewer = document.querySelector('#pages')! as HTMLElement, viewport = document.querySelector('main')! as HTMLElement, container = document.querySelector('section')! as HTMLElement;
    const first = document.querySelector('article')! as HTMLElement, layer = first.firstElementChild! as HTMLElement;
    const residents = new Map<number, {frame: HTMLElement; text?: HTMLElement}>([[0, {frame: first, text: layer}]]);
    const pages = Array.from({length: count}, (_, i) => ({view: [0, 0, 100, 200], pageNumber: i + 1, getTextContent: vi.fn(async () => ({items: [{str: `Page ${i + 1}`}]})), getViewport(this: {pageNumber: number}) {return this.pageNumber;}}));
    const pdf = {numPages: count, fingerprints: ['standard-pdf-fingerprint'], getPage: vi.fn(async (number: number) => pages[number - 1]), getMetadata(this: {fingerprints: string[]}) {return this.fingerprints;}};
    const release = vi.fn(), acquire = vi.fn(() => ({promise: Promise.resolve(pdf as any), release}));
    const ports: PdfHypothesisPorts = {window: window as unknown as Window, viewport, viewer, container, sourceUrl: 'https://paper.example/test.pdf', text, acquire,
        page: index => residents.get(index), top: index => index * 250};
    return {document, window: window as any, ports, residents, first, layer, viewer, viewport, container, pdf, pages, release, acquire};
}
describe('Hypothesis PDF.js reader compatibility', () => {
    it('reuses the PDF lease and original metadata without rendering or creating offscreen DOM, and restores owned state', async () => {
        const s = setup(); s.first.classList.add('page');
        const cleanup = await installPdfHypothesisAdapter(s.ports, new AbortController().signal), app = s.window.PDFViewerApplication;
        expect(s.acquire).toHaveBeenCalledOnce(); expect(app.pdfDocument).toBe(s.pdf); await app.initializedPromise;
        expect(app.downloadComplete).toBe(true); expect(app.url).toBe('https://paper.example/test.pdf'); expect(app.pdfViewer.pagesCount).toBe(2);
        expect(s.pdf.getPage.mock.calls).toEqual([[1], [2]]); expect(s.viewer.querySelectorAll('[data-fluentread-hypothesis-placeholder]')).toHaveLength(0);
        expect(s.document.querySelectorAll('canvas')).toHaveLength(0); expect(s.layer.classList.contains('textLayer')).toBe(true); expect(s.viewport.id).toBe('viewerContainer');
        const view = app.pdfViewer.getPageView(0); expect(view.div).toBe(s.first); expect(view.textLayer).toEqual({div: s.layer, renderingDone: true}); expect(view.renderingState).toBe(3); expect(view.pdfPage).toBe(s.pages[0]); expect(app.pdfViewer.getPageView(30)).toBeUndefined();
        s.container.style.width = '70%'; cleanup(); expect(s.release).toHaveBeenCalledOnce(); expect(s.viewport.id).toBe('old-id'); expect(s.container.style.width).toBe('90%'); expect(s.window.PDFViewerApplication).toBeUndefined();
        expect(s.first.classList.contains('page')).toBe(true); expect(s.layer.classList.contains('textLayer')).toBe(false);
    });
    it('anchors offscreen pages to lazy placeholders and invalidates them when real text is rendered', async () => {
        const s = setup(); let top = 250; s.ports.top = () => top;
        const cleanup = await installPdfHypothesisAdapter(s.ports, new AbortController().signal), viewer = s.window.PDFViewerApplication.pdfViewer, view = viewer.getPageView(1);
        expect(view.textLayer).toBeNull(); expect(view.renderingState).toBe(0); expect(s.viewer.children.length).toBe(1);
        const placeholder = view.div; expect(view.div).toBe(placeholder); expect(placeholder.isConnected).toBe(true); expect(placeholder.style.top).toBe('250px');
        top = 400; viewer.update(); expect(placeholder.style.top).toBe('400px');
        const frame = s.document.createElement('article'); s.viewer.append(frame); s.residents.set(1, {frame}); expect(view.renderingState).toBe(0); expect(view.div).toBe(frame); expect(placeholder.isConnected).toBe(false);
        s.residents.set(1, {frame, text: frame}); expect(view.textLayer.div).toBe(frame); expect(frame.classList.contains('page')).toBe(true); expect(frame.classList.contains('textLayer')).toBe(true);
        s.residents.delete(1); const second = view.div; cleanup(); expect(second.isConnected).toBe(false); expect(frame.classList.contains('textLayer')).toBe(false);
    });
    it('gives each reflow text view a stable independent fingerprint, matching text offsets and genuine page methods', async () => {
        const s = setup(2, ['Reflow original and translation', 'Second page']); const previous = {existing: true}; s.window.PDFViewerApplication = previous;
        const cleanup = await installPdfHypothesisAdapter(s.ports, new AbortController().signal), app = s.window.PDFViewerApplication;
        expect(app.pdfDocument.fingerprints[0]).toMatch(/^standard-pdf-fingerprint-fr-[a-f0-9]{32}$/); expect(app.pdfDocument.numPages).toBe(2); expect(app.pdfDocument.getMetadata()).toEqual(['standard-pdf-fingerprint']); expect(app.url).toBe('');
        const first = app.pdfViewer.getPageView(0).pdfPage; expect((await first.getTextContent()).items).toEqual([{str: s.ports.text![0]}]); expect(first.getViewport()).toBe(1); expect(first.view).toEqual([0, 0, 100, 200]);
        const identity = app.pdfDocument.fingerprints[0]; cleanup(); expect(s.window.PDFViewerApplication).toBe(previous);
        const cleanAgain = await installPdfHypothesisAdapter(s.ports, new AbortController().signal); expect(s.window.PDFViewerApplication.pdfDocument.fingerprints[0]).toBe(identity); cleanAgain();
        s.ports.text = ['Changed translation', 'Second page']; const changed = await installPdfHypothesisAdapter(s.ports, new AbortController().signal); expect(s.window.PDFViewerApplication.pdfDocument.fingerprints[0]).not.toBe(identity); changed();
    });
    it('never sends a signed source URL or local path to the service', async () => {
        const s = setup(0); s.ports.sourceUrl = 'https://paper.example/file.pdf?token=private';
        const cleanup = await installPdfHypothesisAdapter(s.ports, new AbortController().signal); expect(s.window.PDFViewerApplication.url).toBe(''); cleanup();
    });
    it('releases the shared lease on initialization failure and on cancellation', async () => {
        const s = setup(); s.pdf.getPage.mockRejectedValueOnce(Error('bad page'));
        await expect(installPdfHypothesisAdapter(s.ports, new AbortController().signal)).rejects.toThrow('bad page'); expect(s.release).toHaveBeenCalledOnce();
        const controller = new AbortController(); controller.abort();
        await expect(installPdfHypothesisAdapter(s.ports, controller.signal)).rejects.toThrow(); expect(s.release).toHaveBeenCalledTimes(2);
    });
    it('loads at most four page proxies concurrently and cancels before loading more metadata', async () => {
        const s = setup(8), controller = new AbortController(), callbacks: (() => void)[] = [];
        s.pdf.getPage.mockImplementation((number: number) => new Promise(resolve => callbacks.push(() => resolve(s.pages[number - 1]))));
        const operation = installPdfHypothesisAdapter(s.ports, controller.signal); await Promise.resolve(); await Promise.resolve(); expect(s.pdf.getPage).toHaveBeenCalledTimes(4);
        controller.abort(); callbacks.forEach(resolve => resolve()); await expect(operation).rejects.toThrow(); expect(s.pdf.getPage).toHaveBeenCalledTimes(4); expect(s.release).toHaveBeenCalledOnce();
    });
});
