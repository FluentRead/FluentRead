import {describe, expect, it, vi} from 'vitest';
import {createTranslationCachePolicyBinding} from '@/src/services/translation/cachePolicyBinding';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {Config} from '@/src/core/config/model';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function fixture(ready = Promise.resolve()) {
    let config = {translationCacheMaxBytes: 5 * 1024 * 1024, translationCacheMaxEntries: 2_000};
    let listener!: (next: typeof config) => void;
    const setLimits = vi.fn(async (_limits: {maxBytes: number; maxEntries: number}): Promise<void> => undefined);
    const warn = vi.fn();
    const binding = createTranslationCachePolicyBinding({
        ready, getConfig: () => config, setLimits, warn,
        subscribe(callback) { listener = callback; callback(config); return () => undefined; },
    });
    return {
        binding, setLimits, warn,
        update(patch: Partial<typeof config>) { config = {...config, ...patch}; listener(config); },
    };
}

describe('持久缓存策略与配置生命周期', () => {
    it('等待水合后应用保存上限，重复通知和管理读取不重复执行维护', async () => {
        const hydration = deferred();
        const f = fixture(hydration.promise);
        expect(f.setLimits).not.toHaveBeenCalled();
        hydration.resolve();
        await f.binding.ready;
        expect(f.setLimits).toHaveBeenCalledOnce();
        expect(f.setLimits).toHaveBeenCalledWith({maxBytes: 5 * 1024 * 1024, maxEntries: 2000});
        f.update({});
        await f.binding.applyLatest();
        expect(f.setLimits).toHaveBeenCalledTimes(1);
        f.update({translationCacheMaxEntries: 100});
        await f.binding.applyLatest();
        expect(f.setLimits).toHaveBeenLastCalledWith({maxBytes: 5 * 1024 * 1024, maxEntries: 100});
    });

    it('启动维护失败只告警，管理读取会重试而不会误报完成', async () => {
        const f = fixture();
        const error = new Error('IndexedDB unavailable');
        f.setLimits.mockRejectedValueOnce(error);
        await expect(f.binding.ready).resolves.toBeUndefined();
        expect(f.warn).toHaveBeenCalledWith(error);
        expect(f.warn).toHaveBeenCalledOnce();
        f.setLimits.mockRejectedValueOnce(error);
        await expect(f.binding.applyLatest()).rejects.toBe(error);
        await expect(f.binding.applyLatest()).resolves.toBeUndefined();
        expect(f.setLimits).toHaveBeenCalledTimes(3);
    });

    it.each([false, true])('首次持久层维护阻塞时 useCache=%s 的翻译可以完成，管理读取仍等待维护', async (useCache) => {
        const blocked = deferred();
        const f = fixture();
        f.setLimits.mockImplementationOnce(() => blocked.promise);
        const config = Object.assign(new Config(), {service: 'fixture', useCache});
        const provider = vi.fn(async () => '译文');
        const cacheGet = vi.fn(async () => null);
        const broker = createTranslationBroker({
            ready: f.binding.ready,
            getConfig: () => config,
            providers: {fixture: provider},
            cache: {
                get: cacheGet,
                set: async () => true,
                clear: async () => undefined,
                cleanup: async () => undefined,
            },
            serviceTypes: {
                machine: new Set(['fixture']),
                isAI: () => false,
                isAiSdk: () => false,
                isUseAIContext: () => false,
            },
            endpointResolver: {
                resolveOpenAICompatibleEndpoint: () => ({endpoint: ''}),
                aiSdkTransportProfile: '',
            },
            promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            resolveConfiguredModel: () => '',
            buildTranslationCacheKey: () => 'fixture-cache-key',
        });
        let managed = false;
        const management = f.binding.applyLatest().then(() => { managed = true; });
        try {
            await expect(broker.translateWithCache({origin: 'source', requestTimeoutMs: 1_000}))
                .resolves.toBe('译文');
            expect(provider).toHaveBeenCalledOnce();
            expect(cacheGet).toHaveBeenCalledTimes(useCache ? 1 : 0);
            expect(f.setLimits).toHaveBeenCalledOnce();
            expect(managed).toBe(false);
        } finally {
            blocked.resolve();
            await management;
        }
        expect(managed).toBe(true);
    });

    it('旧策略迟到失败不能使较新的有效策略失效或再次维护', async () => {
        const f = fixture();
        await f.binding.ready;
        const old = deferred();
        f.setLimits.mockImplementationOnce(() => old.promise);
        f.update({translationCacheMaxEntries: 300});
        f.update({translationCacheMaxEntries: 100});
        await f.binding.applyLatest();
        old.reject(new Error('old maintenance failed'));
        await Promise.resolve();
        await Promise.resolve();
        await f.binding.applyLatest();
        expect(f.setLimits).toHaveBeenCalledTimes(3);
        expect(f.setLimits).toHaveBeenLastCalledWith({maxBytes: 5 * 1024 * 1024, maxEntries: 100});
    });

    it('配置就绪失败被记录，翻译启动不被缓存附属维护阻断', async () => {
        const error = new Error('hydration failed');
        const f = fixture(Promise.reject(error));
        await expect(f.binding.ready).resolves.toBeUndefined();
        expect(f.warn).toHaveBeenCalledOnce();
        expect(f.warn).toHaveBeenCalledWith(error);
        expect(f.setLimits).not.toHaveBeenCalled();
    });
});
