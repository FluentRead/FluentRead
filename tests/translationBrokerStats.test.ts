import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTranslationBroker} from '@/src/services/translation/broker';
import type {TranslationBrokerDependencies} from '@/src/services/translation/types';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {
    attachTranslationImageInput,
    attachTranslationRequestControl,
    markTranslationRemainingBudget,
    reportTranslationRoute,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestStatsEvent} from '@/src/services/translation-stats/types';

const IMAGE = `data:image/png;base64,${Buffer.alloc(9, 1).toString('base64')}`;

function createConfig() {
    return {
        service: 'machine',
        maxConcurrentTranslations: 4,
        translationRequestsPerSecond: 0,
        translationRequestsPerMinute: 0,
        from: 'auto',
        to: 'zh-Hans',
        useCache: true,
        enableAIContext: false,
        model: {ai: 'ai-model'} as Record<string, string>,
        customModel: {} as Record<string, string>,
        token: {} as Record<string, string>,
        proxy: {} as Record<string, string>,
        custom: '',
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
}

interface Harness {
    translate: ReturnType<typeof createTranslationBroker>['translateWithCache'];
    provider: ReturnType<typeof vi.fn<(message: Record<string, unknown>) => Promise<unknown>>>;
    record: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    config: ReturnType<typeof createConfig>;
    advance: (ms: number) => void;
    events: () => TranslationRequestStatsEvent[];
}

function createHarness(overrides: Partial<TranslationBrokerDependencies> = {}): Harness {
    let clock = 10_000;
    const config = createConfig();
    const cache = new Map<string, string>();
    const provider = vi.fn(async (message: Record<string, unknown>): Promise<unknown> => (
        Array.isArray(message.origin) ? message.origin.map((value) => `译:${value}`) : `译:${String(message.origin)}`
    ));
    const record = vi.fn();
    const warn = vi.fn();
    const broker = createTranslationBroker({
        ready: Promise.resolve(),
        getConfig: () => config,
        providers: {machine: provider, ai: provider, other: provider, '': provider},
        cache: {
            get: async (key) => cache.get(key) ?? null,
            set: async (key, value) => {
                cache.set(key, value);
                return true;
            },
            clear: async () => cache.clear(),
            cleanup: async () => undefined,
        },
        serviceIds: {minimax: 'minimax', mimo: 'mimo'},
        serviceTypes: {
            machine: new Set(['machine', 'other']),
            isAI: (service) => service === 'ai',
            isAiSdk: () => false,
            isUseAIContext: () => false,
        },
        endpointResolver: {
            resolveOpenAICompatibleEndpoint: () => ({endpoint: ''}),
            getMimoEndpoint: () => '',
            minimaxEndpoints: {},
            aiSdkTransportProfile: 'test',
        },
        promptBuilder: {buildPageSummaryPrompt: (value) => value, buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: (override) => resolveTranslationLanguages(override, {sourceLanguage: config.from, targetLanguage: config.to}),
        resolveConfiguredModel: (selected, custom) => custom || selected || '',
        buildTranslationCacheKey: (identity) => JSON.stringify(identity),
        captureTranslationStatsGeneration: () => 4,
        recordTranslationRequest: record,
        logger: {warn},
        now: () => clock,
        ...overrides,
    });
    return {
        translate: broker.translateWithCache,
        provider,
        record,
        warn,
        config,
        advance: (ms) => {
            clock += ms;
        },
        events: () => record.mock.calls.map(([event]) => event as TranslationRequestStatsEvent),
    };
}

let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('翻译 broker 请求统计', () => {
    it('单条请求记录规模、服务耗时与结果字符，并在缓存命中时标记来源', async () => {
        harness.provider.mockImplementationOnce(async (message: Record<string, unknown>) => {
            harness.advance(250);
            return `译文:${String(message.origin)}`;
        });

        await expect(harness.translate({origin: 'Hello 世界'})).resolves.toBe('译文:Hello 世界');
        await expect(harness.translate({origin: 'Hello 世界'})).resolves.toBe('译文:Hello 世界');

        const [network, cached] = harness.events();
        expect(harness.record).toHaveBeenCalledTimes(2);
        expect(harness.record.mock.calls[0][1]).toBe(4);
        expect(network).toEqual({
            startedAt: 10_000,
            durationMs: 250,
            serviceId: 'machine',
            mode: 'single',
            segmentCount: 1,
            sourceChars: 8,
            sourceBytes: 12,
            resultChars: 11,
            source: 'network',
            cachedSegments: 0,
            upstreamCalls: 1,
            upstreamMs: 250,
            outcome: 'success',
        });
        expect(cached).toMatchObject({source: 'cache', cachedSegments: 1, upstreamCalls: 0, upstreamMs: 0, durationMs: 0});
        expect(JSON.stringify(harness.events())).not.toContain('Hello');
    });

    it('批量请求区分全部缓存、部分缓存和复用进行中的相同请求', async () => {
        await harness.translate({origin: ['a', 'b']});
        await harness.translate({origin: ['a', 'b']});
        await harness.translate({origin: ['a', 'c', 'd']});

        let release!: () => void;
        harness.provider.mockImplementationOnce((message: Record<string, unknown>) => new Promise((resolve) => {
            release = () => resolve((message.origin as string[]).map((value) => `译:${value}`));
        }));
        const owner = harness.translate({origin: ['x', 'y']});
        const waiter = harness.translate({origin: ['x', 'y']});
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        release();
        await Promise.all([owner, waiter]);

        expect(harness.events().map((event) => [event.mode, event.source, event.cachedSegments, event.segmentCount, event.resultChars]))
            .toEqual([
                ['batch', 'network', 0, 2, 6],
                ['batch', 'cache', 2, 2, 6],
                ['batch', 'partial', 1, 3, 9],
                ['batch', 'network', 0, 2, 6],
                ['batch', 'shared', 0, 2, 6],
            ]);
    });

    it('AI 服务记录实际请求模型，失败请求保留分类与状态码并继续抛出原错误', async () => {
        const failure = Object.assign(new Error('HTTP 429 rate limit'), {kind: 'rate-limit', statusCode: 429});
        harness.provider.mockImplementationOnce(async () => {
            harness.advance(40);
            throw failure;
        });

        await expect(harness.translate({origin: 'hi', serviceOverride: 'ai'})).rejects.toBe(failure);

        expect(harness.events()[0]).toMatchObject({
            serviceId: 'ai',
            model: 'ai-model',
            outcome: 'error',
            errorKind: 'rate-limit',
            statusCode: 429,
            upstreamCalls: 1,
            upstreamMs: 40,
            durationMs: 40,
        });
        expect(harness.events()[0]).not.toHaveProperty('resultChars');
    });

    it('超时和取消分别记录结果，取消不附带失败原因', async () => {
        harness.provider.mockImplementationOnce(() => new Promise(() => undefined));
        await expect(harness.translate(markTranslationRemainingBudget({origin: 'slow', requestTimeoutMs: 5}))).rejects.toThrow('翻译请求超时');

        const controller = new AbortController();
        harness.provider.mockImplementationOnce(() => new Promise(() => undefined));
        const cancelled = harness.translate(attachTranslationRequestControl({origin: 'stop'}, {signal: controller.signal, ownershipKey: 'tab-1'}));
        await vi.waitFor(() => expect(harness.provider).toHaveBeenCalledTimes(2));
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});

        const [timeout, aborted] = harness.events();
        expect(timeout).toMatchObject({outcome: 'timeout', errorKind: 'timeout', source: 'network'});
        expect(timeout).not.toHaveProperty('statusCode');
        expect(aborted).toMatchObject({outcome: 'cancelled', upstreamCalls: 1});
        expect(aborted).not.toHaveProperty('errorKind');
    });

    it('配置就绪前失败时依次回落到独立服务、默认服务和 unknown', async () => {
        const failed = createHarness({ready: Promise.reject(new Error('config unavailable'))});
        await expect(failed.translate({origin: 'a', serviceOverride: 'other'})).rejects.toThrow('config unavailable');
        await expect(failed.translate({origin: 'b'})).rejects.toThrow('config unavailable');
        failed.config.service = '';
        await expect(failed.translate({origin: 'c'})).rejects.toThrow('config unavailable');

        expect(failed.events().map((event) => [event.serviceId, event.outcome, event.errorKind])).toEqual([
            ['other', 'error', 'unknown'],
            ['machine', 'error', 'unknown'],
            ['unknown', 'error', 'unknown'],
        ]);
    });

    it('图片请求按图片模式计入解码字节，统计端口异常只告警', async () => {
        const imageRequest = attachTranslationImageInput({origin: 'caption'}, IMAGE);
        await expect(harness.translate(imageRequest)).rejects.toThrow('图片识别需要支持视觉输入的 AI 翻译服务');
        expect(harness.events()[0]).toMatchObject({mode: 'image', sourceChars: 7, sourceBytes: 7 + 9, outcome: 'error'});

        harness.record.mockImplementationOnce(() => {
            throw new Error('stats offline');
        });
        await expect(harness.translate({origin: 'still works'})).resolves.toBe('译:still works');
        expect(harness.warn).toHaveBeenCalledWith('[FluentRead] translation stats record failed:', expect.any(Error));
    });

    it('免费链的线路尝试按上限随请求事件上报，并保留去重后的线路标识', async () => {
        const attempts = [
            {route: 'microsoft', outcome: 'error' as const, durationMs: 900, chars: 5},
            {route: 'google', outcome: 'success' as const, durationMs: 250, chars: 5},
            {route: 'google', outcome: 'success' as const, durationMs: 150, chars: 4},
        ];
        harness.provider.mockImplementationOnce(async (message: Record<string, unknown>) => {
            for (const attempt of attempts) reportTranslationRoute(message, attempt);
            return '译:free';
        });

        await expect(harness.translate({origin: 'free chain', serviceOverride: 'other'})).resolves.toBe('译:free');

        const [event] = harness.events();
        expect(event.routes).toEqual(['microsoft', 'google']);
        expect(event.routeAttempts).toEqual(attempts);

        harness.provider.mockImplementationOnce(async (message: Record<string, unknown>) => {
            for (let index = 0; index < 250; index += 1) {
                reportTranslationRoute(message, {route: `route-${index}`, outcome: 'success', durationMs: -5, chars: 1});
            }
            return '译:capped';
        });
        await harness.translate({origin: 'capped chain', serviceOverride: 'other'});
        const capped = harness.events()[1];
        expect(capped.routeAttempts).toHaveLength(200);
        expect(capped.routes).toHaveLength(200);
        expect(capped.routeAttempts?.[0]).toEqual({route: 'route-0', outcome: 'success', durationMs: 0, chars: 1});
    });

    it('未注入统计端口时不采集，未注入代次捕获时使用 0', async () => {
        const silent = createHarness({recordTranslationRequest: undefined});
        silent.provider.mockImplementationOnce(async (message: Record<string, unknown>) => {
            reportTranslationRoute(message, {route: 'google', outcome: 'success', durationMs: 10, chars: 2});
            return '译:quiet';
        });
        await expect(silent.translate({origin: 'quiet'})).resolves.toBe('译:quiet');
        expect(silent.record).not.toHaveBeenCalled();

        const record = vi.fn();
        const noGeneration = createHarness({captureTranslationStatsGeneration: undefined, recordTranslationRequest: record});
        await noGeneration.translate({origin: 'zero'});
        expect(record).toHaveBeenCalledWith(expect.objectContaining({outcome: 'success'}), 0);
        await expect(noGeneration.translate({origin: []})).resolves.toEqual([]);
        await expect(noGeneration.translate({origin: '   '})).resolves.toBe('   ');
        expect(record).toHaveBeenCalledTimes(1);
    });
});
