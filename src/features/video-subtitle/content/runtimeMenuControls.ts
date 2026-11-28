/**
 * @file src/features/video-subtitle/content/runtimeMenuControls.ts
 * 文件职责：封装视频字幕播放器入口按钮与弹出菜单的创建、渲染同步、交互分发、快捷键响应与焦点恢复逻辑。
 * 主要内容：统一管理菜单展开/收起、字幕显示模式与双语顺序切换、校时偏移调整、AI 识别/模型选择/字幕下载入口转发，以及文档点击与 Escape 逐层关闭事件处理。
 * 模块边界：仅操作视频字幕按钮与菜单 DOM 并通过注入端口回调运行时状态，不直接持有字幕时间轴、音频采集或翻译请求队列。
 */
import browser from 'webextension-polyfill';
import {hasUiLanguageBundle, type UiLanguage} from '@/src/core/i18n';
import {normalizeVideoSubtitleOffsetMs, type Config} from '@/src/core/config/model';
import {
    normalizeVideoSubtitleModeHotkeyAction,
    resolveNextVideoSubtitleMenuMode,
    videoSubtitleModeHotkeyDisplayName,
} from '@/src/core/config/videoSubtitleShortcut';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getFullscreenElement} from '@/src/platform/dom/fullscreen';
import {sendRuntimeMessage} from '@/src/platform/browser/runtimeMessages';
import {VIDEO_LOCAL_TRANSCRIPTION_MODELS} from '@/src/features/video-subtitle/transcription';
import {resolveVideoTranslationUiStatus} from './captionClock';
import {supportsSafariNativeVideoFullscreen} from './nativeFullscreen';
import {getVideoServiceLabel} from './serviceProfile';
import type {ActiveVideoSubtitleModeController} from './activeModeController';
import {
    handleVideoSubtitleModeShortcutKeydown,
    notifyVideoSubtitleModeSwitch,
    videoSubtitleModeLabelKey,
    type VideoSubtitleModeShortcutPorts,
} from './modeShortcut';
import {
    createVideoPlayerMenu,
    isVideoModelPromptOpen,
    renderVideoAiMenu,
    renderVideoAiModelSelection,
    renderVideoMenuMode,
    renderVideoMenuModeShortcut,
    renderVideoSubtitleOrder,
    renderVideoModelPrompt,
    renderVideoSubtitleTiming,
    renderVideoSourceStatus,
    renderVideoTranslationStatus,
    handleVideoMenuNavigation,
    handleVideoMenuDisclosure,
    closeVideoMenuDisclosure,
    resetVideoMenuDisclosures,
    setVideoMenuToolsOpen,
    setVideoMenuDownloadStatus,
    syncVideoPlayerMenuLayout,
    revealVideoMenuBodyControl,
    type VideoMenuMode,
} from './playerMenu';
import {
    VIDEO_TRANSLATION_ACTIVE_CLASS,
    VIDEO_TRANSLATION_BUTTON_ID,
    VIDEO_TRANSLATION_MENU_ID,
    findCaptionContainer,
    getVideoSubtitleDownloadErrorMessage,
    getVideoUiLanguage,
    isSupportedVideoPage,
    isXVideoPage,
    isYouTubeVideoPage,
    localizeVideoUiText,
    markVideoUi,
    normalizeVideoSubtitleDisplayMode,
    refreshVideoUiAccessibility,
    refreshVideoUiText,
    syncTranslationOverlayPosition,
    videoUi,
} from './ui';
import {isXNativeCaptionControl} from './xCaptionSource';
import type {VideoAiFullCapturePhase, VideoAiFullCaptureProgress} from './video-ai/fullCapture';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
import type {VideoTranslationCache} from './translationCache';
import type {VideoPlayerBinding} from './videoPlayerBinding';
import type {VideoAiModelSetup} from './video-ai/modelSetup';

export interface VideoRuntimeMenuPorts {
    config: Config;
    isDestroyed: () => boolean;
    isMediaSubtitlePage: () => boolean;
    canReadVideo: () => boolean;
    canTranslateVideo: () => boolean;
    getObservedVideo: () => HTMLMediaElement | null;
    getPlayerTarget: () => {player: HTMLElement; video: HTMLMediaElement} | null;
    getPlayerBinding: () => VideoPlayerBinding | null;
    getSubtitleOffsetMs: () => number;
    getPretranslationCues: () => readonly VideoSubtitleCue[];
    getPretranslationTrackKey: () => string;
    getProgressiveCueText: () => string;
    readCurrentCaptionText: (container: Element | null) => string;
    videoTranslator: Pick<VideoTranslationCache, 'getFailureStatus' | 'hasFailure' | 'retryFailures'>;
    reading: {
        syncMenu(menu: HTMLElement, enabled: boolean, selectedMode: VideoMenuMode): void;
        handleAction(action: string | undefined): boolean;
    };
    downloads: {
        cancel(): void;
        original(menu: HTMLElement, button: HTMLButtonElement, formatError: (error: unknown) => string): Promise<void>;
        translated(menu: HTMLElement, button: HTMLButtonElement, bilingual: boolean): Promise<void>;
    };
    aiModelSetup: Pick<VideoAiModelSetup, 'cancel' | 'reset' | 'choice' | 'checking' | 'downloading' | 'downloadProgress'>;
    aiModelMenu: {
        request(menu: HTMLElement, regenerate?: boolean): Promise<void>;
        select(menu: HTMLElement): Promise<void>;
        choose(menu: HTMLElement, choice: string): void;
        finish(menu: HTMLElement, confirm: boolean): void;
    };
    getAiState: () => {
        fullActive: boolean;
        phase: VideoAiFullCapturePhase;
        progress: VideoAiFullCaptureProgress;
        error: string;
        cuesLength: number;
        provider: Config['videoTranscriptionProvider'];
        model: ReturnType<typeof import('@/src/features/video-subtitle/transcription').normalizeVideoLocalTranscriptionModel>;
        isRestored: boolean;
        isRestoring: boolean;
        finishPlaybackCapture: () => boolean;
    };
    persistVideoConfig: (patch: Partial<Config>) => void;
    ensureNativeCaptions: () => void;
    ensurePretranslationTrack: () => void;
    restoreCachedAiSubtitles: () => Promise<unknown>;
    stopFullAiSubtitleGeneration: () => void;
    openSentenceLearning: () => Promise<void>;
    closeSentenceLearning: () => void;
    resetTranslationState: () => void;
    scheduleUpdate: () => void;
    schedulePretranslation: () => void;
    syncPretranslationConfig: () => void;
    scheduleXNativeCaptionSync: () => void;
    updatePlayerUiState: () => void;
}

export interface VideoRuntimeMenuControls {
    getMenuElement(): HTMLElement | null;
    clearElements(): void;
    closeMenu(): void;
    renderPlayerUiState(): void;
    selectMenuMode(mode: VideoMenuMode): void;
    createActiveModeController(): ActiveVideoSubtitleModeController;
    createPlayerMenu(player: HTMLElement): HTMLElement;
    createPlayerButton(): HTMLButtonElement;
    handleDocumentClick(event: MouseEvent): void;
    handleDocumentKeydown(event: KeyboardEvent): void;
}

export function createVideoRuntimeMenuControls(ports: VideoRuntimeMenuPorts): VideoRuntimeMenuControls {
    const {config} = ports;
    let menuElement: HTMLElement | null = null;
    let buttonElement: HTMLButtonElement | null = null;
    // 语言资源包可能在配置广播后才到达，加载完成时仍需刷新既有菜单。
    const menuTextLocale = (language: UiLanguage) => `${language}:${hasUiLanguageBundle(language)}`;
    let renderedMenuTextLocale = '';

    const closeMenu = () => {
        const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
        const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
        const heldFocus = menu?.contains(document.activeElement);
        // 先隐藏，再取消可能同步刷新菜单的确认与导出。
        if (menu) menu.hidden = true;
        ports.aiModelSetup.cancel();
        ports.downloads.cancel();
        if (menu) {
            if (isVideoModelPromptOpen(menu)) renderVideoModelPrompt(menu, null, getVideoUiLanguage(config.uiLanguage));
            if (menu.dataset.panel === 'tools') setVideoMenuToolsOpen(menu, false);
            else resetVideoMenuDisclosures(menu);
        }
        button?.setAttribute('aria-expanded', 'false');
        if (heldFocus && button?.isConnected) button.focus({preventScroll: true});
        syncTranslationOverlayPosition(findCaptionContainer());
    };

    const renderPlayerUiState = () => {
        const button = buttonElement?.isConnected ? buttonElement : document.getElementById(VIDEO_TRANSLATION_BUTTON_ID);
        const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
        // X 控制栏收起后入口按钮会卸载，但已打开的菜单仍可操作；
        // 菜单状态不能依赖入口按钮在场，否则功能已生效却仍显示旧状态。
        if (!(menu instanceof HTMLElement)) return;
        if (button instanceof HTMLButtonElement) buttonElement = button;
        menuElement = menu;

        const enabled = config.on && config.videoTranslationEnabled;
        const visible = config.videoSubtitleVisible !== false;
        const selectedMode: VideoMenuMode = enabled && visible ? normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) : 'off';
        const activeShortcut = config.videoSubtitleModeHotkeyEnabled === true
            ? videoSubtitleModeHotkeyDisplayName(config.videoSubtitleModeHotkey, config.customVideoSubtitleModeHotkey)
            : '';
        const modeLabel = videoUi(videoSubtitleModeLabelKey(selectedMode));
        const status = config.on
            ? (enabled && visible
                ? `${videoUi('video.enabled')} · ${modeLabel}${activeShortcut ? ` · ${activeShortcut}` : ''}`
                : videoUi('video.disabled'))
            : videoUi('video.globalDisabled');
        button?.classList.toggle(VIDEO_TRANSLATION_ACTIVE_CLASS, enabled && visible);
        // 入口只开关菜单；清理复用节点上的旧 toggle 语义，不把字幕状态冒充点击动作。
        button?.removeAttribute('aria-pressed');
        const expanded = String(!menu.hidden);
        if (button && button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);

        const language = getVideoUiLanguage(config.uiLanguage);
        const failureStatus = ports.videoTranslator.getFailureStatus();
        let cachedActiveCaptionText: string | undefined;
        const readActiveCaptionText = () => cachedActiveCaptionText ??= ports.getProgressiveCueText() || ports.readCurrentCaptionText(findCaptionContainer());
        const translationStatus = resolveVideoTranslationUiStatus(
            enabled && visible && ports.canTranslateVideo(), failureStatus,
            () => { const text = readActiveCaptionText(); return Boolean(text) && ports.videoTranslator.hasFailure(text); },
        );
        refreshVideoUiAccessibility(menu.hidden ? null : menu, button, document, language, status);
        if (menu.hidden) { renderVideoTranslationStatus(null, button, translationStatus, language); return; }
        const textLocale = menuTextLocale(language);
        if (renderedMenuTextLocale !== textLocale) {
            refreshVideoUiText(menu, language);
            renderedMenuTextLocale = textLocale;
        }
        const choice = ports.aiModelSetup.choice;
        renderVideoModelPrompt(menu, choice && {options: VIDEO_LOCAL_TRANSCRIPTION_MODELS, ...choice}, language);
        renderVideoMenuMode(menu, selectedMode, !config.on, status);
        renderVideoMenuModeShortcut(menu, activeShortcut || null, language);
        renderVideoSubtitleOrder(menu, config.videoSubtitleAppearance.bilingualOrder, !enabled || !visible, selectedMode === 'bilingual');
        const service = menu.querySelector<HTMLElement>('[data-service-label]');
        const serviceLabel = localizeVideoUiText(getVideoServiceLabel(config.videoService || config.service), language);
        if (service && service.textContent !== serviceLabel) service.textContent = serviceLabel;
        ports.reading.syncMenu(menu, enabled, selectedMode);
        const ai = ports.getAiState();
        const learningButton = menu.querySelector<HTMLButtonElement>('[data-action="open-sentence-learning"]');
        if (learningButton) {
            learningButton.disabled = ai.fullActive && ai.phase !== 'ready' && ai.progress.captureMode !== 'playback';
            learningButton.title = learningButton.disabled ? videoUi('video.sourcePreparing') : videoUi('video.learning.title');
        }
        const cues = ports.getPretranslationCues();
        renderVideoSubtitleTiming(menu, ports.getSubtitleOffsetMs(), enabled && visible && cues.length > 0, language);
        renderVideoAiMenu(menu, {
            available: ports.isMediaSubtitlePage() && browserCapabilities.extensionDom,
            checking: ports.aiModelSetup.checking,
            downloading: ports.aiModelSetup.downloading,
            downloadProgress: ports.aiModelSetup.downloadProgress,
            active: ai.fullActive,
            fullActive: ai.fullActive,
            phase: ai.phase,
            progress: ai.progress,
            error: ai.error,
        }, language);
        const canChooseAiModel = enabled && visible && ports.isMediaSubtitlePage() && browserCapabilities.extensionDom && ai.provider !== 'native-qwen';
        renderVideoAiModelSelection(menu, {
            model: ai.model,
            available: canChooseAiModel,
            disabled: ports.aiModelSetup.checking || ports.aiModelSetup.downloading
                || (ai.fullActive && ai.phase !== 'ready'),
        }, language);
        if (ports.isMediaSubtitlePage()) {
            const source = ai.fullActive && ai.cuesLength > 0 ? (ai.isRestored ? 'cache' : 'ai')
                : ports.getPretranslationTrackKey().startsWith('x:') && cues.length > 0 ? 'native' : 'none';
            renderVideoSourceStatus(menu, {
                enabled: enabled && visible,
                source,
                cueCount: source === 'none' ? 0 : cues.length,
                checking: ai.isRestoring,
                generating: ai.fullActive && ai.phase !== 'ready',
                translationFailed: ports.canTranslateVideo() && (ports.videoTranslator.hasFailure(readActiveCaptionText()) || failureStatus.state === 'permanent' || failureStatus.state === 'cooldown'),
                canRegenerate: enabled && visible && ai.cuesLength > 0 && ai.phase === 'ready',
                canChooseModel: canChooseAiModel,
            }, language);
            renderVideoTranslationStatus(null, button, translationStatus, language);
        } else {
            renderVideoTranslationStatus(menu, button, translationStatus, language);
        }
        const nativeHint = menu.querySelector<HTMLElement>('[data-native-fullscreen-hint]');
        if (nativeHint) nativeHint.hidden = !isYouTubeVideoPage() || !supportsSafariNativeVideoFullscreen(ports.getObservedVideo() as HTMLVideoElement | null) || !enabled || !visible;
        syncVideoPlayerMenuLayout(menu);
    };

    const selectMenuMode = (mode: VideoMenuMode) => {
        if (mode === 'off') {
            if (config.videoSubtitleVisible === false) return;
            // 菜单只关闭字幕显示；功能总开关留给设置中心，保留再次开启字幕的入口。
            ports.persistVideoConfig({videoSubtitleVisible: false});
            ports.downloads.cancel();
            ports.aiModelSetup.reset();
            const ai = ports.getAiState();
            if (ai.fullActive && ai.phase !== 'ready') {
                ports.stopFullAiSubtitleGeneration();
            }
            return;
        }
        const wasEnabled = config.videoTranslationEnabled;
        // 弹出式菜单不再单独提供“显示字幕”开关；选择任一显示方式即恢复可见。
        ports.persistVideoConfig({
            videoSubtitleDisplayMode: normalizeVideoSubtitleDisplayMode(mode),
            ...(wasEnabled ? {} : {videoTranslationEnabled: true}),
            ...(config.videoSubtitleVisible === false ? {videoSubtitleVisible: true} : {}),
        });
        if (!wasEnabled) { ports.ensureNativeCaptions(); void ports.restoreCachedAiSubtitles(); }
    };

    const handleMenuClick = async (event: MouseEvent) => {
        if (!event.isTrusted) return;
        const menu = menuElement;
        if (!menu || !(event.target instanceof Element)) return;
        const target = event.target.closest<HTMLElement>('[data-action], [data-mode], [data-model-choice], [data-subtitle-order]');
        if (!target || !menu.contains(target) || (target instanceof HTMLButtonElement && target.disabled)) return;

        event.preventDefault();
        event.stopPropagation();

        if (handleVideoMenuDisclosure(menu, target.dataset.action)) return;
        if (target.dataset.action === 'show-reading-original') { selectMenuMode('bilingual'); return; }
        if (ports.reading.handleAction(target.dataset.action)) return;

        const ai = ports.getAiState();
        if (target.dataset.action?.startsWith('download-') && ai.fullActive && ai.phase !== 'ready') {
            setVideoMenuDownloadStatus(menu, videoUi('video.sourcePreparing'), 2400);
            return;
        }

        if (target.dataset.action === 'open-subtitle-tools' || target.dataset.action === 'close-subtitle-tools') {
            const open = target.dataset.action === 'open-subtitle-tools';
            setVideoMenuToolsOpen(menu, open);
            const destination = menu.querySelector<HTMLButtonElement>(open ? '[data-action="close-subtitle-tools"]' : '[data-action="open-subtitle-tools"]');
            if (destination && !destination.hidden) destination.focus();
            else menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
            return;
        }
        if (['subtitle-earlier', 'subtitle-later', 'reset-subtitle-timing'].includes(target.dataset.action || '')) {
            const nextOffset = target.dataset.action === 'reset-subtitle-timing' ? 0
                : normalizeVideoSubtitleOffsetMs(config.videoSubtitleOffsetMs) + (target.dataset.action === 'subtitle-earlier' ? -500 : 500);
            ports.persistVideoConfig({videoSubtitleOffsetMs: normalizeVideoSubtitleOffsetMs(nextOffset)});
            return;
        }
        if (target.dataset.subtitleOrder === 'original-first' || target.dataset.subtitleOrder === 'translation-first') {
            ports.persistVideoConfig({videoSubtitleAppearance: {...config.videoSubtitleAppearance, bilingualOrder: target.dataset.subtitleOrder}});
            return;
        }
        if (target.dataset.mode) {
            selectMenuMode(target.dataset.mode as VideoMenuMode);
            return;
        }
        if (target.dataset.action === 'open-sentence-learning') {
            if (!ports.canReadVideo()) selectMenuMode('bilingual');
            ports.ensureNativeCaptions();
            ports.ensurePretranslationTrack();
            closeMenu();
            void ports.openSentenceLearning().catch(() => ports.closeSentenceLearning());
            return;
        }
        if (target.dataset.action === 'close-menu') {
            closeMenu();
            buttonElement?.focus({preventScroll: true});
            return;
        }
        if (target.dataset.action === 'retry-subtitle-translation') {
            ports.videoTranslator.retryFailures();
            ports.resetTranslationState();
            ports.scheduleUpdate();
            ports.schedulePretranslation();
            ports.updatePlayerUiState();
            return;
        }
        if (target.dataset.action === 'regenerate-ai-subtitle') {
            await ports.aiModelMenu.request(menu, true);
            ports.updatePlayerUiState();
            return;
        }
        if (target.dataset.action === 'select-ai-model') {
            await ports.aiModelMenu.select(menu);
            ports.updatePlayerUiState();
            return;
        }
        if (target.dataset.action === 'toggle-ai-subtitle') {
            if (ai.fullActive) {
                if (ai.finishPlaybackCapture()) { ports.updatePlayerUiState(); return; }
                ports.stopFullAiSubtitleGeneration();
                setVideoMenuToolsOpen(menu, false);
                menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
            } else {
                // 识别失败后的“重试”应重跑识别，不能悄悄恢复上一版缓存。
                await ports.aiModelMenu.request(menu, ai.phase === 'error');
            }
            ports.updatePlayerUiState();
            return;
        }
        if (target.dataset.modelChoice) {
            ports.aiModelMenu.choose(menu, target.dataset.modelChoice);
            return;
        }
        if (target.dataset.action === 'model-prompt-cancel' || target.dataset.action === 'model-prompt-confirm') {
            ports.aiModelMenu.finish(menu, target.dataset.action === 'model-prompt-confirm');
            return;
        }
        if (target.dataset.action === 'download-subtitles') {
            await ports.downloads.original(menu, target as HTMLButtonElement,
                error => getVideoSubtitleDownloadErrorMessage(error, getVideoUiLanguage(config.uiLanguage)));
            return;
        }
        if (target.dataset.action === 'download-translated-subtitles' || target.dataset.action === 'download-bilingual-subtitles') {
            ports.syncPretranslationConfig();
            await ports.downloads.translated(menu, target as HTMLButtonElement, target.dataset.action === 'download-bilingual-subtitles');
            return;
        }
        if (target.dataset.action === 'open-settings') {
            closeMenu();
            void sendRuntimeMessage({type: 'openOptionsPage', section: 'settings-video'}).catch(() => undefined);
        }
    };

    const bindMenuClick = (menu: HTMLElement) => {
        menu.dataset.fluentReadClickBound = 'true';
        menu.addEventListener('click', handleMenuClick);
        menu.addEventListener('keydown', handleVideoMenuNavigation);
    };

    const createPlayerMenu = (player: HTMLElement): HTMLElement => {
        const language = getVideoUiLanguage(config.uiLanguage);
        const menu = createVideoPlayerMenu(language, ports.isMediaSubtitlePage());
        renderedMenuTextLocale = '';
        player.appendChild(menu);
        bindMenuClick(menu);
        menuElement = menu;
        return menu;
    };

    const handleButtonClick = (event: MouseEvent) => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        const menu = menuElement?.isConnected ? menuElement : document.getElementById(VIDEO_TRANSLATION_MENU_ID);
        if (!(menu instanceof HTMLElement)) return;
        menuElement = menu;
        if (!menu.hidden) {
            closeMenu();
            return;
        }
        menu.hidden = false;
        ports.getPlayerBinding()?.syncMenuHost();
        renderPlayerUiState();
        syncTranslationOverlayPosition(findCaptionContainer());
        // 新一次打开回到主要操作；只重置自有正文，不滚动网页，状态刷新/旋转保留原位置。
        const body = menu.querySelector<HTMLElement>('.fluent-read-video-menu-body');
        if (body) body.scrollTop = 0;
        // 这是用户明确打开菜单的初始焦点；极矮态不能把焦点交给已隔离的正文。
        const initialFocus = menu.dataset.viewportState === 'close-only' ? '[data-action="close-menu"]' : '[data-mode][aria-checked="true"]';
        const control = menu.querySelector<HTMLButtonElement>(initialFocus);
        control?.focus({preventScroll: true});
        revealVideoMenuBodyControl(menu, control);
    };

    const bindButtonClick = (button: HTMLButtonElement) => {
        button.dataset.fluentReadClickBound = 'true';
        button.addEventListener('click', handleButtonClick);
    };

    const createPlayerButton = (): HTMLButtonElement => {
        const button = document.createElement('button');
        button.id = VIDEO_TRANSLATION_BUTTON_ID;
        button.className = 'ytp-button fluent-read-video-subtitle-button fluent-read-video-ui notranslate';
        button.type = 'button';
        button.setAttribute('role', 'button');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-controls', VIDEO_TRANSLATION_MENU_ID);
        const initialLabel = videoUi('video.buttonAriaLabel', {status: videoUi('video.disabled')});
        button.setAttribute('aria-label', initialLabel);
        button.title = initialLabel;
        const icon = document.createElement('img');
        icon.className = 'fluent-read-video-subtitle-button-icon';
        icon.src = browser.runtime.getURL('icon/128.png');
        icon.alt = '';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        markVideoUi(button);
        bindButtonClick(button);
        button.classList.toggle('fluent-read-video-subtitle-x-button', ports.isMediaSubtitlePage());
        buttonElement = button;
        return button;
    };

    const handleDocumentClick = (event: MouseEvent) => {
        const target = event.target;
        if (isXVideoPage() && target instanceof Element) {
            const player = ports.getPlayerTarget()?.player, control = target.closest('button, [role="button"]');
            if (player && control && player.contains(control) && isXNativeCaptionControl(control)) ports.scheduleXNativeCaptionSync();
        }
        if (!event.isTrusted) return;
        if (!menuElement?.isConnected || menuElement.hidden || !(target instanceof Node)) return;
        if (buttonElement?.contains(target) || menuElement.contains(target)) return;
        closeMenu();
    };

    const notifyModeSwitch = (mode: VideoMenuMode) => notifyVideoSubtitleModeSwitch(
        mode,
        videoUi,
        config.videoSubtitleModeHotkeyEnabled === true
            ? videoSubtitleModeHotkeyDisplayName(config.videoSubtitleModeHotkey, config.customVideoSubtitleModeHotkey)
            : undefined,
    );

    const shortcutPorts: VideoSubtitleModeShortcutPorts = {
        document,
        config,
        isActive: () => !ports.isDestroyed() && config.on && config.videoTranslationEnabled && isSupportedVideoPage()
            && Boolean(ports.getPlayerTarget() || ports.getObservedVideo()?.isConnected),
        isVisible: () => config.videoSubtitleVisible !== false,
        applyMode: selectMenuMode,
        notify: notifyModeSwitch,
    };

    const createActiveModeController = (): ActiveVideoSubtitleModeController => ({
        isActive: shortcutPorts.isActive,
        getCurrentMode: () => (shortcutPorts.isVisible() ? normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode) : 'off'),
        switchMode: () => {
            if (!shortcutPorts.isActive()) return null;
            const nextMode = resolveNextVideoSubtitleMenuMode(
                normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode),
                shortcutPorts.isVisible(),
                normalizeVideoSubtitleModeHotkeyAction(config.videoSubtitleModeHotkeyAction),
            );
            selectMenuMode(nextMode);
            notifyModeSwitch(nextMode);
            return nextMode;
        },
    });

    const handleDocumentKeydown = (event: KeyboardEvent) => {
        if (!event.isTrusted) return;
        if (config.videoSubtitleModeHotkeyEnabled === true
            && handleVideoSubtitleModeShortcutKeydown(event, shortcutPorts)) return;
        if (event.key !== 'Escape' || !menuElement || menuElement.hidden) return;
        // 全屏 Escape 属于浏览器；菜单可以同时收尾，但不能阻止退出全屏。
        if (!getFullscreenElement(document)) event.preventDefault();
        event.stopPropagation();
        // 导出/模型确认先退回原菜单，再按一次才关闭整个菜单。
        if (menuElement.dataset.view === 'export-prompt') { ports.downloads.cancel(); return; }
        if (menuElement.dataset.view === 'main' && closeVideoMenuDisclosure(menuElement)) return;
        if (menuElement && !menuElement.hidden && isVideoModelPromptOpen(menuElement)) {
            ports.aiModelMenu.finish(menuElement, false);
        } else if (menuElement.dataset.panel === 'tools') {
            setVideoMenuToolsOpen(menuElement, false);
            const destination = menuElement.querySelector<HTMLButtonElement>('[data-action="open-subtitle-tools"]');
            if (destination && !destination.hidden) destination.focus();
            else menuElement.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
        } else { closeMenu(); buttonElement?.focus({preventScroll: true}); }
    };

    return {
        getMenuElement: () => menuElement,
        clearElements: () => { buttonElement = null; menuElement = null; },
        closeMenu,
        renderPlayerUiState,
        selectMenuMode,
        createActiveModeController,
        createPlayerMenu,
        createPlayerButton,
        handleDocumentClick,
        handleDocumentKeydown,
    };
}
