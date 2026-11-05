import {describe, expect, it, vi} from 'vitest';
import {fitVideoSubtitleFontSize, getVideoSubtitleFreeRegions, videoSubtitleRectsOverlap} from '@/src/features/video-subtitle/content/subtitleLayout';

import {
  DEFAULT_VIDEO_SUBTITLE_APPEARANCE,
  VIDEO_SUBTITLE_SKINS,
  getVideoSubtitleAppearanceCssVars,
  normalizeVideoSubtitleAppearance,
} from '@/src/core/config/videoSubtitleAppearance';
import {
  Config,
  VIDEO_SOURCE_LANGUAGE_OPTIONS,
  normalizeConfig,
  normalizeVideoSubtitleOffsetMs,
} from '@/src/core/config/model';

describe('video subtitle appearance contract', () => {
  it('移动视频的空区同时避开顶部、中部和底部控件，保留足以阅读的左上区域', () => {
    const viewport = {left: 50, top: 48, width: 301, height: 226};
    const obstacles = [{left: 234, top: 48, width: 144, height: 48}, {left: 91, top: 133, width: 220, height: 56},
      {left: 12, top: 200, width: 312, height: 44}, {left: 330, top: 200, width: 48, height: 44}, {left: 30, top: 230, width: 342, height: 44}];
    const regions = getVideoSubtitleFreeRegions(viewport, obstacles);
    expect(regions).toContainEqual({left: 56, top: 54, width: 174, height: 75});
    for (const area of regions) {
      expect(area.left).toBeGreaterThanOrEqual(viewport.left); expect(area.top).toBeGreaterThanOrEqual(viewport.top);
      expect(area.left + area.width).toBeLessThanOrEqual(viewport.left + viewport.width);
      expect(area.top + area.height).toBeLessThanOrEqual(viewport.top + viewport.height);
      expect(obstacles.some(obstacle => videoSubtitleRectsOverlap(area, obstacle))).toBe(false);
    }
    expect(getVideoSubtitleFreeRegions(viewport, [...obstacles, ...obstacles])).toEqual(regions);
    expect(getVideoSubtitleFreeRegions(viewport, [{left: 500, top: 500, width: 5, height: 5}])).toEqual([{left: 56, top: 54, width: 289, height: 214}]);
  });

  it('空区搜索限制障碍与候选数量，不伪造被全部覆盖的可用位置', () => {
    expect(getVideoSubtitleFreeRegions({left: 0, top: 0, width: 100, height: 100}, [{left: 0, top: 0, width: 100, height: 100}])).toEqual([]);
    const obstacles = Array.from({length: 100}, (_, index) => ({left: index * 7, top: index * 3, width: 8, height: 12}));
    const viewport = {left: 0, top: 0, width: 320, height: 180};
    expect(getVideoSubtitleFreeRegions(viewport, obstacles)).toEqual(getVideoSubtitleFreeRegions(viewport, obstacles.slice(0, 16)));
    expect(getVideoSubtitleFreeRegions(viewport, obstacles).length).toBeLessThanOrEqual(8);
  });
  it('字幕时间偏移保存为半秒步进，迁移旧配置时默认同步且不改已有字幕外观', () => {
    expect(new Config().videoSubtitleOffsetMs).toBe(0);
    expect(normalizeConfig({}).videoSubtitleOffsetMs).toBe(0);
    for (const value of [undefined, 'invalid', Infinity, NaN]) expect(normalizeVideoSubtitleOffsetMs(value)).toBe(0);
    expect(normalizeVideoSubtitleOffsetMs(99999)).toBe(10000);
    expect(normalizeVideoSubtitleOffsetMs(-99999)).toBe(-10000);
    expect(normalizeVideoSubtitleOffsetMs('500')).toBe(500);
    expect(normalizeVideoSubtitleOffsetMs(-1100)).toBe(-1000);
    expect(Object.is(normalizeVideoSubtitleOffsetMs(-1), -0)).toBe(false);
    const saved = normalizeConfig({videoSubtitleOffsetMs: -1500, videoSubtitleAppearance: {fontScale: 140}});
    expect(saved.videoSubtitleOffsetMs).toBe(-1500);
    expect(saved.videoSubtitleAppearance.fontScale).toBe(140);
    expect(normalizeConfig(JSON.parse(JSON.stringify(saved))).videoSubtitleOffsetMs).toBe(-1500);
  });

  it('exposes an extensible skin registry while preserving the current default', () => {
    expect(VIDEO_SUBTITLE_SKINS.length).toBeGreaterThanOrEqual(8);
    expect(VIDEO_SUBTITLE_SKINS.map((skin) => skin.id)).toContain('classic');
    expect(new Config().videoSubtitleAppearance).toEqual(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
    expect(new Config().videoSourceLanguage).toBe('auto');
    expect(VIDEO_SOURCE_LANGUAGE_OPTIONS.map((item) => item.value)).toContain('ko');
  });

  it('normalizes invalid appearance input to bounded defaults and accepts valid controls', () => {
    expect(normalizeVideoSubtitleAppearance(undefined)).toEqual(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
    expect(normalizeVideoSubtitleAppearance({
      skin: 'neon',
      textColor: ' #ABCDEF ',
      translationColor: '#123456',
      position: 'top',
      bottomOffset: 99,
      backgroundOpacity: -10,
      lineSpacing: 1.35,
      maxWidth: 67,
      fontScale: 123,
      karaoke: true,
    })).toEqual({
      skin: 'neon',
      textColor: '#abcdef',
      translationColor: '#123456',
      position: 'top',
      bilingualOrder: 'original-first',
      bottomOffset: 25,
      autoBottom: false,
      backgroundVisible: true,
      backgroundOpacity: 0,
      outlineStyle: 'skin',
      outlineColor: '#000000',
      outlineWidth: 1,
      lineSpacing: 1.35,
      maxWidth: 67,
      fontScale: 123,
      karaoke: true,
      readingAnnotation: false,
    });
    expect(normalizeVideoSubtitleAppearance({
      skin: 'removed',
      textColor: 'red',
      translationColor: '#12',
      position: 'side',
      bottomOffset: Number.NaN,
      backgroundOpacity: Number.POSITIVE_INFINITY,
      lineSpacing: 'invalid',
      maxWidth: null,
      fontScale: undefined,
    })).toEqual(DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
    expect(normalizeVideoSubtitleAppearance({position: 'center'}).position).toBe('center');
    // 逐字高亮默认关闭，只有明确的 true 才开启。
    expect(DEFAULT_VIDEO_SUBTITLE_APPEARANCE.karaoke).toBe(false);
    expect(normalizeVideoSubtitleAppearance({karaoke: 'true'}).karaoke).toBe(false);
    expect(normalizeVideoSubtitleAppearance({bottomOffset: 10}).autoBottom).toBe(true);
    expect(normalizeVideoSubtitleAppearance({bottomOffset: 16}).autoBottom).toBe(false);
    expect(normalizeVideoSubtitleAppearance({autoBottom: false}).autoBottom).toBe(false);
    expect(normalizeVideoSubtitleAppearance({autoBottom: true, bottomOffset: 16}).autoBottom).toBe(true);
    expect(normalizeVideoSubtitleAppearance({skin: 'clean'})).toMatchObject({
      textColor: '#1f2937',
      translationColor: '#0f766e',
      backgroundOpacity: 88,
    });
  });

  it('轮廓颜色复用既有颜色库归一化透明值和越界通道，拒绝无效 CSS', () => {
    for (const [value, expected] of [
      [' #FF102080 ', '#ff102080'], ['rgb(255, 16, 32)', '#ff1020'],
      ['rgba(255, 16, 32, 1)', '#ff1020'], ['rgba(255, 16, 32, 0)', '#ff102000'],
      ['rgba(256, 0, 0, .5)', '#ff000080'], ['rgba(-1, 0, 0, .5)', '#00000080'],
      ['rgba(0, 0, 0, 1.5)', '#000000'], ['url(https://example.test)', '#000000'],
      ['#F08', '#ff0088'], ['red', '#ff0000'], ['transparent', '#00000000'],
    ]) expect(normalizeVideoSubtitleAppearance({outlineColor: value}).outlineColor).toBe(expected);
    const shadow = getVideoSubtitleAppearanceCssVars({skin: 'clean', outlineStyle: 'shadow'});
    expect(shadow['--fluent-read-video-subtitle-text-shadow'].split(', ')).toHaveLength(8);
  });

  it('各皮肤的默认轮廓数据保持既有颜色与粗细', () => {
    for (const [skin, outlineColor, outlineWidth] of [
      ['classic', '#000000', 1], ['clean', '#000000', 1], ['glass', '#00000066', 1],
      ['contrast', '#000000', 2], ['paper', '#23140a99', 1], ['terminal', '#000000', 1],
      ['neon', '#000000', 1], ['minimal', '#000000', 1],
    ]) expect(normalizeVideoSubtitleAppearance({skin})).toMatchObject({outlineStyle: 'skin', outlineColor, outlineWidth});
  });

  it('双语顺序默认原文在上，合法值经配置保存保留，旧值和非法值回退且不改其他外观', () => {
    expect(new Config().videoSubtitleAppearance.bilingualOrder).toBe('original-first');
    for (const bilingualOrder of [undefined, null, '', 'invalid', false, {}, 'ORIGINAL-FIRST']) {
      const appearance = normalizeVideoSubtitleAppearance({bilingualOrder, readingAnnotation: true, fontScale: 160});
      expect(appearance).toMatchObject({bilingualOrder: 'original-first', readingAnnotation: true, fontScale: 160});
      expect(getVideoSubtitleAppearanceCssVars(appearance)['--fluent-read-video-subtitle-translation-order']).toBe('3');
    }
    for (const bilingualOrder of ['original-first', 'translation-first'] as const) {
      const saved = normalizeConfig({videoSubtitleAppearance: {bilingualOrder, readingAnnotation: true, fontScale: 160}});
      expect(normalizeConfig(JSON.parse(JSON.stringify(saved))).videoSubtitleAppearance).toMatchObject({
        bilingualOrder, readingAnnotation: true, fontScale: 160,
      });
      expect(getVideoSubtitleAppearanceCssVars(saved.videoSubtitleAppearance)['--fluent-read-video-subtitle-translation-order'])
        .toBe(bilingualOrder === 'translation-first' ? '0' : '3');
    }
  });

  it('converts normalized appearance to stable CSS variables for the content UI', () => {
    const vars = getVideoSubtitleAppearanceCssVars({
      skin: 'terminal',
      textColor: '#112233',
      translationColor: '#abcdef',
      position: 'top',
      bottomOffset: 12,
      backgroundOpacity: 50,
      lineSpacing: 1.5,
      maxWidth: 75,
      fontScale: 140,
    });
    expect(vars).toMatchObject({
      '--fluent-read-video-subtitle-text-color': '#112233',
      '--fluent-read-video-subtitle-translation-color': '#abcdef',
      '--fluent-read-video-subtitle-position': 'top',
      '--fluent-read-video-subtitle-bottom-offset': '12%',
      '--fluent-read-video-subtitle-background': 'rgba(4, 20, 16, 0.5)',
      '--fluent-read-video-subtitle-line-spacing': '1.5',
      '--fluent-read-video-subtitle-max-width': '75%',
      '--fluent-read-video-subtitle-font-scale': '140%',
    });
  });

  it('保留旧皮肤轮廓，并归一化自定义轮廓、透明度与背景开关', () => {
    expect(normalizeVideoSubtitleAppearance({skin: 'glass'})).toMatchObject({
      outlineStyle: 'skin', outlineColor: '#00000066', outlineWidth: 1, backgroundVisible: true,
    });
    const stroke = normalizeVideoSubtitleAppearance({outlineStyle: 'stroke', outlineColor: 'rgba(255, 16, 32, .5)', outlineWidth: 2.34});
    expect(stroke).toMatchObject({outlineStyle: 'stroke', outlineColor: '#ff102080', outlineWidth: 2.3});
    expect(getVideoSubtitleAppearanceCssVars(stroke)).toMatchObject({
      '--fluent-read-video-subtitle-text-stroke': '2.3px #ff102080',
    });
    const shadow = getVideoSubtitleAppearanceCssVars({outlineStyle: 'shadow', outlineColor: '#12ab34', outlineWidth: 2});
    expect(shadow['--fluent-read-video-subtitle-text-stroke']).toBe('0');
    expect(shadow['--fluent-read-video-subtitle-text-shadow']).toContain('2px 0px 0 #12ab34');
    const none = getVideoSubtitleAppearanceCssVars({outlineStyle: 'none'});
    expect(none['--fluent-read-video-subtitle-text-stroke']).toBe('0');
    expect(none['--fluent-read-video-subtitle-text-shadow']).toBe('none');
    const noBackground = getVideoSubtitleAppearanceCssVars({backgroundVisible: false, backgroundOpacity: 72});
    expect(noBackground).toMatchObject({
      '--fluent-read-video-subtitle-background': 'transparent',
      '--fluent-read-video-subtitle-border': 'transparent',
      '--fluent-read-video-subtitle-shadow': 'none',
      '--fluent-read-video-subtitle-backdrop-filter': 'none',
    });
    expect(normalizeVideoSubtitleAppearance({backgroundVisible: 'false'}).backgroundVisible).toBe(true);
    expect(normalizeVideoSubtitleAppearance({outlineStyle: 'invalid', outlineWidth: 99, outlineColor: 'url(javascript:alert(1))'}))
      .toMatchObject({outlineStyle: 'skin', outlineWidth: 4, outlineColor: '#000000'});
  });

  it('keeps video source language separate from the webpage language during normalization', () => {
    const normalized = normalizeConfig({from: 'en', videoSourceLanguage: 'ko'});
    expect(normalized.from).toBe('en');
    expect(normalized.videoSourceLanguage).toBe('ko');
    expect(normalizeConfig({videoSubtitleFontSize: 140}).videoSubtitleAppearance.fontScale).toBe(140);
    expect(normalizeConfig({videoSourceLanguage: 'xx'}).videoSourceLanguage).toBe('auto');
    expect(normalizeConfig({videoSourceLanguage: '  '}).videoSourceLanguage).toBe('auto');
  });
  it('保存 200–500% 和整数自定义字号，旧字号保持不变，非法输入仍回退', () => {
    for (const fontScale of [80, 100, 160, 200, 325, 500]) {
      expect(normalizeVideoSubtitleAppearance({fontScale}).fontScale).toBe(fontScale);
      expect(normalizeConfig({videoSubtitleAppearance: {fontScale}}).videoSubtitleAppearance.fontScale).toBe(fontScale);
    }
    expect(normalizeVideoSubtitleAppearance({fontScale: '325'}).fontScale).toBe(325);
    expect(normalizeVideoSubtitleAppearance({fontScale: 900}).fontScale).toBe(500);
    expect(normalizeVideoSubtitleAppearance({fontScale: -1}).fontScale).toBe(80);
    expect(normalizeVideoSubtitleAppearance({fontScale: NaN}).fontScale).toBe(100);
    expect(getVideoSubtitleAppearanceCssVars({fontScale: 500})['--fluent-read-video-subtitle-font-scale']).toBe('500%');
  });
  it('大字号按实际换行高度适配；新字幕或更大画面重新从用户字号计算', () => {
    let applied = 0;
    const apply = (size: number) => {applied = size;};
    const fitted = fitVideoSubtitleFontSize(100, 120, apply, () => applied * 4 + 16);
    expect(fitted).toBeLessThan(30); expect(applied * 4 + 16).toBeLessThanOrEqual(120);
    expect(fitVideoSubtitleFontSize(100, 500, apply, () => applied * 4 + 16)).toBe(100);
    expect(fitVideoSubtitleFontSize(100, 120, apply, () => applied)).toBe(100);
    expect(fitVideoSubtitleFontSize(NaN, 0, apply, () => 0)).toBe(16);
    expect(fitVideoSubtitleFontSize(12, 1, apply, () => 200)).toBe(8);
    expect(fitVideoSubtitleFontSize(100, 120, apply, () => NaN)).toBe(100);
  });
  it('非线性换行高度下接近最大可容纳字号，测量次数固定有界', () => {
    let applied = 0;
    // 字符随字号变宽，行数在整数边界跳变；高度不是字号的线性函数。
    const heightFor = (size: number) => Math.ceil(400 * size / 900) * size * 1.28 + 16;
    const measure = vi.fn(() => heightFor(applied));
    const fitted = fitVideoSubtitleFontSize(105.6, 474, size => {applied = size;}, measure);
    expect(fitted).toBeGreaterThan(25);
    expect(heightFor(fitted)).toBeLessThanOrEqual(474);
    expect(heightFor(fitted + .4)).toBeGreaterThan(474);
    expect(applied).toBe(fitted);
    expect(measure.mock.calls.length).toBeLessThanOrEqual(10);
    measure.mockClear();
    expect(fitVideoSubtitleFontSize(105.6, 8000, size => {applied = size;}, measure)).toBe(105.6);
    expect(measure).toHaveBeenCalledOnce();
  });
  it('无效视口或中途测量失效不会无限试探，也不应用未经证明的中间字号', () => {
    let applied = 0;
    const apply = (size: number) => {applied = size;};
    expect(fitVideoSubtitleFontSize(0, NaN, apply, () => 0)).toBe(16);
    expect(fitVideoSubtitleFontSize(8, 1, apply, () => 100)).toBe(8);
    expect(fitVideoSubtitleFontSize(100, 120, apply, () => applied === 100 ? 1000 : NaN)).toBe(100);
    expect(applied).toBe(100);
    expect(fitVideoSubtitleFontSize(100, 120, apply, () => applied === 100 ? 1000 : applied === 8 ? 24 : NaN)).toBe(8);
    expect(applied).toBe(8);
  });

  it('三行读音允许指定可读下限，溢出也不缩至下限以下，低于下限的原字号不被放大', () => {
    let applied = 0;
    const apply = (value: number) => {applied = value;};
    expect(fitVideoSubtitleFontSize(32, 30, apply, () => applied * 3, 14)).toBe(14);
    expect(applied).toBe(14);
    expect(fitVideoSubtitleFontSize(10, 1, apply, () => applied * 3, 14)).toBe(10);
    expect(applied).toBe(10);
    expect(fitVideoSubtitleFontSize(32, 1, apply, () => applied * 3, NaN)).toBe(8);
    expect(fitVideoSubtitleFontSize(32, 1, apply, () => applied * 3, 0)).toBe(8);
    expect(fitVideoSubtitleFontSize(13, 12.345, apply, () => applied, 12.345)).toBeGreaterThanOrEqual(12.345);
    expect(applied).toBeGreaterThanOrEqual(12.345);
  });

});
