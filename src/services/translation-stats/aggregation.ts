/**
 * @file src/services/translation-stats/aggregation.ts
 * 文件职责：把翻译请求事件折叠为本地小时汇总，并把汇总行计算成设置页可直接展示的统计快照。
 * 主要内容：提供本地日界线与小时桶、筛选归一化、分桶定位与分位数估算、请求事件与线路尝试折叠、总量与成功率/复用率/耗时指标计算、逐小时或逐日趋势，以及按服务模型和内部线路分组的表现排行。
 * 模块边界：本文件只执行确定性的内存计算，不访问 IndexedDB、浏览器 runtime、翻译 provider 或 Vue 组件。
 */

import {
    TRANSLATION_REQUEST_OUTCOMES,
    TRANSLATION_REQUEST_SOURCES,
    TRANSLATION_STATS_DURATION_BOUNDS_MS,
    TRANSLATION_STATS_ERROR_KINDS,
    TRANSLATION_STATS_SCHEMA_VERSION,
    TRANSLATION_STATS_SIZE_BOUNDS_CHARS,
    type StoredTranslationRequestEvent,
    type TranslationRequestStatsEvent,
    type TranslationStatsBreakdownItem,
    type TranslationStatsDimension,
    type TranslationStatsFilter,
    type TranslationStatsRange,
    type TranslationRouteAttempt,
    type TranslationRouteBreakdownItem,
    type TranslationRouteRollup,
    type TranslationRouteTotals,
    type TranslationStatsRollup,
    type TranslationStatsSnapshot,
    type TranslationStatsTimelinePoint,
    type TranslationStatsTotals,
} from './types';

type FoldableEvent = TranslationRequestStatsEvent | StoredTranslationRequestEvent;

export interface TranslationStatsSnapshotOptions {
    now?: number;
    recordingStartedAt?: number | null;
    dimensions?: readonly TranslationStatsDimension[];
    /** 免费翻译链等内部线路的小时汇总；缺省表示本次范围没有线路数据。 */
    routeRollups?: readonly TranslationRouteRollup[];
}

const HOUR_MS = 60 * 60 * 1000;
const VALID_RANGES = new Set<TranslationStatsRange>(['today', '7d', '30d']);

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
    return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function zeroHistogram(bounds: readonly number[]): number[] {
    return Array.from({length: bounds.length + 1}, () => 0);
}

export function localDayStart(timestamp: number): number {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

export function shiftLocalDays(timestamp: number, delta: number): number {
    const date = new Date(timestamp);
    date.setDate(date.getDate() + delta);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/** 以本地零点为基准切小时，半小时时区也不会让同一个桶跨越两个本地日期。 */
export function localHourBucketStart(timestamp: number): number {
    const dayStart = localDayStart(timestamp);
    return dayStart + Math.floor((timestamp - dayStart) / HOUR_MS) * HOUR_MS;
}

export function getTranslationStatsRangeStart(range: TranslationStatsRange, now: number): number {
    const today = localDayStart(now);
    if (range === 'today') return today;
    return shiftLocalDays(today, range === '7d' ? -6 : -29);
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeTranslationStatsFilter(value?: Partial<TranslationStatsFilter>): TranslationStatsFilter {
    const range = value?.range && VALID_RANGES.has(value.range) ? value.range : '7d';
    const serviceId = optionalText(value?.serviceId);
    // 机器翻译的模型维度为空串；只有明确指定服务时模型筛选才有意义。
    const model = serviceId && typeof value?.model === 'string' ? value.model.trim() : undefined;
    return {
        range,
        ...(serviceId ? {serviceId} : {}),
        ...(model !== undefined ? {model} : {}),
    };
}

/** 返回数值所在分桶；上界不含本身，超过全部上界时落入最后一个桶。 */
export function histogramIndex(value: number, bounds: readonly number[]): number {
    const index = bounds.findIndex((bound) => value < bound);
    return index < 0 ? bounds.length : index;
}

/**
 * 按分桶线性插值估算分位数，并以真实最大值封顶。
 * 最后一个桶没有上界，使用最大值作为插值终点。
 */
export function estimateHistogramPercentile(
    histogram: readonly number[],
    bounds: readonly number[],
    percentile: number,
    maxValue: number,
): number | null {
    const total = histogram.reduce((sum, count) => sum + count, 0);
    if (total <= 0) return null;
    const target = Math.min(1, Math.max(0, percentile)) * total;
    let index = 0;
    let cumulative = 0;
    while (index < histogram.length - 1 && cumulative + histogram[index] < target) {
        cumulative += histogram[index];
        index += 1;
    }
    const lower = index === 0 ? 0 : bounds[index - 1];
    const upper = index < bounds.length ? bounds[index] : Math.max(maxValue, lower);
    const fraction = Math.min(1, Math.max(0, (target - cumulative) / histogram[index]));
    return Math.min(maxValue, lower + (upper - lower) * fraction);
}

export function createTranslationStatsRollup(bucketStart: number, serviceId: string, model: string): TranslationStatsRollup {
    return {
        bucketStart,
        serviceId,
        model,
        schemaVersion: TRANSLATION_STATS_SCHEMA_VERSION,
        requestCount: 0,
        outcomes: zeroRecord(TRANSLATION_REQUEST_OUTCOMES),
        sources: zeroRecord(TRANSLATION_REQUEST_SOURCES),
        errorKinds: zeroRecord(TRANSLATION_STATS_ERROR_KINDS),
        segmentCount: 0,
        cachedSegments: 0,
        sharedSegments: 0,
        sourceChars: 0,
        sourceBytes: 0,
        resultChars: 0,
        maxSourceChars: 0,
        upstreamCalls: 0,
        sizeHistogram: zeroHistogram(TRANSLATION_STATS_SIZE_BOUNDS_CHARS),
        latencyCount: 0,
        latencyDurationMs: 0,
        latencyMaxDurationMs: 0,
        latencyUpstreamMs: 0,
        latencySourceChars: 0,
        durationHistogram: zeroHistogram(TRANSLATION_STATS_DURATION_BOUNDS_MS),
    };
}

/** 耗时只采样成功且真正请求了服务的翻译；缓存直接返回和复用请求会显著拉低平均值。 */
export function isTranslationLatencySample(event: Pick<FoldableEvent, 'outcome' | 'source'>): boolean {
    return event.outcome === 'success' && (event.source === 'network' || event.source === 'partial');
}

export function translationStatsRollupKey(event: Pick<FoldableEvent, 'startedAt' | 'serviceId' | 'model'>): [number, string, string] {
    return [localHourBucketStart(event.startedAt), event.serviceId, event.model ?? ''];
}

/** 返回新的汇总行，不修改传入对象，便于事务内重试和测试比对。 */
export function foldTranslationRequestEvent(rollup: TranslationStatsRollup, event: FoldableEvent): TranslationStatsRollup {
    const next: TranslationStatsRollup = {
        ...rollup,
        outcomes: {...rollup.outcomes},
        sources: {...rollup.sources},
        errorKinds: {...rollup.errorKinds},
        sizeHistogram: [...rollup.sizeHistogram],
        durationHistogram: [...rollup.durationHistogram],
    };
    next.requestCount += 1;
    next.outcomes[event.outcome] += 1;
    next.sources[event.source] += 1;
    if (event.errorKind) next.errorKinds[event.errorKind] += 1;
    next.segmentCount += event.segmentCount;
    next.cachedSegments += event.cachedSegments;
    if (event.source === 'shared') next.sharedSegments += event.segmentCount;
    next.sourceChars += event.sourceChars;
    next.sourceBytes += event.sourceBytes;
    next.resultChars += event.resultChars ?? 0;
    next.maxSourceChars = Math.max(next.maxSourceChars, event.sourceChars);
    next.upstreamCalls += event.upstreamCalls;
    next.sizeHistogram[histogramIndex(event.sourceChars, TRANSLATION_STATS_SIZE_BOUNDS_CHARS)] += 1;
    if (isTranslationLatencySample(event)) {
        next.latencyCount += 1;
        next.latencyDurationMs += event.durationMs;
        next.latencyMaxDurationMs = Math.max(next.latencyMaxDurationMs, event.durationMs);
        next.latencyUpstreamMs += Math.min(event.upstreamMs, event.durationMs);
        next.latencySourceChars += event.sourceChars;
        next.durationHistogram[histogramIndex(event.durationMs, TRANSLATION_STATS_DURATION_BOUNDS_MS)] += 1;
    }
    return next;
}

export function createTranslationRouteRollup(bucketStart: number, serviceId: string, route: string): TranslationRouteRollup {
    return {
        bucketStart,
        serviceId,
        route,
        schemaVersion: TRANSLATION_STATS_SCHEMA_VERSION,
        attemptCount: 0,
        outcomes: zeroRecord(TRANSLATION_REQUEST_OUTCOMES),
        chars: 0,
        maxChars: 0,
        latencyCount: 0,
        latencyDurationMs: 0,
        latencyMaxDurationMs: 0,
        durationHistogram: zeroHistogram(TRANSLATION_STATS_DURATION_BOUNDS_MS),
    };
}

/** 线路尝试只有成功时才计入耗时；失败与超时仍计入尝试次数和成功率分母。 */
export function foldTranslationRouteAttempt(rollup: TranslationRouteRollup, attempt: TranslationRouteAttempt): TranslationRouteRollup {
    const next: TranslationRouteRollup = {
        ...rollup,
        outcomes: {...rollup.outcomes},
        durationHistogram: [...rollup.durationHistogram],
    };
    next.attemptCount += 1;
    next.outcomes[attempt.outcome] += 1;
    next.chars += attempt.chars;
    next.maxChars = Math.max(next.maxChars, attempt.chars);
    if (attempt.outcome === 'success') {
        next.latencyCount += 1;
        next.latencyDurationMs += attempt.durationMs;
        next.latencyMaxDurationMs = Math.max(next.latencyMaxDurationMs, attempt.durationMs);
        next.durationHistogram[histogramIndex(attempt.durationMs, TRANSLATION_STATS_DURATION_BOUNDS_MS)] += 1;
    }
    return next;
}

export function emptyTranslationRouteTotals(): TranslationRouteTotals {
    return {
        attemptCount: 0,
        outcomes: zeroRecord(TRANSLATION_REQUEST_OUTCOMES),
        successRate: null,
        chars: 0,
        maxChars: 0,
        averageChars: null,
        latencyCount: 0,
        averageDurationMs: null,
        medianDurationMs: null,
        p95DurationMs: null,
        maxDurationMs: null,
        durationHistogram: zeroHistogram(TRANSLATION_STATS_DURATION_BOUNDS_MS),
    };
}

export function aggregateTranslationRouteTotals(rollups: readonly TranslationRouteRollup[]): TranslationRouteTotals {
    const totals = emptyTranslationRouteTotals();
    let latencyDurationMs = 0;
    let maxDurationMs = 0;
    for (const rollup of rollups) {
        totals.attemptCount += rollup.attemptCount;
        addRecord(totals.outcomes, rollup.outcomes);
        totals.chars += rollup.chars;
        totals.maxChars = Math.max(totals.maxChars, rollup.maxChars);
        totals.latencyCount += rollup.latencyCount;
        latencyDurationMs += rollup.latencyDurationMs;
        maxDurationMs = Math.max(maxDurationMs, rollup.latencyMaxDurationMs);
        addHistogram(totals.durationHistogram, rollup.durationHistogram);
    }
    const {success, error, timeout} = totals.outcomes;
    const settled = success + error + timeout;
    totals.successRate = settled > 0 ? success / settled : null;
    if (totals.attemptCount > 0) totals.averageChars = totals.chars / totals.attemptCount;
    if (totals.latencyCount > 0) {
        totals.averageDurationMs = latencyDurationMs / totals.latencyCount;
        totals.maxDurationMs = maxDurationMs;
        totals.medianDurationMs = estimateHistogramPercentile(
            totals.durationHistogram, TRANSLATION_STATS_DURATION_BOUNDS_MS, 0.5, maxDurationMs,
        );
        totals.p95DurationMs = estimateHistogramPercentile(
            totals.durationHistogram, TRANSLATION_STATS_DURATION_BOUNDS_MS, 0.95, maxDurationMs,
        );
    }
    return totals;
}

/** 按尝试次数降序排列线路，次数相同时保持服务与线路标识的稳定顺序。 */
export function buildTranslationRouteBreakdown(rollups: readonly TranslationRouteRollup[]): TranslationRouteBreakdownItem[] {
    const groups = new Map<string, {serviceId: string; route: string; rollups: TranslationRouteRollup[]}>();
    for (const rollup of rollups) {
        const key = `${rollup.serviceId}\u0000${rollup.route}`;
        const group = groups.get(key) ?? {serviceId: rollup.serviceId, route: rollup.route, rollups: []};
        group.rollups.push(rollup);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => ({serviceId: group.serviceId, route: group.route, totals: aggregateTranslationRouteTotals(group.rollups)}))
        .sort((left, right) => (
            right.totals.attemptCount - left.totals.attemptCount
            || left.serviceId.localeCompare(right.serviceId)
            || left.route.localeCompare(right.route)
        ));
}

function addHistogram(target: number[], source: readonly number[]): void {
    for (let index = 0; index < target.length; index += 1) target[index] += source[index] ?? 0;
}

function addRecord<K extends string>(target: Record<K, number>, source: Readonly<Record<K, number>>): void {
    for (const key of Object.keys(target) as K[]) target[key] += source[key] ?? 0;
}

export function emptyTranslationStatsTotals(): TranslationStatsTotals {
    return {
        requestCount: 0,
        outcomes: zeroRecord(TRANSLATION_REQUEST_OUTCOMES),
        sources: zeroRecord(TRANSLATION_REQUEST_SOURCES),
        errorKinds: zeroRecord(TRANSLATION_STATS_ERROR_KINDS),
        successRate: null,
        segmentCount: 0,
        cachedSegments: 0,
        sharedSegments: 0,
        reuseRate: null,
        sourceChars: 0,
        sourceBytes: 0,
        resultChars: 0,
        maxSourceChars: 0,
        averageSourceChars: null,
        averageSegments: null,
        upstreamCalls: 0,
        sizeHistogram: zeroHistogram(TRANSLATION_STATS_SIZE_BOUNDS_CHARS),
        latencyCount: 0,
        averageDurationMs: null,
        medianDurationMs: null,
        p95DurationMs: null,
        maxDurationMs: null,
        averageUpstreamMs: null,
        charsPerSecond: null,
        durationHistogram: zeroHistogram(TRANSLATION_STATS_DURATION_BOUNDS_MS),
    };
}

export function aggregateTranslationStatsTotals(rollups: readonly TranslationStatsRollup[]): TranslationStatsTotals {
    const totals = emptyTranslationStatsTotals();
    let latencyDurationMs = 0;
    let latencyUpstreamMs = 0;
    let latencySourceChars = 0;
    let maxDurationMs = 0;
    for (const rollup of rollups) {
        totals.requestCount += rollup.requestCount;
        addRecord(totals.outcomes, rollup.outcomes);
        addRecord(totals.sources, rollup.sources);
        addRecord(totals.errorKinds, rollup.errorKinds);
        totals.segmentCount += rollup.segmentCount;
        totals.cachedSegments += rollup.cachedSegments;
        totals.sharedSegments += rollup.sharedSegments;
        totals.sourceChars += rollup.sourceChars;
        totals.sourceBytes += rollup.sourceBytes;
        totals.resultChars += rollup.resultChars;
        totals.maxSourceChars = Math.max(totals.maxSourceChars, rollup.maxSourceChars);
        totals.upstreamCalls += rollup.upstreamCalls;
        addHistogram(totals.sizeHistogram, rollup.sizeHistogram);
        totals.latencyCount += rollup.latencyCount;
        latencyDurationMs += rollup.latencyDurationMs;
        latencyUpstreamMs += rollup.latencyUpstreamMs;
        latencySourceChars += rollup.latencySourceChars;
        maxDurationMs = Math.max(maxDurationMs, rollup.latencyMaxDurationMs);
        addHistogram(totals.durationHistogram, rollup.durationHistogram);
    }
    const {success, error, timeout} = totals.outcomes;
    const settled = success + error + timeout;
    totals.successRate = settled > 0 ? success / settled : null;
    totals.reuseRate = totals.segmentCount > 0
        ? (totals.cachedSegments + totals.sharedSegments) / totals.segmentCount
        : null;
    if (totals.requestCount > 0) {
        totals.averageSourceChars = totals.sourceChars / totals.requestCount;
        totals.averageSegments = totals.segmentCount / totals.requestCount;
    }
    if (totals.latencyCount > 0) {
        totals.averageDurationMs = latencyDurationMs / totals.latencyCount;
        totals.maxDurationMs = maxDurationMs;
        totals.averageUpstreamMs = latencyUpstreamMs / totals.latencyCount;
        totals.medianDurationMs = estimateHistogramPercentile(
            totals.durationHistogram, TRANSLATION_STATS_DURATION_BOUNDS_MS, 0.5, maxDurationMs,
        );
        totals.p95DurationMs = estimateHistogramPercentile(
            totals.durationHistogram, TRANSLATION_STATS_DURATION_BOUNDS_MS, 0.95, maxDurationMs,
        );
        totals.charsPerSecond = latencyDurationMs > 0 ? latencySourceChars / latencyDurationMs * 1_000 : null;
    }
    return totals;
}

export function collectTranslationStatsDimensions(
    rollups: readonly Pick<TranslationStatsRollup, 'serviceId' | 'model'>[],
): TranslationStatsDimension[] {
    const modelsByService = new Map<string, Set<string>>();
    for (const rollup of rollups) {
        const models = modelsByService.get(rollup.serviceId) ?? new Set<string>();
        models.add(rollup.model);
        modelsByService.set(rollup.serviceId, models);
    }
    return [...modelsByService]
        .map(([serviceId, models]) => ({serviceId, models: [...models].sort((a, b) => a.localeCompare(b))}))
        .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

function matchesDimensions(rollup: TranslationStatsRollup, filter: TranslationStatsFilter): boolean {
    if (filter.serviceId && rollup.serviceId !== filter.serviceId) return false;
    return filter.model === undefined || rollup.model === filter.model;
}

function localDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildTimeline(
    rollups: readonly TranslationStatsRollup[],
    range: TranslationStatsRange,
    now: number,
): TranslationStatsTimelinePoint[] {
    const byBucket = new Map<string, TranslationStatsRollup[]>();
    for (const rollup of rollups) {
        const key = range === 'today' ? `hour:${rollup.bucketStart}` : localDateKey(rollup.bucketStart);
        const bucket = byBucket.get(key) ?? [];
        bucket.push(rollup);
        byBucket.set(key, bucket);
    }

    if (range === 'today') {
        const todayStart = localDayStart(now);
        const tomorrowStart = shiftLocalDays(todayStart, 1);
        const points: TranslationStatsTimelinePoint[] = [];
        // 逐个真实 epoch 小时推进；夏令时切换日自然得到 23 或 25 个桶。
        for (let bucketStart = todayStart; bucketStart < tomorrowStart; bucketStart += HOUR_MS) {
            const date = new Date(bucketStart);
            const key = `hour:${bucketStart}`;
            points.push({
                key,
                label: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
                startedAt: bucketStart,
                totals: aggregateTranslationStatsTotals(byBucket.get(key) ?? []),
            });
        }
        return points;
    }

    const days = range === '7d' ? 7 : 30;
    const start = getTranslationStatsRangeStart(range, now);
    return Array.from({length: days}, (_, index) => {
        const bucketStart = shiftLocalDays(start, index);
        const date = new Date(bucketStart);
        const key = localDateKey(bucketStart);
        return {
            key,
            label: `${date.getMonth() + 1}/${date.getDate()}`,
            startedAt: bucketStart,
            totals: aggregateTranslationStatsTotals(byBucket.get(key) ?? []),
        };
    });
}

function buildBreakdown(rollups: readonly TranslationStatsRollup[]): TranslationStatsBreakdownItem[] {
    const groups = new Map<string, {serviceId: string; model: string; rollups: TranslationStatsRollup[]}>();
    for (const rollup of rollups) {
        const key = `${rollup.serviceId}\u0000${rollup.model}`;
        const group = groups.get(key) ?? {serviceId: rollup.serviceId, model: rollup.model, rollups: []};
        group.rollups.push(rollup);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => ({
            serviceId: group.serviceId,
            model: group.model,
            totals: aggregateTranslationStatsTotals(group.rollups),
        }))
        .sort((left, right) => (
            right.totals.requestCount - left.totals.requestCount
            || left.serviceId.localeCompare(right.serviceId)
            || left.model.localeCompare(right.model)
        ));
}

export function buildTranslationStatsSnapshot(
    rollups: readonly TranslationStatsRollup[],
    requestedFilter: Partial<TranslationStatsFilter> = {},
    options: TranslationStatsSnapshotOptions = {},
): TranslationStatsSnapshot {
    const generatedAt = options.now ?? Date.now();
    const filter = normalizeTranslationStatsFilter(requestedFilter);
    const rangeStart = getTranslationStatsRangeStart(filter.range, generatedAt);
    const selected = rollups.filter((rollup) => (
        matchesDimensions(rollup, filter)
        && rollup.bucketStart >= rangeStart
        && rollup.bucketStart <= generatedAt
    ));
    const derivedRecordingStartedAt = rollups.length > 0
        ? Math.min(...rollups.map((rollup) => rollup.bucketStart))
        : null;

    return {
        generatedAt,
        recordingStartedAt: options.recordingStartedAt === undefined
            ? derivedRecordingStartedAt
            : options.recordingStartedAt,
        dimensions: (options.dimensions ?? collectTranslationStatsDimensions(rollups)).map((dimension) => ({
            serviceId: dimension.serviceId,
            models: [...dimension.models],
        })),
        selected: {
            filter,
            totals: aggregateTranslationStatsTotals(selected),
        },
        timeline: buildTimeline(selected, filter.range, generatedAt),
        breakdown: buildBreakdown(selected),
        routes: buildTranslationRouteBreakdown((options.routeRollups ?? []).filter((rollup) => (
            (!filter.serviceId || rollup.serviceId === filter.serviceId)
            && rollup.bucketStart >= rangeStart
            && rollup.bucketStart <= generatedAt
        ))),
    };
}
