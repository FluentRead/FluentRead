import {describe, expect, it, vi} from 'vitest';
import {detectChineseScript} from '@/src/core/language/detect';
import {
    CHROME_TRANSLATION_PREPARATION_LANGUAGES,
    ChromeTranslationPreparationError,
    getChromeTranslationPreparationLanguageLabel,
    prepareChromeTranslationInPage,
    resolveChromeTranslationPreparationPair,
    type ChromeTranslationPreparationEnvironment,
    type ChromeTranslationPreparationStatus,
} from '@/src/features/settings/model/chromeTranslationPreparation';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

function namedError(name: string, message = name): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

it('检测模型较晚就绪时复用已经创建的翻译模型完成自检',async()=>{
    const environment=readyEnvironment(),detector=await environment.LanguageDetector!.create(),ready=deferred<typeof detector>();
    environment.LanguageDetector!.create=vi.fn(()=>ready.promise);const statuses:ChromeTranslationPreparationStatus[]=[];
    const work=prepareChromeTranslationInPage({from:'fr',to:'en',onStatus:value=>statuses.push(value)},environment);
    await Promise.resolve();await Promise.resolve();ready.resolve(detector);
    await expect(work).resolves.toMatchObject({sourceLanguage:'fr',targetLanguage:'en'});
    expect(environment.Translator!.create).toHaveBeenCalledOnce();expect(statuses.at(-1)?.phase).toBe('verifying');
});

function readyEnvironment(
    detectedLanguage = 'fr',
    translatedText: unknown = 'The local model is ready.',
    destroyDetector: () => void = vi.fn(),
    destroyTranslator: () => void = vi.fn(),
): ChromeTranslationPreparationEnvironment {
    return {
        LanguageDetector: {
            create: vi.fn(async () => ({
                detect: vi.fn(async () => [{detectedLanguage, confidence: 0.99}]),
                destroy: destroyDetector,
            })),
        },
        Translator: {
            create: vi.fn(async () => ({
                translate: vi.fn(async () => translatedText),
                destroy: destroyTranslator,
            })),
        },
    };
}

describe('Chrome 设置页本地模型准备', () => {
    it.each(['initializing', 'verifying'] as const)('状态%s回调取消后不再启动后续API操作', async phase => {
        const controller = new AbortController(), environment = readyEnvironment();
        const detector = {detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]), destroy: vi.fn()};
        const translator = {translate: vi.fn(async () => 'Ready'), destroy: vi.fn()};
        vi.mocked(environment.LanguageDetector!.create).mockResolvedValue(detector);
        vi.mocked(environment.Translator!.create).mockResolvedValue(translator);
        await expect(prepareChromeTranslationInPage({from: 'fr', to: 'en', signal: controller.signal,
            onStatus: status => {if (status.phase === phase) controller.abort();}}, environment)).rejects.toMatchObject({name: 'AbortError'});
        expect(detector.detect).not.toHaveBeenCalled();expect(translator.translate).not.toHaveBeenCalled();
        expect(environment.LanguageDetector!.create).toHaveBeenCalledTimes(phase === 'initializing' ? 0 : 1);
        expect(environment.Translator!.create).toHaveBeenCalledTimes(phase === 'initializing' ? 0 : 1);
        if (phase === 'verifying') {expect(detector.destroy).toHaveBeenCalledOnce();expect(translator.destroy).toHaveBeenCalledOnce();}
    });
    it('创建API同步触发取消且随后拒绝时，取消结果保持并消费迟到拒绝', async () => {
        const controller = new AbortController(), environment = readyEnvironment(), destroy = vi.fn();
        vi.mocked(environment.LanguageDetector!.create).mockImplementation(() => {controller.abort();return Promise.reject(new Error('late factory rejection'));});
        vi.mocked(environment.Translator!.create).mockResolvedValue({translate: async () => 'Ready', destroy});
        await expect(prepareChromeTranslationInPage({from: 'fr', to: 'en', signal: controller.signal}, environment)).rejects.toMatchObject({name: 'AbortError'});
        for (let i = 0; i < 12; i++) await Promise.resolve();expect(destroy).toHaveBeenCalledOnce();
    });
    it('自动源语言只准备一个与目标不同的确定性语言对', () => {
        const toEnglish = resolveChromeTranslationPreparationPair(' auto ', ' en ');
        expect(toEnglish).toEqual({
            sourceLanguage: 'fr',
            targetLanguage: 'en',
            sampleText: expect.stringContaining('française'),
        });
        expect(resolveChromeTranslationPreparationPair('AUTO', 'EN-us')).toMatchObject({
            sourceLanguage: 'fr',
            targetLanguage: 'en-us',
        });
        expect(resolveChromeTranslationPreparationPair('auto', 'zh-Hans')).toMatchObject({
            sourceLanguage: 'en',
            targetLanguage: 'zh',
        });
    });

    it('显式源语言保持实际语言并规范化 Chrome 中文别名', () => {
        expect(resolveChromeTranslationPreparationPair('EN-us', 'ja')).toMatchObject({
            sourceLanguage: 'en-us',
            targetLanguage: 'ja',
            sampleText: expect.stringContaining('English'),
        });
        expect(resolveChromeTranslationPreparationPair('zh-CN', 'en')).toMatchObject({
            sourceLanguage: 'zh',
            sampleText: expect.stringContaining('简体中文'),
        });
        expect(resolveChromeTranslationPreparationPair('zh-TW', 'en')).toMatchObject({
            sourceLanguage: 'zh-Hant',
            sampleText: expect.stringContaining('繁體中文'),
        });
        for (const alias of ['zh-SG', 'zh-Hans']) {
            expect(resolveChromeTranslationPreparationPair(alias, 'fr').sourceLanguage).toBe('zh');
        }
        for (const alias of ['zh-Hant', 'zh-HK', 'zh-MO']) {
            expect(resolveChromeTranslationPreparationPair(alias, 'fr').sourceLanguage).toBe('zh-Hant');
        }
    });

    it('显式源语言与目标相同时替换校验源语言并始终保留用户目标', () => {
        expect(resolveChromeTranslationPreparationPair('en', 'en')).toMatchObject({
            sourceLanguage: 'fr',
            targetLanguage: 'en',
        });
        expect(resolveChromeTranslationPreparationPair('fr-FR', 'fr')).toMatchObject({
            sourceLanguage: 'en',
            targetLanguage: 'fr',
        });
        expect(resolveChromeTranslationPreparationPair('zh-Hans', 'zh-CN')).toMatchObject({
            sourceLanguage: 'en',
            targetLanguage: 'zh',
        });
        expect(resolveChromeTranslationPreparationPair('zh-Hant', 'zh-TW')).toMatchObject({
            sourceLanguage: 'en',
            targetLanguage: 'zh-Hant',
        });
    });

    it('为 Chrome 官方支持的全部显式源语言提供可检测的完整校验句', () => {
        expect(CHROME_TRANSLATION_PREPARATION_LANGUAGES).toHaveLength(39);
        expect(new Set(CHROME_TRANSLATION_PREPARATION_LANGUAGES.map(item => item.value)).size).toBe(39);
        for (const {value: source, label} of CHROME_TRANSLATION_PREPARATION_LANGUAGES) {
            const pair = resolveChromeTranslationPreparationPair(source, source === 'en' ? 'zh-Hans' : 'en');
            expect(pair.sourceLanguage).toBe(source);
            expect(pair.sampleText.length).toBeGreaterThan(20);
            expect(label.trim()).not.toBe('');
        }
    });

    it('为自动选择的检查语言生成当前界面语言的名称', () => {
        const uiLanguages = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;
        for (const uiLanguage of uiLanguages) {
            const labels = CHROME_TRANSLATION_PREPARATION_LANGUAGES.map(({value}) => (
                getChromeTranslationPreparationLanguageLabel(value, uiLanguage)
            ));
            expect(labels).toHaveLength(39);
            expect(labels.every(label => label.trim().length > 0)).toBe(true);
        }

        expect(getChromeTranslationPreparationLanguageLabel('fr', 'en-US')).toBe('French');
        expect(getChromeTranslationPreparationLanguageLabel('fr', 'ja-JP')).toBe('フランス語');
        expect(getChromeTranslationPreparationLanguageLabel('fr', 'ko-KR')).toBe('프랑스어');
        expect(getChromeTranslationPreparationLanguageLabel('zh', 'en-US')).toBe('Simplified Chinese');
        expect(getChromeTranslationPreparationLanguageLabel('zh-Hant', 'en-US')).toBe('Traditional Chinese');
        expect(CHROME_TRANSLATION_PREPARATION_LANGUAGES.map(({value}) => (
            getChromeTranslationPreparationLanguageLabel(value, 'en-US')
        )).join(' ')).not.toMatch(/[\u3400-\u9fff]/u);
        expect(getChromeTranslationPreparationLanguageLabel('fr', 'invalid_locale!')).toBe('法语');
        expect(getChromeTranslationPreparationLanguageLabel('unknown', 'invalid_locale!')).toBe('unknown');

        const displayNames = Intl.DisplayNames;
        try {
            Object.defineProperty(Intl, 'DisplayNames', {
                configurable: true,
                value: class {
                    of(): undefined { return undefined; }
                },
            });
            expect(getChromeTranslationPreparationLanguageLabel('fr', 'en-US')).toBe('法语');
        } finally {
            Object.defineProperty(Intl, 'DisplayNames', {configurable: true, value: displayNames});
        }
    });

    it('拒绝非法语言代码、auto 目标和没有校验文本的显式源语言', () => {
        expect(() => resolveChromeTranslationPreparationPair('', 'en')).toThrow('from 语言代码无效');
        expect(() => resolveChromeTranslationPreparationPair('bad!', 'en')).toThrow('from 语言代码无效');
        expect(() => resolveChromeTranslationPreparationPair('en', '')).toThrow('to 语言代码无效');
        expect(() => resolveChromeTranslationPreparationPair('en', 'auto')).toThrow('to 语言代码无效');
        expect(() => resolveChromeTranslationPreparationPair('eo', 'en')).toThrow('暂时无法为源语言 eo');
        try {
            resolveChromeTranslationPreparationPair('bad!', 'en');
        } catch (error) {
            expect(error).toBeInstanceOf(ChromeTranslationPreparationError);
            expect(error).toMatchObject({code: 'invalid-language-code', params: {field: 'from'}});
        }
        try {
            resolveChromeTranslationPreparationPair('eo', 'en');
        } catch (error) {
            expect(error).toMatchObject({code: 'sample-unavailable', params: {sourceLanguage: 'eo'}});
        }
    });

    it('在首个等待点前并行启动 detector 与 translator create 并完整自检', async () => {
        const detectorReady = deferred<{detect: (text: string) => Promise<unknown>; destroy: () => void}>();
        const translatorReady = deferred<{translate: (text: string) => Promise<unknown>; destroy: () => void}>();
        const detect = vi.fn(async () => [{detectedLanguage: 'fr-FR', confidence: 0.99}]);
        const translate = vi.fn(async () => 'The local translation model understands this sentence.');
        const destroyDetector = vi.fn();
        const destroyTranslator = vi.fn();
        const detectorCreate = vi.fn(() => detectorReady.promise);
        const translatorCreate = vi.fn(() => translatorReady.promise);
        const statuses: ChromeTranslationPreparationStatus[] = [];
        const preparation = prepareChromeTranslationInPage({
            from: 'auto',
            to: 'en',
            onStatus: (status) => statuses.push(status),
        }, {
            LanguageDetector: {create: detectorCreate},
            Translator: {create: translatorCreate},
        });

        expect(detectorCreate).toHaveBeenCalledOnce();
        expect(translatorCreate).toHaveBeenCalledOnce();
        expect(translatorCreate).toHaveBeenCalledWith(expect.objectContaining({
            sourceLanguage: 'fr',
            targetLanguage: 'en',
            monitor: expect.any(Function),
        }));
        detectorReady.resolve({detect, destroy: destroyDetector});
        translatorReady.resolve({translate, destroy: destroyTranslator});

        await expect(preparation).resolves.toMatchObject({
            sourceLanguage: 'fr',
            targetLanguage: 'en',
            detectedLanguage: 'fr-FR',
            translatedText: 'The local translation model understands this sentence.',
        });
        const sampleText = resolveChromeTranslationPreparationPair('auto', 'en').sampleText;
        expect(detect).toHaveBeenCalledWith(sampleText);
        expect(translate).toHaveBeenCalledWith(sampleText);
        expect(destroyDetector).toHaveBeenCalledOnce();
        expect(destroyTranslator).toHaveBeenCalledOnce();
        expect(statuses.map((status) => status.phase)).toEqual(['initializing', 'initializing', 'verifying']);
        expect(statuses[1].model).toBe('translator');
    });

    it('从两个模型转发合法 downloadprogress 并忽略畸形进度', async () => {
        const listeners = new Map<string, (event: {loaded?: unknown}) => void>();
        const createResource = (
            model: string,
            options: {monitor?: (monitor: {addEventListener: (
                type: 'downloadprogress',
                listener: (event: {loaded?: unknown}) => void,
            ) => void}) => void},
            resource: object,
        ) => {
            options.monitor?.({
                addEventListener: (type, listener) => {
                    expect(type).toBe('downloadprogress');
                    listeners.set(model, listener);
                },
            });
            for (const loaded of [undefined, '0.5', Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
                listeners.get(model)?.({loaded});
            }
            listeners.get(model)?.({loaded: model === 'detector' ? 0 : 0.375});
            listeners.get(model)?.({loaded: model === 'detector' ? 0.004 : 0.376});
            listeners.get(model)?.({loaded: 1});
            return Promise.resolve(resource);
        };
        const statuses: ChromeTranslationPreparationStatus[] = [];
        await prepareChromeTranslationInPage({
            from: 'auto',
            to: 'en',
            onStatus: (status) => statuses.push(status),
        }, {
            LanguageDetector: {
                create: vi.fn((options) => createResource('detector', options ?? {}, {
                    detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]),
                }) as Promise<never>),
            },
            Translator: {
                create: vi.fn((options) => createResource('translator', options, {
                    translate: vi.fn(async () => 'Ready'),
                }) as Promise<never>),
            },
        });

        expect(statuses.filter((status) => status.phase === 'downloading')).toEqual([
            {phase: 'downloading', model: 'language-detector', loaded: 0, sourceLanguage: 'fr', targetLanguage: 'en'},
            {phase: 'downloading', model: 'language-detector', loaded: 1, sourceLanguage: 'fr', targetLanguage: 'en'},
            {phase: 'downloading', model: 'translator', loaded: 0.375, sourceLanguage: 'fr', targetLanguage: 'en'},
            {phase: 'downloading', model: 'translator', loaded: 1, sourceLanguage: 'fr', targetLanguage: 'en'},
        ]);
    });

    it('带 signal 完成准备时也把同一信号传给 detect 与 translate', async () => {
        const controller = new AbortController();
        const detect = vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]);
        const translate = vi.fn(async () => 'Ready');
        await prepareChromeTranslationInPage({from: 'fr', to: 'en', signal: controller.signal}, {
            LanguageDetector: {create: vi.fn(async () => ({detect}))},
            Translator: {create: vi.fn(async () => ({translate}))},
        });
        const sample = resolveChromeTranslationPreparationPair('fr', 'en').sampleText;
        expect(detect).toHaveBeenCalledWith(sample, {signal: controller.signal});
        expect(translate).toHaveBeenCalledWith(sample, {signal: controller.signal});
    });

    it('状态回调抛错或缺省时都不影响模型准备', async () => {
        const reporter = vi.fn(() => { throw new Error('UI detached'); });
        await expect(prepareChromeTranslationInPage({
            from: 'auto',
            to: 'en',
            onStatus: reporter,
        }, readyEnvironment())).resolves.toMatchObject({sourceLanguage: 'fr', targetLanguage: 'en'});
        expect(reporter).toHaveBeenCalled();
        await expect(prepareChromeTranslationInPage(
            {from: 'auto', to: 'en'},
            readyEnvironment(),
        )).resolves.toMatchObject({sourceLanguage: 'fr', targetLanguage: 'en'});
    });

    it('默认从当前扩展页面读取现代 API', async () => {
        const detectorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'LanguageDetector');
        const translatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Translator');
        Object.defineProperty(globalThis, 'LanguageDetector', {
            configurable: true,
            value: readyEnvironment().LanguageDetector,
        });
        Object.defineProperty(globalThis, 'Translator', {
            configurable: true,
            value: readyEnvironment().Translator,
        });
        try {
            await expect(prepareChromeTranslationInPage({from: 'auto', to: 'en'}))
                .resolves.toMatchObject({sourceLanguage: 'fr', targetLanguage: 'en'});
        } finally {
            if (detectorDescriptor) Object.defineProperty(globalThis, 'LanguageDetector', detectorDescriptor);
            else delete (globalThis as Record<string, unknown>).LanguageDetector;
            if (translatorDescriptor) Object.defineProperty(globalThis, 'Translator', translatorDescriptor);
            else delete (globalThis as Record<string, unknown>).Translator;
        }
    });

    it('缺少任一现代 API 时明确失败且不回退 legacy 接口', async () => {
        const createDetector = vi.fn(async () => ({detect: vi.fn()}));
        const createTranslator = vi.fn(async () => ({translate: vi.fn()}));
        for (const environment of [
            {},
            {LanguageDetector: {create: createDetector}},
            {LanguageDetector: {} as never, Translator: {create: createTranslator}},
        ]) {
            await expect(prepareChromeTranslationInPage(
                {from: 'auto', to: 'en'},
                environment,
            )).rejects.toThrow('不支持 Chrome 现代 LanguageDetector/Translator API');
        }
        expect(createDetector).not.toHaveBeenCalled();
        expect(createTranslator).not.toHaveBeenCalled();
    });

    it('把取消信号传给 create 和自检，并在取消后释放迟到资源', async () => {
        const controller = new AbortController();
        const detectorReady = deferred<{detect: (text: string, options?: {signal?: AbortSignal}) => Promise<unknown>; destroy: () => void}>();
        const translatorReady = deferred<{translate: (text: string, options?: {signal?: AbortSignal}) => Promise<unknown>; destroy: () => void}>();
        const destroyDetector = vi.fn();
        const destroyTranslator = vi.fn();
        let reportLateProgress!: (event: {loaded?: unknown}) => void;
        const detectorCreate = vi.fn((options?: {monitor?: (monitor: {addEventListener: (
            type: 'downloadprogress',
            listener: (event: {loaded?: unknown}) => void,
        ) => void}) => void}) => {
            options?.monitor?.({addEventListener: (_type, listener) => { reportLateProgress = listener; }});
            return detectorReady.promise;
        });
        const translatorCreate = vi.fn(() => translatorReady.promise);
        const statuses: ChromeTranslationPreparationStatus[] = [];
        const preparation = prepareChromeTranslationInPage({
            from: 'fr',
            to: 'en',
            signal: controller.signal,
            onStatus: status => statuses.push(status),
        }, {
            LanguageDetector: {create: detectorCreate},
            Translator: {create: translatorCreate},
        });

        expect(detectorCreate).toHaveBeenCalledWith(expect.objectContaining({signal: controller.signal}));
        expect(translatorCreate).toHaveBeenCalledWith(expect.objectContaining({signal: controller.signal}));
        controller.abort();
        reportLateProgress({loaded: 0.5});
        await expect(preparation).rejects.toMatchObject({name: 'AbortError'});
        expect(statuses.map(status => status.phase)).toEqual(['initializing']);
        detectorReady.resolve({
            detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]),
            destroy: destroyDetector,
        });
        translatorReady.resolve({translate: vi.fn(async () => 'Ready'), destroy: destroyTranslator});
        await Promise.resolve();
        await Promise.resolve();
        expect(destroyDetector).toHaveBeenCalledOnce();
        expect(destroyTranslator).toHaveBeenCalledOnce();
    });

    it('预先取消时不启动任何模型', async () => {
        const controller = new AbortController();
        controller.abort();
        const environment = readyEnvironment();
        await expect(prepareChromeTranslationInPage({
            from: 'fr',
            to: 'en',
            signal: controller.signal,
        }, environment)).rejects.toMatchObject({name: 'AbortError'});
        expect(environment.LanguageDetector!.create).not.toHaveBeenCalled();
        expect(environment.Translator!.create).not.toHaveBeenCalled();
    });

    it('带 signal 的底层失败保留原始错误并移除取消监听', async () => {
        const controller = new AbortController();
        const failure = new Error('detector create failed with signal');
        await expect(prepareChromeTranslationInPage({
            from: 'fr',
            to: 'en',
            signal: controller.signal,
        }, {
            LanguageDetector: {create: vi.fn(async () => { throw failure; })},
            Translator: {create: vi.fn(async () => ({
                translate: vi.fn(async () => 'Ready'),
                destroy: vi.fn(),
            }))},
        })).rejects.toBe(failure);
    });

    it('把同步 NotAllowedError 转为包含实际语言对的可操作提示并清理迟到资源', async () => {
        const translatorReady = deferred<{translate: (text: string) => Promise<string>; destroy: () => void}>();
        const destroyTranslator = vi.fn();
        const translatorCreate = vi.fn(() => translatorReady.promise);
        const detectorCreate = vi.fn(() => {
            throw namedError('NotAllowedError');
        });
        const preparation = prepareChromeTranslationInPage({from: 'auto', to: 'en'}, {
            LanguageDetector: {create: detectorCreate},
            Translator: {create: translatorCreate},
        });

        await expect(preparation).rejects.toMatchObject({
            code: 'user-activation-required',
            params: {sourceLanguage: 'fr', targetLanguage: 'en'},
            message: expect.stringContaining('再次点击“准备 Chrome 本地翻译”继续准备 fr → en'),
        });
        expect(translatorCreate).toHaveBeenCalledOnce();
        translatorReady.resolve({translate: vi.fn(async () => 'Ready'), destroy: destroyTranslator});
        await Promise.resolve();
        await Promise.resolve();
        expect(destroyTranslator).toHaveBeenCalledOnce();
    });

    it('translator 立即失败时也会释放迟到的 detector 资源', async () => {
        const detectorReady = deferred<{detect: (text: string) => Promise<unknown>; destroy: () => void}>();
        const destroyDetector = vi.fn();
        const preparation = prepareChromeTranslationInPage({from: 'auto', to: 'en'}, {
            LanguageDetector: {create: vi.fn(() => detectorReady.promise)},
            Translator: {create: vi.fn(() => { throw new Error('translator create failed'); })},
        });

        await expect(preparation).rejects.toThrow('translator create failed');
        detectorReady.resolve({
            detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]),
            destroy: destroyDetector,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(destroyDetector).toHaveBeenCalledOnce();
    });

    it('中文自检的 NotSupportedError 不误报不支持中文，并保留浏览器原始原因', async () => {
        const destroyDetector = vi.fn();
        await expect(prepareChromeTranslationInPage({from: 'en', to: 'zh-Hans'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({detect: vi.fn(), destroy: destroyDetector})),
            },
            Translator: {
                create: vi.fn(async () => { throw namedError('NotSupportedError', 'Unable to create translator for the given source and target language.'); }),
            },
        })).rejects.toMatchObject({
            code: 'model-unavailable',
            params: {sourceLanguage: 'en', targetLanguage: 'zh', detail: 'Unable to create translator for the given source and target language.'},
            message: expect.stringContaining('当前 Chrome 无法创建本地翻译模型'),
        });
        expect(destroyDetector).toHaveBeenCalledOnce();
    });

    it('拒绝畸形语言检测结果并在每次失败后释放两个模型', async () => {
        for (const detectedValue of [
            null,
            [],
            [{}],
            [{detectedLanguage: 1, confidence: 0.99}],
            [{detectedLanguage: 'fr'}],
            [{detectedLanguage: ' ', confidence: 0.99}],
            [{detectedLanguage: 'bad!', confidence: 0.99}],
            [{detectedLanguage: 'fr', confidence: Number.NaN}],
            [{detectedLanguage: 'fr', confidence: 0.39}],
            [{detectedLanguage: 'fr', confidence: 1.01}],
        ]) {
            const destroyDetector = vi.fn();
            const destroyTranslator = vi.fn();
            const environment = readyEnvironment('fr', 'Ready', destroyDetector, destroyTranslator);
            environment.LanguageDetector!.create = vi.fn(async () => ({
                detect: vi.fn(async () => detectedValue),
                destroy: destroyDetector,
            }));
            await expect(prepareChromeTranslationInPage(
                {from: 'auto', to: 'en'},
                environment,
            )).rejects.toMatchObject({code: 'invalid-detection'});
            expect(destroyDetector).toHaveBeenCalledOnce();
            expect(destroyTranslator).toHaveBeenCalledOnce();
        }
    });

    it('拒绝与校验源语言不一致的检测结果', async () => {
        await expect(prepareChromeTranslationInPage(
            {from: 'auto', to: 'en'},
            readyEnvironment('en'),
        )).rejects.toMatchObject({
            code: 'detection-mismatch',
            params: {expectedLanguage: 'fr', detectedLanguage: 'en'},
        });
    });

    it('接受同一语言的地区检测码和 Chrome 151 中文脚本码', async () => {
        await expect(prepareChromeTranslationInPage(
            {from: 'en-US', to: 'ja'},
            readyEnvironment('en-GB'),
        )).resolves.toMatchObject({sourceLanguage: 'en-us', detectedLanguage: 'en-GB'});
        await expect(prepareChromeTranslationInPage(
            {from: 'zh-CN', to: 'en'},
            readyEnvironment('zh-Hans'),
        )).resolves.toMatchObject({sourceLanguage: 'zh', detectedLanguage: 'zh-Hans'});
        await expect(prepareChromeTranslationInPage(
            {from: 'zh-TW', to: 'en'},
            readyEnvironment('zh-Hant'),
        )).resolves.toMatchObject({sourceLanguage: 'zh-Hant', detectedLanguage: 'zh-Hant'});
    });

    it('拒绝非字符串和空白翻译结果', async () => {
        for (const translatedValue of [null, '   ']) {
            await expect(prepareChromeTranslationInPage(
                {from: 'auto', to: 'en'},
                readyEnvironment('fr', translatedValue),
            )).rejects.toMatchObject({code: 'invalid-translation'});
        }
    });

    it('保留普通 Error，规范化非 Error 失败并忽略资源销毁异常', async () => {
        const original = new Error('detect failed');
        await expect(prepareChromeTranslationInPage({from: 'auto', to: 'en'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({
                    detect: vi.fn(async () => { throw original; }),
                    destroy: vi.fn(() => { throw new Error('detector cleanup failed'); }),
                })),
            },
            Translator: {
                create: vi.fn(async () => ({
                    translate: vi.fn(async () => 'Ready'),
                    destroy: vi.fn(() => { throw new Error('translator cleanup failed'); }),
                })),
            },
        })).rejects.toBe(original);

        await expect(prepareChromeTranslationInPage({from: 'auto', to: 'en'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}])})),
            },
            Translator: {
                create: vi.fn(async () => { throw 0; }),
            },
        })).rejects.toThrow('Chrome 本地翻译准备失败');
        await expect(prepareChromeTranslationInPage({from: 'auto', to: 'en'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}])})),
            },
            Translator: {
                create: vi.fn(async () => { throw 'translator failed'; }),
            },
        })).rejects.toThrow('translator failed');
    });
});

describe('Chrome 简繁体准备对', () => {
    it.each([
        ['zh-Hans-HK', 'zh-Hant-CN', 'zh', 'zh-Hant', 'zh-Hans'],
        ['zh-Hant-CN', 'zh-Hans-HK', 'zh-Hant', 'zh', 'zh-Hant'],
    ])('%s → %s 保持真实语言对且泛中文自检按样本精化', async (from, to, sourceLanguage, targetLanguage, detectedLanguage) => {
        const environment = readyEnvironment('zh');
        await expect(prepareChromeTranslationInPage({from, to}, environment)).resolves.toMatchObject({sourceLanguage, targetLanguage, detectedLanguage});
        expect(environment.Translator!.create).toHaveBeenCalledWith(expect.objectContaining({sourceLanguage, targetLanguage}));
    });
});

describe('Chrome 固定校验样例的语言合约', () => {
    it.each(CHROME_TRANSLATION_PREPARATION_LANGUAGES)('$value 的泛中文结果与真实样例检测一致', async ({value: from}) => {
        const to = from === 'en' ? 'fr' : 'en';
        const pair = resolveChromeTranslationPreparationPair(from, to);
        const script = detectChineseScript(pair.sampleText);
        for (const nativeCode of ['zh', 'ZH']) {
            const destroyDetector = vi.fn(), destroyTranslator = vi.fn();
            const environment = readyEnvironment(nativeCode, 'Ready', destroyDetector, destroyTranslator);
            const preparation = prepareChromeTranslationInPage({from, to}, environment);
            if (script) {
                await expect(preparation).resolves.toMatchObject({
                    ...pair,
                    detectedLanguage: `zh-${script}`,
                });
            } else {
                await expect(preparation).rejects.toMatchObject({
                    code: 'detection-mismatch',
                    params: {expectedLanguage: pair.sourceLanguage, detectedLanguage: nativeCode},
                });
            }
            expect(destroyDetector).toHaveBeenCalledOnce();
            expect(destroyTranslator).toHaveBeenCalledOnce();
        }
    });

    it.each([
        'zh-CN', 'zh-SG', 'zh-Hans', 'zh-TW', 'zh-HK', 'zh-MO',
        'zh-Hans-HK', 'zh-Hant-CN', 'zh-Latn', 'zh-foo',
    ])('%s 的泛中文结果依据公开解析取得的固定样例', async from => {
        const pair = resolveChromeTranslationPreparationPair(from, 'en');
        const script = detectChineseScript(pair.sampleText);
        expect(script).toBeDefined();
        await expect(prepareChromeTranslationInPage({from, to: 'en'}, readyEnvironment('zh')))
            .resolves.toMatchObject({...pair, detectedLanguage: `zh-${script}`});
    });

    it.each([
        ['zh-Hans-HK', 'zh-Hant'],
        ['zh-Hant-CN', 'zh-Hans'],
    ])('%s 不接受明确相反的检测脚本 %s', async (from, detectedLanguage) => {
        const pair = resolveChromeTranslationPreparationPair(from, 'en');
        const destroyDetector = vi.fn(), destroyTranslator = vi.fn();
        const environment = readyEnvironment(detectedLanguage, 'Ready', destroyDetector, destroyTranslator);
        await expect(prepareChromeTranslationInPage({from, to: 'en'}, environment)).rejects.toMatchObject({
            code: 'detection-mismatch',
            params: {expectedLanguage: pair.sourceLanguage, detectedLanguage},
        });
        expect(destroyDetector).toHaveBeenCalledOnce();
        expect(destroyTranslator).toHaveBeenCalledOnce();
    });

    it.each([
        [0.399, false], [0.4, true], [1, true], [1.01, false],
    ])('固定样例置信度 %s 的接受结果保持为 %s', async (confidence, accepted) => {
        const destroyDetector = vi.fn(), destroyTranslator = vi.fn();
        const environment = readyEnvironment('fr', 'Ready', destroyDetector, destroyTranslator);
        vi.mocked(environment.LanguageDetector!.create).mockResolvedValue({
            detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence}]),
            destroy: destroyDetector,
        });
        const preparation = prepareChromeTranslationInPage({from: 'fr', to: 'en'}, environment);
        if (accepted) await expect(preparation).resolves.toMatchObject({detectedLanguage: 'fr'});
        else await expect(preparation).rejects.toMatchObject({code: 'invalid-detection'});
        expect(destroyDetector).toHaveBeenCalledOnce();
        expect(destroyTranslator).toHaveBeenCalledOnce();
    });
});
