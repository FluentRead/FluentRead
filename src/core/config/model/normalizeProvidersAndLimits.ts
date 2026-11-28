/**
 * @file src/core/config/model/normalizeProvidersAndLimits.ts
 *
 * 文件职责：规范化翻译服务目录、请求限流与缓存配额、免费翻译池、多 API Key 与轮换、自定义与组合服务及模型标识迁移等核心供应商配置。
 * 主要内容：提供 normalizeProvidersAndLimitsConfig，完成缓存上下限、并发与 QPS/RPM 限流、免费池升级迁移、凭据映射清洗、默认提示词升级、模型补全以及 DeepSeek/MiniMax/MiMo 套餐参数归一。
 * 模块边界：仅由 normalizeConfig.ts 编排调用的纯配置字段转换模块，不直接读写浏览器存储，也不发起网络请求或依赖 UI 层。
 */

import {normalizeAiRequestTimeoutMs} from '../aiRequestTimeout';
import {apiKeysToToken, normalizeApiKeys} from '../apiKeys';
import {currentModelIds, defaultModels} from '../catalog/models';
import {options} from '../catalog/options';
import {defaultOption} from '../catalog/prompts';
import {services} from '../catalog/services';
import {normalizeCompositeTranslationProviders} from '../compositeTranslation';
import {normalizeCustomBodyMapping} from '../customBody';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId} from '../customOpenAI';
import {normalizeDeepLApiPlan} from '../deepl';
import {
    normalizeFreeTranslationCooldownMs,
    normalizeFreeTranslationMode,
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
    normalizeMyMemoryEmail,
} from '../freeTranslation';
import {normalizeHarnessPreferences} from '../harness';
import {normalizeModelThinkingMapping} from '../modelThinking';
import {normalizeRequestHeaderRules} from '../requestHeaders';
import {normalizeModelRequestLimits, normalizeServiceRequestLimits} from '../requestLimits';
import {
    normalizeApiKeyRecoveryMs,
    normalizeMaxConcurrentTranslations,
    normalizeTranslationBackoffBaseMs,
    normalizeTranslationBackoffMaxMs,
    normalizeTranslationMaxRetries,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from '../scheduling';
import {DEFAULT_DISABLED_AI_PLATFORM_SERVICES, normalizeDisabledTranslationServices} from '../serviceAvailability';
import {normalizeTranslationCacheLimits} from '../translationCache';
import {normalizeAreaVisionPrompt, normalizeModelVisionOverrides} from '../vision';
import {normalizeWritingPreferences} from '../writing';
import {hasOwn, isBooleanMapping, normalizeStringMapping} from './clone';
import {type Config, systemRoleFactory, userRoleFactory} from './configClass';
import {DEFAULT_NEW_API_URL} from './interactionDefaults';
import {migrateModelIdentifiers} from './modelMigration';
import {
    hasConfiguredAiPlatformService,
    isSupportedTranslationService,
    normalizeChatGPTPlanModelState,
    normalizeCloudRegionMapping,
    normalizeCustomModelMapping,
    normalizeCustomOpenAIProviderState,
    normalizeModelThinkingState,
    normalizeSavedCustomModelState,
    upgradeLegacyDefaultUserRoles,
    withoutRetiredRequirementEntries,
    withoutRetiredServiceEntries,
} from './providerNormalization';

function normalizeLimitsAndFreePool(normalized: Config, source: Partial<Config>): void {
    const cacheLimits = normalizeTranslationCacheLimits({
        maxBytes: source.translationCacheMaxBytes,
        maxEntries: source.translationCacheMaxEntries,
    });
    normalized.translationCacheMaxBytes = cacheLimits.maxBytes;
    normalized.translationCacheMaxEntries = cacheLimits.maxEntries;
    normalized.maxConcurrentTranslations = normalizeMaxConcurrentTranslations(source.maxConcurrentTranslations);
    normalized.aiRequestTimeoutMs = normalizeAiRequestTimeoutMs(source.aiRequestTimeoutMs);
    normalized.translationRequestsPerSecond = normalizeTranslationRequestsPerSecond(source.translationRequestsPerSecond);
    normalized.translationRequestsPerMinute = normalizeTranslationRequestsPerMinute(source.translationRequestsPerMinute);
    normalized.serviceRequestLimits = withoutRetiredServiceEntries(normalizeServiceRequestLimits(source.serviceRequestLimits));
    normalized.modelRequestLimits = withoutRetiredServiceEntries(normalizeModelRequestLimits(source.modelRequestLimits));
    normalized.apiKeyRecoveryMs = normalizeApiKeyRecoveryMs(source.apiKeyRecoveryMs);
    normalized.freeTranslationOrder = normalizeFreeTranslationOrder(source.freeTranslationOrder);
    normalized.disabledTranslationServices = normalizeDisabledTranslationServices(source.disabledTranslationServices);
    if (source.aiPlatformDefaultRemovalMigrated !== true) {
        const disabledServices = new Set(normalized.disabledTranslationServices);
        for (const service of DEFAULT_DISABLED_AI_PLATFORM_SERVICES) {
            if (!hasConfiguredAiPlatformService(source, service)) disabledServices.add(service);
        }
        normalized.disabledTranslationServices = [...disabledServices];
    }
    normalized.aiPlatformDefaultRemovalMigrated = true;
    // 旧配置首次升级默认开启 B站；标记写入后尊重用户后续的手动关闭。
    if (source.freeTranslationBilibiliDefaultApplied !== true) {
        const order = normalized.freeTranslationOrder.filter(id => id !== 'bilibiliFree');
        const microsoftIndex = order.indexOf('microsoft');
        order.splice(microsoftIndex < 0 ? 0 : microsoftIndex + 1, 0, 'bilibiliFree');
        normalized.freeTranslationOrder = order;
    }
    normalized.freeTranslationBilibiliDefaultApplied = true;
    normalized.freeTranslationMode = normalizeFreeTranslationMode(source.freeTranslationMode);
    // 权重归后台管理，不接受导入文件或旧配置中的人工权重。
    delete (normalized as Config & {freeTranslationWeights?: unknown}).freeTranslationWeights;
    normalized.freeTranslationTimeoutMs = normalizeFreeTranslationTimeoutMs(source.freeTranslationTimeoutMs);
    normalized.freeTranslationCooldownMs = normalizeFreeTranslationCooldownMs(source.freeTranslationCooldownMs);
    normalized.myMemoryEmail = normalizeMyMemoryEmail(source.myMemoryEmail);
    normalized.translationMaxRetries = normalizeTranslationMaxRetries(source.translationMaxRetries);
    normalized.translationBackoffBaseMs = normalizeTranslationBackoffBaseMs(source.translationBackoffBaseMs);
    normalized.translationBackoffMaxMs = Math.max(
        normalized.translationBackoffBaseMs,
        normalizeTranslationBackoffMaxMs(source.translationBackoffMaxMs),
    );
}

function normalizeCredentialsAndRoles(normalized: Config, source: Partial<Config>): {
    hasSavedCustomModelSchema: boolean;
    hasModelThinkingSchema: boolean;
} {
    normalized.apiKeys = withoutRetiredServiceEntries(normalizeApiKeys(source.apiKeys));
    const legacyToken = withoutRetiredServiceEntries(normalizeStringMapping(source.token));
    // apiKeys 是新字段的完整数据源；空的旧 token 镜像不能清空已保存的行。
    for (const [service, token] of Object.entries(legacyToken)) {
        if (!Object.prototype.hasOwnProperty.call(normalized.apiKeys, service)) {
            Object.defineProperty(normalized.apiKeys, service, {
                value: token ? [token] : [], enumerable: true, writable: true, configurable: true,
            });
        }
    }
    normalized.apiKeyRotationEnabled = isBooleanMapping(source.apiKeyRotationEnabled)
        ? withoutRetiredServiceEntries({...source.apiKeyRotationEnabled})
        : {};
    // 兼容已有多 Key 配置；新建配置仍默认关闭多 Key 轮询。
    for (const [service, keys] of Object.entries(normalized.apiKeys)) {
        if (keys.filter(Boolean).length > 1
            && !Object.prototype.hasOwnProperty.call(normalized.apiKeyRotationEnabled, service)) {
            Object.defineProperty(normalized.apiKeyRotationEnabled, service, {
                value: true, enumerable: true, writable: true, configurable: true,
            });
        }
    }
    normalized.token = apiKeysToToken(normalized.apiKeys);
    normalized.secret = withoutRetiredServiceEntries(normalizeStringMapping(source.secret));
    normalized.serviceRegion = normalizeCloudRegionMapping(source.serviceRegion);
    normalized.model = withoutRetiredServiceEntries(normalizeStringMapping(source.model));
    normalized.documentModel = withoutRetiredServiceEntries(normalizeStringMapping(source.documentModel));
    normalized.requireApiKey = isBooleanMapping(source.requireApiKey)
        ? withoutRetiredRequirementEntries({...source.requireApiKey})
        : {};
    normalized.customModel = withoutRetiredServiceEntries(normalizeStringMapping(source.customModel));
    normalized.documentCustomModel = withoutRetiredServiceEntries(normalizeStringMapping(source.documentCustomModel));
    const hasSavedCustomModelSchema = hasOwn(source as object, 'customModels');
    normalized.customModels = normalizeCustomModelMapping(source.customModels);
    const hasModelThinkingSchema = hasOwn(source as object, 'modelThinking');
    normalized.modelThinking = normalizeModelThinkingMapping(source.modelThinking);
    normalized.proxy = withoutRetiredServiceEntries(normalizeStringMapping(source.proxy));
    normalized.system_role = {
        ...systemRoleFactory(),
        ...withoutRetiredServiceEntries(normalizeStringMapping(source.system_role)),
    };
    normalized.user_role = upgradeLegacyDefaultUserRoles({
        ...userRoleFactory(),
        ...withoutRetiredServiceEntries(normalizeStringMapping(source.user_role)),
    });
    normalized.customBody = withoutRetiredServiceEntries(normalizeCustomBodyMapping(source.customBody));
    normalized.customHeaders = normalizeStringMapping(source.customHeaders);
    normalized.requestHeaderRules = normalizeRequestHeaderRules(source.requestHeaderRules);
    return {hasSavedCustomModelSchema, hasModelThinkingSchema};
}

function normalizeServiceSelections(normalized: Config, source: Partial<Config>): void {
    if (typeof normalized.custom !== 'string') normalized.custom = defaultOption.custom;
    normalized.deeplApiPlan = normalizeDeepLApiPlan(source.deeplApiPlan);
    if (typeof normalized.newApiUrl !== 'string') normalized.newApiUrl = DEFAULT_NEW_API_URL;
    normalizeCustomOpenAIProviderState(normalized, source);
    normalized.compositeTranslationProviders = normalizeCompositeTranslationProviders(
        source.compositeTranslationProviders,
        normalized.customOpenAIProviders,
    );
    normalized.favoriteServices = Array.isArray(source.favoriteServices)
        ? [...new Set(source.favoriteServices.filter(service =>
            typeof service === 'string' && isSupportedTranslationService(
                service,
                normalized.customOpenAIProviders,
                normalized.compositeTranslationProviders,
            )))].slice(0, 100)
        : [];
    normalized.writing = normalizeWritingPreferences(source.writing, normalized.customOpenAIProviders);
    normalized.harness = normalizeHarnessPreferences(source.harness, normalized.customOpenAIProviders);

    if (!isSupportedTranslationService(normalized.service, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)) {
        normalized.service = defaultOption.service;
    }
    const disabledServices = new Set(normalized.disabledTranslationServices);
    if (disabledServices.has(normalized.service)) {
        const fallback = options.services.find(item => item.value !== 'machine' && item.value !== 'ai' && !item.disabled && !disabledServices.has(item.value))?.value
            || normalized.customOpenAIProviders.find(provider => !disabledServices.has(provider.id))?.id
            || normalized.compositeTranslationProviders.find(provider => !disabledServices.has(provider.id))?.id;
        if (fallback) normalized.service = fallback;
        else normalized.disabledTranslationServices = normalized.disabledTranslationServices.filter(service => service !== normalized.service);
    }

    if (!isSupportedTranslationService(normalized.documentService, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)) {
        normalized.documentService = '';
    }

    for (const field of ['hoverTranslationService', 'selectionTranslationService', 'imageTranslationService'] as const) {
        normalized[field] = isSupportedTranslationService(source[field], normalized.customOpenAIProviders, normalized.compositeTranslationProviders)
            ? source[field]
            : '';
    }

    normalized.areaTranslationMode = source.areaTranslationMode === 'ai' ? 'ai' : 'standard';
    normalized.areaTranslationService = isSupportedTranslationService(source.areaTranslationService, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)
        ? source.areaTranslationService
        : '';
    normalized.areaRecognitionMode = source.areaRecognitionMode === 'ocr' ? 'ocr' : 'prefer-vision';
    normalized.areaVisionPrompt = normalizeAreaVisionPrompt(source.areaVisionPrompt);
    normalized.modelVision = normalizeModelVisionOverrides(source.modelVision);
}

function normalizeModelCatalogAndBilling(
    normalized: Config,
    source: Partial<Config>,
    hasSavedCustomModelSchema: boolean,
    hasModelThinkingSchema: boolean,
): void {
    migrateModelIdentifiers(normalized.model);
    migrateModelIdentifiers(normalized.documentModel);

    // 旧配置可能没有保存过模型选择；为所有 AI 服务补齐各自的默认模型。
    defaultModels.forEach((defaultModel, service) => {
        if (isCustomOpenAIProviderId(service)
            && !isConfiguredCustomOpenAIProvider(normalized.customOpenAIProviders, service)) return;
        if (!normalized.model[service]) normalized.model[service] = defaultModel;
        if (!normalized.documentModel[service]) normalized.documentModel[service] = defaultModel;
    });

    const selectedModel = normalized.model[services.deepseek];
    const configuredThinkingMode = source.deepseekThinkingMode;

    if (selectedModel === 'deepseek-chat') {
        normalized.model[services.deepseek] = currentModelIds.deepseek;
        normalized.deepseekThinkingMode = 'disabled';
    } else if (selectedModel === 'deepseek-reasoner') {
        // 旧 reasoner 使用当前 Flash 模型，并显式保留 thinking 开启状态。
        normalized.model[services.deepseek] = currentModelIds.deepseek;
        normalized.deepseekThinkingMode = 'enabled';
    } else if (configuredThinkingMode !== 'enabled' && configuredThinkingMode !== 'disabled') {
        // 兼容 #219 的早期配置：该实现把 v4-pro 作为默认思考模型。
        normalized.deepseekThinkingMode = selectedModel === 'deepseek-v4-pro' ? 'enabled' : 'disabled';
    }
    normalizeChatGPTPlanModelState(normalized);
    normalizeSavedCustomModelState(normalized, hasSavedCustomModelSchema);
    normalizeModelThinkingState(normalized, hasModelThinkingSchema);

    if (!['auto', 'responses', 'chat'].includes(normalized.deepseekApiType)) {
        normalized.deepseekApiType = 'auto';
    }
    if (!['payg', 'token-plan'].includes(normalized.minimaxBillingPlan)) {
        normalized.minimaxBillingPlan = 'payg';
    }
    if (!['global', 'cn'].includes(normalized.minimaxRegion)) {
        normalized.minimaxRegion = 'cn';
    }
    if (!['payg', 'token-plan'].includes(normalized.mimoBillingPlan)) {
        normalized.mimoBillingPlan = 'payg';
    }
    if (!['cn', 'sgp', 'ams'].includes(normalized.mimoRegion)) {
        normalized.mimoRegion = 'cn';
    }
}

export function normalizeProvidersAndLimitsConfig(normalized: Config, source: Partial<Config>): void {
    normalizeLimitsAndFreePool(normalized, source);
    const {hasSavedCustomModelSchema, hasModelThinkingSchema} = normalizeCredentialsAndRoles(normalized, source);
    normalizeServiceSelections(normalized, source);
    normalizeModelCatalogAndBilling(normalized, source, hasSavedCustomModelSchema, hasModelThinkingSchema);
}
