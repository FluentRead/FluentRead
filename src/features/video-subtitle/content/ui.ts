/**
 * @file src/features/video-subtitle/content/ui.ts
 *
 * 文件职责：封装视频字幕 content UI 的界面语言转换与可访问名称刷新，避免 YouTube 播放器运行时承载重复的文案拼装。
 * 主要内容：提供视频菜单本地化、节点创建、播放器定位、字幕几何及样式安装，并封装字幕文件的浏览器下载。
 * 模块边界：只读取界面配置并操作视频 feature 拥有的节点、样式和下载链接，不发起翻译或识别请求；任务生命周期由 runtime 管理。
 */

import {getVideoSubtitleAppearanceCssVars, normalizeVideoSubtitleAppearance} from '@/src/core/config/videoSubtitleAppearance';
import {config} from '@/src/services/config/store';
import {type VideoSubtitleDisplayMode} from '@/src/core/config/model';
import {cuesToSrt, sanitizeSubtitleFilename, type VideoSubtitleCue} from './youtubeSubtitleData';

import {
    normalizeUiLanguage,
    translate,
    translateLegacyText,
    type TranslationParams,
    type UiLanguage,
} from '@/src/core/i18n';

export type {UiLanguage} from '@/src/core/i18n';

export function getVideoUiLanguage(value: unknown): UiLanguage {
    return normalizeUiLanguage(value);
}

export function translateVideoUi(
    key: string,
    language: UiLanguage,
    params?: TranslationParams,
): string {
    return translate(key, language, params);
}

export function localizeVideoUiText(source: string, language: UiLanguage): string {
    return translateLegacyText(source, language);
}

export function createVideoUiTextElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className: string,
    source: string,
    language: UiLanguage,
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = localizeVideoUiText(source, language);
    element.dataset.i18nSource = source;
    return element;
}

export function refreshVideoUiText(root: HTMLElement, language: UiLanguage): void {
    root.querySelectorAll<HTMLElement>('[data-i18n-source]').forEach((element) => {
        const source = element.dataset.i18nSource;
        if (source !== undefined) element.textContent = localizeVideoUiText(source, language);
    });
}

export function refreshVideoUiAccessibility(
    menu: HTMLElement,
    button: HTMLElement,
    document: Document,
    language: UiLanguage,
    status: string,
): void {
    menu.setAttribute('aria-label', translateVideoUi('video.menuAriaLabel', language));
    menu.querySelector<HTMLElement>('[role="radiogroup"]')?.setAttribute('aria-label', translateVideoUi('video.displayMode', language));
    const buttonLabel = translateVideoUi('video.buttonAriaLabel', language, {status});
    button.setAttribute('aria-label', buttonLabel);
    button.title = buttonLabel;
    document.getElementById('fluent-read-video-subtitle-panel')?.setAttribute('aria-label', translateVideoUi('video.panelAriaLabel', language));
    document.getElementById('fluent-read-video-subtitle')?.setAttribute('aria-label', translateVideoUi('video.translationOverlayAriaLabel', language));
    document.getElementById('fluent-read-video-subtitle-original')?.setAttribute('aria-label', translateVideoUi('video.originalOverlayAriaLabel', language));
}

export const VIDEO_AI_CAPTION_CONTAINER_ID = 'fluent-read-video-ai-caption-container';
export const VIDEO_CAPTION_CONTAINER_SELECTOR = '#ytp-caption-window-container, .ytp-caption-window-container, #fluent-read-video-ai-caption-container';
export const VIDEO_CAPTION_SEGMENT_SELECTOR = '.ytp-caption-segment';
export const VIDEO_TRANSLATION_OVERLAY_ID = 'fluent-read-video-subtitle';
export const VIDEO_NORMALIZED_CAPTION_OVERLAY_ID = 'fluent-read-video-subtitle-original';
export const VIDEO_SUBTITLE_PANEL_ID = 'fluent-read-video-subtitle-panel';
export const VIDEO_TRANSLATION_LAYER_ID = 'fluent-read-video-subtitle-layer';
export const VIDEO_TRANSLATION_BUTTON_ID = 'fluent-read-video-subtitle-button';
export const VIDEO_TRANSLATION_MENU_ID = 'fluent-read-video-subtitle-menu';

export const VIDEO_PLAYER_SELECTOR = '#movie_player, .html5-video-player, [data-testid="videoPlayer"]';
export const VIDEO_RIGHT_CONTROLS_SELECTOR = '.ytp-right-controls';
export const VIDEO_FALLBACK_CONTROLS_CLASS = 'fluent-read-video-controls';
export const VIDEO_PLAYER_HOST_CLASS = 'fluent-read-video-player-host';
export const VIDEO_PLAYER_ACTIVE_ATTRIBUTE = 'data-fluent-read-video-active';
export const VIDEO_PLAYER_PROGRESS_ATTRIBUTE = 'data-fluent-read-video-progress';
export const VIDEO_X_SETTINGS_CONTROL_SELECTOR = [
  '[data-testid="videoPlayer"] button[aria-label*="Settings" i]',
  '[data-testid="videoPlayer"] button[aria-label*="设置"]',
  '[data-testid="videoPlayer"] button[title*="Settings" i]',
  '[data-testid="videoPlayer"] [data-testid*="settings" i]',
  '[data-testid="videoPlayer"] [data-testid*="setting" i]',
  'button[aria-label*="Settings" i]',
  'button[aria-label*="设置"]',
  'button[title*="Settings" i]',
  '[role="button"][aria-label*="Settings" i]',
  '[role="button"][aria-label*="设置"]',
].join(', ');
export const VIDEO_TRANSLATION_ACTIVE_CLASS = 'fluent-read-video-subtitle-active';
export const VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS = 'fluent-read-video-display-translation-only';
export const VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS = 'fluent-read-video-display-original-only';
export const VIDEO_DISPLAY_HIDDEN_CLASS = 'fluent-read-video-display-hidden';
export const VIDEO_NORMALIZED_CAPTION_CLASS = 'fluent-read-video-normalized-caption';
export const VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS = 'fluent-read-video-normalized-caption-active';
export const VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS = 'fluent-read-video-subtitle-panel-active';

export const YOUTUBE_HOST_PATTERN = /(^|\.)youtube\.com$/i;
export const X_SUBTITLE_RESOURCE_MESSAGE = 'fluent-read-x-video-subtitle-resource';

export const VIDEO_DISPLAY_MODE_LABELS: Record<VideoSubtitleDisplayMode, string> = {
  bilingual: '双语',
  'translation-only': '仅译文',
  'original-only': '仅原文',
};

export const VIDEO_CAPTION_EMPTY_GRACE_MS = 420;
export const VIDEO_CAPTION_STABILITY_MS = 360;
export const VIDEO_CAPTION_FALLBACK_SEGMENT_SELECTOR = '.captions-text';
export const VIDEO_SUBTITLE_DOWNLOAD_CONCURRENCY = 3;


export function normalizeVideoSubtitleDisplayMode(value: unknown): VideoSubtitleDisplayMode {
  if (value === 'translation-only' || value === 'original-only') return value;
  return 'bilingual';
}


export function getTimedTextCacheKey(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return [
      parsed.searchParams.get('v') || '',
      parsed.searchParams.get('lang') || '',
      parsed.searchParams.get('tlang') || '',
      parsed.searchParams.get('kind') || '',
    ].join(':');
  } catch {
    return url;
  }
}

export function isOriginalTimedTextUrl(url: string): boolean {
  try {
    return !new URL(url, window.location.href).searchParams.get('tlang');
  } catch {
    return false;
  }
}

export function downloadSubtitleSrt(cues: VideoSubtitleCue[], languageCode: string): void {
  const srt = cuesToSrt(cues);
  if (!srt.trim()) throw new Error('字幕轨道没有可下载的内容');

  const title = sanitizeSubtitleFilename(document.title.replace(/\s*-\s*(?:YouTube|X)\s*$/i, ''));
  const language = sanitizeSubtitleFilename(languageCode || 'original');
  const blobUrl = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = `${title}-${language}.srt`;
  anchor.style.display = 'none';
  (document.body || document.documentElement).appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function isYouTubeVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return YOUTUBE_HOST_PATTERN.test(locationLike.hostname)
    && (locationLike.pathname === '/watch' || locationLike.pathname.startsWith('/shorts/'));
}

export function isXVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return isXHostPage(locationLike);
}

export function isXHostPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(locationLike.hostname.toLowerCase());
}

export function isSupportedVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return isYouTubeVideoPage(locationLike) || isXVideoPage(locationLike);
}

/** 读取当前播放器可见的原生字幕，不读取插件自己的译文节点。 */
export function getVisibleCaptionSegments(container: Element): HTMLElement[] {
  const nativeSegments = Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR));
  const candidates = nativeSegments.length > 0
    ? nativeSegments
    : Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_FALLBACK_SEGMENT_SELECTOR));

  return candidates.filter((segment) => !candidates.some((candidate) => candidate !== segment && candidate.contains(segment)));
}

export function readVisibleCaptionText(container: Element | null): string {
  if (!container) return '';

  const segments = getVisibleCaptionSegments(container)
    .map((segment) => segment.textContent?.replace(/[\s\u3000]+/g, ' ').trim() || '')
    .filter(Boolean);

  return segments.join(' ').replace(/[\s\u3000]+/g, ' ').trim();
}

export function findCaptionContainer(): HTMLElement | null {
  if (isXVideoPage()) return document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID);
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(VIDEO_CAPTION_CONTAINER_SELECTOR));
  return candidates.find((candidate) => readVisibleCaptionText(candidate))
    || candidates[0]
    || null;
}

/** X 播放器的覆盖链接可能位于 video 外的同一 post 容器；只在单视频且链接明确指向当前 status 时提升容器。 */
function hasCurrentXVideoOverlayLink(container: HTMLElement): boolean {
  const status = window.location.pathname.match(/\/status\/(\d+)/i)?.[1];
  if (!status) return false;
  const origin = window.location.origin;
  const videoLinkPattern = new RegExp(`/status/${status}/video/\\d+/?$`, 'i');
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]')).some((anchor) => {
    try {
      const href = new URL(anchor.getAttribute('href') || '', window.location.href);
      return href.origin === origin && videoLinkPattern.test(href.pathname);
    } catch {
      return false;
    }
  });
}

function findXVideoOverlayContainer(video: HTMLVideoElement): HTMLElement | null {
  const post = video.closest('article');
  if (!post || post.querySelectorAll<HTMLVideoElement>('video').length !== 1) return null;
  let current = video.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    if (!post.contains(current)) break;
    const videos = Array.from(current.querySelectorAll<HTMLVideoElement>('video'));
    if (videos.length !== 1 || videos[0] !== video) continue;
    if (hasCurrentXVideoOverlayLink(current)) return current;
    if (current === post) break;
  }
  return null;
}

export function findVideoPlayer(): HTMLElement | null {
  const activeHost = document.querySelector<HTMLElement>(`.${VIDEO_PLAYER_HOST_CLASS}`);
  if (activeHost?.isConnected) return activeHost;
  const players = Array.from(document.querySelectorAll<HTMLElement>(VIDEO_PLAYER_SELECTOR));
  if (isXVideoPage()) {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    const overlayContainer = videos
      .map((video) => findXVideoOverlayContainer(video))
      .find((container): container is HTMLElement => container !== null);
    if (overlayContainer) return overlayContainer;
    const status = window.location.pathname.match(/\/status\/(\d+)/)?.[1];
    const currentPost = players.find(player => player.closest('article')?.querySelector(`a[href*="/status/${status}"]`));
    if (currentPost) return currentPost;
  }
  if (players[0]) return players[0];

  const video = document.querySelector<HTMLVideoElement>('video');
  let current = video?.parentElement || null;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    const rect = current.getBoundingClientRect();
    if (rect.width >= 240 && rect.height >= 120) return current;
  }
  return video?.parentElement || null;
}

export function findXSettingsControl(player: HTMLElement): HTMLElement | null {
  if (!isXVideoPage()) return null;
  if (hasCurrentXVideoOverlayLink(player)) return null;
  return player.querySelector<HTMLElement>(VIDEO_X_SETTINGS_CONTROL_SELECTOR);
}

/** X 的控制栏没有固定 class；从设置齿轮向上找最近的按钮组。 */
export function findXNativeControls(player: HTMLElement, settingsControl: HTMLElement): HTMLElement | null {
  let candidate = settingsControl.parentElement;
  while (candidate && candidate !== player) {
    const interactiveCount = candidate.querySelectorAll('button, [role="button"]').length;
    if (interactiveCount >= 2) return candidate;
    candidate = candidate.parentElement;
  }
  return settingsControl.parentElement;
}

export function getVideoPageKey(href = window.location.href): string {
  try {
    const url = new URL(href, window.location.href);
    return `${url.pathname}:${url.searchParams.get('v') || ''}`;
  } catch {
    return href;
  }
}

export function markVideoUi(element: HTMLElement): void {
  element.classList.add('notranslate', 'fluent-read-video-ui');
  element.setAttribute('data-fluent-read-ui', 'video-subtitle');
  element.setAttribute('translate', 'no');
}

export function createTextElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

export function videoUi(key: string, params?: Record<string, string | number | boolean>): string {
  return translateVideoUi(key, getVideoUiLanguage(config.uiLanguage), params);
}

export function getOrCreateVideoSubtitleLayer(player: HTMLElement): HTMLElement {
  let layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = VIDEO_TRANSLATION_LAYER_ID;
    layer.className = 'fluent-read-video-subtitle-layer fluent-read-video-ui notranslate';
    layer.setAttribute('data-fluent-read-ui', 'video-subtitle');
    layer.setAttribute('translate', 'no');
  }
  if (layer.parentElement !== player) player.appendChild(layer);
  return layer;
}

export function getOrCreateVideoSubtitlePanel(player: HTMLElement): HTMLElement {
  const layer = getOrCreateVideoSubtitleLayer(player);
  const existing = layer.querySelector<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`);
  if (existing) return existing;

  const panel = document.createElement('div');
  panel.id = VIDEO_SUBTITLE_PANEL_ID;
  panel.className = 'fluent-read-video-subtitle-panel fluent-read-video-ui notranslate';
  panel.setAttribute('data-fluent-read-ui', 'video-subtitle');
  panel.setAttribute('translate', 'no');
  panel.setAttribute('aria-label', videoUi('video.panelAriaLabel'));
  layer.appendChild(panel);
  return panel;
}

export function getOrCreateTranslationOverlay(player: HTMLElement): HTMLElement {
  const panel = getOrCreateVideoSubtitlePanel(player);

  const existing = document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID);
  if (existing instanceof HTMLElement) {
    if (existing.parentElement !== panel) panel.appendChild(existing);
    return existing;
  }

  const overlay = document.createElement('div');
  overlay.id = VIDEO_TRANSLATION_OVERLAY_ID;
  overlay.className = 'fluent-read-video-subtitle notranslate';
  overlay.setAttribute('data-fluent-read-ui', 'video-subtitle');
  overlay.setAttribute('translate', 'no');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', videoUi('video.translationOverlayAriaLabel'));
  panel.appendChild(overlay);
  return overlay;
}

export function getOrCreateNormalizedCaptionOverlay(player: HTMLElement): HTMLElement {
  const panel = getOrCreateVideoSubtitlePanel(player);
  const existing = document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID);
  if (existing instanceof HTMLElement) {
    if (existing.parentElement !== panel) panel.appendChild(existing);
    return existing;
  }

  const overlay = document.createElement('div');
  overlay.id = VIDEO_NORMALIZED_CAPTION_OVERLAY_ID;
  overlay.className = 'fluent-read-video-subtitle-original notranslate';
  overlay.setAttribute('data-fluent-read-ui', 'video-subtitle');
  overlay.setAttribute('translate', 'no');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', videoUi('video.originalOverlayAriaLabel'));
  panel.appendChild(overlay);
  return overlay;
}

export function removeTranslationOverlay(): void {
  document.querySelectorAll(`#${VIDEO_TRANSLATION_LAYER_ID}`).forEach((node) => node.remove());
  document.querySelectorAll(`#${VIDEO_TRANSLATION_OVERLAY_ID}`).forEach((node) => node.remove());
  document.querySelectorAll(`#${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}`).forEach((node) => node.remove());
}

/** X 的原生字幕已隐藏，贴底时只避开实际可见的播放控件，不预留原文区域。 */
export function getXSubtitleBottomInset(player: HTMLElement): number {
  const playerRect = player.getBoundingClientRect();
  const settings = Array.from(player.querySelectorAll<HTMLElement>(VIDEO_X_SETTINGS_CONTROL_SELECTOR))
    .find(control => !control.closest('.fluent-read-video-ui'));
  const controls = settings ? findXNativeControls(player, settings) : player.querySelector<HTMLElement>(`.${VIDEO_FALLBACK_CONTROLS_CLASS}`);
  if (controls) {
    const rect = controls.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0;
    for (let node: HTMLElement | null = controls; visible && node; node = node.parentElement) {
      const style = getComputedStyle(node);
      visible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
      if (node === player) break;
    }
    if (visible && rect.top >= playerRect.top + playerRect.height * .65 && rect.top < playerRect.bottom) {
      return Math.max(12, playerRect.bottom - rect.top + 8);
    }
  }
  const video = player.querySelector('video');
  // 浏览器自带 controls 在 closed shadow tree 中，无法测量；交互时预留一行按钮高度。
  if (video?.controls && (video.paused || player.matches(':hover') || player.contains(document.activeElement))) return 56;
  return 12;
}

export function syncTranslationOverlayPosition(container: HTMLElement | null): void {
  if (!container) return;
  const overlay = document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID);
  const normalizedOverlay = document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID);
  const panel = document.getElementById(VIDEO_SUBTITLE_PANEL_ID);
  const player = findVideoPlayer();
  if (!overlay || !panel || !player) return;

  const playerRect = player.getBoundingClientRect();
  const visibleCaptionSegments = getVisibleCaptionSegments(container)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  // YouTube 在字幕切换期间会短暂保留一个空的、甚至回到播放器顶部的容器。
  // 没有真实字幕片段时保留上一次位置，避免译文被重新定位到顶部后闪过。

  const playerWidth = playerRect.width || 960;
  const menu = document.getElementById(VIDEO_TRANSLATION_MENU_ID);
  const menuReserve = menu instanceof HTMLElement && !menu.hidden && playerWidth >= 640
    ? Math.min(menu.getBoundingClientRect().width + 20, playerWidth * .34)
    : 0;
  const appearance = normalizeVideoSubtitleAppearance(config.videoSubtitleAppearance);
  Object.entries(getVideoSubtitleAppearanceCssVars(appearance)).forEach(([name, value]) => panel.style.setProperty(name, value));
  panel.dataset.fluentReadSubtitleSkin = appearance.skin;
  const availableWidth = Math.max(Math.min(playerWidth - 24 - menuReserve, playerWidth * appearance.maxWidth / 100), 160);
  const baseFontSize = Math.min(Math.max(playerWidth * .022, 16), 30);
  const fontScale = appearance.fontScale / 100;
  panel.style.setProperty('--fluent-read-video-subtitle-font-size', `${baseFontSize * fontScale}px`);

  // 双语面板固定在播放器底部安全区上方；字幕内容变化只会改变面板向上的高度，
  // 不会把整组字幕重新锚定到不同的 top。
  const active = Boolean(overlay.textContent?.trim() || normalizedOverlay?.textContent?.trim());
  panel.classList.toggle(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS, active);
  panel.style.width = 'max-content';
  panel.style.setProperty('max-width', `${availableWidth}px`, 'important');
  const playerHeight = playerRect.height || 540;
  const autoBottom = isXVideoPage() && appearance.position === 'bottom' && appearance.autoBottom;
  const offset = autoBottom ? getXSubtitleBottomInset(player) : appearance.bottomOffset === 10 ? Math.min(Math.max(playerHeight * .1, 52), 96) : Math.max(12, playerHeight * appearance.bottomOffset / 100);
  panel.style.setProperty('--fluent-read-video-subtitle-bottom', `${offset}px`);
  panel.style.setProperty('top', appearance.position === 'top' ? `${offset}px` : appearance.position === 'center' ? '50%' : 'auto', 'important');
  panel.style.setProperty('bottom', appearance.position === 'bottom' ? 'var(--fluent-read-video-subtitle-bottom)' : 'auto', 'important');
  panel.style.transform = appearance.position === 'center' ? 'translateY(-50%)' : 'none';
  if (!active) return;

  // 背景只包住双语文本，并以播放器中心为锚点。长字幕仍受播放器宽度限制，
  // 超出时在面板内部换行，而不是把半透明背景铺满整行。
  panel.style.left = '12px';
  const measuredWidth = panel.getBoundingClientRect().width;
  const width = Math.min(Math.max(measuredWidth, 0), availableWidth);
  const usableRight = playerWidth - menuReserve - 12;
  const left = Math.max(12, Math.min((usableRight - width + 12) / 2, usableRight - width));
  panel.style.left = `${left}px`;

  // 双语模式下原生字幕仍然可见时，译文面板要放在原生字幕上方，不能用固定底部
  // 位置压住 YouTube 的分段字幕。逐词合并已经显示整段原文时，原文在同一个面板内，
  // 则继续使用固定底部锚点，避免随着原生 DOM 的词宽变化上下跳动。
  const layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  const normalizedCaptionActive = layer?.classList.contains(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS) === true;
  if (!isXVideoPage() && appearance.position === 'bottom' && displayMode === 'bilingual' && !normalizedCaptionActive && visibleCaptionSegments.length > 0) {
    const playerHeight = playerRect.height || 540;
    const nativeCaptionTop = Math.min(...visibleCaptionSegments.map((rect) => rect.top - playerRect.top));
    const panelHeight = panel.getBoundingClientRect().height;
    const fallbackBottom = Math.min(Math.max(playerHeight * .1, 52), 96);
    const maxBottom = Math.max(12, playerHeight - panelHeight - 12);
    const requestedBottom = playerHeight - nativeCaptionTop + 8;
    const bottom = Math.max(fallbackBottom, Math.min(requestedBottom, maxBottom));
    panel.style.setProperty('--fluent-read-video-subtitle-bottom', `${bottom}px`);
  }
}

export function applyVideoDisplayState(container: HTMLElement): void {
  const mode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  container.classList.toggle(VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS, mode === 'translation-only');
  container.classList.toggle(VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS, mode === 'original-only');
  container.classList.toggle(VIDEO_DISPLAY_HIDDEN_CLASS, config.videoSubtitleVisible === false);
  container.setAttribute('data-fluent-read-video-display-mode', mode);
  const layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  layer?.classList.toggle(VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS, mode === 'translation-only');
  layer?.classList.toggle(VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS, mode === 'original-only');
  layer?.classList.toggle(VIDEO_DISPLAY_HIDDEN_CLASS, config.videoSubtitleVisible === false);
  layer?.setAttribute('data-fluent-read-video-display-mode', mode);
}

export function installVideoSubtitleStyle(): HTMLStyleElement {
  const existing = document.getElementById('fluent-read-video-subtitle-style');
  if (existing instanceof HTMLStyleElement) return existing;

  const style = document.createElement('style');
  style.id = 'fluent-read-video-subtitle-style';
  style.textContent = `
    .fluent-read-video-menu-item[hidden] { display: none !important; }
    .fluent-read-video-local-guide { margin: 0 0 4px !important; font-size: 11px !important; color: #bbb !important; }
    .fluent-read-video-local-guide summary { cursor: pointer !important; padding: 2px 4px !important; }
    .fluent-read-video-local-guide p { margin: 6px 4px !important; line-height: 1.45 !important; font-size: 11px !important; color: #bbb !important; }

    #${VIDEO_AI_CAPTION_CONTAINER_ID} {
      position: absolute !important;
      inset: auto 0 0 !important;
      z-index: 1 !important;
      width: 100% !important;
      min-height: 1px !important;
      opacity: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
      overflow: hidden !important;
    }
    #${VIDEO_AI_CAPTION_CONTAINER_ID} .${VIDEO_CAPTION_SEGMENT_SELECTOR.slice(1)} {
      display: block !important;
    }
    #${VIDEO_TRANSLATION_LAYER_ID} {
      position: absolute !important;
      inset: 0 !important;
      z-index: 2147483645 !important;
      overflow: visible !important;
      pointer-events: none !important;
      visibility: visible !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID} {
      display: none !important;
      position: absolute !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
      max-width: calc(100% - 24px) !important;
      bottom: var(--fluent-read-video-subtitle-bottom, clamp(52px, 10%, 96px)) !important;
      margin: 0 !important;
      padding: 5px 8px 6px !important;
      border: 1px solid var(--fluent-read-video-subtitle-border, rgba(255, 255, 255, .1)) !important;
      border-radius: 6px !important;
      background: var(--fluent-read-video-subtitle-background, rgba(12, 15, 22, .56)) !important;
      box-shadow: var(--fluent-read-video-subtitle-shadow, 0 2px 6px rgba(0, 0, 0, .24)) !important;
      backdrop-filter: var(--fluent-read-video-subtitle-backdrop-filter, blur(2px)) !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: 6px !important;
      overflow: visible !important;
      pointer-events: none !important;
      user-select: none !important;
      text-align: center !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID}.${VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS} {
      display: flex !important;
    }
    #${VIDEO_TRANSLATION_OVERLAY_ID} {
      display: block !important;
      position: relative !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
      width: auto !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      color: var(--fluent-read-video-subtitle-translation-color, #ffe45c) !important;
      font-family: var(--fluent-read-video-subtitle-font-family, Arial), "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
      font-size: var(--fluent-read-video-subtitle-font-size, clamp(16px, 2.2vw, 30px)) !important;
      font-weight: 700 !important;
      line-height: var(--fluent-read-video-subtitle-line-spacing, 1.28) !important;
      text-align: center !important;
      -webkit-text-stroke: var(--fluent-read-video-subtitle-text-stroke, 1px #000) !important;
      paint-order: stroke fill !important;
      text-shadow: var(--fluent-read-video-subtitle-text-shadow, 0 1px 2px rgba(0, 0, 0, .72)) !important;
      white-space: pre-wrap !important;
      pointer-events: none !important;
      user-select: none !important;
      visibility: visible !important;
    }
    #${VIDEO_TRANSLATION_OVERLAY_ID}:empty { display: none !important; }
    #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      display: none !important;
      position: relative !important;
      z-index: 1 !important;
      box-sizing: border-box !important;
      width: auto !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      color: var(--fluent-read-video-subtitle-text-color, #fff) !important;
      font-family: var(--fluent-read-video-subtitle-font-family, Arial), "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
      font-size: var(--fluent-read-video-subtitle-font-size, clamp(16px, 2.2vw, 30px)) !important;
      font-weight: 600 !important;
      line-height: var(--fluent-read-video-subtitle-line-spacing, 1.28) !important;
      text-align: center !important;
      -webkit-text-stroke: var(--fluent-read-video-subtitle-text-stroke, 0) !important;
      paint-order: stroke fill !important;
      text-shadow: var(--fluent-read-video-subtitle-text-shadow, 0 1px 2px rgba(0, 0, 0, .9)) !important;
      white-space: pre-wrap !important;
      pointer-events: none !important;
      user-select: none !important;
      visibility: visible !important;
    }
    #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}:empty { display: none !important; }
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      display: block !important;
    }
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID},
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS} #${VIDEO_TRANSLATION_OVERLAY_ID},
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_DISPLAY_HIDDEN_CLASS} {
      visibility: hidden !important;
    }
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      display: none !important;
    }
    #ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .ytp-caption-segment,
    #ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .captions-text,
    .ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .ytp-caption-segment,
    .ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .captions-text {
      visibility: hidden !important;
    }
    #${VIDEO_TRANSLATION_LAYER_ID}.${VIDEO_DISPLAY_HIDDEN_CLASS} {
      visibility: hidden !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID} {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      align-self: center !important;
      flex: 0 0 auto !important;
      width: 32px !important;
      height: 32px !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      color: #fff !important;
      cursor: pointer !important;
      font: inherit !important;
      line-height: 1 !important;
      vertical-align: middle !important;
      opacity: .9 !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}[${VIDEO_PLAYER_PROGRESS_ATTRIBUTE}] {
      width: auto !important;
      min-width: 32px !important;
      gap: 4px !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}[${VIDEO_PLAYER_PROGRESS_ATTRIBUTE}]::after {
      content: attr(${VIDEO_PLAYER_PROGRESS_ATTRIBUTE}) !important;
      display: inline-block !important;
      color: rgba(255, 255, 255, .82) !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      line-height: 1 !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}:hover,
    #${VIDEO_TRANSLATION_BUTTON_ID}:focus-visible { opacity: 1 !important; }
    #${VIDEO_TRANSLATION_BUTTON_ID} .fluent-read-video-subtitle-button-icon {
      display: block !important;
      width: 16px !important;
      height: 16px !important;
      border-radius: 4px !important;
      background: transparent !important;
      object-fit: cover !important;
      overflow: hidden !important;
      transform: translateY(0) !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}.fluent-read-video-subtitle-x-button {
      width: 28px !important;
      height: 28px !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}.fluent-read-video-subtitle-x-button[${VIDEO_PLAYER_PROGRESS_ATTRIBUTE}] {
      width: auto !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}.${VIDEO_TRANSLATION_ACTIVE_CLASS} .fluent-read-video-subtitle-button-icon {
      background: #ec4899 !important;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .16), 0 2px 8px rgba(236, 72, 153, .42) !important;
    }
    #${VIDEO_TRANSLATION_BUTTON_ID}:not(.${VIDEO_TRANSLATION_ACTIVE_CLASS}) .fluent-read-video-subtitle-button-icon {
      background: rgba(236, 72, 153, .16) !important;
      box-shadow: 0 0 0 1px rgba(236, 72, 153, .62), 0 2px 8px rgba(236, 72, 153, .2) !important;
    }
    .${VIDEO_FALLBACK_CONTROLS_CLASS} {
      position: absolute !important;
      right: 8px !important;
      bottom: 8px !important;
      z-index: 2147483646 !important;
      display: none !important;
      align-items: center !important;
      min-height: 32px !important;
      border-radius: 6px !important;
      background: rgba(0, 0, 0, .22) !important;
    }
    .${VIDEO_PLAYER_HOST_CLASS}[${VIDEO_PLAYER_ACTIVE_ATTRIBUTE}="true"] .${VIDEO_FALLBACK_CONTROLS_CLASS},
    .${VIDEO_PLAYER_HOST_CLASS}:fullscreen .${VIDEO_FALLBACK_CONTROLS_CLASS},
    .${VIDEO_PLAYER_HOST_CLASS}[data-fluent-read-video-fullscreen="true"] .${VIDEO_FALLBACK_CONTROLS_CLASS} {
      display: flex !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} {
      position: absolute !important;
      right: 8px !important;
      bottom: 40px !important;
      z-index: 2147483646 !important;
      width: min(248px, calc(100vw - 24px)) !important;
      min-width: 0 !important;
      max-width: calc(100% - 16px) !important;
      max-height: calc(100% - 48px) !important;
      box-sizing: border-box !important;
      padding: 10px !important;
      border: 1px solid rgba(255, 255, 255, .12) !important;
      border-radius: 14px !important;
      background: rgba(28, 28, 32, .97) !important;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .32) !important;
      color: #f7f7f8 !important;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif !important;
      writing-mode: horizontal-tb !important;
      text-orientation: mixed !important;
      word-break: normal !important;
      white-space: normal !important;
      overflow: auto !important;
      overscroll-behavior: contain !important;
      scrollbar-width: thin !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[hidden] { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} * {
      box-sizing: border-box !important;
      font-family: inherit !important;
      text-transform: none !important;
      letter-spacing: normal !important;
      text-shadow: none !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-title {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 8px !important;
      min-height: 24px !important;
      padding: 0 4px 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-brand {
      flex: 0 0 auto !important;
      color: #ff8fbd !important;
      font-size: 12px !important;
      font-weight: 600 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode {
      all: unset !important;
      display: flex !important;
      align-items: center !important;
      width: 100% !important;
      min-height: 32px !important;
      box-sizing: border-box !important;
      padding: 6px !important;
      border-radius: 8px !important;
      background: transparent !important;
      color: #f7f7f8 !important;
      cursor: pointer !important;
      font: inherit !important;
      text-align: left !important;
      min-width: 0 !important;
      gap: 6px !important;
      writing-mode: horizontal-tb !important;
      word-break: normal !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item:hover,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode:hover {
      background: rgba(255, 255, 255, .07) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item:focus-visible,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode:focus-visible {
      outline: 2px solid #ff8fbd !important;
      outline-offset: -2px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item:disabled {
      cursor: default !important;
      opacity: .55 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-label {
      display: block !important;
      min-width: 0 !important;
      flex: 1 1 auto !important;
      font: inherit !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-value {
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      color: rgba(255, 255, 255, .58) !important;
      font-size: 11px !important;
      font-weight: 400 !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-value:empty { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch .fluent-read-video-menu-value,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-settings .fluent-read-video-menu-label {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      overflow: hidden !important;
      clip-path: inset(50%) !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-check {
      display: none !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch .fluent-read-video-menu-check {
      display: block !important;
      position: relative !important;
      width: 28px !important;
      height: 16px !important;
      flex: 0 0 28px !important;
      border-radius: 10px !important;
      background: rgba(255, 255, 255, .23) !important;
      color: transparent !important;
      font-size: 0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch .fluent-read-video-menu-check::after {
      content: "" !important;
      position: absolute !important;
      left: 2px !important;
      top: 2px !important;
      width: 12px !important;
      height: 12px !important;
      border-radius: 50% !important;
      background: #fff !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch[aria-checked="true"] .fluent-read-video-menu-check { background: #ec4899 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-switch[aria-checked="true"] .fluent-read-video-menu-check::after { left: 14px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-settings {
      width: auto !important;
      min-height: 24px !important;
      padding: 3px 0 3px 6px !important;
      color: rgba(255, 255, 255, .52) !important;
      font-size: 10px !important;
      justify-content: flex-end !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-service {
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-gear { font-size: 15px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode-group {
      display: flex !important;
      gap: 2px !important;
      padding: 3px !important;
      border-radius: 9px !important;
      background: rgba(255, 255, 255, .05) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode {
      width: auto !important;
      flex: 1 !important;
      min-height: 28px !important;
      justify-content: center !important;
      text-align: center !important;
      padding: 4px 2px !important;
      color: rgba(255, 255, 255, .62) !important;
      font-size: 11px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode[aria-checked="true"] {
      background: rgba(236, 72, 153, .18) !important;
      color: #ffacd0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai-group,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-downloads {
      margin-top: 10px !important;
      padding-top: 10px !important;
      border-top: 1px solid rgba(255, 255, 255, .09) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} [data-action="toggle-ai-subtitle"] {
      padding: 8px 10px !important;
      border: 1px solid rgba(236, 72, 153, .2) !important;
      background: rgba(236, 72, 153, .12) !important;
      color: #ffacd0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} [data-action="toggle-ai-subtitle"]:hover { background: rgba(236, 72, 153, .2) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} [data-action="toggle-ai-subtitle"][data-error="true"] {
      flex-direction: column !important;
      align-items: flex-start !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-downloads {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
      gap: 4px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-downloads .fluent-read-video-menu-item {
      flex-direction: column !important;
      justify-content: center !important;
      text-align: center !important;
      font-size: 11px !important;
      color: rgba(255, 255, 255, .66) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item[aria-busy="true"] .fluent-read-video-menu-value::before {
      content: "" !important;
      display: inline-block !important;
      flex: 0 0 auto !important;
      width: 9px !important;
      height: 9px !important;
      border: 1.5px solid rgba(255, 255, 255, .28) !important;
      border-top-color: #ff8fbd !important;
      border-radius: 50% !important;
      animation: fluent-read-video-download-spin .72s linear infinite !important;
    }
    @keyframes fluent-read-video-download-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-item[aria-busy="true"] .fluent-read-video-menu-value::before { animation: none !important; }
    }
    #ytp-caption-window-container.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} .ytp-caption-segment,
    #ytp-caption-window-container.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} .captions-text,
    .ytp-caption-window-container.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} .ytp-caption-segment,
    .ytp-caption-window-container.${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} .captions-text {
      visibility: hidden !important;
    }
    #ytp-caption-window-container.${VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS} #${VIDEO_TRANSLATION_OVERLAY_ID},
    .ytp-caption-window-container.${VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS} #${VIDEO_TRANSLATION_OVERLAY_ID},
    #ytp-caption-window-container.${VIDEO_DISPLAY_HIDDEN_CLASS},
    .ytp-caption-window-container.${VIDEO_DISPLAY_HIDDEN_CLASS} {
      visibility: hidden !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  return style;
}


export function getVideoSubtitleDownloadErrorMessage(error: unknown, language: UiLanguage = 'zh-CN'): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('没有可用的 YouTube 字幕轨道')) return localizeVideoUiText('当前视频没有字幕', language);
  if (message.includes('未返回完整字幕数据') || message.includes('先打开原生字幕')) {
    return localizeVideoUiText('请先开启 YouTube 字幕', language);
  }
  if (message.includes('字幕轨道请求失败')) return localizeVideoUiText('获取失败，请重试', language);
  return localizeVideoUiText('下载失败，请重试', language);
}
