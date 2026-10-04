/**
 * @file src/features/document-translation/public.ts
 * 文件职责：汇总文档翻译 feature 的稳定公共 API，供文档页面一次性取得格式模型、预览、二进制读写、分段翻译和展示辅助能力。
 * 主要内容：再导出 document 与 preview 纯函数、文件解析入口、translation 网关、PDF 页面预览与可取消归档编码，以及 presentation 中的格式标签和阅读器辅助函数。
 * 模块边界：本文件不执行解析或翻译，也不暴露内部实现私有函数；调用方应通过这些公共契约注入翻译和 PDF rasterizer，避免绕过 services 层直接耦合 JSZip、pdf-lib 或 pdfjs。
 */
export * from './core/document';
export * from './core/preview';
export {
    parseDocumentFile,
} from './services/binary';
export * from './services/translation';
export {generateDocumentArchive} from './services/archive';
export {
    createPdfPagePreview,
} from './ui/pdfPreview';
export * from './ui/presentation';
