import {describe, expect, it} from 'vitest';

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
} from '@/src/core/config/model';

describe('video subtitle appearance contract', () => {
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
      fontScale: 120,
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
});
