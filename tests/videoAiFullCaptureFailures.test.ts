import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {VideoAiFullCaptureController, type VideoAiFullCaptureProgress} from '@/src/features/video-subtitle/content/video-ai/fullCapture';
import type {VideoAiAudioChunk} from '@/src/features/video-subtitle/content/video-ai/fullCapture';
import type {VideoAiStabilizedCue} from '@/src/features/video-subtitle/content/video-ai/streamingTranscript';

class FakeNode {
  constructor(private readonly shouldThrow = false) {}
  connect(): this { return this; }
  disconnect(): void {
    if (this.shouldThrow) throw new Error('disconnect failed');
  }
}

class FakeProcessor extends FakeNode {
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

class FakeGain extends FakeNode {
  gain = {value: 1};
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static throwDisconnect = false;
  static throwDecode = false;
  static decodeResults: Array<AudioBuffer | Promise<AudioBuffer>> = [];
  static throwMediaElement = false;
  static decodeResult: {numberOfChannels: number; sampleRate: number; getChannelData: (index: number) => Float32Array} = {
    numberOfChannels: 1,
    sampleRate: 16_000,
    getChannelData: () => speechAudio(1_000),
  };
  readonly processor = new FakeProcessor(FakeAudioContext.throwDisconnect);
  readonly source = new FakeNode(FakeAudioContext.throwDisconnect);
  readonly gain = new FakeGain(FakeAudioContext.throwDisconnect);
  readonly destination = new FakeNode(FakeAudioContext.throwDisconnect);
  state: AudioContextState = 'running';

  constructor(readonly options?: AudioContextOptions) { FakeAudioContext.instances.push(this); }
  createMediaElementSource(): MediaElementAudioSourceNode {
    if (FakeAudioContext.throwMediaElement) throw new Error('media element blocked');
    return this.source as unknown as MediaElementAudioSourceNode;
  }
  createMediaStreamSource(): MediaStreamAudioSourceNode { return this.source as unknown as MediaStreamAudioSourceNode; }
  createScriptProcessor(): ScriptProcessorNode { return this.processor as unknown as ScriptProcessorNode; }
  createGain(): GainNode { return this.gain as unknown as GainNode; }
  async decodeAudioData(): Promise<AudioBuffer> {
    if (FakeAudioContext.throwDecode) throw new Error('decode failed');
    const next = FakeAudioContext.decodeResults.shift();
    if (next) return await next;
    return FakeAudioContext.decodeResult as unknown as AudioBuffer;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.state = 'closed'; }
}

class FakeVideo {
  currentSrc = 'blob:source';
  src = 'blob:source';
  duration = 10;
  paused = false;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  readyState = 1;
  crossOrigin = '';
  style = {cssText: ''};
  captureStream = () => new FakeMediaStream() as unknown as MediaStream;
  pauseCalls = 0;
  playCalls = 0;
  removed = false;
  throwOnPause = false;
  throwOnSrcObject = false;
  throwOnCurrentTime = false;
  private currentTimeValue = 0;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  get currentTime(): number { return this.currentTimeValue; }
  set currentTime(value: number) {
    if (this.throwOnCurrentTime) throw new Error('currentTime is read-only');
    this.currentTimeValue = value;
  }

  private srcObjectValue: unknown = null;
  get srcObject(): unknown { return this.srcObjectValue; }
  set srcObject(value: unknown) {
    if (this.throwOnSrcObject) throw new Error('srcObject is read-only');
    this.srcObjectValue = value;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) || new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  get metadataListenerCount(): number {
    return ['loadedmetadata', 'canplay', 'error'].reduce((sum, type) => sum + (this.listeners.get(type)?.size || 0), 0);
  }

  emit(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) || []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  setAttribute(): void {}
  load(): void {}
  pause(): void {
    this.pauseCalls += 1;
    if (this.throwOnPause) throw new Error('pause failed');
    this.paused = true;
  }
  async play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
  }
  remove(): void { this.removed = true; }
}

class FakeTrack {
  clone(): FakeTrack { return new FakeTrack(); }
  stop(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getAudioTracks(): FakeTrack[] { return this.tracks; }
  getTracks(): FakeTrack[] { return this.tracks; }
}

function installScanDom(scanVideo: FakeVideo): void {
  vi.stubGlobal('document', {
    createElement: () => scanVideo,
    documentElement: {appendChild: vi.fn()},
  });
  vi.stubGlobal('window', {
    AudioContext: FakeAudioContext,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 403})));
}

function installCustomAudioWindow(): void {
  vi.stubGlobal('window', {AudioContext: FakeAudioContext, setTimeout, clearTimeout});
}

async function tick(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function speechAudio(durationMs = 1_000): Float32Array {
  return new Float32Array(Math.round(durationMs * 16)).fill(0.04);
}

function makeInjectedController(options: {
  model?: 'tiny' | 'base' | 'small';
  audio?: Float32Array;
  transcribe?: (chunk: VideoAiAudioChunk) => Promise<Record<string, unknown>>;
  onComplete?: (cues: unknown[], session: number) => Promise<void>;
  onError?: (error: Error) => void;
  onProgress?: (progress: VideoAiFullCaptureProgress) => void;
  onInvalidate?: (reason: 'cancel' | 'error' | 'destroy', session: number) => void;
  onSessionStart?: (session: number) => void;
  onCuesProgress?: (cues: VideoAiStabilizedCue[], session: number) => void;
} = {}): VideoAiFullCaptureController {
  const video = new FakeVideo();
  return new VideoAiFullCaptureController({
    getVideo: () => video as unknown as HTMLVideoElement,
    getAudio: async () => options.audio || speechAudio(),
    getModel: () => options.model || 'tiny',
    isSupported: () => true,
    transcribe: options.transcribe || (async () => ({
      text: 'Injected complete sentence.',
      segments: [{startMs: 0, endMs: 900, text: 'Injected complete sentence.'}],
    })),
    onTranscriptionComplete: options.onComplete || (async () => undefined),
    onError: options.onError || vi.fn(),
    onStateChange: vi.fn(),
    onProgress: options.onProgress,
    onInvalidate: options.onInvalidate,
    onSessionStart: options.onSessionStart,
    onCuesProgress: options.onCuesProgress,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  FakeAudioContext.instances = [];
  FakeAudioContext.throwDisconnect = false;
  FakeAudioContext.throwDecode = false;
  FakeAudioContext.throwMediaElement = false;
  FakeAudioContext.decodeResults = [];
  FakeAudioContext.decodeResult = {
    numberOfChannels: 1,
    sampleRate: 16_000,
    getChannelData: () => speechAudio(1_000),
  };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('完整 AI 字幕失败与取消边界', () => {
  it.each(['setup-failure', 'cancel'] as const)('releases both fallback media streams even when AudioContext close rejects (%s)', async outcome => {
    vi.useFakeTimers();
    const scan = new FakeVideo(), visible = new FakeVideo(), track = new FakeTrack();
    visible.captureStream = () => new FakeMediaStream([track]) as unknown as MediaStream;
    installScanDom(scan); vi.stubGlobal('MediaStream', FakeMediaStream); FakeAudioContext.throwMediaElement = true;
    const stop = vi.spyOn(track, 'stop'), close = vi.spyOn(FakeAudioContext.prototype, 'close').mockRejectedValue(new Error('audio service already closed'));
    if (outcome === 'setup-failure') vi.spyOn(FakeAudioContext.prototype, 'createScriptProcessor').mockImplementationOnce(() => {throw new Error('processor disconnected');});
    const errors = vi.fn(), transcribe = vi.fn(async () => ({text: 'must not run'}));
    const controller = new VideoAiFullCaptureController({getVideo: () => visible as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scan as unknown as HTMLVideoElement, getModel: () => 'tiny', isSupported: () => true,
      transcribe, onTranscriptionComplete: vi.fn(async () => undefined), onError: errors, onStateChange: vi.fn()});
    controller.start(); await tick(80);
    if (outcome === 'setup-failure') {expect(controller.getPhase()).toBe('error'); expect(errors.mock.calls[0]?.[0].message).toContain('processor disconnected');}
    else {expect(controller.getPhase()).toBe('capturing'); controller.cancel();}
    await tick(); expect(stop).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce(); expect(scan.removed).toBe(true);
    expect(transcribe).not.toHaveBeenCalled(); controller.destroy(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['injected', 'decoded'] as const)('enforces the complete-audio duration limit when %s media metadata is absent', async source => {
    installScanDom(new FakeVideo());
    const video = new FakeVideo(); video.duration = Number.NaN;
    const overlong = new Float32Array(20 * 60 * 16_000 + 1);
    const getChannelData = vi.fn(() => overlong);
    FakeAudioContext.decodeResult = {numberOfChannels: 1, sampleRate: 16_000, getChannelData};
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4))));
    const transcribe = vi.fn(async () => ({text: 'must not transcribe oversized audio'}));
    const errors = vi.fn();
    const controller = new VideoAiFullCaptureController({getVideo: () => video as unknown as HTMLVideoElement,
      ...(source === 'injected' ? {getAudio: async () => overlong} : {}), getModel: () => 'tiny', isSupported: () => true,
      transcribe, onTranscriptionComplete: vi.fn(async () => undefined), onError: errors, onStateChange: vi.fn()});
    controller.start(); await tick(70);
    expect(controller.getPhase()).toBe('error');
    expect(errors.mock.calls[0]?.[0].message).toContain('20 分钟');
    expect(transcribe).not.toHaveBeenCalled();
    expect(video.playCalls).toBe(0);
    controller.destroy();
  });

  it.each(['success', 'decode-failure', 'decode-timeout'] as const)('does not let pending AudioContext closure block %s recovery', async outcome => {
    vi.useFakeTimers();
    const scan = new FakeVideo();
    installScanDom(scan);
    const visible = new FakeVideo(); visible.duration = 1;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4))));
    if (outcome === 'decode-failure') FakeAudioContext.throwDecode = true;
    if (outcome === 'decode-timeout') FakeAudioContext.decodeResults = [new Promise<AudioBuffer>(() => undefined)];
    let rejectClosure!: (reason: Error) => void;
    const close = vi.spyOn(FakeAudioContext.prototype, 'close').mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {rejectClosure = reject;}));
    const completed = vi.fn(async () => undefined);
    const controller = new VideoAiFullCaptureController({getVideo: () => visible as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'A complete decoded sentence.', segments: [{startMs: 0, endMs: 900, text: 'A complete decoded sentence.'}]}),
      onTranscriptionComplete: completed, onError: vi.fn(), onStateChange: vi.fn()});
    controller.start(); await tick(50);
    if (outcome === 'decode-timeout') await vi.advanceTimersByTimeAsync(8_000);
    await tick(50);
    expect(close).toHaveBeenCalled();
    if (outcome === 'success') {expect(completed).toHaveBeenCalledOnce(); expect(controller.getPhase()).toBe('ready');}
    else expect(scan.playCalls).toBe(1);
    expect(visible.playCalls).toBe(0);
    rejectClosure(new Error('late cleanup failure')); await tick();
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('后续窗口仍识别时先发布稳定字幕，回调修改不污染最终结果', async () => {
    installCustomAudioWindow();
    let resolveNext!: (value: Record<string, unknown>) => void;
    const nextWindow = new Promise<Record<string, unknown>>(resolve => { resolveNext = resolve; });
    const transcribe = vi.fn(async (chunk: VideoAiAudioChunk) => chunk.sequence === 1
      ? {text: 'The first complete sentence.', segments: [{startMs: 0, endMs: 3000, text: 'The first complete sentence.'}]}
      : nextWindow);
    const onComplete = vi.fn(async () => undefined);
    const onCuesProgress = vi.fn((cues: VideoAiStabilizedCue[], session: number) => {
      expect(session).toBe(1);
      expect(cues.every(cue => !cue.partial)).toBe(true);
      cues[0].text = 'External mutation.';
    });
    const controller = makeInjectedController({audio: speechAudio(20_000), transcribe, onComplete, onCuesProgress});
    expect(controller.start()).toBe(true);
    await tick(60);
    expect(onCuesProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(controller.getPhase()).toBe('transcribing');
    resolveNext({text: 'The following complete sentence.', segments: [{startMs: 2000, endMs: 4000, text: 'The following complete sentence.'}]});
    await tick(80);
    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onComplete.mock.calls)).not.toContain('External mutation');
  });

  it('逐窗字幕回调取消时不提交完成结果，也不再发布旧会话字幕', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    const onComplete = vi.fn(async () => undefined);
    const onCuesProgress = vi.fn(() => controller.cancel());
    controller = makeInjectedController({audio: speechAudio(20_000), onComplete, onCuesProgress});
    expect(controller.start()).toBe(true);
    await tick(80);
    expect(onCuesProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(controller.getPhase()).toBe('idle');
  });

  it('完整音频最终窗无标点仍发布完整字幕，不沿用实时前缀等待规则', async () => {
    installCustomAudioWindow();
    const onCuesProgress = vi.fn();
    const controller = makeInjectedController({audio: speechAudio(4000), onCuesProgress,
      transcribe: async () => ({text: 'The final sentence without punctuation', segments: [{startMs: 0, endMs: 3000, text: 'The final sentence without punctuation'}]})});
    expect(controller.start()).toBe(true);
    await tick(60);
    expect(controller.getPhase()).toBe('ready');
    expect(onCuesProgress).toHaveBeenCalledTimes(1);
    expect(onCuesProgress.mock.calls[0][0]).toEqual([expect.objectContaining({
      text: 'The final sentence without punctuation', partial: false,
    })]);
  });

  it.each(['base', 'small'] as const)('%s 识别空结果提示检查人声和原语言，不推荐已经使用的 Base', async model => {
    installCustomAudioWindow();
    const controller = makeInjectedController({model, transcribe: async () => ({text: '', segments: []})});
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toContain('清晰人声');
    expect(controller.getError()).toContain('视频原语言');
    expect(controller.getError()).not.toContain('Base');
    expect(controller.getError()).not.toContain('翻译失败');
  });

  it('没有可复制音源时清理副本，并吞掉 pause/srcObject 清理异常', async () => {
    const sourceVideo = new FakeVideo();
    sourceVideo.currentSrc = '';
    sourceVideo.src = '';
    const scanVideo = new FakeVideo();
    scanVideo.throwOnPause = true;
    scanVideo.throwOnSrcObject = true;
    installScanDom(scanVideo);

    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: ''}),
      onTranscriptionComplete: async () => undefined,
      onError,
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick();
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toContain('没有可复制的音频源');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scanVideo.removed).toBe(true);
  });

  it('隐藏副本 currentTime 不可写时继续工作，取消时吞掉音频图清理异常', async () => {
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.throwOnCurrentTime = true;
    scanVideo.throwOnPause = true;
    scanVideo.throwOnSrcObject = true;
    installScanDom(scanVideo);
    FakeAudioContext.throwDisconnect = true;

    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: ''}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick();
    expect(scanVideo.playCalls).toBe(1);
    expect(controller.getPhase()).toBe('capturing');
    controller.cancel();
    expect(controller.getPhase()).toBe('idle');
    expect(scanVideo.removed).toBe(true);
  });

  it('MediaElementSource 失败时使用克隆音轨，并清理 fallback stream', async () => {
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    sourceVideo.srcObject = new FakeMediaStream([new FakeTrack()]);
    installScanDom(scanVideo);
    vi.stubGlobal('MediaStream', FakeMediaStream);
    FakeAudioContext.throwMediaElement = true;

    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'unused'}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(20);
    expect(controller.getPhase()).toBe('capturing');
    controller.cancel();
    expect(controller.getPhase()).toBe('idle');
    expect(scanVideo.removed).toBe(true);
  });

  it('扫描副本加载期间取消后丢弃迟到的 loadedmetadata，并清理副本', async () => {
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.readyState = 0;
    installScanDom(scanVideo);
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'unused'}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(12);
    controller.cancel();
    scanVideo.readyState = 1;
    scanVideo.emit('loadedmetadata');
    await tick(12);
    expect(controller.getPhase()).toBe('idle');
    expect(scanVideo.removed).toBe(true);
  });

  it.each(['cancel', 'destroy'] as const)('扫描副本等待 metadata 时 %s 立即清理元素、监听器和加载 timer', async action => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.readyState = 0;
    installScanDom(scanVideo);
    const onError = vi.fn();
    const transcribe = vi.fn(async () => ({text: 'unused'}));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe, onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    await tick();
    expect(scanVideo.metadataListenerCount).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    controller[action]();
    await tick();
    expect.soft(scanVideo.removed).toBe(true);
    expect.soft(scanVideo.metadataListenerCount).toBe(0);
    expect.soft(vi.getTimerCount()).toBe(0);
    scanVideo.readyState = 1;
    scanVideo.emit('loadedmetadata');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(controller.getPhase()).toBe('idle');
    expect(onError).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it.each(['loadedmetadata', 'canplay', 'error', 'timeout'] as const)('扫描副本 metadata 等待通过 %s 结算后释放等待资源', async outcome => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.readyState = 0;
    installScanDom(scanVideo);
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    await tick();
    expect(scanVideo.metadataListenerCount).toBe(3);
    if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(2_499);
      expect(scanVideo.removed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    } else {
      if (outcome !== 'error') scanVideo.readyState = 1;
      scanVideo.emit(outcome);
      await tick();
    }
    expect(scanVideo.metadataListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'error' || outcome === 'timeout') {
      expect(controller.getPhase()).toBe('error');
      expect(controller.getError()).toContain(outcome === 'timeout' ? '加载 X 视频音频超时' : '无法加载 X 视频音频');
      expect(scanVideo.removed).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(FakeAudioContext.instances).toHaveLength(0);
    } else {
      expect(controller.getPhase()).toBe('capturing');
      expect(scanVideo.playCalls).toBe(1);
      expect(FakeAudioContext.instances).toHaveLength(1);
      expect(onError).not.toHaveBeenCalled();
      controller.cancel();
      expect(scanVideo.removed).toBe(true);
    }
  });

  it('metadata 已到达但尚未建图时停止，迟到 continuation 不创建音频图', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.readyState = 0;
    installScanDom(scanVideo);
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    controller.start();
    await tick();
    scanVideo.readyState = 1;
    scanVideo.emit('loadedmetadata');
    controller.cancel();
    await tick();
    expect(scanVideo.removed).toBe(true);
    expect(scanVideo.metadataListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('load 同步触发停止时不安装新的 metadata 监听或等待 timer', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    scanVideo.readyState = 0;
    installScanDom(scanVideo);
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    scanVideo.load = () => controller.cancel();
    controller.start();
    await tick();
    expect(scanVideo.removed).toBe(true);
    expect(scanVideo.metadataListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getPhase()).toBe('idle');
    expect(onError).not.toHaveBeenCalled();
  });

  it('停止慢速第三方副本请求后，迟到 null 不再创建隐藏扫描副本', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    const createElement = vi.spyOn(document, 'createElement');
    let resolveIsolated!: (video: HTMLVideoElement | null) => void;
    const isolated = new Promise<HTMLVideoElement | null>(resolve => {resolveIsolated = resolve;});
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: () => isolated,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    controller.start();
    await tick();
    controller.cancel();
    resolveIsolated(null);
    await tick();
    expect(createElement).not.toHaveBeenCalled();
    expect(scanVideo.playCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getPhase()).toBe('idle');
    expect(onError).not.toHaveBeenCalled();
  });

  it('第三方副本在停止后迟到返回时，仅清理旧副本且不建立音频图', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    let resolveIsolated!: (video: HTMLVideoElement) => void;
    const isolated = new Promise<HTMLVideoElement>(resolve => {resolveIsolated = resolve;});
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: () => isolated,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    controller.start();
    await tick();
    controller.cancel();
    resolveIsolated(scanVideo as unknown as HTMLVideoElement);
    await tick();
    expect(scanVideo.removed).toBe(true);
    expect(scanVideo.pauseCalls).toBe(1);
    expect(scanVideo.playCalls).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getPhase()).toBe('idle');
    expect(onError).not.toHaveBeenCalled();
  });

  it('metadata 等待中停止后立即重试，不叠加旧副本和加载 timer', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const firstScan = new FakeVideo();
    const nextScan = new FakeVideo();
    firstScan.readyState = nextScan.readyState = 0;
    installScanDom(firstScan);
    const createElement = vi.spyOn(document, 'createElement').mockReturnValueOnce(firstScan as unknown as HTMLElement).mockReturnValue(nextScan as unknown as HTMLElement);
    const onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async () => ({text: 'unused'}), onTranscriptionComplete: async () => undefined,
      onError, onStateChange: vi.fn(),
    });
    controller.start();
    await tick();
    controller.cancel();
    expect(controller.start()).toBe(true);
    await tick();
    expect(createElement).toHaveBeenCalledTimes(2);
    expect(firstScan.removed).toBe(true);
    expect(firstScan.metadataListenerCount).toBe(0);
    expect(nextScan.removed).toBe(false);
    expect(nextScan.metadataListenerCount).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    firstScan.readyState = 1;
    firstScan.emit('loadedmetadata');
    await tick();
    expect(FakeAudioContext.instances).toHaveLength(0);
    nextScan.readyState = 1;
    nextScan.emit('loadedmetadata');
    await tick();
    expect(controller.getPhase()).toBe('capturing');
    expect(nextScan.playCalls).toBe(1);
    expect(nextScan.removed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    controller.cancel();
    expect(nextScan.removed).toBe(true);
  });

  it('旧 session 返回被新 session 复用的 scan element 时不移除新图', async () => {
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    let resolveFirst!: (value: HTMLVideoElement) => void;
    const firstIsolated = new Promise<HTMLVideoElement>(resolve => { resolveFirst = resolve; });
    let isolatedCalls = 0;
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => {
        isolatedCalls += 1;
        return isolatedCalls === 1 ? firstIsolated : scanVideo as unknown as HTMLVideoElement;
      },
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'unused'}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(20);
    controller.cancel();
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(controller.getPhase()).toBe('capturing');
    resolveFirst(scanVideo as unknown as HTMLVideoElement);
    await tick(30);
    expect(scanVideo.removed).toBe(false);
    expect(controller.getPhase()).toBe('capturing');
    controller.cancel();
  });

  it('快速解码返回空 PCM 或抛出异常时回退到隐藏扫描路径', async () => {
    for (const decodeResult of [
      {numberOfChannels: 0, sampleRate: 16_000, getChannelData: () => new Float32Array()},
      null,
    ]) {
      const sourceVideo = new FakeVideo();
      const scanVideo = new FakeVideo();
      installScanDom(scanVideo);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
      if (decodeResult) {
        FakeAudioContext.decodeResult = decodeResult;
      } else {
        FakeAudioContext.throwDecode = true;
      }

      const controller = new VideoAiFullCaptureController({
        getVideo: () => sourceVideo as unknown as HTMLVideoElement,
        getModel: () => 'tiny',
        isSupported: () => true,
        transcribe: async () => ({text: 'unused'}),
        onTranscriptionComplete: async () => undefined,
        onError: vi.fn(),
        onStateChange: vi.fn(),
      });
      expect(controller.start()).toBe(true);
      await tick(20);
      expect(controller.getPhase()).toBe('capturing');
      controller.cancel();
      FakeAudioContext.throwDecode = false;
    }
  });

  it('快速解码读取期间取消时重新抛出取消错误并保持 idle', async () => {
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    let controller!: VideoAiFullCaptureController;
    const cancelBody = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        controller.cancel();
      },
      cancel: cancelBody,
    }, {highWaterMark: 0}))));
    controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'unused'}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    await tick(24);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('无 Content-Length 的 direct fallback 超过 48 MiB 时取消流，不读到 EOF 或进入解码', async () => {
    const sourceVideo = new FakeVideo();
    sourceVideo.currentSrc = sourceVideo.src = 'https://video.twimg.com/ext_tw_video/123/pu/vid/direct.mp4';
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    let produced = 0;
    let reachedEof = false;
    const cancelBody = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (produced === 64) {
          reachedEof = true;
          stream.close();
          return;
        }
        produced += 1;
        stream.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel: cancelBody,
    }, {highWaterMark: 0}));
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getAudio: async () => null,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(response.headers.has('content-length')).toBe(false);
    expect(controller.start()).toBe(true);
    await tick(180);
    expect(produced).toBe(49);
    expect(reachedEof).toBe(false);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(scanVideo.playCalls).toBe(1);
    expect(transcribe).not.toHaveBeenCalled();
    controller.cancel();
  });

  it.each([
    {name: '非成功状态', options: {status: 403}},
    {name: 'Content-Length 超过 48 MiB', options: {headers: {'content-length': String(49 * 1024 * 1024)}}},
  ])('快速解码提前拒绝 $name 时终止 fetch 和未消费响应体', async ({options}) => {
    installCustomAudioWindow();
    const pullBody = vi.fn();
    const cancelBody = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: pullBody,
      cancel: cancelBody,
    }, {highWaterMark: 0}), options);
    let fetchSignal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      // 模拟原生 fetch：中止传输会关闭尚未交给 reader 的响应体。
      fetchSignal.addEventListener('abort', () => { void response.body!.cancel(); }, {once: true});
      return response;
    }));
    const sourceVideo = new FakeVideo();
    const getIsolatedVideo = vi.fn(() => new Promise<HTMLVideoElement | null>(() => undefined));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'must not run'}),
      onTranscriptionComplete: async () => undefined,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(30);
    // 在扫描、用户取消或错误态清理发生前，fast path 自身必须释放传输。
    expect(getIsolatedVideo).toHaveBeenCalledTimes(1);
    expect(controller.getPhase()).toBe('capturing');
    expect(fetchSignal.aborted).toBe(true);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(pullBody).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(sourceVideo.pauseCalls).toBe(0);
    expect(sourceVideo.playCalls).toBe(0);
    controller.cancel();
  });

  it('流读取刚完成时取消，await 边界后的旧媒体不会创建解码 context', async () => {
    installCustomAudioWindow();
    const response = new Response(new Uint8Array(8));
    const body = response.body!;
    const getReader = body.getReader.bind(body);
    let controller!: VideoAiFullCaptureController;
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      const reader = getReader();
      const release = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        release();
        controller.cancel();
      };
      return reader;
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const sourceVideo = new FakeVideo();
    const onError = vi.fn();
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onError,
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(controller.getPhase()).toBe('idle');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('pending 原生解码取消立即关闭 context 并清除计时器，不启动扫描或发布结果', async () => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    const sourceVideo = new FakeVideo();
    sourceVideo.duration = 1;
    FakeAudioContext.decodeResults = [new Promise<AudioBuffer>(() => undefined)];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    const onComplete = vi.fn(async () => undefined);
    const onError = vi.fn();
    const getIsolatedVideo = vi.fn(async () => null);
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: onComplete,
      onError,
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(30);
    const context = FakeAudioContext.instances[0];
    expect(context.options).toEqual({sampleRate: 16_000});
    expect(context.state).toBe('running');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.cancel();
    await tick(30);
    expect(context.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getPhase()).toBe('idle');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(getIsolatedVideo).not.toHaveBeenCalled();
    expect(sourceVideo.pauseCalls).toBe(0);
    expect(sourceVideo.playCalls).toBe(0);
  });

  it.each([
    ['cancel', 'cancel-before-resolve'], ['cancel', 'resolve-then-cancel'],
    ['destroy', 'cancel-before-resolve'], ['destroy', 'resolve-then-cancel'],
  ] as const)('原生 decode %s / %s 后不再读取声道或复制 PCM', async (action, order) => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    let resolveDecode!: (value: AudioBuffer) => void;
    const decoded = new Promise<AudioBuffer>(resolve => {resolveDecode = resolve;});
    // 原生 API 直接返回 promise；避免 async 测试封装引入额外微任务、改变 race 的先后。
    const decode = vi.spyOn(FakeAudioContext.prototype, 'decodeAudioData').mockImplementation(() => decoded);
    const getChannelData = vi.fn(() => speechAudio(1_000));
    const speech = {numberOfChannels: 1, sampleRate: 16_000, getChannelData} as unknown as AudioBuffer;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    const video = new FakeVideo(); video.duration = 1;
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    const onComplete = vi.fn(async () => undefined), onError = vi.fn();
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement, getModel: () => 'tiny', isSupported: () => true,
      transcribe, onTranscriptionComplete: onComplete, onError, onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true); await tick(30);
    expect(decode).toHaveBeenCalledOnce();
    if (order === 'resolve-then-cancel') resolveDecode(speech);
    controller[action]();
    if (order === 'cancel-before-resolve') resolveDecode(speech);
    await tick(40);
    expect(getChannelData).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled(); expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled(); expect(controller.isRequested()).toBe(false);
    expect(FakeAudioContext.instances.every(context => context.state === 'closed')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    controller.destroy();
  });

  it('旧 session 的延迟快速解码返回不会覆盖 cancel + restart 后的新状态', async () => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    const sourceVideo = new FakeVideo();
    sourceVideo.duration = 1;
    const speech = {
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => speechAudio(1_000),
    } as unknown as AudioBuffer;
    let resolveFirst!: (value: AudioBuffer) => void;
    const firstDecode = new Promise<AudioBuffer>(resolve => { resolveFirst = resolve; });
    FakeAudioContext.decodeResults = [firstDecode, speech];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    const transcribe = vi.fn(async () => ({
      text: 'The restarted decode state survives.',
      segments: [{startMs: 0, endMs: 900, text: 'The restarted decode state survives.'}],
    }));
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onError: (error) => { throw error; },
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(20);
    const oldContext = FakeAudioContext.instances[0];
    controller.cancel();
    await tick(20);
    expect(oldContext.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.start()).toBe(true);
    await tick(40);
    expect(controller.getPhase()).toBe('ready');
    const progressBeforeLateDecode = controller.getProgress();
    resolveFirst(speech);
    await tick(40);
    expect(controller.getPhase()).toBe('ready');
    expect(controller.getProgress().phase).toBe(progressBeforeLateDecode.phase);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances.every(context => context.state === 'closed')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    controller.destroy();
  });

  it('fast decode capturing 进度同步取消时不会进入旧 finishCapture', async () => {
    installCustomAudioWindow();
    let now = 0;
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => { now += 300; return now; });
    const sourceVideo = new FakeVideo();
    sourceVideo.duration = 1;
    const speech = {
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => speechAudio(1_000),
    } as unknown as AudioBuffer;
    FakeAudioContext.decodeResults = [speech];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8))));
    let controller!: VideoAiFullCaptureController;
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onProgress: (progress) => {
        if (progress.phase === 'capturing' && progress.captureMode === 'fast-decode') controller.cancel();
      },
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(() => controller.start()).not.toThrow();
    await tick(40);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('识别完成但没有可读 cue 时进入错误态', async () => {
    installCustomAudioWindow();
    const onError = vi.fn();
    const controller = makeInjectedController({
      audio: speechAudio(),
      transcribe: async () => ({text: '', segments: []}),
      onError,
    });

    expect(controller.start()).toBe(true);
    await tick(40);
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toContain('没有识别出可读字幕');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('onTranscriptionComplete 取消后不会回到 ready 或再次写入结果', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    const onComplete = vi.fn(async () => {
      controller.cancel();
    });
    controller = makeInjectedController({onComplete});

    expect(controller.start()).toBe(true);
    await tick(40);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
  });

  it('首个转写窗口开始前取消时不会继续提交识别结果', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    controller = makeInjectedController({
      onProgress: (progress) => {
        if (progress.phase === 'transcribing' && progress.transcribedMs === 0) controller.cancel();
      },
    });
    expect(controller.start()).toBe(true);
    await tick(40);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
  });

  it('窗口完成回调前取消时不会进入翻译完成态', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    controller = makeInjectedController({
      onProgress: (progress) => {
        if (progress.phase === 'transcribing' && progress.transcribedMs > 0) controller.cancel();
      },
    });
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
  });

  it('translating 进度回调同步取消时不会调用完成回调', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    const onComplete = vi.fn(async () => undefined);
    controller = makeInjectedController({
      onProgress: (progress) => {
        if (progress.phase === 'translating') controller.cancel();
      },
      onComplete,
    });
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('idle');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('ready 进度回调同步取消时不会释放或通知旧 session 状态', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    const onStateChange = vi.fn();
    const sourceVideo = new FakeVideo();
    const controllerInstance = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getAudio: async () => speechAudio(),
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({
        text: 'Ready callback sentence.',
        segments: [{startMs: 0, endMs: 900, text: 'Ready callback sentence.'}],
      }),
      onTranscriptionComplete: async () => undefined,
      onProgress: (progress) => {
        if (progress.phase === 'ready') controller.cancel();
      },
      onError: (error) => { throw error; },
      onStateChange,
    });
    controller = controllerInstance;
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
  });

  it('初始进度回调同步取消时不会访问已清空的 abort controller', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    let firstProgress = true;
    controller = makeInjectedController({
      onProgress: () => {
        if (!firstProgress) return;
        firstProgress = false;
        controller.cancel();
      },
    });
    expect(() => controller.start()).not.toThrow();
    await tick(30);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.isRequested()).toBe(false);
  });

  it('onSessionStart 同步取消时不会继续调用音频读取器', async () => {
    installCustomAudioWindow();
    let controller!: VideoAiFullCaptureController;
    const getAudio = vi.fn(async () => speechAudio());
    controller = makeInjectedController({
      onSessionStart: () => controller.cancel(),
    });
    // Replace the injected reader through a direct controller to observe that
    // cancellation is checked before the optional audio source is awaited.
    controller = new VideoAiFullCaptureController({
      getVideo: () => new FakeVideo() as unknown as HTMLVideoElement,
      getAudio,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async () => ({text: 'unused'}),
      onTranscriptionComplete: async () => undefined,
      onSessionStart: () => controller.cancel(),
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(() => controller.start()).not.toThrow();
    await tick(30);
    expect(getAudio).not.toHaveBeenCalled();
    expect(controller.getPhase()).toBe('idle');
  });

  it('旧 session 的 finish finally 不会清空重启后的扫描 PCM', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    installScanDom(scanVideo);
    let audioCalls = 0;
    let transcribeCalls = 0;
    let resolveFirst!: (value: Record<string, unknown>) => void;
    const firstResult = new Promise<Record<string, unknown>>(resolve => { resolveFirst = resolve; });
    const chunks: VideoAiAudioChunk[] = [];
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getAudio: async () => {
        audioCalls += 1;
        return audioCalls === 1 ? speechAudio() : null;
      },
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe: async (chunk) => {
        transcribeCalls += 1;
        chunks.push(chunk);
        if (transcribeCalls === 1) return firstResult;
        return {text: 'The restarted scan survives.', segments: [{startMs: 0, endMs: 900, text: 'The restarted scan survives.'}]};
      },
      onTranscriptionComplete: async () => undefined,
      onError: (error) => { throw error; },
      onStateChange: vi.fn(),
    });

    expect(controller.start()).toBe(true);
    await tick(30);
    expect(transcribeCalls).toBe(1);
    controller.cancel();
    expect(controller.start()).toBe(true);
    await tick(30);
    const processor = FakeAudioContext.instances.at(-1)!.processor;
    scanVideo.currentTime = 9;
    processor.emit(speechAudio(9_000));
    resolveFirst({text: 'The old scan result.', segments: [{startMs: 0, endMs: 900, text: 'The old scan result.'}]});
    await tick(30);
    scanVideo.currentTime = 11;
    processor.emit(speechAudio(2_000));
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(80);

    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    const restartedChunk = chunks.find(chunk => chunk.sessionId === controller.getSessionId());
    expect(restartedChunk).toBeTruthy();
    expect(restartedChunk!.durationMs).toBeGreaterThanOrEqual(10_000);
    controller.destroy();
  });

  it('旧 session 的 queue 错误不会污染重启后的 fullTranscriptionError', async () => {
    installCustomAudioWindow();
    let transcribeCalls = 0;
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: Record<string, unknown>) => void;
    const firstResult = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectFirst = reject; });
    const secondResult = new Promise<Record<string, unknown>>(resolve => { resolveSecond = resolve; });
    const controller = makeInjectedController({
      transcribe: async () => {
        transcribeCalls += 1;
        return transcribeCalls === 1 ? firstResult : secondResult;
      },
      onError: (error) => { throw error; },
    });

    expect(controller.start()).toBe(true);
    await tick(30);
    controller.cancel();
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(transcribeCalls).toBe(2);
    rejectFirst(new Error('old session failed'));
    await tick(30);
    resolveSecond({text: 'The new session succeeds.', segments: [{startMs: 0, endMs: 900, text: 'The new session succeeds.'}]});
    await tick(60);
    expect(controller.getPhase()).toBe('ready');
    controller.destroy();
  });

  it('窗口识别失败时进入错误态并释放扫描资源', async () => {
    installCustomAudioWindow();
    const onError = vi.fn();
    const controller = makeInjectedController({
      transcribe: async () => { throw new Error('window failed'); },
      onError,
    });
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toContain('window failed');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('失败时回调当前 generation 的失效通知', async () => {
    installCustomAudioWindow();
    const onInvalidate = vi.fn();
    const controller = makeInjectedController({
      transcribe: async () => { throw new Error('invalidate me'); },
      onInvalidate,
    });
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('error');
    expect(onInvalidate).toHaveBeenCalledWith('error', expect.any(Number));
  });

  it('Worker 跳过窗口时给出可执行错误', async () => {
    installCustomAudioWindow();
    const onError = vi.fn();
    const controller = makeInjectedController({
      transcribe: async () => ({skipped: true}),
      onError,
    });
    expect(controller.start()).toBe(true);
    await tick(50);
    expect(controller.getPhase()).toBe('error');
    expect(controller.getError()).toContain('请求被跳过');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('完整 AI 字幕扫描窗口的暂停边界', () => {
  function makeScanController(scanVideo: FakeVideo, chunks: VideoAiAudioChunk[], model = 'tiny'): VideoAiFullCaptureController {
    const sourceVideo = new FakeVideo();
    sourceVideo.duration = scanVideo.duration;
    return new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => model,
      isSupported: () => true,
      transcribe: async (chunk) => {
        chunks.push(chunk);
        return {
          text: 'A complete scan sentence.',
          segments: [{startMs: 0, endMs: Math.min(chunk.durationMs, 900), text: 'A complete scan sentence.'}],
        };
      },
      onTranscriptionComplete: async () => undefined,
      onError: (error) => { throw error; },
      onStateChange: vi.fn(),
    });
  }

  it('扫描和识别并行时保持进度单调，扫描结束保留已完成窗口指标', async () => {
    vi.useFakeTimers();
    const sourceVideo = new FakeVideo();
    const scanVideo = new FakeVideo();
    sourceVideo.duration = scanVideo.duration = 20;
    installScanDom(scanVideo);
    let resolveFirst!: (result: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>(resolve => { resolveFirst = resolve; });
    let resolveNext!: (result: Record<string, unknown>) => void;
    const next = new Promise<Record<string, unknown>>(resolve => { resolveNext = resolve; });
    const controller = new VideoAiFullCaptureController({
      getVideo: () => sourceVideo as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny', isSupported: () => true,
      transcribe: async chunk => chunk.sequence === 1 ? first : next,
      onTranscriptionComplete: async () => undefined, onStateChange: vi.fn(),
      onError: error => { throw error; },
    });
    expect(controller.start()).toBe(true);
    await tick(20);
    const processor = FakeAudioContext.instances.at(-1)!.processor;
    scanVideo.currentTime = 12;
    processor.emit(speechAudio(12_000));
    await tick(20);
    const readProgress = controller.getProgress().progress;
    resolveFirst({text: 'The first scanned sentence.', segments: [{startMs: 0, endMs: 3000, text: 'The first scanned sentence.'}]});
    await tick(30);
    expect(controller.getProgress()).toMatchObject({phase: 'capturing', transcribedMs: 10_000, windowIndex: 1});
    expect(controller.getProgress().progress).toBeGreaterThanOrEqual(readProgress);
    scanVideo.currentTime = 20;
    processor.emit(speechAudio(8_000));
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(30);
    expect(controller.getProgress()).toMatchObject({phase: 'transcribing', transcribedMs: 10_000, windowIndex: 1});
    expect(controller.getProgress().progress).toBeGreaterThanOrEqual(.45);
    resolveNext({text: 'The next scanned sentence.', segments: [{startMs: 0, endMs: 1000, text: 'The next scanned sentence.'}]});
    await tick(80);
    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(controller.getProgress().progress).toBe(1);
  });

  it('在窗口后半段发现长暂停时切断窗口，并跳过不足 900ms 的静音尾部', async () => {
    vi.useFakeTimers();
    const scanVideo = new FakeVideo();
    scanVideo.duration = 10;
    installScanDom(scanVideo);
    const chunks: VideoAiAudioChunk[] = [];
    const controller = makeScanController(scanVideo, chunks);
    expect(controller.start()).toBe(true);
    await tick(20);

    scanVideo.currentTime = 10;
    const audio = speechAudio(10_000);
    audio.fill(0, 9 * 16_000);
    FakeAudioContext.instances.at(-1)!.processor.emit(audio);
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(50);

    expect(controller.getPhase()).toBe('ready');
    expect(chunks).toHaveLength(1);
    expect(Math.round(chunks[0].startMs)).toBe(0);
    expect(Math.round(chunks[0].durationMs)).toBe(9_500);
  });

  it('自然停顿后不足 900ms 的最后人声仍会送入识别，不能直接丢弃', async () => {
    vi.useFakeTimers();
    const scanVideo = new FakeVideo();
    scanVideo.duration = 10;
    installScanDom(scanVideo);
    const chunks: VideoAiAudioChunk[] = [];
    const controller = makeScanController(scanVideo, chunks);
    expect(controller.start()).toBe(true);
    await tick(20);
    scanVideo.currentTime = 10;
    const audio = speechAudio(10_000);
    audio.fill(0, 8800 * 16, 9600 * 16);
    FakeAudioContext.instances.at(-1)!.processor.emit(audio);
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(60);
    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(chunks.map(chunk => [chunk.startMs, chunk.durationMs])).toEqual([[0, 9200], [9200, 800]]);
    expect(chunks[1].pcm.length).toBe(800 * 16);
  });

  it('暂停边界后保留后续完整尾窗，并按新的绝对时间起点识别', async () => {
    vi.useFakeTimers();
    const scanVideo = new FakeVideo();
    scanVideo.duration = 11;
    installScanDom(scanVideo);
    const chunks: VideoAiAudioChunk[] = [];
    const controller = makeScanController(scanVideo, chunks);
    expect(controller.start()).toBe(true);
    await tick(20);

    scanVideo.currentTime = 11;
    const audio = speechAudio(11_000);
    audio.fill(0, 6 * 16_000, 7 * 16_000);
    FakeAudioContext.instances.at(-1)!.processor.emit(audio);
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(60);

    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(Math.round(chunks[0].startMs)).toBe(0);
    expect(Math.round(chunks[0].durationMs)).toBe(6_500);
    expect(Math.round(chunks[1].startMs)).toBe(6_500);
    expect(chunks.every((chunk) => chunk.durationMs > 0 && chunk.durationMs <= 10_000)).toBe(true);
  });

  it.each([
    ['tiny', [0, 8_800, 17_600], 10_000],
    ['base', [0, 12_800], 14_000],
    ['small', [0, 12_800], 14_000],
  ] as const)('%s 连续语音窗口保持 1.2 秒重叠步长，并覆盖最终尾部', async (model, starts, windowMs) => {
    vi.useFakeTimers();
    const scanVideo = new FakeVideo();
    scanVideo.duration = 20;
    installScanDom(scanVideo);
    const chunks: VideoAiAudioChunk[] = [];
    const controller = makeScanController(scanVideo, chunks, model);
    expect(controller.start()).toBe(true);
    await tick(20);

    scanVideo.currentTime = 20;
    FakeAudioContext.instances.at(-1)!.processor.emit(speechAudio(20_000));
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(80);

    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(chunks.map((chunk) => Math.round(chunk.startMs))).toEqual(expect.arrayContaining([...starts]));
    expect(Math.max(...chunks.map((chunk) => Math.round(chunk.durationMs)))).toBeLessThanOrEqual(windowMs);
    expect(Math.round(Math.max(...chunks.map((chunk) => chunk.startMs + chunk.durationMs)))).toBe(20_000);
    controller.destroy();
  });

  it('扫描进度回调同步取消时，后续 queue 入口会拒绝旧 session', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => { now += 300; return now; });
    const scanVideo = new FakeVideo();
    scanVideo.duration = 10;
    installScanDom(scanVideo);
    let controller!: VideoAiFullCaptureController;
    const transcribe = vi.fn(async () => ({text: 'must not run'}));
    controller = new VideoAiFullCaptureController({
      getVideo: () => new FakeVideo() as unknown as HTMLVideoElement,
      getIsolatedVideo: async () => scanVideo as unknown as HTMLVideoElement,
      getModel: () => 'tiny',
      isSupported: () => true,
      transcribe,
      onTranscriptionComplete: async () => undefined,
      onProgress: (progress) => {
        if (progress.phase === 'capturing' && progress.capturedMs > 0) controller.cancel();
      },
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    expect(controller.start()).toBe(true);
    await tick(20);
    scanVideo.currentTime = 10;
    FakeAudioContext.instances.at(-1)!.processor.emit(speechAudio(10_000));
    await tick(30);
    expect(controller.getPhase()).toBe('idle');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('多个音频块拼接时忽略窗口结束后的块，并继续完成尾窗', async () => {
    vi.useFakeTimers();
    const scanVideo = new FakeVideo();
    scanVideo.duration = 12.5;
    installScanDom(scanVideo);
    const chunks: VideoAiAudioChunk[] = [];
    const controller = makeScanController(scanVideo, chunks);
    expect(controller.start()).toBe(true);
    await tick(20);

    scanVideo.currentTime = 12.5;
    const processor = FakeAudioContext.instances.at(-1)!.processor;
    for (let index = 0; index < 5; index += 1) processor.emit(speechAudio(2_500));
    scanVideo.ended = true;
    scanVideo.emit('ended');
    vi.advanceTimersByTime(420);
    await tick(80);

    await vi.waitFor(() => expect(controller.getPhase()).toBe('ready'));
    expect(controller.getPhase()).toBe('ready');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    controller.destroy();
  });
});


describe('完整 AI 字幕的有界窗口生产', () => {
  type CopiedWindow = {pcm: Float32Array; startMs: number; endMs: number};
  function observeWindowCopies(controller: VideoAiFullCaptureController) {
    // 记录实际 PCM 分配边界，不将所有窗口另存一份用于断言。
    const boundary = controller as unknown as {createFullAudioWindowFromBlocks: (start: number, end: number) => CopiedWindow};
    const copy = boundary.createFullAudioWindowFromBlocks.bind(boundary);
    return vi.spyOn(boundary, 'createFullAudioWindowFromBlocks').mockImplementation(copy);
  }
  function pcmSha(pcm: Float32Array): string {
    return createHash('sha256').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  }
  async function settleYieldedWindows(controller: VideoAiFullCaptureController): Promise<void> {
    for (let index = 0; index < 200 && controller.getPhase() === 'transcribing'; index += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
  }

  it.each([
    ['tiny', 10_000, 8_800, 137, 87_244_800],
    ['base', 14_000, 12_800, 94, 83_942_400],
    ['small', 14_000, 12_800, 94, 83_942_400],
  ] as const)('%s 的 20 分钟全部窗口顺序和 PCM 不变，同时最多只保留两个窗副本', async (model, windowMs, stepMs, expectedCount, legacyCopiedBytes) => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    const source = speechAudio(1_200_000);
    let resolveFirst!: () => void;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const windows: Array<{startMs: number; durationMs: number; sequence: number; sha: string; bytes: number}> = [];
    let completed = 0;
    let peakCopiedBytes = 0;
    let copiedBytes = 0;
    const onComplete = vi.fn(async () => undefined);
    const onError = vi.fn();
    const video = new FakeVideo();
    video.duration = 1_200;
    const controller = new VideoAiFullCaptureController({
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudio: async () => source, getModel: () => model, isSupported: () => true,
      transcribe: async chunk => {
        windows.push({startMs: chunk.startMs, durationMs: chunk.durationMs, sequence: chunk.sequence,
          sha: pcmSha(chunk.pcm), bytes: chunk.pcm.byteLength});
        if (chunk.sequence === 1) await first;
        completed += 1;
        copiedBytes -= chunk.pcm.byteLength;
        const text = `Observation ${chunk.sequence} is complete.`;
        return {text, segments: [{startMs: 0, endMs: 900, text}]};
      },
      onTranscriptionComplete: onComplete, onError, onStateChange: vi.fn(),
    });
    const copies = observeWindowCopies(controller);
    const original = copies.getMockImplementation()!;
    copies.mockImplementation((start, end) => {
      const window = original(start, end);
      copiedBytes += window.pcm.byteLength;
      peakCopiedBytes = Math.max(peakCopiedBytes, copiedBytes);
      expect(copies.mock.calls.length - completed).toBeLessThanOrEqual(2);
      return window;
    });
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(windows).toHaveLength(1);
    expect(copies).toHaveBeenCalledTimes(2);
    expect(peakCopiedBytes).toBe(windowMs * 16 * 4 * 2);
    expect(onComplete).not.toHaveBeenCalled();
    resolveFirst();
    await tick(30);
    await settleYieldedWindows(controller);
    expect(controller.getPhase()).toBe('ready');
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(expectedCount);
    expect(windows.reduce((sum, window) => sum + window.bytes, 0)).toBe(legacyCopiedBytes);
    for (const [index, window] of windows.entries()) {
      const startMs = index * stepMs;
      const endMs = Math.min(startMs + windowMs, 1_200_000);
      expect(window).toMatchObject({startMs, durationMs: endMs - startMs, sequence: index + 1,
        sha: pcmSha(source.subarray(startMs * 16, endMs * 16))});
    }
    expect(peakCopiedBytes).toBe(windowMs * 16 * 4 * 2);
    expect(controller.getProgress()).toMatchObject({capturedMs: 1_200_000, transcribedMs: 1_200_000,
      windowIndex: expectedCount, windowCount: expectedCount, progress: 1});
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等待活动窗时取消立即清空预备 PCM，迟到结果不提交字幕或再复制窗口', async () => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    let resolveFirst!: (value: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>(resolve => { resolveFirst = resolve; });
    const onComplete = vi.fn(async () => undefined);
    const onPreview = vi.fn();
    const transcribe = vi.fn(() => first);
    const controller = makeInjectedController({audio: speechAudio(60_000), transcribe, onComplete, onCuesProgress: onPreview});
    const copies = observeWindowCopies(controller);
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(copies).toHaveBeenCalledTimes(2);
    const prepared = copies.mock.results[1].value as CopiedWindow;
    expect(prepared.pcm.length).toBe(160_000);
    controller.cancel();
    expect(prepared.pcm.length).toBe(0);
    resolveFirst({text: 'The cancelled result must not be published.'});
    await tick(30);
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.getPhase()).toBe('idle');
    expect(copies).toHaveBeenCalledTimes(2);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('页面可在两个识别窗口之间停止，取消会清除让出任务的 timer', async () => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    const transcribe = vi.fn(async () => ({text: 'The first complete sentence.'}));
    const onComplete = vi.fn(async () => undefined);
    const controller = makeInjectedController({audio: speechAudio(60_000), transcribe, onComplete});
    const copies = observeWindowCopies(controller);
    expect(controller.start()).toBe(true);
    await tick(30);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(copies).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    controller.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await tick(30);
    expect(controller.getPhase()).toBe('idle');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('后续窗失败可保留已发布预览，但不提交完整结果并释放预备窗', async () => {
    vi.useFakeTimers();
    installCustomAudioWindow();
    const onComplete = vi.fn(async () => undefined);
    const onPreview = vi.fn();
    const onError = vi.fn();
    const controller = makeInjectedController({audio: speechAudio(60_000), onComplete, onCuesProgress: onPreview, onError,
      transcribe: async chunk => {
        if (chunk.sequence > 1) throw new Error('The next window failed.');
        return {text: 'The first complete sentence.', segments: [{startMs: 0, endMs: 900, text: 'The first complete sentence.'}]};
      }});
    const copies = observeWindowCopies(controller);
    expect(controller.start()).toBe(true);
    await tick(30);
    await vi.advanceTimersByTimeAsync(1);
    await tick(30);
    expect(controller.getPhase()).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(copies).toHaveBeenCalledTimes(3);
    expect(copies.mock.results.every(result => result.value.pcm.length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
