/**
 * @file src/features/video-subtitle/content/ui.ts
 *
 * 文件职责：封装视频字幕 content UI 的界面语言转换、可访问名称刷新、受守卫的字幕层/外观样式同步及桌面/触屏安全视口菜单样式，并以播放器级样式持续隐藏由 FluentRead 接管的 YouTube 原生字幕。
 * 主要内容：提供视频菜单本地化、局部外观变量与快照缓存、显式读音开关与示例说明、紧凑下载折叠入口与格式化导出下拉样式、独立纯文本读音行及按语言命名；双语顺序用原文与译文双行示意并标记暂未生效的偏好，字幕按偏好交换原译文顺序并使用 dir="auto" 适配 RTL，读音始终紧跟原文并计入字幕布局，防止缩成不可读小字；菜单仅管理自身交互，不参与字幕的宽度与水平居中计算；保留逐字高亮、校时与就地模型选择控件，支持 Safari 全屏与单次安全区扣减、CSS containment、GPU 合成进度条、高对比强制配色与状态指示；仅过滤 YouTube 滚动窗口实际裁切的旧行并复用每批几何测量，按实际画面及同视频可见底控约束字幕几何、换行与大字号完整高度，并封装字幕清理、媒体时钟读取、样式及字幕下载。
 * 模块边界：只读取界面配置并操作视频 feature 拥有的节点、样式和下载链接，不发起翻译或识别请求；任务生命周期由 runtime 管理。
 * 课程菜单：样式工厂可在课程 Shadow Root 内复用同一份品牌色、图标、分段按钮和正文密度，避免各平台维护不同外观。
 */

import {serializeSubtitleFile, type SubtitleExportFormat} from './subtitleExport';
import {htmlMediaForPlayer, isExcludedHtmlMediaHost} from './htmlMedia';
import {getVideoSubtitleAppearanceCssVars, normalizeVideoSubtitleAppearance, type VideoSubtitleAppearance} from '@/src/core/config/videoSubtitleAppearance';
import {config} from '@/src/services/config/store';
import {type VideoSubtitleDisplayMode} from '@/src/core/config/model';
import {sanitizeSubtitleFilename, type VideoSubtitleCue} from './youtubeSubtitleData';
import {getCaptionPlatform} from './platforms';
import {timedTextTrackKey} from './timedTextTrackCache';
import {fitVideoSubtitleFontSize} from './subtitleLayout';
import {getYoutubeSubtitleControlsScope} from './youtubeControlsScope';
import {
  getFullscreenElement,
  getVisibleSubtitleControlEntries,
  positionMobileYoutubeSubtitle,
  resetSubtitlePanelLayout,
  finishSubtitlePanelLayout,
  prepareSubtitlePanelLayout,
  findOwnedSubtitlePanel,
  syncSubtitleScrollHostState,
  setSubtitlePanelScrollable,
  setStyleIfChanged,
  removeStyleIfPresent,
  setAttrIfChanged,
  setDataIfChanged,
  VIDEO_SUBTITLE_SCROLL_HOST_ID,
  type VisibleSubtitleControl,
} from './subtitleControlLayout';
import {createVideoKaraokeController, setVideoCaptionText, type VideoKaraokeController, VIDEO_KARAOKE_FILL_PROPERTY, VIDEO_KARAOKE_STATE_ATTRIBUTE, VIDEO_KARAOKE_TEXT_ATTRIBUTE, VIDEO_KARAOKE_UNIT_CLASS} from './karaoke';
import {VIDEO_NATIVE_CAPTION_HIDDEN_CLASS} from './youtubeNativeCaptionVisibility';
import {buildVideoSubtitleStyleText} from './videoSubtitleStyles';
import {isYouTubeEmbedPage, YOUTUBE_HOST_PATTERN} from './youtubeEmbedUrl';

export {VIDEO_NATIVE_CAPTION_HIDDEN_CLASS} from './youtubeNativeCaptionVisibility';
export {isYouTubeEmbedPage, YOUTUBE_HOST_PATTERN} from './youtubeEmbedUrl';
export {setStyleIfChanged, removeStyleIfPresent, setAttrIfChanged, setDataIfChanged} from './subtitleControlLayout';

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
        const text = translateVideoUi(element.dataset.i18nKey!, language, readI18nParams(element));
        if (element.textContent !== text) element.textContent = text;
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-aria-key]').forEach((element) => {
        const label = translateVideoUi(element.dataset.i18nAriaKey!, language, readI18nParams(element));
        if (element.getAttribute('aria-label') !== label) element.setAttribute('aria-label', label);
        if (!element.dataset.i18nTitleKey && element.title !== label) element.title = label;
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-title-key]').forEach((element) => {
        const title = translateVideoUi(element.dataset.i18nTitleKey!, language);
        if (element.title !== title) element.title = title;
    });
}

/** 菜单关闭时仍更新可见的入口和字幕层，无变化的名称不触发 DOM 观察器。 */
export function refreshVideoUiAccessibility(
    menu: HTMLElement | null,
    button: HTMLElement | null,
    document: Document,
    language: UiLanguage,
    status: string,
): void {
    const setLabel = (element: HTMLElement | null, label: string) => {
        if (element && element.getAttribute('aria-label') !== label) element.setAttribute('aria-label', label);
    };
    if (menu) {
        setLabel(menu, translateVideoUi('video.menuAriaLabel', language));
        setLabel(menu.querySelector('.fluent-read-video-menu-mode-group'), translateVideoUi('video.displayMode', language));
    }
    if (button) {
        const buttonLabel = translateVideoUi('video.buttonAriaLabel', language, {status});
        setLabel(button, buttonLabel);
        if (button.title !== buttonLabel) button.title = buttonLabel;
    }
    setLabel(document.getElementById(VIDEO_SUBTITLE_PANEL_ID), translateVideoUi('video.panelAriaLabel', language));
    setLabel(document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID), translateVideoUi('video.translationOverlayAriaLabel', language));
    setLabel(document.getElementById(VIDEO_NORMALIZED_CAPTION_OVERLAY_ID), translateVideoUi('video.originalOverlayAriaLabel', language));
    const reading = document.getElementById(VIDEO_READING_OVERLAY_ID);
    if (reading) setLabel(reading, translateVideoUi(reading.dataset.readingLabelKey || 'video.readingAnnotation.label', language));
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
export const VIDEO_PLAYER_STATUS_ATTRIBUTE = 'data-fluent-read-video-status';
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
export const VIDEO_NATIVE_CUE_HIDDEN_CLASS = 'fluent-read-video-native-cue-hidden';
export const VIDEO_NORMALIZED_CAPTION_CLASS = 'fluent-read-video-normalized-caption';
export const VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS = 'fluent-read-video-normalized-caption-active';
export const VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS = 'fluent-read-video-subtitle-panel-active';

const YOUTUBE_MAIN_HOST_PATTERN = /(^|\.)youtube\.com$/i;
const YOUTUBE_LIVE_PATH_PATTERN = /^\/live\/[\w-]{11}\/?$/u;
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
  getVideo: () => HTMLMediaElement | null,
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
  const nextLang = language ? `${language}-Latn` : '';
  if (line.lang !== nextLang) line.lang = nextLang;
  const labelKey = `video.readingAnnotation.${language || 'label'}`;
  setDataIfChanged(line, 'readingLabelKey', labelKey);
  setAttrIfChanged(line, 'aria-label', videoUi(labelKey));
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

export function downloadSubtitleSrt(srt: string, languageCode: string, cues?: readonly VideoSubtitleCue[], format: SubtitleExportFormat = 'srt'): void {
  if (!srt.trim()) throw new Error('字幕轨道没有可下载的内容');

  const title = sanitizeSubtitleFilename(document.title.replace(/\s*-\s*(?:YouTube|X)\s*$/i, ''));
  const language = sanitizeSubtitleFilename(languageCode || 'original');
  const file = cues ? serializeSubtitleFile(cues, format) : {text: srt, extension: 'srt', mime: 'application/x-subrip;charset=utf-8'};
  const blobUrl = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = `${title}-${language}.${file.extension}`;
  anchor.style.display = 'none';
  (document.body || document.documentElement).appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function isYouTubeVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return isYouTubeEmbedPage(locationLike)
    || (YOUTUBE_MAIN_HOST_PATTERN.test(locationLike.hostname)
      && (locationLike.pathname === '/watch'
        || locationLike.pathname.startsWith('/shorts/')
        || YOUTUBE_LIVE_PATH_PATTERN.test(locationLike.pathname)));
}

export function isXVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return isXHostPage(locationLike);
}

export function isXHostPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(locationLike.hostname.toLowerCase());
}

export function isHtmlMediaPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  const platform = getCaptionPlatform(locationLike);
  return Boolean(locationLike.hostname) && !YOUTUBE_HOST_PATTERN.test(locationLike.hostname) && !isXVideoPage(locationLike)
    && !isExcludedHtmlMediaHost(locationLike.hostname)
    && (!platform || (import.meta.env.BROWSER !== 'userscript' && platform === 'coursera'));
}

export function isSupportedVideoPage(locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location): boolean {
  return isYouTubeVideoPage(locationLike) || isXVideoPage(locationLike) || getCaptionPlatform(locationLike) !== null || isHtmlMediaPage(locationLike);
}

/** 读取当前播放器可见的原生字幕，同时保留滚动窗口阶段已读取的片段矩形避免重复测量。 */
function getVisibleCaptionSegmentsWithRects(container: Element): Array<{element: HTMLElement; rect?: DOMRect}> {
  const nativeSegments = Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_SEGMENT_SELECTOR));
  const candidates = nativeSegments.length > 0
    ? nativeSegments
    : Array.from(container.querySelectorAll<HTMLElement>(VIDEO_CAPTION_FALLBACK_SEGMENT_SELECTOR));

  const candidateSet = new Set(candidates);
  const rollupRects = new Map<Element, DOMRect>();
  const visible: Array<{element: HTMLElement; rect?: DOMRect}> = [];
  for (const segment of candidates) {
    // 查询不包含容器自身；只排除本次候选中的祖先，保留外层片段的完整文本。
    let nested = false;
    for (let ancestor = segment.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      if (candidateSet.has(ancestor)) {nested = true; break;}
    }
    if (nested) continue;
    const rollup = segment.closest?.('.ytp-caption-window-rollup');
    if (!rollup) {visible.push({element: segment}); continue;}
    let windowRect = rollupRects.get(rollup);
    if (!windowRect) {
      windowRect = rollup.getBoundingClientRect();
      rollupRects.set(rollup, windowRect);
    }
    const segmentRect = segment.getBoundingClientRect();
    // visibility:hidden 是插件隐藏原生行的方式，不能据此过滤；只排除
    // YouTube 滚动窗口实际裁掉的旧行。未布局时保留原文，避免误判为空。
    if (!windowRect.height || !segmentRect.height
      || (segmentRect.bottom > windowRect.top && segmentRect.top < windowRect.bottom)) {
      visible.push({element: segment, rect: segmentRect});
    }
  }
  return visible;
}

/** 读取当前播放器可见的原生字幕，不读取插件自己的译文节点。 */
export function getVisibleCaptionSegments(container: Element): HTMLElement[] {
  return getVisibleCaptionSegmentsWithRects(container).map(({element}) => element);
}

export function readVisibleCaptionText(container: Element | null): string {
  if (!container) return '';

  const segments = getVisibleCaptionSegments(container)
    .map((segment) => segment.textContent?.replace(/[\s\u3000]+/g, ' ').trim() || '')
    .filter(Boolean);

  // segment 可能只是逐词或样式片段，同文不能证明是滚动残留。
  // 裁切旧行已在上游排除；有时间轴时由 runtime 选择当前 cue，无时间轴时保留完整台词。
  return segments.join(' ').replace(/[\s\u3000]+/g, ' ').trim();
}

export function findCaptionContainer(): HTMLElement | null {
  if (isXVideoPage() || isHtmlMediaPage()) return document.getElementById(VIDEO_AI_CAPTION_CONTAINER_ID);
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

function syncVideoDisplayModeClasses(target: HTMLElement): void {
  const mode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  const enabled = config.on !== false && config.videoTranslationEnabled !== false;
  target.classList.toggle(VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS, enabled && mode === 'translation-only');
  target.classList.toggle(VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS, enabled && mode === 'original-only');
  target.classList.toggle(VIDEO_DISPLAY_HIDDEN_CLASS, enabled && config.videoSubtitleVisible === false);
  setAttrIfChanged(target, 'data-fluent-read-video-display-mode', mode);
}

export function getOrCreateVideoSubtitleLayer(player: HTMLElement): HTMLElement {
  let layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = VIDEO_TRANSLATION_LAYER_ID;
    layer.className = 'fluent-read-video-subtitle-layer fluent-read-video-ui notranslate';
    layer.setAttribute('data-fluent-read-ui', 'video-subtitle');
    layer.setAttribute('translate', 'no');
    syncVideoDisplayModeClasses(layer);
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
  overlay.setAttribute('dir', 'auto');
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
  overlay.setAttribute('dir', 'auto');
  overlay.setAttribute('aria-label', videoUi('video.originalOverlayAriaLabel'));
  panel.appendChild(overlay);
  return overlay;
}

/** 字幕运行时只保留状态所有权，自有 DOM 的清空交由 UI 层完成。 */
export function clearRenderedVideoTranslation(owner: Document, preserveReading = false): void {
  owner.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => {
    subtitleLayoutSnapshots.delete(panel);
    resetSubtitlePanelLayout(panel);
  });
  owner.querySelectorAll(`#${VIDEO_TRANSLATION_OVERLAY_ID}`).forEach(node => writeVideoCaptionText(node, ''));
  if (!preserveReading) {
    owner.querySelectorAll(`#${VIDEO_READING_OVERLAY_ID}`).forEach(node => {if (node.textContent !== '') node.textContent = '';});
  }
}

export function deactivateNormalizedVideoCaption(owner: Document): void {
  owner.querySelectorAll(VIDEO_CAPTION_CONTAINER_SELECTOR).forEach(node => node.classList.remove(VIDEO_NORMALIZED_CAPTION_CLASS));
  owner.querySelectorAll<HTMLElement>(`#${VIDEO_TRANSLATION_LAYER_ID}`).forEach(node => {node.classList.remove(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS); syncSubtitleScrollHostState(node);});
  owner.querySelectorAll(`#${VIDEO_NORMALIZED_CAPTION_OVERLAY_ID}`).forEach(node => writeVideoCaptionText(node, ''));
}

/** 读取当前播放器媒体；暂未挂载或时间无效时不编造播放位置。 */
export function readVideoPlaybackTimeMs(player: HTMLElement | null, fallback: HTMLMediaElement | null): number {
  const video = player?.querySelector<HTMLVideoElement>('video.html5-main-video, video') || fallback;
  const time = video?.currentTime;
  return typeof time === 'number' && Number.isFinite(time) ? time * 1000 : Number.NaN;
}

export function removeTranslationOverlay(): void {
  document.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => {
    subtitleLayoutSnapshots.delete(panel);
    appliedAppearanceKeys.delete(panel);
    resetSubtitlePanelLayout(panel, true);
  });
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
export function getVideoSubtitleViewport(player: HTMLElement, layer: HTMLElement, measuredPlayerRect?: DOMRect) {
  const media = htmlMediaForPlayer(player);
  if (media) {
    const fallbackRect = (!player.clientWidth || !player.clientHeight)
      ? (measuredPlayerRect || player.getBoundingClientRect())
      : undefined;
    return {
      left: 0,
      top: 0,
      width: player.clientWidth || fallbackRect!.width,
      height: player.clientHeight || fallbackRect!.height,
      right: 0,
      bottom: 0,
      controlsInset: media.tagName === 'AUDIO' ? 8 : 56,
      visibleControls: undefined as readonly VisibleSubtitleControl[] | undefined,
      layerRect: undefined as DOMRect | undefined,
    };
  }
  const video = player.querySelector('video');
  const layerRect = layer.getBoundingClientRect();
  const playerRect = measuredPlayerRect || player.getBoundingClientRect();
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
  const paintedViewport = {left, right, top, bottom, height: Math.max(0, bottom - top)};
  const xPage = isXVideoPage();
  const visibleControls = xPage ? undefined : getVisibleSubtitleControlEntries(player);
  return {
    left: (left - layerRect.left) / scaleX,
    top: (top - layerRect.top) / scaleY,
    width: Math.max(0, right - left) / scaleX,
    height: Math.max(0, bottom - top) / scaleY,
    right: (layerRect.right - right) / scaleX,
    bottom: (layerRect.bottom - bottom) / scaleY,
    controlsInset: (xPage ? getXSubtitleBottomInset(player, paintedViewport)
      : getYoutubeSubtitleBottomInset(visibleControls!, paintedViewport)) / scaleY,
    visibleControls,
    layerRect,
  };
}

/** 只避开真实可见的底部控件；移动视频高度不足时不能保留桌面的 52px 起步底距。 */
function getYoutubeSubtitleBottomInset(
  visibleControls: readonly VisibleSubtitleControl[],
  viewport: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'height'>,
): number {
  let inset = 12;
  for (const {rect} of visibleControls) {
    if (rect.right <= viewport.left || rect.left >= viewport.right || rect.top < viewport.top + viewport.height * .65 || rect.top >= viewport.bottom) continue;
    inset = Math.max(inset, viewport.bottom - rect.top + 8);
  }
  return inset;
}

interface CachedSubtitleAppearance {
  key: string;
  appearance: VideoSubtitleAppearance;
  cssVars: Record<string, string>;
}

let cachedAppearanceState: CachedSubtitleAppearance | null = null;
const appliedAppearanceKeys = new WeakMap<HTMLElement, string>();

interface SubtitleLayoutSnapshot {
  key: string;
  player: HTMLElement;
  layer: HTMLElement;
  scope: HTMLElement;
  parent: HTMLElement | null;
  fullscreenElement: Element | null;
  panelRectFn: HTMLElement['getBoundingClientRect'];
  panelScrollHeightGetter: (() => unknown) | undefined;
}

const subtitleLayoutSnapshots = new WeakMap<HTMLElement, SubtitleLayoutSnapshot>();

function getAppearanceRawKey(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const s = value as Record<string, unknown>;
  return `${s.skin}|${s.textColor}|${s.translationColor}|${s.position}|${s.bilingualOrder}|${s.bottomOffset}|${s.autoBottom}|${s.backgroundVisible}|${s.backgroundOpacity}|${s.outlineStyle}|${s.outlineColor}|${s.outlineWidth}|${s.lineSpacing}|${s.maxWidth}|${s.fontScale}|${s.karaoke}|${s.readingAnnotation}`;
}

function getCachedSubtitleAppearance(raw: unknown): CachedSubtitleAppearance {
  const key = getAppearanceRawKey(raw);
  if (cachedAppearanceState && cachedAppearanceState.key === key) return cachedAppearanceState;
  const appearance = normalizeVideoSubtitleAppearance(raw);
  cachedAppearanceState = {key, appearance, cssVars: getVideoSubtitleAppearanceCssVars(appearance)};
  return cachedAppearanceState;
}

let cachedCoarsePointerQuery: MediaQueryList | null | undefined;
function isCoarsePointerViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (cachedCoarsePointerQuery === undefined) {
    cachedCoarsePointerQuery = window.matchMedia('(pointer: coarse)') ?? null;
  }
  return cachedCoarsePointerQuery?.matches === true;
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
  const viewport = getVideoSubtitleViewport(player, layer, playerRect);
  const xPage = isXVideoPage();
  const htmlMediaPage = isHtmlMediaPage();
  const youtubePage = isYouTubeVideoPage();
  const scope = getYoutubeSubtitleControlsScope(player);
  const fullscreenElement = getFullscreenElement(document);
  const fullscreen = Boolean(fullscreenElement?.contains(player));
  const menu = document.getElementById(VIDEO_TRANSLATION_MENU_ID);
  const menuOpen = menu instanceof HTMLElement && !menu.hidden;
  const learningOpen = Boolean(scope.querySelector('#fluent-read-video-learning-panel.fluent-read-video-ui[data-fluent-read-ui="video-subtitle"]'));
  const cachedAppearance = getCachedSubtitleAppearance(config.videoSubtitleAppearance);
  const {appearance} = cachedAppearance;
  const overlayText = overlay.textContent || '';
  const normalizedText = normalizedOverlay?.textContent || '';
  const readingText = panel.querySelector(`#${VIDEO_READING_OVERLAY_ID}`)?.textContent || '';
  const active = Boolean(overlayText.trim() || normalizedText.trim());
  const playerWidth = viewport ? viewport.width : playerRect.width || 960;
  const playerHeight = viewport ? viewport.height : playerRect.height || 540;
  const compactPlayer = playerWidth <= 600 || isCoarsePointerViewport();
  const displayMode = normalizeVideoSubtitleDisplayMode(config.videoSubtitleDisplayMode);
  const normalizedCaptionActive = layer.classList.contains(VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS);
  const needsNativeAvoidance = active && !xPage && !compactPlayer && appearance.position === 'bottom' && displayMode === 'bilingual' && !normalizedCaptionActive;
  let nativeCaptionTop: number | null = null;
  if (needsNativeAvoidance) {
    // 仅在译文需要避开桌面原生行时测量，忽略切换期间空的原生容器，并复用滚动窗口阶段的片段矩形。
    const visibleCaptionSegments = getVisibleCaptionSegmentsWithRects(container)
      .map(({element, rect}) => rect || element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0);
    if (visibleCaptionSegments.length > 0) {
      nativeCaptionTop = Math.min(...visibleCaptionSegments.map((rect) => rect.top - playerRect.top));
    }
  }
  const visibleControlsKey = viewport?.visibleControls
    ? viewport.visibleControls.map(({element, rect}) => `${rect.left},${rect.top},${rect.width},${rect.height},${player.contains(element) ? 1 : 0}`).join(';')
    : '';
  const scrollHostRect = panel.parentElement?.id === VIDEO_SUBTITLE_SCROLL_HOST_ID
    ? panel.parentElement.getBoundingClientRect()
    : null;
  const snapshotKey = [
    playerRect.left, playerRect.top, playerRect.width, playerRect.height,
    layer.clientWidth, layer.clientHeight,
    viewport ? `${viewport.left},${viewport.top},${viewport.width},${viewport.height},${viewport.right},${viewport.bottom},${viewport.controlsInset}` : 'none',
    visibleControlsKey,
    scrollHostRect ? `${scrollHostRect.left},${scrollHostRect.top},${scrollHostRect.width},${scrollHostRect.height}` : '',
    cachedAppearance.key,
    overlayText, normalizedText, readingText,
    active ? 1 : 0, menuOpen ? 1 : 0, learningOpen ? 1 : 0,
    fullscreen ? 1 : 0, compactPlayer ? 1 : 0,
    xPage ? 1 : 0, htmlMediaPage ? 1 : 0, youtubePage ? 1 : 0,
    config.on !== false ? 1 : 0, config.videoTranslationEnabled !== false ? 1 : 0, config.videoSubtitleVisible !== false ? 1 : 0,
    displayMode, normalizedCaptionActive ? 1 : 0,
    nativeCaptionTop === null ? '' : nativeCaptionTop,
    panel.classList.contains(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS) ? 1 : 0,
    panel.dataset.fluentReadSubtitleLayout || '',
  ].join('\u001f');
  const panelRectFn = panel.getBoundingClientRect;
  const panelScrollHeightGetter = Object.getOwnPropertyDescriptor(panel, 'scrollHeight')?.get;
  const previousSnapshot = subtitleLayoutSnapshots.get(panel);
  if (
    previousSnapshot
    && previousSnapshot.key === snapshotKey
    && previousSnapshot.player === player
    && previousSnapshot.layer === layer
    && previousSnapshot.scope === scope
    && previousSnapshot.parent === panel.parentElement
    && previousSnapshot.fullscreenElement === fullscreenElement
    && previousSnapshot.panelRectFn === panelRectFn
    && previousSnapshot.panelScrollHeightGetter === panelScrollHeightGetter
  ) {
    return;
  }

  const saveSnapshot = () => {
    const finalHostRect = panel.parentElement?.id === VIDEO_SUBTITLE_SCROLL_HOST_ID
      ? panel.parentElement.getBoundingClientRect()
      : null;
    const finalKey = [
      playerRect.left, playerRect.top, playerRect.width, playerRect.height,
      layer.clientWidth, layer.clientHeight,
      viewport ? `${viewport.left},${viewport.top},${viewport.width},${viewport.height},${viewport.right},${viewport.bottom},${viewport.controlsInset}` : 'none',
      visibleControlsKey,
      finalHostRect ? `${finalHostRect.left},${finalHostRect.top},${finalHostRect.width},${finalHostRect.height}` : '',
      cachedAppearance.key,
      overlayText, normalizedText, readingText,
      active ? 1 : 0, menuOpen ? 1 : 0, learningOpen ? 1 : 0,
      fullscreen ? 1 : 0, compactPlayer ? 1 : 0,
      xPage ? 1 : 0, htmlMediaPage ? 1 : 0, youtubePage ? 1 : 0,
      config.on !== false ? 1 : 0, config.videoTranslationEnabled !== false ? 1 : 0, config.videoSubtitleVisible !== false ? 1 : 0,
      displayMode, normalizedCaptionActive ? 1 : 0,
      nativeCaptionTop === null ? '' : nativeCaptionTop,
      panel.classList.contains(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS) ? 1 : 0,
      panel.dataset.fluentReadSubtitleLayout || '',
    ].join('\u001f');
    subtitleLayoutSnapshots.set(panel, {
      key: finalKey,
      player,
      layer,
      scope,
      parent: panel.parentElement,
      fullscreenElement,
      panelRectFn,
      panelScrollHeightGetter,
    });
  };

  if (viewport) {
    setStyleIfChanged(layer, 'clip-path', `inset(${viewport.top}px ${viewport.right}px ${viewport.bottom}px ${viewport.left}px)`, 'important');
  } else {
    if (xPage) setStyleIfChanged(layer, 'clip-path', 'inset(50%)', 'important');
    else removeStyleIfPresent(layer, 'clip-path');
  }
  // 测量阶段不解除同句滚动交互；临时宿主与原 layer 始终使用相同坐标与显示状态。
  prepareSubtitlePanelLayout(panel, layer, player);

  if (appliedAppearanceKeys.get(panel) !== cachedAppearance.key) {
    for (const [name, value] of Object.entries(cachedAppearance.cssVars)) {
      setStyleIfChanged(panel, name, value);
    }
    setDataIfChanged(panel, 'fluentReadSubtitleSkin', appearance.skin);
    appliedAppearanceKeys.set(panel, cachedAppearance.key);
  }
  const availableWidth = Math.max(0, Math.min(playerWidth - 24, playerWidth * appearance.maxWidth / 100));
  const baseFontSize = Math.min(Math.max(playerWidth * .022, 16), 30);
  const fontScale = appearance.fontScale / 100;
  setStyleIfChanged(panel, '--fluent-read-video-subtitle-font-size', `${baseFontSize * fontScale}px`);

  // 双语面板固定在播放器底部安全区上方；字幕内容变化只会改变面板向上的高度，
  // 不会把整组字幕重新锚定到不同的 top。
  panel.classList.toggle(VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS, active);
  setStyleIfChanged(panel, 'width', 'max-content');
  setStyleIfChanged(panel, 'max-width', fullscreen
    ? `min(${availableWidth}px, calc(100% - max(12px, env(safe-area-inset-left, 0px)) - max(12px, env(safe-area-inset-right, 0px))))`
    : `${availableWidth}px`, 'important');
  const autoBottom = (xPage || htmlMediaPage || compactPlayer) && appearance.position === 'bottom' && appearance.autoBottom;
  const requestedOffset = autoBottom ? viewport?.controlsInset ?? getXSubtitleBottomInset(player) : appearance.bottomOffset === 10 ? Math.min(Math.max(playerHeight * .1, 52), 96) : Math.max(12, playerHeight * appearance.bottomOffset / 100);
  const offset = Math.min(requestedOffset, Math.max(0, playerHeight - 24));
  const bottomInset = `${(viewport?.bottom || 0) + offset}px`;
  setStyleIfChanged(panel, '--fluent-read-video-subtitle-bottom', fullscreen ? `max(${bottomInset}, calc(env(safe-area-inset-bottom, 0px) + 12px))` : bottomInset);
  const topInset = `${(viewport?.top || 0) + offset}px`;
  setStyleIfChanged(panel, 'top', appearance.position === 'top' ? fullscreen ? `max(${topInset}, calc(env(safe-area-inset-top, 0px) + 12px))` : topInset : appearance.position === 'center' ? viewport ? `${viewport.top + playerHeight / 2}px` : '50%' : 'auto', 'important');
  setStyleIfChanged(panel, 'bottom', appearance.position === 'bottom' ? 'var(--fluent-read-video-subtitle-bottom)' : 'auto', 'important');
  const maximumHeight = Math.max(0, playerHeight - (appearance.position === 'center' ? 24 : offset + 12));
  setStyleIfChanged(panel, 'max-height', fullscreen ? `min(${maximumHeight}px, calc(100% - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px))` : `${maximumHeight}px`, 'important');
  setStyleIfChanged(panel, 'transform', appearance.position === 'center' ? 'translateY(-50%)' : 'none');
  if (!active) {resetSubtitlePanelLayout(panel); saveSnapshot(); return;}

  // 背景只包住双语文本，并始终以视频画面中心为锚点；菜单浮层不挤占字幕空间。
  // 长字幕仍受播放器宽度限制，超出时在面板内部换行，而不是把半透明背景铺满整行。
  const centerPanel = () => {
    setStyleIfChanged(panel, 'left', `${(viewport?.left || 0) + 12}px`);
    const layerRect = viewport?.layerRect || layer.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const measuredWidth = panelRect.width / (layer.clientWidth > 0 && layerRect.width > 0 ? layerRect.width / layer.clientWidth : 1);
    const width = Math.min(Math.max(measuredWidth, 0), availableWidth);
    const usableRight = playerWidth - 12;
    const left = Math.max(12, Math.min((usableRight - width + 12) / 2, usableRight - width));
    const panelLeft = `${(viewport?.left || 0) + left}px`;
    setStyleIfChanged(panel, 'left', fullscreen
      ? `max(${(viewport?.left || 0) + 12}px, env(safe-area-inset-left, 0px), min(${panelLeft}, calc(100% - max(12px, env(safe-area-inset-right, 0px)) - ${width}px)))`
      : panelLeft);
    return panelRect;
  };
  // 菜单或学习面板开启时撤回兄弟宿主；字幕回原层且不接收指针，避免遮挡当前交互面板。
  if (!menuOpen && !learningOpen && youtubePage && compactPlayer && autoBottom && config.on !== false
    && config.videoTranslationEnabled !== false && config.videoSubtitleVisible !== false && viewport) {
    centerPanel();
    if (positionMobileYoutubeSubtitle(panel, player, layer, viewport, availableWidth, viewport.visibleControls, viewport.layerRect)) {
      saveSnapshot();
      return;
    }
  }
  finishSubtitlePanelLayout(panel, menuOpen || learningOpen);
  const fitMaxHeight = fullscreen ? Math.min(maximumHeight, panel.clientHeight || maximumHeight) : maximumHeight;
  const hasReading = Boolean(readingText);
  const requestedFontSize = baseFontSize * fontScale;
  const fontFitKey = `${overlayText}\0${normalizedText}\0${readingText}\0${availableWidth}|${fitMaxHeight}|${requestedFontSize}|${hasReading ? 1 : 0}|${displayMode}|${normalizedCaptionActive ? 1 : 0}|${appearance.karaoke ? 1 : 0}|${appearance.skin}|${appearance.lineSpacing}|${appearance.outlineStyle}|${appearance.outlineWidth}`;
  fitVideoSubtitleFontSize(
    requestedFontSize,
    fitMaxHeight,
    size => setStyleIfChanged(panel, '--fluent-read-video-subtitle-font-size', `${size}px`),
    () => panel.scrollHeight,
    hasReading ? 16 : 8,
    {target: panel, key: fontFitKey},
  );
  if (!menuOpen && hasReading && panel.scrollHeight > maximumHeight + 1) setSubtitlePanelScrollable(panel, true);
  const centeredPanelRect = centerPanel();

  // 双语模式下原生字幕仍然可见时，译文面板要放在原生字幕上方，不能用固定底部
  // 位置压住 YouTube 的分段字幕。逐词合并已经显示整段原文时，原文在同一个面板内，
  // 则继续使用固定底部锚点，避免随着原生 DOM 的词宽变化上下跳动。
  if (needsNativeAvoidance && nativeCaptionTop !== null) {
    const resolvedPlayerHeight = playerRect.height || 540;
    const panelHeight = centeredPanelRect.height;
    const fallbackBottom = Math.min(Math.max(resolvedPlayerHeight * .1, 52), 96);
    const maxBottom = Math.max(12, resolvedPlayerHeight - panelHeight - 12);
    const requestedBottom = resolvedPlayerHeight - nativeCaptionTop + 8;
    const bottom = Math.max(fallbackBottom, Math.min(requestedBottom, maxBottom));
    setStyleIfChanged(panel, '--fluent-read-video-subtitle-bottom', fullscreen ? `max(${bottom}px, calc(env(safe-area-inset-bottom, 0px) + 12px))` : `${bottom}px`);
  }
  saveSnapshot();
}

export function applyVideoDisplayState(container: HTMLElement): void {
  if (config.on === false || config.videoTranslationEnabled === false || config.videoSubtitleVisible === false) {
    document.querySelectorAll<HTMLElement>(`#${VIDEO_SUBTITLE_PANEL_ID}`).forEach(panel => {
      subtitleLayoutSnapshots.delete(panel);
      resetSubtitlePanelLayout(panel);
    });
  }
  syncVideoDisplayModeClasses(container);
  const layer = document.getElementById(VIDEO_TRANSLATION_LAYER_ID);
  if (layer) {
    syncVideoDisplayModeClasses(layer);
    syncSubtitleScrollHostState(layer);
  }
}

/** 同一份播放器样式可供顶层页面与课程字幕 Shadow Root 使用。 */
export function createVideoSubtitleStyle(ownerDocument: Document = document): HTMLStyleElement {
  const style = ownerDocument.createElement('style');
  style.id = 'fluent-read-video-subtitle-style';
  style.textContent = buildVideoSubtitleStyleText({
    aiCaptionContainerId: VIDEO_AI_CAPTION_CONTAINER_ID,
    captionSegmentClass: VIDEO_CAPTION_SEGMENT_SELECTOR.slice(1),
    translationLayerId: VIDEO_TRANSLATION_LAYER_ID,
    subtitleScrollHostId: VIDEO_SUBTITLE_SCROLL_HOST_ID,
    subtitlePanelId: VIDEO_SUBTITLE_PANEL_ID,
    subtitlePanelActiveClass: VIDEO_SUBTITLE_PANEL_ACTIVE_CLASS,
    translationOverlayId: VIDEO_TRANSLATION_OVERLAY_ID,
    normalizedCaptionOverlayId: VIDEO_NORMALIZED_CAPTION_OVERLAY_ID,
    readingOverlayId: VIDEO_READING_OVERLAY_ID,
    displayTranslationOnlyClass: VIDEO_DISPLAY_TRANSLATION_ONLY_CLASS,
    karaokeUnitClass: VIDEO_KARAOKE_UNIT_CLASS,
    karaokeStateAttribute: VIDEO_KARAOKE_STATE_ATTRIBUTE,
    karaokeTextAttribute: VIDEO_KARAOKE_TEXT_ATTRIBUTE,
    karaokeFillProperty: VIDEO_KARAOKE_FILL_PROPERTY,
    normalizedCaptionActiveClass: VIDEO_NORMALIZED_CAPTION_ACTIVE_CLASS,
    displayOriginalOnlyClass: VIDEO_DISPLAY_ORIGINAL_ONLY_CLASS,
    displayHiddenClass: VIDEO_DISPLAY_HIDDEN_CLASS,
    nativeCaptionHiddenClass: VIDEO_NATIVE_CAPTION_HIDDEN_CLASS,
    normalizedCaptionClass: VIDEO_NORMALIZED_CAPTION_CLASS,
    nativeCueHiddenClass: VIDEO_NATIVE_CUE_HIDDEN_CLASS,
    translationButtonId: VIDEO_TRANSLATION_BUTTON_ID,
    playerProgressAttribute: VIDEO_PLAYER_PROGRESS_ATTRIBUTE,
    translationActiveClass: VIDEO_TRANSLATION_ACTIVE_CLASS,
    playerStatusAttribute: VIDEO_PLAYER_STATUS_ATTRIBUTE,
    fallbackControlsClass: VIDEO_FALLBACK_CONTROLS_CLASS,
    playerHostClass: VIDEO_PLAYER_HOST_CLASS,
    playerActiveAttribute: VIDEO_PLAYER_ACTIVE_ATTRIBUTE,
    translationMenuId: VIDEO_TRANSLATION_MENU_ID,
  });
  return style;
}

export function installVideoSubtitleStyle(): HTMLStyleElement {
  const existing = document.getElementById('fluent-read-video-subtitle-style');
  if (existing instanceof HTMLStyleElement) return existing;
  const style = createVideoSubtitleStyle();
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
