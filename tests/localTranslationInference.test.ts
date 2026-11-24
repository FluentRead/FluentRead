import {resolveLocalTranslationLanguageCode} from '@/src/core/language/localTranslation';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {supportsHunyuanTranslation} from '@/src/platform/browser/localTranslationSupport';
import {readFileSync} from 'node:fs';
import {prepareWllamaExtensionModule} from '../scripts/testing/wllama-extension-build';
import * as messages from '@/src/core/i18n/messages/localTranslation';
import {assertLocalTranslationOutput, hunyuanTranslationPrompt, splitLocalTranslationText} from '@/src/core/translation/localInference';
import {LOCAL_TRANSLATION_MODEL_IDS as ids, resolveOpusTranslationRepository} from '@/src/core/config/localTranslation';

describe('local model language routes and bounded generation', () => {
  it('packages the pinned Hunyuan worker without a blob Worker or runtime evaluation', () => {
    const code = readFileSync(new URL('../node_modules/@wllama/wllama/esm/index.js', import.meta.url), 'utf8');
    const result = prepareWllamaExtensionModule(code);
    expect(result.code).not.toContain('createWorker(completeCode)');
    expect(result.code).toContain("new URL('fluent-read-ai/wllama.worker.js', self.location.href)");
    expect(result.source).toContain("self.addEventListener('message', function bootstrap");
    expect(result.source).toContain('function wModuleInit()');
    expect(() => prepareWllamaExtensionModule('const incompatible = true;')).toThrow('Unsupported wllama build');
    for (const catalog of Object.values(messages)) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(messages.localTranslationEnglishMessages).sort());
      expect(Object.values(catalog).every((value) => value.trim().length > 0)).toBe(true);
    }
  });
  afterEach(() => vi.unstubAllGlobals());
  it('detects memory64 support without allocating model-sized memory', () => {
    const validate = vi.fn(() => true);
    vi.stubGlobal('WebAssembly', {validate});
    expect(supportsHunyuanTranslation()).toBe(true);
    expect(validate).toHaveBeenCalledWith(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]));
    validate.mockReturnValue(false);
    expect(supportsHunyuanTranslation()).toBe(false);
    vi.stubGlobal('WebAssembly', undefined);
    expect(supportsHunyuanTranslation()).toBe(false);
  });
  it('resolves both directions to distinct small models and rejects unsupported language pairs', () => {
    expect(resolveOpusTranslationRepository(ids.opusZhEn, 'en', 'zh')).toBe('Xenova/opus-mt-en-zh');
    expect(resolveOpusTranslationRepository(ids.opusZhEn, 'zh', 'en')).toBe('Xenova/opus-mt-zh-en');
    expect(resolveOpusTranslationRepository(ids.opusJaEn, 'ja', 'en')).toBe('Xenova/opus-mt-ja-en');
    expect(resolveOpusTranslationRepository(ids.opusJaEn, 'en', 'ja')).toBe('Xenova/opus-mt-en-jap');
    expect(() => resolveOpusTranslationRepository(ids.opusZhEn, 'ja', 'zh')).toThrow('LANGUAGE_UNSUPPORTED');
    expect(resolveLocalTranslationLanguageCode(ids.hunyuan, 'zh-Hant')).toBe('zh-Hant');
    expect(resolveLocalTranslationLanguageCode(ids.hunyuan, 'ja-JP')).toBe('ja');
    expect(() => resolveLocalTranslationLanguageCode(ids.opusJaEn, 'zh')).toThrow('LANGUAGE_UNSUPPORTED');
  });

  it('splits long paragraphs without losing whitespace or cutting surrogate pairs', () => {
    const text = 'A short sentence.\n\n' + '材料😀'.repeat(500) + ' End.';
    const parts = splitLocalTranslationText(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => part.length <= 480)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/u.test(part))).toBe(true);
    expect(splitLocalTranslationText('x'.repeat(11) + ' ' + 'y'.repeat(11), 20).join('')).toBe('x'.repeat(11) + ' ' + 'y'.repeat(11));
    expect(splitLocalTranslationText('x'.repeat(19) + '😀end', 20)).toEqual(['x'.repeat(19), '😀end']);
    expect(splitLocalTranslationText('')).toEqual([]);
  });

  it('groups sentences within a line and within the budget while preserving paragraph separators', () => {
    const text = '  Hello. Goodbye!\r\n\r\n第一句。第二句。\u2029Last.';
    expect(splitLocalTranslationText(text, 50, 'paragraph')).toEqual([
      '  Hello. Goodbye!\r\n', '\r\n', '第一句。第二句。\u2029', 'Last.',
    ]);
    expect(splitLocalTranslationText('Hello. Goodbye!', 9, 'paragraph')).toEqual(['Hello. ', 'Goodbye!']);
    expect(splitLocalTranslationText('Hello. Goodbye!')).toEqual(['Hello. ', 'Goodbye!']);

    const long = 'First. ' + '材料😀'.repeat(220) + ' Done! Next.';
    const parts = splitLocalTranslationText(long, 80, 'paragraph');
    expect(parts.join('')).toBe(long);
    expect(parts.every((part) => part.length <= 80 && !/[\uD800-\uDBFF]$/u.test(part))).toBe(true);
  });

  it('uses the translation-specific Hunyuan prompt and preserves the original source literally', () => {
    expect(hunyuanTranslationPrompt('材料 <x>', 'zh', 'en')).toContain('材料 <x>');
    expect(hunyuanTranslationPrompt('print', 'en', 'ja')).toContain('Japanese');
    expect(() => hunyuanTranslationPrompt('print', 'en', 'invalid')).toThrow('LANGUAGE_UNSUPPORTED');
  });

  it('rejects the repeated output reported by the user while allowing source-owned repetitions', () => {
    expect(() => assertLocalTranslationOutput('而是用旧线与新线' + '冲'.repeat(100), 'The printer flushes the old filament.')).toThrow('REPETITION');
    expect(() => assertLocalTranslationOutput('abc'.repeat(20), 'abc'.repeat(20))).not.toThrow();
    expect(() => assertLocalTranslationOutput('打印机排出残余材料，避免混色。', 'The printer flushes the remaining material to avoid color mixing.')).not.toThrow();
    expect(() => assertLocalTranslationOutput('', 'source')).toThrow('EMPTY');
  });
});
