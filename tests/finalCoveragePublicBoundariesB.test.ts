/**
 * @file tests/finalCoveragePublicBoundariesB.test.ts
 * 文件职责：验证后台装配、OCR、下载与响应流等公共边界行为。
 * 主要内容：后台处理器装配、同高物理行排序、借用图片准备后取消、SDK 错误回调、
 * 下载暂停后的迟到成功、Web Audio 同步失败、锁定的 WebDAV 响应流和模型配置身份。
 * 模块边界：不导出私有函数、不复制业务逻辑、不替换生产源码；仅控制明确的外部端口。
 * 图片状态查询取消已有完整用例，另建议注册原 tests/imageOcrStatusCancellation.test.ts。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Config as ConfigType} from '@/src/core/config/model';
import type {TranslationArtifact} from '@/src/features/local-translation/offscreen/artifactStore';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}

// 每个用例独立加载真实模块。公共服务端口和外部 SDK 的替换只存在于该用例。
const mockedModules = new Set<string>();
const cleanups: Array<() => void | Promise<void>> = [];
function port(module: string, factory: () => Record<string, unknown>) {
    mockedModules.add(module);
    vi.doMock(module, factory);
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
    try {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    } finally {
        for (const module of mockedModules) vi.doUnmock(module);
        mockedModules.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        if (vi.isFakeTimers()) {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
        vi.resetModules();
    }
});

async function providerComposition() {
    const {Config} = await import('@/src/core/config/model');
    const source = new Config();
    source.model.openai = 'gpt-4o';
    const ready = deferred<void>();
    cleanups.push(() => ready.resolve());
    const recordMany = vi.fn(async () => 1);
    const captureGeneration = vi.fn(() => 11);
    const runConnection = vi.fn(async (_service: string, options: {
        recordModelUsage(events: unknown[]): Promise<void>;
    }) => {
        // provider 公共端口按其契约提交事件，不绕过真实组合根的注入函数。
        await options.recordModelUsage([{serviceId: 'openai', modelId: 'gpt-4o'}]);
        return {durationMs: 25};
    });
    const resolveProbe = vi.fn(async (_source: ConfigType, _service: string, _model: string, _options: unknown) =>
        ({capability: 'supported' as const, source: 'probe' as const, checkedAt: 123}));
    const browserPort = {runtime: {id: 'boundary-b', getURL: (path: string) => `chrome-extension://boundary-b/${path.replace(/^\//u, '')}`}};
    vi.stubGlobal('browser', browserPort);
    port('webextension-polyfill', () => ({default: browserPort}));
    port('@/src/services/config/store', () => ({config: source, configReady: ready.promise}));
    port('@/src/providers/translation/connectionTest', () => ({
        runTranslationServiceConnectionTest: runConnection,
        formatConnectionTestError: (_service: string, error: unknown) => String(error),
    }));
    port('@/src/providers/translation/free-translation', () => ({getFreeTranslationWeightSnapshot: vi.fn()}));
    const {createTranslationRequestScheduler} = await import('@/src/services/translation/requestScheduler');
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    port('@/src/app/translation/runtime', () => ({translationRequestScheduler: scheduler}));
    port('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: resolveProbe}}));
    port('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository: () => ({recordMany, captureGeneration})}));
    const {createProviderTestRuntimeHandlers} = await import('@/src/app/background/providerRuntime');
    const {createBackgroundMessageRouter} = await import('@/src/services/messaging/backgroundRouter');
    // 通过实际 router 分派，不调用组合根内部闭包或替换两个真实 handler factory。
    const router = createBackgroundMessageRouter<{sender?: {url?: string}}>(createProviderTestRuntimeHandlers());
    return {source, ready, router, runConnection, resolveProbe, recordMany, captureGeneration, scheduler};
}

describe('final boundary B provider composition public routing', () => {
    it('waits for config readiness and routes connection tests through the usage-aware provider port', async () => {
        const fixture = await providerComposition();
        const pending = fixture.router.dispatch({type: 'testTranslationService', service: 'openai'}, {});
        await Promise.resolve();
        expect(fixture.runConnection).not.toHaveBeenCalled();
        fixture.ready.resolve();
        await expect(pending).resolves.toEqual({handled: true, response: {success: true, durationMs: 25}});
        expect(fixture.captureGeneration).toHaveBeenCalledOnce();
        expect(fixture.recordMany).toHaveBeenCalledWith([{serviceId: 'openai', modelId: 'gpt-4o'}], 11);
        expect(fixture.runConnection).toHaveBeenCalledWith('openai', expect.objectContaining({
            configuredModel: 'gpt-4o', effectiveModel: 'gpt-4o', requestScheduler: fixture.scheduler,
            config: expect.objectContaining({model: expect.objectContaining({openai: 'gpt-4o'})}),
        }));
    });

    it('allows exact options-page query/hash URLs and sends the current frozen config to the vision port', async () => {
        const fixture = await providerComposition();
        const {createVisionProbeIdentity} = await import('@/src/core/config/visionProbe');
        const {VISION_PROBE_MESSAGE} = await import('@/src/services/translation/types');
        fixture.ready.resolve();
        const identity = createVisionProbeIdentity(fixture.source, 'openai', 'gpt-4o');
        for (const [index, suffix] of ['?service=openai#settings', '#settings'].entries()) {
            const result = await fixture.router.dispatch({type: VISION_PROBE_MESSAGE, service: 'openai', model: 'gpt-4o',
                identity, requestId: `boundary-b-vision-${index}`}, {sender: {url: `chrome-extension://boundary-b/options.html${suffix}`}});
            expect(result).toEqual({handled: true, response: {success: true, capability: 'supported', source: 'probe', checkedAt: 123}});
        }
        expect(fixture.resolveProbe).toHaveBeenCalledTimes(2);
        expect(fixture.resolveProbe).toHaveBeenLastCalledWith(expect.objectContaining({model: expect.objectContaining({openai: 'gpt-4o'})}),
            'openai', 'gpt-4o', {force: true, signal: expect.any(AbortSignal), timeoutMs: expect.any(Number)});
        const frozen = fixture.resolveProbe.mock.calls[0][0] as unknown as ConfigType;
        expect(frozen).not.toBe(fixture.source);
        fixture.source.model.openai = 'changed-model';
        expect(frozen.model.openai).toBe('gpt-4o');
    });

    it('rejects lookalike paths and foreign origins before the vision provider runs', async () => {
        const fixture = await providerComposition();
        const {VISION_PROBE_MESSAGE, VISION_PROBE_CANCEL_MESSAGE} = await import('@/src/services/translation/types');
        fixture.ready.resolve();
        for (const url of ['chrome-extension://boundary-b/options.html.evil', 'chrome-extension://other/options.html', 'https://fixture.invalid/options.html']) {
            for (const type of [VISION_PROBE_MESSAGE, VISION_PROBE_CANCEL_MESSAGE]) {
                await expect(fixture.router.dispatch({type, service: 'openai', model: 'gpt-4o', requestId: 'boundary-b-untrusted'}, {sender: {url}}))
                    .rejects.toThrow('识图检测仅可从设置页执行');
            }
        }
        expect(fixture.resolveProbe).not.toHaveBeenCalled();
    });
});

describe('final boundary B physical OCR line ordering', () => {
    it('orders equal-height ordinary-image lines left to right while preserving separate physical lines', async () => {
        const {collectMangaRegions} = await import('@/src/features/image-translation/services/mangaBubbles');
        const text = (value: string, x: number) => ({text: value, confidence: 0.99, box: {x, y: 40, width: 90, height: 12}});
        const regions = collectMangaRegions({results: [text('Right column', 210), text('Left column', 20)]}, 'en', 400, 400, 'image');
        expect(regions.map(region => ({text: region.text, bbox: region.bbox}))).toEqual([
            {text: 'Left column', bbox: {x0: 20, y0: 40, x1: 110, y1: 52}},
            {text: 'Right column', bbox: {x0: 210, y0: 40, x1: 300, y1: 52}},
        ]);
        expect(regions.every(region => region.sourceBoxes === undefined)).toBe(true);
    });
});

async function ocrSdkFixture(failFirst = false) {
    type SdkOptions = {errorHandler(reason: unknown): void; logger(message: unknown): void};
    // PNG 也会经过真实 prepareOcrImage/flattenOcrAlpha；Canvas 外部端口提供完整、
    // 不透明且与源图分离的 RGBA 副本，不替换像素处理、共享取消、Worker 或缓存模块。
    const sourcePixels = new Uint8ClampedArray(100 * 100 * 4);
    for (let index = 0; index < sourcePixels.length; index += 4) sourcePixels.set([28, 64, 96, 255], index);
    const image = {naturalWidth: 100, naturalHeight: 100, src: 'borrowed-source', pixels: sourcePixels} as unknown as HTMLImageElement;
    const readbacks: Array<{width: number; height: number; data: Uint8ClampedArray}> = [];
    const canvases: Array<{width: number; height: number; getContext: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn>}> = [];
    const drawImage = vi.fn();
    const getImageData = vi.fn();
    const putImageData = vi.fn();
    const createElement = vi.fn((tag: string) => {
        if (tag !== 'canvas') throw new Error(`Unexpected OCR element ${tag}`);
        let drawnPixels = new Uint8ClampedArray();
        const canvas = {width: 0, height: 0,
            getContext: vi.fn((kind: string) => {
                if (kind !== '2d') return null;
                return {
                    drawImage: (source: HTMLImageElement, x: number, y: number, width: number, height: number) => {
                        drawImage(source, x, y, width, height);
                        if (source !== image || x !== 0 || y !== 0 || width !== 100 || height !== 100) {
                            throw new Error('Opaque borrowed-image fixture received unexpected raster geometry');
                        }
                        drawnPixels = new Uint8ClampedArray(sourcePixels);
                    },
                    getImageData: (x: number, y: number, width: number, height: number) => {
                        getImageData(x, y, width, height);
                        if (x !== 0 || y !== 0 || width !== canvas.width || height !== canvas.height
                            || drawnPixels.length !== width * height * 4) throw new Error('Incomplete Canvas RGBA fixture');
                        const pixels = {width, height, data: new Uint8ClampedArray(drawnPixels)};
                        readbacks.push(pixels);
                        return pixels;
                    },
                    putImageData: (pixels: {data: Uint8ClampedArray}, x: number, y: number) => {
                        putImageData(pixels, x, y);
                        drawnPixels = new Uint8ClampedArray(pixels.data);
                    },
                    imageSmoothingEnabled: false,
                    imageSmoothingQuality: 'low',
                };
            }),
            // 原尺寸不透明 PNG 应复用原编码；若发生额外编码，明确失败而非悬挂回调。
            toBlob: vi.fn(() => {throw new Error('Unexpected re-encoding of opaque original-size PNG');}),
        };
        canvases.push(canvas);
        return canvas;
    });
    vi.stubGlobal('document', {createElement});
    const reason = new Error('boundary-b SDK recognition failure');
    const escaped: unknown[] = [];
    const sdkCallbacks: unknown[] = [];
    let options!: SdkOptions;
    let failed = false;
    const result = {data: {blocks: [{paragraphs: [{lines: [{text: 'Retried text', confidence: 91,
        bbox: {x0: 1, y0: 2, x1: 70, y1: 20}}]}]}]}};
    const worker = {
        setParameters: vi.fn(async () => undefined),
        terminate: vi.fn(async () => undefined),
        recognize: vi.fn(async () => {
            if (failFirst && !failed) {
                failed = true;
                // 合理的外部 SDK 端口：同一作业既拒绝 Promise，也递送 errorHandler。
                // 真正的业务 Worker runtime、共享取消和缓存模块都保持原样。
                sdkCallbacks.push(reason);
                const rejectedJob = Promise.reject(reason);
                try {options.errorHandler(reason);} catch (error) {escaped.push(error);}
                return rejectedJob;
            }
            return result;
        }),
    };
    const createWorker = vi.fn(async (_languages: string[], _oem: number, input: SdkOptions) => {options = input; return worker;});
    port('tesseract.js', () => ({createWorker, PSM: {SPARSE_TEXT: 11, SPARSE_TEXT_OSD: 12, SINGLE_BLOCK: 6}}));
    vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://boundary-b${path}`}});
    const {recognizeImage} = await import('@/src/features/image-translation/services/ocrRuntime');
    return {recognizeImage, createWorker, worker, reason, escaped, sdkCallbacks,
        image, sourcePixels, canvases, readbacks, createElement, drawImage, getImageData, putImageData};
}

describe('final boundary B actual OCR public consumer', () => {
    it('rejects cancellation after synchronous borrowed-image preparation without creating an SDK worker or caching a result', async () => {
        const fixture = await ocrSdkFixture();
        const {image} = fixture;
        const originalPixels = new Uint8ClampedArray(fixture.sourcePixels);
        const controller = new AbortController();
        const operation = fixture.recognizeImage('data:image/png;base64,fixture', 'en', controller.signal, {decodedImage: image});
        const outcome = operation.then(value => ({value}), error => ({error}));
        expect(fixture.drawImage).toHaveBeenCalledWith(image, 0, 0, 100, 100);
        expect(fixture.getImageData).toHaveBeenCalledWith(0, 0, 100, 100);
        expect(fixture.readbacks[0].data).toHaveLength(100 * 100 * 4);
        expect(fixture.readbacks[0].data).not.toBe(fixture.sourcePixels);
        // public 调用已返回；准备后的 await 尚未恢复，真实调用方立即取消。
        controller.abort();
        expect(await outcome).toMatchObject({error: {name: 'AbortError', message: '图片 OCR 请求已取消'}});
        // 让已取消共享任务的 continuation 消费完；不推进任意虚构的 internals。
        await Promise.resolve();
        expect(fixture.createWorker).not.toHaveBeenCalled();
        expect(image.src).toBe('borrowed-source');
        await expect(fixture.recognizeImage('data:image/png;base64,fixture', 'en', undefined, {decodedImage: image})).resolves.toEqual([
            {text: 'Retried text', bbox: {x0: 1, y0: 2, x1: 70, y1: 20}},
        ]);
        expect(fixture.worker.recognize).toHaveBeenCalledOnce();
        expect(fixture.worker.recognize).toHaveBeenCalledWith('data:image/png;base64,fixture', {}, {blocks: true}, expect.any(String));
        await expect(fixture.recognizeImage('data:image/png;base64,fixture', 'en', undefined, {decodedImage: image})).resolves.toEqual([
            {text: 'Retried text', bbox: {x0: 1, y0: 2, x1: 70, y1: 20}},
        ]);
        expect(fixture.worker.recognize).toHaveBeenCalledOnce();
        expect(fixture.createElement).toHaveBeenCalledTimes(2);
        expect(fixture.putImageData).not.toHaveBeenCalled();
        expect(fixture.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(fixture.canvases.every(canvas => canvas.toBlob.mock.calls.length === 0)).toBe(true);
        expect(fixture.readbacks.every(pixels => pixels.data.length === 100 * 100 * 4
            && pixels.data.every((value, index) => value === originalPixels[index]))).toBe(true);
        expect(fixture.sourcePixels).toEqual(originalPixels);
        expect(image.src).toBe('borrowed-source');
    });

    it('consumes SDK error callbacks without escaping an exception and preserves the original job rejection for a clean retry', async () => {
        const fixture = await ocrSdkFixture(true);
        const {image} = fixture;
        const originalPixels = new Uint8ClampedArray(fixture.sourcePixels);
        await expect(fixture.recognizeImage('data:image/png;base64,sdk-fixture', 'en', undefined, {decodedImage: image})).rejects.toBe(fixture.reason);
        expect(fixture.sdkCallbacks).toEqual([fixture.reason]);
        expect(fixture.escaped).toEqual([]);
        await expect(fixture.recognizeImage('data:image/png;base64,sdk-fixture', 'en', undefined, {decodedImage: image})).resolves.toEqual([
            {text: 'Retried text', bbox: {x0: 1, y0: 2, x1: 70, y1: 20}},
        ]);
        expect(fixture.createWorker).toHaveBeenCalledOnce();
        expect(fixture.worker.setParameters).toHaveBeenCalledOnce();
        expect(fixture.worker.recognize).toHaveBeenCalledTimes(2);
        expect(fixture.worker.recognize).toHaveBeenLastCalledWith('data:image/png;base64,sdk-fixture', {}, {blocks: true}, expect.any(String));
        await fixture.recognizeImage('data:image/png;base64,sdk-fixture', 'en', undefined, {decodedImage: image});
        expect(fixture.worker.recognize).toHaveBeenCalledTimes(2);
        expect(fixture.createElement).toHaveBeenCalledTimes(2);
        expect(fixture.drawImage).toHaveBeenCalledWith(image, 0, 0, 100, 100);
        expect(fixture.getImageData).toHaveBeenCalledWith(0, 0, 100, 100);
        expect(fixture.putImageData).not.toHaveBeenCalled();
        expect(fixture.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(fixture.canvases.every(canvas => canvas.toBlob.mock.calls.length === 0)).toBe(true);
        expect(fixture.readbacks.every(pixels => pixels.data.length === 100 * 100 * 4
            && pixels.data !== fixture.sourcePixels && pixels.data.every((value, index) => value === originalPixels[index]))).toBe(true);
        expect(fixture.sourcePixels).toEqual(originalPixels);
        expect(image.src).toBe('borrowed-source');
    });
});

describe('final boundary B independent local-download ownership', () => {
    it('keeps an active download paused when its transfer port returns late success, and resumes only on a new public start', async () => {
        const actual = await import('@/src/features/local-translation/offscreen/artifactStore');
        const {LOCAL_TRANSLATION_MODEL_IDS: ids} = await import('@/src/core/config/localTranslation');
        const transferEntered = deferred<AbortSignal>();
        const finishTransfer = deferred<void>();
        const pausedFinal = deferred<void>();
        const resumedFinal = deferred<void>();
        const download = vi.fn(async (_file: TranslationArtifact, signal: AbortSignal) => {
            transferEntered.resolve(signal);
            await finishTransfer.promise;
        });
        // artifactStore 是 manager 的公开文件传输端口；保留真实清单，模拟取消后
        // 底层迟到兑现成功的已开始传输，不导出或调用 manager 的私有 run/update。
        port('@/src/features/local-translation/offscreen/artifactStore', () => ({...actual,
            artifactComplete: async () => false, artifactDownloadedBytes: async () => 0,
            downloadTranslationArtifact: download,
        }));
        const entries = new Map<string, Response>();
        vi.stubGlobal('caches', {open: async () => ({
            match: async (key: string) => entries.get(key)?.clone(),
            put: async (key: string, value: Response) => {entries.set(key, value.clone());},
        })});
        vi.stubGlobal('WebAssembly', {...WebAssembly, Suspending: function () {}, promising: function () {}});
        vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10_000_000_000, usage: 0})}});
        const {createLocalTranslationDownloadManager} = await import('@/src/features/local-translation/offscreen/downloads');
        let pausedCount = 0;
        const manager = createLocalTranslationDownloadManager({onChange: async snapshot => {
            const task = snapshot.tasks.find(task => task.model === ids.opusZhEn);
            if (task?.phase === 'paused' && ++pausedCount === 2) pausedFinal.resolve();
            if (task?.phase === 'ready') resumedFinal.resolve();
        }});
        cleanups.push(async () => {finishTransfer.resolve(); await manager.pause(ids.opusZhEn);});
        await manager.start(ids.opusZhEn);
        const signal = await transferEntered.promise;
        await manager.pause(ids.opusZhEn);
        expect(signal.aborted).toBe(true);
        finishTransfer.resolve();
        await pausedFinal.promise;
        expect((await manager.status()).tasks.find(task => task.model === ids.opusZhEn))
            .toMatchObject({phase: 'paused', bytesPerSecond: 0, error: undefined});
        const initialCalls = download.mock.calls.length;
        expect(initialCalls).toBe(Math.min(3, actual.getTranslationArtifacts(ids.opusZhEn).length));
        download.mockImplementation(async () => undefined);
        await manager.start(ids.opusZhEn);
        await resumedFinal.promise;
        expect((await manager.status()).tasks.find(task => task.model === ids.opusZhEn))
            .toMatchObject({phase: 'ready', bytesPerSecond: 0, error: undefined});
        expect(download).toHaveBeenCalledTimes(initialCalls + actual.getTranslationArtifacts(ids.opusZhEn).length);
    });
});

describe('final boundary B synchronous Web Audio decoder failure', () => {
    it('closes the decoder and returns a sanitized decode error when the Web Audio port throws before a deadline is created', async () => {
        vi.useFakeTimers();
        const close = vi.fn(async () => undefined);
        const decode = vi.fn(() => {throw new DOMException('controlled decoder refused the input', 'InvalidStateError');});
        const createWorker = vi.fn();
        class AudioContextPort {
            state = 'running';
            decodeAudioData = decode;
            close = close;
        }
        vi.stubGlobal('window', {location: {href: 'chrome-extension://boundary-b/offscreen.html'}, setTimeout, clearTimeout, AudioContext: AudioContextPort});
        vi.stubGlobal('Worker', class {constructor() {createWorker();}});
        const {transcribeLocalVideoAudio, cancelLocalVideoTranscription} = await import('@/src/features/video-subtitle/offscreen/transcription');
        cleanups.push(() => cancelLocalVideoTranscription('boundary-b-sync-decode'));
        await expect(transcribeLocalVideoAudio({streamId: 'boundary-b-sync-decode', audioBase64: 'AAAAAA==', model: 'tiny'}))
            .rejects.toThrow('音频解码失败：controlled decoder refused the input');
        expect(decode).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(createWorker).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1); // 只有既有的 30 秒空闲释放计时器。
        await cancelLocalVideoTranscription('boundary-b-sync-decode');
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('final boundary B WebDAV response stream ownership', () => {
    it.each([[200, 'network', undefined], [423, 'locked', 423]] as const)
    ('preserves the public error for a HTTP %i response whose body belongs to another reader', async (status, code, expectedStatus) => {
        vi.useFakeTimers();
        const {createWebDavApi} = await import('@/src/platform/webdav/api');
        const {createWebDavSession} = await import('@/src/platform/webdav/connection');
        const connection = {url: 'https://dav.fixture.invalid/base/', username: 'fixture', password: 'synthetic-only', allowInsecure: false, revision: 'b-fixture'};
        const session = createWebDavSession(connection, async () => connection);
        const cancel = vi.fn();
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {controller.enqueue(new TextEncoder().encode('fixture body'));}, cancel,
        }), {status});
        const reader = response.body!.getReader();
        try {
            const fetcher = vi.fn<typeof fetch>(async () => response);
            await expect(createWebDavApi(fetcher).read(session)).rejects.toMatchObject({code, status: expectedStatus});
            expect(fetcher).toHaveBeenCalledOnce();
            expect(response.body!.locked).toBe(true);
            expect(cancel).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(await reader.read()).toEqual({done: false, value: new TextEncoder().encode('fixture body')});
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
        expect(response.body!.locked).toBe(false);
    });
});

describe('final boundary B free-web cancellation between completed chunks', () => {
    it('preserves the caller reason and never starts a second chunk after a completed first response yields to cancellation', async () => {
        const {setRuntimeFetch} = await import('@/src/platform/http/runtime');
        cleanups.push(() => setRuntimeFetch());
        const {translateFreeChineseWebText} = await import('@/src/providers/translation/free-chinese-web');
        const jsonEntered = deferred<void>();
        const parsed = deferred<{fanyi: {tran: string}}>();
        const response = Response.json({fanyi: {tran: 'first translated chunk'}});
        // 控制实际 Response 的公开 json 端口，仍返回原生 Promise 与普通 JSON 对象。
        response.json = vi.fn(() => {jsonEntered.resolve(); return parsed.promise;});
        const fetcher = vi.fn<typeof fetch>(async () => response);
        setRuntimeFetch(fetcher);
        const controller = new AbortController();
        const reason = new DOMException('stopped between translation chunks', 'AbortError');
        const operation = translateFreeChineseWebText('youdaoFree', 'a'.repeat(1001), 'en', 'zh-Hans', controller.signal);
        const outcome = operation.then(value => ({value}), error => ({error}));
        await jsonEntered.promise;
        parsed.resolve({fanyi: {tran: 'first translated chunk'}});
        // JSON reader 与 provider 分别跨过一次真实 await。取消发生在串行 slot/chunk
        // 循环恢复之前，而非在 response.json 内部伪造 signal.aborted getter。
        await Promise.resolve();
        await Promise.resolve();
        controller.abort(reason);
        expect(await outcome).toEqual({error: reason});
        expect(fetcher).toHaveBeenCalledOnce();
        expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('q')).toBe('a'.repeat(500));
        expect(fetcher.mock.calls[0][1]).toMatchObject({signal: controller.signal, credentials: 'omit'});
    });
});

describe('final boundary B model-input configuration identity', () => {
    beforeEach(async () => {
        const {Config} = await import('@/src/core/config/model');
        const actualConfig = new Config();
        port('@/src/services/config/store', () => ({config: actualConfig, configReady: Promise.resolve()}));
    });

    it.each(['claude', 'gemini'] as const)('normalizes absent/blank %s proxies and invalidates its input key only on effective endpoint changes', async service => {
        const {Config} = await import('@/src/core/config/model');
        const {getHarnessModelInputKey} = await import('@/src/services/harness/modelGateway');
        const config = new Config();
        config.proxy[service] = '';
        const baseline = getHarnessModelInputKey(config, service, 'fixture-model');
        delete config.proxy[service];
        expect(getHarnessModelInputKey(config, service, 'fixture-model')).toBe(baseline);
        config.proxy[service] = '   ';
        expect(getHarnessModelInputKey(config, service, 'fixture-model')).toBe(baseline);
        config.proxy[service] = 'https://native.fixture.invalid/endpoint';
        const changed = getHarnessModelInputKey(config, service, 'fixture-model');
        expect(changed).not.toBe(baseline);
        expect(changed).toMatch(/^[a-f0-9]{64}$/u);
        config.proxy[service] = ' https://native.fixture.invalid/endpoint ';
        expect(getHarnessModelInputKey(config, service, ' fixture-model ')).toBe(changed);
    });

    it('distinguishes invalid custom headers from valid empty headers and canonicalizes valid header order', async () => {
        const {Config} = await import('@/src/core/config/model');
        const {getHarnessModelInputKey} = await import('@/src/services/harness/modelGateway');
        const config = new Config();
        const service = 'custom:boundary-b';
        config.customOpenAIProviders = [{id: service, name: 'Boundary fixture', endpoint: 'https://custom.fixture.invalid/v1/chat/completions', models: ['fixture-model']}];
        const empty = getHarnessModelInputKey(config, service, 'fixture-model');
        config.customHeaders[service] = '{invalid';
        const invalid = getHarnessModelInputKey(config, service, 'fixture-model');
        expect(invalid).not.toBe(empty);
        config.customHeaders[service] = '{"x-number":1}';
        expect(getHarnessModelInputKey(config, service, 'fixture-model')).toBe(invalid);
        config.customHeaders[service] = '{"x-b":"fixture-B","x-a":"fixture-A"}';
        const valid = getHarnessModelInputKey(config, service, 'fixture-model');
        expect(valid).not.toBe(invalid);
        config.customHeaders[service] = '{"X-A":"fixture-A","X-B":"fixture-B"}';
        expect(getHarnessModelInputKey(config, service, 'fixture-model')).toBe(valid);
    });
});
