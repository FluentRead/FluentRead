/** 实际 userscript 通信、阅读处理器、会话编排和 GM 存储，模型边界使用可控流。 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import type {ReadingRequest, ReadingProgress, ReadingResponse} from '@/src/features/reading-assistant/types';

const state = vi.hoisted(() => ({
    config: {} as any,
    listeners: new Set<(config: any) => void>(),
    model: vi.fn(),
    lightweight: false,
    ready: Promise.resolve() as Promise<void>,
}));
vi.mock('@/src/services/config/store', () => ({
    config: state.config, get configReady() {return state.ready;},
    subscribeConfig: (callback: (config: any) => void) => {state.listeners.add(callback);return () => state.listeners.delete(callback);},
    saveConfig: vi.fn(), applyConfigHistoryAction: vi.fn(), getConfigRevision: () => 0,
    prepareConfigPatchRequest: vi.fn(), prepareConfigSaveRequest: vi.fn(), parseStoredConfig: vi.fn(),
    CONFIG_HISTORY_MESSAGE: 'configHistoryAction', CONFIG_PERSIST_MESSAGE: 'persistConfig',
    CONFIG_PERSIST_BATCH_MESSAGE: 'persistConfigBatch', CONFIG_STORAGE_KEY: 'local:config',
}));
vi.mock('@/src/app/translation/runtime', () => ({cleanupTranslationCache: vi.fn(), clearTranslationCache: vi.fn(), translateWithCache: vi.fn()}));
vi.mock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: vi.fn()}}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository: () => ({})}));
vi.mock('@/src/features/vocabulary/repository', () => ({vocabularyBook: {pruneUndo: async () => undefined}}));
vi.mock('ai', () => ({streamText: (...args: unknown[]) => state.model(...args), tool: (definition: unknown) => definition}));
vi.mock('@/src/services/harness/modelGateway', async original => ({
    ...await original<typeof import('@/src/services/harness/modelGateway')>(), createHarnessLanguageModel: () => ({}),
}));
vi.mock('@/src/services/harness/generation', async original => {
    const native = await original<typeof import('@/src/services/harness/generation')>();
    const lightweight = await import('@/userscript/readingGeneration');
    return {...native, createHarnessGenerator: (...args: Parameters<typeof native.createHarnessGenerator>) =>
        (state.lightweight ? lightweight.createHarnessGenerator : native.createHarnessGenerator)(...args)};
});
vi.mock('webextension-polyfill', async () => ({default: (await import('@/userscript/browser')).default}));

import browser, {setPlatformMessageHandler, resetPlatformMessageHandler, UNHANDLED_RUNTIME_MESSAGE, type UserscriptRuntimePort} from '@/userscript/browser';
import {createPlatformMessageHandler} from '@/userscript/platform';
import {createPlatformMessageHandler as createFullPlatformMessageHandler} from '@/userscript/platformFull';
import {streamReading, listHarnessSessions, getHarnessSession, clearHarnessSessions, saveLearningMemory, listLearningMemories} from '@/src/features/reading-assistant/client';

const values = new Map<string, unknown>();
const put = vi.fn((key: string, value: unknown) => {values.set(key, value);});
const get = vi.fn((key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback);
let page: EventTarget, doc: EventTarget;
let serial = 0;
const source = 'Practice helps every day.';
const request = (overrides: Partial<ReadingRequest> = {}): ReadingRequest => ({type: 'fluentReadHarness', action: 'run', requestId: `request-${++serial}`, intent: 'grammar', question: '', selection: {text: source, context: source, sentence: source}, ...overrides});
function generated(text = '练习有助于每天进步。', hold?: Promise<void>) {
    return {fullStream: (async function* () {yield {type: 'text-delta', id: 'answer', text};if (hold) await hold;})(),
        response: Promise.resolve({messages: [], modelId: 'controlled-reader'}), usage: Promise.resolve({}), finishReason: Promise.resolve('stop')};
}
function begin(input = request()) {
    const progress = vi.fn<(value: ReadingProgress) => void>(), result = vi.fn<(value: ReadingResponse) => void>(), error = vi.fn();
    const stream = streamReading(input, {progress, result, error});return {...stream, progress, result, error, input};
}
function event(type: string, persisted?: boolean) {
    const value = new Event(type); if (persisted !== undefined) Object.defineProperty(value, 'persisted', {value: persisted});return value;
}
function navigate(url: string) {vi.stubGlobal('location', {href: url});doc.dispatchEvent(event('fluentread-route-change'));}
function configure(patch: Record<string, unknown>) {Object.assign(state.config, patch);for (const callback of state.listeners) callback(state.config);}
async function completed(run: ReturnType<typeof begin>) {
    await vi.waitFor(() => expect(run.result).toHaveBeenCalledOnce());
    const value = run.result.mock.calls[0][0];expect(value.success).toBe(true);expect(run.error).not.toHaveBeenCalled();return value;
}
beforeEach(() => {
    resetPlatformMessageHandler(); values.clear();put.mockClear();get.mockClear();state.model.mockReset();state.listeners.clear();state.ready = Promise.resolve();state.lightweight = false;
    Object.assign(state.config, new Config());state.config.on = true;state.config.harness = {...state.config.harness, enabled: true, service: 'openai', model: 'reader', memoryEnabled: false};state.config.token.openai = 'controlled-fixture';
    page = new EventTarget();doc = new EventTarget();vi.stubGlobal('window', page);vi.stubGlobal('document', doc);vi.stubGlobal('location', {href: 'https://reading.test/article'});
    vi.stubGlobal('GM_info', undefined);vi.stubGlobal('GM', {getValue: get, setValue: put, deleteValue: (key: string) => values.delete(key), listValues: () => [...values.keys()]});
    vi.stubGlobal('indexedDB', {open: () => {throw new Error('Host IndexedDB must not be used');}});
    state.model.mockImplementation(() => generated());
});
afterEach(async () => {resetPlatformMessageHandler();await Promise.resolve();expect(state.listeners.size).toBe(0);vi.unstubAllGlobals();});

describe.each([['compact', createPlatformMessageHandler], ['full', createFullPlatformMessageHandler]] as const)('%s userscript public reading', (_name, createHandler) => {
    it('streams through the actual client and persists/restores only through GM', async () => {
        setPlatformMessageHandler(createHandler(vi.fn()));const run = begin();const response = await completed(run);
        expect(run.progress.mock.calls.some(([value]) => value.kind === 'text' && value.text.includes('练习'))).toBe(true);
        expect(response).toMatchObject({success: true, sessionId: expect.any(String), turnId: expect.any(String)});
        const sessions = await listHarnessSessions();expect(sessions.sessions).toHaveLength(1);expect(sessions.sessions[0].text).toBe(source);
        const session = await getHarnessSession(sessions.sessions[0].id);expect(session?.turns[0].answer).toBe('练习有助于每天进步。');
        expect(put).toHaveBeenCalled();expect(state.model).toHaveBeenCalledOnce();
        const follow = begin(request({sessionId: session!.id, anchorTurnId: session!.turns[0].id, question: 'Why?', selection: {text: 'forged replacement', context: '', sentence: ''}}));await completed(follow);
        expect(JSON.stringify(state.model.mock.calls[1][0].messages)).toContain(source);expect(JSON.stringify(state.model.mock.calls[1][0].messages)).not.toContain('forged replacement');
    });
    it('cancels immediately and drops late progress/result without discarding completed history', async () => {
        let release!: () => void;const hold = new Promise<void>(resolve => {release = resolve;});state.model.mockImplementation(() => generated('部分回答', hold));
        setPlatformMessageHandler(createHandler(vi.fn()));const run = begin();await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
        run.cancel();expect(state.model.mock.calls[0][0].abortSignal.aborted).toBe(true);release();await new Promise(resolve => setTimeout(resolve, 15));
        expect(run.result).not.toHaveBeenCalled();expect(run.error).not.toHaveBeenCalled();
        state.model.mockImplementation(() => generated());await completed(begin());expect((await listHarnessSessions()).sessions).toHaveLength(2);
    });
});

it.each(['route', 'pagehide', 'BFCache', 'replacement', 'config', 'disabled-site'] as const)('invalidates active reading on %s and rejects late work', async reason => {
    let release!: () => void;const hold = new Promise<void>(resolve => {release = resolve;});state.model.mockImplementation(() => generated('旧正文', hold));
    const handler = createPlatformMessageHandler(vi.fn());setPlatformMessageHandler(handler);const run = begin();await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
    const signal = state.model.mock.calls[0][0].abortSignal as AbortSignal;
    if (reason === 'route') navigate('https://reading.test/another');
    if (reason === 'pagehide') page.dispatchEvent(event('pagehide', false));
    if (reason === 'BFCache') page.dispatchEvent(event('pagehide', true));
    if (reason === 'replacement') setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));
    if (reason === 'config') configure({harness: {...state.config.harness, model: 'new-reader'}});
    if (reason === 'disabled-site') configure({disabledExtensionDomains: ['reading.test']});
    expect(signal.aborted).toBe(true);release();await new Promise(resolve => setTimeout(resolve, 15));expect(run.result).not.toHaveBeenCalled();expect(run.error).toHaveBeenCalledOnce();
    state.model.mockImplementation(() => generated());
    if (reason === 'BFCache') {const suspended = begin();expect(suspended.error).toHaveBeenCalledOnce();page.dispatchEvent(event('pageshow', true));await completed(begin());}
    else if (reason === 'pagehide') {const closed = begin();expect(closed.error).toHaveBeenCalledOnce();expect(state.listeners.size).toBe(0);}
    else if (reason === 'disabled-site') {const blocked = begin();await vi.waitFor(() => expect(blocked.result).toHaveBeenCalledOnce());expect(blocked.result.mock.calls[0][0]).toMatchObject({success: false, error: '当前网站已禁用扩展'});}
    else await completed(begin());
});

it('keeps settings-only memory management separate from page captures and ignores forged sender fields', async () => {
    setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));
    const memory = await saveLearningMemory({kind: 'lesson', content: 'Practice means repeated exercise.'});expect(memory.content).toContain('Practice');
    await expect(listLearningMemories()).rejects.toThrow();
    await expect(browser.runtime.sendMessage({type: 'fluentReadHarness', action: 'memory-list', sender: {url: 'fluentread-userscript://settings'}})).resolves.toMatchObject({success: false});
    navigate('https://reading.test/article#fluentread-userscript-settings/settings-learning');
    expect(await listLearningMemories()).toEqual([memory]);await clearHarnessSessions();expect((await listHarnessSessions()).sessions).toEqual([]);
});

it.each(['legacy', 'modern'] as const)('keeps %s manager private reading ephemeral and rejects history/memory access', async kind => {
    if (kind === 'legacy') vi.stubGlobal('GM_info', {isIncognito: true});else (globalThis.GM as UserscriptModernApi).info = {isPrivate: true};
    expect(browser.extension.inIncognitoContext).toBe(true);setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));
    const run = begin();const result = await completed(run);expect(result).not.toHaveProperty('sessionId');expect(put).not.toHaveBeenCalled();
    await expect(listHarnessSessions()).rejects.toThrow();await expect(saveLearningMemory({kind: 'note', content: 'private'})).rejects.toThrow();
});

it('queues only one cloned request during lazy wiring and releases all endpoints on handler replacement', async () => {
    let server!: UserscriptRuntimePort;const disposed = vi.fn();setPlatformMessageHandler(Object.assign(async () => UNHANDLED_RUNTIME_MESSAGE, {connect: (port: UserscriptRuntimePort) => {server = port;}, dispose: disposed}));
    expect(() => browser.runtime.connect({name: 'unapproved-port'})).toThrow();
    const port = browser.runtime.connect({name: 'fluentReadHarnessStream'}), receive = vi.fn(), disconnected = vi.fn();port.onDisconnect.addListener(disconnected);
    const message = {source: 'original'};port.postMessage(message);message.source = 'mutated';expect(() => port.postMessage({source: 'overflow'})).toThrow();
    server.onMessage.addListener(receive);expect(receive).toHaveBeenCalledWith({source: 'original'});
    const reply = vi.fn();port.onMessage.addListener(reply);server.postMessage({answer: 'visible'});expect(reply).toHaveBeenCalledWith({answer: 'visible'});
    resetPlatformMessageHandler();expect(disconnected).toHaveBeenCalledOnce();expect(disposed).toHaveBeenCalledOnce();expect(() => server.postMessage({answer: 'late'})).toThrow();
    const late = vi.fn();server.onDisconnect.addListener(late);expect(late).toHaveBeenCalledOnce();port.disconnect();expect(disconnected).toHaveBeenCalledOnce();
});

it.each(['cancel', 'route', 'dispose'] as const)('does not start a model when %s wins lazy initialization', async reason => {
    let ready!: () => void;state.ready = new Promise<void>(resolve => {ready = resolve;});
    const handler = createPlatformMessageHandler(vi.fn());setPlatformMessageHandler(handler);const run = begin();
    if (reason === 'cancel') run.cancel();
    if (reason === 'route') navigate('https://reading.test/new-route');
    if (reason === 'dispose') resetPlatformMessageHandler();
    ready();await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.model).not.toHaveBeenCalled();expect(run.result).not.toHaveBeenCalled();
    if (reason === 'cancel') expect(run.error).not.toHaveBeenCalled();else expect(run.error).toHaveBeenCalledOnce();
    if (reason !== 'dispose') await completed(begin());
});

it('rejects an old history message when navigation wins initialization and allows a fresh message on the new route', async () => {
    let ready!: () => void;state.ready = new Promise<void>(resolve => {ready = resolve;});
    setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));
    const previous = browser.runtime.sendMessage({type: 'fluentReadHarness', action: 'sessions-list'});
    navigate('https://reading.test/after-history-request');ready();
    await expect(previous).resolves.toMatchObject({success: false, cancelled: true, error: '阅读页面已失活，请重新打开阅读卡'});
    expect(state.model).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
    await expect(listHarnessSessions()).resolves.toMatchObject({sessions: []});
    expect(state.listeners.size).toBe(1);expect(state.model).not.toHaveBeenCalled();
});

it('retries a failed GM initialization and preserves one owned subscription', async () => {
    setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));
    (globalThis.GM as UserscriptModernApi).listValues = () => Promise.reject(new Error('Temporary GM read failure'));
    const failed = begin();await vi.waitFor(() => expect(failed.error).toHaveBeenCalledOnce());expect(state.model).not.toHaveBeenCalled();
    (globalThis.GM as UserscriptModernApi).listValues = () => [...values.keys()];
    await completed(begin());expect(state.listeners.size).toBe(1);
});

it('reports message initialization failure, rejects inactive and disabled reading, and leaves same-route work running', async () => {
    const handler = createPlatformMessageHandler(vi.fn());setPlatformMessageHandler(handler);
    (globalThis.GM as UserscriptModernApi).listValues = () => Promise.reject(new Error('Temporary GM read failure'));
    await expect(browser.runtime.sendMessage({type: 'fluentReadHarness', action: 'sessions-list'})).resolves.toMatchObject({success: false, error: '阅读助手初始化失败，请重试'});
    (globalThis.GM as UserscriptModernApi).listValues = () => [...values.keys()];
    configure({on: false});const disabled = begin();await vi.waitFor(() => expect(disabled.result).toHaveBeenCalledOnce());expect(disabled.result.mock.calls[0][0]).toMatchObject({success: false, error: '阅读理解已停用'});expect(state.model).not.toHaveBeenCalled();
    configure({on: true});let release!: () => void;const hold = new Promise<void>(resolve => {release = resolve;});state.model.mockImplementation(() => generated('still current', hold));
    const active = begin();await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
    page.dispatchEvent(event('hashchange'));doc.dispatchEvent(event('fluentread-route-change'));configure({harness: {...state.config.harness, hoverDelay: 300}});
    expect(state.model.mock.calls[0][0].abortSignal.aborted).toBe(false);release();await completed(active);
    page.dispatchEvent(event('pagehide', true));await expect(browser.runtime.sendMessage(request())).resolves.toMatchObject({success: false, cancelled: true});
    page.dispatchEvent(event('pageshow', true));navigate('https://reading.test/other');
    configure({disabledExtensionDomains: ['reading.test']});await expect(saveLearningMemory({kind: 'lesson', content: 'blocked'})).rejects.toThrow('无法访问学习笔记');
    handler.dispose();handler.dispose();await expect(handler(request())).resolves.toBe(UNHANDLED_RUNTIME_MESSAGE);
});

it('keeps failing port listeners isolated and closes a synchronously failed owner', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);let backend!: UserscriptRuntimePort;
    setPlatformMessageHandler(Object.assign(async () => undefined, {connect: (port: UserscriptRuntimePort) => {backend = port;}}));
    const client = browser.runtime.connect({name: 'fluentReadHarnessStream'}), received = vi.fn();
    client.onMessage.addListener(() => {throw new Error('listener failure');});client.onMessage.addListener(received);
    backend.postMessage({ok: true});expect(received).toHaveBeenCalledWith({ok: true});expect(warning).toHaveBeenCalledOnce();
    setPlatformMessageHandler(Object.assign(async () => undefined, {connect: () => {throw new Error('owner failure');}}));
    const failed = browser.runtime.connect({name: 'fluentReadHarnessStream'});const disconnected = vi.fn();failed.onDisconnect.addListener(disconnected);expect(disconnected).toHaveBeenCalledOnce();
    const ignored = vi.fn();failed.onMessage.addListener(ignored);expect(ignored).not.toHaveBeenCalled();
    expect(() => browser.runtime.connect()).toThrow();warning.mockRestore();
});

it('runs the real lightweight SSE transport through the public client, private port, conversation and GM history', async () => {
    state.lightweight = true;const {setRuntimeFetch}=await import('@/src/platform/http/runtime');
    const fetcher=vi.fn(async ()=>new Response('data: {"choices":[{"delta":{"content":"练习有助于每天进步。"},"finish_reason":"stop"}]}\n\n', {headers:{'content-type':'text/event-stream'}}));
    setRuntimeFetch(fetcher);
    try {
        setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));const run=begin();const result=await completed(run);if(!result.success)throw new Error('Expected successful reading');
        expect(state.model).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledOnce();
        const session=await getHarnessSession(result.sessionId!);expect(session?.turns[0].answer).toBe('练习有助于每天进步。');
        expect(run.progress.mock.calls.some(([value])=>value.kind==='text'&&value.text==='练习有助于每天进步。')).toBe(true);
    } finally {setRuntimeFetch();}
});

it('cancels a real lightweight response body from the public reading handle and rejects its late data', async () => {
    state.lightweight=true;const {setRuntimeFetch}=await import('@/src/platform/http/runtime');
    const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分讲解"}}]}\n\n'));},cancel});
    setRuntimeFetch(async()=>new Response(body));
    try {
        setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));const run=begin();
        await vi.waitFor(()=>expect(run.progress.mock.calls.some(([value])=>value.kind==='text'&&value.text==='部分讲解')).toBe(true));
        run.cancel();await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());expect(body.locked).toBe(false);
        expect(run.result).not.toHaveBeenCalled();expect(run.error).not.toHaveBeenCalled();expect(state.model).not.toHaveBeenCalled();
    } finally {setRuntimeFetch();}
});

it('rejects an explicit null context-tool argument at the actual shared execution boundary', async () => {
    state.lightweight=true;const {setRuntimeFetch}=await import('@/src/platform/http/runtime');
    const fetcher=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"null-args","function":{"name":"read_context","arguments":"null"}}]},"finish_reason":"tool_calls"}]}\n\n'));
    setRuntimeFetch(fetcher);
    try {
        setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));const run=begin();await vi.waitFor(()=>expect(run.result).toHaveBeenCalledOnce());
        expect(run.result.mock.calls[0][0]).toMatchObject({success:false,error:'理解请求未完成，请重试'});
        expect(fetcher).toHaveBeenCalledOnce();expect(run.error).not.toHaveBeenCalled();expect(state.model).not.toHaveBeenCalled();
    } finally {setRuntimeFetch();}
});

it('rejects a memory save when navigation wins during the actual GM generation read', async () => {
    setPlatformMessageHandler(createPlatformMessageHandler(vi.fn()));await completed(begin());await saveLearningMemory({kind:'note',content:'Existing memory'});
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});let pending=true;
    vi.stubGlobal('GM',{getValue:async(key:string,fallback:unknown)=>{if(pending&&key.startsWith('fluentread:reading:v1:operation:memory-save:')){pending=false;entered();await hold;}return get(key,fallback);},setValue:put,deleteValue:(key:string)=>values.delete(key),listValues:()=>[...values.keys()]});
    const writes=put.mock.calls.length,saving=saveLearningMemory({kind:'note',content:'Do not save after leaving'});const rejected=expect(saving).rejects.toThrow('无法访问学习笔记');
    await started;navigate('https://reading.test/new-document');release();await rejected;expect(put).toHaveBeenCalledTimes(writes);
});
