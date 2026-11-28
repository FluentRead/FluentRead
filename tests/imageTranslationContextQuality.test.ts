/**
 * @file tests/imageTranslationContextQuality.test.ts
 * 验证图片翻译的编号标签放行、整图源语言固定、AI 有界多段与标题上下文、非原生并发池、免费池单线路整图一致性以及 Google 界面对话框标签分组协议。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    createImageTranslationBackgroundHandlers,
    IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
    type ImageTranslationBackgroundDependencies,
} from '@/src/features/image-translation/background/handlers';
import {getAlignedImageLabelSlots} from '@/src/features/image-translation/labelContext';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';
import {createGoogleImageContext, parseGoogleImageContext} from '@/src/providers/translation/googleImageContext';
import {Config} from '@/src/core/config/model';
import {customModelString, resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {
    attachTranslationGlossaryContext,
    getImageLabelSlots,
    isImageTextBatch,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProvider, TranslationProviderRequest, TranslationRequestMessage} from '@/src/services/translation/types';
import {providerConfigFixture} from './helpers/providerSnapshot';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
};

function setupHandlers(extra: Partial<ImageTranslationBackgroundDependencies> = {}) {
    const translateTexts = vi.fn(async (request: {origin: string | string[]}) =>
        Array.isArray(request.origin) ? request.origin.map(text => `译:${text}`) : `译:${request.origin}`);
    const dependencies: ImageTranslationBackgroundDependencies = {
        assertLanguagesDownloaded: vi.fn(async () => undefined),
        translateImage: vi.fn(async () => ({image: 'data:image/png,x', lines: []})),
        fetchImage: vi.fn(async () => 'data:image/png;base64,x'),
        getTranslationService: () => 'google',
        supportsBatchTranslation: () => false,
        translateTexts,
        downloadLanguages: vi.fn(async () => undefined),
        markLanguagesDownloaded: vi.fn(async () => []),
        ...extra,
    };
    const handlers = createImageTranslationBackgroundHandlers(dependencies);
    const textHandler = handlers.find(handler => handler.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
    return {dependencies, translateTexts: dependencies.translateTexts as ReturnType<typeof vi.fn>, textHandler};
}

function createBrokerFixture(service: string, provider: TranslationProvider, extraConfig: Partial<Config> = {}) {
    const current = Object.assign(new Config(), {
        service, from: 'auto', to: 'zh-Hans', useCache: false, enableAIContext: false, ...extraConfig,
    });
    const broker = createTranslationBroker({
        ready: Promise.resolve(),
        getConfig: () => current,
        providers: {[service]: provider},
        cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
        serviceTypes: servicesType,
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
        promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: override => ({
            sourceLanguage: override?.sourceLanguage ?? current.from,
            targetLanguage: override?.targetLanguage ?? current.to,
        }),
        resolveConfiguredModel,
        buildTranslationCacheKey: identity => JSON.stringify(identity),
        logger: {warn: vi.fn()},
    });
    return {config: current, broker};
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('1. 编号界面标签放行与技术标识过滤', () => {
    it('放行首字母大写常用界面序号标签，同时保留技术版本号、网址和硬件型号过滤', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
        });
        const texts = [
            'Layer 2', 'Plate 1', 'Step 2', 'Page 3', 'Option 1', 'Item 4', 'Tab 1', 'Nozzle 1', 'Room 101',
            'GPT-4', 'TLS 1.3', 'v2.1', 'USB3', 'X1C', 'H2D', 'SGLang 0.5.21', 'https://example.com', '22%', 'Claude 3.5 Sonnet',
        ];
        const response = await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts}) as {
            success: boolean; translations: string[];
        };
        expect(response.success).toBe(true);
        const sent = translateTexts.mock.calls[0]![0].origin as string[];
        expect(sent).toEqual(['Layer 2', 'Plate 1', 'Step 2', 'Page 3', 'Option 1', 'Item 4', 'Tab 1', 'Nozzle 1', 'Room 101']);
        expect(response.translations.slice(0, 9)).toEqual(sent.map(text => `译:${text}`));
        expect(response.translations.slice(9)).toEqual(texts.slice(9));
    });
});

describe('2. auto 源语下的整图语言固定', () => {
    const plateSettingsDialog = [
        'Plate Settings', 'Plate type', 'Same as Global Plate Type', 'Print sequence',
        'Same as Global Print Sequence', 'Spiral vase', 'Same as Global',
        'First layer filament sequence', 'Auto', 'Other layer filament sequence',
        'Customize', 'Layer', 'to', 'End', 'OK', 'Cancel',
    ];
    const slicingResultTable = [
        'Filament', 'Model', 'Flush', 'Tower', 'Total', 'Weight', 'Cost',
        'Print time', 'Model printing time', 'Total time', 'Estimated cost',
    ];

    it.each(['google', 'microsoft', 'freeTranslation', 'openai', 'bilibili'] as const)(
        '真实 16 项 Plate Settings 对话框（无人工 prose 句）在 from=auto 时为 %s 固定 sourceLanguage=en',
        async service => {
            const {textHandler, translateTexts} = setupHandlers({
                getTranslationService: () => service,
                supportsNativeBatch: id => id === 'google' || id === 'microsoft' || id === 'freeTranslation',
                supportsAIMultiSegment: id => id === 'openai',
                getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
            });
            await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: plateSettingsDialog});
            expect(translateTexts).toHaveBeenCalled();
            for (const [request] of translateTexts.mock.calls) {
                expect(request.sourceLanguage).toBe('en');
            }
        },
    );

    it('真实 Slicing Result 表格固定 en；德/法/西语界面、含重音字符或非英文功能词绝不误固定为 en', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
        });
        await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: slicingResultTable});
        expect(translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'en'});

        const nonEnglishGuardrails = [
            ['Einstellungen', 'Drucken', 'Schicht', 'Automatisch', 'Abbrechen'],
            ['Paramètres', 'Séquence', 'Annuler'],
            ['Configuración', 'Secuencia', 'Cancelar'],
            // 含非 ASCII 拉丁变音字母即使统计猜英文也不走英文兜底
            [...slicingResultTable, 'Café'],
            // 词数足但 ASCII 字母少于 20（franc 猜 en 但字母总量不足 20）
            ['Print', 'Type', 'Weight', 'Ok'],
            // 含德语功能词压过英文功能词
            [...slicingResultTable, 'mit', 'von'],
        ];
        for (const texts of nonEnglishGuardrails) {
            translateTexts.mockClear();
            await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts});
            expect(translateTexts.mock.calls[0]![0].sourceLanguage).not.toBe('en');
        }

        // 目标语言就是 en 时不固定 sourceLanguage=en
        const toEnglish = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'en'}),
        });
        await toEnglish.textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: slicingResultTable});
        expect(toEnglish.translateTexts.mock.calls[0]![0]).not.toHaveProperty('sourceLanguage');
    });

    it('兼容日文 Han+Kana、韩文 Hangul+Han 与英文单字母希腊单位符号，仍拒绝真正混合文字体系', async () => {
        // 日文漫画（Han + Kana）固定 ja 且为 localTranslation 提供同图检测上下文
        const jaLocal = setupHandlers({
            getTranslationService: () => 'localTranslation',
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
        });
        const jaTexts = ['こんにちは世界', '次のページへ進みましょう。', '右'];
        await jaLocal.textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: jaTexts});
        const jaRequests = jaLocal.translateTexts.mock.calls.map(([req]) => req);
        expect(jaRequests.every(req => req.sourceLanguage === 'ja')).toBe(true);
        expect(jaRequests.find(req => req.origin === '右')?.sourceLanguageDetectionText).toBe(jaTexts.join('\n'));

        // 韩文含汉字（Hangul + Han）固定 ko
        const koBatch = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
        });
        await koBatch.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['韓國語 설정 안내입니다.', '확인'],
        });
        expect(koBatch.translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'ko'});

        // 英文带单字母希腊单位（μ、Ω）仍固定 en
        const greekUnit = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-Hans'}),
        });
        await greekUnit.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Layer height 200 μm', 'Resistance 10 Ω', 'Select the plate type for this print job.', 'Auto'],
        });
        expect(greekUnit.translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'en'});

        // 真正混合文字（假名 + 谚文、英文 + 多字母希腊词、单独单字母希腊符号）不固定
        const mixedCases = [
            ['こんにちは世界', '안녕하세요'],
            ['Plate Settings', 'Ρυθμίσεις'],
            ['Ω'],
        ];
        for (const texts of mixedCases) {
            greekUnit.translateTexts.mockClear();
            await greekUnit.textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts});
            expect(greekUnit.translateTexts.mock.calls[0]![0]).not.toHaveProperty('sourceLanguage');
        }
    });

    it('受信术语上下文携带 sourceLanguage=auto 时同样固定为整图语言，显式源语、混合文字或与目标同语不覆盖', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: 'zh-CN'}),
        });

        // 受信上下文 sourceLanguage=auto -> 固定 en
        const autoMessage = attachTranslationGlossaryContext({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: plateSettingsDialog,
            sourceLanguage: 'auto',
            glossaryRevision: 'rev-1',
        }, {context: 'page', pageUrl: 'https://example.test'});
        await textHandler.handle(autoMessage);
        expect(translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'en', glossaryRevision: 'rev-1'});

        // 受信上下文显式 sourceLanguage=fr -> 不覆盖
        translateTexts.mockClear();
        const explicitMessage = attachTranslationGlossaryContext({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: plateSettingsDialog,
            sourceLanguage: 'fr',
            glossaryRevision: 'rev-1',
        }, {context: 'page'});
        await textHandler.handle(explicitMessage);
        expect(translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'fr'});

        // 混合脚本（拉丁 + 西里尔） -> 不固定
        translateTexts.mockClear();
        await textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Plate Settings', 'Настройки печати для этого документа'],
        });
        expect(translateTexts.mock.calls[0]![0]).not.toHaveProperty('sourceLanguage');

        // 单独无法识别短词 -> 不固定
        translateTexts.mockClear();
        await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Auto']});
        expect(translateTexts.mock.calls[0]![0]).not.toHaveProperty('sourceLanguage');

        // 显式非 auto 的 glossaryConfig.from -> 不覆盖
        const explicitFrom = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'de', to: 'zh-Hans'}),
        });
        await explicitFrom.textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: plateSettingsDialog});
        expect(explicitFrom.translateTexts.mock.calls[0]![0]).not.toHaveProperty('sourceLanguage');

        // 无目标语言且 glossaryConfig.from=auto -> 仍可固定
        const noTarget = setupHandlers({
            getTranslationService: () => 'microsoft',
            supportsNativeBatch: () => true,
            getGlossaryConfig: () => ({glossaryEnabled: false, glossaryLibraries: [], from: 'auto', to: ''}),
        });
        await noTarget.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Select the plate type for this print job.', 'Auto'],
        });
        expect(noTarget.translateTexts.mock.calls[0]![0]).toMatchObject({sourceLanguage: 'en'});
    });
});

describe('3. 提示词 AI 有界多段、标题上下文、协议回退与非原生并发池', () => {
    it('12 项对话框在单次 aiMultiSegment 调用中完成：开启 AI 上下文附带 <=240 字符 pageContext，关闭开关时不泄露标题且不强开 enableAIContext', async () => {
        const provider = vi.fn(async (request: TranslationProviderRequest) => {
            const parsed = JSON.parse(String(request.origin)) as string[];
            return JSON.stringify(parsed.map((text, index) => [index, `中:${text}`]));
        });
        const {config, broker} = createBrokerFixture('openai', provider, {enableAIContext: true});
        const {textHandler} = setupHandlers({
            getTranslationService: () => 'openai',
            supportsBatchTranslation: () => true,
            supportsNativeBatch: () => false,
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => config.enableAIContext,
            getGlossaryConfig: () => config,
            translateTexts: request => broker.translateWithCache(request as TranslationRequestMessage),
        });
        const labels = [
            'Plate Settings', 'Select the plate type for this print job.', 'Print sequence', 'Spiral vase',
            'First layer filament sequence', 'Auto', 'Customize', 'Layer 2',
            'Plate 1', 'OK', 'Cancel', 'Auto',
        ];
        const result = await textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: labels,
            title: '  3D Slicer\n\tSettings   Dialog  ',
        }) as {success: boolean; translations: string[]};
        expect(result.success).toBe(true);
        expect(result.translations).toEqual(labels.map(label => `中:${label}`));
        expect(provider).toHaveBeenCalledOnce();
        const providerRequest = provider.mock.calls[0]![0];
        expect(providerRequest.pageContext).toBe('Page title: 3D Slicer Settings Dialog');
        expect(providerRequest.sourceLanguage).toBe('en');

        // 用户关闭 enableAIContext 时仍走单次 aiMultiSegment，但不得附带宿主页面标题或强开 enableAIContext
        provider.mockClear();
        config.enableAIContext = false;
        const optOut = setupHandlers({
            getTranslationService: () => 'openai',
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => false,
        });
        await optOut.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Plate type', 'Auto'],
            title: 'Private Host Page Title',
        });
        expect(optOut.translateTexts.mock.calls[0]![0]).toMatchObject({aiMultiSegment: true, pageContext: ''});
        expect(optOut.translateTexts.mock.calls[0]![0]).not.toHaveProperty('enableAIContext');
    });

    it('超长标题按 Unicode 码点截断至 240 字符且不拆断代理对，空标题不附加 pageContext', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'openai',
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => true,
        });
        const emojiTitle = 'A'.repeat(227) + '😀' + 'Z';
        await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Hello'], title: emojiTitle});
        const pageContext = translateTexts.mock.calls[0]![0].pageContext as string;
        expect(pageContext.length).toBeLessThanOrEqual(240);
        expect(pageContext).toBe('Page title: ' + 'A'.repeat(227));
        expect(/[\uD800-\uDBFF]$/u.test(pageContext)).toBe(false);

        translateTexts.mockClear();
        await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Hello'], title: '   \n\t  '});
        expect(translateTexts.mock.calls[0]![0]).toMatchObject({pageContext: '', aiMultiSegment: true, enableAIContext: true});
    });

    it('超过 24 段或 3500 字符时自动分块调用 aiMultiSegment 并按原序回填', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'openai',
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => true,
        });
        const manyLabels = Array.from({length: 26}, (_, index) => `Option label ${index + 1}`);
        const resCount = await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: manyLabels, title: ''}) as {
            translations: string[];
        };
        expect(translateTexts).toHaveBeenCalledTimes(2);
        expect(translateTexts.mock.calls[0]![0].origin).toHaveLength(24);
        expect(translateTexts.mock.calls[1]![0].origin).toHaveLength(2);
        expect(translateTexts.mock.calls[0]![0]).toMatchObject({aiMultiSegment: true, enableAIContext: true});
        expect(resCount.translations).toEqual(manyLabels.map(label => `译:${label}`));

        translateTexts.mockClear();
        const longTexts = ['A'.repeat(2000) + '.', 'B'.repeat(2000) + '.'];
        await textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: longTexts});
        expect(translateTexts).toHaveBeenCalledTimes(2);
        expect(translateTexts.mock.calls[0]![0].origin).toEqual([longTexts[0]]);
        expect(translateTexts.mock.calls[1]![0].origin).toEqual([longTexts[1]]);
    });

    it('aiMultiSegment 遇到协议/槽位错误或畸形返回时优雅回退至并行逐段池，并遵守 AI 上下文开关；非协议错误直接失败', async () => {
        const fallbackErrors: unknown[] = [
            Object.assign(new Error('bad protocol'), {name: 'AIMultiSegmentResponseError'}),
            Object.assign(new Error('repair failed'), {code: 'AI_MULTI_SEGMENT_REPAIR_FAILED'}),
            Object.assign(new Error('slot invalid'), {code: 'TRANSLATION_SLOT_RESPONSE_INVALID'}),
            'malformed-response',
        ];
        for (const failure of fallbackErrors) {
            const translateTexts = vi.fn(async (request: {origin: string | string[]; aiMultiSegment?: boolean; discourseContext?: string}) => {
                if (request.aiMultiSegment) {
                    if (failure === 'malformed-response') return [' '];
                    throw failure;
                }
                return `回退:${request.origin}`;
            });
            const {textHandler} = setupHandlers({
                getTranslationService: () => 'openai',
                supportsAIMultiSegment: () => true,
                isTextContextEnabled: () => true,
                translateTexts,
            });
            const res = await textHandler.handle({
                type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
                texts: ['Plate type', 'Auto'],
                title: 'Slicer Settings',
            }) as {success: boolean; translations: string[]};
            expect(res).toEqual({success: true, translations: ['回退:Plate type', '回退:Auto']});
            expect(translateTexts).toHaveBeenCalledTimes(3);
            const fallbackRequest = translateTexts.mock.calls[1]![0];
            expect(fallbackRequest).toMatchObject({
                pageContext: 'Page title: Slicer Settings',
                enableAIContext: true,
            });
            expect(fallbackRequest.discourseContext).toContain('neighboring image OCR');
        }

        // 关闭 AI 上下文时，aiMultiSegment 回退逐段池也不得强开 enableAIContext 或携带宿主标题/邻文
        const optOutTranslate = vi.fn(async (request: {origin: string | string[]; aiMultiSegment?: boolean}) => {
            if (request.aiMultiSegment) throw Object.assign(new Error('bad protocol'), {name: 'AIMultiSegmentResponseError'});
            return `回退:${request.origin}`;
        });
        const optOutFallback = setupHandlers({
            getTranslationService: () => 'openai',
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => false,
            translateTexts: optOutTranslate,
        });
        await expect(optOutFallback.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Plate type', 'Auto'],
            title: 'Private Page Title',
        })).resolves.toEqual({success: true, translations: ['回退:Plate type', '回退:Auto']});
        expect(optOutTranslate.mock.calls[1]![0]).toMatchObject({pageContext: ''});
        expect(optOutTranslate.mock.calls[1]![0]).not.toHaveProperty('enableAIContext');
        expect(optOutTranslate.mock.calls[1]![0]).not.toHaveProperty('discourseContext');

        // 非协议错误（HTTP 500 或非对象错误）不得静默回退
        for (const hardError of [new Error('HTTP 500'), 'network down']) {
            const translateTexts = vi.fn(async () => { throw hardError; });
            const {textHandler} = setupHandlers({
                getTranslationService: () => 'openai',
                supportsAIMultiSegment: () => true,
                translateTexts,
            });
            await expect(textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['Plate type', 'Auto']}))
                .rejects.toThrow('图片文字批量翻译失败');
            expect(translateTexts).toHaveBeenCalledOnce();
        }
    });

    it('非原生非 AI 服务（如 bilibili）走 6 并发逐段池而非串行数组循环，组合 AI 成员携带页面标题上下文', async () => {
        const waits = new Map<string, ReturnType<typeof deferred<string>>>();
        const translateTexts = vi.fn((request: {origin: string | string[]}) => {
            expect(Array.isArray(request.origin)).toBe(false);
            const gate = deferred<string>();
            waits.set(request.origin as string, gate);
            return gate.promise;
        });
        const {textHandler} = setupHandlers({
            getTranslationService: () => 'bilibili',
            supportsBatchTranslation: () => true,
            supportsNativeBatch: () => false,
            supportsAIMultiSegment: () => false,
            translateTexts,
        });
        const items = Array.from({length: 8}, (_, index) => `Button item ${index + 1}`);
        const pending = textHandler.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: items});
        await vi.waitFor(() => expect(waits.size).toBe(6));
        for (const [key, gate] of waits) gate.resolve(`译:${key}`);
        await vi.waitFor(() => expect(waits.size).toBe(8));
        waits.get(items[6]!)!.resolve(`译:${items[6]}`);
        waits.get(items[7]!)!.resolve(`译:${items[7]}`);
        await expect(pending).resolves.toEqual({success: true, translations: items.map(item => `译:${item}`)});

        // 组合服务含 AI 成员时（supportsAIMultiSegment 返回 false 但 isTextContextEnabled 返回 true）附带标题与邻文
        const compositeCalls: Array<Record<string, unknown>> = [];
        const composite = setupHandlers({
            getTranslationService: () => 'composite:images',
            supportsNativeBatch: () => false,
            supportsAIMultiSegment: () => false,
            isTextContextEnabled: () => true,
            translateTexts: vi.fn(async request => {
                compositeCalls.push(request as unknown as Record<string, unknown>);
                return `译:${request.origin}`;
            }),
        });
        await composite.textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Plate type', 'Auto'],
            title: 'Printer Settings',
        });
        expect(compositeCalls[0]).toMatchObject({
            pageContext: 'Page title: Printer Settings',
            enableAIContext: true,
        });
        expect(String(compositeCalls[0]!.discourseContext)).toContain('neighboring image OCR');
    });

    it('freeTranslation 批次经 handler 附带不可序列化的同图标记且不携带 Google 标签槽', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'freeTranslation',
            supportsNativeBatch: service => service === 'freeTranslation',
            supportsAIMultiSegment: () => false,
        });
        await textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['Plate Settings', 'Plate type', 'Auto'],
            imageLabelSlots: [0, 1, 2],
        });
        expect(translateTexts).toHaveBeenCalledOnce();
        const request = translateTexts.mock.calls[0]![0];
        expect(isImageTextBatch(request)).toBe(true);
        expect(getImageLabelSlots(request)).toBeUndefined();
    });
});

describe('3b. imageTranslationRuntime 依赖装配（supportsNativeBatch / supportsAIMultiSegment）', () => {
    it('正确区分原生批译、免费池、非原生数组服务与提示词型 AI 服务', async () => {
        vi.resetModules();
        const runtimeConfig = {
            enableAIContext: false,
            service: 'google',
            imageTranslationService: '',
            imageTranslationOcrEngine: 'paddle' as const,
            imageTranslationInferenceBackend: 'auto' as const,
            model: {} as Record<string, string>,
            customModel: {} as Record<string, string>,
            compositeTranslationProviders: [{id: 'composite:mix', name: 'Mix', strategy: 'sequential' as const, services: ['google', 'openai'], timeoutMs: 12000}],
            disabledTranslationServices: [] as string[],
        };
        const captured: ImageTranslationBackgroundDependencies[] = [];
        vi.doMock('@/src/services/config/store', () => ({config: runtimeConfig}));
        vi.doMock('@/src/app/translation/runtime', () => ({translateWithCache: vi.fn()}));
        vi.doMock('@/src/app/background/handlers/imageTranslation', () => ({
            createImageTranslationBackgroundHandlers: (deps: ImageTranslationBackgroundDependencies) => { captured.push(deps); return []; },
        }));
        vi.doMock('@/src/features/image-translation/background/offscreenAdapter', () => ({
            imageTranslationOffscreenAdapter: {translateImage: vi.fn(), fetchImage: vi.fn()},
            imageTranslationSourceTransport: {fetchImage: vi.fn(), assertImageSource: vi.fn()},
            imageTranslationProgressTransport: {sendProgress: vi.fn()},
        }));
        const {createImageTranslationRuntime} = await import('@/src/app/background/imageTranslationRuntime');
        createImageTranslationRuntime({
            assertDownloaded: vi.fn(async () => undefined),
            getDownloaded: vi.fn(async () => []),
            markDownloaded: vi.fn(async () => []),
            markRemoved: vi.fn(async () => []),
        });
        const deps = captured[0]!;
        expect(deps.supportsNativeBatch!('google')).toBe(true);
        expect(deps.supportsNativeBatch!('microsoft')).toBe(true);
        expect(deps.supportsNativeBatch!('freeTranslation')).toBe(true);
        expect(deps.supportsNativeBatch!('bilibili')).toBe(false);
        expect(deps.supportsNativeBatch!('openai')).toBe(false);

        expect(deps.supportsAIMultiSegment!('openai')).toBe(true);
        expect(deps.supportsAIMultiSegment!('google')).toBe(false);
        expect(deps.supportsAIMultiSegment!('bilibili')).toBe(false);
        runtimeConfig.model = {tongyi: customModelString};
        runtimeConfig.customModel = {tongyi: 'qwen-mt-plus'};
        expect(deps.supportsAIMultiSegment!('tongyi')).toBe(false);
        runtimeConfig.customModel.tongyi = 'qwen-plus';
        expect(deps.supportsAIMultiSegment!('tongyi')).toBe(true);

        expect(deps.isTextContextEnabled!('openai')).toBe(false);
        runtimeConfig.enableAIContext = true;
        expect(deps.isTextContextEnabled!('openai')).toBe(true);
        expect(deps.isTextContextEnabled!('composite:mix')).toBe(true);
        expect(deps.getTranslationService()).toBe('google');
        runtimeConfig.imageTranslationService = 'openai';
        expect(deps.getTranslationService()).toBe('openai');
        expect(deps.getGlossaryConfig!()).toBe(runtimeConfig);
        expect(deps.getImageOcrEngine!()).toBe('paddle');
        expect(deps.getImageInferenceBackend!()).toBe('auto');
        vi.doUnmock('@/src/services/config/store');
        vi.doUnmock('@/src/app/translation/runtime');
        vi.doUnmock('@/src/app/background/handlers/imageTranslation');
        vi.doUnmock('@/src/features/image-translation/background/offscreenAdapter');
    });
});

describe('4. 免费翻译同图批次单线路一致性与整组换线', () => {
    let microsoftMock: ReturnType<typeof vi.fn>;
    let googleMock: ReturnType<typeof vi.fn>;
    let googleOwnerMock: ReturnType<typeof vi.fn>;
    let officialMock: ReturnType<typeof vi.fn>;
    let freeTranslation: typeof import('@/src/providers/translation/free-translation').default;
    let attachSnapshot: typeof import('@/src/services/translation/requestSnapshot').attachTranslationProviderConfig;
    let createSnapshot: typeof import('@/src/services/translation/requestSnapshot').createTranslationProviderConfigSnapshot;
    let markImageBatch: typeof import('@/src/services/translation/requestSnapshot').markImageTextBatch;
    let mockConfig: Record<string, unknown>;

    beforeEach(async () => {
        vi.resetModules();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        microsoftMock = vi.fn();
        googleMock = vi.fn();
        googleOwnerMock = vi.fn();
        officialMock = vi.fn();
        mockConfig = {
            service: 'freeTranslation',
            from: 'en',
            to: 'zh-Hans',
            freeTranslationTimeoutMs: 2_000,
            freeTranslationCooldownMs: 1_000,
            freeTranslationMode: 'balanced',
            freeTranslationOrder: ['microsoft', 'alibabaFree', 'google'],
            nativeBatchTranslationEnabled: {},
        };
        vi.doMock('@/src/platform/storage/freeTranslationHealthStorage', () => ({
            freeTranslationHealthStorage: {load: async () => null, save: async () => undefined},
        }));
        vi.doMock('@/src/providers/translation/microsoft', () => ({translateMicrosoftTexts: microsoftMock}));
        vi.doMock('@/src/providers/translation/google', () => ({translateGoogleText: googleMock, translateGoogleOwnerTexts: googleOwnerMock}));
        vi.doMock('@/src/providers/translation/free-official-web', () => ({translateOfficialFreeWebProvider: officialMock}));
        ({default: freeTranslation} = await import('@/src/providers/translation/free-translation'));
        ({
            attachTranslationProviderConfig: attachSnapshot,
            createTranslationProviderConfigSnapshot: createSnapshot,
            markImageTextBatch: markImageBatch,
        } = await import('@/src/services/translation/requestSnapshot'));
    });

    afterEach(() => {
        vi.doUnmock('@/src/platform/storage/freeTranslationHealthStorage');
        vi.doUnmock('@/src/providers/translation/microsoft');
        vi.doUnmock('@/src/providers/translation/google');
        vi.doUnmock('@/src/providers/translation/free-official-web');
    });

    function createImageFreeRequest(origin: string[], extra: Record<string, unknown> = {}) {
        const snapshot = createSnapshot(providerConfigFixture({...mockConfig, ...extra}));
        const message = markImageBatch({origin, sourceLanguage: 'en', targetLanguage: 'zh-Hans', ...extra});
        return attachSnapshot(message, snapshot);
    }

    it('原生免费线路以有界块在单一服务上完成全部图片标签，不跨服务混译', async () => {
        microsoftMock.mockImplementation(async (texts: string[]) => texts.map(text => `微软:${text}`));
        const labels = Array.from({length: 10}, (_, index) => `Plate setting ${index + 1}`);
        const result = await freeTranslation(createImageFreeRequest(labels));
        expect(result).toEqual(labels.map(label => `微软:${label}`));
        expect(microsoftMock).toHaveBeenCalledTimes(2);
        expect(microsoftMock.mock.calls[0]![0]).toHaveLength(8);
        expect(microsoftMock.mock.calls[1]![0]).toHaveLength(2);
        expect(officialMock).not.toHaveBeenCalled();
        expect(googleOwnerMock).not.toHaveBeenCalled();
    });

    it('首条线路失败或返回空值时整图切换至下一健康线路，保持整图术语统一并保留空白槽', async () => {
        microsoftMock.mockRejectedValue(Object.assign(new Error('upstream 503'), {statusCode: 503}));
        officialMock.mockImplementationOnce(async () => '   ');
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(text => `谷歌:${text}`));
        mockConfig.freeTranslationMode = 'sequential';

        const result = await freeTranslation(createImageFreeRequest(['Plate Settings', '   ', 'Plate type', 'Auto']));
        expect(result).toEqual(['谷歌:Plate Settings', '   ', '谷歌:Plate type', '谷歌:Auto']);
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(officialMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock).toHaveBeenCalledOnce();
    });

    it('单条线路（或关闭原生合批的线路）逐条完成整图且在取消时立即中止，纯空白图片批次本地返回', async () => {
        mockConfig.freeTranslationMode = 'sequential';
        mockConfig.freeTranslationOrder = ['alibabaFree', 'microsoft'];
        officialMock.mockImplementation(async (_id: string, req: {origin: string}) => `阿里:${req.origin}`);
        const labels = ['Plate Settings', 'Plate type', 'Print sequence'];
        await expect(freeTranslation(createImageFreeRequest(labels))).resolves.toEqual(labels.map(label => `阿里:${label}`));
        expect(officialMock).toHaveBeenCalledTimes(3);
        expect(microsoftMock).not.toHaveBeenCalled();

        // 纯空白图片批次直接返回不发请求
        officialMock.mockClear();
        await expect(freeTranslation(createImageFreeRequest([' ', '\t']))).resolves.toEqual([' ', '\t']);
        expect(officialMock).not.toHaveBeenCalled();

        // 单条循环中途取消
        const singleAbort = new AbortController();
        officialMock.mockImplementationOnce(async (_id: string, req: {origin: string}) => {
            singleAbort.abort(new Error('stop single'));
            return `阿里:${req.origin}`;
        });
        await expect(freeTranslation(createImageFreeRequest(['First label', 'Second label'], {abortSignal: singleAbort.signal})))
            .rejects.toThrow();

        // 原生分块中途取消
        mockConfig.freeTranslationOrder = ['microsoft'];
        const nativeAbort = new AbortController();
        microsoftMock.mockImplementationOnce(async (texts: string[]) => {
            nativeAbort.abort(new Error('stop native'));
            return texts.map(text => `微软:${text}`);
        });
        const tenLabels = Array.from({length: 10}, (_, index) => `Label ${index + 1}`);
        await expect(freeTranslation(createImageFreeRequest(tenLabels, {abortSignal: nativeAbort.signal})))
            .rejects.toThrow();
    });

    it('同图多行单线路超时上限封顶 10s（总预算一半），首路挂起后仍为第二路保留充足换线窗口', async () => {
        vi.useFakeTimers();
        mockConfig.freeTranslationMode = 'sequential';
        mockConfig.freeTranslationOrder = ['microsoft', 'google'];
        mockConfig.freeTranslationTimeoutMs = 8_000;
        microsoftMock.mockImplementation(() => new Promise(() => {}));
        googleOwnerMock.mockImplementation(async (texts: string[]) => texts.map(text => `谷歌:${text}`));

        const labels = Array.from({length: 14}, (_, index) => `Dialog label ${index + 1}`);
        const pending = freeTranslation(createImageFreeRequest(labels));
        // 单路封顶 10_000ms，不能吃掉全部 20_000ms 导致候选 2 饿死
        await vi.advanceTimersByTimeAsync(10_500);
        await expect(pending).resolves.toEqual(labels.map(label => `谷歌:${label}`));
        expect(microsoftMock).toHaveBeenCalledOnce();
        expect(googleOwnerMock).toHaveBeenCalledTimes(2);
    });
});

describe('5. Google 界面对话框短标签分组协议（labelContext + googleImageContext + handlers 重映射）', () => {
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const decode = (text: string) => text.replace(/&(amp|lt|gt);/gu, (_, key: string) => ({amp: '&', lt: '<', gt: '>'})[key]!);
    const slot = (id: number, text: string) => `<span data-fr-slot="${id}">${text}</span>`;
    const region = (text: string, x0: number, y0: number, x1: number, y1: number, index: number, extra: Partial<ImageTextRegion> = {}) => ({
        line: {text, bbox: {x0, y0, x1, y1}, ...extra} as ImageTextRegion,
        index,
    });

    it('labelContext 识别左对齐列、右对齐列、同行按钮条与双栏表单，并拒绝坏框或过远/重叠区域', () => {
        // 双栏设置弹窗：标题 + 左列标签/右列值 + 底部按钮行
        const dialog = [
            region('Plate Settings', 20, 10, 160, 28, 0),
            region('Plate type', 20, 50, 110, 66, 1),
            region('Auto', 220, 50, 260, 66, 2),
            region('Print sequence', 20, 90, 140, 106, 3),
            region('By layer', 220, 90, 290, 106, 4),
            region('Spiral vase', 20, 130, 120, 146, 5),
            region('OK', 180, 180, 210, 196, 6),
            region('Cancel', 230, 180, 290, 196, 7),
        ];
        expect(getAlignedImageLabelSlots(dialog)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

        // 右对齐堆叠列
        const rightAligned = [
            region('Default', 210, 10, 280, 26, 0),
            region('Auto', 240, 42, 280, 58, 1),
        ];
        expect(getAlignedImageLabelSlots(rightAligned)).toEqual([0, 1]);

        // 各类负样本：不连续 index、字高差异过大、垂直间隙过大/重叠、水平过远/重叠、非法框、含标点/数字、竖排
        const negatives = [
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 20, 40, 110, 56, 2)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 20, 40, 110, 80, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 20, 100, 110, 116, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 20, 20, 110, 36, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 900, 10, 940, 26, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 80, 10, 140, 26, 1)],
            [region('Plate type', 20, 10, 20, 26, 0), region('Auto', 20, 40, 110, 56, 1)],
            [region('Plate type', NaN, 10, 110, 26, 0), region('Auto', 20, 40, 110, 56, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Auto', 20, 40, 110, 40, 1)],
            [region('Plate type', 20, 10, 110, 26, 0), region('Print sequence', 300, 42, 420, 58, 1)],
            [region('Plate type.', 20, 10, 110, 26, 0), region('Auto', 20, 40, 110, 56, 1)],
            [region('Plate type', 20, 10, 110, 26, 0, {vertical: true}), region('Auto', 20, 40, 110, 56, 1)],
        ];
        for (const rows of negatives) {
            expect(getAlignedImageLabelSlots(rows)).toEqual([]);
        }
    });

    it('googleImageContext 将连续界面短标签按上限 8 项/1200 字符合并成语境段落并严格一对一还原', () => {
        const labels = [
            'Plate Settings', 'Plate type', 'Print sequence', 'Spiral vase',
            'First layer filament sequence', 'Auto', 'Customize', 'OK', 'Cancel', 'Reset',
        ];
        const plan = createGoogleImageContext(labels, escape, labels.map((_, index) => index));
        expect(plan.documents).toHaveLength(2);
        expect(plan.documents[0]).toBe(`<p>${labels.slice(0, 8).map((text, idx) => slot(idx, `${text}.`)).join(' ')}</p>`);
        expect(plan.documents[1]).toBe(`<p>${labels.slice(8).map((text, idx) => slot(idx + 8, `${text}.`)).join(' ')}</p>`);
        expect([...plan.labelSlots]).toEqual(labels.map((_, index) => index));

        const zh = ['打印板设置', '打印板类型', '打印顺序', '螺旋花瓶', '首层耗材顺序', '自动', '自定义', '确定', '取消', '重置'];
        const response = [
            `<p>${zh.slice(0, 8).map((text, idx) => slot(idx, `${text}。`)).join(' ')}</p>`,
            `<p>${zh.slice(8).map((text, idx) => slot(idx + 8, `${text}。`)).join(' ')}</p>`,
        ];
        expect(parseGoogleImageContext(response, labels, decode, plan.labelSlots)).toEqual(zh);

        // 超出 1200 字符预算或遇到非纯字母项时断开分组，单项保持 pre
        const oversized = ['A'.repeat(700), 'B'.repeat(700)];
        const overPlan = createGoogleImageContext(oversized, escape, [0, 1]);
        expect(overPlan.labelSlots.size).toBe(0);
        expect(overPlan.documents).toEqual([`<pre>${slot(0, oversized[0])}</pre>`, `<pre>${slot(1, oversized[1])}</pre>`]);

        const mixed = ['Intro.', 'Plate type', 'Auto', 'Note:', 'Cancel'];
        const mixedPlan = createGoogleImageContext(mixed, escape, [1, 2, 3, 4]);
        expect([...mixedPlan.labelSlots]).toEqual([1, 2]);
        expect(mixedPlan.documents).toEqual([
            `<p>${slot(0, 'Intro.')}</p>`,
            `<p>${slot(1, 'Plate type.')} ${slot(2, 'Auto.')}</p>`,
            `<pre>${slot(3, 'Note:')}</pre>`,
            `<pre>${slot(4, 'Cancel')}</pre>`,
        ]);

        // 9 项和 17 项连续标签自动拆为 7+2 和 8+7+2，避免 (8k+1) 尾项孤立退化为 pre
        const nine = Array.from({length: 9}, (_, idx) => `Label ${String.fromCharCode(65 + idx)}`);
        const ninePlan = createGoogleImageContext(nine, escape, nine.map((_, idx) => idx));
        expect(ninePlan.documents).toEqual([
            `<p>${nine.slice(0, 7).map((text, idx) => slot(idx, `${text}.`)).join(' ')}</p>`,
            `<p>${nine.slice(7).map((text, idx) => slot(idx + 7, `${text}.`)).join(' ')}</p>`,
        ]);
        expect([...ninePlan.labelSlots]).toEqual(nine.map((_, idx) => idx));

        const seventeen = Array.from({length: 17}, (_, idx) => `Item ${String.fromCharCode(65 + idx)}`);
        const seventeenPlan = createGoogleImageContext(seventeen, escape, seventeen.map((_, idx) => idx));
        expect(seventeenPlan.documents).toHaveLength(3);
        expect(seventeenPlan.documents[0]).toContain('data-fr-slot="7"');
        expect(seventeenPlan.documents[1]).toContain('data-fr-slot="14"');
        expect(seventeenPlan.documents[2]).toBe(`<p>${slot(15, 'Item P.')} ${slot(16, 'Item Q.')}</p>`);
        expect([...seventeenPlan.labelSlots]).toEqual(seventeen.map((_, idx) => idx));

        // 若第 8、9 项合起来超 1200 字符，则保持 8+pre 不做无效拆分
        const heavyTail = [...Array.from({length: 7}, () => 'A'), 'B'.repeat(700), 'C'.repeat(700)];
        const heavyPlan = createGoogleImageContext(heavyTail, escape, heavyTail.map((_, idx) => idx));
        expect(heavyPlan.documents).toEqual([
            `<p>${heavyTail.slice(0, 8).map((text, idx) => slot(idx, `${text}.`)).join(' ')}</p>`,
            `<pre>${slot(8, heavyTail[8])}</pre>`,
        ]);
        expect([...heavyPlan.labelSlots]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('handlers 为 Google 正确重映射弹窗相邻标签槽位（含首尾项和过滤后偏移）', async () => {
        const {textHandler, translateTexts} = setupHandlers({
            getTranslationService: () => 'google',
            supportsNativeBatch: () => true,
        });
        await textHandler.handle({
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            texts: ['123', 'Plate Settings', 'Plate type', 'Auto', '22%', 'Cancel'],
            imageLabelSlots: [1, 2, 3, 5],
        });
        const request = translateTexts.mock.calls[0]![0];
        expect(request.origin).toEqual(['Plate Settings', 'Plate type', 'Auto', 'Cancel']);
        // 原始 1,2,3 连续保留为 [0,1,2]；原始 5 因前一项 4 被过滤而不构成相邻标签组
        expect(getImageLabelSlots(request)).toEqual([0, 1, 2]);
    });
});
