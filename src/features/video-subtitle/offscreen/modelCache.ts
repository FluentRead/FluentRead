/**
 * @file src/features/video-subtitle/offscreen/modelCache.ts
 * 文件职责：维护 Transformers.js Whisper 模型文件地址、浏览器缓存与可选的共享目录缓存。
 * 主要内容：按固定版本及完整精度清单核对本地和共享模型，优先从共享目录复用，允许把本地完整模型迁移过去；网络下载继续流式接收、有界回退并发布真实字节进度。
 * 模块边界：只处理模型文件缓存，不创建 Worker、不初始化 ONNX session，也不参与后台 owner 生命周期。
 */
import {withModelDownload, type ModelSourcePreference} from '@/src/platform/http/modelDownloads';
import {createDownloadProgressTracker, type DownloadProgress} from '@/src/core/download/progress';
import {
  getVideoLocalTranscriptionDownloadBytes,
  getVideoLocalTranscriptionModelId,
  normalizeVideoLocalTranscriptionModel,
  normalizeVideoLocalTranscriptionModels,
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
  type VideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/transcription';
import {
  VIDEO_AI_MODEL_REVISION,
  VIDEO_AI_Q4_MODEL_FILES,
  VIDEO_AI_Q8_MODEL_FILES,
  VIDEO_AI_SMALL_MODEL_FILES,
  getVideoAiModelFileSets,
  type VideoAiModelFile,
} from '@/src/features/video-subtitle/modelFiles';
import {
  createSharedVideoAiModelCache,
  readSharedVideoAiModels,
  sharedModelFileUrl,
  type VideoAiModelCache,
} from '@/src/features/video-subtitle/sharedModelDirectory';

export {
  VIDEO_AI_MODEL_REVISION,
  VIDEO_AI_Q4_MODEL_FILES,
  VIDEO_AI_Q8_MODEL_FILES,
  VIDEO_AI_SMALL_MODEL_FILES,
};

export const VIDEO_AI_MODEL_REMOTE_HOST = 'https://modelscope.cn/models/';
export const VIDEO_AI_MODEL_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';

const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const MODEL_FILE_DOWNLOAD_TIMEOUT_MS = 120_000;

export function getVideoAiModelFileUrl(model: unknown, file: string): string {
  const modelId = getVideoLocalTranscriptionModelId(normalizeVideoLocalTranscriptionModel(model));
  return `${VIDEO_AI_MODEL_REMOTE_HOST}${modelId}/resolve/${VIDEO_AI_MODEL_REVISION}/${file}`;
}

interface ResolvedVideoAiModelCache {
  cache: VideoAiModelCache;
  localCache: Cache;
  sharedCache?: VideoAiModelCache;
}

/** Transformers.js 使用共享目录优先、扩展 CacheStorage 兜底的同一缓存接口。 */
export async function createVideoAiModelCache(): Promise<ResolvedVideoAiModelCache> {
  if (typeof caches === 'undefined') throw new Error('当前浏览器不支持本地模型缓存');
  const localCache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const sharedCache = await createSharedVideoAiModelCache();
  if (!sharedCache) return {cache: localCache, localCache};
  return {
    localCache,
    sharedCache,
    cache: {
      match: async request => await sharedCache.match(request) || await localCache.match(request),
      put: (request, response) => sharedCache.put(request, response),
      putWithProgress: (request, response, onProgress) => sharedCache.putWithProgress
        ? sharedCache.putWithProgress(request, response, onProgress)
        : sharedCache.put(request, response),
    },
  };
}

/**
 * 下载登记只代表过去成功；可用状态还需同一精度清单的全部精确缓存键。
 * Tiny/Base 保留实际 Worker 支持的完整 q4 或 q8，Small 仅 FP32 encoder/q4 decoder。
 * 后台可直接读取同扩展 origin 的 Request 元数据，不读取模型响应体、
 * 不创建缺失缓存，也不删除登记或 q8 回退文件，避免与进行中的下载竞态。
 */
export async function readCachedVideoAiModelState(receipts: unknown): Promise<{
  models: VideoLocalTranscriptionModel[];
  localModels: VideoLocalTranscriptionModel[];
  sharedModels: VideoLocalTranscriptionModel[];
}> {
  const models = normalizeVideoLocalTranscriptionModels(receipts);
  let localModels: VideoLocalTranscriptionModel[] = [];
  let sharedModels: VideoLocalTranscriptionModel[] = [];
  if (typeof caches !== 'undefined') {
    try {
      if (models.length && await caches.has(TRANSFORMERS_CACHE_NAME)) {
        const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
        const urls = new Set((await cache.keys()).map(request => request.url));
        localModels = models.filter(model => {
          const complete = (files: readonly string[]) => files.every(file => urls.has(getVideoAiModelFileUrl(model, file)));
          return getVideoAiModelFileSets(model).some(complete);
        });
      }
      sharedModels = await readSharedVideoAiModels(await createSharedVideoAiModelCache());
    } catch (error) {
      throw new Error('无法读取模型缓存，请重试', {cause: error});
    }
  }
  const available = new Set([...localModels, ...sharedModels]);
  return {models: VIDEO_LOCAL_TRANSCRIPTION_MODELS.filter(item => available.has(item.value)).map(item => item.value), localModels, sharedModels};
}

export async function readCachedVideoAiModels(receipts: unknown): Promise<VideoLocalTranscriptionModel[]> {
  return (await readCachedVideoAiModelState(receipts)).models;
}

/**
 * 顺序下载并写入 Transformers.js 使用的同一个 Cache Storage。cache.put 会
 * 直接消费 Response，不在 JS 堆中再构造一份几十 MB 的 ONNX ArrayBuffer。
 */
export async function cacheVideoAiModelFiles(
  model: unknown,
  dtype: 'q4' | 'q8' = 'q4',
  onProgress?: (progress: DownloadProgress) => void,
  options: {preference?: ModelSourcePreference} = {},
): Promise<void> {
  const normalizedModel = normalizeVideoLocalTranscriptionModel(model);
  if (normalizedModel === 'small' && dtype === 'q8') throw new Error('Small 模型只支持 FP32 编码器与 q4 解码器');
  const resolved = await createVideoAiModelCache();
  const cache = resolved.cache;

  const files = normalizedModel === 'small' ? VIDEO_AI_SMALL_MODEL_FILES
    : dtype === 'q8' ? VIDEO_AI_Q8_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES;
  // 界面体积按各模型的默认清单统计；q8 回退没有预计总量，各文件报出大小后才给百分比。
  const tracker = createDownloadProgressTracker(
    files.length,
    dtype === 'q4' ? getVideoLocalTranscriptionDownloadBytes(model) : 0,
    progress => onProgress?.(progress),
  );
  // 所有模型允许慢速持续接收，但全部来源与文件共用十分钟总准备预算。
  const controller = new AbortController();
  const totalTimeout = setTimeout(() => controller.abort(), 600_000);
  try {
    for (const file of files) {
      const url = getVideoAiModelFileUrl(model, file);
      const progress = tracker.file();
      if (resolved.sharedCache) {
        const shared = await resolved.sharedCache.match(url);
        if (shared) {
          progress.cached(Number(shared.headers.get('Content-Length')));
          await shared.body?.cancel();
          continue;
        }
        const local = await resolved.localCache.match(url);
        if (local) {
          if (resolved.sharedCache.putWithProgress) await resolved.sharedCache.putWithProgress(url, local, progress.advance);
          else await resolved.sharedCache.put(url, local);
          progress.complete();
          continue;
        }
      } else {
        const cached = await cache.match(url);
        if (cached) {
          progress.cached(Number(cached.headers.get('Content-Length')));
          continue;
        }
      }

      await withModelDownload(url, response => resolved.sharedCache
        ? resolved.sharedCache.putWithProgress?.(url, response, progress.advance) ?? resolved.sharedCache.put(url, response)
        : cache.put(url, response), {
        timeoutMs: normalizedModel === 'small' ? 300_000 : MODEL_FILE_DOWNLOAD_TIMEOUT_MS,
        maxBytes: (normalizedModel === 'small' && file === 'onnx/encoder_model.onnx' ? 384 : 256) * 1024 * 1024,
        signal: controller.signal,
        onProgress: progress.advance,
        onSourceStatus: tracker.transfer,
        preference: options.preference,
      });
      progress.complete();
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型下载超过总等待时限', {cause: error});
    if (error instanceof Error && error.name === 'QuotaExceededError') throw error;
    if (error instanceof Error && error.message.includes('共享模型目录需要重新授权')) throw error;
    throw new Error('模型下载失败，请检查网络后重试', {cause: error});
  } finally {
    clearTimeout(totalTimeout);
  }
}

/** 将已有的完整浏览器缓存模型迁入共享目录，验证每个文件后再清除本地副本。 */
export async function moveVideoAiModelToSharedDirectory(
  model: unknown,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const normalizedModel = normalizeVideoLocalTranscriptionModel(model);
  if (typeof caches === 'undefined') throw new Error('当前浏览器不支持本地模型缓存');
  const sharedCache = await createSharedVideoAiModelCache();
  if (!sharedCache) throw new Error('请先在本地 AI 字幕设置中选择共享模型文件夹');
  const localCache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const files = await findCompleteLocalModelFiles(localCache, normalizedModel);
  if (!files) throw new Error('浏览器缓存中的模型文件不完整，请先重新下载');
  const tracker = createDownloadProgressTracker(files.length, getVideoLocalTranscriptionDownloadBytes(normalizedModel), progress => onProgress?.(progress));
  for (const file of files) {
    const url = getVideoAiModelFileUrl(normalizedModel, file);
    const progress = tracker.file();
    const existing = await sharedCache.match(sharedModelFileUrl(normalizedModel, file));
    if (existing) {
      progress.cached(Number(existing.headers.get('Content-Length')));
      await existing.body?.cancel();
      continue;
    }
    const cached = await localCache.match(url);
    if (!cached) throw new Error('浏览器缓存中的模型文件不完整，请先重新下载');
    if (sharedCache.putWithProgress) await sharedCache.putWithProgress(url, cached, progress.advance);
    else await sharedCache.put(url, cached);
    progress.complete();
  }
  const sharedModels = await readSharedVideoAiModels(sharedCache);
  if (!sharedModels.includes(normalizedModel)) throw new Error('共享模型文件校验失败，请重试迁移');
  await removeVideoAiModelFiles(normalizedModel);
}

async function findCompleteLocalModelFiles(cache: Cache, model: VideoLocalTranscriptionModel): Promise<readonly VideoAiModelFile[] | undefined> {
  for (const files of getVideoAiModelFileSets(model)) {
    const complete = await Promise.all(files.map(async file => {
      const response = await cache.match(getVideoAiModelFileUrl(model, file));
      if (!response) return false;
      await response.body?.cancel();
      return true;
    }));
    if (complete.every(Boolean)) return files;
  }
  return undefined;
}

export function cacheVideoAiQ4ModelFiles(model: unknown, onProgress?: (progress: DownloadProgress) => void, options?: {preference?: ModelSourcePreference}): Promise<void> {
  return cacheVideoAiModelFiles(model, 'q4', onProgress, options);
}

export function cacheVideoAiQ8ModelFiles(model: unknown, onProgress?: (progress: DownloadProgress) => void, options?: {preference?: ModelSourcePreference}): Promise<void> {
  return cacheVideoAiModelFiles(model, 'q8', onProgress, options);
}

/** 只清除指定 Whisper 模型的缓存文件，保留其他模型及字幕结果。 */
export async function removeVideoAiModelFiles(model: unknown): Promise<void> {
  if (!VIDEO_LOCAL_TRANSCRIPTION_MODELS.some(item => item.value === model)) throw new Error('无效的本地字幕模型');
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const prefix = getVideoAiModelFileUrl(model, '');
  for (const request of await cache.keys()) {
    if (request.url.startsWith(prefix)) await cache.delete(request);
  }
}
