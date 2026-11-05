/**
 * @file src/core/config/compositeTranslation.ts
 * 上下文能力：仅统计当前已启用且能消费提示词的成员，关闭项与原生翻译模型不使组合开启 AI 参考。
 * 文件职责：定义可把多个已配置翻译服务组成单一选择项的公开配置契约，供配置归一化、服务目录、设置表单与 broker 共同使用。
 * 主要内容：规范化随机、轮流与智能策略、稳定组合 ID、成员顺序及单成员时间预算；剔除失效自定义成员、重复成员和嵌套组合，并提供无副作用的查询、目录和删除辅助函数。
 * 模块边界：只处理不含凭据的公开组合数据，不读写存储、不发起网络请求、不保存运行统计；真实服务调用、失败回退和智能排序由翻译编排层负责。
 */
import {resolveConfiguredModel, services, servicesType} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider, type CustomOpenAIServiceOption} from './customOpenAI';
import {parseApiKeyRequirementKey} from './validation';
import {sha256Hex} from '@/src/shared/function/sha256';
import {isTranslationServiceDisabled} from './serviceAvailability';

export const COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX = 'composite:' as const;
export const DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS = 12_000;
export const COMPOSITE_TRANSLATION_TIMEOUT_MIN = 1_000;
export const COMPOSITE_TRANSLATION_TIMEOUT_MAX = 45_000;
export const MAX_COMPOSITE_TRANSLATION_PROVIDER_NAME_LENGTH = 80;
export type CompositeTranslationStrategy = 'random' | 'sequential' | 'smart';
export interface CompositeTranslationProvider {
    id: string;
    name: string;
    strategy: CompositeTranslationStrategy;
    services: string[];
    /** 每个成员尝试的预算；整体请求仍受 broker 截止时间约束。 */
    timeoutMs: number;
}

const ID_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
let fallbackIdSequence = 0;

export function isCompositeTranslationProviderId(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX)
        && ID_SUFFIX.test(value.slice(COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX.length));
}

export function normalizeCompositeTranslationStrategy(value: unknown): CompositeTranslationStrategy {
    return value === 'random' || value === 'smart' ? value : 'sequential';
}

export function normalizeCompositeTranslationTimeoutMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(COMPOSITE_TRANSLATION_TIMEOUT_MAX, Math.max(COMPOSITE_TRANSLATION_TIMEOUT_MIN, Math.trunc(value)))
        : DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS;
}

/** 组合只能引用真实普通服务；自定义服务必须仍在当前配置目录中。 */
export function isCompositeTranslationMemberService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    if (typeof service !== 'string') return false;
    if (isCustomOpenAIProviderId(service)) return isConfiguredCustomOpenAIProvider(customProviders, service);
    return servicesType.machine.has(service) || servicesType.AI.has(service);
}

export function normalizeCompositeTranslationProviders(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): CompositeTranslationProvider[] {
    if (!Array.isArray(value)) return [];
    const providers: CompositeTranslationProvider[] = [];
    const seenIds = new Set<string>();
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const own = (key: string): unknown => Object.prototype.hasOwnProperty.call(item, key) ? item[key] : undefined;
        const rawId = own('id');
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!isCompositeTranslationProviderId(id) || seenIds.has(id)) continue;
        seenIds.add(id);
        const rawName = own('name');
        const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_COMPOSITE_TRANSLATION_PROVIDER_NAME_LENGTH).trim() : '';
        const rawServices = own('services');
        const members = Array.isArray(rawServices) ? rawServices.map(service => typeof service === 'string' ? service.trim() : service) : [];
        providers.push({
            id,
            name: name || `组合翻译 ${providers.length + 1}`,
            strategy: normalizeCompositeTranslationStrategy(own('strategy')),
            services: [...new Set(members.filter(service => isCompositeTranslationMemberService(service, customProviders)))],
            timeoutMs: normalizeCompositeTranslationTimeoutMs(own('timeoutMs')),
        });
    }
    return providers;
}

export function getCompositeTranslationProvider(providers: readonly CompositeTranslationProvider[] | undefined, serviceId: string): CompositeTranslationProvider | undefined {
    return providers?.find(provider => provider.id === serviceId);
}

export function isConfiguredCompositeTranslationProvider(providers: readonly CompositeTranslationProvider[] | undefined, serviceId: string): boolean {
    return getCompositeTranslationProvider(providers, serviceId) !== undefined;
}

export function getCompositeTranslationServiceOptions(providers: readonly CompositeTranslationProvider[] | undefined): CustomOpenAIServiceOption[] {
    return (providers || []).map(provider => ({value: provider.id, label: provider.name,
        description: `${({random: '随机', sequential: '轮流', smart: '智能'} as const)[provider.strategy]} · ${provider.services.length} 个翻译服务`,
    }));
}

export function withCompositeTranslationServiceOptions<T extends CustomOpenAIServiceOption>(options: readonly T[], providers: readonly CompositeTranslationProvider[] | undefined): Array<T | CustomOpenAIServiceOption> {
    return [...options.filter(option => !isCompositeTranslationProviderId(option.value)), ...getCompositeTranslationServiceOptions(providers)];
}

function createCompositeTranslationProviderIdSuffix(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    fallbackIdSequence = (fallbackIdSequence + 1) % Number.MAX_SAFE_INTEGER;
    return [Date.now().toString(36), fallbackIdSequence.toString(36), Math.random().toString(36).slice(2, 14)].join('-');
}

export function createNextCompositeTranslationProviderId(providers: readonly CompositeTranslationProvider[] | undefined, createSuffix: () => string = createCompositeTranslationProviderIdSuffix): string {
    const used = new Set((providers || []).map(provider => provider.id));
    for (let attempt = 0; attempt < 32; attempt += 1) {
        const rawSuffix = createSuffix();
        const suffix = typeof rawSuffix === 'string' ? rawSuffix.trim() : '';
        const candidate = `${COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX}${suffix}`;
        if (isCompositeTranslationProviderId(candidate) && !used.has(candidate)) return candidate;
    }
    throw new Error('无法生成唯一的组合翻译服务 ID');
}

export function removeCompositeTranslationProvider(providers: readonly CompositeTranslationProvider[] | undefined, serviceId: string): CompositeTranslationProvider[] {
    return (providers || []).filter(provider => provider.id !== serviceId).map(provider => ({...provider, services: [...provider.services]}));
}

/** 只表示有成员可以消费上下文；组合本身仍不被视为 AI 或 AI 跨段合批服务。 */
export function hasCompositeTranslationAIContext(config: object, serviceId: string): boolean {
    if (!isCompositeTranslationProviderId(serviceId)) return false;
    const source = config as Record<string, any>;
    const provider = getCompositeTranslationProvider(source.compositeTranslationProviders, serviceId);
    return provider?.services.some(service => !isTranslationServiceDisabled(source.disabledTranslationServices, service)
        && servicesType.isUseAIContext(service,
        resolveConfiguredModel(source.model?.[service], source.customModel?.[service]))) ?? false;
}

/**
 * 只摘要所选组合和成员实际连接字段；用于前端会话失效，不把地址、正文、凭据或
 * 完整配置留在位图缓存/DOM 身份里。字段读取同时建立 Vue 响应式成员依赖。
 */
export function getCompositeTranslationConfigFingerprint(config: object, serviceId: string): string | undefined {
    if (!isCompositeTranslationProviderId(serviceId)) return undefined;
    const source = config as Record<string, any>;
    const provider = getCompositeTranslationProvider(source.compositeTranslationProviders, serviceId);
    if (!provider) return `composite-v1:${sha256Hex(serviceId)}`;
    const mappingFields = ['model', 'customModel', 'modelThinking', 'proxy', 'token', 'apiKeys', 'secret', 'customBody', 'customHeaders',
        'serviceRegion', 'system_role', 'user_role', 'apiKeyRotationEnabled', 'nativeBatchTranslationEnabled', 'serviceRequestLimits', 'modelRequestLimits'];
    const memberConfig = provider.services.map(service => ({
        service,
        fields: Object.fromEntries(mappingFields.map(field => [field, source[field]?.[service]])),
        customProvider: source.customOpenAIProviders?.find((item: CustomOpenAIProvider) => item.id === service),
        requireApiKey: Object.fromEntries(Object.entries(source.requireApiKey ?? {}).filter(([key]) => key === service
            || key.startsWith(`${service}:`) || parseApiKeyRequirementKey(key)?.[0] === service)),
        endpoint: service === services.custom ? source.custom : undefined,
        newApiUrl: service === services.newapi ? source.newApiUrl : undefined,
        azureOpenaiEndpoint: service === services.azureOpenai ? source.azureOpenaiEndpoint : undefined,
        deeplx: service === services.deeplx ? source.deeplx : undefined,
        myMemoryEmail: service === services.myMemory ? source.myMemoryEmail : undefined,
        youdaoCredentials: service === services.youdao ? [source.youdaoAppKey, source.youdaoAppSecret] : undefined,
        tencentCredentials: [services.tencent, services.huanYuan, services.huanYuanTranslation].includes(service)
            ? [source.tencentSecretId, source.tencentSecretKey] : undefined,
        deeplPlan: service === services.deepL ? source.deeplApiPlan : undefined,
        freeTranslation: service === services.freeTranslation
            ? [source.freeTranslationOrder, source.freeTranslationMode, source.freeTranslationTimeoutMs, source.freeTranslationCooldownMs] : undefined,
        minimax: service === services.minimax ? [source.minimaxBillingPlan, source.minimaxRegion] : undefined,
        mimo: service === services.mimo ? [source.mimoBillingPlan, source.mimoRegion] : undefined,
        deepseek: service === services.deepseek ? [source.deepseekApiType, source.deepseekThinkingMode] : undefined,
    }));
    return `composite-v1:${sha256Hex(JSON.stringify({
        id: provider.id, strategy: provider.strategy, services: provider.services, timeoutMs: provider.timeoutMs,
        members: memberConfig, requestHeaderRules: source.requestHeaderRules,
        apiKeyRecoveryMs: source.apiKeyRecoveryMs, translationMaxRetries: source.translationMaxRetries,
        translationBackoffBaseMs: source.translationBackoffBaseMs, translationBackoffMaxMs: source.translationBackoffMaxMs,
        legacyCredentials: [source.ak, source.sk, source.appid, source.key],
    }))}`;
}
