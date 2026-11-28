/**
 * @file src/core/config/model/normalizeAppearanceAndReading.ts
 *
 * 文件职责：规范化页面阅读体验、隐私保护、双语译文外观与逐句高亮、界面皮肤布局、网站规则、翻译中心及术语库配置。
 * 主要内容：提供 normalizeAppearanceAndReadingConfig，完成旧 translationStatus 迁移、源/目标语言与排除标签清洗、界面皮肤与弹窗布局顺序规范化、网站域名规则、翻译中心服务筛选、术语库与 AI 多段合批参数校验。
 * 模块边界：仅由 normalizeConfig.ts 在供应商配置归一后调用，依赖已规范化的自定义与组合服务列表；不访问浏览器存储，也不直接操作 DOM。
 */

import {normalizePrivacyPolicy, normalizePrivacyTerms} from '../../privacy/policy';
import {normalizeAiMultiSegmentMaxCharacters, normalizeAiMultiSegmentMaxSegments} from '../aiMultiSegment';
import {defaultOption} from '../catalog/prompts';
import {normalizeInformationHighlightPreferences} from '../informationHighlight';
import {
    normalizeInterfaceFont,
    normalizeInterfaceSkin,
    normalizeInterfaceVisibility,
    normalizePopupModuleOrder,
    normalizePopupQuickFeatureOrder,
    normalizePopupQuickFeatureVisibility,
} from '../interfaceAppearance';
import {normalizeNativeBatchTranslationEnabled} from '../nativeBatch';
import {
    normalizeEagerTranslationCharacters,
    normalizeExcludedLanguages,
    normalizeExcludedTags,
    normalizeMinTranslationTextLength,
} from '../pageTranslation';
import {
    normalizeSentenceHighlightAppearance,
    normalizeSentenceHighlightProfiles,
    normalizeSentenceHighlightStyle,
} from '../sentenceHighlight';
import {normalizeShareCardPreferences} from '../shareCard';
import {normalizeTranslationAppearance, normalizeTranslationStyleProfiles} from '../translationAppearance';
import {normalizeTranslationLoadingStyle} from '../translationLoadingStyle';
import {normalizeGlossaryIds, normalizeGlossaryLibraries} from '@/src/core/glossary';
import {normalizeUiLanguage} from '@/src/core/i18n/language';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {normalizeSiteAdaptationSettings} from '@/src/core/site-adaptation/schema';
import {
    normalizeAlwaysTranslateDomains,
    normalizeDisabledExtensionDomains,
    normalizeSiteDomains,
} from '@/src/core/site-rules/domain';
import {normalizeStringList} from './clone';
import type {Config} from './configClass';
import {isSupportedTranslationService} from './providerNormalization';

export function normalizeConfigLanguage(value: unknown): string {
    return typeof value === 'string' ? normalizeChineseLanguageCode(value) : '';
}

export function normalizeAppearanceAndReadingConfig(normalized: Config, source: Partial<Config>): void {
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
        ? source.activeSentenceHighlightProfileId
        : '';
    normalized.translationAppearance = normalizeTranslationAppearance(source.translationAppearance);
    normalized.browserDefaultTranslationFont = source.browserDefaultTranslationFont === true;
    normalized.translationStyleProfiles = normalizeTranslationStyleProfiles(source.translationStyleProfiles);
    normalized.activeTranslationStyleProfileId = typeof source.activeTranslationStyleProfileId === 'string'
        && normalized.translationStyleProfiles.some((profile) => profile.id === source.activeTranslationStyleProfileId)
        ? source.activeTranslationStyleProfileId
        : '';
    normalized.translationScope = source.translationScope === 'all' ? 'all' : 'content';

    normalized.from = normalizeConfigLanguage(source.from) || defaultOption.from;
    normalized.to = normalizeConfigLanguage(source.to) || defaultOption.to;
    normalized.excludedLanguages = normalizeExcludedLanguages(source.excludedLanguages);
    normalized.excludedTags = normalizeExcludedTags(source.excludedTags);
    normalized.uiLanguage = normalizeUiLanguage(source.uiLanguage);
    normalized.uiLanguageSetupCompleted = source.uiLanguageSetupCompleted === true;
    normalized.translationLoadingStyle = normalizeTranslationLoadingStyle(source.translationLoadingStyle);

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

    if (typeof normalized.pageTitleTranslationEnabled !== 'boolean') {
        normalized.pageTitleTranslationEnabled = true;
    }
    if (!['viewport', 'all'].includes(normalized.fullPageTranslationMode)) {
        normalized.fullPageTranslationMode = 'viewport';
    }
    normalized.translationCenterServices = normalizeStringList(source.translationCenterServices)
        .filter(service => isSupportedTranslationService(
            service,
            normalized.customOpenAIProviders,
            normalized.compositeTranslationProviders,
        ));
    normalized.translationCenterSourceLanguage = normalizeConfigLanguage(source.translationCenterSourceLanguage);
    normalized.translationCenterTargetLanguage = normalizeConfigLanguage(source.translationCenterTargetLanguage);
    normalized.translationCenterLayout = source.translationCenterLayout === 'grid' ? 'grid' : 'list';
    normalized.glossaryEnabled = source.glossaryEnabled === true;
    normalized.glossaryLibraries = normalizeGlossaryLibraries(source.glossaryLibraries);
    normalized.documentGlossaryIds = normalizeGlossaryIds(source.documentGlossaryIds, normalized.glossaryLibraries);
    normalized.videoGlossaryIds = normalizeGlossaryIds(source.videoGlossaryIds, normalized.glossaryLibraries);
    normalized.enableAIMultiSegment = source.enableAIMultiSegment === true;
    normalized.aiMultiSegmentMaxSegments = normalizeAiMultiSegmentMaxSegments(source.aiMultiSegmentMaxSegments);
    normalized.aiMultiSegmentMaxCharacters = normalizeAiMultiSegmentMaxCharacters(source.aiMultiSegmentMaxCharacters);
}
