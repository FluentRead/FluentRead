import {beforeEach, describe, expect, it, vi} from 'vitest';
const m = vi.hoisted(() => ({config: {} as any, subscribe: vi.fn(), connect: vi.fn(), onConnect: vi.fn(), removed: vi.fn(), updated: vi.fn(), handlerFactory: vi.fn(), handler: {connect: vi.fn(), cancelAll: vi.fn(), cancelTab: vi.fn()}, runtimeFactory: vi.fn(), record: vi.fn(), shadow: vi.fn()}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}`, connect: m.connect, onConnect: {addListener: m.onConnect}}, tabs: {onRemoved: {addListener: m.removed}, onUpdated: {addListener: m.updated}}}}));
vi.mock('@/src/services/config/store', () => ({config: m.config, configReady: Promise.resolve(), subscribeConfig: m.subscribe}));
vi.mock('@/src/features/writing-assistant/background', () => ({createWritingHandler: m.handlerFactory}));
vi.mock('@/src/services/writing/runtime', () => ({createWritingRuntime: m.runtimeFactory}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({modelUsageRepository: {captureGeneration: () => 3, recordMany: m.record}}));
vi.mock('@/src/platform/shadow-ui/vue', () => ({createVueShadowUi: m.shadow}));
vi.mock('@/src/features/writing-assistant/ui/WritingSurface.vue', () => ({default: {}}));
import {Config} from '@/src/core/config/model';
import {streamWriting} from '@/src/features/writing-assistant/client';
import {mountWritingAssistant, unmountWritingAssistant, isWritingAssistantMounted} from '@/src/features/writing-assistant/content';
import {installWritingBackgroundRuntime} from '@/src/app/background/writingRuntime';
const request = {type: 'fluentReadWriting', action: 'run', requestId: 'write', intent: 'reply', instruction: '', draft: 'Draft', context: '', language: 'en', tone: 'natural', history: []} as const;
function event() { const listeners = new Set<Function>(); return {addListener: (fn: Function) => listeners.add(fn), removeListener: (fn: Function) => listeners.delete(fn), fire: (arg?: unknown) => [...listeners].forEach(fn => fn(arg)), listeners}; }
beforeEach(() => { vi.clearAllMocks(); Object.assign(m.config, new Config()); m.handlerFactory.mockReturnValue(m.handler); m.record.mockResolvedValue(undefined); });
describe('Writing client cleanup', () => {
  function setup() { const port = {onMessage: event(), onDisconnect: event(), disconnect: vi.fn(), postMessage: vi.fn()}; m.connect.mockReturnValue(port); const handlers = {progress: vi.fn(), result: vi.fn()}; return {port, handlers}; }
  it('isolates request ids, streams progress, closes results and ignores late events', () => {
    const {port, handlers} = setup(); const cancel = streamWriting(request as any, handlers);
    port.onMessage.fire({requestId: 'other', type: 'progress'}); expect(handlers.progress).not.toHaveBeenCalled();
    port.onMessage.fire({requestId: 'write', type: 'progress', progress: {kind: 'text', text: 'D'}}); expect(handlers.progress).toHaveBeenCalledOnce();
    port.onMessage.fire({requestId: 'write', type: 'result', response: {success: true, text: 'Draft'}}); expect(handlers.result).toHaveBeenCalledOnce(); cancel(); cancel(); expect(port.disconnect).toHaveBeenCalledOnce(); expect(port.onMessage.listeners.size).toBe(0);
  });
  it('cancels without reporting an error and handles disconnect or failed post', () => {
    const first = setup(); const cancel = streamWriting(request as any, first.handlers); const old = [...first.port.onDisconnect.listeners][0]; const message = [...first.port.onMessage.listeners][0]; cancel(); old(); message({requestId: 'write'}); expect(first.handlers.result).not.toHaveBeenCalled();
    const second = setup(); second.port.disconnect.mockImplementation(() => {throw new Error('closed');}); streamWriting(request as any, second.handlers); second.port.onDisconnect.fire(); expect(second.handlers.result).toHaveBeenCalledWith(expect.objectContaining({success: false}));
    const third = setup(); third.port.postMessage.mockImplementation(() => {throw new Error('failed');}); streamWriting(request as any, third.handlers); expect(third.handlers.result).toHaveBeenCalledOnce();
  });
});
describe('Writing mounting and background composition', () => {
  it('removes late mounts and replaces only its own previous surface', async () => {
    unmountWritingAssistant(); expect(isWritingAssistantMounted()).toBe(false);
    let resolve!: (value: any) => void; const late = {remove: vi.fn()}; m.shadow.mockImplementationOnce(() => new Promise(r => {resolve = r;})); const pending = mountWritingAssistant({} as any); unmountWritingAssistant(); resolve(late); await pending; expect(late.remove).toHaveBeenCalledOnce();
    const current = {remove: vi.fn()}; m.shadow.mockResolvedValue(current); await mountWritingAssistant({} as any); expect(isWritingAssistantMounted()).toBe(true); await mountWritingAssistant({} as any); expect(current.remove).toHaveBeenCalledOnce(); unmountWritingAssistant(); expect(current.remove).toHaveBeenCalledTimes(2);
  });
  it('gates non-writing URLs and disabled sites, binds config and tab invalidation, and records a captured generation', async () => {
    const run = vi.fn(async () => ({success: true})); m.runtimeFactory.mockReturnValue(run); installWritingBackgroundRuntime();
    const deps = m.handlerFactory.mock.calls[0][0];
    expect(deps.eligibility({})).toContain('仅支持'); expect(deps.eligibility({url:'https://example.com'})).toContain('仅支持');
    const sender = {url:'https://github.com/a/b/issues/1',tab:{url:'https://github.com/a/b/issues/1'}};
    expect(deps.eligibility(sender)).toBeUndefined(); m.config.on = false; expect(deps.eligibility(sender)).toContain('停用'); m.config.on = true; m.config.writing.enabled = false; expect(deps.eligibility(sender)).toContain('停用'); m.config.writing.enabled = true;
    m.config.disabledExtensionDomains = ['github.com']; expect(deps.eligibility(sender)).toContain('禁用'); m.config.disabledExtensionDomains = ['example.com']; expect(deps.eligibility({...sender,tab:{url:'https://example.com'}})).toContain('禁用'); expect(deps.eligibility({url:sender.url})).toBeUndefined();
    const changed = m.subscribe.mock.calls[0][0]; changed(m.config); changed(m.config); expect(m.handler.cancelAll).toHaveBeenCalledOnce(); m.config.writing.tone = 'friendly'; changed(m.config); expect(m.handler.cancelAll).toHaveBeenCalledTimes(2);
    m.onConnect.mock.calls[0][0]('port'); expect(m.handler.connect).toHaveBeenCalledWith('port'); m.removed.mock.calls[0][0](2); m.updated.mock.calls[0][0](3,{status:'complete'}); m.updated.mock.calls[0][0](4,{url:sender.url}); m.updated.mock.calls[0][0](5,{status:'loading'}); expect(m.handler.cancelTab.mock.calls).toEqual([[2],[4],[5]]);
    await deps.run(request,new AbortController().signal,vi.fn()); expect(m.runtimeFactory.mock.calls[0][0]()).toBe(m.config);
    m.record.mockRejectedValue(new Error('storage')); m.runtimeFactory.mock.calls[0][1]({purpose:'writing'}); await Promise.resolve(); expect(m.record).toHaveBeenCalledWith([{purpose:'writing'}],3);
  });
});
