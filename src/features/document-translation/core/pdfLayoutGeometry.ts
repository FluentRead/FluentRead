/**
 * @file src/features/document-translation/core/pdfLayoutGeometry.ts
 *
 * 文件职责：封装 PDF 版面分析共用的几何矩形运算、变换矩阵提取、字形拼接及中日韩/英文可读文本分类辅助函数。
 * 主要内容：导出 PdfLayoutAtom、PdfGraphicsShape、PdfGraphicsOperators、PdfLayoutBlock、LayoutLine 类型，extractPdfGraphicsShapes 图形算子解析，joinPdfSourceLines 行拼接，以及矩形合并、覆盖与文本可读性判定工具。
 * 模块边界：无浏览器依赖的纯几何与文本规则模块，供 pdfLineGrouping、pdfRegionsAndMath 与 pdfLayoutAnalysis 共享，不加载 PDF.js 或触碰 DOM。
 */

import type {PdfDocumentBlock, PdfDocumentLine, PdfDocumentRun} from './document';

export type Rectangle = Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>;
export type Matrix = readonly number[];

export interface PdfLayoutAtom extends PdfDocumentRun {
    fontSize: number;
    baseline: number;
    fontFamily: string;
    layoutFontSize?: number;
}

export interface PdfGraphicsShape extends Rectangle {
    kind: 'image' | 'form' | 'path';
}

export interface PdfGraphicsOperators {
    fnArray: readonly number[];
    argsArray: readonly unknown[];
}

export interface PdfLayoutBlock extends Omit<PdfDocumentBlock, 'segmentIndex'> {
    source: string;
}

export interface LayoutLine extends PdfDocumentLine {
    baseline: number;
    fontSize: number;
    fontFamily: string;
    runs: PdfLayoutAtom[];
}

const identity = [1, 0, 0, 1, 0, 0];
export const largeOperator = /^[∫∬∭∮∯∰∑∏⋃⋂]$/u;

export const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 10;
};

export const right = (box: Rectangle) => box.x + box.width;
export const bottom = (box: Rectangle) => box.y + box.height;

export const union = (a: Rectangle, b: Rectangle): Rectangle => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y};
};

export const overlaps = (a: Rectangle, b: Rectangle, padding = 0) =>
    a.x <= right(b) + padding && right(a) + padding >= b.x
    && a.y <= bottom(b) + padding && bottom(a) + padding >= b.y;

const multiply = (a: Matrix, b: Matrix): number[] => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
];

function transformedBox(matrix: Matrix, bounds: Matrix): Rectangle {
    const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]]
        .map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}

function clipped(box: Rectangle, width: number, height: number): Rectangle | undefined {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const result = {x, y, width: Math.min(width, right(box)) - x, height: Math.min(height, bottom(box)) - y};
    return result.width >= 0 && result.height >= 0 ? result : undefined;
}

/** PDF.js 的 constructPath 已附带控制点包围盒；clip/endPath 本身不是可见图形。 */
export function extractPdfGraphicsShapes(
    list: PdfGraphicsOperators,
    ops: Record<string, number>,
    viewport: {width: number; height: number; transform: Matrix},
): PdfGraphicsShape[] {
    let matrix = [...identity];
    const stack: number[][] = [];
    let path: Rectangle | undefined;
    const shapes: PdfGraphicsShape[] = [];
    const add = (kind: PdfGraphicsShape['kind'], box: Rectangle) => {
        const valid = clipped(box, viewport.width, viewport.height);
        if (valid && (valid.width > 0 || valid.height > 0)) shapes.push({...valid, kind});
    };
    const boxFor = (bounds: Matrix) => transformedBox(multiply(viewport.transform, matrix), bounds);
    const paintsPath = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
    for (let index = 0; index < list.fnArray.length; index += 1) {
        const fn = list.fnArray[index];
        const args = list.argsArray[index] as any[] | null;
        if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
            stack.push([...matrix]);
            if (fn === ops.paintFormXObjectBegin && args) {
                if (args[0]) matrix = multiply(matrix, args[0]);
                if (args[1]) add('form', boxFor(args[1]));
            }
        } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
            matrix = stack.pop() || [...identity];
        } else if (fn === ops.transform && args) {
            matrix = multiply(matrix, args);
        } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
            add('image', boxFor([0, 0, 1, 1]));
        } else if (fn === ops.constructPath && args) {
            // PDF.js 6 combines construction and painting; older operator fixtures keep them separate.
            if (typeof args[0] === 'number') {
                if (args[2] && paintsPath.has(args[0])) add('path', boxFor(args[2]));
            } else if (args[2]) {
                const next = boxFor(args[2]);
                path = path ? union(path, next) : next;
            }
        } else if (paintsPath.has(fn)) {
            if (path) add('path', path);
            path = undefined;
        } else if (fn === ops.endPath) {
            path = undefined;
        }
    }
    return shapes;
}

export function joinRuns(runs: readonly PdfLayoutAtom[]): string {
    let text = '';
    let end = -Infinity;
    for (const run of runs) {
        const gap = run.x - end;
        if (text && gap > Math.max(1.1, run.fontSize * 0.1) && !/[\s\-–—/]$/u.test(text) && !/^[,.;:!?，。；：！？)\]}]/u.test(run.text)) {
            text += ' ';
        }
        text += run.text;
        end = Math.max(end, right(run));
    }
    return text.replace(/\s+/gu, ' ').trim();
}

export const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
export const cjkGlyphs = new RegExp(`[${CJK}]`, 'gu');
export const cjkGlyph = new RegExp(`[${CJK}]`, 'u');
/** 以中日韩文字为主的一行：这些文字占去非空白字符的一半以上。 */
export const cjkLine = (text: string) => (text.match(cjkGlyphs)?.length ?? 0) * 2 >= text.replace(/\s/gu, '').length;
/** 上一行以中日韩文字或全角标点结尾、下一行以它们开头时，折行处不应补空格。 */
export const cjkLineEnd = new RegExp(`[${CJK}，。、；：！？（）《》“”]$`, 'u');
export const cjkLineStart = new RegExp(`^[${CJK}，。、；：！？（）《》“”]`, 'u');

/** 复用已确认同属一块的逐行原文拼接规则；人工 OCR 校对与首次解析使用同一文字契约。 */
export function joinPdfSourceLines(lines: readonly PdfDocumentLine[], kind?: PdfDocumentBlock['kind']): string {
    if (!lines.length) return '';
    const joined = lines.reduce((text, line, index) => {
        if (!text) return line.text;
        // 段落/分栏关联已确认两行同属一块；只有 URL 尾斜杠和带数字的路径首词共同确认续行，后续正文空白不变。
        const path = line.text.match(/^[A-Za-z0-9._~%/?#&=+-]+(?=\s|$)/u)?.[0];
        if (/(?:^|[\s(["'])https?:\/\/[^\s<>"'`，。、；：！？（）【】《》「」“”‘’]+\/$/u.test(lines[index - 1].text)
            && path?.includes('/') && /\d/u.test(path)) return text + line.text;
        return /[-‐‑\u00AD]$/u.test(text) && /^[a-z]/u.test(line.text) ? text.slice(0, -1) + line.text
            : cjkLineEnd.test(text) && cjkLineStart.test(line.text) ? text + line.text : `${text} ${line.text}`;
    }, '');
    // 标题末尾抬高的小字是脚注标记（☆、*、a），不属于标题文字。
    const lastLine = lines.at(-1)!;
    const runs = lastLine.runs ?? [];
    const mark = runs.at(-1) as PdfLayoutAtom;
    const marked = kind === 'heading' && runs.length > 1 && mark.fontSize <= lastLine.fontSize! * 0.8 && mark.baseline < lastLine.baseline! - lastLine.fontSize! * 0.15
        && /^[\p{L}\d*†‡⇑☆]{1,2}$/u.test(mark.text.trim()) && joined.endsWith(mark.text.trim());
    // 两端撑开排版的中文在每个字之间都留了空；逐字带空格的原文会被当成一串单字来翻译。
    const spaced = joined.match(/[\p{Script=Han}] (?=[\p{Script=Han}])/gu)?.length ?? 0;
    return (spaced >= 3 && spaced >= (joined.match(/[\p{Script=Han}]/gu)!.length - 1) * 0.6
        ? joined.replace(/(?<=[\p{Script=Han}，。、；：（）]) (?=[\p{Script=Han}，。、；：（）])/gu, '')
        : marked ? joined.slice(0, -mark.text.trim().length).trimEnd() : joined).replace(/\u00AD/gu, '');
}

/** 作者署名：以逗号分隔的多个“名 姓”，或带单位标记（上标字母、数字、星号等）的人名；只用 and 连接的两个词组更像标题，不算署名。 */
export const byline = /^(?=.*(?:,|[*†‡⇑]|\s[a-z\d]\b))(?:(?:\p{Lu}[\p{L}\p{M}.'’-]*\s+){1,3}\p{Lu}[\p{L}\p{M}'’-]+(?:\s*[a-z\d*†‡⇑](?:\s*,\s*[a-z\d*†‡⇑])*)?\s*(?:,|\band\b|&|$)\s*)+$/u;
export const affiliationLine = /^(?:Department|Faculty|School|University|Institute|College|Laboratory)\s+(?:of|for)\b|(?:\b(?:University|College|Academy|Institute|Laborator(?:y|ies)|Group)|大学|学院|研究所|研究院|实验室)$/iu;
export const contactLine = /^(?:(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,})$/iu;

/** 一行的“词数”：按空白分出的词，加上不用空格分词的中日韩文字（两个字约合一个词）。 */
export const textUnits = (text: string) =>
    text.split(/\s+/u).filter(Boolean).length
    + (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) / 2;

/** 三个以上的词里多半是单个拉丁字母或数字（“i k k 1 k word”）：这是散落的上下标，不是句子。 */
const looseSymbols = (text: string) => {
    const tokens = text.trim().split(/\s+/u);
    return tokens.length >= 3 && tokens.filter(token => /^[\p{Script=Latin}\d]$/u.test(token)).length >= tokens.length * 0.6;
};

/** 含有可读词语（至少三个连续字母或一个中日韩文字，数学函数名除外）的文字才值得翻译；根号横线在部分数学字体里被读成一串 ffi，不是词语。 */
export const readable = (text: string) =>
    !/(?:ffi){3,}/u.test(text)
    && !looseSymbols(text)
    && (/\p{L}{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        text.replace(/\b(?:lim|min|max|log|exp|sin|cos|tan|arg|sup|inf)\b/giu, ''),
    ));

export const sectionTitle = /^(?:Abstract|References|Acknowledge?ments?|Appendix(?:\s+[A-Z])?(?:\.\s.*)?)$/iu;

/** 仅识别已支持章节名的逐字母普通空格样式；压缩键不写回来源文字，双空格的词界也只供识别。 */
export function spacedSectionTitle(line: LayoutLine): boolean {
    const text = line.runs.map(run => run.text).join(' ');
    return text.length < 80 && /^[A-Za-z](?: +[A-Za-z]){3,}$/u.test(text)
        && sectionTitle.test(text.split(/ {2,}/u).map(word => word.replace(/ /gu, '')).join(' '));
}

/** 行高的六成以上落在区域内才算区域内文字；紧贴图形包围盒上沿的正文行只是相邻。 */
export const coversLine = (region: Rectangle, line: LayoutLine) =>
    overlaps(region, line)
    && line.x + line.width / 2 >= region.x
    && line.x + line.width / 2 <= right(region)
    && line.baseline >= region.y
    && line.baseline <= bottom(region) + 2
    && Math.min(bottom(line), bottom(region) + 2) - Math.max(line.y, region.y) >= line.height * 0.6;

/** 整页 Form 的 BBox 描述嵌入页的坐标范围，不能用它把子图形和正文连成一个插图。 */
export function isPageWrapper(shape: PdfGraphicsShape, width: number, height: number): boolean {
    return shape.kind === 'form' && shape.y <= 1 && bottom(shape) >= height - 1 && shape.width >= width * .75;
}

export function uniqueEdges(values: number[]): number[] {
    const groups: number[][] = [];
    for (const value of values.sort((a, b) => a - b)) {
        const group = groups.at(-1);
        if (group && value - group[0] < 0.6) group.push(value);
        else groups.push([value]);
    }
    return groups.map(group => group[Math.floor(group.length / 2)]);
}
