/**
 * @file src/platform/storage/translationStatsRepository.ts
 * 文件职责：在扩展后台专属 IndexedDB 中保存翻译请求统计，提供低开销的缓冲写入、设置页快照、请求记录分页与独立清除能力。
 * 主要内容：定义 FluentReadTranslationStats Dexie 数据库、事件与线路尝试白名单归一化、按代次失效的内存队列、事务内追加最近请求并折叠服务与线路小时汇总、超额记录与过期汇总清理，以及串行化的读写与清除操作。
 * 模块边界：本文件只拥有翻译统计的本地持久化适配，只接受数值与标识字段；不注册 runtime 消息、不计算界面格式，也不参与翻译结果或缓存。
 */

import Dexie, {type Table} from 'dexie';
import {
    buildTranslationStatsSnapshot,
    collectTranslationStatsDimensions,
    createTranslationRouteRollup,
    createTranslationStatsRollup,
    foldTranslationRequestEvent,
    foldTranslationRouteAttempt,
    getTranslationStatsRangeStart,
    localHourBucketStart,
    normalizeTranslationStatsFilter,
    translationStatsRollupKey,
} from '@/src/services/translation-stats/aggregation';
import {
    TRANSLATION_REQUEST_MODES,
    TRANSLATION_REQUEST_OUTCOMES,
    TRANSLATION_REQUEST_SOURCES,
    TRANSLATION_STATS_ERROR_KINDS,
    TRANSLATION_STATS_MAX_STORED_REQUESTS,
    TRANSLATION_STATS_REQUEST_MAX_PAGE_SIZE,
    TRANSLATION_STATS_REQUEST_PAGE_SIZE,
    TRANSLATION_STATS_MAX_REQUEST_ROUTES,
    TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS,
    TRANSLATION_STATS_ROLLUP_RETENTION_DAYS,
    TRANSLATION_STATS_SCHEMA_VERSION,
    type StoredTranslationRequestEvent,
    type TranslationRouteAttempt,
    type TranslationRouteRollup,
    type TranslationRequestStatsEvent,
    type TranslationStatsFilter,
    type TranslationStatsRequestFilter,
    type TranslationStatsRequestPage,
    type TranslationStatsRequestQuery,
    type TranslationStatsRollup,
    type TranslationStatsSnapshot,
} from '@/src/services/translation-stats/types';

export const TRANSLATION_STATS_DATABASE_NAME = 'FluentReadTranslationStats' as const;
export const TRANSLATION_STATS_DATABASE_VERSION = 2 as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const DEFAULT_FLUSH_DELAY_MS = 1_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 100;
let generatedEventSequence = 0;

type RollupKey = [number, string, string];
type RouteRollupKey = [number, string, string];

export class FluentReadTranslationStatsDatabase extends Dexie {
    requests!: Table<StoredTranslationRequestEvent, string>;
    rollups!: Table<TranslationStatsRollup, RollupKey>;
    routes!: Table<TranslationRouteRollup, RouteRollupKey>;

    constructor(name: string = TRANSLATION_STATS_DATABASE_NAME) {
        super(name);
        this.version(1).stores({
            requests: '&id, startedAt, [startedAt+id]',
            rollups: '[bucketStart+serviceId+model], bucketStart, [serviceId+model]',
        });
        this.version(TRANSLATION_STATS_DATABASE_VERSION).stores({
            requests: '&id, startedAt, [startedAt+id]',
            rollups: '[bucketStart+serviceId+model], bucketStart, [serviceId+model]',
            routes: '[bucketStart+serviceId+route], bucketStart',
        });
    }
}

export interface TranslationStatsRepositoryOptions {
    flushDelayMs?: number;
    maxBufferedEvents?: number;
    maxStoredRequests?: number;
    rollupRetentionDays?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    warn?: (message: string, error: unknown) => void;
}

function identifier(value: unknown, field: string, allowEmpty: boolean): string {
    if (typeof value !== 'string') throw new TypeError(`翻译统计事件 ${field} 必须是字符串`);
    const normalized = value
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_IDENTIFIER_LENGTH);
    if (!normalized && !allowEmpty) throw new TypeError(`翻译统计事件 ${field} 不能为空`);
    return normalized;
}

function finiteNonNegative(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
        throw new TypeError(`翻译统计事件 ${field} 必须是非负有限数字`);
    }
    return value;
}

function count(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`翻译统计事件 ${field} 必须是非负整数`);
    }
    return value;
}

function member<T extends string>(value: unknown, values: readonly T[], field: string): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new TypeError(`翻译统计事件 ${field} 无效`);
    }
    return value as T;
}

function createEventId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    generatedEventSequence = (generatedEventSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `request-${Date.now().toString(36)}-${generatedEventSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 按白名单重建事件；调用方附带的其他字段不会进入数据库。 */
export function normalizeTranslationRequestEvent(event: TranslationRequestStatsEvent): StoredTranslationRequestEvent {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError('翻译统计事件必须是对象');
    }
    if (event.schemaVersion !== undefined && event.schemaVersion !== TRANSLATION_STATS_SCHEMA_VERSION) {
        throw new TypeError('翻译统计事件版本不受支持');
    }
    const outcome = member(event.outcome, TRANSLATION_REQUEST_OUTCOMES, 'outcome');
    const segmentCount = count(event.segmentCount, 'segmentCount');
    const cachedSegments = count(event.cachedSegments, 'cachedSegments');
    if (cachedSegments > segmentCount) throw new TypeError('翻译统计事件缓存段落不能超过请求段落');
    // 失败原因与状态码只是诊断补充：未知分类归入 unknown，无效状态码直接省略，不因此丢弃整条统计。
    const failed = outcome === 'error' || outcome === 'timeout';
    const errorKind = failed
        ? TRANSLATION_STATS_ERROR_KINDS.find((kind) => kind === event.errorKind) ?? 'unknown'
        : undefined;
    const statusCode = failed && Number.isInteger(event.statusCode) && event.statusCode! >= 100 && event.statusCode! <= 599
        ? event.statusCode
        : undefined;
    const resultChars = outcome === 'success' && event.resultChars !== undefined
        ? count(event.resultChars, 'resultChars')
        : undefined;
    return {
        id: event.id === undefined ? createEventId() : identifier(event.id, 'id', false),
        schemaVersion: TRANSLATION_STATS_SCHEMA_VERSION,
        startedAt: finiteNonNegative(event.startedAt, 'startedAt', MAX_TIMESTAMP),
        durationMs: finiteNonNegative(event.durationMs, 'durationMs'),
        serviceId: identifier(event.serviceId, 'serviceId', false),
        model: event.model === undefined ? '' : identifier(event.model, 'model', true),
        mode: member(event.mode, TRANSLATION_REQUEST_MODES, 'mode'),
        segmentCount,
        sourceChars: count(event.sourceChars, 'sourceChars'),
        sourceBytes: count(event.sourceBytes, 'sourceBytes'),
        ...(resultChars !== undefined ? {resultChars} : {}),
        source: member(event.source, TRANSLATION_REQUEST_SOURCES, 'source'),
        cachedSegments,
        upstreamCalls: count(event.upstreamCalls, 'upstreamCalls'),
        upstreamMs: finiteNonNegative(event.upstreamMs, 'upstreamMs'),
        outcome,
        ...(errorKind ? {errorKind} : {}),
        ...(statusCode !== undefined ? {statusCode} : {}),
        routes: normalizeRoutes(event.routes),
    };
}

/** 线路标识与尝试同样只保留白名单数值；非法项被丢弃而不是让整条统计失败。 */
export function normalizeTranslationRouteAttempts(value: unknown): TranslationRouteAttempt[] {
    if (!Array.isArray(value)) return [];
    const attempts: TranslationRouteAttempt[] = [];
    for (const candidate of value.slice(0, TRANSLATION_STATS_MAX_ROUTE_ATTEMPTS)) {
        if (!candidate || typeof candidate !== 'object') continue;
        const attempt = candidate as Partial<TranslationRouteAttempt>;
        const route = typeof attempt.route === 'string' ? identifier(attempt.route, 'route', true) : '';
        const outcome = TRANSLATION_REQUEST_OUTCOMES.find((value) => value === attempt.outcome);
        const durationMs = typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0
            ? attempt.durationMs
            : -1;
        const chars = typeof attempt.chars === 'number' && Number.isSafeInteger(attempt.chars) && attempt.chars >= 0
            ? attempt.chars
            : -1;
        if (route && outcome && durationMs >= 0 && chars >= 0) attempts.push({route, outcome, durationMs, chars});
    }
    return attempts;
}

function normalizeRoutes(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const routes = value
        .filter((route): route is string => typeof route === 'string')
        .map((route) => identifier(route, 'route', true))
        .filter(Boolean);
    return [...new Set(routes)].sort().slice(0, TRANSLATION_STATS_MAX_REQUEST_ROUTES);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`翻译统计请求记录 ${field} 必须是 ${minimum}-${maximum} 的整数`);
    }
    return value;
}

function matchesRequestFilter(event: StoredTranslationRequestEvent, filter: TranslationStatsRequestFilter): boolean {
    return (!filter.serviceId || event.serviceId === filter.serviceId)
        && (filter.model === undefined || event.model === filter.model)
        && (!filter.source || event.source === filter.source)
        && (!filter.outcome || event.outcome === filter.outcome);
}

export class TranslationStatsRepository {
    private generation = 0;
    private queue: Array<{event: StoredTranslationRequestEvent; attempts: TranslationRouteAttempt[]}> = [];
    private timer: unknown = null;
    private operations: Promise<void> = Promise.resolve();
    private readonly flushDelayMs: number;
    private readonly maxBufferedEvents: number;
    private readonly maxStoredRequests: number;
    private readonly rollupRetentionMs: number;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly warn: (message: string, error: unknown) => void;

    constructor(
        readonly database: FluentReadTranslationStatsDatabase = new FluentReadTranslationStatsDatabase(),
        options: TranslationStatsRepositoryOptions = {},
    ) {
        this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
        this.maxStoredRequests = options.maxStoredRequests ?? TRANSLATION_STATS_MAX_STORED_REQUESTS;
        this.rollupRetentionMs = (options.rollupRetentionDays ?? TRANSLATION_STATS_ROLLUP_RETENTION_DAYS) * DAY_MS;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.warn = options.warn ?? ((message, error) => console.warn(message, error));
    }

    /** 请求开始时捕获；清除统计会推进代次，使清除前发起、清除后结束的请求不再写回。 */
    captureGeneration(): number {
        return this.generation;
    }

    /** 同步入队并延迟合并写入，任何校验或存储问题都不会影响翻译调用方。 */
    record(event: TranslationRequestStatsEvent, expectedGeneration = this.generation): void {
        if (expectedGeneration !== this.generation) return;
        let normalized: StoredTranslationRequestEvent;
        try {
            normalized = normalizeTranslationRequestEvent(event);
        } catch (error) {
            this.warn('[FluentRead] translation stats event rejected:', error);
            return;
        }
        this.queue.push({event: normalized, attempts: normalizeTranslationRouteAttempts(event.routeAttempts)});
        if (this.queue.length >= this.maxBufferedEvents) {
            void this.flush();
            return;
        }
        if (this.timer === null) {
            this.timer = this.setTimer(() => {
                this.timer = null;
                void this.flush();
            }, this.flushDelayMs);
        }
    }

    /** 读写与清除共用一条串行链，保证清除不会被迟到的批量写入覆盖。 */
    private enqueue(operation: () => Promise<void>): Promise<void> {
        const run = this.operations.then(operation);
        this.operations = run.catch((error) => this.warn('[FluentRead] translation stats storage failed:', error));
        return run;
    }

    flush(): Promise<void> {
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        return this.enqueue(() => this.writeQueued());
    }

    private async writeQueued(): Promise<void> {
        const queued = this.queue.splice(0);
        if (queued.length === 0) return;
        const batch = queued.map((item) => item.event);
        const attempts = queued.flatMap((item) => item.attempts.map((attempt) => ({serviceId: item.event.serviceId, startedAt: item.event.startedAt, attempt})));
        const {requests, rollups, routes} = this.database;
        await this.database.transaction('rw', requests, rollups, routes, async () => {
            await requests.bulkPut(batch);

            const grouped = new Map<string, {key: RollupKey; events: StoredTranslationRequestEvent[]}>();
            for (const event of batch) {
                const key = translationStatsRollupKey(event);
                const id = JSON.stringify(key);
                const group = grouped.get(id) ?? {key, events: []};
                group.events.push(event);
                grouped.set(id, group);
            }
            const groups = [...grouped.values()];
            const existing = await rollups.bulkGet(groups.map((group) => group.key));
            await rollups.bulkPut(groups.map((group, index) => group.events.reduce(
                foldTranslationRequestEvent,
                existing[index] ?? createTranslationStatsRollup(...group.key),
            )));

            const routeGroups = new Map<string, {key: RouteRollupKey; attempts: TranslationRouteAttempt[]}>();
            for (const {serviceId, startedAt, attempt} of attempts) {
                const key: RouteRollupKey = [localHourBucketStart(startedAt), serviceId, attempt.route];
                const id = JSON.stringify(key);
                const group = routeGroups.get(id) ?? {key, attempts: []};
                group.attempts.push(attempt);
                routeGroups.set(id, group);
            }
            if (routeGroups.size > 0) {
                const groups = [...routeGroups.values()];
                const existing = await routes.bulkGet(groups.map((group) => group.key));
                await routes.bulkPut(groups.map((group, index) => group.attempts.reduce(
                    foldTranslationRouteAttempt,
                    existing[index] ?? createTranslationRouteRollup(...group.key),
                )));
            }

            const overflow = await requests.count() - this.maxStoredRequests;
            if (overflow > 0) {
                const expired = await requests.orderBy('[startedAt+id]').limit(overflow).primaryKeys();
                await requests.bulkDelete(expired);
            }
            const retentionCutoff = this.now() - this.rollupRetentionMs;
            await rollups.where('bucketStart').below(retentionCutoff).delete();
            await routes.where('bucketStart').below(retentionCutoff).delete();
        });
    }

    async getDashboard(filter: Partial<TranslationStatsFilter> = {}, now = this.now()): Promise<TranslationStatsSnapshot> {
        await this.flush();
        const normalized = normalizeTranslationStatsFilter(filter);
        const rangeStart = getTranslationStatsRangeStart(normalized.range, now);
        const {rollups, routes} = this.database;
        const [selected, first, dimensionKeys, routeRollups] = await this.database.transaction('r', rollups, routes, () => Promise.all([
            rollups.where('bucketStart').between(rangeStart, now, true, true).toArray(),
            rollups.orderBy('bucketStart').first(),
            rollups.orderBy('[serviceId+model]').uniqueKeys(),
            routes.where('bucketStart').between(rangeStart, now, true, true).toArray(),
        ]));
        const dimensions = collectTranslationStatsDimensions((dimensionKeys as unknown as Array<[string, string]>)
            .map(([serviceId, model]) => ({serviceId, model})));
        return buildTranslationStatsSnapshot(selected, normalized, {
            now,
            recordingStartedAt: first?.bucketStart ?? null,
            dimensions,
            routeRollups,
        });
    }

    /** 记录数量有固定上限，按范围读出后在内存排序分页即可满足最新与最慢两种视图。 */
    async getRequestLog(query: TranslationStatsRequestQuery, now = this.now()): Promise<TranslationStatsRequestPage> {
        await this.flush();
        const base = normalizeTranslationStatsFilter(query.filter);
        const filter: TranslationStatsRequestFilter = {
            ...base,
            ...(query.filter.source ? {source: member(query.filter.source, TRANSLATION_REQUEST_SOURCES, 'source')} : {}),
            ...(query.filter.outcome ? {outcome: member(query.filter.outcome, TRANSLATION_REQUEST_OUTCOMES, 'outcome')} : {}),
        };
        const sort = query.sort === 'slowest' ? 'slowest' : 'recent';
        const limit = boundedInteger(query.limit, TRANSLATION_STATS_REQUEST_PAGE_SIZE, 1, TRANSLATION_STATS_REQUEST_MAX_PAGE_SIZE, 'limit');
        const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const rangeStart = getTranslationStatsRangeStart(filter.range, now);
        const matched = (await this.database.requests
            .where('[startedAt+id]')
            .between([rangeStart, ''], [now, '\uffff'], true, true)
            .toArray())
            .filter((event) => matchesRequestFilter(event, filter))
            .sort((left, right) => (sort === 'slowest' ? right.durationMs - left.durationMs : 0)
                || right.startedAt - left.startedAt
                || right.id.localeCompare(left.id));
        return {
            generatedAt: now,
            filter,
            sort,
            offset,
            limit,
            totalCount: matched.length,
            items: matched.slice(offset, offset + limit),
        };
    }

    /** 只清空翻译统计库，不影响翻译缓存、模型用量、配置或学习数据。 */
    clear(): Promise<void> {
        // 在任何等待前推进代次并丢弃队列，确保进行中的请求结束后不会写回。
        this.generation += 1;
        this.queue = [];
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        return this.enqueue(async () => {
            await this.database.transaction('rw', this.database.requests, this.database.rollups, this.database.routes, async () => {
                await this.database.requests.clear();
                await this.database.rollups.clear();
                await this.database.routes.clear();
            });
        });
    }
}

export const translationStatsRepository = new TranslationStatsRepository();
