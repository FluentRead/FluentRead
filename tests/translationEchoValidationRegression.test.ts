/**
 * @file tests/translationEchoValidationRegression.test.ts
 * 文件职责：用公开短句及正文夹具验证回显、明确 Latin 错语种门禁和真实 broker 的恢复、失败及缓存边界。
 * 主要内容：覆盖既有外语证据、分词边界、专名/技术标识、同目标语言、简繁和真实字词差异；以实际波兰语损坏结果验证保守长段校验，并经真实 broker 验证一次重试、逐槽恢复与缓存拒绝。
 * 模块边界：不运行浏览器、不调用网络或真实存储；只替换配置存储与纯槽协议出口，不修改语言识别或展示比较规则。
 */
import {describe, expect, it, vi} from 'vitest';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse, isUnchangedTranslationResponse} from '@/src/core/translation/resultValidation';
import {allowUnchangedTranslationResult} from '@/src/services/translation/requestSnapshot';
import {createTranslationBroker} from '@/src/services/translation/broker';
import type {TranslationConfigSource, TranslationProvider} from '@/src/services/translation/types';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import observedResidue from './fixtures/translation-quality/observed-ar-fr-residue.json';

vi.mock('@/src/services/config/store', () => ({config: {}}));
vi.mock('@/src/core/translation/public', () => import('@/src/core/translation/slotProtocol'));

// 只保留公开帖子的一段短句摘录；长正文独立编写，数字是测试数据。
// https://x.com/thsottiaux/status/2107913674593644711
const corpusSentence = 'This test reports a high count of 40M active sample readers in GPT-6, but all numbers are fictional and describe fixture data.';
const oembedClosing = "Loading a banked reset in everyone's paid accounts. See you again tomorrow!";
const corpusText = 'Test excerpt/\n\n' + corpusSentence + '\n\n' + oembedClosing + ' https://example.test/fixture';
const chineseTranslation = '这个测试虚构了 GPT-6 和四千万活跃读者的数字，只用于验证翻译。';

const echoVariants = [
    ['末尾增加标点', corpusSentence, corpusSentence + '!'],
    ['末尾替换标点', corpusSentence, corpusSentence.replace(/\.$/u, '!?')],
    ['标点形成分词边界', corpusSentence, corpusSentence.replace(', but', ' — but')],
    ['移除逗号但保留词边界', corpusSentence, corpusSentence.replace(', but', ' but')],
    ['引号包装', corpusSentence, '“' + corpusSentence + '”'],
    ['末尾 U+200B', corpusSentence, corpusSentence + '\u200b'],
    ['词内 U+200B', corpusSentence, corpusSentence.replace('active', 'ac\u200btive')],
    ['U+200B 和末尾标点', corpusSentence, corpusSentence + '\u200b!?'],
    ['完整多段夹具 U+200B', corpusText, corpusText + '\u200b'],
    ['完整多段夹具标点', corpusText, corpusText + '!'],
    ['保留撇号词边界', oembedClosing, oembedClosing + '.'],
    ['既有短职业标题证据', 'Frontend Developer', 'Frontend Developer!'],
    ['既有标签列表证据', 'solo, blush, smile, bangs, looking_at_viewer, long_hair, blue_eyes',
        'solo; blush; smile; bangs; looking_at_viewer; long_hair; blue_eyes!'],
] as const;

const acceptedCases = [
    ['两个词的人名', 'Taylor Swift', 'Taylor Swift!'],
    ['两个词的品牌', 'Visual Studio', 'Visual Studio\u200b'],
    ['纯技术名称', 'OpenAI API', 'OpenAI API!'],
    ['多词技术名称', 'Microsoft Visual Studio Code', 'Microsoft Visual Studio Code!'],
    ['多词专名', 'World Wide Web', 'World Wide Web\u200b'],
    ['模型编号', 'GPT-6', 'GPT-6!'],
    ['版本编号', 'SGLang 0.5.21', 'SGLang 0.5.21\u200b'],
    ['标识符列表', 'id, status, user_name, updated_at, created_at, action',
        'id; status; user_name; updated_at; created_at; action!'],
    ['裸网址', 'https://docs.sglang.io/cookbook', 'https://docs.sglang.io/cookbook\u200b'],
    ['纯符号', '—', '—!?'],
    ['纯数字', '123', '123!'],
    ['空原文', '', '\u200b!'],
    ['短文本仍无外语证据', 'Day 3/', 'Day 3/!'],
    ['可信中文同目标', '今天已经更新了功能，可以开始使用。', '今天已经更新了功能，可以开始使用！'],
    ['中文同目标含品牌', '今天发布了 GPT-6，新功能可以在 Codex 中使用。', '今天发布了 GPT-6，新功能可以在 Codex 中使用！'],
    ['中文真实改写', '今天已经更新了功能，可以开始使用。', '今天功能已经更新，可以开始使用。'],
    ['简体转繁体', '允许清空设置，并保留用户的原始文字。', '允許清空設定，並保留使用者的原始文字。'],
    ['繁体转简体', '允許清空設定，並保留使用者的原始文字。', '允许清空设置，并保留用户的原始文字。'],
    ['真实中文译文', corpusSentence, chineseTranslation],
    ['替换一个英文词', corpusSentence, corpusSentence.replace('high', 'peak')],
    ['改变数字内容', corpusSentence, corpusSentence.replace('40M', '41M')],
    ['不折叠大小写', corpusSentence, corpusSentence.toLowerCase()],
    ['连字符不能拼接字词', 'We will re-sign the agreement after we read every sentence.',
        'We will resign the agreement after we read every sentence.'],
    ['删除分词标点不能连接内容', 'Please read alpha,beta before you start the application.',
        'Please read alphabeta before you start the application.'],
    ['运算符不能被忽略', 'Read the C++ guide before you start the application.',
        'Read the C guide before you start the application.'],
    ['乘法和除法不能折叠', 'Please read a*b before you start the application.',
        'Please read a/b before you start the application.'],
    ['标识符不能丢下划线', 'Please read user_name before you start the application.',
        'Please read user name before you start the application.'],
    ['减法不能被当作逗号', 'Please read a-b before you start the application.',
        'Please read a,b before you start the application.'],
    ['不能移除逻辑否定', 'Please check !flag before you start the application.',
        'Please check flag before you start the application.'],
    ['不等号不能变成赋值', 'Please check value != expected before you start the application.',
        'Please check value = expected before you start the application.'],
    ['不能移除可选链', 'Please check settings?.value before you start the application.',
        'Please check settings.value before you start the application.'],
    ['三元运算符不能被移除', 'Please check x ? y : z before you start the application.',
        'Please check x y z before you start the application.'],
    ['三元表达式不能移除冒号', 'Please check x ? y : z before you start the application.',
        'Please check x ? y z before you start the application.'],
    ['保留重音内容', 'Please read the Café guide before you start the application.',
        'Please read the Cafe guide before you start the application.'],
    ['不移除 ZWJ', corpusSentence, corpusSentence.replace('active', 'ac\u200dtive')],
    ['不移除 ZWNJ', corpusSentence, corpusSentence.replace('active', 'ac\u200ctive')],
    ['不泛化错语种', corpusSentence, 'これは日本語です。'],
] as const;

function createHarness(targetLanguage = 'zh-Hans') {
    const config: TranslationConfigSource = {
        service: 'mock', from: 'auto', to: targetLanguage, useCache: true, enableAIContext: false,
        model: {mock: 'mock-model'}, customModel: {}, proxy: {}, custom: '', deeplx: '', newApiUrl: '',
        minimaxBillingPlan: 'payg', minimaxRegion: 'cn', mimoBillingPlan: 'payg', mimoRegion: 'cn',
        azureOpenaiEndpoint: '', customBody: {}, system_role: {}, user_role: {},
        deepseekApiType: 'auto', deepseekThinkingMode: 'disabled',
    };
    const provider = vi.fn<TranslationProvider>();
    const store = new Map<string, string>();
    const cacheGet = vi.fn(async (key: string) => store.get(key) ?? null);
    const cacheSet = vi.fn(async (key: string, translation: string) => {
        store.set(key, translation);
        return true;
    });
    const broker = createTranslationBroker({
        ready: Promise.resolve(),
        getConfig: () => config,
        providers: {mock: provider},
        cache: {get: cacheGet, set: cacheSet, clear: async () => { store.clear(); }, cleanup: async () => undefined},
        serviceTypes: {machine: new Set(['mock']), isAI: () => false, isAiSdk: () => false, isUseAIContext: () => false},
        endpointResolver: {
            resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://unused.example.test'}),
            aiSdkTransportProfile: 'unused',
        },
        promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: overrides => resolveTranslationLanguages(overrides, {sourceLanguage: 'auto', targetLanguage}),
        resolveConfiguredModel: (selected, custom) => custom || selected || '',
        buildTranslationCacheKey: identity => JSON.stringify(identity),
    });
    return {broker, provider, store, cacheGet, cacheSet};
}

describe('保守回显比较沿用原文已有的外语证据', () => {
    it('图片的明确同文只规范空白，普通翻译仍拒绝可信外语原文', () => {
        expect(isUnchangedTranslationResponse(corpusSentence, `  ${corpusSentence}  `)).toBe(true);
        expect(isLikelyUntranslatedResponse(corpusSentence, `  ${corpusSentence}  `, 'zh-Hans')).toBe(true);
    });
    it.each(echoVariants)('%s 的原文包装仍被图片策略接受，首次成功并缓存', async (_label, origin, result) => {
        expect(isUnchangedTranslationResponse(origin, result)).toBe(true);
        const harness = createHarness(); harness.provider.mockResolvedValue(result);
        await expect(harness.broker.translateWithCache(allowUnchangedTranslationResult({origin}))).resolves.toBe(result);
        await expect(harness.broker.translateWithCache(allowUnchangedTranslationResult({origin}))).resolves.toBe(result);
        expect(harness.provider).toHaveBeenCalledOnce();
    });

    it.each([['', ''], ['Text', ' '], ['\u200b', ''], ['!', '?'], ['Addition (', ')'], ['C++', 'C']])(
        '空白、仅有包装或字词变化不能冒充图片原样成功：%j → %j', (origin, result) => {
            expect(isUnchangedTranslationResponse(origin, result)).toBe(false);
        },
    );
    it.each(echoVariants)('%s 只变边界或 U+200B 时拒绝回显', (_label, origin, result) => {
        // 对照证明新增比较没有引入新的外语识别规则。
        expect(isLikelyUntranslatedResponse(origin, origin, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(origin, result, 'zh-Hans')).toBe(true);
        expect(isLikelyUntranslatedResponse(origin, result, 'zh-Hant')).toBe(true);
    });

    it.each(acceptedCases)('%s 不被扩大回显比较误拒绝', (_label, origin, result) => {
        expect(isLikelyUntranslatedResponse(origin, result, 'zh-Hans')).toBe(false);
    });

    it.each(['en', 'en-US', 'en-Latn'])('可信英文同目标 %s 允许原样词字加标点/U+200B', target => {
        expect(isLikelyUntranslatedResponse(corpusSentence, corpusSentence + '\u200b!', target)).toBe(false);
    });

    it('可信非中文同目标保持原有语言判断', () => {
        const german = 'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.';
        expect(isLikelyUntranslatedResponse(german, german + '!', 'de')).toBe(false);
    });
});

describe('真实 broker 入口拒绝回显并保护内存缓存', () => {
    it.each(echoVariants)('%s 连续回显沿 UNTRANSLATED_RESPONSE 失败且不写缓存', async (_label, origin, result) => {
        const harness = createHarness();
        harness.provider.mockResolvedValue(result);
        await expect(harness.broker.translateWithCache({origin})).rejects.toMatchObject({
            kind: 'response', code: 'UNTRANSLATED_RESPONSE', retryable: false,
        });
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.cacheSet).not.toHaveBeenCalled();
        expect(harness.store.size).toBe(0);
    });

    it.each(['!', '\u200b'])('旧缓存中的 %j 回显不能命中，持续回显仍失败且不新增缓存', async suffix => {
        const harness = createHarness();
        harness.cacheGet.mockResolvedValueOnce(corpusSentence + suffix);
        harness.provider.mockResolvedValue(corpusSentence + suffix);
        await expect(harness.broker.translateWithCache({origin: corpusSentence})).rejects.toMatchObject({
            code: 'UNTRANSLATED_RESPONSE',
        });
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.cacheSet).not.toHaveBeenCalled();
    });

    it('一次回显后恢复真实译文，只缓存成功译文并允许下一次复用', async () => {
        const harness = createHarness();
        harness.provider.mockResolvedValueOnce(corpusSentence + '\u200b!').mockResolvedValueOnce(chineseTranslation);
        await expect(harness.broker.translateWithCache({origin: corpusSentence})).resolves.toBe(chineseTranslation);
        await expect(harness.broker.translateWithCache({origin: corpusSentence})).resolves.toBe(chineseTranslation);
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.cacheSet).toHaveBeenCalledOnce();
        expect([...harness.store.values()]).toEqual([chineseTranslation]);
    });

    it('旧回显缓存重新请求成功后只写入真实译文', async () => {
        const harness = createHarness();
        harness.cacheGet.mockResolvedValueOnce(corpusSentence + '\u200b');
        harness.provider.mockResolvedValue(chineseTranslation);
        await expect(harness.broker.translateWithCache({origin: corpusSentence})).resolves.toBe(chineseTranslation);
        expect(harness.provider).toHaveBeenCalledOnce();
        expect([...harness.store.values()]).toEqual([chineseTranslation]);
    });

    it('普通批量逐槽恢复也拒绝持续回显，不把该批次写入缓存', async () => {
        const harness = createHarness();
        const echo = corpusSentence + '\u200b!';
        harness.provider.mockResolvedValueOnce([echo, '中文']).mockResolvedValueOnce(echo);
        await expect(harness.broker.translateWithCache({origin: [corpusSentence, '中文']})).rejects.toMatchObject({
            code: 'UNTRANSLATED_RESPONSE',
        });
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.provider.mock.calls[1][0]).toMatchObject({origin: corpusSentence});
        expect(harness.cacheSet).not.toHaveBeenCalled();
    });

    it('关闭缓存仍经过已有回显恢复线路', async () => {
        const harness = createHarness();
        harness.provider.mockResolvedValue(corpusSentence + '!');
        await expect(harness.broker.translateWithCache({origin: corpusSentence, useCache: false})).rejects.toMatchObject({
            code: 'UNTRANSLATED_RESPONSE',
        });
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.cacheGet).not.toHaveBeenCalled();
        expect(harness.cacheSet).not.toHaveBeenCalled();
    });

    it.each([
        ['纯人名', 'Taylor Swift', 'Taylor Swift!', 'zh-Hans'],
        ['纯技术标识', 'OpenAI API', 'OpenAI API\u200b', 'zh-Hans'],
        ['可信同目标', corpusSentence, corpusSentence + '\u200b!', 'en'],
        ['真实不同字词', corpusSentence, chineseTranslation, 'zh-Hans'],
        ['简繁转换', '允许清空设置，并保留用户的原始文字。', '允許清空設定，並保留使用者的原始文字。', 'zh-Hant'],
    ])('%s 仍可成功、写缓存并复用', async (_label, origin, result, target) => {
        const harness = createHarness(target);
        harness.provider.mockResolvedValue(result);
        await expect(harness.broker.translateWithCache({origin})).resolves.toBe(result);
        await expect(harness.broker.translateWithCache({origin})).resolves.toBe(result);
        expect(harness.provider).toHaveBeenCalledOnce();
        expect(harness.cacheSet).toHaveBeenCalledOnce();
        expect([...harness.store.values()]).toEqual([result]);
    });
});


describe('中文目标下明确 Latin 错语种结果', () => {
    const polishSource = 'Osobne działko laserowe o ogromnej mocy: zabija jednym strzałem, strzela co 1,5 s, zasięg 34, niebieski promień, bardzo duży pobór prądu.';
    const corruptPolishResult = 'Osobne dzia😍ko laserowe o ogromnej mocy：zabija jednym strza😍em，strzela co 1,5 s，zasig 34，niebieski promie😍，bardzo du😍y pobór pr😍du。';
    const english = 'The software translates every complete paragraph and keeps all reader settings available after a restart.';
    const french = 'Le logiciel traduit chaque paragraphe et conserve les paramètres de lecture pour tous les utilisateurs après un redémarrage.';
    const chinese = '独立的高功率激光炮，一击即可消灭目标，每隔一点五秒发射一次，射程三十四，蓝色光束，耗电量非常大。';
    const japanese = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
    it.each(['zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW'])('rejects actual changed-Latin Factorio response for %s using actual identification', target => {
        expect(identifyTextLanguage(polishSource)).toMatchObject({ status: 'identified', languages: ['pl'] });
        expect(identifyTextLanguage(corruptPolishResult)).toMatchObject({ status: 'identified', languages: ['pl'] });
        expect(isLikelyUntranslatedResponse(polishSource, corruptPolishResult, target)).toBe(false);
        expect(isClearlyWrongLanguageResponse(polishSource, corruptPolishResult, target)).toBe(true);
    });
    it.each([polishSource.replace('34', '35'), english, french])('rejects credible substantial Latin prose without depending on emoji %#', result => {
        expect(isClearlyWrongLanguageResponse(polishSource, result, 'zh-Hans')).toBe(true);
    });
    it.each([
        [polishSource, chinese], [polishSource, chinese + ' 😍😍😍😍😍'],
        [english, '这个功能支持 Microsoft Visual Studio Code 和 GitHub Copilot，阅读后仍保留全部设置。'],
        [english, '中文说明中引用 “The software translates every complete paragraph and keeps all reader settings available after a restart.”'],
        [english, 'CPU GPU API SQL HTTP JSON SVG PNG'],
        [english, 'Mary Jane'], [english, 'International Society for Technology Innovation Management and Research'],
        [english, 'Microsoft Visual Studio Code GitHub Copilot Azure OpenAI ChatGPT Google Chrome Safari Mozilla Firefox Edge'],
        [english, 'Zhang Wei Li Ming Wang Fang Liu Qiang Chen Jie Zhao Yun Sun Li'],
        [english, 'laser'], [english, 'laser engines'], [english, '😍😍😍😍😍😍😍😍'],
        [english, '34 + 1.5 = 35.5'], [english, 'https://example.test/extremelylongidentifier/another/path/to/technical/resource.js'],
        ['Mary Jane', english], ['CPU GPU API SQL HTTP JSON SVG PNG', english],
        [chinese, english], ['', english], [english, ''],
        [english, 'Ancillary nucleation photodissociation cryogenic electromechanical superconductivity'],
    ])('keeps Chinese, names, identifiers, symbols and insufficient evidence %#', (source, result) => {
        expect(isClearlyWrongLanguageResponse(source, result, 'zh-Hans')).toBe(false);
    });
    it.each([
        [polishSource, corruptPolishResult, 'pl'], [english, english.replace('restart', 'reboot'), 'en'],
        [english, french, 'fr'], [english, japanese, 'ja'],
    ])('does not reject results already in the chosen non-Chinese target %#', (source, result, target) => {
        expect(isClearlyWrongLanguageResponse(source, result, target)).toBe(false);
    });
    it('retains the existing Japanese paragraph protection and short-name allowance', () => {
        expect(isClearlyWrongLanguageResponse(english, japanese, 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(english, 'トヨタ自動車', 'zh-Hans')).toBe(false);
    });
    it.each([
        ['Automatic configuration preserves previously selected translation preferences.', 'unknown'],
        ['The software keeps all the settings for users.', 'identified'],
    ])('keeps insufficient Latin prose evidence with actual %s identification', (result, status) => {
        expect(identifyTextLanguage(result).status).toBe(status);
        expect(isClearlyWrongLanguageResponse(english, result, 'zh-Hans')).toBe(false);
    });
    it.each(['source', 'result'])('keeps a substantial but mixed-language %s conservative', field => {
        const mixed = english + ' ' + french;
        expect(identifyTextLanguage(mixed).status).toBe('unknown');
        expect(isClearlyWrongLanguageResponse(field === 'source' ? mixed : english, field === 'result' ? mixed : french, 'zh-Hans')).toBe(false);
    });
    it('keeps short underscore identifiers despite comma-list formatting', () => {
        const identifiers = 'a__, b__, c__, d__, e__, f__';
        expect(isLikelyUntranslatedResponse(identifiers, identifiers, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(identifiers, identifiers, 'zh-Hans')).toBe(false);
    });
    it('retains the existing kana-only Japanese paragraph rejection', () => {
        const kanaOnly = 'これはすべてひらがなのながいせつめいであり、ほかのぶんしょうもひらがなだけでかかれています。';
        expect(identifyTextLanguage(kanaOnly)).toMatchObject({ status: 'identified', languages: ['ja'] });
        expect(isClearlyWrongLanguageResponse(english, kanaOnly, 'zh-Hans')).toBe(true);
    });
    it('keeps a short Japanese quotation inside a substantial Chinese paragraph', () => {
        const quotation = '这个功能用于阅读中文文章，用户可以保留技术名称以及少量外语引用，不需要把引文视作整段错语种。'.repeat(3)
            + 'これはひらがなだけでかかれたせつめいです。';
        const kana = (quotation.match(/[\p{Script=Hiragana}\p{Script=Katakana}ーｰ]/gu) ?? []).length;
        const han = (quotation.match(/\p{Script=Han}/gu) ?? []).length;
        expect(kana).toBeGreaterThanOrEqual(16);
        expect(han).toBeGreaterThan(kana * 2);
        expect(isClearlyWrongLanguageResponse(english, quotation, 'zh-Hans')).toBe(false);
    });
    describe('真实 broker 恢复与缓存边界', () => {
        const chinese = '独立的高功率激光炮，每隔一点五秒发射一次，射程三十四，蓝色光束，耗电量非常大。';
        it('actual broker retries once and caches only the corrected Chinese result', async () => {
            const harness = createHarness();
            harness.provider.mockResolvedValueOnce(corruptPolishResult).mockResolvedValueOnce(chinese);
            await expect(harness.broker.translateWithCache({ origin: polishSource })).resolves.toBe(chinese);
            await expect(harness.broker.translateWithCache({ origin: polishSource })).resolves.toBe(chinese);
            expect(harness.provider).toHaveBeenCalledTimes(2);
            expect(harness.cacheSet).toHaveBeenCalledOnce();
            expect([...harness.store.values()]).toEqual([chinese]);
        });
        it('old corrupted cache is not reused and is replaced only by a valid result', async () => {
            const harness = createHarness();
            harness.cacheGet.mockResolvedValueOnce(corruptPolishResult);
            harness.provider.mockResolvedValue(chinese);
            await expect(harness.broker.translateWithCache({ origin: polishSource })).resolves.toBe(chinese);
            expect(harness.provider).toHaveBeenCalledOnce();
            expect([...harness.store.values()]).toEqual([chinese]);
        });
        it('repeated wrong-language responses keep the existing failure and cache boundary', async () => {
            const harness = createHarness();
            harness.provider.mockResolvedValue(corruptPolishResult);
            await expect(harness.broker.translateWithCache({ origin: polishSource })).rejects.toMatchObject({
                kind: 'response', code: 'WRONG_LANGUAGE_RESPONSE', retryable: false,
            });
            expect(harness.provider).toHaveBeenCalledTimes(2);
            expect(harness.cacheSet).not.toHaveBeenCalled();
            expect(harness.store.size).toBe(0);
        });
        it('ordinary broker batch recovers only the corrupt slot and keeps neighboring translations and names', async () => {
            const harness = createHarness();
            const next = 'The software translates every complete paragraph and keeps all reader settings available after a restart.';
            harness.provider.mockResolvedValueOnce([corruptPolishResult, '下一段已经译成中文。', 'Mary Jane']).mockResolvedValueOnce(chinese);
            await expect(harness.broker.translateWithCache({ origin: [polishSource, next, 'Mary Jane'] }))
                .resolves.toEqual([chinese, '下一段已经译成中文。', 'Mary Jane']);
            expect(harness.provider).toHaveBeenCalledTimes(2);
            expect(harness.provider.mock.calls[1][0]).toMatchObject({ origin: polishSource });
            expect([...harness.store.values()]).not.toContain(corruptPolishResult);
        });
    });
});


describe('已观察 AR/FR 残留正文的共享响应与缓存门禁', () => {
    const chinese = '该域名专供文档示例使用，无需事先许可。它不是服务，请勿将其用于测试或监控。';
    it.each(observedResidue.pairs)('拒绝 $lang 原始损坏结果，保持字节不变并接受真正中文', ({origin, result, lang}) => {
        expect(identifyTextLanguage(origin)).toMatchObject({status: 'identified', languages: [lang]});
        expect(isLikelyUntranslatedResponse(origin, result, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, result, 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(origin, result, 'zh-Hant')).toBe(true);
        expect(isClearlyWrongLanguageResponse(origin, chinese, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, result, lang)).toBe(false);
    });
    it.each(observedResidue.pairs)('$lang 旧坏缓存经真实 broker 读校验失效，成功后仅缓存中文', async ({origin, result}) => {
        const harness = createHarness();
        harness.cacheGet.mockResolvedValueOnce(result);
        harness.provider.mockResolvedValue(chinese);
        await expect(harness.broker.translateWithCache({origin})).resolves.toBe(chinese);
        await expect(harness.broker.translateWithCache({origin})).resolves.toBe(chinese);
        expect(harness.provider).toHaveBeenCalledOnce();
        expect([...harness.store.values()]).toEqual([chinese]);
    });
    it.each(observedResidue.pairs)('$lang 持续坏结果按既有重试失败，不写缓存', async ({origin, result}) => {
        const harness = createHarness(); harness.provider.mockResolvedValue(result);
        await expect(harness.broker.translateWithCache({origin})).rejects.toMatchObject({code: 'WRONG_LANGUAGE_RESPONSE'});
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.cacheSet).not.toHaveBeenCalled();
    });
    it.each(observedResidue.pairs)('$lang 批量仅重试坏槽，不丢相邻中文和专名', async ({origin, result}) => {
        const harness = createHarness();
        harness.provider.mockResolvedValueOnce([result, '已经完成。', 'Mary Jane']).mockResolvedValueOnce(chinese);
        await expect(harness.broker.translateWithCache({origin: [origin, 'The task is now complete.', 'Mary Jane']}))
            .resolves.toEqual([chinese, '已经完成。', 'Mary Jane']);
        expect(harness.provider).toHaveBeenCalledTimes(2);
        expect(harness.provider.mock.calls[1][0]).toMatchObject({origin});
    });
    it.each(observedResidue.pairs)('$lang 中文解释中的长引文不会被比例单独误拒', ({origin, result}) => {
        for (const [left, right] of [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['«', '»'], ['"', '"']]) {
            expect(isClearlyWrongLanguageResponse(origin, `中文说明引用${left}${result}${right}，这是原文示例。`, 'zh-Hans')).toBe(false);
        }
        expect(isClearlyWrongLanguageResponse(origin, chinese.repeat(3) + ' ' + result, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse('Mary Jane', result, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse('CPU GPU API SQL HTTP JSON SVG PNG', result, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(chinese, result, 'zh-Hans')).toBe(false);
    });
    it('词外 ASCII 单引文保留，法语与英文词内撇号不截走残留正文', () => {
        const arabic = observedResidue.pairs[0];
        expect(isClearlyWrongLanguageResponse(arabic.origin, `中文说明引用：'${arabic.result}'，这是原文示例。`, 'zh-Hans')).toBe(false);
        const french = observedResidue.pairs[1];
        expect(french.origin).toContain('L’usage');
        expect(french.origin).toContain('s’agit');
        expect(french.origin).toContain('d’un');
        expect(isClearlyWrongLanguageResponse(french.origin, `中文说明引用‘${french.origin}’，这是原文示例。`, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(french.origin, `中文说明引用：'${french.result}'，这是原文示例。`, 'zh-Hans')).toBe(false);
        // observed FR 原始结果本身含 L'use / s'agit / d'un；不改字节仍须拒绝。
        expect(french.result).toContain("s'agit");
        expect(isClearlyWrongLanguageResponse(french.origin, french.result, 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(french.origin, french.result + " it's", 'zh-Hans')).toBe(true);
        expect(isClearlyWrongLanguageResponse(french.origin, '中文引用：\'Le logiciel traduit chaque paragraphe et conserve les paramètres de lecture pour tous les utilisateurs après un redémarrage.\'。', 'zh-Hans')).toBe(false);
    });
    it('少量汉字加新写的外文或不可信混合源，不被新增残留规则武断拒绝', () => {
        const {origin} = observedResidue.pairs[1];
        expect(isClearlyWrongLanguageResponse(origin, '示例 Automatic configuration preserves previously selected translation preferences and independently synchronizes alternate workstation profiles across distant installations.', 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse('???', observedResidue.pairs[1].result, 'zh-Hans')).toBe(false);
        expect(isClearlyWrongLanguageResponse(origin, '示例 Mary Jane', 'zh-Hans')).toBe(false);
        // 本次只证明同 Arabic 正文残留，不能用源文中不存在的文字推断保留了原文。
        expect(isClearlyWrongLanguageResponse(origin, observedResidue.pairs[0].result, 'zh-Hans')).toBe(false);
    });
});
