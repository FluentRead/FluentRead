/**
 * @file src/features/full-page-translation/public.ts
 * 文件职责：汇总全文翻译 feature 给其他模块使用的稳定能力，覆盖只读双语摘录、页面翻译控制、局部区域翻译、进度面板生命周期和进度及真实结果状态订阅。
 * 主要内容：精确再导出 autoTranslateEnglishPage、handleTranslation、restoreOriginalContent、活动状态与悬浮取消函数，局部翻译的区域盘点与切换函数，以及进度面板 mount/unmount、进度订阅和工具栏结果类型与订阅。
 * 模块边界：公共出口不暴露 FullPageSession、DOM 状态机或指示器实现；content composition root 与 floating-ball 应依赖此处，内部 renderer/state/background 仍通过各自子路径组装。
 */
export {
    autoTranslateEnglishPage,
    cancelPendingHoverTranslation,
    handleTranslation,
    invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive,
    getFullPageTranslationFrameState,
    readFullPageUnchangedCompletion,
    resetFullPageTranslationRouteState,
    restoreOriginalContent,
    type PageTranslationInvocation,
} from './content/runtime';
export {beginBilingualArtifactHostWriteGesture as noteBilingualHostGesture} from './content/state';
export {
    inspectTranslationSection,
    toggleTranslationSection,
    type TranslationSectionAction,
    type TranslationSectionResult,
    type TranslationSectionSummary,
} from './content/sectionTranslation';
export {
    mountTranslationProgressPanel,
    unmountTranslationProgressPanel,
} from './content/progressPanel';
export {
    subscribeFullPageTranslationProgress,
} from './progress';

export {getTranslationToolbarStatus, subscribeTranslationToolbarStatus} from './content/stateNotification';
export type {TranslationToolbarStatus} from './toolbarStatus';

export {readBilingualExcerpt} from './content/excerpt';
export {readVisibleTranslationRoot} from './content/public';
