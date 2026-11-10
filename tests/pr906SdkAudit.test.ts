/** PR #906 独立审计：真实 SDK + 注入的假 HTTP transport；不访问模型服务。 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {}, configReady: Promise.resolve()}));

import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {Config} from '@/src/core/config/model';
import {DOUBAO_SEED_TRANSLATION_MODEL_ID} from '@/src/core/config/doubaoSeedTranslation';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {buildPageSummaryPrompt, buildPageSummarySystemPrompt} from '@/src/core/translation/prompts';
import {translateWithOpenAICompatibleAiSdk, type AiSdkTranslationRequest} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import doubao from '@/src/providers/translation/doubao';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createTranslationBroker} from '@/src/services/translation/broker';
import type {TranslationConfigSource, TranslationRequestMessage} from '@/src/services/translation/types';
import {attachTranslationGlossaryContext} from '@/src/services/translation/requestSnapshot';

function configFor(service: string = services.custom) {
  const defaults = new Config();
  const current = {
    service, from: 'en', to: 'zh-Hans', useCache: false, enableAIContext: false,
    model: {[service]: 'audit-model'}, customModel: {}, customBody: {}, customHeaders: {},
    token: {[service]: 'fake-sdk-audit-primary'}, apiKeys: {} as Record<string, string[]>,
    apiKeyRotationEnabled: {} as Record<string, boolean>, proxy: {}, requireApiKey: {},
    system_role: {[service]: 'Translate the supplied text.'},
    user_role: {[service]: 'Translate {{origin}} into {{to}}.'},
    custom: 'http://127.0.0.1:11434/v1/chat/completions',
    deeplx: defaults.deeplx, newApiUrl: defaults.newApiUrl,
    minimaxBillingPlan: defaults.minimaxBillingPlan, minimaxRegion: defaults.minimaxRegion,
    mimoBillingPlan: defaults.mimoBillingPlan, mimoRegion: defaults.mimoRegion,
    azureOpenaiEndpoint: defaults.azureOpenaiEndpoint,
    deepseekApiType: defaults.deepseekApiType, deepseekThinkingMode: defaults.deepseekThinkingMode,
    maxConcurrentTranslations: 2, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
    translationMaxRetries: 0,
  };
  return current satisfies TranslationConfigSource;
}

function brokerFor(current: ReturnType<typeof configFor>) {
  return createTranslationBroker({
    ready: Promise.resolve(), getConfig: () => current,
    providers: {
      [services.custom]: message => translateWithOpenAICompatibleAiSdk(message as unknown as AiSdkTranslationRequest),
      [services.doubao]: message => doubao(message as unknown as Parameters<typeof doubao>[0]),
    },
    cache: {get: async () => null, set: async () => true, clear: async () => undefined, cleanup: async () => undefined},
    serviceTypes: servicesType,
    endpointResolver: {resolveOpenAICompatibleEndpoint, aiSdkTransportProfile: 'ai-sdk'},
    promptBuilder: {buildPageSummaryPrompt, buildPageSummarySystemPrompt},
    getMissingCredentialMessage,
    getTranslationLanguages: override => resolveTranslationLanguages(override, {
      sourceLanguage: current.from, targetLanguage: current.to,
    }),
    resolveConfiguredModel, buildTranslationCacheKey: identity => JSON.stringify(identity),
    logger: {warn: vi.fn()},
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {resolve = res;});
  return {promise, resolve};
}

function success(text = '有效中文译文') {
  return new Response(JSON.stringify({
    choices: [{message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
    model: 'audit-model', usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
  }), {status: 200, headers: {'content-type': 'application/json'}});
}

function failure() {
  return new Response(JSON.stringify({error: {message: 'Synthetic provider failure'}}), {
    status: 500, headers: {'content-type': 'application/json'},
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('fetch', vi.fn(() => {throw new Error('Audit forbids real network');}));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  const timers = vi.getTimerCount();
  setRuntimeFetch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(timers).toBe(0);
});

describe('PR #906 actual SDK settlement and effective pending policy', () => {
  it.each(['private-context', 'another-key'] as const)(
    'a 429 cools the frozen quota while %s can use the free transport slot', async isolation => {
      const current = configFor();
      current.maxConcurrentTranslations = 1;
      const fetchMock = vi.fn(() => Promise.resolve(fetchMock.mock.calls.length === 1
        ? new Response(JSON.stringify({error: {message: 'Synthetic quota limit'}}), {
          status: 429, headers: {'content-type': 'application/json', 'retry-after': '2'},
        }) : success()));
      setRuntimeFetch(fetchMock);
      const broker = brokerFor(current);
      const invoke = (origin: string, privateContext = false) => broker.translateWithCache(
        attachTranslationGlossaryContext({origin, requestTimeoutMs: 5_000}, {privateContext}),
      );
      const first = invoke('The first synthetic paragraph exceeds its API quota.').catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toMatchObject({kind: 'rate-limit', statusCode: 429});
      const cooled = invoke('The second synthetic paragraph must respect the shared cooldown.');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (isolation === 'another-key') current.token[services.custom] = 'fake-sdk-audit-secondary';
      const healthy = invoke('The third synthetic paragraph belongs to an isolated healthy quota.', isolation === 'private-context');
      await vi.advanceTimersByTimeAsync(0);
      await expect(healthy).resolves.toBe('有效中文译文');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(cooled).resolves.toBe('有效中文译文');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it.each([200, 500])('HTTP %s body already arrived: a deadline retains the real attempt slot until body EOF', async status => {
    const current = configFor();
    current.maxConcurrentTranslations = 1;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(controller) {bodyController = controller;}});
    let firstSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      firstSignal ??= init?.signal;
      return Promise.resolve(fetchMock.mock.calls.length === 1
        ? new Response(body, {status, headers: {'content-type': 'application/json'}})
        : success('下一条中文译文'));
    });
    setRuntimeFetch(fetchMock);
    const broker = brokerFor(current);
    const first = broker.translateWithCache({
      origin: 'The first synthetic paragraph has a response with an unfinished body.', requestTimeoutMs: 1_000,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toMatchObject({name: 'TranslationProviderDeadlineError'});
    expect(firstSignal?.aborted).toBe(true);
    const next = broker.translateWithCache({
      origin: 'The second synthetic paragraph must wait for the physical body.', requestTimeoutMs: 5_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      const content = status === 200
        ? {choices: [{message: {role: 'assistant', content: '迟到中文译文'}, finish_reason: 'stop'}]}
        : {error: {message: 'Synthetic late provider failure'}};
      bodyController.enqueue(new TextEncoder().encode(JSON.stringify(content)));
      bodyController.close();
      await vi.advanceTimersByTimeAsync(0);
      await expect(next).resolves.toBe('下一条中文译文');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['single', 'batch', 'summary'] as const)('%s: a Seed-configured provider overridden to SDK isolates pending by actual retry policy', async entry => {
    const current = configFor(services.doubao);
    current.model[services.doubao] = DOUBAO_SEED_TRANSLATION_MODEL_ID;
    current.enableAIContext = entry === 'summary';
    const initial = [deferred<Response>(), deferred<Response>()];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return initial[bodies.length - 1]?.promise ?? Promise.resolve(success());
    });
    setRuntimeFetch(fetchMock);
    const broker = brokerFor(current);
    const invoke = (sequence: number) => {
      const options = {modelOverride: 'sdk-override-model', requestTimeoutMs: 10_000};
      let message: TranslationRequestMessage;
      if (entry === 'batch') {
        message = {origin: ['The shared synthetic source paragraph.'], ...options};
      } else if (entry === 'summary') {
        message = {
          origin: `The synthetic translation paragraph ${sequence}.`, ...options,
          pageContext: 'The shared synthetic page context for summarization.'.repeat(30),
        };
      } else {
        message = {origin: 'The shared synthetic source paragraph.', ...options};
      }
      return broker.translateWithCache(message).catch(error => error);
    };
    const first = invoke(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current.translationMaxRetries = 1;
    const second = invoke(2);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Both physical first attempts must exist before either one can settle.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      initial.forEach(transport => transport.resolve(failure()));
      await vi.advanceTimersByTimeAsync(3_000);
    }
    const outcomes = await Promise.all([first, second]);
    if (entry === 'summary') {
      // First summary fails without retry; second retries once; each entry then translates.
      expect(outcomes).toEqual(['有效中文译文', '有效中文译文']);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } else {
      expect(outcomes[0]).toMatchObject({kind: 'provider', statusCode: 500});
      expect(outcomes[1]).toEqual(entry === 'batch' ? ['有效中文译文'] : '有效中文译文');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
    expect(bodies.every(body => body.model === 'sdk-override-model' && body.stream === false)).toBe(true);
  });

  it('rotation normalizes SDK retries to zero: pending stays shared and each physical key is attempted once', async () => {
    const current = configFor();
    current.apiKeys[services.custom] = ['fake-sdk-rotation-primary', 'fake-sdk-rotation-secondary'];
    current.apiKeyRotationEnabled[services.custom] = true;
    current.translationMaxRetries = 2;
    const initial = deferred<Response>();
    const credentials: Array<string | null> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      credentials.push(new Headers(init?.headers).get('authorization'));
      return credentials.length === 1 ? initial.promise : Promise.resolve(failure());
    });
    setRuntimeFetch(fetchMock);
    const broker = brokerFor(current);
    const invoke = () => broker.translateWithCache({
      origin: 'The same synthetic source while the key rotation policy is active.', requestTimeoutMs: 10_000,
    }).catch(error => error);
    const first = invoke();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current.translationMaxRetries = 0;
    const second = invoke();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      initial.resolve(failure());
      await vi.advanceTimersByTimeAsync(3_000);
    }
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0]).toMatchObject({statusCode: 500});
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentials).toEqual([
      'Bearer fake-sdk-rotation-primary', 'Bearer fake-sdk-rotation-secondary',
    ]);
  });
});
