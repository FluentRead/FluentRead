/**
 * Actual mounted VocabularyBook + CollectionEntry client templates, actual
 * message router/selection TTS handlers and strategy synthesizer. Only DOM,
 * storage/config, decorative controls and provider/audio boundaries are ports.
 * The options sender has a real extension-page URL and deliberately no tab.
 * Default imports consume repository production; apply the separate candidate
 * handler patch for the after run. No business method or private state is copied.
 */
import {randomUUID} from 'node:crypto';
import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import VocabularyBook from '@/src/features/vocabulary/ui/VocabularyBook.vue';
import CollectionEntry from '@/src/features/vocabulary/ui/CollectionEntry.vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {normalizeConfig} from '@/src/core/config/model';
import type {LocalTtsMode} from '@/src/core/config/localTts';
import * as learning from '@/src/features/vocabulary/learningModel';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {createSelectionTtsBackgroundHandlers, type SelectionTtsContext} from '@/src/features/selection-translation/background/ttsHandler';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';
import type {LocalTtsAudio} from '@/src/features/local-tts/protocol';

const ports = vi.hoisted(() => ({browser: {} as any, config: {} as any}));
vi.mock('webextension-polyfill', () => ({default: {get runtime() {return ports.browser.runtime;}}}));
vi.mock('@/src/services/config/store', () => ({get config() {return ports.config;}, configReady: Promise.resolve(), requestConfigPatch: vi.fn(), subscribeConfig: () => () => {}}));
vi.mock('@/src/ui/interfaceAppearance', () => ({applyInterfaceTheme: vi.fn()}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {browser: 'chrome'}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('element-plus', () => ({ElOption: {render: () => null}, ElMessageBox: {confirm: vi.fn()}}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {inheritAttrs: false, setup: (_: unknown, {attrs, slots}: any) => () => Vue.h('div', attrs, slots.default?.())}}));
vi.mock('@/src/ui/components/UiIcon.vue', () => ({default: {inheritAttrs: false, setup: (_: unknown, {attrs, slots}: any) => () => Vue.h('div', attrs, slots.default?.())}}));
vi.mock('@/src/ui/components/FeatureEnableCard.vue', () => ({default: {inheritAttrs: false, setup: (_: unknown, {attrs, slots}: any) => () => Vue.h('div', attrs, slots.default?.())}}));
vi.mock('@/src/features/vocabulary/ui/VocabularyStudy.vue', () => ({default: {setup() {throw new Error('Unrequested study path mounted');}}}));
vi.mock('@/src/features/vocabulary/ui/SavedExplanation.vue', () => ({default: {setup() {throw new Error('Unrequested editor path mounted');}}}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {setup() {throw new Error('Unrequested answer path mounted');}}}));

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
const audio = (): LocalTtsAudio => ({audio: new Uint8Array([1, 2]).buffer, contentType: 'audio/wav', voice: 'af_heart', backend: 'wasm'});
type Sender = {url: string; tab?: {id: number}};
const optionsSender = (): Sender => ({url: 'chrome-extension://controlled-extension/options.html#settings-vocabulary'});
const apps: Vue.App[] = [];
const pending: Array<ReturnType<typeof deferred<LocalTtsAudio>>> = [];
async function settle() {for (let i = 0; i < 20; i++) {await Promise.resolve(); await Vue.nextTick();}}
afterEach(async () => {
    for (const app of apps.splice(0)) app.unmount();
    for (const task of pending.splice(0)) task.resolve(audio());
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function runtime(honorAbort = true, mode: LocalTtsMode = 'local-only') {
    vi.useFakeTimers();
    const jobs: Array<{text: string; signal?: AbortSignal; task: ReturnType<typeof deferred<LocalTtsAudio>>}> = [];
    const online = vi.fn(async () => {throw new Error('Controlled online synthesis failure');});
    const local = vi.fn((text: string, _language: string, _voice: string, signal?: AbortSignal) => {
        const task = deferred<LocalTtsAudio>(); pending.push(task); jobs.push({text, signal, task});
        const onAbort = () => {if (honorAbort) task.reject(new DOMException('cancelled', 'AbortError'));};
        signal?.addEventListener('abort', onAbort, {once: true});
        if (signal?.aborted) onAbort();
        return task.promise.finally(() => signal?.removeEventListener('abort', onAbort));
    });
    const synthesize = createSelectionTtsSynthesizer({getMode: () => mode, getLocalVoice: () => 'af_heart',
        getOnlineVoices: () => [], synthesizeOnline: online, synthesizeLocal: local});
    const play = vi.fn(async () => {}), stop = vi.fn(async () => {}), notify = vi.fn(async () => {});
    const fetchPageAudio = vi.fn(async () => audio());
    const handlers = createSelectionTtsBackgroundHandlers({getPreferredVoices: () => [], synthesize, fetchPageAudio,
        playWithOffscreen: play, stopWithOffscreen: stop, seekWithOffscreen: async () => {throw Error('Unexpected seek in vocabulary cancellation fixture');}, sendTabMessage: notify});
    const router = createBackgroundMessageRouter(handlers);
    // Same public context construction as installBackgroundMessageRuntime.
    const dispatch = createBackgroundRuntimeMessageListener(router, sender => ({sender: sender as SelectionTtsContext['sender']}));
    return {jobs, online, local, play, stop, notify, dispatch, fetchPageAudio};
}

async function mountBook(honorAbort = true, options: {mode?: LocalTtsMode; audioContext?: boolean; tabId?: number} = {}) {
    const rt = runtime(honorAbort, options.mode), sender = optionsSender();
    if (options.tabId === undefined) expect(Object.hasOwn(sender, 'tab')).toBe(false);
    else sender.tab = {id: options.tabId};
    const {window, document} = parseHTML('<html><head></head><body><div id="mount"></div></body></html>');
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    const browserSpeech = vi.fn(), audioPlay = vi.fn(async () => {}), audioContexts: any[] = [], audioElements: any[] = [];
    class TestAudioContext {
        state = 'running'; destination = {};
        resume = vi.fn(async () => {}); close = vi.fn(async () => {this.state = 'closed';});
        decodeAudioData = vi.fn(async () => ({}));
        createBufferSource = vi.fn(() => {
            const source = {buffer: null, onended: null as unknown, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn()};
            return source;
        });
        constructor() {audioContexts.push(this);}
    }
    Object.assign(window, {AudioContext: options.audioContext === false ? undefined : TestAudioContext, matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
        speechSynthesis: {getVoices: () => [], speak: browserSpeech, cancel: vi.fn()}});
    vi.stubGlobal('__VUE_DEVTOOLS_GLOBAL_HOOK__', {enabled: true, emit() {}});
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    for (const key of ['Node', 'Element', 'HTMLElement', 'SVGElement'] as const) vi.stubGlobal(key, window[key]);
    vi.stubGlobal('crypto', {randomUUID});
    vi.stubGlobal('Audio', class {onended: unknown; onerror: unknown; play = audioPlay; pause() {} removeAttribute() {} constructor() {audioElements.push(this);}});
    vi.stubGlobal('SpeechSynthesisUtterance', class {lang = ''; voice: unknown; onend: unknown; onerror: unknown; constructor(readonly text: string) {}});
    const listeners = new Set<unknown>();
    const traffic: Array<{message: any; sender: Sender; response?: any}> = [];
    const entry: learning.VocabularyEntry = {id: 'saved-a', term: 'art', normalizedTerm: 'art', identityKey: 'en:art', sourceLanguage: 'en', kind: 'expression',
        translations: {'zh-cn': {text: '艺术', updatedAt: 1}}, contexts: [], note: '', phonetic: '', partOfSpeech: '',
        createdAt: 1, updatedAt: 1, lastSeenAt: 1, encounterCount: 1, masteryLevel: 0, status: 'new', nextReviewAt: 1,
        lastReviewedAt: null, reviewCount: 0, lapseCount: 0, schemaVersion: 1};
    const browser = {runtime: {
        sendMessage: async (message: any) => {
            if (message.type === learning.VOCABULARY_BOOK_MESSAGE && message.action === 'list') return {success: true, data: [structuredClone(entry)]};
            const row = {message, sender: {...sender}} as typeof traffic[number]; traffic.push(row);
            row.response = await rt.dispatch(message, row.sender);
            return row.response;
        },
        onMessage: {addListener: (fn: unknown) => listeners.add(fn), removeListener: (fn: unknown) => listeners.delete(fn)},
    }};
    const config = normalizeConfig({theme: 'light', uiLanguage: 'zh-CN', vocabularyBookEnabled: true, selectionTtsMode: options.mode || 'local-only'});
    ports.browser = browser; ports.config = config;
    const component = VocabularyBook;
    const events = new WeakMap<Element, Record<string, any>>();
    const renderer = Vue.createRenderer<any, any>({createElement: tag => Vue.markRaw(document.createElement(tag)), createText: text => document.createTextNode(text),
        createComment: text => document.createComment(text), insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
        setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
        patchProp(node, key, _old, value) {
            if (key.startsWith('on')) {const saved = events.get(node) || {}; saved[key] = value; events.set(node, saved);}
            else if (key === 'style') Object.assign(node.style, value || {});
            else if (key.startsWith('aria-') && value != null) node.setAttribute(key, String(value));
            else if (value === false || value == null) node.removeAttribute(key);
            else node.setAttribute(key, value === true ? '' : String(value));
        },
        insertStaticContent(html, parent, anchor) {const box = document.createElement('div'); box.innerHTML = html; const first = box.firstChild!, last = box.lastChild!;
            while (box.firstChild) parent.insertBefore(box.firstChild, anchor || null); return [first, last];},
    });
    const app = renderer.createApp(component); apps.push(app); app.mount(document.querySelector('#mount')!); await settle();
    function clickSpeech() {
        const button = document.querySelector('.entry-actions button.entry-icon'); expect(button).toBeTruthy();
        const callback = events.get(button!)?.onClick; expect(callback).toBeTypeOf('function');
        callback({target: button, currentTarget: button, stopPropagation() {}, preventDefault() {}});
    }
    function sendPlaybackState(message: unknown) {
        for (const listener of listeners) (listener as (message: unknown, sender: unknown) => unknown)(message, sender);
    }
    function unmount() {app.unmount(); apps.splice(apps.indexOf(app), 1);}
    return {...rt, sender, document, listeners, traffic, clickSpeech, sendPlaybackState, unmount, browserSpeech, audioPlay, audioContexts, audioElements, entry, renderer,
        click(target: Element) {const handler = events.get(target)?.onClick; expect(handler).toBeTypeOf('function'); handler({target,currentTarget:target,stopPropagation(){},preventDefault(){}});}};
}

describe('vocabulary extension-page TTS cancellation through public runtime', () => {
    it('passes the no-tab options owner signal into real synthesis and aborts on the rendered second click', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        expect(ctx.jobs).toHaveLength(1); expect(ctx.jobs[0].signal).toBeInstanceOf(AbortSignal);
        expect(ctx.document.querySelector('.entry-actions button.entry-icon')?.getAttribute('aria-label')).toBe('停止朗读');
        ctx.clickSpeech(); await settle();
        expect(ctx.jobs[0].signal?.aborted).toBe(true);
        expect(ctx.traffic.find(row => row.message.type === 'selectionTts')?.sender).toEqual(optionsSender());
        expect(ctx.traffic.find(row => row.message.type === 'selectionTtsStop')?.sender).toEqual(optionsSender());
        expect(ctx.document.querySelector('.entry-actions button.entry-icon')?.getAttribute('aria-label')).toBe('朗读原文');
        expect(ctx.online).not.toHaveBeenCalled(); expect(ctx.play).not.toHaveBeenCalled(); expect(ctx.stop).not.toHaveBeenCalled();
        expect(ctx.audioPlay).not.toHaveBeenCalled(); expect(ctx.browserSpeech).not.toHaveBeenCalled();
    });
    it('keeps a local-only provider failure from falling back to browser speech', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.reject(new Error('Local model unavailable')); await settle();
        expect(ctx.traffic.find(row => row.message.type === 'selectionTts')?.response).toMatchObject({success: false});
        expect(ctx.browserSpeech).not.toHaveBeenCalled();
        expect(ctx.online).not.toHaveBeenCalled();
        expect(ctx.document.querySelector('.entry-actions button.entry-icon')?.getAttribute('aria-label')).toBe('朗读原文');
        expect(ctx.document.body.textContent).toContain('Local model unavailable');
    });
    it('aborts on public unmount after hash navigation and rejects delayed adapter success without playback', async () => {
        const ctx = await mountBook(false); ctx.clickSpeech(); await settle();
        expect(ctx.jobs).toHaveLength(1); expect(ctx.jobs[0].signal).toBeInstanceOf(AbortSignal);
        ctx.sender.url = 'chrome-extension://controlled-extension/options.html#settings-services';
        ctx.unmount(); await settle();
        expect(ctx.jobs[0].signal?.aborted).toBe(true); expect(ctx.listeners.size).toBe(0);
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.traffic.find(row => row.message.type === 'selectionTts')?.response).toMatchObject({success: false});
        expect(ctx.audioPlay).not.toHaveBeenCalled(); expect(ctx.browserSpeech).not.toHaveBeenCalled();
        expect(ctx.online).not.toHaveBeenCalled(); expect(ctx.play).not.toHaveBeenCalled();
    });
    it('activates extension-page Web Audio in the click gesture and plays returned synthesis bytes', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechRequesting');
        expect(ctx.audioContexts).toHaveLength(1);
        expect(ctx.audioContexts[0].resume).toHaveBeenCalledOnce();
        expect(ctx.jobs).toHaveLength(1);
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechPlaying');
        expect(ctx.audioContexts[0].decodeAudioData).toHaveBeenCalledOnce();
        expect(ctx.audioContexts[0].createBufferSource.mock.results[0].value.start).toHaveBeenCalledOnce();
        expect(ctx.audioPlay).not.toHaveBeenCalled();
    });
    it('does not decode returned audio after STOP while Web Audio is resuming', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        const context = ctx.audioContexts[0], resumed = deferred<void>();
        context.resume.mockImplementationOnce(() => resumed.promise);
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(context.resume).toHaveBeenCalledTimes(2); expect(context.decodeAudioData).not.toHaveBeenCalled();
        ctx.clickSpeech(); await settle(); resumed.resolve(); await settle();
        expect(context.decodeAudioData).not.toHaveBeenCalled(); expect(context.createBufferSource).not.toHaveBeenCalled();
        expect(ctx.document.querySelector('.entry-speech-status')).toBeNull();
    });
    it('ignores a canceled browser utterance starting during the next fallback and retains its watchdog', async () => {
        const ctx = await mountBook(true, {mode: 'online-first', audioContext: false});
        ctx.fetchPageAudio.mockRejectedValue(new Error('Google unavailable'));
        ctx.clickSpeech(); await settle(); ctx.jobs[0].task.reject(new Error('Local unavailable')); await settle();
        expect(ctx.browserSpeech).toHaveBeenCalledOnce();
        const old = ctx.browserSpeech.mock.calls[0][0];
        ctx.clickSpeech(); await settle(); ctx.clickSpeech(); await settle();
        ctx.jobs[1].task.reject(new Error('Local unavailable')); await settle();
        expect(ctx.browserSpeech).toHaveBeenCalledTimes(2);
        old.onstart(); await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechRequesting');
        await vi.advanceTimersByTimeAsync(8000); await settle();
        expect(ctx.document.querySelector('.entry-actions button.entry-icon')?.getAttribute('aria-label')).toBe('朗读原文');
        expect(ctx.document.querySelector('.book-toast')?.textContent).toBe('learning.collection.speechBrowserNotStarted');
    });
    it('keeps the visible speech status while offscreen reports playback progress', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechPlaying');
        const id = ctx.traffic.find(row => row.message.type === 'selectionTts')?.message.clientRequestId;
        ctx.sendPlaybackState({type: 'selectionTtsState', clientRequestId: id, state: 'progress', progress: 0.25});
        await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechPlaying');
    });
    it.each(['event-first', 'rejection-first'] as const)('bounds HTML audio fallback when Google playback fails (%s)', async order => {
        const ctx = await mountBook(true, {mode: 'online-first', audioContext: false});
        const primaryPlay = deferred<void>(), googlePlay = deferred<void>();
        ctx.audioPlay.mockImplementationOnce(() => primaryPlay.promise).mockImplementationOnce(() => googlePlay.promise);
        ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.audioElements).toHaveLength(1);
        const primary = ctx.audioElements[0];
        primary.onerror(); primaryPlay.reject(new Error('Primary decode failure')); await settle();
        expect(ctx.fetchPageAudio).toHaveBeenCalledOnce();
        expect(ctx.audioElements).toHaveLength(2);
        const google = ctx.audioElements[1];
        if (order === 'event-first') google.onerror();
        googlePlay.reject(new Error('Google decode failure')); await settle();
        if (order === 'rejection-first') google.onerror();
        await settle();
        expect(ctx.browserSpeech).toHaveBeenCalledOnce();
        primary.onerror(); google.onerror(); await settle();
        expect(ctx.fetchPageAudio).toHaveBeenCalledOnce();
        expect(ctx.traffic.filter(row => row.message.type === 'selectionTtsGoogle')).toHaveLength(1);
        expect(ctx.browserSpeech).toHaveBeenCalledOnce();
        ctx.browserSpeech.mock.calls[0][0].onstart(); await settle();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechPlaying');
    });
    it('does not leave local-only mode after HTML audio playback fails', async () => {
        const ctx = await mountBook(true, {audioContext: false});
        ctx.audioPlay.mockRejectedValueOnce(new Error('Local audio decode failure'));
        ctx.clickSpeech(); await settle(); ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.fetchPageAudio).not.toHaveBeenCalled();
        expect(ctx.online).not.toHaveBeenCalled(); expect(ctx.browserSpeech).not.toHaveBeenCalled();
        expect(ctx.traffic.filter(row => row.message.type === 'fluentReadVocabularyBook').map(row => row.message.action)).toEqual(['listUndo']);
        expect(ctx.traffic.filter(row => row.message.type !== 'fluentReadVocabularyBook').map(row => row.message.type)).toEqual(['selectionTts']);
        expect(ctx.document.querySelector('.entry-speech-status')).toBeNull();
    });
    it('ignores a pending HTML play rejection after the user stops playback', async () => {
        const ctx = await mountBook(true, {mode: 'online-first', audioContext: false});
        const playback = deferred<void>(); ctx.audioPlay.mockImplementationOnce(() => playback.promise);
        ctx.clickSpeech(); await settle(); ctx.jobs[0].task.resolve(audio()); await settle();
        ctx.clickSpeech(); playback.reject(new Error('Play cancelled')); await settle();
        expect(ctx.fetchPageAudio).not.toHaveBeenCalled(); expect(ctx.browserSpeech).not.toHaveBeenCalled();
        expect(ctx.document.querySelector('.entry-speech-status')).toBeNull();
    });
    it('shows playing after the background accepts offscreen audio', async () => {
        const ctx = await mountBook(true, {tabId: 8}); ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.resolve(audio()); await settle();
        expect(ctx.play).toHaveBeenCalledOnce();
        expect(ctx.document.querySelector('.entry-speech-status')?.textContent).toBe('learning.collection.speechPlaying');
    });
    it('clears the active speech state when all providers fail and browser speech is unavailable', async () => {
        const ctx = await mountBook(true, {mode: 'online-first'});
        Reflect.deleteProperty(window, 'speechSynthesis');
        ctx.fetchPageAudio.mockRejectedValueOnce(new Error('Google unavailable'));
        ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.reject(new Error('Local unavailable')); await settle();
        expect(ctx.fetchPageAudio).toHaveBeenCalledOnce();
        expect(ctx.browserSpeech).not.toHaveBeenCalled();
        expect(ctx.document.querySelector('.entry-speech-status')).toBeNull();
        expect(ctx.document.querySelector('.entry-actions button.entry-icon')?.getAttribute('aria-label')).toBe('朗读原文');
    });
    it('does not send a local-only vocabulary word to any online provider after local synthesis fails', async () => {
        const ctx = await mountBook(); ctx.clickSpeech(); await settle();
        ctx.jobs[0].task.reject(new Error('Edge test failure')); await settle();
        expect(ctx.document.querySelector('.book-toast')?.textContent).toContain('Edge test failure');
        expect(ctx.traffic.filter(row => row.message.type === 'fluentReadVocabularyBook').map(row => row.message.action)).toEqual(['listUndo']);
        expect(ctx.traffic.filter(row => row.message.type !== 'fluentReadVocabularyBook').map(row => row.message.type)).toEqual(['selectionTts']);
        expect(ctx.online).not.toHaveBeenCalled();
        expect(ctx.document.querySelector('.entry-speech-status')).toBeNull();
    });
    it('isolates URL and UUID owners from content, wrong-page STOP and no-tab Google fallback', async () => {
        const rt = runtime(false), first = optionsSender(), other = {url: 'chrome-extension://controlled-extension/options.html?view=another'};
        const id = randomUUID(), nextId = randomUUID(), content = {url: 'https://controlled.example/', tab: {id: 8}};
        const start = (sender: Sender, text: string, clientRequestId = id) => rt.dispatch({type: 'selectionTts', text, language: 'en-US', clientRequestId}, sender);
        const contentResult = start(content, 'content'); await settle();
        const pageResult = start(first, 'page'); await settle();
        const nextResult = start(first, 'next page', nextId); await settle();
        expect(rt.jobs).toHaveLength(3); rt.jobs.forEach(job => expect(job.signal).toBeInstanceOf(AbortSignal));
        expect(rt.jobs[0].signal?.aborted).toBe(false);
        await rt.dispatch({type: 'selectionTtsStop', clientRequestId: id}, other);
        await rt.dispatch({type: 'selectionTtsStop', clientRequestId: randomUUID()}, first);
        expect(rt.jobs[1].signal?.aborted).toBe(false); expect(rt.jobs[2].signal?.aborted).toBe(false);
        await rt.dispatch({type: 'selectionTtsGoogle', text: 'unused', clientRequestId: id}, first);
        expect(rt.jobs[0].signal?.aborted).toBe(false); expect(rt.stop).not.toHaveBeenCalled();
        await rt.dispatch({type: 'selectionTtsStop', clientRequestId: id}, first);
        expect(rt.jobs[1].signal?.aborted).toBe(true); expect(rt.jobs[0].signal?.aborted).toBe(false); expect(rt.jobs[2].signal?.aborted).toBe(false);
        rt.jobs.forEach(job => job.task.resolve(audio()));
        expect(await pageResult).toMatchObject({success: false});
        expect(await nextResult).toMatchObject({success: true, transport: 'page'});
        expect(await contentResult).toMatchObject({success: true, transport: 'offscreen'});
        expect(rt.play).toHaveBeenCalledOnce(); expect(rt.stop).not.toHaveBeenCalled(); expect(rt.online).not.toHaveBeenCalled();
    });
    it('honors STOP between public dispatch and provider entry without starting local synthesis', async () => {
        const rt = runtime(), sender = optionsSender(), id = randomUUID();
        const request = rt.dispatch({type: 'selectionTts', text: 'art', language: 'en-US', clientRequestId: id}, sender);
        await rt.dispatch({type: 'selectionTtsStop', clientRequestId: id}, sender);
        await settle(); expect(rt.local).not.toHaveBeenCalled();
        expect(await request).toMatchObject({success: false}); expect(rt.online).not.toHaveBeenCalled();
    });
});

it('renders the direct collection entry and dispatches bilingual copy, learning and mastery from its own controls', async () => {
    const ctx = await mountBook(); const copy = vi.fn(), study = vi.fn(), mastery = vi.fn();
    const host = ctx.document.createElement('section'); ctx.document.body.append(host);
    const app = ctx.renderer.createApp(CollectionEntry, {entry: ctx.entry, translation: '艺术', playing: false, speechPhase: 'idle', busy: false, status: '新词', review: '现在可以复习', onCopy: copy, onStudy: study, onMastery: mastery});
    apps.push(app); app.mount(host); await settle();
    expect(host.querySelector('.entry-open')?.textContent).toBe('art');
    const byText = (text: string) => {const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === text); expect(button).toBeTruthy(); return button!;};
    ctx.click(byText('复制双语')); ctx.click(byText('复制原文')); ctx.click(host.querySelector('.entry-open')!); ctx.click(byText('标记掌握'));
    expect(copy.mock.calls).toEqual([[true],[false]]); expect(study).toHaveBeenCalledOnce(); expect(mastery).toHaveBeenCalledOnce();
});
