/**
 * @file src/features/video-subtitle/content/translationCache.ts
 * 文件职责：管理一个视频轨道的译文 LRU 缓存、请求合并、供应商级熔断退避与预取窗口调度。
 * 主要内容：同步读取已完成译文并刷新 LRU 活跃度（上限 160 条），使双语在同一次更新中显示；基于 retryBackoff 区分永久错误、限流共享冷却（到期单探针恢复）与单句瞬态指数退避，暴露只读 getFailureStatus 供 UI/运行时展示状态和一键重试；支持跳转抢占取消在途旧预取，复用未变预取窗口并跳过已缓存/在途预取的重复集合与正则开销，以版本隔离清理前的迟到结果。
 * 模块边界：只调用注入的翻译函数，不读取配置、网络或播放器；轨道和配置变化由 runtime 显式 clear。
 */
import {VideoTranslationScheduler} from './translationScheduler';
import {normalizeVideoCaptionText, VideoSubtitlePretranslationWindow} from './subtitleLogic';
import {classifyVideoError, computeBackoffDelayMs} from './retryBackoff';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export interface VideoTranslationFailureStatus {
  readonly state: 'ok' | 'retrying' | 'cooldown' | 'permanent';
  readonly retryAt: number;
  readonly message: string;
}

const MAX_CACHE_ENTRIES = 160;
const TRANSIENT_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];
const RATE_LIMIT_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

export class VideoTranslationCache {
  private readonly translatedVideoCache = new Map<string, string>();
  private readonly inFlightVideoTranslations = new Map<string, Promise<string>>();
  private readonly videoTranslationFailures = new Map<string, {attempts: number; retryAt: number}>();
  private readonly translationScheduler: VideoTranslationScheduler;
  private readonly pretranslationWindow = new VideoSubtitlePretranslationWindow();
  private pretranslationCacheVersion = 0;
  private visibleRevision = 0;
  private sharedCooldownUntil = 0;
  private rateLimitAttempts = 0;
  private permanentFailure = false;
  private activeProbe: Promise<string> | null = null;
  private lastFailureMessage = '';
  private lastPrimedSelected: readonly VideoSubtitleCue[] | undefined;
  private lastPrimedKeys: string[] = [];

  /** 原生字幕轨只在成功缓存变化时重建完整时间轴。 */
  get revision(): number { return this.visibleRevision; }

  constructor(
    translate: (text: string, signal: AbortSignal) => Promise<string>,
    private readonly options: {random?: () => number} = {},
  ) {
    this.translationScheduler = new VideoTranslationScheduler(translate);
  }

  private resetCircuitState(): void {
    this.sharedCooldownUntil = 0;
    this.rateLimitAttempts = 0;
    this.permanentFailure = false;
    this.activeProbe = null;
    this.lastFailureMessage = '';
  }

  private touchCached(key: string, value: string): void {
    this.translatedVideoCache.delete(key);
    this.translatedVideoCache.set(key, value);
  }

  private recordCueFailure(key: string, attempts: number, retryAt: number): void {
    this.videoTranslationFailures.delete(key);
    this.videoTranslationFailures.set(key, {attempts, retryAt});
    if (this.videoTranslationFailures.size > MAX_CACHE_ENTRIES) {
      this.videoTranslationFailures.delete(this.videoTranslationFailures.keys().next().value!);
    }
  }

  clear(): void {
    if (this.translatedVideoCache.size) this.visibleRevision += 1;
    this.translatedVideoCache.clear();
    this.pretranslationWindow.clear();
    this.cancelPending();
  }

  /** 只切换显示方式时取消在途请求，保留已经成功的译文。 */
  cancelPending(): void {
    this.pretranslationCacheVersion += 1;
    this.inFlightVideoTranslations.clear();
    this.videoTranslationFailures.clear();
    this.resetCircuitState();
    this.lastPrimedSelected = undefined;
    this.lastPrimedKeys = [];
    this.translationScheduler.clear();
  }

  /** 当前句失败或供应商限流/永久失败后允许一键重试，保留同一视频中已经成功的译文。 */
  retryFailures(): void {
    this.videoTranslationFailures.clear();
    this.resetCircuitState();
  }

  getFailureStatus(): VideoTranslationFailureStatus {
    if (this.permanentFailure) {
      return {state: 'permanent', retryAt: Infinity, message: this.lastFailureMessage};
    }
    if (this.sharedCooldownUntil > 0) {
      return {state: 'cooldown', retryAt: this.sharedCooldownUntil, message: this.lastFailureMessage};
    }
    if (this.videoTranslationFailures.size > 0) {
      let earliestRetryAt = Infinity;
      for (const entry of this.videoTranslationFailures.values()) {
        if (entry.retryAt < earliestRetryAt) earliestRetryAt = entry.retryAt;
      }
      return {state: 'retrying', retryAt: earliestRetryAt, message: this.lastFailureMessage};
    }
    return {state: 'ok', retryAt: 0, message: ''};
  }

  hasFailure(source: string): boolean {
    return this.videoTranslationFailures.has(normalizeVideoCaptionText(source));
  }

  peek(source: string): string | undefined {
    const key = normalizeVideoCaptionText(source);
    const cached = this.translatedVideoCache.get(key);
    if (cached !== undefined) this.touchCached(key, cached);
    return cached;
  }

  private retainPrefetchesFromKeys(keys: ReadonlySet<string>): void {
    for (const source of this.translationScheduler.retainPrefetches(keys)) {
      this.inFlightVideoTranslations.delete(source);
    }
  }

  retainPrefetches(sources: readonly string[]): void {
    this.retainPrefetchesFromKeys(new Set(sources.map(source => normalizeVideoCaptionText(source))));
  }

  /** 跳转抢占：取消未启动旧预取并向在途旧预取发送 abort 信号，同时清理所有已中止预取的在途记录。 */
  abortPrefetchesNotIn(sources: readonly string[]): void {
    const keys = new Set(sources.map(source => normalizeVideoCaptionText(source)));
    for (const source of this.translationScheduler.abortPrefetchesNotIn(keys)) {
      this.inFlightVideoTranslations.delete(source);
    }
  }

  primeUpcoming(cues: readonly VideoSubtitleCue[], currentMs: number, windowMs: number, playbackRate: number,
    request: (source: string, prefetch: boolean, cue: VideoSubtitleCue) => Promise<string>): void {
    const selected = this.pretranslationWindow.select(cues, currentMs, windowMs, playbackRate);
    if (selected !== this.lastPrimedSelected) {
      this.lastPrimedSelected = selected;
      this.lastPrimedKeys = selected.map(cue => normalizeVideoCaptionText(cue.text));
      const keys = this.lastPrimedKeys.length > 0 ? new Set(this.lastPrimedKeys) : EMPTY_STRING_SET;
      this.retainPrefetchesFromKeys(keys);
    }
    for (let index = 0; index < selected.length; index += 1) {
      const key = this.lastPrimedKeys[index]!;
      if (this.translatedVideoCache.has(key)) continue;
      const cue = selected[index]!;
      const prefetch = cue.startMs > currentMs;
      if (prefetch && this.inFlightVideoTranslations.has(key)) continue;
      void request(cue.text, prefetch, cue).catch(() => undefined);
    }
  }

  request(source: string, prefetch = false): Promise<string> {
    const key = normalizeVideoCaptionText(source);
    if (!key) return Promise.resolve(source);

    const cached = this.translatedVideoCache.get(key);
    if (cached !== undefined) {
      this.touchCached(key, cached);
      return Promise.resolve(cached);
    }

    if (this.permanentFailure) return Promise.resolve('');

    const existing = this.inFlightVideoTranslations.get(key);
    if (existing) {
      if (!prefetch) void this.translationScheduler.request(key).catch(() => undefined);
      return existing;
    }

    const now = Date.now();
    let isProbe = false;
    if (this.sharedCooldownUntil > 0) {
      if (now < this.sharedCooldownUntil || this.activeProbe !== null) {
        return Promise.resolve('');
      }
      isProbe = true;
    }

    const failure = this.videoTranslationFailures.get(key);
    if (!isProbe && failure && now < failure.retryAt) {
      // 播放器更新频率很高；失败退避期间返回空结果，避免瞬态错误每 120ms 重发并刷满日志与网络。
      return Promise.resolve('');
    }

    const requestVersion = this.pretranslationCacheVersion;
    let pendingRequest: Promise<string>;
    pendingRequest = this.translationScheduler.request(key, prefetch)
      .then((translated) => {
        const result = typeof translated === 'string' ? translated.trim() : '';
        // 空响应不是成功译文，更不能在下次播放时把原文冒充译文缓存命中。
        if (!result) throw new Error('视频字幕翻译返回空内容');
        if (requestVersion === this.pretranslationCacheVersion) {
          this.videoTranslationFailures.delete(key);
          this.sharedCooldownUntil = 0;
          this.rateLimitAttempts = 0;
          if (this.videoTranslationFailures.size === 0) this.lastFailureMessage = '';
          this.touchCached(key, result);
          this.visibleRevision += 1;
          if (this.translatedVideoCache.size > MAX_CACHE_ENTRIES) {
            this.translatedVideoCache.delete(this.translatedVideoCache.keys().next().value!);
          }
        }
        return result;
      })
      .catch((error) => {
        if (requestVersion === this.pretranslationCacheVersion && (error as Error)?.name !== 'AbortError') {
          const classified = classifyVideoError(error);
          const previousAttempts = this.videoTranslationFailures.get(key)?.attempts || 0;
          if (classified.category === 'permanent') {
            this.permanentFailure = true;
            this.sharedCooldownUntil = Infinity;
            this.lastFailureMessage = classified.message;
            this.recordCueFailure(key, previousAttempts + 1, Infinity);
          } else if (!this.permanentFailure) {
            this.lastFailureMessage = classified.message;
            if (classified.category === 'rate-limit') {
              const failedAt = Date.now();
              if (failedAt >= this.sharedCooldownUntil) {
                this.rateLimitAttempts = Math.min(this.rateLimitAttempts + 1, RATE_LIMIT_DELAYS_MS.length);
              }
              const delayMs = computeBackoffDelayMs(this.rateLimitAttempts, {
                baseDelaysMs: RATE_LIMIT_DELAYS_MS,
                retryAfterMs: classified.retryAfterMs,
                jitterRatio: 0.2,
                random: this.options.random,
              });
              const retryAt = failedAt + delayMs;
              this.sharedCooldownUntil = Math.max(this.sharedCooldownUntil, retryAt);
              this.recordCueFailure(key, previousAttempts + 1, this.sharedCooldownUntil);
            } else {
              if (this.activeProbe === pendingRequest) {
                this.sharedCooldownUntil = 0;
                this.rateLimitAttempts = 0;
              }
              const attempts = Math.min(previousAttempts + 1, TRANSIENT_DELAYS_MS.length);
              const delayMs = computeBackoffDelayMs(attempts, {
                baseDelaysMs: TRANSIENT_DELAYS_MS,
                jitterRatio: 0.2,
                random: this.options.random,
              });
              this.recordCueFailure(key, attempts, Date.now() + delayMs);
            }
          }
        }
        throw error;
      })
      .finally(() => {
        if (this.activeProbe === pendingRequest) this.activeProbe = null;
        if (this.inFlightVideoTranslations.get(key) === pendingRequest) this.inFlightVideoTranslations.delete(key);
      });
    if (isProbe) this.activeProbe = pendingRequest;
    this.inFlightVideoTranslations.set(key, pendingRequest);
    return pendingRequest;
  }
}
