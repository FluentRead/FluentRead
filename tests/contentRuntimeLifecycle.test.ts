import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installContentPageLifecycle} from '@/src/app/content/pageLifecycle';

const mocks = vi.hoisted(() => ({
    config: {
        on: true, disabledExtensionDomains: [] as string[], bilingualSentenceHighlightEnabled: true,
        disableFloatingBall: true, disableSelectionTranslator: true, disableImageTranslator: true,
        selectionAreaEnabled: false, translationProgressPanelEnabled: false,
    },
    configReady: Promise.resolve(), subscribeConfig: vi.fn(),
    installPageStyles: vi.fn(), removeStyles: vi.fn(), syncHighlight: vi.fn(),
    mountInput: vi.fn(), invalidateInput: vi.fn(), restoreOriginal: vi.fn(),
    resetRouteState: vi.fn(),
    addRuntimeListener: vi.fn(), removeRuntimeListener: vi.fn(), createMessageHandler: vi.fn(),
    setBridges: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config, get configReady() { return mocks.configReady; }, subscribeConfig: mocks.subscribeConfig,
}));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({createShadowRootUi: vi.fn()}));
vi.mock('@/src/app/content/features', () => ({
    ...Object.fromEntries([
        'autoTranslateEnglishPage', 'cancelPendingHoverTranslation', 'handleTranslation', 'noteBilingualHostGesture',
        'inputBoxTranslationConfigKey', 'isAreaTranslatorMounted', 'isFullPageTranslationActive',
        'mountAreaTranslator', 'mountFloatingBall', 'mountImageTranslator', 'mountSelectionTranslator',
        'mountTranslationProgressPanel', 'mountVideoSubtitleTranslation', 'isSupportedVideoPage',
        'unmountAreaTranslator', 'unmountFloatingBall',
        'unmountImageTranslator', 'unmountSelectionTranslator', 'unmountTranslationProgressPanel',
    ].map(name => [name, vi.fn()])),
    restoreOriginalContent: mocks.restoreOriginal,
    resetFullPageTranslationRouteState: mocks.resetRouteState,
    createInputTranslationContentFeature: () => ({mount: mocks.mountInput, invalidate: mocks.invalidateInput}),
    mountHoverTranslationContentFeature: () => vi.fn(),
}));
vi.mock('@/src/app/translation/client', () => ({cancelAllTranslations: vi.fn()}));
vi.mock('@/src/services/translation/context', () => ({resetPageTranslationContextCache: vi.fn()}));
vi.mock('@/src/services/translation/legacyPageCache', () => ({clearLegacyPageTranslationCache: vi.fn()}));
vi.mock('@/src/app/content/hotkeyRuntime', () => ({
    createContentHotkeyRuntime: () => ({installFloatingBallHotkey: () => vi.fn()}),
}));
vi.mock('@/src/app/content/quickTranslationRuntime', () => ({mountConfiguredQuickTranslation: vi.fn()}));
vi.mock('@/src/app/content/pageStyles', () => ({installPageStyles: mocks.installPageStyles}));
vi.mock('@/src/app/content/qqMailFrameRuntime', () => ({installQqMailTopFrameBridge: vi.fn()}));
vi.mock('@/src/app/content/mainWorldBridgeLifecycle', () => ({setMainWorldBridgesEnabled: mocks.setBridges}));
vi.mock('@/src/app/content/messageRuntime', () => ({createContentRuntimeMessageHandler: mocks.createMessageHandler}));
vi.mock('@/src/app/content/bilingualSentenceHighlight', () => ({syncBilingualSentenceHighlight: mocks.syncHighlight}));
vi.mock('@/src/app/content/siteAdaptationRuntime', () => ({
    createContentSiteAdaptationRuntime: () => ({routeChanged: vi.fn(), update: vi.fn()}),
}));

function transition(target: EventTarget, type: string, persisted = false, trusted = true): void {
    // Node EventTarget 没有浏览器导航入口；只在夹具中标记浏览器派发的可信生命周期。
    const event = Object.assign(new Event(type), {persisted});
    Object.defineProperty(event, 'isTrusted', {value: trusted});
    target.dispatchEvent(event);
}

describe('content runtime 页面生命周期', () => {
    it('取消离开不卸载，往返缓存暂停后可恢复，真正离开只销毁一次', () => {
        const target = new EventTarget();
        const controller = new AbortController();
        const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
        const state = installContentPageLifecycle(target, controller.signal, actions);
        expect(state.isSuspended()).toBe(false);
        transition(target, 'beforeunload');
        transition(target, 'pageshow');
        expect(actions.dispose).not.toHaveBeenCalled();
        expect(actions.suspend).not.toHaveBeenCalled();
        transition(target, 'pagehide', true);
        expect(state.isSuspended()).toBe(true);
        transition(target, 'pagehide', true);
        expect(actions.suspend).toHaveBeenCalledOnce();
        transition(target, 'pageshow');
        expect(actions.resume).not.toHaveBeenCalled();
        transition(target, 'pageshow', true);
        expect(state.isSuspended()).toBe(false);
        transition(target, 'pageshow', true);
        expect(actions.resume).toHaveBeenCalledOnce();
        transition(target, 'pagehide');
        transition(target, 'pagehide');
        transition(target, 'pageshow', true);
        expect(actions.dispose).toHaveBeenCalledOnce();
        expect(actions.resume).toHaveBeenCalledOnce();
    });

    it('宿主伪造页面离开不能卸载扩展，伪造恢复也不能绕过真正的暂停', () => {
        const target = new EventTarget();
        const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
        const state = installContentPageLifecycle(target, new AbortController().signal, actions);
        transition(target, 'pagehide', false, false);
        transition(target, 'pagehide', true, false);
        expect(actions.dispose).not.toHaveBeenCalled();
        expect(actions.suspend).not.toHaveBeenCalled();
        expect(state.isSuspended()).toBe(false);
        transition(target, 'pagehide', true);
        transition(target, 'pageshow', true, false);
        expect(actions.resume).not.toHaveBeenCalled();
        expect(state.isSuspended()).toBe(true);
        transition(target, 'pageshow', true);
        expect(actions.resume).toHaveBeenCalledOnce();
        expect(state.isSuspended()).toBe(false);
    });

    it('运行时失效后移除页面监听，不允许迟到的 pageshow 复活扩展', () => {
        const target = new EventTarget();
        const controller = new AbortController();
        const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
        installContentPageLifecycle(target, controller.signal, actions);
        transition(target, 'pagehide', true);
        controller.abort();
        transition(target, 'pageshow', true);
        transition(target, 'pagehide');
        expect(actions.resume).not.toHaveBeenCalled();
        expect(actions.dispose).not.toHaveBeenCalled();
    });
});

describe('content composition root 冷启动与暂停恢复', () => {
    let page: EventTarget;
    let invalidated: () => void;
    let context: {isInvalid: boolean; onInvalidated: (callback: () => void) => void};
    let ready: () => void;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.config.on = true;
        mocks.config.disabledExtensionDomains = [];
        mocks.config.bilingualSentenceHighlightEnabled = true;
        mocks.configReady = new Promise<void>(resolve => { ready = resolve; });
        mocks.installPageStyles.mockReturnValue(mocks.removeStyles);
        mocks.subscribeConfig.mockReturnValue(vi.fn());
        mocks.createMessageHandler.mockReturnValue(vi.fn());
        context = {isInvalid: false, onInvalidated: callback => { invalidated = callback; }};
        page = Object.assign(new EventTarget(), {location: {href: 'https://example.com/article'}});
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', Object.assign(new EventTarget(), {getElementById: () => null}));
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('browser', {runtime: {
            sendMessage: vi.fn().mockResolvedValue(undefined),
            onMessage: {addListener: mocks.addRuntimeListener, removeListener: mocks.removeRuntimeListener},
        }});
    });

    afterEach(() => { invalidated?.(); vi.unstubAllGlobals(); });

    it.each(['pagehide', 'invalidate'] as const)('配置读取期间 %s 后不允许迟到初始化挂载', async reason => {
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        if (reason === 'pagehide') transition(page, 'pagehide');
        else { context.isInvalid = true; invalidated(); }
        ready();
        await starting;
        transition(page, 'pageshow', true);
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
        expect(mocks.mountInput).not.toHaveBeenCalled();
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        expect(mocks.subscribeConfig).not.toHaveBeenCalled();
    });

    it('配置读取期间进往返缓存，配置就绪后继续保持暂停直到真实恢复', async () => {
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        transition(page, 'pagehide', true);
        ready();
        await starting;
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
        const state = mocks.createMessageHandler.mock.calls[0][1];
        expect(state.isPageSuspended()).toBe(true);
        transition(page, 'pageshow', true, false);
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
        transition(page, 'pageshow', true);
        await vi.waitFor(() => expect(mocks.installPageStyles).toHaveBeenCalledOnce());
        expect(state.isPageSuspended()).toBe(false);
        expect(mocks.mountInput).toHaveBeenCalledOnce();
        invalidated();
        transition(page, 'pageshow', true);
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.installPageStyles).toHaveBeenCalledOnce();
    });

    it('取消离开以及伪造离开都保留功能；暂停时配置回声不能写入高亮属性', async () => {
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        transition(page, 'beforeunload');
        transition(page, 'pagehide', false, false);
        ready();
        await starting;
        expect(mocks.installPageStyles).toHaveBeenCalledOnce();
        transition(page, 'pagehide', true);
        const onConfig = mocks.subscribeConfig.mock.calls[0][0];
        onConfig(mocks.config);
        expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.installPageStyles).toHaveBeenCalledOnce();
    });

    it('站点禁用时其他设置变更不能重新给宿主页面添加高亮属性', async () => {
        mocks.config.disabledExtensionDomains = ['example.com'];
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        ready();
        await starting;
        mocks.subscribeConfig.mock.calls[0][0](mocks.config);
        expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false);
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
    });

    it('宿主伪造相同 URL 的路由通知不能反复失效正在执行的翻译', async () => {
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        ready();
        await starting;
        document.dispatchEvent(new Event('fluentread-route-change'));
        expect(mocks.resetRouteState).not.toHaveBeenCalled();
        window.location.href = 'https://example.com/next-article';
        document.dispatchEvent(new Event('fluentread-route-change'));
        document.dispatchEvent(new Event('fluentread-route-change'));
        expect(mocks.resetRouteState).toHaveBeenCalledOnce();
    });
});
