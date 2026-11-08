/**
 * @file tests/openAIHttpContract.test.ts
 * 文件职责：以真实锁定 AI SDK 对照 standalone HTTP 执行端口的产品可见合同。
 * 主要内容：比较真实内存 fetch 请求、文本与归一错误、重试时序、响应校验、读取清理和取消；单独固定不执行宿主 telemetry 的授权差异。
 * 模块边界：不 mock SDK、不读取研究目录、不联网；不替代共享 transport 的预算、租约、用量与真实浏览器验收。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {openAICompatibleSdkExecution as sdkExecution} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {standaloneOpenAIExecution} from '@/src/providers/translation/ai-sdk/openai-http';
import type {OpenAICompatibleCall, OpenAICompatibleExecution} from '@/src/providers/translation/ai-sdk/openai-transport';

const EPOCH = Date.UTC(2026, 9, 15);
const SECRET = 'contract-fixture-secret';
type BodyLifecycle = {reads: number; cancel: number; releaseLock: number; streamCancel: number};
type Reply = {
  body?: unknown;
  raw?: string;
  status?: number;
  headers?: Record<string, string>;
  throw?: () => unknown;
  readError?: boolean;
  readFailure?: () => unknown;
  trackBody?: boolean;
  noBody?: boolean;
  cancelFailure?: boolean;
  virtualOversizeChunk?: boolean;
  respectPreAbort?: boolean;
  holdUntilAbort?: boolean;
  lateResolve?: boolean;
};
type Scenario = {
  replies: readonly Reply[];
  maxRetries?: number;
  abort?: 'before' | 'fetch' | 'backoff' | 'late';
  call?: Partial<Pick<OpenAICompatibleCall, 'requestBody' | 'apiKey' | 'headers' | 'endpoint'>>;
};

function success(message: Record<string, unknown> = {content: '译文'}, extra: Record<string, unknown> = {}) {
  return {model: 'response-model', choices: [{message: {role: 'assistant', ...message}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}, ...extra};
}
function failure(status: number, headers: Record<string, string> = {}): Reply {
  return {status, headers, body: {error: {message: `fixture HTTP ${status}`, code: `fixture-${status}`}}};
}

async function observe(execution: OpenAICompatibleExecution, scenario: Scenario) {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const controller = new AbortController();
  const requests: Array<{at: number; url: string; method?: string; headers: Record<string, string>; body: unknown; aborted: boolean}> = [];
  const bodies: BodyLifecycle[] = [];
  let fetchSettledAt: number | undefined;
  const abort = () => controller.abort(new DOMException('fixture caller abort', 'AbortError'));
  const call: OpenAICompatibleCall = {
    endpoint: {endpoint: 'https://fixture.invalid/v1/chat/completions', baseURL: 'https://fixture.invalid/v1/', queryParams: {'api-version': 'fixture version'}},
    apiKey: SECRET, headers: {'X-Fixture': 'header-value'},
    requestBody: {model: 'fixture-model', messages: [{role: 'user', content: 'Fixture source'}], stream: false},
    signal: controller.signal, maxRetries: scenario.maxRetries ?? 2,
    ...scenario.call,
    fetch: async (input, init) => {
      const reply = scenario.replies[Math.min(requests.length, scenario.replies.length - 1)];
      const signal = init?.signal!;
      requests.push({at: Date.now() - EPOCH, url: String(input), method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body, aborted: signal.aborted});
      if (reply.respectPreAbort && signal.aborted) throw signal.reason;
      if (scenario.abort && scenario.abort !== 'before') setTimeout(abort, 17);
      if (reply.holdUntilAbort) return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {fetchSettledAt = Date.now() - EPOCH; reject(signal.reason);};
        if (signal.aborted) rejectAbort(); else signal.addEventListener('abort', rejectAbort, {once: true});
      });
      if (reply.throw) throw reply.throw();
      if (reply.lateResolve) await new Promise(resolve => setTimeout(resolve, 100));
      const body = reply.raw ?? JSON.stringify(reply.body);
      const response = new Response(reply.readError || reply.readFailure
        ? new ReadableStream({start(stream) {stream.error(reply.readFailure?.() ?? new Error('fixture body read failure'));}}) : reply.noBody ? null : body,
      {status: reply.status ?? 200, statusText: 'Fixture Status Text', headers: {'content-type': 'application/json', 'x-request-id': 'fixture-request', ...reply.headers}});
      if (reply.trackBody) {
        const stream = response.body!;
        const trace: BodyLifecycle = {reads: 0, cancel: 0, releaseLock: 0, streamCancel: 0}; bodies.push(trace);
        Object.defineProperty(response, 'body', {get: () => ({
          async cancel(...args: Parameters<ReadableStream['cancel']>) {
            trace.streamCancel++;
            await stream.cancel(...args);
            if (reply.cancelFailure) throw new Error('fixture cancel failure');
          },
          getReader() {
            const reader = stream.getReader();
            return {
              read() {
                trace.reads++;
                if (reply.virtualOversizeChunk) {
                  // 注入读取端口声明的大 chunk，双方都应在复制/分配前拒绝；不分配 2 GiB。
                  const chunk = new Uint8Array(0);
                  Object.defineProperty(chunk, 'length', {value: 2 ** 31 + 1});
                  return Promise.resolve({done: false as const, value: chunk});
                }
                return reader.read();
              },
              cancel(reason?: unknown) {trace.cancel++; return reader.cancel(reason);},
              releaseLock() {trace.releaseLock++; return reader.releaseLock();},
            };
          },
        })});
      }
      fetchSettledAt = Date.now() - EPOCH;
      return response;
    },
  };
  if (scenario.abort === 'before') abort();
  const outcome = execution.run(call).then(
    text => ({ok: true as const, text}),
    error => {
      const normalized = execution.normalizeError('custom', error, [SECRET], controller.signal.aborted);
      return {ok: false as const, error: {name: normalized.name, message: normalized.message, kind: normalized.kind,
        retryable: normalized.retryable, statusCode: normalized.statusCode, code: normalized.code,
        requestId: normalized.requestId, retryAfterMs: normalized.retryAfterMs}};
    },
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  const observed = {outcome: result, requests, delays: timer.mock.calls.map(args => Number(args[1] ?? 0)), bodies, fetchSettledAt};
  expect(vi.getTimerCount()).toBe(0);
  timer.mockRestore();
  vi.useRealTimers();
  return observed;
}

async function compare(scenario: Scenario) {
  const sdk = await observe(sdkExecution, scenario);
  const standalone = await observe(standaloneOpenAIExecution, scenario);
  expect(standalone).toEqual(sdk);
  return standalone;
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {userAgent: 'FluentRead Fixture Browser'});
  vi.stubGlobal('fetch', vi.fn(() => {throw new Error('External network is forbidden in contract tests');}));
  vi.stubGlobal('AI_SDK_TELEMETRY_INTEGRATIONS', undefined);
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('standalone OpenAI HTTP contract against the real SDK', () => {
  it('preserves the browser headers, exact custom body, model and query encoding', async () => {
    const requestBody = {model: 'custom/model', messages: [{role: 'developer', content: 'Fixture instructions'},
      {role: 'user', content: [{type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}}, {type: 'text', text: 'Fixture text'}]}],
    response_format: {type: 'json_object'}, custom_field: [0, false, ''], stream: false};
    const result = await compare({replies: [{body: success()}], call: {requestBody}});
    expect(result.requests[0].body).toBe(JSON.stringify(requestBody));
    expect(result.requests[0].headers['user-agent']).toBe('ai/7.0.165 ai-sdk-provider-utils/5.0.76 fluentread fixture browser');
    expect(result.requests[0].url).toBe('https://fixture.invalid/v1/chat/completions?api-version=fixture+version');
  });

  it('preserves Azure-style headers without inventing Bearer authorization', async () => {
    const result = await compare({replies: [{body: success()}], call: {apiKey: undefined, headers: {'api-key': SECRET, 'X-Title': 'FluentRead'}}});
    expect(result.requests[0].headers.authorization).toBeUndefined();
    expect(result.requests[0].headers['api-key']).toBe(SECRET);
  });

  it('preserves an unauthenticated local-style endpoint without query or optional headers', async () => {
    const result = await compare({replies: [{body: success()}], call: {apiKey: undefined, headers: undefined,
      endpoint: {endpoint: 'https://fixture.invalid/v1/chat/completions', baseURL: 'https://fixture.invalid/v1'}}});
    expect(result.requests[0].url).toBe('https://fixture.invalid/v1/chat/completions');
    expect(result.requests[0].headers.authorization).toBeUndefined();
  });

  it.each([0, 1, 2])('matches retry count %i for permanent and transient statuses', async maxRetries => {
    for (const status of [401, 403, 408, 409, 429, 500]) {
      const result = await compare({maxRetries, replies: [failure(status)]});
      const retryable = [408, 409, 429, 500].includes(status);
      expect(result.requests).toHaveLength(retryable ? maxRetries + 1 : 1);
      expect(result.delays).toEqual(retryable ? [2000, 4000].slice(0, maxRetries) : []);
    }
  });

  it.each([1, 2])('keeps the last permanent failure after an earlier retry with maxRetries=%i', async maxRetries => {
    const result = await compare({maxRetries, replies: [failure(500), failure(401)]});
    expect(result.requests).toHaveLength(2);
    expect(result.outcome).toMatchObject({ok: false, error: {kind: 'authentication', statusCode: 401, retryable: false}});
  });

  it.each([
    ['seconds', {'retry-after': '3'}, 3000],
    ['fractional seconds', {'retry-after': '0.25'}, 250],
    ['milliseconds priority', {'retry-after-ms': '150', 'retry-after': '3'}, 150],
    ['zero milliseconds', {'retry-after-ms': '0'}, 0],
    ['date', {'retry-after': new Date(EPOCH + 3000).toUTCString()}, 3000],
    ['past date', {'retry-after': new Date(EPOCH - 3000).toUTCString()}, 2000],
    ['59999 milliseconds', {'retry-after-ms': '59999'}, 59999],
    ['60000 milliseconds', {'retry-after-ms': '60000'}, 2000],
    ['invalid ms falls through', {'retry-after-ms': 'junk', 'retry-after': '7'}, 7000],
    ['negative ms blocks seconds', {'retry-after-ms': '-1', 'retry-after': '7'}, 2000],
    ['invalid header', {'retry-after': 'junk'}, 2000],
  ] as const)('preserves Retry-After parsing: %s', async (_name, headers, delay) => {
    const result = await compare({maxRetries: 1, replies: [failure(429, headers), {body: success()}]});
    expect(result.delays).toEqual([delay]);
    expect(result.outcome).toEqual({ok: true, text: '译文'});
  });

  it.each([
    ['browser network error', () => new TypeError('Failed to fetch'), 1],
    ['network error with cause', () => new TypeError('Failed to fetch', {cause: new Error('fixture connection cause')}), 3],
    ['Bun-style network error', () => Object.assign(new Error('fixture connection closed'), {code: 'ECONNRESET'}), 3],
  ] as const)('preserves SDK network retry classification: %s', async (_name, createError, attempts) => {
    const result = await compare({replies: [{throw: createError}]});
    expect(result.requests).toHaveLength(attempts);
  });

  it.each(['fixture primitive rejection', null, {message: 'plain rejection'}])('does not invent retryability for a non-Error rejection %#', async rejection => {
    const result = await compare({replies: [{throw: () => rejection}]});
    expect(result.requests).toHaveLength(1);
    expect(result.outcome.ok).toBe(false);
  });

  it.each(['AbortError', 'TimeoutError', 'ResponseAborted'])('recognizes a non-Error DOMException named %s like the SDK', async name => {
    // Safari 的 DOMException 不保证继承 Error；不替换 SDK，只注入该宿主构造器。
    class HostDOMException {
      constructor(readonly message = '', readonly name = 'Error') {}
      toString() {return `${this.name}: ${this.message}`;}
    }
    vi.stubGlobal('DOMException', HostDOMException);
    const result = await compare({replies: [{throw: () => new HostDOMException('fixture abort boundary', name)}]});
    expect(result.requests).toHaveLength(1);
    expect(result.outcome.ok).toBe(false);
  });

  it.each([
    ['empty', {content: ''}], ['null', {content: null}], ['missing', {}],
    ['reasoning only', {reasoning_content: 'fixture reasoning'}],
    ['reasoning and text', {content: '译文', reasoning_content: 'first', reasoning: 'second'}],
    ['refusal only', {refusal: 'fixture refusal'}], ['refusal and text', {content: '译文', refusal: 'fixture refusal'}],
    ['tool only', {tool_calls: [{id: 'call-fixture', function: {name: 'fixture_tool', arguments: '{"a":1}'}}]}],
    ['tool and text', {content: '译文', tool_calls: [{id: 'call-fixture', function: {name: 'fixture_tool', arguments: '{"a":1}'}}]}],
  ] as const)('preserves port text for %s without promoting reasoning or refusal', async (_name, message) => {
    const result = await compare({replies: [{body: success(message)}]});
    expect(result.requests).toHaveLength(1);
    expect(result.outcome).toEqual({ok: true, text: 'content' in message ? message.content || '' : ''});
  });

  it('joins only text parts of structured content without returning reasoning or refusal', async () => {
    const content = [{type: 'text', text: '译'}, {type: 'thinking', thinking: [{type: 'text', text: 'hidden'}]},
      {type: 'text', text: 2}, {type: 'text', text: '文'}];
    const result = await compare({replies: [{body: success({content, refusal: 'not a translation'})}]});
    expect(result.outcome).toEqual({ok: true, text: '译文'});
  });

  it.each([
    ['invalid part type', success({content: [{type: 1, text: 'not text'}]})],
    ['number content', success({content: 123})], ['wrong role', success({role: 'user', content: '译文'})],
    ['number reasoning', success({reasoning: 123})], ['number id', success({content: null}, {id: 123})],
    ['string created', success({}, {created: 'now'})], ['invalid usage', success({}, {usage: {prompt_tokens: '4'}})],
    ['invalid usage details', success({}, {usage: {completion_tokens_details: {reasoning_tokens: '2'}}})],
    ['invalid tool name', success({tool_calls: [{function: {name: 3, arguments: '{}'}}]})],
    ['invalid thought signature', success({tool_calls: [{function: {name: 'x', arguments: '{}'}, extra_content: {google: {thought_signature: 3}}}]})],
    ['null message', {choices: [{message: null}]}], ['null choice', {choices: [null]}],
    ['missing choices', {model: 'missing'}], ['empty choices', {choices: []}],
    ['number finish reason', {choices: [{message: {content: '译文'}, finish_reason: 1}]}],
  ] as const)('matches normalized schema failure for %s', async (_name, body) => {
    const result = await compare({replies: [{body}]});
    expect(result.requests).toHaveLength(1);
    expect(result.outcome.ok).toBe(false);
  });

  it.each([
    '{broken-json',
    '{"choices":[{"message":{"content":null}}],"__proto__":{"polluted":true}}',
    '{"choices":[{"message":{"content":null}}],"constructor":{"prototype":{"polluted":true}}}',
  ])('matches invalid JSON or unsafe property rejection: %s', async raw => {
    const result = await compare({replies: [{raw}]});
    expect(result.outcome.ok).toBe(false);
    expect(result.requests).toHaveLength(1);
  });

  it.each(['deep', 'wide'])('accepts %s unknown metadata without a recursive traversal overflow', async shape => {
    const metadata = shape === 'deep'
      ? '{"child":'.repeat(12000) + 'null' + '}'.repeat(12000)
      : '[' + Array.from({length: 150000}, () => 'null').join(',') + ']';
    const raw = '{"choices":[{"message":{"content":"译文"}}],"unknownMetadata":' + metadata + '}';
    const result = await compare({replies: [{raw}]});
    expect(result.outcome).toEqual({ok: true, text: '译文'});
  });

  it.each([
    ['valid nested error', {error: {message: `invalid ${SECRET}`, code: 'fixture-code'}}],
    ['numeric code', {error: {message: 'numeric code', code: 123, param: {field: 1}}}],
    ['string envelope', {error: 'plain error'}], ['null message', {error: {message: null}}],
    ['extra fields', {message: 'outer fallback', code: 'outer-code', error: {message: 'nested message', extra: 'ignored'}}],
  ] as const)('preserves HTTP diagnostics when parsed SDK data and raw body differ: %s', async (_name, body) => {
    const result = await compare({replies: [{status: 400, body, headers: {'x-request-id': `request-${SECRET}`}}]});
    expect(JSON.stringify(result.outcome)).not.toContain(SECRET);
  });

  it.each([
    ['empty error', {status: 401, raw: ''}],
    ['HTML error', {status: 500, raw: '<html>fixture error</html>', headers: {'content-type': 'text/html'}}],
    ['successful reader failure', {readError: true, trackBody: true}],
    ['failed reader failure', {status: 500, readError: true, trackBody: true}],
    ['successful size preflight', {body: success(), trackBody: true, headers: {'content-length': '2147483649'}}],
    ['failed size preflight', {status: 500, body: {error: {message: 'fixture'}}, trackBody: true, headers: {'content-length': '2147483649'}}],
    ['missing success body', {noBody: true}],
    ['missing oversized body', {noBody: true, headers: {'content-length': '2147483649'}}],
    ['failed size-preflight cancellation', {body: success(), trackBody: true, cancelFailure: true, headers: {'content-length': '2147483649'}}],
    ['streamed size bound', {body: success(), trackBody: true, virtualOversizeChunk: true}],
    ['successful response abort', {readFailure: () => new DOMException('fixture response aborted', 'AbortError'), trackBody: true}],
    ['failed response abort', {status: 500, readFailure: () => new DOMException('fixture response aborted', 'AbortError'), trackBody: true}],
  ] satisfies Array<[string, Reply]>)('preserves error-body/read boundaries: %s', async (_name, reply) => {
    const result = await compare({maxRetries: 0, replies: [reply]});
    expect(result.outcome.ok).toBe(false);
  });

  it('cancels and releases a successful response reader after consuming it', async () => {
    const result = await compare({replies: [{body: success(), trackBody: true}]});
    expect(result.bodies).toEqual([{reads: 2, cancel: 1, releaseLock: 1, streamCancel: 0}]);
  });

  it.each([
    ['pre-aborted honoring fetch', {abort: 'before', replies: [{respectPreAbort: true, body: success()}]}],
    ['pre-aborted ignoring fetch', {abort: 'before', replies: [{body: success()}]}],
    ['pre-aborted retryable response', {abort: 'before', replies: [failure(500)]}],
    ['abort during fetch', {abort: 'fetch', replies: [{holdUntilAbort: true}]}],
    ['abort during backoff', {abort: 'backoff', replies: [failure(429, {'retry-after': '30'})]}],
    ['ignored abort with late transport', {abort: 'late', replies: [{lateResolve: true, body: success()}]}],
  ] satisfies Array<[string, Scenario]>)('preserves signal ownership: %s', async (_name, scenario) => {
    const result = await compare(scenario);
    expect(result.requests).toHaveLength(1);
  });

  it('intentionally does not read or run host telemetry while preserving the actual translation', async () => {
    const events: Array<{name: string; value: unknown}> = [];
    const getter = vi.fn(() => [{
      onStepStart(event: {messages?: unknown}) {events.push({name: 'start', value: event.messages});},
      onEnd(event: {text?: unknown; finalStep?: {request?: {body?: unknown}}}) {events.push({name: 'end', value: {text: event.text, body: event.finalStep?.request?.body}});},
    }]);
    Object.defineProperty(globalThis, 'AI_SDK_TELEMETRY_INTEGRATIONS', {configurable: true, get: getter});
    const sdk = await observe(sdkExecution, {replies: [{body: success()}]});
    expect(getter).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{name: 'start', value: [{role: 'user', content: 'FluentRead OpenAI-compatible request'}]},
      {name: 'end', value: {text: '译文', body: undefined}}]);
    getter.mockClear(); events.length = 0;
    const standalone = await observe(standaloneOpenAIExecution, {replies: [{body: success()}]});
    expect(standalone).toEqual(sdk);
    expect(getter).not.toHaveBeenCalled(); expect(events).toEqual([]);
  });

  it('intentionally isolates a throwing host telemetry getter from standalone execution', async () => {
    const getter = vi.fn(() => {throw new Error('fixture host hook failure');});
    Object.defineProperty(globalThis, 'AI_SDK_TELEMETRY_INTEGRATIONS', {configurable: true, get: getter});
    const sdk = await observe(sdkExecution, {replies: [{body: success()}]});
    expect(sdk.requests).toEqual([]); expect(sdk.outcome.ok).toBe(false);
    getter.mockClear();
    const standalone = await observe(standaloneOpenAIExecution, {replies: [{body: success()}]});
    expect(standalone.outcome).toEqual({ok: true, text: '译文'});
    expect(getter).not.toHaveBeenCalled();
  });
});
