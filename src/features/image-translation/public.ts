/**
 * @file src/features/image-translation/public.ts
 * 文件职责：汇总图片翻译 feature 的网页运行契约，供 content 注册和区域翻译适配器获取最小稳定能力。
 * 主要内容：再导出图片翻译 mount/unmount 和右键目标切换、漫画连续翻译动作与状态订阅、OCR 语言包准备函数；语言包常量由 ocrLanguages 直接提供，设置组件由 ui/public.ts 单独公开。
 * 模块边界：此入口不引入设置组件及其样式，不暴露后台 handler、Tesseract worker 或 Canvas 修补细节；应用层据浏览器 capability 选择性使用，区域翻译只依赖共享结果类型而不反向控制图片 UI。
 */
export {
    toggleMangaTranslation,
    subscribeMangaTranslation,
    toggleContextMenuImage,
    mountImageTranslator,
    unmountImageTranslator,
    getMangaReadingCandidates,
    readMangaReadingCandidate,
    observeMangaReadingCandidate,
    registerMangaReadingOverlayHost,
} from './content';
export type {MangaTranslationStatus} from './content/mangaSession';
export {prepareImageOcrLanguages} from './services/client';
export {isImageTranslatorNeeded, isMangaReaderPage, mountMangaEntry, unmountMangaEntry, openMangaEntry, openMangaReading, subscribeMangaReading} from './content/mangaEntry';
