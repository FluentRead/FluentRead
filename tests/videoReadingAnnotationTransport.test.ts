import {afterEach, describe, expect, it, vi, type Mock} from 'vitest';
import {createReadingAnnotationRuntime} from '@/src/features/video-subtitle/offscreen/readingAnnotation';
import {createVideoReadingAnnotationHandlers} from '@/src/features/video-subtitle/background/readingAnnotation';
import {isReadingAnnotationWorkerRequest, isReadingAnnotationWorkerResponse, parseReadingAnnotationResponse, type ReadingAnnotationInput, type ReadingAnnotationRequest} from '@/src/core/messaging/readingAnnotation';
import {parseOffscreenRequest, parseOffscreenResponse} from '@/src/core/messaging/offscreen';
import {createOffscreenMessageListener, type OffscreenMessageDependencies} from '@/src/app/offscreen/messageRouter';
import type {OffscreenClient} from '@/src/platform/offscreen/client';
import {READING_ANNOTATION_REQUEST_TIMEOUT_MS, READING_ANNOTATION_WORKER_TIMEOUT_MS} from '@/src/core/readingAnnotation';

type AnnotateReading = NonNullable<OffscreenMessageDependencies['readingAnnotation']>['annotate'];

const reading = {text: 'konnichiwa', language: 'ja', scheme: 'hepburn'};
const input = {text: 'こんにちは', language: 'ja'};
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const owner = (tab = 1, frame = 0, documentId = 'doc') => ({sender: {id: 'extension', tab: {id: tab}, frameId: frame, documentId}});
function fakeWorker() {
  const instance = {postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null} as unknown as Worker;
  return {instance, reply: (data: unknown) => instance.onmessage?.call(instance, {data} as MessageEvent),
    fail: () => instance.onerror?.call(instance, {} as ErrorEvent)};
}

afterEach(() => vi.useRealTimers());

describe('读音标注消息边界', () => {
  it('严格限制请求文本、语言、请求标识及Worker回包，允许明确无需标注结果', () => {
    const request = {...input, requestId: 'reading:1'};
    expect(parseOffscreenRequest('READING_ANNOTATION', request)).toEqual(request);
    expect(parseOffscreenRequest('READING_ANNOTATION_CANCEL', {requestId: 'reading:1'})).toEqual({requestId: 'reading:1'});
    for (const invalid of [{...request, text: ''}, {...request, text: 'a'.repeat(3001)}, {...request, language: 'auto'}, {...request, requestId: '../bad'}]) {
      expect(() => parseOffscreenRequest('READING_ANNOTATION', invalid)).toThrow();
    }
    for (const result of [reading, null]) {
      expect(parseReadingAnnotationResponse({success: true, result})).toEqual({success: true, result});
      expect(parseOffscreenResponse('READING_ANNOTATION', {success: true, result})).toEqual({success: true, result});
    }
    expect(parseOffscreenResponse('READING_ANNOTATION_CANCEL', {success: true, cancelled: false})).toEqual({success: true, cancelled: false});
    expect(parseReadingAnnotationResponse({success: false, error: 'failed'})).toEqual({success: false, error: 'failed'});
    for (const result of [{...reading, text: ''}, {...reading, scheme: ''}, {...reading, text: 'a'.repeat(12001)}, {...reading, scheme: 'a'.repeat(65)}]) {
      expect(() => parseReadingAnnotationResponse({success: true, result})).toThrow();
    }
    expect(isReadingAnnotationWorkerRequest({id: 1, ...input})).toBe(true);
    expect(isReadingAnnotationWorkerRequest({id: 0, ...input})).toBe(false);
    for (const reply of [null, {}, {id: 0, ok: true, result: reading}, {id: 1, ok: false}, {id: 1, ok: 'yes'}, {id: 1, ok: true, result: {}}]) expect(isReadingAnnotationWorkerResponse(reply)).toBe(false);
    expect(isReadingAnnotationWorkerResponse({id: 1, ok: true, result: null})).toBe(true);
    expect(isReadingAnnotationWorkerResponse({id: 1, ok: false, error: 'offline'})).toBe(true);
  });
});

describe('离屏读音Worker资源归属', () => {
  it('首次请求才创建Worker，串行处理，忽略无关消息，空闲释放后按需重建', async () => {
    vi.useFakeTimers(); const first = fakeWorker(), second = fakeWorker();
    const createWorker = vi.fn().mockReturnValueOnce(first.instance).mockReturnValue(second.instance);
    const runtime = createReadingAnnotationRuntime({createWorker}); expect(createWorker).not.toHaveBeenCalled();
    const envelope: ReadingAnnotationInput & {id: number; requestId: string} = {...input, id: 999, requestId: 'offscreen:1'};
    const a = runtime.annotate(envelope), b = runtime.annotate({...input, text: '次'});
    expect(first.instance.postMessage).toHaveBeenCalledTimes(1);
    expect(first.instance.postMessage).toHaveBeenCalledWith({id: 1, ...input});
    first.reply(null); first.reply({id: 999, ok: true, result: reading});
    first.reply({id: 1, ok: true, result: reading}); await expect(a).resolves.toEqual(reading);
    expect(first.instance.postMessage).toHaveBeenLastCalledWith({id: 2, text: '次', language: 'ja'});
    first.reply({id: 2, ok: true, result: null}); await expect(b).resolves.toBeNull();
    first.reply({id: 2, ok: true, result: reading});
    vi.advanceTimersByTime(29_999); expect(first.instance.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(first.instance.terminate).toHaveBeenCalledOnce();
    const c = runtime.annotate(input); second.reply({id: 3, ok: true, result: reading}); await c;
    second.fail(); expect(second.instance.terminate).toHaveBeenCalledOnce(); runtime.dispose();
  });

  it('慢下载超过旧预算后换句不重启共享词典，取消句不派发或泄漏迟到结果', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker(); const createWorker = vi.fn(() => worker.instance);
    const runtime = createReadingAnnotationRuntime({createWorker});
    const oldAbort = new AbortController(), queuedAbort = new AbortController();
    const old = runtime.annotate(input, oldAbort.signal), queued = runtime.annotate(input, queuedAbort.signal);
    const oldRejected = expect(old).rejects.toMatchObject({name: 'AbortError'}), queuedRejected = expect(queued).rejects.toMatchObject({name: 'AbortError'});
    await vi.advanceTimersByTimeAsync(45_000);
    expect(worker.instance.terminate).not.toHaveBeenCalled();
    oldAbort.abort(); queuedAbort.abort(); await oldRejected; await queuedRejected;
    const latest = runtime.annotate({...input, text: '次の文'});
    expect(worker.instance.postMessage).toHaveBeenCalledTimes(1); expect(worker.instance.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    worker.reply({id: 1, ok: true, result: reading});
    expect(worker.instance.postMessage).toHaveBeenLastCalledWith({id: 3, text: '次の文', language: 'ja'});
    const latestReading = {...reading, text: 'tsugi no bun'};
    worker.reply({id: 1, ok: true, result: reading});
    worker.reply({id: 3, ok: true, result: latestReading});
    await expect(latest).resolves.toEqual(latestReading);
    expect(createWorker).toHaveBeenCalledOnce();
    const pending = runtime.annotate(input); const pendingRejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    const queuedOnDispose = runtime.annotate(input); const queuedOnDisposeRejected = expect(queuedOnDispose).rejects.toMatchObject({name: 'AbortError'});
    runtime.dispose(); await pendingRejected; await queuedOnDisposeRejected;
    await expect(runtime.annotate(input)).rejects.toMatchObject({name: 'AbortError'});
    const stopped = new AbortController(); stopped.abort();
    await expect(createReadingAnnotationRuntime({createWorker}).annotate(input, stopped.signal)).rejects.toMatchObject({name: 'AbortError'});
  });

  it('首次下载等待仍有总上限，到期回收Worker并允许重试', async () => {
    vi.useFakeTimers(); const worker = fakeWorker(), retryWorker = fakeWorker();
    const createWorker = vi.fn().mockReturnValueOnce(worker.instance).mockReturnValue(retryWorker.instance);
    const runtime = createReadingAnnotationRuntime({createWorker});
    const pending = runtime.annotate(input), rejected = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(READING_ANNOTATION_WORKER_TIMEOUT_MS - 1);
    expect(worker.instance.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(worker.instance.terminate).toHaveBeenCalledOnce();
    const retry = runtime.annotate(input);
    retryWorker.reply({id: 2, ok: true, result: reading});
    await expect(retry).resolves.toEqual(reading);
    runtime.dispose();
  });

  it('超时、损坏回包和Worker错误都回收实例，后续任务可以重试', async () => {
    vi.useFakeTimers(); const workers = Array.from({length: 6}, () => fakeWorker()); let index = 0;
    const runtime = createReadingAnnotationRuntime({createWorker: () => workers[index++].instance, timeoutMs: 50, idleMs: 20});
    const timeout = runtime.annotate(input); const timedOut = expect(timeout).rejects.toThrow('超时'); vi.advanceTimersByTime(50); await timedOut;
    const malformed = runtime.annotate(input); const malformedRejected = expect(malformed).rejects.toThrow('格式'); workers[1].reply({id: 2, ok: true, result: {}}); await malformedRejected;
    const mismatch = runtime.annotate(input); const mismatchRejected = expect(mismatch).rejects.toThrow('语言'); workers[2].reply({id: 3, ok: true, result: {...reading, language: 'ko'}}); await mismatchRejected;
    const crash = runtime.annotate(input); const crashRejected = expect(crash).rejects.toThrow('执行'); workers[3].fail(); await crashRejected;
    const clone = runtime.annotate(input); const cloneRejected = expect(clone).rejects.toThrow('读取'); workers[4].instance.onmessageerror?.call(workers[4].instance, {} as MessageEvent); await cloneRejected;
    const engineFailure = runtime.annotate(input); const engineRejected = expect(engineFailure).rejects.toThrow('failed'); workers[5].reply({id: 6, ok: false, error: 'failed'}); await engineRejected;
    const retry = runtime.annotate(input); workers[5].reply({id: 7, ok: true, result: reading}); await retry;
    runtime.dispose();
  });

  it('创建和postMessage异常不锁死槽位，队列有界且新请求延后空闲回收', async () => {
    vi.useFakeTimers(); const worker = fakeWorker(); const createWorker = vi.fn().mockImplementationOnce(() => {throw new Error('create');}).mockReturnValue(worker.instance);
    const runtime = createReadingAnnotationRuntime({createWorker});
    await expect(runtime.annotate(input)).rejects.toThrow('create');
    (worker.instance.postMessage as Mock<Worker['postMessage']>).mockImplementationOnce(() => {throw new Error('post');});
    await expect(runtime.annotate(input)).rejects.toThrow('post');
    const active = runtime.annotate(input); const jobs = Array.from({length: 16}, () => runtime.annotate(input));
    await expect(runtime.annotate(input)).rejects.toThrow('队列已满');
    const outcomes = Promise.allSettled([active, ...jobs]); runtime.dispose(); await outcomes;
    const otherWorker = fakeWorker(); const other = createReadingAnnotationRuntime({createWorker: () => otherWorker.instance, idleMs: 20});
    const first = other.annotate(input); otherWorker.reply({id: 1, ok: true, result: null}); await first;
    vi.advanceTimersByTime(10); const second = other.annotate(input); vi.advanceTimersByTime(10); expect(otherWorker.instance.terminate).not.toHaveBeenCalled();
    otherWorker.reply({id: 2, ok: true, result: null}); await second; other.dispose();
  });
});

describe('后台读音发送方与取消隔离', () => {
  it('真实content信封依次路由到离屏与Worker，只转发正文语言并保留各层自有编号', async () => {
    const worker = fakeWorker();
    const runtime = createReadingAnnotationRuntime({createWorker: () => worker.instance});
    const dependencies = {runtimeId: 'extension', readingAnnotation: runtime,
      translate: vi.fn(), ttsPlayer: {play: vi.fn(), stop: vi.fn(), seek: vi.fn()}, fetchImage: vi.fn(), translateImage: vi.fn(), translateArea: vi.fn(), downloadOcrLanguages: vi.fn()} as OffscreenMessageDependencies;
    const listener = createOffscreenMessageListener(dependencies);
    const send = vi.fn((message: object) => new Promise(resolve => listener({...message, target: 'offscreen'}, {id: 'extension'}, resolve)));
    const handlers = createVideoReadingAnnotationHandlers({runtimeId: 'extension', offscreen: {send} as unknown as OffscreenClient, createRequestId: () => 'offscreen:unique'});
    const envelope: ReadingAnnotationRequest & {type: 'fluentReadAnnotateVideoReading'; id: number} = {
      type: 'fluentReadAnnotateVideoReading', ...input, requestId: 'page:1', id: 999,
    };
    const pending = handlers[0].handle(envelope, owner()); await flush();
    expect(send).toHaveBeenCalledWith({type: 'READING_ANNOTATION', ...input, requestId: 'offscreen:unique'}, expect.objectContaining({signal: expect.any(AbortSignal), timeoutMs: READING_ANNOTATION_REQUEST_TIMEOUT_MS}));
    expect(worker.instance.postMessage).toHaveBeenCalledWith({id: 1, ...input});
    worker.reply({id: 1, ok: true, result: reading});
    await expect(pending).resolves.toEqual({success: true, result: reading});
    runtime.dispose();
  });

  it('绑定tab/frame/document所有权，在离屏等待期间取消并忽略迟到成功', async () => {
    let complete!: (value: unknown) => void;
    const send = vi.fn((_message: unknown, _options: {signal: AbortSignal}) => new Promise(resolve => {complete = resolve;}));
    const handlers = createVideoReadingAnnotationHandlers({runtimeId: 'extension', offscreen: {send} as unknown as OffscreenClient, createRequestId: () => 'offscreen:unique'});
    const request: ReadingAnnotationRequest & {type: 'fluentReadAnnotateVideoReading'} = {type: 'fluentReadAnnotateVideoReading', ...input, requestId: 'page:1'};
    const pending = handlers[0].handle(request as never, owner()); await flush();
    expect(await handlers[1].handle({requestId: 'page:1'} as never, owner(2))).toMatchObject({cancelled: false});
    expect(await handlers[1].handle({requestId: 'page:1'} as never, owner(1, 1))).toMatchObject({cancelled: false});
    expect(await handlers[1].handle({requestId: 'page:1'} as never, owner(1, 0, 'new-document'))).toMatchObject({cancelled: false});
    expect(send.mock.calls[0][1].signal.aborted).toBe(false);
    expect(await handlers[1].handle({requestId: 'page:1'} as never, owner())).toMatchObject({cancelled: true});
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
    expect(send.mock.calls[0][0]).toEqual({type: 'READING_ANNOTATION', ...input, requestId: 'offscreen:unique'});
    complete({success: true, result: reading}); await expect(pending).resolves.toMatchObject({success: false, error: '读音标注已取消'});
  });

  it('拒绝损坏、非内容页面和重复标识，先取消不会启动，失败后可以新请求', async () => {
    const send = vi.fn().mockResolvedValue({success: true, result: reading});
    const handlers = createVideoReadingAnnotationHandlers({runtimeId: 'extension', offscreen: {send} as unknown as OffscreenClient});
    const request = {...input, requestId: 'page:1'};
    for (const context of [{}, {sender: {id: 'extension'}}, {sender: {id: 'other', tab: {id: 1}}}, owner(-1)]) await expect(handlers[0].handle(request as never, context)).rejects.toThrow('发送方');
    await expect(handlers[0].handle({...request, text: ''} as never, owner())).rejects.toThrow('格式');
    expect(() => handlers[1].handle({requestId: '../bad'} as never, owner())).toThrow('格式');
    expect(() => handlers[1].handle({requestId: 'valid'} as never, {})).toThrow('发送方');
    await handlers[1].handle({requestId: 'page:1'} as never, owner());
    await expect(handlers[0].handle(request as never, owner())).resolves.toMatchObject({success: false}); expect(send).not.toHaveBeenCalled();
    const first = handlers[0].handle(request as never, owner());
    await expect(handlers[0].handle(request as never, owner())).rejects.toThrow('重复'); await first;
    expect(send.mock.calls[0][0].requestId).toMatch(/^reading:/);
    send.mockRejectedValueOnce(new Error('offline'));
    await expect(handlers[0].handle(request as never, owner())).rejects.toThrow('offline');
    await expect(handlers[0].handle(request as never, owner())).resolves.toMatchObject({success: true});
  });

  it('同时挂起和先取消记录都有上限，未带frame/document的发送方仍使用稳定隔离键', async () => {
    const send = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const handlers = createVideoReadingAnnotationHandlers({runtimeId: 'extension', offscreen: {send} as unknown as OffscreenClient, createRequestId: () => 'unique'});
    const minimalOwner = {sender: {id: 'extension', tab: {id: 1}}};
    for (let index = 0; index < 257; index += 1) await handlers[1].handle({requestId: `cancel:${index}`} as never, minimalOwner);
    void handlers[0].handle({...input, requestId: 'cancel:0'} as never, minimalOwner);
    await expect(handlers[0].handle({...input, requestId: 'cancel:256'} as never, minimalOwner)).resolves.toMatchObject({success: false});
    for (let index = 0; index < 31; index += 1) void handlers[0].handle({...input, requestId: `pending:${index}`} as never, minimalOwner);
    await expect(handlers[0].handle({...input, requestId: 'overflow'} as never, minimalOwner)).rejects.toThrow('队列已满');
    expect(send).toHaveBeenCalledTimes(32);
  });
});

describe('离屏读音路由', () => {
  function setup(annotate = vi.fn<AnnotateReading>(async () => reading), feature = true) {
    const dependencies = {runtimeId: 'extension', readingAnnotation: feature ? {annotate} : undefined,
      translate: vi.fn(), ttsPlayer: {play: vi.fn(), stop: vi.fn(), seek: vi.fn()}, fetchImage: vi.fn(), translateImage: vi.fn(), translateArea: vi.fn(), downloadOcrLanguages: vi.fn()} as OffscreenMessageDependencies;
    const listener = createOffscreenMessageListener(dependencies);
    const dispatch = (message: object, sender: unknown = {id: 'extension'}) => new Promise<any>(resolve => listener({target: 'offscreen', ...message}, sender, resolve));
    return {annotate, listener, dispatch};
  }
  it('只接受后台代理，完整校验输入和结果，传播失败与null结果', async () => {
    const request = {type: 'READING_ANNOTATION', ...input, requestId: 'a'};
    const {dispatch, annotate} = setup();
    for (const sender of [{}, {id: 'other'}, {id: 'extension', tab: {id: 1}}]) await expect(dispatch(request, sender)).resolves.toMatchObject({success: false});
    await expect(setup(undefined, false).dispatch(request)).resolves.toMatchObject({success: false});
    await expect(dispatch({...request, text: ''})).resolves.toMatchObject({success: false});
    await expect(dispatch(request)).resolves.toEqual({success: true, result: reading});
    annotate.mockResolvedValueOnce(null as never); await expect(dispatch({...request, requestId: 'b'})).resolves.toEqual({success: true, result: null});
    annotate.mockResolvedValueOnce({text: ''} as never); await expect(dispatch({...request, requestId: 'c'})).resolves.toMatchObject({success: false, error: '读音标注结果无效'});
    annotate.mockRejectedValueOnce(new Error('engine')); await expect(dispatch({...request, requestId: 'd'})).resolves.toMatchObject({success: false, error: 'engine'});
  });

  it('先取消、重复请求与在途取消均不放行旧结果，回复保持一次', async () => {
    let complete!: (value: typeof reading) => void;
    const annotate = vi.fn<AnnotateReading>(() => new Promise<typeof reading>(resolve => {complete = resolve;}));
    const {dispatch} = setup(annotate); const request = {type: 'READING_ANNOTATION', ...input, requestId: 'a'};
    await dispatch({type: 'READING_ANNOTATION_CANCEL', requestId: 'a'});
    await expect(dispatch(request)).resolves.toMatchObject({success: false}); expect(annotate).not.toHaveBeenCalled();
    const pending = dispatch(request); await flush();
    await expect(dispatch(request)).resolves.toMatchObject({success: false, error: '读音标注请求标识重复'});
    await expect(dispatch({type: 'READING_ANNOTATION_CANCEL', requestId: 'a'})).resolves.toMatchObject({success: true, cancelled: true});
    await expect(pending).resolves.toMatchObject({success: false, cancelled: true});
    expect(annotate.mock.calls[0][1]!.aborted).toBe(true); complete(reading); await flush();
    await expect(dispatch({type: 'READING_ANNOTATION_CANCEL', requestId: '../bad'})).resolves.toMatchObject({success: false});
    for (let index = 0; index < 257; index += 1) await dispatch({type: 'READING_ANNOTATION_CANCEL', requestId: `cancel:${index}`});
    await expect(dispatch({...request, requestId: 'cancel:256'})).resolves.toMatchObject({success: false});
  });
});
