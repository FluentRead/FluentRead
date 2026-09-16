import {describe, expect, it} from 'vitest';
import {emptyTranslationStatsTotals} from '@/src/services/translation-stats/aggregation';
import {
    breakdownMetric,
    buildErrorKindRows,
    buildHistogramRows,
    buildTrendBars,
    formatStatsBytes,
    formatStatsCompact,
    formatStatsDuration,
    formatStatsNumber,
    formatStatsPercent,
    requestPageRange,
    routeMetric,
    sortBreakdown,
    sortRoutes,
    trimHistogramRows,
} from '@/src/features/translation-stats/model/presentation';
import {emptyTranslationRouteTotals} from '@/src/services/translation-stats/aggregation';
import type {
    TranslationRouteBreakdownItem,
    TranslationRouteTotals,
    TranslationStatsBreakdownItem,
    TranslationStatsTimelinePoint,
    TranslationStatsTotals,
} from '@/src/services/translation-stats/types';

function totals(overrides: Partial<TranslationStatsTotals> = {}): TranslationStatsTotals {
    return {...emptyTranslationStatsTotals(), ...overrides};
}

function point(key: string, overrides: Partial<TranslationStatsTotals>): TranslationStatsTimelinePoint {
    return {key, label: key, startedAt: 0, totals: totals(overrides)};
}

function item(serviceId: string, model: string, overrides: Partial<TranslationStatsTotals>): TranslationStatsBreakdownItem {
    return {serviceId, model, totals: totals(overrides)};
}

describe('翻译统计展示模型', () => {
    it('请求趋势按结果分段，耗时与文本量按最大值计算柱高', () => {
        const points = [
            point('a', {requestCount: 4, outcomes: {success: 2, error: 1, timeout: 0, cancelled: 1}, averageDurationMs: 500, sourceChars: 100}),
            point('b', {requestCount: 2, outcomes: {success: 2, error: 0, timeout: 0, cancelled: 0}, averageDurationMs: null, sourceChars: 400}),
            point('c', {}),
        ];

        const requests = buildTrendBars(points, 'requests');
        expect(requests.maximum).toBe(4);
        expect(requests.bars.map((bar) => bar.height)).toEqual([100, 50, 0]);
        expect(requests.bars[0].segments).toEqual([
            {key: 'success', share: 0.5},
            {key: 'failed', share: 0.25},
            {key: 'cancelled', share: 0.25},
        ]);
        expect(requests.bars[1].segments).toEqual([{key: 'success', share: 1}]);
        expect(requests.bars[2].segments).toEqual([]);

        const latency = buildTrendBars(points, 'latency');
        expect(latency.maximum).toBe(500);
        expect(latency.bars.map((bar) => [bar.value, bar.height, bar.segments.length])).toEqual([[500, 100, 0], [null, 0, 0], [null, 0, 0]]);
        expect(buildTrendBars(points, 'chars').bars.map((bar) => bar.height)).toEqual([25, 100, 0]);
        expect(buildTrendBars([], 'requests')).toEqual({maximum: 0, bars: []});
    });

    it('分布行携带上下界、占比和相对最大桶比例', () => {
        expect(buildHistogramRows([1, 3, 0], [100, 200])).toEqual({
            total: 4,
            rows: [
                {index: 0, lower: null, upper: 100, count: 1, share: 0.25, ratio: 1 / 3},
                {index: 1, lower: 100, upper: 200, count: 3, share: 0.75, ratio: 1},
                {index: 2, lower: 200, upper: null, count: 0, share: 0, ratio: 0},
            ],
        });
        expect(buildHistogramRows([0, 0], [10]).rows.map((row) => [row.share, row.ratio])).toEqual([[0, 0], [0, 0]]);

        const rows = buildHistogramRows([3, 0, 1, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6, 7]).rows;
        expect(trimHistogramRows(rows).map((row) => row.index)).toEqual([0, 1, 2, 3, 4]);
        expect(trimHistogramRows(rows, 1).map((row) => row.index)).toEqual([0, 1, 2]);
        expect(trimHistogramRows(buildHistogramRows([0, 0, 0, 0, 0, 0, 0, 9], [1, 2, 3, 4, 5, 6, 7]).rows)).toHaveLength(8);
    });

    it('失败原因只保留出现过的分类并按次数降序', () => {
        const errorKinds = {...emptyTranslationStatsTotals().errorKinds, network: 1, 'rate-limit': 3};
        expect(buildErrorKindRows(errorKinds)).toEqual([
            {kind: 'rate-limit', count: 3, share: 0.75},
            {kind: 'network', count: 1, share: 0.25},
        ]);
        expect(buildErrorKindRows(emptyTranslationStatsTotals().errorKinds)).toEqual([]);
    });

    it('服务表现按指标排序，缺失值始终在后且同值按请求量与名称稳定排序', () => {
        const rows = [
            item('google', '', {requestCount: 10, successRate: 0.9, averageDurationMs: 400, p95DurationMs: 900, maxDurationMs: 1_500, averageSourceChars: 80}),
            item('openai', 'gpt-b', {requestCount: 5, successRate: 1, averageDurationMs: 1_200, p95DurationMs: 2_000, maxDurationMs: 3_000, averageSourceChars: 300}),
            item('openai', 'gpt-a', {requestCount: 5, successRate: 1, averageDurationMs: 1_200, p95DurationMs: 2_000, maxDurationMs: 3_000, averageSourceChars: 300}),
            item('deepL', '', {requestCount: 2, successRate: null, averageDurationMs: null, p95DurationMs: null, maxDurationMs: null, averageSourceChars: null}),
            item('bing', '', {requestCount: 7, successRate: null, averageDurationMs: null, p95DurationMs: null, maxDurationMs: null, averageSourceChars: null}),
        ];
        const ids = (key: Parameters<typeof sortBreakdown>[1], direction: Parameters<typeof sortBreakdown>[2]) => sortBreakdown(rows, key, direction)
            .map((row) => `${row.serviceId}:${row.model}`);

        expect(ids('requests', 'desc')).toEqual(['google:', 'bing:', 'openai:gpt-a', 'openai:gpt-b', 'deepL:']);
        expect(ids('average', 'asc')).toEqual(['google:', 'openai:gpt-a', 'openai:gpt-b', 'bing:', 'deepL:']);
        expect(ids('successRate', 'desc')).toEqual(['openai:gpt-a', 'openai:gpt-b', 'google:', 'bing:', 'deepL:']);
        expect(ids('size', 'asc')[0]).toBe('google:');
        expect(ids('p95', 'desc')[0]).toBe('openai:gpt-a');
        expect(ids('max', 'asc').slice(-2)).toEqual(['bing:', 'deepL:']);
        expect(breakdownMetric(rows[0].totals, 'max')).toBe(1_500);
        expect(rows.map((row) => row.serviceId)).toEqual(['google', 'openai', 'openai', 'deepL', 'bing']);
    });

    it('免费线路按尝试次数、成功率和耗时排序，缺失耗时的线路排在最后', () => {
        const route = (id: string, overrides: Partial<TranslationRouteTotals>): TranslationRouteBreakdownItem => ({
            serviceId: 'freeTranslation', route: id, totals: {...emptyTranslationRouteTotals(), ...overrides},
        });
        const rows = [
            route('microsoft', {attemptCount: 12, successRate: 0.9, averageDurationMs: 300, p95DurationMs: 700, maxDurationMs: 900, averageChars: 40}),
            route('google', {attemptCount: 5, successRate: 1, averageDurationMs: 700, p95DurationMs: 1_200, maxDurationMs: 1_500, averageChars: 60}),
            route('deeplx', {attemptCount: 9, successRate: 0, averageDurationMs: null, p95DurationMs: null, maxDurationMs: null, averageChars: 20}),
        ];
        const ids = (key: Parameters<typeof sortRoutes>[1], direction: Parameters<typeof sortRoutes>[2]) => sortRoutes(rows, key, direction).map((row) => row.route);

        expect(ids('attempts', 'desc')).toEqual(['microsoft', 'deeplx', 'google']);
        expect(ids('average', 'asc')).toEqual(['microsoft', 'google', 'deeplx']);
        expect(ids('successRate', 'desc')).toEqual(['google', 'microsoft', 'deeplx']);
        expect(ids('p95', 'desc')[0]).toBe('google');
        expect(ids('max', 'asc').at(-1)).toBe('deeplx');
        expect(ids('size', 'desc')[0]).toBe('google');
        expect(routeMetric(rows[0].totals, 'attempts')).toBe(12);
        expect(rows.map((row) => row.route)).toEqual(['microsoft', 'google', 'deeplx']);

        const tied = [
            route('bing', {attemptCount: 4, averageDurationMs: 500}),
            route('azure', {attemptCount: 4, averageDurationMs: 500}),
            route('yandex', {attemptCount: 7, averageDurationMs: 500}),
            route('lingva', {attemptCount: 2, averageDurationMs: null}),
            route('apertium', {attemptCount: 9, averageDurationMs: null}),
        ];
        expect(sortRoutes(tied, 'average', 'desc').map((row) => row.route))
            .toEqual(['yandex', 'azure', 'bing', 'apertium', 'lingva']);
    });

    it('分页区间在空列表、中间页与末页保持一致', () => {
        expect(requestPageRange(0, 20, 0)).toEqual({start: 0, end: 0, pageIndex: 0, pageCount: 1});
        expect(requestPageRange(20, 20, 45)).toEqual({start: 21, end: 40, pageIndex: 1, pageCount: 3});
        expect(requestPageRange(40, 20, 45)).toEqual({start: 41, end: 45, pageIndex: 2, pageCount: 3});
        expect(requestPageRange(60, 20, 45)).toEqual({start: 45, end: 45, pageIndex: 3, pageCount: 3});
    });

    it('按界面语言格式化数量、紧凑数量、百分比、耗时与字节，并为无效值兜底', () => {
        expect(formatStatsNumber(12_345.6, 'en-US')).toBe('12,346');
        expect(formatStatsNumber(Number.NaN, 'en-US')).toBe('0');
        expect(formatStatsCompact(9_999, 'en-US')).toBe('9,999');
        expect(formatStatsCompact(123_456, 'en-US')).toBe('123.5K');
        expect(formatStatsCompact(-5, 'zh-CN')).toBe('0');
        expect(formatStatsCompact(123_456, 'zh-CN')).toBe('12.3万');
        expect(formatStatsPercent(0.9876, 'en-US')).toBe('98.8%');
        expect(formatStatsPercent(null, 'en-US')).toBe('—');
        expect(formatStatsDuration(null, 'en-US')).toBe('—');
        expect(formatStatsDuration(-1, 'en-US')).toBe('—');
        expect(formatStatsDuration(420.4, 'en-US')).toBe('420 ms');
        expect(formatStatsDuration(2_345, 'en-US')).toBe('2.35 sec');
        expect(formatStatsDuration(12_340, 'en-US')).toBe('12.3 sec');
        expect(formatStatsDuration(125_000, 'en-US')).toBe('2 min 5 sec');
        expect(formatStatsBytes(512, 'en-US')).toBe('512 byte');
        expect(formatStatsBytes(Number.POSITIVE_INFINITY, 'en-US')).toBe('0 byte');
        expect(formatStatsBytes(1_536, 'en-US')).toBe('1.5 kB');
        expect(formatStatsBytes(3 * 1_024 * 1_024, 'en-US')).toBe('3 MB');
    });
});
