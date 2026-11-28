/**
 * @file src/features/document-translation/core/pdfRegionsAndMath.ts
 *
 * 文件职责：识别 PDF 页面中的插图合并区域、有线与填色表格、开放表头表格、独立装饰文字框、公式行与分段花括号公式及独立数学图标签。
 * 主要内容：导出 mergedFigures、tableRegions、shadedTableRegions、findTextPanels、formulaLine、piecewiseFormulaBounds、isolatedMathLabels 与 captionedTableGeometry。
 * 模块边界：仅依赖 pdfLayoutGeometry 与 pdfLineGrouping 的纯几何和行结果，不承担段落合并、阅读顺序或浏览器渲染逻辑。
 */

import {
    bottom,
    coversLine,
    median,
    overlaps,
    right,
    textUnits,
    union,
    type LayoutLine,
    type PdfGraphicsShape,
    type PdfLayoutAtom,
    type Rectangle,
} from './pdfLayoutGeometry';
import {pdfLayoutLines} from './pdfLineGrouping';

export interface TextPanel {
    box: PdfGraphicsShape;
    atoms: PdfLayoutAtom[];
    lines: LayoutLine[];
    centered: boolean;
}

export function mergedFigures(shapes: readonly PdfGraphicsShape[], container: (box: Rectangle) => boolean): Rectangle[] {
    const figures: Rectangle[] = [];
    for (const shape of shapes) {
        // 后续图注切分会裁剪此框；不能修改调用方保留的原始图形。
        let merged: Rectangle = {...shape};
        let changed = true;
        while (changed) {
            changed = false;
            for (let index = figures.length - 1; index >= 0; index -= 1) {
                if (overlaps(merged, figures[index], 2)) {
                    merged = union(merged, figures[index]);
                    figures.splice(index, 1);
                    changed = true;
                }
            }
        }
        figures.push(merged);
    }
    // 许多小底框首尾相接也会并成一个圈住整页文字的大区域，合并之后再检查一次。
    return figures.filter(figure => !container(figure));
}

export function tableRegions(shapes: readonly PdfGraphicsShape[], width: number, figures: readonly Rectangle[]): Rectangle[] {
    // Word 将同一横边按单元格分别绘制；先连接同基线的相接片段，再判断整条表线的宽度，不能丢掉狭窄的前几列。
    const rows: Rectangle[] = [];
    for (const shape of shapes.filter(shape => shape.kind === 'path' && shape.width >= 6 && shape.height <= 2 && !figures.some(figure => overlaps(shape, figure)))) {
        let row: Rectangle = shape;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const previous = rows[index];
            if (Math.abs(previous.y - row.y) <= 1.5 && previous.x <= right(row) + 1.5 && right(previous) + 1.5 >= row.x) {
                row = union(row, previous);
                rows.splice(index, 1);
            }
        }
        rows.push(row);
    }
    const wideRows = rows.filter(row => row.width >= width * .2).sort((a, b) => a.y - b.y);
    const groups: Rectangle[][] = [];
    let verticalEdges: readonly PdfGraphicsShape[] | undefined;
    for (const row of wideRows) {
        const group = groups.find(group => {
            const last = group.at(-1)!;
            if (row.y - last.y > 150 || Math.min(right(row), right(last)) - Math.max(row.x, last.x) < Math.min(row.width, last.width) * .7) return false;
            if (Math.min(row.width, last.width) >= Math.max(row.width, last.width) * .7) return true;
            // 不等宽的章节分隔线不能仅靠重叠并成表格；真正跨列的表头须有两条竖边连接上下横线。
            verticalEdges ??= shapes.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4);
            let left = Infinity;
            let farRight = -Infinity;
            for (const edge of verticalEdges) {
                if (edge.y > bottom(last) + 2 || bottom(edge) < row.y - 2
                    || edge.x < Math.max(row.x, last.x) - 2 || right(edge) > Math.min(right(row), right(last)) + 2) continue;
                left = Math.min(left, edge.x);
                farRight = Math.max(farRight, edge.x);
                if (farRight - left >= 6) return true;
            }
            return false;
        });
        if (group) group.push(row);
        else groups.push([row]);
    }
    return groups.filter(group => group.length >= 2).map(group => {
        const box = group.reduce(union);
        // 有些网格省略最后一行的底横线；两条分列竖边在同一高度结束，仍能确定完整末行。
        // 竖边必须穿过最后两条横线，单条装饰线和远处图形不能延伸表格。
        const endings = shapes.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4
            && shape.x >= box.x - 2 && right(shape) <= right(box) + 2 && shape.y <= group.at(-2)!.y + 2
            && bottom(shape) > bottom(box) + 2 && bottom(shape) <= bottom(box) + 150);
        let end = bottom(box);
        for (const edge of endings) {
            if (endings.some(other => Math.abs(other.x - edge.x) >= 6 && Math.abs(bottom(other) - bottom(edge)) <= 1.5)) {
                end = Math.max(end, bottom(edge));
            }
        }
        return {...box, y: Math.max(0, box.y - 1), height: end - box.y + 2};
    });
}

/** 相接且同宽的填色行，里面反复出现对齐的多个文字单元格，是表格底色而非插图。 */
export function shadedTableRegions(shapes: readonly PdfGraphicsShape[], lines: readonly LayoutLine[], width: number, font: number): Rectangle[] {
    const rows = shapes.filter(shape => shape.kind === 'path' && shape.width >= width * 0.2 && shape.height >= 6 && shape.height <= font * 5)
        .sort((a, b) => a.y - b.y);
    const groups: PdfGraphicsShape[][] = [];
    for (const row of rows) {
        const group = groups.find(group => {
            const last = group.at(-1)!;
            return Math.abs(last.x - row.x) <= 1.5 && Math.abs(right(last) - right(row)) <= 1.5
                && Math.abs(row.y - bottom(last)) <= 2 && Math.abs(row.height - last.height) <= 2;
        });
        if (group) group.push(row);
        else groups.push([row]);
    }
    return groups.flatMap(group => {
        if (group.length < 3) return [];
        const cells = group.map(row => lines.filter(line => coversLine(row, line)));
        const aligned = cells.filter(row => row.length >= 2 && row.filter(cell => cells.some(other => other !== row
            && other.some(candidate => Math.abs(candidate.x - cell.x) <= font * 0.6))).length >= 2);
        return aligned.length >= Math.max(3, group.length * 0.75) ? [group.reduce<Rectangle>(union, group[0])] : [];
    });
}

/** 小底框内多行按基线连续并成句，才允许脱离全页行分组；页图里的零散标签和网格不参与。 */
export function findTextPanels(input: {atoms: readonly PdfLayoutAtom[]; graphics: readonly PdfGraphicsShape[]; width: number}, font: number): TextPanel[] {
    const shapes = input.graphics.filter(shape => shape.kind === 'path' && shape.width >= font * 4
        && shape.width <= input.width * .37 && shape.height >= font * 2 && shape.height <= font * 9);
    const candidates: TextPanel[] = [];
    if (shapes.length > 128 || input.atoms.length > 2048) return candidates;
    const center = (line: LayoutLine) => line.x + line.width / 2;
    for (const box of shapes) {
        const atoms = input.atoms.filter(atom => atom.fontSize >= font * .75 && atom.fontSize <= font * 1.22
            && atom.x >= box.x - 1 && right(atom) <= right(box) + 1 && atom.baseline >= box.y && atom.baseline <= bottom(box) + 1);
        if (atoms.length < 2 || atoms.length > 150) continue;
        const lines = pdfLayoutLines(atoms);
        if (lines.length < 2 || lines.length > 10 || !/[.!?。！？]$/u.test(lines.at(-1)!.text)
            || textUnits(lines.map(line => line.text).join(' ')) < 4) continue;
        const centered = lines.every(line => Math.abs(center(line) - center(lines[0])) <= font * .9);
        const leftAligned = lines.every(line => Math.abs(line.x - lines[0].x) <= font * .7);
        if (!centered && !leftAligned) continue;
        if (lines.slice(1).some((line, index) => {
            const gap = line.baseline - lines[index].baseline;
            return gap < font * .65 || gap > font * 1.65;
        })) continue;
        candidates.push({box, atoms, lines, centered});
    }
    return candidates.sort((a, b) => b.atoms.length - a.atoms.length || a.box.width * a.box.height - b.box.width * b.box.height);
}

export function formulaLine(line: LayoutLine, pageWidth: number, lines: readonly LayoutLine[], font: number): boolean {
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
export function piecewiseFormulaBounds(seed: LayoutLine, lines: readonly LayoutLine[], font: number): Rectangle | undefined {
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
export function isolatedMathLabels(
    lines: readonly LayoutLine[],
    graphics: readonly PdfGraphicsShape[],
    font: number,
    width: number,
    height: number,
): Set<LayoutLine> {
    const labels = new Set<LayoutLine>();
    const body = lines.filter(line => line.y >= height * 0.065 && bottom(line) <= height * 0.945
        && line.fontSize <= font * 1.1 && line.width <= width * 0.5);
    const local = body.filter(line => line.width <= font * 12);
    const names = local.filter(line => /^[\p{L}\p{N}_]{1,32}$/u.test(line.text));
    const typedNames = new Set<string>();
    const recordName = (line: LayoutLine, name: string) => {
        let remaining = name.length;
        let stem = '';
        let scripted = false;
        let trailing = true;
        for (const run of line.runs) {
            if (!remaining) break;
            const part = run.text.trim().slice(0, remaining);
            remaining -= part.length;
            // 别名只去掉已确认类型名称末尾、字号更小且基线降低的下标；普通同字号希腊字母不被剥离。
            const script = run.fontSize <= line.fontSize * 0.8 && run.baseline - line.baseline >= line.fontSize * 0.15
                && run.baseline - line.baseline <= line.fontSize * 0.8;
            if (script) scripted = true;
            else {if (scripted) trailing = false; stem += part;}
        }
        typedNames.add(name);
        typedNames.add(trailing ? stem : name);
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
        const start = nearNode(shape.x, shape.y);
        const end = start && nearNode(horizontal ? right(shape) : shape.x, horizontal ? shape.y : bottom(shape), start);
        if (start && end) edges.push({shape, nodes: [start, end]});
    }
    for (const stroke of strokes) {
        const horizontal = stroke.width > stroke.height;
        const length = horizontal ? stroke.width : stroke.height;
        const endX = horizontal ? right(stroke) : stroke.x;
        const endY = horizontal ? stroke.y : bottom(stroke);
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
            const along = name.x + name.width / 2 - base.x;
            const gap = base.y - bottom(name);
            return along >= font && along <= base.width - font && gap >= 0 && gap <= font;
        });
        if (!nearby.length) continue;
        const legs = strokes.filter(stroke => stroke.height > stroke.width && Math.abs(bottom(stroke) - base.y) <= font * 0.5);
        const left = legs.find(leg => Math.abs(leg.x - base.x) <= font * 0.5);
        const rightLeg = legs.find(leg => leg !== left && Math.abs(leg.x - right(base)) <= font * 0.5);
        if (!left || !rightLeg) continue;
        const start = nearNode(left.x, left.y);
        const end = start && nearNode(rightLeg.x, rightLeg.y, start);
        if (!start || !end) continue;
        for (const name of nearby) if (name.y >= Math.max(left.y, rightLeg.y) + font) labels.add(name);
    }
    return labels;
}

/** 只有表头横线的开放表格：相接表头框、连续数字列与下方独立表题共同给出边界。 */
export function captionedTableGeometry(
    atoms: readonly PdfLayoutAtom[],
    shapes: readonly PdfGraphicsShape[],
    width: number,
): Array<{bounds: Rectangle; dividers: Rectangle[]}> {
    const captions = atoms.filter(atom => /^Table\s+\d+[.．]\d+\s+\p{Lu}/u.test(atom.text));
    if (!captions.length) return [];
    const font = median(atoms.map(atom => atom.layoutFontSize ?? atom.fontSize));
    const headers = shapes.filter(shape => shape.kind === 'path' && shape.width >= font * 4 && shape.height >= font && shape.height <= font * 5);
    const groups: PdfGraphicsShape[][] = [];
    for (const header of headers.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const group = groups.find(group => Math.abs(group[0].y - header.y) <= 1 && Math.abs(group[0].height - header.height) <= 1 && Math.abs(right(group.at(-1)!) - header.x) <= 1);
        if (group) group.push(header);
        else groups.push([header]);
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
