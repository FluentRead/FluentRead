/**
 * @file src/features/document-translation/core/pdfFallbackBidi.ts
 * 文件职责：为已完整绘制的单行段落生成不可见搜索层的视觉字符次序；不改写保存的原文或译文。
 * 仅使用 bidi-js 1.1.0 的公开 UBA API（上游 MIT、Unicode 13）；不实现逐词反转或字符镜像替换。
 * 边界：只接受 BMP 单码元单字素与普通单空格；复杂字素、多行、重复/边缘空白仍走旧路径。
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
    if (!text || text !== paragraph || text.length > 8192 || !/[^\x00-\x7f]/u.test(text)
        || /^ | $| {2}|[^\S ]/u.test(text) || /[\p{M}\p{Cf}\p{Cc}]/u.test(text)) return;
    // 公共 API 的索引是 UTF-16；本原型拒绝任何需跨码元/跨字符归属的字素，而不猜测其位置。
    if (Array.from(text).some(character => character.length !== 1 || /[\uD800-\uDFFF]/u.test(character))
        || typeof Intl.Segmenter !== 'function') return;
    if (Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)).some(item => item.segment.length !== 1)) return;
    const bidi = engine ??= bidiFactory();
    if (!Array.from(text).some(character => /^(?:R|AL|AN)$/u.test(bidi.getBidiCharTypeName(character)))) return;
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
    return Object.freeze({direction: paragraphInfo.level ? 'rtl' : 'ltr',
        visualIndices: indices, visualText: indices.map(index => text[index]).join(''), advance: .5});
}

/** 测量与绘制显式共享方向，退出或失败都恢复前一个 Canvas 状态；普通路径无需调用。 */
export function withPdfFallbackBidiDirection<T>(context: {direction: string}, direction: 'ltr' | 'rtl', action: () => T): T {
    const previous = context.direction;
    try {context.direction = direction; return action();}
    finally {context.direction = previous;}
}
