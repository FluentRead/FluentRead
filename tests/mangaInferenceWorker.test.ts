/**
 * @file tests/mangaInferenceWorker.test.ts
 * 文件职责：验证独立漫画 Worker 的真实消息处理器与 ONNX 初始化串行锁。
 * 主要内容：以延迟模型端口覆盖错误恢复、FIFO、CPU 锁定、进度转发、张量所有权及模型释放；真实资源调度验证推理内 CPU 初始化不会嵌套互等。
 * 模块边界：只替换模型与 ONNX 外部接口，不下载权重或验证真实浏览器 GPU；取消由客户端硬终止负责。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MangaInferenceMessage, MangaInferenceProgress, MangaInferenceResponse} from '@/src/features/image-translation/services/mangaInferenceClient';

const mocks = vi.hoisted(() => {
    const create = vi.fn();
    return {
        createOcr: vi.fn(), createPainter: vi.fn(), create, session: {create},
        initialization: vi.fn(),loadSeg:vi.fn(),inputs:[] as Array<{type:string;data:Float32Array;dims:number[];dispose:ReturnType<typeof vi.fn>}>,
        realInitialization: undefined as typeof import('@/src/shared/onnx/resources')['paceLocalInitialization'] | undefined,
    };
});
vi.mock('onnxruntime-web/webgpu', () => ({InferenceSession: mocks.session,env:{wasm:{}},Tensor:class {
    type:string;data:Float32Array;dims:number[];dispose=vi.fn();
    constructor(type:string,data:Float32Array,dims:number[]){this.type=type;this.data=data;this.dims=dims;mocks.inputs.push(this);}
}}));
vi.mock('@/src/features/image-translation/services/mangaOcrAssets',()=>({loadMangaTextSegmentationAsset:mocks.loadSeg}));
vi.mock('@/src/shared/onnx/resources', async importOriginal => {
    const resources = await importOriginal<typeof import('@/src/shared/onnx/resources')>();
    mocks.realInitialization = resources.paceLocalInitialization;
    return {...resources, paceLocalInitialization: <T>(operation: () => Promise<T>) => mocks.initialization(operation)};
});
vi.mock('@/src/features/image-translation/services/mangaOcr', () => ({createBrowserMangaOcr: mocks.createOcr}));
vi.mock('@/src/features/image-translation/services/mangaInpainting', () => ({createBrowserMangaInpainter: mocks.createPainter}));

type WorkerScope = {
    onmessage?: (event: MessageEvent<MangaInferenceMessage>) => void;
    postMessage: ReturnType<typeof vi.fn>;
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
async function flush() { await vi.advanceTimersByTimeAsync(0); }
let scope: WorkerScope;
let ocr: {recognize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>};
let painter: {run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>};
const terminal = () => scope.postMessage.mock.calls.map(([message]) => message as MangaInferenceResponse).filter(message => message.success !== undefined);
async function send(message: Partial<MangaInferenceMessage> & {type: MangaInferenceMessage['type']; requestId: number}) {
    scope.onmessage!({data: {cpu: false, ...message}} as MessageEvent<MangaInferenceMessage>);
    await flush();
    return terminal().find(response => response.requestId === message.requestId);
}

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
    // 队列单元用例只控制模型 Promise；互等回归会单独启用真实初始化预算。
    mocks.initialization.mockReset().mockImplementation(<T>(operation: () => Promise<T>) => operation());
    mocks.create.mockReset().mockResolvedValue({backend: 'fixture'});
    mocks.session.create = mocks.create;
    mocks.loadSeg.mockReset().mockResolvedValue(undefined);mocks.inputs.length=0;
    ocr = {recognize: vi.fn().mockResolvedValue({results: []}), destroy: vi.fn().mockResolvedValue(undefined)};
    painter = {run: vi.fn().mockResolvedValue(new Float32Array([0.25])), release: vi.fn().mockResolvedValue(undefined)};
    mocks.createOcr.mockReset().mockResolvedValue(ocr);
    mocks.createPainter.mockReset().mockResolvedValue(painter);
    scope = {postMessage: vi.fn()};
    vi.stubGlobal('self', scope);
    vi.stubGlobal('navigator', {hardwareConcurrency: 8, gpu: {requestAdapter: vi.fn()}});
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>`chrome-extension://fixture${path}`}});
    const worker = await import('@/src/app/offscreen/mangaInferenceWorker');
    worker.startMangaInferenceWorkerApp();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('漫画推理 Worker 消息处理器', () => {
    it('仅在会话成功创建后报告该次配置的执行后端，不暴露图片和模型内容', async () => {
        mocks.createOcr.mockImplementationOnce(async () => {
            await mocks.session.create('det.onnx', {executionProviders: ['webgpu', {name: 'wasm'}, 'unknown']});
            await mocks.session.create('rec.onnx', {});
            return ocr;
        });
        await send({requestId: 99, type: 'prepare-ocr'});
        expect(scope.postMessage).toHaveBeenCalledWith({requestId: 99, executionProviders: ['webgpu', 'wasm']}, []);
        expect(scope.postMessage.mock.calls.filter(([message]) => message.executionProviders)).toHaveLength(1);
        mocks.create.mockRejectedValueOnce(new Error('session failed'));
        mocks.createPainter.mockImplementationOnce(async () => {
            await mocks.session.create('lama.onnx', {executionProviders: ['wasm']}); return painter;
        });
        const failed = await send({requestId: 100, type: 'prepare-inpaint'});
        expect(failed).toMatchObject({success: false, error: 'session failed'});
        expect(scope.postMessage.mock.calls.filter(([message]) => message.executionProviders)).toHaveLength(1);
    });
    it('普通图片可请求真实检测侧车，仅转移owned bit bytes，不把模型Float32概率张量转移',async()=>{
        const bits=new Uint8Array([1,2]),originalProbability=new Float32Array([.9,.1]);
        ocr.recognize.mockResolvedValue({results:[],imageDetectionFrames:[{pageWidth:4,pageHeight:4,x:0,y:0,width:4,height:4,bits}]});
        const result=await send({requestId:44,type:'recognize',image:'image',imageDetectionEvidence:true});
        expect(ocr.recognize).toHaveBeenCalledWith('image',{flatten:true,noCache:true,strategy:'per-box',imageDetectionEvidence:true});
        const [,transfer]=scope.postMessage.mock.calls.find(([message])=>message===result)!;
        expect(transfer).toEqual([bits.buffer]);expect(transfer).not.toContain(originalProbability.buffer);
    });
    it('漫画可请求像素段落证据且不生成检测帧传输',async()=>{
        ocr.recognize.mockResolvedValue({results:[],imageParagraphGapProofs:[]});
        const result=await send({requestId:47,type:'recognize',image:'manga',mangaParagraphGapEvidence:true});
        expect(ocr.recognize).toHaveBeenCalledWith('manga',{flatten:true,noCache:true,strategy:'per-box',mangaParagraphGapEvidence:true});
        expect(result).toMatchObject({requestId:47,success:true,result:{results:[],imageParagraphGapProofs:[]}});
        expect(scope.postMessage.mock.calls.find(([message])=>message===result)![1]).toEqual([]);
    });
    it('侧车重复buffer只转移一次，非ArrayBuffer不列transfer，正常消息仍不含新flag',async()=>{
        const bits=new Uint8Array([1]),shared=new Uint8Array(new SharedArrayBuffer(1));
        const geometry={pageWidth:1,pageHeight:1,x:0,y:0,width:1,height:1};
        ocr.recognize.mockResolvedValue({results:[],imageDetectionFrames:[{...geometry,bits},{...geometry,bits},{...geometry,bits:shared}]});
        const result=await send({requestId:45,type:'recognize',image:'image'});
        expect(ocr.recognize).toHaveBeenCalledWith('image',{flatten:true,noCache:true,strategy:'per-box'});
        expect(scope.postMessage.mock.calls.find(([message])=>message===result)![1]).toEqual([bits.buffer]);
    });
    it('不同侧车view共享同一ArrayBuffer时保留各自内容与边界，并且只转移底层buffer一次',async()=>{
        const buffer=new ArrayBuffer(3),first=new Uint8Array(buffer,0,1),last=new Uint8Array(buffer,2,1);
        first[0]=1;last[0]=2;
        const geometry={pageWidth:2,pageHeight:1,y:0,width:1,height:1};
        const frames=[{...geometry,x:0,bits:first},{...geometry,x:1,bits:last}],page={results:[],imageDetectionFrames:frames};
        ocr.recognize.mockResolvedValue(page);
        const result=await send({requestId:46,type:'recognize',image:'image',imageDetectionEvidence:true});
        expect(result).toEqual({requestId:46,success:true,result:page});
        expect(scope.postMessage.mock.calls.find(([message])=>message===result)![1]).toEqual([buffer]);
        expect(frames.map(frame=>({offset:frame.bits.byteOffset,length:frame.bits.byteLength,value:frame.bits[0]})))
            .toEqual([{offset:0,length:1,value:1},{offset:2,length:1,value:2}]);
        expect(ocr.recognize).toHaveBeenCalledOnce();
    });
    it('拒绝空消息、不安全 ID 和未知操作，合法消息仍能执行', async () => {
        for (const data of [undefined, null, {}, {requestId: NaN, type: 'prepare-ocr'}, {requestId: 1.5, type: 'prepare-ocr'}, {requestId: Number.MAX_SAFE_INTEGER + 1, type: 'prepare-ocr'}, {requestId: '1', type: 'prepare-ocr'}, {requestId: 1, type: 'unknown'}]) {
            scope.onmessage!({data} as MessageEvent<MangaInferenceMessage>);
        }
        await flush();
        expect(scope.postMessage).not.toHaveBeenCalled();
        expect(mocks.createOcr).not.toHaveBeenCalled();
        expect(mocks.createPainter).not.toHaveBeenCalled();
        expect(await send({requestId: 0, type: 'prepare-ocr'})).toEqual({requestId: 0, success: true, result: undefined});
    });

    it('OCR 准备转发阶段、复用模型，识别转发图片和正确策略，最后释放并重建', async () => {
        mocks.createOcr.mockImplementationOnce(async (_signal, progress: MangaInferenceProgress) => {
            progress('preparing', 0);
            progress('initializing');
            return ocr;
        });
        await send({requestId: 1, type: 'prepare-ocr'});
        expect(scope.postMessage.mock.calls.slice(0, 2)).toEqual([
            [{requestId: 1, stage: 'preparing', percent: 0}, []],
            [{requestId: 1, stage: 'initializing', percent: undefined}, []],
        ]);
        expect(mocks.createOcr).toHaveBeenCalledWith(undefined, expect.any(Function));
        const page = {results: [{text: 'hello', score: 0.9, box: {x: 0, y: 0, width: 10, height: 10}}]};
        ocr.recognize.mockResolvedValue(page);
        await send({requestId: 2, type: 'recognize', image: 'data:image/png;base64,AA=='});
        expect(ocr.recognize.mock.calls).toEqual([['data:image/png;base64,AA==', {flatten: true, noCache: true, strategy: 'per-box'}]]);
        expect(scope.postMessage).toHaveBeenCalledWith({requestId: 2, stage: 'recognizing', percent: undefined}, []);
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 2, success: true, result: page}, []);
        await send({requestId: 3, type: 'prepare-ocr'});
        expect(mocks.createOcr).toHaveBeenCalledOnce();
        await send({requestId: 4, type: 'dispose-ocr'});
        expect(ocr.destroy).toHaveBeenCalledOnce();
        await send({requestId: 5, type: 'dispose-ocr'});
        expect(ocr.destroy).toHaveBeenCalledOnce();
        await send({requestId: 6, type: 'prepare-ocr'});
        expect(mocks.createOcr).toHaveBeenCalledTimes(2);
    });

    it('inpaint 隐式准备模型、转发下载和初始化进度，并转移 Float32Array 的真实 ArrayBuffer', async () => {
        mocks.createPainter.mockImplementationOnce(async (_signal, progress: (percent?: number, initializing?: boolean) => void) => {
            progress(0, false);
            progress(90, true);
            progress();
            return painter;
        });
        const patch = {image: new Float32Array([1, 0, 1]), mask: new Float32Array([1]), width: 1, height: 1};
        const output = new Float32Array([0.5, 0.25, 0]);
        painter.run.mockResolvedValue(output);
        await send({requestId: 7, type: 'inpaint', patch});
        expect(painter.run.mock.calls).toEqual([[patch]]);
        expect(scope.postMessage.mock.calls.slice(0, 3)).toEqual([
            [{requestId: 7, stage: 'preparing', percent: 0}, []],
            [{requestId: 7, stage: 'initializing', percent: 90}, []],
            [{requestId: 7, stage: 'preparing', percent: undefined}, []],
        ]);
        expect(scope.postMessage.mock.calls[3]).toEqual([{requestId: 7, stage: 'recognizing', percent: undefined}, []]);
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 7, success: true, result: output}, [output.buffer]);
        expect(scope.postMessage.mock.calls.at(-1)![1][0]).toBe(output.buffer);
        await send({requestId: 8, type: 'prepare-inpaint'});
        expect(mocks.createPainter).toHaveBeenCalledOnce();
        expect(painter.run).toHaveBeenCalledOnce();
        await send({requestId: 9, type: 'dispose-inpaint'});
        expect(painter.release).toHaveBeenCalledOnce();
        await send({requestId: 10, type: 'dispose-inpaint'});
        expect(painter.release).toHaveBeenCalledOnce();
        await send({requestId: 11, type: 'prepare-inpaint'});
        expect(mocks.createPainter).toHaveBeenCalledTimes(2);
    });

    it('修补端口销毁后重建，在 run 开始前发布 recognizing 并保持请求身份', async () => {
        await send({requestId: 1, type: 'prepare-inpaint'});
        await send({requestId: 2, type: 'dispose-inpaint'});
        const output = deferred<Float32Array>();
        mocks.createPainter.mockImplementationOnce(async (_signal, progress: (percent?: number, initializing?: boolean) => void) => {
            progress(undefined, true);
            return painter;
        });
        painter.run.mockImplementationOnce(() => {
            // 在算子真正开始的边界检查，不能等 run 返回后才发送阶段。
            expect(scope.postMessage.mock.calls.at(-1)).toEqual([{requestId: 3, stage: 'recognizing', percent: undefined}, []]);
            return output.promise;
        });
        await send({requestId: 3, type: 'inpaint'});
        expect(mocks.createPainter).toHaveBeenCalledTimes(2);
        expect(painter.run).toHaveBeenCalledOnce();
        expect(scope.postMessage.mock.calls.filter(([message]) => message.requestId === 3)).toEqual([
            [{requestId: 3, stage: 'initializing', percent: undefined}, []],
            [{requestId: 3, stage: 'recognizing', percent: undefined}, []],
        ]);
        expect(terminal().map(message => message.requestId)).toEqual([1, 2]);
        const pixels = new Float32Array([0.5]);
        output.resolve(pixels);
        await flush();
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 3, success: true, result: pixels}, [pixels.buffer]);
    });

    it('共享内存上的张量不放入 transfer 列表，避免 DataCloneError', async () => {
        const output = new Float32Array(new SharedArrayBuffer(12));
        painter.run.mockResolvedValue(output);
        await send({requestId: 1, type: 'inpaint'});
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: true, result: output}, []);
    });

    it('空端口释放是幂等操作，不意外创建任何模型', async () => {
        expect(await send({requestId: 1, type: 'dispose-ocr'})).toMatchObject({success: true});
        expect(await send({requestId: 2, type: 'dispose-inpaint'})).toMatchObject({success: true});
        expect(mocks.createOcr).not.toHaveBeenCalled();
        expect(mocks.createPainter).not.toHaveBeenCalled();
    });

    it('释放 OCR 不销毁 inpaint 端口，释放 inpaint 不销毁新建的 OCR 端口', async () => {
        await send({requestId: 1, type: 'prepare-ocr'});
        await send({requestId: 2, type: 'prepare-inpaint'});
        await send({requestId: 3, type: 'dispose-ocr'});
        await send({requestId: 4, type: 'inpaint'});
        expect(painter.release).not.toHaveBeenCalled();
        expect(mocks.createPainter).toHaveBeenCalledOnce();
        await send({requestId: 5, type: 'prepare-ocr'});
        await send({requestId: 6, type: 'dispose-inpaint'});
        await send({requestId: 7, type: 'recognize', image: 'still-ready'});
        expect(ocr.destroy).toHaveBeenCalledOnce();
        expect(mocks.createOcr).toHaveBeenCalledTimes(2);
        expect(terminal().every(response => response.success)).toBe(true);
    });

    it('CPU 请求锁定单线程并屏蔽 WebGPU，后续 GPU 标记不能恢复后端', async () => {
        const resources = await import('@/src/shared/onnx/resources');
        expect(resources.localWasmThreads()).toBe(2);
        const gpu = (navigator as Navigator & {gpu?: unknown}).gpu;
        await send({requestId: 1, type: 'prepare-ocr'});
        expect((navigator as Navigator & {gpu?: unknown}).gpu).toBe(gpu);
        mocks.createPainter.mockImplementationOnce(async () => {
            expect(resources.localWasmThreads()).toBe(1);
            expect((navigator as Navigator & {gpu?: unknown}).gpu).toBeUndefined();
            return painter;
        });
        await send({requestId: 2, type: 'prepare-inpaint', cpu: true});
        await send({requestId: 3, type: 'recognize', cpu: false, image: 'page'});
        expect(resources.localWasmThreads()).toBe(1);
        expect((navigator as Navigator & {gpu?: unknown}).gpu).toBeUndefined();
    });

    it('无法屏蔽 GPU 时返回明确错误，消息队列继续执行', async () => {
        Object.defineProperty(navigator, 'gpu', {value: {}, configurable: false});
        const failure = await send({requestId: 1, type: 'prepare-ocr', cpu: true});
        expect(failure).toMatchObject({requestId: 1, success: false, error: expect.stringContaining('gpu')});
        expect(mocks.createOcr).not.toHaveBeenCalled();
        expect(await send({requestId: 2, type: 'prepare-ocr'})).toMatchObject({success: true});
    });

    it.each([
        ['prepare-ocr', 'createOcr', new Error('OCR download failed')],
        ['prepare-inpaint', 'createPainter', 'inpaint download failed'],
    ] as const)('%s 初始化失败后不缓存坏端口，下一请求重新创建', async (type, factory, error) => {
        mocks[factory].mockRejectedValueOnce(error);
        expect(await send({requestId: 1, type})).toEqual({requestId: 1, success: false, error: error instanceof Error ? error.message : error});
        expect(await send({requestId: 2, type})).toMatchObject({requestId: 2, success: true});
        expect(mocks[factory]).toHaveBeenCalledTimes(2);
    });

    it.each(['recognize', 'inpaint'] as const)('%s 算子失败有 requestId 且不破坏 FIFO 队列', async type => {
        const run = type === 'recognize' ? ocr.recognize : painter.run;
        run.mockRejectedValueOnce(new Error('operator failed'));
        expect(await send({requestId: 1, type})).toEqual({requestId: 1, success: false, error: 'operator failed'});
        expect(await send({requestId: 2, type})).toMatchObject({requestId: 2, success: true});
        expect(run).toHaveBeenCalledTimes(2);
        expect(type === 'recognize' ? mocks.createOcr : mocks.createPainter).toHaveBeenCalledOnce();
    });

    it.each(['ocr', 'inpaint'] as const)('%s 释放失败可重试，成功后才清空对应端口', async kind => {
        const release = kind === 'ocr' ? ocr.destroy : painter.release;
        const factory = kind === 'ocr' ? mocks.createOcr : mocks.createPainter;
        await send({requestId: 1, type: `prepare-${kind}`});
        release.mockRejectedValueOnce('release failed');
        expect(await send({requestId: 2, type: `dispose-${kind}`})).toEqual({requestId: 2, success: false, error: 'release failed'});
        expect(await send({requestId: 3, type: `dispose-${kind}`})).toMatchObject({success: true});
        expect(release).toHaveBeenCalledTimes(2);
        await send({requestId: 4, type: `prepare-${kind}`});
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('准备尚未完成时后续识别与释放保持 FIFO，失败任务不会毒化队列', async () => {
        const initialized = deferred<typeof ocr>();
        mocks.createOcr.mockReturnValueOnce(initialized.promise);
        const pending = send({requestId: 1, type: 'prepare-ocr'});
        await send({requestId: 2, type: 'recognize', image: 'queued-page'});
        await send({requestId: 3, type: 'dispose-ocr'});
        expect(terminal()).toEqual([]);
        expect(ocr.recognize).not.toHaveBeenCalled();
        expect(ocr.destroy).not.toHaveBeenCalled();
        initialized.resolve(ocr);
        await pending;
        await flush();
        expect(terminal().map(message => message.requestId)).toEqual([1, 2, 3]);
        expect(ocr.recognize).toHaveBeenCalledOnce();
        expect(ocr.destroy).toHaveBeenCalledOnce();
    });

    it('识别挂起时不并发执行 inpaint 或销毁正在使用的 OCR 端口', async () => {
        const inference = deferred<{results: []}>();
        ocr.recognize.mockReturnValueOnce(inference.promise);
        await send({requestId: 1, type: 'recognize', image: 'busy-page'});
        await send({requestId: 2, type: 'inpaint'});
        await send({requestId: 3, type: 'dispose-ocr'});
        expect(mocks.createPainter).not.toHaveBeenCalled();
        expect(ocr.destroy).not.toHaveBeenCalled();
        inference.reject(new Error('late inference failure'));
        await flush();
        expect(terminal()).toEqual([
            {requestId: 1, success: false, error: 'late inference failure'},
            {requestId: 2, success: true, result: expect.any(Float32Array)},
            {requestId: 3, success: true, result: undefined},
        ]);
    });
});

describe('ONNX Asyncify 初始化串行锁', () => {
    it.each(['ocr', 'inpaint'] as const)('%s 的真实推理 pacer 内部能创建 CPU session 并完成回退，不与初始化队列互等', async kind => {
        const resources = await import('@/src/shared/onnx/resources');
        mocks.initialization.mockImplementation(mocks.realInitialization!);
        const {protectMangaSession} = await import('@/src/features/image-translation/services/mangaSessionFallback');
        const trace: string[] = [];
        const feeds = {image: new Float32Array([1]), mask: new Float32Array([1])};
        const page = {results: []};
        const pixels = new Float32Array([0.5]);
        const result = kind === 'ocr' ? page : pixels;
        const gpuRun = vi.fn(async () => { trace.push('gpu-run'); throw new Error('GPU device lost'); });
        const gpu = {
            run: gpuRun,
            release: vi.fn(async () => { trace.push('gpu-release'); }),
        };
        const cpu = {
            run: vi.fn(async () => { trace.push('cpu-run'); return result; }),
            release: vi.fn(async () => undefined),
        };
        const initialized = deferred<typeof cpu>();
        mocks.create.mockResolvedValueOnce(gpu).mockImplementationOnce(() => {
            trace.push('cpu-create');
            return initialized.promise;
        });
        const create = async () => {
            const session = await mocks.session.create('gpu.onnx', {executionProviders: ['webgpu']});
            protectMangaSession(
                session,
                () => mocks.session.create('cpu.onnx', {executionProviders: ['wasm']}),
                () => undefined,
            );
            // 保留生产中的关键调用顺序：推理 pacer 包住带有 CPU 回退的 session.run。
            const run = () => resources.paceLocalInference(() => session.run(feeds));
            if (kind === 'ocr') { ocr.recognize.mockImplementation(run); return ocr; }
            painter.run.mockImplementation(run);
            return painter;
        };
        (kind === 'ocr' ? mocks.createOcr : mocks.createPainter).mockImplementationOnce(create);
        await send({requestId: 1, type: `prepare-${kind}`});
        expect(terminal()).toEqual([{requestId: 1, success: true, result: undefined}]);
        await send({requestId: 2, type: kind === 'ocr' ? 'recognize' : 'inpaint'});
        // CPU create 必须在尚未完成的推理里面启动；共用同一 pacer 会停在这里。
        expect(trace).toEqual(['gpu-run', 'gpu-release', 'cpu-create']);
        expect(mocks.create).toHaveBeenNthCalledWith(2, 'cpu.onnx', {executionProviders: ['wasm']});
        expect(mocks.initialization).toHaveBeenCalledTimes(2);
        expect(cpu.run).not.toHaveBeenCalled();
        expect(terminal()).toHaveLength(1);
        initialized.resolve(cpu);
        await flush();
        expect(trace).toEqual(['gpu-run', 'gpu-release', 'cpu-create', 'cpu-run']);
        expect(cpu.run).toHaveBeenCalledWith(feeds);
        expect(terminal()).toEqual([
            {requestId: 1, success: true, result: undefined},
            {requestId: 2, success: true, result},
        ]);
        // 回退完成后两条队列仍然可用，释放走完真实 session 装饰器。
        await resources.paceLocalInference(async () => undefined);
        await gpu.release();
        expect(cpu.release).toHaveBeenCalledOnce();
        expect(gpuRun).toHaveBeenCalledOnce();
    });

    it('同一次模型创建中的并发 Session.create 也依次执行，并保留 receiver、模型与选项', async () => {
        const firstSession = deferred<{id: string}>();
        const secondSession = deferred<{id: string}>();
        mocks.create.mockReturnValueOnce(firstSession.promise).mockReturnValueOnce(secondSession.promise);
        const options = {executionProviders: ['webgpu']};
        let first!: Promise<unknown>, second!: Promise<unknown>;
        mocks.createOcr.mockImplementationOnce(async () => {
            first = mocks.session.create('detector.onnx', options);
            second = mocks.session.create(new Uint8Array([1, 2]), {executionProviders: ['wasm']});
            await Promise.all([first, second]);
            return ocr;
        });
        await send({requestId: 1, type: 'prepare-ocr'});
        expect(mocks.create).toHaveBeenCalledOnce();
        expect(mocks.create).toHaveBeenNthCalledWith(1, 'detector.onnx', options);
        expect(mocks.create.mock.contexts[0]).toBe(mocks.session);
        expect(terminal()).toEqual([]);
        firstSession.resolve({id: 'detector'});
        await flush();
        expect(mocks.create).toHaveBeenCalledTimes(2);
        expect(mocks.create).toHaveBeenNthCalledWith(2, new Uint8Array([1, 2]), {executionProviders: ['wasm']});
        secondSession.resolve({id: 'recognizer'});
        await expect(first).resolves.toEqual({id: 'detector'});
        await expect(second).resolves.toEqual({id: 'recognizer'});
        await flush();
        expect(terminal()).toEqual([{requestId: 1, success: true, result: undefined}]);
    });

    it('Session 初始化拒绝仍释放锁，第二个初始化与后续 Worker 消息可以完成', async () => {
        const failed = deferred<unknown>();
        mocks.create.mockReturnValueOnce(failed.promise).mockResolvedValueOnce({id: 'recovered'});
        let sessionResults!: Promise<PromiseSettledResult<unknown>[]>;
        mocks.createOcr.mockImplementationOnce(async () => {
            sessionResults = Promise.allSettled([
                mocks.session.create('broken.onnx'),
                mocks.session.create('healthy.onnx'),
            ]);
            const [first] = await sessionResults;
            if (first.status === 'rejected') throw first.reason;
            return ocr;
        });
        await send({requestId: 1, type: 'prepare-ocr'});
        expect(mocks.create).toHaveBeenCalledOnce();
        failed.reject(new Error('bad session'));
        await flush();
        await expect(sessionResults).resolves.toEqual([
            {status: 'rejected', reason: expect.objectContaining({message: 'bad session'})},
            {status: 'fulfilled', value: {id: 'recovered'}},
        ]);
        expect(terminal()).toEqual([{requestId: 1, success: false, error: 'bad session'}]);
        expect(await send({requestId: 2, type: 'prepare-ocr'})).toMatchObject({success: true});
    });
});

function segSession(){
    const meta=(name:string,shape:number[])=>({name,isTensor:true,type:'float32',shape});
    return {inputNames:['images'],outputNames:['blk','seg','det'],inputMetadata:[meta('images',[1,3,1024,1024])],
        outputMetadata:[meta('blk',[1,64512,7]),meta('seg',[1,1,1024,1024]),meta('det',[1,2,1024,1024])],
        run:vi.fn(),release:vi.fn(async()=>{})};
}
function segOutput(){
    const output=(dims:number[])=>({type:'float32',dims,data:new Float32Array(dims.reduce((a,b)=>a*b,1)) as Float32Array,dispose:vi.fn()});
    return {blk:output([1,64512,7]),seg:output([1,1,1024,1024]),det:output([1,2,1024,1024])};
}
async function prepareSeg(session=segSession()){
    mocks.loadSeg.mockResolvedValue(new ArrayBuffer(3));mocks.create.mockResolvedValue(session);
    expect(await send({type:'prepare-seg',requestId:100})).toMatchObject({success:true,result:true});return session;
}

describe('可选缓存 CTD Worker 端口',()=>{
    it('缺失只报告 false，不创建会话或读取输入；缓存异常归为不可重试协议错误',async()=>{
        expect(await send({type:'prepare-seg',requestId:100})).toEqual({requestId:100,success:true,result:false});
        expect(mocks.create).not.toHaveBeenCalled();expect(mocks.inputs).toHaveLength(0);
        expect(await send({type:'segment',requestId:101})).toMatchObject({success:false,errorKind:'protocol',error:'图片分割模型未导入'});
        mocks.loadSeg.mockRejectedValueOnce(new Error('hash mismatch')).mockRejectedValueOnce('cache unavailable');
        expect(await send({type:'prepare-seg',requestId:102})).toMatchObject({errorKind:'protocol',error:'hash mismatch'});
        expect(await send({type:'prepare-seg',requestId:103})).toMatchObject({errorKind:'protocol',error:'cache unavailable'});
    });
    it('固定模型仅懒创建一次，RGB输入原buffer，seg用float32乘法截断并转移owned bytes，所有张量均释放',async()=>{
        const session=await prepareSeg(),output=segOutput();
        output.seg.data.set([0,1,.5,127.999/255,128/255,254.999/255]);session.run.mockResolvedValue(output);
        const source=new Float32Array(3*1024*1024);source[0]=.75;
        const result=await send({type:'segment',requestId:101,tensor:source});
        const seg=result!.result as Uint8Array;
        expect(Array.from(seg.subarray(0,6))).toEqual([0,255,127,127,128,254]);
        expect(seg).toHaveLength(1024*1024);expect(seg.buffer).not.toBe(output.seg.data.buffer);
        expect(session.run).toHaveBeenCalledWith({images:mocks.inputs[0]});
        expect(mocks.inputs[0].data).toBe(source);expect(mocks.inputs[0].data[0]).toBe(.75);
        expect(mocks.inputs[0].type).toBe('float32');expect(mocks.inputs[0].dims).toEqual([1,3,1024,1024]);
        for(const value of [...Object.values(output),...mocks.inputs])expect(value.dispose).toHaveBeenCalledOnce();
        expect(scope.postMessage.mock.calls.find(([message])=>message===result)![1]).toEqual([seg.buffer]);
        expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.create.mock.calls[0][1]).toEqual({executionProviders:['webgpu','wasm'],graphOptimizationLevel:'all'});
        await send({type:'dispose-seg',requestId:102});await send({type:'dispose-seg',requestId:103});
        expect(session.release).toHaveBeenCalledOnce();await prepareSeg(session);expect(mocks.create).toHaveBeenCalledTimes(2);
    });
    it('CPU 请求沿原锁后端且使用同串行 create；非Chrome URL只指向同源内置runtime',async()=>{
        vi.stubGlobal('chrome',undefined);Object.assign(scope,{location:{href:'moz-extension://fixture/mangaInferenceWorker.js'}});
        mocks.loadSeg.mockResolvedValue(new ArrayBuffer(1));const session=segSession();mocks.create.mockResolvedValue(session);
        expect(await send({type:'prepare-seg',requestId:100,cpu:true})).toMatchObject({result:true});
        expect(mocks.create.mock.calls[0][1]).toEqual({executionProviders:['wasm'],graphOptimizationLevel:'all'});
        expect((navigator as Navigator&{gpu?:unknown}).gpu).toBeUndefined();
    });
    it.each([
        ['input names',(s:ReturnType<typeof segSession>)=>{s.inputNames=[];}],
        ['output count',(s:ReturnType<typeof segSession>)=>{s.outputNames=[];}],
        ['output order',(s:ReturnType<typeof segSession>)=>{s.outputNames.reverse();}],
        ['input meta count',(s:ReturnType<typeof segSession>)=>{s.inputMetadata=[];}],
        ['input meta name',(s:ReturnType<typeof segSession>)=>{s.inputMetadata[0].name='x';}],
        ['input meta tensor',(s:ReturnType<typeof segSession>)=>{s.inputMetadata[0].isTensor=false;}],
        ['input meta dtype',(s:ReturnType<typeof segSession>)=>{s.inputMetadata[0].type='uint8';}],
        ['input meta rank',(s:ReturnType<typeof segSession>)=>{s.inputMetadata[0].shape=[];}],
        ['input meta dims',(s:ReturnType<typeof segSession>)=>{s.inputMetadata[0].shape[2]=512;}],
        ['output meta dims',(s:ReturnType<typeof segSession>)=>{s.outputMetadata[1].shape[1]=2;}],
    ] as const)('%s 不匹配立即释放未知模型，无forward',async(_name,mutate)=>{
        const session=segSession();mutate(session);mocks.loadSeg.mockResolvedValue(new ArrayBuffer(1));mocks.create.mockResolvedValue(session);
        expect(await send({type:'prepare-seg',requestId:100})).toMatchObject({success:false,errorKind:'protocol'});
        expect(session.release).toHaveBeenCalledOnce();expect(session.run).not.toHaveBeenCalled();
    });
    it.each(['absent','short','offset','shared','nan','negative','over'] as const)('%s输入不可推理，保持会话可重试',async fault=>{
        const session=await prepareSeg();let input:Float32Array|undefined=new Float32Array(3*1024*1024);
        if(fault==='absent')input=undefined;
        if(fault==='short')input=new Float32Array(1);
        if(fault==='offset')input=new Float32Array(new ArrayBuffer((3*1024*1024+1)*4),4);
        if(fault==='shared')input=new Float32Array(new SharedArrayBuffer(3*1024*1024*4));
        if(fault==='nan')input![0]=NaN;if(fault==='negative')input![0]=-.01;if(fault==='over')input![0]=1.01;
        expect(await send({type:'segment',requestId:101,tensor:input})).toMatchObject({success:false,errorKind:'protocol'});
        expect(session.run).not.toHaveBeenCalled();expect(mocks.inputs).toHaveLength(0);
    });
    it.each(['missing','extra','dtype','shape','data','length','nan','negative','over'] as const)('%s输出保留失败且释放unused blk/det和输入',async fault=>{
        const session=await prepareSeg(),outputs=segOutput(),originals=Object.values(outputs);
        if(fault==='missing')delete (outputs as Partial<typeof outputs>).seg;
        if(fault==='extra')Object.assign(outputs,{other:{...outputs.seg,dispose:vi.fn()}});
        if(fault==='dtype')outputs.seg.type='uint8';if(fault==='shape')outputs.seg.dims=[1,1,512,2048];
        if(fault==='data')outputs.seg.data=new Uint8Array(1024*1024) as unknown as Float32Array;
        if(fault==='length')outputs.seg.data=new Float32Array(2);
        if(fault==='nan')outputs.seg.data[0]=NaN;if(fault==='negative')outputs.seg.data[0]=-.1;if(fault==='over')outputs.seg.data[0]=1.1;
        session.run.mockResolvedValue(outputs);
        expect(await send({type:'segment',requestId:101,tensor:new Float32Array(3*1024*1024)})).toMatchObject({success:false,errorKind:'protocol'});
        expect(mocks.inputs[0].dispose).toHaveBeenCalledOnce();
        for(const value of Object.values(outputs))expect(value.dispose).toHaveBeenCalledOnce();
        if(fault==='missing')expect(originals[1].dispose).not.toHaveBeenCalled(); // ORT 未返回的对象不是 worker 所有。
    });
    it('run首因不被dispose故障覆盖，其他输出仍释放；成功后的清理故障也不可发布',async()=>{
        const session=await prepareSeg(),source=new Float32Array(3*1024*1024);
        session.run.mockRejectedValueOnce(new Error('native run'));
        expect(await send({type:'segment',requestId:101,tensor:source})).toMatchObject({errorKind:'execution',error:'native run'});
        expect(mocks.inputs[0].dispose).toHaveBeenCalledOnce();
        const output=segOutput();output.seg.data[0]=NaN;output.blk.dispose.mockImplementationOnce(()=>{throw new Error('dispose secondary');});session.run.mockResolvedValueOnce(output);
        expect(await send({type:'segment',requestId:102,tensor:source})).toMatchObject({errorKind:'protocol',error:'图片分割概率无效'});
        expect(output.det.dispose).toHaveBeenCalledOnce();
        const valid=segOutput();valid.blk.dispose.mockImplementationOnce(()=>{throw new Error('dispose primary');});session.run.mockResolvedValueOnce(valid);
        expect(await send({type:'segment',requestId:103,tensor:source})).toMatchObject({errorKind:'execution',error:'dispose primary'});expect(valid.det.dispose).toHaveBeenCalledOnce();
    });
});

it('缺失元数据必须协议拒绝；清理多故障也保留首个undefined并释放其余张量',async()=>{
    const unknown=segSession();unknown.release.mockRejectedValueOnce(new Error('release secondary'));Object.assign(unknown,{inputMetadata:undefined});mocks.loadSeg.mockResolvedValue(new ArrayBuffer(1));mocks.create.mockResolvedValueOnce(unknown);
    expect(await send({type:'prepare-seg',requestId:99})).toMatchObject({errorKind:'protocol'});expect(unknown.release).toHaveBeenCalledOnce();
    const session=await prepareSeg(),output=segOutput();output.blk.dispose.mockImplementationOnce(()=>{throw undefined;});output.seg.dispose.mockImplementationOnce(()=>{throw new Error('secondary');});session.run.mockResolvedValue(output);
    expect(await send({type:'segment',requestId:101,tensor:new Float32Array(3*1024*1024)})).toMatchObject({errorKind:'execution',error:'undefined'});expect(output.det.dispose).toHaveBeenCalledOnce();
});
