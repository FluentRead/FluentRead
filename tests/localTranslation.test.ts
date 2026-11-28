import {resolveLocalTranslationLanguageCode} from '@/src/core/language/localTranslation';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as detection from '@/src/core/language/detect';
import {
  DEFAULT_LOCAL_TRANSLATION_MODEL,
  HUNYUAN2_SUPPORTED_LANGUAGES,
  HUNYUAN_LANGUAGE_NAMES,
  LOCAL_TRANSLATION_MODEL_IDS,
  LOCAL_TRANSLATION_MODELS,
  localTranslationErrorKey,
  normalizeLocalTranslationDownloadSnapshot,
  normalizeLocalTranslationModel,
  resolveOpusTranslationRepository,
} from '@/src/core/config/localTranslation';
import {
  LOCAL_TRANSLATION_MODEL_FILES,
  getLocalTranslationModelFileUrl,
  isLocalTranslationModelCached,
  removeLocalTranslationModelFiles,
} from '@/src/features/local-translation/offscreen/modelCache';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('@/src/core/language/detect');
});

describe('local translation model catalog', () => {
  it('normalizes the built-in model catalog', () => {
    expect(DEFAULT_LOCAL_TRANSLATION_MODEL).toBe(LOCAL_TRANSLATION_MODEL_IDS.opusZhEn);
    expect(normalizeLocalTranslationModel('missing')).toBe(DEFAULT_LOCAL_TRANSLATION_MODEL);
    const active = LOCAL_TRANSLATION_MODELS.filter((item) => !item.legacy && !item.supersededBy);
    expect(active).toHaveLength(7);
    expect(active.map((item) => item.value)).toEqual([
      LOCAL_TRANSLATION_MODEL_IDS.opusZhEn,
      LOCAL_TRANSLATION_MODEL_IDS.hunyuan3,
      LOCAL_TRANSLATION_MODEL_IDS.opusJaEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusFrEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusDeEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusEsEn,
      LOCAL_TRANSLATION_MODEL_IDS.opusRuEn,
    ]);
    const hyMt2 = LOCAL_TRANSLATION_MODELS.find((item) => item.value === LOCAL_TRANSLATION_MODEL_IDS.hunyuan);
    expect(hyMt2?.supersededBy).toBe(LOCAL_TRANSLATION_MODEL_IDS.hunyuan3);
    expect(hyMt2?.legacy).toBeUndefined();
    expect(HUNYUAN2_SUPPORTED_LANGUAGES.size).toBe(38);
    expect(HUNYUAN_LANGUAGE_NAMES.el).toBe('Greek');
    expect(HUNYUAN_LANGUAGE_NAMES['kk-Cyrl']).toBe('Cyrillic Kazakh');
    expect(HUNYUAN_LANGUAGE_NAMES['mn-Cyrl']).toBe('Cyrillic Mongolian');
  });

  it('resolves Hy-MT3 102 languages vs Hy-MT2 38 languages and all OPUS packs', () => {
    for (const [language, expected] of [
      ['el', 'el'],
      ['sv-SE', 'sv'],
      ['zh-TW', 'zh-Hant'],
      ['nb-NO', 'no'],
      ['nn-NO', 'nn'],
      ['kk-Cyrl', 'kk-Cyrl'],
      ['kk-Cyrl-KZ', 'kk-Cyrl'],
      ['mn_cyrl', 'mn-Cyrl'],
      ['mn-Cyrl-MN', 'mn-Cyrl'],
    ] as const) {
      expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, language)).toBe(expected);
    }
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, 'xx')).toThrow('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.hunyuan, 'fil')).toBe('tl');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.hunyuan, 'zh-TW')).toBe('zh-Hant');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.hunyuan, 'el')).toThrow('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');

    const opusPairs = [
      [LOCAL_TRANSLATION_MODEL_IDS.opusFrEn, 'fr', 'Xenova/opus-mt-en-fr', 'Xenova/opus-mt-fr-en'],
      [LOCAL_TRANSLATION_MODEL_IDS.opusDeEn, 'de', 'Xenova/opus-mt-en-de', 'Xenova/opus-mt-de-en'],
      [LOCAL_TRANSLATION_MODEL_IDS.opusEsEn, 'es', 'Xenova/opus-mt-en-es', 'Xenova/opus-mt-es-en'],
      [LOCAL_TRANSLATION_MODEL_IDS.opusRuEn, 'ru', 'Xenova/opus-mt-en-ru', 'Xenova/opus-mt-ru-en'],
    ] as const;
    for (const [modelId, lang, enToLang, langToEn] of opusPairs) {
      expect(resolveLocalTranslationLanguageCode(modelId, lang)).toBe(lang);
      expect(resolveLocalTranslationLanguageCode(modelId, 'en-US')).toBe('en');
      expect(() => resolveLocalTranslationLanguageCode(modelId, 'zh')).toThrow('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
      expect(resolveOpusTranslationRepository(modelId, 'en', lang)).toBe(enToLang);
      expect(resolveOpusTranslationRepository(modelId, lang, 'en')).toBe(langToEn);
      expect(() => resolveOpusTranslationRepository(modelId, lang, 'zh')).toThrow('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    }
    expect(() => resolveOpusTranslationRepository(LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, 'en', 'zh')).toThrow('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
  });

  it('normalizes download snapshots and maps local translation error keys', () => {
    expect(normalizeLocalTranslationDownloadSnapshot(null)).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({version: 1, tasks: []})).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({version: 2, tasks: [null]})).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({
      version: 2,
      tasks: [
        {model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'ready', downloadedBytes: 10, totalBytes: 10, bytesPerSecond: 0, updatedAt: 1},
        {model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'ready', downloadedBytes: 10, totalBytes: 10, bytesPerSecond: 0, updatedAt: 2},
      ],
    })).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({
      version: 2,
      tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'ready', downloadedBytes: -1, totalBytes: 10, bytesPerSecond: 0, updatedAt: 1}],
    })).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({
      version: 2,
      tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'ready', downloadedBytes: 11, totalBytes: 10, bytesPerSecond: 0, updatedAt: 1}],
    })).toBeUndefined();
    expect(normalizeLocalTranslationDownloadSnapshot({
      version: 2,
      tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'error', downloadedBytes: 5, totalBytes: 10, bytesPerSecond: 0, updatedAt: 1, error: 'network'}],
    })).toEqual({
      version: 2,
      tasks: [{model: LOCAL_TRANSLATION_MODEL_IDS.hunyuan3, phase: 'error', downloadedBytes: 5, totalBytes: 10, bytesPerSecond: 0, updatedAt: 1, error: 'network'}],
    });
    expect(localTranslationErrorKey(new Error('LOCAL_TRANSLATION_NOT_DOWNLOADED'))).toBe('settings.localTranslation.error.notDownloaded');
    expect(localTranslationErrorKey('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED')).toBe('settings.localTranslation.error.language');
    expect(localTranslationErrorKey('LOCAL_TRANSLATION_REPETITION')).toBe('settings.localTranslation.error.repetition');
    expect(localTranslationErrorKey('LOCAL_TRANSLATION_TIMEOUT')).toBe('settings.localTranslation.error.timeout');
    expect(localTranslationErrorKey('LOCAL_TRANSLATION_MODEL_REMOVED')).toBe('settings.localTranslation.error.removed');
    expect(localTranslationErrorKey('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED')).toBe('settings.localTranslation.error.browser');
    expect(localTranslationErrorKey(undefined)).toBe('settings.localTranslation.trialError');
  });

  it('maps product language codes for M2M100 and NLLB and rejects unsupported pairs', () => {
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, 'zh-Hans')).toBe('zh');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, 'en-US')).toBe('en');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.nllb, 'zh-Hant')).toBe('zho_Hant');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.nllb, 'ja')).toBe('jpn_Jpan');
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, 'auto', 'This is a long enough English sentence for local language detection.')).toBe('en');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, 'auto')).toThrow('空文本');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.nllb, 'xx')).toThrow('暂不支持');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, '123')).toThrow('暂不支持语言：123');
    vi.spyOn(detection, 'detectlang').mockReturnValueOnce('xx');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, '', 'sample')).toThrow('暂不支持语言：xx');
  });

  it('loads model metadata without evaluating the text detector', async () => {
    vi.resetModules();
    const evaluateDetector = vi.fn(() => { throw new Error('model metadata must not initialize text detection'); });
    vi.doMock('@/src/core/language/detect', evaluateDetector);
    const metadata = await import('@/src/core/config/localTranslation');
    expect(metadata.getLocalTranslationModel(undefined).value).toBe(DEFAULT_LOCAL_TRANSLATION_MODEL);
    expect(metadata.normalizeLocalTranslationModel(LOCAL_TRANSLATION_MODEL_IDS.hunyuan)).toBe(LOCAL_TRANSLATION_MODEL_IDS.hunyuan);
    expect(evaluateDetector).not.toHaveBeenCalled();
  });

  it('keeps specified model languages independent of detection text and preserves model aliases', () => {
    const detect = vi.spyOn(detection, 'detectlang');
    for (const [model, language, expected] of [
      [LOCAL_TRANSLATION_MODEL_IDS.opusZhEn, 'zh-TW', 'zh'],
      [LOCAL_TRANSLATION_MODEL_IDS.opusJaEn, 'ja-JP', 'ja'],
      [LOCAL_TRANSLATION_MODEL_IDS.hunyuan, 'fil', 'tl'],
      [LOCAL_TRANSLATION_MODEL_IDS.hunyuan, 'zh-TW', 'zh-Hant'],
      [LOCAL_TRANSLATION_MODEL_IDS.m2m100, ' nb-NO ', 'no'],
      [LOCAL_TRANSLATION_MODEL_IDS.nllb, 'nb-NO', 'nno_Latn'],
      [LOCAL_TRANSLATION_MODEL_IDS.nllb, 'zh-Hans', 'zho_Hans'],
      [LOCAL_TRANSLATION_MODEL_IDS.nllb, 'zh-Hant', 'zho_Hant'],
      ['retired-model', 'en-US', 'en'],
    ]) expect(resolveLocalTranslationLanguageCode(model, language, '😀')).toBe(expected);
    expect(detect).not.toHaveBeenCalled();
  });

  it.each([' AUTO ', '', undefined, null, 42])('keeps automatic source detection and blank input rejection for %s', (language) => {
    const text = 'This is a long enough English sentence for local language detection.';
    expect(resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.m2m100, language, text)).toBe('en');
    expect(() => resolveLocalTranslationLanguageCode(LOCAL_TRANSLATION_MODEL_IDS.nllb, language, ' \n\t ')).toThrow('本地模型无法自动识别空文本，请指定源语言');
  });
});

describe('local translation model cache', () => {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (url: string) => entries.get(url)),
    put: vi.fn(async (url: string, response: Response) => { entries.set(url, response); }),
    delete: vi.fn(async (url: string) => entries.delete(url)),
  };

  beforeEach(() => {
    entries.clear();
    vi.stubGlobal('caches', {open: vi.fn(async () => cache)});
    vi.stubGlobal('window', {setTimeout, clearTimeout});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('model')));
  });

  const seed = (model: string) => {
    for (const file of LOCAL_TRANSLATION_MODEL_FILES) entries.set(getLocalTranslationModelFileUrl(model, file), new Response('model'));
  };

  it('uses the exact q8 manifests and reports complete state only when every file is cached', async () => {
    expect(getLocalTranslationModelFileUrl(LOCAL_TRANSLATION_MODEL_IDS.m2m100, LOCAL_TRANSLATION_MODEL_FILES[0]))
      .toContain('Xenova/m2m100_418M/resolve/main/config.json');
    await expect(isLocalTranslationModelCached(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBe(false);
    seed(LOCAL_TRANSLATION_MODEL_IDS.m2m100);
    entries.delete(getLocalTranslationModelFileUrl(LOCAL_TRANSLATION_MODEL_IDS.m2m100, LOCAL_TRANSLATION_MODEL_FILES.at(-1)!));
    await expect(isLocalTranslationModelCached(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBe(false);
    seed(LOCAL_TRANSLATION_MODEL_IDS.m2m100);
    await expect(isLocalTranslationModelCached(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBe(true);
  });

  it('removes only the selected model files', async () => {
    seed(LOCAL_TRANSLATION_MODEL_IDS.m2m100);
    seed(LOCAL_TRANSLATION_MODEL_IDS.nllb);
    await removeLocalTranslationModelFiles(LOCAL_TRANSLATION_MODEL_IDS.m2m100);
    await expect(isLocalTranslationModelCached(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBe(false);
    await expect(isLocalTranslationModelCached(LOCAL_TRANSLATION_MODEL_IDS.nllb)).resolves.toBe(true);
  });
});
