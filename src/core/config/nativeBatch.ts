/**
 * @file src/core/config/nativeBatch.ts
 *
 * 文件职责：统一原生多文本翻译协议的服务名单与按服务保存的合批偏好，让设置可见性和运行时请求决策使用同一领域规则。
 * 主要内容：声明五个可靠原生批量服务，默认全部开启；旧配置缺项及无效值继续使用开启默认值，只有支持服务的自有显式 false 才停用合批。
 * 模块边界：只处理服务标识和普通配置数据，不读写存储、不发送翻译请求，也不将 AI 多段翻译开关混入原生协议能力。
 */

import {services} from './catalog';

export const NATIVE_BATCH_TRANSLATION_SERVICES = Object.freeze([
    services.google,
    services.microsoft,
    services.deepL,
    services.azureTranslator,
    services.googleCloudTranslation,
]);

const nativeBatchServices = new Set<string>(NATIVE_BATCH_TRANSLATION_SERVICES);

export const DEFAULT_NATIVE_BATCH_TRANSLATION_ENABLED: Readonly<Record<string, boolean>> = Object.freeze(
    Object.fromEntries(NATIVE_BATCH_TRANSLATION_SERVICES.map((service) => [service, true])),
);

/** 协议能力不受用户偏好影响；其他逐项数组适配器不属于原生多文本服务。 */
export function isNativeBatchTranslationService(service: string): boolean {
    return nativeBatchServices.has(service);
}

/** 缺项和错误类型沿用默认开启；继承属性不能表达用户主动关闭。 */
export function isNativeTranslationBatchEnabled(service: string, preferences: unknown): boolean {
    return isNativeBatchTranslationService(service)
        && !(preferences !== null && typeof preferences === 'object' && !Array.isArray(preferences)
            && Object.hasOwn(preferences, service)
            && (preferences as Record<string, unknown>)[service] === false);
}

/** 只保留原生服务的布尔偏好，丢弃无关字段并为每次配置创建独立映射。 */
export function normalizeNativeBatchTranslationEnabled(value: unknown): Record<string, boolean> {
    return Object.fromEntries(NATIVE_BATCH_TRANSLATION_SERVICES.map((service) => [
        service, isNativeTranslationBatchEnabled(service, value),
    ]));
}
