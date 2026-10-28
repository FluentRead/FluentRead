import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('webextension-polyfill', () => ({default: {}}));

const mocks = vi.hoisted(() => ({
    config: {on: true, disabledExtensionDomains: [], bilingualSentenceHighlightEnabled: false,
        browserDefaultTranslationFont: false,
        selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, floatingBallHotkey: 'Alt+T', hotkey: 'Control'},
    realHotkeys: false,
    configReady: Promise.resolve(),
    sendMessage: vi.fn(),
    addRuntimeListener: vi.fn(),
    removeRuntimeListener: vi.fn(),
    autoTranslateEnglishPage: vi.fn(),
    restoreOriginalContent: vi.fn(),
    resetRouteState: vi.fn(), resetContext: vi.fn(), routeChanged: vi.fn(),
    getState: vi.fn(),
    isDisabled: vi.fn(() => false),
    subscribeConfig: vi.fn(), installStyles: vi.fn(), removeStyles: vi.fn(), syncHighlight: vi.fn(),
    mountSelection: vi.fn(), unmountSelection: vi.fn(),
    fontSet: vi.fn(), fontReset: vi.fn(), fontDispose: vi.fn(),
    mountHover: vi.fn(), mountQuick: vi.fn(), invalidateCache: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config,
    get configReady() { return mocks.configReady; },
    subscribeConfig: mocks.subscribeConfig,
}));
vi.mock('@/src/core/config/constants', () => ({constants: {}}));
vi.mock('@/src/features/site-rules/domain', () => ({isExtensionDisabledOnSite: mocks.isDisabled}));
vi.mock('@/src/features/full-page-translation/public', () => ({
    createPageTranslationDisplayModeSync: (_initial: unknown, apply: (next: any) => void) => apply,
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    getFullPageTranslationFrameState: mocks.getState,
    invalidateFullPageTranslationSessionCache: mocks.invalidateCache,
    restoreOriginalContent: mocks.restoreOriginalContent,
    resetFullPageTranslationRouteState: mocks.resetRouteState,
    cancelPendingHoverTranslation: vi.fn(), handleTranslation: vi.fn(), noteBilingualHostGesture: vi.fn(),
}));
vi.mock('@/src/services/translation/client', () => ({cancelAllTranslations: vi.fn()}));
vi.mock('@/src/services/translation/context', () => ({resetPageTranslationContextCache: mocks.resetContext}));
vi.mock('@/src/shared/geometry/touch', () => ({getCenterPoint: vi.fn()}));
vi.mock('@/src/features/hover-translation/public', () => ({mountHoverTranslationContentFeature: mocks.mountHover}));
vi.mock('@/src/features/selection-translation/public', () => ({
    mountSelectionTranslator: mocks.mountSelection, unmountSelectionTranslator: mocks.unmountSelection,
}));
vi.mock('@/src/app/content/hotkeyRuntime', async importOriginal => {
    const actual = await importOriginal<typeof import('@/src/app/content/hotkeyRuntime')>();
    return {createContentHotkeyRuntime: (...args: Parameters<typeof actual.createContentHotkeyRuntime>) => mocks.realHotkeys ? actual.createContentHotkeyRuntime(...args) : {installFloatingBallHotkey: () => vi.fn()}};
});
vi.mock('@/src/app/content/quickTranslationRuntime', () => ({mountConfiguredQuickTranslation: mocks.mountQuick}));
vi.mock('@/src/app/content/pageStyles', () => ({installPageStyles: mocks.installStyles}));
vi.mock('@/src/app/content/bilingualSentenceHighlight', () => ({syncBilingualSentenceHighlight: mocks.syncHighlight}));
vi.mock('@/src/app/content/pageTranslationFont', () => ({createPageTranslationFontRuntime: () => ({
    read: () => false, set: mocks.fontSet, reset: mocks.fontReset, dispose: mocks.fontDispose,
})}));
vi.mock('@/src/app/content/siteAdaptationRuntime', () => ({
    createContentSiteAdaptationRuntime: () => ({routeChanged: mocks.routeChanged, update: vi.fn()}),
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

// 从真实网易入口装配划词端口，生命周期仍执行真实共享 frame runtime。
async function loadNeteaseEntry() {
    return (await import('../entrypoints/neteaseMailFrame.content')).default;
}

beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('defineContentScript', (entry: unknown) => entry);
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    mocks.addRuntimeListener.mockReset();
    mocks.removeRuntimeListener.mockReset();
    mocks.autoTranslateEnglishPage.mockReset();
    mocks.restoreOriginalContent.mockReset();
    mocks.resetRouteState.mockReset();
    mocks.resetContext.mockReset();
    mocks.routeChanged.mockReset().mockReturnValue(false);
    mocks.getState.mockReset().mockReturnValue({sessionId: null, translationConfig: undefined, fullPageMode: 'all'});
    mocks.fontSet.mockReset(); mocks.fontReset.mockReset(); mocks.fontDispose.mockReset();
    mocks.mountHover.mockReset().mockReturnValue(vi.fn()); mocks.mountQuick.mockReset(); mocks.invalidateCache.mockReset();
    mocks.config.on = true;
    mocks.config.browserDefaultTranslationFont = false;
    mocks.realHotkeys = false;
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
        const {main: startNeteaseMailFrameApp} = await loadNeteaseEntry();
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
        const {main: startNeteaseMailFrameApp} = await loadNeteaseEntry();
        let invalidate: (() => void) | undefined;
        const context = {isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }};
        try {
            await startNeteaseMailFrameApp(context as never);
            expect(mocks.sendMessage).not.toHaveBeenCalled();
            expect(invalidate).toBeUndefined();
            top.window.location.href = 'about:blank';
            top.window.top = {location: {href: readTop}};
            (top.window as typeof top.window & {frameElement: {className: string}}).frameElement = {className: 'APP-editor-iframe'};
            await startNeteaseMailFrameApp(context as never);
            expect(mocks.sendMessage).not.toHaveBeenCalled();
            expect(mocks.mountSelection).not.toHaveBeenCalled();
            expect(mocks.installStyles).not.toHaveBeenCalled();
            // 匹配邮箱的 compose child 保留路由生命周期；不挂载 UI 并不
            // 等于未建立 frame。fixture 结束仍须销毁自己创建的上下文。
            expect(invalidate).toBeTypeOf('function');
        } finally { invalidate?.(); }
        expect(mocks.removeRuntimeListener).toHaveBeenCalledOnce();
        expect(mocks.subscribeConfig.mock.results[0].value).toHaveBeenCalledOnce();
        expect([...top.listeners.values()].every(set => set.size === 0)).toBe(true);
    });

    it('tracks selection setting changes while the reading frame stays open', async () => {
        const {window} = installGlobals('about:blank');
        window.top = {location: {href: readTop}};
        vi.stubGlobal('navigator', {});
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 1, sessionId: null});
        const {main: startNeteaseMailFrameApp} = await loadNeteaseEntry();
        let invalidate: () => void = () => undefined;
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        expect(mocks.mountSelection).toHaveBeenCalledOnce();
        mocks.config.selectionTranslatorMode = 'disabled';
        mocks.config.disableSelectionTranslator = true;
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
        await vi.waitFor(() => expect(mocks.unmountSelection).toHaveBeenCalledOnce());
        mocks.config.selectionTranslatorMode = 'bilingual';
        mocks.config.disableSelectionTranslator = false;
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
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

        const {main: startNeteaseMailFrameApp} = await loadNeteaseEntry();
        let invalidate: () => void = () => undefined;
        await startNeteaseMailFrameApp({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        expect(mocks.mountSelection).toHaveBeenCalledOnce();

        mocks.config.disableSelectionTranslator = true;
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
        await vi.waitFor(() => expect(mocks.unmountSelection).toHaveBeenCalledOnce());
        mocks.config.disableSelectionTranslator = false;
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
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
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
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
            : kind === 'netease' ? (await loadNeteaseEntry()).main : startEmbeddedFrameApp;
        return {...globals, start};
    }

    it.each(['qq', 'embedded'] as const)('%s authorization and config refresh never mount or release NetEase selection ports', async kind => {
        const {start, listeners} = await readingFrame(kind);
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
        let invalidate!: () => void;
        const context = {isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}};
        try {
            await start(context as never);
            expect(mocks.installStyles).toHaveBeenCalledOnce();
            const notifyConfig = mocks.subscribeConfig.mock.calls[0][0];
            mocks.config.disableSelectionTranslator = true;
            notifyConfig(mocks.config);
            mocks.config.disableSelectionTranslator = false;
            notifyConfig(mocks.config);
            const refresh = mocks.addRuntimeListener.mock.calls[0][0];
            refresh({type: kind === 'qq' ? 'qqMailFrameRefresh' : 'embeddedFrameRefresh'}, {id: 'extension-id'});
            await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'state').length).toBeGreaterThan(1));
            expect(mocks.mountSelection).not.toHaveBeenCalled();
            expect(mocks.unmountSelection).not.toHaveBeenCalled();
        } finally {invalidate?.();}
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.mountSelection).not.toHaveBeenCalled();
        expect(mocks.unmountSelection).not.toHaveBeenCalled();
        expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s forwards the real trusted full-page shortcut to the top session and follows its current snapshot', async kind => {
        mocks.realHotkeys = true;mocks.config.selectionTranslatorMode = 'disabled';
        const {start, listeners, window} = await readingFrame(kind);
        const snapshot = {service: 'freeTranslation', model: '', sourceLanguage: 'en', targetLanguage: 'zh-CN', thinking: false,
            useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'bilingual', style: 0, profileId: 'quick-test'};
        let sessionId: number | null = null, revision = 0;
        mocks.sendMessage.mockImplementation(async message => {
            if (message.action === 'toggle') {sessionId = sessionId === null ? 5 : null;revision++;return;}
            return {enabled: true, revision, sessionId, fullPageMode: 'viewport', scope: 'content', translationConfig: snapshot};
        });
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        const press = (trusted = true) => {
            for (const type of ['keydown', 'keyup']) {
                const event = Object.assign(new Event(type, {cancelable: true}), {key: 't', code: 'KeyT', altKey: true, repeat: false});
                Object.defineProperty(event, 'isTrusted', {value: trusted});
                for (const listener of [...listeners.get(type) ?? []]) listener(event);
            }
        };
        press(false);expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'toggle')).toHaveLength(0);
        press();await vi.waitFor(() => expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce());
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({service: 'freeTranslation', model: '', targetLanguage: 'zh-CN', displayMode: 'bilingual', profileId: 'quick-test', fullPageMode: 'viewport', scope: 'content'}, snapshot);
        press();await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'state')).toHaveLength(3));
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();expect(sessionId).toBeNull();
        const hide = Object.assign(new Event('pagehide'), {persisted: true});Object.defineProperty(hide, 'isTrusted', {value: true});window.dispatchEvent(hide);
        const count = mocks.sendMessage.mock.calls.length;press();expect(mocks.sendMessage).toHaveBeenCalledTimes(count);
        const show = Object.assign(new Event('pageshow'), {persisted: true});Object.defineProperty(show, 'isTrusted', {value: true});window.dispatchEvent(show);
        await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(2));press();await vi.waitFor(() => expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledTimes(2));
        invalidate();press();expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
    });
    it.each(['qq', 'embedded'] as const)('%s releases current frame tools if top toggle messaging throws and allows explicit reauthorization', async kind => {
        mocks.realHotkeys = true;const {start, listeners} = await readingFrame(kind);
        let fail = true;
        mocks.sendMessage.mockImplementation(message => {if (message.action === 'toggle' && fail) throw new Error('Context unavailable');return Promise.resolve({enabled: true, revision: 0, sessionId: null});});
        let invalidate!: () => void;await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        const press = () => {const event = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});Object.defineProperty(event, 'isTrusted', {value: true});for (const listener of [...listeners.get('keydown') ?? []]) listener(event);};
        press();expect(mocks.removeStyles).toHaveBeenCalledOnce();expect(listeners.get('keydown')?.size).toBe(0);
        fail = false;mocks.addRuntimeListener.mock.calls[0][0]({type: kind === 'qq' ? 'qqMailFrameRefresh' : 'embeddedFrameRefresh'}, {id: 'extension-id'});
        await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(2));press();await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'toggle')).toHaveLength(2));
        invalidate();expect(mocks.removeStyles).toHaveBeenCalledTimes(2);
    });

    it.each((['qq', 'netease', 'embedded'] as const).flatMap(kind => (['failure', 'success'] as const).map(outcome => ({kind, outcome}))))('$kind handles an old toggle $outcome after BFCache reauthorization', async ({kind, outcome}) => {
        mocks.realHotkeys = true;
        const {start, listeners, window} = await readingFrame(kind);
        let rejectOld!: (error: Error) => void;
        let resolveOld!: () => void;
        mocks.sendMessage.mockImplementation(message => message.action === 'toggle'
            ? new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; })
            : Promise.resolve({enabled: true, revision: 0, sessionId: null}));
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const key = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});
            Object.defineProperty(key, 'isTrusted', {value: true});
            for (const listener of [...listeners.get('keydown') ?? []]) listener(key);
            expect(rejectOld).toBeTypeOf('function');
            for (const type of ['pagehide', 'pageshow']) {
                const event = Object.assign(new Event(type), {persisted: true});
                Object.defineProperty(event, 'isTrusted', {value: true});
                window.dispatchEvent(event);
            }
            await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(2));
            const readsBefore = mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'state').length;
            if (outcome === 'failure') rejectOld(new Error('old request failed'));
            else resolveOld();
            if (outcome === 'success') await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'state')).toHaveLength(readsBefore + 1));
            else { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
            expect(mocks.removeStyles).toHaveBeenCalledTimes(1);
            expect(listeners.get('keydown')?.size).toBeGreaterThan(0);
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s does not let an earlier failed toggle revoke a later successful toggle', async kind => {
        mocks.realHotkeys = true;
        const {start, listeners} = await readingFrame(kind);
        let rejectOld!: (error: Error) => void;
        let toggleCount = 0;
        mocks.sendMessage.mockImplementation(message => {
            if (message.action !== 'toggle') return Promise.resolve({enabled: true, revision: 0, sessionId: null});
            return ++toggleCount === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve();
        });
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const press = () => {
                for (const type of ['keydown', 'keyup']) {
                    const key = Object.assign(new Event(type), {key: 't', code: 'KeyT', altKey: true, repeat: false});
                    Object.defineProperty(key, 'isTrusted', {value: true});
                    for (const listener of [...listeners.get(type) ?? []]) listener(key);
                }
            };
            press(); press();
            await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.filter(([message]) => message.action === 'state')).toHaveLength(2));
            rejectOld(new Error('old request failed'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(mocks.removeStyles).not.toHaveBeenCalled();
            expect(listeners.get('keydown')?.size).toBeGreaterThan(0);
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s preserves a newer external top session when an old toggle rejects', async kind => {
        mocks.realHotkeys = true;
        const {start, listeners} = await readingFrame(kind);
        let rejectOld!: (error: Error) => void;
        let state: any = {enabled: true, revision: 0, sessionId: null};
        mocks.sendMessage.mockImplementation(message => message.action === 'toggle'
            ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(state));
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const key = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});
            Object.defineProperty(key, 'isTrusted', {value: true});
            for (const listener of [...listeners.get('keydown') ?? []]) listener(key);
            state = {enabled: true, revision: 1, sessionId: 1, fullPageMode: 'all', translationConfig: {
                service: 'freeTranslation', model: '', sourceLanguage: 'en', targetLanguage: 'zh-CN', thinking: false,
                useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'bilingual', style: 0,
            }};
            const type = kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh';
            mocks.addRuntimeListener.mock.calls[0][0]({type}, {id: 'extension-id'});
            await vi.waitFor(() => expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce());
            const restores = mocks.restoreOriginalContent.mock.calls.length;
            rejectOld(new Error('old request failed'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(mocks.removeStyles).not.toHaveBeenCalled();
            expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(restores);
            expect(listeners.get('keydown')?.size).toBeGreaterThan(0);
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s rechecks a newer top session if an old toggle fails during its state read', async kind => {
        mocks.realHotkeys = true;
        const {start, listeners} = await readingFrame(kind);
        let rejectOld!: (error: Error) => void;
        let resolveStale!: (state: unknown) => void;
        let reads = 0;
        const oldState = {enabled: true, revision: 0, sessionId: null};
        const newState = {enabled: true, revision: 1, sessionId: 1, fullPageMode: 'all', translationConfig: {
            service: 'freeTranslation', model: '', sourceLanguage: 'en', targetLanguage: 'zh-CN', thinking: false,
            useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'bilingual', style: 0,
        }};
        mocks.sendMessage.mockImplementation(message => {
            if (message.action === 'toggle') return new Promise((_resolve, reject) => { rejectOld = reject; });
            if (++reads === 1) return Promise.resolve(oldState);
            if (reads === 2) return new Promise(resolve => {resolveStale = resolve;});
            return Promise.resolve(newState);
        });
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const key = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});
            Object.defineProperty(key, 'isTrusted', {value: true});
            for (const listener of [...listeners.get('keydown') ?? []]) listener(key);
            const type = kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh';
            mocks.addRuntimeListener.mock.calls[0][0]({type}, {id: 'extension-id'});
            await vi.waitFor(() => expect(reads).toBe(2));
            rejectOld(new Error('old request failed'));
            await vi.waitFor(() => expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce());
            expect(reads).toBe(3);
            resolveStale(oldState);
            await Promise.resolve(); await Promise.resolve();
            expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
            expect(listeners.get('keydown')?.size).toBeGreaterThan(0);
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s releases current authorization when the latest toggle rejects', async kind => {
        mocks.realHotkeys = true;
        const {start, listeners} = await readingFrame(kind);
        let unavailable = false;
        mocks.sendMessage.mockImplementation(message => {
            if (message.action === 'toggle') {unavailable = true; return Promise.reject(new Error('current request failed'));}
            return unavailable ? Promise.reject(new Error('state unavailable')) : Promise.resolve({enabled: true, revision: 0, sessionId: null});
        });
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const key = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});
            Object.defineProperty(key, 'isTrusted', {value: true});
            for (const listener of [...listeners.get('keydown') ?? []]) listener(key);
            await vi.waitFor(() => expect(mocks.removeStyles).toHaveBeenCalledOnce());
            expect(listeners.get('keydown')?.size).toBe(0);
            unavailable = false;
            const type = kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh';
            mocks.addRuntimeListener.mock.calls[0][0]({type}, {id: 'extension-id'});
            await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(2));
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)('%s releases and can recover when following a toggled session throws', async kind => {
        mocks.realHotkeys = true;
        const {start, listeners} = await readingFrame(kind);
        let active = false;
        const config = {service: 'freeTranslation', model: '', sourceLanguage: 'en', targetLanguage: 'zh-CN', thinking: false,
            useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'bilingual', style: 0};
        mocks.sendMessage.mockImplementation(message => {
            if (message.action === 'toggle') {active = true; return Promise.resolve();}
            return Promise.resolve(active ? {enabled: true, revision: 1, sessionId: 1, fullPageMode: 'all', translationConfig: config}
                : {enabled: true, revision: 0, sessionId: null});
        });
        mocks.autoTranslateEnglishPage.mockImplementationOnce(() => {throw new Error('cannot start frame session');});
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const key = Object.assign(new Event('keydown'), {key: 't', code: 'KeyT', altKey: true, repeat: false});
            Object.defineProperty(key, 'isTrusted', {value: true});
            for (const listener of [...listeners.get('keydown') ?? []]) listener(key);
            await vi.waitFor(() => expect(mocks.removeStyles).toHaveBeenCalledOnce());
            expect(listeners.get('keydown')?.size).toBe(0);
            const type = kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh';
            mocks.addRuntimeListener.mock.calls[0][0]({type}, {id: 'extension-id'});
            await vi.waitFor(() => expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledTimes(2));
            expect(listeners.get('keydown')?.size).toBeGreaterThan(0);
        } finally { invalidate(); }
    });

    it('forwards a configured embedded quick profile, guards hover and ignores a late failure after disposal', async () => {
        const {start} = await readingFrame('embedded');
        let rejectOld!: (error: Error) => void;
        mocks.sendMessage.mockImplementation(message => message.action === 'toggle'
            ? new Promise((_resolve, reject) => {rejectOld = reject;})
            : Promise.resolve({enabled: true, revision: 0, sessionId: null}));
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        const toggle = mocks.mountQuick.mock.calls[0][5];
        const isSiteDisabled = mocks.mountHover.mock.calls[0][0].isSiteDisabled;
        expect(isSiteDisabled()).toBe(false);
        const invocation = {service: 'test-service', fullPageMode: 'viewport'};
        toggle(invocation);
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'embeddedFrameRequest', action: 'toggle', invocation});
        invalidate();
        expect(isSiteDisabled()).toBe(true);
        const calls = mocks.sendMessage.mock.calls.length;
        toggle(invocation);
        rejectOld(new Error('late failure'));
        await Promise.resolve(); await Promise.resolve();
        expect(mocks.sendMessage).toHaveBeenCalledTimes(calls);
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
    });

    it('invalidates the embedded page cache only for extension-owned messages', async () => {
        const {start} = await readingFrame('embedded');
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            const listener = mocks.addRuntimeListener.mock.calls[0][0];
            expect(listener({type: 'translationCacheCleared'}, {id: 'external'})).toBe(false);
            expect(mocks.invalidateCache).not.toHaveBeenCalled();
            expect(listener({type: 'translationCacheCleared'}, {id: 'extension-id'})).toBe(false);
            expect(mocks.invalidateCache).toHaveBeenCalledOnce();
        } finally { invalidate(); }
    });

    it.each(['qq', 'netease', 'embedded'] as const)(
        '%s 正文字体以已水合的全局配置为准，迟到顶层字体快照不能覆盖新偏好或重新请求翻译', async kind => {
            const {start} = await readingFrame(kind);
            mocks.config.browserDefaultTranslationFont = true;
            const top = {enabled: true, revision: 0, sessionId: null, browserDefaultFont: false};
            mocks.sendMessage.mockImplementation(async () => ({...top}));
            let invalidate!: () => void;
            try {
                await start({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                const restores = mocks.restoreOriginalContent.mock.calls.length;
                const listener = mocks.addRuntimeListener.mock.calls[0][0];
                const type = kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh';
                const calls = mocks.sendMessage.mock.calls.length;
                listener({type}, {id: 'other'});
                expect(mocks.sendMessage).toHaveBeenCalledTimes(calls);
                mocks.config.browserDefaultTranslationFont = false;
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                expect(mocks.fontSet).toHaveBeenLastCalledWith(false);
                await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.length).toBeGreaterThan(calls));
                let resolveOld!: (state: unknown) => void;
                const reading = mocks.sendMessage.mock.calls.length;
                mocks.sendMessage.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
                listener({type}, {id: 'extension-id'});
                await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.length).toBeGreaterThan(reading));
                mocks.config.browserDefaultTranslationFont = true;
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                const writes = mocks.fontSet.mock.calls.length;
                resolveOld({...top, browserDefaultFont: false});
                await vi.waitFor(() => expect(mocks.sendMessage.mock.calls.length).toBeGreaterThan(reading + 1));
                await Promise.resolve();
                expect(mocks.fontSet.mock.calls.slice(writes).every(([enabled]) => enabled === true)).toBe(true);
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                expect(mocks.config.browserDefaultTranslationFont).toBe(true);
                expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(restores);
                expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
            } finally { invalidate?.(); }
            expect(mocks.fontReset).toHaveBeenCalled();
            expect(mocks.fontDispose).toHaveBeenCalledOnce();
        },
    );

    it.each(['qq', 'netease', 'embedded'] as const)(
        '%s 授权恢复与 BFCache 返回重新应用全局字体，暂停和站点禁用均不改写偏好', async kind => {
            const {start, window} = await readingFrame(kind);
            mocks.config.browserDefaultTranslationFont = true;
            let authorized = true;
            mocks.sendMessage.mockImplementation(async () => ({enabled: authorized, revision: 0, sessionId: null, browserDefaultFont: false}));
            let invalidate!: () => void;
            const transition = (type: string) => {
                const event = Object.assign(new Event(type), {persisted: true});
                Object.defineProperty(event, 'isTrusted', {value: true});
                window.dispatchEvent(event);
            };
            try {
                await start({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
                const refresh = () => mocks.addRuntimeListener.mock.calls[0][0](
                    {type: kind === 'qq' ? 'qqMailFrameRefresh' : kind === 'netease' ? 'neteaseMailFrameRefresh' : 'embeddedFrameRefresh'}, {id: 'extension-id'});
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                authorized = false; refresh();
                await vi.waitFor(() => expect(mocks.removeStyles).toHaveBeenCalledOnce());
                expect(mocks.fontReset).toHaveBeenCalled();
                expect(mocks.config.browserDefaultTranslationFont).toBe(true);
                const unauthorizedWrites = mocks.fontSet.mock.calls.length;
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                expect(mocks.fontSet).toHaveBeenCalledTimes(unauthorizedWrites);
                authorized = true; refresh();
                await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(2));
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                transition('pagehide');
                expect(mocks.removeStyles).toHaveBeenCalledTimes(2);
                const pausedWrites = mocks.fontSet.mock.calls.length;
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                expect(mocks.fontSet).toHaveBeenCalledTimes(pausedWrites);
                expect(mocks.config.browserDefaultTranslationFont).toBe(true);
                transition('pageshow');
                await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(3));
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                mocks.isDisabled.mockReturnValue(true);
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                expect(mocks.removeStyles).toHaveBeenCalledTimes(3);
                expect(mocks.config.browserDefaultTranslationFont).toBe(true);
                mocks.isDisabled.mockReturnValue(false);
                mocks.subscribeConfig.mock.calls[0][0](mocks.config);
                await vi.waitFor(() => expect(mocks.installStyles).toHaveBeenCalledTimes(4));
                expect(mocks.fontSet).toHaveBeenLastCalledWith(true);
                expect(mocks.config.browserDefaultTranslationFont).toBe(true);
                expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
            } finally { invalidate?.(); }
            expect(mocks.fontDispose).toHaveBeenCalledOnce();
        },
    );

    it.each(['qq', 'netease', 'embedded'] as const)(
        '%s 同规则真实路由变化失效旧请求，同地址通知和卸载后事件不重复失效', async kind => {
            const {listeners, window, start} = await readingFrame(kind);
            mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
            let invalidate!: () => void;
            await start({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
            const emitRoute = () => [...(listeners.get('fluentread-route-change') ?? [])]
                .forEach(callback => callback(new Event('fluentread-route-change')));
            const location = kind === 'netease'
                ? (window.top as {location: {href: string}}).location : window.location;
            emitRoute();
            expect(mocks.resetContext).not.toHaveBeenCalled();
            expect(mocks.resetRouteState).not.toHaveBeenCalled();
            expect(mocks.routeChanged).not.toHaveBeenCalled();

            location.href += '#next-reading-route';
            emitRoute();
            expect(mocks.resetContext).toHaveBeenCalledOnce();
            expect(mocks.resetRouteState).toHaveBeenCalledOnce();
            expect(mocks.routeChanged).toHaveBeenCalledWith(new URL(location.href));
            // 适配规则未变化时只失效共享上下文与提交代次，不改变原有 refresh 门禁。
            expect(mocks.sendMessage).toHaveBeenCalledOnce();
            expect(mocks.resetRouteState.mock.invocationCallOrder[0])
                .toBeLessThan(mocks.routeChanged.mock.invocationCallOrder[0]);
            emitRoute();
            expect(mocks.resetRouteState).toHaveBeenCalledOnce();

            location.href += '-again';
            emitRoute();
            expect(mocks.resetRouteState).toHaveBeenCalledTimes(2);
            expect(mocks.resetContext).toHaveBeenCalledTimes(2);
            invalidate();
            location.href += '-after-dispose';
            emitRoute();
            expect(mocks.resetRouteState).toHaveBeenCalledTimes(2);
        },
    );

    it.each(['qq', 'netease', 'embedded'] as const)(
        '%s 真实路由变化保留适配刷新资格，关闭时仍失效旧请求', async kind => {
            const {listeners, window, start} = await readingFrame(kind);
            mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
            let invalidate!: () => void;
            await start({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
            mocks.routeChanged.mockReturnValue(true);
            const location = kind === 'netease'
                ? (window.top as {location: {href: string}}).location : window.location;
            const emitRoute = () => [...(listeners.get('fluentread-route-change') ?? [])]
                .forEach(callback => callback(new Event('fluentread-route-change')));
            // 用 query 变化保持网易 reading route 的片段资格。
            const next = new URL(location.href);
            next.searchParams.set('route', 'next');
            location.href = next.href;
            emitRoute();
            await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
            expect(mocks.resetRouteState).toHaveBeenCalledOnce();
            mocks.config.on = false;
            next.searchParams.set('route', 'disabled');
            location.href = next.href;
            emitRoute();
            expect(mocks.resetRouteState).toHaveBeenCalledTimes(2);
            expect(mocks.resetContext).toHaveBeenCalledTimes(2);
            expect(mocks.routeChanged).toHaveBeenCalledTimes(2);
            expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
            invalidate();
        },
    );

    it('网易顶层阅读地址不变而子文档路由变化时仍失效请求，站点适配继续使用顶层身份', async () => {
        const {listeners, window, start} = await readingFrame('netease');
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
        let invalidate!: () => void;
        await start({isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }} as never);
        window.location.href = 'about:blank#next-frame-content';
        const emitRoute = () => [...(listeners.get('fluentread-route-change') ?? [])]
            .forEach(callback => callback(new Event('fluentread-route-change')));
        emitRoute();
        expect(mocks.resetRouteState).toHaveBeenCalledOnce();
        expect(mocks.resetContext).toHaveBeenCalledOnce();
        expect(mocks.routeChanged).toHaveBeenCalledWith(new URL((window.top as {location: {href: string}}).location.href));
        emitRoute();
        expect(mocks.resetRouteState).toHaveBeenCalledOnce();
        expect(mocks.sendMessage).toHaveBeenCalledOnce();
        invalidate();
    });

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

describe('Hugging Face Space top frame bridge', () => {
    it('rejects unrelated top and child pages and tolerates a removed runtime during notification', async () => {
        const {installEmbeddedTopFrameBridge, startEmbeddedFrameApp} = await import('@/src/app/content/embeddedFrameRuntime');
        installGlobals('https://example.com/');
        installEmbeddedTopFrameBridge(() => true, new AbortController().signal);
        await startEmbeddedFrameApp({isInvalid: false, onInvalidated: vi.fn()} as never);
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        const {window} = installGlobals('https://www.omgubuntu.co.uk/2026/09/era-rust-calendar-gnome-beta');
        window.top = {};
        installEmbeddedTopFrameBridge(() => true, new AbortController().signal);
        await startEmbeddedFrameApp({isInvalid: false, onInvalidated: vi.fn()} as never);
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        window.top = window;
        mocks.sendMessage.mockImplementation(() => {throw new Error('extension removed');});
        const lifetime = new AbortController();
        expect(() => installEmbeddedTopFrameBridge(() => true, lifetime.signal)).not.toThrow();
        expect(mocks.addRuntimeListener).toHaveBeenCalledOnce();
        lifetime.abort();
    });

    it('applies enabled, matching profile, scope and mode to top frame toggle commands', async () => {
        installGlobals('https://huggingface.co/spaces/FineEnvs/RL-Explorer');
        const {installEmbeddedTopFrameBridge} = await import('@/src/app/content/embeddedFrameRuntime');
        let enabled = false;
        const lifetime = new AbortController();
        installEmbeddedTopFrameBridge(() => enabled, lifetime.signal);
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const send = (invocation?: unknown) => listener({type: 'embeddedFrameCommand', action: 'toggle', invocation}, {id: 'extension-id'}, vi.fn());
        mocks.getState.mockReturnValue({sessionId: 3, revision: 2, fullPageMode: 'all', scope: 'content', translationConfig: {service: 's'}});
        send();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
        enabled = true;
        send({service: 's', fullPageMode: 'all', scope: 'content'});
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        send({service: 's', fullPageMode: 'viewport', scope: 'content'});
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(2);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({service: 's', fullPageMode: 'viewport', scope: 'content'});
        send({service: 's', fullPageMode: 'all', scope: 'all'});
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({service: 's', fullPageMode: 'all', scope: 'all'});
        lifetime.abort();
    });

    it('从首页软导航进入 Space 后同步会话，离开应用页拒绝命令并清理监听', async () => {
        const {window, listeners} = installGlobals('https://huggingface.co/');
        const {installEmbeddedTopFrameBridge} = await import('@/src/app/content/embeddedFrameRuntime');
        const lifetime = new AbortController();
        installEmbeddedTopFrameBridge(() => true, lifetime.signal);
        expect(mocks.addRuntimeListener).toHaveBeenCalledOnce();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const respond = vi.fn();
        const command = {type: 'embeddedFrameCommand', action: 'state'};
        const sender = {id: 'extension-id'};
        expect(listener(command, sender, respond)).toBe(false);

        window.location.href = 'https://huggingface.co/spaces/FineEnvs/RL-Explorer';
        for (const notify of listeners.get('fluentread-route-change') ?? []) notify();
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'embeddedFrameChanged'});
        expect(listener(command, sender, respond)).toBe(true);
        expect(respond).toHaveBeenCalledWith({...mocks.getState(), enabled: true});
        expect(listener({...command, action: 'toggle'}, {id: 'other'}, respond)).toBe(false);
        expect(listener({...command, action: 'toggle'}, sender, respond)).toBe(true);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();

        window.location.href += '/tree/main';
        mocks.sendMessage.mockClear();
        for (const notify of listeners.get('fluentread-route-change') ?? []) notify();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(listener({...command, action: 'toggle'}, sender, respond)).toBe(false);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        lifetime.abort();
        expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
        expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
    });
});

describe('QQ legacy top frame bridge', () => {
    it.each(['qq', 'netease', 'embedded'] as const)('顶层 %s 字体事件只提示重新读取真实快照', async kind => {
        const href = kind === 'qq' ? topUrl : kind === 'netease'
            ? 'https://mail.163.com/js6/main.jsp?sid=redacted#module=read.ReadModule%7C%7B%7D'
            : 'https://huggingface.co/spaces/FineEnvs/RL-Explorer';
        const {listeners} = installGlobals(href);
        const mail = await load();
        const {installEmbeddedTopFrameBridge} = await import('@/src/app/content/embeddedFrameRuntime');
        const install = kind === 'qq' ? mail.installQqMailTopFrameBridge
            : kind === 'netease' ? mail.installNeteaseMailTopFrameBridge : installEmbeddedTopFrameBridge;
        let browserDefaultFont = true;
        const lifetime = new AbortController();
        install(() => true, lifetime.signal, () => browserDefaultFont);
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        const type = kind === 'qq' ? 'qqMailFrameCommand' : kind === 'netease' ? 'neteaseMailFrameCommand' : 'embeddedFrameCommand';
        const respond = vi.fn();
        listener({type, action: 'state', browserDefaultFont: false}, {id: 'extension-id'}, respond);
        expect(respond).toHaveBeenLastCalledWith({...mocks.getState(), enabled: true, browserDefaultFont: true});
        browserDefaultFont = false;
        for (const notify of listeners.get('fluentread-page-translation-font-changed') ?? []) notify();
        listener({type, action: 'state'}, {id: 'extension-id'}, respond);
        expect(respond).toHaveBeenLastCalledWith({...mocks.getState(), enabled: true, browserDefaultFont: false});
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
        lifetime.abort();
        expect(listeners.get('fluentread-page-translation-font-changed')?.size).toBe(0);
    });

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

describe('expired-frame language initialization', () => {
    const kinds = ['qq', 'netease', 'embedded'] as const;
    type Kind = typeof kinds[number];
    async function fixture(kind: Kind) {
        const href = kind === 'qq' ? 'https://mail.qq.com/cgi-bin/readmail?mailid=language'
            : kind === 'netease' ? 'about:blank' : 'https://www.kaggleusercontent.com/kf/126670518/signed-token/__results__.html';
        const globals = installGlobals(href);
        Object.assign(globals.window.location, {hostname: kind === 'netease' ? '' : new URL(href).hostname});
        globals.window.top = kind === 'netease'
            ? {location: {href: 'https://mail.163.com/js6/main.jsp?sid=redacted#module=read.ReadModule%7C%7B%7D'}} : {};
        vi.stubGlobal('navigator', {});
        Object.assign(mocks.config, {uiLanguage: 'en-US'});
        Object.assign(browser.runtime, {getURL: (path: string) => `chrome-extension://language-fixture/${path}`});
        const json = vi.fn(async () => ({messages: {'frame.language.test': 'Loaded language'}, legacyText: {}, legacyPatterns: {early: [], late: []}}));
        const response = {ok: true, status: 200, json};
        const fetch = vi.fn(async () => response);
        vi.stubGlobal('fetch', fetch);
        const language = await import('@/src/platform/i18n/uiLanguageBundles');
        const ensure = vi.spyOn(language, 'ensureUiLanguageBundle');
        const definition = kind === 'netease' ? await loadNeteaseEntry() : (await import('../entrypoints/supportedFrame.content')).default;
        return {...globals, fetch, json, response, ensure, ensureLanguage: language.ensureUiLanguageBundle, start: definition.main};
    }
    const flush = async () => {for (let tick = 0; tick < 12; tick++) await Promise.resolve();};
    afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

    it.each(kinds.flatMap(kind => (['invalid', 'pagehide'] as const).map(reason => ({kind, reason}))))(
        '$kind does not start a language request after $reason while configuration was pending', async ({kind, reason}) => {
            const f = await fixture(kind);
            let ready!: () => void, invalidate: (() => void) | undefined, invalid = false;
            mocks.configReady = new Promise<void>(resolve => {ready = resolve;});
            const starting = f.start({get isInvalid() {return invalid;}, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
            try {
                await flush();expect(f.ensure).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled();
                if (reason === 'invalid') invalid = true;
                else {
                    const event = Object.assign(new Event('pagehide'), {persisted: false});
                    Object.defineProperty(event, 'isTrusted', {value: true});f.window.dispatchEvent(event);
                }
                ready();await starting;
                expect(f.ensure).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled();expect(f.json).not.toHaveBeenCalled();
                expect(mocks.sendMessage).not.toHaveBeenCalled();expect(mocks.installStyles).not.toHaveBeenCalled();expect(mocks.mountSelection).not.toHaveBeenCalled();
                expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
            } finally {invalidate?.();}
        },
    );

    it.each(kinds)('%s still waits for the live frame language before requesting authorization and installing tools', async kind => {
        const f = await fixture(kind);let release!: () => void, invalidate: (() => void) | undefined, settled = false;
        const resource = new Promise<void>(resolve => {release = resolve;});
        f.fetch.mockImplementationOnce(async () => {await resource;return f.response;});
        mocks.sendMessage.mockResolvedValue({enabled: true, revision: 0, sessionId: null});
        const starting = f.start({isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        void Promise.resolve(starting).then(() => {settled = true;});
        try {
            await flush();expect(f.ensure).toHaveBeenCalledOnce();expect(f.ensure).toHaveBeenCalledWith('en-US');expect(f.fetch).toHaveBeenCalledOnce();
            expect(settled).toBe(false);expect(mocks.sendMessage).not.toHaveBeenCalled();expect(mocks.installStyles).not.toHaveBeenCalled();
            release();await starting;await flush();expect(f.json).toHaveBeenCalledOnce();expect(settled).toBe(true);
            expect(mocks.sendMessage).toHaveBeenCalledOnce();expect(mocks.installStyles).toHaveBeenCalledOnce();
            if (kind === 'netease') expect(mocks.mountSelection).toHaveBeenCalledOnce();
            else expect(mocks.mountSelection).not.toHaveBeenCalled();
        } finally {release();invalidate?.();}
    });

    it.each(kinds)('%s lets a shared language load finish after its frame becomes invalid without installing stale tools', async kind => {
        const f = await fixture(kind);let release!: () => void, invalidate: (() => void) | undefined, invalid = false;
        const resource = new Promise<void>(resolve => {release = resolve;});
        f.fetch.mockImplementationOnce(async () => {await resource;return f.response;});
        const starting = f.start({get isInvalid() {return invalid;}, onInvalidated: (callback: () => void) => {invalidate = callback;}} as never);
        try {
            await flush();expect(f.fetch).toHaveBeenCalledOnce();invalid = true;
            const shared = f.ensureLanguage('en-US');release();await expect(shared).resolves.toBe(true);await starting;
            expect(f.fetch).toHaveBeenCalledOnce();expect(f.json).toHaveBeenCalledOnce();
            expect(mocks.sendMessage).not.toHaveBeenCalled();expect(mocks.installStyles).not.toHaveBeenCalled();expect(mocks.mountSelection).not.toHaveBeenCalled();
        } finally {release();invalidate?.();}
    });
});
