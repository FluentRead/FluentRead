/**
 * @file tests/harnessModelGateway.test.ts
 * 文件职责：验证 Harness 模型网关的服务边界、端点、凭据、取消和工具调用请求协议。
 * 主要内容：使用真实 AI SDK provider 加 mock fetch 检查 OpenAI-compatible payload。
 * 模块边界：测试不访问真实网络，不覆盖 UI、会话、Config 持久化或背景路由。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
const planBuild = vi.hoisted(() => ({enabled: false}));
vi.mock('@/src/platform/chatgpt-plan/buildMode', () => ({get chatGPTPlanDevelopmentEnabled() {return planBuild.enabled;}}));
import {generateText, streamText, tool} from 'ai';
import {z} from 'zod';
import {reactive} from 'vue';
import {Config} from '@/src/core/config/model';
import {currentModelIds, services} from '@/src/core/config/catalog';
import {createHarnessLanguageModel, getHarnessModelInputKey, normalizeHarnessModelError, sanitizeHarnessModelMessage} from '@/src/services/harness/modelGateway';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createHarnessRuntime} from '@/src/services/harness/runtime';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
}

describe('harness model gateway', () => {
  afterEach(() => {
    setRuntimeFetch();
    planBuild.enabled = false;
  });

  it.each(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-luna-2026-10-01', 'gpt-6.1-terra-2026-10-01'])(
    'serializes completion limits for %s in generation and streaming without mutating settings', async modelId => {
      const config = new Config();
      for (const [custom, expectedLimit] of [
        ['', 1200], ['{"max_tokens":64}', 64],
        ['{"max_tokens":null,"max_completion_tokens":32,"service_tier":"fast","reasoning_effort":"none"}', 32],
        ['{"max_tokens":null}', 1200], ['{"max_completion_tokens":48}', 48],
        ['{"max_tokens":64,"max_completion_tokens":32}', 32],
        ['{"max_tokens":64,"max_completion_tokens":null}', 64],
      ] as const) {
        config.customBody[services.openai] = custom;
        const before = JSON.stringify(config);
        const calls: Record<string, unknown>[] = [];
        setRuntimeFetch(async (_input, init) => {
          const serialized = String(init?.body);
          expect(serialized).not.toContain('"max_tokens"');
          const body = JSON.parse(serialized); calls.push(body);
          expect(body.max_completion_tokens).toBe(expectedLimit);
          if (custom.includes('service_tier')) expect(body).toMatchObject({service_tier: 'fast', reasoning_effort: 'none'});
          if (body.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
          return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
        });
        const model = createHarnessLanguageModel(config, services.openai, modelId);
        expect((await generateText({model, prompt: 'Explain', maxOutputTokens: 1200, maxRetries: 0})).text).toBe('done');
        expect(await streamText({model, prompt: 'Explain', maxOutputTokens: 1200, maxRetries: 0}).text).toBe('done');
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(config)).toBe(before);
      }
    },
  );

  it.each([[services.openai, 'gpt-4o'], [services.openai, 'gpt-6-luna-other'], [services.openrouter, 'gpt-6-luna'], ['custom:limit', 'gpt-6.1-terra']])(
    'preserves legacy token parameters for %s / %s', async (service, modelId) => {
      const config = new Config();
      config.customOpenAIProviders = [{id: 'custom:limit', name: 'Local', endpoint: 'https://fixture.test/v1', models: [modelId]}];
      setRuntimeFetch(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBe(1200); expect(body).not.toHaveProperty('max_completion_tokens');
        return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
      });
      await generateText({model: createHarnessLanguageModel(config, service, modelId), prompt: 'Explain', maxOutputTokens: 1200, maxRetries: 0});
    },
  );

  it('merges OpenAI generation parameters while retaining SDK session and protocol ownership', async () => {
    const config = new Config();
    const originalKey = getHarnessModelInputKey(config, services.openai, 'gpt-6-luna');
    config.customBody[services.openai] = JSON.stringify({model: 'wrong', messages: [], tools: [], tool_choice: 'none', parallel_tool_calls: false, stream: true, stream_options: {bad: true}, response_format: {type: 'bad'}, temperature: 0.2, service_tier: 'fast', reasoning_effort: 'none'});
    expect(getHarnessModelInputKey(config, services.openai, 'gpt-6-luna')).not.toBe(originalKey);
    setRuntimeFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({model: 'gpt-6-luna', temperature: 0.2, service_tier: 'fast', reasoning_effort: 'none'});
      expect(body.messages).toEqual([{role: 'system', content: 'System'}, {role: 'user', content: 'Explain'}]);
      expect(body.tools[0].function.name).toBe('lookup');
      expect(body.tool_choice).not.toBe('none'); expect(body.parallel_tool_calls).not.toBe(false);
      expect(body.stream).not.toBe(true); expect(body).not.toHaveProperty('stream_options'); expect(body).not.toHaveProperty('response_format');
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens');
      return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    await generateText({model: createHarnessLanguageModel(config, services.openai, 'gpt-6-luna'), system: 'System', prompt: 'Explain', tools: {lookup: tool({inputSchema: z.object({q: z.string()})})}, maxRetries: 0});
  });

  it('rejects invalid OpenAI custom JSON before sending a request', async () => {
    const config = new Config(); config.customBody[services.openai] = '{invalid';
    const fetch = vi.fn(); setRuntimeFetch(fetch);
    await expect(generateText({model: createHarnessLanguageModel(config, services.openai, 'gpt-6-luna'), prompt: 'Explain', maxRetries: 0})).rejects.toThrow('有效的 JSON 对象');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([services.claude, services.gemini])('tracks a native %s proxy change without exposing its credentials', service => {
    const config = new Config();delete config.proxy[service];
    const direct = getHarnessModelInputKey(config, service, 'reader');
    config.proxy[service] = 'https://fixture.test/native?token=private-value';
    const proxied = getHarnessModelInputKey(config, service, 'reader');
    expect(proxied).not.toBe(direct);expect(proxied).toMatch(/^[a-f0-9]{64}$/u);expect(proxied).not.toContain('private-value');
    config.proxy[service] += ' ';expect(getHarnessModelInputKey(config, service, 'reader')).toBe(proxied);
  });

  it('keeps invalid gateway inputs comparable for cancellation and distinguishes repaired endpoint/header inputs', () => {
    const config = new Config();config.deepseekApiType = 'responses';
    const invalid = getHarnessModelInputKey(config, services.deepseek, 'reader');
    expect(invalid).toMatch(/^[a-f0-9]{64}$/u);config.deepseekApiType = 'chat';
    expect(getHarnessModelInputKey(config, services.deepseek, 'reader')).not.toBe(invalid);
    const service = 'custom:key-identity';config.customOpenAIProviders = [{id: service, name: 'Local', endpoint: 'http://localhost:11434/v1', models: ['reader']}];
    config.customHeaders[service] = '{invalid';const badHeader = getHarnessModelInputKey(config, service, 'reader');
    config.customHeaders[service] = '{"x-a":"private-value"}';
    const repaired = getHarnessModelInputKey(config, service, 'reader');expect(repaired).not.toBe(badHeader);expect(repaired).not.toContain('private-value');
  });

  it.each([
    ['mimo', 'https://api.xiaomimimo.com/v1/chat/completions', 'mimo-v2.5', 'mimo-v2.6-flash'],
    ['mimo', 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions', 'mimo-v2.5-pro', 'mimo-v2.6-pro'],
    ['custom:mimo', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro', 'mimo-v2.6-pro'],
    ['mimo', 'https://gateway.example/v1/chat/completions', 'mimo-v2.5', 'mimo-v2.5'],
  ])('reading/writing gateway maps %s at %s without editing saved settings', async (service, endpoint, legacy, expected) => {
    const config = new Config();
    config.harness.model = legacy;
    config.writing.model = legacy;
    if (service.startsWith('custom:')) {
      config.customOpenAIProviders = [{id: service, name: 'MiMo', endpoint, models: [legacy]}];
    } else config.proxy[service] = endpoint;
    const before = JSON.stringify(config);
    const bodies: Record<string, unknown>[] = [];
    setRuntimeFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
      return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    const model = createHarnessLanguageModel(config, service, legacy);
    expect((await generateText({model, prompt: 'Explain', maxRetries: 0})).text).toBe('done');
    expect(await streamText({model, prompt: 'Explain', maxRetries: 0}).text).toBe('done');
    expect(bodies.map(body => body.model)).toEqual([expected, expected]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('refuses saved ChatGPT requests in the public build before any transport and preserves their configuration', () => {
    const config = new Config(); config.service = services.chatgptPlan;
    config.model[services.chatgptPlan] = 'saved-account-model';
    const before = JSON.stringify(config); const fetch = vi.fn(); setRuntimeFetch(fetch);
    expect(() => createHarnessLanguageModel(config, services.chatgptPlan, 'saved-account-model'))
      .toThrow('尚未开放公开接入');
    try {createHarnessLanguageModel(config, services.chatgptPlan, 'saved-account-model');}
    catch (error) {expect(error).toMatchObject({kind: 'bad-request', retryable: false});}
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(config)).toBe(before);
    planBuild.enabled = true;
    expect(createHarnessLanguageModel(config, services.chatgptPlan, 'saved-account-model'))
      .toMatchObject({provider: 'fluentread-chatgpt-plan', modelId: 'saved-account-model'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keys the local plan input only by the trimmed model while preserving saved configuration', () => {
    const config = new Config();
    const key = getHarnessModelInputKey(config, services.chatgptPlan, ' account-model ');
    config.token[services.chatgptPlan] = 'unused-fixture-key';
    config.proxy[services.chatgptPlan] = 'https://unused.fixture/v1';
    config.apiKeys[services.chatgptPlan] = ['unused-fixture-A', 'unused-fixture-B'];
    const before = JSON.stringify(config);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(getHarnessModelInputKey(config, services.chatgptPlan, 'account-model')).toBe(key);
    expect(getHarnessModelInputKey(config, services.chatgptPlan, 'other-model')).not.toBe(key);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('changes the provider input key when rotation, required credentials or thinking changes', () => {
    const config = new Config();
    const service = services.deepseek, model = 'deepseek-v4-flash';
    delete config.token[service];
    const withoutCredential = getHarnessModelInputKey(config, service, model);
    config.token[service] = 'fixture-A';
    expect(getHarnessModelInputKey(config, service, model)).not.toBe(withoutCredential);
    config.apiKeys[service] = ['fixture-A', 'fixture-B'];
    const rotating = getHarnessModelInputKey(config, service, model);
    config.apiKeyRecoveryMs += 60_000;
    const changedRecovery = getHarnessModelInputKey(config, service, model);
    expect(changedRecovery).not.toBe(rotating);
    config.apiKeyRotationEnabled[service] = false;
    const fixedKey = getHarnessModelInputKey(config, service, model);
    expect(fixedKey).not.toBe(changedRecovery);
    config.modelThinking[service] = {[model]: true};
    expect(getHarnessModelInputKey(config, service, model)).not.toBe(fixedKey);
  });

  it('uses the fixed anonymous Bilibili endpoint without residual keys, proxy, tools or model overrides', async () => {
    const config = new Config();
    config.token[services.bilibili] = 'must-not-send';
    config.apiKeys[services.bilibili] = ['must-not-send', 'another-secret'];
    config.proxy[services.bilibili] = 'https://untrusted.fixture/v1';
    config.customHeaders[services.bilibili] = '{"Authorization":"private"}';
    const key = getHarnessModelInputKey(config, services.bilibili, 'untrusted-model');
    setRuntimeFetch(async (input, init) => {
      expect(String(input)).toBe(`https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1/chat/completions`);
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({model: BILIBILI_FREE_TRANSLATION_MODEL, temperature: 0, chat_template_kwargs: {enable_thinking: false}});
      expect(body.messages).toEqual([{role: 'system', content: 'Explain in Chinese'}, {role: 'user', content: 'Source only'}]);
      expect(body).not.toHaveProperty('tools');
      expect(JSON.stringify(init)).not.toContain('must-not-send');
      return response({choices: [{message: {role: 'assistant', content: '免费讲解'}, finish_reason: 'stop'}]});
    });
    const model = createHarnessLanguageModel(config, services.bilibili, 'untrusted-model');
    expect((await generateText({model, system: 'Explain in Chinese', prompt: 'Source only', tools: {lookup: tool({inputSchema: z.object({q: z.string()})})}})).text).toBe('免费讲解');
    config.token[services.bilibili] = 'changed';
    config.proxy[services.bilibili] = 'https://changed.fixture';
    expect(getHarnessModelInputKey(config, services.bilibili, 'changed-model')).toBe(key);
  });

  it('streams Bilibili responses and preserves HTTP failures and cancellation without retries', async () => {
    const config = new Config();
    const signal = new AbortController().signal;
    setRuntimeFetch(async (_input, init) => {
      expect(init?.signal).toBe(signal);
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      return new Response('data: {"id":"bili","choices":[{"index":0,"delta":{"role":"assistant","content":"讲解"},"finish_reason":null}]}\n\ndata: {"id":"bili","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
    });
    expect(await streamText({model: createHarnessLanguageModel(config, services.bilibili, ''), prompt: 'Explain', abortSignal: signal, maxRetries: 0}).text).toBe('讲解');
    const failed = vi.fn(async () => new Response('{"error":{"message":"rate limited"}}', {status: 429}));
    setRuntimeFetch(failed);
    await expect(generateText({model: createHarnessLanguageModel(config, services.bilibili, ''), prompt: 'Explain', maxRetries: 0})).rejects.toMatchObject({statusCode: 429});
    expect(failed).toHaveBeenCalledOnce();
    setRuntimeFetch(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(generateText({model: createHarnessLanguageModel(config, services.bilibili, ''), prompt: 'Explain', abortSignal: signal, maxRetries: 0})).rejects.toThrow('Aborted');
  });

  it('keeps actual SDK transport errors out of the runtime console and still reports sanitized failures', async () => {
    const config = new Config(); config.on = true; config.harness.enabled = true; config.harness.service = services.bilibili;
    const secret = 'sk-fixture-private-123456';
    const source = 'FIXTURE_PRIVATE_SOURCE';
    const failed = vi.fn(async () => new Response(JSON.stringify({error: {message: `authorization: ${secret}`}}), {status: 400, headers: {'content-type': 'application/json'}}));
    setRuntimeFetch(failed);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // 对照真实 SDK 默认行为，确保该错误确实会触发原始控制台日志。
      const baseline = streamText({model: createHarnessLanguageModel(config, services.bilibili, ''), prompt: source, maxRetries: 0});
      let rawError: unknown;
      for await (const part of baseline.fullStream) if (part.type === 'error') rawError = part.error;
      expect(rawError).toMatchObject({statusCode: 400});
      expect(consoleError).toHaveBeenCalledWith(rawError);
      consoleError.mockClear();
      const record = vi.fn();
      const result = await createHarnessRuntime(() => config, () => record).run({type: 'fluentReadHarness', action: 'run', requestId: 'actual-sdk-no-raw-log', intent: 'meaning', question: '', selection: {text: source, context: 'FIXTURE_PRIVATE_CONTEXT', sentence: ''}}, new AbortController().signal);
      expect(result).toMatchObject({success: false, error: expect.stringContaining('HTTP 400')});
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(source);
      expect(consoleError).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({outcome: 'error', serviceId: services.bilibili}));
      expect(failed).toHaveBeenCalledTimes(2);
    } finally { consoleError.mockRestore(); }
  });

  it('keeps custom endpoint query, model, messages and tools', async () => {
    const config = new Config();
    config.customOpenAIProviders = [{id: 'custom:test', name: 'Test', endpoint: 'https://local.test/v1/chat/completions?tenant=a&tenant=b', models: ['my-model']}];
    config.token['custom:test'] = 'secret-key';
    config.customHeaders['custom:test'] = '{"x-opencode-session":"stable-harness-session"}';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(input)).toContain('tenant=a');
      expect(body.model).toBe('my-model');
      expect(new Headers(init?.headers).get('x-opencode-session')).toBe('stable-harness-session');
      expect(body.tools?.[0]?.function?.name).toBe('lookup');
      expect(body.messages).toEqual([{role: 'user', content: 'Explain this sentence'}]);
      expect((init?.headers as Record<string, string>).authorization).toContain('secret-key');
      return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, 'custom:test', 'my-model');
    await generateText({model, messages: [{role: 'user', content: 'Explain this sentence'}], tools: {lookup: tool({description: 'lookup', inputSchema: z.object({q: z.string()})})}});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects machine services and DeepSeek Responses mode', () => {
    const config = new Config();
    expect(() => createHarnessLanguageModel(config, services.google, 'x')).toThrow('尚未适配');
    expect(() => createHarnessLanguageModel(config, 'unknown-service', 'x')).toThrow('尚未适配');
    expect(() => createHarnessLanguageModel(config, services.openai, '   ')).toThrow('选择一个模型');
    config.deepseekApiType = 'responses';
    expect(() => createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat')).toThrow('Responses');
    expect(() => createHarnessLanguageModel({...config, token: {...config.token, [services.zhipu]: 'invalid'}} as Config, services.zhipu, 'glm-test')).toThrow('id.secret');
  });

  it('adds DeepSeek thinking without replacing session messages', async () => {
    const config = new Config();
    config.modelThinking = {[services.deepseek]: {'deepseek-chat': true}};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({type: 'enabled'});
      expect(body.messages).toEqual([{role: 'system', content: 'Use Chinese'}, {role: 'user', content: 'Explain'}]);
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat');
    await generateText({model, system: 'Use Chinese', prompt: 'Explain'});
  });

  it('supports explicit compatible endpoint overrides and disabled thinking', async () => {
    const config = new Config();
    config.proxy[services.deepseek] = 'https://deepseek.test/v1/chat/completions?region=cn';
    config.proxy[services.tongyi] = 'https://qwen.test/v1/chat/completions?region=cn';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).includes('deepseek.test')) expect(body.thinking).toEqual({type: 'disabled'});
      expect(String(input)).toMatch(/(?:deepseek|qwen)\.test/u);
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.deepseek, 'deepseek-chat'), prompt: 'hello'});
    await generateText({model: createHarnessLanguageModel(config, services.tongyi, currentModelIds.tongyiTokenPlan), prompt: 'hello'});
  });

  it('builds a Zhipu bearer token and preserves a configured endpoint query', async () => {
    const config = new Config();
    config.proxy[services.zhipu] = 'https://zhipu.test/api/chat/completions?tenant=reader';
    config.token[services.zhipu] = 'public-id.private-secret';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('tenant=reader');
      const authorization = new Headers(init?.headers).get('authorization') || '';
      expect(authorization.startsWith('Bearer ey')).toBe(true);
      expect(authorization).not.toContain('private-secret');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.zhipu, 'glm-test'), prompt: 'Explain'});
  });

  it('adds service specific headers for Azure and OpenRouter', async () => {
    const azure = new Config();
    azure.token[services.azureOpenai] = 'azure-secret';
    azure.azureOpenaiEndpoint = 'https://azure.test/openai/deployments/reader/chat/completions?api-version=2024-02-15-preview';
    const azureFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(azure.azureOpenaiEndpoint);
      expect(new Headers(init?.headers).get('api-key')).toBe('azure-secret');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(JSON.parse(String(init?.body)).model).toBe('reader');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(azureFetch);
    await generateText({model: createHarnessLanguageModel(azure, services.azureOpenai, 'reader'), prompt: 'hello'});

    const router = new Config();
    router.token[services.openrouter] = 'router-secret';
    const routerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('HTTP-Referer')).toBe('https://fluent.thinkstu.com');
      expect(new Headers(init?.headers).get('X-Title')).toBe('FluentRead Harness');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(routerFetch);
    await generateText({model: createHarnessLanguageModel(router, services.openrouter, 'openrouter/test'), prompt: 'hello'});
  });

  it('normalizes the Azure Foundry resource endpoint for v1 without a dated API version', async () => {
    const config = new Config();
    config.token[services.azureOpenai] = 'azure-secret';
    config.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://reader.services.ai.azure.com/openai/v1/chat/completions');
      expect(new Headers(init?.headers).get('api-key')).toBe('azure-secret');
      expect(JSON.parse(String(init?.body)).model).toBe('deepseek-deployment');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.azureOpenai, 'deepseek-deployment'), prompt: 'hello'});
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses native Claude Messages API and honors configured proxy', async () => {
    const config = new Config();
    config.token[services.claude] = 'claude-secret';
    config.proxy[services.claude] = 'https://claude-proxy.test/v1/messages';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://claude-proxy.test/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('claude-secret');
      expect(new Headers(init?.headers).get('anthropic-dangerous-direct-browser-access')).toBe('true');
      return response({id: 'msg_1', type: 'message', role: 'assistant', content: [{type: 'text', text: 'claude answer'}], stop_reason: 'end_turn', usage: {input_tokens: 2, output_tokens: 3}});
    });
    setRuntimeFetch(fetchMock);
    const result = await generateText({model: createHarnessLanguageModel(config, services.claude, 'claude-sonnet-5'), prompt: 'Explain'});
    expect(result.text).toBe('claude answer');
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('api.anthropic.com');
      return response({id: 'msg_2', type: 'message', role: 'assistant', content: [{type: 'text', text: 'direct'}], stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1}});
    });
    setRuntimeFetch(directFetch);
    const directConfig = new Config();
    directConfig.token[services.claude] = 'direct-secret';
    expect((await generateText({model: createHarnessLanguageModel(directConfig, services.claude, 'claude-test'), prompt: 'Explain'})).text).toBe('direct');
    expect(createHarnessLanguageModel(new Config(), services.claude, 'claude-no-key')).toBeTruthy();
  });

  it('uses native Gemini generateContent API and honors configured proxy', async () => {
    const config = new Config();
    config.token[services.gemini] = 'gemini-secret';
    config.proxy[services.gemini] = 'https://gemini-proxy.test/v1beta/models/gemini-test:generateContent';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://gemini-proxy.test/v1beta/models/gemini-test:generateContent');
      return response({candidates: [{content: {role: 'model', parts: [{text: 'gemini answer'}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5}});
    });
    setRuntimeFetch(fetchMock);
    const result = await generateText({model: createHarnessLanguageModel(config, services.gemini, 'gemini-test'), prompt: 'Explain'});
    expect(result.text).toBe('gemini answer');
    expect(createHarnessLanguageModel(new Config(), services.gemini, 'gemini-test')).toBeTruthy();
  });

  it('uses the Token Plan endpoint for the matching Qwen model', async () => {
    const config = new Config();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('token-plan.cn-beijing.maas.aliyuncs.com');
      return response({choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}]});
    });
    setRuntimeFetch(fetchMock);
    await generateText({model: createHarnessLanguageModel(config, services.tongyi, currentModelIds.tongyiTokenPlan), prompt: 'hello'});
    expect(createHarnessLanguageModel(config, services.tongyi, 'qwen-normal')).toBeTruthy();
  });

  it('normalizes provider details without leaking credential query values', () => {
    const error = new Error('request failed https://api.test/chat?api_key=secret-value&tenant=reader');
    const normalized = normalizeHarnessModelError(error, services.openai, 'secret-value');
    expect(normalized.message).not.toContain('secret-value');
    expect(normalized.message).toContain('api_key=[已隐藏]');
    expect(sanitizeHarnessModelMessage('https://x.test/?token=raw&ok=1')).toBe('https://x.test/?token=[已隐藏]&ok=1');
  });

  it('propagates cancellation through runtime fetch', async () => {
    const config = new Config();
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('Aborted', 'AbortError');
    });
    setRuntimeFetch(fetchMock);
    const model = createHarnessLanguageModel(config, services.openai, 'gpt-test');
    await expect(generateText({model, prompt: 'hello', abortSignal: controller.signal})).rejects.toThrow();
  });
});

describe('harness model gateway multi-key rotation', () => {
  afterEach(() => setRuntimeFetch());

  function multiKeyConfig(id: string): Config {
    const config = new Config();
    config.customOpenAIProviders = [{id, name: 'Rotation fixture', endpoint: 'https://rotation.fixture/v1/chat/completions', models: ['fixture']}];
    config.apiKeys[id] = ['fixture-A', 'fixture-B', 'fixture-C'];
    config.token[id] = 'fixture-A';
    return config;
  }

  it('keeps native model metadata and freezes reactive settings during failover', async () => {
    const config = reactive(new Config());
    config.apiKeys[services.gemini] = ['native-A', 'native-B'];
    config.token[services.gemini] = 'native-A';
    config.proxy[services.gemini] = 'https://native.fixture/generate';
    const model = createHarnessLanguageModel(config, services.gemini, 'gemini-fixture');
    expect(typeof model).toBe('object');
    if (typeof model === 'string') throw new Error('Expected native model');
    expect(model.modelId).toBe('gemini-fixture');
    expect(model.provider).toContain('gemini');
    expect(model.supportedUrls).toHaveProperty('*');
    config.proxy[services.gemini] = 'https://changed.fixture/generate';
    config.apiKeys[services.gemini] = ['changed-key'];
    const seen: string[] = [];
    setRuntimeFetch(async (input, init) => {
      expect(String(input)).toBe('https://native.fixture/generate');
      const key = new Headers(init?.headers).get('x-goog-api-key')!;
      seen.push(key);
      if (key === 'native-A') return new Response(JSON.stringify({error: {message: 'API key not valid'}}), {status: 401});
      return response({candidates: [{content: {role: 'model', parts: [{text: 'native answer'}]}, finishReason: 'STOP'}]});
    });
    expect((await generateText({model, prompt: 'hello'})).text).toBe('native answer');
    expect(seen).toEqual(['native-A', 'native-B']);
  });

  it('tries A then B on auth failure and uses B/C on later requests', async () => {
    const config = multiKeyConfig('custom:rotation-generate');
    const seen: string[] = [];
    setRuntimeFetch(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') || '';
      seen.push(key);
      if (key === 'fixture-A') return new Response(JSON.stringify({error: {message: 'invalid key'}}), {status: 401});
      return response({choices: [{message: {role: 'assistant', content: key}, finish_reason: 'stop'}]});
    }));
    const model = createHarnessLanguageModel(config, 'custom:rotation-generate', 'fixture');
    expect((await generateText({model, prompt: 'one'})).text).toBe('fixture-B');
    expect((await generateText({model, prompt: 'two'})).text).toMatch(/^fixture-[BC]$/u);
    expect(seen.slice(0, 3)).toEqual(['fixture-A', 'fixture-B', expect.any(String)]);
    expect(seen[2]).not.toBe('fixture-A');
  });

  it('retries a stream handshake on the next key but never replays a partial stream', async () => {
    const config = multiKeyConfig('custom:rotation-stream');
    const seen: string[] = [];
    setRuntimeFetch(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') || '';
      seen.push(key);
      if (key === 'fixture-A') return new Response(JSON.stringify({error: {message: 'rate limited'}}), {status: 429});
      const body = [
        `data: ${JSON.stringify({id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {role: 'assistant', content: key}, finish_reason: null}]})}`,
        '',
        `data: ${JSON.stringify({id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}`,
        '', 'data: [DONE]', '', '',
      ].join('\n');
      return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
    }));
    const result = streamText({model: createHarnessLanguageModel(config, 'custom:rotation-stream', 'fixture'), prompt: 'stream'});
    expect(await result.text).toBe('fixture-B');
    expect(seen).toEqual(['fixture-A', 'fixture-B']);

    const partialConfig = multiKeyConfig('custom:rotation-partial');
    let calls = 0;
    let transport: ReadableStreamDefaultController<Uint8Array>;
    setRuntimeFetch(vi.fn(async () => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({start(controller) {
        transport = controller;
        controller.enqueue(new TextEncoder().encode('data: {"id":"partial","choices":[{"index":0,"delta":{"role":"assistant","content":"once"},"finish_reason":null}]}\n\n'));
      }});
      return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream'}});
    }));
    const partial = streamText({model: createHarnessLanguageModel(partialConfig, 'custom:rotation-partial', 'fixture'), prompt: 'partial'});
    const chunks = partial.textStream[Symbol.asyncIterator]();
    expect(await chunks.next()).toEqual({value: 'once', done: false});
    transport!.error(new Error('partial stream failure'));
    await expect(chunks.next()).rejects.toThrow('partial stream failure');
    expect(calls).toBe(1);
  });
});


it('网关拒绝非法头并遮罩错误回显，头配置快照不随后续编辑改变', async () => {
    const config = new Config();
    config.customOpenAIProviders = [{id: 'custom:headers', name: 'Headers', endpoint: 'https://fixture.example/v1/chat/completions', models: ['model']}];
    config.customHeaders['custom:headers'] = '{"x":1}';
    expect(() => createHarnessLanguageModel(config, 'custom:headers', 'model')).toThrow('自定义请求头');
    expect(normalizeHarnessModelError(new Error('failure'), 'custom:headers', '', '{oops').message).toContain('failure');
    config.customHeaders['custom:headers'] = '{"x-auth":"private-header"}';
    expect(normalizeHarnessModelError(new Error('private-header rejected'), 'custom:headers', '', config.customHeaders['custom:headers']).message).not.toContain('private-header');
    const model = createHarnessLanguageModel(config, 'custom:headers', 'model');
    config.customHeaders['custom:headers'] = '{"x-auth":"changed"}';
    setRuntimeFetch(async (_input, init) => {
        expect(new Headers(init?.headers).get('x-auth')).toBe('private-header');
        return response({choices: [{message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}]});
    });
    try { await generateText({model, prompt: 'fixture'}); } finally { setRuntimeFetch(); }
});
