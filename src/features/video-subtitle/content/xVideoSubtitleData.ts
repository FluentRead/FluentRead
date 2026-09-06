/**
 * @file src/features/video-subtitle/content/xVideoSubtitleData.ts
 * 文件职责：解析 X 原生 WebVTT/HLS 字幕，保留字幕与媒体共享的真实时间基准。
 * 主要内容：解析字幕文本、语言 playlist 与 MPEGTS 映射，限制桥接响应体积和资源地址。
 * 模块边界：仅转换传入的文本和 URL，不发起网络请求、不选择播放器、不改变字幕显示时间。
 */
import type { VideoSubtitleCue } from './youtubeSubtitleData';

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

export function decodeHtmlEntities(value: string, useDom = true): string {
  if (useDom && typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
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

export const chooseXSubtitleLanguageResources = selectXSubtitleLanguageResources;
