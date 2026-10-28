import {translationSnapshot} from './helpers/localInferenceFixtures';
import {getEventListeners} from 'node:events';
import type {OffscreenRequestMap} from '@/src/core/messaging/offscreen';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {createLocalTranslationOffscreenAdapter} from '@/src/platform/offscreen/localTranslation';
import {
  LOCAL_TRANSLATION_MODEL_IDS,
  LOCAL_TRANSLATION_MODEL_STATE_KEY,
  LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY,
} from '@/src/core/config/localTranslation';
import {createLocalTranslationBackgroundHandlers} from '@/src/features/local-translation/background/handlers';
import {OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE} from '@/src/platform/offscreen/client';

const send = vi.fn();
const client = {
  send,
  sendIfPresent: vi.fn(),
  ensureDocument: vi.fn(),
  hasDocument: vi.fn(),
} as any;

const baseOffscreenDependencies = {
  ttsPlayer: {play: vi.fn(async () => undefined), stop: vi.fn(() => true), seek: vi.fn(() => true)},
  fetchImage: vi.fn(async () => 'data:image/png;base64,image'),
  translateImage: vi.fn(async () => ({image: 'image', lines: []})),
  translateArea: vi.fn(async () => ({image: 'image', lines: []})),
  downloadOcrLanguages: vi.fn(async () => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('local translation Offscreen adapter', () => {
  it('forwards detection context without changing the source text', async () => {
    send.mockResolvedValue({success: true, result: '译文'});
    await createLocalTranslationOffscreenAdapter(client).translate({model: LOCAL_TRANSLATION_MODEL_IDS.m2m100, text: 'Reduce Waste during Filament Change',
      sourceLanguage: 'auto', targetLanguage: 'zh', sourceLanguageDetectionText: 'English paragraph context'});
    expect(send.mock.calls[0][0]).toMatchObject({text: 'Reduce Waste during Filament Change', sourceLanguageDetectionText: 'English paragraph context'});
  });
  it('forwards model, language pair, cancellation and timeout metadata', async () => {
    send.mockResolvedValueOnce({success: true, result: '译文'});
    const adapter = createLocalTranslationOffscreenAdapter(client);
    const controller = new AbortController();
    await expect(adapter.translate({
      model: LOCAL_TRANSLATION_MODEL_IDS.m2m100,
      text: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
    }, {signal: controller.signal, timeoutMs: 20_000})).resolves.toBe('译文');
    expect(send).toHaveBeenCalledWith({
      type: 'LOCAL_TRANSLATION_TRANSLATE',
      requestId: expect.any(String),
      model: LOCAL_TRANSLATION_MODEL_IDS.m2m100,
      text: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
    }, {
      signal: controller.signal,
      timeoutMs: 20_000,
      cancelMessage: {
        type: OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE,
        requestId: expect.any(String),
      },
    });
    const sent = send.mock.calls[0]?.[0];
    const options = send.mock.calls[0]?.[1];
    expect(options.cancelMessage.requestId).toBe(sent.requestId);
  });

  it('validates prepare, status and remove responses', async () => {
    send
      .mockResolvedValueOnce({success: true, ...translationSnapshot()})
      .mockResolvedValueOnce({success: true, models: []})
      .mockResolvedValueOnce({success: true});
    const adapter = createLocalTranslationOffscreenAdapter(client);
    await expect(adapter.prepare(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toMatchObject({success: true});
    await expect(adapter.status()).resolves.toMatchObject({success: true});
    await expect(adapter.remove(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBeUndefined();
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({type: 'LOCAL_TRANSLATION_PREPARE'}), {timeoutMs: 30_000});
    expect(send).toHaveBeenNthCalledWith(2, {type: 'LOCAL_TRANSLATION_STATUS'}, {timeoutMs: 30_000});
    expect(send).toHaveBeenNthCalledWith(3, expect.objectContaining({type: 'LOCAL_TRANSLATION_REMOVE_MODEL'}), {timeoutMs: 30_000});
  });
});

describe('local translation paragraph language detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/src/features/local-translation/offscreen/downloads');
    vi.resetModules();
  });

  it.each([true, false])('reports missing model files without redundant retry (flag %s) and reconciles without blocking failure', async retrySingleThread => {
    vi.resetModules();
    const reconcile = vi.fn(() => new Promise<void>(() => {}));
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready', updatedAt: 42}]}), reconcileUnavailable: reconcile}),
    }));
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {queueMicrotask(() => this.onmessage?.({data: {
        requestId: message.requestId, success: false, error: 'LOCAL_TRANSLATION_NOT_DOWNLOADED', retrySingleThread,
      }}));}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      await expect(owner.translateLocalText({model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'})).rejects.toThrow('LOCAL_TRANSLATION_NOT_DOWNLOADED');
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, 42, 'missing');
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each(['missing', 'integrity'])('reconciles a real initialized download manager after cache %s', async damage => {
    vi.resetModules();vi.doUnmock('@/src/features/local-translation/offscreen/downloads');
    const stores = new Map<string, Map<string, Response>>();
    vi.stubGlobal('caches', {open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        match: async (key: string) => entries.get(key)?.clone(),
        put: async (key: string, value: Response) => {entries.set(key, value.clone());},
        delete: async (key: string) => entries.delete(key),
        keys: async (key: string) => [...entries.keys()].filter(value => value.split('?')[0] === key.split('?')[0]).map(value => new Request(value)),
      };
    }});
    const artifact = await import('@/src/features/local-translation/offscreen/artifactStore');
    const model = LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, files = artifact.getTranslationArtifacts(model);
    const store = await caches.open(artifact.LOCAL_MODEL_CACHE);
    for (const file of files) {
      await store.put(`${artifact.artifactUrl(file)}?fluent-read-verified=${file.sha256}`, new Response('{}'));
      for (let index = 0; index < Math.ceil(file.size / artifact.MODEL_CHUNK_SIZE); index++) {
        const size = Math.min(artifact.MODEL_CHUNK_SIZE, file.size - index * artifact.MODEL_CHUNK_SIZE);
        await store.put(`${artifact.artifactUrl(file)}?fluent-read-part=${index}`, new Response('', {headers: {'Content-Length': String(size)}}));
      }
    }
    const damaged = files.find(file => file.path === 'config.json')!;
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {
        void artifact.matchTranslationArtifact(artifact.artifactUrl(damaged)).then(
          () => {throw new Error('missing chunk was accepted');},
          (error: Error) => this.onmessage?.({data: {requestId: message.requestId, success: false, error: error.message, retrySingleThread: true}}),
        );
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    vi.stubGlobal('navigator', {language: 'en-US'});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      expect((await owner.getLocalTranslationModelStatus()).tasks.find(task => task.model === model)?.phase).toBe('ready');
      if (damage === 'missing') await store.delete(`${artifact.artifactUrl(damaged)}?fluent-read-part=0`);
      await expect(owner.translateLocalText({model, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'})).rejects.toThrow(
        damage === 'missing' ? 'LOCAL_TRANSLATION_NOT_DOWNLOADED' : 'LOCAL_TRANSLATION_INTEGRITY',
      );
      await vi.waitFor(async () => expect((await owner.getLocalTranslationModelStatus()).tasks.find(task => task.model === model)?.phase)
        .toBe(damage === 'missing' ? 'paused' : 'error'));
      expect(workers).toHaveLength(1);expect(workers[0].terminate).toHaveBeenCalledOnce();
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('cancels safely if the signal is aborted while the Worker is being constructed', async () => {
    vi.resetModules();
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]})}),
    }));
    const controller = new AbortController(), workers: FakeWorker[] = [];
    class FakeWorker {
      terminate = vi.fn();postMessage = vi.fn();
      constructor() {workers.push(this);controller.abort();}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      await expect(owner.translateLocalText({model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'}, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
      expect(workers).toHaveLength(1);expect(workers[0].terminate).toHaveBeenCalledOnce();expect(workers[0].postMessage).not.toHaveBeenCalled();
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('does not loop when the single-thread Worker also requests a retry', async () => {
    vi.resetModules();
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]})}),
    }));
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {queueMicrotask(() => this.onmessage?.({data: {requestId: message.requestId, success: false, retrySingleThread: true, error: 'PTHREAD_UNAVAILABLE'}}));}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      await expect(owner.translateLocalText({model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'})).rejects.toThrow('PTHREAD_UNAVAILABLE');
      expect(workers).toHaveLength(2);expect(workers[0].terminate).toHaveBeenCalledOnce();
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('reconciles a missing model even if a single-thread fallback returns a retry-marked failure', async () => {
    vi.resetModules();
    const reconcile = vi.fn(async () => undefined);
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready', updatedAt: 42}]}), reconcileUnavailable: reconcile}),
    }));
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {queueMicrotask(() => this.onmessage?.({data: {requestId: message.requestId, success: false, retrySingleThread: true,
        error: message.singleThread ? 'LOCAL_TRANSLATION_NOT_DOWNLOADED' : 'PTHREAD_UNAVAILABLE'}}));}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      await expect(owner.translateLocalText({model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'})).rejects.toThrow('LOCAL_TRANSLATION_NOT_DOWNLOADED');
      expect(workers).toHaveLength(2);expect(reconcile).toHaveBeenCalledWith(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, 42, 'missing');
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('ignores an old Worker error after cancellation and preserves the replacement request', async () => {
    vi.resetModules();
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]})}),
    }));
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      onerror?: (event: any) => void;
      message: any;
      terminate = vi.fn();
      constructor() { workers.push(this); }
      postMessage(message: any) { this.message = message; }
      complete(result: string) { this.onmessage?.({data: {requestId: this.message.requestId, success: true, result}}); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const {translateLocalText, disposeLocalTranslationWorker} = await import('@/src/features/local-translation/offscreen/translation');
    const request = {model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh'};
    const controller = new AbortController();
    try {
      const first = translateLocalText(request, controller.signal);
      const cancelled = expect(first).rejects.toMatchObject({name: 'AbortError'});
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      controller.abort();
      await cancelled;
      const second = translateLocalText(request);
      const completed = expect(second).resolves.toBe('新译文');
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      workers[0].onerror?.({message: 'late failure from cancelled worker'});
      workers[1].complete('新译文');
      await completed;
      expect(workers[1].terminate).not.toHaveBeenCalled();
      const third = translateLocalText(request);
      const rejected = expect(third).rejects.toThrow('current worker failed');
      await vi.waitFor(() => expect(workers[1].message.requestId).toBe(3));
      workers[1].onerror?.({message: 'current worker failed'});
      await rejected;
      expect(workers[1].terminate).toHaveBeenCalledOnce();
    } finally { disposeLocalTranslationWorker(); }
  });

  it('rebuilds a failed pthread runtime once with singleThread and returns the fresh result', async () => {
    vi.resetModules();
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]})}),
    }));
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      messages: any[] = [];
      constructor() {workers.push(this);}
      postMessage(message: any) {
        this.messages.push(message);
        queueMicrotask(() => this.onmessage?.({data: {
          requestId: message.requestId, success: message.singleThread === true,
          ...(message.singleThread ? {result: 'Fresh result'} : {retrySingleThread: true, error: 'pthread unavailable'}),
        }}));
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    try {
      await expect(owner.translateLocalText({model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn,text:'Hello world',sourceLanguage:'en',targetLanguage:'zh'})).resolves.toBe('Fresh result');
      expect(workers).toHaveLength(2);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(workers[1].messages).toHaveLength(1);
      expect(workers[1].messages[0].singleThread).toBe(true);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('uses real detection with paragraph context, preserves explicit choices and handles blank context', async () => {
    vi.resetModules();
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]})}),
    }));
    const posted: any[] = [];
    class FakeWorker {
      onmessage?: (event: any) => void;
      postMessage(message: any) {
        posted.push(message);
        queueMicrotask(() => this.onmessage?.({data: {requestId: message.requestId, success: true, result: '译文'}}));
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const {translateLocalText, disposeLocalTranslationWorker} = await import('@/src/features/local-translation/offscreen/translation');
    const text = 'Reduce Waste during Filament Change';
    const paragraph = 'When switching between different filaments for printing, the printer flushes the remaining material to avoid color mixing. ' + text;
    const request = {model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text, sourceLanguage: 'auto', targetLanguage: 'zh'};
    try {
      await expect(translateLocalText(request)).rejects.toThrow('LANGUAGE_UNSUPPORTED');
      await expect(translateLocalText({...request, sourceLanguageDetectionText: paragraph})).resolves.toBe('译文');
      expect(posted.at(-1)).toMatchObject({text, sourceLanguage: 'en', targetLanguage: 'zh'});
      expect(posted.at(-1)).not.toHaveProperty('sourceLanguageDetectionText');
      await expect(translateLocalText({...request, sourceLanguage: 'fr', sourceLanguageDetectionText: paragraph})).rejects.toThrow('LANGUAGE_UNSUPPORTED');
      for (const context of [undefined, '', '  ', [], {}]) {
        await expect(translateLocalText({...request, text: paragraph, sourceLanguageDetectionText: context})).resolves.toBe('译文');
      }
    } finally {
      disposeLocalTranslationWorker();
    }
  });
});

describe('local translation idle disposal while waiting for shared capacity', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('@/src/features/local-translation/offscreen/downloads');
    vi.doUnmock('@/src/shared/onnx/resources');
    vi.resetModules();
  });

  async function warmOwner(memory?: number, statusHook?: () => Promise<unknown>) {
    vi.useFakeTimers(); vi.resetModules();
    vi.stubGlobal('navigator', memory === undefined ? {} : {deviceMemory: memory});
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({status: statusHook || (async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]}))}),
    }));
    const workers: WarmWorker[] = [];
    class WarmWorker {
      onmessage?: (event: any) => void;
      terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {queueMicrotask(() => this.onmessage?.({data: {requestId: message.requestId, success: true, result: 'warm'}}));}
    }
    vi.stubGlobal('Worker', WarmWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    return {workers, owner: await import('@/src/features/local-translation/offscreen/translation'), request: {
      model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh',
    }};
  }

  it('rejects malformed correlated replies without retrying and keeps a later valid translation available', async () => {
    const {owner, workers, request} = await warmOwner(8);
    const workerClass = globalThis.Worker;
    const originalPost = workerClass.prototype.postMessage;
    workerClass.prototype.postMessage = function(message) {
      this.onmessage?.(new MessageEvent('message', {data: {requestId: 'wrong', success: true, result: 'unrelated'}}));
      this.onmessage?.(new MessageEvent('message', {data: {requestId: message.requestId + 1, success: true, result: 'foreign'}}));
      this.onmessage?.(new MessageEvent('message', {data: {requestId: message.requestId, success: true, result: [], retrySingleThread: true}}));
    };
    try {
      await expect(owner.translateLocalText(request)).rejects.toThrow('消息格式无效');
      expect(workers).toHaveLength(1); expect(workers[0].terminate).not.toHaveBeenCalled();
      workerClass.prototype.postMessage = originalPost;
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(1);
    } finally {workerClass.prototype.postMessage = originalPost; owner.disposeLocalTranslationWorker();}
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pre-cancelled translation before taking a queue or worker lease, and leaves later translation available', async () => {
    const {owner, workers, request} = await warmOwner(8);
    const controller = new AbortController(); controller.abort();
    try {
      await expect(owner.translateLocalText(request, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
      expect(workers).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(1);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('cancels a request while checking the model cache without destroying its warm worker or poisoning a later request', async () => {
    const ready = {tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]};
    let checking = false;
    let finishStatus!: (value: typeof ready) => void;
    const status = vi.fn(async () => checking ? new Promise<typeof ready>(resolve => {finishStatus = resolve;}) : ready);
    const {owner, workers, request} = await warmOwner(8, status);
    const controller = new AbortController();
    try {
      await owner.translateLocalText(request);
      checking = true;
      const pending = owner.translateLocalText(request, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(status).toHaveBeenCalledTimes(2);
      controller.abort(); finishStatus(ready); await rejected;
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      checking = false;
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(1);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each(['cancel', 'dispose'] as const)('discards a completed native result when %s arrives before the translation caller accepts it', async mode => {
    const {owner, workers, request} = await warmOwner(8);
    const controller = new AbortController();
    let cancelFirstReply = true;
    (globalThis.Worker as any).prototype.postMessage = function(message: any) {
      queueMicrotask(() => {
        this.onmessage?.({data: {requestId: message.requestId, success: true, result: 'ready'}});
        if (cancelFirstReply) {
          cancelFirstReply = false;
          // Worker 回复先解除原生等待；取消在其续体之后、返回到公开调用方之前到达。
          queueMicrotask(() => mode === 'cancel' ? controller.abort() : owner.disposeLocalTranslationWorker());
        }
      });
    };
    try {
      await expect(owner.translateLocalText(request, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
      expect(workers).toHaveLength(1);
      if (mode === 'cancel') expect(workers[0].terminate).not.toHaveBeenCalled();
      else expect(workers[0].terminate).toHaveBeenCalledOnce();
      await expect(owner.translateLocalText(request)).resolves.toBe('ready');
      expect(workers).toHaveLength(mode === 'cancel' ? 1 : 2);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('does not revive an old translation that was waiting for shared inference capacity when the owner is disposed', async () => {
    const resources = await vi.importActual<typeof import('@/src/shared/onnx/resources')>('@/src/shared/onnx/resources');
    const budget = vi.fn(resources.createLocalInferenceBudget(1));
    vi.doMock('@/src/shared/onnx/resources', () => ({...resources, withLocalInferenceBudget: budget}));
    const {owner, workers, request} = await warmOwner(8);
    let releaseBudget!: () => void;
    const busy = new Promise<void>(resolve => {releaseBudget = resolve;});
    let occupying: Promise<unknown> | undefined;
    let rejected: Promise<unknown> | undefined;
    try {
      await owner.translateLocalText(request);
      occupying = budget(() => busy);
      const queued = owner.translateLocalText(request);
      rejected = expect(queued).rejects.toMatchObject({name: 'AbortError'});
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(budget).toHaveBeenCalledTimes(3);
      expect(workers).toHaveLength(1);
      owner.disposeLocalTranslationWorker();
      releaseBudget(); await occupying; await rejected;
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(2);
    } finally {
      releaseBudget(); await occupying;
      owner.disposeLocalTranslationWorker();
      await rejected;
    }
  });

  it.each([[4, 60_000], [8, 180_000], [undefined, 120_000]])('reuses translation across reading pauses with memory %s and releases after %s idle milliseconds', async (memory, idleMs) => {
    const {owner, workers, request} = await warmOwner(memory);
    try {
      for (let index = 0; index < 3; index++) {
        await expect(owner.translateLocalText(request)).resolves.toBe('warm');
        await vi.advanceTimersByTimeAsync(45_000);
      }
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(idleMs! - 45_001);
      expect(workers[0].terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(2);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each([
    {stop: 'cancel', late: 'resolve', model: 'same'}, {stop: 'cancel', late: 'reject', model: 'same'},
    {stop: 'cancel', late: 'resolve', model: 'switch'}, {stop: 'cancel', late: 'reject', model: 'switch'},
    {stop: 'dispose', late: 'resolve', model: 'same'}, {stop: 'dispose', late: 'reject', model: 'same'},
    {stop: 'dispose', late: 'resolve', model: 'switch'}, {stop: 'dispose', late: 'reject', model: 'switch'},
  ] as const)('$stop 在 status 挂起时释放串行槽；迟到 $late 不影响 $model 模型新任务', async ({stop, late, model}) => {
    const ready = {tasks: [LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, LOCAL_TRANSLATION_MODEL_IDS.m2m100]
      .map(model => ({model, phase: 'ready'}))};
    let finishStatus!: (value: typeof ready) => void;
    let rejectStatus!: (reason: unknown) => void;
    let count = 0;
    const status = vi.fn(async () => ++count === 2
      ? new Promise<typeof ready>((resolve, reject) => {finishStatus = resolve;rejectStatus = reject;}) : ready);
    const {owner, workers, request} = await warmOwner(8, status);
    const controller = new AbortController();
    let cancelled = false;
    try {
      await owner.translateLocalText(request);
      const first = owner.translateLocalText({...request, text: 'Stale pending status'}, controller.signal)
        .then(() => 'unexpected', error => {cancelled = error.name === 'AbortError';return error.name;});
      for (let i = 0; i < 20 && !finishStatus; i++) await Promise.resolve();
      expect(finishStatus).toBeTypeOf('function');
      if (stop === 'cancel') controller.abort(); else owner.disposeLocalTranslationWorker();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(cancelled).toBe(true);
      expect(await first).toBe('AbortError');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      const nextModel = model === 'same' ? request.model : LOCAL_TRANSLATION_MODEL_IDS.m2m100;
      await expect(owner.translateLocalText({...request, model: nextModel, text: 'Fresh task'})).resolves.toBe('warm');
      expect(status).toHaveBeenCalledTimes(3);
      expect(workers).toHaveLength(stop === 'dispose' || model === 'switch' ? 2 : 1);
      if (late === 'resolve') finishStatus(ready); else rejectStatus(new Error('late status failure'));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(workers.at(-1)!.terminate).not.toHaveBeenCalled();
      await expect(owner.translateLocalText({...request, model: nextModel})).resolves.toBe('warm');
      expect(workers).toHaveLength(stop === 'dispose' || model === 'switch' ? 2 : 1);
    } finally {finishStatus?.(ready);owner.disposeLocalTranslationWorker();}
  });

  it('status 真正开始前立即取消不会启动存储查询或遗留监听', async () => {
    const status = vi.fn(async () => ({tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]}));
    const {owner, workers, request} = await warmOwner(8, status);
    const controller = new AbortController();
    try {
      const pending = owner.translateLocalText(request, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({name: 'AbortError'});
      expect(status).not.toHaveBeenCalled();
      expect(workers).toHaveLength(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('排队翻译取消时立即释放等待，其他任务仍保持顺序和已加载 Worker', async () => {
    const ready = {tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]};
    let finishStatus!: (value: typeof ready) => void;
    let checking = false;
    const status = vi.fn(async () => checking ? new Promise<typeof ready>(resolve => {finishStatus = resolve;}) : ready);
    const {owner, workers, request} = await warmOwner(8, status);
    let current: Promise<string> | undefined;
    let later: Promise<string> | undefined;
    try {
      await owner.translateLocalText(request);
      checking = true;
      current = owner.translateLocalText({...request, text: 'Waiting for model status'});
      for (let i = 0; i < 20 && !finishStatus; i++) await Promise.resolve();
      expect(finishStatus).toBeTypeOf('function');
      const controller = new AbortController();
      let cancelled = false;
      const stopped = owner.translateLocalText({...request, text: 'Cancelled in queue'}, controller.signal)
        .then(() => 'unexpected', error => {cancelled = error.name === 'AbortError'; return error.name;});
      later = owner.translateLocalText({...request, text: 'Next request'});
      controller.abort();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(cancelled).toBe(true);
      expect(await stopped).toBe('AbortError');
      expect(status).toHaveBeenCalledTimes(2);
      expect(workers[0].terminate).not.toHaveBeenCalled();
      checking = false; finishStatus(ready);
      await expect(current).resolves.toBe('warm');
      await expect(later).resolves.toBe('warm');
      expect(status).toHaveBeenCalledTimes(3);
      expect(workers).toHaveLength(1);
    } finally { checking = false; finishStatus?.(ready); owner.disposeLocalTranslationWorker(); await current?.catch(() => undefined); await later?.catch(() => undefined); }
  });

  it('protects a warm translation while checking the model cache and invalidates the entire old queue on disposal', async () => {
    const ready = {tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready'}]};
    let finishStatus!: (value: typeof ready) => void;
    let checking = false;
    const status = vi.fn(async () => checking ? new Promise<typeof ready>(resolve => {finishStatus = resolve;}) : ready);
    const {owner, workers, request} = await warmOwner(8, status);
    try {
      await owner.translateLocalText(request);
      await vi.advanceTimersByTimeAsync(179_000);
      checking = true;
      const current = owner.translateLocalText(request);
      const currentRejected = expect(current).rejects.toMatchObject({name: 'AbortError'});
      const queued = owner.translateLocalText(request);
      const queueRejected = expect(queued).rejects.toMatchObject({name: 'AbortError'});
      await vi.advanceTimersByTimeAsync(185_000);
      expect(workers[0].terminate).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledTimes(2);
      owner.disposeLocalTranslationWorker();
      finishStatus(ready);
      await currentRejected; await queueRejected;
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      checking = false;
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(2);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each(['retry', 'success'])('does not revive or accept the old translation after disposal races with a %s response', async kind => {
    const {owner, workers, request} = await warmOwner(8);
    let disposeOnReply = true;
    const originalPost = (globalThis.Worker as any).prototype.postMessage;
    (globalThis.Worker as any).prototype.postMessage = function(message: any) {
      if (!disposeOnReply) {originalPost.call(this, message); return;}
      queueMicrotask(() => {
        this.onmessage?.({data: {requestId: message.requestId, ...(kind === 'retry'
          ? {success: false, retrySingleThread: true} : {success: true, result: 'old'})}});
        disposeOnReply = false;
        owner.disposeLocalTranslationWorker();
      });
    };
    try {
      await expect(owner.translateLocalText(request)).rejects.toMatchObject({name: 'AbortError'});
      expect(workers).toHaveLength(1);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await expect(owner.translateLocalText(request)).resolves.toBe('warm');
      expect(workers).toHaveLength(2);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each(['reuse', 'switch-model'] as const)('keeps the warm worker alive past its old idle deadline while a %s request waits for capacity', async mode => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {deviceMemory: 8});
    vi.resetModules();
    const readyModels = [LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, LOCAL_TRANSLATION_MODEL_IDS.m2m100];
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({
      createLocalTranslationDownloadManager: () => ({
        status: async () => ({tasks: readyModels.map(model => ({model, phase: 'ready'}))}),
      }),
    }));
    const resources = await vi.importActual<typeof import('@/src/shared/onnx/resources')>('@/src/shared/onnx/resources');
    const budget = vi.fn(resources.createLocalInferenceBudget(1));
    vi.doMock('@/src/shared/onnx/resources', () => ({...resources, withLocalInferenceBudget: budget}));

    const workers: IdleWorker[] = [];
    class IdleWorker {
      onmessage?: (event: any) => void;
      onerror?: (event: any) => void;
      messages: any[] = [];
      terminate = vi.fn();
      constructor() {workers.push(this);}
      postMessage(message: any) {this.messages.push(message);}
      complete(result: string) {
        this.onmessage?.({data: {requestId: this.messages.at(-1).requestId, success: true, result}});
      }
    }
    const flush = async () => {for (let index = 0; index < 10; index++) await Promise.resolve();};
    vi.stubGlobal('Worker', IdleWorker);
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'https://extension.test/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    const request = {model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Warm request', sourceLanguage: 'en', targetLanguage: 'zh'};
    const controller = new AbortController();
    let releaseBudget!: () => void;
    const busy = new Promise<void>(resolve => {releaseBudget = resolve;});
    let occupying: Promise<unknown> | undefined;
    let outcome: Promise<{result: string} | {error: unknown}> | undefined;
    try {
      const warm = owner.translateLocalText(request);
      await flush();
      expect(workers).toHaveLength(1);
      const original = workers[0];
      original.complete('Warm result');
      await expect(warm).resolves.toBe('Warm result');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(179_000);

      // 另一类本地推理占满预算；新翻译尚未 postMessage，也没有 Worker 超时。
      occupying = budget(() => busy);
      const model = mode === 'reuse' ? LOCAL_TRANSLATION_MODEL_IDS.opusZhEn : LOCAL_TRANSLATION_MODEL_IDS.m2m100;
      const queued = owner.translateLocalText({...request, model, text: 'Queued request'}, controller.signal);
      let settled = false;
      outcome = queued.then(
        result => {settled = true;return {result};},
        error => {settled = true;return {error};},
      );
      await flush();
      expect(budget).toHaveBeenCalledTimes(3);
      expect(budget).toHaveBeenLastCalledWith(expect.any(Function), controller.signal);
      expect(original.messages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(185_000);
      expect(settled).toBe(false);
      expect(workers).toHaveLength(1);
      expect(original.terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      releaseBudget();await occupying;await flush();
      expect(workers).toHaveLength(mode === 'reuse' ? 1 : 2);
      const current = workers.at(-1)!;
      expect(current.messages.at(-1)).toMatchObject({type: 'translate', model, text: 'Queued request'});
      expect(current.terminate).not.toHaveBeenCalled();
      if (mode === 'reuse') {
        expect(current).toBe(original);expect(current.messages).toHaveLength(2);
      } else {
        expect(original.terminate).toHaveBeenCalledOnce();expect(original.messages).toHaveLength(1);
      }
      current.complete('Queued result');
      expect(await outcome).toEqual({result: 'Queued result'});

      // 只有新请求真正完成后才重新开始空闲计时，保留随后三分钟的热会话。
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(179_999);
      expect(current.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(current.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();releaseBudget();await occupying;
      owner.disposeLocalTranslationWorker();
      await outcome;
    }
  });
});

describe('local translation owner model management and worker failures', () => {
  afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.doUnmock('@/src/features/local-translation/offscreen/downloads');vi.resetModules();});
  async function fixture() {
    vi.resetModules();vi.useFakeTimers();
    const ready = translationSnapshot('ready');
    let hooks!: {onChange: (snapshot: typeof ready) => Promise<void>; beforeRemove: (model: string) => void};
    const downloads = {status: vi.fn().mockResolvedValue(ready), start: vi.fn().mockResolvedValue(ready), pause: vi.fn().mockResolvedValue(translationSnapshot('paused')),
      remove: vi.fn(async (model: string) => {hooks.beforeRemove(model);})};
    vi.doMock('@/src/features/local-translation/offscreen/downloads', () => ({createLocalTranslationDownloadManager: (options: typeof hooks) => {hooks = options;return downloads;}}));
    const workers: WorkerPort[] = [];
    class WorkerPort {
      onmessage?: (event: any) => void;onerror?: (event: any) => void;messages: any[] = [];terminate = vi.fn();
      postMessage = vi.fn((message: any) => {this.messages.push(message);});
      constructor(readonly url: string, readonly options: unknown) {workers.push(this);}
      reply(data: unknown) {this.onmessage?.({data});}
    }
    vi.stubGlobal('Worker', WorkerPort);
    vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://owner/${path}`}});
    vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'chrome-extension://owner/offscreen.html'}});
    const owner = await import('@/src/features/local-translation/offscreen/translation');
    const request = {model: LOCAL_TRANSLATION_MODEL_IDS.m2m100, text: 'Original', sourceLanguage: 'en', targetLanguage: 'zh'};
    const flush = () => vi.advanceTimersByTimeAsync(0);
    return {owner, hooks, downloads, workers, request, flush, ready};
  }

  it('forwards download controls, publishes configured progress, and only terminates the model being removed', async () => {
    const {owner, hooks, downloads, workers, request, flush, ready} = await fixture();
    try {
      await expect(hooks.onChange(ready)).resolves.toBeUndefined();
      const notify = vi.fn().mockResolvedValue(undefined);owner.configureLocalTranslationDownloadNotifications(notify);
      await hooks.onChange(ready);expect(notify).toHaveBeenCalledWith(ready);
      await expect(owner.prepareLocalTranslationModel(request.model)).resolves.toEqual(ready);
      await expect(owner.pauseLocalTranslationModelDownload(request.model)).resolves.toEqual(translationSnapshot('paused'));
      expect(downloads.start).toHaveBeenCalledWith(request.model);expect(downloads.pause).toHaveBeenCalledWith(request.model);
      const status = await owner.getLocalTranslationModelStatus();
      expect(status.models.find(model => model.model === request.model)).toMatchObject({downloaded: true});
      expect(status.models.find(model => model.model === LOCAL_TRANSLATION_MODEL_IDS.opusZhEn)).toMatchObject({downloaded: false});
      const pending = owner.translateLocalText(request);
      const rejection = expect(pending).rejects.toThrow('LOCAL_TRANSLATION_MODEL_REMOVED');await flush();
      expect(workers[0].url).toBe('chrome-extension://owner/localTranslationWorker.js');expect(workers[0].options).toEqual({type: 'module'});
      await owner.removeLocalTranslationModel(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn);expect(workers[0].terminate).not.toHaveBeenCalled();
      await owner.removeLocalTranslationModel(request.model);await rejection;expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('rejects missing model downloads before creating a worker and skips blank or same-language requests', async () => {
    const {owner, downloads, workers, request} = await fixture();
    try {
      await expect(owner.translateLocalText({...request, text: ''})).resolves.toBe('');
      await expect(owner.translateLocalText({...request, text: '  '})).resolves.toBe('  ');
      await expect(owner.translateLocalText({...request, targetLanguage: 'en'})).resolves.toBe('Original');
      expect(downloads.status).not.toHaveBeenCalled();
      for (const tasks of [[], [{model: request.model, phase: 'paused'}]]) {
        downloads.status.mockResolvedValue({version: 2, tasks});
        await expect(owner.translateLocalText(request)).rejects.toThrow('LOCAL_TRANSLATION_NOT_DOWNLOADED');
      }
      expect(workers).toHaveLength(0);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each([
    [{success: true, result: 42}, '消息格式无效'],
    [{success: false}, '本地翻译 Worker 失败'],
    [{success: true, result: ''}, '本地翻译未返回有效译文'],
    [{success: false, error: 'model failed'}, 'model failed'],
  ] as const)('rejects invalid or failed worker responses %j while allowing later requests', async (response, error) => {
    const {owner, workers, request, flush} = await fixture();
    try {
      const pending = owner.translateLocalText(request);const rejection = expect(pending).rejects.toThrow(error);await flush();
      const worker = workers[0];worker.reply(null);worker.reply({requestId: 999, success: true, result: 'orphan'});
      worker.reply({requestId: worker.messages[0].requestId, ...response});await rejection;
      const retry = owner.translateLocalText(request);await flush();
      worker.reply({requestId: worker.messages[1].requestId, success: true, result: 'Recovered'});
      await expect(retry).resolves.toBe('Recovered');expect(workers).toHaveLength(1);
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it.each([new Error('structured clone failed'), 'worker unavailable', null])('terminates failed postMessage resources and recovers from %s', async error => {
    const {owner, workers, request, flush} = await fixture();
    try {
      const warm = owner.translateLocalText(request);await flush();workers[0].reply({requestId: workers[0].messages[0].requestId, success: true, result: 'Warm'});await warm;
      workers[0].postMessage.mockImplementationOnce(() => {throw error;});
      const signal = new AbortController().signal;
      await expect(owner.translateLocalText(request, signal)).rejects.toThrow(error instanceof Error ? error.message : error || '无法启动本地翻译 Worker');
      expect(workers[0].terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
      const retry = owner.translateLocalText(request);await flush();
      workers[0].reply({requestId: 1, success: true, result: 'Late old result'});
      workers[1].reply({requestId: workers[1].messages[0].requestId, success: true, result: 'Recovered'});
      await expect(retry).resolves.toBe('Recovered');
    } finally {owner.disposeLocalTranslationWorker();}
  });

  it('terminates a stalled worker at the absolute deadline and reports runtime errors without a browser message', async () => {
    const {owner, workers, request, flush} = await fixture();
    try {
      const stalled = owner.translateLocalText(request);const timedOut = expect(stalled).rejects.toThrow('超过 120 秒');await flush();
      await vi.advanceTimersByTimeAsync(120_000);await timedOut;expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const retry = owner.translateLocalText(request);const crashed = expect(retry).rejects.toThrow('本地翻译 Worker 已停止');await flush();
      workers[1].onerror?.({});await crashed;expect(workers[1].terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    } finally {owner.disposeLocalTranslationWorker();}
  });
});

describe('local translation background handlers', () => {
  it('acknowledges background jobs without marking them downloaded and only persists trusted completed progress', async () => {
    let stored: Record<string, unknown> = {[LOCAL_TRANSLATION_MODEL_STATE_KEY]: []};
    const offscreen = {
      prepare: vi.fn(async () => ({success: true, ...translationSnapshot()})),
      status: vi.fn(async () => ({models: [{model: LOCAL_TRANSLATION_MODEL_IDS.m2m100, downloaded: true}]})),
      remove: vi.fn(async () => undefined),
      pause: vi.fn(async () => ({success: true, ...translationSnapshot('paused')})),
      translate: vi.fn(async () => 'result'),
    };
    const handlers = createLocalTranslationBackgroundHandlers({
      offscreen,
      isTrustedProgress: (context) => context === 'offscreen',
      storage: {
        get: async () => stored,
        set: async (value) => { stored = {...stored, ...value}; },
      },
    });
    const prepare = handlers.find((item) => item.type === 'fluentReadPrepareLocalTranslationModel')!;
    const state = handlers.find((item) => item.type === 'fluentReadGetLocalTranslationModelState')!;
    const remove = handlers.find((item) => item.type === 'fluentReadRemoveLocalTranslationModel')!;

    await expect(prepare.handle({type: 'fluentReadPrepareLocalTranslationModel', model: LOCAL_TRANSLATION_MODEL_IDS.m2m100} as any, {})).resolves.toMatchObject({
      success: true,
      ...translationSnapshot(),
    });
    expect(stored[LOCAL_TRANSLATION_MODEL_STATE_KEY]).toEqual([]);
    await expect(state.handle({type: 'fluentReadGetLocalTranslationModelState'}, {})).resolves.toEqual({success: true, models: [{model: LOCAL_TRANSLATION_MODEL_IDS.m2m100, downloaded: true}]});
    const progress = handlers.find((item) => item.type === 'fluentReadLocalTranslationDownloadProgress')!;
    const snapshot = {version: 2, tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, phase: 'ready', downloadedBytes: 20, totalBytes: 20, bytesPerSecond: 0, updatedAt: 2}]};
    await expect(progress.handle({type: progress.type, snapshot} as any, {})).resolves.toEqual({success: false});
    expect(stored[LOCAL_TRANSLATION_MODEL_STATE_KEY]).toEqual([]);
    await expect(progress.handle({type: progress.type, snapshot} as any, 'offscreen')).resolves.toEqual({success: true});
    expect(stored[LOCAL_TRANSLATION_MODEL_STATE_KEY]).toEqual([LOCAL_TRANSLATION_MODEL_IDS.opusZhEn]);
    await progress.handle({type: progress.type, snapshot: {...snapshot, tasks: [{...snapshot.tasks[0], phase: 'downloading', updatedAt: 1}]}} as any, 'offscreen');
    expect(stored[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]).toEqual(snapshot);
    await expect(remove.handle({type: 'fluentReadRemoveLocalTranslationModel', model: LOCAL_TRANSLATION_MODEL_IDS.m2m100} as any, {})).resolves.toMatchObject({success: true});
    expect(offscreen.prepare).toHaveBeenCalledOnce();
    expect(offscreen.remove).toHaveBeenCalledOnce();
  });
});

describe('local translation Offscreen message route', () => {
  const request = {
    target: 'offscreen', type: 'LOCAL_TRANSLATION_TRANSLATE', requestId: 'route-1',
    model: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh',
  };
  const localDependencies = () => ({
    translate: vi.fn(async (): Promise<string> => 'translated'),
    prepare: vi.fn(async () => translationSnapshot()),
    pause: vi.fn(async () => translationSnapshot('paused')),
    status: vi.fn(async () => ({models: []})),
    removeModel: vi.fn(async () => undefined),
  });
  const route = (localTranslation?: ReturnType<typeof localDependencies>) => {
    const listener = createOffscreenMessageListener({
      ...baseOffscreenDependencies, translate: vi.fn(async () => 'chrome'), localTranslation,
    });
    return (message: Record<string, unknown>) => new Promise<any>((resolve) => {
      expect(listener({...request, ...message}, {}, resolve)).toBe(true);
    });
  };

  it.each(['PREPARE', 'PAUSE', 'STATUS', 'REMOVE_MODEL', 'TRANSLATE'])('rejects %s when local execution is unavailable', async (operation) => {
    await expect(route()({type: `LOCAL_TRANSLATION_${operation}`})).resolves.toMatchObject({success: false});
  });

  it.each([
    ['PREPARE', 'prepare', {success: true, ...translationSnapshot()}],
    ['PAUSE', 'pause', {success: true, ...translationSnapshot('paused')}],
    ['STATUS', 'status', {success: true, models: []}],
    ['REMOVE_MODEL', 'removeModel', {success: true}],
  ] as const)('forwards %s and returns its snapshot', async (operation, method, response) => {
    const local = localDependencies();
    await expect(route(local)({type: `LOCAL_TRANSLATION_${operation}`})).resolves.toEqual(response);
    expect(local[method]).toHaveBeenCalledOnce();
  });

  it.each([
    {model: 'unknown'}, {sourceLanguageDetectionText: 42}, {requestId: 'invalid request'},
  ])('rejects invalid translation fields %j before execution', async (fields) => {
    const local = localDependencies();
    await expect(route(local)(fields)).resolves.toMatchObject({success: false});
    expect(local.translate).not.toHaveBeenCalled();
  });

  it('preserves a valid detection context and rejects duplicate active identifiers', async () => {
    const local = localDependencies();
    let finish!: (value: string) => void;
    local.translate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const dispatch = route(local);
    const result = dispatch({sourceLanguageDetectionText: 'English context'});
    await vi.waitFor(() => expect(local.translate).toHaveBeenCalledOnce());
    await expect(dispatch({})).resolves.toMatchObject({success: false, error: expect.stringContaining('正在执行')});
    finish('translated');
    await expect(result).resolves.toEqual({success: true, result: 'translated', requestId: 'route-1'});
  });

  it.each(['reject', 'invalid-result'] as const)('reports executor failure: %s', async (mode) => {
    const local = localDependencies();
    if (mode === 'reject') local.translate.mockRejectedValue(new Error('executor failed'));
    else local.translate.mockResolvedValue(null as never);
    await expect(route(local)({})).resolves.toMatchObject({success: false, requestId: 'route-1'});
  });

  it('validates cancellation and safely acknowledges an already settled request', async () => {
    const dispatch = route(localDependencies());
    await expect(dispatch({type: OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE, requestId: 'invalid request'}))
      .resolves.toMatchObject({success: false});
    await expect(dispatch({type: OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE}))
      .resolves.toEqual({success: true, cancelled: false, requestId: 'route-1'});
  });

  it('passes a signal to the local executor and supports cancellation', async () => {
    let resolveTranslation!: (value: string) => void;
    const translate = vi.fn((_message: OffscreenRequestMap['LOCAL_TRANSLATION_TRANSLATE'], _signal: AbortSignal) => new Promise<string>((resolve) => { resolveTranslation = resolve; }));
    const listener = createOffscreenMessageListener({
      ...baseOffscreenDependencies,
      translate: vi.fn(async () => 'chrome'),
      localTranslation: {
        translate,
        prepare: vi.fn(async () => translationSnapshot()),
        status: vi.fn(async () => ({models: []})),
        removeModel: vi.fn(async () => undefined),
      },
    });
    let response!: (value: unknown) => void;
    const responsePromise = new Promise<unknown>((resolve) => { response = resolve; });
    expect(listener({
      target: 'offscreen',
      type: 'LOCAL_TRANSLATION_TRANSLATE',
      requestId: 'local-1',
      model: LOCAL_TRANSLATION_MODEL_IDS.m2m100,
      text: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
    }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const signal = translate.mock.calls[0]?.[1] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    let cancelResponse!: (value: unknown) => void;
    const cancelPromise = new Promise<unknown>((resolve) => { cancelResponse = resolve; });
    expect(listener({
      target: 'offscreen',
      type: OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE,
      requestId: 'local-1',
    }, {}, cancelResponse)).toBe(true);
    await expect(cancelPromise).resolves.toEqual({success: true, cancelled: true, requestId: 'local-1'});
    await expect(responsePromise).resolves.toMatchObject({success: false, cancelled: true, requestId: 'local-1'});
    expect(signal.aborted).toBe(true);
    resolveTranslation('迟到译文');
  });
});
