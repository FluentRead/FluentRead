/**
 * @file src/core/config/scheduling.ts
 *
 * 文件职责：定义翻译任务调度相关的默认值、合法范围和纯规范化函数。
 * 主要内容：覆盖并发、每秒/每分钟请求上限、失败重试次数以及指数退避的基准和上限。
 * 模块边界：该文件不依赖服务目录、存储或浏览器运行时，便于内容脚本、后台调度器和配置模型共享同一套边界。
 */

export const DEFAULT_MAX_CONCURRENT_TRANSLATIONS = 6;
export const MIN_CONCURRENT_TRANSLATIONS = 1;
export const MAX_CONCURRENT_TRANSLATIONS = 100;
export const DEFAULT_TRANSLATION_REQUESTS_PER_SECOND = 10;
export const MIN_TRANSLATION_REQUESTS_PER_SECOND = 0;
export const MAX_TRANSLATION_REQUESTS_PER_SECOND = 1000;
export const DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE = 250;
export const MIN_TRANSLATION_REQUESTS_PER_MINUTE = 0;
export const MAX_TRANSLATION_REQUESTS_PER_MINUTE = 10_000;
export const DEFAULT_TRANSLATION_MAX_RETRIES = 3;
export const MIN_TRANSLATION_MAX_RETRIES = 0;
export const MAX_TRANSLATION_MAX_RETRIES = 10;
export const DEFAULT_TRANSLATION_BACKOFF_BASE_MS = 500;
export const MIN_TRANSLATION_BACKOFF_BASE_MS = 100;
export const MAX_TRANSLATION_BACKOFF_BASE_MS = 60_000;
export const DEFAULT_TRANSLATION_BACKOFF_MAX_MS = 3_000;
export const MIN_TRANSLATION_BACKOFF_MAX_MS = 1000;
export const MAX_TRANSLATION_BACKOFF_MAX_MS = 300_000;

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

export function normalizeMaxConcurrentTranslations(value: unknown): number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= MIN_CONCURRENT_TRANSLATIONS
        && value <= MAX_CONCURRENT_TRANSLATIONS
        ? value
        : DEFAULT_MAX_CONCURRENT_TRANSLATIONS;
}

export function normalizeTranslationRequestsPerSecond(value: unknown): number {
    return normalizeInteger(
        value,
        DEFAULT_TRANSLATION_REQUESTS_PER_SECOND,
        MIN_TRANSLATION_REQUESTS_PER_SECOND,
        MAX_TRANSLATION_REQUESTS_PER_SECOND,
    );
}

export function normalizeTranslationRequestsPerMinute(value: unknown): number {
    return normalizeInteger(
        value,
        DEFAULT_TRANSLATION_REQUESTS_PER_MINUTE,
        MIN_TRANSLATION_REQUESTS_PER_MINUTE,
        MAX_TRANSLATION_REQUESTS_PER_MINUTE,
    );
}

export function normalizeTranslationMaxRetries(value: unknown): number {
    return normalizeInteger(
        value,
        DEFAULT_TRANSLATION_MAX_RETRIES,
        MIN_TRANSLATION_MAX_RETRIES,
        MAX_TRANSLATION_MAX_RETRIES,
    );
}

export function normalizeTranslationBackoffBaseMs(value: unknown): number {
    return normalizeInteger(
        value,
        DEFAULT_TRANSLATION_BACKOFF_BASE_MS,
        MIN_TRANSLATION_BACKOFF_BASE_MS,
        MAX_TRANSLATION_BACKOFF_BASE_MS,
    );
}

export function normalizeTranslationBackoffMaxMs(value: unknown): number {
    return normalizeInteger(
        value,
        DEFAULT_TRANSLATION_BACKOFF_MAX_MS,
        MIN_TRANSLATION_BACKOFF_MAX_MS,
        MAX_TRANSLATION_BACKOFF_MAX_MS,
    );
}
