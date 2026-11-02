/**
 * @file src/features/document-translation/core/pdfFallbackBidi.ts
 * 文件职责：为已完整绘制的单行段落生成不可见搜索层的视觉字符次序；不改写保存的原文或译文。
 * 仅使用 bidi-js 1.1.0 的公开 UBA API（上游 MIT、Unicode 13）；不实现逐词反转或字符镜像替换。
 * 边界：只接受可打印 ASCII 与希伯来基本字母 U+05D0..U+05EA；复杂字素和其他文字仍走旧路径。
 * 重复/边缘/特殊空白与角括号不授能力，防止 reader 的空白合并或字符删除改变旧输出。
 * 仅当规范段落方向与锁定 PDF.js 4.10.38 的读回方向相同才授能力；不声称通用 RTL 或 Unicode 支持。
 * 返回的半 em advance 只描述既有均匀搜索槽，不证明 Canvas 真实字形边界；实际阅读器验收仍独立进行。
 */
import bidiFactory from 'bidi-js';

export interface PdfFallbackBidiLine {
    readonly direction: 'ltr' | 'rtl';
    readonly visualText: string;
    readonly visualIndices: readonly number[];
    readonly advance: .5;
}
let engine: ReturnType<typeof bidiFactory> | undefined;

export function pdfFallbackBidiLine(text: string, paragraph: string): PdfFallbackBidiLine | undefined {
    if (!text || text !== paragraph || text.length > 8192 || /[^\x20-\x7e\u05d0-\u05ea]/u.test(text)
        || /[<>]|^ | $| {2}/u.test(text)) return;
    // 此字符集均为单码元单字素。锁定 reader 将基本希伯来字母全部归 R，其余 ASCII 分类已定义。
    // 它按 R 占比而不是 first-strong 选基方向；拒绝不一致情形，绝不自行反转单词。
    const hebrewCount = text.match(/[\u05d0-\u05ea]/gu)?.length ?? 0;
    if (!hebrewCount) return;
    const readerLevel = hebrewCount / text.length < .3 && text.length > 4 ? 0 : 1;
    const bidi = engine ??= bidiFactory();
    const levels = bidi.getEmbeddingLevels(text), paragraphInfo = levels.paragraphs[0];
    if (levels.paragraphs.length !== 1 || !paragraphInfo || paragraphInfo.start !== 0 || paragraphInfo.end !== text.length - 1
        || (paragraphInfo.level !== 0 && paragraphInfo.level !== 1)) return;
    if (paragraphInfo.level !== readerLevel) return;
    const order = bidi.getReorderedIndices(text, levels);
    if (order.length !== text.length) return;
    const seen = new Set<number>();
    for (const index of order) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= text.length || seen.has(index)) return;
        seen.add(index);
    }
    const indices = Object.freeze([...order]);
    return Object.freeze({direction: paragraphInfo.level ? 'rtl' : 'ltr',
        visualIndices: indices, visualText: indices.map(index => text[index]).join(''), advance: .5});
}

/** 测量与绘制显式共享方向，退出或失败都恢复前一个 Canvas 状态；普通路径无需调用。 */
export function withPdfFallbackBidiDirection<T>(context: {direction: string}, direction: 'ltr' | 'rtl', action: () => T): T {
    const previous = context.direction;
    try {context.direction = direction; return action();}
    finally {context.direction = previous;}
}
