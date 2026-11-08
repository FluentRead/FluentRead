/**
 * @file src/features/video-subtitle/transcriptionCache.ts
 * 文件职责：定义视频 AI 字幕缓存的纯协议、稳定身份和完整 cue 规范化规则。
 * 主要内容：生成 status/media、poster 或稳定 direct source key，隔离识别方式/本机端点/模型/视频源语言/识别策略版本，避免复用旧版固定语言的字幕，并拒绝临时地址与 partial cue。
 * 模块边界：只依赖纯视频字幕数据和模型归一化，不导入 Dexie、浏览器 API、后台 runtime 或音频数据。
 */
import type {VideoSubtitleCue} from '@/src/features/video-subtitle/content/youtubeSubtitleData';
import {normalizeVideoAiSubtitleTimeline} from '@/src/features/video-subtitle/content/video-ai/cueTimeline';
import {isDegenerateVideoTranscript, normalizeVideoLocalTranscriptionModel, type VideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {NATIVE_QWEN_ASR_MODEL} from '@/src/core/messaging/video';
import {normalizeNativeAsrBaseUrl} from '@/src/core/config/nativeAsr';

export const VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE = 'fluentReadGetVideoAiSubtitleCache' as const;
export const VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE = 'fluentReadSetVideoAiSubtitleCache' as const;
export const VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE = 'fluentReadGetVideoAiSubtitleCacheStats' as const;
export const VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE = 'fluentReadClearVideoAiSubtitleCache' as const;
// 逐窗语言检测及 Base/Small 解码容量变化后，旧版固定语言结果必须重新识别。
export const VIDEO_AI_SUBTITLE_CACHE_SCHEMA_FINGERPRINT = 'video-ai-cues-v2' as const;
export const VIDEO_AI_SUBTITLE_CACHE_MAX_CUES = 1_200 as const;

export interface VideoAiSubtitleCacheSource {
  tweetId?: unknown;
  statusUrl?: unknown;
  tweetUrl?: unknown;
  mediaId?: unknown;
  videoIndex?: unknown;
  poster?: unknown;
  directSource?: unknown;
}

export interface VideoAiSubtitleCacheIdentity {
  videoKey: string;
  model: VideoLocalTranscriptionModel | typeof NATIVE_QWEN_ASR_MODEL;
  sourceLanguage: string;
  schemaFingerprint: typeof VIDEO_AI_SUBTITLE_CACHE_SCHEMA_FINGERPRINT | 'video-native-qwen-text-v1';
  provider?: 'native-qwen';
  nativeBaseUrl?: string;
}

export interface VideoAiSubtitleCacheRequest {
  source: VideoAiSubtitleCacheSource;
  model?: unknown;
  sourceLanguage?: unknown;
  videoSourceLanguage?: unknown;
  provider?: unknown;
  nativeBaseUrl?: unknown;
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableUrl(value: unknown): string {
  const raw = normalizedText(value);
  if (!raw || /^(?:blob|data):/iu.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function mediaIdFromUrl(value: unknown): string {
  return stableUrl(value).match(/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)/iu)?.[1] || '';
}

function tweetIdFromUrl(value: unknown): string {
  return stableUrl(value).match(/\/(?:status|statuses)\/(\d+)(?:\/|$)/iu)?.[1] || '';
}

export function buildVideoAiSubtitleVideoKey(source: VideoAiSubtitleCacheSource): string | null {
  const tweetId = normalizedText(source.tweetId) || tweetIdFromUrl(source.statusUrl) || tweetIdFromUrl(source.tweetUrl);
  const mediaId = normalizedText(source.mediaId) || mediaIdFromUrl(source.directSource) || mediaIdFromUrl(source.poster);
  if (mediaId) return `media:${mediaId}`;
  const poster = stableUrl(source.poster);
  if (poster) return `poster:${poster}`;
  const directSource = stableUrl(source.directSource);
  if (directSource) return `source:${directSource}`;
  const videoIndex = normalizedText(source.videoIndex);
  return tweetId && videoIndex ? `tweet:${tweetId}:video:${videoIndex}` : null;
}

function sourceLanguage(value: unknown): string {
  const normalized = normalizedText(value).toLocaleLowerCase();
  return normalized.slice(0, 32) || 'auto';
}

export function buildVideoAiSubtitleCacheIdentity(request: VideoAiSubtitleCacheRequest): VideoAiSubtitleCacheIdentity | null {
  const videoKey = buildVideoAiSubtitleVideoKey(request.source);
  if (!videoKey) return null;
  if (request.provider === 'native-qwen') {
    const nativeBaseUrl = normalizeNativeAsrBaseUrl(request.nativeBaseUrl);
    if (request.model !== NATIVE_QWEN_ASR_MODEL || !nativeBaseUrl) return null;
    return {videoKey, model: NATIVE_QWEN_ASR_MODEL, provider: 'native-qwen', nativeBaseUrl,
      sourceLanguage: sourceLanguage(request.videoSourceLanguage ?? request.sourceLanguage), schemaFingerprint: 'video-native-qwen-text-v1'};
  }
  if (request.provider !== undefined && request.provider !== 'browser') return null;
  return {
    videoKey,
    model: normalizeVideoLocalTranscriptionModel(request.model),
    sourceLanguage: sourceLanguage(request.videoSourceLanguage ?? request.sourceLanguage),
    schemaFingerprint: VIDEO_AI_SUBTITLE_CACHE_SCHEMA_FINGERPRINT,
  };
}

export function buildVideoAiSubtitleCacheKey(identity: VideoAiSubtitleCacheIdentity): string {
  if (identity.provider === 'native-qwen') return JSON.stringify([identity.schemaFingerprint, identity.videoKey, identity.model, identity.sourceLanguage, identity.nativeBaseUrl]);
  return [identity.schemaFingerprint, identity.videoKey, identity.model, identity.sourceLanguage].join('|');
}

export function normalizeCompletedVideoAiSubtitleCues(value: unknown): VideoSubtitleCue[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (value.length > VIDEO_AI_SUBTITLE_CACHE_MAX_CUES) return [];
  if (value.some((cue) => !cue || typeof cue !== 'object' || (cue as {partial?: unknown}).partial === true
    || isDegenerateVideoTranscript((cue as VideoSubtitleCue).text))) return [];
  const normalized = normalizeVideoAiSubtitleTimeline(value as VideoSubtitleCue[])
    .filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.durationMs) && cue.text.trim());
  // A bounded cache entry must remain a complete timeline. Silently keeping
  // only the tail would make refresh restore a plausible but incomplete
  // transcript, which is worse than simply rerunning ASR.
  return normalized.map((cue) => structuredClone(cue));
}
