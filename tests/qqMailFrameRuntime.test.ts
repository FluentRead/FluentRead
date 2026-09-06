import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {on: true, disabledExtensionDomains: [], bilingualSentenceHighlightEnabled: false},
    configReady: Promise.resolve(),
    sendMessage: vi.fn(),
    addRuntimeListener: vi.fn(),
    removeRuntimeListener: vi.fn(),
    autoTranslateEnglishPage: vi.fn(),
    restoreOriginalContent: vi.fn(),
    getState: vi.fn(),
    isDisabled: vi.fn(() => false),
    subscribeConfig: vi.fn(), installStyles: vi.fn(), removeStyles: vi.fn(), syncHighlight: vi.fn(),
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
}));
vi.mock('@/src/app/translation/client', () => ({cancelAllTranslations: vi.fn()}));
vi.mock('@/src/shared/geometry/touch', () => ({getCenterPoint: vi.fn()}));
vi.mock('@/src/app/content/features', () => ({
    cancelPendingHoverTranslation: vi.fn(), handleTranslation: vi.fn(), mountHoverTranslationContentFeature: () => vi.fn(),
    noteBilingualHostGesture: vi.fn(),
}));
vi.mock('@/src/app/content/hotkeyRuntime', () => ({
    createContentHotkeyRuntime: () => ({installFloatingBallHotkey: () => vi.fn()}),
}));
vi.mock('@/src/app/content/quickTranslationRuntime', () => ({mountConfiguredQuickTranslation: vi.fn()}));
vi.mock('@/src/app/content/pageStyles', () => ({installPageStyles: mocks.installStyles}));
vi.mock('@/src/app/content/bilingualSentenceHighlight', () => ({syncBilingualSentenceHighlight: mocks.syncHighlight}));
vi.mock('@/src/app/content/siteAdaptationRuntime', () => ({
    createContentSiteAdaptationRuntime: () => ({routeChanged: vi.fn(), update: vi.fn()}),
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
    const document = {addEventListener: vi.fn(add), removeEventListener: vi.fn(remove)};
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
    mocks.isDisabled.mockReturnValue(false);
    mocks.subscribeConfig.mockReset().mockReturnValue(vi.fn());
    mocks.installStyles.mockReset().mockReturnValue(mocks.removeStyles);
    mocks.removeStyles.mockReset();
    mocks.syncHighlight.mockReset();
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
