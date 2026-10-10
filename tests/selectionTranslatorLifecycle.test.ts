/**
 * @file tests/selectionTranslatorLifecycle.test.ts
 * 文件职责：执行划词组件的实际挂载与卸载回调，验证扩展消息端口撤销不会留下宿主页面资源。
 * 主要内容：覆盖注销清理、原生右键菜单选区恢复与重复翻译复用、朗读生成与降级、取消、迟到响应、进度隔离和富文本 trim 后的 UTF-16 跟读偏移。
 * 模块边界：编译真实 Vue setup 并替换浏览器和渲染依赖，不模拟完整 UI 或声称真实浏览器验证。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import * as speechProgress from '@/src/core/tts/speechProgress';
import {createSelectionTtsContentController} from '@/src/features/selection-translation/content/selectionTtsContentController';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {compileScript, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import {Config} from '@/src/core/config/model';
import * as selectionCore from '@/src/features/selection-translation/core';
import * as harness from '@/src/core/config/harness';
import * as runtimeMessages from '@/src/platform/browser/runtimeMessages';
import * as detect from '@/src/core/language/detect';
import * as wordNormalization from '@/src/features/selection-translation/services/wordNormalization';
import * as vocabularyProtocol from '@/src/features/vocabulary/protocol';
import * as hotkey from '@/src/core/hotkey';
import {setSelectionContextMenuHandler, translateSelectionFromContextMenu as translateSelectionThroughBridge} from '@/src/features/selection-translation/content/contextMenuBridge';

vi.mock('webextension-polyfill', () => ({default: {}}));

const filename = 'src/features/selection-translation/ui/SelectionTranslator.vue';
const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
type SelectionBuildTarget = 'chrome' | 'userscript';
const setupSource = compileScript(descriptor, {id: 'selection-lifecycle'}).content;
const compiledByTarget = new Map<SelectionBuildTarget, string>();
function compileForTarget(target: SelectionBuildTarget): string {
    let compiled = compiledByTarget.get(target);
    if (!compiled) {
        // 和 Vite 的 define 使用相同静态属性替换；各构建目标只转译一次，所有用例复用真实 setup。
        compiled = ts.transpileModule(setupSource.replaceAll('import.meta.env.BROWSER', JSON.stringify(target)), {
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
        }).outputText;
        compiledByTarget.set(target, compiled);
    }
    return compiled;
}
let app: Vue.App | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function mountSelection(privateContext = false, selectionAdapter?: Record<string, unknown>, browserTarget: SelectionBuildTarget = 'chrome') {
    vi.useFakeTimers();
    const config = Object.assign(new Config(), {
        disableSelectionTranslator: false, selectionTranslatorMode: 'bilingual', theme: 'light',
    });
    const listeners = new Map<string, Set<(...args: any[]) => any>>();
    const eventTarget = (prefix: string) => ({
        addEventListener: vi.fn((type: string, listener: (...args: any[]) => any) => {
            const key = `${prefix}:${type}`;
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key)!.add(listener);
        }),
        removeEventListener: vi.fn((type: string, listener: (...args: any[]) => any) => {
            listeners.get(`${prefix}:${type}`)?.delete(listener);
        }),
    });
    const media = eventTarget('media');
    const document = {...eventTarget('document'), getElementById: vi.fn(() => null)};
    const window = {
        ...eventTarget('window'), innerWidth: 1000, innerHeight: 800,
        matchMedia: () => ({matches: false, ...media}),
        setTimeout, clearTimeout,
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
        cancelAnimationFrame: vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id)),
        speechSynthesis: {cancel: vi.fn()},
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const event = {addListener: vi.fn(), removeListener: vi.fn()};
    const browser = {
        runtime: {onMessage: event, getURL: (path: string) => path,
            sendMessage: vi.fn().mockResolvedValue({success: true, zoom: 1})},
        extension: {inIncognitoContext: privateContext},
    };
    const unsubscribeConfig = vi.fn(), releaseContextMenu = vi.fn();
    let contextMenuHandler = (_selectionText?: string): boolean => false;
    const registerContextMenu = vi.fn((handler: typeof contextMenuHandler) => {
        contextMenuHandler = handler;
        return releaseContextMenu;
    });
    const translateText = vi.fn().mockResolvedValue('这是译文'), translateTextBatch = vi.fn();
    let stopTts: MockInstance<(notifyRemote?: boolean) => void>;
    let ttsRequestId = 0;
    const modules: Record<string, unknown> = {
        './SpeechFollowText.vue': {},
        '@/src/core/tts/speechProgress': speechProgress,
        '@/src/core/translation/result': {hasDistinctTranslation},
        vue: {...Vue, useTemplateRef: () => Vue.ref(null)},
        'webextension-polyfill': browser,
        '@/src/platform/browser/runtimeMessages': runtimeMessages,
        '@/src/services/config/store': {config, subscribeConfig: () => unsubscribeConfig},
        '@/src/app/translation/client': {translateText, translateTextBatch},
        '@/src/features/selection-translation/core': selectionCore,
        '@/src/features/selection-translation/services/wordNormalization': wordNormalization,
        '@/src/core/config/harness': harness,
        '@/src/core/language/detect': detect,
        '@/src/features/vocabulary/protocol': vocabularyProtocol,
        '@/src/core/hotkey': hotkey,
        '@/src/features/share-card/public': {isShareCardMounted: () => false},
        '@/src/features/selection-translation/content/selectionTtsContentController': {
            createSelectionTtsContentController: (dependencies: Parameters<typeof createSelectionTtsContentController>[0]) => {
                const controller = createSelectionTtsContentController({
                    ...dependencies,
                    createClientRequestId: () => `tts-client-${++ttsRequestId}`,
                });
                stopTts = vi.spyOn(controller, 'stop');
                return controller;
            },
        },
        '@/src/features/selection-translation/content/contextMenuBridge': {
            setSelectionContextMenuHandler: registerContextMenu,
        },
        '@/src/features/selection-translation/pageZoom': {normalizeSelectionPageZoom: () => 1},
        '@/src/ui/i18n': {useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})},
    };
    const exports: Record<string, any> = {};
    new Function('require', 'exports', compileForTarget(browserTarget))((id: string) => {
        if (!(id in modules) && !id.startsWith('@/src/')) throw new Error(`Unexpected import: ${id}`);
        return modules[id] ?? {};
    }, exports);
    exports.default.render = () => null;
    const renderer = Vue.createRenderer<Record<string, unknown>, Record<string, unknown>>({
        patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
        createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {},
        parentNode: () => null, nextSibling: () => null,
    });
    const currentApp = renderer.createApp(exports.default, {selectionAdapter});
    const lifecycleErrors = vi.fn();
    currentApp.config.errorHandler = lifecycleErrors;
    app = currentApp;
    const vm = currentApp.mount({});
    const state = (vm.$ as any).setupState as Record<string, any>;
    return {state, event, browser, config, listeners, window, document, unsubscribeConfig, releaseContextMenu, translateText, translateTextBatch, stopTts: stopTts!,
        registerContextMenu, get contextMenuHandler() {return contextMenuHandler;},
        lifecycleErrors, unmount: () => { currentApp.unmount(); app = undefined; }};
}

describe('explicit selection sentence collection', () => {
    function prepare(text: string, sourceLanguage = 'en', privateContext = false) {
        const fixture = mountSelection(privateContext);
        fixture.config.vocabularyBookEnabled = true;
        const request = {text, generation: 1, sourceLanguage, targetLanguage: 'zh-Hans'};
        fixture.state.snapshot = {text};
        fixture.state.selectedText = text;
        fixture.state.activeContentRequest = request;
        fixture.state.translationAnswer = {...request, answer: '这是一句译文。'};
        fixture.browser.runtime.sendMessage.mockResolvedValue({success: true, data: {id: 'saved-sentence'}});
        return {...fixture, request};
    }

    it('saves a complete selected sentence through the existing card without requiring an English word selection', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        expect(fixture.state.isWordSelection).toBe(false);
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'upsert', input: expect.objectContaining({
                term: fixture.request.text, sourceLanguage: 'en', translation: '这是一句译文。',
            }),
        }));
        expect(fixture.state.isVocabularySaved).toBe(true);
    });

    it('uses the captured language for other-language sentences and retrieves saved state after explicit card requests', async () => {
        const fixture = prepare('Les idées méritent notre attention.', 'fr');
        await fixture.state.refreshVocabularySaved(fixture.request);
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'getByTerm', sourceLanguage: 'fr', term: fixture.request.text,
        }));
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'upsert', input: expect.objectContaining({sourceLanguage: 'fr'}),
        }));
    });

    it('does not query or save a selected sentence in a private context', async () => {
        const fixture = prepare('Good ideas deserve attention.', 'en', true);
        fixture.browser.runtime.sendMessage.mockClear();
        await fixture.state.refreshVocabularySaved(fixture.request);
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.type === vocabularyProtocol.VOCABULARY_BOOK_MESSAGE)).toBe(false);
    });

    it('does not mark a new selection saved when the previous sentence save finishes late', async () => {
        const fixture = prepare('Good ideas deserve attention.');
        let finish!: (response: unknown) => void;
        fixture.browser.runtime.sendMessage.mockImplementation(message => message.action === 'upsert'
            ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({success: true}));
        const pending = fixture.state.saveVocabularyEntry({isTrusted: true});
        const text = 'Practice makes progress.';
        fixture.state.snapshot = {text};
        fixture.state.selectedText = text;
        fixture.state.beginSelectionContentRequest(text);
        finish({success: true, data: {id: 'old-sentence'}});
        await pending;
        expect(fixture.state.isVocabularySaved).toBe(false);
        expect(fixture.state.noticeMessage).toBe('');
    });

    it.each(['untrusted', 'disabled', 'missing-answer'] as const)('does not save when %s', async condition => {
        const fixture = prepare('Good ideas deserve attention.');
        if (condition === 'disabled') fixture.config.vocabularyBookEnabled = false;
        if (condition === 'missing-answer') fixture.state.translationAnswer = null;
        fixture.browser.runtime.sendMessage.mockClear();
        await fixture.state.saveVocabularyEntry({isTrusted: condition !== 'untrusted'});
        expect(fixture.browser.runtime.sendMessage.mock.calls.some(([message]) => message.action === 'upsert')).toBe(false);
    });
});

describe('SelectionTranslator lifecycle after extension reload', () => {
    it.each(['normal', 'runtime removed', 'event removed', 'removeListener throws'] as const)(
        'cleans up all selection resources when %s', async failure => {
            const fixture = mountSelection();
            const {state, event, browser, window, listeners} = fixture;
            await Vue.nextTick();
            expect(fixture.config.disableSelectionTranslator).toBe(false);
            expect(fixture.config.selectionTranslatorMode).toBe('bilingual');
            const registered = event.addListener.mock.calls.map(([listener]) => listener);
            expect(registered).toHaveLength(4);
            const onTimer = vi.fn();
            for (const timer of ['readingHoverTimer', 'selectionLossTimer', 'selectionPresentationTimer', 'copyTimer', 'noticeTimer']) {
                state[timer] = setTimeout(onTimer, 50);
            }
            state.selectionFrame = window.requestAnimationFrame(onTimer);
            state.positionFrame = window.requestAnimationFrame(onTimer);
            const pendingTranslation = new AbortController();
            state.translationAbortController = pendingTranslation;
            const pendingWordLookup = new AbortController();
            state.wordLookupAbortController = pendingWordLookup;
            state.isWordCardSupportLoading = true;
            state.translationResult = '译文';
            state.isLoading = true;
            if (failure === 'runtime removed') Reflect.deleteProperty(browser, 'runtime');
            else if (failure === 'event removed') Reflect.deleteProperty(browser.runtime, 'onMessage');
            else if (failure === 'removeListener throws') {
                event.removeListener.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
            }

            expect(() => fixture.unmount()).not.toThrow();
            expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
            expect(event.removeListener.mock.calls.map(([listener]) => listener)).toEqual(registered);
            expect(fixture.unsubscribeConfig).toHaveBeenCalledOnce();
            expect(fixture.releaseContextMenu).toHaveBeenCalledOnce();
            expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
            expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2);
            expect(pendingTranslation.signal.aborted).toBe(true);
            expect(pendingWordLookup.signal.aborted).toBe(true);
            expect(state.isWordCardSupportLoading).toBe(false);
            expect(fixture.stopTts).toHaveBeenCalledWith(true);
            expect(window.speechSynthesis.cancel).toHaveBeenCalledOnce();
            expect(state.translationResult).toBe('');
            expect(state.isLoading).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(100);
            expect(onTimer).not.toHaveBeenCalled();
        },
    );

    const card = (word: string) => ({word, normalizedWord: word, phonetics: [], sources: [],
        meanings: [{partOfSpeech: '名词', definitions: [{definition: 'an English definition'}]}]});
    function beginWord(fixture: ReturnType<typeof mountSelection>, word: string) {
        fixture.state.snapshot = {text: word};
        fixture.state.selectedText = word;
        return fixture.state.beginSelectionContentRequest(word);
    }

    it('shows the first word card while auxiliary translation is pending and cancels that wait on unmount', async () => {
        const fixture = mountSelection();
        const {state, browser} = fixture;
        browser.runtime.sendMessage.mockImplementation((message: any) => message.type !== 'selectionWordLookup'
            ? Promise.resolve({success: true, zoom: 1})
            : message.translateFields ? new Promise(() => {}) : Promise.resolve({success: true, data: card(message.word)}));
        const pending = state.requestWordCard(beginWord(fixture, 'read'));
        await vi.advanceTimersByTimeAsync(0);
        expect(state.wordCard.word).toBe('read');
        expect(state.isWordCardLoading).toBe(false);
        expect(state.isWordCardSupportLoading).toBe(true);
        fixture.unmount();
        await pending;
        expect(vi.getTimerCount()).toBe(0);
        expect(state.wordCard).toBeNull();
    });

    it('ends an unresponsive message after 3.5 seconds while keeping the ordinary translation', async () => {
        const fixture = mountSelection();
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionWordLookup'
            ? new Promise(() => {}) : Promise.resolve({success: true, zoom: 1}));
        const request = beginWord(fixture, 'missing');
        fixture.state.translationResult = '已有译文';
        const pending = fixture.state.requestWordCard(request);
        await vi.advanceTimersByTimeAsync(3_500);
        await pending;
        expect(fixture.state.isWordCardLoading).toBe(false);
        expect(fixture.state.wordCardError).toContain('可稍后重查');
        expect(fixture.state.translationResult).toBe('已有译文');
    });

    it('ignores an old word response after the user selects a new word', async () => {
        const fixture = mountSelection();
        let release!: (response: any) => void;
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type !== 'selectionWordLookup'
            ? Promise.resolve({success: true, zoom: 1}) : message.word === 'old'
                ? new Promise(resolve => { release = resolve; }) : Promise.resolve({success: true, data: card(message.word)}));
        const old = fixture.state.requestWordCard(beginWord(fixture, 'old'));
        const current = fixture.state.requestWordCard(beginWord(fixture, 'new'));
        await vi.advanceTimersByTimeAsync(0);
        await current;
        release({success: true, data: card('old')});
        await old;
        expect(fixture.state.wordCard.word).toBe('new');
        expect(fixture.state.wordCardError).toBe('');
        expect(fixture.state.isWordCardSupportLoading).toBe(false);
    });
});

function deferredTts() {
    let resolve!: (response: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function ttsMessages(fixture: ReturnType<typeof mountSelection>, type: string) {
    return fixture.browser.runtime.sendMessage.mock.calls
        .map(([message]) => message as {type: string; text?: string; clientRequestId: string})
        .filter(message => message.type === type);
}

function prepareTts(fixture: ReturnType<typeof mountSelection>, responses: Promise<Record<string, unknown>>[]) {
    fixture.config.selectionTtsMode = 'local-only';
    fixture.browser.runtime.sendMessage.mockImplementation((message: any) => {
        if (message.type === 'selectionTts') {
            const response = responses.shift();
            if (!response) throw new Error('Unexpected TTS request');
            return response;
        }
        return Promise.resolve({success: true, zoom: 1});
    });
}

function emitTtsState(fixture: ReturnType<typeof mountSelection>, clientRequestId: string, state: string, extra = {}) {
    return fixture.event.addListener.mock.calls.map(([listener]) =>
        listener({type: 'selectionTtsState', clientRequestId, state, ...extra}));
}

function expectAudioReset(state: Record<string, any>) {
    expect(state.isPreparingAudio).toBe(false);
    expect(state.isPlaying).toBe(false);
    expect(state.audioProgress).toBeNull();
    expect(state.currentAudioKind).toBeNull();
    expect(state.currentAudioText).toBe('');
    expect(state.currentAudioKey).toBe('');
}

describe('SelectionTranslator TTS generation and progress ownership', () => {
    it('5 second controls use the active route, reject unavailable playback and ignore late seek failures', async () => {
        const fixture=mountSelection();const response=deferredTts();prepareTts(fixture,[response.promise]);
        const pending=fixture.state.toggleAudio('Hello world','source');
        await fixture.state.seekAudio(5);expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        response.resolve({success:true,transport:'offscreen'});await pending;
        await fixture.state.seekAudio(5);expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        emitTtsState(fixture,'tts-client-1','progress',{progress:{start:0,end:5,fraction:0,estimated:true},position:{currentTime:2,duration:12}});
        fixture.browser.runtime.sendMessage.mockResolvedValue({success:true});
        await fixture.state.seekAudio(5);await fixture.state.seekAudio(-5);
        expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([
            {type:'selectionTtsSeek',clientRequestId:'tts-client-1',offsetSeconds:5},
            {type:'selectionTtsSeek',clientRequestId:'tts-client-1',offsetSeconds:-5},
        ]);
        expect(fixture.state.audioPosition).toEqual({currentTime:2,duration:12});
        const delayed=deferredTts();fixture.browser.runtime.sendMessage.mockImplementation(message=>message.type==='selectionTtsSeek'?delayed.promise:Promise.resolve({success:true}));
        const jump=fixture.state.seekAudio(5);fixture.state.stopAudio();delayed.resolve({success:false});await jump;
        expect(fixture.state.audioPosition).toBeNull();expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.state.playbackTime(65.9)).toBe('1:05');
    });

    it('page audio jumps by 5 seconds, updates text immediately and clears its sampling timer on stop', async () => {
        const fixture=mountSelection();const audios:FakeSeekAudio[]=[];
        class FakeSeekAudio {
            currentTime=2;duration=12;ontimeupdate:((event?:Event)=>void)|null=null;
            play=vi.fn(async()=>undefined);pause=vi.fn();removeAttribute=vi.fn();
            constructor(public src:string){audios.push(this);}
        }
        vi.stubGlobal('Audio',FakeSeekAudio);
        await fixture.state.playExternalAudio('https://audio','Hello world','source','Hello world',0);
        await fixture.state.seekAudio(5);expect(audios[0].currentTime).toBe(7);
        expect(fixture.state.audioPosition).toEqual({currentTime:7,duration:12});expect(fixture.state.audioProgress.start).toBe(6);
        await fixture.state.seekAudio(-5);await fixture.state.seekAudio(-5);expect(audios[0].currentTime).toBe(0);
        expect(fixture.state.audioProgress.start).toBe(0);
        await fixture.state.seekAudio(5);await fixture.state.seekAudio(5);await fixture.state.seekAudio(5);expect(audios[0].currentTime).toBe(12);
        expect(audios[0].play).toHaveBeenCalledOnce();expect(ttsMessages(fixture,'selectionTtsSeek')).toEqual([]);
        fixture.state.stopAudio();expect(fixture.state.audioPosition).toBeNull();
        const stopped=fixture.state.audioProgress;await vi.advanceTimersByTimeAsync(500);expect(fixture.state.audioProgress).toBe(stopped);
    });
    it.each(['source', 'translation'] as const)('keeps %s in preparation until synthesis succeeds', async kind => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('  Practice helps.  ', kind);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.audioProgress).toBeNull();
        expect(fixture.state.currentAudioKind).toBe(kind);
        expect(fixture.state.currentAudioText).toBe('Practice helps.');
        expect(ttsMessages(fixture, 'selectionTts')).toEqual([
            expect.objectContaining({text: 'Practice helps.', clientRequestId: 'tts-client-1'}),
        ]);
        await vi.advanceTimersByTimeAsync(500);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe(kind);
        expect(fixture.state.currentAudioKey).toBe('Practice helps.');
        expect(fixture.state.noticeMessage).toBe('');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it.each(['response', 'rejection'] as const)('resets preparation and displays an error after synthesis %s', async failure => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.isPreparingAudio).toBe(true);
        if (failure === 'response') response.resolve({success: false, error: '模型推理失败'});
        else response.reject(new Error('worker disconnected'));
        await pending;
        expectAudioReset(fixture.state);
        expect(fixture.state.noticeMessage).toBe(failure === 'response' ? '模型推理失败' : '本地语音生成失败，请重试');
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([]);
        if (failure === 'rejection') expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({message: 'worker disconnected'}));
    });

    it.each(['stop button', 'same text toggle', 'unmount'] as const)('cancels pending synthesis via %s and discards late success', async action => {
        const fixture = mountSelection();
        const response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        if (action === 'stop button') fixture.state.stopAudioFromUi();
        else if (action === 'same text toggle') await fixture.state.toggleAudio('Practice helps.', 'source');
        else fixture.unmount();
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(true);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId}]);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        // STOP 可以先于远端 PLAY 生效；迟到成功须再次精确停止旧请求。
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([
            {type: 'selectionTtsStop', clientRequestId}, {type: 'selectionTtsStop', clientRequestId},
        ]);
        expect(fixture.state.noticeMessage).toBe('');
    });

    it.each(['success', 'failure', 'rejection'] as const)('ignores old synthesis %s while the replacement is playing', async outcome => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('新句子。', 'translation');
        const [oldRequest, newRequest] = ttsMessages(fixture, 'selectionTts');
        expect(oldRequest.clientRequestId).not.toBe(newRequest.clientRequestId);
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        const progress = {start: 0, end: 4, fraction: 0.5, estimated: true};
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).toContain(true);
        if (outcome === 'success') oldResponse.resolve({success: true, transport: 'offscreen'});
        else if (outcome === 'failure') oldResponse.resolve({success: false, error: 'old model failed'});
        else oldResponse.reject(new Error('old worker disconnected'));
        await oldPending;
        await Vue.nextTick();
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.currentAudioKind).toBe('translation');
        expect(fixture.state.currentAudioText).toBe('新句子。');
        expect(fixture.state.audioProgress).toEqual(progress);
        expect(fixture.state.noticeMessage).toBe('');
        expect(ttsMessages(fixture, 'selectionTtsStop').every(message => message.clientRequestId === oldRequest.clientRequestId)).toBe(true);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toHaveLength(outcome === 'success' ? 2 : 1);
    });

    it('does not clear replacement preparation when old synthesis completes first', async () => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('New sentence.', 'source');
        oldResponse.resolve({success: true, transport: 'offscreen'});
        await oldPending;
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.currentAudioText).toBe('New sentence.');
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
    });

    it('routes progress to the pending or active request and rejects old, unrelated and malformed progress', async () => {
        const fixture = mountSelection();
        const oldResponse = deferredTts(), newResponse = deferredTts();
        prepareTts(fixture, [oldResponse.promise, newResponse.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        oldResponse.resolve({success: true, transport: 'offscreen'});
        await oldPending;
        const newPending = fixture.state.toggleAudio('新句子。', 'translation');
        const [oldRequest, newRequest] = ttsMessages(fixture, 'selectionTts');
        const progress = {start: 0, end: 4, fraction: 0.25, estimated: true};
        expect(emitTtsState(fixture, oldRequest.clientRequestId, 'progress', {progress})).not.toContain(true);
        expect(emitTtsState(fixture, 'another-card', 'progress', {progress})).not.toContain(true);
        expect(fixture.state.audioProgress).toBeNull();
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).toContain(true);
        expect(fixture.state.audioProgress).toEqual(progress);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.audioProgressFor('translation')).toBeNull();
        newResponse.resolve({success: true, transport: 'offscreen'});
        await newPending;
        expect(fixture.state.audioProgressFor('translation')).toEqual(progress);
        expect(fixture.state.audioProgressFor('source')).toBeNull();
        emitTtsState(fixture, oldRequest.clientRequestId, 'progress', {progress: {...progress, fraction: 0.9}});
        expect(fixture.state.audioProgress).toEqual(progress);
        emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress: {...progress, fraction: Number.NaN}});
        expect(fixture.state.audioProgress).toBeNull();
        fixture.state.stopAudioFromUi();
        expect(emitTtsState(fixture, newRequest.clientRequestId, 'progress', {progress})).not.toContain(true);
        expectAudioReset(fixture.state);
    });

    it.each(['ended', 'stopped', 'error'] as const)('resets playback on matching %s without stopping the remote again', async terminal => {
        const fixture = mountSelection();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        emitTtsState(fixture, clientRequestId, 'progress', {progress: {start: 0, end: 15, fraction: 0.5, estimated: true}});
        expect(emitTtsState(fixture, 'another-card', terminal, {error: '其他卡片错误'})).not.toContain(true);
        expect(fixture.state.isPlaying).toBe(true);
        expect(emitTtsState(fixture, clientRequestId, terminal, {error: '音频解码失败'})).toContain(true);
        expectAudioReset(fixture.state);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        await Vue.nextTick();
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([]);
        expect(fixture.state.noticeMessage).toBe(terminal === 'error' ? '音频解码失败' : '');
    });
});

describe('SelectionTranslator word TTS generation and fallback', () => {
    const pronunciation = {text: 'American pronunciation', label: '美式'};

    function beginWordTts(fixture: ReturnType<typeof mountSelection>, response: ReturnType<typeof deferredTts>) {
        fixture.state.wordCard = {word: 'hello'};
        prepareTts(fixture, [response.promise]);
        return fixture.state.toggleWordAudio(pronunciation);
    }

    function browserSpeech(fixture: ReturnType<typeof mountSelection>) {
        const speak = vi.fn();
        Object.assign(fixture.window.speechSynthesis, {getVoices: () => [], speak});
        vi.stubGlobal('SpeechSynthesisUtterance', class {
            constructor(public text: string) {}
        });
        return speak;
    }

    it.each(['offscreen', 'page'] as const)('keeps word generation pending then restores the pronunciation key after %s playback', async transport => {
        const fixture = mountSelection();
        const response = deferredTts();
        const audios: Array<{play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>}> = [];
        vi.stubGlobal('Audio', class {
            preload = '';
            play = vi.fn(async () => undefined);
            pause = vi.fn();
            removeAttribute = vi.fn();
            constructor() { audios.push(this); }
        });
        const pending = beginWordTts(fixture, response);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.currentAudioText).toBe('hello');
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        await vi.advanceTimersByTimeAsync(500);
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.isPlaying).toBe(false);
        response.resolve({success: true, transport, ...(transport === 'page' ? {audioBase64: 'YQ==', contentType: 'audio/mpeg'} : {})});
        await pending;
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        expect(fixture.state.isCurrentWordAudio(pronunciation)).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual(transport === 'offscreen'
            ? [{type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}] : []);
        if (transport === 'page') {
            expect(audios[0].play).toHaveBeenCalledOnce();
            expect(audios[0].pause).toHaveBeenCalledOnce();
        }
    });

    it('cancels the same pronunciation key during generation and never adopts its late result', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const pending = beginWordTts(fixture, response);
        expect(fixture.state.isPreparingAudio).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}]);
        response.resolve({success: true, transport: 'offscreen'});
        await pending;
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([
            {type: 'selectionTtsStop', clientRequestId: 'tts-client-1'}, {type: 'selectionTtsStop', clientRequestId: 'tts-client-1'},
        ]);
    });

    it.each([
        ['inference failure', {success: false, error: '单词推理失败'}, '单词推理失败', null],
        ['model missing', {success: false, errorCode: 'local-tts-model-not-downloaded'}, 'selectionTts.localModelNotDownloaded', 'open-local-tts'],
        ['language unsupported', {success: false, errorCode: 'local-tts-language-unsupported'}, 'selectionTts.languageUnsupported', null],
    ])('clears local-only word ownership and displays the notice for %s', async (_kind, failure, notice, action) => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        const pending = beginWordTts(fixture, response);
        const generation = fixture.state.ttsContentController.currentGeneration();
        response.resolve(failure as Record<string, unknown>);
        await pending;
        expectAudioReset(fixture.state);
        expect(fixture.state.ttsContentController.currentGeneration()).toBeGreaterThan(generation);
        expect(fixture.state.noticeMessage).toBe(notice);
        expect(fixture.state.noticeAction).toBe(action);
        expect(fixture.stopTts).toHaveBeenLastCalledWith(false);
        expect(speak).not.toHaveBeenCalled();
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([]);
    });

    it('continues to browser speech when the EdgeSpeechResult object has handled=false', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        fixture.state.wordCard = {word: 'hello'};
        prepareTts(fixture, [response.promise]);
        fixture.config.selectionTtsMode = 'online-only';
        const pending = fixture.state.toggleWordAudio({text: 'hello'});
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(speak).toHaveBeenCalledOnce();
        expect(speak).toHaveBeenCalledWith(expect.objectContaining({text: 'hello', lang: 'en-US'}));
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.isCurrentWordAudio({text: 'hello'})).toBe(true);
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([]);
    });

    it('preserves the selected pronunciation key after browser fallback so the next click stops playback', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        const speak = browserSpeech(fixture);
        const pending = beginWordTts(fixture, response);
        fixture.config.selectionTtsMode = 'online-only';
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(speak).toHaveBeenCalledOnce();
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        expect(fixture.state.isCurrentWordAudio(pronunciation)).toBe(true);
        await fixture.state.toggleWordAudio(pronunciation);
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTts')).toHaveLength(1);
    });

    it('continues to Google offscreen fallback and keeps a distinct pronunciation key cancellable', async () => {
        const fixture = mountSelection();
        const response = deferredTts();
        fixture.state.wordCard = {word: 'hello'};
        fixture.config.selectionTtsMode = 'online-only';
        fixture.browser.runtime.sendMessage.mockImplementation((message: any) => message.type === 'selectionTts'
            ? response.promise : Promise.resolve({success: true, transport: 'offscreen'}));
        const pending = fixture.state.toggleWordAudio(pronunciation);
        response.resolve({success: false, error: 'Edge offline'});
        await pending;
        expect(ttsMessages(fixture, 'selectionTtsGoogle')).toEqual([
            expect.objectContaining({text: 'hello', language: 'en-US', clientRequestId: 'tts-client-2'}),
        ]);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKey).toBe(pronunciation.text);
        await fixture.state.toggleWordAudio(pronunciation);
        await Vue.nextTick();
        expectAudioReset(fixture.state);
        expect(ttsMessages(fixture, 'selectionTtsStop')).toEqual([{type: 'selectionTtsStop', clientRequestId: 'tts-client-2'}]);
    });

    it('follows external word pronunciation using actual media time and ignores timeupdate after stop', async () => {
        const fixture = mountSelection();
        const audios: PronunciationAudio[] = [];
        class PronunciationAudio {
            currentTime = 0;
            duration = 4;
            ontimeupdate: (() => void) | null = null;
            play = vi.fn(async () => undefined);
            pause = vi.fn();
            removeAttribute = vi.fn();
            constructor(public src: string) { audios.push(this); }
        }
        vi.stubGlobal('Audio', PronunciationAudio);
        fixture.state.wordCard = {word: 'hello'};
        const pronunciation = {audio: 'https://dictionary.test/hello.mp3', label: '美式'};
        await fixture.state.toggleWordAudio(pronunciation);
        expect(fixture.state.isPreparingAudio).toBe(false);
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.currentAudioKind).toBe('word');
        expect(fixture.state.currentAudioKey).toBe(pronunciation.audio);
        expect(fixture.state.audioProgress).toEqual({start:0,end:5,fraction:0,estimated:true});
        expect(fixture.state.audioPosition).toEqual({currentTime:0,duration:4});
        expect(ttsMessages(fixture, 'selectionTts')).toEqual([]);
        const audio = audios[0];
        expect(audio.src).toBe(pronunciation.audio);
        expect(audio.play).toHaveBeenCalledOnce();
        expect(audio.ontimeupdate).toBeTypeOf('function');
        audio.currentTime = 2;
        audio.ontimeupdate?.();
        expect(fixture.state.audioProgressFor('word')).toEqual({start: 0, end: 5, fraction: 0.5, estimated: true});
        expect(fixture.state.audioProgressFor('source')).toBeNull();
        audio.currentTime = 1;
        audio.ontimeupdate?.();
        expect(fixture.state.audioProgressFor('word')).toEqual({start: 0, end: 5, fraction: 0.25, estimated: true});
        const staleTimeupdate = audio.ontimeupdate;
        await fixture.state.toggleWordAudio(pronunciation);
        expectAudioReset(fixture.state);
        expect(audio.pause).toHaveBeenCalledOnce();
        expect(audio.removeAttribute).toHaveBeenCalledWith('src');
        audio.currentTime = 3;
        staleTimeupdate?.();
        expectAudioReset(fixture.state);
        expect(audios).toHaveLength(1);
    });
});

describe('SelectionTranslator trimmed speech offsets in rich text', () => {
    it.each([
        ['source', '  ', 'x', ''],
        ['translation', '\t\uFEFF', 'x', '  '],
        ['source', '  ', '😀x', '\t'],
        ['translation', '', 'x', '  '],
    ] as const)('maps %s trimmed speech into the original code/text parts (%j, %j)', async (kind, leading, code, trailing) => {
        const fixture = mountSelection();
        const parts = [{kind: 'code', text: leading + code}, {kind: 'text', text: ' hello' + trailing}];
        const text = parts.map(part => part.text).join('');
        if (kind === 'source') {
            fixture.state.selectedText = text;
            fixture.state.snapshot = {text, parts};
        } else {
            fixture.state.translationResult = text;
            fixture.state.translationParts = parts;
        }
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio(text, kind);
        expect(ttsMessages(fixture, 'selectionTts')[0].text).toBe(text.trim());
        const trimmedStart = text.trim().indexOf('hello');
        const rawProgress = {start: trimmedStart, end: trimmedStart + 5, fraction: 0.5, estimated: true};
        emitTtsState(fixture, 'tts-client-1', 'progress', {progress: rawProgress});
        expect(fixture.state.audioProgress).toEqual(rawProgress);
        const displayed = fixture.state.audioProgressFor(kind);
        expect(displayed).toEqual({...rawProgress, start: text.indexOf('hello'), end: text.indexOf('hello') + 5});
        expect(fixture.state.audioTextOffset).toBe(leading.length);
        expect(fixture.state.audioProgressFor(kind === 'source' ? 'translation' : 'source')).toBeNull();
        const displayedParts = kind === 'source' ? fixture.state.sourceTextParts : fixture.state.translatedTextParts;
        const offset = displayedParts[1].offset;
        expect(offset).toBe(leading.length + code.length);
        expect(speechProgress.speechTextSlices(displayedParts[1].text, offset, displayed)).toEqual({
            before: ' ', active: 'hello', after: trailing, fraction: 0.5,
        });
        expect(displayedParts[0].text).toBe(leading + code);
        expect(displayedParts.map((part: {text: string}) => part.text).join('')).toBe(text);
        fixture.state.stopAudioFromUi();
        expect(fixture.state.audioTextOffset).toBe(0);
        expect(fixture.state.audioProgressFor(kind)).toBeNull();
        expectAudioReset(fixture.state);
    });

    it.each(['source', 'translation'] as const)('preserves the %s trim offset when remote error falls back to browser word boundaries', async kind => {
        const fixture = mountSelection();
        const text = '  x hello';
        const parts = [{kind: 'code', text: '  x'}, {kind: 'text', text: ' hello'}];
        if (kind === 'source') {
            fixture.state.selectedText = text;
            fixture.state.snapshot = {text, parts};
        } else {
            fixture.state.translationResult = text;
            fixture.state.translationParts = parts;
        }
        const speak = vi.fn();
        Object.assign(fixture.window.speechSynthesis, {getVoices: () => [], speak});
        vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        fixture.config.selectionTtsMode = 'online-only';
        await fixture.state.toggleAudio(text, kind);
        expect(fixture.state.audioTextOffset).toBe(2);
        expect(emitTtsState(fixture, 'tts-client-1', 'error', {error: 'decode failed'})).toContain(true);
        expect(speak).toHaveBeenCalledOnce();
        const utterance = speak.mock.calls[0][0];
        expect(utterance.text).toBe('x hello');
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.audioTextOffset).toBe(2);
        utterance.onboundary({charIndex: 2, charLength: 5});
        const displayed = fixture.state.audioProgressFor(kind);
        expect(displayed).toEqual({start: 4, end: 9, fraction: 1, estimated: false});
        expect(speechProgress.speechTextSlices(parts[1].text, (kind === 'source' ? fixture.state.sourceTextParts : fixture.state.translatedTextParts)[1].offset, displayed)).toEqual({
            before: ' ', active: 'hello', after: '', fraction: 1,
        });
        fixture.state.stopAudioFromUi();
        expect(fixture.state.audioTextOffset).toBe(0);
        expectAudioReset(fixture.state);
    });
});

it('keeps an existing ordinary translation running when opening the learning view', async () => {
    const fixture = mountSelection();
    fixture.config.harness.enabled = true;
    fixture.state.selectionConfigVersion += 1;
    await Vue.nextTick();
    const pending = new AbortController();
    fixture.state.snapshot = {text: 'Practice helps.', range: {}, parts: [{kind: 'text', text: 'Practice helps.'}]};
    fixture.state.readingSelection = {text: 'Practice helps.', context: '', sentence: 'Practice helps.'};
    fixture.state.activeContentRequest = {text: 'Practice helps.', generation: 1, sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};
    fixture.state.translationAbortController = pending;
    fixture.state.isLoading = true;
    fixture.state.openReadingCard();
    expect(fixture.state.readingMode).toBe(true);
    expect(pending.signal.aborted).toBe(false);
    fixture.unmount();
    expect(pending.signal.aborted).toBe(true);
});


describe('selection card geometry across content changes', () => {
    it('preserves the opening position across learning tabs and expanding content', async () => {
        const {state} = mountSelection();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 388, height: 180})};
        state.manualPopupPosition = {left: 220, top: 410};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px', maxHeight: '378px'});
        state.readingMode = true;
        await Vue.nextTick();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 388, height: 520})};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px', maxHeight: '378px'});
        state.readingMode = false;
        await Vue.nextTick();
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '220px', top: '410px'});
    });
    it('preserves a resized card and clamps it only when the viewport shrinks', () => {
        const {state, window} = mountSelection();
        state.tooltipRef = {getBoundingClientRect: () => ({width: 450, height: 240})};
        state.manualPopupPosition = {left: 510, top: 490};
        state.manualPopupSize = {width: 450, height: 240};
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '510px', top: '490px', width: '450px', height: '240px'});
        window.innerWidth = 390; window.innerHeight = 400;
        state.applyManualPopupGeometry();
        expect(state.tooltipStyle).toMatchObject({left: '12px', top: '248px', width: '366px', height: '140px'});
    });
});

describe('automatic card audio height ownership', () => {
    async function audioCard() {
        const fixture = mountSelection();
        const cardRect = vi.fn(() => ({width: 388, height: 180}));
        fixture.state.tooltipRef = {getBoundingClientRect: cardRect};
        fixture.state.snapshot = {text: 'Practice helps.', range: {getClientRects: vi.fn(() => [])}};
        fixture.state.selectedText = 'Practice helps.';
        fixture.state.manualPopupPosition = {left: 200, top: 100};
        fixture.state.showTooltip = true;
        await Vue.nextTick(); await Vue.nextTick();
        fixture.state.applyManualPopupGeometry();
        return {...fixture, cardRect};
    }

    it.each(['source', 'word'] as const)('holds the automatic %s card during preparation and playback without adopting a manual size', async kind => {
        const fixture = await audioCard(), response = deferredTts();
        prepareTts(fixture, [response.promise]);
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        const pending = kind === 'word' ? fixture.state.toggleWordAudio({text: 'Practice helps.'})
            : fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px', height: '180px'});
        expect(fixture.state.manualPopupSize).toBeNull();
        const capturedReads = fixture.cardRect.mock.calls.length;
        response.resolve({success: true, transport: 'offscreen'}); await pending;
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        for (let index = 0; index < 20; index++) emitTtsState(fixture, clientRequestId, 'progress', {
            progress: {start: 0, end: 8, fraction: index / 20, estimated: true},
        });
        expect(fixture.state.isPlaying).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        expect(fixture.cardRect).toHaveBeenCalledTimes(capturedReads);
        fixture.state.stopAudioFromUi();
        expect(fixture.state.audioPopupHeight).toBeNull();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        expect(fixture.state.manualPopupPosition).toEqual({left: 200, top: 100});
    });

    it.each(['ended', 'stopped', 'error'] as const)('releases only the matching automatic audio height on %s', async terminal => {
        const fixture = await audioCard();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        const {clientRequestId} = ttsMessages(fixture, 'selectionTts')[0];
        emitTtsState(fixture, 'another-card', terminal, {error: 'Unrelated error'});
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        emitTtsState(fixture, clientRequestId, terminal, {error: 'Controlled decode failure'});
        expect(fixture.state.audioPopupHeight).toBeNull();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
    });

    it('keeps a replacement height owned when the previous synthesis finishes late', async () => {
        const fixture = await audioCard(), oldResponse = deferredTts(), replacement = deferredTts();
        prepareTts(fixture, [oldResponse.promise, replacement.promise]);
        const oldPending = fixture.state.toggleAudio('Old sentence.', 'source');
        const newPending = fixture.state.toggleAudio('New sentence.', 'source');
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        oldResponse.resolve({success: true, transport: 'offscreen'}); await oldPending;
        expect(fixture.state.isPreparingAudio).toBe(true);
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        expect(fixture.state.manualPopupSize).toBeNull();
        replacement.resolve({success: true, transport: 'offscreen'}); await newPending;
        emitTtsState(fixture, ttsMessages(fixture, 'selectionTts')[0].clientRequestId, 'ended');
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
    });

    it('keeps an existing user size authoritative through preparation playback and stop', async () => {
        const fixture = await audioCard(), response = deferredTts();
        fixture.state.manualPopupSize = {width: 450, height: 240};
        fixture.state.applyManualPopupGeometry();
        fixture.cardRect.mockClear();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.audioPopupHeight).toBeNull();
        response.resolve({success: true, transport: 'offscreen'}); await pending;
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '450px', height: '240px'});
        expect(fixture.state.manualPopupSize).toEqual({width: 450, height: 240});
        expect(fixture.cardRect).not.toHaveBeenCalled();
    });

    it.each(['stop', 'hide', 'unmount', 'failure'] as const)('does not retain or restore the audio layout after %s', async reason => {
        const fixture = await audioCard(), response = deferredTts();
        prepareTts(fixture, [response.promise]);
        const pending = fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.tooltipStyle.height).toBe('180px');
        if (reason === 'stop') fixture.state.stopAudio();
        else if (reason === 'hide') fixture.state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        response.resolve(reason === 'failure' ? {success: false, error: 'Controlled synthesis failure', errorCode: 'local-only-error'}
            : {success: true, transport: 'offscreen'});
        await pending; await Vue.nextTick();
        expect(fixture.state.audioPopupHeight).toBeNull();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
        expect(fixture.state.manualPopupSize).toBeNull();
        expect(fixture.state.isPlaying).toBe(false);
    });

    it('clamps a temporary audio height to a smaller viewport without turning it into a user size', async () => {
        const fixture = await audioCard();
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        fixture.window.innerHeight = 180;
        fixture.state.handleViewportResize();
        await vi.advanceTimersByTimeAsync(20);
        const top = parseFloat(fixture.state.tooltipStyle.top), height = parseFloat(fixture.state.tooltipStyle.height);
        expect(top).toBeGreaterThanOrEqual(12);
        expect(top + height).toBeLessThanOrEqual(168);
        expect(fixture.state.manualPopupSize).toBeNull();
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle.height).toBeUndefined();
    });
});

describe('context menu selection ownership', () => {
    async function prepareMenu(browserTarget: SelectionBuildTarget = 'chrome') {
        const fixture = mountSelection(false, undefined, browserTarget);
        class FakeElement {}
        class FakeNode {}
        vi.stubGlobal('Element', FakeElement);
        vi.stubGlobal('Node', FakeNode);
        let nativeText = 'Good ideas deserve attention.';
        const paragraph = {nodeType: 1, tagName: 'P', parentElement: null,
            getAttribute: () => null, hasAttribute: () => false, closest: () => null,
            querySelector: () => null, querySelectorAll: () => []};
        const node = {nodeType: 3, parentElement: paragraph, isConnected: true, ownerDocument: fixture.document};
        const range = Vue.markRaw({startContainer: node, endContainer: node, commonAncestorContainer: node,
            startOffset: 0, endOffset: nativeText.length, collapsed: false,
            getClientRects: vi.fn(() => [{left: 200, right: 380, top: 250, bottom: 270, width: 180, height: 20}]),
            cloneRange: () => range, toString: () => nativeText});
        const selection = {rangeCount: 1, isCollapsed: false, anchorNode: node, anchorOffset: 0,
            getRangeAt: () => range, toString: () => nativeText};
        const getSelection = vi.fn((): typeof selection | null => selection);
        Object.assign(fixture.window, {getSelection});
        fixture.config.selectionTranslatorTrigger = 'contextMenu';
        fixture.config.selectionTranslatorDelay = 9000;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        const rightDown = () => fixture.state.handlePointerDown({isTrusted: true, button: 2, target: null});
        const openMenu = () => {rightDown(); fixture.state.handleContextMenu({isTrusted: true, target: null});};
        const inputTarget = Object.assign(new FakeElement(), {closest: () => ({}), getAttribute: () => null});
        const uiTarget = Object.assign(new FakeNode(), {getRootNode: () => fixture.document});
        return {...fixture, node, paragraph, range, getSelection, rightDown, openMenu, selection,
            inputTarget, uiTarget, setText: (text: string) => {nativeText = text;}};
    }

    it('forwards the browser-bound text through the bridge without retaining a replaced handler', () => {
        const first = vi.fn(() => false), second = vi.fn(() => true);
        const releaseFirst = setSelectionContextMenuHandler(first);
        const releaseSecond = setSelectionContextMenuHandler(second);
        releaseFirst();
        expect(translateSelectionThroughBridge('Good ideas deserve attention.')).toBe(true);
        expect(second).toHaveBeenCalledWith('Good ideas deserve attention.');
        expect(first).not.toHaveBeenCalled();
        releaseSecond();
        expect(translateSelectionThroughBridge('Good ideas deserve attention.')).toBe(false);
    });

    it.each(['chrome', 'userscript'] as const)('registers and cleans native listeners only for the extension target %s while keeping its live-selection bridge', browserTarget => {
        const fixture = mountSelection(false, undefined, browserTarget);
        expect(fixture.registerContextMenu).toHaveBeenCalledOnce();
        expect(fixture.listeners.get('document:contextmenu')?.size ?? 0).toBe(browserTarget === 'chrome' ? 1 : 0);
        fixture.unmount();
        expect(fixture.listeners.get('document:contextmenu')?.size ?? 0).toBe(0);
        expect(fixture.document.removeEventListener.mock.calls.some(([type]) => type === 'contextmenu')).toBe(browserTarget === 'chrome');
        expect(fixture.releaseContextMenu).toHaveBeenCalledOnce();
    });

    it('keeps userscript right-click dismissal and its live-selection message bridge without native menu capture or suppressed ownership', async () => {
        const fixture = await prepareMenu('userscript');
        fixture.config.selectionTranslatorTrigger = 'icon';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.translateText.mockImplementation(() => new Promise(() => {}));
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        fixture.state.openTooltip();
        const firstController = fixture.state.translationAbortController;
        fixture.rightDown();
        expect(firstController.signal.aborted).toBe(true);
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.snapshot).toBeNull();
        expect(fixture.state.suppressSelectionUntil).toBe(0);
        expect(fixture.state.contextMenuSelection).toBeNull();
        expect(fixture.contextMenuHandler('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        expect(fixture.state.showTooltip).toBe(true);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.contextMenuHandler('Good ideas deserve attention.')).toBe(false);
        fixture.state.applySelection(null);
        await vi.advanceTimersByTimeAsync(161);
        expect(fixture.state.showTooltip).toBe(false);
        expect(fixture.state.contextMenuSourceRejected).toBe(false);
    });

    it('restores only the menu-captured Range after selection collapse and blur, without waiting for configured delay', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        fixture.state.handleWindowBlur();
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(200);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.state.translateSelectionFromContextMenu('  Good  ideas deserve attention.  ')).toBe(true);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('这是译文');
        expect(fixture.lifecycleErrors).not.toHaveBeenCalled();
    });

    it('cancels a pending direct-mode presentation before a native menu collapses Selection', async () => {
        const fixture = await prepareMenu();
        fixture.config.selectionTranslatorTrigger = 'direct';
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        expect(fixture.state.selectionPresentationTimer).not.toBeNull();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(9001);
        expect(fixture.translateText).not.toHaveBeenCalled();
        expect(fixture.state.selectionPresentationTimer).toBeNull();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('cancels an existing entry dismissal and rejects new pointer dismissal while the native menu owns Selection', async () => {
        const fixture = await prepareMenu();
        fixture.config.selectionTranslatorTrigger = 'dot';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.config.selectionTranslatorAutoDismiss = true;
        fixture.state.selectionConfigVersion += 1;
        await Vue.nextTick();
        fixture.state.applySelection(fixture.state.readSelectionSnapshot());
        const pointer = {isTrusted: true, pointerType: 'mouse', clientX: 900, clientY: 750, target: null};
        fixture.state.handlePointerMove(pointer);
        expect(fixture.state.entryDismissTimer).not.toBeNull();
        fixture.openMenu();
        expect(fixture.state.entryDismissTimer).toBeNull();
        fixture.state.handlePointerMove(pointer);
        expect(fixture.state.entryDismissTimer).toBeNull();
        fixture.getSelection.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(601);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('keeps an in-flight request intact through repeated right clicks and duplicate menu commands', async () => {
        const fixture = await prepareMenu();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        const controller = fixture.state.translationAbortController;
        const request = fixture.state.activeContentRequest;
        fixture.openMenu();
        expect(controller.signal.aborted).toBe(false);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.state.activeContentRequest).toBe(request);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        finish('好想法值得关注。'); await Vue.nextTick();
        expect(fixture.state.translationResult).toBe('好想法值得关注。');
        expect(controller.signal.aborted).toBe(false);
    });

    it('reuses a completed card, then starts a fresh request after explicit dismissal', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        await Vue.nextTick();
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
        expect(fixture.state.translationResult).toBe('这是译文');
        fixture.state.closeTooltip();
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
    });

    it('uses the captured geometry at command time instead of measuring the host selection again', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.range.getClientRects.mockClear();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.range.getClientRects).not.toHaveBeenCalled();
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('lets another explicit menu command retry a failed translation without discarding the selected text', async () => {
        const fixture = await prepareMenu();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        fixture.translateText.mockRejectedValueOnce(new Error('fixture request failure'));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        await Vue.nextTick();
        expect(fixture.state.error).toBe('翻译失败，请重试');
        expect(fixture.state.showTooltip).toBe(true);
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        await Vue.nextTick();
        expect(fixture.state.error).toBe('');
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('replaces an old request only when a different menu selection is explicitly translated and ignores its late response', async () => {
        const fixture = await prepareMenu();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        const previousController = fixture.state.translationAbortController;
        fixture.setText('New ideas deserve a chance.');
        fixture.openMenu();
        expect(previousController.signal.aborted).toBe(false);
        fixture.state.translateSelectionFromContextMenu('New ideas deserve a chance.');
        expect(previousController.signal.aborted).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(2);
        await Vue.nextTick();
        finish('旧选区的迟到结果'); await Vue.nextTick();
        expect(fixture.state.selectedText).toBe('New ideas deserve a chance.');
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('keeps an explicitly opened card when a later Selection change only clears the page highlight', async () => {
        const fixture = await prepareMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        fixture.getSelection.mockReturnValue(null);
        fixture.state.applySelection(null);
        await vi.advanceTimersByTimeAsync(200);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('rejects a browser text mismatch instead of translating a different live selection or stale menu capture', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        expect(fixture.state.translateSelectionFromContextMenu('A different sentence.')).toBe(false);
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('A different sentence.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('never turns a bare browser text or untrusted contextmenu event into a translatable selection', async () => {
        const fixture = await prepareMenu();
        fixture.state.handleContextMenu({isTrusted: false, target: null});
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('returns a missing selection response when the host Range becomes unreadable instead of throwing from the menu handler', async () => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.range.toString = () => {throw new Error('fixture disposed range');};
        fixture.getSelection.mockImplementation(() => {throw new Error('fixture disposed document');});
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('does not capture protected input text for a later browser text fallback', async () => {
        const fixture = await prepareMenu();
        fixture.paragraph.tagName = 'INPUT';
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('rejects a menu opened in an input even when document Selection retains identical text from the page', async () => {
        const fixture = await prepareMenu();
        fixture.state.handleContextMenu({isTrusted: true, target: fixture.inputTarget});
        fixture.state.handleWindowBlur();
        expect(fixture.state.readSelectionSnapshot()).not.toBeNull();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });

    it('invalidates a previous page capture when a trusted menu opens inside the card without cancelling its translation', async () => {
        const fixture = await prepareMenu();
        fixture.translateText.mockImplementation(() => new Promise(() => {}));
        fixture.openMenu();
        fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.');
        const controller = fixture.state.translationAbortController;
        fixture.document.getElementById.mockReturnValue(fixture.uiTarget as any);
        fixture.state.handleContextMenu({isTrusted: true, target: fixture.uiTarget});
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.state.contextMenuSelection).toBeNull();
        expect(controller.signal.aborted).toBe(false);
        expect(fixture.state.showTooltip).toBe(true);
        expect(fixture.translateText).toHaveBeenCalledTimes(1);
    });

    it('allows a contenteditable=false text island while rejecting inherited editable targets', async () => {
        const fixture = await prepareMenu();
        const editableParent = {getAttribute: () => 'true', parentElement: null};
        const target = Object.assign(Object.create(Object.getPrototypeOf(fixture.inputTarget)), {
            closest: () => null, getAttribute: () => 'false', parentElement: editableParent,
        });
        expect(fixture.state.isContextMenuInputTarget(target)).toBe(false);
        target.getAttribute = () => null;
        expect(fixture.state.isContextMenuInputTarget(target)).toBe(true);
    });

    it.each(['disconnected', 'foreign-document', 'collapsed', 'text-changed', 'protected'] as const)(
        'rechecks captured source ownership and rejects %s ranges', async reason => {
            const fixture = await prepareMenu();
            fixture.openMenu();
            if (reason === 'disconnected') fixture.node.isConnected = false;
            else if (reason === 'foreign-document') fixture.node.ownerDocument = {} as typeof fixture.document;
            else if (reason === 'collapsed') fixture.range.collapsed = true;
            else if (reason === 'text-changed') fixture.setText('A new sentence in the same node.');
            else fixture.paragraph.tagName = 'TEXTAREA';
            expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
            expect(fixture.translateText).not.toHaveBeenCalled();
        },
    );

    it.each(['pointer', 'escape', 'scroll', 'close'] as const)('discards a menu capture after a new %s interaction', async reason => {
        const fixture = await prepareMenu();
        fixture.openMenu();
        fixture.getSelection.mockReturnValue(null);
        if (reason === 'pointer') fixture.state.handlePointerDown({isTrusted: true, button: 0, target: null});
        else if (reason === 'escape') fixture.state.handleKeydown({isTrusted: true, key: 'Escape', target: null});
        else if (reason === 'scroll') fixture.state.handleScroll({target: null});
        else fixture.state.closeTooltip();
        expect(fixture.state.translateSelectionFromContextMenu('Good ideas deserve attention.')).toBe(false);
        expect(fixture.translateText).not.toHaveBeenCalled();
    });
});

describe('selection card on an extension PDF page', () => {
    function preparePdf() {
        const acceptsRange = vi.fn(() => true);
        const context = vi.fn(() => ({text: 'The Transformer uses attention.', title: 'Attention Is All You Need', sourceUrl: 'https://arxiv.org/pdf/1706.03762'}));
        const captureReading = vi.fn(() => ({text: 'Transformer models', context: 'The Transformer uses attention.', sentence: 'The Transformer uses attention.'}));
        let invalidate = () => {};
        const unsubscribeSource = vi.fn();
        const extractText = vi.fn((_range: Range, text: string) => text);
        const fixture = mountSelection(false, {acceptsRange, extractText, normalizeText: (text: string) => text.replace(/\s+/g, ' ').trim(), context, captureReading,
            subscribeInvalidation: (listener: () => void) => {invalidate = listener; return unsubscribeSource;}});
        class FakeElement {}
        class FakeNode {}
        vi.stubGlobal('Element', FakeElement);
        vi.stubGlobal('Node', FakeNode);
        const start = {isConnected: true, ownerDocument: fixture.document}, end = {isConnected: true, ownerDocument: fixture.document};
        const range = {startContainer: start, endContainer: end, startOffset: 0, endOffset: 18,
            getClientRects: () => [{left: 200, right: 380, top: 250, bottom: 270, width: 180, height: 20}],
            cloneRange: () => range};
        Vue.markRaw(range); // 原生 Range 不被 Vue 代理，测试对象也保持相同身份规则。
        Object.assign(fixture.window, {getSelection: () => ({rangeCount: 1, isCollapsed: false,
            anchorNode: start, anchorOffset: 0, getRangeAt: () => range, toString: () => 'Transformer\nmodels'})});
        fixture.config.selectionTranslatorTrigger = 'direct';
        fixture.config.selectionTranslatorDelay = 0;
        fixture.state.selectionConfigVersion += 1;
        return {...fixture, acceptsRange, extractText, context, captureReading, range, unsubscribeSource, invalidate: () => invalidate()};
    }

    it('only captures an adapter-approved source range and normalizes PDF wraps in the snapshot', () => {
        const fixture = preparePdf();
        fixture.acceptsRange.mockReturnValue(false);
        expect(fixture.state.readSelectionSnapshot()).toBeNull();
        expect(fixture.extractText).not.toHaveBeenCalled();
        fixture.acceptsRange.mockReturnValue(true);
        expect(fixture.state.readSelectionSnapshot()).toMatchObject({text: 'Transformer models', parts: [{kind: 'text', text: 'Transformer models'}]});
        expect(fixture.extractText).toHaveBeenCalledWith(fixture.range, 'Transformer\nmodels');
        fixture.extractText.mockReturnValue('First page footer.\nSecond page title.');
        expect(fixture.state.readSelectionSnapshot()).toMatchObject({text: 'First page footer. Second page title.'});
    });

    it('waits for pointer release and sends PDF context through the existing translation client', async () => {
        const fixture = preparePdf();
        const getSelection = (fixture.window as any).getSelection;
        (fixture.window as any).getSelection = () => null;
        fixture.state.handlePointerDown({isTrusted: true, button: 0, target: null});
        (fixture.window as any).getSelection = getSelection;
        fixture.state.handleSelectionChange({isTrusted: true});
        await vi.advanceTimersByTimeAsync(100);
        expect(fixture.translateText).not.toHaveBeenCalled();
        fixture.state.handlePointerUp({isTrusted: true, button: 0, target: null});
        await vi.advanceTimersByTimeAsync(32); await Vue.nextTick();
        expect(fixture.translateText).toHaveBeenCalledWith('Transformer models', 'Attention Is All You Need', expect.objectContaining({
            pageContext: 'The Transformer uses attention.', signal: expect.any(AbortSignal),
        }));
        expect(fixture.state.translationResult).toBe('这是译文');
    });

    it('aborts source requests and ignores late translations after the source owner invalidates', async () => {
        const fixture = preparePdf();
        let finish!: (text: string) => void;
        fixture.translateText.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.selectedText = 'Transformer models';
        const request = fixture.state.beginSelectionContentRequest('Transformer models');
        const pending = fixture.state.requestTranslation(request);
        const controller = fixture.state.translationAbortController;
        fixture.acceptsRange.mockReturnValue(false);
        fixture.invalidate();
        expect(controller.signal.aborted).toBe(true);
        expect(fixture.state.snapshot).toBeNull();
        finish('旧文件的迟到译文'); await pending;
        expect(fixture.state.translationResult).toBe('');
        fixture.unmount();
        expect(fixture.unsubscribeSource).toHaveBeenCalledOnce();
    });

    it('uses the adapter for PDF reading and vocabulary source metadata', async () => {
        const fixture = preparePdf();
        fixture.config.harness.enabled = true;
        fixture.config.vocabularyBookEnabled = true;
        fixture.state.selectionConfigVersion += 1;
        fixture.state.snapshot = fixture.state.readSelectionSnapshot();
        fixture.state.selectedText = 'Transformer models';
        const request = fixture.state.beginSelectionContentRequest('Transformer models');
        fixture.state.translationAnswer = {...request, answer: '模型'};
        fixture.state.translationResult = '模型';
        fixture.state.openReadingCard();
        expect(fixture.captureReading).toHaveBeenCalled();
        expect(fixture.state.readingSelection.context).toBe('The Transformer uses attention.');
        fixture.browser.runtime.sendMessage.mockResolvedValue({success: true, data: {id: 'saved'}});
        await fixture.state.saveVocabularyEntry({isTrusted: true});
        expect(fixture.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action: 'upsert', input: expect.objectContaining({context: expect.objectContaining({
            text: 'The Transformer uses attention.', sourceUrl: 'https://arxiv.org/pdf/1706.03762', pageTitle: 'Attention Is All You Need',
        })})}));
    });
});

it('相同译文隐藏后，切换选区与不同结果仍恢复显示', async () => {
    const {state, lifecycleErrors} = mountSelection();
    state.selectedText = 'Café'; state.translationResult = 'Cafe\u0301'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(false);
    state.translationResult = '咖啡馆'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(true);
    state.selectedText = '咖啡馆'; await Vue.nextTick();
    expect(state.hasDistinctTranslationResult).toBe(false);
    expect(lifecycleErrors).not.toHaveBeenCalled();
});


describe('selection card bounded layout work', () => {
    async function gestureFixture(edge = '') {
        const fixture = mountSelection();
        const frames = new Map<number, FrameRequestCallback>();
        let frameId = 0;
        fixture.window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.set(++frameId, callback); return frameId;
        }) as any;
        fixture.window.cancelAnimationFrame = vi.fn((id: any) => {frames.delete(id);});
        class GestureElement {
            dataset = {resizeEdge: edge};
            clientLeft = 0;
            clientWidth = 388;
            captured = false;
            getBoundingClientRect = vi.fn(() => ({left: 200, top: 100, right: 588, bottom: 340, width: 388, height: 240}));
            closest(selector: string) {return selector === '.fr-tooltip-header' ? this : null;}
            matches() {return false;}
            setPointerCapture() {this.captured = true;}
            hasPointerCapture() {return this.captured;}
            releasePointerCapture() {this.captured = false;}
        }
        vi.stubGlobal('HTMLElement', GestureElement);
        const element = new GestureElement();
        fixture.state.tooltipRef = element;
        fixture.state.snapshot = {text: 'Practice helps.', range: {getClientRects: vi.fn(() => [])}};
        fixture.state.showTooltip = true;
        fixture.state.manualPopupPosition = {left: 200, top: 100};
        await Vue.nextTick();
        const pointer = (type: string, x: number, y: number, pointerId = 1) => ({
            type, isTrusted: true, isPrimary: true, button: 0, pointerId, clientX: x, clientY: y,
            target: element, preventDefault: vi.fn(), stopPropagation: vi.fn(),
        });
        fixture.state.beginPopupGesture(pointer('pointerdown', 205, 110));
        const flush = () => {const pending = [...frames.values()];frames.clear();pending.forEach(callback => callback(0));};
        return {...fixture, element, frames, pointer, flush};
    }

    it('coalesces trusted pointer moves and paints only the last point without re-reading card geometry', async () => {
        const {state, element, frames, pointer, flush} = await gestureFixture();
        for (let i = 1; i <= 30; i++) state.movePopupGesture(pointer('pointermove', 205 + i, 110 + i));
        expect(frames.size).toBe(1);
        expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
        expect(state.manualPopupPosition).toEqual({left: 200, top: 100});
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '230px', top: '130px'});
        expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(0);
    });

    it('flushes the final accepted pointer point on release and rejects a late cancelled animation frame', async () => {
        const {state, element, frames, pointer} = await gestureFixture('se');
        state.movePopupGesture(pointer('pointermove', 255, 145));
        const lateFrame = [...frames.values()][0];
        state.stopPopupGesture(pointer('pointerup', 255, 145));
        expect(state.manualPopupSize).toEqual({width: 438, height: 275});
        expect(state.tooltipStyle).toMatchObject({width: '438px', height: '275px'});
        expect(element.captured).toBe(false);
        expect(frames.size).toBe(0);
        const settled = {...state.tooltipStyle};
        lateFrame(0);
        expect(state.tooltipStyle).toEqual(settled);
    });

    it('lets a real resize replace the temporary audio height and preserves that user size after audio stops', async () => {
        const fixture = await gestureFixture('se');
        prepareTts(fixture, [Promise.resolve({success: true, transport: 'offscreen'})]);
        await fixture.state.toggleAudio('Practice helps.', 'source');
        expect(fixture.state.audioPopupHeight).toBe(240);
        fixture.state.movePopupGesture(fixture.pointer('pointermove', 255, 145));
        fixture.state.stopPopupGesture(fixture.pointer('pointerup', 255, 145));
        expect(fixture.state.manualPopupSize).toEqual({width: 438, height: 275});
        expect(fixture.state.audioPopupHeight).toBeNull();
        fixture.state.stopAudio();
        expect(fixture.state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '438px', height: '275px'});
        expect(fixture.state.manualPopupSize).toEqual({width: 438, height: 275});
    });

    it.each(['pointercancel', 'lostpointercapture', 'blur', 'hide', 'unmount'])('discards pending moves after %s', async reason => {
        const fixture = await gestureFixture();
        const {state, frames, pointer} = fixture;
        state.movePopupGesture(pointer('pointermove', 255, 145));
        const lateFrame = [...frames.values()][0];
        if (reason === 'hide') state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        else if (reason === 'blur') state.handleWindowBlur();
        else state.stopPopupGesture(pointer(reason, 255, 145));
        const settled = {...state.tooltipStyle};
        expect(frames.size).toBe(0);
        expect(state.popupManipulating).toBe(false);
        lateFrame(0);
        expect(state.tooltipStyle).toEqual(settled);
    });

    it('ignores foreign pointer moves and release events while the current gesture remains owned', async () => {
        const {state, frames, pointer} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 255, 145, 2));
        expect(frames.size).toBe(0);
        state.stopPopupGesture(pointer('pointerup', 255, 145, 2));
        expect(state.popupManipulating).toBe(true);
        state.movePopupGesture({...pointer('pointermove', 255, 145), isTrusted: false});
        expect(frames.size).toBe(0);
    });

    it('keeps a new gesture frame intact when a cancelled old callback is delivered late', async () => {
        const {state, frames, pointer, flush} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 215, 120));
        const oldFrame = [...frames.values()][0];
        state.stopPopupGesture(pointer('pointercancel', 215, 120));
        state.beginPopupGesture(pointer('pointerdown', 205, 110));
        state.movePopupGesture(pointer('pointermove', 245, 150));
        oldFrame(0);
        expect(frames.size).toBe(1);
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '240px', top: '140px'});
    });

    it('does not remeasure the host selection for an anchored card, and needs no card read after manual resize', () => {
        const {state} = mountSelection();
        const range = {getClientRects: vi.fn(() => [])};
        const cardRect = vi.fn(() => ({width: 388, height: 240}));
        state.snapshot = {text: 'Practice helps.', range};
        state.tooltipRef = {getBoundingClientRect: cardRect};
        state.showTooltip = true;
        state.manualPopupPosition = {left: 200, top: 100};
        state.manualPopupSize = {width: 388, height: 240};
        for (let i = 0; i < 30; i++) state.updatePosition();
        expect(range.getClientRects).not.toHaveBeenCalled();
        expect(cardRect).not.toHaveBeenCalled();
        expect(state.tooltipStyle).toMatchObject({left: '200px', top: '100px', width: '388px', height: '240px'});
    });

    it.each(['hide', 'replacement', 'unmount'])('rejects the queued first anchor after %s', async reason => {
        const fixture = mountSelection();
        const {state} = fixture;
        const cardRect = vi.fn(() => ({width: 388, height: 240}));
        state.snapshot = {text: 'Practice helps.', range: {}, anchor: {left: 40, right: 150, top: 100, bottom: 120, width: 110, height: 20}, isForward: true};
        state.tooltipRef = {getBoundingClientRect: cardRect};
        state.showTooltip = true;
        state.updatePosition(false);
        if (reason === 'hide') state.hideAll();
        else if (reason === 'unmount') fixture.unmount();
        else state.snapshot = {...state.snapshot, text: 'A new selection.'};
        await Vue.nextTick();
        expect(cardRect).not.toHaveBeenCalled();
        expect(state.manualPopupPosition).toBeNull();
    });

    it('does not let an old position frame clear the new frame after geometry reset', async () => {
        const {state, frames, flush} = await gestureFixture();
        state.stopPopupGesture();
        state.schedulePositionUpdate();
        const oldFrame = [...frames.values()][0];
        state.resetPopupGeometry();
        state.manualPopupPosition = {left: 250, top: 150};
        state.manualPopupSize = {width: 388, height: 240};
        state.schedulePositionUpdate();
        oldFrame(0);
        expect(frames.size).toBe(1);
        flush();
        expect(state.tooltipStyle).toMatchObject({left: '250px', top: '150px'});
    });

    it('cancels a captured drag when the viewport changes its automatic width', async () => {
        const {state, window, frames, pointer, element} = await gestureFixture();
        state.movePopupGesture(pointer('pointermove', 900, 200));
        const oldMove = [...frames.values()][0];
        window.innerWidth = 390;
        state.handleViewportResize();
        expect(state.popupManipulating).toBe(false);
        expect(element.captured).toBe(false);
        state.movePopupGesture(pointer('pointermove', 905, 200));
        oldMove(0);
        const frameCount = frames.size;
        expect(frameCount).toBe(1); // only the current viewport reposition remains queued
        const current = [...frames.values()];frames.clear();current.forEach(callback => callback(0));
        expect(parseFloat(state.tooltipStyle.left)).toBe(12);
        expect(state.manualPopupPosition).toEqual({left: 12, top: 100});
    });

    it('uses an ordinary wheel to scroll only the overflowing one-row navigation', () => {
        const {state} = mountSelection();
        class NavigationElement {
            scrollWidth = 600; clientWidth = 280; scrollLeft = 0;
            matches(selector: string) {return selector === '.fr-study-toolbar';}
        }
        vi.stubGlobal('HTMLElement', NavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({overflowX: 'auto', overflowY: 'auto'}));
        const toolbar = new NavigationElement();
        const preventDefault = vi.fn();
        const event = {ctrlKey: false, deltaX: 0, deltaY: 60, cancelable: true, preventDefault, composedPath: () => [toolbar], currentTarget: toolbar};
        state.handleUiWheel(event);
        expect(toolbar.scrollLeft).toBe(60);
        expect(preventDefault).toHaveBeenCalledOnce();
        state.handleUiWheel({...event, deltaY: -30});
        expect(toolbar.scrollLeft).toBe(30);
        state.handleUiWheel({...event, ctrlKey: true});
        expect(toolbar.scrollLeft).toBe(30);
    });

    it('reveals each focused toolbar action by moving only the owned horizontal strip', () => {
        const {state} = mountSelection();
        class NavigationElement {
            tagName = 'BUTTON'; clientWidth = 278; clientLeft = 0; scrollLeft = 0;
            left = 259; right = 297;
            getBoundingClientRect() {return {left: this.left, right: this.right};}
            contains(element: unknown) {return element === button;}
        }
        vi.stubGlobal('HTMLElement', NavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({paddingLeft: '8px', paddingRight: '8px'}));
        const toolbar = new NavigationElement(), button = new NavigationElement();
        toolbar.left = 13; toolbar.right = 291;
        const event = {currentTarget: toolbar, target: button};
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(14); // reveal the clipped final button and its focus outline
        button.left = 7; button.right = 45;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        button.left = 21; button.right = 59;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        state.handleStudyToolbarFocus({...event, target: new NavigationElement()});
        state.handleStudyToolbarFocus({...event, currentTarget: {}});
        button.tagName = 'SPAN';
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
    });

    it.each([0.5, 2])('reveals focused toolbar actions at popup scale %s using layout scroll units', scale => {
        const {state} = mountSelection();
        state.pageZoom = 1 / scale;
        class ScaledNavigationElement {
            tagName = 'BUTTON'; clientWidth = 278; clientLeft = 1; scrollLeft = 0;
            left = 246; right = 284;
            getBoundingClientRect() {
                if (this === toolbar) return {left:13, right:13 + 280 * scale};
                return {left:13 + (this.left - toolbar.scrollLeft) * scale, right:13 + (this.right - toolbar.scrollLeft) * scale};
            }
            contains(element: unknown) {return element === button;}
        }
        vi.stubGlobal('HTMLElement', ScaledNavigationElement);
        vi.stubGlobal('getComputedStyle', () => ({paddingLeft:'8px',paddingRight:'8px'}));
        const toolbar = new ScaledNavigationElement(), button = new ScaledNavigationElement();
        const event = {currentTarget:toolbar,target:button};
        const visibleLeft = 13 + 9 * scale, visibleRight = 13 + 271 * scale;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(13);
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(visibleRight);
        button.left = 9; button.right = 47;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0);
        expect(button.getBoundingClientRect().left).toBeGreaterThanOrEqual(visibleLeft);
        button.left = 180; button.right = 218;
        state.handleStudyToolbarFocus(event);
        expect(toolbar.scrollLeft).toBe(0); // an already visible action must not jump the strip
        expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(visibleRight);
    });

    it('computes UTF-16 offsets once and preserves positioned segments through speech progress updates', () => {
        const {state} = mountSelection();
        const parts = [{kind: 'code', text: ' 😀'}, {kind: 'text', text: ' café'}, {kind: 'code', text: '`x`'}, {kind: 'text', text: ' end'}];
        state.snapshot = {parts};
        state.translationParts = parts;
        const source = state.sourceTextParts, translated = state.translatedTextParts;
        expect(source.map((part: {offset: number}) => part.offset)).toEqual([0, 3, 8, 11]);
        expect(source.map((part: {text: string}) => part.text).join('')).toBe(' 😀 café`x` end');
        state.isPlaying = true; state.currentAudioKind = 'source';
        for (let i = 0; i < 30; i++) {
            state.audioProgress = {start: 3, end: 8, fraction: i / 30, estimated: true};
            expect(state.sourceTextParts).toBe(source);
            expect(state.translatedTextParts).toBe(translated);
            expect(state.sourceAudioProgress).toEqual({start: 3, end: 8, fraction: i / 30, estimated: true});
        }
        state.snapshot = {parts: [{kind: 'text', text: 'new'}]};
        expect(state.sourceTextParts).not.toBe(source);
        expect(state.sourceTextParts[0].offset).toBe(0);
    });
});
