/**
 * @file src/core/config/model/providerNormalization.ts
 *
 * 文件职责：封装配置归一化中的服务与模型子域规则，包括自定义 OpenAI 档案迁移、退役服务清理、云地域白名单收敛、自定义模型与 Thinking 偏好保护。
 * 主要内容：导出 normalizeCustomOpenAIProviderState、hasConfiguredAiPlatformService、isSupportedTranslationService、normalizeChatGPTPlanModelState、normalizeSavedCustomModelState、normalizeModelThinkingState、upgradeLegacyDefaultUserRoles、normalizeCloudRegionMapping、normalizeCustomModelMapping 与退役键清理辅助函数。
 * 模块边界：仅作为 config/model 内部子域归一化模块被 normalizeConfig 调用，通过 type-only 导入引用 Config 类型以避免与 configClass 产生循环依赖。
 */

import {apiKeysToToken} from '../apiKeys';
import {currentModelIds, defaultModelIds, defaultModels, models} from '../catalog/models';
import {defaultOption, LEGACY_DEFAULT_USER_ROLES} from '../catalog/prompts';
import {resolveCloudRegion} from '../catalog/regions';
import {resolveConfiguredModel, services} from '../catalog/services';
import {servicesType} from '../catalog/serviceTypes';
import {
    isCompositeTranslationProviderId,
    isConfiguredCompositeTranslationProvider,
    type CompositeTranslationProvider,
} from '../compositeTranslation';
import {
    CUSTOM_OPENAI_RESERVED_MODEL_ID,
    getCustomOpenAIProvider,
    isConfiguredCustomOpenAIProvider,
    isCustomOpenAIProviderId,
    LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
    MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
    normalizeCustomOpenAIModels,
    normalizeCustomOpenAIProviders,
    type CustomOpenAIProvider,
} from '../customOpenAI';
import {normalizeDictionaryWorkspace} from '../dictionaryWorkspace';
import type {ModelThinkingMapping} from '../modelThinking';
import {
    API_KEY_REQUIREMENT_KEY_PREFIX,
    createApiKeyRequirementKey,
    getLegacyApiKeyRequirementKey,
    parseApiKeyRequirementKey,
} from '../validation';
import {configuredString, hasOwn, isBooleanMapping, isRecord, normalizeStringMapping} from './clone';
import type {Config} from './configClass';
import {migrateModelIdentifier} from './modelMigration';
import type {IMapping} from './types';

// 已退役服务只在配置迁移边界保留标识，用于清除旧版本遗留的不可见配置和凭据。
const retiredServiceIds = new Set(['cozecom', 'cozecn']);

function legacyCustomModel(
    selectedModels: unknown,
    customModels: unknown,
): string {
    return resolveConfiguredModel(
        configuredString(selectedModels, LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        configuredString(customModels, LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
    ).trim();
}

function getConfiguredApiKey(mapping: unknown, service: string): string {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return '';
    const values = (mapping as Record<string, unknown>)[service];
    return Array.isArray(values)
        ? values.find((value): value is string => typeof value === 'string' && Boolean(value.trim())) || ''
        : '';
}

/** 默认 Config 本来就含 custom 地址和默认模型；只有真实修改或引用才创建旧 profile。 */
function hasSubstantialLegacyCustomConfiguration(source: Partial<Config>): boolean {
    const sourceRecord = source as unknown as Record<string, unknown>;
    const referenced = source.service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.hoverTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.selectionTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.imageTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.documentService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.videoService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || source.areaTranslationService === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
        || (Array.isArray(source.translationCenterServices)
            && source.translationCenterServices.includes(LEGACY_CUSTOM_OPENAI_PROVIDER_ID));
    if (referenced) return true;

    const endpoint = typeof source.custom === 'string' ? source.custom.trim() : '';
    if (endpoint && endpoint !== defaultOption.custom) return true;

    const defaultModel = defaultModels.get(LEGACY_CUSTOM_OPENAI_PROVIDER_ID)!;
    const selectedModel = configuredString(source.model, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    const documentModel = configuredString(source.documentModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    if ((selectedModel && selectedModel !== defaultModel)
        || (documentModel && documentModel !== defaultModel)
        || configuredString(source.customModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.documentCustomModel, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)) return true;

    if (configuredString(source.token, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || getConfiguredApiKey(source.apiKeys, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.proxy, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.customBody, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)
        || configuredString(source.customHeaders, LEGACY_CUSTOM_OPENAI_PROVIDER_ID)) return true;
    const systemRole = configuredString(source.system_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    const userRole = configuredString(source.user_role, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    // 仍停留在历史默认提示词的旧配置不算用户改写；否则升级默认提示词会凭空
    // 判定旧自定义 OpenAI 档案存在真实配置。
    if ((systemRole && systemRole !== defaultOption.system_role)
        || (userRole && userRole !== defaultOption.user_role
            && !LEGACY_DEFAULT_USER_ROLES.includes(userRole))) return true;

    const requirementModel = legacyCustomModel(source.model, source.customModel);
    const requirementKey = createApiKeyRequirementKey(LEGACY_CUSTOM_OPENAI_PROVIDER_ID, requirementModel);
    const legacyRequirementKey = getLegacyApiKeyRequirementKey(
        LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
        requirementModel,
    );
    return isBooleanMapping(source.requireApiKey)
        && requirementModel !== ''
        && (hasOwn(sourceRecord.requireApiKey as object, requirementKey)
            || hasOwn(sourceRecord.requireApiKey as object, legacyRequirementKey));
}

function protectProviderModels(
    provider: CustomOpenAIProvider,
    modelsToProtect: readonly string[],
): CustomOpenAIProvider {
    const protectedModels = Array.from(new Set(modelsToProtect.map(model => model.trim()).filter(Boolean)));
    if (protectedModels.length === 0) return provider;
    const protectedSet = new Set(protectedModels);
    const existingModels = new Set(provider.models);
    const missingModels = protectedModels.filter(model => !existingModels.has(model));
    if (missingModels.length === 0) return provider;

    const combined = [...provider.models, ...missingModels];
    let removeCount = Math.max(0, combined.length - MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
    const removedIndexes = new Set<number>();
    for (let index = provider.models.length - 1; index >= 0 && removeCount > 0; index -= 1) {
        if (protectedSet.has(provider.models[index])) continue;
        removedIndexes.add(index);
        removeCount -= 1;
    }
    const nextModels = combined.filter((_, index) => !removedIndexes.has(index));
    return {...provider, models: nextModels};
}

function withoutOrphanCustomProviderEntries<T>(
    mapping: Record<string, T>,
    configuredIds: ReadonlySet<string>,
): Record<string, T> {
    return Object.fromEntries(Object.entries(mapping).filter(([service]) => (
        !isCustomOpenAIProviderId(service) || configuredIds.has(service)
    )));
}

export function normalizeCustomOpenAIProviderState(normalized: Config, source: Partial<Config>): void {
    let providers = normalizeCustomOpenAIProviders(source.customOpenAIProviders);
    const legacyProvider = getCustomOpenAIProvider(providers, LEGACY_CUSTOM_OPENAI_PROVIDER_ID);
    if (!legacyProvider
        && !Array.isArray(source.customOpenAIProviders)
        && hasSubstantialLegacyCustomConfiguration(source)) {
        const pageModel = legacyCustomModel(normalized.model, normalized.customModel)
            || defaultModels.get(LEGACY_CUSTOM_OPENAI_PROVIDER_ID)!;
        const documentModel = legacyCustomModel(normalized.documentModel, normalized.documentCustomModel)
            || pageModel;
        providers = normalizeCustomOpenAIProviders([...providers, {
            id: LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
            name: '自定义接口',
            endpoint: typeof source.custom === 'string' ? source.custom : defaultOption.custom,
            models: [pageModel, documentModel],
        }]);
    } else if (legacyProvider && !legacyProvider.endpoint && typeof source.custom === 'string') {
        const legacyEndpoint = source.custom;
        providers = providers.map((provider) => provider.id === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
            ? {...provider, endpoint: legacyEndpoint}
            : provider);
    }

    const configuredIds = new Set(providers.map((provider) => provider.id));
    normalized.token = withoutOrphanCustomProviderEntries(normalized.token, configuredIds);
    normalized.model = withoutOrphanCustomProviderEntries(normalized.model, configuredIds);
    normalized.documentModel = withoutOrphanCustomProviderEntries(normalized.documentModel, configuredIds);
    normalized.customModel = withoutOrphanCustomProviderEntries(normalized.customModel, configuredIds);
    normalized.documentCustomModel = withoutOrphanCustomProviderEntries(normalized.documentCustomModel, configuredIds);
    normalized.proxy = withoutOrphanCustomProviderEntries(normalized.proxy, configuredIds);
    normalized.system_role = withoutOrphanCustomProviderEntries(normalized.system_role, configuredIds);
    normalized.user_role = withoutOrphanCustomProviderEntries(normalized.user_role, configuredIds);
    normalized.customBody = withoutOrphanCustomProviderEntries(normalized.customBody, configuredIds);
    normalized.customHeaders = withoutOrphanCustomProviderEntries(normalized.customHeaders, configuredIds);
    if (import.meta.env?.BROWSER !== 'userscript') {
        const dictionaryHeaderIds = new Set(normalizeDictionaryWorkspace(source.selectionDictionaryWorkspace).recipes.map(recipe => `dictionary:${recipe.id}`));
        normalized.customHeaders = Object.fromEntries(Object.entries(normalized.customHeaders)
            .filter(([service]) => !service.startsWith('dictionary:') || dictionaryHeaderIds.has(service)));
    }
    normalized.apiKeys = withoutOrphanCustomProviderEntries(normalized.apiKeys, configuredIds);
    normalized.serviceRequestLimits = Object.fromEntries(Object.entries(normalized.serviceRequestLimits)
        .filter(([service]) => !isCustomOpenAIProviderId(service) || configuredIds.has(service)));
    normalized.modelRequestLimits = Object.fromEntries(Object.entries(normalized.modelRequestLimits)
        .filter(([service]) => !isCustomOpenAIProviderId(service) || configuredIds.has(service)));

    // 每项直接保护自己的模型，避免为 P 个服务重复扫描完整目录（P²）。
    providers = providers.map((provider) => {
        const service = provider.id;
        const savedPageCustomModel = configuredString(normalized.customModel, service);
        const savedDocumentCustomModel = configuredString(normalized.documentCustomModel, service);
        const resolvedPageModel = resolveConfiguredModel(
            normalized.model[service],
            normalized.customModel[service],
        ).trim();
        const pageModel = resolvedPageModel || provider.models[0] || '';
        const resolvedDocumentModel = resolveConfiguredModel(
            normalized.documentModel[service],
            normalized.documentCustomModel[service],
        ).trim();
        const documentModel = resolvedDocumentModel || pageModel;
        if (pageModel) normalized.model[service] = pageModel;
        else delete normalized.model[service];
        if (documentModel) normalized.documentModel[service] = documentModel;
        else delete normalized.documentModel[service];
        delete normalized.customModel[service];
        delete normalized.documentCustomModel[service];
        if (!normalized.system_role[service]) normalized.system_role[service] = defaultOption.system_role;
        if (!normalized.user_role[service]) normalized.user_role[service] = defaultOption.user_role;
        return protectProviderModels(provider, [
            pageModel,
            documentModel,
            savedPageCustomModel,
            savedDocumentCustomModel,
        ]);
    });

    const validRequirementKeys = new Set<string>();
    for (const provider of providers) {
        const providerModels = new Set([
            ...provider.models,
            normalized.model[provider.id],
            normalized.documentModel[provider.id],
        ].filter((model): model is string => Boolean(model)));
        providerModels.forEach((model) => {
            const key = createApiKeyRequirementKey(provider.id, model);
            const legacyKey = getLegacyApiKeyRequirementKey(provider.id, model);
            validRequirementKeys.add(key);
            validRequirementKeys.add(legacyKey);
            if (provider.id === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
                && hasOwn(normalized.requireApiKey, legacyKey)
                && !hasOwn(normalized.requireApiKey, key)) {
                normalized.requireApiKey[key] = normalized.requireApiKey[legacyKey];
            }
        });
    }
    normalized.requireApiKey = Object.fromEntries(Object.entries(normalized.requireApiKey).filter(([key]) => {
        if (key.startsWith(API_KEY_REQUIREMENT_KEY_PREFIX)) {
            const parts = parseApiKeyRequirementKey(key);
            if (!parts) return false;
            return !isCustomOpenAIProviderId(parts[0]) || validRequirementKeys.has(key);
        }
        return !key.startsWith(`${LEGACY_CUSTOM_OPENAI_PROVIDER_ID}:`) || validRequirementKeys.has(key);
    }));
    normalized.customOpenAIProviders = normalizeCustomOpenAIProviders(providers);
    normalized.apiKeyRotationEnabled = withoutOrphanCustomProviderEntries(
        normalized.apiKeyRotationEnabled,
        new Set(providers.map((provider) => provider.id)),
    );
    normalized.token = apiKeysToToken(normalized.apiKeys);
}

/** 判定旧配置中目标平台是否已经被实际选用或单独配置。 */
export function hasConfiguredAiPlatformService(source: Partial<Config>, service: string): boolean {
    const raw = source as Record<string, unknown>;
    const selectedFields = [
        'service', 'hoverTranslationService', 'selectionTranslationService',
        'imageTranslationService', 'documentService', 'videoService',
        'areaTranslationService', 'inputBoxTranslationService',
    ];
    if (selectedFields.some(field => raw[field] === service)) return true;

    for (const field of ['harness', 'writing'] as const) {
        const preferences = raw[field];
        if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)
            && (preferences as Record<string, unknown>).service === service) return true;
    }

    for (const field of ['favoriteServices', 'translationCenterServices'] as const) {
        const selected = raw[field];
        if (Array.isArray(selected) && selected.includes(service)) return true;
    }
    const quickProfiles = raw.quickTranslationProfiles;
    if (Array.isArray(quickProfiles) && quickProfiles.some(profile => (
        profile !== null && typeof profile === 'object' && !Array.isArray(profile)
        && (profile as Record<string, unknown>).service === service
    ))) return true;
    const composites = raw.compositeTranslationProviders;
    if (Array.isArray(composites) && composites.some(provider => (
        provider !== null && typeof provider === 'object' && !Array.isArray(provider)
        && Array.isArray((provider as Record<string, unknown>).services)
        && ((provider as Record<string, unknown>).services as unknown[]).includes(service)
    ))) return true;

    const mappings = raw as Record<string, unknown>;
    for (const field of ['token', 'secret', 'proxy', 'customModel', 'customBody', 'customHeaders', 'serviceRegion'] as const) {
        const mapping = mappings[field];
        const value = mapping && typeof mapping === 'object' && !Array.isArray(mapping)
            ? (mapping as Record<string, unknown>)[service]
            : undefined;
        if (typeof value === 'string' && value.trim()) return true;
    }

    const apiKeys = mappings.apiKeys && typeof mappings.apiKeys === 'object' && !Array.isArray(mappings.apiKeys)
        ? (mappings.apiKeys as Record<string, unknown>)[service]
        : undefined;
    if (Array.isArray(apiKeys) && apiKeys.some(key => typeof key === 'string' && key.trim())) return true;

    const customModels = mappings.customModels && typeof mappings.customModels === 'object' && !Array.isArray(mappings.customModels)
        ? (mappings.customModels as Record<string, unknown>)[service]
        : undefined;
    if (Array.isArray(customModels) && customModels.some(model => typeof model === 'string' && model.trim())) return true;

    const selectedModel = mappings.model && typeof mappings.model === 'object' && !Array.isArray(mappings.model)
        ? (mappings.model as Record<string, unknown>)[service]
        : undefined;
    if (typeof selectedModel === 'string' && selectedModel.trim()
        && selectedModel !== (defaultModelIds as Record<string, unknown>)[service]) return true;

    for (const field of ['modelThinking', 'serviceRequestLimits', 'modelRequestLimits', 'modelVision'] as const) {
        const mapping = mappings[field];
        const value = mapping && typeof mapping === 'object' && !Array.isArray(mapping)
            ? (mapping as Record<string, unknown>)[service]
            : undefined;
        if (value && typeof value === 'object' && Object.keys(value).length > 0) return true;
    }
    const rotation = mappings.apiKeyRotationEnabled && typeof mappings.apiKeyRotationEnabled === 'object'
        && !Array.isArray(mappings.apiKeyRotationEnabled)
        ? (mappings.apiKeyRotationEnabled as Record<string, unknown>)[service]
        : undefined;
    if (rotation === true) return true;

    const systemRole = mappings.system_role && typeof mappings.system_role === 'object' && !Array.isArray(mappings.system_role)
        ? (mappings.system_role as Record<string, unknown>)[service]
        : undefined;
    const userRole = mappings.user_role && typeof mappings.user_role === 'object' && !Array.isArray(mappings.user_role)
        ? (mappings.user_role as Record<string, unknown>)[service]
        : undefined;
    return (typeof systemRole === 'string' && systemRole !== defaultOption.system_role)
        || (typeof userRole === 'string' && userRole !== defaultOption.user_role
            && !LEGACY_DEFAULT_USER_ROLES.includes(userRole));
}

function migrateModelThinkingIdentifiers(normalized: Config): ModelThinkingMapping {
    const migrated: Array<[string, Record<string, boolean>]> = [];
    for (const [service, modelStates] of Object.entries(normalized.modelThinking)) {
        const customModels = new Set(hasOwn(normalized.customModels, service) ? normalized.customModels[service] : []);
        const currentId = (model: string) => {
            if (customModels.has(model)) return model;
            if (service === services.deepseek
                && (model === 'deepseek-chat' || model === 'deepseek-reasoner')) {
                return currentModelIds.deepseek;
            }
            return migrateModelIdentifier(service, model);
        };
        const currentEntries = Object.entries(modelStates)
            .filter(([model]) => currentId(model) === model);
        const legacyEntries = Object.entries(modelStates)
            .filter(([model]) => currentId(model) !== model);
        const migratedModels = new Map<string, boolean>();
        for (const [model, enabled] of [...currentEntries, ...legacyEntries]) {
            const currentModel = currentId(model);
            if (!migratedModels.has(currentModel)) migratedModels.set(currentModel, enabled);
        }
        migrated.push([service, Object.fromEntries(migratedModels)]);
    }
    return Object.fromEntries(migrated);
}

function resolvedConfiguredModels(normalized: Config, service: string): string[] {
    return [
        resolveConfiguredModel(normalized.model[service], normalized.customModel[service]),
        resolveConfiguredModel(normalized.documentModel[service], normalized.documentCustomModel[service]),
    ].map((model) => model.trim()).filter(Boolean);
}

function modelsForService(service: string): string[] {
    // catalog contract（由 serviceCatalog.test.ts 覆盖）：每个 useModel 服务都有模型列表。
    return models.get(service)!.filter((model) => model !== CUSTOM_OPENAI_RESERVED_MODEL_ID);
}

function isPersistableBuiltInModelService(service: string): boolean {
    return !isCustomOpenAIProviderId(service)
        && service !== services.chatgptPlan
        && servicesType.AI.has(service)
        && servicesType.isUseModel(service);
}

function validThinkingModels(normalized: Config, service: string, provider?: CustomOpenAIProvider): Set<string> {
    if (provider) return new Set([...provider.models, ...resolvedConfiguredModels(normalized, service)]);
    // 套餐没有静态目录；保留已选择模型的旧偏好，不把配置规范化当作账户能力判断。
    if (service === services.chatgptPlan) return new Set(resolvedConfiguredModels(normalized, service));
    if (!isPersistableBuiltInModelService(service)) return new Set();
    return new Set([
        ...modelsForService(service),
        ...(normalized.customModels[service] || []),
        ...resolvedConfiguredModels(normalized, service),
    ]);
}

export function normalizeModelThinkingState(normalized: Config, hasSavedSchema: boolean): void {
    const mapping = migrateModelThinkingIdentifiers(normalized);
    if (!hasSavedSchema) {
        const legacyEnabled = normalized.deepseekThinkingMode === 'enabled';
        for (const model of resolvedConfiguredModels(normalized, services.deepseek)) {
            (mapping[services.deepseek] ||= {})[model] = legacyEnabled;
        }
    }

    // 自定义服务数量不设上限；一次索引后按 ID 查找，避免逐服务 find 的 P² 成本。
    const providersById = new Map(normalized.customOpenAIProviders.map(provider => [provider.id, provider]));
    const pruned: ModelThinkingMapping = {};
    for (const [service, modelStates] of Object.entries(mapping)) {
        const validModels = validThinkingModels(normalized, service, providersById.get(service));
        const validEntries = Object.entries(modelStates).filter(([model]) => validModels.has(model));
        if (validEntries.length > 0) pruned[service] = Object.fromEntries(validEntries);
    }
    normalized.modelThinking = pruned;
}

/**
 * 旧默认提示词允许模型“在不必要时返回原文”，较弱的模型据此整句保留源语言，
 * 造成译文中夹杂明显应当翻译的英文（Issue #54）。仅把仍停留在历史默认值的条目
 * 升级为当前默认提示词，用户自定义的提示词按原样保留。
 */
export function upgradeLegacyDefaultUserRoles(mapping: IMapping): IMapping {
    const upgraded: IMapping = {};
    for (const [service, prompt] of Object.entries(mapping)) {
        upgraded[service] = LEGACY_DEFAULT_USER_ROLES.includes(prompt)
            ? defaultOption.user_role
            : prompt;
    }
    return upgraded;
}

/**
 * 地域会同时决定签名 scope 与请求域名，因此只保留白名单内的取值：
 * 导入配置里的未知地域回落到该服务的默认地域，不需要地域的服务直接丢弃。
 */
export function normalizeCloudRegionMapping(value: unknown): IMapping {
    return Object.fromEntries(
        Object.entries(normalizeStringMapping(value))
            .filter(([service]) => servicesType.isUseRegion(service))
            .map(([service, region]) => [service, resolveCloudRegion(service, region)]),
    );
}

export function normalizeCustomModelMapping(value: unknown): Record<string, string[]> {
    if (!isRecord(value)) return {};
    const normalized: Record<string, string[]> = {};
    for (const [service, savedModels] of Object.entries(value)) {
        if (!isPersistableBuiltInModelService(service)) continue;
        const builtInModels = new Set(modelsForService(service));
        const list = normalizeCustomOpenAIModels(savedModels, builtInModels);
        if (list.length > 0) normalized[service] = list;
    }
    return normalized;
}

/** 账户发现模型不使用静态目录或自定义入口；旧哨兵精确还原后统一保存实际 slug。 */
export function normalizeChatGPTPlanModelState(normalized: Config): void {
    for (const [selected, custom] of [[normalized.model, normalized.customModel], [normalized.documentModel, normalized.documentCustomModel]]) {
        const slug = resolveConfiguredModel(selected[services.chatgptPlan], custom[services.chatgptPlan]).trim();
        if (slug) selected[services.chatgptPlan] = slug;
        else delete selected[services.chatgptPlan];
        delete custom[services.chatgptPlan];
    }
    delete normalized.customModels[services.chatgptPlan];
}

function activeSavedCustomModel(selectedModel: string, customModel: string): string {
    // direct ID 已由 canonicalizeDirectCustomModel 在调用前收敛为 sentinel。
    if (selectedModel === CUSTOM_OPENAI_RESERVED_MODEL_ID) return customModel;
    return '';
}

function canonicalizeDirectCustomModel(service: string, selected: IMapping, custom: IMapping): void {
    const selectedModel = selected[service];
    if (!selectedModel
        || selectedModel === CUSTOM_OPENAI_RESERVED_MODEL_ID
        || modelsForService(service).includes(selectedModel)) return;
    selected[service] = CUSTOM_OPENAI_RESERVED_MODEL_ID;
    custom[service] = selectedModel;
}

function protectSavedCustomModels(
    mapping: Record<string, string[]>,
    service: string,
    values: readonly string[],
): void {
    const builtInModels = new Set(modelsForService(service));
    const protectedModels = normalizeCustomOpenAIModels(values).filter((model) => !builtInModels.has(model));
    if (protectedModels.length === 0) return;
    const protectedSet = new Set(protectedModels);
    const savedModels = [...(mapping[service] || [])];
    protectedModels.forEach((model) => {
        if (!savedModels.includes(model)) savedModels.push(model);
    });
    while (savedModels.length > MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER) {
        let removableIndex = savedModels.length - 1;
        while (removableIndex >= 0 && protectedSet.has(savedModels[removableIndex])) removableIndex -= 1;
        // protectedModels 本身最多 50 个，因此溢出时一定还存在一个非保护项。
        savedModels.splice(removableIndex, 1);
    }
    mapping[service] = savedModels.slice(0, MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
}

export function normalizeSavedCustomModelState(normalized: Config, hasSavedSchema: boolean): void {
    const configuredServices = new Set([
        ...Object.keys(normalized.customModels),
        ...Object.keys(normalized.customModel),
        ...Object.keys(normalized.documentCustomModel),
        ...Object.keys(normalized.model),
        ...Object.keys(normalized.documentModel),
    ]);
    for (const service of configuredServices) {
        if (!isPersistableBuiltInModelService(service)) continue;
        canonicalizeDirectCustomModel(service, normalized.model, normalized.customModel);
        canonicalizeDirectCustomModel(service, normalized.documentModel, normalized.documentCustomModel);
        const activeModels = [
            activeSavedCustomModel(normalized.model[service], normalized.customModel[service]),
            activeSavedCustomModel(
                normalized.documentModel[service],
                normalized.documentCustomModel[service],
            ),
        ];
        protectSavedCustomModels(normalized.customModels, service, hasSavedSchema
            ? activeModels
            : [normalized.customModel[service], normalized.documentCustomModel[service], ...activeModels]);
    }
}

export function withoutRetiredServiceEntries<T>(mapping: Record<string, T>): Record<string, T> {
    return Object.fromEntries(
        Object.entries(mapping).filter(([service]) => !retiredServiceIds.has(service)),
    );
}

export function withoutRetiredRequirementEntries(mapping: Record<string, boolean>): Record<string, boolean> {
    return Object.fromEntries(
        Object.entries(mapping).filter(([key]) => !Array.from(retiredServiceIds).some(
            service => key === service || key.startsWith(`${service}:`),
        )),
    );
}

export function isSupportedTranslationService(
    value: unknown,
    customProviders: readonly CustomOpenAIProvider[],
    compositeProviders: readonly CompositeTranslationProvider[] = [],
): value is string {
    if (typeof value !== 'string') return false;
    if (isCompositeTranslationProviderId(value)) {
        return isConfiguredCompositeTranslationProvider(compositeProviders, value);
    }
    if (isCustomOpenAIProviderId(value)) {
        return isConfiguredCustomOpenAIProvider(customProviders, value);
    }
    return servicesType.machine.has(value) || servicesType.AI.has(value);
}
