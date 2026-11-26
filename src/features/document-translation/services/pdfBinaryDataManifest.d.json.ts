/**
 * @file src/features/document-translation/services/pdfBinaryDataManifest.d.json.ts
 * 文件职责：为 PDF.js 固定版本 CMap 与标准字体校验清单提供轻量静态类型声明，避免 TypeScript 推断 182 项字面量导致内存膨胀。
 * 主要内容：声明 pdfBinaryDataManifest.json 的版本号、cmaps 与 standard_fonts 字典条目结构（精确字节数与 SHA-256 摘要）。
 * 模块边界：仅作为编译期类型声明服务于 pdfBinaryDataFactory.ts，不生成任何运行时代码。
 */
declare const manifest: {
    readonly version: string;
    readonly cmaps: Readonly<Record<string, {readonly bytes: number; readonly sha256: string}>>;
    readonly standard_fonts: Readonly<Record<string, {readonly bytes: number; readonly sha256: string}>>;
};
export default manifest;
