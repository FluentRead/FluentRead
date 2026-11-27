/**
 * @file src/core/tts/audioCache.ts
 * 文件职责：为已合成的 TTS 音频提供有界内存 LRU + 字节预算 + TTL 缓存，并合并相同参数的并发合成请求。
 * 主要内容：定义缓存键构造、条目元数据与统计契约，实现 TtsAudioCache（命中续期、超额淘汰、过大跳过及多等待者取消安全复用）。
 * 模块边界：本文件属于 core 纯领域层，不访问 IndexedDB/CacheStorage/网络，也不持有全局实例；由后台 TTS 合成服务组装与管理。
 */

import type {SpeechCue} from './speechProgress';
import type {TtsSourceId} from './backoff';

export interface TtsCachedAudioPayload {
    readonly audio: ArrayBuffer;
    readonly contentType: string;
    readonly voice: string;
    readonly source?: TtsSourceId;
    readonly fallbackFrom?: TtsSourceId;
    readonly timings?: SpeechCue[];
}

export interface TtsAudioCacheKeyInput {
    readonly mode: string;
    readonly sourceScope: string;
    readonly language: string;
    readonly voiceKey: string;
    readonly rate: number;
    readonly text: string;
}

export interface TtsAudioCacheOptions {
    readonly maxEntries?: number;
    readonly maxBytes?: number;
    readonly maxEntryBytes?: number;
    readonly ttlMs?: number;
    readonly now?: () => number;
}

export interface TtsAudioCacheStats {
    readonly entries: number;
    readonly bytes: number;
    readonly hits: number;
    readonly misses: number;
    readonly coalesced: number;
}

interface StoredEntry {
    readonly payload: TtsCachedAudioPayload;
    readonly bytes: number;
    readonly expiresAt: number;
}

interface InFlightTask {
    readonly promise: Promise<TtsCachedAudioPayload>;
    readonly controller: AbortController;
    waiters: number;
}

export const DEFAULT_TTS_AUDIO_CACHE_LIMITS = Object.freeze({
    maxEntries: 48,
    maxBytes: 12 * 1024 * 1024,
    maxEntryBytes: 2 * 1024 * 1024,
    ttlMs: 30 * 60 * 1000,
});

function createAbortError(): Error {
    const error = new Error('语音合成已取消');
    error.name = 'AbortError';
    return error;
}

/** 构造包含模式、来源范围、语言、音色偏好、语速与规范文本的确定性缓存键。 */
export function buildTtsAudioCacheKey(input: TtsAudioCacheKeyInput): string {
    const rateBucket = Math.round(input.rate * 100);
    const normalizedText = input.text.trim();
    const normalizedLang = input.language.trim().replace(/_/gu, '-').toLowerCase();
    return `${input.mode}|${input.sourceScope}|${normalizedLang}|${input.voiceKey}|r${rateBucket}|${normalizedText}`;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, onCancel: () => void): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', handleAbort);
            action();
        };
        const handleAbort = () => finish(() => {
            onCancel();
            reject(createAbortError());
        });
        signal.addEventListener('abort', handleAbort, {once: true});
        void promise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
        );
    });
}

/**
 * 有界内存音频缓存与并发去重器：
 * - 重复点击朗读同一词句时 0ms 直接命中返回
 * - 超出条数或字节上限时先清过期项，再按 LRU 淘汰最久未用条目
 * - 相同键的并发请求共享一次在途合成；单个等待者取消不影响其他等待者，最后一个取消时才中止底层请求
 */
export class TtsAudioCache {
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private readonly maxEntryBytes: number;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly entries = new Map<string, StoredEntry>();
    private readonly inFlight = new Map<string, InFlightTask>();
    private totalBytes = 0;
    private hits = 0;
    private misses = 0;
    private coalesced = 0;

    constructor(options: TtsAudioCacheOptions = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_TTS_AUDIO_CACHE_LIMITS.maxEntries);
        this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_TTS_AUDIO_CACHE_LIMITS.maxBytes);
        this.maxEntryBytes = Math.max(1, Math.min(this.maxBytes, options.maxEntryBytes ?? DEFAULT_TTS_AUDIO_CACHE_LIMITS.maxEntryBytes));
        this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTS_AUDIO_CACHE_LIMITS.ttlMs);
        this.now = options.now ?? (() => Date.now());
    }

    private deleteEntry(key: string): void {
        const existing = this.entries.get(key);
        if (!existing) return;
        this.entries.delete(key);
        this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
    }

    private pruneExpired(current: number): void {
        for (const [key, entry] of this.entries) {
            if (current >= entry.expiresAt) this.deleteEntry(key);
        }
    }

    get(key: string): TtsCachedAudioPayload | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }
        const current = this.now();
        if (current >= entry.expiresAt) {
            this.deleteEntry(key);
            this.misses += 1;
            return undefined;
        }
        // 刷新 LRU 顺序（Map 尾部为最近使用）。
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.hits += 1;
        return entry.payload;
    }

    set(key: string, payload: TtsCachedAudioPayload): boolean {
        const bytes = payload.audio.byteLength;
        if (bytes <= 0 || bytes > this.maxEntryBytes) return false;
        const current = this.now();
        this.deleteEntry(key);
        this.pruneExpired(current);
        while (this.entries.size > 0 && (this.entries.size >= this.maxEntries || this.totalBytes + bytes > this.maxBytes)) {
            this.deleteEntry(this.entries.keys().next().value!);
        }
        this.entries.set(key, {
            payload,
            bytes,
            expiresAt: current + this.ttlMs,
        });
        this.totalBytes += bytes;
        return true;
    }

    /** 优先命中缓存，其次复用在途任务，最后执行 producer 并在成功后入缓存。 */
    async getOrSynthesize(
        key: string,
        producer: (signal: AbortSignal) => Promise<TtsCachedAudioPayload>,
        signal?: AbortSignal,
    ): Promise<{payload: TtsCachedAudioPayload; cached: boolean}> {
        if (signal?.aborted) throw createAbortError();
        const cached = this.get(key);
        if (cached) return {payload: cached, cached: true};

        let task = this.inFlight.get(key);
        if (task) {
            this.coalesced += 1;
        } else {
            const controller = new AbortController();
            const runProducer = (): Promise<TtsCachedAudioPayload> => {
                try {
                    return Promise.resolve(producer(controller.signal));
                } catch (error) {
                    return Promise.reject(error);
                }
            };
            const created: InFlightTask = {
                controller,
                waiters: 0,
                promise: runProducer().then((result) => {
                    // clear() 或取消后不写回旧结果；降级回退音频不污染主缓存键。
                    if (this.inFlight.get(key) === created && !controller.signal.aborted && !result.fallbackFrom) {
                        this.set(key, result);
                    }
                    return result;
                }).finally(() => {
                    if (this.inFlight.get(key) === created) this.inFlight.delete(key);
                }),
            };
            // 防止全部等待者提前取消时产生 unhandled rejection。
            void created.promise.catch(() => undefined);
            this.inFlight.set(key, created);
            task = created;
        }

        const currentTask = task;
        currentTask.waiters += 1;
        let released = false;
        const releaseWaiter = (cancelled: boolean) => {
            if (released) return;
            released = true;
            currentTask.waiters = Math.max(0, currentTask.waiters - 1);
            if (cancelled && currentTask.waiters === 0) {
                currentTask.controller.abort();
            }
        };

        try {
            const payload = await awaitWithSignal(currentTask.promise, signal, () => releaseWaiter(true));
            releaseWaiter(false);
            return {payload, cached: false};
        } catch (error) {
            releaseWaiter(false);
            throw error;
        }
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
        for (const task of this.inFlight.values()) task.controller.abort();
        this.inFlight.clear();
    }

    stats(): TtsAudioCacheStats {
        this.pruneExpired(this.now());
        return {
            entries: this.entries.size,
            bytes: this.totalBytes,
            hits: this.hits,
            misses: this.misses,
            coalesced: this.coalesced,
        };
    }
}
