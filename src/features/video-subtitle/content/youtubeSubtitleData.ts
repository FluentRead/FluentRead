/**
 * @file src/features/video-subtitle/content/youtubeSubtitleData.ts
 * 文件职责：提供 YouTube 字幕轨道发现、timedtext 响应解析、增量词流合并、时间轴规范化和 SRT 导出的纯数据处理能力。
 * 主要内容：定义 caption track 与 cue 模型，从页面脚本提取平衡 JSON，选择目标轨道、构造 json3 URL，校验 XML/json3 时间字段，按事件边界合并词流并收敛增量前缀，生成可重复导出的时间轴和安全文件名。
 * 模块边界：模块不监听网络、不修改播放器 DOM也不调用翻译；runtime 消费生成的 cues，youtubeTimedTextBridge 只负责捕获响应，函数可在离线 fixture 中独立验证。
 */
export interface YoutubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: string;
}

export interface VideoSubtitleCue {
  startMs: number;
  durationMs: number;
  text: string;
}

interface YoutubeTimedTextSegment {
  utf8?: unknown;
}

interface YoutubeTimedTextEvent {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: YoutubeTimedTextSegment[];
}

function extractBalancedJson(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}' && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }

  return null;
}

function timedTextVideoId(baseUrl: string): string {
  try {
    return new URL(baseUrl, 'https://www.youtube.com/').searchParams.get('v') || '';
  } catch {
    return '';
  }
}

/**
 * 从 YouTube 页面初始化脚本中读取 captionTracks，不依赖页面私有全局变量。
 * SPA 导航会保留旧视频的初始化脚本；传入 expectedVideoId 后必须继续扫描，
 * 直到响应或 timedtext URL 能明确绑定到当前视频。
 */
export function extractYoutubeCaptionTracks(
  root: ParentNode = document,
  expectedVideoId = '',
): YoutubeCaptionTrack[] {
  const scripts = Array.from(root.querySelectorAll('script'));
  for (const script of scripts) {
    const source = script.textContent || '';
    if (!source.includes('playerCaptionsTracklistRenderer')) continue;

    const markerIndex = source.indexOf('ytInitialPlayerResponse');
    const objectStart = source.indexOf('{', markerIndex >= 0 ? markerIndex : 0);
    const jsonSource = extractBalancedJson(source, objectStart);
    if (!jsonSource) continue;

    try {
      const response = JSON.parse(jsonSource) as {
        videoDetails?: { videoId?: unknown };
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<Record<string, unknown>> } };
      };
      const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks)) continue;

      const responseVideoId = typeof response.videoDetails?.videoId === 'string'
        ? response.videoDetails.videoId
        : '';
      if (expectedVideoId && responseVideoId && responseVideoId !== expectedVideoId) continue;

      const parsedTracks = tracks.flatMap((track) => {
        const baseUrl = typeof track.baseUrl === 'string' ? track.baseUrl : '';
        const languageCode = typeof track.languageCode === 'string' ? track.languageCode : '';
        if (!baseUrl || !languageCode) return [];
        if (expectedVideoId && !responseVideoId && timedTextVideoId(baseUrl) !== expectedVideoId) return [];
        const nameValue = track.name;
        const name = nameValue && typeof nameValue === 'object'
          ? (nameValue as { simpleText?: unknown }).simpleText
          : undefined;
        return [{
          baseUrl,
          languageCode,
          kind: typeof track.kind === 'string' ? track.kind : undefined,
          name: typeof name === 'string' ? name : undefined,
        }];
      });
      if (parsedTracks.length > 0) return parsedTracks;
    } catch {
      // YouTube 页面上的脚本可能被截断或包裹在其他数据中，继续尝试下一个脚本。
    }
  }

  return [];
}

/** 选择原始字幕轨：优先指定语言的人工作品，再回退到人工轨和自动轨。 */
export function chooseYoutubeCaptionTrack(
  tracks: YoutubeCaptionTrack[],
  preferredLanguage?: string,
): YoutubeCaptionTrack | null {
  if (tracks.length === 0) return null;
  const language = preferredLanguage && preferredLanguage !== 'auto'
    ? preferredLanguage.toLowerCase()
    : '';
  const exact = tracks.find((track) => language && track.languageCode.toLowerCase() === language && track.kind !== 'asr');
  if (exact) return exact;
  const human = tracks.find((track) => track.kind !== 'asr');
  // tracks 非空且只分为人工轨/ASR；没有人工轨时第一条必然是 ASR。
  return human || tracks[0]!;
}

/** 从当前 YouTube 地址选择对应初始化脚本中的字幕轨，避免 SPA 导航复用旧视频轨道。 */
export function chooseYoutubeCaptionTrackForLocation(
  root: ParentNode,
  location: Pick<Location, 'hostname' | 'pathname' | 'search'>,
  preferredLanguage?: string,
): YoutubeCaptionTrack | null {
  const videoId = getYoutubeVideoId(location);
  return videoId ? chooseYoutubeCaptionTrack(extractYoutubeCaptionTracks(root, videoId), preferredLanguage) : null;
}

/** 按 YouTube 当前 timedtext 接口约定补充 JSON3 参数；若需要 POT，调用方可再追加。 */
export function buildYoutubeTimedTextUrl(track: YoutubeCaptionTrack): string {
  const url = new URL(track.baseUrl);
  const parameters: Record<string, string> = {
    fmt: 'json3',
    xorb: '2',
    xobt: '3',
    xovt: '3',
    c: 'WEB',
    cplayer: 'UNIPLAYER',
  };
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function decodeHtmlEntities(value: string): string {
  if (typeof document !== 'undefined') {
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

function cleanCueText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim());
}

function numericValue(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

const WORD_STREAM_JOIN_GAP_MS = 700;
const WORD_STREAM_MAX_CUE_SPAN_MS = 8000;
const WORD_STREAM_MAX_WORDS = 14;

function normalizeCueComparisonText(value: string): string {
  return value.replace(/[\s\u3000]+/g, ' ').trim();
}

function countCueWords(value: string): number {
  const normalized = normalizeCueComparisonText(value);
  return normalized.split(' ').filter(Boolean).length;
}

/** 只延续常见称谓后紧接的大写人名式词形；其余歧义缩写保留事件句界。 */
function hasCueTitleContinuation(value: string, nextValue: string): boolean {
  return /\b(?:Mr|Mrs|Ms|Dr|Prof)\.$/i.test(normalizeCueComparisonText(value))
    && /^\p{Lu}[\p{L}\p{M}]+(?=$|[\s.,!?])/u.test(normalizeCueComparisonText(nextValue));
}

function hasCueTerminalPunctuation(value: string, nextValue = ''): boolean {
  const text = normalizeCueComparisonText(value).replace(/["'’”»)\]}」』】）]+$/u, '');
  if (/[!?。！？；;：:…]$/.test(text)) return true;
  if (!text.endsWith('.')) return false;
  // 普通 cue 没有词内连续性证据；末点不跨事件猜测域名、小数或点分缩写。
  return !hasCueTitleContinuation(value, nextValue);
}

/** 自动字幕逐词流通常以短词、短间隔事件连续写入 timedtext。 */
function isWordStreamCue(cue: VideoSubtitleCue, next?: VideoSubtitleCue): boolean {
  const text = normalizeCueComparisonText(cue.text);
  return text.length > 0
    && text.length <= 32
    && countCueWords(text) <= 2
    && !hasCueTerminalPunctuation(text, next?.text);
}

function cueGapMs(previous: VideoSubtitleCue, next: VideoSubtitleCue): number {
  return next.startMs - (previous.startMs + Math.max(previous.durationMs, 500));
}

function canJoinWordStreamCues(previous: VideoSubtitleCue, next: VideoSubtitleCue): boolean {
  return next.startMs >= previous.startMs
    && next.startMs - previous.startMs <= 1800
    && cueGapMs(previous, next) <= WORD_STREAM_JOIN_GAP_MS;
}

function joinCueText(previous: string, next: string): string {
  const left = previous.trim();
  const right = next.trim();
  const leftWord = hasCueTitleContinuation(left, right)
    ? left.slice(0, -1)
    : left.replace(/["'’”»)\]}」』】）,]+$/u, '');
  const rightWord = /^['’](?:s|re|ve|ll|d|m|t)[.,!?;:]*(?=$|\s)/i.test(right)
    ? right
    : right.replace(/^["'’“‘«(\[{「『【（]+/u, '');
  const boundary = [...Array.from(leftWord).slice(-1), ...Array.from(rightWord).slice(0, 1)].join('');
  // 此处只连接不同事件；JSON3 原始 segment 仍按原样 join('')，避免破坏子词。
  const needsSpace = /^[\p{L}\p{N}\p{M}]{2}$/u.test(boundary)
    && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(boundary);
  return `${left}${needsSpace ? ' ' : ''}${right}`;
}

function isPrefixPair(left: string, right: string): boolean {
  const first = normalizeCueComparisonText(left).toLocaleLowerCase();
  const second = normalizeCueComparisonText(right).toLocaleLowerCase();
  return first === second || first.startsWith(second) || second.startsWith(first);
}

/** 同一时间点的增量 cue 只保留最长版本，避免短词抢先命中并阻断完整句预翻译。 */
function collapseIncrementalCues(cues: VideoSubtitleCue[]): VideoSubtitleCue[] {
  const result: VideoSubtitleCue[] = [];
  cues.forEach((cue) => {
    const previous = result[result.length - 1];
    const sameStart = previous && Math.abs(previous.startMs - cue.startMs) <= 120;
    if (!previous || !sameStart || !isPrefixPair(previous.text, cue.text)) {
      result.push(cue);
      return;
    }

    const previousTextLength = Array.from(normalizeCueComparisonText(previous.text)).length;
    const currentTextLength = Array.from(normalizeCueComparisonText(cue.text)).length;
    const winner = currentTextLength >= previousTextLength ? cue : previous;
    const endMs = Math.max(
      previous.startMs + previous.durationMs,
      cue.startMs + cue.durationMs,
    );
    result[result.length - 1] = {
      ...winner,
      durationMs: Math.max(winner.durationMs, endMs - winner.startMs),
    };
  });
  return result;
}

function hasWordStreamRun(cues: VideoSubtitleCue[], startIndex: number): boolean {
  let wordCueCount = 0;
  let previous: VideoSubtitleCue | undefined;
  for (let index = startIndex; index < Math.min(cues.length, startIndex + 4); index += 1) {
    const cue = cues[index];
    if (previous && !canJoinWordStreamCues(previous, cue)) return false;
    if (isWordStreamCue(cue, cues[index + 1])) {
      wordCueCount += 1;
    } else if (!previous || !hasCueTerminalPunctuation(cue.text, cues[index + 1]?.text)) {
      return false;
    }
    previous = cue;
    if (wordCueCount >= 3) return true;
  }
  return false;
}

/** 将明确的逐词 timedtext 合并为播放器可直接显示的短句，普通整段 cue 保持原样。 */
function mergeWordStreamCues(cues: VideoSubtitleCue[]): VideoSubtitleCue[] {
  const result: VideoSubtitleCue[] = [];
  let index = 0;
  while (index < cues.length) {
    if (!hasWordStreamRun(cues, index)) {
      result.push(cues[index]);
      index += 1;
      continue;
    }

    const first = cues[index];
    let last = first;
    let endIndex = index;
    let text = first.text;
    let wordCount = countCueWords(text);
    let endMs = first.startMs + Math.max(first.durationMs, 500);

    while (endIndex + 1 < cues.length) {
      const next = cues[endIndex + 1];
      const following = cues[endIndex + 2];
      if (!canJoinWordStreamCues(last, next)) break;
      const nextIsWordCue = isWordStreamCue(next, following);
      if (!nextIsWordCue && !hasCueTerminalPunctuation(next.text, following?.text)) break;

      const nextWordCount = countCueWords(next.text);
      const nextEndMs = next.startMs + Math.max(next.durationMs, 500);
      if (wordCount + nextWordCount > WORD_STREAM_MAX_WORDS || nextEndMs - first.startMs > WORD_STREAM_MAX_CUE_SPAN_MS) break;

      text = joinCueText(text, next.text);
      wordCount += nextWordCount;
      endMs = Math.max(endMs, nextEndMs);
      last = next;
      endIndex += 1;
      if (hasCueTerminalPunctuation(next.text, following?.text)) break;
    }

    result.push({
      startMs: first.startMs,
      durationMs: Math.max(500, endMs - first.startMs),
      text: normalizeCueComparisonText(text),
    });
    index = endIndex + 1;
  }
  return result;
}

function parseJson3Events(value: unknown): VideoSubtitleCue[] {
  if (!value || typeof value !== 'object') return [];
  const events = (value as { events?: YoutubeTimedTextEvent[] }).events;
  if (!Array.isArray(events)) return [];

  return events.flatMap((event) => {
    const startMs = numericValue(event.tStartMs);
    if (startMs === null || startMs < 0 || !Array.isArray(event.segs)) return [];
    const text = cleanCueText(event.segs
      .map((segment) => typeof segment.utf8 === 'string' ? segment.utf8 : '')
      .join(''));
    if (!text) return [];
    const durationMs = event.dDurationMs === undefined ? 0 : numericValue(event.dDurationMs);
    if (durationMs === null || durationMs < 0 || !Number.isFinite(startMs + durationMs)) return [];
    return [{ startMs, durationMs, text }];
  });
}

function parseXmlEvents(source: string): VideoSubtitleCue[] {
  if (typeof DOMParser !== 'undefined') {
    const documentRoot = new DOMParser().parseFromString(source, 'text/xml');
    const nodes = Array.from(documentRoot.querySelectorAll('text'));
    if (nodes.length > 0) {
      return nodes.flatMap((node) => {
        const start = numericValue(node.getAttribute('start'));
        const durationAttribute = node.getAttribute('dur');
        const duration = durationAttribute === null ? 0 : numericValue(durationAttribute);
        if (start === null || start < 0 || duration === null || duration < 0) return [];
        const startMs = start * 1000;
        const durationMs = duration * 1000;
        if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) return [];
        const text = cleanCueText(node.textContent || '');
        return text ? [{ startMs, durationMs, text }] : [];
      });
    }
  }

  return Array.from(source.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)).flatMap((match) => {
    const attributes = match[1]!;
    const start = numericValue(attributes.match(/\bstart\s*=\s*["']([^"']*)["']/i)?.[1]);
    const durationAttribute = attributes.match(/\bdur\s*=\s*["']([^"']*)["']/i)?.[1];
    const duration = durationAttribute === undefined ? 0 : numericValue(durationAttribute);
    if (start === null || start < 0 || duration === null || duration < 0) return [];
    const startMs = start * 1000;
    const durationMs = duration * 1000;
    const text = cleanCueText(match[2]);
    return Number.isFinite(startMs) && Number.isFinite(durationMs) && text ? [{ startMs, durationMs, text }] : [];
  });
}

/** 解析 YouTube JSON3 或 XML timedtext 响应为统一时间轴。 */
export function parseYoutubeTimedTextResponse(source: string): VideoSubtitleCue[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  try {
    const json = JSON.parse(trimmed);
    const cues = parseJson3Events(json);
    if (cues.length > 0) return cues;
  } catch {
    // 尝试 XML/VTT 回退。
  }
  return parseXmlEvents(trimmed);
}

export function finalizeVideoSubtitleCues(cues: VideoSubtitleCue[]): VideoSubtitleCue[] {
  const ordered = [...cues]
    .filter((cue) => Number.isFinite(cue.startMs) && cue.startMs >= 0 && Number.isFinite(cue.durationMs)
      && Number.isFinite(cue.startMs + cue.durationMs) && cue.text.trim())
    .sort((left, right) => left.startMs - right.startMs);
  const withDurations: VideoSubtitleCue[] = [];
  ordered.forEach((cue, index) => {
    const nextStart = ordered[index + 1]?.startMs;
    const inferredDuration = nextStart !== undefined ? nextStart - cue.startMs : 2000;
    const durationMs = cue.durationMs > 0 ? cue.durationMs : Math.max(500, Math.min(8000, inferredDuration));
    withDurations.push({ ...cue, durationMs });
  });
  // 词流合并可能新产生增量前缀关系；每次有效转换都减少 cue 数，有限收敛保证重复调用幂等。
  let result = withDurations;
  while (true) {
    const finalized = mergeWordStreamCues(collapseIncrementalCues(result));
    if (finalized.length === result.length) return finalized;
    result = finalized;
  }
}

function formatSrtTimestamp(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':') + `,${String(millis).padStart(3, '0')}`;
}

export function cuesToSrt(cues: VideoSubtitleCue[]): string {
  return finalizeVideoSubtitleCues(cues).map((cue, index) => {
    const endMs = cue.startMs + cue.durationMs;
    return `${index + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(endMs)}\n${cue.text}\n`;
  }).join('\n');
}

export function getYoutubeVideoId(locationLike: Pick<Location, 'hostname' | 'pathname' | 'search'> = window.location): string {
  try {
    const url = new URL(locationLike.pathname + locationLike.search, `https://${locationLike.hostname}`);
    return url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

export function sanitizeSubtitleFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'youtube-subtitles';
}
