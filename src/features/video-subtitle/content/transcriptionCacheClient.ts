/**
 * @file src/features/video-subtitle/content/transcriptionCacheClient.ts
 * 文件职责：从当前 X 或 HTML 媒体提取可跨刷新复用的身份，并通过后台消息读写完整识别字幕。
 * 主要内容：使用视频所属帖子的链接、媒体缩略图和稳定源定位缓存；比较逐步补全的媒体身份，校验返回 cue，容忍存储暂时不可用。
 * 模块边界：内容页只传递文本和媒体身份，不直接打开数据库、不保存音频、不决定播放器会话的恢复时机。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import {buildVideoAiSubtitleVideoKey, normalizeCompletedVideoAiSubtitleCues, type VideoAiSubtitleCacheRequest, type VideoAiSubtitleCacheSource} from '../transcriptionCache';

/** 元数据补全或暂时缺失不代表换视频；两边都有媒体 ID 时优先拒绝真正的媒体冲突。 */
export function isSameVideoTranscriptionMedia(previous: VideoAiSubtitleCacheSource, next: VideoAiSubtitleCacheSource): boolean {
  const previousKey = buildVideoAiSubtitleVideoKey(previous);
  const nextKey = buildVideoAiSubtitleVideoKey(next);
  if (previousKey && previousKey === nextKey) return true;
  if (previousKey?.startsWith('media:') && nextKey?.startsWith('media:')) return false;
  const previousPoster = buildVideoAiSubtitleVideoKey({poster: previous.poster});
  const nextPoster = buildVideoAiSubtitleVideoKey({poster: next.poster});
  if (previousPoster && nextPoster) return previousPoster === nextPoster;
  const previousDirect = buildVideoAiSubtitleVideoKey({directSource: previous.directSource});
  const nextDirect = buildVideoAiSubtitleVideoKey({directSource: next.directSource});
  if (previousDirect && nextDirect) return previousDirect === nextDirect;
  const postKey = (source: VideoAiSubtitleCacheSource) => buildVideoAiSubtitleVideoKey({
    tweetId: source.tweetId, statusUrl: source.statusUrl, tweetUrl: source.tweetUrl, videoIndex: source.videoIndex,
  });
  const previousPost = postKey(previous);
  return Boolean(previousPost && previousPost === postKey(next));
}

/** 同一媒体丢失临时属性时保留最后确认的信息；切换媒体时直接使用新身份。 */
export function mergeVideoTranscriptionMediaIdentity(
  previous: VideoAiSubtitleCacheSource | null, next: VideoAiSubtitleCacheSource | null, sameMedia: boolean,
): VideoAiSubtitleCacheSource | null {
  return sameMedia && previous && next ? {...next,
    poster: next.poster || previous.poster, directSource: next.directSource || previous.directSource,
  } : next;
}

/** 将 DOM/source 变化与媒体变化分开判断，运行时据此决定保留还是取消识别会话。 */
export function getVideoTranscriptionMediaTransition(
  previous: VideoAiSubtitleCacheSource | null, next: VideoAiSubtitleCacheSource | null,
  sameVideo: boolean, previousSource: string, nextSource: string,
): {sameMedia: boolean; identity: VideoAiSubtitleCacheSource | null; key: string} {
  const previousKey = previous ? buildVideoAiSubtitleVideoKey(previous) || previousSource : '';
  const enriched = sameVideo && previousSource === nextSource && (!previousKey || previousKey.startsWith('blob:'));
  const sameMedia = Boolean(next && (enriched || (previous && isSameVideoTranscriptionMedia(previous, next))));
  const identity = mergeVideoTranscriptionMediaIdentity(previous, next, sameMedia);
  return {sameMedia, identity, key: identity ? buildVideoAiSubtitleVideoKey(identity) || nextSource : ''};
}

const streamIds = new WeakMap<object, string>();
const htmlIdentities = new WeakMap<HTMLMediaElement, {source: string; mediaId: string}>();
let streamSequence = 0;

export function getVideoTranscriptionCacheRequest(
  video: HTMLMediaElement | null, model: unknown, language: string, href: string, confirmedIdentity?: VideoAiSubtitleCacheSource | null,
): VideoAiSubtitleCacheRequest | null {
  if (!video) return null;
  if (confirmedIdentity) return {source: confirmedIdentity, model, videoSourceLanguage: language};
  const page = new URL(href);
  if (!/(^|\.)(x|twitter)\.com$/i.test(page.hostname)) {
    const stream = video.srcObject;
    if (stream && !streamIds.has(stream)) streamIds.set(stream, `stream:${++streamSequence}`);
    const source = stream ? streamIds.get(stream) : video.currentSrc || video.src || video.querySelector<HTMLSourceElement>('source[src]')?.src;
    if (!source) return null;
    // 完整地址只参与摘要，查询参数中的媒体 ID 不丢失，签名和凭据也不写入缓存身份。
    let identity = htmlIdentities.get(video);
    if (!identity || identity.source !== source) {identity = {source, mediaId: `html:${sha256Hex(source)}`}; htmlIdentities.set(video, identity);}
    return {source: {mediaId: identity.mediaId}, model, videoSourceLanguage: language};
  }
  const post = video.closest('article');
  const links = Array.from(post?.querySelectorAll<HTMLAnchorElement>('a[href]') || []);
  const permalink = links.find(link => /\/status\/\d+(?:\/|$)/.test(link.pathname));
  const statusUrl = permalink?.href || href;
  const explicitIndex = statusUrl.match(/\/status\/\d+\/video\/(\d+)(?:[/?#]|$)/)?.[1];
  const videos = Array.from(post?.querySelectorAll<HTMLMediaElement>('video') || []);
  const index = videos.indexOf(video);
  const videoIndex = explicitIndex || (index >= 0 ? String(index + 1) : '');
  let poster = (video as HTMLVideoElement).poster;
  // X 首页有时把缩略图放在 video 的兄弟 img，而非 video.poster；只在当前唯一视频的局部容器找媒体缩略图。
  let scope = video.parentElement;
  for (let depth = 0; !poster && scope && depth < 6; depth += 1, scope = scope.parentElement) {
    const scopedVideos = scope.querySelectorAll('video');
    if (scopedVideos.length !== 1 || scopedVideos[0] !== video) break;
    const image = Array.from(scope.querySelectorAll<HTMLImageElement>('img[src]'))
      .find(candidate => /^https:\/\/pbs\.twimg\.com\/(?:ext_tw_video|amplify_video|tweet_video)_thumb\/\d+\//iu.test(candidate.src));
    poster = image?.src || '';
    if (scope === post) break;
  }
  return {source: {
    statusUrl,
    ...(videoIndex ? {videoIndex} : {}),
    poster,
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
      const cues = normalizeCompletedVideoAiSubtitleCues(result.cues);
      return cues.length ? cues : null;
    } catch { return null; }
  }
  async set(request: VideoAiSubtitleCacheRequest, cues: readonly VideoSubtitleCue[]): Promise<void> {
    try { await this.send({type: 'fluentReadSetVideoAiSubtitleCache', ...request, cues}); }
    catch { /* 缓存失败不影响本次已完成字幕。 */ }
  }
}
