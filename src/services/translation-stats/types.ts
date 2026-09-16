/**
 * @file src/services/translation-stats/types.ts
 * 文件职责：定义翻译请求统计的事件、小时汇总、筛选条件、设置页快照与请求记录分页的共享数据合同。
 * 主要内容：声明时间范围、请求来源与结果、耗时和文本规模分桶边界、保留上限、逐请求事件与线路尝试、按小时聚合的服务模型与线路汇总行、服务与线路表现、趋势点和记录查询类型。
 * 模块边界：本文件只描述统计数据形状与常量，不读取浏览器存储、不计算聚合、不接触翻译 broker 或设置页组件。
 */

export const TRANSLATION_STATS_SCHEMA_VERSION = 1 as const;
/** 逐请求记录只保留最近一段，长期指标由小时汇总承担。 */
export const TRANSLATION_STATS_MAX_STORED_REQUESTS = 5_000 as const;
export const TRANSLATION_STATS_ROLLUP_RETENTION_DAYS = 90 as const;
export const TRANSLATION_STATS_REQUEST_PAGE_SIZE = 20 as const;
/** 单次请求最多保留的线路尝试与线路标识数量，避免超大批量把统计事件撑大。 */
export const TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS = 200 as const;
export const TRANSLATION_STATS_MAX_REQUEST_ROUTES = 12 as const;
export const TRANSLATION_STATS_REQUEST_MAX_PAGE_SIZE = 100 as const;

/** 耗时分桶上界（毫秒）；最后一个桶收纳超过最大上界的请求。 */
export const TRANSLATION_STATS_DURATION_BOUNDS_MS = [100, 250, 500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 20_000, 30_000] as const;
/** 文本规模分桶上界（字符）；最后一个桶收纳超过最大上界的请求。 */
export const TRANSLATION_STATS_SIZE_BOUNDS_CHARS = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000] as const;

export type TranslationStatsRange = 'today' | '7d' | '30d';
export type TranslationRequestOutcome = 'success' | 'error' | 'timeout' | 'cancelled';
/**
 * network：至少部分原文需要请求服务且没有复用缓存；cache：全部原文来自缓存；
 * partial：批量中部分命中缓存；shared：复用了进行中的相同请求。
 */
export type TranslationRequestSource = 'network' | 'cache' | 'partial' | 'shared';
export type TranslationRequestMode = 'single' | 'batch' | 'image';
export type TranslationStatsErrorKind =
    | 'authentication'
    | 'rate-limit'
    | 'timeout'
    | 'network'
    | 'bad-request'
    | 'provider'
    | 'response'
    | 'unknown';

export const TRANSLATION_REQUEST_OUTCOMES: readonly TranslationRequestOutcome[] = ['success', 'error', 'timeout', 'cancelled'];
export const TRANSLATION_REQUEST_SOURCES: readonly TranslationRequestSource[] = ['network', 'cache', 'partial', 'shared'];
export const TRANSLATION_REQUEST_MODES: readonly TranslationRequestMode[] = ['single', 'batch', 'image'];
export const TRANSLATION_STATS_ERROR_KINDS: readonly TranslationStatsErrorKind[] = [
    'authentication', 'rate-limit', 'timeout', 'network', 'bad-request', 'provider', 'response', 'unknown',
];

/** 免费翻译等内部多线路服务的一次线路尝试；一次请求可能包含多次尝试。 */
export interface TranslationRouteAttempt {
    route: string;
    outcome: TranslationRequestOutcome;
    durationMs: number;
    chars: number;
}

/** Broker 在一次翻译请求结束后产生的事件，只包含时间、标识和数值。 */
export interface TranslationRequestStatsEvent {
    id?: string;
    schemaVersion?: typeof TRANSLATION_STATS_SCHEMA_VERSION;
    startedAt: number;
    durationMs: number;
    serviceId: string;
    /** AI 服务实际请求的模型；机器翻译为空。 */
    model?: string;
    mode: TranslationRequestMode;
    segmentCount: number;
    sourceChars: number;
    /** 原文 UTF-8 字节数，图片请求另加图片解码后的字节数。 */
    sourceBytes: number;
    resultChars?: number;
    source: TranslationRequestSource;
    cachedSegments: number;
    upstreamCalls: number;
    upstreamMs: number;
    outcome: TranslationRequestOutcome;
    errorKind?: TranslationStatsErrorKind;
    statusCode?: number;
    /** 本次请求实际用到的内部线路标识（免费翻译链）。 */
    routes?: readonly string[];
    /** 逐次线路尝试；只折叠进线路汇总，不随请求记录保存。 */
    routeAttempts?: readonly TranslationRouteAttempt[];
}

export interface StoredTranslationRequestEvent extends Omit<TranslationRequestStatsEvent, 'id' | 'schemaVersion' | 'model' | 'routes' | 'routeAttempts'> {
    id: string;
    schemaVersion: typeof TRANSLATION_STATS_SCHEMA_VERSION;
    model: string;
    routes: string[];
}

/** 以本地小时、服务和线路为主键的尝试累计；耗时只统计成功的尝试。 */
export interface TranslationRouteRollup {
    bucketStart: number;
    serviceId: string;
    route: string;
    schemaVersion: typeof TRANSLATION_STATS_SCHEMA_VERSION;
    attemptCount: number;
    outcomes: Record<TranslationRequestOutcome, number>;
    chars: number;
    maxChars: number;
    latencyCount: number;
    latencyDurationMs: number;
    latencyMaxDurationMs: number;
    durationHistogram: number[];
}

export interface TranslationRouteTotals {
    attemptCount: number;
    outcomes: Record<TranslationRequestOutcome, number>;
    successRate: number | null;
    chars: number;
    maxChars: number;
    averageChars: number | null;
    latencyCount: number;
    averageDurationMs: number | null;
    medianDurationMs: number | null;
    p95DurationMs: number | null;
    maxDurationMs: number | null;
    durationHistogram: number[];
}

export interface TranslationRouteBreakdownItem {
    serviceId: string;
    route: string;
    totals: TranslationRouteTotals;
}

/** 以本地小时、服务和模型为主键的累计值；耗时字段只统计成功且实际请求服务的翻译。 */
export interface TranslationStatsRollup {
    bucketStart: number;
    serviceId: string;
    model: string;
    schemaVersion: typeof TRANSLATION_STATS_SCHEMA_VERSION;
    requestCount: number;
    outcomes: Record<TranslationRequestOutcome, number>;
    sources: Record<TranslationRequestSource, number>;
    errorKinds: Record<TranslationStatsErrorKind, number>;
    segmentCount: number;
    cachedSegments: number;
    sharedSegments: number;
    sourceChars: number;
    sourceBytes: number;
    resultChars: number;
    maxSourceChars: number;
    upstreamCalls: number;
    sizeHistogram: number[];
    latencyCount: number;
    latencyDurationMs: number;
    latencyMaxDurationMs: number;
    latencyUpstreamMs: number;
    latencySourceChars: number;
    durationHistogram: number[];
}

export interface TranslationStatsFilter {
    range: TranslationStatsRange;
    serviceId?: string;
    model?: string;
}

export interface TranslationStatsTotals {
    requestCount: number;
    outcomes: Record<TranslationRequestOutcome, number>;
    sources: Record<TranslationRequestSource, number>;
    errorKinds: Record<TranslationStatsErrorKind, number>;
    /** 成功 ÷（成功 + 错误 + 超时）；取消不计为失败。 */
    successRate: number | null;
    segmentCount: number;
    cachedSegments: number;
    sharedSegments: number;
    /** （缓存命中段落 + 复用进行中请求的段落）÷ 全部段落。 */
    reuseRate: number | null;
    sourceChars: number;
    sourceBytes: number;
    resultChars: number;
    maxSourceChars: number;
    averageSourceChars: number | null;
    averageSegments: number | null;
    upstreamCalls: number;
    sizeHistogram: number[];
    latencyCount: number;
    averageDurationMs: number | null;
    medianDurationMs: number | null;
    p95DurationMs: number | null;
    maxDurationMs: number | null;
    averageUpstreamMs: number | null;
    charsPerSecond: number | null;
    durationHistogram: number[];
}

export interface TranslationStatsDimension {
    serviceId: string;
    models: string[];
}

export interface TranslationStatsTimelinePoint {
    key: string;
    label: string;
    startedAt: number;
    totals: TranslationStatsTotals;
}

export interface TranslationStatsBreakdownItem {
    serviceId: string;
    model: string;
    totals: TranslationStatsTotals;
}

export interface TranslationStatsSnapshot {
    generatedAt: number;
    recordingStartedAt: number | null;
    dimensions: TranslationStatsDimension[];
    selected: {
        filter: TranslationStatsFilter;
        totals: TranslationStatsTotals;
    };
    timeline: TranslationStatsTimelinePoint[];
    breakdown: TranslationStatsBreakdownItem[];
    /** 免费翻译链等内部线路的尝试表现；没有线路数据时为空数组。 */
    routes: TranslationRouteBreakdownItem[];
}

export type TranslationStatsRequestSort = 'recent' | 'slowest';

export interface TranslationStatsRequestFilter extends TranslationStatsFilter {
    source?: TranslationRequestSource;
    outcome?: TranslationRequestOutcome;
}

export interface TranslationStatsRequestQuery {
    filter: TranslationStatsRequestFilter;
    sort?: TranslationStatsRequestSort;
    offset?: number;
    limit?: number;
}

export interface TranslationStatsRequestPage {
    generatedAt: number;
    filter: TranslationStatsRequestFilter;
    sort: TranslationStatsRequestSort;
    offset: number;
    limit: number;
    totalCount: number;
    items: StoredTranslationRequestEvent[];
}
