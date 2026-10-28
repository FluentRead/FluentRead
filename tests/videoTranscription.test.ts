import { describe, expect, it } from 'vitest';
import {
  getVideoLocalTranscriptionModelId,
  getVideoLocalTranscriptionDownloadBytes,
  getVideoLocalTranscriptionInferenceTimeoutMs,
  getVideoLocalTranscriptionWorkerTimeoutMs,
  getVideoLocalTranscriptionRequestTimeoutMs,
  normalizeVideoLocalTranscriptionModel,
  normalizeVideoLocalTranscriptionModels,
  normalizeVideoAiRecognitionMetadata,
  isDegenerateVideoTranscript,
  VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
  resampleToWhisperAudio,
  prepareWhisperAudioWindow,
} from '@/src/features/video-subtitle/transcription';
import {
  getVideoAiModelFileUrl,
  VIDEO_AI_Q4_MODEL_FILES,
} from '@/src/features/video-subtitle/offscreen/modelCache';

describe('视频 AI 字幕转写配置', () => {
  it('保留正常印地语短句及二到五次带元音符号的合理强调', () => {
    expect(isDegenerateVideoTranscript('आज पुस्तकालय खुला है और छात्र शांतिपूर्वक पढ़ रहे हैं।')).toBe(false);
    for (let count = 2; count <= 5; count++) {
      expect(isDegenerateVideoTranscript('धीरे धीरे सीखो। '.repeat(count))).toBe(false);
      expect(isDegenerateVideoTranscript('कि'.repeat(count))).toBe(false);
      expect(isDegenerateVideoTranscript('a\u0301'.repeat(count))).toBe(false);
    }
  });

  it.each(['क', 'कि', 'a', 'a\u0301', 'กิ', 'か\u3099'])('附着标记与普通字符一致，在十六次循环前后使用同一边界：%s', character => {
    expect(isDegenerateVideoTranscript(character.repeat(15))).toBe(false);
    expect(isDegenerateVideoTranscript(character.repeat(16))).toBe(true);
  });

  it('长短语带结合标记时仍使用六次与总长四十八的保护边界', () => {
    const phrase = 'धीरेसीखो';
    expect(phrase).toHaveLength(8);
    expect(isDegenerateVideoTranscript(phrase.repeat(5))).toBe(false);
    expect(isDegenerateVideoTranscript(phrase.repeat(6))).toBe(true);
    expect(isDegenerateVideoTranscript('कि'.repeat(6))).toBe(false);
    expect(isDegenerateVideoTranscript('cafe\u0301'.repeat(10))).toBe(true);
    expect(isDegenerateVideoTranscript('عِلْم'.repeat(12))).toBe(true);
  });

  it('跨消息保留实际自动语言诊断，零值不丢失，不填造未提供的检测', () => {
    expect(normalizeVideoAiRecognitionMetadata({detectedLanguage: 'ja', languageConfidence: 0.83,
      languageDetectionMs: 126, encoderReuse: true, text: 'unrelated'})).toEqual({
      detectedLanguage: 'ja', languageConfidence: 0.83, languageDetectionMs: 126, encoderReuse: true,
    });
    expect(normalizeVideoAiRecognitionMetadata({detectedLanguage: 'en', languageConfidence: 0,
      languageDetectionMs: 0, encoderReuse: false})).toEqual({
      detectedLanguage: 'en', languageConfidence: 0, languageDetectionMs: 0, encoderReuse: false,
    });
    expect(normalizeVideoAiRecognitionMetadata({detectedLanguage: 'haw', languageConfidence: 1})).toEqual({
      detectedLanguage: 'haw', languageConfidence: 1,
    });
    expect(normalizeVideoAiRecognitionMetadata({})).toEqual({});
    expect(normalizeVideoAiRecognitionMetadata({detectedLanguage: 'zh'})).toEqual({detectedLanguage: 'zh'});
  });

  it('不把异常语言 token、字符串数字和非法耗时当作真实模型诊断', () => {
    for (const value of [null, undefined, '', false, 0]) expect(normalizeVideoAiRecognitionMetadata(value)).toEqual({});
    for (const detectedLanguage of [undefined, 1, 'auto', 'en-US', '<|en|>', 'EN', '<script>']) {
      expect(normalizeVideoAiRecognitionMetadata({detectedLanguage, languageConfidence: 0.9})).toEqual({});
    }
    for (const languageConfidence of [undefined, '0.9', NaN, Infinity, -0.1, 1.1]) {
      expect(normalizeVideoAiRecognitionMetadata({detectedLanguage: 'zh', languageConfidence})).toEqual({detectedLanguage: 'zh'});
    }
    for (const languageDetectionMs of ['5', NaN, Infinity, -1]) {
      expect(normalizeVideoAiRecognitionMetadata({languageDetectionMs, encoderReuse: 'true'})).toEqual({});
    }
  });

  it('使用扩展内本地 Whisper 模型，推荐并默认 Small，保留 Tiny/Base 选择', () => {
    expect(VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL).toBe('small');
    expect(normalizeVideoLocalTranscriptionModel(undefined)).toBe('small');
    expect(normalizeVideoLocalTranscriptionModel('tiny')).toBe('tiny');
    expect(normalizeVideoLocalTranscriptionModel('base')).toBe('base');
    expect(normalizeVideoLocalTranscriptionModel('small')).toBe('small');
    expect(normalizeVideoLocalTranscriptionModel('unknown')).toBe('small');
    expect(getVideoLocalTranscriptionModelId('unknown')).toBe('onnx-community/whisper-small');
    expect(getVideoLocalTranscriptionModelId('base')).toBe('onnx-community/whisper-base');
    expect(getVideoLocalTranscriptionDownloadBytes('base')).toBe(150_000_000);
    expect(getVideoLocalTranscriptionDownloadBytes('unknown')).toBe(590_000_000);
    expect(getVideoLocalTranscriptionModelId('small')).toBe('onnx-community/whisper-small');
    expect(getVideoLocalTranscriptionDownloadBytes('small')).toBe(590_000_000);
    expect(normalizeVideoLocalTranscriptionModels(['tiny', 'base', 'small', 'unknown', 'tiny', 'small'])).toEqual(['tiny', 'base', 'small']);
  });

  it('分模块精度只透传真实枚举，不从 legacy dtype 或模型名猜造', () => {
    expect(normalizeVideoAiRecognitionMetadata({encoderDtype: 'fp32', decoderDtype: 'q4', dtype: 'q4'}))
      .toEqual({encoderDtype: 'fp32', decoderDtype: 'q4'});
    for (const dtype of ['fp32', 'q4', 'q8']) {
      expect(normalizeVideoAiRecognitionMetadata({encoderDtype: dtype, decoderDtype: dtype}))
        .toEqual({encoderDtype: dtype, decoderDtype: dtype});
    }
    for (const dtype of [undefined, null, 4, 'Q4', 'fp16', 'quantized', {}]) {
      expect(normalizeVideoAiRecognitionMetadata({encoderDtype: dtype, decoderDtype: dtype})).toEqual({});
    }
    expect(normalizeVideoAiRecognitionMetadata({model: 'small', dtype: 'q4'})).toEqual({});
    expect(normalizeVideoAiRecognitionMetadata({encoderDtype: 'fp32'})).toEqual({encoderDtype: 'fp32'});
    expect(normalizeVideoAiRecognitionMetadata({decoderDtype: 'q8'})).toEqual({decoderDtype: 'q8'});
  });

  it('默认 Small 使用慢 CPU 预算，明确选择 Tiny/Base 继续保留原上限', () => {
    for (const model of ['small', 'unknown', null, undefined, 3]) {
      expect(getVideoLocalTranscriptionInferenceTimeoutMs(model)).toBe(60_000);
      expect(getVideoLocalTranscriptionWorkerTimeoutMs(model)).toBe(180_000);
      expect(getVideoLocalTranscriptionRequestTimeoutMs(model)).toBe(200_000);
    }
    for (const model of ['tiny', 'base']) {
      expect(getVideoLocalTranscriptionInferenceTimeoutMs(model)).toBe(15_000);
      expect(getVideoLocalTranscriptionWorkerTimeoutMs(model)).toBe(32_000);
      expect(getVideoLocalTranscriptionRequestTimeoutMs(model)).toBe(40_000);
    }
  });

  it('预下载只缓存 Whisper q4 运行所需文件，并使用与 Transformers.js 相同的 URL', () => {
    expect(VIDEO_AI_Q4_MODEL_FILES).toEqual([
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_q4.onnx',
      'onnx/decoder_model_merged_q4.onnx',
    ]);
    expect(getVideoAiModelFileUrl('base', 'onnx/encoder_model_q4.onnx')).toBe(
      'https://modelscope.cn/models/onnx-community/whisper-base/resolve/master/onnx/encoder_model_q4.onnx',
    );
  });

  it('将多声道音频重采样为单声道 PCM', () => {
    const result = resampleToWhisperAudio([
      new Float32Array([1, 1, 1, 1]),
      new Float32Array([-1, -1, -1, -1]),
    ], 8, 4);

    expect(result).toHaveLength(2);
    expect(Array.from(result)).toEqual([0, 0]);
  });

  it('只裁剪长数字静音外侧并保留偏移、上下文和句间停顿', () => {
    const audio = new Float32Array(8 * 16_000);
    audio.fill(0.02, 2 * 16_000, 3 * 16_000);
    audio.fill(-0.02, 4 * 16_000, 5 * 16_000);
    const result = prepareWhisperAudioWindow(audio);
    expect(result.offsetMs).toBe(1840);
    expect(result.sourceDurationMs).toBe(8000);
    expect(result.audio.length / 16).toBe(3320);
    expect(Array.from(result.audio.subarray(1160 * 16, 2160 * 16))).toEqual(new Array(16_000).fill(0));
    expect(result.audio.buffer).toBe(audio.buffer);
  });

  it('保留低音量声音、短静音边缘和小于二十毫秒的语音窗', () => {
    const quiet = new Float32Array(32_000).fill(0.00005);
    expect(prepareWhisperAudioWindow(quiet).audio).toEqual(quiet);
    const shortEdges = new Float32Array(16_000);
    shortEdges.fill(0.04, 400 * 16, 700 * 16);
    expect(prepareWhisperAudioWindow(shortEdges)).toMatchObject({audio: shortEdges, offsetMs: 0, sourceDurationMs: 1000});
    expect(prepareWhisperAudioWindow(new Float32Array([0.01])).audio).toEqual(new Float32Array([0.01]));
  });

  it('空音频或 PCM16 一个量化步长内的数字静音不送入模型，非法采样置零', () => {
    expect(prepareWhisperAudioWindow(new Float32Array())).toEqual({audio: new Float32Array(), offsetMs: 0, sourceDurationMs: 0});
    const silent = new Float32Array(16_000).fill(1 / 32_768);
    silent[1] = NaN;
    silent[2] = Infinity;
    expect(prepareWhisperAudioWindow(silent)).toEqual({audio: new Float32Array(), offsetMs: 0, sourceDurationMs: 1000});
    const input = new Float32Array([0.02, NaN, Infinity, -0.03]);
    const result = prepareWhisperAudioWindow(input);
    expect(result.audio).toEqual(new Float32Array([0.02, 0, 0, -0.03]));
    expect(result.audio.buffer).not.toBe(input.buffer);
    expect(Number.isNaN(input[1])).toBe(true);
  });
});
