import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    aggregateTranslationRouteTotals,
    aggregateTranslationStatsTotals,
    buildTranslationRouteBreakdown,
    createTranslationRouteRollup,
    emptyTranslationRouteTotals,
    foldTranslationRouteAttempt,
    buildTranslationStatsSnapshot,
    collectTranslationStatsDimensions,
    createTranslationStatsRollup,
    emptyTranslationStatsTotals,
    estimateHistogramPercentile,
    foldTranslationRequestEvent,
    getTranslationStatsRangeStart,
    histogramIndex,
    isTranslationLatencySample,
    localDayStart,
    localHourBucketStart,
    normalizeTranslationStatsFilter,
    shiftLocalDays,
    translationStatsRollupKey,
} from '@/src/services/translation-stats/aggregation';
import {
    TRANSLATION_STATS_DURATION_BOUNDS_MS,
    TRANSLATION_STATS_SIZE_BOUNDS_CHARS,
    type TranslationRequestStatsEvent,
    type TranslationRouteAttempt,
    type TranslationRouteRollup,
    type TranslationStatsRollup,
} from '@/src/services/translation-stats/types';

const NOW = new Date(2026, 8, 16, 15, 20).getTime();
const HOUR = 60 * 60 * 1000;

function requestEvent(overrides: Partial<TranslationRequestStatsEvent> = {}): TranslationRequestStatsEvent {
    return {
        startedAt: new Date(2026, 8, 16, 10, 15).getTime(),
        durationMs: 600,
        serviceId: 'microsoft',
        mode: 'batch',
        segmentCount: 4,
        sourceChars: 320,
        sourceBytes: 400,
        resultChars: 300,
        source: 'network',
        cachedSegments: 0,
        upstreamCalls: 1,
        upstreamMs: 500,
        outcome: 'success',
        ...overrides,
    };
}

function rollupOf(events: TranslationRequestStatsEvent[]): TranslationStatsRollup {
    const [bucketStart, serviceId, model] = translationStatsRollupKey(events[0]);
    return events.reduce(foldTranslationRequestEvent, createTranslationStatsRollup(bucketStart, serviceId, model));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('翻译统计本地时间与筛选', () => {
    it('按本地零点切日与小时桶，并计算三种时间范围的起点', () => {
        const timestamp = new Date(2026, 8, 16, 10, 45, 12).getTime();

        expect(localDayStart(timestamp)).toBe(new Date(2026, 8, 16).getTime());
        expect(shiftLocalDays(timestamp, -6)).toBe(new Date(2026, 8, 10).getTime());
        expect(localHourBucketStart(timestamp)).toBe(new Date(2026, 8, 16, 10).getTime());
        expect(getTranslationStatsRangeStart('today', NOW)).toBe(new Date(2026, 8, 16).getTime());
        expect(getTranslationStatsRangeStart('7d', NOW)).toBe(new Date(2026, 8, 10).getTime());
        expect(getTranslationStatsRangeStart('30d', NOW)).toBe(new Date(2026, 7, 18).getTime());
    });

    it('筛选归一化回落到 7 天，模型筛选只在指定服务时保留（含机器翻译空模型）', () => {
        expect(normalizeTranslationStatsFilter()).toEqual({range: '7d'});
        expect(normalizeTranslationStatsFilter({range: 'year' as never, serviceId: '  ', model: 'x'})).toEqual({range: '7d'});
        expect(normalizeTranslationStatsFilter({range: 'today', model: 'gpt'})).toEqual({range: 'today'});
        expect(normalizeTranslationStatsFilter({range: '30d', serviceId: ' openai ', model: ' gpt-5 '}))
            .toEqual({range: '30d', serviceId: 'openai', model: 'gpt-5'});
        expect(normalizeTranslationStatsFilter({range: '30d', serviceId: 'google', model: ''}))
            .toEqual({range: '30d', serviceId: 'google', model: ''});
    });
});

describe('翻译统计分桶与分位数', () => {
    it('分桶上界不含本身，超过全部上界落入最后一个桶', () => {
        expect(histogramIndex(0, TRANSLATION_STATS_DURATION_BOUNDS_MS)).toBe(0);
        expect(histogramIndex(100, TRANSLATION_STATS_DURATION_BOUNDS_MS)).toBe(1);
        expect(histogramIndex(999, TRANSLATION_STATS_DURATION_BOUNDS_MS)).toBe(3);
        expect(histogramIndex(45_000, TRANSLATION_STATS_DURATION_BOUNDS_MS)).toBe(TRANSLATION_STATS_DURATION_BOUNDS_MS.length);
    });

    it('按分桶线性插值估算中位数和 P95，并以最大值封顶', () => {
        const bounds = [100, 200, 400];

        expect(estimateHistogramPercentile([0, 0, 0, 0], bounds, 0.5, 0)).toBeNull();
        expect(estimateHistogramPercentile([2, 0, 0, 0], bounds, 0.5, 90)).toBe(50);
        expect(estimateHistogramPercentile([2, 0, 0, 0], bounds, 0.95, 60)).toBe(60);
        expect(estimateHistogramPercentile([1, 0, 3, 0], bounds, 0.5, 390)).toBeCloseTo(266.67, 1);
        expect(estimateHistogramPercentile([0, 0, 0, 4], bounds, 0.5, 1_000)).toBe(700);
        expect(estimateHistogramPercentile([0, 0, 0, 1], bounds, 1, 300)).toBe(300);
        expect(estimateHistogramPercentile([4, 0, 0, 0], bounds, -1, 80)).toBe(0);
        expect(estimateHistogramPercentile([4, 0, 0, 0], bounds, 2, 80)).toBe(80);
    });
});

describe('翻译统计事件折叠与汇总', () => {
    it('只有成功且实际请求服务的请求进入耗时样本', () => {
        expect(isTranslationLatencySample({outcome: 'success', source: 'network'})).toBe(true);
        expect(isTranslationLatencySample({outcome: 'success', source: 'partial'})).toBe(true);
        expect(isTranslationLatencySample({outcome: 'success', source: 'cache'})).toBe(false);
        expect(isTranslationLatencySample({outcome: 'success', source: 'shared'})).toBe(false);
        expect(isTranslationLatencySample({outcome: 'timeout', source: 'network'})).toBe(false);
    });

    it('折叠返回新汇总行，累计结果、来源、失败原因、规模和耗时分布', () => {
        const base = createTranslationStatsRollup(1, 'openai', 'gpt');
        const folded = [
            requestEvent({serviceId: 'openai', model: 'gpt', durationMs: 1_200, upstreamMs: 1_500}),
            requestEvent({serviceId: 'openai', model: 'gpt', source: 'cache', cachedSegments: 4, durationMs: 3, upstreamCalls: 0, upstreamMs: 0}),
            requestEvent({serviceId: 'openai', model: 'gpt', source: 'shared', segmentCount: 2, durationMs: 90, upstreamCalls: 0, upstreamMs: 0}),
            requestEvent({serviceId: 'openai', model: 'gpt', outcome: 'error', errorKind: 'rate-limit', resultChars: undefined, sourceChars: 6_000}),
            requestEvent({serviceId: 'openai', model: 'gpt', outcome: 'cancelled', resultChars: undefined, sourceChars: 10}),
        ].reduce(foldTranslationRequestEvent, base);

        expect(base.requestCount).toBe(0);
        expect(folded).toMatchObject({
            requestCount: 5,
            outcomes: {success: 3, error: 1, timeout: 0, cancelled: 1},
            sources: {network: 3, cache: 1, partial: 0, shared: 1},
            errorKinds: {'rate-limit': 1, unknown: 0},
            segmentCount: 18,
            cachedSegments: 4,
            sharedSegments: 2,
            sourceChars: 320 * 3 + 6_000 + 10,
            resultChars: 900,
            maxSourceChars: 6_000,
            upstreamCalls: 3,
            latencyCount: 1,
            latencyDurationMs: 1_200,
            latencyMaxDurationMs: 1_200,
            latencyUpstreamMs: 1_200,
            latencySourceChars: 320,
        });
        expect(folded.durationHistogram[histogramIndex(1_200, TRANSLATION_STATS_DURATION_BOUNDS_MS)]).toBe(1);
        expect(folded.sizeHistogram.reduce((sum, count) => sum + count, 0)).toBe(5);
        expect(folded.sizeHistogram[TRANSLATION_STATS_SIZE_BOUNDS_CHARS.length]).toBe(1);
        expect(translationStatsRollupKey({startedAt: NOW, serviceId: 'google'})).toEqual([new Date(2026, 8, 16, 15).getTime(), 'google', '']);
    });

    it('空汇总返回缺失指标，非空汇总计算成功率、复用率、平均规模、耗时分位与速度', () => {
        expect(aggregateTranslationStatsTotals([])).toEqual(emptyTranslationStatsTotals());

        const totals = aggregateTranslationStatsTotals([
            rollupOf([
                requestEvent({durationMs: 400, upstreamMs: 300}),
                requestEvent({durationMs: 1_600, upstreamMs: 1_400, sourceChars: 800}),
                requestEvent({source: 'partial', cachedSegments: 2, durationMs: 2_000, upstreamMs: 1_000}),
                requestEvent({outcome: 'timeout', errorKind: 'timeout', durationMs: 45_000, resultChars: undefined}),
            ]),
            rollupOf([requestEvent({source: 'cache', cachedSegments: 4, durationMs: 2, upstreamCalls: 0, upstreamMs: 0})]),
        ]);

        expect(totals.requestCount).toBe(5);
        expect(totals.successRate).toBeCloseTo(4 / 5);
        expect(totals.reuseRate).toBeCloseTo(6 / 20);
        expect(totals.averageSourceChars).toBe((320 * 4 + 800) / 5);
        expect(totals.averageSegments).toBe(4);
        expect(totals.latencyCount).toBe(3);
        expect(totals.averageDurationMs).toBe(4_000 / 3);
        expect(totals.maxDurationMs).toBe(2_000);
        expect(totals.averageUpstreamMs).toBe(2_700 / 3);
        expect(totals.medianDurationMs).toBeGreaterThanOrEqual(1_000);
        expect(totals.p95DurationMs).toBeLessThanOrEqual(2_000);
        expect(totals.charsPerSecond).toBeCloseTo((320 + 800 + 320) / 4_000 * 1_000);
        expect(totals.errorKinds.timeout).toBe(1);
    });

    it('耗时总和为 0 时不计算处理速度，缺失的历史字段按 0 合并', () => {
        const instant = rollupOf([requestEvent({durationMs: 0, upstreamMs: 0})]);
        const legacy = {
            ...rollupOf([requestEvent({outcome: 'cancelled', resultChars: undefined})]),
            outcomes: {success: 0} as TranslationStatsRollup['outcomes'],
            sizeHistogram: [1],
            durationHistogram: [],
        };
        const totals = aggregateTranslationStatsTotals([instant, legacy]);

        expect(totals.latencyCount).toBe(1);
        expect(totals.charsPerSecond).toBeNull();
        expect(totals.averageDurationMs).toBe(0);
        expect(totals.outcomes).toEqual({success: 1, error: 0, timeout: 0, cancelled: 0});
        expect(totals.sizeHistogram.reduce((sum, count) => sum + count, 0)).toBe(2);
        expect(totals.successRate).toBe(1);
    });

    it('维度按服务与模型去重排序', () => {
        expect(collectTranslationStatsDimensions([
            {serviceId: 'openai', model: 'gpt-b'},
            {serviceId: 'google', model: ''},
            {serviceId: 'openai', model: 'gpt-a'},
            {serviceId: 'openai', model: 'gpt-b'},
        ])).toEqual([
            {serviceId: 'google', models: ['']},
            {serviceId: 'openai', models: ['gpt-a', 'gpt-b']},
        ]);
    });
});

describe('免费线路尝试聚合', () => {
    const attempt = (overrides: Partial<TranslationRouteAttempt> = {}): TranslationRouteAttempt => ({
        route: 'microsoft', outcome: 'success', durationMs: 400, chars: 30, ...overrides,
    });
    const routeRollup = (route: string, attempts: TranslationRouteAttempt[], bucketStart = new Date(2026, 8, 16, 10).getTime()): TranslationRouteRollup => (
        attempts.reduce(foldTranslationRouteAttempt, createTranslationRouteRollup(bucketStart, 'freeTranslation', route))
    );

    it('折叠尝试时只有成功计入耗时，失败与取消仍计入尝试和成功率分母', () => {
        const base = createTranslationRouteRollup(1, 'freeTranslation', 'microsoft');
        const folded = [
            attempt({durationMs: 200, chars: 10}),
            attempt({outcome: 'error', durationMs: 900, chars: 40}),
            attempt({outcome: 'timeout', durationMs: 5_000, chars: 40}),
            attempt({outcome: 'cancelled', durationMs: 50, chars: 40}),
        ].reduce(foldTranslationRouteAttempt, base);

        expect(base.attemptCount).toBe(0);
        expect(folded).toMatchObject({
            attemptCount: 4,
            outcomes: {success: 1, error: 1, timeout: 1, cancelled: 1},
            chars: 130,
            maxChars: 40,
            latencyCount: 1,
            latencyDurationMs: 200,
            latencyMaxDurationMs: 200,
        });
        expect(folded.durationHistogram.reduce((sum, count) => sum + count, 0)).toBe(1);
    });

    it('线路汇总计算成功率、平均文本量与耗时分位，空输入返回缺失指标', () => {
        expect(aggregateTranslationRouteTotals([])).toEqual(emptyTranslationRouteTotals());

        const totals = aggregateTranslationRouteTotals([
            routeRollup('microsoft', [attempt({durationMs: 200}), attempt({durationMs: 600})]),
            routeRollup('microsoft', [attempt({outcome: 'error', durationMs: 1_000, chars: 60})], new Date(2026, 8, 16, 11).getTime()),
        ]);

        expect(totals.attemptCount).toBe(3);
        expect(totals.successRate).toBeCloseTo(2 / 3);
        expect(totals.averageChars).toBe(40);
        expect(totals.maxChars).toBe(60);
        expect(totals.latencyCount).toBe(2);
        expect(totals.averageDurationMs).toBe(400);
        expect(totals.maxDurationMs).toBe(600);
        expect(totals.medianDurationMs).toBeGreaterThan(0);
        expect(totals.p95DurationMs).toBeLessThanOrEqual(600);
    });

    it('线路排行按尝试次数降序，并在次数相同时按服务与线路标识稳定排序', () => {
        expect(buildTranslationRouteBreakdown([
            routeRollup('google', [attempt({route: 'google'})]),
            routeRollup('microsoft', [attempt(), attempt()]),
            routeRollup('deeplx', [attempt({route: 'deeplx'})]),
        ]).map((item) => [item.route, item.totals.attemptCount])).toEqual([
            ['microsoft', 2],
            ['deeplx', 1],
            ['google', 1],
        ]);
    });
});

describe('翻译统计快照', () => {
    const rollups = [
        rollupOf([requestEvent({startedAt: new Date(2026, 8, 16, 9, 5).getTime(), serviceId: 'google'})]),
        rollupOf([requestEvent({startedAt: new Date(2026, 8, 16, 14, 59).getTime(), serviceId: 'openai', model: 'gpt-b'})]),
        rollupOf([requestEvent({startedAt: new Date(2026, 8, 16, 14, 1).getTime(), serviceId: 'openai', model: 'gpt-a'})]),
        rollupOf([requestEvent({startedAt: new Date(2026, 8, 12, 8).getTime(), serviceId: 'google'}), requestEvent({startedAt: new Date(2026, 8, 12, 8, 30).getTime(), serviceId: 'google'})]),
        rollupOf([requestEvent({startedAt: new Date(2026, 7, 20, 8).getTime(), serviceId: 'deepL'})]),
        rollupOf([requestEvent({startedAt: new Date(2026, 8, 16, 16).getTime(), serviceId: 'future'})]),
    ];

    it('今日范围逐小时生成趋势，并按请求量、服务与模型排序服务表现', () => {
        const snapshot = buildTranslationStatsSnapshot(rollups, {range: 'today'}, {now: NOW});

        expect(snapshot.generatedAt).toBe(NOW);
        expect(snapshot.recordingStartedAt).toBe(new Date(2026, 7, 20, 8).getTime());
        expect(snapshot.dimensions.map((dimension) => dimension.serviceId)).toEqual(['deepL', 'future', 'google', 'openai']);
        expect(snapshot.selected.totals.requestCount).toBe(3);
        expect(snapshot.timeline).toHaveLength((localDayStart(NOW + 24 * HOUR + HOUR) - localDayStart(NOW)) / HOUR);
        expect(snapshot.timeline[9]).toMatchObject({label: '09:00', totals: {requestCount: 1}});
        expect(snapshot.timeline[14].totals.requestCount).toBe(2);
        expect(snapshot.breakdown.map((item) => `${item.serviceId}:${item.model}`)).toEqual(['google:', 'openai:gpt-a', 'openai:gpt-b']);
    });

    it('7 天与 30 天范围逐日生成趋势，并支持服务与模型筛选和外部维度', () => {
        const week = buildTranslationStatsSnapshot(rollups, {range: '7d', serviceId: 'google'}, {
            now: NOW,
            recordingStartedAt: 123,
            dimensions: [{serviceId: 'google', models: ['']}],
        });
        expect(week.recordingStartedAt).toBe(123);
        expect(week.dimensions).toEqual([{serviceId: 'google', models: ['']}]);
        expect(week.timeline).toHaveLength(7);
        expect(week.timeline[2]).toMatchObject({label: '9/12', totals: {requestCount: 2}});
        expect(week.selected.totals.requestCount).toBe(3);

        const month = buildTranslationStatsSnapshot(rollups, {range: '30d', serviceId: 'openai', model: 'gpt-b'}, {now: NOW});
        expect(month.timeline).toHaveLength(30);
        expect(month.selected.filter).toEqual({range: '30d', serviceId: 'openai', model: 'gpt-b'});
        expect(month.breakdown).toHaveLength(1);
        expect(buildTranslationStatsSnapshot(rollups, {range: '30d'}, {now: NOW}).selected.totals.requestCount).toBe(6);
    });

    it('线路表现随范围与服务筛选，未提供线路汇总时为空数组', () => {
        const routeRollups = [
            foldTranslationRouteAttempt(
                createTranslationRouteRollup(new Date(2026, 8, 16, 10).getTime(), 'freeTranslation', 'microsoft'),
                {route: 'microsoft', outcome: 'success', durationMs: 300, chars: 20},
            ),
            foldTranslationRouteAttempt(
                createTranslationRouteRollup(new Date(2026, 8, 12, 10).getTime(), 'freeTranslation', 'google'),
                {route: 'google', outcome: 'error', durationMs: 900, chars: 20},
            ),
            foldTranslationRouteAttempt(
                createTranslationRouteRollup(new Date(2026, 8, 16, 16).getTime(), 'freeTranslation', 'deeplx'),
                {route: 'deeplx', outcome: 'success', durationMs: 100, chars: 20},
            ),
        ];

        expect(buildTranslationStatsSnapshot(rollups, {range: '30d'}, {now: NOW}).routes).toEqual([]);
        const today = buildTranslationStatsSnapshot(rollups, {range: 'today'}, {now: NOW, routeRollups});
        expect(today.routes.map((item) => item.route)).toEqual(['microsoft']);
        const week = buildTranslationStatsSnapshot(rollups, {range: '7d'}, {now: NOW, routeRollups});
        expect(week.routes.map((item) => item.route)).toEqual(['google', 'microsoft']);
        expect(buildTranslationStatsSnapshot(rollups, {range: '7d', serviceId: 'google'}, {now: NOW, routeRollups}).routes).toEqual([]);
    });

    it('未传入当前时间时使用系统时间，空数据没有最早记录', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const snapshot = buildTranslationStatsSnapshot([]);

        expect(snapshot.generatedAt).toBe(NOW);
        expect(snapshot.recordingStartedAt).toBeNull();
        expect(snapshot.selected.filter).toEqual({range: '7d'});
        expect(snapshot.breakdown).toEqual([]);
    });
});
