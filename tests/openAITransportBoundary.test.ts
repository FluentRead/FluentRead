import {Worker} from 'node:worker_threads';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {providerConfigFixture, withProviderSnapshot} from './helpers/providerSnapshot';
import {translateOpenAICompatible, type AiSdkTranslationRequest, type OpenAICompatibleCall, type OpenAICompatibleExecution} from '@/src/providers/translation/ai-sdk/openai-transport';
import {LlmTransportError, normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {LlmTransportError as SharedError} from '@/src/providers/translation/ai-sdk/transport-errors';
import {translateWithOpenAICompatibleAiSdk as direct} from '@/userscript/openaiCompatible';
import {translateWithOpenAICompatibleAiSdk as sdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import * as endpoints from '@/src/providers/translation/ai-sdk/endpoints';
import * as templates from '@/src/services/translation/templates';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {attachTranslationImageInput, attachTranslationModelUsageObserver, attachTranslationRequestScheduler, attachTranslationProviderConfig, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {boundErrorResponse} from '@/src/providers/translation/ai-sdk/boundedErrorResponse';
import {userscriptFetch} from '@/userscript/http';
import type {TranslationConfigSource} from '@/src/services/translation/types';

const config = () => providerConfigFixture({service: 'custom', model: {custom: 'fixture-model'}, token: {},
  custom: 'https://fixture.invalid/v1', translationMaxRetries: 0});
const request = (overrides: Partial<AiSdkTranslationRequest> = {}, settings: Partial<TranslationConfigSource> = {}) =>
  withProviderSnapshot({origin: 'Fixture source', ...overrides}, {...config(), ...settings});
const execution = (run: OpenAICompatibleExecution['run']): OpenAICompatibleExecution => ({run, normalizeError: normalizeAiSdkError});
const textResponse = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({choices: [{message: {content: '译文'}}], ...extra}));
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};

afterEach(() => {setRuntimeFetch(); vi.restoreAllMocks(); vi.useRealTimers();});

describe('shared OpenAI request and response boundary', () => {
  it('passes its local error-body policy through the real GM adapter without sending it as a header', async () => {
    const huge = 'x'.repeat(1024 * 1024); let details!: UserscriptXmlHttpRequestDetails;
    globalThis.GM_xmlhttpRequest = value => {
      details = value;
      queueMicrotask(() => value.onload?.({status: 429, responseText: huge, responseHeaders: 'retry-after: 3\r\nx-request-id: gm-fixture'}));
      return {abort() {}};
    };
    setRuntimeFetch(userscriptFetch);
    try {
      await translateOpenAICompatible(request(), execution(async call => {
        const response = await call.fetch('https://fixture.invalid/v1/chat/completions', {method: 'POST', body: '{}'});
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('3');
        expect(response.headers.get('x-request-id')).toBe('gm-fixture');
        expect(await response.text()).toContain('上游错误响应过大');
        return 'checked';
      }));
      expect(Object.keys(details.headers ?? {}).some(name => name.toLowerCase().includes('errorbody'))).toBe(false);
    } finally {globalThis.GM_xmlhttpRequest = undefined;}
  });
  it('re-exports one error class instead of producing incompatible SDK and standalone identities', () => {
    expect(SharedError).toBe(LlmTransportError);
  });

  it.each(['{', 'null', '3', '[]', '{"model":4,"messages":[]}', '{"model":" ","messages":[]}', '{"model":"valid","messages":{}}'])
  ('rejects a malformed payload at the preparation boundary before dispatch: %s', async body => {
    vi.spyOn(templates, 'commonMsgTemplate').mockReturnValueOnce(body);
    const run = vi.fn();
    await expect(translateOpenAICompatible(request(), execution(run))).rejects.toMatchObject({kind: 'bad-request', retryable: false});
    expect(run).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error endpoint rejection and rejects malformed custom headers without a request', async () => {
    vi.spyOn(endpoints, 'resolveOpenAICompatibleEndpoint').mockImplementationOnce(() => {throw 'invalid endpoint';});
    const run = vi.fn();
    await expect(translateOpenAICompatible(request(), execution(run))).rejects.toMatchObject({message: 'invalid endpoint', kind: 'bad-request'});
    vi.mocked(endpoints.resolveOpenAICompatibleEndpoint).mockReturnValueOnce({endpoint: 'https://fixture.invalid/v1/chat/completions', baseURL: 'https://fixture.invalid/v1'});
    await expect(translateOpenAICompatible(request({serviceOverride: 'custom:fixture'},
      {customHeaders: {'custom:fixture': '{"invalid header":"value"}'}}), execution(run))).rejects.toMatchObject({kind: 'bad-request'});
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps OpenRouter attribution headers in the shared prepared request', async () => {
    const run = vi.fn(async (_call: OpenAICompatibleCall) => '译文');
    await translateOpenAICompatible(request({serviceOverride: 'openrouter'}, {model: {openrouter: 'fixture/model'}}), execution(run));
    expect(run.mock.calls[0][0].headers).toEqual({'HTTP-Referer': 'https://fluent.thinkstu.com', 'X-Title': 'FluentRead'});
  });

  it.each([
    {prompt_tokens_details: 'invalid', completion_tokens_details: 'invalid'},
    {prompt_tokens_details: [], completion_tokens_details: []},
    {prompt_tokens_details: {}, completion_tokens_details: {}},
    {prompt_tokens_details: {cached_tokens: 2.8, cache_write_tokens: 3.9}, completion_tokens_details: {reasoning_tokens: 4.7}},
    {prompt_tokens_details: {cached_tokens: -2, cache_write_tokens: '3'}, completion_tokens_details: {reasoning_tokens: -1}},
  ])('normalizes optional usage details while retaining the original usage observation: %j', async usage => {
    const original = textResponse({usage, model: 'actual-model'});
    setRuntimeFetch(async () => original);
    const observe = vi.fn();
    const source = attachTranslationModelUsageObserver(request(), observe);
    let normalized: any;
    await translateOpenAICompatible(source, execution(async call => {
      const response = await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      normalized = await response.json(); return normalized.choices[0].message.content;
    }));
    expect(normalized.model).toBe('actual-model');
    expect(original.bodyUsed).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({outcome: 'success', actualModel: 'actual-model'});
    if (typeof usage.prompt_tokens_details === 'object' && !Array.isArray(usage.prompt_tokens_details)
      && 'cached_tokens' in usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === 'number'
      && usage.prompt_tokens_details.cached_tokens >= 0) {
      expect(normalized.usage).toEqual({prompt_tokens_details: {cached_tokens: 2, cache_write_tokens: 3}, completion_tokens_details: {reasoning_tokens: 4}});
    } else expect(normalized.usage).toBeUndefined();
  });

  it.each(['{broken', 'null', '{"choices":[]}', '{"choices":[{"message":{"content":null}}]}'])
  ('keeps malformed or non-text HTTP responses as errors rather than rebuilding success: %s', async body => {
    setRuntimeFetch(async () => new Response(body));
    await expect(direct(request())).rejects.toBeInstanceOf(LlmTransportError);
  });

  it('uses an attached scheduler without inventing a lease or a signal when the executor omits init', async () => {
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const schedule = vi.spyOn(scheduler, 'scheduleAttempt');
    const observe = vi.spyOn(scheduler, 'observeResponse');
    setRuntimeFetch(async () => textResponse());
    const source = attachTranslationRequestScheduler(request(), scheduler);
    await translateOpenAICompatible(source, execution(async call => {
      const response = await call.fetch('https://fixture.invalid/v1/chat/completions');
      return (await response.json()).choices[0].message.content;
    }));
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({signal: undefined, countConcurrency: false}));
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('retains explicit attempt settlement on the caller lease and defaults older snapshots to two retries', async () => {
    const scheduler = createTranslationRequestScheduler(() => ({}));
    const lease = {holdUntil: vi.fn()};
    const snapshot = requireTranslationProviderConfig(request());
    const source = attachTranslationRequestScheduler(attachTranslationProviderConfig({origin: 'Source'},
      {...snapshot, translationMaxRetries: undefined}), scheduler, undefined, lease);
    setRuntimeFetch(async () => textResponse());
    await translateOpenAICompatible(source, execution(async call => {
      expect(call.maxRetries).toBe(2);
      await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      return '译文';
    }));
    expect(lease.holdUntil).toHaveBeenCalledTimes(1);
    await expect(lease.holdUntil.mock.calls[0][0]).resolves.toMatchObject({response: expect.any(Response)});
  });

  it.each([
    ['image_url is not supported by this model', true],
    ['invalid model request', false],
  ] as const)('keeps explicit image rejection ownership: %s', async (message, unsupported) => {
    setRuntimeFetch(async () => new Response(JSON.stringify({error: {message}}), {status: 400}));
    const source = attachTranslationImageInput(request(), 'data:image/png;base64,AAAA');
    const error = await direct(source).catch(error => error);
    expect(Boolean(error.imageInputUnsupported)).toBe(unsupported);
    expect(error instanceof LlmTransportError).toBe(!unsupported);
  });

  it.each([false, true])('preserves complete failed response bytes and HTTP metadata with scheduler=%s', async useScheduler => {
    const bytes = Uint8Array.from([0, 255, 123, 34, 101, 114, 114, 111, 114, 34, 58, 49, 125]);
    const headers = {'content-type': 'application/octet-stream', 'retry-after': '7', 'x-request-id': 'fixture-id'};
    setRuntimeFetch(async () => new Response(bytes, {status: 429, statusText: 'Too Many Requests', headers}));
    const source = useScheduler ? attachTranslationRequestScheduler(request(), createTranslationRequestScheduler(() => ({}))) : request();
    await translateOpenAICompatible(source, execution(async call => {
      const response = await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      expect(response.status).toBe(429); expect(response.statusText).toBe('Too Many Requests');
      expect(Object.fromEntries(response.headers)).toMatchObject(headers);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      return 'ok';
    }));
  });

  it('returns a bounded error without releasing either lease while a noncooperative stream continues', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let networkSignal: AbortSignal | null | undefined;
    setRuntimeFetch(async (_input, init) => {
      networkSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller; controller.enqueue(new Uint8Array(32_769));}}), {
        status: 400, headers: {'retry-after': '2', 'content-type': 'text/plain'},
      });
    });
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const lease = {holdUntil: vi.fn()};
    const source = attachTranslationRequestScheduler(request(), scheduler, {quotaScope: 'fixture'}, lease);
    let errorResponse!: Response;
    const first = translateOpenAICompatible(source, execution(async call => {
      errorResponse = await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      return await errorResponse.text();
    }));
    expect(await first).toContain('上游错误响应过大');
    expect(networkSignal?.aborted).toBe(true);
    expect(errorResponse.status).toBe(400); expect(errorResponse.headers.get('retry-after')).toBe('2');
    expect(lease.holdUntil).toHaveBeenCalledOnce();
    let outerSettled = false; void Promise.resolve(lease.holdUntil.mock.calls[0][0]).then(() => {outerSettled = true;});
    let nextStarted = false;
    const next = scheduler.scheduleAttempt(async () => {nextStarted = true; return 'next';}, {countConcurrency: true});
    await flush(); expect(nextStarted).toBe(false); expect(outerSettled).toBe(false);
    stream.enqueue(new Uint8Array(5)); stream.close();
    expect(await next).toBe('next'); await flush(); expect(outerSettled).toBe(true);
  });

  it('returns a bounded error after the body deadline while retaining an unfinished attempt', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let networkSignal: AbortSignal | null | undefined;
    setRuntimeFetch(async (_input, init) => {
      networkSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {status: 503});
    });
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const source = attachTranslationRequestScheduler(request(), scheduler, {quotaScope: 'fixture'});
    const result = translateOpenAICompatible(source, execution(async call => (await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal})).text()));
    await flush(); await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toContain('读取超时'); expect(networkSignal?.aborted).toBe(true);
    let nextStarted = false;
    const next = scheduler.scheduleAttempt(async () => {nextStarted = true; return 'next';}, {countConcurrency: true});
    await flush(); expect(nextStarted).toBe(false);
    stream.close(); expect(await next).toBe('next');
  });

  it('keeps a caller-aborted noncooperative body in the attempt slot until it actually ends', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {status: 400}));
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const abort = new AbortController();
    const source = attachTranslationRequestScheduler(request({abortSignal: abort.signal}), scheduler, {quotaScope: 'fixture'});
    const result = translateOpenAICompatible(source, execution(async call => (await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal})).text())).catch(error => error);
    await flush(); abort.abort();
    expect(await result).toMatchObject({kind: 'timeout', retryable: false});
    let nextStarted = false;
    const next = scheduler.scheduleAttempt(async () => {nextStarted = true; return 'next';}, {countConcurrency: true});
    await flush(); expect(nextStarted).toBe(false);
    stream.close(); expect(await next).toBe('next');
  });

  it('keeps the attempt slot when a cancelled transport returns late and its body has not finished', async () => {
    let releaseHeaders!: (response: Response) => void;
    setRuntimeFetch(() => new Promise<Response>(resolve => {releaseHeaders = resolve;}));
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const abort = new AbortController();
    const source = attachTranslationRequestScheduler(request({abortSignal: abort.signal}), scheduler, {quotaScope: 'fixture'});
    const result = translateOpenAICompatible(source, execution(async call => (await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal})).text())).catch(error => error);
    await flush(); abort.abort(); expect(await result).toMatchObject({kind: 'timeout', retryable: false});
    let nextStarted = false;
    const next = scheduler.scheduleAttempt(async () => {nextStarted = true; return 'next';}, {countConcurrency: true});
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    releaseHeaders(new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {status: 400}));
    await flush(); expect(nextStarted).toBe(false);
    stream.close(); expect(await next).toBe('next');
  });

  it('preserves HTTP status while discarding a partial body after the source stream errors', async () => {
    let networkSignal: AbortSignal | null | undefined;
    setRuntimeFetch(async (_input, init) => {
      networkSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(new TextEncoder().encode('private-partial-response'));
        controller.error(new Error('upstream disconnected'));
      }}), {status: 422, headers: {'x-request-id': 'source-error'}});
    });
    const error = await sdk(request()).catch(error => error);
    expect(error).toMatchObject({kind: 'bad-request', statusCode: 422, requestId: 'source-error'});
    expect(error.message).not.toContain('private-partial-response');
    expect(networkSignal?.aborted).toBe(true);
  });

  it('accepts the exact byte limit as a complete body', async () => {
    const bytes = new Uint8Array(32_768).fill(65);
    setRuntimeFetch(async () => new Response(bytes, {status: 400}));
    await translateOpenAICompatible(request(), execution(async call => {
      const response = await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      return 'ok';
    }));
  });

  it('passes through bodyless errors, unless the caller has already cancelled', async () => {
    const response = new Response(null, {status: 304, headers: {'x-request-id': 'bodyless'}});
    const untouched = boundErrorResponse(response, undefined, vi.fn());
    expect(await untouched.result).toBe(response); await untouched.drained;
    const controller = new AbortController(); controller.abort();
    const cancelled = boundErrorResponse(response, controller.signal, vi.fn());
    await expect(cancelled.result).rejects.toMatchObject({name: 'AbortError'}); await cancelled.drained;
    const opaque = Response.error();
    expect(await boundErrorResponse(opaque, undefined, vi.fn()).result).toBe(opaque);
  });

  it('finishes bounded timeout even when the native source errors as a consequence of abort', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {status: 503});
    const abortTransport = vi.fn(() => stream.error(new DOMException('transport aborted', 'AbortError')));
    const bounded = boundErrorResponse(response, undefined, abortTransport);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await bounded.result).status).toBe(503); await bounded.drained;
    expect(abortTransport).toHaveBeenCalledOnce();
  });

  it('continues draining a noncooperative producer without retaining its later chunks', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new Uint8Array(32_769));
      for (let i = 0; i < 130; i++) controller.enqueue(new Uint8Array(10));
      controller.close();
    }}), {status: 400});
    const abort = vi.fn(); const bounded = boundErrorResponse(response, undefined, abort);
    expect(await (await bounded.result).text()).toContain('上游错误响应过大');
    await bounded.drained; expect(abort).toHaveBeenCalledOnce();
  });

  it('keeps a valid response when a custom transport throws while releasing its reader', async () => {
    const reader = {read: vi.fn(async () => ({done: true as const})), releaseLock: vi.fn(() => {throw new Error('lock cleanup');})};
    const response = {status: 400, statusText: '', headers: new Headers(), body: {getReader: () => reader}} as unknown as Response;
    const bounded = boundErrorResponse(response, undefined, vi.fn());
    expect((await bounded.result).status).toBe(400); await expect(bounded.drained).resolves.toBeUndefined();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not infer unsupported image input from a truncated error body', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const prefix = new TextEncoder().encode('{"error":{"message":"image_url is not supported by this model"}}');
    const tooLarge = new Uint8Array(32_769); tooLarge.set(prefix);
    setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller; controller.enqueue(tooLarge);}}), {status: 400}));
    const source = attachTranslationImageInput(request(), 'data:image/png;base64,AAAA');
    const error = await direct(source).catch(error => error);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect(error.imageInputUnsupported).toBeUndefined(); expect(error.statusCode).toBe(400);
    stream.close();
  });

  it.each([['SDK', sdk], ['standalone', direct]] as const)(
    'caps a nonterminating oversized HTTP error before the actual %s executor consumes it', async (_name, translate) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      let networkSignal: AbortSignal | null | undefined;
      setRuntimeFetch(async (_input, init) => {
        networkSignal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({start(controller) {
          stream = controller; controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        }}), {status: 400, headers: {'retry-after': '2', 'x-request-id': 'bounded-id'}});
      });
      const error = await translate(request()).catch(error => error);
      expect(error).toMatchObject({kind: 'bad-request', statusCode: 400, requestId: 'bounded-id', retryAfterMs: 2_000});
      expect(error.message).toContain('上游错误响应过大');
      expect(networkSignal?.aborted).toBe(true);
      stream.close();
    },
  );

  it.each([['SDK', sdk], ['standalone', direct]] as const)(
    'bounds a stalled HTTP error without a scheduler for the actual %s executor', async (_name, translate) => {
      vi.useFakeTimers();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {stream = controller;}}), {status: 400}));
      const result = translate(request()).catch(error => error);
      await flush(); await vi.advanceTimersByTimeAsync(1_000);
      const error = await result;
      expect(error).toMatchObject({kind: 'bad-request', statusCode: 400});
      expect(error.message).toContain('读取超时');
      stream.close();
    },
  );

  it('keeps a real SDK retry behind the noncooperative previous HTTP attempt', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({start(controller) {
      stream = controller; controller.enqueue(new Uint8Array(32_769));
    }}), {status: 429, headers: {'retry-after-ms': '1'}})).mockImplementationOnce(async () => textResponse());
    setRuntimeFetch(fetcher);
    const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
    const source = attachTranslationRequestScheduler(request({}, {translationMaxRetries: 1}), scheduler, {quotaScope: 'fixture'});
    const result = sdk(source);
    await flush(); await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    stream.close(); await flush(); await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe('译文'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves caller cancellation before execution and cleans its deadline timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(); controller.abort();
    const run = vi.fn(async (call: OpenAICompatibleCall) => {expect(call.signal.aborted).toBe(true); throw new DOMException('aborted', 'AbortError');});
    await expect(translateOpenAICompatible(request({abortSignal: controller.signal}), execution(run))).rejects.toMatchObject({kind: 'timeout', retryable: false});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards a Request input signal when the executor supplies no init object', async () => {
    const abort = new AbortController(); abort.abort();
    let receivedSignal: AbortSignal | null | undefined;
    setRuntimeFetch(async (_input, init) => {receivedSignal = init?.signal; return new Response(null, {status: 400});});
    const result = translateOpenAICompatible(request(), execution(async call => {
      const input = new Request('https://fixture.invalid/v1/chat/completions', {signal: abort.signal});
      await call.fetch(input);
      return 'unreachable';
    }));
    await expect(result).rejects.toMatchObject({kind: 'timeout'});
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('preserves already-aborted call signals even when a transport returns a late error response', async () => {
    const abort = new AbortController(); abort.abort();
    let receivedSignal: AbortSignal | null | undefined;
    setRuntimeFetch(async (_input, init) => {receivedSignal = init?.signal; return new Response('late', {status: 400});});
    const result = translateOpenAICompatible(request({abortSignal: abort.signal}), execution(async call => {
      await call.fetch('https://fixture.invalid/v1/chat/completions', {signal: call.signal});
      return 'unreachable';
    }));
    await expect(result).rejects.toMatchObject({kind: 'timeout', retryable: false});
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('bounds an HTTP error even when the executor omits a signal', async () => {
    setRuntimeFetch(async () => new Response('error detail', {status: 400}));
    await translateOpenAICompatible(request(), execution(async call => {
      const response = await call.fetch('https://fixture.invalid/v1/chat/completions');
      expect(response.status).toBe(400); expect(await response.text()).toBe('error detail');
      return 'ok';
    }));
  });

  it.each(['', '<think>Only reasoning</think>'])('rejects empty visible text and preserves its transport identity: %s', async text => {
    await expect(translateOpenAICompatible(request(), execution(async () => text))).rejects.toMatchObject({kind: 'response', retryable: false});
  });

  it('preserves an already classified error from the executor without rewrapping it', async () => {
    const error = new LlmTransportError('classified', {kind: 'bad-request', retryable: false});
    await expect(translateOpenAICompatible(request(), execution(async () => {throw error;}))).rejects.toBe(error);
  });

  it('does not start a second batch item when the shared absolute budget expired between items', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const run = vi.fn(async () => {vi.setSystemTime(1020); return 'first';});
    await expect(translateOpenAICompatible(request({origin: ['one', 'two'], requestTimeoutMs: 10}), execution(run))).rejects.toMatchObject({kind: 'timeout', retryable: true});
    expect(run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});

// A broken implementation can starve its own Vitest timeout. A separate worker
// and parent-side watchdog make the reproducer safe even before the fix.
const viteRequire = createRequire(createRequire(import.meta.url).resolve('vite'));
const bundle = (viteRequire('esbuild') as {buildSync: (options: Record<string, unknown>) => {outputFiles: Array<{text: string}>}}).buildSync({
  entryPoints: [resolve(process.cwd(), 'src/providers/translation/ai-sdk/boundedErrorResponse.ts')],
  alias: {'@': resolve(process.cwd())}, bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;

const workerCode = `
  const {parentPort, workerData} = require('node:worker_threads');
  const loaded = {exports: {}};
  new Function('module', 'exports', 'require', workerData.bundle)(loaded, loaded.exports, require);
  const abort = new AbortController();
  let source;
  const body = new ReadableStream({
    start(controller) { source = controller; },
    pull(controller) { controller.enqueue(new Uint8Array(workerData.size)); },
  });
  const {result, drained} = loaded.exports.boundErrorResponse(
    new Response(body, {status: 400}), abort.signal, () => source.error(new Error('transport stopped')),
  );
  if (workerData.mode === 'abort') setTimeout(() => abort.abort(), 25);
  (async () => {
    try { const response = await result; await drained; parentPort.postMessage({status: response.status, body: await response.text()}); }
    catch (error) { await drained; parentPort.postMessage({name: error.name}); }
  })().catch(error => parentPort.postMessage({failure: String(error)}));
`;

it.each([
  {size: 0, mode: 'deadline'},
  {size: 1, mode: 'abort'},
] as const)('lets $mode run despite a continuous stream of $size-byte chunks', async ({size, mode}) => {
  const worker = new Worker(workerCode, {eval: true, workerData: {bundle, size, mode}});
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await new Promise<{status?: number; body?: string; name?: string; failure?: string}>((resolveMessage, reject) => {
      watchdog = setTimeout(() => reject(new Error('worker did not yield to the deadline or abort event')), 4_000);
      worker.once('message', resolveMessage);
      worker.once('error', reject);
    });
    expect(message.failure).toBeUndefined();
    if (mode === 'deadline') {expect(message.status).toBe(400); expect(message.body).toContain('读取超时');}
    else expect(message.name).toBe('AbortError');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await worker.terminate();
  }
}, 7_000);

it('releases a large discarded chunk before an uncooperative stream reaches EOF', async () => {
  // Force collection in an isolated Node process; no GC flag or global state is
  // changed in Vitest, and a watchdog bounds a noncooperative source.
  const script = `
    const loaded = {exports: {}};
    new Function('module', 'exports', 'require', process.env.FLUENTREAD_GC_BUNDLE)(loaded, loaded.exports, require);
    (async () => {
      let source, chunk = new Uint8Array(64 * 1024 * 1024);
      const weak = new WeakRef(chunk.buffer);
      const body = new ReadableStream({start(controller) { source = controller; controller.enqueue(chunk); }});
      chunk = null;
      const bounded = loaded.exports.boundErrorResponse(new Response(body, {status: 400}), undefined, () => {});
      await bounded.result;
      let released = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
        await new Promise(resolve => setTimeout(resolve, 20));
        if (!weak.deref()) {released = true; break;}
      }
      source.close(); await bounded.drained;
      if (!released) throw new Error('discarded chunk remained reachable while waiting for EOF');
      console.log('released-before-eof');
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `;
  const {stdout} = await promisify(execFile)(process.execPath, ['--expose-gc', '-e', script], {
    env: {...process.env, FLUENTREAD_GC_BUNDLE: bundle}, timeout: 10_000,
  });
  expect(stdout.trim()).toBe('released-before-eof');
}, 15_000);
