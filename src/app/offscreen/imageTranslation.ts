/**
 * @file src/app/offscreen/imageTranslation.ts
 * 文件职责：汇总 Offscreen Document 中图片读取、OCR、图片重绘以及圈选裁剪识别所需的能力，供 offscreen runtime 通过单一 app 路径装配。
 * 主要内容：重导出远程图片读取、OCR 语言包下载、清除与 Worker 释放、整图翻译、圈选区域裁剪与识别函数，以及本地推理诊断读取端口。
 * 模块边界：该 barrel 不监听 runtime 消息、不探测浏览器 capability，也不持有 Worker；图片读取、OCR 和绘制实现由 image-translation feature services 所有，路由在 messageRouter。
 */
export {
    fetchImageInOffscreen,
} from '@/src/features/image-translation/services/remoteImage';
export {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    disposeImageOcrWorker,
} from '@/src/features/image-translation/services/ocrRuntime';
export {
    cropAreaInOffscreen,
    translateAreaInOffscreen,
    translateImageInOffscreen,
} from '@/src/features/image-translation/services/offscreenRuntime';
export {mangaOcrModelStatus} from '@/src/features/image-translation/services/mangaOcrAssets';
export {mangaInferenceClient} from '@/src/features/image-translation/services/mangaInferenceClient';
export {removeMangaModels,disposeMangaModels} from '@/src/features/image-translation/services/mangaOcr';
