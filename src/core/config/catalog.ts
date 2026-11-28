/**
 * @file src/core/config/catalog.ts
 *
 * 文件职责：作为翻译服务、地域、模型、选项与提示词目录的纯重导出门面，保持全部公开符号兼容并支持按符号精确追踪依赖。
 * 主要内容：转发 ./catalog/services、./catalog/serviceTypes、./catalog/regions、./catalog/models、./catalog/options、./catalog/targetLanguageLabels 与 ./catalog/prompts 的全部运行时与类型符号，涵盖 services、servicesType、options、models、defaultModels、cloudRegionOptions、defaultOption 与 LEGACY_DEFAULT_USER_ROLES。
 * 模块边界：仅包含纯 re-export 语句，不定义本地常量或运行时逻辑；各目录切片的独立依赖与实现分别由 src/core/config/catalog/ 下的子模块承担。
 */

export type {CloudCredentialLabels} from './catalog/services';
export {
    services,
    cloudCredentialLabels,
    getCloudCredentialLabels,
    cloudVendorServices,
    referenceAiPlatformServices,
    customModelString,
    resolveConfiguredModel,
} from './catalog/services';
export {servicesType} from './catalog/serviceTypes';
export type {
    MiniMaxBillingPlan,
    MiniMaxRegion,
    MiMoBillingPlan,
    MiMoRegion,
} from './catalog/regions';
export {
    cloudRegionOptions,
    getDefaultCloudRegion,
    resolveCloudRegion,
    minimaxBillingPlans,
    minimaxRegions,
    mimoBillingPlans,
    mimoRegions,
} from './catalog/regions';
export {
    currentModelIds,
    defaultModelIds,
    models,
    firstConfiguredModel,
    defaultModels,
} from './catalog/models';
export {options} from './catalog/options';
export {
    multilingualTargetLanguageLabels,
    englishTargetLanguageLabels,
    getMultilingualTargetLanguageLabel,
} from './catalog/targetLanguageLabels';
export {LEGACY_DEFAULT_USER_ROLES, defaultOption} from './catalog/prompts';
