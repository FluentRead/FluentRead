/**
 * @file tests/translationEfficiencyOptimization.test.ts
 * 文件职责：验证翻译缓存批量事务、主流大模型轻量 JSON 合批、提示词前缀缓存稳定性和调度器签名快路径的正确性与效率收益。
 * 主要内容：测试 TranslationCache 的 getMany/setMany 单事务行为与过期/容量边界，验证 broker 批量路径复用批量缓存端口，核对 Claude/Gemini/DeepSeek/通义在多段翻译中走 compactBatch 并拒绝截断响应，验证页面上下文位于段落术语前以保持 LLM 前缀缓存一致。
 * 模块边界：纯 Vitest 单元与集成测试，使用内存与 fake-indexeddb，不访问外部网络。
 */
import 'fake-indexeddb/auto';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const sendMessageMock = vi.hoisted(() => vi.fn());
vi.mock('webextension-polyfill', () => ({
    default: {
        runtime: {sendMessage: sendMessageMock},
    },
}));

import {
    translationCache,
    translationCacheDb,
    TRANSLATION_CACHE_MAX_ENTRY_BYTES,
    TRANSLATION_CACHE_MEMORY_ENTRIES,
    TRANSLATION_CACHE_TTL_MS,
} from '@/src/services/translation/cache';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {buildOpenAIChatPayload} from '@/src/services/translation/templates';
import {translateTextBatch} from '@/src/services/translation/client';
import {defaultOption, resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {Config} from '@/src/core/config/model';
import {config as runtimeConfig} from '@/src/services/config/store';
import {TRANSLATION_COMPACT_BATCH, type TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import deepseek from '@/src/providers/translation/deepseek';
import gemini from '@/src/providers/translation/gemini';
import tongyi from '@/src/providers/translation/tongyi';
import doubaoSeedTranslation from '@/src/providers/translation/doubao-seed-translation';
import hunyuanTranslation from '@/src/providers/translation/hunyuan-translation';
import {attachTranslationRequestScheduler} from '@/src/services/translation/requestSnapshot';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

function makeConfig(overrides: Partial<Config> = {}): Config {
    const base = new Config();
    return Object.assign(base, {
        from: 'en',
        to: 'zh-Hans',
        useCache: true,
        enableAIContext: true,
        token: {
            ...base.token,
            claude: 'sk-ant-test',
            gemini: 'AIza-test',
            deepseek: 'sk-ds-test',
            tongyi: 'sk-qwen-test',
            zhipu: 'zhipu-id.zhipu-secret',
            openai: 'sk-openai-test',
        },
        ...overrides,
    });
}

describe('translation efficiency and cost optimizations', () => {
    beforeEach(async () => {
        await translationCache.clear();
        await translationCache.setLimits({maxEntries: 5_000, maxBytes: 10 * 1024 * 1024});
        setRuntimeFetch(null as never);
    });

    it('persists and reads batches in single IndexedDB transactions via setMany and getMany', async () => {
        const entries = Array.from({length: 16}, (_, index) => ({
            key: `v3:batch-key-${index}`,
            value: `译文段落 ${index}`,
        }));

        const txSpy = vi.spyOn(translationCacheDb, 'transaction');
        const written = await translationCache.setMany(entries, 1_000);
        expect(written).toBe(16);
        expect(txSpy).toHaveBeenCalledTimes(1);
        txSpy.mockRestore();

        // 热内存层命中：零 IndexedDB 查询。
        const bulkGetSpy = vi.spyOn(translationCacheDb.entries, 'bulkGet');
        const memoryHits = await translationCache.getMany(entries.map((entry) => entry.key), 1_005);
        expect(memoryHits).toEqual(entries.map((entry) => entry.value));
        expect(bulkGetSpy).not.toHaveBeenCalled();

        // 验证热内存容量已扩大至 384，可容纳完整长文而不回退 IndexedDB。
        expect(TRANSLATION_CACHE_MEMORY_ENTRIES).toBeGreaterThanOrEqual(384);
        bulkGetSpy.mockRestore();
    });

    it('handles getMany and setMany edge cases: empty, invalid/oversize, DB miss/hit/expiry, overwrite, epoch races, and storage errors', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            // 空输入与全无效输入
            expect(await translationCache.getMany([])).toEqual([]);
            expect(await translationCache.setMany([])).toBe(0);
            expect(await translationCache.setMany([
                {key: 'v3:empty', value: ''},
                {key: 'v3:too-long', value: 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES + 1)},
                {key: 'v3:wide-utf8', value: '汉'.repeat(Math.ceil(TRANSLATION_CACHE_MAX_ENTRY_BYTES / 2))},
            ], 1_000)).toBe(0);

            // 单条委托 + 写入失败分支
            expect(await translationCache.setMany([{key: 'v3:single', value: '单条'}], 1_000)).toBe(1);
            const setSpy = vi.spyOn(translationCache, 'set').mockResolvedValueOnce(false);
            expect(await translationCache.setMany([{key: 'v3:single-fail', value: '失败'}], 1_000)).toBe(0);
            setSpy.mockRestore();

            // 覆盖已有条目 + 重复键去重
            expect(await translationCache.setMany([
                {key: 'v3:single', value: '覆盖旧值'},
                {key: 'v3:single', value: '覆盖最终值'},
                {key: 'v3:second', value: '第二条'},
            ], 1_000)).toBe(2);
            expect(await translationCache.getMany(['v3:single', 'v3:second'], 1_005)).toEqual(['覆盖最终值', '第二条']);

            // 仅含有效库内记录（无过期键）时的 getMany 分支
            await translationCacheDb.entries.put({
                key: 'v3:db-only-valid',
                translation: '纯有效库命中',
                createdAt: 1_000,
                lastAccessedAt: 1_000,
                expiresAt: 1_000 + TRANSLATION_CACHE_TTL_MS,
                byteSize: 24,
            });
            expect(await translationCache.getMany(['v3:db-only-valid'], 2_000)).toEqual(['纯有效库命中']);

            // 绕过内存直接写库，覆盖 getMany 读库命中、重复键扇出、缺失和过期回收
            await translationCacheDb.entries.bulkPut([
                {
                    key: 'v3:db-hit',
                    translation: '库内命中',
                    createdAt: 1_000,
                    lastAccessedAt: 1_000,
                    expiresAt: 1_000 + TRANSLATION_CACHE_TTL_MS,
                    byteSize: 20,
                },
                {
                    key: 'v3:db-expired',
                    translation: '库内过期',
                    createdAt: 1_000,
                    lastAccessedAt: 1_000,
                    expiresAt: 1_500,
                    byteSize: 20,
                },
            ]);
            expect(await translationCache.getMany(['v3:db-hit', 'v3:db-hit', 'v3:db-missing', 'v3:db-expired'], 2_000))
                .toEqual(['库内命中', '库内命中', null, null]);
            expect(await translationCacheDb.entries.get('v3:db-expired')).toBeUndefined();

            // 内存过期后台回收 + 回收失败降级日志
            const expiredTime = 1_000 + TRANSLATION_CACHE_TTL_MS + 100;
            const txFail = vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('tx failed'));
            expect(await translationCache.getMany(['v3:single'], expiredTime)).toEqual([null]);
            await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
            txFail.mockRestore();

            // removeExpiredMany 遇到记录已更新或 clearEpoch 变更时提前返回
            await translationCache.set('v3:mem-exp-updated', '旧值', 1_000);
            const origBulkGet = translationCacheDb.entries.bulkGet.bind(translationCacheDb.entries);
            vi.spyOn(translationCacheDb.entries, 'bulkGet').mockImplementationOnce((async () => [{
                key: 'v3:mem-exp-updated',
                translation: '新值',
                createdAt: expiredTime,
                lastAccessedAt: expiredTime,
                expiresAt: expiredTime + TRANSLATION_CACHE_TTL_MS,
                byteSize: 24,
            }]) as never);
            expect(await translationCache.getMany(['v3:mem-exp-updated'], expiredTime)).toEqual([null]);
            await vi.waitFor(() => expect(translationCacheDb.entries.bulkGet).toHaveBeenCalled());
            vi.restoreAllMocks();
            vi.spyOn(console, 'warn').mockImplementation(() => undefined);

            // removeExpiredMany epoch 变化分支
            await translationCache.set('v3:mem-exp-clear', '待清', 1_000);
            const origTx = translationCacheDb.transaction.bind(translationCacheDb);
            vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((...args: unknown[]) => {
                void translationCache.clear();
                return (origTx as (...a: unknown[]) => unknown)(...args) as never;
            });
            expect(await translationCache.getMany(['v3:mem-exp-clear'], expiredTime)).toEqual([null]);
            await translationCache.clear();

            // getMany 读库期间 clear() 导致 epoch 变化与读库异常
            await translationCacheDb.entries.put({
                key: 'v3:race',
                translation: '竞态',
                createdAt: 1_000,
                lastAccessedAt: 1_000,
                expiresAt: 1_000 + TRANSLATION_CACHE_TTL_MS,
                byteSize: 16,
            });
            vi.spyOn(translationCacheDb.entries, 'bulkGet').mockImplementationOnce((async (keys: readonly string[]) => {
                const res = await origBulkGet(keys as string[]);
                await translationCache.clear();
                return res;
            }) as never);
            expect(await translationCache.getMany(['v3:race'], 2_000)).toEqual([null]);

            vi.spyOn(translationCacheDb.entries, 'bulkGet').mockRejectedValueOnce(new Error('read err'));
            expect(await translationCache.getMany(['v3:missing-err'], 2_000)).toEqual([null]);

            // setMany 写库期间 clear() 导致 epoch 变化（事务内和事务后）以及写库异常
            vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((...args: unknown[]) => {
                void translationCache.clear();
                return (origTx as (...a: unknown[]) => unknown)(...args) as never;
            });
            expect(await translationCache.setMany([
                {key: 'v3:race-a', value: 'A'},
                {key: 'v3:race-b', value: 'B'},
            ], 2_000)).toBe(0);

            vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('write err'));
            expect(await translationCache.setMany([
                {key: 'v3:err-a', value: 'A'},
                {key: 'v3:err-b', value: 'B'},
            ], 2_000)).toBe(0);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('batches broker cache reads and writes through getMany and setMany when available', async () => {
        const store = new Map<string, string>();
        const get = vi.fn(async (key: string) => store.get(key) ?? null);
        const getMany = vi.fn(async (keys: readonly string[]) => keys.map((key) => store.get(key) ?? null));
        const set = vi.fn(async (key: string, value: string) => {
            store.set(key, value);
            return true;
        });
        const setMany = vi.fn(async (entries: readonly {key: string; value: string}[]) => {
            entries.forEach(({key, value}) => store.set(key, value));
            return entries.length;
        });
        const provider = vi.fn(async (request: {origin: string | string[]}) => (
            Array.isArray(request.origin) ? request.origin.map((text) => `中文:${text}`) : `中文:${request.origin}`
        ));
        const currentConfig = makeConfig({service: services.google});
        const broker = createTranslationBroker({
            ready: Promise.resolve(),
            getConfig: () => currentConfig,
            providers: {[services.google]: provider},
            cache: {get, getMany, set, setMany, clear: async () => store.clear(), cleanup: async () => undefined},
            buildTranslationCacheKey: (identity) => JSON.stringify(identity),
            getTranslationLanguages: (override = {}) => ({
                sourceLanguage: override.sourceLanguage || 'auto',
                targetLanguage: override.targetLanguage || 'zh-Hans',
            }),
            getMissingCredentialMessage: () => null,
            resolveConfiguredModel,
            serviceTypes: servicesType,
            endpointResolver: {
                aiSdkTransportProfile: 'test',
                resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://example.invalid/v1/chat/completions'}),
            },
            promptBuilder: {
                buildPageSummaryPrompt: (text) => text,
                buildPageSummarySystemPrompt: () => 'summary',
            },
        });

        const batch = ['First sentence.', 'Second sentence.', 'Third sentence.', 'Fourth sentence.'];
        const first = await broker.translateWithCache({origin: batch});
        expect(first).toEqual(batch.map((text) => `中文:${text}`));
        expect(getMany).toHaveBeenCalledTimes(1);
        expect(setMany).toHaveBeenCalledTimes(1);
        expect(get).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();

        // 二次请求全部通过单次 getMany 命中缓存，零上游调用。
        const second = await broker.translateWithCache({origin: batch});
        expect(second).toEqual(first);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(getMany).toHaveBeenCalledTimes(2);

        // 覆盖 pendingCacheValues 命中、批量写失败/超时日志、clear 换代写跳过和单条缓存落盘
        let releaseSlowWrite!: () => void;
        const slowSetMany = vi.fn(() => new Promise<number>((resolve) => {
            releaseSlowWrite = () => resolve(2);
        }));
        const logger = {warn: vi.fn()};
        const brokerSlow = createTranslationBroker({
            ready: Promise.resolve(),
            getConfig: () => currentConfig,
            providers: {[services.google]: provider},
            cache: {
                get: async (key) => store.get(key) ?? null,
                getMany: async (keys) => keys.map((key) => store.get(key) ?? null),
                set: async (key, value) => { store.set(key, value); return true; },
                setMany: slowSetMany,
                clear: async () => store.clear(),
                cleanup: async () => undefined,
            },
            logger,
            persistenceGraceMs: 5,
            buildTranslationCacheKey: (identity) => JSON.stringify(identity),
            getTranslationLanguages: (override = {}) => ({
                sourceLanguage: override.sourceLanguage || 'auto',
                targetLanguage: override.targetLanguage || 'zh-Hans',
            }),
            getMissingCredentialMessage: () => null,
            resolveConfiguredModel,
            serviceTypes: servicesType,
            endpointResolver: {
                aiSdkTransportProfile: 'test',
                resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://example.invalid/v1/chat/completions'}),
            },
            promptBuilder: {
                buildPageSummaryPrompt: (text) => text,
                buildPageSummarySystemPrompt: () => 'summary',
            },
        });
        // 触发批量写超时宽限期，同时 pendingCacheValues 仍向紧随的同批请求提供热命中
        const freshBatch = ['Pending alpha.', 'Pending beta.'];
        const firstSlow = await brokerSlow.translateWithCache({origin: freshBatch});
        expect(firstSlow).toEqual(['中文:Pending alpha.', '中文:Pending beta.']);
        expect(logger.warn).toHaveBeenCalledWith('[FluentRead] translation cache write timed out:', expect.anything());
        // 紧随请求在 slowSetMany 完成前直接命中 pendingCacheValues（不调用 getMany）
        const cachedFromPending = await brokerSlow.translateWithCache({origin: freshBatch});
        expect(cachedFromPending).toEqual(firstSlow);
        // 在途批量写完成前执行 clearTranslationCache，覆盖 finally 中 pendingCacheValues 已被清空的分支
        const clearDone = brokerSlow.clearTranslationCache();
        releaseSlowWrite();
        await clearDone;

        // 批量写拒绝日志 + clear 换代期间跳过过期写
        slowSetMany.mockRejectedValueOnce(new Error('idb quota'));
        const failBatch = ['Fail gamma.', 'Fail delta.'];
        await expect(brokerSlow.translateWithCache({origin: failBatch})).resolves.toEqual(['中文:Fail gamma.', '中文:Fail delta.']);
        expect(logger.warn).toHaveBeenCalledWith('[FluentRead] translation cache write failed:', expect.any(Error));

        // clear() 换代使挂起写入前检查 generation !== cacheGeneration
        const brokerClear = createTranslationBroker({
            ready: Promise.resolve(),
            getConfig: () => currentConfig,
            providers: {
                [services.google]: async (req) => {
                    const out = (req.origin as string[]).map((t) => `中文:${t}`);
                    void brokerClear.clearTranslationCache();
                    return out;
                },
            },
            cache: {
                get: async () => null,
                getMany: async (keys) => keys.map(() => null),
                set: async () => true,
                setMany: vi.fn(async () => 2),
                clear: async () => undefined,
                cleanup: async () => undefined,
            },
            buildTranslationCacheKey: (identity) => JSON.stringify(identity),
            getTranslationLanguages: (override = {}) => ({
                sourceLanguage: override.sourceLanguage || 'auto',
                targetLanguage: override.targetLanguage || 'zh-Hans',
            }),
            getMissingCredentialMessage: () => null,
            resolveConfiguredModel,
            serviceTypes: servicesType,
            endpointResolver: {
                aiSdkTransportProfile: 'test',
                resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://example.invalid/v1/chat/completions'}),
            },
            promptBuilder: {
                buildPageSummaryPrompt: (text) => text,
                buildPageSummarySystemPrompt: () => 'summary',
            },
        });
        await expect(brokerClear.translateWithCache({origin: ['Clear one.', 'Clear two.']})).resolves.toEqual(['中文:Clear one.', '中文:Clear two.']);
        // 混合批命中 1 条 + 重复 key 1 条（触发 getMany 扇出及仅 1 条写入分支）
        await expect(broker.translateWithCache({origin: ['Only single miss.', 'Only single miss.']})).resolves.toEqual(['中文:Only single miss.', '中文:Only single miss.']);
    });

    it.each([services.claude, services.gemini, services.deepseek, services.tongyi, services.zhipu] as const)(
        'uses compact JSON batch protocol for %s to avoid verbose slot marker tokens',
        async (service) => {
            const receivedOrigins: Array<string | string[]> = [];
            const receivedCompactFlags: boolean[] = [];
            const provider = vi.fn(async (request: {origin: string | string[]; [TRANSLATION_COMPACT_BATCH]?: true}) => {
                receivedOrigins.push(request.origin);
                const configSnapshot = (request as unknown as Record<symbol, TranslationProviderConfigSnapshot | undefined>);
                const snapshot = Object.getOwnPropertySymbols(request)
                    .map((sym) => configSnapshot[sym])
                    .find((value): value is TranslationProviderConfigSnapshot => Boolean(value && typeof value === 'object' && 'service' in value));
                receivedCompactFlags.push(Boolean(snapshot?.[TRANSLATION_COMPACT_BATCH]));
                const parsed = JSON.parse(String(request.origin)) as string[];
                return JSON.stringify(parsed.map((text, index) => [index, `译文(${text})`]));
            });

            const currentConfig = makeConfig({
                service,
                model: {
                    ...new Config().model,
                    [services.tongyi]: 'qwen-plus',
                    [services.deepseek]: 'deepseek-chat',
                    [services.claude]: 'claude-sonnet-4-5',
                    [services.gemini]: 'gemini-2.5-flash',
                },
            });
            const broker = createTranslationBroker({
                ready: Promise.resolve(),
                getConfig: () => currentConfig,
                providers: {[service]: provider},
                cache: {
                    get: async () => null,
                    set: async () => true,
                    clear: async () => undefined,
                    cleanup: async () => undefined,
                },
                buildTranslationCacheKey: (identity) => JSON.stringify(identity),
                getTranslationLanguages: (override = {}) => ({
                    sourceLanguage: override.sourceLanguage || 'auto',
                    targetLanguage: override.targetLanguage || 'zh-Hans',
                }),
                getMissingCredentialMessage: () => null,
                resolveConfiguredModel,
                serviceTypes: servicesType,
                endpointResolver: {
                    aiSdkTransportProfile: 'test',
                    resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://example.invalid/v1/chat/completions'}),
                },
                promptBuilder: {
                    buildPageSummaryPrompt: (text) => text,
                    buildPageSummarySystemPrompt: () => 'summary',
                },
            });

            const segments = [
                'Design systems reduce cognitive load.',
                'Batch translation cuts request overhead.',
                'Prefix caching lowers input token costs.',
            ];
            const result = await broker.translateWithCache({
                origin: segments,
                aiMultiSegment: true,
                useCache: false,
            });
            expect(result).toEqual(segments.map((text) => `译文(${text})`));
            expect(receivedCompactFlags).toEqual([true]);
            expect(String(receivedOrigins[0])).toBe(JSON.stringify(segments));
            expect(String(receivedOrigins[0])).not.toContain('___FLUENTREAD_');
        },
    );

    it('rejects length-truncated compact batch responses in DeepSeek, Gemini, and Tongyi', async () => {
        const base = createTranslationProviderConfigSnapshot(makeConfig({
            model: {
                ...new Config().model,
                [services.deepseek]: 'deepseek-chat',
                [services.gemini]: 'gemini-2.5-flash',
                [services.tongyi]: 'qwen-plus',
            },
        }));
        const compactConfig = Object.freeze({...base, [TRANSLATION_COMPACT_BATCH]: true as const});

        // DeepSeek Chat & Responses 正常 compactBatch 透传原始 JSON 字符串（含字面 <think>）
        const rawCompact = '[[0,"你好 <think>tag</think>"]]';
        setRuntimeFetch(async () => new Response(JSON.stringify({
            choices: [{message: {content: rawCompact}, finish_reason: 'stop'}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(deepseek(attachTranslationProviderConfig({
            origin: '["Hello"]', serviceOverride: services.deepseek, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, compactConfig))).resolves.toBe(rawCompact);

        const compactResponsesConfig = Object.freeze({...compactConfig, deepseekApiType: 'responses' as const});
        setRuntimeFetch(async () => new Response(JSON.stringify({
            status: 'completed',
            output: [{type: 'message', status: 'completed', content: [{type: 'output_text', text: rawCompact}]}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(deepseek(attachTranslationProviderConfig({
            origin: '["Hello"]', serviceOverride: services.deepseek, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, compactResponsesConfig))).resolves.toBe(rawCompact);

        // 非 compactBatch 模式下 DeepSeek Chat 与 Responses 正常走后处理分支
        const normalChatConfig = Object.freeze({...base, deepseekApiType: 'chat' as const});
        setRuntimeFetch(async () => new Response(JSON.stringify({
            choices: [{message: {content: '普通译文'}, finish_reason: 'stop'}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(deepseek(attachTranslationProviderConfig({
            origin: 'Hello', serviceOverride: services.deepseek, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, normalChatConfig))).resolves.toBe('普通译文');

        const normalResponsesConfig = Object.freeze({...base, deepseekApiType: 'responses' as const});
        setRuntimeFetch(async () => new Response(JSON.stringify({
            status: 'completed',
            output: [{type: 'message', status: 'completed', content: [{type: 'output_text', text: '普通响应译文'}]}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(deepseek(attachTranslationProviderConfig({
            origin: 'Hello', serviceOverride: services.deepseek, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, normalResponsesConfig))).resolves.toBe('普通响应译文');

        setRuntimeFetch(async () => new Response(JSON.stringify({
            choices: [{message: {content: '[[0,"你好"]]'}, finish_reason: 'length'}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(deepseek(attachTranslationProviderConfig({
            origin: '["Hello"]', serviceOverride: services.deepseek, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, compactConfig))).rejects.toMatchObject({code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});

        setRuntimeFetch(async () => new Response(JSON.stringify({
            candidates: [{content: {parts: [{text: '[[0,"你好"]]'}]}, finishReason: 'MAX_TOKENS'}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(gemini(attachTranslationProviderConfig({
            origin: '["Hello"]', serviceOverride: services.gemini, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, compactConfig))).rejects.toMatchObject({code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});

        setRuntimeFetch(async () => new Response(JSON.stringify({
            choices: [{message: {content: '[[0,"你好"]]'}, finish_reason: 'length'}],
        }), {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(tongyi(attachTranslationProviderConfig({
            origin: '["Hello"]', serviceOverride: services.tongyi, sourceLanguage: 'en', targetLanguage: 'zh-Hans', requestTimeoutMs: 5_000,
        }, compactConfig))).rejects.toMatchObject({code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});
    });

    it('keeps webpage_context ahead of per-paragraph glossary for stable LLM prompt prefix caching', () => {
        const pageSummary = 'Page summary (AI-generated reference):\nThis guide explains browser extension performance tuning, IndexedDB batching, and prompt caching.';
        const baseConfig = createTranslationProviderConfigSnapshot(makeConfig({
            service: services.openai,
            system_role: {[services.openai]: defaultOption.system_role},
            user_role: {[services.openai]: defaultOption.user_role},
        }));
        const configA = Object.freeze({
            ...baseConfig,
            glossaryTerms: [{source: 'IndexedDB', target: '本地索引库'}],
        });
        const configB = Object.freeze({
            ...baseConfig,
            glossaryTerms: [{source: 'Prompt Caching', target: '提示词缓存'}],
        });

        const payloadA = buildOpenAIChatPayload({
            current: configA,
            serviceOverride: services.openai,
            origin: 'IndexedDB transactions should be batched.',
            context: pageSummary,
            targetLanguage: 'zh-Hans',
        });
        const payloadB = buildOpenAIChatPayload({
            current: configB,
            serviceOverride: services.openai,
            origin: 'Prompt Caching lowers repeated input cost.',
            context: pageSummary,
            targetLanguage: 'zh-Hans',
        });

        const userA = (payloadA.messages as Array<{content: string}>)[1]!.content;
        const userB = (payloadB.messages as Array<{content: string}>)[1]!.content;
        const contextEndA = userA.indexOf('</webpage_context>') + '</webpage_context>'.length;
        const contextEndB = userB.indexOf('</webpage_context>') + '</webpage_context>'.length;
        const glossaryStartA = userA.indexOf('<fluentread_glossary>');
        const glossaryStartB = userB.indexOf('<fluentread_glossary>');

        // <webpage_context> 位于 <fluentread_glossary> 之前，且两段请求在上下文结束前的整段前缀逐字节一致。
        expect(contextEndA).toBeGreaterThan(0);
        expect(contextEndA).toBeLessThan(glossaryStartA);
        expect(contextEndB).toBeLessThan(glossaryStartB);
        expect(userA.slice(0, contextEndA)).toBe(userB.slice(0, contextEndB));
    });

    it('reacts immediately when scheduler switches between default and service-level limits', async () => {
        let currentLimits: {
            maxConcurrentTranslations: number;
            serviceRequestLimits?: Record<string, {enabled: boolean; limits: {maxConcurrentTranslations: number}}>;
        } = {maxConcurrentTranslations: 2};
        const scheduler = createTranslationRequestScheduler(() => currentLimits);

        let running = 0;
        let peak = 0;
        const releases: Array<() => void> = [];
        const startTask = () => scheduler.schedule(() => new Promise<void>((resolve) => {
            running += 1;
            peak = Math.max(peak, running);
            releases.push(() => {
                running -= 1;
                resolve();
            });
        }), {identity: {service: services.openai}});

        const first = startTask();
        const second = startTask();
        expect(peak).toBe(2);
        releases.splice(0).forEach((release) => release());
        await Promise.all([first, second]);

        // 启用服务级并发上限 1 后，签名快路径必须失效并立即按新限额执行。
        currentLimits = {
            maxConcurrentTranslations: 4,
            serviceRequestLimits: {[services.openai]: {enabled: true, limits: {maxConcurrentTranslations: 1}}},
        };
        peak = 0;
        const third = startTask();
        const fourth = startTask();
        expect(peak).toBe(1);
        expect(releases).toHaveLength(1);
        releases.splice(0).forEach((release) => release());
        await third;
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        expect(peak).toBe(1);
        releases.splice(0).forEach((release) => release());
        await fourth;
    });

    it('deduplicates repeated strings during batch language preflight in client translateTextBatch', async () => {
        const previousService = runtimeConfig.service;
        const previousTo = runtimeConfig.to;
        sendMessageMock.mockReset();
        sendMessageMock.mockImplementation(async (message: unknown) => {
            const req = message as {origin?: string[]};
            return Array.isArray(req.origin) ? req.origin.map((text) => `译:${text}`) : '';
        });
        try {
            runtimeConfig.service = services.google;
            runtimeConfig.to = 'zh-Hans';
            const result = await translateTextBatch(
                ['Repeated UI label', 'Repeated UI label', 'Another button'],
                'Test Page',
                {serviceOverride: services.google, targetLanguage: 'zh-Hans'},
            );
            expect(result).toEqual(['译:Repeated UI label', '译:Repeated UI label', '译:Another button']);
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
        } finally {
            runtimeConfig.service = previousService;
            runtimeConfig.to = previousTo;
        }
    });

    it('repairs multiple leaked/invalid slots concurrently in AI multi-segment batches and deduplicates repeated batch cache keys', async () => {
        let activeRepairs = 0;
        let peakRepairs = 0;
        const releaseRepairs: Array<() => void> = [];
        let callIndex = 0;
        const provider = vi.fn(async (request: {origin: string | string[]}) => {
            callIndex += 1;
            if (callIndex === 1) {
                // 首个完整批次：第 0、2 槽返回原文回显，第 1 槽已正确翻译。
                return JSON.stringify([
                    [0, 'First paragraph needs repair.'],
                    [1, '第二段已正确翻译。'],
                    [2, 'Third paragraph needs repair.'],
                ]);
            }
            activeRepairs += 1;
            peakRepairs = Math.max(peakRepairs, activeRepairs);
            await new Promise<void>((resolve) => {
                releaseRepairs.push(() => {
                    activeRepairs -= 1;
                    resolve();
                });
            });
            return `已修复:${String(request.origin)}`;
        });
        const endpointSpy = vi.fn(() => ({endpoint: 'https://example.invalid/v1/chat/completions'}));
        const cacheKeySpy = vi.fn((identity: Record<string, unknown>) => JSON.stringify(identity));
        const currentConfig = makeConfig({service: services.openai, enableAIContext: false});
        const broker = createTranslationBroker({
            ready: Promise.resolve(),
            getConfig: () => currentConfig,
            providers: {[services.openai]: provider},
            cache: {get: async () => null, getMany: async (keys) => keys.map(() => null), set: async () => true, setMany: async () => 1, clear: async () => undefined, cleanup: async () => undefined},
            buildTranslationCacheKey: cacheKeySpy,
            getTranslationLanguages: (override = {}) => ({
                sourceLanguage: override.sourceLanguage || 'en',
                targetLanguage: override.targetLanguage || 'zh-Hans',
            }),
            getMissingCredentialMessage: () => null,
            resolveConfiguredModel,
            serviceTypes: servicesType,
            endpointResolver: {aiSdkTransportProfile: 'test', resolveOpenAICompatibleEndpoint: endpointSpy},
            promptBuilder: {buildPageSummaryPrompt: (text) => text, buildPageSummarySystemPrompt: () => 'summary'},
        });

        const promise = broker.translateWithCache({
            origin: ['First paragraph needs repair.', 'Second paragraph.', 'Third paragraph needs repair.'],
            aiMultiSegment: true,
            useCache: false,
        });
        await vi.waitFor(() => expect(releaseRepairs).toHaveLength(2));
        expect(peakRepairs).toBe(2);
        releaseRepairs.splice(0).forEach((release) => release());
        await expect(promise).resolves.toEqual([
            '已修复:First paragraph needs repair.',
            '第二段已正确翻译。',
            '已修复:Third paragraph needs repair.',
        ]);

        // 批量缓存键对重复文本只构建一次，且端点解析按快照复用。
        cacheKeySpy.mockClear();
        endpointSpy.mockClear();
        const repeatedProvider = vi.fn(async (req: {origin: string | string[]}) =>
            (req.origin as string[]).map((text) => `译:${text}`),
        );
        const batchBroker = createTranslationBroker({
            ready: Promise.resolve(),
            getConfig: () => makeConfig({service: services.openai}),
            providers: {[services.openai]: repeatedProvider},
            cache: {get: async () => null, getMany: async (keys) => keys.map(() => null), set: async () => true, setMany: async () => 1, clear: async () => undefined, cleanup: async () => undefined},
            buildTranslationCacheKey: cacheKeySpy,
            getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
            getMissingCredentialMessage: () => null,
            resolveConfiguredModel,
            serviceTypes: servicesType,
            endpointResolver: {aiSdkTransportProfile: 'test', resolveOpenAICompatibleEndpoint: endpointSpy},
            promptBuilder: {buildPageSummaryPrompt: (text) => text, buildPageSummarySystemPrompt: () => 'summary'},
        });
        await batchBroker.translateWithCache({origin: ['Repeat me.', 'Repeat me.', 'Repeat me.', 'Unique one.', 'Repeat me.', 'Unique two.']});
        // 1 次 batchKey + 3 次唯一 itemKey（而非 6 次 itemKey），端点解析与批量项数无关（只按配置快照解析）。
        expect(cacheKeySpy).toHaveBeenCalledTimes(4);
        expect(endpointSpy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('reports HTTP 429 responses from Doubao Seed Translation and Hunyuan Translation to the request scheduler', async () => {
        const observeResponse = vi.fn();
        const scheduler = {schedule: vi.fn(), scheduleAttempt: vi.fn(), observeResponse};
        const base = createTranslationProviderConfigSnapshot(makeConfig({
            token: {...new Config().token, [services.doubao]: 'ark-key'},
            model: {...new Config().model, [services.doubao]: 'doubao-seed-translation-250915'},
            tencentSecretId: '1234567890-id',
            tencentSecretKey: '1234567890-key',
        }));

        setRuntimeFetch(async () => new Response('rate limited', {status: 429, headers: {'retry-after': '3'}}));
        const doubaoReq = attachTranslationRequestScheduler(
            attachTranslationProviderConfig({
                origin: 'Hello', serviceOverride: services.doubao, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
            }, base),
            scheduler,
            {service: services.doubao, quotaScope: 'doubao-scope'},
        );
        await expect(doubaoSeedTranslation(doubaoReq)).rejects.toMatchObject({statusCode: 429});
        expect(observeResponse).toHaveBeenCalledTimes(1);

        const hunyuanReq = attachTranslationRequestScheduler(
            attachTranslationProviderConfig({
                origin: 'Hello', serviceOverride: services.huanYuanTranslation, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
            }, base),
            scheduler,
            {service: services.huanYuanTranslation, quotaScope: 'hunyuan-scope'},
        );
        await expect(hunyuanTranslation(hunyuanReq)).rejects.toMatchObject({statusCode: 429});
        expect(observeResponse).toHaveBeenCalledTimes(2);
    });
});
