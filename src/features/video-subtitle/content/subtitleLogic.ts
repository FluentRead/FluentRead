/**
 * @file src/features/video-subtitle/content/subtitleLogic.ts
 * 文件职责：提供字幕批量翻译、配置指纹和渐进文本展示的纯逻辑。
 * 主要内容：相同译文保留原文且不重复展示；合成双语导出文本、去重并限制批译并发，生成服务配置键，按原文进度截取译文与按时间选择渐进字幕；按播放速度选取当前句和八条不同的后续原文，排除过期字幕，并以手动偏移计算有效字幕区间。
 * 模块边界：只处理输入数据和注入翻译函数，不读取 DOM、全局配置或浏览器接口。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {buildGlossaryRevision} from '@/src/core/glossary';
import type {Config} from '@/src/core/config/model';
import {resolveConfiguredModel} from '@/src/core/config/catalog';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

/** 根据原文前缀和播放时间选择渐进字幕，支持重复句与短时单词片段。 */
export function findProgressiveVideoCaptionCue(cues: readonly VideoSubtitleCue[], source: string, currentMs: number): VideoSubtitleCue | null {
  const normalizedSource = normalizeVideoCaptionText(source);
  if (!normalizedSource || cues.length === 0) return null;

  const foldedSource = normalizedSource.toLocaleLowerCase();
  const sourceLength = Array.from(normalizedSource).length;
  const getTimeDistance = (cue: VideoSubtitleCue): number => {
    const endMs = cue.startMs + Math.max(cue.durationMs, 500);
    return Number.isFinite(currentMs)
      ? currentMs < cue.startMs
        ? cue.startMs - currentMs
        : currentMs > endMs
          ? currentMs - endMs
          : 0
      : 0;
  };
  const score = (cue: VideoSubtitleCue): number[] => {
    const fullSource = normalizeVideoCaptionText(cue.text);
    const exact = fullSource.toLocaleLowerCase() === foldedSource ? 0 : 1;
    return [
      getTimeDistance(cue),
      exact,
      Math.abs(Array.from(fullSource).length - sourceLength),
      cue.startMs,
    ];
  };

  const pickBest = (predicate: (cue: VideoSubtitleCue, foldedText: string) => boolean): VideoSubtitleCue | null => {
    let best: VideoSubtitleCue | null = null;
    let bestScore: number[] | null = null;
    for (const cue of cues) {
      const foldedText = normalizeVideoCaptionText(cue.text).toLocaleLowerCase();
      if (!predicate(cue, foldedText)) continue;
      const nextScore = score(cue);
      let isBetter = bestScore === null;
      if (bestScore) {
        for (let index = 0; index < nextScore.length; index += 1) {
          if (nextScore[index] === bestScore[index]) continue;
          isBetter = nextScore[index] < bestScore[index];
          break;
        }
      }
      if (isBetter) {
        best = cue;
        bestScore = nextScore;
      }
    }
    return best;
  };

  const matched = pickBest((_cue, fullSource) =>
    fullSource === foldedSource || fullSource.startsWith(foldedSource));
  if (matched) return matched;

  // 部分 YouTube 版本只把“当前词”写入 DOM，而不是写入完整前缀。
  // 此时用播放器时间轴和当前词反查完整 cue，避免一直等不到稳定句子。
  if (!Number.isFinite(currentMs) || normalizedSource.length < 3) return null;
  return pickBest((cue, fullSource) => {
    if (getTimeDistance(cue) > 1200) return false;
    return fullSource.includes(foldedSource) || foldedSource.includes(fullSource);
  });
}

/** 手动校时只改变显示时钟；区间严格使用原始时间戳，不填补空档或修改下载数据。 */
export function selectVideoSubtitleCueAtOffset(cues: readonly VideoSubtitleCue[], playbackMs: number, offsetMs: number): VideoSubtitleCue | null {
  const currentMs = playbackMs - offsetMs;
  if (!Number.isFinite(currentMs)) return null;
  let active: VideoSubtitleCue | null = null;
  for (const cue of cues) {
    if (cue.durationMs <= 0 || currentMs < cue.startMs || currentMs >= cue.startMs + cue.durationMs) continue;
    if (!active || cue.startMs > active.startMs) active = cue;
  }
  return active;
}

/** 当前句独占首位；滚动字幕的重复条目和已结束字幕不占后续八句的预取名额。 */
export function selectVideoSubtitlePretranslationCues(
  cues: readonly VideoSubtitleCue[], currentMs: number, windowMs: number, playbackRate = 1,
): VideoSubtitleCue[] {
  if (!Number.isFinite(currentMs) || !Number.isFinite(windowMs) || windowMs <= 0) return [];
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? Math.max(1, playbackRate) : 1;
  const active = selectVideoSubtitleCueAtOffset(cues, currentMs, 0);
  const upcoming = cues.filter(cue => cue.durationMs > 0 && cue.startMs > currentMs && cue.startMs <= currentMs + windowMs * rate)
    .sort((left, right) => left.startMs - right.startMs);
  const selected: VideoSubtitleCue[] = [];
  const sources = new Set<string>();
  const append = (cue: VideoSubtitleCue): boolean => {
    const source = normalizeVideoCaptionText(cue.text);
    if (!source || sources.has(source)) return false;
    sources.add(source);
    selected.push(cue);
    return true;
  };
  if (active) append(active);
  let count = 0;
  for (const cue of upcoming) {
    if (append(cue)) count += 1;
    if (count === 8) break;
  }
  return selected;
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

/** 原生文本与播放时间必须同时匹配；不得用邻句或其他时段的同文 cue 替换当前原文。 */
export function selectYoutubeCaptionCue(
  cues: readonly VideoSubtitleCue[], source: string, currentMs: number,
): {cue: VideoSubtitleCue | null; stale: boolean} {
  const visible = normalizeVideoCaptionText(source).toLocaleLowerCase();
  if (!visible || !Number.isFinite(currentMs)) return {cue: null, stale: false};
  let selected: VideoSubtitleCue | null = null;
  let selectedRank = Infinity;
  for (const cue of cues) {
    // 正常播放每帧只清洗当前区间的文本；长视频的其他数千句无需反复替换和大小写转换。
    if (currentMs < cue.startMs || currentMs >= cue.startMs + cue.durationMs || cue.durationMs <= 0) continue;
    const text = normalizeVideoCaptionText(cue.text).toLocaleLowerCase();
    if (!text) continue;
    const directRank = text === visible ? 0 : text.startsWith(visible) ? 1 : 3;
    const rank = directRank < 3 ? directRank : hasRollingCaptionPrefix(visible, text) ? 1
      : visible.length >= 3 && (text.includes(visible) || visible.includes(text)) ? 2 : 3;
    if (rank === 3) continue;
    if (rank < selectedRank || (rank === selectedRank && (!selected || cue.startMs > selected.startMs))) {
      selected = cue;
      selectedRank = rank;
    }
  }
  if (selected) return {cue: selected, stale: false};
  // 无当前匹配才判断原生播放器是否残留旧句；找到首个前缀即可停止，不改变跨时段重复句语义。
  const stale = cues.some(cue => {
    const text = normalizeVideoCaptionText(cue.text).toLocaleLowerCase();
    return text.startsWith(visible);
  });
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

/**
 * 双语字幕把原文放在上一行、译文放在下一行。译文与原文相同（包括已是目标语言而跳过翻译）
 * 时只保留一行，避免导出的文件里出现两行一样的字幕。
 */
export function mergeBilingualVideoSubtitleCues(
  cues: readonly VideoSubtitleCue[],
  translated: readonly VideoSubtitleCue[],
): VideoSubtitleCue[] {
  return cues.map((cue, index) => {
    const original = cue.text.trim();
    const translation = (translated[index]?.text || '').trim();
    const unchanged = !hasDistinctTranslation(normalizeVideoCaptionText(original), normalizeVideoCaptionText(translation));
    return {...cue, text: unchanged ? original : `${original}\n${translation}`};
  });
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
    from: value.from,
    videoSourceLanguage: value.videoSourceLanguage,
    videoPreferHumanSubtitles: value.videoPreferHumanSubtitles,
    glossaryRevision: buildGlossaryRevision(value.glossaryLibraries, value.glossaryEnabled),
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
    freeTranslationOrder: service === 'free' ? value.freeTranslationOrder : undefined,
    freeTranslationMode: service === 'free' ? value.freeTranslationMode : undefined,
    minimaxRegion: service === 'minimax' ? value.minimaxRegion : undefined,
    minimaxBillingPlan: service === 'minimax' ? value.minimaxBillingPlan : undefined,
    mimoRegion: service === 'mimo' ? value.mimoRegion : undefined,
    mimoBillingPlan: service === 'mimo' ? value.mimoBillingPlan : undefined,
    deeplApiPlan: service === 'deepl' ? value.deeplApiPlan : undefined,
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
