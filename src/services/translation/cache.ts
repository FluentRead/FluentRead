/**
 * @file src/services/translation/cache.ts
 *
 * 文件职责：实现扩展自有的翻译结果缓存，统一键规范化、确定超限写入的早拒绝、TTL、可配置双容量限制、内存热层和 Dexie 持久层。
 * 主要内容：定义缓存 identity/record、canonicalize 与 buildTranslationCacheKey，维护 FluentReadCacheDatabase 与事务内增量用量汇总，并通过 translationCache 提供读取、写入、按短窗口合批写回的持久化 LRU、过期清理、阈值设置和用量统计；缓存读写故障降级，管理故障向 UI 如实报告。 可核对的公开符号包括 TRANSLATION_CACHE_VERSION、TRANSLATION_CACHE_TTL_MS、TRANSLATION_CACHE_MAX_ENTRY_BYTES、TRANSLATION_CACHE_MEMORY_ENTRIES、TranslationCacheIdentity、TranslationCacheRecord。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {sha256Hex} from '@/src/shared/function/sha256';
import Dexie, { type Table } from 'dexie';
import {
  normalizeTranslationCacheLimits,
  type TranslationCacheLimits,
} from '@/src/core/config/translationCache';

// v3 放弃旧语言映射可能以繁体身份存入的简体或粤语译文；继续保留 v2 的上下文回显门禁。
export const TRANSLATION_CACHE_VERSION = 3;
export const TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const TRANSLATION_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
export const TRANSLATION_CACHE_MEMORY_ENTRIES = 384;
/** 命中后访问时间只是 LRU 排序提示；短窗口内合并为一次读写事务，避免整页命中逐条排队写库。 */
export const TRANSLATION_CACHE_TOUCH_FLUSH_MS = 32;

export interface TranslationCacheIdentity {
  [key: string]: unknown;
}

export interface TranslationCacheRecord {
  key: string;
  translation: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  byteSize: number;
}

/**
 * 对结构化缓存身份做确定性序列化。
 * 对象字段顺序不能改变 key，用户文本也不能直接拼接成带分隔符的 key。
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'undefined') return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item !== 'undefined')
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(String(value));
}

/**
 * 从结构化请求身份生成带版本的不可读 key。
 * 版本号允许未来修改缓存协议，而不会误用旧协议留下的数据。
 */
export function buildTranslationCacheKey(identity: TranslationCacheIdentity): string {
  const payload = canonicalize({
    version: TRANSLATION_CACHE_VERSION,
    ...identity,
  });
  const digest = sha256Hex(payload);
  return `v${TRANSLATION_CACHE_VERSION}:${digest}`;
}

// 每次写缓存都要量两个字符串。可用性仍按调用时检查（无痕/精简环境可能没有
// TextEncoder），但实例本身可复用，不必为此反复构造。
let byteSizeEncoder: TextEncoder | undefined;

function getByteSize(value: string): number {
  if (typeof TextEncoder === 'undefined') return value.length * 2;
  byteSizeEncoder ??= new TextEncoder();
  return byteSizeEncoder.encode(value).byteLength;
}

interface TranslationCacheTotals {
  id: 'totals';
  bytes: number;
  entries: number;
}

export interface TranslationCacheStats extends TranslationCacheLimits {
  bytes: number;
  entries: number;
}

class FluentReadCacheDatabase extends Dexie {
  entries!: Table<TranslationCacheRecord, string>;
  totals!: Table<TranslationCacheTotals, string>;

  constructor() {
    super('FluentReadTranslationCache');
    this.version(1).stores({
      entries: '&key, createdAt, expiresAt, lastAccessedAt',
    });
    this.version(2).stores({
      entries: '&key, createdAt, expiresAt, lastAccessedAt',
    });
    this.version(3).stores({
      entries: '&key, createdAt, expiresAt, lastAccessedAt',
      totals: '&id',
    });
  }
}

export const translationCacheDb = new FluentReadCacheDatabase();

function isExpired(record: TranslationCacheRecord, now: number): boolean {
  return record.expiresAt <= now || record.createdAt + TRANSLATION_CACHE_TTL_MS <= now;
}

/**
 * 翻译缓存由后台统一持有，IndexedDB 之外再保留一层小型热数据内存缓存。
 * 读取、写入和维护失败会降级为未命中，使无痕模式、禁用 IndexedDB 或配额不足时仍能翻译。
 */
class TranslationCache {
  private readonly memory = new Map<string, TranslationCacheRecord>();
  /** 待写回的访问时间：按 key 保留最新时间与记录创建时间，写回时拒绝被替换的新记录。 */
  private readonly pendingTouches = new Map<string, {createdAt: number; lastAccessedAt: number}>();
  private touchFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private limits = normalizeTranslationCacheLimits(undefined);
  private clearEpoch = 0;
  private contentRevision = 0;
  private pruneRevision = 0;
  private readonly keyRevisions = new Map<string, number>();

  private bumpKeyRevision(key: string): void {
    this.keyRevisions.delete(key);
    this.keyRevisions.set(key, this.contentRevision);
    if (this.keyRevisions.size > 512) {
      this.keyRevisions.clear();
      this.pruneRevision += 1;
    }
  }

  private getKeyRevision(key: string): number {
    return this.keyRevisions.get(key) ?? 0;
  }

  private remember(record: TranslationCacheRecord): void {
    this.memory.delete(record.key);
    this.memory.set(record.key, record);
    while (this.memory.size > TRANSLATION_CACHE_MEMORY_ENTRIES) {
      const oldestKey = this.memory.keys().next().value as string;
      this.memory.delete(oldestKey);
    }
  }

  /** 元数据只在旧数据库首次使用时遍历重建，正常读写始终在同一事务内增量维护。 */
  private async readTotals(): Promise<TranslationCacheTotals> {
    const existing = await translationCacheDb.totals.get('totals');
    if (existing) return existing;
    const totals: TranslationCacheTotals = { id: 'totals', bytes: 0, entries: 0 };
    await translationCacheDb.entries.each((record) => {
      totals.bytes += record.byteSize;
      totals.entries += 1;
    });
    return totals;
  }

  private async deleteRecords(keys: string[], totals: TranslationCacheTotals): Promise<void> {
    if (keys.length === 0) return;
    await translationCacheDb.entries.bulkDelete(keys);
    this.contentRevision += 1;
    this.pruneRevision += 1;
    keys.forEach((key) => this.memory.delete(key));
    totals.entries -= keys.length;
  }

  /** 过期索引先回收无效条目，再沿访问时间索引只读取需要淘汰的记录。 */
  private async prune(totals: TranslationCacheTotals, now: number): Promise<Set<string>> {
    const expiredKeys: string[] = [];
    await translationCacheDb.entries.where('expiresAt').belowOrEqual(now)
      .or('createdAt').belowOrEqual(now - TRANSLATION_CACHE_TTL_MS)
      .each((record) => {
        expiredKeys.push(record.key);
        totals.bytes -= record.byteSize;
      });
    await this.deleteRecords(expiredKeys, totals);

    if (totals.entries > this.limits.maxEntries || totals.bytes > this.limits.maxBytes) {
      const evictedKeys: string[] = [];
      await translationCacheDb.entries.orderBy('lastAccessedAt')
        .until(() => totals.entries - evictedKeys.length <= this.limits.maxEntries
          && totals.bytes <= this.limits.maxBytes)
        .each((record) => {
          evictedKeys.push(record.key);
          totals.bytes -= record.byteSize;
        });
      await this.deleteRecords(evictedKeys, totals);
      expiredKeys.push(...evictedKeys);
    }
    return new Set(expiredKeys);
  }

  private async maintain(now: number): Promise<TranslationCacheStats> {
    await this.flushPendingTouches();
    return translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
      const totals = await this.readTotals();
      await this.prune(totals, now);
      await translationCacheDb.totals.put(totals);
      return { bytes: totals.bytes, entries: totals.entries, ...this.limits };
    });
  }

  private touch(record: TranslationCacheRecord, now: number): void {
    record.lastAccessedAt = Math.max(record.lastAccessedAt, now);
    this.remember(record);
    // 同一记录对象的访问时间单调递增，直接覆盖即可；写回时再与库内时间取最大值。
    this.pendingTouches.set(record.key, {createdAt: record.createdAt, lastAccessedAt: record.lastAccessedAt});
    this.touchFlushTimer ??= setTimeout(() => { void this.flushTouches(); }, TRANSLATION_CACHE_TOUCH_FLUSH_MS);
  }

  /** 写入、淘汰和统计都依赖库内 LRU 顺序；进入这些事务前先落盘尚未写回的访问时间。 */
  private async flushPendingTouches(): Promise<void> {
    if (this.touchFlushTimer === undefined) return;
    clearTimeout(this.touchFlushTimer);
    await this.flushTouches();
  }

  /** 一次事务批量写回访问时间；只推进同一条记录的时间，旧代际或被替换的记录不能被覆盖。 */
  private async flushTouches(): Promise<void> {
    this.touchFlushTimer = undefined;
    const epoch = this.clearEpoch;
    const touches = [...this.pendingTouches];
    this.pendingTouches.clear();
    try {
      await translationCacheDb.transaction('rw', translationCacheDb.entries, async () => {
        const records = await translationCacheDb.entries.bulkGet(touches.map(([key]) => key));
        const updated = records.flatMap((current, index) => {
          const touch = touches[index]![1];
          if (!current || epoch !== this.clearEpoch || current.createdAt !== touch.createdAt
            || current.lastAccessedAt >= touch.lastAccessedAt) return [];
          return [{...current, lastAccessedAt: touch.lastAccessedAt}];
        });
        if (updated.length > 0) await translationCacheDb.entries.bulkPut(updated);
      });
    } catch (error) {
      console.warn('[FluentRead] translation cache read failed:', error);
    }
  }

  private async removeExpired(key: string, now: number, epoch: number): Promise<void> {
    await translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
      if (epoch !== this.clearEpoch) return;
      const record = await translationCacheDb.entries.get(key);
      // 读取和删除之间可能写入了同 key 新值，不能用旧内存记录删除新译文。
      if (!record || !isExpired(record, now)) return;
      const totals = await this.readTotals();
      totals.bytes -= record.byteSize;
      await this.deleteRecords([key], totals);
      await translationCacheDb.totals.put(totals);
    });
  }

  async get(key: string, now = Date.now()): Promise<string | null> {
    const epoch = this.clearEpoch;
    const pruneRevision = this.pruneRevision;
    const keyRevision = this.getKeyRevision(key);
    const memoryRecord = this.memory.get(key);
    if (memoryRecord) {
      if (isExpired(memoryRecord, now)) {
        this.memory.delete(key);
        void this.removeExpired(key, now, epoch).catch((error) => {
          console.warn('[FluentRead] translation cache read failed:', error);
        });
        return null;
      }
      this.touch(memoryRecord, now);
      return memoryRecord.translation;
    }

    try {
      const record = await translationCacheDb.entries.get(key);
      if (epoch !== this.clearEpoch || pruneRevision !== this.pruneRevision
        || this.getKeyRevision(key) !== keyRevision || !record) return null;
      if (isExpired(record, now)) {
        await this.removeExpired(key, now, epoch);
        return null;
      }
      this.touch(record, now);
      return record.translation;
    } catch (error) {
      console.warn('[FluentRead] translation cache read failed:', error);
      return null;
    }
  }

  async set(key: string, translation: string, now = Date.now()): Promise<boolean> {
    // UTF-16 单元数只是字节下界：仅提前拒绝确定超限的字符串，其余仍按原计费。
    if (typeof key === 'string' && typeof translation === 'string'
      && key.length + translation.length > TRANSLATION_CACHE_MAX_ENTRY_BYTES) return false;
    const byteSize = getByteSize(key) + getByteSize(translation);
    if (!translation || byteSize > TRANSLATION_CACHE_MAX_ENTRY_BYTES) return false;
    const record: TranslationCacheRecord = {
      key, translation, createdAt: now, lastAccessedAt: now,
      expiresAt: now + TRANSLATION_CACHE_TTL_MS, byteSize,
    };
    const epoch = this.clearEpoch;
    let persisted = false;
    let writeRevision = this.contentRevision;
    await this.flushPendingTouches();
    try {
      await translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
        if (epoch !== this.clearEpoch) return;
        const totals = await this.readTotals();
        const previous = await translationCacheDb.entries.get(key);
        totals.bytes += byteSize - (previous?.byteSize ?? 0);
        if (!previous) totals.entries += 1;
        await translationCacheDb.entries.put(record);
        this.contentRevision += 1;
        this.bumpKeyRevision(key);
        // 新值提交后若被其他写入推进修订号而跳过晋升，也不能留下同 key 的旧热值。
        this.memory.delete(key);
        const removed = await this.prune(totals, now);
        await translationCacheDb.totals.put(totals);
        // 调用方时钟回退时新值也可能成为 LRU 候选；被逐出的写入不能重新进入热层。
        persisted = !removed.has(key);
        writeRevision = this.contentRevision;
      });
      if (!persisted || epoch !== this.clearEpoch || writeRevision !== this.contentRevision) return false;
      this.remember(record);
      return true;
    } catch (error) {
      console.warn('[FluentRead] translation cache write failed:', error);
      return false;
    }
  }

  private async removeExpiredMany(keys: readonly string[], now: number, epoch: number): Promise<void> {
    await translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
      if (epoch !== this.clearEpoch) return;
      const records = await translationCacheDb.entries.bulkGet([...keys]);
      const removable: string[] = [];
      let freedBytes = 0;
      for (const record of records) {
        if (!record || !isExpired(record, now)) continue;
        removable.push(record.key);
        freedBytes += record.byteSize;
      }
      if (removable.length === 0) return;
      const totals = await this.readTotals();
      totals.bytes -= freedBytes;
      await this.deleteRecords(removable, totals);
      await translationCacheDb.totals.put(totals);
    });
  }

  async getMany(keys: readonly string[], now = Date.now()): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    const epoch = this.clearEpoch;
    const pruneRevision = this.pruneRevision;
    const results = new Array<string | null>(keys.length).fill(null);
    const missedByKey = new Map<string, number[]>();
    const expiredMemoryKeys: string[] = [];

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const memoryRecord = this.memory.get(key);
      if (memoryRecord) {
        if (isExpired(memoryRecord, now)) {
          this.memory.delete(key);
          expiredMemoryKeys.push(key);
        } else {
          this.touch(memoryRecord, now);
          results[index] = memoryRecord.translation;
        }
        continue;
      }
      let slots = missedByKey.get(key);
      if (!slots) {
        slots = [];
        missedByKey.set(key, slots);
      }
      slots.push(index);
    }

    if (expiredMemoryKeys.length > 0) {
      void this.removeExpiredMany(expiredMemoryKeys, now, epoch).catch((error) => {
        console.warn('[FluentRead] translation cache read failed:', error);
      });
    }
    if (missedByKey.size === 0) return results;

    try {
      const missedKeys = [...missedByKey.keys()];
      const keyRevisions = missedKeys.map((key) => this.getKeyRevision(key));
      const records = await translationCacheDb.entries.bulkGet(missedKeys);
      if (epoch !== this.clearEpoch || pruneRevision !== this.pruneRevision) return results;
      const expiredDbKeys: string[] = [];
      for (let index = 0; index < missedKeys.length; index += 1) {
        const key = missedKeys[index]!;
        if (this.getKeyRevision(key) !== keyRevisions[index]) continue;
        const record = records[index];
        if (!record) continue;
        if (isExpired(record, now)) {
          expiredDbKeys.push(record.key);
          continue;
        }
        this.touch(record, now);
        for (const slot of missedByKey.get(key)!) {
          results[slot] = record.translation;
        }
      }
      if (expiredDbKeys.length > 0) {
        await this.removeExpiredMany(expiredDbKeys, now, epoch);
      }
      return results;
    } catch (error) {
      console.warn('[FluentRead] translation cache read failed:', error);
      return results;
    }
  }

  async setMany(entries: readonly {key: string; value: string}[], now = Date.now()): Promise<number> {
    if (entries.length === 0) return 0;
    const deduped = new Map<string, TranslationCacheRecord>();
    for (const {key, value: translation} of entries) {
      if (typeof key !== 'string' || typeof translation !== 'string' || !translation) continue;
      if (key.length + translation.length > TRANSLATION_CACHE_MAX_ENTRY_BYTES) continue;
      const byteSize = getByteSize(key) + getByteSize(translation);
      if (byteSize > TRANSLATION_CACHE_MAX_ENTRY_BYTES) continue;
      deduped.set(key, {
        key,
        translation,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: now + TRANSLATION_CACHE_TTL_MS,
        byteSize,
      });
    }
    const records = [...deduped.values()];
    if (records.length === 0) return 0;
    if (records.length === 1) {
      const only = records[0]!;
      return (await this.set(only.key, only.translation, now)) ? 1 : 0;
    }

    const epoch = this.clearEpoch;
    let persistedRecords: TranslationCacheRecord[] = [];
    let writeRevision = this.contentRevision;
    await this.flushPendingTouches();
    try {
      await translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
        if (epoch !== this.clearEpoch) return;
        const totals = await this.readTotals();
        const keys = records.map((record) => record.key);
        const previousRecords = await translationCacheDb.entries.bulkGet(keys);
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index]!;
          const previous = previousRecords[index];
          totals.bytes += record.byteSize - (previous?.byteSize ?? 0);
          if (!previous) totals.entries += 1;
        }
        await translationCacheDb.entries.bulkPut(records);
        this.contentRevision += 1;
        for (const key of keys) {
          this.bumpKeyRevision(key);
          this.memory.delete(key);
        }
        const removed = await this.prune(totals, now);
        await translationCacheDb.totals.put(totals);
        persistedRecords = records.filter((record) => !removed.has(record.key));
        writeRevision = this.contentRevision;
      });
      if (epoch !== this.clearEpoch || writeRevision !== this.contentRevision) return 0;
      for (const record of persistedRecords) this.remember(record);
      return persistedRecords.length;
    } catch (error) {
      console.warn('[FluentRead] translation cache write failed:', error);
      return 0;
    }
  }

  async setLimits(value: TranslationCacheLimits, now = Date.now()): Promise<void> {
    this.limits = normalizeTranslationCacheLimits(value);
    await this.maintain(now);
  }

  async getStats(now = Date.now()): Promise<TranslationCacheStats> {
    // 统计同时清理过期项与超限项，使设置页面显示当前有效用量；存储故障交由 UI 如实提示。
    return this.maintain(now);
  }

  async cleanup(now = Date.now()): Promise<void> {
    try {
      await this.maintain(now);
    } catch (error) {
      console.warn('[FluentRead] translation cache cleanup failed:', error);
    }
  }

  async clear(): Promise<void> {
    this.clearEpoch += 1;
    this.contentRevision += 1;
    this.pruneRevision += 1;
    this.keyRevisions.clear();
    this.memory.clear();
    this.pendingTouches.clear();
    clearTimeout(this.touchFlushTimer);
    this.touchFlushTimer = undefined;
    try {
      await translationCacheDb.transaction('rw', translationCacheDb.entries, translationCacheDb.totals, async () => {
        await translationCacheDb.entries.clear();
        // 删除汇总使首次使用旧库和清空后的重新初始化沿用同一路径。
        await translationCacheDb.totals.clear();
      });
    } catch (error) {
      console.warn('[FluentRead] translation cache clear failed:', error);
      throw error;
    }
  }
}

export const translationCache = new TranslationCache();
