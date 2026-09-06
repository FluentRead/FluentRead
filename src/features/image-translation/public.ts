/**
 * @file src/features/image-translation/public.ts
 * 文件职责：汇总图片翻译 feature 的对外契约，供 content 注册、设置页面和区域翻译适配器获取各自所需的最小稳定能力。
 * 主要内容：再导出图片翻译 mount/unmount 和右键目标切换、OCR 语言包准备、常量与规范化、Offscreen 译图结果类型，以及 ImageOcrSettings Vue 组件。
 * 模块边界：公共入口不暴露后台 handler、Tesseract worker 或 Canvas 修补细节；应用层据浏览器 capability 选择性使用，区域翻译只依赖共享结果类型而不反向控制图片 UI。
 */
export {
    toggleContextMenuImage,
    mountImageTranslator,
    unmountImageTranslator,
} from './content';
export {
    IMAGE_OCR_LANGUAGE_PACKS,
    IMAGE_OCR_LANGUAGE_STATE_KEY,
    IMAGE_OCR_RECOMMENDED_LANGUAGES,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from './ocrLanguages';
export type {
    OffscreenImageTranslationLine,
    OffscreenImageTranslationResult,
} from './services/offscreenRuntime';
export {default as ImageOcrSettings} from './ui/ImageOcrSettings.vue';
export {prepareImageOcrLanguages} from './services/client';
