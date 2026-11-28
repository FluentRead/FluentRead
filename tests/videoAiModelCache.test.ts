import {afterEach, describe, expect, it, vi} from 'vitest';
import {cacheVideoAiModelFiles, cacheVideoAiQ4ModelFiles, cacheVideoAiQ8ModelFiles, getVideoAiModelFileUrl, readCachedVideoAiModelState, VIDEO_AI_Q4_MODEL_FILES, VIDEO_AI_Q8_MODEL_FILES, VIDEO_AI_SMALL_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';
import type {DownloadProgress} from '@/src/core/download/progress';

const readCachedVideoAiModels = async (receipts: unknown) => (await readCachedVideoAiModelState(receipts)).models;

afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});

describe('video AI model cache', () => {
    it('keeps canonical cache ownership after a timed out source and forwards official preference plus connecting/receiving metadata', async () => {
        vi.useFakeTimers();
        const model = 'small', canonical = getVideoAiModelFileUrl(model, 'tokenizer.json');
        const saved: Array<{url: string; text: string}> = [];
        const cache = {match: async (url: string) => url === canonical ? undefined : new Response('cached', {headers: {'Content-Length': '4'}}),
            put: async (url: string, response: Response) => {saved.push({url, text: await response.text()});}};
        vi.stubGlobal('caches', {open: async () => cache});
        let resolveLate!: (response: Response) => void;
        const late = new Promise<Response>(resolve => {resolveLate = resolve;});
        const fetcher = vi.fn().mockImplementationOnce(() => late).mockResolvedValueOnce(new Response('verified'));
        vi.stubGlobal('fetch', fetcher);
        const reports: DownloadProgress[] = [];
        const pending = cacheVideoAiQ4ModelFiles(model, progress => reports.push(progress), {preference: 'official'});
        await vi.advanceTimersByTimeAsync(10_001); await pending;
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://huggingface.co/onnx-community/whisper-small/resolve/main/tokenizer.json', 'https://hf-mirror.com/onnx-community/whisper-small/resolve/main/tokenizer.json']);
        expect(saved).toEqual([{url: canonical, text: 'verified'}]);
        expect(reports.filter(item => item.transfer?.state === 'connecting').map(item => item.transfer?.source)).toContain('hf-mirror');
        expect(reports.at(-1)).toMatchObject({transfer: {source: 'hf-mirror', attempt: 2, attempts: 3, state: 'receiving'}});
        resolveLate(new Response('wrong late bytes')); await Promise.resolve(); await Promise.resolve();
        expect(saved).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    });
    it('does not touch Cache Storage without a valid download receipt', async () => {
        const open = vi.fn(), has = vi.fn();
        vi.stubGlobal('caches', {open, has});
        await expect(readCachedVideoAiModels([])).resolves.toEqual([]);
        await expect(readCachedVideoAiModels(['unknown'])).resolves.toEqual([]);
        expect(has).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
        vi.stubGlobal('caches', undefined);
        await expect(readCachedVideoAiModels(undefined)).resolves.toEqual([]);
    });
    it('does not create an absent cache when registered models are checked', async () => {
        const open = vi.fn(), has = vi.fn(async () => false);
        vi.stubGlobal('caches', {open, has});
        await expect(readCachedVideoAiModels(['tiny'])).resolves.toEqual([]);
        expect(has).toHaveBeenCalledWith('transformers-cache'); expect(open).not.toHaveBeenCalled();
    });
    it('reads only Request keys for registered default models without response bodies, inference or network', async () => {
        const urls = ['tiny', 'base', 'small'].flatMap(model => (model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES).map(file => getVideoAiModelFileUrl(model, file)));
        const cache = {keys: vi.fn(async () => urls.map(url => new Request(url))), match: vi.fn(() => {throw new Error('body access forbidden');}), put: vi.fn(), delete: vi.fn()};
        const open = vi.fn(async () => cache), fetcher = vi.fn(), worker = vi.fn();
        vi.stubGlobal('caches', {has: async () => true, open}); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('Worker', worker);
        await expect(readCachedVideoAiModels(['small', 'tiny', 'tiny', 'unknown'])).resolves.toEqual(['small', 'tiny']);
        expect(cache.keys).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledWith('transformers-cache');
        expect(cache.match).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled(); expect(cache.delete).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    });
    it.each(['tiny', 'base', 'small'].flatMap(model => (model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES).map(file => [model, file])))('rejects %s readiness when default required %s is missing', async (model, missing) => {
        const files = model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES;
        const urls = files.filter(file => file !== missing).map(file => getVideoAiModelFileUrl(model, file));
        vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys: async () => urls.map(url => new Request(url))})});
        await expect(readCachedVideoAiModels([model])).resolves.toEqual([]);
    });
    it.each(['tiny', 'base'])('keeps a complete %s q8 fallback ready without requiring another q4 download', async model => {
        const urls = VIDEO_AI_Q8_MODEL_FILES.map(file => getVideoAiModelFileUrl(model, file));
        const fetcher = vi.fn(), worker = vi.fn();
        vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys: async () => urls.map(url => new Request(url))})});
        vi.stubGlobal('fetch', fetcher); vi.stubGlobal('Worker', worker);
        await expect(readCachedVideoAiModels([model])).resolves.toEqual([model]);
        expect(fetcher).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    });
    it.each(['tiny', 'base'].flatMap(model => [[model, 'q4', 'q8'], [model, 'q8', 'q4']]))('does not mix %s %s encoder with %s decoder into one complete precision manifest', async (model, encoder, decoder) => {
        const files = [...VIDEO_AI_Q4_MODEL_FILES.slice(0, 5), encoder === 'q4' ? VIDEO_AI_Q4_MODEL_FILES[5] : VIDEO_AI_Q8_MODEL_FILES[5], decoder === 'q4' ? VIDEO_AI_Q4_MODEL_FILES[6] : VIDEO_AI_Q8_MODEL_FILES[6]];
        vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys: async () => files.map(file => new Request(getVideoAiModelFileUrl(model, file)))})});
        await expect(readCachedVideoAiModels([model])).resolves.toEqual([]);
    });
    it('does not substitute another model, revision, host or query keys for canonical files', async () => {
        const retainedQ8 = VIDEO_AI_Q8_MODEL_FILES.map(file => getVideoAiModelFileUrl('tiny', file));
        const urls = new Set([
            ...retainedQ8.filter(url => !url.endsWith('encoder_model_quantized.onnx')),
            ...VIDEO_AI_Q4_MODEL_FILES.map(file => getVideoAiModelFileUrl('base', file)),
            ...VIDEO_AI_Q4_MODEL_FILES.flatMap(file => {
                const url = getVideoAiModelFileUrl('tiny', file);
                return [url.replace('/master/', '/old/'), url.replace('modelscope.cn/models', 'huggingface.co'), `${url}?version=other`];
            }),
        ]);
        const keys = vi.fn(async () => [...urls].map(url => new Request(url)));
        vi.stubGlobal('caches', {has: async () => true, open: async () => ({keys})});
        await expect(readCachedVideoAiModels(['tiny', 'base'])).resolves.toEqual(['base']);
        for (const url of retainedQ8.slice(0, 5)) expect(urls.has(url)).toBe(true);
    });
    it.each(['has', 'open', 'keys'])('surfaces Cache Storage %s failures instead of reporting not downloaded', async failing => {
        const fail = async () => {throw new Error('controlled storage failure');};
        vi.stubGlobal('caches', {has: failing === 'has' ? fail : async () => true, open: failing === 'open' ? fail : async () => ({keys: fail})});
        await expect(readCachedVideoAiModels(['tiny'])).rejects.toThrow('无法读取模型缓存');
    });
    it('reports unavailable Cache Storage when a registered model requires checking', async () => {
        vi.stubGlobal('caches', undefined);
        await expect(readCachedVideoAiModels(['tiny'])).rejects.toThrow('不支持本地模型缓存');
    });
    it('repairs only the missing required file and makes the existing receipt ready without deleting fallback files', async () => {
        const model = 'tiny';
        const files = [...VIDEO_AI_Q4_MODEL_FILES, ...VIDEO_AI_Q8_MODEL_FILES];
        const entries = new Map(files.filter(file => file !== 'tokenizer.json').map(file => [getVideoAiModelFileUrl(model, file), new Response('cached')]));
        const cache = {keys: async () => [...entries.keys()].map(url => new Request(url)), match: async (url: string) => entries.get(url), put: async (url: string, response: Response) => {await response.arrayBuffer(); entries.set(url, new Response('repaired'));}};
        const fetcher = vi.fn(async (_url: string) => new Response('tokenizer'));
        vi.stubGlobal('caches', {has: async () => true, open: async () => cache}); vi.stubGlobal('fetch', fetcher);
        await expect(readCachedVideoAiModels([model])).resolves.toEqual([]);
        await cacheVideoAiQ4ModelFiles(model, undefined, {preference: 'mirror'});
        expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe(getVideoAiModelFileUrl(model, 'tokenizer.json'));
        await expect(readCachedVideoAiModels([model])).resolves.toEqual([model]);
        expect(entries.has(getVideoAiModelFileUrl(model, 'onnx/encoder_model_quantized.onnx'))).toBe(true);
    });
    it('Small completes only the seven mixed precision files and retries a missing final file', async () => {
        const entries = new Map<string, Response>();
        const cache = {
            match: vi.fn(async (url: string) => entries.get(url)),
            put: vi.fn(async (url: string, response: Response) => {await response.arrayBuffer(); entries.set(url, new Response('x', {headers: response.headers}));}),
        };
        const fetcher = vi.fn(async (url: string) => {
            if (url.endsWith('decoder_model_merged_q4.onnx')) throw new Error('last file unavailable');
            return new Response(new Uint8Array(4), {headers: {'Content-Length': '4'}});
        });
        vi.stubGlobal('caches', {open: async () => cache});vi.stubGlobal('fetch', fetcher);
        const failed: DownloadProgress[] = [];
        await expect(cacheVideoAiQ4ModelFiles('small', item => failed.push(item))).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: 'last file unavailable'},
        });
        expect(entries.size).toBe(6);
        expect(failed[0]).toMatchObject({loaded: 0, total: 590_000_000, transfer: {source: 'huggingface', state: 'connecting', attempt: 1, attempts: 3}});
        expect(failed.at(-1)!.loaded).toBeLessThan(failed.at(-1)!.total);
        fetcher.mockClear().mockImplementation(async () => new Response(new Uint8Array(4), {headers: {'Content-Length': '4'}}));
        const completed: DownloadProgress[] = [];
        await cacheVideoAiQ4ModelFiles('small', item => completed.push(item));
        expect(fetcher).toHaveBeenCalledOnce();
        expect([...entries.keys()]).toEqual(VIDEO_AI_SMALL_MODEL_FILES.map(file => getVideoAiModelFileUrl('small', file)));
        expect(VIDEO_AI_SMALL_MODEL_FILES).toContain('onnx/encoder_model.onnx');
        expect(VIDEO_AI_SMALL_MODEL_FILES).not.toContain('onnx/encoder_model_q4.onnx');
        expect(completed.at(-1)).toMatchObject({loaded: 28, total: 28, transfer: {state: 'receiving'}});
        await expect(cacheVideoAiQ8ModelFiles('small')).rejects.toThrow('FP32');
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it('Small admits a 353 MB encoder header but bounds oversized files before caching their body', async () => {
        const cache = {match: async (url: string) => url.endsWith('encoder_model.onnx') ? undefined : new Response('cached'),
            put: vi.fn(async () => {throw new Error('353 MB header admitted');})};
        vi.stubGlobal('caches', {open: async () => cache});
        vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(new Uint8Array(1), {headers: {'Content-Length': url.endsWith('encoder_model.onnx') ? '352825870' : '1'}})));
        await expect(cacheVideoAiQ4ModelFiles('small')).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: '353 MB header admitted'},
        });
        expect(cache.put).toHaveBeenCalled();
        cache.put.mockClear();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {headers: {'Content-Length': String(384 * 1024 * 1024 + 1)}})));
        await expect(cacheVideoAiQ4ModelFiles('small')).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: expect.stringContaining('大小上限')},
        });
        expect(cache.put).not.toHaveBeenCalled();
        // Small decoder and JSON files retain the original 256 MiB cap.
        cache.match = async (url: string) => url.endsWith('decoder_model_merged_q4.onnx') ? undefined : new Response('cached');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {headers: {'Content-Length': String(256 * 1024 * 1024 + 1)}})));
        await expect(cacheVideoAiQ4ModelFiles('small')).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: expect.stringContaining('大小上限')},
        });
        expect(cache.put).not.toHaveBeenCalled();
    });
    it('Small source retries share a ten-minute download deadline even while data keeps arriving', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('caches', {open: async () => ({match: async () => undefined, put: async (_url: string, response: Response) => {await response.text();}})});
        const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
            let interval: ReturnType<typeof setInterval>;
            return new Response(new ReadableStream<Uint8Array>({
                start(stream) {
                    interval = setInterval(() => stream.enqueue(new Uint8Array([1])), 10_000);
                    options.signal!.addEventListener('abort', () => {clearInterval(interval);stream.close();}, {once: true});
                },
                cancel() {clearInterval(interval);},
            }));
        });
        vi.stubGlobal('fetch', fetcher);
        const pending = cacheVideoAiQ4ModelFiles('small');
        const checked = expect(pending).rejects.toThrow('总等待时限');
        await vi.advanceTimersByTimeAsync(600_001);await checked;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });
    it.each(['tiny', 'base'])('gives %s slow continuous files one shared ten-minute budget without marking a partial sixth file cached', async model => {
        vi.useFakeTimers();
        const entries = new Map<string, Response>();
        const cache = {match: async (url: string) => entries.get(url), put: async (url: string, response: Response) => {
            const text = await response.text(); entries.set(url, new Response(text));
        }};
        vi.stubGlobal('caches', {open: async () => cache});
        const fetched = vi.fn(async () => {
            let interval: ReturnType<typeof setInterval>, finish: ReturnType<typeof setTimeout>;
            const clean = () => {clearInterval(interval); clearTimeout(finish);};
            return new Response(new ReadableStream<Uint8Array>({start(stream) {
                interval = setInterval(() => stream.enqueue(new Uint8Array([1])), 10_000);
                finish = setTimeout(() => {clearInterval(interval); stream.close();}, 110_000);
            }, cancel: clean}));
        });
        vi.stubGlobal('fetch', fetched);
        const pending = cacheVideoAiQ4ModelFiles(model), checked = expect(pending).rejects.toThrow('模型下载超过总等待时限');
        await vi.advanceTimersByTimeAsync(599_999);
        expect(entries.size).toBe(5); expect(fetched).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(1); await checked;
        expect([...entries.keys()]).toEqual(VIDEO_AI_Q4_MODEL_FILES.slice(0, 5).map(file => getVideoAiModelFileUrl(model, file)));
        expect(vi.getTimerCount()).toBe(0);
    });
    it('builds normalized model URLs and exposes both dtype manifests', () => {
        expect(getVideoAiModelFileUrl('base', VIDEO_AI_Q4_MODEL_FILES[0])).toContain('whisper-base');
        expect(VIDEO_AI_Q8_MODEL_FILES).toContain('onnx/encoder_model_quantized.onnx');
    });
    it('downloads only missing files and uses the q8 manifest', async () => {
        const entries = new Set<string>();
        const cache = {
            match: vi.fn(async (url: string) => entries.has(url) ? new Response('cached') : undefined),
            put: vi.fn(async (url: string, response: Response) => { await response.arrayBuffer(); entries.add(url); }),
        };
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        vi.stubGlobal('window', {setTimeout, clearTimeout});
        vi.stubGlobal('fetch', vi.fn(async () => new Response('model')));
        await cacheVideoAiModelFiles('tiny', 'q8');
        expect(cache.put).toHaveBeenCalledTimes(VIDEO_AI_Q8_MODEL_FILES.length);
        await cacheVideoAiModelFiles('tiny', 'q8');
        expect(cache.put).toHaveBeenCalledTimes(VIDEO_AI_Q8_MODEL_FILES.length);
    });
    it('reports one combined byte progress for the whole model and counts cached files', async () => {
        const entries = new Map<string, Response>();
        const cache = {
            match: vi.fn(async (url: string) => entries.get(url)),
            put: vi.fn(async (url: string, response: Response) => { await response.arrayBuffer(); entries.set(url, new Response('x', {headers: response.headers})); }),
        };
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        vi.stubGlobal('window', {setTimeout, clearTimeout});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4), {headers: {'Content-Length': '4'}})));
        const reports: DownloadProgress[] = [];
        await cacheVideoAiQ4ModelFiles('tiny', progress => reports.push(progress));
        const exact = VIDEO_AI_Q4_MODEL_FILES.length * 4;
        // 最后一个文件开始前按界面标注的 100 MB 计算，全部大小已知后改用精确合计。
        expect(reports[0]).toMatchObject({loaded: 0, total: 100_000_000, transfer: {state: 'connecting'}});
        expect(reports.at(-1)).toMatchObject({loaded: exact, total: exact, transfer: {state: 'receiving'}});
        expect(reports.every((item, index) => index === 0 || item.loaded >= reports[index - 1].loaded)).toBe(true);

        // 再次调用时文件都在缓存里：按缓存响应头的大小计入已完成部分。
        const cached: Array<{loaded: number; total: number}> = [];
        await cacheVideoAiModelFiles('tiny', 'q4', progress => cached.push(progress));
        expect(cached.at(-1)).toEqual({loaded: exact, total: exact});
        expect(fetch).toHaveBeenCalledTimes(VIDEO_AI_Q4_MODEL_FILES.length);

        // q8 回退没有预计体积：文件大小未全部确定前不给总量。
        const q8: DownloadProgress[] = [];
        await cacheVideoAiQ8ModelFiles('tiny', progress => q8.push(progress));
        expect(q8.some(item => item.total === 0)).toBe(true);
        expect(q8.at(-1)).toMatchObject({loaded: exact, total: exact, transfer: {state: 'receiving'}});
    });
    it('fails clearly when Cache Storage is unavailable or fetch fails', async () => {
        vi.stubGlobal('caches', undefined);
        await expect(cacheVideoAiModelFiles('tiny')).rejects.toThrow('缓存');
        const cache = {match: vi.fn(async () => undefined), put: vi.fn()};
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        vi.stubGlobal('window', {setTimeout, clearTimeout});
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status: 503})));
        await expect(cacheVideoAiModelFiles('tiny')).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: '模型文件下载失败（503）'},
        });
        const cause = new Error('Hugging Face / HF Mirror / ModelScope connection failed');
        vi.stubGlobal('fetch', vi.fn(async () => {throw cause;}));
        await expect(cacheVideoAiModelFiles('tiny')).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause,
        });
    });
    it('keeps q4 and q8 wrapper calls on the same cache implementation', async () => {
        const cache = {match: vi.fn(async () => new Response('cached')), put: vi.fn()};
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        vi.stubGlobal('window', {setTimeout, clearTimeout});
        await cacheVideoAiQ4ModelFiles('tiny');
        await cacheVideoAiQ8ModelFiles('tiny');
        expect(cache.match).toHaveBeenCalledTimes(VIDEO_AI_Q4_MODEL_FILES.length + VIDEO_AI_Q8_MODEL_FILES.length);
    });
    it('keeps per-source timeout diagnostics as the cause of an actionable download error', async () => {
        vi.useFakeTimers();
        const cache = {match: vi.fn(async () => undefined), put: vi.fn()};
        vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
        vi.stubGlobal('window', {setTimeout, clearTimeout});
        vi.stubGlobal('fetch', vi.fn((_url: string, options: {signal: AbortSignal}) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        })));
        const pending = cacheVideoAiModelFiles('tiny');
        const assertion = expect(pending).rejects.toMatchObject({
            message: '模型下载失败，请检查网络后重试', cause: {message: expect.stringContaining('超过')},
        });
        await vi.advanceTimersByTimeAsync(120_000 * 4);
        await assertion;
        vi.useRealTimers();
    });
});
