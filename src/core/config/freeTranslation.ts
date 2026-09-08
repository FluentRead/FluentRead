/**
 * @file src/core/config/freeTranslation.ts
 * 文件职责：定义免费翻译后备服务目录、默认顺序及等待策略的合法范围。
 * 主要内容：区分官方公开 API 与既有网页接口，清理未知和重复服务，保留用户停用与排序选择，并规范超时、冷却和可选邮箱。
 * 模块边界：本文件只包含纯配置规则，不读取存储、调用供应商或持有请求健康状态；运行时降级由翻译服务编排。
 */

export const FREE_TRANSLATION_PROVIDERS = [
    {id: 'microsoft', label: '微软翻译', description: 'Edge 网页接口，非官方公开 API', official: false},
    {id: 'deeplx', label: 'DeepLX', description: '非官方公共接口，无需密钥', official: false},
    {id: 'google', label: '谷歌翻译', description: '网页接口，非官方公开 API', official: false},
    {id: 'myMemory', label: 'MyMemory', description: '官方 API，匿名每天 5,000 字符', official: true},
    {id: 'apertium', label: 'Apertium', description: '免密钥开源翻译，支持部分欧洲语言对；不支持中日韩。', official: true},
] as const;

export const DEFAULT_FREE_TRANSLATION_ORDER = ['microsoft', 'deeplx', 'google', 'myMemory'] as const;
export const DEFAULT_FREE_TRANSLATION_TIMEOUT_MS = 5_000;
export const DEFAULT_FREE_TRANSLATION_COOLDOWN_MS = 60_000;

/** 显式列表只保留用户选中的服务，不能在读取设置时重新启用已停用接口。 */
export function normalizeFreeTranslationOrder(value: unknown): string[] {
    if (!Array.isArray(value)) return [...DEFAULT_FREE_TRANSLATION_ORDER];
    const known = new Set<string>(FREE_TRANSLATION_PROVIDERS.map(item => item.id));
    const order = [...new Set(value.filter((id): id is string => typeof id === 'string' && known.has(id)))];
    return order.length ? order : [...DEFAULT_FREE_TRANSLATION_ORDER];
}

function normalizeDuration(value: unknown, fallback: number, maximum: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(maximum, Math.max(1_000, Math.floor(value)))
        : fallback;
}

export function normalizeFreeTranslationTimeoutMs(value: unknown): number {
    return normalizeDuration(value, DEFAULT_FREE_TRANSLATION_TIMEOUT_MS, 15_000);
}

export function normalizeFreeTranslationCooldownMs(value: unknown): number {
    return normalizeDuration(value, DEFAULT_FREE_TRANSLATION_COOLDOWN_MS, 300_000);
}

export function normalizeMyMemoryEmail(value: unknown): string {
    if (typeof value !== 'string') return '';
    const email = value.trim();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : '';
}
