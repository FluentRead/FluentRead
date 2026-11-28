/**
 * @file src/features/video-subtitle/content/karaokeLogic.ts
 * 文件职责：提供视频字幕逐字高亮（KTV 式扫光）的纯计算：切分高亮单元、估算时长并把播放进度换算成单元位置。
 * 主要内容：中日文与泰文等不靠空格分词的文字按字切分，其余文字按词切分，标点并入相邻单元以保持避头尾；按字词数量与停顿分配权重；在句子时长内留出收尾余量。
 * 模块边界：只处理字符串与数字，不读取 DOM、配置或播放器；节点构建与逐帧绘制由 karaoke.ts 负责。
 */

export interface VideoKaraokePart {
  text: string;
  /** 0 表示空白分隔符，不参与高亮也不占用时间。 */
  weight: number;
}

export interface VideoKaraokeTiming {
  startMs: number;
  durationMs: number;
}

export interface VideoKaraokePosition {
  /** 正在扫过的单元序号；等于单元总数时整句已点亮。 */
  index: number;
  /** 当前单元已点亮的比例，范围 0–1。 */
  fraction: number;
}

const UNSPACED_SCRIPTS = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}';
const PIECE_PATTERN = new RegExp(`\\s+|[${UNSPACED_SCRIPTS}]\\p{M}*|[^\\s${UNSPACED_SCRIPTS}]+`, 'gu');
const UNSPACED_PATTERN = new RegExp(`[${UNSPACED_SCRIPTS}]`, 'u');
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const OPENING_PUNCTUATION_PATTERN = /[\p{Ps}\p{Pi}]+$/u;
const PAUSE_PATTERN = /[,.!?;:，。！？；：、…]/u;

/** 句子在结束前略早点亮完毕，避免最后一个字刚亮就被下一句替换。 */
const SWEEP_RATIO = .92;

function weighVideoKaraokeUnit(text: string): number {
  let weight = 0;
  for (const character of text) {
    if (UNSPACED_PATTERN.test(character)) weight += 1;
    else if (WORD_CHARACTER_PATTERN.test(character)) weight += .4;
  }
  return Math.max(.6, weight) + (PAUSE_PATTERN.test(text) ? .6 : 0);
}

/**
 * 把一行字幕无损切成高亮单元与空白分隔符，所有片段按顺序拼接后等于原文。
 * 收尾标点跟随前一个单元，起始括号和引号跟随后一个单元，换行时不会把标点单独甩到行首或行尾。
 */
export function splitVideoKaraokeParts(text: string): VideoKaraokePart[] {
  const parts: VideoKaraokePart[] = [];
  let carry = '';
  const pushUnit = (unit: string) => parts.push({text: unit, weight: weighVideoKaraokeUnit(unit)});
  for (const piece of text.match(PIECE_PATTERN) || []) {
    if (/^\s/u.test(piece)) {
      if (carry) pushUnit(carry);
      carry = '';
      parts.push({text: piece, weight: 0});
      continue;
    }
    if (WORD_CHARACTER_PATTERN.test(piece)) {
      pushUnit(carry + piece);
      carry = '';
      continue;
    }
    const opening = piece.match(OPENING_PUNCTUATION_PATTERN)?.[0] || '';
    const closing = piece.slice(0, piece.length - opening.length);
    const previous = parts[parts.length - 1];
    if (closing && previous?.weight) {
      previous.text += closing;
      previous.weight = weighVideoKaraokeUnit(previous.text);
      carry = opening;
    } else {
      carry = closing + opening;
    }
  }
  if (carry) pushUnit(carry);
  return parts;
}

/** 没有时间轴的字幕按阅读速度估算一句话在媒体时间轴上的时长，限制在 1.2–7 秒之间（媒体时钟已随倍速推进）。 */
export function estimateVideoKaraokeDurationMs(text: string, _playbackRate?: number): number {
  const weight = splitVideoKaraokeParts(text).reduce((total, part) => total + part.weight, 0);
  return Math.min(7000, Math.max(1200, Math.round(weight * 230)));
}

/** 播放时间在句子内的扫光进度，范围 0–1；时间无效时停在句首。 */
export function getVideoKaraokeProgress(timing: VideoKaraokeTiming, currentMs: number): number {
  const sweepMs = timing.durationMs * SWEEP_RATIO;
  if (!Number.isFinite(currentMs) || !(sweepMs > 0)) return 0;
  return Math.min(1, Math.max(0, (currentMs - timing.startMs) / sweepMs));
}

/** ends 是各单元权重的累计值；返回进度落在第几个单元以及该单元内的比例。 */
export function locateVideoKaraokePosition(ends: readonly number[], progress: number): VideoKaraokePosition {
  const total = ends[ends.length - 1] || 0;
  if (progress >= 1 || total <= 0) return {index: ends.length, fraction: 0};
  const target = total * Math.max(0, progress);
  let index = 0;
  while (index < ends.length && ends[index] <= target) index += 1;
  if (index >= ends.length) return {index: ends.length, fraction: 0};
  const start = index > 0 ? ends[index - 1] : 0;
  return {index, fraction: Math.max(0, (target - start) / (ends[index] - start))};
}
