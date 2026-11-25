/**
 * @file tests/translationEfficiencyOptimization.test.ts
 * 文件职责：验证翻译缓存批量事务、主流大模型轻量 JSON 合批、提示词前缀缓存稳定性和调度器签名快路径的正确性与效率收益。
 * 主要内容：测试 TranslationCache 的 getMany/setMany 单事务行为与过期/容量边界，验证 broker 批量路径复用批量缓存端口，核对 Claude/Gemini/DeepSeek/通义在多段翻译中走 compactBatch 并拒绝截断响应，验证页面上下文位于段落术语前以保持 LLM 前缀缓存一致。
 * 模块边界：纯 Vitest 单元与集成测试，使用内存与 fake-indexeddb，不访问外部网络。
 */
import 'fake-indexeddb/auto';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
    translationCache,
    translationCacheDb,
    TRANSLATION_CACHE_MEMORY_ENTRIES,
} from '@/src/services/translation/cache';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {buildOpenAIChatPayload} from '@/src/services/translation/templates';
import {defaultOption, resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {Config} from '@/src/core/config/model';
import {TRANSLATION_COMPACT_BATCH, type TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import deepseek from '@/src/providers/translation/deepseek';
import gemini from '@/src/providers/translation/gemini';
import tongyi from '@/src/providers/translation/tongyi';
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
    });

    it.each([services.claude, services.gemini, services.deepseek, services.tongyi] as const)(
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
        const {attachTranslationProviderConfig} = await import('@/src/services/translation/requestSnapshot');

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
});
