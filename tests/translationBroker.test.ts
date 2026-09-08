import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    createTranslationBroker,
    type TranslationBroker,
    type TranslationRequestMessage,
} from '@/src/services/translation/broker';
import type {TranslationModelUsageRecord} from '@/src/services/translation/types';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {
    DEFAULT_TRANSLATION_PERSISTENCE_GRACE_MS,
    waitForBoundedPersistence,
} from '@/src/services/translation/persistenceBarrier';
import {
    attachTranslationRequestControl,
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
    getTranslationProviderConfig,
    markTranslationRemainingBudget,
    reportTranslationModelUsage,
} from '@/src/services/translation/requestSnapshot';

type CacheIdentity = {
    [key: string]: unknown;
    requestMode: string;
    sourceText: string | string[];
    sourceLanguage?: string;
    targetLanguage?: string;
    service?: string;
    model?: string;
    endpoint?: string;
    transportProfile?: string;
    context?: string;
    pageContext?: string;
    sourceLanguageDetectionText?: string;
};

const mocks = vi.hoisted(() => {
    const cacheStore = new Map<string, string>();
    const machineServices = new Set([
        'mock',
        'custom',
        'deeplx',
        'newapi',
        'minimax',
        'mimo',
        'azureOpenai',
        'chromeTranslator',
    ]);
    const aiServices = new Set(['ai', 'aiSdk', 'brokenAiSdk']);
    const aiSdkServices = new Set(['aiSdk', 'brokenAiSdk']);
    const service = vi.fn();
    const minimaxEndpoints = {
        payg: {cn: 'https://minimax.payg.cn', global: 'https://minimax.payg.global'},
        'token-plan': {cn: 'https://minimax.token.cn', global: 'https://minimax.token.global'},
    } as Record<string, Record<string, string>>;
    const providers = {
        '': service,
        freeTranslation: service,
        myMemory: service,
        apertium: service,
        ai: service,
        aiSdk: service,
        azureOpenai: service,
        chromeTranslator: service,
        brokenAiSdk: service,
        custom: service,
        deeplx: service,
        deepL: service,
        minimax: service,
        mimo: service,
        mock: service,
        newapi: service,
    };
    const buildTranslationCacheKey = vi.fn((identity: unknown) => JSON.stringify(identity));
    const config = {
        service: 'mock',
        maxConcurrentTranslations: 6,
        translationRequestsPerSecond: 0,
        translationRequestsPerMinute: 0,
        from: 'auto',
        to: 'zh-Hans',
        useCache: true,
        enableAIContext: false,
        model: {
            mock: 'mock-model',
            ai: 'ai-model',
            aiSdk: 'ai-sdk-model',
            brokenAiSdk: 'broken-ai-sdk-model',
            custom: 'custom-model',
            deeplx: 'deeplx-model',
            newapi: 'newapi-model',
            minimax: 'minimax-model',
            mimo: 'mimo-model',
        } as Record<string, string>,
        customModel: {} as Record<string, string>,
        modelThinking: {} as Record<string, Record<string, boolean>>,
        proxy: {} as Record<string, string>,
        custom: '',
        deeplApiPlan: 'free' as 'free' | 'pro',
        deeplx: '',
        newApiUrl: '',
        minimaxBillingPlan: 'payg',
        minimaxRegion: 'cn',
        mimoBillingPlan: 'payg',
        mimoRegion: 'cn',
        azureOpenaiEndpoint: '',
        customBody: {} as Record<string, string>,
        system_role: {} as Record<string, string>,
        user_role: {} as Record<string, string>,
        deepseekApiType: 'auto',
        deepseekThinkingMode: 'disabled',
    };

    return {
        aiSdkServices,
        aiServices,
        buildTranslationCacheKey,
        cacheStore,
        config,
        providers,
        endpointResolver: vi.fn((serviceName: string, _current?: unknown) => {
            if (serviceName === 'brokenAiSdk') throw new Error('endpoint missing');
            return {endpoint: `https://${serviceName}.endpoint.test`};
        }),
        getMissingCredentialMessage: vi.fn(() => null as string | null),
        machineServices,
        minimaxEndpoints,
        recordModelUsage: vi.fn(async (_events: readonly TranslationModelUsageRecord[]) => undefined),
        service,
        cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
        cacheSet: vi.fn(async (key: string, value: string) => {
            cacheStore.set(key, value);
            return true;
        }),
        cacheClear: vi.fn(async () => {
            cacheStore.clear();
        }),
        cacheCleanup: vi.fn(async () => undefined),
    };
});

let translateWithCache: TranslationBroker['translateWithCache'];
let clearTranslationCache: TranslationBroker['clearTranslationCache'];
let cleanupTranslationCache: TranslationBroker['cleanupTranslationCache'];

function installBroker(
    now?: () => number,
    ready: Promise<unknown> = Promise.resolve(),
    includeModelUsageGeneration = true,
    persistenceGraceMs?: number,
): void {
    const broker = createTranslationBroker({
        ready,
        getConfig: () => mocks.config,
        providers: mocks.providers,
        cache: {
            get: mocks.cacheGet,
            set: mocks.cacheSet,
            clear: mocks.cacheClear,
            cleanup: mocks.cacheCleanup,
        },
        serviceIds: {minimax: 'minimax', mimo: 'mimo'},
        serviceTypes: {
            machine: mocks.machineServices,
            isAI: (service: string) => mocks.aiServices.has(service),
            isAiSdk: (service: string) => mocks.aiSdkServices.has(service),
            isUseAIContext: (service: string) => service === 'ai' || service === 'aiSdk' || service === 'brokenAiSdk',
        },
        endpointResolver: {
            resolveOpenAICompatibleEndpoint: mocks.endpointResolver,
            getMimoEndpoint: (plan: string, region: string) => `https://mimo.${plan}.${region}.test`,
            minimaxEndpoints: mocks.minimaxEndpoints,
            aiSdkTransportProfile: 'ai-sdk-profile',
        },
        promptBuilder: {
            buildPageSummaryPrompt: (pageContext: string) => `summarize:${pageContext}`,
            buildPageSummarySystemPrompt: () => 'summary-system',
        },
        getMissingCredentialMessage: mocks.getMissingCredentialMessage,
        getTranslationLanguages: (override?: {sourceLanguage?: string; targetLanguage?: string}) => resolveTranslationLanguages(
            override, {sourceLanguage: mocks.config.from, targetLanguage: mocks.config.to},
        ),
        resolveConfiguredModel: (selected?: string, custom?: string) => custom || selected || '',
        buildTranslationCacheKey: mocks.buildTranslationCacheKey,
        captureModelUsageGeneration: includeModelUsageGeneration ? () => 7 : undefined,
        recordModelUsage: mocks.recordModelUsage,
        persistenceGraceMs,
        now,
    });
    translateWithCache = broker.translateWithCache;
    clearTranslationCache = broker.clearTranslationCache;
    cleanupTranslationCache = broker.cleanupTranslationCache;
}

function cacheKey(identity: CacheIdentity): string {
    return JSON.stringify(identity);
}

function cacheIdentityAt(index: number): CacheIdentity {
    return mocks.buildTranslationCacheKey.mock.calls[index][0] as CacheIdentity;
}

function translationCacheIdentities(): CacheIdentity[] {
    return mocks.buildTranslationCacheKey.mock.calls
        .map(([identity]) => identity as CacheIdentity)
        .filter(identity => identity.requestMode !== 'page-summary');
}

async function flushMicrotasks(times = 20): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await Promise.resolve();
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, reject, resolve};
}

describe('translation broker', () => {
    it('keeps simultaneous simplified and traditional requests separate and reuses only matching script aliases', async () => {
        const simplified = deferred<string>();
        const traditional = deferred<string>();
        mocks.service.mockImplementation((message) => message.targetLanguage === 'zh-Hans' ? simplified.promise : traditional.promise);
        const hans = translateWithCache({origin: 'The network settings', sourceLanguage: 'en', targetLanguage: 'zh-CN'});
        const hant = translateWithCache({origin: 'The network settings', sourceLanguage: 'en', targetLanguage: 'zh-TW'});
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(2));
        expect(mocks.service.mock.calls.map(([message]) => message.targetLanguage)).toEqual(['zh-Hans', 'zh-Hant']);
        simplified.resolve('网络设置');
        traditional.resolve('網路設定');
        await expect(hans).resolves.toBe('网络设置');
        await expect(hant).resolves.toBe('網路設定');
        await expect(translateWithCache({origin: 'The network settings', sourceLanguage: 'en', targetLanguage: 'zh-HK'})).resolves.toBe('網路設定');
        await expect(translateWithCache({origin: 'The network settings', sourceLanguage: 'en', targetLanguage: 'zh-SG'})).resolves.toBe('网络设置');
        expect(mocks.service).toHaveBeenCalledTimes(2);
        await expect(translateWithCache({origin: 'The network settings', sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hant'})).resolves.toBe('網路設定');
        await expect(translateWithCache({origin: 'The network settings', sourceLanguage: 'zh-Hant', targetLanguage: 'zh-Hans'})).resolves.toBe('网络设置');
        expect(mocks.service).toHaveBeenCalledTimes(4);
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.cacheStore.clear();
        mocks.aiSdkServices.clear();
        mocks.aiSdkServices.add('aiSdk');
        mocks.aiSdkServices.add('brokenAiSdk');
        mocks.aiServices.clear();
        mocks.aiServices.add('ai');
        mocks.aiServices.add('aiSdk');
        mocks.aiServices.add('brokenAiSdk');
        mocks.machineServices.clear();
        ['mock', 'freeTranslation', 'myMemory', 'custom', 'deeplx', 'newapi', 'minimax', 'mimo', 'azureOpenai', 'chromeTranslator']
            .forEach(service => mocks.machineServices.add(service));
        Object.assign(mocks.config, {
            service: 'mock',
            from: 'auto',
            to: 'zh-Hans',
            useCache: true,
            enableAIContext: false,
            maxConcurrentTranslations: 6,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
            proxy: {},
            custom: '',
            deeplApiPlan: 'free',
            deeplx: '',
            newApiUrl: '',
            minimaxBillingPlan: 'payg',
            minimaxRegion: 'cn',
            mimoBillingPlan: 'payg',
            mimoRegion: 'cn',
            azureOpenaiEndpoint: '',
            customBody: {},
            system_role: {},
            user_role: {},
            deepseekApiType: 'auto',
            deepseekThinkingMode: 'disabled',
            modelThinking: {},
            freeTranslationOrder: undefined,
            freeTranslationTimeoutMs: undefined,
            freeTranslationCooldownMs: undefined,
            myMemoryEmail: undefined,
        });
        mocks.config.model = {
            mock: 'mock-model',
            ai: 'ai-model',
            aiSdk: 'ai-sdk-model',
            azureOpenai: 'azure-openai-model',
            chromeTranslator: '',
            brokenAiSdk: 'broken-ai-sdk-model',
            custom: 'custom-model',
            deeplx: 'deeplx-model',
            newapi: 'newapi-model',
            minimax: 'minimax-model',
            mimo: 'mimo-model',
        };
        mocks.config.customModel = {};
        mocks.service.mockReset();
        mocks.service.mockResolvedValue('默认译文');
        mocks.getMissingCredentialMessage.mockReturnValue(null);
        mocks.endpointResolver.mockImplementation((serviceName: string, _current?: unknown) => {
            if (serviceName === 'brokenAiSdk') throw new Error('endpoint missing');
            return {endpoint: `https://${serviceName}.endpoint.test`};
        });
        Object.assign(mocks.minimaxEndpoints, {
            payg: {cn: 'https://minimax.payg.cn', global: 'https://minimax.payg.global'},
            'token-plan': {cn: 'https://minimax.token.cn', global: 'https://minimax.token.global'},
        });
        installBroker();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('isolates ordered anonymous routes while ignoring credentials and private endpoints', async () => {
        mocks.config.service = 'freeTranslation';
        const policy = mocks.config as typeof mocks.config & {freeTranslationOrder: string[]};
        policy.freeTranslationOrder = ['myMemory', 'microsoft'];
        mocks.service.mockResolvedValue('first provider translation');
        await translateWithCache({origin: 'same source'});
        await translateWithCache({origin: 'same source'});
        expect(mocks.service).toHaveBeenCalledTimes(1);
        policy.freeTranslationOrder = ['microsoft', 'myMemory'];
        await translateWithCache({origin: 'same source'});
        expect(mocks.service).toHaveBeenCalledTimes(2);
        mocks.config.deeplx = 'https://private.example/translate';
        mocks.config.proxy = {deeplx: 'https://private.example/proxy'};
        await translateWithCache({origin: 'same source', context: 'not used by anonymous APIs'});
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(translationCacheIdentities().at(-1)).toMatchObject({freeTranslationPolicy: {
            version: 2, order: ['microsoft', 'myMemory'],
        }});
        delete (policy as Partial<typeof policy>).freeTranslationOrder;
    });

    it.each([
        ['freeTranslation', false], ['freeTranslation', true],
        ['myMemory', false], ['myMemory', true],
    ] as const)('%s 的 MyMemory 邮箱变更隔离在途执行并复用成功缓存，批量=%s', async (service, batch) => {
        const policy = mocks.config as typeof mocks.config & {myMemoryEmail?: string; freeTranslationOrder?: string[]};
        Object.assign(policy, {service, myMemoryEmail: '', freeTranslationOrder: ['myMemory']});
        const request: TranslationRequestMessage = batch ? {origin: ['same source']} : {origin: 'same source'};
        const translated = batch ? ['新邮箱译文'] : '新邮箱译文';
        const previous = deferred<string | string[]>();
        mocks.service.mockImplementation(message => {
            const current = getTranslationProviderConfig(message, mocks.config as never);
            return current.myMemoryEmail === 'reader@example.com' ? Promise.resolve(translated) : previous.promise;
        });
        const oldRequest = translateWithCache(request).catch(error => error);
        await flushMicrotasks();
        policy.myMemoryEmail = 'reader@example.com';
        const newRequest = translateWithCache(request).catch(error => error);
        await flushMicrotasks();
        previous.reject(new Error('旧匿名额度已用尽'));
        expect(await oldRequest).toBeInstanceOf(Error);
        expect(await newRequest).toEqual(translated);
        expect(mocks.service).toHaveBeenCalledTimes(2);
        policy.myMemoryEmail = 'another@example.com';
        await expect(translateWithCache(request)).resolves.toEqual(translated);
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it.each(['freeTranslationTimeoutMs', 'freeTranslationCooldownMs'] as const)('免费链 %s 变更不共享旧等待策略的在途失败', async field => {
        Object.assign(mocks.config, {service: 'freeTranslation', useCache: false, [field]: 1_000});
        const previous = deferred<string>();
        mocks.service.mockImplementation(message => {
            const current = getTranslationProviderConfig(message, mocks.config as never);
            return current[field] === 5_000 ? Promise.resolve('新策略译文') : previous.promise;
        });
        const oldRequest = translateWithCache({origin: 'same source'}).catch(error => error);
        await flushMicrotasks();
        Object.assign(mocks.config, {[field]: 5_000});
        const newRequest = translateWithCache({origin: 'same source'}).catch(error => error);
        await flushMicrotasks();
        previous.reject(new Error('旧策略执行失败'));
        expect(await oldRequest).toBeInstanceOf(Error);
        expect(await newRequest).toBe('新策略译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it.each(['freeTranslation', 'myMemory', 'apertium'])('%s 在途去重归一默认值且忽略实际不用的 Key 与代理', async service => {
        Object.assign(mocks.config, {service, useCache: false});
        const pending = deferred<string>();
        mocks.service.mockReturnValue(pending.promise);
        const first = translateWithCache({origin: 'same source'});
        await flushMicrotasks();
        Object.assign(mocks.config, {
            freeTranslationTimeoutMs: 5_000,
            freeTranslationCooldownMs: 60_000,
            myMemoryEmail: '  ',
            token: {[service]: 'saved-key'},
            proxy: {[service]: 'https://private.example/proxy', deeplx: 'https://private.example/deeplx'},
            deeplx: 'https://private.example/translate',
        });
        const second = translateWithCache({origin: 'same source'});
        await flushMicrotasks();
        pending.resolve('共享译文');
        await expect(Promise.all([first, second])).resolves.toEqual(['共享译文', '共享译文']);
        expect(mocks.service).toHaveBeenCalledTimes(1);
    });

    it('未启用 MyMemory 的免费链不因邮箱变化拆分在途请求', async () => {
        Object.assign(mocks.config, {service: 'freeTranslation', freeTranslationOrder: ['microsoft']});
        const pending = deferred<string>();
        mocks.service.mockReturnValue(pending.promise);
        const first = translateWithCache({origin: 'same source'});
        await flushMicrotasks();
        Object.assign(mocks.config, {myMemoryEmail: 'reader@example.com'});
        const second = translateWithCache({origin: 'same source'});
        await flushMicrotasks();
        pending.resolve('共享译文');
        await expect(Promise.all([first, second])).resolves.toEqual(['共享译文', '共享译文']);
        expect(mocks.service).toHaveBeenCalledTimes(1);
    });

    it('圈选事务携带可信配置快照时沿用OCR开始前的服务模型与提示，忽略同名字符串伪造', async () => {
        mocks.config.service = 'ai';
        const snapshot = createTranslationProviderConfigSnapshot({...mocks.config,
            system_role: {...mocks.config.system_role, ai: 'frozen-area-prompt'},
            model: {...mocks.config.model, ai: 'frozen-area-model'},
        });
        mocks.config.service = 'mock';
        mocks.service.mockResolvedValue('translated');
        await translateWithCache(attachTranslationProviderConfig({origin: 'ocr text', useCache: false}, snapshot));
        const providerRequest = mocks.service.mock.calls[0][0];
        expect(getTranslationProviderConfig(providerRequest, snapshot).system_role.ai).toBe('frozen-area-prompt');
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'ai', model: 'frozen-area-model'});
        await translateWithCache({origin: 'second text', useCache: false, TRANSLATION_PROVIDER_CONFIG: snapshot} as any);
        expect(translationCacheIdentities().at(-1)?.service).toBe('mock');
    });

    it('reuses persisted single cache entries, including successful unchanged results', async () => {
        mocks.service.mockResolvedValueOnce('共享译文');
        await expect(translateWithCache({origin: 'Readable source'})).resolves.toBe('共享译文');
        await expect(translateWithCache({origin: 'Readable source'})).resolves.toBe('共享译文');

        expect(mocks.service).toHaveBeenCalledTimes(1);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
        expect(mocks.cacheGet).toHaveBeenCalledTimes(2);

        await clearTranslationCache();
        vi.clearAllMocks();
        mocks.service.mockResolvedValueOnce('Same');
        await expect(translateWithCache({origin: 'Same'})).resolves.toBe('Same');
        await expect(translateWithCache({origin: 'Same'})).resolves.toBe('Same');
        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.cacheSet).toHaveBeenCalledWith(expect.any(String), 'Same');

        await clearTranslationCache();
        mocks.service.mockResolvedValueOnce('Same');
        await expect(translateWithCache({origin: 'Same'})).resolves.toBe('Same');
        expect(mocks.service).toHaveBeenCalledTimes(2);

        await clearTranslationCache();
        vi.clearAllMocks();
        mocks.service.mockResolvedValueOnce('');
        await expect(translateWithCache({origin: 'Empty'})).resolves.toBe('');

        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('bypasses cache when disabled globally or by request', async () => {
        mocks.service.mockResolvedValue('直连译文');

        mocks.config.useCache = false;
        await expect(translateWithCache({origin: 'A'})).resolves.toBe('直连译文');

        mocks.config.useCache = true;
        await expect(translateWithCache({origin: 'B', useCache: false})).resolves.toBe('直连译文');

        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it('关闭缓存仍按完整身份合并同一在途单条和批量请求，并在失败后释放 pending', async () => {
        mocks.config.useCache = false;
        const singleProvider = deferred<string>();
        mocks.service.mockImplementationOnce(() => singleProvider.promise);

        const firstSingle = translateWithCache({origin: 'No-cache pending'});
        const secondSingle = translateWithCache({origin: 'No-cache pending'});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();
        singleProvider.resolve('共享单条译文');
        await expect(Promise.all([firstSingle, secondSingle]))
            .resolves.toEqual(['共享单条译文', '共享单条译文']);

        mocks.service.mockRejectedValueOnce(new Error('temporary failure'));
        await expect(translateWithCache({origin: 'No-cache retry'})).rejects.toThrow('temporary failure');
        mocks.service.mockResolvedValueOnce('恢复译文');
        await expect(translateWithCache({origin: 'No-cache retry'})).resolves.toBe('恢复译文');

        const batchProvider = deferred<string[]>();
        mocks.service.mockImplementationOnce(() => batchProvider.promise);
        const firstBatch = translateWithCache({origin: ['No-cache A', 'No-cache B']});
        const secondBatch = translateWithCache({origin: ['No-cache A', 'No-cache B']});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(4);
        batchProvider.resolve(['无缓存甲', '无缓存乙']);
        await expect(Promise.all([firstBatch, secondBatch])).resolves.toEqual([
            ['无缓存甲', '无缓存乙'],
            ['无缓存甲', '无缓存乙'],
        ]);
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('内部取消会中止自己的 provider，且所有权不会劫持同缓存身份的普通调用方', async () => {
        mocks.config.useCache = false;
        const controlledProvider = deferred<string>();
        let controlledSignal: AbortSignal | undefined;
        mocks.service
            .mockImplementationOnce((message: {abortSignal?: AbortSignal}) => {
                controlledSignal = message.abortSignal;
                return controlledProvider.promise;
            })
            .mockResolvedValueOnce('普通译文');
        const controller = new AbortController();
        const controlled = translateWithCache(attachTranslationRequestControl({
            origin: 'Owned pending',
            useCache: false,
            requestTimeoutMs: 5_000,
        }, {
            signal: controller.signal,
            ownershipKey: 'image:owned-1',
        }));
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledOnce());

        const ordinary = translateWithCache({
            origin: 'Owned pending',
            useCache: false,
            requestTimeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(2));
        await expect(ordinary).resolves.toBe('普通译文');

        controller.abort();
        await expect(controlled).rejects.toMatchObject({name: 'AbortError'});
        expect(controlledSignal?.aborted).toBe(true);
        const identities = translationCacheIdentities();
        expect(identities).toHaveLength(2);
        expect(identities[0]).toEqual(identities[1]);

        controlledProvider.resolve('迟到译文');
        await flushMicrotasks();
    });

    it('内部取消在配置水合或缓存读取阶段也立即释放且不启动 provider', async () => {
        const ready = deferred<unknown>();
        installBroker(undefined, ready.promise);
        const readyController = new AbortController();
        const waitingForReady = translateWithCache(attachTranslationRequestControl({
            origin: 'Waiting ready',
            requestTimeoutMs: 5_000,
        }, {
            signal: readyController.signal,
            ownershipKey: 'image:ready',
        }));
        await flushMicrotasks();
        readyController.abort();
        await expect(waitingForReady).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.service).not.toHaveBeenCalled();
        ready.resolve(undefined);

        installBroker();
        const cacheRead = deferred<string | null>();
        mocks.cacheGet.mockImplementationOnce(() => cacheRead.promise);
        const cacheController = new AbortController();
        const waitingForCache = translateWithCache(attachTranslationRequestControl({
            origin: 'Waiting cache',
            requestTimeoutMs: 5_000,
        }, {
            signal: cacheController.signal,
            ownershipKey: 'image:cache',
        }));
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledOnce());
        cacheController.abort();
        await expect(waitingForCache).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.service).not.toHaveBeenCalled();
        cacheRead.resolve(null);
        await flushMicrotasks();
    });

    it.each([
        {label: '单条', origin: 'Shared pending body', result: '共享译文'},
        {label: '批量', origin: ['Shared first body', 'Shared second body'], result: ['第一条译文', '第二条译文']},
    ])('共享$label等待者取消只结束自己的等待，迟到成功不能覆盖取消', async ({origin, result}) => {
        const provider = deferred<string | string[]>();
        let providerSignal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            providerSignal = message.abortSignal;
            return provider.promise;
        });
        const ownerController = new AbortController();
        const waiterController = new AbortController();
        const request = () => typeof origin === 'string'
            ? {origin, useCache: false, requestTimeoutMs: 5_000}
            : {origin, useCache: false, requestTimeoutMs: 5_000};
        const owner = translateWithCache(attachTranslationRequestControl(request(), {
            signal: ownerController.signal,
            ownershipKey: 'shared-body',
        }));
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledOnce());
        const waiter = translateWithCache(attachTranslationRequestControl(request(), {
            signal: waiterController.signal,
            ownershipKey: 'shared-body',
        }));
        const success = vi.fn();
        const failure = vi.fn();
        const settledWaiter = waiter.then(success, failure);
        await flushMicrotasks();

        waiterController.abort();
        await flushMicrotasks();
        const cancelledBeforeProviderSettled = failure.mock.calls.length === 1;
        expect(providerSignal?.aborted).toBe(false);
        provider.resolve(result);
        await expect(owner).resolves.toEqual(result);
        await settledWaiter;

        expect(cancelledBeforeProviderSettled).toBe(true);
        expect(failure).toHaveBeenCalledWith(expect.objectContaining({name: 'AbortError'}));
        expect(success).not.toHaveBeenCalled();
        expect(mocks.service).toHaveBeenCalledOnce();
    });

    it('同步缓存操作触发取消时也已取得监听所有权', async () => {
        const controller = new AbortController();
        mocks.cacheGet.mockImplementationOnce(() => {
            controller.abort();
            return new Promise<string | null>(() => undefined);
        });

        const request = translateWithCache(attachTranslationRequestControl({
            origin: 'Synchronous cache cancellation',
            requestTimeoutMs: 5_000,
        }, {
            signal: controller.signal,
            ownershipKey: 'image:sync-cache',
        }));

        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('预取消立即拒绝，共享摘要等待者取消不影响 owner，owner 取消继续向上抛出', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.config.useCache = false;
        const preAborted = new AbortController();
        preAborted.abort();
        await expect(translateWithCache(attachTranslationRequestControl({
            origin: 'Pre-aborted summary',
            pageContext: 'Article',
            useCache: false,
        }, {
            signal: preAborted.signal,
            ownershipKey: 'image:shared-summary',
        }))).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.service).not.toHaveBeenCalled();

        const summary = deferred<string>();
        let providerSignal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal; summaryPrompt?: string}) => {
            if (!message.summaryPrompt) throw new Error('取消摘要后不应启动正文 provider');
            providerSignal = message.abortSignal;
            return summary.promise;
        });
        const ownerController = new AbortController();
        const waiterController = new AbortController();
        const owner = translateWithCache(attachTranslationRequestControl({
            origin: 'Summary owner',
            pageContext: 'Shared article context',
            useCache: false,
        }, {
            signal: ownerController.signal,
            ownershipKey: 'image:shared-summary',
        }));
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledOnce());
        const waiter = translateWithCache(attachTranslationRequestControl({
            origin: 'Summary waiter',
            pageContext: 'Shared article context',
            useCache: false,
        }, {
            signal: waiterController.signal,
            ownershipKey: 'image:shared-summary',
        }));
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();

        waiterController.abort();
        await expect(waiter).rejects.toMatchObject({name: 'AbortError'});
        expect(providerSignal?.aborted).toBe(false);
        ownerController.abort();
        await expect(owner).rejects.toMatchObject({name: 'AbortError'});
        expect(providerSignal?.aborted).toBe(true);
        summary.resolve('迟到摘要');
        await flushMicrotasks();
    });

    it('持久化宽限直接覆盖成功、失败、默认时限和诊断器异常', async () => {
        const failure = new Error('direct persistence failure');
        const onFailure = vi.fn();
        const onTimeout = vi.fn();
        await expect(waitForBoundedPersistence(Promise.resolve(), {
            graceMs: 1.9,
            onFailure,
            onTimeout,
        })).resolves.toBeUndefined();
        expect(onFailure).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();

        await expect(waitForBoundedPersistence(Promise.reject(failure), {
            graceMs: -1,
            onFailure,
            onTimeout,
        })).resolves.toBeUndefined();
        expect(onFailure).toHaveBeenCalledWith(failure);

        await expect(waitForBoundedPersistence(Promise.reject(failure), {
            graceMs: Number.NaN,
            onFailure: () => { throw new Error('broken failure logger'); },
            onTimeout,
        })).resolves.toBeUndefined();

        vi.useFakeTimers();
        const hung = waitForBoundedPersistence(new Promise<void>(() => undefined), {
            onFailure,
            onTimeout: () => { throw new Error('broken timeout logger'); },
        });
        await vi.advanceTimersByTimeAsync(DEFAULT_TRANSLATION_PERSISTENCE_GRACE_MS);
        await expect(hung).resolves.toBeUndefined();
    });

    it('关闭缓存不会合并模型或 deadline 不同的请求，也不与缓存请求共享 pending', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(0);
        const requests = Array.from({length: 4}, () => deferred<string>());
        requests.forEach(({promise}) => mocks.service.mockImplementationOnce(() => promise));

        const outcomes = [
            translateWithCache({origin: 'Full identity', modelOverride: 'model-a', useCache: false, requestTimeoutMs: 2_000}),
            translateWithCache({origin: 'Full identity', modelOverride: 'model-b', useCache: false, requestTimeoutMs: 2_000}),
            translateWithCache({origin: 'Full identity', modelOverride: 'model-a', useCache: false, requestTimeoutMs: 3_000}),
            translateWithCache({origin: 'Full identity', modelOverride: 'model-a', useCache: true, requestTimeoutMs: 2_000}),
        ];
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(4);
        requests.forEach((request, index) => request.resolve(`译文 ${index}`));
        await expect(Promise.all(outcomes)).resolves.toEqual(['译文 0', '译文 1', '译文 2', '译文 3']);
        expect(mocks.cacheGet).toHaveBeenCalled();
        expect(mocks.cacheSet).toHaveBeenCalledOnce();
    });

    it('空单条和空批量请求直接返回，不读取凭据、缓存或 provider', async () => {
        mocks.getMissingCredentialMessage.mockReturnValue('missing credential');

        await expect(translateWithCache({origin: '  \n'})).resolves.toBe('  \n');
        await expect(translateWithCache({origin: []})).resolves.toEqual([]);
        expect(mocks.getMissingCredentialMessage).not.toHaveBeenCalled();
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('拒绝 provider 的非字符串单条结果，且不污染缓存', async () => {
        mocks.service.mockResolvedValueOnce({translated: '对象不是协议结果'});
        await expect(translateWithCache({origin: 'Cached invalid'})).rejects.toThrow('单条翻译返回格式异常');

        mocks.service.mockResolvedValueOnce(undefined);
        await expect(translateWithCache({origin: 'Direct invalid', useCache: false})).rejects.toThrow('单条翻译返回格式异常');
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent single requests and clears pending state after success and rejection', async () => {
        let resolveFirst!: (value: string) => void;
        mocks.service.mockImplementationOnce(() => new Promise<string>(resolve => {
            resolveFirst = resolve;
        }));

        const first = translateWithCache({origin: 'Pending'});
        const second = translateWithCache({origin: 'Pending'});
        await flushMicrotasks();
        resolveFirst('Pending 译文');

        await expect(first).resolves.toBe('Pending 译文');
        await expect(second).resolves.toBe('Pending 译文');
        expect(mocks.service).toHaveBeenCalledTimes(1);

        await clearTranslationCache();
        mocks.service
            .mockRejectedValueOnce(new Error('provider down'))
            .mockResolvedValueOnce('恢复译文');

        await expect(translateWithCache({origin: 'Reject once'})).rejects.toThrow('provider down');
        await expect(translateWithCache({origin: 'Reject once'})).resolves.toBe('恢复译文');
        expect(mocks.service).toHaveBeenCalledTimes(3);
    });

    it('在后台 provider 入口按配置限制跨调用方的真实并发', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.config.useCache = false;
        mocks.config.maxConcurrentTranslations = 1;
        const firstProvider = deferred<string>();
        mocks.service
            .mockImplementationOnce(() => firstProvider.promise)
            .mockResolvedValueOnce('第二个译文');

        const first = translateWithCache({origin: 'Scheduler first', useCache: false});
        const second = translateWithCache({origin: 'Scheduler second', useCache: false});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(1);

        firstProvider.resolve('第一个译文');
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(2);
        await expect(Promise.all([first, second])).resolves.toEqual(['第一个译文', '第二个译文']);
    });

    it('在后台 provider 入口按每秒请求上限延后新的真实请求', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.config.useCache = false;
        mocks.config.maxConcurrentTranslations = 10;
        mocks.config.translationRequestsPerSecond = 1;
        mocks.service
            .mockResolvedValueOnce('第一秒译文')
            .mockResolvedValueOnce('下一秒译文');

        const first = translateWithCache({origin: 'Rate first', useCache: false});
        const second = translateWithCache({origin: 'Rate second', useCache: false});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(mocks.service).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(2);
        await expect(Promise.all([first, second])).resolves.toEqual(['第一秒译文', '下一秒译文']);
    });

    it('provider 调度排队超过请求预算时返回统一超时错误', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.config.useCache = false;
        mocks.config.maxConcurrentTranslations = 1;
        const firstProvider = deferred<string>();
        mocks.service.mockImplementationOnce(() => firstProvider.promise);

        const first = translateWithCache({origin: 'Deadline scheduler first', useCache: false});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();

        const second = translateWithCache({
            origin: 'Deadline scheduler second',
            useCache: false,
            requestTimeoutMs: 1_000,
        });
        const secondOutcome = second.catch((error) => error);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(secondOutcome).resolves.toMatchObject({message: '翻译请求超时'});
        expect(mocks.service).toHaveBeenCalledOnce();

        firstProvider.resolve('第一个译文');
        await expect(first).resolves.toBe('第一个译文');
    });

    it('跨毫秒启动的同预算单条与批量请求仍使用稳定 pending 身份', async () => {
        const singleTimestamps = [0, 0, 1, 1];
        installBroker(() => singleTimestamps.shift() ?? 1);
        const singleProvider = deferred<string>();
        mocks.service.mockImplementation(() => singleProvider.promise);

        const firstSingle = translateWithCache({origin: 'Cross-millisecond single'});
        const secondSingle = translateWithCache({origin: 'Cross-millisecond single'});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({requestTimeoutMs: 44_999}));
        singleProvider.resolve('稳定单条译文');
        await expect(Promise.all([firstSingle, secondSingle]))
            .resolves.toEqual(['稳定单条译文', '稳定单条译文']);

        mocks.service.mockReset();
        mocks.cacheGet.mockClear();
        mocks.cacheStore.clear();
        const batchTimestamps = [0, 0, 1, 1];
        installBroker(() => batchTimestamps.shift() ?? 1);
        const batchProvider = deferred<string[]>();
        mocks.service.mockImplementation(() => batchProvider.promise);

        const firstBatch = translateWithCache({origin: ['Cross', 'millisecond']});
        const secondBatch = translateWithCache({origin: ['Cross', 'millisecond']});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({requestTimeoutMs: 44_999}));
        batchProvider.resolve(['跨毫秒', '批量译文']);
        await expect(Promise.all([firstBatch, secondBatch]))
            .resolves.toEqual([
                ['跨毫秒', '批量译文'],
                ['跨毫秒', '批量译文'],
            ]);
    });

    it('只合并超时预算完全相同的并发请求，不混用不同 deadline', async () => {
        // provider 会扣除摘要阶段已经消耗的毫秒；冻结时钟后只验证 timeout identity 本身。
        vi.spyOn(Date, 'now').mockReturnValue(0);
        const firstWave = [deferred<string>(), deferred<string>()];
        mocks.service
            .mockImplementationOnce(() => firstWave[0].promise)
            .mockImplementationOnce(() => firstWave[1].promise);

        // 步骤 1：先短后长；过去按秒取整会错误共享同一个 pending Promise。
        const shortFirst = translateWithCache({origin: 'Timeout identity A', requestTimeoutMs: 1_001});
        const longSecond = translateWithCache({origin: 'Timeout identity A', requestTimeoutMs: 1_999});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.service.mock.calls.map(([message]) => message.requestTimeoutMs)).toEqual([1_001, 1_999]);
        firstWave[0].resolve('短预算译文');
        firstWave[1].resolve('长预算译文');
        await expect(Promise.all([shortFirst, longSecond])).resolves.toEqual(['短预算译文', '长预算译文']);

        await clearTranslationCache();
        mocks.service.mockClear();
        const secondWave = [deferred<string>(), deferred<string>()];
        mocks.service
            .mockImplementationOnce(() => secondWave[0].promise)
            .mockImplementationOnce(() => secondWave[1].promise);

        // 步骤 2：再验证相反顺序，避免较短 deadline 被较长请求放宽。
        const longFirst = translateWithCache({origin: 'Timeout identity B', requestTimeoutMs: 1_999});
        const shortSecond = translateWithCache({origin: 'Timeout identity B', requestTimeoutMs: 1_001});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.service.mock.calls.map(([message]) => message.requestTimeoutMs)).toEqual([1_999, 1_001]);
        secondWave[0].resolve('长预算译文');
        secondWave[1].resolve('短预算译文');
        await expect(Promise.all([longFirst, shortSecond])).resolves.toEqual(['长预算译文', '短预算译文']);

        await clearTranslationCache();
        mocks.service.mockClear();
        const sameBudget = deferred<string>();
        mocks.service.mockImplementationOnce(() => sameBudget.promise);

        // 步骤 3：完全相同的归一化预算仍应共享 provider 工作。
        const sameFirst = translateWithCache({origin: 'Timeout identity C', requestTimeoutMs: 1_999.9});
        const sameSecond = translateWithCache({origin: 'Timeout identity C', requestTimeoutMs: 1_999.1});
        await flushMicrotasks();
        expect(mocks.service).toHaveBeenCalledOnce();
        sameBudget.resolve('共享预算译文');
        await expect(Promise.all([sameFirst, sameSecond])).resolves.toEqual(['共享预算译文', '共享预算译文']);
    });

    it('单条 provider 超时会中止信号、释放 pending，并忽略迟到结果的缓存写入', async () => {
        vi.useFakeTimers();
        const late = deferred<string>();
        let firstSignal: AbortSignal | undefined;
        mocks.service
            .mockImplementationOnce((message: {abortSignal?: AbortSignal}) => {
                firstSignal = message.abortSignal;
                return late.promise;
            })
            .mockResolvedValueOnce('新译文');

        const first = translateWithCache({origin: 'Deadline single', requestTimeoutMs: 1_000});
        const firstRejection = expect(first).rejects.toThrow('翻译请求超时');
        await flushMicrotasks();
        expect(firstSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        await firstRejection;
        expect(firstSignal?.aborted).toBe(true);

        // 步骤 1：相同 cache/pending identity 必须重新调用 provider，而不是复用已超时 Promise。
        await expect(translateWithCache({origin: 'Deadline single', requestTimeoutMs: 1_000}))
            .resolves.toBe('新译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSet).toHaveBeenCalledOnce();

        // 步骤 2：旧 provider 即使随后返回，也不能把新译文覆盖成迟到结果。
        late.resolve('迟到译文');
        await flushMicrotasks();
        expect(mocks.cacheSet).toHaveBeenCalledOnce();
        expect([...mocks.cacheStore.values()]).toEqual(['新译文']);
    });

    it('未显式传 deadline 的内部调用也有默认上限，不会永久悬挂', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        mocks.service.mockImplementationOnce((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string>(() => undefined);
        });

        const request = translateWithCache({origin: 'Default deadline', useCache: false});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(45_000);
        await rejection;
        expect(signal?.aborted).toBe(true);
    });

    it('批量 provider 超时后释放 pending，允许同一批次重试且不缓存迟到数组', async () => {
        vi.useFakeTimers();
        const late = deferred<string[]>();
        let firstSignal: AbortSignal | undefined;
        mocks.service
            .mockImplementationOnce((message: {abortSignal?: AbortSignal}) => {
                firstSignal = message.abortSignal;
                return late.promise;
            })
            .mockResolvedValueOnce(['新 A', '新 B']);

        const first = translateWithCache({origin: ['A', 'B'], requestTimeoutMs: 1_000});
        const firstRejection = expect(first).rejects.toThrow('翻译请求超时');
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(1_000);
        await firstRejection;
        expect(firstSignal?.aborted).toBe(true);

        await expect(translateWithCache({origin: ['A', 'B'], requestTimeoutMs: 1_000}))
            .resolves.toEqual(['新 A', '新 B']);
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(2);

        late.resolve(['迟到 A', '迟到 B']);
        await flushMicrotasks();
        expect(mocks.cacheSet).toHaveBeenCalledTimes(2);
        expect([...mocks.cacheStore.values()].sort()).toEqual(['新 A', '新 B']);
    });

    it('deduplicates missing batch entries, preserves order, and reuses full batch cache hits', async () => {
        mocks.service.mockImplementation(async (message: {origin: string[]}) => (
            message.origin.map(origin => `${origin}-译文`)
        ));

        await expect(translateWithCache({
            origin: ['same', 'same', 'other'],
            sourceLanguage: 'en',
            targetLanguage: 'zh-Hans',
        })).resolves.toEqual(['same-译文', 'same-译文', 'other-译文']);

        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: ['same', 'other'],
            sourceLanguage: 'en',
            targetLanguage: 'zh-Hans',
        }));

        mocks.service.mockClear();
        await expect(translateWithCache({
            origin: ['same', 'other'],
            sourceLanguage: 'en',
            targetLanguage: 'zh-Hans',
        })).resolves.toEqual(['same-译文', 'other-译文']);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('persists unchanged batch items so ambiguous target-language text is not translated again', async () => {
        mocks.service.mockResolvedValueOnce(['中文', '英文译文']);

        await expect(translateWithCache({
            origin: ['中文', 'English source'],
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
        })).resolves.toEqual(['中文', '英文译文']);
        await expect(translateWithCache({
            origin: ['中文', 'English source'],
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
        })).resolves.toEqual(['中文', '英文译文']);

        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.cacheSet.mock.calls.map(([, value]) => value))
            .toEqual(expect.arrayContaining(['中文', '英文译文']));
    });

    it('rejects invalid batch provider results and clears rejected pending batches', async () => {
        mocks.service.mockResolvedValueOnce('not-array');
        await expect(translateWithCache({origin: ['A'], useCache: false})).rejects.toThrow('批量翻译返回格式异常');

        mocks.service.mockResolvedValueOnce(['A', 'extra']);
        await expect(translateWithCache({origin: ['A'], useCache: false})).rejects.toThrow('批量翻译返回数量异常');

        mocks.service.mockResolvedValueOnce(['A', undefined]);
        await expect(translateWithCache({origin: ['A', 'B'], useCache: false})).rejects.toThrow('批量翻译返回格式异常');

        mocks.service.mockResolvedValueOnce(['直连 A']);
        await expect(translateWithCache({origin: ['A'], useCache: false})).resolves.toEqual(['直连 A']);

        mocks.service.mockResolvedValueOnce(new Array(2));
        await expect(translateWithCache({origin: ['A', 'B'], useCache: false}))
            .rejects.toThrow('批量翻译返回格式异常');
        mocks.service.mockResolvedValueOnce(['A', ,] as string[]);
        await expect(translateWithCache({origin: ['A', 'B'], useCache: false}))
            .rejects.toThrow('批量翻译返回格式异常');

        mocks.service.mockResolvedValueOnce(['only-one']);
        await expect(translateWithCache({origin: ['A', 'B']})).rejects.toThrow('批量翻译返回数量异常');

        mocks.service.mockResolvedValueOnce(['A-译文', null]);
        await expect(translateWithCache({origin: ['A', 'B']})).rejects.toThrow('批量翻译返回格式异常');

        mocks.service.mockResolvedValueOnce(['A-译文', 'B-译文']);
        await expect(translateWithCache({origin: ['A', 'B']})).resolves.toEqual(['A-译文', 'B-译文']);

        let resolveBatch!: (value: string[]) => void;
        mocks.service.mockImplementationOnce(() => new Promise<string[]>(resolve => {
            resolveBatch = resolve;
        }));
        const first = translateWithCache({origin: ['P', 'Q']});
        const second = translateWithCache({origin: ['P', 'Q']});
        await flushMicrotasks();
        resolveBatch(['P-译文', 'Q-译文']);
        await expect(first).resolves.toEqual(['P-译文', 'Q-译文']);
        await expect(second).resolves.toEqual(['P-译文', 'Q-译文']);
    });

    it('DeepL Free 与 Pro 缓存隔离，固定代理以实际地址为缓存身份', async () => {
        mocks.machineServices.add('deepL');
        mocks.config.service = 'deepL';
        mocks.service.mockImplementation(async message => (
            `${getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(mocks.config)).deeplApiPlan} 译文`
        ));

        await expect(translateWithCache({origin: 'DeepL source'})).resolves.toBe('free 译文');
        mocks.config.deeplApiPlan = 'pro';
        await expect(translateWithCache({origin: 'DeepL source'})).resolves.toBe('pro 译文');
        mocks.config.deeplApiPlan = 'free';
        mocks.config.proxy.deepL = '  ';
        await expect(translateWithCache({origin: 'DeepL source'})).resolves.toBe('free 译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(translationCacheIdentities().map(identity => identity.endpoint)).toEqual([
            'https://api-free.deepl.com/v2/translate',
            'https://api.deepl.com/v2/translate',
            'https://api-free.deepl.com/v2/translate',
        ]);

        mocks.config.proxy.deepL = '  https://deepl-proxy.example/translate  ';
        await translateWithCache({origin: 'DeepL proxied source'});
        mocks.config.deeplApiPlan = 'pro';
        await translateWithCache({origin: 'DeepL proxied source'});
        expect(mocks.service).toHaveBeenCalledTimes(3);
        expect(translationCacheIdentities().slice(-2).map(identity => identity.endpoint)).toEqual([
            'https://deepl-proxy.example/translate', 'https://deepl-proxy.example/translate',
        ]);
    });

    it('缓存读取期间切换 DeepL 套餐不会修改在途请求或合并新旧套餐请求', async () => {
        mocks.machineServices.add('deepL');
        mocks.config.service = 'deepL';
        const cacheRead = deferred<string | null>();
        mocks.cacheGet.mockImplementationOnce(() => cacheRead.promise);
        mocks.service.mockImplementation(async message => (
            `${getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(mocks.config)).deeplApiPlan} 译文`
        ));
        const freeRequest = translateWithCache({origin: 'DeepL in flight'});
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledOnce());

        mocks.config.deeplApiPlan = 'pro';
        await expect(translateWithCache({origin: 'DeepL in flight'})).resolves.toBe('pro 译文');
        cacheRead.resolve(null);
        await expect(freeRequest).resolves.toBe('free 译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(translationCacheIdentities().map(identity => identity.endpoint)).toEqual([
            'https://api-free.deepl.com/v2/translate', 'https://api.deepl.com/v2/translate',
        ]);
    });

    it('builds provider cache identities for proxy, custom endpoints, Minimax, Mimo, and AI SDK services', async () => {
        mocks.config.proxy.mock = 'https://proxy.example';
        await translateWithCache({origin: 'Proxy'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({endpoint: 'https://proxy.example'});

        mocks.config.service = 'custom';
        mocks.config.custom = 'https://custom.example';
        await translateWithCache({origin: 'Custom'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'custom', endpoint: 'https://custom.example'});

        mocks.config.service = 'deeplx';
        mocks.config.deeplx = 'https://deeplx.example';
        await translateWithCache({origin: 'DeepLX'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'deeplx', endpoint: 'https://deeplx.example'});

        mocks.config.service = 'newapi';
        mocks.config.newApiUrl = 'https://newapi.example';
        await translateWithCache({origin: 'New API'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'newapi', endpoint: 'https://newapi.example'});

        mocks.config.service = 'minimax';
        mocks.config.minimaxBillingPlan = 'token-plan';
        mocks.config.minimaxRegion = 'global';
        await translateWithCache({origin: 'Minimax'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'minimax', endpoint: 'https://minimax.token.global'});

        mocks.config.minimaxBillingPlan = 'unknown';
        mocks.config.minimaxRegion = 'cn';
        await translateWithCache({origin: 'Minimax default'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'minimax', endpoint: 'https://minimax.payg.cn'});

        mocks.minimaxEndpoints.payg = {};
        installBroker();
        await translateWithCache({origin: 'Minimax missing endpoint'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'minimax', endpoint: ''});

        mocks.config.service = 'mimo';
        mocks.config.mimoBillingPlan = 'subscription';
        mocks.config.mimoRegion = 'global';
        await translateWithCache({origin: 'Mimo'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'mimo', endpoint: 'https://mimo.subscription.global.test'});

        mocks.config.service = 'aiSdk';
        await translateWithCache({origin: 'AI SDK'});
        expect(mocks.endpointResolver).toHaveBeenCalledWith('aiSdk', expect.any(Object));
        expect(translationCacheIdentities().at(-1)).toMatchObject({
            endpoint: 'https://aiSdk.endpoint.test',
            transportProfile: 'ai-sdk-profile',
        });

        mocks.config.service = 'brokenAiSdk';
        await translateWithCache({origin: 'Broken AI SDK'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({
            endpoint: '',
            transportProfile: 'ai-sdk-profile',
        });

        mocks.config.service = 'azureOpenai';
        mocks.config.azureOpenaiEndpoint = 'https://azure-openai.example';
        await translateWithCache({origin: 'Azure OpenAI'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({
            azureOpenaiEndpoint: 'https://azure-openai.example',
            service: 'azureOpenai',
        });

        mocks.config.service = 'mock';
        await translateWithCache({origin: 'Fallback service', serviceOverride: ''});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'mock'});

        mocks.machineServices.add('');
        mocks.config.model[''] = 'empty-service-model';
        mocks.config.service = '';
        await translateWithCache({origin: 'Empty configured service', serviceOverride: ''});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: ''});
    });

    it('动态 custom:* 服务复用 custom provider，并以动态 ID、端点和模型隔离缓存', async () => {
        mocks.aiServices.add('custom:1');
        mocks.aiSdkServices.add('custom:1');
        mocks.config.service = 'custom:1';
        mocks.config.model['custom:1'] = 'local-model';

        await expect(translateWithCache({origin: 'Dynamic custom'})).resolves.toBe('默认译文');

        expect(mocks.service).toHaveBeenCalledOnce();
        expect(translationCacheIdentities().at(-1)).toMatchObject({
            service: 'custom:1',
            model: 'local-model',
            endpoint: 'https://custom:1.endpoint.test',
            transportProfile: 'ai-sdk-profile',
        });
    });

    it('passes modelOverride through credential checks, cache identity, and provider calls', async () => {
        mocks.service.mockResolvedValue('覆盖模型译文');

        await expect(translateWithCache({
            origin: 'Model override',
            modelOverride: 'manual-model',
            serviceOverride: 'ai',
        })).resolves.toBe('覆盖模型译文');

        expect(mocks.getMissingCredentialMessage).toHaveBeenCalledWith('ai', expect.objectContaining({
            model: expect.objectContaining({ai: 'manual-model'}),
            customModel: expect.objectContaining({ai: 'manual-model'}),
        }));
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'ai', model: 'manual-model'});
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            modelOverride: 'manual-model',
            serviceOverride: 'ai',
        }));
    });

    it('reports credential, unsupported override, and missing adapter failures before provider calls', async () => {
        mocks.getMissingCredentialMessage.mockReturnValueOnce('缺少凭据');
        await expect(translateWithCache({origin: 'Credential'})).rejects.toThrow('缺少凭据');

        await expect(translateWithCache({
            origin: 'Unsupported',
            serviceOverride: 'unsupported',
        })).rejects.toThrow('独立翻译服务不可用');

        mocks.config.service = 'missing';
        await expect(translateWithCache({origin: 'Missing adapter'})).rejects.toThrow('未找到翻译服务适配器: missing');

        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('adds DeepL context and AI page context only when the target service consumes them', async () => {
        mocks.machineServices.add('deepL');
        mocks.config.service = 'deepL';
        mocks.config.model.deepL = 'deepl-model';
        await translateWithCache({origin: 'DeepL text', context: 'Title'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({service: 'deepL', context: 'Title'});

        mocks.config.service = 'mock';
        await translateWithCache({origin: 'Plain text', context: 'Title', pageContext: 'Article'});
        expect(translationCacheIdentities().at(-1)).toMatchObject({
            context: undefined,
            pageContext: undefined,
        });
    });

    it('does not summarize or forward page context to machine services and resumes it after an AI switch', async () => {
        mocks.config.enableAIContext = true;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            Promise.resolve(message.summaryPrompt ? 'AI summary' : `${message.origin}-译文`)
        ));

        await expect(translateWithCache({
            origin: 'Machine source',
            pageContext: 'Private machine context',
            useCache: false,
        })).resolves.toBe('Machine source-译文');

        expect(mocks.service).toHaveBeenCalledTimes(1);
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            origin: 'Machine source',
            pageContext: '',
        }));
        expect(mocks.service.mock.calls.some(([message]) => message.summaryPrompt)).toBe(false);
        expect(mocks.config.enableAIContext).toBe(true);

        mocks.config.service = 'ai';
        await expect(translateWithCache({
            origin: 'AI source',
            pageContext: 'AI article context',
            useCache: false,
        })).resolves.toBe('AI source-译文');

        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(1);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            summaryPrompt: 'summarize:AI article context',
        }));
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            origin: 'AI source',
            pageContext: 'Page summary (AI-generated reference):\nAI summary\n\nAI article context',
        }));
        expect(mocks.config.enableAIContext).toBe(true);
    });

    it('请求级 AI 上下文策略覆盖实时配置，并同时约束摘要与正文 provider', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            Promise.resolve(message.summaryPrompt ? '冻结摘要' : `${message.origin}-译文`)
        ));

        await expect(translateWithCache({
            origin: 'Frozen enabled',
            pageContext: 'Session context',
            enableAIContext: true,
            useCache: false,
        })).resolves.toBe('Frozen enabled-译文');
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            summaryPrompt: 'summarize:Session context',
        }));
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            origin: 'Frozen enabled',
            pageContext: expect.stringContaining('Session context'),
        }));

        mocks.service.mockClear();
        mocks.config.enableAIContext = true;
        await expect(translateWithCache({
            origin: 'Frozen disabled',
            pageContext: 'Must not leave broker',
            enableAIContext: false,
            useCache: false,
        })).resolves.toBe('Frozen disabled-译文');
        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: 'Frozen disabled',
            pageContext: '',
        }));
        expect(mocks.service.mock.calls.some(([message]) => message.summaryPrompt)).toBe(false);
    });

    it('在缓存写入前拦截 AI 上下文回显，并只做一次无上下文重译', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        let translationCalls = 0;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll 与 SoundSource 的音量控制冲突。');
            translationCalls += 1;
            if (translationCalls === 1) {
                return Promise.resolve('Ebullioscopic <webpage_context> 以下是不受信任的网页参考资料。页面摘要：Atoll 与 SoundSource 冲突。</webpage_context>');
            }
            return Promise.resolve('埃布利奥斯科皮克');
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const request = {
            origin: 'Ebullioscopic',
            context: 'Issue timeline',
            pageContext: 'Page title: Atoll issue. Readable page content (Markdown): SoundSource superkey conflicts with the macOS volume HUD.',
        };

        await expect(translateWithCache(request)).resolves.toBe('埃布利奥斯科皮克');
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[0]?.[0]).toMatchObject({pageContext: expect.stringContaining('Atoll')});
        expect(bodyCalls[1]?.[0]).toMatchObject({context: '', pageContext: ''});
        expect(mocks.cacheSet.mock.calls.some(([, value]) => String(value).includes('<webpage_context>'))).toBe(false);
        expect(warning).toHaveBeenCalledWith(
            '[FluentRead] AI page context leaked into translation; retrying once without page context:',
            expect.any(Error),
        );

        await flushMicrotasks();
        await expect(translateWithCache(request)).resolves.toBe('埃布利奥斯科皮克');
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        warning.mockRestore();
    });

    it('把旧缓存中的上下文回显视为 miss，并直接用无上下文结果覆盖', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Author <webpage_context> leaked cached article </webpage_context>');
        mocks.service.mockImplementation((message: {summaryPrompt?: string; pageContext?: string}) => (
            Promise.resolve(message.summaryPrompt ? '安全摘要' : message.pageContext ? '不应再次携带上下文' : '作者')
        ));

        await expect(translateWithCache({
            origin: 'Author',
            pageContext: 'Page title: Cached article. Readable page content (Markdown): private reference material.',
        })).resolves.toBe('作者');
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({context: '', pageContext: ''}));
        await flushMicrotasks();
        expect(mocks.cacheSet.mock.calls.some(([, value]) => value === '作者')).toBe(true);
    });

    it('无上下文重译仍回显网页材料时停止展示且不写缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt
                ? '网页摘要'
                : 'Author <webpage_context> 仍然泄漏的网页材料 </webpage_context>')
        ));

        await expect(translateWithCache({
            origin: 'Author',
            pageContext: 'Page title: Context that must never be displayed.',
            useCache: false,
        })).rejects.toMatchObject({
            kind: 'response',
            retryable: false,
            code: 'AI_CONTEXT_LEAK_AFTER_RECOVERY',
        });
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({context: '', pageContext: ''}));
        expect(mocks.cacheSet).not.toHaveBeenCalled();
        warning.mockRestore();
    });

    it('无上下文重译后接受仅与页面术语重合的合法长译名', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => Promise.resolve(
            message.summaryPrompt
                ? '人工智能驱动的网页阅读辅助工具。'
                : '人工智能驱动的网页阅读辅助工具',
        ));

        await expect(translateWithCache({
            origin: 'AI',
            pageContext: '页面摘要：人工智能驱动的网页阅读辅助工具，可帮助用户理解网页。',
        })).resolves.toBe('人工智能驱动的网页阅读辅助工具');
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[1]?.[0]).toMatchObject({context: '', pageContext: ''});
        await flushMicrotasks();
        await expect(translateWithCache({
            origin: 'AI',
            pageContext: '页面摘要：人工智能驱动的网页阅读辅助工具，可帮助用户理解网页。',
        })).resolves.toBe('人工智能驱动的网页阅读辅助工具');
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        warning.mockRestore();
    });

    it('未膨胀的长上下文片段只触发一次无上下文重译并稳定复用复验缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const origin = 'The author describes the effects of winter weather on regional transport, including railway maintenance and the preparation of temporary services for small towns.';
        const reference = 'The article compares coastal restoration methods and explains why native wetlands can reduce storm damage for nearby communities.';
        const pageContext = `Page title: Coastal research. ${reference} The appendix contains details of the monitoring schedule.`;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => Promise.resolve(
            message.summaryPrompt ? 'A brief article summary.' : reference,
        ));

        expect(reference.length).toBeLessThan(origin.length);
        await expect(translateWithCache({origin, pageContext})).resolves.toBe(reference);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[1]?.[0]).toMatchObject({origin, context: '', pageContext: ''});
        await flushMicrotasks();
        await expect(translateWithCache({origin, pageContext})).resolves.toBe(reference);
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        warning.mockRestore();
    });

    it('AI 多段中已经无上下文复验的软重合译文可以稳定命中缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('人工智能驱动的网页阅读辅助工具。');
            if (!message.pageContext && !message.origin.includes('___FLUENTREAD_')) {
                return Promise.resolve('人工智能驱动的网页阅读辅助工具');
            }
            return Promise.resolve(message.origin
                .replace('AI', '人工智能驱动的网页阅读辅助工具')
                .replace('Reader', '阅读器'));
        });
        const request = {
            origin: ['AI', 'Reader'],
            pageContext: '页面摘要：人工智能驱动的网页阅读辅助工具，可帮助用户理解网页。',
            aiMultiSegment: true,
        };

        await expect(translateWithCache(request)).resolves.toEqual([
            '人工智能驱动的网页阅读辅助工具',
            '阅读器',
        ]);
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        await flushMicrotasks();
        await expect(translateWithCache(request)).resolves.toEqual([
            '人工智能驱动的网页阅读辅助工具',
            '阅读器',
        ]);
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        warning.mockRestore();
    });

    it('AI 多段模式只发一次字符串 provider 请求，并严格校验标记后逐段缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        mocks.service.mockImplementation((message: {origin: string | string[]}) => {
            expect(typeof message.origin).toBe('string');
            return Promise.resolve((message.origin as string)
                .replace('First paragraph', '第一段')
                .replace('Second paragraph', '第二段'));
        });

        await expect(translateWithCache({
            origin: ['First paragraph', 'Second paragraph'],
            aiMultiSegment: true,
        })).resolves.toEqual(['第一段', '第二段']);
        expect(mocks.service).toHaveBeenCalledTimes(1);
        expect(mocks.service.mock.calls[0]?.[0].origin).toEqual(expect.stringContaining('___FLUENTREAD_'));
        await flushMicrotasks();
        const identities = translationCacheIdentities();
        expect(identities.some((identity) => identity.requestMode === 'ai-multi-segment')).toBe(true);
        const itemIdentities = identities.filter((identity) => Array.isArray(identity.sourceText)
            && String(identity.sourceText[0]).startsWith('slot:'));
        expect(itemIdentities.map((identity) => identity.sourceText[1])).toEqual(expect.arrayContaining([
            'First paragraph',
            'Second paragraph',
        ]));
        expect(itemIdentities.every((identity) => identity.requestMode === 'ai-multi-segment')).toBe(true);
        expect(mocks.cacheSet.mock.calls.map(([, value]) => value)).toEqual(expect.arrayContaining(['第一段', '第二段']));

        mocks.service.mockClear();
        await expect(translateWithCache({
            origin: ['First paragraph', 'Second paragraph'],
            aiMultiSegment: true,
        })).resolves.toEqual(['第一段', '第二段']);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('AI 多段缓存包含完整批次与槽位指纹，不跨邻段组合或重复槽位误用', async () => {
        mocks.config.service = 'ai';
        mocks.service.mockImplementation((message: {origin: string}) => {
            let leadIndex = 0;
            return Promise.resolve(message.origin
                .replaceAll('bank', message.origin.includes('river clue') ? '河岸' : '银行')
                .replaceAll('river clue', '河流语境')
                .replaceAll('loan clue', '贷款语境')
                .replaceAll('Lead', () => (++leadIndex === 1 ? '铅' : '领先')));
        });

        await expect(translateWithCache({
            origin: ['bank', 'river clue'],
            aiMultiSegment: true,
        })).resolves.toEqual(['河岸', '河流语境']);
        await flushMicrotasks();
        await expect(translateWithCache({
            origin: ['bank', 'loan clue'],
            aiMultiSegment: true,
        })).resolves.toEqual(['银行', '贷款语境']);

        await expect(translateWithCache({
            origin: ['Lead', 'river clue', 'Lead'],
            aiMultiSegment: true,
        })).resolves.toEqual(['铅', '河流语境', '领先']);
        await flushMicrotasks();
        mocks.service.mockClear();
        await expect(translateWithCache({
            origin: ['Lead', 'river clue', 'Lead'],
            aiMultiSegment: true,
        })).resolves.toEqual(['铅', '河流语境', '领先']);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('旧坏缓存与普通 miss 同批时保留完整邻段上下文，只对泄漏段无上下文重译', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce(null);
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            if (!message.pageContext) return Promise.resolve('安全的甲');
            return Promise.resolve(message.origin
                .replace('Alpha', 'Atoll SoundSource StudioDisplay context material that belongs only to the webpage and must not be shown')
                .replace('Beta', '带上下文的乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: Atoll. Readable page content (Markdown): SoundSource StudioDisplay reference.',
            aiMultiSegment: true,
        })).resolves.toEqual(['安全的甲', '带上下文的乙']);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[0]?.[0]).toMatchObject({
            origin: expect.stringContaining('Alpha'),
            pageContext: expect.stringContaining('Atoll'),
        });
        expect(bodyCalls[0]?.[0].origin).toContain('Beta');
        expect(bodyCalls[1]?.[0]).toMatchObject({origin: 'Alpha', context: '', pageContext: ''});
    });

    it('普通 AI 数组请求也只对上下文泄漏项执行一次无上下文重译', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.service.mockImplementation((message: {
            summaryPrompt?: string;
            origin: string | string[];
            pageContext?: string;
        }) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            if (typeof message.origin === 'string') return Promise.resolve('安全的甲');
            return Promise.resolve([
                'Alpha <webpage_context> Atoll SoundSource StudioDisplay </webpage_context>',
                '安全的乙',
            ]);
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: Atoll. SoundSource StudioDisplay reference.',
            useCache: false,
        })).resolves.toEqual(['安全的甲', '安全的乙']);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[0]?.[0]).toMatchObject({origin: ['Alpha', 'Beta'], pageContext: expect.stringContaining('Atoll')});
        expect(bodyCalls[1]?.[0]).toMatchObject({origin: 'Alpha', context: '', pageContext: ''});
    });

    it('普通 AI 批量的旧坏缓存只用无上下文 provider 请求修复', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce('已缓存的乙');
        mocks.service.mockImplementation((message: {
            summaryPrompt?: string;
            origin: string | string[];
            pageContext?: string;
        }) => {
            if (message.summaryPrompt) return Promise.resolve('安全摘要');
            return Promise.resolve(Array.isArray(message.origin) ? ['安全的甲'] : '不应走单条');
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: cached article.',
        })).resolves.toEqual(['安全的甲', '已缓存的乙']);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(1);
        expect(bodyCalls[0]?.[0]).toMatchObject({origin: ['Alpha'], context: '', pageContext: ''});
    });

    it('AI 多段单元素请求复用单条恢复，并兼容运行时缺失的槽位值', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        mocks.service.mockImplementation((message: {origin: string | string[]}) => {
            expect(Array.isArray(message.origin)).toBe(false);
            expect(message.origin).toBe('');
            return Promise.resolve('空槽译文');
        });

        await expect(translateWithCache({
            origin: [undefined] as unknown as string[],
            aiMultiSegment: true,
            useCache: false,
        })).resolves.toEqual(['空槽译文']);
        expect(mocks.service).toHaveBeenCalledTimes(1);
    });

    it('AI 多段单元素的旧泄漏缓存直接走无上下文单条恢复', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>');
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => (
            Promise.resolve(message.summaryPrompt ? 'Atoll 页面摘要' : '安全的甲')
        ));

        await expect(translateWithCache({
            origin: ['Alpha'],
            context: '邻段标题',
            pageContext: 'Page title: Atoll article.',
            aiMultiSegment: true,
        })).resolves.toEqual(['安全的甲']);
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            origin: 'Alpha',
            context: '',
            pageContext: '',
        }));
    });

    it('AI 多段协议完整且只有一个槽回显明确上下文标记时保留其余译文', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('页面主题摘要');
            if (!message.pageContext) return Promise.resolve('安全的甲');
            return Promise.resolve(message.origin
                .replace('Alpha', '甲 <webpage_context>错误引用的页面内容</webpage_context>')
                .replace('Beta', '已正确翻译的乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: example article.',
            aiMultiSegment: true,
        })).resolves.toEqual(['安全的甲', '已正确翻译的乙']);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[1]?.[0]).toMatchObject({origin: 'Alpha', context: '', pageContext: ''});
        await flushMicrotasks();
        expect(mocks.cacheSet.mock.calls.map(([, value]) => value)).toEqual(expect.arrayContaining([
            '安全的甲', '已正确翻译的乙',
        ]));
        expect(mocks.cacheSet.mock.calls.some(([, value]) => String(value).includes('<webpage_context>'))).toBe(false);
    });

    it('完整多段协议内的泄漏槽无上下文恢复后仍明确泄漏时拒绝整批缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('页面主题摘要');
            if (!message.pageContext) return Promise.resolve('甲 <webpage_context>恢复后仍泄漏</webpage_context>');
            return Promise.resolve(message.origin
                .replace('Alpha', '甲 <webpage_context>错误引用的页面内容</webpage_context>')
                .replace('Beta', '已正确翻译的乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: example article.',
            aiMultiSegment: true,
        })).rejects.toMatchObject({code: 'AI_CONTEXT_LEAK_AFTER_RECOVERY'});
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({origin: 'Alpha', pageContext: ''}));
        const cachedValues = mocks.cacheSet.mock.calls.map(([, value]) => value);
        expect(cachedValues).not.toContain('已正确翻译的乙');
        expect(cachedValues.some((value) => String(value).includes('<webpage_context>'))).toBe(false);
    });

    it('AI 多段整包泄漏时只重试一次无上下文请求并解析安全结果', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string; pageContext?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            if (message.pageContext) {
                return Promise.resolve(`${message.origin}\n<webpage_context>Atoll private material</webpage_context>`);
            }
            return Promise.resolve(message.origin.replace('Alpha', '甲').replace('Beta', '乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: Atoll. SoundSource StudioDisplay reference.',
            aiMultiSegment: true,
            useCache: false,
        })).resolves.toEqual(['甲', '乙']);
        const bodyCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(bodyCalls).toHaveLength(2);
        expect(bodyCalls[1]?.[0]).toMatchObject({context: '', pageContext: ''});
        expect(warning).toHaveBeenCalledWith(
            '[FluentRead] AI page context leaked into multi-segment translation; retrying once without page context:',
            expect.any(Error),
        );
        warning.mockRestore();
    });

    it('AI 多段整包无上下文重试仍明确泄漏时拒绝结果', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return Promise.resolve('安全摘要');
            return Promise.resolve(`${message.origin}\n<webpage_context>仍然泄漏</webpage_context>`);
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: private article.',
            aiMultiSegment: true,
            useCache: false,
        })).rejects.toMatchObject({
            kind: 'response',
            retryable: false,
            code: 'AI_CONTEXT_LEAK_AFTER_RECOVERY',
        });
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(2);
        warning.mockRestore();
    });

    it('AI 多段 provider 原样回显完整协议包时立即拒绝', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        mocks.service.mockImplementation((message: {origin: string}) => Promise.resolve(message.origin));

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            aiMultiSegment: true,
            useCache: false,
        })).rejects.toMatchObject({
            kind: 'response',
            retryable: false,
            code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID',
        });
    });

    it('AI 多段协议允许空原文保留空槽并翻译其余段落', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        mocks.service.mockImplementation((message: {origin: string}) => Promise.resolve(
            message.origin.replace('Beta', '乙'),
        ));

        await expect(translateWithCache({
            origin: ['', 'Beta'],
            aiMultiSegment: true,
            useCache: false,
        })).resolves.toEqual(['', '乙']);
    });

    it('AI 多段从旧泄漏缓存无上下文启动时只拒绝确定泄漏', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const softLeak = 'Atoll SoundSource StudioDisplay context material remains visible in a long but non-verbatim response for validation';
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce('Beta <webpage_context> leaked cache </webpage_context>');
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            return Promise.resolve(message.origin.replace('Alpha', softLeak).replace('Beta', '安全的乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: Atoll. Readable page content: SoundSource StudioDisplay reference.',
            aiMultiSegment: true,
        })).resolves.toEqual([softLeak, '安全的乙']);

        installBroker();
        mocks.cacheGet.mockClear();
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce('Beta <webpage_context> leaked cache </webpage_context>');
        mocks.service.mockClear();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return Promise.resolve('安全摘要');
            return Promise.resolve(message.origin
                .replace('Alpha', '甲 <webpage_context>仍然泄漏</webpage_context>')
                .replace('Beta', '安全的乙'));
        });

        await expect(translateWithCache({
            origin: ['Alpha', 'Beta'],
            pageContext: 'Page title: private article.',
            aiMultiSegment: true,
        })).rejects.toMatchObject({code: 'AI_CONTEXT_LEAK_AFTER_RECOVERY'});
    });

    it('普通 AI 批量从旧泄漏缓存无上下文启动时区分软重合与确定泄漏', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const softLeak = 'Atoll SoundSource StudioDisplay context material remains visible in a long but non-verbatim response for validation';
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>');
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt ? 'Atoll SoundSource StudioDisplay summary' : [softLeak])
        ));

        await expect(translateWithCache({
            origin: ['Alpha'],
            pageContext: 'Page title: Atoll. Readable page content: SoundSource StudioDisplay reference.',
        })).resolves.toEqual([softLeak]);

        installBroker();
        mocks.cacheGet.mockClear();
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>');
        mocks.service.mockClear();
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt
                ? '安全摘要'
                : ['Alpha <webpage_context>仍然泄漏</webpage_context>'])
        ));

        await expect(translateWithCache({
            origin: ['Alpha'],
            pageContext: 'Page title: private article.',
        })).rejects.toMatchObject({code: 'AI_CONTEXT_LEAK_AFTER_RECOVERY'});
    });

    it('空白单条缓存重新走常规上下文恢复', async () => {
        mocks.cacheGet.mockResolvedValueOnce('   ');
        mocks.service.mockResolvedValueOnce('新译文');

        await expect(translateWithCache({origin: 'Stale source'})).resolves.toBe('新译文');
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({origin: 'Stale source'}));
        await flushMicrotasks();
        expect(mocks.cacheSet).toHaveBeenCalledWith(expect.any(String), '新译文');
    });

    it('批量缓存校验对运行时缺失的原文槽使用空串身份', async () => {
        mocks.cacheGet.mockResolvedValueOnce('无源缓存译文');

        await expect(translateWithCache({
            origin: [undefined] as unknown as string[],
        })).resolves.toEqual(['无源缓存译文']);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('AI 多段对校验后变为缺项的槽位继续使用空串防御值', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = false;
        const origins = ['Alpha', 'Beta', 'Gamma'];
        const originalSome = Array.prototype.some;
        const originalFilter = Array.prototype.filter;
        let parsedAdjusted = false;
        let originsAdjusted = false;
        const someSpy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
            this: unknown[],
            callback: (value: unknown, index: number, array: unknown[]) => unknown,
            thisArg?: unknown,
        ): boolean {
            const result = Reflect.apply(originalSome, this, [callback, thisArg]) as boolean;
            if (!parsedAdjusted && this.length === 3
                && this[0] === 'Alpha' && this[1] === '乙' && this[2] === '丙') {
                this[1] = undefined;
                parsedAdjusted = true;
            }
            return result;
        });
        const filterSpy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
            this: unknown[],
            callback: (value: unknown, index: number, array: unknown[]) => unknown,
            thisArg?: unknown,
        ): unknown[] {
            const result = Reflect.apply(originalFilter, this, [callback, thisArg]) as unknown[];
            if (parsedAdjusted && !originsAdjusted
                && this.length === 3 && this[0] === 0 && this[1] === 1 && this[2] === 2) {
                origins[1] = undefined as unknown as string;
                origins[2] = undefined as unknown as string;
                originsAdjusted = true;
            }
            return result;
        });
        mocks.service.mockImplementation((message: {origin: string}) => Promise.resolve(
            message.origin.replace('Beta', '乙').replace('Gamma', '丙'),
        ));

        try {
            await expect(translateWithCache({
                origin: origins,
                aiMultiSegment: true,
            })).resolves.toEqual(['Alpha', undefined, '丙']);
            expect(parsedAdjusted).toBe(true);
            expect(originsAdjusted).toBe(true);
        } finally {
            someSpy.mockRestore();
            filterSpy.mockRestore();
        }
    });

    it('AI 多段无上下文恢复对二次读取时缺失的译文槽采用空串', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const softLeak = 'Atoll SoundSource StudioDisplay context material remains visible in a long but non-verbatim response for validation';
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce('Beta <webpage_context> leaked cache </webpage_context>');
        const originalSome = Array.prototype.some;
        let adjusted = false;
        const someSpy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
            this: unknown[],
            callback: (value: unknown, index: number, array: unknown[]) => unknown,
            thisArg?: unknown,
        ): boolean {
            const result = Reflect.apply(originalSome, this, [callback, thisArg]) as boolean;
            if (!adjusted && this.length === 2 && this[0] === softLeak && this[1] === '安全的乙') {
                let reads = 0;
                Object.defineProperty(this, 0, {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                        reads += 1;
                        return reads <= 2 ? softLeak : undefined;
                    },
                });
                adjusted = true;
            }
            return result;
        });
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            return Promise.resolve(message.origin.replace('Alpha', softLeak).replace('Beta', '安全的乙'));
        });

        try {
            await expect(translateWithCache({
                origin: ['Alpha', 'Beta'],
                pageContext: 'Page title: Atoll. Readable page content: SoundSource StudioDisplay reference.',
                aiMultiSegment: true,
            })).resolves.toEqual(['', '安全的乙']);
            expect(adjusted).toBe(true);
        } finally {
            someSpy.mockRestore();
        }
    });

    it('普通 AI 批量对校验后缺失的原文与译文槽采用空串恢复', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const softLeak = 'Atoll SoundSource StudioDisplay context material remains visible in a long but non-verbatim response for validation';
        mocks.cacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('Alpha <webpage_context> leaked cache </webpage_context>')
            .mockResolvedValueOnce('Beta <webpage_context> leaked cache </webpage_context>');
        const originalSome = Array.prototype.some;
        let providerOrigins: Array<string | undefined> | undefined;
        let adjusted = false;
        const someSpy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
            this: unknown[],
            callback: (value: unknown, index: number, array: unknown[]) => unknown,
            thisArg?: unknown,
        ): boolean {
            const result = Reflect.apply(originalSome, this, [callback, thisArg]) as boolean;
            if (!adjusted && this.length === 2 && this[0] === softLeak && this[1] === '安全的乙') {
                if (providerOrigins) providerOrigins[0] = undefined;
                let reads = 0;
                Object.defineProperty(this, 0, {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                        reads += 1;
                        return reads === 1 ? softLeak : undefined;
                    },
                });
                Object.defineProperty(this, 1, {
                    configurable: true,
                    enumerable: true,
                    get: () => undefined,
                });
                adjusted = true;
            }
            return result;
        });
        mocks.service.mockImplementation((message: {
            summaryPrompt?: string;
            origin: string | Array<string | undefined>;
        }) => {
            if (message.summaryPrompt) return Promise.resolve('Atoll SoundSource StudioDisplay summary');
            providerOrigins = message.origin as Array<string | undefined>;
            return Promise.resolve([softLeak, '安全的乙']);
        });

        try {
            await expect(translateWithCache({
                origin: ['Alpha', 'Beta'],
                pageContext: 'Page title: Atoll. Readable page content: SoundSource StudioDisplay reference.',
            })).resolves.toEqual(['', '']);
            expect(adjusted).toBe(true);
        } finally {
            someSpy.mockRestore();
        }
    });

    it('AI 多段协议缺失标记时返回不可重试的响应错误，且不写入坏缓存', async () => {
        mocks.config.service = 'ai';
        mocks.service.mockResolvedValue('缺少全部段落标记的普通文本');

        await expect(translateWithCache({
            origin: ['First paragraph', 'Second paragraph'],
            aiMultiSegment: true,
            useCache: false,
        })).rejects.toMatchObject({kind: 'response', retryable: false});
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('AI 多段仅用 Unicode 或空白包装原文时视为协议回显', async () => {
        mocks.config.service = 'ai';
        mocks.service.mockImplementation((message: {origin: string}) => Promise.resolve(
            message.origin
                .replace(/_BEGIN___/gu, '_BEGIN___  ')
                .replace(/___FLUENTREAD_/gu, '\u00a0___FLUENTREAD_'),
        ));

        await expect(translateWithCache({
            origin: ['First paragraph', 'Second paragraph'],
            aiMultiSegment: true,
            useCache: false,
        })).rejects.toMatchObject({
            kind: 'response',
            retryable: false,
            code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID',
        });
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('uses persisted, shared, empty, failed, and evicted AI summaries without blocking translation', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;

        const persistedSummaryKey = cacheKey({
            requestMode: 'page-summary',
            sourceLanguage: 'auto',
            targetLanguage: '',
            sourceText: 'Persisted context',
            service: 'ai',
            model: 'ai-model',
            modelThinking: false,
            endpoint: '',
            customBody: '',
        });
        mocks.cacheStore.set(persistedSummaryKey, 'Persisted summary');
        await translateWithCache({origin: 'Persisted', pageContext: 'Persisted context'});
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            pageContext: 'Persisted summary',
        }));
        expect(mocks.service.mock.calls.some(([message]) => message.summaryPrompt === 'summarize:Persisted context')).toBe(false);

        mocks.service.mockReset();
        let resolveSummary!: (value: string) => void;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string | string[]}) => {
            if (message.summaryPrompt) {
                return new Promise<string>(resolve => {
                    resolveSummary = resolve;
                });
            }
            return Promise.resolve(`${message.origin}-译文`);
        });
        const first = translateWithCache({origin: 'A', pageContext: 'Concurrent context'});
        const second = translateWithCache({origin: 'B', pageContext: 'Concurrent context'});
        await flushMicrotasks();
        resolveSummary('Concurrent summary');
        await expect(first).resolves.toBe('A-译文');
        await expect(second).resolves.toBe('B-译文');
        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(1);
        await expect(translateWithCache({origin: 'C', pageContext: 'Concurrent context'})).resolves.toBe('C-译文');
        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(1);

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            Promise.resolve(message.summaryPrompt ? '' : `${message.origin}-译文`)
        ));
        await expect(translateWithCache({origin: 'Empty summary', pageContext: 'Empty context'})).resolves.toBe('Empty summary-译文');
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({pageContext: 'Empty context'}));

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            Promise.resolve(message.summaryPrompt ? {notText: true} : `${message.origin}-译文`)
        ));
        await expect(translateWithCache({origin: 'Object summary', pageContext: 'Object context'})).resolves.toBe('Object summary-译文');
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({pageContext: 'Object context'}));

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return Promise.reject(new Error('summary failed'));
            return Promise.resolve(`${message.origin}-译文`);
        });
        const summaryWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(translateWithCache({origin: 'Failed summary', pageContext: 'Failed context'})).resolves.toBe('Failed summary-译文');
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({pageContext: 'Failed context'}));
        expect(summaryWarn).toHaveBeenCalledWith(
            '[FluentRead] page context summary failed; using extracted context:',
            expect.any(Error),
        );
        summaryWarn.mockRestore();

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            Promise.resolve(message.summaryPrompt ? `Summary ${message.summaryPrompt}` : `${message.origin}-译文`)
        ));
        for (let index = 0; index < 9; index += 1) {
            await translateWithCache({origin: `Evict ${index}`, pageContext: `Evict context ${index}`});
        }
        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(9);

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => (
            message.summaryPrompt
                ? Promise.reject(new Error('summary failed'))
                : Promise.resolve(`${message.origin}-译文`)
        ));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
            throw new Error('warn failed');
        });
        await expect(translateWithCache({origin: 'Reject summary', pageContext: 'Reject context'}))
            .resolves.toBe('Reject summary-译文');
        warn.mockRestore();
    });

    it('摘要耗时不同的相同入口预算请求仍共享正文 pending', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const timestamps = [0, 1_000, 1_000, 1_000];
        installBroker(() => timestamps.shift() ?? 1_000);
        const bodyProvider = deferred<string>();
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => {
            if (message.summaryPrompt) return Promise.resolve('共享摘要');
            return bodyProvider.promise;
        });

        // 步骤 1：首个请求用 1 秒生成摘要，正文只剩 3 秒。
        const summarizedFirst = translateWithCache({
            origin: 'Same deadline',
            pageContext: 'Same article',
            requestTimeoutMs: 4_000,
        });
        await flushMicrotasks(100);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: 'Same deadline',
            requestTimeoutMs: 3_000,
        }));

        // 步骤 2：后发请求直接命中摘要，正文虽仍有 4 秒，但入口预算相同，必须复用现有工作。
        const cachedSummarySecond = translateWithCache({
            origin: 'Same deadline',
            pageContext: 'Same article',
            requestTimeoutMs: 4_000,
        });
        await flushMicrotasks(100);
        const translationCalls = mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt);
        expect(translationCalls.map(([message]) => message.requestTimeoutMs)).toEqual([3_000]);

        bodyProvider.resolve('共享正文译文');
        await expect(Promise.all([summarizedFirst, cachedSummarySecond]))
            .resolves.toEqual(['共享正文译文', '共享正文译文']);
    });

    it('持久摘要读取耗时计入绝对总预算，4 秒请求只给正文剩余 500 毫秒', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.cacheGet
            .mockImplementationOnce(() => new Promise<string>(resolve => {
                setTimeout(() => resolve('持久摘要上下文'), 3_500);
            }))
            .mockResolvedValue(null);
        let bodySignal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal; summaryPrompt?: string}) => {
            if (message.summaryPrompt) throw new Error('命中持久摘要后不应生成新摘要');
            bodySignal = message.abortSignal;
            return new Promise<string>(() => undefined);
        });

        const request = translateWithCache({
            origin: 'Exact total budget',
            pageContext: 'Cached article context',
            requestTimeoutMs: 4_000,
        });
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(3_500);
        await flushMicrotasks(20);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: 'Exact total budget',
            requestTimeoutMs: 500,
        }));
        expect(bodySignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(499);
        expect(bodySignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(bodySignal?.aborted).toBe(true);
    });

    it('正文缓存读取耗时会从单条 provider deadline 中精确扣除', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.cacheGet.mockImplementationOnce(() => new Promise<null>(resolve => {
            setTimeout(() => resolve(null), 3_500);
        }));
        let signal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string>(() => undefined);
        });

        const request = translateWithCache({origin: 'Slow single cache', requestTimeoutMs: 4_000});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(3_500);
        await flushMicrotasks(20);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: 'Slow single cache',
            requestTimeoutMs: 500,
        }));
        await vi.advanceTimersByTimeAsync(500);
        await rejection;
        expect(signal?.aborted).toBe(true);
    });

    it('分项缓存读取耗时会从批量 provider deadline 中精确扣除', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.cacheGet.mockImplementation(() => new Promise<null>(resolve => {
            setTimeout(() => resolve(null), 3_500);
        }));
        let signal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string[]>(() => undefined);
        });

        const request = translateWithCache({origin: ['A', 'B'], requestTimeoutMs: 4_000});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(3_500);
        await flushMicrotasks(20);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            origin: ['A', 'B'],
            requestTimeoutMs: 500,
        }));
        await vi.advanceTimersByTimeAsync(500);
        await rejection;
        expect(signal?.aborted).toBe(true);
    });

    it('批量缓存读取超过绝对 deadline 后立即失败，且迟到结果不再启动 provider', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.cacheGet.mockImplementation(() => new Promise<null>(resolve => {
            setTimeout(() => resolve(null), 5_000);
        }));

        const request = translateWithCache({origin: ['A', 'B'], requestTimeoutMs: 4_000});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(4_000);
        await rejection;
        expect(mocks.service).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks(20);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('上层事务标记的 500 毫秒剩余预算不会被公开入口下限抬高', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let signal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string>(() => undefined);
        });

        const request = translateWithCache(markTranslationRemainingBudget({
            origin: 'Internal remaining budget',
            requestTimeoutMs: 500,
            useCache: false,
        }));
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await flushMicrotasks(20);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({requestTimeoutMs: 500}));
        await vi.advanceTimersByTimeAsync(499);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(signal?.aborted).toBe(true);
    });

    it('内部 500 毫秒剩余预算覆盖悬挂 configReady，超时后不启动 provider', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const ready = deferred<void>();
        installBroker(undefined, ready.promise);

        const request = translateWithCache(markTranslationRemainingBudget({
            origin: 'Never ready',
            requestTimeoutMs: 500,
            useCache: false,
        }));
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(500);
        await rejection;
        expect(mocks.service).not.toHaveBeenCalled();

        ready.resolve();
        await flushMicrotasks(20);
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('公开 500 毫秒预算仍归一为一秒，并从入口扣除 configReady 的 600 毫秒', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const ready = deferred<void>();
        installBroker(undefined, ready.promise);
        let signal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal}) => {
            signal = message.abortSignal;
            return new Promise<string>(() => undefined);
        });

        const request = translateWithCache({
            origin: 'Delayed ready',
            requestTimeoutMs: 500,
            useCache: false,
        });
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(599);
        expect(mocks.service).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        ready.resolve();
        await flushMicrotasks(20);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({requestTimeoutMs: 400}));

        await vi.advanceTimersByTimeAsync(399);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(signal?.aborted).toBe(true);
    });

    it('无显式预算时 configReady 悬挂也在入口 45 秒绝对 deadline 失败', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const ready = deferred<void>();
        installBroker(undefined, ready.promise);

        const request = translateWithCache({origin: 'Default ready deadline'});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(44_999);
        expect(mocks.service).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('无显式预算时正文缓存悬挂也在入口 45 秒绝对 deadline 失败', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mocks.cacheGet.mockImplementation(() => new Promise<null>(() => undefined));

        const request = translateWithCache({origin: 'Default cache deadline'});
        const rejection = expect(request).rejects.toThrow('翻译请求超时');
        await vi.advanceTimersByTimeAsync(45_000);
        await rejection;
        expect(mocks.service).not.toHaveBeenCalled();
    });

    it('摘要缓存写入在消息响应前形成 barrier，完成后才继续正文 provider', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        const summaryWrite = deferred<boolean>();
        mocks.cacheSet
            .mockImplementationOnce(() => summaryWrite.promise)
            .mockResolvedValue(true);
        mocks.service.mockImplementation((message: {origin: string; summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt ? '页面摘要' : `${message.origin}-译文`)
        ));

        let settled = false;
        const request = translateWithCache({origin: 'Body', pageContext: 'Article'});
        void request.finally(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledOnce());
        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(1);
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(0);
        expect(settled).toBe(false);

        summaryWrite.resolve(true);
        await expect(request).resolves.toBe('Body-译文');
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(1);
    });

    it('单条缓存写悬挂时消息保持未完成，写入完成后释放 pending', async () => {
        const write = deferred<boolean>();
        mocks.cacheSet.mockImplementationOnce(async (key: string, value: string) => {
            await write.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service.mockResolvedValueOnce('首个译文');

        let settled = false;
        const request = translateWithCache({origin: 'Deferred single'});
        void request.finally(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(mocks.service).toHaveBeenCalledOnce();

        write.resolve(true);
        await expect(request).resolves.toBe('首个译文');
        await expect(translateWithCache({origin: 'Deferred single'})).resolves.toBe('首个译文');
        expect(mocks.service).toHaveBeenCalledOnce();
    });

    it('单条缓存写超过宽限期后复用待写值，clear 仍等待旧写并使其失效', async () => {
        vi.useFakeTimers();
        installBroker(undefined, Promise.resolve(), true, 25);
        const lateWrite = deferred<boolean>();
        mocks.cacheSet
            .mockImplementationOnce(async (key: string, value: string) => {
                await lateWrite.promise;
                mocks.cacheStore.set(key, value);
                return true;
            })
            .mockResolvedValueOnce(true);
        mocks.service
            .mockResolvedValueOnce('宽限期首译')
            .mockResolvedValueOnce('清理后重译');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        let settled = false;
        const request = translateWithCache({origin: 'Hung cache persistence'});
        void request.finally(() => { settled = true; });
        await flushMicrotasks(100);
        expect(mocks.cacheSet).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(request).resolves.toBe('宽限期首译');
        expect(warn).toHaveBeenCalledWith(
            '[FluentRead] translation cache write timed out:',
            expect.any(Error),
        );

        await flushMicrotasks();
        mocks.cacheGet.mockClear();
        await expect(translateWithCache({origin: 'Hung cache persistence'})).resolves.toBe('宽限期首译');
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.service).toHaveBeenCalledOnce();

        const clearing = clearTranslationCache();
        await flushMicrotasks();
        expect(mocks.cacheClear).not.toHaveBeenCalled();
        lateWrite.resolve(true);
        await clearing;
        expect(mocks.cacheClear).toHaveBeenCalledOnce();
        expect(mocks.cacheStore.size).toBe(0);

        await expect(translateWithCache({origin: 'Hung cache persistence'})).resolves.toBe('清理后重译');
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it('批量缓存写超过宽限期后按 item key 复用待写值', async () => {
        vi.useFakeTimers();
        installBroker(undefined, Promise.resolve(), true, 25);
        const lateWrites = deferred<boolean>();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.cacheSet.mockImplementation(async (key: string, value: string) => {
            await lateWrites.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service.mockResolvedValueOnce(['待写 A', '待写 B']);

        const first = translateWithCache({origin: ['Pending batch A', 'Pending batch B']});
        await flushMicrotasks(100);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(25);
        await expect(first).resolves.toEqual(['待写 A', '待写 B']);

        // 反转整批身份，确保本次不是 pendingBatches 的整批 Promise 复用，而是逐项命中待写值。
        await flushMicrotasks();
        mocks.cacheGet.mockClear();
        await expect(translateWithCache({origin: ['Pending batch B', 'Pending batch A']}))
            .resolves.toEqual(['待写 B', '待写 A']);
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.service).toHaveBeenCalledOnce();

        const clearing = clearTranslationCache();
        await flushMicrotasks();
        expect(mocks.cacheClear).not.toHaveBeenCalled();
        lateWrites.resolve(true);
        await clearing;
        expect(mocks.cacheClear).toHaveBeenCalledOnce();
        expect(mocks.cacheStore.size).toBe(0);
    });

    it('迟到缓存写失败后移除待写值并允许重新请求 provider', async () => {
        vi.useFakeTimers();
        installBroker(undefined, Promise.resolve(), true, 25);
        const lateFailure = deferred<boolean>();
        const failure = new Error('late cache set failed');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.cacheSet
            .mockImplementationOnce(() => lateFailure.promise)
            .mockResolvedValueOnce(true);
        mocks.service
            .mockResolvedValueOnce('失败前可复用译文')
            .mockResolvedValueOnce('持久化失败后重译');

        const first = translateWithCache({origin: 'Late failed persistence'});
        await flushMicrotasks(100);
        await vi.advanceTimersByTimeAsync(25);
        await expect(first).resolves.toBe('失败前可复用译文');
        await flushMicrotasks();
        await expect(translateWithCache({origin: 'Late failed persistence'}))
            .resolves.toBe('失败前可复用译文');
        expect(mocks.service).toHaveBeenCalledOnce();

        lateFailure.reject(failure);
        await flushMicrotasks(100);
        expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache write failed:', failure);

        await expect(translateWithCache({origin: 'Late failed persistence'}))
            .resolves.toBe('持久化失败后重译');
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it('批量缓存写全部完成前消息保持未完成，完成后整批可从缓存复用', async () => {
        const writes = deferred<boolean>();
        mocks.cacheSet.mockImplementation(async (key: string, value: string) => {
            await writes.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service.mockResolvedValueOnce(['首个 A', '首个 B']);

        let settled = false;
        const request = translateWithCache({origin: ['Deferred A', 'Deferred B']});
        void request.finally(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledTimes(2));
        expect(settled).toBe(false);
        expect(mocks.service).toHaveBeenCalledOnce();

        writes.resolve(true);
        await expect(request).resolves.toEqual(['首个 A', '首个 B']);
        await expect(translateWithCache({origin: ['Deferred A', 'Deferred B']}))
            .resolves.toEqual(['首个 A', '首个 B']);
        expect(mocks.service).toHaveBeenCalledOnce();
    });

    it('缓存写失败只记录旁路诊断，不产生 unhandled rejection 或覆盖译文', async () => {
        const failure = new Error('cache set failed');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.cacheSet.mockRejectedValueOnce(failure);
        mocks.service.mockResolvedValueOnce('成功译文');

        await expect(translateWithCache({origin: 'Rejected set'})).resolves.toBe('成功译文');
        await flushMicrotasks();
        expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache write failed:', failure);
    });

    it('clear 等待已开始的迟到写，随后清库避免旧译文复活', async () => {
        const lateWrite = deferred<boolean>();
        mocks.cacheSet.mockImplementationOnce(async (key: string, value: string) => {
            await lateWrite.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service.mockResolvedValueOnce('迟到缓存译文');

        const translation = translateWithCache({origin: 'Late set before clear'});
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledOnce());
        const clearing = clearTranslationCache();
        await flushMicrotasks();
        expect(mocks.cacheClear).not.toHaveBeenCalled();

        lateWrite.resolve(true);
        await expect(translation).resolves.toBe('迟到缓存译文');
        await clearing;
        expect(mocks.cacheClear).toHaveBeenCalledOnce();
        expect(mocks.cacheStore.size).toBe(0);
    });

    it('关闭缓存时 AI 上下文只做请求内去重，不读写或复用任何摘要缓存', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        let resolveFirstSummary!: (value: string) => void;
        let summaryCalls = 0;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (!message.summaryPrompt) return Promise.resolve(`${message.origin}-译文`);
            summaryCalls += 1;
            if (summaryCalls === 1) {
                return new Promise<string>((resolve) => {
                    resolveFirstSummary = resolve;
                });
            }
            return Promise.resolve(`摘要 ${summaryCalls}`);
        });
        mocks.cacheGet.mockClear();
        mocks.cacheSet.mockClear();

        const first = translateWithCache({origin: 'A', pageContext: 'private context', useCache: false});
        const second = translateWithCache({origin: 'B', pageContext: 'private context', useCache: false});
        await flushMicrotasks();
        expect(summaryCalls).toBe(1);
        resolveFirstSummary('请求内共享摘要');
        await expect(Promise.all([first, second])).resolves.toEqual(['A-译文', 'B-译文']);

        await expect(translateWithCache({origin: 'C', pageContext: 'private context', useCache: false}))
            .resolves.toBe('C-译文');
        expect(summaryCalls).toBe(2);

        mocks.config.useCache = false;
        await expect(translateWithCache({origin: 'D', pageContext: 'global no-cache context'}))
            .resolves.toBe('D-译文');
        expect(summaryCalls).toBe(3);
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('摘要 provider 超时会中止信号、释放 pending、允许重试且忽略迟到缓存写入', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        vi.useFakeTimers();
        const lateSummary = deferred<string>();
        const summarySignals: AbortSignal[] = [];
        let summaryCalls = 0;
        mocks.service.mockImplementation((message: {
            abortSignal?: AbortSignal;
            origin: string;
            requestTimeoutMs?: number;
            summaryPrompt?: string;
        }) => {
            if (!message.summaryPrompt) return Promise.resolve(`${message.origin}-译文`);
            summaryCalls += 1;
            if (message.abortSignal) summarySignals.push(message.abortSignal);
            return summaryCalls === 1 ? lateSummary.promise : Promise.resolve('新摘要');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const summaryKey = cacheKey({
            requestMode: 'page-summary',
            sourceLanguage: 'auto',
            targetLanguage: '',
            sourceText: 'Retry context',
            service: 'ai',
            model: 'ai-model',
            modelThinking: false,
            endpoint: '',
            customBody: '',
        });
        const first = translateWithCache({
            origin: 'First',
            pageContext: 'Retry context',
            requestTimeoutMs: 4_000,
        });
        await flushMicrotasks(20);
        expect(summarySignals[0]?.aborted).toBe(false);
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            summaryPrompt: 'summarize:Retry context',
            requestTimeoutMs: 1_000,
        }));

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(first).resolves.toBe('First-译文');
        expect(summarySignals[0]?.aborted).toBe(true);
        expect(mocks.cacheStore.has(summaryKey)).toBe(false);

        await expect(translateWithCache({
            origin: 'Second',
            pageContext: 'Retry context',
            requestTimeoutMs: 4_000,
        })).resolves.toBe('Second-译文');
        expect(summaryCalls).toBe(2);
        const freshContext = 'Page summary (AI-generated reference):\n新摘要\n\nRetry context';
        expect(mocks.cacheStore.get(summaryKey)).toBe(freshContext);
        expect(mocks.cacheSet.mock.calls.filter(([key]) => key === summaryKey)).toHaveLength(1);

        lateSummary.resolve('迟到摘要');
        await flushMicrotasks(20);
        expect(mocks.cacheStore.get(summaryKey)).toBe(freshContext);
        expect(mocks.cacheSet.mock.calls.filter(([key]) => key === summaryKey)).toHaveLength(1);
    });

    it('没有显式请求 deadline 时，摘要 provider 仍在十秒后中止并回退原上下文', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        vi.useFakeTimers();
        let summarySignal: AbortSignal | undefined;
        mocks.service.mockImplementation((message: {abortSignal?: AbortSignal; origin: string; summaryPrompt?: string}) => {
            if (message.summaryPrompt) {
                summarySignal = message.abortSignal;
                return new Promise<string>(() => undefined);
            }
            return Promise.resolve(`${message.origin}-译文`);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        let settled = false;
        const request = translateWithCache({
            origin: 'Default summary deadline',
            pageContext: 'Default deadline context',
            useCache: false,
        }).finally(() => {
            settled = true;
        });
        await flushMicrotasks(20);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        expect(summarySignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(request).resolves.toBe('Default summary deadline-译文');
        expect(summarySignal?.aborted).toBe(true);
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            origin: 'Default summary deadline',
            pageContext: 'Default deadline context',
        }));
    });

    it('falls back to raw page context when summary budget expires and reports total budget exhaustion', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) return new Promise<string>(() => undefined);
            return Promise.resolve(`${message.origin}-译文`);
        });

        const timed = translateWithCache({
            origin: 'Budgeted',
            pageContext: 'Slow context',
            requestTimeoutMs: 4_000,
            useCache: false,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(timed).resolves.toBe('Budgeted-译文');
        expect(mocks.service).toHaveBeenLastCalledWith(expect.objectContaining({
            pageContext: 'Slow context',
            requestTimeoutMs: 3_000,
        }));

        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (message.summaryPrompt) {
                return new Promise<string>(resolve => {
                    setTimeout(() => resolve('Late summary'), 1_500);
                });
            }
            return Promise.resolve(`${message.origin}-译文`);
        });
        const late = translateWithCache({
            origin: 'Late budget',
            pageContext: 'Late context',
            requestTimeoutMs: 4_000,
            useCache: false,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(late).resolves.toBe('Late budget-译文');
        await vi.advanceTimersByTimeAsync(500);

        vi.useRealTimers();
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(4_000);
        mocks.service.mockReset();
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt ? 'Too late summary' : 'never')
        ));
        await expect(translateWithCache({
            origin: 'Timeout',
            pageContext: 'Timeout context',
            requestTimeoutMs: 4_000,
            useCache: false,
        })).rejects.toThrow('翻译请求超时');
        expect(mocks.service.mock.calls.filter(([message]) => !message.summaryPrompt)).toHaveLength(0);
    });

    it('keeps AI summary disabled for non-finite budgets and blank page contexts', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.service.mockResolvedValue('译文');

        await expect(translateWithCache({
            origin: 'Blank context',
            pageContext: '   ',
            requestTimeoutMs: Number.NaN,
            useCache: false,
        })).resolves.toBe('译文');

        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.service).toHaveBeenCalledWith(expect.objectContaining({
            pageContext: '',
        }));
    });

    it('clears persisted and summary caches and exposes cleanup', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => (
            Promise.resolve(message.summaryPrompt ? 'Summary' : '译文')
        ));

        await translateWithCache({origin: 'Before clear', pageContext: 'Clear context'});
        await clearTranslationCache();
        await translateWithCache({origin: 'After clear', pageContext: 'Clear context'});
        await cleanupTranslationCache();

        expect(mocks.cacheClear).toHaveBeenCalledOnce();
        expect(mocks.cacheCleanup).toHaveBeenCalledOnce();
        expect(mocks.service.mock.calls.filter(([message]) => message.summaryPrompt)).toHaveLength(2);
    });

    it('清理期间使未完成的单条与批量请求失效，旧结果不能重新写缓存或继续参与去重', async () => {
        let resolveSingle!: (value: string) => void;
        mocks.service.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveSingle = resolve;
        }));
        const staleSingle = translateWithCache({origin: 'stale-single'});
        await flushMicrotasks();

        await clearTranslationCache();
        resolveSingle('旧单条译文');
        await expect(staleSingle).resolves.toBe('旧单条译文');
        expect(mocks.cacheSet).not.toHaveBeenCalled();

        mocks.service.mockResolvedValueOnce('新单条译文');
        await expect(translateWithCache({origin: 'stale-single'})).resolves.toBe('新单条译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);

        mocks.cacheSet.mockClear();
        let resolveBatch!: (value: string[]) => void;
        mocks.service.mockImplementationOnce(() => new Promise<string[]>((resolve) => {
            resolveBatch = resolve;
        }));
        const staleBatch = translateWithCache({origin: ['stale-a', 'stale-b']});
        await flushMicrotasks();

        await clearTranslationCache();
        resolveBatch(['旧 A', '旧 B']);
        await expect(staleBatch).resolves.toEqual(['旧 A', '旧 B']);
        expect(mocks.cacheSet).not.toHaveBeenCalled();

        mocks.service.mockResolvedValueOnce(['新 A', '新 B']);
        await expect(translateWithCache({origin: ['stale-a', 'stale-b']})).resolves.toEqual(['新 A', '新 B']);
        expect(mocks.service).toHaveBeenCalledTimes(4);
    });

    it('清理使未完成的 AI 摘要失效，完成后的原请求可用但下一请求必须重新生成摘要', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        let resolveSummary!: (value: string) => void;
        let summaryCalls = 0;
        mocks.service.mockImplementation((message: {summaryPrompt?: string; origin: string}) => {
            if (!message.summaryPrompt) return Promise.resolve(`${message.origin}-译文`);
            summaryCalls += 1;
            if (summaryCalls === 1) {
                return new Promise<string>((resolve) => {
                    resolveSummary = resolve;
                });
            }
            return Promise.resolve('新摘要');
        });

        const staleRequest = translateWithCache({
            origin: '旧请求',
            pageContext: '同一页面上下文',
            useCache: true,
        });
        await flushMicrotasks();
        await clearTranslationCache();
        resolveSummary('迟到摘要');
        await expect(staleRequest).resolves.toBe('旧请求-译文');
        expect(mocks.cacheSet).not.toHaveBeenCalled();

        await expect(translateWithCache({
            origin: '新请求',
            pageContext: '同一页面上下文',
            useCache: true,
        })).resolves.toBe('新请求-译文');
        expect(summaryCalls).toBe(2);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(2);
    });

    it('旧摘要在 clear 后才进入正文时，正文 pending 不得被新代请求复用', async () => {
        mocks.config.service = 'ai';
        mocks.config.enableAIContext = true;
        mocks.config.useCache = false;
        const oldSummary = deferred<string>();
        const oldBody = deferred<string>();
        const freshSummary = deferred<string>();
        const freshBody = deferred<string>();
        let summaryCalls = 0;
        let bodyCalls = 0;
        mocks.service.mockImplementation((message: {summaryPrompt?: string}) => {
            if (message.summaryPrompt) {
                summaryCalls += 1;
                return summaryCalls === 1 ? oldSummary.promise : freshSummary.promise;
            }
            bodyCalls += 1;
            return bodyCalls === 1 ? oldBody.promise : freshBody.promise;
        });
        const message = {
            origin: 'generation-sensitive-body',
            pageContext: 'shared generation context',
            useCache: false,
        } as const;

        const staleRequest = translateWithCache({...message});
        await vi.waitFor(() => expect(summaryCalls).toBe(1));
        await clearTranslationCache();

        oldSummary.resolve('shared summary');
        await vi.waitFor(() => expect(bodyCalls).toBe(1));

        const freshRequest = translateWithCache({...message});
        await vi.waitFor(() => expect(summaryCalls).toBe(2));
        freshSummary.resolve('shared summary');
        await vi.waitFor(() => expect(bodyCalls).toBe(2));

        freshBody.resolve('新代正文译文');
        await expect(freshRequest).resolves.toBe('新代正文译文');
        oldBody.resolve('旧代正文译文');
        await expect(staleRequest).resolves.toBe('旧代正文译文');
        expect(mocks.service).toHaveBeenCalledTimes(4);
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('清理会等待已经进入存储适配器的旧写入，再执行最终清库', async () => {
        let releaseWrite!: () => void;
        mocks.service.mockResolvedValueOnce('待清理译文');
        mocks.cacheSet.mockImplementationOnce(async (key: string, value: string) => {
            await new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
            mocks.cacheStore.set(key, value);
            return true;
        });

        const translation = translateWithCache({origin: 'write-race'});
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledOnce());
        const clearing = clearTranslationCache();
        await flushMicrotasks();
        expect(mocks.cacheClear).not.toHaveBeenCalled();

        releaseWrite();
        await expect(translation).resolves.toBe('待清理译文');
        await clearing;
        expect(mocks.cacheClear).toHaveBeenCalledOnce();
        expect(mocks.cacheStore.size).toBe(0);
    });

    it('清理期间的新缓存请求等待所有连续 clear，随后读取、翻译并持久化新值', async () => {
        const staleWrite = deferred<boolean>();
        mocks.cacheSet.mockImplementationOnce(async (key: string, value: string) => {
            await staleWrite.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service
            .mockResolvedValueOnce('清理前旧译文')
            .mockResolvedValueOnce('连续清理后新译文');

        const staleRequest = translateWithCache({origin: 'clear-barrier-source'});
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledOnce());
        const firstClear = clearTranslationCache();

        mocks.cacheGet.mockClear();
        const freshRequest = translateWithCache({origin: 'clear-barrier-source'});
        await flushMicrotasks();
        expect(mocks.cacheGet).not.toHaveBeenCalled();
        expect(mocks.service).toHaveBeenCalledOnce();

        // 请求已经在等待第一道屏障后再加入第二次 clear；不能从两次 clear
        // 之间的短窗口继续执行。
        const secondClear = clearTranslationCache();
        await flushMicrotasks();
        expect(mocks.cacheClear).not.toHaveBeenCalled();
        expect(mocks.cacheGet).not.toHaveBeenCalled();

        staleWrite.resolve(true);
        await expect(staleRequest).resolves.toBe('清理前旧译文');
        await Promise.all([firstClear, secondClear]);
        await expect(freshRequest).resolves.toBe('连续清理后新译文');

        expect(mocks.cacheClear).toHaveBeenCalledTimes(2);
        expect(mocks.cacheGet).toHaveBeenCalledOnce();
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSet).toHaveBeenCalledTimes(2);
        await expect(translateWithCache({origin: 'clear-barrier-source'}))
            .resolves.toBe('连续清理后新译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it('等待 clear 屏障仍服从调用方取消和绝对 deadline', async () => {
        vi.useFakeTimers();
        installBroker(undefined, Promise.resolve(), true, 5_000);
        const staleWrite = deferred<boolean>();
        mocks.cacheSet.mockImplementationOnce(async (key: string, value: string) => {
            await staleWrite.promise;
            mocks.cacheStore.set(key, value);
            return true;
        });
        mocks.service.mockResolvedValueOnce('占用清理屏障的旧译文');

        const staleRequest = translateWithCache({origin: 'barrier-owner'});
        await flushMicrotasks(100);
        expect(mocks.cacheSet).toHaveBeenCalledOnce();
        const clearing = clearTranslationCache();

        const controller = new AbortController();
        const aborted = translateWithCache(attachTranslationRequestControl({
            origin: 'aborted-during-clear',
        }, {
            signal: controller.signal,
            ownershipKey: 'clear-barrier-abort',
        }));
        const timedOut = translateWithCache({
            origin: 'timed-out-during-clear',
            requestTimeoutMs: 1_000,
        });
        const timedOutOutcome = timedOut.catch((error: unknown) => error);
        await flushMicrotasks();
        controller.abort();
        await expect(aborted).rejects.toMatchObject({name: 'AbortError'});

        await vi.advanceTimersByTimeAsync(1_000);
        await expect(timedOutOutcome).resolves.toMatchObject({
            name: 'TranslationProviderDeadlineError',
        });
        expect(mocks.service).toHaveBeenCalledOnce();

        staleWrite.resolve(true);
        await expect(staleRequest).resolves.toBe('占用清理屏障的旧译文');
        await clearing;
        expect(mocks.cacheClear).toHaveBeenCalledOnce();
    });

    it('records every cache identity input expected by the broker contract', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.enableAIContext = true;
        mocks.config.customBody.aiSdk = '{"temperature":0}';
        mocks.config.system_role.aiSdk = 'system';
        mocks.config.user_role.aiSdk = 'user';
        mocks.config.deepseekApiType = 'reasoner';
        mocks.config.modelThinking = {aiSdk: {'ai-sdk-model': true}};

        await translateWithCache({
            origin: 'Identity',
            pageContext: 'Identity context',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
        });

        const identities = mocks.buildTranslationCacheKey.mock.calls.map(([identity]) => identity as CacheIdentity);
        expect(identities).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestMode: 'page-summary',
                customBody: '{"temperature":0}',
                endpoint: 'https://aiSdk.endpoint.test',
                model: 'ai-sdk-model',
                modelThinking: true,
                sourceText: 'Identity context',
                transportProfile: 'ai-sdk-profile',
            }),
            expect.objectContaining({
                requestMode: 'single',
                customBody: '{"temperature":0}',
                deepseekApiType: 'reasoner',
                endpoint: 'https://aiSdk.endpoint.test',
                model: 'ai-sdk-model',
                modelThinking: true,
                pageContext: expect.stringContaining('Identity context'),
                sourceLanguage: 'en',
                sourceText: 'Identity',
                systemRole: 'system',
                targetLanguage: 'fr',
                transportProfile: 'ai-sdk-profile',
                userRole: 'user',
            }),
        ]));

        expect(cacheIdentityAt(0)).toMatchObject({requestMode: 'page-summary'});
    });

    it('按模型 Thinking 状态隔离缓存，并把冻结值传给 provider', async () => {
        mocks.config.service = 'ai';
        mocks.config.modelThinking = {ai: {'ai-model': false}};
        mocks.service.mockImplementation((message: {thinkingOverride?: boolean}) => (
            Promise.resolve(message.thinkingOverride ? '思考译文' : '快速译文')
        ));

        await expect(translateWithCache({origin: 'same-thinking-source'})).resolves.toBe('快速译文');
        mocks.config.modelThinking = {ai: {'ai-model': true}};
        await expect(translateWithCache({origin: 'same-thinking-source'})).resolves.toBe('思考译文');
        mocks.config.modelThinking = {ai: {'ai-model': false}};
        await expect(translateWithCache({origin: 'same-thinking-source'})).resolves.toBe('快速译文');
        await expect(translateWithCache({
            origin: 'request-thinking-override',
            thinkingOverride: true,
        })).resolves.toBe('思考译文');

        expect(mocks.service).toHaveBeenCalledTimes(3);
        expect(mocks.service.mock.calls.map(([message]) => message.thinkingOverride)).toEqual([false, true, true]);
        expect(translationCacheIdentities()
            .filter((identity) => identity.sourceText === 'same-thinking-source')
            .map((identity) => identity.modelThinking))
            .toEqual([false, true, false]);
        expect(translationCacheIdentities()
            .find((identity) => identity.sourceText === 'request-thinking-override'))
            .toMatchObject({modelThinking: true});
    });

    it('请求级语言覆盖同时进入 provider 与缓存身份，切换目标语言不会复用旧译文', async () => {
        mocks.service.mockImplementation(async (message: {sourceLanguage?: string; targetLanguage?: string}) =>
            `${message.sourceLanguage}->${message.targetLanguage}`);

        await expect(translateWithCache({origin: 'same', sourceLanguage: 'en', targetLanguage: 'ja'}))
            .resolves.toBe('en->ja');
        await expect(translateWithCache({origin: 'same', sourceLanguage: 'en', targetLanguage: 'fr'}))
            .resolves.toBe('en->fr');
        await expect(translateWithCache({origin: 'same', sourceLanguage: 'en', targetLanguage: 'ja'}))
            .resolves.toBe('en->ja');

        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.service.mock.calls.map(([message]) => ({
            sourceLanguage: message.sourceLanguage,
            targetLanguage: message.targetLanguage,
        }))).toEqual([
            {sourceLanguage: 'en', targetLanguage: 'ja'},
            {sourceLanguage: 'en', targetLanguage: 'fr'},
        ]);
        expect(translationCacheIdentities()).toEqual(expect.arrayContaining([
            expect.objectContaining({sourceLanguage: 'en', targetLanguage: 'ja'}),
            expect.objectContaining({sourceLanguage: 'en', targetLanguage: 'fr'}),
        ]));
    });

    it('Chrome auto 检测样本进入缓存与 pending 身份，显式源语言则不分裂缓存', async () => {
        mocks.config.service = 'chromeTranslator';
        mocks.service.mockImplementation(async (message: {sourceLanguageDetectionText?: string}) =>
            `译:${message.sourceLanguageDetectionText || 'explicit'}`);

        await expect(translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        })).resolves.toBe('译:Bonjour le monde.');
        await expect(translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'これはテストです。',
        })).resolves.toBe('译:これはテストです。');
        await expect(translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        })).resolves.toBe('译:Bonjour le monde.');

        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(translationCacheIdentities()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sourceLanguage: 'auto',
                sourceLanguageDetectionText: 'Bonjour le monde.',
            }),
            expect.objectContaining({
                sourceLanguage: 'auto',
                sourceLanguageDetectionText: 'これはテストです。',
            }),
        ]));

        await clearTranslationCache();
        mocks.service.mockClear();
        mocks.buildTranslationCacheKey.mockClear();
        await expect(translateWithCache({
            origin: 'same explicit source',
            sourceLanguage: 'fr',
            sourceLanguageDetectionText: 'sample A',
        })).resolves.toBe('译:explicit');
        await expect(translateWithCache({
            origin: 'same explicit source',
            sourceLanguage: 'fr',
            sourceLanguageDetectionText: 'sample B',
        })).resolves.toBe('译:explicit');

        expect(mocks.service).toHaveBeenCalledOnce();
        expect(translationCacheIdentities()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({sourceLanguageDetectionText: expect.any(String)}),
        ]));
    });

    it('Chrome auto 无缓存并发请求以检测样本区分 pending，并合并相同样本', async () => {
        mocks.config.service = 'chromeTranslator';
        const frenchProvider = deferred<string>();
        const japaneseProvider = deferred<string>();
        mocks.service.mockImplementation((message: {sourceLanguageDetectionText?: string}) => {
            if (message.sourceLanguageDetectionText === 'Bonjour le monde.') {
                return frenchProvider.promise;
            }
            return japaneseProvider.promise;
        });

        const french = translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'Bonjour le monde.',
            useCache: false,
        });
        const japanese = translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'これはテストです。',
            useCache: false,
        });
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(2));
        frenchProvider.resolve('フランス語訳');
        japaneseProvider.resolve('日本語訳');
        await expect(Promise.all([french, japanese]))
            .resolves.toEqual(['フランス語訳', '日本語訳']);

        mocks.service.mockClear();
        const sharedProvider = deferred<string>();
        mocks.service.mockImplementation(() => sharedProvider.promise);
        const firstShared = translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'Bonjour le monde.',
            useCache: false,
        });
        const secondShared = translateWithCache({
            origin: '___FLUENTREAD_packet___',
            sourceLanguageDetectionText: 'Bonjour le monde.',
            useCache: false,
        });
        await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledOnce());
        sharedProvider.resolve('共享译文');
        await expect(Promise.all([firstShared, secondShared]))
            .resolves.toEqual(['共享译文', '共享译文']);
    });

    it('非 Chrome provider 不会收到扩展页面伪造的重复检测正文', async () => {
        await expect(translateWithCache({
            origin: 'cloud source',
            serviceOverride: 'mock',
            sourceLanguageDetectionText: 'must stay local',
        })).resolves.toBe('默认译文');

        expect(mocks.service).toHaveBeenCalledWith(expect.not.objectContaining({
            sourceLanguageDetectionText: expect.anything(),
        }));
        expect(translationCacheIdentities()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({sourceLanguageDetectionText: expect.anything()}),
        ]));
    });

    it('cache.get 等待期间配置变化时，单条 provider 与缓存身份仍共用同一不可变快照', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.model.aiSdk = 'model-a';
        mocks.config.proxy.aiSdk = 'https://proxy-a.example/v1';
        mocks.config.customBody.aiSdk = '{"temperature":0.1}';
        mocks.config.system_role.aiSdk = 'system-a';
        mocks.config.user_role.aiSdk = 'user-a';
        mocks.endpointResolver.mockImplementation((serviceName: string, current?: unknown) => ({
            endpoint: (current as {proxy: Record<string, string>}).proxy[serviceName],
        }));

        const firstCacheRead = deferred<string | null>();
        mocks.cacheGet
            .mockImplementationOnce(() => firstCacheRead.promise)
            .mockImplementation(async (key: string) => mocks.cacheStore.get(key) ?? null);
        const providerSnapshots: ReturnType<typeof createTranslationProviderConfigSnapshot>[] = [];
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            const current = getTranslationProviderConfig(
                message,
                createTranslationProviderConfigSnapshot(mocks.config),
            );
            providerSnapshots.push(current);
            return [
                current.model.aiSdk,
                current.proxy.aiSdk,
                current.customBody.aiSdk,
                current.system_role.aiSdk,
                current.user_role.aiSdk,
            ].join('|');
        });

        const oldRequest = translateWithCache({origin: 'snapshot-race'});
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledOnce());

        mocks.config.model.aiSdk = 'model-b';
        mocks.config.proxy.aiSdk = 'https://proxy-b.example/v1';
        mocks.config.customBody.aiSdk = '{"temperature":0.9}';
        mocks.config.system_role.aiSdk = 'system-b';
        mocks.config.user_role.aiSdk = 'user-b';
        firstCacheRead.resolve(null);

        await expect(oldRequest).resolves.toBe(
            'model-a|https://proxy-a.example/v1|{"temperature":0.1}|system-a|user-a',
        );
        expect(providerSnapshots).toHaveLength(1);
        expect(Object.isFrozen(providerSnapshots[0])).toBe(true);
        expect(Object.isFrozen(providerSnapshots[0].proxy)).toBe(true);
        expect(JSON.parse(mocks.cacheSet.mock.calls[0][0])).toMatchObject({
            model: 'model-a',
            endpoint: 'https://proxy-a.example/v1',
            customBody: '{"temperature":0.1}',
            systemRole: 'system-a',
            userRole: 'user-a',
        });

        await expect(translateWithCache({origin: 'snapshot-race'})).resolves.toBe(
            'model-b|https://proxy-b.example/v1|{"temperature":0.9}|system-b|user-b',
        );
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(mocks.cacheSet.mock.calls.map(([key, value]) => ({
            identity: JSON.parse(key),
            value,
        }))).toEqual(expect.arrayContaining([
            expect.objectContaining({
                identity: expect.objectContaining({model: 'model-a', endpoint: 'https://proxy-a.example/v1'}),
                value: expect.stringContaining('model-a|https://proxy-a.example/v1'),
            }),
            expect.objectContaining({
                identity: expect.objectContaining({model: 'model-b', endpoint: 'https://proxy-b.example/v1'}),
                value: expect.stringContaining('model-b|https://proxy-b.example/v1'),
            }),
        ]));
    });

    it('批量冷缓存读取期间配置变化时，所有读写 key 与 provider 都固定在请求快照', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.model.aiSdk = 'batch-model-a';
        mocks.config.proxy.aiSdk = 'https://batch-a.example/v1';
        mocks.config.customBody.aiSdk = '{"batch":"a"}';
        mocks.config.system_role.aiSdk = 'batch-system-a';
        mocks.config.user_role.aiSdk = 'batch-user-a';
        mocks.endpointResolver.mockImplementation((serviceName: string, current?: unknown) => ({
            endpoint: (current as {proxy: Record<string, string>}).proxy[serviceName],
        }));

        const firstRead = deferred<string | null>();
        const secondRead = deferred<string | null>();
        mocks.cacheGet
            .mockImplementationOnce(() => firstRead.promise)
            .mockImplementationOnce(() => secondRead.promise)
            .mockImplementation(async (key: string) => mocks.cacheStore.get(key) ?? null);
        const providerSnapshots: ReturnType<typeof createTranslationProviderConfigSnapshot>[] = [];
        mocks.service.mockImplementation(async (message: {origin: string[]} & Record<string, unknown>) => {
            const current = getTranslationProviderConfig(
                message,
                createTranslationProviderConfigSnapshot(mocks.config),
            );
            providerSnapshots.push(current);
            return message.origin.map((origin) => `${origin}:${current.model.aiSdk}:${current.proxy.aiSdk}`);
        });

        const oldRequest = translateWithCache({origin: ['batch-one', 'batch-two']});
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledTimes(2));
        const oldReadIdentities = mocks.cacheGet.mock.calls.slice(0, 2).map(([key]) => JSON.parse(key));
        expect(oldReadIdentities).toEqual([
            expect.objectContaining({
                requestMode: 'batch',
                sourceText: 'batch-one',
                model: 'batch-model-a',
                endpoint: 'https://batch-a.example/v1',
                customBody: '{"batch":"a"}',
                systemRole: 'batch-system-a',
                userRole: 'batch-user-a',
            }),
            expect.objectContaining({
                requestMode: 'batch',
                sourceText: 'batch-two',
                model: 'batch-model-a',
                endpoint: 'https://batch-a.example/v1',
            }),
        ]);

        mocks.config.model.aiSdk = 'batch-model-b';
        mocks.config.proxy.aiSdk = 'https://batch-b.example/v1';
        mocks.config.customBody.aiSdk = '{"batch":"b"}';
        mocks.config.system_role.aiSdk = 'batch-system-b';
        mocks.config.user_role.aiSdk = 'batch-user-b';
        firstRead.resolve(null);
        secondRead.resolve(null);

        await expect(oldRequest).resolves.toEqual([
            'batch-one:batch-model-a:https://batch-a.example/v1',
            'batch-two:batch-model-a:https://batch-a.example/v1',
        ]);
        expect(providerSnapshots).toHaveLength(1);
        expect(providerSnapshots[0].model.aiSdk).toBe('batch-model-a');
        const oldWriteIdentities = mocks.cacheSet.mock.calls.slice(0, 2).map(([key]) => JSON.parse(key));
        expect(oldWriteIdentities).toEqual(oldReadIdentities);

        await expect(translateWithCache({origin: ['batch-one', 'batch-two']})).resolves.toEqual([
            'batch-one:batch-model-b:https://batch-b.example/v1',
            'batch-two:batch-model-b:https://batch-b.example/v1',
        ]);
        expect(mocks.service).toHaveBeenCalledTimes(2);
        expect(providerSnapshots[1].model.aiSdk).toBe('batch-model-b');
        expect(mocks.cacheGet.mock.calls.slice(2).map(([key]) => JSON.parse(key))).toEqual([
            expect.objectContaining({sourceText: 'batch-one', model: 'batch-model-b'}),
            expect.objectContaining({sourceText: 'batch-two', model: 'batch-model-b'}),
        ]);
        expect(mocks.cacheSet.mock.calls.slice(2).map(([key]) => JSON.parse(key))).toEqual([
            expect.objectContaining({sourceText: 'batch-one', model: 'batch-model-b'}),
            expect.objectContaining({sourceText: 'batch-two', model: 'batch-model-b'}),
        ]);
    });

    it('AI 摘要等待缓存时沿用请求快照，后续配置不会交叉污染摘要与正文缓存', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.enableAIContext = true;
        mocks.config.model.aiSdk = 'summary-model-a';
        mocks.config.proxy.aiSdk = 'https://summary-a.example/v1';
        mocks.config.customBody.aiSdk = '{"seed":"a"}';
        mocks.config.system_role.aiSdk = 'summary-system-a';
        mocks.config.user_role.aiSdk = 'summary-user-a';
        mocks.endpointResolver.mockImplementation((serviceName: string, current?: unknown) => ({
            endpoint: (current as {proxy: Record<string, string>}).proxy[serviceName],
        }));

        const summaryCacheRead = deferred<string | null>();
        mocks.cacheGet
            .mockImplementationOnce(() => summaryCacheRead.promise)
            .mockImplementation(async (key: string) => mocks.cacheStore.get(key) ?? null);
        const providerCalls: Array<{summary: boolean; snapshot: ReturnType<typeof createTranslationProviderConfigSnapshot>}> = [];
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            const current = getTranslationProviderConfig(
                message,
                createTranslationProviderConfigSnapshot(mocks.config),
            );
            const summary = typeof message.summaryPrompt === 'string';
            providerCalls.push({summary, snapshot: current});
            return summary
                ? `summary:${current.model.aiSdk}:${current.system_role.aiSdk}`
                : `translation:${current.model.aiSdk}:${current.proxy.aiSdk}:${current.user_role.aiSdk}`;
        });

        const oldRequest = translateWithCache({origin: 'summary-race', pageContext: 'shared article'});
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledOnce());

        mocks.config.model.aiSdk = 'summary-model-b';
        mocks.config.proxy.aiSdk = 'https://summary-b.example/v1';
        mocks.config.customBody.aiSdk = '{"seed":"b"}';
        mocks.config.system_role.aiSdk = 'summary-system-b';
        mocks.config.user_role.aiSdk = 'summary-user-b';
        summaryCacheRead.resolve(null);

        await expect(oldRequest).resolves.toBe(
            'translation:summary-model-a:https://summary-a.example/v1:summary-user-a',
        );
        expect(providerCalls).toHaveLength(2);
        expect(providerCalls.map(({summary, snapshot}) => ({
            summary,
            model: snapshot.model.aiSdk,
            endpoint: snapshot.proxy.aiSdk,
            systemRole: snapshot.system_role.aiSdk,
            userRole: snapshot.user_role.aiSdk,
        }))).toEqual([
            {
                summary: true,
                model: 'summary-model-a',
                endpoint: 'https://summary-a.example/v1',
                systemRole: 'summary-system-a',
                userRole: 'summary-user-a',
            },
            {
                summary: false,
                model: 'summary-model-a',
                endpoint: 'https://summary-a.example/v1',
                systemRole: 'summary-system-a',
                userRole: 'summary-user-a',
            },
        ]);

        const oldWrites = mocks.cacheSet.mock.calls.map(([key]) => JSON.parse(key) as CacheIdentity);
        expect(oldWrites).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestMode: 'page-summary',
                model: 'summary-model-a',
                endpoint: 'https://summary-a.example/v1',
                customBody: '{"seed":"a"}',
            }),
            expect.objectContaining({
                requestMode: 'single',
                model: 'summary-model-a',
                endpoint: 'https://summary-a.example/v1',
                systemRole: 'summary-system-a',
                userRole: 'summary-user-a',
            }),
        ]));

        await expect(translateWithCache({origin: 'summary-race', pageContext: 'shared article'})).resolves.toBe(
            'translation:summary-model-b:https://summary-b.example/v1:summary-user-b',
        );
        expect(providerCalls).toHaveLength(4);
        expect(providerCalls.slice(2).every(({snapshot}) => snapshot.model.aiSdk === 'summary-model-b')).toBe(true);
        const allWrites = mocks.cacheSet.mock.calls.map(([key]) => JSON.parse(key) as CacheIdentity);
        expect(allWrites).toEqual(expect.arrayContaining([
            expect.objectContaining({requestMode: 'page-summary', model: 'summary-model-b'}),
            expect.objectContaining({requestMode: 'single', model: 'summary-model-b'}),
        ]));
    });

    it('只在真实 AI provider 调用时记录服务商 usage，缓存命中不重复计数', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = true;
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                actualModel: 'kimi-k2.6',
                outcome: 'success',
                usageAvailability: 'reported',
                inputTokens: 12,
                outputTokens: 8,
                totalTokens: 20,
                cachedInputTokens: 4,
                cacheWriteTokens: 2,
            });
            return '统计译文';
        });

        await expect(translateWithCache({origin: 'usage-source'})).resolves.toBe('统计译文');
        await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalled());
        await expect(translateWithCache({origin: 'usage-source'})).resolves.toBe('统计译文');

        expect(mocks.service).toHaveBeenCalledOnce();
        expect(mocks.recordModelUsage).toHaveBeenCalledOnce();
        expect(mocks.recordModelUsage.mock.calls[0][0]).toEqual([
            expect.objectContaining({
                serviceId: 'aiSdk',
                configuredModel: 'ai-sdk-model',
                actualModel: 'kimi-k2.6',
                purpose: 'translation',
                outcome: 'success',
                usageAvailability: 'reported',
                inputTokens: 12,
                outputTokens: 8,
                totalTokens: 20,
                cachedInputTokens: 4,
                cacheWriteTokens: 2,
            }),
        ]);
    });

    it('未提供模型用量代次端口时以零代次记录真实 AI 调用', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        installBroker(undefined, Promise.resolve(), false);
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '零代次译文';
        });

        await expect(translateWithCache({origin: 'usage-generation-fallback'})).resolves.toBe('零代次译文');
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({purpose: 'translation', outcome: 'success'}),
        ], 0);
    });

    it('区分摘要与正文，并把同一 provider 内的多次真实尝试逐条落库', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.enableAIContext = true;
        mocks.config.useCache = false;
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            if (typeof message.summaryPrompt === 'string') {
                reportTranslationModelUsage(message, {
                    usageAvailability: 'reported',
                    inputTokens: 5,
                    outputTokens: 2,
                    totalTokens: 7,
                });
                return '页面摘要';
            }
            reportTranslationModelUsage(message, {
                outcome: 'error',
                statusCode: 429,
                usageAvailability: 'unreported',
            });
            reportTranslationModelUsage(message, {
                outcome: 'success',
                usageAvailability: 'reported',
                inputTokens: 10,
                outputTokens: 6,
                totalTokens: 16,
            });
            return '正文译文';
        });

        await expect(translateWithCache({
            origin: 'usage-with-context',
            pageContext: 'article context',
        })).resolves.toBe('正文译文');

        expect(mocks.recordModelUsage).toHaveBeenCalledTimes(2);
        expect(mocks.recordModelUsage.mock.calls[0][0]).toEqual([
            expect.objectContaining({purpose: 'page-summary', totalTokens: 7}),
        ]);
        expect(mocks.recordModelUsage.mock.calls[1][0]).toEqual([
            expect.objectContaining({purpose: 'translation', outcome: 'error', statusCode: 429}),
            expect.objectContaining({purpose: 'translation', outcome: 'success', totalTokens: 16}),
        ]);
    });

    it('provider 未报告 usage 或统计仓库失败都不改变翻译结果', async () => {
        mocks.config.service = 'ai';
        mocks.config.useCache = false;
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '无 usage 译文';
        });
        mocks.recordModelUsage.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(translateWithCache({origin: 'unreported-source'})).resolves.toBe('无 usage 译文');
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({
                serviceId: 'ai',
                purpose: 'translation',
                outcome: 'success',
                usageAvailability: 'unreported',
            }),
        ], 7);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        warn.mockRestore();
    });

    it('规范化 provider 自报的时间与模型名，并保留已经发生的上游成功尝试', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                actualModel: ' \u0000kimi-k2.6\u007f ',
                startedAt: 123,
                durationMs: -8,
                outcome: 'success',
                usageAvailability: 'reported',
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
            });
            throw new Error('response parse failed');
        });

        await expect(translateWithCache({origin: 'parse-error'})).rejects.toThrow('response parse failed');
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({
                actualModel: 'kimi-k2.6',
                startedAt: 123,
                durationMs: 0,
                outcome: 'success',
            }),
        ], 7);
    });

    it('把 provider 取消映射为 cancelled，并安全回退非法观察字段', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        installBroker(() => 500);
        const abortError = new Error('cancelled by caller');
        abortError.name = 'AbortError';
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                actualModel: ' \u0000\u007f ',
                startedAt: Number.NaN,
                durationMs: Number.NaN,
                usageAvailability: 'unreported',
            });
            throw abortError;
        });

        await expect(translateWithCache({origin: 'cancelled'})).rejects.toBe(abortError);
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({
                actualModel: undefined,
                startedAt: 500,
                durationMs: 0,
                outcome: 'cancelled',
            }),
        ], 7);
    });

    it('给同一 provider 的多条无时间观察使用零时长，并记录 AI 超时', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        mocks.service.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                actualModel: 42 as unknown as string,
                usageAvailability: 'unreported',
            });
            reportTranslationModelUsage(message, {
                usageAvailability: 'unreported',
            });
            return '双尝试译文';
        });

        await expect(translateWithCache({origin: 'two-attempts'})).resolves.toBe('双尝试译文');
        expect(mocks.recordModelUsage.mock.calls[0][0]).toEqual([
            expect.objectContaining({actualModel: undefined, durationMs: 0, outcome: 'success'}),
            expect.objectContaining({durationMs: 0, outcome: 'success'}),
        ]);

        vi.useFakeTimers();
        mocks.recordModelUsage.mockClear();
        mocks.service.mockImplementationOnce((message: Record<string, unknown>) => new Promise<string>(() => {
            const signal = message.abortSignal as AbortSignal;
            signal.addEventListener('abort', () => {
                reportTranslationModelUsage(message, {
                    outcome: 'cancelled',
                    usageAvailability: 'unreported',
                });
            }, {once: true});
        }));
        const timedOut = translateWithCache({origin: 'usage-timeout', requestTimeoutMs: 1_000});
        const rejection = expect(timedOut).rejects.toThrow('翻译请求超时');
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({outcome: 'timeout', usageAvailability: 'unreported'}),
        ], 7);
    });

    it('本地预检失败不伪造上游请求，统计写入在消息响应前形成 barrier', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        mocks.service.mockRejectedValueOnce(new Error('endpoint validation failed'));

        await expect(translateWithCache({origin: 'preflight'})).rejects.toThrow('endpoint validation failed');
        expect(mocks.recordModelUsage).not.toHaveBeenCalled();

        const usageWrite = deferred<undefined>();
        mocks.recordModelUsage.mockImplementationOnce(() => usageWrite.promise);
        mocks.service.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '等待统计落盘的译文';
        });
        let settled = false;
        const request = translateWithCache({origin: 'durable-usage'});
        void request.finally(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(mocks.recordModelUsage).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({usageAvailability: 'unreported'}),
        ], 7);
        usageWrite.resolve(undefined);
        await expect(request).resolves.toBe('等待统计落盘的译文');
    });

    it('模型用量写入超过宽限期不会永久占用无缓存 pending', async () => {
        vi.useFakeTimers();
        installBroker(undefined, Promise.resolve(), true, 25);
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        mocks.recordModelUsage.mockImplementation(() => new Promise<undefined>(() => undefined));
        mocks.service.mockImplementation(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {usageAvailability: 'unreported'});
            return '用量宽限译文';
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const first = translateWithCache({origin: 'Hung usage', useCache: false});
        await flushMicrotasks(100);
        expect(mocks.recordModelUsage).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(25);
        await expect(first).resolves.toBe('用量宽限译文');
        expect(warn).toHaveBeenCalledWith(
            '[FluentRead] model usage write timed out:',
            expect.any(Error),
        );

        const second = translateWithCache({origin: 'Hung usage', useCache: false});
        await flushMicrotasks(100);
        await vi.advanceTimersByTimeAsync(25);
        await expect(second).resolves.toBe('用量宽限译文');
        expect(mocks.service).toHaveBeenCalledTimes(2);
    });

    it('把结构化 provider timeout 与 HTTP 408 校准为 timeout', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        for (const {timeoutError, observation} of [
            {
                timeoutError: Object.assign(new Error('sdk timeout'), {kind: 'timeout'}),
                observation: {outcome: 'cancelled' as const},
            },
            {
                timeoutError: Object.assign(new Error('http timeout'), {statusCode: 408}),
                observation: {outcome: 'cancelled' as const},
            },
            {
                timeoutError: new Error('adapter omitted structured timeout'),
                observation: {outcome: 'error' as const, statusCode: 408},
            },
        ]) {
            mocks.service.mockImplementationOnce(async (message: Record<string, unknown>) => {
                reportTranslationModelUsage(message, {
                    ...observation,
                    usageAvailability: 'unreported',
                });
                throw timeoutError;
            });
            await expect(translateWithCache({origin: `timeout-${mocks.service.mock.calls.length}`}))
                .rejects.toBe(timeoutError);
        }

        expect(mocks.recordModelUsage).toHaveBeenCalledTimes(3);
        expect(mocks.recordModelUsage.mock.calls.map(([events]) => events[0]?.outcome))
            .toEqual(['timeout', 'timeout', 'timeout']);
    });

    it('HTTP 408 只校准最后一次失败，不改写批量中更早的成功 observation', async () => {
        mocks.config.service = 'aiSdk';
        mocks.config.useCache = false;
        const timeoutError = new Error('later transport timed out');
        mocks.service.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationModelUsage(message, {
                outcome: 'success',
                usageAvailability: 'reported',
                totalTokens: 12,
            });
            reportTranslationModelUsage(message, {
                outcome: 'error',
                statusCode: 408,
                usageAvailability: 'unreported',
            });
            throw timeoutError;
        });

        await expect(translateWithCache({origin: ['first', 'second']})).rejects.toBe(timeoutError);
        expect(mocks.recordModelUsage).toHaveBeenCalledWith([
            expect.objectContaining({outcome: 'success', totalTokens: 12}),
            expect.objectContaining({outcome: 'timeout', statusCode: 408}),
        ], 7);
    });
});
