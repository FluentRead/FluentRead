/**
 * @file src/features/hypothesis/public.ts
 * 文件职责：公开 PDF 阅读器协作批注客户端和划词工具栏的位置辅助。
 * 主要内容：导出文档私有客户端、扩展页面静态脚本加载与选区避让。
 * 模块边界：PDF 阅读器负责文档适配，账户和服务数据由官方侧栏处理。
 */
export {createHypothesisClient, injectHypothesisDocumentScript, type HypothesisResult} from './client';
export {hypothesisSelectionAnchor} from './selection';
