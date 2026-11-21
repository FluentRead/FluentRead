/**
 * @file src/features/local-translation/offscreen/translation.worker.ts
 *
 * 文件职责：在隔离 Worker 中运行轻量 OPUS 翻译和混元 Hy-MT2 翻译。
 * 主要内容：只读取已校验的离线模型；混元保留段落上下文，遇到生成上限时缩小分段，WebGPU 推理失败时释放旧实例并切换到同一模型的 CPU 推理；ONNX 按句翻译并保留单线程恢复。
 * 模块边界：入站先经 feature 公共协议校验，不下载模型、不读取页面配置；空闲释放、请求取消和最终超时由外层 Worker 生命周期控制。
 */
import {forceSingleThreadInference, localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {env, InterruptableStoppingCriteria, pipeline} from '@huggingface/transformers';
import {Wllama} from '@wllama/wllama/esm/index.js';
import {
    getLocalTranslationModel, resolveOpusTranslationRepository,
    LOCAL_TRANSLATION_DTYPE, LOCAL_TRANSLATION_MODEL_REMOTE_HOST,
} from '@/src/core/config/localTranslation';
import {assertLocalTranslationOutput, hunyuanTranslationPrompt, splitLocalTranslationText} from '@/src/core/translation/localInference';
import {getTranslationArtifacts, matchTranslationArtifact, translationArtifactBlob} from './artifactStore';
import {supportsHunyuanTranslation} from '@/src/platform/browser/localTranslationSupport';
import {configureOnnxWasmBackend, withCompressedWasmBinary} from '@/src/shared/onnx/wasmBinary';
import {readWorkerRequestId} from '@/src/core/messaging/validation';
import {parseLocalTranslationWorkerRequest, type LocalTranslationWorkerRequest as WorkerRequest, type LocalTranslationWorkerResponse as WorkerResponse} from '../workerProtocol';

type Translator = ((text: string, options?: Record<string, unknown>) => Promise<unknown>) & {dispose?: () => Promise<void>};
type TranslateRequest = Extract<WorkerRequest, {type: 'translate'}>;

interface HunyuanSession {
    engine: Wllama;
    requestedGpu: boolean;
}

class HunyuanOutputLimitError extends Error {
    constructor() { super('LOCAL_TRANSLATION_OUTPUT_LIMIT'); }
}

const MAX_INFERENCE_MS = 90_000;
const HUNYUAN_RETRY_CHUNK_LENGTH = 160;
let translator: Translator | undefined;
let translatorRepository = '';
let hunyuan: HunyuanSession | undefined;
let backend: WorkerResponse['backend'];
let taskQueue = Promise.resolve();

function extensionUrl(path: string): string { return new URL(path, self.location.href).toString(); }

function configureEnvironment(): void {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = extensionUrl('local-models/');
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = true;
    env.customCache = {
        match: async (request: string | Request) => {
            const key = typeof request === 'string' ? request : (request as Request).url;
            // Avoid even a local missing-file probe for optional tokenizer metadata.
            if (key.startsWith(env.localModelPath)) return undefined;
            return await matchTranslationArtifact(key)
                || await (await caches.open('transformers-cache')).match(key);
        },
        put: async () => { throw new Error('LOCAL_TRANSLATION_NOT_DOWNLOADED'); },
    };
    env.remoteHost = LOCAL_TRANSLATION_MODEL_REMOTE_HOST;
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = localWasmThreads();
        configureOnnxWasmBackend(env.backends.onnx.wasm, {
            mjs: extensionUrl('fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs'),
            wasm: extensionUrl('fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'),
        });
    }
}

async function dispose(): Promise<void> {
    backend = undefined;
    const previousTranslator = translator;
    const previousHunyuan = hunyuan;
    translator = undefined;
    translatorRepository = '';
    hunyuan = undefined;
    // 释放失败也不能让损坏会话继续占用缓存；下一条队列请求应能够创建新实例。
    try { await previousTranslator?.dispose?.(); }
    finally { await previousHunyuan?.engine.exit(); }
}

async function getTranslator(request: TranslateRequest): Promise<Translator> {
    const item = getLocalTranslationModel(request.model);
    const repository = item.engine === 'opus'
        ? resolveOpusTranslationRepository(request.model, request.sourceLanguage!, request.targetLanguage!) : request.model;
    if (translator && translatorRepository === repository) return translator;
    await dispose();
    const revision = getTranslationArtifacts(request.model).find((file) => file.repo === repository)?.revision || 'main';
    const create = () => pipeline('translation', repository, {
        device: 'wasm', dtype: LOCAL_TRANSLATION_DTYPE, revision, local_files_only: true,
        // OPUS q8 的合并权重不兼容此 ORT 版本的 QDQ 转置优化；只排除此优化器，保留其余完整图优化。
        session_options: {
            graphOptimizationLevel: 'all',
            extra: {optimization: {disable_specified_optimizers: 'QDQSelectorActionTransformer'}},
            enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential',
        },
    }) as unknown as Promise<Translator>;
    const wasm = env.backends.onnx.wasm;
    translator = await paceLocalInitialization(() => wasm
        ? withCompressedWasmBinary(wasm, extensionUrl('fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm'), create)
        : create());
    translatorRepository = repository;
    backend = 'wasm';
    return translator;
}

function assertInferenceActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('LOCAL_TRANSLATION_TIMEOUT');
}

async function getHunyuan(model: string, preferGpu = true, signal?: AbortSignal): Promise<HunyuanSession> {
    if (!supportsHunyuanTranslation()) throw new Error('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED');
    if (hunyuan && (preferGpu || !hunyuan.requestedGpu)) return hunyuan;
    await dispose();
    assertInferenceActive(signal);
    const file = getTranslationArtifacts(model)[0];
    if (!file) throw new Error('LOCAL_TRANSLATION_INVALID_MODEL');
    const blob = await translationArtifactBlob(file);
    const load = async (requestedGpu: boolean): Promise<HunyuanSession> => {
        assertInferenceActive(signal);
        const engine = new Wllama({default: extensionUrl('fluent-read-ai/wllama.wasm')}, {
            suppressNativeLog: true,
            logger: {debug() {}, log() {}, warn() {}, error() {}},
        });
        engine.setCompat(null);
        try {
            await paceLocalInitialization(() => engine.loadModel([blob], {
                n_ctx: 2048, n_batch: 128, n_ubatch: 64, n_threads: 1, n_parallel: 1,
                n_gpu_layers: requestedGpu ? 99 : 0, warmup: false, jinja: true,
                cache_idle_slots: false, ctx_shift: false,
            }));
        } catch (error) {
            await engine.exit().catch(() => undefined);
            throw error;
        }
        // 能力探测和请求 GPU 层数不证明实际卸载；无执行证据时保持未知。
        backend = requestedGpu ? undefined : 'wasm';
        return {engine, requestedGpu};
    };
    const requestGpu = preferGpu && 'gpu' in navigator && 'Suspending' in WebAssembly;
    try {
        hunyuan = await load(requestGpu);
    } catch (error) {
        if (!requestGpu) throw error;
        hunyuan = await load(false);
    }
    return hunyuan;
}

async function translateChunks(
    chunks: readonly string[],
    infer: (text: string) => Promise<string>,
    signal: AbortSignal,
): Promise<string> {
    const results: string[] = [];
    for (const chunk of chunks) {
        assertInferenceActive(signal);
        const text = chunk.trim();
        if (!text) { results.push(chunk); continue; }
        const translated = await infer(text);
        assertInferenceActive(signal);
        results.push((chunk.match(/^\s*/u)?.[0] || '') + translated.trim() + (chunk.match(/\s*$/u)?.[0] || ''));
        await new Promise((resolve) => self.setTimeout(resolve, 0));
    }
    assertInferenceActive(signal);
    return results.join('');
}

async function translateHunyuanChunk(
    model: string,
    source: string,
    sourceLanguage: string,
    targetLanguage: string,
    signal: AbortSignal,
): Promise<string> {
    async function infer(text: string): Promise<string> {
        const prompt = hunyuanTranslationPrompt(text, sourceLanguage, targetLanguage);
        const session = await getHunyuan(model);
        const complete = async (engine: Wllama) => {
            assertInferenceActive(signal);
            const response = await paceLocalInference(() => engine.createChatCompletion({
                messages: [{role: 'user', content: prompt}],
                max_tokens: 768, temperature: 0.7, top_p: 0.6, top_k: 20,
                penalty_repeat: 1.05, seed: 42, cache_prompt: false, abortSignal: signal,
            }));
            assertInferenceActive(signal);
            const choice = response.choices[0];
            const output = choice?.message.content || '';
            const reachedLimit = choice?.finish_reason === 'length';
            // 先识别输出失控形成的重复，再决定是否真的需要拆小原文。
            if (!reachedLimit || output.trim()) assertLocalTranslationOutput(output, text);
            if (reachedLimit) throw new HunyuanOutputLimitError();
            return output;
        };
        try {
            return await complete(session.engine);
        } catch (error) {
            assertInferenceActive(signal);
            if (!session.requestedGpu || error instanceof HunyuanOutputLimitError) throw error;
            // 释放 WebGPU 实例后再加载 CPU 实例，并复用它处理剩余片段和后续请求。
            const cpu = await getHunyuan(model, false, signal);
            return complete(cpu.engine);
        }
    }
    try {
        return await infer(source);
    } catch (error) {
        if (!(error instanceof HunyuanOutputLimitError)) throw error;
        const smaller = splitLocalTranslationText(source, HUNYUAN_RETRY_CHUNK_LENGTH, 'paragraph');
        if (smaller.length < 2) throw error;
        return translateChunks(smaller, infer, signal);
    }
}

async function translate(request: TranslateRequest): Promise<string> {
    const {text, model, sourceLanguage, targetLanguage} = request;
    if (!text?.trim() || !sourceLanguage || !targetLanguage) throw new Error('LOCAL_TRANSLATION_INVALID_REQUEST');
    const isHunyuan = getLocalTranslationModel(model).engine === 'hunyuan';
    const onnx = isHunyuan ? undefined : await getTranslator(request);
    if (isHunyuan) await getHunyuan(model);
    const abort = new AbortController();
    const stop = new InterruptableStoppingCriteria();
    const timer = self.setTimeout(() => { abort.abort(); stop.interrupt(); }, MAX_INFERENCE_MS);
    try {
        const chunks = splitLocalTranslationText(text, undefined, isHunyuan ? 'paragraph' : 'sentence');
        if (!onnx) {
            return await translateChunks(chunks, (source) =>
                translateHunyuanChunk(model, source, sourceLanguage, targetLanguage, abort.signal), abort.signal);
        }
        return await translateChunks(chunks, async (source) => {
            const output = await paceLocalInference(() => onnx(source, {
                src_lang: sourceLanguage, tgt_lang: targetLanguage,
                max_new_tokens: 512, do_sample: false, num_beams: 1,
                no_repeat_ngram_size: 4, repetition_penalty: 1.1, stopping_criteria: stop,
            }));
            assertInferenceActive(abort.signal);
            const first = Array.isArray(output) ? output[0] : output;
            const translated = (first as {translation_text?: string})?.translation_text || '';
            assertLocalTranslationOutput(translated, source);
            return translated;
        }, abort.signal);
    } catch (error) {
        assertInferenceActive(abort.signal);
        throw error;
    } finally {
        self.clearTimeout(timer);
    }
}

export function startLocalTranslationWorker(): void {
    configureEnvironment();
    const post = (response: WorkerResponse) => self.postMessage(response);
    self.addEventListener('message', (event: MessageEvent<unknown>) => {
        const requestId = readWorkerRequestId(event.data);
        if (requestId === undefined) return;
        let request: WorkerRequest;
        try { request = parseLocalTranslationWorkerRequest(event.data); }
        catch (error) { post({requestId, success: false, error: error instanceof Error ? error.message : 'LOCAL_TRANSLATION_INVALID_REQUEST'}); return; }
        const run = async () => {
            try {
                if (request.singleThread) {forceSingleThreadInference(); configureEnvironment();}
                if (request.type === 'dispose') { await dispose(); post({requestId: request.requestId, success: true}); return; }
                const started = performance.now();
                const result = await translate(request);
                post({requestId: request.requestId, success: true, result, ...(backend === undefined ? {} : {backend}), elapsedMs: performance.now() - started});
            } catch (error) {
                const retrySingleThread = request.type === 'translate'
                    && getLocalTranslationModel(request.model).engine !== 'hunyuan' && localWasmThreads() > 1;
                post({requestId: request.requestId, success: false, error: error instanceof Error ? error.message : 'LOCAL_TRANSLATION_FAILED', ...(retrySingleThread ? {retrySingleThread: true} : {})});
            }
        };
        taskQueue = taskQueue.then(run, run);
    });
}
