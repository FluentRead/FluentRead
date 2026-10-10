import {describe, expect, it, vi} from 'vitest';
import {fitVideoSubtitleFontSize} from '@/src/features/video-subtitle/content/subtitleLayout';

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
    })).toEqual({
      skin: 'neon',
      textColor: '#abcdef',
      translationColor: '#123456',
      position: 'top',
      bottomOffset: 25,
      autoBottom: false,
      backgroundOpacity: 0,
      lineSpacing: 1.35,
      maxWidth: 67,
      fontScale: 123,
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

});
