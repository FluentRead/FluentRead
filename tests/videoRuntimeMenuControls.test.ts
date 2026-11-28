/**
 * @file tests/videoRuntimeMenuControls.test.ts
 * 文件职责：针对视频字幕运行时菜单控制器（createVideoRuntimeMenuControls）的焦点恢复、快捷键、下载/重试与 UI 状态分支提供直接单元测试。
 * 主要内容：覆盖菜单打开/关闭与工具栏/确认弹窗回退、模式切换与定时偏移调整、句学打开失败兜底、AI 字幕回放采集结束、外部点击与全局快捷键（含全屏 Escape、导出取消与说明折叠）。
 * 模块边界：通过 linkedom 与受控端口桩测试控制器本体，不加载浏览器扩展环境或真实视频网站页面。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {normalizeConfig} from '@/src/core/config/model';

const sendRuntimeMessageMock = vi.hoisted(() => vi.fn(async () => ({ok: true})));
const browserMock = vi.hoisted(() => ({
    runtime: {getURL: vi.fn((p: string) => `chrome-extension://test/${p}`)},
}));

vi.mock('webextension-polyfill', () => ({default: browserMock}));
vi.mock('@/src/platform/browser/runtimeMessages', () => ({
    sendRuntimeMessage: sendRuntimeMessageMock,
}));

import {
    createVideoRuntimeMenuControls,
    type VideoRuntimeMenuPorts,
} from '@/src/features/video-subtitle/content/runtimeMenuControls';
import {
    setVideoMenuToolsOpen,
    handleVideoMenuDisclosure,
} from '@/src/features/video-subtitle/content/playerMenu';
import {VIDEO_TRANSLATION_MENU_ID} from '@/src/features/video-subtitle/content/ui';

function installDom(url = 'https://www.youtube.com/watch?v=test123') {
    const dom = parseHTML('<!doctype html><html><body><div id="player"></div></body></html>');
    const {window, document} = dom;
    const parsedUrl = new URL(url);
    Object.defineProperty(window, 'location', {configurable: true, value: parsedUrl});
    Object.defineProperty(document, 'location', {configurable: true, value: parsedUrl});
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('location', parsedUrl);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
    vi.stubGlobal('HTMLVideoElement', window.HTMLVideoElement);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('navigator', {language: 'zh-CN', userAgent: 'Mozilla/5.0 Safari/605.1.15'});
    return {window, document, player: document.getElementById('player')!};
}

function trustedEvent<T extends Event>(event: T, extra: Record<string, unknown> = {}): T {
    Object.defineProperty(event, 'isTrusted', {configurable: true, value: true});
    for (const [k, v] of Object.entries(extra)) {
        Object.defineProperty(event, k, {configurable: true, value: v});
    }
    return event;
}

function makeClickEvent(window: Window & {Event: typeof Event}, extra: Record<string, unknown> = {}): MouseEvent {
    return trustedEvent(new window.Event('click', {bubbles: true, cancelable: true}), extra) as unknown as MouseEvent;
}

function makeKeyEvent(window: Window & {Event: typeof Event}, props: Record<string, unknown> = {}, trusted = true): KeyboardEvent {
    const ev = new window.Event('keydown', {bubbles: true, cancelable: true});
    Object.defineProperty(ev, 'isTrusted', {configurable: true, value: trusted});
    for (const [k, v] of Object.entries(props)) {
        Object.defineProperty(ev, k, {configurable: true, value: v});
    }
    return ev as unknown as KeyboardEvent;
}

function createPorts(overrides: Partial<VideoRuntimeMenuPorts> = {}): VideoRuntimeMenuPorts {
    const config = normalizeConfig({
        on: true,
        videoTranslationEnabled: true,
        videoSubtitleVisible: true,
        videoSubtitleDisplayMode: 'bilingual',
        videoSubtitleOffsetMs: 0,
        videoSubtitleModeHotkeyEnabled: true,
        videoSubtitleModeHotkey: 'custom',
        customVideoSubtitleModeHotkey: 'Alt+V',
    });
    const base: VideoRuntimeMenuPorts = {
        config,
        isDestroyed: () => false,
        isMediaSubtitlePage: () => false,
        canReadVideo: () => true,
        canTranslateVideo: () => true,
        getObservedVideo: () => null,
        getPlayerTarget: () => null,
        getPlayerBinding: () => null,
        getSubtitleOffsetMs: () => config.videoSubtitleOffsetMs,
        getPretranslationCues: () => [],
        getPretranslationTrackKey: () => '',
        getProgressiveCueText: () => '',
        readCurrentCaptionText: () => '',
        videoTranslator: {
            getFailureStatus: () => ({state: 'ok', retryAt: 0, message: ''}),
            hasFailure: () => false,
            retryFailures: vi.fn(),
        },
        reading: {
            syncMenu: vi.fn(),
            handleAction: vi.fn(() => false),
        },
        downloads: {
            cancel: vi.fn(),
            original: vi.fn(async (_menu, _btn, formatError) => {formatError(new Error('network'));}),
            translated: vi.fn(async () => undefined),
        },
        aiModelSetup: {
            choice: null,
            checking: false,
            downloading: false,
            downloadProgress: undefined,
            cancel: vi.fn(),
            reset: vi.fn(),
        },
        aiModelMenu: {
            request: vi.fn(async () => undefined),
            select: vi.fn(async () => undefined),
            choose: vi.fn(),
            finish: vi.fn(),
        },
        getAiState: () => ({
            fullActive: false,
            phase: 'idle',
            progress: {
                phase: 'idle',
                progress: 0,
                capturedMs: 0,
                durationMs: 0,
                completedChunks: 0,
                totalChunks: 0,
                captureMode: 'fast-decode',
            } as never,
            error: '',
            provider: config.videoTranscriptionProvider,
            model: 'tiny',
            cuesLength: 0,
            isRestored: false,
            isRestoring: false,
            finishPlaybackCapture: vi.fn(() => false),
        }),
        persistVideoConfig: vi.fn((patch) => {Object.assign(config, patch);}),
        stopFullAiSubtitleGeneration: vi.fn(),
        ensureNativeCaptions: vi.fn(),
        ensurePretranslationTrack: vi.fn(),
        restoreCachedAiSubtitles: vi.fn(async () => false),
        openSentenceLearning: vi.fn(async () => undefined),
        closeSentenceLearning: vi.fn(),
        resetTranslationState: vi.fn(),
        scheduleUpdate: vi.fn(),
        schedulePretranslation: vi.fn(),
        updatePlayerUiState: vi.fn(),
        syncPretranslationConfig: vi.fn(),
        scheduleXNativeCaptionSync: vi.fn(),
    };
    return {...base, ...overrides};
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sendRuntimeMessageMock.mockReset().mockResolvedValue({ok: true});
});

describe('createVideoRuntimeMenuControls 完整分支与边界', () => {
    it('覆盖菜单关闭还原、焦点归还、全局禁用状态、翻译失败回调与 Safari 全屏提示', () => {
        const {window, document, player} = installDom();
        const video = document.createElement('video') as HTMLVideoElement & {webkitSupportsFullscreen?: boolean; webkitEnterFullscreen?: () => void};
        video.webkitSupportsFullscreen = true;
        video.webkitEnterFullscreen = vi.fn();
        player.appendChild(video);

        const hasFailure = vi.fn(() => true);
        let activeText = 'Hello caption';
        const ports = createPorts({
            getObservedVideo: () => video,
            getProgressiveCueText: () => activeText,
            videoTranslator: {
                getFailureStatus: () => ({state: 'retrying', retryAt: 0, message: 'retrying'}),
                hasFailure,
                retryFailures: vi.fn(),
            },
        });
        const controls = createVideoRuntimeMenuControls(ports);
        const button = controls.createPlayerButton();
        const menu = controls.createPlayerMenu(player);
        player.appendChild(button);
        menu.hidden = false;

        // 1. 正常开启状态 + 失败探测回调执行（有文本 & 无文本）
        controls.renderPlayerUiState();
        expect(hasFailure).toHaveBeenCalledWith('Hello caption');
        activeText = '';
        controls.renderPlayerUiState();

        // 2. 全局开关关闭（config.on = false）与视频字幕隐藏（videoSubtitleVisible = false）
        ports.config.on = false;
        controls.renderPlayerUiState();
        ports.config.on = true;
        ports.config.videoSubtitleVisible = false;
        controls.renderPlayerUiState();
        ports.config.videoSubtitleVisible = true;

        // 3. 移除 learningButton 与 button 元素，验证缺失分支
        menu.querySelector('[data-action="open-sentence-learning"]')?.remove();
        controls.clearElements();
        button.remove();
        controls.renderPlayerUiState();

        // 4. 恢复 button，打开模型确认弹窗 + closeMenu，再打开 tools 面板 + 菜单内焦点 + closeMenu
        player.appendChild(button);
        const focusSpy = vi.spyOn(button, 'focus').mockImplementation(() => undefined);
        controls.renderPlayerUiState();
        const mediaPorts = createPorts({isMediaSubtitlePage: () => true});
        const mediaControls = createVideoRuntimeMenuControls(mediaPorts);
        const mediaMenu = mediaControls.createPlayerMenu(player);
        mediaMenu.hidden = false;
        mediaMenu.dataset.view = 'model-prompt';
        mediaControls.closeMenu();
        mediaMenu.hidden = false;
        mediaMenu.dataset.view = 'main';
        setVideoMenuToolsOpen(mediaMenu, true);
        expect(mediaMenu.dataset.panel).toBe('tools');
        mediaControls.closeMenu();
        mediaMenu.remove();

        menu.hidden = false;
        const innerBtn = menu.querySelector('button')!;
        Object.defineProperty(document, 'activeElement', {configurable: true, value: innerBtn});
        controls.closeMenu();
        expect(menu.hidden).toBe(true);
        expect(focusSpy).toHaveBeenCalled();

        // 5. handleButtonClick 在找不到菜单时安全退出，以及 close-only 视口态聚焦关闭按钮
        menu.remove();
        controls.clearElements();
        button.dispatchEvent(makeClickEvent(window));

        player.appendChild(menu);
        menu.id = VIDEO_TRANSLATION_MENU_ID;
        menu.hidden = true;
        menu.dataset.viewportState = 'close-only';
        button.dispatchEvent(makeClickEvent(window));
        expect(menu.hidden).toBe(false);
    });

    it('覆盖模式切换、菜单点击全部分支、下载制备拦截、重试、回放采集与设置跳转', async () => {
        const {window, document, player} = installDom();
        const finishPlaybackCapture = vi.fn(() => true);
        let aiActive = true;
        let aiPhase: ReturnType<VideoRuntimeMenuPorts['getAiState']>['phase'] = 'capturing';
        let readable = false;
        const ports = createPorts({
            canReadVideo: () => readable,
            getAiState: () => ({
                fullActive: aiActive,
                phase: aiPhase,
                progress: {
                    phase: aiPhase,
                    progress: 0.5,
                    capturedMs: 5000,
                    durationMs: 10000,
                    completedChunks: 1,
                    totalChunks: 2,
                    captureMode: 'playback',
                } as never,
                error: '',
                provider: normalizeConfig({}).videoTranscriptionProvider,
                model: 'tiny',
                cuesLength: 0,
                isRestored: false,
                isRestoring: false,
                finishPlaybackCapture,
            }),
            openSentenceLearning: vi.fn(async () => {throw new Error('boom');}),
        });
        const controls = createVideoRuntimeMenuControls(ports);
        const button = controls.createPlayerButton();
        const menu = controls.createPlayerMenu(player);
        player.appendChild(button);
        menu.hidden = false;

        // selectMenuMode('off') 在 AI 活跃时停止采集；再从 videoTranslationEnabled=false 切到 bilingual
        controls.selectMenuMode('off');
        expect(ports.stopFullAiSubtitleGeneration).toHaveBeenCalled();
        ports.config.videoTranslationEnabled = false;
        controls.selectMenuMode('bilingual');
        expect(ports.ensureNativeCaptions).toHaveBeenCalled();
        expect(ports.restoreCachedAiSubtitles).toHaveBeenCalled();

        const clickAction = async (action: string, extraAttrs: Record<string, string> = {}) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.action = action;
            for (const [k, v] of Object.entries(extraAttrs)) btn.setAttribute(k, v);
            menu.appendChild(btn);
            btn.dispatchEvent(makeClickEvent(window));
            await Promise.resolve();
            await Promise.resolve();
            btn.remove();
        };

        // 不可信点击与菜单元素清空后的点击均安全忽略
        menu.dispatchEvent(new window.Event('click', {bubbles: true}));
        controls.clearElements();
        menu.dispatchEvent(makeClickEvent(window));
        controls.renderPlayerUiState();

        // 下载折叠按钮（handleVideoMenuDisclosure 返回 true）
        const disclosureBtn = menu.querySelector<HTMLElement>('[data-action="toggle-subtitle-downloads"]');
        if (disclosureBtn) {
            disclosureBtn.dispatchEvent(makeClickEvent(window));
        }

        // AI 采集未 ready 时下载被拦截
        await clickAction('download-subtitles');
        expect(ports.downloads.original).not.toHaveBeenCalled();

        // close-subtitle-tools 时隐藏 open-subtitle-tools -> 回退聚焦当前 mode
        menu.querySelectorAll<HTMLElement>('[data-action="open-subtitle-tools"]').forEach(el => {el.hidden = true;});
        await clickAction('close-subtitle-tools');

        // 校时：提前、延后、重置
        await clickAction('subtitle-earlier');
        expect(ports.config.videoSubtitleOffsetMs).toBe(-500);
        await clickAction('subtitle-later');
        expect(ports.config.videoSubtitleOffsetMs).toBe(0);
        await clickAction('reset-subtitle-timing');
        expect(ports.config.videoSubtitleOffsetMs).toBe(0);

        // open-sentence-learning 在不可读时自动切双语，且 reject 时兜底 closeSentenceLearning
        readable = false;
        await clickAction('open-sentence-learning');
        expect(ports.closeSentenceLearning).toHaveBeenCalled();

        // retry-subtitle-translation
        await clickAction('retry-subtitle-translation');
        expect(ports.videoTranslator.retryFailures).toHaveBeenCalled();

        // toggle-ai-subtitle 在回放采集模式下优先 finishPlaybackCapture
        await clickAction('toggle-ai-subtitle');
        expect(finishPlaybackCapture).toHaveBeenCalled();

        // ready 后测试下载原文（含错误格式化回调）、open-settings（含 sendRuntimeMessage reject 兜底）及未知 action
        aiPhase = 'ready';
        aiActive = false;
        await clickAction('download-subtitles');
        expect(ports.downloads.original).toHaveBeenCalled();

        sendRuntimeMessageMock.mockRejectedValueOnce(new Error('closed'));
        await clickAction('open-settings');
        expect(sendRuntimeMessageMock).toHaveBeenCalledWith({type: 'openOptionsPage', section: 'settings-video'});

        await clickAction('unknown-noop-action');
    });

    it('覆盖外部点击关闭与全局快捷键 / Escape 分层退出', () => {
        const {window, document, player} = installDom();
        const video = document.createElement('video');
        player.appendChild(video);
        let destroyed = false;
        let hasVideo = true;
        let hasTarget = true;
        const ports = createPorts({
            isDestroyed: () => destroyed,
            getObservedVideo: () => (hasVideo ? video : null),
            getPlayerTarget: () => (hasTarget ? {player, host: player} as never : null),
        });
        const controls = createVideoRuntimeMenuControls(ports);
        const button = controls.createPlayerButton();
        const menu = controls.createPlayerMenu(player);
        player.appendChild(button);

        // handleDocumentClick: 菜单隐藏时返回；展开后点外部关闭
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        menu.hidden = true;
        controls.handleDocumentClick(makeClickEvent(window, {target: outside}));
        menu.hidden = false;
        controls.handleDocumentClick(makeClickEvent(window, {target: outside}));
        expect(menu.hidden).toBe(true);

        // handleDocumentKeydown: 不可信事件返回
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}, false));

        // 快捷键切换模式（Alt+V）：测试 isActive 各短路操作数与命中分支
        const shortcutEvent = () => makeKeyEvent(window, {
            key: 'v', code: 'KeyV', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, target: document.body,
        });

        destroyed = true;
        controls.handleDocumentKeydown(shortcutEvent());
        destroyed = false;
        ports.config.on = false;
        controls.handleDocumentKeydown(shortcutEvent());
        ports.config.on = true;
        ports.config.videoTranslationEnabled = false;
        controls.handleDocumentKeydown(shortcutEvent());
        ports.config.videoTranslationEnabled = true;
        hasVideo = false;
        hasTarget = false;
        controls.handleDocumentKeydown(shortcutEvent());
        hasTarget = true;
        controls.handleDocumentKeydown(shortcutEvent());
        hasVideo = true;
        controls.handleDocumentKeydown(shortcutEvent());

        // 非 Escape 或隐藏菜单直接返回
        menu.hidden = true;
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));
        menu.hidden = false;
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Enter'}));

        // Escape: export-prompt -> 取消下载
        menu.dataset.view = 'export-prompt';
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));
        expect(ports.downloads.cancel).toHaveBeenCalled();

        // Escape: main + 打开的 disclosure -> 关闭 disclosure
        menu.dataset.view = 'main';
        menu.dataset.panel = 'main';
        handleVideoMenuDisclosure(menu, 'toggle-subtitle-downloads');
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));

        // Escape: 全屏下 tools 面板（媒体页菜单：有可见 open-subtitle-tools 与隐藏 open-subtitle-tools 两种情况）
        const mediaControls = createVideoRuntimeMenuControls(createPorts({isMediaSubtitlePage: () => true}));
        const mediaMenu = mediaControls.createPlayerMenu(player);
        mediaMenu.hidden = false;
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: player});
        setVideoMenuToolsOpen(mediaMenu, true);
        expect(mediaMenu.dataset.panel).toBe('tools');
        const openToolsBtn = mediaMenu.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]');
        if (openToolsBtn) openToolsBtn.hidden = false;
        mediaControls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));
        expect(mediaMenu.dataset.panel).not.toBe('tools');

        setVideoMenuToolsOpen(mediaMenu, true);
        if (openToolsBtn) openToolsBtn.hidden = true;
        mediaControls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));
        mediaMenu.remove();
        Object.defineProperty(document, 'fullscreenElement', {configurable: true, value: null});

        // Escape: 普通主菜单 -> 关闭菜单并聚焦按钮
        menu.dataset.panel = 'main';
        controls.handleDocumentKeydown(makeKeyEvent(window, {key: 'Escape'}));
        expect(menu.hidden).toBe(true);
    });
});
