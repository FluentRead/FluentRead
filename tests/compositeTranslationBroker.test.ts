import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {
    attachTranslationImageInput, attachTranslationRequestControl, getTranslationImageInput,
    getTranslationProviderConfig, getTranslationRequestScheduler, markTranslationRemainingBudget,
    reportTranslationModelUsage, allowUnchangedTranslationResult, reportTranslationRoute,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationModelUsageRecord, TranslationProvider, TranslationProviderRegistry} from '@/src/services/translation/types';

const group = 'composite:test';
const sourceText = 'This paragraph explains how translation works.';
const translatedText = '这一段解释翻译如何工作。';

function setup(members: string[] = [services.google, services.microsoft]) {
    const config = Object.assign(new Config(), {
        service: group, useCache: true, enableAIContext: false, from: 'en', to: 'zh-Hans',
        compositeTranslationProviders: [{id: group, name: '组合测试', strategy: 'sequential' as const,
            services: members, timeoutMs: 1_000}],
    });
    config.token.openai = 'fixture-composite-openai';
    config.model.openai = 'gpt-4.1-mini';
    config.customModel.openai = '';
    const providers: TranslationProviderRegistry = {};
    for (const service of members) providers[service] = vi.fn<TranslationProvider>(async () => translatedText);
    const cacheStore = new Map<string, string>();
    const cacheKeys = vi.fn((identity: Record<string, unknown>) => JSON.stringify(identity));
    const recordRequest = vi.fn();
    const recordUsage = vi.fn(async (_events: readonly TranslationModelUsageRecord[], _generation: number) => undefined);
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => config, providers,
        cache: {get: async key => cacheStore.get(key) ?? null, set: async (key, value) => {
            cacheStore.set(key, value); return true;
        }, clear: async () => {cacheStore.clear();}, cleanup: async () => undefined},
        serviceTypes: servicesType,
        endpointResolver: {resolveOpenAICompatibleEndpoint: service => ({endpoint: `https://${service}.example/v1/chat/completions`}),
            aiSdkTransportProfile: 'fixture-ai-sdk'},
        promptBuilder: {buildPageSummaryPrompt: context => `summarize:${context}`, buildPageSummarySystemPrompt: () => 'summary-system'},
        getMissingCredentialMessage,
        getTranslationLanguages: override => resolveTranslationLanguages(override, {sourceLanguage: config.from, targetLanguage: config.to}),
        resolveConfiguredModel, buildTranslationCacheKey: cacheKeys,
        recordTranslationRequest: recordRequest, recordModelUsage: recordUsage,
        logger: {warn: vi.fn()},
    });
    return {broker, config, providers, cacheKeys, cacheStore, recordRequest, recordUsage};
}

afterEach(() => vi.useRealTimers());

describe('组合翻译真实 broker 接入', () => {
    it('所有供应商抛出空错误时仍返回明确失败，而不伪造成功或丢失路由记录', async () => {
        const h = setup(); vi.mocked(h.providers.google).mockRejectedValue(undefined); vi.mocked(h.providers.microsoft).mockRejectedValue(undefined);
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).rejects.toThrow('组合翻译没有可用的成员服务');
        expect(h.providers.google).toHaveBeenCalledOnce(); expect(h.providers.microsoft).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0].routes).toEqual([services.google, services.microsoft]);
    });
    it('跳过已关闭的组合成员并在其他成员上继续回退', async () => {
        const h = setup([services.google, services.microsoft]);
        h.config.disabledTranslationServices = [services.google];
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.providers.microsoft).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0].routes).toEqual([services.microsoft]);
    });

    it('组合成员全部关闭时在 provider 调用前返回明确错误', async () => {
        const h = setup([services.google, services.microsoft]);
        h.config.disabledTranslationServices = [services.google, services.microsoft];
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false}))
            .rejects.toMatchObject({message: '组合翻译的所有成员都已关闭，请重新启用至少一个服务', kind: 'bad-request', retryable: false, code: 'TRANSLATION_SERVICE_DISABLED'});
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.providers.microsoft).not.toHaveBeenCalled();
    });

    it('图片组合的单条协议成员接受整批原样结果，沿用取消所有权且不换成员', async () => {
        const h = setup([services.claude, services.google]);
        h.config.token.claude = 'fixture-claude';
        const origins = [sourceText, 'The second paragraph describes caching.'];
        h.providers.claude = vi.fn(async message => message.origin);
        const controller = new AbortController();
        const request = attachTranslationRequestControl(allowUnchangedTranslationResult({origin: origins}),
            {signal: controller.signal, ownershipKey: 'image-composite-original'});
        await expect(h.broker.translateWithCache(request)).resolves.toEqual(origins);
        expect(h.providers.claude).toHaveBeenCalledTimes(2);
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({outcome: 'success', upstreamCalls: 2});
    });

    it('图片组合旧缓存泄漏后逐段恢复仍允许原样结果，清除上下文并保留正确槽', async () => {
        const h = setup([services.claude]);
        h.config.token.claude = 'fixture-claude'; h.config.enableAIContext = true;
        const origins = [sourceText, 'The second paragraph describes caching.'];
        h.providers.claude = vi.fn(async message => 'summaryPrompt' in message ? '安全摘要' : message.origin);
        const request = () => allowUnchangedTranslationResult({origin: origins, pageContext: 'Page title: Reference. Readable page content: caching instructions.'});
        await expect(h.broker.translateWithCache(request())).resolves.toEqual(origins);
        for (const [key] of h.cacheStore) {
            if (JSON.parse(key).sourceText === sourceText) h.cacheStore.set(key, '<webpage_context>页面参考材料</webpage_context>');
        }
        vi.mocked(h.providers.claude).mockClear();
        await expect(h.broker.translateWithCache(request())).resolves.toEqual(origins);
        expect(h.providers.claude).toHaveBeenCalledOnce();
        expect(h.providers.claude).toHaveBeenCalledWith(expect.objectContaining({origin: sourceText, pageContext: ''}));
    });

    it('图片组合中的免费成员原样成功时保留线路统计，不误判为回退', async () => {
        const h = setup([services.freeTranslation, services.google]);
        h.providers.freeTranslation = vi.fn(async message => {
            reportTranslationRoute(message, {route: 'microsoft', outcome: 'success', durationMs: 1, chars: sourceText.length});
            return sourceText;
        });
        await expect(h.broker.translateWithCache(allowUnchangedTranslationResult({origin: sourceText}))).resolves.toBe(sourceText);
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0].routes).toEqual(['freeTranslation', 'microsoft']);
    });

    it('图片组合仍拒绝递归配置和成员取消，不把真实错误当作原样成功', async () => {
        const nested = setup([group]);
        await expect(nested.broker.translateWithCache(allowUnchangedTranslationResult({origin: sourceText})))
            .rejects.toThrow('没有可用的成员服务');
        expect(nested.providers[group]).not.toHaveBeenCalled();
        const h = setup();
        h.providers.google = vi.fn(async () => {throw new DOMException('provider cancelled', 'AbortError');});
        await expect(h.broker.translateWithCache(allowUnchangedTranslationResult({origin: sourceText})))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(h.providers.microsoft).not.toHaveBeenCalled();
    });

    it('AI 默认预算不覆盖组合成员超时，配置变更后回退仍沿用冻结的组合预算', async () => {
        vi.useFakeTimers();vi.setSystemTime(0);
        const h = setup([services.openai, services.google]);
        h.config.aiRequestTimeoutMs = 600_000;
        let firstSignal!: AbortSignal;
        h.providers.openai = vi.fn(async message => {
            expect(message.requestTimeoutMs).toBe(1_000);
            expect(getTranslationProviderConfig(message, h.config).aiRequestTimeoutMs).toBe(600_000);
            firstSignal = message.abortSignal as AbortSignal;
            return new Promise((_resolve, reject) => firstSignal.addEventListener('abort', () => reject(new Error('transport aborted')), {once: true}));
        });
        h.providers.google = vi.fn(async message => {
            expect(message.requestTimeoutMs).toBeLessThanOrEqual(1_000);
            const snapshot = getTranslationProviderConfig(message, h.config);
            expect(snapshot.aiRequestTimeoutMs).toBe(600_000);
            expect(snapshot.compositeTranslationProviders?.[0].timeoutMs).toBe(1_000);
            return translatedText;
        });
        const pending = h.broker.translateWithCache({origin: sourceText, useCache: false});
        await vi.advanceTimersByTimeAsync(0);
        h.config.aiRequestTimeoutMs = 10_000;
        h.config.compositeTranslationProviders[0].timeoutMs = 45_000;
        await vi.advanceTimersByTimeAsync(1_001);
        await expect(pending).resolves.toBe(translatedText);
        expect(firstSignal.aborted).toBe(true);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({routes: ['openai', 'google'], upstreamCalls: 2});
    });

    it('含 AI 的组合总预算仍为 45 秒，AI 的长等待默认不能延长整轮或启动下一成员', async () => {
        vi.useFakeTimers();vi.setSystemTime(0);
        const h = setup([services.openai, services.google]);
        h.config.aiRequestTimeoutMs = 600_000;
        h.config.compositeTranslationProviders[0].timeoutMs = 45_000;
        let signal!: AbortSignal;
        h.providers.openai = vi.fn(async message => {
            expect(message.requestTimeoutMs).toBe(45_000);
            signal = message.abortSignal as AbortSignal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('transport aborted')), {once: true}));
        });
        const settled = h.broker.translateWithCache({origin: sourceText, useCache: false}).catch(error => error);
        await vi.advanceTimersByTimeAsync(44_999);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(settled).resolves.toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(signal.aborted).toBe(true);
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, outcome: 'timeout'});
    });

    it('AI 长等待默认也不会覆盖组合取消所有权', async () => {
        vi.useFakeTimers();vi.setSystemTime(0);
        const h = setup([services.openai, services.google]);
        h.config.aiRequestTimeoutMs = 600_000;
        h.config.compositeTranslationProviders[0].timeoutMs = 45_000;
        const controller = new AbortController();
        let signal!: AbortSignal;
        h.providers.openai = vi.fn(async message => {
            signal = message.abortSignal as AbortSignal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('transport aborted')), {once: true}));
        });
        const settled = h.broker.translateWithCache(attachTranslationRequestControl({origin: sourceText, useCache: false},
            {signal: controller.signal, ownershipKey: 'composite-ai-timeout-cancel'})).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);controller.abort();await vi.advanceTimersByTimeAsync(0);
        await expect(settled).resolves.toMatchObject({name: 'AbortError'});
        expect(signal.aborted).toBe(true);expect(h.providers.google).not.toHaveBeenCalled();
    });

    it('顺序策略每个成功请求轮流首选下一成员，并在末尾回到第一项', async () => {
        const h = setup([services.google, services.microsoft, services.bilibili]);
        const attempted: string[] = [];
        for (const service of h.config.compositeTranslationProviders[0].services) {
            h.providers[service] = vi.fn(async () => {attempted.push(service); return translatedText;});
        }
        for (let index = 0; index < 4; index += 1) {
            await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        }
        expect(attempted).toEqual(['google', 'microsoft', 'bilibili', 'google']);
        expect(h.recordRequest.mock.calls.map(([event]) => event.routes)).toEqual([
            ['google'], ['microsoft'], ['bilibili'], ['google'],
        ]);
    });

    it('首选失败只推进当前请求的回退，下一请求仍按独立轮次从下一成员开始', async () => {
        const h = setup([services.google, services.microsoft, services.bilibili]);
        const attempted: string[] = [];
        let googleCalls = 0, microsoftCalls = 0, bilibiliCalls = 0;
        h.providers.google = vi.fn(async () => {
            attempted.push('google');
            if (++googleCalls === 1) throw new Error('first unavailable');
            return translatedText;
        });
        h.providers.microsoft = vi.fn(async () => {
            attempted.push('microsoft');
            if (++microsoftCalls === 2) throw new Error('second unavailable');
            return translatedText;
        });
        h.providers.bilibili = vi.fn(async () => {
            attempted.push('bilibili');
            if (++bilibiliCalls === 1) throw new Error('third unavailable');
            return translatedText;
        });
        for (let index = 0; index < 3; index += 1) {
            await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        }
        expect(attempted).toEqual(['google', 'microsoft', 'microsoft', 'bilibili', 'google', 'bilibili']);
        expect(h.recordRequest.mock.calls.map(([event]) => event.routes)).toEqual([
            ['google', 'microsoft'], ['microsoft', 'bilibili', 'google'], ['bilibili'],
        ]);
    });

    it('并发公开请求在任何成员响应前已经取得不同轮流起点', async () => {
        const h = setup([services.google, services.microsoft, services.bilibili]);
        const attempted: string[] = [];
        const complete: Array<() => void> = [];
        for (const service of h.config.compositeTranslationProviders[0].services) {
            h.providers[service] = vi.fn(async () => {
                attempted.push(service);
                return new Promise(resolve => complete.push(() => resolve(translatedText)));
            });
        }
        const requests = Array.from({length: 3}, () => h.broker.translateWithCache({origin: sourceText, useCache: false}));
        void Promise.all(requests).catch(() => undefined);
        await vi.waitFor(() => expect(attempted).toEqual(['google', 'microsoft', 'bilibili']));
        complete.forEach(resolve => resolve());
        await expect(Promise.all(requests)).resolves.toEqual([translatedText, translatedText, translatedText]);
    });

    it('单条和数组按公开请求轮流，数组拆成单条协议时保持同一成员', async () => {
        const h = setup([services.google, services.microsoft]);
        h.config.nativeBatchTranslationEnabled.microsoft = false;
        const attempted: Array<{service: string; origin: unknown}> = [];
        for (const service of [services.google, services.microsoft]) {
            h.providers[service] = vi.fn(async message => {
                attempted.push({service, origin: message.origin});
                return Array.isArray(message.origin) ? message.origin.map(() => translatedText) : translatedText;
            });
        }
        const origins = [sourceText, 'The second paragraph describes caching.'];
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        await expect(h.broker.translateWithCache({origin: origins, useCache: false})).resolves.toEqual([translatedText, translatedText]);
        await expect(h.broker.translateWithCache({origin: origins, useCache: false})).resolves.toEqual([translatedText, translatedText]);
        expect(attempted).toEqual([
            {service: 'google', origin: sourceText},
            {service: 'microsoft', origin: origins[0]},
            {service: 'microsoft', origin: origins[1]},
            {service: 'google', origin: origins},
        ]);
        expect(h.recordRequest.mock.calls.map(([event]) => event.routes)).toEqual([['google'], ['microsoft'], ['google']]);
    });

    it('同一原文的缓存命中也推进组合轮次，成员缓存仍各自复用', async () => {
        const h = setup();
        for (let index = 0; index < 4; index += 1) {
            await expect(h.broker.translateWithCache({origin: sourceText})).resolves.toBe(translatedText);
        }
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.providers.microsoft).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls.map(([event]) => [event.routes[0], event.source])).toEqual([
            ['google', 'network'], ['microsoft', 'network'], ['google', 'cache'], ['microsoft', 'cache'],
        ]);
    });

    it('智能策略从真实上游失败学习，下一次优先使用成功成员', async () => {
        const h = setup();
        Object.assign(h.config.compositeTranslationProviders[0], {strategy: 'smart'});
        h.providers.google = vi.fn(async () => {throw new Error('unavailable');});
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.providers.microsoft).toHaveBeenCalledTimes(2);
    });

    it('顺序失败回退仍用成员的冻结凭据、模型与 Thinking 设置', async () => {
        const h = setup([services.google, services.openai]);
        h.config.modelThinking.openai = {'gpt-4.1-mini': true};
        h.providers.google = vi.fn(async () => {
            h.config.token.openai = 'changed-during-request';
            h.config.model.openai = 'changed-model';
            h.config.compositeTranslationProviders[0].services.reverse();
            throw new Error('first member failed');
        });
        h.providers.openai = vi.fn(async message => {
            const snapshot = getTranslationProviderConfig(message, h.config);
            expect(snapshot.token.openai).toBe('fixture-composite-openai');
            expect(snapshot.model.openai).toBe('gpt-4.1-mini');
            expect(message.modelOverride).toBeUndefined();
            expect(message.thinkingOverride).toBe(true);
            expect(getTranslationRequestScheduler(message)?.identity).toEqual({
                service: 'openai', model: 'gpt-4.1-mini', quotaScope: expect.stringMatching(/^[a-f0-9]{64}$/u),
            });
            return translatedText;
        });
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false,
            modelOverride: 'group-model', thinkingOverride: false})).resolves.toBe(translatedText);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.providers.openai).toHaveBeenCalledOnce();
        expect(h.recordRequest).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, model: 'gpt-4.1-mini',
            upstreamCalls: 2, routes: ['google', 'openai'], outcome: 'success'});
    });

    it('显式数组按成员合批偏好原子返回，不继承组合的合批覆盖', async () => {
        const h = setup();
        h.config.nativeBatchTranslationEnabled.microsoft = false;
        h.providers.google = vi.fn(async () => {throw new Error('network unavailable');});
        h.providers.microsoft = vi.fn(async message => {
            expect(message.enableNativeBatch).toBe(false);
            expect(typeof message.origin).toBe('string');
            return `译文：${message.origin}`;
        });
        const origins = [sourceText, 'The second paragraph describes caching.'];
        await expect(h.broker.translateWithCache({origin: origins, enableNativeBatch: true, useCache: false}))
            .resolves.toEqual(origins.map(origin => `译文：${origin}`));
        expect(h.providers.microsoft).toHaveBeenCalledTimes(2);
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, mode: 'batch', segmentCount: 2, upstreamCalls: 3});
    });

    it('单条协议成员数组失败不发布部分缓存，下一轮使用其他成员后再轮回重试', async () => {
        const h = setup([services.claude, services.google]);
        h.config.token.claude = 'fixture-claude';
        h.providers.claude = vi.fn(async message => {
            expect(typeof message.origin).toBe('string');
            if (message.origin === 'The second paragraph describes caching.') throw new Error('second item failed');
            return translatedText;
        });
        h.providers.google = vi.fn(async message => (message.origin as string[]).map(() => translatedText));
        const origins = [sourceText, 'The second paragraph describes caching.'];
        await expect(h.broker.translateWithCache({origin: origins})).resolves.toEqual([translatedText, translatedText]);
        expect(h.providers.claude).toHaveBeenCalledTimes(2);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect([...h.cacheStore.keys()].some(key => JSON.parse(key).service === 'claude')).toBe(false);
        h.providers.claude = vi.fn(async message => {
            expect(typeof message.origin).toBe('string');
            return translatedText;
        });
        await expect(h.broker.translateWithCache({origin: origins})).resolves.toEqual([translatedText, translatedText]);
        expect(h.providers.claude).not.toHaveBeenCalled();
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[1][0]).toMatchObject({routes: ['google'], source: 'cache', upstreamCalls: 0});
        await expect(h.broker.translateWithCache({origin: origins})).resolves.toEqual([translatedText, translatedText]);
        expect(h.providers.claude).toHaveBeenCalledTimes(2);
    });

    it('缓存身份属于真实成员，同服务的直接请求复用组合成功译文', async () => {
        const h = setup([services.google]);
        await expect(h.broker.translateWithCache({origin: sourceText})).resolves.toBe(translatedText);
        await expect(h.broker.translateWithCache({origin: sourceText})).resolves.toBe(translatedText);
        await expect(h.broker.translateWithCache({origin: sourceText, serviceOverride: services.google})).resolves.toBe(translatedText);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.cacheKeys.mock.calls.every(([identity]) => identity.service === 'google')).toBe(true);
        expect(h.recordRequest.mock.calls[1][0]).toMatchObject({serviceId: group, source: 'cache', cachedSegments: 1, upstreamCalls: 0});
    });

    it('未配置密钥的成员在 provider 前跳过，继续调用可用机器服务', async () => {
        const h = setup([services.openai, services.google]);
        h.config.token.openai = '';
        h.config.apiKeys.openai = [];
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        expect(h.providers.openai).not.toHaveBeenCalled();
        expect(h.providers.google).toHaveBeenCalledOnce();
    });

    it('取消保留内部控制所有权，中止成员且不启动回退', async () => {
        const h = setup();
        const controller = new AbortController();
        let signal!: AbortSignal;
        h.providers.google = vi.fn(async message => {
            signal = message.abortSignal as AbortSignal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
                const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
            }, {once: true}));
        });
        const request = h.broker.translateWithCache(attachTranslationRequestControl({origin: sourceText, useCache: false},
            {signal: controller.signal, ownershipKey: 'composite-owner'}));
        const settled = request.catch(error => error);
        await vi.waitFor(() => expect(h.providers.google).toHaveBeenCalledOnce());
        controller.abort();
        await expect(settled).resolves.toMatchObject({name: 'AbortError'});
        expect(signal.aborted).toBe(true);
        expect(h.providers.microsoft).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({outcome: 'cancelled'});
    });

    it('单成员超时后可回退，每个新成员继承整组剩余预算', async () => {
        vi.useFakeTimers();
        const h = setup();
        let firstSignal!: AbortSignal;
        h.providers.google = vi.fn(async message => {
            firstSignal = message.abortSignal as AbortSignal;
            return new Promise((_resolve, reject) => firstSignal.addEventListener('abort', () => reject(new Error('transport aborted')), {once: true}));
        });
        const request = h.broker.translateWithCache({origin: sourceText, useCache: false, requestTimeoutMs: 2_500});
        await vi.advanceTimersByTimeAsync(1_001);
        await expect(request).resolves.toBe(translatedText);
        expect(firstSignal.aborted).toBe(true);
        expect(h.providers.microsoft).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 2});
    });

    it('受信外层剩余预算耗尽后不会给下一成员重新取得时间', async () => {
        vi.useFakeTimers();
        const h = setup();
        h.providers.google = vi.fn(async message => new Promise((_resolve, reject) =>
            (message.abortSignal as AbortSignal).addEventListener('abort', () => reject(new Error('transport aborted')), {once: true})));
        const request = h.broker.translateWithCache(markTranslationRemainingBudget({origin: sourceText, useCache: false, requestTimeoutMs: 40}));
        const settled = request.catch(error => error);
        await vi.advanceTimersByTimeAsync(41);
        await expect(settled).resolves.toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(h.providers.microsoft).not.toHaveBeenCalled();
    });

    it('回退到 AI 后才生成页面摘要，摘要与翻译用量归属真实成员', async () => {
        const h = setup([services.google, services.openai]);
        h.config.enableAIContext = true;
        h.providers.google = vi.fn(async () => {throw new Error('machine unavailable');});
        h.providers.openai = vi.fn(async message => {
            reportTranslationModelUsage(message, {usageAvailability: 'reported', totalTokens: 3});
            return message.summaryPrompt ? 'This page explains translation.' : translatedText;
        });
        await expect(h.broker.translateWithCache({origin: sourceText, pageContext: 'A page about translation services.', useCache: false}))
            .resolves.toBe(translatedText);
        expect(h.providers.openai).toHaveBeenCalledTimes(2);
        expect(h.recordUsage.mock.calls.flatMap(call => call[0]).map(event => [event.serviceId, event.purpose]))
            .toEqual([['openai', 'page-summary'], ['openai', 'translation']]);
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 3});
    });

    it('图片仅交给具备视觉传输的真实成员，内部图片 symbol 被保留', async () => {
        const h = setup([services.google, services.openai]);
        const image = 'data:image/png;base64,AAAA';
        h.providers.openai = vi.fn(async message => {
            expect(getTranslationImageInput(message)).toBe(image);
            return translatedText;
        });
        await expect(h.broker.translateWithCache(attachTranslationImageInput({origin: 'Transcribe the image.', useCache: false}, image)))
            .resolves.toBe(translatedText);
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.providers.openai).toHaveBeenCalledOnce();
        expect(h.cacheStore.size).toBe(0);
    });

    it('成员多 Key 轮换继续使用成员自己的 scheduler 和模型身份', async () => {
        const h = setup([services.openai]);
        h.config.apiKeys.openai = ['fixture-composite-key-one', 'fixture-composite-key-two'];
        h.config.token.openai = h.config.apiKeys.openai[0];
        const used: string[] = [];
        const quotaScopes: string[] = [];
        h.providers.openai = vi.fn(async message => {
            used.push(getTranslationProviderConfig(message, h.config).token.openai);
            const identity = getTranslationRequestScheduler(message)?.identity;
            expect(identity).toEqual({
                service: 'openai', model: 'gpt-4.1-mini', quotaScope: expect.stringMatching(/^[a-f0-9]{64}$/u),
            });
            quotaScopes.push(identity!.quotaScope!);
            if (used.length === 1) throw Object.assign(new Error('unauthorized'), {statusCode: 401});
            return translatedText;
        });
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).resolves.toBe(translatedText);
        expect(used).toEqual(h.config.apiKeys.openai);
        expect(new Set(quotaScopes).size).toBe(2);
    });

    it('成员两次回显原文仍失败时，回退到下一成员并拒绝缓存损坏译文', async () => {
        const h = setup();
        h.providers.google = vi.fn(async () => sourceText);
        await expect(h.broker.translateWithCache({origin: sourceText})).resolves.toBe(translatedText);
        expect(h.providers.google).toHaveBeenCalledTimes(2);
        expect(h.providers.microsoft).toHaveBeenCalledOnce();
        expect([...h.cacheStore.values()]).toEqual([translatedText]);
    });

    it('删除或空组合报明确配置错误，不调用任何成员', async () => {
        const h = setup();
        h.config.compositeTranslationProviders[0].services = [];
        await expect(h.broker.translateWithCache({origin: sourceText})).rejects.toThrow('添加至少一个服务');
        h.config.compositeTranslationProviders = [];
        await expect(h.broker.translateWithCache({origin: sourceText})).rejects.toThrow('已被删除');
        expect(h.providers.google).not.toHaveBeenCalled();
    });

    it('单条 AI 成员把数组中的旧泄漏缓存逐段无上下文恢复，保留冻结模型与取消所有权', async () => {
        const h = setup([services.claude]);
        h.config.token.claude = 'fixture-claude-before';
        h.config.model.claude = 'claude-sonnet-4-5';
        h.config.enableAIContext = true;
        const origins = ['Alpha', 'Beta'];
        const translations = ['阿尔法', '贝塔'];
        const context = 'Article heading';
        const pageContext = 'Page title: private reference material.';
        h.providers.claude = vi.fn(async message => {
            if (message.summaryPrompt) return 'Private article summary';
            expect(typeof message.origin).toBe('string');
            return message.origin === origins[0] ? translations[0] : translations[1];
        });
        await expect(h.broker.translateWithCache({origin: origins, context, pageContext})).resolves.toEqual(translations);
        const itemKeys = [...h.cacheStore.keys()].filter(key => JSON.parse(key).requestMode === 'batch');
        expect(itemKeys).toHaveLength(2);
        for (const key of itemKeys) h.cacheStore.set(key, '旧译文 <webpage_context>泄漏的私有参考</webpage_context>');
        const owner = new AbortController();
        const snapshots: unknown[] = [];
        h.recordRequest.mockClear();
        h.providers.claude = vi.fn(async message => {
            expect(message.summaryPrompt).toBeUndefined();
            expect(message.context).toBe('');
            expect(message.pageContext).toBe('');
            expect(message.abortSignal?.aborted).toBe(false);
            expect(getTranslationRequestScheduler(message)?.identity).toEqual({service: 'claude', model: 'claude-sonnet-4-5'});
            const snapshot = getTranslationProviderConfig(message, h.config);
            snapshots.push(snapshot);
            expect(snapshot.token.claude).toBe('fixture-claude-before');
            expect(snapshot.model.claude).toBe('claude-sonnet-4-5');
            h.config.token.claude = 'changed-during-recovery';
            h.config.model.claude = 'changed-model';
            return message.origin === origins[0] ? translations[0] : translations[1];
        });
        await expect(h.broker.translateWithCache(attachTranslationRequestControl({origin: origins, context, pageContext,
            modelOverride: 'group-model'}, {signal: owner.signal, ownershipKey: 'recover-cached-array'}))).resolves.toEqual(translations);
        expect(h.providers.claude).toHaveBeenCalledTimes(2);
        expect(snapshots[0]).toStrictEqual(snapshots[1]);
        expect(snapshots.every(snapshot => Object.isFrozen(snapshot))).toBe(true);
        expect(owner.signal.aborted).toBe(false);
        expect(itemKeys.map(key => h.cacheStore.get(key))).toEqual(translations);
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, model: 'claude-sonnet-4-5',
            mode: 'batch', upstreamCalls: 2, cachedSegments: 0, routes: ['claude'], outcome: 'success'});
    });

    it('受信旧配置中的递归成员不会派发，成功成员的内部线路统计仍归属于组合请求', async () => {
        const h = setup([services.freeTranslation]);
        h.config.compositeTranslationProviders[0].services = [group, 'composite:nested', services.freeTranslation];
        const owner = new AbortController();
        h.providers.freeTranslation = vi.fn(async message => {
            expect(message.abortSignal?.aborted).toBe(false);
            expect(message.modelOverride).toBeUndefined();
            expect(getTranslationRequestScheduler(message)?.identity?.service).toBe(services.freeTranslation);
            reportTranslationRoute(message, {route: 'microsoft', outcome: 'error', durationMs: 4, chars: sourceText.length});
            reportTranslationRoute(message, {route: 'google', outcome: 'success', durationMs: 7, chars: sourceText.length});
            return translatedText;
        });
        await expect(h.broker.translateWithCache(attachTranslationRequestControl({origin: sourceText, useCache: false,
            modelOverride: 'group-model'}, {signal: owner.signal, ownershipKey: 'trusted-recursive-members'}))).resolves.toBe(translatedText);
        expect(h.providers.freeTranslation).toHaveBeenCalledOnce();
        expect(owner.signal.aborted).toBe(false);
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 1, outcome: 'success',
            routes: ['freeTranslation', 'microsoft', 'google'], routeAttempts: [
                {route: 'freeTranslation', outcome: 'success'},
                {route: 'microsoft', outcome: 'error', durationMs: 4, chars: sourceText.length},
                {route: 'google', outcome: 'success', durationMs: 7, chars: sourceText.length},
            ]});
    });

    it('全为递归成员的受信组合明确失败，不递归调用或记录伪造的上游尝试', async () => {
        const h = setup();
        h.config.compositeTranslationProviders[0].services = [group, 'composite:nested'];
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false})).rejects.toThrow('组合翻译没有可用的成员服务');
        expect(h.providers.google).not.toHaveBeenCalled();
        expect(h.providers.microsoft).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 0, outcome: 'error'});
        expect(h.recordRequest.mock.calls[0][0]).not.toHaveProperty('routes');
        expect(h.cacheStore.size).toBe(0);
    });

    it('所有真实成员失败时返回最后供应商错误，回退仍消费最初的模型与凭据快照', async () => {
        const h = setup([services.google, services.openai]);
        const firstError = Object.assign(new Error('first member unavailable'), {statusCode: 503});
        const lastError = Object.assign(new Error('last member rate limited'), {statusCode: 429});
        h.providers.google = vi.fn(async () => {
            h.config.token.openai = 'changed-during-failure';
            h.config.model.openai = 'changed-model';
            throw firstError;
        });
        h.providers.openai = vi.fn(async message => {
            const snapshot = getTranslationProviderConfig(message, h.config);
            expect(snapshot.token.openai).toBe('fixture-composite-openai');
            expect(snapshot.model.openai).toBe('gpt-4.1-mini');
            expect(message.modelOverride).toBeUndefined();
            expect(getTranslationRequestScheduler(message)?.identity).toEqual({
                service: 'openai', model: 'gpt-4.1-mini', quotaScope: expect.stringMatching(/^[a-f0-9]{64}$/u),
            });
            throw lastError;
        });
        await expect(h.broker.translateWithCache({origin: sourceText, useCache: false, modelOverride: 'group-model'})).rejects.toBe(lastError);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.providers.openai).toHaveBeenCalledOnce();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 2, outcome: 'error',
            routes: ['google', 'openai'], routeAttempts: [
                {route: 'google', outcome: 'error'}, {route: 'openai', outcome: 'error'},
            ]});
        expect(h.cacheStore.size).toBe(0);
    });

    it('成员返回 AbortError 时保持取消身份并停止回退，内部已记录线路不会丢失', async () => {
        const h = setup();
        const owner = new AbortController();
        const cancellation = Object.assign(new Error('upstream cancelled'), {name: 'AbortError'});
        h.providers.google = vi.fn(async message => {
            reportTranslationRoute(message, {route: 'google-web', outcome: 'cancelled', durationMs: 3, chars: sourceText.length});
            throw cancellation;
        });
        await expect(h.broker.translateWithCache(attachTranslationRequestControl({origin: sourceText, useCache: false},
            {signal: owner.signal, ownershipKey: 'provider-abort'}))).rejects.toBe(cancellation);
        expect(owner.signal.aborted).toBe(false);
        expect(h.providers.google).toHaveBeenCalledOnce();
        expect(h.providers.microsoft).not.toHaveBeenCalled();
        expect(h.recordRequest.mock.calls[0][0]).toMatchObject({serviceId: group, upstreamCalls: 1, outcome: 'cancelled',
            routes: ['google-web'], routeAttempts: [{route: 'google-web', outcome: 'cancelled', durationMs: 3, chars: sourceText.length}]});
        expect(h.cacheStore.size).toBe(0);
    });
});
