import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const ports = vi.hoisted(() => ({current: undefined as unknown, changed: undefined as undefined | (() => void)}));
vi.mock('@/src/services/config/store', () => ({
  get config() { return ports.current; },
  subscribeConfig: (callback: () => void) => { ports.changed = callback; callback(); return () => undefined; },
}));
import {Config} from '@/src/core/config/model';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createVideoSemanticRuntime} from '@/src/features/video-subtitle/background/semanticRuntime';

const service = 'custom:semantic-contract';
const context = {sender: {id: 'ext', tab: {id: 1, incognito: false, url: 'https://video.invalid/watch'},
  frameId: 0, documentId: 'document', url: 'https://video.invalid/watch'}};
const request = (id = 'wire') => ({type: 'fluentReadSegmentVideoSemantics', algorithmVersion: 2,
  requestId: id, cues: [{text: 'A sentence.', startMs: 0, durationMs: 1000}]});
function response() {
  return new Response(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 1, model: 'semantic-model',
    choices: [{index: 0, message: {role: 'assistant', content: '{"boundaries":["b11"]}'}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}), {headers: {'content-type': 'application/json'}});
}
function current() { return ports.current as Config; }
beforeEach(() => {
  ports.changed = undefined;
  const config = new Config();
  Object.assign(config, {on: true, videoTranslationEnabled: true, videoSemanticSegmentationEnabled: true,
    videoSemanticSegmentationService: service, videoSemanticSegmentationModel: 'semantic-model', disabledExtensionDomains: []});
  config.customOpenAIProviders = [{id: service, name: 'Fixture', endpoint: 'https://semantic.invalid/v1/chat/completions', models: ['semantic-model']}];
  config.apiKeys[service] = ['fixture-first', 'fixture-second'];
  config.token[service] = 'fixture-first'; config.apiKeyRotationEnabled[service] = true;
  config.customBody[service] = '{}'; ports.current = config;
  vi.stubGlobal('browser', {runtime: {id: 'ext'}, extension: {inIncognitoContext: false},
    tabs: {onRemoved: {addListener: vi.fn()}, onUpdated: {addListener: vi.fn()}}});
});
afterEach(() => {setRuntimeFetch(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('semantic runtime through the real SDK and shared gateway', () => {
  it.each([
    [{}, 'max_tokens', 8192, 0],
    [{temperature: .6, max_tokens: 16384}, 'max_tokens', 16384, .6],
    [{max_tokens: 2048, max_completion_tokens: 4096}, 'max_completion_tokens', 4096, 0],
    [{max_tokens: null, max_completion_tokens: null}, 'max_tokens', 8192, 0],
  ] as const)('preserves shared custom generation precedence for %j without changing source or model', async (custom, limitKey, limit, temperature) => {
    current().customBody[service] = JSON.stringify({...custom, model: 'wrong-model', messages: [{role: 'user', content: 'injected'}],
      tools: [{type: 'function', function: {name: 'unexpected'}}], tool_choice: 'required', parallel_tool_calls: true,
      stream: true, stream_options: {include_usage: true}, response_format: {type: 'json_object'}});
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response()); setRuntimeFetch(fetch);
    const handlers = createVideoSemanticRuntime();
    expect(await handlers[0].handle(request(), context)).toMatchObject({success: true, result: {boundaries: ['b11']}});
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]; const body = JSON.parse(String(init?.body));
    expect(String(url)).toBe('https://semantic.invalid/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-first');
    expect(body.model).toBe('semantic-model'); expect(body[limitKey]).toBe(limit); expect(body.temperature).toBe(temperature);
    expect(body[limitKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
    const fragments = JSON.parse(body.messages.find((message: {role: string}) => message.role === 'user').content).fragments;
    expect(fragments.map((fragment: {text: string}) => fragment.text).join('')).toBe('A sentence.');
    expect(fragments.map((fragment: {end: string}) => fragment.end)).toEqual(['b2', 'b10', 'b11']);
    expect(JSON.stringify(body.messages)).not.toContain('injected');
    expect(body.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('untrusted data')});
    expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined(); expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.stream).not.toBe(true); expect(body.stream_options).toBeUndefined(); expect(body.response_format).toBeUndefined();
    expect(current().apiKeys[service]).toEqual(['fixture-first', 'fixture-second']);
  });

  it.each([429, 500])('does not retry or rotate the real transport after HTTP %i', async status => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({error: {message: 'fixture-first private fixture detail'}}), {status, headers: {'content-type': 'application/json'}}));
    setRuntimeFetch(fetch);
    const result = await createVideoSemanticRuntime()[0].handle(request(), context);
    expect(result).toMatchObject({success: false, error: 'AI segmentation failed; original subtitles are unchanged'});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fixture-first');
    expect(JSON.stringify(result)).not.toContain('fixture-first');
  });

  it('aborts on a real custom-body fingerprint change and rejects a late response', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => {release = resolve;}));
    setRuntimeFetch(fetch);
    const handlers = createVideoSemanticRuntime(); const pending = handlers[0].handle(request(), context);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const init = fetch.mock.calls[0][1]!; const originalBody = String(init.body);
    expect(init.signal?.aborted).toBe(false);
    ports.changed!(); expect(init.signal?.aborted).toBe(false);
    current().uiLanguage = 'en-US'; ports.changed!(); expect(init.signal?.aborted).toBe(false);
    current().customBody[service] = '{"temperature":0.7,"max_tokens":1024}'; ports.changed!();
    expect(init.signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({success: false});
    release(response()); await Promise.resolve();
    expect(String(init.body)).toBe(originalBody); expect(JSON.parse(originalBody).max_tokens).toBe(8192);
    const nextFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response()); setRuntimeFetch(nextFetch);
    expect(await handlers[0].handle(request('new-explicit-request'), context)).toMatchObject({success: true});
    expect(nextFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(nextFetch.mock.calls[0][1]?.body))).toMatchObject({temperature: .7, max_tokens: 1024});
  });
});
