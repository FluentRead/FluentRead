/**
 * @file tests/mangaInferenceClient.test.ts
 * 文件职责：验证漫画推理客户端的真实请求队列、Worker 重建与资源生命周期。
 * 主要内容：用可控消息端口和假时钟覆盖阶段超时、立即取消与有界收尾、暖机复用和无人端口释放、失败回退、旧消息和释放；真实 Worker 处理器联测取消超时后的修补阶段时限，共享推理预算使用真实实现。
 * 模块边界：不下载模型、不模拟 GPU 算子；断言可观察结果与资源释放，不改生产代码或共享配置。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MangaInferenceMessage, MangaInferenceResponse} from '@/src/features/image-translation/services/mangaInferenceClient';

type ClientModule = typeof import('@/src/features/image-translation/services/mangaInferenceClient');
type Client = ReturnType<ClientModule['createMangaInferenceClient']>;

class ControlledWorker {
    onmessage: ((event: MessageEvent<MangaInferenceResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage = vi.fn<(message: MangaInferenceMessage,transfer?:Transferable[]) => void>();
    terminate = vi.fn();
    get latest(): MangaInferenceMessage { return this.postMessage.mock.calls.at(-1)![0]; }
    emit(response: Partial<MangaInferenceResponse> = {success: true}) {
        this.onmessage?.({data: {requestId: this.latest.requestId, ...response}} as MessageEvent<MangaInferenceResponse>);
    }
    fail(message: string) { this.onerror?.({message} as ErrorEvent); }
}

function observe<T>(promise: Promise<T>) {
    return promise.then(value => ({status: 'fulfilled' as const, value}), reason => ({status: 'rejected' as const, reason}));
}
const flush = () => vi.advanceTimersByTimeAsync(0);
let module: ClientModule;
const clients: Client[] = [];

function harness() {
    const workers: ControlledWorker[] = [];
    const createWorker = vi.fn(() => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker as unknown as Worker;
    });
    const client = module.createMangaInferenceClient(createWorker);
    clients.push(client);
    return {client, workers, createWorker};
}

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 4});
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('self', {location: {href: 'https://extension.test/offscreen/index.html'}});
    module = await import('@/src/features/image-translation/services/mangaInferenceClient');
});

afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('onnxruntime-web/webgpu');
    vi.doUnmock('@/src/features/image-translation/services/mangaOcr');
    vi.doUnmock('@/src/features/image-translation/services/mangaInpainting');
});

describe('图片 CPU/WASM 偏好和诊断', () => {
    it('已到期但迟到的暖机清理回调不能关闭新任务持有的 Worker', async () => {
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const {client, workers} = harness(), abort = new AbortController();
        const canceled = observe(client.prepare('ocr', abort.signal)); await flush(); abort.abort();
        await canceled; workers[0].emit(); await flush();
        const idle = timer.mock.calls.find(([, delay]) => delay === 180_000)![0] as () => void;
        const active = client.request({type: 'recognize'}); await flush(); idle();
        expect(workers[0].terminate).not.toHaveBeenCalled(); workers[0].emit(); await active;
    });
    it('切换后可选分割保持逻辑就绪并重新获得空闲释放期限', async () => {
        const h = harness(); await prepareText(h);
        h.client.setBackend('cpu');
        const recognize = h.client.request({type: 'recognize'}); await flush();
        expect(h.workers[1].latest.cpu).toBe(true); h.workers[1].emit(); await recognize;
        const segment = h.client.segmentText(inputText); await flush();
        h.workers[1].emit({success: true, result: outputText()}); await segment;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(h.workers[1].latest.type).toBe('dispose-seg'); h.workers[1].emit(); await flush();
        expect(h.workers[1].terminate).toHaveBeenCalledOnce();
    });
    it('取消 CPU 准备立即发布取消状态，迟到初始化不恢复页面状态', async () => {
        const {client, workers} = harness(), abort = new AbortController(); client.setBackend('cpu');
        const pending = observe(client.prepare('ocr', abort.signal)); await flush(); abort.abort();
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        workers[0].emit({stage: 'initializing'}); expect(client.getDiagnostics().stage).toBe('canceled');
        workers[0].emit(); await flush(); expect(client.getDiagnostics().stage).toBe('canceled');
    });
    it.each(['prepare-ocr', 'prepare-inpaint', 'prepare-seg', 'recognize', 'inpaint'] as const)('%s 首条消息即 CPU，初始化和推理从首次采用 120 秒预算，失败不再重试', async type => {
        const {client, workers} = harness();
        client.setBackend('cpu');
        const pending = observe(client.request({type}));
        await flush();
        expect(workers[0].latest.cpu).toBe(true);
        expect(client.getDiagnostics()).toMatchObject({preference: 'cpu', cpuFallback: false});
        await vi.advanceTimersByTimeAsync(60_001);
        expect(workers).toHaveLength(1);
        for (const stage of ['initializing', 'recognizing'] as const) {
            workers[0].emit({stage});
            expect(client.getDiagnostics().stage).toBe(stage);
            await vi.advanceTimersByTimeAsync(119_999);
            expect(workers[0].terminate).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers).toHaveLength(1);
        expect(client.getDiagnostics()).toMatchObject({stage: 'error', executionProviders: []});
    });

    it('切换只在串行请求边界重建，CPU 与自动可往返且旧响应不能覆盖新诊断', async () => {
        const {client, workers} = harness();
        expect(client.getDiagnostics()).toEqual({preference: 'auto', cpuFallback: false, stage: 'idle', executionProviders: []});
        const first = client.prepare('ocr'); await flush();
        const stale = workers[0].onmessage!;
        workers[0].emit({executionProviders: ['webgpu', 'wasm']});
        expect(client.getDiagnostics().executionProviders).toEqual(['webgpu', 'wasm']);
        const snapshot = client.getDiagnostics(); snapshot.executionProviders.length = 0;
        expect(client.getDiagnostics().executionProviders).toHaveLength(2);
        client.setBackend('cpu');
        const next = client.request({type: 'recognize', image: 'next'});
        await flush(); expect(workers[0].terminate).not.toHaveBeenCalled();
        workers[0].emit(); await first; await flush();
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers[1].latest.cpu).toBe(true);
        stale({data: {requestId: 1, executionProviders: ['webgpu'], stage: 'initializing'}} as MessageEvent<MangaInferenceResponse>);
        workers[1].emit({stage: 'recognizing', executionProviders: ['wasm']});
        expect(client.getDiagnostics()).toMatchObject({stage: 'recognizing', executionProviders: ['wasm']});
        workers[1].emit({success: true, result: {results: []}}); await next;
        expect(client.getDiagnostics().stage).toBe('completed');
        client.setBackend('auto');
        const back = client.prepare('inpaint'); await flush();
        expect(workers[2].latest.cpu).toBe(false); workers[2].emit(); await back;
        client.dispose(); expect(client.getDiagnostics().stage).toBe('idle');
    });

    it('CPU 偏好跨释放和重新创建保留，自动回退可诊断，旧请求阶段不泄漏', async () => {
        const {client, workers} = harness();
        const first = client.request({type: 'recognize'}); await flush();
        workers[0].fail('GPU failure'); await flush();
        expect(client.getDiagnostics().cpuFallback).toBe(true);
        workers[1].emit({executionProviders: ['wasm']}); workers[1].emit(); await first;
        client.setBackend('cpu'); client.dispose();
        const prepare = client.prepare('ocr'); await flush(); workers[2].emit(); await prepare;
        const release = client.release('ocr'); await flush(); workers[2].emit(); await release;
        const again = client.prepare('ocr'); await flush();
        expect(workers[3].latest.cpu).toBe(true); workers[3].emit(); await again;
        expect(client.getDiagnostics().cpuFallback).toBe(false);
    });

    it('切换偏好前已取消的排队请求不终止当前端口，也不创建新 Worker', async () => {
        const {client, workers} = harness();
        const first = client.prepare('ocr'); await flush();
        client.setBackend('cpu');
        const abort = new AbortController(), queued = observe(client.request({type: 'recognize'}, abort.signal));
        abort.abort(); workers[0].emit(); await first;
        await expect(queued).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await flush(); expect(workers).toHaveLength(1); expect(workers[0].terminate).not.toHaveBeenCalled();
    });
});

describe('漫画独立 Worker 客户端', () => {
    it('解析同源资源 URL，并延迟创建模块 Worker', async () => {
        expect(module.mangaExtensionUrl('../worker.js')).toBe('https://extension.test/worker.js');
        const getURL = vi.fn(path => `chrome-extension://fixture/${path}`);
        vi.stubGlobal('chrome', {runtime: {getURL}});
        expect(module.mangaExtensionUrl('model.bin')).toBe('chrome-extension://fixture/model.bin');
        const worker = new ControlledWorker();
        const WorkerConstructor = vi.fn(function () { return worker; });
        vi.stubGlobal('Worker', WorkerConstructor);
        expect(WorkerConstructor).not.toHaveBeenCalled();
        const result = module.mangaInferenceClient.request({type: 'recognize', image: 'data:image/png;base64,AA=='});
        clients.push(module.mangaInferenceClient);
        await flush();
        expect(WorkerConstructor).toHaveBeenCalledWith('chrome-extension://fixture/mangaInferenceWorker.js', {type: 'module'});
        worker.emit({success: true, result: {results: []}});
        await expect(result).resolves.toEqual({results: []});
    });

    it('串行准备两种模型，复用端口并完整转发真实进度与推理结果', async () => {
        const {client, workers, createWorker} = harness();
        const progress = vi.fn();
        const ocr = client.prepare('ocr', undefined, progress);
        const painter = client.prepare('inpaint');
        await flush();
        const worker = workers[0];
        expect(worker.latest).toEqual({type: 'prepare-ocr', requestId: 1, cpu: false});
        expect(worker.postMessage).toHaveBeenCalledOnce();
        worker.emit({stage: 'preparing', percent: 0});
        worker.emit({stage: 'initializing'});
        expect(progress.mock.calls).toEqual([['preparing', 0], ['initializing', undefined]]);
        worker.emit();
        await ocr;
        await flush();
        expect(worker.latest).toEqual({type: 'prepare-inpaint', requestId: 2, cpu: false});
        worker.emit({stage: 'preparing', percent: 75});
        worker.emit();
        await painter;
        const page = {results: []};
        const recognized = client.request({type: 'recognize', image: 'page'}, undefined, progress);
        await flush();
        worker.emit({stage: 'recognizing'});
        worker.emit({success: true, result: page});
        await expect(recognized).resolves.toBe(page);
        const patch = {image: new Float32Array([1, 2, 3]), mask: new Float32Array([1]), width: 1, height: 1};
        const painted = client.request({type: 'inpaint', patch});
        await flush();
        expect(worker.latest).toMatchObject({type: 'inpaint', patch, requestId: 4});
        const output = new Float32Array([0.5]);
        worker.emit({success: true, result: output});
        await expect(painted).resolves.toBe(output);
        expect(createWorker).toHaveBeenCalledOnce();
        expect(worker.onmessage).toBeNull();
        expect(worker.onerror).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('GPU 失败只重建一次 CPU Worker，后续请求保持 CPU 后端', async () => {
        const {client, workers} = harness();
        const result = client.request({type: 'recognize', image: 'same-page'});
        await flush();
        workers[0].emit({success: false, error: 'GPU device lost'});
        await flush();
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers[1].latest).toEqual({type: 'recognize', image: 'same-page', requestId: 2, cpu: true});
        workers[1].emit({success: true, result: {results: []}});
        await expect(result).resolves.toEqual({results: []});
        const next = client.prepare('ocr');
        await flush();
        expect(workers[1].latest).toMatchObject({type: 'prepare-ocr', cpu: true, requestId: 3});
        workers[1].emit();
        await next;
        expect(workers).toHaveLength(2);
    });

    it.each([undefined, '', 'CPU init failed'])('CPU 失败不进行第三次尝试，并保留错误 %s', async error => {
        const {client, workers} = harness();
        const result = observe(client.prepare('ocr'));
        await flush();
        workers[0].emit({success: false, error: 'GPU init failed'});
        await flush();
        workers[1].emit({success: false, error});
        await expect(result).resolves.toMatchObject({status: 'rejected', reason: {message: error || '漫画推理失败'}});
        expect(workers).toHaveLength(2);
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        const next = client.request({type: 'recognize', image: 'next'});
        await flush();
        expect(workers[2].latest.cpu).toBe(true);
        workers[2].emit();
        await next;
    });

    it.each(['script failed', ''])('处理 Worker error 事件并释放失败实例：%s', async message => {
        const {client, workers} = harness();
        const result = observe(client.request({type: 'inpaint'}));
        await flush();
        workers[0].fail('GPU crashed');
        await flush();
        workers[1].fail(message);
        await expect(result).resolves.toMatchObject({status: 'rejected', reason: {message: message || '漫画推理 Worker 已停止'}});
        expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    });

    it.each([new Error('cannot clone'), 'cannot clone'])('postMessage 同步抛错也清理监听器、计时器并限次重试：%s', async error => {
        const {client, workers, createWorker} = harness();
        createWorker.mockImplementation(() => {
            const worker = new ControlledWorker();
            worker.postMessage.mockImplementation(() => { throw error; });
            workers.push(worker);
            return worker as unknown as Worker;
        });
        await expect(client.request({type: 'recognize', image: 'page'})).rejects.toThrow('cannot clone');
        expect(workers).toHaveLength(2);
        for (const worker of workers) {
            expect(worker.terminate).toHaveBeenCalledOnce();
            expect(worker.onmessage).toBeNull();
            expect(worker.onerror).toBeNull();
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Worker 构造失败允许一次 CPU 重建，失败后队列仍能继续', async () => {
        const {client, workers, createWorker} = harness();
        createWorker.mockImplementationOnce(() => { throw new Error('GPU worker unavailable'); });
        const result = client.prepare('ocr');
        await flush();
        expect(createWorker).toHaveBeenCalledTimes(2);
        expect(workers[0].latest.cpu).toBe(true);
        workers[0].emit();
        await result;
    });

    it('忽略缺失消息、错误请求 ID，以及已终止 Worker 的延迟消息和错误', async () => {
        const {client, workers} = harness();
        const progress = vi.fn();
        const result = client.prepare('ocr', undefined, progress);
        await flush();
        const oldMessage = workers[0].onmessage!;
        const oldError = workers[0].onerror!;
        oldMessage({data: undefined} as unknown as MessageEvent<MangaInferenceResponse>);
        workers[0].emit({requestId: 99, stage: 'recognizing'});
        workers[0].emit({requestId: 99, success: true});
        expect(progress).not.toHaveBeenCalled();
        workers[0].emit({success: false, error: 'retry'});
        await flush();
        progress.mockClear();
        oldMessage({data: {requestId: 1, success: true}} as MessageEvent<MangaInferenceResponse>);
        oldError({message: 'late crash'} as ErrorEvent);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        expect(workers[1].onmessage).not.toBeNull();
        workers[1].emit({stage: 'initializing', percent: 100});
        workers[1].emit();
        await result;
        expect(progress.mock.calls).toEqual([['initializing', 100]]);
        const next = client.prepare('inpaint');
        await flush();
        workers[1].emit({requestId: 2, success: false, error: 'old response'});
        expect(workers[1].onmessage).not.toBeNull();
        workers[1].emit();
        await next;
    });

    it('已取消的请求不创建 Worker，排队取消立即结束且不终止当前任务', async () => {
        const {client, workers, createWorker} = harness();
        const aborted = new AbortController();
        aborted.abort();
        await expect(client.prepare('ocr', aborted.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(createWorker).not.toHaveBeenCalled();
        const active = client.prepare('ocr');
        const queuedSignal = new AbortController();
        const queued = observe(client.prepare('inpaint', queuedSignal.signal));
        await flush();
        queuedSignal.abort();
        await expect(queued).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        expect(workers[0].terminate).not.toHaveBeenCalled();
        workers[0].emit();
        await active;
        await flush();
        expect(workers[0].postMessage).toHaveBeenCalledOnce();
        const next = client.prepare('inpaint');
        await flush();
        workers[0].emit();
        await next;
    });

    it('运行中取消立即结束调用方等待，超过 1.5 秒仍未收尾才硬终止，不回退 CPU', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, 'addEventListener');
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const result = observe(client.request({type: 'recognize', image: 'page'}, controller.signal));
        await flush();
        controller.abort();
        await expect(result).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await flush();
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_499);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(remove.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining(add.mock.calls.map(call => call[1])));
        expect(vi.getTimerCount()).toBe(0);
        const next = client.prepare('ocr');
        await flush();
        expect(workers[1].latest.cpu).toBe(false);
        workers[1].emit();
        await next;
    });

    it('已取消推理在收尾窗口内完成时丢弃结果和进度，保留 OCR 与修补模型并复用同一 Worker', async () => {
        const {client, workers, createWorker} = harness();
        for (const kind of ['ocr', 'inpaint'] as const) {
            const prepared = client.prepare(kind);
            await flush(); workers[0].emit(); await prepared;
        }
        const controller = new AbortController(), progress = vi.fn();
        const canceled = observe(client.request({type: 'recognize', image: 'old-page'}, controller.signal, progress));
        await flush();
        const oldMessage = workers[0].onmessage!;
        const oldError = workers[0].onerror!;
        const oldId = workers[0].latest.requestId;
        controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        const next = client.request<Float32Array>({type: 'inpaint'});
        await vi.advanceTimersByTimeAsync(1_000);
        expect(workers[0].postMessage).toHaveBeenCalledTimes(3);
        workers[0].emit({stage: 'recognizing', percent: 99});
        workers[0].emit({success: true, result: {results: []}});
        await flush();
        expect(progress).not.toHaveBeenCalled();
        expect(workers[0].latest.type).toBe('inpaint');
        // 已完成的旧 handler 即使迟到也不能清除新请求的监听器。
        oldMessage({data: {requestId: oldId, success: true}} as MessageEvent<MangaInferenceResponse>);
        oldError({message: 'late error from canceled page'} as ErrorEvent);
        const output = new Float32Array([0.5]);
        workers[0].emit({success: true, result: output});
        await expect(next).resolves.toBe(output);
        expect(createWorker).toHaveBeenCalledOnce();
        expect(workers[0].terminate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        const releaseOcr = client.release('ocr');
        await flush(); workers[0].emit(); await releaseOcr;
        expect(workers[0].terminate).not.toHaveBeenCalled();
        const nextPainter = client.request({type: 'inpaint'});
        await flush(); workers[0].emit(); await nextPainter;
        expect(createWorker).toHaveBeenCalledOnce();
        const releasePainter = client.release('inpaint');
        await flush(); workers[0].emit(); await releasePainter;
        expect(workers[0].terminate).toHaveBeenCalledOnce();
    });

    it('取消模型准备立即返回，原下载和初始化完成后下一页复用，不发布旧页进度', async () => {
        const {client, workers, createWorker} = harness();
        const controller = new AbortController(), progress = vi.fn();
        const canceled = observe(client.prepare('ocr', controller.signal, progress));
        await flush();
        workers[0].emit({stage: 'preparing', percent: 10});
        progress.mockClear(); controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        const next = client.prepare('ocr');
        await vi.advanceTimersByTimeAsync(10_000);
        workers[0].emit({stage: 'initializing'});
        workers[0].emit();
        await flush();
        expect(workers[0].latest.requestId).toBe(2);
        workers[0].emit(); await next;
        expect(progress).not.toHaveBeenCalled();
        expect(createWorker).toHaveBeenCalledOnce();
        expect(workers[0].terminate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('取消准备的无人 Worker 仅空闲保留三分钟，下一次任务重置期限且 dispose 立即清理', async () => {
        const {client, workers, createWorker} = harness();
        const controller = new AbortController();
        const canceled = observe(client.prepare('ocr', controller.signal));
        await flush(); controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        workers[0].emit(); await flush();
        await vi.advanceTimersByTimeAsync(179_999);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        const next = client.prepare('inpaint');
        await flush();
        await vi.advanceTimersByTimeAsync(1);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        workers[0].emit(); await next;
        expect(createWorker).toHaveBeenCalledOnce();
        client.dispose();
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        const orphan = new AbortController();
        const pending = observe(client.prepare('ocr', orphan.signal));
        await flush(); orphan.abort();
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        workers[1].emit(); await flush();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        const fresh = client.prepare('ocr');
        await flush(); expect(workers[2].latest.cpu).toBe(false);
        workers[2].emit(); await fresh;
    });

    it('取消后的模型阶段仍由超时看守，初始化失败硬终止且不重建 CPU', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const canceled = observe(client.prepare('ocr', controller.signal));
        await flush(); controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        workers[0].emit({stage: 'initializing'});
        await vi.advanceTimersByTimeAsync(15_000);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('准备回复到达后同步取消仍留有空闲释放期限，已回复的旧代不能在 dispose 后取得端口', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const canceled = observe(client.prepare('ocr', controller.signal));
        await flush();
        workers[0].emit(); controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await vi.advanceTimersByTimeAsync(180_000);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        const oldGeneration = observe(client.prepare('ocr'));
        await flush();
        workers[1].emit(); client.dispose();
        await expect(oldGeneration).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('下一条排队请求触发取消时，已完成 prepare 仍不得给旧调用方登记端口', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const canceled = observe(client.prepare('ocr', controller.signal));
        await flush();
        workers[0].postMessage.mockImplementationOnce(() => {
            controller.abort(); workers[0].emit();
        });
        const queued = client.request({type: 'recognize', image: 'next'});
        workers[0].emit();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await queued;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('GPU 失败与取消同时发生时，不创建 CPU Worker', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const result = observe(client.prepare('ocr', controller.signal));
        await flush();
        workers[0].emit({success: false, error: 'GPU failed'});
        controller.abort();
        await expect(result).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await flush();
        expect(workers).toHaveLength(1);
    });

    it('CPU 回退通知触发取消时，在第二次 attempt 入口拒绝且不创建新 Worker', async () => {
        const {client, workers} = harness();
        const controller = new AbortController();
        const progress = vi.fn(() => controller.abort());
        const result = observe(client.prepare('ocr', controller.signal, progress));
        await flush();
        workers[0].emit({success: false, error: 'GPU failed'});
        await expect(result).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await flush();
        expect(progress.mock.calls).toEqual([['initializing']]);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('两个客户端共享真实并行预算，等待预算时取消不阻塞后续请求', async () => {
        const first = harness(), second = harness();
        const busy = first.client.prepare('ocr');
        await flush();
        const controller = new AbortController();
        const waiting = observe(second.client.prepare('inpaint', controller.signal));
        await flush();
        expect(second.createWorker).not.toHaveBeenCalled();
        controller.abort();
        await expect(waiting).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        first.workers[0].emit();
        await busy;
        const next = second.client.prepare('inpaint');
        await flush();
        second.workers[0].emit();
        await next;
    });

    it('dispose 使尚未启动的旧代请求失效，新的请求可正常创建 Worker', async () => {
        const {client, workers, createWorker} = harness();
        const queued = observe(client.prepare('ocr'));
        client.dispose();
        await expect(queued).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        expect(createWorker).not.toHaveBeenCalled();
        const next = client.prepare('inpaint');
        await flush();
        workers[0].emit();
        await next;
    });

    it('dispose 取消当前和排队任务，禁止已销毁代的 GPU 请求回退重建', async () => {
        const {client, workers} = harness();
        const active = observe(client.prepare('ocr'));
        const queued = observe(client.prepare('inpaint'));
        await flush();
        client.dispose();
        await flush();
        // 即使回归导致错误地启动 CPU 重试，也完成它，避免遗留未处理 Promise 干扰其他用例。
        workers[1]?.emit();
        await flush();
        expect(workers).toHaveLength(1);
        await expect(active).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await expect(queued).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        expect(workers[0].terminate).toHaveBeenCalledOnce();
    });

    it('释放单个端口保留另一个，最后一个释放后终止 Worker 并恢复 GPU 首选', async () => {
        const {client, workers} = harness();
        const ocr = client.prepare('ocr');
        await flush();
        workers[0].emit({success: false, error: 'GPU init failed'});
        await flush();
        workers[1].emit();
        await ocr;
        const painter = client.prepare('inpaint');
        await flush();
        workers[1].emit();
        await painter;
        const releaseOcr = client.release('ocr');
        await flush();
        expect(workers[1].latest.type).toBe('dispose-ocr');
        workers[1].emit();
        await releaseOcr;
        expect(workers[1].terminate).not.toHaveBeenCalled();
        const releasePainter = client.release('inpaint');
        await flush();
        expect(workers[1].latest.type).toBe('dispose-inpaint');
        workers[1].emit();
        await releasePainter;
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        await client.release('inpaint');
        const next = client.prepare('ocr');
        await flush();
        expect(workers[2].latest.cpu).toBe(false);
        workers[2].emit();
        await next;
    });

    it('释放失败不进行 CPU 重试，失败队列仍允许新的请求', async () => {
        const {client, workers} = harness();
        const prepare = client.prepare('ocr');
        await flush();
        workers[0].emit();
        await prepare;
        const release = observe(client.release('ocr'));
        await flush();
        workers[0].emit({success: false, error: 'release failed'});
        await expect(release).resolves.toMatchObject({status: 'rejected', reason: {message: 'release failed'}});
        expect(workers).toHaveLength(1);
        const next = client.prepare('ocr');
        await flush();
        workers[1].emit();
        await next;
    });
});

describe('漫画推理阶段超时契约', () => {
    it('真实 Worker 在 OCR 取消收尾超时后重建修补端口，用 recognizing 重置 15 秒初始化期限为完整 60 秒', async () => {
        const deferred = <T>() => {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>(yes => { resolve = yes; });
            return {promise, resolve};
        };
        const initialization = deferred<void>();
        const inference = deferred<Float32Array>();
        const recognizing = deferred<{results: []}>();
        const painter = {run: vi.fn(() => inference.promise), release: vi.fn(async () => undefined)};
        const createPainter = vi.fn(async (_signal, progress: (percent?: number, initializing?: boolean) => void) => {
            progress(undefined, true);
            if (createPainter.mock.calls.length === 2) await initialization.promise;
            return painter;
        });
        const ort = {InferenceSession: {create: vi.fn()}};
        vi.doMock('onnxruntime-web/webgpu', () => ort);
        vi.doMock('@/src/features/image-translation/services/mangaOcr', () => ({
            createBrowserMangaOcr: vi.fn(async () => ({recognize: () => recognizing.promise, destroy: async () => undefined})),
        }));
        vi.doMock('@/src/features/image-translation/services/mangaInpainting', () => ({createBrowserMangaInpainter: createPainter}));
        const {startMangaInferenceWorker} = await import('@/src/features/image-translation/services/mangaInference.worker');
        const workers: ControlledWorker[] = [];
        const client = module.createMangaInferenceClient(() => {
            const worker = new ControlledWorker();
            const scope = {
                onmessage: undefined as ((event: MessageEvent<MangaInferenceMessage>) => void) | undefined,
                postMessage: (response: MangaInferenceResponse) => worker.onmessage?.({data: response} as MessageEvent<MangaInferenceResponse>),
            };
            const previousScope = globalThis.self;
            vi.stubGlobal('self', scope);
            // 浏览器中的每个 Worker 有自己的 ORT 实例；这里还原其独立创建入口。
            ort.InferenceSession.create = vi.fn();
            startMangaInferenceWorker();
            vi.stubGlobal('self', previousScope);
            worker.postMessage.mockImplementation(message => scope.onmessage!({data: message} as MessageEvent<MangaInferenceMessage>));
            workers.push(worker);
            return worker as unknown as Worker;
        });
        clients.push(client);
        const prepared = client.prepare('inpaint');
        await flush();
        await prepared;
        const controller = new AbortController();
        const canceled = observe(client.request({type: 'recognize', image: 'cancelled-page'}, controller.signal));
        await flush();
        controller.abort();
        await expect(canceled).resolves.toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
        await vi.advanceTimersByTimeAsync(1_500);
        recognizing.resolve({results: []});
        await flush();
        const progress = vi.fn();
        const pending = observe(client.request({
            type: 'inpaint', patch: {image: new Float32Array(3), mask: new Float32Array(1), width: 1, height: 1},
        }, undefined, progress));
        await flush();
        expect(workers).toHaveLength(2);
        expect(workers[1].latest.cpu).toBe(false);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        initialization.resolve();
        await flush();
        const beforeInference = progress.mock.calls.slice();
        // 推理的 59,999 毫秒内不触发初始化的旧 15 秒期限，也不扣除初始化耗时。
        await vi.advanceTimersByTimeAsync(59_999);
        const output = new Float32Array([0.5]);
        inference.resolve(output);
        await flush();
        await expect(pending).resolves.toEqual({status: 'fulfilled', value: output});
        expect(beforeInference).toEqual([['initializing', undefined], ['recognizing', undefined]]);
        expect(workers).toHaveLength(2);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers[1].terminate).not.toHaveBeenCalled();
        expect(createPainter).toHaveBeenCalledTimes(2);
        expect(painter.run).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('prepare 没有收到任何阶段时也在 120 秒超时，CPU 重试同样有初始期限', async () => {
        const {client, workers} = harness();
        const pending = observe(client.prepare('ocr'));
        await flush();
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(workers).toHaveLength(2);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('prepare 初始允许 120 秒等待，下载进度每次重置 120 秒空闲期限', async () => {
        const {client, workers} = harness();
        const pending = client.prepare('ocr');
        await flush();
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        workers[0].emit({stage: 'preparing', percent: 0});
        await vi.advanceTimersByTimeAsync(119_999);
        workers[0].emit({stage: 'preparing', percent: 25});
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers).toHaveLength(1);
        workers[0].emit();
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('下载空闲满 120 秒才重建 CPU Worker，CPU 下载空闲也限 120 秒', async () => {
        const {client, workers} = harness();
        const pending = observe(client.prepare('inpaint'));
        await flush();
        workers[0].emit({stage: 'preparing'});
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(workers).toHaveLength(2);
        expect(workers[1].latest.cpu).toBe(true);
        workers[1].emit({stage: 'preparing', percent: 50});
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(workers).toHaveLength(2);
    });

    it('旧请求阶段消息不能重置当前初始化看守期限', async () => {
        const {client, workers} = harness();
        const prepared = client.prepare('ocr');
        await flush();
        const oldRequest = workers[0].latest.requestId;
        workers[0].emit();
        await prepared;
        const pending = client.prepare('inpaint');
        await flush();
        workers[0].emit({stage: 'initializing'});
        await vi.advanceTimersByTimeAsync(14_999);
        workers[0].emit({requestId: oldRequest, stage: 'preparing', percent: 50});
        await vi.advanceTimersByTimeAsync(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers).toHaveLength(2);
        workers[1].emit();
        await pending;
    });

    it('真实 initializing 阶段使用 GPU 15 秒、CPU 120 秒，切阶段清除下载计时器', async () => {
        const {client, workers} = harness();
        const pending = observe(client.prepare('ocr'));
        await flush();
        workers[0].emit({stage: 'preparing', percent: 100});
        await vi.advanceTimersByTimeAsync(100_000);
        expect(workers).toHaveLength(1);
        workers[0].emit({stage: 'initializing'});
        await vi.advanceTimersByTimeAsync(14_999);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        // 重试后收到真实阶段之前，不能沿用 GPU 初始化期限。
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        workers[1].emit({stage: 'initializing'});
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers).toHaveLength(2);
    });

    it.each(['recognize', 'inpaint'] as const)('%s 推理 GPU 60 秒、CPU 120 秒，超时硬终止且仅重试一次', async type => {
        const {client, workers} = harness();
        const pending = observe(client.request({type}));
        await flush();
        workers[0].emit({stage: 'recognizing'});
        await vi.advanceTimersByTimeAsync(59_999);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers[1].latest.cpu).toBe(true);
        workers[1].emit({stage: 'recognizing'});
        await vi.advanceTimersByTimeAsync(119_999);
        expect(workers[1].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers[1].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['ocr', 'inpaint'] as const)('dispose-%s 等待至 10 秒时硬终止，并且不回退 CPU', async kind => {
        const {client, workers} = harness();
        const prepared = client.prepare(kind);
        await flush();
        workers[0].emit();
        await prepared;
        const release = observe(client.release(kind));
        await flush();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(release).resolves.toMatchObject({status: 'rejected', reason: {message: expect.stringContaining('超时')}});
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(workers).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

async function prepareText(h:ReturnType<typeof harness>,ready=true){
    const pending=h.client.prepareTextSegmentation();await flush();h.workers.at(-1)!.emit({success:true,result:ready});await pending;
}
const inputText=()=>new Float32Array(3*1024*1024);
const outputText=()=>new Uint8Array(1024*1024);

describe('可选离线 CTD 客户端',()=>{
    it('必须先prepare可用性，缺模型明确false且工厂零调用',async()=>{
        const h=harness(),factory=vi.fn(inputText);
        await expect(h.client.segmentText(factory)).rejects.toBeInstanceOf(module.MangaSegmentationProtocolError);
        expect(h.createWorker).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();
        const ready=h.client.prepareTextSegmentation();await flush();expect(h.workers[0].latest.type).toBe('prepare-seg');h.workers[0].emit({success:true,result:false});
        await expect(ready).resolves.toBe(false);await expect(h.client.segmentText(factory)).rejects.toThrow('尚未准备');
        expect(factory).not.toHaveBeenCalled();h.client.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it('真实transfer使旧buffer detached，CPU一次重试重新调用工厂并转移另一完整buffer',async()=>{
        const workers:ControlledWorker[]=[],transferred:Float32Array[]=[];
        const client=module.createMangaInferenceClient(()=>{
            const worker=new ControlledWorker();workers.push(worker);
            worker.postMessage.mockImplementation((message,transfer)=>{
                if(transfer){const copy=structuredClone(message,{transfer});transferred.push(copy.tensor!);}
            });return worker as unknown as Worker;
        });clients.push(client);
        let pending=client.prepareTextSegmentation();await flush();workers[0].emit({success:true,result:true});await pending;
        const built:Float32Array[]=[],factory=vi.fn(()=>{const data=inputText();data[0]=.25;built.push(data);return data;});
        const result=client.segmentText(factory);await flush();
        expect(built[0].byteLength).toBe(0);expect(transferred[0][0]).toBe(.25);
        workers[0].emit({success:false,error:'GPU native failure',errorKind:'execution'});await flush();
        expect(workers).toHaveLength(2);expect(workers[1].latest.cpu).toBe(true);expect(factory).toHaveBeenCalledTimes(2);
        expect(built[1].byteLength).toBe(0);expect(transferred[1]).toHaveLength(3*1024*1024);expect(transferred[1][0]).toBe(.25);
        workers[1].emit({success:true,result:outputText()});await expect(result).resolves.toHaveLength(1024*1024);
        const release=client.release('seg');await flush();expect(workers[1].latest.type).toBe('dispose-seg');workers[1].emit();await release;
        expect(workers[1].terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['prepare','segment'] as const)('%s协议失败不当GPU问题重建或再次分配',async stage=>{
        const h=harness(),factory=vi.fn(inputText);
        if(stage==='segment')await prepareText(h);
        const result=observe<boolean|Uint8Array>(stage==='prepare'?h.client.prepareTextSegmentation():h.client.segmentText(factory));await flush();
        h.workers[0].emit({success:false,error:'invalid model SHA',errorKind:'protocol'});
        await expect(result).resolves.toMatchObject({status:'rejected',reason:{name:'MangaSegmentationProtocolError',message:'invalid model SHA'}});
        expect(h.workers).toHaveLength(1);expect(h.workers[0].terminate).toHaveBeenCalledOnce();expect(factory).toHaveBeenCalledTimes(stage==='prepare'?0:1);
    });
    it('工厂异常保持原对象且不重试，未转移input不终止已有OCR/seg会话',async()=>{
        const h=harness();await prepareText(h);const failure=new Error('source owner vanished'),factory=vi.fn(()=>{throw failure;});
        await expect(h.client.segmentText(factory)).rejects.toBe(failure);expect(factory).toHaveBeenCalledOnce();
        expect(h.createWorker).toHaveBeenCalledOnce();expect(h.workers[0].postMessage).toHaveBeenCalledOnce();expect(h.workers[0].terminate).not.toHaveBeenCalled();
    });
    it.each(['short','offset','shared','nan','negative','over','wrong'] as const)('%s工厂输出早拒，不发Worker或CPU重试',async fault=>{
        const h=harness();await prepareText(h);let source:Float32Array=inputText();
        if(fault==='short')source=new Float32Array(1);
        if(fault==='offset')source=new Float32Array(new ArrayBuffer((3*1024*1024+1)*4),4);
        if(fault==='shared')source=new Float32Array(new SharedArrayBuffer(source.byteLength));
        if(fault==='nan')source[0]=NaN;if(fault==='negative')source[0]=-.1;if(fault==='over')source[0]=1.1;
        if(fault==='wrong')source={} as Float32Array;
        await expect(h.client.segmentText(()=>source)).rejects.toBeInstanceOf(module.MangaSegmentationProtocolError);
        expect(h.workers[0].postMessage).toHaveBeenCalledOnce();expect(h.createWorker).toHaveBeenCalledOnce();
    });
    it.each(['prepare','short','offset','shared','wrong'] as const)('%s响应不满足owned固定协议时硬终止且不重试',async fault=>{
        const h=harness();if(fault!=='prepare')await prepareText(h);
        const result=observe<boolean|Uint8Array>(fault==='prepare'?h.client.prepareTextSegmentation():h.client.segmentText(inputText));await flush();
        const value=fault==='prepare'?undefined:fault==='short'?new Uint8Array(1):fault==='offset'?new Uint8Array(new ArrayBuffer(1024*1024+1),1):fault==='shared'?new Uint8Array(new SharedArrayBuffer(1024*1024)):new Float32Array(1024*1024);
        h.workers[0].emit({success:true,result:value});await expect(result).resolves.toMatchObject({status:'rejected',reason:{name:'MangaSegmentationProtocolError'}});
        expect(h.workers).toHaveLength(1);expect(h.workers[0].terminate).toHaveBeenCalledOnce();
    });
    it('排队取消/全局dispose不调用输入工厂，推理取消最多1.5秒收尾',async()=>{
        const h=harness();await prepareText(h);const busy=h.client.request({type:'recognize',image:'other'});await flush();
        const abort=new AbortController(),factory=vi.fn(inputText),queued=observe(h.client.segmentText(factory,abort.signal));abort.abort();
        await expect(queued).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});h.workers[0].emit({success:true,result:{results:[]}});await busy;await flush();expect(factory).not.toHaveBeenCalled();
        const started=new AbortController(),running=observe(h.client.segmentText(factory,started.signal));await flush();started.abort();
        await expect(running).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});await vi.advanceTimersByTimeAsync(1500);expect(h.workers[0].terminate).toHaveBeenCalledOnce();
        await expect(h.client.segmentText(factory)).rejects.toThrow('尚未准备');
    });
    it('已取消prepare迟到成功也保留独立空闲清理，不受OCR持有端口影响',async()=>{
        const h=harness(),ocr=h.client.prepare('ocr');await flush();h.workers[0].emit();await ocr;
        const abort=new AbortController(),pending=observe(h.client.prepareTextSegmentation(abort.signal));await flush();abort.abort();
        await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});h.workers[0].emit({success:true,result:true});await flush();
        await vi.advanceTimersByTimeAsync(180000);expect(h.workers[0].latest.type).toBe('dispose-seg');h.workers[0].emit();await flush();
        expect(h.workers[0].terminate).not.toHaveBeenCalled();const next=h.client.request({type:'recognize'});await flush();h.workers[0].emit({success:true,result:{results:[]}});await next;
    });
    it('seg独立空闲释放，不关闭OCR；没有其他端口则终止整个Worker',async()=>{
        const h=harness();await prepareText(h);await vi.advanceTimersByTimeAsync(179999);expect(h.workers[0].latest.type).toBe('prepare-seg');
        await vi.advanceTimersByTimeAsync(1);expect(h.workers[0].latest.type).toBe('dispose-seg');h.workers[0].emit();await flush();expect(h.workers[0].terminate).toHaveBeenCalledOnce();
    });
    it('已排队idle回调不会释放新seg调用，独立epoch失效后新prepare保持同owner',async()=>{
        const h=harness();await prepareText(h);await vi.advanceTimersByTimeAsync(170000);
        const busy=h.client.request({type:'recognize'});await flush();h.workers[0].emit({stage:'preparing'});await vi.advanceTimersByTimeAsync(10000);
        const renewed=h.client.prepareTextSegmentation();h.workers[0].emit({success:true,result:{results:[]}});await busy;await flush();
        expect(h.workers[0].postMessage.mock.calls.map(([message])=>message.type)).toEqual(['prepare-seg','recognize','prepare-seg']);h.workers[0].emit({success:true,result:true});await renewed;
    });
    it('idle释放失败保留诊断并终止旧owner，不触发CPU恢复',async()=>{
        const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),h=harness();await prepareText(h);
        await vi.advanceTimersByTimeAsync(180000);h.workers[0].emit({success:false,error:'release failed',errorKind:'execution'});await flush();
        expect(warn).toHaveBeenCalledWith('图片分割空闲释放失败',expect.objectContaining({message:'release failed'}));expect(h.workers).toHaveLength(1);expect(h.workers[0].terminate).toHaveBeenCalledOnce();
    });
});

it('seg准备回复后同tick取消或销毁，不给旧owner登记端口',async()=>{
    const h=harness(),abort=new AbortController(),pending=observe(h.client.prepareTextSegmentation(abort.signal));
    await flush();h.workers[0].emit({success:true,result:true});abort.abort();
    await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});
    const next=observe(h.client.prepareTextSegmentation());await flush();h.workers[0].emit({success:true,result:true});h.client.dispose();
    await expect(next).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});expect(vi.getTimerCount()).toBe(0);
});
it('CPU重试前取消不再调用分割输入工厂，空协议错误保留明确首因',async()=>{
    const h=harness(),abort=new AbortController();await prepareText(h);const factory=vi.fn(inputText);
    const pending=observe(h.client.segmentText(factory,abort.signal,()=>abort.abort()));await flush();
    h.workers[0].emit({success:false,errorKind:'execution',error:'GPU failure'});
    await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});await flush();expect(factory).toHaveBeenCalledOnce();expect(h.workers).toHaveLength(1);
    const bad=observe(h.client.prepareTextSegmentation());await flush();h.workers.at(-1)!.emit({success:false,errorKind:'protocol'});
    await expect(bad).resolves.toMatchObject({status:'rejected',reason:{message:'图片分割协议错误'}});
});

it('已完成seg准备在下一条排队消息同步取消时，不发布旧页ready',async()=>{
    const h=harness(),abort=new AbortController(),pending=observe(h.client.prepareTextSegmentation(abort.signal));await flush();
    h.workers[0].postMessage.mockImplementationOnce(()=>{abort.abort();h.workers[0].emit({success:true,result:{results:[]}});});
    const queued=h.client.request({type:'recognize',image:'next'});h.workers[0].emit({success:true,result:true});
    await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});await queued;
});

it.each(['prepare','segment'] as const)('全局删除释放后旧%s等待者不能创建新Worker或分配tensor',async stage=>{
    const h=harness();if(stage==='segment')await prepareText(h);
    const {withMangaModelRemoval}=await import('@/src/features/image-translation/services/mangaOcrAssets');
    let done!:()=>void;const removal=withMangaModelRemoval(()=>new Promise<void>(resolve=>{done=resolve;}));
    const factory=vi.fn(inputText),pending=observe<boolean|Uint8Array>(stage==='prepare'?h.client.prepareTextSegmentation():h.client.segmentText(factory));
    await Promise.resolve();h.client.dispose();done();await removal;
    await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});expect(factory).not.toHaveBeenCalled();
    expect(h.createWorker).toHaveBeenCalledTimes(stage==='prepare'?0:1);
});

it.each(['pre-aborted','queued-cancel'] as const)('已有分割端口再次prepare %s后仍独立空闲释放，OCR继续可用',async mode=>{
    const h=harness(),ocr=h.client.prepare('ocr');await flush();h.workers[0].emit();await ocr;
    await prepareText(h);
    let busy:Promise<unknown>|undefined;
    if(mode==='queued-cancel'){busy=h.client.request({type:'recognize',image:'active-ocr'});await flush();}
    const abort=new AbortController();if(mode==='pre-aborted')abort.abort();
    const pending=observe(h.client.prepareTextSegmentation(abort.signal));
    if(mode==='queued-cancel')abort.abort();
    await expect(pending).resolves.toMatchObject({status:'rejected',reason:{name:'AbortError'}});
    if(busy){h.workers[0].emit({success:true,result:{results:[]}});await busy;await flush();}
    // 已取消的准备根本没有到达 Worker；原有效 CTD 会话仍需重新获得空闲期限。
    expect(h.workers[0].postMessage.mock.calls.filter(([message])=>message.type==='prepare-seg')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(179999);
    expect(h.workers[0].postMessage.mock.calls.some(([message])=>message.type==='dispose-seg')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);expect(h.workers[0].latest.type).toBe('dispose-seg');
    h.workers[0].emit();await flush();expect(h.workers[0].terminate).not.toHaveBeenCalled();
    const next=h.client.request({type:'recognize',image:'next-ocr'});await flush();h.workers[0].emit({success:true,result:{results:[]}});await next;
    expect(h.createWorker).toHaveBeenCalledOnce();expect(h.workers[0].terminate).not.toHaveBeenCalled();
});
