import {afterEach, describe, expect, it, vi} from 'vitest';
import {huggingFaceDownloadOrigins, isModelCacheSource, modelDownloadSources, withModelDownload} from '@/src/platform/http/modelDownloads';
import type {ModelDownloadStatus} from '@/src/core/download/progress';

const url = 'https://huggingface.co/test/model/resolve/pinned/weights.onnx';
afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {resolve = yes;});
    return {promise, resolve};
}

describe('model download source and stream boundaries', () => {
    it('keeps cancellation bookkeeping bounded while reading many model chunks', async () => {
        let remaining = 2048;
        const body = new ReadableStream<Uint8Array>({
            pull(stream) {
                if (remaining-- > 0) stream.enqueue(new Uint8Array([7]));
                else stream.close();
            },
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
        const nativeRace = Promise.race.bind(Promise), registrations = new WeakMap<object, number>();
        let mostRegistrations = 0;
        const race = vi.spyOn(Promise, 'race').mockImplementation(values => {
            const inputs = Array.from(values);
            if (inputs.length === 2 && inputs[1] instanceof Promise) {
                const count = (registrations.get(inputs[1]) ?? 0) + 1;
                registrations.set(inputs[1], count); mostRegistrations = Math.max(mostRegistrations, count);
            }
            return nativeRace(inputs);
        });
        try {
            const bytes = new Uint8Array(await withModelDownload('https://example.com/model', response => response.arrayBuffer()));
            expect(bytes).toEqual(new Uint8Array(2048).fill(7));
            expect(mostRegistrations).toBeLessThanOrEqual(2);
        } finally {
            race.mockRestore();
        }
    });
    it('does not commit a chunk when cancellation arrives as its read settles', async () => {
        const caller = new AbortController(), progress: number[] = [];
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7]))));
        const nativeRace = Promise.race.bind(Promise);
        let calls = 0;
        const race = vi.spyOn(Promise, 'race').mockImplementation(values => {
            const result = nativeRace(values);
            if (++calls === 3) return result.then(value => {caller.abort(); return value;});
            return result;
        });
        try {
            await expect(withModelDownload('https://example.com/model', item => item.arrayBuffer(), {
                signal: caller.signal, onProgress: loaded => progress.push(loaded),
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(progress).toEqual([0]);
        } finally {
            race.mockRestore();
        }
    });
    it('retains exact historical cached provenance while never downloading from its retired origin', () => {
        const pinned = `${url}?download=true`, legacy = pinned.replace('huggingface.co', 'hf-mirror.net');
        expect(isModelCacheSource(pinned, pinned)).toBe(true);
        expect(isModelCacheSource(pinned, pinned.replace('huggingface.co', 'hf-mirror.com'))).toBe(true);
        expect(isModelCacheSource(pinned, legacy)).toBe(true);
        expect(modelDownloadSources(pinned)).not.toContain(legacy);
        for (const source of [undefined, {}, legacy.replace('/pinned/', '/main/'), legacy.replace('weights.onnx', 'config.json'), legacy.replace('?download=true', ''), legacy.replace('hf-mirror.net', 'hf-mirror.net.example.com')]) expect(isModelCacheSource(pinned, source)).toBe(false);
        expect(isModelCacheSource('https://modelscope.cn/models/onnx-community/whisper-small/resolve/master/config.json', 'https://hf-mirror.net/onnx-community/whisper-small/resolve/main/config.json')).toBe(false);
    });
    it('separates the ten-second default header deadline from the twenty-second first-byte wait and reports each safe source attempt', async () => {
        vi.useFakeTimers(); vi.stubGlobal('navigator', {language: 'zh-CN'});
        const late = deferred<Response>(), body = new ReadableStream<Uint8Array>({
            start(stream) {setTimeout(() => {stream.enqueue(new Uint8Array([1, 2])); stream.enqueue(new Uint8Array([3])); stream.close();}, 15_000);},
        });
        const fetcher = vi.fn().mockImplementationOnce(() => late.promise).mockResolvedValueOnce(new Response(body));
        vi.stubGlobal('fetch', fetcher);
        const status: ModelDownloadStatus[] = [], progress: number[] = [];
        const pending = withModelDownload('https://modelscope.cn/models/onnx-community/whisper-small/resolve/master/onnx/encoder_model.onnx', response => response.arrayBuffer(), {
            onSourceStatus: next => status.push(next), onProgress: loaded => progress.push(loaded),
        });
        await vi.advanceTimersByTimeAsync(9999);
        expect(fetcher).toHaveBeenCalledOnce(); expect(progress).toEqual([]);
        expect(status).toEqual([{source: 'modelscope', attempt: 1, attempts: 3, state: 'connecting'}]);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(status.at(-1)).toEqual({source: 'hf-mirror', attempt: 2, attempts: 3, state: 'connecting'});
        await vi.advanceTimersByTimeAsync(5000);
        expect((await pending).byteLength).toBe(3);
        expect(status).toEqual([{source: 'modelscope', attempt: 1, attempts: 3, state: 'connecting'}, {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'connecting'}, {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'receiving'}]);
        expect(progress).toEqual([0, 2, 3]);
        late.resolve(new Response(null)); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
    });
    it('keeps status callback failures outside the download and stops a user cancel from the connecting callback before fetching', async () => {
        const fetcher = vi.fn(async () => new Response('valid')), status = vi.fn(() => {throw new Error('view unavailable');});
        vi.stubGlobal('fetch', fetcher);
        expect(await withModelDownload('https://example.com/model', response => response.text(), {onSourceStatus: status})).toBe('valid');
        expect(status.mock.calls).toHaveLength(2); fetcher.mockClear();
        const controller = new AbortController();
        await expect(withModelDownload(url, response => response.text(), {signal: controller.signal, onSourceStatus: () => controller.abort()})).rejects.toMatchObject({name: 'AbortError'});
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('cancels early rejected bodies and treats cleanup throws and rejections as best-effort cleanup', async () => {
        const cancel = vi.fn(async () => {throw new Error('late underlying cancellation');});
        const response = new Response(new ReadableStream({cancel}), {headers: {'Content-Type': 'text/html'}});
        const fetcher = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response('valid'));
        vi.stubGlobal('fetch', fetcher);
        expect(await withModelDownload(url, item => item.text())).toBe('valid'); expect(cancel).toHaveBeenCalledOnce();
        fetcher.mockResolvedValueOnce({ok: false, status: 503, body: {cancel: () => {throw new Error('body released');}}}).mockResolvedValueOnce(new Response('valid'));
        expect(await withModelDownload(url, item => item.text())).toBe('valid');
        const reader = {read: vi.fn().mockResolvedValueOnce({done: false, value: new Uint8Array([1])}).mockResolvedValueOnce({done: true}),
            cancel: () => {throw new Error('reader unavailable');}, releaseLock: () => {throw new Error('lock released');}};
        fetcher.mockResolvedValueOnce({ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: {getReader: () => reader}});
        expect((await withModelDownload('https://example.com/model', item => item.arrayBuffer())).byteLength).toBe(1);
    });
    it('rejects a total deadline that arrives between consumer resolution and the owner continuation', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('valid')));
        let calls = 0;
        const pending = withModelDownload(url, async response => {
            const value = await response.text();
            if (++calls > 1) return value;
            return new Promise<string>(resolve => {
                setTimeout(() => {resolve(value); queueMicrotask(() => {vi.advanceTimersByTime(10);});}, 0);
            });
        }, {timeoutMs: 10});
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe('valid'); expect(calls).toBe(2); expect(vi.getTimerCount()).toBe(0);
    });
    it('moves to the next source even if a timed out fetch ignores AbortSignal, and cancels its late body', async () => {
        vi.useFakeTimers();
        const gate = deferred<Response>(), cancel = vi.fn();
        const fetched = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(new Response('good'));
        vi.stubGlobal('fetch', fetched);
        const pending = withModelDownload(url, response => response.text(), {timeoutMs: 10});
        const settled = pending.catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(11);
            expect(fetched).toHaveBeenCalledTimes(2);
        } finally {
            gate.resolve(new Response(new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new Uint8Array([1]));}, cancel})));
            await settled;
        }
        await expect(pending).resolves.toBe('good'); expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('bounds a stalled reader and cleanup even when neither read nor cancel honors abortion', async () => {
        vi.useFakeTimers();
        const reading = deferred<ReadableStreamReadResult<Uint8Array>>(), cleanup = deferred<void>();
        const reader = {read: vi.fn(() => reading.promise), cancel: vi.fn(() => cleanup.promise), releaseLock: vi.fn()};
        const fetched = vi.fn().mockResolvedValueOnce({ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: {getReader: () => reader}})
            .mockResolvedValueOnce(new Response('good'));
        vi.stubGlobal('fetch', fetched);
        const pending = withModelDownload(url, response => response.text(), {idleTimeoutMs: 10});
        const settled = pending.catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(11);
            expect(fetched).toHaveBeenCalledTimes(2);
        } finally {
            reading.resolve({done: true, value: undefined}); cleanup.resolve(); await settled;
        }
        await expect(pending).resolves.toBe('good'); expect(reader.releaseLock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('bounds a consumer that remains pending after the complete body and ignores its late completion', async () => {
        vi.useFakeTimers();
        const gate = deferred<void>(), fetched = vi.fn(async () => new Response('good'));
        vi.stubGlobal('fetch', fetched);
        let attempts = 0;
        const pending = withModelDownload(url, async response => {const text = await response.text(); if (++attempts === 1) await gate.promise; return text;}, {timeoutMs: 10});
        const settled = pending.catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(11); expect(fetched).toHaveBeenCalledTimes(2);
        } finally {gate.resolve(); await settled;}
        await expect(pending).resolves.toBe('good'); expect(vi.getTimerCount()).toBe(0);
    });
    it('uses language only as an ordering hint, excludes unverified mirrors and honors explicit preference', () => {
        vi.stubGlobal('navigator', undefined);
        expect(huggingFaceDownloadOrigins()[0]).toBe('https://huggingface.co');
        vi.stubGlobal('navigator', {language: 'zh-CN'});
        expect(huggingFaceDownloadOrigins()).toEqual(['https://hf-mirror.com','https://huggingface.co']);
        expect(huggingFaceDownloadOrigins('official')[0]).toContain('huggingface.co');
        vi.stubGlobal('navigator', {language: 'zh-TW'});
        expect(huggingFaceDownloadOrigins()[0]).toContain('huggingface.co');
        expect(huggingFaceDownloadOrigins('mirror')[0]).toContain('hf-mirror.com');
        expect(modelDownloadSources(url + '?download=true', 'official')).toEqual([
            url + '?download=true', url.replace('huggingface.co', 'hf-mirror.com') + '?download=true',
        ]);
        const whisper = 'https://modelscope.cn/models/onnx-community/whisper-tiny/resolve/master/config.json';
        expect(modelDownloadSources(whisper)).toEqual([
            'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json',
            'https://hf-mirror.com/onnx-community/whisper-tiny/resolve/main/config.json',
            whisper]);
        vi.stubGlobal('navigator', {language: 'zh-CN'});
        expect(modelDownloadSources(whisper)).toEqual([whisper, 'https://hf-mirror.com/onnx-community/whisper-tiny/resolve/main/config.json', 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json']);
        expect(modelDownloadSources(whisper, 'official')).toEqual(['https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json', 'https://hf-mirror.com/onnx-community/whisper-tiny/resolve/main/config.json', whisper]);
        expect(modelDownloadSources(whisper, 'mirror')).toEqual([whisper, 'https://hf-mirror.com/onnx-community/whisper-tiny/resolve/main/config.json', 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json']);
        const small = 'https://modelscope.cn/models/onnx-community/whisper-small/resolve/master/onnx/encoder_model.onnx';
        expect(modelDownloadSources(small, 'official')[0]).toBe('https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model.onnx');
        for (const other of ['https://example.com/model', 'https://modelscope.cn/models/other/model/resolve/master/config.json', 'https://modelscope.cn/other']) {
            expect(modelDownloadSources(other)).toEqual([other]);
        }
    });
    it('bounds declared and streamed file sizes and rejects invalid bounds before fetching', async () => {
        const fetched = vi.fn();vi.stubGlobal('fetch', fetched);
        for (const maxBytes of [0, -1, Number.NaN, 1.5]) {
            await expect(withModelDownload(url, response => response.text(), {maxBytes})).rejects.toThrow('上限无效');
        }
        expect(fetched).not.toHaveBeenCalled();
        const cancel = vi.fn();
        fetched.mockResolvedValueOnce(new Response(new ReadableStream({cancel}), {headers: {'Content-Length': '11'}}));
        await expect(withModelDownload('https://example.com/model', response => response.text(), {maxBytes: 10})).rejects.toThrow('大小上限');
        expect(cancel).toHaveBeenCalledOnce();
        const stream = () => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array([1, 2]));controller.enqueue(new Uint8Array([3, 4]));controller.close();}});
        fetched.mockResolvedValueOnce(new Response(stream()));
        await expect(withModelDownload('https://example.com/model', response => response.arrayBuffer(), {maxBytes: 3})).rejects.toThrow('大小上限');
        fetched.mockResolvedValueOnce(new Response(stream(), {headers: {'Content-Encoding': 'gzip', 'Content-Length': '2'}}));
        expect((await withModelDownload('https://example.com/model', response => response.arrayBuffer(), {maxBytes: 4})).byteLength).toBe(4);
    });
    it('truncated declared bodies fall back and never count as a complete file', async () => {
        vi.stubGlobal('navigator', {language: 'en-US'});
        const fetched = vi.fn().mockResolvedValueOnce(new Response('cut', {headers: {'Content-Length': '10'}}))
            .mockResolvedValueOnce(new Response('whole', {headers: {'Content-Length': '5'}}));
        vi.stubGlobal('fetch', fetched);
        await expect(withModelDownload(url, response => response.text(), {maxBytes: 10})).resolves.toBe('whole');
        expect(fetched).toHaveBeenCalledTimes(2);
    });
    it('streams through cache, keeps source headers, and never buffers or copies the whole model', async () => {
        const original = new Response(new Uint8Array([1,2,3]), {headers: {'Content-Type':'application/octet-stream'}});
        const buffer = vi.spyOn(original, 'arrayBuffer');
        const fetcher = vi.fn(async () => original);
        vi.stubGlobal('fetch', fetcher);
        const value = await withModelDownload(url, async (response, source) => {
            expect(source).toBe(url);expect(response.headers.get('Content-Type')).toContain('octet-stream');
            return Array.from(new Uint8Array(await response.arrayBuffer()));
        }, {preference:'official'});
        expect(value).toEqual([1,2,3]);expect(buffer).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith(url, {signal:expect.any(AbortSignal),credentials:'omit',referrerPolicy:'no-referrer'});
    });
    it('reports real received bytes per source and gives a total only for an uncompressed Content-Length', async () => {
        const chunks = (parts: number[][]) => new ReadableStream<Uint8Array>({start(stream) {for (const part of parts) stream.enqueue(new Uint8Array(part)); stream.close();}});
        const run = async (response: Response) => {
            const calls: Array<[number, number | undefined]> = [];
            vi.stubGlobal('fetch', vi.fn(async () => response));
            await withModelDownload('https://example.com/model', item => item.arrayBuffer(), {onProgress: (loaded, total) => calls.push([loaded, total])});
            return calls;
        };
        expect(await run(new Response(chunks([[1, 2], [3, 4, 5]]), {headers: {'Content-Length': '5'}}))).toEqual([[0, 5], [2, 5], [5, 5]]);
        expect(await run(new Response(chunks([[1, 2, 3]])))).toEqual([[0, undefined], [3, undefined]]);
        // 压缩传输的 Content-Length 是编码后的大小；非法或为零的长度同样不能当作总量。
        expect(await run(new Response(chunks([[1]]), {headers: {'Content-Length': '1', 'Content-Encoding': 'gzip'}}))).toEqual([[0, undefined], [1, undefined]]);
        expect(await run(new Response(chunks([[1]]), {headers: {'Content-Length': 'many'}}))).toEqual([[0, undefined], [1, undefined]]);
        expect(await run(new Response(chunks([[1]]), {headers: {'Content-Length': '0'}}))).toEqual([[0, undefined], [1, undefined]]);

        // 换来源重试时从 0 重新回报；进度回调抛错不影响下载结果。
        vi.stubGlobal('navigator', {language: 'en-US'});
        const restarted: number[] = [];
        let pulls = 0;
        const broken = new ReadableStream<Uint8Array>({pull(stream) {if (pulls++ === 0) stream.enqueue(new Uint8Array([9])); else stream.error(new Error('cut'));}});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(broken)).mockResolvedValueOnce(new Response(chunks([[1, 2]]))));
        expect(await withModelDownload(url, response => response.text(), {onProgress: (loaded) => { restarted.push(loaded); throw new Error('ui failed'); }})).toBe('\u0001\u0002');
        expect(restarted).toEqual([0, 1, 0, 2]);
    });
    it('falls back for HTTP, HTML challenge pages, missing bodies and validation failures', async () => {
        vi.stubGlobal('navigator', {language: 'en-US'});
        for (const bad of [new Response('', {status:503}), new Response('<html>', {headers:{'Content-Type':'text/html'}}), new Response(null)]) {
            const fetcher = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(new Response('verified'));
            vi.stubGlobal('fetch', fetcher);
            expect(await withModelDownload(url, response => response.text())).toBe('verified');
            expect(fetcher.mock.calls[1][0]).toContain('hf-mirror.com');
        }
        const fetcher = vi.fn(async () => new Response('valid'));
        vi.stubGlobal('fetch', fetcher);
        const consume = vi.fn(async (response: Response) => {const text=await response.text();if(consume.mock.calls.length<2)throw new Error('bad hash');return text;});
        expect(await withModelDownload(url, consume)).toBe('valid');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('falls back when a stream breaks or a fetch rejects and exposes the final failure', async () => {
        const body = new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('broken body'));}});
        const fetcher=vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response('good'));
        vi.stubGlobal('fetch', fetcher);
        expect(await withModelDownload(url, response => response.text())).toBe('good');
        fetcher.mockRejectedValueOnce('network').mockResolvedValueOnce(new Response('recovered'));
        expect(await withModelDownload(url, response => response.text())).toBe('recovered');
        vi.stubGlobal('fetch', vi.fn(async()=>{throw new Error('offline');}));
        await expect(withModelDownload(url, response=>response.text())).rejects.toThrow('offline');
    });
    it('propagates quota errors and user cancellation without downloading from another source', async () => {
        const fetcher=vi.fn(async()=>new Response('bytes'));
        vi.stubGlobal('fetch',fetcher);
        await expect(withModelDownload(url,async()=>{throw new DOMException('disk full','QuotaExceededError');})).rejects.toMatchObject({name:'QuotaExceededError'});
        expect(fetcher).toHaveBeenCalledOnce();fetcher.mockClear();
        const controller=new AbortController();controller.abort();
        await expect(withModelDownload(url,response=>response.text(),{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(fetcher).not.toHaveBeenCalled();
        const reading=new AbortController();
        await expect(withModelDownload(url,async response=>{await response.text();reading.abort();},{signal:reading.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(fetcher).toHaveBeenCalledOnce();fetcher.mockClear();
        const headers=new AbortController();fetcher.mockImplementationOnce(async()=>{headers.abort();return new Response('bytes');});
        await expect(withModelDownload(url,response=>response.text(),{signal:headers.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it('times out stalled headers, switches sources and cancels a stalled body', async () => {
        vi.useFakeTimers();
        const fetcher=vi.fn((_url:string,options:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
            options.signal!.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')),{once:true});
        }));
        vi.stubGlobal('fetch',fetcher);
        const pending=withModelDownload(url,response=>response.text(),{connectTimeoutMs:10,idleTimeoutMs:10,timeoutMs:100});
        const checked=expect(pending).rejects.toThrow('超过');
        await vi.advanceTimersByTimeAsync(21);await checked;expect(fetcher).toHaveBeenCalledTimes(2);
        const controller=new AbortController();
        const cancelled=withModelDownload(url,response=>response.text(),{signal:controller.signal});
        const cancellation=expect(cancelled).rejects.toMatchObject({name:'AbortError'});
        await vi.advanceTimersByTimeAsync(1);controller.abort();await cancellation;
        vi.stubGlobal('fetch',vi.fn(async (_url:string,options:RequestInit)=>new Response(new ReadableStream({start(stream){options.signal!.addEventListener('abort',()=>stream.close());}}))));
        const reading=withModelDownload('https://example.com/model',response=>response.text(),{idleTimeoutMs:10});
        const timeout=expect(reading).rejects.toThrow('超过');await vi.advanceTimersByTimeAsync(11);await timeout;
    });
    it('enforces total timeout even with a consumer pending after reception and cleans cancelled streams', async () => {
        vi.useFakeTimers();
        const cancel=vi.fn(async()=>{});
        const reader={read:async()=>({done:true}),cancel,releaseLock:vi.fn()};
        vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,statusText:'OK',headers:new Headers(),body:{getReader:()=>reader}})));
        const pending=withModelDownload('https://example.com/model',async response=>{await response.text();await new Promise(resolve=>setTimeout(resolve,11));},{timeoutMs:10});
        const check=expect(pending).rejects.toThrow('超过');await vi.advanceTimersByTimeAsync(12);await check;
        expect(reader.releaseLock).toHaveBeenCalled();
        const result=await withModelDownload('https://example.com/model',async response=>{await response.body!.cancel();return 'cancelled';});
        expect(result).toBe('cancelled');expect(cancel).toHaveBeenCalled();
    });
});
