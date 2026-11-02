/**
 * @file src/features/document-translation/core/pdfFallbackBidi.ts
 * 文件职责：为 Canvas 已完整绘制的单行段落生成不可见搜索层的视觉字符次序，不改写保存的原文或译文。
 * 主要内容：限定基本 ASCII 与希伯来字母的完整目标身份，验证公开 UBA 排列与锁定阅读器的逐字读回及方向闭合，并在测量或绘制后恢复 Canvas 原方向。
 * 模块边界：只负责受限文本准入与同步绘制方向管理，不解析 PDF、不启动阅读器 worker，也不推断源文件缺失的字符映射。
 * 仅使用 bidi-js 1.1.0 的公开 UBA API（上游 MIT、Unicode 13）；不实现逐词反转或字符镜像替换。
 * 边界：只接受可打印 ASCII 与希伯来基本字母 U+05D0..U+05EA；复杂字素和其他文字仍走旧路径。
 * 重复/边缘/特殊空白与角括号不授能力，防止 reader 的空白合并或字符删除改变旧输出。
 * 仅当规范段落方向与锁定 PDF.js 4.10.38 的读回方向相同才授能力；不声称通用 RTL 或 Unicode 支持。
 * 返回的半 em advance 只描述既有均匀搜索槽，不证明 Canvas 真实字形边界；实际阅读器验收仍独立进行。
 */
import bidiFactory from 'bidi-js';
import {projectPdfReaderBidi} from 'virtual:fluentread-pdfjs-bidi';

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
    // 此精确字符集均为单码元单字素；普通 ASCII 继续走旧资源，不为其构造 UBA 索引。
    if (!/[\u05d0-\u05ea]/u.test(text)) return;
    const bidi = engine ??= bidiFactory();
    const levels = bidi.getEmbeddingLevels(text), paragraphInfo = levels.paragraphs[0];
    if (levels.paragraphs.length !== 1 || !paragraphInfo || paragraphInfo.start !== 0 || paragraphInfo.end !== text.length - 1
        || (paragraphInfo.level !== 0 && paragraphInfo.level !== 1)) return;
    const order = bidi.getReorderedIndices(text, levels);
    if (order.length !== text.length) return;
    const seen = new Set<number>();
    for (const index of order) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= text.length || seen.has(index)) return;
        seen.add(index);
    }
    const indices = Object.freeze([...order]);
    const visualText = indices.map(index => text[index]).join('');
    // 同基方向仍可能以不同方式解析数字/标点；只以锁定 reader 的真实算法逐字闭合授能力。
    const direction = paragraphInfo.level ? 'rtl' : 'ltr', reader = projectPdfReaderBidi(visualText);
    if (!reader || reader.str !== text || reader.dir !== direction) return;
    return Object.freeze({direction,
        visualIndices: indices, visualText, advance: .5});
}

/** 测量与绘制显式共享方向，退出或失败都恢复前一个 Canvas 状态；普通路径无需调用。 */
export function withPdfFallbackBidiDirection<T>(context: {direction: string}, direction: 'ltr' | 'rtl', action: () => T): T {
    const previous = context.direction;
    try {context.direction = direction; return action();}
    finally {context.direction = previous;}
}
