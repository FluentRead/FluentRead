/**
 * @file src/features/video-subtitle/content/subtitleLogic.ts
 * 文件职责：提供字幕批量翻译、配置指纹和渐进文本展示的纯逻辑。
 * 主要内容：相同译文保留原文且不重复展示；为单调排序的时间轴惰性建立 WeakMap 索引（只缓存起点与前缀最大结束时间，不缓存文本以保留原位编辑可见性）实现 O(log n) 当前句、校时偏移、预翻译窗口与 YouTube 活跃区查询，无序数组自动回退线性扫描；优化渐进字幕单次归一化与邻近查找及 YouTube 过期句向外扩散检测；合成双语导出的双行文本和单轨时间轴，去重并限制批译并发，按目录中的实际服务标识生成配置键；按原文进度截取译文。
 * 模块边界：只处理输入数据和注入翻译函数，不读取 DOM、全局配置或浏览器接口。
 */
import {getCompositeTranslationConfigFingerprint} from '@/src/core/config/compositeTranslation';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {createGlossaryRevisionMemoizer} from '@/src/core/glossary';
import type {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, services} from '@/src/core/config/catalog';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

const readGlossaryRevision = createGlossaryRevisionMemoizer();

/** 同一同步更新轮次的选择证据；数组身份、原文和第二次时钟读取相同才可复用。 */
export type YoutubeCueSelection = ReturnType<typeof selectYoutubeCaptionCue> & {cues: readonly VideoSubtitleCue[]; source: string; currentMs: number};

interface SortedCueIndex {
  readonly length: number;
  readonly starts: number[];
  readonly maxMinDisplayEnds: number[];
  readonly maxExactEnds: number[];
}

const EMPTY_CUES: readonly VideoSubtitleCue[] = [];
const sortedCueIndexCache = new WeakMap<readonly VideoSubtitleCue[], {length: number; index: SortedCueIndex | null}>();

function getSortedCueIndex(cues: readonly VideoSubtitleCue[]): SortedCueIndex | null {
  const length = cues.length;
  if (length === 0) return null;
  const cached = sortedCueIndexCache.get(cues);
  if (cached && cached.length === length) return cached.index;

  const starts = new Array<number>(length);
  const maxMinDisplayEnds = new Array<number>(length);
  const maxExactEnds = new Array<number>(length);
  let previousStart = -Infinity;
  let runningMinDisplayEnd = -Infinity;
  let runningExactEnd = -Infinity;

  for (let i = 0; i < length; i += 1) {
    const cue = cues[i]!;
    const startMs = cue.startMs;
    const durationMs = cue.durationMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || startMs < previousStart) {
      sortedCueIndexCache.set(cues, {length, index: null});
      return null;
    }
    previousStart = startMs;
    starts[i] = startMs;
    const minDisplayEnd = startMs + Math.max(durationMs, 500);
    if (minDisplayEnd > runningMinDisplayEnd) runningMinDisplayEnd = minDisplayEnd;
    maxMinDisplayEnds[i] = runningMinDisplayEnd;
    const exactEnd = durationMs > 0 ? startMs + durationMs : -Infinity;
    if (exactEnd > runningExactEnd) runningExactEnd = exactEnd;
    maxExactEnds[i] = runningExactEnd;
  }

  const index: SortedCueIndex = {length, starts, maxMinDisplayEnds, maxExactEnds};
  sortedCueIndexCache.set(cues, {length, index});
  return index;
}

function upperBound(starts: readonly number[], target: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function isBetterScore(nextScore: readonly number[], bestScore: readonly number[] | null): boolean {
  if (!bestScore) return true;
  for (let index = 0; index < nextScore.length; index += 1) {
    if (nextScore[index] === bestScore[index]) continue;
    return nextScore[index]! < bestScore[index]!;
  }
  return false;
}

/** 渐进字幕沿用最短 500ms 展示区间，重叠时选择最新开始的原始 cue。 */
export function findActiveVideoCaptionCue(cues: readonly VideoSubtitleCue[], currentMs: number): VideoSubtitleCue | null {
  if (!Number.isFinite(currentMs)) return null;
  const index = getSortedCueIndex(cues);
  if (index) {
    const upper = upperBound(index.starts, currentMs);
    let active: VideoSubtitleCue | null = null;
    for (let i = upper - 1; i >= 0 && index.maxMinDisplayEnds[i]! > currentMs; i -= 1) {
      const startMs = index.starts[i]!;
      if (active && startMs < active.startMs) break;
      const cue = cues[i]!;
      if (currentMs < startMs + Math.max(cue.durationMs, 500)) active = cue;
    }
    return active;
  }
  let active: VideoSubtitleCue | null = null;
  for (const cue of cues) {
    if (currentMs < cue.startMs || currentMs >= cue.startMs + Math.max(cue.durationMs, 500)) continue;
    if (!active || cue.startMs > active.startMs) active = cue;
  }
  return active;
}

/** X 原生 DOM 残留旧句时跟随已匹配的时间轴，无文本匹配则交回实时翻译。 */
export function selectProgressiveVideoCaptionCue(cues: readonly VideoSubtitleCue[], source: string, currentMs: number): VideoSubtitleCue | null {
  const matched = findProgressiveVideoCaptionCue(cues, source, currentMs);
  const active = findActiveVideoCaptionCue(cues, currentMs);
  if (!active) return matched;
  if (!matched) return null;
  return active.startMs > matched.startMs ? active : matched;
}

/** 根据原文前缀和播放时间选择渐进字幕，支持重复句与短时单词片段。 */
export function findProgressiveVideoCaptionCue(cues: readonly VideoSubtitleCue[], source: string, currentMs: number): VideoSubtitleCue | null {
  const normalizedSource = normalizeVideoCaptionText(source);
  if (!normalizedSource || cues.length === 0) return null;

  const foldedSource = normalizedSource.toLocaleLowerCase();
  const sourceLength = Array.from(normalizedSource).length;
  const finiteTime = Number.isFinite(currentMs);
  const getTimeDistance = (cue: VideoSubtitleCue): number => {
    if (!finiteTime) return 0;
    const endMs = cue.startMs + Math.max(cue.durationMs, 500);
    return currentMs < cue.startMs
      ? cue.startMs - currentMs
      : currentMs > endMs
        ? currentMs - endMs
        : 0;
  };
  const score = (cue: VideoSubtitleCue, fullSource: string, foldedText: string, distance: number): number[] => [
    distance,
    foldedText === foldedSource ? 0 : 1,
    Math.abs(Array.from(fullSource).length - sourceLength),
    cue.startMs,
  ];

  const pickBest = (
    startIndex: number,
    endIndex: number,
    maxDistance: number,
    predicate: (foldedText: string) => boolean,
  ): VideoSubtitleCue | null => {
    let best: VideoSubtitleCue | null = null;
    let bestScore: number[] | null = null;
    for (let i = startIndex; i < endIndex; i += 1) {
      const cue = cues[i]!;
      const distance = getTimeDistance(cue);
      if (distance > maxDistance) continue;
      const fullSource = normalizeVideoCaptionText(cue.text);
      const foldedText = fullSource.toLocaleLowerCase();
      if (!predicate(foldedText)) continue;
      const nextScore = score(cue, fullSource, foldedText, distance);
      if (isBetterScore(nextScore, bestScore)) {
        best = cue;
        bestScore = nextScore;
      }
    }
    return best;
  };

  const prefixPredicate = (fullSource: string) =>
    fullSource === foldedSource || fullSource.startsWith(foldedSource);
  const index = getSortedCueIndex(cues);

  if (index && finiteTime) {
    const upperActive = upperBound(index.starts, currentMs);
    let lowActive = upperActive;
    while (lowActive > 0 && index.maxMinDisplayEnds[lowActive - 1]! >= currentMs) lowActive -= 1;
    const activeMatched = pickBest(lowActive, upperActive, 0, prefixPredicate);
    if (activeMatched) return activeMatched;
  }

  const matched = pickBest(0, cues.length, Infinity, prefixPredicate);
  if (matched) return matched;

  // 部分 YouTube 版本只把“当前词”写入 DOM，而不是写入完整前缀。
  // 此时用播放器时间轴和当前词反查完整 cue，避免一直等不到稳定句子。
  if (!finiteTime || normalizedSource.length < 3) return null;
  const wordPredicate = (fullSource: string) =>
    fullSource.includes(foldedSource) || foldedSource.includes(fullSource);
  if (index) {
    const upperNear = upperBound(index.starts, currentMs + 1200);
    let lowNear = upperNear;
    while (lowNear > 0 && index.maxMinDisplayEnds[lowNear - 1]! >= currentMs - 1200) lowNear -= 1;
    return pickBest(lowNear, upperNear, 1200, wordPredicate);
  }
  return pickBest(0, cues.length, 1200, wordPredicate);
}

/** 手动校时只改变显示时钟；区间严格使用原始时间戳，不填补空档或修改下载数据。 */
export function selectVideoSubtitleCueAtOffset(cues: readonly VideoSubtitleCue[], playbackMs: number, offsetMs: number): VideoSubtitleCue | null {
  const currentMs = playbackMs - offsetMs;
  if (!Number.isFinite(currentMs)) return null;
  const index = getSortedCueIndex(cues);
  if (index) {
    const upper = upperBound(index.starts, currentMs);
    let active: VideoSubtitleCue | null = null;
    for (let i = upper - 1; i >= 0 && index.maxExactEnds[i]! > currentMs; i -= 1) {
      const startMs = index.starts[i]!;
      if (active && startMs < active.startMs) break;
      const cue = cues[i]!;
      if (cue.durationMs > 0 && currentMs < startMs + cue.durationMs) active = cue;
    }
    return active;
  }
  let active: VideoSubtitleCue | null = null;
  for (const cue of cues) {
    if (cue.durationMs <= 0 || currentMs < cue.startMs || currentMs >= cue.startMs + cue.durationMs) continue;
    if (!active || cue.startMs > active.startMs) active = cue;
  }
  return active;
}

/** 当前句独占首位；调用者以新数组发布轨道更新，播放头未跨过边界时复用上次选句。 */
export class VideoSubtitlePretranslationWindow {
  private previous?: {
    cues: readonly VideoSubtitleCue[];
    currentMs: number;
    spanMs: number;
    nextChangeMs: number;
    nextOutsideStartMs: number;
    selected: readonly VideoSubtitleCue[];
  };

  clear(): void {
    if (this.previous) sortedCueIndexCache.delete(this.previous.cues);
    this.previous = undefined;
  }

  select(cues: readonly VideoSubtitleCue[], currentMs: number, windowMs: number, playbackRate = 1): readonly VideoSubtitleCue[] {
    if (!Number.isFinite(currentMs) || !Number.isFinite(windowMs) || windowMs <= 0) return EMPTY_CUES;
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? Math.max(1, playbackRate) : 1;
    const spanMs = windowMs * rate;
    const windowEndMs = currentMs + spanMs;
    const previous = this.previous;
    // 播放头跨过句界，或窗口末端纳入一条新句时，才需要重新选句。
    if (previous?.cues === cues && previous.spanMs === spanMs && currentMs >= previous.currentMs
      && currentMs < previous.nextChangeMs && windowEndMs < previous.nextOutsideStartMs) return previous.selected;

    let active: VideoSubtitleCue | undefined;
    const upcoming: VideoSubtitleCue[] = [];
    let nextChangeMs = Infinity;
    let nextOutsideStartMs = Infinity;
    const index = getSortedCueIndex(cues);
    if (index) {
      const upperCurrent = upperBound(index.starts, currentMs);
      for (let i = upperCurrent - 1; i >= 0 && index.maxExactEnds[i]! > currentMs; i -= 1) {
        const startMs = index.starts[i]!;
        if (active && startMs < active.startMs) break;
        const cue = cues[i]!;
        if (cue.durationMs > 0 && startMs + cue.durationMs > currentMs) active = cue;
      }
      for (let i = upperCurrent; i < cues.length; i += 1) {
        const cue = cues[i]!;
        if (!(cue.durationMs > 0)) continue;
        const startMs = index.starts[i]!;
        if (startMs <= windowEndMs) {
          if (upcoming.length === 0) nextChangeMs = Math.min(nextChangeMs, startMs);
          upcoming.push(cue);
        } else {
          nextOutsideStartMs = startMs;
          break;
        }
      }
    } else {
      for (const cue of cues) {
        const {startMs, durationMs} = cue;
        if (!(durationMs > 0)) continue;
        if (startMs > currentMs) {
          if (startMs <= windowEndMs) {
            upcoming.push(cue);
            nextChangeMs = Math.min(nextChangeMs, startMs);
          } else {
            nextOutsideStartMs = Math.min(nextOutsideStartMs, startMs);
          }
        } else if (startMs + durationMs > currentMs && (!active || startMs > active.startMs)) {
          active = cue;
        }
      }
      upcoming.sort((left, right) => left.startMs - right.startMs);
    }
    if (active) nextChangeMs = Math.min(nextChangeMs, active.startMs + active.durationMs);

    const selected: VideoSubtitleCue[] = [];
    const sources = new Set<string>();
    const append = (cue: VideoSubtitleCue) => {
      const source = normalizeVideoCaptionText(cue.text);
      if (!source || sources.has(source)) return;
      sources.add(source);
      selected.push(cue);
    };
    if (active) append(active);
    const limit = selected.length + 8;
    for (const cue of upcoming) {
      append(cue);
      if (selected.length === limit) break;
    }
    const result = selected.length > 0 ? selected : EMPTY_CUES;
    this.previous = {cues, currentMs, spanMs, nextChangeMs, nextOutsideStartMs, selected: result};
    return result;
  }
}

/** 滚动字幕会保留上一句；仅把末尾完整词组成的前缀用于匹配正在出现的新句。 */
function hasRollingCaptionPrefix(visible: string, full: string): boolean {
  for (let offset = visible.indexOf(' ') + 1; offset > 0; offset = visible.indexOf(' ', offset) + 1) {
    const suffix = visible.slice(offset);
    if (suffix.length < 3) break;
    if (full.startsWith(suffix) && (full.length === suffix.length || /[\s.,!?;:。！？，；：]/.test(full[suffix.length]))) return true;
  }
  return false;
}

function rankYoutubeCaptionText(visible: string, rawText: string): number {
  const text = normalizeVideoCaptionText(rawText).toLocaleLowerCase();
  if (!text) return 3;
  const directRank = text === visible ? 0 : text.startsWith(visible) ? 1 : 3;
  if (directRank < 3) return directRank;
  if (hasRollingCaptionPrefix(visible, text)) return 1;
  return visible.length >= 3 && (text.includes(visible) || visible.includes(text)) ? 2 : 3;
}

/** 原生文本与播放时间必须同时匹配；不得用邻句或其他时段的同文 cue 替换当前原文。 */
export function selectYoutubeCaptionCue(
  cues: readonly VideoSubtitleCue[], source: string, currentMs: number,
): {cue: VideoSubtitleCue | null; stale: boolean} {
  const visible = normalizeVideoCaptionText(source).toLocaleLowerCase();
  if (!visible || !Number.isFinite(currentMs)) return {cue: null, stale: false};
  let selected: VideoSubtitleCue | null = null;
  let selectedRank = Infinity;
  const index = getSortedCueIndex(cues);
  if (index) {
    const upper = upperBound(index.starts, currentMs);
    for (let i = upper - 1; i >= 0 && index.maxExactEnds[i]! > currentMs; i -= 1) {
      const cue = cues[i]!;
      const startMs = index.starts[i]!;
      if (cue.durationMs <= 0 || currentMs >= startMs + cue.durationMs) continue;
      const rank = rankYoutubeCaptionText(visible, cue.text);
      if (rank === 3) continue;
      if (rank < selectedRank || (rank === selectedRank && (!selected || startMs >= selected.startMs))) {
        selected = cue;
        selectedRank = rank;
      }
    }
    if (selected) return {cue: selected, stale: false};
    let stale = false;
    for (let offset = 0; upper - 1 - offset >= 0 || upper + offset < cues.length; offset += 1) {
      const left = upper - 1 - offset;
      if (left >= 0 && normalizeVideoCaptionText(cues[left]!.text).toLocaleLowerCase().startsWith(visible)) {
        stale = true;
        break;
      }
      const right = upper + offset;
      if (right < cues.length && normalizeVideoCaptionText(cues[right]!.text).toLocaleLowerCase().startsWith(visible)) {
        stale = true;
        break;
      }
    }
    return {cue: null, stale};
  }
  for (const cue of cues) {
    // 正常播放每帧只清洗当前区间的文本；长视频的其他数千句无需反复替换和大小写转换。
    if (currentMs < cue.startMs || currentMs >= cue.startMs + cue.durationMs || cue.durationMs <= 0) continue;
    const rank = rankYoutubeCaptionText(visible, cue.text);
    if (rank === 3) continue;
    if (rank < selectedRank || (rank === selectedRank && (!selected || cue.startMs > selected.startMs))) {
      selected = cue;
      selectedRank = rank;
    }
  }
  if (selected) return {cue: selected, stale: false};
  // 无当前匹配才判断原生播放器是否残留旧句；找到首个前缀即可停止，不改变跨时段重复句语义。
  const stale = cues.some(cue => normalizeVideoCaptionText(cue.text).toLocaleLowerCase().startsWith(visible));
  return {cue: null, stale};
}

interface TranslateVideoSubtitleCuesOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export function createVideoSubtitleAbortError(): Error {
  const error = new Error('字幕翻译已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 翻译完整字幕时间轴。相同原文只翻译一次，并限制同时进入共享翻译队列的任务数，
 * 避免长视频一次性排入数百个请求后阻塞播放器当前字幕。
 */
export async function translateVideoSubtitleCues(
  cues: VideoSubtitleCue[],
  translate: (source: string) => Promise<string>,
  options: TranslateVideoSubtitleCuesOptions = {},
): Promise<VideoSubtitleCue[]> {
  if (options.signal?.aborted) throw createVideoSubtitleAbortError();

  const sourceByKey = new Map<string, string>();
  cues.forEach((cue) => {
    const key = normalizeVideoCaptionText(cue.text);
    if (key && !sourceByKey.has(key)) sourceByKey.set(key, cue.text);
  });
  const sources = Array.from(sourceByKey.entries());
  if (sources.length === 0) return [];

  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.floor(options.concurrency as number)
    : 3;
  const concurrency = Math.min(sources.length, Math.max(1, requestedConcurrency));
  const translatedByKey = new Map<string, string>();
  let cursor = 0;
  let completed = 0;
  let failed = false;
  options.onProgress?.(completed, sources.length);

  const worker = async () => {
    while (!failed) {
      if (options.signal?.aborted) {
        failed = true;
        throw createVideoSubtitleAbortError();
      }

      const index = cursor;
      cursor += 1;
      if (index >= sources.length) return;
      const [key, source] = sources[index];

      try {
        const translated = await translate(source);
        if (failed) return;
        if (options.signal?.aborted) throw createVideoSubtitleAbortError();
        const result = typeof translated === 'string' ? translated.trim() : '';
        if (!result) throw new Error(`字幕译文为空：${source.slice(0, 40)}`);
        translatedByKey.set(key, result);
        completed += 1;
        options.onProgress?.(completed, sources.length);
      } catch (error) {
        failed = true;
        // Promise.all 立即交还首错；它仍观察兄弟 worker，迟到结果只会命中 failed 返回。
        throw error ?? new Error('字幕翻译失败');
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return cues.map((cue) => ({
    ...cue,
    text: translatedByKey.get(normalizeVideoCaptionText(cue.text)) || cue.text,
  }));
}

/** 为剪辑导出生成单轨字幕：每种语言占一行，相同译文只显示一次，后续字幕开始时结束上一条。 */
export function mergeBilingualVideoSubtitleCues(
  cues: readonly VideoSubtitleCue[],
  translated: readonly VideoSubtitleCue[],
): VideoSubtitleCue[] {
  const ordered = cues.flatMap((cue, index) => {
    const original = normalizeVideoCaptionText(cue.text);
    const startMs = Math.round(cue.startMs);
    const endMs = Math.max(startMs + 1, Math.round(cue.startMs + cue.durationMs));
    if (!original || cue.startMs < 0 || cue.durationMs <= 0 || !Number.isSafeInteger(endMs)) return [];
    return [{startMs, endMs, original, translation: normalizeVideoCaptionText(translated[index]?.text || '')}];
  }).sort((left, right) => left.startMs - right.startMs);

  const result: VideoSubtitleCue[] = [];
  for (let index = 0; index < ordered.length;) {
    const {startMs} = ordered[index]!;
    let endMs = startMs;
    const originals = new Set<string>();
    const translations = new Set<string>();
    // SRT 只有毫秒精度。同起点的内容按语言合在一条，保留不同台词并去掉重复文本。
    do {
      const cue = ordered[index++]!;
      endMs = Math.max(endMs, cue.endMs);
      originals.add(cue.original);
      if (hasDistinctTranslation(cue.original, cue.translation)) translations.add(cue.translation);
    } while (ordered[index]?.startMs === startMs);
    const durationMs = Math.min(endMs, ordered[index]?.startMs ?? endMs) - startMs;
    const original = [...originals].join(' / ');
    const translation = [...translations].join(' / ');
    result.push({startMs, durationMs, text: translation ? `${original}\n${translation}` : original});
  }
  return result;
}

/** 与后台翻译 cache key 对齐的配置指纹；配置变化时旧译文不能写回视频。 */
export function getVideoTranslationConfigFingerprint(value: Config): string {
  const service = value.videoService || value.service;
  const endpoint = value.proxy[service]
    || (service === 'custom' ? value.custom : '')
    || (service === 'newapi' ? value.newApiUrl : '')
    || (service === 'deeplx' ? value.deeplx : '');
  return JSON.stringify({
    service,
    compositeConnection: getCompositeTranslationConfigFingerprint(value, service),
    from: value.from,
    videoSourceLanguage: value.videoSourceLanguage,
    videoPreferHumanSubtitles: value.videoPreferHumanSubtitles,
    glossaryRevision: readGlossaryRevision(value.glossaryLibraries, value.glossaryEnabled),
    videoGlossaryIds: value.videoGlossaryIds,
    to: value.to,
    model: resolveConfiguredModel(value.model[service], value.customModel[service]),
    endpoint,
    azureOpenaiEndpoint: service === 'azureOpenai' ? value.azureOpenaiEndpoint : '',
    customBody: value.customBody[service] || '',
    customHeaders: value.customHeaders[service] || '',
    requestHeaderRules: value.requestHeaderRules,
    apiKeys: value.apiKeys[service],
    secret: value.secret[service] || '',
    serviceRegion: value.serviceRegion[service] || '',
    requireApiKey: value.requireApiKey,
    freeTranslationOrder: service === services.freeTranslation ? value.freeTranslationOrder : undefined,
    freeTranslationMode: service === services.freeTranslation ? value.freeTranslationMode : undefined,
    minimaxRegion: service === 'minimax' ? value.minimaxRegion : undefined,
    minimaxBillingPlan: service === 'minimax' ? value.minimaxBillingPlan : undefined,
    mimoRegion: service === 'mimo' ? value.mimoRegion : undefined,
    mimoBillingPlan: service === 'mimo' ? value.mimoBillingPlan : undefined,
    deeplApiPlan: service === services.deepL ? value.deeplApiPlan : undefined,
    ak: value.ak, sk: value.sk,
    youdaoAppKey: value.youdaoAppKey, youdaoAppSecret: value.youdaoAppSecret,
    tencentSecretId: value.tencentSecretId, tencentSecretKey: value.tencentSecretKey,
    customOpenAIProviders: value.customOpenAIProviders,
    modelThinking: value.modelThinking,
    systemRole: value.system_role[service] || '',
    userRole: value.user_role[service] || '',
    deepseekApiType: value.deepseekApiType,
    deepseekThinkingMode: value.deepseekThinkingMode,
    token: value.token[service] || '',
    appid: value.appid,
    key: value.key,
    useCache: value.useCache,
  });
}

export function normalizeVideoCaptionText(value: string): string {
  return value.replace(/[\s\u3000]+/g, ' ').trim();
}

function getVideoCaptionPrefixProgress(visibleSource: string, fullSource: string): number | null {
  const visible = normalizeVideoCaptionText(visibleSource);
  const full = normalizeVideoCaptionText(fullSource);
  if (!visible || !full) return null;

  const visibleFolded = visible.toLocaleLowerCase();
  const fullFolded = full.toLocaleLowerCase();
  if (visibleFolded === fullFolded) return 1;
  if (!fullFolded.startsWith(visibleFolded)) return null;

  const visibleLength = Array.from(visible).length;
  const fullLength = Array.from(full).length;
  return Math.min(1, visibleLength / fullLength);
}

/**
 * 原生字幕可能会先把一条 cue 逐词写入 DOM。完整 cue 已经翻译好时，
 * 只揭示与当前原文前缀相同比例的译文，避免连续说话期间一直空白或重复请求。
 * 如果站点一次性给出完整句，则直接返回整句，不人为增加播放延迟。
 */
export function revealVideoSubtitleTranslation(
  translatedText: string,
  visibleSource: string,
  fullSource: string,
): string {
  const translated = translatedText.trim();
  if (!translated) return '';

  const progress = getVideoCaptionPrefixProgress(visibleSource, fullSource);
  if (progress === null || progress >= 1) return translated;

  const units = Array.from(translated);
  const visibleLength = Math.max(1, Math.min(units.length, Math.ceil(units.length * progress)));
  return units.slice(0, visibleLength).join('');
}
