/**
 * @file src/features/video-subtitle/background/cacheHandlers.ts
 * 文件职责：为完整视频 AI 字幕缓存提供受约束的后台消息接口。
 * 主要内容：校验 get/set 请求、只转发完整 cue，并暴露统计和清空操作给内容页或设置页。
 * 模块边界：不访问浏览器页面、不保存音频或凭据；持久化、TTL 与 LRU 规则由 transcriptionCache repository 负责。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {VideoSubtitleCue} from '@/src/features/video-subtitle/content/youtubeSubtitleData';
import {
  buildVideoAiSubtitleCacheIdentity,
  buildVideoAiSubtitleCacheKey,
  VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
  type VideoAiSubtitleCacheRequest,
} from '@/src/features/video-subtitle/transcriptionCache';
import type {VideoAiSubtitleCacheRepository} from './transcriptionCache';

export {VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE, VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE, VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE, VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE};

type CacheContext = unknown;
type GetMessage = BackgroundMessageHandler<CacheContext>;

function request(value: unknown): VideoAiSubtitleCacheRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('视频 AI 字幕缓存请求身份无效');
  const input = value as Record<string, unknown>;
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) throw new TypeError('视频 AI 字幕缓存 source 无效');
  return {source: input.source as VideoAiSubtitleCacheRequest['source'], model: input.model, sourceLanguage: input.sourceLanguage, videoSourceLanguage: input.videoSourceLanguage,
    provider: input.provider, nativeBaseUrl: input.nativeBaseUrl};
}

export function createVideoAiSubtitleCacheHandlers(repository: VideoAiSubtitleCacheRepository): readonly GetMessage[] {
  const get: GetMessage = {
    type: VIDEO_AI_SUBTITLE_CACHE_GET_MESSAGE,
    async handle(message: any) {
      const input = request(message);
      const identity = buildVideoAiSubtitleCacheIdentity(input);
      if (!identity) return {success: true, hit: false, cacheKey: null, cues: []};
      const cues = await repository.get(input);
      return {success: true, hit: cues !== null, cacheKey: buildVideoAiSubtitleCacheKey(identity), cues: cues || []};
    },
  };
  const set: GetMessage = {
    type: VIDEO_AI_SUBTITLE_CACHE_SET_MESSAGE,
    async handle(message: any) {
      const input = request(message);
      const cues = Array.isArray(message.cues) ? message.cues as VideoSubtitleCue[] : message.cues;
      const cached = await repository.set(input, cues);
      return {success: true, cached};
    },
  };
  const stats: GetMessage = {
    type: VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
    async handle() {
      return {success: true, stats: await repository.stats()};
    },
  };
  const clear: GetMessage = {
    type: VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
    async handle() {
      await repository.clear();
      return {success: true};
    },
  };
  return [get, set, stats, clear];
}
