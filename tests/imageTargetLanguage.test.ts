/**
 * @file tests/imageTargetLanguage.test.ts
 * 真实识别验证 OCR 普通文本的同目标过滤、单条与批量映射、冻结目标以及未知和混合文本的保留；
 * 真实事务 wrapper 与 broker 验证 OCR 等待期间词库变更仍拒绝旧版本，不被同目标早退吞掉。
 */
import {describe, expect, it, vi} from 'vitest';
import {
    createImageTranslationBackgroundHandlers, IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
} from '@/src/features/image-translation/background/handlers';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {buildGlossaryRevision} from '@/src/core/glossary';
import {createImageGlossaryContext, type ImageGlossarySenderContext} from '@/src/app/background/imageGlossaryContext';
import type {BackgroundMessageHandler} from '@/src/app/background/messageRouter';
import {createTranslationBroker, type TranslationRequestMessage} from '@/src/services/translation/broker';
import {getTranslationGlossaryContext} from '@/src/services/translation/requestSnapshot';

vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {
    writeOwner: false, getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}), watch: vi.fn(() => () => {}),
}}));

function setup(batch: boolean, target: string) {
    const current = new Config();
    current.to = target;
    const translate = vi.fn(async (request: {origin: string | string[]; targetLanguage?: string}) =>
        Array.isArray(request.origin) ? request.origin.map(text => `T(${text})`) : `T(${request.origin})`);
    const handlers = createImageTranslationBackgroundHandlers({
        assertLanguagesDownloaded: async () => {}, translateImage: async () => ({}), fetchImage: async () => '',
        getTranslationService: () => 'microsoft', getGlossaryConfig: () => current,
        supportsBatchTranslation: () => batch, translateTexts: translate,
        downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
    });
    const call = (texts: string[]) => handlers.find(handler => handler.type === 'fluentReadImageTranslateTexts')!
        .handle({type: 'fluentReadImageTranslateTexts', texts});
    return {current, translate, call};
}

const samples = [
    ['zh-Hans', '这个页面说明软件的功能和设置。'],
    ['zh-Hant', '這個軟體讀取文件並翻譯這個頁面上的語言。'],
    ['en', 'Welcome to the settings page.'],
    ['de', 'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.'],
    ['ja', 'これは日本語の説明です。'],
    ['ko', '이 페이지는 소프트웨어의 기능과 설정을 설명합니다.'],
] as const;

describe('图片 OCR 同目标源头过滤', () => {
    it.each(samples)('%s 普通 OCR 行同目标零 broker 请求', async (target, source) => {
        const {call, translate} = setup(true, target);
        await expect(call([source, source, '123', 'https://example.test']))
            .resolves.toEqual({success: true, translations: [source, source, '123', 'https://example.test']});
        expect(translate).not.toHaveBeenCalled();
    });

    it.each([true, false])('batch=%s 只提交外语行并还原重复行原索引', async batch => {
        const {call, translate} = setup(batch, 'zh-Hans');
        const chinese = samples[0][1];
        const foreign = samples[2][1];
        await expect(call([chinese, foreign, chinese, foreign, '123']))
            .resolves.toEqual({success: true, translations: [chinese, `T(${foreign})`, chinese, `T(${foreign})`, '123']});
        expect(translate).toHaveBeenCalledOnce();
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({origin: batch ? [foreign] : foreign, targetLanguage: 'zh-Hans'}));
    });

    it('目标切换后中文行发出请求，显式冻结目标覆盖后续配置变化', async () => {
        const {call, translate, current} = setup(false, 'zh-Hans');
        await call([samples[0][1]]);
        current.to = 'en';
        translate.mockImplementationOnce(async request => {current.to = 'zh-Hans'; return `T(${request.origin})`;});
        await call([samples[0][1]]);
        expect(translate).toHaveBeenCalledOnce();
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({targetLanguage: 'en'}));
    });

    it('简繁转换、真实英文句子及歧义短词仍请求', async () => {
        const {call, translate} = setup(true, 'zh-Hans');
        const texts = [samples[1][1], `${samples[0][1]} ${samples[2][1]}`, 'Settings'];
        await call(texts);
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({origin: texts}));
    });
});

describe('图片同目标过滤保留冻结的词库版本协议', () => {
    it.each(['disabled', 'deleted'] as const)('OCR期间词库%s时仍向真实broker转发旧版本并拒绝事务', async change => {
        const source = '这个页面说明文档翻译的功能和设置。';
        const current = Object.assign(new Config(), {service: 'openai', from: 'auto', to: 'zh-Hans', glossaryEnabled: true,
            glossaryLibraries: [{id: 'site', name: '页面库', enabled: true, sourceLanguage: '', targetLanguage: '',
                domains: ['docs.example.com'], entries: [{id: 'term', source: '文档', target: '文件', caseSensitive: false}]}],
        });
        const revision = buildGlossaryRevision(current.glossaryLibraries, current.glossaryEnabled);
        const provider = vi.fn(async () => '这个页面说明文件翻译的功能和设置。');
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => current, providers: {openai: provider},
            cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
            serviceTypes: servicesType,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? current.from,
                targetLanguage: request?.targetLanguage ?? current.to}),
            resolveConfiguredModel, buildTranslationCacheKey: identity => JSON.stringify(identity), logger: {warn: vi.fn()},
        });
        const translate = vi.fn((request: TranslationRequestMessage) => broker.translateWithCache(request));
        const offscreenUrl = 'chrome-extension://fixture/offscreen.html';
        let wrapped: BackgroundMessageHandler<ImageGlossarySenderContext>[];
        const call = (type: string, message: Record<string, unknown>, context: ImageGlossarySenderContext) =>
            wrapped.find(handler => handler.type === type)!.handle({type, ...message}, context);
        const handlers = createImageTranslationBackgroundHandlers({
            assertLanguagesDownloaded: async () => {}, fetchImage: async () => '',
            translateImage: async (_image, _language, _title, options) => {
                if (change === 'disabled') current.glossaryEnabled = false;
                else current.glossaryLibraries[0]!.entries = [];
                return call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: options.requestId, texts: [source]}, {sender: {url: offscreenUrl}});
            },
            getTranslationService: () => 'openai', getGlossaryConfig: () => current,
            supportsBatchTranslation: () => true, translateTexts: translate,
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
        });
        wrapped = createImageGlossaryContext<ImageGlossarySenderContext>({
            ready: Promise.resolve(), offscreenUrl, getSourceLanguage: () => current.from,
            getGlossaryRevision: () => buildGlossaryRevision(current.glossaryLibraries, current.glossaryEnabled),
        }).wrap(handlers as BackgroundMessageHandler<ImageGlossarySenderContext>[]);
        await expect(call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId: 'image-glossary-change', image: 'data:image/png;base64,source', sourceLanguage: 'auto'},
            {sender: {url: 'https://docs.example.com/article', tab: {id: 7}}})).rejects.toThrow('术语库已更新');
        expect(buildGlossaryRevision(current.glossaryLibraries, current.glossaryEnabled)).not.toBe(revision);
        expect(translate).toHaveBeenCalledOnce();
        expect(translate).toHaveBeenCalledWith(expect.objectContaining({origin: [source], targetLanguage: 'zh-Hans',
            sourceLanguage: 'auto', glossaryRevision: revision}));
        expect(getTranslationGlossaryContext(translate.mock.calls[0]![0])).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
        expect(provider).not.toHaveBeenCalled();
    });
});
