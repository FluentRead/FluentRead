import {describe, expect, it, vi} from 'vitest';
import {buildSemanticLearningTimeline, createSemanticLearningTimeIndex} from '@/src/features/video-subtitle/content/semanticLearningTimeline';
import {buildVideoSentenceTimeline} from '@/src/features/video-subtitle/content/sentenceTimeline';
import {canUseWholeCueSemanticUnit, createSemanticDocument, segmentSemanticDocument} from '@/src/features/video-subtitle/semanticSegmentation';
const cue = (text: string, startMs = 0) => ({text, startMs, durationMs: 1000});
describe('semantic learning uses separate source and playback identities', () => {
  it('preserves ambiguous selection, chooses first shared envelope, and does not pick in gaps', () => {
    const timeline = buildSemanticLearningTimeline([cue('First sentence. Second sentence!'), cue('Third.', 2000)]);
    const index = createSemanticLearningTimeIndex(timeline);
    expect(index.findIndexAtTime(100, -1)).toBe(0); expect(index.findIndexAtTime(100, 1)).toBe(1);
    expect(index.findIndexAtTime(2100, 0)).toBe(2); expect(index.findIndexAtTime(1500, 0)).toBe(-1);
    expect(index.findIndexAtTime(NaN, 0)).toBe(-1); expect(createSemanticLearningTimeIndex([]).findIndexAtTime(0, 0)).toBe(-1);
  });
});
it('keeps legacy presentation in over-budget fallback', () => {
  for (const text of ['  '+ '中'.repeat(2049) + '\t  ', 'x'.repeat(16001) + '\r\n ']) {
    const source = [cue(text)];
    const [legacy] = buildVideoSentenceTimeline(source);
    const result = buildSemanticLearningTimeline(source);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({id: legacy.id, text: legacy.text});
  }
});

it('keeps an unsplit sentence identity across whitespace normalization', () => {
  const a = buildSemanticLearningTimeline([cue('one two.')])[0];
  const b = buildSemanticLearningTimeline([cue('one\ttwo.')])[0];
  expect(b.id).toBe(a.id);
  expect(b.text).toBe(a.text);
  expect(a.id).not.toBe(buildSemanticLearningTimeline([cue('one two.', 1)])[0].id);
});

it('formats split sentences across cue boundaries without changing raw semantic offsets', () => {
  const source = [cue('先结束。我们'), cue('喜欢\n日语。', 800)];
  const document = createSemanticDocument(source);
  const sentences = buildSemanticLearningTimeline(source);
  expect(sentences.map(item => item.text)).toEqual(['先结束。', '我们喜欢 日语。']);
  expect(segmentSemanticDocument(document).map(unit => document.text.slice(unit.start, unit.end)))
    .toEqual(['先结束。', '我们\n喜欢\n日语。']);
});

it.each([
  'Sea otters have strong teeth.', ' \tA  sentence!\r\n ', '“Wait!”\t', 'e\u0301 and 👩🏽‍💻 belong here.',
  '中'.repeat(127) + '。',
])('matches the full solver for a short cue with one final mark: %s', text => {
  const source = [cue('because we'), cue(text, 3000)];
  const legacy = buildVideoSentenceTimeline(source)[1];
  const solved = segmentSemanticDocument(createSemanticDocument([source[1]]));
  expect(canUseWholeCueSemanticUnit(text)).toBe(true);
  expect(solved).toHaveLength(1);
  expect(solved[0]).toMatchObject({text, start: 0, end: text.length, complete: true});
  const timeline = buildSemanticLearningTimeline(source);
  expect(timeline).toHaveLength(2);
  expect(timeline[1]).toMatchObject({text: legacy.text, id: legacy.id,
    startMs: solved[0].playback!.startMs, endMs: solved[0].playback!.endMs, complete: false});
});

it.each(['First sentence. Second sentence!', 'Dr.', 'No complete sentence', '中'.repeat(128) + '。', 'Wait?!'])
  ('keeps nontrivial cue %s on the full solver', text => {
    expect(canUseWholeCueSemanticUnit(text)).toBe(false);
  });

it('loads the timeline without Intl.Segmenter and preserves the original learning group', async () => {
  vi.resetModules();
  vi.stubGlobal('Intl', Object.assign(Object.create(Intl), {Segmenter: undefined}));
  try {
    const {buildSemanticLearningTimeline: buildWithoutSegmenter} = await import('@/src/features/video-subtitle/content/semanticLearningTimeline');
    const source = [cue('Sea otters'), cue('have strong teeth. They hunt crabs.', 800), cue('Next sentence.', 2000)];
    const legacy = buildVideoSentenceTimeline(source);
    expect(buildWithoutSegmenter(source)).toEqual(legacy.map(group => expect.objectContaining({id: group.id, text: group.text})));
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
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
it('keeps start uncertainty on over-budget whitespace fallback and resolves later punctuation', () => {
  const long = cue(' '.repeat(17000) + 'Ends here.', 5000);
  expect(buildSemanticLearningTimeline([long])[0].complete).toBe(true);
  const timeline = buildSemanticLearningTimeline([cue('because'), long, cue('Next full sentence.', 6500)]);
  expect(timeline.find(unit => unit.text === 'Ends here.')!.complete).toBe(false);
  expect(timeline.find(unit => unit.text === 'Next full sentence.')!.complete).toBe(true);
});
