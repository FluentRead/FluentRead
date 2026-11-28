import {describe, expect, it} from 'vitest';
import {buildVideoSentenceTimeline, createVideoSentenceTimeIndex, type VideoSentence} from '@/src/features/video-subtitle/content/sentenceTimeline';
import type {VideoSubtitleCue} from '@/src/features/video-subtitle/content/youtubeSubtitleData';

const findVideoSentenceAtTime = (sentences: readonly VideoSentence[], time: number) => createVideoSentenceTimeIndex(sentences).findAtTime(time);

const cue = (text: string, startMs: number, durationMs = 1000): VideoSubtitleCue => ({text, startMs, durationMs});

describe('原字幕完整句学习时间轴', () => {
  it('按原始时间聚合跨 cue 完整句，保留源索引与前后句语境', () => {
    const input = [cue('The end!', 4000), cue('  Hello\n', 0), cue('world.', 1000), cue('Next sentence?', 2500)];
    const sentences = buildVideoSentenceTimeline(input);
    expect(sentences.map(item => [item.text, item.startMs, item.endMs, item.cueIndices, item.complete, item.boundary])).toEqual([
      ['Hello world.', 0, 2000, [1, 2], true, 'punctuation'],
      ['Next sentence?', 2500, 3500, [3], true, 'punctuation'],
      ['The end!', 4000, 5000, [0], true, 'punctuation'],
    ]);
    expect(sentences[0]).toMatchObject({previousText: '', nextText: 'Next sentence?'});
    expect(sentences[0].id).toMatch(/^sentence:1,2:0:2000:/);
    expect(sentences[1]).toMatchObject({previousText: 'Hello world.', nextText: 'The end!'});
    expect(sentences[2]).toMatchObject({previousText: 'Next sentence?', nextText: ''});
    expect(input[1].text).toBe('  Hello\n');
  });

  it('保持同一个 cue 内多句的真实整段范围，绝不生成精确子句时间', () => {
    const sentences = buildVideoSentenceTimeline([cue('First. Second! Third?', 10, 9000)]);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({text: 'First. Second! Third?', startMs: 10, endMs: 9010, cueIndices: [0]});
  });

  it('识别中日文、阿拉伯文和印度文字句末；保留称谓、缩写和引号', () => {
    const sentences = buildVideoSentenceTimeline([
      cue('Dr.', 0), cue('Smith said', 1000), cue('“Hello!”', 2000),
      cue('这是', 3000), cue('例句。', 4000), cue('これは文です。', 5000),
      cue('كيف حالك؟', 6000), cue('یہ جملہ ہے۔', 7000), cue('यह वाक्य है।', 8000), cue('दूसरा॥', 9000),
    ]);
    expect(sentences.map(item => item.text)).toEqual([
      'Dr. Smith said “Hello!”', '这是例句。', 'これは文です。', 'كيف حالك؟', 'یہ جملہ ہے۔', 'यह वाक्य है।', 'दूसरा॥',
    ]);
    expect(buildVideoSentenceTimeline([cue('E.g.', 0), cue('A.', 1000), cue('example.', 2000)]).map(item => item.text))
      .toEqual(['E.g. A. example.']);
  });

  it('无标点字幕以间隙和数量/时间/长度上限分段，分段不会被标记成完整句', () => {
    const gaps = buildVideoSentenceTimeline([cue('before gap', 0), cue('after gap', 4000)]);
    expect(gaps.map(item => [item.boundary, item.complete])).toEqual([['gap', false], ['end', false]]);
    expect(buildVideoSentenceTimeline([cue('one', 0), cue('two', 1000)], {maxCues: 1}).map(item => item.boundary))
      .toEqual(['limit', 'end']);
    expect(buildVideoSentenceTimeline([cue('one', 0), cue('two', 1000)], {maxDurationMs: 1500}).map(item => item.boundary))
      .toEqual(['limit', 'end']);
    expect(buildVideoSentenceTimeline([cue('one', 0), cue('two', 1000)], {maxCharacters: 6}).map(item => item.boundary))
      .toEqual(['limit', 'end']);
    expect(buildVideoSentenceTimeline([cue('one', 0), cue('two', 1100)], {maxGapMs: 50}).map(item => item.boundary))
      .toEqual(['gap', 'end']);
    const long = buildVideoSentenceTimeline(Array.from({length: 70}, (_, i) => cue('unpunctuated', i * 1000)));
    expect(long.length).toBeGreaterThan(1);
    expect(long.every(item => item.endMs - item.startMs <= 20_000 && item.cueIndices.length <= 24)).toBe(true);
    const atomic = buildVideoSentenceTimeline([cue('x'.repeat(1000), 0, 30_000)]);
    expect(atomic).toHaveLength(1);
    expect(atomic[0]).toMatchObject({startMs: 0, endMs: 30_000, complete: false, boundary: 'limit'});
    expect(buildVideoSentenceTimeline([cue('x'.repeat(500), 0)])[0]).toMatchObject({complete: false, boundary: 'limit'});
    expect(buildVideoSentenceTimeline([cue('A long sentence.', 0, 30_000)])[0]).toMatchObject({complete: true, boundary: 'punctuation'});
    expect(buildVideoSentenceTimeline([cue('x'.repeat(500) + '.', 0)])[0]).toMatchObject({complete: true, boundary: 'punctuation'});
    expect(buildVideoSentenceTimeline([cue('A.', 0)], {maxCues: 0.5})[0]).toMatchObject({complete: false, boundary: 'limit'});
  });

  it('去重连续完全重复的 cue，正确衔接无空格文字、中日文标点与数字，并识别扩展括号与省略号句末', () => {
    const dedup = buildVideoSentenceTimeline([
      cue('Hello', 0, 1000),
      cue('  Hello  ', 0, 1000),
      cue('world.', 1000, 1000),
    ]);
    expect(dedup).toHaveLength(1);
    expect(dedup[0]).toMatchObject({text: 'Hello world.', cueIndices: [0, 2], complete: true});

    const joined = buildVideoSentenceTimeline([
      cue('你好，', 0, 500), cue('第', 500, 500), cue('2026', 1000, 500), cue('年', 1500, 500), cue('，世界】', 2000, 500),
      cue('ภาษาไทย', 4500, 500), cue('ไม่มีช่องว่าง…', 5000, 500),
      cue('真的吗⁉》', 6000, 500),
      cue("This is the team's.", 7000, 500),
      cue('コーヒー', 8000, 500), cue('を飲む。', 8500, 500),
      cue('人々', 9500, 500), cue('とカフェ・', 10000, 500), cue('ラテ。', 10500, 500),
    ]);
    expect(joined.map(item => [item.text, item.complete])).toEqual([
      ['你好，第2026年，世界】', false],
      ['ภาษาไทยไม่มีช่องว่าง…', true],
      ['真的吗⁉》', true],
      ["This is the team's.", true],
      ['コーヒーを飲む。', true],
      ['人々とカフェ・ラテ。', true],
    ]);
  });

  it('重叠 cue 保留最长原始范围；同起点保持原序；不接受无可靠时间的 cue', () => {
    const invalid = [cue('', 0), cue(' ', 0), cue('negative', -1), cue('nan', NaN), cue('nan duration', 0, NaN),
      cue('zero', 0, 0), cue('negative duration', 0, -1), cue('overflow', Number.MAX_VALUE, Number.MAX_VALUE)];
    expect(buildVideoSentenceTimeline(invalid)).toEqual([]);
    const sentences = buildVideoSentenceTimeline([cue('one', 0, 5000), cue('two', 0, 500), cue('three.', 800, 500)]);
    expect(sentences[0]).toMatchObject({text: 'one two three.', startMs: 0, endMs: 5000, cueIndices: [0, 1, 2]});
    expect(buildVideoSentenceTimeline([])).toEqual([]);
  });

  it('非法可选上限回退到有限默认值', () => {
    const input = [cue('one', 0), cue('two', 1000)];
    expect(buildVideoSentenceTimeline(input, {maxDurationMs: Infinity, maxCharacters: 0, maxCues: -2, maxGapMs: NaN}))
      .toEqual(buildVideoSentenceTimeline(input));
  });

  it('同起点增量补句、时间更正和文字修正都改变材料身份，不复用旧解释或播放终点', () => {
    const initial = buildVideoSentenceTimeline([cue('A first draft.', 0, 1000)])[0];
    const corrected = buildVideoSentenceTimeline([cue('A corrected draft.', 0, 1000)])[0];
    const extended = buildVideoSentenceTimeline([cue('A first draft.', 0, 1500)])[0];
    expect(initial.id).not.toBe(corrected.id);
    expect(initial.id).not.toBe(extended.id);
    expect(initial.id).toBe(buildVideoSentenceTimeline([cue('A first draft.', 0, 1000)])[0].id);
  });

  it('当前句采用最近开始的重叠范围；间隙、结束和非有限时钟不猜测', () => {
    const sentences = buildVideoSentenceTimeline([cue('First.', 0, 5000), cue('Second.', 2000, 1000), cue('Third.', 2000, 500)]);
    expect(findVideoSentenceAtTime(sentences, 0)).toBe(sentences[0]);
    expect(findVideoSentenceAtTime(sentences, 2200)).toBe(sentences[2]);
    expect(findVideoSentenceAtTime([sentences[2], sentences[0]], 2200)).toBe(sentences[2]);
    expect(findVideoSentenceAtTime(sentences, 2900)).toBe(sentences[1]);
    expect(findVideoSentenceAtTime(sentences, 4000)).toBe(sentences[0]);
    expect(findVideoSentenceAtTime(sentences, 5000)).toBeNull();
    expect(findVideoSentenceAtTime(sentences, -1)).toBeNull();
    expect(findVideoSentenceAtTime(sentences, NaN)).toBeNull();
    expect(findVideoSentenceAtTime([], 0)).toBeNull();
  });

  it('查句快照返回原数组位置，保留乱序、同起点后项、原小数边界与长范围回退', () => {
    const sentences = buildVideoSentenceTimeline([
      cue('First.', 0.25, 5000), cue('Second.', 2000.25, 1000), cue('Third.', 2000.25, 500),
    ]);
    const unsorted = [sentences[2], sentences[0], sentences[1]];
    const index = createVideoSentenceTimeIndex(unsorted);
    expect(index.findIndexAtTime(0)).toBe(-1);
    expect(index.findIndexAtTime(0.25)).toBe(1);
    expect(index.findIndexAtTime(2200)).toBe(2);
    expect(index.findAtTime(2500.25)).toBe(sentences[1]);
    expect(index.findAtTime(4000)).toBe(sentences[0]);
    expect(index.findIndexAtTime(5000.25)).toBe(-1);
    expect(index.findAtTime(5000.25)).toBeNull();
    expect(index.findAtTime(NaN)).toBeNull();
    expect(index.findAtTime(Infinity)).toBeNull();
    expect(index.findAtTime(-Infinity)).toBeNull();
    expect(createVideoSentenceTimeIndex([]).findIndexAtTime(0)).toBe(-1);
  });

  it('重叠查句快照在复杂范围和回退时钟下与独立线性 oracle 保持一致', () => {
    const template = buildVideoSentenceTimeline([cue('Template.', 0)])[0];
    const sentences = Array.from({length: 137}, (_, i) => ({
      ...template, id: String(i), startMs: (i * 47 % 31) * 100,
      endMs: (i * 47 % 31) * 100 + (i % 9 === 0 ? 5000 : i * 23 % 700 + 50),
    }));
    sentences.push({...template, startMs: NaN, endMs: 4000}, {...template, startMs: 4000, endMs: 1000});
    const index = createVideoSentenceTimeIndex(sentences);
    for (let i = 0; i < 750; i += 1) {
      const clock = (i * 7919 % 8500) - 250;
      // 独立线性 oracle 只留在测试，避免让已退役算法继续进入生产模块。
      const expected = sentences.reduce<VideoSentence | null>((active, sentence) => clock >= sentence.startMs && clock < sentence.endMs
        && (!active || sentence.startMs >= active.startMs) ? sentence : active, null);
      expect(index.findAtTime(clock)).toBe(expected);
      expect(index.findIndexAtTime(clock)).toBe(expected ? sentences.indexOf(expected) : -1);
    }
  });

  it('快照不跟踪原地编辑；显式重建后反映编辑', () => {
    const sentences = buildVideoSentenceTimeline([cue('First.', 0), cue('Second.', 2000)]);
    const first = sentences[0];
    const index = createVideoSentenceTimeIndex(sentences);
    first.startMs = 1000;
    first.endMs = 1500;
    sentences.reverse();
    expect(index.findIndexAtTime(500)).toBe(0);
    expect(index.findAtTime(500)).toBe(first);
    expect(findVideoSentenceAtTime(sentences, 500)).toBeNull();
    expect(createVideoSentenceTimeIndex(sentences).findIndexAtTime(1250)).toBe(1);
    sentences.pop();
    expect(index.findAtTime(500)).toBe(first);
    expect(findVideoSentenceAtTime(sentences, 1250)).toBeNull();
  });

  it('连续播放查句只在建索引时读取句子范围，不随事件重新访问整份字幕', () => {
    const template = buildVideoSentenceTimeline([cue('Template.', 0)])[0];
    let rangeReads = 0;
    const sentences = Array.from({length: 2400}, (_, i) => ({
      ...template,
      get startMs() { rangeReads += 1; return i * 1000; },
      get endMs() { rangeReads += 1; return i * 1000 + 800; },
    }));
    const index = createVideoSentenceTimeIndex(sentences);
    expect(rangeReads).toBe(4800);
    rangeReads = 0;
    for (let i = 0; i < 1000; i += 1) {
      expect(index.findIndexAtTime(i * 1000 + 500)).toBe(i);
      expect(index.findIndexAtTime(i * 1000 + 800)).toBe(-1);
    }
    expect(rangeReads).toBe(0);
  });
});
