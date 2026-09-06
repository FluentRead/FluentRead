/**
 * @file src/app/document-translation/index.ts
 * 文件职责：汇总文档翻译页面所需的公开业务、配置和运行时能力，形成 DocumentApp 唯一的 app 层依赖入口。
 * 主要内容：转发文档解析/格式/预览 API、Config 与凭据校验、服务模型目录、配置读取、字段级保存与实时订阅、分段翻译、下载生成以及平台能力过滤与不可用提示。
 * 模块边界：该文件只整理稳定公开面，不执行页面挂载、不持有配置副本，也不暴露 document feature 内部实现；实际适配在 runtime，UI 状态在 DocumentApp。
 */
export * from '@/src/features/document-translation/public';
export {buildGlossaryRevision} from '@/src/core/glossary';
export {Config} from '@/src/core/config/model';
export {getMissingCredentialMessage} from '@/src/core/config/validation';
export {
    customModelString,
    getMultilingualTargetLanguageLabel,
    models,
    options,
    resolveConfiguredModel,
    servicesType,
} from '@/src/core/config/catalog';
export {
    getCustomOpenAIProvider,
    withCustomOpenAIServiceOptions,
} from '@/src/core/config/customOpenAI';
export {
    config as runtimeConfig,
    configReady,
    requestConfigPatch,
    subscribeConfig,
} from '@/src/services/config/store';
export {createDocumentDownload, translateDocumentSegments} from './runtime';
export {createUiI18nPlugin, useUiI18n} from '@/src/ui/i18n';
export {default as GlossaryLibrarySelect} from '@/src/ui/components/GlossaryLibrarySelect.vue';
export {
    filterAvailableTranslationServices,
    getTranslationServiceUnavailableMessage,
    supportsTranslationGlossary,
} from '@/src/services/translation/capabilities';

export {default as ElSelect} from '@/src/ui/components/UiSelect.vue';
