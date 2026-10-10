/**
 * @file src/features/document-translation/core/pdfBlockFit.ts
 * 文件职责：为“原版排版”阅读把一段译文放回原文段落所占的矩形，决定哪些段落可以原位替换、可用高度和最终字号与分行。
 * 主要内容：筛选可原位替换的正文块并排除版面分析标记为保留的公式、图内标签、数字表格单元格与页眉页脚，含词语的表格单元格可以替换；量出段落下方到相邻内容之间的空白；从原字号开始按面积比例收缩，直到译文按行距排入可用高度或达到最小可读字号，超出时如实标记溢出而不裁掉文字。
 * 模块边界：纯几何与文字分行，不创建 DOM 或 Canvas、不读取像素、不调用翻译；字宽测量由调用方注入，页面旋转由展示层处理。
 */
import type {PdfDocumentBlock, PdfDocumentPage} from './document';
import {wrapPdfReadingText} from './pdfTextLayout';

export interface PdfOverlayBlock {
    block: PdfDocumentBlock;
    /** 段落下方可以借用的空白（PDF 点），不含与相邻内容之间保留的一点间隙。 */
    spaceBelow: number;
    /** 单行标题右侧到相邻内容或对称页边距之间的空白（PDF 点）。 */
    spaceRight: number;
}
export interface PdfBlockFitInput {
    text: string;
    width: number;
    height: number;
    fontSize: number;
    /** 原文行距；单行块没有行距时传入字号即可。 */
    lineHeight: number;
    minFontSize: number;
    weight: 400 | 600 | 700;
}
export interface PdfBlockFit {fontSize: number; lineHeight: number; lines: string[]; overflow: boolean}
export type PdfBlockMeasure = (text: string, fontSize: number, weight: 400 | 600 | 700) => number;

const PROTECTED_KINDS = new Set(['formula', 'figure-label', 'metadata', 'footer']);
const right = (box: {x: number; width: number}) => box.x + box.width;
const bottom = (box: {y: number; height: number}) => box.y + box.height;

/** 与导出时的原位绘制使用同一取舍：受保护内容保留原页像素，其余正文块才会被译文替换。 */
export function pdfOverlayBlocks(page: PdfDocumentPage): PdfOverlayBlock[] {
    // 图内标签、公式与数字单元格已由版面分析标记；图形包围盒常比可见图形大，不再按重叠面积排除正文。
    const regions = page.preservedRegions ?? [];
    const neighbours = [...page.blocks, ...regions, ...(page.layoutBoundaries ?? [])];
    const quarterTurn = page.rotation === 90 || page.rotation === 270;
    const contentHeight = quarterTurn ? page.width : page.height;
    const contentWidth = quarterTurn ? page.height : page.width;
    return page.blocks.flatMap(sourceBlock => {
        if (sourceBlock.preserveSource || PROTECTED_KINDS.has(sourceBlock.kind ?? '') || !(sourceBlock.width > 0) || !(sourceBlock.height > 0)) return [];
        // 段落末行旁的 QED/式号可能落在该段的外接矩形里；让出右侧这一小条，不能将译文排到保留符号上。
        const rightInset = page.blocks.reduce((edge, other) => {
            const protectedSource = other.preserveSource || PROTECTED_KINDS.has(other.kind ?? '');
            return other !== sourceBlock && protectedSource && other.y < bottom(sourceBlock) && bottom(other) > sourceBlock.y
                && other.x > sourceBlock.x + sourceBlock.width * 0.75 && other.x < right(sourceBlock) && right(other) >= right(sourceBlock) - sourceBlock.fontSize * 2
                ? Math.min(edge, other.x - 1.5) : edge;
        }, right(sourceBlock));
        const block = rightInset < right(sourceBlock) ? {...sourceBlock, width: Math.max(1, rightInset - sourceBlock.x)} : sourceBlock;
        let limit = contentHeight, edge = Math.max(right(block), contentWidth - Math.max(0, block.x));
        for (const other of neighbours) {
            if (other === sourceBlock) continue;
            if (other.y >= bottom(block) - 1 && other.x < right(block) && right(other) > block.x) limit = Math.min(limit, other.y);
            if (other.x >= right(block) - 1 && other.y < bottom(block) && bottom(other) > block.y) edge = Math.min(edge, other.x);
        }
        // 居中/右对齐文字扩宽会移动它的对齐锚点；延长一行的右边界也不能侵入下方错开的另一栏。
        const spaceRight = block.lineCount <= 1 && block.textAlign === 'left' ? Math.max(0, edge - right(block) - 6) : 0;
        for (const other of neighbours) {
            if (other === sourceBlock) continue;
            if (other.y >= bottom(block) - 1 && other.x < right(block) + spaceRight && right(other) > block.x) limit = Math.min(limit, other.y);
        }
        return [{block, spaceBelow: Math.max(0, limit - bottom(block) - 1.5), spaceRight}];
    });
}

/**
 * 字号只在放不下时收缩；每一步按“需要高度 / 可用高度”的平方根估计，通常两三步收敛。
 * 行距沿用原文的行距比例，并限制在适合中日韩文字阅读的范围内；字号缩到原来的四分之三以下后行距收紧到 1.12 倍。
 */
export function fitPdfBlockText(input: PdfBlockFitInput, measure: PdfBlockMeasure): PdfBlockFit {
    const positive = (value: number, fallback: number) => Number.isFinite(value) ? Math.max(1, value) : fallback;
    const width = positive(input.width, 1);
    const height = Number.isFinite(input.height) ? Math.max(0, input.height) : 0;
    const start = positive(input.fontSize, 12);
    const floor = Math.min(start, positive(input.minFontSize, 6));
    const ratio = Math.min(1.6, Math.max(1.25, positive(input.lineHeight, start) / start));
    let fontSize = start;
    for (let step = 0; ; step += 1) {
        // 字号已经明显缩小时收紧行距：原本一行高的位置可以排下两行小字，译文比原文长一倍的单行条目不必被截断。
        const lineHeight = fontSize * (fontSize < start * 0.75 ? Math.min(ratio, 1.12) : ratio);
        const lines = wrapPdfReadingText(input.text, width, {size: fontSize, weight: input.weight, lineHeight}, (text, font) => measure(text, font.size, font.weight));
        const needed = lines.length * lineHeight;
        // 末行下方本就没有行间空白，允许超出四分之一行而不缩小字号。
        const widest = lines.reduce((max, line) => {
            const measured = measure(line, fontSize, input.weight);
            return Math.max(max, Number.isFinite(measured) ? measured : Infinity);
        }, 0);
        const fits = needed <= height + lineHeight * 0.25 && widest <= width;
        if (fits || fontSize <= floor || step >= 12) return {fontSize, lineHeight, lines, overflow: !fits};
        fontSize = Math.max(floor, fontSize * Math.min(0.97, Math.max(0.8, Math.min(Math.sqrt(height / needed), width / widest))));
    }
}
