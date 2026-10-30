import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';

const mocks = vi.hoisted(() => ({pipeline: vi.fn(), threads: vi.fn(), forceSingleThread: vi.fn(), dispose: vi.fn(),
    env: {backends: {onnx: {}}} as any, artifacts: vi.fn(), matchArtifact: vi.fn(), artifactBlob: vi.fn(),
    supportsHunyuan: vi.fn(), engine: vi.fn(), configureWasm: vi.fn(), compressedWasm: vi.fn()}));
vi.mock('@huggingface/transformers', () => ({env: mocks.env, pipeline: mocks.pipeline,
    InterruptableStoppingCriteria: class {interrupted = false; interrupt() {this.interrupted = true;}}}));
vi.mock('@wllama/wllama/esm/index.js', () => ({Wllama: function(...args: unknown[]) {return mocks.engine(...args);}}));
vi.mock('@/src/shared/onnx/resources', () => ({forceSingleThreadInference: mocks.forceSingleThread, localWasmThreads: mocks.threads,
    paceLocalInference: (run: () => Promise<unknown>) => run(), paceLocalInitialization: (run: () => Promise<unknown>) => run()}));
vi.mock('@/src/features/local-translation/offscreen/artifactStore', () => ({getTranslationArtifacts: mocks.artifacts, matchTranslationArtifact: mocks.matchArtifact, translationArtifactBlob: mocks.artifactBlob}));
vi.mock('@/src/platform/browser/localTranslationSupport', () => ({supportsHunyuanTranslation: mocks.supportsHunyuan}));
vi.mock('@/src/shared/onnx/wasmBinary', () => ({configureOnnxWasmBackend: mocks.configureWasm, withCompressedWasmBinary: mocks.compressedWasm}));

beforeEach(() => {vi.resetModules();vi.resetAllMocks();mocks.threads.mockReturnValue(1);mocks.env.backends.onnx = {};
    mocks.artifacts.mockReturnValue([]);mocks.supportsHunyuan.mockReturnValue(true);
    mocks.compressedWasm.mockImplementation((_wasm, _url, create) => create());
    vi.stubGlobal('navigator', {});
    mocks.pipeline.mockResolvedValue(Object.assign(vi.fn(async () => [{translation_text: '你好'}]), {dispose: mocks.dispose}));});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
async function start() {
    const postMessage = vi.fn(), addEventListener = vi.fn();
    vi.stubGlobal('self', {postMessage, addEventListener, setTimeout, clearTimeout, location: {href: 'chrome-extension://test/localTranslationWorker.js'}});
    (await import('@/src/app/offscreen/localTranslationWorker')).startLocalTranslationWorkerApp();
    const listener = addEventListener.mock.calls[0][1] as (event: {data: unknown}) => void;
    return {postMessage, send: (value: unknown) => listener({data: value})};
}
const command = {type: 'translate', model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'};
async function reply(scope: Awaited<ReturnType<typeof start>>, value: Record<string, unknown>) {
    scope.send(value);
    await vi.waitFor(() => expect(scope.postMessage.mock.calls.some(([message]) => message.requestId === value.requestId)).toBe(true));
    return scope.postMessage.mock.calls.find(([message]) => message.requestId === value.requestId)![0];
}
function hunyuanEngine() {
    return {setCompat: vi.fn(), loadModel: vi.fn().mockResolvedValue(undefined), exit: vi.fn().mockResolvedValue(undefined),
        createChatCompletion: vi.fn().mockResolvedValue({choices: [{finish_reason: 'stop', message: {content: '你好'}}]})};
}
describe('actual local translation Worker message boundary', () => {
    it.each(['text', 'sourceLanguage', 'targetLanguage'])('rejects a validated %s cleared before its queued execution', async field => {
        const scope = await start();
        const request: Record<string, unknown> = {...command, requestId: 1};
        scope.send(request);
        request[field] = field === 'text' ? undefined : '';
        await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith({requestId: 1, success: false, error: 'LOCAL_TRANSLATION_INVALID_REQUEST'}));
        expect(mocks.pipeline).not.toHaveBeenCalled();
    });

    it('normalizes a non-Error validation fault without acquiring a model', async () => {
        const scope = await start();
        scope.send({requestId: 1, get type() {throw null;}});
        expect(scope.postMessage).toHaveBeenCalledWith({requestId: 1, success: false, error: 'LOCAL_TRANSLATION_INVALID_REQUEST'});
        expect(mocks.pipeline).not.toHaveBeenCalled();
    });

    it('rejects malformed controls before loading a model, then translates and disposes through the same queue', async () => {
        const scope = await start();
        for (const value of [null, {}, {requestId: '1'}, {requestId: 0}, {requestId: NaN}]) scope.send(value);
        expect(scope.postMessage).not.toHaveBeenCalled();
        scope.send({requestId: 1, type: 'translate', model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 1});
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: expect.stringContaining('消息格式无效')});
        expect(mocks.pipeline).not.toHaveBeenCalled();
        scope.send({requestId: 2, type: 'translate', model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'});
        await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
        expect(scope.postMessage.mock.calls[1][0]).toMatchObject({requestId: 2, success: true, result: '你好', backend: 'wasm'});
        scope.send({requestId: 3, type: 'dispose'});
        await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(3));
        expect(mocks.dispose).toHaveBeenCalledOnce();expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 3, success: true});
    });
    it('keeps a typed single-thread retry hint on actual initialization failure and accepts a later forced retry', async () => {
        const scope = await start();mocks.threads.mockReturnValue(2);mocks.pipeline.mockRejectedValueOnce(new Error('pthread unavailable'));
        const command = {type: 'translate', model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'};
        scope.send({requestId: 1, ...command});
        await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(1));
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'pthread unavailable', retrySingleThread: true});
        scope.send({requestId: 2, ...command, singleThread: true});
        await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(2));
        expect(mocks.forceSingleThread).toHaveBeenCalledOnce();expect(scope.postMessage.mock.calls[1][0]).toMatchObject({requestId: 2, success: true, result: '你好'});
    });

    it('only loads verified cache artifacts, skips optional local probes, and configures the compressed WASM session once', async () => {
        const wasm = {};mocks.env.backends.onnx.wasm = wasm;
        const legacyMatch = vi.fn().mockResolvedValue(new Response('legacy'));
        const open = vi.fn().mockResolvedValue({match: legacyMatch});vi.stubGlobal('caches', {open});
        const scope = await start();
        expect(mocks.configureWasm).toHaveBeenCalledWith(wasm, {
            mjs: 'chrome-extension://test/fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs',
            wasm: 'chrome-extension://test/fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm',
        });
        expect(wasm).toMatchObject({numThreads: 1});
        expect(mocks.env).toMatchObject({allowRemoteModels: false, useBrowserCache: false, useFSCache: false, useCustomCache: true});
        await expect(mocks.env.customCache.match(`${mocks.env.localModelPath}optional.json`)).resolves.toBeUndefined();
        expect(mocks.matchArtifact).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
        const artifact = new Response('verified');mocks.matchArtifact.mockResolvedValueOnce(artifact);
        const remote = 'https://huggingface.co/Xenova/opus-mt-en-zh/resolve/pinned/tokenizer.json';
        await expect(mocks.env.customCache.match(new Request(remote))).resolves.toBe(artifact);
        expect(mocks.matchArtifact).toHaveBeenLastCalledWith(remote);expect(open).not.toHaveBeenCalled();
        expect(await (await mocks.env.customCache.match(remote)).text()).toBe('legacy');
        expect(open).toHaveBeenCalledWith('transformers-cache');expect(legacyMatch).toHaveBeenCalledWith(remote);
        await expect(mocks.env.customCache.put('key', new Response('unverified'))).rejects.toThrow('LOCAL_TRANSLATION_NOT_DOWNLOADED');
        mocks.artifacts.mockReturnValue([{repo: 'Xenova/opus-mt-en-zh', revision: 'pinned'}]);
        expect(await reply(scope, {...command, requestId: 1})).toMatchObject({success: true, result: '你好'});
        expect(await reply(scope, {...command, requestId: 2})).toMatchObject({success: true, result: '你好'});
        expect(mocks.pipeline).toHaveBeenCalledOnce();expect(mocks.compressedWasm).toHaveBeenCalledOnce();
        expect(mocks.pipeline).toHaveBeenCalledWith('translation', 'Xenova/opus-mt-en-zh', expect.objectContaining({revision: 'pinned', local_files_only: true}));
    });

    it('can retry the opposite OPUS direction after the previous model fails to dispose', async () => {
        const scope = await start();
        expect(await reply(scope, {...command, requestId: 1})).toMatchObject({success: true});
        mocks.dispose.mockRejectedValue(new Error('session dispose failed'));
        const reverse = {...command, text: '你好', sourceLanguage: 'zh', targetLanguage: 'en'};
        expect(await reply(scope, {...reverse, requestId: 2})).toMatchObject({success: false, error: 'session dispose failed'});
        const fresh = vi.fn().mockResolvedValue({translation_text: 'Hello'});
        mocks.pipeline.mockResolvedValue(fresh);
        expect(await reply(scope, {...reverse, requestId: 3})).toMatchObject({success: true, result: 'Hello'});
        expect(mocks.dispose).toHaveBeenCalledOnce();expect(mocks.pipeline).toHaveBeenCalledTimes(2);
        await reply(scope, {type: 'dispose', requestId: 4});
        expect(mocks.dispose).toHaveBeenCalledOnce();
    });

    it.each(['gpu', 'fallback', 'cpu'] as const)('initializes Hunyuan using %s, reuses its session, and releases it when switching to OPUS', async mode => {
        if (mode !== 'cpu') {vi.stubGlobal('navigator', {gpu: {}});vi.stubGlobal('WebAssembly', {Suspending: class {}});}
        const failed = hunyuanEngine();failed.loadModel.mockRejectedValue(new Error('GPU unavailable'));failed.exit.mockRejectedValue(new Error('already stopped'));
        const active = hunyuanEngine();mocks.engine.mockReturnValue(active);
        if (mode === 'fallback') mocks.engine.mockReturnValueOnce(failed);
        const artifact = {repo: 'hunyuan', revision: 'pinned'};const blob = new Blob(['verified model']);
        mocks.artifacts.mockReturnValue([artifact]);mocks.artifactBlob.mockResolvedValue(blob);
        const scope = await start(), hunyuanCommand = {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan, text: '  Hello.\n\nWorld!  '};
        const result = await reply(scope, {...hunyuanCommand, requestId: 1});
        expect(result).toMatchObject({success: true, result: '  你好\n\n你好  '});
        if (mode === 'gpu') expect(result).not.toHaveProperty('backend');
        else expect(result.backend).toBe('wasm');
        expect(active.setCompat).toHaveBeenCalledWith(null);
        expect(active.loadModel).toHaveBeenCalledWith([blob], expect.objectContaining({n_gpu_layers: mode === 'gpu' ? 99 : 0, n_threads: 1, n_ctx: 2048}));
        expect(active.createChatCompletion).toHaveBeenCalledTimes(2);
        expect(active.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({abortSignal: expect.any(AbortSignal), max_tokens: 768, cache_prompt: false}));
        if (mode === 'fallback') expect(failed.exit).toHaveBeenCalledOnce();
        expect(await reply(scope, {...hunyuanCommand, requestId: 2})).toMatchObject({success: true});
        expect(active.loadModel).toHaveBeenCalledOnce();expect(mocks.artifactBlob).toHaveBeenCalledOnce();
        expect(await reply(scope, {...command, requestId: 3})).toMatchObject({success: true});
        expect(active.exit).toHaveBeenCalledOnce();
    });

    it.each([false, true])('never carries an old WASM label into an unconfirmed GPU session after disposal failure=%s', async failDisposal => {
        vi.stubGlobal('navigator', {gpu: {}});
        vi.stubGlobal('WebAssembly', {Suspending: class {}});
        mocks.engine.mockImplementation(() => hunyuanEngine());
        mocks.artifacts.mockReturnValue([{}]);
        mocks.artifactBlob.mockResolvedValue(new Blob(['model']));
        const scope = await start(), hunyuanCommand = {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan};
        expect(await reply(scope, {...command, requestId: 1})).toMatchObject({success: true, backend: 'wasm'});
        if (failDisposal) {
            mocks.dispose.mockRejectedValueOnce(new Error('dispose failed'));
            expect(await reply(scope, {...hunyuanCommand, requestId: 2})).toMatchObject({success: false, error: 'dispose failed'});
        }
        const gpu = await reply(scope, {...hunyuanCommand, requestId: 3});
        expect(gpu).toMatchObject({success: true, result: '你好'});
        expect(gpu).not.toHaveProperty('backend');
        expect(await reply(scope, {...command, requestId: 4})).toMatchObject({success: true, backend: 'wasm'});
        expect(await reply(scope, {type: 'dispose', requestId: 5})).toMatchObject({success: true});
        expect(await reply(scope, {...hunyuanCommand, requestId: 6})).not.toHaveProperty('backend');
    });

    it.each(['unsupported', 'missing-artifact', 'cpu-load', 'gpu-and-cpu-load'] as const)('reports Hunyuan %s failure without retaining a broken engine', async mode => {
        const engine = hunyuanEngine();engine.loadModel.mockRejectedValue(new Error('model load failed'));
        mocks.engine.mockReturnValue(engine);mocks.artifacts.mockReturnValue(mode === 'missing-artifact' ? [] : [{}]);
        mocks.artifactBlob.mockResolvedValue(new Blob(['model']));mocks.supportsHunyuan.mockReturnValue(mode !== 'unsupported');
        if (mode === 'gpu-and-cpu-load') {vi.stubGlobal('navigator', {gpu: {}});vi.stubGlobal('WebAssembly', {Suspending: class {}});}
        const scope = await start();
        expect(await reply(scope, {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan, requestId: 1})).toMatchObject({success: false,
            error: mode === 'unsupported' ? 'LOCAL_TRANSLATION_BROWSER_UNSUPPORTED' : mode === 'missing-artifact' ? 'LOCAL_TRANSLATION_INVALID_MODEL' : 'model load failed'});
        expect(engine.exit).toHaveBeenCalledTimes(mode === 'cpu-load' ? 1 : mode === 'gpu-and-cpu-load' ? 2 : 0);
        expect(await reply(scope, {...command, requestId: 2})).toMatchObject({success: true});
    });

    it('suppresses native model logs at every level without changing the public translation result', async () => {
        const levels = ['debug', 'log', 'warn', 'error'] as const;
        const consoleSpies = levels.map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
        try {
            const engine = hunyuanEngine();
            mocks.engine.mockImplementation((_paths, options: {logger: Record<typeof levels[number], (...messages: unknown[]) => void>}) => {
                engine.loadModel.mockImplementation(async () => {
                    // 模拟原生推理库使用收到的 logger 端口，不调用 Worker 私有函数。
                    for (const level of levels) options.logger[level]('synthetic private model diagnostic', {modelPath: '/private/controlled-model'});
                });
                return engine;
            });
            mocks.artifacts.mockReturnValue([{}]);mocks.artifactBlob.mockResolvedValue(new Blob(['model']));
            const scope = await start();
            expect(await reply(scope, {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan, requestId: 1}))
                .toMatchObject({success: true, result: '你好', backend: 'wasm'});
            expect(engine.loadModel).toHaveBeenCalledOnce();expect(engine.createChatCompletion).toHaveBeenCalledOnce();
            for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
            expect(JSON.stringify(scope.postMessage.mock.calls)).not.toContain('synthetic private model diagnostic');
        } finally {for (const spy of consoleSpies) spy.mockRestore();}
    });

    it('does not reuse a Hunyuan engine after its exit rejects during a model switch', async () => {
        const engine = hunyuanEngine();engine.exit.mockRejectedValue(new Error('Hunyuan exit failed'));
        mocks.engine.mockReturnValue(engine);mocks.artifacts.mockReturnValue([{}]);mocks.artifactBlob.mockResolvedValue(new Blob(['model']));
        const scope = await start();
        expect(await reply(scope, {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan, requestId: 1})).toMatchObject({success: true});
        expect(await reply(scope, {...command, requestId: 2})).toMatchObject({success: false, error: 'Hunyuan exit failed'});
        expect(await reply(scope, {...command, requestId: 3})).toMatchObject({success: true, result: '你好'});
        expect(engine.exit).toHaveBeenCalledOnce();
    });

    it('supports the multilingual pipeline and rejects empty output and non-Error initialization failures', async () => {
        const scope = await start(), multilingual = {...command, model: LOCAL_TRANSLATION_MODEL_IDS.m2m100};
        mocks.pipeline.mockRejectedValueOnce('failed to initialize');
        expect(await reply(scope, {...multilingual, requestId: 1})).toMatchObject({success: false, error: 'LOCAL_TRANSLATION_FAILED'});
        const translator = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({translation_text: ''}).mockResolvedValue({translation_text: '你好'});
        mocks.pipeline.mockResolvedValue(translator);
        for (const requestId of [2, 3]) expect(await reply(scope, {...multilingual, requestId})).toMatchObject({success: false, error: 'LOCAL_TRANSLATION_EMPTY'});
        expect(await reply(scope, {...multilingual, requestId: 4})).toMatchObject({success: true, result: '你好'});
        expect(mocks.pipeline).toHaveBeenLastCalledWith('translation', LOCAL_TRANSLATION_MODEL_IDS.m2m100, expect.objectContaining({revision: 'main'}));
    });

    it.each(['length', 'empty-choice', 'empty-content'] as const)('rejects Hunyuan %s output and can translate again on the same loaded engine', async mode => {
        const engine = hunyuanEngine();mocks.engine.mockReturnValue(engine);mocks.artifacts.mockReturnValue([{}]);
        mocks.artifactBlob.mockResolvedValue(new Blob(['model']));
        engine.createChatCompletion.mockResolvedValueOnce({choices: mode === 'empty-choice' ? [] : [{finish_reason: mode === 'length' ? 'length' : 'stop', message: {content: ''}}]});
        const scope = await start(), hunyuanCommand = {...command, model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan};
        expect(await reply(scope, {...hunyuanCommand, requestId: 1})).toMatchObject({success: false, error: mode === 'length' ? 'LOCAL_TRANSLATION_OUTPUT_LIMIT' : 'LOCAL_TRANSLATION_EMPTY'});
        expect(await reply(scope, {...hunyuanCommand, requestId: 2})).toMatchObject({success: true, result: '你好'});
        expect(engine.loadModel).toHaveBeenCalledOnce();
    });

    it('interrupts an overdue inference, rejects its late output, and keeps the queue usable', async () => {
        vi.useFakeTimers();let finish!: (value: unknown) => void;
        const translator = Object.assign(vi.fn().mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValue([{translation_text: '你好'}]), {dispose: mocks.dispose});
        mocks.pipeline.mockResolvedValue(translator);const scope = await start();
        scope.send({...command, requestId: 1});await vi.advanceTimersByTimeAsync(0);
        expect(translator).toHaveBeenCalledOnce();const stop = translator.mock.calls[0][1].stopping_criteria;
        await vi.advanceTimersByTimeAsync(90_000);expect(stop.interrupted).toBe(true);
        finish([{translation_text: 'late'}]);await vi.advanceTimersByTimeAsync(0);
        expect(scope.postMessage).toHaveBeenLastCalledWith({requestId: 1, success: false, error: 'LOCAL_TRANSLATION_TIMEOUT'});
        expect(vi.getTimerCount()).toBe(0);
        scope.send({...command, requestId: 2});await vi.advanceTimersByTimeAsync(1);
        expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({requestId: 2, success: true, result: '你好'}));
        expect(vi.getTimerCount()).toBe(0);
    });
});
