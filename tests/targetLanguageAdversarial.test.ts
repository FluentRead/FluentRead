/**
 * @file tests/targetLanguageAdversarial.test.ts
 * 独立反例检查：名称与目标语言正文不得吞掉外语的否定、引述、标题和短提示；
 * 只调用实际公开识别 API 与展示比较函数，不模拟检测器，也不以主语言占比证明整段。
 */
import {describe, expect, it} from 'vitest';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {hasDistinctTargetTranslation} from '@/src/core/translation/targetResult';
import releases from './fixtures/target-language-releases.json';
import {createLanguageDetectionCopy} from '@/src/core/language/technicalTokens';

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

describe('外语文本语境优先于名称枚举和后缀', () => {
    it.each([
        ['以下列表中的每一项都是英文标题：Birds Fly、Teams、Zoom 都是原文内容。', 'zh-Hans'],
        ['以下列表中的每一项都是外语标题：Birds Fly、Teams、Zoom 都是原文内容。', 'zh-Hans'],
        ['以下这些英语标题 Birds Fly、Teams、Zoom 都是需要翻译的完整原文。', 'zh-Hans'],
        ['以下这些英文题目 Birds Fly、Teams、Zoom 都是需要翻译的完整原文。', 'zh-Hans'],
        ['以下这些英文短句 Birds Fly、Teams、Zoom 都是需要翻译的完整原文。', 'zh-Hans'],
        ['这些内容包括 Birds Fly、Teams、Zoom，是几个需要翻译的英文标题。', 'zh-Hans'],
        ['这些内容包括 Birds Fly、DO NOT、Zoom，后面仍是完整中文说明。', 'zh-Hans'],
        ['新增可访问字幕驱动的 Birds Fly、The Sun、Zoom 网页会议双语字幕。', 'zh-Hans'],
        ['这些内容包括“Birds Fly、Teams、Zoom”，后面仍是完整中文说明。', 'zh-Hans'],
        ['这些内容包括“Birds Fly”、Teams、Zoom，后面仍是完整中文说明。', 'zh-Hans'],
        ['新增字幕功能Google Meet、Teams、Zoom、Slack、Discord、Webex会议。', 'zh-Hans'],
        ['新增可访问字幕驱动的 Google Cloud Platform Guide、Teams、Zoom 网页会议双语字幕。', 'zh-Hans'],
        ['这些内容包括 Aether Nimbus Orison、Mirabelle Willow Summit、Constantine Magnolia Orchard，后面仍是完整中文说明。', 'zh-Hans'],
        ['Google Meet、Teams、Zoom', 'zh-Hans'],
        ['这个页面提供完整中文功能说明。\nGoogle Meet、Teams、Zoom', 'zh-Hans'],
        ['下面显示 Google Meet、Teams、Zoom + 之后的内容。', 'zh-Hans'],
        ['下面是一个需要翻译的英文错误提示：Error+之后仍然是完整中文原文。', 'zh-Hans'],
        ['下面是一个需要翻译的英文错误提示：“Error+”之后仍然是完整中文原文。', 'zh-Hans'],
        ['次の英語タイトル Birds Fly、Teams、Zoom は翻訳する必要があります。', 'ja'],
        ['다음 영어 제목 Birds Fly、Teams、Zoom 은 번역해야 하는 원문입니다.', 'ko'],
        ['这是下面一个英文提示的完整说明：Unknown 的原文仍然需要翻译。', 'zh-Hans'],
        ['这里需要解释：Unknown 的原文仍然需要完整翻译。', 'zh-Hans'],
        ['这些配置中的英文短语 remote adapter 需要安装到 API 服务。', 'zh-Hans'],
        ['這些設定中的外文標題 Birds Fly、Teams、Zoom 仍須提供完整翻譯。', 'zh-Hant'],
        ['英語の見出し Birds Fly、Teams、Zoom は翻訳対象の文章です。', 'ja'],
        ['다음 영문 메시지 Unknown 은 번역해야 하는 원문입니다.', 'ko'],
        ['这些完整原文包含 Birds Fly、Teams、Zoom 它们都是英文标题并且需要翻译。', 'zh-Hans'],
        ['这些完整原文包含 Birds Fly、Teams、Zoom 它们都是英语题目并且需要翻译。', 'zh-Hans'],
        ['这是完整的原文 Error+它是英文错误提示并且需要翻译。', 'zh-Hans'],
        ['この原文には Birds Fly、Teams、Zoom が含まれすべて英語タイトルなので翻訳が必要です。', 'ja'],
        ['이 원문에는 Birds Fly、Teams、Zoom 이 포함되어 모두 영어 제목이며 번역해야 합니다.', 'ko'],
        ['Следующие английские заголовки Birds Fly、Teams、Zoom необходимо перевести на русский язык.', 'ru'],
        ['هذه العناوين الإنجليزية Birds Fly、Teams、Zoom يجب ترجمتها إلى العربية.', 'ar'],
        ['Οι ακόλουθοι αγγλικοί τίτλοι Birds Fly、Teams、Zoom πρέπει να μεταφραστούν στα ελληνικά.', 'el'],
        ['ये अंग्रेज़ी शीर्षक Birds Fly、Teams、Zoom हिंदी में अनुवाद करने के लिए दिए गए हैं।', 'hi'],
        ['Следующий английский заголовок Birds Fly необходимо перевести на русский язык.', 'ru'],
        ['هذا العنوان الإنجليزي Birds Fly يجب ترجمته إلى العربية.', 'ar'],
        ['Ο ακόλουθος αγγλικός τίτλος Birds Fly πρέπει να μεταφραστεί στα ελληνικά.', 'el'],
        ['यह अंग्रेज़ी शीर्षक Birds Fly हिंदी में अनुवाद करने के लिए दिया गया है।', 'hi'],
    ])('明确外语标记、引用或名称预算保留翻译：%s', (source, target) => {
        expect(shouldSkipTranslationForTarget(source, target), JSON.stringify(identifyTextLanguage(source))).toBe(false);
        expect(shouldSkipTranslationForTarget(source, 'und', [target])).toBe(false);
    });

    it.each(releases)('真实发行说明仍在源头跳过：%s', source => {
        expect(shouldSkipTranslationForTarget(source, 'zh-Hans')).toBe(true);
    });

    it.each([
        ['Этот абзац объясняет, как расширение BlueWave Cloud сохраняет исходный текст и показывает перевод прямо под ним.', 'ru'],
        ['Το BlueWave Cloud υποστηρίζει την επέκταση και διατηρεί το αρχικό κείμενο.', 'el'],
        ['يدعم التطبيق BlueWave Cloud ويحافظ على النص الأصلي في الصفحة.', 'ar'],
        ['यह ऐप BlueWave Cloud में मूल पाठ को सुरक्षित रखता है और अनुवाद दिखाता है।', 'hi'],
        ['Το πρόγραμμα υποστηρίζει BlueWave Cloud、Teams、Zoom και διατηρεί το αρχικό κείμενο.', 'el'],
    ])('未覆盖角色标记的文字仍接受独立结构名称：%s', (source, target) => {
        expect(shouldSkipTranslationForTarget(source, target), JSON.stringify(identifyTextLanguage(source))).toBe(true);
    });

    it.each([
        '这里先展示英文标题，新增可访问字幕驱动的 Google Meet、Teams、Zoom 网页会议双语字幕。',
        '这里先展示英文标题。新增可访问字幕驱动的 Google Meet、Teams、Zoom 网页会议双语字幕。',
        '这里先展示英文标题；新增可访问字幕驱动的 Google Meet、Teams、Zoom 网页会议双语字幕。',
        'ここでは英語のタイトルを説明します。アプリは Chrome と Firefox に対応しています。',
        '이 페이지에서 영어 제목을 설명합니다. 이 확장 프로그램은 Chrome 및 Firefox 브라우저를 지원합니다.',
        '新增可访问字幕驱动的 Google Meet、Teams、Zoom 网页会议双语字幕，这里随后解释英文标题。',
        '新增可访问字幕驱动的 Google Meet、Teams、Zoom 网页会议双语字幕。这里随后解释英文标题。',
        'アプリは Chrome と Firefox に対応しています。次に英語タイトルを説明します。',
        '이 확장 프로그램은 Chrome 및 Firefox 브라우저를 지원합니다. 다음에 영어 제목을 설명합니다.',
        'Google Meet、Teams、Zoom 提供英文标题翻译功能并保留完整原文。',
        'アプリの Chrome は英語タイトルを表示して元の文章を保持します。',
        '이 확장 프로그램의 Chrome 은 영어 제목을 표시하며 원문을 보존합니다.',
    ])('已结束的标记不影响后续本族名称正文：%s', source => {
        const target = /\p{Script=Hangul}/u.test(source) ? 'ko' : /\p{Script=Hiragana}/u.test(source) ? 'ja' : 'zh-Hans';
        expect(shouldSkipTranslationForTarget(source, target), JSON.stringify(identifyTextLanguage(source))).toBe(true);
    });
});

describe('合并后技术标识符扫描保持原有边界', () => {
    it('协议候选失败后仍可识别该候选中的 www URL', () => {
        const source = '详见 prefix-www.example.com/path 的说明';
        expect(createLanguageDetectionCopy(source)).toEqual({text: '详见 prefix-  的说明', identifiers: 1, versionedNames: 0});
        expect(source).toContain('www.example.com/path');
    });
    it('Latin 附加字母与过长 ASCII 单词相邻时不会被误当独立厂商前缀', () => {
        const prefix = 'é' + 'AA'.repeat(26);
        expect(createLanguageDetectionCopy(prefix + ' GPT-6')).toEqual({text: prefix + '  ', identifiers: 0, versionedNames: 1});
    });
    it('超过候选上限的连续大写厂商前缀不让内层版本名称独立计权', () => {
        const prefix = 'AA'.repeat(100);
        expect(createLanguageDetectionCopy(prefix + ' GPT-6')).toEqual({text: prefix + '  ', identifiers: 1, versionedNames: 0});
    });
    it('已被版本名称后缀消费的重叠起点不重复计权，也不吞掉后续裸数值', () => {
        const source = 'GPT-6 Sol 2';
        expect(createLanguageDetectionCopy(source)).toEqual({text: '  2', identifiers: 0, versionedNames: 1});
        expect(source).toBe('GPT-6 Sol 2');
    });
});
