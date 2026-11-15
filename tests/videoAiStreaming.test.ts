import { describe, expect, it } from 'vitest';

import {
  VIDEO_AI_SAMPLE_RATE,
  VideoAiStreamingResampler,
  encodeVideoAiPcm16Base64,
  measureVideoAiSpeechActivity,
} from '@/src/features/video-subtitle/content/video-ai/audioWindow';
import {
  VIDEO_AI_MIN_READABLE_CUE_MS,
  VideoAiTranscriptStabilizer,
  areVideoAiTranscriptCorrectionVariants,
  areVideoAiTranscriptTextsRelated,
  mergeVideoAiTranscriptText,
  getVideoAiTranscriptNovelSuffix,
  type VideoAiStabilizedCue,
} from '@/src/features/video-subtitle/content/video-ai/streamingTranscript';
import {
  VIDEO_AI_MAX_CUE_COUNT,
  getVisibleVideoAiCue,
  mergeVideoAiSubtitleCues,
  normalizeVideoAiSubtitleTimeline,
  finalizeVideoAiCuesForPlayback,
} from '@/src/features/video-subtitle/content/video-ai/cueTimeline';
import { VideoAiCanceledGenerationRegistry } from '@/src/features/video-subtitle/content/video-ai/generationRegistry';


// 使用完整识别路径现行的合并与边界规范化，不再测试已退役的逐句尾部缓存。
const updateCueTimeline = (cues: VideoAiStabilizedCue[], cue: VideoAiStabilizedCue) =>
  normalizeVideoAiSubtitleTimeline(mergeVideoAiSubtitleCues([...cues, cue]));

describe('完成识别字幕的原文回放', () => {
  it('保留稳定身份、使用实际说话时长并清除识别和翻译等待时间', () => {
    const input = [{startMs: 1000, durationMs: 9000, spokenEndMs: 2300, text: '  A\n complete\u3000sentence. ',
      cueId: 'ai-1', partial: false, availableAtMs: 6000, translationAvailableAtMs: 8000}] as const;
    expect(finalizeVideoAiCuesForPlayback(input)).toEqual([{
      ...input[0], durationMs: 1300, text: 'A complete sentence.', availableAtMs: 0, translationAvailableAtMs: 0,
    }]);
    expect(input[0].text).toBe('  A\n complete\u3000sentence. ');
    expect(input[0].availableAtMs).toBe(6000);
  });

  it('空时间轴或纯空白字幕不进入回放，边界时间至少可见一毫秒', () => {
    expect(finalizeVideoAiCuesForPlayback([])).toEqual([]);
    expect(finalizeVideoAiCuesForPlayback([
      {startMs: -20, durationMs: 400, spokenEndMs: 0, text: 'Yes.', availableAtMs: 400},
      {startMs: 800, durationMs: 400, spokenEndMs: 700, text: 'No.', availableAtMs: 900},
      {startMs: 1000, durationMs: 400, spokenEndMs: 1200, text: ' \n\u3000 ', availableAtMs: 1400},
    ])).toMatchObject([{startMs: 0, durationMs: 20, text: 'Yes.'}, {startMs: 800, durationMs: 1, text: 'No.'}]);
  });
});

function decodePcm16Base64(value: string): Int16Array {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const samples = new Int16Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

describe('本地 AI 字幕音频窗口', () => {
  it('把 Float32 PCM 钳位并编码成 little-endian PCM16', () => {
    const encoded = encodeVideoAiPcm16Base64(new Float32Array([
      -2,
      -1,
      -0.5,
      0,
      0.5,
      1,
      2,
      Number.NaN,
    ]));

    expect(Array.from(decodePcm16Base64(encoded))).toEqual([
      -32_768,
      -32_768,
      -16_384,
      0,
      16_384,
      32_767,
      32_767,
      0,
    ]);
    expect(encodeVideoAiPcm16Base64(new Float32Array())).toBe('');
  });

  it('只跳过数字静音，低音量非零声音与正常语音都保留给模型', () => {
    const silence = new Float32Array(VIDEO_AI_SAMPLE_RATE * 2);
    const lowNoise = Float32Array.from(
      { length: VIDEO_AI_SAMPLE_RATE },
      (_, index) => index % 2 === 0 ? 0.001 : -0.001,
    );
    const speech = Float32Array.from(
      { length: VIDEO_AI_SAMPLE_RATE },
      (_, index) => 0.04 * Math.sin(2 * Math.PI * 220 * index / VIDEO_AI_SAMPLE_RATE),
    );

    expect(measureVideoAiSpeechActivity(silence)).toMatchObject({
      active: false,
      peak: 0,
      rms: 0,
      activeFrameRatio: 0,
    });
    expect(measureVideoAiSpeechActivity(lowNoise).active).toBe(true);
    expect(measureVideoAiSpeechActivity(speech)).toMatchObject({
      active: true,
      activeFrameRatio: 1,
    });
  });

  it('低音量声音、孤立采样和长静音不被固定能量门删除', () => {
    const audio = new Float32Array(VIDEO_AI_SAMPLE_RATE * 12);
    for (let index = 0; index < VIDEO_AI_SAMPLE_RATE; index += 1) {
      audio[index] = 0.0008 * Math.sin(2 * Math.PI * 317 * index / VIDEO_AI_SAMPLE_RATE);
    }
    expect(measureVideoAiSpeechActivity(audio).active).toBe(true);
    expect(measureVideoAiSpeechActivity(audio).rms).toBeLessThan(0.0012);
    const sparse = new Float32Array(320);
    sparse[0] = 2 / 32_768;
    expect(measureVideoAiSpeechActivity(sparse)).toMatchObject({active: true, activeFrameRatio: 0});
    const digitalSilence = new Float32Array(320).fill(1 / 32_768);
    digitalSilence[0] = NaN;
    digitalSilence[1] = Infinity;
    expect(measureVideoAiSpeechActivity(digitalSilence).active).toBe(false);
  });

  it('跨任意输入块保持重采样相位，长时间不累计时长漂移', () => {
    const sourceRate = 44_100;
    const source = Float32Array.from(
      { length: sourceRate * 10 },
      (_, index) => Math.sin(2 * Math.PI * 317 * index / sourceRate),
    );
    const streamed = new VideoAiStreamingResampler();
    const pieces: Float32Array[] = [];
    let offset = 0;
    const blockSizes = [4_096, 1_337, 2_701, 511];
    let block = 0;
    while (offset < source.length) {
      const end = Math.min(source.length, offset + blockSizes[block % blockSizes.length]);
      pieces.push(streamed.process([source.subarray(offset, end)], sourceRate));
      offset = end;
      block += 1;
    }
    const streamedLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const flattened = new Float32Array(streamedLength);
    let writeAt = 0;
    for (const piece of pieces) {
      flattened.set(piece, writeAt);
      writeAt += piece.length;
    }

    const oneShot = new VideoAiStreamingResampler().process([source], sourceRate);
    expect(flattened.length).toBe(VIDEO_AI_SAMPLE_RATE * 10);
    expect(flattened.length).toBe(oneShot.length);
    let maxDifference = 0;
    for (let index = 0; index < flattened.length; index += 997) {
      maxDifference = Math.max(maxDifference, Math.abs(flattened[index] - oneShot[index]));
    }
    expect(maxDifference).toBeLessThan(1e-6);
  });

  it('以不规则小块连续重采样五分钟仍不累计采样数漂移', () => {
    const sourceRate = 44_100;
    const totalInputSamples = sourceRate * 5 * 60 + 137;
    const blockSizes = [127, 4_096, 733, 2_057, 511, 8_191];
    const resampler = new VideoAiStreamingResampler();
    let consumedSamples = 0;
    let outputSamples = 0;
    let blockIndex = 0;

    while (consumedSamples < totalInputSamples) {
      const blockSize = Math.min(
        blockSizes[blockIndex % blockSizes.length],
        totalInputSamples - consumedSamples,
      );
      outputSamples += resampler.process([new Float32Array(blockSize)], sourceRate).length;
      consumedSamples += blockSize;
      blockIndex += 1;
    }

    const sourceSamplesPerOutput = sourceRate / VIDEO_AI_SAMPLE_RATE;
    const expectedOutputSamples = Math.floor(
      (totalInputSamples - 1) / sourceSamplesPerOutput,
    ) + 1;
    expect(outputSamples).toBe(expectedOutputSamples);
    expect(Math.abs(
      outputSamples / VIDEO_AI_SAMPLE_RATE - totalInputSamples / sourceRate,
    )).toBeLessThanOrEqual(1 / VIDEO_AI_SAMPLE_RATE);
  });

  it('重采样器处理空输入、无效采样率和跨块边界', () => {
    const resampler = new VideoAiStreamingResampler();
    expect(resampler.process([], VIDEO_AI_SAMPLE_RATE)).toHaveLength(0);
    expect(resampler.process([new Float32Array()], Number.NaN)).toHaveLength(0);
    expect(resampler.process([new Float32Array([0, 1])], Number.NaN)).toHaveLength(2);
    expect(resampler.process([new Float32Array([1, 0])], 8_000)).toHaveLength(3);
    const shortBlock = new VideoAiStreamingResampler();
    expect(shortBlock.process([new Float32Array([1])], 44_100)).toHaveLength(1);
    expect(shortBlock.process([new Float32Array([0])], 44_100)).toHaveLength(0);
  });

  it('取消 generation registry 超出容量时淘汰最早记录', () => {
    const registry = new VideoAiCanceledGenerationRegistry(-1);
    const identity = { tabId: 1, streamId: 'stream', generation: 1 };
    registry.mark(identity);
    expect(registry.has(identity)).toBe(false);
  });
});

describe('本地 AI 字幕 generation 取消登记', () => {
  it('只拒绝完全相同的 tab/stream/generation，并有界淘汰最旧记录', () => {
    const registry = new VideoAiCanceledGenerationRegistry(2);
    registry.mark({ tabId: 1, streamId: 'stream-a', generation: 1 });
    expect(registry.has({ tabId: 1, streamId: 'stream-a', generation: 1 })).toBe(true);
    expect(registry.has({ tabId: 1, streamId: 'stream-a', generation: 2 })).toBe(false);
    expect(registry.has({ tabId: 2, streamId: 'stream-a', generation: 1 })).toBe(false);

    registry.mark({ tabId: 1, streamId: 'stream-a', generation: 2 });
    registry.mark({ tabId: 1, streamId: 'stream-a', generation: 3 });
    expect(registry.has({ tabId: 1, streamId: 'stream-a', generation: 1 })).toBe(false);
    expect(registry.has({ tabId: 1, streamId: 'stream-a', generation: 3 })).toBe(true);
  });
});

describe('本地 AI 字幕滑窗文本合并', () => {
  it('消除英文滑窗的词级重叠', () => {
    expect(areVideoAiTranscriptTextsRelated(
      'The quick brown fox',
      'brown fox jumps over the fence.',
    )).toBe(true);
    expect(mergeVideoAiTranscriptText(
      'The quick brown fox',
      'brown fox jumps over the fence.',
    )).toBe('The quick brown fox jumps over the fence.');
  });

  it('长句只要在窗口边界连续重叠三个英文词，也能只取真正新增后缀', () => {
    const previous = 'The speaker reviewed the numbers and explained why the change mattered.';
    const current = 'the change mattered. Outside, traffic moved slowly while rain covered the windows.';
    expect(areVideoAiTranscriptTextsRelated(previous, current)).toBe(true);
    expect(getVideoAiTranscriptNovelSuffix(previous, current)).toBe(
      'Outside, traffic moved slowly while rain covered the windows.',
    );
  });

  it('边界词只有时态或单复数尾缀差异时仍消除整段重叠', () => {
    expect(areVideoAiTranscriptTextsRelated(
      'Explained why the change mattered. Outside, traffic move',
      'change matter. Outside, traffic moved slowly while rain covered the windows.',
    )).toBe(true);
    expect(mergeVideoAiTranscriptText(
      'Explained why the change mattered. Outside, traffic move',
      'change matter. Outside, traffic moved slowly while rain covered the windows.',
    )).toBe(
      'Explained why the change matter. Outside, traffic moved slowly while rain covered the windows.',
    );
  });

  it('消除 CJK 滑窗的字符级重叠', () => {
    expect(areVideoAiTranscriptTextsRelated('今天天气很好', '天气很好我们出去走走')).toBe(true);
    expect(mergeVideoAiTranscriptText('今天天气很好', '天气很好我们出去走走'))
      .toBe('今天天气很好我们出去走走');
  });

  it('把同时间窗的高相似 ASR 校正版合并，但保留否定语义差异', () => {
    expect(areVideoAiTranscriptCorrectionVariants(
      'At Sunrise, the research team opened 11.',
      'At Sunrise, the research team opened the lab and checked the new system.',
    )).toBe(true);
    expect(areVideoAiTranscriptCorrectionVariants(
      'Numbers and X-plained why the change mattered.',
      'numbers and explained why the change mattered.',
    )).toBe(true);
    expect(areVideoAiTranscriptCorrectionVariants(
      'We can release the local model today.',
      'We cannot release the local model today.',
    )).toBe(false);

    const cues = mergeVideoAiSubtitleCues([
      { startMs: 0, durationMs: 2_400, text: 'At Sunrise, the research team opened 11.' },
      { startMs: 300, durationMs: 3_400, text: 'At Sunrise, the research team opened the lab and checked the new system.' },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('At Sunrise, the research team opened the lab and checked the new system.');
  });

  it('首个可读前缀先上屏，后续窗口沿用同一 cue 原位补全', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const preview = stabilizer.ingest({
      startMs: 0,
      durationMs: 1_600,
      availableAtMs: 1_700,
      text: 'At sunrise, the research team',
    });
    expect(preview).toMatchObject([{
      partial: true,
      text: 'At sunrise, the research team',
    }]);

    const completed = stabilizer.ingest({
      startMs: 1_200,
      durationMs: 2_600,
      availableAtMs: 3_900,
      text: 'Research team opened the lab and checked the new system.',
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      cueId: preview[0].cueId,
      text: 'At sunrise, the research team opened the lab and checked the new system.',
      partial: false,
    });
  });

  it('短窗误加句号时仍标为临时 cue，恢复后的长窗沿用身份替换边界前缀', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const preview = stabilizer.ingest({
      startMs: 0,
      durationMs: 1_600,
      availableAtMs: 1_700,
      text: "It's on rise, the research team.",
    });
    expect(preview).toMatchObject([{
      partial: true,
      text: "It's on rise, the research team.",
    }]);

    const corrected = stabilizer.ingest({
      startMs: 1_200,
      durationMs: 2_600,
      availableAtMs: 3_900,
      text: 'Research team opened the lab and checked the new system.',
    });
    expect(corrected).toMatchObject([{
      cueId: preview[0].cueId,
      text: 'Research team opened the lab and checked the new system.',
      partial: false,
    }]);
  });

  it('候选短语遇到下一窗口的完整校正版时替换旧文本，不首尾重复拼接', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const preview = stabilizer.ingest({
      startMs: 20_000,
      durationMs: 2_400,
      availableAtMs: 22_700,
      text: 'Back inside, the team compared both models and wheels',
    });
    expect(preview).toMatchObject([{
      partial: true,
      text: 'Back inside, the team compared both models and wheels',
    }]);

    const corrected = stabilizer.ingest({
      startMs: 20_300,
      durationMs: 3_600,
      availableAtMs: 24_200,
      text: 'Back inside, the team compared both models and recorded every observation.',
    });
    expect(corrected).toHaveLength(1);
    expect(corrected[0].cueId).toBe(preview[0].cueId);
    expect(corrected[0].partial).toBe(false);
    expect(corrected[0].text).toBe(
      'Back inside, the team compared both models and recorded every observation.',
    );
  });

  it('省略号结尾的两词切片保持为候选，等完整窗口后一次提交', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    expect(stabilizer.ingest({
      startMs: 10_000,
      durationMs: 900,
      availableAtMs: 11_100,
      text: 'Outside, traffic...',
    })).toEqual([]);

    const completed = stabilizer.ingest({
      startMs: 10_200,
      durationMs: 3_200,
      availableAtMs: 13_600,
      text: 'Outside, traffic moved slowly while rain covered the windows.',
    });
    expect(completed.map((cue) => cue.text)).toEqual([
      'Outside, traffic moved slowly while rain covered the windows.',
    ]);
  });

  it('重叠时间段只剩一个长边界词时也不会在下一 cue 重复显示', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 14_000,
      durationMs: 3_000,
      availableAtMs: 17_300,
      text: 'Traffic moved slowly while rain covered the windows.',
    });
    expect(first).toHaveLength(1);

    const next = stabilizer.ingest({
      startMs: 16_000,
      durationMs: 3_600,
      availableAtMs: 19_900,
      text: 'Windows. Back inside, the team recorded every observation.',
    });
    expect(next.map((cue) => cue.text)).toEqual([
      'Back inside, the team recorded every observation.',
    ]);
  });

  it('时间连续的小写连接词片段回补上一 cue，并沿用身份触发完整句重译', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 20_000,
      durationMs: 2_200,
      availableAtMs: 22_500,
      text: 'They finished the test.',
    });
    expect(first).toHaveLength(1);

    const continuation = stabilizer.ingest({
      startMs: 21_900,
      durationMs: 2_500,
      availableAtMs: 24_700,
      text: 'with a concise summary and a plan for tomorrow.',
    });
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toMatchObject({
      cueId: first[0].cueId,
      startMs: 20_000,
      text: 'They finished the test with a concise summary and a plan for tomorrow.',
    });

    let timeline: VideoAiStabilizedCue[] = [];
    timeline = updateCueTimeline(timeline, first[0]) as VideoAiStabilizedCue[];
    timeline = updateCueTimeline(timeline, continuation[0]) as VideoAiStabilizedCue[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].text).toBe(
      'They finished the test with a concise summary and a plan for tomorrow.',
    );
  });

  it('Whisper 误加句号后，why 开头的后半句在 760ms 内回补同一 cue', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 0,
      durationMs: 2_500,
      availableAtMs: 2_800,
      text: 'The speaker reviewed the numbers and explained.',
    });
    expect(first).toHaveLength(1);

    const continuation = stabilizer.ingest({
      startMs: 3_150,
      durationMs: 2_500,
      availableAtMs: 5_900,
      text: 'why the change mattered.',
    });
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toMatchObject({
      cueId: first[0].cueId,
      text: 'The speaker reviewed the numbers and explained why the change mattered.',
    });
  });

  it('重叠窗口的小写续句即使上一窗口误加句号也回补同一 cue', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 0,
      durationMs: 2_500,
      availableAtMs: 2_800,
      text: 'A few moments later, the first results appear.',
    });
    expect(first).toHaveLength(1);

    const continuation = stabilizer.ingest({
      startMs: 1_900,
      durationMs: 1_600,
      availableAtMs: 4_600,
      text: 'clearly on the screen.',
    });
    expect(continuation).toMatchObject([{
      cueId: first[0].cueId,
      text: 'A few moments later, the first results appear clearly on the screen.',
    }]);
  });

  it('上一 cue 没有完整句末时，小写普通词也回补而不是单独闪现', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const preview = stabilizer.ingest({
      startMs: 10_000,
      durationMs: 3_000,
      availableAtMs: 13_200,
      text: 'Outside, traffic moved slowly while the afternoon',
    });
    expect(preview).toMatchObject([{ partial: true }]);
    const repeated = stabilizer.ingest({
      startMs: 10_200,
      durationMs: 3_000,
      availableAtMs: 13_700,
      text: 'Outside, traffic moved slowly while the afternoon',
    });
    expect(repeated).toEqual([]);

    const continuation = stabilizer.ingest({
      startMs: 13_050,
      durationMs: 1_800,
      availableAtMs: 15_100,
      text: 'rain covered the windows.',
    });
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toMatchObject({
      cueId: preview[0].cueId,
      text: 'Outside, traffic moved slowly while the afternoon rain covered the windows.',
    });
  });

  it('重叠窗口的整句校正沿用 cue 身份，不把新识别另起一条重复字幕', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 20_000,
      durationMs: 3_500,
      availableAtMs: 23_800,
      text: 'Back inside, the team compared both models and recorded every object.',
    });
    expect(first).toHaveLength(1);

    const corrected = stabilizer.ingest({
      startMs: 20_500,
      durationMs: 3_500,
      availableAtMs: 24_500,
      text: 'Inside, the team compared both models and recorded every observation.',
    });
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({
      cueId: first[0].cueId,
      text: 'Inside, the team compared both models and recorded every observation.',
    });

    let timeline: VideoAiStabilizedCue[] = [];
    timeline = updateCueTimeline(timeline, first[0]) as VideoAiStabilizedCue[];
    timeline = updateCueTimeline(timeline, corrected[0]) as VideoAiStabilizedCue[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].text).toBe(
      'Inside, the team compared both models and recorded every observation.',
    );
  });

  it('丢弃顺序颠倒但结尾重复上一句的边界幻觉', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 10_000,
      durationMs: 4_000,
      availableAtMs: 14_300,
      text: 'Outside, traffic moved slowly while the afternoon rain covered the windows.',
    });
    expect(first).toHaveLength(1);

    expect(stabilizer.ingest({
      startMs: 12_500,
      durationMs: 4_000,
      availableAtMs: 16_800,
      text: 'Back in the sky, after noon rain covered the windows.',
    })).toEqual([]);

    const next = stabilizer.ingest({
      startMs: 13_800,
      durationMs: 4_000,
      availableAtMs: 18_100,
      text: 'Back inside, the team recorded every observation.',
    });
    expect(next.map((cue) => cue.text)).toEqual([
      'Back inside, the team recorded every observation.',
    ]);
  });

  it('下一窗口首句只重播上一句尾词时，仅保留后面的新句', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    expect(stabilizer.ingest({
      startMs: 20_000,
      durationMs: 4_000,
      availableAtMs: 24_300,
      text: 'Inside, the team compared both models and recorded every observation.',
    })).toHaveLength(1);

    const next = stabilizer.ingest({
      startMs: 22_500,
      durationMs: 4_000,
      availableAtMs: 26_800,
      text: 'did every observation. They finished the test with a concise summary.',
    });
    expect(next.map((cue) => cue.text)).toEqual([
      'They finished the test with a concise summary.',
    ]);
  });

  it('时间戳轻微错开时也删除上一 cue 尾部被完整重播的句子', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 4_000,
      availableAtMs: 4_300,
      text: 'The first results appeared clearly. A few moments later.',
    })).toHaveLength(1);

    const next = stabilizer.ingest({
      startMs: 4_600,
      durationMs: 3_000,
      availableAtMs: 7_900,
      text: 'A few moments later. The speaker reviewed the numbers.',
    });
    expect(next.map((cue) => cue.text)).toEqual([
      'The speaker reviewed the numbers.',
    ]);
  });

  it('不会把连续两个窗口确认的单个词直接显示出来', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();

    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 900,
      availableAtMs: 1_000,
      text: 'hello',
    })).toEqual([]);
    expect(stabilizer.ingest({
      startMs: 200,
      durationMs: 900,
      availableAtMs: 1_700,
      text: 'hello',
    })).toEqual([]);
  });

  it('两词句不会单窗闪现，第二窗口确认后才显示', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 1_100,
      availableAtMs: 1_300,
      text: 'The screen.',
    })).toEqual([]);

    const confirmed = stabilizer.ingest({
      startMs: 200,
      durationMs: 1_100,
      availableAtMs: 1_900,
      text: 'The screen.',
    });
    expect(confirmed.map((cue) => cue.text)).toEqual(['The screen.']);
  });

  it('三词英语句也需跨窗确认，避免截断半句单窗闪现', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 1_500,
      availableAtMs: 1_700,
      text: 'Outside, traffic moved.',
    })).toEqual([]);
    const confirmed = stabilizer.ingest({
      startMs: 250,
      durationMs: 1_500,
      availableAtMs: 2_300,
      text: 'Outside, traffic moved.',
    });
    expect(confirmed.map((cue) => cue.text)).toEqual(['Outside, traffic moved.']);
  });

  it('让跨窗口确认的短句一次成句，且不先闪出半句', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();

    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 1_200,
      availableAtMs: 1_300,
      segments: [{ startMs: 0, endMs: 900, text: 'hello from' }],
    })).toEqual([]);

    const confirmed = stabilizer.ingest({
      startMs: 400,
      durationMs: 1_500,
      availableAtMs: 2_100,
      segments: [{ startMs: 0, endMs: 1_100, text: 'hello from here' }],
    });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      startMs: 0,
      text: 'hello from here',
      availableAtMs: 2_100,
    });
    expect(confirmed[0].durationMs).toBeGreaterThanOrEqual(VIDEO_AI_MIN_READABLE_CUE_MS);
  });

  it('丢弃有停顿隔开的孤立短词幻觉，不污染后续完整句', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();

    expect(stabilizer.ingest({
      startMs: 0,
      durationMs: 400,
      availableAtMs: 500,
      text: 'you',
    })).toEqual([]);

    const output = stabilizer.ingest({
      startMs: 1_600,
      durationMs: 1_400,
      availableAtMs: 3_100,
      text: 'This is a complete sentence.',
    });
    expect(output).toHaveLength(1);
    expect(output[0].text).toBe('This is a complete sentence.');
    expect(output[0].text.toLocaleLowerCase()).not.toContain('you');
  });

  it('完整音频段保留无句末的两词短句，availableAt 为零的实时输入仍等待确认', () => {
    const window = {
      startMs: 0,
      durationMs: 10_000,
      availableAtMs: 0,
      segments: [
        {startMs: 280, endMs: 2_180, text: 'Merry old friends gather now'},
        {startMs: 3_120, endMs: 4_360, text: 'Stay calm'},
        {startMs: 5_360, endMs: 9_840, text: 'The garden can do great things for us and we care for the'},
      ],
    };
    const realtime = new VideoAiTranscriptStabilizer();
    const explicitRealtime = new VideoAiTranscriptStabilizer({mode: 'realtime'});
    const realtimeOutput = realtime.ingest(window);
    expect(explicitRealtime.ingest(window)).toEqual(realtimeOutput);
    expect(realtimeOutput.map(cue => cue.text)).not.toContain('Stay calm');

    const complete = new VideoAiTranscriptStabilizer({mode: 'complete'});
    const output = complete.ingest(window);
    expect(output.map(cue => cue.text)).toEqual(window.segments.map(segment => segment.text));
    expect(output[1]).toMatchObject({startMs: 3_120, spokenEndMs: 4_360, partial: false});
    expect(complete.flush(0, true)).toEqual([]);
  });

  it('已剥离的新句尾词可以在前文出现过，完整和实时模式都不会再次吞掉', () => {
    for (const mode of ['realtime', 'complete'] as const) {
      const stabilizer = new VideoAiTranscriptStabilizer({mode});
      const first = stabilizer.ingest({
        startMs: 5_360, durationMs: 4_640, availableAtMs: 10_000,
        segments: [{startMs: 0, endMs: 4_480, text: 'The garden can do great things for us and we care for the'}],
      });
      const tail = stabilizer.ingest({
        startMs: 8_800, durationMs: 2_200, availableAtMs: 11_000,
        segments: [{startMs: 0, endMs: 1_840, text: 'We care for the garden.'}],
      });
      expect(tail).toMatchObject([{
        cueId: first[0].cueId,
        text: 'The garden can do great things for us and we care for the garden.',
        spokenEndMs: 10_640,
        partial: false,
      }]);
      expect(tail[0].text.match(/garden/g)).toHaveLength(2);
      expect(stabilizer.ingest({
        startMs: 8_800, durationMs: 2_200, availableAtMs: 11_200,
        segments: [{startMs: 0, endMs: 1_840, text: 'We care for the garden.'}],
      })).toEqual([]);
    }
  });

  it('完整模式仍拒绝单词噪声和不足三百毫秒的短片段，并保留中文短句', () => {
    const complete = new VideoAiTranscriptStabilizer({mode: 'complete'});
    expect(complete.ingest({startMs: 0, durationMs: 500, availableAtMs: 0, text: 'uh.'})).toEqual([]);
    expect(complete.ingest({startMs: 2_000, durationMs: 200, availableAtMs: 0, text: 'Stay calm'})).toEqual([]);
    expect(complete.ingest({startMs: 4_000, durationMs: 600, availableAtMs: 0, text: '稍等'}))
      .toMatchObject([{text: '稍等', partial: false, startMs: 4_000, spokenEndMs: 4_600}]);
    expect(complete.flush(0, true)).toEqual([]);
  });

  it('按短停顿合成长句，并按强标点或长停顿切成独立 cue', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const output = stabilizer.ingest({
      startMs: 10_000,
      durationMs: 6_000,
      availableAtMs: 16_500,
      segments: [
        { startMs: 0, endMs: 700, text: 'We need stable' },
        { startMs: 820, endMs: 1_800, text: 'subtitles for everyone.' },
        { startMs: 2_000, endMs: 3_100, text: 'Here comes another full thought.' },
        { startMs: 4_100, endMs: 5_300, text: 'A long pause starts this sentence.' },
      ],
    });

    expect(output.map((cue) => cue.text)).toEqual([
      'We need stable subtitles for everyone.',
      'Here comes another full thought.',
      'A long pause starts this sentence.',
    ]);
    expect(output.every((cue) => cue.durationMs >= VIDEO_AI_MIN_READABLE_CUE_MS)).toBe(true);
  });

  it('完整句后面的短片段先保留，下一窗口重放上一句时不会被冲掉', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 9_000,
      durationMs: 5_000,
      availableAtMs: 14_500,
      segments: [
        { startMs: 0, endMs: 2_500, text: 'The speaker explained why the change mattered.' },
        { startMs: 2_650, endMs: 3_250, text: 'Outside, traffic' },
      ],
    });
    expect(first.map((cue) => cue.text)).toEqual([
      'The speaker explained why the change mattered.',
    ]);

    const next = stabilizer.ingest({
      startMs: 10_500,
      durationMs: 5_500,
      availableAtMs: 16_500,
      segments: [
        { startMs: 0, endMs: 1_300, text: 'the change mattered.' },
        { startMs: 1_450, endMs: 4_900, text: 'Outside, traffic moved slowly while rain covered the windows.' },
      ],
    });
    expect(next.map((cue) => cue.text)).toEqual([
      'Outside, traffic moved slowly while rain covered the windows.',
    ]);
  });

  it('同一稳定句在后续滚动窗口不重复提交，只提交真正新增后缀', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({
      startMs: 0,
      durationMs: 2_200,
      availableAtMs: 2_500,
      text: 'The subtitle system works.',
    });
    expect(first).toHaveLength(1);
    expect(first[0].cueId).toBeTruthy();

    expect(stabilizer.ingest({
      startMs: 500,
      durationMs: 2_200,
      availableAtMs: 3_100,
      text: 'The subtitle system works.',
    })).toEqual([]);

    const extension = stabilizer.ingest({
      startMs: 900,
      durationMs: 2_500,
      availableAtMs: 3_700,
      text: 'subtitle system works every day.',
    });
    expect(extension).toHaveLength(1);
    expect(extension[0].text).toBe('every day.');
    expect(extension[0].cueId).not.toBe(first[0].cueId);
    expect(getVideoAiTranscriptNovelSuffix(
      'The subtitle system works.',
      'subtitle system works every day.',
    )).toBe('every day.');
  });

  it('跨窗重复不提交，连接词扩展沿用同一 cue 做原位更新', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const outputs = [
      stabilizer.ingest({
        startMs: 0,
        durationMs: 2_400,
        availableAtMs: 2_700,
        text: 'Local subtitles stay synchronized.',
      }),
      stabilizer.ingest({
        startMs: 500,
        durationMs: 2_400,
        availableAtMs: 3_200,
        text: 'Local subtitles stay synchronized.',
      }),
      stabilizer.ingest({
        startMs: 900,
        durationMs: 2_800,
        availableAtMs: 4_000,
        text: 'subtitles stay synchronized with the video.',
      }),
      stabilizer.ingest({
        startMs: 1_300,
        durationMs: 2_800,
        availableAtMs: 4_500,
        text: 'subtitles stay synchronized with the video.',
      }),
    ].flat();

    expect(outputs.map((cue) => cue.text)).toEqual([
      'Local subtitles stay synchronized.',
      'Local subtitles stay synchronized with the video.',
    ]);
    expect(outputs[1].cueId).toBe(outputs[0].cueId);
    let timeline: VideoAiStabilizedCue[] = [];
    for (const cue of outputs) {
      timeline = updateCueTimeline(timeline, cue) as VideoAiStabilizedCue[];
    }
    expect(timeline.map((cue) => cue.text)).toEqual([
      'Local subtitles stay synchronized with the video.',
    ]);
  });

  it('30 秒连续滚动窗口只提交十个唯一完整句，不随重叠窗口增长重复', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const phrases = Array.from({ length: 10 }, (_, index) => ({
      startMs: index * 3_000,
      endMs: index * 3_000 + 2_200,
      text: `Continuous sentence ${index + 1} stays stable.`,
    }));
    const output: VideoAiStabilizedCue[] = [];

    for (let windowStartMs = 0; windowStartMs <= 26_000; windowStartMs += 2_600) {
      const durationMs = 6_000;
      output.push(...stabilizer.ingest({
        startMs: windowStartMs,
        durationMs,
        availableAtMs: windowStartMs + durationMs + 500,
        segments: phrases
          .filter((phrase) => phrase.startMs >= windowStartMs
            && phrase.endMs <= windowStartMs + durationMs)
          .map((phrase) => ({
            startMs: phrase.startMs - windowStartMs,
            endMs: phrase.endMs - windowStartMs,
            text: phrase.text,
          })),
      }));
    }

    expect(output.map((cue) => cue.text)).toEqual(phrases.map((phrase) => phrase.text));
    expect(new Set(output.map((cue) => cue.text)).size).toBe(phrases.length);
    expect(new Set(output.map((cue) => cue.cueId)).size).toBe(phrases.length);
    expect(output.every((cue, index) => index === 0 || cue.startMs > output[index - 1].startMs))
      .toBe(true);
  });

  it.each([
    ['can release', 'cannot release'], ['do support', "don't support"], ['will release', 'won’t release'],
    ['should release', "shouldn't release"], ['are using', 'aren’t using'],
  ])('词面高度相似但 %s / %s 的否定差异不会被当作重复吞掉', (affirmative, negative) => {
    const firstText = `We ${affirmative} the local model today.`;
    const secondText = `We ${negative} the local model today.`;
    expect.soft(areVideoAiTranscriptCorrectionVariants(firstText, secondText)).toBe(false);
    const stabilizer = new VideoAiTranscriptStabilizer();

    expect(areVideoAiTranscriptTextsRelated(firstText, secondText)).toBe(false);
    const first = stabilizer.ingest({
      startMs: 0,
      durationMs: 2_000,
      availableAtMs: 2_300,
      text: firstText,
    });
    const second = stabilizer.ingest({
      startMs: 1_000,
      durationMs: 2_000,
      availableAtMs: 3_300,
      text: secondText,
    });

    expect([...first, ...second].map((cue) => cue.text)).toEqual([firstText, secondText]);
  });

  it('flush 不会提交仍不可读的孤立片段', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    stabilizer.ingest({
      startMs: 0,
      durationMs: 500,
      availableAtMs: 600,
      text: 'uh',
    });
    expect(stabilizer.flush(3_000)).toEqual([]);
  });

  it('完整采集 flush 可提交有明确句末的短句，但实时 flush 默认仍保持严格门槛', () => {
    const realtime = new VideoAiTranscriptStabilizer();
    realtime.ingest({
      startMs: 0,
      durationMs: 1_500,
      availableAtMs: 1_600,
      text: 'This is CS4.',
    });
    expect(realtime.flush(2_000)).toEqual([]);

    const complete = new VideoAiTranscriptStabilizer();
    complete.ingest({
      startMs: 0,
      durationMs: 1_500,
      availableAtMs: 1_600,
      text: 'This is CS4.',
    });
    expect(complete.flush(2_000, true)).toMatchObject([{
      text: 'This is CS4.',
      partial: false,
      spokenEndMs: 1_500,
    }]);

    const thankYou = new VideoAiTranscriptStabilizer();
    thankYou.ingest({
      startMs: 2_000,
      durationMs: 1_200,
      availableAtMs: 3_300,
      text: 'Thank you.',
    });
    expect(thankYou.flush(4_000, true)).toMatchObject([{ text: 'Thank you.' }]);
  });

  it('完整采集 flush 不强行提交噪声/单词片段，重复 flush 安全返回空数组', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    stabilizer.ingest({
      startMs: 0,
      durationMs: 1_500,
      availableAtMs: 1_600,
      text: 'uh.',
    });
    expect(stabilizer.flush(2_000, true)).toEqual([]);
    expect(stabilizer.flush(2_100, true)).toEqual([]);

    const duplicate = new VideoAiTranscriptStabilizer();
    duplicate.ingest({
      startMs: 0,
      durationMs: 1_500,
      availableAtMs: 1_600,
      text: 'This is CS4.',
    });
    expect(duplicate.flush(2_000, true)).toHaveLength(1);
    expect(duplicate.flush(2_100, true)).toEqual([]);
  });

  it('flush 遇到已被完整前文覆盖的 held 短句时安全丢弃，不触发空值崩溃', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    stabilizer.ingest({
      startMs: 5_000,
      durationMs: 1_500,
      availableAtMs: 6_600,
      text: 'This is CS4.',
    });
    stabilizer.ingest({
      startMs: 0,
      durationMs: 4_000,
      availableAtMs: 6_700,
      text: 'This is CS4. More details follow clearly.',
    });
    expect(stabilizer.flush(7_000, true)).toEqual([]);

    const tooBrief = new VideoAiTranscriptStabilizer();
    tooBrief.ingest({
      startMs: 0,
      durationMs: 200,
      availableAtMs: 300,
      text: 'Thank you.',
    });
    expect(tooBrief.flush(500, true)).toEqual([]);
  });

  it('等待后提交的无标点短语也进入 committed 集合且不会再次输出', () => {
    const stabilizer = new VideoAiTranscriptStabilizer();
    const preview = stabilizer.ingest({
      startMs: 0,
      durationMs: 1_400,
      availableAtMs: 1_500,
      text: 'stable local subtitle phrase',
    });
    expect(preview).toMatchObject([{
      partial: true,
      text: 'stable local subtitle phrase',
    }]);

    const committed = stabilizer.ingest({
      startMs: 3_200,
      durationMs: 1_600,
      availableAtMs: 4_900,
      text: 'Another complete sentence.',
    });
    expect(committed[0]).toMatchObject({ text: 'Another complete sentence.', partial: false });
    expect(committed[0].cueId).toBeTruthy();

    expect(stabilizer.ingest({
      startMs: 200,
      durationMs: 1_400,
      availableAtMs: 5_200,
      text: 'stable local subtitle phrase',
    })).toEqual([]);
  });
});

describe('本地 AI 字幕时间轴稳定性', () => {
  it('无效时长使用最小 cue 时长，重叠起点会截断上一条', () => {
    const cues = mergeVideoAiSubtitleCues([
      { startMs: 0, durationMs: Number.NaN, text: 'first sentence here' },
      { startMs: 1_000, durationMs: Number.NaN, text: 'second sentence here' },
    ]);
    expect(cues[0].durationMs).toBe(1_000);
    const overlap = mergeVideoAiSubtitleCues([
      { startMs: 0, durationMs: 3_000, text: 'alpha beta gamma delta' },
      { startMs: 1_000, durationMs: 800, text: 'totally different words' },
    ]);
    expect(overlap[0].durationMs).toBe(1_000);
    expect((overlap[0] as VideoAiStabilizedCue).spokenEndMs).toBeUndefined();

    const normalized = normalizeVideoAiSubtitleTimeline(overlap);
    expect(normalized[0]).toMatchObject({ durationMs: 1_000, spokenEndMs: 1_000 });

    const invalid = normalizeVideoAiSubtitleTimeline([
      { startMs: 2_000, durationMs: Number.NaN, text: 'Invalid duration falls back safely.' },
    ]);
    expect(invalid[0]).toMatchObject({ durationMs: 500, spokenEndMs: 2_500 });
  });

  it('较早和同起点但更旧的重叠 cue 不抢占当前最新字幕', () => {
    const current={startMs:1_000,durationMs:3_000,availableAtMs:900,text:'Latest visible caption.'};
    const older={startMs:0,durationMs:4_000,availableAtMs:800,text:'Older overlapping caption.'};
    const duplicate={...current,availableAtMs:500,text:'Earlier result at the same start.'};
    expect(getVisibleVideoAiCue([current,older,duplicate] as VideoAiStabilizedCue[],1_200)).toBe(current);
  });

  it('没有 spokenEnd 时按 cue 时长 fallback', () => {
    const cue = { startMs: 1_000, durationMs: Number.NaN, text: 'fallback duration' };
    expect(getVisibleVideoAiCue([cue], 1_000)?.text).toBe(cue.text);
    expect(getVisibleVideoAiCue([cue], 1_499)?.text).toBe(cue.text);
    expect(getVisibleVideoAiCue([cue], Number.NaN)).toBeNull();

    const sameStart = getVisibleVideoAiCue([
      { startMs: 1_000, durationMs: 1_000, availableAtMs: 500, text: 'early result' },
      { startMs: 1_000, durationMs: 1_000, availableAtMs: 700, text: 'later result' },
    ] as VideoAiStabilizedCue[], 1_000);
    expect(sameStart?.text).toBe('later result');
  });
  it('时间轴入口也保证至少 1800ms 的实际可见时长', () => {
    const sourceCue = {
      startMs: 1_000,
      durationMs: 240,
      spokenEndMs: 1_240,
      text: 'This is readable now.',
    } as VideoAiStabilizedCue;
    const [cue] = mergeVideoAiSubtitleCues([sourceCue]);
    expect(getVisibleVideoAiCue([cue], 1_000)?.text).toBe(cue.text);
    expect(getVisibleVideoAiCue([cue], 1_240)).toBeNull();
  });

  it('迟到结果不会把旧句延长到后续音频时间', () => {
    const cue: VideoAiStabilizedCue = {
      startMs: 0,
      durationMs: VIDEO_AI_MIN_READABLE_CUE_MS,
      text: 'This subtitle arrived late.',
      availableAtMs: 5_000,
      spokenEndMs: 1_000,
    };

    // 允许时间轴本身的 80ms 边界容差，但不能把迟到字幕回填到更早的画面。
    expect.soft(getVisibleVideoAiCue([cue], 4_900)).toBeNull();
    expect.soft(getVisibleVideoAiCue([cue], 5_000)).toBeNull();
    expect.soft(getVisibleVideoAiCue([cue], 6_799)).toBeNull();
  });

  it('慢译文返回时间不会改变 spoken cue 的可见区间', () => {
    const cue = {
      startMs: 0,
      durationMs: 1_800,
      text: 'Translation arrives later.',
      availableAtMs: 2_000,
      spokenEndMs: 1_200,
      translationAvailableAtMs: 9_000,
    } as VideoAiStabilizedCue & { translationAvailableAtMs: number };

    expect(getVisibleVideoAiCue([cue], 3_799)).toBeNull();
    expect(getVisibleVideoAiCue([cue], 8_800)).toBeNull();
    expect(getVisibleVideoAiCue([cue], 9_000)).toBeNull();
    expect(getVisibleVideoAiCue([cue], 10_799)).toBeNull();
  });

  it('完整识别的长时间轴有界，递增播放头始终选择最新可用项且不回退', () => {
    const overflowCount = 75;
    const input: VideoAiStabilizedCue[] = Array.from({length: VIDEO_AI_MAX_CUE_COUNT + overflowCount}, (_, index) => {
      const startMs = index * 1_000;
      return {
        startMs,
        durationMs: 900,
        text: `Bounded cue ${index} remains distinct.`,
        cueId: `bounded-${index}`,
        availableAtMs: startMs + 120,
        spokenEndMs: startMs + 800,
      };
    });
    const cues = normalizeVideoAiSubtitleTimeline(mergeVideoAiSubtitleCues(input)) as VideoAiStabilizedCue[];

    expect(cues).toHaveLength(VIDEO_AI_MAX_CUE_COUNT);
    expect(cues[0].cueId).toBe(`bounded-${overflowCount}`);
    expect(cues.at(-1)?.cueId)
      .toBe(`bounded-${VIDEO_AI_MAX_CUE_COUNT + overflowCount - 1}`);

    let previousVisibleStartMs = -1;
    for (let index = 0; index < cues.length; index += 137) {
      const expected = cues[index];
      const visible = getVisibleVideoAiCue(cues, expected.startMs + 200) as VideoAiStabilizedCue | null;
      expect(visible?.cueId).toBe(expected.cueId);
      expect(visible?.startMs).toBeGreaterThanOrEqual(previousVisibleStartMs);
      previousVisibleStartMs = visible?.startMs ?? previousVisibleStartMs;
    }
  });

  it('重复滑窗扩展已有句子时清除旧结尾标点', () => {
    const cues = mergeVideoAiSubtitleCues([
      {
        startMs: 0,
        durationMs: 2_600,
        text: 'The quick brown fox jumps over fences.',
      },
      {
        startMs: 1_100,
        durationMs: 2_500,
        text: 'brown fox jumps over fences every day.',
      },
    ]);

    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('The quick brown fox jumps over fences every day.');
    expect(getVisibleVideoAiCue(cues, 1_500)?.text)
      .toBe('The quick brown fox jumps over fences every day.');
  });

  it('后到的较短重复窗口不会覆盖完整已确认句', () => {
    const cues = mergeVideoAiSubtitleCues([
      { startMs: 0, durationMs: 2_400, text: 'Keep this full sentence intact.' },
      { startMs: 1_000, durationMs: 1_200, text: 'full sentence intact.' },
    ]);

    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Keep this full sentence intact.');
    expect(getVisibleVideoAiCue(cues, 1_500)?.text).toBe('Keep this full sentence intact.');
  });

  it('完全重复的窗口不会缩短已确认 cue', () => {
    const cues = mergeVideoAiSubtitleCues([
      { startMs: 0, durationMs: 2_000, text: 'Keep this complete sentence.' },
      { startMs: 1_200, durationMs: 900, text: 'Keep this complete sentence.' },
    ]);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      startMs: 0,
      durationMs: 2_100,
      text: 'Keep this complete sentence.',
    });
  });

  it('合并 cue 时保留有效翻译到达时间，并忽略无效值', () => {
    const merged = mergeVideoAiSubtitleCues([
      {
        startMs: 0,
        durationMs: 2_000,
        text: 'The same sentence arrives first.',
        translationAvailableAtMs: Number.NaN,
      },
      {
        startMs: 900,
        durationMs: 2_000,
        text: 'same sentence arrives first and continues.',
        translationAvailableAtMs: 2_500,
      },
    ] as Array<VideoAiStabilizedCue & { translationAvailableAtMs: number }>);
    expect(merged).toHaveLength(1);
    expect((merged[0] as VideoAiStabilizedCue & { translationAvailableAtMs?: number })
      .translationAvailableAtMs).toBe(2_500);
  });

  it('最终 AI 时间轴按 spokenEnd 截断 overlap，同时保留静音 gap', () => {
    const cues = normalizeVideoAiSubtitleTimeline([
      {
        startMs: 0,
        durationMs: 10_000,
        spokenEndMs: 10_000,
        text: 'First sentence ends before the next window.',
      } as VideoAiStabilizedCue,
      {
        startMs: 9_780,
        durationMs: 4_000,
        spokenEndMs: 13_800,
        text: 'A distinct next sentence.',
      } as VideoAiStabilizedCue,
      {
        startMs: 15_000,
        durationMs: 4_000,
        spokenEndMs: 15_900,
        text: 'A later sentence after silence.',
      } as VideoAiStabilizedCue,
    ]);

    expect(cues.map((cue) => [cue.startMs, cue.durationMs, (cue as VideoAiStabilizedCue).spokenEndMs])).toEqual([
      [0, 9_780, 9_780],
      [9_780, 4_020, 13_800],
      [15_000, 900, 15_900],
    ]);
    expect(cues[1].startMs).toBeGreaterThanOrEqual((cues[0] as VideoAiStabilizedCue).spokenEndMs!);
    expect(cues[2].startMs).toBeGreaterThan((cues[1] as VideoAiStabilizedCue).spokenEndMs!);
  });

  it('同一 spoken 起点的独立 AI 结果保留后到结果，避免并列 overlap', () => {
    const cues = normalizeVideoAiSubtitleTimeline([
      { startMs: 2_000, durationMs: 3_000, spokenEndMs: 5_000, text: 'Earlier candidate.' },
      { startMs: 2_000, durationMs: 4_000, spokenEndMs: 6_000, text: 'Later candidate.' },
    ] as VideoAiStabilizedCue[]);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ startMs: 2_000, text: 'Later candidate.', spokenEndMs: 6_000 });
  });

  it('校正版先在 merge 阶段保留 spoken overlap，最终归一化后只有一条 cue', () => {
    const merged = mergeVideoAiSubtitleCues([
      {
        startMs: 15_000,
        durationMs: 3_800,
        spokenEndMs: 18_200,
        text: 'Back inside, the team compared both models and recorded every observation.',
      } as VideoAiStabilizedCue,
      {
        startMs: 15_300,
        durationMs: 2_000,
        spokenEndMs: 17_000,
        partial: true,
        text: 'Back inside, the team compared both models and recorded every observation.',
      } as VideoAiStabilizedCue,
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as VideoAiStabilizedCue).spokenEndMs).toBe(18_200);
    expect(normalizeVideoAiSubtitleTimeline(merged)).toHaveLength(1);
  });
});
