import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {huggingFaceDownloadOrigins} from '@/src/platform/http/modelDownloads';
import {sha256} from '@noble/hashes/sha256';
import {createModelArtifactStore, MODEL_ARTIFACT_CHUNK_BYTES, type ModelArtifact} from '@/src/platform/storage/modelArtifacts';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, INFORMATION_HIGHLIGHT_MODELS} from '@/src/core/config/informationHighlightModel';
import {getInformationHighlightArtifacts, getInformationHighlightArtifactStore, informationHighlightArtifactStore, INFORMATION_HIGHLIGHT_CACHE, removeRetiredInformationHighlightArtifacts} from '@/src/features/information-highlight/offscreen/artifacts';

describe('fixed model artifacts integrity and bounded resumable cache', () => {
    let entries: Map<string, Response>, cache: {match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>};
    beforeEach(() => {
        entries = new Map(); cache = {match: vi.fn(async (key: string) => entries.get(key)?.clone()), put: vi.fn(async (key: string, value: Response) => {entries.set(key, value.clone());}), delete: vi.fn(async (key: string) => entries.delete(key))};
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)}); vi.stubGlobal('navigator', {language: 'en'});
    });
    afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});
    const fileFor = (body: Uint8Array, path = 'model.onnx'): ModelArtifact => ({url: `https://huggingface.co/org/model/resolve/pinned/${path}`, size: body.length, sha256: Array.from(sha256(body), value => value.toString(16).padStart(2,'0')).join('')});
    it('pins six verified files with actual size and content SHA-256, not a parameter-count estimate', () => {
        const defaultModel = getInformationHighlightModel(DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID);
        expect(defaultModel.revision).toMatch(/^[a-f0-9]{40}$/u); expect(defaultModel.bytes).toBe(490043908);
        expect(defaultModel.files).toHaveLength(6); expect(defaultModel.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
        expect(defaultModel.files.at(-1)).toMatchObject({size: 483003582, sha256: '30a39f89fab8f30d0f99aa1e28d3e3be6fca66a3fab915f77584ac52a8361d25'});
    });
    it('offers only a pretrained Base model and resolves retired persisted choices to it', () => {
        expect(DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID).toBe('qwen2.5-0.5b');
        expect(INFORMATION_HIGHLIGHT_MODELS.map(model => model.id)).toEqual(['qwen2.5-0.5b']);
        for (const model of INFORMATION_HIGHLIGHT_MODELS) {
            expect(model.revision).toMatch(/^[a-f0-9]{40}$/u);
            expect(model.files).toHaveLength(6);
            expect(model.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
            expect(model.bytes).toBe(model.files.reduce((sum, file) => sum + file.size, 0));
            expect(getInformationHighlightModel(model.id)).toBe(model);
        }
        for (const value of [undefined, null, 'qwen3-0.6b', 'unsupported-model', {}, 1]) expect(getInformationHighlightModel(value)).toBe(INFORMATION_HIGHLIGHT_MODELS[0]);
        expect(getInformationHighlightModel(DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID)).toMatchObject({name: 'Qwen2.5 0.5B Base', repository: 'onnx-community/Qwen2.5-0.5B', bytes: INFORMATION_HIGHLIGHT_MODELS[0].bytes, kvCacheDtype: 'float32'});
    });
    it('keeps verified Base v1 files readable and never serves retired chat-model cache entries', async () => {
        const defaultModel = getInformationHighlightModel(DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID);
        const file = getInformationHighlightArtifacts()[0];
        const retiredUrl = 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/1e0a4a196ecabdf9a879664110574563d3f372d3/config.json';
        expect(file.url).toBe(`https://huggingface.co/onnx-community/Qwen2.5-0.5B/resolve/${defaultModel.revision}/config.json`);
        expect(getInformationHighlightArtifacts()).toHaveLength(defaultModel.files.length);
        expect(getInformationHighlightArtifactStore()).toBe(informationHighlightArtifactStore);
        entries.set(`${file.url}?fluent-read-verified=${file.sha256}`, new Response(JSON.stringify({size: file.size, sha256: file.sha256})));
        entries.set(`${file.url}?fluent-read-part=0`, new Response(new Uint8Array(file.size), {headers: {'Content-Length': String(file.size)}}));
        entries.set(retiredUrl, new Response('retired chat model'));
        expect(await informationHighlightArtifactStore.complete(file)).toBe(true);
        expect(await informationHighlightArtifactStore.match(file.url)).toBeInstanceOf(Response);
        expect(await informationHighlightArtifactStore.match(retiredUrl)).toBeUndefined();
        await informationHighlightArtifactStore.remove(file);
        expect(await informationHighlightArtifactStore.complete(file)).toBe(false);
        expect(entries.has(retiredUrl)).toBe(true);
        expect(vi.mocked(caches.open).mock.calls.every(([name]) => name === INFORMATION_HIGHLIGHT_CACHE)).toBe(true);
    });
    it('deletes only the exact retired chat-model cache and preserves Base and unrelated resources', async () => {
        const retiredCache = 'fluent-read-information-highlight-model-qwen3-0.6b-v1';
        const names = new Set([retiredCache, INFORMATION_HIGHLIGHT_CACHE, 'fluent-read-local-translation-v1', `${retiredCache}-other`]);
        const remove = vi.fn(async (name: string) => names.delete(name));
        vi.stubGlobal('caches', {delete: remove});
        await removeRetiredInformationHighlightArtifacts();
        expect(remove).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith(retiredCache);
        expect([...names]).toEqual([INFORMATION_HIGHLIGHT_CACHE, 'fluent-read-local-translation-v1', `${retiredCache}-other`]);
        await removeRetiredInformationHighlightArtifacts();
        expect(names.size).toBe(3);
    });
    it('streams verified bytes, emits verifying progress and serves only canonical prepared artifacts', async () => {
        const body = new TextEncoder().encode('fixed bytes'), file = fileFor(body), store = createModelArtifactStore('models', [file]), progress = vi.fn();
        await expect(store.blob(file)).rejects.toThrow('NOT_DOWNLOADED'); expect(await store.complete(file)).toBe(false); expect(await store.downloaded(file)).toBe(0);
        const fetcher = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetcher);
        await store.download(file, new AbortController().signal, progress); expect(await store.complete(file)).toBe(true); expect(await store.downloaded(file)).toBe(body.length); expect(await (await store.blob(file)).text()).toBe('fixed bytes');
        expect(await (await store.match(file.url))!.text()).toBe('fixed bytes'); expect(await store.match(new Request(file.url))).toBeInstanceOf(Response); expect(await store.match('https://elsewhere')).toBeUndefined();
        expect(progress).toHaveBeenCalledWith(body.length, true); await store.download(file, new AbortController().signal, progress); expect(fetcher).toHaveBeenCalledOnce();
        await store.remove(file); expect(await store.complete(file)).toBe(false);
    });
    it('keeps cancellation bookkeeping bounded across thousands of successful stream reads', async () => {
        const body = new Uint8Array(2048 * 16).fill(7), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        let offset = 0;
        const reader = {read: vi.fn(async () => {
            if (offset === body.length) return {done: true as const, value: undefined};
            const value = body.subarray(offset, offset + 16); offset += value.length;
            return {done: false as const, value};
        }), cancel: vi.fn(async () => {}), releaseLock: vi.fn()};
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, status: 200, headers: new Headers(), body: {getReader: () => reader}})));
        const nativeRace = Promise.race.bind(Promise), registrations = new WeakMap<object, number>();
        let mostRegistrations = 0;
        // 同一个未决取消 Promise 会保留每次 race 的 reaction；只计数身份复用，不依赖 GC 或耗时。
        const race = vi.spyOn(Promise, 'race').mockImplementation(values => {
            const inputs = Array.from(values);
            if (inputs.length === 2 && inputs[1] instanceof Promise) {
                const count = (registrations.get(inputs[1]) ?? 0) + 1;
                registrations.set(inputs[1], count); mostRegistrations = Math.max(mostRegistrations, count);
            }
            return nativeRace(inputs);
        });
        try {
            await store.download(file, new AbortController().signal, () => {});
            expect(reader.read).toHaveBeenCalledTimes(2049);
            expect(new Uint8Array(await (await store.blob(file)).arrayBuffer())).toEqual(body);
            expect(await store.complete(file)).toBe(true);
            expect(mostRegistrations).toBeLessThanOrEqual(1);
        } finally {race.mockRestore();}
    });
    it('observes synchronous transport failure even when it also cancels the owner', async () => {
        const file = fileFor(new Uint8Array([1, 2])), store = createModelArtifactStore('models', [file]), abort = new AbortController();
        const fetcher = vi.fn(() => {abort.abort(); throw new Error('transport revoked');}); vi.stubGlobal('fetch', fetcher);
        await expect(store.download(file, abort.signal, () => {})).rejects.toMatchObject({name: 'AbortError'});
        expect(fetcher).toHaveBeenCalledOnce(); expect(cache.put).not.toHaveBeenCalled();
    });
    it('requires a valid receipt plus all actual chunks; stale/corrupt receipts cannot claim ready', async () => {
        const body = new Uint8Array([1,2]), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        const receipt = `${file.url}?fluent-read-verified=${file.sha256}`, chunk = `${file.url}?fluent-read-part=0`;
        for (const value of ['invalid JSON', JSON.stringify({size: 1, sha256: file.sha256}), JSON.stringify({size: 2, sha256: 'bad'}), JSON.stringify({size: 2, sha256: file.sha256})]) {entries.set(receipt, new Response(value)); expect(await store.complete(file)).toBe(false);}
        entries.set(chunk, new Response('x', {headers: {'Content-Length': '2'}})); expect(await store.complete(file)).toBe(false); expect(await store.downloaded(file)).toBe(2); await expect(store.blob(file)).rejects.toThrow('NOT_DOWNLOADED');
        entries.set(chunk, new Response(body, {headers: {'Content-Length': '2'}})); expect(await store.complete(file)).toBe(true);
        cache.match.mockImplementation(async (key: string) => key === chunk ? undefined : entries.get(key)?.clone()); await expect(store.blob(file)).rejects.toThrow('NOT_DOWNLOADED');
    });
    it('resumes a whole 4MiB prefix using exact Range, and verifies a fully downloaded unverified file offline', async () => {
        const body = new Uint8Array(MODEL_ARTIFACT_CHUNK_BYTES + 3).fill(7), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        entries.set(`${file.url}?fluent-read-part=0`, new Response(body.subarray(0, MODEL_ARTIFACT_CHUNK_BYTES), {headers: {'Content-Length': String(MODEL_ARTIFACT_CHUNK_BYTES)}}));
        const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(body.subarray(MODEL_ARTIFACT_CHUNK_BYTES), {status: 206, headers: {'Content-Range': `bytes ${MODEL_ARTIFACT_CHUNK_BYTES}-${body.length - 1}/${body.length}`}})); vi.stubGlobal('fetch', fetcher);
        await store.download(file, new AbortController().signal, () => {}); expect(fetcher.mock.calls[0][1]).toMatchObject({headers: {Range: `bytes=${MODEL_ARTIFACT_CHUNK_BYTES}-`}}); expect(await store.complete(file)).toBe(true);
        entries.delete(`${file.url}?fluent-read-verified=${file.sha256}`); await store.download(file, new AbortController().signal, () => {}); expect(fetcher).toHaveBeenCalledOnce();
    });
    it('reads each prepared chunk only once and rejects eviction or replacement during reading', async () => {
        const body = new Uint8Array([1,2]), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        const receipt = `${file.url}?fluent-read-verified=${file.sha256}`, chunk = `${file.url}?fluent-read-part=0`;
        entries.set(receipt, new Response(JSON.stringify({size: file.size, sha256: file.sha256}))); entries.set(chunk, new Response(body, {headers: {'Content-Length': '2'}}));
        cache.match.mockClear(); expect(await (await store.match(file.url))!.arrayBuffer()).toEqual(body.buffer);
        expect(cache.match.mock.calls.map(call => call[0])).toEqual([receipt, chunk]);
        for (const replacement of [undefined, new Response('x')]) {
            cache.match.mockImplementation(async (key: string) => key === chunk ? replacement?.clone() : entries.get(key)?.clone());
            await expect(store.blob(file)).rejects.toThrow('MODEL_NOT_DOWNLOADED'); expect(await store.match(file.url)).toBeUndefined();
        }
        cache.match.mockImplementation(async (key: string) => entries.get(key)?.clone()); entries.delete(receipt); entries.delete(chunk);
        cache.put.mockImplementation(async () => {entries.delete(chunk);});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body))); await expect(store.download(file, new AbortController().signal, () => {})).rejects.toThrow('MODEL_INTEGRITY');
    });
    it('restarts when a source ignores Range and discards corrupt bytes before trying another source', async () => {
        const body = new Uint8Array(MODEL_ARTIFACT_CHUNK_BYTES + 1).fill(3), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        entries.set(`${file.url}?fluent-read-part=0`, new Response(body.subarray(0, MODEL_ARTIFACT_CHUNK_BYTES), {headers: {'Content-Length': String(MODEL_ARTIFACT_CHUNK_BYTES)}}));
        const fetcher = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetcher); await store.download(file, new AbortController().signal, () => {}); expect(await store.complete(file)).toBe(true);
        const small = fileFor(new TextEncoder().encode('good'), 'small'), other = createModelArtifactStore('models', [small]); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('evil')).mockResolvedValueOnce(new Response('good')));
        await other.download(small, new AbortController().signal, () => {}); expect(await other.complete(small)).toBe(true); expect(await store.complete(file)).toBe(true);
    });
    it('rejects invalid ranges, short/oversized files, HTML bodies and quota errors without accepting incomplete data', async () => {
        const file = fileFor(new Uint8Array([1,2])), store = createModelArtifactStore('models', [file]);
        for (const response of [new Response('x', {status: 206}), new Response('x', {status: 206, headers: {'Content-Range': 'bytes 1-1/2'}}), new Response('x'), new Response('xxx'), new Response('page', {status: 500}), new Response(null), new Response('x', {status: 201})]) {
            vi.stubGlobal('fetch', vi.fn(async () => response.clone())); await expect(store.download(file, new AbortController().signal, () => {})).rejects.toThrow(); expect(await store.complete(file)).toBe(false); await store.remove(file);
        }
        cache.put.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError')); const fetcher = vi.fn(async () => new Response(new Uint8Array([1,2]))); vi.stubGlobal('fetch', fetcher); await expect(store.download(file, new AbortController().signal, () => {})).rejects.toMatchObject({name: 'QuotaExceededError'}); expect(fetcher).toHaveBeenCalledOnce();
        vi.stubGlobal('fetch', vi.fn(async () => {throw null;})); await expect(store.download(file, new AbortController().signal, () => {})).rejects.toBe(null);
    });
    it.each([500, 206, 201])('cancels a rejected %s response before trying the next model source', async status => {
        const bytes = new Uint8Array([1, 2]), file = fileFor(bytes), store = createModelArtifactStore('models', [file]);
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({cancel}), {status}))
            .mockResolvedValueOnce(new Response(bytes));
        vi.stubGlobal('fetch', fetcher);
        await store.download(file, new AbortController().signal, () => {});
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(await store.complete(file)).toBe(true);
    });
    it('pauses before fetch or during the stream, keeps other model entries and bounds stalled-network waiting', async () => {
        const body = new Uint8Array([1,2]), file = fileFor(body), store = createModelArtifactStore('models', [file]);
        const controller = new AbortController(); controller.abort(); await expect(store.download(file, controller.signal, () => {})).rejects.toMatchObject({name: 'AbortError'});
        const during = new AbortController(); vi.stubGlobal('fetch', vi.fn(async () => {during.abort(); return new Response(body);})); await expect(store.download(file, during.signal, () => {})).rejects.toMatchObject({name: 'AbortError'});
        vi.useFakeTimers(); const fetcher = vi.fn((_url, {signal}: {signal: AbortSignal}) => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stalled'))))); vi.stubGlobal('fetch', fetcher);
        const stalled = store.download(file, new AbortController().signal, () => {}); const expectation = expect(stalled).rejects.toMatchObject({name: 'TimeoutError'}); await vi.runAllTimersAsync(); await expectation; expect(fetcher).toHaveBeenCalledTimes(huggingFaceDownloadOrigins().length);
    });
    it('rejects cancellation during an asynchronous cache hit instead of reporting ready', async () => {
        const bytes = new Uint8Array([1, 2]), file = fileFor(bytes), store = createModelArtifactStore('models', [file]);
        const controller = new AbortController(), progress = vi.fn();
        entries.set(`${file.url}?fluent-read-verified=${file.sha256}`, new Response(JSON.stringify({size: file.size, sha256: file.sha256})));
        entries.set(`${file.url}?fluent-read-part=0`, new Response(bytes));
        cache.match.mockImplementation(async (key: string) => {
            if (key.endsWith('part=0')) controller.abort();
            return entries.get(key)?.clone();
        });
        await expect(store.download(file, controller.signal, progress)).rejects.toMatchObject({name: 'AbortError'});
        expect(progress).not.toHaveBeenCalled();
    });
    it('switches sources at the header deadline even if fetch ignores abort and cancels its late body', async () => {
        vi.useFakeTimers();
        const bytes = new Uint8Array([1, 2]), file = fileFor(bytes), store = createModelArtifactStore('models', [file]);
        let release!: (response: Response) => void;
        const held = new Promise<Response>(resolve => {release = resolve;});
        const fetcher = vi.fn().mockReturnValueOnce(held).mockResolvedValueOnce(new Response(bytes));
        vi.stubGlobal('fetch', fetcher);
        const pending = store.download(file, new AbortController().signal, () => {});
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetcher).toHaveBeenCalledTimes(2);
        await pending;
        const cancel = vi.fn();
        release(new Response(new ReadableStream({cancel})));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(await store.complete(file)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('abandons a stalled read without waiting for cleanup and cannot write its late chunk', async () => {
        vi.useFakeTimers();
        const bytes = new Uint8Array([1, 2]), file = fileFor(bytes), store = createModelArtifactStore('models', [file]);
        let release!: (value: {done: boolean; value: Uint8Array}) => void;
        const read = vi.fn(() => new Promise<{done: boolean; value: Uint8Array}>(resolve => {release = resolve;}));
        const reader = {read, cancel: vi.fn(() => new Promise<void>(() => {})), releaseLock: vi.fn()};
        const fetcher = vi.fn().mockResolvedValueOnce({ok: true, status: 200, body: {getReader: () => reader}}).mockResolvedValueOnce(new Response(bytes));
        vi.stubGlobal('fetch', fetcher);
        const pending = store.download(file, new AbortController().signal, () => {});
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(45_000);
        expect(fetcher).toHaveBeenCalledTimes(2);
        await pending;
        const writes = cache.put.mock.calls.length;
        release({done: false, value: new Uint8Array([9, 9])});
        await Promise.resolve(); await Promise.resolve();
        expect(cache.put).toHaveBeenCalledTimes(writes);
        expect(reader.cancel).toHaveBeenCalledOnce();
        expect(reader.releaseLock).toHaveBeenCalledOnce();
        expect(await (await store.blob(file)).arrayBuffer()).toEqual(bytes.buffer);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('settles user cancellation immediately while fetch ignores abort and never starts fallback', async () => {
        const file = fileFor(new Uint8Array([1, 2])), store = createModelArtifactStore('models', [file]);
        const controller = new AbortController(), progress = vi.fn();
        let release!: (response: Response) => void;
        const fetcher = vi.fn(() => new Promise<Response>(resolve => {release = resolve;}));
        vi.stubGlobal('fetch', fetcher);
        const pending = store.download(file, controller.signal, progress);
        const expected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        controller.abort();
        await expected;
        const cancel = vi.fn();
        release(new Response(new ReadableStream({cancel})));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(fetcher).toHaveBeenCalledOnce();
        expect(cache.put).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
    });
    it('does not read an expired source after cache opening resumes and tolerates reader cleanup failures', async () => {
        vi.useFakeTimers();
        const bytes = new Uint8Array([1, 2]), file = fileFor(bytes), store = createModelArtifactStore('models', [file]);
        let reopen!: (value: typeof cache) => void;
        const delayed = new Promise<typeof cache>(resolve => {reopen = resolve;});
        const cachePort = cache as unknown as Cache;
        vi.mocked(caches.open).mockResolvedValueOnce(cachePort).mockResolvedValueOnce(cachePort).mockReturnValueOnce(delayed as unknown as Promise<Cache>);
        const reader = {read: vi.fn(), cancel: vi.fn(() => {throw new Error('cleanup unavailable');}), releaseLock: vi.fn(() => {throw new Error('lock already gone');})};
        const fetcher = vi.fn().mockResolvedValueOnce({ok: true, status: 200, body: {getReader: () => reader}}).mockResolvedValueOnce(new Response(bytes));
        vi.stubGlobal('fetch', fetcher);
        const pending = store.download(file, new AbortController().signal, () => {});
        await vi.waitFor(() => expect(caches.open).toHaveBeenCalledTimes(3));
        await vi.advanceTimersByTimeAsync(20_000);
        reopen(cache);
        await pending;
        expect(reader.read).not.toHaveBeenCalled();
        expect(reader.cancel).toHaveBeenCalledOnce();
        expect(reader.releaseLock).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(await store.complete(file)).toBe(true);
    });
});
