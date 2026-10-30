/**
 * @file src/features/local-translation/offscreen/translation.worker.ts
 *
 * 文件职责：在隔离 Worker 中运行轻量 OPUS 翻译和混元 Hy-MT2 翻译。
 * 主要内容：只读取已校验的离线模型；混元优先使用 WebGPU，OPUS 保持 CPU；复用有界线程与计算间歇，失败重建单线程 Worker，分句推理和重复保护约束资源与输出。
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
const MAX_INFERENCE_MS = 90_000;
let translator: Translator | undefined;
let translatorRepository = '';
let hunyuan: Wllama | undefined;
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
    finally { await previousHunyuan?.exit(); }
}

async function getTranslator(request: Extract<WorkerRequest, {type: 'translate'}>): Promise<Translator> {
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

async function getHunyuan(model: string): Promise<Wllama> {
    if (!supportsHunyuanTranslation()) throw new Error('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED');
    if (hunyuan) return hunyuan;
    await dispose();
    const file = getTranslationArtifacts(model)[0];
    if (!file) throw new Error('LOCAL_TRANSLATION_INVALID_MODEL');
    const blob = await translationArtifactBlob(file);
    const makeEngine = () => {
        const engine = new Wllama({default: extensionUrl('fluent-read-ai/wllama.wasm')}, {
            suppressNativeLog: true,
            logger: {debug() {}, log() {}, warn() {}, error() {}},
        });
        engine.setCompat(null);
        return engine;
    };
    const supportsGpu = 'gpu' in navigator && 'Suspending' in WebAssembly;
    let engine = makeEngine();
    const load = (gpu: boolean) => paceLocalInitialization(() => engine.loadModel([blob], {
        n_ctx: 2048, n_batch: 128, n_ubatch: 64, n_threads: 1, n_parallel: 1,
        n_gpu_layers: gpu ? 99 : 0, warmup: false, jinja: true,
        cache_idle_slots: false, ctx_shift: false,
    }));
    try {
        await load(supportsGpu);
        // 能力探测和请求 GPU 层数不证明实际卸载；无执行证据时保持未知。
        backend = supportsGpu ? undefined : 'wasm';
    } catch (error) {
        await engine.exit().catch(() => undefined);
        if (!supportsGpu) throw error;
        engine = makeEngine();
        try { await load(false); } catch (fallbackError) { await engine.exit().catch(() => undefined); throw fallbackError; }
        backend = 'wasm';
    }
    hunyuan = engine;
    return engine;
}

async function translate(request: Extract<WorkerRequest, {type: 'translate'}>): Promise<string> {
    if (!request.text?.trim() || !request.sourceLanguage || !request.targetLanguage) throw new Error('LOCAL_TRANSLATION_INVALID_REQUEST');
    const isHunyuan = getLocalTranslationModel(request.model).engine === 'hunyuan';
    const engine = isHunyuan ? await getHunyuan(request.model) : await getTranslator(request);
    const abort = new AbortController();
    const stop = new InterruptableStoppingCriteria();
    const timer = self.setTimeout(() => { abort.abort(); stop.interrupt(); }, MAX_INFERENCE_MS);
    try {
        const chunks = splitLocalTranslationText(request.text);
        const results: string[] = [];
        for (const chunk of chunks) {
            if (!chunk.trim()) { results.push(chunk); continue; }
            let translated: string;
            if (isHunyuan) {
                const response = await paceLocalInference(() => (engine as Wllama).createChatCompletion({
                    messages: [{role: 'user', content: hunyuanTranslationPrompt(chunk.trim(), request.sourceLanguage!, request.targetLanguage!)}],
                    max_tokens: 768, temperature: 0.7, top_p: 0.6, top_k: 20,
                    penalty_repeat: 1.05, seed: 42, cache_prompt: false, abortSignal: abort.signal,
                }));
                if (response.choices[0]?.finish_reason === 'length') throw new Error('LOCAL_TRANSLATION_OUTPUT_LIMIT');
                translated = response.choices[0]?.message.content || '';
            } else {
                const output = await paceLocalInference(() => (engine as Translator)(chunk.trim(), {
                    src_lang: request.sourceLanguage, tgt_lang: request.targetLanguage,
                    max_new_tokens: 512, do_sample: false, num_beams: 1,
                    no_repeat_ngram_size: 4, repetition_penalty: 1.1, stopping_criteria: stop,
                }));
                const first = Array.isArray(output) ? output[0] : output;
                translated = (first as {translation_text?: string})?.translation_text || '';
            }
            if (abort.signal.aborted || stop.interrupted) throw new Error('LOCAL_TRANSLATION_TIMEOUT');
            assertLocalTranslationOutput(translated, chunk);
            results.push((chunk.match(/^\s*/u)?.[0] || '') + translated.trim() + (chunk.match(/\s*$/u)?.[0] || ''));
            await new Promise((resolve) => self.setTimeout(resolve, 0));
        }
        return results.join('');
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
                post({requestId: request.requestId, success: false, error: error instanceof Error ? error.message : 'LOCAL_TRANSLATION_FAILED', ...(localWasmThreads()>1?{retrySingleThread:true}:{})});
            }
        };
        taskQueue = taskQueue.then(run, run);
    });
}
