/**
 * @file src/app/offscreen/imageTranslation.ts
 * 文件职责：汇总 Offscreen Document 中图片读取、OCR、图片重绘以及圈选裁剪识别所需的能力，供 offscreen runtime 通过单一 app 路径装配。
 * 主要内容：重导出远程图片读取、OCR 语言包下载、图片识别、整图翻译、圈选区域裁剪与识别函数，以及 Offscreen 图片翻译行和结果类型。
 * 模块边界：该 barrel 不监听 runtime 消息、不探测浏览器 capability，也不持有 Worker；图片读取、OCR 和绘制实现由 image-translation feature services 所有，路由在 messageRouter。
 */
export {
    fetchImageInOffscreen,
} from '@/src/features/image-translation/services/remoteImage';
export {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    recognizeImage,
} from '@/src/features/image-translation/services/ocrRuntime';
export {
    translateAreaInOffscreen,
    translateImageInOffscreen,
    type OffscreenImageTranslationLine,
    type OffscreenImageTranslationResult,
} from '@/src/features/image-translation/services/offscreenRuntime';
