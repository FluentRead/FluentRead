import {afterEach, describe, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({config: {on: true, disableImageTranslator: false, imageTranslationContextMenuEnabled: true}, capability: {imageTranslation: true}}));
const subscriptions: Array<(config: unknown) => void> = [];
vi.mock('@/src/services/config/store', () => ({config: state.config, configReady: Promise.resolve(), subscribeConfig: (listener: (config: unknown) => void) => {subscriptions.push(listener); return () => {};}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: state.capability}));
import {createImageContextMenu, imageMenuEnabled, routeImageContextMenu} from '@/src/app/background/imageContextMenu';
import {CONTEXT_MENU_IDS} from '@/src/core/config/constants';
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks(); Object.assign(state.config, {on: true, disableImageTranslator: false, imageTranslationContextMenuEnabled: true}); state.capability.imageTranslation = true;});
describe('图片原生菜单配置与 frame 路由', () => {
    it('创建 image 专用本地化入口，不依赖全文菜单偏好', async () => {
        const create = vi.fn(); vi.stubGlobal('browser', {contextMenus: {create}});
        await createImageContextMenu('zh-CN');
        expect(create).toHaveBeenCalledWith({id: CONTEXT_MENU_IDS.TRANSLATE_IMAGE, title: '翻译图片／还原图片', contexts: ['image']});
        state.config.imageTranslationContextMenuEnabled = false; await createImageContextMenu('en-US'); expect(create).toHaveBeenCalledTimes(1);
        state.config.imageTranslationContextMenuEnabled = true; state.config.on = false; expect(imageMenuEnabled()).toBe(false);
        state.config.on = true; state.config.disableImageTranslator = true; expect(imageMenuEnabled()).toBe(false);
        state.config.disableImageTranslator = false; state.capability.imageTranslation = false; expect(imageMenuEnabled()).toBe(false);
    });
    it('只向点击 frame 转发，未知菜单不处理，无效标签和关闭入口不发送', async () => {
        const sendMessage = vi.fn().mockResolvedValue({}); vi.stubGlobal('browser', {tabs: {sendMessage}});
        expect(routeImageContextMenu({menuItemId: 'other'})).toBe(false);
        const info = {menuItemId: CONTEXT_MENU_IDS.TRANSLATE_IMAGE, srcUrl: 'https://image.test/a.png', frameId: 3};
        expect(routeImageContextMenu(info, {id: 4})).toBe(true);
        expect(sendMessage).toHaveBeenCalledWith(4, {type: 'contextMenuTranslateImage', srcUrl: info.srcUrl}, {frameId: 3});
        routeImageContextMenu({...info, frameId: undefined}, {id: 4}); expect(sendMessage.mock.calls[1][2]).toEqual({frameId: 0});
        routeImageContextMenu(info); state.config.imageTranslationContextMenuEnabled = false; routeImageContextMenu(info, {id: 4}); expect(sendMessage).toHaveBeenCalledTimes(2);
        state.config.imageTranslationContextMenuEnabled = true; sendMessage.mockRejectedValue(new Error('missing frame')); vi.spyOn(console, 'error').mockImplementation(() => {});
        routeImageContextMenu(info, {id: 4}); await Promise.resolve(); expect(console.error).toHaveBeenCalled();
    });
});

it('后台从已保存的开启配置启动后，首次关闭图片菜单仍重新同步', async () => {
    const {installBackgroundContextMenus} = await import('@/src/app/background/contextMenuRuntime');
    const {TabTranslationStateStore} = await import('@/src/app/background/tabTranslationState');
    const event = () => ({addListener: vi.fn()});
    const create = vi.fn();
    vi.stubGlobal('browser', {contextMenus: {create, removeAll: vi.fn(), update: vi.fn(), onClicked: event()},
        tabs: {query: vi.fn().mockResolvedValue([]), onActivated: event(), onUpdated: event(), onRemoved: event()}});
    state.config.disableImageTranslator = true;
    installBackgroundContextMenus(new TabTranslationStateStore());
    state.config.disableImageTranslator = false;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(create.mock.calls.some(([menu]) => menu.id === CONTEXT_MENU_IDS.TRANSLATE_IMAGE)).toBe(true);
    create.mockClear(); state.config.imageTranslationContextMenuEnabled = false;
    subscriptions.at(-1)!(state.config as never);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(create.mock.calls.map(([menu]) => menu.id)).toEqual([CONTEXT_MENU_IDS.TRANSLATE_FULL_PAGE]);
});
