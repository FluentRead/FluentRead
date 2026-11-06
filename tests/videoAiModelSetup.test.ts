import {describe, expect, it, vi} from 'vitest';

import {createVideoAiModelSetup, type VideoAiModelSetupDependencies} from '@/src/features/video-subtitle/content/video-ai/modelSetup';
import {LOCAL_VIDEO_MODEL_DOWNLOAD_ERROR} from '@/src/features/video-subtitle/content/localModelReadiness';
import type {VideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
}

function setup(overrides: Partial<VideoAiModelSetupDependencies> & {responses?: Record<string, unknown[]>} = {}) {
  let configured: VideoLocalTranscriptionModel = 'tiny';
  let current = true;
  const events: string[] = [];
  const responses = overrides.responses ?? {};
  const sendMessage = vi.fn(async (message: {type: string}) => {
    const next = responses[message.type]?.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const dependencies: VideoAiModelSetupDependencies = {
    sendMessage,
    getConfiguredModel: () => configured,
    captureRequest: () => () => current,
    persistModel: vi.fn((model) => { configured = model; }),
    startGeneration: vi.fn(() => events.push('start')),
    setError: vi.fn((message) => events.push(`error:${message}`)),
    formatDownloadError: (message) => `下载失败：${message}`,
    watchDownload: vi.fn(() => () => undefined),
    onChange: vi.fn(),
    ...overrides,
  };
  const controller = createVideoAiModelSetup(dependencies);
  return {
    controller, dependencies, events, sendMessage,
    configure: (model: VideoLocalTranscriptionModel) => { configured = model; },
    invalidate: () => { current = false; },
  };
}

describe('video AI model setup', () => {
  it('closing the initial model prompt removes the choice without starting a download', async () => {
    const {controller, dependencies, sendMessage} = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: []}]}});
    await controller.request(() => true);
    expect(controller.choice).not.toBeNull();
    controller.cancel();
    expect(controller.choice).toBeNull();
    await controller.confirm();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
  });

  it('switching videos resets a pending check without letting its result change the new check', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let calls = 0;
    const {controller, dependencies} = setup({sendMessage: vi.fn(() => ++calls === 1 ? first.promise : second.promise)});
    const a = controller.request(() => true);
    controller.reset();
    expect(controller.checking).toBe(false);
    const b = controller.request(() => true);
    first.resolve({success: true, models: ['tiny']});
    await a;
    expect(controller.checking).toBe(true);
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
    second.resolve({success: true, models: ['tiny']});
    await b;
    expect(controller.checking).toBe(false);
    expect(dependencies.startGeneration).toHaveBeenCalledTimes(1);
  });

  it('switching videos during the first download leaves the new video usable and ignores the old completion', async () => {
    const download = deferred<unknown>();
    const {controller, dependencies} = setup({sendMessage: vi.fn((message: {type: string}) =>
      message.type === 'fluentReadPrepareLocalVideoModel' ? download.promise : Promise.resolve({success: true, models: []}))});
    await controller.request(() => true);
    const a = controller.confirm();
    expect(controller.downloading).toBe(true);
    controller.reset();
    expect(controller.downloading).toBe(false);
    await controller.request(() => true);
    expect(controller.choice).not.toBeNull();
    download.resolve({success: true});
    await a;
    expect(controller.choice).not.toBeNull();
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
  });

  it('reset stops the old view immediately, and its late download completion cannot stop a new watcher', async () => {
    const first = deferred<unknown>(), second = deferred<unknown>();
    const firstStop = vi.fn(), secondStop = vi.fn();
    const listeners: Array<(progress: {loaded: number; total: number} | undefined) => void> = [];
    const watchDownload = vi.fn((_model: VideoLocalTranscriptionModel, next: typeof listeners[number]) => {
      listeners.push(next);
      return listeners.length === 1 ? firstStop : secondStop;
    });
    let downloads = 0;
    const {controller, dependencies} = setup({watchDownload, sendMessage: vi.fn((message: {type: string}) =>
      message.type === 'fluentReadPrepareLocalVideoModel'
        ? (++downloads === 1 ? first.promise : second.promise) : Promise.resolve({success: true, models: []}))});
    await controller.request(() => true);
    const a = controller.confirm();
    listeners[0]!({loaded: 1, total: 100});
    controller.reset();
    expect(firstStop).toHaveBeenCalledOnce();
    controller.reset();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(controller.downloading).toBe(false);
    await controller.request(() => true);
    const b = controller.confirm();
    expect(watchDownload).toHaveBeenCalledTimes(2);
    listeners[1]!({loaded: 10, total: 100});
    first.resolve({success: true});
    await a;
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).not.toHaveBeenCalled();
    expect(controller.downloading).toBe(true);
    expect(controller.downloadProgress).toEqual({loaded: 10, total: 100});
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
    second.resolve({success: true});
    await b;
    expect(secondStop).toHaveBeenCalledOnce();
    expect(controller.downloading).toBe(false);
    expect(dependencies.startGeneration).toHaveBeenCalledOnce();
    controller.reset();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it('starts immediately when the configured model is already downloaded', async () => {
    const {controller, events, dependencies} = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny']}]}});
    const pending = controller.request(() => true);
    expect(controller.checking).toBe(true);
    await pending;
    expect(controller.checking).toBe(false);
    expect(controller.choice).toBeNull();
    expect(events).toEqual(['error:', 'start']);
    expect(dependencies.onChange).toHaveBeenCalledTimes(2);
  });

  it('explicit model selection waits for confirmation even when the current model is downloaded', async () => {
    const {controller, dependencies, sendMessage} = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny', 'base', 'small']}],
    }});
    await controller.request(() => true, true);
    expect(controller.choice).toMatchObject({selected: 'tiny', purpose: 'selection'});
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
    expect(dependencies.persistModel).not.toHaveBeenCalled();
    controller.select('small');
    expect(dependencies.persistModel).not.toHaveBeenCalled();
    await controller.confirm();
    expect(dependencies.persistModel).toHaveBeenCalledTimes(1);
    expect(dependencies.persistModel).toHaveBeenCalledWith('small');
    expect(dependencies.startGeneration).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('explicit model selection preserves the configured model ahead of other cached choices', async () => {
    const {controller, dependencies, configure} = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny']}],
    }});
    // Small remains selected even when Tiny could start without any download.
    configure('small');
    await controller.request(() => true, true);
    expect(controller.choice?.selected).toBe('small');
    controller.cancel();
    expect(dependencies.persistModel).not.toHaveBeenCalled();
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
  });

  it('closing an explicit selector during readiness does not open it from a late response', async () => {
    const status = deferred<unknown>();
    const {controller, dependencies} = setup({sendMessage: vi.fn(() => status.promise)});
    const pending = controller.request(() => true, true);
    controller.cancel();
    status.resolve({success: true, models: ['tiny', 'small']});
    await pending;
    expect(controller.choice).toBeNull();
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
  });

  it('explicit model selection respects the visibility gate despite a cached model', async () => {
    const {controller, dependencies} = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny']}],
    }});
    await controller.request(() => false, true);
    expect(controller.choice).toBeNull();
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
  });

  it('closing during a pending model check never starts recognition from a late result', async () => {
    const status = deferred<unknown>();
    const {controller, dependencies} = setup({sendMessage: vi.fn(() => status.promise)});
    const pending = controller.request(() => true);
    controller.cancel();
    status.resolve({success: true, models: ['tiny']});
    await pending;
    expect(dependencies.startGeneration).not.toHaveBeenCalled();
    expect(controller.choice).toBeNull();
  });

  it('recommends Small, preserves the configured Tiny, lets the user switch and downloads before starting', async () => {
    const {controller, events, dependencies, sendMessage} = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: []}],
      fluentReadPrepareLocalVideoModel: [{success: true, models: ['tiny']}],
    }});
    await controller.request(() => true);
    expect(controller.choice).toEqual({downloaded: [], recommended: 'small', selected: 'tiny'});
    controller.select('base');
    expect(controller.choice?.selected).toBe('base');

    const confirmed = controller.confirm();
    expect(controller.choice).toBeNull();
    expect(controller.downloading).toBe(true);
    await confirmed;
    expect(controller.downloading).toBe(false);
    expect(sendMessage).toHaveBeenLastCalledWith({type: 'fluentReadPrepareLocalVideoModel', model: 'base'});
    expect(dependencies.persistModel).toHaveBeenCalledWith('base');
    expect(events).toEqual(['error:', 'error:', 'start']);
  });

  it('persists a newly chosen model and prefers an already downloaded model without downloading', async () => {
    const {controller, dependencies, sendMessage, events} = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: ['base']}]}});
    await controller.request(() => true);
    expect(controller.choice?.selected).toBe('base');
    await controller.confirm();
    expect(dependencies.persistModel).toHaveBeenCalledWith('base');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe('start');
  });

  it('keeps the model chosen in settings selected while marking Small as recommended', async () => {
    const {controller, configure} = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: []}]}});
    configure('base');
    await controller.request(() => true);
    expect(controller.choice).toEqual({downloaded: [], recommended: 'small', selected: 'base'});
  });

  it('reports status failures only for current requests and never opens a stale choice', async () => {
    const failing = setup({responses: {fluentReadGetLocalVideoModelState: [new Error('offline')]}});
    await failing.controller.request(() => true);
    expect(failing.events).toEqual(['error:', 'error:无法读取模型状态，请重试']);

    const stale = setup({responses: {fluentReadGetLocalVideoModelState: [new Error('offline')]}});
    const staleRequest = stale.controller.request(() => true);
    stale.invalidate();
    await staleRequest;
    expect(stale.events).toEqual(['error:']);

    const moved = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: []}]}});
    const movedRequest = moved.controller.request(() => true);
    moved.invalidate();
    await movedRequest;
    expect(moved.controller.choice).toBeNull();

    const switched = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny']}]}});
    const switchedRequest = switched.controller.request(() => true);
    switched.configure('base');
    await switchedRequest;
    expect(switched.events).toEqual(['error:']);

    const hidden = setup({responses: {fluentReadGetLocalVideoModelState: [{success: true, models: []}]}});
    await hidden.controller.request(() => false);
    expect(hidden.controller.choice).toBeNull();
  });

  it('ignores overlapping requests and empty selections, cancellations or confirmations', async () => {
    const status = deferred<unknown>();
    const idle = setup({sendMessage: vi.fn(() => status.promise)});
    const first = idle.controller.request(() => true);
    await idle.controller.request(() => true);
    idle.controller.select('base');
    idle.controller.cancel();
    await idle.controller.confirm();
    expect(idle.dependencies.sendMessage).toHaveBeenCalledTimes(1);
    expect(idle.dependencies.onChange).toHaveBeenCalledTimes(1);
    status.resolve({success: true, models: []});
    await first;
    idle.controller.cancel();
    expect(idle.controller.choice).toBeNull();

    const download = deferred<unknown>();
    const busy = setup({sendMessage: vi.fn((message: {type: string}) => message.type === 'fluentReadPrepareLocalVideoModel'
      ? download.promise
      : Promise.resolve({success: true, models: []}))});
    await busy.controller.request(() => true);
    const confirming = busy.controller.confirm();
    await busy.controller.request(() => true);
    expect(busy.dependencies.sendMessage).toHaveBeenCalledTimes(2);
    download.resolve({success: true});
    await confirming;
    expect(busy.dependencies.startGeneration).toHaveBeenCalledTimes(1);
  });

  it('tracks real download progress for the confirmed model and stops watching when the download ends', async () => {
    const download = deferred<unknown>();
    let listener: ((progress: {loaded: number; total: number} | undefined) => void) | undefined;
    const stopWatching = vi.fn();
    const watchDownload = vi.fn((_model: VideoLocalTranscriptionModel, next: typeof listener) => { listener = next; return stopWatching; });
    const {controller, dependencies} = setup({watchDownload, sendMessage: vi.fn((message: {type: string}) =>
      message.type === 'fluentReadPrepareLocalVideoModel' ? download.promise : Promise.resolve({success: true, models: []}))});
    await controller.request(() => true);
    controller.select('base');
    const confirming = controller.confirm();
    expect(watchDownload).toHaveBeenCalledWith('base', expect.any(Function));
    expect(controller.downloadProgress).toBeUndefined();

    const changes = vi.mocked(dependencies.onChange).mock.calls.length;
    listener!({loaded: 30, total: 150});
    expect(controller.downloadProgress).toEqual({loaded: 30, total: 150});
    expect(dependencies.onChange).toHaveBeenCalledTimes(changes + 1);
    // 结束事件先于下载响应到达：保留最后一次进度，不退回不确定状态。
    listener!(undefined);
    expect(controller.downloadProgress).toEqual({loaded: 30, total: 150});
    expect(dependencies.onChange).toHaveBeenCalledTimes(changes + 1);

    download.resolve({success: true, models: ['base']});
    await confirming;
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(controller.downloading).toBe(false);
    expect(controller.downloadProgress).toBeUndefined();
  });

  it('drops progress from a download that belongs to a previous video', async () => {
    const download = deferred<unknown>();
    let listener: ((progress: {loaded: number; total: number} | undefined) => void) | undefined;
    const {controller} = setup({
      watchDownload: (_model, next) => { listener = next; return () => undefined; },
      sendMessage: vi.fn((message: {type: string}) =>
        message.type === 'fluentReadPrepareLocalVideoModel' ? download.promise : Promise.resolve({success: true, models: []})),
    });
    await controller.request(() => true);
    const confirming = controller.confirm();
    listener!({loaded: 1, total: 100});
    controller.reset();
    expect(controller.downloadProgress).toBeUndefined();
    listener!({loaded: 50, total: 100});
    expect(controller.downloadProgress).toBeUndefined();
    download.resolve({success: true});
    await confirming;
    expect(controller.downloadProgress).toBeUndefined();
  });

  it('shows download failures and does not start after the request becomes stale', async () => {
    const failed = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: []}],
      fluentReadPrepareLocalVideoModel: [{success: false, error: 'Hugging Face / HF Mirror 模型文件下载失败（503）'}],
    }});
    await failed.controller.request(() => true);
    await failed.controller.confirm();
    expect(failed.events.at(-1)).toBe(`error:下载失败：${LOCAL_VIDEO_MODEL_DOWNLOAD_ERROR}`);
    expect(failed.dependencies.startGeneration).not.toHaveBeenCalled();

    const stale = setup({responses: {
      fluentReadGetLocalVideoModelState: [{success: true, models: []}],
      fluentReadPrepareLocalVideoModel: [{success: true, models: ['base']}],
    }});
    await stale.controller.request(() => true);
    const confirming = stale.controller.confirm();
    stale.invalidate();
    await confirming;
    expect(stale.dependencies.startGeneration).not.toHaveBeenCalled();
  });
});

describe('native ASR model setup avoids browser downloads', () => {
  it('starts native generation without browser preparation', async () => {
    const f = setup({isNative: () => true});
    await f.controller.request(() => true);
    expect(f.controller.revision).toBe(1);
    expect(f.events).toEqual(['error:', 'start']);
    expect(f.controller.choice).toBeNull();
    expect(f.controller.checking).toBe(false);
    expect(f.controller.downloading).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.dependencies.watchDownload).not.toHaveBeenCalled();
    expect(f.dependencies.persistModel).not.toHaveBeenCalled();
  });
  it('routes model switching to settings without generating', async () => {
    const f = setup({isNative: () => true});
    await f.controller.request(() => true, true);
    expect(f.events).toEqual(['error:请在设置中切换识别方式']);
    expect(f.dependencies.onChange).toHaveBeenCalledOnce();
    expect(f.controller.revision).toBe(1);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects hidden and invalidated native requests without transport', async () => {
    const f = setup({isNative: () => true});
    await f.controller.request(() => false);
    f.invalidate();
    await f.controller.request(() => true);
    expect(f.controller.revision).toBe(2);
    expect(f.dependencies.startGeneration).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('retains browser setup when native selection explicitly returns false', async () => {
    const f = setup({isNative: () => false, responses: {fluentReadGetLocalVideoModelState: [{success: true, models: ['tiny']}]}});
    await f.controller.request(() => true);
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.dependencies.startGeneration).toHaveBeenCalledOnce();
  });
});
