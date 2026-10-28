import {IDBFactory} from 'fake-indexeddb';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDocumentHistoryCommitter} from '@/src/features/document-translation/services/historyCommitter';
import {createDocumentHistory, type DocumentHistoryRecord} from '@/src/features/document-translation/services/history';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
const record = (id: string, text: string): DocumentHistoryRecord => ({
    id, name: 'notes.txt', format: 'text', size: 1, total: 1, completed: 1, updatedAt: 1,
    bytes: new Uint8Array([1]), mimeType: 'text/plain', translations: [text], fingerprint: 'settings',
});
const flush = async () => {for (let step = 0; step < 5; step++) await Promise.resolve();};
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});

describe('document history durable revision ownership', () => {
    it('uses the committed version for a later queued edit by the same owner', async () => {
        const history = createDocumentHistory(new IDBFactory()), start = deferred<void>();
        const loaded = await history.loadChecked('same');
        if (loaded.status !== 'ok') throw new Error('expected readable');
        const owner: {revision: number; savedRevision?: number; historyVersion: string | null} = {revision: 1, historyVersion: loaded.version};
        let calls = 0;
        const writer = createDocumentHistoryCommitter<typeof owner>(async (value, current) => {
            if (++calls === 1) await start.promise;
            const result = await history.saveChecked(value, current.historyVersion);
            if (result.status !== 'saved') return false;
            current.historyVersion = result.version;return true;
        });
        const first = writer.save(owner, record('same', 'Earlier'));
        owner.revision = 2;const second = writer.save(owner, record('same', 'Latest'));
        start.resolve();
        expect(await first).toBe(true);expect(await second).toBe(true);
        expect(owner.savedRevision).toBe(2);expect((await history.load('same'))?.translations).toEqual(['Latest']);
    });
    it('acknowledges only committed writes and deduplicates the same pending revision', async () => {
        const commit = deferred<boolean>();
        const save = vi.fn<(value: DocumentHistoryRecord) => Promise<boolean>>().mockReturnValueOnce(commit.promise).mockResolvedValue(true);
        const writer = createDocumentHistoryCommitter(save);
        const task: {revision: number; savedRevision?: number} = {revision: 0};
        const first = writer.save(task, record('file', 'First'));
        expect(writer.save(task, record('file', 'First'))).toBe(first);
        await flush();
        expect(task.savedRevision).toBeUndefined();
        expect(save).toHaveBeenCalledOnce();
        commit.resolve(true);
        expect(await first).toBe(true);
        expect(task.savedRevision).toBe(0);
        expect(await writer.save(task, record('file', 'First'))).toBe(true);
        expect(save).toHaveBeenCalledOnce();
        task.revision = 1;
        await writer.save(task, record('file', 'Second'));
        expect(task.savedRevision).toBe(1);
        expect(save).toHaveBeenCalledTimes(2);
    });

    it.each(['refused', 'rejected'] as const)('keeps a %s revision dirty and retries the same revision', async failure => {
        const save = vi.fn<(value: DocumentHistoryRecord) => Promise<boolean>>().mockResolvedValue(true);
        if (failure === 'refused') save.mockResolvedValueOnce(false);
        else save.mockRejectedValueOnce(new Error('Database unavailable'));
        const writer = createDocumentHistoryCommitter(save);
        const task: {revision: number; savedRevision?: number} = {revision: 3, savedRevision: 2};
        expect(await writer.save(task, record('file', 'Reader correction'))).toBe(false);
        expect(task.savedRevision).toBe(2);
        expect(await writer.save(task, record('file', 'Reader correction'))).toBe(true);
        expect(task.savedRevision).toBe(3);
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('serializes the same material while allowing unrelated documents to commit independently', async () => {
        const earlier = deferred<boolean>();
        const save = vi.fn<(value: DocumentHistoryRecord) => Promise<boolean>>().mockReturnValueOnce(earlier.promise).mockResolvedValue(true);
        const writer = createDocumentHistoryCommitter(save);
        const task = {revision: 1, savedRevision: 0}, other = {revision: 1};
        const first = writer.save(task, record('same', 'Earlier'));
        task.revision = 2;
        const second = writer.save(task, record('same', 'Latest'));
        const independent = writer.save(other, record('other', 'Independent'));
        await independent;
        expect(save.mock.calls.map(([value]) => value.translations[0])).toEqual(['Earlier', 'Independent']);
        expect(task.savedRevision).toBe(0);
        earlier.resolve(true);
        await first;
        expect(task.savedRevision).toBe(1);
        await second;
        expect(task.savedRevision).toBe(2);
        expect(save.mock.calls.map(([value]) => value.translations[0])).toEqual(['Earlier', 'Independent', 'Latest']);
    });

    it('does not let a late acknowledgement lower a newer saved revision and advances after synchronous storage failure', async () => {
        const earlier = deferred<boolean>();
        const save = vi.fn<(value: DocumentHistoryRecord) => Promise<boolean>>().mockReturnValueOnce(earlier.promise)
            .mockImplementationOnce(() => {throw new Error('Storage revoked');}).mockResolvedValue(true);
        const writer = createDocumentHistoryCommitter(save);
        const task = {revision: 1, savedRevision: 0};
        const first = writer.save(task, record('file', 'Earlier'));
        await flush();
        task.savedRevision = 2;
        earlier.resolve(true);
        await first;
        expect(task.savedRevision).toBe(2);
        task.revision = 3;
        expect(await writer.save(task, record('file', 'Latest'))).toBe(false);
        expect(task.savedRevision).toBe(2);
        expect(await writer.save(task, record('file', 'Latest'))).toBe(true);
        expect(task.savedRevision).toBe(3);
    });

    it('revokes a timed-out write before a delayed database open can overwrite the next committed revision', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const factory = new IDBFactory();
        const actualOpen = factory.open.bind(factory);
        const delayed = {} as IDBOpenDBRequest;
        let database!: IDBDatabase;
        const opened = vi.spyOn(factory, 'open').mockReturnValueOnce(delayed).mockImplementation((name, version) => {
            const request = actualOpen(name, version);
            request.addEventListener('success', () => {database = request.result;});
            return request;
        });
        const history = createDocumentHistory(factory, 30);
        const writer = createDocumentHistoryCommitter(value => history.save(value));
        const task = {revision: 1, savedRevision: 0};
        const first = writer.save(task, record('same', 'Earlier correction'));
        await flush();
        expect(opened).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30);
        expect(await first).toBe(false);
        expect(task.savedRevision).toBe(0);
        task.revision = 2;
        expect(await writer.save(task, record('same', 'Latest correction'))).toBe(true);
        expect(task.savedRevision).toBe(2);
        // 真实 IndexedDB 的两次 open 各有独立连接；旧请求迟到后释放自己的连接，不能借用当前已恢复的连接。
        const lateDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = actualOpen('FluentReadDocumentHistory', 2);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const transactions = vi.spyOn(lateDatabase, 'transaction');
        const close = vi.spyOn(lateDatabase, 'close');
        Object.defineProperty(delayed, 'result', {value: lateDatabase});
        delayed.onsuccess!(new Event('success'));
        await flush();
        expect(transactions).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect((await history.load('same'))?.translations).toEqual(['Latest correction']);
        expect(await writer.save(task, record('same', 'Latest correction'))).toBe(true);
        expect(task.savedRevision).toBe(2);
        database.close();
    });

    it('aborts a timed-out transaction after put succeeds so the queued revision commits without a late overwrite', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const factory = new IDBFactory();
        const actualOpen = factory.open.bind(factory);
        const putSucceeded = deferred<void>();
        const aborted = deferred<void>();
        let intercept = true;
        vi.spyOn(factory, 'open').mockImplementation((name, version) => {
            const request = actualOpen(name, version);
            request.addEventListener('success', () => {
                const database = request.result;
                const transact = database.transaction.bind(database);
                vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                    const transaction = transact(stores, mode, options);
                    if (mode === 'readwrite' && intercept) {
                        intercept = false;
                        transaction.addEventListener('abort', () => aborted.resolve());
                        const objectStore = transaction.objectStore.bind(transaction);
                        vi.spyOn(transaction, 'objectStore').mockImplementation(store => {
                            const target = objectStore(store);
                            const put = target.put.bind(target);
                            vi.spyOn(target, 'put').mockImplementation(value => {
                                const stored = put(value);
                                stored.addEventListener('success', () => {
                                    putSucceeded.resolve();
                                    vi.advanceTimersByTime(30);
                                });
                                return stored;
                            });
                            return target;
                        });
                    }
                    return transaction;
                });
            });
            return request;
        });
        const history = createDocumentHistory(factory, 30);
        const writer = createDocumentHistoryCommitter(value => history.save(value));
        const task = {revision: 1, savedRevision: 0};
        const first = writer.save(task, record('same', 'Earlier correction'));
        task.revision = 2;
        const second = writer.save(task, record('same', 'Latest correction'));
        await putSucceeded.promise;
        expect(task.savedRevision).toBe(0);
        expect(await first).toBe(false);
        await aborted.promise;
        expect(await second).toBe(true);
        expect(task.savedRevision).toBe(2);
        expect((await history.load('same'))?.translations).toEqual(['Latest correction']);
    });

    it('acknowledges a real database write only after its transaction commits', async () => {
        const factory = new IDBFactory();
        const actualOpen = factory.open.bind(factory);
        const task = {revision: 1, savedRevision: 0};
        const savedRevisionsAtRequestSuccess: number[] = [];
        const savedRevisionsAtCommit: number[] = [];
        vi.spyOn(factory, 'open').mockImplementation((name, version) => {
            const request = actualOpen(name, version);
            request.addEventListener('success', () => {
                const database = request.result;
                const transact = database.transaction.bind(database);
                vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                    const transaction = transact(stores, mode, options);
                    if (mode === 'readwrite') {
                        transaction.addEventListener('complete', () => savedRevisionsAtCommit.push(task.savedRevision));
                        const objectStore = transaction.objectStore.bind(transaction);
                        vi.spyOn(transaction, 'objectStore').mockImplementation(store => {
                            const target = objectStore(store);
                            const put = target.put.bind(target);
                            vi.spyOn(target, 'put').mockImplementation(value => {
                                const stored = put(value);
                                if (target.name === 'documents') stored.addEventListener('success', () => savedRevisionsAtRequestSuccess.push(task.savedRevision));
                                return stored;
                            });
                            return target;
                        });
                    }
                    return transaction;
                });
            });
            return request;
        });
        const history = createDocumentHistory(factory);
        const writer = createDocumentHistoryCommitter(value => history.save(value));
        expect(await writer.save(task, record('same', 'Reader correction'))).toBe(true);
        expect(savedRevisionsAtRequestSuccess).toEqual([0]);
        expect(savedRevisionsAtCommit).toEqual([0]);
        expect(task.savedRevision).toBe(1);
        expect((await history.load('same'))?.translations).toEqual(['Reader correction']);
    });

    it('keeps an uncloneable revision dirty after aborting the transaction and can retry it', async () => {
        const history = createDocumentHistory(new IDBFactory());
        const writer = createDocumentHistoryCommitter(value => history.save(value));
        const task = {revision: 1, savedRevision: 0};
        expect(await writer.save(task, {...record('same', 'Reader correction'), parsed: {callback: () => {}}})).toBe(false);
        expect(task.savedRevision).toBe(0);
        expect(await history.load('same')).toBeNull();
        expect(await writer.save(task, record('same', 'Reader correction'))).toBe(true);
        expect(task.savedRevision).toBe(1);
        expect((await history.load('same'))?.translations).toEqual(['Reader correction']);
    });

    it('keeps a revision dirty when its deadline races an already committed transaction and does not resume later reads', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const factory = new IDBFactory();
        const actualOpen = factory.open.bind(factory);
        const firstModes: IDBTransactionMode[] = [];
        let intercept = true;
        vi.spyOn(factory, 'open').mockImplementation((name, version) => {
            const request = actualOpen(name, version);
            request.addEventListener('success', () => {
                const database = request.result;
                const transact = database.transaction.bind(database);
                vi.spyOn(database, 'transaction').mockImplementation((stores, mode, options) => {
                    const transaction = transact(stores, mode, options);
                    firstModes.push(mode ?? 'readonly');
                    if (mode === 'readwrite' && intercept) {
                        intercept = false;
                        // 事务已经提交，页面处理 complete 前 deadline 到达；abort 此时按规范抛 InvalidStateError。
                        transaction.addEventListener('complete', () => vi.advanceTimersByTime(30));
                    }
                    return transaction;
                });
            });
            return request;
        });
        const history = createDocumentHistory(factory, 30);
        const writer = createDocumentHistoryCommitter(value => history.save(value));
        const task = {revision: 1, savedRevision: 0};
        expect(await writer.save(task, record('same', 'Earlier correction'))).toBe(false);
        await flush();
        expect(task.savedRevision).toBe(0);
        expect(firstModes).toEqual(['readwrite']);
        task.revision = 2;
        expect(await writer.save(task, record('same', 'Latest correction'))).toBe(true);
        expect(task.savedRevision).toBe(2);
        expect((await history.load('same'))?.translations).toEqual(['Latest correction']);
    });

    it('serializes concurrent capacity changes and never removes a newly committed record due to clock rollback', async () => {
        const factory = new IDBFactory(), first = createDocumentHistory(factory), second = createDocumentHistory(factory);
        for (let index = 0; index < 20; index++) expect(await first.save({...record(`seed-${index}`, 'Old'), updatedAt: index + 10})).toBe(true);
        const missing = await second.loadChecked('new');
        if (missing.status !== 'ok') throw new Error('expected readable');
        const [saved] = await Promise.all([
            second.saveChecked({...record('new', 'New'), updatedAt: -100}, missing.version),
            first.remove('seed-19'),
        ]);
        // If removal wins the transaction race, the absence token deliberately conflicts.
        if (saved.status === 'saved') expect((await second.load('new'))?.translations).toEqual(['New']);
        else expect(saved.status).toBe('conflict');
        expect((await second.list()).length).toBeLessThanOrEqual(20);
    });
});
