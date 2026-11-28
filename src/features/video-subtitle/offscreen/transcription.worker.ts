/**
 * @file src/features/video-subtitle/offscreen/transcription.worker.ts
 * 文件职责：运行独立的 Whisper ONNX Worker，复用模型 session 并执行受限时长的本地音频推理。
 * 主要内容：配置 WASM/WebGPU 和分模块精度、串行复用模型，每窗整体只安排一次 CPU 间歇（WebGPU 跳过人工休眠），每窗检测语言并共享特征与编码，跳过数字静音、恢复裁剪偏移，在退化重试时复用已检出语种避免重复语言检测，仅对真实 WebGPU 或多线程 WASM 初始化/推理故障标记 CPU 回退。生成计时器协作停止解码；独立 Offscreen owner 的墙钟超时负责终止 Worker，同线程计时器不保证原生算子中的实时中断。
 * 模块边界：只运行模型与 Worker 消息循环，入站先经唯一 Worker 协议校验；不访问页面 DOM、后台消息或共享 Offscreen 业务状态。
 */
import {forceSingleThreadInference, localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import { env, InterruptableStoppingCriteria, pipeline, Tensor } from '@huggingface/transformers';
import {
  getVideoLocalTranscriptionModelId,
  getVideoLocalTranscriptionInferenceTimeoutMs,
  normalizeVideoLocalTranscriptionModel,
  isDegenerateVideoTranscript,
  prepareWhisperAudioWindow,
  type VideoAiModelDtype,
} from '@/src/features/video-subtitle/transcription';
import {
  VIDEO_AI_MODEL_REMOTE_HOST,
  VIDEO_AI_MODEL_REMOTE_PATH_TEMPLATE,
  cacheVideoAiQ8ModelFiles,
  createVideoAiModelCache,
} from './modelCache';
import {VIDEO_AI_MODEL_REVISION} from '@/src/features/video-subtitle/modelFiles';
import {parseWhisperChunkTimestamps} from './timestampParser';
import {buildWhisperTranscriptionGenerationOptions, chooseWhisperSourceLanguage, normalizeWhisperSourceLanguage, type WhisperDetectedLanguage} from './transcriptionOptions';
import {configureOnnxWasmBackend, resolveOnnxWasmAssetPaths, withCompressedWasmBinary} from '@/src/shared/onnx/wasmBinary';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
import {prepareWhisperEncoderReuse, prepareWhisperProcessorReuse, withWhisperStoppingCriteria, type WhisperAudioProcessor, type WhisperEncoderReuse, type WhisperEncoderReuseModel, type WhisperProcessorReuse} from './whisperEncoderReuse';
import type {InferenceBackend} from '@/src/core/messaging/inference';
import type {VideoTranscriptionResult, VideoTranscriptionSegment} from '@/src/core/messaging/video';
import {readWorkerRequestId} from '@/src/core/messaging/validation';
import {isVideoWorkerDisposal, parseVideoWorkerRequest, type VideoWorkerRequest as WorkerRequest, type VideoWorkerResponse as WorkerResponse} from '../workerProtocol';

type LocalTranscriber = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<unknown>) & {
  dispose?: () => Promise<void>;
  processor?: WhisperAudioProcessor;
  model?: ((inputs: Record<string, unknown>) => Promise<{logits?: {data: ArrayLike<number>; dims?: readonly number[]}}>) & WhisperEncoderReuseModel & {
    config?: {model_type?: unknown; is_encoder_decoder?: unknown; is_multilingual?: unknown; decoder_start_token_id?: unknown};
    generation_config?: {is_multilingual?: unknown; decoder_start_token_id?: unknown; lang_to_id?: unknown};
  };
};

type LocalTranscriptionBackend = InferenceBackend;
type LocalVideoTranscriptionSegment = VideoTranscriptionSegment;
interface WorkerTranscriptionResult extends VideoTranscriptionResult {
  text: string;
  segments: LocalVideoTranscriptionSegment[];
  model: string;
}

class WebGpuFallbackError extends Error {
  readonly retryWithCpu = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WebGpuFallbackError';
  }
}

class WasmThreadFallbackError extends Error {
  readonly retryWithCpu = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WasmThreadFallbackError';
  }
}

let transcriberPromise: Promise<LocalTranscriber> | null = null;
let transcriberModelId = '';
let transcriberBackend: LocalTranscriptionBackend | undefined;
let transcriberGpuInfo = '';
let transcriberThreads = 1;
let transcriberDtype: 'q4' | 'q8' | undefined;
let transcriberEncoderDtype: VideoAiModelDtype | undefined;
let wasmRuntimeThreads: number | null = null;
let webGpuProbePromise: Promise<{available: boolean; info: string}> | null = null;
let webGpuProbeInfo = '';
let webGpuDisabled = false;
let workerTaskQueue: Promise<void> = Promise.resolve();

const MAX_WHISPER_AUDIO_SECONDS = 30;
const ENABLE_VIDEO_WHISPER_WEBGPU = true;

function configureEnvironment(): void {
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.remoteHost = VIDEO_AI_MODEL_REMOTE_HOST;
env.remotePathTemplate = VIDEO_AI_MODEL_REMOTE_PATH_TEMPLATE;

if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = localWasmThreads();
  // Dedicated worker 已经是隔离执行上下文；proxy worker 在扩展页面中
  // 反而会触发 extension:// WASM 加载失败，因此保持关闭。
  configureOnnxWasmBackend(env.backends.onnx.wasm, resolveOnnxWasmAssetPaths(extensionUrl));
}
}

async function configureModelCache(): Promise<void> {
  const configured = await createVideoAiModelCache();
  if (configured.sharedCache) {
    // CacheStorage 仍作为只读兜底；新增或补齐的文件只写进用户选择的共享目录。
    env.useCustomCache = true;
    env.customCache = configured.cache;
    env.useBrowserCache = false;
    env.useFSCache = false;
    return;
  }
  env.useCustomCache = false;
  env.customCache = null;
  env.useBrowserCache = true;
}

function extensionUrl(path: string): string {
  const getUrl = (globalThis as typeof globalThis & {
    chrome?: {runtime?: {getURL?: (value: string) => string}};
  }).chrome?.runtime?.getURL;
  return getUrl?.(path) || new URL(path, self.location.href).toString();
}

function configureWasmThreads(_model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>): number {
  // ORT initializes one thread pool per worker lifetime. The offscreen owner
  // recreates this worker when the selected model changes, so the first model
  // reliably determines the pool size and subsequent requests reuse it.
  if (wasmRuntimeThreads !== null) {
    transcriberThreads = wasmRuntimeThreads;
    return wasmRuntimeThreads;
  }
  // 只有真正支持 SharedArrayBuffer 的隔离上下文才允许 pthread；否则
  // ONNX Runtime 会强制退回单线程。可用时最多开 2 个线程，避免把
  // Whisper 的内存峰值翻倍，同时让较长窗口不再完全占满单核。
  const threads = localWasmThreads();
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = threads;
  wasmRuntimeThreads = threads;
  transcriberThreads = threads;
  return threads;
}

async function canUseWebGpu(): Promise<boolean> {
  if (!ENABLE_VIDEO_WHISPER_WEBGPU || webGpuDisabled) return false;
  const result = await (webGpuProbePromise ||= probeWebGpu());
  webGpuProbeInfo = result.info;
  return result.available && !webGpuDisabled;
}

function disableWebGpu(reason: unknown): void {
  if (webGpuDisabled) return;
  webGpuDisabled = true;
  console.warn('[FluentRead] 本地视频 Worker 已禁用 WebGPU，当前生命周期改用 WASM', reason);
}

async function createWasmTranscriber(modelId: string, model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>): Promise<LocalTranscriber> {
  const create = async (dtype: 'q4' | 'q8') => {
    const createPipeline = () => pipeline('automatic-speech-recognition', modelId, {
      // ORT 的 CPU arena / memory pattern 会为动态 Whisper 窗口保留大块
      // 中间张量。浏览器实时字幕更看重可回收峰值，关闭后由有界窗口和暖
      // session 复用承担性能，避免 renderer 长时间停留在 GB 级 RSS。
      session_options: {
        // q8 合并权重同样避开锁定 ORT 的 QDQ 转置缺陷；q4 保留默认完整优化。
        ...(dtype === 'q8' ? {extra: {optimization: {disable_specified_optimizers: 'QDQSelectorActionTransformer'}}} : {}),
        enableCpuMemArena: false,
        enableMemPattern: false,
        executionMode: 'sequential',
      },
      device: 'wasm',
      dtype: model === 'small' ? {encoder_model: 'fp32', decoder_model_merged: dtype} : dtype,
      revision: VIDEO_AI_MODEL_REVISION,
    }) as unknown as Promise<LocalTranscriber>;
    const wasm = env.backends.onnx.wasm;
    const transcriber = await paceLocalInitialization(() => wasm
      ? withCompressedWasmBinary(wasm, resolveOnnxWasmAssetPaths(extensionUrl).wasm, createPipeline)
      : createPipeline());
    transcriberDtype = dtype;
    transcriberEncoderDtype = model === 'small' ? 'fp32' : dtype;
    return transcriber;
  };

  try {
    try {
      return await create('q4');
    } catch (q4Error) {
      // Small 的质量档位固定 FP32 encoder/q4 decoder；失败不偷偷下载另一整组精度。
      if (model === 'small') throw q4Error;
      console.warn('[FluentRead] Worker WASM/q4 Whisper 初始化失败，退回 WASM/q8', q4Error);
      // q8 是真实 fallback；写入当前选择的缓存，后续重建 worker 不会再次下载。
      await cacheVideoAiQ8ModelFiles(model);
      return await create('q8');
    }
  } catch (error) {
    if (localWasmThreads() > 1) throw new WasmThreadFallbackError(error);
    throw error;
  }
}

async function createLocalTranscriber(
  modelId: string,
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>,
): Promise<LocalTranscriber> {
  await configureModelCache();
  if (await canUseWebGpu()) {
    let gpuTranscriber: LocalTranscriber | null = null;
    try {
      const createPipeline = () => pipeline('automatic-speech-recognition', modelId, {
        session_options: {
          enableCpuMemArena: false,
          enableMemPattern: false,
          executionMode: 'sequential',
        },
        device: 'webgpu',
        dtype: model === 'small' ? {encoder_model: 'fp32', decoder_model_merged: 'q4'} : 'q4',
        revision: VIDEO_AI_MODEL_REVISION,
      }) as unknown as Promise<LocalTranscriber>;
      const wasm = env.backends.onnx.wasm;
      gpuTranscriber = await paceLocalInitialization(() => wasm
        ? withCompressedWasmBinary(wasm, resolveOnnxWasmAssetPaths(extensionUrl).wasm, createPipeline)
        : createPipeline(), {skipRest: true});
      transcriberBackend = 'webgpu';
      transcriberDtype = 'q4';
      transcriberEncoderDtype = model === 'small' ? 'fp32' : 'q4';
      transcriberGpuInfo = webGpuProbeInfo;
      transcriberThreads = 0;
      console.info('[FluentRead] 本地视频 Worker 使用 WebGPU/q4 推理', transcriberGpuInfo);
      return gpuTranscriber;
    } catch (error) {
      disableWebGpu(error);
      try {
        await gpuTranscriber?.dispose?.();
      } catch {
        // GPU session 清理失败时仍交给 owner 终止当前 Worker。
      }
      transcriberBackend = undefined;
      transcriberGpuInfo = '';
      transcriberDtype = undefined;
      transcriberEncoderDtype = undefined;
      console.warn('[FluentRead] Worker WebGPU Whisper 初始化失败，请求 fresh WASM Worker', error);
      throw new WebGpuFallbackError(error);
    }
  }

  configureWasmThreads(model);
  const transcriber = await createWasmTranscriber(modelId, model);
  transcriberBackend = 'wasm';
  transcriberGpuInfo = '';
  console.info(`[FluentRead] 本地视频 Worker 使用 WASM/${transcriberDtype} 推理（${transcriberThreads} 线程）`);
  return transcriber;
}

async function getLocalTranscriber(model: unknown): Promise<LocalTranscriber> {
  const normalizedModel = normalizeVideoLocalTranscriptionModel(model);
  const modelId = getVideoLocalTranscriptionModelId(normalizedModel);
  if (transcriberPromise && transcriberModelId === modelId) return transcriberPromise;

  if (transcriberPromise && transcriberModelId !== modelId) {
    const previousPromise = transcriberPromise;
    transcriberPromise = null;
    transcriberModelId = '';
    try {
      const previous = await previousPromise;
      await previous.dispose?.();
    } catch {
      // 旧模型失败时继续加载当前选择的模型。
    }
  }

  transcriberModelId = modelId;
  transcriberPromise = createLocalTranscriber(modelId, normalizedModel).catch((error) => {
    transcriberPromise = null;
    transcriberModelId = '';
    transcriberBackend = undefined;
    transcriberGpuInfo = '';
    transcriberDtype = undefined;
    transcriberEncoderDtype = undefined;
    throw error;
  });
  return transcriberPromise;
}

async function runModelInference<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (transcriberBackend === 'webgpu') throw new WebGpuFallbackError(error);
    if (transcriberBackend === 'wasm' && localWasmThreads() > 1) throw new WasmThreadFallbackError(error);
    throw error;
  }
}

function disposeTensorTree(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const disposable = value as {dispose?: unknown};
  if (typeof disposable.dispose === 'function') {
    disposable.dispose();
    return;
  }
  Object.values(value).forEach((child) => disposeTensorTree(child, seen));
}

async function detectWhisperSourceLanguage(
  transcriber: LocalTranscriber,
  audio: Float32Array,
): Promise<{detected: WhisperDetectedLanguage; encoder: WhisperEncoderReuse | null; processor: WhisperProcessorReuse | null; processed: Record<string, unknown> | null} | null> {
  const processor = transcriber.processor;
  const model = transcriber.model;
  const generationConfig = model?.generation_config;
  const modelConfig = model?.config;
  const isMultilingual = generationConfig?.is_multilingual ?? modelConfig?.is_multilingual;
  const langToId = generationConfig?.lang_to_id;
  const decoderStartTokenId = generationConfig?.decoder_start_token_id ?? modelConfig?.decoder_start_token_id;
  if (isMultilingual === false || !processor || !model || typeof decoderStartTokenId !== 'number'
    || !Number.isSafeInteger(decoderStartTokenId)) return null;
  if (!langToId || typeof langToId !== 'object') throw new Error('Whisper 模型缺少语言 token 配置');

  const processed = await processor(audio);
  const decoderInputIds = new Tensor(
    'int64', BigInt64Array.from([BigInt(decoderStartTokenId)]), [1, 1],
  );
  let output: {logits?: {data: ArrayLike<number>; dims?: readonly number[]}} | undefined;
  let encoder: WhisperEncoderReuse | null = null;
  let processorReuse: WhisperProcessorReuse | null = null;
  let handedToGeneration = false;
  let processedCleanupAttempted = false;
  try {
    let detected: WhisperDetectedLanguage;
    try {
      encoder = await runModelInference(() => prepareWhisperEncoderReuse(model, processed, env.version));
      output = await runModelInference(() => model({...processed, ...encoder?.modelInputs, decoder_input_ids: decoderInputIds}));
      const language = chooseWhisperSourceLanguage(output.logits, {isMultilingual, langToId});
      if (!language) throw new Error('Whisper 首步没有可用的语言 token logits');
      detected = language;
    } finally {
      // 检测的 logits/KV 与起始 token 先释放；清理失败不能把租约交给 generation。
      try {disposeTensorTree(output);}
      finally {decoderInputIds.dispose?.();}
    }
    processorReuse = prepareWhisperProcessorReuse(transcriber, audio, processed, env.version);
    if (!processorReuse) {
      // 清理先于交接；如果抛错，外层仍拥有 encoder，特征也不能重复释放。
      processedCleanupAttempted = true;
      disposeTensorTree(processed);
    }
    handedToGeneration = true;
    return {detected, encoder, processor: processorReuse, processed: processorReuse ? processed : null};
  } finally {
    // A direct model forward bypasses pipeline's normal generation cleanup;
    // 未交给 generation 的 encoder 属于检测失败；其释放失败也不能跳过特征。
    // Compatible features remain owned by this request until generation's
    // finally; unsupported processors retain the original second processing.
    try {if (!handedToGeneration) encoder?.dispose();}
    finally {if (!handedToGeneration && !processedCleanupAttempted) disposeTensorTree(processed);}
  }
}

async function resolveWhisperSourceLanguage(
  transcriber: LocalTranscriber,
  audio: Float32Array,
): Promise<{language: string; confidence: number; detectionMs: number; encoder: WhisperEncoderReuse | null; processor: WhisperProcessorReuse | null; processed: Record<string, unknown> | null}> {
  const detectionStartedAt = performance.now();
  const detection = await detectWhisperSourceLanguage(transcriber, audio);
  if (!detection) throw new Error('无法自动检测本地视频音频语言，请在视频字幕设置中选择源语言后重试');
  const {detected, encoder, processor, processed} = detection;
  // 混合语种视频可能在任意窗口切换；置信度只描述当前窗口，不永久锁定后续音频。
  return {language: detected.language, confidence: detected.confidence, detectionMs: performance.now() - detectionStartedAt, encoder, processor, processed};
}

function cleanTranscriptText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^\[(?:blank_audio|silence)\]$/i.test(text) ? '' : text;
}

interface ReusedLanguageDetection {
  language: string;
  confidence: number;
  detectionMs: number;
  encoderReuse: boolean;
}

async function transcribeAudioOnce(
  request: WorkerRequest,
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>,
  boundedAudio: Float32Array,
  retryDegenerate = false,
  generationAudioSeconds = boundedAudio.length / 16_000,
  forcedLanguageDetection?: ReusedLanguageDetection,
): Promise<WorkerTranscriptionResult> {
  const transcriber = await getLocalTranscriber(model);
  const inferenceStartedAt = performance.now();
  const explicitSourceLanguage = forcedLanguageDetection?.language || normalizeWhisperSourceLanguage(request.sourceLanguage);
  const inferenceTimeoutMs = getVideoLocalTranscriptionInferenceTimeoutMs(model);
  // 同一窗内的编码复用、语言检测与解码属于单次窗口任务，只在整窗外围安排一次
  // CPU 间歇（WebGPU 跳过人工休眠），避免子步骤之间被重复插入休眠。
  const {output, languageDetection, interrupted} = await paceLocalInference(async () => {
    const detected = explicitSourceLanguage ? undefined
      : await resolveWhisperSourceLanguage(transcriber, boundedAudio);
    const effectiveSourceLanguage = explicitSourceLanguage || detected!.language;
    // 正文、timestamp 和 EOS 共用 decoder 预算。Base/Small 保留多字节语言所需容量；
    // Tiny 使用已验证的有界时长预算，所有模型仍受独立停止条件约束。
    const stoppingCriteria = new InterruptableStoppingCriteria();
    const timeout = self.setTimeout(() => stoppingCriteria.interrupt(), inferenceTimeoutMs);
    try {
      const options = buildWhisperTranscriptionGenerationOptions(model, effectiveSourceLanguage, generationAudioSeconds, stoppingCriteria);
      if (retryDegenerate) {
        options.no_repeat_ngram_size = 4;
        options.repetition_penalty = 1.15;
      }
      const operation = (generationOptions: Record<string, unknown>) => withWhisperStoppingCriteria(
        transcriber.model, stoppingCriteria, env.version,
        () => runModelInference(() => transcriber(boundedAudio, generationOptions)),
      );
      const generate = () => detected?.encoder
        ? detected.encoder.transcribe(options, operation)
        : operation(options);
      const generated = await (detected?.processor
        ? detected.processor.transcribe(options, generate)
        : generate()) as { text?: unknown; chunks?: unknown };
      return {
        output: generated,
        languageDetection: detected ? {
          language: detected.language,
          confidence: detected.confidence,
          detectionMs: detected.detectionMs,
          encoderReuse: Boolean(detected.encoder),
        } : undefined,
        interrupted: stoppingCriteria.interrupted,
      };
    } finally {
      self.clearTimeout(timeout);
      try {detected?.encoder?.dispose();}
      finally {disposeTensorTree(detected?.processed);}
    }
  }, {skipRest: transcriberBackend === 'webgpu'});
  if (interrupted) {
    const error = new Error(`本地视频 AI 推理超过 ${inferenceTimeoutMs / 1000} 秒`);
    throw transcriberBackend === 'webgpu' ? new WebGpuFallbackError(error) : error;
  }

  if (isDegenerateVideoTranscript(output?.text) || (Array.isArray(output?.chunks)
    && output.chunks.some(chunk => isDegenerateVideoTranscript(chunk?.text)))) {
    if (!retryDegenerate) {
      // 退化重试直接沿用已检出语种，不再重复执行语言检测。
      const retried = await transcribeAudioOnce(
        request,
        model,
        boundedAudio,
        true,
        generationAudioSeconds,
        languageDetection,
      );
      retried.inferenceMs = performance.now() - inferenceStartedAt;
      return retried;
    }
    throw new Error('AI 字幕识别出现异常重复，请确认有人声并重新识别，或尝试其他模型');
  }

  const audioDurationMs = boundedAudio.length / 16;
  const segments = Array.isArray(output?.chunks)
    ? parseWhisperChunkTimestamps(output.chunks as any[], audioDurationMs)
      .map((segment) => ({...segment, text: cleanTranscriptText(segment.text)}))
      .filter((segment) => segment.text && segment.endMs > segment.startMs) as LocalVideoTranscriptionSegment[]
    : [];
  const inferenceMs = performance.now() - inferenceStartedAt;
  const detectionMeta = languageDetection || forcedLanguageDetection;
  // dispatcher 串行：成功加载后到响应序列化前不会执行 dispose/模型切换，
  // 创建成功路径必定已设置 backend 和双模块 dtype；静音早返另行处理。
  const result = {
    text: cleanTranscriptText(output?.text),
    segments,
    model,
    backend: transcriberBackend,
    gpuInfo: transcriberGpuInfo || undefined,
    inferenceMs,
    audioDurationMs,
    threads: transcriberBackend === 'wasm' ? transcriberThreads : undefined,
    dtype: transcriberDtype,
    encoderDtype: transcriberEncoderDtype,
    decoderDtype: transcriberDtype,
    detectedLanguage: detectionMeta?.language,
    languageConfidence: detectionMeta?.confidence,
    languageDetectionMs: detectionMeta?.detectionMs,
    encoderReuse: detectionMeta?.encoderReuse,
  };
  return result;
}

async function transcribeAudio(request: WorkerRequest): Promise<WorkerTranscriptionResult> {
  const model = normalizeVideoLocalTranscriptionModel(request.model);
  const audio = request.audio || new Float32Array();
  const maxSamples = MAX_WHISPER_AUDIO_SECONDS * 16_000;
  const boundedAudio = audio.length > maxSamples ? audio.subarray(0, maxSamples) : audio;
  const prepared = prepareWhisperAudioWindow(boundedAudio);
  if (prepared.audio.length === 0) {
    return {
      text: '',
      segments: [],
      model,
      backend: transcriberBackend,
      threads: transcriberBackend === 'wasm' ? transcriberThreads : undefined,
      dtype: transcriberDtype,
      inferenceMs: 0,
      audioDurationMs: prepared.sourceDurationMs,
    };
  }

  try {
    // 保留原窗时长作为 generation 参数，静音裁剪不改变完整窗的时间基准。
    const result = await transcribeAudioOnce(request, model, prepared.audio, false, boundedAudio.length / 16_000);
    const segments = result.segments.map(segment => ({
      ...segment,
      startMs: segment.startMs + prepared.offsetMs,
      endMs: segment.endMs + prepared.offsetMs,
    }));
    // 无 timestamp 的短句仍必须保留裁剪位置；否则调用方会把它铺满原窗静音。
    if (segments.length === 0 && result.text
      && prepared.audio.length !== boundedAudio.length) {
      segments.push({startMs: prepared.offsetMs, endMs: prepared.offsetMs + prepared.audio.length / 16, text: result.text});
    }
    return {...result, segments, audioDurationMs: prepared.sourceDurationMs};
  } catch (error) {
    if (!(error instanceof WebGpuFallbackError)) throw error;
    disableWebGpu(error);
    await disposeTranscriber();
    console.warn('[FluentRead] Worker GPU Whisper 请求失败，请求 fresh WASM Worker', error);
    throw error;
  }
}

async function disposeTranscriber(): Promise<void> {
  const current = transcriberPromise;
  transcriberPromise = null;
  transcriberModelId = '';
  transcriberBackend = undefined;
  transcriberGpuInfo = '';
  transcriberDtype = undefined;
  transcriberEncoderDtype = undefined;
  transcriberThreads = wasmRuntimeThreads ?? 1;
  try {
    const transcriber = current ? await current : null;
    await transcriber?.dispose?.();
  } catch (error) {
    console.warn('[FluentRead] Worker 释放本地视频模型失败', error);
  }
}

function enqueueWorkerTask(task: () => Promise<void>): void {
  // 主线程队列通常已经只发送一个请求，但 Worker 自身也必须提供同样的
  // 单消费者边界；否则 prepare/transcribe/dispose 的多个 async handler
  // 会并发触碰同一个 ONNX session，造成重复中间张量和不可预测的峰值内存。
  const next = workerTaskQueue.then(task, task);
  workerTaskQueue = next.catch(() => undefined);
}

const workerScope = self as typeof self & {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
function post(response: WorkerResponse): void { workerScope.postMessage(response); }

export function startVideoTranscriptionWorker(): void {
configureEnvironment();
workerScope.onmessage = (event) => {
  if (isVideoWorkerDisposal(event.data)) return;
  const requestId = readWorkerRequestId(event.data);
  if (requestId === undefined) return;
  let request: WorkerRequest;
  try { request = parseVideoWorkerRequest(event.data); }
  catch { post({requestId, success: false, error: '视频 Worker请求消息格式无效'}); return; }
  enqueueWorkerTask(async () => {
    try {
      if (request.device === 'wasm') {
        forceSingleThreadInference();
        const hadGpuSession = transcriberBackend === 'webgpu';
        disableWebGpu('调用方锁定本 Worker 使用 WASM');
        if (hadGpuSession) await disposeTranscriber();
      }
      if (request.type === 'prepare') {
        await getLocalTranscriber(request.model);
        // 与转写相同的单消费者归属：成功初始化设置诊断值，后续 dispose 必须排队。
        post({
          requestId: request.requestId,
          success: true,
          model: normalizeVideoLocalTranscriptionModel(request.model),
          backend: transcriberBackend,
          gpuInfo: transcriberGpuInfo || undefined,
          threads: transcriberBackend === 'wasm' ? transcriberThreads : undefined,
          dtype: transcriberDtype,
          encoderDtype: transcriberEncoderDtype,
          decoderDtype: transcriberDtype,
        });
        return;
      }
      const result = await transcribeAudio(request);
      post({ requestId: request.requestId, success: true, ...result });
    } catch (error) {
      const response: WorkerResponse = {
        requestId: request.requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof WebGpuFallbackError || error instanceof WasmThreadFallbackError) response.retryWithCpu = true;
      post(response);
    }
  });
};

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isVideoWorkerDisposal(event.data)) enqueueWorkerTask(disposeTranscriber);
});

}
