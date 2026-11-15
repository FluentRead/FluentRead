import {describe, expect, it} from 'vitest';
import {
    aggregateModelUsageTotals,
    requestOutputTokensPerSecond,
    buildModelUsageDashboard,
    collectModelUsageDimensions,
    getModelUsageRangeStart,
    normalizeModelUsageFilter,
} from '@/src/services/model-usage/aggregation';
import {createNextCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';

function inTimezone<T>(timezone: string, run: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
}

function event(overrides: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
    return {
        id: overrides.id,
        startedAt: overrides.startedAt ?? new Date(2026, 7, 29, 9).getTime(),
        durationMs: overrides.durationMs ?? 320,
        serviceId: overrides.serviceId ?? 'moonshot',
        configuredModel: overrides.configuredModel ?? 'kimi-k2.6',
        actualModel: overrides.actualModel,
        purpose: overrides.purpose ?? 'translation',
        outcome: overrides.outcome ?? 'success',
        usageAvailability: overrides.usageAvailability ?? 'reported',
        inputTokens: overrides.inputTokens,
        outputTokens: overrides.outputTokens,
        totalTokens: overrides.totalTokens,
        cachedInputTokens: overrides.cachedInputTokens,
        cacheWriteTokens: overrides.cacheWriteTokens,
        reasoningTokens: overrides.reasoningTokens,
        statusCode: overrides.statusCode,
    };
}

describe('模型用量纯聚合', () => {
    it.each([undefined,null,'100',NaN,Infinity,-1])('does not coerce an invalid duration %j into latency or output speed', durationMs => {
        const totals=aggregateModelUsageTotals([{...event({outputTokens:10}),durationMs} as ModelUsageEvent]);
        expect(totals).toMatchObject({requestCount:1,averageDurationMs:0,outputTokensPerSecond:null,speedReportedRequests:0});
    });
    it.each([null, 0, 123])('已有记录起点 %s 时不扫描被筛除调用的起点', recordingStartedAt => {
        const now = new Date(2026, 7, 29, 12).getTime(); let timestampReads = 0;
        const events = Array.from({length: 200}, (_, index) => ({...event({serviceId: 'excluded'}),
            get startedAt() {timestampReads++; return now - index;}}));
        const snapshot = buildModelUsageDashboard(events, {serviceId: 'selected'}, {now, recordingStartedAt, dimensions: []});
        expect(snapshot.recordingStartedAt).toBe(recordingStartedAt);
        expect(snapshot.selected.totals.requestCount).toBe(0);
        expect(timestampReads).toBe(0);
    });
    it('纯聚合大量调用时逐项计算记录起点，不依赖引擎的函数实参数量上限', () => {
        const now = new Date(2026, 7, 29, 12).getTime(), row = event({serviceId: 'excluded', startedAt: now - 1_000});
        const events = Array<ModelUsageEvent>(180_000).fill(row); events[100] = {...row, startedAt: now - 3_000};
        const snapshot = buildModelUsageDashboard(events, {serviceId: 'selected'}, {now, dimensions: []});
        expect(snapshot.recordingStartedAt).toBe(now - 3_000);
        expect(snapshot.selected.totals.requestCount).toBe(0);
    });
    it('只把 provider 明确报告的调用计入平均 Token，并把所有非成功结果计为失败', () => {
        const totals = aggregateModelUsageTotals([
            event({
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                cachedInputTokens: 10,
                cacheWriteTokens: 5,
                reasoningTokens: 4,
            }),
            event({
                outcome: 'error',
                usageAvailability: 'unreported',
                inputTokens: undefined,
                outputTokens: undefined,
                totalTokens: undefined,
            }),
            event({
                outcome: 'cancelled',
                usageAvailability: 'malformed',
                totalTokens: undefined,
            }),
        ]);

        expect(totals).toEqual({
            requestCount: 3,
            successfulRequests: 1,
            failedRequests: 2,
            errorRequests: 1,
            timeoutRequests: 0,
            cancelledRequests: 1,
            reportedTokenRequests: 1,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 10,
            cacheWriteTokens: 5,
            cacheReportedRequests: 1,
            cacheHitRequests: 1,
            cacheEligibleInputTokens: 100,
            cacheEligibleOutputTokens: 20,
            cacheTokenHitRate: 0.1,
            cacheRequestHitRate: 1,
            cacheCoverageRate: 1,
            reasoningTokens: 4,
            outputTokensPerSecond: 62.5,
            speedReportedRequests: 1,
            averageDurationMs: 320,
            averageTokensPerReportedRequest: 120,
            averageInputTokensPerReportedRequest: 100,
            averageOutputTokensPerReportedRequest: 20,
            averageUncachedInputTokensPerCacheReportedRequest: 90,
            averageCachedInputTokensPerCacheReportedRequest: 10,
            averageOutputTokensPerCacheReportedRequest: 20,
            uncachedInputTokenShare: 0.75,
            cachedInputTokenShare: 1 / 12,
            outputTokenShare: 1 / 6,
        });
        expect(aggregateModelUsageTotals([event({usageAvailability: 'unreported'})])
            .averageTokensPerReportedRequest).toBeNull();
        expect(aggregateModelUsageTotals([event({usageAvailability: 'unreported'})])
            .averageInputTokensPerReportedRequest).toBeNull();
        expect(aggregateModelUsageTotals([event({usageAvailability: 'unreported'})])
            .averageOutputTokensPerReportedRequest).toBeNull();

        const invalid = aggregateModelUsageTotals([event({
            inputTokens: Number.NaN,
            outputTokens: -1,
            totalTokens: 1.5,
            cachedInputTokens: Number.MAX_SAFE_INTEGER + 1,
            reasoningTokens: undefined,
        })]);
        expect(invalid).toMatchObject({
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
        });
    });

    it('分别计算每个已报告请求的平均输入和平均输出 Token', () => {
        const totals = aggregateModelUsageTotals([
            event({inputTokens: 80, outputTokens: 20, totalTokens: 100}),
            event({inputTokens: 40, outputTokens: 10, totalTokens: 50}),
            event({
                outcome: 'error',
                usageAvailability: 'unreported',
                inputTokens: undefined,
                outputTokens: undefined,
                totalTokens: undefined,
            }),
        ]);

        expect(totals).toMatchObject({
            requestCount: 3,
            reportedTokenRequests: 2,
            averageTokensPerReportedRequest: 75,
            averageInputTokensPerReportedRequest: 60,
            averageOutputTokensPerReportedRequest: 15,
        });
    });

    it('只用明确上报缓存读取明细的输入计算 Token 与请求命中率，并保留未知覆盖', () => {
        const totals = aggregateModelUsageTotals([
            event({inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 40, cacheWriteTokens: 5}),
            event({inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedInputTokens: 0, cacheWriteTokens: 8}),
            event({inputTokens: 200, outputTokens: 20, totalTokens: 220, cachedInputTokens: undefined}),
            event({usageAvailability: 'unreported', inputTokens: undefined, outputTokens: undefined, totalTokens: undefined}),
        ]);

        expect(totals).toMatchObject({
            cachedInputTokens: 40,
            cacheWriteTokens: 13,
            cacheReportedRequests: 2,
            cacheHitRequests: 1,
            cacheEligibleInputTokens: 150,
            cacheEligibleOutputTokens: 15,
            cacheTokenHitRate: 40 / 150,
            cacheRequestHitRate: 0.5,
            cacheCoverageRate: 2 / 3,
            averageUncachedInputTokensPerCacheReportedRequest: 55,
            averageCachedInputTokensPerCacheReportedRequest: 20,
            averageOutputTokensPerCacheReportedRequest: 7.5,
            uncachedInputTokenShare: 110 / 165,
            cachedInputTokenShare: 40 / 165,
            outputTokenShare: 15 / 165,
        });
        expect(aggregateModelUsageTotals([
            event({inputTokens: 2, cachedInputTokens: 3}),
        ])).toMatchObject({
            cacheReportedRequests: 0,
            cacheTokenHitRate: null,
            averageUncachedInputTokensPerCacheReportedRequest: null,
        });
        expect(aggregateModelUsageTotals([
            event({inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0}),
        ])).toMatchObject({
            averageUncachedInputTokensPerCacheReportedRequest: 0,
            averageCachedInputTokensPerCacheReportedRequest: 0,
            averageOutputTokensPerCacheReportedRequest: 0,
            uncachedInputTokenShare: null,
            cachedInputTokenShare: null,
            outputTokenShare: null,
        });
    });

    it('按总 Token 排列服务模型分布，并以输入输出作为稳定排序依据', () => {
        const snapshot = buildModelUsageDashboard([
            event({serviceId: 'moonshot', configuredModel: 'kimi-k2.6', inputTokens: 120, outputTokens: 80, totalTokens: 200}),
            event({serviceId: 'openai', configuredModel: 'gpt-5.6-luna', inputTokens: 150, outputTokens: 50, totalTokens: 200}),
            event({serviceId: 'deepseek', configuredModel: 'deepseek-chat', inputTokens: 20, outputTokens: 10, totalTokens: 30}),
        ], {range: '30d'}, {now: new Date(2026, 7, 29, 12).getTime()});

        expect(snapshot.breakdown.map(({serviceId, model}) => [serviceId, model])).toEqual([
            ['openai', 'gpt-5.6-luna'],
            ['moonshot', 'kimi-k2.6'],
            ['deepseek', 'deepseek-chat'],
        ]);
        expect(snapshot.breakdown[0]?.totals).toMatchObject({
            inputTokens: 150,
            outputTokens: 50,
            totalTokens: 200,
        });
    });

    it('删除自定义服务后新建身份不会继承同模型的旧用量', () => {
        const retiredServiceId = 'custom:retired-profile';
        const replacementServiceId = createNextCustomOpenAIProviderId([], () => 'replacement-profile');
        const snapshot = buildModelUsageDashboard([
            event({
                serviceId: retiredServiceId,
                configuredModel: 'shared-model',
                inputTokens: 70,
                outputTokens: 30,
                totalTokens: 100,
            }),
            event({
                serviceId: replacementServiceId,
                configuredModel: 'shared-model',
                inputTokens: 15,
                outputTokens: 5,
                totalTokens: 20,
            }),
        ], {range: '30d'}, {now: new Date(2026, 7, 29, 12).getTime()});

        expect(replacementServiceId).not.toBe(retiredServiceId);
        expect(snapshot.breakdown.map(({serviceId, totals}) => [serviceId, totals.totalTokens])).toEqual([
            [retiredServiceId, 100],
            [replacementServiceId, 20],
        ]);
    });

    it('按本地午夜计算 today，并生成完整二十四小时时间线', () => {
        const now = new Date(2026, 7, 29, 15, 30).getTime();
        const today = new Date(2026, 7, 29, 0, 0).getTime();
        const previousMinute = new Date(2026, 7, 28, 23, 59).getTime();
        const snapshot = buildModelUsageDashboard([
            event({startedAt: new Date(2026, 7, 29, 9, 20).getTime(), totalTokens: 12}),
            event({startedAt: previousMinute, totalTokens: 99}),
        ], {range: 'today'}, {now});

        expect(getModelUsageRangeStart('today', now)).toBe(today);
        expect(snapshot.selected.totals.requestCount).toBe(1);
        expect(snapshot.metrics.today.totalTokens).toBe(12);
        expect(snapshot.timeline).toHaveLength(24);
        expect(snapshot.timeline[9]).toMatchObject({label: '09:00', startedAt: new Date(2026, 7, 29, 9).getTime()});
        expect(snapshot.timeline[9].totals.requestCount).toBe(1);
        expect(snapshot.timeline[8].totals.requestCount).toBe(0);
    });

    it('按真实 epoch 小时生成夏令时切换日的 23/25 个唯一时间桶', () => {
        inTimezone('America/New_York', () => {
            const springNow = new Date(2026, 2, 8, 12).getTime();
            const spring = buildModelUsageDashboard([
                event({startedAt: new Date(2026, 2, 8, 3, 15).getTime(), totalTokens: 13}),
            ], {range: 'today'}, {now: springNow});

            expect(spring.timeline).toHaveLength(23);
            expect(new Set(spring.timeline.map((point) => point.key)).size).toBe(23);
            expect(spring.timeline.map((point) => point.label)).not.toContain('02:00');
            expect(spring.timeline.filter((point) => point.label === '03:00')).toHaveLength(1);
            expect(spring.timeline.find((point) => point.label === '03:00')?.totals.totalTokens).toBe(13);
            expect(spring.timeline.reduce((sum, point) => sum + point.totals.totalTokens, 0))
                .toBe(spring.selected.totals.totalTokens);

            const firstRepeatedHour = new Date(2026, 10, 1, 1, 15).getTime();
            const fallNow = new Date(2026, 10, 1, 12).getTime();
            const fall = buildModelUsageDashboard([
                event({startedAt: firstRepeatedHour, totalTokens: 11}),
                event({startedAt: firstRepeatedHour + 60 * 60 * 1000, totalTokens: 17}),
            ], {range: 'today'}, {now: fallNow});

            expect(fall.timeline).toHaveLength(25);
            expect(new Set(fall.timeline.map((point) => point.key)).size).toBe(25);
            expect(fall.timeline.filter((point) => point.label === '01:00')).toHaveLength(2);
            expect(fall.timeline
                .filter((point) => point.label === '01:00')
                .map((point) => point.totals.totalTokens)).toEqual([11, 17]);
            expect(fall.timeline.reduce((sum, point) => sum + point.totals.totalTokens, 0))
                .toBe(fall.selected.totals.totalTokens);
        });
    });

    it('七日和三十日均包含当天，筛选同时作用于指标、时间线和分组', () => {
        const now = new Date(2026, 7, 29, 12).getTime();
        const daysAgo = (days: number, hour = 10) => new Date(2026, 7, 29 - days, hour).getTime();
        const events = [
            event({startedAt: daysAgo(0), serviceId: 'moonshot', configuredModel: 'kimi-k2.6', totalTokens: 10}),
            event({startedAt: daysAgo(0), serviceId: 'moonshot', configuredModel: 'kimi-k3', totalTokens: 80}),
            event({startedAt: daysAgo(6), serviceId: 'moonshot', configuredModel: 'kimi-k2.6', totalTokens: 20}),
            event({startedAt: daysAgo(7), serviceId: 'moonshot', configuredModel: 'kimi-k2.6', totalTokens: 30}),
            event({startedAt: daysAgo(29), serviceId: 'moonshot', configuredModel: 'kimi-k2.6', totalTokens: 40}),
            event({startedAt: daysAgo(0), serviceId: 'openai', configuredModel: 'gpt-5-mini', totalTokens: 50}),
        ];
        const snapshot = buildModelUsageDashboard(events, {
            range: '7d',
            serviceId: 'moonshot',
            model: 'kimi-k2.6',
        }, {now});

        expect(snapshot.metrics.today.requestCount).toBe(1);
        expect(snapshot.metrics.sevenDays.totalTokens).toBe(30);
        expect(snapshot.metrics.thirtyDays.totalTokens).toBe(100);
        expect(snapshot.selected.totals.totalTokens).toBe(30);
        expect(snapshot.timeline).toHaveLength(7);
        expect(snapshot.timeline.reduce((sum, point) => sum + point.totals.requestCount, 0)).toBe(2);
        expect(snapshot.breakdown).toEqual([expect.objectContaining({
            serviceId: 'moonshot',
            model: 'kimi-k2.6',
        })]);
    });

    it('维度优先使用实际响应模型，并稳定排序服务与模型', () => {
        const dimensions = collectModelUsageDimensions([
            event({serviceId: 'openai', configuredModel: 'configured', actualModel: 'gpt-5-mini'}),
            event({serviceId: 'moonshot', configuredModel: 'kimi-k3'}),
            event({serviceId: 'openai', configuredModel: 'configured', actualModel: 'gpt-5.6-luna'}),
            {...event({serviceId: 'stored', configuredModel: 'configured'}), id: 'stored', schemaVersion: 1, model: 'stored-model'},
            event({serviceId: 'custom', configuredModel: ''}),
            event({serviceId: '   ', configuredModel: 'ignored'}),
        ]);

        expect(dimensions).toEqual([
            {serviceId: 'custom', models: ['unknown']},
            {serviceId: 'moonshot', models: ['kimi-k3']},
            {serviceId: 'openai', models: ['gpt-5-mini', 'gpt-5.6-luna']},
            {serviceId: 'stored', models: ['stored-model']},
        ]);
        expect(normalizeModelUsageFilter({range: '7d', serviceId: '  moonshot ', model: ' kimi-k3 '}))
            .toEqual({range: '7d', serviceId: 'moonshot', model: 'kimi-k3'});
        expect(normalizeModelUsageFilter({range: undefined})).toEqual({range: '30d'});
        expect(normalizeModelUsageFilter({
            range: 'invalid' as never,
            serviceId: 42 as never,
            model: '   ',
        })).toEqual({range: '30d'});
    });

    it('空快照使用当前时间与三十日日线，breakdown 排序覆盖请求数、服务和模型', () => {
        const before = Date.now();
        const empty = buildModelUsageDashboard([]);
        expect(empty.generatedAt).toBeGreaterThanOrEqual(before);
        expect(empty.recordingStartedAt).toBeNull();
        expect(empty.timeline).toHaveLength(30);

        const providedMetadata = buildModelUsageDashboard([], {}, {
            now: before,
            recordingStartedAt: 123,
            dimensions: [{serviceId: 'moonshot', models: ['kimi-k2.6']}],
        });
        expect(providedMetadata.recordingStartedAt).toBe(123);
        expect(providedMetadata.dimensions).toEqual([{serviceId: 'moonshot', models: ['kimi-k2.6']}]);

        const now = new Date(2026, 7, 29, 12).getTime();
        const populated = buildModelUsageDashboard([
            event({startedAt: now - 1_000, serviceId: 'b', configuredModel: 'z'}),
            event({startedAt: now - 2_000, serviceId: 'b', configuredModel: 'z'}),
            event({startedAt: now - 3_000, serviceId: 'a', configuredModel: 'y'}),
            event({startedAt: now - 4_000, serviceId: 'a', configuredModel: 'x'}),
        ], {range: '30d'}, {now});
        expect(populated.breakdown.map(({serviceId, model}) => `${serviceId}/${model}`)).toEqual([
            'b/z',
            'a/x',
            'a/y',
        ]);
    });
});

describe('输出速度统计', () => {
    it('按同一组成功请求的总输出除以总耗时，排除失败及缺失数据', () => {
        const totals = aggregateModelUsageTotals([
            event({outputTokens: 100, durationMs: 1000}),
            event({outputTokens: 100, durationMs: 3000}),
            event({outputTokens: 900, durationMs: 1000, outcome: 'error'}),
            event({durationMs: 5000}),
            event({outputTokens: 700, durationMs: 1000, usageAvailability: 'unreported'}),
            event({outputTokens: 100, durationMs: 0}),
        ]);
        expect(totals.outputTokensPerSecond).toBe(50);
        expect(totals.speedReportedRequests).toBe(2);
        expect(aggregateModelUsageTotals([]).outputTokensPerSecond).toBeNull();
        expect(requestOutputTokensPerSecond(event({outputTokens: 0}))).toBe(0);
    });
    it('缺失、负数和非有限数不会形成虚假速度', () => {
        for (const overrides of [
            {outputTokens: undefined}, {outputTokens: -1}, {outputTokens: Infinity},
            {outputTokens: 0.5}, {outputTokens: NaN}, {durationMs: 0},
            {durationMs: -1}, {durationMs: Infinity}, {durationMs: NaN},
            {durationMs: Number.MIN_VALUE}, {outcome: 'cancelled' as const},
            {outcome: 'timeout' as const}, {usageAvailability: 'malformed' as const},
        ]) expect(requestOutputTokensPerSecond(event({outputTokens: 10, ...overrides}))).toBeNull();
    });
});
