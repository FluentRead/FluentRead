/**
 * @file src/app/content/features.ts
 * 文件职责：定义 content composition root 可使用的 feature 公共面，集中汇总页面翻译、悬浮球、划词、区域、图片、输入框和视频字幕能力。
 * 主要内容：重导出各 feature 的 mount/unmount、状态查询、全文翻译控制、选择文本规范化与输入框配置键，让 runtime 只依赖经过审核的 public 契约。
 * 模块边界：该 barrel 不创建实例、不执行翻译，也不越过 public.ts 读取 feature 内部实现；能力装配和生命周期在 content/runtime，业务逻辑归各 src/features 子模块。
 */
export {
    cancelPendingHoverTranslation,
    handleTranslation,
    autoTranslateEnglishPage,
    invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive,
    noteBilingualHostGesture,
    resetFullPageTranslationRouteState,
    restoreOriginalContent,
} from '@/src/features/full-page-translation/public';
export {
    mountTranslationProgressPanel,
    unmountTranslationProgressPanel,
} from '@/src/features/full-page-translation/public';
export {
    mountFloatingBall,
    toggleFloatingBallTranslation,
    unmountFloatingBall,
} from '@/src/features/floating-ball/public';
export {
    isSupportedVideoPage,
    mountVideoSubtitleTranslation,
} from '@/src/features/video-subtitle/public';
export {
    createInputTranslationContentFeature,
    inputBoxTranslationConfigKey,
} from '@/src/features/input-translation/public';
export { mountHoverTranslationContentFeature } from '@/src/features/hover-translation/public';
export { mountQuickTranslationContentFeature } from '@/src/features/quick-translation/public';
export {
    mountSelectionTranslator,
    unmountSelectionTranslator,
} from '@/src/features/selection-translation/public';
export {
    isAreaTranslatorMounted,
    mountAreaTranslator,
    unmountAreaTranslator,
} from '@/src/features/area-translation/public';
export {
    toggleContextMenuImage,
    mountImageTranslator,
    unmountImageTranslator,
} from '@/src/features/image-translation/public';
export {
    isSameLanguage,
    normalizeSelectionText,
    shouldIgnoreSelection,
} from '@/src/features/selection-translation/public';
