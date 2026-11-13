/**
 * @file tests/videoCourseFrame.test.ts
 * 文件职责：验证 edX 子 frame 组合根的范围、配置水合与启停所有权。
 * 主要内容：通过注入的页面生命周期和服务边界验证异步挂载、站点禁用、配置广播、暂停恢复及卸载，下载仍使用真实文件名规范化。
 * 模块边界：字幕 DOM 行为由平台挂载测试和真实 iframe 浏览器专项验证；此处只替换外部端口。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
const ports = vi.hoisted(() => ({config: {} as Record<string, unknown>, listeners: new Set<() => void>(),
    mount: vi.fn(), unmount: vi.fn(), language: vi.fn(), patch: vi.fn(), download: vi.fn(), send: vi.fn(),
    actions: null as null | {suspend(): void; resume(): void; dispose(): void}, suspended: false,
}));
vi.mock('@/src/services/config/store', () => ({config: ports.config, configReady: Promise.resolve(),
    subscribeConfig: (fn: () => void) => {ports.listeners.add(fn);return () => ports.listeners.delete(fn);}, requestConfigPatch: ports.patch}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: ports.language}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: ports.send}));
vi.mock('@/src/services/translation/client', () => ({translateVideoText: vi.fn()}));
vi.mock('@/src/features/video-subtitle/content/platformRuntime', () => ({mountPlatformCaptions: ports.mount}));
vi.mock('@/src/shared/dom/downloadTextFile', () => ({downloadTextFile: ports.download}));
vi.mock('@/src/app/content/pageLifecycle', () => ({installContentPageLifecycle: (_window: unknown, _signal: unknown, actions: typeof ports.actions) => {
    ports.actions = actions; return {isSuspended: () => ports.suspended};
}}));
import {startCourseCaptionFrameApp} from '@/src/app/content/courseCaptionFrame';
import {Config} from '@/src/core/config/model';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
registerAllUiLanguageBundles();

function ctx(invalid = false) { return {isInvalid: invalid} as unknown as ContentScriptContext; }
function globals(host = 'courses.edx.org', topLevel = false) {
    const page = {top: {} as unknown, location: new URL(`https://${host}/courseware/unit`)};
    if (topLevel) page.top = page;
    vi.stubGlobal('window', page); vi.stubGlobal('document', {title: 'Course / lesson'});
}
beforeEach(() => {
    Object.assign(ports.config, new Config(), {on: true, videoTranslationEnabled: true, uiLanguage: 'en-US'});
    ports.listeners.clear(); ports.suspended = false; ports.actions = null;
    ports.mount.mockReset().mockReturnValue(ports.unmount); ports.unmount.mockReset();
    ports.language.mockReset().mockResolvedValue(true); ports.patch.mockReset().mockResolvedValue(undefined); ports.download.mockReset(); globals();
});
afterEach(() => { ports.actions?.dispose(); vi.unstubAllGlobals(); });
const changed = () => ports.listeners.forEach(fn => fn());

describe('edX 课程 frame 组合根', () => {
    it('只接入 courses.edx.org 子 frame，不重复挂载顶层，也不启动无效上下文', async () => {
        globals('courses.edx.org', true); await startCourseCaptionFrameApp(ctx());
        globals('evil.test'); await startCourseCaptionFrameApp(ctx());
        globals(); await startCourseCaptionFrameApp(ctx(true));
        expect(ports.mount).not.toHaveBeenCalled(); expect(ports.actions).toBeNull();
    });
    it('挂载后复用单一配置订阅，关闭、暂停、站点禁用和恢复精确释放', async () => {
        await startCourseCaptionFrameApp(ctx()); expect(ports.mount).toHaveBeenCalledOnce();
        changed(); await Promise.resolve(); expect(ports.mount).toHaveBeenCalledOnce();
        const options = ports.mount.mock.calls[0][0];
        expect(options.label('重试')).toBe('Retry');
        options.patch({videoSubtitleOffsetMs: 500}); await Promise.resolve();
        expect(ports.patch).toHaveBeenCalledWith({videoSubtitleOffsetMs: 500}, ports.send);
        ports.patch.mockRejectedValueOnce(new Error('closed')); options.patch({videoSubtitleOffsetMs: 0}); await Promise.resolve();
        options.download('SRT source', 'en'); expect(ports.download).toHaveBeenCalledWith(expect.stringMatching(/\.srt$/), 'SRT source', 'application/x-subrip;charset=utf-8');
        ports.config.videoTranslationEnabled = false; changed(); expect(ports.unmount).toHaveBeenCalledOnce();
        ports.config.videoTranslationEnabled = true; ports.config.on = false; changed();
        ports.config.on = true; ports.config.disabledExtensionDomains = ['edx.org']; changed(); expect(ports.mount).toHaveBeenCalledOnce();
        ports.config.disabledExtensionDomains = []; ports.suspended = true; ports.actions!.suspend(); changed();
        ports.suspended = false; ports.actions!.resume(); expect(ports.mount).toHaveBeenCalledTimes(2);
        ports.actions!.dispose(); expect(ports.unmount).toHaveBeenCalledTimes(2); expect(ports.listeners.size).toBe(0);
        changed(); ports.actions!.resume(); await Promise.resolve(); expect(ports.mount).toHaveBeenCalledTimes(2);
    });
    it('配置尚在等待时离开或上下文失效，不发布挂载', async () => {
        const pending = startCourseCaptionFrameApp(ctx()); ports.actions!.dispose(); await pending; expect(ports.mount).not.toHaveBeenCalled();
        const context = ctx(); const next = startCourseCaptionFrameApp(context); Object.defineProperty(context, 'isInvalid', {value: true}); await next;
        expect(ports.mount).not.toHaveBeenCalled();
    });
    it('语言包等待期间失效或离开，同样不挂载；已挂载后失效不能恢复', async () => {
        let finish!: (value: boolean) => void;
        ports.language.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const context = ctx(); const pending = startCourseCaptionFrameApp(context); await Promise.resolve();
        Object.defineProperty(context, 'isInvalid', {value: true}); finish(true); await pending; expect(ports.mount).not.toHaveBeenCalled();
        ports.language.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const leaving = startCourseCaptionFrameApp(ctx()); await Promise.resolve(); ports.actions!.dispose(); finish(true); await leaving;
        expect(ports.mount).not.toHaveBeenCalled();
        const mounted = ctx(); await startCourseCaptionFrameApp(mounted); Object.defineProperty(mounted, 'isInvalid', {value: true}); changed();
        expect(ports.unmount).toHaveBeenCalledOnce();
    });
});
