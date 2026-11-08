import {describe, expect, it, vi} from 'vitest';
import {createVideoSemanticHandlers} from '@/src/features/video-subtitle/background/semanticSegmentation';
const context = {sender: {id: 'extension', tab: {id: 1, incognito: false, url: 'https://www.youtube.com/watch?v=a'}, frameId: 0, documentId: 'doc', url: 'https://www.youtube.com/watch?v=a'}};
const request = (requestId = 'one') => ({type: 'fluentReadSegmentVideoSemantics', algorithmVersion: 2, requestId, cues: [{text: 'Hello world.', startMs: 0, durationMs: 1000}]});
const result = {boundaries: ['b12']};
const deferred = () => {let resolve!: (value: unknown) => void; const promise = new Promise(resolve_ => {resolve = resolve_;}); return {promise, resolve};};
function setup() {
  let enabled = true; let revision = 'one'; let privateContext = false;
  const generate = vi.fn().mockResolvedValue(result);
  const handlers = createVideoSemanticHandlers({runtimeId: 'extension', privateContext: () => privateContext,
    settings: () => ({enabled, revision}), generate, allowedSite: url => !url.includes('blocked')});
  return {generate, handlers, run: (input = request(), ctx = context) => handlers[0].handle(input, ctx),
    cancel: (id = 'one', ctx = context) => handlers[1].handle({...{type: 'fluentReadCancelVideoSemantics', requestId: id}}, ctx),
    disable: () => {enabled = false;}, change: () => {revision = 'two';}, makePrivate: () => {privateContext = true;}};
}
describe('AI semantic background trust and lifecycle', () => {
  it('validates output, returns request identity and suppresses duplicate execution', async () => {
    const env = setup(); expect(await env.run()).toMatchObject({success: true, requestId: 'one', result});
    await expect(env.run()).rejects.toThrow(); expect(env.generate).toHaveBeenCalledTimes(1);
  });
  it('default/disabled, private, unknown privacy, forged sender and disabled site never call model', async () => {
    const off = setup(); off.disable(); await expect(off.run()).rejects.toThrow(); expect(off.generate).not.toHaveBeenCalled();
    const privateEnv = setup(); privateEnv.makePrivate(); await expect(privateEnv.run()).rejects.toThrow(); expect(privateEnv.generate).not.toHaveBeenCalled();
    for (const sender of [ {...context.sender, id: 'other'}, {...context.sender, tab: {id: 1, incognito: true}},
      {...context.sender, tab: {id: 1}}, {...context.sender, tab: {id: -1, incognito: false}},
      {...context.sender, frameId: -1}, {...context.sender, url: 'https://blocked.example'}]) {
      const env = setup(); await expect(env.run(request(), {sender} as typeof context)).rejects.toThrow(); expect(env.generate).not.toHaveBeenCalled();
    }
  });
  it('remembers cancellation before start and prevents its replay', async () => {
    const env = setup(); env.cancel(); await expect(env.run()).rejects.toThrow(); await expect(env.run()).rejects.toThrow(); expect(env.generate).not.toHaveBeenCalled();
  });
  it('cancellation only affects matching sender document', async () => {
    const env = setup(); const wait = deferred(); env.generate.mockReturnValue(wait.promise);
    const running = env.run(); env.cancel('one', {...context, sender: {...context.sender, documentId: 'other'}});
    expect(env.generate.mock.calls[0][1].aborted).toBe(false);
    env.cancel(); expect(env.generate.mock.calls[0][1].aborted).toBe(true); expect(await running).toMatchObject({success: false});
    wait.resolve(result);
  });
  it.each(['tab', 'all', 'revision', 'disabled'])('rejects late output after %s change', async mode => {
    const env = setup(); const wait = deferred(); env.generate.mockReturnValue(wait.promise); const running = env.run();
    if (mode === 'tab') {env.handlers.cancelTab(2); expect(env.generate.mock.calls[0][1].aborted).toBe(false); env.handlers.cancelTab(1);}
    if (mode === 'all') env.handlers.cancelAll();
    if (mode === 'revision') env.change();
    if (mode === 'disabled') env.disable();
    wait.resolve(result); expect(await running).toMatchObject({success: false});
  });
  it('bounds concurrent model calls and times out uncooperative transport', async () => {
    vi.useFakeTimers();
    try {
      const env = setup(); env.generate.mockImplementation(() => new Promise(() => {}));
      const running = Array.from({length: 4}, (_, index) => env.run(request(`id${index}`)));
      await expect(env.run(request('fifth'))).rejects.toThrow('busy');
      await vi.advanceTimersByTimeAsync(30000);
      expect((await Promise.all(running)).every(response => (response as {success: boolean}).success === false)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });
  it('sanitizes malformed outputs and raw provider errors without retry', async () => {
    const env = setup(); env.generate.mockRejectedValueOnce(new Error('secret api key and private URL'));
    expect(JSON.stringify(await env.run())).not.toContain('secret'); expect(env.generate).toHaveBeenCalledTimes(1);
    env.generate.mockResolvedValue({text: 'rewritten'}); expect(await env.run(request('two'))).toMatchObject({success: false});
  });
  it('rejects invalid source and request identifiers before model call', async () => {
    for (const bad of [{...request(), algorithmVersion: 999}, {...request(), requestId: ''}, {...request(), cues: null}, {...request(), cues: [{text: 3}]}, {...request(), cues: []}]) {
      const env = setup(); await expect(env.run(bad as ReturnType<typeof request>)).rejects.toThrow(); expect(env.generate).not.toHaveBeenCalled();
    }
  });
});

it('bounds consumed and pre-cancelled identifiers and accepts URL-only sender identity', async () => {
  const env = setup();
  for (let index = 0; index < 513; index++) expect(await env.run(request(`done${index}`))).toMatchObject({success: true});
  for (let index = 0; index < 257; index++) env.cancel(`cancel${index}`);
  const withoutDocument = {sender: {...context.sender, documentId: ''}};
  expect(await env.run(request('url'), withoutDocument)).toMatchObject({success: true});
  const minimal = {sender: {id: 'extension', tab: {id: 1, incognito: false}, frameId: 0}};
  const handlers = createVideoSemanticHandlers({runtimeId: 'extension', privateContext: () => false,
    settings: () => ({enabled: true, revision: ''}), generate: async () => result});
  expect(await handlers[0].handle(request('minimal'), minimal)).toMatchObject({success: true});
});


it('rejects requests from the prior candidate algorithm before provider invocation', async () => {
  const env = setup();
  await expect(env.run({...request(), algorithmVersion: 1})).rejects.toThrow();
  expect(env.generate).not.toHaveBeenCalled();
});
