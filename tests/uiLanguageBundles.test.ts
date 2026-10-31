import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

type I18nModule = typeof import('@/src/core/i18n');
type BundlesModule = typeof import('./helpers/uiLanguageBundles');
type LoaderModule = typeof import('@/src/platform/i18n/uiLanguageBundles');

// 注册表是模块级状态；每个用例重新加载模块，保证“未加载语言”与“已加载语言”互不污染。
async function loadRuntimeModules(): Promise<{i18n: I18nModule; loader: LoaderModule}> {
    vi.resetModules();
    const [i18n, loader] = await Promise.all([
        import('@/src/core/i18n'),
        import('@/src/platform/i18n/uiLanguageBundles'),
    ]);
    return {i18n, loader};
}

async function loadModules(): Promise<{i18n: I18nModule; bundles: BundlesModule; loader: LoaderModule}> {
    const runtime = await loadRuntimeModules();
    const bundles = await import('./helpers/uiLanguageBundles');
    return {...runtime, bundles};
}

function jsonResponse(body: unknown, ok = true, status = 200) {
    return {ok, status, json: async () => body};
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('界面语言注册表', () => {
    let i18n: I18nModule;
    let bundles: BundlesModule;

    beforeEach(async () => {
        ({i18n, bundles} = await loadModules());
    });

    it('未加载的非中文语言回退中文，不把旧文案误判为已本地化', () => {
        expect(i18n.hasUiLanguageBundle('zh-CN')).toBe(true);
        expect(i18n.hasUiLanguageBundle('en-US')).toBe(false);
        expect(i18n.translate('common.brand', 'en-US')).toBe(i18n.translate('common.brand', 'zh-CN'));
        expect(i18n.translate('missing.key', 'ja-JP')).toBe('missing.key');
        expect(i18n.translateLegacyText('  确认清除统计  ', 'en-US')).toBe('  确认清除统计  ');
    });

    it('注册资源包后立即生效，重新注册会丢弃旧的中文反查表', () => {
        const zhSource = i18n.translate('popup.donationTitle', 'zh-CN');
        i18n.registerUiLanguageBundle('fr-FR', {messages: {'popup.donationTitle': 'Version A'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        expect(i18n.translate('popup.donationTitle', 'fr-FR')).toBe('Version A');
        expect(i18n.translateLegacyText(zhSource, 'fr-FR')).toBe('Version A');

        i18n.registerUiLanguageBundle('fr-FR', {messages: {'popup.donationTitle': 'Version B'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        expect(i18n.translateLegacyText(zhSource, 'fr-FR')).toBe('Version B');
    });

    it('静态资源包覆盖六种非中文语言，并生成可被运行时加载器解析的紧凑 JSON', () => {
        const files = bundles.createUiLanguageBundleFiles();
        expect(files.map(({relativeDest}) => relativeDest).sort()).toEqual([
            'i18n/en-US.json', 'i18n/es-ES.json', 'i18n/fr-FR.json',
            'i18n/ja-JP.json', 'i18n/ko-KR.json', 'i18n/ru-RU.json',
        ]);
        for (const {relativeDest, contents} of files) {
            const language = relativeDest.slice('i18n/'.length, -'.json'.length) as keyof typeof bundles.UI_LANGUAGE_BUNDLES;
            expect(contents).not.toContain('\n');
            expect(JSON.parse(contents)).toEqual(bundles.UI_LANGUAGE_BUNDLES[language]);
        }

        bundles.registerAllUiLanguageBundles();
        for (const language of Object.keys(bundles.UI_LANGUAGE_BUNDLES)) {
            expect(i18n.hasUiLanguageBundle(language as keyof typeof bundles.UI_LANGUAGE_BUNDLES)).toBe(true);
        }
        expect(i18n.translate('common.brand', 'en-US')).toBe(bundles.UI_LANGUAGE_BUNDLES['en-US'].messages['common.brand']);
    });

    it('扩展安装 metadata 复用七语品牌和功能说明，不复制界面目录', () => {
        const files = bundles.createExtensionMetadataLocaleFiles();
        expect(files.map(({relativeDest}) => relativeDest).sort()).toEqual([
            '_locales/en/messages.json', '_locales/es/messages.json', '_locales/fr/messages.json',
            '_locales/ja/messages.json', '_locales/ko/messages.json', '_locales/ru/messages.json',
            '_locales/zh_CN/messages.json',
        ]);
        const languageByLocale = {
            zh_CN: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
            fr: 'fr-FR', ru: 'ru-RU', es: 'es-ES',
        } as const;
        bundles.registerAllUiLanguageBundles();
        for (const {relativeDest, contents} of files) {
            const locale = relativeDest.split('/')[1] as keyof typeof languageByLocale;
            const message = JSON.parse(contents);
            expect(Object.keys(message).sort()).toEqual(['extensionDescription', 'extensionName']);
            expect(message.extensionName).toEqual({message: i18n.translate('common.brand', languageByLocale[locale])});
            expect(message.extensionName.message).toBe(locale === 'zh_CN' ? '流畅阅读' : 'FluentRead');
            expect(contents).not.toContain('\n');
        }
        expect(files.filter(({relativeDest}) => relativeDest.startsWith('i18n/'))).toEqual([]);
    });

    it('本地化 PDF 段落进度保留完成数、总量和百分比，七语恢复入口均有文案', () => {
        bundles.registerAllUiLanguageBundles();
        for (const language of ['zh-CN', ...Object.keys(bundles.UI_LANGUAGE_BUNDLES)] as const) {
            const progress = i18n.translate('document.translationProgress.count', language as any, {completed: 35, total: 100, percent: 35});
            expect(progress).toContain('35');
            expect(progress).toContain('100');
            expect(progress).toContain('%');
            expect(progress).not.toMatch(/[{}]/u);
            for (const key of ['document.translationProgress.waitingRetry', 'document.translationProgress.collectingAfterFailure',
                'document.translationRecovery.retry', 'document.translationRecovery.switchService', 'document.translationRecovery.pauseAndSwitch',
                'document.translationRecovery.details', 'document.translationRecovery.interrupted', 'document.translationRecovery.unavailable']) {
                expect(i18n.translate(key, language as any)).not.toBe(key);
            }
            expect(i18n.translate('document.translationRecovery.kept', language as any)).toBe('document.translationRecovery.kept');
        }
        expect(i18n.translate('document.translationProgress.count', 'zh-CN', {completed: 35, total: 100, percent: 35}))
            .toBe('已翻译 35/100 个文本段落（35%）');
        expect(i18n.translate('document.translationRecovery.retry', 'zh-CN')).toBe('重试');
        expect(i18n.translate('document.translationRecovery.switchService', 'zh-CN')).toBe('更换服务');
        expect(i18n.translate('document.translationRecovery.pauseAndSwitch', 'zh-CN')).toBe('暂停并更换服务');
        expect(i18n.translate('document.translationRecovery.details', 'zh-CN')).toBe('详情');
        expect(i18n.translate('document.translationRecovery.interrupted', 'zh-CN')).toBe('翻译暂时中断');
        expect(i18n.translate('document.translationRecovery.unavailable', 'zh-CN')).toBe('当前服务不可用');
        expect(i18n.translate('document.translationRecovery.unavailable', 'en-US')).toBe('Service unavailable');
    });

    it('默认中文入口只消费共享文案的独立中文常量', () => {
        const source = readFileSync(resolve('src/core/i18n/messages/zh-CN.ts'), 'utf8');
        expect(source).toContain("import {pdfReadingChineseMessages} from './pdfReading'");
        expect(source).toContain("import {informationHighlightChineseMessages} from './informationHighlight'");
        expect(source).toContain("import {compositeTranslationChineseMessages} from './compositeTranslation'");
        expect(source).toContain("import {aiRequestTimeoutChineseMessages} from './aiRequestTimeout'");
        expect(source).toContain("import {personalCorrectionChineseMessages} from './personalCorrections'");
        expect(source).not.toMatch(/\b(?:pdfReadingMessages|informationHighlightMessages|compositeTranslationMessages|aiRequestTimeoutMessages|personalCorrectionMessages)\b/u);
    });

    it('独立的七语常量保持完整目录和资源生成的语言映射一致', async () => {
        const [pdf, highlight, chinese, composite, timeout, corrections] = await Promise.all([
            import('@/src/core/i18n/messages/pdfReading'),
            import('@/src/core/i18n/messages/informationHighlight'),
            import('@/src/core/i18n/messages/zh-CN'),
            import('@/src/core/i18n/messages/compositeTranslation'),
            import('@/src/core/i18n/messages/aiRequestTimeout'),
            import('@/src/core/i18n/messages/personalCorrections'),
        ]);
        expect(composite.compositeTranslationMessages['zh-CN']).toBe(composite.compositeTranslationChineseMessages);
        expect(timeout.aiRequestTimeoutMessages['zh-CN']).toBe(timeout.aiRequestTimeoutChineseMessages);
        expect(corrections.personalCorrectionMessages['zh-CN']).toBe(corrections.personalCorrectionChineseMessages);
        const languages = [
            ['zh-CN', pdf.pdfReadingChineseMessages, highlight.informationHighlightChineseMessages],
            ['en-US', pdf.pdfReadingEnglishMessages, highlight.informationHighlightEnglishMessages],
            ['ja-JP', pdf.pdfReadingJapaneseMessages, highlight.informationHighlightJapaneseMessages],
            ['ko-KR', pdf.pdfReadingKoreanMessages, highlight.informationHighlightKoreanMessages],
            ['fr-FR', pdf.pdfReadingFrenchMessages, highlight.informationHighlightFrenchMessages],
            ['ru-RU', pdf.pdfReadingRussianMessages, highlight.informationHighlightRussianMessages],
            ['es-ES', pdf.pdfReadingSpanishMessages, highlight.informationHighlightSpanishMessages],
        ] as const;
        for (const [language, pdfMessages, highlightMessages] of languages) {
            expect(pdf.pdfReadingMessages[language]).toBe(pdfMessages);
            expect(highlight.informationHighlightMessages[language]).toBe(highlightMessages);
            const catalog = language === 'zh-CN' ? chinese.zhCNMessages : bundles.UI_LANGUAGE_BUNDLES[language].messages;
            for (const [key, value] of Object.entries({...(pdfMessages as Readonly<Record<string, string>>),
                ...(highlightMessages as Readonly<Record<string, string>>),
                ...(composite.compositeTranslationMessages[language] as Readonly<Record<string, string>>),
                ...(timeout.aiRequestTimeoutMessages[language] as Readonly<Record<string, string>>),
                ...(corrections.personalCorrectionMessages[language] as Readonly<Record<string, string>>)})) {
                expect(catalog[key as keyof typeof catalog], `${language}: ${key}`).toBe(value);
            }
        }
    });
});

describe('界面语言资源按需加载', () => {
    it('中文和已注册语言不发请求；并发请求同一语言只读取一次并注册', async () => {
        const {i18n, loader} = await loadRuntimeModules();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const fetch = vi.fn(async () => {
            await gate;
            return jsonResponse({messages: {'common.brand': 'Brand EN'}, legacyText: {'确认清除统计': 'Clear stats'}, legacyPatterns: {early: [['^共 (\\d+) 项$', '{1} items']], late: [['^尾(.+)$', 'Tail {1}', [1]]]}});
        });
        const resolveUrl = vi.fn((path: string) => `chrome-extension://id/${path}`);
        const ensure = loader.createUiLanguageBundleLoader({resolveUrl, fetch, warn: vi.fn()});

        await expect(ensure('zh-CN')).resolves.toBe(true);
        await expect(ensure('unsupported')).resolves.toBe(true);
        const first = ensure('en-US');
        const second = ensure('en-US');
        expect(second).toBe(first);
        release();
        await expect(first).resolves.toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        expect(resolveUrl).toHaveBeenCalledWith('i18n/en-US.json');
        expect(i18n.translate('common.brand', 'en-US')).toBe('Brand EN');
        expect(i18n.translateLegacyText('确认清除统计', 'en-US')).toBe('Clear stats');
        expect(i18n.translateLegacyText('共 3 项', 'en-US')).toBe('3 items');
        expect(i18n.translateLegacyText('尾确认清除统计', 'en-US')).toBe('Tail Clear stats');

        await expect(ensure('en-US')).resolves.toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
        ['HTTP 失败', () => jsonResponse({}, false, 404)],
        ['资源形状无效', () => jsonResponse({messages: [], legacyText: {}, legacyPatterns: {early: [], late: []}})],
        ['模板集合缺失', () => jsonResponse({messages: {}, legacyText: {}})],
        ['模板条目不是数组', () => jsonResponse({messages: {}, legacyText: {}, legacyPatterns: {early: ['^a$'], late: []}})],
        ['模板译文不是字符串', () => jsonResponse({messages: {}, legacyText: {}, legacyPatterns: {early: [], late: [['^a$', 1]]}})],
        ['捕获序号不是整数', () => jsonResponse({messages: {}, legacyText: {}, legacyPatterns: {early: [['^a(.+)$', '{1}', ['1']]], late: []}})],
        ['缺少旧文案表', () => jsonResponse({messages: {}})],
        ['非对象响应', () => jsonResponse(null)],
    ])('%s时回退中文、报告警告，并允许下一次重新读取', async (_label, response) => {
        const {i18n, loader} = await loadRuntimeModules();
        const fetch = vi.fn(async () => response());
        const warn = vi.fn();
        const ensure = loader.createUiLanguageBundleLoader({resolveUrl: (path) => path, fetch, warn});

        await expect(ensure('ru-RU')).resolves.toBe(false);
        expect(warn).toHaveBeenCalledOnce();
        expect(i18n.hasUiLanguageBundle('ru-RU')).toBe(false);
        await expect(ensure('ru-RU')).resolves.toBe(false);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('地址解析同步抛错也降级为失败结果，而不是让页面启动流程中断', async () => {
        const {loader} = await loadRuntimeModules();
        const warn = vi.fn();
        const ensure = loader.createUiLanguageBundleLoader({
            resolveUrl: () => { throw new Error('runtime gone'); },
            fetch: vi.fn(),
            warn,
        });
        await expect(ensure('ko-KR')).resolves.toBe(false);
        expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    });

    it('默认实现通过 browser 或 chrome runtime 读取扩展自身资源，运行时缺失时回退中文', async () => {
        const bundle = {messages: {'common.brand': 'Marca'}, legacyText: {}, legacyPatterns: {early: [], late: []}};
        const fetch = vi.fn(async (url: string) => jsonResponse(url.endsWith('es-ES.json') || url.endsWith('ja-JP.json') ? bundle : {}));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('fetch', fetch);

        vi.stubGlobal('browser', {runtime: {getURL: (path: string) => `moz-extension://id/${path}`}});
        let {i18n, loader} = await loadRuntimeModules();
        await expect(loader.ensureUiLanguageBundle('es-ES')).resolves.toBe(true);
        expect(fetch).toHaveBeenLastCalledWith('moz-extension://id/i18n/es-ES.json');
        expect(i18n.translate('common.brand', 'es-ES')).toBe('Marca');

        vi.stubGlobal('browser', undefined);
        vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://id/${path}`}});
        ({i18n, loader} = await loadRuntimeModules());
        await expect(loader.ensureUiLanguageBundle('ja-JP')).resolves.toBe(true);
        expect(fetch).toHaveBeenLastCalledWith('chrome-extension://id/i18n/ja-JP.json');

        vi.stubGlobal('chrome', {runtime: {}});
        ({loader} = await loadRuntimeModules());
        await expect(loader.ensureUiLanguageBundle('fr-FR')).resolves.toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('UI language bundle unavailable'), expect.any(Error));
    });

    it('非响应式 UI 立即渲染一次，资源未注册时加载成功后补渲染，失败或已注册时不重复', async () => {
        const {i18n, loader} = await loadRuntimeModules();
        const render = vi.fn();
        let resolveLoad!: (loaded: boolean) => void;
        const ensure = vi.fn(() => new Promise<boolean>((resolve) => { resolveLoad = resolve; }));

        loader.renderWithUiLanguageBundle('zh-CN', render, ensure);
        expect(render).toHaveBeenCalledOnce();
        expect(ensure).not.toHaveBeenCalled();

        loader.renderWithUiLanguageBundle('en-US', render, ensure);
        expect(render).toHaveBeenCalledTimes(2);
        resolveLoad(true);
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));

        loader.renderWithUiLanguageBundle('ja-JP', render, ensure);
        resolveLoad(false);
        await Promise.resolve(); await Promise.resolve();
        expect(render).toHaveBeenCalledTimes(4);

        i18n.registerUiLanguageBundle('ko-KR', {messages: {}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        loader.renderWithUiLanguageBundle('ko-KR', render);
        expect(render).toHaveBeenCalledTimes(5);
        expect(ensure).toHaveBeenCalledTimes(2);
    });
});
