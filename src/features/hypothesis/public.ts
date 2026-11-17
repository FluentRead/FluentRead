/**
 * @file src/features/hypothesis/public.ts
 * 文件职责：公开当前页面官方协作批注的一键开关与受限本地注入契约。
 * 主要内容：导出文档私有客户端、扩展页面静态脚本加载、后台来源门禁与选区工具栏避让。
 * 模块边界：应用负责绑定浏览器端口，PDF 阅读器负责文档适配，账户和服务数据始终归官方来源。
 */
export {createHypothesisClient, injectHypothesisDocumentScript, type HypothesisResult} from './client';
export {createHypothesisInjectionHandler} from './injection';
export {hypothesisSelectionAnchor} from './selection';
