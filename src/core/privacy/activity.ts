/**
 * @file src/core/privacy/activity.ts
 * 文件职责：定义翻译隐私防护脱敏与拦截记录的数据模型、消息契约、有界记录环与跨类别累计统计聚合逻辑。
 * 主要内容：维护最多 100 条最近记录与累计统计，对存储中的异常样本做星号防御性校验，并重导出不可逆脱敏展示格式工具。
 * 模块边界：纯 TypeScript 算法，无浏览器存储或网络副作用；持久化数据仅含不可逆摘要、类别计数与服务标识。
 */
import {PRIVACY_CATEGORIES, type PrivacyCategory} from './policy';
import {
    clampPrivacyMaskedText,
    cleanPrivacyDisplayText,
    formatPrivacyMaskedDisplay,
    MAX_PRIVACY_MASKED_SAMPLE_LENGTH,
} from './maskDisplay';

export {formatPrivacyMaskedDisplay, MAX_PRIVACY_MASKED_SAMPLE_LENGTH};

export const PRIVACY_ACTIVITY_MESSAGE_TYPE = 'privacyProtectionActivity' as const;
export const PRIVACY_ACTIVITY_ACTIONS = ['masked', 'blocked', 'image-blocked', 'restore-failed', 'capacity-exceeded'] as const;
export type PrivacyActivityAction = typeof PRIVACY_ACTIVITY_ACTIONS[number];
export type PrivacyActivityCategory = PrivacyCategory | 'custom';
export const PRIVACY_ACTIVITY_CATEGORIES: readonly PrivacyActivityCategory[] = [...PRIVACY_CATEGORIES, 'custom'];

export const MAX_PRIVACY_ACTIVITY_RECORDS = 100;
export const MAX_PRIVACY_ACTIVITY_SAMPLES = 6;
const MAX_SERVICE_ID_LENGTH = 80;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export interface PrivacyMaskedSample {
    readonly category: PrivacyActivityCategory;
    readonly masked: string;
}

export type PrivacyCategoryCounts = Readonly<Record<PrivacyActivityCategory, number>>;

export interface PrivacyActivitySummary {
    readonly hitCount: number;
    readonly categoryCounts: Readonly<Partial<Record<PrivacyActivityCategory, number>>>;
    readonly samples: readonly PrivacyMaskedSample[];
}

export interface PrivacyActivityInput {
    readonly occurredAt?: number;
    readonly action: PrivacyActivityAction;
    readonly serviceId: string;
    readonly hitCount: number;
    readonly categoryCounts?: Readonly<Partial<Record<PrivacyActivityCategory, number>>>;
    readonly samples?: readonly PrivacyMaskedSample[];
}

export interface PrivacyActivityRecord {
    readonly id: string;
    readonly occurredAt: number;
    readonly action: PrivacyActivityAction;
    readonly serviceId: string;
    readonly hitCount: number;
    readonly categoryCounts: Readonly<Partial<Record<PrivacyActivityCategory, number>>>;
    readonly samples: readonly PrivacyMaskedSample[];
}

export interface PrivacyActivityStats {
    readonly totalEvents: number;
    readonly maskedEvents: number;
    readonly blockedEvents: number;
    readonly stoppedEvents: number;
    readonly totalHits: number;
    readonly categoryCounts: PrivacyCategoryCounts;
    readonly lastOccurredAt: number | null;
}

export interface PrivacyActivitySnapshot {
    readonly stats: PrivacyActivityStats;
    readonly records: readonly PrivacyActivityRecord[];
}

export type PrivacyActivityMessage =
    | {readonly type: typeof PRIVACY_ACTIVITY_MESSAGE_TYPE; readonly action: 'query'}
    | {readonly type: typeof PRIVACY_ACTIVITY_MESSAGE_TYPE; readonly action: 'clear'}
    | {readonly type: typeof PRIVACY_ACTIVITY_MESSAGE_TYPE; readonly action?: unknown};

export type PrivacyActivityResponse =
    | {readonly success: true; readonly data: PrivacyActivitySnapshot}
    | {readonly success: true; readonly data: {readonly cleared: true}}
    | {readonly success: false; readonly error: string};

export function createEmptyCategoryCounts(): Record<PrivacyActivityCategory, number> {
    return {
        email: 0,
        phone: 0,
        identity: 0,
        payment: 0,
        secret: 0,
        network: 0,
        custom: 0,
    };
}

export function createEmptyPrivacyActivitySnapshot(): PrivacyActivitySnapshot {
    return {
        stats: {
            totalEvents: 0,
            maskedEvents: 0,
            blockedEvents: 0,
            stoppedEvents: 0,
            totalHits: 0,
            categoryCounts: createEmptyCategoryCounts(),
            lastOccurredAt: null,
        },
        records: [],
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isActivityAction(value: unknown): value is PrivacyActivityAction {
    return typeof value === 'string' && PRIVACY_ACTIVITY_ACTIONS.includes(value as PrivacyActivityAction);
}

function isActivityCategory(value: unknown): value is PrivacyActivityCategory {
    return typeof value === 'string' && PRIVACY_ACTIVITY_CATEGORIES.includes(value as PrivacyActivityCategory);
}

function safeCount(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
        ? Math.floor(value)
        : fallback;
}

function sanitizeServiceId(value: unknown): string {
    if (typeof value !== 'string') return 'unknown';
    const normalized = cleanPrivacyDisplayText(value).slice(0, MAX_SERVICE_ID_LENGTH);
    return normalized || 'unknown';
}

function sanitizePartialCategoryCounts(raw: unknown): Partial<Record<PrivacyActivityCategory, number>> {
    const result: Partial<Record<PrivacyActivityCategory, number>> = {};
    if (!isPlainObject(raw)) return result;
    for (const category of PRIVACY_ACTIVITY_CATEGORIES) {
        const count = safeCount(raw[category]);
        if (count > 0) result[category] = count;
    }
    return result;
}

function sanitizeSamples(raw: unknown): PrivacyMaskedSample[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const result: PrivacyMaskedSample[] = [];
    for (const item of raw) {
        if (!isPlainObject(item) || !isActivityCategory(item.category) || typeof item.masked !== 'string') continue;
        const cleaned = clampPrivacyMaskedText(cleanPrivacyDisplayText(item.masked));
        // 防御性校验：拒收不含星号的异常样本，防止损坏的存储内容原样展示。
        if (!cleaned || !cleaned.includes('*')) continue;
        const key = `${item.category}:${cleaned}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({category: item.category, masked: cleaned});
        if (result.length >= MAX_PRIVACY_ACTIVITY_SAMPLES) break;
    }
    return result;
}

let recordSequence = 0;

export function appendPrivacyActivityRecord(
    snapshot: PrivacyActivitySnapshot,
    input: PrivacyActivityInput,
    now: () => number = () => Date.now(),
): PrivacyActivitySnapshot {
    const occurredAt = safeTimestamp(input.occurredAt, safeTimestamp(now(), 0));
    const categoryCounts = sanitizePartialCategoryCounts(input.categoryCounts);
    const summedCategories = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
    const hitCount = Math.max(safeCount(input.hitCount), summedCategories);
    const samples = sanitizeSamples(input.samples);
    const serviceId = sanitizeServiceId(input.serviceId);
    recordSequence = (recordSequence + 1) % 1_000_000;
    const record: PrivacyActivityRecord = {
        id: `${occurredAt}-${recordSequence}`,
        occurredAt,
        action: input.action,
        serviceId,
        hitCount,
        categoryCounts,
        samples,
    };

    const nextCategoryCounts = createEmptyCategoryCounts();
    for (const category of PRIVACY_ACTIVITY_CATEGORIES) {
        nextCategoryCounts[category] = snapshot.stats.categoryCounts[category] + (categoryCounts[category] ?? 0);
    }

    const isMasked = input.action === 'masked';
    const isStopped = input.action === 'restore-failed';
    const isBlocked = !isMasked && !isStopped;

    const nextStats: PrivacyActivityStats = {
        totalEvents: snapshot.stats.totalEvents + 1,
        maskedEvents: snapshot.stats.maskedEvents + (isMasked ? 1 : 0),
        blockedEvents: snapshot.stats.blockedEvents + (isBlocked ? 1 : 0),
        stoppedEvents: snapshot.stats.stoppedEvents + (isStopped ? 1 : 0),
        totalHits: snapshot.stats.totalHits + hitCount,
        categoryCounts: nextCategoryCounts,
        lastOccurredAt: snapshot.stats.lastOccurredAt === null
            ? occurredAt
            : Math.max(snapshot.stats.lastOccurredAt, occurredAt),
    };

    return {
        stats: nextStats,
        records: [record, ...snapshot.records].slice(0, MAX_PRIVACY_ACTIVITY_RECORDS),
    };
}

export function normalizePrivacyActivitySnapshot(raw: unknown): PrivacyActivitySnapshot {
    if (!isPlainObject(raw)) return createEmptyPrivacyActivitySnapshot();
    const rawRecords = Array.isArray(raw.records) ? raw.records : [];
    const records: PrivacyActivityRecord[] = [];
    for (const item of rawRecords) {
        if (!isPlainObject(item) || !isActivityAction(item.action)) continue;
        const occurredAt = safeTimestamp(item.occurredAt, 0);
        const categoryCounts = sanitizePartialCategoryCounts(item.categoryCounts);
        const summedCategories = Object.values(categoryCounts).reduce((sum, count) => sum + count, 0);
        const hitCount = Math.max(safeCount(item.hitCount), summedCategories);
        const id = typeof item.id === 'string' && item.id.trim()
            ? cleanPrivacyDisplayText(item.id).slice(0, 64)
            : `${occurredAt}-${records.length}`;
        records.push({
            id,
            occurredAt,
            action: item.action,
            serviceId: sanitizeServiceId(item.serviceId),
            hitCount,
            categoryCounts,
            samples: sanitizeSamples(item.samples),
        });
        if (records.length >= MAX_PRIVACY_ACTIVITY_RECORDS) break;
    }

    const rawStats = isPlainObject(raw.stats) ? raw.stats : null;
    if (!rawStats) {
        let rebuilt = createEmptyPrivacyActivitySnapshot();
        for (let index = records.length - 1; index >= 0; index -= 1) {
            const record = records[index]!;
            rebuilt = appendPrivacyActivityRecord(rebuilt, record, () => record.occurredAt);
        }
        return rebuilt;
    }

    const categoryCounts = createEmptyCategoryCounts();
    if (isPlainObject(rawStats.categoryCounts)) {
        for (const category of PRIVACY_ACTIVITY_CATEGORIES) {
            categoryCounts[category] = safeCount(rawStats.categoryCounts[category]);
        }
    }
    const maskedEvents = safeCount(rawStats.maskedEvents);
    const blockedEvents = safeCount(rawStats.blockedEvents);
    const stoppedEvents = safeCount(rawStats.stoppedEvents);
    const totalEvents = Math.max(safeCount(rawStats.totalEvents), maskedEvents + blockedEvents + stoppedEvents, records.length);
    const lastOccurredAt = rawStats.lastOccurredAt === null || rawStats.lastOccurredAt === undefined
        ? (records[0]?.occurredAt ?? null)
        : safeTimestamp(rawStats.lastOccurredAt, records[0]?.occurredAt ?? 0);

    return {
        stats: {
            totalEvents,
            maskedEvents,
            blockedEvents,
            stoppedEvents,
            totalHits: safeCount(rawStats.totalHits),
            categoryCounts,
            lastOccurredAt,
        },
        records,
    };
}
