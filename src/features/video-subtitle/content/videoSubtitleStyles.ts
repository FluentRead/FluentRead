/**
 * @file src/features/video-subtitle/content/videoSubtitleStyles.ts
 * 文件职责：集中维护视频双语字幕覆盖层、播放器控制按钮、交互菜单及 Shadow Root 复用的完整 CSS 样式表生成逻辑。
 * 主要内容：基于外部传入的 DOM 标识与状态类名令牌生成样式文本，覆盖逐字卡拉 OK、双语顺序切换、高对比度与移动端安全区。
 * 模块边界：纯字符串构建模块，不直接访问 DOM、window 或配置状态，也不反向依赖 ui.ts，避免产生循环引用。
 */

export interface VideoSubtitleStyleTokens {
  aiCaptionContainerId: string;
  captionSegmentClass: string;
  translationLayerId: string;
  subtitleScrollHostId: string;
  subtitlePanelId: string;
  subtitlePanelActiveClass: string;
  translationOverlayId: string;
  normalizedCaptionOverlayId: string;
  readingOverlayId: string;
  displayTranslationOnlyClass: string;
  karaokeUnitClass: string;
  karaokeStateAttribute: string;
  karaokeTextAttribute: string;
  karaokeFillProperty: string;
  normalizedCaptionActiveClass: string;
  displayOriginalOnlyClass: string;
  displayHiddenClass: string;
  nativeCaptionHiddenClass: string;
  normalizedCaptionClass: string;
  nativeCueHiddenClass: string;
  translationButtonId: string;
  playerProgressAttribute: string;
  translationActiveClass: string;
  playerStatusAttribute: string;
  fallbackControlsClass: string;
  playerHostClass: string;
  playerActiveAttribute: string;
  translationMenuId: string;
}

export function buildVideoSubtitleStyleText(tokens: VideoSubtitleStyleTokens): string {
  const {
    aiCaptionContainerId,
    captionSegmentClass,
    translationLayerId,
    subtitleScrollHostId,
    subtitlePanelId,
    subtitlePanelActiveClass,
    translationOverlayId,
    normalizedCaptionOverlayId,
    readingOverlayId,
    displayTranslationOnlyClass,
    karaokeUnitClass,
    karaokeStateAttribute,
    karaokeTextAttribute,
    karaokeFillProperty,
    normalizedCaptionActiveClass,
    displayOriginalOnlyClass,
    displayHiddenClass,
    nativeCaptionHiddenClass,
    normalizedCaptionClass,
    nativeCueHiddenClass,
    translationButtonId,
    playerProgressAttribute,
    translationActiveClass,
    playerStatusAttribute,
    fallbackControlsClass,
    playerHostClass,
    playerActiveAttribute,
    translationMenuId,
  } = tokens;
  return `#${aiCaptionContainerId} {
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
#${aiCaptionContainerId} .${captionSegmentClass} {
display: block !important;
}
:is(#${translationLayerId}, #${subtitleScrollHostId}) {
position: absolute !important;
inset: 0 !important;
z-index: 2147483645 !important;
overflow: hidden !important;
pointer-events: none !important;
visibility: visible !important;
}
#${translationLayerId} {
contain: layout style !important;
}
#${subtitleScrollHostId} {
inset: auto !important;
left: 0 !important;
top: 0 !important;
margin: 0 !important;
padding: 0 !important;
border: 0 !important;
transform-origin: 0 0 !important;
z-index: 2147483646 !important;
}
#${subtitlePanelId} {
display: none !important;
position: absolute !important;
z-index: 2 !important;
box-sizing: border-box !important;
contain: layout style !important;
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
#${subtitlePanelId}.${subtitlePanelActiveClass} {
display: flex !important;
}
#${subtitlePanelId}[data-fluent-read-subtitle-scrollable="true"] {
overflow-y: auto !important;
overflow-x: hidden !important;
pointer-events: auto !important;
touch-action: pan-y pinch-zoom !important;
overscroll-behavior: contain !important;
}
#${subtitlePanelId}[data-fluent-read-subtitle-scrollable="true"] > div { flex-shrink: 0 !important; }
#${subtitlePanelId}[data-fluent-read-subtitle-scrollable="true"]:focus-visible { outline: 2px solid currentColor !important; outline-offset: -2px !important; }
#${translationOverlayId} {
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
text-wrap: balance !important;
-webkit-font-smoothing: antialiased !important;
overflow-wrap: anywhere !important;
min-width: 0 !important;
pointer-events: none !important;
user-select: none !important;
visibility: visible !important;
}
#${translationOverlayId}:empty { display: none !important; }
#${normalizedCaptionOverlayId} {
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
text-wrap: balance !important;
-webkit-font-smoothing: antialiased !important;
overflow-wrap: anywhere !important;
min-width: 0 !important;
pointer-events: none !important;
user-select: none !important;
visibility: visible !important;
}
#${normalizedCaptionOverlayId}:empty { display: none !important; }
#${readingOverlayId} {
order: 2 !important; display: block !important; max-width: 100% !important; min-width: 0 !important;
margin: 0 !important; padding: 0 !important; border: 0 !important;
font: 500 max(12px, calc(var(--fluent-read-video-subtitle-font-size, 20px) * .72))/1.4 Arial, sans-serif !important;
color: var(--fluent-read-video-subtitle-text-color, #fff) !important;
text-align: center !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important;
text-shadow: var(--fluent-read-video-subtitle-text-shadow, 0 1px 2px #000) !important;
pointer-events: none !important; user-select: none !important;
}
#${readingOverlayId}:empty,
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayTranslationOnlyClass} #${readingOverlayId} {display:none !important;}
#${translationOverlayId} { --fluent-read-video-karaoke-color: var(--fluent-read-video-subtitle-translation-color, #ffe45c); }
#${normalizedCaptionOverlayId} { --fluent-read-video-karaoke-color: var(--fluent-read-video-subtitle-text-color, #fff); }
.${karaokeUnitClass} {
display: inline-block !important;
position: relative !important;
color: color-mix(in srgb, var(--fluent-read-video-karaoke-color) 46%, transparent) !important;
}
.${karaokeUnitClass}[${karaokeStateAttribute}="sung"] { color: var(--fluent-read-video-karaoke-color) !important; }
.${karaokeUnitClass}[${karaokeStateAttribute}="active"]::after {
content: attr(${karaokeTextAttribute}) !important;
content: attr(${karaokeTextAttribute}) / "" !important;
position: absolute !important;
inset: 0 !important;
color: var(--fluent-read-video-karaoke-color) !important;
text-shadow: none !important;
clip-path: inset(-.3em calc(100% - var(${karaokeFillProperty}, 0%)) -.3em -.3em) !important;
pointer-events: none !important;
}
.${karaokeUnitClass}[${karaokeStateAttribute}="active"]:dir(rtl)::after {
clip-path: inset(-.3em -.3em -.3em calc(100% - var(${karaokeFillProperty}, 0%))) !important;
}
:is(#${translationLayerId}, #${subtitleScrollHostId}).${normalizedCaptionActiveClass} #${normalizedCaptionOverlayId} {
display: block !important;
}
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayTranslationOnlyClass} #${normalizedCaptionOverlayId},
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayOriginalOnlyClass} #${translationOverlayId},
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayHiddenClass} {
visibility: hidden !important;
}
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayTranslationOnlyClass} #${normalizedCaptionOverlayId},
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayOriginalOnlyClass} #${translationOverlayId} {
display: none !important;
}
.${nativeCaptionHiddenClass} :is(#ytp-caption-window-container, .ytp-caption-window-container) {
opacity: 0 !important;
}
.${nativeCaptionHiddenClass} :is(#ytp-caption-window-container, .ytp-caption-window-container) :is(.ytp-caption-segment, .captions-text),
#ytp-caption-window-container.${normalizedCaptionClass} .ytp-caption-segment,
#ytp-caption-window-container.${normalizedCaptionClass} .captions-text,
.ytp-caption-window-container.${normalizedCaptionClass} .ytp-caption-segment,
.ytp-caption-window-container.${normalizedCaptionClass} .captions-text {
visibility: hidden !important;
}
video.${nativeCueHiddenClass}::-webkit-media-text-track-container {
display: none !important;
visibility: hidden !important;
opacity: 0 !important;
}
video.${nativeCueHiddenClass}::-webkit-media-text-track-display {
display: none !important;
visibility: hidden !important;
opacity: 0 !important;
}
video.${nativeCueHiddenClass}::cue {
color: transparent !important;
background: transparent !important;
background-color: transparent !important;
text-shadow: none !important;
outline: none !important;
opacity: 0 !important;
visibility: hidden !important;
}
:is(#${translationLayerId}, #${subtitleScrollHostId}).${displayHiddenClass} {
visibility: hidden !important;
}
#${translationButtonId} {
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
#${translationButtonId}[${playerProgressAttribute}] {
width: auto !important;
min-width: 32px !important;
gap: 4px !important;
white-space: nowrap !important;
}
#${translationButtonId}[${playerProgressAttribute}]::after {
content: attr(${playerProgressAttribute}) !important;
display: inline-block !important;
color: rgba(255, 255, 255, .82) !important;
font-size: 10px !important;
font-weight: 600 !important;
line-height: 1 !important;
white-space: nowrap !important;
}
#${translationButtonId}:hover,
#${translationButtonId}:focus-visible { opacity: 1 !important; }
#${translationButtonId} .fluent-read-video-subtitle-button-icon {
display: block !important;
width: 16px !important;
height: 16px !important;
border-radius: 4px !important;
background: transparent !important;
object-fit: cover !important;
overflow: hidden !important;
transform: translateY(0) !important;
}
#${translationButtonId}.fluent-read-video-subtitle-x-button {
width: 28px !important;
height: 28px !important;
}
#${translationButtonId}.fluent-read-video-subtitle-x-button[${playerProgressAttribute}] {
width: auto !important;
}
#${translationButtonId}.${translationActiveClass} .fluent-read-video-subtitle-button-icon {
background: #ec4899 !important;
box-shadow: 0 0 0 1px rgba(255, 255, 255, .16), 0 2px 8px rgba(236, 72, 153, .42) !important;
}
#${translationButtonId}:not(.${translationActiveClass}) .fluent-read-video-subtitle-button-icon {
background: rgba(236, 72, 153, .16) !important;
box-shadow: 0 0 0 1px rgba(236, 72, 153, .62), 0 2px 8px rgba(236, 72, 153, .2) !important;
}
#${translationButtonId}[${playerStatusAttribute}="error"] .fluent-read-video-subtitle-button-icon {
box-shadow: 0 0 0 1.5px #f59e0b, 0 2px 8px rgba(245, 158, 11, .42) !important;
}
#${translationButtonId}[${playerStatusAttribute}="retrying"] .fluent-read-video-subtitle-button-icon {
box-shadow: 0 0 0 1.5px rgba(251, 191, 36, .85), 0 2px 8px rgba(251, 191, 36, .3) !important;
}
.${fallbackControlsClass} {
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
.${playerHostClass}[${playerActiveAttribute}="true"] .${fallbackControlsClass},
.${playerHostClass}:fullscreen .${fallbackControlsClass},
.${playerHostClass}[data-fluent-read-video-fullscreen="true"] .${fallbackControlsClass} {
display: flex !important;
}
.fluent-read-html-media-host[hidden] {
display: none !important;
}
.fluent-read-html-media-host > .fluent-read-video-controls {
top: 4px !important; bottom: auto !important; right: 4px !important;
display: flex !important; pointer-events: auto !important;
}
.fluent-read-html-media-host > #${translationMenuId} { pointer-events: auto !important; }
#${translationMenuId}, #fluent-read-video-learning-panel {
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
#${translationMenuId} {
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
#${translationMenuId}[data-layout="wide"] { width: min(440px, calc(100% - 16px)) !important; }
#${translationMenuId}#${translationMenuId}[hidden],
#${translationMenuId}#${translationMenuId} [hidden] { display: none !important; }
#${translationMenuId} * {
box-sizing: border-box !important;
font-family: inherit !important;
text-transform: none !important;
letter-spacing: normal !important;
text-shadow: none !important;
}
#${translationMenuId} button {
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
#${translationMenuId} button:focus-visible {
outline: 2px solid var(--fr-video-menu-brand-text) !important;
outline-offset: -2px !important;
}
#${translationMenuId} button:disabled { cursor: default !important; opacity: .45 !important; }
#${translationMenuId} .fluent-read-video-menu-icon {
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
#${translationMenuId} .fluent-read-video-menu-icon-sparkle { fill: currentColor !important; stroke-width: 1 !important; }
#${translationMenuId} .fluent-read-video-menu-learning {
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
#${translationMenuId} .fluent-read-video-menu-learning:hover { background: rgba(239, 71, 118, .28) !important; }
#${translationMenuId} .fluent-read-video-menu-learning:disabled { opacity: .45 !important; cursor: default !important; }
#${translationMenuId} .fluent-read-video-menu-learning-label { flex: 1 !important; }
#${translationMenuId} .fluent-read-video-menu-learning .fluent-read-video-menu-icon-next { width: 16px !important; height: 16px !important; }
#${translationMenuId} .fluent-read-video-menu-main,
#${translationMenuId} .fluent-read-video-menu-body,
#${translationMenuId} .fluent-read-video-menu-section {
display: grid !important;
grid-template-columns: minmax(0, 1fr) !important;
gap: 6px !important;
min-width: 0 !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-section {
display: flex !important;
flex-wrap: wrap !important;
align-items: center !important;
column-gap: 10px !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-mode-group { flex: 0 0 auto !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-timing { flex: 1 1 0 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label { contain: inline-size !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-ai-group { flex: 1 1 0 !important; min-width: 128px !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-downloads { flex: 1 0 auto !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-ai-group + .fluent-read-video-menu-downloads { flex-grow: 0 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-download {
flex-direction: row !important;
gap: 4px !important;
min-height: 26px !important;
padding: 0 8px !important;
font-size: 11px !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-download .fluent-read-video-menu-label { min-width: auto !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-download-status { flex: 1 0 100% !important; }
#${translationMenuId} .fluent-read-video-menu-title {
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
#${translationMenuId} .fluent-read-video-menu-brand {
flex: 0 0 auto !important;
color: var(--fr-video-menu-brand-text) !important;
font-size: 11px !important;
font-weight: 650 !important;
}
#${translationMenuId} .fluent-read-video-menu-settings {
min-width: 24px !important;
min-height: 24px !important;
padding: 0 5px !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10px !important;
}
#${translationMenuId} .fluent-read-video-menu-settings:hover { background: var(--fr-video-menu-control) !important; color: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-menu-settings .fluent-read-video-menu-icon { width: 13px !important; height: 13px !important; }
#${translationMenuId} .fluent-read-video-menu-service {
min-width: 0 !important;
max-width: 120px !important;
overflow: hidden !important;
text-overflow: ellipsis !important;
white-space: nowrap !important;
}
#${translationMenuId} .fluent-read-video-menu-close {
width: 28px !important;
height: 28px !important;
flex: 0 0 28px !important;
color: var(--fr-video-menu-muted) !important;
}
#${translationMenuId} .fluent-read-video-menu-title .fluent-read-video-menu-settings { margin-left: auto !important; }
#${translationMenuId} .fluent-read-video-menu-close:hover { background: var(--fr-video-menu-control-hover) !important; }
#${translationMenuId} .fluent-read-video-menu-source,
#${translationMenuId} .fluent-read-video-menu-translation-status {
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
#${translationMenuId} .fluent-read-video-menu-source-status { grid-column: 1 / -1 !important; font-weight: 400 !important; }
#${translationMenuId} .fluent-read-video-menu-source-hint {
margin: 0 !important;
padding: 0 !important;
color: var(--fr-video-menu-muted) !important;
font: inherit !important;
}
#${translationMenuId} .fluent-read-video-menu-source[data-error="true"] .fluent-read-video-menu-source-hint,
#${translationMenuId} .fluent-read-video-menu-translation-status[data-error="true"] .fluent-read-video-menu-source-hint,
#${translationMenuId} .fluent-read-video-menu-translation-status[data-status="retrying"] .fluent-read-video-menu-source-hint { color: #e4bd8d !important; }
#${translationMenuId} .fluent-read-video-menu-source-actions { display: flex !important; flex-wrap: wrap !important; gap: 4px 12px !important; }
#${translationMenuId} .fluent-read-video-menu-secondary {
min-height: 30px !important;
color: var(--fr-video-menu-muted) !important;
white-space: normal !important;
text-align: left !important;
}
#${translationMenuId} .fluent-read-video-menu-secondary[data-action="retry-subtitle-translation"] { color: var(--fr-video-menu-brand-text) !important; font-weight: 600 !important; }
#${translationMenuId} .fluent-read-video-menu-secondary:hover { text-decoration: underline !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-watch,
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-tools {
display: grid !important;
grid-template-columns: minmax(0, 1fr) !important;
gap: 6px !important;
}
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-close { height: 26px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-source .fluent-read-video-menu-secondary { min-height: 26px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-title { gap: 4px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-brand { color: var(--fr-video-menu-text) !important; font-size: 12px !important; font-weight: 600 !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-settings { font-size: 11px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-more {
justify-content: space-between !important;
min-height: 30px !important;
padding: 2px 4px 0 !important;
border-top: 1px solid rgba(255,255,255,.08) !important;
border-radius: 0 !important;
color: var(--fr-video-menu-muted) !important;
}
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-more:hover { color: var(--fr-video-menu-text) !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-model {
justify-content: space-between !important;
min-height: 32px !important;
padding: 2px 4px !important;
gap: 8px !important;
color: var(--fr-video-menu-text) !important;
text-align: left !important;
white-space: normal !important;
}
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-model .fluent-read-video-menu-label { min-width: 0 !important; overflow-wrap: anywhere !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-model .fluent-read-video-menu-icon { flex: none !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-back { width: 24px !important; height: 28px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-export { display: grid !important; gap: 6px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-download { flex-direction: row !important; min-height: 32px !important; padding: 2px 4px !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-secondary-ai .fluent-read-video-menu-ai {
min-height: 28px !important;
padding: 0 4px !important;
background: transparent !important;
box-shadow: none !important;
color: var(--fr-video-menu-muted) !important;
}
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-secondary-ai .fluent-read-video-menu-ai[data-ready="true"] .fluent-read-video-menu-value { display: none !important; }
#${translationMenuId}[data-compact="true"] .fluent-read-video-menu-tools > .fluent-read-video-menu-secondary { justify-content: flex-start !important; padding: 0 4px !important; }
#${translationMenuId}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-tools { gap: 4px !important; }
#${translationMenuId}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-export { grid-template-columns: minmax(0, 1fr) !important; }
#${translationMenuId}[data-compact="true"][data-layout="wide"] .fluent-read-video-menu-export .fluent-read-video-menu-download-status { grid-column: 1 / -1 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-source {
display: grid !important;
grid-template-columns: minmax(0, 1fr) auto !important;
align-items: center !important;
column-gap: 8px !important;
padding: 4px 8px !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-source-hint { grid-column: 1 / -1 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-source-actions { grid-column: 2 !important; grid-row: 1 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-main,
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-section { gap: 4px !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-close { height: 24px !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-secondary { min-height: 24px !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-mode { min-height: 28px !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-ai { min-height: 30px !important; }
#${translationMenuId} .fluent-read-video-menu-order-controls { min-width: 0 !important; flex: 1 1 auto !important; }
#${translationMenuId} .fluent-read-video-menu-order-setting { display: grid !important; gap: 3px !important; min-width: 0 !important; }
#${translationMenuId} .fluent-read-video-menu-order-choice { display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 5px !important; }
#${translationMenuId} .fluent-read-video-menu-order-choice > span:last-child { min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; }
#${translationMenuId} .fluent-read-video-menu-order-diagram { display: grid !important; gap: 3px !important; flex: 0 0 12px !important; width: 12px !important; }
#${translationMenuId} .fluent-read-video-menu-order-diagram > span { display: block !important; height: 2px !important; border-radius: 1px !important; }
#${translationMenuId} .fluent-read-video-menu-order-original { background: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-menu-order-translation { background: var(--fr-video-menu-brand-text) !important; width: 9px !important; }
#${translationMenuId} .fluent-read-video-menu-order-setting[data-active="false"] .fluent-read-video-menu-mode[aria-checked="true"] { background: var(--fr-video-menu-control) !important; box-shadow: inset 0 0 0 1px var(--fr-video-menu-border) !important; color: var(--fr-video-menu-muted) !important; }
#${translationMenuId} .fluent-read-video-menu-mode-shortcut {
display: inline-flex !important;
align-items: center !important;
justify-self: end !important;
max-width: 100% !important;
padding: 1px 6px !important;
border-radius: 999px !important;
background: var(--fr-video-menu-control) !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10px !important;
font-weight: 500 !important;
line-height: 1.4 !important;
white-space: nowrap !important;
overflow: hidden !important;
text-overflow: ellipsis !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-menu-mode-shortcut {
flex: 1 0 100% !important;
width: fit-content !important;
margin-left: auto !important;
}
#${translationMenuId} .fluent-read-video-menu-mode-group,
#${translationMenuId} .fluent-read-video-menu-order-controls {
display: flex !important;
gap: 2px !important;
padding: 2px !important;
border-radius: 8px !important;
background: var(--fr-video-menu-control) !important;
}
#${translationMenuId} .fluent-read-video-menu-mode {
flex: 1 1 auto !important;
min-height: 32px !important;
padding: 0 4px !important;
color: var(--fr-video-menu-muted) !important;
font-size: 11px !important;
font-weight: 500 !important;
overflow: hidden !important;
text-overflow: ellipsis !important;
}
#${translationMenuId} .fluent-read-video-menu-mode:hover { color: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-menu-mode[aria-checked="true"] {
background: var(--fr-video-menu-brand-soft) !important;
box-shadow: inset 0 0 0 1px rgba(239, 71, 118, .32) !important;
color: var(--fr-video-menu-brand-text) !important;
font-weight: 600 !important;
}
#${translationMenuId} .fluent-read-video-menu-mode[data-mode="off"][aria-checked="true"] {
background: rgba(255, 255, 255, .14) !important;
box-shadow: none !important;
color: var(--fr-video-menu-text) !important;
}
#${translationMenuId} .fluent-read-video-menu-row {
display: flex !important;
align-items: center !important;
justify-content: space-between !important;
gap: 8px !important;
min-height: 26px !important;
padding: 0 0 0 4px !important;
}
#${translationMenuId} .fluent-read-video-menu-row-label {
flex: 1 1 auto !important;
min-width: 0 !important;
overflow: hidden !important;
color: var(--fr-video-menu-muted) !important;
text-overflow: ellipsis !important;
white-space: nowrap !important;
}
#${translationMenuId} .fluent-read-video-menu-timing-controls {
display: inline-flex !important;
flex: 0 0 auto !important;
align-items: center !important;
gap: 2px !important;
direction: ltr !important;
}
#${translationMenuId} .fluent-read-video-menu-step {
width: 24px !important;
height: 24px !important;
background: var(--fr-video-menu-control) !important;
}
#${translationMenuId} .fluent-read-video-menu-step:hover:not(:disabled) { background: var(--fr-video-menu-control-hover) !important; }
#${translationMenuId} .fluent-read-video-menu-step-reset { width: 24px !important; min-height: 24px !important; margin-right: 2px !important; background: transparent !important; color: var(--fr-video-menu-muted) !important; }
#${translationMenuId} .fluent-read-video-menu-step-reset:hover { color: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-menu-step-reset:disabled { display: none !important; }
#${translationMenuId} .fluent-read-video-menu-timing-value {
min-width: 40px !important;
color: var(--fr-video-menu-text) !important;
font-size: 11px !important;
font-variant-numeric: tabular-nums !important;
text-align: center !important;
}
#${translationMenuId} .fluent-read-video-menu-ai-group { container: fluent-read-video-ai / inline-size !important; }
@container fluent-read-video-ai (max-width: 190px) {
#${translationMenuId} .fluent-read-video-menu-ai:not([data-error="true"]) .fluent-read-video-menu-value { display: none !important; }
}
#${translationMenuId} .fluent-read-video-menu-ai {
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
#${translationMenuId} .fluent-read-video-menu-ai:hover:not(:disabled) { background: rgba(239, 71, 118, .28) !important; }
#${translationMenuId} .fluent-read-video-menu-ai[data-native="true"],
#${translationMenuId} .fluent-read-video-menu-ai[data-ready="true"] {
background: var(--fr-video-menu-control) !important;
box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1) !important;
color: var(--fr-video-menu-text) !important;
}
#${translationMenuId} .fluent-read-video-menu-ai[data-ready="true"]:hover { background: var(--fr-video-menu-control-hover) !important; }
#${translationMenuId} .fluent-read-video-menu-ai:disabled[data-processing="true"] { opacity: 1 !important; }
#${translationMenuId} .fluent-read-video-menu-ai .fluent-read-video-menu-label {
flex: 0 1 auto !important;
min-width: 0 !important;
overflow: hidden !important;
font-size: 11.5px !important;
font-weight: 600 !important;
text-overflow: ellipsis !important;
}
#${translationMenuId} .fluent-read-video-menu-ai .fluent-read-video-menu-value {
flex: 0 1 auto !important;
min-width: 0 !important;
margin-left: auto !important;
overflow: hidden !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10.5px !important;
font-variant-numeric: tabular-nums !important;
text-overflow: ellipsis !important;
}
#${translationMenuId} .fluent-read-video-menu-ai .fluent-read-video-menu-value:empty { display: none !important; }
#${translationMenuId} .fluent-read-video-menu-ai[data-ready="true"] .fluent-read-video-menu-value { color: #8fdcbf !important; }
#${translationMenuId} .fluent-read-video-menu-ai[data-error="true"] {
flex-wrap: wrap !important;
row-gap: 0 !important;
padding: 6px 8px !important;
}
#${translationMenuId} .fluent-read-video-menu-ai[data-error="true"] .fluent-read-video-menu-value {
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
#${translationMenuId} .fluent-read-video-menu-progress {
position: absolute !important;
left: 0 !important;
bottom: 0 !important;
display: none !important;
width: 100% !important;
height: 2px !important;
background: var(--fr-video-menu-brand) !important;
transform-origin: left center !important;
transform: scaleX(var(--fluent-read-video-ai-progress-scale, 0)) !important;
transition: transform .3s ease !important;
}
#${translationMenuId} .fluent-read-video-menu-ai[data-progress="determinate"] .fluent-read-video-menu-progress { display: block !important; }
#${translationMenuId} .fluent-read-video-menu-ai[data-progress="indeterminate"] .fluent-read-video-menu-progress {
display: block !important;
width: 36% !important;
transform: none !important;
animation: fluent-read-video-menu-indeterminate 1.2s ease-in-out infinite !important;
}
@keyframes fluent-read-video-menu-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(280%); } }
#${translationMenuId} .fluent-read-video-menu-downloads {
display: grid !important;
grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
gap: 4px !important;
}
#${translationMenuId} .fluent-read-video-menu-format-select {
grid-column: 1 / -1 !important;
width: 100% !important;
min-height: 28px !important;
padding: 4px 8px !important;
border: 1px solid var(--fr-video-menu-border) !important;
border-radius: 6px !important;
color: var(--fr-video-menu-text) !important;
background: var(--fr-video-menu-control) !important;
font: inherit !important;
font-size: 11px !important;
cursor: pointer !important;
}
#${translationMenuId} .fluent-read-video-menu-format-select:hover {
background: var(--fr-video-menu-control-hover) !important;
}
#${translationMenuId} .fluent-read-video-menu-format-select:focus-visible {
outline: 2px solid var(--fr-video-menu-brand-text) !important;
outline-offset: -2px !important;
}
#${translationMenuId} .fluent-read-video-menu-format-select option {
background: var(--fr-video-menu-surface) !important;
color: var(--fr-video-menu-text) !important;
}
#${translationMenuId} .fluent-read-video-menu-download {
flex-direction: column !important;
gap: 1px !important;
min-height: 38px !important;
padding: 4px 4px !important;
font-size: 10.5px !important;
background: var(--fr-video-menu-control) !important;
color: rgba(255, 255, 255, .82) !important;
}
#${translationMenuId} .fluent-read-video-menu-download:hover:not(:disabled) { background: var(--fr-video-menu-control-hover) !important; color: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-menu-download .fluent-read-video-menu-icon { width: 13px !important; height: 13px !important; }
#${translationMenuId} .fluent-read-video-menu-download .fluent-read-video-menu-label { min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; }
#${translationMenuId} .fluent-read-video-menu-download[aria-busy="true"] { opacity: 1 !important; }
#${translationMenuId} .fluent-read-video-menu-download[aria-busy="true"] .fluent-read-video-menu-icon { display: none !important; }
#${translationMenuId} .fluent-read-video-menu-download[aria-busy="true"]::before {
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
#${translationMenuId} .fluent-read-video-menu-download-status {
margin: -2px 0 0 !important;
padding: 0 4px 2px !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10.5px !important;
overflow-wrap: anywhere !important;
}
#${translationMenuId} .fluent-read-video-menu-download-status:empty,
#${translationMenuId}[data-measuring] .fluent-read-video-menu-download-status { display: none !important; }
#${translationMenuId} .fluent-read-video-menu-export {
display: grid !important;
grid-template-columns: minmax(0, 1fr) !important;
gap: 4px !important;
min-width: 0 !important;
width: 100% !important;
}
#${translationMenuId} .fluent-read-video-menu-reading,
#${translationMenuId} .fluent-read-video-menu-reading-feedback { display: contents !important; }
#${translationMenuId} .fluent-read-video-menu-reading-header { flex: 0 0 auto !important; }
#${translationMenuId} .fluent-read-video-menu-reading-toggle {
position: relative !important;
width: 28px !important;
height: 28px !important;
padding: 3px !important;
border: 1px solid transparent !important;
background: transparent !important;
color: var(--fr-video-menu-muted) !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-toggle .fluent-read-video-menu-icon { width: 20px !important; height: 20px !important; stroke-width: 1.7 !important; }
#${translationMenuId} .fluent-read-video-menu-reading-toggle[aria-checked="false"]:is(:hover, :focus-visible):not(:disabled) {
background: var(--fr-video-menu-control) !important;
color: var(--fr-video-menu-text) !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-toggle[aria-checked="true"] {
background: var(--fr-video-menu-brand-soft) !important;
border-color: rgba(239, 71, 118, .32) !important;
color: var(--fr-video-menu-brand-text) !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-toggle[aria-checked="true"]:hover:not(:disabled) {
background: rgba(239, 71, 118, .28) !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-help {
padding: 9px !important;
border: 1px solid var(--fr-video-menu-border) !important;
border-radius: 8px !important;
background: var(--fr-video-menu-control) !important;
font-size: 11px !important;
line-height: 1.55 !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-help[popover] {
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
#${translationMenuId} .fluent-read-video-menu-reading-help::backdrop { background: transparent !important; pointer-events: none !important; }
#${translationMenuId} .fluent-read-video-menu-reading-help p { margin: 0 !important; padding: 0 !important; }
#${translationMenuId} .fluent-read-video-menu-reading-example {
display: grid !important;
gap: 2px !important;
margin: 8px 0 !important;
padding: 7px 9px !important;
border-radius: 6px !important;
background: var(--fr-video-menu-surface) !important;
}
#${translationMenuId} .fluent-read-video-menu-reading-example-label,
#${translationMenuId} .fluent-read-video-menu-reading-note { color: var(--fr-video-menu-muted) !important; font-size: 10.5px !important; }
#${translationMenuId} .fluent-read-video-menu-reading-example-text { color: var(--fr-video-menu-brand-text) !important; }
#${translationMenuId} .fluent-read-video-menu-reading-help .fluent-read-video-menu-reading-note + p { margin-top: 6px !important; }
#${translationMenuId} .fluent-read-video-menu-reading > .fluent-read-video-menu-source-hint { padding: 0 4px !important; }
#${translationMenuId} .fluent-read-video-menu-download-toggle {
flex: 0 0 28px !important;
width: 28px !important;
height: 28px !important;
padding: 3px !important;
color: var(--fr-video-menu-muted) !important;
}
#${translationMenuId} .fluent-read-video-menu-download-toggle:hover { color: var(--fr-video-menu-text) !important; background: var(--fr-video-menu-control) !important; }
#${translationMenuId} .fluent-read-video-menu-download-toggle[aria-expanded="true"] { color: var(--fr-video-menu-brand-text) !important; background: var(--fr-video-menu-brand-soft) !important; }
#${translationMenuId} .fluent-read-video-menu-export .fluent-read-video-menu-download {
flex-direction: row !important;
gap: 4px !important;
min-height: 28px !important;
padding: 4px !important;
}
#${translationMenuId}[data-view="export-prompt"] .fluent-read-video-model-prompt.fluent-read-video-export-prompt { display: flex !important; flex-direction: column !important; gap: 8px !important; }
#${translationMenuId} .fluent-read-video-export-actions { flex-wrap: wrap !important; }
#${translationMenuId} .fluent-read-video-export-actions button { white-space: normal !important; }
#${translationMenuId} .fluent-read-video-model-prompt {
display: grid !important;
grid-template-columns: minmax(0, 1fr) !important;
gap: 8px !important;
padding: 2px 2px 0 !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-model-prompt {
grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) !important;
column-gap: 12px !important;
}
#${translationMenuId}[data-layout="wide"] .fluent-read-video-model-prompt-head { grid-column: 1 / -1 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-model-prompt-description { grid-area: 2 / 1 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-model-options { grid-area: 2 / 2 / 4 / 3 !important; }
#${translationMenuId}[data-layout="wide"] .fluent-read-video-model-prompt-actions { grid-area: 3 / 1 !important; align-self: end !important; justify-content: flex-start !important; }
#${translationMenuId} .fluent-read-video-model-prompt-head {
display: flex !important;
align-items: center !important;
gap: 6px !important;
min-height: 32px !important;
padding-left: 2px !important;
color: var(--fr-video-menu-brand-text) !important;
}
#${translationMenuId} .fluent-read-video-model-prompt-title {
flex: 1 1 auto !important;
min-width: 0 !important;
color: var(--fr-video-menu-text) !important;
font-size: 12px !important;
font-weight: 650 !important;
}
#${translationMenuId} .fluent-read-video-model-prompt-head .fluent-read-video-menu-step { background: transparent !important; color: var(--fr-video-menu-muted) !important; }
#${translationMenuId} .fluent-read-video-model-prompt-description {
margin: 0 !important;
padding: 0 2px !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10.5px !important;
line-height: 1.45 !important;
}
#${translationMenuId} .fluent-read-video-model-options { display: grid !important; gap: 4px !important; }
#${translationMenuId} .fluent-read-video-model-option {
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
#${translationMenuId} .fluent-read-video-model-option:hover { background: rgba(255, 255, 255, .09) !important; }
#${translationMenuId} .fluent-read-video-model-option[aria-checked="true"] {
background: rgba(239, 71, 118, .12) !important;
box-shadow: inset 0 0 0 1px rgba(239, 71, 118, .55) !important;
}
#${translationMenuId} .fluent-read-video-model-option-radio {
grid-row: 1 / 3 !important;
width: 12px !important;
height: 12px !important;
border-radius: 50% !important;
box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .42) !important;
}
#${translationMenuId} .fluent-read-video-model-option[aria-checked="true"] .fluent-read-video-model-option-radio {
background: var(--fr-video-menu-brand) !important;
box-shadow: inset 0 0 0 3px rgba(40, 24, 32, 1), 0 0 0 1.5px var(--fr-video-menu-brand) !important;
}
#${translationMenuId} .fluent-read-video-model-option-name {
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
#${translationMenuId} .fluent-read-video-model-option-badge {
padding: 1px 5px !important;
border-radius: 999px !important;
background: var(--fr-video-menu-brand-soft) !important;
color: var(--fr-video-menu-brand-text) !important;
font-size: 9.5px !important;
font-weight: 600 !important;
line-height: 1.3 !important;
}
#${translationMenuId} .fluent-read-video-model-option-size {
justify-self: end !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10.5px !important;
font-variant-numeric: tabular-nums !important;
white-space: nowrap !important;
}
#${translationMenuId} .fluent-read-video-model-option-size.is-downloaded { color: #8fdcbf !important; }
#${translationMenuId} .fluent-read-video-model-option-hint {
grid-column: 2 / -1 !important;
color: var(--fr-video-menu-muted) !important;
font-size: 10.5px !important;
line-height: 1.3 !important;
}
#${translationMenuId} .fluent-read-video-model-prompt-actions {
display: flex !important;
justify-content: flex-end !important;
gap: 6px !important;
}
#${translationMenuId} .fluent-read-video-model-prompt-actions button {
min-height: 28px !important;
padding: 0 12px !important;
border-radius: 7px !important;
font-size: 11.5px !important;
}
#${translationMenuId} .fluent-read-video-model-prompt-cancel { background: var(--fr-video-menu-control) !important; color: var(--fr-video-menu-muted) !important; }
#${translationMenuId} .fluent-read-video-model-prompt-cancel:hover { background: var(--fr-video-menu-control-hover) !important; color: var(--fr-video-menu-text) !important; }
#${translationMenuId} .fluent-read-video-model-prompt-confirm { background: var(--fr-video-menu-brand) !important; color: #fff !important; font-weight: 600 !important; }
#${translationMenuId} .fluent-read-video-model-prompt-confirm:hover { background: #dc315f !important; }
#${translationMenuId} .fluent-read-video-native-fullscreen-hint {
margin: 4px 0 0 !important;
color: var(--fr-video-menu-muted) !important;
font-size: 11px !important;
line-height: 1.45 !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
}
@media (pointer: coarse) {
#${translationButtonId} { min-width: 44px !important; min-height: 44px !important; }
#${translationMenuId} { scroll-padding-top: calc(44px + 6px) !important; }
#${translationMenuId}#${translationMenuId} button,
#${translationMenuId}#${translationMenuId} .fluent-read-video-menu-format-select {
min-width: 44px !important;
min-height: 44px !important;
touch-action: manipulation !important;
}
#${translationMenuId}[data-layout] .fluent-read-video-menu-step { width: 44px !important; height: 44px !important; }
#${translationMenuId}[data-layout] .fluent-read-video-menu-timing {
flex: 1 0 100% !important;
flex-wrap: wrap !important;
}
#${translationMenuId}[data-layout] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label {
contain: none !important;
overflow: visible !important;
text-overflow: clip !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
}
}
#${translationMenuId}[data-presentation="viewport"] {
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
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-main {
display: flex !important;
flex-direction: column !important;
min-height: 0 !important;
gap: 6px !important;
overflow: hidden !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-title {
position: static !important;
flex: 0 0 auto !important;
min-height: 44px !important;
gap: 4px !important;
padding: 0 !important;
margin-bottom: 6px !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-body {
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
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-brand { font-size: 13px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-settings {
flex: 1 1 0 !important;
min-width: 0 !important;
justify-content: flex-end !important;
padding: 0 4px !important;
font-size: 12px !important;
overflow: hidden !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-close,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-back {
flex: 0 0 44px !important;
width: 44px !important;
height: 44px !important;
}
#${translationMenuId}#${translationMenuId}[data-presentation="viewport"] button,
#${translationMenuId}#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-format-select {
min-width: 44px !important;
min-height: 44px !important;
flex-shrink: 0 !important;
touch-action: manipulation !important;
}
#${translationMenuId}[data-presentation="viewport"][data-viewport-state="close-only"] {
bottom: 0 !important;
max-height: 100% !important;
padding: 0 !important;
border: 0 !important;
border-radius: 0 !important;
}
#${translationMenuId}[data-presentation="viewport"][data-viewport-state="close-only"] .fluent-read-video-menu-title {
flex: 0 0 44px !important;
height: 44px !important;
justify-content: flex-end !important;
margin-bottom: 0 !important;
}
#${translationMenuId}[data-presentation="viewport"][data-viewport-state="close-only"] > :not(.fluent-read-video-menu-title),
#${translationMenuId}[data-presentation="viewport"][data-viewport-state="close-only"] > .fluent-read-video-menu-title > :not(.fluent-read-video-menu-close) {
display: none !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-section,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-watch,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-tools {
display: grid !important;
flex: 0 0 auto !important;
grid-template-columns: minmax(0, 1fr) !important;
gap: 10px !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-mode-group {
display: grid !important;
grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
gap: 4px !important;
padding: 3px !important;
}
#${translationMenuId}[data-presentation="viewport"][data-layout="wide"] .fluent-read-video-menu-mode-group {
grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-mode {
padding: 6px 4px !important;
font-size: 14px !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
text-overflow: clip !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-timing {
display: flex !important;
flex-wrap: wrap !important;
gap: 4px 8px !important;
padding-left: 4px !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-timing .fluent-read-video-menu-row-label {
contain: none !important;
overflow: visible !important;
text-overflow: clip !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-step { width: 44px !important; height: 44px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-download-toggle { flex-basis: 44px !important; width: 44px !important; height: 44px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-reading-toggle { width: 44px !important; height: 44px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-timing-value { font-size: 14px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-downloads {
display: grid !important;
grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
gap: 6px !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-download {
flex-direction: row !important;
gap: 4px !important;
padding: 6px !important;
font-size: 12px !important;
white-space: normal !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-download .fluent-read-video-menu-label {
min-width: 0 !important;
white-space: normal !important;
overflow-wrap: anywhere !important;
text-overflow: clip !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-learning {
flex: 0 0 auto !important;
padding: 6px 8px !important;
background: transparent !important;
font-size: 13px !important;
font-weight: 500 !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-menu-learning-label { white-space: normal !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-native-fullscreen-hint { font-size: 12px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt {
grid-template-columns: minmax(0, 1fr) !important;
min-height: 0 !important;
overflow: auto !important;
overscroll-behavior: contain !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-head,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-description,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-options,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions {
grid-area: auto !important;
grid-column: auto !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-title,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-option-name { font-size: 14px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-description,
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-option-hint { font-size: 12px !important; }
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions {
flex-wrap: wrap !important;
gap: 6px !important;
}
#${translationMenuId}[data-presentation="viewport"] .fluent-read-video-model-prompt-actions button {
padding: 6px 10px !important;
white-space: normal !important;
font-size: 13px !important;
}
#${translationMenuId}[data-view="model-prompt"] .fluent-read-video-menu-back,
#${translationMenuId}[data-view="export-prompt"] .fluent-read-video-menu-back { display: none !important; }
@keyframes fluent-read-video-download-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
#${translationMenuId} .fluent-read-video-menu-download[aria-busy="true"]::before,
#${translationMenuId} .fluent-read-video-menu-ai .fluent-read-video-menu-progress { animation: none !important; transition: none !important; }
}
@media (forced-colors: active) {
#${translationMenuId} .fluent-read-video-menu-mode[aria-checked="true"],
#${translationMenuId} .fluent-read-video-model-option[aria-checked="true"],
#${translationMenuId} .fluent-read-video-menu-reading-toggle[aria-checked="true"],
#${translationMenuId} .fluent-read-video-menu-download-toggle[aria-expanded="true"] {
border: 2px solid Highlight !important;
}
#${translationMenuId} .fluent-read-video-model-option-radio {
border: 1.5px solid CanvasText !important;
}
#${translationMenuId} .fluent-read-video-model-option[aria-checked="true"] .fluent-read-video-model-option-radio {
border: 4px solid Highlight !important;
}
}
#ytp-caption-window-container.${displayTranslationOnlyClass} .ytp-caption-segment,
#ytp-caption-window-container.${displayTranslationOnlyClass} .captions-text,
.ytp-caption-window-container.${displayTranslationOnlyClass} .ytp-caption-segment,
.ytp-caption-window-container.${displayTranslationOnlyClass} .captions-text {
visibility: hidden !important;
}
#ytp-caption-window-container.${displayOriginalOnlyClass} #${translationOverlayId},
.ytp-caption-window-container.${displayOriginalOnlyClass} #${translationOverlayId},
#ytp-caption-window-container.${displayHiddenClass},
.ytp-caption-window-container.${displayHiddenClass} {
visibility: hidden !important;
}`;
}
