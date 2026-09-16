/**
 * @file src/features/translation-stats/model/presentation.ts
 * 文件职责：把翻译统计快照转换为设置页可直接渲染的展示模型，并按界面语言格式化耗时、数量、字节与比例。
 * 主要内容：提供趋势柱高度与结果分段、分桶分布行与尾部空桶裁剪、失败原因排行、服务与免费线路表现排序、分页区间，以及本地化的耗时、紧凑数字、字节和百分比文本。
 * 模块边界：本文件只做纯计算与格式化，不发送后台消息、不读取配置，也不包含 Vue 响应式或界面文案 key。
 */

import {
    TRANSLATION_STATS_ERROR_KINDS,
    type TranslationRouteBreakdownItem,
    type TranslationRouteTotals,
    type TranslationStatsBreakdownItem,
    type TranslationStatsErrorKind,
    type TranslationStatsTimelinePoint,
    type TranslationStatsTotals,
} from '@/src/services/translation-stats/types';

export type TranslationStatsTrendMetric = 'requests' | 'latency' | 'chars';
export type TranslationStatsTrendSegmentKey = 'success' | 'failed' | 'cancelled';
export type TranslationStatsBreakdownSortKey = 'requests' | 'successRate' | 'average' | 'p95' | 'max' | 'size';
export type TranslationRouteSortKey = 'attempts' | 'successRate' | 'average' | 'p95' | 'max' | 'size';
export type TranslationStatsSortDirection = 'asc' | 'desc';

export interface TranslationStatsTrendBar {
    key: string;
    label: string;
    startedAt: number;
    value: number | null;
    height: number;
    segments: Array<{key: TranslationStatsTrendSegmentKey; share: number}>;
    totals: TranslationStatsTotals;
}

export interface TranslationStatsHistogramRow {
    index: number;
    lower: number | null;
    upper: number | null;
    count: number;
    share: number;
    ratio: number;
}

export interface TranslationStatsErrorKindRow {
    kind: TranslationStatsErrorKind;
    count: number;
    share: number;
}

function trendValue(totals: TranslationStatsTotals, metric: TranslationStatsTrendMetric): number | null {
    if (metric === 'latency') return totals.averageDurationMs;
    return metric === 'chars' ? totals.sourceChars : totals.requestCount;
}

/** 请求次数柱按成功、失败（错误与超时）和取消分段；耗时与文本量为单色柱。 */
export function buildTrendBars(
    points: readonly TranslationStatsTimelinePoint[],
    metric: TranslationStatsTrendMetric,
): {maximum: number; bars: TranslationStatsTrendBar[]} {
    const maximum = Math.max(0, ...points.map((point) => trendValue(point.totals, metric) ?? 0));
    const bars = points.map((point) => {
        const value = trendValue(point.totals, metric);
        const {success, error, timeout, cancelled} = point.totals.outcomes;
        const requestCount = point.totals.requestCount;
        const segments: TranslationStatsTrendBar['segments'] = metric === 'requests' && requestCount > 0
            ? [
                {key: 'success' as const, share: success / requestCount},
                {key: 'failed' as const, share: (error + timeout) / requestCount},
                {key: 'cancelled' as const, share: cancelled / requestCount},
            ].filter((segment) => segment.share > 0)
            : [];
        return {
            key: point.key,
            label: point.label,
            startedAt: point.startedAt,
            value,
            height: maximum > 0 && value !== null ? value / maximum * 100 : 0,
            segments,
            totals: point.totals,
        };
    });
    return {maximum, bars};
}

/** 把分桶计数转成带上下界的行；第一个桶没有下界，最后一个桶没有上界。 */
export function buildHistogramRows(
    histogram: readonly number[],
    bounds: readonly number[],
): {total: number; rows: TranslationStatsHistogramRow[]} {
    const total = histogram.reduce((sum, count) => sum + count, 0);
    const largest = Math.max(0, ...histogram);
    const rows = histogram.map((count, index) => ({
        index,
        lower: index === 0 ? null : bounds[index - 1],
        upper: index < bounds.length ? bounds[index] : null,
        count,
        share: total > 0 ? count / total : 0,
        ratio: largest > 0 ? count / largest : 0,
    }));
    return {total, rows};
}

/** 去掉最后一个非空桶之后的空桶（至少保留 minimum 行），避免长尾空行把分布卡片拉得过高。 */
export function trimHistogramRows(
    rows: readonly TranslationStatsHistogramRow[],
    minimum = 5,
): TranslationStatsHistogramRow[] {
    let last = rows.length - 1;
    while (last >= minimum && rows[last].count === 0) last -= 1;
    return rows.slice(0, last + 1);
}

export function buildErrorKindRows(errorKinds: Readonly<Record<TranslationStatsErrorKind, number>>): TranslationStatsErrorKindRow[] {
    const total = TRANSLATION_STATS_ERROR_KINDS.reduce((sum, kind) => sum + errorKinds[kind], 0);
    return TRANSLATION_STATS_ERROR_KINDS
        .map((kind) => ({kind, count: errorKinds[kind], share: total > 0 ? errorKinds[kind] / total : 0}))
        .filter((row) => row.count > 0)
        .sort((left, right) => right.count - left.count);
}

export function breakdownMetric(totals: TranslationStatsTotals, key: TranslationStatsBreakdownSortKey): number | null {
    switch (key) {
    case 'successRate': return totals.successRate;
    case 'average': return totals.averageDurationMs;
    case 'p95': return totals.p95DurationMs;
    case 'max': return totals.maxDurationMs;
    case 'size': return totals.averageSourceChars;
    default: return totals.requestCount;
    }
}

/** 缺失值无论升降序都排在末尾，同值时保持请求量优先的稳定顺序。 */
export function sortBreakdown(
    items: readonly TranslationStatsBreakdownItem[],
    key: TranslationStatsBreakdownSortKey,
    direction: TranslationStatsSortDirection,
): TranslationStatsBreakdownItem[] {
    const factor = direction === 'asc' ? 1 : -1;
    return [...items].sort((left, right) => {
        const leftValue = breakdownMetric(left.totals, key);
        const rightValue = breakdownMetric(right.totals, key);
        if (leftValue === null || rightValue === null) {
            return Number(leftValue === null) - Number(rightValue === null)
                || right.totals.requestCount - left.totals.requestCount;
        }
        return (leftValue - rightValue) * factor
            || right.totals.requestCount - left.totals.requestCount
            || left.serviceId.localeCompare(right.serviceId)
            || left.model.localeCompare(right.model);
    });
}

export function routeMetric(totals: TranslationRouteTotals, key: TranslationRouteSortKey): number | null {
    switch (key) {
    case 'successRate': return totals.successRate;
    case 'average': return totals.averageDurationMs;
    case 'p95': return totals.p95DurationMs;
    case 'max': return totals.maxDurationMs;
    case 'size': return totals.averageChars;
    default: return totals.attemptCount;
    }
}

/** 与服务表现同样的排序规则：缺失值排在最后，同值按尝试次数和线路标识稳定排序。 */
export function sortRoutes(
    items: readonly TranslationRouteBreakdownItem[],
    key: TranslationRouteSortKey,
    direction: TranslationStatsSortDirection,
): TranslationRouteBreakdownItem[] {
    const factor = direction === 'asc' ? 1 : -1;
    return [...items].sort((left, right) => {
        const leftValue = routeMetric(left.totals, key);
        const rightValue = routeMetric(right.totals, key);
        if (leftValue === null || rightValue === null) {
            return Number(leftValue === null) - Number(rightValue === null)
                || right.totals.attemptCount - left.totals.attemptCount;
        }
        return (leftValue - rightValue) * factor
            || right.totals.attemptCount - left.totals.attemptCount
            || left.route.localeCompare(right.route);
    });
}

export function requestPageRange(offset: number, limit: number, total: number): {start: number; end: number; pageIndex: number; pageCount: number} {
    return {
        start: total > 0 ? Math.min(offset + 1, total) : 0,
        end: Math.min(offset + limit, total),
        pageIndex: Math.floor(offset / limit),
        pageCount: Math.max(1, Math.ceil(total / limit)),
    };
}

function isValidNumber(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatStatsNumber(value: number, language: string): string {
    return new Intl.NumberFormat(language, {maximumFractionDigits: 0}).format(isValidNumber(value) ? value : 0);
}

/** 一万以下保留完整千分位，更大的数量使用当前语言的紧凑写法。 */
export function formatStatsCompact(value: number, language: string): string {
    const safe = isValidNumber(value) ? value : 0;
    if (safe < 10_000) return formatStatsNumber(safe, language);
    return new Intl.NumberFormat(language, {notation: 'compact', maximumFractionDigits: 1}).format(safe);
}

export function formatStatsPercent(value: number | null, language: string): string {
    if (!isValidNumber(value)) return '—';
    return new Intl.NumberFormat(language, {style: 'percent', maximumFractionDigits: 1}).format(value);
}

function formatUnit(value: number, unit: string, language: string, maximumFractionDigits: number): string {
    return new Intl.NumberFormat(language, {style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits}).format(value);
}

export function formatStatsDuration(value: number | null, language: string): string {
    if (!isValidNumber(value)) return '—';
    if (value < 1_000) return formatUnit(Math.round(value), 'millisecond', language, 0);
    if (value < 60_000) return formatUnit(value / 1_000, 'second', language, value < 10_000 ? 2 : 1);
    const totalSeconds = Math.round(value / 1_000);
    return `${formatUnit(Math.floor(totalSeconds / 60), 'minute', language, 0)} ${formatUnit(totalSeconds % 60, 'second', language, 0)}`;
}

export function formatStatsBytes(value: number, language: string): string {
    const safe = isValidNumber(value) ? value : 0;
    if (safe < 1_024) return formatUnit(safe, 'byte', language, 0);
    if (safe < 1_024 * 1_024) return formatUnit(safe / 1_024, 'kilobyte', language, 1);
    return formatUnit(safe / 1_024 / 1_024, 'megabyte', language, 1);
}
