import {describe, expect, it} from 'vitest';
import posts from './fixtures/chinese-language-posts.json';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {
    detectChineseScript,
    getChineseScript,
    normalizeChineseLanguageCode,
} from '@/src/core/language/chinese';

describe('中文书写体系与语言代码', () => {
    it.each(posts)('截图中的中文评论应跳过简体目标且保留跨语言翻译 %#', (text) => {
        expect(detectChineseScript(text)).toBe('Hans');
        expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(false);
        expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
    });
    it('长中文中的过长或由正文隔开的普通外语词不能合并成技术缩写', () => {
        const context = posts.join('');
        expect(detectChineseScript(`${context} ABCDEFGHIJKLMNOPQRSTUVWXY`)).toBeUndefined();
        expect(detectChineseScript(`${context} OpenAI and GPT`)).toBeUndefined();
        expect(detectChineseScript(`${context} hello中文World`)).toBeUndefined();
    });
    it.each([
        ['zh', 'zh-Hans'],
        [' zh-CN ', 'zh-Hans'],
        ['ZH_sg', 'zh-Hans'],
        ['zh-CHS', 'zh-Hans'],
        ['zh-Hans', 'zh-Hans'],
        ['zh-Hans-TW', 'zh-Hans'],
        ['zh_TW', 'zh-Hant'],
        ['zh-HK', 'zh-Hant'],
        ['zh-MO', 'zh-Hant'],
        ['zh-CHT', 'zh-Hant'],
        ['zh-Hant', 'zh-Hant'],
        ['zh-Hant-CN', 'zh-Hant'],
        ['zh-cmn-Hant-HK', 'zh-Hant'],
        ['zh-CN-extra', 'zh-Hans'],
        ['zh-TW-extra', 'zh-Hant'],
        ['zh-US', 'zh-US'],
        ['zh-Hans-Hant', 'zh-Hans-Hant'],
        ['zh-', 'zh-'],
        [' yue-Hant ', 'yue-Hant'],
        ['cmn', 'cmn'],
        [' en_US ', 'en_US'],
        [' auto ', 'auto'],
        [' ', ''],
    ])('归一别名但保留其他语言或不明确标签 %#', (value, expected) => {
        expect(normalizeChineseLanguageCode(value)).toBe(expected);
    });

    it.each([
        ['zh', 'Hans'],
        ['zh-Hans-HK', 'Hans'],
        ['zh-CHT', 'Hant'],
        ['zh-Hant-SG', 'Hant'],
        ['yue', undefined],
        ['yue-Hant', undefined],
        ['cmn', undefined],
        ['zh-Hans-Hant', undefined],
        ['auto', undefined],
    ])('中文脚本仅来自支持的中文语言码 %#', (value, expected) => {
        expect(getChineseScript(value)).toBe(expected);
    });

    it.each([
        ['简体中文', 'Hans'],
        ['繁體中文', 'Hant'],
        ['这是一个用于中文语言识别的完整句子。', 'Hans'],
        ['這是一個用於中文語言識別的完整句子。', 'Hant'],
        ['你们可以从这个网页读取文字。', 'Hans'],
        ['你們可以從這個網頁讀取文字。', 'Hant'],
        ['欢迎使用简体中文翻译', 'Hans'],
        ['歡迎使用繁體中文翻譯', 'Hant'],
        ['這個佛像可以玩，王后在台上，矽和硅都是元素用字。', 'Hant'],
        ['这是台上的王后，干杯之后回到里屋。', 'Hans'],
        ['這些共享字包括后、干、台、里、云、于、只、余。', 'Hant'],
        [' 這是第 123 個測試。🎉 ', 'Hant'],
        ['这是繁體中文測試', undefined],
        ['这是简体中文測試', undefined],
        ['這是繁體中文测试', undefined],
        ['这里有兩隻貓', undefined],
        ['這裡有两只猫', undefined],
        ['這是繁體中文𫫇', undefined],
        ['这是简体中文𪚥', undefined],
        ['这里有璟', 'Hans'],
        ['深度循环把推理藏起来了。', 'Hans'],
        ['這個軟體能降低運算成本，還能檢查監管風險。', 'Hant'],
        ['这些算法能够减少计算量，也可以提升推理效率。', 'Hans'],
        ['这里的猫可以在花园里跑来跑去。', 'Hans'],
        ['這裡的貓可以在花園裡跑來跑去。', 'Hant'],
        ['技术能力提升以后，OpenAI 还需要持续改进监管。', 'Hans'],
        ['技術能力提升以後，OpenAI 還需要持續改進監管。', 'Hant'],
        ['这些算法使用 AI 和 CoT，可以降低成本并提升推理效率。', 'Hans'],
        ['这个网页可以在 iPhone 上读取所有的内容。', 'Hans'],
        ['这些算法使用 AI，可以降低成本，但是 Please translate this sentence.', undefined],
        ['这些算法可以降低成本，失败信息是 Error。', undefined],
        ['这些算法可以降低成本，同时需要翻译 café。', undefined],
        ['这些算法可以降低成本，同时还有 русский。', undefined],
        ['这些算法可以降低成本，同时还有 한국어。', undefined],
        ['这些算法可以降低成本，同时还有 日本語です。', undefined],
        ['这些算法通过 AIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPIAPI 来测试。', undefined],
        ['中文 AI', undefined],
        ['未来', undefined],
        ['这些共享符号包括々', undefined],
        ['這個網頁包含㐀', 'Hant'],
        ['这里有𫫇', 'Hans'],
        ['这里有𱀀', undefined],
        ['繁體中文 English', undefined],
        ['简体中文 café', undefined],
        ['這裡也有русский', undefined],
        ['今日は良い天気です。', undefined],
        ['あ繁體中文', undefined],
        ['설정 简体中文', undefined],
        ['日本語文章', undefined],
        ['買物', undefined],
        ['写真', undefined],
        ['傷口', undefined],
        ['美麗', undefined],
        ['時間', undefined],
        ['体', undefined],
        ['中文人口', undefined],
        ['云々', undefined],
        ['呢個係繁體嘅廣東話。', undefined],
        ['佢哋話冇問題。', undefined],
        ['这是简体嘅粤语内容。', undefined],
        ['', undefined],
        ['123?! 🎉', undefined],
    ])('仅在中文证据明确且没有冲突时识别字形 %#', (value, expected) => {
        expect(detectChineseScript(value)).toBe(expected);
    });

    it.each(['两', '猫', '数', '软', '𫫇'])('简体冲突字 %s 不得被已有繁体证据掩盖', (character) => {
        expect(detectChineseScript(`這是${character}`)).toBeUndefined();
    });

    it.each(['兩', '隻', '貓', '數', '軟', '𪚥'])('繁体或未知字 %s 不得被已有简体证据掩盖', (character) => {
        expect(detectChineseScript(`这是${character}`)).toBeUndefined();
    });
});
