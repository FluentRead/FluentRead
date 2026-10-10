/**
 * @file src/features/document-translation/core/pdfLayoutAnalysis.ts
 * 文件职责：从 PDF 原始字形和绘图操作推导阅读顺序、段落与必须保留的公式、表格、插图区域。
 * 主要内容：在未旋转内容坐标中追踪绘图矩阵；按相邻行共同让出的竖带识别栏间距，松散的两端对齐行不被拆散；页眉页脚、数字/罗马数字/字母编号的标题、中英文题注与公式碎片分别归类，分栏由并排的正文段落确定、同栏内缩进不同的块按上下顺序阅读，图形在题注处断开，幻灯片内容框、段落底色和标题色带这类装文字的容器不算插图，原位重复描画的文字只读一次，表格按单元格切分且含词语的单元格可以翻译；按基线关联上下标，先识别图表和独立公式，再按列与段落边界组织正文；保留逐行字形几何供阅读和导出使用。
 * 模块边界：纯几何分析，不加载 PDF.js、不访问 Canvas、网络或 DOM，不修改来源文字或文件。
 */
import type {PdfDocumentBlock, PdfDocumentLine, PdfDocumentRun, PdfPreservedRegion} from './document';

type Rectangle = Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>;
type Matrix = readonly number[];
export interface PdfLayoutAtom extends PdfDocumentRun {fontSize: number; baseline: number; fontFamily: string}
export interface PdfGraphicsShape extends Rectangle {kind: 'image' | 'form' | 'path'}
export interface PdfGraphicsOperators {fnArray: readonly number[]; argsArray: readonly unknown[]}
export interface PdfLayoutBlock extends Omit<PdfDocumentBlock, 'segmentIndex'> {source: string}
interface LayoutLine extends PdfDocumentLine {baseline: number; fontSize: number; fontFamily: string; runs: PdfDocumentRun[]}
const identity = [1, 0, 0, 1, 0, 0];
const median = (values: number[]) => {const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 10;};
const right = (box: Rectangle) => box.x + box.width;
const bottom = (box: Rectangle) => box.y + box.height;
const union = (a: Rectangle, b: Rectangle): Rectangle => {const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return {x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y};};
const overlaps = (a: Rectangle, b: Rectangle, padding = 0) => a.x <= right(b) + padding && right(a) + padding >= b.x && a.y <= bottom(b) + padding && bottom(a) + padding >= b.y;
const multiply = (a: Matrix, b: Matrix): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function transformedBox(matrix: Matrix, bounds: Matrix): Rectangle {
    const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]]
        .map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
}
function clipped(box: Rectangle, width: number, height: number): Rectangle | undefined {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
    const x = Math.max(0, box.x), y = Math.max(0, box.y);
    const result = {x, y, width: Math.min(width, right(box)) - x, height: Math.min(height, bottom(box)) - y};
    return result.width >= 0 && result.height >= 0 ? result : undefined;
}

/** PDF.js 的 constructPath 已附带控制点包围盒；clip/endPath 本身不是可见图形。 */
export function extractPdfGraphicsShapes(list: PdfGraphicsOperators, ops: Record<string, number>, viewport: {width: number; height: number; transform: Matrix}): PdfGraphicsShape[] {
    let matrix = [...identity];
    const stack: number[][] = [];
    let path: Rectangle | undefined;
    const shapes: PdfGraphicsShape[] = [];
    const add = (kind: PdfGraphicsShape['kind'], box: Rectangle) => {const valid = clipped(box, viewport.width, viewport.height); if (valid && (valid.width > 0 || valid.height > 0)) shapes.push({...valid, kind});};
    const boxFor = (bounds: Matrix) => transformedBox(multiply(viewport.transform, matrix), bounds);
    const paintsPath = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
    for (let index = 0; index < list.fnArray.length; index += 1) {
        const fn = list.fnArray[index], args = list.argsArray[index] as any[] | null;
        if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
            stack.push([...matrix]);
            if (fn === ops.paintFormXObjectBegin && args) {
                if (args[0]) matrix = multiply(matrix, args[0]);
                if (args[1]) add('form', boxFor(args[1]));
            }
        } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) {
            matrix = stack.pop() || [...identity];
        } else if (fn === ops.transform && args) matrix = multiply(matrix, args);
        else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) add('image', boxFor([0, 0, 1, 1]));
        else if (fn === ops.constructPath && args?.[2]) {const next = boxFor(args[2]); path = path ? union(path, next) : next;}
        else if (paintsPath.has(fn)) {if (path) add('path', path); path = undefined;}
        else if (fn === ops.endPath) path = undefined;
    }
    return shapes;
}

function joinRuns(runs: readonly PdfLayoutAtom[]): string {
    let text = '', end = -Infinity;
    for (const run of runs) {
        const gap = run.x - end;
        if (text && gap > Math.max(1.1, run.fontSize * 0.1) && !/[\s\-–—/]$/u.test(text) && !/^[,.;:!?，。；：！？)\]}]/u.test(run.text)) text += ' ';
        text += run.text; end = Math.max(end, right(run));
    }
    return text.replace(/\s+/gu, ' ').trim();
}

/** 基线而非字形顶边决定同一行，上下标仍保留自己的矩形和文字。 */
export function pdfLayoutLines(atoms: readonly PdfLayoutAtom[], verticalDividers: readonly Rectangle[] = []): LayoutLine[] {
    const rows: Array<{runs: PdfLayoutAtom[]; font: number; baseline: number; samples: number; first: number}> = [];
    // 幻灯片常把同一段文字在原位再画一遍来加粗或做阴影；同一位置的同一段文字只算一次，否则译文会收到重复的原文。
    const drawn = new Map<string, PdfLayoutAtom[]>();
    const unique = atoms.filter(atom => {
        if (!atom.text.trim()) return true;
        const slack = Math.max(1, atom.fontSize * 0.1);
        const column = Math.round(atom.x / slack), row = Math.round(atom.baseline / slack);
        // 按位置分桶后只看相邻的桶，同一行里成百上千个相同的字也不会两两比较。
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
            if (drawn.get(`${column + dx}:${row + dy}:${atom.text}`)?.some(other => Math.abs(other.x - atom.x) <= Math.min(slack, atom.width / 2) && Math.abs(other.baseline - atom.baseline) <= slack && Math.abs(other.fontSize - atom.fontSize) <= 0.5)) return false;
        }
        const key = `${column}:${row}:${atom.text}`;
        const bucket = drawn.get(key);
        if (bucket) bucket.push(atom); else drawn.set(key, [atom]);
        return true;
    });
    // TeX 根号字形的基线可能抬高到上一行；被开方字形紧贴根号右端，按它的基线归行，字形矩形仍保持原样。
    const associated = unique.map(atom => {
        if (atom.text !== '√') return atom;
        const next = unique.filter(other => other !== atom && /^[\p{L}\d(]/u.test(other.text)
            && Math.abs(other.x - right(atom)) <= atom.fontSize * 0.35 && other.fontSize >= atom.fontSize * 0.8
            && other.baseline - atom.baseline > atom.fontSize * 0.35 && other.baseline - atom.baseline <= atom.fontSize)
            .sort((a, b) => Math.abs(a.x - right(atom)) - Math.abs(b.x - right(atom)) || a.baseline - b.baseline)[0];
        return next ? {...atom, baseline: next.baseline} : atom;
    });
    for (const atom of associated.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
        const row = rows.at(-1);
        const tolerance = row ? Math.max(2, Math.max(row.font, atom.fontSize) * 0.55) : 0;
        // 同一行同时含抬高的上标与降低的下标时，二者跨度稍大；下标仍须贴近主行基线，不能单凭早来的上标将它切成下一行。
        const firstTolerance = row && atom.fontSize <= row.font * 0.8 ? Math.max(tolerance, row.font * 0.8) : tolerance;
        // 双栏行距不同时，一栏的基线会落在另一栏两行之间；只与行首基线比较，避免它把上下两行接力串成一行。
        if (!row || Math.abs(atom.baseline - row.baseline) > tolerance || atom.baseline - row.first > firstTolerance) rows.push({runs: [atom], font: atom.fontSize, baseline: atom.baseline, samples: 1, first: atom.baseline});
        else {
            row.runs.push(atom);
            if (atom.fontSize > row.font * 1.15) {row.font = atom.fontSize; row.baseline = atom.baseline; row.samples = 1;}
            else if (atom.fontSize >= row.font * 0.85) {row.baseline = (row.baseline * row.samples + atom.baseline) / (row.samples + 1); row.samples += 1;}
        }
    }
    const result: LayoutLine[] = [];
    const ordered = rows.map(row => [...row.runs].sort((a, b) => a.x - b.x));
    const clearAt = (row: readonly PdfLayoutAtom[], x: number) => !row.some(run => run.x < x + 1.5 && right(run) > x - 1.5);
    const adjacent = (at: number, from: number, font: number) => Boolean(rows[at]) && Math.abs(rows[at].baseline - rows[from].baseline) <= font * 2.2;
    const divided = (start: number, end: number, baseline: number) => verticalDividers.some(divider => divider.x >= start - 0.5 && right(divider) <= end + 0.5
        && baseline >= divider.y - 2 && baseline <= bottom(divider) + 2);
    /**
     * 真实栏间距会被相邻行在同一竖带上共同让出：1 表示某一侧连续两行（或该侧仅有的一行）留白，0 表示上下邻行都占用，-1 表示至少一侧没有邻行可供比较。
     * 松散对齐的词间距即使偶尔与一行邻行对齐，也难以连续两行落在同一竖带。
     */
    const gutterSupport = (rowIndex: number, start: number, end: number, font: number): -1 | 0 | 1 => {
        for (let x = start + 1.5; x <= end - 1.5; x += 2) {
            for (const step of [-1, 1]) {
                if (!adjacent(rowIndex + step, rowIndex, font) || !clearAt(ordered[rowIndex + step], x)) continue;
                if (!adjacent(rowIndex + step * 2, rowIndex + step, font) || clearAt(ordered[rowIndex + step * 2], x)) return 1;
            }
        }
        return adjacent(rowIndex - 1, rowIndex, font) && adjacent(rowIndex + 1, rowIndex, font) ? 0 : -1;
    };
    for (const [rowIndex, row] of ordered.entries()) {
        const bodyFont = median(row.map(run => run.fontSize));
        const groups: PdfLayoutAtom[][] = [];
        // 两端对齐的松散行会把每个词间距都拉到接近一个字宽；只有明显大于本行词距、且被邻行让出的空白才是栏间距。
        const gaps: number[] = [];
        let end = -Infinity;
        for (const run of row) {
            if (run.x - end > bodyFont * 0.15 && end > -Infinity) gaps.push(run.x - end);
            end = Math.max(end, right(run));
        }
        end = -Infinity;
        for (const run of row) {
            const gap = run.x - end;
            let split = !groups.length || divided(end, run.x, rows[rowIndex].baseline);
            if (!split && gap > Math.max(6, bodyFont * 0.9)) {
                const others = [...gaps]; others.splice(others.indexOf(gap), 1);
                const support = gutterSupport(rowIndex, end, run.x, bodyFont);
                split = (support < 0 ? gap >= bodyFont * 2.5 : support === 1) && (!others.length || gap >= bodyFont * 2.5 || gap >= median(others) * 1.8);
            }
            if (split) groups.push([run]);
            else groups.at(-1)!.push(run);
            end = Math.max(end, right(run));
        }
        for (let index = 0; index < groups.length - 1; index += 1) {
            const previous = groups[index], next = groups[index + 1];
            if (/^\d+(?:\.\d+)*$/u.test(joinRuns(previous)) && /^[A-Z]/u.test(joinRuns(next)) && next[0].x - right(previous.at(-1)!) <= bodyFont * 2.5
                && !divided(right(previous.at(-1)!), next[0].x, rows[rowIndex].baseline)) {previous.push(...next); groups.splice(index + 1, 1);}
        }
        for (const runs of groups) {
            const bounds = runs.reduce<Rectangle>((box, run) => union(box, run), runs[0]);
            const dominant = [...runs].sort((a, b) => b.width - a.width)[0];
            const fontSize = median(runs.filter(run => run.fontSize >= dominant.fontSize * 0.85).map(run => run.fontSize));
            result.push({...bounds, text: joinRuns(runs), baseline: median(runs.filter(run => run.fontSize >= fontSize * 0.85).map(run => run.baseline)), fontSize, fontFamily: dominant.fontFamily, runs: runs.map(run => ({...run}))});
        }
    }
    return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const cjkGlyphs = new RegExp(`[${CJK}]`, 'gu');
const cjkGlyph = new RegExp(`[${CJK}]`, 'u');
/** 以中日韩文字为主的一行：这些文字占去非空白字符的一半以上。 */
const cjkLine = (text: string) => (text.match(cjkGlyphs)?.length ?? 0) * 2 >= text.replace(/\s/gu, '').length;
/** 上一行以中日韩文字或全角标点结尾、下一行以它们开头时，折行处不应补空格。 */
const cjkEdge = new RegExp(`^[${CJK}，。、；：！？（）《》“”][${CJK}，。、；：！？（）《》“”]$`, 'u');
/** 作者署名：以逗号分隔的多个“名 姓”，或带单位标记（上标字母、数字、星号等）的人名；只用 and 连接的两个词组更像标题，不算署名。 */
const byline = /^(?=.*(?:,|[*†‡⇑]|\s[a-z\d]\b))(?:(?:[A-Z][\p{L}.'’-]*\s+){1,3}[A-Z][\p{L}'’-]+(?:\s*[a-z\d*†‡⇑](?:\s*,\s*[a-z\d*†‡⇑])*)?\s*(?:,|\band\b|&|$)\s*)+$/u;
/** 一行的“词数”：按空白分出的词，加上不用空格分词的中日韩文字（两个字约合一个词）。 */
const textUnits = (text: string) => text.split(/\s+/u).filter(Boolean).length + (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) / 2;
/** 三个以上的词里多半是单个拉丁字母或数字（“i k k 1 k word”）：这是散落的上下标，不是句子。 */
const looseSymbols = (text: string) => {const tokens = text.trim().split(/\s+/u); return tokens.length >= 3 && tokens.filter(token => /^[\p{Script=Latin}\d]$/u.test(token)).length >= tokens.length * 0.6;};
/** 含有可读词语（至少三个连续字母或一个中日韩文字，数学函数名除外）的文字才值得翻译；根号横线在部分数学字体里被读成一串 ffi，不是词语。 */
const readable = (text: string) => !/(?:ffi){3,}/u.test(text) && !looseSymbols(text) && (/\p{L}{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text.replace(/\b(?:lim|min|max|log|exp|sin|cos|tan|arg|sup|inf)\b/giu, '')));
function mergedFigures(shapes: readonly PdfGraphicsShape[], width: number, height: number, container: (box: Rectangle) => boolean): Rectangle[] {
    const figures: Rectangle[] = [];
    for (const shape of shapes.filter(shape => shape.width >= 24 && shape.height >= 24 && (shape.kind !== 'path' || shape.width * shape.height >= 900))) {
        if (shape.width * shape.height >= width * height * 0.94 || container(shape)) continue;
        let merged: Rectangle = shape;
        for (let index = figures.length - 1; index >= 0; index -= 1) {
            if (overlaps(merged, figures[index], 2)) {merged = union(merged, figures[index]); figures.splice(index, 1);}
        }
        figures.push(merged);
    }
    // 许多小底框首尾相接也会并成一个圈住整页文字的大区域，合并之后再检查一次。
    return figures.filter(figure => !container(figure));
}
function tableRegions(shapes: readonly PdfGraphicsShape[], width: number, figures: readonly Rectangle[]): Rectangle[] {
    const rows = shapes.filter(shape => shape.kind === 'path' && shape.width >= width * 0.2 && shape.height <= 2 && !figures.some(figure => overlaps(shape, figure)))
        .sort((a, b) => a.y - b.y);
    const groups: Rectangle[][] = [];
    for (const row of rows) {
        const group = groups.find(group => {
            const last = group.at(-1)!;
            return row.y - last.y <= 150 && Math.min(right(row), right(last)) - Math.max(row.x, last.x) >= Math.min(row.width, last.width) * 0.7;
        });
        if (group) group.push(row); else groups.push([row]);
    }
    return groups.filter(group => group.length >= 2).map(group => {
        const box = group.reduce(union); return {...box, y: Math.max(0, box.y - 1), height: box.height + 2};
    });
}
/** 相接且同宽的填色行，里面反复出现对齐的多个文字单元格，是表格底色而非插图。 */
function shadedTableRegions(shapes: readonly PdfGraphicsShape[], lines: readonly LayoutLine[], width: number, font: number): Rectangle[] {
    const rows = shapes.filter(shape => shape.kind === 'path' && shape.width >= width * 0.2 && shape.height >= 6 && shape.height <= font * 5)
        .sort((a, b) => a.y - b.y);
    const groups: PdfGraphicsShape[][] = [];
    for (const row of rows) {
        const group = groups.find(group => {
            const last = group.at(-1)!;
            return Math.abs(last.x - row.x) <= 1.5 && Math.abs(right(last) - right(row)) <= 1.5
                && Math.abs(row.y - bottom(last)) <= 2 && Math.abs(row.height - last.height) <= 2;
        });
        if (group) group.push(row); else groups.push([row]);
    }
    return groups.flatMap(group => {
        if (group.length < 3) return [];
        const cells = group.map(row => lines.filter(line => coversLine(row, line)));
        const aligned = cells.filter(row => row.length >= 2 && row.filter(cell => cells.some(other => other !== row
            && other.some(candidate => Math.abs(candidate.x - cell.x) <= font * 0.6))).length >= 2);
        return aligned.length >= Math.max(3, group.length * 0.75) ? [group.reduce<Rectangle>(union, group[0])] : [];
    });
}
/** 行高的六成以上落在区域内才算区域内文字；紧贴图形包围盒上沿的正文行只是相邻。 */
const coversLine = (region: Rectangle, line: LayoutLine) => overlaps(region, line) && line.x + line.width / 2 >= region.x && line.x + line.width / 2 <= right(region) && line.baseline >= region.y && line.baseline <= bottom(region) + 2
    && Math.min(bottom(line), bottom(region) + 2) - Math.max(line.y, region.y) >= line.height * 0.6;
function formulaLine(line: LayoutLine, pageWidth: number, lines: readonly LayoutLine[], font: number): boolean {
    // 与上下行同栏等宽、行距正常的行是两端对齐的正文，即使含有等号也不是独立公式。
    if (lines.some(near => near !== line && near.text.split(/\s+/u).length >= 5 && Math.abs(near.x - line.x) <= 1 && Math.abs(near.width - line.width) <= 2 && Math.abs(near.baseline - line.baseline) <= font * 1.6)) return false;
    return line.text.length < 150 && line.width < pageWidth * 0.75 && /[=∑∫√∈≃≅≈≡≤≥≠¼]|ð[^Þ]*Þ|(?:softmax|Concat|FFN|MultiHead)\s*\(/u.test(line.text)
        && (Math.abs(line.x + line.width / 2 - pageWidth / 2) < pageWidth * 0.23 || /^[A-Za-z][\w (){},.]*\s*=/u.test(line.text) || /¼|ð[^Þ]*Þ/u.test(line.text))
        && !/^(?:Figure|Table)\s+\d/iu.test(line.text)
        && !/\b(?:the|we|our|of|to|and|is|in|this|with|for|that|use|each|are|from|used)\b/iu.test(line.text);
}

export function analyzePdfPageLayout(input: {atoms: readonly PdfLayoutAtom[]; graphics: readonly PdfGraphicsShape[]; width: number; height: number}): {blocks: PdfLayoutBlock[]; preservedRegions: PdfPreservedRegion[]} {
    // 项目符号是单独的一个字形：符号字体里的圆点方块常被读成 n、u、l 这样的字母。它留在原页上不参与翻译，
    // 所在的行从符号之后算起，并且总是另起一段。
    // 可见竖线比词距推断更可靠；紧挨分隔线的两格文字也不能串成一个段落。
    const verticalDividers = input.graphics.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4);
    const rawLines = pdfLayoutLines(input.atoms, verticalDividers);
    const bulletGlyph = (line: LayoutLine) => line.runs.length > 1 ? line.runs[0].text.trim() : '';
    const letterBullets = new Map<string, number>();
    for (const line of rawLines) {const glyph = bulletGlyph(line); if (/^[nlupqvw]$/u.test(glyph) && !/^\s*\p{Ll}/u.test(line.runs[1].text)) letterBullets.set(glyph, (letterBullets.get(glyph) ?? 0) + 1);}
    const bulleted = new Set<LayoutLine>();
    // 目录行“标题……页码”里的引导点和页码留在原页上：这一行只算到标题文字为止，译文不会带着一串点，页码也不会被盖掉。
    const glyphWeight = (text: string) => Array.from(text).reduce((sum, character) => sum + (/[.．·…‥\s]/u.test(character) ? 0.55 : cjkGlyph.test(character) || /[\uFF00-\uFFEF《》（）]/u.test(character) ? 2 : 1), 0);
    // 每个目录条目自成一段，不与上下条目合并。
    const tocEntries = new Set<LayoutLine>();
    const withoutLeader = (line: LayoutLine): LayoutLine => {
        const title = line.text.match(/^(.*?[^\s.．·…‥])\s*(?:[.．·…‥]\s?){6,}\s*\d{0,4}$/u)?.[1];
        if (!title) return line;
        let remaining = title.replace(/\s/gu, '').length, end = line.x;
        const runs: PdfDocumentRun[] = [];
        for (const run of line.runs) {
            const length = run.text.replace(/\s/gu, '').length;
            if (!remaining) break;
            runs.push(run);
            if (length <= remaining) {end = right(run); remaining -= length; continue;}
            const kept = Array.from(run.text.replace(/\s/gu, '')).slice(0, remaining).join('');
            end = run.x + run.width * Math.min(1, glyphWeight(kept) / glyphWeight(run.text)) + line.fontSize * 0.3;
            remaining = 0;
        }
        const entry = {...line, text: title, width: Math.max(1, Math.min(right(line), end) - line.x), runs};
        tocEntries.add(entry);
        if (bulleted.has(line)) bulleted.add(entry);
        return entry;
    };
    const lines = rawLines.map(line => {
        const glyph = bulletGlyph(line);
        if (!(/^[•◦▪■□◆◇●○▶►➢➤❖·§Ø\uE000-\uF8FF]$/u.test(glyph) || (/^[nlupqvw]$/u.test(glyph) && (letterBullets.get(glyph)! >= 2 || cjkLine(line.runs[1].text)) && !/^\s*\p{Ll}/u.test(line.runs[1].text)))) return line;
        const runs = line.runs.slice(1), x = runs[0].x;
        const stripped = {...line, x, width: right(line) - x, runs, text: joinRuns(runs as PdfLayoutAtom[])};
        bulleted.add(stripped);
        return stripped;
    }).map(withoutLeader);
    // 正文字号按字符数加权取中位数：标题、脚注和页眉的行数再多，也不会改变一页的基准字号。
    const sized = input.atoms.filter(atom => atom.fontSize >= 6).sort((a, b) => a.fontSize - b.fontSize);
    let remaining = sized.reduce((sum, atom) => sum + atom.text.length, 0) / 2;
    const font = sized.find(atom => (remaining -= atom.text.length) <= 0)?.fontSize ?? 10;
    // 正文行距：同栏、正文字号的上下相邻两行之间最常见的基线距离。文字处理软件导出的文档常用 1.5 到 2 倍行距，
    // 段落合并与标题折行的间距上限随它放宽；常见的单倍行距（不超过字号的 1.25 倍）保持原有上限。
    const bodyGaps: number[] = [];
    lines.forEach((line, index) => {
        if (Math.abs(line.fontSize - font) > 0.6) return;
        for (let next = index + 1; next < lines.length && lines[next].y - line.y <= font * 2.8; next += 1) {
            const below = lines[next], gap = below.baseline - line.baseline;
            if (gap > font * 0.9 && Math.abs(below.fontSize - font) <= 0.6 && Math.min(right(line), right(below)) - Math.max(line.x, below.x) >= Math.min(line.width, below.width) * 0.5) {bodyGaps.push(gap); break;}
        }
    });
    const loose = bodyGaps.length >= 3 ? Math.max(1, median(bodyGaps) / (font * 1.25)) : 1;
    // 题注开头：“Figure 1.”“Fig. 2:”“Table 3.”，IEEE 版式独占一行的“TABLE I”，以及中文的“图 1 ……”“表 2-1 ……”。正文里的“Table 2 shows”没有紧随的标点，不算题注。
    const captionStart = /^(?:(?:[Ff]igure|FIGURE|[Tt]able|TABLE|[Ff]ig\.|FIG\.)\s+\d+[.:]|TABLE\s+[IVXLC]+$|[图表]\s*\d+(?:[-.．]\d+)*[\s:：.．])/u;
    // 幻灯片的内容框、笔记的段落底色和标题色带都是“装文字的容器”而不是插图：成句的文字占去框内三成以上面积，
    // 或者框占页面三分之一以上且框内多半是成句的行、或字号明显大于图内标注时，框内文字按正文处理。
    const container = (box: Rectangle) => {
        const inside = lines.filter(line => coversLine(box, line) && readable(line.text));
        if (!inside.length) return false;
        const area = box.width * box.height;
        // 插图的包围盒也会圈入旁边的正文；图内若有成批小于正文字号的短标注，它仍是插图。
        const labels = inside.filter(line => textUnits(line.text) < 4 && line.fontSize < Math.min(font * 0.9, 11)).length;
        if (labels > Math.max(3, inside.length * 0.15)) return false;
        if (inside.some(line => textUnits(line.text) >= 4) && inside.reduce((sum, line) => sum + line.width * line.height, 0) >= area * 0.3) return true;
        // 摘要/提示的浅底框常保留较大内边距，文字面积不足三成，但框内仍有接近整行的完整句子。
        if (box.width >= input.width * 0.45 && box.height <= font * 7
            && inside.some(line => textUnits(line.text) >= 12 && line.width >= box.width * 0.6)) return true;
        // 单个大字号标签不足以把整张图变成文字容器（嵌入图有时仍带被裁掉的标题文字层）。
        return area >= input.width * input.height * 0.35 && (inside.length >= 3 && median(inside.map(line => line.fontSize)) >= 12 || inside.filter(line => textUnits(line.text) >= 6).length >= inside.length / 2);
    };
    const shadedTables = shadedTableRegions(input.graphics, lines, input.width, font);
    const figures = mergedFigures(input.graphics.filter(shape => !shadedTables.some(table => shape.kind === 'path'
        && shape.x >= table.x - 1 && right(shape) <= right(table) + 1 && shape.y >= table.y - 1 && bottom(shape) <= bottom(table) + 1)), input.width, input.height, container);
    // 图形对象的包围盒常把题注一并圈入，上下相邻的两张图还会连同中间的题注并成一个区域；题注是需要翻译的正文，图形在题注处断开。
    for (let index = 0; index < figures.length; index += 1) {
        const figure = figures[index];
        const start = lines.find(line => captionStart.test(line.text) && line.y > figure.y + 12 && bottom(line) <= bottom(figure) + 2
            && line.x >= figure.x - 2 && right(line) <= right(figure) + 2 && line.width >= figure.width * 0.4);
        if (!start) continue;
        let end = bottom(start), baseline = start.baseline;
        for (const line of lines) {
            if (line.baseline <= baseline || line.baseline - baseline > start.fontSize * 1.5 || Math.abs(line.fontSize - start.fontSize) > 0.6 || line.x < start.x - 2 || right(line) > right(start) + start.fontSize * 2) continue;
            baseline = line.baseline; end = bottom(line);
        }
        const below = bottom(figure) - end - 2;
        figure.height = Math.max(1, start.y - 2 - figure.y);
        // 题注下方剩余的部分是另一张图，继续按同样的规则检查它自己的题注。
        if (below >= 24) figures.splice(index + 1, 0, {x: figure.x, y: end + 2, width: figure.width, height: below});
    }
    // 插图上方的短居中标签属于图形本身；保留它们能让左右子图在裁剪后仍有完整标题。
    for (let index = 0; index < figures.length; index += 1) {
        const figure = figures[index];
        const labels = lines.filter(line => bottom(line) <= figure.y && figure.y - line.baseline <= Math.max(font, line.fontSize) * 2.5
            && (Math.abs(line.x + line.width / 2 - figure.x - figure.width / 2) <= font * 2 || Math.abs(line.x - figure.x) <= font * 0.25)
            && line.height <= Math.max(font, line.fontSize) * 1.7 && line.width < input.width * .45 && line.text.length <= 80
            && !/^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.|[A-Z]\.)\s+\p{Lu}/u.test(line.text)
            && !/^(?:Figure|Table)\s+\d/iu.test(line.text) && !/[.!?。！？]$/u.test(line.text) && !/[=∑∫√∈]/u.test(line.text));
        labels.sort((a, b) => b.baseline - a.baseline);
        if (labels.length) figures[index] = union(figure, labels[0]);
    }
    const tables = [...tableRegions(input.graphics, input.width, figures), ...shadedTables];
    const regions: PdfPreservedRegion[] = [...figures.map((box, index) => ({...box, id: `figure-${index + 1}`, kind: 'figure' as const})), ...tables.map((box, index) => ({...box, id: `table-${index + 1}`, kind: 'table' as const}))];
    // 图形包围盒可能跨栏并圈入下方的正文：图内只有小字短标签属于图形，题注、成句的行、紧随成句行的续行以及幻灯片这类大字号页面上 12 磅以上的图内文字（流程图里的文字）仍是正文；论文页眉图里的期刊名等大字仍属于图。
    const prose = new Set<LayoutLine>();
    for (const line of lines) {
        if (captionStart.test(line.text) || textUnits(line.text) >= 7) prose.add(line);
        else if (lines.some(near => textUnits(near.text) >= 7 && near.baseline < line.baseline && line.baseline - near.baseline <= near.fontSize * 1.5 && Math.abs(near.fontSize - line.fontSize) <= 0.6 && line.x >= near.x - 1 && line.x - near.x <= font * 2.2 && right(line) <= right(near) + 2)) prose.add(line);
    }
    const inRegion = (region: PdfPreservedRegion, line: LayoutLine) => coversLine(region, line) && !(region.kind === 'figure' && (prose.has(line) || (font >= 14 && line.fontSize >= 12 && readable(line.text))));
    const ordinary = lines.filter(line => !regions.some(region => inRegion(region, line)));
    const formulas = ordinary.filter(line => formulaLine(line, input.width, ordinary, font));
    for (const line of formulas) {
        let bounds: Rectangle = line;
        // 独立公式的小上下标、分式和式号与公式一起保留；不能把下一行正文并入遮盖区域。
        for (const near of ordinary) {
            if (near === line || near.text.length > 45 || near.width > input.width * 0.5) continue;
            if (Math.abs(near.baseline - line.baseline) <= font * 1.65 && (overlaps({...line, x: line.x - font, width: line.width + font * 2, y: line.y - font, height: line.height + font * 2}, near) || /^\(\d+\)$/u.test(near.text))) bounds = union(bounds, near);
        }
        const existing = regions.find(region => region.kind === 'formula' && overlaps(region, bounds));
        if (existing) Object.assign(existing, union(existing, bounds));
        else regions.push({...bounds, id: `formula-${regions.filter(region => region.kind === 'formula').length + 1}`, kind: 'formula'});
    }
    // 记录原区域字形，阅读排版仍使用原页像素，不根据扁平字符串重建公式或表格。
    regions.forEach(region => {region.source = lines.filter(line => inRegion(region, line)).map(line => line.text).join(' ');});
    const authorRows = ordinary.filter(line => line.y < input.height * 0.45 && line.width < input.width * 0.35);
    const authorBuckets = new Map<number, LayoutLine[]>();
    for (const line of authorRows) {const key = Math.round(line.baseline / 2); const bucket = authorBuckets.get(key) || []; bucket.push(line); authorBuckets.set(key, bucket);}
    // 作者区是标题下方按列排开的姓名与单位：有邮箱时三列以上的行即是；没有邮箱时要求至少两行都是三列以上、每格都是首字母大写的短名称，且上方有更大的标题。
    const nameLike = (line: LayoutLine) => /^[\p{Lu}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*){0,3}$/u.test(line.text);
    const gridRows = [...authorBuckets.values()].filter(bucket => bucket.length >= 3);
    const namedRows = gridRows.filter(bucket => bucket.every(nameLike) && lines.some(above => above.baseline < bucket[0].baseline && above.fontSize > bucket[0].fontSize * 1.3));
    const authorGrid = ordinary.some(line => line.text.includes('@')) ? gridRows.flat() : namedRows.length >= 2 ? namedRows.flat() : [];
    const authorStart = authorGrid.reduce((start, line) => Math.min(start, line.y), Infinity);
    const authorEnd = authorGrid.reduce((end, line) => Math.max(end, bottom(line)), -Infinity) + font * 4.5;
    type Draft = {lines: LayoutLine[]; kind: NonNullable<PdfDocumentBlock['kind']>; region?: PdfPreservedRegion; bounds: Rectangle};
    const drafts: Draft[] = [];
    let active: Draft[] = [];
    const classify = (line: LayoutLine): Draft['kind'] => {
        if (line.y > input.height * 0.92 && /^\d{1,4}$/u.test(line.text.trim())) return 'footer';
        // 页眉页脚位于版心之外、不大于正文字号，并与版心隔开至少一行；它们逐页重复，保留原样而不打断正文阅读顺序。
        const header = bottom(line) < input.height * 0.065, trailer = line.y > input.height * 0.945;
        if ((header || trailer) && line.fontSize <= font * 1.05 && line.text.length < 120
            && !lines.some(near => header ? near.y >= bottom(line) - 1 && near.y - bottom(line) < font * 1.2 : bottom(near) <= line.y + 1 && line.y - bottom(near) < font * 1.2)) return 'footer';
        if (captionStart.test(line.text)) return 'caption';
        // 标题下方的作者署名字号常大于正文，但它是人名与单位标记，既不该翻译也不该出现在目录里。
        if (line.y < input.height * 0.45 && byline.test(line.text) && lines.some(above => above.baseline < line.baseline && above.fontSize > line.fontSize * 1.1)) return 'metadata';
        // 没有可读词语的短行（求和号、上下标、极限记号）是公式的碎片，翻译只会破坏它。
        if (!readable(line.text)) return 'formula';
        const numbered = line.fontSize >= font * 0.95 && line.text.length < 120;
        // “1. 标题”与编号列表同形：列表项的续行缩进或占满栏宽，标题下方则是空行或更短的折行。
        const listItem = () => lines.some(near => near.baseline > line.baseline && near.baseline - line.baseline <= line.fontSize * 1.45 * loose
            && (near.x > line.x + 2 ? near.x - line.x <= font * 4 : Math.abs(near.x - line.x) <= 1 && near.width >= line.width * 0.9));
        // 段落中间恰好以数字开头的一行（“4 PP stages …”“10 MB to …”）紧接在同栏的满行之后，不是标题。
        const midParagraph = () => lines.some(near => near.baseline < line.baseline && line.baseline - near.baseline <= line.fontSize * 1.45 * loose
            && Math.abs(near.fontSize - line.fontSize) <= 0.6 && near.x <= line.x + 1 && right(near) >= right(line) - 2 && near.width >= line.width * 0.9 && !/[.!?:。！？：]$/u.test(near.text));
        if ((numbered && !/[-‐‑]$/u.test(line.text) && !midParagraph() && ((/^\d+(?:\.\d+)*\s+[A-Z]/u.test(line.text) && !(line.text.split(/\s+/u).length > 6 && listItem())) || (/^\d+(?:\.\d+)*\.\s+[A-Z]/u.test(line.text) && line.text.split(/\s+/u).length <= 9 && !/[.,;:]$/u.test(line.text) && !listItem())))
            || (line.text.length < 80 && /^(?:Abstract|References|Acknowledge?ments?|Appendix(?:\s+[A-Z])?(?:\.\s.*)?)$/iu.test(line.text))
            // IEEE 等版式的章节用罗马数字或字母编号（“II. RELATED WORK”“A. Data Collection”），字号与正文相同；带有第二个姓名缩写的行是作者而不是标题。
            || (numbered && /^(?:[IVXLC]+|[A-Z])\.\s+[A-Z]/u.test(line.text) && line.text.split(/\s+/u).length <= 10 && !/[.,;:]$/u.test(line.text) && !/\s[A-Z]\.\s/u.test(line.text) && !midParagraph() && !listItem()) || (line.fontSize >= font * 1.32 && line.text.length < 100)) return 'heading';
        if (line.text.includes('@') || (line.y >= authorStart && line.y <= authorEnd && line.width < input.width * 0.35 && line.text.length < 100)) return 'metadata';
        return 'text';
    };
    // 一栏的右边界：左缘相近的各行里最靠右的行尾，用来判断某一行有没有排满。
    const columnEdges = new Map<number, number>();
    const columnRight = (line: LayoutLine) => {
        const key = Math.round(line.x);
        if (!columnEdges.has(key)) columnEdges.set(key, lines.reduce((edge, other) => Math.abs(other.x - line.x) <= font * 3 && Math.abs(other.fontSize - line.fontSize) <= 0.6 ? Math.max(edge, right(other)) : edge, 0));
        return columnEdges.get(key)!;
    };
    const newTableRow = (last: LayoutLine, line: LayoutLine, region: PdfPreservedRegion) => {
        // 横表线、填色行边缘、逐行绘制的竖线端点都提供了明确的单元格行界；不能按小写开头把下一记录并入上一格。
        if (input.graphics.some(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
            && (shape.width >= region.width * 0.7 || shape.width <= 2 && shape.height <= line.fontSize * 1.5)
            && [shape.y, bottom(shape)].some(y => y > last.baseline + 1 && y < line.baseline - 1))) return true;
        // 无逐行表线的表格以同一基线上的数值列确认记录行；真正的断词/括号续行仍可归入一个单元格。
        return lines.some(other => other !== line && coversLine(region, other) && Math.abs(other.baseline - line.baseline) <= 1
            && !readable(other.text) && /\d/u.test(other.text));
    };
    const tableEdges = new Map<PdfPreservedRegion, {xs: number[]; ys: number[]}>();
    const uniqueEdges = (values: number[]) => {
        const groups: number[][] = [];
        for (const value of values.sort((a, b) => a - b)) {
            const group = groups.at(-1);
            if (group && value - group[0] < 0.6) group.push(value); else groups.push([value]);
        }
        return groups.map(group => group[Math.floor(group.length / 2)]);
    };
    const cellBounds = (draft: Draft): Rectangle | undefined => {
        if (draft.region?.kind !== 'table') return;
        const region = draft.region;
        if (!tableEdges.has(region)) {
            const rules = input.graphics.filter(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
                && shape.y >= region.y - 2 && bottom(shape) <= bottom(region) + 2);
            const vertical = rules.filter(shape => shape.width <= 2 && shape.height >= 4);
            let xs = uniqueEdges([region.x, ...vertical.map(shape => shape.x), right(region)]);
            if (!vertical.length && shadedTables.some(table => Math.abs(table.y - region.y) < 1 && Math.abs(table.x - region.x) < 1)) {
                // 无竖线的填色表格按重复的左对齐文字位置定列；沿用首列与左表边之间的内边距。
                const anchors = uniqueEdges(lines.filter(line => coversLine(region, line)).map(line => line.x));
                const padding = Math.max(2, Math.min(font, anchors[0] - region.x));
                xs = [region.x, ...anchors.slice(1).map(x => x - padding), right(region)];
            }
            const ys = uniqueEdges(rules.flatMap(shape => shape.width >= region.width * 0.7
                || shape.width <= 2 && shape.height <= font * 1.5 ? [shape.y, bottom(shape)] : []));
            tableEdges.set(region, {xs, ys: ys.length >= 2 ? ys : [region.y, bottom(region)]});
        }
        const {xs, ys} = tableEdges.get(region)!;
        const center = draft.bounds.x + draft.bounds.width / 2;
        const first = draft.lines[0], last = draft.lines.at(-1)!;
        const x = [...xs].reverse().find(edge => edge <= center) ?? region.x;
        const y = [...ys].reverse().find(edge => edge < first.baseline) ?? region.y;
        const endX = xs.find(edge => edge > center) ?? right(region);
        const endY = ys.find(edge => edge > last.baseline) ?? bottom(region);
        return {x, y, width: Math.max(1, endX - x), height: Math.max(1, endY - y)};
    };
    for (const line of lines) {
        active = active.filter(draft => line.baseline - draft.lines.at(-1)!.baseline <= Math.max(font, draft.lines.at(-1)!.fontSize) * 1.7 * loose);
        const region = regions.find(region => inRegion(region, line));
        const kind = region ? region.kind === 'figure' ? 'figure-label' : region.kind : classify(line);
        let selected: Draft | undefined;
        if (kind !== 'footer' && !/^\(\d+\)\s/u.test(line.text) && !bulleted.has(line) && !tocEntries.has(line)) {
            for (const draft of active) {
                const last = draft.lines.at(-1)!;
                if (tocEntries.has(last)) continue;
                const gap = line.baseline - last.baseline;
                // 折行的标题与首行同字号、左对齐且更短；紧随其后的正文首行通常占满栏宽，不能并入标题。
                const wrappedHeading = draft.kind === 'heading' && (kind === 'text' || kind === 'heading') && draft.lines.length < 3 && gap <= last.fontSize * 1.45 * loose
                    && ((Math.abs(line.x - last.x) <= 1 && line.width < last.width * 0.9) || (kind === 'heading' && Math.abs(line.fontSize - last.fontSize) <= 0.2 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= 2))
                    && !/[.!?。！？]$/u.test(last.text) && !/^\d+(?:\.\d+)*\.?\s/u.test(line.text);
                if (draft.region !== region || (kind === 'heading' ? !wrappedHeading : draft.kind !== kind && !(draft.kind === 'caption' && kind === 'text') && !wrappedHeading)) continue;
                // 悬挂缩进的条目（参考文献、编号列表）以回到左边界的新行开头。
                if (draft.lines.length >= 2 && line.x < last.x - font * 0.8) continue;
                // 表格的每一行是独立的单元格；只有断词续行或以小写、括号开头的续行才并入上一行所在的单元格。
                if (region?.kind === 'table' && (newTableRow(last, line, region) || !(/[-‐‑]$/u.test(last.text) || /^[\p{Ll}(]/u.test(line.text)))) continue;
                // 作者与单位、正文与脚注字号不同，即使左对齐也属于不同段落。
                if (Math.abs(line.fontSize - last.fontSize) > Math.max(0.6, last.fontSize * 0.18)) continue;
                const overlap = Math.min(right(line), right(last)) - Math.max(line.x, last.x);
                const sameColumn = Math.abs(line.x - last.x) <= font * 2.2 || (overlap >= Math.min(line.width, last.width) * 0.72 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= font * 2);
                if (gap <= 0 || !sameColumn) continue;
                // 悬挂缩进条目的首行占满栏宽，其后缩进的续行仍属于同一条目。
                const hangingContinuation = draft.lines.length === 1 && right(last) >= right(line) - 2 && line.x - last.x <= font * 3 && gap <= font * 1.32 * loose;
                if (/[.!?。！？]["')\]}]*$/u.test(last.text) && !hangingContinuation && (line.x - last.x > font * 0.8 || gap > font * 1.32 * loose)) continue;
                // 中日韩文字可以在任意位置折行，段落中间的行都排满栏宽；上一行明显没有排满，说明它是上一段的末行或一个小标题。
                // 以句末标点结束又没有排满的行同样是段落末行，不论文字种类。
                if ((cjkLine(last.text) || /[.!?。！？]$/u.test(last.text)) && !(hangingContinuation && line.x > last.x + 1) && right(last) < Math.max(right(line), columnRight(last)) - font * 2) continue;
                if (!selected || selected.lines.at(-1)!.baseline < last.baseline) selected = draft;
            }
        }
        if (selected) {selected.lines.push(line); selected.bounds = union(selected.bounds, line);}
        else {const draft = {lines: [line], kind, region, bounds: line}; drafts.push(draft); active.push(draft);}
    }
    // 密排表头里上下两行的单元格可能被当成一个单元格的续行；合并后的矩形一旦压到别的块上，就退回到一行一个单元格，译文才不会互相覆盖。
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
        const draft = drafts[index];
        if (draft.region?.kind !== 'table' || draft.lines.length < 2 || !drafts.some(other => other !== draft && overlaps(draft.bounds, other.bounds, -1))) continue;
        drafts.splice(index, 1, ...draft.lines.map(line => ({...draft, lines: [line], bounds: line as Rectangle})));
    }
    // 落在正文段落矩形里、字号明显更小的孤立短词是没有并回所在行的上下标（“p word”里的 word），保留原样。
    for (const draft of drafts) {
        const line = draft.lines[0];
        if (draft.kind !== 'text' || draft.lines.length > 1 || textUnits(line.text) >= 4) continue;
        const centerX = line.x + line.width / 2, centerY = line.y + line.height / 2;
        if (drafts.some(other => other !== draft && other.lines.length > 1 && (other.kind === 'text' || other.kind === 'caption') && line.fontSize <= other.lines[0].fontSize * 0.85
            && centerX >= other.bounds.x && centerX <= right(other.bounds) && centerY >= other.bounds.y && centerY <= bottom(other.bounds))) draft.kind = 'formula';
    }
    const blocks: PdfLayoutBlock[] = drafts.map(draft => {
        const first = draft.lines[0];
        const joined = draft.lines.reduce((text, line) => text ? /[-‐‑]$/u.test(text) && /^[a-z]/u.test(line.text) ? text.slice(0, -1) + line.text : cjkEdge.test(text.slice(-1) + line.text.slice(0, 1)) ? text + line.text : `${text} ${line.text}` : line.text, '');
        // 标题末尾抬高的小字是脚注标记（☆、*、a），不属于标题文字。
        const lastLine = draft.lines.at(-1)!, mark = lastLine.runs.at(-1) as PdfLayoutAtom;
        const marked = draft.kind === 'heading' && lastLine.runs.length > 1 && mark.fontSize <= lastLine.fontSize * 0.8 && mark.baseline < lastLine.baseline - lastLine.fontSize * 0.15
            && /^[\p{L}\d*†‡⇑☆]{1,2}$/u.test(mark.text.trim()) && joined.endsWith(mark.text.trim());
        // 两端撑开排版的中文在每个字之间都留了空；逐字带空格的原文会被当成一串单字来翻译。
        const spaced = joined.match(/[\p{Script=Han}] (?=[\p{Script=Han}])/gu)?.length ?? 0;
        const source = spaced >= 3 && spaced >= (joined.match(/[\p{Script=Han}]/gu)!.length - 1) * 0.6 ? joined.replace(/(?<=[\p{Script=Han}，。、；：（）]) (?=[\p{Script=Han}，。、；：（）])/gu, '') : marked ? joined.slice(0, -mark.text.trim().length).trimEnd() : joined;
        const leading = draft.lines.slice(1).map((line, index) => line.baseline - draft.lines[index].baseline);
        const center = draft.bounds.x + draft.bounds.width / 2;
        const centered = (draft.kind === 'heading' || draft.kind === 'metadata' || draft.kind === 'footer') && Math.abs(center - input.width / 2) <= input.width * 0.045;
        const cell = cellBounds(draft);
        return {...draft.bounds, source, ...(cell ? {cellBounds: cell} : {}), fontSize: median(draft.lines.map(line => line.fontSize)), lineHeight: leading.length ? median(leading) : first.fontSize, lineCount: draft.lines.length, fontFamily: first.fontFamily, fontWeight: draft.kind === 'heading' ? 700 : 400, textAlign: centered ? 'center' : 'left', kind: draft.kind, preserveSource: (draft.region ? draft.region.kind !== 'table' || !readable(source) : false) || draft.kind === 'metadata' || draft.kind === 'footer' || draft.kind === 'formula', lines: draft.lines};
    });
    // 每个连续排版带先读左列再读右列；通栏标题/正文充当列带之间的分隔。
    let readingOrder = 0;
    const ordered: PdfLayoutBlock[] = [];
    let band: PdfLayoutBlock[] = [];
    const flush = () => {
        const columns: Array<{start: number; end: number}> = [];
        // 并排的两栏在水平方向互不重叠；同一栏里缩进不同的块（收窄的摘要、居中的小标题、悬挂缩进）彼此重叠，仍按上下顺序阅读。
        // 先由多行的正文段落与题注确定各栏，再安放标题、单行文字和表格单元格（多行的单元格很窄，不能用来定栏）；每一组里从窄到宽，横跨两栏的块（居中的题注、跨栏的小标题）归入它碰到的最左一栏，但不把两栏连成一栏。
        const seed = (block: PdfLayoutBlock) => Number(!(block.lineCount > 1 && (block.kind === 'text' || block.kind === 'caption')));
        for (const block of [...band].sort((a, b) => seed(a) - seed(b) || a.width - b.width || a.x - b.x || a.y - b.y)) {
            const touched = columns.flatMap((range, index) => Math.min(right(block), range.end) - Math.max(block.x, range.start) > Math.min(block.width, range.end - range.start) * 0.5 ? [index] : []);
            if (!touched.length) {block.column = columns.length; columns.push({start: block.x, end: right(block)}); continue;}
            const target = touched.reduce((leftmost, index) => columns[index].start < columns[leftmost].start ? index : leftmost);
            block.column = target;
            // 正文段落完全盖住的几个窄栏（图旁的两行小标注、缩进的短段）其实都在这一栏里，并入同一栏。
            const absorbed = touched.length > 1 && !seed(block) && touched.every(index => columns[index].start >= block.x - 2 && columns[index].end <= right(block) + 2);
            if (absorbed) for (const index of touched) if (index !== target) {band.forEach(other => {if (other.column === index) other.column = target;}); columns[index] = {start: Infinity, end: -Infinity};}
            if (touched.length === 1 || absorbed) columns[target] = {start: Math.min(columns[target].start, block.x), end: Math.max(columns[target].end, right(block))};
        }
        // 栏号按从左到右重排。
        const rank = columns.map((_, index) => index).sort((a, b) => columns[a].start - columns[b].start);
        band.forEach(block => {block.column = rank.indexOf(block.column!);});
        // 真正的分栏是左右并排的；水平方向错开但一上一下的块（居中的题目与其下靠左的小标题）只是同一栏里的先后两块。
        const extent = (index: number) => band.filter(block => block.column === index).reduce((range, block) => ({top: Math.min(range.top, block.y), bottom: Math.max(range.bottom, bottom(block))}), {top: Infinity, bottom: -Infinity});
        const extents = columns.map((_, index) => extent(index)).filter(range => range.top < range.bottom);
        if (!extents.some((one, index) => extents.some((other, otherIndex) => otherIndex > index && Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top) > font * 0.5))) band.forEach(block => {block.column = 0;});
        ordered.push(...band.sort((a, b) => a.kind === 'metadata' && b.kind === 'metadata' ? a.y - b.y || a.x - b.x : a.column! - b.column! || a.y - b.y)); band = [];
    };
    for (const block of blocks.sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (block.width > input.width * 0.58 || (block.kind === 'heading' && block.textAlign === 'center') || block.kind === 'footer') {flush(); block.column = 0; ordered.push(block);}
        else band.push(block);
    }
    flush();
    ordered.forEach(block => {block.readingOrder = readingOrder++;});
    // 同一图带中的左右子图可能顶边不齐，按重叠高度识别同带后从左向右阅读。
    const regionBands: PdfPreservedRegion[][] = [];
    for (const region of regions.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const band = regionBands.at(-1);
        if (region.kind === 'figure' && band?.every(previous => previous.kind === 'figure') && band.some(previous => Math.min(bottom(region), bottom(previous)) - Math.max(region.y, previous.y) > Math.min(region.height, previous.height) * .5)) band.push(region);
        else regionBands.push([region]);
    }
    return {blocks: ordered, preservedRegions: regionBands.flatMap(band => band.sort((a, b) => a.x - b.x))};
}
