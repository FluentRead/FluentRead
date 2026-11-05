/**
 * @file src/app/document-translation/index.ts
 * 服务启用：转发统一关闭状态判断与候选过滤，文档 UI 继续只依赖本 public API。
 * 文件职责：汇总文档翻译页面所需的公开业务、配置和运行时能力，形成 DocumentApp 唯一的 app 层依赖入口。
 * 主要内容：转发文档解析/格式/预览 API、Config 与凭据校验、服务模型目录与服务标识、配置读取、共享草稿编辑会话、字段级保存与实时订阅、分段翻译、下载生成、统一图标与分段控件，以及平台能力过滤与不可用提示。
 * 模块边界：该文件只整理稳定公开面，不执行页面挂载、不持有配置副本，也不暴露 document feature 内部实现；实际适配在 runtime，UI 状态在 DocumentApp。
 */
export * from '@/src/features/document-translation/public';
export {hasDistinctTranslation} from '@/src/core/translation/result';
export {buildGlossaryRevision} from '@/src/core/glossary';
export {materialCapture, materialGet, materialGeneration, MATERIAL_RESUME_PARAMETER, type MaterialRecord, type MaterialSelection} from '@/src/features/vocabulary/material/public';
export {Config} from '@/src/core/config/model';
export {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';
export {getMissingCredentialMessage} from '@/src/core/config/validation';
export {filterEnabledTranslationServices, isTranslationServiceDisabled} from '@/src/core/config/serviceAvailability';
export {
    customModelString,
    getMultilingualTargetLanguageLabel,
    models,
    options,
    resolveConfiguredModel,
    services,
    servicesType,
} from '@/src/core/config/catalog';
export {
    getCustomOpenAIProvider,
    withCustomOpenAIServiceOptions,
} from '@/src/core/config/customOpenAI';
export {getCompositeTranslationConfigFingerprint, hasCompositeTranslationAIContext, isCompositeTranslationProviderId,
    withCompositeTranslationServiceOptions} from '@/src/core/config/compositeTranslation';
export {
    config as runtimeConfig,
    configReady,
    requestConfigPatch,
    subscribeConfig,
} from '@/src/services/config/store';
export {createDocumentDownload, createPdfPageRecognizer, documentRetryBackoff, translateDocumentSegments} from './runtime';
export {scoreDocumentInformation} from './informationHighlight';
export {useUiI18n} from '@/src/ui/i18n';
export {useConfigEditor} from '@/src/features/settings/model/useConfigEditor';
export {default as GlossaryLibrarySelect} from '@/src/ui/components/GlossaryLibrarySelect.vue';
export {
    filterAvailableTranslationServices,
    getTranslationServiceUnavailableMessage,
    supportsTranslationGlossary,
} from '@/src/services/translation/capabilities';

export {default as ElSelect} from '@/src/ui/components/UiSelect.vue';
export {default as UiIcon} from '@/src/ui/components/UiIcon.vue';
export {default as SegmentedControl} from '@/src/features/settings/ui/components/SegmentedControl.vue';
