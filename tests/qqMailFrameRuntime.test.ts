import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('webextension-polyfill', () => ({default: {}}));

const mocks = vi.hoisted(() => ({
    config: {on: true, disabledExtensionDomains: [], bilingualSentenceHighlightEnabled: false,
        selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false},
    configReady: Promise.resolve(),
    sendMessage: vi.fn(),
    addRuntimeListener: vi.fn(),
    removeRuntimeListener: vi.fn(),
    autoTranslateEnglishPage: vi.fn(),
    restoreOriginalContent: vi.fn(),
    getState: vi.fn(),
    isDisabled: vi.fn(() => false),
    subscribeConfig: vi.fn(), installStyles: vi.fn(), removeStyles: vi.fn(), syncHighlight: vi.fn(),
    mountSelection: vi.fn(), unmountSelection: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config,
    get configReady() { return mocks.configReady; },
    subscribeConfig: mocks.subscribeConfig,
}));
vi.mock('@/src/core/config/constants', () => ({constants: {}}));
vi.mock('@/src/features/site-rules/domain', () => ({isExtensionDisabledOnSite: mocks.isDisabled}));
vi.mock('@/src/features/full-page-translation/public', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    getFullPageTranslationFrameState: mocks.getState,
    invalidateFullPageTranslationSessionCache: vi.fn(),
    restoreOriginalContent: mocks.restoreOriginalContent,
    cancelPendingHoverTranslation: vi.fn(), handleTranslation: vi.fn(), noteBilingualHostGesture: vi.fn(),
}));
vi.mock('@/src/app/translation/client', () => ({cancelAllTranslations: vi.fn()}));
vi.mock('@/src/shared/geometry/touch', () => ({getCenterPoint: vi.fn()}));
vi.mock('@/src/features/hover-translation/public', () => ({mountHoverTranslationContentFeature: () => vi.fn()}));
vi.mock('@/src/features/selection-translation/public', () => ({
    mountSelectionTranslator: mocks.mountSelection, unmountSelectionTranslator: mocks.unmountSelection,
}));
vi.mock('@/src/app/content/hotkeyRuntime', () => ({
    createContentHotkeyRuntime: () => ({installFloatingBallHotkey: () => vi.fn()}),
}));
vi.mock('@/src/app/content/quickTranslationRuntime', () => ({mountConfiguredQuickTranslation: vi.fn()}));
vi.mock('@/src/app/content/pageStyles', () => ({installPageStyles: mocks.installStyles}));
vi.mock('@/src/app/content/bilingualSentenceHighlight', () => ({syncBilingualSentenceHighlight: mocks.syncHighlight}));
vi.mock('@/src/app/content/siteAdaptationRuntime', () => ({
    createContentSiteAdaptationRuntime: () => ({routeChanged: vi.fn(), update: vi.fn()}),
    applyCoreTranslationPreferences: vi.fn(() => false),
}));

const topUrl = 'https://mail.qq.com/cgi-bin/frame_html?legacy=1';

function installGlobals(href = topUrl) {
    const listeners = new Map<string, Set<(...args: any[]) => any>>();
    const add = (type: string, listener: (...args: any[]) => any, options?: {signal?: AbortSignal}) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
        options?.signal?.addEventListener('abort', () => listeners.get(type)?.delete(listener), {once: true});
    };
    const remove = (type: string, listener: (...args: any[]) => any) => listeners.get(type)?.delete(listener);
    const document = {addEventListener: vi.fn(add), removeEventListener: vi.fn(remove),
        getElementById: vi.fn(() => mocks.mountSelection.mock.calls.length > 0 ? {} : null)};
    const window = Object.assign(new EventTarget(), {location: {href}, top: undefined as unknown});
    window.top = window;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('browser', {runtime: {
        sendMessage: mocks.sendMessage,
        onMessage: {addListener: mocks.addRuntimeListener, removeListener: mocks.removeRuntimeListener},
        id: 'extension-id',
    }});
    return {listeners, document, window};
}

async function load() {
    return import('@/src/app/content/qqMailFrameRuntime');
}

beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    mocks.addRuntimeListener.mockReset();
    mocks.removeRuntimeListener.mockReset();
    mocks.autoTranslateEnglishPage.mockReset();
    mocks.restoreOriginalContent.mockReset();
    mocks.getState.mockReset().mockReturnValue({sessionId: null, translationConfig: undefined, fullPageMode: 'all'});
    mocks.config.on = true;
    mocks.configReady = Promise.resolve();
    mocks.config.bilingualSentenceHighlightEnabled = false;
    mocks.config.selectionTranslatorMode = 'bilingual';
    mocks.config.disableSelectionTranslator = false;
    mocks.isDisabled.mockReturnValue(false);
    mocks.subscribeConfig.mockReset().mockReturnValue(vi.fn());
    mocks.installStyles.mockReset().mockReturnValue(mocks.removeStyles);
    mocks.removeStyles.mockReset();
    mocks.syncHighlight.mockReset();
    mocks.mountSelection.mockReset();
    mocks.unmountSelection.mockReset();
});

describe('NetEase mail frame lifecycle', () => {
    const readTop = 'https://mail.163.com/js6/main.jsp?sid=redacted#module=read.ReadModule%7C%7B%7D';
    const listTop = 'https://mail.163.com/js6/main.jsp?sid=redacted#module=mbox.ListModule%7C%7B%7D';

    it('mounts selection translation only in an authorized reading frame and releases it on route exit', async () => {
        const {window} = installGlobals('about:blank');
        window.top = {location: {href: readTop}};
        vi.stubGlobal('navigator', {});
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 1, sessionId: null});
        const {startNeteaseMailFrameApp} = await load();
        let invalidate: () => void = () => undefined;
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'neteaseMailFrameRequest', action: 'state'});
        expect(mocks.installStyles).toHaveBeenCalledOnce();
        expect(mocks.mountSelection).toHaveBeenCalledOnce();
        (window.top as {location: {href: string}}).location.href = listTop;
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        listener({type: 'neteaseMailFrameRefresh'}, {id: 'extension-id'});
        await vi.waitFor(() => expect(mocks.unmountSelection).toHaveBeenCalledOnce());
        invalidate();
    });

    it('never mounts on top-level pages or editable compose frames', async () => {
        const top = installGlobals(readTop);
        const {startNeteaseMailFrameApp} = await load();
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: vi.fn()} as never);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        top.window.location.href = 'about:blank';
        top.window.top = {location: {href: readTop}};
        (top.window as typeof top.window & {frameElement: {className: string}}).frameElement = {className: 'APP-editor-iframe'};
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: vi.fn()} as never);
        expect(mocks.mountSelection).not.toHaveBeenCalled();
    });

    it('tracks selection setting changes while the reading frame stays open', async () => {
        const {window} = installGlobals('about:blank');
        window.top = {location: {href: readTop}};
        vi.stubGlobal('navigator', {});
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 1, sessionId: null});
        const {startNeteaseMailFrameApp} = await load();
        let invalidate: () => void = () => undefined;
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        expect(mocks.mountSelection).toHaveBeenCalledOnce();
        mocks.config.selectionTranslatorMode = 'disabled';
        mocks.config.disableSelectionTranslator = true;
        mocks.subscribeConfig.mock.calls[0][0]();
        await vi.waitFor(() => expect(mocks.unmountSelection).toHaveBeenCalledOnce());
        mocks.config.selectionTranslatorMode = 'bilingual';
        mocks.config.disableSelectionTranslator = false;
        mocks.subscribeConfig.mock.calls[0][0]();
        await vi.waitFor(() => expect(mocks.mountSelection).toHaveBeenCalledTimes(2));
        invalidate();
    });

    it('retries a stale selection mount after quickly disabling and re-enabling it', async () => {
        const {window, document} = installGlobals('about:blank');
        window.top = {location: {href: readTop}};
        vi.stubGlobal('navigator', {});
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 1, sessionId: null});
        let resolveOldMount!: (value: unknown) => void;
        const oldMount = new Promise<unknown>(resolve => { resolveOldMount = resolve; });
        let mounted = false;
        Object.assign(document, {getElementById: vi.fn(() => mounted ? {} : null)});
        mocks.mountSelection.mockImplementationOnce(() => oldMount)
            .mockImplementationOnce(() => oldMount)
            .mockImplementationOnce(() => { mounted = true; return Promise.resolve({}); });

        const {startNeteaseMailFrameApp} = await load();
        let invalidate: () => void = () => undefined;
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        expect(mocks.mountSelection).toHaveBeenCalledOnce();

        mocks.config.disableSelectionTranslator = true;
        mocks.subscribeConfig.mock.calls[0][0]();
        await vi.waitFor(() => expect(mocks.unmountSelection).toHaveBeenCalledOnce());
        mocks.config.disableSelectionTranslator = false;
        mocks.subscribeConfig.mock.calls[0][0]();
        await vi.waitFor(() => expect(mocks.mountSelection).toHaveBeenCalledTimes(2));

        resolveOldMount(null);
        await vi.waitFor(() => expect(mocks.mountSelection).toHaveBeenCalledTimes(3));
        expect(mounted).toBe(true);
        invalidate();
    });

    it('reports the real top session and clears it when leaving the read route', async () => {
        const {window} = installGlobals(readTop);
        const {installNeteaseMailTopFrameBridge} = await load();
        const abort = new AbortController();
        installNeteaseMailTopFrameBridge(() => true, abort.signal);
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const respond = vi.fn();
        listener({type: 'neteaseMailFrameCommand', action: 'state'}, {id: 'extension-id'}, respond);
        expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({enabled: true}));
        listener({type: 'neteaseMailFrameCommand', action: 'toggle', invocation: {targetLanguage: 'zh-Hans'}}, {id: 'extension-id'}, respond);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({targetLanguage: 'zh-Hans'});
        mocks.restoreOriginalContent.mockClear();
        window.location.href = listTop;
        window.dispatchEvent(new Event('hashchange'));
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.sendMessage).toHaveBeenLastCalledWith({type: 'neteaseMailFrameChanged'});
        listener({type: 'neteaseMailFrameCommand', action: 'state'}, {id: 'extension-id'}, respond);
        expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({enabled: false}));
        abort.abort();
    });
});

describe('QQ legacy frame startup 生命周期', () => {
    let frame: ReturnType<typeof installGlobals>['window'];
    let context: {isInvalid: boolean; onInvalidated: (callback: () => void) => void};
    let invalidate: () => void;
    let ready: () => void;
    const transition = (type: string, persisted: boolean, trusted = true) => {
        const event = Object.assign(new Event(type), {persisted});
        Object.defineProperty(event, 'isTrusted', {value: trusted});
        frame.dispatchEvent(event);
    };
    beforeEach(() => {
        frame = installGlobals('https://mail.qq.com/cgi-bin/readmail?mailid=x').window;
        frame.top = {};
        vi.stubGlobal('navigator', {});
        context = {isInvalid: false, onInvalidated: callback => { invalidate = callback; }};
        mocks.configReady = new Promise<void>(resolve => { ready = resolve; });
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
    });
    afterEach(() => { invalidate?.(); vi.unstubAllGlobals(); });

    it.each(['pagehide', 'invalidate'] as const)('配置等待期间 %s 不会在迟到响应后挂载 frame', async reason => {
        const {startQqMailFrameApp} = await load();
        const starting = startQqMailFrameApp(context as never);
        if (reason === 'pagehide') transition('pagehide', false);
        else { context.isInvalid = true; invalidate(); }
        ready();
        await starting;
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.installStyles).not.toHaveBeenCalled();
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
    });

    it('配置等待期间 BFCache 暂停后，仅真实恢复会重新认证并挂载 frame', async () => {
        const {startQqMailFrameApp} = await load();
        const starting = startQqMailFrameApp(context as never);
        transition('pagehide', true);
        ready();
        await starting;
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        transition('pageshow', true, false);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        transition('pageshow', true);
        await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledOnce());
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'qqMailFrameRequest', action: 'state'});
        transition('pagehide', true);
        mocks.config.bilingualSentenceHighlightEnabled = true;
        mocks.subscribeConfig.mock.calls[0][0]();
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        listener({type: 'qqMailFrameRefresh'}, {id: 'extension-id'});
        expect(mocks.sendMessage).toHaveBeenCalledOnce();
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
    });

    it('后台授权响应晚于页面暂停时不能重新添加 frame 手势与样式', async () => {
        let authorize!: (state: unknown) => void;
        mocks.sendMessage.mockReturnValue(new Promise(resolve => { authorize = resolve; }));
        const {startQqMailFrameApp} = await load();
        const starting = startQqMailFrameApp(context as never);
        ready();
        await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
        transition('pagehide', true);
        authorize({enabled: true, revision: 0, sessionId: null});
        await starting;
        expect(mocks.installStyles).not.toHaveBeenCalled();
    });

    it.each(['runtime removed', 'event removed', 'removeListener throws'] as const)(
        'invalidates an active mail frame after %s without interrupting cleanup', async failure => {
            const {listeners} = installGlobals('https://mail.qq.com/cgi-bin/readmail?mailid=x');
            window.top = {} as Window;
            const {startQqMailFrameApp} = await load();
            const starting = startQqMailFrameApp(context as never);
            ready();
            await starting;
            const listener = mocks.addRuntimeListener.mock.calls[0][0];
            const unsubscribe = mocks.subscribeConfig.mock.results[0].value;
            if (failure === 'runtime removed') Reflect.deleteProperty(browser, 'runtime');
            else if (failure === 'event removed') Reflect.deleteProperty(browser.runtime, 'onMessage');
            else mocks.removeRuntimeListener.mockImplementation(() => { throw new Error('Extension context invalidated.'); });

            expect(() => { invalidate(); invalidate(); }).not.toThrow();
            expect(mocks.removeRuntimeListener).toHaveBeenCalledTimes(1);
            expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
            expect(mocks.removeStyles).toHaveBeenCalledOnce();
            expect(unsubscribe).toHaveBeenCalledOnce();
            expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
            expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
        },
    );
});

describe('frame bridge cleanup after extension reload', () => {
    async function readingFrame(kind: 'qq' | 'netease' | 'embedded') {
        const href = kind === 'qq' ? 'https://mail.qq.com/cgi-bin/readmail?mailid=x'
            : kind === 'netease' ? 'about:blank'
                : 'https://www.kaggleusercontent.com/kf/126670518/signed-token/__results__.html';
        const globals = installGlobals(href);
        globals.window.top = kind === 'netease'
            ? {location: {href: 'https://mail.163.com/js6/main.jsp?sid=redacted#module=read.ReadModule%7C%7B%7D'}} : {};
        vi.stubGlobal('navigator', {});
        const mail = await load();
        const {startEmbeddedFrameApp} = await import('@/src/app/content/embeddedFrameRuntime');
        const start = kind === 'qq' ? mail.startQqMailFrameApp
            : kind === 'netease' ? mail.startNeteaseMailFrameApp : startEmbeddedFrameApp;
        return {...globals, start};
    }

    it.each(['qq', 'netease', 'embedded'] as const)(
        'detects passive WXT invalidation and releases an idle %s frame without another gesture', async kind => {
            vi.useFakeTimers();
            try {
                const {start, listeners, document, window} = await readingFrame(kind);
                const removeWindowListener = vi.spyOn(window, 'removeEventListener');
                mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
                let invalid = false;
                const releaseContextListener = vi.fn();
                await start({get isInvalid() { return invalid; }, onInvalidated: () => releaseContextListener} as never);
                const unsubscribe = mocks.subscribeConfig.mock.results[0].value;
                expect(mocks.installStyles).toHaveBeenCalledOnce();
                invalid = true;
                Reflect.deleteProperty(browser, 'runtime');
                vi.advanceTimersByTime(1000);
                expect(mocks.removeStyles).toHaveBeenCalledOnce();
                expect(mocks.removeRuntimeListener).toHaveBeenCalledOnce();
                expect(unsubscribe).toHaveBeenCalledOnce();
                expect(releaseContextListener).toHaveBeenCalledOnce();
                expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
                expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
                expect(removeWindowListener.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(['pagehide', 'pageshow']));
                expect(vi.getTimerCount()).toBe(0);
            } finally { vi.useRealTimers(); }
        },
    );

    it.each(['qq', 'netease', 'embedded'] as const)(
        'does not revive the %s frame when authorization returns after context disposal', async kind => {
            vi.useFakeTimers();
            try {
                const {start, listeners} = await readingFrame(kind);
                let resolve!: (value: unknown) => void;
                mocks.sendMessage.mockReturnValue(new Promise(value => { resolve = value; }));
                let invalid = false;
                const releaseContextListener = vi.fn();
                const starting = start({get isInvalid() { return invalid; }, onInvalidated: () => releaseContextListener} as never);
                for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
                expect(mocks.sendMessage).toHaveBeenCalledOnce();
                invalid = true;
                vi.advanceTimersByTime(1000);
                resolve({enabled: true, revision: 1, sessionId: 1, fullPageMode: 'all', translationConfig: {
                    service: 'freeTranslation', model: '', sourceLanguage: 'en', targetLanguage: 'zh-CN',
                    thinking: false, useCache: true, enableAIContext: false, enableAIMultiSegment: false,
                    displayMode: 'bilingual', style: 0,
                }});
                await starting;
                expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
                expect(mocks.installStyles).not.toHaveBeenCalled();
                expect(mocks.removeRuntimeListener).toHaveBeenCalledOnce();
                expect(mocks.subscribeConfig.mock.results[0].value).toHaveBeenCalledOnce();
                expect(releaseContextListener).toHaveBeenCalledOnce();
                expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
                expect(vi.getTimerCount()).toBe(0);
            } finally { vi.useRealTimers(); }
        },
    );

    it('repeated short-lived embedded frames leave no polling or document listeners', async () => {
        vi.useFakeTimers();
        try {
            for (let index = 0; index < 24; index += 1) {
                const {start, listeners} = await readingFrame('embedded');
                mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
                let invalid = false;
                await start({get isInvalid() { return invalid; }, onInvalidated: vi.fn()} as never);
                invalid = true;
                vi.advanceTimersByTime(1000);
                expect(vi.getTimerCount()).toBe(0);
                expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
            }
            expect(mocks.removeStyles).toHaveBeenCalledTimes(24);
            expect(mocks.removeRuntimeListener).toHaveBeenCalledTimes(24);
        } finally { vi.useRealTimers(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)(
        'releases the %s top bridge when runtime is removed or listener removal fails', async kind => {
            const href = kind === 'qq' ? topUrl : kind === 'netease'
                ? 'https://mail.163.com/js6/main.jsp?sid=redacted#module=read.ReadModule%7C%7B%7D'
                : 'https://www.omgubuntu.co.uk/2026/09/era-rust-calendar-gnome-beta';
            const mail = await load();
            const {installEmbeddedTopFrameBridge} = await import('@/src/app/content/embeddedFrameRuntime');
            const install = kind === 'qq' ? mail.installQqMailTopFrameBridge
                : kind === 'netease' ? mail.installNeteaseMailTopFrameBridge : installEmbeddedTopFrameBridge;
            for (const failure of ['runtime removed', 'removeListener throws']) {
                mocks.removeRuntimeListener.mockReset();
                const {listeners} = installGlobals(href);
                const abortCallbacks: Array<() => void> = [];
                const controller = new AbortController();
                vi.spyOn(controller.signal, 'addEventListener').mockImplementation((_type, callback) => {
                    abortCallbacks.push(callback as () => void);
                });
                install(() => true, controller.signal);
                const listener = mocks.addRuntimeListener.mock.calls.at(-1)![0];
                if (failure === 'runtime removed') Reflect.deleteProperty(browser, 'runtime');
                else mocks.removeRuntimeListener.mockImplementation(() => { throw new Error('Extension context invalidated.'); });

                expect(() => abortCallbacks.forEach(callback => callback())).not.toThrow();
                expect(mocks.removeRuntimeListener).toHaveBeenCalledTimes(1);
                expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
                expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
            }
        },
    );

    it.each(['runtime removed', 'removeListener throws'] as const)(
        'disposes an active embedded frame after %s', async failure => {
            const {listeners, window} = installGlobals('https://www.kaggleusercontent.com/kf/126670518/signed-token/__results__.html');
            window.top = {};
            vi.stubGlobal('navigator', {});
            mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
            const {startEmbeddedFrameApp} = await import('@/src/app/content/embeddedFrameRuntime');
            let invalidate!: () => void;
            await startEmbeddedFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
            const listener = mocks.addRuntimeListener.mock.calls[0][0];
            const unsubscribe = mocks.subscribeConfig.mock.results[0].value;
            if (failure === 'runtime removed') Reflect.deleteProperty(browser, 'runtime');
            else mocks.removeRuntimeListener.mockImplementation(() => { throw new Error('Extension context invalidated.'); });

            expect(() => { invalidate(); invalidate(); }).not.toThrow();
            expect(mocks.removeRuntimeListener).toHaveBeenCalledTimes(1);
            expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
            expect(mocks.removeStyles).toHaveBeenCalledOnce();
            expect(unsubscribe).toHaveBeenCalledOnce();
            expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
            expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
        },
    );
});

describe('QQ legacy top frame bridge', () => {
    it('does not install on unrelated URLs', async () => {
        installGlobals('https://mail.qq.com/cgi-bin/readmail?mailid=x');
        const {installQqMailTopFrameBridge} = await load();
        installQqMailTopFrameBridge(() => true, new AbortController().signal);
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects external senders and replies with the real snapshot while disabled', async () => {
        const {listeners} = installGlobals();
        mocks.config.on = false;
        const snapshot = {sessionId: 9, revision: 3, translationConfig: {service: 's', model: 'm'}, fullPageMode: 'all'};
        mocks.getState.mockReturnValue(snapshot);
        const {installQqMailTopFrameBridge} = await load();
        const signal = new AbortController();
        installQqMailTopFrameBridge(() => false, signal.signal);
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'qqMailFrameChanged'});
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const respond = vi.fn();
        expect(listener({type: 'qqMailFrameCommand', action: 'state'}, {id: 'other'}, respond)).toBe(false);
        expect(listener({type: 'qqMailFrameCommand', action: 'state'}, {id: 'extension-id'}, respond)).toBe(true);
        expect(respond).toHaveBeenCalledWith({...snapshot, enabled: false});
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
        for (const listener of listeners.get('fluentread-translation-started') ?? []) listener();
        expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
        signal.abort();
        expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
        for (const listener of listeners.get('fluentread-translation-started') ?? []) listener();
        expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
        expect(listeners.get('fluentread-translation-started')?.size).toBe(0);
    });

    it('restores then starts normal, same-profile, and different-profile toggles', async () => {
        installGlobals();
        const {installQqMailTopFrameBridge} = await load();
        const signal = new AbortController();
        installQqMailTopFrameBridge(() => true, signal.signal);
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const respond = vi.fn();

        listener({type: 'qqMailFrameCommand', action: 'toggle', invocation: {service: 's'}}, {id: 'extension-id'}, respond);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({service: 's'});

        mocks.restoreOriginalContent.mockClear();
        mocks.autoTranslateEnglishPage.mockClear();
        mocks.getState.mockReturnValue({sessionId: 4, fullPageMode: 'all', translationConfig: {service: 's', model: 'm', targetLanguage: 'zh', displayMode: 'bilingual'}});
        listener({type: 'qqMailFrameCommand', action: 'toggle', invocation: {service: 's'}}, {id: 'extension-id'}, respond);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();

        mocks.restoreOriginalContent.mockClear();
        listener({type: 'qqMailFrameCommand', action: 'toggle', invocation: {service: 'other'}}, {id: 'extension-id'}, respond);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({service: 'other'});
    });
});
