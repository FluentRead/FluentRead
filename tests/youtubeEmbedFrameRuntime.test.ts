/**
 * @file tests/youtubeEmbedFrameRuntime.test.ts
 * 文件职责：核验 YouTube 内嵌字幕组合根的独立入口、异步等待与生命周期。
 * 主要内容：替换配置、语言包和视频挂载端口，验证总开关、站点禁用、暂停恢复、失效和延迟回调的所有权。
 * 模块边界：真实播放器的字幕来源与 DOM 由视频专项测试负责，此处不调用在线服务。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
const ports = vi.hoisted(() => ({config: {} as Record<string, unknown>, listeners: new Set<(next: Record<string, unknown>) => void>(),
    htmlFrame: vi.fn(), mount: vi.fn(), unmount: vi.fn(), language: vi.fn(), bridge: vi.fn(), bridgeMain: vi.fn(),
    sendMessage: vi.fn(), waitDocument: vi.fn(), stopScanner: vi.fn(), activate: undefined as undefined | (() => () => void),
    actions: null as null | {suspend(): void; resume(): void; dispose(): void}, suspended: false, signal: undefined as AbortSignal | undefined,
}));
vi.mock('@/src/app/content/htmlMediaFrame', () => ({startHtmlMediaFrameApp: ports.htmlFrame}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(),
    subscribeConfig: (fn: (next: Record<string, unknown>) => void) => {ports.listeners.add(fn);return () => ports.listeners.delete(fn);}}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: ports.language}));
vi.mock('@/src/features/video-subtitle/content/htmlMedia', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/video-subtitle/content/htmlMedia')>('@/src/features/video-subtitle/content/htmlMedia');
    return {
        ...actual,
        mountWhenHtmlMediaPresent: (activate: () => () => void) => {
            ports.activate = activate;
            return ports.stopScanner;
        },
    };
});
vi.mock('@/src/features/video-subtitle/public', () => ({mountVideoSubtitleTranslation: ports.mount,
    isYouTubeEmbedPage: (location: URL) => /(^|\.)youtube(?:-nocookie)?\.com$/u.test(location.hostname) && /^\/embed\/[\w-]{11}\/?$/u.test(location.pathname)}));
vi.mock('@/src/app/content/mainWorldBridgeLifecycle', () => ({setMainWorldBridgesEnabled: ports.bridge}));
vi.mock('@/src/app/content/youtubeTimedTextBridge', () => ({startYoutubeTimedTextBridgeApp: ports.bridgeMain}));
vi.mock('@/src/app/content/pageLifecycle', () => ({waitForContentDocument: ports.waitDocument,
    installContentPageLifecycle: (_window: unknown, signal: AbortSignal, actions: typeof ports.actions) => {
        ports.actions = actions; ports.signal = signal; return {isSuspended: () => ports.suspended};
    }}));
import {startYoutubeEmbedContentApp} from '@/src/app/content/youtubeEmbedFrameRuntime';
import {startYoutubeEmbedBootstrap} from '@/src/app/content/youtubeEmbedBootstrap';
import {isYouTubeEmbedPage} from '@/src/features/video-subtitle/content/youtubeEmbedUrl';
import {
    VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE,
    VIDEO_SUBTITLE_FRAME_SCRIPT,
    VIDEO_SUBTITLE_FRAME_STARTED_KEY,
} from '@/src/features/video-subtitle/frameProtocol';
import {
    createBrowserVideoSubtitleFrameExecutor,
    createVideoSubtitleFrameHandler,
} from '@/src/app/background/handlers/videoSubtitleFrame';
import {isBrowserTabId} from '@/src/app/background/tabTranslationState';

function ctx(invalid = false) {return {isInvalid: invalid} as unknown as ContentScriptContext;}
function globals(href = 'https://www.youtube.com/embed/abcdefghijk', topLevel = false, doc: Record<string, unknown> = {}) {
    const page = {top: {} as unknown, location: new URL(href)} as Record<string, unknown>;
    if (topLevel) page.top = page;
    vi.stubGlobal('window', page); vi.stubGlobal('document', doc);
}
const changed = () => ports.listeners.forEach(fn => fn(ports.config));
beforeEach(() => {
    for (const key of Object.keys(ports.config)) delete ports.config[key];
    Object.assign(ports.config, {on: true, disabledExtensionDomains: [], uiLanguage: 'en-US'});
    ports.htmlFrame.mockReset();
    ports.listeners.clear(); ports.suspended = false; ports.actions = null; ports.signal = undefined;
    ports.activate = undefined; ports.stopScanner.mockReset();
    ports.waitDocument.mockReset().mockResolvedValue(true);
    ports.sendMessage.mockReset().mockResolvedValue({injected: true});
    ports.mount.mockReset().mockReturnValue(ports.unmount); ports.unmount.mockReset(); ports.bridge.mockReset(); ports.bridgeMain.mockReset();
    ports.language.mockReset().mockResolvedValue(true); globals();
    vi.stubGlobal('browser', {runtime: {sendMessage: ports.sendMessage}});
    vi.stubGlobal('defineContentScript', (entry: unknown) => entry);
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
    it('重复注入到同一隔离世界时幂等忽略第二次启动，销毁后允许重新挂载', async () => {
        await startYoutubeEmbedContentApp(ctx());
        await startYoutubeEmbedContentApp(ctx());
        expect(ports.mount).toHaveBeenCalledOnce();
        expect(ports.listeners.size).toBe(1);
        ports.actions!.dispose();
        await startYoutubeEmbedContentApp(ctx());
        expect(ports.mount).toHaveBeenCalledTimes(2);
    });
    it('轻量引导入口、按需运行时入口与 MAIN 桥保持精确范围且不向引导入口引入重依赖', async () => {
        const bootstrapEntry = (await import('../entrypoints/youtubeEmbed.content')).default;
        const runtimeEntry = (await import('../entrypoints/videoSubtitleFrame.content')).default;
        const bridge = (await import('../entrypoints/youtubeEmbedBridge.content')).default;
        const topBridge = (await import('../entrypoints/youtubeBridge.content')).default;
        const matches = ['*://*.youtube.com/embed/*', '*://youtube.com/embed/*'];
        expect(bootstrapEntry.matches).toEqual(['http://*/*', 'https://*/*']); expect(bridge.matches).toEqual(matches);
        expect(topBridge.matches).toEqual(['*://*.youtube.com/*', '*://youtube.com/*']); expect(topBridge.allFrames).not.toBe(true);
        expect(bootstrapEntry.allFrames).toBe(true); expect(bridge.allFrames).toBe(true);
        expect(bootstrapEntry.runAt).toBe('document_start'); expect(bridge.runAt).toBe('document_start');
        expect(bootstrapEntry.cssInjectionMode).toBeUndefined();
        expect(bootstrapEntry.main).toBe(startYoutubeEmbedBootstrap);
        expect(runtimeEntry.registration).toBe('runtime');
        expect(runtimeEntry.cssInjectionMode).toBe('manual');
        expect(typeof runtimeEntry.main).toBe('function');
        // 同步返回 undefined 以兼容 MV2 tabs.executeScript，并在后台异步启动组合根
        const syncReturn = (runtimeEntry.main as (c: ContentScriptContext) => unknown)(ctx(true));
        expect(syncReturn).toBeUndefined();
        expect(bridge.world).toBe('MAIN'); expect(bridge.globalName).toBe(false);
        expect(bridge.main).toBe(ports.bridgeMain);
        const bootstrapSource = readFileSync(resolve(__dirname, '../src/app/content/youtubeEmbedBootstrap.ts'), 'utf8');
        for (const forbidden of ['services/config/store', 'platform/i18n/uiLanguageBundles', 'video-subtitle/public', 'video-subtitle/content/runtime', 'video-subtitle/content/ui']) {
            expect(bootstrapSource).not.toContain(forbidden);
        }
    });
});

describe('YouTube 内嵌 URL 识别', () => {
    it('使用默认 window.location 与显式参数识别标准 youtube/youtube-nocookie 内嵌路径', () => {
        expect(isYouTubeEmbedPage()).toBe(true);
        expect(isYouTubeEmbedPage(new URL('https://www.youtube-nocookie.com/embed/aB12_cd-345/'))).toBe(true);
        expect(isYouTubeEmbedPage(new URL('https://www.youtube.com/watch?v=abcdefghijk'))).toBe(false);
        expect(isYouTubeEmbedPage(new URL('https://www.youtube.com/embed/short'))).toBe(false);
        expect(isYouTubeEmbedPage(new URL('https://evil.example/embed/abcdefghijk'))).toBe(false);
    });
});

describe('视频字幕子 frame 轻量引导与后台按需注入', () => {
    it('顶层页面、失效上下文、非 HTTP 协议、已启动或排除子 frame 立即退出且不通信', async () => {
        globals('https://www.youtube.com/embed/abcdefghijk', true); await startYoutubeEmbedBootstrap(ctx());
        globals(); await startYoutubeEmbedBootstrap(ctx(true));
        globals('file:///example.html'); await startYoutubeEmbedBootstrap(ctx());
        globals(); (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY] = true;
        await startYoutubeEmbedBootstrap(ctx());
        for (const url of [
            'https://www.youtube.com/watch?v=abcdefghijk',
            'https://www.youtube-nocookie.com/watch?v=abcdefghijk',
            'https://x.com/home',
            'https://twitter.com/i/status/1',
            'https://www.douyin.com/video/123',
            'https://www.edx.org/course',
        ]) {
            globals(url); await startYoutubeEmbedBootstrap(ctx());
        }
        globals('https://player.example/embed', false, {referrer: 'https://www.douyin.com/jingxuan/search/demo'});
        await startYoutubeEmbedBootstrap(ctx());
        expect(ports.sendMessage).not.toHaveBeenCalled();
        expect(ports.activate).toBeUndefined();
    });

    it('YouTube /embed/ 子 frame 在 document_start 直接请求后台按需注入，支持有限重试、告警与生命周期清理', async () => {
        globals('https://www.youtube-nocookie.com/embed/abcdefghijk');
        await startYoutubeEmbedBootstrap(ctx());
        expect(ports.sendMessage).toHaveBeenCalledWith({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE});

        // 瞬时失败后自动有限重试并最终成功，同时支持 BFCache resume 再次检查
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const failure = new Error('tab closed');
            ports.sendMessage.mockClear();
            ports.sendMessage
                .mockRejectedValueOnce(failure)
                .mockResolvedValueOnce({injected: false, error: 'frame committing'})
                .mockResolvedValueOnce({injected: true});
            await startYoutubeEmbedBootstrap(ctx());
            expect(warning).toHaveBeenCalledWith('[FluentRead] 视频字幕子 frame 注入失败', failure);
            await vi.advanceTimersByTimeAsync(250);
            expect(warning).toHaveBeenCalledWith('[FluentRead] 视频字幕子 frame 注入失败', 'frame committing');
            await vi.advanceTimersByTimeAsync(250);
            expect(ports.sendMessage).toHaveBeenCalledTimes(3);

            // 耗尽重试上限后停止自动重试；BFCache suspend 清理定时器，resume 重新触发
            warning.mockClear();
            ports.sendMessage.mockClear();
            ports.sendMessage.mockResolvedValue({injected: false});
            await startYoutubeEmbedBootstrap(ctx());
            await vi.advanceTimersByTimeAsync(1000);
            expect(ports.sendMessage).toHaveBeenCalledTimes(3);
            expect(warning).toHaveBeenCalledWith('[FluentRead] 视频字幕子 frame 注入失败', {injected: false});
            ports.actions!.resume();
            await Promise.resolve();
            expect(ports.sendMessage).toHaveBeenCalledTimes(4);
            ports.actions!.dispose();

            // 不可重试的永久拒绝：告警一次且不重试，立即清理
            warning.mockClear();
            ports.sendMessage.mockClear();
            ports.sendMessage.mockResolvedValueOnce({injected: false, error: 'permanent', retryable: false});
            await startYoutubeEmbedBootstrap(ctx());
            await vi.advanceTimersByTimeAsync(1000);
            expect(ports.sendMessage).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith('[FluentRead] 视频字幕子 frame 注入失败', 'permanent');

            // 失败分支或重试触发时若运行时已启动，则立即标记完成并清理，不告警不重试
            warning.mockClear();
            ports.sendMessage.mockClear();
            ports.sendMessage.mockImplementationOnce(async () => {
                (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY] = true;
                throw new Error('late disconnect after injection');
            });
            await startYoutubeEmbedBootstrap(ctx());
            expect(warning).not.toHaveBeenCalled();
            delete (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY];

            // 启动阶段异常（如语言包加载失败）必须清理启动标记，允许后续重试恢复
            ports.language.mockRejectedValueOnce(new Error('bundle network error'));
            await expect(startYoutubeEmbedContentApp(ctx())).rejects.toThrow('bundle network error');
            expect((window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY]).toBeUndefined();

            // 重试定时器触发前运行时已启动：requestInjection 入口直接标记完成并清理，不重复发消息
            warning.mockClear();
            ports.sendMessage.mockClear();
            ports.sendMessage.mockResolvedValueOnce({injected: false, error: 'transient', retryable: true});
            await startYoutubeEmbedBootstrap(ctx());
            (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY] = true;
            await vi.advanceTimersByTimeAsync(250);
            expect(ports.sendMessage).toHaveBeenCalledTimes(1);
            delete (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY];

            // 定时器待执行期间卸载则取消重试
            warning.mockClear();
            ports.sendMessage.mockClear();
            ports.sendMessage.mockResolvedValueOnce({injected: false});
            await startYoutubeEmbedBootstrap(ctx());
            ports.actions!.dispose();
            await vi.advanceTimersByTimeAsync(500);
            expect(ports.sendMessage).toHaveBeenCalledTimes(1);

            // 上下文失效时不告警也不重试
            warning.mockClear();
            const invalidating = ctx();
            ports.sendMessage.mockImplementationOnce(async () => {
                Object.defineProperty(invalidating, 'isInvalid', {value: true});
                throw new Error('context invalidated');
            });
            await startYoutubeEmbedBootstrap(invalidating);
            expect(warning).not.toHaveBeenCalled();

            const invalidatingResolve = ctx();
            ports.sendMessage.mockImplementationOnce(async () => {
                Object.defineProperty(invalidatingResolve, 'isInvalid', {value: true});
                return {injected: false};
            });
            await startYoutubeEmbedBootstrap(invalidatingResolve);
            expect(warning).not.toHaveBeenCalled();
        } finally {
            warning.mockRestore();
            vi.useRealTimers();
        }
    });

    it('普通与 Vimeo/Coursera 子 frame 仅在发现媒体后请求一次注入，遵循加载等待、BFCache 与清理', async () => {
        for (const url of ['https://player.vimeo.com/video/123456', 'https://www.coursera.org/learn/python/lecture/Ab12/intro']) {
            globals(url);
            await startYoutubeEmbedBootstrap(ctx());
            expect(ports.activate).toBeDefined();
            expect(ports.sendMessage).not.toHaveBeenCalled();
            ports.actions!.dispose();
            ports.activate = undefined;
        }
        ports.stopScanner.mockClear();

        // 等待文档被中止或失效时不启动监听
        globals('https://podcast.example/embed', false, {readyState: 'loading'});
        ports.waitDocument.mockResolvedValueOnce(false);
        await startYoutubeEmbedBootstrap(ctx());
        expect(ports.activate).toBeUndefined();

        const context = ctx();
        ports.waitDocument.mockImplementationOnce(async () => {
            Object.defineProperty(context, 'isInvalid', {value: true});
            return true;
        });
        await startYoutubeEmbedBootstrap(context);
        expect(ports.activate).toBeUndefined();

        // 文档尚未就绪时收到 BFCache resume 不得提前挂载媒体监听
        let resolveDoc!: (ready: boolean) => void;
        ports.waitDocument.mockImplementationOnce(() => new Promise(resolve => {resolveDoc = resolve;}));
        globals('https://podcast.example/embed', false, {readyState: 'loading'});
        const pendingBootstrap = startYoutubeEmbedBootstrap(ctx());
        ports.actions!.resume();
        expect(ports.activate).toBeUndefined();
        resolveDoc(true);
        await pendingBootstrap;
        expect(ports.activate).toBeDefined();
        ports.actions!.dispose();
        ports.activate = undefined;
        ports.stopScanner.mockClear();

        // 已启动状态在 startMediaWatcher / scheduleRetry 中立即清理
        globals('https://podcast.example/embed');
        await startYoutubeEmbedBootstrap(ctx());
        (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY] = true;
        ports.actions!.resume();
        expect(ports.stopScanner).toHaveBeenCalledOnce();
        delete (window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY];
        ports.stopScanner.mockClear();
        ports.activate = undefined;

        // 正常等待完成后启动轻量媒体监听，合并并发请求，未注入时可重试，注入成功后卸载自身
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let resolveInject!: (value: {injected: boolean}) => void;
        ports.sendMessage.mockImplementationOnce(() => new Promise(resolve => {resolveInject = resolve;}));
        globals('https://podcast.example/embed', false, {readyState: 'loading'});
        await startYoutubeEmbedBootstrap(ctx());
        expect(ports.activate).toBeDefined();
        ports.actions!.resume(); // 已在监听时幂等不重复挂载
        const disposeMedia = ports.activate!();
        ports.activate!(); // 合并 inFlight 请求
        expect(ports.sendMessage).toHaveBeenCalledOnce();
        resolveInject({injected: false});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(warning).toHaveBeenCalledWith('[FluentRead] 视频字幕子 frame 注入失败', {injected: false});
        expect(ports.stopScanner).not.toHaveBeenCalled();
        disposeMedia();

        // BFCache 暂停/恢复
        ports.suspended = true;
        ports.actions!.suspend();
        expect(ports.stopScanner).toHaveBeenCalledOnce();
        ports.actions!.resume(); // 暂停态不重建
        expect(ports.stopScanner).toHaveBeenCalledOnce();
        ports.suspended = false;
        ports.actions!.resume();

        // 再次触发并成功注入后自我卸载，后续滞后触发被守卫忽略
        ports.sendMessage.mockResolvedValueOnce({injected: true});
        ports.activate!();
        await vi.waitFor(() => expect(ports.stopScanner).toHaveBeenCalledTimes(2));
        ports.activate!();
        expect(ports.sendMessage).toHaveBeenCalledTimes(2);
        warning.mockRestore();
    });

    it('后台处理器严格校验同扩展、有效 tab、正整数子 frame 与 HTTP(S) 来源并兼容 MV3/MV2 执行器', async () => {
        const executeScript = vi.fn().mockResolvedValue(undefined);
        const handler = createVideoSubtitleFrameHandler({
            runtimeId: 'ext-id',
            isTabId: isBrowserTabId,
            executeScript,
        });
        expect(handler.type).toBe(VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE);

        await expect(handler.handle({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}, undefined as never))
            .resolves.toEqual({injected: false, error: '当前上下文无权注入视频字幕脚本', retryable: false});
        await expect(handler.handle({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}, {sender: {id: 'other'}}))
            .resolves.toEqual({injected: false, error: '当前上下文无权注入视频字幕脚本', retryable: false});
        await expect(handler.handle({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}, {sender: {id: 'ext-id', tab: {id: -1}}}))
            .resolves.toEqual({injected: false, error: '缺少有效标签页标识', retryable: false});
        for (const frameId of [undefined, 0, -2, 1.5]) {
            await expect(handler.handle({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}, {sender: {id: 'ext-id', tab: {id: 7}, frameId}}))
                .resolves.toEqual({injected: false, error: '仅允许向子 frame 按需注入视频字幕脚本', retryable: false});
        }
        for (const url of [undefined, 'about:blank', 'chrome://settings', 'file:///a.html']) {
            await expect(handler.handle({type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE}, {sender: {id: 'ext-id', tab: {id: 7}, frameId: 3, url}}))
                .resolves.toEqual({injected: false, error: '仅支持向 HTTP/HTTPS 子 frame 注入视频字幕脚本', retryable: false});
        }

        // 底层注入异常转为可重试响应，不破坏协议契约
        executeScript.mockRejectedValueOnce(new Error('No frame with id 3'));
        await expect(handler.handle(
            {type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE},
            {sender: {id: 'ext-id', tab: {id: 7}, frameId: 3, url: 'https://www.youtube.com/embed/abcdefghijk'}},
        )).resolves.toEqual({injected: false, error: 'No frame with id 3', retryable: true});
        executeScript.mockRejectedValueOnce('transient');
        await expect(handler.handle(
            {type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE},
            {sender: {id: 'ext-id', tab: {id: 7}, frameId: 3, url: 'https://www.youtube.com/embed/abcdefghijk'}},
        )).resolves.toEqual({injected: false, error: 'transient', retryable: true});

        await expect(handler.handle(
            {type: VIDEO_SUBTITLE_FRAME_INJECT_MESSAGE},
            {sender: {id: 'ext-id', tab: {id: 7}, frameId: 3, url: 'https://www.youtube.com/embed/abcdefghijk'}},
        )).resolves.toEqual({injected: true});
        expect(executeScript).toHaveBeenCalledWith(7, 3, VIDEO_SUBTITLE_FRAME_SCRIPT);

        // MV3 scripting.executeScript
        const mv3Execute = vi.fn().mockResolvedValue([]);
        await createBrowserVideoSubtitleFrameExecutor({scripting: {executeScript: mv3Execute}})(7, 3, VIDEO_SUBTITLE_FRAME_SCRIPT);
        expect(mv3Execute).toHaveBeenCalledWith({target: {tabId: 7, frameIds: [3]}, files: [VIDEO_SUBTITLE_FRAME_SCRIPT], injectImmediately: true});

        // MV2 tabs.executeScript (Firefox / Safari)
        const mv2Execute = vi.fn().mockResolvedValue([]);
        await createBrowserVideoSubtitleFrameExecutor({tabs: {executeScript: mv2Execute}})(7, 3, VIDEO_SUBTITLE_FRAME_SCRIPT);
        expect(mv2Execute).toHaveBeenCalledWith(7, {file: `/${VIDEO_SUBTITLE_FRAME_SCRIPT}`, frameId: 3, runAt: 'document_start'});

        // 无可用注入 API 时显式报错
        await expect(createBrowserVideoSubtitleFrameExecutor({})(7, 3, VIDEO_SUBTITLE_FRAME_SCRIPT))
            .rejects.toThrow('当前浏览器不支持向子 frame 注入视频字幕脚本');
    });
});
