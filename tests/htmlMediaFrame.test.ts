import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
const ports = vi.hoisted(() => ({config: {on: true, videoTranslationEnabled: true, disabledExtensionDomains: [] as string[], uiLanguage: 'en-US'},
    listeners: new Set<() => void>(), waitDocument: vi.fn(), language: vi.fn(), mount: vi.fn(), unmount: vi.fn(), stopScanner: vi.fn(),
    activate: undefined as undefined | (() => () => void), actions: undefined as undefined | {suspend(): void; resume(): void; dispose(): void}, suspended: false,
}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(),
    subscribeConfig: (callback: () => void) => {ports.listeners.add(callback); return () => ports.listeners.delete(callback);}}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: ports.language}));
vi.mock('@/src/features/video-subtitle/content/htmlMedia', async () => {
    const actual = await vi.importActual<typeof import('@/src/features/video-subtitle/content/htmlMedia')>('@/src/features/video-subtitle/content/htmlMedia');
    return {
        ...actual,
        mountWhenHtmlMediaPresent: (activate: () => () => void) => {
            ports.activate = activate; return ports.stopScanner;
        },
    };
});
vi.mock('@/src/features/video-subtitle/public', () => ({mountVideoSubtitleTranslation: ports.mount}));
vi.mock('@/src/app/content/pageLifecycle', () => ({waitForContentDocument: ports.waitDocument, installContentPageLifecycle: (_window: unknown, _signal: unknown, actions: typeof ports.actions) => {
    ports.actions = actions; return {isSuspended: () => ports.suspended};
}}));
import {startHtmlMediaFrameApp} from '@/src/app/content/htmlMediaFrame';
import {VIDEO_SUBTITLE_FRAME_STARTED_KEY} from '@/src/features/video-subtitle/frameProtocol';
const ctx = () => ({isInvalid: false}) as unknown as ContentScriptContext;
function page(url = 'https://podcast.example/embed', top = false) {const win = {location: new URL(url), top: {} as unknown}; if (top) win.top = win; vi.stubGlobal('window', win); vi.stubGlobal('document', {});}
const changed = () => ports.listeners.forEach(callback => callback());
beforeEach(() => {
    Object.assign(ports.config, {on: true, videoTranslationEnabled: true, disabledExtensionDomains: [], uiLanguage: 'en-US'});
    ports.listeners.clear(); ports.activate = undefined; ports.actions = undefined; ports.suspended = false;
    ports.waitDocument.mockReset().mockResolvedValue(true);
    ports.language.mockReset().mockResolvedValue(undefined); ports.mount.mockReset().mockReturnValue(ports.unmount);
    ports.unmount.mockReset(); ports.stopScanner.mockReset(); page(); vi.stubGlobal('defineContentScript', (value: unknown) => value);
});
afterEach(() => {ports.actions?.dispose(); vi.unstubAllGlobals();});

it.each([
    'https://www.youtube.com/embed/abcdefghijk',
    'https://x.com/home',
    'https://www.edx.org/course',
    'https://www.douyin.com/jingxuan/search/demo',
    'https://live.bilibili.com/123',
    'file:///example.html',
])('defers to existing adapters or unsupported URLs: %s', async url => {
    page(url); await startHtmlMediaFrameApp(ctx()); expect(ports.activate).toBeUndefined();
});
it('skips frames embedded by excluded domestic video platforms via referrer', async () => {
    page('https://player.example/embed');
    vi.stubGlobal('document', {referrer: 'https://www.douyin.com/jingxuan/search/demo'});
    await startHtmlMediaFrameApp(ctx());
    expect(ports.activate).toBeUndefined();
});
it('does not start twice in a top frame or invalid context', async () => {
    page(undefined, true); await startHtmlMediaFrameApp(ctx()); page(); const invalid = ctx(); Object.defineProperty(invalid, 'isInvalid', {value: true});
    await startHtmlMediaFrameApp(invalid); expect(ports.actions).toBeUndefined();
});
it('keeps the HTML media fallback available in an embedded Coursera lecture', async () => {
    page('https://www.coursera.org/learn/python/lecture/Ab12/introduction');
    await startHtmlMediaFrameApp(ctx());
    expect(ports.activate).toBeDefined();
});
it('mounts, suspends, resumes, and cleans up in an embedded player.vimeo.com iframe', async () => {
    page('https://player.vimeo.com/video/123456789');
    await startHtmlMediaFrameApp(ctx());
    expect(ports.activate).toBeDefined();
    const dispose = ports.activate!();
    await vi.waitFor(() => expect(ports.mount).toHaveBeenCalledOnce());
    ports.suspended = true;
    ports.actions!.suspend();
    expect(ports.stopScanner).toHaveBeenCalledOnce();
    ports.suspended = false;
    ports.actions!.resume();
    expect(ports.activate).toBeDefined();
    dispose();
    expect(ports.unmount).toHaveBeenCalledOnce();
    ports.actions!.dispose();
    expect(ports.listeners.size).toBe(0);
});
it('loads the subtitle module only after media appears and respects scanner cleanup', async () => {
    await startHtmlMediaFrameApp(ctx()); expect(ports.activate).toBeDefined(); expect(ports.mount).not.toHaveBeenCalled();
    const dispose = ports.activate!(); await vi.waitFor(() => expect(ports.mount).toHaveBeenCalledOnce());
    dispose(); expect(ports.unmount).toHaveBeenCalledOnce();
    changed(); expect(ports.stopScanner).not.toHaveBeenCalled();
    ports.config.on = false; changed(); expect(ports.stopScanner).toHaveBeenCalledOnce();
    ports.config.on = true; changed(); ports.suspended = true; ports.actions!.suspend(); changed();
    expect(ports.stopScanner).toHaveBeenCalledTimes(2);
    ports.suspended = false; ports.actions!.resume(); expect(ports.activate).toBeDefined();
    ports.config.disabledExtensionDomains = ['podcast.example']; changed(); expect(ports.stopScanner).toHaveBeenCalledTimes(3);
    ports.actions!.dispose(); expect(ports.listeners.size).toBe(0);
});
it('rejects delayed module mounting after media removal or frame invalidation', async () => {
    const context = ctx(); await startHtmlMediaFrameApp(context);
    const removed = ports.activate!(); removed(); await Promise.resolve(); expect(ports.mount).not.toHaveBeenCalled();
    ports.activate!(); Object.defineProperty(context, 'isInvalid', {value: true});
    await vi.waitFor(() => expect(ports.mount).not.toHaveBeenCalled());
    ports.actions!.dispose();
});
it('does not revive after leaving during configuration or language hydration', async () => {
    const first = startHtmlMediaFrameApp(ctx()); ports.actions!.dispose(); await first;
    expect(ports.activate).toBeUndefined();
    let resolve!: () => void; ports.language.mockImplementationOnce(() => new Promise<void>(done => {resolve = done;}));
    const context = ctx(); const pending = startHtmlMediaFrameApp(context); await Promise.resolve();
    Object.defineProperty(context, 'isInvalid', {value: true}); resolve(); await pending;
    expect(ports.activate).toBeUndefined();
});
it('preserves a visible load failure and prevents late mounting after disposal', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('fixture view load failed'); ports.mount.mockImplementationOnce(() => {throw failure;});
    await startHtmlMediaFrameApp(ctx()); const dispose = ports.activate!();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[FluentRead] HTML 媒体字幕加载失败', failure));
    dispose(); warning.mockRestore();
    expect((await import('../entrypoints/youtubeEmbed.content')).default).toMatchObject({allFrames: true, runAt: 'document_start', matches: ['http://*/*', 'https://*/*']});
});


it('waits for a mountable document and respects cancellation during the document wait', async () => {
    vi.stubGlobal('document', {readyState: 'loading'}); ports.waitDocument.mockResolvedValueOnce(false);
    await startHtmlMediaFrameApp(ctx()); expect(ports.activate).toBeUndefined();
    const context = ctx(); ports.waitDocument.mockImplementationOnce(async () => {Object.defineProperty(context, 'isInvalid', {value: true}); return true;});
    await startHtmlMediaFrameApp(context); expect(ports.activate).toBeUndefined();
    await startHtmlMediaFrameApp(ctx()); expect(ports.activate).toBeDefined();
});


it('does not report a module rejection after its media owner has already closed', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startHtmlMediaFrameApp(ctx()); let dispose!: () => void;
    ports.mount.mockImplementationOnce(() => {dispose(); throw new Error('late fixture failure');});
    dispose = ports.activate!();
    await vi.waitFor(() => expect(ports.mount).toHaveBeenCalledOnce()); await Promise.resolve();
    expect(warning).not.toHaveBeenCalled(); warning.mockRestore();
});


it('clears the started marker and cleans up if hydration rejects during startup', async () => {
    ports.language.mockRejectedValueOnce(new Error('i18n load failed'));
    await expect(startHtmlMediaFrameApp(ctx())).rejects.toThrow('i18n load failed');
    expect((window as unknown as Record<string, unknown>)[VIDEO_SUBTITLE_FRAME_STARTED_KEY]).toBeUndefined();
    await startHtmlMediaFrameApp(ctx());
    expect(ports.activate).toBeDefined();
});

it('respects a disabled embedding site as well as the media frame site', async () => {
    vi.stubGlobal('document', {referrer: 'https://school.example/lesson'}); ports.config.disabledExtensionDomains = ['school.example'];
    await startHtmlMediaFrameApp(ctx()); expect(ports.activate).toBeUndefined();
    ports.config.disabledExtensionDomains = []; changed(); expect(ports.activate).toBeDefined();
});

it('ignores duplicate runtime startup in the same isolated frame world until disposed', async () => {
    await startHtmlMediaFrameApp(ctx());
    expect(ports.listeners.size).toBe(1);
    await startHtmlMediaFrameApp(ctx());
    expect(ports.listeners.size).toBe(1);
    ports.actions!.dispose();
    await startHtmlMediaFrameApp(ctx());
    expect(ports.listeners.size).toBe(1);
});
