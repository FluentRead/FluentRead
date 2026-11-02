/**
 * @file src/features/document-translation/core/pdfLayoutAnalysis.ts
 * 文件职责：从 PDF 原始字形和绘图操作推导阅读顺序、段落与必须保留的公式、表格、插图区域。
 * 主要内容：在未旋转内容坐标中追踪绘图矩阵；按相邻行共同让出的竖带识别栏间距，松散的两端对齐行不被拆散；页眉页脚、数字/罗马数字/字母编号的标题、中英文题注与公式碎片分别归类，分栏由并排的正文段落确定、同栏内缩进不同的块按稳定基线组织阅读，字体顶边修正不打乱相邻栏的行序；图形在题注处断开，幻灯片内容框、段落底色和标题色带这类装文字的容器不算插图，原位重复描画的文字只读一次，表格碎横边先连接、按真实单元格及合并行边界切分并逐行阅读，含词语的单元格可以翻译；先按局部字形端点及父链关联上下标、避免跨表头基线吸附，以赋值、紧邻左花括号、多行值及同基线数学条件共同确认分段公式，保留其右侧条件和有几何/近邻证据的 TeX 大算符，已关联根号的下伸矩形覆盖相邻被开方字符，以同基线的冒号和纯符号箭头类型、或细线两端的数学节点及直接由数学节点支撑的正交短边确认独立数学标签，两端不复用支撑节点，有限 U 形返回箭头还须匹配同页已确认的类型函数名，先识别图表和独立公式，再按列与段落边界组织正文，仅对同段相邻行中以斜杠结束的 HTTP(S) 地址和含斜杠及数字的路径首词省去人工行间空格；重排保留列表符号并清理排版软连字符，保留逐行字形几何供阅读和导出使用。
 * 开放表格与数学边界：只有表头线的表格由相接表头框、重复数值列与独立表题共同确认；精确数学字框不改变导出字号，横向排版字号及相邻锚点决定伸展分隔符归行，分式单位由横线两侧字形与数学上下文确认。
 * 拼接边界：用 Unicode 锚定规则判断行尾与下一行首字，补充平面的汉字与常见汉字遵守相同规则，拉丁文折行仍保留必要的词间空格。
 * 重描边界：分级物理网格检查同位重描并跨相邻字号级查询；跨字体或提取分段时须完整字串、连续局部几何和相同外框共同确认，部分重叠与不同横向尺度保留。
 * 模块边界：纯几何分析，不加载 PDF.js、不访问 Canvas、网络或 DOM，不修改来源文字或文件。
 */
import type {PdfDocumentBlock, PdfDocumentLine, PdfDocumentRun, PdfPreservedRegion} from './document';

type Rectangle = Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>;
type Matrix = readonly number[];
export interface PdfLayoutAtom extends PdfDocumentRun {fontSize: number; baseline: number; fontFamily: string; layoutFontSize?: number}
export interface PdfGraphicsShape extends Rectangle {kind: 'image' | 'form' | 'path'}
export interface PdfGraphicsOperators {fnArray: readonly number[]; argsArray: readonly unknown[]}
export interface PdfLayoutBlock extends Omit<PdfDocumentBlock, 'segmentIndex'> {source: string}
interface LayoutLine extends PdfDocumentLine {baseline: number; fontSize: number; fontFamily: string; runs: PdfLayoutAtom[]}
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

/** 同位重描可以换字体或拆成不同文字项；完整文字和两端几何均相符时才去除。 */
function uniquePaintAtoms(atoms: readonly PdfLayoutAtom[]): PdfLayoutAtom[] {
    // 同级网格使用固定物理距离；跨级查询覆盖字号容差，巨大字体的邻域也保持有限桶数。
    const cellFor = (slack: number) => 2 ** Math.floor(Math.log2(Math.max(1, slack)));
    const metrics = new Map(atoms.map(atom => [atom, {fontSize: atom.fontSize, baseline: atom.baseline}]));
    const compact = new Map(atoms.map(atom => [atom, atom.text.replace(/\s/gu, '')]));
    const near = (index: Map<string, PdfLayoutAtom[]>, x: number, baseline: number, slack: number, forward = slack, text = '') => {
        const result: PdfLayoutAtom[] = [];
        for (const cell of new Set([cellFor(slack - .05), cellFor(slack + .05)])) {
            const firstColumn = Math.floor((x - slack) / cell), lastColumn = Math.floor((x + forward) / cell);
            const firstRow = Math.floor((baseline - slack) / cell), lastRow = Math.floor((baseline + slack) / cell);
            // 超出安全整数的绝对桶号不能逐一递增；不确定的坐标不做去重，保全原文字项。
            if (![firstColumn, lastColumn, firstRow, lastRow].every(Number.isSafeInteger)) continue;
            for (let dx = 0; dx <= lastColumn - firstColumn; dx++) {
                for (let dy = 0; dy <= lastRow - firstRow; dy++) {
                    for (const atom of index.get(`${cell}:${firstColumn + dx}:${firstRow + dy}:${text}`) ?? []) result.push(atom);
                }
            }
        }
        return result;
    };
    const add = (index: Map<string, PdfLayoutAtom[]>, atom: PdfLayoutAtom, text = '') => {
        const metric = metrics.get(atom)!, cell = cellFor(Math.max(1, metric.fontSize * .1));
        const key = `${cell}:${Math.floor(atom.x / cell)}:${Math.floor(metric.baseline / cell)}:${text}`, bucket = index.get(key);
        if (bucket) bucket.push(atom); else index.set(key, [atom]);
    };
    const slackFor = (atom: PdfLayoutAtom) => Math.max(1, metrics.get(atom)!.fontSize * .1);
    const sameBaseline = (a: PdfLayoutAtom, b: PdfLayoutAtom, slack: number) => {
        const first = metrics.get(a)!, next = metrics.get(b)!;
        return Math.abs(first.baseline - next.baseline) <= slack && Math.abs(first.fontSize - next.fontSize) <= .5;
    };
    const sameDrawing = (index: Map<string, PdfLayoutAtom[]>, atom: PdfLayoutAtom, text: string) => {
        const slack = slackFor(atom);
        return near(index, atom.x, metrics.get(atom)!.baseline, slack, slack, text).some(other =>
            Math.abs(other.x - atom.x) <= Math.min(slack, atom.width / 2, other.width / 2) && Math.abs(other.width - atom.width) <= slack
            && sameBaseline(atom, other, slack));
    };
    const drawn = new Map<string, PdfLayoutAtom[]>();
    const unique = atoms.filter(atom => {
        const text = compact.get(atom)!;
        if (!text) return true;
        if (sameDrawing(drawn, atom, text)) return false;
        add(drawn, atom, text);
        return true;
    });
    // 两次绘制都可能拆成不同片段，完全没有“整句”文字项。只把按绘制顺序物理连续的片段
    // 组成分析用候选；输出仍保留原字形对象，候选自身的片段绝不能被自己当作重描删除。
    const composites = new Map<PdfLayoutAtom, PdfLayoutAtom[]>();
    let pieces: PdfLayoutAtom[] = [];
    const finish = () => {
        if (pieces.length > 1) {
            const first = pieces[0], bounds = pieces.slice(1).reduce<Rectangle>(union, first);
            const candidate = {...first, ...bounds, text: joinRuns(pieces)};
            composites.set(candidate, pieces);
            metrics.set(candidate, metrics.get(first)!);
            compact.set(candidate, candidate.text.replace(/\s/gu, ''));
        }
        pieces = [];
    };
    for (const atom of unique) {
        if (!compact.get(atom)) {finish(); continue;}
        const first = pieces[0], last = pieces.at(-1);
        if (last && (!sameBaseline(first, atom, slackFor(first)) || atom.x <= last.x
            || atom.x < right(last) - Math.min(slackFor(first), last.width * .25) || atom.x - right(last) > metrics.get(first)!.fontSize * .6)) finish();
        pieces.push(atom);
    }
    finish();
    const starts = new Map<string, PdfLayoutAtom[]>(), compositeDrawn = new Map<string, PdfLayoutAtom[]>(), removed = new Set<PdfLayoutAtom>();
    for (const [candidate, parts] of composites) {
        const text = compact.get(candidate)!;
        if (sameDrawing(compositeDrawn, candidate, text)) parts.forEach(part => removed.add(part));
        else add(compositeDrawn, candidate, text);
    }
    unique.forEach(atom => {if (compact.get(atom) && !removed.has(atom)) add(starts, atom);});
    // 先考察宽项，使“整句 + 若干不同字体片段”的保留结果不依赖 PDF 绘制顺序。
    for (const whole of [...unique].sort((a, b) => b.width - a.width)) {
        const text = compact.get(whole)!;
        if (removed.has(whole) || text.length < 2 || whole.width <= 0) continue;
        const slack = slackFor(whole), visited = new Map<PdfLayoutAtom, Set<number>>();
        interface ChainState {offset: number; end: number; part?: PdfLayoutAtom; previous?: ChainState}
        const pending: ChainState[] = [{offset: 0, end: whole.x}];
        while (pending.length) {
            const current = pending.pop()!, {offset, end} = current;
            if (offset === text.length) {
                if (Math.abs(end - right(whole)) > slack) continue;
                for (let state: ChainState | undefined = current; state?.part; state = state.previous) removed.add(state.part);
                break;
            }
            const candidates = near(starts, end, metrics.get(whole)!.baseline, slack, offset ? metrics.get(whole)!.fontSize * .6 : slack).filter(part => {
                const value = compact.get(part)!;
                return !(part === whole || removed.has(part) || value.length >= text.length || !text.startsWith(value, offset)
                    || part.width <= 0 || !sameBaseline(whole, part, slack) || part.x < end - slack
                    || part.x > end + (offset ? metrics.get(whole)!.fontSize * .6 : slack) || right(part) <= end || right(part) > right(whole) + slack
                    || visited.get(part)?.has(offset));
            });
            const closest = candidates.reduce((distance, part) => Math.min(distance, Math.abs(part.x - end)), Infinity);
            for (const part of candidates) {
                // 连续绘制必须接上最近的同字串片段；不能跳过邻近的相同字形再用远处字形拼出重复文字。
                if (Math.abs(part.x - end) > closest + Math.min(slack, part.width * .25)) continue;
                const positions = visited.get(part) ?? new Set<number>(); positions.add(offset); visited.set(part, positions);
                pending.push({offset: offset + compact.get(part)!.length, end: right(part), part, previous: current});
            }
        }
    }
    return unique.filter(atom => !removed.has(atom));
}

/** 基线而非字形顶边决定同一行，上下标仍保留自己的矩形和文字。 */
export function pdfLayoutLines(atoms: readonly PdfLayoutAtom[], verticalDividers: readonly Rectangle[] = []): LayoutLine[] {
    const rows: Array<{runs: PdfLayoutAtom[]; font: number; baseline: number; samples: number; first: number}> = [];
    const rowMembership = new Map<PdfLayoutAtom, (typeof rows)[number]>();
    const unique = uniquePaintAtoms(atoms);
    // TeX 根号字形的基线可能抬高到上一行；被开方字形紧贴根号右端，按它的基线归行。
    const associated = unique.map(atom => {
        // 向量箭头、单位向量帽号与主字形重叠且位于其上方，先归到主字形基线。
        // 否则一排重音符会成为稀疏的独立行，并被误用作正文中的栏间留白证据。
        if (/^[→^]$/u.test(atom.text)) {
            const base = unique.find(other => /^[\p{L}]$/u.test(other.text) && other.fontSize >= atom.fontSize * 0.85 && other.fontSize <= atom.fontSize * 1.2
                && other.baseline - atom.baseline >= atom.fontSize * 0.4 && other.baseline - atom.baseline <= atom.fontSize
                && Math.abs(other.x + other.width / 2 - atom.x - atom.width / 2) <= atom.fontSize * 0.25);
            if (base) return {...atom, baseline: base.baseline};
        }
        if (atom.text !== '√') return atom;
        const next = unique.filter(other => other !== atom && /^[\p{L}\d(]/u.test(other.text)
            && Math.abs(other.x - right(atom)) <= atom.fontSize * 0.35 && other.fontSize >= atom.fontSize * 0.8
            && other.baseline - atom.baseline > atom.fontSize * 0.35 && other.baseline - atom.baseline <= atom.fontSize)
            .sort((a, b) => Math.abs(a.x - right(atom)) - Math.abs(b.x - right(atom)) || a.baseline - b.baseline)[0];
        // 字体的通用 ascent 会低估根号下伸笔画；只在已有相邻字符证据时扩展底边，不移动原字形。
        return next ? {...atom, baseline: next.baseline, height: Math.max(bottom(atom), bottom(next)) - atom.y} : atom;
    });
    // 上下标先按物理相邻且字号更大的局部字形归行，再参与全页基线分组。
    // 不能借用其它表格列的居中基线，把“×10”的上标归到上一行表头。
    const layoutFont = (atom: PdfLayoutAtom) => atom.layoutFontSize ?? atom.fontSize;
    const groupingBases = new Map<PdfLayoutAtom, PdfLayoutAtom>();
    const largestFont = associated.reduce((size, atom) => Math.max(size, layoutFont(atom)), 0);
    const endpoints = new Map<string, PdfLayoutAtom[]>();
    const proseStarts = new Map<string, PdfLayoutAtom[]>();
    const scale = Math.max(1, largestFont);
    for (const atom of associated) {
        const key = `${Math.floor(right(atom) / scale)}:${Math.floor(atom.baseline / scale)}`;
        const bucket = endpoints.get(key);
        if (bucket) bucket.push(atom); else endpoints.set(key, [atom]);
        if (atom.text.length > 5) {
            const key = `${Math.floor(atom.x / scale)}:${Math.floor(atom.baseline / scale)}`, bucket = proseStarts.get(key);
            if (bucket) bucket.push(atom); else proseStarts.set(key, [atom]);
        }
    }
    const localBases = (atom: PdfLayoutAtom, x = atom.x, buckets = endpoints) => {
        const column = Math.floor(x / scale), row = Math.floor(atom.baseline / scale);
        const candidates: PdfLayoutAtom[] = [];
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) candidates.push(...buckets.get(`${column + dx}:${row + dy}`) || []);
        return candidates;
    };
    // 仅在已经找到脚标候选时检查正文邻居；普通短词不必额外分配和扫描第二组空间桶。
    const inlineProse = (atom: PdfLayoutAtom, nearby: readonly PdfLayoutAtom[]) => {
        const sameProse = (other: PdfLayoutAtom) => other.text.length > 5 && Math.abs(layoutFont(other) - layoutFont(atom)) <= layoutFont(atom) * 0.15
            && Math.abs(other.baseline - atom.baseline) <= Math.max(1, layoutFont(atom) * 0.15)
            && (atom.x >= right(other) && atom.x - right(other) <= layoutFont(atom) * 0.6 || other.x >= right(atom) && other.x - right(atom) <= layoutFont(atom) * 0.6);
        return nearby.some(sameProse) || localBases(atom, right(atom), proseStarts).some(sameProse);
    };
    // 拉伸分隔符的绘制基线偏移不代表另一行；以实际字框中心和同横向字号的紧邻字形定位正文基线。
    for (const atom of associated) {
        if (!atom.layoutFontSize) continue;
        const center = atom.y + atom.height / 2;
        const base = localBases(atom).filter(other => other !== atom && !other.layoutFontSize
            && Math.abs(layoutFont(other) - layoutFont(atom)) <= layoutFont(atom) * .15
            && Math.max(other.x - right(atom), atom.x - right(other)) <= layoutFont(atom) * 1.5
            && Math.abs(other.y + other.height / 2 - center) <= layoutFont(atom) * .5)
            .sort((a, b) => Math.abs(a.y + a.height / 2 - center) - Math.abs(b.y + b.height / 2 - center))[0];
        if (base) groupingBases.set(atom, base);
    }
    for (const atom of [...associated].sort((a, b) => layoutFont(b) - layoutFont(a))) {
        if (groupingBases.has(atom) || layoutFont(atom) > largestFont * 0.8 || atom.text.length > 24) continue;
        const nearby = localBases(atom);
        const bases = nearby.filter(other => other.x < atom.x && layoutFont(atom) <= layoutFont(other) * 0.8
            && (atom.text.length <= 5 && atom.width <= layoutFont(other) * 2
                || /^[\p{L}\d]$/u.test(other.text) && atom.width <= layoutFont(other) * 6 && Math.abs(atom.baseline - other.baseline) <= layoutFont(other) * .5)
            && Math.abs(atom.x - right(other)) <= layoutFont(other) * 0.5
            && Math.abs(atom.baseline - other.baseline) <= layoutFont(other) * 0.8);
        const base = bases.sort((a, b) => Math.abs(atom.baseline - a.baseline) - Math.abs(atom.baseline - b.baseline))[0];
        // 拉伸数学括号可能比下一行正文大得多；紧贴同字号、同基线长正文的短词不能吸成上一行下标。
        if (base && !inlineProse(atom, nearby)) groupingBases.set(atom, base);
    }
    const groupingRoot = (atom: PdfLayoutAtom) => {
        while (groupingBases.has(atom)) atom = groupingBases.get(atom)!;
        return atom;
    };
    // 同一上标可由多个字形及其嵌套下标组成；已确认的局部基行沿紧邻脚标延续，不能留下半个脚标成为另一行。
    for (const atom of [...associated].sort((a, b) => a.x - b.x)) {
        if (groupingBases.has(atom) || layoutFont(atom) > largestFont * 0.8 || atom.text.length > 5) continue;
        const nearby = localBases(atom);
        const peer = nearby.find(other => other.x < atom.x && groupingBases.has(other) && layoutFont(atom) <= layoutFont(groupingRoot(other)) * 0.8
            && Math.abs(atom.x - right(other)) <= Math.max(layoutFont(atom), layoutFont(other)) * 0.5
            && Math.abs(atom.baseline - other.baseline) <= Math.max(layoutFont(atom), layoutFont(other)) * 0.35);
        if (peer && !inlineProse(atom, nearby)) groupingBases.set(atom, peer);
    }
    const groupingBaseline = (atom: PdfLayoutAtom) => groupingRoot(atom).baseline;
    for (const atom of associated.sort((a, b) => groupingBaseline(a) - groupingBaseline(b) || a.x - b.x)) {
        const row = rows.at(-1);
        const baseline = groupingBaseline(atom);
        const tolerance = row ? Math.max(2, Math.max(row.font, layoutFont(atom)) * 0.5) : 0;
        // 同一行同时含抬高的上标与降低的下标时，二者跨度稍大；下标仍须贴近主行基线，不能单凭早来的上标将它切成下一行。
        const firstTolerance = row && layoutFont(atom) <= row.font * 0.8 ? Math.max(tolerance, row.font * 0.8) : tolerance;
        // 另一栏较高的公式不应切断本栏相邻的正文；只在越过首基线时查已入行的局部正文端点，避免全行扫描。
        const localContinuation = row && baseline - row.first > firstTolerance
            && localBases(atom, right(atom), proseStarts).some(other => rowMembership.get(other) === row
                && Math.abs(groupingBaseline(other) - baseline) <= layoutFont(atom) * .25
                && Math.abs(other.x - right(atom)) <= layoutFont(atom) * 2);
        // 双栏行距不同时，一栏的基线会落在另一栏两行之间；只与行首基线比较，避免它把上下两行接力串成一行。
        if (!row || Math.abs(baseline - row.baseline) > tolerance || baseline - row.first > firstTolerance && !localContinuation) rows.push({runs: [atom], font: layoutFont(atom), baseline, samples: 1, first: baseline});
        else {
            row.runs.push(atom);
            if (layoutFont(atom) > row.font * 1.15) {row.font = layoutFont(atom); row.baseline = baseline; row.samples = 1;}
            else if (layoutFont(atom) >= row.font * 0.85) {row.baseline = (row.baseline * row.samples + baseline) / (row.samples + 1); row.samples += 1;}
        }
        if (atom.text.length > 5) rowMembership.set(atom, rows.at(-1)!);
    }
    const result: LayoutLine[] = [];
    const ordered = rows.map(row => [...row.runs].sort((a, b) => a.x - b.x));
    const clearAt = (row: readonly PdfLayoutAtom[], x: number) => !row.some(run => run.x < x + 1.5 && right(run) > x - 1.5);
    const adjacent = (at: number, from: number, font: number) => Boolean(rows[at]) && Math.abs(rows[at].baseline - rows[from].baseline) <= font * 2.2;
    // 行内根号等细笔画不覆盖整行高度，不能当作单元格分隔线。
    const divided = (start: number, end: number, baseline: number, font: number) => verticalDividers.some(divider => divider.height >= font && divider.x >= start - 0.5 && right(divider) <= end + 0.5
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
    // 两侧排版基线不一致时，数学项的词距可能接近窄栏间距；另外两排独立
    // 的长正文在相同左右端点停靠，才允许绕过单排词距比例，不能凭一条空白拆行。
    const alignedGutter = (rowIndex: number, start: number, end: number, font: number): boolean => {
        let support = 0;
        for (const direction of [-1, 1]) for (let distance = 1; distance <= 32; distance++) {
            const index = rowIndex + direction * distance;
            if (index < 0 || index >= rows.length) break;
            const row = ordered[index];
            // 栏内段落行距可不同；在连续留白带内找边界，遇到跨栏正文即停止，每侧最多检查32行。
            if (!clearAt(row, (start + end) / 2)) break;
            const left = row.filter(run => right(run) <= start + Math.max(1.5, font * .3));
            if (!left.length || start - right(left.at(-1)!) > font * 2 || right(left.at(-1)!) - left[0].x < font * 6) continue;
            const rightIndex = row.findIndex(run => Math.abs(run.x - end) <= Math.max(1.5, font * .3));
            if (rightIndex < 0) continue;
            let rightEdge = right(row[rightIndex]), hasProse = /\p{L}{3}/u.test(row[rightIndex].text);
            // 三栏索引的数字、逗号是同一栏的连续片段；不能借用再下一栏的宽度作证据。
            for (let index = rightIndex + 1; index < row.length && row[index].x - rightEdge <= font * 1.2; index++) {
                rightEdge = Math.max(rightEdge, right(row[index])); hasProse ||= /\p{L}{3}/u.test(row[index].text);
            }
            if (hasProse && rightEdge - end >= font * (start - right(left.at(-1)!) > 1.5 ? 8 : 6) && ++support >= 2) return true;
        }
        return false;
    };
    for (const [rowIndex, row] of ordered.entries()) {
        const bodyFont = median(row.map(run => layoutFont(run)));
        const groups: PdfLayoutAtom[][] = [];
        // 两端对齐的松散行会把每个词间距都拉到接近一个字宽；只有明显大于本行词距、且被邻行让出的空白才是栏间距。
        const gaps: number[] = [];
        let end = -Infinity;
        for (const run of row) {
            if (run.x - end > bodyFont * 0.15 && end > -Infinity) gaps.push(run.x - end);
            end = Math.max(end, right(run));
        }
        end = -Infinity;
        for (const [runIndex, run] of row.entries()) {
            const gap = run.x - end;
            let split = !groups.length || divided(end, run.x, rows[rowIndex].baseline, bodyFont);
            if (!split && (gap > Math.max(6, bodyFont * 0.9) || gap > bodyFont * .4 && run.width >= bodyFont * 10 && end - groups.at(-1)![0].x >= bodyFont * 10 && alignedGutter(rowIndex, end, run.x, bodyFont))) {
                const others = [...gaps]; others.splice(others.indexOf(gap), 1);
                const support = gutterSupport(rowIndex, end, run.x, bodyFont);
                const next = row[runIndex + 1], previous = groups.at(-1)!.at(-1)!;
                const inlineOperator = /^[=<>≤≥≠∝≈±×÷]$/u.test(run.text) && next && /\p{L}{3}/u.test(previous.text)
                    && /\p{L}{3}/u.test(next.text) && next.x - right(run) <= bodyFont * 1.2;
                if (gap < bodyFont * 1.2 && (inlineOperator || run.text.length >= 6 && /[a-z]{3}|[\p{Script=Han}]{3}/iu.test(run.text))
                    && !alignedGutter(rowIndex, end, run.x, bodyFont)) {groups.at(-1)!.push(run); end = Math.max(end, right(run)); continue;}
                split = (support < 0 ? gap >= bodyFont * 2.5 : support === 1) && (!others.length || gap >= bodyFont * 2.5 || gap >= median(others) * 1.8 || alignedGutter(rowIndex, end, run.x, bodyFont));
            }
            if (split) groups.push([run]);
            else groups.at(-1)!.push(run);
            end = Math.max(end, right(run));
        }
        for (let index = 0; index < groups.length - 1; index += 1) {
            const previous = groups[index], next = groups[index + 1];
            // Word 的显式项目符号常被稳定窄空白带拆成一列；它与同基线文字是一个条目，不能把全部符号留作一栏公式。
            const marker = previous.length === 1 && /^[•◦▪■□◆◇●○▶►➢➤❖·§Ø\uE000-\uF8FF]$/u.test(previous[0].text.trim());
            if ((marker || /^\d+(?:\.\d+)*$/u.test(joinRuns(previous)) && /^[A-Z]/u.test(joinRuns(next))) && next[0].x - right(previous.at(-1)!) <= bodyFont * 2.5
                && !divided(right(previous.at(-1)!), next[0].x, rows[rowIndex].baseline, bodyFont)) {previous.push(...next); groups.splice(index + 1, 1);}
        }
        for (const runs of groups) {
            const bounds = runs.reduce<Rectangle>((box, run) => union(box, run), runs[0]);
            const dominant = [...runs].sort((a, b) => b.width - a.width)[0];
            const fontSize = median(runs.filter(run => layoutFont(run) >= layoutFont(dominant) * 0.85).map(run => layoutFont(run)));
            result.push({...bounds, text: joinRuns(runs), baseline: median(runs.filter(run => layoutFont(run) >= fontSize * 0.85).map(run => run.baseline)), fontSize, fontFamily: dominant.fontFamily, runs: runs.map(run => ({...run}))});
        }
    }
    return result.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const cjkGlyphs = new RegExp(`[${CJK}]`, 'gu');
const cjkGlyph = new RegExp(`[${CJK}]`, 'u');
/** 以中日韩文字为主的一行：这些文字占去非空白字符的一半以上。 */
const cjkLine = (text: string) => (text.match(cjkGlyphs)?.length ?? 0) * 2 >= text.replace(/\s/gu, '').length;
/** 上一行以中日韩文字或全角标点结尾、下一行以它们开头时，折行处不应补空格。 */
const cjkLineEnd = new RegExp(`[${CJK}，。、；：！？（）《》“”]$`, 'u');
const cjkLineStart = new RegExp(`^[${CJK}，。、；：！？（）《》“”]`, 'u');
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
        // 后续图注切分会裁剪此框；不能修改调用方保留的原始图形。
        let merged: Rectangle = {...shape};
        for (let index = figures.length - 1; index >= 0; index -= 1) {
            if (overlaps(merged, figures[index], 2)) {merged = union(merged, figures[index]); figures.splice(index, 1);}
        }
        figures.push(merged);
    }
    // 许多小底框首尾相接也会并成一个圈住整页文字的大区域，合并之后再检查一次。
    return figures.filter(figure => !container(figure));
}
function tableRegions(shapes: readonly PdfGraphicsShape[], width: number, figures: readonly Rectangle[]): Rectangle[] {
    // Word 将同一横边按单元格分别绘制；先连接同基线的相接片段，再判断整条表线的宽度，不能丢掉狭窄的前几列。
    const rows: Rectangle[] = [];
    for (const shape of shapes.filter(shape => shape.kind === 'path' && shape.width >= 6 && shape.height <= 2 && !figures.some(figure => overlaps(shape, figure)))) {
        let row: Rectangle = shape;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const previous = rows[index];
            if (Math.abs(previous.y - row.y) <= 1.5 && previous.x <= right(row) + 1.5 && right(previous) + 1.5 >= row.x) {
                row = union(row, previous); rows.splice(index, 1);
            }
        }
        rows.push(row);
    }
    const wideRows = rows.filter(row => row.width >= width * .2).sort((a, b) => a.y - b.y);
    const groups: Rectangle[][] = [];
    for (const row of wideRows) {
        const group = groups.find(group => {
            const last = group.at(-1)!;
            return row.y - last.y <= 150 && Math.min(right(row), right(last)) - Math.max(row.x, last.x) >= Math.min(row.width, last.width) * 0.7;
        });
        if (group) group.push(row); else groups.push([row]);
    }
    return groups.filter(group => group.length >= 2).map(group => {
        const box = group.reduce(union);
        // 有些网格省略最后一行的底横线；两条分列竖边在同一高度结束，仍能确定完整末行。
        // 竖边必须穿过最后两条横线，单条装饰线和远处图形不能延伸表格。
        const endings = shapes.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4
            && shape.x >= box.x - 2 && right(shape) <= right(box) + 2 && shape.y <= group.at(-2)!.y + 2
            && bottom(shape) > bottom(box) + 2 && bottom(shape) <= bottom(box) + 150);
        let end = bottom(box);
        for (const edge of endings) if (endings.some(other => Math.abs(other.x - edge.x) >= 6 && Math.abs(bottom(other) - bottom(edge)) <= 1.5)) end = Math.max(end, bottom(edge));
        return {...box, y: Math.max(0, box.y - 1), height: end - box.y + 2};
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
    // 先排除非数学文字，再检查几何相邻正文；否则每一行都会对全页正文重复分词。
    return line.text.length < 150 && line.width < pageWidth * 0.75 && /[=≔∑∫√∈≃≅≈≡≤≥≠¼]|ð[^Þ]*Þ|(?:softmax|Concat|FFN|MultiHead)\s*\(/u.test(line.text)
        && (Math.abs(line.x + line.width / 2 - pageWidth / 2) < pageWidth * 0.23 || /^[A-Za-z][\w (){},.]*\s*=/u.test(line.text) || /¼|ð[^Þ]*Þ/u.test(line.text))
        && !/^(?:Figure|Table)\s+\d/iu.test(line.text)
        && !/\b(?:the|we|our|of|to|and|is|in|this|with|for|that|use|each|are|from|used)\b/iu.test(line.text)
        // 与上下行同栏等宽、行距正常的行是两端对齐的正文，即使含有等号也不是独立公式。
        && !lines.some(near => near !== line && Math.abs(near.x - line.x) <= 1 && Math.abs(near.width - line.width) <= 2
            && Math.abs(near.baseline - line.baseline) <= font * 1.6 && near.text.split(/\s+/u).length >= 5);
}

/**
 * TeX 的伸展左花括号可能只有 0.04em 的 ascent，不能靠它的字形顶边猜整组公式的边界。
 * 仅当赋值右侧确有花括号、至少两行对齐值及同基线的数学条件时扩展原图区域；普通 if 句和邻近正文不能单独触发。
 */
function piecewiseFormulaBounds(seed: LayoutLine, lines: readonly LayoutLine[], font: number): Rectangle | undefined {
    if (!/[=≔]\s*$/u.test(seed.text)) return;
    const braces = lines.flatMap(line => line.runs.filter(run => run.text.trim() === '{'
        && run.x >= right(seed) - font * 0.5 && run.x <= right(seed) + font * 1.5
        && Math.abs(run.baseline - seed.baseline) <= font * 2.5));
    for (const brace of braces) {
        const values = lines.filter(line => line !== seed && line.x >= right(brace) - 1 && line.x <= right(brace) + font * 1.2
            && Math.abs(line.baseline - seed.baseline) <= font * 2.5 && line.width <= font * 18
            && line.fontSize >= seed.fontSize * 0.6 && line.fontSize <= seed.fontSize * 1.2 && textUnits(line.text) <= 4);
        if (values.length < 2 || !values.some(first => values.some(second => second.baseline - first.baseline >= font * 0.8))) continue;
        const conditions = lines.filter(line => /^(?:(?:if|when|for)\b.{0,90}[=<>≤≥≠∈]|otherwise\b)/iu.test(line.text)
            && line.text.length <= 100 && values.some(value => Math.abs(line.baseline - value.baseline) <= font * 0.5
                && line.x >= right(value) + font * 0.5 && line.x <= right(value) + font * 5));
        if (!conditions.some(line => !/^otherwise\b/iu.test(line.text))) continue;
        return [...values, ...conditions].reduce<Rectangle>((bounds, line) => union(bounds, line), union(seed, brace));
    }
}

/** 仅正文范围、正文字号的孤立标识可成为数学标签；词本身不构成保留依据。 */
function isolatedMathLabels(lines: readonly LayoutLine[], graphics: readonly PdfGraphicsShape[], font: number, width: number, height: number): Set<LayoutLine> {
    const labels = new Set<LayoutLine>();
    const body = lines.filter(line => line.y >= height * 0.065 && bottom(line) <= height * 0.945
        && line.fontSize <= font * 1.1 && line.width <= width * 0.5);
    const local = body.filter(line => line.width <= font * 12);
    const names = local.filter(line => /^[\p{L}\p{N}_]{1,32}$/u.test(line.text));
    const typedNames = new Set<string>();
    const recordName = (line: LayoutLine, name: string) => {
        let remaining = name.length, stem = '', scripted = false, trailing = true;
        for (const run of line.runs) {
            if (!remaining) break;
            const part = run.text.trim().slice(0, remaining); remaining -= part.length;
            // 别名只去掉已确认类型名称末尾、字号更小且基线降低的下标；普通同字号希腊字母不被剥离。
            const script = run.fontSize <= line.fontSize * 0.8 && run.baseline - line.baseline >= line.fontSize * 0.15
                && run.baseline - line.baseline <= line.fontSize * 0.8;
            if (script) scripted = true;
            else {if (scripted) trailing = false; stem += part;}
        }
        typedNames.add(name); typedNames.add(trailing ? stem : name);
    };
    // 普通双字母词（is、UK 等）也不构成数学证据；只认单字变量、数学样式字符与算符/数学标点。
    const symbolic = (text: string) => /^(?:[A-Za-z0-9_\p{Script=Greek}\p{M}\u{1D400}-\u{1D7FF}]|\p{Sm}|(?=\p{Math})[\u2100-\u214F]|[\s()[\]{},.'′″*:/-])+$/u.test(text)
        && !/[A-Za-z\p{Script=Greek}]{2}/u.test(text);
    const type = (text: string) => /[→↦]/u.test(text) && /[\p{L}\p{N}]/u.test(text) && symbolic(text);
    const types = local.filter(line => type(line.text));
    for (const line of body) {
        const signature = line.text.match(/^([\p{L}\p{N}_]{1,32})\s*:\s*(.+)$/u);
        if (signature && type(signature[2])) {labels.add(line); recordName(line, signature[1]);}
        // PDF 的词距会把名称、冒号、类型拆成三行；必须左右紧邻且基线一致，不能跨栏或跨正文行推断。
        if (line.text !== ':' || !types.some(after => after.x >= right(line) && after.x - right(line) <= font * 1.5
            && Math.abs(after.baseline - line.baseline) <= font * 0.3)) continue;
        const name = names.find(before => right(before) <= line.x && line.x - right(before) <= font * 1.5
            && Math.abs(before.baseline - line.baseline) <= font * 0.3);
        if (name) {labels.add(name); recordName(name, name.text);}
    }
    if (!graphics.length) return labels;
    const nodes = local.filter(line => symbolic(line.text) && /\p{L}/u.test(line.text));
    const strokes = graphics.filter(stroke => stroke.kind === 'path' && Math.min(stroke.width, stroke.height) <= 1
        && Math.max(stroke.width, stroke.height) >= font * 2 && Math.max(stroke.width, stroke.height) <= font * 12);
    // 图中的箭头也会接到另一条数学边的内部；这条边必须直接邻接两个不同数学节点，不能递归借用其它边。
    const nearNode = (x: number, y: number, except?: LayoutLine) => nodes.find(node => node !== except
        && Math.max(node.x - x, x - right(node), 0) <= font * 1.5 && Math.max(node.y - y, y - bottom(node), 0) <= font * 1.5);
    const edges: Array<{shape: PdfGraphicsShape; nodes: [LayoutLine, LayoutLine]}> = [];
    for (const shape of strokes) {
        const horizontal = shape.width > shape.height;
        const start = nearNode(shape.x, shape.y), end = start && nearNode(horizontal ? right(shape) : shape.x, horizontal ? shape.y : bottom(shape), start);
        if (start && end) edges.push({shape, nodes: [start, end]});
    }
    for (const stroke of strokes) {
        const horizontal = stroke.width > stroke.height;
        const length = horizontal ? stroke.width : stroke.height;
        const endX = horizontal ? right(stroke) : stroke.x, endY = horizontal ? stroke.y : bottom(stroke);
        const endpoint = (x: number, y: number, except: readonly LayoutLine[] = []): readonly LayoutLine[] | undefined => {
            const node = nodes.find(node => !except.includes(node) && Math.abs(node.x + node.width / 2 - x) <= font * 1.5
                && Math.abs(node.y + node.height / 2 - y) <= font * 1.5);
            if (node) return [node];
            return edges.find(edge => {
                const crossing = edge.shape.width > edge.shape.height;
                if (crossing === horizontal || edge.nodes.some(node => except.includes(node))) return false;
                const along = crossing ? x - edge.shape.x : y - edge.shape.y;
                const gap = crossing ? Math.abs(y - edge.shape.y) : Math.abs(x - edge.shape.x);
                return along >= font && along <= Math.max(edge.shape.width, edge.shape.height) - font && gap <= font;
            })?.nodes;
        };
        const start = endpoint(stroke.x, stroke.y);
        if (!start || !endpoint(endX, endY, start)) continue;
        for (const name of names) {
            const along = horizontal ? name.x + name.width / 2 - stroke.x : name.y + name.height / 2 - stroke.y;
            const gap = horizontal ? Math.max(stroke.y - bottom(name), name.y - bottom(stroke), 0)
                : Math.max(stroke.x - right(name), name.x - right(stroke), 0);
            if (along >= font && along <= length - font && gap <= font) labels.add(name);
        }
    }
    const returnNames = names.filter(name => typedNames.has(name.text));
    if (!returnNames.length) return labels;
    // 只为同页纯类型签名已经确认的函数识别有限 U 形返回箭头；不把长线一般化为数学边，也不沿图递归。
    for (const base of graphics) {
        if (base.kind !== 'path' || base.height > 1 || base.width < font * 2 || base.width > Math.min(width * 0.5, font * 24)) continue;
        const nearby = returnNames.filter(name => {
            const along = name.x + name.width / 2 - base.x, gap = base.y - bottom(name);
            return along >= font && along <= base.width - font && gap >= 0 && gap <= font;
        });
        if (!nearby.length) continue;
        const legs = strokes.filter(stroke => stroke.height > stroke.width && Math.abs(bottom(stroke) - base.y) <= font * 0.5);
        const left = legs.find(leg => Math.abs(leg.x - base.x) <= font * 0.5);
        const rightLeg = legs.find(leg => leg !== left && Math.abs(leg.x - right(base)) <= font * 0.5);
        if (!left || !rightLeg) continue;
        const start = nearNode(left.x, left.y), end = start && nearNode(rightLeg.x, rightLeg.y, start);
        if (!start || !end) continue;
        for (const name of nearby) if (name.y >= Math.max(left.y, rightLeg.y) + font) labels.add(name);
    }
    return labels;
}

/** 只有表头横线的开放表格：相接表头框、连续数字列与下方独立表题共同给出边界。 */
function captionedTableGeometry(atoms: readonly PdfLayoutAtom[], shapes: readonly PdfGraphicsShape[], width: number): Array<{bounds: Rectangle; dividers: Rectangle[]}> {
    const captions = atoms.filter(atom => /^Table\s+\d+[.．]\d+\s+\p{Lu}/u.test(atom.text));
    if (!captions.length) return [];
    const font = median(atoms.map(atom => atom.layoutFontSize ?? atom.fontSize));
    const headers = shapes.filter(shape => shape.kind === 'path' && shape.width >= font * 4 && shape.height >= font && shape.height <= font * 5);
    const groups: PdfGraphicsShape[][] = [];
    for (const header of headers.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const group = groups.find(group => Math.abs(group[0].y - header.y) <= 1 && Math.abs(group[0].height - header.height) <= 1 && Math.abs(right(group.at(-1)!) - header.x) <= 1);
        if (group) group.push(header); else groups.push([header]);
    }
    const result: Array<{bounds: Rectangle; dividers: Rectangle[]}> = [];
    for (const group of groups) {
        if (group.length < 2) continue;
        const header = group.reduce<Rectangle>(union, group[0]);
        if (header.width < width * .2 || !group.every(cell => shapes.some(rule => rule.kind === 'path' && rule.height <= 2
            && Math.abs(bottom(rule) - bottom(cell)) <= 2 && rule.x <= cell.x + 1 && right(rule) >= right(cell) - 1))) continue;
        const caption = captions.filter(atom => atom.y > bottom(header) && Math.abs(atom.x - header.x) <= font).sort((a, b) => a.y - b.y)[0];
        if (!caption) continue;
        const body = atoms.filter(atom => atom.baseline > bottom(header) && bottom(atom) < caption.y
            && atom.x >= header.x - 1 && right(atom) <= right(header) + 1);
        const numbers = body.filter(atom => /^\d/u.test(atom.text) && atom.width >= font * .5);
        if (new Set(numbers.map(atom => Math.round(atom.baseline / (font * .5)))).size < 3
            || body.filter(atom => /\p{L}{3}/u.test(atom.text)).length < 3) continue;
        const bounds = {x: header.x, y: header.y, width: header.width, height: Math.max(...body.map(bottom)) - header.y};
        const dividers = group.slice(1).map(cell => ({x: cell.x, y: bounds.y, width: 0, height: bounds.height}));
        const anchors = new Map<number, number>();
        for (const number of numbers) {const x = Math.round(number.x); anchors.set(x, (anchors.get(x) ?? 0) + 1);}
        for (const [x, count] of anchors) if (count >= 3) dividers.push({x: x - font * .5, y: bottom(header), width: 0, height: bottom(bounds) - bottom(header)});
        result.push({bounds, dividers});
    }
    return result;
}

export function analyzePdfPageLayout(input: {atoms: readonly PdfLayoutAtom[]; graphics: readonly PdfGraphicsShape[]; width: number; height: number}): {blocks: PdfLayoutBlock[]; preservedRegions: PdfPreservedRegion[]} {
    // 项目符号是单独的一个字形：符号字体里的圆点方块常被读成 n、u、l 这样的字母。它留在原页上不参与翻译，
    // 所在的行从符号之后算起，并且总是另起一段。
    // 可见竖线比词距推断更可靠；紧挨分隔线的两格文字也不能串成一个段落。
    const captionedTables = captionedTableGeometry(input.atoms, input.graphics, input.width);
    const tableDividers = captionedTables.flatMap(table => table.dividers);
    const dividerCandidates = input.graphics.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4);
    // 只索引细笔画的连接端点；无关路径或重复描边不参与逐项全表扫描。
    const pathEnds = new Map<string, Rectangle[]>(), pathStarts = new Map<string, Rectangle[]>(), seenPaths = new Set<string>();
    for (const shape of dividerCandidates.some(shape => shape.width > 0) ? input.graphics : []) {
        if (shape.kind !== 'path') continue;
        const {x, y, width, height} = shape;
        const index = height <= 1 ? pathStarts : width > 0 && width <= 5 && height >= 4 ? pathEnds : undefined;
        if (!index) continue;
        const key = `${x}:${y}:${width}:${height}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        const bucketKey = `${Math.floor(x)}:${Math.floor(index === pathStarts ? y : y + height)}`, bucket = index.get(bucketKey);
        const value = {x, y, width, height};
        if (bucket) bucket.push(value); else index.set(bucketKey, [value]);
    }
    const nearPaths = (index: Map<string, Rectangle[]>, x: number, y: number) => {
        const nearby: Rectangle[] = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) nearby.push(...index.get(`${Math.floor(x) + dx}:${Math.floor(y) + dy}`) ?? []);
        return nearby;
    };
    const verticalDividers = [...dividerCandidates.filter(shape =>
        // 长根号也会有超过一字号的竖笔；相接的上升斜笔与上横线共同确认它，不借单条短边猜测。
        !(shape.width > 0 && nearPaths(pathEnds, right(shape), bottom(shape)).some(diagonal => diagonal.width >= shape.width * 1.4 && diagonal.width <= shape.width * 2.5
            && diagonal.height >= shape.height * 1.2 && diagonal.height <= shape.height * 1.6
            && Math.abs(diagonal.x - right(shape)) <= .5 && Math.abs(bottom(diagonal) - bottom(shape)) <= .5
            && nearPaths(pathStarts, right(diagonal), diagonal.y).some(top => top.width >= diagonal.width * 2
                && Math.abs(top.x - right(diagonal)) <= .5 && Math.abs(top.y - diagonal.y) <= .5)))), ...tableDividers];
    const rawLines = pdfLayoutLines(input.atoms, verticalDividers);
    const bulletGlyph = (line: LayoutLine) => line.runs.length > 1 ? line.runs[0].text.trim() : '';
    const letterBullet = (line: LayoutLine) => {
        const [mark, next] = line.runs;
        return line.runs.length > 1 && /^[nlupqvw]$/u.test(mark.text.trim()) && next.x - right(mark) >= mark.fontSize * .15
            && Math.abs(mark.baseline - next.baseline) <= mark.fontSize * .2 && next.fontSize >= mark.fontSize * .85
            && !/^\s*\p{Ll}/u.test(next.text);
    };
    const letterBullets = new Map<string, number>();
    for (const line of rawLines) {const glyph = bulletGlyph(line); if (letterBullet(line)) letterBullets.set(glyph, (letterBullets.get(glyph) ?? 0) + 1);}
    const bulleted = new Set<LayoutLine>();
    const listMarkers = new Map<LayoutLine, string>();
    // 目录行“标题……页码”里的引导点和页码留在原页上：这一行只算到标题文字为止，译文不会带着一串点，页码也不会被盖掉。
    const glyphWeight = (text: string) => Array.from(text).reduce((sum, character) => sum + (/[.．·…‥\s]/u.test(character) ? 0.55 : cjkGlyph.test(character) || /[\uFF00-\uFFEF《》（）]/u.test(character) ? 2 : 1), 0);
    // 每个目录条目自成一段，不与上下条目合并。
    const tocEntries = new Set<LayoutLine>();
    const withoutLeader = (line: LayoutLine): LayoutLine => {
        const title = line.text.match(/^(.*?[^\s.．·…‥])\s*(?:[.．·…‥]\s?){6,}\s*\d{0,4}$/u)?.[1];
        if (!title) return line;
        let remaining = title.replace(/\s/gu, '').length, end = line.x;
        const runs: PdfLayoutAtom[] = [];
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
        if (listMarkers.has(line)) listMarkers.set(entry, listMarkers.get(line)!);
        return entry;
    };
    const lines = rawLines.map(line => {
        const glyph = bulletGlyph(line);
        if (!(/^[•◦▪■□◆◇●○▶►➢➤❖·§Ø\uE000-\uF8FF]$/u.test(glyph) || (letterBullet(line) && (letterBullets.get(glyph)! >= 2 || cjkLine(line.runs[1].text))))) return line;
        const runs = line.runs.slice(1), x = runs[0].x;
        const stripped = {...line, x, width: right(line) - x, runs, text: joinRuns(runs as PdfLayoutAtom[])};
        bulleted.add(stripped);
        listMarkers.set(stripped, /^[•◦▪■□◆◇●○▶►➢➤❖·]$/u.test(glyph) ? glyph : '•');
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
        for (let next = index + 1; next < lines.length && lines[next].baseline - line.baseline <= font * 2.8; next += 1) {
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
        const labels = inside.filter(line => line.fontSize < Math.min(font * 0.9, 11) && textUnits(line.text) < 4).length;
        if (labels > Math.max(3, inside.length * 0.15)) return false;
        if (inside.some(line => textUnits(line.text) >= 4) && inside.reduce((sum, line) => sum + line.width * line.height, 0) >= area * 0.3) return true;
        // 摘要/提示的浅底框常保留较大内边距，文字面积不足三成，但框内仍有接近整行的完整句子。
        if (box.width >= input.width * 0.45 && box.height <= font * 7
            && inside.some(line => textUnits(line.text) >= 12 && line.width >= box.width * 0.6)) return true;
        // 单个大字号标签不足以把整张图变成文字容器（嵌入图有时仍带被裁掉的标题文字层）。
        return area >= input.width * input.height * 0.35 && (inside.length >= 3 && median(inside.map(line => line.fontSize)) >= 12 || inside.filter(line => textUnits(line.text) >= 6).length >= inside.length / 2);
    };
    const shadedTables = shadedTableRegions(input.graphics, lines, input.width, font);
    const tableBackgrounds = [...shadedTables, ...captionedTables.map(table => table.bounds)];
    const figures = mergedFigures(input.graphics.filter(shape => !tableBackgrounds.some(table => shape.kind === 'path'
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
    const tables = [...tableRegions(input.graphics, input.width, figures), ...shadedTables, ...captionedTables.map(table => table.bounds)];
    const regions: PdfPreservedRegion[] = [...figures.map((box, index) => ({...box, id: `figure-${index + 1}`, kind: 'figure' as const})), ...tables.map((box, index) => ({...box, id: `table-${index + 1}`, kind: 'table' as const}))];
    // 图形包围盒可能跨栏并圈入下方的正文：图内只有小字短标签属于图形，题注、成句的行、紧随成句行的续行以及幻灯片这类大字号页面上 12 磅以上的图内文字（流程图里的文字）仍是正文；论文页眉图里的期刊名等大字仍属于图。
    const prose = new Set<LayoutLine>();
    for (const line of lines) {
        if (captionStart.test(line.text) || textUnits(line.text) >= 7) prose.add(line);
        else if (lines.some(near => near.baseline < line.baseline && line.baseline - near.baseline <= near.fontSize * 1.5 && Math.abs(near.fontSize - line.fontSize) <= 0.6 && line.x >= near.x - 1 && line.x - near.x <= font * 2.2 && right(line) <= right(near) + 2 && textUnits(near.text) >= 7)) prose.add(line);
    }
    const inRegion = (region: PdfPreservedRegion, line: LayoutLine) => coversLine(region, line) && !(region.kind === 'figure' && (prose.has(line) || (font >= 14 && line.fontSize >= 12 && readable(line.text))));
    const ordinary = lines.filter(line => !regions.some(region => inRegion(region, line)));
    const mathLabels = isolatedMathLabels(ordinary, input.graphics, font, input.width, input.height);
    // 行内分式的分子/分母可能是可读单位或多字母变量；真实横分数线、上下两侧字形及紧邻数学符号共同确认它们。
    const fractionFragments = new Set<LayoutLine>();
    const fractionAtoms = ordinary.flatMap(line => line.runs);
    const fractionRuns = new Set<PdfLayoutAtom>();
    for (const rule of input.graphics) {
        if (rule.kind !== 'path' || rule.height > 1 || rule.width < font * .5 || rule.width > font * 12) continue;
        const local = fractionAtoms.filter(run => run.x + run.width / 2 >= rule.x - 1 && run.x + run.width / 2 <= right(rule) + 1
            && Math.abs(run.baseline - rule.y) <= font * 1.4);
        if (!local.some(run => run.baseline < rule.y - .5) || !local.some(run => run.baseline > rule.y + .5)) continue;
        const math = local.some(run => /[\d\p{Script=Greek}\p{Sm}·]|\p{Ll}\p{Lu}/u.test(run.text))
            || fractionAtoms.some(run => /[=∑∫√]/u.test(run.text) && Math.abs(run.baseline - rule.y) <= font
                && Math.max(run.x - right(rule), rule.x - right(run)) <= font * 2);
        if (!math) continue;
        local.forEach(run => fractionRuns.add(run));
        for (const line of ordinary) if (line.text.length <= 45 && textUnits(line.text) <= 5
            && line.x >= rule.x - font && right(line) <= right(rule) + font
            && line.runs.some(run => local.includes(run))) fractionFragments.add(line);
    }
    // 相邻的多个分母可能共用一条提取行；括号组件留在分式周围，不能把它们当成新的可读段落。
    for (const line of ordinary) if (line.text.length <= 45 && textUnits(line.text) <= 5 && line.runs.some(run => fractionRuns.has(run))
        && line.runs.every(run => fractionRuns.has(run) || /^[()[\]{}⎛⎜⎝⎞⎟⎠⎡⎢⎣⎤⎥⎦⎧⎨⎩⎫⎬⎭\s]+$/u.test(run.text))) fractionFragments.add(line);
    const formulas = ordinary.filter(line => fractionFragments.has(line) || formulaLine(line, input.width, ordinary, font));
    for (const line of formulas) {
        let bounds: Rectangle = piecewiseFormulaBounds(line, ordinary, font) ?? line;
        const fractionRules = input.graphics.filter(rule => rule.kind === 'path' && rule.height <= 1 && rule.width >= font * 0.5
            && rule.x <= right(line) + font && right(rule) >= line.x - font && Math.abs(rule.y - line.baseline) <= font);
        // 独立公式的小上下标、分式和式号与公式一起保留；不能把下一行正文并入遮盖区域。
        for (const near of ordinary) {
            if (near === line || near.text.length > 45 || near.width > input.width * 0.5) continue;
            // 教材的短提问紧接着上一题的答案公式；独立列表条目和成句文字不是该公式的上下标。
            if (bulleted.has(near) || readable(near.text) && textUnits(near.text) >= 4
                && !/(?:(?:^|\s)(?:if|when|for)\b.*\p{Sm}|^otherwise\b)/iu.test(near.text)
                // 单位换算分式常包含多个可读词；只有横分数线两侧有对齐字形，才允许按公式保留。
                && !fractionRules.some(rule => Math.abs(near.baseline - rule.y) <= font * 1.2
                    && near.runs.some(run => run.x + run.width / 2 >= rule.x && run.x + run.width / 2 <= right(rule))
                    && ordinary.some(peer => (peer.baseline - rule.y) * (near.baseline - rule.y) < 0 && Math.abs(peer.baseline - rule.y) <= font * 1.2
                        && peer.runs.some(run => run.x + run.width / 2 >= rule.x && run.x + run.width / 2 <= right(rule))))) continue;
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
    // 页底小字不能仅按百分比归为页脚：论文脚注常越过版心下缘。
    // 只接受下半页短水平分隔线之后、同栏且小于正文的可读文字，并沿紧邻行延续；另一栏页脚和独立页码不借用该证据。
    const footnotes = new Set<LayoutLine>();
    const separators = input.graphics.filter(shape => shape.kind === 'path' && shape.y >= input.height * .55
        && shape.width >= font * 2.4 && shape.width <= input.width * .5 && shape.height <= 2);
    for (const line of lines) {
        if (line.fontSize > font * .9 || !readable(line.text)) continue;
        const afterRule = separators.some(rule => line.y >= bottom(rule) - 1 && line.y - bottom(rule) <= font * 2.5
            && Math.abs(line.x - rule.x) <= font * 2 && right(line) >= right(rule) - font);
        const continuation = [...footnotes].some(previous => line.baseline > previous.baseline && line.baseline - previous.baseline <= line.fontSize * 1.8
            && Math.abs(line.fontSize - previous.fontSize) <= .6 && Math.abs(line.x - previous.x) <= font * 2
            && Math.min(right(line), right(previous)) > Math.max(line.x, previous.x));
        if (afterRule || continuation) footnotes.add(line);
    }
    const classify = (line: LayoutLine): Draft['kind'] => {
        if (footnotes.has(line)) return 'text';
        if (line.y > input.height * 0.92 && /^\d{1,4}$/u.test(line.text.trim())) return 'footer';
        // 页眉页脚位于版心之外、不大于正文字号，并与版心隔开至少一行；它们逐页重复，保留原样而不打断正文阅读顺序。
        const header = bottom(line) < input.height * 0.065, trailer = line.y > input.height * 0.945;
        if ((header || trailer) && line.fontSize <= font * 1.05 && line.text.length < 120
            && !lines.some(near => header ? near.y >= bottom(line) - 1 && near.y - bottom(line) < font * 1.2 : bottom(near) <= line.y + 1 && line.y - bottom(near) < font * 1.2)) return 'footer';
        if (captionStart.test(line.text)) return 'caption';
        // 标题下方的作者署名字号常大于正文，但它是人名与单位标记，既不该翻译也不该出现在目录里。
        if (line.y < input.height * 0.45 && byline.test(line.text) && lines.some(above => above.baseline < line.baseline && above.fontSize > line.fontSize * 1.1)) return 'metadata';
        // 没有可读词语的短行（求和号、上下标、极限记号）是公式的碎片，翻译只会破坏它。
        if (mathLabels.has(line) || !readable(line.text)) return 'formula';
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
        // 只有当前格内部、其它列的横界才证明它跨了多行；表头线作为本格顶边不能证明正文跨行。
        if (sameGridCell(last, line, region)) {
            const cell = cellBounds({lines: [last], kind: 'table', region, bounds: last})!;
            if (tableEdges.get(region)!.rules.some(shape => shape.height <= 2 && shape.width >= 6
                && shape.y > cell.y + 1 && bottom(shape) < bottom(cell) - 1
                && (shape.x >= right(cell) - 2 || right(shape) <= cell.x + 2))) return false;
        }
        // 横表线、填色行边缘、逐行绘制的竖线端点都提供了明确的单元格行界；不能按小写开头把下一记录并入上一格。
        const shaded = shadedTables.some(table => Math.abs(table.x - region.x) < 1 && Math.abs(table.y - region.y) < 1);
        if (input.graphics.some(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
            && (shape.width >= region.width * 0.7 && (shape.height <= 2 || shaded) || shape.width <= 2 && shape.height <= line.fontSize * 1.5)
            && [shape.y, bottom(shape)].some(y => y > last.baseline + 1 && y < line.baseline - 1))) return true;
        // 无逐行表线的表格以数值列基线分记录；数值可紧接单个单位表达（°、斜杠、乘点及上标），字母前缀编号和多词描述不能借此拆行。
        const baselineSlack = captionedTables.some(table => Math.abs(table.bounds.x - region.x) < 1 && Math.abs(table.bounds.y - region.y) < 1) ? font * .35 : 1;
        return lines.some(other => coversLine(region, other) && Math.abs(other.baseline - line.baseline) <= baselineSlack
            && !readable(other.text) && /\d/u.test(other.text)
            && (!/\p{L}/u.test(other.text.replace(/(\d)[eE]([+\-−]?\d)/gu, '$1$2'))
                || /^[+\-−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+\-−]?\d+)?\s*°?\p{L}+\p{N}*(?:[\/·⋅*]°?\p{L}+\p{N}*)*$/u.test(other.text.trim())));
    };
    const tableEdges = new Map<PdfPreservedRegion, {xs: number[]; ys: number[]; rules: Rectangle[]}>();
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
            const rules = [...input.graphics, ...tableDividers.map(divider => ({...divider, kind: 'path'}))].filter(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
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
            tableEdges.set(region, {xs, ys: ys.length >= 2 ? ys : [region.y, bottom(region)], rules});
        }
        const {xs, ys, rules} = tableEdges.get(region)!;
        const center = draft.bounds.x + draft.bounds.width / 2;
        const first = draft.lines[0], last = draft.lines.at(-1)!;
        const x = [...xs].reverse().find(edge => edge <= center) ?? region.x;
        const endX = xs.find(edge => edge > center) ?? right(region);
        // 合并行单元格的中间没有横线；其它列的行线不能把它的物理边界切碎。
        const localRows = uniqueEdges(rules.filter(shape => shape.height <= 2 && shape.width >= 6 && shape.x <= x + 2 && right(shape) >= endX - 2)
            .flatMap(shape => [shape.y, bottom(shape)]));
        const shortEdges = rules.filter(shape => shape.width <= 2 && shape.height >= 4 && shape.height <= font * 1.5
            && (Math.abs(shape.x - x) <= 1 || Math.abs(shape.x - endX) <= 1)).flatMap(shape => [shape.y, bottom(shape)]);
        const rowEdges = localRows.length >= 2 ? uniqueEdges([...localRows, ...shortEdges]) : ys;
        const y = [...rowEdges].reverse().find(edge => edge < first.baseline) ?? region.y;
        const endY = rowEdges.find(edge => edge > last.baseline) ?? bottom(region);
        return {x, y, width: Math.max(1, endX - x), height: Math.max(1, endY - y)};
    };
    const sameGridCell = (last: LayoutLine, line: LayoutLine, region: PdfPreservedRegion) => {
        const first = cellBounds({lines: [last], kind: 'table', region, bounds: last});
        const next = cellBounds({lines: [line], kind: 'table', region, bounds: line});
        return !!first && !!next && tableEdges.get(region)!.rules.some(shape => shape.width <= 2 && shape.height >= 4)
            && first.x === next.x && first.y === next.y && first.width === next.width && first.height === next.height;
    };
    const lineIndexes = new Map(lines.map((line, index) => [line, index]));
    // 通栏正文与其下方双栏可能同字号、左对齐；只比相邻两行会把通栏的宽框拖进整列。
    // 用同基线旁栏的实际文字约束合并边界，双向检查也覆盖双栏回到通栏的变化。
    const crossesColumnPeer = (index: number, bounds: Rectangle): boolean => {
        const line = lines[index];
        if (bounds.x >= line.x - font && right(bounds) <= right(line) + font) return false;
        for (const direction of [-1, 1]) for (let peerIndex = index + direction; peerIndex >= 0 && peerIndex < lines.length; peerIndex += direction) {
            const peer = lines[peerIndex];
            if (Math.abs(peer.baseline - line.baseline) > 1) break;
            if (peer.x >= right(line) + font && peer.x < right(bounds) - font
                || right(peer) <= line.x - font && right(peer) > bounds.x + font) return true;
        }
        return false;
    };
    for (const [lineIndex, line] of lines.entries()) {
        active = active.filter(draft => line.baseline - draft.lines.at(-1)!.baseline <= Math.max(font, draft.lines.at(-1)!.fontSize) * 1.7 * loose);
        const region = regions.find(region => inRegion(region, line));
        const kind = region ? region.kind === 'figure' ? 'figure-label' : region.kind : classify(line);
        let selected: Draft | undefined;
        if (kind !== 'footer' && !/^\(\d+\)\s/u.test(line.text) && !bulleted.has(line) && !tocEntries.has(line)) {
            for (const draft of active) {
                const last = draft.lines.at(-1)!;
                if (tocEntries.has(last)) continue;
                const gap = line.baseline - last.baseline;
                // 紧排大标题即使各行长短不同也属于同一标题；普通正文或另起编号仍不能借此并入。
                const tightHeading = kind === 'heading' && Math.abs(line.fontSize - last.fontSize) <= 0.2
                    && Math.abs(line.x - last.x) <= 1 && gap <= last.fontSize * 1.05;
                const wrappedHeading = draft.kind === 'heading' && (kind === 'text' || kind === 'heading') && (draft.lines.length < 3 || tightHeading) && gap <= last.fontSize * 1.45 * loose
                    && (tightHeading || (Math.abs(line.x - last.x) <= 1 && line.width < last.width * 0.9) || (kind === 'heading' && Math.abs(line.fontSize - last.fontSize) <= 0.2 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= 2))
                    && !/[.!?。！？]$/u.test(last.text) && !/^\d+(?:\.\d+)*\.?\s/u.test(line.text);
                if (draft.region !== region || (kind === 'heading' ? !wrappedHeading : draft.kind !== kind && !(draft.kind === 'caption' && kind === 'text') && !wrappedHeading)) continue;
                // 悬挂缩进的条目（参考文献、编号列表）以回到左边界的新行开头。
                if (draft.lines.length >= 2 && line.x < last.x - font * 0.8) continue;
                // 表格的每一行是独立的单元格；只有断词续行或以小写、括号开头的续行才并入上一行所在的单元格。
                if (region?.kind === 'table' && (newTableRow(last, line, region) || !(/[-‐‑]$/u.test(last.text) || /^[\p{Ll}(]/u.test(line.text) || sameGridCell(last, line, region)))) continue;
                // 作者与单位、正文与脚注字号不同，即使左对齐也属于不同段落。
                if (Math.abs(line.fontSize - last.fontSize) > Math.max(0.6, last.fontSize * 0.18)) continue;
                const overlap = Math.min(right(line), right(last)) - Math.max(line.x, last.x);
                const sameColumn = Math.abs(line.x - last.x) <= font * 2.2 || (overlap >= Math.min(line.width, last.width) * 0.72 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= font * 2);
                if (gap <= 0 || !sameColumn) continue;
                if (!region && (crossesColumnPeer(lineIndex, draft.bounds) || crossesColumnPeer(lineIndexes.get(last)!, line))) continue;
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
    // TeX 的大算符可能被抽取为普通字母，且基线位于字形上沿；须有近邻数学算符及下伸几何，不能只凭短词推断数学。
    for (const draft of drafts) {
        const line = draft.lines[0];
        if (draft.kind !== 'text' || draft.lines.length > 1 || textUnits(line.text) >= 4) continue;
        const centerX = line.x + line.width / 2, centerY = line.y + line.height / 2;
        const loweredOperator = line.runs.find(run => /^[\p{L}\p{N}]$/u.test(run.text) && run.fontSize >= line.fontSize * 0.85
            && run.baseline - run.y <= run.fontSize * 0.25 && bottom(run) - run.baseline >= run.fontSize * 0.65);
        if (drafts.some(other => other !== draft && other.lines.length > 1 && (other.kind === 'text' || other.kind === 'caption')
            && (line.fontSize <= other.lines[0].fontSize * 0.85 || loweredOperator && other.lines.some(peer => peer.runs.some(run => /[=∑∫∏]/u.test(run.text)
                && loweredOperator.x >= right(run) && loweredOperator.x - right(run) <= run.fontSize * 1.5
                && Math.abs(run.y - loweredOperator.y) <= run.fontSize * 0.35)))
            && centerX >= other.bounds.x && centerX <= right(other.bounds) && centerY >= other.bounds.y && centerY <= bottom(other.bounds))) draft.kind = 'formula';
    }
    const blockTables = new Map<PdfLayoutBlock, PdfPreservedRegion>();
    const blocks: PdfLayoutBlock[] = drafts.map(draft => {
        const first = draft.lines[0];
        const joined = draft.lines.reduce((text, line, index) => {
            if (!text) return line.text;
            // 段落/分栏关联已确认两行同属一块；只有 URL 尾斜杠和带数字的路径首词共同确认续行，后续正文空白不变。
            const path = line.text.match(/^[A-Za-z0-9._~%/?#&=+-]+(?=\s|$)/u)?.[0];
            if (/(?:^|[\s(["'])https?:\/\/[^\s<>"'`，。、；：！？（）【】《》「」“”‘’]+\/$/u.test(draft.lines[index - 1].text)
                && path?.includes('/') && /\d/u.test(path)) return text + line.text;
            return /[-‐‑\u00AD]$/u.test(text) && /^[a-z]/u.test(line.text) ? text.slice(0, -1) + line.text
                : cjkLineEnd.test(text) && cjkLineStart.test(line.text) ? text + line.text : `${text} ${line.text}`;
        }, '');
        // 标题末尾抬高的小字是脚注标记（☆、*、a），不属于标题文字。
        const lastLine = draft.lines.at(-1)!, mark = lastLine.runs.at(-1) as PdfLayoutAtom;
        const marked = draft.kind === 'heading' && lastLine.runs.length > 1 && mark.fontSize <= lastLine.fontSize * 0.8 && mark.baseline < lastLine.baseline - lastLine.fontSize * 0.15
            && /^[\p{L}\d*†‡⇑☆]{1,2}$/u.test(mark.text.trim()) && joined.endsWith(mark.text.trim());
        // 两端撑开排版的中文在每个字之间都留了空；逐字带空格的原文会被当成一串单字来翻译。
        const spaced = joined.match(/[\p{Script=Han}] (?=[\p{Script=Han}])/gu)?.length ?? 0;
        const source = (spaced >= 3 && spaced >= (joined.match(/[\p{Script=Han}]/gu)!.length - 1) * 0.6 ? joined.replace(/(?<=[\p{Script=Han}，。、；：（）]) (?=[\p{Script=Han}，。、；：（）])/gu, '') : marked ? joined.slice(0, -mark.text.trim().length).trimEnd() : joined).replace(/\u00AD/gu, '');
        const leading = draft.lines.slice(1).map((line, index) => line.baseline - draft.lines[index].baseline);
        const center = draft.bounds.x + draft.bounds.width / 2;
        const centered = (draft.kind === 'heading' || draft.kind === 'metadata' || draft.kind === 'footer') && Math.abs(center - input.width / 2) <= input.width * 0.045;
        const cell = cellBounds(draft);
        const block: PdfLayoutBlock = {...draft.bounds, source, ...(listMarkers.has(first) ? {listMarker: listMarkers.get(first)} : {}), ...(cell ? {cellBounds: cell} : {}), fontSize: median(draft.lines.map(line => line.fontSize)), lineHeight: leading.length ? median(leading) : first.fontSize, lineCount: draft.lines.length, fontFamily: first.fontFamily, fontWeight: draft.kind === 'heading' ? 700 : 400, textAlign: centered ? 'center' : 'left', kind: draft.kind, preserveSource: (draft.region ? draft.region.kind !== 'table' || !readable(source) : false) || draft.kind === 'metadata' || draft.kind === 'footer' || draft.kind === 'formula', lines: draft.lines};
        if (draft.region?.kind === 'table') blockTables.set(block, draft.region);
        return block;
    });
    // 表格以完整区域参与分栏；内部按物理单元格行列展开，不能把较宽的描述列提前当成通栏正文。
    const tableGroups = new Map<PdfPreservedRegion, PdfLayoutBlock[]>();
    for (const block of blocks) {
        const table = blockTables.get(block);
        if (table) {const cells = tableGroups.get(table) ?? []; cells.push(block); tableGroups.set(table, cells);}
    }
    const tableUnits = new Map<PdfLayoutBlock, PdfLayoutBlock[]>();
    const readingBlocks = blocks.filter(block => !blockTables.has(block));
    for (const [region, cells] of tableGroups) {
        const unit: PdfLayoutBlock = {...cells[0], ...region, source: '', kind: 'table'};
        tableUnits.set(unit, cells); readingBlocks.push(unit);
    }
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
    for (const block of readingBlocks.sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (block.width > input.width * 0.58 || (block.kind === 'heading' && block.textAlign === 'center') || block.kind === 'footer') {flush(); block.column = 0; ordered.push(block);}
        else band.push(block);
    }
    flush();
    const reading = ordered.flatMap(block => {
        const cells = tableUnits.get(block);
        if (!cells) return [block];
        // 这些单元格均由 table 草稿创建，cellBounds 在登记 blockTables 前已经生成。
        const rows = uniqueEdges(cells.map(cell => cell.cellBounds!.y));
        const rowOf = new Map(cells.map(cell => [cell, rows.findIndex(y => Math.abs(y - cell.cellBounds!.y) < .6)]));
        return cells.sort((a, b) => rowOf.get(a)! - rowOf.get(b)!
            || a.cellBounds!.x - b.cellBounds!.x || a.y - b.y).map(cell => {cell.column = block.column; return cell;});
    });
    reading.forEach(block => {block.readingOrder = readingOrder++;});
    // 同一图带中的左右子图可能顶边不齐，按重叠高度识别同带后从左向右阅读。
    const regionBands: PdfPreservedRegion[][] = [];
    for (const region of regions.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const band = regionBands.at(-1);
        if (region.kind === 'figure' && band?.every(previous => previous.kind === 'figure') && band.some(previous => Math.min(bottom(region), bottom(previous)) - Math.max(region.y, previous.y) > Math.min(region.height, previous.height) * .5)) band.push(region);
        else regionBands.push([region]);
    }
    return {blocks: reading, preservedRegions: regionBands.flatMap(band => band.sort((a, b) => a.x - b.x))};
}
