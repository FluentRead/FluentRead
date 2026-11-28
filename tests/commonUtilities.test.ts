import {afterEach, describe, expect, it, vi} from 'vitest';
import {detectlang, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse} from '@/src/core/translation/resultValidation';
import {throttle} from '@/src/shared/function/throttle';
import {getCenterPoint} from '@/src/shared/geometry/touch';

describe('语义化公共工具', () => {
    afterEach(() => vi.restoreAllMocks());

    it('节流函数保留 this/参数，并在时间窗内拒绝同步重入', () => {
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_099)
            .mockReturnValueOnce(1_100);
        const calls: Array<{owner: string; value: number}> = [];
        let throttled!: (this: {owner: string}, value: number) => void;
        throttled = throttle(function (this: {owner: string}, value: number) {
            calls.push({owner: this.owner, value});
            if (value === 1) throttled.call(this, 2);
        }, 100);
        const receiver = {owner: 'content'};

        throttled.call(receiver, 1);
        throttled.call(receiver, 3);
        throttled.call(receiver, 4);

        expect(calls).toEqual([
            {owner: 'content', value: 1},
            {owner: 'content', value: 4},
        ]);
        expect(now).toHaveBeenCalledTimes(4);
    });

    it('节流首次调用不受时钟起点影响，系统时钟回退后仍可继续提示错误', () => {
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(50)
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(-1_000)
            .mockReturnValueOnce(-950)
            .mockReturnValueOnce(-900);
        const calls: number[] = [];
        const throttled = throttle((value: number) => { calls.push(value); }, 100);
        for (let value = 0; value < 6; value += 1) throttled(value);
        expect(calls).toEqual([0, 2, 3, 5]);
    });

    it.each([
        ['这是一个用于中文语言识别的完整句子。', 'zh-Hans'],
        ['這是一個用於中文語言識別的完整句子。', 'zh-Hant'],
        ['This is a complete English sentence for language detection.', 'en'],
        ['これは言語判定のための十分に長い日本語の文章です。', 'ja'],
        ['이 문장은 언어 감지를 위한 충분히 긴 한국어 문장입니다.', 'ko'],
        ['Cette phrase française est suffisamment longue pour identifier la langue.', 'fr'],
        ['Este programa permite traducir documentos y páginas de internet del español a otros idiomas.', 'es'],
        ['Это достаточно длинное русское предложение для определения языка.', 'ru'],
    ])('把常用 franc 结果映射到产品语言代码 %#', (value, expected) => {
        expect(detectlang(value)).toBe(expected);
    });

    it('未知或不确定语言保持 franc 原始代码', () => {
        expect(detectlang('12345')).toBe('und');
        expect(detectlang('这是繁體中文測試，这是另一段简体中文。')).toBe('cmn');
        expect(detectlang('呢個係繁體嘅廣東話，佢哋話冇問題。')).not.toBe('zh-Hant');
    });

    it.each([
        ['今日は良い天気です。', 'ja', true],
        ['今日は良い天気です。', 'zh-Hans', false],
        ['이 문장은 한국어로 작성되었습니다.', 'ko', true],
        ['이 문장은 한국어로 작성되었습니다.', 'ja', false],
        ['这是中文测试。', 'zh-Hans', true],
        ['这是中文测试。', 'zh-Hant', false],
        ['这是中文测试。', 'zh-TW', false],
        ['繁體中文測試。', 'zh-Hant', true],
        ['繁體中文測試。', 'zh-Hans', false],
        ['繁體中文測試。', 'zh-CN', false],
        ['这是繁體中文測試。', 'zh-Hans', false],
        ['这是繁體中文測試。', 'zh-Hant', false],
        ['这是中文测试。', 'zh', true],
        ['这是中文测试。', 'zh-Hant-CN', false],
        ['繁體中文測試。', 'zh-Hans-TW', false],
        ['这是简体中文測試。', 'zh-Hans', false],
        ['這是繁體中文测试。', 'zh-Hant', false],
        ['这里有兩隻貓', 'zh-Hans', false],
        ['這裡有两只猫', 'zh-Hant', false],
        ['這是繁體中文𫫇', 'zh-Hant', false],
        ['这是简体中文𪚥', 'zh-Hans', false],
        ['繁體中文 English', 'zh-Hant', false],
        ['呢個係繁體嘅廣東話。', 'zh-Hant', false],
        ['繁體中文測試。', 'yue', false],
        ['这是中文测试。', 'ja', false],
        ['日本語文章', 'zh-Hans', false],
        ['日本語文章', 'ja', false],
        ['時間', 'zh-Hant', false],
        ['云々', 'zh-Hans', false],
        ['Bonjour le monde.', 'en', false],
        ['Hallo Welt.', 'en', false],
        ['AI API', 'en', false],
    ] as const)('仅在字符集能明确证明目标语言时跳过 %#', (value, target, expected) => {
        expect(shouldSkipTranslationForTarget(value, target)).toBe(expected);
    });

    it('未知目标或不足以统计判定的文本会 fail-open', () => {
        const longEnglish = 'This is a deliberately long English paragraph with enough alphabetic characters for reliable language detection.';
        const shortEnglish = 'This ordinary English sentence stays below threshold.';

        expect(shouldSkipTranslationForTarget(longEnglish, 'und')).toBe(false);
        expect(shouldSkipTranslationForTarget(longEnglish, 'unknown')).toBe(false);
        expect(detectlang(shortEnglish)).toBe('en');
        expect(shortEnglish.match(/\p{L}/gu)?.length).toBeLessThan(50);
        expect(shouldSkipTranslationForTarget(shortEnglish, 'en')).toBe(false);
    });

    it('只对至少五十个字母且统计语言匹配的长文本跳过', () => {
        const longEnglish = 'This is a deliberately long English paragraph with enough alphabetic characters for reliable language detection.';
        const longFrench = 'Cette phrase française est suffisamment longue pour identifier la langue avec une confiance raisonnable.';

        expect(longEnglish.match(/\p{L}/gu)?.length).toBeGreaterThanOrEqual(50);
        expect(longFrench.match(/\p{L}/gu)?.length).toBeGreaterThanOrEqual(50);
        expect(shouldSkipTranslationForTarget(longEnglish, 'en')).toBe(true);
        expect(shouldSkipTranslationForTarget(longEnglish, 'fr')).toBe(false);
        expect(shouldSkipTranslationForTarget(longFrench, 'fr')).toBe(true);
        expect(shouldSkipTranslationForTarget(longFrench, 'en')).toBe(false);
    });

    it('西班牙语识别支持地区目标并保留短句和跨语言翻译', () => {
        const text = 'Este programa permite traducir documentos y páginas de internet del español a otros idiomas.';
        for (const target of ['es', 'es-ES', 'es-MX']) expect(shouldSkipTranslationForTarget(text, target)).toBe(true);
        for (const target of ['zh-Hans', 'zh-Hant', 'en']) expect(shouldSkipTranslationForTarget(text, target)).toBe(false);
        expect(shouldSkipTranslationForTarget('¿Cómo estás?', 'es')).toBe(false);
    });

    it('日语和韩语目标中的品牌名或代码不会掩盖夹带的外语正文', () => {
        expect(shouldSkipTranslationForTarget('これは OpenAI API を使います。', 'ja-JP')).toBe(true);
        expect(shouldSkipTranslationForTarget('これは https://example.com の説明です。', 'ja-JP')).toBe(true);
        expect(shouldSkipTranslationForTarget('This English paragraph explains the API の仕様。', 'ja-JP')).toBe(false);
        expect(shouldSkipTranslationForTarget('이 문서는 GitHub API를 설명합니다.', 'ko-KR')).toBe(true);
        expect(shouldSkipTranslationForTarget('This foreign prose describes GitHub API 한국어 이름.', 'ko-KR')).toBe(false);
    });

    it('假名或谚文不能把希腊文和西里尔文正文误判为目标语言', () => {
        expect(shouldSkipTranslationForTarget('これは Ελληνικά の説明です。', 'ja-JP')).toBe(false);
        expect(shouldSkipTranslationForTarget('한국어 설명 Русский текст.', 'ko-KR')).toBe(false);
    });

    it('只把明确外语正文和可读英文标签列表的原文回显视为可疑响应', () => {
        const sentence = 'This English sentence still needs a Chinese translation.';
        const tags = 'solo, blush, smile, bangs, looking_at_viewer, long_hair, blue_eyes';
        expect(isLikelyUntranslatedResponse(sentence, ` ${sentence} `, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(tags, tags, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(sentence, '这句英文仍需要翻译。', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse(sentence, sentence, 'en')).toBe(false);
        expect(isLikelyUntranslatedResponse(tags, tags, 'en')).toBe(false);
        expect(isLikelyUntranslatedResponse('', '', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('OpenAI API', 'OpenAI API', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('Frontend Developer', 'Frontend Developer', 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse('Frontend Developer', '前端开发者', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('Software Engineer', 'Software Engineer', 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse('Visual Studio', 'Visual Studio', 'zh-Hans')).toBe(false);
        for (const name of ['Taylor Swift', 'Frank Sinatra', 'Elvis Presley', 'Whitney Houston', 'Mariah Carey', 'Britney Spears', 'Lady Gaga', 'Silicon Valley', 'World Wide Web', 'Human Genome Project']) {
            expect(isLikelyUntranslatedResponse(name, name, 'zh-Hans')).toBe(false);
        }
        expect(isLikelyUntranslatedResponse('Recording Industry Association of America',
            'Recording Industry Association of America', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('Frontend Developer', 'Frontend Developer', 'en')).toBe(false);
        const pullRequestTitle = 'feat: add Google Drive configuration sync';
        expect(isLikelyUntranslatedResponse(pullRequestTitle,
            'feat：add Google Drive configuration sync', 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(pullRequestTitle,
            '功能：新增 Google Drive 配置同步', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('Microsoft Visual Studio Code',
            'Microsoft Visual Studio Code', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('id, status, user_name, updated_at, created_at, action',
            'id, status, user_name, updated_at, created_at, action', 'zh-Hans')).toBe(false);
        expect(isLikelyUntranslatedResponse('a_b, c_d, e_f, g_h, i_j, k_l',
            'a_b, c_d, e_f, g_h, i_j, k_l', 'zh-Hans')).toBe(false);
        const invalidTags = 'a__, b__, c__, d__, e__, f__, Hello';
        expect(isLikelyUntranslatedResponse(invalidTags, invalidTags, 'zh-Hans')).toBe(false);
    });

    it.each([
        ['Division (', '（', true],
        ['Division (', '(', true],
        ['Division ()', '（）', true],
        ['Division', 'DIVISION', true],
        ['Logical NOT (', 'LOGICAL NOT (', true],
        ['Logical NOT ()', 'LOGICAL NOT ()', true],
        ['Logical AND (', 'logical and （', true],
        ['Bitwise XOR (', 'BITWISE XOR (', true],
        ['Subtraction (', '—', true],
        ['Division (', '除法（', false],
        ['Logical NOT (', '逻辑非（', false],
        ['Logical OR (', '逻辑或（', false],
        ['(', '（', false],
        [')', ')', false],
        ['1', '1', false],
        ['OpenAI API', 'OpenAI API', false],
        ['Taylor Swift', 'Taylor Swift', false],
        ['Visual Studio', 'Visual Studio', false],
        ['DivisionService', 'DIVISIONSERVICE', false],
        ['Division.swift', 'Division.swift', false],
        ['Division v2.0', 'Division v2.0', false],
        ['Division()', 'Division()', false],
        ['division()', 'division()', false],
        ['Addition()', 'Addition()', false],
        ['Remainder()', 'Remainder()', false],
        ['Bitwise Xor()', 'Bitwise Xor()', false],
    ] as const)('中文运算符槽 %j -> %j 的丢词/回显判定为 %s', (source, output, rejected) => {
        expect(isLikelyUntranslatedResponse(source, output, 'zh-Hans')).toBe(rejected);
        expect(isLikelyUntranslatedResponse(source, output, 'zh-Hant')).toBe(rejected);
    });

    it.each(['en', 'ja', 'de'])('运算符补充判定不把 %s 目标的大小写差异强制判为漏译', target => {
        expect(isLikelyUntranslatedResponse('Logical NOT (', 'LOGICAL NOT (', target)).toBe(false);
    });

    it('图片中的裸网址与技术标识原样返回是合法结果，网址旁的正文仍须翻译', () => {
        for (const text of ['docs.sglang.io/cookbook', 'https://docs.sglang.io/cookbook', 'SGLang 0.5.21', 'DeepSeek-V4.1 Flash', '—', '1']) {
            expect(isLikelyUntranslatedResponse(text, text, 'zh-Hans')).toBe(false);
        }
        const prose = 'Please read the documentation at docs.sglang.io/cookbook';
        expect(isLikelyUntranslatedResponse(prose, prose, 'zh-Hans')).toBe(true);
    });

    it('中文目标拒绝明确的日文段落，但保留短引用和含日文术语的中文译文', () => {
        const origin = 'There are also restrictions on the first character of this file.';
        const japanese = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
        const mixedQuotedJa = '東京近辺に住んでいたゲーマー女子高生。退屈な日々を送っていたある日、下校中に車に轢かれそうになった彼女は異世界に転移してしまう。以降彼女は"JK勇者(とてもつよい)"と自称している。虫と高いところが苦手。';
        const mixedQuotedJaAsciiPunct = mixedQuotedJa.replaceAll('。', '.').replaceAll('、', ',');
        const mixedSimplifiedJa = mixedQuotedJa.replace('東京', '东京').replace('車', '车').replace('異', '异');
        expect(isClearlyWrongLanguageResponse(origin, japanese, 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(origin, japanese, 'zh-Hant')).toBe(true);
        expect(isClearlyWrongLanguageResponse(origin, japanese, 'ja')).toBe(false);
        expect(isClearlyWrongLanguageResponse(mixedQuotedJa, mixedQuotedJaAsciiPunct, 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(mixedQuotedJa, mixedSimplifiedJa, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(mixedQuotedJa, mixedQuotedJaAsciiPunct, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse('Nagi-chan おはよ〜', 'Nagi-chan おはよ〜', 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse('陵本なぎ', '陵本なぎ', 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse('“ありがとう”这个词表示感谢。', '“ありがとう”这个词表示感谢。', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, '“ありがとう”这个词表示感谢，日文原句是“ありがとうございます”。', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, '她获得了エクスカリバー和マスターソード和ドラゴンボール，随后开启了新的旅程。', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, '日语写作「ありがとう」。', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, 'これは日本語です。', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, 'あ'.repeat(20), 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(origin, 'あ'.repeat(16) + '汉'.repeat(33), 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, '这是中文译文。', 'zh-Hans')).toBe(false);
    });

    it('只为精确数量的非空触摸点计算中心', () => {
        const touches = {
            0: {clientX: 10, clientY: 20},
            1: {clientX: 30, clientY: 60},
            length: 2,
            item: () => null,
        };

        expect(getCenterPoint(touches, 2)).toEqual({x: 20, y: 40});
        expect(getCenterPoint(touches, 3)).toBeUndefined();
        expect(getCenterPoint({length: 0, item: () => null}, 0)).toBeUndefined();
    });
});
