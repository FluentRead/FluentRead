/**
 * @file src/features/video-subtitle/content/sentenceTimeline.ts
 * 文件职责：把已有视频字幕的原文 cue 聚合为带可靠音频范围的句子学习材料。
 * 主要内容：仅在原始 cue 边界识别多语言句末标点，以时间、长度、数量和静音间隔限制连续段；保留语境和源索引，并提供重叠安全的播放查句快照。
 * 模块边界：不生成译文或 cue 子时间，不调用播放器、网络或存储；快照仅在字幕材料改变时重建，公开数组查询仍反映调用时的内容。
 */
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export type VideoSentenceBoundary = 'punctuation' | 'gap' | 'limit' | 'end';

export interface VideoSentence {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  /** 原始输入数组索引，译文必须按该映射取值，不能按翻译返回顺序推断时间。 */
  cueIndices: number[];
  previousText: string;
  nextText: string;
  boundary: VideoSentenceBoundary;
  complete: boolean;
}

export interface VideoSentenceTimelineOptions {
  maxDurationMs: number;
  maxCharacters: number;
  maxCues: number;
  maxGapMs: number;
}

export interface VideoSentenceTimeIndex {
  /** 返回快照原数组中的位置；间隙或没有命中时返回 -1。 */
  findIndexAtTime(currentMs: number): number;
  findAtTime(currentMs: number): VideoSentence | null;
}

const DEFAULT_LIMITS: VideoSentenceTimelineOptions = {
  maxDurationMs: 20_000,
  maxCharacters: 420,
  maxCues: 24,
  maxGapMs: 1_500,
};

function normalizedLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasSentenceEnd(text: string): boolean {
  const withoutClosingQuotes = text.replace(/[\s"'”’»」』）)\]]+$/u, '');
  // 字幕只给出了整 cue 时间；一个 cue 即使包含多句也不能杜撰词级时间。
  if (!/[.!?。！？؟۔।॥]$/u.test(withoutClosingQuotes)) return false;
  // 常见称谓/缩写和孤立首字母的点不能证明完整句，等后续 cue 再闭合。
  return !/(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e)|\b[A-Za-z])\.$/iu.test(withoutClosingQuotes);
}

export function normalizeVideoSentenceCueText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function joinVideoSentenceCueText(left: string, right: string): string {
  // 无空格文字保留正常连写；其余文字用空格接回字幕换行。
  const separator = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right) ? '' : ' ';
  return left + separator + right;
}

/** 保守聚合原字幕；超长单 cue 保持原子材料，不伪造它的内部时间点。 */
export function buildVideoSentenceTimeline(
  cues: readonly VideoSubtitleCue[],
  options: Partial<VideoSentenceTimelineOptions> = {},
): VideoSentence[] {
  const limits = {
    maxDurationMs: normalizedLimit(options.maxDurationMs, DEFAULT_LIMITS.maxDurationMs),
    maxCharacters: normalizedLimit(options.maxCharacters, DEFAULT_LIMITS.maxCharacters),
    maxCues: normalizedLimit(options.maxCues, DEFAULT_LIMITS.maxCues),
    maxGapMs: normalizedLimit(options.maxGapMs, DEFAULT_LIMITS.maxGapMs),
  };
  const ordered = cues.map((cue, index) => ({...cue, index, text: normalizeVideoSentenceCueText(cue.text)}))
    .filter(cue => cue.text && Number.isFinite(cue.startMs) && cue.startMs >= 0
      && Number.isFinite(cue.durationMs) && cue.durationMs > 0 && Number.isFinite(cue.startMs + cue.durationMs))
    .sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  const result: VideoSentence[] = [];
  let current: VideoSentence | null = null;
  const flush = (boundary: VideoSentenceBoundary): void => {
    if (!current) return;
    let fingerprint = 2166136261;
    for (const character of current.text) fingerprint = Math.imul(fingerprint ^ character.codePointAt(0)!, 16777619);
    current.id = `sentence:${current.cueIndices.join(',')}:${current.startMs}:${current.endMs}:${(fingerprint >>> 0).toString(36)}`;
    current.boundary = boundary;
    current.complete = boundary === 'punctuation';
    result.push(current);
    current = null;
  };
  for (const cue of ordered) {
    const endMs = cue.startMs + cue.durationMs;
    let joined = cue.text;
    if (current) {
      joined = joinVideoSentenceCueText(current.text, cue.text);
      if (cue.startMs - current.endMs > limits.maxGapMs) flush('gap');
      else if (Math.max(current.endMs, endMs) - current.startMs > limits.maxDurationMs
        || joined.length > limits.maxCharacters || current.cueIndices.length >= limits.maxCues) flush('limit');
    }
    if (!current) {
      current = {
        id: '',
        text: cue.text,
        startMs: cue.startMs,
        endMs,
        cueIndices: [cue.index],
        previousText: '',
        nextText: '',
        boundary: 'end',
        complete: false,
      };
    } else {
      current.text = joined;
      current.endMs = Math.max(current.endMs, endMs);
      current.cueIndices.push(cue.index);
    }
    if (current.endMs - current.startMs > limits.maxDurationMs || current.text.length > limits.maxCharacters
      || current.cueIndices.length > limits.maxCues) flush('limit');
    else if (hasSentenceEnd(cue.text)) flush('punctuation');
  }
  flush('end');
  result.forEach((sentence, index) => {
    sentence.previousText = result[index - 1]?.text || '';
    sentence.nextText = result[index + 1]?.text || '';
  });
  return result;
}

/**
 * 按调用时的数组顺序和时间范围创建快照；原数组可继续编辑，编辑后应重建索引。
 * 起点二分后按最大终点树寻找最近仍覆盖当前时刻的范围，避免长重叠 cue 导致退化为全表回扫。
 */
export function createVideoSentenceTimeIndex(sentences: readonly VideoSentence[]): VideoSentenceTimeIndex {
  const snapshot = Array.from(sentences);
  const ordered = snapshot.map((sentence, index) => ({index, startMs: sentence.startMs, endMs: sentence.endMs}))
    .filter(sentence => sentence.startMs < sentence.endMs)
    .sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  let base = 1;
  while (base < ordered.length) base *= 2;
  const maxEnd = new Float64Array(base * 2).fill(-Infinity);
  ordered.forEach((sentence, index) => { maxEnd[base + index] = sentence.endMs; });
  for (let node = base - 1; node > 0; node -= 1) maxEnd[node] = Math.max(maxEnd[node * 2], maxEnd[node * 2 + 1]);

  const findIndexAtTime = (currentMs: number): number => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordered[middle].startMs <= currentMs) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return -1;
    let node = base + low - 1;
    if (maxEnd[node] > currentMs) return ordered[low - 1].index;
    // 只查看此前的兄弟区间；最大终点已经结束的整段无需逐句检查。
    while (node > 1) {
      if (node % 2 === 1 && maxEnd[node - 1] > currentMs) {
        node -= 1;
        while (node < base) {
          node = node * 2 + 1;
          if (maxEnd[node] <= currentMs) node -= 1;
        }
        return ordered[node - base].index;
      }
      node = Math.floor(node / 2);
    }
    return -1;
  };
  return {findIndexAtTime, findAtTime: currentMs => {
    const index = findIndexAtTime(currentMs);
    return index === -1 ? null : snapshot[index];
  }};
}
