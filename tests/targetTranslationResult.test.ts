/**
 * @file tests/targetTranslationResult.test.ts
 * 以真实语言识别验证目标语言排版回显兜底，同时保留数字、否定、字形、符号和近似语种的有效变化。
 */
import {describe, expect, it, vi} from 'vitest';
import {hasDistinctTargetTranslation} from '@/src/core/translation/targetResult';

describe('目标语言译文排版回显', () => {
    it('逐字回显不扫描大量代码字面量，内容变化仍保留展示', () => {
        const source = 'Readable `code` example. '.repeat(2000);
        const duplicate: string = JSON.parse(JSON.stringify(source));
        const NativeMap = globalThis.Map;
        let allocations = 0;
        vi.stubGlobal('Map', new Proxy(NativeMap, {
            construct(target, args) {allocations += 1; return Reflect.construct(target, args)},
        }));
        let distinct: boolean;
        try {distinct = hasDistinctTargetTranslation(source, duplicate, 'zh-Hans')}
        finally {vi.unstubAllGlobals()}
        expect(distinct).toBe(false);
        expect(allocations).toBe(0);
        expect(hasDistinctTargetTranslation(source, source.replace('`code`', '`changed`'), 'zh-Hans')).toBe(true);
    });

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
        ['这个功能使用 ``中 文`` 作为数据字段名称。', '这个功能使用 ``中 文`` 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 ```甲`乙``` 作为数据字段名称。', '这个功能使用 ```甲`乙``` 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 «中 文» 作为数据字段名称。', '这个功能使用 «中 文» 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 ‹中 文› 作为数据字段名称。', '这个功能使用 ‹中 文› 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 „中 文“ 作为数据字段名称。', '这个功能使用 „中 文“ 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 ‚中 文‘ 作为数据字段名称。', '这个功能使用 ‚中 文‘ 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用「中 文」作为数据字段名称。', '这个功能使用「中 文」作为数据字段名称', 'zh-Hans'],
        ['这个功能使用『中 文』作为数据字段名称。', '这个功能使用『中 文』作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 ``“中 文”`` 作为数据字段名称。', '这个功能使用 ``“中 文”`` 作为数据字段名称', 'zh-Hans'],
        ['这个功能使用 "``中 文``" 作为数据字段名称。', '这个功能使用 "``中 文``" 作为数据字段名称', 'zh-Hans'],
        ["这个功能使用 'don't中 文' 作为数据字段名称。", "这个功能使用 'don't中 文' 作为数据字段名称。", 'zh-Hans'],
        ['这个功能使用‘don’t中 文’作为数据字段名称。', '这个功能使用‘don’t中 文’作为数据字段名称。', 'zh-Hans'],
        ["L'application est disponible pour les utilisateurs.", "L'application est disponible pour les utilisateurs", 'fr'],
        ['L’application est disponible pour les utilisateurs.', "L'application est disponible pour les utilisateurs", 'fr'],
        ["The readers' settings are available to every user.", "The readers' settings are available to every user", 'en'],
        ["The page explains 'don't stop' and keeps all the settings available for every user.", "The page explains 'don't stop' and keeps all the settings available for every user", 'en'],
        ['The page explains ‘don’t stop’ and keeps all the settings available for every user.', 'The page explains ‘don’t stop’ and keeps all the settings available for every user', 'en'],
        ['这个功能使用 `中 文 作为数据字段名称。', '这个功能使用 `中 文 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用“中 文作为数据字段名称。', '这个功能使用“中 文作为数据字段名称。', 'zh-Hans'],
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
        ['这个功能使用 ``中 文`` 作为数据字段名称。', '这个功能使用 ``中文`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``甲，乙`` 作为数据字段名称。', '这个功能使用 ``甲,乙`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``甲`乙 中 文`` 作为数据字段名称。', '这个功能使用 ``甲`乙 中文`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ```中 文``` 作为数据字段名称。', '这个功能使用 ```中文``` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ````中 文```` 作为数据字段名称。', '这个功能使用 ````中文```` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``é`` 作为数据字段名称。', '这个功能使用 ``e\u0301`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``a\u200bb`` 作为数据字段名称。', '这个功能使用 ``ab`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 `中 文 作为数据字段名称。', '这个功能使用 `中文 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``中 文``` 作为数据字段名称。', '这个功能使用 ``中文``` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用“中 文作为数据字段名称。', '这个功能使用“中文作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用中 文”作为数据字段名称。', '这个功能使用中文”作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 «中 文» 作为数据字段名称。', '这个功能使用 «中文» 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ‹中 文› 作为数据字段名称。', '这个功能使用 ‹中文› 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 „中 文“ 作为数据字段名称。', '这个功能使用 „中文“ 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ‚中 文‘ 作为数据字段名称。', '这个功能使用 ‚中文‘ 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用‘don’t中 文’作为数据字段名称。', '这个功能使用‘don’t中文’作为数据字段名称。', 'zh-Hans'],
        ["这个功能使用 'don't中 文' 作为数据字段名称。", "这个功能使用 'don't中文' 作为数据字段名称。", 'zh-Hans'],
        ['这个功能使用“中“ 文”作为数据字段名称。', '这个功能使用“中“文”作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 ``“中 文”`` 作为数据字段名称。', '这个功能使用 ``“中文”`` 作为数据字段名称。', 'zh-Hans'],
        ['这个功能使用 "``中 文``" 作为数据字段名称。', '这个功能使用 "``中文``" 作为数据字段名称。', 'zh-Hans'],
        ["'中 文'", "'中文'", 'zh-Hans'],
        ["这个功能使用 N'1  2' 作为数据字段名称。", "这个功能使用 N'1 2' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 N'a  b' 作为数据字段名称。", "这个功能使用 N'a b' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 r'中 文' 作为数据字段名称。", "这个功能使用 r'中文' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 b'a\u200bb' 作为数据字段名称。", "这个功能使用 b'ab' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 E'é' 作为数据字段名称。", "这个功能使用 E'e\u0301' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 arbitraryPrefix'甲，乙' 作为数据字段名称。", "这个功能使用 arbitraryPrefix'甲,乙' 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 N'1  2’ 作为数据字段名称。", "这个功能使用 N'1 2’ 作为数据字段名称。", 'zh-Hans'],
        ["这个功能使用 N'中 文 \"内部引号\"' 作为数据字段名称。", "这个功能使用 N'中文 \"内部引号\"' 作为数据字段名称。", 'zh-Hans'],
        ["L'application est disponible pour tous et l'utilisateur peut lire le document.", "L'application est disponible pour tous et l'utilisateur peut lire le document", 'fr'],
    ])('相似但存在实质变化或目标证据不足仍展示 %#', (source, translation, target) => {
        expect(hasDistinctTargetTranslation(source!, translation, target!)).toBe(true);
    });

    it.each([
        `这个功能使用 '${"a'".repeat(50_000)}尾部作为数据字段名称。`,
        '这个功能使用 ' + Array.from({length: 600}, (_, index) => '`'.repeat(index + 1) + 'x').join('') + '作为数据字段名称。',
        '这个功能使用 ``' + '中 文'.repeat(20_000) + ' 作为数据字段名称。',
        '这个功能使用 ' + '""'.repeat(50_000) + '作为数据字段名称。',
        "这个功能使用 prefix'" + "a'".repeat(50_000) + '尾部作为数据字段名称。',
    ])('大引用输入仍保留实值变化且完成扫描 %#', source => {
        expect(hasDistinctTargetTranslation(source, source.replace('作为', '用作'), 'zh-Hans')).toBe(true);
    });
});
