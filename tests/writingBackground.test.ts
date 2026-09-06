import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWritingHandler, type WritingSender} from '@/src/features/writing-assistant/background';
import type {WritingProgress, WritingRequest, WritingResponse} from '@/src/features/writing-assistant/types';
const request: WritingRequest = {type: 'fluentReadWriting', action: 'run', requestId: 'write-1', intent: 'draft', instruction: 'Write', draft: '', context: '', language: 'en', tone: 'natural', history: []};
function event<T extends (...args: any[]) => void>() { const listeners = new Set<T>(); return {addListener: (fn: T) => listeners.add(fn), removeListener: (fn: T) => listeners.delete(fn), fire: (...args: Parameters<T>) => [...listeners].forEach(fn => fn(...args)), listeners}; }
function port(sender: WritingSender | undefined = {id: 'ext', url: 'https://github.com/a', tab: {id: 1}, documentId: 'doc'}) {
  return {name: 'fluentReadWritingStream', sender, onMessage: event<(message: unknown) => void>(), onDisconnect: event<() => void>(), postMessage: vi.fn()};
}
const success: WritingResponse = {success: true, text: 'Draft', service: 'openai', model: 'writer'};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(overrides = {}) {
  const run = vi.fn(async (_r: WritingRequest, _s: AbortSignal, progress: (value: WritingProgress) => void) => { progress({kind: 'text', text: 'D'}); return success; });
  const deps = {extensionId: 'ext', optionsUrl: 'chrome-extension://ext/options.html', ready: Promise.resolve(), eligibility: vi.fn((): string | undefined => undefined), run, ...overrides};
  return {deps, handler: createWritingHandler(deps)};
}
afterEach(() => vi.useRealTimers());
describe('Writing request leases', () => {
  it('streams a single request and cleans both listeners after completion', async () => {
    const {handler, deps} = setup(); const p = port(); handler.connect(p); p.onMessage.fire(request); p.onMessage.fire(request); await flush();
    expect(deps.run).toHaveBeenCalledOnce(); expect(p.postMessage).toHaveBeenCalledWith({type: 'result', requestId: 'write-1', response: success}); expect(p.onMessage.listeners.size).toBe(0); expect(p.onDisconnect.listeners.size).toBe(0);
    expect(deps.run.mock.calls[0][0]).toEqual({...request, length: 'auto'});
  });
  it('allows only own content documents and the exact options page', async () => {
    for (const sender of [{id: 'other', url: 'https://github.com', tab: {id: 1}}, {id: 'ext', url: 'chrome-extension://ext/options.html.evil'}, {id: 'ext', url: 'file:///tmp/a', tab: {id: 1}}, {id: 'ext', url: 'https://example.com'}, {id: 'ext', tab: {id: -1}}, {id: 'ext', tab: {id: 1}}, {}]) {
      const {handler, deps} = setup(); const p = port(sender); handler.connect(p); p.onMessage.fire(request); await flush(); expect(deps.run).not.toHaveBeenCalled(); expect(p.postMessage.mock.calls[0][0].response.success).toBe(false);
    }
    const {handler, deps} = setup(); const p = port({id: 'ext', url: 'chrome-extension://ext/options.html#settings-writing'}); handler.connect(p); p.onMessage.fire(request); await flush(); expect(deps.run).toHaveBeenCalledOnce();
    const noSender = port(); Reflect.deleteProperty(noSender, 'sender'); handler.connect(noSender); noSender.onMessage.fire(null); expect(noSender.postMessage).toHaveBeenCalled();
    const other = port(); other.name = 'unrelated'; handler.connect(other); expect(other.onMessage.listeners.size).toBe(0);
  });
  it('rejects malformed payloads and a disabled site without model calls', async () => {
    const {handler, deps} = setup(); const p = port(); handler.connect(p); p.onMessage.fire({...request, token: 'evil'}); expect(deps.run).not.toHaveBeenCalled();
    deps.eligibility.mockReturnValue('blocked'); const blocked = port(); handler.connect(blocked); blocked.onMessage.fire(request); await flush(); expect(blocked.postMessage.mock.calls.at(-1)![0].response.error).toBe('blocked');
  });
  it('cancels before readiness, on disconnect and tab closure even if work ignores abort', async () => {
    let ready!: () => void; const {handler, deps} = setup({ready: new Promise(resolve => { ready = () => resolve(undefined); })});
    const p = port(); handler.connect(p); p.onMessage.fire(request); p.onDisconnect.fire(); ready(); await flush(); expect(deps.run).not.toHaveBeenCalled(); expect(p.postMessage).not.toHaveBeenCalled();
    let finish!: (value: WritingResponse) => void; let publish!: (value: WritingProgress) => void;
    deps.run.mockImplementation(async (_r, _s, progress) => { publish = progress; return new Promise(resolve => {finish = resolve;}); });
    const active = port(); handler.connect(active); active.onMessage.fire(request); await flush(); handler.cancelTab(9); expect(active.postMessage).not.toHaveBeenCalled(); handler.cancelTab(1); publish({kind: 'text', text: 'late'}); finish(success); await flush();
    expect(active.postMessage).toHaveBeenCalledTimes(1); expect(active.postMessage.mock.calls[0][0].response.cancelled).toBe(true);
  });
  it('replaces same-document work, bounds parallel pages and cancels all owners', async () => {
    const {handler, deps} = setup(); deps.run.mockImplementation(() => new Promise(() => {}));
    const first = port(); handler.connect(first); first.onMessage.fire(request); const second = port(); handler.connect(second); second.onMessage.fire({...request, requestId: 'write-2'});
    expect(first.postMessage.mock.calls[0][0].response.cancelled).toBe(true);
    for (let i = 2; i <= 4; i++) { const p = port({id: 'ext', url: 'https://github.com/a', tab: {id: i}}); handler.connect(p); p.onMessage.fire(request); }
    const limited = port({id: 'ext', url: 'https://github.com/a', tab: {id: 5}}); handler.connect(limited); limited.onMessage.fire(request); expect(limited.postMessage.mock.calls[0][0].response.error).toContain('其他'); handler.cancelAll();
  });
  it('closes timed-out work and blocks eligibility changes during streaming or completion', async () => {
    vi.useFakeTimers(); const {handler, deps} = setup(); deps.run.mockImplementation(() => new Promise(() => {})); const p = port(); handler.connect(p); p.onMessage.fire(request); await vi.advanceTimersByTimeAsync(60001); expect(p.postMessage.mock.calls.at(-1)![0].response.error).toContain('超时');
    vi.useRealTimers();
    deps.run.mockImplementation(async (_r, _s, publish) => { deps.eligibility.mockReturnValue('blocked'); publish({kind: 'text', text: 'late'}); return success; });
    const changed = port(); handler.connect(changed); changed.onMessage.fire(request); await flush(); expect(changed.postMessage.mock.calls[0][0].response.cancelled).toBe(true);
    deps.eligibility.mockReturnValue(undefined); deps.run.mockImplementation(async () => { deps.eligibility.mockReturnValue('blocked'); return success; });
    const result = port(); handler.connect(result); result.onMessage.fire(request); await flush(); expect(result.postMessage.mock.calls[0][0].response.cancelled).toBe(true);
  });
  it('handles throwing transports and runtime failures without leaking listeners', async () => {
    const {handler, deps} = setup(); deps.run.mockRejectedValue(new Error('private error')); const p = port(); handler.connect(p); p.onMessage.fire(request); await flush(); expect(p.postMessage.mock.calls[0][0].response.error).toContain('未完成');
    const broken = port(); broken.postMessage.mockImplementation(() => { throw new Error('closed'); }); handler.connect(broken); broken.onMessage.fire(request); await flush(); expect(broken.onMessage.listeners.size).toBe(0);
  });
});
