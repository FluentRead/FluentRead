/**
 * @file src/features/document-translation/ui/readers/shared.ts
 *
 * 文件职责：为文档翻译多格式阅读器子模块提供共用的分页边界数值归一化辅助函数。
 * 主要内容：导出 clampPositiveInt，确保页码与每页条数在 NaN、Infinity 或非正数输入下稳定回退到合法正整数。
 * 模块边界：仅包含无副作用的纯数值工具函数，供 delimitedReader、docxReader、jsonReader 与 subtitleReader 共享。
 */

export function clampPositiveInt(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}
