/**
 * @file tests/localTtsWorker.test.ts
 * 文件职责：验证本地 TTS Worker 的 WebGPU 优先、WASM 回退、流式失败恢复和生命周期锁定。
 * 主要内容：用假 Kokoro 模型驱动真实 Worker 队列，验证句段时间、实际 WAV、PCM16 静音与采样率安全检查。
 * 模块边界：覆盖 tts.worker.ts 的设备选择、模型释放、编码和错误边界，不加载模型或启动浏览器 Worker。
 */

vi.mock('@/src/shared/onnx/resources', async original => ({
    ...await original<typeof import('@/src/shared/onnx/resources')>(),
    paceLocalInference: (operation: () => Promise<unknown>) => operation(),
    paceLocalInitialization: (operation: () => Promise<unknown>) => operation(),
}));
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getLocalTtsModelFileUrl, getLocalTtsModelLoaderUrl, getLocalTtsVoiceCacheUrl} from '@/src/features/local-tts/offscreen/modelCache';
import {LOCAL_TTS_MODEL_CACHE_NAME, LOCAL_TTS_VOICE_CACHE_NAME} from '@/src/core/config/localTts';

const mocks = vi.hoisted(() => ({
    probeWebGpu: vi.fn(),
    fromPretrained: vi.fn(),
}));

vi.mock('@uzen/kokoro-js', () => ({
    KokoroTTS: {from_pretrained: mocks.fromPretrained},
    env: {wasmPaths: {}},
}));

vi.mock('@huggingface/transformers-kokoro', () => ({
    env: {
        allowLocalModels: false,
        allowRemoteModels: true,
        useBrowserCache: true,
        useWasmCache: false,
        fetch: globalThis.fetch,
        backends: {onnx: {wasm: {}}},
    },
}));

vi.mock('@/src/shared/onnx/wasmBinary', async () => {
    const actual = await vi.importActual<typeof import('@/src/shared/onnx/wasmBinary')>('@/src/shared/onnx/wasmBinary');
    return {
        ...actual,
        configureOnnxWasmBackend: vi.fn(),
        withCompressedWasmBinary: vi.fn(async (_backend: unknown, _url: string, initialize: () => Promise<unknown>) => initialize()),
    };
});

vi.mock('@/src/shared/onnx/webgpu', () => ({probeWebGpu: mocks.probeWebGpu}));

type FakeModel = {
    stream: ReturnType<typeof vi.fn>;
    model: {dispose: ReturnType<typeof vi.fn>};
};

type WorkerScope = {
    location: {href: string};
    onmessage?: (event: MessageEvent) => void;
    postMessage: ReturnType<typeof vi.fn>;
};

const originalFetch = globalThis.fetch;

function modelFrom(stream: () => AsyncGenerator<unknown>, dispose = vi.fn()): FakeModel {
    return {
        stream: vi.fn(stream),
        model: {dispose},
    };
}

async function* audioChunks(samples: number[], samplingRate = 24_000): AsyncGenerator<unknown> {
    yield {audio: {audio: new Float32Array(samples), sampling_rate: samplingRate}};
}

async function* audioThenError(): AsyncGenerator<unknown> {
    yield {audio: {audio: new Float32Array([1]), sampling_rate: 24_000}};
    throw new Error('webgpu stream failed');
}

async function* errorStream(): AsyncGenerator<unknown> {
    throw new Error('cpu stream failed');
}

function scope(): WorkerScope {
    const value: WorkerScope = {
        location: {href: 'chrome-extension://test/offscreen.html'},
        postMessage: vi.fn(),
    };
    (globalThis as unknown as {self: WorkerScope}).self = value;
    return value;
}

async function start() {
    vi.resetModules();
    const workerScope = scope();
    const worker = await import('@/src/features/local-tts/offscreen/tts.worker');
    worker.startLocalTtsWorker();
    return workerScope;
}

async function send(workerScope: WorkerScope, request: Record<string, unknown>, messageCount: number) {
    workerScope.onmessage?.({data: request} as MessageEvent);
    await vi.waitFor(() => expect(workerScope.postMessage).toHaveBeenCalledTimes(messageCount));
    return workerScope.postMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
    mocks.probeWebGpu.mockReset();
    mocks.probeWebGpu.mockResolvedValue({available: true, info: 'test-gpu'});
    mocks.fromPretrained.mockReset();
});

describe('local TTS worker audio and timing integrity', () => {
    it('maps repeated sentence text to original character offsets and cumulative encoded chunk durations', async () => {
        const text = 'Repeat.  Repeat. 你好。';
        const sampleRate = 8_000;
        const cpuModel = modelFrom(async function* () {
            // 无法匹配的文本与缺失文本仍贡献真实音频时长，但不能虚构字符位置。
            yield {text: 'not in source', audio: {audio: new Float32Array(4_000).fill(0.125), sampling_rate: sampleRate}};
            yield {text: 'Repeat.', audio: {audio: new Float32Array(8_000).fill(0.25), sampling_rate: sampleRate}};
            yield {audio: {audio: [new Float32Array(2_000).fill(0.5), new Float32Array(2_000).fill(-0.5)], sampling_rate: sampleRate}};
            yield {text: 'Repeat.', audio: {audio: new Float32Array(12_000).fill(0.75), sampling_rate: sampleRate}};
            yield {text: '你好。', audio: {audio: new Float32Array(4_000).fill(1), sampling_rate: sampleRate}};
        });
        mocks.fromPretrained.mockResolvedValue(cpuModel);
        const workerScope = await start();
        const response = await send(workerScope, {
            requestId: 20, type: 'synthesize', device: 'wasm', text, voice: 'zf_001', speed: 1,
        }, 1);
        expect(response).toMatchObject({requestId: 20, success: true, backend: 'wasm', samplingRate: sampleRate});
        expect(response.timings).toEqual([
            {startChar: 0, endChar: 7, startTime: 0.5, endTime: 1.5},
            {startChar: 9, endChar: 16, startTime: 2, endTime: 3.5},
            {startChar: 17, endChar: 20, startTime: 3.5, endTime: 4},
        ]);
        expect(cpuModel.stream).toHaveBeenCalledWith(text, {voice: 'zf_001', speed: 1, maxChunkLength: 180});
        const audio = response.audio as ArrayBuffer;
        expect(audio).toBeInstanceOf(ArrayBuffer);
        const wav = new DataView(audio);
        expect(wav.getUint32(24, true)).toBe(sampleRate);
        expect(wav.getUint32(40, true)).toBe(32_000 * 2);
        expect(audio.byteLength).toBe(44 + 32_000 * 2);
        expect(wav.getUint32(40, true) / (sampleRate * 2)).toBe(4);
        expect(wav.getInt16(44, true)).toBe(4096);
        expect(wav.getInt16(44 + 4_000 * 2, true)).toBe(8192);
        expect(wav.getInt16(44 + 14_000 * 2, true)).toBe(-16384);
        expect(wav.getInt16(audio.byteLength - 2, true)).toBe(32767);
        expect(workerScope.postMessage).toHaveBeenCalledWith(response, [audio]);
    });

    it('keeps legacy chunks without text playable and returns no fabricated timings', async () => {
        mocks.fromPretrained.mockResolvedValue(modelFrom(() => audioChunks([0.5, -0.5])));
        const workerScope = await start();
        const response = await send(workerScope, {requestId: 21, type: 'synthesize', device: 'wasm', text: 'Legacy audio'}, 1);
        expect(response).toMatchObject({requestId: 21, success: true, samplingRate: 24_000, timings: []});
        const wav = new DataView(response.audio as ArrayBuffer);
        expect(wav.getUint32(40, true)).toBe(4);
        expect(wav.getInt16(44, true)).toBe(16384);
        expect(wav.getInt16(46, true)).toBe(-16384);
    });

    it.each(['webgpu', 'wasm'] as const)('rejects nonzero %s samples that all round to zero in PCM16', async device => {
        const samples = [0.000_001, -0.000_001, 0.000_01, -0.000_01];
        expect(samples.every(sample => sample !== 0)).toBe(true);
        const dispose = vi.fn();
        const model = modelFrom(() => audioChunks(samples), dispose);
        mocks.fromPretrained.mockResolvedValue(model);
        const workerScope = await start();
        const response = await send(workerScope, {
            requestId: 22, type: 'synthesize', text: 'Sub-PCM signal', ...(device === 'wasm' ? {device} : {}),
        }, 1);
        expect(response).toMatchObject({requestId: 22, success: false, error: '本地 TTS 生成了静音音频'});
        expect(response).not.toHaveProperty('audio');
        expect(response).not.toHaveProperty('timings');
        expect(response.retryWithCpu).toBe(device === 'webgpu' ? true : undefined);
        expect(dispose).toHaveBeenCalledTimes(device === 'webgpu' ? 1 : 0);
        expect(model.stream).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();
        expect(workerScope.postMessage.mock.calls[0]).toHaveLength(1);
    });

    it('accepts a real nonzero PCM16 signal alongside samples that round to zero', async () => {
        mocks.fromPretrained.mockResolvedValue(modelFrom(() => audioChunks([0.000_01, -0.000_01, 0.000_02, -0.000_02])));
        const workerScope = await start();
        const response = await send(workerScope, {requestId: 23, type: 'synthesize', device: 'wasm', text: 'One PCM step'}, 1);
        expect(response.success).toBe(true);
        const wav = new DataView(response.audio as ArrayBuffer);
        expect([44, 46, 48, 50].map(offset => wav.getInt16(offset, true))).toEqual([0, 0, 1, -1]);
    });

    it.each([0, -24_000, 24_000.5, 0x8000_0000, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid sampling rate %s without returning WAV or timings', async sampleRate => {
            mocks.fromPretrained.mockResolvedValue(modelFrom(() => audioChunks([0.5], sampleRate)));
            const workerScope = await start();
            const response = await send(workerScope, {requestId: 24, type: 'synthesize', device: 'wasm', text: 'Bad sampling rate'}, 1);
            expect(response).toEqual({requestId: 24, success: false, error: '本地 TTS 音频采样率无效或不一致'});
            expect(workerScope.postMessage.mock.calls[0]).toHaveLength(1);
        },
    );

    it.each(['webgpu', 'wasm'] as const)('rejects inconsistent %s chunk rates and discards partial audio', async device => {
        const dispose = vi.fn();
        const model = modelFrom(async function* () {
            yield {text: 'First.', audio: {audio: new Float32Array([0.5]), sampling_rate: 24_000}};
            yield {text: 'Second.', audio: {audio: new Float32Array([0.5]), sampling_rate: 16_000}};
        }, dispose);
        mocks.fromPretrained.mockResolvedValue(model);
        const workerScope = await start();
        const response = await send(workerScope, {
            requestId: 25, type: 'synthesize', text: 'First. Second.', ...(device === 'wasm' ? {device} : {}),
        }, 1);
        expect(response).toMatchObject({requestId: 25, success: false, error: '本地 TTS 音频采样率无效或不一致'});
        expect(response).not.toHaveProperty('audio');
        expect(response).not.toHaveProperty('timings');
        expect(response.retryWithCpu).toBe(device === 'webgpu' ? true : undefined);
        expect(dispose).toHaveBeenCalledTimes(device === 'webgpu' ? 1 : 0);
        expect(workerScope.postMessage.mock.calls[0]).toHaveLength(1);
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    delete (globalThis as unknown as {self?: WorkerScope}).self;
});

describe('local TTS worker device fallback', () => {
    it('loads model and voice bytes from qualified mirror caches through the actual SDK fetch port', async () => {
        const pinned = getLocalTtsModelFileUrl('config.json');
        const voice = getLocalTtsVoiceCacheUrl('zf_001');
        const modelCache = new Map([[pinned, new Response('model-bytes', {
            headers: {'X-FluentRead-Model-Source': pinned.replace('https://huggingface.co/', 'https://hf-mirror.net/')},
        })]]);
        const voiceCache = new Map([[voice, new Response('voice-bytes', {
            headers: {'X-FluentRead-Model-Source': voice.replace('https://huggingface.co/', 'https://hf-mirror.com/')},
        })]]);
        const open = vi.fn(async (name: string) => ({
            match: async (url: string) => (name === LOCAL_TTS_MODEL_CACHE_NAME ? modelCache : voiceCache).get(url)?.clone(),
        }));
        vi.stubGlobal('caches', {open});
        const nativeFetch = vi.fn(async () => { throw new Error('Model inference must remain offline'); });
        vi.stubGlobal('fetch', nativeFetch);
        const consumed: string[] = [];
        mocks.fromPretrained.mockImplementation(async () => {
            const {env} = await import('@huggingface/transformers-kokoro');
            consumed.push(await (await env.fetch(getLocalTtsModelLoaderUrl('config.json'))).text());
            consumed.push(await (await env.fetch(voice)).text());
            return modelFrom(() => audioChunks([0.5]));
        });
        const workerScope = await start();
        const response = await send(workerScope, {requestId: 30, type: 'prepare', device: 'wasm'}, 1);
        expect(response).toMatchObject({requestId: 30, success: true, backend: 'wasm'});
        expect(consumed).toEqual(['model-bytes', 'voice-bytes']);
        expect(open.mock.calls.map(([name]) => name)).toEqual([LOCAL_TTS_MODEL_CACHE_NAME, LOCAL_TTS_VOICE_CACHE_NAME]);
        expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('rejects an unmarked main alias through the public prepare message without falling through to network', async () => {
        const loader = getLocalTtsModelLoaderUrl('config.json');
        vi.stubGlobal('caches', {open: vi.fn(async () => ({
            match: async (url: string) => url === loader ? new Response('unknown-version') : undefined,
        }))});
        const nativeFetch = vi.fn(async () => { throw new Error('No implicit download allowed'); });
        vi.stubGlobal('fetch', nativeFetch);
        mocks.fromPretrained.mockImplementation(async () => {
            const {env} = await import('@huggingface/transformers-kokoro');
            await env.fetch(loader);
            return modelFrom(() => audioChunks([0.5]));
        });
        const workerScope = await start();
        const response = await send(workerScope, {requestId: 31, type: 'prepare', device: 'wasm'}, 1);
        expect(response).toMatchObject({requestId: 31, success: false, error: `本地 TTS 缓存缺少模型文件：${loader}`});
        expect(response).not.toHaveProperty('retryWithCpu');
        expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('prefers WebGPU and reports initialization failure for a fresh CPU worker', async () => {
        mocks.fromPretrained.mockRejectedValueOnce(new Error('webgpu init failed'));
        const workerScope = await start();

        const response = await send(workerScope, {requestId: 1, type: 'prepare'}, 1);
        expect(response).toMatchObject({requestId: 1, success: false, retryWithCpu: true});
        expect(response.error).toBe('webgpu init failed');
        expect(mocks.fromPretrained.mock.calls.map(([_, options]) => options.device)).toEqual(['webgpu']);
        expect(mocks.probeWebGpu).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();
    });

    it('discards partial GPU audio, releases the GPU model, and reports a fresh CPU retry hint', async () => {
        const gpuDispose = vi.fn();
        const gpuModel = modelFrom(audioThenError, gpuDispose);
        mocks.fromPretrained.mockResolvedValueOnce(gpuModel);
        const workerScope = await start();

        const response = await send(workerScope, {
            requestId: 3,
            type: 'synthesize',
            text: 'first sentence. second sentence.',
            voice: 'zf_001',
            speed: 1,
        }, 1);

        expect(response).toMatchObject({requestId: 3, success: false, retryWithCpu: true});
        expect(gpuModel.stream).toHaveBeenCalledOnce();
        expect(gpuModel.stream.mock.calls[0][0]).toBe('first sentence. second sentence.');
        expect(gpuDispose).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();

        const wasmModel = modelFrom(() => audioChunks([0.5]));
        mocks.fromPretrained.mockReset().mockResolvedValue(wasmModel);
        const cpuWorkerScope = await start();
        const recovered = await send(cpuWorkerScope, {
            requestId: 4,
            type: 'synthesize',
            device: 'wasm',
            text: 'first sentence. second sentence.',
            voice: 'zf_001',
            speed: 1,
        }, 1);
        expect(recovered).toMatchObject({requestId: 4, success: true, backend: 'wasm'});
        expect(wasmModel.stream).toHaveBeenCalledOnce();
        expect(wasmModel.stream.mock.calls[0][0]).toBe('first sentence. second sentence.');
    });

    it('treats NaN GPU audio as an inference failure and reports a fresh CPU retry hint', async () => {
        const gpuDispose = vi.fn();
        const gpuModel = modelFrom(() => audioChunks([Number.NaN]), gpuDispose);
        mocks.fromPretrained.mockResolvedValueOnce(gpuModel);
        const workerScope = await start();

        const response = await send(workerScope, {requestId: 10, type: 'synthesize', text: 'NaN audio'}, 1);
        expect(response).toMatchObject({requestId: 10, success: false, retryWithCpu: true});
        expect(response.error).toContain('本地 TTS 生成了无效音频');
        expect(gpuDispose).toHaveBeenCalledOnce();
        expect(gpuModel.stream).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();
    });

    it('rejects silent CPU audio without retrying or emitting a WAV', async () => {
        mocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const cpuModel = modelFrom(() => audioChunks([0, -0, 0]));
        mocks.fromPretrained.mockResolvedValue(cpuModel);
        const workerScope = await start();

        const response = await send(workerScope, {requestId: 11, type: 'synthesize', text: 'silent audio'}, 1);
        expect(response).toMatchObject({requestId: 11, success: false, error: '本地 TTS 生成了静音音频'});
        expect(cpuModel.stream).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();
    });

    it('rejects non-finite CPU audio without retrying', async () => {
        mocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const cpuModel = modelFrom(() => audioChunks([Number.NaN, 0.2]));
        mocks.fromPretrained.mockResolvedValue(cpuModel);
        const workerScope = await start();

        const response = await send(workerScope, {requestId: 12, type: 'synthesize', text: 'invalid audio'}, 1);
        expect(response).toMatchObject({requestId: 12, success: false});
        expect(response.error).toContain('本地 TTS 生成了无效音频');
        expect(cpuModel.stream).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();
    });

    it('does not retry a pure CPU stream error or damage the serial queue', async () => {
        mocks.probeWebGpu.mockResolvedValue({available: false, info: ''});
        const cpuModel = modelFrom(errorStream);
        mocks.fromPretrained.mockResolvedValue(cpuModel);
        const workerScope = await start();

        const failed = await send(workerScope, {requestId: 5, type: 'synthesize', text: 'CPU only'}, 1);
        expect(failed).toMatchObject({requestId: 5, success: false, error: 'cpu stream failed'});
        expect(cpuModel.stream).toHaveBeenCalledOnce();
        expect(mocks.fromPretrained).toHaveBeenCalledOnce();

        const prepared = await send(workerScope, {requestId: 6, type: 'prepare'}, 2);
        expect(prepared).toMatchObject({requestId: 6, success: true, backend: 'wasm'});
    });

    it('honors an internal WASM request by releasing GPU and locking the worker to CPU', async () => {
        const gpuDispose = vi.fn();
        const gpuModel = modelFrom(() => audioChunks([0.1]), gpuDispose);
        const wasmModel = modelFrom(() => audioChunks([0.2]));
        mocks.fromPretrained
            .mockResolvedValueOnce(gpuModel)
            .mockResolvedValueOnce(wasmModel);
        const workerScope = await start();

        await send(workerScope, {requestId: 7, type: 'prepare'}, 1);
        const forced = await send(workerScope, {requestId: 8, type: 'prepare', device: 'wasm'}, 2);
        expect(forced).toMatchObject({requestId: 8, success: true, backend: 'wasm'});
        expect(gpuDispose).toHaveBeenCalledOnce();

        await send(workerScope, {requestId: 9, type: 'prepare'}, 3);
        expect(mocks.fromPretrained.mock.calls.map(([_, options]) => options.device)).toEqual(['webgpu', 'wasm']);
    });
});
