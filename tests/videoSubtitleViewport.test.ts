/**
 * @file tests/videoSubtitleViewport.test.ts
 * 文件职责：验证 X 视频字幕按实际画面矩形定位时的 object-fit、object-position 和 layer 坐标换算。
 * 主要内容：覆盖竖屏 contain、横屏留白、cover/none/scale-down、缩放 layer、缺失尺寸和同步样式。
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
import {
  applyVideoDisplayState,
  getXVideoSubtitleViewport,
  installVideoSubtitleStyle,
  removeTranslationOverlay,
  syncTranslationOverlayPosition,
  VIDEO_PLAYER_HOST_CLASS,
  VIDEO_SUBTITLE_PANEL_ID,
  VIDEO_TRANSLATION_LAYER_ID,
  VIDEO_TRANSLATION_OVERLAY_ID,
} from '@/src/features/video-subtitle/content/ui';

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
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    position: 'relative',
    objectFit: element === video ? options.objectFit || 'contain' : '',
    objectPosition: element === video ? options.objectPosition || '50% 50%' : '',
  }));
  player.classList.add(VIDEO_PLAYER_HOST_CLASS);
  return {document, window, player, video, layer};
}

afterEach(() => vi.unstubAllGlobals());

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
