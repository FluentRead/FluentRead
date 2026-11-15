/** 固定读音数据的可信下载与离线复用：使用小型确定性数据覆盖失败、超时和并发边界。 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {createReadingAssetStore, type ReadingAssetFile} from '@/src/features/video-subtitle/reading/assetStore';

const digest = (bytes: Uint8Array) => Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const data = new Uint8Array([1, 2, 3]);
const file = (name = 'dict.dat.gz'): ReadingAssetFile => ({name, size: data.length, sha256: digest(data), urls: [
    `https://primary.test/fixed/${name}`, `https://fallback.test/fixed/${name}`,
]});

describe('on-demand reading data store', () => {
    it('falls back after an invalid response even if the unread body rejects cancellation', async () => {
        const invalid=new Response(new ReadableStream({cancel(){return Promise.reject(new Error('network stream already closed'));}}),{status:503});
        const cancel=vi.spyOn(invalid.body!,'cancel');
        const fetcher=vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(new Response(data));
        expect(new Uint8Array(await create(undefined,{fetch:fetcher}).get(file().name))).toEqual(data);
        expect(cancel).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledTimes(2);expect(cache.put).toHaveBeenCalledOnce();
    });
    let entries: Map<string, Response>;
    let cache: {match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>};
    beforeEach(() => {
        entries = new Map();
        cache = {
            match: vi.fn(async (key: string) => entries.get(key)?.clone()),
            put: vi.fn(async (key: string, value: Response) => {entries.set(key, value.clone());}),
            delete: vi.fn(async (key: string) => entries.delete(key)),
        };
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
    });
    afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});
    const create = (files = [file()], overrides = {}) => createReadingAssetStore({cacheName: 'reading-test-v1', files, ...overrides});

    it('does no work until requested, shares initialization, and verifies cached bytes offline', async () => {
        const fetcher = vi.fn(async () => new Response(data)); vi.stubGlobal('fetch', fetcher);
        const store = create();
        expect(fetcher).not.toHaveBeenCalled(); expect(caches.open).not.toHaveBeenCalled();
        await expect(store.get('unknown')).rejects.toThrow('Unknown reading data file');
        expect(caches.open).not.toHaveBeenCalled();
        const first = store.ensure(), second = store.ensure(), third = store.get(file().name);
        expect(first).toBe(second);
        expect(new Uint8Array(await third)).toEqual(data);
        expect((await first).get(file().name)).toBe(await third);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith(file().urls[0], expect.objectContaining({credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'}));
        fetcher.mockRejectedValue(new Error('offline'));
        const reopened = create();
        expect(new Uint8Array(await reopened.get(file().name))).toEqual(data);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('bounds simultaneous requests and preserves every file in the result', async () => {
        const files = [file('one'), file('two'), file('three'), file('four')];
        const finish: Array<(response: Response) => void> = [];
        const fetcher = vi.fn(() => new Promise<Response>(resolve => finish.push(resolve)));
        const store = create(files, {fetch: fetcher, concurrency: 2});
        const result = store.ensure();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        finish[0](new Response(data)); finish[1](new Response(data));
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
        finish[2](new Response(data)); finish[3](new Response(data));
        expect([...((await result).keys())].sort()).toEqual(files.map(value => value.name).sort());
    });

    it.each([
        ['HTTP error', () => new Response('error', {status: 503})],
        ['partial HTTP status', () => new Response(data, {status: 206})],
        ['missing body', () => new Response(null)],
        ['oversized header', () => new Response(data, {headers: {'Content-Length': '999'}})],
        ['oversized body', () => new Response(new Uint8Array([1, 2, 3, 4]))],
        ['truncated body', () => new Response(new Uint8Array([1, 2]))],
        ['wrong digest', () => new Response(new Uint8Array([3, 2, 1]))],
        ['broken stream', () => new Response(new ReadableStream({start(controller) {controller.error(new Error('broken'));}}))],
    ])('rejects %s before caching and tries a different fixed source', async (_label, invalid) => {
        const fetcher = vi.fn().mockResolvedValueOnce(invalid()).mockResolvedValueOnce(new Response(data));
        expect(new Uint8Array(await create(undefined, {fetch: fetcher}).get(file().name))).toEqual(data);
        expect(fetcher.mock.calls.map(call => call[0])).toEqual(file().urls);
        expect(cache.put).toHaveBeenCalledOnce();
        expect(new Uint8Array(await [...entries.values()][0].clone().arrayBuffer())).toEqual(data);
    });

    it('deletes a same-length corrupt cached response and replaces it with verified data', async () => {
        const item = file(), key = `${item.urls[0]}?fluent-read-verified=${item.sha256}`;
        entries.set(key, new Response(new Uint8Array([3, 2, 1])));
        const fetcher = vi.fn(async () => new Response(data));
        expect(new Uint8Array(await create(undefined, {fetch: fetcher}).get(item.name))).toEqual(data);
        expect(cache.delete).toHaveBeenCalledWith(key); expect(fetcher).toHaveBeenCalledOnce();
    });

    it('retries after complete failure and retains separately verified files', async () => {
        const first = file('one'), second = file('two'); let online = false;
        const fetcher = vi.fn(async (url: string) => {
            if (url.endsWith('two') && !online) throw new Error('unavailable');
            return new Response(data);
        });
        const store = create([first, second], {fetch: fetcher, concurrency: 1});
        await expect(store.ensure()).rejects.toThrow('sources unavailable');
        expect(entries.size).toBe(1); expect(fetcher).toHaveBeenCalledTimes(3);
        online = true;
        expect((await store.ensure()).size).toBe(2);
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(fetcher.mock.calls.filter(([url]) => url.endsWith('one'))).toHaveLength(1);
    });

    it('bounds a stalled source, aborts its request, and uses the fallback', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(new Response(data));
        const result = create(undefined, {fetch: fetcher, sourceTimeoutMs: 20, totalTimeoutMs: 100}).ensure();
        await vi.advanceTimersByTimeAsync(20);
        expect((await result).size).toBe(1);
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a continuously progressing transfer alive beyond twenty seconds', async () => {
        vi.useFakeTimers();
        const response = new Response(new ReadableStream({start(controller) {
            setTimeout(() => controller.enqueue(data.slice(0, 1)), 15_000);
            setTimeout(() => controller.enqueue(data.slice(1, 2)), 30_000);
            setTimeout(() => {controller.enqueue(data.slice(2)); controller.close();}, 45_000);
        }}));
        const fetcher = vi.fn(async () => response);
        const result = create(undefined, {fetch: fetcher}).ensure();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetcher).toHaveBeenCalledOnce(); expect(cache.put).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(25_000);
        expect(new Uint8Array((await result).get(file().name)!)).toEqual(data);
        expect(fetcher).toHaveBeenCalledOnce(); expect(cache.put).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('restarts the idle deadline after a real chunk and falls back when that transfer stops', async () => {
        vi.useFakeTimers(); const cancel = vi.fn();
        const response = new Response(new ReadableStream({start(controller) {
            setTimeout(() => controller.enqueue(data.slice(0, 1)), 15_000);
        }, cancel}));
        const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(data));
        const result = create(undefined, {fetch: fetcher}).ensure();
        await vi.advanceTimersByTimeAsync(34_999);
        expect(fetcher).toHaveBeenCalledOnce(); expect(cache.put).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect((await result).size).toBe(1); expect(fetcher).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce(); expect(cache.put).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not treat empty chunks as download progress', async () => {
        vi.useFakeTimers();
        const response = new Response(new ReadableStream({start(controller) {
            setTimeout(() => controller.enqueue(new Uint8Array()), 10_000);
        }}));
        const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response(data));
        const result = create(undefined, {fetch: fetcher}).ensure();
        await vi.advanceTimersByTimeAsync(20_000);
        expect((await result).size).toBe(1); expect(fetcher).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('enforces the total deadline even while a source continues producing data', async () => {
        vi.useFakeTimers(); const cancel = vi.fn();
        const response = new Response(new ReadableStream({start(controller) {
            setTimeout(() => controller.enqueue(data.slice(0, 1)), 15_000);
            setTimeout(() => controller.enqueue(data.slice(1, 2)), 30_000);
        }, cancel}));
        const fetcher = vi.fn(async () => response);
        const expectation = expect(create(undefined, {fetch: fetcher, totalTimeoutMs: 40_000}).ensure()).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(40_000); await expectation;
        expect(fetcher).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
        expect(cache.put).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it('never stores a response arriving after source timeout', async () => {
        vi.useFakeTimers(); let finish!: (response: Response) => void;
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;})).mockResolvedValueOnce(new Response(data));
        const result = create(undefined, {fetch: fetcher, sourceTimeoutMs: 20, totalTimeoutMs: 100}).ensure();
        await vi.advanceTimersByTimeAsync(20); await result;
        finish(new Response(data)); await vi.advanceTimersByTimeAsync(0);
        expect(cache.put).toHaveBeenCalledOnce();
    });

    it('bounds a body stream that stops producing data and cancels it before retry', async () => {
        vi.useFakeTimers(); const cancel = vi.fn();
        const stalled = new Response(new ReadableStream({pull: () => new Promise(() => {}), cancel}));
        const fetcher = vi.fn().mockResolvedValueOnce(stalled).mockResolvedValueOnce(new Response(data));
        const result = create(undefined, {fetch: fetcher, sourceTimeoutMs: 20, totalTimeoutMs: 100}).ensure();
        await vi.advanceTimersByTimeAsync(20);
        expect((await result).size).toBe(1); expect(cancel).toHaveBeenCalledOnce();
        expect(cache.put).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds the whole preparation including cache reads and permits a later retry', async () => {
        vi.useFakeTimers(); let stuck = true;
        const openCache = vi.fn(() => stuck ? new Promise<typeof cache>(() => {}) : Promise.resolve(cache));
        const store = create(undefined, {openCache, totalTimeoutMs: 30, fetch: vi.fn(async () => new Response(data))});
        const expectation = expect(store.ensure()).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(30); await expectation;
        stuck = false; expect((await store.ensure()).size).toBe(1); expect(vi.getTimerCount()).toBe(0);
    });

    it('settles total timeout during a download and stops source retries', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn((_input: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(() => {}));
        const expectation = expect(create(undefined, {fetch: fetcher, sourceTimeoutMs: 100, totalTimeoutMs: 20}).ensure()).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(20); await expectation;
        expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(cache.put).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects storage failure without claiming the resource is installed', async () => {
        cache.put.mockRejectedValue(new DOMException('storage full', 'QuotaExceededError'));
        await expect(create(undefined, {fetch: vi.fn(async () => new Response(data))}).ensure()).rejects.toThrow();
        expect(entries.size).toBe(0);
    });

    it('handles an empty data set without network requests', async () => {
        const fetcher = vi.fn(); expect((await create([], {fetch: fetcher}).ensure()).size).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        {cacheName: ''}, {sourceTimeoutMs: 0}, {sourceTimeoutMs: NaN}, {totalTimeoutMs: -1}, {concurrency: 0}, {concurrency: 1.5},
        {files: [file(), file()]}, {files: [{...file(), name: '../dict'}]}, {files: [{...file(), size: 0}]},
        {files: [{...file(), sha256: 'bad'}]}, {files: [{...file(), urls: []}]}, {files: [{...file(), urls: ['http://insecure.test/dict']}]},
    ])('rejects an invalid fixed data manifest %#', overrides => {
        expect(() => create(undefined, overrides)).toThrow('Invalid reading data manifest');
    });
});
