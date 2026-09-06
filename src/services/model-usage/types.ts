/**
 * @file src/services/model-usage/types.ts
 * 文件职责：定义大模型上游调用事件、筛选条件、请求日志、数据迁移与设置页统计快照的共享数据合同。
 * 主要内容：声明时间范围、用途、结果、Token 与缓存可用性、汇总指标、时间线、服务模型维度、请求游标分页和导入导出类型。
 * 模块边界：本文件只描述本地统计数据形状，不读取浏览器存储、不解析供应商响应，也不包含设置页展示逻辑。
 */

export const MODEL_USAGE_SCHEMA_VERSION = 1 as const;
export const MODEL_USAGE_TRANSFER_FORMAT = 'fluentread-model-usage' as const;
export const MODEL_USAGE_TRANSFER_VERSION = 1 as const;
export const MODEL_USAGE_REQUEST_PAGE_SIZE = 20 as const;
export const MODEL_USAGE_REQUEST_MAX_PAGE_SIZE = 100 as const;
export const MODEL_USAGE_MAX_STORED_EVENTS = 1_000 as const;
export const MODEL_USAGE_TRANSFER_MAX_EVENTS = 250_000 as const;
export const MODEL_USAGE_TRANSFER_MAX_BYTES = 128 * 1024 * 1024;

export type Range = 'today' | '7d' | '30d';
export type ModelUsagePurpose = 'translation' | 'page-summary' | 'connection-test' | 'reading' | 'writing';
export type ModelUsageOutcome = 'success' | 'error' | 'timeout' | 'cancelled';
export type ModelUsageAvailability = 'reported' | 'unreported' | 'malformed';
export type ModelUsageCacheStatus = 'hit' | 'miss' | 'unreported';

/** 一条事件只代表一次真实上游尝试；仓库会为缺少 id 的内部事件生成唯一标识。 */
export interface ModelUsageEvent {
    id?: string;
    schemaVersion?: typeof MODEL_USAGE_SCHEMA_VERSION;
    startedAt: number;
    durationMs: number;
    serviceId: string;
    configuredModel: string;
    actualModel?: string;
    purpose: ModelUsagePurpose;
    outcome: ModelUsageOutcome;
    usageAvailability: ModelUsageAvailability;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    statusCode?: number;
}

/** IndexedDB 中的事件只包含白名单字段，并补齐稳定主键与实际聚合模型。 */
export interface StoredModelUsageEvent extends Omit<ModelUsageEvent, 'id' | 'schemaVersion'> {
    id: string;
    schemaVersion: typeof MODEL_USAGE_SCHEMA_VERSION;
    model: string;
}

export interface Filter {
    range: Range;
    serviceId?: string;
    model?: string;
}

export interface Totals {
    requestCount: number;
    successfulRequests: number;
    failedRequests: number;
    errorRequests: number;
    timeoutRequests: number;
    cancelledRequests: number;
    reportedTokenRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    cacheReportedRequests: number;
    cacheHitRequests: number;
    cacheEligibleInputTokens: number;
    cacheEligibleOutputTokens: number;
    cacheTokenHitRate: number | null;
    cacheRequestHitRate: number | null;
    cacheCoverageRate: number | null;
    reasoningTokens: number;
    averageDurationMs: number | null;
    averageTokensPerReportedRequest: number | null;
    averageInputTokensPerReportedRequest: number | null;
    averageOutputTokensPerReportedRequest: number | null;
    averageUncachedInputTokensPerCacheReportedRequest: number | null;
    averageCachedInputTokensPerCacheReportedRequest: number | null;
    averageOutputTokensPerCacheReportedRequest: number | null;
    uncachedInputTokenShare: number | null;
    cachedInputTokenShare: number | null;
    outputTokenShare: number | null;
}

export interface ModelUsageDimension {
    serviceId: string;
    models: string[];
}

export interface ModelUsageMetrics {
    today: Totals;
    sevenDays: Totals;
    thirtyDays: Totals;
}

export interface ModelUsageTimelinePoint {
    key: string;
    label: string;
    startedAt: number;
    totals: Totals;
}

export interface ModelUsageBreakdownItem {
    serviceId: string;
    model: string;
    totals: Totals;
}

export interface DashboardSnapshot {
    generatedAt: number;
    recordingStartedAt: number | null;
    dimensions: ModelUsageDimension[];
    metrics: ModelUsageMetrics;
    selected: {
        filter: Filter;
        totals: Totals;
    };
    timeline: ModelUsageTimelinePoint[];
    breakdown: ModelUsageBreakdownItem[];
}

/** 请求日志沿用顶部范围、服务和模型筛选，并可进一步收窄调用场景与结果。 */
export interface ModelUsageRequestFilter extends Filter {
    purpose?: ModelUsagePurpose;
    outcome?: ModelUsageOutcome;
    cacheStatus?: ModelUsageCacheStatus;
}

/** startedAt 与 id 共同形成稳定倒序游标，避免新请求插入时重复或跳过旧记录。 */
export interface ModelUsageRequestCursor {
    startedAt: number;
    id: string;
}

export interface ModelUsageRequestQuery {
    filter: ModelUsageRequestFilter;
    cursor?: ModelUsageRequestCursor;
    limit?: number;
}

export interface ModelUsageRequestPage {
    generatedAt: number;
    filter: ModelUsageRequestFilter;
    items: StoredModelUsageEvent[];
    totalCount: number;
    nextCursor: ModelUsageRequestCursor | null;
}

/** 导出事件刻意不携带仓库派生的 model 字段，导入时会从实际/配置模型重新计算。 */
export interface ModelUsageTransferEvent extends Omit<StoredModelUsageEvent, 'model'> {}

export interface ModelUsageTransferDocument {
    format: typeof MODEL_USAGE_TRANSFER_FORMAT;
    version: typeof MODEL_USAGE_TRANSFER_VERSION;
    exportedAt: number;
    events: ModelUsageTransferEvent[];
}

export interface ModelUsageImportResult {
    receivedCount: number;
    importedCount: number;
    duplicateCount: number;
}

// 保留带领域前缀的别名，方便 recorder 和未来非 UI 调用方获得自说明类型。
export type ModelUsageRange = Range;
export type ModelUsageFilter = Filter;
export type ModelUsageTotals = Totals;
export type ModelUsageDashboardSnapshot = DashboardSnapshot;
