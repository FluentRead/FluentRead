import {describe, expect, it} from 'vitest';
import {createSemanticDocument, parseSemanticBoundaryResponse, segmentSemanticDocument} from '@/src/features/video-subtitle/semanticSegmentation';
const cue = (text: string, startMs = 0, durationMs = 1000) => ({text, startMs, durationMs});
describe('lossless semantic segmentation', () => {
  it('splits semantics without claiming subcue playback timestamps', () => {
    const doc = createSemanticDocument([cue('First sentence. Second sentence!', 10, 9000)]);
    const result = segmentSemanticDocument(doc);
    expect(result.map(unit => unit.text)).toEqual(['First sentence. ', 'Second sentence!']);
    expect(result.every(unit => unit.playback?.precision === 'cue-envelope')).toBe(true);
    expect(result.map(unit => unit.playback)).toEqual(Array(2).fill({precision: 'cue-envelope', startMs: 10, endMs: 9010}));
    expect(result.map(unit => unit.text).join('')).toBe(doc.text);
  });
  it('preserves original source slices separately from explicit cue separators', () => {
    const cues = [cue('  x\t\r\n'), cue('y\u00a0  ', 500), cue('', 2000)];
    const doc = createSemanticDocument(cues);
    expect(doc.spans.map(span => doc.text.slice(span.start, span.end))).toEqual(cues.map(item => item.text));
    expect(segmentSemanticDocument(doc).map(unit => unit.text).join('')).toBe(doc.text);
  });
  it.each(['e\u0301', '👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'क्ष', '가'])('never splits grapheme %s', text => {
    const doc = createSemanticDocument([cue(text + ' hello. 世界你好。')]);
    expect(doc.boundaries.every(point => point.offset >= text.length)).toBe(true);
    expect(segmentSemanticDocument(doc).map(unit => unit.text).join('')).toBe(doc.text);
  });
  it('keeps closing quotes and avoids abbreviation/decimal hard boundaries', () => {
    const doc = createSemanticDocument([cue('Dr. Smith said “Ready!” Then paid 3.14 dollars.')]);
    expect(segmentSemanticDocument(doc).map(unit => unit.text)).toEqual(['Dr. Smith said “Ready!” ', 'Then paid 3.14 dollars.']);
  });
  it('uses cue envelope min/max even for overlapping reversed end times', () => {
    const doc = createSemanticDocument([cue('one', 100, 10000), cue('two', 200, 100)]);
    expect(segmentSemanticDocument(doc)[0].playback).toEqual({precision: 'cue-envelope', startMs: 100, endMs: 10100});
  });
  it('applies valid AI only to existing boundaries and retains all text', () => {
    const doc = createSemanticDocument([cue('one two three four')]);
    const ids = [doc.boundaries[1].id, doc.boundaries.at(-1)!.id];
    expect(parseSemanticBoundaryResponse(doc, {boundaries: ids})).toEqual(ids);
    expect(segmentSemanticDocument(doc, ids).map(unit => unit.text).join('')).toBe(doc.text);
  });
  it('rejects malformed model outputs rather than silently repairing them', () => {
    const doc = createSemanticDocument([cue('hello world.')]);
    const last = doc.boundaries.at(-1)!.id;
    for (const value of [null, [], {}, {boundaries: []}, {boundaries: [last, last]},
      {boundaries: ['b99999']}, {boundaries: [doc.boundaries[0].id]}, {boundaries: [last], text: 'rewrite'},
      {boundaries: [last, doc.boundaries[0].id]}, {boundaries: [NaN]}]) {
      expect(() => parseSemanticBoundaryResponse(doc, value)).toThrow();
    }
  });
  it('bounds input and rejects invalid source timing', () => {
    expect(() => createSemanticDocument([cue('x'.repeat(16001))])).toThrow();
    for (const invalid of [cue('x', -1), cue('x', NaN), cue('x', 0, Infinity), cue('x', 0, 0)]) {
      expect(() => createSemanticDocument([invalid])).toThrow();
    }
    expect(segmentSemanticDocument(createSemanticDocument([]))).toEqual([]);
    const doc = createSemanticDocument([cue('x'.repeat(1000))]);
    expect(segmentSemanticDocument(doc)[0].text).toBe(doc.text);
  });
});

it('handles empty source spans, separator-only documents and large candidate sets deterministically', () => {
  const empty = createSemanticDocument([cue(''), cue('')]);
  expect(segmentSemanticDocument(empty)[0].playback).toBeNull();
  const doc = createSemanticDocument([cue('x'), cue(''), cue('z')]);
  expect(segmentSemanticDocument(doc)[0].cueIndices).toEqual([0, 2]);
  expect(() => createSemanticDocument([cue('中'.repeat(2049))])).toThrow('Too many');
  const many = createSemanticDocument(Array.from({length: 1000}, (_, index) => cue('Sentence.', index * 1000)));
  const units = segmentSemanticDocument(many);
  expect(units.map(unit => unit.text).join('')).toBe(many.text);
  expect(units).toHaveLength(1000);
  expect(() => segmentSemanticDocument({text: 'x', spans: [], boundaries: [{id: 'b1', offset: 1, score: NaN}]})).toThrow('Unreachable');
});

it('does not offer sentence breaks inside URLs, email addresses, dotted names or decimals', () => {
  for (const text of ['Visit https://example.com/a?x=yes now.', 'Email first.last@example.com today.',
    'Open www.example.com now.', 'Use example.com or version 3.14 today.']) {
    const doc = createSemanticDocument([cue(text)]);
    expect(segmentSemanticDocument(doc).map(unit => unit.text)).toEqual([text]);
  }
});

it('does not treat the mandatory AI tail ID as proof that a fragment is complete', () => {
  const doc = createSemanticDocument([cue('because the')]);
  const tail = doc.boundaries.at(-1)!.id;
  expect(segmentSemanticDocument(doc, [tail])[0].complete).toBe(false);
  expect(segmentSemanticDocument(doc)[0].complete).toBe(false);
});

it('provides grapheme-safe word candidates for Thai without spaces', () => {
  const doc = createSemanticDocument([cue('ภาษาไทยไม่มีช่องว่าง')]);
  expect(doc.boundaries.length).toBeGreaterThan(1);
  const legal = new Set([...new Intl.Segmenter('th', {granularity: 'grapheme'}).segment(doc.text)].map(part => part.index + part.segment.length));
  expect(doc.boundaries.every(point => legal.has(point.offset))).toBe(true);
  const ids = [doc.boundaries[0].id, doc.boundaries.at(-1)!.id];
  expect(segmentSemanticDocument(doc, ids).map(unit => unit.text).join('')).toBe(doc.text);
});

it('never offers AI a boundary inside a bare dotted domain or decimal', () => {
  const doc = createSemanticDocument([cue('example.com 3.14')]);
  expect(doc.boundaries.map(point => point.offset)).toEqual([12, 16]);
});

it.each(['rules', 'ai-tail-only'])('does not label the tail after a weak forced start complete in %s mode', mode => {
  const doc = createSemanticDocument([cue('word '.repeat(120) + 'ends.')]);
  const units = segmentSemanticDocument(doc, mode === 'rules' ? undefined : [doc.boundaries.at(-1)!.id]);
  expect(units.length).toBeGreaterThan(1);
  expect(units.every(unit => !unit.complete)).toBe(true);
  expect(units.map(unit => unit.text).join('')).toBe(doc.text);
  expect(units.every(unit => unit.cueIndices.length === 1 && unit.cueIndices[0] === 0 && unit.playback?.startMs === 0 && unit.playback.endMs === 1000)).toBe(true);
});
it('keeps confirmed neighboring sentences and explicitly model-confirmed starts complete', () => {
  const doc = createSemanticDocument([cue('First sentence. ' + 'word '.repeat(120) + 'ends. Last sentence.')]);
  const units = segmentSemanticDocument(doc);
  expect(units.find(unit => unit.text.trim() === 'First sentence.')!.complete).toBe(true);
  expect(units.find(unit => unit.text.trim() === 'Last sentence.')!.complete).toBe(true);
  const modelDoc = createSemanticDocument([cue('one two three four.')]);
  expect(segmentSemanticDocument(modelDoc, ['b8', 'b19']).map(unit => unit.complete)).toEqual([true, true]);
});


it.each(['!!!', '???', '....', '?!?', '！？', '؟!', '।॥', '...。'])(
  'keeps terminal punctuation run %s atomic for rule and AI candidates', marks => {
    const first = `Ready${marks} `;
    const doc = createSemanticDocument([cue(`${first}Next sentence.`)]);
    expect(segmentSemanticDocument(doc).map(unit => unit.text)).toEqual([first, 'Next sentence.']);
    for (let offset = 6; offset < 5 + marks.length; offset++) {
      expect(doc.boundaries.some(point => point.offset === offset)).toBe(false);
      expect(() => parseSemanticBoundaryResponse(doc, {boundaries: [`b${offset}`, doc.boundaries.at(-1)!.id]})).toThrow();
    }
    expect(segmentSemanticDocument(doc).map(unit => unit.text).join('')).toBe(doc.text);
  });


it.each(["This is the team's.", 'This is the team’s.', 'The store is H&M.'])(
  'does not mistake a connected final letter for an initial: %s', first => {
    const doc = createSemanticDocument([cue(`${first} Next sentence.`)]);
    expect(segmentSemanticDocument(doc).map(unit => unit.text)).toEqual([`${first} `, 'Next sentence.']);
  });
it.each(['J. Smith spoke.', 'Dr. Smith spoke.', 'The U.S. team spoke.'])(
  'preserves genuine initials and abbreviations: %s', first => {
    const doc = createSemanticDocument([cue(`${first} Next sentence.`)]);
    expect(segmentSemanticDocument(doc).map(unit => unit.text)).toEqual([`${first} `, 'Next sentence.']);
  });
