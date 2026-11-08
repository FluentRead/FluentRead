/**
 * @file src/features/video-subtitle/content/semanticLearningTimeline.ts
 * 文件职责：在既有有界回放组上提供独立语义句，避免把句内切分伪装为词级对齐。
 * 主要内容：使用共享断句器生成无损语义单位，标记共享 cue 包络；AI 结果只匹配完整源快照。
 * 模块边界：不改变原字幕显示或导出时间，不调用模型；播放器跟随时保留同包络的当前选择；间隔或上限切出的下一组保留起点不确定性，直到出现确认边界。
 */
import {sha256Hex} from '@/src/shared/function/sha256';
import {buildVideoSentenceTimeline, createVideoSentenceTimeIndex, type VideoSentence} from './sentenceTimeline';
import {createSemanticDocument, segmentSemanticDocument, hasRuleSentenceEnd, type SemanticUnit} from '../semanticSegmentation';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
export interface SemanticLearningSentence extends VideoSentence {playbackGroupId: string; sourceKey: string; timingPrecision: 'cue-envelope'; semanticStart: number; semanticEnd: number}
export function semanticSourceKey(group: VideoSentence, cues: readonly VideoSubtitleCue[]): string {
  return JSON.stringify([group.id, group.cueIndices.map(index => cues[index])]);
}
export function buildSemanticLearningTimeline(cues: readonly VideoSubtitleCue[], overrides: ReadonlyMap<string, SemanticUnit[]> = new Map()): SemanticLearningSentence[] {
  const result: SemanticLearningSentence[] = [];
  let previousSourceEnded = true;
  for (const group of buildVideoSentenceTimeline(cues)) {
    const groupStartConfirmed = previousSourceEnded;
    previousSourceEnded = hasRuleSentenceEnd(cues[group.cueIndices[group.cueIndices.length - 1]].text);
    const sourceKey = semanticSourceKey(group, cues);
    const sourceIdentity = sha256Hex(sourceKey);
    let units: SemanticUnit[];
    try { units = overrides.get(sourceKey) ?? segmentSemanticDocument(createSemanticDocument(group.cueIndices.map(index => cues[index]))); }
    catch {
      const text = group.cueIndices.map(index => cues[index].text).join('\n');
      result.push({...group, complete: group.complete && groupStartConfirmed, id: `${group.id}:semantic:${sourceIdentity}:fallback`, text, playbackGroupId: group.id, sourceKey, timingPrecision: 'cue-envelope', semanticStart: 0, semanticEnd: text.length});
      continue;
    }
    for (const unit of units) {
      if (!unit.playback) continue;
      result.push({...group, id: `${group.id}:semantic:${sourceIdentity}:${unit.start}:${unit.end}`, text: unit.text,
        startMs: unit.playback.startMs, endMs: unit.playback.endMs,
        cueIndices: unit.cueIndices.map(index => group.cueIndices[index]),
        complete: unit.complete && (unit.start > 0 || groupStartConfirmed),
        playbackGroupId: group.id, sourceKey, timingPrecision: 'cue-envelope', semanticStart: unit.start, semanticEnd: unit.end});
    }
  }
  result.forEach((unit, index) => {unit.previousText = result[index - 1]?.text || ''; unit.nextText = result[index + 1]?.text || '';});
  return result;
}
/** 同 cue 多句共享时间时不能凭播放器时钟猜是哪一句；优先保留选择，否则取该包络首句。 */
export function createSemanticLearningTimeIndex(sentences: readonly SemanticLearningSentence[]) {
  const index = createVideoSentenceTimeIndex(sentences);
  const key = (unit: SemanticLearningSentence) => JSON.stringify([unit.playbackGroupId, unit.startMs, unit.endMs]);
  const first = new Map<string, number>();
  sentences.forEach((unit, at) => {if (!first.has(key(unit))) first.set(key(unit), at);});
  return {findIndexAtTime(time: number, selected: number): number {
    const found = index.findIndexAtTime(time);
    if (found < 0) return -1;
    const identity = key(sentences[found]);
    if (sentences[selected] && key(sentences[selected]) === identity) return selected;
    return first.get(identity)!;
  }};
}
