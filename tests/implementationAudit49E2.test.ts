import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {loadMangaInpaintAsset, loadMangaOcrAssets, mangaOcrModelStatus, removeMangaOcrAssets, importMangaModel, MANGA_INPAINT_ASSET, MANGA_OCR_ASSETS, MANGA_OCR_CACHE} from '@/src/features/image-translation/services/mangaOcrAssets';
import {createBrowserMangaOcr, createMangaOcrRuntime, mangaOcrRuntime, removeMangaModels} from '@/src/features/image-translation/services/mangaOcr';
import {createBrowserMangaInpainter, createMangaInpaintingRuntime, mangaInpaintingRuntime} from '@/src/features/image-translation/services/mangaInpainting';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {startMangaInferenceWorker} from '@/src/features/image-translation/services/mangaInference.worker';
import type {MangaInferenceMessage, MangaInferenceResponse} from '@/src/features/image-translation/services/mangaInferenceClient';
import * as ort from 'onnxruntime-web/webgpu';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createVirtualModelResponsePort, virtualModelBuffer} from './helpers/virtualModelResponse';
// 本组显式虚拟容量不含真实 ONNX wire；仅控制纯模型变换端口，保留实际资源校验/入库/取消/删除生命周期。
vi.mock('@/src/features/image-translation/services/mangaRecognitionShapes',async original=>({...await original<any>(),optimizeVerifiedMangaRecognition:(buffer:ArrayBuffer)=>buffer}));

const sdk = vi.hoisted(() => ({sessions: [] as any[], detectors: [] as Array<{session: unknown; options: unknown}>, detectionSession: undefined as any, create: vi.fn(), initialize: vi.fn(), recognize: vi.fn(), destroy: vi.fn()}));
vi.mock('onnxruntime-web/webgpu', () => ({env: {wasm: {}}, InferenceSession: {create: sdk.create}, Tensor: class {
    constructor(public type: string, public data: Float32Array, public dims: number[]) {}
    dispose() {}
}}));
vi.mock('ppu-paddle-ocr/web', () => ({RecognitionService: class {}, DetectionService: class {
    platform = {canvas: {createProcessor: () => ({findRegions: () => []})}};
    constructor(public session: unknown, public options: unknown) {sdk.detectors.push(this);}
}, PaddleOcrService: class {
    constructor(public options: unknown) {}
    detector: unknown;
    detectionSession = sdk.detectionSession; recognitionSession = undefined;
    async initialize() {await sdk.initialize();}
    async recognize() {return sdk.recognize();}
    async destroy() {await sdk.destroy();}
}}));

type Asset = {bytes: number; sha256: string};
const rootUrl = 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/bf1d5edb0335d3262be7caf13f766ba274b4cadd/';
const allAssets = [...MANGA_OCR_ASSETS, MANGA_INPAINT_ASSET];
const NativeResponse = globalThis.Response;
// Explicitly tagged metadata/crypto/Response ports represent model capacities with one real byte.
// These lifecycle tests prove capacity, verification state and cache ownership, not real model hash/content,
// native large-body copying, or clone/bodyUsed semantics of virtual responses. Ordinary bodies remain native.
function bytesFor(asset: Asset): ArrayBuffer {return virtualModelBuffer(asset.bytes);}
function responseFor(asset: Asset): Response {return {ok: true, arrayBuffer: async () => bytesFor(asset)} as Response;}
function assetFor(url: string): Asset {return allAssets.find(a => url.endsWith('path' in a ? a.path : 'lama-manga-dynamic.onnx'))!;}
const stores = new Map<string, Map<string, Response>>();
let onDelete: (() => Promise<boolean>) | undefined;
let onPut: ((url: string) => Promise<void>) | undefined;
const cachePort = (name: string) => {
    let entries = stores.get(name); if (!entries) {entries = new Map(); stores.set(name, entries);}
    const held = entries;
    return {
        async match(url: string) {return held.get(url);},
        async put(url: string, response: Response) {await onPut?.(url); held.set(url, name === MANGA_OCR_CACHE ? responseFor(assetFor(url)) : response);},
        async delete(url: string) {return held.delete(url);},
    };
};
function seedModels() {stores.set(MANGA_OCR_CACHE, new Map([...MANGA_OCR_ASSETS.map(a => [rootUrl + a.path, responseFor(a)] as const), [MANGA_INPAINT_ASSET.url, responseFor(MANGA_INPAINT_ASSET)]]));}
function controlledGpu() {vi.stubGlobal('GPUDevice', {prototype: {adapterInfo: {}}}); vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => ({info: {vendor: 'controlled hardware port'}})}});}
const pixels = () => new Uint8ClampedArray(32 * 32 * 4).fill(200);
// This lifecycle fixture represents an opaque black decoded image. A zeroed
// RGBA buffer represents transparency, not the intended opaque sample; keep
// the production alpha preparation active while providing a complete Canvas port.
const ocrCanvasWrites = vi.fn();
const ocrCanvases: Array<{width: number; height: number}> = [];
function opaqueOcrPixels(width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    return {data, width, height};
}
const region = {text: 'Hello world', fontSize: 8, bbox: {x0: 8, y0: 8, x1: 24, y1: 24}};
const backgrounds = [{uniform: false, color: 'rgb(200,200,200)'}];
const repair = (signal?: AbortSignal) => mangaInpaintingRuntime.repair(pixels(), 32, 32, [region], signal, undefined, undefined, backgrounds);
const recognize = (signal?: AbortSignal) => mangaOcrRuntime.recognize('controlled-image', 'en', 32, 32, signal, undefined, {naturalWidth: 32, naturalHeight: 32} as HTMLImageElement);
async function tick() {for (let n = 0; n < 40; n++) await Promise.resolve();}
function capture<T>(promise: Promise<T>) {return promise.then(value => ({value, error: undefined}), error => ({value: undefined, error}));}
function evidence(name: string, data: unknown) {if (process.env.AUDIT_E2_EVIDENCE) {mkdirSync(process.env.AUDIT_E2_EVIDENCE, {recursive: true}); writeFileSync(join(process.env.AUDIT_E2_EVIDENCE, name + '.json'), JSON.stringify(data, null, 2));}}

// Only the Worker transport is controlled: the production worker public entry
// performs dispatch, model creation, inference, error responses and release.
const modelFetch = vi.fn<typeof fetch>();
const workers: ControlledInferenceWorker[] = [];
class ControlledInferenceWorker {
    onmessage: ((event: MessageEvent<MangaInferenceResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    private closed = false;
    private scope = {
        onmessage: null as ((event: MessageEvent<MangaInferenceMessage>) => void) | null,
        postMessage: (response: MangaInferenceResponse) => {
            if (!this.closed) this.onmessage?.({data: response} as MessageEvent<MangaInferenceResponse>);
        },
    };
    postMessage = vi.fn((message: MangaInferenceMessage) => {
        if (!this.closed) this.scope.onmessage?.({data: message} as MessageEvent<MangaInferenceMessage>);
    });
    terminate = vi.fn(() => {
        this.closed = true;
        this.scope.onmessage = null;
        this.onmessage = null;
        this.onerror = null;
    });
    constructor(url: string, options: WorkerOptions) {
        expect(url).toBe('chrome-extension://fixture/mangaInferenceWorker.js');
        expect(options).toEqual({type: 'module'});
        const previousScope = globalThis.self;
        // Native workers have separate ORT module instances. Restore this external
        // SDK port before each public start, avoiding nested initialization wrappers.
        ort.InferenceSession.create = sdk.create;
        vi.stubGlobal('self', this.scope);
        try {startMangaInferenceWorker();}
        finally {vi.stubGlobal('self', previousScope);}
        workers.push(this);
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
beforeEach(async () => {
    vi.stubGlobal('Response', createVirtualModelResponsePort(NativeResponse));
    vi.useFakeTimers({toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']}); stores.clear(); onDelete = undefined; onPut = undefined; workers.length = 0;
    ocrCanvasWrites.mockClear(); ocrCanvases.length = 0;
    sdk.sessions.length = 0; sdk.detectors.length = 0; sdk.detectionSession = undefined; sdk.create.mockReset(); sdk.initialize.mockReset().mockResolvedValue(undefined);
    sdk.destroy.mockReset().mockResolvedValue(undefined); sdk.recognize.mockReset().mockResolvedValue({results: [{text: 'Hello world', confidence: 1, box: {x: 8, y: 8, width: 16, height: 16}}]});
    sdk.create.mockImplementation(async () => {const port = {run: vi.fn(async ({image}) => ({inpainted: {data: new Float32Array(image.data), dispose() {}}})), release: vi.fn(async () => {})}; sdk.sessions.push(port); return port;});
    vi.stubGlobal('caches', {open: async (name: string) => cachePort(name), delete: vi.fn(async (name: string) => {const result = await (onDelete?.() ?? Promise.resolve(true)); if (result) stores.delete(name); return result;})});
    vi.stubGlobal('crypto', {subtle: {digest: vi.fn(async (_method: string, b: ArrayBuffer) => Uint8Array.from(allAssets.find(a => a.bytes === b.byteLength)!.sha256.match(/../g)!, part => parseInt(part, 16)).buffer)}});
    vi.stubGlobal('navigator', {language: 'en-US'});
    ort.InferenceSession.create = sdk.create;
    vi.stubGlobal('Worker', ControlledInferenceWorker);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 32, height: 32, close: vi.fn()})));
    vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => 'chrome-extension://fixture/' + path.replace(/^\/+/, '')}});
    vi.stubGlobal('document', {createElement: () => {
        const canvas = {width: 0, height: 0, getContext: () => ({drawImage() {},
            getImageData: (_x: number, _y: number, width: number, height: number) => opaqueOcrPixels(width, height),
            putImageData: ocrCanvasWrites,
        })};
        ocrCanvases.push(canvas); return canvas;
    }});
    modelFetch.mockReset().mockRejectedValue(new Error('unexpected controlled model request'));
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, options?: RequestInit) => String(url) === 'controlled-image'
        ? Promise.resolve(new Response(new Uint8Array([0]), {headers: {'content-type': 'image/png'}}))
        : modelFetch(url, options)));
    await removeMangaOcrAssets();
    vi.mocked(caches.delete).mockClear();
});
afterEach(async () => {
    try {
        // Release the two public ports in order; native worker shutdown owns any
        // model whose SDK release failed. Preserve the strict timer assertion.
        await mangaOcrRuntime.dispose().catch(() => undefined);
        await mangaInpaintingRuntime.dispose().catch(() => undefined);
        expect(ocrCanvasWrites).not.toHaveBeenCalled();
        expect(ocrCanvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();}
});

describe('E2 public manga resource ownership', () => {
    it('preserves the feature error when cache removal clears the last pending download snapshot', async () => {
        const entered = deferred<void>(), finalFetch = deferred<Response>();
        modelFetch.mockRejectedValueOnce(new Error('first controlled fetch failure'))
            .mockImplementationOnce(() => {entered.resolve(); return finalFetch.promise;});
        const result = loadMangaInpaintAsset().then(() => undefined, error => error);
        await entered.promise;
        try {
            // 仅当前注册来源进入网络；旧 .net 只保留已缓存文件的资格。
            expect(modelFetch.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['huggingface.co', 'hf-mirror.com']);
            expect(modelFetch.mock.calls.every(([url]) => new URL(String(url)).pathname === new URL(MANGA_INPAINT_ASSET.url).pathname)).toBe(true);
            expect((await mangaOcrModelStatus()).download?.source).toBe('hf-mirror.com');
            await removeMangaOcrAssets();
            expect(caches.delete).toHaveBeenCalledWith(MANGA_OCR_CACHE);
        } finally {
            // An assertion failure must still settle the owned fetch and its timer.
            finalFetch.reject(new Error('last controlled fetch failure'));
            await result;
        }
        const error = await result;
        evidence('last-fetch-removal', {errorName: error?.name, errorMessage: error?.message, cause: error?.cause?.message, fetchAttempts: modelFetch.mock.calls.length});
        expect(error).not.toBeInstanceOf(TypeError);
        expect(error).toMatchObject({message: '漫画模型下载未完成，请重试或导入已下载文件', cause: {message: 'last controlled fetch failure'}});
        expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });

    it('does not let older failed attempts mark a newer download as failed', async () => {
        const lastA = deferred<Response>(), enteredA = deferred<void>(), pendingB = deferred<Response>(), enteredB = deferred<void>(), abortB = new AbortController();
        modelFetch.mockRejectedValueOnce(new Error('A first')).mockImplementationOnce(() => {enteredA.resolve(); return lastA.promise;})
            .mockImplementationOnce((_url, options) => {enteredB.resolve(); options!.signal!.addEventListener('abort', () => pendingB.reject(new Error('B abort')), {once: true}); return pendingB.promise;});
        const a = capture(loadMangaInpaintAsset()); await enteredA.promise;
        const b = capture(loadMangaInpaintAsset(abortB.signal)); await enteredB.promise;
        lastA.reject(new Error('A final')); const finishedA = await a;
        try {
            expect(finishedA.error).toMatchObject({cause: {message: 'A final'}});
            expect((await mangaOcrModelStatus()).download).toMatchObject({phase: 'downloading', source: 'huggingface.co'});
        } finally {abortB.abort(); await b;}
    });

    it('does not let an older successful download clear the newer current snapshot', async () => {
        const firstA = deferred<Response>(), enteredA = deferred<void>(), pendingB = deferred<Response>(), enteredB = deferred<void>(), abortB = new AbortController();
        modelFetch.mockImplementationOnce(() => {enteredA.resolve(); return firstA.promise;}).mockImplementationOnce((_url, options) => {enteredB.resolve(); options!.signal!.addEventListener('abort', () => pendingB.reject(new Error('B abort')), {once: true}); return pendingB.promise;});
        const a = capture(loadMangaInpaintAsset()); await enteredA.promise;
        const b = capture(loadMangaInpaintAsset(abortB.signal)); await enteredB.promise;
        firstA.resolve(responseFor(MANGA_INPAINT_ASSET)); const finishedA = await a;
        try {expect(finishedA.error).toBeUndefined(); expect((await mangaOcrModelStatus()).download).toMatchObject({phase: 'downloading', source: 'huggingface.co'});}
        finally {abortB.abort(); await b;}
    });

    it('keeps newer ownership when an older request switches to its fallback source', async () => {
        const firstA = deferred<Response>(), enteredA = deferred<void>(), pendingB = deferred<Response>(), enteredB = deferred<void>(), fallbackA = deferred<Response>(), enteredFallback = deferred<void>(), abortB = new AbortController();
        modelFetch.mockImplementationOnce(() => {enteredA.resolve(); return firstA.promise;}).mockImplementationOnce((_url, options) => {enteredB.resolve(); options!.signal!.addEventListener('abort', () => pendingB.reject(new Error('B abort')), {once: true}); return pendingB.promise;})
            .mockImplementationOnce(() => {enteredFallback.resolve(); return fallbackA.promise;});
        const a = capture(loadMangaInpaintAsset()); await enteredA.promise;
        const b = capture(loadMangaInpaintAsset(abortB.signal)); await enteredB.promise;
        firstA.reject(new Error('A first')); await enteredFallback.promise;
        try {expect((await mangaOcrModelStatus()).download?.source).toBe('huggingface.co');}
        finally {fallbackA.reject(new Error('A final')); await a; abortB.abort(); await b;}
    });

    it('does not let older cancellation pause the newer current download', async () => {
        const aEntered = deferred<void>(), bEntered = deferred<void>(), abortA = new AbortController(), abortB = new AbortController();
        modelFetch.mockImplementationOnce((_url, options) => {aEntered.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('A aborted')), {once: true}));})
            .mockImplementationOnce((_url, options) => {bEntered.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('B aborted')), {once: true}));});
        const a = capture(loadMangaInpaintAsset(abortA.signal)); await aEntered.promise;
        const b = capture(loadMangaInpaintAsset(abortB.signal)); await bEntered.promise;
        abortA.abort(); const stopped = await a;
        try {expect(stopped.error.name).toBe('AbortError'); expect((await mangaOcrModelStatus()).download?.phase).toBe('downloading');}
        finally {abortB.abort(); await b;}
    });

    it('does not let an older multi-file OCR load reclaim ownership on its next asset', async () => {
        const detection = deferred<Response>(), detectionEntered = deferred<void>(), inpaintEntered = deferred<void>(), recognitionEntered = deferred<void>(), recognition = deferred<Response>(), abort = new AbortController();
        modelFetch.mockImplementationOnce(() => {detectionEntered.resolve(); return detection.promise;})
            .mockImplementationOnce((_url, options) => {inpaintEntered.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('inpaint abort')), {once: true}));})
            .mockImplementationOnce(() => {recognitionEntered.resolve(); return recognition.promise;}).mockRejectedValueOnce(new Error('recognition fallback failure'));
        const ocr = capture(loadMangaOcrAssets()); await detectionEntered.promise;
        const inpaint = capture(loadMangaInpaintAsset(abort.signal)); await inpaintEntered.promise;
        detection.resolve(responseFor(MANGA_OCR_ASSETS[0])); await recognitionEntered.promise;
        try {expect((await mangaOcrModelStatus()).download?.file).toBe('lama-manga-dynamic.onnx');}
        finally {recognition.reject(new Error('recognition failure')); await ocr; abort.abort(); await inpaint;}
    });

    it('publishes legitimate sequential-file progress for the same public OCR load', async () => {
        const stages = MANGA_OCR_ASSETS.map(() => ({entered: deferred<void>(), response: deferred<Response>()}));
        for (const stage of stages) modelFetch.mockImplementationOnce(() => {stage.entered.resolve(); return stage.response.promise;});
        const loading = capture(loadMangaOcrAssets());
        const snapshots: unknown[] = [];
        try {
            for (let index = 0; index < stages.length; index++) {
                await stages[index].entered.promise;
                const snapshot = (await mangaOcrModelStatus()).download; snapshots.push(snapshot);
                expect(snapshot).toMatchObject({phase: 'downloading', file: MANGA_OCR_ASSETS[index].path.split('/').pop()});
                stages[index].response.resolve(responseFor(MANGA_OCR_ASSETS[index]));
            }
        } finally {for (let index = 0; index < stages.length; index++) stages[index].response.resolve(responseFor(MANGA_OCR_ASSETS[index])); await loading; evidence('sequential-snapshots', snapshots);}
        expect((await mangaOcrModelStatus()).download).toBeUndefined(); expect((await mangaOcrModelStatus()).ready).toBe(true);
    });

    it('does not clear a newer download when an older offline import finishes', async () => {
        const imported = deferred<ArrayBuffer>(), entered = deferred<void>(), abort = new AbortController();
        const offline = importMangaModel({name: 'ppocrv6_dict.txt', size: MANGA_OCR_ASSETS[2].bytes, arrayBuffer: () => imported.promise} as File);
        modelFetch.mockImplementationOnce((_url, options) => {entered.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('cancel')), {once: true}));});
        const downloading = capture(loadMangaInpaintAsset(abort.signal)); await entered.promise;
        imported.resolve(bytesFor(MANGA_OCR_ASSETS[2])); await offline;
        try {expect((await mangaOcrModelStatus()).download?.phase).toBe('downloading'); expect(stores.get(MANGA_OCR_CACHE)?.has(rootUrl + MANGA_OCR_ASSETS[2].path)).toBe(true);}
        finally {abort.abort(); await downloading;}
    });

    it('does not clear a newer snapshot when pending cache deletion finishes', async () => {
        const deletion = deferred<boolean>(), enteredDelete = deferred<void>(), enteredFetch = deferred<void>(), abort = new AbortController();
        onDelete = () => {enteredDelete.resolve(); return deletion.promise;};
        const removing = removeMangaOcrAssets(); await enteredDelete.promise;
        modelFetch.mockImplementationOnce((_url, options) => {enteredFetch.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('cancel')), {once: true}));});
        const downloading = capture(loadMangaInpaintAsset(abort.signal)); await enteredFetch.promise;
        deletion.resolve(true); await removing;
        try {expect((await mangaOcrModelStatus()).download?.phase).toBe('downloading');}
        finally {abort.abort(); await downloading;}
    });

    it('preserves the snapshot and admits retry after cache deletion fails', async () => {
        modelFetch.mockRejectedValue(new Error('controlled failure')); await capture(loadMangaInpaintAsset());
        onDelete = async () => {throw new Error('cache delete failure');};
        await expect(removeMangaOcrAssets()).rejects.toThrow('cache delete failure');
        expect((await mangaOcrModelStatus()).download?.phase).toBe('error');
        onDelete = undefined; await removeMangaOcrAssets(); expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });

    it('clears only the matching paused download after verified offline import', async () => {
        const entered = deferred<void>(), abort = new AbortController();
        modelFetch.mockImplementationOnce((_url, options) => {entered.resolve(); return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('pause')), {once: true}));});
        const downloading = capture(loadMangaInpaintAsset(abort.signal)); await entered.promise; abort.abort(); await downloading;
        expect((await mangaOcrModelStatus()).download?.phase).toBe('paused');
        await importMangaModel({name: 'lama-manga-dynamic.onnx', size: MANGA_INPAINT_ASSET.bytes, arrayBuffer: async () => bytesFor(MANGA_INPAINT_ASSET)} as File);
        expect(await mangaOcrModelStatus()).toMatchObject({inpaintingReady: true}); expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });

    it('keeps cache writes owned by the deleted cache handle without resurrecting the named cache', async () => {
        const put = deferred<void>(), entered = deferred<void>(); onPut = () => {entered.resolve(); return put.promise;};
        modelFetch.mockResolvedValue(responseFor(MANGA_INPAINT_ASSET));
        const downloading = capture(loadMangaInpaintAsset()); await entered.promise;
        await removeMangaOcrAssets(); put.resolve(); expect((await downloading).error).toBeUndefined();
        expect((await mangaOcrModelStatus()).inpaintingReady).toBe(false);
        onPut = undefined; await loadMangaInpaintAsset(); expect((await mangaOcrModelStatus()).inpaintingReady).toBe(true);
    });

    it('rejects failed verified cache persistence and permits a subsequent download', async () => {
        modelFetch.mockResolvedValue(responseFor(MANGA_INPAINT_ASSET)); onPut = async () => {throw new Error('cache put failure');};
        await expect(loadMangaInpaintAsset()).rejects.toThrow('cache put failure');
        expect((await mangaOcrModelStatus()).inpaintingReady).toBe(false);
        onPut = undefined; await loadMangaInpaintAsset(); expect((await mangaOcrModelStatus()).inpaintingReady).toBe(true);
    });
});

describe('E2 real runtime removal admission', () => {
    it('preserves OCR initialization errors and cancellation when SDK destruction rejects', async () => {
        seedModels(); sdk.initialize.mockRejectedValueOnce(new Error('original initialize failure')); sdk.destroy.mockRejectedValueOnce(new Error('secondary destroy failure'));
        await expect(createBrowserMangaOcr()).rejects.toThrow('original initialize failure'); expect(sdk.destroy).toHaveBeenCalledOnce();
        const abort = new AbortController(); sdk.initialize.mockImplementationOnce(async () => {abort.abort();}); sdk.destroy.mockRejectedValueOnce(new Error('secondary cancel cleanup failure'));
        await expect(createBrowserMangaOcr(abort.signal)).rejects.toMatchObject({name: 'AbortError'}); expect(sdk.destroy).toHaveBeenCalledTimes(2);
    });

    it('preserves inpainting initialization cancellation when its owned session release rejects', async () => {
        seedModels(); const abort = new AbortController(), release = vi.fn(async () => {throw new Error('secondary release failure');});
        sdk.create.mockImplementationOnce(async () => {abort.abort(); return {release};});
        await expect(createBrowserMangaInpainter(abort.signal)).rejects.toMatchObject({name: 'AbortError'}); expect(release).toHaveBeenCalledOnce();
    });

    it('preserves OCR CPU fallback cancellation when releasing the replacement session rejects', async () => {
        seedModels(); controlledGpu(); const abort = new AbortController(), release = vi.fn(async () => {throw new Error('CPU secondary release failure');});
        const gpuRelease = vi.fn(async () => {}), gpu = {run: vi.fn(async () => {throw new Error('controlled GPU run failure');}), release: gpuRelease}; sdk.detectionSession = gpu;
        sdk.create.mockImplementationOnce(async () => {abort.abort(); return {release};});
        sdk.recognize.mockImplementationOnce(async () => {await gpu.run(); return {results: []};});
        const port = await createBrowserMangaOcr();
        expect(sdk.detectors).toHaveLength(1); expect(sdk.detectors[0].session).toBe(gpu);
        expect(sdk.detectors[0].options).toEqual({maxSideLength: 1536, paddingVertical: .1, paddingHorizontal: .2});
        const decodedImage = {naturalWidth: 32, naturalHeight: 32, src: 'borrowed-source'} as HTMLImageElement;
        try {await expect(port.recognize('fixture', {flatten: true, noCache: true, strategy: 'per-box', signal: abort.signal, decodedImage})).rejects.toMatchObject({name: 'AbortError'});}
        finally {await port.destroy();}
        expect(decodedImage).toMatchObject({naturalWidth: 32, naturalHeight: 32, src: 'borrowed-source'});
        expect(release).toHaveBeenCalledOnce(); expect(gpuRelease).toHaveBeenCalledOnce();
    });

    it('preserves inpainting CPU fallback cancellation when replacement release rejects', async () => {
        seedModels(); controlledGpu(); const abort = new AbortController(), release = vi.fn(async () => {throw new Error('CPU secondary release failure');});
        const gpuRelease = vi.fn(async () => {}), gpu = {run: vi.fn(async () => {throw new Error('controlled GPU run failure');}), release: gpuRelease};
        sdk.create.mockResolvedValueOnce(gpu).mockImplementationOnce(async () => {abort.abort(); return {release};});
        const port = await createBrowserMangaInpainter();
        try {await expect(port.run({image: new Float32Array(3), mask: new Float32Array(1), width: 1, height: 1}, abort.signal)).rejects.toMatchObject({name: 'AbortError'});}
        finally {await port.release();}
        expect(release).toHaveBeenCalledOnce(); expect(gpuRelease).toHaveBeenCalledOnce();
    });

    it('holds later singleton repair admission until both session queues and cache removal finish', async () => {
        seedModels(); await repair(); const entered = deferred<void>(), deletion = deferred<boolean>();
        onDelete = () => {entered.resolve(); return deletion.promise;};
        modelFetch.mockImplementation(async url => responseFor(assetFor(String(url))));
        const removing = capture(removeMangaModels()); await entered.promise;
        const later = capture(repair()); await tick();
        const creationsWhileRemoving = sdk.create.mock.calls.length;
        try {expect(creationsWhileRemoving).toBe(1); expect(sdk.sessions[0].release).toHaveBeenCalledOnce();}
        finally {deletion.resolve(true); await removing; await later;}
        expect(sdk.create).toHaveBeenCalledTimes(2); await mangaInpaintingRuntime.dispose();
        expect(sdk.sessions.every(s => s.release.mock.calls.length === 1)).toBe(true);
        evidence('removal-repair-admission', {creationsWhileRemoving, totalCreations: sdk.create.mock.calls.length, releases: sdk.sessions.map(s => s.release.mock.calls.length)});
    });

    it('admits later recognition after failed cleanup while still cleaning the other model and cache', async () => {
        seedModels(); await repair(); await recognize(); sdk.sessions[0].release.mockRejectedValueOnce(new Error('inpaint release failure'));
        await expect(removeMangaModels()).rejects.toThrow('inpaint release failure');
        // The failed inpaint release terminates the shared native worker, releasing OCR too.
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers[0].postMessage.mock.calls.map(([message]) => message.type)).toContain('dispose-inpaint');
        expect(caches.delete).toHaveBeenCalledOnce();
        modelFetch.mockImplementation(async url => responseFor(assetFor(String(url))));
        expect(await recognize()).toHaveLength(1); expect(await repair()).toEqual(pixels());
    });

    it('clears cache even when OCR destruction fails and recovers on repeated removal', async () => {
        seedModels(); await recognize(); sdk.destroy.mockRejectedValueOnce(new Error('OCR destroy failure'));
        await expect(removeMangaModels()).rejects.toThrow('OCR destroy failure'); expect(caches.delete).toHaveBeenCalledOnce();
        await removeMangaModels(); expect(caches.delete).toHaveBeenCalledTimes(2);
        modelFetch.mockImplementation(async url => responseFor(assetFor(String(url)))); expect(await recognize()).toHaveLength(1);
    });

    it('coalesces concurrent removal and does not strand a cancelled recognition behind it', async () => {
        seedModels(); const entered = deferred<void>(), deletion = deferred<boolean>(); onDelete = () => {entered.resolve(); return deletion.promise;};
        const first = capture(removeMangaModels()), second = capture(removeMangaModels()); await entered.promise;
        const abort = new AbortController(), waiting = capture(recognize(abort.signal)); abort.abort();
        expect((await waiting).error.name).toBe('AbortError'); expect(sdk.initialize).not.toHaveBeenCalled();
        deletion.resolve(true); await first; await second; await tick();
        expect(caches.delete).toHaveBeenCalledOnce(); expect(sdk.initialize).not.toHaveBeenCalled();
    });

    it('does not create or run a queued repair cancelled while model removal is pending', async () => {
        seedModels(); const entered = deferred<void>(), deletion = deferred<boolean>(); onDelete = () => {entered.resolve(); return deletion.promise;};
        const removing = capture(removeMangaModels()); await entered.promise;
        const abort = new AbortController(), waiting = capture(repair(abort.signal)); await tick(); abort.abort();
        try {expect(sdk.create).not.toHaveBeenCalled();}
        finally {deletion.resolve(true); await removing;}
        expect((await waiting).error?.name).toBe('AbortError'); expect(sdk.create).not.toHaveBeenCalled();
    });

    it('rechecks admission when a second removal starts before the first wait resumes', async () => {
        seedModels(); const enteredA = deferred<void>(), enteredB = deferred<void>(), deletionA = deferred<boolean>(), deletionB = deferred<boolean>(); let deletes = 0;
        onDelete = () => {if (++deletes === 1) {enteredA.resolve(); return deletionA.promise;} enteredB.resolve(); return deletionB.promise;};
        modelFetch.mockImplementation(async url => responseFor(assetFor(String(url))));
        const removalA = removeMangaModels(); await enteredA.promise;
        const waiting = capture(repair()), removalB = capture(removalA.then(() => removeMangaModels()));
        deletionA.resolve(true); await enteredB.promise; await tick();
        const creationsWhileB = sdk.create.mock.calls.length;
        try {expect(creationsWhileB).toBe(0);}
        finally {deletionB.resolve(true); await removalB; expect((await waiting).error).toBeUndefined();}
        expect(sdk.create).toHaveBeenCalledOnce(); evidence('successive-removal-admission', {creationsWhileB, totalCreations: sdk.create.mock.calls.length, deletes});
    });

    it('waits for admitted inference without cancelling it and holds new recognition until removal ends', async () => {
        seedModels(); await repair(); const active = deferred<any>(), entered = deferred<void>();
        sdk.sessions[0].run.mockImplementationOnce(() => {entered.resolve(); return active.promise;});
        const beforeRemoval = capture(repair()); await entered.promise;
        const removing = capture(removeMangaModels()), later = capture(recognize()); await tick();
        try {expect(sdk.initialize).not.toHaveBeenCalled(); expect(sdk.sessions[0].release).not.toHaveBeenCalled(); expect(caches.delete).not.toHaveBeenCalled();}
        finally {
            const input = sdk.sessions[0].run.mock.calls.at(-1)[0].image.data;
            active.resolve({inpainted: {data: new Float32Array(input), dispose() {}}});
            modelFetch.mockImplementation(async url => responseFor(assetFor(String(url))));
            expect((await beforeRemoval).error).toBeUndefined(); await removing; expect((await later).error).toBeUndefined();
        }
        expect(sdk.initialize).toHaveBeenCalledOnce();
    });

    it('keeps independent factory OCR and repair inference concurrent outside removal', async () => {
        const ocrEntered = deferred<void>(), repairEntered = deferred<void>(), ocrDone = deferred<any>(), repairDone = deferred<Float32Array>();
        const ocr = createMangaOcrRuntime(async () => ({recognize: async () => {ocrEntered.resolve(); return ocrDone.promise;}, destroy: async () => {}}));
        let patchSize = 0;
        const inpainter = createMangaInpaintingRuntime(async () => ({run: async patch => {patchSize = patch.image.length; repairEntered.resolve(); return repairDone.promise;}, release: async () => {}}));
        const o = capture(ocr.recognize('fixture', 'en', 32, 32)), i = capture(inpainter.repair(pixels(), 32, 32, [region], undefined, undefined, undefined, backgrounds));
        await Promise.all([ocrEntered.promise, repairEntered.promise]);
        ocrDone.resolve({results: []}); repairDone.resolve(new Float32Array(patchSize));
        expect((await o).value).toEqual([]); expect((await i).value).toBeInstanceOf(Uint8ClampedArray);
        await Promise.all([ocr.dispose(), inpainter.dispose()]);
    });

    it('proves the real Offscreen router already blocks new image admission and duplicate removal', async () => {
        const deletion = deferred<boolean>(), entered = deferred<void>(); onDelete = () => {entered.resolve(); return deletion.promise;};
        const translateImage = vi.fn();
        const listener = createOffscreenMessageListener({translate: vi.fn(), ttsPlayer: {play: vi.fn(), stop: vi.fn(), seek: () => {throw Error('Unexpected speech seek in image removal fixture');}}, fetchImage: vi.fn(), translateImage, translateArea: vi.fn(), downloadOcrLanguages: vi.fn(), removeMangaModels});
        const send = (type: string, rest = {}) => new Promise<any>(resolve => {expect(listener({target: 'offscreen', type, ...rest}, {}, resolve)).toBe(true);});
        const removing = send('FLUENT_READ_MANGA_MODEL_REMOVE_OFFSCREEN'); await entered.promise;
        try {
            expect(await send('FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', {image: 'data:image/png;base64,AA==', sourceLanguage: 'en', requestId: 'later', manga: true})).toMatchObject({success: false, error: '正在清除语言包，请稍后重试'});
            expect(await send('FLUENT_READ_MANGA_MODEL_REMOVE_OFFSCREEN')).toMatchObject({success: false}); expect(translateImage).not.toHaveBeenCalled();
        } finally {deletion.resolve(true); expect(await removing).toEqual({success: true});}
    });
});
