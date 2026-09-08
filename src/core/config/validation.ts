/**
 * @file src/core/config/validation.ts
 *
 * 文件职责：表达各翻译服务对 API Key 的领域校验规则，为保存、连接测试和请求前检查提供一致判定。
 * 主要内容：定义 CredentialConfig，结合服务类型及代理等配置计算凭据要求键，判断是否必须提供密钥，并生成面向用户的缺失凭据消息。 可核对的公开符号包括 CredentialConfig、getApiKeyRequirementKey、isApiKeyRequired、getMissingCredentialMessage。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import { customModelString, options, services, servicesType } from './catalog';
import {
    getCustomOpenAIProviderLabel,
    isCustomOpenAIProviderId,
    LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
    type CustomOpenAIProvider,
} from './customOpenAI';

export const API_KEY_REQUIREMENT_KEY_PREFIX = 'v2:' as const;

export interface CredentialConfig {
    token?: Record<string, string | undefined>;
    model?: Record<string, string | undefined>;
    customModel?: Record<string, string | undefined>;
    requireApiKey?: Record<string, boolean | undefined>;
    customOpenAIProviders?: readonly CustomOpenAIProvider[];
    youdaoAppKey?: string;
    youdaoAppSecret?: string;
    tencentSecretId?: string;
    tencentSecretKey?: string;
}

function getServiceLabel(service: string, config: CredentialConfig): string {
    if (isCustomOpenAIProviderId(service)) {
        return getCustomOpenAIProviderLabel(config.customOpenAIProviders, service);
    }
    return options.services.find((item) => item.value === service)?.label
        || service;
}

/** JSON 元组保留 service/model 边界，模型名即使包含冒号也不会与另一个服务碰撞。 */
export function createApiKeyRequirementKey(service: string, model: string): string {
    return `${API_KEY_REQUIREMENT_KEY_PREFIX}${JSON.stringify([service, model])}`;
}

export function getLegacyApiKeyRequirementKey(service: string, model: string): string {
    return `${service}:${model}`;
}

export function parseApiKeyRequirementKey(key: string): [service: string, model: string] | null {
    if (!key.startsWith(API_KEY_REQUIREMENT_KEY_PREFIX)) return null;
    try {
        const value: unknown = JSON.parse(key.slice(API_KEY_REQUIREMENT_KEY_PREFIX.length));
        return Array.isArray(value)
            && value.length === 2
            && typeof value[0] === 'string'
            && typeof value[1] === 'string'
            ? [value[0], value[1]]
            : null;
    } catch {
        return null;
    }
}

function getActualModel(service: string, config: CredentialConfig): string {
    const selectedModel = config.model?.[service] || '';
    return selectedModel === customModelString
        ? config.customModel?.[service] || selectedModel
        : selectedModel;
}

/** 使用服务和实际模型共同定位开关，避免切换模型或含冒号 ID 时误用另一项设置。 */
export function getApiKeyRequirementKey(service: string, config: CredentialConfig): string {
    return createApiKeyRequirementKey(service, getActualModel(service, config));
}

export function isApiKeyRequired(service: string, config: CredentialConfig): boolean {
    if (!servicesType.isAI(service)) return true;
    const requirement = config.requireApiKey?.[getApiKeyRequirementKey(service, config)];
    if (typeof requirement === 'boolean') return requirement;
    // custom:* 是新 schema，旧版本不可能为它写入无分隔键；禁止读取可能与
    // legacy custom + 冒号模型碰撞的旧键。内置服务与 legacy custom 仍兼容读取。
    if (isCustomOpenAIProviderId(service) && service !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID) return true;
    return config.requireApiKey?.[getLegacyApiKeyRequirementKey(service, getActualModel(service, config))] !== false;
}

/** 返回设置页和翻译前校验共用的凭据提示；返回 null 表示当前服务不缺凭据。 */
export function getMissingCredentialMessage(
    service: string,
    config: CredentialConfig,
): string | null {
    const serviceLabel = getServiceLabel(service, config);

    if (servicesType.isUseToken(service) && service !== services.deeplx && service !== services.libreTranslate && isApiKeyRequired(service, config)) {
        if (!config.token?.[service]?.trim()) {
            return `${serviceLabel} 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。`;
        }
    }

    if (service === services.youdao
        && (!config.youdaoAppKey?.trim() || !config.youdaoAppSecret?.trim())) {
        return `${serviceLabel} 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。`;
    }

    if (servicesType.isTencent(service)
        && (!config.tencentSecretId?.trim() || !config.tencentSecretKey?.trim())) {
        return `${serviceLabel} 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。`;
    }

    return null;
}
