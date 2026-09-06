import {beforeEach, describe, expect, it, vi} from 'vitest';

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
    sendMessage: vi.fn(),
}));

vi.mock('@/src/core/config/model', () => ({
    normalizeSelectionTranslatorDelay: mocks.normalizeDelay,
}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/app/content/features', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    invalidateFullPageTranslationSessionCache: mocks.invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive: mocks.isFullPageTranslationActive,
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
    vi.stubGlobal('browser', {runtime: {sendMessage: mocks.sendMessage}});
    vi.stubGlobal('document', {getElementById: vi.fn(() => null)});
});

describe('内容脚本 runtime 消息协议', () => {
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
        expect(respond).toHaveBeenLastCalledWith({status: 'success', isTranslated: false, isSiteDisabled: false});
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
            isSiteDisabled: true,
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
            isSiteDisabled: false,
        });
        expect(mocks.config).toMatchObject({
            disableFloatingBall: false,
            disableSelectionTranslator: false,
            selectionAreaEnabled: true,
            disableImageTranslator: false,
            translationProgressPanelEnabled: true,
        });
    });
    it('关闭划词翻译仍保留 Harness，而总开关关闭会卸载共享界面', async () => {
        const {createContentRuntimeMessageHandler} = await import('@/src/app/content/messageRuntime');
        const handler = createContentRuntimeMessageHandler({} as never, {isSiteDisabled: () => false, updateSiteDisabled: vi.fn()});
        const respond = vi.fn();
        mocks.config.harness = {enabled: true};
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.mountSelectionTranslator).toHaveBeenCalledOnce();
        expect(mocks.unmountSelectionTranslator).not.toHaveBeenCalled();
        mocks.config.on = false;
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledOnce();
        mocks.config.on = true;
        mocks.config.harness.enabled = false;
        handler({type: 'updateSelectionTranslatorMode', mode: 'disabled'}, {}, respond);
        expect(mocks.unmountSelectionTranslator).toHaveBeenCalledTimes(2);
    });

});
