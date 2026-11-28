/**
 * @file src/features/local-tts/offscreen/tts.worker.ts
 * 文件职责：在独立 Worker 中加载并运行 Kokoro v1.1 中文 TTS，避免推理阻塞 Offscreen DOM。
 * 主要内容：验证固定版本缓存及精确匹配的当前或历史镜像来源，保持已下载音色离线可用；处理 WebGPU/WASM 回退、有界线程与仅针对 CPU 的推理节流，串行合成并单遍完成 PCM16 校验与 WAV 编码，保留带去空白回退的真实句段时间。
 * 模块边界：只运行本地模型，入站消息先经 feature 公共协议校验；不访问配置、网页、标签页或直接播放 Audio。
 */

import type {SpeechCue} from '@/src/core/tts/speechProgress';
import {isModelCacheSource} from '@/src/platform/http/modelDownloads';
import {forceSingleThreadInference, localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {KokoroTTS, env as kokoroEnv} from '@uzen/kokoro-js';
import {env as kokoroTransformersEnv} from '@huggingface/transformers-kokoro';
import {
    LOCAL_TTS_MODEL_DTYPE,
    LOCAL_TTS_MODEL_FILE_NAME,
    LOCAL_TTS_MODEL_REPOSITORY,
    LOCAL_TTS_MODEL_REVISION,
    LOCAL_TTS_VOICE_PATH,
} from '@/src/core/config/localTts';
import {configureOnnxWasmBackend, resolveOnnxWasmAssetPaths, withCompressedWasmBinary} from '@/src/shared/onnx/wasmBinary';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {readWorkerRequestId} from '@/src/core/messaging/validation';
import type {InferenceBackend} from '@/src/core/messaging/offscreen';
import {parseLocalTtsWorkerRequest, type LocalTtsWorkerRequest as WorkerRequest, type LocalTtsWorkerResponse as WorkerResponse} from '../protocol';

type LocalTtsDevice = InferenceBackend;

let modelPromise: Promise<KokoroTTS> | null = null;
let modelBackend: LocalTtsDevice | undefined;
let taskQueue: Promise<void> = Promise.resolve();
let fetchPatched = false;
let gpuUnavailable = false;
let cpuLocked = false;
let gpuProbePromise: Promise<boolean> | null = null;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function retryWithCpuError(error: unknown): Error & {retryWithCpu: true} {
    const wrapped = error instanceof Error ? error : new Error(errorMessage(error));
    return Object.assign(wrapped, {retryWithCpu: true as const});
}

function shouldRetryWithCpu(error: unknown): error is {retryWithCpu: true} {
    return typeof error === 'object' && error !== null && (error as {retryWithCpu?: unknown}).retryWithCpu === true;
}

function extensionUrl(path: string): string {
    const getUrl = (globalThis as typeof globalThis & {
        chrome?: {runtime?: {getURL?: (value: string) => string}};
    }).chrome?.runtime?.getURL;
    return getUrl?.(path) || new URL(path, self.location.href).toString();
}

function requestUrl(input: RequestInfo | URL): string {
    return typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.toString()
            : input.url;
}

function modelCacheUrls(url: string): string[] {
    const mainPrefix = `/${LOCAL_TTS_MODEL_REPOSITORY}/resolve/main/`;
    const pinnedPrefix = `/${LOCAL_TTS_MODEL_REPOSITORY}/resolve/${LOCAL_TTS_MODEL_REVISION}/`;
    if (url.includes(mainPrefix)) return [url.replace(mainPrefix, pinnedPrefix), url];
    if (url.includes(pinnedPrefix)) return [url, url.replace(pinnedPrefix, mainPrefix)];
    return [url];
}

async function localCacheFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    nativeFetch: typeof fetch,
): Promise<Response> {
    const url = requestUrl(input);
    // 音色 URL 也属于模型仓库的 resolve 命名空间；其它扩展资源保留原生 fetch。
    if (!url.includes(`/${LOCAL_TTS_MODEL_REPOSITORY}/resolve/`)) return nativeFetch(input, init);
    if (typeof caches === 'undefined') throw new Error('本地 TTS 缓存不可用');

    const isVoiceFile = url.startsWith(`${LOCAL_TTS_VOICE_PATH}/`);
    const cache = await caches.open(isVoiceFile ? 'kokoro-voices' : 'transformers-cache');
    const cacheUrls = modelCacheUrls(url);
    const pinnedUrl = cacheUrls[0];
    for (const cacheUrl of cacheUrls) {
        const cached = await cache.match(cacheUrl);
        if (cached?.ok) {
            const source = cached.headers.get('X-FluentRead-Model-Source');
            if ((source !== null && isModelCacheSource(pinnedUrl, source))
                || (cacheUrl === pinnedUrl && source === null)) return cached;
        }
    }
    throw new Error(`本地 TTS 缓存缺少模型文件：${url}`);
}

/** @remarks @uzen/kokoro-js 没有 revision 参数；模型 URL 只允许读取固定版本的本地缓存。 */
function installLocalOnlyFetch(): void {
    if (fetchPatched) return;
    fetchPatched = true;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const offlineFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => localCacheFetch(input, init, nativeFetch);
    globalThis.fetch = offlineFetch as typeof fetch;
    kokoroTransformersEnv.fetch = offlineFetch;
}

function configureRuntime(): void {
    installLocalOnlyFetch();
    kokoroEnv.allowLocalModels = false;
    kokoroTransformersEnv.allowLocalModels = false;
    // Transformers.js uses the remote model namespace as the Cache Storage key;
    // offlineFetch above prevents a cache miss from reaching the network.
    kokoroTransformersEnv.allowRemoteModels = true;
    // 通过验证固定版本的 offlineFetch 只读缓存，避免库误读旧 main 或写入重复权重。
    kokoroTransformersEnv.useBrowserCache = false;
    // MV3 extension CSP rejects the blob URL generated by the WASM factory
    // pre-cache path; keep the MJS static and inject the packaged CPU/WebGPU WASM binary.
    kokoroTransformersEnv.useWasmCache = false;
    const onnxAssets = resolveOnnxWasmAssetPaths(extensionUrl);
    if (kokoroTransformersEnv.backends.onnx.wasm) {
        kokoroTransformersEnv.backends.onnx.wasm.numThreads = localWasmThreads();
        configureOnnxWasmBackend(kokoroTransformersEnv.backends.onnx.wasm, onnxAssets);
    }
    kokoroEnv.wasmPaths = onnxAssets;
}

async function createModel(device: LocalTtsDevice): Promise<KokoroTTS> {
    configureRuntime();
    const create = () => KokoroTTS.from_pretrained(LOCAL_TTS_MODEL_REPOSITORY, {
        dtype: LOCAL_TTS_MODEL_DTYPE,
        device,
        model_file_name: LOCAL_TTS_MODEL_FILE_NAME,
        voicePath: LOCAL_TTS_VOICE_PATH,
    });
    const wasm = kokoroTransformersEnv.backends.onnx.wasm;
    return paceLocalInitialization(() => wasm
        ? withCompressedWasmBinary(wasm, resolveOnnxWasmAssetPaths(extensionUrl).wasm, create)
        : create());
}

async function hasUsableWebGpu(): Promise<boolean> {
    if (cpuLocked || gpuUnavailable) return false;
    if (!gpuProbePromise) {
        gpuProbePromise = probeWebGpu()
            .then((result) => result.available)
            .catch(() => false);
    }
    return gpuProbePromise;
}

function loadModel(device: LocalTtsDevice): Promise<KokoroTTS> {
    const loading = createModel(device)
        .then((model) => {
            modelBackend = device;
            return model;
        });
    let settled!: Promise<KokoroTTS>;
    settled = loading
        .catch((error) => {
            if (modelPromise === settled) modelPromise = null;
            modelBackend = undefined;
            throw error;
        });
    modelPromise = settled;
    return settled;
}

async function getModel(): Promise<KokoroTTS> {
    if (modelPromise) return modelPromise;
    const preferred: LocalTtsDevice = (await hasUsableWebGpu()) ? 'webgpu' : 'wasm';
    try {
        return await loadModel(preferred);
    } catch (error) {
        if (preferred !== 'webgpu' && localWasmThreads() === 1) throw error;
        // GPU 初始化可能已污染当前 ORT runtime；外层必须重建 Worker 后再尝试 CPU。
        gpuUnavailable = true;
        throw retryWithCpuError(error);
    }
}

function concatAudio(chunks: readonly Float32Array[]): Float32Array {
    const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
    const output = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

function floatToPcm16(value: number): number {
    const clamped = Math.max(-1, Math.min(1, value));
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function validateAndEncodeWav(chunks: readonly Float32Array[], sampleRate: number | undefined): ArrayBuffer {
    let totalSamples = 0;
    for (const chunk of chunks) totalSamples += chunk.length;
    if (totalSamples === 0) throw new Error('本地 TTS 生成了静音音频');
    const dataLength = totalSamples * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    let hasSignal = false;
    let invalidSamples = 0;
    let offset = 44;
    for (const chunk of chunks) {
        for (let index = 0; index < chunk.length; index += 1) {
            const sample = chunk[index];
            if (!Number.isFinite(sample)) {
                invalidSamples += 1;
                offset += 2;
                continue;
            }
            const pcm = floatToPcm16(sample);
            if (pcm !== 0) hasSignal = true;
            view.setInt16(offset, pcm, true);
            offset += 2;
        }
    }
    if (invalidSamples) throw new Error(`本地 TTS 生成了无效音频（${invalidSamples}/${totalSamples} 个采样）`);
    if (!hasSignal) throw new Error('本地 TTS 生成了静音音频');
    const writeAscii = (pos: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) view.setUint8(pos + index, value.charCodeAt(index));
    };
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate!, true);
    view.setUint32(28, sampleRate! * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);
    return buffer;
}

async function synthesizeWithModel(
    model: KokoroTTS,
    text: string,
    voice: string,
    speed: number,
): Promise<{audio: ArrayBuffer; samplingRate: number; timings: SpeechCue[]}> {
    const chunks: Float32Array[] = [];
    let samplingRate: number | undefined;
    const timings: SpeechCue[] = [];
    let seconds = 0, cursor = 0;
    const stream = model.stream(text, {voice: voice as never, speed, maxChunkLength: 180})[Symbol.asyncIterator]();
    while (true) {
        // WebGPU 推理不占用主 CPU 预算，仅 WASM 路径节流以保护页面流畅度。
        const next = modelBackend === 'webgpu'
            ? await stream.next()
            : await paceLocalInference(() => stream.next());
        if (next.done) break;
        const item = next.value;
        const rate = item.audio.sampling_rate;
        if (!Number.isSafeInteger(rate) || rate <= 0 || rate > 0x7fffffff
            || (samplingRate !== undefined && samplingRate !== rate)) throw new Error('本地 TTS 音频采样率无效或不一致');
        const samples = item.audio.audio;
        chunks.push(samples instanceof Float32Array ? samples.slice() : concatAudio(samples));
        samplingRate = rate;
        const chunk = chunks.at(-1)!;
        let matchedText = typeof item.text === 'string' && item.text ? item.text : '';
        let start = matchedText ? text.indexOf(matchedText, cursor) : -1;
        if (start < 0 && matchedText) {
            const trimmed = matchedText.trim();
            if (trimmed && trimmed !== matchedText) {
                start = text.indexOf(trimmed, cursor);
                if (start >= 0) matchedText = trimmed;
            }
        }
        if (start >= 0 && chunk.length > 0) {
            timings.push({startChar: start, endChar: start + matchedText.length, startTime: seconds, endTime: seconds + chunk.length / samplingRate});
            cursor = start + matchedText.length;
        }
        seconds += chunk.length / samplingRate;
    }
    const audio = validateAndEncodeWav(chunks, samplingRate);
    return {audio, samplingRate: samplingRate!, timings};
}

async function synthesize(request: WorkerRequest): Promise<{audio: ArrayBuffer; samplingRate: number; timings: SpeechCue[]}> {
    const text = request.text?.trim() || '';
    if (!text) throw new Error('本地 TTS 文本为空');
    const voice = request.voice?.trim() || 'zf_001';
    const speed = typeof request.speed === 'number' && Number.isFinite(request.speed)
        ? Math.min(2, Math.max(0.5, request.speed))
        : 1;
    const model = await getModel();
    const backend = modelBackend;
    try {
        return await synthesizeWithModel(model, text, voice, speed);
    } catch (error) {
        if (backend !== 'webgpu') throw error;
        // 局部 chunks 只存在于上一次调用的栈中；释放 GPU session 后从整段文本重试一次。
        gpuUnavailable = true;
        await disposeModel();
        throw retryWithCpuError(error);
    }
}

async function lockCpuForWorker(): Promise<void> {
    forceSingleThreadInference();
    cpuLocked = true;
    gpuUnavailable = true;
    if (modelBackend === 'webgpu') await disposeModel();
}

async function disposeModel(): Promise<void> {
    const current = modelPromise;
    modelPromise = null;
    modelBackend = undefined;
    if (!current) return;
    try {
        const model = await current;
        await (model.model as unknown as {dispose?: () => Promise<void> | void}).dispose?.();
    } catch {
        // Worker termination remains the final resource boundary.
    }
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = taskQueue.then(operation, operation);
    taskQueue = run.then(() => undefined, () => undefined);
    return run;
}

function post(response: WorkerResponse): void {
    const workerScope = self as unknown as {postMessage(message: unknown, transfer?: Transferable[]): void};
    if (response.audio) workerScope.postMessage(response, [response.audio]);
    else workerScope.postMessage(response);
}

async function handle(request: WorkerRequest): Promise<void> {
    try {
        if (request.device === 'wasm') await lockCpuForWorker();
        if (request.type === 'dispose') {
            await disposeModel();
            post({requestId: request.requestId, success: true});
            return;
        }
        if (request.type === 'prepare') {
            await getModel();
            post({requestId: request.requestId, success: true, backend: modelBackend});
            return;
        }
        const result = await synthesize(request);
        post({
            requestId: request.requestId,
            success: true,
            audio: result.audio,
            samplingRate: result.samplingRate,
            timings: result.timings,
            backend: modelBackend,
        });
    } catch (error) {
        post({
            requestId: request.requestId,
            success: false,
            error: errorMessage(error),
            ...(shouldRetryWithCpu(error) ? {retryWithCpu: true as const} : {}),
        });
    }
}

export function startLocalTtsWorker(): void {
    self.onmessage = (event: MessageEvent<unknown>) => {
        const requestId = readWorkerRequestId(event.data);
        if (requestId === undefined) return;
        let request: WorkerRequest;
        try { request = parseLocalTtsWorkerRequest(event.data); }
        catch (error) { post({requestId, success: false, error: errorMessage(error)}); return; }
        void enqueue(() => handle(request));
    };
}
