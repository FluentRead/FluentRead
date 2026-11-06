import {describe, expect, it} from 'vitest';
import {buildSemanticLearningTimeline, createSemanticLearningTimeIndex, semanticSourceKey} from '@/src/features/video-subtitle/content/semanticLearningTimeline';
import {buildVideoSentenceTimeline} from '@/src/features/video-subtitle/content/sentenceTimeline';
import {Config, normalizeConfig} from '@/src/core/config/model';
const cue = (text: string, startMs = 0) => ({text, startMs, durationMs: 1000});
describe('semantic learning uses separate source and playback identities', () => {
  it('preserves ambiguous selection, chooses first shared envelope, and does not pick in gaps', () => {
    const timeline = buildSemanticLearningTimeline([cue('First sentence. Second sentence!'), cue('Third.', 2000)]);
    const index = createSemanticLearningTimeIndex(timeline);
    expect(index.findIndexAtTime(100, -1)).toBe(0); expect(index.findIndexAtTime(100, 1)).toBe(1);
    expect(index.findIndexAtTime(2100, 0)).toBe(2); expect(index.findIndexAtTime(1500, 0)).toBe(-1);
    expect(index.findIndexAtTime(NaN, 0)).toBe(-1); expect(createSemanticLearningTimeIndex([]).findIndexAtTime(0, 0)).toBe(-1);
  });
  it('retains an oversized atomic cue and rejects stale source override identity', () => {
    const huge = cue('x'.repeat(16001)); expect(buildSemanticLearningTimeline([huge])[0].text).toBe(huge.text);
    const source = [cue('Hello.')]; const group = buildVideoSentenceTimeline(source)[0];
    const key = semanticSourceKey(group, source);
    const overrides = new Map([[key, [{start: 0, end: 1, text: '', cueIndices: [], complete: false, playback: null}]]]);
    expect(buildSemanticLearningTimeline(source, overrides)).toEqual([]);
    expect(buildSemanticLearningTimeline([cue('Other.')], overrides)[0].text).toBe('Other.');
  });
  it('AI settings default off and malformed restores cannot enable or select providers', () => {
    expect(new Config().videoSemanticSegmentationEnabled).toBe(false);
    for (const value of [undefined, 'false', 'true', 1, null, {}]) {
      const config = normalizeConfig({videoSemanticSegmentationEnabled: value, videoSemanticSegmentationModel: 42, videoSemanticSegmentationService: null});
      expect(config.videoSemanticSegmentationEnabled).toBe(false); expect(config.videoSemanticSegmentationService).toBe(''); expect(config.videoSemanticSegmentationModel).toBe('');
    }
    expect(normalizeConfig({videoSemanticSegmentationEnabled: true, videoSemanticSegmentationService: ' explicit ', videoSemanticSegmentationModel: ' chosen '}))
      .toMatchObject({videoSemanticSegmentationEnabled: true, videoSemanticSegmentationService: 'explicit', videoSemanticSegmentationModel: 'chosen'});
  });
});

it('keeps raw whitespace and correct offsets in over-budget fallback', () => {
  for (const text of ['  '+ '中'.repeat(2049) + '\t  ', 'x'.repeat(16001) + '\r\n ']) {
    const result = buildSemanticLearningTimeline([cue(text)]);
    expect(result).toHaveLength(1); expect(result[0].text).toBe(text);
    expect(result[0].semanticEnd).toBe(text.length);
  }
});

it('source whitespace and time changes invalidate semantic identity even at equal offsets', () => {
  const a = buildSemanticLearningTimeline([cue('one two.')])[0];
  const b = buildSemanticLearningTimeline([cue('one\ttwo.')])[0];
  expect(a.id).not.toBe(b.id);
  expect(a.id).not.toBe(buildSemanticLearningTimeline([cue('one two.', 1)])[0].id);
});

it.each(['gap', 'limit'])('does not turn a continuation after a %s group into a complete sentence', boundary => {
  const first = boundary === 'gap' ? cue('because we') : cue('word '.repeat(90));
  const timeline = buildSemanticLearningTimeline([first, cue('needed more time.', 5000), cue('Next full sentence.', 6500)]);
  expect(timeline.find(unit => unit.text === 'needed more time.')!.complete).toBe(false);
  expect(timeline.find(unit => unit.text === 'Next full sentence.')!.complete).toBe(true);
});
it('uses actual source punctuation rather than a preceding length-limit flag for the next start', () => {
  const timeline = buildSemanticLearningTimeline([cue('word '.repeat(90) + 'finished.'), cue('Next full sentence.', 2000)]);
  expect(timeline.find(unit => unit.text === 'Next full sentence.')!.complete).toBe(true);
});
it('keeps start uncertainty on over-budget raw whitespace fallback and resolves later punctuation', () => {
  const long = cue(' '.repeat(17000) + 'Ends here.', 5000);
  expect(buildSemanticLearningTimeline([long])[0].complete).toBe(true);
  const timeline = buildSemanticLearningTimeline([cue('because'), long, cue('Next full sentence.', 6500)]);
  expect(timeline.find(unit => unit.text === long.text)!.complete).toBe(false);
  expect(timeline.find(unit => unit.text === 'Next full sentence.')!.complete).toBe(true);
});
