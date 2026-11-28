import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {annotateVideoReading} from '@/src/features/video-subtitle/content/readingAnnotationClient';
import {createVideoReadingController} from '@/src/features/video-subtitle/content/readingAnnotationController';
import {VideoReadingAnnotationSession} from '@/src/features/video-subtitle/content/readingAnnotationSession';
import {startReadingAnnotationWorkerApp as startReadingAnnotationWorker} from '@/src/app/offscreen/readingAnnotationWorker';
import type {VideoReadingAnnotation} from '@/src/core/messaging/readingAnnotation';

const mocks = vi.hoisted(() => ({send: vi.fn(), capabilities: {extensionDom: true}, annotate: vi.fn()}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: mocks.send}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: mocks.capabilities}));
vi.mock('@/src/features/video-subtitle/reading/engine', () => ({annotateReading: mocks.annotate}));

const reading: VideoReadingAnnotation = {text: 'konnichiwa', language: 'ja', scheme: 'hepburn-ipadic-v1'};
const flush = async () => {for (let index = 0; index < 10; index += 1) await Promise.resolve();};
const deferred = () => {
  let resolve!: (value: VideoReadingAnnotation | null) => void, reject!: (error?: unknown) => void;
  const promise = new Promise<VideoReadingAnnotation | null>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve: (value: VideoReadingAnnotation | null) => resolve(value), reject: (error?: unknown) => reject(error)};
};

beforeEach(() => {mocks.send.mockReset(); mocks.annotate.mockReset(); mocks.capabilities.extensionDom = true;});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('内容脚本读音传输', () => {
  it('不支持或无可辨认文字时不启动后台，支持文字仅扩展版可用', async () => {
    await expect(annotateVideoReading('Hello', 'en', new AbortController().signal)).resolves.toBeNull();
    await expect(annotateVideoReading('日本', 'auto', new AbortController().signal)).resolves.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.capabilities.extensionDom = false;
    await expect(annotateVideoReading('こんにちは', 'ja', new AbortController().signal)).rejects.toThrow('浏览器扩展版');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('规范化语言，使用唯一请求标识并验证成功、无需标注、显式失败和损坏响应', async () => {
    vi.stubGlobal('crypto', {randomUUID: () => 'unique'});
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    mocks.send.mockResolvedValueOnce({success: true, result: reading});
    await expect(annotateVideoReading('こんにちは', 'JA_jp', controller.signal)).resolves.toEqual(reading);
    expect(mocks.send).toHaveBeenCalledWith({type: 'fluentReadAnnotateVideoReading', text: 'こんにちは', language: 'ja', requestId: 'reading:unique'});
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    mocks.send.mockResolvedValueOnce({success: true, result: null});
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).resolves.toBeNull();
    mocks.send.mockResolvedValueOnce({success: false, error: 'offline'});
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).rejects.toThrow('offline');
    mocks.send.mockResolvedValueOnce({success: false, error: ''});
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).rejects.toThrow('读音暂不可用');
    mocks.send.mockResolvedValueOnce({success: true, result: {text: 'missing fields'}});
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).rejects.toThrow('格式');
  });

  it('uuid不可用时仍生成符合协议的请求标识，传输拒绝后清理abort监听', async () => {
    vi.stubGlobal('crypto', {}); mocks.send.mockRejectedValue(new Error('transport'));
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).rejects.toThrow('transport');
    expect(mocks.send.mock.calls[0][0].requestId).toMatch(/^reading:[a-z0-9]+:[a-z0-9]+$/);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('已取消时不发送，等待中取消立即拒绝且只取消同一请求，迟到成功不会恢复', async () => {
    const stopped = new AbortController(); stopped.abort();
    await expect(annotateVideoReading('こんにちは', 'ja', stopped.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(mocks.send).not.toHaveBeenCalled();
    const waiting = deferred();
    mocks.send.mockImplementation(message => message.type === 'fluentReadCancelVideoReading' ? Promise.reject(new Error('closed')) : waiting.promise.then(result => ({success: true, result})));
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = annotateVideoReading('こんにちは', 'ja', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    controller.abort(); controller.abort(); await rejected;
    expect(mocks.send.mock.calls).toHaveLength(2);
    expect(mocks.send.mock.calls[1][0]).toEqual({type: 'fluentReadCancelVideoReading', requestId: mocks.send.mock.calls[0][0].requestId});
    waiting.resolve(reading); await flush(); expect(remove).toHaveBeenCalledOnce();
  });

  it('后台调用同步触发取消时，即使成功回包先进入race也不接受其结果', async () => {
    const controller = new AbortController();
    mocks.send.mockImplementation(message => {
      if (message.type === 'fluentReadAnnotateVideoReading') controller.abort();
      return Promise.resolve({success: true, result: reading});
    });
    await expect(annotateVideoReading('こんにちは', 'ja', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('当前原句读音控制器', () => {
  it('默认关闭、不支持语言和纯汉字auto均无后台工作，peek也不猜语言', () => {
    const annotate = vi.fn(), changed = vi.fn(); const controller = createVideoReadingController(annotate, changed);
    controller.sync('こんにちは', 'ja', false);
    expect(controller.state).toEqual({status: 'idle', result: null, source: '', language: ''});
    expect(changed).not.toHaveBeenCalled();
    controller.sync('Hello', 'en', true); expect(controller.state).toMatchObject({status: 'no-reading', source: 'Hello', language: ''});
    controller.sync('日本', 'auto', true); expect(controller.state).toMatchObject({status: 'no-reading', source: '日本', language: ''});
    controller.sync('日本', 'auto', true); expect(changed).toHaveBeenCalledTimes(2);
    expect(controller.peek('Hello', 'en')).toBeNull(); expect(controller.peek('こんにちは', 'ja')).toBeUndefined();
    controller.sync('', 'ja', true); expect(controller.state).toEqual({status: 'idle', result: null, source: '', language: ''});
    expect(annotate).not.toHaveBeenCalled(); controller.destroy();
  });

  it('合并当前句更新且只发布状态变化，关闭后重新显示直接命中缓存', async () => {
    const pending = deferred(), annotate = vi.fn(() => pending.promise), changed = vi.fn();
    const controller = createVideoReadingController(annotate, changed);
    controller.sync(' こんにちは\n世界 ', 'JA_jp', true); controller.sync('こんにちは 世界', 'jpn', true); await flush();
    expect(annotate).toHaveBeenCalledOnce(); expect(controller.state.status).toBe('loading');
    expect(controller.state.source).toBe('こんにちは 世界'); pending.resolve(reading); await flush();
    expect(controller.state).toMatchObject({status: 'ready', result: reading, language: 'ja'});
    controller.sync('こんにちは 世界', 'ja', true); expect(changed).toHaveBeenCalledTimes(2);
    controller.sync('こんにちは 世界', 'ja', false); expect(controller.state.status).toBe('idle');
    controller.sync('こんにちは 世界', 'ja', true); expect(controller.state.status).toBe('ready'); await flush();
    expect(annotate).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledTimes(4);
    expect(controller.peek('こんにちは 世界', 'ja')).toEqual(reading); controller.destroy();
  });

  it('换句同步撤掉旧读音并取消旧请求，旧成功和旧失败都不能污染新句', async () => {
    const old = deferred(), next = deferred(), annotate = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const controller = createVideoReadingController(annotate, vi.fn());
    controller.sync('こんにちは', 'ja', true); await flush();
    controller.sync('さようなら', 'ja', true); await flush(); expect(annotate.mock.calls[0][2].aborted).toBe(true);
    old.resolve(reading); await flush(); expect(controller.state).toMatchObject({status: 'loading', source: 'さようなら', result: null});
    next.resolve({...reading, text: 'sayōnara'}); await flush(); expect(controller.state.result?.text).toBe('sayōnara');
    const lateFailure = deferred(); annotate.mockReturnValueOnce(lateFailure.promise);
    controller.sync('ありがとう', 'ja', true); await flush(); controller.clear(); lateFailure.reject(new Error('late')); await flush();
    expect(controller.state.status).toBe('idle'); controller.destroy();
  });

  it('当前失败等待显式retry，相同cue不会轮询重发，当前AbortError也会结束loading', async () => {
    const annotate = vi.fn().mockRejectedValueOnce(new Error('failed')).mockRejectedValueOnce(new DOMException('cancel', 'AbortError')).mockResolvedValue(reading);
    const controller = createVideoReadingController(annotate, vi.fn());
    controller.sync('こんにちは', 'ja', true); await flush(); expect(controller.state.status).toBe('error');
    controller.sync('こんにちは', 'ja', true); await flush(); expect(annotate).toHaveBeenCalledOnce();
    controller.retry(); controller.sync('こんにちは', 'ja', true); await flush(); expect(controller.state.status).toBe('error');
    controller.retry(); controller.sync('こんにちは', 'ja', true); await flush(); expect(controller.state.status).toBe('ready');
    expect(annotate).toHaveBeenCalledTimes(3); controller.destroy();
  });

  it('空结果缓存为无需标注，重置清缓存，关闭卸载取消在途任务且之后不再同步', async () => {
    const annotate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(reading);
    const controller = createVideoReadingController(annotate, vi.fn());
    controller.sync('こんにちは', 'ja', true); await flush(); expect(controller.state).toMatchObject({status: 'no-reading', source: 'こんにちは'});
    controller.clear(); controller.sync('こんにちは', 'ja', true); await flush(); expect(annotate).toHaveBeenCalledOnce();
    controller.reset(); expect(controller.peek('こんにちは', 'ja')).toBeUndefined();
    controller.sync('こんにちは', 'ja', true); await flush(); expect(controller.state.status).toBe('ready');
    const pending = deferred(); annotate.mockReturnValueOnce(pending.promise);
    controller.sync('さようなら', 'ja', true); await flush(); controller.destroy();
    pending.resolve(reading); await flush(); controller.sync('こんにちは', 'ja', true);
    expect(controller.state).toEqual({status: 'idle', result: null, source: '', language: ''}); expect(annotate).toHaveBeenCalledTimes(3);
  });

  it('支持共享 session、peek 文本规范化、预取与窗口裁剪，销毁外部 session 不释放缓存', async () => {
    const sharedAnnotate = vi.fn(async (text: string, language: string): Promise<VideoReadingAnnotation | null> => ({text: `R:${text}`, language, scheme: 'shared'}));
    const shared = new VideoReadingAnnotationSession(sharedAnnotate);
    const controller = createVideoReadingController(vi.fn(), vi.fn(), {session: shared});
    expect(controller.session).toBe(shared);
    expect(controller.peek('   ', 'ja')).toBeNull();

    // 预取跳过空文本、无适用语言文本和已缓存文本，并支持窗口裁剪与默认语言参数。
    controller.prefetch(['', 'Hello', 'こんにちは', 'さようなら']);
    controller.retainPrefetches(['', 'Hello', 'こんにちは']);
    await flush();
    expect(sharedAnnotate).toHaveBeenCalledOnce();
    expect(controller.peek(' こんにちは\n ', 'ja')).toEqual({text: 'R:こんにちは', language: 'ja', scheme: 'shared'});

    // 缓存命中时 sync 直接发布 ready 且不重复调用 session.request。
    const requestSpy = vi.spyOn(shared, 'request');
    controller.sync('こんにちは', 'ja', true);
    expect(controller.state).toMatchObject({status: 'ready', result: {text: 'R:こんにちは'}});
    expect(requestSpy).not.toHaveBeenCalled();

    // 预取已缓存项跳过；销毁控制器后预取/裁剪无副作用，同轮已 resolve 的迟到结果在 clear 后不覆写状态。
    controller.prefetch(['こんにちは'], 'ja');
    controller.retainPrefetches(['こんにちは'], 'ja');
    expect(requestSpy).not.toHaveBeenCalled();
    const late = deferred();
    sharedAnnotate.mockReturnValueOnce(late.promise);
    controller.sync('ありがとう', 'ja', true);
    await flush();
    late.resolve({text: 'arigatou', language: 'ja', scheme: 'shared'});
    await Promise.resolve();
    await Promise.resolve();
    controller.clear();
    await flush();
    expect(controller.state.status).toBe('idle');
    controller.destroy();
    controller.prefetch(['ありがとう'], 'ja');
    controller.retainPrefetches(['ありがとう'], 'ja');
    expect(shared.peek('こんにちは', 'ja')).toEqual({text: 'R:こんにちは', language: 'ja', scheme: 'shared'});
    shared.destroy();
  });
});

describe('读音Worker入口', () => {
  function setup() {
    let listener!: (event: MessageEvent<unknown>) => void;
    const scope = {location: {href: 'chrome-extension://extension/readingAnnotationWorker.js'},
      addEventListener: vi.fn((_type: 'message', handle: typeof listener) => {listener = handle;}), postMessage: vi.fn()};
    startReadingAnnotationWorker(scope);
    return {scope, send: (data: unknown) => listener({data} as MessageEvent)};
  }
  it('无效请求不加载引擎，合法请求只采用Worker固定词典标识并保持编号', async () => {
    const {scope, send} = setup();
    for (const value of [null, {}, {id: 0, text: 'こんにちは', language: 'ja'}, {id: 1, text: '', language: 'ja'}, {id: 2, text: 'hello', language: 'en'}, {id: 3, text: 'あ'.repeat(3001), language: 'ja'}]) send(value);
    expect(mocks.annotate).not.toHaveBeenCalled(); expect(scope.postMessage).not.toHaveBeenCalled();
    mocks.annotate.mockResolvedValue(reading); send({id: 4, text: 'こんにちは', language: 'ja', dictionaryUrl: 'https://untrusted.test/dict'}); await flush();
    expect(mocks.annotate).toHaveBeenCalledWith('こんにちは', 'ja', 'chrome-extension://extension/reading-dictionary/ja/');
    expect(scope.postMessage).toHaveBeenCalledWith({id: 4, ok: true, result: reading});
  });
  it('空结果正常回复，失败只回通用错误且不终止后续消息', async () => {
    const {scope, send} = setup();
    mocks.annotate.mockRejectedValueOnce(new Error('private engine path')).mockResolvedValueOnce(null).mockResolvedValue(reading);
    send({id: 1, text: 'こんにちは', language: 'ja'}); await flush();
    expect(scope.postMessage).toHaveBeenLastCalledWith({id: 1, ok: false, error: '读音暂不可用'});
    send({id: 2, text: 'こんにちは', language: 'ja'}); await flush(); expect(scope.postMessage).toHaveBeenLastCalledWith({id: 2, ok: true, result: null});
    send({id: 3, text: 'こんにちは', language: 'ja'}); await flush(); expect(scope.postMessage).toHaveBeenLastCalledWith({id: 3, ok: true, result: reading});
  });
});
