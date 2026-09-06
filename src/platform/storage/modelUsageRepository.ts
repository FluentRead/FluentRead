/**
 * @file src/platform/storage/modelUsageRepository.ts
 * 文件职责：在扩展后台专属 IndexedDB 中永久保存脱敏的大模型上游调用事件，并提供统计、请求日志、迁移与独立重置能力。
 * 主要内容：定义 FluentReadModelUsage Dexie 数据库、严格事件白名单、稳定游标分页、幂等批量写入、最近 1000 条记录保留、版本化导入导出，以及最近三十日聚合和全历史维度查询。
 * 模块边界：本文件只拥有模型用量的本地持久化适配，不采集网页文本、不读取 API Key，也不注册 runtime 消息或渲染设置页面。
 */

import Dexie, {type Table} from 'dexie';
import {
    buildModelUsageDashboard,
    getModelUsageRangeStart,
    normalizeModelUsageFilter,
} from '@/src/services/model-usage/aggregation';
import {
    MODEL_USAGE_SCHEMA_VERSION,
    MODEL_USAGE_MAX_STORED_EVENTS,
    MODEL_USAGE_REQUEST_MAX_PAGE_SIZE,
    MODEL_USAGE_REQUEST_PAGE_SIZE,
    MODEL_USAGE_TRANSFER_FORMAT,
    MODEL_USAGE_TRANSFER_MAX_BYTES,
    MODEL_USAGE_TRANSFER_MAX_EVENTS,
    MODEL_USAGE_TRANSFER_VERSION,
    type DashboardSnapshot,
    type Filter,
    type ModelUsageImportResult,
    type ModelUsageAvailability,
    type ModelUsageEvent,
    type ModelUsageOutcome,
    type ModelUsagePurpose,
    type ModelUsageRequestFilter,
    type ModelUsageRequestPage,
    type ModelUsageRequestQuery,
    type ModelUsageTransferDocument,
    type ModelUsageTransferEvent,
    type StoredModelUsageEvent,
} from '@/src/services/model-usage/types';

export const MODEL_USAGE_DATABASE_NAME = 'FluentReadModelUsage' as const;
export const MODEL_USAGE_DATABASE_VERSION = 2 as const;

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const PURPOSES = new Set<ModelUsagePurpose>(['translation', 'page-summary', 'connection-test', 'reading', 'writing']);
const OUTCOMES = new Set<ModelUsageOutcome>(['success', 'error', 'timeout', 'cancelled']);
const AVAILABILITIES = new Set<ModelUsageAvailability>(['reported', 'unreported', 'malformed']);
const TRANSFER_DOCUMENT_KEYS = new Set(['format', 'version', 'exportedAt', 'events']);
const TRANSFER_EVENT_KEYS = new Set([
    'id',
    'schemaVersion',
    'startedAt',
    'durationMs',
    'serviceId',
    'configuredModel',
    'actualModel',
    'purpose',
    'outcome',
    'usageAvailability',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'statusCode',
]);
let generatedEventSequence = 0;

export class FluentReadModelUsageDatabase extends Dexie {
    events!: Table<StoredModelUsageEvent, string>;

    constructor(name: string = MODEL_USAGE_DATABASE_NAME) {
        super(name);
        this.version(1).stores({
            events: '&id, startedAt, serviceId, model, [serviceId+model], purpose, outcome, usageAvailability',
        });
        this.version(MODEL_USAGE_DATABASE_VERSION).stores({
            events: '&id, startedAt, [startedAt+id], serviceId, model, [serviceId+model], purpose, outcome, usageAvailability',
        });
    }
}

function requiredIdentifier(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new TypeError(`模型用量事件 ${field} 必须是字符串`);
    const normalized = value
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_IDENTIFIER_LENGTH);
    if (!normalized) throw new TypeError(`模型用量事件 ${field} 不能为空`);
    return normalized;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    return requiredIdentifier(value, field);
}

function finiteNonNegative(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
        throw new TypeError(`模型用量事件 ${field} 必须是非负有限数字`);
    }
    return value;
}

function optionalTokenCount(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`模型用量事件 ${field} 必须是非负安全整数`);
    }
    return value;
}

function optionalStatusCode(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
        throw new TypeError('模型用量事件 statusCode 必须是有效 HTTP 状态码');
    }
    return value;
}

function createEventId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    generatedEventSequence = (generatedEventSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `usage-${Date.now().toString(36)}-${generatedEventSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeEventId(value: unknown): string {
    if (value === undefined) return createEventId();
    if (typeof value !== 'string') throw new TypeError('模型用量事件 id 必须是字符串');
    const id = value.trim();
    if (!id || id.length > MAX_EVENT_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/u.test(id)) {
        throw new TypeError('模型用量事件 id 格式无效');
    }
    return id;
}

/** 只重建允许持久化的数值与标识字段，调用方附带的文本、URL 或凭据不会进入数据库。 */
export function normalizeStoredModelUsageEvent(event: ModelUsageEvent): StoredModelUsageEvent {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError('模型用量事件必须是对象');
    }
    if (event.schemaVersion !== undefined && event.schemaVersion !== MODEL_USAGE_SCHEMA_VERSION) {
        throw new TypeError('模型用量事件版本不受支持');
    }
    if (!PURPOSES.has(event.purpose)) throw new TypeError('模型用量事件 purpose 无效');
    if (!OUTCOMES.has(event.outcome)) throw new TypeError('模型用量事件 outcome 无效');
    if (!AVAILABILITIES.has(event.usageAvailability)) {
        throw new TypeError('模型用量事件 usageAvailability 无效');
    }

    const configuredModel = requiredIdentifier(event.configuredModel || 'unknown', 'configuredModel');
    const actualModel = optionalIdentifier(event.actualModel, 'actualModel');
    const numericFields = optionalNumericFields(event);
    if (
        event.usageAvailability === 'reported'
        && [numericFields.inputTokens, numericFields.outputTokens, numericFields.totalTokens]
            .some((value) => value === undefined)
    ) {
        throw new TypeError('模型用量事件已上报 usage 必须包含输入、输出和总 Token');
    }
    if (
        event.usageAvailability !== 'reported'
        && [
            numericFields.inputTokens,
            numericFields.outputTokens,
            numericFields.totalTokens,
            numericFields.cachedInputTokens,
            numericFields.cacheWriteTokens,
            numericFields.reasoningTokens,
        ].some((value) => value !== undefined)
    ) {
        throw new TypeError('模型用量事件未上报或异常 usage 不能携带 Token 明细');
    }
    if (
        numericFields.inputTokens !== undefined
        && (
            (numericFields.cachedInputTokens ?? 0) > numericFields.inputTokens
            || (numericFields.cacheWriteTokens ?? 0) > numericFields.inputTokens
            || (numericFields.cachedInputTokens ?? 0) + (numericFields.cacheWriteTokens ?? 0)
                > numericFields.inputTokens
        )
    ) {
        throw new TypeError('模型用量事件缓存 Token 不能超过输入 Token');
    }
    return {
        id: normalizeEventId(event.id),
        schemaVersion: MODEL_USAGE_SCHEMA_VERSION,
        startedAt: finiteNonNegative(event.startedAt, 'startedAt', MAX_TIMESTAMP),
        durationMs: finiteNonNegative(event.durationMs, 'durationMs'),
        serviceId: requiredIdentifier(event.serviceId, 'serviceId'),
        configuredModel,
        ...(actualModel ? {actualModel} : {}),
        model: actualModel || configuredModel,
        purpose: event.purpose,
        outcome: event.outcome,
        usageAvailability: event.usageAvailability,
        ...numericFields,
    };
}

function optionalNumericFields(event: ModelUsageEvent): Pick<
StoredModelUsageEvent,
'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'statusCode'
> {
    const inputTokens = optionalTokenCount(event.inputTokens, 'inputTokens');
    const outputTokens = optionalTokenCount(event.outputTokens, 'outputTokens');
    const totalTokens = optionalTokenCount(event.totalTokens, 'totalTokens');
    const cachedInputTokens = optionalTokenCount(event.cachedInputTokens, 'cachedInputTokens');
    const cacheWriteTokens = optionalTokenCount(event.cacheWriteTokens, 'cacheWriteTokens');
    const reasoningTokens = optionalTokenCount(event.reasoningTokens, 'reasoningTokens');
    const statusCode = optionalStatusCode(event.statusCode);
    return {
        ...(inputTokens !== undefined ? {inputTokens} : {}),
        ...(outputTokens !== undefined ? {outputTokens} : {}),
        ...(totalTokens !== undefined ? {totalTokens} : {}),
        ...(cachedInputTokens !== undefined ? {cachedInputTokens} : {}),
        ...(cacheWriteTokens !== undefined ? {cacheWriteTokens} : {}),
        ...(reasoningTokens !== undefined ? {reasoningTokens} : {}),
        ...(statusCode !== undefined ? {statusCode} : {}),
    };
}

function sameEvent(left: StoredModelUsageEvent, right: StoredModelUsageEvent): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeRequestFilter(filter: ModelUsageRequestFilter): ModelUsageRequestFilter {
    const normalized = normalizeModelUsageFilter(filter);
    if (filter.purpose !== undefined && !PURPOSES.has(filter.purpose)) {
        throw new TypeError('模型用量请求筛选 purpose 无效');
    }
    if (filter.outcome !== undefined && !OUTCOMES.has(filter.outcome)) {
        throw new TypeError('模型用量请求筛选 outcome 无效');
    }
    if (filter.cacheStatus !== undefined && !['hit', 'miss', 'unreported'].includes(filter.cacheStatus)) {
        throw new TypeError('模型用量请求筛选 cacheStatus 无效');
    }
    return {
        ...normalized,
        ...(filter.purpose ? {purpose: filter.purpose} : {}),
        ...(filter.outcome ? {outcome: filter.outcome} : {}),
        ...(filter.cacheStatus ? {cacheStatus: filter.cacheStatus} : {}),
    };
}

function normalizeRequestLimit(value: unknown): number {
    if (value === undefined) return MODEL_USAGE_REQUEST_PAGE_SIZE;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MODEL_USAGE_REQUEST_MAX_PAGE_SIZE) {
        throw new TypeError(`模型用量请求分页 limit 必须是 1-${MODEL_USAGE_REQUEST_MAX_PAGE_SIZE} 的整数`);
    }
    return value as number;
}

function normalizeRequestCursor(value: ModelUsageRequestQuery['cursor']): ModelUsageRequestQuery['cursor'] {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('模型用量请求游标必须是对象');
    }
    if (typeof value.id !== 'string') throw new TypeError('模型用量请求游标 id 必须是字符串');
    return {
        startedAt: finiteNonNegative(value.startedAt, 'cursor.startedAt', MAX_TIMESTAMP),
        id: normalizeEventId(value.id),
    };
}

function matchesRequestFilter(event: StoredModelUsageEvent, filter: ModelUsageRequestFilter): boolean {
    const cacheMatches = !filter.cacheStatus
        || (filter.cacheStatus === 'hit' && typeof event.cachedInputTokens === 'number' && event.cachedInputTokens > 0)
        || (filter.cacheStatus === 'miss' && event.cachedInputTokens === 0)
        || (filter.cacheStatus === 'unreported' && event.cachedInputTokens === undefined);
    return cacheMatches
        && (!filter.serviceId || event.serviceId === filter.serviceId)
        && (!filter.model || event.model === filter.model)
        && (!filter.purpose || event.purpose === filter.purpose)
        && (!filter.outcome || event.outcome === filter.outcome);
}

function isBeforeCursor(event: StoredModelUsageEvent, cursor: ModelUsageRequestQuery['cursor']): boolean {
    return !cursor
        || event.startedAt < cursor.startedAt
        || (event.startedAt === cursor.startedAt && event.id < cursor.id);
}

function toTransferEvent(event: StoredModelUsageEvent): ModelUsageTransferEvent {
    const {model: _derivedModel, ...transferEvent} = event;
    return transferEvent;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
    const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
    if (unknownKey) throw new TypeError(`${label} 包含不支持的字段 ${unknownKey}`);
}

function serializedByteLength(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
        throw new TypeError('模型用量导入文件无法序列化');
    }
}

/** 导入先完整白名单化所有事件；任一非法项都会在事务开始前拒绝整份文件。 */
export function parseModelUsageTransferDocument(value: unknown): ModelUsageTransferDocument {
    if (!isPlainRecord(value)) throw new TypeError('模型用量导入文件必须是对象');
    assertOnlyKeys(value, TRANSFER_DOCUMENT_KEYS, '模型用量导入文件');
    if (serializedByteLength(value) > MODEL_USAGE_TRANSFER_MAX_BYTES) {
        throw new TypeError('模型用量导入文件超过 128 MiB 上限');
    }
    if (value.format !== MODEL_USAGE_TRANSFER_FORMAT) throw new TypeError('模型用量导入文件类型无效');
    if (value.version !== MODEL_USAGE_TRANSFER_VERSION) throw new TypeError('模型用量导入文件版本不受支持');
    const exportedAt = finiteNonNegative(value.exportedAt, 'exportedAt', MAX_TIMESTAMP);
    if (!Array.isArray(value.events)) throw new TypeError('模型用量导入文件 events 必须是数组');
    if (value.events.length > MODEL_USAGE_TRANSFER_MAX_EVENTS) {
        throw new TypeError(`模型用量导入文件最多包含 ${MODEL_USAGE_TRANSFER_MAX_EVENTS} 条事件`);
    }

    const events = value.events.map((candidate, index) => {
        if (!isPlainRecord(candidate)) throw new TypeError(`模型用量导入事件 ${index + 1} 必须是对象`);
        assertOnlyKeys(candidate, TRANSFER_EVENT_KEYS, `模型用量导入事件 ${index + 1}`);
        if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
            throw new TypeError(`模型用量导入事件 ${index + 1} 缺少稳定 id`);
        }
        if (candidate.schemaVersion !== MODEL_USAGE_SCHEMA_VERSION) {
            throw new TypeError(`模型用量导入事件 ${index + 1} 版本不受支持`);
        }
        return toTransferEvent(normalizeStoredModelUsageEvent(candidate as unknown as ModelUsageEvent));
    });
    return {
        format: MODEL_USAGE_TRANSFER_FORMAT,
        version: MODEL_USAGE_TRANSFER_VERSION,
        exportedAt,
        events,
    };
}

/** 每次写入后按请求开始时间和事件 id 保留最近记录，避免模型用量库无限增长。 */
async function pruneStoredModelUsageEvents(
    events: Table<StoredModelUsageEvent, string>,
): Promise<void> {
    const ordered = await events.orderBy('[startedAt+id]').toArray();
    const overflowCount = ordered.length - MODEL_USAGE_MAX_STORED_EVENTS;
    if (overflowCount <= 0) return;
    await events.bulkDelete(ordered.slice(0, overflowCount).map((event) => event.id));
}

export class ModelUsageRepository {
    private usageGeneration = 0;

    constructor(readonly database: FluentReadModelUsageDatabase = new FluentReadModelUsageDatabase()) {}

    /** Provider 在发起真实请求前同步捕获；reset 会立即推进代次，使旧请求后续写入失效。 */
    captureGeneration(): number {
        return this.usageGeneration;
    }

    /** 整批先完成白名单重建，再在一个事务中补写缺失事件；相同 id 的重试保持幂等。 */
    async recordMany(
        events: readonly ModelUsageEvent[],
        expectedGeneration = this.usageGeneration,
    ): Promise<number> {
        if (events.length === 0) return 0;
        const normalized = events.map(normalizeStoredModelUsageEvent);
        if (expectedGeneration !== this.usageGeneration) return 0;
        const unique = new Map<string, StoredModelUsageEvent>();
        for (const event of normalized) {
            const previous = unique.get(event.id);
            if (previous && !sameEvent(previous, event)) {
                throw new Error(`模型用量事件 id 冲突: ${event.id}`);
            }
            unique.set(event.id, event);
        }

        return this.database.transaction('rw', this.database.events, async () => {
            const candidates = [...unique.values()];
            const existing = await this.database.events.bulkGet(candidates.map((event) => event.id));
            // clear 可在 bulkGet 等待期间同步推进 generation；此时不得再补写旧请求。
            if (expectedGeneration !== this.usageGeneration) return 0;
            const pending: StoredModelUsageEvent[] = [];
            candidates.forEach((event, index) => {
                const stored = existing[index];
                if (!stored) {
                    pending.push(event);
                    return;
                }
                if (!sameEvent(stored, event)) throw new Error(`模型用量事件 id 冲突: ${event.id}`);
            });
            if (pending.length > 0) await this.database.events.bulkAdd(pending);
            await pruneStoredModelUsageEvents(this.database.events);
            return pending.length;
        });
    }

    async getDashboard(filter: Filter = {range: '30d'}, now = Date.now()): Promise<DashboardSnapshot> {
        const normalizedFilter = normalizeModelUsageFilter(filter);
        const recentStart = getModelUsageRangeStart('30d', now);
        const [events, first, dimensionKeys] = await this.database.transaction(
            'r',
            this.database.events,
            async () => Promise.all([
                this.database.events.where('startedAt').between(recentStart, now, true, true).toArray(),
                this.database.events.orderBy('startedAt').first(),
                this.database.events.orderBy('[serviceId+model]').uniqueKeys(),
            ]),
        );
        const modelsByService = new Map<string, Set<string>>();
        for (const key of dimensionKeys) {
            if (!Array.isArray(key) || typeof key[0] !== 'string' || typeof key[1] !== 'string') continue;
            const models = modelsByService.get(key[0]) ?? new Set<string>();
            models.add(key[1]);
            modelsByService.set(key[0], models);
        }
        const dimensions = [...modelsByService]
            .map(([serviceId, models]) => ({serviceId, models: [...models].sort((a, b) => a.localeCompare(b))}))
            .sort((a, b) => a.serviceId.localeCompare(b.serviceId));

        return buildModelUsageDashboard(events, normalizedFilter, {
            now,
            recordingStartedAt: first?.startedAt ?? null,
            dimensions,
        });
    }

    /** 逐请求列表使用 startedAt+id 复合索引倒序读取，limit 始终有上限且不会塞进聚合快照。 */
    async getRequestLog(
        query: ModelUsageRequestQuery = {filter: {range: '30d'}},
        now = Date.now(),
    ): Promise<ModelUsageRequestPage> {
        const filter = normalizeRequestFilter(query.filter);
        const cursor = normalizeRequestCursor(query.cursor);
        const limit = normalizeRequestLimit(query.limit);
        const rangeStart = getModelUsageRangeStart(filter.range, now);
        const baseCollection = () => this.database.events
            .where('[startedAt+id]')
            .between([rangeStart, ''], [now, '\uffff'], true, true)
            .reverse()
            .filter((event) => matchesRequestFilter(event, filter));

        const [pageCandidates, totalCount] = await this.database.transaction(
            'r',
            this.database.events,
            async () => Promise.all([
                baseCollection()
                    .filter((event) => isBeforeCursor(event, cursor))
                    .limit(limit + 1)
                    .toArray(),
                baseCollection().count(),
            ]),
        );
        const hasMore = pageCandidates.length > limit;
        const items = pageCandidates.slice(0, limit);
        const last = hasMore ? items.at(-1) : undefined;
        return {
            generatedAt: now,
            filter,
            items,
            totalCount,
            nextCursor: last ? {startedAt: last.startedAt, id: last.id} : null,
        };
    }

    async exportData(exportedAt = Date.now()): Promise<ModelUsageTransferDocument> {
        const events = await this.database.events.orderBy('[startedAt+id]').toArray();
        if (events.length > MODEL_USAGE_TRANSFER_MAX_EVENTS) {
            throw new Error(`模型用量单次最多导出 ${MODEL_USAGE_TRANSFER_MAX_EVENTS} 条事件`);
        }
        const document: ModelUsageTransferDocument = {
            format: MODEL_USAGE_TRANSFER_FORMAT,
            version: MODEL_USAGE_TRANSFER_VERSION,
            exportedAt: finiteNonNegative(exportedAt, 'exportedAt', MAX_TIMESTAMP),
            events: events.map(toTransferEvent),
        };
        if (serializedByteLength(document) > MODEL_USAGE_TRANSFER_MAX_BYTES) {
            throw new Error('模型用量导出文件超过 128 MiB 上限');
        }
        return document;
    }

    /** 导入只合并白名单事件：相同 id 同内容幂等跳过，相同 id 异内容会让整批事务回滚。 */
    async importData(value: unknown): Promise<ModelUsageImportResult> {
        const document = parseModelUsageTransferDocument(value);
        const importedCount = await this.recordMany(document.events, this.usageGeneration);
        return {
            receivedCount: document.events.length,
            importedCount,
            duplicateCount: document.events.length - importedCount,
        };
    }

    /** 重置只清空模型用量事件表，不删除翻译缓存、配置、词书或其他 IndexedDB。 */
    async clear(): Promise<void> {
        // 必须在第一个 await 前推进代次，确保清除进行中完成的旧 provider 立即失效。
        this.usageGeneration += 1;
        await this.database.events.clear();
    }
}

export const modelUsageDb = new FluentReadModelUsageDatabase();
export const modelUsageRepository = new ModelUsageRepository(modelUsageDb);
