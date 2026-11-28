import {afterEach, describe, expect, it, vi} from 'vitest';

const {cacheVideoAiQ4ModelFiles} = vi.hoisted(() => ({cacheVideoAiQ4ModelFiles: vi.fn(async () => undefined)}));
vi.mock('@/src/features/video-subtitle/offscreen/modelCache', () => ({cacheVideoAiQ4ModelFiles}));

import {
  normalizeVideoLocalTranscriptionModels,
  resampleToWhisperAudio,
} from '@/src/features/video-subtitle/transcription';
import {
  cancelLocalVideoTranscription,
  disposeLocalVideoTranscriber,
  prepareLocalVideoTranscriptionModel,
  transcribeLocalVideoAudio,
} from '@/src/features/video-subtitle/offscreen/transcription';
import {createVideoSubtitleBackgroundHandlers, releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';

type WorkerMessage = {requestId: number; type: string; device?: 'wasm'; model?: string; audio?: Float32Array};

class CoverageWorker {
  static instances: CoverageWorker[] = [];
  static postError: unknown = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  lastMessage?: WorkerMessage;
  terminated = false;

  constructor(public readonly url: string) {
    CoverageWorker.instances.push(this);
  }

  postMessage(message: WorkerMessage): void {
    if (CoverageWorker.postError !== null) throw CoverageWorker.postError;
    this.lastMessage = message;
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: Record<string, unknown>): void {
    this.onmessage?.({data: response} as MessageEvent);
  }
}

class CoverageAudioContext {
  static instances: CoverageAudioContext[] = [];
  static nextDecodeResult?: Promise<{numberOfChannels: number; sampleRate: number; getChannelData(index: number): Float32Array}>;
  state = 'running';
  decodeResult: Promise<{numberOfChannels: number; sampleRate: number; getChannelData(index: number): Float32Array}> = Promise.resolve({
    numberOfChannels: 1,
    sampleRate: 16_000,
    getChannelData: () => new Float32Array([0]),
  });
  closeError = false;

  constructor() {
    CoverageAudioContext.instances.push(this);
    if (CoverageAudioContext.nextDecodeResult) this.decodeResult = CoverageAudioContext.nextDecodeResult;
  }

  decodeAudioData(): Promise<{numberOfChannels: number; sampleRate: number; getChannelData(index: number): Float32Array}> {
    return this.decodeResult;
  }

  async close(): Promise<void> {
    this.state = 'closed';
    if (this.closeError) throw new Error('close failed');
  }
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function installWorker(options: {audio?: typeof CoverageAudioContext; getUrl?: boolean} = {}): void {
  vi.stubGlobal('Worker', CoverageWorker);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', {
    location: {href: 'chrome-extension://test/offscreen.html'},
    setTimeout,
    clearTimeout,
    ...(options.audio ? {AudioContext: options.audio} : {}),
  });
  if (options.getUrl) {
    vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://test/${path}`}});
  } else {
    vi.stubGlobal('chrome', undefined);
  }
}

function workerMessage(): WorkerMessage {
  const worker = CoverageWorker.instances.at(-1);
  expect(worker?.lastMessage).toBeTruthy();
  return worker!.lastMessage!;
}

afterEach(async () => {
  await cancelLocalVideoTranscription('coverage-stream');
  await cancelLocalVideoTranscription('legacy-video-stream');
  await cancelLocalVideoTranscription('warm-stream');
  await cancelLocalVideoTranscription('recovered-stream');
  await cancelLocalVideoTranscription('handoff-stream');
  disposeLocalVideoTranscriber();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  CoverageWorker.instances = [];
  CoverageWorker.postError = null;
  CoverageAudioContext.instances = [];
  CoverageAudioContext.nextDecodeResult = undefined;
  cacheVideoAiQ4ModelFiles.mockClear();
});

describe('video transcription public normalization branches', () => {
  it('normalizes empty and malformed configuration values', () => {
    expect(normalizeVideoLocalTranscriptionModels(null)).toEqual([]);
    expect(normalizeVideoLocalTranscriptionModels(['tiny', 1, 'base', 'tiny', null])).toEqual(['tiny', 'base']);
  });

  it('mixes, copies, and interpolates channels across rate and length edge cases', () => {
    const sameRate = new Float32Array([0.25, -0.5]);
    expect(resampleToWhisperAudio([sameRate], 16_000)).not.toBe(sameRate);
    expect(Array.from(resampleToWhisperAudio([sameRate], 0))).toEqual([0.25, -0.5]);
    expect(Array.from(resampleToWhisperAudio([new Float32Array([1, 0]), new Float32Array([0])], 8, 4)))
      .toEqual([0.5]);
    expect(Array.from(resampleToWhisperAudio([new Float32Array([1, 0]), new Float32Array([0, 1])], 8, 8)))
      .toEqual([0.5, 0.5]);
    expect(resampleToWhisperAudio([], 16_000)).toEqual(new Float32Array());
  });
});

describe('video transcription offscreen transport branches', () => {
  it('uses extension worker URLs and ignores late responses for unknown requests', async () => {
    installWorker({getUrl: true});
    const pending = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA==', model: 'tiny'});
    await tick();
    const worker = CoverageWorker.instances[0];
    worker.reply({requestId: 999, success: true});
    worker.reply({requestId: workerMessage().requestId, success: true, text: 'ok', segments: [], model: 'tiny'});
    await expect(pending).resolves.toMatchObject({text: 'ok'});
    expect(worker.url).toContain('videoTranscriptionWorker.js');
  });

  it('maps worker failures and postMessage errors to stable exceptions', async () => {
    installWorker();
    const failed = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const first = CoverageWorker.instances[0];
    first.reply({requestId: first.lastMessage!.requestId, success: false});
    await expect(failed).rejects.toThrow('本地视频 AI Worker 失败');
    await cancelLocalVideoTranscription('coverage-stream');

    const warm = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'warm-stream'});
    await tick();
    const second = CoverageWorker.instances.at(-1)!;
    second.onerror?.({message: ''} as ErrorEvent);
    await tick();
    const fallback = CoverageWorker.instances.at(-1)!;
    expect(second.terminated).toBe(true);
    expect(fallback).not.toBe(second);
    expect(fallback.lastMessage?.device).toBe('wasm');
    fallback.onerror?.({message: ''} as ErrorEvent);
    await expect(warm).rejects.toThrow('Worker 已停止');
    expect(fallback.terminated).toBe(true);
    expect(CoverageWorker.instances.at(-1)).toBe(fallback);
    await cancelLocalVideoTranscription('warm-stream');

    CoverageWorker.postError = 'wire failure';
    const postString = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await expect(postString).rejects.toThrow('wire failure');

    CoverageWorker.postError = {};
    const postObject = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await expect(postObject).rejects.toThrow('无法启动本地视频 AI Worker');
  });

  it('recreates the worker when the model changes and bounds oversized PCM', async () => {
    installWorker();
    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA==', model: 'tiny'});
    await tick();
    const firstWorker = CoverageWorker.instances[0];
    firstWorker.reply({requestId: firstWorker.lastMessage!.requestId, success: true, model: 'tiny', text: '', segments: []});
    await first;

    const oversizedBytes = new Uint8Array(30 * 16_000 * 2 + 2);
    const oversized = Buffer.from(oversizedBytes).toString('base64');
    const second = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: oversized, model: 'base'});
    await tick();
    expect(firstWorker.terminated).toBe(true);
    const secondWorker = CoverageWorker.instances.at(-1)!;
    expect(secondWorker.lastMessage!.audio).toHaveLength(30 * 16_000);
    secondWorker.reply({requestId: secondWorker.lastMessage!.requestId, success: true, model: 'base', backend: 'wasm', gpuInfo: 'gpu', inferenceMs: 1, audioDurationMs: 2, threads: 2, dtype: 'q8', text: 'bounded', segments: []});
    await expect(second).resolves.toMatchObject({text: 'bounded', backend: 'wasm', dtype: 'q8'});
  });

  it('supports legacy WebM decoding, closed contexts, and decode failures', async () => {
    installWorker({audio: CoverageAudioContext});
    CoverageAudioContext.nextDecodeResult = Promise.resolve({
      numberOfChannels: 2,
      sampleRate: 8,
      getChannelData: (index: number) => index === 0 ? new Float32Array([1, 0]) : new Float32Array([-1, 0]),
    });
    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'data:audio/webm;base64,AAAAAA==', model: 'tiny'});
    await tick();
    const created = CoverageAudioContext.instances[0];
    const worker = CoverageWorker.instances.at(-1)!;
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, model: 'tiny', text: 'legacy', segments: []});
    await expect(first).resolves.toMatchObject({text: 'legacy'});

    created.state = 'closed';
    CoverageAudioContext.nextDecodeResult = Promise.reject('decode string');
    const second = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    await tick();
    await expect(second).rejects.toThrow('音频解码失败：decode string');

    const syncThrow = vi.spyOn(CoverageAudioContext.prototype, 'decodeAudioData').mockImplementationOnce(() => {
      throw new Error('sync decode error');
    });
    await expect(transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='}))
      .rejects.toThrow('音频解码失败：sync decode error');
    syncThrow.mockRestore();

    vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout});
    const noDecoder = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    await expect(noDecoder).rejects.toThrow('没有可用的 Web Audio 解码器');
  });

  it('handles PCM validation, empty audio, and missing audio', async () => {
    installWorker();
    await expect(transcribeLocalVideoAudio({streamId: 'coverage-stream'})).rejects.toThrow('没有捕获到视频音频');
    await expect(transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AA=='})).rejects.toThrow('PCM 数据长度无效');

    const empty = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: ''});
    await expect(empty).rejects.toThrow('没有捕获到视频音频');

    const signed = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'data:audio/pcm;base64,AID/fw=='});
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    expect(Array.from(worker.lastMessage!.audio!)).toEqual([-1, 1]);
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: null, segments: null, model: 1, backend: 'other', gpuInfo: 1, inferenceMs: '1', audioDurationMs: null, threads: null, dtype: 'other'});
    await expect(signed).rejects.toThrow('视频 Worker转写响应消息格式无效');
  });

  it('rejects worker timeouts and decode timeouts', async () => {
    vi.useFakeTimers();
    installWorker({audio: CoverageAudioContext});
    const pending = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA==', model: 'tiny'});
    const pendingResult = expect(pending).rejects.toThrow('超过 11.2 秒');
    await tick();
    const firstWorker = CoverageWorker.instances.at(-1)!;
    await vi.advanceTimersByTimeAsync(20_800);
    const fallback = CoverageWorker.instances.at(-1)!;
    expect(firstWorker.terminated).toBe(true);
    expect(fallback).not.toBe(firstWorker);
    expect(fallback.lastMessage?.device).toBe('wasm');
    await vi.advanceTimersByTimeAsync(11_199);
    expect(fallback.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pendingResult;
    expect(fallback.terminated).toBe(true);
    expect(CoverageWorker.instances.at(-1)).toBe(fallback);
    await cancelLocalVideoTranscription('coverage-stream');

    CoverageAudioContext.nextDecodeResult = new Promise(() => undefined);
    const decode = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    const decodeResult = expect(decode).rejects.toThrow('音频解码失败：音频解码超过 8 秒');
    await vi.advanceTimersByTimeAsync(8_000);
    await decodeResult;
    await cancelLocalVideoTranscription('coverage-stream');
    const recovered = transcribeLocalVideoAudio({streamId: 'recovered-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const recoveredWorker = CoverageWorker.instances.at(-1)!;
    recoveredWorker.reply({requestId: recoveredWorker.lastMessage!.requestId, success: true, text: 'recovered', segments: []});
    await expect(recovered).resolves.toMatchObject({text: 'recovered'});
  });

  it('caches cold models, rejects stream conflicts, and cancels queued prepare jobs', async () => {
    installWorker();
    await expect(prepareLocalVideoTranscriptionModel('base')).resolves.toMatchObject({model: 'base', dtype: 'q4'});
    expect(cacheVideoAiQ4ModelFiles).toHaveBeenCalledWith('base', undefined, {preference: 'auto'});
    // 预下载把调用方的进度回调原样交给模型缓存。
    const onProgress = vi.fn();
    await prepareLocalVideoTranscriptionModel('tiny', {onProgress});
    expect(cacheVideoAiQ4ModelFiles).toHaveBeenLastCalledWith('tiny', onProgress, {preference: 'auto'});

    const warm = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'warm-stream'});
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, model: 'tiny', backend: 'other', gpuInfo: 'gpu', threads: 1, dtype: 'other'});
    await expect(warm).resolves.toEqual({model: 'tiny', backend: undefined, gpuInfo: 'gpu', threads: 1, dtype: undefined});
    await cancelLocalVideoTranscription('warm-stream');

    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    await expect(prepareLocalVideoTranscriptionModel('base', {keepWarm: true, streamId: 'warm-stream'})).rejects.toThrow('另一个标签页');
    await cancelLocalVideoTranscription('coverage-stream');
    await expect(first).rejects.toThrow('取消');

    const queued = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'warm-stream'});
    await cancelLocalVideoTranscription('warm-stream');
    await expect(queued).rejects.toThrow('已取消');
  });
});

describe('video transcription background ownership races', () => {
  const context = (tabId: number) => ({sender: {tab: {id: tabId}}});
  const handler = (handlers: readonly {type: string; handle: (...args: any[]) => any}[], type: string) => handlers.find((item) => item.type === type)!;

  it('releases an exact failed warm owner and runs closeWhenIdle on cancellation', async () => {
    let failWarm = true;
    const closeWhenIdle = vi.fn(async () => undefined);
    const offscreen = {
      send: vi.fn(async (message: any) => message.type === 'VIDEO_AI_PREPARE' && failWarm ? {success: false, error: 'warm failed'} : {success: true, model: 'tiny'}),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)} as any;
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage, closeWhenIdle});
    const prepare = handler(handlers, 'fluentReadPrepareLocalVideoModel');
    const cancel = handler(handlers, 'fluentReadCancelLocalVideoTranscription');
    await expect(prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 1}, context(1)))
      .resolves.toMatchObject({success: false});
    failWarm = false;
    await expect(prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 1}, context(2)))
      .resolves.toMatchObject({success: true});
    await cancel.handle({streamId: 'warm-stream', generation: 1}, context(2));
    expect(closeWhenIdle).toHaveBeenCalledTimes(1);
  });

  it('reserves newer generations before awaiting cancellation and rejects the old result', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
    const offscreen = {
      send: vi.fn((message: any) => message.streamId.endsWith(':1') ? firstResponse : Promise.resolve({success: true, text: 'new'})),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)} as any;
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
    const transcribe = handler(handlers, 'fluentReadTranscribeLocalVideoAudio');
    const first = transcribe.handle({streamId: 'race', generation: 1, audioPcm16Base64: 'AAAAAA=='}, context(1));
    await tick();
    const second = transcribe.handle({streamId: 'race', generation: 2, audioPcm16Base64: 'AAAAAA=='}, context(1));
    await tick();
    resolveFirst({success: true, text: 'old'});
    await expect(first).rejects.toThrow('generation 已取消');
    await expect(second).resolves.toMatchObject({success: true, text: 'new'});
    expect(offscreen.sendIfPresent).toHaveBeenCalledWith(
      {type: 'VIDEO_AI_CANCEL', streamId: 'tab:1:race:generation:1'},
      {timeoutMs: 5_000},
    );
  });

  it('releases transport failures and accepts messages without a tab sender', async () => {
    releaseVideoSubtitleOwnerForTab(-1);
    const failingOffscreen = {
      send: vi.fn(async () => { throw new Error('offscreen unavailable'); }),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)};
    const failingHandlers = createVideoSubtitleBackgroundHandlers({offscreen: failingOffscreen, storage});
    await expect(handler(failingHandlers, 'fluentReadTranscribeLocalVideoAudio')
      .handle({streamId: 'failure', generation: 1, audioPcm16Base64: 'AAAAAA=='}, {}))
      .rejects.toThrow('offscreen unavailable');

    const succeedingOffscreen = {
      send: vi.fn(async () => ({success: true, text: 'ok'})),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const succeedingHandlers = createVideoSubtitleBackgroundHandlers({offscreen: succeedingOffscreen, storage});
    await expect(handler(succeedingHandlers, 'fluentReadTranscribeLocalVideoAudio')
      .handle({streamId: 'failure', generation: 1, audioPcm16Base64: 'AAAAAA=='}, {}))
      .resolves.toMatchObject({success: true});

    const warmFailingOffscreen = {
      send: vi.fn(async () => { throw new Error('warm unavailable'); }),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const warmFailingHandlers = createVideoSubtitleBackgroundHandlers({offscreen: warmFailingOffscreen, storage});
    await expect(handler(warmFailingHandlers, 'fluentReadPrepareLocalVideoModel')
      .handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 1}, context(1)))
      .rejects.toThrow('warm unavailable');
  });

  it('cancels a previous warm generation before starting its replacement', async () => {
    const offscreen = {
      send: vi.fn(async () => ({success: true, model: 'tiny', backend: 'wasm'})),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)};
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
    const prepare = handler(handlers, 'fluentReadPrepareLocalVideoModel');
    await prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 1}, context(1));
    await expect(prepare.handle({model: 'base', keepWarm: true, streamId: 'warm-stream', generation: 2}, context(1)))
      .resolves.toMatchObject({success: true, model: 'base'});
    expect(offscreen.sendIfPresent).toHaveBeenCalledWith(
      {type: 'VIDEO_AI_CANCEL', streamId: 'tab:1:warm-stream:generation:1'},
      {timeoutMs: 5_000},
    );
  });

  it('shares an exact reservation for same-generation prepare and transcription', async () => {
    const response = {success: true, model: 'tiny', backend: 'wasm'};
    const offscreen = {
      send: vi.fn(async (message: any) => message.type === 'VIDEO_AI_PREPARE' ? response : {success: true, text: 'ok'}),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)} as any;
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
    const prepare = handler(handlers, 'fluentReadPrepareLocalVideoModel');
    const transcribe = handler(handlers, 'fluentReadTranscribeLocalVideoAudio');
    const warm = prepare.handle({model: 'tiny', keepWarm: true, streamId: 'same', generation: 1}, context(1));
    const audio = transcribe.handle({model: 'tiny', streamId: 'same', generation: 1, audioPcm16Base64: 'AAAAAA=='}, context(1));
    await expect(warm).resolves.toMatchObject({success: true});
    await expect(audio).resolves.toMatchObject({success: true, text: 'ok'});
    await expect(prepare.handle({model: 'tiny', keepWarm: true, streamId: 'same', generation: 1}, context(1)))
      .resolves.toMatchObject({success: true});
  });

  it('releases completed ownership without canceling the idle worker', async () => {
    const offscreen = {
      send: vi.fn(async () => ({success: true, model: 'tiny', backend: 'wasm'})),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)} as any;
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
    const prepare = handler(handlers, 'fluentReadPrepareLocalVideoModel');
    const cancel = handler(handlers, 'fluentReadCancelLocalVideoTranscription');
    await prepare.handle({model: 'tiny', keepWarm: true, streamId: 'done', generation: 1}, context(1));
    await expect(cancel.handle({streamId: 'done', generation: 1, reason: 'complete'}, context(1)))
      .resolves.toEqual({success: true, completed: true});
    expect(offscreen.sendIfPresent).toHaveBeenCalledWith(
      {type: 'VIDEO_AI_CANCEL', streamId: 'tab:1:done:generation:1', reason: 'complete'},
      {timeoutMs: 5_000},
    );
    await expect(prepare.handle({model: 'tiny', keepWarm: true, streamId: 'new', generation: 1}, context(2)))
      .resolves.toMatchObject({success: true});
    await expect(prepare.handle({model: 'tiny', keepWarm: true, streamId: 'done', generation: 1}, context(1)))
      .rejects.toThrow('generation 已取消');
    const stale = await cancel.handle({streamId: 'done', generation: 1}, context(1));
    expect(stale).toEqual({success: true, stale: true});
    expect(offscreen.sendIfPresent).toHaveBeenCalledTimes(1);
  });

  it('cancels warm preparation while response, read, or write is pending', async () => {
    const context = (tabId: number) => ({sender: {tab: {id: tabId}}});
    const defer = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return {promise, resolve};
    };
    const cancelResponse = defer<unknown>();
    const offscreen = {
      send: vi.fn(() => cancelResponse.promise),
      sendIfPresent: vi.fn(async () => ({success: true})),
    } as any;
    const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)} as any;
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
    const prepare = handler(handlers, 'fluentReadPrepareLocalVideoModel');
    const cancel = handler(handlers, 'fluentReadCancelLocalVideoTranscription');
    const responsePending = prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 1}, context(1));
    await cancel.handle({streamId: 'warm-stream', generation: 1}, context(1));
    cancelResponse.resolve({success: true, model: 'tiny'});
    await expect(responsePending).rejects.toThrow('generation 已取消');

    const readPending = defer<Record<string, unknown>>();
    offscreen.send.mockResolvedValue({success: true, model: 'tiny'});
    storage.get.mockReturnValueOnce(readPending.promise);
    const readRequest = prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 2}, context(1));
    await tick();
    await cancel.handle({streamId: 'warm-stream', generation: 2}, context(1));
    readPending.resolve({});
    await expect(readRequest).rejects.toThrow('generation 已取消');

    const writePending = defer<void>();
    storage.get.mockResolvedValueOnce({});
    storage.set.mockReturnValueOnce(writePending.promise);
    const writeRequest = prepare.handle({model: 'tiny', keepWarm: true, streamId: 'warm-stream', generation: 3}, context(1));
    await tick();
    await cancel.handle({streamId: 'warm-stream', generation: 3}, context(1));
    writePending.resolve();
    await expect(writeRequest).rejects.toThrow('generation 已取消');
  });
});

describe('video transcription offscreen lifecycle branches', () => {
  it('bounds decoded legacy audio with a copied transfer buffer', async () => {
    installWorker({audio: CoverageAudioContext});
    const maxSamples = 30 * 16_000;
    CoverageAudioContext.nextDecodeResult = Promise.resolve({
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array(maxSamples + 1),
    });
    const pending = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    expect(worker.lastMessage!.audio).toHaveLength(maxSamples);
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: 'bounded', segments: []});
    await expect(pending).resolves.toMatchObject({text: 'bounded'});
  });

  it('handles empty PCM, legacy stream IDs, queued cancellation, and idle disposal', async () => {
    vi.useFakeTimers();
    installWorker();
    const empty = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'data:audio/pcm;base64,'});
    await expect(empty).resolves.toMatchObject({text: '', segments: [], audioDurationMs: 0});
    await cancelLocalVideoTranscription(null);
    await cancelLocalVideoTranscription('coverage-stream');

    const request: {audioPcm16Base64: string; streamId?: string} = {audioPcm16Base64: 'AAAAAA=='};
    const legacy = transcribeLocalVideoAudio(request);
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    expect(request.streamId).toBe('legacy-video-stream');
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: 'legacy', segments: []});
    await expect(legacy).resolves.toMatchObject({text: 'legacy'});
    await cancelLocalVideoTranscription('legacy-video-stream');

    const active = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const queued = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'coverage-stream'});
    await cancelLocalVideoTranscription('coverage-stream');
    await expect(queued).rejects.toThrow('已取消');
    await expect(active).rejects.toThrow('取消');

    const disposable = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const disposableWorker = CoverageWorker.instances.at(-1)!;
    disposableWorker.reply({requestId: disposableWorker.lastMessage!.requestId, success: true, text: '', segments: []});
    await disposable;
    await vi.advanceTimersByTimeAsync(120_000);
    await tick();
    expect(disposableWorker.terminated).toBe(true);
  });

  it('continues past unrelated queued preparation jobs during cancellation', async () => {
    installWorker();
    const active = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const cached = prepareLocalVideoTranscriptionModel('base');
    const warm = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'coverage-stream'});
    await cancelLocalVideoTranscription('coverage-stream');
    await expect(warm).rejects.toThrow('已取消');
    await expect(active).rejects.toThrow('取消');
    await expect(cached).resolves.toMatchObject({model: 'base', dtype: 'q4'});
  });

  it('keeps cache preparation queued behind active transcription', async () => {
    installWorker();
    const active = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const queued = prepareLocalVideoTranscriptionModel('base');
    const worker = CoverageWorker.instances.at(-1)!;
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: 'active', segments: []});
    await expect(active).resolves.toMatchObject({text: 'active'});
    await expect(queued).resolves.toMatchObject({model: 'base', dtype: 'q4'});
  });

  it('guards duplicate idle disposal while the first close is pending', async () => {
    vi.useFakeTimers();
    installWorker({audio: CoverageAudioContext});
    let resolveClose!: () => void;
    const closePending = new Promise<void>((resolve) => { resolveClose = resolve; });
    vi.stubGlobal('window', {
      location: {href: 'chrome-extension://test/offscreen.html'},
      setTimeout,
      clearTimeout: vi.fn(),
      AudioContext: CoverageAudioContext,
    });
    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    await tick();
    CoverageAudioContext.instances.at(-1)!.close = async () => closePending;
    const firstWorker = CoverageWorker.instances.at(-1)!;
    firstWorker.reply({requestId: firstWorker.lastMessage!.requestId, success: true, text: '', segments: []});
    await first;
    const second = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioBase64: 'AAAAAA=='});
    await tick();
    const secondWorker = CoverageWorker.instances.at(-1)!;
    secondWorker.reply({requestId: secondWorker.lastMessage!.requestId, success: true, text: '', segments: []});
    await second;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(firstWorker.terminated || secondWorker.terminated).toBe(true);
    resolveClose();
    await tick();
  });

  it('releases a completed stream while retaining the warm worker for handoff', async () => {
    installWorker();
    const prepared = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'coverage-stream'});
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, model: 'tiny', backend: 'wasm'});
    await expect(prepared).resolves.toMatchObject({model: 'tiny'});
    await cancelLocalVideoTranscription('coverage-stream', 'complete');
    expect(worker.terminated).toBe(false);

    const recovered = transcribeLocalVideoAudio({streamId: 'handoff-stream', audioPcm16Base64: 'AAAAAA==', model: 'tiny'});
    await tick();
    expect(CoverageWorker.instances).toHaveLength(1);
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: 'handoff', segments: []});
    await expect(recovered).resolves.toMatchObject({text: 'handoff'});
  });

  it('does not release a stream while a transcription request is still pending', async () => {
    installWorker();
    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const second = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    const secondResult = expect(second).resolves.toMatchObject({skipped: true});
    await cancelLocalVideoTranscription('coverage-stream', 'complete');
    await cancelLocalVideoTranscription('coverage-stream');
    await expect(first).rejects.toThrow('取消');
    await secondResult;
  });

  it('does not release a stream when its queued transcription is behind preparation', async () => {
    installWorker();
    const first = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    await tick();
    const worker = CoverageWorker.instances.at(-1)!;
    worker.reply({requestId: worker.lastMessage!.requestId, success: true, text: 'warm', segments: []});
    await first;

    const cached = prepareLocalVideoTranscriptionModel('base');
    const pending = transcribeLocalVideoAudio({streamId: 'coverage-stream', audioPcm16Base64: 'AAAAAA=='});
    const pendingResult = expect(pending).resolves.toMatchObject({skipped: true});
    await cancelLocalVideoTranscription('coverage-stream', 'complete');
    await cancelLocalVideoTranscription('coverage-stream');
    await expect(cached).resolves.toMatchObject({model: 'base', dtype: 'q4'});
    await pendingResult;
  });
});
