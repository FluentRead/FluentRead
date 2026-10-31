/** 阅读专用轻量 transport 的真实 fetch/SSE/循环行为；与锁定 SDK 比较实际 wire。 */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createHarnessGenerator} from '@/userscript/readingGeneration';
import {createHarnessGenerator as nativeGenerator} from '@/src/services/harness/generation';
import {READ_CONTEXT_INPUT_SCHEMA, isReadContextInput} from '@/src/services/harness/readContext';
import {runHarnessLoop, type HarnessGenerateInput, type HarnessToolDefinition, type HarnessToolCall} from '@/src/core/harness/loop';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

const transport = vi.fn<typeof fetch>();
const tools: HarnessToolDefinition[] = [{name: 'read_context', description: '返回已授权段落', input: READ_CONTEXT_INPUT_SCHEMA}];
const config = (service = 'openai') => {const value = new Config();value.on = true;value.harness.enabled = true;value.token[service] = 'controlled-key';return value;};
const input = (): HarnessGenerateInput => ({system: 'Explain only the selected text.', messages: [{role: 'user', content: 'Practice helps.'}], tools, signal: new AbortController().signal, onText: vi.fn()});
const openai = (text = 'Visible answer', extra: Record<string, unknown> = {}) => ({id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'server-model', choices: [{index: 0, delta: {content: text}, finish_reason: 'stop'}], ...extra});
const events = (values: unknown[], chunkSize = 17, ending = '\n\n') => {
    const bytes = new TextEncoder().encode(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${ending}`).join(''));
    return new Response(new ReadableStream<Uint8Array>({start(controller) {for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));controller.close();}}), {headers: {'content-type': 'text/event-stream'}});
};
const claude = (text = 'Visible answer') => [
    {type: 'message_start', message: {id: 'message', type: 'message', role: 'assistant', model: 'server-model', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 5, output_tokens: 0}}},
    {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
    {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}},
    {type: 'content_block_stop', index: 0},
    {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 3}}, {type: 'message_stop'},
];
const gemini = (text = 'Visible answer') => [{modelVersion: 'server-model', candidates: [{index: 0, content: {role: 'model', parts: [{text}]}, finishReason: 'STOP'}], usageMetadata: {promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8}}];
beforeEach(() => {transport.mockReset();setRuntimeFetch(transport);});
afterEach(() => {setRuntimeFetch();vi.restoreAllMocks();});

it.each(['gpt-6-luna', 'gpt-6.1-terra'])('keeps %s completion limits and custom parameters equivalent across reading transports', async model => {
    const value = config();
    value.customBody.openai = JSON.stringify({max_tokens: null, max_completion_tokens: 32, reasoning_effort: 'none', service_tier: 'fast', stream: false, messages: [], tools: []});
    transport.mockImplementation(async () => events([openai()]));
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        const result = await factory(value, 'openai', model, tools)(input());
        expect(result.text).toBe('Visible answer');
    }
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, init] of transport.mock.calls) {
        const serialized = String(init!.body), body = JSON.parse(serialized);
        expect(serialized).not.toContain('"max_tokens"');
        expect(body).toMatchObject({model, max_completion_tokens: 32, reasoning_effort: 'none', service_tier: 'fast', stream: true});
        expect(body.messages).toEqual([{role: 'system', content: 'Explain only the selected text.'}, {role: 'user', content: 'Practice helps.'}]);
        expect(body.tools[0].function.name).toBe('read_context');
    }
});

it.each(['openai', 'claude', 'gemini'] as const)('keeps %s text, tool schema, endpoint and auth equivalent to the native SDK request', async service => {
    const value = config(service), request = input();const fixture = service === 'openai' ? [openai()] : service === 'claude' ? claude() : gemini();
    transport.mockImplementation(async () => events(fixture));
    const native = await nativeGenerator(value, service, 'fixture-model', tools)(request);
    const baseline = transport.mock.calls[0];transport.mockClear();
    const actual = await createHarnessGenerator(value, service, 'fixture-model', tools)(request);
    expect(actual.text).toBe(native.text);expect(actual.toolCalls).toEqual(native.toolCalls);
    const observed = transport.mock.calls[0];expect(String(observed[0])).toBe(String(baseline[0]));
    const headers = new Headers(observed[1]?.headers), nativeHeaders = new Headers(baseline[1]?.headers);
    for (const key of ['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access']) expect(headers.get(key)).toBe(nativeHeaders.get(key));
    const body = JSON.parse(observed[1]!.body as string), expected = JSON.parse(baseline[1]!.body as string);
    for (const key of ['model', 'stream', 'max_tokens', 'messages', 'system', 'contents', 'systemInstruction', 'generationConfig', 'tools', 'tool_choice', 'toolConfig']) expect(body[key], key).toEqual(expected[key]);
    expect(observed[1]?.signal).toBe(request.signal);expect(observed[1]?.redirect).toBe('error');
});

it.each(['openai', 'claude', 'gemini'] as const)('executes an authorized %s tool call and preserves tool-result pairing in the next actual request', async service => {
    const value = config(service);let count = 0;
    transport.mockImplementation(async () => {
        if (count++ > 0) return events(service === 'claude' ? claude('Context explains it.') : service === 'gemini' ? gemini('Context explains it.') : [openai('Context explains it.')]);
        if (service === 'claude') return events([{type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'context-call', name: 'read_context', input: {}}},
            {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"reason":"clarify"}'}}, {type: 'message_delta', delta: {stop_reason: 'tool_use'}}]);
        if (service === 'gemini') return events([{candidates: [{content: {parts: [{functionCall: {id: 'context-call', name: 'read_context', args: {reason: 'clarify'}}, thoughtSignature: 'signed-tool'}]}, finishReason: 'STOP'}]}]);
        return events([
            {choices: [{delta: {tool_calls: [{index: 0, id: 'context-call', function: {arguments: '{"reason":'}}]}}]},
            {choices: [{delta: {tool_calls: [{index: 0, function: {name: 'read_context', arguments: '"clarify"}'}}]}, finish_reason: 'tool_calls'}]},
        ]);
    });
    const executeTool = vi.fn(async () => 'Only the authorized paragraph.');
    const result = await runHarnessLoop({generate: createHarnessGenerator(value, service, 'fixture-model', tools), executeTool,
        system: 'Analyze', user: 'Selected phrase', tools, signal: new AbortController().signal});
    expect(result.text).toBe('Context explains it.');expect(executeTool).toHaveBeenCalledWith({id: 'context-call', name: 'read_context', input: {reason: 'clarify'}}, expect.any(AbortSignal));
    const second = JSON.parse(transport.mock.calls[1][1]!.body as string);expect(JSON.stringify(second)).toContain('Only the authorized paragraph.');expect(JSON.stringify(second)).toContain('context-call');
    if (service === 'gemini') expect(JSON.stringify(second)).toContain('signed-tool');
});

it.each(['{"x-secret":"ignored"}', '{invalid-unused-header'] as const)('keeps anonymous Bilibili fixed and hides split thinking despite unused headers %s', async headers => {
    const value = config('bilibili');value.proxy.bilibili = 'https://ignored.test';value.customHeaders.bilibili = headers;
    transport.mockResolvedValue(events([{choices: [{delta: {content: '<thi'}}]}, {choices: [{delta: {content: 'nk>hidden</think>Visible'}}]}, {choices: [{delta: {content: ' answer'}, finish_reason: 'stop'}]}], 1));
    const request = input();const result = await createHarnessGenerator(value, 'bilibili', 'ignored', [])(request);
    expect(result.text).toBe('Visible answer');expect(request.onText).toHaveBeenCalledTimes(2);expect(request.onText).not.toHaveBeenCalledWith('');
    const [url, init] = transport.mock.calls[0];expect(String(url)).not.toContain('ignored.test');expect(init?.credentials).toBe('omit');expect(new Headers(init?.headers).has('authorization')).toBe(false);expect(new Headers(init?.headers).has('x-secret')).toBe(false);expect(JSON.stringify(JSON.parse(init!.body as string))).not.toContain('controlled-key');
});

it.each([
    ['malformed JSON', 'not json'], ['not an object', '[]'], ['provider error', '{"error":{"message":"private"}}'],
    ['missing choices', '{}'], ['unfinished stream', '{"choices":[{"delta":{"content":"incomplete"}}]}'],
    ['invalid text', '{"choices":[{"delta":{"content":7},"finish_reason":"stop"}]}'],
    ['invalid tool index', '{"choices":[{"delta":{"tool_calls":[{"index":-1}]},"finish_reason":"tool_calls"}]}'],
    ['invalid tool JSON', '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"read_context","arguments":"oops"}}]},"finish_reason":"tool_calls"}]}'],
] as const)('rejects %s without accepting partial output', async (_label, payload) => {
    transport.mockResolvedValue(new Response(`data: ${payload}\n\n`));await expect(createHarnessGenerator(config(), 'openai', 'reader', tools)(input())).rejects.toThrow();
});

it('releases a stalled body reader promptly on cancellation and never publishes a late answer', async () => {
    const cancel = vi.fn();const body = new ReadableStream<Uint8Array>({cancel});transport.mockResolvedValue(new Response(body));
    const controller = new AbortController(), request = {...input(), signal: controller.signal};const pending = createHarnessGenerator(config(), 'openai', 'reader', [])(request);
    await vi.waitFor(() => expect(body.locked).toBe(true));controller.abort();await expect(pending).rejects.toThrow();expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false);expect(request.onText).not.toHaveBeenCalled();
});

it('rotates a rejected key using structured HTTP status without disclosing either credential', async () => {
    const value = config();value.apiKeys.openai = ['controlled-first-key', 'controlled-second-key'];value.token.openai = value.apiKeys.openai[0];
    transport.mockResolvedValueOnce(new Response('unused private error', {status: 401})).mockResolvedValueOnce(events([openai()]));
    const usage = vi.fn();const result = await createHarnessGenerator(value, 'openai', 'reader', [], usage)(input());expect(usage).toHaveBeenCalledOnce();expect(usage.mock.calls[0][0].outcome).toBe('success');expect(result.text).toBe('Visible answer');expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual(['Bearer controlled-first-key', 'Bearer controlled-second-key']);
});

it('preserves Gemini empty-text signatures and string tool args across the next real SDK-equivalent request', async () => {
    const first = [{candidates: [{content: {parts: [{text: 'Preface'}]}}]},
        {candidates: [{content: {parts: [{text: '', thoughtSignature: 'signature-on-current-text'}]}}]},
        {candidates: [{content: {parts: [{functionCall: {id: 'read', name: 'read_context', args: '{"reason":"clarify"}'}, thoughtSignature: 'tool-signature'}]}, finishReason: 'STOP'}]}];
    const executeTool = vi.fn(async (_call: HarnessToolCall) => 'Authorized text');
    const observed: Record<string, unknown>[] = [];
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        transport.mockReset().mockResolvedValueOnce(events(first)).mockResolvedValueOnce(events(gemini('Done')));
        await runHarnessLoop({generate: factory(config('gemini'), 'gemini', 'gemini-3-flash-preview', tools), executeTool,
            system: 'Analyze', user: 'Phrase', tools, signal: new AbortController().signal});
        observed.push(JSON.parse(transport.mock.calls[1][1]!.body as string));
    }
    expect(observed[1].contents).toEqual(observed[0].contents);expect(JSON.stringify(observed[1])).toContain('signature-on-current-text');
    expect(executeTool.mock.calls[0][0]).toMatchObject({input: {reason: 'clarify'}});
});

it('assembles only the authorized Gemini partial reason path without allowing prototype or nested writes', async () => {
    const valid = [{candidates: [{content: {parts: [{functionCall: {id: 'partial', name: 'read_context', willContinue: true, partialArgs: [{jsonPath: '$.reason', stringValue: 'cl', willContinue: true}]}}]}}]},
        // 顶层省略 willContinue 时，参数自身的继续标记仍保留同一调用，后续帧才能补齐 reason。
        {candidates: [{content: {parts: [{functionCall: {partialArgs: [{jsonPath: '$.reason', stringValue: 'ari', willContinue: true}]}}]}}]},
        {candidates: [{content: {parts: [{functionCall: {partialArgs: [{jsonPath: '$.reason', stringValue: 'fy'}]}}]}, finishReason: 'STOP'}]}];
    transport.mockResolvedValue(events(valid));const result = await createHarnessGenerator(config('gemini'), 'gemini', 'reader', tools)(input());expect(result.toolCalls[0]).toMatchObject({input: {reason: 'clarify'}});
    for (const path of ['$.extra', '$.__proto__.polluted', '$.reason.nested']) {
        transport.mockResolvedValue(events([{candidates: [{content: {parts: [{functionCall: {id: 'bad', name: 'read_context', partialArgs: [{jsonPath: path, stringValue: 'bad'}]}}]}, finishReason: 'STOP'}]}]));
        await expect(createHarnessGenerator(config('gemini'), 'gemini', 'reader', tools)(input())).rejects.toThrow('参数无效');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

it.each(['success', 'HTTP error', 'stream error', 'cancelled', 'timeout'] as const)('records %s through the existing usage contract and isolates failing sinks', async mode => {
    const controller = new AbortController(), usage = vi.fn(), request = {...input(), signal: controller.signal};
    if (mode === 'success') transport.mockResolvedValue(events([openai('Answer', {usage: {prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: {cached_tokens: 2}}})]));
    else if (mode === 'HTTP error') transport.mockResolvedValue(new Response('', {status: 503}));
    else if (mode === 'stream error') transport.mockResolvedValue(events([{error: {message: 'provider error'}}]));
    else {transport.mockImplementation(async () => {controller.abort(mode === 'timeout' ? new Error('阅读请求超时') : undefined);return events([openai()]);});}
    const pending = createHarnessGenerator(config(), 'openai', 'reader', tools, usage)(request);
    if (mode === 'success') await pending;else await expect(pending).rejects.toThrow();
    expect(usage).toHaveBeenCalledOnce();expect(usage.mock.calls[0][0]).toMatchObject({purpose: 'reading', outcome: mode === 'success' ? 'success' : mode === 'cancelled' || mode === 'timeout' ? mode : 'error'});
    if (mode === 'success') expect(usage.mock.calls[0][0]).toMatchObject({inputTokens: 5, outputTokens: 3, totalTokens: 8, cachedInputTokens: 2});
    transport.mockResolvedValue(events([openai()]));await expect(createHarnessGenerator(config(), 'openai', 'reader', [], () => {throw new Error('sink failure');})(input())).resolves.toMatchObject({text: 'Visible answer'});
});

it('preserves the original generation failure when its final usage consumer also throws', async () => {
    transport.mockResolvedValue(events([{error: {message: 'provider rejected reading'}}]));
    const usage = vi.fn(() => {throw new Error('usage sink failed');});
    await expect(createHarnessGenerator(config(), 'openai', 'reader', [], usage)(input())).rejects.toThrow('阅读服务返回错误');
    expect(usage).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();
});

it('does not wait on a stuck cancellation handshake after HTTP failure or malformed stream data', async () => {
    for (const status of [200, 503]) {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new TextEncoder().encode('data: invalid\n\n'));}, cancel});
        transport.mockResolvedValue(new Response(body, {status}));
        await expect(createHarnessGenerator(config(), 'openai', 'reader', [])(input())).rejects.toThrow();expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false);
    }
});

it.each(['gemini-3-flash-preview', 'gemini-2.5-flash'] as const)('keeps %s missing-signature compatibility on the actual follow-up wire', async model => {
    const request = input();request.messages = [...request.messages, {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'unsigned', toolName: 'read_context', input: {}}]},
        {role: 'tool', content: [{type: 'tool-result', toolCallId: 'unsigned', toolName: 'read_context', output: {type: 'text', value: 'Context'}}]}];
    const bodies: any[] = [];
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        transport.mockReset().mockResolvedValue(events(gemini()));await factory(config('gemini'), 'gemini', model, tools)(request);bodies.push(JSON.parse(transport.mock.calls[0][1]!.body as string));
    }
    expect(bodies[1].contents).toEqual(bodies[0].contents);
});

it('matches the native boundary: a connection failure can rotate keys, a failure after streamed text cannot replay', async () => {
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        const value = config();value.apiKeys.openai = [`${factory.name}-stream-key-a`, `${factory.name}-stream-key-b`];value.token.openai = value.apiKeys.openai[0];
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        transport.mockReset().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({start(next) {
            controller = next;next.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: 'Partial'}}]})}\n\n`));
        }})));
        const request = input(), pending = factory(value, 'openai', 'reader', tools)(request);
        await vi.waitFor(() => expect(request.onText).toHaveBeenCalledWith('Partial'));controller.error(new TypeError('Failed to fetch'));
        await expect(pending).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();
    }
});

it('preserves native model admission and normalized model identifiers before any network request', async () => {
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        expect(() => factory(config(), 'openai', '  ', [])).toThrow('选择一个模型');
        expect(() => factory(config(), 'microsoft', 'machine-model', [])).toThrow('尚未适配');
        transport.mockReset().mockResolvedValue(events([openai()]));await factory(config(), 'openai', '  trimmed-reader  ', [])(input());
        expect(JSON.parse(transport.mock.calls[0][1]!.body as string).model).toBe('trimmed-reader');
    }
});

it('keeps signed Claude thinking and merges parallel tool results exactly like the native next request', async () => {
    const initial = [{type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
        {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'Hidden reasoning'}},
        {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'thinking-signature'}}, {type: 'content_block_stop', index: 0},
        {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: 'Preface'}}, {type: 'content_block_stop', index: 1},
        ...[2, 3].flatMap(index => [{type: 'content_block_start', index, content_block: {type: 'tool_use', id: `tool-${index}`, name: 'read_context', input: {}}},
            {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: '{}'}}, {type: 'content_block_stop', index}]),
        {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 4}}, {type: 'message_stop'}];
    const bodies: any[] = [];
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        transport.mockReset().mockResolvedValueOnce(events(initial)).mockResolvedValueOnce(events(claude('Done')));
        const onText = vi.fn();await runHarnessLoop({generate: factory(config('claude'), 'claude', 'claude-sonnet-4-5', tools), executeTool: async () => 'Authorized paragraph',
            system: 'Explain', user: 'Phrase', tools, signal: new AbortController().signal, onText});
        expect(onText.mock.calls.map(([text]) => text).join('')).not.toContain('Hidden reasoning');
        bodies.push(JSON.parse(transport.mock.calls[1][1]!.body as string));
    }
    expect(bodies[1].messages).toEqual(bodies[0].messages);expect(bodies[1].messages.at(-1).content).toHaveLength(2);
});

it.each([
    ['openai', {choices: [{delta: {content: 'text'}, finish_reason: {bad: true}}]}],
    ['openai', {choices: [{delta: 'not an object', finish_reason: 'stop'}]}],
    ['openai', {model: 42, choices: [{delta: {content: 'text'}, finish_reason: 'stop'}]}],
    ['openai', {choices: [{delta: {tool_calls: {}}, finish_reason: 'stop'}]}],
    ['openai', {choices: [{delta: {tool_calls: [null]}, finish_reason: 'stop'}]}],
    ['gemini', {candidates: 'not an array'}],
    ['gemini', {candidates: [{finishReason: 'STOP', content: {parts: [null]}}]}],
    ['gemini', {candidates: [{finishReason: 'STOP', content: {parts: [7]}}]}],
    ['claude', {type: 'unknown-event'}],
    ['claude', {type: 'message_delta', delta: {stop_reason: {bad: true}}}],
] as const)('rejects malformed %s event fields instead of treating them as completed text', async (service, value) => {
    transport.mockResolvedValue(events([value]));await expect(createHarnessGenerator(config(service), service, 'reader', tools)(input())).rejects.toThrow();
});

it('counts all key attempts in the one final usage duration without counting failures twice', async () => {
    const clock = vi.spyOn(Date, 'now');clock.mockReturnValue(1000);
    const value = config();value.apiKeys.openai = ['duration-key-one', 'duration-key-two'];value.token.openai = value.apiKeys.openai[0];
    transport.mockImplementationOnce(async () => {clock.mockReturnValue(1200);return new Response('', {status: 401});})
        .mockImplementationOnce(async () => {clock.mockReturnValue(1500);return events([openai()]);});
    const usage = vi.fn();await createHarnessGenerator(value, 'openai', 'reader', [], usage)(input());
    expect(usage).toHaveBeenCalledOnce();expect(usage.mock.calls[0][0]).toMatchObject({startedAt: 1000, durationMs: 500, outcome: 'success'});
});

it('rejects an unregistered tool before sending data to the model', () => {
    expect(() => createHarnessGenerator(config(), 'openai', 'reader', [{name: 'write_context', description: 'not authorized', input: {}}])).toThrow('不支持的阅读助手工具');
    expect(transport).not.toHaveBeenCalled();
});

it('accepts real SSE comments, multiline data and terminal events across CRLF and EOF boundaries', async () => {
    const payload = ': keepalive\r\nevent: completion\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r';
    const bytes = new TextEncoder().encode(payload);transport.mockResolvedValue(new Response(new ReadableStream({start(controller) {for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));controller.close();}})));
    await expect(createHarnessGenerator(config(), 'openai', 'reader', [])(input())).resolves.toMatchObject({text: 'Answer'});
});

it('bounds stream memory and rejects missing bodies without leaving a locked reader', async () => {
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));controller.close();}});
    transport.mockResolvedValue(new Response(body));await expect(createHarnessGenerator(config(), 'openai', 'reader', [])(input())).rejects.toThrow('响应过大');expect(body.locked).toBe(false);
    transport.mockResolvedValue(new Response(null));await expect(createHarnessGenerator(config(), 'openai', 'reader', [])(input())).rejects.toThrow('空响应');
});

it.each(['length', 'content_filter', 'tool_calls'])('rejects incomplete Bilibili completion %s without accepting reasoning as visible text', async finish => {
    transport.mockResolvedValue(events([{choices: [{delta: {content: '<think>hidden</think>answer'}, finish_reason: finish}]}]));
    await expect(createHarnessGenerator(config('bilibili'), 'bilibili', 'ignored', [])(input())).rejects.toThrow();
});

it('keeps OpenAI reasoning, tool signatures and missing tool-result content on the next wire', async () => {
    const request = input();request.messages = [...request.messages,
        {role: 'assistant', content: [{type: 'reasoning', text: 'internal'}, {type: 'tool-call', toolCallId: 'previous', toolName: 'read_context', input: {}, providerOptions: {google: {thoughtSignature: 'signed'}}}]},
        {role: 'tool', content: [{type: 'tool-result', toolCallId: 'previous', toolName: 'read_context', output: {type: 'text', value: ''}}]}];
    transport.mockResolvedValue(events([{choices: [{delta: {reasoning: 'new reasoning', tool_calls: [{id: 'new', function: {name: 'read_context', arguments: '{}'}, extra_content: {google: {thought_signature: 'new-signature'}}}]}, finish_reason: 'tool_calls'}]}]));
    const result = await createHarnessGenerator(config(), 'openai', 'reader', tools)(request), wire = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(wire.messages[2]).toMatchObject({content: null, reasoning_content: 'internal', tool_calls: [{extra_content: {google: {thought_signature: 'signed'}}}]});
    expect(wire.messages[3]).toMatchObject({role: 'tool', tool_call_id: 'previous', content: ''});
    expect(result.assistant.content).toEqual(expect.arrayContaining([{type: 'reasoning', text: 'new reasoning'}, expect.objectContaining({type: 'tool-call', providerOptions: {google: {thoughtSignature: 'new-signature'}}})]));
});

it('preserves Gemini signed reasoning and the Gemma system-message adaptation on the real wire', async () => {
    const request = input();request.messages = [...request.messages, {role: 'assistant', content: [{type: 'reasoning', text: 'hidden', providerOptions: {google: {thoughtSignature: 'signed-reasoning'}}}]}];
    transport.mockResolvedValue(events([{candidates: [{content: {parts: [{text: 'thought', thought: true, thoughtSignature: 'new-reasoning'}, {text: 'answer'}]}, finishReason: 'STOP'}]}]));
    const result = await createHarnessGenerator(config('gemini'), 'gemini', 'gemma-3-27b-it', [])(request), wire = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(wire.systemInstruction).toBeUndefined();expect(wire.contents[0].parts[0]).toEqual({text: request.system});
    expect(wire.contents[1].parts).toEqual([{text: 'hidden', thought: true, thoughtSignature: 'signed-reasoning'}]);expect(result.text).toBe('answer');
    expect(result.assistant.content).toEqual([{type: 'reasoning', text: 'thought', providerOptions: {google: {thoughtSignature: 'new-reasoning'}}}, {type: 'text', text: 'answer'}]);
});

it('replays Claude redacted reasoning as opaque data without displaying or parsing it', async () => {
    const first = [{type: 'content_block_start', index: 0, content_block: {type: 'redacted_thinking', data: 'opaque-signature'}}, {type: 'content_block_stop', index: 0},
        {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'context', name: 'read_context', input: {}}}, {type: 'message_delta', delta: {stop_reason: 'tool_use'}}];
    transport.mockResolvedValueOnce(events(first)).mockResolvedValueOnce(events(claude('Done')));
    const result = await runHarnessLoop({generate: createHarnessGenerator(config('claude'), 'claude', 'reader', tools), executeTool: async () => 'Context', system: 'Explain', user: 'Phrase', tools, signal: new AbortController().signal});
    expect(result.text).toBe('Done');const wire = JSON.parse(transport.mock.calls[1][1]!.body as string);
    expect(wire.messages[1].content[0]).toEqual({type: 'redacted_thinking', data: 'opaque-signature'});
});

it('stops the current network chunk immediately when a visible update cancels the reading', async () => {
    const controller = new AbortController(), onText = vi.fn(() => controller.abort());
    transport.mockResolvedValue(events([openai('First'), openai('Second')], 4096));
    const usage = vi.fn();await expect(createHarnessGenerator(config(), 'openai', 'reader', [], usage)({...input(), signal: controller.signal, onText})).rejects.toThrow();
    expect(onText).toHaveBeenCalledOnce();expect(onText).toHaveBeenCalledWith('First');expect(usage).toHaveBeenCalledOnce();expect(usage.mock.calls[0][0].outcome).toBe('cancelled');
});

it.each(['azureOpenai', 'zhipu', 'custom:reader', 'claude', 'gemini'] as const)('preserves %s configured endpoint and credentials without mutating saved preferences', async service => {
    const value = config(service), before = () => JSON.stringify(value);
    if (service === 'azureOpenai') value.azureOpenaiEndpoint = 'https://azure.test/openai/deployments/reader/chat/completions?api-version=2024-02-15-preview';
    else if (service === 'custom:reader') {value.customOpenAIProviders = [{id: service, name: 'Reader', endpoint: 'https://reader.test/v1/chat/completions?tenant=a&tenant=b', models: ['reader']}];value.customHeaders[service] = '{"X-Reader":"fixture"}';}
    else {value.proxy[service] = 'https://reader.test/exact?tenant=a&tenant=b';if (service === 'zhipu') value.token[service] = 'fixture-id.fixture-secret';}
    const saved = before(), observed: Array<{url:string;body:any;headers:Headers}> = [];
    for (const factory of [nativeGenerator, createHarnessGenerator]) {
        transport.mockReset().mockResolvedValue(events(service === 'claude' ? claude() : service === 'gemini' ? gemini() : [openai()]));
        await factory(value, service, 'reader', [])(input());const call=transport.mock.calls[0];observed.push({url:String(call[0]),body:JSON.parse(call[1]!.body as string),headers:new Headers(call[1]?.headers)});
    }
    expect(observed[1].url).toBe(observed[0].url);expect(observed[1].body).toMatchObject(observed[0].body);
    for (const header of ['api-key','x-api-key','x-goog-api-key','x-reader']) expect(observed[1].headers.get(header)).toBe(observed[0].headers.get(header));
    if (service==='zhipu') expect(observed[1].headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
    expect(before()).toBe(saved);
});

it('allows keyless local OpenAI endpoints and rejects malformed custom headers before network activity', async () => {
    const value=config('custom:local');value.customOpenAIProviders=[{id:'custom:local',name:'Local',endpoint:'http://localhost:11434/v1',models:['reader']}];delete value.token['custom:local'];
    transport.mockResolvedValue(events([openai()]));await createHarnessGenerator(value,'custom:local','reader',[])(input());expect(new Headers(transport.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    transport.mockClear();value.customHeaders['custom:local']='{invalid';await expect(createHarnessGenerator(value,'custom:local','reader',[])(input())).rejects.toThrow('自定义请求头');expect(transport).not.toHaveBeenCalled();
});

it.each(['claude','gemini'] as const)('records %s actual model and measured tokens from its native response format', async service => {
    const usage=vi.fn();transport.mockResolvedValue(events(service==='claude'?claude():gemini()));await createHarnessGenerator(config(service),service,'reader',[],usage)(input());
    expect(usage).toHaveBeenCalledOnce();expect(usage.mock.calls[0][0]).toMatchObject({actualModel:'server-model',inputTokens:5,outputTokens:3,totalTokens:8,outcome:'success'});
});

it.each([
    ['id type',{index:0,id:7,function:{name:'read_context'}}],
    ['name type',{index:0,id:'x',function:{name:7}}],
    ['argument type',{index:0,id:'x',function:{name:'read_context',arguments:{reason:'invalid'}}}],
    ['missing id',{index:0,function:{name:'read_context'}}],
    ['missing name',{index:0,id:'x'}],
] as const)('rejects OpenAI %s tool corruption before the loop can execute it',async (_label,call)=>{
    transport.mockResolvedValue(events([{choices:[{delta:{tool_calls:[call]},finish_reason:'tool_calls'}]}]));await expect(createHarnessGenerator(config(),'openai','reader',tools)(input())).rejects.toThrow();
});

it.each(['id','name'] as const)('rejects a changed OpenAI tool %s across streamed chunks',async field=>{
    const first={index:0,id:'initial',function:{name:'read_context',arguments:'{'}};
    const second=field==='id'?{index:0,id:'changed'}:{index:0,function:{name:'another_tool'}};
    transport.mockResolvedValue(events([{choices:[{delta:{tool_calls:[first]}}]},{choices:[{delta:{tool_calls:[second]},finish_reason:'tool_calls'}]}]));
    await expect(createHarnessGenerator(config(),'openai','reader',tools)(input())).rejects.toThrow('冲突');
});

it.each([
    ['unknown text block',[{type:'content_block_delta',index:5,delta:{type:'text_delta',text:'unowned'}}]],
    ['invalid text',[{type:'content_block_start',index:0,content_block:{type:'text'}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:5}}]],
] as const)('rejects Claude %s without emitting unowned content',async (_label,values)=>{
    transport.mockResolvedValue(events([...values,{type:'message_delta',delta:{stop_reason:'end_turn'}}]));const request=input();await expect(createHarnessGenerator(config('claude'),'claude','reader',tools)(request)).rejects.toThrow();expect(request.onText).not.toHaveBeenCalled();
});

it.each([
    ['invalid function',{functionCall:'read_context'}], ['orphan partial args',{functionCall:{partialArgs:[]}}],
    ['non-list partial args',{functionCall:{name:'read_context',partialArgs:{reason:'invalid'}}}], ['invalid text',{text:5}],
    ['missing tool name',{functionCall:{args:{}}}],
] as const)('rejects Gemini %s before returning a successful tool round',async (_label,part)=>{
    transport.mockResolvedValue(events([{candidates:[{content:{parts:[part]},finishReason:'STOP'}]}]));await expect(createHarnessGenerator(config('gemini'),'gemini','reader',tools)(input())).rejects.toThrow();
});

it('omits unsupported history metadata while preserving visible assistant text and empty tool results', async () => {
    const request=input();request.messages=[...request.messages,{role:'assistant',content:[{type:'reasoning',text:'unsigned reasoning'}, {type:'source-url',url:'https://reference.test'}, {type:'text',text:''},{type:'text',text:'Previous answer'}]},
        {role:'tool',content:[{type:'tool-result',toolName:'read_context',toolCallId:'old-call'}]}, {role:'user',content:null}];
    for(const service of ['openai','claude','gemini']) {
        transport.mockReset().mockResolvedValue(events(service==='claude'?claude():service==='gemini'?gemini():[openai()]));
        await createHarnessGenerator(config(service),service,'reader',tools)(request);
        const wire=JSON.parse(transport.mock.calls[0][1]!.body as string),encoded=JSON.stringify(wire);
        expect(encoded).toContain('Previous answer');expect(encoded).not.toContain('reference.test');
        if(service==='openai')expect(wire.messages[2]).toMatchObject({role:'assistant',content:'Previous answer',reasoning_content:'unsigned reasoning'});
        if(service==='claude')expect(encoded).not.toContain('unsigned reasoning');
    }
});

it('handles Gemini incremental calls with no optional args and an explicit trailing close frame',async()=>{
    const fixtures=[
        {functionCall:{name:'read_context',willContinue:true}},
        {functionCall:{willContinue:false}},
        {functionCall:{name:'read_context'}},
    ];
    transport.mockResolvedValue(events(fixtures.map((part,index)=>({candidates:[{content:{parts:[part]},...(index===fixtures.length-1?{finishReason:'STOP'}:{})}]}))));
    const result=await createHarnessGenerator(config('gemini'),'gemini','reader',tools)(input());expect(result.toolCalls).toHaveLength(2);
    for(const call of result.toolCalls)expect(call).toMatchObject({id:expect.any(String),name:'read_context',input:{}});
});

it('preserves a streaming Gemini argument across an empty continuation frame',async()=>{
    transport.mockResolvedValue(events([
        {candidates:[{content:{parts:[{functionCall:{name:'read_context',willContinue:true,partialArgs:[{jsonPath:'$.reason',stringValue:'why',willContinue:true}]}}]}}]},
        {candidates:[{content:{parts:[{functionCall:{partialArgs:[]}}]},finishReason:'STOP'}]},
    ]));
    const result=await createHarnessGenerator(config('gemini'),'gemini','reader',tools)(input());expect(result.toolCalls[0].input).toEqual({reason:'why'});
});

it('uses the configured Claude model when start metadata omits it and retains an earlier finish reason',async()=>{
    transport.mockResolvedValue(events([{type:'message_start',message:{usage:{input_tokens:2}}},...claude('Done').slice(1,-1),{type:'message_delta',delta:{}},{type:'message_stop'}]));
    const usage=vi.fn();await expect(createHarnessGenerator(config('claude'),'claude','configured-reader',[],usage)(input())).resolves.toMatchObject({text:'Done'});expect(usage.mock.calls[0][0].actualModel).toBe('configured-reader');
});

it('accepts an empty OpenAI tool input as an object and records a non-timeout Error abort as cancelled',async()=>{
    transport.mockResolvedValue(events([{choices:[{delta:{tool_calls:[{id:'empty',function:{name:'read_context'}}]},finish_reason:'tool_calls'}]}]));
    expect((await createHarnessGenerator(config(),'openai','reader',tools)(input())).toolCalls[0].input).toEqual({});
    const controller=new AbortController();controller.abort(new Error('user closed reading'));const usage=vi.fn();transport.mockResolvedValue(events([openai()]));
    await expect(createHarnessGenerator(config(),'openai','reader',[],usage)({...input(),signal:controller.signal})).rejects.toThrow();expect(usage.mock.calls[0][0].outcome).toBe('cancelled');
});

it.each([null,[],{extra:'not authorized'},{reason:5},{reason:'x'.repeat(201)}])('preserves invalid read_context input %j so the shared validator still rejects it',async args=>{
    const observed: unknown[]=[];
    for(const factory of [nativeGenerator,createHarnessGenerator]) {
        transport.mockReset().mockResolvedValue(events([{choices:[{delta:{tool_calls:[{index:0,id:'invalid-input',function:{name:'read_context',arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]}]));
        const result=await factory(config(),'openai','reader',tools)(input());observed.push(result.toolCalls[0].input);
    }
    expect(isReadContextInput(observed[0])).toBe(false);expect(observed[1]).toEqual(observed[0]);expect(isReadContextInput(observed[1])).toBe(false);
});
