import {withProviderSnapshot} from './helpers/providerSnapshot';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig} = vi.hoisted(() => ({
  mockConfig: {
    service: 'custom',
    from: 'auto',
    to: 'zh-Hans',
    useCache: true,
    enableAIContext: false,
    token: {} as Record<string, string>,
    model: {} as Record<string, string>,
    customModel: {} as Record<string, string>,
    customBody: {} as Record<string, string>,
    system_role: {} as Record<string, string>,
    user_role: {} as Record<string, string>,
    requireApiKey: {} as Record<string, boolean>,
    proxy: {} as Record<string, string>,
    custom: 'http://127.0.0.1:11434/v1/chat/completions',
    deeplx: '',
    newApiUrl: '',
    azureOpenaiEndpoint: '',
    minimaxBillingPlan: 'payg',
    minimaxRegion: 'cn',
    mimoBillingPlan: 'payg',
    mimoRegion: 'cn',
    deepseekApiType: 'auto',
    deepseekThinkingMode: 'disabled',
    translationMaxRetries: 2,
    aiRequestTimeoutMs: undefined as number | undefined,
    youdaoAppKey: '',
    youdaoAppSecret: '',
    tencentSecretId: '',
    tencentSecretKey: '',
  },
}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {buildPageSummaryPrompt, buildPageSummarySystemPrompt} from '@/src/core/translation/prompts';
import {translateWithOpenAICompatibleAiSdk as translateWithSdk, type AiSdkTranslationRequest} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {translateWithOpenAICompatibleAiSdk as translateWithStandalone} from '@/userscript/openaiCompatible';
import {resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import azureOpenai from '@/src/providers/translation/azure-openai';
import {normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    attachTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createTranslationBroker} from '@/src/services/translation/broker';
import type {TranslationModelUsageObservation} from '@/src/services/translation/types';

function successResponse(text = '译文') {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
  }), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

function errorResponse(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({error: {message, code: `code-${status}`}}), {
    status,
    statusText: 'Provider Error',
    headers: {'content-type': 'application/json', ...headers},
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function ollamaBroker(translateWithOpenAICompatibleAiSdk: typeof translateWithSdk) {
  const current = {
    ...mockConfig,
    service: services.ollama,
    model: {[services.ollama]: 'gemma3:4b'},
    token: {},
    translationMaxRetries: 0,
    maxConcurrentTranslations: 1,
    translationRequestsPerSecond: 0,
    translationRequestsPerMinute: 0,
    useCache: false,
  };
  return createTranslationBroker({
    ready: Promise.resolve(),
    getConfig: () => current,
    providers: {[services.ollama]: message => translateWithOpenAICompatibleAiSdk(withProviderSnapshot(message as unknown as AiSdkTranslationRequest, mockConfig))},
    cache: {
      get: async () => null,
      set: async () => true,
      clear: async () => undefined,
      cleanup: async () => undefined,
    },
    serviceTypes: servicesType,
    endpointResolver: {resolveOpenAICompatibleEndpoint, aiSdkTransportProfile: 'ai-sdk'},
    promptBuilder: {buildPageSummaryPrompt, buildPageSummarySystemPrompt},
    getMissingCredentialMessage,
    getTranslationLanguages: override => resolveTranslationLanguages(override, {
      sourceLanguage: current.from, targetLanguage: current.to,
    }),
    resolveConfiguredModel,
    buildTranslationCacheKey: identity => JSON.stringify(identity),
  });
}

describe.each([['locked SDK', translateWithSdk], ['standalone HTTP', translateWithStandalone]] as const)('%s OpenAI-compatible transport', (_name, translateWithOpenAICompatibleAiSdk) => {
  it.each([
    ['official OpenAI', 'https://api.openai.com/v1/chat/completions', {max_tokens: 96}, {max_completion_tokens: 96}],
    ['compatible legacy', 'https://gateway.test/v1/chat/completions', {max_tokens: 96}, {max_tokens: 96}],
    ['compatible explicit', 'https://gateway.test/v1/chat/completions', {max_tokens: null, max_completion_tokens: 32}, {max_completion_tokens: 32}],
  ])('normalizes final SDK and standalone translation requests for %s', async (_name, endpoint, budget, expected) => {
    mockConfig.custom = endpoint;
    mockConfig.model.custom = 'arbitrary-model';
    mockConfig.customBody.custom = JSON.stringify({...budget, service_tier: 'fast', reasoning_effort: 'none'});
    const bodies: Record<string, unknown>[] = [];
    setRuntimeFetch(async (_input, init) => {bodies.push(JSON.parse(String(init?.body)));return successResponse();});
    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'Hello'}, mockConfig))).resolves.toBe('译文');
    expect(bodies).toHaveLength(1);
    for (const body of bodies) {
      expect(body).toMatchObject({...expected, service_tier: 'fast', reasoning_effort: 'none', stream: false});
      expect(body).not.toHaveProperty('max_completion_tokens' in expected ? 'max_tokens' : 'max_completion_tokens');
    }
  });

  beforeEach(() => {
    vi.useRealTimers();
    setRuntimeFetch();
    mockConfig.service = services.custom;
    mockConfig.to = 'zh-Hans';
    mockConfig.token = {[services.custom]: 'sk-local-secret-value'};
    mockConfig.model = {[services.custom]: 'base-model'};
    mockConfig.customModel = {};
    mockConfig.customBody = {};
    mockConfig.system_role = {[services.custom]: 'You are a translator.'};
    mockConfig.user_role = {[services.custom]: 'Translate {{origin}} into {{to}}.'};
    mockConfig.proxy = {};
    mockConfig.requireApiKey = {};
    mockConfig.translationMaxRetries = 2;
    mockConfig.aiRequestTimeoutMs = undefined;
    mockConfig.custom = 'http://127.0.0.1:11434/v1/chat/completions';
    mockConfig.newApiUrl = '';
    mockConfig.azureOpenaiEndpoint = '';
  });

  afterEach(() => {
    setRuntimeFetch();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('直接 SDK 调用默认允许 60 秒待响应，覆盖旧 40 秒 provider 超时', async () => {
    vi.useFakeTimers();
    const transport = deferredResponse();
    let signal!: AbortSignal;
    setRuntimeFetch(vi.fn((_input, init) => {
      signal = init!.signal!;
      signal.addEventListener('abort', () => transport.reject(new DOMException('aborted', 'AbortError')), {once: true});
      return transport.promise;
    }));
    const result = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'Slow direct model source'}, mockConfig));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
    transport.resolve(successResponse('缓慢模型译文'));
    await expect(result).resolves.toBe('缓慢模型译文');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {configured: 10_000, explicit: undefined, deadline: 10_000},
    {configured: 600_000, explicit: 500, deadline: 500},
    {configured: 10_000, explicit: 180_000, deadline: 180_000},
  ])('SDK 采用配置或显式预算并在精确截止 abort：$deadline 毫秒', async ({configured, explicit, deadline}) => {
    vi.useFakeTimers();
    mockConfig.aiRequestTimeoutMs = configured;
    let signal!: AbortSignal;
    setRuntimeFetch(vi.fn((_input, init) => {
      signal = init!.signal!;
      return new Promise<Response>((_, reject) => signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
    }));
    const outcome = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'SDK deadline source', requestTimeoutMs: explicit}, mockConfig)).catch(error => error);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({kind: 'timeout', retryable: true});
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SDK 数组的总预算继承 180 秒设置，并向后项只传剩余预算', async () => {
    vi.useFakeTimers();
    mockConfig.aiRequestTimeoutMs = 180_000;
    const responses = [deferredResponse(), deferredResponse()];
    const signals: AbortSignal[] = [];
    setRuntimeFetch(vi.fn((_input, init) => {
      const response = responses[signals.length];
      signals.push(init!.signal!);
      init!.signal!.addEventListener('abort', () => response.reject(new DOMException('aborted', 'AbortError')), {once: true});
      return response.promise;
    }));
    const result = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: ['First slow source', 'Second slow source']}, mockConfig));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(signals[0].aborted).toBe(false);
    responses[0].resolve(successResponse('第一段译文'));
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(signals[1].aborted).toBe(false);
    responses[1].resolve(successResponse('第二段译文'));
    await expect(result).resolves.toEqual(['第一段译文', '第二段译文']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('SDK 数组第二项在总预算耗尽时 abort，而不重新得到完整用户预算', async () => {
    vi.useFakeTimers();
    mockConfig.aiRequestTimeoutMs = 10_000;
    const first = deferredResponse();
    const signals: AbortSignal[] = [];
    setRuntimeFetch(vi.fn((_input, init) => {
      signals.push(init!.signal!);
      if (signals.length === 1) return first.promise;
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
    }));
    const outcome = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: ['First source', 'Pending second source']}, mockConfig)).catch(error => error);
    await vi.advanceTimersByTimeAsync(7_000);
    first.resolve(successResponse('第一段译文'));
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({kind: 'timeout'});
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('issue #626：Base URL 经真实 SDK 发往完整接口并保留模型和鉴权', async () => {
    mockConfig.custom = 'https://opencode.ai/zen/v1';
    mockConfig.model[services.custom] = 'big-pickle';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === 'https://opencode.ai/zen/v1/chat/completions'
      ? successResponse('你好')
      : new Response('<!DOCTYPE html><html><body>Not Found</body></html>', {status: 404, headers: {'content-type': 'text/html'}}));
    setRuntimeFetch(fetchMock);
    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'hello'}, mockConfig))).resolves.toBe('你好');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-local-secret-value');
    expect(JSON.parse(String(init.body))).toMatchObject({model: 'big-pickle', stream: false});
    expect(mockConfig.custom).toBe('https://opencode.ai/zen/v1');
  });


  it('preserves custom top-level fields while keeping the SDK-owned stream mode', async () => {
    mockConfig.custom = 'http://127.0.0.1:11434/non-standard-generate';
    mockConfig.customBody[services.custom] = JSON.stringify({
      vendor_flag: 'kept',
      model: 'custom-model',
      stream: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
      requestTimeoutMs: 5_000,
    }, mockConfig))).resolves.toBe('译文');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/non-standard-generate');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-local-secret-value');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'custom-model',
      stream: false,
      vendor_flag: 'kept',
    });
  });

  it.each([
    ['', 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions'],
    ['https://gateway.example.com/v1/chat/completions', 'https://gateway.example.com/v1/chat/completions'],
  ])('issue #513：混元使用官方接口且保留显式代理 %s', async (proxy, expectedEndpoint) => {
    mockConfig.service = services.huanYuan;
    mockConfig.model[services.huanYuan] = 'hy3';
    mockConfig.token[services.huanYuan] = 'hunyuan-test-key';
    mockConfig.proxy[services.huanYuan] = proxy;
    const fetchMock = vi.fn().mockResolvedValue(successResponse('你好'));
    setRuntimeFetch(fetchMock);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'hello'}, mockConfig))).resolves.toBe('你好');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(expectedEndpoint);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer hunyuan-test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({model: 'hy3', stream: false});
    expect(mockConfig.token[services.huanYuan]).toBe('hunyuan-test-key');
    expect(mockConfig.proxy[services.huanYuan]).toBe(proxy);
  });

  it('通过 runtimeFetch 发起 AI SDK 请求，使 userscript 可复用 GM transport', async () => {
    const nativeFetch = vi.fn().mockRejectedValue(new Error('不应调用原生 fetch'));
    vi.stubGlobal('fetch', nativeFetch);
    const runtimeTransport = vi.fn().mockResolvedValue(successResponse('GM 译文'));
    setRuntimeFetch(runtimeTransport);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig))).resolves.toBe('GM 译文');

    expect(runtimeTransport).toHaveBeenCalledOnce();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['https://reader.openai.azure.com', 'https://reader.openai.azure.com/openai/v1/chat/completions'],
    ['https://reader.services.ai.azure.com/openai/v1/', 'https://reader.services.ai.azure.com/openai/v1/chat/completions'],
    ['https://reader.openai.azure.com/openai/deployments/reader/chat/completions?api-version=2024-10-21', 'https://reader.openai.azure.com/openai/deployments/reader/chat/completions?api-version=2024-10-21'],
  ])('Azure provider 使用部署名称与 api-key 请求 %s', async (endpoint, expected) => {
    mockConfig.azureOpenaiEndpoint = endpoint;
    mockConfig.token[services.azureOpenai] = ' azure-test-key ';
    mockConfig.model[services.azureOpenai] = 'reader-deployment';
    const fetchMock = vi.fn().mockResolvedValue(successResponse('Azure 译文'));
    setRuntimeFetch(fetchMock);

    await expect(azureOpenai(withProviderSnapshot({origin: 'hello', serviceOverride: services.azureOpenai}, mockConfig))).resolves.toBe('Azure 译文');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(expected);
    expect(new Headers(init.headers).get('api-key')).toBe('azure-test-key');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({model: 'reader-deployment', stream: false});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('Azure 前置校验和 transport 使用同一个请求快照', async () => {
    mockConfig.azureOpenaiEndpoint = 'https://snapshot.services.ai.azure.com';
    mockConfig.token[services.azureOpenai] = 'snapshot-key';
    mockConfig.model[services.azureOpenai] = 'snapshot-deployment';
    const snapshot = createTranslationProviderConfigSnapshot(mockConfig);
    mockConfig.azureOpenaiEndpoint = '';
    mockConfig.token[services.azureOpenai] = '';
    mockConfig.model[services.azureOpenai] = '';
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    setRuntimeFetch(fetchMock);

    await azureOpenai(withProviderSnapshot(attachTranslationProviderConfig({origin: 'hello', serviceOverride: services.azureOpenai}, snapshot), mockConfig));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://snapshot.services.ai.azure.com/openai/v1/chat/completions');
    expect(new Headers(init.headers).get('api-key')).toBe('snapshot-key');
    expect(JSON.parse(String(init.body)).model).toBe('snapshot-deployment');
  });

  it('Azure 在发送请求前拒绝缺失凭据、无效端点和空部署名称', async () => {
    mockConfig.service = services.azureOpenai;
    mockConfig.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com';
    mockConfig.model[services.azureOpenai] = '   ';
    const fetchMock = vi.fn();
    setRuntimeFetch(fetchMock);

    await expect(azureOpenai(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('Azure API Key 未配置');
    mockConfig.token[services.azureOpenai] = '   ';
    await expect(azureOpenai(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('Azure API Key 未配置');
    mockConfig.token[services.azureOpenai] = 'azure-test-key';
    mockConfig.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com/unexpected';
    await expect(azureOpenai(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('Azure 端点地址格式不正确');
    mockConfig.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com';
    await expect(azureOpenai(withProviderSnapshot({origin: 'hello'}, mockConfig))).rejects.toThrow('模型尚未配置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Azure 允许通过模型覆盖和自定义请求体指定部署名称', async () => {
    mockConfig.service = services.azureOpenai;
    mockConfig.azureOpenaiEndpoint = 'http://localhost:3000/v1';
    mockConfig.requireApiKey[`${services.azureOpenai}:`] = false;
    const models: string[] = [];
    setRuntimeFetch(vi.fn(async (_input, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      expect(new Headers(init?.headers).has('api-key')).toBe(false);
      return successResponse();
    }));

    await azureOpenai(withProviderSnapshot({origin: 'hello', modelOverride: 'custom-deployment'}, mockConfig));
    mockConfig.customBody[services.azureOpenai] = '{"model":"body-deployment"}';
    await azureOpenai(withProviderSnapshot({origin: 'hello'}, mockConfig));
    expect(models).toEqual(['custom-deployment', 'body-deployment']);
  });

  it('逐次报告真实 transport 的服务商 Token，且不把 Kimi 缓存 Token 重复加入总量', async () => {
    const observations: TranslationModelUsageObservation[] = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'kimi-k2.6',
      choices: [{message: {role: 'assistant', content: 'Kimi 译文'}, finish_reason: 'stop'}],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        cached_tokens: 6,
      },
    }), {status: 200, headers: {'content-type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot(attachTranslationModelUsageObserver({
      origin: 'hello',
      serviceOverride: services.custom,
    }, (observation) => observations.push(observation)), mockConfig))).resolves.toBe('Kimi 译文');

    expect(observations).toEqual([
      expect.objectContaining({
        actualModel: 'kimi-k2.6',
        outcome: 'success',
        statusCode: 200,
        usageAvailability: 'reported',
        inputTokens: 15,
        outputTokens: 5,
        totalTokens: 20,
        cachedInputTokens: 6,
      }),
    ]);
  });

  it('把每次 HTTP 408 transport 尝试报告为 timeout', async () => {
    const observations: TranslationModelUsageObservation[] = [];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(
      408,
      'request timeout',
      {'retry-after': '0'},
    )));
    vi.stubGlobal('fetch', fetchMock);

    const error = await translateWithOpenAICompatibleAiSdk(withProviderSnapshot(attachTranslationModelUsageObserver({
      origin: 'hello',
      serviceOverride: services.custom,
    }, (observation) => observations.push(observation)), mockConfig)).catch((reason) => reason);

    expect(error).toMatchObject({kind: 'timeout', statusCode: 408});
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(observations).toHaveLength(3);
    expect(observations).toEqual(observations.map(() => expect.objectContaining({
      outcome: 'timeout',
      statusCode: 408,
      usageAvailability: 'unreported',
    })));
  });

  it('AI SDK 的首次请求和内部重试都经过共享 attempt scheduler', async () => {
    const scheduler = createTranslationRequestScheduler(() => ({
      maxConcurrentTranslations: 1,
      translationRequestsPerSecond: 0,
      translationRequestsPerMinute: 0,
    }));
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(408, 'request timeout'));
    setRuntimeFetch(fetchMock);

    const request = attachTranslationRequestScheduler({
      origin: 'hello',
      serviceOverride: services.custom,
    }, scheduler, {service: services.custom, model: 'base-model'});
    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot(request, mockConfig))).rejects.toMatchObject({statusCode: 408});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('uses the broker-attached endpoint, credential, prompt, and custom body snapshot', async () => {
    mockConfig.custom = 'https://snapshot-a.example/v1/chat/completions';
    mockConfig.token[services.custom] = 'snapshot-token-a';
    mockConfig.model[services.custom] = 'snapshot-model-a';
    mockConfig.customBody[services.custom] = '{"temperature":0.2,"snapshot":"a"}';
    mockConfig.system_role[services.custom] = 'snapshot-system-a';
    mockConfig.user_role[services.custom] = 'snapshot-user-a {{origin}} to {{to}}';
    const snapshot = createTranslationProviderConfigSnapshot(mockConfig);

    mockConfig.custom = 'https://snapshot-b.example/v1/chat/completions';
    mockConfig.token[services.custom] = 'snapshot-token-b';
    mockConfig.model[services.custom] = 'snapshot-model-b';
    mockConfig.customBody[services.custom] = '{"temperature":0.9,"snapshot":"b"}';
    mockConfig.system_role[services.custom] = 'snapshot-system-b';
    mockConfig.user_role[services.custom] = 'snapshot-user-b {{origin}} to {{to}}';

    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot(attachTranslationProviderConfig({
      origin: 'hello',
      serviceOverride: services.custom,
      targetLanguage: 'fr',
    }, snapshot), mockConfig))).resolves.toBe('译文');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://snapshot-a.example/v1/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer snapshot-token-a');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'snapshot-model-a',
      temperature: 0.2,
      snapshot: 'a',
      messages: [
        {role: 'system', content: 'snapshot-system-a'},
        {role: 'user', content: 'snapshot-user-a hello to fr'},
      ],
    });
  });

  it('classifies a missing custom endpoint as a permanent configuration error', async () => {
    mockConfig.custom = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig)).catch((reason) => reason);

    expect(error).toMatchObject({kind: 'bad-request', retryable: false});
    expect(error.message).toContain('未配置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes OpenAI-specific custom messages without SDK prompt-schema rejection', async () => {
    const customMessages = [
      {role: 'developer', content: 'Return only a translation.'},
      {role: 'user', content: [{type: 'text', text: 'hello'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AA=='}}]},
    ];
    mockConfig.customBody[services.custom] = JSON.stringify({messages: customMessages});
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig))).resolves.toBe('译文');

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages).toEqual(customMessages);
  });

  it('accepts valid translation text when optional provider metadata is non-standard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 123,
      created: 'now',
      choices: [{message: {content: '兼容旧 Custom 的译文'}, finish_reason: 0}],
      usage: {prompt_tokens: '12', completion_tokens: '4', total_tokens: '16'},
    }), {
      status: 200,
      headers: {'content-type': 'application/json'},
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig))).resolves.toBe('兼容旧 Custom 的译文');
  });

  it('does not retry permanent authentication errors and redacts secrets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(
      401,
      `invalid api_key=sk-local-secret-value`,
      {'x-request-id': 'req-auth-test-sk-local-secret-value'},
    ));
    vi.stubGlobal('fetch', fetchMock);

    const error = await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig)).catch((reason) => reason);

    expect(error).toMatchObject({
      name: 'LlmTransportError',
      kind: 'authentication',
      retryable: false,
      statusCode: 401,
      code: 'code-401',
    });
    expect(error.message).toContain('HTTP 401');
    expect(error.requestId).not.toContain('sk-local-secret-value');
    expect(error.message).toContain('req-auth-test');
    expect(error.message).not.toContain('sk-local-secret-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [services.minimax, 'invalid api key (code 2049)', 'Token Plan Key'],
    [services.mimo, 'invalid api key', '集群不匹配'],
  ])('retains specialized credential diagnostics for %s', async (service, providerMessage, expectedDetail) => {
    mockConfig.token[service] = 'sk-provider-test';
    mockConfig.model[service] = 'provider-model';
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, providerMessage));
    vi.stubGlobal('fetch', fetchMock);

    const error = await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: service,
    }, mockConfig)).catch((reason) => reason);

    expect(error).toMatchObject({kind: 'authentication', retryable: false, statusCode: 401});
    expect(error.message).toContain(expectedDetail);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets the SDK retry transient 429 responses and retains Retry-After metadata', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(
      429,
      'rate limited',
      {'retry-after': '1', 'retry-after-ms': '250', 'x-request-id': 'req-rate-test'},
    )));
    vi.stubGlobal('fetch', fetchMock);

    const request = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
      requestTimeoutMs: 30_000,
    }, mockConfig));
    const outcome = request.catch((reason) => reason);
    await vi.runAllTimersAsync();
    const error = await outcome;

    expect(error).toMatchObject({
      name: 'LlmTransportError',
      kind: 'rate-limit',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 250,
      requestId: 'req-rate-test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve', 'reject'] as const)('issue #952：Ollama 取消后等真实传输 %s 再开始下一条请求', async settlement => {
    vi.useFakeTimers();
    const firstTransport = deferredResponse();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstTransport.promise)
      .mockImplementation(() => Promise.resolve(successResponse('第二条译文')));
    setRuntimeFetch(fetchMock);
    const broker = ollamaBroker(translateWithOpenAICompatibleAiSdk);
    const controller = new AbortController();
    const first = broker.translateWithCache(attachTranslationRequestControl({
      origin: 'The first English paragraph.', requestTimeoutMs: 5_000,
    }, {signal: controller.signal, ownershipKey: 'issue-952-first'})).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(first).resolves.toMatchObject({name: 'AbortError'});
    const second = broker.translateWithCache({
      origin: 'The second English paragraph.', requestTimeoutMs: 5_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (settlement === 'resolve') firstTransport.resolve(successResponse('第一条译文'));
      else firstTransport.reject(new TypeError('Late physical transport rejection'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toBe('第二条译文');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('issue #952：Ollama 超时后仍持有未结束的真实请求槽位', async () => {
    vi.useFakeTimers();
    const firstTransport = deferredResponse();
    let firstSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input, init?: RequestInit) => {
        firstSignal = init?.signal;
        return firstTransport.promise;
      })
      .mockImplementation(() => Promise.resolve(successResponse('重试译文')));
    setRuntimeFetch(fetchMock);
    const broker = ollamaBroker(translateWithOpenAICompatibleAiSdk);
    const first = broker.translateWithCache({
      origin: 'A slow English paragraph.', requestTimeoutMs: 1_000,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toMatchObject({name: 'TranslationProviderDeadlineError', message: '翻译请求超时'});
    expect(firstSignal?.aborted).toBe(true);
    const retry = broker.translateWithCache({
      origin: 'A slow English paragraph.', requestTimeoutMs: 5_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      firstTransport.reject(new TypeError('Transport finished after cancellation'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(retry).resolves.toBe('重试译文');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([200, 500])('issue #952：Ollama 取消后等待迟到的 HTTP %s 响应正文结束', async status => {
    vi.useFakeTimers();
    const firstTransport = deferredResponse();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const lateBody = new ReadableStream<Uint8Array>({
      start(controller) {bodyController = controller;},
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstTransport.promise)
      .mockImplementation(() => Promise.resolve(successResponse('下一条译文')));
    setRuntimeFetch(fetchMock);
    const broker = ollamaBroker(translateWithOpenAICompatibleAiSdk);
    const controller = new AbortController();
    const first = broker.translateWithCache(attachTranslationRequestControl({
      origin: 'A paragraph with a delayed response body.', requestTimeoutMs: 5_000,
    }, {signal: controller.signal, ownershipKey: `issue-952-body-${status}`})).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(first).resolves.toMatchObject({name: 'AbortError'});
    const next = broker.translateWithCache({
      origin: 'Another paragraph after cancellation.', requestTimeoutMs: 5_000,
    });
    firstTransport.resolve(new Response(lateBody, {status, headers: {'content-type': 'application/json'}}));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      const body = status === 200
        ? {choices: [{message: {role: 'assistant', content: '迟到译文'}, finish_reason: 'stop'}]}
        : {error: {message: 'Late provider failure'}};
      bodyController.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      bodyController.close();
      await vi.advanceTimersByTimeAsync(0);
      await expect(next).resolves.toBe('下一条译文');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('issue #952：Ollama 错误正文读取失败仍保留 HTTP 401 鉴权分类并释放槽位', async () => {
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {controller.error(new TypeError('The error response body failed'));},
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(failedBody, {status: 401, headers: {'content-type': 'application/json'}}))
      .mockImplementation(() => Promise.resolve(successResponse('重新配置后的译文')));
    setRuntimeFetch(fetchMock);
    const broker = ollamaBroker(translateWithOpenAICompatibleAiSdk);
    const failed = broker.translateWithCache({
      origin: 'A paragraph rejected by the local server.', requestTimeoutMs: 5_000,
    });
    await expect(failed).rejects.toMatchObject({
      statusCode: 401, kind: 'authentication', retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(broker.translateWithCache({
      origin: 'Another paragraph after updating authentication.', requestTimeoutMs: 5_000,
    })).resolves.toBe('重新配置后的译文');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('issue #952：Ollama 数组和单条入口共用一个真实并发上限', async () => {
    vi.useFakeTimers();
    const transports: ReturnType<typeof deferredResponse>[] = [];
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      const transport = deferredResponse();
      transports.push(transport);
      active += 1;
      peak = Math.max(peak, active);
      return transport.promise.finally(() => {active -= 1;});
    });
    setRuntimeFetch(fetchMock);
    const broker = ollamaBroker(translateWithOpenAICompatibleAiSdk);
    const batch = broker.translateWithCache({
      origin: ['First paragraph in a document.', 'Second paragraph in a document.'],
      requestTimeoutMs: 5_000,
    });
    const single = broker.translateWithCache({
      origin: 'A paragraph from another translation entry.', requestTimeoutMs: 5_000,
    });
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(index + 1);
      expect(active).toBe(1);
      transports[index].resolve(successResponse('正确译文'));
    }
    await expect(batch).resolves.toEqual(['正确译文', '正确译文']);
    await expect(single).resolves.toBe('正确译文');
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === 'http://127.0.0.1:11434/v1/chat/completions')).toBe(true);
  });

  it('uses the configured maximum retry count for SDK-owned HTTP retries', async () => {
    vi.useFakeTimers();
    mockConfig.translationMaxRetries = 1;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(429, 'rate limited')));
    vi.stubGlobal('fetch', fetchMock);

    const request = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
      requestTimeoutMs: 30_000,
    }, mockConfig));
    const outcome = request.catch((reason) => reason);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toMatchObject({kind: 'rate-limit', statusCode: 429});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies a rejected browser fetch for the outer network-only fallback', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
    }, mockConfig)).catch((reason) => reason);

    expect(error).toMatchObject({
      name: 'LlmTransportError',
      kind: 'network',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not misclassify SDK prompt/schema failures as retryable network errors', () => {
    const invalidPrompt = new Error('messages must not be empty');
    invalidPrompt.name = 'AI_InvalidPromptError';
    expect(normalizeAiSdkError(services.custom, invalidPrompt)).toMatchObject({
      kind: 'bad-request',
      retryable: false,
    });

    expect(normalizeAiSdkError(services.custom, new Error('Unexpected SDK response state'))).toMatchObject({
      kind: 'response',
      retryable: false,
    });
  });

  it('classifies an SDK deadline during Retry-After as timeout, not user cancellation', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(
      429,
      'rate limited',
      {'retry-after': '10'},
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: 'hello',
      serviceOverride: services.custom,
      requestTimeoutMs: 1_000,
    }, mockConfig)).catch((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;

    expect(error).toMatchObject({
      name: 'LlmTransportError',
      kind: 'timeout',
      retryable: true,
    });
    expect(error.message).toContain('请求超时');
  });

  it('shares one absolute deadline across a sequential batch', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_input, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(successResponse()), 600);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        reject(abortError);
      }, {once: true});
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = translateWithOpenAICompatibleAiSdk(withProviderSnapshot({
      origin: ['first', 'second'],
      serviceOverride: services.custom,
      requestTimeoutMs: 1_000,
    }, mockConfig)).catch((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;

    expect(error).toMatchObject({kind: 'timeout', retryable: true});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
