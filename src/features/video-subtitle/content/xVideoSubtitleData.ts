/**
 * @file src/features/video-subtitle/content/xVideoSubtitleData.ts
 * 文件职责：解析 X 原生 WebVTT/HLS 字幕与时间线中的已公开视频资源，保留字幕与媒体共享的真实时间基准。
 * 主要内容：解析字幕文本、语言 playlist 与 MPEGTS 映射；从有界 video_info 提取同站媒体地址，并验证桥接消息、页面归属和字幕加载条件。
 * 模块边界：仅转换传入的文本和 URL，不发起网络请求、不选择播放器、不改变字幕显示时间。
 */
import type { VideoSubtitleCue } from './youtubeSubtitleData';
import {decodeTextareaHtml} from '@/src/shared/text/htmlEntities';

export interface XSubtitleResource {
  url: string;
  offsetMs: number;
  languageCode?: string;
}

export interface ParsedXSubtitleResource {
  cues: VideoSubtitleCue[];
  resources: XSubtitleResource[];
}

const MAX_SUBTITLE_SOURCE_LENGTH = 1_000_000;
const MAX_RESOURCE_URL_LENGTH = 8_192;
export const X_VIDEO_MEDIA_RESOURCES_MESSAGE = 'fluent-read-x-video-media-resources';
export interface XVideoMediaVariant {url: string; bitrate?: number}
export type ParsedXVideoBridgeMessage = {kind: 'media'; variants: XVideoMediaVariant[]}
  | {kind: 'subtitle'; url: string; responseText: string; loadCaptions: boolean};

/** 信任边界在浏览器 runtime；这里只验证桥接数据，并通过纯上下文端口判断页面/媒体归属。 */
export function parseXVideoBridgeMessage(input: unknown, context: {
  matchesPage: (pageHref: string) => boolean;
  mediaSource: string;
  videoCount: () => number;
}): ParsedXVideoBridgeMessage | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as {source?: unknown; type?: unknown; url?: unknown; responseText?: unknown; pageHref?: unknown};
  if (data.source !== 'fluent-read') return null;
  if (typeof data.pageHref === 'string' && (data.pageHref.length > MAX_RESOURCE_URL_LENGTH || !context.matchesPage(data.pageHref))) return null;
  if (data.type === X_VIDEO_MEDIA_RESOURCES_MESSAGE) {
    if (typeof data.responseText !== 'string' || data.responseText.length > 100_000) return null;
    let values: unknown;
    try { values = JSON.parse(data.responseText); } catch { return null; }
    if (!Array.isArray(values) || values.length > 96) return null;
    const variants: XVideoMediaVariant[] = [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const variant = value as {url?: unknown; bitrate?: unknown};
      if (!isXVideoMediaVariantUrl(variant.url)) continue;
      const bitrate = typeof variant.bitrate === 'number' && Number.isFinite(variant.bitrate) && variant.bitrate > 0 ? variant.bitrate : undefined;
      variants.push({url: variant.url, ...(bitrate ? {bitrate} : {})});
    }
    return {kind: 'media', variants};
  }
  if (data.type !== 'fluent-read-x-video-subtitle-resource' || typeof data.url !== 'string'
    || typeof data.responseText !== 'string' || data.responseText.length > MAX_SUBTITLE_SOURCE_LENGTH || !isXSubtitleResourceUrl(data.url)) return null;
  // 所有已验证的 HLS 仍交给音轨 reader 自行按 ID 选择；只有当前播放器
  // 的字幕旁路可进入原生字幕 loader，推荐视频的清单不能污染字幕时间轴。
  const mediaId = context.mediaSource.match(/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)/)?.[1];
  const matchesMedia = mediaId ? data.url.includes(`/${mediaId}/`) : context.videoCount() <= 1;
  return {kind: 'subtitle', url: data.url, responseText: data.responseText,
    loadCaptions: matchesMedia && /WEBVTT|TYPE=SUBTITLES/i.test(data.responseText)};
}

/** 仅旁路 X 自己的时间线/详情响应，不请求 API、不读取或转发 headers 与正文。 */
export function isXVideoMetadataUrl(value: string, pageHref: string): boolean {
  try {
    const page = new URL(pageHref);
    const url = new URL(value, pageHref);
    const isX = (host: string) => host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com';
    return page.protocol === 'https:' && isX(page.hostname) && url.protocol === 'https:' && isX(url.hostname)
      && /^\/i\/api\/graphql\/[^/]+\/(?:TweetDetail|TweetResultByRestId|HomeTimeline|HomeLatestTimeline|UserTweets|UserTweetsAndReplies|UserMedia|SearchTimeline|Bookmarks|ListLatestTweetsTimeline)$/.test(url.pathname);
  } catch { return false; }
}

export function isXVideoMediaVariantUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_RESOURCE_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'video.twimg.com' && !url.username && !url.password
      && /\/(?:ext_tw_video|amplify_video|tweet_video)\/\d+\//.test(url.pathname)
      && /\.(?:m3u8|mp4)$/i.test(url.pathname);
  } catch { return false; }
}

/** video_info 可在多种 GraphQL 包装下；只输出 URL/码率，不把原 JSON 带出 MAIN world。 */
export function parseXVideoMediaVariants(text: unknown): XVideoMediaVariant[] {
  if (typeof text !== 'string' || text.length > 2_000_000) return [];
  let root: unknown;
  try { root = JSON.parse(text); } catch { return []; }
  const pending: unknown[] = [root];
  const variants = new Map<string, XVideoMediaVariant>();
  let visited = 0;
  while (pending.length && visited < 20_000 && variants.size < 96) {
    const value = pending.pop();
    visited += 1;
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const info = record.video_info;
    if (info && typeof info === 'object' && Array.isArray((info as {variants?: unknown}).variants)) {
      for (const variant of (info as {variants: unknown[]}).variants.slice(0, 12)) {
        if (variants.size >= 96) break;
        if (!variant || typeof variant !== 'object') continue;
        const entry = variant as {url?: unknown; content_type?: unknown; bitrate?: unknown};
        if (!isXVideoMediaVariantUrl(entry.url) || !['application/x-mpegURL', 'application/vnd.apple.mpegurl', 'video/mp4'].includes(String(entry.content_type))) continue;
        const bitrate = typeof entry.bitrate === 'number' && Number.isFinite(entry.bitrate) && entry.bitrate > 0 ? entry.bitrate : undefined;
        variants.set(entry.url, {url: entry.url, ...(bitrate ? {bitrate} : {})});
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'video_info') continue;
      if (child && typeof child === 'object' && pending.length < 20_000) pending.push(child);
    }
  }
  return [...variants.values()];
}

export function isXVideoBridgeResourceUrl(url: string, pageHref: string): boolean {
  return isXSubtitleResourceUrl(url) || isXVideoMetadataUrl(url, pageHref);
}

export function createXVideoBridgeResourcePayload(url: string, responseText: unknown, pageHref: string) {
  if (!isXVideoMetadataUrl(url, pageHref)) return createXSubtitleResourcePayload(url, responseText, pageHref);
  if (pageHref.length > MAX_RESOURCE_URL_LENGTH) return null;
  const variants = parseXVideoMediaVariants(responseText);
  return variants.length ? {
    source: 'fluent-read' as const, type: X_VIDEO_MEDIA_RESOURCES_MESSAGE,
    // 不保留 GraphQL 地址的查询参数，其中可能包含用户级游标或状态。
    url: new URL(url, pageHref).origin + new URL(url, pageHref).pathname,
    responseText: JSON.stringify(variants), pageHref,
  } : null;
}

export function decodeHtmlEntities(value: string, useDom = true): string {
  if (useDom && typeof document !== 'undefined') {
    return decodeTextareaHtml(value);
  }

  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function cleanSubtitleText(value: string): string {
  const decoded = decodeHtmlEntities(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ''));
  // X 的逐词时间扩展有时经过实体转义；只移除解码后的该元数据，
  // 不把字幕里有意转义的 <vector> 等正文再按 HTML 标签剥离。
  return decoded
    .replace(/<\/?x-word-ms(?:\s[^<>]*)?\/?>/gi, '')
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

export function parseTimestamp(value: string): number | null {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length === 1 ? Number(parts[0]) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return (hours * 3_600 + minutes * 60 + seconds) * 1000;
}

/** 解析 X 原生字幕常见的 WebVTT sidecar；时间偏移用于 HLS 分片字幕。 */
export function parseWebVttSubtitleResponse(source: string, offsetMs = 0): VideoSubtitleCue[] {
  if (typeof source !== 'string' || source.length > MAX_SUBTITLE_SOURCE_LENGTH) return [];
  const lines = source.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const cues: VideoSubtitleCue[] = [];
  let index = 0;
  // RFC 8216 的 WebVTT cue 时间属于媒体时间轴，不能再累加 EXTINF 片段时长。
  // 存在 X-TIMESTAMP-MAP 时，只用 LOCAL→MPEGTS 映射；offsetMs 用来解开 33 位回绕。
  const mapping = source.match(/^X-TIMESTAMP-MAP\s*=([^\r\n]+)/im)?.[1];
  const local = mapping?.match(/LOCAL:([^,\s]+)/i)?.[1];
  const pts = mapping?.match(/MPEGTS:(\d+)/i)?.[1];
  const localMs = local ? parseTimestamp(local) : null;
  const wrapMs = 2 ** 33 / 90;
  const rawOffset = pts && localMs !== null ? Number(pts) / 90 - localMs : 0;
  // RFC 8216 §3.5: without X-TIMESTAMP-MAP, LOCAL 0 maps to MPEGTS 0.
  // HLS segment offsets are playlist bookkeeping and must not be added here.
  const mapOffset = mapping && pts && localMs !== null
    ? rawOffset + Math.round((offsetMs - rawOffset) / wrapMs) * wrapMs
    : 0;

  while (index < lines.length) {
    const current = lines[index].trim();
    if (!current) {
      index += 1;
      continue;
    }
    if (/^(?:NOTE(?:\s|$)|STYLE$|REGION$)/i.test(current)) {
      index += 1;
      while (index < lines.length && lines[index].trim() !== '') index += 1;
      continue;
    }

    let timing = current;
    if (!timing.includes('-->') && lines[index + 1]?.includes('-->')) {
      timing = lines[index + 1].trim();
      index += 1;
    }

    const match = timing.match(/^([^ ]+)\s+-->\s+([^ ]+)/);
    if (!match) {
      index += 1;
      continue;
    }

    const startMs = parseTimestamp(match[1]);
    const endMs = parseTimestamp(match[2]);
    if (startMs === null || endMs === null || endMs <= startMs) {
      index += 1;
      continue;
    }

    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '') {
      if (lines[index].includes('-->') && textLines.length === 0) break;
      textLines.push(lines[index]);
      index += 1;
    }

    const text = cleanSubtitleText(textLines.join('\n'));
    if (text) {
      cues.push({
        startMs: Math.max(0, mapOffset + startMs),
        durationMs: endMs - startMs,
        text,
      });
    }
  }

  return cues;
}

export function readAttribute(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`${name}=(?:"([^"]*)"|([^,]*))`, 'i'));
  return (match?.[1] || match?.[2] || '').trim() || undefined;
}

export function resolveResourceUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value.trim().replace(/^"|"$/g, ''), baseUrl).toString();
  } catch {
    return null;
  }
}

export function languageCodeFromUrl(url: string): string | undefined {
  if (!/^https?:\/\/[^[]+$/i.test(url)) return undefined;
  const path = new URL(url).pathname;
  const match = path.match(/\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)\.(?:m3u8|vtt|webvtt|srt)$/i);
  if (!match) return undefined;
  return match[1];
}

/**
 * 解析 X 的字幕 master/media playlist。master playlist 通常通过
 * #EXT-X-MEDIA:TYPE=SUBTITLES 指向语言 playlist，media playlist 再列出
 * 带时间偏移的 WebVTT 分片。
 */
export function parseXSubtitleResource(source: string, baseUrl: string, segmentStartMs = 0): ParsedXSubtitleResource {
  if (typeof source !== 'string' || source.length > MAX_SUBTITLE_SOURCE_LENGTH) return {cues: [], resources: []};
  try {
    const parsedBase = new URL(baseUrl);
    if (parsedBase.protocol !== 'https:') return {cues: [], resources: []};
  } catch {
    return {cues: [], resources: []};
  }
  const trimmed = source.trim();
  if (/^WEBVTT(?:\s|$)/i.test(trimmed)) {
    return { cues: parseWebVttSubtitleResponse(trimmed, segmentStartMs), resources: [] };
  }
  // 完整 HLS 列表有 EXTM3U 头；桥接也允许单独捕获的字幕 MEDIA 标签。
  // 不能把 200 错误页或普通正文当作相对资源。
  if (!/^#EXTM3U(?:\s|$)/i.test(trimmed)
    && !/^\s*#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/im.test(trimmed)) return {cues: [], resources: []};

  const resources: XSubtitleResource[] = [];
  const lines = trimmed.replace(/\r/g, '').split('\n');
  const hasSubtitleMediaTag = lines.some((line) => /#EXT-X-MEDIA:/i.test(line) && /TYPE=SUBTITLES/i.test(line));
  let pendingDurationMs = 0;
  let offsetMs = 0;

  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;

    if (normalized.startsWith('#EXT-X-MEDIA:') && /TYPE=SUBTITLES/i.test(normalized)) {
      const resourceUrl = readAttribute(normalized, 'URI');
      const resolvedUrl = resourceUrl ? resolveResourceUrl(resourceUrl, baseUrl) : null;
      if (resolvedUrl && isXSubtitleResourceUrl(resolvedUrl)) {
        resources.push({
          url: resolvedUrl,
          offsetMs: 0,
          languageCode: readAttribute(normalized, 'LANGUAGE') || languageCodeFromUrl(resolvedUrl),
        });
      }
      continue;
    }

    const duration = normalized.match(/^#EXTINF:([\d.]+)/i);
    if (duration) {
      pendingDurationMs = Number(duration[1]) * 1000;
      continue;
    }

    if (normalized.startsWith('#') || hasSubtitleMediaTag) continue;
    const resolvedUrl = resolveResourceUrl(normalized, baseUrl);
    if (!resolvedUrl || !isXSubtitleResourceUrl(resolvedUrl)) continue;

    resources.push({
      url: resolvedUrl,
      offsetMs,
      languageCode: languageCodeFromUrl(resolvedUrl),
    });
    offsetMs += Number.isFinite(pendingDurationMs) ? pendingDurationMs : 0;
    pendingDurationMs = 0;
  }

  return { cues: [], resources };
}

export function isXSubtitleResourceUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESOURCE_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'video.twimg.com' || host.endsWith('.twimg.com'))
      && /(?:\.m3u8|\.vtt|\.webvtt|\/captions\/|\/subtitles?\/)/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** MAIN-world 数据只用于字幕资源旁路，绝不接受无界响应或其它站点地址。 */
export function createXSubtitleResourcePayload(url: string, responseText: unknown, pageHref: string) {
  if (!isXSubtitleResourceUrl(url) || typeof pageHref !== 'string' || pageHref.length > MAX_RESOURCE_URL_LENGTH || typeof responseText !== 'string'
    || responseText.length > 1_000_000
    || !(/WEBVTT/i.test(responseText) || /^\s*#EXTM3U\b/i.test(responseText)
      || /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/i.test(responseText))) return null;
  return {source: 'fluent-read' as const, type: 'fluent-read-x-video-subtitle-resource', url, responseText, pageHref};
}

/** 只选择一条原生字幕语言轨道；偏好语言不存在时回退到第一条轨道。 */
export function selectXSubtitleLanguageResources<T extends {languageCode?: string}>(
  resources: readonly T[],
  preferredLanguage?: string,
): T[] {
  if (!resources.length) return [];
  const normalized = typeof preferredLanguage === 'string' ? preferredLanguage.trim().toLowerCase() : '';
  if (!normalized || normalized === 'auto') return resources.filter((resource) => resource.languageCode === resources[0].languageCode);
  const exact = resources.find((resource) => resource.languageCode?.toLowerCase() === normalized);
  const base = resources.find((resource) => resource.languageCode?.toLowerCase().split('-')[0] === normalized.split('-')[0]);
  const selectedCode = (exact || base || resources[0]).languageCode;
  return resources.filter((resource) => resource.languageCode === selectedCode);
}
