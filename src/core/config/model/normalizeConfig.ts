/**
 * @file src/core/config/model/normalizeConfig.ts
 *
 * 文件职责：实现顶层配置归一化入口 normalizeConfig，将存储或导入的任意普通对象补齐、清洗并迁移为合法的 Config 实例。
 * 主要内容：调用迭代深克隆剥离响应式 Proxy 与敏感未知键，统一规范化语言、外观、限流、免费池、API 密钥、自定义与组合服务、模型迁移、视频字幕、悬浮球、划词、快捷键与术语库配置。
 * 模块边界：协调 configClass、providerNormalization、interactionDefaults 及各领域配置子模块的纯转换，不直接读写浏览器存储或发起网络请求。
 */

import {normalizePrivacyPolicy, normalizePrivacyTerms} from '../../privacy/policy';
import {normalizeAiMultiSegmentMaxCharacters, normalizeAiMultiSegmentMaxSegments} from '../aiMultiSegment';
import {normalizeAiRequestTimeoutMs} from '../aiRequestTimeout';
import {apiKeysToToken, normalizeApiKeys} from '../apiKeys';
import {
    DEFAULT_AREA_TRANSLATION_HOTKEY,
    normalizeAreaTranslationHotkey,
    normalizeCustomAreaTranslationHotkey,
    resolveAreaTranslationHotkey,
} from '../areaTranslation';
import {currentModelIds, defaultModels} from '../catalog/models';
import {options} from '../catalog/options';
import {defaultOption} from '../catalog/prompts';
import {services} from '../catalog/services';
import {servicesType} from '../catalog/serviceTypes';
import {normalizeClickSelectionHotkey} from '../clickSelection';
import {normalizeCompositeTranslationProviders} from '../compositeTranslation';
import {normalizeCustomBodyMapping} from '../customBody';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId} from '../customOpenAI';
import {normalizeDeepLApiPlan} from '../deepl';
import {dictionaryId, normalizeDictionaryWorkspace} from '../dictionaryWorkspace';
import {
    normalizeFreeTranslationCooldownMs,
    normalizeFreeTranslationMode,
    normalizeFreeTranslationOrder,
    normalizeFreeTranslationTimeoutMs,
    normalizeMyMemoryEmail,
} from '../freeTranslation';
import {normalizeHarnessPreferences} from '../harness';
import {normalizeInformationHighlightPreferences} from '../informationHighlight';
import {
    normalizeCustomInputBoxTranslationHotkey,
    normalizeInputBoxTranslationInterval,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationOutputMode,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
} from '../inputTranslation';
import {
    normalizeInterfaceFont,
    normalizeInterfaceSkin,
    normalizeInterfaceVisibility,
    normalizePopupModuleOrder,
    normalizePopupQuickFeatureOrder,
    normalizePopupQuickFeatureVisibility,
} from '../interfaceAppearance';
import {normalizeLocalTtsMode, normalizeLocalTtsVoice} from '../localTts';
import {normalizeMangaCachePages, normalizeMangaPrefetchPages, normalizeMangaSiteRules} from '../mangaNormalization';
import {normalizeModelThinkingMapping} from '../modelThinking';
import {DEFAULT_NATIVE_ASR_BASE_URL, normalizeNativeAsrBaseUrl} from '../nativeAsr';
import {normalizeNativeBatchTranslationEnabled} from '../nativeBatch';
import {
    normalizeEagerTranslationCharacters,
    normalizeExcludedLanguages,
    normalizeExcludedTags,
    normalizeMinTranslationTextLength,
} from '../pageTranslation';
import {
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    normalizeCustomParagraphCopyHotkey,
    normalizeParagraphCopyContentMode,
    normalizeParagraphCopyHotkey,
    resolveParagraphCopyHotkey,
} from '../paragraphCopy';
import {inputBoxTranslationTriggerHotkey, normalizeQuickTranslationProfiles} from '../quickTranslation';
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
import {
    DEFAULT_SECTION_TRANSLATION_HOTKEY,
    normalizeCustomSectionTranslationHotkey,
    normalizeSectionTranslationHotkey,
    resolveSectionTranslationHotkey,
} from '../sectionTranslation';
import {normalizeSectionTranslationRules} from '../sectionTranslationRules';
import {normalizeWordDictionarySource} from '../selectionDictionary';
import {
    normalizeSelectionTtsOnlineSources,
    normalizeSelectionTtsOpenAiModel,
    normalizeSelectionTtsOpenAiVoice,
    normalizeSelectionTtsRate,
    normalizeSelectionTtsVoiceOrder,
} from '../selectionTts';
import {isSensitiveConfigKey} from '../sensitiveKeys';
import {
    normalizeSentenceHighlightAppearance,
    normalizeSentenceHighlightProfiles,
    normalizeSentenceHighlightStyle,
} from '../sentenceHighlight';
import {DEFAULT_DISABLED_AI_PLATFORM_SERVICES, normalizeDisabledTranslationServices} from '../serviceAvailability';
import {normalizeShareCardPreferences} from '../shareCard';
import {normalizeTranslationAppearance, normalizeTranslationStyleProfiles} from '../translationAppearance';
import {normalizeTranslationCacheLimits} from '../translationCache';
import {normalizeTranslationLoadingStyle} from '../translationLoadingStyle';
import {normalizeVideoCourseAutoStart} from '../videoCourse';
import {normalizeVideoSentenceLearningAppearance} from '../videoSentenceLearningAppearance';
import {normalizeVideoSubtitleAppearance} from '../videoSubtitleAppearance';
import {
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    normalizeCustomVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkeyAction,
    resolveVideoSubtitleModeHotkey,
} from '../videoSubtitleShortcut';
import {normalizeAreaVisionPrompt, normalizeModelVisionOverrides} from '../vision';
import {normalizeWritingPreferences, resolveWritingHotkey} from '../writing';
import {
    DEFAULT_COMMAND_PALETTE_HOTKEY,
    normalizeCommandPaletteEnabled,
    normalizeCommandPaletteHotkey,
    normalizeCustomCommandPaletteHotkey,
    resolveCommandPaletteHotkey,
} from '../commandPalette';
import {normalizeContextMenuEntryPreferences} from '@/src/core/context-menu/domain';
import {normalizeGlossaryIds, normalizeGlossaryLibraries} from '@/src/core/glossary';
import {resolveConfiguredHotkey} from '@/src/core/hotkey';
import {normalizeUiLanguage} from '@/src/core/i18n/language';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {normalizeSiteAdaptationSettings} from '@/src/core/site-adaptation/schema';
import {
    normalizeAlwaysTranslateDomains,
    normalizeDisabledExtensionDomains,
    normalizeFloatingBallDisabledDomains,
    normalizeSiteDomains,
} from '@/src/core/site-rules/domain';
import {
    cloneConfigValue,
    hasOwn,
    isBooleanMapping,
    normalizeStringList,
    normalizeStringMapping,
} from './clone';
import {Config, systemRoleFactory, userRoleFactory} from './configClass';
import {
    DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    DEFAULT_NEW_API_URL,
    normalizeFloatingBallClickAction,
    normalizeFloatingBallCollapsedOpacity,
    normalizeFloatingBallHoverDelay,
    normalizeFloatingBallMargin,
    normalizeFloatingBallToolsDisplay,
    normalizeFloatingBallVerticalPosition,
    normalizeMouseHoverTranslationDelay,
    normalizeSelectionTranslatorDelay,
    normalizeVideoSubtitleFontSize,
    normalizeVideoSubtitleOffsetMs,
    VIDEO_SOURCE_LANGUAGE_OPTIONS,
} from './interactionDefaults';
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

function normalizeConfigLanguage(value: unknown): string {
    return typeof value === 'string' ? normalizeChineseLanguageCode(value) : '';
}

/**
 * 将存储或导入的普通对象补齐为当前配置结构，并迁移已退役或错误的模型编号。
 */
export function normalizeConfig(value: unknown): Config {
    const normalized = new Config();
    const knownFields = new Set(Object.keys(normalized));
    // Vue 的响应式对象是 Proxy。Chrome 的 runtime 通道有时会替调用方
    // 做隐式转换，但 Firefox 会严格按 structured clone 处理并直接抛出
    // DataCloneError，所以配置边界必须先落成纯对象。
    const source = value && typeof value === 'object'
        ? cloneConfigValue(value) as Partial<Config>
        : {};
    // 导入对象的所有键都是普通数据；避免 __proto__ setter 改写配置实例的原型。
    for (const key of Object.keys(source)) {
        Object.defineProperty(normalized, key, Object.getOwnPropertyDescriptor(source, key)!);
    }
    // 短期版本曾暴露的策略开关在对应功能退役后必须主动丢弃，避免旧配置继续
    // 分叉存储语义，或让已经删除的 X 原生翻译设置进入历史和迁移导出。
    delete (normalized as unknown as Record<string, unknown>).persistCredentials;
    delete (normalized as unknown as Record<string, unknown>).xGrokAutoTranslateEnabled;
    for (const key of Object.keys(source)) {
        if (!knownFields.has(key) && isSensitiveConfigKey(key)) {
            delete (normalized as unknown as Record<string, unknown>)[key];
        }
    }
    const legacyTranslationStatus = (source as unknown as Record<string, unknown>).translationStatus;
    if (typeof source.translationProgressPanelEnabled !== 'boolean') {
        normalized.translationProgressPanelEnabled = typeof legacyTranslationStatus === 'boolean'
            ? legacyTranslationStatus
            : false;
    }
    normalized.informationHighlight = normalizeInformationHighlightPreferences(source.informationHighlight);
    normalized.privacyProtection = normalizePrivacyPolicy(source.privacyProtection);
    normalized.privacyProtectionSecretTerms = normalizePrivacyTerms(source.privacyProtectionSecretTerms);
    normalized.nativeBatchTranslationEnabled = normalizeNativeBatchTranslationEnabled(source.nativeBatchTranslationEnabled);
    normalized.bilingualSentenceHighlightEnabled = source.bilingualSentenceHighlightEnabled !== false;
    normalized.bilingualSentenceHighlightStyle = normalizeSentenceHighlightStyle(source.bilingualSentenceHighlightStyle);
    normalized.bilingualSentenceHighlightAppearance = normalizeSentenceHighlightAppearance(source.bilingualSentenceHighlightAppearance);
    normalized.bilingualSentenceHighlightProfiles = normalizeSentenceHighlightProfiles(source.bilingualSentenceHighlightProfiles);
    normalized.activeSentenceHighlightProfileId = typeof source.activeSentenceHighlightProfileId === 'string'
        && normalized.bilingualSentenceHighlightProfiles.some(profile => profile.id === source.activeSentenceHighlightProfileId)
        ? source.activeSentenceHighlightProfileId : '';
    normalized.translationAppearance = normalizeTranslationAppearance(source.translationAppearance);
    normalized.browserDefaultTranslationFont = source.browserDefaultTranslationFont === true;
    normalized.translationStyleProfiles = normalizeTranslationStyleProfiles(source.translationStyleProfiles);
    normalized.activeTranslationStyleProfileId = typeof source.activeTranslationStyleProfileId === 'string'
        && normalized.translationStyleProfiles.some((profile) => profile.id === source.activeTranslationStyleProfileId)
        ? source.activeTranslationStyleProfileId : '';
    normalized.translationScope = source.translationScope === 'all' ? 'all' : 'content';
    delete (normalized as unknown as Record<string, unknown>).translationStatus;
    // __fluentConfigRevision 只用于 storage 的写入顺序判断，不能进入运行时
    // 配置或历史快照，否则默认配置与同值的页面快照会因内部字段不同而无法去重。
    delete (normalized as unknown as Record<string, unknown>).__fluentConfigRevision;
    // 后台计数幂等日志与 revision 一样只属于存储协议，不能进入 UI、历史或导出配置。
    delete (normalized as unknown as Record<string, unknown>).__fluentCountOperations;
    delete (normalized as unknown as Record<string, unknown>).robot_id;

    // 翻译次数只接受非负安全整数；旧版本或手工修改产生的字符串、负数和溢出值回退为 0。
    normalized.count = typeof source.count === 'number'
        && Number.isSafeInteger(source.count)
        && source.count >= 0
        ? source.count
        : 0;
    normalized.from = normalizeConfigLanguage(source.from) || defaultOption.from;
    normalized.to = normalizeConfigLanguage(source.to) || defaultOption.to;
    normalized.excludedLanguages = normalizeExcludedLanguages(source.excludedLanguages);
    normalized.excludedTags = normalizeExcludedTags(source.excludedTags);
    normalized.customInputBoxTranslationHotkey = normalizeCustomInputBoxTranslationHotkey(
        source.customInputBoxTranslationHotkey,
    );
    if (normalized.inputBoxTranslationTrigger === 'custom' && !normalized.customInputBoxTranslationHotkey) {
        normalized.inputBoxTranslationTrigger = 'disabled';
    }
    normalized.inputBoxTranslationTarget = normalizeConfigLanguage(source.inputBoxTranslationTarget)
        || defaultOption.inputBoxTranslationTarget;
    normalized.inputBoxTranslationOutputMode = normalizeInputBoxTranslationOutputMode(source.inputBoxTranslationOutputMode);
    normalized.inputBoxTranslationInterval = normalizeInputBoxTranslationInterval(
        source.inputBoxTranslationInterval,
    );
    normalized.inputBoxTranslationModel = normalizeInputBoxTranslationModel(source.inputBoxTranslationModel);
    normalized.inputBoxTranslationPrompt = normalizeInputBoxTranslationPrompt(source.inputBoxTranslationPrompt);
    normalized.inputBoxTranslationSystemPrompt = normalizeInputBoxTranslationPrompt(
        source.inputBoxTranslationSystemPrompt,
    );
    normalized.uiLanguage = normalizeUiLanguage(source.uiLanguage);
    const cacheLimits = normalizeTranslationCacheLimits({
        maxBytes: source.translationCacheMaxBytes,
        maxEntries: source.translationCacheMaxEntries,
    });
    normalized.translationCacheMaxBytes = cacheLimits.maxBytes;
    normalized.translationCacheMaxEntries = cacheLimits.maxEntries;
    normalized.uiLanguageSetupCompleted = source.uiLanguageSetupCompleted === true;
    normalized.maxConcurrentTranslations = normalizeMaxConcurrentTranslations(
        source.maxConcurrentTranslations,
    );
    normalized.aiRequestTimeoutMs = normalizeAiRequestTimeoutMs(source.aiRequestTimeoutMs);
    normalized.translationLoadingStyle = normalizeTranslationLoadingStyle(
        source.translationLoadingStyle,
    );
    normalized.translationRequestsPerSecond = normalizeTranslationRequestsPerSecond(
        source.translationRequestsPerSecond,
    );
    normalized.translationRequestsPerMinute = normalizeTranslationRequestsPerMinute(
        source.translationRequestsPerMinute,
    );
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
    normalized.translationBackoffBaseMs = normalizeTranslationBackoffBaseMs(
        source.translationBackoffBaseMs,
    );
    normalized.translationBackoffMaxMs = Math.max(
        normalized.translationBackoffBaseMs,
        normalizeTranslationBackoffMaxMs(source.translationBackoffMaxMs),
    );

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

    if (typeof normalized.custom !== 'string') normalized.custom = defaultOption.custom;
    normalized.deeplApiPlan = normalizeDeepLApiPlan(source.deeplApiPlan);
    if (typeof normalized.newApiUrl !== 'string') normalized.newApiUrl = DEFAULT_NEW_API_URL;
    normalizeCustomOpenAIProviderState(normalized, source);
    normalized.compositeTranslationProviders = normalizeCompositeTranslationProviders(source.compositeTranslationProviders, normalized.customOpenAIProviders);
    normalized.favoriteServices = Array.isArray(source.favoriteServices)
        ? [...new Set(source.favoriteServices.filter(service =>
            typeof service === 'string' && isSupportedTranslationService(service, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)))].slice(0, 100)
        : [];
    normalized.inputBoxTranslationService = normalizeInputBoxTranslationService(
        source.inputBoxTranslationService,
        normalized.customOpenAIProviders,
        normalized.compositeTranslationProviders,
    );
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
        normalized[field] = isSupportedTranslationService(source[field], normalized.customOpenAIProviders, normalized.compositeTranslationProviders) ? source[field] : '';
    }

    normalized.areaTranslationMode = source.areaTranslationMode === 'ai' ? 'ai' : 'standard';
    normalized.areaTranslationService = isSupportedTranslationService(source.areaTranslationService, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)
        ? source.areaTranslationService : '';
    normalized.areaRecognitionMode = source.areaRecognitionMode === 'ocr' ? 'ocr' : 'prefer-vision';
    normalized.areaVisionPrompt = normalizeAreaVisionPrompt(source.areaVisionPrompt);
    normalized.modelVision = normalizeModelVisionOverrides(source.modelVision);

    if (typeof normalized.videoTranslationEnabled !== 'boolean') {
        normalized.videoTranslationEnabled = true;
    }
    normalized.videoMeetingAutoEnabled = typeof source.videoMeetingAutoEnabled === 'boolean' ? source.videoMeetingAutoEnabled : true;
    normalized.videoCourseAutoStart = normalizeVideoCourseAutoStart(source.videoCourseAutoStart);
    normalized.videoPreferHumanSubtitles = typeof source.videoPreferHumanSubtitles === 'boolean' ? source.videoPreferHumanSubtitles : true;
    // 缺失或非法选择统一使用质量默认；明确保存的 Tiny/Base/Small 继续保留。
    if (normalized.videoLocalModel !== 'tiny' && normalized.videoLocalModel !== 'base' && normalized.videoLocalModel !== 'small') {
        normalized.videoLocalModel = 'small';
    }
    normalized.videoTranscriptionProvider = source.videoTranscriptionProvider === 'native-qwen' ? 'native-qwen' : 'browser';
    normalized.videoNativeAsrBaseUrl = source.videoNativeAsrBaseUrl === undefined
        ? DEFAULT_NATIVE_ASR_BASE_URL : normalizeNativeAsrBaseUrl(source.videoNativeAsrBaseUrl);
    if (!VIDEO_SOURCE_LANGUAGE_OPTIONS.some((item) => item.value === normalized.videoSourceLanguage)) {
        normalized.videoSourceLanguage = 'auto';
    }
    // 早期 Beta 版本曾把 DeepLX 写成默认值。只对没有迁移标记的旧配置
    // 执行一次迁移，避免覆盖用户在新版本中主动选择的 DeepLX。
    const shouldMigrateLegacyVideoDefault = source.videoService === services.deeplx
        && source.videoServiceDefaultMigrated !== true;
    if (shouldMigrateLegacyVideoDefault
        || !isSupportedTranslationService(normalized.videoService, normalized.customOpenAIProviders, normalized.compositeTranslationProviders)) {
        normalized.videoService = '';
    }
    normalized.videoServiceDefaultMigrated = true;
    if (typeof normalized.videoSubtitleVisible !== 'boolean') {
        normalized.videoSubtitleVisible = true;
    }
    if (!['bilingual', 'translation-only', 'original-only'].includes(normalized.videoSubtitleDisplayMode)) {
        normalized.videoSubtitleDisplayMode = 'bilingual';
    }
    if (typeof normalized.videoSubtitleModeHotkeyEnabled !== 'boolean') {
        normalized.videoSubtitleModeHotkeyEnabled = false;
    }
    normalized.customVideoSubtitleModeHotkey = normalizeCustomVideoSubtitleModeHotkey(source.customVideoSubtitleModeHotkey);
    normalized.videoSubtitleModeHotkey = normalizeVideoSubtitleModeHotkey(source.videoSubtitleModeHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，避免开启状态没有可用快捷键。
    if (normalized.videoSubtitleModeHotkey === 'custom' && !normalized.customVideoSubtitleModeHotkey) {
        normalized.videoSubtitleModeHotkey = DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
    }
    normalized.videoSubtitleModeHotkeyAction = normalizeVideoSubtitleModeHotkeyAction(source.videoSubtitleModeHotkeyAction);
    normalized.commandPaletteEnabled = normalizeCommandPaletteEnabled(source.commandPaletteEnabled);
    normalized.customCommandPaletteHotkey = normalizeCustomCommandPaletteHotkey(source.customCommandPaletteHotkey);
    normalized.commandPaletteHotkey = normalizeCommandPaletteHotkey(source.commandPaletteHotkey);
    if (normalized.commandPaletteHotkey === 'custom' && !normalized.customCommandPaletteHotkey) {
        normalized.commandPaletteHotkey = DEFAULT_COMMAND_PALETTE_HOTKEY;
    }
    normalized.videoSubtitleFontSize = normalizeVideoSubtitleFontSize(normalized.videoSubtitleFontSize);
    normalized.videoSubtitleOffsetMs = normalizeVideoSubtitleOffsetMs(normalized.videoSubtitleOffsetMs);
    const hasVideoSubtitleAppearance = hasOwn(source as object, 'videoSubtitleAppearance');
    normalized.videoSubtitleAppearance = normalizeVideoSubtitleAppearance(
        hasVideoSubtitleAppearance
            ? source.videoSubtitleAppearance
            : {fontScale: source.videoSubtitleFontSize},
    );

    normalized.videoSentenceLearningAppearance = normalizeVideoSentenceLearningAppearance(source.videoSentenceLearningAppearance);

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

    const enabledHoverChoices = options.keys.filter(item => !('disabled' in item && item.disabled) && item.value !== 'none').map(item => item.value);
    normalized.hoverShortcutBeforeDisable = enabledHoverChoices.includes(normalized.hotkey)
        ? normalized.hotkey : enabledHoverChoices.includes(source.hoverShortcutBeforeDisable ?? '')
            ? source.hoverShortcutBeforeDisable! : defaultOption.hotkey;
    normalized.mouseHoverTranslationDelay = normalizeMouseHoverTranslationDelay(
        source.mouseHoverTranslationDelay,
    );
    normalized.floatingBallToolsDisplay = normalizeFloatingBallToolsDisplay(source.floatingBallToolsDisplay);
    normalized.floatingBallVerticalPosition = normalizeFloatingBallVerticalPosition(
        source.floatingBallVerticalPosition,
    );
    normalized.floatingBallHoverDelay = normalizeFloatingBallHoverDelay(source.floatingBallHoverDelay);
    normalized.floatingBallClickAction = normalizeFloatingBallClickAction(source.floatingBallClickAction);
    normalized.floatingBallCompact = source.floatingBallCompact === true;
    normalized.floatingBallSettingsEntryVisible = source.floatingBallSettingsEntryVisible !== false;
    normalized.floatingBallCollapsedOpacity = normalizeFloatingBallCollapsedOpacity(
        source.floatingBallCollapsedOpacity,
    );
    normalized.floatingBallDefaultMargin = normalizeFloatingBallMargin(
        source.floatingBallDefaultMargin,
        DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    );
    normalized.floatingBallPopoutMargin = normalizeFloatingBallMargin(
        source.floatingBallPopoutMargin,
        DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    );
    normalized.floatingBallDisabledDomains = normalizeFloatingBallDisabledDomains(
        source.floatingBallDisabledDomains,
    );
    normalized.sidebarTranslationEnabled = source.sidebarTranslationEnabled === true;
    normalized.minTranslationTextLength = normalizeMinTranslationTextLength(source.minTranslationTextLength);
    normalized.eagerTranslationCharacters = normalizeEagerTranslationCharacters(source.eagerTranslationCharacters);
    normalized.longParagraphLineBreakEnabled = source.longParagraphLineBreakEnabled === true;
    normalized.translationBeforeOriginal = source.translationBeforeOriginal === true;
    normalized.alwaysTranslateDomains = normalizeAlwaysTranslateDomains(source.alwaysTranslateDomains);
    normalized.disabledExtensionDomains = normalizeDisabledExtensionDomains(source.disabledExtensionDomains);
    normalized.translationOnlyDomains = normalizeSiteDomains(source.translationOnlyDomains);
    normalized.siteAdaptation = normalizeSiteAdaptationSettings(source.siteAdaptation);
    normalized.shareCard = normalizeShareCardPreferences(source.shareCard);
    normalized.interfaceSkin = normalizeInterfaceSkin(source.interfaceSkin);
    normalized.interfaceFont = normalizeInterfaceFont(source.interfaceFont);
    normalized.interfaceVisibility = normalizeInterfaceVisibility(source.interfaceVisibility);
    normalized.popupModuleOrder = normalizePopupModuleOrder(source.popupModuleOrder);
    normalized.translationSidepanelScope = source.translationSidepanelScope === 'window' ? 'window' : 'tab';
    normalized.toolbarClickAction = source.toolbarClickAction === 'translate' ? 'translate' : 'popup';
    normalized.popupQuickFeatureOrder = normalizePopupQuickFeatureOrder(source.popupQuickFeatureOrder);
    normalized.popupQuickFeatureVisibility = normalizePopupQuickFeatureVisibility(source.popupQuickFeatureVisibility);

    if (!['disabled', 'bilingual', 'translation-only'].includes(normalized.selectionTranslatorMode)) {
        normalized.selectionTranslatorMode = 'disabled';
    }
    // 仅旧版本缺失呈现字段时迁移；关闭统一开关后，学习偏好不能再次把功能打开。
    const legacySelection = source.selectionTranslatorPresentation === undefined;
    normalized.selectionTranslatorPresentation = 'card';
    if (legacySelection && normalized.harness.enabled && normalized.selectionTranslatorMode === 'disabled') {
        normalized.selectionTranslatorMode = 'bilingual';
        normalized.selectionTranslatorTrigger = normalized.harness.trigger === 'shortcut' ? 'custom'
            : normalized.harness.trigger === 'hover' ? 'hover' : 'icon';
        if (normalized.harness.trigger === 'shortcut') normalized.customSelectionTranslatorHotkey = normalized.harness.customHotkey;
    }
    const selectionTriggerValues = ['direct', 'icon', 'dot', 'hover', 'contextMenu', 'Control', 'Alt', 'Shift', 'custom'];
    const selectionShortcutValues = ['Control', 'Alt', 'Shift', 'custom'];
    const hasExplicitSelectionTrigger = typeof source.selectionTranslatorTrigger === 'string'
        && selectionTriggerValues.includes(source.selectionTranslatorTrigger);
    if (!selectionTriggerValues.includes(normalized.selectionTranslatorTrigger)) {
        normalized.selectionTranslatorTrigger = 'icon';
    }
    if (!['none', 'Control', 'Alt', 'Shift', 'custom'].includes(normalized.selectionTranslatorHotkey)) {
        normalized.selectionTranslatorHotkey = 'none';
    }
    if (typeof normalized.customSelectionTranslatorHotkey !== 'string') {
        normalized.customSelectionTranslatorHotkey = '';
    }
    normalized.selectionClickSelectEnabled = source.selectionClickSelectEnabled === true;
    normalized.selectionClickSelectHotkey = normalizeClickSelectionHotkey(source.selectionClickSelectHotkey);
    normalized.selectionTranslatorDelay = normalizeSelectionTranslatorDelay(
        source.selectionTranslatorDelay,
    );
    normalized.selectionTranslatorBidirectional = source.selectionTranslatorBidirectional === true;
    normalized.selectionDictionarySource = normalizeWordDictionarySource(source.selectionDictionarySource);
    if (import.meta.env?.BROWSER !== 'userscript') {
        normalized.selectionDictionaryWorkspace = normalizeDictionaryWorkspace(source.selectionDictionaryWorkspace);
        const recipe = dictionaryId(source.selectionDictionaryRecipe);
        normalized.selectionDictionaryRecipe = normalized.selectionDictionaryWorkspace.recipes.some(item => item.id === recipe) ? recipe : '';
    }
    normalized.selectionTranslatorAutoDismiss = typeof source.selectionTranslatorAutoDismiss === 'boolean'
        ? source.selectionTranslatorAutoDismiss : true;
    // 兼容上一版“触发方式 + 可选快捷键”配置，并将最终状态收敛为单一触发方式。
    if (!hasExplicitSelectionTrigger
        && ['direct', 'icon', 'dot'].includes(normalized.selectionTranslatorTrigger)
        && normalized.selectionTranslatorHotkey !== 'none') {
        normalized.selectionTranslatorTrigger = normalized.selectionTranslatorHotkey;
    }
    if (selectionShortcutValues.includes(normalized.selectionTranslatorTrigger)) {
        if (normalized.selectionTranslatorTrigger === 'custom'
            && (!normalized.customSelectionTranslatorHotkey.trim() || normalized.customSelectionTranslatorHotkey === 'none')) {
            normalized.selectionTranslatorTrigger = 'icon';
            normalized.selectionTranslatorHotkey = 'none';
        } else {
            normalized.selectionTranslatorHotkey = normalized.selectionTranslatorTrigger;
        }
    } else {
        normalized.selectionTranslatorHotkey = 'none';
    }
    normalized.selectionTtsVoices = normalizeSelectionTtsVoiceOrder(normalized.selectionTtsVoices);
    normalized.selectionTtsMode = normalizeLocalTtsMode(source.selectionTtsMode);
    normalized.selectionTtsLocalVoice = normalizeLocalTtsVoice(source.selectionTtsLocalVoice);
    normalized.selectionTtsRate = normalizeSelectionTtsRate(source.selectionTtsRate);
    normalized.selectionTtsOnlineSources = normalizeSelectionTtsOnlineSources(source.selectionTtsOnlineSources);
    normalized.selectionTtsOpenAiModel = normalizeSelectionTtsOpenAiModel(source.selectionTtsOpenAiModel);
    normalized.selectionTtsOpenAiVoice = normalizeSelectionTtsOpenAiVoice(source.selectionTtsOpenAiVoice);
    normalized.disableSelectionTranslator = normalized.selectionTranslatorMode === 'disabled';
    normalized.selectionTranslatorModeBeforeDisable = normalized.selectionTranslatorMode === 'translation-only'
        || (normalized.selectionTranslatorMode === 'disabled' && source.selectionTranslatorModeBeforeDisable === 'translation-only')
        ? 'translation-only' : 'bilingual';
    if (typeof normalized.vocabularyBookEnabled !== 'boolean') {
        normalized.vocabularyBookEnabled = false;
    }
    if (typeof normalized.vocabularyReencounterEnabled !== 'boolean') normalized.vocabularyReencounterEnabled = false;
    if (import.meta.env?.BROWSER !== 'userscript') normalized.personalCorrectionsEnabled = source.personalCorrectionsEnabled === true;
    else delete (normalized as Partial<Config>).personalCorrectionsEnabled;
    if (typeof normalized.selectionAreaEnabled !== 'boolean') {
        normalized.selectionAreaEnabled = true;
    }
    normalized.customSelectionAreaHotkey = normalizeCustomAreaTranslationHotkey(source.customSelectionAreaHotkey);
    normalized.selectionAreaHotkey = normalizeAreaTranslationHotkey(source.selectionAreaHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，圈选翻译不会失去唯一入口。
    if (normalized.selectionAreaHotkey === 'custom' && !normalized.customSelectionAreaHotkey) {
        normalized.selectionAreaHotkey = DEFAULT_AREA_TRANSLATION_HOTKEY;
    }
    if (typeof normalized.paragraphCopyEnabled !== 'boolean') {
        normalized.paragraphCopyEnabled = false;
    }
    normalized.customParagraphCopyHotkey = normalizeCustomParagraphCopyHotkey(source.customParagraphCopyHotkey);
    normalized.paragraphCopyHotkey = normalizeParagraphCopyHotkey(source.paragraphCopyHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，段落复制不会失去唯一入口。
    if (normalized.paragraphCopyHotkey === 'custom' && !normalized.customParagraphCopyHotkey) {
        normalized.paragraphCopyHotkey = DEFAULT_PARAGRAPH_COPY_HOTKEY;
    }
    normalized.paragraphCopyContent = normalizeParagraphCopyContentMode(source.paragraphCopyContent);
    if (typeof normalized.sectionTranslationHotkeyEnabled !== 'boolean') {
        normalized.sectionTranslationHotkeyEnabled = false;
    }
    normalized.sectionTranslationRules = normalizeSectionTranslationRules(source.sectionTranslationRules);
    normalized.customSectionTranslationHotkey = normalizeCustomSectionTranslationHotkey(source.customSectionTranslationHotkey);
    normalized.sectionTranslationHotkey = normalizeSectionTranslationHotkey(source.sectionTranslationHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，开启的快捷键不会失去可用组合。
    if (normalized.sectionTranslationHotkey === 'custom' && !normalized.customSectionTranslationHotkey) {
        normalized.sectionTranslationHotkey = DEFAULT_SECTION_TRANSLATION_HOTKEY;
    }
    if (typeof normalized.disableImageTranslator !== 'boolean') {
        normalized.disableImageTranslator = true;
    }
    normalized.imageTranslationMangaEnabled = typeof normalized.imageTranslationMangaEnabled === 'boolean' ? normalized.imageTranslationMangaEnabled : true;
    // 新安装、缺失或非法值使用 PaddleOCR；保留已保存的 Tesseract 选择。
    normalized.imageTranslationOcrEngine = normalized.imageTranslationOcrEngine === 'tesseract' ? 'tesseract' : 'paddle';
    normalized.imageTranslationInferenceBackend = normalized.imageTranslationInferenceBackend === 'cpu' ? 'cpu' : 'auto';
    normalized.imageTranslationMangaPromptEnabled = typeof normalized.imageTranslationMangaPromptEnabled === 'boolean' ? normalized.imageTranslationMangaPromptEnabled : true;
    normalized.imageTranslationMangaDownloadConfirmed = normalized.imageTranslationMangaDownloadConfirmed === true;
    normalized.imageTranslationMangaSites = normalizeMangaSiteRules(normalized.imageTranslationMangaSites);
    normalized.imageTranslationMangaPrefetchPages = normalizeMangaPrefetchPages(normalized.imageTranslationMangaPrefetchPages);
    normalized.imageTranslationMangaCachePages = normalizeMangaCachePages(normalized.imageTranslationMangaCachePages);
    normalized.imageTranslationHoverEnabled = typeof normalized.imageTranslationHoverEnabled === 'boolean' ? normalized.imageTranslationHoverEnabled : true;
    normalized.imageTranslationContextMenuEnabled = typeof normalized.imageTranslationContextMenuEnabled === 'boolean' ? normalized.imageTranslationContextMenuEnabled : true;
    if (typeof normalized.contextMenuEnabled !== 'boolean') {
        normalized.contextMenuEnabled = true;
    }
    normalized.contextMenuEntries = normalizeContextMenuEntryPreferences(source.contextMenuEntries);
    normalized.contextMenuShowTargetLanguage = normalized.contextMenuShowTargetLanguage !== false;
    normalized.contextMenuShowShortcut = normalized.contextMenuShowShortcut !== false;
    if (typeof normalized.pageTitleTranslationEnabled !== 'boolean') {
        normalized.pageTitleTranslationEnabled = true;
    }
    if (!['viewport', 'all'].includes(normalized.fullPageTranslationMode)) {
        normalized.fullPageTranslationMode = 'viewport';
    }
    normalized.translationCenterServices = normalizeStringList(source.translationCenterServices)
        .filter(service => isSupportedTranslationService(service, normalized.customOpenAIProviders, normalized.compositeTranslationProviders));
    normalized.translationCenterSourceLanguage = normalizeConfigLanguage(source.translationCenterSourceLanguage);
    normalized.translationCenterTargetLanguage = normalizeConfigLanguage(source.translationCenterTargetLanguage);
    normalized.translationCenterLayout = source.translationCenterLayout === 'grid' ? 'grid' : 'list';
    normalized.glossaryEnabled = source.glossaryEnabled === true;
    normalized.glossaryLibraries = normalizeGlossaryLibraries(source.glossaryLibraries);
    normalized.documentGlossaryIds = normalizeGlossaryIds(source.documentGlossaryIds, normalized.glossaryLibraries);
    normalized.videoGlossaryIds = normalizeGlossaryIds(source.videoGlossaryIds, normalized.glossaryLibraries);
    normalized.quickTranslationProfiles = normalizeQuickTranslationProfiles(
        source.quickTranslationProfiles,
        {
            isSupportedService: (service) => isSupportedTranslationService(
                service,
                normalized.customOpenAIProviders,
                normalized.compositeTranslationProviders,
            ),
            serviceUsesModel: (service) => isCustomOpenAIProviderId(service)
                || servicesType.isUseModel(service),
            glossaryLibraries: normalized.glossaryLibraries,
            reservedHotkeys: [
                resolveConfiguredHotkey(normalized.hotkey, normalized.customHotkey),
                resolveConfiguredHotkey(normalized.floatingBallHotkey, normalized.customFloatingBallHotkey),
                ...(normalized.selectionAreaEnabled
                    ? [resolveAreaTranslationHotkey(normalized.selectionAreaHotkey, normalized.customSelectionAreaHotkey)]
                    : []),
                ...(normalized.paragraphCopyEnabled
                    ? [resolveParagraphCopyHotkey(normalized.paragraphCopyHotkey, normalized.customParagraphCopyHotkey)]
                    : []),
                ...(normalized.sectionTranslationHotkeyEnabled
                    ? [resolveSectionTranslationHotkey(normalized.sectionTranslationHotkey, normalized.customSectionTranslationHotkey)]
                    : []),
                ...(normalized.videoSubtitleModeHotkeyEnabled
                    ? [resolveVideoSubtitleModeHotkey(normalized.videoSubtitleModeHotkey, normalized.customVideoSubtitleModeHotkey)]
                    : []),
                ...(resolveWritingHotkey(normalized.writing)
                    ? [resolveWritingHotkey(normalized.writing)]
                    : []),
                ...(normalized.commandPaletteEnabled
                    ? [resolveCommandPaletteHotkey(normalized.commandPaletteHotkey, normalized.customCommandPaletteHotkey)]
                    : []),
                inputBoxTranslationTriggerHotkey(
                    normalized.inputBoxTranslationTrigger,
                    normalized.customInputBoxTranslationHotkey,
                ),
            ],
        },
    );
    normalized.enableAIMultiSegment = source.enableAIMultiSegment === true;
    normalized.aiMultiSegmentMaxSegments = normalizeAiMultiSegmentMaxSegments(source.aiMultiSegmentMaxSegments);
    normalized.aiMultiSegmentMaxCharacters = normalizeAiMultiSegmentMaxCharacters(source.aiMultiSegmentMaxCharacters);
    return normalized;
}
