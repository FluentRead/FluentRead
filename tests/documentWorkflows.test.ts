import {afterEach, describe, expect, it, vi} from 'vitest';
import JSZip from 'jszip';
import {parseDocument, DOCUMENT_MAX_BYTES, type ParsedDocument} from '@/src/features/document-translation/core/document';
import {createDocumentTaskState, type DocumentQueueItem} from '@/src/features/document-translation/ui/useDocumentTasks';
import {createDocumentImportWorkflow, type DocumentImportPorts} from '@/src/features/document-translation/services/importWorkflow';
import {createDocumentRecognitionWorkflow, type DocumentRecognitionPorts} from '@/src/features/document-translation/services/recognitionWorkflow';
import {createDocumentExportWorkflow, type DocumentExportPorts} from '@/src/features/document-translation/services/exportWorkflow';
import {generateDocumentArchive} from '@/src/features/document-translation/services/archive';
import type {DocumentHistoryRecord} from '@/src/features/document-translation/services/history';
import {createDocumentHistory, documentHistoryId} from '@/src/features/document-translation/services/history';
import {IDBFactory} from 'fake-indexeddb';
import type {DocumentDownload} from '@/src/features/document-translation/services/binary';

const cleanups: Array<() => void> = [];
const pending = <T,>(fallback: T) => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});
    cleanups.push(() => resolve(fallback));
    return {promise, resolve, reject};
};
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
afterEach(async () => {for (const cleanup of cleanups.splice(0)) cleanup();await settle();vi.useRealTimers();vi.restoreAllMocks();});
const document = (name = 'source.txt') => parseDocument(name, 'Source.');
const task = (id = 1): DocumentQueueItem => ({...createDocumentTaskState(), id, name: `${id}.txt`, document: document(`${id}.txt`), translations: ['Reader correction'], revision: 2});
function record(parsed = document(), parsedVersion = 16): DocumentHistoryRecord {
    return {id: 'history', name: parsed.fileName, format: parsed.format, size: 7, total: 1, completed: 1, updatedAt: 1,
        bytes: new TextEncoder().encode('Source.'), mimeType: 'text/plain', translations: ['Kept correction'], fingerprint: 'settings', parsed, parsedVersion};
}
function importFixture() {
    let id = 0;
    const tasks: DocumentQueueItem[] = [];
    const load = vi.fn<(id: string) => Promise<DocumentHistoryRecord | null>>().mockResolvedValue(null);
    const history = {loadChecked: async (id: string) => ({status: 'ok' as const, record: await load(id), version: 'v:fixture'})};
    const ports: DocumentImportPorts = {
        parseFile: vi.fn(async file => parseDocument(file.name, await file.text())),
        fetchPdf: vi.fn<DocumentImportPorts['fetchPdf']>().mockResolvedValue(new File(['Source.'], 'online.txt')),
        history: null, parsedVersion: 16,
        createTask: (file, sourceUrl) => ({...createDocumentTaskState(), id: ++id, name: file.name, sourceUrl}),
        appendTask: vi.fn(item => {tasks.push(item);}), releaseDocument: vi.fn(), onStart: vi.fn(), onPhase: vi.fn(),
        onReadProgress: vi.fn(), onDownloadProgress: vi.fn(), onOnlineError: vi.fn(), onHistoryUnavailable: vi.fn(), onFinished: vi.fn(), onHistoryMissing: vi.fn(async () => {}),
    };
    const workflow = createDocumentImportWorkflow(ports);cleanups.push(workflow.dispose);
    return {ports, workflow, tasks, load, history};
}

describe('document import workflow ownership', () => {
    it.each(['blocked', 'timeout'] as const)('preserves existing history after a transient %s read and a later successful save', async failure => {
        const f = importFixture(), factory = new IDBFactory(), history = createDocumentHistory(factory);
        const bytes = new TextEncoder().encode('Source.'), id = await documentHistoryId(bytes);
        const prior = {...record(), id, bytes};
        expect(await history.save(prior)).toBe(true);
        let block = true;
        const late = {result: {close: vi.fn()}} as unknown as IDBOpenDBRequest;
        const flaky = createDocumentHistory({open(name: string, version?: number) {
            if (!block) return factory.open(name, version);
            block = false;
            if (failure === 'blocked') queueMicrotask(() => late.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
            return late;
        }} as IDBFactory, 20);
        f.ports.history = flaky;
        let written: Promise<boolean> | undefined;
        vi.mocked(f.ports.onFinished).mockImplementation(() => {
            const item = f.tasks[0];
            if (item.document && item.historyId && item.bytes && !item.historyReadUnavailable) written = flaky.save({...prior,
                id: item.historyId, bytes: item.bytes, translations: [...item.translations], completed: 0});
        });
        await f.workflow.loadFiles([new File([bytes], 'source.txt', {type: 'text/plain'})]);
        await written;
        expect(f.tasks[0].historyReadUnavailable).toBe(true);
        expect(written).toBeUndefined();
        f.tasks[0].translations = ['Current correction']; f.tasks[0].revision = 1;
        await f.workflow.loadFiles([new File([bytes], 'source.txt', {type: 'text/plain'})]);
        expect(f.tasks[0].translations).toEqual(['Current correction']);
        expect(f.tasks[1].translations).toEqual(['Kept correction']);
        expect(f.tasks[1].historyReadUnavailable).toBeUndefined();
        late.onsuccess!(new Event('success'));
        expect(late.result.close).toHaveBeenCalledOnce();
        expect((await history.load(id))?.translations).toEqual(['Kept correction']);
    });
    it('does not publish an obsolete unavailable history result over a replacement import', async () => {
        const f = importFixture(), old = pending<{status: 'ok'; record: DocumentHistoryRecord | null; version: string} | {status: 'unavailable'}>({status: 'unavailable'});
        const checked = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({status: 'ok', record: record(), version: 'v:fixture'});
        f.ports.history = {loadChecked: checked};
        const first = f.workflow.loadFiles([new File(['Old.'], 'old.txt')]);
        await vi.waitFor(() => expect(checked).toHaveBeenCalledOnce());
        const second = f.workflow.loadFiles([new File(['Source.'], 'next.txt')]);
        await second;old.resolve({status: 'unavailable'});await first;
        expect(f.tasks).toHaveLength(1);
        expect(f.tasks[0]).toMatchObject({name: 'next.txt', translations: ['Kept correction']});
        expect(f.tasks[0].historyReadUnavailable).toBeUndefined();
    });
    it('reports an unavailable history reopen without treating it as a missing record', async () => {
        const f = importFixture();f.ports.history = {loadChecked: vi.fn().mockResolvedValue({status: 'unavailable'})};
        await f.workflow.openHistory('history');
        expect(f.ports.onHistoryUnavailable).toHaveBeenCalledOnce();
        expect(f.ports.onHistoryMissing).not.toHaveBeenCalled();expect(f.tasks).toEqual([]);
    });
    it('rejects files independently, leaves existing corrections untouched, and selects the first readable task only', async () => {
        const f = importFixture(), existing = task();f.tasks.push(existing);
        const huge = new File(['Source.'], 'huge.txt');Object.defineProperty(huge, 'size', {value: DOCUMENT_MAX_BYTES + 1});
        await f.workflow.loadFiles([new File(['bad'], 'bad.exe'), huge, new File([''], 'empty.txt'), new File(['Source.'], 'first.txt'), new File(['Next.'], 'next.txt')]);
        expect(f.tasks.slice(1, 4).map(item => item.error)).toEqual([
            expect.stringContaining('暂不支持'), expect.stringContaining('文件大小超过'), expect.stringContaining('没有找到'),
        ]);
        expect(f.tasks[0]).toBe(existing);expect(existing.translations).toEqual(['Reader correction']);expect(existing.revision).toBe(2);
        expect(vi.mocked(f.ports.appendTask).mock.calls.map(([, select]) => select)).toEqual([false, false, false, true, false]);
        expect(f.ports.onFinished).toHaveBeenCalledOnce();expect(f.ports.onOnlineError).not.toHaveBeenCalled();
    });

    it('owns online progress through parsing and keeps request failures separate from task errors', async () => {
        const f = importFixture(), gate = pending(new File(['Source.'], 'online.txt'));
        vi.mocked(f.ports.fetchPdf).mockReturnValueOnce(gate.promise);
        const running = f.workflow.openOnlinePdf('https://example.test/paper.pdf');
        const options = vi.mocked(f.ports.fetchPdf).mock.calls[0][1]!;
        options.onProgress!({received: 10});expect(f.ports.onDownloadProgress).toHaveBeenCalledWith({received: 10});
        gate.resolve(new File(['Source.'], 'online.txt'));await running;
        expect(f.tasks[0].sourceUrl).toBe('https://example.test/paper.pdf');
        expect(vi.mocked(f.ports.onPhase).mock.calls.map(([phase]) => phase)).toEqual(['idle', 'downloading', 'reading', 'idle']);
        vi.mocked(f.ports.fetchPdf).mockRejectedValueOnce('network failed');await f.workflow.openOnlinePdf('bad');
        expect(f.ports.onOnlineError).toHaveBeenCalledWith('network failed');expect(f.tasks).toHaveLength(1);
    });

    it.each(['cancel', 'dispose'] as const)('discards late parsing and progress after %s and releases its unowned document', async action => {
        const f = importFixture(), parsed = document(), gate = pending(parsed);
        vi.mocked(f.ports.parseFile).mockReturnValueOnce(gate.promise);
        const running = f.workflow.loadFiles([new File(['Source.'], 'source.txt')]);
        const options = vi.mocked(f.ports.parseFile).mock.calls[0][1]!;
        f.workflow[action]();expect(options.signal!.aborted).toBe(true);
        options.onPdfProgress!({completed: 1, total: 1});gate.resolve(parsed);await running;
        expect(f.tasks).toEqual([]);expect(f.ports.onReadProgress).not.toHaveBeenCalled();
        expect(f.ports.releaseDocument).toHaveBeenCalledWith(parsed);expect(f.ports.onFinished).not.toHaveBeenCalled();
        if (action === 'cancel') {await f.workflow.loadFiles([new File(['New.'], 'new.txt')]);expect(f.tasks[0].name).toBe('new.txt');}
        else {await f.workflow.loadFiles([new File(['New.'], 'new.txt')]);expect(f.tasks).toEqual([]);}
    });

    it('does not let an older online rejection clear or fail its replacement operation', async () => {
        const f = importFixture(), old = pending(new File(['Source.'], 'old.txt')), next = pending(document('new.txt'));
        vi.mocked(f.ports.fetchPdf).mockReturnValueOnce(old.promise);
        const first = f.workflow.openOnlinePdf('old');const options = vi.mocked(f.ports.fetchPdf).mock.calls[0][1]!;
        vi.mocked(f.ports.parseFile).mockReturnValueOnce(next.promise);
        const second = f.workflow.loadFiles([new File(['New.'], 'new.txt')]);
        options.onProgress!({received: 99, total: 100});old.reject(new Error('late'));await first;
        expect(f.ports.onOnlineError).not.toHaveBeenCalled();expect(f.ports.onDownloadProgress).not.toHaveBeenCalled();
        expect(f.ports.onPhase).toHaveBeenLastCalledWith('reading');
        next.resolve(document('new.txt'));await second;expect(f.tasks.map(item => item.name)).toEqual(['new.txt']);
    });

    it('accepts a scanned PDF without text and publishes parse failure text on only the new task', async () => {
        const f = importFixture(), pdf = {...document(), segments: [], binary: {kind: 'pdf', bytes: new Uint8Array([1]), pages: []}} as ParsedDocument;
        vi.mocked(f.ports.parseFile).mockResolvedValueOnce(pdf).mockRejectedValueOnce('broken file');
        await f.workflow.loadFiles([new File(['pdf'], 'scan.pdf'), new File(['bad'], 'bad.txt')]);
        expect(f.tasks[0].document).toBe(pdf);expect(f.tasks[0].error).toBe('');expect(f.tasks[1].error).toBe('broken file');
    });

    it('uses parsed PDF source bytes for restart history and forwards progress only while import owns the document', async () => {
        const f = importFixture();f.ports.history = f.history;
        const bytes = new Uint8Array([1, 2, 3]);
        const pdf = {...document(), fileName: 'restart.pdf', format: 'pdf', binary: {kind: 'pdf', bytes, pages: []}} as ParsedDocument;
        const saved = {...record(pdf), bypassCache: true, translations: [''], completed: 0, bytes};
        f.load.mockResolvedValue(saved);
        vi.mocked(f.ports.parseFile).mockImplementationOnce(async (_file, options) => {
            options!.onPdfProgress!({completed: 1, total: 2});
            return pdf;
        });
        const input = new File([bytes], 'restart.pdf');
        const reading = vi.spyOn(input, 'arrayBuffer');
        await f.workflow.loadFiles([input]);
        expect(reading).not.toHaveBeenCalled();
        expect(f.ports.onReadProgress).toHaveBeenCalledWith({completed: 1, total: 2});
        expect(f.tasks[0]).toMatchObject({bytes, bypassCache: true, translations: ['']});
    });

    it('ignores an obsolete parsing rejection after cancel instead of publishing a failed restart task', async () => {
        const f = importFixture(), parsed = pending(document());
        vi.mocked(f.ports.parseFile).mockReturnValueOnce(parsed.promise);
        const running = f.workflow.loadFiles([new File(['Source.'], 'restart.txt')]);
        f.workflow.cancel();parsed.reject(new Error('late parse failure'));
        await running;
        expect(f.tasks).toEqual([]);
        expect(f.ports.onOnlineError).not.toHaveBeenCalled();
        expect(f.ports.onFinished).not.toHaveBeenCalled();
    });

    it('restores matching history from file bytes and reuses a current history snapshot without parsing', async () => {
        const f = importFixture();f.ports.history = f.history;f.load.mockResolvedValue(record());
        await f.workflow.loadFiles([new File(['Source.'], 'source.txt', {type: 'text/plain'})]);
        expect(f.tasks[0]).toMatchObject({translations: ['Kept correction'], fingerprint: 'settings', mimeType: 'text/plain'});
        expect(f.tasks[0].bytes).toEqual(new TextEncoder().encode('Source.'));
        vi.mocked(f.ports.parseFile).mockClear();await f.workflow.openHistory('history');
        expect(f.ports.parseFile).not.toHaveBeenCalled();expect(f.tasks[1]).toMatchObject({historyId: 'history', savedRevision: 0, translations: ['Kept correction']});
        f.load.mockResolvedValueOnce(null);await f.workflow.openHistory('missing');expect(f.ports.onHistoryMissing).toHaveBeenCalledOnce();
    });

    it.each([[15, 16], [17, 18]])('reparses an obsolete version %i history snapshot for version %i and recovers edits by matching original text', async (obsoleteVersion, currentVersion) => {
        const f = importFixture();f.ports.history = f.history;f.ports.parsedVersion = currentVersion;
        f.load.mockResolvedValue(record(document(), obsoleteVersion));
        await f.workflow.openHistory('history');expect(f.ports.parseFile).toHaveBeenCalledOnce();
        expect(f.tasks[0].translations).toEqual(['Kept correction']);expect(f.tasks[0].historyId).toBeTruthy();
        await f.workflow.loadFiles([]);expect(f.ports.onFinished).toHaveBeenCalledOnce();
        f.load.mockResolvedValue(record(f.tasks[0].document!, currentVersion));
        await f.workflow.openHistory('history');expect(f.ports.parseFile).toHaveBeenCalledOnce();
        expect(f.tasks[1].document).toBe(f.tasks[0].document);expect(f.tasks[1].translations).toEqual(['Kept correction']);
    });

    it.each([undefined, false, true, 'true', 1])('restores only an explicit cache bypass through same-file import and history snapshots: %j', async bypassCache => {
        const f = importFixture();f.ports.history = f.history;
        const saved = {...record(), bypassCache: bypassCache as boolean, translations: [''], completed: 0};
        f.load.mockResolvedValue(saved);
        await f.workflow.loadFiles([new File(['Source.'], 'source.txt', {type: 'text/plain'})]);
        expect(f.tasks[0]).toMatchObject({bypassCache: bypassCache === true, translations: ['']});
        await f.workflow.openHistory('history');
        expect(f.tasks[1]).toMatchObject({bypassCache: bypassCache === true, translations: ['']});
        saved.parsedVersion = 15;
        await f.workflow.openHistory('history');
        expect(f.tasks[2]).toMatchObject({bypassCache: bypassCache === true, translations: ['']});
        f.load.mockResolvedValueOnce(null);
        await f.workflow.loadFiles([new File(['New.'], 'different.txt')]);
        expect(f.tasks[3].bypassCache).toBe(false);
    });

    it.each(['bytes', 'history'] as const)('checks cancellation again after pending %s before advancing import', async stage => {
        const f = importFixture();f.ports.history = f.history;
        const buffer = new ArrayBuffer(7);new Uint8Array(buffer).set(new TextEncoder().encode('Source.'));
        const bytes = pending(buffer), saved = pending<DocumentHistoryRecord | null>(record());
        const input = new File(['Source.'], 'source.txt');
        const reading = vi.spyOn(input, 'arrayBuffer');
        if (stage === 'bytes') {
            vi.mocked(f.ports.parseFile).mockResolvedValueOnce(document());
            reading.mockReturnValueOnce(bytes.promise);
        }
        else f.load.mockReturnValueOnce(saved.promise);
        const running = f.workflow.loadFiles([input]);
        if (stage === 'history') await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
        else await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
        f.workflow.cancel();bytes.resolve(buffer);saved.resolve(record());await running;
        expect(f.tasks).toEqual([]);expect(f.ports.onFinished).not.toHaveBeenCalled();
    });

    it('ignores pending history lookups after disposal and handles disabled history as missing', async () => {
        const f = importFixture();await f.workflow.openHistory('disabled');expect(f.ports.onHistoryMissing).toHaveBeenCalledOnce();
        f.ports.history = f.history;const gate = pending<DocumentHistoryRecord | null>(record());f.load.mockReturnValueOnce(gate.promise);
        const running = f.workflow.openHistory('history');f.workflow.dispose();gate.resolve(record());await running;
        expect(f.tasks).toEqual([]);
    });

    it('stops a multi-file import when its synchronous task consumer cancels the remaining queue', async () => {
        const f = importFixture();
        vi.mocked(f.ports.appendTask).mockImplementationOnce(item => {f.tasks.push(item);f.workflow.cancel();});
        await f.workflow.loadFiles([new File(['First.'], 'first.txt'), new File(['Second.'], 'second.txt')]);
        expect(f.tasks.map(item => item.name)).toEqual(['first.txt']);expect(f.ports.parseFile).toHaveBeenCalledOnce();
    });

    it('drops import after its pending content digest is invalidated, and tolerates unavailable digest support', async () => {
        const f = importFixture();f.ports.history = f.history;
        const digest = pending(new Uint8Array(32).buffer);
        const hash = vi.spyOn(globalThis.crypto.subtle, 'digest').mockReturnValueOnce(digest.promise);
        const running = f.workflow.loadFiles([new File(['Source.'], 'source.txt')]);
        await vi.waitFor(() => expect(hash).toHaveBeenCalledOnce());f.workflow.cancel();
        digest.resolve(new Uint8Array(32).buffer);await running;expect(f.load).not.toHaveBeenCalled();expect(f.tasks).toEqual([]);
        hash.mockRejectedValueOnce(new Error('digest unavailable'));
        await f.workflow.loadFiles([new File(['Source.'], 'unhashed.txt')]);
        expect(f.tasks[0].historyId).toBe('');expect(f.tasks[0].historyReadUnavailable).toBe(true);
        expect(f.tasks[0].translations).toEqual([]);expect(f.load).not.toHaveBeenCalled();
        f.tasks[0].translations = ['Unsaved edit'];f.tasks[0].revision = 1;
        await f.workflow.loadFiles([new File(['Source.'], 'unhashed.txt')]);
        expect(f.tasks[0].translations).toEqual(['Unsaved edit']);
        expect(f.tasks[1].historyId).toBeTruthy();expect(f.tasks[1].historyReadUnavailable).toBeUndefined();
        expect(f.load).toHaveBeenCalledOnce();
    });
});

describe('document recognition workflow ownership', () => {
    function fixture() {
        const ports: DocumentRecognitionPorts = {recognize: vi.fn(async value => value), createRecognizer: vi.fn(() => async () => []), onProgress: vi.fn()};
        const workflow = createDocumentRecognitionWorkflow(ports);cleanups.push(workflow.dispose);
        const parent = new AbortController();let current = true;
        const options = {sourceLanguage: 'en', startPage: 2, signal: parent.signal, isCurrent: () => current};
        return {ports, workflow, parent, options, supersede: () => {current = false;}};
    }
    it('freezes recognizer settings and removes its parent listener after success or current failure', async () => {
        const f = fixture(), add = vi.spyOn(f.parent.signal, 'addEventListener'), remove = vi.spyOn(f.parent.signal, 'removeEventListener');
        const source = document();expect(await f.workflow.recognize(source, f.options)).toBe(source);
        expect(f.ports.createRecognizer).toHaveBeenCalledWith('en');expect(vi.mocked(f.ports.recognize).mock.calls[0][2]?.startPage).toBe(2);
        expect(remove.mock.calls[0]).toEqual(add.mock.calls[0].slice(0, 2));
        vi.mocked(f.ports.recognize).mockRejectedValueOnce(new Error('OCR unavailable'));
        await expect(f.workflow.recognize(source, f.options)).rejects.toThrow('OCR unavailable');
        expect(f.ports.onProgress).toHaveBeenLastCalledWith(null);
    });
    it.each(['parent', 'cancel', 'dispose', 'session', 'replacement'] as const)('drops late OCR progress/results after %s invalidation', async action => {
        const f = fixture(), gate = pending(document());vi.mocked(f.ports.recognize).mockReturnValueOnce(gate.promise);
        const running = f.workflow.recognize(document(), f.options);const controls = vi.mocked(f.ports.recognize).mock.calls[0][2]!;
        controls.onProgress!({completed: 1, total: 2});expect(f.ports.onProgress).toHaveBeenLastCalledWith({completed: 1, total: 2});
        if (action === 'parent') f.parent.abort();else if (action === 'session') f.supersede();
        else if (action === 'replacement') await f.workflow.recognize(document('next.txt'), f.options);else f.workflow[action]();
        vi.mocked(f.ports.onProgress).mockClear();controls.onProgress!({completed: 2, total: 2});gate.resolve(document());
        expect(await running).toBeNull();expect(vi.mocked(f.ports.onProgress).mock.calls.every(([value]) => value === null)).toBe(true);
        expect(controls.signal!.aborted).toBe(action !== 'session');
    });
    it('does not start when disposed, already aborted or no longer the captured session, and absorbs obsolete rejection', async () => {
        const f = fixture(), gate = pending(document());vi.mocked(f.ports.recognize).mockReturnValueOnce(gate.promise);
        const running = f.workflow.recognize(document(), f.options);f.workflow.cancel();gate.reject('late');expect(await running).toBeNull();
        f.supersede();expect(await f.workflow.recognize(document(), f.options)).toBeNull();
        f.parent.abort();expect(await f.workflow.recognize(document(), f.options)).toBeNull();
        f.workflow.dispose();expect(await f.workflow.recognize(document(), f.options)).toBeNull();expect(f.ports.recognize).toHaveBeenCalledOnce();
    });
});

function exportFixture() {
    const current = task(), tasks = [current], payload: DocumentDownload = {data: 'exported', mimeType: 'text/plain', fileName: 'result.txt'};
    let selected: DocumentQueueItem | null = current;
    const ports: DocumentExportPorts = {
        createDownload: vi.fn(async () => payload), createArchive: vi.fn(async () => new JSZip()), generateArchive: vi.fn(generateDocumentArchive),
        isActiveTask: value => selected === value, containsTask: value => tasks.includes(value),
        createUrl: vi.fn(() => 'blob:export'), revokeUrl: vi.fn(), triggerDownload: vi.fn(),
        onState: vi.fn(), onStart: vi.fn(), onProgress: vi.fn(), onComplete: vi.fn(), onError: vi.fn(), onNoticeExpired: vi.fn(),
    };
    const workflow = createDocumentExportWorkflow(ports);cleanups.push(workflow.dispose);
    return {ports, workflow, current, tasks, payload, select: (value: DocumentQueueItem | null) => {selected = value;}};
}
describe('document export workflow ownership', () => {
    it('captures corrections and revision at invocation and releases URLs and notices exactly once', async () => {
        vi.useFakeTimers();const f = exportFixture(), gate = pending(f.payload);vi.mocked(f.ports.createDownload).mockReturnValueOnce(gate.promise);
        const running = f.workflow.single(f.current, 'bilingual', 'readable');
        f.current.translations[0] = 'New correction';f.current.revision = 3;
        const options = vi.mocked(f.ports.createDownload).mock.calls[0][3]!;
        options.onPdfProgress!({phase: 'rendering', completedPages: 1, totalPages: 2});options.onArchiveProgress!(42);
        expect(f.ports.onProgress).toHaveBeenCalledWith({kind: 'single', percent: 42});
        gate.resolve(f.payload);await running;
        expect(vi.mocked(f.ports.createDownload).mock.calls[0].slice(0, 3)).toEqual([f.current.document, ['Reader correction'], 'bilingual']);
        expect(options.pdfPresentation).toBe('readable');expect(f.current.downloaded).toBe(2);expect(f.current.revision).toBe(3);
        expect(f.ports.triggerDownload).toHaveBeenCalledWith('blob:export', 'result.txt');
        await vi.advanceTimersByTimeAsync(1000);expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(4000);expect(f.ports.onNoticeExpired).toHaveBeenCalledOnce();
        f.workflow.dispose();expect(vi.getTimerCount()).toBe(0);expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
    });
    it.each(['cancel', 'reset', 'dispose', 'switch', 'document'] as const)('prevents late single bytes and progress from downloading after %s', async action => {
        const f = exportFixture(), gate = pending(f.payload);vi.mocked(f.ports.createDownload).mockReturnValueOnce(gate.promise);
        const running = f.workflow.single(f.current, 'translated', 'layout');const options = vi.mocked(f.ports.createDownload).mock.calls[0][3]!;
        if (action === 'switch') f.select(null);else if (action === 'document') f.current.document = document('new.txt');else f.workflow[action]();
        options.onArchiveProgress!(99);gate.resolve(f.payload);await running;
        expect(f.ports.onProgress).not.toHaveBeenCalled();expect(f.ports.triggerDownload).not.toHaveBeenCalled();expect(f.current.downloaded).toBe(0);
        if (action === 'cancel') expect(f.ports.onError).toHaveBeenCalledWith('single', expect.anything(), true);
        else expect(f.ports.onError).not.toHaveBeenCalled();
    });
    it('keeps a replacement export busy when an invalidated predecessor settles, and permits retry after a current error', async () => {
        const f = exportFixture(), first = pending(f.payload), next = pending(f.payload);
        vi.mocked(f.ports.createDownload).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
        const old = f.workflow.single(f.current, 'translated', 'layout');
        await f.workflow.single(f.current, 'translated', 'layout');expect(f.ports.createDownload).toHaveBeenCalledOnce();
        f.workflow.reset();const newer = f.workflow.single(f.current, 'translated', 'layout');
        first.reject(new Error('obsolete'));await old;expect(f.ports.onState).toHaveBeenLastCalledWith({busy: true, canceling: false});
        next.reject('current failure');await newer;expect(f.ports.onError).toHaveBeenCalledWith('single', 'current failure', false);
        await f.workflow.single(f.current, 'translated', 'layout');expect(f.current.downloaded).toBe(2);
    });
    it('exports frozen batch revisions with layout presentation and sanitizes duplicate archive paths', async () => {
        const f = exportFixture(), second = task(2);f.tasks.push(second);let blob: Blob | undefined;
        vi.mocked(f.ports.createUrl).mockImplementation(value => {blob = value;return 'blob:zip';});
        vi.mocked(f.ports.createDownload).mockImplementation(async (_doc, values, _mode, options) => {
            options?.onPdfProgress?.({phase: 'saving', completedPages: 1, totalPages: 1});options?.onArchiveProgress?.(10);
            return {...f.payload, data: values.join(''), fileName: '../same.txt'};
        });
        await f.workflow.batch([f.current, second, {...task(3), document: null}], 'translated');
        const zip = await JSZip.loadAsync(await blob!.arrayBuffer());
        expect(await zip.file('1/.._same.txt')!.async('string')).toBe('Reader correction');expect(zip.file('2/.._same.txt')).toBeTruthy();
        expect(vi.mocked(f.ports.createDownload).mock.calls.every(([, , , options]) => options?.pdfPresentation === 'layout')).toBe(true);
        expect(f.ports.onComplete).toHaveBeenCalledWith('batch', 2);expect(second.downloaded).toBe(2);
        expect(f.ports.onProgress).toHaveBeenCalledWith({kind: 'batch', saving: true});
    });
    it.each(['creation', 'file', 'archive', 'removal'] as const)('cancels or invalidates pending batch %s without a download or revision ACK', async stage => {
        const f = exportFixture(), archive = pending(new JSZip()), file = pending(f.payload), bytes = pending(new Uint8Array([1]));
        if (stage === 'creation') vi.mocked(f.ports.createArchive).mockReturnValueOnce(archive.promise);
        if (stage === 'file' || stage === 'removal') vi.mocked(f.ports.createDownload).mockReturnValueOnce(file.promise);
        if (stage === 'archive') vi.mocked(f.ports.generateArchive).mockReturnValueOnce(bytes.promise);
        const running = f.workflow.batch([f.current], 'bilingual');await settle();
        if (stage === 'removal') f.tasks.splice(0);else f.workflow.cancel();
        for (const [, , , options] of vi.mocked(f.ports.createDownload).mock.calls) options?.onArchiveProgress?.(99);
        const before = vi.mocked(f.ports.onProgress).mock.calls.length;
        vi.mocked(f.ports.generateArchive).mock.calls[0]?.[2]?.onProgress?.(99);
        expect(vi.mocked(f.ports.onProgress).mock.calls).toHaveLength(before);
        archive.resolve(new JSZip());file.resolve(f.payload);bytes.resolve(new Uint8Array([1]));await running;
        expect(f.ports.triggerDownload).not.toHaveBeenCalled();expect(f.current.downloaded).toBe(0);
        if (stage !== 'removal') expect(f.ports.onError).toHaveBeenCalledWith('batch', expect.anything(), true);
    });
    it('revokes rejected anchor URLs immediately, retries safely and cancels every owned timer at reset', async () => {
        vi.useFakeTimers();const f = exportFixture();vi.mocked(f.ports.triggerDownload).mockImplementationOnce(() => {throw new Error('blocked');});
        await f.workflow.single(f.current, 'bilingual', 'layout');expect(f.ports.revokeUrl).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
        expect(f.current.downloaded).toBe(0);await f.workflow.single(f.current, 'bilingual', 'layout');expect(vi.getTimerCount()).toBe(2);
        f.workflow.reset();expect(vi.getTimerCount()).toBe(0);expect(f.ports.revokeUrl).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(6000);expect(f.ports.onNoticeExpired).not.toHaveBeenCalled();
    });
    it('replaces the previous successful-export notice timer when downloading again before it expires', async () => {
        vi.useFakeTimers();const f = exportFixture();await f.workflow.single(f.current, 'bilingual', 'layout');
        await vi.advanceTimersByTimeAsync(1000);await f.workflow.single(f.current, 'translated', 'layout');
        await vi.advanceTimersByTimeAsync(4000);expect(f.ports.onNoticeExpired).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);expect(f.ports.onNoticeExpired).toHaveBeenCalledOnce();
    });
    it.each(['handoff-reset', 'handoff-dispose', 'feedback-dispose'] as const)('releases resources if %s occurs synchronously inside a browser or UI port', async action => {
        vi.useFakeTimers();const f = exportFixture();
        if (action === 'feedback-dispose') vi.mocked(f.ports.onComplete).mockImplementationOnce(() => f.workflow.dispose());
        else vi.mocked(f.ports.triggerDownload).mockImplementationOnce(() => action === 'handoff-reset' ? f.workflow.reset() : f.workflow.dispose());
        await f.workflow.single(f.current, 'bilingual', 'layout');
        expect(vi.getTimerCount()).toBe(0);expect(f.ports.revokeUrl).toHaveBeenCalledOnce();
        expect(f.current.downloaded).toBe(action === 'feedback-dispose' ? 2 : 0);
        if (action !== 'feedback-dispose') expect(f.ports.onComplete).not.toHaveBeenCalled();
    });
    it('ignores empty, disposed and documentless exports, including original-blob handoff after disposal', async () => {
        const f = exportFixture();f.workflow.cancel();await f.workflow.batch([], 'bilingual');
        await f.workflow.single({...task(), document: null}, 'translated', 'layout');
        f.workflow.dispose();await f.workflow.single(f.current, 'translated', 'layout');f.workflow.saveBlob(new Blob(['old']), 'old.txt');
        expect(f.ports.createDownload).not.toHaveBeenCalled();expect(f.ports.createUrl).not.toHaveBeenCalled();
    });
});
