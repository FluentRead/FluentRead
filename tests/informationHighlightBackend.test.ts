import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createInformationHighlightBackgroundHandlers} from '@/src/features/information-highlight/background/handlers';
import {createInformationHighlightOffscreenAdapter} from '@/src/features/information-highlight/background/offscreenAdapter';
import {createInformationHighlightModelRuntime, createInformationHighlightModelsRuntime, probeInformationHighlightWebGpu} from '@/src/features/information-highlight/offscreen/runtime';
import {getInformationHighlightArtifactStore} from '@/src/features/information-highlight/offscreen/artifacts';
import {INFORMATION_HIGHLIGHT_MODEL_BYTES} from '@/src/core/config/informationHighlightModel';
import type {InformationHighlightModelStatus, InformationHighlightResult} from '@/src/features/information-highlight/protocol';
import type {OffscreenClient} from '@/src/platform/offscreen/client';

const result: InformationHighlightResult = {spans: [{start: 0, end: 1, score: 2}], engine: 'local'};
const status: InformationHighlightModelStatus = {phase: 'ready', downloaded: true, initialized: false, downloadedBytes: INFORMATION_HIGHLIGHT_MODEL_BYTES, totalBytes: INFORMATION_HIGHLIGHT_MODEL_BYTES, downloadSizeBytes: INFORMATION_HIGHLIGHT_MODEL_BYTES, modelId: 'qwen2.5-0.5b', modelName: 'Qwen2.5 0.5B', supported: true};
type ModelId = 'qwen2.5-0.5b' | 'qwen3-0.6b';
const uuid = '01234567-0123-4123-8123-012345678901';
const flush = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('background identity and existing offscreen transport', () => {
    function fixture() {
        const offscreen = {score: vi.fn(async (_text: string, _signal: AbortSignal, _modelId?: ModelId) => result), status: vi.fn(async (_modelId?: ModelId) => status), prepare: vi.fn(async (_modelId?: ModelId) => status), pause: vi.fn(async (_modelId?: ModelId) => status), remove: vi.fn(async (_modelId?: ModelId) => status)};
        const handlers = createInformationHighlightBackgroundHandlers({runtimeId: 'id', offscreen, isUi: url => url === 'chrome-extension://id/options.html', isDocument: url => url === 'chrome-extension://id/document.html'});
        const send = (type: string, payload = {}, sender: unknown = {id: 'id', url: 'https://example.com', tab: {id: 1}, frameId: 0, documentId: 'doc'}) => handlers.find(handler => handler.type === type)!.handle({type, ...payload}, {sender});
        return {offscreen, send};
    }
    it('permits only extension UI to change assets and validates the public UUID/text/sender', async () => {
        const {send, offscreen} = fixture();
        for (const type of ['GET_INFORMATION_HIGHLIGHT_MODEL_STATUS','PREPARE_INFORMATION_HIGHLIGHT_MODEL','PAUSE_INFORMATION_HIGHLIGHT_MODEL','REMOVE_INFORMATION_HIGHLIGHT_MODEL']) {
            expect(await send(type, {}, {id: 'id', url: 'chrome-extension://id/options.html'})).toEqual({success: true, status});
            await expect(send(type, {}, {id: 'other'})).rejects.toThrow('UNTRUSTED');
        }
        await expect(send('PREPARE_INFORMATION_HIGHLIGHT_MODEL')).rejects.toThrow('UNTRUSTED');
        await expect(send('PREPARE_INFORMATION_HIGHLIGHT_MODEL', {}, {id: 'id'})).rejects.toThrow('UNTRUSTED');
        expect(await send('GET_INFORMATION_HIGHLIGHT_MODEL_STATUS')).toEqual({success: true, status});
        expect(await send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid}, {id: 'id', url: 'chrome-extension://id/document.html', tab: {id: 2}})).toEqual({success: true, result});
        for (const input of [{requestId: 'bad', text: 'a'}, {requestId: uuid, text: ''}, {requestId: uuid, text: 42}, {requestId: uuid, text: 'a'.repeat(12001)}]) await expect(send('SCORE_INFORMATION_HIGHLIGHT', input)).rejects.toThrow();
        for (const sender of [null, {id: 'other'}, {id: 'id'}, {id: 'id', tab: {id: 1}, url: 'chrome-extension://id/unknown.html'}]) {
            await expect(Promise.resolve().then(() => send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid}, sender))).rejects.toThrow();
        }
        expect(offscreen.prepare).toHaveBeenCalledOnce();
        expect(await send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid}, {id: 'id', url: 'chrome-extension://id/document.html'})).toEqual({success: true, result});
    });
    it('routes explicit model identities through management and scoring, and rejects unknown model ids', async () => {
        const {send, offscreen} = fixture();
        const ui = {id: 'id', url: 'chrome-extension://id/options.html'};
        const commands = {GET_INFORMATION_HIGHLIGHT_MODEL_STATUS: 'status', PREPARE_INFORMATION_HIGHLIGHT_MODEL: 'prepare', PAUSE_INFORMATION_HIGHLIGHT_MODEL: 'pause', REMOVE_INFORMATION_HIGHLIGHT_MODEL: 'remove'} as const;
        for (const [type, method] of Object.entries(commands) as Array<[string, typeof commands[keyof typeof commands]]>) {
            await send(type, {modelId: 'qwen3-0.6b'}, ui);
            expect(offscreen[method]).toHaveBeenLastCalledWith('qwen3-0.6b');
            const calls = offscreen[method].mock.calls.length;
            await expect(send(type, {modelId: 'remote-model'}, ui)).rejects.toThrow('INVALID_MODEL');
            expect(offscreen[method]).toHaveBeenCalledTimes(calls);
        }
        await send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid, modelId: 'qwen3-0.6b'});
        expect(offscreen.score).toHaveBeenLastCalledWith('a', expect.any(AbortSignal), 'qwen3-0.6b');
        await expect(send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid, modelId: 'remote-model'})).rejects.toThrow('INVALID_MODEL');
        expect(offscreen.score).toHaveBeenCalledOnce();
    });
    it('cannot cancel another tab/frame/document and ignores a late result after same-owner cancellation', async () => {
        const {send, offscreen} = fixture(); let resolve!: (result: InformationHighlightResult) => void;
        offscreen.score.mockImplementation(() => new Promise(done => {resolve = done;}));
        const task = Promise.resolve(send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid}));
        const signal = offscreen.score.mock.calls[0][1];
        expect(send('CANCEL_INFORMATION_HIGHLIGHT', {requestId: uuid}, {id: 'id', url: 'https://example.com', tab: {id: 2}})).toEqual({success: true}); expect(signal.aborted).toBe(false);
        expect(send('CANCEL_INFORMATION_HIGHLIGHT', {requestId: uuid})).toEqual({success: true}); expect(signal.aborted).toBe(true);
        await expect(send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid})).rejects.toThrow('BUSY');
        resolve(result); await expect(task).rejects.toMatchObject({name: 'AbortError'});
        for (let i = 0; i < 513; i++) send('CANCEL_INFORMATION_HIGHLIGHT', {requestId: uuid.replace(/\d{4}$/u, String(i).padStart(4,'0'))});
        await expect(send('SCORE_INFORMATION_HIGHLIGHT', {text: 'a', requestId: uuid.replace(/\d{4}$/u, '0512')})).rejects.toMatchObject({name: 'AbortError'});
    });
    it('binds all adapter commands and cancellation to existing client, and preserves model errors', async () => {
        const send = vi.fn(async (_message: unknown, _options: unknown) => ({success: true, status, result}));
        const adapter = createInformationHighlightOffscreenAdapter({send} as unknown as OffscreenClient);
        for (const command of ['status','prepare','pause','remove'] as const) expect(await adapter[command]()).toEqual(status);
        for (const [command, type] of [['status', 'STATUS'], ['prepare', 'PREPARE'], ['pause', 'PAUSE'], ['remove', 'REMOVE']] as const) {
            await adapter[command]('qwen3-0.6b');
            expect(send).toHaveBeenLastCalledWith({type: `INFORMATION_HIGHLIGHT_${type}_OFFSCREEN`, modelId: 'qwen3-0.6b'}, expect.any(Object));
        }
        const signal = new AbortController().signal; expect(await adapter.score('a', signal)).toEqual(result);
        const options = send.mock.calls.at(-1)![1] as {cancelMessage: {requestId: string}; signal: AbortSignal}; expect(options.signal).toBe(signal); expect(options.cancelMessage.requestId).toMatch(/^[0-9a-f-]{36}$/u);
        await adapter.score('a', signal, 'qwen3-0.6b');
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({type: 'INFORMATION_HIGHLIGHT_SCORE_OFFSCREEN', modelId: 'qwen3-0.6b', text: 'a'}), expect.objectContaining({signal}));
        send.mockResolvedValueOnce({success: false, error: 'INFORMATION_HIGHLIGHT_TOKEN_LIMIT'} as never); await expect(adapter.score('a', signal)).rejects.toThrow('TOKEN_LIMIT');
        send.mockResolvedValueOnce({success: false} as never); await expect(adapter.status()).rejects.toThrow('FAILED');
        send.mockResolvedValueOnce({success: false, error: 'bad'} as never); await expect(adapter.prepare()).rejects.toThrow('bad');
        send.mockResolvedValueOnce({success: true} as never); await expect(adapter.score('a', signal)).rejects.toThrow('FAILED');
    });
});

describe('model registry keeps downloads independent and shares one GPU worker', () => {
    beforeEach(() => {vi.useFakeTimers(); vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10e9, usage: 0})}});});
    function fixture(customStore = false) {
        const ready = {'qwen2.5-0.5b': true, 'qwen3-0.6b': true};
        const stores = (['qwen2.5-0.5b', 'qwen3-0.6b'] as const).map(modelId => {
            const store = getInformationHighlightArtifactStore(modelId);
            return {modelId, complete: vi.spyOn(store, 'complete').mockImplementation(async () => ready[modelId]),
                downloaded: vi.spyOn(store, 'downloaded').mockResolvedValue(0),
                download: vi.spyOn(store, 'download').mockImplementation(async (file, _signal, progress) => {progress?.(file.size, false); ready[modelId] = true;}),
                remove: vi.spyOn(store, 'remove').mockImplementation(async () => {ready[modelId] = false;})};
        });
        const workers: Array<{postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((event: {data: unknown}) => void) | null; onerror: ((event: {message: string}) => void) | null}> = [];
        const createWorker = vi.fn(() => {
            const worker = {postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null};
            workers.push(worker); return worker as unknown as Worker;
        });
        const runtime = createInformationHighlightModelsRuntime({createWorker, probe: async () => ({supported: true}), notify: vi.fn(), budget: async run => run(), ...(customStore ? {store: getInformationHighlightArtifactStore} : {})});
        const answer = (index: number, output = result) => {
            const worker = workers[index], request = worker.postMessage.mock.calls.findLast(([message]) => message.type === 'score')![0];
            worker.onmessage?.({data: {requestId: request.requestId, success: true, initialized: true, result: output}});
        };
        return {runtime, ready, stores, workers, createWorker, answer};
    }
    it('reads default or supplied registry stores for status without creating a worker or downloading files', async () => {
        for (const customStore of [false, true]) {
            const value = fixture(customStore);
            expect(await value.runtime.status('qwen3-0.6b')).toMatchObject({modelId: 'qwen3-0.6b', downloaded: true});
            expect(value.stores[1].complete).toHaveBeenCalledTimes(6);
            expect(value.createWorker).not.toHaveBeenCalled(); expect(value.stores[1].download).not.toHaveBeenCalled();
            value.runtime.dispose(); vi.restoreAllMocks();
        }
    });
    it('serializes model switches, releases the previous worker, and ignores its late response', async () => {
        const value = fixture();
        const first = value.runtime.score('a', new AbortController().signal, 'qwen2.5-0.5b'); await flush();
        const stale = value.workers[0].onmessage!;
        const second = value.runtime.score('a', new AbortController().signal, 'qwen3-0.6b'); await flush();
        expect(value.createWorker).toHaveBeenCalledOnce();
        value.answer(0); expect(await first).toEqual(result); await flush();
        expect(value.workers[0].terminate).toHaveBeenCalledOnce(); expect(value.createWorker).toHaveBeenCalledTimes(2);
        expect(value.workers[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({modelId: 'qwen3-0.6b'}));
        stale({data: {requestId: 1, success: true, initialized: true, result: {spans: [], engine: 'stale Qwen2'}}});
        const newerResult = {...result, engine: 'Qwen3'}; value.answer(1, newerResult); expect(await second).toEqual(newerResult);
        expect(await value.runtime.status('qwen2.5-0.5b')).toMatchObject({modelId: 'qwen2.5-0.5b', downloaded: true, initialized: false});
        expect(await value.runtime.status('qwen3-0.6b')).toMatchObject({modelId: 'qwen3-0.6b', downloaded: true, initialized: true});
        const third = value.runtime.score('a', new AbortController().signal); await flush();
        expect(value.workers[1].terminate).toHaveBeenCalledOnce(); expect(value.createWorker).toHaveBeenCalledTimes(3);
        value.answer(2); await third;
        expect(value.stores.every(store => !store.download.mock.calls.length)).toBe(true);
        value.runtime.dispose();
    });
    it('pauses and removes only the selected model while keeping the other model assets ready', async () => {
        const value = fixture(); value.ready['qwen3-0.6b'] = false; let downloadSignal!: AbortSignal;
        value.stores[1].download.mockImplementationOnce((_file, signal) => new Promise((_resolve, reject) => {
            downloadSignal = signal; signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')));
        }));
        await value.runtime.prepare('qwen3-0.6b'); await flush();
        expect(downloadSignal.aborted).toBe(false);
        await value.runtime.pause('qwen2.5-0.5b'); expect(downloadSignal.aborted).toBe(false);
        expect(await value.runtime.status()).toMatchObject({downloaded: true, modelId: 'qwen2.5-0.5b'});
        await value.runtime.pause('qwen3-0.6b'); await flush(); expect(downloadSignal.aborted).toBe(true);
        await value.runtime.remove('qwen3-0.6b'); expect(value.stores[1].remove).toHaveBeenCalled(); expect(value.stores[0].remove).not.toHaveBeenCalled();
        expect(await value.runtime.status()).toMatchObject({downloaded: true}); expect(value.stores[0].download).not.toHaveBeenCalled();
        expect(value.createWorker).not.toHaveBeenCalled(); value.runtime.dispose();
    });
    it('does not replace the current warm model for a cancelled queued choice and still accepts a later switch', async () => {
        const value = fixture(), cancelled = new AbortController();
        const first = value.runtime.score('a', new AbortController().signal); await flush();
        const queued = value.runtime.score('a', cancelled.signal, 'qwen3-0.6b');
        const cancellation = expect(queued).rejects.toMatchObject({name: 'AbortError'}); cancelled.abort(); await cancellation;
        value.answer(0); await first; await flush();
        expect(value.createWorker).toHaveBeenCalledOnce(); expect(value.workers[0].terminate).not.toHaveBeenCalled();
        expect(await value.runtime.status()).toMatchObject({initialized: true});
        const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
        await expect(value.runtime.score('a', alreadyCancelled.signal, 'qwen3-0.6b')).rejects.toMatchObject({name: 'AbortError'}); await flush();
        expect(value.createWorker).toHaveBeenCalledOnce();
        const newer = value.runtime.score('a', new AbortController().signal, 'qwen3-0.6b'); await flush(); value.answer(1); await newer;
        expect(value.workers[0].terminate).toHaveBeenCalledOnce(); expect(value.createWorker).toHaveBeenCalledTimes(2); value.runtime.dispose();
    });
    it('recovers the shared queue after one model fails and refuses all work after disposal', async () => {
        const value = fixture();
        const failed = value.runtime.score('a', new AbortController().signal, 'qwen3-0.6b');
        const failure = expect(failed).rejects.toThrow('GPU lost'); await flush(); value.workers[0].onerror?.({message: 'GPU lost'}); await failure;
        expect(await value.runtime.status('qwen3-0.6b')).toMatchObject({modelId: 'qwen3-0.6b', phase: 'error', initialized: false});
        const next = value.runtime.score('a', new AbortController().signal); await flush(); value.answer(1); await next;
        expect(await value.runtime.status()).toMatchObject({modelId: 'qwen2.5-0.5b', phase: 'ready', initialized: true});
        value.runtime.dispose(); expect(value.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
        expect(() => value.runtime.status()).toThrow('DISPOSED');
        await expect(value.runtime.score('a', new AbortController().signal, 'qwen3-0.6b')).rejects.toThrow('DISPOSED');
    });
});

describe('bounded model runtime and explicit downloads', () => {
    beforeEach(() => {vi.useFakeTimers(); vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10e9, usage: 0})}});});
    function fixture(ready = true, modelId: ModelId = 'qwen2.5-0.5b') {
        let complete = ready;
        const store = {complete: vi.fn(async () => complete), downloaded: vi.fn(async () => 0), remove: vi.fn(async () => {complete = false;}), download: vi.fn(async (file: {size: number}, _signal: AbortSignal, progress: (bytes: number, verifying: boolean) => void) => {progress(file.size, false); progress(file.size, true); complete = true;}), blob: vi.fn(), match: vi.fn()};
        const worker = {postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((event: {data: unknown}) => void) | null, onerror: null as ((event: {message: string}) => void) | null};
        worker.postMessage.mockImplementation(request => {if (request.type === 'score') queueMicrotask(() => worker.onmessage?.({data: {requestId: request.requestId, success: true, initialized: true, stage: 'scoring'}}));});
        const createWorker = vi.fn(() => worker as unknown as Worker), notify = vi.fn(), probe = vi.fn(async () => ({supported: true}));
        const runtime = createInformationHighlightModelRuntime({modelId, store: store as never, createWorker, notify, probe, budget: async run => run()});
        const answer = (response = {success: true, result, initialized: true}) => worker.onmessage?.({data: {requestId: worker.postMessage.mock.calls.findLast(([request]) => request.type === 'score')![0].requestId, ...response}});
        return {runtime, worker, store, createWorker, notify, probe, answer};
    }
    it('identifies Qwen3 assets and worker requests without overwriting the legacy model status', async () => {
        const legacy = fixture(), newer = fixture(false, 'qwen3-0.6b');
        expect(await newer.runtime.status()).toMatchObject({modelId: 'qwen3-0.6b', modelName: 'Qwen3 0.6B', downloaded: false});
        const newerSize = (await newer.runtime.status()).totalBytes;
        expect(newerSize).toBeGreaterThan(INFORMATION_HIGHLIGHT_MODEL_BYTES);
        await newer.runtime.prepare(); await flush();
        expect(newer.store.download.mock.calls.every(([file]) => (file as {url?: string}).url?.includes('/Qwen3-0.6B-ONNX/'))).toBe(true);
        expect(legacy.store.download).not.toHaveBeenCalled();
        const task = newer.runtime.score('a', new AbortController().signal); await flush();
        expect(newer.worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'score', modelId: 'qwen3-0.6b'}));
        newer.answer(); await task; await newer.runtime.remove();
        expect(await newer.runtime.status()).toMatchObject({downloaded: false, modelId: 'qwen3-0.6b'});
        expect(await legacy.runtime.status()).toMatchObject({downloaded: true, modelId: 'qwen2.5-0.5b'});
        newer.runtime.dispose(); legacy.runtime.dispose();
    });
    it('status does not create a worker/download, caches cheap capability, and rejects inference before prepare', async () => {
        const {runtime, createWorker, store, probe} = fixture(false);
        expect(await runtime.status()).toMatchObject({phase: 'absent', downloaded: false, initialized: false, totalBytes: INFORMATION_HIGHLIGHT_MODEL_BYTES}); await runtime.status(); expect(probe).toHaveBeenCalledOnce();
        expect(store.complete).toHaveBeenCalledTimes(6); vi.advanceTimersByTime(1000); await runtime.status(); expect(store.complete).toHaveBeenCalledTimes(12);
        await expect(runtime.score('a', new AbortController().signal)).rejects.toThrow('NOT_DOWNLOADED'); expect(createWorker).not.toHaveBeenCalled(); expect(store.download).not.toHaveBeenCalled();
        const queued = await runtime.prepare(); expect(queued.phase).toBe('queued'); await flush(); expect(await runtime.status()).toMatchObject({phase: 'ready', downloaded: true}); expect(store.download).toHaveBeenCalledTimes(6);
        await runtime.prepare(); expect(store.download).toHaveBeenCalledTimes(6); const readyReads = store.complete.mock.calls.length;
        vi.advanceTimersByTime(1_000); await runtime.status(); expect(store.complete).toHaveBeenCalledTimes(readyReads);
        vi.advanceTimersByTime(59_000); await runtime.status(); expect(store.complete).toHaveBeenCalledTimes(readyReads + 6); runtime.dispose();
    });
    it('supports partial status, storage errors, pause, resume and targeted removal without source text', async () => {
        const partial = fixture(false); partial.store.downloaded.mockResolvedValue(1); expect(await partial.runtime.status()).toMatchObject({phase: 'paused', downloadedBytes: 6});
        const failed = fixture(false); vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 1, usage: 0})}}); await failed.runtime.prepare(); await flush(); expect(await failed.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_STORAGE_QUOTA'});
        vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10e9})}});
        const value = fixture(false); let reject!: (error: Error) => void;
        value.store.download.mockImplementationOnce((_file, signal) => new Promise((_resolve, no) => {reject = no; signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')));}));
        await value.runtime.prepare(); await flush(); await value.runtime.prepare(); expect(value.store.download).toHaveBeenCalledOnce(); await value.runtime.pause(); await flush(); expect(await value.runtime.status()).toMatchObject({phase: 'absent'});
        await value.runtime.prepare(); await flush(); expect(await value.runtime.status()).toMatchObject({downloaded: true}); await value.runtime.remove(); expect(value.store.remove).toHaveBeenCalledTimes(6); expect(await value.runtime.status()).toMatchObject({phase: 'absent'});
        value.store.remove.mockRejectedValueOnce(new Error('disk')); await expect(value.runtime.remove()).rejects.toThrow('disk'); expect(await value.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_REMOVE_FAILED'});
    });
    it('cancels immediately, lets a cooperative chunk drain, reuses warm worker and releases after idle', async () => {
        const {runtime, worker, createWorker, answer} = fixture(); const controller = new AbortController();
        const task = runtime.score('a', controller.signal); await flush(); expect(createWorker).toHaveBeenCalledOnce();
        controller.abort(); await expect(task).rejects.toMatchObject({name: 'AbortError'}); expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({type: 'cancel'})); answer(); await flush(); expect(worker.terminate).not.toHaveBeenCalled();
        const again = runtime.score('a', new AbortController().signal); await flush(); answer(); expect(await again).toEqual(result); expect(createWorker).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(180_000); expect(worker.terminate).toHaveBeenCalledOnce(); expect(await runtime.status()).toMatchObject({initialized: false});
    });
    it('holds queue ownership while cancelled native inference drains, hard-resets hanging workers and drops queued old owners', async () => {
        const value = fixture(), first = new AbortController(); const task = value.runtime.score('a', first.signal); await flush();
        const queued = value.runtime.score('b', new AbortController().signal); first.abort(); await expect(task).rejects.toMatchObject({name: 'AbortError'}); expect(value.createWorker).toHaveBeenCalledOnce(); vi.advanceTimersByTime(1500); await expect(queued).rejects.toMatchObject({name: 'AbortError'}); expect(value.worker.terminate).toHaveBeenCalledOnce();
        const cancelled = new AbortController(); cancelled.abort(); await expect(value.runtime.score('a', cancelled.signal)).rejects.toMatchObject({name: 'AbortError'});
        const timeout = fixture(); const pending = timeout.runtime.score('a', new AbortController().signal); await flush(); vi.advanceTimersByTime(120_000); await expect(pending).rejects.toThrow('TIMEOUT'); expect(timeout.worker.terminate).toHaveBeenCalledOnce();
    });
    it('isolates late response ids, worker faults and capability failures', async () => {
        const value = fixture(); const pending = value.runtime.score('a', new AbortController().signal); await flush();
        value.worker.onmessage?.({data: {requestId: -1, success: true, result}}); value.worker.onerror?.({message: 'GPU lost'}); await expect(pending).rejects.toThrow('GPU lost');
        const fail = fixture(); const response = fail.runtime.score('a', new AbortController().signal); await flush(); const cachedReads = fail.store.complete.mock.calls.length;
        fail.answer({success: false, error: 'INFORMATION_HIGHLIGHT_TOKEN_LIMIT', initialized: true} as never); await expect(response).rejects.toThrow('TOKEN_LIMIT'); expect(fail.worker.terminate).not.toHaveBeenCalled();
        expect(await fail.runtime.status()).toMatchObject({phase: 'ready', initialized: true}); expect(fail.store.complete).toHaveBeenCalledTimes(cachedReads); fail.runtime.dispose();
        const evicted = fixture(); const missing = evicted.runtime.score('a', new AbortController().signal); await flush(); evicted.store.complete.mockResolvedValue(false); evicted.answer({success: false, error: 'MODEL_NOT_DOWNLOADED', initialized: false} as never);
        await expect(missing).rejects.toThrow('MODEL_NOT_DOWNLOADED'); expect(await evicted.runtime.status()).toMatchObject({downloaded: false, phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED'}); evicted.runtime.dispose();
        const initialization = fixture(); const invalid = initialization.runtime.score('a', new AbortController().signal); await flush(); initialization.answer({success: false, error: 'ONNX init failed', initialized: false} as never);
        await expect(invalid).rejects.toThrow('ONNX init failed'); expect(initialization.worker.terminate).toHaveBeenCalledOnce(); expect(await initialization.runtime.status()).toMatchObject({initialized: false});
        expect(await initialization.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED', downloaded: true});
        expect(await initialization.runtime.prepare()).toMatchObject({phase: 'ready', errorCode: undefined}); expect(initialization.store.download).not.toHaveBeenCalled();
        const unavailable = fixture(false); unavailable.probe.mockResolvedValue({supported: false, reason: 'unsupported'} as never); await expect(unavailable.runtime.prepare()).rejects.toThrow('unsupported'); await expect(unavailable.runtime.score('a', new AbortController().signal)).rejects.toThrow('unsupported');
        vi.stubGlobal('navigator', {}); expect(await probeInformationHighlightWebGpu()).toMatchObject({supported: false});
        for (const adapter of [null, {features: new Set()}, {features: new Set(['shader-f16'])}]) {vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => adapter}}); expect((await probeInformationHighlightWebGpu()).supported).toBe(Boolean(adapter?.features.has('shader-f16')));}
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => {throw new Error('lost');}}}); expect(await probeInformationHighlightWebGpu()).toMatchObject({supported: false});
    });
    it('keeps cold initialization warm after cancellation while bounding initialization and scoring separately', async () => {
        const value = fixture(), controller = new AbortController();
        value.worker.postMessage.mockImplementation(request => {if (request.type === 'score') queueMicrotask(() => value.worker.onmessage?.({data: {requestId: request.requestId, success: true, initialized: false, stage: 'initializing'}}));});
        const task = value.runtime.score('a', controller.signal); await flush(); controller.abort(); await expect(task).rejects.toMatchObject({name: 'AbortError'});
        vi.advanceTimersByTime(1500); expect(value.worker.terminate).not.toHaveBeenCalled();
        const requestId = value.worker.postMessage.mock.calls[0][0].requestId;
        value.worker.onmessage?.({data: {requestId, success: true, initialized: true, stage: 'scoring'}}); value.answer({success: false, initialized: true, error: '信息高亮已取消'} as never); await flush(); expect(value.worker.terminate).not.toHaveBeenCalled();
        const again = value.runtime.score('a', new AbortController().signal); await flush(); value.answer(); expect(await again).toEqual(result); value.runtime.dispose();
        const stalled = fixture(); stalled.worker.postMessage.mockImplementation(() => {});
        const pending = stalled.runtime.score('a', new AbortController().signal); await flush(); const assertion = expect(pending).rejects.toThrow('TIMEOUT'); vi.advanceTimersByTime(30_000); await assertion; expect(stalled.worker.terminate).toHaveBeenCalledOnce();
    });
    it('clears model failures after a direct successful score retry, while cancelled and removed owners cannot report recovery', async () => {
        for (const outcome of ['success', 'cancelled', 'removed'] as const) {
            const value = fixture(); const failed = value.runtime.score('a', new AbortController().signal); await flush();
            value.answer({success: false, initialized: false, error: 'ONNX init failed'} as never); await expect(failed).rejects.toThrow('ONNX init failed');
            expect(await value.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED'});
            const controller = new AbortController(), retry = value.runtime.score('a', controller.signal); await flush();
            expect(await value.runtime.status()).toMatchObject({phase: 'error'}); // 初始化/评分阶段消息还不能宣称恢复。
            let removal: Promise<InformationHighlightModelStatus> | undefined;
            if (outcome === 'cancelled') controller.abort();
            if (outcome === 'removed') removal = value.runtime.remove();
            value.answer();
            if (outcome === 'cancelled') {
                await expect(retry).rejects.toMatchObject({name: 'AbortError'}); await flush();
                expect(await value.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED'});
            } else {
                expect(await retry).toEqual(result);
                if (removal) {await removal; expect(await value.runtime.status()).toMatchObject({phase: 'absent', initialized: false, downloaded: false});}
                else {expect(await value.runtime.status()).toMatchObject({phase: 'ready', initialized: true}); expect((await value.runtime.status()).errorCode).toBeUndefined();}
            }
            expect(value.store.download).not.toHaveBeenCalled(); value.runtime.dispose();
        }
    });
    it('rejects active ownership on dispose, ignores captured late callbacks and handles failed worker posts', async () => {
        const disposed = fixture(); const task = disposed.runtime.score('a', new AbortController().signal); await flush(); const onmessage = disposed.worker.onmessage!, onerror = disposed.worker.onerror!;
        disposed.runtime.dispose(); await expect(task).rejects.toMatchObject({name: 'AbortError'}); onmessage({data: {requestId: 1, success: true, initialized: true, result}}); onerror({message: 'late'});
        for (const error of [new Error('post failed'), 'native failure']) {
            const failed = fixture(); failed.worker.postMessage.mockImplementation(() => {throw error;}); await expect(failed.runtime.score('a', new AbortController().signal)).rejects.toThrow(error instanceof Error ? 'post failed' : 'WORKER_FAILED'); expect(failed.worker.terminate).toHaveBeenCalledOnce();
        }
        const cancelled = fixture(), controller = new AbortController(); const pending = cancelled.runtime.score('a', controller.signal); await flush(); cancelled.worker.postMessage.mockImplementation(() => {throw new Error('cancel failed');});
        controller.abort(); await expect(pending).rejects.toMatchObject({name: 'AbortError'}); await flush(); expect(cancelled.worker.terminate).toHaveBeenCalledOnce();
        const absent = fixture(); const noResult = absent.runtime.score('a', new AbortController().signal); await flush(); const callback = absent.worker.onmessage!;
        absent.answer({success: true, initialized: true} as never); await expect(noResult).rejects.toThrow('FAILED'); callback({data: {requestId: 1, success: true, initialized: true, result}}); expect(await absent.runtime.status()).toMatchObject({phase: 'error', errorCode: 'INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED'}); absent.runtime.dispose();
        const successful = fixture(); const success = successful.runtime.score('a', new AbortController().signal); await flush(); const repeated = successful.worker.onmessage!; successful.answer(); await success; repeated({data: {requestId: 1, success: true, initialized: true, result}}); successful.runtime.dispose();
    });
    it('serializes removal with an active download and rejects prepare or score during removal', async () => {
        const value = fixture(false); let started!: () => void;
        const downloading = new Promise<void>(resolve => {started = resolve;});
        value.store.download.mockImplementationOnce((_file, signal) => new Promise((_resolve, reject) => {started(); signal.addEventListener('abort', () => reject(new DOMException('removed', 'AbortError')));}));
        await value.runtime.prepare(); await downloading;
        let removeFile!: () => void; value.store.remove.mockImplementationOnce(() => new Promise<void>(resolve => {removeFile = resolve;}));
        const removal = value.runtime.remove(); await flush(); await expect(value.runtime.prepare()).rejects.toThrow('REMOVING'); await expect(value.runtime.score('a', new AbortController().signal)).rejects.toThrow('REMOVING');
        expect(await value.runtime.remove()).toMatchObject({downloaded: false, phase: 'removing'}); removeFile(); await removal; expect(value.store.remove).toHaveBeenCalledTimes(6);
        const failed = fixture(false); failed.store.download.mockRejectedValueOnce('bad download'); await failed.runtime.prepare(); await flush(); expect(await failed.runtime.status()).toMatchObject({errorCode: 'INFORMATION_HIGHLIGHT_DOWNLOAD_FAILED'});
        failed.store.remove.mockRejectedValueOnce('bad removal'); await expect(failed.runtime.remove()).rejects.toBe('bad removal'); expect(await failed.runtime.status()).toMatchObject({errorCode: 'INFORMATION_HIGHLIGHT_REMOVE_FAILED'});
        const disposeDownload = fixture(false); let signal!: AbortSignal; disposeDownload.store.download.mockImplementationOnce((_file, active) => {signal = active; return new Promise(() => {});}); await disposeDownload.runtime.prepare(); await flush(); disposeDownload.runtime.dispose(); expect(signal.aborted).toBe(true);
    });
    it('retries status after disk failure and observes cancellation while the status probe is pending', async () => {
        const retry = fixture(); retry.store.complete.mockRejectedValueOnce(new Error('cache failed')); await expect(retry.runtime.status()).rejects.toThrow('cache failed'); expect(await retry.runtime.status()).toMatchObject({downloaded: true});
        const value = fixture(), controller = new AbortController(); value.store.complete.mockImplementationOnce(async () => {controller.abort(); return true;});
        await expect(value.runtime.score('a', controller.signal)).rejects.toMatchObject({name: 'AbortError'}); await flush(); expect(value.createWorker).not.toHaveBeenCalled();
    });
    it('publishes finite download error codes instead of localized browser or arbitrary exception text', async () => {
        for (const [error, code] of [[new Error('MODEL_INTEGRITY'), 'MODEL_INTEGRITY'], [new Error('MODEL_NETWORK'), 'MODEL_NETWORK'], [new TypeError('网络错误'), 'MODEL_NETWORK'], [new DOMException('read timed out', 'AbortError'), 'MODEL_NETWORK'], [new Error('arbitrary internal path'), 'DOWNLOAD_FAILED'], [{name: 'QuotaExceededError'}, 'STORAGE_QUOTA'], [null, 'DOWNLOAD_FAILED']] as const) {
            const value = fixture(false); value.store.download.mockRejectedValueOnce(error); await value.runtime.prepare(); await flush(); expect(await value.runtime.status()).toMatchObject({phase: 'error', errorCode: `INFORMATION_HIGHLIGHT_${code}`});
        }
    });
});
