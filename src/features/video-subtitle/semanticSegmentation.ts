/**
 * @file src/features/video-subtitle/semanticSegmentation.ts
 * 文件职责：按本地规则将字幕原文切分为学习片段。
 * 主要内容：保留 cue 原文映射，在字素边界按有界代价选择分段，起止边界均有依据才标记完整。
 * 模块边界：不改写字幕或生成子句时间；回放范围仅覆盖原始 cue。
 */
import type {VideoSubtitleCue} from './content/youtubeSubtitleData';

const segmenters = typeof Intl.Segmenter === 'function' ? {
  grapheme: new Intl.Segmenter(undefined, {granularity: 'grapheme'}),
  word: new Intl.Segmenter(undefined, {granularity: 'word'}),
} : undefined;
const MAX_SEGMENTATION_CHARACTERS = 16_000;
const MAX_BOUNDARY_PREDECESSORS = 128;
/** 所有文本偏移均为 JavaScript UTF-16 码元；span 不包含 cue 间展示分隔符。 */
interface SourceSpan {cueIndex: number; start: number; end: number; startMs: number; endMs: number}
interface SemanticBoundary {offset: number; score: number}
interface SemanticDocument {text: string; spans: SourceSpan[]; boundaries: SemanticBoundary[]}
export interface SemanticUnit {
  start: number; end: number; text: string; cueIndices: number[]; complete: boolean;
  playback: {precision: 'cue-envelope'; startMs: number; endMs: number} | null;
}
type PlayableSemanticUnit = SemanticUnit & {playback: NonNullable<SemanticUnit['playback']>};

const terminal = /[.!?。！？؟۔।॥]$/u;
const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)|(?<!['’&])\b[A-Za-z])\.$/iu;

/** Punctuation evidence for a source boundary, not a guarantee of grammatical completeness. */
export function hasRuleSentenceEnd(text: string): boolean {
  const tail = text.slice(-80).trimEnd().replace(/["'”’»」』）)\]]+$/u, '');
  return terminal.test(tail) && !abbreviation.test(tail);
}

/** 一个可达的起点和唯一的强边界足以证明整 cue 是最优切分。 */
export function canUseWholeCueSemanticUnit(text: string): boolean {
  // 原始码元数量也限制了候选数。此长度内无长句惩罚，加入任何弱边界只增加代价。
  return segmenters !== undefined && text.length <= MAX_BOUNDARY_PREDECESSORS
    && /^[^.!?。！？؟۔।॥]*[.!?。！？؟۔।॥]["'”’»」』）)\]]*\s*$/u.test(text)
    && hasRuleSentenceEnd(text);
}

/** 空白也属于源文字；cue 之间只有一个显式分隔换行，不压缩或清洗源文字。 */
export function createSemanticDocument(cues: readonly VideoSubtitleCue[]): SemanticDocument {
  if (!segmenters) throw new Error('Unicode segmentation is unavailable');
  let text = '';
  const spans: SourceSpan[] = [];
  for (const [cueIndex, cue] of cues.entries()) {
    if (typeof cue.text !== 'string' || !Number.isFinite(cue.startMs) || cue.startMs < 0
      || !Number.isFinite(cue.durationMs) || cue.durationMs <= 0 || !Number.isFinite(cue.startMs + cue.durationMs)) {
      throw new Error('Invalid subtitle source');
    }
    if (cueIndex) text += '\n';
    const start = text.length;
    text += cue.text;
    if (text.length > MAX_SEGMENTATION_CHARACTERS) throw new Error('Subtitle window too large');
    spans.push({cueIndex, start, end: text.length, startMs: cue.startMs, endMs: cue.startMs + cue.durationMs});
  }
  const protectedSpans = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s]+|[^\s@]+@[^\s@]+\.[^\s@]+|(?:[\p{L}\p{N}_-]+\.)+[\p{L}\p{N}_-]+/gu)]
    .map(match => ({start: match.index, end: match.index + match[0].length}));
  const wordEnds = new Set([...segmenters.word.segment(text)].filter(part => part.isWordLike).map(part => part.index + part.segment.length));
  let protectedIndex = 0;
  const boundaries: SemanticBoundary[] = [];
  const graphemes = [...segmenters.grapheme.segment(text)];
  for (let i = 0; i < graphemes.length; i++) {
    const part = graphemes[i];
    const offset = part.index + part.segment.length;
    const previous = text.slice(Math.max(0, offset - 80), offset).trimEnd();
    const next = graphemes[i + 1]?.segment || '';
    // Repeated/mixed terminal marks form one punctuation run, not standalone sentences.
    if (/^[.!?。！？؟۔।॥]$/u.test(part.segment) && /^[.!?。！？؟۔।॥]$/u.test(next)) continue;
    while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].end <= offset) protectedIndex++;
    if (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].start < offset
      && offset < protectedSpans[protectedIndex].end) continue;
    // 词内不产生普通候选；CJK、标点和空白仍可提供句法候选。
    const strong = hasRuleSentenceEnd(previous)
      && !(/\.$/u.test(previous) && !/\s/u.test(part.segment) && /^[\p{L}\p{N}]/u.test(next));
    if (offset === text.length || wordEnds.has(offset) || /\s/u.test(part.segment) || strong
      || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(part.segment)) {
      // 标点后有空白时只在空白末尾选边界，避免形成空白独立句。
      if (/^[\s"'”’»」』）)\]]/u.test(next)) continue;
      boundaries.push({offset, score: strong ? 8 : -4});
      if (boundaries.length > 2048) throw new Error('Too many subtitle boundaries');
    }
  }
  return {text, spans, boundaries};
}

/** 在候选边界间运行有界动态规划，原文与时间均来自输入 cue。 */
export function segmentSemanticDocument(document: SemanticDocument): SemanticUnit[] {
  if (!document.text) return [];
  const points = [{offset: 0, score: 0}, ...document.boundaries];
  const cost = new Float64Array(points.length).fill(Infinity);
  const from = new Int32Array(points.length).fill(-1);
  cost[0] = 0;
  const rewards = new Int32Array(points.length + 1);
  points.forEach((point, index) => { rewards[index + 1] = rewards[index] + (point.score > 0 ? 12 : 0); });
  for (let end = 1; end < points.length; end++) {
    // 每一候选至多查看 128 个前驱，长单词仍保持原子，不伪造内部词界。
    for (let start = end - 1; start >= Math.max(0, end - MAX_BOUNDARY_PREDECESSORS); start--) {
      const length = points[end].offset - points[start].offset;
      const boundaryScore = points[end].score;
      const lengthPenalty = Math.max(0, length - 240) ** 2 / 240;
      const shortPenalty = length < 12 ? (12 - length) / 3 : 0;
      // 跳过已经确认的高分句尾会有代价，不能为了长度把多个完整句重新粘合。
      const skipped = rewards[end] - rewards[start + 1];
      const candidate = cost[start] + 6 + lengthPenalty + shortPenalty + skipped - boundaryScore;
      if (candidate < cost[end]) { cost[end] = candidate; from[end] = start; }
    }
  }
  const ranges: Array<[number, number]> = [];
  for (let end = points.length - 1; end > 0;) {
    const start = from[end];
    if (start < 0) throw new Error('Unreachable boundary');
    ranges.push([points[start].offset, points[end].offset]);
    end = start;
  }
  const boundaryScores = new Map(points.map(point => [point.offset, point.score]));
  let cursor = 0;
  return ranges.reverse().map(([start, end]) => {
    while (cursor < document.spans.length && document.spans[cursor].end <= start) cursor++;
    const spans: SourceSpan[] = [];
    for (let index = cursor; index < document.spans.length && document.spans[index].start < end; index++) {
      const span = document.spans[index];
      if (span.end > start && span.end > span.start) spans.push(span);
    }
    const confirmedStart = start === 0 || boundaryScores.get(start)! > 0;
    const confirmedEnd = boundaryScores.get(end)! > 0;
    return {start, end, complete: confirmedStart && confirmedEnd,
      text: document.text.slice(start, end), cueIndices: spans.map(span => span.cueIndex),
      playback: spans.length ? {precision: 'cue-envelope' as const, startMs: Math.min(...spans.map(span => span.startMs)),
        endMs: Math.max(...spans.map(span => span.endMs))} : null};
  });
}

export function segmentPlayableSemanticCues(cues: readonly VideoSubtitleCue[]): PlayableSemanticUnit[] {
  return segmentSemanticDocument(createSemanticDocument(cues))
    .filter((unit): unit is PlayableSemanticUnit => unit.playback !== null);
}
