/**
 * @file src/features/video-subtitle/content/transcriptionCacheClient.ts
 * 文件职责：从当前 X 视频提取可跨刷新复用的身份，并通过后台消息读写完整识别字幕。
 * 主要内容：使用视频所属帖子的链接、媒体缩略图和稳定源定位缓存；校验返回 cue，容忍存储暂时不可用。
 * 模块边界：内容页只传递文本和媒体身份，不直接打开数据库、不保存音频、不决定播放器会话的恢复时机。
 */
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import {normalizeVideoAiSubtitleTimeline} from './video-ai/cueTimeline';
import type {VideoAiSubtitleCacheRequest} from '../transcriptionCache';

export function getVideoTranscriptionCacheRequest(
  video: HTMLVideoElement | null, model: unknown, language: string, href: string,
): VideoAiSubtitleCacheRequest | null {
  if (!video) return null;
  const post = video.closest('article');
  const links = Array.from(post?.querySelectorAll<HTMLAnchorElement>('a[href]') || []);
  const permalink = links.find(link => /\/status\/\d+(?:\/|$)/.test(link.pathname));
  const statusUrl = permalink?.href || href;
  const explicitIndex = statusUrl.match(/\/status\/\d+\/video\/(\d+)(?:[/?#]|$)/)?.[1];
  const videos = Array.from(post?.querySelectorAll('video') || []);
  const index = videos.indexOf(video);
  const videoIndex = explicitIndex || (index >= 0 ? String(index + 1) : '');
  return {source: {
    statusUrl,
    ...(videoIndex ? {videoIndex} : {}),
    poster: video.poster,
    directSource: video.currentSrc || video.src,
  }, model, videoSourceLanguage: language};
}

export class VideoTranscriptionCacheClient {
  constructor(private readonly send: (message: unknown) => Promise<unknown>) {}
  async get(request: VideoAiSubtitleCacheRequest): Promise<VideoSubtitleCue[] | null> {
    try {
      const result = await this.send({type: 'fluentReadGetVideoAiSubtitleCache', ...request}) as
        {success?: boolean; hit?: boolean; cues?: VideoSubtitleCue[]} | undefined;
      if (!result?.success || !result.hit || !Array.isArray(result.cues)) return null;
      const cues = normalizeVideoAiSubtitleTimeline(result.cues);
      return cues.length ? cues : null;
    } catch { return null; }
  }
  async set(request: VideoAiSubtitleCacheRequest, cues: readonly VideoSubtitleCue[]): Promise<void> {
    try { await this.send({type: 'fluentReadSetVideoAiSubtitleCache', ...request, cues}); }
    catch { /* 缓存失败不影响本次已完成字幕。 */ }
  }
}
