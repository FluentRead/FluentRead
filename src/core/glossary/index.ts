/**
 * @file src/core/glossary/index.ts
 * 文件职责：提供术语库领域层的稳定公共接口，使配置、翻译编排和设置界面共享相同的契约。
 * 主要内容：导出库与条目类型、配置归一化、版本标识、范围匹配与匹配上下文类型，以及导入解析和可回导的导出格式。
 * 模块边界：仅汇总同目录纯模块，不依赖浏览器 API、Vue、存储和翻译供应商；内部解析辅助函数不向上层公开。
 */
export {GLOSSARY_LIMITS, createGlossaryEntry, createGlossaryLibrary, normalizeGlossaryLibraries,
    normalizeGlossaryDomain, normalizeGlossaryIds, buildGlossaryRevision} from './model';
export type {GlossaryLibrary, GlossaryEntry} from './model';
export {resolveGlossary, resolveGlossaryEntries, getGlossaryScopeReason, glossarySourcesOverlap} from './match';
export type {GlossaryContext} from './match';
export {decodeGlossaryText, parseGlossaryImport, exportGlossary} from './transfer';
export type {GlossaryImportFormat} from './transfer';
export {protectGlossaryText, validateGlossaryProtectedTokens, GlossaryPlaceholderError} from './protection';
