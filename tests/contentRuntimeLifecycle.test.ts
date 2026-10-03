/**
 * @file tests/contentRuntimeLifecycle.test.ts
 * 文件职责：验证内容应用启动、配置等待、页面暂停恢复与离开时的生命周期边界。
 * 主要内容：隔离各 feature 的组合根依赖，确认原始 XML 与失效上下文不会启动运行时，迟到初始化和伪造页面事件不会挂载功能，扩展端口撤销或拒绝注销也不会中断宿主页面清理。
 * 模块边界：不测试各 feature 的 Vue 组件或真实翻译请求；跨域 frame 的身份与会话另有专门测试。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installContentPageLifecycle, waitForContentDocument} from '@/src/app/content/pageLifecycle';
import {isRawXmlContentDocument} from '@/src/shared/dom/documentType';

const mocks = vi.hoisted(() => ({
    config: {
        on: true, disabledExtensionDomains: [] as string[], bilingualSentenceHighlightEnabled: true,
        disableFloatingBall: true, disableSelectionTranslator: true, disableImageTranslator: true,
        selectionAreaEnabled: false, translationProgressPanelEnabled: false,
        writing: {enabled: false}, inputBoxTranslationTrigger: 'disabled', paragraphCopyEnabled: false,
    },
    configReady: Promise.resolve(), subscribeConfig: vi.fn(),
    installPageStyles: vi.fn(), removeStyles: vi.fn(), syncHighlight: vi.fn(), mountParagraphCopyContentFeature: vi.fn(),
    mountInput: vi.fn(), invalidateInput: vi.fn(), restoreOriginal: vi.fn(),
    resetRouteState: vi.fn(),
    addRuntimeListener: vi.fn(), removeRuntimeListener: vi.fn(), createMessageHandler: vi.fn(),
    setBridges: vi.fn(),
    mountWriting: vi.fn(), unmountWriting: vi.fn(), writingMounted: false,
    floatingBallAllowed: true, shareCardMounted: false, mountShareCard: vi.fn(),
}));
vi.mock('@/src/features/writing-assistant/public', () => ({
    mountWritingAssistant: () => {mocks.writingMounted = true; mocks.mountWriting();},
    unmountWritingAssistant: () => {mocks.writingMounted = false; mocks.unmountWriting();},
    isWritingAssistantMounted: () => mocks.writingMounted,
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
        'mountParagraphCopyContentFeature', 'mountSectionTranslationContentFeature',
        'unmountAreaTranslator', 'unmountFloatingBall',
        'unmountImageTranslator', 'unmountSelectionTranslator', 'unmountTranslationProgressPanel',
    ].map(name => [name, vi.fn()])),
    mountParagraphCopyContentFeature: mocks.mountParagraphCopyContentFeature,
    mountShareCard: () => { mocks.shareCardMounted = true; mocks.mountShareCard(); },
    unmountShareCard: () => { mocks.shareCardMounted = false; },
    isShareCardMounted: () => mocks.shareCardMounted,
    isFloatingBallAllowedOnPage: () => mocks.floatingBallAllowed,
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
vi.mock('@/src/app/content/qqMailFrameRuntime', () => ({
    installQqMailTopFrameBridge: vi.fn(),
    installNeteaseMailTopFrameBridge: vi.fn(),
}));
vi.mock('@/src/app/content/embeddedFrameRuntime', () => ({installEmbeddedTopFrameBridge: vi.fn()}));
vi.mock('@/src/app/content/mainWorldBridgeLifecycle', () => ({setMainWorldBridgesEnabled: mocks.setBridges}));
vi.mock('@/src/app/content/messageRuntime', () => ({createContentRuntimeMessageHandler: mocks.createMessageHandler}));
vi.mock('@/src/app/content/bilingualSentenceHighlight', () => ({syncBilingualSentenceHighlight: mocks.syncHighlight}));
vi.mock('@/src/app/content/siteAdaptationRuntime', () => ({
    createContentSiteAdaptationRuntime: () => ({routeChanged: vi.fn(), update: vi.fn()}),
    applyCoreTranslationPreferences: vi.fn(() => false),
}));

function transition(target: EventTarget, type: string, persisted = false, trusted = true): void {
    // Node EventTarget 没有浏览器导航入口；只在夹具中标记浏览器派发的可信生命周期。
    const event = Object.assign(new Event(type), {persisted});
    Object.defineProperty(event, 'isTrusted', {value: trusted});
    target.dispatchEvent(event);
}

class FakeMutationObserver {
    static instance: FakeMutationObserver | null = null;
    readonly observe = vi.fn();
    readonly disconnect = vi.fn();

    constructor(private readonly callback: () => void) {
        FakeMutationObserver.instance = this;
    }

    trigger(): void {
        this.callback();
    }
}

function createLoadingDocument(): {document: Document; setBody: () => void} {
    const target = new EventTarget() as Document;
    const documentElement = {isConnected: true} as unknown as HTMLElement;
    let body: Node | null = null;
    Object.defineProperties(target, {
        documentElement: {configurable: true, get: () => documentElement},
        body: {configurable: true, get: () => body},
    });
    return {
        document: target,
        setBody: () => { body = {isConnected: true} as unknown as Node; },
    };
}

describe('content document 基础 DOM 就绪边界', () => {
    afterEach(() => {
        FakeMutationObserver.instance = null;
        vi.unstubAllGlobals();
    });

    it('body 出现后立即放行，不等待 DOMContentLoaded', async () => {
        const {document, setBody} = createLoadingDocument();
        vi.stubGlobal('MutationObserver', FakeMutationObserver);
        const ready = waitForContentDocument(document, new AbortController().signal);

        expect(FakeMutationObserver.instance).not.toBeNull();
        setBody();
        FakeMutationObserver.instance!.trigger();

        await expect(ready).resolves.toBe(true);
        expect(FakeMutationObserver.instance!.disconnect).toHaveBeenCalledOnce();
        FakeMutationObserver.instance!.trigger();
    });

    it('已有基础 DOM 时同步放行', async () => {
        const {document, setBody} = createLoadingDocument();
        setBody();

        await expect(waitForContentDocument(document, new AbortController().signal)).resolves.toBe(true);
    });

    it('信号已取消时不建立观察器', async () => {
        const {document} = createLoadingDocument();
        const controller = new AbortController();
        controller.abort();

        await expect(waitForContentDocument(document, controller.signal)).resolves.toBe(false);
    });

    it('页面离开时结束等待，不迟到激活内容功能', async () => {
        const {document} = createLoadingDocument();
        const controller = new AbortController();
        vi.stubGlobal('MutationObserver', FakeMutationObserver);
        const ready = waitForContentDocument(document, controller.signal);

        controller.abort();

        await expect(ready).resolves.toBe(false);
        expect(FakeMutationObserver.instance!.disconnect).toHaveBeenCalledOnce();
    });
});

describe('内容脚本文档类型边界', () => {
    it.each([
        ['text/html', false],
        ['application/xhtml+xml', false],
        ['text/plain', false],
        ['application/json', false],
        ['text/xml', true],
        ['application/xml', true],
        ['application/rss+xml', true],
        ['image/svg+xml', true],
        ['text/xsl', true],
    ] as const)('%s 是否属于原始 XML 文档：%s', (contentType, expected) => {
        expect(isRawXmlContentDocument({contentType})).toBe(expected);
    });
});

describe('content runtime 页面生命周期', () => {
    it('上下文检查只在失效时销毁一次，并立即停止检查', () => {
        vi.useFakeTimers();
        try {
            const target = new EventTarget(), context = {isInvalid: false};
            const actions = {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()};
            installContentPageLifecycle(target, new AbortController().signal, actions, context);
            vi.advanceTimersByTime(1000);
            expect(actions.dispose).not.toHaveBeenCalled();
            context.isInvalid = true;
            vi.advanceTimersByTime(2000);
            transition(target, 'pagehide');
            expect(actions.dispose).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });

    it('已经中止的页面不会安装上下文定时器', () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController(); controller.abort();
            installContentPageLifecycle(new EventTarget(), controller.signal,
                {suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn()}, {isInvalid: true});
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });
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
        mocks.config.writing.enabled = false;
        mocks.writingMounted = false;
        mocks.shareCardMounted = false;
        mocks.config.disabledExtensionDomains = [];
        mocks.config.bilingualSentenceHighlightEnabled = true;
        mocks.configReady = new Promise<void>(resolve => { ready = resolve; });
        mocks.installPageStyles.mockReturnValue(mocks.removeStyles);
        mocks.subscribeConfig.mockReturnValue(vi.fn());
        mocks.createMessageHandler.mockReturnValue(vi.fn());
        invalidated = vi.fn();
        context = {isInvalid: false, onInvalidated: callback => { invalidated = callback; }};
        page = Object.assign(new EventTarget(), {location: {href: 'https://example.com/article'}});
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', Object.assign(new EventTarget(), {contentType: 'text/html', getElementById: () => null}));
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('browser', {runtime: {
            sendMessage: vi.fn().mockResolvedValue(undefined),
            onMessage: {addListener: mocks.addRuntimeListener, removeListener: mocks.removeRuntimeListener},
        }});
    });

    afterEach(() => { invalidated?.(); vi.unstubAllGlobals(); });

    it('空闲页面在扩展失效后主动清理，停止上下文检查且不再次挂载', async () => {
        vi.useFakeTimers();
        try {
            const unsubscribe = vi.fn();
            mocks.subscribeConfig.mockReturnValue(unsubscribe);
            const {startContentApp} = await import('@/src/app/content/runtime');
            const starting = startContentApp(context as never); ready(); await starting;
            context.isInvalid = true;
            vi.stubGlobal('browser', {});
            await vi.advanceTimersByTimeAsync(1000);
            expect(mocks.removeStyles).toHaveBeenCalledOnce();
            expect(mocks.restoreOriginal).toHaveBeenCalledOnce();
            expect(unsubscribe).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            transition(page, 'pageshow', true);
            expect(mocks.installPageStyles).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });

    it.each(['text/xml', 'application/xml', 'application/rss+xml', 'image/svg+xml'])('%s 文档不等待配置，也不挂载页面功能或桥', async contentType => {
        Object.assign(document, {contentType});
        const registerInvalidation = vi.fn();
        context.onInvalidated = registerInvalidation;
        const {startContentApp} = await import('@/src/app/content/runtime');
        await startContentApp(context as never);
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
        expect(mocks.setBridges).not.toHaveBeenCalled();
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        expect(mocks.subscribeConfig).not.toHaveBeenCalled();
        expect(registerInvalidation).not.toHaveBeenCalled();
    });

    it('XHTML 文档仍可启动网页功能', async () => {
        Object.assign(document, {contentType: 'application/xhtml+xml'});
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never); ready(); await starting;
        expect(mocks.installPageStyles).toHaveBeenCalledOnce();
    });

    it('纯文本页面保留现有的网页功能入口', async () => {
        Object.assign(document, {contentType: 'text/plain'});
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never); ready(); await starting;
        expect(mocks.installPageStyles).toHaveBeenCalledOnce();
    });

    it('启动前已经失效的扩展上下文不注册页面生命周期', async () => {
        context.isInvalid = true;
        const registerInvalidation = vi.fn();
        context.onInvalidated = registerInvalidation;
        const {startContentApp} = await import('@/src/app/content/runtime');
        ready();

        await startContentApp(context as never);

        expect(registerInvalidation).not.toHaveBeenCalled();
        expect(mocks.addRuntimeListener).not.toHaveBeenCalled();
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
    });

    it('扩展重载移除 runtime 后仍完成监听、页面样式与配置订阅清理', async () => {
        const unsubscribe = vi.fn();
        mocks.subscribeConfig.mockReturnValue(unsubscribe);
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never); ready(); await starting;
        const listener = mocks.addRuntimeListener.mock.calls[0][0];
        vi.stubGlobal('browser', {});

        expect(() => invalidated()).not.toThrow();

        expect(mocks.removeRuntimeListener).toHaveBeenCalledWith(listener);
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.restoreOriginal).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
        invalidated();
        expect(mocks.removeStyles).toHaveBeenCalledOnce();
    });

    it('失效消息端口拒绝注销时仍清理页面功能和配置订阅', async () => {
        const unsubscribe = vi.fn();
        mocks.subscribeConfig.mockReturnValue(unsubscribe);
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never); ready(); await starting;
        mocks.removeRuntimeListener.mockImplementationOnce(() => { throw new Error('Extension context invalidated.'); });

        expect(() => invalidated()).not.toThrow();

        expect(mocks.removeStyles).toHaveBeenCalledOnce();
        expect(mocks.restoreOriginal).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('写作和分享卡片遵循同一启停和 BFCache 恢复生命周期', async () => {
        Object.assign(page, {location: {href: 'https://github.com/FluentRead/FluentRead/issues/1'}});
        mocks.config.writing.enabled = true;
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never); ready(); await starting;
        expect(mocks.mountWriting).toHaveBeenCalledOnce();
        expect(mocks.mountShareCard).toHaveBeenCalledOnce();
        transition(page, 'pagehide', true);
        expect(mocks.writingMounted).toBe(false);
        expect(mocks.shareCardMounted).toBe(false);
        transition(page, 'pageshow', true);
        await vi.waitFor(() => expect(mocks.mountWriting).toHaveBeenCalledTimes(2));
        expect(mocks.mountShareCard).toHaveBeenCalledTimes(2);
        invalidated();
        expect(mocks.writingMounted).toBe(false);
        expect(mocks.shareCardMounted).toBe(false);
    });

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
        expect(mocks.mountInput).not.toHaveBeenCalled();
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
        expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false, undefined, undefined);
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
        expect(mocks.syncHighlight).toHaveBeenLastCalledWith(document, false, undefined, undefined);
        expect(mocks.installPageStyles).not.toHaveBeenCalled();
    });

    it('默认关闭的输入框和段落复制功能按配置变化增删监听器', async () => {
        const {startContentApp} = await import('@/src/app/content/runtime');
        const starting = startContentApp(context as never);
        ready();
        await starting;

        expect(mocks.mountInput).not.toHaveBeenCalled();
        expect(mocks.mountParagraphCopyContentFeature).not.toHaveBeenCalled();

        const onConfig = mocks.subscribeConfig.mock.calls[0][0];
        mocks.config.inputBoxTranslationTrigger = 'ctrl_enter';
        mocks.config.paragraphCopyEnabled = true;
        onConfig(mocks.config);
        expect(mocks.mountInput).toHaveBeenCalledOnce();
        expect(mocks.mountParagraphCopyContentFeature).toHaveBeenCalledOnce();

        mocks.config.inputBoxTranslationTrigger = 'disabled';
        mocks.config.paragraphCopyEnabled = false;
        onConfig(mocks.config);
        expect(mocks.invalidateInput).toHaveBeenCalled();

        invalidated();
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
