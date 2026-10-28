/**
 * @file src/features/full-page-translation/public.ts
 * 文件职责：汇总全文翻译 feature 给其他模块使用的稳定能力，覆盖只读双语摘录、页面翻译控制、局部区域翻译和进度及真实结果状态订阅。
 * 主要内容：公开不请求 provider 的当前页面显示模式同步入口；精确再导出 autoTranslateEnglishPage、handleTranslation、restoreOriginalContent、活动状态与悬浮取消函数，局部翻译的区域盘点、切换与自动补齐函数，以及进度面板生命周期、结果状态订阅和个人校订的受控原译文读取、受影响预览与可逆更新端口。
 * 模块边界：公共出口不暴露 FullPageSession、DOM 状态机或指示器实现，不静态引入 Vue 面板；进度面板生命周期由 ui/public 单独提供。content composition root 与 floating-ball 应依赖对应公开契约，内部 renderer/state/background 仍通过各自子路径组装。
 */
export {
    autoTranslateEnglishPage,
    cancelPendingHoverTranslation,
    handleTranslation,
    invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive,
    getFullPageTranslationFrameState,
    getFullPageTranslationSessionId,
    readFullPageUnchangedCompletion,
    resetFullPageTranslationRouteState,
    restoreOriginalContent,
    type PageTranslationInvocation,
} from './content/runtime';
export {beginBilingualArtifactHostWriteGesture as noteBilingualHostGesture} from './content/state';
export {syncPageTranslationDisplayMode, createPageTranslationDisplayModeSync} from './content/displayMode';
export {
    inspectTranslationSection,
    toggleTranslationSection,
    ensureTranslationSection,
    type TranslationSectionAction,
    type TranslationSectionResult,
    type TranslationSectionSummary,
} from './content/sectionTranslation';
export {
    subscribeFullPageTranslationProgress,
} from './progress';

export {getTranslationToolbarStatus, subscribeTranslationToolbarStatus, getFullPageTranslationDiagnostic, getFullPageTranslationDocumentToken} from './content/stateNotification';
export type {TranslationToolbarStatus} from './toolbarStatus';

export {readBilingualExcerpt} from './content/excerpt';
export {readVisibleTranslationRoot} from './content/public';
export {readPersonalCorrectionPair, listVisiblePersonalCorrectionPairs, refreshVisiblePersonalCorrections, watchPersonalCorrectionContext, disableVisiblePersonalCorrections} from './content/personalCorrections';
export type {PersonalCorrectionPair} from './content/personalCorrections';
