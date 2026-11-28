import {hasBrowserTranslationApi} from '@/src/platform/browser/capabilities';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MIN_CHROME_LANGUAGE_CONFIDENCE as sharedConfidence} from '@/src/core/language/confidence';
import {MIN_CHROME_LANGUAGE_CONFIDENCE as detectionConfidence} from '@/src/core/language/detect';
import {
    detectChromeLanguage,
    disposeChromeTranslationModels,
    detectLanguageByScript,
    detectedLanguageFrom,
    friendlyChromeTranslationError,
    createChromePreparationRequiredError,
    isChromePreparationRequiredError,
    mapChromeLanguageCode,
    parseChromeTranslationRequest,
    parseLanguageCode,
    performChromeTranslation,
    translateWithChromeApi,
    MIN_CHROME_LANGUAGE_CONFIDENCE,
    type ChromeTranslationEnvironment,
    type ChromeModelStatus,
} from '@/src/app/offscreen/translation';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';

function modernTranslator(
    translator: Record<string, unknown>,
    availability: unknown = 'available',
): ChromeTranslationEnvironment {
    return {
        Translator: {
            availability: vi.fn(async () => availability),
            create: vi.fn(async () => translator),
        },
    } as ChromeTranslationEnvironment;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

describe('Offscreen Chrome 翻译域', () => {
    it('keeps cancellation authoritative when a late detector creation rejects', async () => {
        let reject!: (error: Error) => void;
        const creation = new Promise<never>((_resolve, failure) => {reject = failure;}), controller = new AbortController();
        const create = vi.fn(() => creation);
        const pending = detectChromeLanguage('hello', {translation: {createDetector: create}} as ChromeTranslationEnvironment, controller.signal);
        const cancelled = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        controller.abort(); await cancelled; reject(new Error('late detector failure')); await Promise.resolve(); await Promise.resolve();
    });
    it.each([false,true])('settles stream cancellation with iterator.return missing=%s or rejecting', async noReturn => {
        const next = deferred<IteratorResult<unknown>>(), close = vi.fn().mockRejectedValue(new Error('stream already gone'));
        const iterator = {next: vi.fn(() => next.promise), return: noReturn?undefined:close, [Symbol.asyncIterator]() {return this;}};
        const environment = modernTranslator({translateStreaming: vi.fn(() => iterator), destroy: vi.fn()}), controller = new AbortController();
        const pending = performChromeTranslation('hello', 'en', 'zh', environment, controller.signal);
        const cancelled = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce()); controller.abort(); await cancelled;
        await Promise.resolve(); expect(close).toHaveBeenCalledTimes(noReturn?0:1); next.resolve({done: true, value: undefined}); disposeChromeTranslationModels(environment);
    });
    it('uses script evidence and destroys a legacy detector that returns no confident language', async () => {
        const destroy=vi.fn(),environment={translation:{createDetector:vi.fn(async()=>({detect:async()=>[],destroy}))}};
        await expect(detectChromeLanguage('こんにちは',environment)).resolves.toBe('ja');expect(destroy).toHaveBeenCalledOnce();
    });
    afterEach(() => { vi.useRealTimers(); });
    it('结构化准备错误重复经过友好映射时保留实际语言对与对象身份', () => {
        const error = createChromePreparationRequiredError('fr', 'zh');
        expect(friendlyChromeTranslationError(error, 'auto', 'en')).toBe(error);
        expect(error).toMatchObject({sourceLanguage: 'fr', targetLanguage: 'zh', code: 'preparation-required'});
    });
    it('严格解析文本与语言对，并拒绝 null、数组和非法语言', () => {
        expect(parseChromeTranslationRequest({text: ' hello ', from: ' auto ', to: ' zh-Hans '}))
            .toEqual({text: ' hello ', from: 'auto', to: 'zh-Hans'});
        expect(parseChromeTranslationRequest({
            text: '___FLUENTREAD_packet___',
            from: 'auto',
            to: 'ja',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        })).toEqual({
            text: '___FLUENTREAD_packet___',
            from: 'auto',
            to: 'ja',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        });
        expect(parseChromeTranslationRequest({
            text: 'hello', from: 'auto', to: 'ja', sourceLanguageDetectionText: '   ',
        })).toEqual({text: 'hello', from: 'auto', to: 'ja'});
        expect(() => parseChromeTranslationRequest(null)).toThrow('data 必须是对象');
        expect(() => parseChromeTranslationRequest([])).toThrow('data 必须是对象');
        expect(() => parseChromeTranslationRequest({text: 1, from: 'en', to: 'ja'})).toThrow('文本必须是字符串');
        expect(() => parseChromeTranslationRequest({text: 'x', from: 1, to: 'ja'})).toThrow('from 必须是语言代码');
        expect(() => parseChromeTranslationRequest({text: 'x', from: 'bad!', to: 'ja'})).toThrow('from 语言代码无效');
        expect(() => parseChromeTranslationRequest({text: 'x', from: 'en', to: ''})).toThrow('to 语言代码无效');
        expect(() => parseChromeTranslationRequest({text: 'x', from: 'en', to: 'auto'})).toThrow('to 语言代码无效');
        expect(() => parseChromeTranslationRequest({
            text: 'x', from: 'auto', to: 'ja', sourceLanguageDetectionText: [],
        })).toThrow('检测文本必须是字符串');
        expect(parseLanguageCode(' EN-us ', 'from', false)).toBe('EN-us');
    });

    it('只接受首名、有效且达到官方示例阈值的现代检测结果', () => {
        expect(MIN_CHROME_LANGUAGE_CONFIDENCE).toBe(0.4);
        expect(MIN_CHROME_LANGUAGE_CONFIDENCE).toBe(detectionConfidence);
        expect(MIN_CHROME_LANGUAGE_CONFIDENCE).toBe(sharedConfidence);
        expect(detectedLanguageFrom([{detectedLanguage: 'en', confidence: 0.4}])).toBe('en');
        expect(detectedLanguageFrom([{detectedLanguage: 'fr', confidence: 1}])).toBe('fr');
        expect(detectedLanguageFrom([{detectedLanguage: 'en', confidence: 0.399}])).toBeNull();
        expect(detectedLanguageFrom([{detectedLanguage: 'und', confidence: 1}])).toBeNull();
        expect(detectedLanguageFrom([
            {detectedLanguage: 'und', confidence: 0.8},
            {detectedLanguage: 'fr', confidence: 0.2},
        ])).toBeNull();
        for (const confidence of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
            expect(detectedLanguageFrom([{detectedLanguage: 'en', confidence}])).toBeNull();
        }
        expect(detectedLanguageFrom([{detectedLanguage: 'en'}], false)).toBe('en');
        expect(detectedLanguageFrom([{detectedLanguage: 'en', confidence: 0.2}], false)).toBeNull();
    });

    it('映射 Chrome 语言代码并识别新旧 Translation API', () => {
        expect(mapChromeLanguageCode('zh-Hans')).toBe('zh');
        expect(mapChromeLanguageCode('zh-CN')).toBe('zh');
        expect(mapChromeLanguageCode('zh-Hant')).toBe('zh-Hant');
        expect(mapChromeLanguageCode('zh-TW')).toBe('zh-Hant');
        expect(mapChromeLanguageCode('zh-HK')).toBe('zh-Hant');
        expect(mapChromeLanguageCode('eo')).toBe('eo');
        expect(hasBrowserTranslationApi({translation: {createTranslator: vi.fn()}})).toBe(true);
        expect(hasBrowserTranslationApi({Translator: {create: vi.fn()}})).toBe(true);
        expect(hasBrowserTranslationApi({translation: {}})).toBe(false);
    });

    it('脚本兜底只识别 Kana 与 Hangul，共享脚本、纯 Han 与 Latin 保持未知', () => {
        expect(detectLanguageByScript('今天は良い天気です')).toBe('ja');
        expect(detectLanguageByScript('한글')).toBe('ko');
        expect(detectLanguageByScript('あ안')).toBeNull();
        expect(detectLanguageByScript('Русский текст')).toBeNull();
        expect(detectLanguageByScript('Український текст')).toBeNull();
        expect(detectLanguageByScript('نص عربي')).toBeNull();
        expect(detectLanguageByScript('متن فارسی')).toBeNull();
        expect(detectLanguageByScript('हिन्दी पाठ')).toBeNull();
        expect(detectLanguageByScript('मराठी मजकूर')).toBeNull();
        expect(detectLanguageByScript('ข้อความไทย')).toBeNull();
        expect(detectLanguageByScript('中文')).toBeNull();
        expect(detectLanguageByScript('日本語文章')).toBeNull();
        expect(detectLanguageByScript('English')).toBeNull();
        expect(detectLanguageByScript('Bonjour')).toBeNull();
    });

    it('兼容 legacy 检测器缺少 confidence 的结果并释放模型', async () => {
        const destroy = vi.fn();
        const detect = vi.fn(async () => [{detectedLanguage: ' fr '}]);
        const environment = {translation: {createDetector: vi.fn(async () => ({detect, destroy}))}};

        await expect(detectChromeLanguage('bonjour', environment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledWith('bonjour');
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('现代检测器优先于 legacy，并把 availability、monitor 与原生 signal 串起来', async () => {
        const controller = new AbortController();
        const statuses: ChromeModelStatus[] = [];
        const destroy = vi.fn();
        const detect = vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]);
        const legacyCreate = vi.fn();
        let progressListener: ((event: {loaded?: unknown}) => void) | undefined;
        const availability = vi.fn(async () => 'downloadable');
        const create = vi.fn(async (options?: {
            signal?: AbortSignal;
            monitor?: (monitor: {addEventListener: (
                type: 'downloadprogress',
                listener: (event: {loaded?: unknown}) => void,
            ) => void}) => void;
        }) => {
            options?.monitor?.({
                addEventListener: (_type, listener) => { progressListener = listener; },
            });
            progressListener?.({loaded: 0});
            progressListener?.({loaded: 0.25});
            progressListener?.({loaded: 'invalid'});
            progressListener?.({loaded: 1});
            return {detect, destroy};
        });

        const environment = {
            LanguageDetector: {availability, create},
            translation: {createDetector: legacyCreate},
        };
        await expect(detectChromeLanguage('Bonjour le monde.', environment,
            controller.signal, (status) => statuses.push(status))).resolves.toBe('fr');

        expect(legacyCreate).not.toHaveBeenCalled();
        expect(availability).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            signal: expect.any(AbortSignal),
            monitor: expect.any(Function),
        }));
        expect(detect).toHaveBeenCalledWith('Bonjour le monde.', {signal: controller.signal});
        expect(create.mock.calls[0]?.[0]?.signal).not.toBe(controller.signal);
        expect(destroy).not.toHaveBeenCalled();
        expect(statuses).toEqual([
            {model: 'language-detector', phase: 'checking'},
            {model: 'language-detector', phase: 'downloading', availability: 'downloadable'},
            {model: 'language-detector', phase: 'downloading', availability: 'downloadable', loaded: 0},
            {model: 'language-detector', phase: 'downloading', availability: 'downloadable', loaded: 0.25},
            {model: 'language-detector', phase: 'initializing', availability: 'downloadable', loaded: 1},
            {model: 'language-detector', phase: 'ready', availability: 'downloadable', loaded: 1},
        ]);
        const completedStatuses = [...statuses];
        controller.abort();
        progressListener?.({loaded: 0.75});
        expect(statuses).toEqual(completedStatuses);
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('现代检测结果低置信度或 und 时不采用后续候选，也不把 Latin 猜成英语', async () => {
        for (const result of [
            [{detectedLanguage: 'en', confidence: 0.399}],
            [{detectedLanguage: 'und', confidence: 1}, {detectedLanguage: 'fr', confidence: 0.9}],
            [{detectedLanguage: 'en'}],
        ]) {
            const environment: ChromeTranslationEnvironment = {
                LanguageDetector: {
                    availability: vi.fn(async () => 'available'),
                    create: vi.fn(async () => ({detect: vi.fn(async () => result)})),
                },
            };
            await expect(detectChromeLanguage('Bonjour le monde.', environment))
                .rejects.toThrow('无法可靠识别源语言');
        }
    });

    it('旧检测器的空或畸形结果回退脚本检测，清理异常不覆盖结果', async () => {
        const results: unknown[] = [
            [],
            null,
            [null],
            [{}],
            [{detectedLanguage: ' '}],
            [{detectedLanguage: 'bad!'}],
        ];
        for (const result of results) {
            const destroy = vi.fn(() => { throw new Error('cleanup failed'); });
            const environment = {
                LanguageDetector: {create: vi.fn(async () => ({detect: vi.fn(async () => result), destroy}))},
            };
            await expect(detectChromeLanguage('かな', environment)).resolves.toBe('ja');
            expect(destroy).not.toHaveBeenCalled();
            disposeChromeTranslationModels(environment);
            expect(destroy).toHaveBeenCalledOnce();
        }
    });

    it('检测器失败只在字符集明确时兜底，Latin 与纯 Han 不再猜成英语或中文', async () => {
        await expect(detectChromeLanguage('今日は良い天気です。', {
            translation: {createDetector: vi.fn(async () => { throw new Error('not ready'); })},
        })).resolves.toBe('ja');
        const destroy = vi.fn();
        await expect(detectChromeLanguage('한글', {
            translation: {createDetector: vi.fn(async () => ({
                detect: vi.fn(async () => { throw new Error('detect failed'); }),
                destroy,
            }))},
        })).resolves.toBe('ko');
        expect(destroy).toHaveBeenCalledOnce();
        await expect(detectChromeLanguage('plain', {})).rejects.toThrow('无法可靠识别源语言');
        await expect(detectChromeLanguage('日本語文章', {})).rejects.toThrow('无法可靠识别源语言');
        await expect(detectChromeLanguage('Український текст', {})).rejects.toThrow('无法可靠识别源语言');
        await expect(detectChromeLanguage('متن فارسی', {})).rejects.toThrow('无法可靠识别源语言');
        await expect(detectChromeLanguage('मराठी मजकूर', {})).rejects.toThrow('无法可靠识别源语言');
        await expect(detectChromeLanguage('ข้อความไทย', {})).rejects.toThrow('无法可靠识别源语言');

        const activation = new Error('gesture required');
        activation.name = 'NotAllowedError';
        await expect(detectChromeLanguage('Bonjour', {
            translation: {createDetector: vi.fn(async () => { throw activation; })},
        })).rejects.toBe(activation);
        await expect(detectChromeLanguage('Bonjour', {
            translation: {createDetector: vi.fn(async () => { throw new Error('model download failed'); })},
        })).rejects.toThrow('model download failed');
        await expect(detectChromeLanguage('Bonjour', {
            translation: {createDetector: vi.fn(async () => { throw new Error('detector crashed'); })},
        })).rejects.toThrow('无法可靠识别源语言');
    });

    it('检测 availability 不可用时不 create，未知值或探测异常则继续尝试权威 create', async () => {
        const unavailableCreate = vi.fn();
        await expect(detectChromeLanguage('Bonjour le monde.', {
            LanguageDetector: {
                availability: vi.fn(async () => 'unavailable'),
                create: unavailableCreate,
            },
        })).rejects.toThrow('语言检测模型不可用');
        expect(unavailableCreate).not.toHaveBeenCalled();

        for (const availability of [
            vi.fn(async () => 'future-status'),
            vi.fn(async () => { throw new Error('availability probe failed'); }),
        ]) {
            const create = vi.fn(async () => ({
                detect: vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.9}]),
            }));
            await expect(detectChromeLanguage('Bonjour le monde.', {
                LanguageDetector: {availability, create},
            })).resolves.toBe('fr');
            expect(create).toHaveBeenCalledOnce();
        }
    });

    it('取消悬挂的 availability 会立即结束，且不会继续创建检测器', async () => {
        const availability = deferred<unknown>();
        const create = vi.fn();
        const controller = new AbortController();
        const pending = detectChromeLanguage('Bonjour le monde.', {
            LanguageDetector: {availability: vi.fn(() => availability.promise), create},
        }, controller.signal);
        await Promise.resolve();

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(create).not.toHaveBeenCalled();
        availability.resolve('available');
    });

    it('取消检测会立即拒绝并释放现有或迟到 detector', async () => {
        const detectResult = deferred<unknown>();
        const destroyActive = vi.fn();
        const activeController = new AbortController();
        const active = detectChromeLanguage('hello', {
            translation: {createDetector: vi.fn(async () => ({
                detect: vi.fn(() => detectResult.promise),
                destroy: destroyActive,
            }))},
        }, activeController.signal);
        await Promise.resolve();
        activeController.abort();
        await expect(active).rejects.toMatchObject({name: 'AbortError'});
        expect(destroyActive).toHaveBeenCalledOnce();

        const creation = deferred<Record<string, unknown>>();
        const destroyLate = vi.fn();
        const lateController = new AbortController();
        const late = detectChromeLanguage('hello', {
            translation: {createDetector: vi.fn(() => creation.promise as never)},
        }, lateController.signal);
        lateController.abort();
        await expect(late).rejects.toMatchObject({name: 'AbortError'});
        creation.resolve({detect: vi.fn(async () => []), destroy: destroyLate});
        await vi.waitFor(() => expect(destroyLate).toHaveBeenCalledOnce());
        detectResult.resolve([]);
    });

    it('串接流式翻译并保留 translator 到容器释放', async () => {
        const destroy = vi.fn();
        const translateStreaming = vi.fn(async function* () {
            yield '你';
            yield '好';
        });
        const environment = modernTranslator({translateStreaming, destroy});

        await expect(performChromeTranslation('hello', 'en', 'zh', environment)).resolves.toBe('你好');
        expect(translateStreaming).toHaveBeenCalledWith('hello');
        expect(destroy).not.toHaveBeenCalled();
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('同时具备 translate 与 translateStreaming 时短文本直调 translate，超 4000 字符使用流式，无流式时仍回退 translate', async () => {
        const translate = vi.fn(async (text: string) => `direct:${text.length}`);
        const translateStreaming = vi.fn(async function* (text: string) {
            yield `stream:${text.length}`;
        });
        const environment = modernTranslator({translate, translateStreaming, destroy: vi.fn()});
        const boundaryText = 'a'.repeat(4_000);
        const longText = 'b'.repeat(4_001);

        await expect(performChromeTranslation('short paragraph', 'en', 'zh', environment))
            .resolves.toBe('direct:15');
        await expect(performChromeTranslation(boundaryText, 'en', 'zh', environment))
            .resolves.toBe('direct:4000');
        expect(translate).toHaveBeenCalledTimes(2);
        expect(translateStreaming).not.toHaveBeenCalled();

        await expect(performChromeTranslation(longText, 'en', 'zh', environment))
            .resolves.toBe('stream:4001');
        expect(translate).toHaveBeenCalledTimes(2);
        expect(translateStreaming).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);

        const directOnlyTranslate = vi.fn(async (text: string) => `only-direct:${text.length}`);
        const directOnlyEnv = modernTranslator({translate: directOnlyTranslate, destroy: vi.fn()});
        await expect(performChromeTranslation(longText, 'en', 'zh', directOnlyEnv))
            .resolves.toBe('only-direct:4001');
        expect(directOnlyTranslate).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(directOnlyEnv);
    });

    it('detectChromeLanguage 按环境 LRU 记忆化检测样本，支持 256 容量淘汰、跳过超长/带状态回调并在卸载时清空', async () => {
        const detect = vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.95}]);
        const environment = {
            LanguageDetector: {create: vi.fn(async () => ({detect, destroy: vi.fn()}))},
        };

        await expect(detectChromeLanguage('Bonjour le monde.', environment)).resolves.toBe('fr');
        await expect(detectChromeLanguage('Bonjour le monde.', environment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(1);

        // 传入 reporter 时仍执行完整检测流程以保留状态回调。
        const statuses: ChromeModelStatus[] = [];
        await expect(detectChromeLanguage('Bonjour le monde.', environment, undefined, status => statuses.push(status)))
            .resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(2);
        expect(statuses).toContainEqual({model: 'language-detector', phase: 'ready', loaded: 1});

        // 超过 2000 字符的长样本不进入记忆化缓存。
        const oversized = 'x'.repeat(2_001);
        await expect(detectChromeLanguage(oversized, environment)).resolves.toBe('fr');
        await expect(detectChromeLanguage(oversized, environment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(4);

        // 其他环境不共享缓存。
        const otherDetect = vi.fn(async () => [{detectedLanguage: 'de', confidence: 0.95}]);
        const otherEnvironment = {
            LanguageDetector: {create: vi.fn(async () => ({detect: otherDetect, destroy: vi.fn()}))},
        };
        await expect(detectChromeLanguage('Bonjour le monde.', otherEnvironment)).resolves.toBe('de');
        expect(otherDetect).toHaveBeenCalledTimes(1);
        disposeChromeTranslationModels(otherEnvironment);

        // 超过 256 条时淘汰最久未命中条目，最近命中条目保留。
        detect.mockClear();
        const lruEnvironment = {
            LanguageDetector: {create: vi.fn(async () => ({detect, destroy: vi.fn()}))},
        };
        for (let i = 0; i < 256; i += 1) {
            await expect(detectChromeLanguage(`sample-${i}`, lruEnvironment)).resolves.toBe('fr');
        }
        expect(detect).toHaveBeenCalledTimes(256);
        // 刷新 sample-0 为最新，插入 sample-256 应淘汰 sample-1 而保留 sample-0。
        await expect(detectChromeLanguage('sample-0', lruEnvironment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(256);
        await expect(detectChromeLanguage('sample-256', lruEnvironment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(257);
        await expect(detectChromeLanguage('sample-0', lruEnvironment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(257);
        await expect(detectChromeLanguage('sample-1', lruEnvironment)).resolves.toBe('fr');
        expect(detect).toHaveBeenCalledTimes(258);

        disposeChromeTranslationModels(lruEnvironment);
        await expect(detectChromeLanguage('sample-0', lruEnvironment)).rejects.toMatchObject({name: 'AbortError'});
        disposeChromeTranslationModels(environment);
    });

    it('同一 environment 替换 LanguageDetector 引用时清空检测缓存并释放旧检测器', async () => {
        const firstDestroy = vi.fn();
        const firstDetect = vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.95}]);
        const secondDestroy = vi.fn();
        const secondDetect = vi.fn(async () => [{detectedLanguage: 'de', confidence: 0.95}]);
        const environment: {
            Translator?: ChromeTranslationEnvironment['Translator'];
            LanguageDetector?: ChromeTranslationEnvironment['LanguageDetector'];
        } = {
            ...modernTranslator({translate: vi.fn(async () => 'translated'), destroy: vi.fn()}),
            LanguageDetector: {create: vi.fn(async () => ({detect: firstDetect, destroy: firstDestroy}))},
        };

        // 先通过 Translator 建立环境缓存，再首次运行检测器，覆盖无旧检测器槽位的 detectorRef 初始化分支。
        await expect(performChromeTranslation('hello', 'en', 'zh', environment)).resolves.toBe('translated');
        await expect(detectChromeLanguage('same sample', environment)).resolves.toBe('fr');
        await expect(detectChromeLanguage('same sample', environment)).resolves.toBe('fr');
        expect(firstDetect).toHaveBeenCalledTimes(1);

        environment.LanguageDetector = {
            create: vi.fn(async () => ({detect: secondDetect, destroy: secondDestroy})),
        };
        await expect(detectChromeLanguage('same sample', environment)).resolves.toBe('de');
        expect(firstDestroy).toHaveBeenCalledOnce();
        expect(secondDetect).toHaveBeenCalledTimes(1);
        await expect(detectChromeLanguage('same sample', environment)).resolves.toBe('de');
        expect(secondDetect).toHaveBeenCalledTimes(1);

        disposeChromeTranslationModels(environment);
        expect(secondDestroy).toHaveBeenCalledOnce();
    });

    it('现代 Translator 优先，availability 使用映射后语言对并把 signal 传到 create/translate', async () => {
        const controller = new AbortController();
        const statuses: ChromeModelStatus[] = [];
        const legacyCreate = vi.fn();
        const destroy = vi.fn();
        const translate = vi.fn(async () => 'Traditional Chinese translated');
        const availability = vi.fn(async () => 'downloading');
        const create = vi.fn(async (options: {
            sourceLanguage: string;
            targetLanguage: string;
            signal?: AbortSignal;
            monitor?: (value: {
                addEventListener: (type: string, listener: (event: {loaded: number}) => void) => void;
            }) => void;
        }) => {
            options.monitor?.({addEventListener: (_type, listener) => listener({loaded: 0.5})});
            return {translate, destroy};
        });

        const environment = {
            Translator: {availability, create},
            translation: {createTranslator: legacyCreate},
        };
        await expect(translateWithChromeApi({
            text: '繁體中文', from: 'zh-TW', to: 'en',
        }, environment, controller.signal, (status) => statuses.push(status))).resolves.toBe('Traditional Chinese translated');

        expect(legacyCreate).not.toHaveBeenCalled();
        expect(availability).toHaveBeenCalledWith({sourceLanguage: 'zh-Hant', targetLanguage: 'en'});
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            sourceLanguage: 'zh-Hant',
            targetLanguage: 'en',
            signal: expect.any(AbortSignal),
            monitor: expect.any(Function),
        }));
        expect(translate).toHaveBeenCalledWith('繁體中文', {signal: controller.signal});
        expect(create.mock.calls[0]?.[0]?.signal).not.toBe(controller.signal);
        expect(destroy).not.toHaveBeenCalled();
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
        expect(statuses).toEqual([
            {model: 'translator', phase: 'checking'},
            {model: 'translator', phase: 'downloading', availability: 'downloading'},
            {model: 'translator', phase: 'downloading', availability: 'downloading', loaded: 0.5},
            {model: 'translator', phase: 'ready', availability: 'downloading', loaded: 1},
        ]);
    });

    it.each(['available', 'downloadable', 'downloading'] as const)(
        'Translator availability=%s 时继续 create',
        async (availabilityValue) => {
            const create = vi.fn(async () => ({translate: vi.fn(async () => '译文')}));
            await expect(performChromeTranslation('hello', 'en', 'ja', {
                Translator: {availability: vi.fn(async () => availabilityValue), create},
            })).resolves.toBe('译文');
            expect(create).toHaveBeenCalledOnce();
        },
    );

    it('Translator unavailable 不 create，availability 未知或抛错仍尝试 create', async () => {
        const unavailableCreate = vi.fn();
        await expect(performChromeTranslation('hello', 'en', 'ja', {
            Translator: {availability: vi.fn(async () => 'unavailable'), create: unavailableCreate},
        })).rejects.toThrow('翻译语言包不可用');
        expect(unavailableCreate).not.toHaveBeenCalled();

        for (const availability of [
            vi.fn(async () => 'future-status'),
            vi.fn(async () => { throw new Error('availability failed'); }),
        ]) {
            const create = vi.fn(async () => ({translate: vi.fn(async () => '译文')}));
            await expect(performChromeTranslation('hello', 'en', 'ja', {
                Translator: {availability, create},
            })).resolves.toBe('译文');
            expect(create).toHaveBeenCalledOnce();
        }
    });

    it('模型状态 reporter 抛错不会影响翻译', async () => {
        await expect(performChromeTranslation(
            'hello',
            'en',
            'ja',
            modernTranslator({translate: vi.fn(async () => '译文')}, 'downloadable'),
            undefined,
            () => { throw new Error('observer failed'); },
        )).resolves.toBe('译文');
    });

    it('没有 availability 时 monitor 仍报告不带状态枚举的下载进度', async () => {
        const statuses: ChromeModelStatus[] = [];
        const create = vi.fn(async (options: {
            sourceLanguage: string;
            targetLanguage: string;
            monitor?: (monitor: {
                addEventListener: (type: string, listener: (event: {loaded: number}) => void) => void;
            }) => void;
        }) => {
            options.monitor?.({addEventListener: (_type, listener) => listener({loaded: 0.2})});
            return {translate: vi.fn(async () => '译文')};
        });

        await expect(performChromeTranslation('hello', 'en', 'ja', {
            Translator: {create},
        }, undefined, (status) => statuses.push(status))).resolves.toBe('译文');
        expect(statuses).toEqual([
            {model: 'translator', phase: 'checking'},
            {model: 'translator', phase: 'initializing'},
            {model: 'translator', phase: 'downloading', loaded: 0.2},
            {model: 'translator', phase: 'ready', loaded: 1},
        ]);
    });

    it('availability 已 available 时 monitor 的未完成进度仍属于初始化而非下载', async () => {
        const statuses: ChromeModelStatus[] = [];
        const create = vi.fn(async (options: {
            sourceLanguage: string;
            targetLanguage: string;
            monitor?: (monitor: {
                addEventListener: (type: string, listener: (event: {loaded: number}) => void) => void;
            }) => void;
        }) => {
            options.monitor?.({addEventListener: (_type, listener) => listener({loaded: 0.25})});
            return {translate: vi.fn(async () => '译文')};
        });

        await expect(performChromeTranslation('hello', 'en', 'ja', {
            Translator: {availability: vi.fn(async () => 'available'), create},
        }, undefined, (status) => statuses.push(status))).resolves.toBe('译文');
        expect(statuses).toEqual([
            {model: 'translator', phase: 'checking'},
            {model: 'translator', phase: 'initializing', availability: 'available'},
            {model: 'translator', phase: 'initializing', availability: 'available', loaded: 0.25},
            {model: 'translator', phase: 'ready', availability: 'available', loaded: 1},
        ]);
        expect(statuses).not.toContainEqual(expect.objectContaining({phase: 'downloading'}));
    });

    it('取消悬挂流会立即 return，迟到 chunk 不会成为结果且共享实例不销毁', async () => {
        const next = deferred<IteratorResult<unknown>>();
        const destroy = vi.fn();
        const close = vi.fn(() => { throw new Error('stream already closed'); });
        const iterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
            next: vi.fn(() => next.promise),
            return: close,
            [Symbol.asyncIterator]() { return this; },
        };
        const controller = new AbortController();
        const translateStreaming = vi.fn(() => iterator);
        const environment = modernTranslator({
            translateStreaming,
            destroy,
        });
        const pending = performChromeTranslation('hello', 'en', 'zh', environment, controller.signal);
        await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce());
        expect(translateStreaming).toHaveBeenCalledWith('hello', {signal: controller.signal});
        expect(environment.Translator?.create).toHaveBeenCalledWith(expect.objectContaining({
            signal: expect.any(AbortSignal),
        }));

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(close).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
        next.resolve({done: false, value: '迟到'});
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('取消普通 translate Promise 会立即拒绝且共享 translator 保留', async () => {
        const translated = deferred<unknown>();
        const destroy = vi.fn();
        const translate = vi.fn(() => translated.promise);
        const controller = new AbortController();
        const environment = modernTranslator({translate, destroy});
        const pending = performChromeTranslation('hello', 'en', 'zh', environment, controller.signal);
        await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(destroy).not.toHaveBeenCalled();
        translated.resolve('迟到译文');
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('createTranslator 在取消后迟到时仍会立即 destroy', async () => {
        const creation = deferred<Record<string, unknown>>();
        const destroy = vi.fn();
        const controller = new AbortController();
        const pending = performChromeTranslation('hello', 'en', 'zh', {
            translation: {createTranslator: vi.fn(() => creation.promise)},
        }, controller.signal);

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        creation.resolve({translate: vi.fn(async () => '迟到译文'), destroy});
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    });

    it('取消悬挂的 Translator availability 会立即拒绝且不 create', async () => {
        const availability = deferred<unknown>();
        const create = vi.fn();
        const controller = new AbortController();
        const pending = performChromeTranslation('hello', 'en', 'ja', {
            Translator: {availability: vi.fn(() => availability.promise), create},
        }, controller.signal);
        await Promise.resolve();

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(create).not.toHaveBeenCalled();
        availability.resolve('available');
    });

    it('拒绝无效流式块、普通结果和缺失翻译方法，并兼容旧 API', async () => {
        await expect(performChromeTranslation('x', 'en', 'ja', {})).rejects.toThrow('没有可用的翻译 API');
        await expect(performChromeTranslation('x', 'en', 'ja', modernTranslator({
            translateStreaming: async function* () { yield 1; },
        }))).rejects.toThrow('无效的流式结果');
        await expect(performChromeTranslation('x', 'en', 'ja', modernTranslator({
            translate: vi.fn(async () => null),
        }))).rejects.toThrow('无效结果');
        await expect(performChromeTranslation('x', 'en', 'ja', modernTranslator({})))
            .rejects.toThrow('不支持翻译方法');

        const destroy = vi.fn(() => { throw new Error('ignored cleanup'); });
        const create = vi.fn(async () => ({translate: vi.fn(async () => '旧译文'), destroy}));
        await expect(performChromeTranslation('x', 'en', 'ja', {translation: {createTranslator: create}}))
            .resolves.toBe('旧译文');
        expect(create).toHaveBeenCalledWith({sourceLanguage: 'en', targetLanguage: 'ja'});
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('连续翻译与语言检测复用实例，空闲期限刷新后才释放', async () => {
        vi.useFakeTimers();
        const translatorDestroy = vi.fn();
        const detectorDestroy = vi.fn();
        const environment = {
            ...modernTranslator({translate: vi.fn(async text => `${text}-translated`), destroy: translatorDestroy}),
            LanguageDetector: {create: vi.fn(async () => ({
                detect: vi.fn(async () => [{detectedLanguage: 'en', confidence: 1}]), destroy: detectorDestroy,
            }))},
        };
        const request = {text: 'first', from: 'auto', to: 'ja'};
        await expect(translateWithChromeApi(request, environment)).resolves.toBe('first-translated');
        await vi.advanceTimersByTimeAsync(localModelIdleMs() - 1);
        const statuses: ChromeModelStatus[] = [];
        await expect(translateWithChromeApi({...request, text: 'second'}, environment, undefined,
            status => statuses.push(status))).resolves.toBe('second-translated');
        expect(environment.Translator!.create).toHaveBeenCalledOnce();
        expect(environment.LanguageDetector.create).toHaveBeenCalledOnce();
        expect(statuses).toEqual([
            {model: 'language-detector', phase: 'ready', loaded: 1},
            {model: 'translator', phase: 'ready', availability: 'available', loaded: 1},
        ]);
        await vi.advanceTimersByTimeAsync(localModelIdleMs() - 1);
        expect(translatorDestroy).not.toHaveBeenCalled();
        expect(detectorDestroy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(translatorDestroy).toHaveBeenCalledOnce();
        expect(detectorDestroy).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
    });

    it.each(['checking', 'initializing', 'ready'] as const)(
        'Translator 在 %s 状态同步取消最后一个创建消费者，不进入后续模型工作', async phase => {
            const controller = new AbortController();
            const translate = vi.fn(async () => 'unexpected');
            const destroy = vi.fn();
            const create = vi.fn(async () => ({translate, destroy}));
            const availability = vi.fn(async () => 'available');
            const environment = {Translator: {availability, create}};
            await expect(performChromeTranslation('hello', 'en', 'ja', environment, controller.signal, status => {
                if (status.phase === phase) controller.abort();
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(translate).not.toHaveBeenCalled();
            expect(availability).toHaveBeenCalledTimes(phase === 'checking' ? 0 : 1);
            expect(create).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
            expect(destroy).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
            disposeChromeTranslationModels(environment);
        },
    );

    it('LanguageDetector ready 状态同步取消未被使用的新实例，立即拒绝且收尾销毁', async () => {
        const controller = new AbortController();
        const detect = vi.fn(async () => [{detectedLanguage: 'en', confidence: 1}]);
        const destroy = vi.fn();
        const environment = {LanguageDetector: {create: vi.fn(async () => ({detect, destroy}))}};
        await expect(detectChromeLanguage('hello', environment, controller.signal, status => {
            if (status.phase === 'ready') controller.abort();
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(detect).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
    });

    it('同语言对并发共享创建和下载状态，首请求取消不销毁其余消费者', async () => {
        const creation = deferred<Record<string, unknown>>();
        const destroy = vi.fn();
        const translate = vi.fn(async (_text: string) => 'shared translation');
        let creationSignal: AbortSignal | undefined;
        let progress: ((event: {loaded: number}) => void) | undefined;
        const create = vi.fn((options: {signal?: AbortSignal; monitor?: (monitor: {
            addEventListener: (type: string, listener: (event: {loaded: number}) => void) => void;
        }) => void}) => {
            creationSignal = options.signal;
            options.monitor?.({addEventListener: (_type, listener) => { progress = listener; }});
            return creation.promise;
        });
        const environment = {Translator: {availability: vi.fn(async () => 'downloadable'), create}};
        const firstController = new AbortController();
        const first = performChromeTranslation('first', 'en', 'ja', environment, firstController.signal);
        const statuses: ChromeModelStatus[] = [];
        const second = performChromeTranslation('second', 'en', 'ja', environment, undefined,
            status => statuses.push(status));
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(creationSignal?.aborted).toBe(false);
        progress?.({loaded: 0.5});
        expect(statuses).toContainEqual({model: 'translator', phase: 'downloading', availability: 'downloadable', loaded: 0.5});
        creation.resolve({translate, destroy});
        await expect(second).resolves.toBe('shared translation');
        await expect(performChromeTranslation('third', 'en', 'ja', environment)).resolves.toBe('shared translation');
        expect(translate.mock.calls.map(call => call[0])).toEqual(['second', 'third']);
        expect(create).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it.each(['cancel-all', 'pagehide'] as const)('%s 在创建中取消全部消费者并只释放一次迟到实例', async mode => {
        const creation = deferred<Record<string, unknown>>();
        const destroy = vi.fn();
        let creationSignal: AbortSignal | undefined;
        const create = vi.fn((options: {signal?: AbortSignal}) => {
            creationSignal = options.signal;
            return creation.promise;
        });
        const environment = {Translator: {create}};
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = performChromeTranslation('first', 'en', 'ja', environment, firstController.signal);
        const second = performChromeTranslation('second', 'en', 'ja', environment, secondController.signal);
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        if (mode === 'cancel-all') {
            firstController.abort(); secondController.abort();
        } else disposeChromeTranslationModels(environment);
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await expect(second).rejects.toMatchObject({name: 'AbortError'});
        expect(creationSignal?.aborted).toBe(true);
        creation.resolve({translate: vi.fn(), destroy});
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('取消正在执行的推理立即返回，但其原生操作收尾前不会启动下一个任务', async () => {
        const nativeResult = deferred<unknown>();
        const translate = vi.fn((text: string) => text === 'active' ? nativeResult.promise : Promise.resolve(text));
        const destroy = vi.fn();
        const environment = modernTranslator({translate, destroy});
        const controller = new AbortController();
        const active = performChromeTranslation('active', 'en', 'ja', environment, controller.signal);
        await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
        const queuedController = new AbortController();
        const cancelledQueue = performChromeTranslation('cancelled queue', 'en', 'ja', environment, queuedController.signal);
        const survivor = performChromeTranslation('survivor', 'en', 'ja', environment);
        controller.abort(); queuedController.abort();
        await expect(active).rejects.toMatchObject({name: 'AbortError'});
        await expect(cancelledQueue).rejects.toMatchObject({name: 'AbortError'});
        expect(translate).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
        nativeResult.resolve('late original');
        await expect(survivor).resolves.toBe('survivor');
        expect(translate.mock.calls.map(call => call[0])).toEqual(['active', 'survivor']);
        disposeChromeTranslationModels(environment);
    });

    it.each(['promise', 'stream'] as const)('取消 %s 永不收尾时有界释放实例与等待队列', async mode => {
        vi.useFakeTimers();
        const nativeResult = new Promise<never>(() => {});
        const destroy = vi.fn();
        const close = vi.fn(async () => ({done: true as const, value: undefined}));
        const translate = vi.fn(() => nativeResult);
        const iterator = {next: vi.fn(() => nativeResult), return: close,
            [Symbol.asyncIterator]() { return this; }};
        const create = vi.fn().mockResolvedValueOnce(mode === 'promise'
            ? {translate, destroy} : {translateStreaming: () => iterator, destroy})
            .mockResolvedValue({translate: vi.fn(async () => 'rebuilt')});
        const environment = {Translator: {create}};
        const controller = new AbortController();
        const active = performChromeTranslation('active', 'en', 'ja', environment, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        const queued = performChromeTranslation('queued', 'en', 'ja', environment);
        const queuedOutcome = queued.catch(error => error);
        controller.abort();
        await expect(active).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(1_499);
        expect(destroy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(destroy).toHaveBeenCalledOnce();
        expect(await queuedOutcome).toMatchObject({name: 'InvalidStateError'});
        await expect(performChromeTranslation('retry', 'en', 'ja', environment)).resolves.toBe('rebuilt');
        expect(create).toHaveBeenCalledTimes(2);
        if (mode === 'stream') expect(close).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
    });

    it('检测器共享创建且逐次推理，排队请求取消不影响进行中的检测', async () => {
        const detected = deferred<unknown>();
        const detect = vi.fn((text: string) => text === 'active' ? detected.promise
            : Promise.resolve([{detectedLanguage: 'fr', confidence: 1}]));
        const destroy = vi.fn();
        const environment = {LanguageDetector: {create: vi.fn(async () => ({detect, destroy}))}};
        const active = detectChromeLanguage('active', environment);
        await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
        const controller = new AbortController();
        const cancelled = detectChromeLanguage('cancelled', environment, controller.signal);
        const survivor = detectChromeLanguage('survivor', environment);
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        detected.resolve([{detectedLanguage: 'en', confidence: 1}]);
        await expect(active).resolves.toBe('en');
        await expect(survivor).resolves.toBe('fr');
        expect(environment.LanguageDetector.create).toHaveBeenCalledOnce();
        expect(detect.mock.calls.map(call => call[0])).toEqual(['active', 'survivor']);
        disposeChromeTranslationModels(environment);
    });

    it('两语言对忙碌时第三对等待容量，可取消并在释放后创建', async () => {
        const activeJa = deferred<unknown>();
        const activeFr = deferred<unknown>();
        const resources = new Map<string, {destroy: ReturnType<typeof vi.fn>}>();
        const create = vi.fn(async (options: {targetLanguage: string}) => {
            const resource = {destroy: vi.fn(), translate: vi.fn(() => options.targetLanguage === 'ja'
                ? activeJa.promise : options.targetLanguage === 'fr' ? activeFr.promise : Promise.resolve('de'))};
            resources.set(options.targetLanguage, resource);
            return resource;
        });
        const environment = {Translator: {create}};
        const ja = performChromeTranslation('ja', 'en', 'ja', environment);
        const fr = performChromeTranslation('fr', 'en', 'fr', environment);
        await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
        const controller = new AbortController();
        const cancelled = performChromeTranslation('cancelled', 'en', 'de', environment, controller.signal);
        const survivor = performChromeTranslation('de', 'en', 'de', environment);
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        expect(create).toHaveBeenCalledTimes(2);
        activeJa.resolve('ja');
        await expect(ja).resolves.toBe('ja');
        await expect(survivor).resolves.toBe('de');
        expect(resources.get('ja')?.destroy).toHaveBeenCalledOnce();
        expect(resources.get('fr')?.destroy).not.toHaveBeenCalled();
        activeFr.resolve('fr'); await expect(fr).resolves.toBe('fr');
        disposeChromeTranslationModels(environment);
    });

    it('语言对缓存淘汰最久未用的空闲实例，并在推理过程中暂停空闲回收', async () => {
        vi.useFakeTimers();
        const nativeResult = deferred<unknown>();
        const resources = new Map<string, {destroy: ReturnType<typeof vi.fn>}>();
        const create = vi.fn(async (options: {targetLanguage: string}) => {
            const resource = {destroy: vi.fn(), translate: vi.fn((text: string) => text === 'active'
                ? nativeResult.promise : Promise.resolve(options.targetLanguage))};
            resources.set(options.targetLanguage, resource);
            return resource;
        });
        const environment = {Translator: {create}};
        await performChromeTranslation('first', 'en', 'ja', environment);
        await vi.advanceTimersByTimeAsync(1);
        await performChromeTranslation('second', 'en', 'fr', environment);
        await vi.advanceTimersByTimeAsync(1);
        await performChromeTranslation('reuse', 'en', 'ja', environment);
        await performChromeTranslation('third', 'en', 'de', environment);
        expect(resources.get('fr')?.destroy).toHaveBeenCalledOnce();
        expect(resources.get('ja')?.destroy).not.toHaveBeenCalled();
        const active = performChromeTranslation('active', 'en', 'ja', environment);
        await vi.advanceTimersByTimeAsync(localModelIdleMs() * 2);
        expect(resources.get('ja')?.destroy).not.toHaveBeenCalled();
        nativeResult.resolve('done'); await expect(active).resolves.toBe('done');
        await vi.advanceTimersByTimeAsync(localModelIdleMs());
        expect(resources.get('ja')?.destroy).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
    });

    it('容器释放同时结束执行、队列和容量等待，迟到原生结果不会再次销毁', async () => {
        const nativeResult = deferred<unknown>();
        const destroy = vi.fn();
        const translate = vi.fn(() => nativeResult.promise);
        const environment = modernTranslator({translate, destroy});
        const first = performChromeTranslation('first', 'en', 'ja', environment);
        const secondPair = performChromeTranslation('second pair', 'en', 'fr', environment);
        await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
        const queued = performChromeTranslation('queued', 'en', 'ja', environment);
        const capacity = performChromeTranslation('capacity', 'en', 'de', environment);
        disposeChromeTranslationModels(environment);
        for (const promise of [first, secondPair, queued, capacity]) {
            await expect(promise).rejects.toMatchObject({name: 'AbortError'});
        }
        expect(destroy).toHaveBeenCalledTimes(2);
        nativeResult.resolve('late');
        await Promise.resolve();
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledTimes(2);
    });

    it('原生失败让已排队请求拒绝失效实例，后续重建且单次配额错误保持复用', async () => {
        let rejectFirst!: (reason: Error) => void;
        const firstResult = new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
        const destroy = vi.fn();
        const translate = vi.fn((text: string) => text === 'failure' ? firstResult : Promise.resolve(text));
        const environment = modernTranslator({translate, destroy});
        const first = performChromeTranslation('failure', 'en', 'ja', environment);
        await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
        const queuedOutcomes = Array.from({length: 8}, (_, index) =>
            performChromeTranslation(`queued ${index}`, 'en', 'ja', environment).catch(error => error));
        await Promise.resolve();
        rejectFirst(Object.assign(new Error('invalid instance'), {name: 'InvalidStateError'}));
        await expect(first).rejects.toMatchObject({name: 'InvalidStateError'});
        const rebuilt = performChromeTranslation('rebuilt', 'en', 'ja', environment);
        for (const outcome of queuedOutcomes) expect(await outcome).toMatchObject({name: 'InvalidStateError'});
        await expect(rebuilt).resolves.toBe('rebuilt');
        expect(translate.mock.calls.map(call => call[0])).toEqual(['failure', 'rebuilt']);
        expect(environment.Translator?.create).toHaveBeenCalledTimes(2);
        expect(destroy).toHaveBeenCalledOnce();
        translate.mockRejectedValueOnce(Object.assign(new Error('too long'), {name: 'QuotaExceededError'}));
        await expect(performChromeTranslation('quota', 'en', 'ja', environment)).rejects.toMatchObject({name: 'QuotaExceededError'});
        await expect(performChromeTranslation('after quota', 'en', 'ja', environment)).resolves.toBe('after quota');
        expect(environment.Translator?.create).toHaveBeenCalledTimes(2);
        disposeChromeTranslationModels(environment);
    });

    it('模型完成准备的状态回调卸载容器，尚未交付的实例只清理一次', async () => {
        const destroy = vi.fn();
        const translate = vi.fn();
        const environment = modernTranslator({translate, destroy});
        await expect(performChromeTranslation('hello', 'en', 'ja', environment, undefined, status => {
            if (status.phase === 'ready') disposeChromeTranslationModels(environment);
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(translate).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('现代检测器同步异常也释放失效实例，保留保守脚本兜底', async () => {
        const destroy = vi.fn();
        const environment = {LanguageDetector: {create: vi.fn(async () => ({
            detect: vi.fn(() => { throw Object.assign(new Error('invalid detector'), {name: 'InvalidStateError'}); }),
            destroy,
        }))}};
        await expect(detectChromeLanguage('かな', environment)).resolves.toBe('ja');
        expect(destroy).toHaveBeenCalledOnce();
        disposeChromeTranslationModels(environment);
    });

    it('旧实验接口的流式成功和取消都立即释放独占 translator', async () => {
        const destroyComplete = vi.fn();
        const successful = {translation: {createTranslator: vi.fn(async () => ({
            translateStreaming: async function* () { yield 'legacy'; yield ' stream'; }, destroy: destroyComplete,
        }))}};
        await expect(performChromeTranslation('hello', 'en', 'ja', successful)).resolves.toBe('legacy stream');
        expect(destroyComplete).toHaveBeenCalledOnce();

        const next = deferred<IteratorResult<unknown>>();
        const close = vi.fn(async () => ({done: true as const, value: undefined}));
        const destroyCancelled = vi.fn();
        const iterator = {next: vi.fn(() => next.promise), return: close,
            [Symbol.asyncIterator]() { return this; }};
        const cancelledEnvironment = {translation: {createTranslator: vi.fn(async () => ({
            translateStreaming: () => iterator, destroy: destroyCancelled,
        }))}};
        const controller = new AbortController();
        const cancelled = performChromeTranslation('hello', 'en', 'ja', cancelledEnvironment, controller.signal);
        await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce());
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        expect(close).toHaveBeenCalledOnce();
        expect(destroyCancelled).toHaveBeenCalledOnce();
        next.resolve({done: false, value: 'late'});
    });

    it('检测与翻译阶段交接时卸载环境，旧请求和后续请求都不能重新创建实例', async () => {
        const detection = deferred<unknown>();
        const detect = vi.fn(() => detection.promise);
        const createTranslator = vi.fn(async () => ({translate: vi.fn(async () => 'unexpected')}));
        const environment = {LanguageDetector: {create: vi.fn(async () => ({detect}))},
            Translator: {create: createTranslator}};
        const request = {text: 'hello world', from: 'auto', to: 'ja'};
        const translating = translateWithChromeApi(request, environment);
        await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
        // detector 的原生 Promise 完成后，译文阶段的后续微任务必须看到终止标记。
        detection.resolve([{detectedLanguage: 'en', confidence: 1}]);
        queueMicrotask(() => disposeChromeTranslationModels(environment));
        await expect(translating).rejects.toMatchObject({name: 'AbortError'});
        await expect(translateWithChromeApi(request, environment)).rejects.toMatchObject({name: 'AbortError'});
        expect(createTranslator).not.toHaveBeenCalled();
        await expect(detectChromeLanguage('text', environment)).rejects.toMatchObject({name: 'AbortError'});
        await expect(performChromeTranslation('text', 'en', 'ja', environment)).rejects.toMatchObject({name: 'AbortError'});
        const neverUsed: ChromeTranslationEnvironment = {Translator: {create: createTranslator}};
        disposeChromeTranslationModels(neverUsed);
        await expect(performChromeTranslation('text', 'en', 'ja', neverUsed)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('创建失败不会缓存拒绝，下一次请求可以重新创建', async () => {
        const create = vi.fn().mockRejectedValueOnce(new Error('model failed'))
            .mockResolvedValue({translate: vi.fn(async () => 'recovered')});
        const environment = {Translator: {create}};
        await expect(performChromeTranslation('first', 'en', 'ja', environment)).rejects.toThrow('model failed');
        await expect(performChromeTranslation('second', 'en', 'ja', environment)).resolves.toBe('recovered');
        expect(create).toHaveBeenCalledTimes(2);
        disposeChromeTranslationModels(environment);
    });

    it('把实验 API 错误映射成可操作提示', () => {
        expect(friendlyChromeTranslationError(new Error('model not available'), 'en', 'ja').message)
            .toContain('当前不可用');
        expect(friendlyChromeTranslationError(new Error('language not supported'), 'en', 'xx').message)
            .toContain('en → xx');
        expect(friendlyChromeTranslationError(new Error('model download failed'), 'en', 'ja').message)
            .toContain('模型未就绪');
        expect(friendlyChromeTranslationError('plain failure', 'en', 'ja').message).toBe('翻译失败：plain failure');
        expect(friendlyChromeTranslationError(null, 'en', 'ja').message).toBe('翻译失败：未知错误');
        const notAllowed = new Error('gesture required');
        notAllowed.name = 'NotAllowedError';
        expect(friendlyChromeTranslationError(notAllowed, 'en', 'ja').message)
            .toContain('en → ja 语言包尚未准备');
        expect(friendlyChromeTranslationError(notAllowed, 'auto', 'ja').message)
            .toContain('自动识别源语言需要先准备语言检测模型');
        const notSupported = new Error('pair rejected');
        notSupported.name = 'NotSupportedError';
        expect(friendlyChromeTranslationError(notSupported, 'en', 'xx').message).toContain('浏览器内置翻译当前不可用');
        const quota = new Error('too much text');
        quota.name = 'QuotaExceededError';
        expect(friendlyChromeTranslationError(quota, 'en', 'ja').message).toContain('长度限制');
        const operation = new Error('initialization failed');
        operation.name = 'OperationError';
        expect(friendlyChromeTranslationError(operation, 'en', 'ja').message).toContain('模型未就绪');
        const networkWithLanguageMessage = new Error('language model download failed');
        networkWithLanguageMessage.name = 'NetworkError';
        expect(friendlyChromeTranslationError(networkWithLanguageMessage, 'en', 'ja').message)
            .toContain('模型未就绪');
        const uncertain = new Error('无法可靠识别源语言');
        uncertain.name = 'ChromeLanguageUndeterminedError';
        expect(friendlyChromeTranslationError(uncertain, 'auto', 'ja').message).toBe('无法可靠识别源语言');
        const abort = new Error('cancelled');
        abort.name = 'AbortError';
        expect(friendlyChromeTranslationError(abort, 'en', 'ja')).toBe(abort);
    });

    it('识别结构化待准备错误的完整和不完整形状', () => {
        const complete = createChromePreparationRequiredError('en', 'zh');
        expect(isChromePreparationRequiredError(complete)).toBe(true);
        expect(isChromePreparationRequiredError({...complete, code: 'other'})).toBe(false);
        expect(isChromePreparationRequiredError({...complete, sourceLanguage: 1})).toBe(false);
        expect(isChromePreparationRequiredError(null)).toBe(false);
    });

    it.each([
        ['QuotaExceededError', '长度限制'],
        ['OperationError', '模型未就绪'],
        ['NetworkError', '网络连接'],
        ['InvalidStateError', '模型未就绪'],
        ['NotSupportedError', '浏览器内置翻译当前不可用'],
    ] as const)('auto 检测的 %s 经 translateWithChromeApi 链路保留并友好映射', async (name, expected) => {
        const detectionError = new Error('detector operation failed');
        detectionError.name = name;
        const translatorCreate = vi.fn();

        await expect(translateWithChromeApi({
            text: 'Bonjour le monde.',
            from: 'auto',
            to: 'zh-Hans',
        }, {
            LanguageDetector: {
                create: vi.fn(async () => ({
                    detect: vi.fn(async () => { throw detectionError; }),
                })),
            },
            Translator: {create: translatorCreate},
        })).rejects.toThrow(expected);
        expect(translatorCreate).not.toHaveBeenCalled();
    });

    it('首次自动检测时提示准备语言检测模型', async () => {
        const activation = new Error('gesture required');
        activation.name = 'NotAllowedError';
        const translatorCreate = vi.fn();

        const error: Error = await translateWithChromeApi({
            text: 'Bonjour le monde.',
            from: 'auto',
            to: 'ja',
        }, {
            LanguageDetector: {
                create: vi.fn(async () => { throw activation; }),
            },
            Translator: {create: translatorCreate},
        }).then(
            () => { throw new Error('expected auto detection preparation to fail'); },
            (reason) => reason instanceof Error ? reason : new Error(String(reason)),
        );
        expect(error.message).toContain('准备语言检测模型');
        expect(error.message).not.toContain('选为 auto');
        expect(translatorCreate).not.toHaveBeenCalled();
    });

    it('auto 只检测纯正文样本，translator 仍接收完整标记 payload', async () => {
        const markedText = [
            '___FLUENTREAD_test_0_BEGIN___',
            'Bonjour le monde.',
            '___FLUENTREAD_test_0_END___',
        ].join('\n');
        const detect = vi.fn(async () => [{detectedLanguage: 'fr', confidence: 0.99}]);
        const translate = vi.fn(async () => '___FLUENTREAD_test_0_BEGIN___\n你好，世界。\n___FLUENTREAD_test_0_END___');
        const createDetector = vi.fn(async () => ({detect}));
        const createTranslator = vi.fn(async () => ({translate}));

        await expect(translateWithChromeApi({
            text: markedText,
            from: 'auto',
            to: 'zh-Hans',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        }, {
            LanguageDetector: {
                availability: vi.fn(async () => 'available'),
                create: createDetector,
            },
            Translator: {
                availability: vi.fn(async () => 'available'),
                create: createTranslator,
            },
        })).resolves.toContain('你好，世界。');

        expect(detect).toHaveBeenCalledWith('Bonjour le monde.', undefined);
        expect(createTranslator).toHaveBeenCalledWith(expect.objectContaining({
            sourceLanguage: 'fr',
            targetLanguage: 'zh',
        }));
        expect(translate).toHaveBeenCalledWith(markedText);
    });

    it('Chrome 151+ 的 zh-Hans/zh-Hant 检测结果进入正确语言对和同语言短路', async () => {
        const simplifiedCreate = vi.fn(async () => ({translate: vi.fn(async () => '繁體譯文')}));
        await expect(translateWithChromeApi({text: '这是中文测试。', from: 'auto', to: 'zh-Hant'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({
                    detect: vi.fn(async () => [{detectedLanguage: 'zh-Hans', confidence: 0.99}]),
                })),
            },
            Translator: {create: simplifiedCreate},
        })).resolves.toBe('繁體譯文');
        expect(simplifiedCreate).toHaveBeenCalledWith(expect.objectContaining({
            sourceLanguage: 'zh',
            targetLanguage: 'zh-Hant',
        }));

        const sameLanguageCreate = vi.fn();
        await expect(translateWithChromeApi({text: '繁體中文測試。', from: 'auto', to: 'zh-TW'}, {
            LanguageDetector: {
                create: vi.fn(async () => ({
                    detect: vi.fn(async () => [{detectedLanguage: 'zh-Hant', confidence: 0.99}]),
                })),
            },
            Translator: {create: sameLanguageCreate},
        })).resolves.toBe('繁體中文測試。');
        expect(sameLanguageCreate).not.toHaveBeenCalled();
    });

    it('空白与同语言请求不创建 translator，auto 检测和语言映射进入真实请求', async () => {
        const createTranslator = vi.fn(async () => ({translate: vi.fn(async () => '译文')}));
        const environment = {translation: {
            createDetector: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'en'}])})),
            createTranslator,
        }};

        await expect(translateWithChromeApi({text: '   ', from: 'auto', to: 'ja'}, environment)).resolves.toBe('');
        await expect(translateWithChromeApi({text: '中文', from: 'zh-Hans', to: 'zh'}, environment)).resolves.toBe('中文');
        await expect(translateWithChromeApi({text: 'hello', from: 'auto', to: 'zh-Hant'}, environment)).resolves.toBe('译文');
        expect(createTranslator).toHaveBeenCalledOnce();
        expect(createTranslator).toHaveBeenCalledWith({sourceLanguage: 'en', targetLanguage: 'zh-Hant'});
    });

    it('明确报告不支持环境并格式化 translator 创建失败', async () => {
        await expect(translateWithChromeApi({text: 'x', from: 'en', to: 'ja'}, {}))
            .rejects.toThrow('当前浏览器未开放内置翻译接口');
        await expect(translateWithChromeApi({text: 'x', from: 'en', to: 'ja'}, {
            translation: {createTranslator: vi.fn(async () => { throw new Error('not ready'); })},
        })).rejects.toThrow('当前不可用');
        await expect(translateWithChromeApi({text: 'x', from: 'en', to: 'ja'}, {
            translation: {createTranslator: vi.fn(async () => { throw 'boom'; })},
        })).rejects.toThrow('翻译失败：boom');

        const controller = new AbortController();
        controller.abort();
        await expect(translateWithChromeApi({text: 'x', from: 'en', to: 'ja'}, {
            translation: {createTranslator: vi.fn()},
        }, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
});

describe('Chrome 中文字形与语言包保持独立', () => {
    it.each([
        ['這是一段繁體中文翻譯測試，閱讀設定與網頁內容。', 'zh-Hans', 'zh-Hant', 'zh'],
        ['这是一段简体中文翻译测试，阅读设置与网页内容。', 'zh-Hant', 'zh', 'zh-Hant'],
    ])('泛中文检测的正文 %s 按实际字形选择源语言并保留简繁互译', async (text, to, sourceLanguage, targetLanguage) => {
        const environment: ChromeTranslationEnvironment = {
            ...modernTranslator({translate: vi.fn(async () => 'converted'), destroy: vi.fn()}),
            LanguageDetector: {create: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'zh', confidence: 0.9}])}))},
        };
        await expect(translateWithChromeApi({text, from: 'auto', to}, environment)).resolves.toBe('converted');
        expect(environment.Translator!.create).toHaveBeenCalledWith(expect.objectContaining({sourceLanguage, targetLanguage}));
    });
    it('legacy 泛中文检测也使用原文精化字形，并保留共用汉字为未区分中文', async () => {
        const environment = {translation: {createDetector: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'zh'}])}))}};
        await expect(detectChromeLanguage('這是繁體翻譯測試。', environment)).resolves.toBe('zh-Hant');
        await expect(detectChromeLanguage('中文', environment)).resolves.toBe('zh');
    });
    it('泛中文与目标简体相同代码时也调用翻译器，不能自行跳过', async () => {
        const environment: ChromeTranslationEnvironment = {
            ...modernTranslator({translate: vi.fn(async () => 'result')}),
            LanguageDetector: {create: vi.fn(async () => ({detect: vi.fn(async () => [{detectedLanguage: 'zh', confidence: 0.9}])}))},
        };
        await expect(translateWithChromeApi({text: '中文', from: 'auto', to: 'zh-Hans'}, environment)).resolves.toBe('result');
        expect(environment.Translator!.create).toHaveBeenCalled();
    });
    it('显式脚本优先于地区，双方保持正确的 Chrome 模型代码', () => {
        expect(mapChromeLanguageCode('zh-Hans-HK')).toBe('zh');
        expect(mapChromeLanguageCode('zh-Hant-CN')).toBe('zh-Hant');
    });
    it('繁简语言包不可用时保留失败，不返回原文伪装成功', async () => {
        const environment = modernTranslator({}, 'unavailable');
        await expect(translateWithChromeApi({text: '繁體中文', from: 'zh-Hant', to: 'zh-Hans'}, environment)).rejects.toThrow('不可用');
        expect(environment.Translator!.create).not.toHaveBeenCalled();
    });
});
