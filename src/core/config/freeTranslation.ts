/**
 * @file src/core/config/freeTranslation.ts
 * 文件职责：定义免费翻译服务池、默认智能加速策略及请求预算的合法范围。
 * 主要内容：维护仅直连供应商的免密钥目录、冷启动权重、均衡与顺序模式，规范启用列表、超时及可选邮箱；迁移时移除第三方代理，保留其余明确选择。
 * 模块边界：本文件只包含纯配置规则，不读取存储、调用供应商或持有请求健康状态；运行时降级由翻译服务编排。
 */

/** official 表示由供应商运营，网页端点不等于有文档或服务保证的公开 API。 */
export const BILIBILI_FREE_TRANSLATION_DOMAIN = 'index-translate.bilibili.com';

export const FREE_TRANSLATION_PROVIDERS = [
    {id: 'microsoft', label: '微软翻译', description: 'Edge 网页接口，非官方公开 API', official: true, defaultWeight: 5},
    {id: 'bilibiliFree', label: 'B站翻译', description: '官方免费文本 API，Index-Translate-35B-A3B，无需密钥', official: true, defaultWeight: 2},
    {id: 'transmart', label: '腾讯交互翻译', description: '免密钥网页接口，与腾讯云翻译不同', official: true, defaultWeight: 3},
    {id: 'volcengineFree', label: '火山翻译', description: '免密钥网页接口，无需配置火山云账号', official: true, defaultWeight: 3},
    {id: 'google', label: '谷歌翻译', description: '网页接口，非官方公开 API', official: true, defaultWeight: 3},
    {id: 'youdaoFree', label: '有道网页翻译', description: '免密钥普通文本翻译，与有道智云不同', official: true, defaultWeight: 3},
    {id: 'icibaFree', label: '金山词霸', description: '免密钥网页翻译，自动处理网页签名', official: true, defaultWeight: 3},
    {id: 'yandexFree', label: 'Yandex', description: '免密钥网页接口，暂不支持繁体目标语言', official: true, defaultWeight: 2},
    {id: 'myMemory', label: 'MyMemory', description: '官方 API，匿名每天 5,000 字符', official: true, defaultWeight: 1},
    {id: 'sogouFree', label: '搜狗翻译', description: '实验性网页接口，自动处理临时签名', official: true, defaultWeight: 2},
    {id: 'reversoFree', label: 'Reverso', description: '实验性网页接口，可能触发访问验证', official: true, defaultWeight: 1},
    {id: 'apertiumFree', label: 'Apertium', description: '开放翻译服务，仅支持已提供的语言对，暂无中译', official: true, defaultWeight: 1},
    {id: 'alibabaFree', label: '阿里翻译', description: '官方网页接口，无需密钥', official: true, defaultWeight: 3},
    {id: 'modernMtFree', label: 'ModernMT', description: '官方网页接口，无需密钥', official: true, defaultWeight: 2},
    {id: 'laraFree', label: 'Lara', description: '官方网页接口，无需密钥', official: true, defaultWeight: 2},
    {id: 'lingvanexFree', label: 'Lingvanex', description: '官方网页接口，无需密钥', official: true, defaultWeight: 2},
] as const;

export type FreeTranslationProviderId = typeof FREE_TRANSLATION_PROVIDERS[number]['id'];

export function isFreeTranslationProviderId(value: unknown): value is FreeTranslationProviderId {
    return typeof value === 'string' && FREE_TRANSLATION_PROVIDERS.some(provider => provider.id === value);
}

export type FreeTranslationMode = 'balanced' | 'sequential';
export const DEFAULT_FREE_TRANSLATION_MODE: FreeTranslationMode = 'balanced';
export const DEFAULT_FREE_TRANSLATION_ORDER = FREE_TRANSLATION_PROVIDERS.map(provider => provider.id);
export const DEFAULT_FREE_TRANSLATION_TIMEOUT_MS = 5_000;
export const DEFAULT_FREE_TRANSLATION_COOLDOWN_MS = 60_000;
export const FREE_TRANSLATION_TOTAL_TIMEOUT_MS = 20_000;

export function normalizeFreeTranslationMode(value: unknown): FreeTranslationMode {
    return value === 'sequential' ? 'sequential' : DEFAULT_FREE_TRANSLATION_MODE;
}

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
