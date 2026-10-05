import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildGlossaryRevision, type GlossaryLibrary} from '@/src/core/glossary';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getPageTranslationContext: vi.fn(),
  persistCountIncrement: vi.fn<(
    delta: number,
    sendMessage: (message: unknown) => Promise<unknown>,
    operationId: string,
  ) => Promise<number>>(async () => 0),
  getMissingCredentialMessage: vi.fn(() => null as string | null),
  config: {
    glossaryEnabled: false,
    glossaryLibraries: [] as GlossaryLibrary[],
    videoGlossaryIds: null as string[] | null,
    count: 0,
    maxConcurrentTranslations: 6,
    translationMaxRetries: 3,
    translationBackoffBaseMs: 1000,
    translationBackoffMaxMs: 30000,
    model: {
      mock: 'mock-model',
      'mock-ai': 'mock-ai-model',
      chromeTranslator: 'chrome-built-in',
    } as Record<string, string>,
    customModel: {mock: '', 'mock-ai': '', chromeTranslator: ''} as Record<string, string>,
    service: 'mock',
    from: 'en',
    to: 'zh-CN',
    useCache: true,
    enableAIContext: false,
    videoService: 'mock',
  },
}));

vi.mock('webextension-polyfill', () => ({
  default: {runtime: {sendMessage: mocks.sendMessage}},
}));
vi.mock('@/src/services/config/store', () => ({
  config: mocks.config,
  requestConfigCountIncrement: mocks.persistCountIncrement,
}));
vi.mock('@/src/core/language/detect', () => ({
  detectlang: () => 'eng',
  shouldSkipTranslationForTarget: () => false,
}));
vi.mock('@/src/core/config/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/core/config/catalog')>();
  return {
    ...actual,
    resolveConfiguredModel: (model: string) => model,
    servicesType: {
      ...actual.servicesType,
    isUseAIContext: (service: string) => service === 'mock-ai',
    isAiSdk: (service: string) => service === 'mock-ai',
    },
  };
});
vi.mock('@/src/services/translation/context', () => ({getPageTranslationContext: mocks.getPageTranslationContext}));
vi.mock('@/src/core/config/validation', () => ({getMissingCredentialMessage: mocks.getMissingCredentialMessage}));

import {cancelAllTranslations, translateText, translateTextBatch, translateVideoText} from '@/src/app/translation/client';
import {
  createTranslationCancelHandler,
  createTranslationRequestFallback,
  createTranslationRequestRegistry,
  type TranslationRequestContext,
} from '@/src/app/background/handlers/translation';
import {clearTranslationQueue} from '@/src/services/translation/queue';
import {getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe('translation API request lifecycle performance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendMessage.mockReset();
    mocks.getPageTranslationContext.mockReset();
    mocks.persistCountIncrement.mockReset().mockResolvedValue(0);
    mocks.getMissingCredentialMessage.mockReset().mockReturnValue(null);
    mocks.config.count = 0;
    mocks.config.glossaryEnabled = false;
    mocks.config.glossaryLibraries = [];
    mocks.config.videoGlossaryIds = null;
    mocks.config.maxConcurrentTranslations = 6;
    mocks.config.translationMaxRetries = 3;
    mocks.config.translationBackoffBaseMs = 1000;
    mocks.config.translationBackoffMaxMs = 30000;
    mocks.config.enableAIContext = false;
    mocks.config.service = 'mock';
    mocks.config.videoService = 'mock';
    mocks.config.from = 'en';
    mocks.config.to = 'zh-CN';
    mocks.config.useCache = true;
    mocks.config.model.mock = 'mock-model';
    mocks.config.model['mock-ai'] = 'mock-ai-model';
    mocks.config.model.chromeTranslator = 'chrome-built-in';
    Object.defineProperty(globalThis, 'document', {
      value: {title: 'Fixture video title'},
      configurable: true,
    });
    Object.defineProperty(globalThis, 'location', {
      value: {protocol: 'https:'},
      configurable: true,
    });
  });

  afterEach(async () => {
    clearTranslationQueue();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'document', {value: originalDocument, configurable: true});
    Object.defineProperty(globalThis, 'location', {value: originalLocation, configurable: true});
  });

  it.each(['single', 'batch', 'video'] as const)('术语版本和选择在 %s 的上下文提取前冻结', async kind => {
    mocks.config.service = 'mock-ai';
    mocks.config.videoService = 'mock-ai';
    mocks.config.enableAIContext = true;
    mocks.config.glossaryEnabled = true;
    mocks.config.glossaryLibraries = [{id: 'technical', name: 'Technical', enabled: true,
      sourceLanguage: '', targetLanguage: '', domains: [], entries: [{id: 'term', source: 'agent', target: '智能体', caseSensitive: false}]}];
    const ids = ['technical'];
    mocks.config.videoGlossaryIds = ids;
    const revision = buildGlossaryRevision(mocks.config.glossaryLibraries, true);
    const context = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(context.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    const request = kind === 'single' ? translateText('agent', 'Page', {glossaryIds: ids})
      : kind === 'batch' ? translateTextBatch(['agent'], 'Page', {glossaryIds: ids}) : translateVideoText('agent');
    ids.push('changed');
    mocks.config.glossaryLibraries[0].entries[0].target = '代理人';
    context.resolve('page context');
    await request;
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({glossaryIds: ['technical'], glossaryRevision: revision,
      ...(kind === 'video' ? {glossaryContext: 'video'} : {})}));
  });

  it('重试保持术语快照，版本更新错误不进行自动重试', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('network error')).mockResolvedValueOnce('重试译文');
    const ids = ['original'];
    const request = translateText('agent', 'Page', {glossaryIds: ids, glossaryRevision: 'glossary-v1:disabled', retryDelay: 1});
    await flushMicrotasks();
    ids.push('changed');
    await vi.advanceTimersByTimeAsync(2);
    await expect(request).resolves.toBe('重试译文');
    expect(mocks.sendMessage.mock.calls.every(([message]) => message.glossaryIds.length === 1 && message.glossaryIds[0] === 'original')).toBe(true);
    mocks.sendMessage.mockReset().mockResolvedValue({marker: 'fluentread-translation-error-v1',
      message: '术语库已更新，请重新翻译', kind: 'bad-request', retryable: false, code: 'GLOSSARY_REVISION_CHANGED'});
    await expect(translateText('agent', 'Page')).rejects.toMatchObject({code: 'GLOSSARY_REVISION_CHANGED'});
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('网页上下文不因无法读取 API Key 而阻止 background 请求', async () => {
    mocks.config.service = 'mock-ai';
    mocks.getMissingCredentialMessage.mockReturnValue('DeepSeek 需要 API Key（访问令牌），当前尚未配置');
    mocks.sendMessage.mockResolvedValue('网页译文');

    await expect(translateText('Readable source', 'Context', {maxRetries: 0})).resolves.toBe('网页译文');

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('网页批量翻译不因无法读取 API Key 而被本地拦截', async () => {
    mocks.config.service = 'mock-ai';
    mocks.getMissingCredentialMessage.mockReturnValue('DeepSeek 需要 API Key（访问令牌），当前尚未配置');
    mocks.sendMessage.mockResolvedValue(['网页批量译文']);

    await expect(translateTextBatch(['Readable source'], 'Context', {maxRetries: 0}))
      .resolves.toEqual(['网页批量译文']);

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('批量客户端拒绝数量正确但包含稀疏空槽的响应', async () => {
    mocks.sendMessage.mockResolvedValue(new Array(2));

    await expect(translateTextBatch(['First', 'Second'], 'Context', {maxRetries: 0}))
      .rejects.toThrow('批量翻译返回格式异常');
  });

  it('扩展页面仍会在本地凭据缺失时快速失败', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: {protocol: 'chrome-extension:'},
      configurable: true,
    });
    mocks.config.service = 'mock-ai';
    mocks.getMissingCredentialMessage.mockReturnValue('DeepSeek 需要 API Key（访问令牌），当前尚未配置');

    await expect(translateText('Readable source', 'Context', {maxRetries: 0}))
      .rejects.toThrow('DeepSeek 需要 API Key');

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('clears successful request timeouts and coalesces count persistence', async () => {
    mocks.sendMessage.mockResolvedValue('译文');

    const requests = Array.from({length: 24}, (_, index) =>
      translateText(`Readable source ${index}`, 'Context'));
    await expect(Promise.all(requests)).resolves.toHaveLength(24);

    // 所有 45 秒请求计时器均已清除，只剩共享的 500 毫秒计数持久化计时器。
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(1);
    expect(mocks.persistCountIncrement).toHaveBeenCalledWith(
      24,
      expect.any(Function),
      expect.stringMatching(/^count-/u),
    );
    expect(mocks.config.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('计数持久化失败后复用 operationId 重试，成功调用不会丢失或重复', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.sendMessage.mockResolvedValue('译文');
    mocks.persistCountIncrement
      .mockRejectedValueOnce(new Error('runtime disconnected'))
      .mockResolvedValueOnce(1);

    await expect(translateText('Retryable count source', 'Context', {maxRetries: 0})).resolves.toBe('译文');
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(1);
    const firstOperationId = mocks.persistCountIncrement.mock.calls[0]?.[2];

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(2);
    expect(mocks.persistCountIncrement.mock.calls[1]?.[2]).toBe(firstOperationId);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('失败或取消的翻译不会排入完成计数', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('provider unavailable'));

    await expect(translateText('Failed count source', 'Context', {maxRetries: 0}))
      .rejects.toThrow('provider unavailable');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('发送独立入口的服务、语言和模型覆盖，不修改网页默认配置', async () => {
    mocks.sendMessage.mockResolvedValue('文档译文');

    await expect(translateText('Document source', 'Document context', {
      serviceOverride: 'mock-ai',
      modelOverride: 'document-model',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      useCache: false,
      maxRetries: 0,
    })).resolves.toBe('文档译文');

    expect(mocks.config.service).toBe('mock');
    expect(mocks.config.to).toBe('zh-CN');
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'Document source',
      serviceOverride: 'mock-ai',
      modelOverride: 'document-model',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      useCache: false,
      requestTimeoutMs: 44_000,
    }));
    expect(mocks.config.model['mock-ai']).toBe('mock-ai-model');
  });

  it.each(['chromeTranslator', 'localTranslation'])('仅为本地 %s auto 转发纯检测样本', async (service) => {
    mocks.sendMessage.mockResolvedValue('译文');
    const markedText = '___FLUENTREAD_test_0_BEGIN___\nBonjour\n___FLUENTREAD_test_0_END___';

    await expect(translateText(markedText, 'Context', {
      serviceOverride: service,
      sourceLanguage: 'auto',
      targetLanguage: 'zh-Hans',
      sourceLanguageDetectionText: 'Bonjour',
      maxRetries: 0,
    })).resolves.toBe('译文');
    await expect(translateText(markedText, 'Context', {
      serviceOverride: service,
      sourceLanguage: 'fr',
      targetLanguage: 'zh-Hans',
      sourceLanguageDetectionText: 'Bonjour',
      maxRetries: 0,
    })).resolves.toBe('译文');
    await expect(translateText(markedText, 'Context', {
      serviceOverride: 'mock',
      sourceLanguage: 'auto',
      targetLanguage: 'zh-Hans',
      sourceLanguageDetectionText: 'Bonjour',
      maxRetries: 0,
    })).resolves.toBe('译文');

    const [chromeAuto, chromeExplicit, cloudAuto] = mocks.sendMessage.mock.calls.map(([message]) => message);
    expect(chromeAuto).toMatchObject({
      origin: markedText,
      serviceOverride: service,
      sourceLanguage: 'auto',
      sourceLanguageDetectionText: 'Bonjour',
      requestTimeoutMs: service === 'chromeTranslator' ? 299_000 : 44_000,
    });
    expect(chromeExplicit).not.toHaveProperty('sourceLanguageDetectionText');
    expect(cloudAuto).not.toHaveProperty('sourceLanguageDetectionText');
    expect(chromeExplicit).toMatchObject({requestTimeoutMs: service === 'chromeTranslator' ? 299_000 : 44_000});
    expect(cloudAuto).toMatchObject({requestTimeoutMs: 44_000});
  });

  it('普通单条和批量请求在排队前冻结默认服务、模型与语言', async () => {
    mocks.config.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    mocks.sendMessage.mockImplementation(({origin}: {origin: string | string[]}) => {
      if (origin === 'Blocking source') return blocker.promise;
      return Promise.resolve(Array.isArray(origin) ? origin.map(value => `译:${value}`) : `译:${origin}`);
    });

    const first = translateText('Blocking source', 'Context', {maxRetries: 0});
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    const queuedSingle = translateText('Queued source', 'Context', {maxRetries: 0});
    const queuedBatch = translateTextBatch(['Queued batch source'], 'Context', {maxRetries: 0});

    mocks.config.service = 'mock-ai';
    mocks.config.model['mock-ai'] = 'changed-model';
    mocks.config.from = 'ja';
    mocks.config.to = 'fr';
    blocker.resolve('阻塞请求译文');

    await expect(first).resolves.toBe('阻塞请求译文');
    await expect(queuedSingle).resolves.toBe('译:Queued source');
    await expect(queuedBatch).resolves.toEqual(['译:Queued batch source']);

    expect(mocks.sendMessage.mock.calls.slice(1).map(([message]) => message)).toEqual([
      expect.objectContaining({
        origin: 'Queued source',
        serviceOverride: 'mock',
        modelOverride: 'mock-model',
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
      }),
      expect.objectContaining({
        origin: ['Queued batch source'],
        serviceOverride: 'mock',
        modelOverride: 'mock-model',
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
      }),
    ]);
  });

  it('视频请求在排队前冻结视频服务、模型与语言', async () => {
    mocks.config.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    mocks.sendMessage
      .mockImplementationOnce(() => blocker.promise)
      .mockResolvedValueOnce('字幕译文');

    const first = translateText('Blocking source', 'Context', {maxRetries: 0});
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    mocks.config.videoService = 'mock-ai';
    mocks.config.model['mock-ai'] = 'video-model';
    mocks.config.from = 'en';
    mocks.config.to = 'ja';
    const video = translateVideoText('Queued subtitle');
    await Promise.resolve();

    mocks.config.videoService = 'mock';
    mocks.config.model['mock-ai'] = 'changed-video-model';
    mocks.config.from = 'de';
    mocks.config.to = 'fr';
    mocks.config.useCache = false;
    blocker.resolve('阻塞请求译文');

    await expect(first).resolves.toBe('阻塞请求译文');
    await expect(video).resolves.toBe('字幕译文');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      origin: 'Queued subtitle',
      serviceOverride: 'mock-ai',
      modelOverride: 'video-model',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      useCache: true,
    }));
  });

  it('lets migrated AI SDK services own retries and restores structured error details', async () => {
    mocks.config.service = 'mock-ai';
    mocks.sendMessage.mockResolvedValue({
      marker: 'fluentread-translation-error-v1',
      message: '当前翻译服务的 API Key 无效（HTTP 401）。',
      kind: 'authentication',
      retryable: false,
      statusCode: 401,
      requestId: 'req-test',
    });

    const request = translateText('Readable source', 'Context');
    await expect(request).rejects.toMatchObject({
      name: 'TranslationRequestError',
      statusCode: 401,
      retryable: false,
      requestId: 'req-test',
    });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retries browser-level network failures without repeating exhausted HTTP retries', async () => {
    mocks.config.service = 'mock-ai';
    const networkError = {
      marker: 'fluentread-translation-error-v1',
      message: 'Custom 服务网络连接失败，请检查网络或代理设置',
      kind: 'network',
      retryable: true,
    };
    mocks.sendMessage
      .mockResolvedValueOnce(networkError)
      .mockResolvedValueOnce(networkError)
      .mockResolvedValueOnce('网络恢复后的译文');

    const request = translateText('Readable source', 'Context', {retryDelay: 100});
    await vi.advanceTimersByTimeAsync(300);
    await expect(request).resolves.toBe('网络恢复后的译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);

    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue({
      marker: 'fluentread-translation-error-v1',
      message: '当前翻译服务的请求频率或配额已达上限（HTTP 429），请稍后重试。',
      kind: 'rate-limit',
      retryable: true,
      statusCode: 429,
    });

    await expect(translateText('Another readable source', 'Context', {retryDelay: 100}))
      .rejects.toMatchObject({kind: 'rate-limit', statusCode: 429});
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['freeTranslation', 'google'].flatMap(service =>
    ['single', 'batch', 'video'].map(kind => ({service, kind})),
  ))('$service 的 $kind 内部换线后不再重跑候选池', async ({service, kind}) => {
    mocks.config.service = service;
    mocks.config.videoService = service;
    mocks.sendMessage.mockRejectedValue(new Error('candidate pool exhausted'));
    const request = kind === 'single' ? translateText('Readable source', 'Context', {maxRetries: 3})
      : kind === 'batch' ? translateTextBatch(['First source', 'Second source'], 'Context', {maxRetries: 3})
      : translateVideoText('Readable subtitle');
    await expect(request).rejects.toThrow('candidate pool exhausted');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.config.translationMaxRetries).toBe(3);
  });

  it('读取任务调度设置，按指数退避并在上限处封顶', async () => {
    mocks.config.translationMaxRetries = 2;
    mocks.config.translationBackoffBaseMs = 600;
    mocks.config.translationBackoffMaxMs = 1000;
    mocks.sendMessage
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('退避后的译文');

    const request = translateText('Backoff source', 'Context');
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(599);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toBe('退避后的译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('尊重服务端 Retry-After，不被本地退避上限缩短', async () => {
    mocks.config.translationMaxRetries = 1;
    mocks.config.translationBackoffBaseMs = 100;
    mocks.config.translationBackoffMaxMs = 200;
    mocks.sendMessage
      .mockResolvedValueOnce({
        marker: 'fluentread-translation-error-v1',
        message: '请求频率超限',
        kind: 'rate-limit',
        retryable: true,
        retryAfterMs: 500,
      })
      .mockResolvedValueOnce('Retry-After 后的译文');

    const request = translateText('Retry-After source', 'Context');
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toBe('Retry-After 后的译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('扩展上下文失效时立即失败，不进入无效的传输重试', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));

    await expect(translateText('Readable source', 'Context', {retryDelay: 100}))
      .rejects.toThrow('Extension context invalidated.');

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a retry delay without sending another runtime request', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('temporary failure'));
    const controller = new AbortController();
    const request = translateText('Readable source', 'Context', {
      maxRetries: 3,
      retryDelay: 10_000,
      signal: controller.signal,
    });
    const outcome = request.catch((error) => error);

    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    // 请求没有成功，因此既不会保留重试计时器，也不会新增完成计数。
    expect(vi.getTimerCount()).toBe(0);
    cancelAllTranslations();
    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['chrome-text', 'video'])('%s abort 发送精确 cancel，中止后台 broker signal 并及时释放前台队列', async (client) => {
    mocks.config.maxConcurrentTranslations = 1;
    const registry = createTranslationRequestRegistry();
    const cancel = createTranslationCancelHandler(registry);
    const context = {sender: {tab: {id: 8}, frameId: 0, documentId: 'document-8'}};
    let brokerSignal!: AbortSignal;
    const translate = vi.fn((message: {origin: string}) => {
      if (message.origin === 'Second readable source') return Promise.resolve('第二段译文');
      brokerSignal = getTranslationRequestControl(message)!.signal;
      return new Promise<string>((_resolve, reject) => brokerSignal.addEventListener('abort', () => {
        const error = new Error('background broker aborted');
        error.name = 'AbortError';
        reject(error);
      }, {once: true}));
    });
    const fallback = createTranslationRequestFallback<TranslationRequestContext>({
      translate,
      serializeError: (error) => error,
      requestRegistry: registry,
    });
    mocks.sendMessage.mockImplementation((message: {type?: string; origin?: string}) => (
      message.type === 'fluentReadTranslationCancel'
        ? cancel.handle(message as never, context)
        : fallback.handle(message as never, context)
    ));
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const first = client === 'video' ? translateVideoText('First readable source', controller.signal) : translateText('First readable source', 'Context', {
      signal: controller.signal,
      maxRetries: 0,
      serviceOverride: 'chromeTranslator',
    });
    const firstOutcome = first.catch((error) => error);

    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    const firstRequest = mocks.sendMessage.mock.calls[0]?.[0];
    controller.abort();
    await expect(firstOutcome).resolves.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(brokerSignal.aborted).toBe(true));
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(mocks.sendMessage.mock.calls[1]?.[0]).toEqual({
      type: 'fluentReadTranslationCancel',
      clientRequestId: firstRequest.clientRequestId,
    });

    const second = client === 'video' ? translateVideoText('Second readable source') : translateText('Second readable source', 'Context', {maxRetries: 0});
    await expect(second).resolves.toBe('第二段译文');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('timeout 只发送一次 cancel，中止后台 broker signal 并让下一请求进队', async () => {
    mocks.config.maxConcurrentTranslations = 1;
    const registry = createTranslationRequestRegistry();
    const cancel = createTranslationCancelHandler(registry);
    const context = {sender: {tab: {id: 9}, frameId: 0}};
    let brokerSignal!: AbortSignal;
    const translate = vi.fn((message: {origin: string}) => {
      if (message.origin === 'Second timeout source') return Promise.resolve('第二段译文');
      brokerSignal = getTranslationRequestControl(message)!.signal;
      return new Promise<string>((_resolve, reject) => brokerSignal.addEventListener('abort', () => {
        const error = new Error('background broker aborted');
        error.name = 'AbortError';
        reject(error);
      }, {once: true}));
    });
    const fallback = createTranslationRequestFallback<TranslationRequestContext>({
      translate,
      serializeError: (error) => error,
      requestRegistry: registry,
    });
    mocks.sendMessage.mockImplementation((message: {type?: string; origin?: string}) => (
      message.type === 'fluentReadTranslationCancel'
        ? cancel.handle(message as never, context)
        : fallback.handle(message as never, context)
    ));
    const first = translateText('First timeout source', 'Context', {
      maxRetries: 0,
      timeout: 10_000,
      serviceOverride: 'chromeTranslator',
    });
    const firstOutcome = first.catch((error) => error);

    const second = translateText('Second timeout source', 'Context', {maxRetries: 0});
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(firstOutcome).resolves.toMatchObject({message: '翻译请求超时'});
    await vi.waitFor(() => expect(brokerSignal.aborted).toBe(true));
    const firstRequest = mocks.sendMessage.mock.calls[0]?.[0];
    expect(mocks.sendMessage.mock.calls.filter(([message]) => (
      message.type === 'fluentReadTranslationCancel'
    ))).toEqual([[{
      type: 'fluentReadTranslationCancel',
      clientRequestId: firstRequest.clientRequestId,
    }]]);
    await expect(second).resolves.toBe('第二段译文');
    // 第一条已取消请求不计数，第二条成功请求仍保留共享的延迟持久化任务。
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps AI context enabled without capturing it until the selected service supports it', async () => {
    mocks.config.enableAIContext = true;
    const pageContext = 'Page title: Fixture article\nReadable context for AI terminology.';
    mocks.getPageTranslationContext.mockResolvedValue(pageContext);
    mocks.sendMessage.mockImplementation(({origin}: {origin: string}) => Promise.resolve(`${origin}-译文`));

    await expect(translateText('Machine source', 'Fixture article', {maxRetries: 0}))
      .resolves.toBe('Machine source-译文');

    expect(mocks.getPageTranslationContext).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      origin: 'Machine source',
      serviceOverride: 'mock',
      pageContext: undefined,
    }));
    expect(mocks.config.enableAIContext).toBe(true);

    mocks.config.service = 'mock-ai';
    await expect(translateText('AI source', 'Fixture article', {maxRetries: 0}))
      .resolves.toBe('AI source-译文');

    expect(mocks.getPageTranslationContext).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      origin: 'AI source',
      serviceOverride: 'mock-ai',
      pageContext,
    }));
    expect(mocks.config.enableAIContext).toBe(true);
  });

  it('显式 AI 上下文策略覆盖实时配置并原样发送给 background', async () => {
    mocks.config.service = 'mock-ai';
    mocks.config.enableAIContext = false;
    const pageContext = 'Frozen full-page session context.';
    mocks.getPageTranslationContext.mockResolvedValue(pageContext);
    mocks.sendMessage.mockImplementation(({origin}: {origin: string | string[]}) => Promise.resolve(
      Array.isArray(origin) ? origin.map(value => `${value}-译文`) : `${origin}-译文`,
    ));

    await expect(translateText('Context-enabled source', 'Fixture article', {
      enableAIContext: true,
      maxRetries: 0,
    })).resolves.toBe('Context-enabled source-译文');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      enableAIContext: true,
      pageContext,
    }));

    mocks.config.enableAIContext = true;
    await expect(translateTextBatch(['Context-disabled source'], 'Fixture article', {
      enableAIContext: false,
      maxRetries: 0,
    })).resolves.toEqual(['Context-disabled source-译文']);
    expect(mocks.getPageTranslationContext).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      enableAIContext: false,
      pageContext: undefined,
    }));
  });


  it('video requests inherit the current webpage service and model while preserving an explicit override', async () => {
    mocks.config.videoService = '';
    mocks.config.service = 'mock-ai';
    mocks.sendMessage.mockResolvedValue('字幕译文');
    await translateVideoText('Inherited subtitle source');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({serviceOverride: 'mock-ai', modelOverride: 'mock-ai-model'}));
    mocks.config.service = 'mock';
    mocks.config.videoService = 'mock-ai';
    await translateVideoText('Independent subtitle source');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({serviceOverride: 'mock-ai', modelOverride: 'mock-ai-model'}));
  });

  it('uses independent video source language without changing webpage language', async () => {
    mocks.sendMessage.mockResolvedValue('今天是个好日子。');
    await expect(translateVideoText('오늘은 좋은 날입니다.', undefined, 'auto')).resolves.toBe('今天是个好日子。');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({sourceLanguage: 'auto', origin: '오늘은 좋은 날입니다.'}));
    await translateVideoText('안녕하세요.', undefined, 'ko');
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({sourceLanguage: 'ko'}));
    expect(mocks.config.from).toBe('en');
  });

  it('uses the video AI service when resolving and sending page context', async () => {
    mocks.config.enableAIContext = true;
    mocks.config.videoService = 'mock-ai';
    const pageContext = 'Page title: Fixture video title\nReadable page context for subtitle terminology.';
    mocks.getPageTranslationContext.mockResolvedValue(pageContext);
    mocks.sendMessage.mockResolvedValue('字幕译文');

    await expect(translateVideoText('A subtitle source')).resolves.toBe('字幕译文');

    expect(mocks.getPageTranslationContext).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      context: '视频字幕：Fixture video title',
      pageContext,
      origin: 'A subtitle source',
      useCache: true,
      serviceOverride: 'mock-ai',
      modelOverride: 'mock-ai-model',
      thinkingOverride: false,
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans',
      requestTimeoutMs: 19_000,
    }));
    expect(mocks.sendMessage.mock.calls[0]?.[0].clientRequestId).toEqual(expect.any(String));
  });
});
