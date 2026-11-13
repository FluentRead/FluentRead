import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const routes = vi.hoisted(() => ({mail: vi.fn(), netease: vi.fn(), embedded: vi.fn(), course: vi.fn(), mountSelection: vi.fn(), unmountSelection: vi.fn()}));
vi.mock('@/src/app/content/qqMailFrameRuntime', () => ({startQqMailFrameApp: routes.mail, startNeteaseMailFrameApp: routes.netease}));
vi.mock('@/src/app/content/embeddedFrameRuntime', () => ({startEmbeddedFrameApp: routes.embedded}));
vi.mock('@/src/app/content/courseCaptionFrame', () => ({startCourseCaptionFrameApp: routes.course}));
vi.mock('@/src/features/selection-translation/public', () => ({mountSelectionTranslator: routes.mountSelection, unmountSelectionTranslator: routes.unmountSelection}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('defineContentScript', (entry: unknown) => entry);
});

afterEach(() => vi.unstubAllGlobals());

it('共用入口只覆盖受支持的五类 frame，并按主机委托到对应运行时', async () => {
    const entry = (await import('../entrypoints/supportedFrame.content')).default;
    expect(entry.matches).toEqual([
        'https://*.hf.space/*',
        'https://disqus.com/embed/comments/*',
        'https://www.kaggleusercontent.com/kf/*/__results__.html*',
        'https://mail.qq.com/cgi-bin/readmail*',
        'https://courses.edx.org/*',
    ]);
    expect(entry.allFrames).toBe(true);
    expect(entry.matchAboutBlank).toBeUndefined();
    expect(entry.runAt).toBe('document_end');
    expect(entry.cssInjectionMode).toBe('ui');

    const context = {id: 'frame-context'} as never;
    vi.stubGlobal('window', {location: {hostname: 'mail.qq.com'}});
    await entry.main(context);
    expect(routes.mail).toHaveBeenCalledOnce();
    expect(routes.mail).toHaveBeenCalledWith(context);
    expect(routes.embedded).not.toHaveBeenCalled();
    expect(routes.course).not.toHaveBeenCalled();

    vi.stubGlobal('window', {location: {hostname: 'courses.edx.org'}});
    await entry.main(context);
    expect(routes.course).toHaveBeenCalledOnce();
    expect(routes.course).toHaveBeenCalledWith(context);
    expect(routes.embedded).not.toHaveBeenCalled();

    routes.mail.mockClear();
    for (const hostname of ['disqus.com', 'www.kaggleusercontent.com', 'fineenvs-rl-explorer.hf.space']) {
        vi.stubGlobal('window', {location: {hostname}});
        await entry.main(context);
    }
    expect(routes.embedded).toHaveBeenCalledTimes(3);
    expect(routes.mail).not.toHaveBeenCalled();
    expect(routes.netease).not.toHaveBeenCalled();
    expect(routes.mountSelection).not.toHaveBeenCalled();
    expect(routes.unmountSelection).not.toHaveBeenCalled();
});

it('网易入口保留独立主机、about:blank 和 UI 样式策略，并显式装配真实划词端口', async () => {
    const entry = (await import('../entrypoints/neteaseMailFrame.content')).default;
    expect(entry.matches).toEqual(['https://*.mail.163.com/*', 'https://*.mail.126.com/*', 'https://*.mail.yeah.net/*']);
    expect(entry.allFrames).toBe(true);
    expect(entry.matchAboutBlank).toBe(true);
    expect(entry.runAt).toBe('document_end');
    expect(entry.cssInjectionMode).toBe('ui');
    const context = {id: 'netease-frame-context'} as never;
    const pending = Promise.resolve();
    routes.netease.mockReturnValueOnce(pending);
    expect(entry.main(context)).toBe(pending);
    await pending;
    expect(routes.netease).toHaveBeenCalledOnce();
    expect(routes.netease).toHaveBeenCalledWith(context, {mount: routes.mountSelection, unmount: routes.unmountSelection});
    expect(routes.mail).not.toHaveBeenCalled();
    expect(routes.embedded).not.toHaveBeenCalled();
    expect(routes.course).not.toHaveBeenCalled();
    // 入口只传入能力；是否挂载仍由真实 frame 的授权和配置状态决定。
    expect(routes.mountSelection).not.toHaveBeenCalled();
    expect(routes.unmountSelection).not.toHaveBeenCalled();
});
