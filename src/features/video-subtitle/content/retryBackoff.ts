/**
 * @file src/features/video-subtitle/content/retryBackoff.ts
 * 文件职责：为视频字幕轨道拉取与逐句翻译提供统一的错误分类、带抖动退避延迟计算和轨道拉取退避状态机。
 * 主要内容：识别永久错误（鉴权、无效请求、服务禁用、401/403/404/410、扩展上下文失效）、限流错误（429、免费线路临时不可用、Retry-After）和瞬态错误；计算有界比例抖动退避并优先遵循 Retry-After；提供 createCaptionFetchBackoff 管理前两次 5 秒后递增至 60 秒的轨道重试与永久/超限停止。
 * 模块边界：本文件为纯算法模块，不访问 DOM、全局配置或网络接口；可选注入 now 与 random 以保证测试确定性。
 */

export type VideoErrorCategory = 'permanent' | 'rate-limit' | 'transient';

export interface ClassifiedVideoError {
  readonly category: VideoErrorCategory;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
  readonly message: string;
}

export interface BackoffDelayOptions {
  readonly baseDelaysMs?: readonly number[];
  readonly retryAfterMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export interface CaptionFetchBackoffOptions {
  readonly baseDelaysMs?: readonly number[];
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
  readonly jitterRatio?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface CaptionFetchBackoffState {
  readonly attempts: number;
  readonly retryAt: number;
  readonly exhausted: boolean;
  readonly lastCategory: VideoErrorCategory | null;
  readonly lastMessage: string;
}

export interface CaptionFetchBackoff {
  canAttempt(now?: number): boolean;
  recordSuccess(): void;
  recordFailure(error: unknown, now?: number): CaptionFetchBackoffState;
  reset(): void;
  getState(): CaptionFetchBackoffState;
}

const PERMANENT_STATUS_CODES = new Set([401, 403, 404, 410]);
const TRANSIENT_ERROR_KINDS: ReadonlySet<string | undefined> = new Set(['timeout', 'network', 'provider', 'response']);
const CONTEXT_INVALIDATED_PATTERN = /extension context invalidated|扩展上下文已失效/iu;
const DEFAULT_BASE_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];
const DEFAULT_CAPTION_FETCH_DELAYS_MS: readonly number[] = [5_000, 5_000, 15_000, 30_000, 60_000];
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_CAPTION_FETCH_MAX_ATTEMPTS = 6;

interface VideoErrorLike {
  readonly kind?: unknown;
  readonly retryable?: unknown;
  readonly statusCode?: unknown;
  readonly code?: unknown;
  readonly retryAfterMs?: unknown;
  readonly message?: unknown;
}

export function classifyVideoError(error: unknown): ClassifiedVideoError {
  const candidate: VideoErrorLike = error !== null && typeof error === 'object'
    ? error as VideoErrorLike
    : {};
  const message = typeof candidate.message === 'string'
    ? candidate.message.trim()
    : typeof error === 'string'
      ? error.trim()
      : '';
  const statusCode = typeof candidate.statusCode === 'number' && Number.isFinite(candidate.statusCode)
    ? candidate.statusCode
    : undefined;
  const retryAfterMs = typeof candidate.retryAfterMs === 'number'
    && Number.isFinite(candidate.retryAfterMs)
    && candidate.retryAfterMs > 0
    ? candidate.retryAfterMs
    : undefined;
  const kind = typeof candidate.kind === 'string' ? candidate.kind : undefined;
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : undefined;

  if (
    kind === 'authentication'
    || kind === 'bad-request'
    || code === 'TRANSLATION_SERVICE_DISABLED'
    || (statusCode !== undefined && PERMANENT_STATUS_CODES.has(statusCode))
    || CONTEXT_INVALIDATED_PATTERN.test(message)
  ) {
    return {
      category: 'permanent',
      ...(statusCode !== undefined ? {statusCode} : {}),
      ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
      message,
    };
  }

  if (
    kind === 'rate-limit'
    || statusCode === 429
    || code === 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE'
    || retryAfterMs !== undefined
  ) {
    return {
      category: 'rate-limit',
      ...(statusCode !== undefined ? {statusCode} : {}),
      ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
      message,
    };
  }

  if (retryable === false && !TRANSIENT_ERROR_KINDS.has(kind)) {
    return {
      category: 'permanent',
      ...(statusCode !== undefined ? {statusCode} : {}),
      message,
    };
  }

  return {
    category: 'transient',
    ...(statusCode !== undefined ? {statusCode} : {}),
    message,
  };
}

export function computeBackoffDelayMs(attempt: number, options: BackoffDelayOptions = {}): number {
  const baseDelays = options.baseDelaysMs && options.baseDelaysMs.length > 0
    ? options.baseDelaysMs
    : DEFAULT_BASE_DELAYS_MS;
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const baseIndex = Math.min(safeAttempt - 1, baseDelays.length - 1);
  const baseDelay = Math.max(0, baseDelays[baseIndex]!);

  const jitterRatio = typeof options.jitterRatio === 'number' && Number.isFinite(options.jitterRatio)
    ? Math.min(1, Math.max(0, options.jitterRatio))
    : DEFAULT_JITTER_RATIO;
  const randomValue = (options.random ?? Math.random)();
  const boundedRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
  const jittered = Math.round(baseDelay * (1 + boundedRandom * jitterRatio));

  const retryAfterMs = typeof options.retryAfterMs === 'number'
    && Number.isFinite(options.retryAfterMs)
    && options.retryAfterMs > 0
    ? options.retryAfterMs
    : 0;

  const hasExplicitMax = typeof options.maxDelayMs === 'number' && Number.isFinite(options.maxDelayMs);
  const maxDelay = hasExplicitMax ? Math.max(0, options.maxDelayMs!) : DEFAULT_MAX_DELAY_MS;
  const boundedBase = Math.min(jittered, maxDelay);
  const combined = Math.max(boundedBase, retryAfterMs);
  return hasExplicitMax ? Math.min(combined, maxDelay) : combined;
}

export function createCaptionFetchBackoff(options: CaptionFetchBackoffOptions = {}): CaptionFetchBackoff {
  const baseDelaysMs = options.baseDelaysMs ?? DEFAULT_CAPTION_FETCH_DELAYS_MS;
  const maxAttempts = typeof options.maxAttempts === 'number' && Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.floor(options.maxAttempts))
    : DEFAULT_CAPTION_FETCH_MAX_ATTEMPTS;
  const getNow = options.now ?? Date.now;

  let attempts = 0;
  let retryAt = 0;
  let exhausted = false;
  let lastCategory: VideoErrorCategory | null = null;
  let lastMessage = '';

  const reset = (): void => {
    attempts = 0;
    retryAt = 0;
    exhausted = false;
    lastCategory = null;
    lastMessage = '';
  };

  const getState = (): CaptionFetchBackoffState => ({
    attempts,
    retryAt,
    exhausted,
    lastCategory,
    lastMessage,
  });

  return {
    canAttempt(now = getNow()): boolean {
      return !exhausted && now >= retryAt;
    },
    recordSuccess(): void {
      reset();
    },
    recordFailure(error: unknown, now = getNow()): CaptionFetchBackoffState {
      const classified = classifyVideoError(error);
      attempts += 1;
      lastCategory = classified.category;
      lastMessage = classified.message;

      if (classified.category === 'permanent' || attempts >= maxAttempts) {
        exhausted = true;
        retryAt = Infinity;
        return getState();
      }

      // 前两次失败保持精确 5 秒重试窗口以兼容现有测试契约；第 3 次起按指数退避并启用有界抖动。
      const jitterRatio = options.jitterRatio !== undefined
        ? options.jitterRatio
        : attempts <= 2
          ? 0
          : DEFAULT_JITTER_RATIO;
      const delayMs = computeBackoffDelayMs(attempts, {
        baseDelaysMs,
        retryAfterMs: classified.retryAfterMs,
        maxDelayMs: options.maxDelayMs,
        jitterRatio,
        random: options.random,
      });
      retryAt = now + delayMs;
      return getState();
    },
    reset,
    getState,
  };
}
