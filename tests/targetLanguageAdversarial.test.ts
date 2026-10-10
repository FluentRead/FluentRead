/**
 * @file tests/targetLanguageAdversarial.test.ts
 * 独立反例检查：名称与目标语言正文不得吞掉外语的否定、引述、标题和短提示；
 * 只调用实际公开识别 API 与展示比较函数，不模拟检测器，也不以主语言占比证明整段。
 */
import {describe, expect, it} from 'vitest';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {hasDistinctTargetTranslation} from '@/src/core/translation/targetResult';

const foreignCases: readonly (readonly [string, string])[] = [
    ['这是中文的错误说明，DO NOT 后面仍然是中文正文。', 'zh-Hans'],
    ['这是中文的错误说明，STOP NOW 后面仍然是中文正文。', 'zh-Hans'],
    ['这是中文的错误说明，“DO NOT”后面仍然是中文正文。', 'zh-Hans'],
    ['这是中文的错误说明，FIVE DOLLARS 后面给出中文报价。', 'zh-Hans'],
    ['这是中文说明，Birds Fly 是一句英文陈述。', 'zh-Hans'],
    ['这是中文说明，Mission Accomplished 是一句英文提示。', 'zh-Hans'],
    ['这是中文说明，Never Again 是一句英文口号。', 'zh-Hans'],
    ['这是中文说明，Safety First 是一句英文口号。', 'zh-Hans'],
    ['这是中文说明，Memory Corrupted 是一句英文提示。', 'zh-Hans'],
    ['这是中文说明："Birds Fly" 是一句英文陈述。', 'zh-Hans'],
    ['这是中文说明。Birds Fly\n后面的中文说明还在继续。', 'zh-Hans'],
    ['这是中文说明。This Is A Complete English Sentence.', 'zh-Hans'],
    ['这是中文说明，Microsoft Edge Is Not Ready 后面保留中文。', 'zh-Hans'],
    ['这是中文说明，Microsoft Edge Was Never Available 后面保留中文。', 'zh-Hans'],
    ['这是中文说明，Chrome Does Not Work 后面保留中文。', 'zh-Hans'],
    ['这是中文说明，No Longer Supported 后面保留中文。', 'zh-Hans'],
    ['这是中文说明，ACCESS DENIED 后面保留中文。', 'zh-Hans'],
    ['这是中文说明，NEW FEATURE 后面给出中文解释。', 'zh-Hans'],
    ['これは日本語の説明です。DO NOT', 'ja'],
    ['これは日本語の説明です。「DO NOT」という英語の説明です。', 'ja'],
    ['これは日本語の説明です。STOP NOW', 'ja'],
    ['이 기능은 원문을 유지합니다. DO NOT', 'ko'],
    ['이 기능은 원문을 유지합니다. "DO NOT"', 'ko'],
    ['Приложение сохраняет исходный текст на странице. DO NOT', 'ru'],
    ['Το κείμενο διατηρείται στη σελίδα. DO NOT', 'el'],
    ['يدعم التطبيق النص الأصلي في الصفحة. DO NOT', 'ar'],
    ['התוסף שומר את הטקסט המקורי בדף. DO NOT', 'he'],
    ['รองรับและแสดงข้อความต้นฉบับในหน้าเว็บ DO NOT', 'th'],
    ['यह ऐप मूल पाठ को सुरक्षित रखता है। DO NOT', 'hi'],
    ['这是中文说明。GPU API DO NOT\n后面的中文说明继续。', 'zh-Hans'],
];

describe('独立反例：外语提示不会被当作名称吞掉', () => {
    it.each(foreignCases)('%s → %s', (source, target) => {
        const identification = identifyTextLanguage(source);
        expect(shouldSkipTranslationForTarget(source, target), JSON.stringify(identification)).toBe(false);
        expect(shouldSkipTranslationForTarget(source, 'und', [target])).toBe(false);
    });
});

describe('独立反例：名称预算与本族正文', () => {
    it.each([
        ['Chrome Firefox Edge Safari Opera Brave 支持', 'zh-Hans'],
        ['Chrome Firefox Edge Safari Opera Brave 対応', 'ja'],
        ['Chrome Firefox Edge Safari Opera Brave 지원', 'ko'],
        ['OpenAI DeepSeek ByteDance Meta Samsung Nvidia AMD 中文', 'zh-Hans'],
        ['OpenAI DeepSeek ByteDance Meta Samsung Nvidia AMD 新增', 'zh-Hans'],
        ['OpenAI DeepSeek ByteDance Meta Samsung Nvidia AMD 增加功能。', 'zh-Hans'],
    ])('仅名称与短片段不足以跳过：%s', (source, target) => {
        expect(shouldSkipTranslationForTarget(source, target)).toBe(false);
    });
    it.each([
        ['扩展已经支持 Chrome 与 Firefox，同时完整保留原文。', 'zh-Hans'],
        ['拡張機能は Chrome と Firefox に対応し、元の文章を保持します。', 'ja'],
        ['이 확장 프로그램은 Chrome 및 Firefox 브라우저를 지원합니다.', 'ko'],
        ['Το πρόγραμμα υποστηρίζει Chrome και Firefox και διατηρεί το αρχικό κείμενο.', 'el'],
    ])('完整本族正文中的名称仍可跳过：%s', (source, target) => {
        expect(shouldSkipTranslationForTarget(source, target)).toBe(true);
    });
});

describe('独立反例：展示兜底保留实质变化', () => {
    it.each([
        ['我们已经完成文档翻译，支持离线阅读。', '我们已经完成文档翻译，不支持离线阅读。', 'zh-Hans'],
        ['这个功能支持 0.10 秒的缓存刷新。', '这个功能支持 0.1 秒的缓存刷新。', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '这个功能支持 52 种语言?!', 'zh-Hans'],
        ['这个功能支持 52 种语言。', '这个功能支持 52 种语言...', 'zh-Hans'],
        ['这个功能支持 x > y 的计算。', '这个功能支持 x < y 的计算。', 'zh-Hans'],
        ['我们已经完成文档翻译，保留原文。', '我们已经完成文档翻译；保留原文。', 'zh-Hans'],
        ['这个功能将字符串“，”用作数据字段的分隔符。', '这个功能将字符串“,”用作数据字段的分隔符。', 'zh-Hans'],
        ['这个功能将字符串“：”用作配置参数的分隔符。', '这个功能将字符串“:”用作配置参数的分隔符。', 'zh-Hans'],
        ['The delimiter in the input text is ",".', 'The delimiter in the input text is "，".', 'en'],
        ['这个功能将 `，` 用作数据字段的分隔符。', '这个功能将 `,` 用作数据字段的分隔符。', 'zh-Hans'],
        ['这个功能将 `“test”` 用作数据字段的默认值。', '这个功能将 `"test"` 用作数据字段的默认值。', 'zh-Hans'],
        ['这是中文的错误说明，DO NOT 后面仍然是中文正文。', '这是中文的错误说明，DO NOT 后面仍然是中文正文', 'zh-Hans'],
        ['Welcome to the settings page.', 'Welcome to the settings page!', 'en'],
        ['This application keeps the original text.', 'This application keeps the original texts.', 'en'],
        ['これは日本語の説明です。', 'これは日本語の説明です？', 'ja'],
        ['이 기능은 원문을 유지합니다.', '이 기능은 원문을 유지하지 않습니다.', 'ko'],
    ])('保留实质变化 %#：%s → %s', (source, translation, target) => {
        expect(hasDistinctTargetTranslation(source, translation, target)).toBe(true);
    });
});
