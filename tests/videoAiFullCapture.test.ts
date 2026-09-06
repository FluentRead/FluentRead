import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consolidateVideoAiFullCues,
  createVideoAiFullAudioWindows,
  VideoAiFullCaptureController,
} from '@/src/features/video-subtitle/content/video-ai/fullCapture';
import {normalizeCompletedVideoAiSubtitleCues} from '@/src/features/video-subtitle/transcriptionCache';
import type { VideoAiAudioChunk } from '@/src/features/video-subtitle/content/video-ai/capture';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('本地 AI 完整视频音频窗口', () => {
  it('Tiny 使用 10 秒窗口和 1.2 秒重叠，并覆盖到完整尾部', () => {
    const audio = new Float32Array(25 * 16_000);
    const windows = createVideoAiFullAudioWindows(audio, 'tiny');

    expect(windows.map(({ startMs, endMs }) => [Math.round(startMs), Math.round(endMs)])).toEqual([
      [0, 10_000],
      [8_800, 18_800],
      [17_600, 25_000],
    ]);
    expect(windows.every(({ pcm }) => pcm.length > 0)).toBe(true);
    expect(windows.at(-1)?.endMs).toBe(25_000);
  });

  it('Base 在较长窗口下仍不超过 Whisper 单次 30 秒上限', () => {
    const audio = new Float32Array(45 * 16_000);
    const windows = createVideoAiFullAudioWindows(audio, 'base');

    expect(windows.length).toBe(4);
    expect(windows[0].endMs - windows[0].startMs).toBe(14_000);
    expect(windows[1].startMs).toBe(12_800);
    expect(windows.at(-1)?.endMs).toBe(45_000);
    expect(Math.max(...windows.map(({ pcm }) => pcm.length / 16_000))).toBeLessThanOrEqual(30);
  });

  it('空 PCM 不会伪造一个可识别窗口', () => {
    expect(createVideoAiFullAudioWindows(new Float32Array(), 'tiny')).toEqual([]);
  });

  it('完整模式只合并有校正证据的重叠句子', () => {
    const cues = consolidateVideoAiFullCues([
      {
        startMs: 15_000,
        durationMs: 3_800,
        spokenEndMs: 18_200,
        availableAtMs: 0,
        text: 'Back inside, the team compared both models and recorded every observation.',
      },
      {
        startMs: 15_300,
        durationMs: 2_000,
        spokenEndMs: 17_000,
        availableAtMs: 0,
        partial: true,
        text: 'Back in some parts of the window,',
      },
    ]);

    expect(cues).toHaveLength(2);
    expect(cues.map((cue) => cue.text)).toEqual([
      'Back inside, the team compared both models and recorded every observation.',
      'Back in some parts of the window,',
    ]);

    const corrected = consolidateVideoAiFullCues([
      {
        startMs: 15_000,
        durationMs: 3_800,
        spokenEndMs: 18_200,
        availableAtMs: 0,
        text: 'Back inside, the team compared both models and recorded every observation.',
      },
      {
        startMs: 15_300,
        durationMs: 2_000,
        spokenEndMs: 17_000,
        availableAtMs: 0,
        partial: true,
        text: 'Back inside, the team compared both models and recorded every observation',
      },
    ]);
    expect(corrected).toHaveLength(1);
    expect(corrected[0].text).toContain('compared both models');

    const shorterCorrection = consolidateVideoAiFullCues([
      {
        startMs: 20_000,
        durationMs: 3_800,
        spokenEndMs: 23_800,
        availableAtMs: 0,
        text: 'At Sunrise, the research team opened the lab and checked the new system.',
      },
      {
        startMs: 20_300,
        durationMs: 1_200,
        spokenEndMs: 21_500,
        availableAtMs: 0,
        partial: true,
        text: 'At Sunrise, the research team opened 11.',
      },
    ]);
    expect(shorterCorrection).toHaveLength(1);
    expect(shorterCorrection[0].text).toContain('checked the new system');

    const longerCorrection = consolidateVideoAiFullCues([
      {
        startMs: 25_000,
        durationMs: 1_200,
        spokenEndMs: 26_200,
        availableAtMs: 0,
        partial: true,
        text: 'The team compared both models.',
      },
      {
        startMs: 25_300,
        durationMs: 3_800,
        spokenEndMs: 29_100,
        availableAtMs: 0,
        text: 'The team compared both models carefully and recorded every observation.',
      },
    ]);
    expect(longerCorrection).toHaveLength(1);
    expect(longerCorrection[0].text).toContain('carefully and recorded');
  });

  it('does not merge common-first-word sentences or semantic numeric/negation changes', () => {
    const cases = [
      ['The system is ready for the next experiment.', 'The results are available on the screen.'],
      ['Opened 11 windows today for review.', 'Opened 12 windows today for review.'],
      ['We can release the local model today.', 'We cannot release the local model today.'],
    ];
    for (const [first, second] of cases) {
      const cues = consolidateVideoAiFullCues([
        {startMs: 1_000, durationMs: 2_000, spokenEndMs: 3_000, availableAtMs: 0, text: first},
        {startMs: 1_400, durationMs: 2_000, spokenEndMs: 3_400, availableAtMs: 0, text: second},
      ]);
      expect(cues.map((cue) => cue.text)).toEqual([first, second]);
    }
  });

  it('完整窗口处理无效采样率、短尾和缺少 spokenEnd 的 cue', () => {
    const audio = new Float32Array(18_490 * 16);
    expect(createVideoAiFullAudioWindows(audio, 'tiny', Number.NaN)).toEqual([]);
    expect(createVideoAiFullAudioWindows(audio, 'tiny', 0)).toEqual([]);
    const windows = createVideoAiFullAudioWindows(audio, 'tiny');
    expect(windows.at(-1)?.endMs).toBeCloseTo(18_490, 5);
    expect(createVideoAiFullAudioWindows(new Float32Array(13_600 * 16), 'base')).toHaveLength(1);

    const cues = consolidateVideoAiFullCues([
      { startMs: Number.NaN, durationMs: 1_000, text: '', availableAtMs: 0, spokenEndMs: 0 },
      { startMs: 0, durationMs: 1_000, spokenEndMs: 1_000, text: 'A distinct sentence.', availableAtMs: 0 },
      { startMs: 100, durationMs: 1_000, spokenEndMs: 1_100, text: 'A much longer distinct sentence with more words.', availableAtMs: 0 },
      { startMs: 2_000, durationMs: 1_000, spokenEndMs: 3_000, text: 'Another sentence.', availableAtMs: 0 },
      { startMs: 4_000, durationMs: 1_000, text: 'Fallback spoken end sentence.', availableAtMs: 0, spokenEndMs: Number.NaN },
      { startMs: 6_000, durationMs: 1_000, spokenEndMs: 7_000, text: '!!!', availableAtMs: 0 },
      { startMs: 6_100, durationMs: 1_000, spokenEndMs: 7_100, text: '!!! more', availableAtMs: 0 },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual([
      'A distinct sentence.',
      'A much longer distinct sentence with more words.',
      'Another sentence.',
      'Fallback spoken end sentence.',
      '!!!',
      '!!! more',
    ]);
  });
});

describe('本地 AI 完整生成控制器的安全边界', () => {
  it('浏览器不支持采集时立即进入错误态，不会显示生成中', () => {
    const errors: Error[] = [];
    const states: string[] = [];
    const controller = new VideoAiFullCaptureController({
      getVideo: () => null,
      getModel: () => 'tiny',
      isSupported: () => false,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: (error) => errors.push(error),
      onStateChange: () => states.push(controller.getPhase()),
    });

    expect(controller.start()).toBe(false);
    expect(controller.getPhase()).toBe('error');
    expect(controller.isRequested()).toBe(false);
    expect(errors[0]?.message).toContain('完整采集');
    expect(states).not.toContain('capturing');
  });

  it('公开状态查询在初始和失败状态返回快照', () => {
    const controller = new VideoAiFullCaptureController({
      getVideo: () => null,
      getModel: () => 'tiny',
      isSupported: () => false,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.getSessionId()).toBe(0);
    expect(controller.getProgress()).toMatchObject({ phase: 'idle', progress: 0 });
    expect(controller.getError()).toBe('');
    expect(controller.isActive()).toBe(false);
    controller.start();
    expect(controller.getError()).toContain('完整采集');
    expect(controller.isActive()).toBe(false);
    controller.destroy();
    const idle = new VideoAiFullCaptureController({
      getVideo: () => null,
      getModel: () => 'tiny',
      isSupported: () => false,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    idle.cancel();
    idle.destroy();
  });

  it('可直接读取完整媒体时跳过 1x 扫描并保持回放时间轴', async () => {
    const speech = Float32Array.from(
      { length: 3 * 16_000 },
      (_, index) => 0.04 * Math.sin(2 * Math.PI * 220 * index / 16_000),
    );
    const decoded = {
      numberOfChannels: 1,
      sampleRate: 16_000,
      duration: 3,
      getChannelData: () => speech,
    };
    class FastAudioContext {
      state: AudioContextState = 'running';

      async decodeAudioData(): Promise<AudioBuffer> {
        return decoded as unknown as AudioBuffer;
      }

      async close(): Promise<void> {
        this.state = 'closed';
      }
    }
    const videoState = {
      currentSrc: 'data:video/webm;base64,fixture',
      src: 'data:video/webm;base64,fixture',
      duration: 3,
      currentTime: 0,
      paused: false,
      playbackRate: 1,
      muted: false,
      volume: 1,
      captureStream: () => ({ getAudioTracks: () => [] }),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
    };
    const transcribe = vi.fn(async () => ({
      text: 'A fast decoded sentence without punctuation',
      segments: [{ startMs: 0, endMs: 1_000, text: 'A fast decoded sentence without punctuation' }],
    }));
    const onTranscriptionComplete = vi.fn(async (_cues: import('@/src/features/video-subtitle/content/video-ai/streamingTranscript').VideoAiStabilizedCue[]) => undefined);
    const progress: Array<{ captureMode?: string; phase: string }> = [];
    vi.stubGlobal('window', {
      AudioContext: FastAudioContext,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(4),
    })));

    const controller = new VideoAiFullCaptureController({
      getVideo: () => videoState as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete,
      onError: (error) => { throw error; },
      onStateChange: () => undefined,
      onProgress: (next) => progress.push({ captureMode: next.captureMode, phase: next.phase }),
    });

    expect(controller.start()).toBe(true);
    for (let index = 0; index < 30 && controller.getPhase() !== 'ready'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(controller.getPhase()).toBe('ready');
    expect(fetch).toHaveBeenCalledWith('data:video/webm;base64,fixture', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscriptionComplete).toHaveBeenCalledTimes(1);
    const completedCues = onTranscriptionComplete.mock.calls[0][0];
    expect(completedCues.length).toBeGreaterThan(0);
    expect(completedCues.every(cue => cue.partial === false)).toBe(true);
    expect(normalizeCompletedVideoAiSubtitleCues(completedCues)).toHaveLength(completedCues.length);
    expect(progress.some((item) => item.captureMode === 'fast-decode')).toBe(true);
    // 快速解码不应改写用户 video 的播放位置或主动播放。
    expect(videoState.currentTime).toBe(0);
    expect(videoState.pause).not.toHaveBeenCalled();
    expect(videoState.play).not.toHaveBeenCalled();
  });

  it('快速解码等待期间取消后，迟到结果不会写回或触碰用户 video', async () => {
    let resolveFetch!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const videoState = {
      currentSrc: 'https://video.twimg.com/video.mp4',
      src: 'https://video.twimg.com/video.mp4',
      duration: 3,
      currentTime: 1.25,
      paused: false,
      playbackRate: 1.5,
      muted: true,
      volume: 0.35,
      captureStream: () => ({ getAudioTracks: () => [] }),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
    };
    class FastAudioContext {
      state: AudioContextState = 'running';

      async close(): Promise<void> { this.state = 'closed'; }
    }
    const onTranscriptionComplete = vi.fn(async () => undefined);
    vi.stubGlobal('window', { AudioContext: FastAudioContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(() => pendingFetch));

    const controller = new VideoAiFullCaptureController({
      getVideo: () => videoState as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'must be discarded' }),
      onTranscriptionComplete,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    controller.cancel();
    resolveFetch({
      ok: true,
      headers: { get: () => null } as unknown as Headers,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getPhase()).toBe('idle');
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    expect(videoState.currentTime).toBe(1.25);
    expect(videoState.playbackRate).toBe(1.5);
    expect(videoState.muted).toBe(true);
    expect(videoState.volume).toBe(0.35);
    expect(videoState.pause).not.toHaveBeenCalled();
    expect(videoState.play).not.toHaveBeenCalled();
  });

  it('优先使用注入的 HLS PCM，跳过 blob fetch 和 1x 扫描', async () => {
    const speech = Float32Array.from(
      { length: 3 * 16_000 },
      (_, index) => 0.04 * Math.sin(2 * Math.PI * 220 * index / 16_000),
    );
    class AudioContextStub {
      state: AudioContextState = 'running';
      async close(): Promise<void> { this.state = 'closed'; }
    }
    const videoState = {
      currentSrc: 'blob:https://x.com/mse',
      src: '',
      duration: 3,
      currentTime: 12,
      paused: false,
      playbackRate: 1,
      muted: false,
      volume: 1,
      captureStream: () => ({ getAudioTracks: () => [] }),
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
    };
    const transcribe = vi.fn(async () => ({ text: 'HLS audio works.' }));
    const onTranscriptionComplete = vi.fn(async () => undefined);
    const getAudio = vi.fn(async (_video: HTMLVideoElement, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return speech;
    });
    vi.stubGlobal('window', { AudioContext: AudioContextStub, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must not run'); }));

    const controller = new VideoAiFullCaptureController({
      getVideo: () => videoState as unknown as HTMLVideoElement,
      getAudio,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete,
      onError: vi.fn(),
      onStateChange: () => undefined,
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 30 && controller.getPhase() !== 'ready'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(controller.getPhase()).toBe('ready');
    expect(getAudio).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(videoState.currentTime).toBe(12);
    expect(videoState.pause).not.toHaveBeenCalled();
    expect(videoState.play).not.toHaveBeenCalled();
  });
});

class FullFakeNode {
  connect(): this { return this; }
  disconnect(): void {}
}

class FullFakeProcessor extends FullFakeNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  emit(samples: Float32Array): void {
    this.onaudioprocess?.({
      inputBuffer: {
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => samples,
      },
    } as unknown as AudioProcessingEvent);
  }
}

class FullFakeGain extends FullFakeNode {
  gain = { value: 1 };
}

class FullFakeTrack {
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'ended') return;
    this.listeners.add(() => {
      if (typeof listener === 'function') listener(new Event('ended'));
      else listener.handleEvent(new Event('ended'));
    });
  }

  removeEventListener(): void {}
  stop(): void {}
  clone(): MediaStreamTrack { return this as unknown as MediaStreamTrack; }
  emitEnded(): void { this.listeners.forEach((listener) => listener()); }
}

class FullFakeMediaStream {
  constructor(private readonly tracks: FullFakeTrack[] = []) {}
  getAudioTracks(): MediaStreamTrack[] { return this.tracks as unknown as MediaStreamTrack[]; }
  getTracks(): MediaStreamTrack[] { return this.getAudioTracks(); }
}

class FullFakeContext {
  static instances: FullFakeContext[] = [];
  static mediaElementError: unknown = null;
  static processorError: unknown = null;
  static mediaStreamError: unknown = null;
  static resumeGate: { promise: Promise<void>; resolve: () => void } | null = null;
  state: AudioContextState = 'running';
  readonly destination = new FullFakeNode();
  readonly processor = new FullFakeProcessor();
  readonly source = new FullFakeNode();
  readonly gain = new FullFakeGain();

  constructor() {
    FullFakeContext.instances.push(this);
  }

  createMediaElementSource(): MediaElementAudioSourceNode {
    if (FullFakeContext.mediaElementError !== null) throw FullFakeContext.mediaElementError;
    return this.source as unknown as MediaElementAudioSourceNode;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    if (FullFakeContext.mediaStreamError !== null) throw FullFakeContext.mediaStreamError;
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  createScriptProcessor(): ScriptProcessorNode {
    if (FullFakeContext.processorError !== null) throw FullFakeContext.processorError;
    return this.processor as unknown as ScriptProcessorNode;
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }

  async resume(): Promise<void> {
    await FullFakeContext.resumeGate?.promise;
  }

  async close(): Promise<void> { this.state = 'closed'; }
}

class FullFakeVideo {
  currentTime = 0;
  duration = 12;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  readyState = 4;
  src = 'blob:scan';
  currentSrc = 'blob:scan';
  crossOrigin = '';
  private sourceObject: MediaStream | null = null;
  srcObjectError: unknown = null;
  mozCaptureStream: (() => MediaStream) | undefined;
  playError: unknown = null;
  pauseError: unknown = null;
  captureStream = () => ({ getAudioTracks: () => [] }) as unknown as MediaStream;
  audioTrack = new FullFakeTrack();
  style = { cssText: '' };
  private readonly listeners = new Map<string, Map<EventListenerOrEventListenerObject, () => void>>();

  get srcObject(): MediaStream | null { return this.sourceObject; }
  set srcObject(value: MediaStream | null) {
    if (this.srcObjectError !== null) throw this.srcObjectError;
    this.sourceObject = value;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = () => {
      if (typeof listener === 'function') listener(new Event(type));
      else listener.handleEvent(new Event(type));
    };
    const set = this.listeners.get(type) || new Map<EventListenerOrEventListenerObject, () => void>();
    set.set(listener, callback);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  listenerCount(type: string): number { return this.listeners.get(type)?.size || 0; }
  firstListener(type: string): (() => void) | undefined { return this.listeners.get(type)?.values().next().value; }

  async play(): Promise<void> {
    if (this.playError !== null) throw this.playError;
  }
  pause(): void {
    if (this.pauseError !== null) throw this.pauseError;
  }
  load(): void {}
  setAttribute(): void {}
  remove(): void {}
}

beforeEach(() => {
  FullFakeContext.instances = [];
  FullFakeContext.mediaElementError = null;
  FullFakeContext.processorError = null;
  FullFakeContext.mediaStreamError = null;
  FullFakeContext.resumeGate = null;
});

describe('本地 AI 完整生成控制器扫描与收尾', () => {
  it('通过隐藏扫描副本采集、排队重叠窗口并在视频结束后完成识别', async () => {
    vi.useFakeTimers();
    FullFakeContext.instances = [];
    const sourceVideo = new FullFakeVideo();
    sourceVideo.duration = 0;
    const scanVideo = new FullFakeVideo();
    const transcribe = vi.fn(async () => ({
      text: 'The complete hidden scan sentence is ready.',
      segments: [{ startMs: 0, endMs: 1_500, text: 'The complete hidden scan sentence is ready.' }],
      inferenceMs: 100,
    }));
    const onTranscriptionComplete = vi.fn(async () => undefined);
    const onError = vi.fn();
    const progress: string[] = [];
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));

    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete,
      onError,
      onStateChange: vi.fn(),
      onProgress: (next) => progress.push(next.phase),
    });

    expect(controller.start()).toBe(true);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    scanVideo.currentTime = 10;
    FullFakeContext.instances.at(-1)?.processor.emit(new Float32Array(160_000).fill(0.04));
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(controller.getPhase()).toBe('ready');
    expect(transcribe).toHaveBeenCalled();
    expect(onTranscriptionComplete).toHaveBeenCalledTimes(1);
    expect(progress).toContain('transcribing');
    expect(progress).toContain('ready');
    expect(onError).not.toHaveBeenCalled();
    controller.destroy();
    vi.useRealTimers();
  });

  it('超过 30 秒时按绝对采集位置排队后续窗口并保留正确 start/duration', async () => {
    vi.useFakeTimers();
    FullFakeContext.instances = [];
    const sourceVideo = new FullFakeVideo();
    sourceVideo.duration = 35;
    const scanVideo = new FullFakeVideo();
    scanVideo.duration = 35;
    const chunks: VideoAiAudioChunk[] = [];
    const transcribe = vi.fn(async (chunk: VideoAiAudioChunk) => {
      chunks.push(chunk);
      return { text: `Window ${chunk.sequence} is complete.` };
    });
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onError: (error) => { throw error; },
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    for (const duration of [10, 10, 10, 5]) {
      scanVideo.currentTime += duration;
      FullFakeContext.instances.at(-1)?.processor.emit(new Float32Array(duration * 16_000).fill(0.04));
    }
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();

    expect(controller.getPhase()).toBe('ready');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((chunk) => Math.round(chunk.startMs))).toEqual(
      expect.arrayContaining([0, 8_800, 17_600]),
    );
    expect(chunks.every((chunk) => chunk.durationMs > 0 && chunk.durationMs <= 10_000)).toBe(true);
    controller.destroy();
    vi.useRealTimers();
  });
});

describe('本地 AI 完整模式快速解码边界', () => {
  it('拒绝错误响应、过大响应、空数据、解码异常和时长不匹配', async () => {
    vi.useFakeTimers();
    const cases = [
      { response: { ok: false, headers: { get: () => null } }, decode: 'ok' },
      { response: { ok: true, headers: { get: () => String(60 * 1024 * 1024) } }, decode: 'ok' },
      { response: { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }, decode: 'ok' },
      { response: { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, decode: 'reject' },
      { response: { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, decode: 'mismatch' },
      { response: { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, decode: 'noduration' },
      { response: { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(4) }, decode: 'empty' },
    ] as const;
    for (const item of cases) {
      class DecodeContext {
        state: AudioContextState = 'running';

        async decodeAudioData(): Promise<AudioBuffer> {
          if (item.decode === 'reject') throw new Error('decode failed');
          const length = item.decode === 'mismatch' ? 16_000 : 48_000;
          return {
            numberOfChannels: item.decode === 'empty' ? 0 : 1,
            sampleRate: 16_000,
            getChannelData: () => new Float32Array(length).fill(0.04),
          } as unknown as AudioBuffer;
        }

        async close(): Promise<void> { this.state = 'closed'; }
      }
      const video = {
        currentSrc: item.decode === 'noduration' ? '' : 'data:video/webm;base64:fixture',
        src: 'data:video/webm;base64:fixture',
        duration: item.decode === 'noduration' ? 0 : 3,
        currentTime: 0,
        paused: false,
        ended: false,
        playbackRate: 1,
        muted: false,
        volume: 1,
        captureStream: () => ({ getAudioTracks: () => [] }),
      };
      vi.stubGlobal('window', { AudioContext: DecodeContext, setTimeout, clearTimeout });
      vi.stubGlobal('fetch', vi.fn(async () => item.response));
      const controller = new VideoAiFullCaptureController({
        getVideo: () => video as unknown as HTMLVideoElement,
        getModel: () => 'tiny',
        isSupported: () => true,
        transcribe: async () => ({ text: 'unused' }),
        onTranscriptionComplete: async () => undefined,
        onError: vi.fn(),
        onStateChange: vi.fn(),
      });
      expect(controller.start()).toBe(true);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(['capturing', 'transcribing', 'error']).toContain(controller.getPhase());
      controller.cancel();
      vi.unstubAllGlobals();
    }
    vi.useRealTimers();
  });
});

describe('本地 AI 完整模式入口与隐藏副本边界', () => {
  it('拒绝缺少视频、音频源和超长视频', () => {
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    const make = (video: unknown, supported = true) => new VideoAiFullCaptureController({
      getVideo: () => video as HTMLVideoElement | null,
      getModel: () => 'tiny',
      isSupported: () => supported,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(make(null).start()).toBe(false);
    expect(make({ duration: 1, currentSrc: '', src: '' }).start()).toBe(false);
    expect(make({ duration: 1_201, currentSrc: 'data:x', src: 'data:x' }).start()).toBe(false);
    const longVideo = new FullFakeVideo();
    longVideo.duration = 1_201;
    expect(make(longVideo).start()).toBe(false);
    const noContextVideo = new FullFakeVideo();
    vi.stubGlobal('window', {});
    expect(make(noContextVideo).start()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('快速解码处理 src fallback、非媒体 URL、超大 data URL 和缺少 AudioContext', async () => {
    const cases = [
      { currentSrc: '', src: 'data:video/webm;base64:fixture' },
      { currentSrc: 'ftp://invalid', src: '' },
      { currentSrc: `data:${'x'.repeat(72 * 1024 * 1024 + 1)}`, src: '' },
    ];
    for (const source of cases) {
      const video = new FullFakeVideo();
      video.currentSrc = source.currentSrc;
      video.src = source.src;
      vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
      const controller = new VideoAiFullCaptureController({
        getVideo: () => video as unknown as HTMLVideoElement,
        getAudio: async () => null,
        getModel: () => 'tiny',
        isSupported: () => true,
        transcribe: async () => ({ text: 'unused' }),
        onTranscriptionComplete: async () => undefined,
        onError: vi.fn(),
        onStateChange: vi.fn(),
      });
      expect(controller.start()).toBe(true);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      controller.cancel();
      vi.unstubAllGlobals();
    }

    const emptySource = new FullFakeVideo();
    emptySource.currentSrc = '';
    emptySource.src = '';
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    const emptySourceController = new VideoAiFullCaptureController({
      getVideo: () => emptySource as unknown as HTMLVideoElement,
      getAudio: async () => null,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(emptySourceController.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    emptySourceController.cancel();
    vi.unstubAllGlobals();

    const noContext = new FullFakeVideo();
    vi.stubGlobal('window', {});
    const controller = new VideoAiFullCaptureController({
      getVideo: () => noContext as unknown as HTMLVideoElement,
      getAudio: async () => null,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    controller.cancel();
    vi.unstubAllGlobals();
  });

  it('支持 webkit AudioContext 和无有效视频时长的注入音频路径', async () => {
    const video = new FullFakeVideo();
    video.duration = 0;
    const completed = vi.fn(async () => undefined);
    const errors = vi.fn();
    vi.stubGlobal('window', { webkitAudioContext: FullFakeContext, setTimeout, clearTimeout });
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => new Float32Array(16_000).fill(0.04),
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'The webkit audio sentence.' }),
      onTranscriptionComplete: completed,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 16 && controller.getPhase() !== 'ready'; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('ready');
    expect(completed).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('无独立注入器时可用 createScanVideo 建立隐藏副本', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FullFakeVideo();
    const scanVideo = new FullFakeVideo();
    const documentStub = {
      createElement: () => scanVideo,
      documentElement: { appendChild: vi.fn() },
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'hidden copy sentence.' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    controller.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('隐藏副本等待 loadedmetadata 后继续，超时则清理并报错', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FullFakeVideo();
    sourceVideo.crossOrigin = 'anonymous';
    sourceVideo.srcObject = {} as MediaStream;
    const scanVideo = new FullFakeVideo();
    scanVideo.readyState = 0;
    const documentStub = {
      createElement: vi.fn(() => scanVideo),
      documentElement: { appendChild: vi.fn() },
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    scanVideo.readyState = 1;
    scanVideo.emit('loadedmetadata');
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    controller.cancel();

    const timeoutVideo = new FullFakeVideo();
    timeoutVideo.readyState = 0;
    documentStub.createElement = vi.fn(() => timeoutVideo);
    const timeoutController = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(timeoutController.start()).toBe(true);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    vi.advanceTimersByTime(2_500);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(timeoutController.getError()).toContain('超时');
    timeoutController.cancel();

    const errorVideo = new FullFakeVideo();
    errorVideo.readyState = 0;
    documentStub.createElement = vi.fn(() => errorVideo);
    const errorController = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(errorController.start()).toBe(true);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    errorVideo.emit('error');
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(errorController.getError()).toContain('加载');
    errorController.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('注入的 isolated video 返回 null 时回退到 createScanVideo', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FullFakeVideo();
    const scanVideo = new FullFakeVideo();
    const documentStub = {
      createElement: vi.fn(() => scanVideo),
      documentElement: { appendChild: vi.fn() },
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => null,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    controller.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('MediaElementSource 失败时回退 captureStream，并响应音轨 ended', async () => {
    vi.useFakeTimers();
    FullFakeContext.instances = [];
    FullFakeContext.mediaElementError = new Error('media element blocked');
    const sourceVideo = new FullFakeVideo();
    const scanVideo = new FullFakeVideo();
    sourceVideo.captureStream = () => new FullFakeMediaStream() as unknown as MediaStream;
    sourceVideo.srcObject = new FullFakeMediaStream([scanVideo.audioTrack]) as unknown as MediaStream;
    scanVideo.captureStream = () => new FullFakeMediaStream([scanVideo.audioTrack]) as unknown as MediaStream;
    const errors = vi.fn();
    vi.stubGlobal('MediaStream', FullFakeMediaStream);
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'fallback sentence is complete.' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('capturing');
    expect(scanVideo.listenerCount('ended')).toBe(1);
    sourceVideo.duration = 0;
    scanVideo.duration = 0;
    FullFakeContext.instances.at(-1)?.processor.emit(new Float32Array(16_000).fill(0.04));
    scanVideo.audioTrack.emitEnded();
    expect(controller.getError()).toContain('音轨');
    controller.cancel();
    expect(scanVideo.listenerCount('ended')).toBe(0);
    FullFakeContext.mediaElementError = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('隐藏副本 play 失败和超大播放头会清理图并停止采集', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FullFakeVideo();
    const scanVideo = new FullFakeVideo();
    scanVideo.playError = new Error('play blocked');
    scanVideo.pauseError = new Error('pause blocked');
    scanVideo.srcObjectError = new Error('readonly srcObject');
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const errors = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(controller.getError()).toContain('play blocked');
    controller.cancel();

    const overflowVideo = new FullFakeVideo();
    const overflowScan = new FullFakeVideo();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const overflow = new VideoAiFullCaptureController({
      getVideo: () => overflowVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => overflowScan as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(overflow.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    overflowScan.currentTime = 1_500_000;
    FullFakeContext.instances.at(-1)?.processor.emit(new Float32Array(100).fill(0.04));
    expect(errors).toHaveBeenCalled();
    overflow.cancel();

    FullFakeContext.processorError = new Error('processor blocked');
    const graphErrorVideo = new FullFakeVideo();
    const graphErrorScan = new FullFakeVideo();
    const graphError = new VideoAiFullCaptureController({
      getVideo: () => graphErrorVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => graphErrorScan as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(graphError.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(graphError.getError()).toContain('processor blocked');
    graphError.cancel();
    FullFakeContext.processorError = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('完整模式捕获到静音和跳过结果时进入错误态', async () => {
    const video = new FullFakeVideo();
    const make = (audio: Float32Array, result: Record<string, unknown>) => {
      vi.stubGlobal('window', { webkitAudioContext: FullFakeContext, setTimeout, clearTimeout });
      const errors = vi.fn();
      const controller = new VideoAiFullCaptureController({
        getVideo: () => video as unknown as HTMLVideoElement,
        getAudio: async () => audio,
        getModel: () => 'tiny',
        isSupported: () => true,
        transcribe: async () => result,
        onTranscriptionComplete: async () => undefined,
        onError: errors,
        onStateChange: vi.fn(),
      });
      return { controller, errors };
    };
    const silent = make(new Float32Array(16_000), { text: '' });
    expect(silent.controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(silent.controller.getError()).toContain('音频');
    vi.unstubAllGlobals();

    const skipped = make(new Float32Array(16_000).fill(0.04), { skipped: true });
    expect(skipped.controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(skipped.controller.getError()).toContain('跳过');
    vi.unstubAllGlobals();
  });

  it('翻译完成回调失败时转为完整识别错误并释放音频', async () => {
    const video = new FullFakeVideo();
    const errors = vi.fn();
    vi.stubGlobal('window', { webkitAudioContext: FullFakeContext, setTimeout, clearTimeout });
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => new Float32Array(16_000).fill(0.04),
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'The callback failure sentence.' }),
      onTranscriptionComplete: async () => { throw { failed: true }; },
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toBe('本地视频完整 AI 字幕失败');
    controller.cancel();
    vi.unstubAllGlobals();
  });

  it('字符串失败值也会经过统一错误归一化', async () => {
    const video = new FullFakeVideo();
    const errors = vi.fn();
    vi.stubGlobal('window', { webkitAudioContext: FullFakeContext, setTimeout, clearTimeout });
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => new Float32Array(16_000).fill(0.04),
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'The string failure sentence.' }),
      onTranscriptionComplete: async () => { throw 'string failure'; },
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toBe('string failure');
    controller.cancel();
    vi.unstubAllGlobals();
  });

  it('覆盖启动状态、取消回调、legacy 源和处理器边界', async () => {
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    const video = new FullFakeVideo();
    const invalidates = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'A complete state sentence.' }),
      onTranscriptionComplete: async () => undefined,
      onInvalidate: invalidates,
      onSessionStart: vi.fn(),
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.isActive()).toBe(false);
    expect(controller.start()).toBe(true);
    expect(controller.isActive()).toBe(true);
    expect(controller.start()).toBe(true);
    controller.cancel();
    expect(invalidates).toHaveBeenCalledWith('cancel', 1);

    const destroyInvalidate = vi.fn();
    const destroyController = new VideoAiFullCaptureController({
      getVideo: () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onInvalidate: destroyInvalidate,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(destroyController.start()).toBe(true);
    destroyController.destroy();
    expect(destroyInvalidate).toHaveBeenCalledWith('destroy', 1);

    const legacy = new FullFakeVideo();
    legacy.captureStream = undefined as unknown as () => MediaStream;
    legacy.mozCaptureStream = () => new FullFakeMediaStream() as unknown as MediaStream;
    const legacyController = new VideoAiFullCaptureController({
      getVideo: () => legacy as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(legacyController.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    legacyController.cancel();

    const emptyPcm = new FullFakeVideo();
    const emptyController = new VideoAiFullCaptureController({
      getVideo: () => emptyPcm as unknown as HTMLVideoElement,
      getAudio: async () => new Float32Array(),
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(emptyController.start()).toBe(true);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    emptyController.cancel();
    vi.unstubAllGlobals();
  });

  it('取消 getAudio 等待会让 startAudioGraph 丢弃已中止 session', async () => {
    let resolveAudio!: (audio: Float32Array | null) => void;
    const pendingAudio = new Promise<Float32Array | null>((resolve) => { resolveAudio = resolve; });
    const video = new FullFakeVideo();
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => pendingAudio,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    controller.cancel();
    resolveAudio(new Float32Array(16_000).fill(0.04));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('idle');
    vi.unstubAllGlobals();
  });

  it('resume 未完成时取消会丢弃旧 epoch，processor stale callback 与空 PCM 不写回', async () => {
    let resolveResume!: () => void;
    FullFakeContext.resumeGate = {
      promise: new Promise<void>((resolve) => { resolveResume = resolve; }),
      resolve: () => resolveResume(),
    };
    const video = new FullFakeVideo();
    const scan = new FullFakeVideo();
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, headers: { get: () => null } })));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scan as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: 'unused' }),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const context = FullFakeContext.instances.at(-1)!;
    const staleProcessor = context.processor.onaudioprocess;
    const staleEnded = scan.firstListener('ended');
    scan.currentTime = Number.NaN;
    staleProcessor?.({
      inputBuffer: {
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0.04]),
      },
    } as unknown as AudioProcessingEvent);
    staleProcessor?.({
      inputBuffer: {
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array(),
      },
    } as unknown as AudioProcessingEvent);
    controller.cancel();
    staleProcessor?.({
      inputBuffer: {
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array(),
      },
    } as unknown as AudioProcessingEvent);
    staleProcessor?.({
      inputBuffer: {
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array(),
      },
    } as unknown as AudioProcessingEvent);
    staleEnded?.();
    resolveResume();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(controller.getPhase()).toBe('idle');
    vi.unstubAllGlobals();
  });

  it('无独立 capture 源和空音轨都返回明确错误', async () => {
    vi.stubGlobal('MediaStream', FullFakeMediaStream);
    vi.stubGlobal('window', { AudioContext: FullFakeContext, setTimeout, clearTimeout });
    FullFakeContext.mediaElementError = new Error('blocked');
    const video = new FullFakeVideo();
    video.captureStream = undefined as unknown as () => MediaStream;
    const errors = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => null,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(controller.getError()).toContain('独立音频源');
    controller.cancel();

    FullFakeContext.mediaElementError = new Error('blocked');
    const noTracks = new FullFakeVideo();
    noTracks.captureStream = () => new FullFakeMediaStream() as unknown as MediaStream;
    const noTracksController = new VideoAiFullCaptureController({
      getVideo: () => noTracks as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(noTracksController.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(noTracksController.getError()).toContain('音轨');
    noTracksController.cancel();

    FullFakeContext.mediaStreamError = new Error('stream source blocked');
    const streamErrorVideo = new FullFakeVideo();
    streamErrorVideo.captureStream = () => new FullFakeMediaStream() as unknown as MediaStream;
    streamErrorVideo.srcObject = new FullFakeMediaStream([streamErrorVideo.audioTrack]) as unknown as MediaStream;
    const streamErrorController = new VideoAiFullCaptureController({
      getVideo: () => streamErrorVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => new FullFakeVideo() as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({ text: '' }),
      onTranscriptionComplete: async () => undefined,
      onError: errors,
      onStateChange: vi.fn(),
    });
    expect(streamErrorController.start()).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(streamErrorController.getError()).toContain('stream source blocked');
    streamErrorController.cancel();
    vi.unstubAllGlobals();
  });
});

describe('完整识别缓存恢复', () => {
  const cues = [{startMs: 400, durationMs: 1600, text: '오늘은 좋은 날입니다.'}];
  function fixture(complete = vi.fn().mockResolvedValue(undefined)) {
    const options = {
      getVideo: vi.fn(() => null), getModel: () => 'tiny', isSupported: vi.fn(() => true),
      getAudio: vi.fn(), transcribe: vi.fn(), onTranscriptionComplete: complete,
      onError: vi.fn(), onStateChange: vi.fn(), onProgress: vi.fn(), onSessionStart: vi.fn(), onInvalidate: vi.fn(),
    };
    return {controller: new VideoAiFullCaptureController(options), options};
  }
  it('只恢复原语言文本和时间轴，翻译完成后 ready，重复触发不读取音频或预热模型', async () => {
    const {controller, options} = fixture();
    expect(controller.restore(cues)).toBe(true);
    expect(controller.restore(cues)).toBe(true);
    expect(controller.getPhase()).toBe('translating');
    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(options.onTranscriptionComplete).toHaveBeenCalledOnce();
    expect(options.onTranscriptionComplete).toHaveBeenCalledWith([
      {startMs: 400, durationMs: 1600, text: cues[0].text, availableAtMs: 0, spokenEndMs: 2000},
    ], controller.getSessionId());
    expect(controller.getProgress()).toMatchObject({progress: 1, durationMs: 2000});
    expect(options.getVideo).not.toHaveBeenCalled();
    expect(options.getAudio).not.toHaveBeenCalled();
    expect(options.transcribe).not.toHaveBeenCalled();
    expect(options.onSessionStart).not.toHaveBeenCalled();
    controller.destroy();
  });
  it('空字幕和不支持的页面不能制造 ready 状态', () => {
    const {controller, options} = fixture();
    expect(controller.restore([])).toBe(false);
    options.isSupported.mockReturnValue(false);
    expect(controller.restore(cues)).toBe(false);
    expect(options.onTranscriptionComplete).not.toHaveBeenCalled();
    expect(controller.getPhase()).toBe('idle');
  });
  it('恢复期间取消后，迟到翻译成功和失败均不能回写', async () => {
    for (const reject of [false, true]) {
      let resolve!: () => void;
      let fail!: (error: Error) => void;
      const complete = vi.fn(() => new Promise<void>((yes, no) => {resolve = yes; fail = no;}));
      const {controller, options} = fixture(complete);
      controller.restore(cues);
      controller.cancel();
      if (reject) fail(new Error('late'));
      else resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(controller.getPhase()).toBe('idle');
      expect(options.onError).not.toHaveBeenCalled();
    }
  });
  it('缓存翻译失败进入可重试错误状态，不重复识别音频', async () => {
    const {controller, options} = fixture(vi.fn().mockRejectedValue(new Error('Translation unavailable')));
    controller.restore(cues);
    await vi.waitFor(() => expect(controller.getPhase()).toBe('error'));
    expect(controller.isRequested()).toBe(false);
    expect(controller.getError()).toBe('Translation unavailable');
    expect(options.transcribe).not.toHaveBeenCalled();
    options.onTranscriptionComplete.mockResolvedValue(undefined);
    expect(controller.restore(cues)).toBe(true);
    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    controller.destroy();
  });
});
