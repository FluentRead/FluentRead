/**
 * @file src/features/video-subtitle/content/translationCache.ts
 * 文件职责：管理一个视频轨道的译文缓存、请求合并和失败重试退避。
 * 主要内容：同步读取已完成译文，使双语在同一次更新中显示；限制缓存条数，复用边界未变化的预取窗口并清理已离开窗口的未启动预取，以版本隔离清理前的迟到结果。
 * 模块边界：只调用注入的翻译函数，不读取配置、网络或播放器；轨道和配置变化由 runtime 显式 clear。
 */
import {VideoTranslationScheduler} from './translationScheduler';
import {VideoSubtitlePretranslationWindow} from './subtitleLogic';
import type {VideoSubtitleCue} from './youtubeSubtitleData';
export class VideoTranslationCache {
  private readonly translatedVideoCache = new Map<string, string>();
  private readonly inFlightVideoTranslations = new Map<string, Promise<string>>();
  private readonly videoTranslationFailures = new Map<string, {attempts: number; retryAt: number}>();
  private readonly translationScheduler: VideoTranslationScheduler;
  private readonly pretranslationWindow = new VideoSubtitlePretranslationWindow();
  private pretranslationCacheVersion = 0;
  private visibleRevision = 0;
  /** 原生字幕轨只在成功缓存变化时重建完整时间轴。 */
  get revision(): number { return this.visibleRevision; }
  constructor(translate: (text: string, signal: AbortSignal) => Promise<string>) {
    this.translationScheduler = new VideoTranslationScheduler(translate);
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
    this.translationScheduler.clear();
  }
  /** 当前句失败可单独重试，保留同一视频中已经成功的译文。 */
  retryFailures(): void {
    this.videoTranslationFailures.clear();
  }
  hasFailure(source: string): boolean {
    return this.videoTranslationFailures.has(source.replace(/[\s\u3000]+/g, ' ').trim());
  }
  peek(source: string): string | undefined {
    return this.translatedVideoCache.get(source.replace(/[\s\u3000]+/g, ' ').trim());
  }
  retainPrefetches(sources: readonly string[]): void {
    const keys = new Set(sources.map(source => source.replace(/[\s\u3000]+/g, ' ').trim()));
    for (const source of this.translationScheduler.retainPrefetches(keys)) {
      this.inFlightVideoTranslations.delete(source);
    }
  }
  primeUpcoming(cues: readonly VideoSubtitleCue[], currentMs: number, windowMs: number, playbackRate: number,
    request: (source: string, prefetch: boolean, cue: VideoSubtitleCue) => Promise<string>): void {
    const selected = this.pretranslationWindow.select(cues, currentMs, windowMs, playbackRate);
    this.retainPrefetches(selected.map(cue => cue.text));
    for (const cue of selected) void request(cue.text, cue.startMs > currentMs, cue).catch(() => undefined);
  }
  request(source: string, prefetch = false): Promise<string> {
    const key = source.replace(/[\s\u3000]+/g, ' ').trim();
    if (!key) return Promise.resolve(source);

    const cached = this.translatedVideoCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const failure = this.videoTranslationFailures.get(key);
    if (failure && Date.now() < failure.retryAt) {
      // 播放器更新频率很高；失败退避期间返回空结果，避免 API Key/429 等
      // 错误每 120ms 重发并刷满日志与网络。
      return Promise.resolve('');
    }

    const existing = this.inFlightVideoTranslations.get(key);
    if (existing) {
      if (!prefetch) void this.translationScheduler.request(key).catch(() => undefined);
      return existing;
    }

    const requestVersion = this.pretranslationCacheVersion;
    let request: Promise<string>;
    request = this.translationScheduler.request(key, prefetch)
      .then((translated) => {
        const result = typeof translated === 'string' ? translated.trim() : '';
        // 空响应不是成功译文，更不能在下次播放时把原文冒充译文缓存命中。
        if (!result) throw new Error('视频字幕翻译返回空内容');
        if (requestVersion === this.pretranslationCacheVersion) {
          this.videoTranslationFailures.delete(key);
          this.translatedVideoCache.set(key, result);
          this.visibleRevision += 1;
          if (this.translatedVideoCache.size > 160) {
            const oldestKey = this.translatedVideoCache.keys().next().value;
            if (oldestKey) this.translatedVideoCache.delete(oldestKey);
          }
        }
        return result;
      })
      .catch((error) => {
        if (requestVersion === this.pretranslationCacheVersion && (error as Error)?.name !== 'AbortError') {
          const previousAttempts = this.videoTranslationFailures.get(key)?.attempts || 0;
          const attempts = Math.min(previousAttempts + 1, 4);
          const retryDelays = [2_000, 5_000, 15_000, 30_000];
          this.videoTranslationFailures.set(key, {
            attempts,
            retryAt: Date.now() + retryDelays[attempts - 1],
          });
          if (this.videoTranslationFailures.size > 160) {
            const oldestKey = this.videoTranslationFailures.keys().next().value;
            if (oldestKey) this.videoTranslationFailures.delete(oldestKey);
          }
        }
        throw error;
      })
      .finally(() => {
        if (this.inFlightVideoTranslations.get(key) === request) this.inFlightVideoTranslations.delete(key);
      });
    this.inFlightVideoTranslations.set(key, request);
    return request;
  }
}
