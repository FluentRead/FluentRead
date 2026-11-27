import { describe, expect, it, vi } from 'vitest';
import {options, getMultilingualTargetLanguageLabel} from '@/src/core/config/catalog';
import {normalizeConfig} from '@/src/core/config/model';
import {WRITING_LANGUAGES, normalizeWritingPreferences, resolveWritingLanguage} from '@/src/core/config/writing';

vi.mock('@/src/services/config/store', () => ({
    config: {
        from: 'auto',
        to: 'zh-Hans',
    },
}));

import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {getTranslationLanguages} from '@/src/services/translation/languages';

describe('翻译请求语言隔离', () => {
    it('优先使用请求级语言而不需要改写默认配置', () => {
        expect(getTranslationLanguages({
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        })).toEqual({
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        });
    });

    it('缺少或为空的请求级语言会回退到默认配置', () => {
        expect(getTranslationLanguages({
            sourceLanguage: ' ',
        })).toEqual({
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
        });
    });

    it('纯解析器清理请求值，并使用显式默认快照', () => {
        expect(resolveTranslationLanguages({
            sourceLanguage: '  de ',
            targetLanguage: '',
        }, {
            sourceLanguage: 'auto',
            targetLanguage: 'fr',
        })).toEqual({
            sourceLanguage: 'de',
            targetLanguage: 'fr',
        });
    });

    it('纯解析器允许 null 请求并完整回退', () => {
        expect(resolveTranslationLanguages(null, {
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        })).toEqual({sourceLanguage: 'en', targetLanguage: 'ja'});
    });

    it('请求语言与默认快照均按书写体系归一，保留简繁互译方向', () => {
        expect(resolveTranslationLanguages({
            sourceLanguage: 'zh-TW',
            targetLanguage: 'zh-CN',
        }, {sourceLanguage: 'auto', targetLanguage: 'en'}))
            .toEqual({sourceLanguage: 'zh-Hant', targetLanguage: 'zh-Hans'});
        expect(resolveTranslationLanguages(undefined, {
            sourceLanguage: ' zh-CHS ',
            targetLanguage: ' zh-Hant-CN ',
        })).toEqual({sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hant'});
        expect(resolveTranslationLanguages({
            sourceLanguage: 'auto',
            targetLanguage: 'yue',
        }, {sourceLanguage: 'zh-Hant', targetLanguage: 'zh-Hans'}))
            .toEqual({sourceLanguage: 'auto', targetLanguage: 'yue'});
    });
});

describe('扩展翻译语言目录', () => {
    it('源语言、目标语言、输入框和写作共用无重复的完整目录', () => {
        const targets = options.to.map(item => item.value);
        expect(targets).toHaveLength(52);
        expect(new Set(targets).size).toBe(targets.length);
        expect(options.from.map(item => item.value)).toEqual(['auto', ...targets]);
        expect(options.inputBoxTranslationTarget.map(item => item.value)).toEqual(['auto', ...targets]);
        expect(normalizeConfig({inputBoxTranslationTarget: 'auto'}).inputBoxTranslationTarget).toBe('auto');
        expect(WRITING_LANGUAGES.map(item => item.value)).toEqual(['target', ...targets]);
        expect(targets).toEqual(expect.arrayContaining(['ar', 'hi', 'vi', 'th', 'de', 'pt', 'it', 'uk', 'sw', 'fil']));
    });

    it('新增语言在七种界面中有名称，保存后仍用于写作和翻译请求', () => {
        for (const {value} of options.to) {
            for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
                expect(getMultilingualTargetLanguageLabel(value, 'missing', locale)).not.toBe('missing');
            }
            const saved = normalizeConfig({from: value, to: value, inputBoxTranslationTarget: value});
            expect(saved).toMatchObject({from: value, to: value, inputBoxTranslationTarget: value});
            expect(normalizeWritingPreferences({language: value, referenceLanguage: value}))
                .toMatchObject({language: value, referenceLanguage: value});
            expect(resolveWritingLanguage('target', saved.to)).toBe(value);
            expect(getTranslationLanguages({sourceLanguage: value, targetLanguage: value}))
                .toEqual({sourceLanguage: value, targetLanguage: value});
        }
        expect(getMultilingualTargetLanguageLabel('ar', '', 'en-US')).toBe('Arabic');
        expect(getMultilingualTargetLanguageLabel('vi', '', 'zh-CN')).toContain('越南语');
    });
});
