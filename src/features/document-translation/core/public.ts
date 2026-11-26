/**
 * @file src/features/document-translation/core/public.ts
 * 文件职责：向后台与跨功能调用方公开纯文档 URL 规范化契约，避免拉入 PDF 阅读器、Vue、PDF.js 或归档依赖图。
 * 主要内容：转发 pdfSource 中的纯 URL 与阅读器链接辅助函数。
 * 模块边界：只导出 core 纯函数，不依赖 Vue、DOM、WXT、PDF.js 或二进制编解码模块。
 */

export {createPdfReaderUrl, getPdfSourceUrl, normalizeOnlinePdfUrl} from './pdfSource';
