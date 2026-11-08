/**
 * @file src/features/video-subtitle/semanticSegmentation.ts
 * 文件职责：为规则与 AI 断句提供同一份无损原文、候选边界和有界优化器。
 * 主要内容：保留 cue 原文映射，只允许字素边界；验证模型边界 ID，按全局代价选择语义分段，完整性需同时具有局部起止边界证据。
 * 模块边界：不请求模型、不改写字幕、不生成子句时间；回放范围仅为覆盖原 cue 的包络。
 */
import type {VideoSubtitleCue} from './content/youtubeSubtitleData';

export const SEMANTIC_ALGORITHM_VERSION = 2;
const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const wordSegmenter = new Intl.Segmenter(undefined, {granularity: 'word'});
export const MAX_SEGMENTATION_CHARACTERS = 16_000;
/** 所有文本偏移均为 JavaScript UTF-16 码元；span 不包含 cue 间展示分隔符。 */
export interface SourceSpan {cueIndex: number; start: number; end: number; startMs: number; endMs: number}
export interface SemanticBoundary {id: string; offset: number; score: number}
export interface SemanticDocument {text: string; spans: SourceSpan[]; boundaries: SemanticBoundary[]}
export interface SemanticUnit {
  start: number; end: number; text: string; cueIndices: number[]; complete: boolean;
  playback: {precision: 'cue-envelope'; startMs: number; endMs: number} | null;
}

const terminal = /[.!?。！？؟۔।॥]["'”’»」』）)\]]*$/u;
const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)|(?<!['’&])\b[A-Za-z])\.$/iu;

/** Punctuation evidence for a source boundary, not a guarantee of grammatical completeness. */
export function hasRuleSentenceEnd(text: string): boolean {
  const tail = text.slice(-80).trimEnd();
  return terminal.test(tail) && !abbreviation.test(tail);
}

/** 空白也属于源文字；cue 之间只有一个显式分隔换行，不压缩或清洗源文字。 */
export function createSemanticDocument(cues: readonly VideoSubtitleCue[]): SemanticDocument {
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
  const wordEnds = new Set([...wordSegmenter.segment(text)].filter(part => part.isWordLike).map(part => part.index + part.segment.length));
  let protectedIndex = 0;
  const boundaries: SemanticBoundary[] = [];
  const graphemes = [...graphemeSegmenter.segment(text)];
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
      boundaries.push({id: `b${offset}`, offset, score: strong ? 8 : -4});
      if (boundaries.length > 2048) throw new Error('Too many subtitle boundaries');
    }
  }
  return {text, spans, boundaries};
}

/** 模型只返回允许的句尾 ID；顺序、唯一性、尾界和字段均必须完全有效。 */
export function parseSemanticBoundaryResponse(document: SemanticDocument, value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'boundaries')) throw new Error('Invalid boundary response');
  const ids = (value as {boundaries?: unknown}).boundaries;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > document.boundaries.length) throw new Error('Invalid boundary list');
  const allowed = new Map(document.boundaries.map(boundary => [boundary.id, boundary.offset]));
  let previous = 0;
  for (const id of ids) {
    const offset = typeof id === 'string' ? allowed.get(id) : undefined;
    if (offset === undefined || offset <= previous) throw new Error('Invalid boundary order');
    previous = offset;
  }
  if (previous !== document.text.length) throw new Error('Missing final boundary');
  return ids as string[];
}

/** 统一有界动态规划；AI 只改变候选代价，无法插字、漏字、改变回放时间。 */
export function segmentSemanticDocument(document: SemanticDocument, aiBoundaries?: readonly string[]): SemanticUnit[] {
  if (!document.text) return [];
  const accepted = aiBoundaries === undefined ? undefined
    : new Set(parseSemanticBoundaryResponse(document, {boundaries: aiBoundaries}));
  const points = [{id: 'b0', offset: 0, score: 0}, ...document.boundaries];
  const cost = new Float64Array(points.length).fill(Infinity);
  const from = new Int32Array(points.length).fill(-1);
  cost[0] = 0;
  const rewards = new Int32Array(points.length + 1);
  points.forEach((point, index) => { rewards[index + 1] = rewards[index] + ((accepted ? accepted.has(point.id) : point.score > 0) ? 12 : 0); });
  for (let end = 1; end < points.length; end++) {
    // 每一候选至多查看 128 个前驱，长单词仍保持原子，不伪造内部词界。
    for (let start = end - 1; start >= Math.max(0, end - 128); start--) {
      const length = points[end].offset - points[start].offset;
      const boundaryScore = accepted ? (accepted.has(points[end].id) ? 12 : -12) : points[end].score;
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
    const confirmedStart = start === 0 || (accepted ? accepted.has(`b${start}`) : boundaryScores.get(start)! > 0);
    const confirmedEnd = accepted && end < document.text.length ? accepted.has(`b${end}`) : boundaryScores.get(end)! > 0;
    return {start, end, complete: confirmedStart && confirmedEnd,
      text: document.text.slice(start, end), cueIndices: spans.map(span => span.cueIndex),
      playback: spans.length ? {precision: 'cue-envelope' as const, startMs: Math.min(...spans.map(span => span.startMs)),
        endMs: Math.max(...spans.map(span => span.endMs))} : null};
  });
}
