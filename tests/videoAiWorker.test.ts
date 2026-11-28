import {describe, expect, it, vi} from 'vitest';
import {isDegenerateVideoTranscript} from '@/src/features/video-subtitle/transcription';
import {parseWhisperChunkTimestamps} from '@/src/features/video-subtitle/offscreen/timestampParser';
import {buildWhisperTranscriptionGenerationOptions, chooseWhisperSourceLanguage, normalizeWhisperSourceLanguage} from '@/src/features/video-subtitle/offscreen/transcriptionOptions';

const workerMocks = vi.hoisted(() => {
    class FakeTensor {
        readonly data: Float32Array | BigInt64Array;
        readonly dims: number[];
        disposed = false;
        constructor(_type: string, data: Float32Array | BigInt64Array, dims: number[]) {
            this.data = data;
            this.dims = dims;
        }
        dispose(): void { this.disposed = true; }
    }
    class FakeStoppingCriteria {
        interrupted = false;
        interrupt(): void { this.interrupted = true; }
    }
    return {
        env: {version: '3.8.1' as string | undefined, backends: {onnx: {wasm: {}}}},
        InterruptableStoppingCriteria: FakeStoppingCriteria,
        Tensor: FakeTensor,
        pipeline: vi.fn(),
    };
});

vi.mock('@huggingface/transformers', () => ({...workerMocks,
    pipeline: async (...args: unknown[]) => {
        const transcriber = await workerMocks.pipeline(...args);
        transcriber.model ||= {};
        transcriber.model.config ||= {};
        transcriber.model.config.model_type ||= 'whisper';
        transcriber.model._get_stopping_criteria ||= () => {
            const criteria: unknown[] = [];
            return {criteria, push(item: unknown) {criteria.push(item);}};
        };
        return transcriber;
    },
}));
const wasmMocks = vi.hoisted(() => ({
    assertOnnxWasmRuntimeSupported: vi.fn(),
    configureOnnxWasmBackend: vi.fn(),
    withCompressedWasmBinary: (_backend: unknown, _url: string, initialize: () => Promise<unknown>) => initialize(),
}));

vi.mock('@/src/shared/onnx/wasmBinary', async () => {
    const actual = await vi.importActual<typeof import('@/src/shared/onnx/wasmBinary')>('@/src/shared/onnx/wasmBinary');
    return {...actual, ...wasmMocks};
});
const webGpuMocks = vi.hoisted(() => ({
    probeWebGpu: vi.fn(async () => ({available: false, info: ''})),
}));

vi.mock('@/src/shared/onnx/webgpu', () => webGpuMocks);
const modelCacheMocks = vi.hoisted(() => ({
    cacheVideoAiQ8ModelFiles: vi.fn(async () => undefined),
    createVideoAiModelCache: vi.fn(async (): Promise<any> => ({cache: {}, localCache: {}})),
}));
vi.mock('@/src/features/video-subtitle/offscreen/modelCache', () => ({
    VIDEO_AI_MODEL_REMOTE_HOST: 'https://modelscope.cn',
    VIDEO_AI_MODEL_REMOTE_PATH_TEMPLATE: 'models/{model}/resolve/{revision}/',
    ...modelCacheMocks,
}));

function createWorkerScope(): Record<string, any> {
    return {
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        location: {href: 'chrome-extension://test/worker.js'},
    };
}

async function waitForWorkerMessages(scope: Record<string, any>, count: number): Promise<void> {
    for (let index = 0; index < 30 && scope.postMessage.mock.calls.length < count; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

async function loadProtocolWorker(transcriber: any, backend: 'webgpu' | 'wasm' = 'wasm') {
    vi.resetModules();
    const scope = createWorkerScope();
    vi.stubGlobal('self', scope);
    vi.stubGlobal('navigator', {hardwareConcurrency: 1});
    webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: backend === 'webgpu', info: 'native GPU'});
    workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
    (await import('@/src/app/offscreen/videoTranscriptionWorker')).startVideoTranscriptionWorkerApp();
    return scope;
}

describe('视频 AI Worker timestamp parser', () => {
    it('语言检测在部分语言 token 为非有限值时保留有效候选并归一化置信度', () => {
        expect(chooseWhisperSourceLanguage({data: new Float32Array([1, NaN, Infinity]), dims: [1, 1, 3]},
            {isMultilingual: true, langToId: {'<|en|>': 0, '<|ja|>': 1, '<|ko|>': 2}}))
            .toEqual({language: 'en', confidence: 1});
    });
    it('continues its single-consumer queue after a detached response port rejects both replies for a task', async () => {
        const scope=await loadProtocolWorker(vi.fn());
        try {
            scope.postMessage.mockImplementationOnce(()=>{throw new Error('success channel closed');}).mockImplementationOnce(()=>{throw new Error('error channel closed');});
            scope.onmessage({data:{requestId:1,type:'prepare',model:'tiny'}});
            await waitForWorkerMessages(scope,2);expect(scope.postMessage).toHaveBeenCalledTimes(2);
            scope.onmessage({data:{requestId:2,type:'prepare',model:'tiny'}});
            await waitForWorkerMessages(scope,3);expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({requestId:2,success:true}));
            expect(workerMocks.pipeline).toHaveBeenCalledOnce();
        } finally {vi.unstubAllGlobals();}
    });
    it('gives Transformers the shared cache while disabling duplicate browser and filesystem writes', async () => {
        const cache = {match: vi.fn(), put: vi.fn()};
        modelCacheMocks.createVideoAiModelCache.mockResolvedValueOnce({cache, localCache: {}, sharedCache: cache});
        const scope = await loadProtocolWorker(vi.fn());
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare', model: 'tiny'}});
            await waitForWorkerMessages(scope, 1);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model: 'tiny'}));
            expect(workerMocks.env).toMatchObject({useCustomCache: true, customCache: cache, useBrowserCache: false, useFSCache: false});
        } finally {vi.unstubAllGlobals();}
    });
    it('rejects a malformed correlated command before loading a model and still accepts a later valid preparation', async () => {
        const scope = await loadProtocolWorker(vi.fn());
        try {
            for (const value of [null, {}, {requestId: 0}, {requestId: NaN}]) scope.onmessage({data: value});
            expect(scope.postMessage).not.toHaveBeenCalled();
            scope.onmessage({data: {requestId: 1, type: 'transcribe', audio: new Uint8Array(4)}});
            expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: expect.stringContaining('消息格式无效')});
            expect(workerMocks.pipeline).not.toHaveBeenCalled();
            scope.onmessage({data: {requestId: 2, type: 'prepare', model: 'tiny'}});
            await waitForWorkerMessages(scope, 2);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({requestId: 2, success: true, model: 'tiny', backend: 'wasm'}));
            expect(workerMocks.pipeline).toHaveBeenCalledOnce();
        } finally {vi.unstubAllGlobals();}
    });
    it('忽略不属于识别协议的消息，未加载模型也能dispose，缺少音频返回数字静音', async () => {
        const scope = await loadProtocolWorker(vi.fn());
        try {
            scope.onmessage({data: null});
            scope.onmessage({data: {requestId: 'foreign'}});
            const listener = scope.addEventListener.mock.calls[0][1];
            listener({});
            listener({data: {type: 'other'}});
            scope.onmessage({data: {type: 'dispose'}});
            listener({data: {type: 'dispose'}});
            scope.onmessage({data: {requestId: 1, type: 'transcribe'}});
            await waitForWorkerMessages(scope, 1);
            expect(workerMocks.pipeline).not.toHaveBeenCalled();
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: '', segments: [], inferenceMs: 0, audioDurationMs: 0}));
            expect(scope.postMessage.mock.calls[0][0].backend).toBeUndefined();
        } finally {vi.unstubAllGlobals();}
    });

    it('超过30秒的输入只进入一个受限窗，清理静音标记和非字符串输出', async () => {
        const transcriber = vi.fn(async (_audio: Float32Array) => ({text: 42, chunks: [{text: '[blank_audio]', timestamp: [0, 1]}]}));
        const scope = await loadProtocolWorker(transcriber);
        try {
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'base', sourceLanguage: 'en', audio: new Float32Array(500_000).fill(.04)}});
            await waitForWorkerMessages(scope, 1);
            expect(transcriber.mock.calls[0][0]).toHaveLength(480_000);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: '', segments: [], audioDurationMs: 30_000}));
        } finally {vi.unstubAllGlobals();}
    });

    it.each([undefined, null, {text: 'A complete original phrase.'}])('流水线无时间戳或空结果时保持明确空片段输出：%s', async output => {
        const scope = await loadProtocolWorker(vi.fn(async () => output));
        try {
            scope.onmessage({data: {requestId: 1, type: 'transcribe', sourceLanguage: 'en', audio: new Float32Array(16_000).fill(.04)}});
            await waitForWorkerMessages(scope, 1);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: output?.text || '', segments: []}));
        } finally {vi.unstubAllGlobals();}
    });

    it.each(['no-processor', 'nonmultilingual', 'unsafe-start', 'no-logits'])('auto模型缺少检测能力时明确失败、不生成错误语言字幕：%s', async failure => {
        const feature = new workerMocks.Tensor('float32', new Float32Array([.1]), [1]);
        const transcriber: any = vi.fn();
        transcriber.processor = vi.fn(async () => ({input_features: feature}));
        transcriber.model = vi.fn(async () => ({}));
        transcriber.model.config = {is_multilingual: true, decoder_start_token_id: failure === 'unsafe-start' ? .5 : 0};
        transcriber.model.generation_config = {lang_to_id: {'<|en|>': 1}};
        if (failure === 'no-processor') delete transcriber.processor;
        if (failure === 'nonmultilingual') transcriber.model.config.is_multilingual = false;
        const scope = await loadProtocolWorker(transcriber);
        try {
            scope.onmessage({data: {requestId: 1, type: 'transcribe', sourceLanguage: 'auto', audio: new Float32Array(16_000).fill(.04)}});
            await waitForWorkerMessages(scope, 1);
            expect(transcriber).not.toHaveBeenCalled();
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: failure === 'no-logits' ? 'Whisper 首步没有可用的语言 token logits' : expect.stringContaining('无法自动检测')}));
            expect(feature.disposed).toBe(failure === 'no-logits');
        } finally {vi.unstubAllGlobals();}
    });

    it.each(['webgpu', 'wasm'] as const)('没有WASM配置时仍执行当前后端，Chrome URL与本地URL分别正确：%s', async backend => {
        const previous = workerMocks.env.backends.onnx.wasm;
        workerMocks.env.backends.onnx.wasm = undefined as any;
        const getURL = vi.fn((value: string) => `chrome-extension://owned/${value}`);
        vi.stubGlobal('chrome', {runtime: {getURL}});
        const scope = await loadProtocolWorker(vi.fn(async () => ({text: '[silence]'})), backend);
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare', model: 'base'}});
            await waitForWorkerMessages(scope, 1);
            scope.onmessage({data: {requestId: 2, type: 'prepare', model: 'base', device: backend === 'wasm' ? 'wasm' : undefined}});
            await waitForWorkerMessages(scope, 2);
            expect(workerMocks.pipeline).toHaveBeenCalledOnce();
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, backend}));
        } finally {workerMocks.env.backends.onnx.wasm = previous;vi.unstubAllGlobals();}
    });

    it('Chrome资产URL不依赖Worker location，模型切换清理失败仍能加载下一模型', async () => {
        const base: any = vi.fn(async () => ({text: 'One original sentence.'}));
        base.dispose = vi.fn(async () => {throw new Error('old session cleanup failed');});
        const scope = await loadProtocolWorker(base);
        vi.stubGlobal('chrome', {runtime: {getURL: vi.fn(path => 'chrome-extension://owned/' + path)}});
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare', model: 'base'}});
            await waitForWorkerMessages(scope, 1);
            workerMocks.pipeline.mockResolvedValue(vi.fn(async () => ({text: 'Another original sentence.'})));
            scope.onmessage({data: {requestId: 2, type: 'prepare', model: 'tiny', device: 'wasm'}});
            await waitForWorkerMessages(scope, 2);
            scope.onmessage({data: {requestId: 3, type: 'prepare', model: 'tiny', device: 'wasm'}});
            await waitForWorkerMessages(scope, 3);
            expect(base.dispose).toHaveBeenCalledOnce();
            expect(workerMocks.pipeline).toHaveBeenCalledTimes(2);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model: 'tiny'}));
            expect((globalThis as any).chrome.runtime.getURL).toHaveBeenCalledWith(expect.stringContaining('ort-wasm'));
        } finally {vi.unstubAllGlobals();}
    });

    it('dispose清理失败保留错误诊断，后续消息仍能初始化新的模型', async () => {
        const transcriber: any = vi.fn();
        transcriber.dispose = vi.fn(async () => {throw new Error('dispose rejected');});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const scope = await loadProtocolWorker(transcriber);
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare'}});
            await waitForWorkerMessages(scope, 1);
            scope.addEventListener.mock.calls[0][1]({data: {type: 'dispose'}});
            scope.onmessage({data: {requestId: 2, type: 'prepare'}});
            await waitForWorkerMessages(scope, 2);
            expect(transcriber.dispose).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith('[FluentRead] Worker 释放本地视频模型失败', expect.objectContaining({message: 'dispose rejected'}));
            expect(workerMocks.pipeline).toHaveBeenCalledTimes(2);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true}));
        } finally {warn.mockRestore();vi.unstubAllGlobals();}
    });

    it('CPU初始化抛出非Error也保留明确消息，隔离多线程失败提示fresh单线程恢复', async () => {
        const scope = await loadProtocolWorker(vi.fn());
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        vi.stubGlobal('crossOriginIsolated', true);
        workerMocks.pipeline.mockRejectedValue('CPU initialization failed');
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare'}});
            await waitForWorkerMessages(scope, 1);
            expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'CPU initialization failed', retryWithCpu: true});
        } finally {vi.unstubAllGlobals();}
    });

    it.each(['absent', 'success', 'failure'])('GPU初始化诊断抛错时恢复owner边界，清理行为明确：%s', async cleanup => {
        const transcriber: any = vi.fn();
        if (cleanup !== 'absent') transcriber.dispose = vi.fn(async () => {
            if (cleanup === 'failure') throw new Error('GPU cleanup failed');
        });
        const info = vi.spyOn(console, 'info').mockImplementationOnce(() => {throw 'GPU diagnostic failed';});
        const scope = await loadProtocolWorker(transcriber, 'webgpu');
        try {
            scope.onmessage({data: {requestId: 1, type: 'prepare'}});
            await waitForWorkerMessages(scope, 1);
            if (cleanup !== 'absent') expect(transcriber.dispose).toHaveBeenCalledOnce();
            expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'GPU diagnostic failed', retryWithCpu: true});
        } finally {info.mockRestore();vi.unstubAllGlobals();}
    });

    it('GPU生成超时拒绝部分结果并释放模型，给freshCPU恢复而非提交字幕', async () => {
        vi.useFakeTimers();
        const transcriber = vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return {text: 'Incomplete phrase.', chunks: []};
        });
        const scope = await loadProtocolWorker(transcriber, 'webgpu');
        scope.setTimeout = (fn: () => void) => setTimeout(fn, 1);
        try {
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'tiny', sourceLanguage: 'en', audio: new Float32Array(16_000).fill(.04)}});
            await vi.advanceTimersByTimeAsync(10);
            expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: '本地视频 AI 推理超过 15 秒', retryWithCpu: true});
        } finally {vi.useRealTimers();vi.unstubAllGlobals();}
    });
    it.each(['webgpu', 'wasm'])('Small 使用独立真实模型 ID 和固定混合精度，暖调用及模型切换诊断准确：%s', async backend => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: backend === 'webgpu', info: 'native GPU'});
        const small: any = vi.fn(async () => ({text: 'A quality subtitle.', chunks: []}));
        small.dispose = vi.fn(async () => undefined);
        const base = vi.fn(async () => ({text: 'A standard subtitle.', chunks: []}));
        workerMocks.pipeline.mockReset().mockResolvedValueOnce(small).mockResolvedValueOnce(base);
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'prepare', model: 'small'}});
        await waitForWorkerMessages(scope, 1);
        expect(workerMocks.pipeline).toHaveBeenCalledWith('automatic-speech-recognition', 'onnx-community/whisper-small', expect.objectContaining({
            device: backend, dtype: {encoder_model: 'fp32', decoder_model_merged: 'q4'},
            session_options: {enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential'},
        }));
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model: 'small', backend, dtype: 'q4', encoderDtype: 'fp32', decoderDtype: 'q4'}));
        scope.onmessage({data: {requestId: 2, type: 'prepare', model: 'small'}});
        await waitForWorkerMessages(scope, 2);
        scope.onmessage({data: {requestId: 3, type: 'transcribe', model: 'small', sourceLanguage: 'en', audio: new Float32Array(16_000).fill(.04)}});
        await waitForWorkerMessages(scope, 3);
        expect(workerMocks.pipeline).toHaveBeenCalledOnce();
        expect(small).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({language: 'en', max_new_tokens: 440}));
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model: 'small', encoderDtype: 'fp32', decoderDtype: 'q4'}));
        expect(scope.postMessage.mock.calls[2][0].detectedLanguage).toBeUndefined();
        scope.onmessage({data: {requestId: 4, type: 'prepare', model: 'base'}});
        await waitForWorkerMessages(scope, 4);
        expect(small.dispose).toHaveBeenCalledOnce();
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model: 'base', encoderDtype: 'q4', decoderDtype: 'q4'}));
        // A silent Small request has not loaded Small and must not attribute Base's held session to it.
        scope.onmessage({data: {requestId: 5, type: 'transcribe', model: 'small', audio: new Float32Array(16_000)}});
        await waitForWorkerMessages(scope, 5);
        expect(scope.postMessage.mock.calls[4][0].encoderDtype).toBeUndefined();
        expect(scope.postMessage.mock.calls[4][0].decoderDtype).toBeUndefined();
        vi.unstubAllGlobals();
    });

    it('Small WASM 混合精度初始化失败时不另下载全 q8 权重', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
        modelCacheMocks.cacheVideoAiQ8ModelFiles.mockClear();
        workerMocks.pipeline.mockReset().mockRejectedValue(new Error('Small mixed session failed'));
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'prepare', model: 'small'}});
        await waitForWorkerMessages(scope, 1);
        expect(workerMocks.pipeline).toHaveBeenCalledOnce();
        expect(modelCacheMocks.cacheVideoAiQ8ModelFiles).not.toHaveBeenCalled();
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'Small mixed session failed'});
        vi.unstubAllGlobals();
    });

    it('Small 使用独立六十秒生成停止预算，中断循环后恢复 hook 并拒绝未完成结果', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const scope = createWorkerScope();
            const configuredTimeouts: number[] = [];
            scope.setTimeout = (callback: () => void, milliseconds: number) => {
                configuredTimeouts.push(milliseconds);
                return setTimeout(callback, milliseconds === 60_000 ? 4 : milliseconds);
            };
            vi.stubGlobal('self', scope);
            vi.stubGlobal('navigator', {hardwareConcurrency: 1});
            webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
            let iterations = 0;
            const originalHook = () => {
                const criteria: any[] = [];
                return {criteria, push(item: unknown) {criteria.push(item);}};
            };
            const transcriber: any = vi.fn(async (_audio, options) => {
                const list = transcriber.model._get_stopping_criteria({max_length: 443});
                expect(list.criteria).toContain(options.stopping_criteria);
                while (iterations < 440 && !list.criteria.some((criterion: any) => criterion.interrupted)) {
                    await new Promise(resolve => setTimeout(resolve, 2));
                    iterations++;
                }
                return {text: 'Incomplete output.', chunks: []};
            });
            transcriber.model = {config: {model_type: 'whisper'}, _get_stopping_criteria: originalHook};
            workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
            (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'small', sourceLanguage: 'en', audio: new Float32Array(16_000).fill(.04)}});
            await vi.advanceTimersByTimeAsync(30);
            expect(configuredTimeouts).toEqual([60_000]);
            expect(iterations).toBeGreaterThan(0);
            expect(iterations).toBeLessThan(440);
            expect(transcriber.model._get_stopping_criteria).toBe(originalHook);
            expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: '本地视频 AI 推理超过 60 秒'});
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it.each(['tiny', 'base'])('旧模型的 WASM q8 恢复保留原优化器和真实双模块精度：%s', async model => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
        modelCacheMocks.cacheVideoAiQ8ModelFiles.mockClear();
        workerMocks.pipeline.mockReset().mockRejectedValueOnce(new Error('q4 failed')).mockResolvedValueOnce(vi.fn());
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'prepare', model}});
        await waitForWorkerMessages(scope, 1);
        expect(modelCacheMocks.cacheVideoAiQ8ModelFiles).toHaveBeenCalledWith(model);
        expect(workerMocks.pipeline).toHaveBeenLastCalledWith('automatic-speech-recognition', 'onnx-community/whisper-' + model, expect.objectContaining({
            device: 'wasm', dtype: 'q8', session_options: expect.objectContaining({extra: {optimization: {disable_specified_optimizers: 'QDQSelectorActionTransformer'}}}),
        }));
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, model, backend: 'wasm', dtype: 'q8', encoderDtype: 'q8', decoderDtype: 'q8'}));
        vi.unstubAllGlobals();
    });

    it.each(['explicit', 'auto-fallback', 'auto-shared'])('请求计时器中断实际生成循环并恢复停止 hook：%s', async mode => {
        vi.resetModules();
        vi.useFakeTimers();
        try {
            const scope = createWorkerScope();
            scope.setTimeout = (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds === 15_000 ? 4 : milliseconds);
            vi.stubGlobal('self', scope);
            vi.stubGlobal('navigator', {hardwareConcurrency: 1});
            workerMocks.env.version = '3.8.1';
            webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
            let iterations = 0;
            const originalHook = vi.fn(() => {
                const criteria: any[] = [];
                return {criteria, push(item: unknown) {criteria.push(item);}};
            });
            const transcriber: any = vi.fn(async (_audio, options) => {
                const list = transcriber.model._get_stopping_criteria({max_length: 443});
                expect(list.criteria).toContain(options.stopping_criteria);
                while (iterations < 440 && !list.criteria.some((criterion: any) => criterion.interrupted)) {
                    await new Promise(resolve => setTimeout(resolve, 2));
                    iterations++;
                }
                return {text: 'Unfinished temporary result.', chunks: []};
            });
            transcriber.processor = vi.fn(async () => ({input_features: new workerMocks.Tensor('float32', new Float32Array([0]), [1, 80, 3000])}));
            transcriber.model = vi.fn(async () => ({logits: new workerMocks.Tensor('float32', new Float32Array([0, 8, 1]), [1, 1, 3])}));
            transcriber.model.config = {model_type: 'whisper', is_encoder_decoder: true, is_multilingual: true, decoder_start_token_id: 0};
            transcriber.model.generation_config = {lang_to_id: {'<|en|>': 1, '<|zh|>': 2}};
            transcriber.model._get_stopping_criteria = originalHook;
            if (mode === 'auto-shared') {
                transcriber.model.main_input_name = 'input_features';
                transcriber.model.forward_params = ['input_features', 'decoder_input_ids'];
                transcriber.model._prepare_encoder_decoder_kwargs_for_generation = vi.fn(async () => ({encoder_outputs: new workerMocks.Tensor('float32', new Float32Array([0]), [1, 1500, 384])}));
            }
            workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
            (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'tiny', sourceLanguage: mode === 'explicit' ? 'en' : 'auto', audio: new Float32Array(48_000).fill(.04)}});
            await vi.advanceTimersByTimeAsync(30);
            expect(iterations).toBeGreaterThan(0);
            expect(iterations).toBeLessThan(440);
            expect(transcriber).toHaveBeenCalledTimes(1);
            expect(originalHook).toHaveBeenCalledOnce();
            expect(transcriber.model._get_stopping_criteria).toBe(originalHook);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: '本地视频 AI 推理超过 15 秒'}));
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
    it('数字静音直接返回空字幕，不初始化模型或检测语言', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset();
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'transcribe', sourceLanguage: 'auto', audio: new Float32Array(160_000)}});
        await waitForWorkerMessages(scope, 1);
        expect(workerMocks.pipeline).not.toHaveBeenCalled();
        expect(webGpuMocks.probeWebGpu).not.toHaveBeenCalled();
        expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({success: true, text: '', segments: [], inferenceMs: 0, audioDurationMs: 10_000}));
        vi.unstubAllGlobals();
    });

    it.each([true, false])('裁剪长静音后恢复字幕绝对窗口位置（有 timestamp：%s）', async (withTimestamps) => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
        const transcriber = vi.fn(async (_audio: Float32Array, _options: Record<string, unknown>) => ({text: 'A complete sentence.', chunks: withTimestamps ? [{timestamp: [.16, 1.16], text: 'A complete sentence.'}] : []}));
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        const audio = new Float32Array(5 * 16_000);
        audio.fill(.04, 2 * 16_000, 3 * 16_000);
        scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'tiny', sourceLanguage: 'en', audio}});
        await waitForWorkerMessages(scope, 1);
        expect(transcriber.mock.calls[0][0].length).toBe(1320 * 16);
        expect(transcriber.mock.calls[0][1]).toMatchObject({max_new_tokens: 30, language: 'en'});
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            success: true, audioDurationMs: 5000,
            segments: [{startMs: withTimestamps ? 2000 : 1840, endMs: withTimestamps ? 3000 : 3160, text: 'A complete sentence.'}],
        }));
        vi.unstubAllGlobals();
    });

    it('兼容路径逐窗调用 Whisper 首步 logits，两个相同语种窗后仍检测同一流的切换', async () => {
        vi.resetModules();
        const scope: Record<string, any> = {
            setTimeout,
            clearTimeout,
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
            location: {href: 'chrome-extension://test/worker.js'},
        };
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        workerMocks.pipeline.mockReset();
        const detectionTensors: any[] = [];
        const modelCalls: any[] = [];
        const transcribeCalls: any[] = [];
        const transcriber: any = vi.fn(async (_audio: Float32Array, options: Record<string, unknown>) => {
            transcribeCalls.push(options);
            return {text: options.language === 'ko' ? '한국어' : 'English', chunks: []};
        });
        transcriber.processor = vi.fn(async () => {
            const feature = new workerMocks.Tensor('float32', new Float32Array([0]), [1]);
            detectionTensors.push(feature);
            return {input_features: feature};
        });
        transcriber.model = vi.fn(async (inputs: Record<string, any>) => {
            modelCalls.push(inputs);
            const language = modelCalls.length <= 2 ? 'ko' : 'en';
            const logits = new workerMocks.Tensor('float32', new Float32Array([0, language === 'ko' ? 1 : 9, language === 'ko' ? 8 : 1]), [1, 1, 3]);
            detectionTensors.push(logits);
            return {logits};
        });
        transcriber.model.config = {is_multilingual: true, decoder_start_token_id: 0};
        transcriber.model.generation_config = {
            is_multilingual: true,
            decoder_start_token_id: 0,
            lang_to_id: {'<|en|>': 1, '<|ko|>': 2},
        };
        transcriber.dispose = vi.fn(async () => undefined);
        workerMocks.pipeline.mockResolvedValue(transcriber);
        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        expect(wasmMocks.configureOnnxWasmBackend).toHaveBeenCalledWith(
            workerMocks.env.backends.onnx.wasm,
            expect.objectContaining({
                mjs: expect.stringContaining('ort-wasm-simd-threaded.jspi.mjs'),
                wasm: expect.stringContaining('ort-wasm-simd-threaded.jspi.wasm'),
            }),
        );
        const send = (requestId: number, languageSessionKey: string) => scope.onmessage?.({data: {
            requestId, type: 'transcribe', model: 'tiny', sourceLanguage: 'auto', languageSessionKey,
            audio: new Float32Array(48_000).fill(0.04),
        }});
        send(1, 'stream-ko');
        for (let index = 0; index < 10 && scope.postMessage.mock.calls.length < 1; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
        send(2, 'stream-ko');
        for (let index = 0; index < 10 && scope.postMessage.mock.calls.length < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
        send(3, 'stream-ko');
        for (let index = 0; index < 10 && scope.postMessage.mock.calls.length < 3; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
        for (let index = 0; index < 16; index += 1) {
            send(10 + index, `stream-${index}`);
            for (let attempt = 0; attempt < 10 && scope.postMessage.mock.calls.length < 4 + index; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        send(30, 'stream-ko');
        for (let index = 0; index < 10 && scope.postMessage.mock.calls.length < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
        expect(modelCalls).toHaveLength(20);
        expect(modelCalls[0].decoder_input_ids.data[0]).toBe(0n);
        expect(transcribeCalls.slice(0, 3).map((call) => call.language)).toEqual(['ko', 'ko', 'en']);
        expect(transcribeCalls.at(-1)?.language).toBe('en');
        expect(scope.postMessage.mock.calls[2][0]).toMatchObject({detectedLanguage: 'en', languageConfidence: expect.any(Number), encoderReuse: false});
        expect(detectionTensors.every((tensor) => tensor.disposed)).toBe(true);
        vi.unstubAllGlobals();
    });

    it('短窗与低置信度如实回传，后续每窗继续检测；显式中文跳过检测', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const transcriber: any = vi.fn(async (_audio, options) => ({text: options.language === 'zh' ? '我挟天子以令诸侯。' : 'uncertain', chunks: []}));
        transcriber.processor = vi.fn(async () => ({input_features: new workerMocks.Tensor('float32', new Float32Array([0]), [1])}));
        const logits = [[0, 1.1, 1], [0, 0, 9], [0, 0, 9]];
        transcriber.model = vi.fn(async () => ({logits: new workerMocks.Tensor('float32', new Float32Array(logits.shift() || [0, 0, 9]), [1, 1, 3])}));
        transcriber.model.config = {is_multilingual: true, decoder_start_token_id: 0};
        transcriber.model.generation_config = {lang_to_id: {'<|en|>': 1, '<|zh|>': 2}};
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        for (let requestId = 1; requestId <= 4; requestId += 1) {
            scope.onmessage({data: {requestId, type: 'transcribe', model: 'tiny', sourceLanguage: 'auto', languageSessionKey: 'chinese', audio: new Float32Array(64_000).fill(0.04)}});
            await waitForWorkerMessages(scope, requestId);
        }
        expect(transcriber.model).toHaveBeenCalledTimes(4);
        expect(transcriber.mock.calls.map((call: any[]) => call[1].language)).toEqual(['en', 'zh', 'zh', 'zh']);
        scope.onmessage({data: {requestId: 5, type: 'transcribe', model: 'tiny', sourceLanguage: 'zh-Hans', audio: new Float32Array(64_000).fill(0.04)}});
        await waitForWorkerMessages(scope, 5);
        expect(transcriber.model).toHaveBeenCalledTimes(4);
        expect(transcriber.mock.calls.at(-1)[1]).toMatchObject({language: 'zh', task: 'transcribe', no_repeat_ngram_size: 8});
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: '我挟天子以令诸侯。'}));
        expect(scope.postMessage.mock.calls[0][0].languageConfidence).toBeLessThan(.8);
        expect(scope.postMessage.mock.calls[4][0].detectedLanguage).toBeUndefined();
        vi.unstubAllGlobals();
    });

    it.each(['success', 'success-fallback', 'decoder-failure', 'detection-failure', 'detection-cleanup-failure', 'output-cleanup-failure', 'generation-cleanup-failure', 'feature-cleanup-failure'])('3.8.1 特征与编码只属于当前请求，恢复实例属性并释放张量（%s）', async outcome => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        workerMocks.env.version = '3.8.1';
        const tensors: any[] = [];
        const shared = new workerMocks.Tensor('float32', new Float32Array([.1]), [1, 1500, 384]);
        if (outcome === 'detection-cleanup-failure' || outcome === 'generation-cleanup-failure') vi.spyOn(shared, 'dispose').mockImplementation(() => {
            shared.disposed = true;
            throw new Error('encoder cleanup failure');
        });
        let decoderInput: any;
        const forwardParams = ['input_features', 'decoder_input_ids'];
        const transcriber: any = vi.fn(async (_audio, options) => {
            expect(options.encoder_outputs).toBe(shared);
            expect(transcriber.model.forward_params).toEqual([...forwardParams, 'encoder_outputs']);
            expect(shared.disposed).toBe(false);
            expect(tensors[0].disposed).toBe(outcome === 'success-fallback');
            const processed = await transcriber.processor(_audio);
            expect(processed.input_features.disposed).toBe(false);
            if (outcome === 'decoder-failure') throw new Error('decoder failure');
            await new Promise(resolve => setTimeout(resolve, 3));
            return {text: 'A new sentence.', chunks: [{timestamp: [0, 1], text: 'A new sentence.'}]};
        });
        transcriber.processor = vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 3));
            const feature = new workerMocks.Tensor('float32', new Float32Array([0]), [1, 80, 3000]);
            const disposal = vi.spyOn(feature, 'dispose');
            if (outcome === 'feature-cleanup-failure') disposal.mockImplementation(() => {
                feature.disposed = true;
                throw new Error('feature cleanup failure');
            });
            tensors.push(feature);
            return {input_features: feature};
        });
        const originalProcessor = transcriber.processor;
        if (outcome !== 'success-fallback' && outcome !== 'feature-cleanup-failure') transcriber.processor.feature_extractor = {config: {sampling_rate: 16_000, chunk_length: 30, hop_length: 160}};
        transcriber.model = vi.fn(async inputs => {
            decoderInput = inputs.decoder_input_ids;
            vi.spyOn(decoderInput, 'dispose');
            expect(inputs.encoder_outputs).toBe(shared);
            expect(shared.disposed).toBe(false);
            if (outcome.startsWith('detection-')) throw new Error('detection failure');
            const logits = new workerMocks.Tensor('float32', new Float32Array([0, 9, 0]), [1, 1, 3]);
            if (outcome === 'output-cleanup-failure') vi.spyOn(logits, 'dispose').mockImplementation(() => {
                logits.disposed = true;
                throw new Error('logits cleanup failure');
            });
            tensors.push(logits);
            return {logits};
        });
        transcriber.model.config = {model_type: 'whisper', is_encoder_decoder: true, is_multilingual: true, decoder_start_token_id: 0};
        transcriber.model.main_input_name = 'input_features';
        transcriber.model.forward_params = forwardParams;
        transcriber.model.generation_config = {lang_to_id: {'<|en|>': 1, '<|ja|>': 2}};
        transcriber.model._prepare_encoder_decoder_kwargs_for_generation = vi.fn(async () => ({encoder_outputs: shared}));
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        try {
            (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'tiny', sourceLanguage: 'auto', audio: new Float32Array(16_000).fill(.04)}});
            await waitForWorkerMessages(scope, 1);
            expect(transcriber.model._prepare_encoder_decoder_kwargs_for_generation).toHaveBeenCalledTimes(1);
            expect(transcriber.model.forward_params).toBe(forwardParams);
            expect(shared.disposed).toBe(true);
            // The incompatible pipeline retains its original second feature ownership.
            expect(tensors.slice(0, 2).every(tensor => tensor.disposed)).toBe(true);
            if (outcome === 'success-fallback') expect(tensors[2].disposed).toBe(false);
            expect(originalProcessor).toHaveBeenCalledTimes(outcome === 'success-fallback' ? 2 : 1);
            expect(transcriber.processor).toBe(originalProcessor);
            expect(tensors[0].dispose).toHaveBeenCalledOnce();
            expect(decoderInput.disposed).toBe(true);
            expect(decoderInput.dispose).toHaveBeenCalledOnce();
            if (outcome.startsWith('success')) {
                const response = scope.postMessage.mock.calls[0][0];
                expect(response).toMatchObject({success: true, detectedLanguage: 'en', languageConfidence: expect.any(Number), encoderReuse: true});
                expect(response.languageDetectionMs).toBeGreaterThanOrEqual(3);
                expect(response.inferenceMs).toBeGreaterThan(response.languageDetectionMs);
            } else {
                const error = outcome === 'decoder-failure' ? 'decoder failure'
                    : outcome.endsWith('cleanup-failure') ? (outcome === 'output-cleanup-failure' ? 'logits cleanup failure' : outcome === 'feature-cleanup-failure' ? 'feature cleanup failure' : 'encoder cleanup failure')
                    : 'detection failure';
                expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error}));
            }
        } finally {
            workerMocks.env.version = '3.8.1';
            vi.unstubAllGlobals();
        }
    });

    it('auto 异常重复重试建立新的特征租约，首窗张量已释放且第二窗不跨用', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const features: any[] = [], encoders: any[] = [];
        const transcriber: any = vi.fn(async (audio, options) => {
            const processed = await transcriber.processor(audio);
            expect(processed.input_features).toBe(features.at(-1));
            expect(processed.input_features.disposed).toBe(false);
            expect(options.encoder_outputs).toBe(encoders.at(-1));
            if (features.length === 1) return {text: 'Repeated phrase. '.repeat(10), chunks: []};
            expect(features[0].disposed).toBe(true);
            expect(encoders[0].disposed).toBe(true);
            return {text: 'A recovered original sentence.', chunks: []};
        });
        transcriber.processor = vi.fn(async () => {
            const feature = new workerMocks.Tensor('float32', new Float32Array([.1]), [1, 80, 3000]);
            vi.spyOn(feature, 'dispose');
            features.push(feature);
            return {input_features: feature, duplicateReference: feature};
        });
        transcriber.processor.feature_extractor = {config: {sampling_rate: 16_000, chunk_length: 30, hop_length: 160}};
        transcriber.model = vi.fn(async () => ({logits: new workerMocks.Tensor('float32', new Float32Array([0, 9, 0]), [1, 1, 3])}));
        Object.assign(transcriber.model, {
            config: {model_type: 'whisper', is_encoder_decoder: true, is_multilingual: true, decoder_start_token_id: 0},
            main_input_name: 'input_features', forward_params: ['input_features', 'decoder_input_ids'],
            generation_config: {lang_to_id: {'<|en|>': 1, '<|ja|>': 2}},
            _prepare_encoder_decoder_kwargs_for_generation: vi.fn(async () => {
                const encoder = new workerMocks.Tensor('float32', new Float32Array([.1]), [1, 1500, 384]);
                encoders.push(encoder);
                return {encoder_outputs: encoder};
            }),
        });
        const originalProcessor = transcriber.processor;
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        try {
            (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
            scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'base', sourceLanguage: 'auto', audio: new Float32Array(16_000).fill(.04)}});
            await waitForWorkerMessages(scope, 1);
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: 'A recovered original sentence.'}));
            expect(originalProcessor).toHaveBeenCalledTimes(2);
            expect(transcriber).toHaveBeenCalledTimes(2);
            expect(transcriber.processor).toBe(originalProcessor);
            expect(features).toHaveLength(2);
            expect(features.every(tensor => tensor.disposed && tensor.dispose.mock.calls.length === 1)).toBe(true);
            expect(encoders.every(tensor => tensor.disposed)).toBe(true);
        } finally {vi.unstubAllGlobals();}
    });

    it.each([false, true])('长串中文重复只重试一次，失败给出恢复提示而不提交错误字幕（继续重复：%s）', async stillRepeated => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const repeated = '全套 不' + '吻'.repeat(50);
        const transcriber: any = vi.fn()
            .mockResolvedValueOnce({text: repeated, chunks: []})
            .mockResolvedValueOnce({text: stillRepeated ? repeated : '我挟天子以令诸侯。', chunks: []});
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'tiny', sourceLanguage: 'zh-Hans', languageSessionKey: 'repeat', audio: new Float32Array(64_000).fill(0.04)}});
        await waitForWorkerMessages(scope, 1);
        expect(transcriber).toHaveBeenCalledTimes(2);
        expect(transcriber.mock.calls[1][1]).toMatchObject({language: 'zh', no_repeat_ngram_size: 4, repetition_penalty: 1.15});
        if (stillRepeated) expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: expect.stringContaining('异常重复')}));
        else {
            expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, text: '我挟天子以令诸侯。'}));
            const response = scope.postMessage.mock.calls[0][0];
            expect(response.detectedLanguage).toBeUndefined();
            expect(response.languageDetectionMs).toBeUndefined();
            expect(response.encoderReuse).toBeUndefined();
        }
        vi.unstubAllGlobals();
    });

    it('总文本正常但 timestamp chunk 出现重复时也重新识别', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        webGpuMocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const transcriber: any = vi.fn()
            .mockResolvedValueOnce({text: '看起来正常。', chunks: [{text: '吻'.repeat(50), timestamp: [0, 1]}]})
            .mockResolvedValueOnce({text: '恢复的字幕。', chunks: [{text: '恢复的字幕。', timestamp: [0, 1]}]});
        workerMocks.pipeline.mockReset().mockResolvedValue(transcriber);
        (await import('@/src/features/video-subtitle/offscreen/transcription.worker')).startVideoTranscriptionWorker();
        scope.onmessage({data: {requestId: 1, type: 'transcribe', model: 'base', sourceLanguage: 'zh', audio: new Float32Array(64_000).fill(0.04)}});
        await waitForWorkerMessages(scope, 1);
        expect(transcriber).toHaveBeenCalledTimes(2);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, segments: [expect.objectContaining({text: '恢复的字幕。'})]}));
        vi.unstubAllGlobals();
    });

    it('退化检测覆盖中文长串与英文短语循环，保留叠词和正常重复强调', () => {
        expect(isDegenerateVideoTranscript('全套 不' + '吻'.repeat(50))).toBe(true);
        expect(isDegenerateVideoTranscript('Thank you for watching. '.repeat(8))).toBe(true);
        expect(isDegenerateVideoTranscript('你好你好你好')).toBe(false);
        expect(isDegenerateVideoTranscript('不，不，不，这是我的选择。')).toBe(false);
        expect(isDegenerateVideoTranscript('哈哈哈哈哈，谢谢谢谢。')).toBe(false);
        expect(isDegenerateVideoTranscript('1234567890'.repeat(6))).toBe(true);
        expect(isDegenerateVideoTranscript(undefined)).toBe(false);
    });

    it('硬件 WebGPU 可用时优先创建 q4 session，并回传 GPU 诊断', async () => {
        vi.resetModules();
        const scope: Record<string, any> = {
            setTimeout,
            clearTimeout,
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
            location: {href: 'chrome-extension://test/worker.js'},
        };
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 8});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Apple / MTL / GPU'});
        const gpuTranscriber: any = vi.fn(async () => ({text: 'GPU result', chunks: []}));
        gpuTranscriber.dispose = vi.fn(async () => undefined);
        workerMocks.pipeline.mockResolvedValue(gpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {requestId: 1, type: 'prepare', model: 'tiny'}});
        for (let index = 0; index < 10 && scope.postMessage.mock.calls.length < 1; index += 1) await new Promise(resolve => setTimeout(resolve, 0));

        expect(webGpuMocks.probeWebGpu).toHaveBeenCalledTimes(1);
        expect(workerMocks.pipeline).toHaveBeenCalledWith('automatic-speech-recognition', expect.any(String), expect.objectContaining({
            device: 'webgpu',
            dtype: 'q4',
            session_options: expect.objectContaining({enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential'}),
        }));
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            success: true,
            backend: 'webgpu',
            gpuInfo: 'Apple / MTL / GPU',
            dtype: 'q4',
        }));
        vi.unstubAllGlobals();
    });

    it('GPU 语言检测失败时释放旧 session 并回传 fresh CPU 重试提示', async () => {
        vi.resetModules();
        const scope: Record<string, any> = {
            setTimeout,
            clearTimeout,
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
            location: {href: 'chrome-extension://test/worker.js'},
        };
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Discrete GPU'});

        const gpuTranscriber: any = vi.fn(async () => ({text: 'should not run', chunks: []}));
        gpuTranscriber.processor = vi.fn(async () => ({input_features: new workerMocks.Tensor('float32', new Float32Array([0]), [1])}));
        gpuTranscriber.model = vi.fn(async () => { throw new Error('GPU language detection failed'); });
        gpuTranscriber.model.config = {is_multilingual: true, decoder_start_token_id: 0};
        gpuTranscriber.model.generation_config = {
            is_multilingual: true,
            decoder_start_token_id: 0,
            lang_to_id: {'<|en|>': 1},
        };
        gpuTranscriber.dispose = vi.fn(async () => undefined);

        workerMocks.pipeline.mockResolvedValue(gpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        const send = (requestId: number, device?: 'wasm') => scope.onmessage?.({data: {
            requestId,
            type: 'transcribe',
            model: 'tiny',
            sourceLanguage: 'auto',
            languageSessionKey: `stream-${requestId}`,
            audio: new Float32Array([0.04, 0.04, 0.04, 0.04]),
            device,
        }});
        send(1);
        for (let index = 0; index < 20 && scope.postMessage.mock.calls.length < 1; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: 'GPU language detection failed', retryWithCpu: true}));
        expect(gpuTranscriber.dispose).toHaveBeenCalledTimes(1);
        expect(workerMocks.pipeline.mock.calls.map(([, , options]) => options.device)).toEqual(['webgpu']);
        expect(workerMocks.pipeline).toHaveBeenCalledTimes(1);
        expect(webGpuMocks.probeWebGpu).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('GPU 上的语言配置错误直接返回，不误判为 GPU 故障或重建 session', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Discrete GPU'});
        const gpuTranscriber: any = vi.fn();
        gpuTranscriber.processor = vi.fn();
        gpuTranscriber.model = vi.fn();
        gpuTranscriber.model.config = {is_multilingual: true, decoder_start_token_id: 0};
        gpuTranscriber.dispose = vi.fn(async () => undefined);
        workerMocks.pipeline.mockResolvedValue(gpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {
            requestId: 1,
            type: 'transcribe',
            model: 'tiny',
            sourceLanguage: 'auto',
            audio: new Float32Array([0.04, 0.04, 0.04, 0.04]),
        }});
        await waitForWorkerMessages(scope, 1);

        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'Whisper 模型缺少语言 token 配置'});
        expect(gpuTranscriber.dispose).not.toHaveBeenCalled();
        expect(gpuTranscriber.model).not.toHaveBeenCalled();
        expect(workerMocks.pipeline).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('GPU 初始化失败后释放状态并回传 fresh CPU 重试提示', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Discrete GPU'});
        workerMocks.pipeline.mockRejectedValue(new Error('GPU init failed'));

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {requestId: 1, type: 'prepare', model: 'tiny'}});
        await waitForWorkerMessages(scope, 1);

        expect(workerMocks.pipeline.mock.calls.map(([, , options]) => options.device)).toEqual(['webgpu']);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: 'GPU init failed', retryWithCpu: true}));
        expect(workerMocks.pipeline).toHaveBeenCalledTimes(1);
        expect(webGpuMocks.probeWebGpu).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('显式源语言的 GPU 推理失败后释放 session 并回传 fresh CPU 重试提示', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Discrete GPU'});
        const gpuTranscriber: any = vi.fn(async () => { throw new Error('GPU inference failed'); });
        gpuTranscriber.dispose = vi.fn(async () => undefined);
        workerMocks.pipeline.mockResolvedValue(gpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {
            requestId: 1,
            type: 'transcribe',
            model: 'tiny',
            sourceLanguage: 'en-US',
            audio: new Float32Array([0.04, 0.04, 0.04, 0.04]),
        }});
        await waitForWorkerMessages(scope, 1);

        expect(gpuTranscriber.dispose).toHaveBeenCalledTimes(1);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: 'GPU inference failed', retryWithCpu: true}));
        expect(workerMocks.pipeline).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('WASM 推理失败时直接返回错误，不再次创建或重试 session', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 1});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: false, info: ''});
        const cpuTranscriber: any = vi.fn(async () => { throw new Error('CPU inference failed'); });
        workerMocks.pipeline.mockResolvedValue(cpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {
            requestId: 1,
            type: 'transcribe',
            model: 'tiny',
            sourceLanguage: 'en',
            audio: new Float32Array([0.04, 0.04, 0.04, 0.04]),
        }});
        await waitForWorkerMessages(scope, 1);

        expect(cpuTranscriber).toHaveBeenCalledTimes(1);
        expect(workerMocks.pipeline).toHaveBeenCalledTimes(1);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: false, error: 'CPU inference failed'}));
        expect(scope.postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty('retryWithCpu');
        vi.unstubAllGlobals();
    });

    it('收到 device wasm 时释放 GPU session 并锁定本 Worker 使用 WASM', async () => {
        vi.resetModules();
        const scope = createWorkerScope();
        vi.stubGlobal('self', scope);
        vi.stubGlobal('navigator', {hardwareConcurrency: 4});
        workerMocks.pipeline.mockReset();
        webGpuMocks.probeWebGpu.mockReset().mockResolvedValue({available: true, info: 'Discrete GPU'});
        const gpuTranscriber: any = vi.fn(async () => ({text: 'GPU result', chunks: []}));
        gpuTranscriber.dispose = vi.fn(async () => undefined);
        const cpuTranscriber: any = vi.fn(async () => ({text: 'CPU result', chunks: []}));
        workerMocks.pipeline
            .mockResolvedValueOnce(gpuTranscriber)
            .mockResolvedValueOnce(cpuTranscriber);

        const workerModule = await import('@/src/features/video-subtitle/offscreen/transcription.worker');
        workerModule.startVideoTranscriptionWorker();
        scope.onmessage?.({data: {requestId: 1, type: 'prepare', model: 'tiny'}});
        await waitForWorkerMessages(scope, 1);
        scope.onmessage?.({data: {requestId: 2, type: 'prepare', model: 'tiny', device: 'wasm'}});
        await waitForWorkerMessages(scope, 2);

        expect(gpuTranscriber.dispose).toHaveBeenCalledTimes(1);
        expect(workerMocks.pipeline.mock.calls.map(([, , options]) => options.device)).toEqual(['webgpu', 'wasm']);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({success: true, backend: 'wasm', dtype: 'q4'}));
        expect(webGpuMocks.probeWebGpu).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('为显式韩语和 auto 构建独立 transcribe 参数，auto 会清除上次语言', () => {
        const korean = buildWhisperTranscriptionGenerationOptions('tiny', 'ko-KR', 2, 'criteria');
        const english = buildWhisperTranscriptionGenerationOptions('tiny', 'en-US', 2, 'criteria');
        const automatic = buildWhisperTranscriptionGenerationOptions('tiny', 'auto', 2, 'criteria');
        expect(korean).toMatchObject({language: 'ko', task: 'transcribe', stopping_criteria: 'criteria'});
        expect(english.language).toBe('en');
        expect(automatic).toMatchObject({language: null, task: 'transcribe'});
        expect(korean).not.toBe(automatic);
        expect(normalizeWhisperSourceLanguage(undefined)).toBeNull();
        expect(normalizeWhisperSourceLanguage('')).toBeNull();
        expect(normalizeWhisperSourceLanguage('_')).toBeNull();
        expect(normalizeWhisperSourceLanguage('automatic')).toBeNull();
        expect(normalizeWhisperSourceLanguage('  ko_KR ')).toBe('ko');
    });

    it('解码容量不随模型、语言或异常时长越过448位置的decoder context', () => {
        for (const model of ['tiny', 'base', 'small', undefined]) {
            for (const seconds of [-1, 0, 1, 10, 14, 30, Infinity, NaN]) {
                const options = buildWhisperTranscriptionGenerationOptions(model, 'auto', seconds, 'criteria');
                expect(options.max_new_tokens + 3).toBeLessThan(448);
                expect(options.stopping_criteria).toBe('criteria');
            }
        }
    });

    it('多语种正文和timestamp不会被英文每秒token预算强制截尾', () => {
        const counterexamples = [
            {language: 'hi', seconds: 9.12, lexicalTokens: 119},
            {language: 'hi', seconds: 13.8, lexicalTokens: 199},
            {language: 'th', seconds: 8.82, lexicalTokens: 101},
            {language: 'th', seconds: 7.2, lexicalTokens: 65},
            {language: 'th', seconds: 9.54, lexicalTokens: 133},
            {language: 'ar', seconds: 8.16, lexicalTokens: 55},
        ];
        for (const model of ['base', 'small']) {
            for (const {language, seconds, lexicalTokens} of counterexamples) {
                const options = buildWhisperTranscriptionGenerationOptions(model, language, seconds, null);
                expect(options.max_new_tokens).toBeGreaterThan(lexicalTokens + 3);
                expect(options).toMatchObject({no_repeat_ngram_size: 8, do_sample: false, num_beams: 1});
            }
        }
        expect(buildWhisperTranscriptionGenerationOptions('tiny', 'zh-Hans', 10, null).max_new_tokens).toBe(100);
        expect(buildWhisperTranscriptionGenerationOptions('base', 'ja', 30, null).max_new_tokens).toBe(440);
    });

    it('Tiny 保留原时长与中日韩预算，高预算只用于 Base/Small', () => {
        for (const language of ['auto', 'en', 'hi', 'th', 'ar']) {
            expect(buildWhisperTranscriptionGenerationOptions('tiny', language, 10, null).max_new_tokens).toBe(60);
            expect(buildWhisperTranscriptionGenerationOptions('tiny', language, 30, null).max_new_tokens).toBe(64);
            expect(buildWhisperTranscriptionGenerationOptions('tiny', language, 0, null).max_new_tokens).toBe(24);
        }
        for (const language of ['zh-Hans', 'ja', 'ko-KR']) {
            expect(buildWhisperTranscriptionGenerationOptions('tiny', language, 10, null).max_new_tokens).toBe(100);
            expect(buildWhisperTranscriptionGenerationOptions('tiny', language, 30, null).max_new_tokens).toBe(128);
        }
        expect(buildWhisperTranscriptionGenerationOptions('unknown', 'hi', 9.12, null).max_new_tokens).toBe(440);
        for (const seconds of [NaN, Infinity, -1]) {
            expect(buildWhisperTranscriptionGenerationOptions('tiny', 'en', seconds, null).max_new_tokens).toBe(24);
        }
        for (const model of ['base', 'small']) {
            expect(buildWhisperTranscriptionGenerationOptions(model, 'auto', 1, null).max_new_tokens).toBe(440);
        }
    });

    it('从首个 decoder step 的多语语言 token logits 选择韩语并计算置信度', () => {
        const result = chooseWhisperSourceLanguage({
            data: new Float32Array([0, 2, 9, 3, 1]), dims: [1, 1, 5],
        }, {isMultilingual: true, langToId: {'<|en|>': 1, '<|ko|>': 2, '<|zh|>': 3}});
        expect(result?.language).toBe('ko');
        expect(result?.confidence).toBeGreaterThan(0.99);
        expect(chooseWhisperSourceLanguage({data: [1, 2], dims: [1, 1, 4]}, {langToId: {'<|ko|>': 3}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 1]}, {isMultilingual: false, langToId: {'<|ko|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 1]}, {isMultilingual: true, langToId: {'bad': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 1]}, {isMultilingual: true, langToId: {'<|english|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 1]}, {isMultilingual: true, langToId: {'<|--|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1, 2], dims: [1, 1, 2]}, {isMultilingual: true, langToId: {'<|ko|>': '1'}})?.language).toBe('ko');
        expect(chooseWhisperSourceLanguage(null, {langToId: {'<|ko|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: {length: 'bad'} as unknown as ArrayLike<number>}, {langToId: {'<|ko|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1]}, {langToId: null})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 0]}, {langToId: {'<|ko|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: [1, 1, 2]}, {langToId: {'<|ko|>': 1}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [Number.NaN], dims: [1, 1, 1]}, {langToId: {'<|ko|>': 0}})).toBeNull();
        expect(chooseWhisperSourceLanguage({data: [1], dims: undefined}, {langToId: {'<|ko|>': 0}})?.language).toBe('ko');
    });

    it('把连续缺失 timestamp 的 chunks 分成单调区间', () => {
        const result = parseWhisperChunkTimestamps([
            {text: 'first'},
            {text: 'second'},
        ], 2_000);
        expect(result).toEqual([
            {startMs: 0, endMs: 1_000, text: 'first'},
            {startMs: 1_000, endMs: 2_000, text: 'second'},
        ]);
    });

    it('使用下一段已知起点填补缺失结束点并避免相撞', () => {
        const result = parseWhisperChunkTimestamps([
            {timestamp: [0, null], text: 'first'},
            {timestamp: [1.5, 2], text: 'second'},
        ], 2_000);
        expect(result[0]).toMatchObject({startMs: 0, endMs: 1_500});
        expect(result[1]).toMatchObject({startMs: 1_500, endMs: 2_000});
    });

    it('过滤空文本并限制越界时间', () => {
        const result = parseWhisperChunkTimestamps([
            {timestamp: [-1, 99], text: '  kept  '},
            {timestamp: [99, 100], text: ''},
        ], 1_000);
        expect(result).toEqual([{startMs: 0, endMs: 1_000, text: 'kept'}]);
    });

    it('修复相同起止点为最小可见区间', () => {
        const result = parseWhisperChunkTimestamps([{timestamp: [1, 1], text: 'edge'}], 2_000);
        expect(result[0]).toMatchObject({startMs: 1_000, endMs: 1_400});
    });
    it('对非法音频时长和非字符串文本返回空结果', () => {
        expect(parseWhisperChunkTimestamps([{timestamp: [0, 1], text: 123}], Number.NaN)).toEqual([]);
    });
});
