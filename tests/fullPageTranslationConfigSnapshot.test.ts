import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildGlossaryRevision, type GlossaryLibrary} from '@/src/core/glossary';
import * as hashModule from '@/src/shared/function/sha256';
import * as pageDiscourse from '@/src/services/translation/context/pageDiscourse';
import {translateText, translateTextBatch} from '@/src/services/translation/client';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
import {createQuickTranslationProfile} from '@/src/core/config/quickTranslation';
import {resolveQuickTranslationInvocation} from '@/src/features/quick-translation/core';

const fixture = vi.hoisted(() => ({config: {
    service: 'microsoft', model: {microsoft: 'default-model'}, customModel: {}, modelThinking: {},
    from: 'en', to: 'zh-Hans', glossaryEnabled: true, glossaryLibraries: [] as GlossaryLibrary[],
    excludedLanguages: ['de'], useCache: true, enableAIContext: false, enableAIMultiSegment: false,
    nativeBatchTranslationEnabled: {}, display: 1, style: 0,
    translationOnlyDomains: [] as string[],
    longParagraphLineBreakEnabled: false, translationBeforeOriginal: false,
    compositeTranslationProviders: [] as CompositeTranslationProvider[], customBody: {} as Record<string, string>,
}}));
// 可选浏览器证据由预检边界套件验证；这里保留原有纯识别与请求/DOM契约。
vi.mock('@/src/services/translation/languagePreflight', () => ({shouldSkipTranslationWithEvidence: async () => false}));
vi.mock('@/src/services/config/store', () => ({config: fixture.config}));
vi.mock('@/src/services/translation/client', () => ({translateText: vi.fn(), translateTextBatch: vi.fn()}));
vi.mock('@/src/services/translation/queue', () => ({cancelTranslationQueueSession: vi.fn(), createTranslationQueueSession: vi.fn()}));
import {captureFullPageTranslationConfig, getTranslationInvocationIdentity, translateTextSlots} from '@/src/features/full-page-translation/content/translationRequest';

let generation = 0;
beforeEach(() => {
    Object.assign(fixture.config, {service: 'microsoft', from: 'en', to: 'zh-Hans', glossaryEnabled: true,
        excludedLanguages: ['de'], useCache: true, display: 1, longParagraphLineBreakEnabled: false,
        translationOnlyDomains: [],
        translationBeforeOriginal: false, enableAIMultiSegment: false, enableAIContext: false,
        compositeTranslationProviders: [], customBody: {},
        glossaryLibraries: [{id: `library-${generation++}`, name: '技术', enabled: true,
            sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
            entries: [{id: 'term-1', source: 'agent', target: '智能体', caseSensitive: false}]}],
    });
    vi.mocked(translateText).mockReset().mockImplementation(async origin => `译:${origin}`);
    vi.mocked(translateTextBatch).mockReset();
    vi.stubGlobal('document', {title: 'Config snapshot fixture'});
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('网页翻译配置捕获与词库摘要复用', () => {
    it('按当前网址冻结网站显示模式，其他网站继承全局且单次快捷方案覆盖仍有效', () => {
        vi.stubGlobal('location', {href: 'https://docs.example.com/article'});
        fixture.config.translationOnlyDomains = ['example.com'];
        const saved = captureFullPageTranslationConfig();
        expect(saved.displayMode).toBe('single'); expect(saved.displayModeOverridden).toBeUndefined();
        expect(captureFullPageTranslationConfig({displayMode: 'bilingual'})).toMatchObject({displayMode: 'bilingual', displayModeOverridden: true});
        location.href = 'https://another.test/article';
        expect(captureFullPageTranslationConfig().displayMode).toBe('bilingual');
        expect(saved.displayMode).toBe('single'); expect(fixture.config.display).toBe(1);
    });
    it('真实快捷方案的默认显示继承可随全局切换，只有显式方案产生显示冻结标记', () => {
        const profile = createQuickTranslationProfile('full-page', []);
        const settings = {...fixture.config, fullPageTranslationMode: 'viewport' as const, translationScope: 'content' as const};
        const first = captureFullPageTranslationConfig(resolveQuickTranslationInvocation(profile, settings));
        expect(first.displayMode).toBe('bilingual'); expect(first.displayModeOverridden).toBeUndefined();
        fixture.config.display = 0; settings.display = 0;
        const second = captureFullPageTranslationConfig(resolveQuickTranslationInvocation(profile, settings));
        expect(second.displayMode).toBe('single'); expect(second.displayModeOverridden).toBeUndefined();
        // 请求快照仍冻结请求当时的模式；已译内容是否跟随全局由独立覆盖标记决定。
        expect(first.displayMode).toBe('bilingual');
        for (const [mode, expected] of [['bilingual', 'bilingual'], ['translation-only', 'single']] as const) {
            const explicit = captureFullPageTranslationConfig(resolveQuickTranslationInvocation({...profile, displayMode: mode}, settings));
            expect(explicit).toMatchObject({displayMode: expected, displayModeOverridden: true});
        }
    });
    it('只有显式显示覆盖冻结本次模式，服务或语言覆盖仍允许网页显示即时切换', () => {
        expect(captureFullPageTranslationConfig().displayModeOverridden).toBeUndefined();
        expect(captureFullPageTranslationConfig({service: 'microsoft', targetLanguage: 'ja'}).displayModeOverridden).toBeUndefined();
        expect(captureFullPageTranslationConfig({displayMode: 'single'}).displayModeOverridden).toBe(true);
        expect(captureFullPageTranslationConfig({displayMode: 'bilingual'}).displayModeOverridden).toBe(true);
    });
    it('组合以原始数组进入 broker；成员连接修改隔离前端完成缓存与操作身份', async () => {
        fixture.config.service = 'composite:page';
        fixture.config.compositeTranslationProviders = [{id: 'composite:page', name: '网页组合', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12_000}];
        vi.mocked(translateTextBatch).mockImplementation(async origins => origins.map(origin => `译:${origin}`));
        const session = {active: true, translationSlotCache: new Map()};
        const first = captureFullPageTranslationConfig();
        await expect(translateTextSlots(['First paragraph', 'Second paragraph'], first, undefined, undefined, session)).resolves.toEqual(['译:First paragraph', '译:Second paragraph']);
        expect(translateText).not.toHaveBeenCalled();
        expect(vi.mocked(translateTextBatch).mock.calls[0][0]).toEqual(['First paragraph', 'Second paragraph']);
        await expect(translateTextSlots(['First paragraph', 'Second paragraph'], first, undefined, undefined, session)).resolves.toEqual(['译:First paragraph', '译:Second paragraph']);
        expect(translateTextBatch).toHaveBeenCalledOnce();
        fixture.config.customBody.google = '{"fixture":"changed"}';
        const next = captureFullPageTranslationConfig();
        expect(getTranslationInvocationIdentity(next)).not.toBe(getTranslationInvocationIdentity(first));
        await expect(translateTextSlots(['First paragraph', 'Second paragraph'], next, undefined, undefined, session)).resolves.toEqual(['译:First paragraph', '译:Second paragraph']);
        expect(translateTextBatch).toHaveBeenCalledTimes(2);
    });

    it('组合冻结通用 AI 成员能力并为其准备篇章上下文，保留原生数组而不启用 AI 槽协议', async () => {
        fixture.config.service = 'composite:context';
        fixture.config.enableAIContext = true;
        fixture.config.enableAIMultiSegment = true;
        fixture.config.compositeTranslationProviders = [{id: fixture.config.service, name: '上下文组合', strategy: 'smart', services: ['google', 'openai'], timeoutMs: 12_000}];
        const commit = vi.fn();
        const prepare = vi.spyOn(pageDiscourse, 'preparePageDiscourseContext').mockReturnValue({context: 'Bounded member context', commit});
        vi.mocked(translateTextBatch).mockResolvedValue(['译文一', '译文二']);
        const snapshot = captureFullPageTranslationConfig();
        expect(snapshot.compositeAIContext).toBe(true);
        await expect(translateTextSlots(['First paragraph', 'Second paragraph'], snapshot, undefined, undefined, undefined, false, {} as Element)).resolves.toEqual(['译文一', '译文二']);
        expect(prepare).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith(['译文一', '译文二']);
        expect(vi.mocked(translateTextBatch).mock.calls[0][2]).toMatchObject({discourseContext: 'Bounded member context'});
        expect(vi.mocked(translateTextBatch).mock.calls[0][2]?.aiMultiSegment).toBeUndefined();
        expect(translateText).not.toHaveBeenCalled();
    });

    it('重复悬浮捕获只复用词库摘要，每次仍生成独立配置并复制选库/排除数组', () => {
        const hash = vi.spyOn(hashModule, 'sha256Hex');
        const ids = ['selected'], first = captureFullPageTranslationConfig({glossaryIds: ids});
        const second = captureFullPageTranslationConfig({glossaryIds: ids});
        expect(hash).toHaveBeenCalledTimes(1);
        expect(first).not.toBe(second);
        expect(first.excludedLanguages).not.toBe(second.excludedLanguages);
        expect(first.glossaryIds).not.toBe(second.glossaryIds);
        ids.push('later'); fixture.config.excludedLanguages.push('ja');
        expect(first.glossaryIds).toEqual(['selected']);
        expect(first.excludedLanguages).toEqual(['de']);
        expect([first.glossaryIds, first.excludedLanguages].every(Object.isFrozen)).toBe(true);
        expect(captureFullPageTranslationConfig().excludedLanguages).toEqual(['ja', 'de']);
        expect(hash).toHaveBeenCalledTimes(1);
    });

    it('同一可变配置实例的词条修改与启停仍在事件开始时捕获，不等待广播或持久化', () => {
        const first = captureFullPageTranslationConfig();
        fixture.config.glossaryLibraries[0].entries[0].target = '代理人';
        const second = captureFullPageTranslationConfig();
        expect(second.glossaryRevision).toBe(buildGlossaryRevision(fixture.config.glossaryLibraries, true));
        expect(second.glossaryRevision).not.toBe(first.glossaryRevision);
        fixture.config.glossaryEnabled = false;
        expect(captureFullPageTranslationConfig().glossaryRevision).toBe('glossary-v1:disabled');
        fixture.config.glossaryLibraries[0].domains.push('example.com'); fixture.config.glossaryEnabled = true;
        expect(captureFullPageTranslationConfig().glossaryRevision).not.toBe(second.glossaryRevision);
        expect(first.glossaryRevision).not.toBe(second.glossaryRevision);
    });

    it('摘要复用不缓存服务/模型/语言/展示与快捷方案覆盖字段', () => {
        const first = captureFullPageTranslationConfig({service: 'microsoft', model: 'first', targetLanguage: 'ja',
            profileId: 'first-profile', displayMode: 'single', glossaryIds: []});
        fixture.config.from = 'auto'; fixture.config.to = 'fr'; fixture.config.useCache = false;
        fixture.config.longParagraphLineBreakEnabled = true; fixture.config.translationBeforeOriginal = true;
        const second = captureFullPageTranslationConfig({service: 'google', model: 'second', targetLanguage: 'ko',
            profileId: 'second-profile', displayMode: 'bilingual', glossaryIds: ['technical']});
        expect(first).toMatchObject({service: 'microsoft', model: 'first', sourceLanguage: 'en', targetLanguage: 'ja',
            profileId: 'first-profile', displayMode: 'single', glossaryIds: [], useCache: true,
            longParagraphLineBreak: false, translationBeforeOriginal: false, requestOverridesApplied: true});
        expect(second).toMatchObject({service: 'google', model: 'second', sourceLanguage: 'auto', targetLanguage: 'ko',
            profileId: 'second-profile', displayMode: 'bilingual', glossaryIds: ['technical'], useCache: false,
            longParagraphLineBreak: true, translationBeforeOriginal: true, requestOverridesApplied: true});
        expect(second.glossaryRevision).toBe(first.glossaryRevision);
        expect(captureFullPageTranslationConfig()).toMatchObject({service: 'microsoft', model: 'default-model', targetLanguage: 'fr'});
    });

    it('单候选 AI 协议失败按已捕获词库与语言逐槽降级，后续配置编辑不污染请求', async () => {
        fixture.config.enableAIMultiSegment = true;
        const snapshot = captureFullPageTranslationConfig({service: 'openai', model: 'fixture-model'});
        const session = {active: true, translationSlotCache: new Map()};
        vi.mocked(translateText).mockRejectedValueOnce({kind: 'response', code: 'TRANSLATION_SLOT_RESPONSE_INVALID'});
        const result = translateTextSlots(['First paragraph'], snapshot, undefined, undefined, session);
        fixture.config.to = 'fr'; fixture.config.glossaryLibraries[0].entries[0].target = '代理人';
        await expect(result).resolves.toEqual(['译:First paragraph']);
        expect(translateText).toHaveBeenCalledTimes(2);
        expect(vi.mocked(translateText).mock.calls.every(([, , options]) =>
            options?.targetLanguage === 'zh-Hans' && options.glossaryRevision === snapshot.glossaryRevision)).toBe(true);
        expect(captureFullPageTranslationConfig().glossaryRevision).not.toBe(snapshot.glossaryRevision);
    });

    it.each([undefined, ['译:First paragraph', null], ['', '']])(
        '跨候选异常响应 %j 只按各自原快照降级，不发布空或错位译文', async response => {
            fixture.config.enableAIMultiSegment = true;
            const snapshot = captureFullPageTranslationConfig({service: 'openai', model: 'fixture-model'});
            const session = {active: true, translationSlotCache: new Map()};
            vi.mocked(translateTextBatch).mockResolvedValueOnce(response as string[]);
            await expect(Promise.all([
                translateTextSlots(['First paragraph'], snapshot, undefined, undefined, session),
                translateTextSlots(['Second paragraph'], snapshot, undefined, undefined, session),
            ])).resolves.toEqual([['译:First paragraph'], ['译:Second paragraph']]);
            expect(translateTextBatch).toHaveBeenCalledOnce();
            expect(vi.mocked(translateText).mock.calls.map(([origin]) => origin)).toEqual(['First paragraph', 'Second paragraph']);
            expect(vi.mocked(translateText).mock.calls.every(([, , options]) =>
                options?.glossaryRevision === snapshot.glossaryRevision && !options!.aiMultiSegment)).toBe(true);
        },
    );

    it('完整批次允许运行时缺失来源的空槽，但非空来源的空译文仍逐槽恢复', async () => {
        fixture.config.enableAIMultiSegment = true;
        const snapshot = captureFullPageTranslationConfig({service: 'openai', model: 'fixture-model'});
        const session = {active: true, translationSlotCache: new Map()};
        vi.mocked(translateTextBatch).mockResolvedValueOnce(['', '']);
        await expect(Promise.all([
            translateTextSlots([undefined as never], snapshot, undefined, undefined, session),
            translateTextSlots(['Second paragraph'], snapshot, undefined, undefined, session),
        ])).resolves.toEqual([['译:'], ['译:Second paragraph']]);
        expect(vi.mocked(translateText).mock.calls.map(([origin]) => origin)).toEqual(['', 'Second paragraph']);
    });

    it('公式混合空槽保留本地公式与原始空槽，并沿用捕获配置翻译正文', async () => {
        const snapshot = captureFullPageTranslationConfig({service: 'youdao'});
        await expect(translateTextSlots([undefined as never, 'First paragraph $$$x^2$$$'], snapshot))
            .resolves.toEqual(['', '译:First paragraph $$$x^2$$$']);
        expect(vi.mocked(translateText).mock.calls.map(([origin]) => origin)).toEqual(['First paragraph']);
    });

    it('单候选槽协议损坏后沿同一页面身份熔断，location 与 document.URL 的回退身份一致', async () => {
        const page = {title: 'Config snapshot fixture', location: {href: 'https://example.test/article'},
            URL: 'https://example.test/article'};
        vi.stubGlobal('document', page);
        fixture.config.enableAIMultiSegment = true;
        const snapshot = captureFullPageTranslationConfig({service: 'openai', model: 'fixture-model'});
        const session = {active: true, translationSlotCache: new Map()};
        vi.mocked(translateText).mockResolvedValueOnce('Malformed slot envelope');
        await expect(translateTextSlots(['First paragraph', 'Second paragraph'], snapshot, undefined, undefined, session))
            .resolves.toEqual(['译:First paragraph', '译:Second paragraph']);
        vi.stubGlobal('document', {title: page.title, URL: page.URL});
        await expect(translateTextSlots(['Third paragraph', 'Fourth paragraph'], snapshot, undefined, undefined, session))
            .resolves.toEqual(['译:Third paragraph', '译:Fourth paragraph']);
        expect(translateTextBatch).not.toHaveBeenCalled();
        expect(vi.mocked(translateText).mock.calls.slice(1).map(([origin]) => origin))
            .toEqual(['First paragraph', 'Second paragraph', 'Third paragraph', 'Fourth paragraph']);
    });
});
