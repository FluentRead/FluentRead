import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {vocabularyReencounterEnabled: true}, extension: {inIncognitoContext: false}, send: vi.fn(), add: vi.fn(), remove: vi.fn(), shadow: vi.fn(), patch: vi.fn(),
  scanner: {setEntries: vi.fn(), refresh: vi.fn(), dispose: vi.fn()}, install: vi.fn(), ui: {remove: vi.fn(), shadowHost: {isConnected: true}},
}));
vi.mock('webextension-polyfill', () => ({default: {extension: mocks.extension, runtime: {sendMessage: mocks.send, onMessage: {addListener: mocks.add, removeListener: mocks.remove}}}}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, requestConfigPatch: mocks.patch}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.shadow}));
vi.mock('@/src/features/vocabulary/content/scanner', () => ({installReencounterScanner: mocks.install}));
vi.mock('@/src/features/vocabulary/ui/ReencounterPanel.vue', () => ({default: {name: 'Panel'}}));
import {mountVocabularyReencounter, unmountVocabularyReencounter} from '@/src/features/vocabulary/content/reencounter';
import type {ReencounterOccurrence} from '@/src/features/vocabulary/content/readingText';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createContentFeatureRegistry} from '@/src/app/content/featureRegistry';

const term = {id: 'art', term: 'art', sourceLanguage: 'en', reference: '', savedSentence: '', savedTitle: ''};
const hit = (): ReencounterOccurrence => ({entry: term, sentence: 'Art matters.', root: {} as Document,
  ranges: [{startContainer: {isConnected: true}} as unknown as Range]});
const flush = async () => {for (let i = 0; i < 8; i += 1) await Promise.resolve();};
const deferred = <T>() => {let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function mount() {
  const controller = new AbortController(); const ctx = {isInvalid: false} as ContentScriptContext;
  const events = vi.spyOn(controller.signal, 'addEventListener');
  mountVocabularyReencounter(ctx, controller.signal);
  return {controller, ctx, callbacks: () => mocks.install.mock.calls.at(-1)![1], props: () => mocks.shadow.mock.calls.at(-1)![1].props,
    lateAbort: () => {const callback = events.mock.calls.find(call => call[0] === 'abort')?.[1]; if (typeof callback === 'function') callback(new Event('abort'));}};
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.config.vocabularyReencounterEnabled = true; mocks.extension.inIncognitoContext = false;
  mocks.add.mockReset();
  mocks.ui.shadowHost.isConnected = true;
  mocks.install.mockReturnValue(mocks.scanner); mocks.shadow.mockResolvedValue(mocks.ui); mocks.patch.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (message: {action: string}) => ({success: true, data: message.action === 'reencounterList' ? [term] : {...term, savedSentence: 'Old art sentence.'}}));
  vi.stubGlobal('document', {});
});
afterEach(() => {mocks.remove.mockReset(); unmountVocabularyReencounter(); vi.unstubAllGlobals();});

describe('reencounter content ownership and selective reads', () => {
  it('keeps a successor mounted if host cleanup synchronously starts the next activation',async()=>{
    const old=mount();await flush();old.callbacks().changed([hit()]);await flush();let successor:ReturnType<typeof mount>|undefined;
    mocks.ui.remove.mockImplementationOnce(()=>{unmountVocabularyReencounter();successor=mount();});
    old.controller.abort();await flush();mount();expect(mocks.install).toHaveBeenCalledTimes(2);
    successor!.controller.abort();mount();expect(mocks.install).toHaveBeenCalledTimes(3);
  });
  it('does not clear a newer list when the previous list rejects late',async()=>{
    const pending=deferred<unknown>();mocks.send.mockReturnValueOnce(pending.promise);mount();
    mocks.add.mock.calls[0][0]({type:'fluentReadVocabularyBookChanged'});await flush();
    pending.reject(Error('old list failed'));await flush();expect(mocks.scanner.setEntries).toHaveBeenCalledTimes(1);expect(mocks.scanner.setEntries).toHaveBeenLastCalledWith([term]);
  });
  it('ignores a queued collection notification after ordinary disposal', async () => {
    mount(); await flush();
    const listener = mocks.add.mock.calls[0][0];
    unmountVocabularyReencounter();
    const calls = mocks.send.mock.calls.length;
    listener({type: 'fluentReadVocabularyBookChanged'}); await flush();
    expect(mocks.send).toHaveBeenCalledTimes(calls);
    expect(mocks.scanner.dispose).toHaveBeenCalledTimes(1);
  });
  it('rolls back partial listener registration so the actual registry can retry', async () => {
    const listeners = new Set<unknown>();
    mocks.add.mockImplementationOnce(listener => {listeners.add(listener); throw new Error('revoked');})
      .mockImplementation(listener => {listeners.add(listener);});
    mocks.remove.mockImplementation(listener => {listeners.delete(listener);});
    const controller = new AbortController();
    const ctx = {isInvalid: false} as ContentScriptContext;
    const registry = createContentFeatureRegistry([{id: 'reencounter', isEnabled: () => true,
      mount: runtime => mountVocabularyReencounter(runtime.ctx, runtime.signal), unmount: unmountVocabularyReencounter}]);
    const runtime = {ctx, signal: controller.signal, isCurrent: () => true};
    expect((await registry.mountEnabled(runtime))[0].status).toBe('failed');
    expect(mocks.scanner.dispose).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0); expect(mocks.send).not.toHaveBeenCalled();
    expect((await registry.reconcileEnabled())[0].status).toBe('mounted'); await flush();
    expect(mocks.install).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    controller.abort(); registry.unmountAll();
    expect(mocks.scanner.dispose).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0);
  });
  it.each(['abort', 'invalid'] as const)('releases an activation invalidated during message registration: %s', async reason => {
    const controller = new AbortController(); const ctx = {isInvalid: false} as ContentScriptContext;
    mocks.add.mockImplementationOnce(() => {if (reason === 'abort') controller.abort(); else Object.assign(ctx, {isInvalid: true});});
    mountVocabularyReencounter(ctx, controller.signal); await flush();
    expect(mocks.scanner.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled();
    mount(); await flush(); expect(mocks.install).toHaveBeenCalledTimes(2); expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('does not mount in private, invalid, aborted or disabled contexts, and mounts only once', () => {
    mocks.extension.inIncognitoContext = true; mount(); mocks.extension.inIncognitoContext = false;
    mountVocabularyReencounter({isInvalid: true} as ContentScriptContext, new AbortController().signal);
    const aborted = new AbortController(); aborted.abort(); mountVocabularyReencounter({isInvalid: false} as ContentScriptContext, aborted.signal);
    mocks.config.vocabularyReencounterEnabled = false; mount(); expect(mocks.install).not.toHaveBeenCalled();
    mocks.config.vocabularyReencounterEnabled = true; mount(); mount(); expect(mocks.install).toHaveBeenCalledTimes(1);
  });
  it('loads minimal terms without a UI or AI request and reads one saved sentence only after opening', async () => {
    const task = mount(); await flush();
    expect(mocks.scanner.setEntries).toHaveBeenCalledWith([term]); expect(mocks.shadow).not.toHaveBeenCalled();
    const occurrence = hit(); task.callbacks().changed([occurrence]); await flush(); const props = task.props();
    expect(mocks.shadow).toHaveBeenCalledTimes(1); task.callbacks().changed([occurrence]); expect(mocks.shadow).toHaveBeenCalledTimes(1);
    task.callbacks().open(occurrence); await flush();
    expect(props.state.current).toBe(occurrence); expect(props.state.saved.savedSentence).toBe('Old art sentence.');
    task.callbacks().changed([occurrence]); expect(props.state.current).toBe(occurrence);
    expect(mocks.send.mock.calls.map(call => call[0].action)).toEqual(['reencounterList', 'reencounterGet']);
    props.close(); expect(props.state.current).toBeNull();
    task.controller.abort(); task.lateAbort(); expect(mocks.scanner.dispose).toHaveBeenCalledTimes(1); expect(mocks.ui.remove).toHaveBeenCalledTimes(1); expect(mocks.remove).toHaveBeenCalled();
  });
  it('prevents a late UI and pending term fetch from reviving a disposed activation', async () => {
    const reading = deferred<unknown>(); const shadow = deferred<unknown>(); mocks.send.mockReturnValue(reading.promise); mocks.shadow.mockReturnValue(shadow.promise);
    const task = mount(); task.callbacks().changed([hit()]); task.callbacks().changed([hit()]); expect(mocks.shadow).toHaveBeenCalledTimes(1);
    unmountVocabularyReencounter(); reading.resolve({success: true, data: [term]}); shadow.resolve(mocks.ui); await flush();
    expect(mocks.scanner.setEntries).not.toHaveBeenCalled(); expect(mocks.ui.remove).toHaveBeenCalledTimes(1);
    task.callbacks().changed([hit()]); expect(mocks.shadow).toHaveBeenCalledTimes(1);
  });
  it('handles list failures and refreshes across pages without allowing old responses to replace the newest terms', async () => {
    mocks.send.mockRejectedValueOnce(new Error('storage')); mount(); await flush(); expect(mocks.scanner.setEntries).toHaveBeenCalledWith([]);
    const old = deferred<unknown>(); mocks.send.mockReturnValueOnce(old.promise).mockResolvedValueOnce({success: true, data: [term]});
    const listener = mocks.add.mock.calls[0][0]; listener({type: 'other'}); listener(null);
    listener({type: 'fluentReadVocabularyBookChanged'}); listener({type: 'fluentReadVocabularyBookChanged'}); await flush();
    old.resolve({success: true, data: []}); await flush(); expect(mocks.scanner.setEntries.mock.calls.at(-1)?.[0]).toEqual([term]);
  });
  it('retains errors for explicit retry, discards old reads on close or a newer selection, and rejects malformed responses', async () => {
    const task = mount(); await flush(); task.callbacks().changed([hit()]); await flush(); const props = task.props();
    mocks.send.mockResolvedValueOnce({success: false, error: {message: 'deleted'}}); await props.open(hit()); expect(props.state.error).toBe('deleted');
    await props.retry(); expect(props.state.saved.savedSentence).toBe('Old art sentence.');
    mocks.send.mockResolvedValueOnce(undefined); await props.open(hit()); expect(props.state.error).toBe('收藏暂时无法读取');
    mocks.send.mockRejectedValueOnce('storage'); await props.open(hit()); expect(props.state.error).toBe('收藏暂时无法读取');
    const old = deferred<unknown>(); mocks.send.mockReturnValueOnce(old.promise); const reading = props.open(hit()); props.close();
    old.resolve({success: true, data: term}); await reading; expect(props.state.saved).toBeNull(); expect(props.state.loading).toBe(false);
    const rejected = deferred<unknown>(); mocks.send.mockReturnValueOnce(rejected.promise); const fail = props.open(hit()); await props.open(hit());
    rejected.reject(new Error('old error')); await fail; expect(props.state.error).toBe('');
    props.close(); props.retry(); expect(props.state.current).toBeNull();
  });
  it('clears stale cards on DOM removal and stops all processing for this visit without modifying a saved entry', async () => {
    const task = mount(); await flush(); const occurrence = hit(); task.callbacks().changed([occurrence]); await flush(); const props = task.props();
    await props.open(occurrence); (occurrence.ranges[0].startContainer as unknown as {isConnected: boolean}).isConnected = false;
    task.callbacks().changed([hit()]); expect(props.state.current).toBeNull();
    await props.open(hit()); task.callbacks().changed([]); expect(props.state.current).toBeNull();
    props.pause(); expect(props.state.paused).toBe(true); const calls = mocks.send.mock.calls.length;
    await props.open(hit()); mocks.add.mock.calls[0][0]({type: 'fluentReadVocabularyBookChanged'}); expect(mocks.send).toHaveBeenCalledTimes(calls);
    expect(mocks.send.mock.calls.every(call => ['reencounterList', 'reencounterGet'].includes(call[0].action))).toBe(true);
  });
  it('persists only the marking flag when permanently closing, and reports persistence failures', async () => {
    const task = mount(); await flush(); task.callbacks().changed([hit()]); await flush(); const props = task.props();
    await props.disable(); expect(mocks.patch).toHaveBeenCalledWith({vocabularyReencounterEnabled: false}, expect.any(Function));
    mocks.patch.mockRejectedValueOnce(new Error('failed')); await props.disable(); expect(props.state.error).toBe('failed');
    mocks.patch.mockRejectedValueOnce('oops'); await props.disable(); expect(props.state.error).toBe('设置保存失败');
    const failed = deferred<unknown>(); mocks.patch.mockReturnValueOnce(failed.promise); const closing = props.disable(); task.controller.abort(); failed.reject(new Error('late')); await closing; expect(props.state.error).toBe('');
  });
  it('copes with revoked message ports and rejected UI creation while still freeing host resources', async () => {
    mocks.shadow.mockRejectedValue(new Error('invalidated')); const task = mount(); await flush(); task.callbacks().changed([hit()]); await flush();
    mocks.remove.mockImplementation(() => {throw new Error('revoked');}); expect(() => unmountVocabularyReencounter()).not.toThrow(); expect(mocks.scanner.dispose).toHaveBeenCalled();
  });
  it('limits repairs when a hostile page repeatedly deletes the owned overlay', async () => {
    const task = mount(); await flush(); task.callbacks().changed([hit()]); await flush();
    mocks.ui.shadowHost.isConnected = false; task.callbacks().changed([hit()]); await flush();
    task.callbacks().changed([hit()]); await flush(); task.callbacks().changed([hit()]); await flush();
    expect(mocks.shadow).toHaveBeenCalledTimes(2); expect(mocks.ui.remove).toHaveBeenCalledTimes(2);
  });
});
