import {describe, expect, it} from 'vitest';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';
import {translate, translateLegacyText} from '@/src/core/i18n';
import {navigationItems} from '@/src/features/settings/model/navigation';
import {
    translationStatsChineseMessages,
    translationStatsEnglishMessages,
    translationStatsFrenchMessages,
    translationStatsJapaneseMessages,
    translationStatsKoreanMessages,
    translationStatsRussianMessages,
    translationStatsSpanishMessages,
} from '@/src/core/i18n/messages/translationStats';

registerAllUiLanguageBundles();

const catalogs = {
    'en-US': translationStatsEnglishMessages,
    'ja-JP': translationStatsJapaneseMessages,
    'ko-KR': translationStatsKoreanMessages,
    'fr-FR': translationStatsFrenchMessages,
    'ru-RU': translationStatsRussianMessages,
    'es-ES': translationStatsSpanishMessages,
} as const;

function placeholders(value: string): string[] {
    return [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
}

describe('翻译统计界面文案', () => {
    it('七种界面语言拥有相同 key 与占位符，并已合并进各语言目录', () => {
        const keys = Object.keys(translationStatsChineseMessages).sort();
        expect(keys.length).toBeGreaterThan(100);
        for (const [language, catalog] of Object.entries(catalogs)) {
            expect(Object.keys(catalog).sort(), language).toEqual(keys);
            for (const key of keys) {
                const source = translationStatsChineseMessages[key as keyof typeof translationStatsChineseMessages];
                const localized = catalog[key as keyof typeof catalog];
                expect(placeholders(localized), `${language}: ${key}`).toEqual(placeholders(source));
                // 日文与中文共用部分汉字词（如“成功”“今日”），只校验其他语言不回显中文源文案。
                if (language !== 'ja-JP') expect(localized, `${language}: ${key}`).not.toBe(source);
                if (language !== 'ja-JP') expect(localized, `${language}: ${key}`).not.toMatch(/[\u3400-\u9fff]/u);
                expect(translate(key, language as keyof typeof catalogs), `${language}: ${key}`).toBe(localized);
            }
        }
        expect(translate('translationStats.charsValue', 'zh-CN', {value: '1,024'})).toBe('1,024 字符');
        expect(translate('translationStats.log.page', 'en-US', {page: 2, pages: 5})).toBe('Page 2 of 5');
    });

    it('翻译统计导航与搜索文案覆盖全部非中文界面语言', () => {
        const item = navigationItems.find((value) => value.id === 'settings-translation-stats')!;
        const sources = [item.label, item.description, item.heading, item.summary, item.kicker, item.title, item.detail, item.searchDescription];
        for (const language of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
            for (const source of sources) {
                const localized = translateLegacyText(source, language);
                expect(localized, `${language}: ${source}`).not.toBe(source);
                if (language !== 'ja-JP') expect(localized, `${language}: ${source}`).not.toMatch(/[\u3400-\u9fff]/u);
            }
        }
        expect(translateLegacyText(item.label, 'en-US')).toBe('Translation statistics');
    });
});
