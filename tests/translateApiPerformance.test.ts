import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildGlossaryRevision, type GlossaryLibrary} from '@/src/core/glossary';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';

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
    privateTranslation: undefined as {enabled: boolean; service: string; model: string} | undefined,
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
    nativeBatchTranslationEnabled: {} as Record<string, boolean>,
    videoService: 'mock',
    compositeTranslationProviders: [] as CompositeTranslationProvider[],
    aiRequestTimeoutMs: undefined as number | undefined,
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
    isAI: (service: string) => service === 'mock-ai' || actual.servicesType.isAI(service),
    isUseAIContext: (service: string) => service === 'mock-ai',
    isAiSdk: (service: string) => service === 'mock-ai',
    },
  };
});
vi.mock('@/src/services/translation/context', () => ({getPageTranslationContext: mocks.getPageTranslationContext}));
vi.mock('@/src/core/config/validation', () => ({getMissingCredentialMessage: mocks.getMissingCredentialMessage}));

import {cancelAllTranslations, getTranslationTimeout, translateText, translateTextBatch, translateVideoText} from '@/src/services/translation/client';
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

type ContextClient = 'single' | 'batch' | 'video';

function contextGateRequest(
  kind: ContextClient,
  signal?: AbortSignal,
  contextOptions: {pageContext?: string; enableAIContext?: boolean} = {},
): Promise<string | string[]> {
  return kind === 'video' ? translateVideoText('Context gate source', signal)
    : kind === 'batch' ? translateTextBatch(['Context gate source'], 'Page', {signal, maxRetries: 0, ...contextOptions})
      : translateText('Context gate source', 'Page', {signal, maxRetries: 0, ...contextOptions});
}

function enableContextGate(): void {
  mocks.config.service = 'mock-ai';
  mocks.config.videoService = 'mock-ai';
  mocks.config.enableAIContext = true;
}

describe('translation API request lifecycle performance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendMessage.mockReset();
    mocks.getPageTranslationContext.mockReset();
    mocks.persistCountIncrement.mockReset().mockResolvedValue(0);
    mocks.getMissingCredentialMessage.mockReset().mockReturnValue(null);
    mocks.config.privateTranslation = undefined;
    mocks.config.count = 0;
    mocks.config.glossaryEnabled = false;
    mocks.config.glossaryLibraries = [];
    mocks.config.videoGlossaryIds = null;
    mocks.config.maxConcurrentTranslations = 6;
    mocks.config.translationMaxRetries = 3;
    mocks.config.translationBackoffBaseMs = 1000;
    mocks.config.translationBackoffMaxMs = 30000;
    mocks.config.enableAIContext = false;
    mocks.config.nativeBatchTranslationEnabled = {};
    mocks.config.service = 'mock';
    mocks.config.videoService = 'mock';
    mocks.config.compositeTranslationProviders = [];
    mocks.config.aiRequestTimeoutMs = undefined;
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

  it.each([false, true])('Chrome 批量标记 %s 的公开预算与真实客户端请求保持一致，显式覆盖优先', async batch => {
    const expected = batch ? 45_000 : 300_000;
    expect(getTranslationTimeout('chromeTranslator', undefined, batch)).toBe(expected);
    expect(getTranslationTimeout('chromeTranslator', 2_000, batch)).toBe(2_000);
    mocks.config.service = 'chromeTranslator';
    mocks.sendMessage.mockResolvedValue(batch ? ['内置译文'] : '内置译文');
    if (batch) await translateTextBatch(['Chrome budget source'], 'Page', {maxRetries: 0});
    else await translateText('Chrome budget source', 'Page', {maxRetries: 0});
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: expected - 1_000});
  });

  it.each([10_000, 600_000].flatMap(timeout => [false, true].map(batch => ({timeout, batch}))))
  ('AI $timeout 毫秒配置在批量标记 $batch 的公开预算及真实请求中保留', async ({timeout, batch}) => {
    mocks.config.service = 'mock-ai';
    mocks.config.aiRequestTimeoutMs = timeout;
    expect(getTranslationTimeout('mock-ai', undefined, batch)).toBe(timeout + 1_000);
    expect(getTranslationTimeout('mock-ai', 2_000, batch)).toBe(2_000);
    mocks.sendMessage.mockResolvedValue(batch ? ['配置预算译文'] : '配置预算译文');
    if (batch) await translateTextBatch(['AI budget source'], 'Page', {maxRetries: 0});
    else await translateText('AI budget source', 'Page', {maxRetries: 0});
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: timeout});
  });

  it.each(['single', 'batch', 'video'] as const)('%s AI 默认允许超过 45 秒响应，并完整提供 120 秒后台预算', async kind => {
    mocks.config.service = 'mock-ai';
    mocks.config.videoService = 'mock-ai';
    const transport = deferred<string | string[]>();
    mocks.sendMessage.mockReturnValue(transport.promise);
    const request = contextGateRequest(kind);
    await flushMicrotasks();
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: 120_000});
    await vi.advanceTimersByTimeAsync(60_000);
    transport.resolve(kind === 'batch' ? ['缓慢模型译文'] : '缓慢模型译文');
    await expect(request).resolves.toEqual(kind === 'batch' ? ['缓慢模型译文'] : '缓慢模型译文');
  });

  it.each(['single', 'batch', 'video'] as const)('%s AI 在等待前冻结用户预算，外层只增加一秒收取后台结果', async kind => {
    mocks.config.service = 'mock-ai';
    mocks.config.videoService = 'mock-ai';
    mocks.config.translationMaxRetries = 0;
    mocks.config.aiRequestTimeoutMs = 180_000;
    mocks.config.enableAIContext = true;
    const context = deferred<string>();
    const transport = deferred<string | string[]>();
    mocks.getPageTranslationContext.mockReturnValue(context.promise);
    mocks.sendMessage.mockReturnValue(transport.promise);
    const request = contextGateRequest(kind);
    const outcome = request.catch(error => error);
    mocks.config.aiRequestTimeoutMs = 10_000;
    context.resolve('Frozen page context');
    await flushMicrotasks();
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: 180_000});
    await vi.advanceTimersByTimeAsync(180_000);
    let finished = false;
    void outcome.then(() => {finished = true;});
    await flushMicrotasks();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toMatchObject({message: '翻译请求超时'});
    transport.resolve(kind === 'batch' ? ['迟到译文'] : '迟到译文');
  });

  it.each(['single', 'batch'] as const)('%s AI 显式 timeout 优先于用户默认配置', async kind => {
    mocks.config.service = 'mock-ai';
    mocks.config.aiRequestTimeoutMs = 600_000;
    const transport = deferred<string | string[]>();
    mocks.sendMessage.mockReturnValue(transport.promise);
    const request = kind === 'batch'
      ? translateTextBatch(['Override source'], 'Page', {timeout: 2_000, maxRetries: 0})
      : translateText('Override source', 'Page', {timeout: 2_000, maxRetries: 0});
    const outcome = request.catch(error => error);
    await flushMicrotasks();
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: 1_000});
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toMatchObject({message: '翻译请求超时'});
    transport.resolve(kind === 'batch' ? ['迟到译文'] : '迟到译文');
  });

  it.each(['single', 'batch', 'video'] as const)('%s 机器翻译保持原默认预算', async kind => {
    mocks.config.aiRequestTimeoutMs = 600_000;
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['机器译文'] : '机器译文');
    await contextGateRequest(kind);
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: kind === 'video' ? 19_000 : 44_000});
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

  it.each(['single', 'batch'] as const)('%s 扩展页面启用专用模型时将凭据校验交给可信后台', async kind => {
    Object.defineProperty(globalThis, 'location', {value: {protocol: 'chrome-extension:'}, configurable: true});
    mocks.config.service = 'mock-ai';
    mocks.config.privateTranslation = {enabled: true, service: 'custom:private', model: 'private-model'};
    mocks.getMissingCredentialMessage.mockReturnValue('普通连接需要 API Key，当前尚未配置');
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['专用译文'] : '专用译文');
    const options = {maxRetries: 0, glossaryContext: 'document' as const};
    const request = kind === 'batch' ? translateTextBatch(['Readable source'], 'Document', options)
      : translateText('Readable source', 'Document', options);
    await expect(request).resolves.toEqual(kind === 'batch' ? ['专用译文'] : '专用译文');
    expect(mocks.getMissingCredentialMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const payload = mocks.sendMessage.mock.calls[0][0];
    expect(payload).toMatchObject({serviceOverride: 'mock-ai', modelOverride: 'mock-ai-model', glossaryContext: 'document'});
    expect(payload).not.toHaveProperty('privateContext');
    expect(payload).not.toHaveProperty('incognito');
  });

  it.each(['single', 'batch'] as const)('%s 专用模式客户端保留后台拒绝且不重试普通连接', async kind => {
    Object.defineProperty(globalThis, 'location', {value: {protocol: 'chrome-extension:'}, configurable: true});
    mocks.config.privateTranslation = {enabled: true, service: 'custom:private', model: 'private-model'};
    mocks.getMissingCredentialMessage.mockReturnValue('普通连接需要 API Key，当前尚未配置');
    mocks.sendMessage.mockResolvedValue({marker: 'fluentread-translation-error-v1',
      message: '无法确认窗口隐私身份', kind: 'bad-request', retryable: false, code: 'PRIVATE_TRANSLATION_UNAVAILABLE'});
    const request = kind === 'batch' ? translateTextBatch(['Readable source'], 'Document')
      : translateText('Readable source', 'Document');
    await expect(request).rejects.toMatchObject({code: 'PRIVATE_TRANSLATION_UNAVAILABLE', retryable: false});
    expect(mocks.getMissingCredentialMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('扩展页面关闭专用模式后批量翻译仍按普通凭据快速失败', async () => {
    Object.defineProperty(globalThis, 'location', {value: {protocol: 'chrome-extension:'}, configurable: true});
    mocks.config.privateTranslation = {enabled: false, service: 'custom:private', model: 'private-model'};
    mocks.getMissingCredentialMessage.mockReturnValue('普通连接需要 API Key，当前尚未配置');
    await expect(translateTextBatch(['Readable source'], 'Document', {maxRetries: 0})).rejects.toThrow('普通连接需要 API Key');
    expect(mocks.getMissingCredentialMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
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
      requestTimeoutMs: 120_000,
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

  it.each(['single', 'batch', 'video'] as const)('原生合批偏好在 %s 入队前冻结，服务设置变更只影响新调用', async kind => {
    mocks.config.maxConcurrentTranslations = 1;
    mocks.config.service = 'google';
    mocks.config.videoService = 'google';
    mocks.config.nativeBatchTranslationEnabled = {google: false};
    const blocker = deferred<string>();
    mocks.sendMessage.mockImplementation(({origin}: {origin: string | string[]}) => origin === 'Blocking source'
      ? blocker.promise : Promise.resolve(Array.isArray(origin) ? origin.map(() => '译文') : '译文'));
    const first = translateText('Blocking source');
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
    const queued = kind === 'single' ? translateText('Queued source') : kind === 'batch'
      ? translateTextBatch(['Queued source']) : translateVideoText('Queued source');
    mocks.config.nativeBatchTranslationEnabled.google = true;
    blocker.resolve('阻塞译文');
    await first;
    await queued;
    expect(mocks.sendMessage.mock.calls[1]?.[0]).toMatchObject({serviceOverride: 'google', enableNativeBatch: false});
    await translateText('New source');
    expect(mocks.sendMessage.mock.calls[2]?.[0]).toMatchObject({enableNativeBatch: true});
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

  it.each(['single', 'batch', 'video'] as const)('%s abort immediately rejects queued work before transport starts', async kind => {
    mocks.config.maxConcurrentTranslations = 1;
    const gate = deferred<string>();
    mocks.sendMessage.mockReturnValueOnce(gate.promise);
    const active = translateText('Active source', 'Page', {maxRetries: 0});
    await flushMicrotasks(30);
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const owner = new AbortController();
    let failure: unknown;
    const queued = contextGateRequest(kind, owner.signal).catch(error => {failure = error; return error;});
    await flushMicrotasks(30);
    owner.abort();
    await flushMicrotasks();
    try {
      expect(failure).toMatchObject({name: 'AbortError'});
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
    } finally {
      gate.resolve('Completed active translation');
      await Promise.all([active, queued]);
    }
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
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

  it.each(['single', 'batch', 'video'].flatMap(kind => (
    ['success', 'failure'].map(late => ({kind: kind as ContextClient, late}))
  )))('$kind 在自动上下文 gate 尚未放行时立即取消，并观察迟到的 $late', async ({kind, late}) => {
    enableContextGate();
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const observed = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const outcome = contextGateRequest(kind, controller.signal).then(
      value => {observed('fulfilled', value);return value;},
      error => {observed('rejected', error);return error;},
    );
    try {
      await flushMicrotasks();
      expect(mocks.getPageTranslationContext).toHaveBeenCalledOnce();
      controller.abort();
      await flushMicrotasks();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // 先断言 caller 收口；finally 才释放 gate，旧实现失败也不会悬挂测试。
      expect(observed).toHaveBeenCalledWith('rejected', expect.objectContaining({name: 'AbortError', message: '翻译已取消'}));
      for (const [type, listener] of added.mock.calls) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
    } finally {
      if (late === 'failure') gate.reject(new Error('Late page context failure'));
      else gate.resolve('Late page context');
      await outcome;
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      process.off('unhandledRejection', unhandled);
    }
    expect(observed).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['single', 'batch', 'video'] as const)('%s 的 context gate 取消不影响共享 gate 的另一 caller', async kind => {
    enableContextGate();
    mocks.config.maxConcurrentTranslations = 1;
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    const controller = new AbortController();
    const observed = vi.fn();
    const first = contextGateRequest(kind, controller.signal).then(
      value => {observed('fulfilled', value);return value;},
      error => {observed('rejected', error);return error;},
    );
    let secondSettled = false;
    const second = contextGateRequest(kind).then(value => {secondSettled = true;return value;});
    try {
      await flushMicrotasks();
      controller.abort();
      await flushMicrotasks();
      expect(observed).toHaveBeenCalledWith('rejected', expect.objectContaining({name: 'AbortError', message: '翻译已取消'}));
      expect(secondSettled).toBe(false);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve('Shared page context');
      await Promise.all([first, second]);
    }
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({pageContext: 'Shared page context'}));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(1);
    expect(mocks.persistCountIncrement.mock.calls[0]?.[0]).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['single', 'batch', 'video'] as const)('%s 的提前取消不提取自动上下文或发送消息', async kind => {
    enableContextGate();
    const controller = new AbortController();
    controller.abort();
    await expect(contextGateRequest(kind, controller.signal)).rejects.toMatchObject({name: 'AbortError', message: '翻译已取消'});
    expect(mocks.getPageTranslationContext).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['single', 'batch'].flatMap(kind => (
    ['explicit', 'disabled'].map(mode => ({kind: kind as 'single' | 'batch', mode}))
  )))('$kind 的 $mode 上下文不启动自动 gate，原 transport listener 仍清理', async ({kind, mode}) => {
    enableContextGate();
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const supplied = `  ${'context '.repeat(600)}  `;
    const request = contextGateRequest(kind, controller.signal, mode === 'explicit'
      ? {pageContext: supplied} : {enableAIContext: false});
    try {
      await flushMicrotasks(16);
      expect(mocks.getPageTranslationContext).not.toHaveBeenCalled();
      await expect(request).resolves.toEqual(kind === 'batch' ? ['译文'] : '译文');
      expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        pageContext: mode === 'explicit' ? supplied.trim().slice(0, 4000) : undefined,
      }));
      for (const [type, listener] of added.mock.calls) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
      controller.abort();
      await flushMicrotasks();
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve('Unused page context');
      await request.catch(() => undefined);
    }
  });

  it.each(['single', 'batch', 'video'] as const)('%s 无 signal 的自动上下文仍正常等待与完成', async kind => {
    enableContextGate();
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    let settled = false;
    const request = contextGateRequest(kind).then(value => {settled = true;return value;});
    try {
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve('Uncancelled page context');
      await request;
    }
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({pageContext: 'Uncancelled page context'}));
  });

  it.each(['single', 'batch', 'video'] as const)('%s 不支持 AI 上下文的服务不启动 gate', async kind => {
    mocks.config.enableAIContext = true;
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockResolvedValue(kind === 'batch' ? ['译文'] : '译文');
    const request = contextGateRequest(kind);
    try {
      await flushMicrotasks(16);
      expect(mocks.getPageTranslationContext).not.toHaveBeenCalled();
      await expect(request).resolves.toEqual(kind === 'batch' ? ['译文'] : '译文');
    } finally {
      gate.resolve('Unused page context');
      await request.catch(() => undefined);
    }
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({pageContext: undefined}));
  });

  it.each(['single', 'batch', 'video'].flatMap(kind => (
    ['abort-first', 'context-first'].flatMap(order => (
      ['success', 'failure'].map(settlement => ({kind: kind as ContextClient, order, settlement}))
    ))
  )))('$kind 的 $order/$settlement 同轮 settle/abort 仅取消一次且不启动 transport', async ({kind, order, settlement}) => {
    enableContextGate();
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const observed = vi.fn();
    const outcome = contextGateRequest(kind, controller.signal).catch(error => {observed(error);return error;});
    try {
      await flushMicrotasks();
      const settle = () => settlement === 'failure' ? gate.reject(new Error('Page context failed in same job'))
        : gate.resolve('Settled page context');
      if (order === 'abort-first') {controller.abort();settle();}
      else {settle();controller.abort();}
      await expect(outcome).resolves.toMatchObject({name: 'AbortError', message: '翻译已取消'});
      expect(observed).toHaveBeenCalledTimes(1);
      for (const [type, listener] of added.mock.calls) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve('Cleanup page context');
      await outcome;
    }
  });

  it.each(['single', 'batch', 'video'] as const)('%s 的 context extractor 同步取消后返回的 promise 仍观察迟到失败', async kind => {
    enableContextGate();
    const gate = deferred<string>();
    const controller = new AbortController();
    mocks.getPageTranslationContext.mockImplementation(() => {controller.abort();return gate.promise;});
    const observed = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const outcome = contextGateRequest(kind, controller.signal).catch(error => {observed(error);return error;});
    try {
      await flushMicrotasks();
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({name: 'AbortError', message: '翻译已取消'}));
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.reject(new Error('Late synchronous-abort context failure'));
      await outcome;
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('自动上下文和 transport 正常完成后移除各自 signal listener', async () => {
    enableContextGate();
    const gate = deferred<string>();
    const transport = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    mocks.sendMessage.mockReturnValue(transport.promise);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const request = contextGateRequest('single', controller.signal);
    try {
      await flushMicrotasks();
      const contextListeners = [...added.mock.calls];
      gate.resolve('Resolved page context');
      await flushMicrotasks(16);
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
      for (const [type, listener] of contextListeners) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
      transport.resolve('译文');
      await expect(request).resolves.toBe('译文');
      for (const [type, listener] of added.mock.calls) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
      controller.abort();
      await flushMicrotasks();
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve('Cleanup page context');
      transport.resolve('Cleanup translation');
      await request.catch(() => undefined);
    }
  });

  it('未取消 caller 的自动上下文失败保留原错误并清理 signal listener', async () => {
    enableContextGate();
    const gate = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(gate.promise);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const observed = vi.fn();
    const outcome = contextGateRequest('single', controller.signal).catch(error => {observed(error);return error;});
    const error = new Error('Page context unavailable');
    try {
      await flushMicrotasks();
      gate.reject(error);
      await expect(outcome).resolves.toBe(error);
      controller.abort();
      await flushMicrotasks();
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(error);
      for (const [type, listener] of added.mock.calls) {
        if (type === 'abort') expect(removed).toHaveBeenCalledWith('abort', listener);
      }
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve('Cleanup page context');
      await outcome;
    }
  });

  it.each(['single', 'batch', 'video'] as const)('%s 在本地队列等待时取消立即结束且不发送后台消息', async kind => {
    mocks.config.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    mocks.sendMessage.mockReturnValue(blocker.promise);
    const active = translateText('Active readable source', 'Page', {maxRetries: 0, skipLanguageDetection: true});
    await flushMicrotasks(40);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const pending = kind === 'video' ? translateVideoText('Queued readable source', controller.signal)
      : kind === 'batch' ? translateTextBatch(['Queued readable source'], 'Page', {signal: controller.signal, maxRetries: 0, skipLanguageDetection: true})
        : translateText('Queued readable source', 'Page', {signal: controller.signal, maxRetries: 0, skipLanguageDetection: true});
    const observed = vi.fn();
    const outcome = pending.then(value => observed('resolved', value), error => observed('rejected', error));
    try {
      await flushMicrotasks(40);
      controller.abort();
      await flushMicrotasks(40);
      expect(observed).toHaveBeenCalledWith('rejected', expect.objectContaining({name: 'AbortError'}));
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
      expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
    } finally {
      blocker.resolve('活动译文');
      await Promise.all([active, outcome]);
    }
  });

  it.each(['chrome-text', 'text', 'batch', 'video'])('%s abort 发送精确 cancel，中止后台 broker signal 并及时释放前台队列', async (client) => {
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
    const first = client === 'video' ? translateVideoText('First readable source', controller.signal)
      : client === 'batch' ? translateTextBatch(['First readable source'], 'Context', {signal: controller.signal, maxRetries: 0})
      : translateText('First readable source', 'Context', {
      signal: controller.signal,
      maxRetries: 0,
      serviceOverride: client === 'chrome-text' ? 'chromeTranslator' : 'mock',
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

  it('上下文提取期间保留批量原文槽位和单条请求选项', async () => {
    mocks.config.service = 'mock-ai';
    mocks.config.enableAIContext = true;
    const context = deferred<string>();
    mocks.getPageTranslationContext.mockReturnValue(context.promise);
    mocks.sendMessage.mockImplementation(async ({origin}: {origin: string | string[]}) => Array.isArray(origin) ? origin.map(value => `译:${value}`) : `译:${origin}`);
    const origins = ['Original first', 'Original second'];
    const options = {enableAIContext: true, aiMultiSegment: true, documentBatch: true, sourceLanguageDetectionText: 'Original detection', maxRetries: 0};
    const batch = translateTextBatch(origins, 'Page', options);
    const single = translateText('Original single', 'Page', options);
    origins.push('Added later');
    options.enableAIContext = false;
    options.aiMultiSegment = false;
    options.documentBatch = false;
    context.resolve('captured context');

    await expect(batch).resolves.toEqual(['译:Original first', '译:Original second']);
    await expect(single).resolves.toBe('译:Original single');
    const batchMessage = mocks.sendMessage.mock.calls.find(([message]) => Array.isArray(message.origin))?.[0];
    const singleMessage = mocks.sendMessage.mock.calls.find(([message]) => message.origin === 'Original single')?.[0];
    expect(batchMessage).toMatchObject({origin: ['Original first', 'Original second'], documentBatch: true, aiMultiSegment: true, enableAIContext: true});
    expect(singleMessage).toMatchObject({enableAIContext: true});
    expect(singleMessage).not.toHaveProperty('documentBatch');
    expect(origins).toEqual(['Original first', 'Original second', 'Added later']);
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

  it.each(['single', 'batch', 'video'] as const)('%s 组合中的通用 AI 成员保留页面上下文，纯机器组合不提取', async kind => {
    mocks.config.enableAIContext = true;
    mocks.config.service = 'composite:context';
    mocks.config.videoService = 'composite:context';
    mocks.config.compositeTranslationProviders = [{id: 'composite:context', name: '上下文组合', strategy: 'sequential', services: ['mock', 'mock-ai'], timeoutMs: 12_000}];
    mocks.getPageTranslationContext.mockResolvedValue('Combined page context');
    mocks.sendMessage.mockImplementation(({origin}: {origin: string | string[]}) => Promise.resolve(Array.isArray(origin) ? ['译文'] : '译文'));
    await contextGateRequest(kind);
    expect(mocks.getPageTranslationContext).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({serviceOverride: 'composite:context', pageContext: 'Combined page context'}));
    mocks.config.compositeTranslationProviders[0].services = ['mock'];
    await contextGateRequest(kind);
    expect(mocks.getPageTranslationContext).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({serviceOverride: 'composite:context', pageContext: undefined}));
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
      requestTimeoutMs: 120_000,
    }));
    expect(mocks.sendMessage.mock.calls[0]?.[0].clientRequestId).toEqual(expect.any(String));
  });

  it('空来源及空批次保持本地结果，不启动消息或完成计数', async () => {
    await expect(translateText(undefined as never)).resolves.toBe('');
    await expect(translateTextBatch([])).resolves.toEqual([]);
    await expect(translateVideoText(undefined as never)).resolves.toBe('');
    await expect(translateVideoText(' 	')).resolves.toBe(' 	');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.persistCountIncrement).not.toHaveBeenCalled();
  });

  it('原生Chrome批次使用45秒预算，显式超时和篇章证据逐次独立', async () => {
    mocks.sendMessage.mockResolvedValue(['译文']);
    mocks.config.service = 'chromeTranslator';
    const evidence = 'e'.repeat(2500);
    await expect(translateTextBatch(['Source'], undefined, {maxRetries: 0, discourseContext: evidence})).resolves.toEqual(['译文']);
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({requestTimeoutMs: 44_000, discourseContext: evidence.slice(0, 2400)});
    await expect(translateTextBatch(['Source'], 'Page', {maxRetries: 0, timeout: 3_000})).resolves.toEqual(['译文']);
    expect(mocks.sendMessage.mock.calls[1][0]).toMatchObject({requestTimeoutMs: 2_000});
    expect(mocks.sendMessage.mock.calls[1][0].discourseContext).toBeUndefined();
    mocks.sendMessage.mockResolvedValue('译文');
    await translateText('Source', 'Page', {maxRetries: 0, discourseContext: evidence});
    expect(mocks.sendMessage.mock.calls[2][0].discourseContext).toBe(evidence.slice(0, 2400));
  });

  it('没有模型的机器服务在扩展页面验证原配置，不创建虚构模型覆盖', async () => {
    Object.defineProperty(globalThis, 'location', {value: {protocol: 'chrome-extension:'}, configurable: true});
    mocks.config.service = 'microsoft';
    delete mocks.config.model.microsoft;
    delete mocks.config.customModel.microsoft;
    mocks.sendMessage.mockResolvedValue('机器译文');
    await expect(translateText('Source', 'Page', {maxRetries: 0})).resolves.toBe('机器译文');
    expect(mocks.getMissingCredentialMessage).toHaveBeenCalledWith('microsoft', mocks.config);
    expect(mocks.sendMessage.mock.calls[0][0].modelOverride).toBeUndefined();
  });

  it('非法显式重试间隔回退到有效预算，存活signal的重试完成后清理监听', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    mocks.sendMessage.mockRejectedValueOnce(new Error('temporary network failure')).mockResolvedValueOnce('恢复译文');
    const request = translateText('Retry source', 'Page', {signal: controller.signal, maxRetries: 1, retryDelay: -1, retryMaxDelay: Number.NaN});
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toBe('恢复译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    remove.mockRestore();
  });

  it('运行时同步取消即使取消通知抛错也只结束本调用，迟到结果结算后下一请求才启动', async () => {
    mocks.config.maxConcurrentTranslations = 1;
    const controller = new AbortController();
    const transport = deferred<string>();
    mocks.sendMessage.mockImplementation(message => {
      if (message.type) throw new Error('Extension context invalidated');
      if (message.origin === 'Synchronous source') {
        controller.abort();
        return transport.promise;
      }
      return Promise.resolve('下一个译文');
    });
    const first = translateText('Synchronous source', 'Page', {signal: controller.signal, maxRetries: 0});
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    const [request] = mocks.sendMessage.mock.calls[0];
    expect(mocks.sendMessage.mock.calls[1][0]).toEqual({type: 'fluentReadTranslationCancel', clientRequestId: request.clientRequestId});
    const next = translateText('Next source', 'Page', {maxRetries: 0});
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    transport.resolve('迟到译文');
    await expect(next).resolves.toBe('下一个译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.persistCountIncrement).toHaveBeenCalledWith(1, expect.any(Function), expect.any(String));
  });

  it.each([undefined, new AbortController().signal])('空自动上下文在有无signal时均不伪造pageContext %j', async signal => {
    enableContextGate();
    mocks.getPageTranslationContext.mockResolvedValue('');
    mocks.sendMessage.mockResolvedValue('译文');
    await expect(translateText('Source', 'Page', {signal, maxRetries: 0})).resolves.toBe('译文');
    expect(mocks.sendMessage.mock.calls[0][0].pageContext).toBeUndefined();
  });

  it('视频请求在无document环境仍保留字幕与语言，短暂故障按统一策略重试', async () => {
    Object.defineProperty(globalThis, 'document', {value: undefined, configurable: true});
    mocks.sendMessage.mockRejectedValueOnce(new Error('temporary network failure')).mockResolvedValueOnce('字幕译文');
    const request = translateVideoText('Subtitle source');
    await flushMicrotasks();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(request).resolves.toBe('字幕译文');
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage.mock.calls[1][0]).toMatchObject({context: '视频字幕：', origin: 'Subtitle source', sourceLanguage: 'en'});
  });

  it('视频完成计数写入失败后复用操作身份恢复，不使已完成翻译失败', async () => {
    const error = new Error('storage temporarily unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.sendMessage.mockResolvedValue('字幕译文');
      mocks.persistCountIncrement.mockRejectedValueOnce(error).mockResolvedValue(1);
      await expect(translateVideoText('Subtitle source')).resolves.toBe('字幕译文');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(log).toHaveBeenCalledWith('[FluentRead] 保存视频翻译计数失败:', error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.persistCountIncrement).toHaveBeenCalledTimes(2);
      expect(mocks.persistCountIncrement.mock.calls[0][2]).toBe(mocks.persistCountIncrement.mock.calls[1][2]);
    } finally {
      log.mockRestore();
    }
  });

  it.each(['random-throws', 'crypto-missing', 'uuid-missing'] as const)('随机API %s 时请求身份仍唯一，取消沿用各自身份', async mode => {
    const originalCrypto = globalThis.crypto;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'development');
    try {
      Object.defineProperty(globalThis, 'crypto', {configurable: true, value: mode === 'crypto-missing' ? undefined : {
        getRandomValues: (bytes: Uint32Array) => {
          if (mode === 'random-throws') throw new Error('random unavailable');
          bytes.set([1, 2, 3, 4]);
          return bytes;
        },
      }});
      vi.resetModules();
      const client = await import('@/src/services/translation/client');
      mocks.sendMessage.mockRejectedValueOnce(new Error('temporary network failure')).mockResolvedValue('译文');
      const first = client.translateText('First fallback source', 'Page', {signal: new AbortController().signal, maxRetries: 1, retryDelay: 0, retryMaxDelay: 0});
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toBe('译文');
      await client.translateVideoText('Second fallback source');
      const requestIds = mocks.sendMessage.mock.calls.map(([message]) => message.clientRequestId);
      expect(requestIds).toHaveLength(3);
      expect(new Set(requestIds).size).toBe(3);
      requestIds.forEach(id => expect(id).toMatch(/^translation-[a-z0-9-]+-\d+$/u));
      client.cancelAllTranslations();
      expect(log).toHaveBeenCalledWith('[翻译API] 取消所有等待中的翻译任务');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {configurable: true, value: originalCrypto});
      vi.unstubAllEnvs();
      log.mockRestore();
      vi.resetModules();
    }
  });

});
