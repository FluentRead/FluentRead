import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
const mocks = vi.hoisted(() => ({env: {backends: {onnx: {wasm: {}}}} as any, config: vi.fn(), tokenizer: vi.fn(), model: vi.fn(), match: vi.fn(), store: vi.fn(), tensors: [] as Array<{dispose: Mock}>}));
vi.mock('@huggingface/transformers', () => ({env: mocks.env, AutoConfig: {from_pretrained: mocks.config}, AutoTokenizer: {from_pretrained: mocks.tokenizer}, AutoModelForCausalLM: {from_pretrained: mocks.model}, Tensor: class {
    dispose = vi.fn(); constructor(public type: string, public data: ArrayLike<number>, public dims: number[]) {mocks.tensors.push(this);}
}}));
vi.mock('@/src/features/information-highlight/offscreen/artifacts', () => ({informationHighlightArtifactStore: {match: mocks.match}, getInformationHighlightArtifactStore: mocks.store}));
vi.mock('@/src/shared/onnx/resources', () => ({localWasmThreads: () => 1, paceLocalInitialization: async (run: () => Promise<unknown>) => run(), paceLocalInference: async (run: () => Promise<unknown>) => run()}));
import {startInformationHighlightWorker, type InformationHighlightWorkerRequest} from '@/src/features/information-highlight/offscreen/worker';
import {startInformationHighlightWorkerApp} from '@/src/app/offscreen/informationHighlightWorker';
import * as modelCatalog from '@/src/core/config/informationHighlightModel';

const flush = async () => {for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve,0)); for (let i = 0; i < 10; i++) await Promise.resolve();};
describe('static model worker uses prepared files and serial cooperative cancellation', () => {
    let listener: (event: {data: InformationHighlightWorkerRequest}) => void, post: Mock, model: Mock;
    beforeEach(() => {
        vi.clearAllMocks(); mocks.tensors.length = 0;
        mocks.env.backends.onnx.wasm = {};
        const tensor = (dims: number[], data: number[]) => {const value = {dims, type: 'float32', data, dispose: vi.fn()}; mocks.tensors.push(value); return value;};
        model = vi.fn(async ({input_ids, attention_mask}) => ({logits: tensor([1,input_ids.dims[1],2], Array(input_ids.dims[1] * 2).fill(0)), 'present.0.key': tensor([1,1,attention_mask.dims[1],1], [0])}));
        mocks.store.mockImplementation(() => ({match: mocks.match}));
        mocks.config.mockImplementation(async () => ({bos_token_id: 0})); mocks.tokenizer.mockResolvedValue({encode: vi.fn(() => [1]), model: {convert_ids_to_tokens: () => ['a']}, added_tokens: [{content: '<special>'}]}); mocks.model.mockResolvedValue(model);
        post = vi.fn(); vi.stubGlobal('self', {location: {href: 'chrome-extension://id/informationHighlightWorker.js'}, addEventListener: (_type: string, callback: typeof listener) => {listener = callback;}, postMessage: post});
    });
    afterEach(() => vi.unstubAllGlobals());
    const send = (data: InformationHighlightWorkerRequest) => listener({data});
    it('loads only fixed verified q4f16 files, uses real input_ids forward and disposes temporary tensors', async () => {
        expect(startInformationHighlightWorkerApp).toBe(startInformationHighlightWorker); startInformationHighlightWorkerApp();
        expect(mocks.env).toMatchObject({allowLocalModels: true, allowRemoteModels: false, useBrowserCache: false, useFSCache: false});
        expect(mocks.env.backends.onnx.wasm.wasmPaths).toMatchObject({mjs: expect.stringContaining('/fluent-read-ai/'), wasm: expect.stringContaining('/fluent-read-ai/')});
        send({type: 'score', requestId: 1, text: 'a'}); await flush();
        await mocks.env.customCache.match('canonical'); expect(mocks.match).toHaveBeenCalledWith('canonical'); await expect(mocks.env.customCache.put()).rejects.toThrow('NOT_DOWNLOADED');
        expect(mocks.model).toHaveBeenCalledWith('onnx-community/Qwen2.5-0.5B', expect.objectContaining({revision: 'bae5ceaee026f0d0592858b2bd27645a06f19c42', local_files_only: true, device: 'webgpu', dtype: 'q4f16', config: {'transformers.js_config': {kv_cache_dtype: 'float32'}, bos_token_id: 0}}));
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true, initialized: true, result: {spans: [{start: 0,end: 1,score: 1}], engine: expect.stringContaining('local WebGPU')}}));
        expect(mocks.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
        send({type: 'score', requestId: 2, text: 'a'}); await flush(); expect(mocks.model).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
        startInformationHighlightWorker(); send({type: 'score', requestId: 3, text: 'a'}); await flush(); expect(mocks.model).toHaveBeenCalledTimes(2); expect(model).toHaveBeenCalledTimes(2);
    });
    it.each(['qwen3-0.6b', 'remote-model'])('rejects retired or unknown model %s before loading files', async modelId => {
        startInformationHighlightWorker(); send({type: 'score', requestId: 1, text: 'a', modelId: modelId as never}); await flush();
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({requestId: 1, success: false, initialized: false, error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'}));
        expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.tokenizer).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
        send({type: 'score', requestId: 2, text: 'a', modelId: 'qwen2.5-0.5b'}); await flush();
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true, initialized: true, result: expect.objectContaining({engine: expect.stringContaining('Qwen2.5 0.5B Base')})}));
        expect(mocks.model).toHaveBeenCalledOnce();
    });
    it('rejects retired Qwen3 requests in a warm Base worker without reusing scores for that id', async () => {
        startInformationHighlightWorker(); send({type: 'score', requestId: 1, text: 'a'}); await flush();
        send({type: 'score', requestId: 2, text: 'a', modelId: 'qwen3-0.6b' as never}); await flush();
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({requestId: 2, success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'}));
        send({type: 'score', requestId: 3, text: 'a'}); await flush();
        expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true, result: expect.objectContaining({engine: expect.stringContaining('Qwen2.5 0.5B Base')})}));
        expect(mocks.model).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
    });
    it('keeps a worker bound to one model when a test-only future Base descriptor is available', async () => {
        // 仅为通用 Worker 的模型归属守卫提供第二个 Base 夹具；真实清单不重新接受 Qwen3。
        const alternativeId = 'test-only-base' as never, lookup = modelCatalog.getInformationHighlightModel;
        const alternative = {...lookup(undefined), id: alternativeId, name: 'Test-only Base'};
        const descriptor = vi.spyOn(modelCatalog, 'getInformationHighlightModel').mockImplementation(value => value === alternativeId ? alternative : lookup(value));
        try {
            startInformationHighlightWorker(); send({type: 'score', requestId: 1, text: 'a'}); await flush();
            send({type: 'score', requestId: 2, text: 'a', modelId: alternativeId}); await flush();
            expect(post).toHaveBeenLastCalledWith(expect.objectContaining({requestId: 2, success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'}));
            expect(mocks.model).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
            send({type: 'score', requestId: 3, text: 'a'}); await flush();
            expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true, result: expect.objectContaining({engine: expect.stringContaining('Qwen2.5 0.5B Base')})}));
            startInformationHighlightWorker(); send({type: 'score', requestId: 4, text: 'a', modelId: alternativeId}); await flush();
            expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true, result: expect.objectContaining({engine: expect.stringContaining('Test-only Base')})}));
            expect(mocks.model).toHaveBeenCalledTimes(2);
        } finally {descriptor.mockRestore();}
    });
    it('rejects cancelled queued requests before initialization, ignores malformed messages and never starts duplicate ids', async () => {
        mocks.env.backends.onnx.wasm = undefined; startInformationHighlightWorker();
        for (const data of [null, {type: 'score', requestId: NaN}, {type: 'unknown', requestId: 1}, {type: 'score', requestId: 1, text: 4}]) listener({data: data as never});
        send({type: 'cancel', requestId: 1}); send({type: 'score', requestId: 1, text: 'a'}); send({type: 'score', requestId: 1, text: 'a'}); send({type: 'cancel', requestId: 1}); await flush();
        expect(mocks.model).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: false, initialized: false}));
    });
    it('surfaces initialization/forward errors and retries initialization without network fallback', async () => {
        startInformationHighlightWorker(); mocks.model.mockRejectedValueOnce(new Error('GPU init failed'));
        send({type: 'score', requestId: 1, text: 'a'}); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: false, initialized: false, error: 'GPU init failed'}));
        model.mockRejectedValueOnce('native failure'); send({type: 'score', requestId: 2, text: 'a'}); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: false, initialized: true, error: 'INFORMATION_HIGHLIGHT_FAILED'}));
        expect(mocks.tensors.every(tensor => tensor.dispose.mock.calls.length === 1)).toBe(true);
        send({type: 'score', requestId: 3, text: 'a'}); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true})); expect(mocks.model).toHaveBeenCalledTimes(2);
    });
    it('cancels an in-flight forward cooperatively while retaining the model session for later work', async () => {
        startInformationHighlightWorker(); let done!: (value: unknown) => void;
        const real = model.getMockImplementation()!; model.mockImplementationOnce(() => new Promise(resolve => {done = resolve;}));
        send({type: 'score', requestId: 1, text: 'a'}); for(let i=0;i<40;i++) await Promise.resolve(); send({type: 'cancel', requestId: 1});
        done(await real(model.mock.calls[0][0])); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: false, initialized: true}));
        send({type: 'score', requestId: 2, text: 'a'}); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true})); expect(mocks.model).toHaveBeenCalledOnce();
    });
    it('finishes cold preparation after cancellation, reuses the warm engine, and never caches a cancelled result', async () => {
        let loaded!: (value: unknown) => void; mocks.model.mockImplementationOnce(() => new Promise(resolve => {loaded = resolve;}));
        startInformationHighlightWorker(); send({type: 'score', requestId: 1, text: 'a'}); for(let i=0;i<40;i++) await Promise.resolve();
        send({type: 'cancel', requestId: 1}); loaded(model); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: false, initialized: true})); expect(model).not.toHaveBeenCalled();
        send({type: 'score', requestId: 2, text: 'a'}); await flush(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({success: true})); expect(mocks.model).toHaveBeenCalledOnce(); expect(model).toHaveBeenCalledOnce();
        send({type: 'score', requestId: 3, text: 'a'}); await flush(); expect(model).toHaveBeenCalledOnce();
    });
});
