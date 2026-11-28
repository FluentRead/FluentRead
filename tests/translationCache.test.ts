import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import CryptoJS from 'crypto-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRANSLATION_CACHE_MAX_BYTES as TRANSLATION_CACHE_MAX_BYTES,
  DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES as TRANSLATION_CACHE_MAX_ENTRIES,
} from '@/src/core/config/translationCache';
import {
  TRANSLATION_CACHE_MAX_ENTRY_BYTES,
  TRANSLATION_CACHE_MEMORY_ENTRIES,
  TRANSLATION_CACHE_TTL_MS,
  TRANSLATION_CACHE_TOUCH_FLUSH_MS,
  buildTranslationCacheKey,
  canonicalize,
  translationCache,
  translationCacheDb,
  type TranslationCacheRecord,
} from '@/src/services/translation/cache';

function record(
  key: string,
  overrides: Partial<TranslationCacheRecord> = {},
): TranslationCacheRecord {
  const createdAt = overrides.createdAt ?? 1_000;
  const translation = overrides.translation ?? `译文-${key}`;
  return {
    key,
    translation,
    createdAt,
    lastAccessedAt: overrides.lastAccessedAt ?? createdAt,
    expiresAt: overrides.expiresAt ?? createdAt + TRANSLATION_CACHE_TTL_MS,
    byteSize: overrides.byteSize ?? key.length + translation.length,
  };
}

async function resetCache(): Promise<void> {
  await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: TRANSLATION_CACHE_MAX_ENTRIES }, 0).catch(() => undefined);
  await translationCache.clear().catch(() => undefined);
  await translationCacheDb.entries.clear().catch(() => undefined);
}

describe('translation cache identity', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetCache();
  });

  it('canonicalizes every supported primitive and structural type deterministically', () => {
    const symbol = Symbol('cache');
    const fn = function cacheIdentity() { return 'ignored'; };

    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
    expect(canonicalize('a"b')).toBe(JSON.stringify('a"b'));
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(Number.NaN)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(10n)).toBe(JSON.stringify('10'));
    expect(canonicalize([1, undefined, 'x'])).toBe('[1,null,"x"]');
    expect(canonicalize({ b: 2, omitted: undefined, a: { z: false } }))
      .toBe('{"a":{"z":false},"b":2}');
    expect(canonicalize(symbol)).toBe(JSON.stringify(String(symbol)));
    expect(canonicalize(fn)).toBe(JSON.stringify(String(fn)));
  });

  it('uses an opaque versioned digest for every cache identity field', () => {
    const base = { sourceText: 'a_b', targetLanguage: 'zh-Hans', service: 'microsoft' };
    const key = buildTranslationCacheKey(base);

    expect(key).toMatch(/^v3:[0-9a-f]{64}$/);
    expect(buildTranslationCacheKey({ ...base, sourceText: 'a' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, targetLanguage: 'en' })).not.toBe(key);
    expect(buildTranslationCacheKey({ ...base, service: 'google' })).not.toBe(key);
  });

  it('does not reuse pre-migration traditional identities that may contain simplified or Cantonese output', async () => {
    const identity = {sourceText: 'The network settings', sourceLanguage: 'en', targetLanguage: 'zh-Hant', service: 'tongyi', model: 'qwen-mt-plus'};
    const legacyKey = `v2:${CryptoJS.SHA256(canonicalize({version: 2, ...identity})).toString(CryptoJS.enc.Hex)}`;
    await translationCacheDb.entries.put(record(legacyKey, {translation: '网络设置'}));
    const currentKey = buildTranslationCacheKey(identity);
    expect(currentKey).not.toBe(legacyKey);
    await expect(translationCache.get(currentKey, 2_000)).resolves.toBeNull();
    await expect(translationCache.set(currentKey, '網路設定', 2_000)).resolves.toBe(true);
    await expect(translationCache.get(currentKey, 3_000)).resolves.toBe('網路設定');
  });

  it('falls back to UTF-16 byte estimation when TextEncoder is unavailable', async () => {
    vi.stubGlobal('TextEncoder', undefined);
    const translation = 'x'.repeat(Math.floor(TRANSLATION_CACHE_MAX_ENTRY_BYTES / 2));

    await expect(translationCache.set('fallback-byte-size', translation, 1_000)).resolves.toBe(false);
    await expect(translationCacheDb.entries.get('fallback-byte-size')).resolves.toBeUndefined();
  });
});

describe('translation cache persistence policy', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetCache();
  });

  it('serves hot memory hits without reading IndexedDB and persists access order', async () => {
    await expect(translationCache.set('hot', '热译文', 1_000)).resolves.toBe(true);
    const getSpy = vi.spyOn(translationCacheDb.entries, 'get');

    await expect(translationCache.get('hot', 2_000)).resolves.toBe('热译文');

    expect(getSpy).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await expect(translationCacheDb.entries.get('hot')).resolves.toMatchObject({ lastAccessedAt: 2_000 });
    });
  });

  it('loads cold IndexedDB hits promptly, merges their access-time writes, and promotes them to memory', async () => {
    await translationCacheDb.entries.bulkPut([record('cold', { lastAccessedAt: 1_000 }), record('cold-2', { lastAccessedAt: 1_000 })]);
    const bulkPut = vi.spyOn(translationCacheDb.entries, 'bulkPut');
    const update = vi.spyOn(translationCacheDb.entries, 'update');

    await expect(Promise.all([
      translationCache.get('cold', 5_000),
      translationCache.get('cold-2', 5_500),
    ])).resolves.toEqual(['译文-cold', '译文-cold-2']);
    await vi.waitFor(async () => {
      await expect(translationCacheDb.entries.get('cold')).resolves.toMatchObject({ lastAccessedAt: 5_000 });
      await expect(translationCacheDb.entries.get('cold-2')).resolves.toMatchObject({ lastAccessedAt: 5_500 });
    });
    // 同一时间窗内的命中只写一次库，不再逐条排队读写事务。
    expect(bulkPut).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();

    const getSpy = vi.spyOn(translationCacheDb.entries, 'get');
    await expect(translationCache.get('cold', 6_000)).resolves.toBe('译文-cold');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('serves and promotes a cold hit even when the asynchronous LRU touch fails', async () => {
    const failure = new Error('touch blocked');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await translationCacheDb.entries.put(record('cold-touch-failure'));
    vi.spyOn(translationCacheDb.entries, 'bulkPut').mockRejectedValueOnce(failure);

    await expect(translationCache.get('cold-touch-failure', 5_000)).resolves.toBe('译文-cold-touch-failure');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache read failed:', failure);
    });
    const getSpy = vi.spyOn(translationCacheDb.entries, 'get');
    await expect(translationCache.get('cold-touch-failure', 6_000)).resolves.toBe('译文-cold-touch-failure');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('expires hot records by TTL and removes their persistent copy asynchronously', async () => {
    await translationCache.set('hot-expired', '旧译文', 1_000);

    await expect(translationCache.get('hot-expired', 1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toBeNull();
    await vi.waitFor(async () => {
      await expect(translationCacheDb.entries.get('hot-expired')).resolves.toBeUndefined();
    });
  });

  it('expires cold records by expiresAt even when createdAt is still fresh', async () => {
    await translationCacheDb.entries.put(record('cold-expired', {
      createdAt: 10_000,
      lastAccessedAt: 10_000,
      expiresAt: 10_100,
    }));

    await expect(translationCache.get('cold-expired', 10_101)).resolves.toBeNull();
    await expect(translationCacheDb.entries.get('cold-expired')).resolves.toBeUndefined();
  });

  it('returns null for missing cold entries', async () => {
    await expect(translationCache.get('missing', 1_000)).resolves.toBeNull();
  });

  it('evicts the oldest hot-memory entry while keeping its IndexedDB copy readable', async () => {
    for (let index = 0; index <= TRANSLATION_CACHE_MEMORY_ENTRIES; index += 1) {
      await translationCache.set(`memory-${index}`, `译文-${index}`, 1_000 + index);
    }

    const getSpy = vi.spyOn(translationCacheDb.entries, 'get');
    await expect(translationCache.get('memory-0', 5_000)).resolves.toBe('译文-0');

    expect(getSpy).toHaveBeenCalledWith('memory-0');
  });

  it('rejects empty and oversized entries before writing', async () => {
    await expect(translationCache.set('empty', '', 1_000)).resolves.toBe(false);
    await expect(translationCache.set('too-large', 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES), 1_000))
      .resolves.toBe(false);
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
  });

  it('bounds persistent entries by LRU count', async () => {
    const existing = Array.from({ length: TRANSLATION_CACHE_MAX_ENTRIES }, (_, index) => (
      record(`entry-${index}`, {
        createdAt: 1_000 + index,
        lastAccessedAt: 1_000 + index,
      })
    ));
    await translationCacheDb.entries.bulkPut(existing);

    await expect(translationCache.set('entry-new', '新译文', 10_000)).resolves.toBe(true);

    await expect(translationCacheDb.entries.count()).resolves.toBe(TRANSLATION_CACHE_MAX_ENTRIES);
    await expect(translationCacheDb.entries.get('entry-0')).resolves.toBeUndefined();
    await expect(translationCacheDb.entries.get('entry-new')).resolves.toBeDefined();
  });

  it('bounds persistent entries by declared byte size', async () => {
    await translationCacheDb.entries.bulkPut([
      record('byte-old', { lastAccessedAt: 1_000, byteSize: TRANSLATION_CACHE_MAX_BYTES - 1 }),
      record('byte-mid', { lastAccessedAt: 2_000, byteSize: 10 }),
    ]);

    await expect(translationCache.set('byte-new', '新译文', 3_000)).resolves.toBe(true);

    await expect(translationCacheDb.entries.get('byte-old')).resolves.toBeUndefined();
    await expect(translationCacheDb.entries.get('byte-mid')).resolves.toBeDefined();
    await expect(translationCacheDb.entries.get('byte-new')).resolves.toBeDefined();
  });

  it('keeps translating when IndexedDB read or write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(translationCacheDb.entries, 'get').mockRejectedValueOnce(new Error('blocked read'));

    await expect(translationCache.get('read-failure', 1_000)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache read failed:', expect.any(Error));

    vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('quota'));
    await expect(translationCache.set('write-failure', '译文', 1_000)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache write failed:', expect.any(Error));
  });

  it('cleanup removes expired records and stale memory entries', async () => {
    const now = 1_000 + TRANSLATION_CACHE_TTL_MS;
    await translationCacheDb.entries.put(record('db-expires-at', { expiresAt: now }));
    await translationCacheDb.entries.put(record('db-created-at', {
      createdAt: 1_000,
      expiresAt: 1_000 + 7 * TRANSLATION_CACHE_TTL_MS,
    }));
    await translationCache.set('memory-stale', '旧译文', 1_000);
    await translationCache.set('memory-live', '新译文', now - 1);

    await translationCache.cleanup(now);

    await expect(translationCacheDb.entries.get('db-expires-at')).resolves.toBeUndefined();
    await expect(translationCacheDb.entries.get('db-created-at')).resolves.toBeUndefined();
    await expect(translationCache.get('memory-live', now + 1)).resolves.toBe('新译文');

    const getSpy = vi.spyOn(translationCacheDb.entries, 'get');
    await expect(translationCache.get('memory-stale', now + 1)).resolves.toBeNull();
    expect(getSpy).toHaveBeenCalledWith('memory-stale');
  });

  it('cleanup degrades when IndexedDB cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(translationCacheDb.entries, 'where').mockImplementationOnce(() => {
      throw new Error('cleanup blocked');
    });

    await expect(translationCache.cleanup(10_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache cleanup failed:', expect.any(Error));
  });

  it('clear removes memory and IndexedDB entries', async () => {
    await translationCache.set('clear-me', '译文', 1_000);

    await expect(translationCache.clear()).resolves.toBeUndefined();

    await expect(translationCache.get('clear-me', 2_000)).resolves.toBeNull();
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
  });

  it('clear invalidates a deferred cold read without repopulating memory or IndexedDB', async () => {
    const staleRecord = record('clear-cold-race', { lastAccessedAt: 1_000 });
    await translationCacheDb.entries.put(staleRecord);
    let resolveRead!: (value: TranslationCacheRecord) => void;
    const deferredRead = new Promise<TranslationCacheRecord>((resolve) => {
      resolveRead = resolve;
    });
    const getSpy = vi.spyOn(translationCacheDb.entries, 'get')
      .mockReturnValueOnce(deferredRead as never);

    const read = translationCache.get('clear-cold-race', 5_000);
    await vi.waitFor(() => {
      expect(getSpy).toHaveBeenCalledWith('clear-cold-race');
    });

    await translationCache.clear();
    resolveRead(staleRecord);

    await expect(read).resolves.toBeNull();
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
    await expect(translationCache.get('clear-cold-race', 6_000)).resolves.toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('clear invalidates a write that entered the old epoch before its transaction starts', async () => {
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionSpy = vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((
      async (...args: unknown[]) => {
        await transactionGate;
        const scope = args.at(-1) as () => unknown;
        return scope();
      }
    ) as never);

    const staleWrite = translationCache.set('clear-write-race', '旧代译文', 5_000);
    await vi.waitFor(() => expect(transactionSpy).toHaveBeenCalledOnce());

    await translationCache.clear();
    releaseTransaction();

    await expect(staleWrite).resolves.toBe(false);
    await expect(translationCacheDb.entries.get('clear-write-race')).resolves.toBeUndefined();
    await expect(translationCache.get('clear-write-race', 6_000)).resolves.toBeNull();
  });

  it('clear rethrows IndexedDB failures after clearing memory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(translationCacheDb.entries, 'clear').mockRejectedValueOnce(new Error('clear blocked'));

    await expect(translationCache.clear()).rejects.toThrow('clear blocked');
    expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache clear failed:', expect.any(Error));
  });

  it('uses Date.now defaults for ordinary set and get calls', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);

    await expect(translationCache.set('default-now', '默认时间')).resolves.toBe(true);
    now.mockReturnValue(50_001);
    await expect(translationCache.get('default-now')).resolves.toBe('默认时间');
  });
});


describe('translation cache configurable storage limits', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetCache();
  });

  it('reports UTF-8 bytes and entry totals, including replacement and clear', async () => {
    await expect(translationCache.getStats(1_000)).resolves.toEqual({
      bytes: 0, entries: 0, maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: TRANSLATION_CACHE_MAX_ENTRIES,
    });
    await translationCache.set('same', 'hello', 1_000);
    await expect(translationCache.getStats(1_001)).resolves.toMatchObject({ bytes: 9, entries: 1 });
    await translationCache.set('same', '中文', 1_002);
    await expect(translationCache.getStats(1_003)).resolves.toMatchObject({ bytes: 10, entries: 1 });
    await translationCache.clear();
    await expect(translationCache.getStats(1_004)).resolves.toMatchObject({ bytes: 0, entries: 0 });
  });

  it('migrates a real v2 database and rebuilds its aggregate only once', async () => {
    await translationCache.clear();
    translationCacheDb.close();
    await Dexie.delete('FluentReadTranslationCache');
    const legacy = new Dexie('FluentReadTranslationCache');
    legacy.version(2).stores({ entries: '&key, createdAt, expiresAt, lastAccessedAt' });
    await legacy.table('entries').put(record('legacy', { byteSize: 73 }));
    legacy.close();
    await translationCacheDb.open();
    const scan = vi.spyOn(translationCacheDb.entries, 'each');
    await expect(translationCache.getStats(2_000)).resolves.toMatchObject({ bytes: 73, entries: 1 });
    await translationCache.set('new', 'value', 2_001);
    await translationCache.set('new', 'updated', 2_002);
    await expect(translationCache.getStats(2_003)).resolves.toMatchObject({ bytes: 83, entries: 2 });
    expect(scan).toHaveBeenCalledOnce();
  });

  it('shrinks the entry limit immediately and persists hot-read LRU across reopening the database', async () => {
    const items = Array.from({ length: 120 }, (_, index) => record(`limit-${index}`, {
      lastAccessedAt: 1_000 + index,
    }));
    await translationCacheDb.entries.bulkPut(items);
    await translationCache.get('limit-0', 2_000);
    await translationCache.get('limit-0', 3_000);
    // 真实重开同一个数据库，确认热读顺序已写入磁盘，后续淘汰不依赖进程内 Map。
    await vi.waitFor(async () => {
      await translationCacheDb.entries.get('limit-0').then((item) => expect(item?.lastAccessedAt).toBe(3_000));
    });
    translationCacheDb.close();
    await translationCacheDb.open();
    await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: 100 }, 4_000);
    await expect(translationCacheDb.entries.count()).resolves.toBe(100);
    await expect(translationCacheDb.entries.get('limit-0')).resolves.toBeDefined();
    await expect(translationCacheDb.entries.get('limit-1')).resolves.toBeUndefined();
    await expect(translationCacheDb.entries.get('limit-20')).resolves.toBeUndefined();
    await expect(translationCacheDb.entries.get('limit-21')).resolves.toBeDefined();
  });

  it('enforces the byte limit independently and forgets evicted hot entries', async () => {
    const size = 220_000;
    for (let index = 0; index < 6; index += 1) {
      await translationCache.set(`large-${index}`, 'x'.repeat(size), 1_000 + index);
    }
    await translationCache.setLimits({ maxBytes: 1024 * 1024, maxEntries: 100 }, 2_000);
    await expect(translationCache.getStats(2_000)).resolves.toMatchObject({
      bytes: 4 * (size + 7), entries: 4, maxBytes: 1024 * 1024, maxEntries: 100,
    });
    await expect(translationCache.get('large-0', 2_001)).resolves.toBeNull();
    await expect(translationCache.get('large-1', 2_001)).resolves.toBeNull();
    await expect(translationCache.get('large-2', 2_001)).resolves.toHaveLength(size);
  });

  it('expires recent-but-invalid entries before evicting an older valid result', async () => {
    await translationCacheDb.entries.bulkPut(Array.from({ length: 100 }, (_, index) => (
      record(`expiry-${index}`, { lastAccessedAt: 1_000 + index,
        ...(index === 99 ? { expiresAt: 10_000 } : {}),
      })
    )));
    await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: 100 }, 9_000);
    await translationCache.set('fresh', 'new', 10_000);
    await expect(translationCache.get('expiry-0', 10_001)).resolves.toBe('译文-expiry-0');
    await expect(translationCache.get('expiry-99', 10_001)).resolves.toBeNull();
    await expect(translationCache.getStats(10_001)).resolves.toMatchObject({ entries: 100 });
  });

  it('does not retain a newly written item in memory when its old timestamp makes it the eviction victim', async () => {
    await translationCacheDb.entries.bulkPut(Array.from({ length: 100 }, (_, index) => (
      record(`newer-${index}`, { lastAccessedAt: 10_000 + index })
    )));
    await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: 100 }, 1_000);
    await expect(translationCache.set('older', 'clock moved backwards', 2_000)).resolves.toBe(false);
    await expect(translationCache.get('older', 3_000)).resolves.toBeNull();
    await expect(translationCache.getStats(3_000)).resolves.toMatchObject({ entries: 100 });
  });

  it('keeps aggregate counters consistent across concurrent writes and replacement', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, index) => translationCache.set(`parallel-${index}`, '文本', 1_000)));
    await Promise.all(Array.from({ length: 10 }, (_, index) => translationCache.set(`parallel-${index}`, '新的文本', 1_001)));
    const records = await translationCacheDb.entries.toArray();
    await expect(translationCache.getStats(2_000)).resolves.toMatchObject({
      entries: 25, bytes: records.reduce((sum, item) => sum + item.byteSize, 0),
    });
  });

  it('updates counters when hot and cold reads remove expired entries', async () => {
    await translationCacheDb.entries.put(record('cold-expiration', { expiresAt: 2_000, byteSize: 27 }));
    await translationCache.set('hot-expiration', 'hot', 1_000);
    await expect(translationCache.get('cold-expiration', 2_001)).resolves.toBeNull();
    await expect(translationCache.getStats(2_001)).resolves.toMatchObject({ entries: 1, bytes: 17 });
    await expect(translationCache.get('hot-expiration', 1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toBeNull();
    await expect(translationCache.getStats(1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toMatchObject({ entries: 0, bytes: 0 });
  });

  it('reports storage management errors while reads and writes still degrade safely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('stats blocked'));
    await expect(translationCache.getStats(1_000)).rejects.toThrow('stats blocked');
    vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('limit cleanup blocked'));
    await expect(translationCache.setLimits({ maxBytes: 1024 * 1024, maxEntries: 100 }, 1_000))
      .rejects.toThrow('limit cleanup blocked');
    await expect(translationCache.getStats(1_000)).resolves.toMatchObject({ maxBytes: 1024 * 1024, maxEntries: 100 });
    await translationCache.set('hot-failure', 'valid', 1_000);
    vi.spyOn(translationCacheDb, 'transaction').mockRejectedValueOnce(new Error('expiration blocked'));
    await expect(translationCache.get('hot-failure', 1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toBeNull();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(
      '[FluentRead] translation cache read failed:', expect.objectContaining({ message: 'expiration blocked' }),
    ));
  });

  it('prevents delayed expiration work from mutating a new clear epoch', async () => {
    await translationCache.set('expired-race', 'old', 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
      await gate;
      return (args.at(-1) as () => unknown)();
    }) as never);
    await expect(translationCache.get('expired-race', 1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toBeNull();
    await translationCache.clear();
    await translationCache.set('expired-race', 'replacement', 2_000 + TRANSLATION_CACHE_TTL_MS);
    release();
    await expect(translationCache.getStats(2_001 + TRANSLATION_CACHE_TTL_MS)).resolves.toMatchObject({ entries: 1 });
    await expect(translationCache.get('expired-race', 2_001 + TRANSLATION_CACHE_TTL_MS)).resolves.toBe('replacement');
  });

  it.each(['missing', 'replaced'])('does not delete an expired key that became %s before deletion', async (state) => {
    await translationCache.set('expiry-write-race', 'old', 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finish = new Promise<void>((resolve, reject) => {
      vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
        await gate;
        try { await (args.at(-1) as () => unknown)(); resolve(); } catch (error) { reject(error); }
      }) as never);
    });
    await expect(translationCache.get('expiry-write-race', 1_000 + TRANSLATION_CACHE_TTL_MS)).resolves.toBeNull();
    if (state === 'missing') {
      await translationCacheDb.entries.delete('expiry-write-race');
      await translationCacheDb.totals.clear();
    } else {
      await translationCache.set('expiry-write-race', 'replacement', 1_001 + TRANSLATION_CACHE_TTL_MS);
    }
    release();
    await finish;
    await expect(translationCache.get('expiry-write-race', 1_002 + TRANSLATION_CACHE_TTL_MS))
      .resolves.toBe(state === 'missing' ? null : 'replacement');
  });

  it('uses the current time by default for limits, statistics, and cleanup', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    await translationCache.set('default-management', 'value');
    await translationCache.setLimits({ maxBytes: 1024 * 1024, maxEntries: 100 });
    await expect(translationCache.getStats()).resolves.toMatchObject({ entries: 1 });
    time.mockReturnValue(50_000 + TRANSLATION_CACHE_TTL_MS);
    await translationCache.cleanup();
    await expect(translationCache.getStats()).resolves.toMatchObject({ bytes: 0, entries: 0 });
  });
});


describe('translation cache delayed operation races', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCache();
  });

  it('does not repopulate an evicted record from a delayed cold read', async () => {
    const victim = record('victim', { lastAccessedAt: 500 });
    await translationCacheDb.entries.bulkPut([victim, ...Array.from({ length: 100 }, (_, index) => (
      record(`keep-${index}`, { lastAccessedAt: 1_000 + index })
    ))]);
    let resolveRead!: (value: TranslationCacheRecord) => void;
    vi.spyOn(translationCacheDb.entries, 'get').mockReturnValueOnce(new Promise<TranslationCacheRecord>((resolve) => {
      resolveRead = resolve;
    }) as never);
    const pending = translationCache.get('victim', 2_000);
    await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: 100 }, 2_000);
    resolveRead(victim);
    await expect(pending).resolves.toBeNull();
    await expect(translationCache.get('victim', 2_001)).resolves.toBeNull();
  });

  it('keeps batch cold hits that land after an unrelated write', async () => {
    await translationCacheDb.entries.bulkPut([record('batch-a'), record('batch-b')]);
    let resolveRead!: (value: (TranslationCacheRecord | undefined)[]) => void;
    vi.spyOn(translationCacheDb.entries, 'bulkGet').mockReturnValueOnce(new Promise((resolve) => {
      resolveRead = resolve;
    }) as never);
    const pending = translationCache.getMany(['batch-a', 'batch-b', 'missing'], 2_000);
    await translationCache.set('unrelated', 'value', 2_000);
    resolveRead([record('batch-a'), record('batch-b'), undefined]);
    await expect(pending).resolves.toEqual([record('batch-a').translation, record('batch-b').translation, null]);
    await translationCache.getStats(2_000);
    await expect(translationCacheDb.entries.get('batch-a')).resolves.toMatchObject({ lastAccessedAt: 2_000 });
  });

  it.each(['evicted', 'replaced', 'cleared'])('does not revive a committed write whose return is delayed until it is %s', async (state) => {
    await translationCacheDb.entries.bulkPut(Array.from({ length: 99 }, (_, index) => (
      record(`keep-${index}`, { lastAccessedAt: 2_000 + index })
    )));
    await translationCache.setLimits({ maxBytes: TRANSLATION_CACHE_MAX_BYTES, maxEntries: 100 }, 1_000);
    const actualTransaction = translationCacheDb.transaction.bind(translationCacheDb);
    let release!: () => void;
    let signalCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { signalCommitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
      const result = await (actualTransaction as (...params: unknown[]) => Promise<unknown>)(...args);
      signalCommitted();
      await gate;
      return result;
    }) as never);
    const oldWrite = translationCache.set('delayed-write', 'old', 1_000);
    await committed;
    if (state === 'evicted') await translationCache.set('newest', 'new', 3_000);
    if (state === 'replaced') await translationCache.set('delayed-write', 'replacement', 3_000);
    if (state === 'cleared') await translationCache.clear();
    release();
    await expect(oldWrite).resolves.toBe(false);
    await expect(translationCache.get('delayed-write', 3_001)).resolves.toBe(state === 'replaced' ? 'replacement' : null);
  });

  it('keeps persistent LRU time monotonic when touches arrive out of order', async () => {
    await translationCache.set('touch-order', 'value', 1_000);
    await expect(translationCache.get('touch-order', 6_000)).resolves.toBe('value');
    await expect(translationCache.get('touch-order', 5_000)).resolves.toBe('value');
    await vi.waitFor(async () => {
      await expect(translationCacheDb.entries.get('touch-order')).resolves.toMatchObject({ lastAccessedAt: 6_000 });
    });

    // 库内已有更晚的访问时间（例如其他写入路径）时，迟到的旧访问不能回拨。
    const stored = await translationCacheDb.entries.get('touch-order');
    await translationCacheDb.entries.put({ ...stored!, lastAccessedAt: 9_000 });
    await expect(translationCache.get('touch-order', 7_000)).resolves.toBe('value');
    const bulkPut = vi.spyOn(translationCacheDb.entries, 'bulkPut');
    await translationCache.getStats(7_000);
    expect(bulkPut).not.toHaveBeenCalled();
    await expect(translationCacheDb.entries.get('touch-order')).resolves.toMatchObject({ lastAccessedAt: 9_000 });
  });

  it('drops an old hot value when a replacement returns after an unrelated write changed the revision', async () => {
    await translationCache.set('hot-replacement', 'old', 1_000);
    const actualTransaction = translationCacheDb.transaction.bind(translationCacheDb);
    let release!: () => void;
    let signalCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { signalCommitted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(translationCacheDb, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
      const result = await (actualTransaction as (...params: unknown[]) => Promise<unknown>)(...args);
      signalCommitted();
      await gate;
      return result;
    }) as never);
    const replacement = translationCache.set('hot-replacement', 'new', 2_000);
    await committed;
    await translationCache.set('unrelated-key', 'other', 3_000);
    release();
    await expect(replacement).resolves.toBe(false);
    await expect(translationCache.get('hot-replacement', 3_001)).resolves.toBe('new');
  });

  it.each(['clear', 'replacement'])('ignores an old touch after %s creates a new record at the same key', async (state) => {
    await translationCache.set('touch-generation', 'old', 1_000);
    await translationCache.get('touch-generation', 9_000);
    if (state === 'clear') await translationCache.clear();
    await translationCache.set('touch-generation', 'replacement', 2_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(translationCacheDb.entries.get('touch-generation')).resolves.toMatchObject({
      translation: 'replacement', lastAccessedAt: 2_000,
    });
  });

  it('does not rewrite a record replaced before the batched touch commits', async () => {
    await translationCache.set('touch-replaced-directly', 'old', 1_000);
    await translationCache.get('touch-replaced-directly', 9_000);
    // 其他数据库写入绕过本实例的写入路径替换同 key 记录，待写回的访问时间属于旧记录。
    await translationCacheDb.entries.put(record('touch-replaced-directly', { createdAt: 3_000, lastAccessedAt: 3_000 }));
    await translationCache.getStats(3_000);
    await expect(translationCacheDb.entries.get('touch-replaced-directly')).resolves.toMatchObject({
      createdAt: 3_000, lastAccessedAt: 3_000,
    });
  });

  it('does not resurrect a record deleted before the batched touch commits', async () => {
    await translationCache.set('touch-deleted', 'old', 1_000);
    await translationCache.get('touch-deleted', 9_000);
    await translationCacheDb.entries.delete('touch-deleted');
    await translationCache.getStats(9_000);
    await expect(translationCacheDb.entries.get('touch-deleted')).resolves.toBeUndefined();
  });

  it('drops a batched touch whose flush races with clear', async () => {
    await translationCache.set('touch-clear-race', 'old', 1_000);
    const actualBulkGet = translationCacheDb.entries.bulkGet.bind(translationCacheDb.entries);
    let clearing: Promise<void> | undefined;
    vi.spyOn(translationCacheDb.entries, 'bulkGet').mockImplementationOnce((async (keys: string[]) => {
      const records = await actualBulkGet(keys);
      // 在事务区域外发起清理，模拟设置页的独立清理请求在批量写回途中到达。
      clearing = Dexie.ignoreTransaction(() => translationCache.clear());
      return records;
    }) as never);
    await translationCache.get('touch-clear-race', 9_000);
    await vi.waitFor(() => expect(clearing).toBeDefined());
    await clearing;
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
  });
});

describe('translation cache definite oversize rejection', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetCache();
  });

  it.each([
    ['ordinary key', `v3:${'a'.repeat(64)}`],
    ['large key', 'k'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES - 1)],
  ])('counts an exact-limit %s but skips encoding its MAX+1 replacement', async (_label, key) => {
    const value = 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES - key.length);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    await expect(translationCache.set(key, value, 1_000)).resolves.toBe(true);
    expect(encode).toHaveBeenCalledTimes(2);
    const before = await translationCacheDb.entries.get(key);
    expect(before).toMatchObject({translation: value, byteSize: TRANSLATION_CACHE_MAX_ENTRY_BYTES});
    encode.mockClear();

    await expect(translationCache.set(key, `${value}x`, 2_000)).resolves.toBe(false);
    await expect(translationCacheDb.entries.get(key)).resolves.toEqual(before);
    await expect(translationCache.getStats(2_000)).resolves.toMatchObject({
      bytes: TRANSLATION_CACHE_MAX_ENTRY_BYTES, entries: 1,
    });
    expect(encode).not.toHaveBeenCalled();
  });

  it.each([
    ['Chinese', '中', 3],
    ['lone high surrogate', '\ud800', 3],
    ['lone low surrogate', '\udc00', 3],
    ['valid surrogate pair', '\ud83d\ude42', 4],
  ] as const)('keeps native byte accounting for %s with an inconclusive unit bound', async (_label, unit, unitBytes) => {
    const key = `v3:${'a'.repeat(64)}`;
    const value = unit.repeat(Math.floor((TRANSLATION_CACHE_MAX_ENTRY_BYTES - key.length) / unitBytes) + 1);
    expect(key.length + value.length).toBeLessThan(TRANSLATION_CACHE_MAX_ENTRY_BYTES);
    expect(new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength)
      .toBeGreaterThan(TRANSLATION_CACHE_MAX_ENTRY_BYTES);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    await expect(translationCache.set(key, value, 1_000)).resolves.toBe(false);
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
    await expect(translationCache.getStats(1_000)).resolves.toMatchObject({bytes: 0, entries: 0});
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it('keeps the old UTF-16 fallback limit when TextEncoder is unavailable', async () => {
    vi.stubGlobal('TextEncoder', undefined);
    const key = 'f';
    const value = 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES / 2 - key.length);

    await expect(translationCache.set(key, value, 1_000)).resolves.toBe(true);
    const before = await translationCacheDb.entries.get(key);
    expect(before?.byteSize).toBe(TRANSLATION_CACHE_MAX_ENTRY_BYTES);
    await expect(translationCache.set(key, `${value}x`, 2_000)).resolves.toBe(false);
    await expect(translationCache.set(key, 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES), 2_000)).resolves.toBe(false);
    await expect(translationCacheDb.entries.get(key)).resolves.toEqual(before);
    await expect(translationCache.getStats(2_000)).resolves.toMatchObject({
      bytes: TRANSLATION_CACHE_MAX_ENTRY_BYTES, entries: 1,
    });
  });

  it('keeps the existing row, hot value and pending touch until its original flush after an oversized replacement', async () => {
    const key = 'pending-oversize';
    await expect(translationCache.set(key, 'old value', 1_000)).resolves.toBe(true);
    const before = await translationCacheDb.entries.get(key);
    const totals = await translationCacheDb.totals.get('totals');
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const get = vi.spyOn(translationCacheDb.entries, 'get');
      const transaction = vi.spyOn(translationCacheDb, 'transaction');
      const bulkPut = vi.spyOn(translationCacheDb.entries, 'bulkPut');
      const encode = vi.spyOn(TextEncoder.prototype, 'encode');
      await expect(translationCache.get(key, 2_000)).resolves.toBe('old value');
      expect(get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await expect(translationCache.set(key,
        'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES - key.length + 1),
        1_000 + TRANSLATION_CACHE_TTL_MS + 1)).resolves.toBe(false);
      expect(transaction).not.toHaveBeenCalled();
      await expect(translationCache.get(key, 2_000)).resolves.toBe('old value');
      expect(get).not.toHaveBeenCalled();
      await expect(translationCacheDb.entries.get(key)).resolves.toEqual(before);
      await expect(translationCacheDb.totals.get('totals')).resolves.toEqual(totals);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(TRANSLATION_CACHE_TOUCH_FLUSH_MS - 1);
      expect(bulkPut).not.toHaveBeenCalled();
      await expect(translationCacheDb.entries.get(key)).resolves.toEqual(before);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => {
        await expect(translationCacheDb.entries.get(key)).resolves.toEqual({...before, lastAccessedAt: 2_000});
      });
      expect(bulkPut).toHaveBeenCalledOnce();
      await expect(translationCacheDb.totals.get('totals')).resolves.toEqual(totals);
      expect(vi.getTimerCount()).toBe(0);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      try {
        await translationCache.clear();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('retains non-string coercion and original coercion error identity on the native path', async () => {
    const convert = vi.fn(() => 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES));
    const value = {toString: convert} as unknown as string;
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    await expect(translationCache.set('coercion', value, 1_000)).resolves.toBe(false);
    expect(convert).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledTimes(2);

    const failure = new Error('coercion failed');
    const fail = vi.fn(() => {throw failure;});
    encode.mockClear();
    await expect(translationCache.set({toString: fail} as unknown as string, 'value', 1_000)).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledOnce();
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
  });

  it('keeps a normal encoder failure but safely rejects a definitely oversized primitive without encoding', async () => {
    const failure = new RangeError('controlled encoding allocation failure');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {throw failure;});

    await expect(translationCache.set('ordinary', 'value', 1_000)).rejects.toBe(failure);
    expect(encode).toHaveBeenCalledOnce();
    encode.mockClear();
    await expect(translationCache.set('oversized', 'x'.repeat(TRANSLATION_CACHE_MAX_ENTRY_BYTES), 1_000)).resolves.toBe(false);
    await expect(translationCacheDb.entries.count()).resolves.toBe(0);
    expect(encode).not.toHaveBeenCalled();
  });
});
