/**
 * @file tests/videoSubtitleViewport.test.ts
 * 文件职责：验证 X/YouTube 视频字幕按实际画面矩形定位时的 object-fit、object-position、控件安全区和 layer 坐标换算。
 * 主要内容：覆盖竖屏 contain、横屏留白、cover/none/scale-down、缩放 layer、同视频兄弟控件显隐与隔离、普通避让字幕点击穿透、临时宿主恢复和极长句滚动。
 * 模块边界：只测试视频字幕 UI 的几何契约，不启动播放器绑定、识别、翻译或浏览器运行时。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

vi.mock('@/src/services/config/store', () => ({
  config: {
    uiLanguage: 'zh-CN',
    videoSubtitleAppearance: undefined,
    videoSubtitleDisplayMode: 'bilingual',
    videoSubtitleVisible: true,
  },
}));

import {config} from '@/src/services/config/store';
import {DEFAULT_VIDEO_SUBTITLE_APPEARANCE} from '@/src/core/config/videoSubtitleAppearance';
import {getYoutubeSubtitleControlsScope} from '@/src/features/video-subtitle/content/youtubeControlsScope';
import {
  applyVideoDisplayState,
  getOrCreateTranslationOverlay,
  getOrCreateNormalizedCaptionOverlay,
  getOrCreateVideoSubtitleLayer,
  clearRenderedVideoTranslation,
  deactivateNormalizedVideoCaption,
  getXVideoSubtitleViewport,
  installVideoSubtitleStyle,
  markVideoUi,
  removeTranslationOverlay,
  syncTranslationOverlayPosition,
  VIDEO_PLAYER_HOST_CLASS,
  VIDEO_SUBTITLE_PANEL_ID,
  VIDEO_TRANSLATION_LAYER_ID,
  VIDEO_TRANSLATION_OVERLAY_ID,
} from '@/src/features/video-subtitle/content/ui';
import {findOwnedSubtitlePanel, getVisibleYoutubeSubtitleControls, VIDEO_SUBTITLE_SCROLL_HOST_ID} from '@/src/features/video-subtitle/content/subtitleControlLayout';
import {createVideoPlayerMenu} from '@/src/features/video-subtitle/content/playerMenu';
import {createVideoSentenceLearningHost} from '@/src/features/video-subtitle/content/sentenceLearningHost';

type Rect = {left: number; top: number; width: number; height: number; right: number; bottom: number};

function rect(left: number, top: number, width: number, height: number): Rect {
  return {left, top, width, height, right: left + width, bottom: top + height};
}

function fixture(options: {
  player?: Rect;
  layer?: Rect;
  video?: Rect;
  intrinsic?: [number, number];
  offset?: [number, number];
  objectFit?: string;
  objectPosition?: string;
  clientSize?: [number, number];
} = {}) {
  config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE};
  config.videoSubtitleDisplayMode = 'bilingual';
  config.videoSubtitleVisible = true;
  const parsed = parseHTML('<!doctype html><html><head></head><body><div class="player"><video></video></div></body></html>');
  const {document, window} = parsed;
  const player = document.querySelector<HTMLElement>('.player')!;
  const video = player.querySelector<HTMLVideoElement>('video')!;
  const layer = document.createElement('div');
  layer.id = VIDEO_TRANSLATION_LAYER_ID;
  player.appendChild(layer);
  const playerRect = options.player || rect(100, 100, 1000, 600);
  const layerRect = options.layer || playerRect;
  const videoRect = options.video || playerRect;
  const [videoWidth, videoHeight] = options.intrinsic || [1920, 1080];
  const [offsetWidth, offsetHeight] = options.offset || [videoRect.width, videoRect.height];
  Object.defineProperties(video, {
    videoWidth: {configurable: true, value: videoWidth},
    videoHeight: {configurable: true, value: videoHeight},
    offsetWidth: {configurable: true, value: offsetWidth},
    offsetHeight: {configurable: true, value: offsetHeight},
    getBoundingClientRect: {configurable: true, value: () => videoRect},
  });
  Object.defineProperty(player, 'getBoundingClientRect', {configurable: true, value: () => playerRect});
  Object.defineProperty(layer, 'getBoundingClientRect', {configurable: true, value: () => layerRect});
  const [clientWidth, clientHeight] = options.clientSize || [layerRect.width, layerRect.height];
  Object.defineProperty(layer, 'clientWidth', {configurable: true, value: clientWidth});
  Object.defineProperty(layer, 'clientHeight', {configurable: true, value: clientHeight});
  vi.stubGlobal('document', document);
  Object.defineProperty(window, 'location', {configurable: true, value: new URL('https://x.com/status/1')});
  vi.stubGlobal('window', window);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLVideoElement', window.HTMLVideoElement);
  vi.stubGlobal('HTMLStyleElement', window.HTMLStyleElement);
  vi.stubGlobal('getComputedStyle', (element: Element) => ({
    display: (element as HTMLElement).style.display || 'block',
    visibility: (element as HTMLElement).style.visibility || 'visible',
    opacity: (element as HTMLElement).style.opacity || '1',
    position: 'relative',
    objectFit: element === video ? options.objectFit || 'contain' : '',
    objectPosition: element === video ? options.objectPosition || '50% 50%' : '',
  }));
  player.classList.add(VIDEO_PLAYER_HOST_CLASS);
  return {document, window, player, video, layer};
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

function mobileControlFixture(resetScrollBoxOnReparent = false) {
  const f = fixture({player: rect(0, 48, 402, 226), intrinsic: [400, 300]});
  Object.defineProperty(f.window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=controls')});
  f.player.id = 'movie_player'; f.player.classList.add('html5-video-player', 'ytp-mweb-player');
  const scope = f.document.createElement('div'); scope.id = 'player-container-id'; scope.className = 'player-container';
  f.player.before(scope); scope.appendChild(f.player);
  const controls = f.document.createElement('div'); controls.id = 'player-control-overlay';
  controls.style.pointerEvents = 'auto'; controls.style.position = 'absolute'; controls.style.zIndex = '6';
  scope.appendChild(controls);
  const obstacles = [
    ['player-controls-top', rect(234, 48, 144, 48)], ['player-controls-middle-core-buttons', rect(91, 133, 220, 56)],
    ['player-controls-bottom', rect(12, 200, 312, 44)], ['ytPlayerProgressBarDragContainer', rect(30, 230, 342, 44)],
  ] as const;
  for (const [className, bounds] of obstacles) {
    const node = f.document.createElement('div'); node.className = className; controls.appendChild(node);
    Object.defineProperty(node, 'getBoundingClientRect', {value: () => bounds});
  }
  // 浏览器布局端口：同一原字号短句为153×60；真实长句在窄区换成三行，压紧内距后72高；极长句高600。
  let cue: 'short' | 'long' | 'huge' = 'short';
  const overlay = getOrCreateTranslationOverlay(f.player), original = getOrCreateNormalizedCaptionOverlay(f.player);
  const panel = overlay.parentElement!;
  let scrollPosition = 0;
  f.layer.classList.add('fluent-read-video-normalized-caption-active');
  const dimensions = () => {
    const maximum = Number.parseFloat(panel.style.getPropertyValue('max-width').match(/[\d.]+/)?.[0] || '') || 277;
    const width = Math.min(maximum, cue === 'short' ? 153 : 241);
    const compact = panel.style.getPropertyValue('--fluent-read-video-subtitle-gap') === '2px';
    const full = cue === 'huge' ? 600 : cue === 'short' || width >= 241 ? 60 : compact ? 72 : 81;
    const maximumHeight = Number.parseFloat(panel.style.getPropertyValue('max-height').match(/[\d.]+/)?.[0] || '');
    return {width, full, height: Number.isFinite(maximumHeight) ? Math.min(full, maximumHeight) : full};
  };
  Object.defineProperties(panel, {
    getBoundingClientRect: {value: () => {const d = dimensions(), top = Number.parseFloat(panel.style.top);
      // 模拟真实浏览器在临时移除max-height时夹回scrollTop；布局完成后应恢复同句滚动位置。
      scrollPosition = Math.min(scrollPosition, Math.max(0, d.full - d.height));
      return rect(Number.parseFloat(panel.style.left.match(/[\d.]+/)?.[0] || '') || 0, 48 + (Number.isFinite(top) ? top : 226 - Number.parseFloat(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom').match(/[\d.]+/)?.[0] || '') - d.height), d.width, d.height);}},
    scrollHeight: {get: () => dimensions().full}, clientHeight: {get: () => dimensions().height},
    scrollTop: {get: () => scrollPosition, set: (value: number) => {const d = dimensions(); scrollPosition = Math.max(0, Math.min(value, d.full - d.height));}},
  });
  const nativeBounds = f.window.HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(f.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.id === VIDEO_SUBTITLE_SCROLL_HOST_ID) return {...rect(20, 70, 402, 226), x: 20, y: 70, toJSON() {return {};}} as DOMRect;
    return nativeBounds.call(this);
  });
  const setCue = (next: typeof cue) => {
    cue = next; original.textContent = next === 'short' ? '(Audience) Good.' : next === 'long' ? 'Good morning. How are you?' : 'A very long caption '.repeat(40);
    overlay.textContent = next === 'short' ? '（观众）很好。' : next === 'long' ? '早上好。你好吗？' : '很长的字幕。'.repeat(40);
  };
  const container = f.document.createElement('div'); f.player.appendChild(container);
  const sync = () => syncTranslationOverlayPosition(container);
  if (resetScrollBoxOnReparent) {
    const append = f.window.HTMLElement.prototype.appendChild;
    // 浏览器边界：跨父节点重新建立滚动盒会丢弃原偏移，重挂前的scrollTop赋值不能保住位置。
    vi.spyOn(f.window.HTMLElement.prototype, 'appendChild').mockImplementation(function <T extends Node>(this: HTMLElement, node: T): T {
      const movedPanel = (node as Node) === panel && node.parentElement !== this;
      const result = append.call(this, node) as T;
      if (movedPanel) scrollPosition = 0;
      return result;
    });
  }
  setCue('short');
  return {...f, scope, controls, obstacles, panel, overlay, original, container, setCue, sync};
}

describe('mobile YouTube readable control avoidance', () => {
  it('菜单和学习面板关闭后在最终滚动盒恢复同句位置，跨父节点归零不能吞掉保存值', () => {
    const f = mobileControlFixture(true); f.setCue('huge'); f.sync();
    f.panel.scrollTop = 10000; expect(f.panel.scrollTop).toBe(f.panel.scrollHeight - f.panel.clientHeight);
    f.panel.scrollTop = 120; f.sync(); expect(f.panel.scrollTop).toBe(120);
    const menu = createVideoPlayerMenu('zh-CN', false); f.player.appendChild(menu); menu.hidden = false;
    f.sync(); f.sync(); expect(f.panel.parentElement).toBe(f.layer); expect(f.panel.hasAttribute('tabindex')).toBe(false);
    menu.hidden = true; f.sync();
    expect(f.panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID); expect(f.panel.scrollTop).toBe(120);
    f.sync(); expect(f.panel.scrollTop).toBe(120);
    const learning = createVideoSentenceLearningHost({markUi: markVideoUi, mount: () => () => {}});
    learning.open(f.player, {video: f.video, cues: [], platform: 'youtube', title: 'Learning', sourceLanguage: 'en', targetLanguage: 'zh-CN', translate: async value => value});
    f.sync(); expect(f.panel.parentElement).toBe(f.layer);
    learning.close(); f.sync(); expect(f.panel.scrollTop).toBe(120);
    f.original.textContent = 'Another long caption '.repeat(40); f.sync(); expect(f.panel.scrollTop).toBe(0);
  });

  it('控制区域跳过自有UI和零尺寸，去重父子组并限制可见障碍数', () => {
    const f = mobileControlFixture();
    const add = (className: string, bounds: Rect, owned = false) => {
      const node = f.document.createElement('div'); node.className = className + (owned ? ' fluent-read-video-ui' : '');
      Object.defineProperty(node, 'getBoundingClientRect', {value: () => bounds}); f.controls.appendChild(node);
    };
    add('player-controls-middle-core-buttons', rect(91, 133, 220, 56));
    add('player-controls-middle-core-buttons', rect(91, 133, 220, 56), true);
    add('player-controls-bottom', rect(1, 1, 0, 0));
    expect(getVisibleYoutubeSubtitleControls(f.player)).toHaveLength(4);
    add('player-controls-bottom', rect(91, 133, 221, 56));
    add('player-controls-bottom', rect(91, 133, 220, 57));
    for (let i = 0; i < 20; i++) add('player-controls-bottom', rect(i, 240, 10, 10));
    expect(getVisibleYoutubeSubtitleControls(f.player)).toHaveLength(16);
  });

  it('仅player全屏不避让未绘制的外部兄弟控件，scope全屏才将它们纳入空区与滚动宿主', () => {
    const f = mobileControlFixture();
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.player});
    f.sync(); expect(f.panel.dataset.fluentReadSubtitleLayout).toBeUndefined();
    expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toContain('12px');
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.scope});
    f.sync(); expect(f.panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID); expect(f.panel.hasAttribute('tabindex')).toBe(false);
    f.setCue('huge'); f.sync();
    expect(f.panel.dataset.fluentReadSubtitleLayout).toBe('scroll');
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)?.parentElement).toBe(f.scope);
  });
  it('短句和长句在顶部/中部/底部控件之间完整显示，暂停也保留原字号；隐藏后回到底部中心', () => {
    const f = mobileControlFixture(); Object.defineProperty(f.video, 'paused', {value: true});
    const listen = vi.spyOn(f.panel, 'addEventListener');
    for (const cue of ['short', 'long'] as const) {
      f.setCue(cue); f.sync();
      const panel = f.panel.getBoundingClientRect();
      expect(f.panel.dataset.fluentReadSubtitleLayout).toBe('free');
      expect(f.panel.hasAttribute('tabindex')).toBe(false); expect(f.panel.scrollHeight).toBeLessThanOrEqual(panel.height);
      expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-font-size')).toBe('16px');
      for (const [, obstacle] of f.obstacles) expect(panel.right <= obstacle.left || panel.left >= obstacle.right || panel.bottom <= obstacle.top || panel.top >= obstacle.bottom).toBe(true);
      expect(panel.left).toBeGreaterThanOrEqual(50); expect(panel.right).toBeLessThanOrEqual(351.5);
      const host = f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)!;
      expect(host.parentElement).toBe(f.scope); expect(f.panel.parentElement).toBe(host); expect(f.layer.parentElement).toBe(f.player);
      expect(host.style.getPropertyValue('clip-path')).toBe(f.layer.style.getPropertyValue('clip-path'));
      expect(f.panel.hasAttribute('data-fluent-read-subtitle-scrollable')).toBe(false); expect(f.panel.hasAttribute('role')).toBe(false);
    }
    expect(listen).not.toHaveBeenCalled();
    const reachedScope = vi.fn(); f.scope.addEventListener('click', reachedScope);
    const click = new f.window.Event('click', {bubbles: true, cancelable: true}); f.panel.dispatchEvent(click);
    expect(reachedScope).toHaveBeenCalledOnce(); expect(click.defaultPrevented).toBe(false);
    f.controls.hidden = true; f.sync();
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(f.panel.parentElement).toBe(f.layer);
    expect(f.panel.dataset.fluentReadSubtitleLayout).toBeUndefined(); expect(f.panel.style.top).toBe('auto');
    expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toBe('12px');
    expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-padding')).toBeUndefined();
    expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-gap')).toBeUndefined();
  });

  it('仅内部可见控件、隐藏或画面外的外部控件不会提升普通字幕，同矩形的外部可见控件仍被识别', () => {
    const f = mobileControlFixture(); f.player.appendChild(f.controls);
    const outside = f.document.createElement('div'); outside.className = 'player-controls-middle-core-buttons'; f.scope.appendChild(outside);
    let bounds = rect(91, 133, 220, 56);
    Object.defineProperty(outside, 'getBoundingClientRect', {value: () => bounds});
    outside.hidden = true; f.sync();
    expect(f.panel.dataset.fluentReadSubtitleLayout).toBe('free'); expect(f.panel.parentElement).toBe(f.layer);
    outside.hidden = false; bounds = rect(91, 500, 220, 56); f.sync(); expect(f.panel.parentElement).toBe(f.layer);
    // 内部重复与外部重复都保留几何去重；外部代表不能被内部先出现的同矩形吞掉。
    const inside = outside.cloneNode() as HTMLElement; f.controls.appendChild(inside);
    Object.defineProperty(inside, 'getBoundingClientRect', {value: () => rect(91, 133, 220, 56)});
    bounds = rect(91, 133, 220, 56); f.sync();
    expect(getVisibleYoutubeSubtitleControls(f.player)).toHaveLength(4);
    expect(f.panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID);
    outside.hidden = true; f.sync(); expect(f.panel.parentElement).toBe(f.layer); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
  });

  it('普通宿主复用唯一面板和显示模式，free与scroll切换、菜单、手动位置和Off沿用原清理', () => {
    const f = mobileControlFixture(); f.sync();
    const host = f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)!;
    for (const mode of ['translation-only', 'original-only', 'bilingual'] as const) {
      config.videoSubtitleDisplayMode = mode; applyVideoDisplayState(f.container);
      expect(host.classList.contains('fluent-read-video-display-translation-only')).toBe(mode === 'translation-only');
      expect(host.classList.contains('fluent-read-video-display-original-only')).toBe(mode === 'original-only');
    }
    f.setCue('huge'); f.sync(); expect(f.panel.getAttribute('tabindex')).toBe('0'); expect(f.panel.parentElement).toBe(host);
    f.setCue('long'); f.sync(); expect(f.panel.hasAttribute('tabindex')).toBe(false); expect(f.panel.parentElement).toBe(host);
    expect(f.panel.hasAttribute('data-fluent-read-subtitle-scrollable')).toBe(false);
    expect(getOrCreateTranslationOverlay(f.player)).toBe(f.overlay); expect(f.document.querySelectorAll('#' + VIDEO_SUBTITLE_PANEL_ID)).toHaveLength(1);
    // 此处消费真实菜单节点及布局接口；入口事件的公共runtime回归在独立测试文件中。
    const menu = createVideoPlayerMenu('zh-CN', false); f.player.appendChild(menu); menu.hidden = false; f.sync();
    expect(f.panel.parentElement).toBe(f.layer); expect(host.isConnected).toBe(false);
    menu.hidden = true; f.sync(); expect(f.panel.parentElement?.id).toBe(VIDEO_SUBTITLE_SCROLL_HOST_ID);
    config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE, position: 'top'}; f.sync();
    expect(f.panel.parentElement).toBe(f.layer); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
    config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE}; f.sync();
    const enabled = config.videoTranslationEnabled; config.videoTranslationEnabled = false; applyVideoDisplayState(f.container); config.videoTranslationEnabled = enabled;
    expect(f.panel.parentElement).toBe(f.layer); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
    removeTranslationOverlay(); expect(f.panel.isConnected).toBe(false);
  });

  it('极长句使用同scope遮罩之上的唯一自有host，保留模式、原字号及周期滚动位置', () => {
    const f = mobileControlFixture(); f.setCue('huge'); f.sync();
    const host = f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)!;
    expect(host.parentElement).toBe(f.scope); expect(host.previousElementSibling).toBe(f.controls);
    expect(f.layer.parentElement).toBe(f.player); expect(f.panel.parentElement).toBe(host);
    expect(host.style.transform).toBe('translate(-20px, -22px) scale(1, 1)');
    expect(host.style.getPropertyValue('clip-path')).toBe(f.layer.style.getPropertyValue('clip-path'));
    expect(f.panel.getAttribute('tabindex')).toBe('0'); expect(f.panel.getAttribute('role')).toBe('region');
    expect(f.panel.style.getPropertyValue('--fluent-read-video-subtitle-font-size')).toBe('16px');
    expect(getOrCreateTranslationOverlay(f.player)).toBe(f.overlay);
    expect(getOrCreateNormalizedCaptionOverlay(f.player)).toBe(f.original);
    expect(f.document.querySelectorAll(`#${VIDEO_SUBTITLE_PANEL_ID}`)).toHaveLength(1);
    f.panel.scrollTop = 120; f.sync(); expect(f.panel.scrollTop).toBe(120);
    f.overlay.textContent += '译文渐进更新'; f.sync(); expect(f.panel.scrollTop).toBe(120);
    f.original.textContent = 'A different long sentence '.repeat(40); f.sync(); expect(f.panel.scrollTop).toBe(0);
    for (const mode of ['translation-only', 'original-only', 'bilingual'] as const) {
      config.videoSubtitleDisplayMode = mode; applyVideoDisplayState(f.container);
      expect(host.classList.contains('fluent-read-video-display-translation-only')).toBe(mode === 'translation-only');
      expect(host.classList.contains('fluent-read-video-display-original-only')).toBe(mode === 'original-only');
    }
    deactivateNormalizedVideoCaption(f.document);
    expect(host.classList.contains('fluent-read-video-normalized-caption-active')).toBe(false);
    config.videoSubtitleVisible = false; applyVideoDisplayState(f.container);
    expect(f.panel.parentElement).toBe(f.layer); expect(host.isConnected).toBe(false);
    expect(f.panel.hasAttribute('tabindex')).toBe(false);
  });

  it('临时host随同视频scope重绑，layer被替换时采用原panel且不造同ID副本', () => {
    const f = mobileControlFixture();
    const foreignLayer = f.document.createElement('div');
    expect(findOwnedSubtitlePanel(foreignLayer, VIDEO_SUBTITLE_PANEL_ID)).toBeNull(); expect(f.panel.parentElement).toBe(f.layer);
    f.setCue('huge'); f.sync();
    const oldHost = f.panel.parentElement!;
    f.scope.id = 'old-container';
    const next = f.document.createElement('div'); next.id = 'player-container-id'; next.className = 'player-container';
    f.scope.after(next); next.append(f.player, f.controls); f.sync();
    expect(oldHost.isConnected).toBe(false); expect(f.panel.parentElement?.parentElement).toBe(next);
    f.layer.remove(); getOrCreateTranslationOverlay(f.player);
    expect(f.document.querySelectorAll(`#${VIDEO_SUBTITLE_PANEL_ID}`)).toHaveLength(1);
    expect(f.document.getElementById(VIDEO_SUBTITLE_PANEL_ID)).toBe(f.panel);
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
  });

  it('控件占满画面而没有可读空区时撤回已有滚动host，不留下空卡片或临时交互', () => {
    const f = mobileControlFixture(); f.setCue('huge'); f.sync();
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).not.toBeNull();
    const covering = f.document.createElement('div'); covering.className = 'player-controls-top'; f.controls.appendChild(covering);
    Object.defineProperty(covering, 'getBoundingClientRect', {value: () => rect(0, 48, 402, 226)});
    f.sync();
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(f.panel.parentElement).toBe(f.layer);
    expect(f.panel.hasAttribute('tabindex')).toBe(false); expect(f.panel.dataset.fluentReadSubtitleLayout).toBeUndefined();
    expect(f.original.textContent).toContain('A very long caption');
  });

  it('全屏只含player时在原layer滚动；不可测宿主不残留，自有显示状态清空也能释放交互', () => {
    const f = mobileControlFixture(); f.player.appendChild(f.controls); f.setCue('huge');
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: f.player}); f.sync();
    expect(f.panel.parentElement).toBe(f.layer); expect(f.panel.getAttribute('tabindex')).toBe('0');
    Object.defineProperty(f.document, 'fullscreenElement', {configurable: true, value: null}); f.scope.appendChild(f.controls);
    Object.defineProperty(f.layer, 'clientWidth', {configurable: true, value: 0}); Object.defineProperty(f.layer, 'clientHeight', {configurable: true, value: 0}); f.sync();
    expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).not.toBeNull();
    vi.mocked(f.window.HTMLElement.prototype.getBoundingClientRect).mockReturnValue({...rect(0, 0, 0, 0), x: 0, y: 0, toJSON() {return {};}} as DOMRect);
    f.sync(); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull(); expect(f.panel.parentElement).toBe(f.layer);
    clearRenderedVideoTranslation(f.document); f.original.textContent = ''; config.videoSubtitleVisible = false; applyVideoDisplayState(f.container);
    expect(f.panel.hasAttribute('tabindex')).toBe(false);
  });

  it('退出滚动host只保留卡片原有焦点，不自动聚焦；按压中的Space尾事件仍由该卡片消费', () => {
    const f = mobileControlFixture(); f.setCue('huge'); f.sync();
    let active: Element = f.document.body;
    Object.defineProperty(f.document, 'activeElement', {configurable: true, get: () => active});
    const focus = vi.spyOn(f.panel, 'focus').mockImplementation(() => {active = f.panel;});
    const append = f.layer.appendChild.bind(f.layer);
    Object.defineProperty(f.layer, 'appendChild', {value: (node: Node) => {if (node === f.panel && active === f.panel) active = f.document.body; return append(node);}});
    f.controls.hidden = true; f.sync(); expect(focus).not.toHaveBeenCalled();
    f.controls.hidden = false; f.sync(); f.panel.focus();
    const space = new f.window.Event('keydown', {bubbles: true, cancelable: true}); Object.defineProperty(space, 'key', {value: ' '}); f.panel.dispatchEvent(space);
    f.controls.hidden = true; f.sync();
    expect(f.document.activeElement).toBe(f.panel); expect(f.panel.hasAttribute('tabindex')).toBe(false);
    const play = vi.fn(); f.scope.addEventListener('keyup', play);
    const up = new f.window.Event('keyup', {bubbles: true}); Object.defineProperty(up, 'key', {value: ' '}); f.document.activeElement!.dispatchEvent(up);
    expect(play).not.toHaveBeenCalled();
  });

  it('滚动键实际改变卡片位置，Tab/触摸保留原生默认动作，尾随事件不会冒泡启动宿主', () => {
    const f = mobileControlFixture(); f.setCue('huge'); f.sync();
    const hostPlay = vi.fn(); f.scope.addEventListener('click', hostPlay); f.scope.addEventListener('keydown', hostPlay); f.scope.addEventListener('keyup', hostPlay);
    const key = (type: string, value: string, shiftKey = false) => {const event = new f.window.Event(type, {bubbles: true, cancelable: true}); Object.defineProperties(event, {key: {value}, shiftKey: {value: shiftKey}}); f.panel.dispatchEvent(event); return event;};
    expect(key('keydown', 'ArrowDown').defaultPrevented).toBe(true); expect(f.panel.scrollTop).toBe(40);
    key('keyup', 'ArrowDown'); key('keydown', 'End'); expect(f.panel.scrollTop).toBe(f.panel.scrollHeight - f.panel.clientHeight);
    key('keydown', 'Home'); expect(f.panel.scrollTop).toBe(0); key('keydown', ' '); expect(f.panel.scrollTop).toBeGreaterThan(0);
    key('keydown', 'ArrowUp'); key('keydown', 'PageDown'); key('keydown', 'PageUp'); key('keydown', ' ', true);
    expect(key('keydown', 'Enter').defaultPrevented).toBe(true);
    expect(key('keydown', 'Tab').defaultPrevented).toBe(false); expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
    key('keydown', 'k'); key('keyup', 'k'); expect(hostPlay).not.toHaveBeenCalled();
    const touch = new f.window.Event('touchstart', {bubbles: true, cancelable: true}); f.panel.dispatchEvent(touch); expect(touch.defaultPrevented).toBe(false);
    f.controls.hidden = true; f.sync();
    const end = new f.window.Event('touchend', {bubbles: true, cancelable: true}); f.panel.dispatchEvent(end); expect(end.defaultPrevented).toBe(false);
    f.panel.dispatchEvent(new f.window.Event('click', {bubbles: true})); key('keyup', ' '); expect(hostPlay).not.toHaveBeenCalled();
    expect(f.panel.hasAttribute('tabindex')).toBe(false); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
    key('keydown', 'z'); expect(hostPlay).toHaveBeenCalledOnce();
    const outsideWheel = vi.fn(); f.scope.addEventListener('wheel', outsideWheel); f.panel.dispatchEvent(new f.window.Event('wheel', {bubbles: true})); expect(outsideWheel).toHaveBeenCalledOnce();
    f.controls.hidden = false; f.sync(); config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE, position: 'top'}; f.sync();
    expect(f.panel.hasAttribute('tabindex')).toBe(false); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
    config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE}; f.sync(); clearRenderedVideoTranslation(f.document);
    expect(f.panel.hasAttribute('tabindex')).toBe(false);
    f.setCue('huge'); f.sync(); const other = f.document.createElement('div'); f.document.body.appendChild(other); getOrCreateVideoSubtitleLayer(other);
    expect(f.panel.parentElement).toBe(f.layer); expect(f.panel.hasAttribute('tabindex')).toBe(false);
    removeTranslationOverlay(); expect(f.document.getElementById(VIDEO_SUBTITLE_SCROLL_HOST_ID)).toBeNull();
  });
});

describe('X video subtitle viewport', () => {
  it('finds the centered painted portrait area for contain', () => {
    const {player, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({
      left: 331.25,
      top: 0,
      width: 337.5,
      height: 600,
      right: 331.25,
      bottom: 0,
    });
  });

  it('honors non-centered video geometry and object-position percentages', () => {
    const {player, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain', objectPosition: '0% 100%'});
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({left: 0, top: 0, width: 337.5, height: 600, right: 662.5, bottom: 0});
  });

  it('handles horizontal contain letterboxing and pixel object-position', () => {
    const {player, layer} = fixture({intrinsic: [1920, 1080], objectFit: 'contain', objectPosition: '50px 25px'});
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({left: 50, top: 25, width: 950, height: 562.5, right: 0, bottom: 12.5});
  });

  it.each([
    ['fill', [0, 0, 1000, 600]],
    ['cover', [0, 0, 1000, 600]],
    ['none', [0, 0, 1000, 600]],
    ['scale-down', [331.25, 0, 337.5, 600]],
  ] as const)('supports object-fit %s', (objectFit, expected) => {
    const {player, layer} = fixture({intrinsic: [1080, 1920], objectFit});
    const viewport = getXVideoSubtitleViewport(player, layer)!;
    expect([viewport.left, viewport.top, viewport.width, viewport.height]).toEqual(expected);
  });

  it('converts viewport geometry into a scaled layer that is not the player', () => {
    const {player, layer} = fixture({
      player: rect(100, 100, 1000, 600),
      layer: rect(200, 150, 500, 300),
      video: rect(100, 100, 1000, 600),
      intrinsic: [1920, 1080],
      objectFit: 'contain',
    });
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({left: 0, top: 0, width: 500, height: 300, right: 0, bottom: 0});
  });

  it('uses the layer client coordinate scale instead of assuming its rect is unscaled', () => {
    const {player, layer} = fixture({
      player: rect(100, 100, 1000, 600),
      layer: rect(200, 150, 500, 300),
      clientSize: [400, 240],
      video: rect(100, 100, 1000, 600),
      intrinsic: [1920, 1080],
      objectFit: 'contain',
    });
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({left: 0, top: 0, width: 400, height: 240, right: 0, bottom: 0});
  });

  it('keeps a layer larger than the player anchored to the absolute video intersection', () => {
    const {player, layer} = fixture({
      player: rect(300, 200, 400, 300),
      layer: rect(200, 100, 800, 600),
      video: rect(300, 200, 400, 300),
      intrinsic: [1920, 1080],
      objectFit: 'contain',
    });
    expect(getXVideoSubtitleViewport(player, layer)).toMatchObject({left: 100, top: 137.5, width: 400, height: 225, right: 300, bottom: 237.5});
  });

  it('returns null for missing metadata, zero geometry, or no painted intersection', () => {
    const missing = fixture({intrinsic: [0, 0]});
    expect(getXVideoSubtitleViewport(missing.player, missing.layer)).toMatchObject({left: 0, top: 0, width: 1000, height: 600});
    const zero = fixture({video: rect(0, 0, 0, 0)});
    expect(getXVideoSubtitleViewport(zero.player, zero.layer)).toBeNull();
    const outside = fixture({layer: rect(2000, 2000, 100, 100)});
    expect(getXVideoSubtitleViewport(outside.player, outside.layer)?.width).toBe(0);
  });

  it('keeps a very narrow viewport usable instead of imposing a 160px minimum', () => {
    const {player, layer} = fixture({player: rect(0, 0, 120, 600), layer: rect(0, 0, 120, 600), video: rect(0, 0, 120, 600), intrinsic: [1080, 1920]});
    const viewport = getXVideoSubtitleViewport(player, layer)!;
    expect(viewport.width).toBe(120);
  });

  it('syncs X panel limits and position to the actual viewport', () => {
    const {document, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
    const panel = document.createElement('div');
    panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div');
    overlay.id = VIDEO_TRANSLATION_OVERLAY_ID;
    overlay.textContent = 'translated';
    panel.appendChild(overlay);
    layer.appendChild(panel);
    installVideoSubtitleStyle();
    const caption = document.createElement('div');
    document.body.appendChild(caption);
    syncTranslationOverlayPosition(caption);
    expect(panel.style.maxWidth).toBe('313.5px');
    expect(panel.style.left).toBe('500px');
    expect(panel.style.bottom).toBe('var(--fluent-read-video-subtitle-bottom)');
    expect(layer.style.clipPath).toContain('inset(0px 331.25px 0px 331.25px)');
  });

  it('does not reserve a bottom inset for a visible controls row outside the video horizontally', () => {
    const {document, player, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
    const controls = document.createElement('div');
    controls.innerHTML = '<button aria-label="Settings"></button><button>Play</button>';
    Object.defineProperty(controls, 'getBoundingClientRect', {configurable: true, value: () => rect(900, 628, 180, 44)});
    player.appendChild(controls);
    expect(getXVideoSubtitleViewport(player, layer)?.controlsInset).toBe(12);
  });

  it('uses the real painted viewport for controls inside player but outside a portrait video', () => {
    const {document, player, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
    const controls = document.createElement('div');
    controls.innerHTML = '<button aria-label="Settings"></button><button>Play</button>';
    Object.defineProperty(controls, 'getBoundingClientRect', {configurable: true, value: () => rect(900, 628, 180, 44)});
    player.appendChild(controls);
    const viewport = getXVideoSubtitleViewport(player, layer)!;
    expect(viewport.controlsInset).toBe(12);
  });

  it('anchors top, center, and bottom modes to the computed viewport', () => {
    const modes = [
      ['top', '12px', 'auto', 'none'],
      ['center', '300px', 'auto', 'translateY(-50%)'],
      ['bottom', 'auto', 'var(--fluent-read-video-subtitle-bottom)', 'none'],
    ] as const;
    for (const [position, top, bottom, transform] of modes) {
      const {document, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
      config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE, position, autoBottom: false, bottomOffset: 0};
      const panel = document.createElement('div');
      panel.id = VIDEO_SUBTITLE_PANEL_ID;
      const overlay = document.createElement('div');
      overlay.id = VIDEO_TRANSLATION_OVERLAY_ID;
      overlay.textContent = 'translated';
      panel.appendChild(overlay);
      layer.appendChild(panel);
      const caption = document.createElement('div');
      document.body.appendChild(caption);
      syncTranslationOverlayPosition(caption);
      expect(panel.style.top).toBe(top);
      expect(panel.style.bottom).toBe(bottom);
      expect(panel.style.transform).toBe(transform);
      panel.remove();
      caption.remove();
    }
  });

  it('hides the layer and removes owned overlays cleanly', () => {
    const {document, layer} = fixture();
    const panel = document.createElement('div');
    panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div');
    overlay.id = VIDEO_TRANSLATION_OVERLAY_ID;
    panel.appendChild(overlay);
    layer.appendChild(panel);
    const caption = document.createElement('div');
    config.videoSubtitleVisible = false;
    applyVideoDisplayState(caption);
    expect(layer.classList.contains('fluent-read-video-display-hidden')).toBe(true);
    removeTranslationOverlay();
    expect(document.getElementById(VIDEO_TRANSLATION_LAYER_ID)).toBeNull();
    expect(document.getElementById(VIDEO_TRANSLATION_OVERLAY_ID)).toBeNull();
  });
  it('anchors compact YouTube bilingual captions 12px above the painted video instead of reserving desktop 52px', () => {
    const {document, window, layer} = fixture({player: rect(0, 0, 390, 300), intrinsic: [1920, 1080]});
    Object.defineProperty(window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=mobile')});
    const panel = document.createElement('div'); panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div'); overlay.id = VIDEO_TRANSLATION_OVERLAY_ID; overlay.textContent = '双语字幕';
    panel.appendChild(overlay); layer.appendChild(panel);
    const container = document.createElement('div'); document.body.appendChild(container);
    syncTranslationOverlayPosition(container);
    // 390×300 容器中 16:9 画面高度 219.375，底部留白 40.3125；仅保留 12px 画内安全距。
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toBe('52.3125px');
    expect(panel.style.top).toBe('auto');
    expect(panel.style.maxWidth).toBe('366px');
  });

  it('moves compact YouTube captions above visible controls and back down when controls hide', () => {
    const {document, window, player, layer} = fixture({player: rect(0, 0, 390, 219.375), intrinsic: [1920, 1080]});
    Object.defineProperty(window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=mobile')});
    const panel = document.createElement('div'); panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div'); overlay.id = VIDEO_TRANSLATION_OVERLAY_ID; overlay.textContent = '双语字幕';
    panel.appendChild(overlay); layer.appendChild(panel);
    const controls = document.createElement('div'); controls.className = 'ytp-right-controls';
    Object.defineProperty(controls, 'getBoundingClientRect', {value: () => rect(250, 179.375, 120, 32)});
    player.appendChild(controls);
    const container = document.createElement('div'); document.body.appendChild(container);
    syncTranslationOverlayPosition(container);
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toBe('48px');
    controls.style.opacity = '0'; syncTranslationOverlayPosition(container);
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toBe('12px');
  });

  it('avoids mobile YouTube sibling bottom controls inside the verified single-video container', () => {
    // 真实 iOS Safari DOM 的所有权与几何：402×226 播放器、居中 4:3 画面、播放器外的左右底控。
    const {document, window, player, video, layer} = fixture({player: rect(0, 48, 402, 226), intrinsic: [400, 300]});
    Object.defineProperty(window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=mobile')});
    player.id = 'movie_player'; player.classList.add('html5-video-player', 'ytp-mweb-player');
    const scope = document.createElement('div'); scope.id = 'player-container-id'; scope.className = 'player-container sticky-player';
    player.before(scope); scope.appendChild(player);
    const root = document.createElement('ytm-custom-control');
    root.innerHTML = '<ytm-watch-player-controls><div id="player-control-overlay"><div class="player-controls-content"><div class="player-controls-bottom player-controls-bottom-left"></div><div class="player-controls-bottom player-controls-bottom-right"></div></div></div></ytm-watch-player-controls>';
    scope.appendChild(root);
    const controls = root.querySelectorAll<HTMLElement>('.player-controls-bottom');
    Object.defineProperty(controls[0], 'getBoundingClientRect', {value: () => rect(12, 200, 312, 44)});
    Object.defineProperty(controls[1], 'getBoundingClientRect', {value: () => rect(324, 200, 66, 44)});
    const panel = document.createElement('div'); panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div'); overlay.id = VIDEO_TRANSLATION_OVERLAY_ID; overlay.textContent = '双语字幕';
    panel.appendChild(overlay); layer.appendChild(panel);
    const container = document.createElement('div'); player.appendChild(container);
    const bottom = () => {syncTranslationOverlayPosition(container); return panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom');};
    expect(player.contains(controls[0])).toBe(false);
    expect(getYoutubeSubtitleControlsScope(player, null)).toBe(player);
    expect(getYoutubeSubtitleControlsScope(player, video)).toBe(scope);
    expect(bottom()).toBe('82px');
    for (const property of ['visibility', 'display', 'opacity'] as const) {
      root.style[property] = property === 'visibility' ? 'hidden' : property === 'display' ? 'none' : '0';
      expect(bottom()).toBe('12px');
      root.style.removeProperty(property);
      expect(bottom()).toBe('82px');
    }
    root.hidden = true; expect(bottom()).toBe('12px'); root.hidden = false;
    const outside = document.createElement('video'); document.body.appendChild(outside);
    expect(getYoutubeSubtitleControlsScope(player, outside)).toBe(player);
    expect(bottom()).toBe('82px');
    scope.appendChild(outside); expect(bottom()).toBe('12px');
    outside.remove(); expect(bottom()).toBe('82px');
    scope.classList.remove('player-container'); expect(bottom()).toBe('12px');
    scope.classList.add('player-container'); scope.id = 'unrelated-wrapper'; expect(bottom()).toBe('12px');
    // 即使整页误带相同 id/class，也不扩大查询范围到 body。
    document.body.id = 'player-container-id'; document.body.className = 'player-container'; expect(bottom()).toBe('12px');
  });

  it('does not reserve mobile sibling controls outside the painted video or in the upper area', () => {
    const {document, window, player, layer} = fixture({player: rect(0, 0, 402, 226), intrinsic: [400, 300]});
    Object.defineProperty(window, 'location', {configurable: true, value: new URL('https://m.youtube.com/watch?v=mobile')});
    player.id = 'movie_player'; player.classList.add('html5-video-player', 'ytp-mweb-player');
    const scope = document.createElement('div'); scope.id = 'player-container-id'; scope.className = 'player-container';
    player.before(scope); scope.appendChild(player);
    const controls = document.createElement('div'); controls.className = 'player-controls-bottom'; scope.appendChild(controls);
    let controlRect = rect(0, 190, 40, 30);
    Object.defineProperty(controls, 'getBoundingClientRect', {value: () => controlRect});
    expect(getXVideoSubtitleViewport(player, layer)?.controlsInset).toBe(12);
    controlRect = rect(70, 20, 200, 30);
    expect(getXVideoSubtitleViewport(player, layer)?.controlsInset).toBe(12);
    controlRect = rect(70, 190, 200, 30);
    expect(getXVideoSubtitleViewport(player, layer)?.controlsInset).toBe(44);
  });

  it('constrains fullscreen captions by both notch sides and the upper/lower system safe areas', () => {
    const {document, player, layer} = fixture({player: rect(0, 0, 390, 219.375), intrinsic: [1920, 1080]});
    Object.defineProperty(document, 'fullscreenElement', {value: player});
    const panel = document.createElement('div'); panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div'); overlay.id = VIDEO_TRANSLATION_OVERLAY_ID; overlay.textContent = '双语字幕';
    panel.appendChild(overlay); layer.appendChild(panel);
    const container = document.createElement('div'); document.body.appendChild(container);
    syncTranslationOverlayPosition(container);
    expect(panel.style.maxWidth).toContain('env(safe-area-inset-left');
    expect(panel.style.maxWidth).toContain('env(safe-area-inset-right');
    expect(panel.style.left).toContain('env(safe-area-inset-right');
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-bottom')).toContain('env(safe-area-inset-bottom');
    expect(panel.style.maxHeight).toContain('env(safe-area-inset-top');
    config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE, position: 'top'};
    syncTranslationOverlayPosition(container);
    expect(panel.style.top).toContain('env(safe-area-inset-top');
  });

  it('500% 长双语字幕按可见画面适配，换短句后恢复请求字号', () => {
    const {document, layer} = fixture({intrinsic: [1080, 1920], objectFit: 'contain'});
    config.videoSubtitleAppearance = {...DEFAULT_VIDEO_SUBTITLE_APPEARANCE, fontScale: 500};
    const panel = document.createElement('div'); panel.id = VIDEO_SUBTITLE_PANEL_ID;
    const overlay = document.createElement('div'); overlay.id = VIDEO_TRANSLATION_OVERLAY_ID; overlay.textContent = 'Long bilingual subtitle';
    panel.appendChild(overlay); layer.appendChild(panel);
    let lines = 20;
    Object.defineProperty(panel, 'scrollHeight', {get: () => Number.parseFloat(panel.style.getPropertyValue('--fluent-read-video-subtitle-font-size')) * lines + 16});
    const container = document.createElement('div'); document.body.appendChild(container);
    syncTranslationOverlayPosition(container);
    const requested = 16 * 5;
    expect(Number.parseFloat(panel.style.getPropertyValue('--fluent-read-video-subtitle-font-size'))).toBeLessThan(requested);
    expect(panel.scrollHeight).toBeLessThanOrEqual(Number.parseFloat(panel.style.getPropertyValue('max-height')));
    lines = 2; overlay.textContent = 'Short'; syncTranslationOverlayPosition(container);
    expect(panel.style.getPropertyValue('--fluent-read-video-subtitle-font-size')).toBe(`${requested}px`);
    expect(config.videoSubtitleAppearance.fontScale).toBe(500);
  });

});
