import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const ports = vi.hoisted(() => ({
    apiGate: undefined as Promise<void> | undefined,
    workerGate: undefined as Promise<void> | undefined,
    apiStarted: vi.fn(), workerStarted: vi.fn(),
    options: {workerSrc: ''}, getDocument: vi.fn(),
}));
vi.mock('../src/features/document-translation/services/binary', () => ({
    pdfTextAtoms: (items: Array<{str: string}>) => items,
    pdfTextLines: (items: Array<{str: string}>) => items,
    pdfTextBlocks: (items: Array<{str: string}>) => items.map(({str}, index) => ({source: str, fontWeight: index ? 400 : 700})),
}));

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function bytes(signature = '%PDF-'): ArrayBuffer {return new TextEncoder().encode(signature).buffer as ArrayBuffer;}
function page(text = ['Heading', 'Paragraph']) {
    return {getViewport: vi.fn(() => ({width: 600})), getTextContent: vi.fn(async () => ({items: [...text.map(str => ({str})), {image: true}], styles: {}})), cleanup: vi.fn()};
}
function task(pages = [page(), page(['Second page'])]) {
    const pdf = {numPages: pages.length, getPage: vi.fn(async (number: number) => pages[number - 1])};
    const result = {promise: Promise.resolve(pdf), destroy: vi.fn(async () => {})};
    ports.getDocument.mockReturnValue(result); return {result, pdf, pages};
}
type Module = typeof import('../integrations/obsidian/pdf');
const extract = (module: Module, signal?: AbortSignal) => (module.extractPdfSegments as (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<unknown>)(bytes(), signal);
let module: Module; let createUrl: ReturnType<typeof vi.fn>; let revokeUrl: ReturnType<typeof vi.fn>;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); ports.apiGate = undefined; ports.workerGate = undefined; ports.options.workerSrc = '';
    ports.getDocument.mockReset();
    vi.stubGlobal('window', {}); createUrl = vi.fn(() => 'blob:owned-pdf-worker'); revokeUrl = vi.fn();
    // 保留 URL 构造器契约；只替换本用例拥有的 blob 分配与回收端口。
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createUrl);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl);
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', async () => {
        ports.apiStarted(); await ports.apiGate;
        return {GlobalWorkerOptions: ports.options, getDocument: ports.getDocument};
    });
    vi.doMock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw', async () => {
        ports.workerStarted(); await ports.workerGate; return {default: '/* controlled worker */'};
    });
    module = await import('../integrations/obsidian/pdf');
});
afterEach(() => {module.disposePdfWorker(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('Obsidian PDF extraction resource ownership', () => {
    it('rejects an invalid signature before importing PDF.js or creating a worker', async () => {
        await expect(module.extractPdfSegments(bytes('not a PDF'))).rejects.toThrow('签名');
        expect(ports.apiStarted).not.toHaveBeenCalled(); expect(ports.getDocument).not.toHaveBeenCalled();
    });
    it('preserves page/heading identities, cleans every page, and destroys the task once', async () => {
        const fixture = task(); expect(await extract(module)).toEqual([
            {id: 0, source: 'Heading', contextLabel: '第 1 页', role: 'heading'},
            {id: 1, source: 'Paragraph', contextLabel: undefined, role: 'paragraph'},
            {id: 2, source: 'Second page', contextLabel: '第 2 页', role: 'heading'},
        ]);
        expect(fixture.pages.every(value => value.cleanup.mock.calls.length === 1)).toBe(true);
        expect(fixture.result.destroy).toHaveBeenCalledOnce(); expect(createUrl).toHaveBeenCalledOnce();
        expect(ports.getDocument.mock.calls[0][0]).toMatchObject({disableFontFace: true, disableWorkerRendering: true, useWorkerFetch: false});
    });
    it('reuses one worker across concurrent documents and revokes it once', async () => {
        // 先固定 API mock；并发边界由 worker gate 控制，不依赖测试器同时解析动态 mock 的时序。
        const api = await import('pdfjs-dist/legacy/build/pdf.mjs');
        expect(api.getDocument).toBe(ports.getDocument);
        const gate = deferred<void>(); ports.workerGate = gate.promise;
        const first = task(); const second = task();
        ports.getDocument.mockReturnValueOnce(first.result).mockReturnValueOnce(second.result);
        const pending = Promise.all([extract(module), extract(module)]); pending.catch(() => {});
        try {
            await vi.waitFor(() => expect(ports.workerStarted).toHaveBeenCalledOnce());
            expect(ports.getDocument).not.toHaveBeenCalled();
        } finally {gate.resolve();}
        expect(await pending).toHaveLength(2);
        expect(ports.getDocument).toHaveBeenCalledTimes(2);
        expect(first.result.destroy).toHaveBeenCalledOnce(); expect(second.result.destroy).toHaveBeenCalledOnce();
        expect(createUrl).toHaveBeenCalledOnce();
        expect(await (createUrl.mock.calls[0][0] as Blob).text()).toBe('/* controlled worker */');
        expect(ports.workerStarted).toHaveBeenCalledOnce();
        module.disposePdfWorker(); module.disposePdfWorker(); expect(revokeUrl).toHaveBeenCalledOnce();
    });
    it('does not recreate a worker after disposal during a delayed API import', async () => {
        const gate = deferred<void>(); ports.apiGate = gate.promise; task();
        const pending = extract(module).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(ports.apiStarted).toHaveBeenCalledOnce()); module.disposePdfWorker(); gate.resolve();
        expect(await pending).toBe('AbortError'); expect(createUrl).not.toHaveBeenCalled(); expect(ports.getDocument).not.toHaveBeenCalled();
    });
    it('does not recreate a worker after disposal during its delayed raw import', async () => {
        const gate = deferred<void>(); ports.workerGate = gate.promise; task();
        const pending = extract(module).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(ports.workerStarted).toHaveBeenCalledOnce()); module.disposePdfWorker(); gate.resolve();
        expect(await pending).toBe('AbortError'); expect(createUrl).not.toHaveBeenCalled();
    });
    it('starts a fresh extraction after a previous lifetime was disposed', async () => {
        task(); await extract(module); module.disposePdfWorker(); await extract(module);
        expect(createUrl).toHaveBeenCalledTimes(2); expect(ports.getDocument).toHaveBeenCalledTimes(2);
    });
    it('skips browser worker setup in Node while retaining PDF extraction', async () => {
        vi.stubGlobal('window', undefined); task(); expect(await extract(module)).toHaveLength(3);
        expect(createUrl).not.toHaveBeenCalled(); expect(ports.workerStarted).not.toHaveBeenCalled();
    });
    it('cleans an acquired page when its text extraction fails and preserves that failure', async () => {
        const fixture = task(); fixture.pages[0].getTextContent.mockRejectedValueOnce(new Error('text extraction failed'));
        await expect(extract(module)).rejects.toThrow('text extraction failed'); expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce();
        expect(fixture.pdf.getPage).toHaveBeenCalledOnce(); expect(fixture.result.destroy).toHaveBeenCalledOnce();
    });
    it('destroys a failed load task and does not mask its error with teardown rejection', async () => {
        const result = {promise: Promise.reject(new Error('encrypted PDF')), destroy: vi.fn(async () => {throw new Error('teardown failed');})};
        result.promise.catch(() => {}); ports.getDocument.mockReturnValue(result);
        await expect(extract(module)).rejects.toThrow('encrypted PDF'); expect(result.destroy).toHaveBeenCalledOnce();
    });
    it('reports a textless PDF after cleaning its task', async () => {
        const fixture = task([page([])]); await expect(extract(module)).rejects.toThrow('没有可提取文字');
        expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce(); expect(fixture.result.destroy).toHaveBeenCalledOnce();
    });
    it('rejects pre-cancelled input without loading or worker allocation', async () => {
        const controller = new AbortController(); controller.abort(); task();
        await expect(extract(module, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(ports.apiStarted).not.toHaveBeenCalled(); expect(ports.getDocument).not.toHaveBeenCalled();
    });
    it('does not allocate a worker when cancelled while its module loads', async () => {
        const gate = deferred<void>(); ports.workerGate = gate.promise; const controller = new AbortController(); task();
        const pending = extract(module, controller.signal).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(ports.workerStarted).toHaveBeenCalledOnce()); controller.abort(); gate.resolve();
        expect(await pending).toBe('AbortError'); expect(createUrl).not.toHaveBeenCalled(); expect(ports.getDocument).not.toHaveBeenCalled();
    });
    it('destroys only the cancelled document immediately and releases the acquired page', async () => {
        const gate = deferred<{items: Array<{str: string}>; styles: {}}>(); const controller = new AbortController(); const fixture = task();
        fixture.pages[0].getTextContent.mockReturnValueOnce(gate.promise);
        const pending = extract(module, controller.signal).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(fixture.pages[0].getTextContent).toHaveBeenCalledOnce()); controller.abort(); await turn();
        const destroyedOnAbort = fixture.result.destroy.mock.calls.length; gate.resolve({items: [{str: 'Late text'}], styles: {}});
        const outcome = await pending; expect(destroyedOnAbort).toBe(1); expect(outcome).toBe('AbortError');
        expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce(); expect(fixture.pdf.getPage).toHaveBeenCalledOnce();
    });
    it('does not accept success after cancellation inside getDocument', async () => {
        const controller = new AbortController(); const fixture = task();
        ports.getDocument.mockImplementationOnce(() => {controller.abort(); return fixture.result;});
        await expect(extract(module, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fixture.pdf.getPage).not.toHaveBeenCalled(); expect(fixture.result.destroy).toHaveBeenCalledOnce();
    });
    it('removes the abort listener after successful extraction', async () => {
        const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener'); const fixture = task();
        await extract(module, controller.signal); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        controller.abort(); expect(fixture.result.destroy).toHaveBeenCalledOnce();
    });
    it('destroys an in-progress task on plugin disposal and cleans its late page', async () => {
        const gate = deferred<{items: Array<{str: string}>; styles: {}}>(); const fixture = task();
        fixture.pages[0].getTextContent.mockReturnValueOnce(gate.promise);
        const pending = extract(module).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(fixture.pages[0].getTextContent).toHaveBeenCalledOnce());
        module.disposePdfWorker(); await turn(); const destroyedOnDispose = fixture.result.destroy.mock.calls.length;
        gate.resolve({items: [], styles: {}}); const outcome = await pending;
        expect(destroyedOnDispose).toBe(1); expect(outcome).toBe('AbortError'); expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce();
    });
    it('cancels one loading task without destroying another document', async () => {
        const first = task(); const second = task(); const gate = deferred<typeof first.pdf>();
        first.result.promise = gate.promise;
        ports.getDocument.mockReturnValueOnce(first.result).mockReturnValueOnce(second.result);
        const controller = new AbortController(); const pending = extract(module, controller.signal).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(ports.getDocument).toHaveBeenCalledOnce()); controller.abort(); await turn();
        const firstDestroyedOnAbort = first.result.destroy.mock.calls.length, secondDestroyedOnAbort = second.result.destroy.mock.calls.length;
        const secondSegments = await extract(module); gate.resolve(first.pdf); const outcome = await pending;
        expect(firstDestroyedOnAbort).toBe(1); expect(secondDestroyedOnAbort).toBe(0);
        expect(secondSegments).toHaveLength(3); expect(outcome).toBe('AbortError');
        expect(second.result.destroy).toHaveBeenCalledOnce(); expect(first.pdf.getPage).not.toHaveBeenCalled();
    });
    it('cleans a page obtained after cancellation without requesting its text', async () => {
        const fixture = task(); const gate = deferred<ReturnType<typeof page>>(); const controller = new AbortController();
        fixture.pdf.getPage.mockReturnValueOnce(gate.promise);
        const pending = extract(module, controller.signal).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(fixture.pdf.getPage).toHaveBeenCalledOnce()); controller.abort(); gate.resolve(fixture.pages[0]);
        expect(await pending).toBe('AbortError'); expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce(); expect(fixture.pages[0].getTextContent).not.toHaveBeenCalled();
    });
    it('reports teardown failure after an otherwise successful extraction', async () => {
        const fixture = task(); fixture.result.destroy.mockRejectedValueOnce(new Error('teardown failed'));
        await expect(extract(module)).rejects.toThrow('teardown failed'); expect(fixture.result.destroy).toHaveBeenCalledOnce();
    });
    it('preserves a failed page acquisition and tears down the loading task', async () => {
        const fixture = task(); fixture.pdf.getPage.mockRejectedValueOnce(new Error('broken page'));
        await expect(extract(module)).rejects.toThrow('broken page');
        expect(fixture.result.destroy).toHaveBeenCalledOnce(); expect(fixture.pages[0].cleanup).not.toHaveBeenCalled();
        expect(fixture.pages[0].getTextContent).not.toHaveBeenCalled();
    });
    it('reports cancellation when the native text request rejects after task destruction', async () => {
        const gate = deferred<{items: Array<{str: string}>; styles: {}}>(); const controller = new AbortController(); const fixture = task();
        fixture.pages[0].getTextContent.mockReturnValueOnce(gate.promise);
        fixture.result.destroy.mockRejectedValueOnce(new Error('destroy rejected'));
        const pending = extract(module, controller.signal).then(() => 'resolved', error => error.name);
        await vi.waitFor(() => expect(fixture.pages[0].getTextContent).toHaveBeenCalledOnce()); controller.abort(); await turn();
        gate.reject(new Error('worker terminated')); expect(await pending).toBe('AbortError');
        expect(fixture.pages[0].cleanup).toHaveBeenCalledOnce(); expect(fixture.result.destroy).toHaveBeenCalledOnce();
        expect(fixture.pdf.getPage).toHaveBeenCalledOnce();
    });
});
