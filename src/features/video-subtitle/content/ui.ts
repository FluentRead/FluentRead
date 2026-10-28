/**
 * @file src/features/video-subtitle/content/ui.ts
 *
 * 文件职责：封装视频字幕 content UI 的界面语言转换、可访问名称刷新及桌面/触屏安全视口菜单样式，避免 YouTube 播放器运行时承载重复的文案拼装。
 * 主要内容：提供视频菜单本地化、局部外观变量、显式读音开关与示例说明、紧凑下载折叠入口、独立纯文本读音行及按语言命名；双语顺序用原文与译文双行示意并标记暂未生效的偏好，字幕按偏好交换原译文顺序，读音始终紧跟原文并计入字幕布局，防止缩成不可读小字；菜单仅管理自身交互，不参与字幕的宽度与水平居中计算；保留逐字高亮、校时与就地模型选择控件，过滤 YouTube 滚动窗口旧行，按实际画面及同视频可见底控约束字幕几何、换行与大字号完整高度，并封装字幕清理、媒体时钟读取、样式及字幕下载。
 * 模块边界：只读取界面配置并操作视频 feature 拥有的节点、样式和下载链接，不发起翻译或识别请求；任务生命周期由 runtime 管理。
 */

import {getVideoSubtitleAppearanceCssVars, normalizeVideoSubtitleAppearance} from '@/src/core/config/videoSubtitleAppearance';
import {config} from '@/src/services/config/store';
import {type VideoSubtitleDisplayMode} from '@/src/core/config/model';
import {cuesToSrt, sanitizeSubtitleFilename, type VideoSubtitleCue} from './youtubeSubtitleData';
import {getCaptionPlatform} from './platforms';
import {timedTextTrackKey} from './timedTextTrackCache';
import {fitVideoSubtitleFontSize} from './subtitleLayout';
import {getYoutubeSubtitleControlsScope} from './youtubeControlsScope';
import {getVisibleYoutubeSubtitleControls, positionMobileYoutubeSubtitle, resetSubtitlePanelLayout, finishSubtitlePanelLayout,
  prepareSubtitlePanelLayout, findOwnedSubtitlePanel, syncSubtitleScrollHostState, setSubtitlePanelScrollable, VIDEO_SUBTITLE_SCROLL_HOST_ID} from './subtitleControlLayout';
import {createVideoKaraokeController, setVideoCaptionText, type VideoKaraokeController, VIDEO_KARAOKE_FILL_PROPERTY, VIDEO_KARAOKE_STATE_ATTRIBUTE, VIDEO_KARAOKE_TEXT_ATTRIBUTE, VIDEO_KARAOKE_UNIT_CLASS} from './karaoke';

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

function readI18nParams(element: HTMLElement): TranslationParams | undefined {
    if (!element.dataset.i18nParams) return undefined;
    try {
        return JSON.parse(element.dataset.i18nParams) as TranslationParams;
    } catch {
        return undefined;
    }
}

/** 界面语言变化时按节点上记录的文案键重新填充文字、可访问名称与提示。 */
export function refreshVideoUiText(root: HTMLElement, language: UiLanguage): void {
    root.querySelectorAll<HTMLElement>('[data-i18n-key]').forEach((element) => {
        element.textContent = translateVideoUi(element.dataset.i18nKey!, language, readI18nParams(element));
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-aria-key]').forEach((element) => {
        const label = translateVideoUi(element.dataset.i18nAriaKey!, language);
        element.setAttribute('aria-label', label);
        element.title = label;
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-title-key]').forEach((element) => {
        element.title = translateVideoUi(element.dataset.i18nTitleKey!, language);
    });
}

export function refreshVideoUiAccessibility(
    menu: HTMLElement,
    button: HTMLElement | null,
    document: Document,
    language: UiLanguage,
    status: string,
): void {
    menu.setAttribute('aria-label', translateVideoUi('video.menuAriaLabel', language));
    menu.querySelector<HTMLElement>('.fluent-read-video-menu-mode-group')?.setAttribute('aria-label', translateVideoUi('video.displayMode', language));
    const buttonLabel = translateVideoUi('video.buttonAriaLabel', language, {status});
    button?.setAttribute('aria-label', buttonLabel);
    if (button) button.title = buttonLabel;
    document.getElementById('fluent-read-video-subtitle-panel')?.setAttribute('aria-label', translateVideoUi('video.panelAriaLabel', language));
    document.getElementById('fluent-read-video-subtitle')?.setAttribute('aria-label', translateVideoUi('video.translationOverlayAriaLabel', language));
    document.getElementById('fluent-read-video-subtitle-original')?.setAttribute('aria-label', translateVideoUi('video.originalOverlayAriaLabel', language));
    const reading = document.getElementById(VIDEO_READING_OVERLAY_ID);
    if (reading) reading.setAttribute('aria-label', translateVideoUi(reading.dataset.readingLabelKey || 'video.readingAnnotation.label', language));
}

export const VIDEO_AI_CAPTION_CONTAINER_ID = 'fluent-read-video-ai-caption-container';
export const VIDEO_CAPTION_CONTAINER_SELECTOR = '#ytp-caption-window-container, .ytp-caption-window-container, #fluent-read-video-ai-caption-container';
export const VIDEO_CAPTION_SEGMENT_SELECTOR = '.ytp-caption-segment';
export const VIDEO_TRANSLATION_OVERLAY_ID = 'fluent-read-video-subtitle';
export const VIDEO_NORMALIZED_CAPTION_OVERLAY_ID = 'fluent-read-video-subtitle-original';
export const VIDEO_READING_OVERLAY_ID = 'fluent-read-video-subtitle-reading';
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

export const VIDEO_CAPTION_STABILITY_MS = 80;
export const VIDEO_CAPTION_MAX_WAIT_MS = 240;
export const VIDEO_CAPTION_FALLBACK_SEGMENT_SELECTOR = '.captions-text';
export const VIDEO_SUBTITLE_DOWNLOAD_CONCURRENCY = 3;


export function normalizeVideoSubtitleDisplayMode(value: unknown): VideoSubtitleDisplayMode {
  if (value === 'translation-only' || value === 'original-only') return value;
  return 'bilingual';
}

export function isVideoKaraokeEnabled(): boolean {
  return config.videoSubtitleAppearance?.karaoke === true;
}

/** FluentRead 字幕行统一从这里写入，逐字高亮开启时拆成可点亮的单元。 */
export function writeVideoCaptionText(element: Element, text: string): void {
  setVideoCaptionText(element, text, isVideoKaraokeEnabled());
}

/** 为播放器字幕装配逐字高亮：当前句的起点计入手动校时；sync 在配置变化后按新的开关重写已显示的字幕行。 */
export function createVideoSubtitleKaraoke(
  getVideo: () => HTMLVideoElement | null,
  getCue: () => VideoSubtitleCue | null,
  getOffsetMs: () => number,
): VideoKaraokeController {
  const getLines = () => [VIDEO_NORMALIZED_CAPTION_OVERLAY_ID, VIDEO_TRANSLATION_OVERLAY_ID]
    .flatMap(id => document.getElementById(id) || []);
  const controller = createVideoKaraokeController({
    window,
    document,
    isEnabled: isVideoKaraokeEnabled,
    getVideo,
    getLines,
    getTiming: () => {
      const cue = getCue();
      return cue ? {startMs: cue.startMs + getOffsetMs(), durationMs: cue.durationMs} : null;
    },
  });
  return {
    sync: () => {
      getLines().forEach(line => writeVideoCaptionText(line, line.textContent || ''));
      controller.sync();
    },
    destroy: controller.destroy,
  };
}

/** 人工轨到达时原文与译文一起更新；网站字幕节点及原始时间轴保持不变。 */
export function renderHumanVideoCaption(player: HTMLElement, container: HTMLElement, source: string, translation: string): void {
  writeVideoCaptionText(getOrCreateNormalizedCaptionOverlay(player), source);
  const layer = player.querySelector<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`);
  layer?.classList.add(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
  if (layer) syncSubtitleScrollHostState(layer);
  container.classList.add(VIDEO_NORMALIZED_CAPTION_CLASS);
  writeVideoCaptionText(getOrCreateTranslationOverlay(player), translation);
  syncTranslationOverlayPosition(container);
}

/** 读音为独立纯文本行，不污染原文 textContent 或参与估算的逐字高亮。 */
export function renderVideoReadingAnnotation(player: HTMLElement, text: string, language = ''): boolean {
  let line = document.getElementById(VIDEO_READING_OVERLAY_ID);
  if (!line && !text) return false;
  const panel = getOrCreateVideoSubtitlePanel(player);
  if (!line) {
    line = document.createElement('div'); line.id = VIDEO_READING_OVERLAY_ID;
    markVideoUi(line); line.setAttribute('dir','ltr'); panel.appendChild(line);
  }
  if (line.parentElement !== panel) panel.appendChild(line);
  const changed = line.textContent !== text;
  if (changed) line.textContent = text;
  line.lang = language ? `${language}-Latn` : '';
  line.dataset.readingLabelKey = `video.readingAnnotation.${language || 'label'}`;
  line.setAttribute('aria-label', videoUi(line.dataset.readingLabelKey));
  return changed;
}


export function getTimedTextCacheKey(url: string): string { return timedTextTrackKey(url, window.location.href); }

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
  return isYouTubeVideoPage(locationLike) || isXVideoPage(locationLike) || getCaptionPlatform(locationLike) !== null;
}

/** 读取当前播放器可见的原生字幕，不读取插件自己的译文节点。 */
export function getVisibleCaptionSegments(container: Element): HTMLElement[] {
  const nativeSegments = Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR));
  const candidates = nativeSegments.length > 0
    ? nativeSegments
    : Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_FALLBACK_SEGMENT_SELECTOR));

  const candidateSet = new Set(candidates);
  return candidates.filter((segment) => {
    // 查询不包含容器自身；只排除本次候选中的祖先，保留外层片段的完整文本。
    for (let ancestor = segment.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      if (candidateSet.has(ancestor)) return false;
    }
    const rollup = segment.closest?.('.ytp-caption-window-rollup');
    if (!rollup) return true;
    const windowRect = rollup.getBoundingClientRect();
    const segmentRect = segment.getBoundingClientRect();
    // visibility:hidden 是插件隐藏原生行的方式，不能据此过滤；只排除
    // YouTube 滚动窗口实际裁掉的旧行。未布局时保留原文，避免误判为空。
    return !windowRect.height || !segmentRect.height
      || (segmentRect.bottom > windowRect.top && segmentRect.top < windowRect.bottom);
  });
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
  const candidates = Array.from((findVideoPlayer() || document).querySelectorAll<HTMLElement>(VIDEO_CAPTION_CONTAINER_SELECTOR));
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
  if (layer.parentElement !== player) {
    const panel = findOwnedSubtitlePanel(layer, VIDEO_SUBTITLE_PANEL_ID);
    if (panel) resetSubtitlePanelLayout(panel, true);
    player.appendChild(layer);
  }
  return layer;
}

export function getOrCreateVideoSubtitlePanel(player: HTMLElement): HTMLElement {
  const layer = getOrCreateVideoSubtitleLayer(player);
  const existing = findOwnedSubtitlePanel(layer, VIDEO_SUBTITLE_PANEL_ID);
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

/** 字幕运行时只保留状态所有权，自有 DOM 的清空交由 UI 层完成。 */
export function clearRenderedVideoTranslation(owner: Document): void {
  owner.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => resetSubtitlePanelLayout(panel));
  owner.querySelectorAll(`#${VIDEO_TRANSLATION_OVERLAY_ID}`).forEach(node => writeVideoCaptionText(node, ''));
  owner.querySelectorAll(`#${VIDEO_READING_OVERLAY_ID}`).forEach(node => {node.textContent='';});
}

export function deactivateNormalizedVideoCaption(owner: Document): void {
  owner.querySelectorAll(VIDEO_CAPTION_CONTAINER_SELECTOR).forEach(node => node.classList.remove(VIDEO_NORMALIZED_CAPTION_CLASS));
  owner.querySelectorAll<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`).forEach(node => {node.classList.remove(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS); syncSubtitleScrollHostState(node);});
  owner.querySelectorAll(`#${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}`).forEach(node => writeVideoCaptionText(node, ''));
}

/** 读取当前播放器媒体；暂未挂载或时间无效时不编造播放位置。 */
export function readVideoPlaybackTimeMs(player: HTMLElement | null, fallback: HTMLVideoElement | null): number {
  const video = player?.querySelector<HTMLVideoElement>('video.html5-main-video, video') || fallback;
  const time = video?.currentTime;
  return typeof time === 'number' && Number.isFinite(time) ? time * 1000 : Number.NaN;
}

export function removeTranslationOverlay(): void {
  document.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => resetSubtitlePanelLayout(panel, true));
  document.querySelectorAll(`#${VIDEO_TRANSLATION_LAYER_ID}`).forEach((node) => node.remove());
  document.querySelectorAll(`#${VIDEO_TRANSLATION_OVERLAY_ID}`).forEach((node) => node.remove());
  document.querySelectorAll(`#${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}`).forEach((node) => node.remove());
}

/** X 的原生字幕已隐藏，贴底时只避开实际可见的播放控件，不预留原文区域。 */
export function getXSubtitleBottomInset(player: HTMLElement, viewport?: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'height'>): number {
  const playerRect = viewport || player.getBoundingClientRect();
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
    if (visible && (!viewport || (rect.right > viewport.left && rect.left < viewport.right))
      && rect.top >= playerRect.top + playerRect.height * .65 && rect.top < playerRect.bottom) {
      return Math.max(12, playerRect.bottom - rect.top + 8);
    }
  }
  const video = player.querySelector('video');
  // 浏览器自带 controls 在 closed shadow tree 中，无法测量；交互时预留一行按钮高度。
  if (video?.controls && (video.paused || player.matches(':hover') || player.contains(document.activeElement))) return 56;
  return 12;
}

/** 将实际视频画面（扣除 contain 留白）换算到字幕层坐标；YouTube 移动页面和 X 共用，不改写宿主视频布局。 */
export function getVideoSubtitleViewport(player: HTMLElement, layer: HTMLElement) {
  const video = player.querySelector('video');
  const layerRect = layer.getBoundingClientRect();
  const playerRect = player.getBoundingClientRect();
  const videoRect = video?.getBoundingClientRect();
  if (!video || !videoRect || videoRect.width <= 0 || videoRect.height <= 0 || layerRect.width <= 0 || layerRect.height <= 0) return null;
  const style = getComputedStyle(video);
  let width = videoRect.width;
  let height = videoRect.height;
  // X 的竖屏 video 经常占满宽播放器，但可见画面只占中间一列。
  if (video.videoWidth > 0 && video.videoHeight > 0 && ['contain', 'cover', 'none', 'scale-down'].includes(style.objectFit)) {
    const scaleX = video.offsetWidth > 0 ? videoRect.width / video.offsetWidth : 1;
    const scaleY = video.offsetHeight > 0 ? videoRect.height / video.offsetHeight : 1;
    const ratios = [width / scaleX / video.videoWidth, height / scaleY / video.videoHeight];
    const fit = style.objectFit === 'none' ? 1 : style.objectFit === 'cover' ? Math.max(...ratios)
      : Math.min(...ratios, style.objectFit === 'scale-down' ? 1 : Infinity);
    width = video.videoWidth * fit * scaleX;
    height = video.videoHeight * fit * scaleY;
  }
  // 浏览器把 right 10px bottom 5px 序列化为两个 calc，表达式内部空格不能拆成坐标。
  const positions = (style.objectPosition || '50% 50%').match(/calc\([^)]*\)|\S+/g) || [];
  const positionOffset = (value: string, space: number, scale: number) => {
    if (value === 'left' || value === 'top') return 0;
    if (value === 'right' || value === 'bottom') return space;
    if (/^-?[\d.]+%$/.test(value)) return space * Number.parseFloat(value) / 100;
    if (/^-?[\d.]+px$/.test(value)) return Number.parseFloat(value) * scale;
    const calculated = /^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/.exec(value);
    if (calculated) return space * Number(calculated[1]) / 100 + (calculated[2] === '-' ? -1 : 1) * Number(calculated[3]) * scale;
    return space / 2;
  };
  const x = videoRect.left + positionOffset(positions[0] || '50%', videoRect.width - width, video.offsetWidth > 0 ? videoRect.width / video.offsetWidth : 1);
  const y = videoRect.top + positionOffset(positions[1] || '50%', videoRect.height - height, video.offsetHeight > 0 ? videoRect.height / video.offsetHeight : 1);
  const left = Math.max(x, videoRect.left, playerRect.left, layerRect.left);
  const top = Math.max(y, videoRect.top, playerRect.top, layerRect.top);
  const right = Math.min(x + width, videoRect.right, playerRect.right, layerRect.right);
  const bottom = Math.min(y + height, videoRect.bottom, playerRect.bottom, layerRect.bottom);
  const scaleX = layer.clientWidth > 0 ? layerRect.width / layer.clientWidth : 1;
  const scaleY = layer.clientHeight > 0 ? layerRect.height / layer.clientHeight : 1;
  return {
    left: (left - layerRect.left) / scaleX,
    top: (top - layerRect.top) / scaleY,
    width: Math.max(0, right - left) / scaleX,
    height: Math.max(0, bottom - top) / scaleY,
    right: (layerRect.right - right) / scaleX,
    bottom: (layerRect.bottom - bottom) / scaleY,
    controlsInset: (isXVideoPage() ? getXSubtitleBottomInset(player, {left, right, top, bottom, height: Math.max(0, bottom - top)})
      : getYoutubeSubtitleBottomInset(player, {left, right, top, bottom, height: Math.max(0, bottom - top)})) / scaleY,
  };
}

/** 只避开真实可见的底部控件；移动视频高度不足时不能保留桌面的 52px 起步底距。 */
function getYoutubeSubtitleBottomInset(player: HTMLElement, viewport: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'height'>): number {
  let inset = 12;
  for (const rect of getVisibleYoutubeSubtitleControls(player)) {
    if (rect.right <= viewport.left || rect.left >= viewport.right || rect.top < viewport.top + viewport.height * .65 || rect.top >= viewport.bottom) continue;
    inset = Math.max(inset, viewport.bottom - rect.top + 8);
  }
  return inset;
}

export function syncTranslationOverlayPosition(container: HTMLElement | null): void {
  if (!container) return;
  const overlay = document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID);
  const normalizedOverlay = document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID);
  const panel = document.getElementById(VIDEO_SUBTITLE_PANEL_ID);
  const layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  const player = layer?.parentElement;
  if (!overlay || !panel || !player || !layer) return;

  const playerRect = player.getBoundingClientRect();
  const viewport = getVideoSubtitleViewport(player, layer);
  if (viewport) {
    layer.style.setProperty('clip-path', `inset(${viewport.top}px ${viewport.right}px ${viewport.bottom}px ${viewport.left}px)`, 'important');
  } else {
    if (isXVideoPage()) layer.style.setProperty('clip-path', 'inset(50%)', 'important');
    else layer.style.removeProperty('clip-path');
  }
  // 测量阶段不解除同句滚动交互；临时宿主与原 layer 始终使用相同坐标与显示状态。
  prepareSubtitlePanelLayout(panel, layer, player);
  const visibleCaptionSegments = getVisibleCaptionSegments(container)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  // YouTube 在字幕切换期间会短暂保留一个空的、甚至回到播放器顶部的容器。
  // 没有真实字幕片段时保留上一次位置，避免译文被重新定位到顶部后闪过。

  const playerWidth = viewport ? viewport.width : playerRect.width || 960;
  const menu = document.getElementById(VIDEO_TRANSLATION_MENU_ID);
  const menuOpen = menu instanceof HTMLElement && !menu.hidden;
  const learningOpen = Boolean(getYoutubeSubtitleControlsScope(player).querySelector('#fluent-read-video-learning-panel.fluent-read-video-ui[data-fluent-read-ui="video-subtitle"]'));
  const appearance = normalizeVideoSubtitleAppearance(config.videoSubtitleAppearance);
  Object.entries(getVideoSubtitleAppearanceCssVars(appearance)).forEach(([name, value]) => panel.style.setProperty(name, value));
  panel.dataset.fluentReadSubtitleSkin = appearance.skin;
  const availableWidth = Math.max(0, Math.min(playerWidth - 24, playerWidth * appearance.maxWidth / 100));
  const baseFontSize = Math.min(Math.max(playerWidth * .022, 16), 30);
  const fontScale = appearance.fontScale / 100;
  panel.style.setProperty('--fluent-read-video-subtitle-font-size', `${baseFontSize * fontScale}px`);

  // 双语面板固定在播放器底部安全区上方；字幕内容变化只会改变面板向上的高度，
  // 不会把整组字幕重新锚定到不同的 top。
  const active = Boolean(overlay.textContent?.trim() || normalizedOverlay?.textContent?.trim());
  panel.classList.toggle(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS, active);
  panel.style.width = 'max-content';
  const fullscreen = Boolean(document.fullscreenElement?.contains(player));
  panel.style.setProperty('max-width', fullscreen
    ? `min(${availableWidth}px, calc(100% - max(12px, env(safe-area-inset-left, 0px)) - max(12px, env(safe-area-inset-right, 0px))))`
    : `${availableWidth}px`, 'important');
  const playerHeight = viewport ? viewport.height : playerRect.height || 540;
  const compactPlayer = playerWidth <= 600 || window.matchMedia?.('(pointer: coarse)').matches === true;
  const autoBottom = (isXVideoPage() || compactPlayer) && appearance.position === 'bottom' && appearance.autoBottom;
  const requestedOffset = autoBottom ? viewport?.controlsInset ?? getXSubtitleBottomInset(player) : appearance.bottomOffset === 10 ? Math.min(Math.max(playerHeight * .1, 52), 96) : Math.max(12, playerHeight * appearance.bottomOffset / 100);
  const offset = Math.min(requestedOffset, Math.max(0, playerHeight - 24));
  const bottomInset = `${(viewport?.bottom || 0) + offset}px`;
  panel.style.setProperty('--fluent-read-video-subtitle-bottom', fullscreen ? `max(${bottomInset}, calc(env(safe-area-inset-bottom, 0px) + 12px))` : bottomInset);
  const topInset = `${(viewport?.top || 0) + offset}px`;
  panel.style.setProperty('top', appearance.position === 'top' ? fullscreen ? `max(${topInset}, calc(env(safe-area-inset-top, 0px) + 12px))` : topInset : appearance.position === 'center' ? viewport ? `${viewport.top + playerHeight / 2}px` : '50%' : 'auto', 'important');
  panel.style.setProperty('bottom', appearance.position === 'bottom' ? 'var(--fluent-read-video-subtitle-bottom)' : 'auto', 'important');
  const maximumHeight = Math.max(0, playerHeight - (appearance.position === 'center' ? 24 : offset + 12));
  panel.style.setProperty('max-height', fullscreen ? `min(${maximumHeight}px, calc(100% - max(env(safe-area-inset-top, 0px), env(safe-area-inset-bottom, 0px)) - max(env(safe-area-inset-top, 0px), env(safe-area-inset-bottom, 0px)) - 24px))` : `${maximumHeight}px`, 'important');
  panel.style.transform = appearance.position === 'center' ? 'translateY(-50%)' : 'none';
  if (!active) {resetSubtitlePanelLayout(panel); return;}

  // 背景只包住双语文本，并始终以视频画面中心为锚点；菜单浮层不挤占字幕空间。
  // 长字幕仍受播放器宽度限制，超出时在面板内部换行，而不是把半透明背景铺满整行。
  const centerPanel = () => {
    panel.style.left = `${(viewport?.left || 0) + 12}px`;
    const layerRect = layer.getBoundingClientRect();
    const measuredWidth = panel.getBoundingClientRect().width / (layer.clientWidth > 0 && layerRect.width > 0 ? layerRect.width / layer.clientWidth : 1);
    const width = Math.min(Math.max(measuredWidth, 0), availableWidth);
    const usableRight = playerWidth - 12;
    const left = Math.max(12, Math.min((usableRight - width + 12) / 2, usableRight - width));
    const panelLeft = `${(viewport?.left || 0) + left}px`;
    panel.style.left = fullscreen
      ? `max(${(viewport?.left || 0) + 12}px, env(safe-area-inset-left, 0px), min(${panelLeft}, calc(100% - max(12px, env(safe-area-inset-right, 0px)) - ${width}px)))`
      : panelLeft;
  };
  centerPanel();
  // 菜单或学习面板开启时撤回兄弟宿主；字幕回原层且不接收指针，避免遮挡当前交互面板。
  const adaptive = !menuOpen && !learningOpen && isYouTubeVideoPage() && compactPlayer && autoBottom && config.on !== false && config.videoTranslationEnabled !== false && config.videoSubtitleVisible !== false && viewport
    && positionMobileYoutubeSubtitle(panel, player, layer, viewport, availableWidth);
  if (adaptive) return;
  finishSubtitlePanelLayout(panel, menuOpen || learningOpen);
  fitVideoSubtitleFontSize(baseFontSize * fontScale,
    fullscreen ? Math.min(maximumHeight, panel.clientHeight || maximumHeight) : maximumHeight,
    size => panel.style.setProperty('--fluent-read-video-subtitle-font-size', `${size}px`),
    () => panel.scrollHeight, panel.querySelector(`#${VIDEO_READING_OVERLAY_ID}`)?.textContent ? 16 : 8);
  if (!menuOpen && panel.querySelector(`#${VIDEO_READING_OVERLAY_ID}`)?.textContent && panel.scrollHeight > maximumHeight + 1) setSubtitlePanelScrollable(panel, true);
  centerPanel();

  // 双语模式下原生字幕仍然可见时，译文面板要放在原生字幕上方，不能用固定底部
  // 位置压住 YouTube 的分段字幕。逐词合并已经显示整段原文时，原文在同一个面板内，
  // 则继续使用固定底部锚点，避免随着原生 DOM 的词宽变化上下跳动。
  const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  const normalizedCaptionActive = layer?.classList.contains(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS) === true;
  if (!isXVideoPage() && !compactPlayer && appearance.position === 'bottom' && displayMode === 'bilingual' && !normalizedCaptionActive && visibleCaptionSegments.length > 0) {
    const playerHeight = playerRect.height || 540;
    const nativeCaptionTop = Math.min(...visibleCaptionSegments.map((rect) => rect.top - playerRect.top));
    const panelHeight = panel.getBoundingClientRect().height;
    const fallbackBottom = Math.min(Math.max(playerHeight * .1, 52), 96);
    const maxBottom = Math.max(12, playerHeight - panelHeight - 12);
    const requestedBottom = playerHeight - nativeCaptionTop + 8;
    const bottom = Math.max(fallbackBottom, Math.min(requestedBottom, maxBottom));
    panel.style.setProperty('--fluent-read-video-subtitle-bottom', fullscreen ? `max(${bottom}px, calc(env(safe-area-inset-bottom, 0px) + 12px))` : `${bottom}px`);
  }
}

export function applyVideoDisplayState(container: HTMLElement): void {
  if (config.on === false || config.videoTranslationEnabled === false || config.videoSubtitleVisible === false) {
    document.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => resetSubtitlePanelLayout(panel));
  }
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
  if (layer) syncSubtitleScrollHostState(layer);
}

export function installVideoSubtitleStyle(): HTMLStyleElement {
  const existing = document.getElementById('fluent-read-video-subtitle-style');
  if (existing instanceof HTMLStyleElement) return existing;

  const style = document.createElement('style');
  style.id = 'fluent-read-video-subtitle-style';
  style.textContent = `
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
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}) {
      position: absolute !important;
      inset: 0 !important;
      z-index: 2147483645 !important;
      overflow: hidden !important;
      pointer-events: none !important;
      visibility: visible !important;
    }
    #${VIDEO_SUBTITLE_SCROLL_HOST_ID} {
      inset: auto !important;
      left: 0 !important;
      top: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      transform-origin: 0 0 !important;
      z-index: 2147483646 !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID} {
      display: none !important;
      position: absolute !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
      max-width: calc(100% - 24px) !important;
      min-width: 0 !important;
      bottom: var(--fluent-read-video-subtitle-bottom, clamp(52px, 10%, 96px)) !important;
      margin: 0 !important;
      padding: var(--fluent-read-video-subtitle-padding, 5px 8px 6px) !important;
      border: 1px solid var(--fluent-read-video-subtitle-border, rgba(255, 255, 255, .1)) !important;
      border-radius: 6px !important;
      background: var(--fluent-read-video-subtitle-background, rgba(12, 15, 22, .56)) !important;
      box-shadow: var(--fluent-read-video-subtitle-shadow, 0 2px 6px rgba(0, 0, 0, .24)) !important;
      backdrop-filter: var(--fluent-read-video-subtitle-backdrop-filter, blur(2px)) !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: var(--fluent-read-video-subtitle-gap, 6px) !important;
      overflow: hidden !important;
      pointer-events: none !important;
      user-select: none !important;
      text-align: center !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID}.${VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS} {
      display: flex !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID}[data-fluent-read-subtitle-scrollable="true"] {
      overflow-y: auto !important;
      overflow-x: hidden !important;
      pointer-events: auto !important;
      touch-action: pan-y pinch-zoom !important;
      overscroll-behavior: contain !important;
    }
    #${VIDEO_SUBTITLE_PANEL_ID}[data-fluent-read-subtitle-scrollable="true"] > div { flex-shrink: 0 !important; }
    #${VIDEO_SUBTITLE_PANEL_ID}[data-fluent-read-subtitle-scrollable="true"]:focus-visible { outline: 2px solid currentColor !important; outline-offset: -2px !important; }
    #${VIDEO_TRANSLATION_OVERLAY_ID} {
      order: var(--fluent-read-video-subtitle-translation-order, 3) !important;
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
      overflow-wrap: anywhere !important;
      min-width: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
      visibility: visible !important;
    }
    #${VIDEO_TRANSLATION_OVERLAY_ID}:empty { display: none !important; }
    #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      order: 1 !important;
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
      overflow-wrap: anywhere !important;
      min-width: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
      visibility: visible !important;
    }
    #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}:empty { display: none !important; }
    #${VIDEO_READING_OVERLAY_ID} {
      order: 2 !important; display: block !important; max-width: 100% !important; min-width: 0 !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important;
      font: 500 max(12px, calc(var(--fluent-read-video-subtitle-font-size, 20px) * .72))/1.4 Arial, sans-serif !important;
      color: var(--fluent-read-video-subtitle-text-color, #fff) !important;
      text-align: center !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important;
      text-shadow: var(--fluent-read-video-subtitle-text-shadow, 0 1px 2px #000) !important;
      pointer-events: none !important; user-select: none !important;
    }
    #${VIDEO_READING_OVERLAY_ID}:empty,
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} #${VIDEO_READING_OVERLAY_ID} {display:none !important;}
    /* 逐字高亮：未唱到的字用本行颜色的淡色，唱过的恢复原色，正在唱的字由同字高亮层从行首方向扫过。 */
    #${VIDEO_TRANSLATION_OVERLAY_ID} { --fluent-read-video-karaoke-color: var(--fluent-read-video-subtitle-translation-color, #ffe45c); }
    #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} { --fluent-read-video-karaoke-color: var(--fluent-read-video-subtitle-text-color, #fff); }
    .${VIDEO_KARAOKE_UNIT_CLASS} {
      display: inline-block !important;
      position: relative !important;
      color: color-mix(in srgb, var(--fluent-read-video-karaoke-color) 46%, transparent) !important;
    }
    .${VIDEO_KARAOKE_UNIT_CLASS}[${VIDEO_KARAOKE_STATE_ATTRIBUTE}="sung"] { color: var(--fluent-read-video-karaoke-color) !important; }
    .${VIDEO_KARAOKE_UNIT_CLASS}[${VIDEO_KARAOKE_STATE_ATTRIBUTE}="active"]::after {
      content: attr(${VIDEO_KARAOKE_TEXT_ATTRIBUTE}) !important;
      content: attr(${VIDEO_KARAOKE_TEXT_ATTRIBUTE}) / "" !important;
      position: absolute !important;
      inset: 0 !important;
      color: var(--fluent-read-video-karaoke-color) !important;
      text-shadow: none !important;
      clip-path: inset(-.3em calc(100% - var(${VIDEO_KARAOKE_FILL_PROPERTY}, 0%)) -.3em -.3em) !important;
      pointer-events: none !important;
    }
    .${VIDEO_KARAOKE_UNIT_CLASS}[${VIDEO_KARAOKE_STATE_ATTRIBUTE}="active"]:dir(rtl)::after {
      clip-path: inset(-.3em -.3em -.3em calc(100% - var(${VIDEO_KARAOKE_FILL_PROPERTY}, 0%))) !important;
    }
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      display: block !important;
    }
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID},
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS} #${VIDEO_TRANSLATION_OVERLAY_ID},
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_HIDDEN_CLASS} {
      visibility: hidden !important;
    }
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS} #${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID} {
      display: none !important;
    }
    #ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .ytp-caption-segment,
    #ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .captions-text,
    .ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .ytp-caption-segment,
    .ytp-caption-window-container.${VIDEO_NORMALIZED_CAPTION_CLASS} .captions-text {
      visibility: hidden !important;
    }
    :is(#${VIDEO_TRANSLATION_LAYER_ID}, #${VIDEO_SUBTITLE_SCROLL_HOST_ID}).${VIDEO_DISPLAY_HIDDEN_CLASS} {
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
    /* 视频界面的外观只赋给自有节点，不向宿主网页或独立设置页注入主题。 */
    #${VIDEO_TRANSLATION_MENU_ID}, #fluent-read-video-learning-panel {
      --fr-video-menu-brand: #ef4776;
      --fr-video-menu-brand-strong: #dc315f;
      --fr-video-menu-brand-strong-hover: #cf315e;
      --fr-video-menu-brand-text: #ffadc2;
      --fr-video-menu-brand-soft: rgba(239, 71, 118, .2);
      --fr-video-menu-surface: #18181c;
      --fr-video-menu-border: rgba(255, 255, 255, .1);
      --fr-video-menu-radius: 12px;
      --fr-video-menu-shadow: 0 10px 30px rgba(0, 0, 0, .36);
      --fr-video-menu-text: #f5f5f7;
      --fr-video-menu-muted: rgba(255, 255, 255, .72);
      --fr-video-menu-control: rgba(255, 255, 255, .07);
      --fr-video-menu-control-hover: rgba(255, 255, 255, .12);
    }
    #${VIDEO_TRANSLATION_MENU_ID} {
      position: absolute !important;
      right: 8px !important;
      bottom: 40px !important;
      z-index: 2147483646 !important;
      display: block !important;
      width: min(280px, calc(100% - 16px)) !important;
      min-width: 0 !important;
      max-width: calc(100% - 16px) !important;
      max-height: calc(100% - 48px) !important;
      box-sizing: border-box !important;
      margin: 0 !important;
      padding: 6px !important;
      border: 1px solid var(--fr-video-menu-border) !important;
      border-radius: var(--fr-video-menu-radius) !important;
      background: var(--fr-video-menu-surface) !important;
      box-shadow: var(--fr-video-menu-shadow) !important;
      color: var(--fr-video-menu-text) !important;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
      text-align: left !important;
      writing-mode: horizontal-tb !important;
      text-orientation: mixed !important;
      word-break: normal !important;
      white-space: normal !important;
      overflow: auto !important;
      scroll-padding-top: calc(28px + 6px) !important;
      overscroll-behavior: contain !important;
      scrollbar-width: thin !important;
      cursor: default !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] { width: min(440px, calc(100% - 16px)) !important; }
    /* hidden 必须高于带 compact/layout 状态的组件规则，收起的选项页不能被 grid 再次显示。 */
    #${VIDEO_TRANSLATION_MENU_ID}#${VIDEO_TRANSLATION_MENU_ID}[hidden],
    #${VIDEO_TRANSLATION_MENU_ID}#${VIDEO_TRANSLATION_MENU_ID} [hidden] { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} * {
      box-sizing: border-box !important;
      font-family: inherit !important;
      text-transform: none !important;
      letter-spacing: normal !important;
      text-shadow: none !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} button {
      all: unset !important;
      box-sizing: border-box !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      min-width: 0 !important;
      border-radius: 6px !important;
      color: inherit !important;
      font: inherit !important;
      cursor: pointer !important;
      white-space: nowrap !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} button:focus-visible {
      outline: 2px solid var(--fr-video-menu-brand-text) !important;
      outline-offset: -2px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} button:disabled { cursor: default !important; opacity: .45 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-icon {
      display: block !important;
      flex: 0 0 auto !important;
      width: 14px !important;
      height: 14px !important;
      margin: 0 !important;
      fill: none !important;
      stroke: currentColor !important;
      stroke-width: 2 !important;
      stroke-linecap: round !important;
      stroke-linejoin: round !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-icon-sparkle { fill: currentColor !important; stroke-width: 1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-learning {
      display: flex !important;
      align-items: center !important;
      justify-content: flex-start !important;
      gap: 9px !important;
      width: 100% !important;
      padding: 9px 11px !important;
      border: 1px solid rgba(239, 71, 118, .3) !important;
      border-radius: 9px !important;
      color: var(--fr-video-menu-brand-text) !important;
      background: var(--fr-video-menu-brand-soft) !important;
      font-weight: 600 !important;
      text-align: left !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-learning:hover { background: rgba(239, 71, 118, .28) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-learning:disabled { opacity: .45 !important; cursor: default !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-learning-label { flex: 1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-learning .fluent-read-video-menu-icon-next { width: 16px !important; height: 16px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-main,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-body,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-section {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 6px !important;
      min-width: 0 !important;
    }
    /* 矮播放器：显示设置与操作各压成一行，分段按语言长度取自然宽度，其余控件分享剩余空间。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-section {
      display: flex !important;
      flex-wrap: wrap !important;
      align-items: center !important;
      column-gap: 10px !important;
    }
    /* 放不下时整块换行而不是把按钮文字压成省略号：步进器与下载按钮保持内容宽度，AI 按钮至少保留名称空间。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-mode-group { flex: 0 0 auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-timing { flex: 1 1 0 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label { contain: inline-size !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-ai-group { flex: 1 1 0 !important; min-width: 128px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-downloads { flex: 1 0 auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-ai-group + .fluent-read-video-menu-downloads { flex-grow: 0 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-download {
      flex-direction: row !important;
      gap: 4px !important;
      min-height: 26px !important;
      padding: 0 8px !important;
      font-size: 11px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-download .fluent-read-video-menu-label { min-width: auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-download-status { flex: 1 0 100% !important; }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-title {
      position: sticky !important;
      top: -6px !important;
      z-index: 1 !important;
      background: var(--fr-video-menu-surface) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 6px !important;
      min-height: 22px !important;
      margin-bottom: 6px !important;
      padding: 0 0 0 4px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-brand {
      flex: 0 0 auto !important;
      color: var(--fr-video-menu-brand-text) !important;
      font-size: 11px !important;
      font-weight: 650 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-settings {
      min-width: 0 !important;
      min-height: 22px !important;
      padding: 0 5px !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-settings:hover { background: var(--fr-video-menu-control) !important; color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-settings .fluent-read-video-menu-icon { width: 13px !important; height: 13px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-service {
      min-width: 0 !important;
      max-width: 120px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-close {
      width: 28px !important;
      height: 28px !important;
      flex: 0 0 28px !important;
      color: var(--fr-video-menu-muted) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-title .fluent-read-video-menu-settings { margin-left: auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-close:hover { background: var(--fr-video-menu-control-hover) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-source {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto !important;
      align-items: center !important;
      gap: 2px 8px !important;
      padding: 0 4px !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 12px !important;
      line-height: 1.5 !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-source-status { grid-column: 1 / -1 !important; font-weight: 400 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-source-hint {
      margin: 0 !important;
      padding: 0 !important;
      color: var(--fr-video-menu-muted) !important;
      font: inherit !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-source[data-error="true"] .fluent-read-video-menu-source-hint { color: #e4bd8d !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-source-actions { display: flex !important; flex-wrap: wrap !important; gap: 4px 12px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-secondary {
      min-height: 30px !important;
      color: var(--fr-video-menu-muted) !important;
      white-space: normal !important;
      text-align: left !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-secondary[data-action="retry-subtitle-translation"] { color: var(--fr-video-menu-brand-text) !important; font-weight: 600 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-secondary:hover { text-decoration: underline !important; }

    /* X 的观看首页只保留显示方式和当前动作，次级选项使用原位返回页。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-watch,
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-tools {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-close { height: 26px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-source .fluent-read-video-menu-secondary { min-height: 26px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-title { gap: 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-brand { color: var(--fr-video-menu-text) !important; font-size: 12px !important; font-weight: 600 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-settings { font-size: 11px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-more {
      justify-content: space-between !important;
      min-height: 30px !important;
      padding: 2px 4px 0 !important;
      border-top: 1px solid rgba(255,255,255,.08) !important;
      border-radius: 0 !important;
      color: var(--fr-video-menu-muted) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-more:hover { color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-model {
      justify-content: space-between !important;
      min-height: 32px !important;
      padding: 2px 4px !important;
      gap: 8px !important;
      color: var(--fr-video-menu-text) !important;
      text-align: left !important;
      white-space: normal !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-model .fluent-read-video-menu-label { min-width: 0 !important; overflow-wrap: anywhere !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-model .fluent-read-video-menu-icon { flex: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-back { width: 24px !important; height: 28px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-export { display: grid !important; gap: 6px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-download { flex-direction: row !important; min-height: 32px !important; padding: 2px 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-secondary-ai .fluent-read-video-menu-ai {
      min-height: 28px !important;
      padding: 0 4px !important;
      background: transparent !important;
      box-shadow: none !important;
      color: var(--fr-video-menu-muted) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-secondary-ai .fluent-read-video-menu-ai[data-ready="true"] .fluent-read-video-menu-value { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"] .fluent-read-video-menu-tools > .fluent-read-video-menu-secondary { justify-content: flex-start !important; padding: 0 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-tools { gap: 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-export { grid-template-columns: minmax(0, 1fr) !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-export .fluent-read-video-menu-download-status { grid-column: 1 / -1 !important; }

    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-source {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto !important;
      align-items: center !important;
      column-gap: 8px !important;
      padding: 4px 8px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-source-hint { grid-column: 1 / -1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-source-actions { grid-column: 2 !important; grid-row: 1 !important; }

    /* 矮播放器为临时下载反馈也留出一行空间，不能只在没有反馈时放得下。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-main,
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-section { gap: 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-close { height: 24px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-secondary { min-height: 24px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-mode { min-height: 28px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-menu-ai { min-height: 30px !important; }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-controls { min-width: 0 !important; flex: 1 1 auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-setting { display: grid !important; gap: 3px !important; min-width: 0 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-choice { display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 5px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-choice > span:last-child { min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-diagram { display: grid !important; gap: 3px !important; flex: 0 0 12px !important; width: 12px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-diagram > span { display: block !important; height: 2px !important; border-radius: 1px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-original { background: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-translation { background: var(--fr-video-menu-brand-text) !important; width: 9px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-setting[data-active="false"] .fluent-read-video-menu-mode[aria-checked="true"] { background: var(--fr-video-menu-control) !important; box-shadow: inset 0 0 0 1px var(--fr-video-menu-border) !important; color: var(--fr-video-menu-muted) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode-group,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-order-controls {
      display: flex !important;
      gap: 2px !important;
      padding: 2px !important;
      border-radius: 8px !important;
      background: var(--fr-video-menu-control) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode {
      flex: 1 1 auto !important;
      min-height: 32px !important;
      padding: 0 4px !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode:hover { color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode[aria-checked="true"] {
      background: var(--fr-video-menu-brand-soft) !important;
      box-shadow: inset 0 0 0 1px rgba(239, 71, 118, .32) !important;
      color: var(--fr-video-menu-brand-text) !important;
      font-weight: 600 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-mode[data-mode="off"][aria-checked="true"] {
      background: rgba(255, 255, 255, .14) !important;
      box-shadow: none !important;
      color: var(--fr-video-menu-text) !important;
    }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-row {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 8px !important;
      min-height: 26px !important;
      padding: 0 0 0 4px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-row-label {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      overflow: hidden !important;
      color: var(--fr-video-menu-muted) !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-timing-controls {
      display: inline-flex !important;
      flex: 0 0 auto !important;
      align-items: center !important;
      gap: 2px !important;
      direction: ltr !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-step {
      width: 24px !important;
      height: 24px !important;
      background: var(--fr-video-menu-control) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-step:hover:not(:disabled) { background: var(--fr-video-menu-control-hover) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-step-reset { width: 22px !important; margin-right: 2px !important; background: transparent !important; color: var(--fr-video-menu-muted) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-step-reset:hover { color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-step-reset:disabled { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-timing-value {
      min-width: 40px !important;
      color: var(--fr-video-menu-text) !important;
      font-size: 11px !important;
      font-variant-numeric: tabular-nums !important;
      text-align: center !important;
    }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai-group { container: fluent-read-video-ai / inline-size !important; }
    /* 空间不足时只保留操作名称，进度仍由底部进度条表达；错误说明始终保留。 */
    @container fluent-read-video-ai (max-width: 190px) {
      #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai:not([data-error="true"]) .fluent-read-video-menu-value { display: none !important; }
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai {
      position: relative !important;
      width: 100% !important;
      min-height: 34px !important;
      padding: 0 8px !important;
      justify-content: flex-start !important;
      gap: 6px !important;
      overflow: hidden !important;
      border-radius: 8px !important;
      background: var(--fr-video-menu-brand-soft) !important;
      box-shadow: inset 0 0 0 1px rgba(239, 71, 118, .3) !important;
      color: var(--fr-video-menu-brand-text) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai:hover:not(:disabled) { background: rgba(239, 71, 118, .28) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-native="true"],
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-ready="true"] {
      background: var(--fr-video-menu-control) !important;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1) !important;
      color: var(--fr-video-menu-text) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-ready="true"]:hover { background: var(--fr-video-menu-control-hover) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai:disabled[data-processing="true"] { opacity: 1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai .fluent-read-video-menu-label {
      flex: 0 1 auto !important;
      min-width: 0 !important;
      overflow: hidden !important;
      font-size: 11.5px !important;
      font-weight: 600 !important;
      text-overflow: ellipsis !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai .fluent-read-video-menu-value {
      flex: 0 1 auto !important;
      min-width: 0 !important;
      margin-left: auto !important;
      overflow: hidden !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10.5px !important;
      font-variant-numeric: tabular-nums !important;
      text-overflow: ellipsis !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai .fluent-read-video-menu-value:empty { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-ready="true"] .fluent-read-video-menu-value { color: #8fdcbf !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-error="true"] {
      flex-wrap: wrap !important;
      row-gap: 0 !important;
      padding: 6px 8px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-error="true"] .fluent-read-video-menu-value {
      flex: 1 0 100% !important;
      margin: 0 !important;
      padding-left: 20px !important;
      color: #ffb4c3 !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
      display: -webkit-box !important;
      -webkit-line-clamp: 2 !important;
      -webkit-box-orient: vertical !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-progress {
      position: absolute !important;
      left: 0 !important;
      bottom: 0 !important;
      display: none !important;
      width: var(--fluent-read-video-ai-progress, 0%) !important;
      height: 2px !important;
      background: var(--fr-video-menu-brand) !important;
      transition: width .3s ease !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-progress="determinate"] .fluent-read-video-menu-progress { display: block !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai[data-progress="indeterminate"] .fluent-read-video-menu-progress {
      display: block !important;
      width: 36% !important;
      animation: fluent-read-video-menu-indeterminate 1.2s ease-in-out infinite !important;
    }
    @keyframes fluent-read-video-menu-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(280%); } }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-downloads {
      display: grid !important;
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      gap: 4px !important;
    }
    /* 单列菜单只有约 72px 一格，图标改放在文字上方，长语言也不会被截断。 */
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download {
      flex-direction: column !important;
      gap: 1px !important;
      min-height: 38px !important;
      padding: 4px 4px !important;
      font-size: 10.5px !important;
      background: var(--fr-video-menu-control) !important;
      color: rgba(255, 255, 255, .82) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download:hover:not(:disabled) { background: var(--fr-video-menu-control-hover) !important; color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download .fluent-read-video-menu-icon { width: 13px !important; height: 13px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download .fluent-read-video-menu-label { min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download[aria-busy="true"] { opacity: 1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download[aria-busy="true"] .fluent-read-video-menu-icon { display: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download[aria-busy="true"]::before {
      content: "" !important;
      display: block !important;
      flex: 0 0 auto !important;
      width: 9px !important;
      height: 9px !important;
      margin: 0 2px !important;
      border: 1.5px solid rgba(255, 255, 255, .28) !important;
      border-top-color: var(--fr-video-menu-brand-text) !important;
      border-radius: 50% !important;
      animation: fluent-read-video-download-spin .72s linear infinite !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download-status {
      margin: -2px 0 0 !important;
      padding: 0 4px 2px !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10.5px !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download-status:empty,
    #${VIDEO_TRANSLATION_MENU_ID}[data-measuring] .fluent-read-video-menu-download-status { display: none !important; }

    /* 高频设置保留清楚的开关；解释与低频导出按需展开，不占常驻卡片高度。 */
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-export {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 4px !important;
      min-width: 0 !important;
      width: 100% !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-feedback { display: contents !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-header { flex: 0 0 auto !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-toggle {
      position: relative !important;
      width: 28px !important;
      height: 28px !important;
      padding: 3px !important;
      border: 1px solid transparent !important;
      background: transparent !important;
      color: var(--fr-video-menu-muted) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-toggle .fluent-read-video-menu-icon { width: 20px !important; height: 20px !important; stroke-width: 1.7 !important; }
    /* 与标题栏图标及显示方式选中态统一：透明底、柔和品牌色；悬停不能覆盖开启状态。 */
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-toggle[aria-checked="false"]:is(:hover, :focus-visible):not(:disabled) {
      background: var(--fr-video-menu-control) !important;
      color: var(--fr-video-menu-text) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-toggle[aria-checked="true"] {
      background: var(--fr-video-menu-brand-soft) !important;
      border-color: rgba(239, 71, 118, .32) !important;
      color: var(--fr-video-menu-brand-text) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-toggle[aria-checked="true"]:hover:not(:disabled) {
      background: rgba(239, 71, 118, .28) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-help {
      padding: 9px !important;
      border: 1px solid var(--fr-video-menu-border) !important;
      border-radius: 8px !important;
      background: var(--fr-video-menu-control) !important;
      font-size: 11px !important;
      line-height: 1.55 !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-help[popover] {
      position: fixed !important;
      inset: auto !important;
      top: var(--fr-reading-help-top, 8px) !important;
      left: var(--fr-reading-help-left, 8px) !important;
      margin: 0 !important;
      width: var(--fr-reading-help-width, 280px) !important;
      max-height: var(--fr-reading-help-max-height, calc(100vh - 16px)) !important;
      overflow: auto !important;
      background: var(--fr-video-menu-surface) !important;
      color: var(--fr-video-menu-text) !important;
      box-shadow: var(--fr-video-menu-shadow) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-help::backdrop { background: transparent !important; pointer-events: none !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-help p { margin: 0 !important; padding: 0 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-example {
      display: grid !important;
      gap: 2px !important;
      margin: 8px 0 !important;
      padding: 7px 9px !important;
      border-radius: 6px !important;
      background: var(--fr-video-menu-surface) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-example-label,
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-note { color: var(--fr-video-menu-muted) !important; font-size: 10.5px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-example-text { color: var(--fr-video-menu-brand-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading-help .fluent-read-video-menu-reading-note + p { margin-top: 6px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-reading > .fluent-read-video-menu-source-hint { padding: 0 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download-toggle {
      flex: 0 0 28px !important;
      width: 28px !important;
      height: 28px !important;
      padding: 3px !important;
      color: var(--fr-video-menu-muted) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download-toggle:hover { color: var(--fr-video-menu-text) !important; background: var(--fr-video-menu-control) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download-toggle[aria-expanded="true"] { color: var(--fr-video-menu-brand-text) !important; background: var(--fr-video-menu-brand-soft) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-export .fluent-read-video-menu-download {
      flex-direction: row !important;
      gap: 4px !important;
      min-height: 28px !important;
      padding: 4px !important;
    }

    #${VIDEO_TRANSLATION_MENU_ID}[data-view="export-prompt"] .fluent-read-video-model-prompt.fluent-read-video-export-prompt { display: flex !important; flex-direction: column !important; gap: 8px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-export-actions { flex-wrap: wrap !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-export-actions button { white-space: normal !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 8px !important;
      padding: 2px 2px 0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-model-prompt {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) !important;
      column-gap: 12px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-model-prompt-head { grid-column: 1 / -1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-model-prompt-description { grid-area: 2 / 1 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-model-options { grid-area: 2 / 2 / 4 / 3 !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-layout="wide"] .fluent-read-video-model-prompt-actions { grid-area: 3 / 1 !important; align-self: end !important; justify-content: flex-start !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-head {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      min-height: 32px !important;
      padding-left: 2px !important;
      color: var(--fr-video-menu-brand-text) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-title {
      flex: 1 1 auto !important;
      min-width: 0 !important;
      color: var(--fr-video-menu-text) !important;
      font-size: 12px !important;
      font-weight: 650 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-head .fluent-read-video-menu-step { background: transparent !important; color: var(--fr-video-menu-muted) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-description {
      margin: 0 !important;
      padding: 0 2px !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10.5px !important;
      line-height: 1.45 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-options { display: grid !important; gap: 4px !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option {
      display: grid !important;
      grid-template-columns: 12px minmax(0, 1fr) !important;
      align-items: center !important;
      justify-items: start !important;
      column-gap: 8px !important;
      row-gap: 1px !important;
      width: 100% !important;
      padding: 6px 8px !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, .05) !important;
      box-shadow: inset 0 0 0 1px transparent !important;
      white-space: normal !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option:hover { background: rgba(255, 255, 255, .09) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option[aria-checked="true"] {
      background: rgba(239, 71, 118, .12) !important;
      box-shadow: inset 0 0 0 1px rgba(239, 71, 118, .55) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-radio {
      grid-row: 1 / 3 !important;
      width: 12px !important;
      height: 12px !important;
      border-radius: 50% !important;
      box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .42) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option[aria-checked="true"] .fluent-read-video-model-option-radio {
      background: var(--fr-video-menu-brand) !important;
      box-shadow: inset 0 0 0 3px rgba(40, 24, 32, 1), 0 0 0 1.5px var(--fr-video-menu-brand) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-name {
      display: inline-flex !important;
      flex-wrap: wrap !important;
      align-items: center !important;
      gap: 2px 6px !important;
      min-width: 0 !important;
      color: var(--fr-video-menu-text) !important;
      font-size: 11.5px !important;
      font-weight: 600 !important;
      white-space: normal !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-badge {
      padding: 1px 5px !important;
      border-radius: 999px !important;
      background: var(--fr-video-menu-brand-soft) !important;
      color: var(--fr-video-menu-brand-text) !important;
      font-size: 9.5px !important;
      font-weight: 600 !important;
      line-height: 1.3 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-size {
      justify-self: end !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10.5px !important;
      font-variant-numeric: tabular-nums !important;
      white-space: nowrap !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-size.is-downloaded { color: #8fdcbf !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-option-hint {
      grid-column: 2 / -1 !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 10.5px !important;
      line-height: 1.3 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-actions {
      display: flex !important;
      justify-content: flex-end !important;
      gap: 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-actions button {
      min-height: 28px !important;
      padding: 0 12px !important;
      border-radius: 7px !important;
      font-size: 11.5px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-cancel { background: var(--fr-video-menu-control) !important; color: var(--fr-video-menu-muted) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-cancel:hover { background: var(--fr-video-menu-control-hover) !important; color: var(--fr-video-menu-text) !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-confirm { background: var(--fr-video-menu-brand) !important; color: #fff !important; font-weight: 600 !important; }
    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-model-prompt-confirm:hover { background: #dc315f !important; }

    #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-native-fullscreen-hint {
      margin: 4px 0 0 !important;
      color: var(--fr-video-menu-muted) !important;
      font-size: 11px !important;
      line-height: 1.45 !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
    }
    /* 触屏目标至少 44px；安全视口菜单在下方单独安排正文滚动。 */
    @media (pointer: coarse) {
      #${VIDEO_TRANSLATION_BUTTON_ID} { min-width: 44px !important; min-height: 44px !important; }
      #${VIDEO_TRANSLATION_MENU_ID} { scroll-padding-top: calc(44px + 6px) !important; }
      /* 双 ID 优先于 compact/wide 的次级按钮规则，关闭、模式、返回与操作均保留完整触控面积。 */
      #${VIDEO_TRANSLATION_MENU_ID}#${VIDEO_TRANSLATION_MENU_ID} button {
        min-width: 44px !important;
        min-height: 44px !important;
        touch-action: manipulation !important;
      }
      #${VIDEO_TRANSLATION_MENU_ID}[data-layout] .fluent-read-video-menu-step { width: 44px !important; height: 44px !important; }
      /* 触屏步进器变宽后独立成行，时间标签保留全文，长语言可换行而不截成省略号。 */
      #${VIDEO_TRANSLATION_MENU_ID}[data-layout] .fluent-read-video-menu-timing {
        flex: 1 0 100% !important;
        flex-wrap: wrap !important;
      }
      #${VIDEO_TRANSLATION_MENU_ID}[data-layout] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label {
        contain: none !important;
        overflow: visible !important;
        text-overflow: clip !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
      }
    }
    /* 手机菜单使用安全可见视口宿主，不随 16:9 的短播放器裁切；标题与正文分别布局。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] {
      left: 50% !important;
      right: auto !important;
      bottom: 8px !important;
      transform: translateX(-50%) !important;
      display: flex !important;
      flex-direction: column !important;
      width: min(560px, calc(100% - 16px)) !important;
      max-height: calc(100% - 16px) !important;
      padding: 8px !important;
      border-radius: 16px !important;
      font-size: 14px !important;
      overflow: hidden !important;
      scroll-padding-top: 0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-main {
      display: flex !important;
      flex-direction: column !important;
      min-height: 0 !important;
      gap: 6px !important;
      overflow: hidden !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-title {
      position: static !important;
      flex: 0 0 auto !important;
      min-height: 44px !important;
      gap: 4px !important;
      padding: 0 !important;
      margin-bottom: 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-body {
      display: flex !important;
      flex-direction: column !important;
      min-height: 0 !important;
      gap: 10px !important;
      padding: 0 8px 4px !important;
      overflow: auto !important;
      overscroll-behavior: contain !important;
      scrollbar-width: thin !important;
      scrollbar-gutter: stable !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-brand { font-size: 13px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-settings {
      flex: 1 1 0 !important;
      min-width: 0 !important;
      justify-content: flex-end !important;
      padding: 0 4px !important;
      font-size: 12px !important;
      overflow: hidden !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-close,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-back {
      flex: 0 0 44px !important;
      width: 44px !important;
      height: 44px !important;
    }
    /* 窄屏与带鼠标的手机测试视口也保留完整触控面积，长标签自然换行。 */
    #${VIDEO_TRANSLATION_MENU_ID}#${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] button {
      min-width: 44px !important;
      min-height: 44px !important;
      flex-shrink: 0 !important;
      touch-action: manipulation !important;
    }
    /* 安全高度不足 128px 时只保留关闭；正常态需在 84px 外框/标题之外留出完整 44px 正文窗口。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"][data-viewport-state="close-only"] {
      bottom: 0 !important;
      max-height: 100% !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"][data-viewport-state="close-only"] .fluent-read-video-menu-title {
      flex: 0 0 44px !important;
      height: 44px !important;
      justify-content: flex-end !important;
      margin-bottom: 0 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"][data-viewport-state="close-only"] > :not(.fluent-read-video-menu-title),
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"][data-viewport-state="close-only"] > .fluent-read-video-menu-title > :not(.fluent-read-video-menu-close) {
      display: none !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-section,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-watch,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-tools {
      display: grid !important;
      flex: 0 0 auto !important;
      grid-template-columns: minmax(0, 1fr) !important;
      gap: 10px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-mode-group {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 4px !important;
      padding: 3px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"][data-layout="wide"] .fluent-read-video-menu-mode-group {
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-mode {
      padding: 6px 4px !important;
      font-size: 14px !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
      text-overflow: clip !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-timing {
      display: flex !important;
      flex-wrap: wrap !important;
      gap: 4px 8px !important;
      padding-left: 4px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label {
      contain: none !important;
      overflow: visible !important;
      text-overflow: clip !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-step { width: 44px !important; height: 44px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-download-toggle { flex-basis: 44px !important; width: 44px !important; height: 44px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-reading-toggle { width: 44px !important; height: 44px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-timing-value { font-size: 14px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-downloads {
      display: grid !important;
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      gap: 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-download {
      flex-direction: row !important;
      gap: 4px !important;
      padding: 6px !important;
      font-size: 12px !important;
      white-space: normal !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-download .fluent-read-video-menu-label {
      min-width: 0 !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
      text-overflow: clip !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-learning {
      flex: 0 0 auto !important;
      padding: 6px 8px !important;
      background: transparent !important;
      font-size: 13px !important;
      font-weight: 500 !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-menu-learning-label { white-space: normal !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-native-fullscreen-hint { font-size: 12px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt {
      grid-template-columns: minmax(0, 1fr) !important;
      min-height: 0 !important;
      overflow: auto !important;
      overscroll-behavior: contain !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-head,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-description,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-options,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions {
      grid-area: auto !important;
      grid-column: auto !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-title,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-option-name { font-size: 14px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-description,
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-option-hint { font-size: 12px !important; }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions {
      flex-wrap: wrap !important;
      gap: 6px !important;
    }
    #${VIDEO_TRANSLATION_MENU_ID}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions button {
      padding: 6px 10px !important;
      white-space: normal !important;
      font-size: 13px !important;
    }
    /* 确认页有自己的取消/返回，不能暴露仍指向隐藏工具页的返回按钮。 */
    #${VIDEO_TRANSLATION_MENU_ID}[data-view="model-prompt"] .fluent-read-video-menu-back,
    #${VIDEO_TRANSLATION_MENU_ID}[data-view="export-prompt"] .fluent-read-video-menu-back { display: none !important; }
    @keyframes fluent-read-video-download-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-download[aria-busy="true"]::before,
      #${VIDEO_TRANSLATION_MENU_ID} .fluent-read-video-menu-ai .fluent-read-video-menu-progress { animation: none !important; transition: none !important; }
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
