/**
 * @file src/features/video-subtitle/offscreen/transcription.ts
 * 文件职责：在 Offscreen Document 中串行调度视频 Whisper Worker、PCM 解码和模型预热。
 * 主要内容：管理单待处理转写、prepare 去重、模型切换、超时终止、取消清理与空闲释放。
 * 模块边界：只编排 Offscreen/Worker 资源，不解析字幕时间轴，也不管理后台 tab owner。
 */
import {
  normalizeVideoLocalTranscriptionModel,
  resampleToWhisperAudio,
} from '@/src/features/video-subtitle/transcription';
import { cacheVideoAiQ4ModelFiles, removeVideoAiModelFiles } from './modelCache';

type LocalTranscriptionBackend = 'webgpu' | 'wasm';

export interface LocalVideoTranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LocalVideoTranscriptionResult {
  text: string;
  segments: LocalVideoTranscriptionSegment[];
  model: string;
  backend?: LocalTranscriptionBackend;
  gpuInfo?: string;
  skipped?: boolean;
  decodeMs?: number;
  inferenceMs?: number;
  audioDurationMs?: number;
  threads?: number;
  dtype?: 'q4' | 'q8';
}

export type LocalVideoTranscriptionCancelReason = 'cancel' | 'complete';

interface LocalVideoTranscriptionRequest {
  streamId?: string;
  audioBase64?: string;
  audioPcm16Base64?: string;
  model?: unknown;
  sourceLanguage?: string;
}

interface WorkerRequest {
  requestId: number;
  type: 'prepare' | 'transcribe';
  model?: unknown;
  sourceLanguage?: string;
  languageSessionKey?: string;
  audio?: Float32Array;
}

interface WorkerResponse extends Partial<LocalVideoTranscriptionResult> {
  requestId: number;
  success: boolean;
  error?: string;
}

interface PendingWorkerRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: unknown) => void;
  timeout: number;
}

interface PendingTranscriptionJob {
  request: LocalVideoTranscriptionRequest;
  resolve: (result: LocalVideoTranscriptionResult) => void;
  reject: (error: unknown) => void;
}

interface PendingPrepareJob {
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
  keepWarm: boolean;
  streamId: string;
  resolve: (result: {
    model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
    backend?: LocalTranscriptionBackend;
    gpuInfo?: string;
    threads?: number;
    dtype?: 'q4' | 'q8';
  }) => void;
  reject: (error: unknown) => void;
}

const MODEL_IDLE_DISPOSE_MS = 30_000;
const MAX_WHISPER_AUDIO_SECONDS = 30;
const MODEL_PREPARE_TIMEOUT_MS = 120_000;
// 包含从浏览器 Cache API 初始化 ONNX session 的冷启动；真正 decoder 仍由
// Worker 内部的 15 秒 stopping criteria 限制。
const TRANSCRIPTION_TIMEOUT_MS = 32_000;
const AUDIO_DECODE_TIMEOUT_MS = 8_000;

let transcriptionWorker: Worker | null = null;
let transcriptionWorkerModel: ReturnType<typeof normalizeVideoLocalTranscriptionModel> | '' = '';
let workerRequestId = 0;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();
let decodeAudioContext: AudioContext | null = null;
let queueRunning = false;
let removingModel = false;
let workerDisposing = false;
let pendingTranscription: PendingTranscriptionJob | null = null;
const pendingPrepare: PendingPrepareJob[] = [];
const pendingPreparePromises = new Map<string, Promise<{
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
  backend?: LocalTranscriptionBackend;
  gpuInfo?: string;
  threads?: number;
  dtype?: 'q4' | 'q8';
}>>();
let idleDisposeTimer: number | undefined;
let activeStreamId = '';
let currentTranscriptionStreamId = '';

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback);
}

function terminateWorker(error?: Error, releaseStream = false): void {
  const current = transcriptionWorker;
  transcriptionWorker = null;
  transcriptionWorkerModel = '';
  if (releaseStream) activeStreamId = '';
  current?.terminate();
  const pending = [...pendingWorkerRequests.values()];
  pendingWorkerRequests.clear();
  pending.forEach((request) => {
    window.clearTimeout(request.timeout);
    if (error) request.reject(error);
  });
}

function getWorker(): Worker {
  if (transcriptionWorker) return transcriptionWorker;
  const runtimeGetUrl = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
  }).chrome?.runtime?.getURL;
  const workerUrl = runtimeGetUrl?.('videoTranscriptionWorker.js')
    || new URL('videoTranscriptionWorker.js', window.location.href).toString();
  const worker = new Worker(workerUrl, { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const pending = response && pendingWorkerRequests.get(response.requestId);
    if (!pending) return;
    pendingWorkerRequests.delete(response.requestId);
    window.clearTimeout(pending.timeout);
    if (response.success) pending.resolve(response);
    else pending.reject(new Error(response.error || '本地视频 AI Worker 失败'));
  };
  worker.onerror = (event) => {
    terminateWorker(new Error(event.message || '本地视频 AI Worker 已停止'), true);
  };
  transcriptionWorker = worker;
  return worker;
}

function requestWorker(
  message: Omit<WorkerRequest, 'requestId'>,
  transfer: Transferable[] = [],
  timeoutMs: number,
): Promise<WorkerResponse> {
  const requestId = ++workerRequestId;
  const requestedModel = normalizeVideoLocalTranscriptionModel(message.model);
  // ONNX Runtime fixes the WASM thread pool when its runtime starts. Recreate
  // the dedicated worker only when the selected model changes; repeated live
  // requests for the same model continue to reuse the warm session.
  if (transcriptionWorker && transcriptionWorkerModel && transcriptionWorkerModel !== requestedModel) {
    terminateWorker(new Error('本地视频 AI 模型已切换'));
  }
  const worker = getWorker();
  transcriptionWorkerModel = requestedModel;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      const error = new Error(`本地视频 AI Worker 超过 ${timeoutMs / 1000} 秒，已终止以保护浏览器性能`);
      terminateWorker(error, true);
    }, timeoutMs);
    pendingWorkerRequests.set(requestId, { resolve, reject, timeout });
    try {
      worker.postMessage({ ...message, requestId }, transfer);
    } catch (error) {
      window.clearTimeout(timeout);
      const workerError = toError(error, '无法启动本地视频 AI Worker');
      terminateWorker(workerError, true);
      reject(workerError);
    }
  });
}

function decodeBase64(value: string): ArrayBuffer {
  const encoded = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function decodePcm16Base64(value: string): Float32Array {
  const encoded = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(encoded);
  if (binary.length % 2 !== 0) throw new Error('本地视频 PCM 数据长度无效');

  // Convert only the accepted 30-second window. This avoids allocating a
  // second full-size byte buffer before the Float32Array for malformed input.
  const maxBytes = MAX_WHISPER_AUDIO_SECONDS * 16_000 * 2;
  const byteLength = Math.min(binary.length, maxBytes);
  const audio = new Float32Array(byteLength / 2);
  for (let index = 0, offset = 0; offset < byteLength; index += 1, offset += 2) {
    const unsigned = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
    const sample = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    audio[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return audio;
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

async function closeDecodeAudioContext(): Promise<void> {
  const context = decodeAudioContext;
  decodeAudioContext = null;
  if (context) await context.close().catch(() => undefined);
}

async function decodeAudioToWhisperAudio(audio: ArrayBuffer): Promise<Float32Array> {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) throw new Error('当前浏览器没有可用的 Web Audio 解码器');

  if (!decodeAudioContext || decodeAudioContext.state === 'closed') {
    decodeAudioContext = new AudioContextConstructor();
  }
  try {
    const decoded = await Promise.race([
      decodeAudioContext.decodeAudioData(audio.slice(0)),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error(`音频解码超过 ${AUDIO_DECODE_TIMEOUT_MS / 1000} 秒`)),
        AUDIO_DECODE_TIMEOUT_MS,
      )),
    ]);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    return resampleToWhisperAudio(channels, decoded.sampleRate);
  } catch (error) {
    await closeDecodeAudioContext();
    throw new Error(`音频解码失败：${toError(error, '未知解码错误').message}`);
  }
}

async function disposeLoadedTranscriber(): Promise<void> {
  workerDisposing = true;
  terminateWorker();
  await closeDecodeAudioContext();
  workerDisposing = false;
  drainQueue();
}

function scheduleIdleDisposal(): void {
  if (idleDisposeTimer !== undefined) window.clearTimeout(idleDisposeTimer);
  idleDisposeTimer = window.setTimeout(() => {
    idleDisposeTimer = undefined;
    if (queueRunning || pendingTranscription || pendingPrepare.length > 0 || workerDisposing) return;
    void disposeLoadedTranscriber();
  }, MODEL_IDLE_DISPOSE_MS);
}

function clearIdleDisposal(): void {
  if (idleDisposeTimer === undefined) return;
  window.clearTimeout(idleDisposeTimer);
  idleDisposeTimer = undefined;
}

async function transcribeLocalVideoAudioNow(request: LocalVideoTranscriptionRequest): Promise<LocalVideoTranscriptionResult> {
  if (!request.audioPcm16Base64 && !request.audioBase64) throw new Error('没有捕获到视频音频');
  const startedAt = performance.now();
  // 新实时链路在内容页面直接采集 16 kHz PCM，避免每 2–8 秒创建 WebM、
  // 再在 offscreen 用 AudioContext 解码。旧 audioBase64 仅作为兼容后备。
  const audio = request.audioPcm16Base64
    ? decodePcm16Base64(request.audioPcm16Base64)
    : await decodeAudioToWhisperAudio(decodeBase64(request.audioBase64!));
  const decodeMs = performance.now() - startedAt;
  if (audio.length === 0) {
    return {
      text: '',
      segments: [],
      model: normalizeVideoLocalTranscriptionModel(request.model),
      decodeMs,
      inferenceMs: 0,
      audioDurationMs: 0,
    };
  }

  const maxSamples = MAX_WHISPER_AUDIO_SECONDS * 16_000;
  const boundedAudio = audio.length > maxSamples ? audio.subarray(0, maxSamples) : audio;
  // subarray 可能仍然引用整个解码 buffer；slice 后再 transfer，避免把无关
  // 的长 buffer 一起移动到 Worker，随后由主线程可回收。
  const workerAudio = boundedAudio.byteOffset === 0 && boundedAudio.byteLength === boundedAudio.buffer.byteLength
    ? boundedAudio
    : boundedAudio.slice();
  const response = await requestWorker({
    type: 'transcribe',
    model: normalizeVideoLocalTranscriptionModel(request.model),
    sourceLanguage: request.sourceLanguage,
    languageSessionKey: request.streamId,
    audio: workerAudio,
  }, [workerAudio.buffer], TRANSCRIPTION_TIMEOUT_MS);
  return {
    text: typeof response.text === 'string' ? response.text : '',
    segments: Array.isArray(response.segments) ? response.segments : [],
    model: typeof response.model === 'string'
      ? response.model
      : normalizeVideoLocalTranscriptionModel(request.model),
    backend: response.backend === 'webgpu' || response.backend === 'wasm' ? response.backend : undefined,
    gpuInfo: typeof response.gpuInfo === 'string' ? response.gpuInfo : undefined,
    decodeMs,
    inferenceMs: typeof response.inferenceMs === 'number' ? response.inferenceMs : undefined,
    audioDurationMs: typeof response.audioDurationMs === 'number' ? response.audioDurationMs : undefined,
    threads: typeof response.threads === 'number' ? response.threads : undefined,
    dtype: response.dtype === 'q4' || response.dtype === 'q8' ? response.dtype : undefined,
  };
}

async function prepareLocalVideoTranscriptionModelNow(
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>,
  keepWarm: boolean,
): Promise<{
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
  backend?: LocalTranscriptionBackend;
  gpuInfo?: string;
  threads?: number;
  dtype?: 'q4' | 'q8';
}> {
  if (!keepWarm) {
    await cacheVideoAiQ4ModelFiles(model);
    return { model, dtype: 'q4' };
  }
  const response = await requestWorker({ type: 'prepare', model }, [], MODEL_PREPARE_TIMEOUT_MS);
  const result = {
    model,
    backend: response.backend === 'webgpu' || response.backend === 'wasm' ? response.backend : undefined,
    gpuInfo: typeof response.gpuInfo === 'string' ? response.gpuInfo : undefined,
    threads: typeof response.threads === 'number' ? response.threads : undefined,
    dtype: response.dtype === 'q4' || response.dtype === 'q8' ? response.dtype : undefined,
  };
  return result;
}

function createSkippedResult(model: unknown): LocalVideoTranscriptionResult {
  return {
    text: '',
    segments: [],
    model: normalizeVideoLocalTranscriptionModel(model),
    skipped: true,
  };
}

function drainQueue(): void {
  if (queueRunning || workerDisposing) return;
  // 播放中的实时窗口优先；模型下载不能插队并销毁当前 ASR session。
  const transcriptionJob = pendingTranscription;
  const prepareCandidate = pendingPrepare[0];
  const prepareJob = !transcriptionJob && prepareCandidate
    ? pendingPrepare.shift()!
    : null;
  if (!prepareJob && !transcriptionJob) return;
  if (transcriptionJob) pendingTranscription = null;
  queueRunning = true;
  currentTranscriptionStreamId = transcriptionJob?.request.streamId || '';
  void (async () => {
    try {
      if (prepareJob) {
        if (prepareJob.streamId) {
          activeStreamId = prepareJob.streamId;
          currentTranscriptionStreamId = prepareJob.streamId;
        }
        prepareJob.resolve(await prepareLocalVideoTranscriptionModelNow(prepareJob.model, prepareJob.keepWarm));
      } else if (transcriptionJob) {
        transcriptionJob.resolve(await transcribeLocalVideoAudioNow(transcriptionJob.request));
      }
    } catch (error) {
      if (prepareJob) prepareJob.reject(error);
      else transcriptionJob?.reject(error);
    } finally {
      queueRunning = false;
      currentTranscriptionStreamId = '';
      scheduleIdleDisposal();
      drainQueue();
    }
  })();
}

/** 预热模型；模型和推理均在独立 Worker 中运行，offscreen 主线程保持可响应。 */
export function prepareLocalVideoTranscriptionModel(model?: unknown, options?: {
  keepWarm?: boolean;
  streamId?: unknown;
}): Promise<{
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
  backend?: LocalTranscriptionBackend;
  gpuInfo?: string;
  threads?: number;
  dtype?: 'q4' | 'q8';
}> {
  if (removingModel) return Promise.reject(new Error('正在清除模型，请稍后重试'));
  const normalizedModel = normalizeVideoLocalTranscriptionModel(model);
  const keepWarm = options?.keepWarm === true;
  const streamId = keepWarm && typeof options?.streamId === 'string' ? options.streamId.trim() : '';
  const requestKey = `${normalizedModel}:${keepWarm ? 'warm' : 'cache'}:${streamId}`;
  const existing = pendingPreparePromises.get(requestKey);
  if (existing) return existing;

  const request = new Promise<{
    model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>;
    backend?: LocalTranscriptionBackend;
    gpuInfo?: string;
    threads?: number;
    dtype?: 'q4' | 'q8';
  }>((resolve, reject) => {
    if (streamId && activeStreamId && activeStreamId !== streamId) {
      reject(new Error('另一个标签页正在使用本地 AI 字幕，请先停止后再试'));
      return;
    }
    clearIdleDisposal();
    pendingPrepare.push({ model: normalizedModel, keepWarm, streamId, resolve, reject });
    drainQueue();
  });
  pendingPreparePromises.set(requestKey, request);
  void request.then(
    () => {
      if (pendingPreparePromises.get(requestKey) === request) pendingPreparePromises.delete(requestKey);
    },
    () => {
      if (pendingPreparePromises.get(requestKey) === request) pendingPreparePromises.delete(requestKey);
    },
  );
  return request;
}

/** 只保留一个待处理分片；Worker 超时会被 terminate，绝不继续堆积音频。 */
export function transcribeLocalVideoAudio(request: LocalVideoTranscriptionRequest): Promise<LocalVideoTranscriptionResult> {
  if (removingModel) return Promise.reject(new Error('正在清除模型，请稍后重试'));
  return new Promise((resolve, reject) => {
    clearIdleDisposal();
    const streamId = typeof request.streamId === 'string' && request.streamId.trim()
      ? request.streamId.trim()
      : 'legacy-video-stream';
    if (activeStreamId && activeStreamId !== streamId) {
      reject(new Error('另一个标签页正在使用本地 AI 字幕，请先停止后再试'));
      return;
    }
    activeStreamId = streamId;
    request.streamId = streamId;
    if (pendingTranscription) {
      pendingTranscription.resolve(createSkippedResult(pendingTranscription.request.model));
    }
    pendingTranscription = { request, resolve, reject };
    drainQueue();
  });
}

/** 取消当前流并立即终止 Worker，确保停止/换页后 CPU 不再继续跑满。 */
export async function cancelLocalVideoTranscription(
  streamId: unknown,
  reason: LocalVideoTranscriptionCancelReason = 'cancel',
): Promise<void> {
  const normalizedStreamId = typeof streamId === 'string' ? streamId.trim() : '';
  const ownsStream = normalizedStreamId && (
    activeStreamId === normalizedStreamId
    || currentTranscriptionStreamId === normalizedStreamId
    || pendingPrepare.some((job) => job.streamId === normalizedStreamId)
  );
  if (!ownsStream) return;
  if (reason === 'complete') {
    if (
      currentTranscriptionStreamId === normalizedStreamId
      || pendingTranscription?.request.streamId === normalizedStreamId
      || pendingPrepare.some((job) => job.streamId === normalizedStreamId)
    ) return;
    if (activeStreamId === normalizedStreamId) activeStreamId = '';
    return;
  }
  if (activeStreamId === normalizedStreamId) activeStreamId = '';
  if (pendingTranscription?.request.streamId === normalizedStreamId) {
    pendingTranscription.resolve(createSkippedResult(pendingTranscription.request.model));
    pendingTranscription = null;
  }
  for (let index = pendingPrepare.length - 1; index >= 0; index -= 1) {
    if (pendingPrepare[index].streamId !== normalizedStreamId) continue;
    const [job] = pendingPrepare.splice(index, 1);
    job.reject(new Error('本地视频 AI 字幕已取消'));
  }
  if (currentTranscriptionStreamId === normalizedStreamId || transcriptionWorker) {
    terminateWorker(new Error('本地视频 AI 字幕已取消'));
  }
  await closeDecodeAudioContext();
  clearIdleDisposal();
  drainQueue();
}

/** 空闲时释放已加载 Worker，再删除指定模型；使用或下载过程中拒绝删除。 */
export async function removeLocalVideoTranscriptionModel(model: unknown): Promise<void> {
  if (model !== 'tiny' && model !== 'base') throw new Error('无效的本地字幕模型');
  if (removingModel || queueRunning || pendingTranscription || pendingPrepare.length || pendingPreparePromises.size || workerDisposing) throw new Error('模型正在使用或下载，请结束后再清除');
  removingModel = true;
  try {
    clearIdleDisposal();
    if (transcriptionWorkerModel === model) await disposeLoadedTranscriber();
    await removeVideoAiModelFiles(model);
  } finally { removingModel = false; }
}
