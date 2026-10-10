/**
 * @file src/features/video-subtitle/content/playerMenu.ts
 * 文件职责：组装播放器字幕菜单，以紧凑行呈现显示方式、字幕时间、本地 AI 字幕与下载操作，并在同一弹层内提供模型下载确认。
 * 主要内容：X 首层聚焦显示方式和当前需要的操作，模型选择、校时、导出和重新识别放在可返回的选项页；复用稳定节点呈现字幕来源、故障恢复、实际音频读取及并行识别进度、模型下载进度和模型确认，生成预览期间不开放完整字幕导出。
 * 模块边界：只操作 FluentRead 自己的菜单节点，不读取存储、不发起识别或绑定全局事件；运行时负责配置、请求与清理。
 */
import type {VideoSubtitleDisplayMode} from '@/src/core/config/model';
import {
    createTextElement, markVideoUi, translateVideoUi, localizeVideoUiText,
    VIDEO_TRANSLATION_MENU_ID, type UiLanguage,
} from './ui';
import type {VideoAiFullCapturePhase, VideoAiFullCaptureProgress} from './video-ai/fullCapture';
import type {VideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
import {downloadProgressPercent, formatDownloadBytes, formatDownloadProgress, type DownloadProgress} from '@/src/core/download/progress';

/** 菜单里的“关闭”与三种显示方式同属一个选择：用户只需回答“现在看哪种字幕”。 */
export type VideoMenuMode = VideoSubtitleDisplayMode | 'off';
export const VIDEO_MENU_MODES: readonly VideoMenuMode[] = ['bilingual', 'translation-only', 'original-only', 'off'];
const VIDEO_MENU_MODE_KEYS: Record<VideoMenuMode, string> = {
    bilingual: 'video.modeBilingual',
    'translation-only': 'video.modeTranslation',
    'original-only': 'video.modeOriginal',
    off: 'video.modeOff',
};

/** 菜单底边与播放器底边的距离，需与样式中的 bottom 保持一致。 */
const MENU_BOTTOM_OFFSET_PX = 40;
const MENU_TOP_GAP_PX = 8;
/** 矮行布局至少需要这么宽；更窄时各组会自动换行，仍比单列矮。 */
const WIDE_LAYOUT_MIN_PLAYER_WIDTH_PX = 300;
/** 单列菜单高度超过播放器可用高度的这一比例时，改用更矮的双列，留出画面上半部分。 */
const STACK_LAYOUT_MAX_HEIGHT_RATIO = .8;

type IconName = 'settings' | 'minus' | 'plus' | 'reset' | 'sparkle' | 'download' | 'close' | 'back' | 'next';
const ICON_PATHS: Record<IconName, string[]> = {
    settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
    minus: ['M6 12h12'],
    plus: ['M12 6v12', 'M6 12h12'],
    reset: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4.5V9h4.5'],
    sparkle: ['M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z', 'M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'],
    download: ['M12 4v10.5', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'],
    close: ['M7 7l10 10', 'M17 7 7 17'],
    back: ['M14 6l-6 6 6 6'],
    next: ['M10 6l6 6-6 6'],
};

// YouTube 启用 Trusted Types，图标只能逐个创建节点，不能写入 innerHTML。
function createIcon(name: IconName): SVGSVGElement {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', `fluent-read-video-menu-icon fluent-read-video-menu-icon-${name}`);
    for (const d of ICON_PATHS[name]) {
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

/** 带 data-i18n-key 的节点会在界面语言变化时由 refreshVideoUiText 重新填充。 */
function keyedText<K extends keyof HTMLElementTagNameMap>(
    tagName: K, className: string, key: string, language: UiLanguage, params?: Record<string, string | number>,
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    element.className = className;
    element.dataset.i18nKey = key;
    if (params) element.dataset.i18nParams = JSON.stringify(params);
    element.textContent = translateVideoUi(key, language, params);
    return element;
}

function createButton(className: string, attributes: Record<string, string>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
    return button;
}

function setAccessibleName(element: HTMLElement, label: string): void {
    element.setAttribute('aria-label', label);
    element.title = label;
}

function createHeader(language: UiLanguage, compact = false): HTMLElement {
    const title = createTextElement('div', 'fluent-read-video-menu-title', '');
    if (compact) {
        const back = createButton('fluent-read-video-menu-back', {'data-action': 'close-subtitle-tools', role: 'menuitem'});
        back.dataset.i18nAriaKey = 'video.back';
        setAccessibleName(back, translateVideoUi('video.back', language));
        back.hidden = true;
        back.appendChild(createIcon('back'));
        title.append(back, keyedText('span', 'fluent-read-video-menu-brand', 'video.subtitleTitle', language));
    } else title.appendChild(createTextElement('span', 'fluent-read-video-menu-brand', localizeVideoUiText('流畅阅读', language)));
    const settings = createButton('fluent-read-video-menu-item fluent-read-video-menu-settings', {
        'data-action': 'open-settings', role: 'menuitem',
    });
    settings.dataset.i18nAriaKey = 'video.openSettings';
    setAccessibleName(settings, translateVideoUi('video.openSettings', language));
    const service = createTextElement('span', 'fluent-read-video-menu-service', '');
    service.dataset.serviceLabel = 'true';
    settings.append(service, createIcon('settings'));
    const close = createButton('fluent-read-video-menu-close', {'data-action': 'close-menu', role: 'menuitem'});
    close.dataset.i18nAriaKey = 'video.closeMenu';
    setAccessibleName(close, translateVideoUi('video.closeMenu', language));
    close.appendChild(createIcon('close'));
    title.append(settings, close);
    return title;
}

function createModeGroup(language: UiLanguage): HTMLElement {
    const group = createTextElement('div', 'fluent-read-video-menu-mode-group', '');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', translateVideoUi('video.displayMode', language));
    for (const mode of VIDEO_MENU_MODES) {
        const item = keyedText('button', 'fluent-read-video-menu-mode', VIDEO_MENU_MODE_KEYS[mode], language);
        item.type = 'button';
        item.dataset.mode = mode;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');
        if (mode === 'off') {
            item.dataset.i18nTitleKey = 'video.modeOffHint';
            item.title = translateVideoUi('video.modeOffHint', language);
        }
        group.appendChild(item);
    }
    return group;
}

function createTimingRow(language: UiLanguage): HTMLElement {
    const timing = createTextElement('div', 'fluent-read-video-menu-row fluent-read-video-menu-timing', '');
    timing.dataset.timingRow = 'true';
    timing.appendChild(keyedText('span', 'fluent-read-video-menu-row-label', 'video.timingShort', language));
    const controls = createTextElement('div', 'fluent-read-video-menu-timing-controls', '');
    const stepper = (action: string, icon: IconName) => {
        const button = createButton('fluent-read-video-menu-step', {'data-action': action, role: 'menuitem'});
        button.appendChild(createIcon(icon));
        return button;
    };
    const value = createTextElement('output', 'fluent-read-video-menu-timing-value', '0.0 s');
    value.dataset.subtitleOffset = 'true';
    value.setAttribute('aria-live', 'polite');
    const reset = stepper('reset-subtitle-timing', 'reset');
    reset.classList.add('fluent-read-video-menu-step-reset');
    // 重置按钮只在有偏移时出现，放在最左侧，出现或消失时不移动连续点击中的步进按钮。
    controls.append(reset, stepper('subtitle-earlier', 'minus'), value, stepper('subtitle-later', 'plus'));
    timing.appendChild(controls);
    return timing;
}

function createAiGroup(language: UiLanguage): HTMLElement {
    const group = createTextElement('div', 'fluent-read-video-menu-ai-group', '');
    const button = createButton('fluent-read-video-menu-item fluent-read-video-menu-ai', {
        'data-action': 'toggle-ai-subtitle', role: 'menuitemcheckbox', 'aria-checked': 'false', 'aria-live': 'polite',
    });
    const label = keyedText('span', 'fluent-read-video-menu-label', 'video.aiGenerate', language);
    const state = createTextElement('span', 'fluent-read-video-menu-value', '');
    state.dataset.state = 'true';
    const progress = createTextElement('span', 'fluent-read-video-menu-progress', '');
    progress.setAttribute('aria-hidden', 'true');
    button.append(createIcon('sparkle'), label, state, progress);
    group.appendChild(button);
    return group;
}

function createDownloadActions(language: UiLanguage): HTMLElement {
    const actions = createTextElement('div', 'fluent-read-video-menu-downloads', '');
    for (const [action, key, ariaKey] of [
        ['download-subtitles', 'video.downloadOriginalShort', 'video.downloadOriginal'],
        ['download-translated-subtitles', 'video.downloadTranslatedShort', 'video.downloadTranslated'],
        ['download-bilingual-subtitles', 'video.downloadBilingualShort', 'video.downloadBilingual'],
    ]) {
        const button = createButton('fluent-read-video-menu-item fluent-read-video-menu-download', {'data-action': action, role: 'menuitem'});
        button.dataset.i18nAriaKey = ariaKey;
        setAccessibleName(button, translateVideoUi(ariaKey, language));
        button.append(createIcon('download'), keyedText('span', 'fluent-read-video-menu-label', key, language));
        actions.appendChild(button);
    }
    return actions;
}

function createDownloadStatus(): HTMLElement {
    const status = createTextElement('p', 'fluent-read-video-menu-download-status', '');
    status.dataset.downloadStatus = 'true';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    return status;
}

function createAiModelSelection(): HTMLButtonElement {
    const button = createButton('fluent-read-video-menu-item fluent-read-video-menu-model', {
        'data-action': 'select-ai-model', role: 'menuitem',
        'aria-controls': 'fluent-read-video-model-prompt', 'aria-expanded': 'false',
    });
    // 运行时确认 X 本地能力和配置状态后才显示，其他平台不引入空入口。
    button.hidden = true;
    button.append(createTextElement('span', 'fluent-read-video-menu-label', ''), createIcon('next'));
    return button;
}

/** 菜单始终由同一组节点更新，避免进度变化时丢失焦点与键盘状态。 */
export function createVideoPlayerMenu(language: UiLanguage, withLocalGeneration: boolean): HTMLElement {
    const menu = document.createElement('div');
    menu.id = VIDEO_TRANSLATION_MENU_ID;
    menu.className = 'fluent-read-video-subtitle-menu fluent-read-video-ui notranslate';
    menu.hidden = true;
    menu.dataset.layout = 'stack';
    menu.dataset.view = 'main';
    menu.dataset.compact = String(withLocalGeneration);
    menu.dataset.panel = 'watch';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', translateVideoUi('video.menuAriaLabel', language));
    markVideoUi(menu);

    const main = createTextElement('div', 'fluent-read-video-menu-main', '');
    main.appendChild(createHeader(language, withLocalGeneration));
    if (withLocalGeneration) {
        const watch = createTextElement('div', 'fluent-read-video-menu-watch', '');
        const primary = createTextElement('div', 'fluent-read-video-menu-primary-ai', '');
        primary.appendChild(createAiGroup(language));
        const more = keyedText('button', 'fluent-read-video-menu-more', 'video.subtitleTools', language);
        more.type = 'button';
        more.dataset.action = 'open-subtitle-tools';
        more.setAttribute('role', 'menuitem');
        more.setAttribute('aria-expanded', 'false');
        more.setAttribute('aria-controls', 'fluent-read-video-menu-tools');
        // 标签与箭头分开，避免语言刷新移除图标。
        const label = keyedText('span', '', 'video.subtitleTools', language);
        delete more.dataset.i18nKey;
        more.replaceChildren(label, createIcon('next'));
        watch.append(createModeGroup(language), createSourceStatus(language), primary, more);

        const tools = createTextElement('div', 'fluent-read-video-menu-tools', '');
        tools.id = 'fluent-read-video-menu-tools';
        tools.hidden = true;
        const downloads = createTextElement('div', 'fluent-read-video-menu-export', '');
        downloads.append(keyedText('span', 'fluent-read-video-menu-row-label', 'video.downloadGroup', language), createDownloadActions(language), createDownloadStatus());
        const secondary = createTextElement('div', 'fluent-read-video-menu-secondary-ai', '');
        const regenerate = keyedText('button', 'fluent-read-video-menu-secondary', 'video.regenerate', language);
        regenerate.type = 'button';
        regenerate.dataset.action = 'regenerate-ai-subtitle';
        regenerate.setAttribute('role', 'menuitem');
        regenerate.hidden = true;
        tools.append(createAiModelSelection(), createTimingRow(language), downloads, secondary, regenerate);
        main.append(watch, tools);
        menu.append(main, createModelPrompt(language));
        return menu;
    }

    const display = createTextElement('div', 'fluent-read-video-menu-section fluent-read-video-menu-display', '');
    display.append(createModeGroup(language), createTimingRow(language));
    const actions = createTextElement('div', 'fluent-read-video-menu-section fluent-read-video-menu-actions', '');
    actions.append(createDownloadActions(language), createDownloadStatus());
    main.append(display, actions);
    menu.appendChild(main);
    return menu;
}

/** 选项页复用原节点；每秒状态更新不能把用户弹回首页。 */
export function setVideoMenuToolsOpen(menu: HTMLElement, open: boolean): void {
    const watch = menu.querySelector<HTMLElement>('.fluent-read-video-menu-watch');
    const tools = menu.querySelector<HTMLElement>('.fluent-read-video-menu-tools');
    if (!watch || !tools) return;
    watch.hidden = open;
    tools.hidden = !open;
    menu.dataset.panel = open ? 'tools' : 'watch';
    menu.querySelector<HTMLElement>('[data-action="close-subtitle-tools"]')!.hidden = !open;
    menu.querySelector<HTMLElement>('[data-action="open-subtitle-tools"]')!.setAttribute('aria-expanded', String(open));
    syncVideoPlayerMenuLayout(menu);
}

/** 来源与错误只在菜单内解释，不在视频画面上反复弹出提示。 */
function createSourceStatus(language: UiLanguage): HTMLElement {
    const group = createTextElement('div', 'fluent-read-video-menu-source', '');
    const status = createTextElement('div', 'fluent-read-video-menu-source-status', '');
    status.dataset.sourceStatus = 'true';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const hint = createTextElement('p', 'fluent-read-video-menu-source-hint', '');
    hint.dataset.sourceHint = 'true';
    const actions = createTextElement('div', 'fluent-read-video-menu-source-actions', '');
    for (const [action, key] of [
        ['retry-subtitle-translation', 'video.retryTranslation'],
    ]) {
        const button = keyedText('button', 'fluent-read-video-menu-secondary', key, language);
        button.type = 'button';
        button.dataset.action = action;
        button.setAttribute('role', 'menuitem');
        button.hidden = true;
        actions.appendChild(button);
    }
    group.append(status, hint, actions);
    return group;
}

export interface VideoSourceStatus {
    enabled: boolean;
    source: 'none' | 'native' | 'cache' | 'ai';
    cueCount: number;
    checking: boolean;
    generating: boolean;
    translationFailed: boolean;
    canRegenerate: boolean;
    /** 本地模型选择不依赖字幕来源，尚无字幕时也可打开工具页。 */
    canChooseModel?: boolean;
}

const renderingSourceMenus = new WeakSet<HTMLElement>();

export function renderVideoSourceStatus(menu: HTMLElement, state: VideoSourceStatus, language: UiLanguage): void {
    // 移动正在聚焦的 AI 操作会触发播放器 blur → 状态同步，不能重入同一次节点移动。
    if (renderingSourceMenus.has(menu)) return;
    renderingSourceMenus.add(menu);
    try { renderSourceStatus(menu, state, language); }
    finally { renderingSourceMenus.delete(menu); }
}

function renderSourceStatus(menu: HTMLElement, state: VideoSourceStatus, language: UiLanguage): void {
    const group = menu.querySelector<HTMLElement>('.fluent-read-video-menu-source');
    if (!group) return;
    const key = !state.enabled ? 'video.sourceOff'
        : state.source !== 'none' ? `video.source.${state.source}`
            : state.generating ? 'video.sourcePreparing'
                : state.checking ? 'video.sourceChecking' : 'video.sourceMissing';
    const status = group.querySelector<HTMLElement>('[data-source-status]')!;
    const label = translateVideoUi(key, language, {count: state.cueCount});
    // 每秒同步不重写 live region，避免读屏器反复播报同一条状态。
    if (status.textContent !== label) status.textContent = label;
    const hintKey = !state.enabled ? ''
        : state.translationFailed ? 'video.translationFailedHint'
            : state.source === 'none' && !state.generating && !state.checking ? 'video.sourceMissingHint' : '';
    const hint = group.querySelector<HTMLElement>('[data-source-hint]')!;
    const hintText = hintKey ? translateVideoUi(hintKey, language) : '';
    if (hint.textContent !== hintText) hint.textContent = hintText;
    hint.hidden = !hintText;
    group.dataset.error = String(state.translationFailed && state.enabled);
    const aiButton = menu.querySelector<HTMLElement>('[data-action="toggle-ai-subtitle"]');
    if (aiButton) {
        aiButton.dataset.native = String(state.source === 'native');
        const aiGroup = aiButton.parentElement!;
        const primary = menu.querySelector<HTMLElement>('.fluent-read-video-menu-primary-ai')!;
        const secondary = menu.querySelector<HTMLElement>('.fluent-read-video-menu-secondary-ai')!;
        const destination = state.source === 'none' || state.generating ? primary : secondary;
        if (aiGroup.parentElement !== destination) {
            const heldFocus = aiGroup.contains(document.activeElement);
            destination.appendChild(aiGroup);
            // 重新识别先清空旧来源，可能在进入 generating 前已经移回首页。
            // 此时也要返回首页，否则失败提示会藏在不可见的 AI 操作中。
            if (destination === primary && menu.dataset.panel === 'tools') {
                setVideoMenuToolsOpen(menu, false);
            }
            if (heldFocus && destination === secondary && menu.dataset.panel === 'watch') {
                menu.querySelector<HTMLButtonElement>('[data-mode][aria-checked="true"]')?.focus();
            }
        }
        primary.hidden = !state.enabled || destination !== primary;
        secondary.hidden = destination !== secondary;
    }
    group.querySelector<HTMLButtonElement>('[data-action="retry-subtitle-translation"]')!.hidden = !state.enabled || !state.translationFailed;
    group.querySelector<HTMLElement>('.fluent-read-video-menu-source-actions')!.hidden = !state.enabled || !state.translationFailed;
    menu.querySelector<HTMLButtonElement>('[data-action="regenerate-ai-subtitle"]')!.hidden = !state.canRegenerate;
    const canResetTiming = menu.querySelector<HTMLElement>('[data-timing-row]')?.hidden === false;
    menu.querySelector<HTMLElement>('[data-action="open-subtitle-tools"]')!.hidden = !state.enabled || (state.source === 'none' && !canResetTiming && !state.canChooseModel);
    for (const button of menu.querySelectorAll<HTMLButtonElement>('.fluent-read-video-menu-download')) {
        // 导出中由原操作释放按钮；来源刷新不能提前解除 busy 状态。
        if (button.getAttribute('aria-busy') === 'true') continue;
        button.disabled = !state.enabled || state.cueCount === 0 || (state.source === 'ai' && state.generating);
    }
}

/** 菜单内的方向键移动焦点，Space 等按键不冒泡成宿主播放器的暂停/快进。 */
export function handleVideoMenuNavigation(event: KeyboardEvent): void {
    if (!event.isTrusted) return;
    const menu = event.currentTarget as HTMLElement;
    if (!(event.target instanceof HTMLElement) || !menu.contains(event.target)) return;
    event.stopPropagation();
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const scope = horizontal ? event.target.closest('.fluent-read-video-menu-mode-group') : menu;
    if (!scope) return;
    const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
        .filter(button => !button.disabled && !button.closest('[hidden]'));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
}

/** “关闭”由总开关或隐藏字幕决定；三种显示方式只在字幕实际可见时高亮。 */
export function renderVideoMenuMode(menu: HTMLElement, selected: VideoMenuMode, disabled: boolean, disabledReason: string): void {
    menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((item) => {
        item.setAttribute('aria-checked', String(item.dataset.mode === selected));
        item.disabled = disabled;
    });
    const group = menu.querySelector<HTMLElement>('.fluent-read-video-menu-mode-group');
    if (group) group.title = disabled ? disabledReason : '';
}

/** 持久配置更新时复用按钮；无时间轴且无偏移时整行收起，仍允许清除已有偏移。 */
export function renderVideoSubtitleTiming(menu: HTMLElement, offsetMs: number, available: boolean, language: UiLanguage): void {
    const row = menu.querySelector<HTMLElement>('[data-timing-row]')!;
    row.hidden = !available && offsetMs === 0;
    row.title = available ? '' : localizeVideoUiText('当前字幕暂不支持时间调整', language);
    const value = menu.querySelector<HTMLOutputElement>('[data-subtitle-offset]')!;
    value.textContent = `${offsetMs > 0 ? '+' : ''}${(offsetMs / 1000).toFixed(1)} s`;
    value.setAttribute('aria-label', localizeVideoUiText('字幕时间偏移', language));
    const earlier = menu.querySelector<HTMLButtonElement>('[data-action="subtitle-earlier"]')!;
    const later = menu.querySelector<HTMLButtonElement>('[data-action="subtitle-later"]')!;
    const reset = menu.querySelector<HTMLButtonElement>('[data-action="reset-subtitle-timing"]')!;
    earlier.disabled = !available || offsetMs <= -10_000;
    later.disabled = !available || offsetMs >= 10_000;
    reset.disabled = offsetMs === 0;
    setAccessibleName(earlier, localizeVideoUiText('提前 0.5 秒', language));
    setAccessibleName(later, localizeVideoUiText('延后 0.5 秒', language));
    setAccessibleName(reset, localizeVideoUiText('重置字幕时间', language));
}

export interface VideoAiMenuState {
    available: boolean;
    checking: boolean;
    downloading?: boolean;
    /** 模型下载的真实字节进度；尚未收到或总量未知时菜单保持循环动画。 */
    downloadProgress?: DownloadProgress;
    active: boolean;
    running: boolean;
    requested: boolean;
    fullActive: boolean;
    phase: VideoAiFullCapturePhase;
    progress: VideoAiFullCaptureProgress;
    error: string;
}

export function renderVideoAiMenu(menu: HTMLElement, state: VideoAiMenuState, language: UiLanguage): void {
    const button = menu.querySelector<HTMLButtonElement>('[data-action="toggle-ai-subtitle"]');
    if (!button) return;
    const ready = state.fullActive && state.phase === 'ready';
    const downloading = state.downloading === true;
    const processing = state.active && !ready;
    const labelKey = !state.available ? 'video.aiUnavailable'
        : downloading ? 'video.aiDownloadingModel'
            : state.checking ? 'video.aiCheckingModel'
                : ready ? 'video.aiDisable'
                    : processing ? 'video.aiStop'
                        : state.error ? 'video.aiRetry'
                            : 'video.aiGenerate';
    let detail = '';
    let percent: number | undefined;
    if (state.fullActive) {
        if (state.phase === 'capturing') {
            detail = translateVideoUi('video.aiReadingAudio', language);
            if (state.progress.capturedMs > 0 && state.progress.durationMs > 0) {
                percent = Math.round(state.progress.progress * 100);
                detail = state.progress.transcribedMs > 0
                    ? translateVideoUi('video.aiTranscribing', language, {percent})
                    : `${detail} ${percent}%`;
            }
        }
        else if (state.phase === 'transcribing' || state.phase === 'translating') {
            percent = Math.round(state.progress.progress * 100);
            detail = translateVideoUi(state.phase === 'transcribing' ? 'video.aiTranscribing' : 'video.aiTranslating', language, {percent});
        } else if (ready) detail = translateVideoUi('video.aiReady', language);
        else detail = translateVideoUi('video.aiPreparing', language);
    } else if (state.running) detail = translateVideoUi('video.aiGenerating', language);
    else if (state.requested) detail = translateVideoUi('video.aiWaitingForPlayback', language);
    if (state.error && !downloading && !state.checking) detail = localizeVideoUiText(state.error, language);
    let title = state.error && !downloading ? localizeVideoUiText(state.error, language) : detail;
    if (downloading && state.downloadProgress) {
        // 菜单宽度有限：按钮上只写百分比（总量未知时写已下载体积），完整字节数放在悬停提示里。
        percent = downloadProgressPercent(state.downloadProgress);
        detail = percent === undefined ? formatDownloadBytes(state.downloadProgress.loaded) : `${percent}%`;
        title = formatDownloadProgress(state.downloadProgress);
    }
    button.disabled = !state.available || state.checking || downloading;
    button.setAttribute('aria-checked', String(state.active));
    button.dataset.processing = String(processing || state.checking || downloading);
    button.dataset.error = String(Boolean(state.error) && !downloading);
    button.dataset.ready = String(ready);
    // 确定进度显示为进度条；读取音频、尚未收到下载进度等无法给出比例的阶段使用循环动画。
    button.dataset.progress = percent === undefined ? (processing || downloading ? 'indeterminate' : 'none') : 'determinate';
    button.style.setProperty('--fluent-read-video-ai-progress', `${percent ?? 0}%`);
    const labelElement = button.querySelector<HTMLElement>('.fluent-read-video-menu-label')!;
    labelElement.dataset.i18nKey = labelKey;
    labelElement.textContent = translateVideoUi(labelKey, language);
    button.querySelector<HTMLElement>('[data-state]')!.textContent = detail;
    button.title = title;
}

const downloadStatusTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * 两个下载共用一行状态。每次写入取消前一次清理，避免旧下载清掉新反馈；
 * 卸载时写入空状态即可释放菜单拥有的计时器。
 */
export function setVideoMenuDownloadStatus(menu: HTMLElement, text: string, clearAfterMs?: number): void {
    clearTimeout(downloadStatusTimers.get(menu));
    downloadStatusTimers.delete(menu);
    menu.querySelector<HTMLElement>('[data-download-status]')!.textContent = text;
    syncVideoPlayerMenuLayout(menu);
    if (clearAfterMs === undefined) return;
    downloadStatusTimers.set(menu, setTimeout(() => {
        downloadStatusTimers.delete(menu);
        setVideoMenuDownloadStatus(menu, '');
    }, clearAfterMs));
}

export interface VideoModelPromptOption {
    readonly value: VideoLocalTranscriptionModel;
    readonly downloadSizeMb: number;
}

export interface VideoModelPromptState {
    readonly options: readonly VideoModelPromptOption[];
    readonly downloaded: readonly VideoLocalTranscriptionModel[];
    readonly recommended: VideoLocalTranscriptionModel;
    readonly selected: VideoLocalTranscriptionModel;
    /** 同一菜单视图可用于首次下载或用户主动更换当前识别模型。 */
    readonly purpose?: 'setup' | 'selection';
}

export interface VideoAiModelSelectionState {
    readonly model: VideoLocalTranscriptionModel;
    readonly available: boolean;
    readonly disabled: boolean;
}

const MODEL_NAME_KEYS: Record<VideoLocalTranscriptionModel, [name: string, hint: string]> = {
    tiny: ['video.modelTinyName', 'video.modelTinyHint'],
    base: ['video.modelBaseName', 'video.modelBaseHint'],
    small: ['video.modelSmallName', 'video.modelSmallHint'],
};

/** 只呈现当前配置与是否可操作，不替用户选择模型或中断现有字幕。 */
export function renderVideoAiModelSelection(menu: HTMLElement, state: VideoAiModelSelectionState, language: UiLanguage): void {
    const button = menu.querySelector<HTMLButtonElement>('[data-action="select-ai-model"]');
    if (!button) return;
    const params = {model: translateVideoUi(MODEL_NAME_KEYS[state.model][0], language)};
    button.hidden = !state.available;
    button.disabled = !state.available || state.disabled;
    button.dataset.model = state.model;
    button.dataset.i18nAriaKey = 'video.modelSelectionAria';
    button.dataset.i18nParams = JSON.stringify(params);
    setAccessibleName(button, translateVideoUi('video.modelSelectionAria', language, params));
    button.setAttribute('aria-expanded', String(menu.dataset.view === 'model-prompt'
        && menu.querySelector<HTMLElement>('[data-model-prompt]')?.dataset.purpose === 'selection'));
    const label = button.querySelector<HTMLElement>('.fluent-read-video-menu-label')!;
    label.dataset.i18nKey = 'video.modelSelection';
    label.dataset.i18nParams = JSON.stringify(params);
    label.textContent = translateVideoUi('video.modelSelection', language, params);
}

function createModelPrompt(language: UiLanguage): HTMLElement {
    const prompt = createTextElement('section', 'fluent-read-video-model-prompt', '');
    prompt.id = 'fluent-read-video-model-prompt';
    prompt.dataset.modelPrompt = 'true';
    prompt.hidden = true;
    prompt.setAttribute('role', 'group');
    prompt.setAttribute('aria-labelledby', 'fluent-read-video-model-prompt-title');
    const head = createTextElement('div', 'fluent-read-video-model-prompt-head', '');
    const title = keyedText('span', 'fluent-read-video-model-prompt-title', 'video.modelPromptTitle', language);
    title.id = 'fluent-read-video-model-prompt-title';
    const close = createButton('fluent-read-video-menu-step', {'data-action': 'model-prompt-cancel', role: 'menuitem'});
    close.dataset.i18nAriaKey = 'video.modelPromptCancel';
    setAccessibleName(close, translateVideoUi('video.modelPromptCancel', language));
    close.appendChild(createIcon('close'));
    head.append(createIcon('sparkle'), title, close);
    const description = keyedText('p', 'fluent-read-video-model-prompt-description', 'video.modelPromptDescription', language);
    const options = createTextElement('div', 'fluent-read-video-model-options', '');
    options.dataset.modelOptions = 'true';
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-labelledby', 'fluent-read-video-model-prompt-title');
    const actions = createTextElement('div', 'fluent-read-video-model-prompt-actions', '');
    const cancel = keyedText('button', 'fluent-read-video-model-prompt-cancel', 'video.modelPromptCancel', language);
    cancel.type = 'button';
    cancel.dataset.action = 'model-prompt-cancel';
    cancel.setAttribute('role', 'menuitem');
    const confirm = keyedText('button', 'fluent-read-video-model-prompt-confirm', 'video.modelPromptDownload', language);
    confirm.type = 'button';
    confirm.dataset.action = 'model-prompt-confirm';
    confirm.setAttribute('role', 'menuitem');
    actions.append(cancel, confirm);
    prompt.append(head, description, options, actions);
    return prompt;
}

function renderModelOption(option: VideoModelPromptOption, state: VideoModelPromptState, language: UiLanguage): HTMLButtonElement {
    const button = createButton('fluent-read-video-model-option', {role: 'menuitemradio'});
    button.dataset.modelChoice = option.value;
    const [nameKey, hintKey] = MODEL_NAME_KEYS[option.value];
    const radio = createTextElement('span', 'fluent-read-video-model-option-radio', '');
    radio.setAttribute('aria-hidden', 'true');
    const name = createTextElement('span', 'fluent-read-video-model-option-name', '');
    name.appendChild(keyedText('span', '', nameKey, language));
    if (option.value === state.recommended) {
        name.appendChild(keyedText('span', 'fluent-read-video-model-option-badge', 'video.modelRecommended', language));
    }
    const downloaded = state.downloaded.includes(option.value);
    const size = downloaded
        ? keyedText('span', 'fluent-read-video-model-option-size is-downloaded', 'video.modelDownloaded', language)
        : keyedText('span', 'fluent-read-video-model-option-size', 'video.modelSize', language, {size: option.downloadSizeMb});
    button.append(radio, name, size, keyedText('span', 'fluent-read-video-model-option-hint', hintKey, language));
    return button;
}

/** 在同一弹层内切换到模型确认视图；传入 null 回到主菜单。 */
export function renderVideoModelPrompt(menu: HTMLElement, state: VideoModelPromptState | null, language: UiLanguage): void {
    const prompt = menu.querySelector<HTMLElement>('[data-model-prompt]');
    if (!prompt) return;
    if (menu.dataset.view === 'export-prompt' && !state) return;
    const main = menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!;
    menu.querySelector<HTMLElement>('[data-action="select-ai-model"]')?.setAttribute('aria-expanded', String(state?.purpose === 'selection'));
    if (!state) {
        prompt.hidden = true;
        main.hidden = false;
        menu.dataset.view = 'main';
        return;
    }
    const selection = state.purpose === 'selection';
    prompt.dataset.purpose = selection ? 'selection' : 'setup';
    const title = prompt.querySelector<HTMLElement>('.fluent-read-video-model-prompt-title')!;
    title.dataset.i18nKey = selection ? 'video.modelSelectionTitle' : 'video.modelPromptTitle';
    title.textContent = translateVideoUi(title.dataset.i18nKey, language);
    const description = prompt.querySelector<HTMLElement>('.fluent-read-video-model-prompt-description')!;
    description.dataset.i18nKey = selection ? 'video.modelSelectionDescription' : 'video.modelPromptDescription';
    description.textContent = translateVideoUi(description.dataset.i18nKey, language);
    // 菜单状态每秒都会刷新；选项只在内容变化时重建，切换选择时原地更新，避免移除正在聚焦的按钮。
    const options = prompt.querySelector<HTMLElement>('[data-model-options]')!;
    const optionsKey = JSON.stringify([language, state.recommended, state.downloaded, state.options]);
    if (options.dataset.renderKey !== optionsKey) {
        options.dataset.renderKey = optionsKey;
        options.replaceChildren(...state.options.map(option => renderModelOption(option, state, language)));
    }
    options.querySelectorAll<HTMLElement>('[data-model-choice]').forEach((option) => {
        option.setAttribute('aria-checked', String(option.dataset.modelChoice === state.selected));
    });
    const confirm = prompt.querySelector<HTMLButtonElement>('[data-action="model-prompt-confirm"]')!;
    const confirmKey = state.downloaded.includes(state.selected) ? 'video.modelPromptStart' : 'video.modelPromptDownload';
    confirm.dataset.i18nKey = confirmKey;
    confirm.textContent = translateVideoUi(confirmKey, language);
    prompt.dataset.selectedModel = state.selected;
    main.hidden = true;
    prompt.hidden = false;
    menu.dataset.view = 'model-prompt';
}

export function isVideoModelPromptOpen(menu: HTMLElement): boolean {
    return menu.dataset.view === 'model-prompt';
}

/** 退出原位模型视图后只恢复可见操作的焦点，不切换工具页或播放器。 */
export function focusVideoModelPromptReturn(menu: HTMLElement, purpose?: 'selection'): void {
    const selectors = [
        ...(purpose === 'selection' ? ['[data-action="select-ai-model"]'] : []),
        '[data-action="toggle-ai-subtitle"]',
        '[data-action="close-subtitle-tools"]',
        '[data-mode][aria-checked="true"]',
    ];
    for (const selector of selectors) {
        const button = menu.querySelector<HTMLButtonElement>(selector);
        if (!button || button.disabled || button.closest('[hidden]')) continue;
        button.focus();
        return;
    }
}

/**
 * 菜单挂在播放器内，只能按播放器实际尺寸选择布局。矮而宽的播放器（手机横屏视频、
 * 小窗口）改为双列，避免单列菜单遮住整个画面还需要滚动；其余情况保持单列。
 */
export function syncVideoPlayerMenuLayout(menu: HTMLElement): void {
    const player = menu.parentElement;
    if (menu.hidden || !player) return;
    // 使用布局尺寸而非变换后的外接矩形，与菜单自身的 CSS 像素保持同一坐标系。
    const width = player.clientWidth;
    const height = player.clientHeight;
    if (!width || !height) return;
    // X 观看首页已精简，不再因为少量说明把菜单拉成 440px 的横向面板。
    if (menu.dataset.compact === 'true' && menu.dataset.panel === 'watch' && menu.dataset.view === 'main') {
        menu.dataset.layout = 'stack';
        return;
    }
    // 下载反馈只短暂出现，不参与布局判断，避免文字出现和消失时菜单来回切换形状。
    menu.dataset.layout = 'stack';
    menu.dataset.measuring = 'true';
    const needed = menu.scrollHeight;
    delete menu.dataset.measuring;
    const available = height - MENU_BOTTOM_OFFSET_PX - MENU_TOP_GAP_PX;
    menu.dataset.layout = needed > available * STACK_LAYOUT_MAX_HEIGHT_RATIO && width >= WIDE_LAYOUT_MIN_PLAYER_WIDTH_PX ? 'wide' : 'stack';
}
