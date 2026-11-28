/**
 * @file tests/harnessModelGateway.test.ts
 * 文件职责：验证 Harness 轻量模型网关的服务边界、端点、凭据、取消、工具调用、多 Key 轮转和 ChatGPT 套餐协议。
 * 主要内容：使用真实轻量 HTTP/SSE 生成器与可控 runtimeFetch 检查 OpenAI-compatible、Claude、Gemini、B站及 ChatGPT 套餐请求和响应行为。
 * 模块边界：测试不访问真实网络，不覆盖 UI、会话、Config 持久化或背景路由。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
const planBuild = vi.hoisted(() => ({enabled: false}));
const planBridge = vi.hoisted(() => ({respond: vi.fn()}));
vi.mock('@/src/platform/chatgpt-plan/buildMode', () => ({get chatGPTPlanDevelopmentEnabled() {return planBuild.enabled;}}));
vi.mock('@/src/platform/chatgpt-plan/bridge', async actual => {
  const real = await actual<typeof import('@/src/platform/chatgpt-plan/bridge')>();
  return {...real, requestChatGPTPlanResponse: (...args: Parameters<typeof real.requestChatGPTPlanResponse>) => planBridge.respond(...args)};
});
import {reactive} from 'vue';
import {Config} from '@/src/core/config/model';
import {currentModelIds, services} from '@/src/core/config/catalog';
import {createHarnessGenerator} from '@/src/services/harness/generation';
import {createHarnessStreamExecutor, getHarnessModelInputKey, normalizeHarnessModelError, sanitizeHarnessModelMessage} from '@/src/services/harness/modelGateway';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createHarnessRuntime} from '@/src/services/harness/runtime';
import type {HarnessGenerateInput, HarnessToolDefinition} from '@/src/core/harness/loop';

const sse = (chunks: unknown[]) => new Response(
  chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''),
  {status: 200, headers: {'content-type': 'text/event-stream'}},
);
const openaiSse = (content = 'done') => sse([
  {id: 'chat', choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}]},
  {id: 'chat', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]},
  '[DONE]',
]);
const claudeSse = (text = 'claude answer') => sse([
  {type: 'message_start', message: {id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: {input_tokens: 2, output_tokens: 0}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 3}},
  {type: 'message_stop'},
]);
const geminiSse = (text = 'gemini answer') => sse([
  {candidates: [{content: {role: 'model', parts: [{text}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5}},
]);
const promptInput = (text = 'Explain', overrides: Partial<HarnessGenerateInput> = {}): HarnessGenerateInput => ({
  system: 'System',
  messages: [{role: 'user', content: text}],
  tools: [],
  signal: new AbortController().signal,
  ...overrides,
});

describe('harness model gateway', () => {
  afterEach(() => {
    setRuntimeFetch();
    planBuild.enabled = false;
    planBridge.respond.mockReset();
  });

  it.each([services.openai, services.bilibili, services.chatgptPlan, 'custom:closed'])('rejects disabled %s before constructing any AI transport', service => {
    const config = new Config(); config.disabledTranslationServices = [service];
    const before = JSON.stringify(config);
    expect(() => createHarnessGenerator(config, service, 'saved-model', [])).toThrow('所选翻译服务已关闭');
    expect(JSON.stringify(config)).toBe(before);
  });

  it.each(['gpt-4o', 'o3', 'gpt-5', 'gpt-6-luna', 'gpt-6.1-terra', 'future-model-alias'])(
    'serializes completion limits for %s in streaming without mutating settings', async modelId => {
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
          return openaiSse('done');
        });
        const generate = createHarnessGenerator(config, services.openai, modelId, []);
        expect((await generate(promptInput())).text).toBe('done');
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(config)).toBe(before);
      }
    },
  );

  it.each([[services.openrouter, 'gpt-6-luna'], ['custom:limit', 'gpt-6.1-terra']])(
    'preserves legacy token parameters for %s / %s', async (service, modelId) => {
      const config = new Config();
      config.customOpenAIProviders = [{id: 'custom:limit', name: 'Local', endpoint: 'https://fixture.test/v1', models: [modelId]}];
      setRuntimeFetch(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBe(1200); expect(body).not.toHaveProperty('max_completion_tokens');
        return openaiSse('done');
      });
      await createHarnessGenerator(config, service, modelId, [])(promptInput());
    },
  );

  it('merges OpenAI generation parameters while retaining session and protocol ownership', async () => {
    const config = new Config();
    const originalKey = getHarnessModelInputKey(config, services.openai, 'gpt-6-luna');
    config.customBody[services.openai] = JSON.stringify({model: 'wrong', messages: [], tools: [], tool_choice: 'none', parallel_tool_calls: false, stream: false, stream_options: {bad: true}, response_format: {type: 'bad'}, temperature: 0.2, service_tier: 'fast', reasoning_effort: 'none'});
    expect(getHarnessModelInputKey(config, services.openai, 'gpt-6-luna')).not.toBe(originalKey);
    const tools: HarnessToolDefinition[] = [{name: 'lookup', description: 'lookup', input: {type: 'object', properties: {q: {type: 'string'}}}}];
    setRuntimeFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({model: 'gpt-6-luna', temperature: 0.2, service_tier: 'fast', reasoning_effort: 'none'});
      expect(body.messages).toEqual([{role: 'system', content: 'System'}, {role: 'user', content: 'Explain'}]);
      expect(body.tools[0].function.name).toBe('lookup');
      expect(body.tool_choice).not.toBe('none'); expect(body.parallel_tool_calls).not.toBe(false);
      expect(body.stream).toBe(true); expect(body).not.toHaveProperty('stream_options'); expect(body).not.toHaveProperty('response_format');
      return openaiSse('done');
    });
    await createHarnessGenerator(config, services.openai, 'gpt-6-luna', tools, undefined, {allowedTools: ['lookup']})(promptInput('Explain', {tools}));
  });

  it.each([
    ['custom:protocol', 'https://api.openai.com/v1/chat/completions', '', 'max_completion_tokens'],
    [services.openai, 'https://gateway.test/v1/chat/completions', '', 'max_tokens'],
    ['custom:protocol', 'https://gateway.test/v1/chat/completions', '{"max_completion_tokens":80,"reasoning_effort":"none","service_tier":"fast"}', 'max_completion_tokens'],
    [services.deepseek, 'https://api.deepseek.com/chat/completions', '{"thinking":{"type":"enabled"}}', 'max_tokens'],
  ])('uses actual endpoint and explicit custom parameters for %s at %s', async (service, endpoint, custom, field) => {
    const config = new Config();
    config.proxy[service] = endpoint;
    config.customOpenAIProviders = [{id: 'custom:protocol', name: 'Protocol', endpoint, models: ['alias']}];
    config.customBody[service] = custom;
    const key = getHarnessModelInputKey(config, service, 'alias');
    setRuntimeFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body[field]).toBe(custom.includes('80') ? 80 : 1200);
      expect(body).not.toHaveProperty(field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens');
      if (custom.includes('service_tier')) expect(body).toMatchObject({reasoning_effort: 'none', service_tier: 'fast'});
      if (service === services.deepseek) expect(body.thinking).toEqual({type: 'enabled'});
      return openaiSse('done');
    });
    await createHarnessGenerator(config, service, 'alias', [])(promptInput());
    config.customBody[service] = '{"temperature":0.4}';
    expect(getHarnessModelInputKey(config, service, 'alias')).not.toBe(key);
  });

  it('rejects invalid OpenAI custom JSON before sending a request', async () => {
    const config = new Config(); config.customBody[services.openai] = '{invalid';
    const fetch = vi.fn(); setRuntimeFetch(fetch);
    await expect(createHarnessGenerator(config, services.openai, 'gpt-6-luna', [])(promptInput())).rejects.toThrow('有效的 JSON 对象');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([services.claude, services.gemini])('tracks a native %s proxy change without exposing its credentials', service => {
    const config = new Config(); delete config.proxy[service];
    const direct = getHarnessModelInputKey(config, service, 'reader');
    config.proxy[service] = 'https://fixture.test/native?token=private-value';
    const proxied = getHarnessModelInputKey(config, service, 'reader');
    expect(proxied).not.toBe(direct); expect(proxied).toMatch(/^[a-f0-9]{64}$/u); expect(proxied).not.toContain('private-value');
    config.proxy[service] += ' '; expect(getHarnessModelInputKey(config, service, 'reader')).toBe(proxied);
  });

  it('keeps invalid gateway inputs comparable for cancellation and distinguishes repaired endpoint/header inputs', () => {
    const config = new Config(); config.deepseekApiType = 'responses';
    const invalid = getHarnessModelInputKey(config, services.deepseek, 'reader');
    expect(invalid).toMatch(/^[a-f0-9]{64}$/u); config.deepseekApiType = 'chat';
    expect(getHarnessModelInputKey(config, services.deepseek, 'reader')).not.toBe(invalid);
    const service = 'custom:key-identity'; config.customOpenAIProviders = [{id: service, name: 'Local', endpoint: 'http://localhost:11434/v1', models: ['reader']}];
    config.customHeaders[service] = '{invalid'; const badHeader = getHarnessModelInputKey(config, service, 'reader');
    config.customHeaders[service] = '{"x-a":"private-value"}';
    const repaired = getHarnessModelInputKey(config, service, 'reader'); expect(repaired).not.toBe(badHeader); expect(repaired).not.toContain('private-value');
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
      return openaiSse('done');
    });
    const generate = createHarnessGenerator(config, service, legacy, []);
    expect((await generate(promptInput())).text).toBe('done');
    expect(bodies.map(body => body.model)).toEqual([expected]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('refuses saved ChatGPT requests in the public build and streams text, tools, usage and errors when enabled', async () => {
    const config = new Config(); config.service = services.chatgptPlan;
    config.model[services.chatgptPlan] = 'saved-account-model';
    const before = JSON.stringify(config); const fetch = vi.fn(); setRuntimeFetch(fetch);
    expect(() => createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', []))
      .toThrow('尚未开放公开接入');
    try {createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', []);}
    catch (error) {expect(error).toMatchObject({kind: 'bad-request', retryable: false});}
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(config)).toBe(before);

    planBuild.enabled = true;
    expect(() => createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', [{name: 'bad_tool', description: 'no', input: {}}])).toThrow('不支持的阅读助手工具');

    const planEvent = (type: string, fields: Record<string, unknown> = {}) => `data: ${JSON.stringify({type, ...fields})}\n\n`;
    const planResp = (body: string) => new Response(body, {headers: {'Content-Type': 'text/event-stream'}});
    const toolDef: HarnessToolDefinition[] = [{name: 'read_context', description: 'read', input: {type: 'object'}}];
    const searchTool: HarnessToolDefinition[] = [{name: 'search_memory', description: 'search', input: {type: 'object', properties: {query: {type: 'string'}}}}];
    const usageSink = vi.fn();
    const validateStep = vi.fn();
    planBridge.respond.mockResolvedValueOnce(planResp(
      planEvent('response.output_text.delta', {delta: '套餐'})
      + planEvent('response.output_text.delta', {delta: '回答'})
      + planEvent('response.completed', {
        response: {
          id: 'r1', status: 'completed', model: 'saved-account-model',
          output: [
            {type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: '套餐回答'}]},
            {type: 'function_call', namespace: 'fluentread', call_id: 'c1', name: 'fluentread.read_context', arguments: '{"reason":"check"}'},
          ],
          usage: {input_tokens: 10, output_tokens: 4, input_tokens_details: {cached_tokens: 2}, output_tokens_details: {reasoning_tokens: 1}},
        },
      }),
    ));
    const onText = vi.fn();
    const generated = await createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', toolDef, usageSink, {validateStep})({
      system: 'Sys',
      messages: [
        {role: 'user', content: 'Hello'},
        {role: 'assistant', content: [{type: 'text', text: 'Prior'}]},
        {role: 'user', content: null as never},
      ],
      tools: toolDef,
      signal: new AbortController().signal,
      onText,
    });
    expect(generated.text).toBe('套餐回答');
    expect(onText).toHaveBeenCalledWith('套餐回答');
    expect(generated.toolCalls).toEqual([{id: 'c1', name: 'read_context', input: {reason: 'check'}}]);
    expect(validateStep).toHaveBeenCalledWith(expect.objectContaining({actualModel: 'saved-account-model', finishReason: 'tool-calls'}));
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: services.chatgptPlan, inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, reasoningTokens: 1, outcome: 'success',
    }));

    // Empty system prompt, explicit schema tool, missing usage, tool-only output & failing usage sink
    planBridge.respond.mockResolvedValueOnce(planResp(planEvent('response.completed', {
      response: {
        id: 'r2', status: 'completed', model: 'saved-account-model',
        output: [{type: 'function_call', namespace: 'fluentread', call_id: 'c2', name: 'search_memory', arguments: '{"query":"q"}'}],
      },
    })));
    const toolOnly = await createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', searchTool, () => {throw new Error('sink');}, {
      allowedTools: ['search_memory'], purpose: 'writing',
    })({system: '', messages: [{role: 'user', content: 'Hi'}], tools: searchTool, signal: new AbortController().signal});
    expect(toolOnly.text).toBe('');
    expect(toolOnly.toolCalls).toEqual([{id: 'c2', name: 'search_memory', input: {query: 'q'}}]);

    // Invalid tool JSON
    planBridge.respond.mockResolvedValueOnce(planResp(planEvent('response.completed', {
      response: {
        id: 'r3', status: 'completed', model: 'saved-account-model',
        output: [{type: 'function_call', namespace: 'fluentread', call_id: 'c3', name: 'read_context', arguments: '{broken'}],
      },
    })));
    await expect(createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', toolDef, usageSink)(promptInput())).rejects.toThrow('不是有效 JSON');
    expect(usageSink.mock.lastCall?.[0]).toMatchObject({outcome: 'error'});

    // Timeout & cancelled outcomes + unreported usage when stream finishes without finish event
    for (const reason of [new Error('请求超时'), new Error('user cancelled')]) {
      const abort = new AbortController();
      planBridge.respond.mockImplementationOnce(async () => {abort.abort(reason); throw reason;});
      await expect(createHarnessGenerator(config, services.chatgptPlan, 'saved-account-model', [], usageSink)(promptInput('Hi', {signal: abort.signal}))).rejects.toThrow();
      expect(usageSink.mock.lastCall?.[0].outcome).toBe(reason.message.includes('超时') ? 'timeout' : 'cancelled');
    }
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
      return openaiSse('免费讲解');
    });
    const generate = createHarnessGenerator(config, services.bilibili, 'untrusted-model', []);
    expect((await generate({system: 'Explain in Chinese', messages: [{role: 'user', content: 'Source only'}], tools: [], signal: new AbortController().signal})).text).toBe('免费讲解');
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
      return openaiSse('讲解');
    });
    expect((await createHarnessGenerator(config, services.bilibili, '', [])(promptInput('Explain', {signal}))).text).toBe('讲解');
    const failed = vi.fn(async () => new Response('{"error":{"message":"rate limited"}}', {status: 429}));
    setRuntimeFetch(failed);
    await expect(createHarnessGenerator(config, services.bilibili, '', [])(promptInput())).rejects.toMatchObject({statusCode: 429});
    expect(failed).toHaveBeenCalledOnce();
    setRuntimeFetch(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(createHarnessGenerator(config, services.bilibili, '', [])(promptInput('Explain', {signal}))).rejects.toThrow('Aborted');
  });

  it('keeps transport errors out of the runtime console and still reports sanitized failures', async () => {
    const config = new Config(); config.on = true; config.harness.enabled = true; config.harness.service = services.bilibili;
    const secret = 'sk-fixture-private-123456';
    const source = 'FIXTURE_PRIVATE_SOURCE';
    const failed = vi.fn(async () => new Response(JSON.stringify({error: {message: `authorization: ${secret}`}}), {status: 400, headers: {'content-type': 'application/json'}}));
    setRuntimeFetch(failed);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const record = vi.fn();
      const result = await createHarnessRuntime(() => config, () => record).run({type: 'fluentReadHarness', action: 'run', requestId: 'actual-no-raw-log', intent: 'meaning', question: '', selection: {text: source, context: 'FIXTURE_PRIVATE_CONTEXT', sentence: ''}}, new AbortController().signal);
      expect(result).toMatchObject({success: false, error: expect.stringContaining('HTTP 400')});
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(source);
      expect(consoleError).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({outcome: 'error', serviceId: services.bilibili}));
      expect(failed).toHaveBeenCalledTimes(1);
    } finally { consoleError.mockRestore(); }
  });

  it('keeps custom endpoint query, model, messages and tools', async () => {
    const config = new Config();
    config.customOpenAIProviders = [{id: 'custom:test', name: 'Test', endpoint: 'https://local.test/v1/chat/completions?tenant=a&tenant=b', models: ['my-model']}];
    config.token['custom:test'] = 'secret-key';
    config.customHeaders['custom:test'] = '{"x-opencode-session":"stable-harness-session"}';
    const tools: HarnessToolDefinition[] = [{name: 'lookup', description: 'lookup', input: {type: 'object', properties: {q: {type: 'string'}}}}];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(input)).toContain('tenant=a');
      expect(body.model).toBe('my-model');
      expect(new Headers(init?.headers).get('x-opencode-session')).toBe('stable-harness-session');
      expect(body.tools?.[0]?.function?.name).toBe('lookup');
      expect(body.messages).toEqual([{role: 'system', content: 'System'}, {role: 'user', content: 'Explain this sentence'}]);
      expect(new Headers(init?.headers).get('authorization')).toContain('secret-key');
      return openaiSse('done');
    });
    setRuntimeFetch(fetchMock);
    const generate = createHarnessGenerator(config, 'custom:test', 'my-model', tools, undefined, {allowedTools: ['lookup']});
    await generate(promptInput('Explain this sentence', {tools}));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects machine services and DeepSeek Responses mode', async () => {
    const config = new Config();
    expect(() => createHarnessGenerator(config, services.google, 'x', [])).toThrow('尚未适配');
    expect(() => createHarnessGenerator(config, 'unknown-service', 'x', [])).toThrow('尚未适配');
    expect(() => createHarnessGenerator(config, services.openai, '   ', [])).toThrow('选择一个模型');
    config.deepseekApiType = 'responses';
    await expect(createHarnessGenerator(config, services.deepseek, 'deepseek-chat', [])(promptInput())).rejects.toThrow('Responses');
    await expect(createHarnessGenerator({...config, token: {...config.token, [services.zhipu]: 'invalid'}} as Config, services.zhipu, 'glm-test', [])(promptInput())).rejects.toThrow('id.secret');
  });

  it('adds DeepSeek thinking without replacing session messages', async () => {
    const config = new Config();
    config.modelThinking = {[services.deepseek]: {'deepseek-chat': true}};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({type: 'enabled'});
      expect(body.messages).toEqual([{role: 'system', content: 'Use Chinese'}, {role: 'user', content: 'Explain'}]);
      return openaiSse('ok');
    });
    setRuntimeFetch(fetchMock);
    await createHarnessGenerator(config, services.deepseek, 'deepseek-chat', [])(promptInput('Explain', {system: 'Use Chinese'}));
  });

  it('supports explicit compatible endpoint overrides and disabled thinking', async () => {
    const config = new Config();
    config.proxy[services.deepseek] = 'https://deepseek.test/v1/chat/completions?region=cn';
    config.proxy[services.tongyi] = 'https://qwen.test/v1/chat/completions?region=cn';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).includes('deepseek.test')) expect(body.thinking).toEqual({type: 'disabled'});
      expect(String(input)).toMatch(/(?:deepseek|qwen)\.test/u);
      return openaiSse('ok');
    });
    setRuntimeFetch(fetchMock);
    await createHarnessGenerator(config, services.deepseek, 'deepseek-chat', [])(promptInput('hello'));
    await createHarnessGenerator(config, services.tongyi, currentModelIds.tongyiTokenPlan, [])(promptInput('hello'));
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
      return openaiSse('ok');
    });
    setRuntimeFetch(fetchMock);
    await createHarnessGenerator(config, services.zhipu, 'glm-test', [])(promptInput());
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
      return openaiSse('ok');
    });
    setRuntimeFetch(azureFetch);
    await createHarnessGenerator(azure, services.azureOpenai, 'reader', [])(promptInput('hello'));

    const router = new Config();
    router.token[services.openrouter] = 'router-secret';
    const routerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('HTTP-Referer')).toBe('https://read.thinkstu.com');
      expect(new Headers(init?.headers).get('X-Title')).toBe('FluentRead Harness');
      return openaiSse('ok');
    });
    setRuntimeFetch(routerFetch);
    await createHarnessGenerator(router, services.openrouter, 'openrouter/test', [])(promptInput('hello'));
  });

  it('normalizes the Azure Foundry resource endpoint for v1 without a dated API version', async () => {
    const config = new Config();
    config.token[services.azureOpenai] = 'azure-secret';
    config.azureOpenaiEndpoint = 'https://reader.services.ai.azure.com';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://reader.services.ai.azure.com/openai/v1/chat/completions');
      expect(new Headers(init?.headers).get('api-key')).toBe('azure-secret');
      expect(JSON.parse(String(init?.body)).model).toBe('deepseek-deployment');
      return openaiSse('ok');
    });
    setRuntimeFetch(fetchMock);
    await createHarnessGenerator(config, services.azureOpenai, 'deepseek-deployment', [])(promptInput('hello'));
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
      return claudeSse('claude answer');
    });
    setRuntimeFetch(fetchMock);
    expect((await createHarnessGenerator(config, services.claude, 'claude-sonnet-5', [])(promptInput())).text).toBe('claude answer');
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('api.anthropic.com');
      return claudeSse('direct');
    });
    setRuntimeFetch(directFetch);
    const directConfig = new Config();
    directConfig.token[services.claude] = 'direct-secret';
    expect((await createHarnessGenerator(directConfig, services.claude, 'claude-test', [])(promptInput())).text).toBe('direct');
    expect(createHarnessGenerator(new Config(), services.claude, 'claude-no-key', [])).toBeTruthy();
  });

  it('uses native Gemini streamGenerateContent API and honors configured proxy', async () => {
    const config = new Config();
    config.token[services.gemini] = 'gemini-secret';
    config.proxy[services.gemini] = 'https://gemini-proxy.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://gemini-proxy.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
      return geminiSse('gemini answer');
    });
    setRuntimeFetch(fetchMock);
    expect((await createHarnessGenerator(config, services.gemini, 'gemini-test', [])(promptInput())).text).toBe('gemini answer');
    expect(createHarnessGenerator(new Config(), services.gemini, 'gemini-test', [])).toBeTruthy();
  });

  it('uses the Token Plan endpoint for the matching Qwen model', async () => {
    const config = new Config();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('token-plan.cn-beijing.maas.aliyuncs.com');
      return openaiSse('ok');
    });
    setRuntimeFetch(fetchMock);
    await createHarnessGenerator(config, services.tongyi, currentModelIds.tongyiTokenPlan, [])(promptInput('hello'));
    expect(createHarnessGenerator(config, services.tongyi, 'qwen-normal', [])).toBeTruthy();
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
    await expect(createHarnessGenerator(config, services.openai, 'gpt-test', [])(promptInput('hello', {signal: controller.signal}))).rejects.toThrow();
  });

  it('assembles Gemini streaming search_memory partialArgs safely and falls back to default read_context schema', async () => {
    const config = new Config();
    config.token[services.gemini] = 'gemini-secret';
    const tools: HarnessToolDefinition[] = [{name: 'search_memory', description: 'search', input: {type: 'object', properties: {query: {type: 'string'}}}}];
    setRuntimeFetch(async () => sse([
      {candidates: [{content: {parts: [{functionCall: {id: 'mem-1', name: 'search_memory', willContinue: true, partialArgs: [{jsonPath: '$.query', stringValue: 'hel', willContinue: true}]}}]}}]},
      {candidates: [{content: {parts: [{functionCall: {partialArgs: [{jsonPath: '$.query', stringValue: 'lo'}]}}]}, finishReason: 'STOP'}]},
    ]));
    const result = await createHarnessStreamExecutor(config, services.gemini, 'gemini-2.5-flash', tools, undefined, {allowedTools: ['search_memory']})(promptInput('Explain', {tools}));
    expect(result.toolCalls).toEqual([{id: 'mem-1', name: 'search_memory', input: {query: 'hello'}}]);

    setRuntimeFetch(async () => sse([
      {candidates: [{content: {parts: [{functionCall: {id: 'bad', name: 'read_context', partialArgs: [null]}}]}, finishReason: 'STOP'}]},
    ]));
    await expect(createHarnessStreamExecutor(config, services.gemini, 'gemini-2.5-flash', [{name: 'read_context', description: 'read', input: {type: 'object'}}])(promptInput('Explain'))).rejects.toThrow('read_context 工具参数无效');
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

  it('freezes reactive settings during failover', async () => {
    const config = reactive(new Config());
    config.apiKeys[services.gemini] = ['native-A', 'native-B'];
    config.token[services.gemini] = 'native-A';
    config.proxy[services.gemini] = 'https://native.fixture/generate';
    const generate = createHarnessGenerator(config, services.gemini, 'gemini-fixture', []);
    config.proxy[services.gemini] = 'https://changed.fixture/generate';
    config.apiKeys[services.gemini] = ['changed-key'];
    const seen: string[] = [];
    setRuntimeFetch(async (input, init) => {
      expect(String(input)).toBe('https://native.fixture/generate');
      const key = new Headers(init?.headers).get('x-goog-api-key')!;
      seen.push(key);
      if (key === 'native-A') return new Response(JSON.stringify({error: {message: 'API key not valid'}}), {status: 401});
      return geminiSse('native answer');
    });
    expect((await generate(promptInput('hello'))).text).toBe('native answer');
    expect(seen).toEqual(['native-A', 'native-B']);
  });

  it('tries A then B on auth failure and uses B/C on later requests', async () => {
    const config = multiKeyConfig('custom:rotation-generate');
    const seen: string[] = [];
    setRuntimeFetch(vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/u, '') || '';
      seen.push(key);
      if (key === 'fixture-A') return new Response(JSON.stringify({error: {message: 'invalid key'}}), {status: 401});
      return openaiSse(key);
    }));
    const generate = createHarnessGenerator(config, 'custom:rotation-generate', 'fixture', []);
    expect((await generate(promptInput('one'))).text).toBe('fixture-B');
    expect((await generate(promptInput('two'))).text).toMatch(/^fixture-[BC]$/u);
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
      return openaiSse(key);
    }));
    expect((await createHarnessGenerator(config, 'custom:rotation-stream', 'fixture', [])(promptInput('stream'))).text).toBe('fixture-B');
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
    const onText = vi.fn();
    const pending = createHarnessGenerator(partialConfig, 'custom:rotation-partial', 'fixture', [])(promptInput('partial', {onText}));
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('once'));
    transport!.error(new Error('partial stream failure'));
    await expect(pending).rejects.toThrow('partial stream failure');
    expect(calls).toBe(1);
  });
});

it('网关拒绝非法头并遮罩错误回显，头配置快照不随后续编辑改变', async () => {
  const config = new Config();
  config.customOpenAIProviders = [{id: 'custom:headers', name: 'Headers', endpoint: 'https://fixture.example/v1/chat/completions', models: ['model']}];
  config.customHeaders['custom:headers'] = '{"x":1}';
  await expect(createHarnessGenerator(config, 'custom:headers', 'model', [])(promptInput('fixture'))).rejects.toThrow('自定义请求头');
  expect(normalizeHarnessModelError(new Error('failure'), 'custom:headers', '', '{oops').message).toContain('failure');
  config.customHeaders['custom:headers'] = '{"x-auth":"private-header"}';
  expect(normalizeHarnessModelError(new Error('private-header rejected'), 'custom:headers', '', config.customHeaders['custom:headers']).message).not.toContain('private-header');
  const generate = createHarnessGenerator(config, 'custom:headers', 'model', []);
  config.customHeaders['custom:headers'] = '{"x-auth":"changed"}';
  setRuntimeFetch(async (_input, init) => {
    expect(new Headers(init?.headers).get('x-auth')).toBe('private-header');
    return openaiSse('done');
  });
  try { await generate(promptInput('fixture')); } finally { setRuntimeFetch(); }
});
