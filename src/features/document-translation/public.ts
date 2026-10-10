/**
 * @file src/features/document-translation/public.ts
 * 文件职责：汇总文档翻译 feature 的稳定公共 API，供文档页面一次性取得格式模型、预览、二进制读写、分段翻译和展示辅助能力。
 * 主要内容：再导出 document 与 preview 纯函数、文件解析入口、translation 网关、PDF 页面预览及资源释放、可取消归档编码、文档历史与按原文恢复译文的迁移函数，presentation 中的格式标签和阅读器辅助函数，富文本预览的原位同步、共用文档缩放手势，以及扫描版 PDF 的逐页识别。
 * 模块边界：本文件不执行解析或翻译，也不暴露内部实现私有函数；调用方应通过这些公共契约注入翻译和 PDF rasterizer，避免绕过 services 层直接耦合 JSZip、pdf-lib 或 pdfjs。
 */
import {defineAsyncComponent} from 'vue';

export * from './core/document';
export * from './core/pdfSource';
export type {PdfReadingPresentation} from './core/pdfReadingPlan';
export {fetchOnlinePdf} from './services/pdfSource';
// 解析与导出公共 API 可独立使用；进入 PDF 阅读界面时才加载 Vue 组件及扩展配置。
export const PdfReader = defineAsyncComponent(() => import('./ui/PdfReader.vue').then(module => module.default));
export * from './core/preview';
export {
    parseDocumentFile,
} from './services/binary';
export type {PdfExportProgress} from './services/binary';
export * from './services/translation';
export {generateDocumentArchive} from './services/archive';
export * from './services/history';
export * from './services/pdfOcr';
export {
    createPdfPagePreview,
    releasePdfDocument,
} from './ui/pdfPreview';
export * from './ui/presentation';
export * from './ui/richPreviewSync';
export {installDocumentZoomGestures} from './ui/documentZoom';
export type {DocumentZoomOptions, DocumentZoomPoint} from './ui/documentZoom';
