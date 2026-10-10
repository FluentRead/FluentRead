import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Real Vue runtime-dom and client templates; only browser, config and rendering environment ports are controlled.
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: (window as any)[name]});
    }
    const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (fn: FrameRequestCallback) => {frames.set(++nextFrame, fn); return nextFrame;}});
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {configurable: true, value: (id: number) => frames.delete(id)});
    Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: class {observe() {} unobserve() {} disconnect() {}}});
    Object.defineProperty(globalThis, 'matchMedia', {configurable: true, value: () => ({matches: false})});
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'Mac', clipboard: {writeText: async () => undefined}}});
    return {document, frames};
});
const external = vi.hoisted(() => ({
    ports: [] as any[], config: {} as any, subscribers: new Set<(value: any) => void>(),
    connect: vi.fn(), sendMessage: vi.fn(), onConnect: new Set<(port: any) => void>(),
    removed: new Set<Function>(), updated: new Set<Function>(), alarms: new Set<Function>(),
    requests: [] as Array<{url: string; headers: Headers; body: any; signal: AbortSignal; settle: () => void; complete: () => void}>,
}));
vi.mock('webextension-polyfill', () => ({default: {extension: {inIncognitoContext: false}, runtime: {
    id: 'fixture', onConnect: {addListener: (fn: (port: any) => void) => external.onConnect.add(fn)},
    connect: external.connect, sendMessage: external.sendMessage, getURL: (path: string) => `chrome-extension://fixture/${path}`,
}, tabs: {onRemoved: {addListener: (fn: Function) => external.removed.add(fn)}, onUpdated: {addListener: (fn: Function) => external.updated.add(fn)}},
alarms: {create: async () => undefined, onAlarm: {addListener: (fn: Function) => external.alarms.add(fn)}}}}));
vi.mock('@/src/services/config/store', () => ({
    config: external.config, configReady: Promise.resolve(),
    subscribeConfig: (listener: (value: any) => void) => {external.subscribers.add(listener); return () => external.subscribers.delete(listener);},
    requestConfigPatch: async (patch: any) => {Object.assign(external.config, patch); external.subscribers.forEach(listener => listener({...external.config}));},
}));
vi.mock('@/src/ui/i18n', async () => {
    const {ref} = await import('vue');
    return {useUiI18n: () => ({t: (key: string) => key, translateLegacy: (value: string) => value, language: ref('zh-CN'), bundleRevision: ref(0)})};
});
vi.mock('element-plus', () => ({ElMessageBox: {confirm: async () => undefined}}));
vi.mock('element-plus/es/components/message-box/style/css', () => ({}));
vi.mock('@/src/platform/storage/harnessSessionRepository', () => ({harnessSessionRepository: {
    recoverInterrupted: async () => undefined, prune: async () => 0, captureGeneration: (sessionId: string) => ({epoch: 0, generation: 0, sessionId}),
    upsertTurn: async () => true, get: async () => null, list: async () => ({sessions: [], hasMore: false}), delete: async () => undefined, clear: async () => undefined,
}}));
vi.mock('@/src/platform/storage/learningMemoryRepository', () => ({learningMemoryRepository: {list: async () => []}}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({modelUsageRepository: {captureGeneration: () => 0, recordMany: async () => undefined}}));

import {createApp, h, nextTick, reactive, type App, type Component} from 'vue';
import {Config} from '@/src/core/config/model';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';
import {runHarnessLoop, type HarnessGenerateInput} from '@/src/core/harness/loop';
import {rankRecords, explainRecord, type MemoryRecord} from '@/src/core/harness/memorySearch';
import {readMemory} from '@/src/services/harness/memoryRecall';
import {createHarnessConversationRuntime} from '@/src/services/harness/conversation';
import {streamReading} from '@/src/features/reading-assistant/client';
import {streamWriting} from '@/src/features/writing-assistant/client';
import {createWritingHandler} from '@/src/features/writing-assistant/background';
import type {ReadingRequest, ReadingProgress} from '@/src/features/reading-assistant/types';
import type {WritingRequest} from '@/src/features/writing-assistant/types';
import type {HarnessSessionStore} from '@/src/services/harness/sessionTypes';
import ReadingPanel from '@/src/features/reading-assistant/ui/ReadingPanel.vue';
import ReadingAnswer from '@/src/features/reading-assistant/ui/ReadingAnswer.vue';
import WritingPanel from '@/src/features/writing-assistant/ui/WritingPanel.vue';
import {installHarnessBackgroundRuntime} from '@/src/app/background/harnessRuntime';
import {installWritingBackgroundRuntime} from '@/src/app/background/writingRuntime';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

function event<T extends (...args: any[]) => void>() {
    const listeners = new Set<T>();
    return {addListener: (fn: T) => listeners.add(fn), removeListener: (fn: T) => listeners.delete(fn), fire: (...args: Parameters<T>) => [...listeners].forEach(fn => fn(...args)), listeners};
}
function makePort(name = 'fluentReadHarnessStream', sender?: any) {
    const onMessage = event<(value: any) => void>(), onDisconnect = event<() => void>();
    return {name, sender, onMessage, onDisconnect, postMessage: vi.fn(), disconnect: vi.fn(() => onDisconnect.fire())};
}
const apps = new Set<App>();
function mount(component: Component, values: any) {
    const props = reactive(values); const host = dom.document.createElement('div'); dom.document.body.append(host);
    const app = createApp({render: () => h(component, props)}); app.config.warnHandler = () => undefined; app.mount(host); apps.add(app);
    return {host, props, app};
}
async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick();}
function button(host: Element, label: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
    if (!result) throw new Error(`Missing actual client button: ${label}`);
    return result;
}
function readingRequest(requestId = 'reading-fixture'): ReadingRequest {
    return {type: 'fluentReadHarness', action: 'run', requestId, intent: 'meaning', selection: {text: 'First source.', context: '', sentence: 'First source.'}, question: ''};
}
const writingRequest: WritingRequest = {type: 'fluentReadWriting', action: 'run', requestId: 'writing-fixture', intent: 'draft', draft: '', context: '', instruction: 'Write a reply', language: 'en', tone: 'natural', history: []};
const result = {success: true as const, text: 'Finished', service: 'deepseek', model: 'fixture-model'};
const generated = {assistant: {role: 'assistant' as const, content: [{type: 'text', text: 'Finished'}]}, text: 'Finished', toolCalls: []};

beforeEach(() => {
    Object.assign(external.config, new Config(), {on: true});
    external.config.service = 'deepseek'; external.config.writing = {...external.config.writing, enabled: true, referenceLanguage: 'off'};
    external.ports = []; external.sendMessage.mockReset().mockResolvedValue({success: true});
    external.connect.mockReset().mockImplementation(({name}) => {const port = makePort(name); external.ports.push(port); return port;});
    external.requests = [];
    setRuntimeFetch((input, init) => new Promise((resolve, reject) => {
        const signal = init!.signal as AbortSignal;
        const abort = () => {signal.removeEventListener('abort', abort); reject(new DOMException('fixture request cancelled', 'AbortError'));};
        const complete = () => {
            signal.removeEventListener('abort', abort);
            const chunk = {id: 'fixture', created: 0, model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: 'Finished'}, finish_reason: 'stop'}]};
            resolve(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {headers: {'Content-Type': 'text/event-stream'}}));
        };
        external.requests.push({url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal, settle: abort, complete});
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
    }));
});
afterEach(async () => {
    apps.forEach(app => app.unmount()); apps.clear(); await flush();
    external.config.on = false; external.subscribers.forEach(listener => listener(external.config));
    external.requests.forEach(request => request.settle());
    external.ports.forEach(port => port.disconnect()); dom.document.body.replaceChildren(); dom.frames.clear();
    external.subscribers.clear(); external.onConnect.clear(); external.removed.clear(); external.updated.clear(); external.alarms.clear();
    setRuntimeFetch();
    vi.useRealTimers(); vi.restoreAllMocks();
});

describe('audit49B production cancellation and ownership', () => {
    it('closes the model progress lease after a successful loop', async () => {
        let captured!: HarnessGenerateInput; const progress = vi.fn();
        await expect(runHarnessLoop({generate: async input => {captured = input; input.onText?.('Finished'); return generated;}, executeTool: async () => '', system: '', user: 'source', tools: [], signal: new AbortController().signal, onText: progress})).resolves.toMatchObject({text: 'Finished'});
        captured.onText?.('late');
        expect(progress.mock.calls).toEqual([['Finished']]);
    });
    it('aborts pending model work and suppresses late progress after the bounded timeout', async () => {
        vi.useFakeTimers(); let captured!: HarnessGenerateInput; const progress = vi.fn();
        const work = runHarnessLoop({generate: async input => {captured = input; return new Promise(() => {});}, executeTool: async () => '', system: '', user: 'source', tools: [], timeoutMs: 1000, signal: new AbortController().signal, onText: progress});
        const outcome = expect(work).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(1000); await outcome;
        expect(captured.signal.aborted).toBe(true); captured.onText?.('late'); expect(progress).not.toHaveBeenCalled();
    });
    it('rejects a pre-cancelled memory read before touching the repository port', async () => {
        const controller = new AbortController(); controller.abort(); const recall = vi.fn(async () => []);
        await expect(readMemory({recall}, 'grammar', controller.signal)).rejects.toThrow('取消'); expect(recall).not.toHaveBeenCalled();
    });
    it('removes a live memory read abort listener after cancellation and ignores late storage settlement', async () => {
        const controller = new AbortController(); let settle!: (value: []) => void;
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const work = readMemory({recall: () => new Promise(resolve => {settle = resolve;})}, 'grammar', controller.signal);
        const outcome = expect(work).rejects.toThrow('取消'); controller.abort(); await outcome; settle([]);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
    it('replaces same-document writing work when all four slots are occupied', async () => {
        const pending: Array<{signal: AbortSignal; settle: (value: typeof result) => void}> = [];
        const handler = createWritingHandler({extensionId: 'fixture', optionsUrl: 'chrome-extension://fixture/options.html', ready: Promise.resolve(), eligibility: () => undefined,
            run: (_request, signal) => new Promise(resolve => pending.push({signal, settle: resolve})),
        });
        const ports = [1, 2, 3, 4].map(id => makePort('fluentReadWritingStream', {id: 'fixture', url: 'https://github.com/a/b/issues/1', tab: {id}, frameId: 0, documentId: `doc-${id}`}));
        ports.forEach((port, index) => {handler.connect(port); port.onMessage.fire({...writingRequest, requestId: `first-${index}`});}); await flush();
        const replacement = makePort('fluentReadWritingStream', ports[0].sender); handler.connect(replacement); replacement.onMessage.fire({...writingRequest, requestId: 'replacement'}); await flush();
        try {
            expect(pending).toHaveLength(5); expect(pending[0].signal.aborted).toBe(true);
            expect(pending.slice(1, 4).every(work => !work.signal.aborted)).toBe(true);
            expect(ports[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({response: expect.objectContaining({cancelled: true})}));
        } finally {handler.cancelAll(); pending.forEach(work => work.settle(result)); await flush();}
    });
    it('uses stable sender identity despite object property order and tab title metadata', async () => {
        const pending: Array<{signal: AbortSignal; settle: (value: typeof result) => void}> = [];
        const handler = createWritingHandler({extensionId: 'fixture', optionsUrl: 'chrome-extension://fixture/options.html', ready: Promise.resolve(), eligibility: () => undefined,
            run: (_request, signal) => new Promise(resolve => pending.push({signal, settle: resolve})),
        });
        const first = makePort('fluentReadWritingStream', {id: 'fixture', url: 'https://github.com/a/b/issues/1', tab: {id: 1, title: 'old'}, documentId: 'doc'});
        const second = makePort('fluentReadWritingStream', {documentId: 'doc', tab: {title: 'new', id: 1}, url: 'https://github.com/a/b/issues/1', id: 'fixture'});
        handler.connect(first); first.onMessage.fire(writingRequest); await flush(); handler.connect(second); second.onMessage.fire({...writingRequest, requestId: 'second'}); await flush();
        try {expect(pending[0].signal.aborted).toBe(true); expect(pending[1].signal.aborted).toBe(false);}
        finally {handler.cancelAll(); pending.forEach(work => work.settle(result)); await flush();}
    });
    it('does not reschedule persistence or alter a completed answer from a late runtime callback', async () => {
        vi.useFakeTimers(); let publish!: (value: ReadingProgress) => void;
        const writes: any[] = []; const store: HarnessSessionStore = {
            captureGeneration: sessionId => ({epoch: 0, generation: 0, sessionId}),
            upsertTurn: async (_session, turn) => {writes.push({...turn}); return true;},
            get: async () => null, list: async () => ({sessions: [], hasMore: false}), delete: async () => undefined, clear: async () => undefined, prune: async () => 0,
        };
        const progress = vi.fn(); const runtime = createHarnessConversationRuntime({store, preferences: () => ({contextMode: 'selection', maxContextChars: 1500}), id: () => crypto.randomUUID(), runtime: {run: async (_request, _signal, callback) => {publish = callback!; publish({kind: 'text', text: 'Partial'}); return result;}}});
        await expect(runtime.run(readingRequest(), new AbortController().signal, progress)).resolves.toMatchObject(result);
        const count = writes.length, progressCount = progress.mock.calls.length;
        publish({kind: 'text', text: 'late'}); await vi.advanceTimersByTimeAsync(501);
        expect(writes).toHaveLength(count); expect(writes.at(-1)).toMatchObject({status: 'completed', answer: 'Finished'}); expect(progress).toHaveBeenCalledTimes(progressCount);
    });
});

describe('audit49B real browser-stream clients', () => {
    it('reading releases listeners on completion before invoking a throwing consumer', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            start({progress: vi.fn(), result: () => {throw new Error('consumer');}}); const port = external.ports.at(-1);
            expect(() => port.onMessage.fire({type: 'result', requestId: request.requestId, response: result})).toThrow('consumer');
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce();
        });
    it('reading releases listeners on explicit cancellation and ignores late delivery', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            const progress = vi.fn(), done = vi.fn(); const cancel = start({progress, result: done}); const port = external.ports.at(-1);
            cancel(); cancel(); port.onMessage.fire({type: 'progress', requestId: request.requestId, progress: {kind: 'text', text: 'late'}});
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
        });
    it('reading ignores malformed or unknown envelopes and remains able to receive the real result', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            const done = vi.fn(); start({progress: vi.fn(), result: done}); const port = external.ports.at(-1);
            for (const value of [null, false, {}, {type: 'unknown', requestId: request.requestId}]) expect(() => port.onMessage.fire(value)).not.toThrow();
            expect(done).not.toHaveBeenCalled(); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); expect(done).toHaveBeenCalledWith(result);
        });
    it('writing releases listeners on completion before invoking a throwing consumer', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            start({progress: vi.fn(), result: () => {throw new Error('consumer');}}); const port = external.ports.at(-1);
            expect(() => port.onMessage.fire({type: 'result', requestId: request.requestId, response: result})).toThrow('consumer');
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce();
        });
    it('writing releases listeners on explicit cancellation and ignores late delivery', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            const progress = vi.fn(), done = vi.fn(); const cancel = start({progress, result: done}); const port = external.ports.at(-1);
            cancel(); cancel(); port.onMessage.fire({type: 'progress', requestId: request.requestId, progress: {kind: 'text', text: 'late'}});
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
        });
    it('writing ignores malformed or unknown envelopes and remains able to receive the real result', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            const done = vi.fn(); start({progress: vi.fn(), result: done}); const port = external.ports.at(-1);
            for (const value of [null, false, {}, {type: 'unknown', requestId: request.requestId}]) expect(() => port.onMessage.fire(value)).not.toThrow();
            expect(done).not.toHaveBeenCalled(); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); expect(done).toHaveBeenCalledWith(result);
        });
});

describe('audit49B actual client SFC interactions', () => {
    const panelProps = () => ({selection: {text: 'First source.', context: '', sentence: 'First source.'}, preferences: {...DEFAULT_HARNESS_PREFERENCES, enabled: true}, active: true, targetLanguage: 'zh-Hans', sourceLanguage: 'en', vocabularyEnabled: false, privateContext: false, animations: false});
    const sentenceTable = (rows: string) => `| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n${rows}`;
    const sentenceRows = '| Cats | noun | subject | 猫 |\n| chase | verb | predicate | 追赶 |\n| mice | noun | object | 老鼠 |';
    it('puts the first grounded structure and its adjacent heading before the explanation without duplicating either', async () => {
        const text = `### 主干\n主干说明保留。\n\n| Term | Meaning |\n| --- | --- |\n| cats | 猫 |\n\n### 结构分析\n${sentenceTable(sentenceRows)}\n\n### 关键点\n关键说明保留。`;
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text}); await flush();
        const answer = host.querySelector('[data-reading-answer]')!;
        expect([...answer.querySelectorAll('h3, h4')].map(node => node.textContent)).toEqual(['结构分析', '主干', '关键点']);
        expect(answer.querySelectorAll('.fr-sentence-analysis')).toHaveLength(1);
        expect(answer.querySelectorAll('table')).toHaveLength(1);
        expect(answer.querySelector('table')?.textContent).toContain('TermMeaningcats猫');
        const visibleText = answer.textContent!;
        expect(visibleText.indexOf('Cats')).toBeLessThan(visibleText.indexOf('主干说明保留。'));
        expect(visibleText.indexOf('主干说明保留。')).toBeLessThan(visibleText.indexOf('Term'));
        expect(visibleText.indexOf('Term')).toBeLessThan(visibleText.indexOf('关键说明保留。'));
    });
    it('adds a structure title for a grounded table without an adjacent heading and keeps its preceding paragraph', async () => {
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text: `先读主干说明。\n\n${sentenceTable(sentenceRows)}\n\n后续说明。`}); await flush();
        const answer = host.querySelector('[data-reading-answer]')!;
        expect([...answer.querySelectorAll('h3, h4')].map(node => node.textContent)).toEqual(['结构分析']);
        expect(answer.querySelectorAll('.fr-sentence-analysis')).toHaveLength(1);
        expect(answer.querySelectorAll('table')).toHaveLength(0);
        expect(answer.textContent!.indexOf('Cats')).toBeLessThan(answer.textContent!.indexOf('先读主干说明。'));
        expect(answer.textContent!.indexOf('先读主干说明。')).toBeLessThan(answer.textContent!.indexOf('后续说明。'));
    });
    it.each([
        ['list', '- 主语对应 Cats。\n- 谓语对应 chase。', ['结构分析', '主干', '成分', '关键点'], '主语对应 Cats。'],
        ['nested heading', '#### 主语补充\nCats 表示动作执行者。', ['结构分析', '主干', '成分', '主语补充', '关键点'], '主语补充'],
    ])('keeps the original section heading with its remaining %s while promoting only the structure', async (_kind, continuation, headings, nextText) => {
        const text = `### 主干\n主干原有解释。\n\n### 成分\n${sentenceTable(sentenceRows)}\n\n${continuation}\n\n### 关键点\n关键原有解释。`;
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text}); await flush();
        const answer = host.querySelector('[data-reading-answer]')!;
        expect(answer.firstElementChild?.classList.contains('fr-reading-structure')).toBe(true);
        expect(answer.querySelector('.fr-reading-structure h3')?.textContent).toBe('结构分析');
        expect([...answer.querySelectorAll('h3, h4')].map(node => node.textContent)).toEqual(headings);
        const originalHeading = [...answer.children].find(node => node.textContent === '成分')!;
        expect(originalHeading.nextElementSibling?.textContent).toContain(nextText);
        expect(answer.querySelectorAll('.fr-sentence-analysis')).toHaveLength(1);
        expect(answer.querySelector('table')).toBeNull();
        expect(answer.textContent!.indexOf('主干原有解释。')).toBeLessThan(answer.textContent!.indexOf('成分'));
        expect(answer.textContent!.indexOf('成分')).toBeLessThan(answer.textContent!.indexOf('关键原有解释。'));
    });
    it.each([
        ['ordinary', '| Term | Meaning |\n| --- | --- |\n| cats | 猫 |'],
        ['mismatched source', sentenceTable('| birds | noun | subject | 鸟 |')],
        ['incomplete streamed row', sentenceTable('| Cats | noun | subject | 猫 |\n| chase | verb |')],
        ['reordered fragments', sentenceTable('| mice | noun | object | 老鼠 |\n| Cats | noun | subject | 猫 |')],
    ])('retains the original answer order for a %s table that cannot anchor to the source', async (_kind, table) => {
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text: `### 主干\n原始主干说明。\n\n### 结构分析\n${table}\n\n### 关键点\n原始关键说明。`}); await flush();
        const answer = host.querySelector('[data-reading-answer]')!;
        expect([...answer.querySelectorAll('h3, h4')].map(node => node.textContent)).toEqual(['主干', '结构分析', '关键点']);
        expect(answer.querySelector('.fr-sentence-analysis')).toBeNull();
        expect(answer.querySelectorAll('table')).toHaveLength(1);
        expect(answer.textContent!.indexOf('原始主干说明。')).toBeLessThan(answer.textContent!.indexOf('结构分析'));
        expect(answer.textContent!.indexOf('结构分析')).toBeLessThan(answer.textContent!.indexOf('原始关键说明。'));
    });
    it('keeps a selected structure fragment mounted while streamed complete rows and preceding explanation blocks grow', async () => {
        const firstRows = '| Cats | noun | subject | 猫 |\n| chase | verb | predicate | 追赶 |';
        const {host, props} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text: `### 主干\n先读主干。\n\n### 结构分析\n${sentenceTable(firstRows)}`}); await flush();
        const selected = host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button')[1];
        selected.click(); await flush();
        expect(selected.getAttribute('aria-pressed')).toBe('true');
        props.text = `### 主干\n先读主干。\n\n### 成分\n- 正文中的新增解释。\n\n### 结构分析\n${sentenceTable(sentenceRows.replace('追赶', '主动追赶'))}\n\n### 关键点\n正在生成的新说明。`;
        await flush();
        expect(host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button')[1]).toBe(selected);
        expect(selected.getAttribute('aria-pressed')).toBe('true');
        expect(selected.getAttribute('tabindex')).toBe('0');
        expect(host.querySelector('.fr-sentence-detail-heading strong')?.textContent).toBe('chase');
        expect(host.querySelector('.fr-sentence-meaning')?.textContent).toBe('主动追赶');
        expect([...host.querySelectorAll('h3, h4')].map(node => node.textContent)).toEqual(['结构分析', '主干', '成分', '关键点']);
    });
    it('shows one unknown label while keeping explicit custom word classes and concise role descriptions', async () => {
        const rows = '| Cats | unknown | unknown | 猫 |\n| chase | custom-pos | 时间状语，修饰动作 | 追赶 |\n| mice | custom-pos | custom-pos | 老鼠 |';
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text: sentenceTable(rows)}); await flush();
        expect([...host.querySelectorAll('.fr-sentence-token-meta')].map(node => node.textContent)).toEqual(['其他', '时间状语 · custom-pos', 'custom-pos']);
        expect(host.textContent).not.toContain('其他 · 其他');
        host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button')[1].click(); await flush();
        expect(host.querySelector('.fr-sentence-role')?.textContent).toContain('时间状语，修饰动作');
        expect(host.querySelector('.fr-sentence-detail-heading')?.textContent).toContain('custom-pos');
    });
    it('filters generic unknown dimensions before localization and translates the single fallback label', async () => {
        const i18n = await import('@/src/ui/i18n');
        const original = i18n.useUiI18n();
        vi.spyOn(i18n, 'useUiI18n').mockImplementation(() => ({...original, translateLegacy: value => value === '其他' ? 'Autre' : value === '主语' ? 'Sujet' : value}));
        const rows = '| Cats | unknown | subject | 猫 |\n| chase | unknown | unknown | 追赶 |\n| mice | other | 其他 | 老鼠 |';
        const {host} = mount(ReadingAnswer, {sourceText: 'Cats chase mice.', text: sentenceTable(rows)}); await flush();
        expect([...host.querySelectorAll('.fr-sentence-token-meta')].map(node => node.textContent)).toEqual(['Sujet', 'Autre', 'Autre']);
        expect(host.querySelector('.fr-sentence-detail-heading span')?.textContent).toBe('Autre');
        expect(host.textContent).not.toContain('Sujet · Autre');
        expect(host.textContent).not.toContain('Autre · Autre');
    });
    it('keeps a long unannotated source tail outside the annotation unit and reconstructs the entire source verbatim', async () => {
        const remaining = 'chase small animals through the garden while the reader watches a sentence that is only partly annotated. '.repeat(3);
        const source = `Cats, ${remaining}`;
        const {host} = mount(ReadingAnswer, {sourceText: source, text: sentenceTable('| Cats | noun | subject | 猫 |')}); await flush();
        const tokens = host.querySelector('.fr-sentence-tokens')!;
        const unit = tokens.querySelector('.fr-sentence-unit')!;
        expect(tokens.querySelectorAll('.fr-sentence-unit')).toHaveLength(1);
        expect(unit.querySelector('.fr-sentence-gap')?.textContent).toBe(', ');
        expect(unit.textContent).not.toContain('chase');
        const prose = [...tokens.querySelectorAll('.fr-sentence-gap')].find(node => node.textContent === remaining)!;
        expect(prose).toBeDefined();
        expect(prose.parentElement).toBe(tokens);
        const sourceCopy = tokens.cloneNode(true) as Element;
        sourceCopy.querySelectorAll('.fr-sentence-token-meta').forEach(node => node.remove());
        expect(sourceCopy.textContent).toBe(source);
    });
    it('keeps punctuation with the preceding structure unit and supports keyboard navigation through the wrapped buttons', async () => {
        const source = 'When ready, Cats chase mice.';
        const rows = '| When ready | phrase | 时间状语 | 准备好时 |\n' + sentenceRows;
        const {host} = mount(ReadingAnswer, {sourceText: source, text: sentenceTable(rows)}); await flush();
        const units = host.querySelectorAll('.fr-sentence-unit');
        expect(units).toHaveLength(4);
        expect(units[0].textContent).toContain(',');
        expect(units[0].textContent).not.toContain('Cats');
        expect(units[3].textContent).toContain('.');
        const buttons = host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button');
        const focus = vi.spyOn(buttons[3], 'focus');
        const end = new Event('keydown', {bubbles: true, cancelable: true});
        Object.defineProperty(end, 'key', {value: 'End'});
        buttons[0].dispatchEvent(end); await flush();
        expect(end.defaultPrevented).toBe(true);
        expect(buttons[3].getAttribute('aria-pressed')).toBe('true');
        expect(buttons[3].getAttribute('tabindex')).toBe('0');
        expect(focus).toHaveBeenCalledWith({preventScroll: true});
    });
    it('starts the same learning action for a new selection without reusing the old turn or draft question', async () => {
        const {host, props} = mount(ReadingPanel, panelProps()); await flush(); const first = external.ports[0];
        const old = first.postMessage.mock.calls[0][0]; first.onMessage.fire({type: 'result', requestId: old.requestId, response: {...result, turnId: 'old-turn', sessionId: 'old-session'}}); await flush();
        const input = host.querySelector<HTMLInputElement>('input[aria-label="继续追问"]')!; input.value = 'Question about old source'; input.dispatchEvent(new Event('input'));
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        expect(external.ports).toHaveLength(2); const next = external.ports[1].postMessage.mock.calls[0][0];
        expect(next.selection.text).toBe('Second source.'); expect(next.question).toBe(''); expect(next.history).toEqual([]); expect(next.sessionId).toBeUndefined(); expect(next.anchorTurnId).toBeUndefined();
    });
    it('cancels an old selection stream and leaves a new selection free of stopped state and late output', async () => {
        const {host, props} = mount(ReadingPanel, panelProps()); await flush(); const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush();
        expect(first.disconnect).toHaveBeenCalledOnce(); first.onMessage.fire({type: 'progress', requestId: old.requestId, progress: {kind: 'text', text: 'stale answer'}});
        button(host, '读懂').click(); await flush(); expect(external.ports).toHaveLength(2); expect(host.textContent).not.toContain('stale answer');
    });
    it('keeps a keyboard entry point when streamed sentence annotations shrink for the same source', async () => {
        const source = 'Cats chase mice.';
        const table = (rows: string) => `| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n${rows}`;
        const {host, props} = mount(ReadingAnswer, {sourceText: source, text: table('| Cats | noun | subject | Cats |\n| chase | verb | predicate | chase |\n| mice | noun | object | mice |')}); await flush();
        host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button')[2].click(); await flush();
        props.text = table('| Cats | noun | subject | Cats |'); await flush();
        const active = host.querySelector<HTMLButtonElement>('.fr-sentence-tokens button[tabindex="0"]'); expect(active?.textContent).toContain('Cats'); expect(active?.getAttribute('aria-pressed')).toBe('true');
    });
    it('initializes optional-session writing drafts through the actual client and sends the provided source', async () => {
        const {host} = mount(WritingPanel, {active: true, initialDraft: 'Existing source draft', initialContext: '', initialIntent: 'polish'}); await flush();
        expect(external.ports).toHaveLength(1); const port = external.ports[0], request = port.postMessage.mock.calls[0][0];
        expect(request.draft).toBe('Existing source draft'); expect(request.intent).toBe('polish'); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); await flush(); expect(host.textContent).toContain('Finished');
    });
    it('preserves completed reading results when the same action is clicked twice', async () => {
        const {host} = mount(ReadingPanel, panelProps()); await flush(); const port = external.ports[0], request = port.postMessage.mock.calls[0][0];
        port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); await flush(); button(host, '读懂').click(); await flush();
        expect(external.ports).toHaveLength(1); expect(host.textContent).toContain('Finished');
    });
    it('keeps a late clipboard success from marking a new selection answer as copied', async () => {
        let finish!: () => void;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const {host, props} = mount(ReadingPanel, panelProps()); await flush();
        const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        first.onMessage.fire({type: 'result', requestId: old.requestId, response: result}); await flush(); button(host, '复制').click();
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        const next = external.ports[1], request = next.postMessage.mock.calls[0][0];
        next.onMessage.fire({type: 'result', requestId: request.requestId, response: {...result, text: 'New answer'}}); await flush();
        finish(); await flush(); expect(button(host, '复制').textContent).toBe('复制'); expect(host.textContent).not.toContain('已复制');
        expect(host.textContent).toContain('New answer');
    });
    it('keeps a late clipboard failure from displaying an old selection error on the new answer', async () => {
        let fail!: (error: Error) => void;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise((_resolve, reject) => {fail = reject;}));
        const {host, props} = mount(ReadingPanel, panelProps()); await flush();
        const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        first.onMessage.fire({type: 'result', requestId: old.requestId, response: result}); await flush(); button(host, '复制').click();
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        const next = external.ports[1], request = next.postMessage.mock.calls[0][0];
        next.onMessage.fire({type: 'result', requestId: request.requestId, response: {...result, text: 'New answer'}}); await flush();
        fail(new Error('fixture clipboard denied')); await flush(); expect(host.textContent).not.toContain('复制失败');
        expect(host.textContent).toContain('New answer');
    });
});

describe('audit49B real lexical ranking contracts', () => {
    it('keeps standalone explanation identical to ranked scores and reasons, including expiry and stable ties', () => {
        const now = Date.parse('2026-10-06T00:00:00Z');
        const records: MemoryRecord[] = ['a', 'b', 'expired', 'other'].map(id => ({id, content: id === 'other' ? 'unrelated shopping' : 'Grammar 苹果 helps grammar practice', kind: 'lesson', tags: ['grammar'], scope: 'user', project: null, importance: 2, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), accessedAt: null, accessCount: 2, expiresAt: id === 'expired' ? new Date(now).toISOString() : null}));
        const ranked = rankRecords(records, 'Grammar 苹果', 3, {now}); expect(ranked.map(hit => hit.record.id)).toEqual(['a', 'b']);
        expect(ranked.map(hit => ({score: hit.score, reasons: hit.reasons}))).toEqual(records.slice(0, 2).map(record => explainRecord(record, 'Grammar 苹果', {now})));
        expect(rankRecords(records, '   ', 3, {now})).toEqual([]); expect(rankRecords(records, 'Grammar 苹果', 0, {now})).toEqual([]);
    });
});

type BackgroundKind = 'reading' | 'writing';
function configureBackground(service = 'deepseek') {
    external.config.service = service;
    external.config.model[service] = 'fixture-model'; external.config.token[service] = 'fixture-secret-first';
    external.config.harness = {...external.config.harness, enabled: true, service: '', model: '', memoryEnabled: false};
    external.config.writing = {...external.config.writing, enabled: true, service: '', model: '', referenceLanguage: 'off'};
    if (service.startsWith('custom:')) external.config.customOpenAIProviders = [{id: service, name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: []}];
}
function notifyConfiguration() { external.subscribers.forEach(listener => listener(external.config)); }
async function untilFixture(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0));}
    throw new Error('Controlled HTTP/client fixture did not reach its expected loading/settlement marker');
}
async function openBackgroundPort(kind: BackgroundKind) {
    const index = external.requests.length;
    const port = makePort(kind === 'reading' ? 'fluentReadHarnessStream' : 'fluentReadWritingStream', {id: 'fixture', tab: {id: 92}, frameId: 0, documentId: 'fixture-document', url: 'https://github.com/fixture/repository/issues/1'});
    external.ports.push(port); external.onConnect.forEach(listener => listener(port));
    port.onMessage.fire(kind === 'reading' ? readingRequest(`background-reading-${index}`) : {...writingRequest, requestId: `background-writing-${index}`});
    await untilFixture(() => external.requests.length > index);
    return {port, request: external.requests[index]};
}
function installBackground(kind: BackgroundKind) { if (kind === 'reading') installHarnessBackgroundRuntime(); else installWritingBackgroundRuntime(); }
async function proveEffectiveChange(kind: BackgroundKind, setup: () => void, change: () => void, verifyOld: (request: typeof external.requests[number]) => void, verifyNew: (request: typeof external.requests[number]) => void) {
    configureBackground(); setup(); installBackground(kind);
    const first = await openBackgroundPort(kind); verifyOld(first.request);
    change(); notifyConfiguration();
    expect(first.request.signal.aborted).toBe(true);
    await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({cancelled: true})}));
    const next = await openBackgroundPort(kind); verifyNew(next.request); next.request.complete();
    await untilFixture(() => next.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(next.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true, text: 'Finished'})}));
    const notifications = JSON.stringify(external.ports.flatMap(port => port.postMessage.mock.calls));
    for (const secret of ['fixture-secret-first', 'fixture-secret-next', 'fixture-secret-second', 'fixture-header-first', 'fixture-header-next']) expect(notifications).not.toContain(secret);
}
async function proveInactiveProfiles(kind: BackgroundKind) {
    configureBackground('custom:fixture');
    external.config.harness.service = 'custom:fixture'; external.config.harness.model = 'fixture-model';
    external.config.writing.service = 'custom:fixture'; external.config.writing.model = 'fixture-model';
    external.config.proxy['custom:fixture'] = 'https://fixture.invalid/v1/chat/completions';
    installBackground(kind); const first = await openBackgroundPort(kind);
    external.config.theme = 'dark'; external.config.service = 'openai'; external.config.token.openai = 'unused-fixture-secret';
    external.config.apiKeys.openai = ['unused-fixture-key']; external.config.apiKeyRotationEnabled.openai = true;
    external.config.customHeaders.openai = '{"X-Unused":"unused-fixture-header"}'; external.config.modelThinking.deepseek = {'unused-model': true};
    external.config.model['custom:fixture'] = 'inactive-default-model'; external.config.customModel['custom:fixture'] = 'inactive-custom-model';
    external.config.customOpenAIProviders[0] = {...external.config.customOpenAIProviders[0], name: 'Renamed', endpoint: 'https://unused.invalid/v1', models: ['unselected']};
    external.config.customOpenAIProviders.push({id: 'custom:unused', name: 'Unused', endpoint: 'https://unused.invalid/v1', models: []});
    external.config.writing.referenceLanguage = 'es'; external.config.harness.hoverDelay = 900;
    notifyConfiguration(); expect(first.request.signal.aborted).toBe(false); expect(first.port.postMessage.mock.calls.some(([value]) => value.type === 'result')).toBe(false);
    first.request.complete(); await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true, text: 'Finished'})}));
}
async function proveEquivalentInputs(kind: BackgroundKind) {
    configureBackground('custom:fixture');
    external.config.apiKeys['custom:fixture'] = ['fixture-secret-first', 'fixture-secret-second'];
    external.config.apiKeyRotationEnabled['custom:fixture'] = false;
    external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-first","X-Other":"one"}';
    installBackground(kind); const first = await openBackgroundPort(kind);
    external.config.apiKeys['custom:fixture'] = [' fixture-secret-first ', 'unused-disabled-key', 'fixture-secret-first'];
    external.config.customHeaders['custom:fixture'] = '{ "x-other": "one", "x-fixture": " fixture-header-first " }';
    notifyConfiguration(); expect(first.request.signal.aborted).toBe(false);
    first.request.complete(); await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true})}));
}
const headerSetup = () => {configureBackground('custom:fixture'); external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-first"}';};
const headerChange = () => {external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-next"}';};
const keySetup = () => {external.config.apiKeys.deepseek = ['fixture-secret-first', 'fixture-secret-second']; external.config.apiKeyRotationEnabled.deepseek = false;};
const keyChange = () => {external.config.apiKeys.deepseek[0] = 'fixture-secret-next';};
const rotationSetup = () => {keySetup(); external.config.apiKeyRotationEnabled.deepseek = true;};
const rotationChange = () => {external.config.apiKeyRotationEnabled.deepseek = false;};
const thinkingSetup = () => {external.config.modelThinking.deepseek = {'fixture-model': false};};
const thinkingChange = () => {external.config.modelThinking.deepseek['fixture-model'] = true;};
describe('audit49B real installed background generation ownership', () => {
    it('reading cancels changed active custom headers and the next real HTTP request uses the new header', () => proveEffectiveChange('reading', headerSetup, headerChange, request => expect(request.headers.get('x-fixture')).toBe('fixture-header-first'), request => expect(request.headers.get('x-fixture')).toBe('fixture-header-next')));
    it('writing cancels changed active custom headers and the next real HTTP request uses the new header', () => proveEffectiveChange('writing', headerSetup, headerChange, request => expect(request.headers.get('x-fixture')).toBe('fixture-header-first'), request => expect(request.headers.get('x-fixture')).toBe('fixture-header-next')));
    it('reading cancels a changed effective apiKeys row and the next request uses that key', () => proveEffectiveChange('reading', keySetup, keyChange, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('writing cancels a changed effective apiKeys row and the next request uses that key', () => proveEffectiveChange('writing', keySetup, keyChange, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('reading cancels a changed effective multi-key rotation policy', () => proveEffectiveChange('reading', rotationSetup, rotationChange, request => expect(request.headers.get('authorization')).toMatch(/^Bearer fixture-secret-/), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first')));
    it('writing cancels a changed effective multi-key rotation policy', () => proveEffectiveChange('writing', rotationSetup, rotationChange, request => expect(request.headers.get('authorization')).toMatch(/^Bearer fixture-secret-/), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first')));
    it('reading cancels changed thinking for the effective model and the next request carries the new body', () => proveEffectiveChange('reading', thinkingSetup, thinkingChange, request => expect(request.body.thinking).toEqual({type: 'disabled'}), request => expect(request.body.thinking).toEqual({type: 'enabled'})));
    it('writing cancels changed thinking for the effective model and the next request carries the new body', () => proveEffectiveChange('writing', thinkingSetup, thinkingChange, request => expect(request.body.thinking).toEqual({type: 'disabled'}), request => expect(request.body.thinking).toEqual({type: 'enabled'})));
    it('reading cancels a changed inherited token and the next request uses the new credential', () => proveEffectiveChange('reading', () => undefined, () => {external.config.token.deepseek = 'fixture-secret-next';}, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('reading keeps active work through unrelated UI and inactive or overridden profiles', () => proveInactiveProfiles('reading'));
    it('writing keeps active work through unrelated UI and inactive or overridden profiles', () => proveInactiveProfiles('writing'));
    it('reading keeps active work for equivalent headers and disabled secondary credentials', () => proveEquivalentInputs('reading'));
    it('writing keeps active work for equivalent headers and disabled secondary credentials', () => proveEquivalentInputs('writing'));
});
