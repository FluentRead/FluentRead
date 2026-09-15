/**
 * @file src/services/translation/freeWeights.ts
 * 文件职责：把免费翻译服务的后台健康快照转换成设置页可读的百分比权重。
 * 主要内容：单次失败中的服务为 0，恢复中的服务沿用动态权重，并用最大余数法让可用服务总和稳定为 100%。
 * 模块边界：这里只处理不含凭据的服务 ID、性能和冷却时间；不读取存储、不发起请求，也不决定用户启停配置。
 */
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {
    getDynamicFreeProviderWeight,
    type FreeFailureCategory,
    type FreeProviderPerformance,
} from './freeRoutingPolicy';

/** 设置页读取后台快照的周期；实际翻译调度不会等待这个周期。 */
export const FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS = 5 * 60_000;
export const FREE_TRANSLATION_WEIGHTS_MESSAGE_TYPE = 'getFreeTranslationWeights' as const;

export type FreeTranslationWeightStatus = 'disabled' | 'ready' | 'cooling' | 'recovering';

/** 由后台去掉连接身份哈希后提供给 UI 的健康记录。 */
export interface FreeTranslationProviderHealth {
    providerId: string;
    retryAt: number;
    failures: number;
    category: FreeFailureCategory;
    performance?: FreeProviderPerformance;
}

export interface FreeTranslationWeightEntry {
    providerId: string;
    /** 当前服务在可用服务池中的百分比，保留一位小数。 */
    weight: number;
    status: FreeTranslationWeightStatus;
    retryAt?: number;
}

export interface FreeTranslationWeightSnapshot {
    /** 至少有一个可用服务时为 100；全部服务都在冷却时为 0。 */
    total: number;
    observedAt: number;
    entries: readonly FreeTranslationWeightEntry[];
}

export interface FreeTranslationWeightsResponse {
    success: true;
    snapshot: FreeTranslationWeightSnapshot;
}

function clampFailureCount(value: number): number {
    return Number.isInteger(value) && value > 0 ? Math.min(100, value) : 0;
}

function rawWeight(
    baseWeight: number,
    health: FreeTranslationProviderHealth | undefined,
    now: number,
): number {
    if (health && health.retryAt > now) return 0;
    if (health && health.failures > 0 && !health.performance) {
        // 兼容没有性能记录的旧冷却数据；下一次成功探测会重新建立平滑观测。
        return baseWeight * Math.max(0.1, 0.5 ** Math.min(4, clampFailureCount(health.failures)));
    }
    return getDynamicFreeProviderWeight(baseWeight, health?.performance, now);
}

function statusOf(
    enabled: boolean,
    health: FreeTranslationProviderHealth | undefined,
    now: number,
): FreeTranslationWeightStatus {
    if (!enabled) return 'disabled';
    if (health && health.retryAt > now) return 'cooling';
    if (health && (health.failures > 0 || (health.performance && health.performance.reliability < 0.999))) return 'recovering';
    return 'ready';
}

/**
 * 将精确权重四舍五入为一位小数，同时把舍入误差分配给小数部分最大的服务，
 * 避免界面出现 99.9% 或 100.1% 的总和。
 */
function roundedPercentages(values: readonly number[]): number[] {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return values.map(() => 0);
    const exact = values.map(value => value / total * 1000);
    const rounded = exact.map(value => Math.floor(value));
    let remaining = 1000 - rounded.reduce((sum, value) => sum + value, 0);
    const order = exact.map((value, index) => ({index, fraction: value - Math.floor(value)}))
        .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
    for (let index = 0; index < order.length && remaining > 0; index += 1, remaining -= 1) {
        rounded[order[index]!.index] += 1;
    }
    return rounded.map(value => value / 10);
}

/** 计算当前启用服务的展示权重；disabled 服务也返回一项，便于 UI 保持列表稳定。 */
export function calculateFreeTranslationWeightSnapshot(
    enabledProviderIds: readonly string[],
    health: readonly FreeTranslationProviderHealth[] = [],
    now = Date.now(),
): FreeTranslationWeightSnapshot {
    const enabled = new Set(enabledProviderIds);
    const healthByProvider = new Map(health.map(item => [item.providerId, item]));
    const rawValues = FREE_TRANSLATION_PROVIDERS.map(provider => (
        enabled.has(provider.id) ? rawWeight(provider.defaultWeight, healthByProvider.get(provider.id), now) : 0
    ));
    const totalRaw = rawValues.reduce((sum, value) => sum + value, 0);
    const percentages = roundedPercentages(rawValues);
    return {
        total: totalRaw > 0 ? 100 : 0,
        observedAt: now,
        entries: FREE_TRANSLATION_PROVIDERS.map((provider, index) => {
            const providerHealth = healthByProvider.get(provider.id);
            const cooling = providerHealth && providerHealth.retryAt > now;
            return {
                providerId: provider.id,
                weight: percentages[index]!,
                status: statusOf(enabled.has(provider.id), providerHealth, now),
                ...(cooling ? {retryAt: providerHealth!.retryAt} : {}),
            };
        }),
    };
}
