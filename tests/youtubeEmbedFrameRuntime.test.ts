/**
 * @file tests/youtubeEmbedFrameRuntime.test.ts
 * 文件职责：核验 YouTube 内嵌字幕组合根的独立入口、异步等待与生命周期。
 * 主要内容：替换配置、语言包和视频挂载端口，验证总开关、站点禁用、暂停恢复、失效和延迟回调的所有权。
 * 模块边界：真实播放器的字幕来源与 DOM 由视频专项测试负责，此处不调用在线服务。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
const ports = vi.hoisted(() => ({config: {} as Record<string, unknown>, listeners: new Set<(next: Record<string, unknown>) => void>(),
    mount: vi.fn(), unmount: vi.fn(), language: vi.fn(), bridge: vi.fn(), bridgeMain: vi.fn(),
    actions: null as null | {suspend(): void; resume(): void; dispose(): void}, suspended: false, signal: undefined as AbortSignal | undefined,
}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(),
    subscribeConfig: (fn: (next: Record<string, unknown>) => void) => {ports.listeners.add(fn);return () => ports.listeners.delete(fn);}}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: ports.language}));
vi.mock('@/src/features/video-subtitle/public', () => ({mountVideoSubtitleTranslation: ports.mount,
    isYouTubeEmbedPage: (location: URL) => /(^|\.)youtube\.com$/u.test(location.hostname) && /^\/embed\/[\w-]{11}\/?$/u.test(location.pathname)}));
vi.mock('@/src/app/content/mainWorldBridgeLifecycle', () => ({setMainWorldBridgesEnabled: ports.bridge}));
vi.mock('@/src/app/content/youtubeTimedTextBridge', () => ({startYoutubeTimedTextBridgeApp: ports.bridgeMain}));
vi.mock('@/src/app/content/pageLifecycle', () => ({installContentPageLifecycle: (_window: unknown, signal: AbortSignal, actions: typeof ports.actions) => {
    ports.actions = actions; ports.signal = signal; return {isSuspended: () => ports.suspended};
}}));
import {startYoutubeEmbedContentApp} from '@/src/app/content/youtubeEmbedFrameRuntime';

function ctx(invalid = false) {return {isInvalid: invalid} as unknown as ContentScriptContext;}
function globals(href = 'https://www.youtube.com/embed/abcdefghijk', topLevel = false) {
    const page = {top: {} as unknown, location: new URL(href)}; if (topLevel) page.top = page;
    vi.stubGlobal('window', page); vi.stubGlobal('document', {});
}
const changed = () => ports.listeners.forEach(fn => fn(ports.config));
beforeEach(() => {
    for (const key of Object.keys(ports.config)) delete ports.config[key];
    Object.assign(ports.config, {on: true, disabledExtensionDomains: [], uiLanguage: 'en-US'});
    ports.listeners.clear(); ports.suspended = false; ports.actions = null; ports.signal = undefined;
    ports.mount.mockReset().mockReturnValue(ports.unmount); ports.unmount.mockReset(); ports.bridge.mockReset(); ports.bridgeMain.mockReset();
    ports.language.mockReset().mockResolvedValue(true); globals(); vi.stubGlobal('defineContentScript', (entry: unknown) => entry);
});
afterEach(() => {ports.actions?.dispose(); vi.unstubAllGlobals();});

describe('YouTube 内嵌字幕组合根', () => {
    it('只挂载有效内嵌子frame，不挂载顶层、其他主机或已失效上下文', async () => {
        globals(undefined, true); await startYoutubeEmbedContentApp(ctx());
        globals('https://evil.test/embed/abcdefghijk'); await startYoutubeEmbedContentApp(ctx());
        globals('https://www.youtube.com/watch?v=abcdefghijk'); await startYoutubeEmbedContentApp(ctx());
        globals(); await startYoutubeEmbedContentApp(ctx(true));
        expect(ports.mount).not.toHaveBeenCalled(); expect(ports.actions).toBeNull();
    });
    it('配置水合后仅挂载一次，广播复用挂载并加载当前语言包', async () => {
        await startYoutubeEmbedContentApp(ctx()); expect(ports.mount).toHaveBeenCalledOnce(); expect(ports.listeners.size).toBe(1);
        expect(ports.language).toHaveBeenCalledWith('en-US'); expect(ports.bridge).toHaveBeenLastCalledWith(document, true);
        ports.config.uiLanguage = 'zh-CN'; changed(); await Promise.resolve();
        expect(ports.language).toHaveBeenLastCalledWith('zh-CN'); expect(ports.mount).toHaveBeenCalledOnce();
    });
    it('关闭、站点禁用及恢复释放或重建同一挂载，并同步关闭MAIN桥', async () => {
        ports.config.disabledExtensionDomains = ['youtube.com']; await startYoutubeEmbedContentApp(ctx());
        expect(ports.mount).not.toHaveBeenCalled(); expect(ports.bridge).toHaveBeenLastCalledWith(document, false);
        ports.config.disabledExtensionDomains = []; changed(); expect(ports.mount).toHaveBeenCalledOnce();
        ports.config.on = false; changed(); expect(ports.unmount).toHaveBeenCalledOnce(); expect(ports.bridge).toHaveBeenLastCalledWith(document, false);
        ports.config.on = undefined; changed(); expect(ports.mount).toHaveBeenCalledTimes(2);
        ports.actions!.dispose(); expect(ports.unmount).toHaveBeenCalledTimes(2); expect(ports.listeners.size).toBe(0); expect(ports.signal!.aborted).toBe(true);
        ports.actions!.dispose(); expect(ports.unmount).toHaveBeenCalledTimes(2);
        await Promise.resolve(); expect(ports.mount).toHaveBeenCalledTimes(2);
    });
    it('BFCache暂停期间不重建，恢复后挂载，离开后延迟广播不能复活', async () => {
        await startYoutubeEmbedContentApp(ctx()); ports.suspended = true; ports.actions!.suspend(); changed(); await Promise.resolve();
        expect(ports.unmount).toHaveBeenCalledOnce(); expect(ports.mount).toHaveBeenCalledOnce();
        ports.suspended = false; ports.actions!.resume(); expect(ports.mount).toHaveBeenCalledTimes(2);
        let finish!: (ready: boolean) => void; ports.language.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        changed(); ports.actions!.dispose(); finish(true); await Promise.resolve(); ports.actions!.resume();
        expect(ports.mount).toHaveBeenCalledTimes(2); expect(ports.listeners.size).toBe(0);
    });
    it('等待配置时离开或失效不挂载', async () => {
        const pending = startYoutubeEmbedContentApp(ctx()); ports.actions!.dispose(); await pending;
        const context = ctx(); const invalid = startYoutubeEmbedContentApp(context); Object.defineProperty(context, 'isInvalid', {value: true}); await invalid;
        expect(ports.mount).not.toHaveBeenCalled(); expect(ports.signal!.aborted).toBe(true);
    });
    it('等待语言包时离开或失效不挂载，已挂载上下文失效后不可重建', async () => {
        let finish!: (ready: boolean) => void;
        ports.language.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const context = ctx(); const pending = startYoutubeEmbedContentApp(context); await Promise.resolve();
        Object.defineProperty(context, 'isInvalid', {value: true}); finish(true); await pending;
        ports.language.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const leaving = startYoutubeEmbedContentApp(ctx()); await Promise.resolve(); ports.actions!.dispose(); finish(true); await leaving;
        expect(ports.mount).not.toHaveBeenCalled();
        const mounted = ctx(); await startYoutubeEmbedContentApp(mounted); Object.defineProperty(mounted, 'isInvalid', {value: true}); changed();
        expect(ports.unmount).toHaveBeenCalledOnce(); expect(ports.bridge).toHaveBeenLastCalledWith(document, false);
    });
    it('专用UI和MAIN桥保留document_start及相同frame范围，顶层桥仍覆盖SPA导航', async () => {
        const ui = (await import('../entrypoints/youtubeEmbed.content')).default;
        const bridge = (await import('../entrypoints/youtubeEmbedBridge.content')).default;
        const topBridge = (await import('../entrypoints/youtubeBridge.content')).default;
        const matches = ['*://*.youtube.com/embed/*', '*://youtube.com/embed/*'];
        expect(ui.matches).toEqual(matches); expect(bridge.matches).toEqual(matches);
        expect(topBridge.matches).toEqual(['*://*.youtube.com/*', '*://youtube.com/*']); expect(topBridge.allFrames).not.toBe(true);
        expect(ui.allFrames).toBe(true); expect(bridge.allFrames).toBe(true); expect(ui.runAt).toBe('document_start'); expect(bridge.runAt).toBe('document_start');
        expect(ui.cssInjectionMode).toBe('ui'); expect(bridge.world).toBe('MAIN'); expect(bridge.globalName).toBe(false);
        expect(ui.main).toBe(startYoutubeEmbedContentApp); expect(bridge.main).toBe(ports.bridgeMain);
    });
});
