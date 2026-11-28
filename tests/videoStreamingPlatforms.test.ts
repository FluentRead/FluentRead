/**
 * @file tests/videoStreamingPlatforms.test.ts
 * 文件职责：验证 Netflix、Amazon Prime Video、TED、Vimeo 的播放器容器定位、控制栏锚点、原生字幕显隐恢复与生命周期清理。
 * 主要内容：覆盖 platformProfiles 全部查询与回退分支，并在隔离 DOM 中执行 mountPlatformCaptions 验证双语/单语/关闭切换、TED 演讲稿与 `<track>` 读取、SPA 路由离开与卸载清理。
 * 模块边界：仅使用 linkedom 与注入端口测试平台字幕运行时与纯 DOM 轮廓模块，不访问真实流媒体网站或网络接口。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {Config} from '@/src/core/config/model';
import {
    findPlatformControlMount,
    findPlatformPlayerRoot,
    getPlatformDomProfile,
    hasStreamingControlBar,
    readPlatformTranscriptCue,
} from '@/src/features/video-subtitle/content/platformProfiles';
import {mountPlatformCaptions} from '@/src/features/video-subtitle/content/platformRuntime';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();

vi.mock('@/src/features/video-subtitle/content/readingAnnotationClient', () => ({
    annotateVideoReading: vi.fn(async () => null),
}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {extensionDom: true}}));
vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));

const disposals: Array<() => void> = [];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    disposals.splice(0).forEach(dispose => dispose());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function createStreamingFixture(url: string, html: string, translate = vi.fn().mockResolvedValue('流媒体测试译文')) {
    const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
    const stylePrototype = Object.getPrototypeOf(document.body.style);
    if (!stylePrototype.getPropertyPriority) {
        const priorities = new WeakMap<object, Map<string, string>>();
        const set = stylePrototype.setProperty;
        const remove = stylePrototype.removeProperty;
        const get = stylePrototype.getPropertyValue;
        stylePrototype.getPropertyValue = function (key: string) { return get.call(this, key) || ''; };
        stylePrototype.getPropertyPriority = function (key: string) { return priorities.get(this)?.get(key) || ''; };
        stylePrototype.setProperty = function (key: string, value: string, priority = '') {
            if (!priorities.has(this)) priorities.set(this, new Map());
            priorities.get(this)!.set(key, priority);
            return set.call(this, key, value);
        };
        stylePrototype.removeProperty = function (key: string) {
            priorities.get(this)?.delete(key);
            return remove.call(this, key);
        };
    }
    const selectedValues = new WeakMap<object, string>();
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() { return selectedValues.get(this) || ''; },
        set(value) { selectedValues.set(this, value); },
    });
    const config = new Config();
    config.on = true;
    config.to = 'zh-Hans';
    Object.defineProperty(window, 'location', {value: new URL(url), configurable: true});
    Object.defineProperty(window, 'innerWidth', {value: 1280, configurable: true});
    Object.defineProperty(window, 'innerHeight', {value: 720, configurable: true});
    window.getComputedStyle = () => ({display: 'block', visibility: 'visible'}) as CSSStyleDeclaration;
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Element', window.Element);

    const video = document.querySelector('video') as unknown as HTMLVideoElement | null;
    if (video) {
        Object.defineProperty(video, 'readyState', {value: 4, configurable: true});
        Object.defineProperty(video, 'seeking', {value: false, configurable: true});
        Object.defineProperty(video, 'ended', {value: false, configurable: true});
        Object.defineProperty(video, 'paused', {value: false, configurable: true});
        Object.defineProperty(video, 'currentTime', {value: 5, writable: true, configurable: true});
        Object.defineProperty(video, 'currentSrc', {value: 'https://cdn.example/video.mp4', configurable: true});
        video.getBoundingClientRect = () => ({left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({})});
    }

    let listener: (() => void) | undefined;
    const patch = vi.fn((value: Partial<Config>) => {
        Object.assign(config, value);
        listener?.();
    });
    const subscribe = vi.fn((fn: () => void) => {
        listener = fn;
        return vi.fn();
    });
    const openSettings = vi.fn();
    const start = () => {
        const dispose = mountPlatformCaptions({
            document: document as unknown as Document,
            window: window as unknown as Window,
            config,
            translate,
            patch,
            subscribe,
            openSettings,
            iconUrl: 'chrome-extension://fixture/icon/128.png',
            label: text => text,
        });
        disposals.push(dispose);
        return dispose;
    };
    const captionShadow = () => document.getElementById('fluent-read-platform-captions')?.shadowRoot;
    const controlsShadow = () => document.getElementById('fluent-read-platform-controls')?.shadowRoot;
    return {document, window, config, translate, patch, openSettings, start, captionShadow, controlsShadow, change: () => listener?.(), video};
}

describe('流媒体平台 DOM 轮廓与锚点定位', () => {
    it('返回各平台配置、播放器容器与控制栏锚点', () => {
        expect(getPlatformDomProfile('netflix')?.playerSelector).toContain('.watch-video--player-view');
        expect(getPlatformDomProfile('meet')).toBeNull();
        expect(hasStreamingControlBar('netflix')).toBe(true);
        expect(hasStreamingControlBar('primevideo')).toBe(true);
        expect(hasStreamingControlBar('ted')).toBe(true);
        expect(hasStreamingControlBar('vimeo')).toBe(true);
        expect(hasStreamingControlBar('disney')).toBe(false);
        expect(hasStreamingControlBar('bilibili')).toBe(false);

        expect(findPlatformPlayerRoot(null, 'netflix')).toBeNull();
        const {document, window} = parseHTML(`
            <div class="watch-video--player-view">
                <video id="v1"></video>
                <div class="watch-video--bottom-controls-container">
                    <button id="hidden-anchor" data-uia="control-audio-subtitle"></button>
                    <button id="visible-anchor" data-uia="control-fullscreen-enter"></button>
                </div>
            </div>
            <div id="plain-wrap"><video id="v2"></video></div>
        `);
        const v1 = document.getElementById('v1') as unknown as HTMLVideoElement;
        const v2 = document.getElementById('v2') as unknown as HTMLVideoElement;
        const hiddenAnchor = document.getElementById('hidden-anchor') as unknown as HTMLElement;
        const visibleAnchor = document.getElementById('visible-anchor') as unknown as HTMLElement;
        hiddenAnchor.getBoundingClientRect = () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({})});
        visibleAnchor.getBoundingClientRect = () => ({left: 0, top: 0, right: 32, bottom: 32, width: 32, height: 32, x: 0, y: 0, toJSON: () => ({})});
        window.getComputedStyle = ((el: Element) => ({visibility: el === hiddenAnchor ? 'hidden' : 'visible'})) as unknown as typeof window.getComputedStyle;

        const root1 = findPlatformPlayerRoot(v1, 'netflix')!;
        expect(root1.className).toBe('watch-video--player-view');
        expect(findPlatformPlayerRoot(v2, 'netflix')?.id).toBe('plain-wrap');
        expect(findPlatformPlayerRoot(v2, 'meet')?.id).toBe('plain-wrap');

        const mount = findPlatformControlMount(root1, 'netflix', v1, window as unknown as Window, false);
        expect(mount?.anchor?.id).toBe('visible-anchor');
        expect(mount?.controls.className).toBe('watch-video--bottom-controls-container');
        expect(mount?.nativeFallback).toBe(false);

        // 所有锚点不可见时回退到首个锚点
        visibleAnchor.getBoundingClientRect = () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({})});
        expect(findPlatformControlMount(root1, 'netflix', v1, window as unknown as Window, false)?.anchor?.id).toBe('hidden-anchor');

        // 无控制栏时：流媒体不悬浮回退，课程允许原生控件回退到容器
        const plainRoot = document.getElementById('plain-wrap') as unknown as HTMLElement;
        expect(findPlatformControlMount(plainRoot, 'netflix', v2, window as unknown as Window, false)).toBeNull();
        expect(findPlatformControlMount(plainRoot, 'disney', v2, window as unknown as Window, true)).toBeNull();
        expect(findPlatformControlMount(null, 'netflix', v2, window as unknown as Window, true)).toBeNull();
        Object.defineProperty(v2, 'controls', {value: true, configurable: true});
        const courseFallback = findPlatformControlMount(plainRoot, 'bilibili', v2, window as unknown as Window, true);
        expect(courseFallback?.controls).toBe(plainRoot);
        expect(courseFallback?.nativeFallback).toBe(true);
    });

    it('读取 TED 演讲稿活跃句与时间范围句，非 TED 平台直接返回空', () => {
        const {document} = parseHTML(`
            <div data-testid="transcript-cue" data-start="0" data-end="4">First talk cue</div>
            <div data-testid="transcript-cue" data-start="4" data-end="8">Second talk cue</div>
            <div data-testid="transcript-cue" data-start="bad" data-end="9">Broken cue</div>
            <div data-testid="transcript-cue" data-start="">Missing start</div>
            <div data-testid="transcript-cue" data-start="12">Missing end</div>
            <div data-testid="transcript-cue" data-start="8" data-end="10">   </div>
        `);
        expect(readPlatformTranscriptCue('vimeo', document as unknown as Document, 1)).toBe('');
        expect(readPlatformTranscriptCue('ted', document as unknown as Document, 5)).toBe('Second talk cue');
        expect(readPlatformTranscriptCue('ted', document as unknown as Document, 9)).toBe('');
        expect(readPlatformTranscriptCue('ted', document as unknown as Document, -1)).toBe('');
        expect(readPlatformTranscriptCue('ted', document as unknown as Document, NaN)).toBe('');

        const first = document.querySelector('[data-start="0"]')!;
        first.setAttribute('aria-current', 'true');
        expect(readPlatformTranscriptCue('ted', document as unknown as Document, 99)).toBe('First talk cue');
    });
});

describe('主流流媒体平台运行时生命周期', () => {
    it('Netflix 隐藏原生 timedtext、挂载控制栏并支持全部显示模式、恢复与 SPA 清理', async () => {
        const f = createStreamingFixture(
            'https://www.netflix.com/watch/80100172',
            `<div class="watch-video--player-view">
                <video></video>
                <div class="player-timedtext"><div class="player-timedtext-text-container">Welcome to Netflix.</div></div>
                <div class="watch-video--bottom-controls-container">
                    <button id="nf-cc" data-uia="control-audio-subtitle"></button>
                </div>
            </div>`,
        );
        const anchor = f.document.getElementById('nf-cc')!;
        anchor.getBoundingClientRect = () => ({left: 800, top: 660, right: 832, bottom: 692, width: 32, height: 32, x: 800, y: 660, toJSON: () => ({})});
        const nativeCaption = f.document.querySelector<HTMLElement>('.player-timedtext-text-container')!;
        nativeCaption.style.setProperty('visibility', 'visible', 'important');

        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(100);

        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Welcome to Netflix.');
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('流媒体测试译文');
        expect(f.captionShadow()?.querySelector<HTMLElement>('.tools')?.hidden).toBe(true);
        expect(nativeCaption.style.getPropertyValue('visibility')).toBe('hidden');
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();
        expect(f.document.getElementById('fluent-read-platform-controls')?.nextSibling).toBe(anchor);

        // 全屏事件触发重新布局且不丢失控制栏
        f.document.dispatchEvent(new f.window.Event('fullscreenchange'));
        await vi.advanceTimersByTimeAsync(100);
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();

        // 快捷键 Alt+M 切换显示模式（双语 <-> 仅原文）
        f.config.videoSubtitleModeHotkeyEnabled = true;
        f.config.videoSubtitleModeHotkeyAction = 'bilingual-original';
        f.change();
        const shortcutEvent = Object.assign(new f.window.Event('keydown', {bubbles: true, cancelable: true}), {
            key: 'm',
            code: 'KeyM',
            altKey: true,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
            repeat: false,
            isComposing: false,
        });
        Object.defineProperty(shortcutEvent, 'isTrusted', {value: true});
        f.document.dispatchEvent(shortcutEvent);
        await vi.advanceTimersByTimeAsync(100);
        expect(f.config.videoSubtitleDisplayMode).toBe('original-only');

        // 按钮 title 含当前模式与快捷键，菜单含快捷键胶囊，读音按钮使用 aria-checked
        const toggleBtn = f.controlsShadow()!.querySelector<HTMLButtonElement>('#fluent-read-video-subtitle-button')!;
        expect(toggleBtn.title).toContain('原文');
        expect(toggleBtn.title).toMatch(/Alt\+M|Option\+M/);
        toggleBtn.click();
        expect(f.controlsShadow()!.querySelector<HTMLElement>('[data-mode-shortcut-badge]')?.hidden).toBe(false);
        const readingBtn = f.controlsShadow()!.querySelector<HTMLButtonElement>('[data-action="toggle-reading-annotation"]')!;
        expect(readingBtn.hasAttribute('aria-pressed')).toBe(false);
        expect(readingBtn.getAttribute('aria-checked')).toBe('false');

        // 通过控制栏菜单切换关闭模式：恢复原生字幕，读音按钮禁用，但保留控制栏按钮以便重新开启
        f.controlsShadow()!.querySelector<HTMLButtonElement>('[data-mode="off"]')!.click();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.config.videoSubtitleVisible).toBe(false);
        expect(readingBtn.disabled).toBe(true);
        expect(nativeCaption.style.getPropertyValue('visibility')).toBe('visible');
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();

        // 切回仅原文和仅译文模式（仅译文下读音按钮提示需包含原文）
        f.controlsShadow()!.querySelector<HTMLButtonElement>('[data-mode="original-only"]')!.click();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.config.videoSubtitleVisible).toBe(true);
        expect(readingBtn.disabled).toBe(false);
        expect(f.captionShadow()?.querySelector<HTMLElement>('.source')?.hidden).toBe(false);
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('');

        f.controlsShadow()!.querySelector<HTMLButtonElement>('[data-mode="translation-only"]')!.click();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.captionShadow()?.querySelector<HTMLElement>('.source')?.hidden).toBe(true);
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('流媒体测试译文');
        expect(readingBtn.title).toContain('原文');

        // SPA 导航离开平台后完整移除控制栏与浮层并恢复原生节点
        Object.defineProperty(f.window, 'location', {value: new URL('https://example.com/other'), configurable: true});
        await vi.advanceTimersByTimeAsync(300);
        expect(f.document.getElementById('fluent-read-platform-controls')).toBeNull();
        expect(nativeCaption.style.getPropertyValue('visibility')).toBe('visible');

        dispose();
        expect(f.document.getElementById('fluent-read-platform-captions')).toBeNull();
    });

    it('Amazon Prime Video 识别字幕容器并挂载控制栏', async () => {
        const f = createStreamingFixture(
            'https://www.amazon.co.jp/gp/video/detail/B08EXAMPLE',
            `<div class="webPlayerSDKContainer">
                <video></video>
                <span class="atvwebplayersdk-captions-text">Prime Video line.</span>
                <div class="atvwebplayersdk-bottompanel-container">
                    <button class="atvwebplayersdk-subtitle-button"></button>
                </div>
            </div>`,
        );
        const anchor = f.document.querySelector<HTMLElement>('.atvwebplayersdk-subtitle-button')!;
        anchor.getBoundingClientRect = () => ({left: 700, top: 650, right: 732, bottom: 682, width: 32, height: 32, x: 700, y: 650, toJSON: () => ({})});

        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(100);

        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Prime Video line.');
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('流媒体测试译文');
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();
        dispose();
        expect(f.document.getElementById('fluent-read-platform-controls')).toBeNull();
    });

    it('TED 支持演讲稿活跃句与控制栏挂载', async () => {
        const f = createStreamingFixture(
            'https://www.ted.com/talks/example_talk',
            `<div data-testid="talk-player">
                <video></video>
                <div data-testid="player-controls"><button data-testid="cc-button"></button></div>
            </div>
            <div data-testid="transcript-cue" data-start="3" data-end="8">Ideas worth spreading.</div>`,
        );
        const anchor = f.document.querySelector<HTMLElement>('[data-testid="cc-button"]')!;
        anchor.getBoundingClientRect = () => ({left: 600, top: 640, right: 630, bottom: 670, width: 30, height: 30, x: 600, y: 640, toJSON: () => ({})});

        f.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Ideas worth spreading.');
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('流媒体测试译文');
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();
    });

    it('Vimeo 支持 .vp-captions 及 HTML5 <track> 字幕轨，禁用扩展时完整清理', async () => {
        const f = createStreamingFixture(
            'https://player.vimeo.com/video/123456789',
            `<div class="vp-video-wrapper">
                <video></video>
                <div class="vp-captions">Vimeo DOM caption</div>
                <div class="vp-controls"><button class="vp-cc"></button></div>
            </div>`,
        );
        const anchor = f.document.querySelector<HTMLElement>('.vp-cc')!;
        anchor.getBoundingClientRect = () => ({left: 620, top: 640, right: 650, bottom: 670, width: 30, height: 30, x: 620, y: 640, toJSON: () => ({})});

        // 注入 HTML5 TextTrack 验证优先读取 `<track>` 轨并在停用后恢复 mode
        const track = {
            kind: 'subtitles',
            language: 'en',
            label: 'English',
            mode: 'showing' as TextTrackMode,
            cues: [{startTime: 0, endTime: 10, text: 'Vimeo track cue.'}],
        };
        Object.defineProperty(f.video!, 'textTracks', {value: [track], configurable: true});

        f.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Vimeo track cue.');
        expect(track.mode).toBe('hidden');
        expect(f.document.getElementById('fluent-read-platform-controls')).not.toBeNull();

        // 静默空档不反复切回 track.mode='showing' 造成原生字幕闪烁
        f.video!.currentTime = 20;
        await vi.advanceTimersByTimeAsync(300);
        expect(f.document.getElementById('fluent-read-platform-captions')?.hidden).toBe(true);
        expect(track.mode).toBe('hidden');

        f.config.videoTranslationEnabled = false;
        f.change();
        expect(track.mode).toBe('showing');
        expect(f.document.getElementById('fluent-read-platform-controls')).toBeNull();
    });

    it('不擅自启用用户已关闭的 disabled <track>，并在流媒体控制栏同步翻译失败与重试', async () => {
        const translate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('流媒体重试成功');
        const f = createStreamingFixture(
            'https://www.netflix.com/watch/9001',
            `<div class="watch-video--player-view">
                <video></video>
                <div class="player-timedtext-text-container">Retryable Netflix line.</div>
                <div class="watch-video--bottom-controls-container">
                    <button id="nf-cc" data-uia="control-audio-subtitle"></button>
                </div>
            </div>`,
            translate,
        );
        const anchor = f.document.getElementById('nf-cc')!;
        anchor.getBoundingClientRect = () => ({left: 800, top: 660, right: 832, bottom: 692, width: 32, height: 32, x: 800, y: 660, toJSON: () => ({})});

        const disabledTrack = {
            kind: 'subtitles',
            language: 'en',
            label: 'English',
            mode: 'disabled' as TextTrackMode,
            cues: [{startTime: 0, endTime: 10, text: 'Disabled track cue.'}],
        };
        Object.defineProperty(f.video!, 'textTracks', {value: [disabledTrack], configurable: true});

        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(100);

        // disabled 轨道保持 disabled，读取的是可见 DOM 字幕
        expect(disabledTrack.mode).toBe('disabled');
        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Retryable Netflix line.');
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('');
        expect(f.controlsShadow()?.querySelector('[data-source-status]')?.textContent).toBe('这句翻译失败');
        const retryBtn = f.controlsShadow()!.querySelector<HTMLButtonElement>('[data-action="retry-subtitle-translation"]')!;
        expect(retryBtn.hidden).toBe(false);

        retryBtn.click();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.captionShadow()?.querySelector('.translation')?.textContent).toBe('流媒体重试成功');
        expect(retryBtn.hidden).toBe(true);
        dispose();
    });

    it('Disney+ 无控制栏在隐藏字幕时可通过快捷键唤醒，且关闭快捷键时卸载 window 监听', async () => {
        const f = createStreamingFixture(
            'https://www.disneyplus.com/video/12345',
            `<div class="btm-media-player">
                <video></video>
                <div class="dss-hls-subtitle-overlay">Disney line.</div>
            </div>`,
        );
        f.config.videoSubtitleVisible = false;
        f.config.videoSubtitleModeHotkeyEnabled = true;
        f.config.videoSubtitleModeHotkeyAction = 'bilingual-original';

        const removed: string[] = [];
        const originalRemove = f.window.removeEventListener.bind(f.window);
        f.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
            removed.push(type);
            return originalRemove(type, listener, options);
        }) as typeof f.window.removeEventListener;
        const dispose = f.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.document.getElementById('fluent-read-platform-captions')).toBeNull();

        const wakeEvent = Object.assign(new f.window.Event('keydown', {bubbles: true, cancelable: true}), {
            key: 'm', code: 'KeyM', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false,
        });
        Object.defineProperty(wakeEvent, 'isTrusted', {value: true});
        f.window.dispatchEvent(wakeEvent);
        await vi.advanceTimersByTimeAsync(100);
        expect(f.config.videoSubtitleVisible).toBe(true);
        expect(f.captionShadow()?.querySelector('.source')?.textContent).toBe('Disney line.');

        // 关闭快捷键时立即移除 window keydown 监听
        f.config.videoSubtitleModeHotkeyEnabled = false;
        f.change();
        expect(removed).toContain('keydown');
        dispose();
    });
});
