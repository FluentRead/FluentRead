/**
 * @file tests/targetTranslationResult.test.ts
 * 以真实语言识别验证目标语言排版回显兜底，同时保留数字、否定、字形、符号和近似语种的有效变化。
 */
import {describe, expect, it} from 'vitest';
import {hasDistinctTargetTranslation} from '@/src/core/translation/targetResult';

describe('目标语言译文排版回显', () => {
    it.each([
        ['我们已经完成文档翻译，支持离线阅读。', '我们已经完成文档翻译,支持离线阅读', 'zh-Hans'],
        ['這個軟體讀取文件並翻譯這個頁面上的語言。', '這 個 軟 體 讀 取 文 件 並 翻 譯 這 個 頁 面 上 的 語 言.', 'zh-Hant'],
        ['これは日本語の説明です。', 'これは日本語の説明です', 'ja'],
        ['Welcome to the settings page.', 'Welcome to the settings page', 'en'],
        ['Bonjour et bienvenue sur notre site.', 'Bonjour et bienvenue sur notre site', 'fr'],
        ['Добро пожаловать на наш сайт.', 'Добро пожаловать на наш сайт', 'ru'],
        ['这个页面提供“翻译”功能，支持本地阅读。', '这个页面提供"翻译"功能, 支持本地阅读.', 'zh-Hans'],
        ['我们已经完成文档翻译。', '我们已经完成文档翻译。\u200b', 'zh-Hans'],
        ['我们已经完成文档翻译。', undefined, 'zh-Hans'],
        [String.raw`这个功能使用 "a\"  b" 作为数据字段名称。`, String.raw`这个功能使用 "a\"  b" 作为数据字段名称。`, 'zh-Hans'],
    ])('仅排版回显保留原文 %#', (source, translation, target) => {
        expect(hasDistinctTargetTranslation(source!, translation, target!)).toBe(false);
    });
    it.each([
        ['123', '124', 'zh-Hans'],
        [String.raw`这个功能使用 "a\"  b" 作为数据字段名称。`, String.raw`这个功能使用 "a\" b" 作为数据字段名称。`, 'zh-Hans'],
        [String.raw`这个功能使用 "a\"` + '\u200bb" 作为数据字段名称。', String.raw`这个功能使用 "a\"b" 作为数据字段名称。`, 'zh-Hans'],
        [String.raw`这个功能使用 "a\"é" 作为数据字段名称。`, String.raw`这个功能使用 "a\"` + 'e\u0301" 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 "a b" 作为数据字段名称。', String.raw`这个功能使用 "a\" b" 作为数据字段名称。`, 'zh-Hans'],
        ['这个功能将字符串“1  2”用作数据字段的分隔符。', '这个功能将字符串“1 2”用作数据字段的分隔符。', 'zh-Hans'],
        ['这个功能使用 `a\u200bb` 作为数据字段名称。', '这个功能使用 `ab` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用“é”作为数据字段名称。', '这个功能使用“e\u0301”作为数据字段名称。', 'zh-Hans'],
        ['我们已经完成文档翻译。', '我们还没有完成文档翻译。', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '这个功能支持 53 种语言。', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '这个功能支持 52 种语言？', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '这个功能支持 52 种语言！', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '這個功能支援 52 種語言。', 'zh-Hant'],
        ['Welcome to the settings page.', 'Welcome to the settings page', 'de'],
        ['Bienvenido a nuestro sitio web.', 'Bienvenido a nuestro sitio web', 'pt'],
        ['我們已經完成文件翻譯。', '我们已经完成文档翻译。', 'zh-Hans'],
        ['我们已经完成文档翻译，支持离线阅读。', '我们已经完成文档翻译支持离线阅读', 'zh-Hans'],
        ['这个页面支持 x+y 的计算和显示。', '这个页面支持 x-y 的计算和显示。', 'zh-Hans'],
        ['This page explains how the application uses API keys.', 'This page explains how the application uses api keys.', 'en'],
        ['The value is 1.2 and the setting is enabled.', 'The value is 12 and the setting is enabled.', 'en'],
        ['The settings are available for every user.', 'Thesettings are available for every user.', 'en'],
        ['日本国立大学', '日本国立大学。', 'zh-Hans'],
    ])('相似但存在实质变化或目标证据不足仍展示 %#', (source, translation, target) => {
        expect(hasDistinctTargetTranslation(source!, translation, target!)).toBe(true);
    });
});
