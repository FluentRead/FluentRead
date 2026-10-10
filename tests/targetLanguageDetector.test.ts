/**
 * @file tests/targetLanguageDetector.test.ts
 * 文件职责：针对中文发布说明和跨文字正文中的名称夹杂验证源头语言识别，覆盖正文与名称的边界、
 * 真实外语句子、目标和排除语言一致性，以及长文本的线性扫描边界；只调用实际纯算法模块。
 */
import {describe, expect, it} from 'vitest';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {createLanguageDetectionCopy} from '@/src/core/language/technicalTokens';
import productionReleaseCases from './fixtures/target-language-releases.json';

const releaseCases = [
    'FluentRead 0.0.34 修复 Microsoft Edge 开发者中心拒绝扩展包的打包兼容问题。',
    '下载说明：Chrome 和 Edge 使用 Chrome ZIP；Firefox ZIP 为未签名构建，用于临时加载或提交签名。另附 Firefox 构建源码和 SHA-256 校验文件。',
    '翻译语言扩展至 52 种，新增多家云翻译与 AI 服务，包括 Doubao-Seed-Translation。',
    '支持时将漫画重运算移入 Worker，提供 GPU 优先与 CPU 回退和限制并发。',
    '新增独立 Thunderbird 邮件翻译、Obsidian 桌面插件及可选的本机 ACP Agent 翻译桥接。',
];

describe('发布说明中的名称不是外语正文', () => {
    it.each([...productionReleaseCases, productionReleaseCases.join('\n')])('生产浏览器逐字发布说明：%s', source => {
        expect(identifyTextLanguage(source)).toMatchObject({status: 'identified', languages: ['zh-Hans']});
        expect(shouldSkipTranslationForTarget(source, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'en', ['zh-Hans'])).toBe(true);
        for (const target of ['en', 'ja', 'ko', 'zh-Hant']) expect(shouldSkipTranslationForTarget(source, target)).toBe(false);
    });
    it.each([...releaseCases, releaseCases.join('\n')])('%s', source => {
        expect(identifyTextLanguage(source)).toMatchObject({status: 'identified', languages: ['zh-Hans']});
        expect(shouldSkipTranslationForTarget(source, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'en', ['zh-Hans'])).toBe(true);
        for (const target of ['en', 'ja', 'ko', 'zh-Hant']) expect(shouldSkipTranslationForTarget(source, target)).toBe(false);
    });
    it.each([
        ['改进 OpenAI、Anthropic 和 DeepSeek 服务的失败提示。', 'zh-Hans'],
        ['修復Chrome瀏覽器中選取文字後工具列位置偏移的問題。', 'zh-Hant'],
        ['修復 OAuth callback 失敗後無法重新登入的問題。', 'zh-Hant'],
        ['請開啟設定頁面，並儲存目前選取的服務。', 'zh-Hant'],
        ['新增「复制原文」按钮，支持保留 `code` 中的完整内容。', 'zh-Hans'],
        ['扩展已经支持 Chrome 与 Firefox，同时完整保留原文。', 'zh-Hans'],
        ['新增字幕驱动的 AetherStream、Echo Room、Vector 网页会议双语字幕。', 'zh-Hans'],
        ['新增 AetherStream Studio、Nimbus Cloud 服务，支持保留原文和逐段翻译。', 'zh-Hans'],
    ])('界面词语与通用技术角色提供中文证据：%s', (source, language) => {
        expect(shouldSkipTranslationForTarget(source, language)).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'en')).toBe(false);
    });
    it('长文本逐句复用有界名称检查，末尾外语提示仍否决整段', () => {
        const source = productionReleaseCases.join('\n').repeat(256);
        expect(source.length).toBeGreaterThan(64_000);
        expect(shouldSkipTranslationForTarget(source, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(source + '\nDO NOT', 'zh-Hans')).toBe(false);
    });
});

describe('名称句架适用于其他非 Latin 文字', () => {
    it.each([
        ['Chrome と Edge に対応した新しい機能を公開しました。', 'ja'],
        ['Microsoft Edge の拡張機能に対応しています。', 'ja'],
        ['Chrome 및 Edge 브라우저에서 새로운 기능을 사용할 수 있습니다.', 'ko'],
        ['Microsoft Edge 확장 프로그램의 호환성을 개선했습니다.', 'ko'],
        ['Этот абзац объясняет, как расширение Microsoft Edge сохраняет исходный текст и показывает перевод прямо под ним.', 'ru'],
        ['Το Microsoft Edge υποστηρίζει την επέκταση και διατηρεί το αρχικό κείμενο.', 'el'],
        ['התוסף תומך בדפדפן Microsoft Edge ושומר את הטקסט המקורי בדף.', 'he'],
        ['รองรับ Microsoft Edge และแสดงข้อความต้นฉบับในหน้าเว็บ', 'th'],
        ['يدعم التطبيق Microsoft Edge ويحافظ على النص الأصلي في الصفحة.', 'ar'],
        ['यह ऐप Microsoft Edge में मूल पाठ को सुरक्षित रखता है और अनुवाद दिखाता है।', 'hi'],
    ])('%s → %s', (source, language) => {
        expect(identifyTextLanguage(source)).toMatchObject({status: 'identified', languages: [language]});
        expect(shouldSkipTranslationForTarget(source, language)).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'und', [language])).toBe(true);
        expect(shouldSkipTranslationForTarget(source, language === 'en' ? 'zh-Hans' : 'en')).toBe(false);
    });
});

describe('短界面操作句架沿用名称证据', () => {
    it.each([
        ['继续使用 Chrome', 'zh-Hans'], ['通过 Aether 继续操作', 'zh-Hans'],
        ['透過 Aether 繼續操作', 'zh-Hant'],
    ])('%s 具有完整操作句架', (source, language) => {
        expect(shouldSkipTranslationForTarget(source, language)).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'en')).toBe(false);
    });
    it.each(['通过 Chrome', '继续使用 Chrome 浏览'])('%s 没有完整短操作句架', source => {
        expect(shouldSkipTranslationForTarget(source, 'zh-Hans')).toBe(false);
    });
});

describe('外语正文和歧义片段继续保留翻译', () => {
    it.each([
        ['这是中文说明。Please Translate This Sentence.', 'zh-Hans'],
        ['这是中文说明，Please Translate This Sentence 后面的说明保留。', 'zh-Hans'],
        ['这是中文说明，请翻译 Microsoft Edge 这个名称。', 'zh-Hans'],
        ['这里的缓存内容需要检查 Public Topic，其中包括英文标题。', 'zh-Hans'],
        ['中文 Chrome', 'zh-Hans'],
        ['Chrome と Edge に対応しています。Please Open The Settings Page.', 'ja'],
        ['이 기능은 Chrome 브라우저를 지원합니다. Please Open The Settings Page.', 'ko'],
        ['Приложение поддерживает Microsoft Edge. Please Open The Settings Page.', 'ru'],
        ['รองรับ Microsoft Edge และต้นฉบับ Please Open The Settings Page.', 'th'],
        ['يدعم التطبيق Microsoft Edge. Please Open The Settings Page.', 'ar'],
        ['Microsoft Edge Is Broken 后面的中文说明仍需保留。', 'zh-Hans'],
        ['Google Cloud Platform Is Ready 后面的中文说明仍需保留。', 'zh-Hans'],
        ['请按照以下英文提示操作：`Restart the browser and try again.`', 'zh-Hans'],
        ['请按照以下英文提示操作：`Please restart the browser; then try again.`', 'zh-Hans'],
        ['请按照以下英文提示操作：`Please choose A or B > continue`', 'zh-Hans'],
        ['请按照以下英文提示操作：`Birds Fly; Safety First.`', 'zh-Hans'],
        ['日本の設定を修復する方法を確認してください。', 'zh-Hans'],
        ['設定修復', 'zh-Hans'],
        ['这些算法支持 Chrome，但失败信息是 Error。', 'zh-Hans'],
        ['这些算法说明 Chrome 是 Error。', 'zh-Hans'],
        ['这个页面列出英文标题 Google Cloud Platform Guide、Teams、Zoom，请保留所有翻译入口。', 'zh-Hans'],
        ['这些内容包括“Birds Fly、Safety First、Memory Corrupted”，请继续提供完整翻译。', 'zh-Hans'],
        ['这些内容包括 Birds Fly、Safety First、Memory Corrupted，是几句英文标题。', 'zh-Hans'],
        ['这些内容包括 Birds Fly、Safety First、Memory Corrupted 是几句英文标题。', 'zh-Hans'],
        ['新增可访问字幕驱动的 Birds Fly、Rivers Flow、Sailors Swim 网页会议双语字幕。', 'zh-Hans'],
        ['以下英文标题 Birds Fly、Teams、Zoom 需要翻译，请保留完整原文。', 'zh-Hans'],
        ['这些内容列出外语标题列表 Rivers Flow、Teams、Zoom 的完整内容。', 'zh-Hans'],
        ['这里列出了 Birds Fly、DO NOT、Safety First 以及其他英文提示。', 'zh-Hans'],
        ['说明 Google Meet、Teams、Zoom', 'zh-Hans'],
        ['这里列出 Aether、Nimbus、Zenith、Orion、Nova、Lumen 名称。', 'zh-Hans'],
        ['下面显示 Google Meet、Teams、Zoom + 之后的内容。', 'zh-Hans'],
    ])('%s 不跳过 %s', (source, language) => {
        expect(shouldSkipTranslationForTarget(source, language)).toBe(false);
        expect(shouldSkipTranslationForTarget(source, 'und', [language])).toBe(false);
    });
});

describe('行内代码结构与自然提示的边界', () => {
    it.each([
        '`browser.runtime`', '`user_name`', '`requestHandler`', '`GPU`', '`code`', '`[]`',
        '`const value = 1;`', '`value = 1`', '`value += 1`', '`{"count": 1}`', '`[value]`', '`<code>`',
        '`fn(value)`', '`await fn(value)`', '`x > y`', '`npm run build --watch`',
    ])('明确代码 %s 不产生外语正文', code => {
        const copy = createLanguageDetectionCopy(code);
        expect(copy.text.trim()).toBe('');
        expect(copy.identifiers).toBeGreaterThan(0);
        expect(shouldSkipTranslationForTarget('新增功能支持保留原始内容 ' + code + '，避免改动网页代码。', 'zh-Hans')).toBe(true);
    });
    it.each([
        '`Please restart the browser; then try again.`', '`Please choose A or B > continue`',
        '`Birds Fly; Safety First.`', '`Please read (or listen) to the complete sentence.`',
        '`Добро пожаловать на наш сайт.`', '`Bonjour et bienvenue sur notre site.`', '`+ Welcome`',
    ])('样式或单个运算标点不遮蔽自然提示 %s', prompt => {
        expect(createLanguageDetectionCopy(prompt).text).toContain(prompt);
        expect(shouldSkipTranslationForTarget('这段中文说明引用外语提示 ' + prompt + '，请保留翻译入口。', 'zh-Hans')).toBe(false);
    });
});
