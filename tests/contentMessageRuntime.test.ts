import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';

const mocks = vi.hoisted(() => ({
    config: {
        harness: undefined as {enabled: boolean} | undefined,
        on: true,
        disableFloatingBall: false,
        selectionTranslatorMode: 'bilingual',
        disableSelectionTranslator: false,
        selectionTranslatorTrigger: 'direct',
        selectionTranslatorHotkey: 'none',
        customSelectionTranslatorHotkey: '',
        selectionTranslatorDelay: 0,
        selectionAreaEnabled: false,
        disableImageTranslator: false,
        translationProgressPanelEnabled: false,
    },
    normalizeDelay: vi.fn((value: number | string) => Number(value)),
    autoTranslateEnglishPage: vi.fn(),
    invalidateFullPageTranslationSessionCache: vi.fn(),
    isFullPageTranslationActive: vi.fn(),
    getTranslationToolbarStatus: vi.fn(),
    readFullPageUnchangedCompletion: vi.fn(),
    mountAreaTranslator: vi.fn(),
    mountFloatingBall: vi.fn(),
    toggleContextMenuImage: vi.fn(),
    mountImageTranslator: vi.fn(),
    mountSelectionTranslator: vi.fn(),
    mountTranslationProgressPanel: vi.fn(),
    restoreOriginalContent: vi.fn(),
    unmountAreaTranslator: vi.fn(),
    unmountFloatingBall: vi.fn(),
    unmountImageTranslator: vi.fn(),
    unmountSelectionTranslator: vi.fn(),
    unmountTranslationProgressPanel: vi.fn(),
    translateSelectionFromContextMenu: vi.fn(),
    startAreaTranslationFromContextMenu: vi.fn(),
    startSectionTranslationPicker: vi.fn(),
    sendMessage: vi.fn(),
    showPageNotice: vi.fn(),
    dismissPageNotice: vi.fn(),
}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice: mocks.showPageNotice, dismissPageNotice: mocks.dismissPageNotice}));

// Context 是受控外部生命周期端口；用原生 AbortController 驱动 invalid 门禁，避免伪造强转。
// 本 suite 验证实际 handler，不声称执行 WXT 的启动广播或浏览器环境检测。
vi.mock('wxt/utils/content-script-context', () => ({
    ContentScriptContext: class extends AbortController {
        get isInvalid() {return this.signal.aborted;}
    },
}));

vi.mock('@/src/core/config/model', () => ({
    normalizeSelectionTranslatorDelay: mocks.normalizeDelay,
}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/app/content/features', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    invalidateFullPageTranslationSessionCache: mocks.invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive: mocks.isFullPageTranslationActive,
    getTranslationToolbarStatus: mocks.getTranslationToolbarStatus,
    readFullPageUnchangedCompletion: mocks.readFullPageUnchangedCompletion,
    getFullPageTranslationFrameState: () => ({sessionId: 7}),
    mountAreaTranslator: mocks.mountAreaTranslator,
    mountFloatingBall: mocks.mountFloatingBall,
    toggleContextMenuImage: mocks.toggleContextMenuImage,
    mountImageTranslator: mocks.mountImageTranslator,
    mountSelectionTranslator: mocks.mountSelectionTranslator,
    mountTranslationProgressPanel: mocks.mountTranslationProgressPanel,
    restoreOriginalContent: mocks.restoreOriginalContent,
    unmountAreaTranslator: mocks.unmountAreaTranslator,
    unmountFloatingBall: mocks.unmountFloatingBall,
    unmountImageTranslator: mocks.unmountImageTranslator,
    unmountSelectionTranslator: mocks.unmountSelectionTranslator,
    unmountTranslationProgressPanel: mocks.unmountTranslationProgressPanel,
    translateSelectionFromContextMenu: mocks.translateSelectionFromContextMenu,
    startAreaTranslationFromContextMenu: mocks.startAreaTranslationFromContextMenu,
    startSectionTranslationPicker: mocks.startSectionTranslationPicker,
}));

beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    Object.assign(mocks.config, {
        harness: undefined,
        on: true,
        disableFloatingBall: false,
        selectionTranslatorMode: 'bilingual',
        disableSelectionTranslator: false,
        selectionTranslatorTrigger: 'direct',
        selectionTranslatorHotkey: 'none',
        customSelectionTranslatorHotkey: '',
        selectionTranslatorDelay: 0,
        selectionAreaEnabled: false,
        disableImageTranslator: false,
        translationProgressPanelEnabled: false,
    });
    for (const value of Object.values(mocks)) {
        if (typeof value === 'function' && 'mockReset' in value) value.mockReset();
    }
    mocks.normalizeDelay.mockImplementation((value) => Number(value));
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.isFullPageTranslationActive.mockReturnValue(false);
    mocks.getTranslationToolbarStatus.mockReturnValue('idle');
    vi.stubGlobal('browser', {runtime: {sendMessage: mocks.sendMessage}});
    vi.stubGlobal('document', {getElementById: vi.fn(() => null)});
});

describe('内容脚本 runtime 消息协议', () => {
    it('信息高亮状态在暂停或关闭时仍可读，关闭可抢占，开启和重试遵循当前页面门禁', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn(); let disabled = false, suspended = false, invalid = false;
        const snapshot = {enabled: false, phase: 'idle', sessionId: '0', processedParagraphs: 0, queuedParagraphs: 0, highlightedSpans: 0, mode: 'keywords'} as const;
        const feature = {getState: vi.fn(() => snapshot), setEnabled: vi.fn((enabled: boolean) => ({...snapshot, enabled})), retry: vi.fn(() => snapshot)};
        const handler = createContentRuntimeMessageHandler({get isInvalid() {return invalid;}} as ContentScriptContext, {
            isSiteDisabled: () => disabled, isPageSuspended: () => suspended, updateSiteDisabled: vi.fn(), informationHighlight: feature,
        });
        expect(handler({type: 'SET_INFORMATION_HIGHLIGHT_ENABLED', enabled: 'true'}, {}, respond)).toBe(false);
        for (const restriction of ['config', 'site', 'suspend', 'context']) {
            mocks.config.on = restriction !== 'config'; disabled = restriction === 'site'; suspended = restriction === 'suspend'; invalid = restriction === 'context';
            handler({type: 'GET_INFORMATION_HIGHLIGHT_STATE'}, {}, respond); expect(respond).toHaveBeenLastCalledWith({success: true, state: snapshot});
            handler({type: 'SET_INFORMATION_HIGHLIGHT_ENABLED', enabled: true}, {}, respond); expect(respond).toHaveBeenLastCalledWith({success: false, state: snapshot, error: 'INFORMATION_HIGHLIGHT_PAGE_DISABLED'});
            handler({type: 'RETRY_INFORMATION_HIGHLIGHT'}, {}, respond); expect(feature.retry).not.toHaveBeenCalled();
            handler({type: 'SET_INFORMATION_HIGHLIGHT_ENABLED', enabled: false}, {}, respond); expect(respond).toHaveBeenLastCalledWith({success: true, state: snapshot});
        }
        mocks.config.on = true; disabled = suspended = invalid = false;
        handler({type: 'SET_INFORMATION_HIGHLIGHT_ENABLED', enabled: true}, {}, respond); expect(respond).toHaveBeenLastCalledWith({success: true, state: {...snapshot, enabled: true}});
        handler({type: 'RETRY_INFORMATION_HIGHLIGHT'}, {}, respond); expect(feature.retry).toHaveBeenCalledOnce();
        const unavailable = createContentRuntimeMessageHandler({} as ContentScriptContext, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
        unavailable({type: 'GET_INFORMATION_HIGHLIGHT_STATE'}, {}, respond); expect(respond).toHaveBeenLastCalledWith({success: false, error: 'INFORMATION_HIGHLIGHT_PAGE_UNAVAILABLE'});
    });
    it('往返缓存暂停时拒绝迟到的功能挂载，恢复后允许新的用户操作', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        let suspended = true;
        mocks.config.disableFloatingBall = true;
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            isPageSuspended: () => suspended,
            updateSiteDisabled: vi.fn(async () => undefined),
        });
        handler({type: 'toggleFloatingBall', isEnabled: true}, {}, respond);
        handler({type: 'contextMenuTranslate', action: 'fullPage'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'disabled'});
        expect(mocks.mountFloatingBall).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.config.disableFloatingBall).toBe(true);
        handler({type: 'getFullPageTranslationState'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'success', isTranslated: false, isSiteDisabled: false, toolbarStatus: 'idle'});
        handler({type: 'translationCacheCleared'}, {}, respond);
        expect(mocks.invalidateFullPageTranslationSessionCache).toHaveBeenCalledOnce();
        suspended = false;
        handler({type: 'toggleFloatingBall', isEnabled: true}, {}, respond);
        expect(mocks.mountFloatingBall).toHaveBeenCalledOnce();
    });

    it('拒绝非对象并为旧 clearCache 明确返回后台成功或失败', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const updateSiteDisabled = vi.fn(async () => undefined);
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled,
        });
        const respond = vi.fn();

        expect(handler(null, {}, respond)).toBe(false);
        mocks.sendMessage.mockResolvedValueOnce({success: true});
        expect(handler({message: 'clearCache'}, {}, respond)).toBe(true);
        await Promise.resolve();
        expect(mocks.sendMessage).toHaveBeenCalledWith({type: 'clearTranslationCache'});
        expect(respond).toHaveBeenCalledWith({success: true});

        mocks.sendMessage.mockRejectedValueOnce(new Error('worker stopped'));
        expect(handler({message: 'clearCache'}, {}, respond)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(respond).toHaveBeenLastCalledWith({success: false, error: 'worker stopped'});

        mocks.sendMessage.mockResolvedValueOnce({success: false, error: 'IndexedDB blocked'});
        expect(handler({message: 'clearCache'}, {}, respond)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(respond).toHaveBeenLastCalledWith({success: false, error: 'IndexedDB blocked'});

        mocks.sendMessage.mockResolvedValueOnce(undefined);
        expect(handler({message: 'clearCache'}, {}, respond)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(respond).toHaveBeenLastCalledWith({
            success: false,
            error: '后台未确认缓存清理成功',
        });

        mocks.sendMessage.mockRejectedValueOnce('worker stopped as text');
        expect(handler({message: 'clearCache'}, {}, respond)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(respond).toHaveBeenLastCalledWith({
            success: false,
            error: 'worker stopped as text',
        });
        expect(updateSiteDisabled).not.toHaveBeenCalled();
    });

    it('严格校验站点开关并把异步成功与失败显式回传', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const updateSiteDisabled = vi.fn(async () => undefined);
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled,
        });

        expect(handler({type: 'updateSiteExtensionDisabled', isDisabled: 'yes'}, {}, respond)).toBe(false);
        expect(handler({type: 'updateSiteExtensionDisabled', isDisabled: true}, {}, respond)).toBe(true);
        await Promise.resolve();
        expect(updateSiteDisabled).toHaveBeenCalledWith(true);
        expect(respond).toHaveBeenCalledWith({status: 'success'});

        updateSiteDisabled.mockRejectedValueOnce(new Error('activation failed'));
        expect(handler({type: 'updateSiteExtensionDisabled', isDisabled: false}, {}, respond)).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(respond).toHaveBeenLastCalledWith({status: 'failed'});
    });

    it('缓存清理广播在站点禁用时仍失效当前全文会话', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => true,
            updateSiteDisabled: vi.fn(async () => undefined),
        });

        expect(handler({type: 'translationCacheCleared'}, {}, respond)).toBe(true);
        expect(mocks.invalidateFullPageTranslationSessionCache).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith({status: 'success'});
    });

    it('站点禁用时只开放状态读取，并保留 tabId 菜单所需的真实字段', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => true,
            updateSiteDisabled: vi.fn(async () => undefined),
        });

        expect(handler({type: 'toggleFloatingBall', isEnabled: true}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenLastCalledWith({status: 'disabled'});
        expect(mocks.mountFloatingBall).not.toHaveBeenCalled();

        expect(handler({type: 'getFullPageTranslationState'}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenLastCalledWith({
            status: 'success',
            isTranslated: false,
            isSiteDisabled: true, toolbarStatus: 'idle',
        });
    });

    it('更新 UI 配置并让菜单翻译与恢复根据真实全文状态回复', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        }, {areaTranslation: true, imageTranslation: true} as never);

        expect(handler({type: 'toggleFloatingBall', isEnabled: true}, {}, respond)).toBe(true);
        expect(mocks.mountFloatingBall).toHaveBeenCalledOnce();
        expect(handler({type: 'toggleFloatingBall', isEnabled: false}, {}, respond)).toBe(true);
        expect(mocks.unmountFloatingBall).toHaveBeenCalledOnce();
        expect(handler({type: 'updateSelectionTranslatorMode', mode: 'invalid'}, {}, respond)).toBe(false);
        expect(handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond)).toBe(true);
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledOnce();
        expect(handler({
            type: 'updateSelectionTranslatorSettings',
            trigger: 'custom',
            hotkey: 'custom',
            customHotkey: 'Alt+K',
            delay: '25',
        }, {}, respond)).toBe(true);
        expect(mocks.config).toMatchObject({
            selectionTranslatorTrigger: 'custom',
            selectionTranslatorHotkey: 'custom',
            customSelectionTranslatorHotkey: 'Alt+K',
            selectionTranslatorDelay: 25,
        });

        mocks.isFullPageTranslationActive.mockReturnValueOnce(true);
        expect(handler({type: 'contextMenuTranslate', action: 'fullPage'}, {}, respond)).toBe(true);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenLastCalledWith({
            status: 'success',
            action: 'translated',
            isTranslated: true,
        });

        mocks.isFullPageTranslationActive.mockReturnValueOnce(false);
        expect(handler({type: 'contextMenuTranslate', action: 'restore'}, {}, respond)).toBe(true);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenLastCalledWith({
            status: 'success',
            action: 'restored',
            isTranslated: false,
        });
        expect(handler({type: 'contextMenuTranslate', action: 'unknown'}, {}, respond)).toBe(false);
    });

    it('Popup 的局部翻译请求进入区域选择模式，未挂载时如实返回失败', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        });

        mocks.startSectionTranslationPicker.mockReturnValueOnce(true);
        expect(handler({type: 'contextMenuTranslate', action: 'section'}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenLastCalledWith({status: 'success'});
        mocks.startSectionTranslationPicker.mockReturnValueOnce(false);
        handler({type: 'contextMenuTranslate', action: 'section'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'failed'});
        expect(mocks.startSectionTranslationPicker).toHaveBeenCalledTimes(2);
        // 划词与局部翻译共用同一分支，互不串用对方的入口。
        expect(mocks.translateSelectionFromContextMenu).not.toHaveBeenCalled();
        mocks.translateSelectionFromContextMenu.mockReturnValueOnce(true);
        handler({type: 'contextMenuTranslate', action: 'selection'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'success'});
        expect(mocks.startSectionTranslationPicker).toHaveBeenCalledTimes(2);
    });

    it('圈选右键命令等待按需挂载结果后如实回复', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        }, {areaTranslation: true} as never);

        mocks.startAreaTranslationFromContextMenu.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('mount failed')).mockImplementationOnce(() => { throw new Error('start failed'); });
        expect(handler({type: 'contextMenuTranslate', action: 'area'}, {}, respond)).toBe(true);
        await vi.waitFor(() => expect(respond).toHaveBeenLastCalledWith({status: 'success'}));
        handler({type: 'contextMenuTranslate', action: 'area'}, {}, respond);
        await vi.waitFor(() => expect(respond).toHaveBeenLastCalledWith({status: 'disabled'}));
        handler({type: 'contextMenuTranslate', action: 'area'}, {}, respond);
        await vi.waitFor(() => expect(respond).toHaveBeenLastCalledWith({status: 'failed'}));
        handler({type: 'contextMenuTranslate', action: 'area'}, {}, respond);
        await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(4));
        expect(respond).toHaveBeenLastCalledWith({status: 'failed'});

        const unsupported = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        }, {areaTranslation: false} as never);
        unsupported({type: 'contextMenuTranslate', action: 'area'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'disabled'});
        expect(mocks.startAreaTranslationFromContextMenu).toHaveBeenCalledTimes(4);
    });

    it('站点停用或总开关关闭时局部翻译请求被拒绝，不进入选择模式', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const siteDisabled = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => true,
            updateSiteDisabled: vi.fn(async () => undefined),
        });
        siteDisabled({type: 'contextMenuTranslate', action: 'section'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'disabled'});
        mocks.config.on = false;
        const pluginOff = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        });
        pluginOff({type: 'contextMenuTranslate', action: 'section'}, {}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'disabled'});
        expect(mocks.startSectionTranslationPicker).not.toHaveBeenCalled();
    });

    it('总开关关闭时只保存子功能偏好，不允许消息把页面功能重新挂载', async () => {
        mocks.config.on = false;
        mocks.isFullPageTranslationActive.mockReturnValue(true);
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false,
            updateSiteDisabled: vi.fn(async () => undefined),
        }, {areaTranslation: true, imageTranslation: true} as never);

        expect(handler({type: 'toggleFloatingBall', isEnabled: true}, {}, respond)).toBe(true);
        expect(handler({type: 'updateSelectionTranslatorMode', mode: 'bilingual'}, {}, respond)).toBe(true);
        expect(handler({type: 'toggleSelectionAreaTranslator', isEnabled: true}, {}, respond)).toBe(true);
        expect(handler({type: 'toggleImageTranslator', isEnabled: true}, {}, respond)).toBe(true);
        expect(handler({type: 'toggleTranslationProgressPanel', isEnabled: true}, {}, respond)).toBe(true);

        expect(mocks.mountFloatingBall).not.toHaveBeenCalled();
        expect(mocks.mountSelectionTranslator).not.toHaveBeenCalled();
        expect(mocks.mountAreaTranslator).not.toHaveBeenCalled();
        expect(mocks.mountImageTranslator).not.toHaveBeenCalled();
        expect(mocks.mountTranslationProgressPanel).not.toHaveBeenCalled();
        expect(handler({type: 'getFullPageTranslationState'}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenLastCalledWith({
            status: 'success',
            isTranslated: false,
            isSiteDisabled: false, toolbarStatus: 'idle',
        });
        expect(mocks.config).toMatchObject({
            disableFloatingBall: false,
            disableSelectionTranslator: false,
            selectionAreaEnabled: true,
            disableImageTranslator: false,
            translationProgressPanelEnabled: true,
        });
    });
    it('关闭划词翻译即卸载共享界面，不被已启用的学习偏好覆盖', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const handler = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
        const respond = vi.fn();
        mocks.config.harness = {enabled: true};
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.mountSelectionTranslator).not.toHaveBeenCalled();
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledOnce();
        mocks.config.on = false;
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledTimes(2);
        mocks.config.on = true;
        mocks.config.harness.enabled = false;
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledTimes(3);
    });

});


describe('read-only exact unchanged query on existing content state channel', () => {
    const contexts: ContentScriptContext[] = [];
    afterEach(() => {
        contexts.splice(0).forEach(ctx => ctx.abort());
        vi.restoreAllMocks();
    });

    async function createQueryFixture(options: {
        suspended?: boolean;
        siteDisabled?: boolean;
        omitSuspensionGate?: boolean;
        capabilities?: BrowserCapabilities;
    } = {}) {
        const page = parseHTML('<html><body><p class="owner">First source</p><p class="owner">Second source</p></body></html>');
        vi.stubGlobal('document', page.document);
        vi.stubGlobal('browser', {runtime: {id: 'owned-extension', sendMessage: mocks.sendMessage}});
        const {ContentScriptContext} = await import('wxt/utils/content-script-context');
        const ctx = new ContentScriptContext('content-message-query-unit');
        contexts.push(ctx);
        const lifecycle = {siteDisabled: options.siteDisabled ?? false, suspended: options.suspended ?? false};
        const updateSiteDisabled = vi.fn(async () => undefined);
        const state = {
            isSiteDisabled: () => lifecycle.siteDisabled,
            ...(!options.omitSuspensionGate ? {isPageSuspended: () => lifecycle.suspended} : {}),
            updateSiteDisabled,
        };
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const handler = createContentRuntimeMessageHandler(ctx, state, options.capabilities);
        const querySelectorAll = vi.spyOn(page.document, 'querySelectorAll');
        const fetch = vi.fn(() => {throw new Error('runtime query must not issue a network request');});
        vi.stubGlobal('fetch', fetch);
        return {handler, ctx, lifecycle, updateSiteDisabled, document: page.document, querySelectorAll,
            fetch, respond: vi.fn(), originalMarkup: page.document.toString(), originalConfig: {...mocks.config}};
    }

    type QueryFixture = Awaited<ReturnType<typeof createQueryFixture>>;
    const trustedSender = {id: 'owned-extension'};
    const firstQuery = {selector: '.owner', index: 0, source: 'First source', sessionId: 7};

    function expectReadOnly(fixture: QueryFixture) {
        expect(fixture.document.toString()).toBe(fixture.originalMarkup);
        expect(mocks.config).toEqual(fixture.originalConfig);
        expect(fixture.updateSiteDisabled).not.toHaveBeenCalled();
        expect(fixture.fetch).not.toHaveBeenCalled();
        for (const [name, port] of Object.entries(mocks)) {
            if (typeof port === 'function' && name !== 'readFullPageUnchangedCompletion') {
                expect(port, `read-only query must not call ${name}`).not.toHaveBeenCalled();
            }
        }
    }

    function expectNoQueryAccess(fixture: QueryFixture) {
        expect(fixture.querySelectorAll).not.toHaveBeenCalled();
        expect(mocks.readFullPageUnchangedCompletion).not.toHaveBeenCalled();
        expectReadOnly(fixture);
    }

    it('binds actual selector owner and rejects unauthenticated, oversized or disabled queries', async () => {
        const owner = {};
        vi.stubGlobal('browser', {runtime: {id: 'owned-extension'}});
        vi.stubGlobal('document', {querySelectorAll: vi.fn(() => [owner])});
        mocks.readFullPageUnchangedCompletion.mockReturnValue({status: 'available', completionId: 42});
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        let suspended = false;
        const handler = createContentRuntimeMessageHandler({} as never, {
            isSiteDisabled: () => false, isPageSuspended: () => suspended, updateSiteDisabled: vi.fn(),
        });
        const respond = vi.fn();
        const query = {type: 'getFullPageTranslationState', unchangedQueries: [{selector: '#spec', index: 0, source: 'Spec', sessionId: 7}]};
        handler(query, {id: 'owned-extension'}, respond);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledWith(owner, 7, 'Spec');
        expect(respond).toHaveBeenLastCalledWith({status: 'success', sessionId: 7, outcomes: [{status: 'available', completionId: 42}]});
        mocks.readFullPageUnchangedCompletion.mockClear();
        handler(query, {id: 'another-extension'}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'unavailable', reason: 'query-unavailable'});
        expect(handler({...query, unchangedQueries: Array(17).fill(query.unchangedQueries[0])}, {id: 'owned-extension'}, respond)).toBe(false);
        suspended = true;
        handler(query, {id: 'owned-extension'}, respond);
        expect(respond).toHaveBeenLastCalledWith({status: 'unavailable', reason: 'query-unavailable'});
        expect(mocks.readFullPageUnchangedCompletion).not.toHaveBeenCalled();
    });

    it('returns each exact owner/session/source result in request order without translating or rewriting the page', async () => {
        const fixture = await createQueryFixture({omitSuspensionGate: true});
        const owners = fixture.document.getElementsByClassName('owner');
        const available = {status: 'available', completionId: 42};
        const stale = {status: 'unavailable', reason: 'session-mismatch'};
        mocks.readFullPageUnchangedCompletion.mockReturnValueOnce(available).mockReturnValueOnce(stale);
        const message = {type: 'getFullPageTranslationState', unchangedQueries: [
            {selector: '.owner', index: 1, source: 'Second source', sessionId: 1}, firstQuery,
        ]};
        const originalMessage = structuredClone(message);

        expect(fixture.handler(message, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.querySelectorAll).toHaveBeenCalledTimes(2);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenNthCalledWith(1, owners[1], 1, 'Second source');
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenNthCalledWith(2, owners[0], 7, 'First source');
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', sessionId: 7, outcomes: [available, stale]});
        expect(message).toEqual(originalMessage);
        expectReadOnly(fixture);
    });

    it('accepts an empty batch as a state read without resolving owners', async () => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: []}, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', sessionId: 7, outcomes: []});
        expectNoQueryAccess(fixture);
    });

    it('accepts the inclusive batch/string/index limits and passes a positive session ID unchanged', async () => {
        const fixture = await createQueryFixture();
        const boundaryOwner = fixture.document.createElement('p');
        boundaryOwner.id = 'a'.repeat(511);
        boundaryOwner.textContent = 'x'.repeat(2048);
        fixture.document.body.append(boundaryOwner);
        const indexedOwners = Array.from({length: 1025}, () => {
            const owner = fixture.document.createElement('span');
            owner.className = 'indexed';
            fixture.document.body.append(owner);
            return owner;
        });
        fixture.originalMarkup = fixture.document.toString();
        const queries = [
            {selector: '#' + boundaryOwner.id, index: 0, source: boundaryOwner.textContent, sessionId: 1},
            {selector: '.indexed', index: 1024, source: '', sessionId: Number.MAX_SAFE_INTEGER},
            ...Array.from({length: 14}, () => ({...firstQuery})),
        ];
        const completion = {status: 'unavailable', reason: 'completion-unavailable'};
        mocks.readFullPageUnchangedCompletion.mockReturnValue(completion);

        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: queries}, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.querySelectorAll).toHaveBeenCalledTimes(16);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenNthCalledWith(1, boundaryOwner, 1, 'x'.repeat(2048));
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenNthCalledWith(2, indexedOwners[1024], Number.MAX_SAFE_INTEGER, '');
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledTimes(16);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', sessionId: 7, outcomes: Array(16).fill(completion)});
        expectReadOnly(fixture);
    });

    it.each([
        {label: 'null batch', batch: null},
        {label: 'string batch', batch: 'queries'},
        {label: 'array-like object', batch: {0: firstQuery, length: 1}},
        {label: '17 owners', batch: Array.from({length: 17}, () => ({...firstQuery}))},
    ])('rejects $label before any selector or completion read', async ({batch}) => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: batch}, trustedSender, fixture.respond)).toBe(false);
        expect(fixture.respond).not.toHaveBeenCalled();
        expectNoQueryAccess(fixture);
    });

    const malformedQueries: Array<{label: string; query: unknown}> = [
        {label: 'null query', query: null},
        {label: 'undefined query', query: undefined},
        {label: 'primitive query', query: 'owner'},
        {label: 'missing selector', query: {index: 0, source: 'First source', sessionId: 7}},
        {label: 'numeric selector', query: {...firstQuery, selector: 1}},
        {label: '513-character selector', query: {...firstQuery, selector: '#' + 'a'.repeat(512)}},
        {label: 'missing source', query: {selector: '.owner', index: 0, sessionId: 7}},
        {label: 'numeric source', query: {...firstQuery, source: 1}},
        {label: '2049-character source', query: {...firstQuery, source: 'x'.repeat(2049)}},
        {label: 'missing index', query: {selector: '.owner', source: 'First source', sessionId: 7}},
        {label: 'numeric string index', query: {...firstQuery, index: '0'}},
        {label: 'fractional index', query: {...firstQuery, index: 0.5}},
        {label: 'NaN index', query: {...firstQuery, index: NaN}},
        {label: 'infinite index', query: {...firstQuery, index: Infinity}},
        {label: 'negative index', query: {...firstQuery, index: -1}},
        {label: 'index 1025', query: {...firstQuery, index: 1025}},
        {label: 'missing session', query: {selector: '.owner', index: 0, source: 'First source'}},
        {label: 'numeric string session', query: {...firstQuery, sessionId: '7'}},
        {label: 'fractional session', query: {...firstQuery, sessionId: 1.5}},
        {label: 'NaN session', query: {...firstQuery, sessionId: NaN}},
        {label: 'infinite session', query: {...firstQuery, sessionId: Infinity}},
        {label: 'zero session', query: {...firstQuery, sessionId: 0}},
        {label: 'negative session', query: {...firstQuery, sessionId: -1}},
    ];
    it.each(malformedQueries)('rejects an entire batch containing $label without partially reading its valid first entry', async ({query}) => {
        const fixture = await createQueryFixture();
        const message = {type: 'getFullPageTranslationState', unchangedQueries: [firstQuery, query]};
        const originalMessage = structuredClone(message);
        expect(fixture.handler(message, trustedSender, fixture.respond)).toBe(false);
        expect(fixture.respond).not.toHaveBeenCalled();
        expect(message).toEqual(originalMessage);
        expectNoQueryAccess(fixture);
    });

    it.each([
        {label: 'null sender', sender: null},
        {label: 'missing sender', sender: undefined},
        {label: 'sender without extension ID', sender: {}},
        {label: 'another extension', sender: {id: 'another-extension'}},
        {label: 'numeric sender ID', sender: {id: 7}},
    ])('does not expose owner state to $label even when its batch is malformed', async ({sender}) => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: null}, sender, fixture.respond)).toBe(true);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'unavailable', reason: 'query-unavailable'});
        expectNoQueryAccess(fixture);
    });

    it.each([undefined, 7])('refuses queries when runtime ID is %s rather than a string', async runtimeId => {
        const fixture = await createQueryFixture();
        vi.stubGlobal('browser', {runtime: {id: runtimeId, sendMessage: mocks.sendMessage}});
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: [firstQuery]}, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'unavailable', reason: 'query-unavailable'});
        expectNoQueryAccess(fixture);
    });

    it.each(['config-off', 'context-invalid', 'site-disabled', 'page-suspended'])('blocks trusted owner queries while %s without querying or changing the page', async gate => {
        const fixture = await createQueryFixture();
        if (gate === 'config-off') mocks.config.on = false;
        if (gate === 'context-invalid') fixture.ctx.abort();
        if (gate === 'site-disabled') fixture.lifecycle.siteDisabled = true;
        if (gate === 'page-suspended') fixture.lifecycle.suspended = true;
        fixture.originalConfig = {...mocks.config};
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: [firstQuery]}, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'unavailable', reason: 'query-unavailable'});
        expectNoQueryAccess(fixture);
    });

    it('rechecks suspension and site state on every call and permits read-only queries after resume', async () => {
        const fixture = await createQueryFixture({suspended: true});
        const message = {type: 'getFullPageTranslationState', unchangedQueries: [firstQuery]};
        const completion = {status: 'available', completionId: 43};
        mocks.readFullPageUnchangedCompletion.mockReturnValue(completion);
        fixture.handler(message, trustedSender, fixture.respond);
        fixture.lifecycle.suspended = false;
        fixture.lifecycle.siteDisabled = true;
        fixture.handler(message, trustedSender, fixture.respond);
        expectNoQueryAccess(fixture);
        expect(fixture.respond).toHaveBeenCalledTimes(2);
        fixture.lifecycle.siteDisabled = false;
        expect(fixture.handler(message, trustedSender, fixture.respond)).toBe(true);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenLastCalledWith({status: 'success', sessionId: 7, outcomes: [completion]});
        expectReadOnly(fixture);
    });

    it.each([
        {label: 'invalid selector syntax', selector: '[', index: 0},
        {label: 'empty selector', selector: '', index: 0},
        {label: 'missing selector owner', selector: '#missing', index: 0},
        {label: 'missing owner at an in-range index', selector: '.owner', index: 2},
    ])('isolates $label as owner-unavailable and still returns the next valid result', async ({selector, index}) => {
        const fixture = await createQueryFixture();
        const completion = {status: 'available', completionId: 44};
        mocks.readFullPageUnchangedCompletion.mockReturnValue(completion);
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: [
            {selector, index, source: 'Missing source', sessionId: 7}, firstQuery,
        ]}, trustedSender, fixture.respond)).toBe(true);
        expect(fixture.querySelectorAll).toHaveBeenCalledTimes(2);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledOnce();
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledWith(fixture.document.getElementsByClassName('owner')[0], 7, 'First source');
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', sessionId: 7,
            outcomes: [{status: 'unavailable', reason: 'owner-unavailable'}, completion]});
        expectReadOnly(fixture);
    });

    it('contains a completion reader exception per owner and continues without starting translation', async () => {
        const fixture = await createQueryFixture();
        const completion = {status: 'available', completionId: 45};
        mocks.readFullPageUnchangedCompletion.mockImplementationOnce(() => {throw new Error('owner was detached');})
            .mockReturnValueOnce(completion);
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: [
            firstQuery, {selector: '.owner', index: 1, source: 'Second source', sessionId: 7},
        ]}, trustedSender, fixture.respond)).toBe(true);
        expect(mocks.readFullPageUnchangedCompletion).toHaveBeenCalledTimes(2);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', sessionId: 7,
            outcomes: [{status: 'unavailable', reason: 'owner-unavailable'}, completion]});
        expectReadOnly(fixture);
    });

    it('keeps legacy state requests without unchangedQueries available and reports actual translated state', async () => {
        const fixture = await createQueryFixture();
        mocks.isFullPageTranslationActive.mockReturnValue(true);
        mocks.getTranslationToolbarStatus.mockReturnValue('translated');
        expect(fixture.handler({type: 'getFullPageTranslationState', unchangedQueries: undefined}, {}, fixture.respond)).toBe(true);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'success', isTranslated: true,
            isSiteDisabled: false, toolbarStatus: 'translated'});
        expect(fixture.querySelectorAll).not.toHaveBeenCalled();
        expect(mocks.readFullPageUnchangedCompletion).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(fixture.document.toString()).toBe(fixture.originalMarkup);
    });

    it.each(['qqMailFrameCommand', 'qqMailFrameRefresh', 'embeddedFrameCommand', 'embeddedFrameRefresh'])('leaves %s to its frame protocol without responding or mounting features', async type => {
        const fixture = await createQueryFixture({siteDisabled: true});
        expect(fixture.handler({type}, trustedSender, fixture.respond)).toBe(false);
        expect(fixture.respond).not.toHaveBeenCalled();
        expectNoQueryAccess(fixture);
    });

    it('mounts selection UI once and preserves an existing owner when mode changes', async () => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'updateSelectionTranslatorMode', mode: 'bilingual'}, {}, fixture.respond)).toBe(true);
        expect(mocks.mountSelectionTranslator).toHaveBeenCalledOnce();
        expect(mocks.mountSelectionTranslator).toHaveBeenCalledWith(fixture.ctx);
        const existing = fixture.document.createElement('div');
        existing.id = 'fluent-read-selection-translator-container';
        fixture.document.body.append(existing);
        expect(fixture.handler({type: 'updateSelectionTranslatorMode', mode: 'translation-only'}, {}, fixture.respond)).toBe(true);
        expect(mocks.mountSelectionTranslator).toHaveBeenCalledOnce();
        expect(mocks.unmountSelectionTranslator).not.toHaveBeenCalled();
        expect(fixture.document.getElementById(existing.id)).toBe(existing);
        expect(mocks.config).toMatchObject({selectionTranslatorMode: 'translation-only', disableSelectionTranslator: false});
        expect(fixture.respond).toHaveBeenCalledTimes(2);
    });

    it.each([
        {label: 'invalid trigger', settings: {trigger: 'hover'}},
        {label: 'invalid legacy hotkey', settings: {trigger: 'direct', hotkey: 'Meta'}},
        {label: 'non-string custom hotkey', settings: {trigger: 'custom', customHotkey: 7}},
        {label: 'object delay', settings: {trigger: 'direct', delay: {ms: 25}}},
    ])('rejects $label without changing selection preferences', async ({settings}) => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'updateSelectionTranslatorSettings', ...settings}, {}, fixture.respond)).toBe(false);
        expect(fixture.respond).not.toHaveBeenCalled();
        expectNoQueryAccess(fixture);
    });

    it.each([
        {trigger: 'direct', expectedHotkey: 'none'},
        {trigger: 'icon', expectedHotkey: 'none'},
        {trigger: 'dot', expectedHotkey: 'none'},
        {trigger: 'Control', expectedHotkey: 'Control'},
        {trigger: 'Alt', expectedHotkey: 'Alt'},
        {trigger: 'Shift', expectedHotkey: 'Shift'},
        {trigger: 'custom', expectedHotkey: 'custom'},
    ])('treats $trigger as the selection trigger authority and preserves omitted delay', async ({trigger, expectedHotkey}) => {
        const fixture = await createQueryFixture();
        mocks.config.selectionTranslatorDelay = 120;
        mocks.config.customSelectionTranslatorHotkey = 'Alt+K';
        expect(fixture.handler({type: 'updateSelectionTranslatorSettings', trigger}, {}, fixture.respond)).toBe(true);
        expect(mocks.config).toMatchObject({selectionTranslatorTrigger: trigger,
            selectionTranslatorHotkey: expectedHotkey,
            customSelectionTranslatorHotkey: '', selectionTranslatorDelay: 120});
        expect(mocks.normalizeDelay).not.toHaveBeenCalled();
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith();
        expect(mocks.mountSelectionTranslator).not.toHaveBeenCalled();
    });

    it.each(['none', 'Control', 'Alt', 'Shift', 'custom'])('accepts legacy hotkey %s while direct trigger remains authoritative', async hotkey => {
        const fixture = await createQueryFixture();
        expect(fixture.handler({type: 'updateSelectionTranslatorSettings', trigger: 'direct', hotkey, delay: 0}, {}, fixture.respond)).toBe(true);
        expect(mocks.config.selectionTranslatorHotkey).toBe('none');
        expect(mocks.normalizeDelay).toHaveBeenCalledOnce();
        expect(mocks.normalizeDelay).toHaveBeenCalledWith(0);
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith();
    });

    it('mounts and disables supported area, image and progress features through their own lifecycle ports', async () => {
        const {resolveBrowserCapabilities} = await import('@/src/platform/browser/capabilities');
        const fixture = await createQueryFixture({capabilities: resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3})});
        for (const type of ['toggleSelectionAreaTranslator', 'toggleImageTranslator', 'toggleTranslationProgressPanel']) {
            expect(fixture.handler({type, isEnabled: true}, {}, fixture.respond)).toBe(true);
            expect(fixture.handler({type, isEnabled: false}, {}, fixture.respond)).toBe(true);
        }
        expect(mocks.mountAreaTranslator).toHaveBeenCalledOnce();
        expect(mocks.mountAreaTranslator).toHaveBeenCalledWith(fixture.ctx);
        expect(mocks.unmountAreaTranslator).toHaveBeenCalledOnce();
        expect(mocks.mountImageTranslator).toHaveBeenCalledOnce();
        expect(mocks.unmountImageTranslator).toHaveBeenCalledOnce();
        expect(mocks.mountTranslationProgressPanel).toHaveBeenCalledOnce();
        expect(mocks.mountTranslationProgressPanel).toHaveBeenCalledWith(fixture.ctx);
        expect(mocks.unmountTranslationProgressPanel).toHaveBeenCalledOnce();
        expect(mocks.config).toMatchObject({selectionAreaEnabled: false, disableImageTranslator: true, translationProgressPanelEnabled: false});
        expect(fixture.respond).toHaveBeenCalledTimes(6);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects unsupported area and image toggles without accepting their enabled preference', async () => {
        const {resolveBrowserCapabilities} = await import('@/src/platform/browser/capabilities');
        const fixture = await createQueryFixture({capabilities: resolveBrowserCapabilities({browser: 'unknown', manifestVersion: 2})});
        expect(fixture.handler({type: 'toggleSelectionAreaTranslator', isEnabled: true}, {}, fixture.respond)).toBe(true);
        expect(fixture.handler({type: 'toggleImageTranslator', isEnabled: true}, {}, fixture.respond)).toBe(true);
        expect(mocks.mountAreaTranslator).not.toHaveBeenCalled();
        expect(mocks.mountImageTranslator).not.toHaveBeenCalled();
        expect(mocks.unmountAreaTranslator).toHaveBeenCalledOnce();
        expect(mocks.unmountImageTranslator).toHaveBeenCalledOnce();
        expect(mocks.config).toEqual(fixture.originalConfig);
        expect(fixture.respond).toHaveBeenNthCalledWith(1, {status: 'unsupported', error: '当前浏览器暂不支持圈选翻译'});
        expect(fixture.respond).toHaveBeenNthCalledWith(2, {status: 'unsupported', error: '当前浏览器暂不支持图片翻译与 OCR'});
    });

    it('reports image context-menu outcomes and skips its feature port when unsupported', async () => {
        const {resolveBrowserCapabilities} = await import('@/src/platform/browser/capabilities');
        const fixture = await createQueryFixture({capabilities: resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3})});
        const message = {type: 'contextMenuTranslateImage', srcUrl: 'https://example.test/source.png'};
        mocks.toggleContextMenuImage.mockReturnValueOnce(true).mockReturnValueOnce(false);
        fixture.handler(message, {}, fixture.respond);
        fixture.handler(message, {}, fixture.respond);
        expect(mocks.toggleContextMenuImage).toHaveBeenCalledTimes(2);
        expect(mocks.toggleContextMenuImage).toHaveBeenCalledWith(message.srcUrl);
        expect(fixture.respond).toHaveBeenNthCalledWith(1, {status: 'success'});
        expect(fixture.respond).toHaveBeenNthCalledWith(2, {status: 'failed'});
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const unsupported = createContentRuntimeMessageHandler(fixture.ctx, {
            isSiteDisabled: () => false, updateSiteDisabled: fixture.updateSiteDisabled,
        }, resolveBrowserCapabilities({browser: 'unknown', manifestVersion: 2}));
        expect(unsupported(message, {}, fixture.respond)).toBe(true);
        expect(mocks.toggleContextMenuImage).toHaveBeenCalledTimes(2);
        expect(fixture.respond).toHaveBeenLastCalledWith({status: 'disabled'});
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
        {action: 'fullPage', active: false, port: 'autoTranslateEnglishPage'},
        {action: 'restore', active: true, port: 'restoreOriginalContent'},
    ])('reports an unchanged $action command as failed instead of inventing a successful transition', async ({action, active, port}) => {
        const fixture = await createQueryFixture();
        mocks.isFullPageTranslationActive.mockReturnValue(active);
        expect(fixture.handler({type: 'contextMenuTranslate', action}, {}, fixture.respond)).toBe(true);
        expect(port === 'autoTranslateEnglishPage' ? mocks.autoTranslateEnglishPage : mocks.restoreOriginalContent).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledOnce();
        expect(fixture.respond).toHaveBeenCalledWith({status: 'failed', action: 'unchanged', isTranslated: active});
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });
});


describe('右键菜单操作反馈', () => {
    it('转发原生选区文本，并拒绝将非字符串作为选区', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const handler = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
        mocks.translateSelectionFromContextMenu.mockReturnValue(true);
        handler({type: 'contextMenuTranslate', action: 'selection', selectionText: 'Selected text'}, {}, vi.fn());
        expect(mocks.translateSelectionFromContextMenu).toHaveBeenLastCalledWith('Selected text');
        handler({type: 'contextMenuTranslate', action: 'selection', selectionText: {}}, {}, vi.fn());
        expect(mocks.translateSelectionFromContextMenu).toHaveBeenLastCalledWith(undefined);
    });
    it('停用网站仍能显示原因明确且可以关闭的反馈，使用生命周期信号和同一提示 key', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const controller = new AbortController(), respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({signal: controller.signal} as never, {isSiteDisabled: () => true, updateSiteDisabled: vi.fn()});
        expect(handler({type: 'contextMenuNotice', reason: 'selectionUnavailable'}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenCalledWith({status: 'success'});
        expect(mocks.showPageNotice).toHaveBeenCalledWith('选区已失效，请重新选中文字后右键翻译。', 'error', {key: 'context-menu', signal: controller.signal, durationMs: 6000});
        expect(handler({type: 'contextMenuNotice', reason: 'raw private exception'}, {}, respond)).toBe(false);
        expect(mocks.showPageNotice).toHaveBeenCalledOnce();
    });

    it('用户脚本没有原生菜单通知，但保留实时选区消息入口', async () => {
        vi.stubEnv('BROWSER', 'userscript');
        try {
            const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
            const respond = vi.fn();
            const handler = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
            expect(handler({type: 'contextMenuNotice', reason: 'failed'}, {}, respond)).toBe(false);
            expect(mocks.showPageNotice).not.toHaveBeenCalled();
            mocks.translateSelectionFromContextMenu.mockReturnValue(true);
            expect(handler({type: 'contextMenuTranslate', action: 'selection'}, {}, respond)).toBe(true);
            expect(respond).toHaveBeenCalledWith({status: 'success'});
            expect(mocks.dismissPageNotice).not.toHaveBeenCalled();
        } finally {vi.unstubAllEnvs();}
    });
    it.each(['invalid', 'suspended'])('已失效或挂起的页面 %s 不创建通知', async kind => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const respond = vi.fn();
        const handler = createContentRuntimeMessageHandler({isInvalid: kind === 'invalid'} as never,
            {isSiteDisabled: () => false, isPageSuspended: () => kind === 'suspended', updateSiteDisabled: vi.fn()});
        expect(handler({type: 'contextMenuNotice', reason: 'failed'}, {}, respond)).toBe(true);
        expect(respond).toHaveBeenCalledWith({status: 'failed'});
        expect(mocks.showPageNotice).not.toHaveBeenCalled();
    });
    it('重试真正启动后撤销过期右键提示，拒绝或未启动时保留原因', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const handler = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
        mocks.translateSelectionFromContextMenu.mockReturnValue(false);
        handler({type: 'contextMenuTranslate', action: 'selection'}, {}, vi.fn());
        expect(mocks.dismissPageNotice).not.toHaveBeenCalled();
        mocks.translateSelectionFromContextMenu.mockReturnValue(true);
        handler({type: 'contextMenuTranslate', action: 'selection'}, {}, vi.fn());
        expect(mocks.dismissPageNotice).toHaveBeenCalledWith('context-menu');
    });

});
