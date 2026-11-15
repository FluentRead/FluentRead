/**
 * @file src/features/video-subtitle/offscreen/transcription.ts
 * 文件职责：在 Offscreen Document 中串行调度视频 Whisper Worker、PCM 解码和模型预热。
 * 主要内容：复用共享并行预算及排队任务代次保护，管理单待处理转写、prepare 去重、模型切换、GPU 生命周期失败后的单次 CPU 重建、超时终止、首窗等待的有界预热租期、取消清理与按设备内存安排的空闲释放，兼容解码返回后先检查会话归属再读取 PCM；透传实际语言检测诊断，预下载时校验本次来源偏好，并把字节及连接状态交给调用方。
 * 模块边界：只编排 Offscreen/Worker 资源，收到未知载荷先经共享 Worker 协议校验；不解析字幕时间轴，也不管理后台 tab owner。
 */
import {withLocalInferenceBudget} from '@/src/shared/onnx/resources';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';
import {
  normalizeVideoLocalTranscriptionModel,
  getVideoLocalTranscriptionWorkerTimeoutMs,
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
  normalizeVideoAiRecognitionMetadata,
  resampleToWhisperAudio,
} from '@/src/features/video-subtitle/transcription';
import { cacheVideoAiQ4ModelFiles, removeVideoAiModelFiles } from './modelCache';
import type {DownloadProgress} from '@/src/core/download/progress';
import type {ModelSourcePreference} from '@/src/platform/http/modelDownloads';
import type {VideoPreparationResult, VideoTranscriptionCancelReason, VideoTranscriptionResult, VideoTranscriptionSegment} from '@/src/core/messaging/video';
import {readWorkerRequestId} from '@/src/core/messaging/validation';
import {parseVideoWorkerResponse, type VideoWorkerRequest as WorkerRequest, type VideoWorkerResponse as WorkerResponse} from '../workerProtocol';

export type LocalVideoTranscriptionSegment = VideoTranscriptionSegment;
export interface LocalVideoTranscriptionResult extends VideoTranscriptionResult {
  text: string;
  segments: LocalVideoTranscriptionSegment[];
  model: string;
}
export type LocalVideoTranscriptionPreparation = VideoPreparationResult;
export type LocalVideoTranscriptionCancelReason = VideoTranscriptionCancelReason;

interface LocalVideoTranscriptionRequest {
  streamId?: string;
  audioBase64?: string;
  audioPcm16Base64?: string;
  model?: unknown;
  sourceLanguage?: string;
}

interface PendingWorkerRequest {
  type: WorkerRequest['type'];
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
  onProgress?: (progress: DownloadProgress) => void;
  preference: ModelSourcePreference;
  resolve: (result: LocalVideoTranscriptionPreparation) => void;
  reject: (error: unknown) => void;
}

type WorkerLifecycleError = Error & {retryableWorkerFailure?: true};

// 覆盖 X 的 5 秒媒体发现、60 秒独立读取和 8 秒解码，首窗提交即消费。
const MODEL_FIRST_AUDIO_WARM_LEASE_MS = 90_000;
const MAX_WHISPER_AUDIO_SECONDS = 30;
const MODEL_PREPARE_TIMEOUT_MS = 120_000;
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
const pendingPreparePromises = new Map<string, Promise<LocalVideoTranscriptionPreparation>>();
let idleDisposeTimer: number | undefined;
let firstAudioWarmLease: {streamId: string; deadlineAt: number} | null = null;
let activeStreamId = '';
let workerGeneration = 0;
let currentTranscriptionStreamId = '';
let transcriptionCancellationVersion = 0;

function createWorkerLifecycleError(message: string): WorkerLifecycleError {
  const error = new Error(message) as WorkerLifecycleError;
  error.retryableWorkerFailure = true;
  return error;
}

function isWorkerLifecycleError(error: unknown): error is WorkerLifecycleError {
  return error instanceof Error && (error as WorkerLifecycleError).retryableWorkerFailure === true;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : fallback);
}

function terminateWorker(error?: Error, releaseStream = false): void {
  firstAudioWarmLease = null;
  clearIdleDisposal();
  workerGeneration++;
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
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (transcriptionWorker !== worker) return;
    const requestId = readWorkerRequestId(event.data);
    if (requestId === undefined) return;
    const pending = pendingWorkerRequests.get(requestId);
    if (!pending) return;
    pendingWorkerRequests.delete(requestId);
    window.clearTimeout(pending.timeout);
    let response: WorkerResponse;
    try { response = parseVideoWorkerResponse(event.data, pending.type); }
    catch (error) { pending.reject(error); return; }
    if (response.success) pending.resolve(response);
    else if (response.retryWithCpu === true) {
      const error = createWorkerLifecycleError(response.error || '本地视频 AI GPU Worker 失败，准备使用 CPU 重试');
      // The current request was removed above; explicitly reject it after the
      // worker teardown so the fallback helper can create a fresh CPU Worker.
      terminateWorker(error);
      pending.reject(error);
    }
    else pending.reject(new Error(response.error || '本地视频 AI Worker 失败'));
  };
  worker.onerror = (event) => {
    if (transcriptionWorker !== worker) return;
    terminateWorker(createWorkerLifecycleError(event.message || '本地视频 AI Worker 已停止'));
  };
  transcriptionWorker = worker;
  return worker;
}

function requestWorker(message: Omit<WorkerRequest, 'requestId'>, transfer: Transferable[] = [], timeoutMs: number): Promise<WorkerResponse> {
  const generation = workerGeneration;
  return withLocalInferenceBudget(() => {
    if (generation !== workerGeneration) throw new Error('本地视频 AI 字幕已取消');
    return requestWorkerNow(message, transfer, timeoutMs);
  });
}

function requestWorkerNow(
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
      const error = createWorkerLifecycleError(`本地视频 AI Worker 超过 ${timeoutMs / 1000} 秒，已终止以保护浏览器性能`);
      terminateWorker(error);
    }, timeoutMs);
    pendingWorkerRequests.set(requestId, { type: message.type, resolve, reject, timeout });
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

function requestWorkerWithCpuFallback(
  message: Omit<WorkerRequest, 'requestId'> & {type: 'transcribe'},
  retryMessage: Omit<WorkerRequest, 'requestId'> & {type: 'transcribe'},
  transfer: Transferable[], retryTransfer: Transferable[], timeoutMs: number, streamId?: string,
): Promise<WorkerResponse & VideoTranscriptionResult>;
function requestWorkerWithCpuFallback(
  message: Omit<WorkerRequest, 'requestId'>, retryMessage: Omit<WorkerRequest, 'requestId'>,
  transfer: Transferable[], retryTransfer: Transferable[], timeoutMs: number, streamId?: string,
): Promise<WorkerResponse>;
async function requestWorkerWithCpuFallback(
  message: Omit<WorkerRequest, 'requestId'>,
  retryMessage: Omit<WorkerRequest, 'requestId'>,
  transfer: Transferable[],
  retryTransfer: Transferable[],
  timeoutMs: number,
  streamId = '',
): Promise<WorkerResponse> {
  const deadlineAt = Date.now() + timeoutMs;
  const firstAttemptTimeout = Math.max(1, Math.floor(timeoutMs / 2));
  try {
    return await requestWorker(message, transfer, firstAttemptTimeout);
  } catch (error) {
    const remainingMs = deadlineAt - Date.now();
    if (!isWorkerLifecycleError(error)) throw error;
    if (message.device === 'wasm' || remainingMs <= 0) {
      activeStreamId = '';
      throw error;
    }
    if (streamId && activeStreamId !== streamId) throw new Error('本地视频 AI 字幕已取消');
    try {
      return await requestWorker({...retryMessage, device: 'wasm'}, retryTransfer, remainingMs);
    } catch (retryError) {
      if (isWorkerLifecycleError(retryError)) activeStreamId = '';
      throw retryError;
    }
  }
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

async function decodeAudioToWhisperAudio(
  audio: ArrayBuffer,
  cancellationVersion: number,
  streamId: LocalVideoTranscriptionRequest['streamId'],
): Promise<Float32Array> {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) throw new Error('当前浏览器没有可用的 Web Audio 解码器');

  if (!decodeAudioContext || decodeAudioContext.state === 'closed') {
    decodeAudioContext = new AudioContextConstructor();
  }
  let decodeTimeout: number | undefined;
  let decodeError: Error | undefined;
  try {
    const decoded = await Promise.race([
      decodeAudioContext.decodeAudioData(audio.slice(0)),
      new Promise<never>((_, reject) => {
        decodeTimeout = window.setTimeout(
          () => reject(new Error(`音频解码超过 ${AUDIO_DECODE_TIMEOUT_MS / 1000} 秒`)),
          AUDIO_DECODE_TIMEOUT_MS,
        );
      }),
    ]);
    // close() 不保证原生 decode 已停止；迟到的旧会话不能再复制或重采样整段 PCM。
    if (cancellationVersion !== transcriptionCancellationVersion || streamId !== activeStreamId) {
      throw new Error('本地视频 AI 字幕已取消');
    }
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    return resampleToWhisperAudio(channels, decoded.sampleRate);
  } catch (error) {
    // 取消已负责关闭自己的 context；保留取消错误，不能把它改写为解码失败。
    if (cancellationVersion !== transcriptionCancellationVersion || streamId !== activeStreamId) {
      throw new Error('本地视频 AI 字幕已取消');
    }
    await closeDecodeAudioContext();
    decodeError = new Error(`音频解码失败：${toError(error, '未知解码错误').message}`);
  } finally {
    if (decodeTimeout !== undefined) window.clearTimeout(decodeTimeout);
  }
  throw decodeError;
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
  }, firstAudioWarmLease?.streamId === activeStreamId && firstAudioWarmLease.deadlineAt > Date.now()
    ? firstAudioWarmLease.deadlineAt - Date.now()
    : localModelIdleMs());
}

function clearIdleDisposal(): void {
  if (idleDisposeTimer === undefined) return;
  window.clearTimeout(idleDisposeTimer);
  idleDisposeTimer = undefined;
}

async function transcribeLocalVideoAudioNow(request: LocalVideoTranscriptionRequest): Promise<LocalVideoTranscriptionResult> {
  if (!request.audioPcm16Base64 && !request.audioBase64) throw new Error('没有捕获到视频音频');
  const startedAt = performance.now();
  const cancellationVersion = transcriptionCancellationVersion;
  // 新实时链路在内容页面直接采集 16 kHz PCM，避免每 2–8 秒创建 WebM、
  // 再在 offscreen 用 AudioContext 解码。旧 audioBase64 仅作为兼容后备。
  const audio = request.audioPcm16Base64
    ? decodePcm16Base64(request.audioPcm16Base64)
    : await decodeAudioToWhisperAudio(decodeBase64(request.audioBase64!), cancellationVersion, request.streamId);
  // 关闭 AudioContext 不保证未决解码不会迟到；同一 streamId 重启也不能
  // 重新取得旧任务的归属，必须在空音频返回或启动 Worker 前检查取消版本。
  if (cancellationVersion !== transcriptionCancellationVersion || request.streamId !== activeStreamId) {
    throw new Error('本地视频 AI 字幕已取消');
  }
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
  // The first request transfers its buffer. Keep an independent copy for the
  // one allowed retry on a fresh WASM worker.
  const retryAudio = boundedAudio.slice();
  const response = await requestWorkerWithCpuFallback({
    type: 'transcribe',
    model: normalizeVideoLocalTranscriptionModel(request.model),
    sourceLanguage: request.sourceLanguage,
    languageSessionKey: request.streamId,
    audio: workerAudio,
  }, {
    type: 'transcribe',
    model: normalizeVideoLocalTranscriptionModel(request.model),
    sourceLanguage: request.sourceLanguage,
    languageSessionKey: request.streamId,
    audio: retryAudio,
  }, [workerAudio.buffer], [retryAudio.buffer], getVideoLocalTranscriptionWorkerTimeoutMs(request.model), request.streamId);
  if (activeStreamId === request.streamId) firstAudioWarmLease = {streamId: request.streamId!, deadlineAt: 0};
  return {
    text: response.text,
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
    ...normalizeVideoAiRecognitionMetadata(response),
  };
}

async function prepareLocalVideoTranscriptionModelNow(
  model: ReturnType<typeof normalizeVideoLocalTranscriptionModel>,
  keepWarm: boolean,
  streamId = '',
  onProgress?: (progress: DownloadProgress) => void,
  preference: ModelSourcePreference = 'auto',
): Promise<LocalVideoTranscriptionPreparation> {
  if (!keepWarm) {
    await cacheVideoAiQ4ModelFiles(model, onProgress, {preference});
    return { model, dtype: 'q4' };
  }
  const response = await requestWorkerWithCpuFallback({ type: 'prepare', model }, { type: 'prepare', model }, [], [], model === 'small' ? 600_000 : MODEL_PREPARE_TIMEOUT_MS, streamId);
  const result = {
    model,
    backend: response.backend === 'webgpu' || response.backend === 'wasm' ? response.backend : undefined,
    gpuInfo: typeof response.gpuInfo === 'string' ? response.gpuInfo : undefined,
    threads: typeof response.threads === 'number' ? response.threads : undefined,
    dtype: response.dtype === 'q4' || response.dtype === 'q8' ? response.dtype : undefined,
    ...normalizeVideoAiRecognitionMetadata(response),
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
        const prepared = await prepareLocalVideoTranscriptionModelNow(prepareJob.model, prepareJob.keepWarm, prepareJob.streamId, prepareJob.onProgress, prepareJob.preference);
        if (prepareJob.keepWarm && prepareJob.streamId && activeStreamId === prepareJob.streamId
          && pendingTranscription?.request.streamId !== prepareJob.streamId && !firstAudioWarmLease) {
          firstAudioWarmLease = {streamId: prepareJob.streamId, deadlineAt: Date.now() + MODEL_FIRST_AUDIO_WARM_LEASE_MS};
        }
        prepareJob.resolve(prepared);
      } else if (transcriptionJob) {
        transcriptionJob.resolve(await transcribeLocalVideoAudioNow(transcriptionJob.request));
      }
    } catch (error) {
      firstAudioWarmLease = null;
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
  /** 仅预下载（keepWarm 为 false）时回报模型文件的真实字节进度；并发的相同请求共用首个调用者的回调。 */
  onProgress?: (progress: DownloadProgress) => void;
  /** 只影响这次预下载；任意外部值回退到自动选择，不接收自定义 URL。 */
  preference?: unknown;
}): Promise<LocalVideoTranscriptionPreparation> {
  if (removingModel) return Promise.reject(new Error('正在清除模型，请稍后重试'));
  const normalizedModel = normalizeVideoLocalTranscriptionModel(model);
  const keepWarm = options?.keepWarm === true;
  const preference = options?.preference === 'official' || options?.preference === 'mirror' ? options.preference : 'auto';
  const streamId = keepWarm && typeof options?.streamId === 'string' ? options.streamId.trim() : '';
  const requestKey = `${normalizedModel}:${keepWarm ? 'warm' : 'cache'}:${streamId}`;
  const existing = pendingPreparePromises.get(requestKey);
  if (existing) return existing;

  const request = new Promise<LocalVideoTranscriptionPreparation>((resolve, reject) => {
    if (streamId && activeStreamId && activeStreamId !== streamId) {
      reject(new Error('另一个标签页正在使用本地 AI 字幕，请先停止后再试'));
      return;
    }
    clearIdleDisposal();
    pendingPrepare.push({ model: normalizedModel, keepWarm, streamId, onProgress: options?.onProgress, preference, resolve, reject });
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
    const streamId = typeof request.streamId === 'string' && request.streamId.trim()
      ? request.streamId.trim()
      : 'legacy-video-stream';
    if (activeStreamId && activeStreamId !== streamId) {
      reject(new Error('另一个标签页正在使用本地 AI 字幕，请先停止后再试'));
      return;
    }
    clearIdleDisposal();
    // 保留已消费标记，重复的同 owner prepare 不能重新延长首窗租期。
    firstAudioWarmLease = {streamId, deadlineAt: 0};
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
    firstAudioWarmLease = null;
    if (activeStreamId === normalizedStreamId) activeStreamId = '';
    scheduleIdleDisposal();
    return;
  }
  firstAudioWarmLease = null;
  if (currentTranscriptionStreamId === normalizedStreamId) transcriptionCancellationVersion += 1;
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
  if (!VIDEO_LOCAL_TRANSCRIPTION_MODELS.some(item => item.value === model)) throw new Error('无效的本地字幕模型');
  if (removingModel || queueRunning || pendingTranscription || pendingPrepare.length || pendingPreparePromises.size || workerDisposing) throw new Error('模型正在使用或下载，请结束后再清除');
  removingModel = true;
  try {
    clearIdleDisposal();
    firstAudioWarmLease = null;
    if (transcriptionWorkerModel === model) await disposeLoadedTranscriber();
    await removeVideoAiModelFiles(model);
  } finally {
    removingModel = false;
    if (transcriptionWorker) scheduleIdleDisposal();
  }
}
