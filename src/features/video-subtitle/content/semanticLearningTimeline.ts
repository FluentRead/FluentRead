/**
 * @file src/features/video-subtitle/content/semanticLearningTimeline.ts
 * 文件职责：在既有有界回放组上提供独立语义句，避免把句内切分伪装为词级对齐。
 * 主要内容：保留语义偏移和共享 cue 包络，沿用学习面板的字幕文本拼接，静音间隔后重置起始确认，有界缓存单组语义切分以加速渐进字幕追加，并在热路径时间索引中以三字段直接比较替代 JSON 序列化。
 * 模块边界：不改变原字幕显示或导出时间；播放器跟随时保留同包络的当前选择；上限切出的下一组保留起点不确定性，直到出现确认边界或静音间隔。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {buildVideoSentenceTimeline, createVideoSentenceTimeIndex, joinVideoSentenceCueText, normalizeVideoSentenceCueText, type VideoSentence} from './sentenceTimeline';
import {canUseWholeCueSemanticUnit, hasRuleSentenceEnd, segmentPlayableSemanticCues, type SemanticUnit} from '../semanticSegmentation';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
interface SemanticLearningSentence extends VideoSentence {playbackGroupId: string}

interface CachedGroupCue {
  text: string;
  startMs: number;
  durationMs: number;
}
const MAX_GROUP_CACHE_ENTRIES = 512;
const groupSegmentCache = new Map<string, {cues: CachedGroupCue[]; units: SemanticLearningSentence[]}>();

function formatSemanticUnit(unit: SemanticUnit, cues: readonly VideoSubtitleCue[], offsets: readonly number[]): string {
  let text = '';
  for (const index of unit.cueIndices) {
    const offset = offsets[index];
    const fragment = normalizeVideoSentenceCueText(cues[index].text.slice(Math.max(0, unit.start - offset), unit.end - offset));
    if (fragment) text = text ? joinVideoSentenceCueText(text, fragment) : fragment;
  }
  return text;
}

export function buildSemanticLearningTimeline(cues: readonly VideoSubtitleCue[]): SemanticLearningSentence[] {
  const result: SemanticLearningSentence[] = [];
  let previousSourceEnded = true;
  for (const group of buildVideoSentenceTimeline(cues)) {
    const groupStartConfirmed = previousSourceEnded;
    const lastCue = cues[group.cueIndices[group.cueIndices.length - 1]];
    previousSourceEnded = group.boundary === 'gap' || hasRuleSentenceEnd(lastCue.text);
    if (group.cueIndices.length === 1 && canUseWholeCueSemanticUnit(lastCue.text)) {
      result.push({...group, complete: groupStartConfirmed, playbackGroupId: group.id});
      continue;
    }
    const groupCues = group.cueIndices.map(index => cues[index]);
    const cacheKey = `${group.id}\0${groupStartConfirmed ? 1 : 0}\0${groupCues.length}`;
    const cached = groupSegmentCache.get(cacheKey);
    if (cached && cached.cues.every((item, index) => item.text === groupCues[index].text
      && item.startMs === groupCues[index].startMs
      && item.durationMs === groupCues[index].durationMs)) {
      groupSegmentCache.delete(cacheKey);
      groupSegmentCache.set(cacheKey, cached);
      for (const unit of cached.units) result.push({...unit, cueIndices: [...unit.cueIndices]});
      continue;
    }
    // 计算原始 UTF-16 位置，组内每两个 cue 之间有一个合成换行。
    let sourceEnd = -1;
    const offsets = groupCues.map(cue => {
      const start = sourceEnd + 1;
      sourceEnd = start + cue.text.length;
      return start;
    });
    let units: ReturnType<typeof segmentPlayableSemanticCues>;
    try { units = segmentPlayableSemanticCues(groupCues); }
    catch {
      result.push({...group, complete: group.complete && groupStartConfirmed, playbackGroupId: group.id});
      continue;
    }
    let sourceIdentity: string | undefined;
    const groupResult: SemanticLearningSentence[] = [];
    for (const unit of units) {
      const coversGroup = unit.start === 0 && unit.end === sourceEnd;
      const entry: SemanticLearningSentence = {...group,
        id: coversGroup ? group.id : `${group.id}:semantic:${sourceIdentity ??= sha256Hex(JSON.stringify(groupCues))}:${unit.start}:${unit.end}`,
        text: coversGroup ? group.text : formatSemanticUnit(unit, groupCues, offsets),
        startMs: unit.playback.startMs, endMs: unit.playback.endMs,
        cueIndices: unit.cueIndices.map(index => group.cueIndices[index]),
        complete: unit.complete && (unit.start > 0 || groupStartConfirmed),
        playbackGroupId: group.id};
      groupResult.push(entry);
      result.push({...entry, cueIndices: [...entry.cueIndices]});
    }
    groupSegmentCache.set(cacheKey, {
      cues: groupCues.map(({text, startMs, durationMs}) => ({text, startMs, durationMs})),
      units: groupResult,
    });
    if (groupSegmentCache.size > MAX_GROUP_CACHE_ENTRIES) {
      groupSegmentCache.delete(groupSegmentCache.keys().next().value!);
    }
  }
  result.forEach((unit, index) => {unit.previousText = result[index - 1]?.text || ''; unit.nextText = result[index + 1]?.text || '';});
  return result;
}
/** 同 cue 多句共享时间时不能凭播放器时钟猜是哪一句；优先保留选择，否则取该包络首句。 */
export function createSemanticLearningTimeIndex(sentences: readonly SemanticLearningSentence[]) {
  const index = createVideoSentenceTimeIndex(sentences);
  const key = (unit: SemanticLearningSentence) => `${unit.playbackGroupId}\0${unit.startMs}\0${unit.endMs}`;
  const first = new Map<string, number>();
  sentences.forEach((unit, at) => {
    if (unit.id === unit.playbackGroupId) return;
    const identity = key(unit);
    if (!first.has(identity)) first.set(identity, at);
  });
  return {findIndexAtTime(time: number, selected: number): number {
    const found = index.findIndexAtTime(time);
    if (found < 0) return -1;
    const unit = sentences[found];
    if (unit.id === unit.playbackGroupId) return found;
    const current = sentences[selected];
    if (current && current.playbackGroupId === unit.playbackGroupId
      && current.startMs === unit.startMs && current.endMs === unit.endMs) return selected;
    return first.get(key(unit))!;
  }};
}
