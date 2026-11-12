import {describe, expect, it, vi} from 'vitest';
import posts from './fixtures/chinese-language-posts.json';
import modelPost from './fixtures/chinese-language-model-post.json';
import {detectChineseScript, shouldSkipChineseSelection, shouldSkipChineseTargetParagraph, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {getChineseScript, normalizeChineseLanguageCode} from '@/src/core/language/chinese';

describe('中文书写体系与语言代码', () => {
    it('中文标签与配置归一化不初始化正文算法或字符表', async () => {
        vi.resetModules();
        const evaluateText = vi.fn(() => { throw new Error('language tags must not initialize Chinese text detection'); });
        const evaluateVariants = vi.fn(() => { throw new Error('language tags must not initialize Chinese character data'); });
        vi.doMock('@/src/core/language/chineseText', evaluateText);
        vi.doMock('@/src/core/language/chineseVariants', evaluateVariants);
        try {
            const labels = await import('@/src/core/language/chinese');
            const {normalizeConfig} = await import('@/src/core/config/model');
            expect(labels.normalizeChineseLanguageCode(' zh_TW ')).toBe('zh-Hant');
            expect(labels.getChineseScript('ZH-cn')).toBe('Hans');
            const config = normalizeConfig({from: 'zh-TW', to: 'zh_CN'});
            expect(config.from).toBe('zh-Hant');
            expect(config.to).toBe('zh-Hans');
            expect(evaluateText).not.toHaveBeenCalled();
            expect(evaluateVariants).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('@/src/core/language/chineseText');
            vi.doUnmock('@/src/core/language/chineseVariants');
        }
    });

    const releaseNote = '云端模型清单允许清空，且不再连带拒掉无关偏好的保存';
    it.each([releaseNote, `${releaseNote} (84522b3)`])('用户反馈的发布说明有无提交哈希均识别为简体 %#', text => {
        expect(detectChineseScript(text)).toBe('Hans');
        expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(false);
        expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
    });
    it.each([...modelPost, modelPost.join('\n')])('用户反馈的模型公告按段落和整篇跳过简体目标 %#', text => {
        expect(detectChineseScript(text)).toBe('Hans');
        for (const target of ['zh', 'zh-CN', 'zh-Hans']) {
            expect(shouldSkipTranslationForTarget(text, target)).toBe(true);
        }
        expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(false);
        expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
    });
    it.each([
        '请使用 AI 翻译', '新增文档 PDF', '新增 PDF、ePub 功能', '预计推出 GPT-7.1 Nova 模型',
        '清单允许清空 (84522B3)', '清单允许清空 (84522b3ff33401f87da8d5d7c4510ea5453e40ef)',
    ])('短中文语境和结构化技术标识符仍可跳过 %s', text => {
        expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
    });
    it.each(['日本国立大学', '学校教育', '株式会社', '体'])('补充简体字数据不将日文共享字 %s 当成中文', text => {
        expect(detectChineseScript(text)).toBeUndefined();
        expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(false);
        expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(false);
    });
    it('中文词语证据保留简繁区别和中性字形', () => {
        const traditional = '雲端模型清單允許清空，且不再連帶拒掉無關偏好的保存 (84522b3)';
        expect(detectChineseScript(traditional)).toBe('Hant');
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hant')).toBe(true);
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hans')).toBe(false);
        for (const text of ['你好，世界！', '新增功能', '不再保存']) {
            expect(detectChineseScript(text)).toBeUndefined();
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
            expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(true);
        }
    });
    it.each([
        'GPT-6 Sol', '中文 GPT-6 Sol', '预计推出 GPT-6 GPT-7 GPT-8 GPT-9 模型',
        '预计将推出 GPT-6 Sol Please translate this sentence.',
        '预计将推出 GPT-6 Sol ERROR PLEASE RETRY', '预计将推出 GPT-6，Sol 仍需要翻译',
        '预计将推出 GPT-6 模型，Sol 这个词需要翻译',
        '预计将推出 GPT-6 Sol あ', '预计将推出 GPT-6 Sol 한국어',
        '预计将推出 GPT-6 Sol 模型與配置', '预计将推出 GPT-6 Sol 模型嘅',
        '清单允许清空 (84522b3) Please translate this sentence.',
        '清单允许清空 (abcdefa)',
        `预计将推出 ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ-6 Sol 模型`,
    ])('技术名称和哈希不掩盖外语、冲突和不确定文本 %#', text => {
        expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(false);
    });
    // 统一标识符规则：同时含字母和数字的编号（84522b3g、H100）及更长的十六进制摘要都不是任何语言的正文，
    // 不能因为不是严格的 7–40 位提交哈希就让整段中文重新翻译；纯字母伪哈希 abcdefa 仍按外语词处理。
    it.each(['清单允许清空 (84522b3g)', '清单允许清空 (84522b3ff33401f87da8d5d7c4510ea5453e40ef0)', '清单允许清空，适配 H100 显卡'])(
        '字母数字混合编号和长摘要按标识符处理 %#', text => {
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
            expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
        });
    const formatAnnouncement = '新增文档翻译工作台，支持 PDF、ePub、DOCX，以及 HTML、TXT、Markdown、SRT、VTT、ASS/SSA、LRC、JSON 等格式。';
    it('中文格式清单不因保留的格式名称较多而重复请求翻译', () => {
        for (const text of [formatAnnouncement, `✨ 新增功能\n${formatAnnouncement}`, formatAnnouncement.toLowerCase()]) {
            expect(detectChineseScript(text)).toBe('Hans');
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(true);
            expect(shouldSkipTranslationForTarget(text, 'zh-Hant')).toBe(false);
            expect(shouldSkipTranslationForTarget(text, 'en')).toBe(false);
        }
    });
    it('中性字形的中文新增标题无需在简繁目标间重复翻译', () => {
        expect(detectChineseScript('✨ 新增功能')).toBeUndefined();
        for (const target of ['zh-Hans', 'zh-Hant']) {
            expect(shouldSkipTranslationForTarget('✨ 新增功能', target)).toBe(true);
            expect(shouldSkipTranslationForTarget('新增 PDF、ePub 功能', target)).toBe(true);
        }
        expect(shouldSkipTranslationForTarget('✨ 新增功能', 'en')).toBe(false);
    });
    it('格式名称不掩盖外语正文、简繁冲突或未知字形', () => {
        for (const suffix of [' Please translate this sentence.', ' ERROR PLEASE RETRY', ' 日本語です。', ' 한국어', ' café', ' русский', ' 與', ' 𱀀']) {
            expect(shouldSkipTranslationForTarget(formatAnnouncement + suffix, 'zh-Hans')).toBe(false);
        }
        for (const text of ['新增機能', '新增功能 English', '新增功能あ', '新增功能嘅', '新增功能𱀀', 'PDF、ePub、DOCX、Markdown']) {
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(false);
        }
        const traditional = '新增文件翻譯工作台，支援 PDF、ePub、DOCX，以及 HTML、TXT、Markdown、SRT、VTT、ASS/SSA、LRC、JSON 等格式。';
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hant')).toBe(true);
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hans')).toBe(false);
    });
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

describe('划词和翻译卡片的纯中文选区', () => {
    it.each(['你好', '人', '中文人口', '未来', '你好，世界！123 🎉', '繁體中文', '这是繁體混排', '𱀀', '你好 👨‍👩‍👧‍👦'])('中文目标下跳过 %s', text => {
        for (const target of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant']) {
            expect(shouldSkipChineseSelection(text, target)).toBe(true);
        }
        expect(shouldSkipChineseSelection(text, 'en')).toBe(false);
        expect(shouldSkipChineseSelection(text, 'ja')).toBe(false);
    });
    it.each(['', '123！🎉', 'Hello', '中文 English', '中文 AI', '你好 café', '你好 русский', '你好 한국어', '今日は良い天気です。', '中文あ'])('保留非纯中文或无汉字选区 %s', text => {
        expect(shouldSkipChineseSelection(text, 'zh-CN')).toBe(false);
    });
});


describe('网页翻译排除语言', () => {
    it('简繁分别选择，清空列表后仍允许简繁转换', () => {
        const traditional = '這個軟體讀取文件並翻譯這個頁面上的語言。';
        const simplified = '这个软件读取文档并翻译这个页面上的语言。';
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hans', ['zh-Hant'])).toBe(true);
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hans', [])).toBe(false);
        expect(shouldSkipTranslationForTarget(traditional, 'en', ['zh-Hans'])).toBe(false);
        expect(shouldSkipTranslationForTarget(simplified, 'en', ['zh-Hant'])).toBe(false);
        for (const text of [traditional, simplified]) {
            expect(shouldSkipTranslationForTarget(text, 'en', ['zh-Hans', 'zh-Hant'])).toBe(true);
        }
    });
    it('多选只跳过已识别的语言，未知短句和外语混排继续翻译', () => {
        const selected = ['zh-Hant', 'ja', 'fr', 'de'];
        for (const text of ['これは日本語の説明です。',
            'Cette phrase française est suffisamment longue pour identifier la langue avec une confiance raisonnable.',
            'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.']) {
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans', selected)).toBe(true);
        }
        for (const text of ['This is a deliberately long English paragraph with enough alphabetic characters for reliable language detection.',
            'Bonjour', '日本語', '這個頁面 Please translate this sentence.', '这是繁體中文測試。']) {
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans', selected)).toBe(false);
        }
        expect(shouldSkipTranslationForTarget('한국어 설명입니다.', 'zh-Hans', ['ko'])).toBe(true);
        expect(shouldSkipTranslationForTarget('This is a deliberately long English paragraph with enough alphabetic characters for reliable language detection.', 'und', ['en'])).toBe(true);
    });
});

describe('全文翻译的中文目标段落预检', () => {
    it.each([
        // 识别为混合或未知的中文正文段落：八个以上汉字夹英文术语、链接、代码、版权行与英文句子。
        '在 Vue 3 中，组合式 API（Composition API）让逻辑复用变得更加自然。与 Options API 不同，你可以把相关逻辑放在一起。',
        '在终端中运行以下命令即可完成安装：npm install -g pnpm，然后执行 pnpm install 安装依赖。整个过程大约需要 30 秒。',
        'Copyright © 2024 某某博客 保留所有权利',
        '价格：免费 | 语言：中文 | 平台：Windows / macOS / Linux',
        '这是中文段落。This is a full English sentence embedded in it. 这句又是中文。',
        '这些算法使用 AI，可以降低成本，但是 Please translate this sentence.',
    ])('中文目标的混合与未知正文段落不再翻译 %#', text => {
        expect(shouldSkipChineseTargetParagraph(text, 'zh-Hans')).toBe(true);
        expect(shouldSkipChineseTargetParagraph(text, 'zh-CN')).toBe(true);
    });

    it.each([
        ['在 Vue 3 中，组合式 API 让逻辑复用变得更加自然。', 'en'],
        ['Hello world, this is a plain English paragraph.', 'zh-Hans'],
        ['123?! 🎉', 'zh-Hans'],
        ['中', 'zh-Hans'],
        // 八字阈值之下保持 fail-open：短词可能是日文汉字、繁体短语或界面残片。
        ['—— 本文完 ——', 'zh-Hans'],
        ['转载请注明出处。', 'zh-Hans'],
        ['時間', 'zh-Hans'],
        ['日本国立大学', 'zh-Hans'],
        ['趨勢', 'zh-Hans'],
        // 假名或谚文正文不跳过：日文、韩文段落仍需翻译。
        ['今日は良い天気です。', 'zh-Hans'],
        ['한국어 설명입니다.', 'zh-Hans'],
        ['この文章には漢字が含まれていますが、かな文字があるため翻訳を続けます。', 'zh-Hans'],
        // 与目标书写体系相反的简繁字形保留简繁转换。
        ['这是简体中文段落，可以转换为繁体。', 'zh-Hant'],
        ['這是繁體中文段落，可以轉換為簡體。', 'zh-Hans'],
    ])('不满足段落跳过条件时继续翻译 %s -> %s', (text, target) => {
        expect(shouldSkipChineseTargetParagraph(text, target)).toBe(false);
    });

    it('简繁体系与目标一致时跳过，八字同形与中性字段落对两目标都跳过', () => {
        expect(shouldSkipChineseTargetParagraph('这是简体中文段落。', 'zh-Hans')).toBe(true);
        expect(shouldSkipChineseTargetParagraph('這是繁體中文段落。', 'zh-Hant')).toBe(true);
        expect(shouldSkipChineseTargetParagraph('本文完整段落保留原文。', 'zh-Hans')).toBe(true);
        expect(shouldSkipChineseTargetParagraph('本文完整段落保留原文。', 'zh-Hant')).toBe(true);
        // 非中文目标不受段落规则影响。
        expect(shouldSkipChineseTargetParagraph('这是简体中文段落。', 'ja')).toBe(false);
        expect(shouldSkipChineseTargetParagraph('', 'zh-Hans')).toBe(false);
    });
});
