/**
 * @file src/features/document-translation/core/pdfLayoutAnalysis.ts
 * 文件职责：编排 PDF 页面级版面分析管线，从原始字形与绘图算子推导段落块、阅读顺序及必须保留的公式、表格与插图区域。
 * 主要内容：转发 pdfLayoutGeometry 与 pdfLineGrouping 的公开导出，并将 analyzePdfPageLayout 拆分为分隔线识别、列表与目录引导符清洗、保留区域归集、段落合并与多栏阅读排序等独立阶段函数。
 * 模块边界：纯几何版面编排模块，不加载 PDF.js、不访问 Canvas、网络或 DOM，不修改来源文字或文件。
 */

import type {PdfDocumentBlock, PdfPreservedRegion} from './document';
import {findBorderlessTables} from './pdfBorderlessTable';
import {
    affiliationLine,
    bottom,
    byline,
    cjkGlyph,
    cjkLine,
    contactLine,
    coversLine,
    extractPdfGraphicsShapes,
    isPageWrapper,
    joinPdfSourceLines,
    joinRuns,
    largeOperator,
    median,
    overlaps,
    readable,
    right,
    sectionTitle,
    spacedSectionTitle,
    textUnits,
    union,
    uniqueEdges,
    type LayoutLine,
    type PdfGraphicsOperators,
    type PdfGraphicsShape,
    type PdfLayoutAtom,
    type PdfLayoutBlock,
    type Rectangle,
} from './pdfLayoutGeometry';
import {pdfLayoutLines} from './pdfLineGrouping';
import {
    captionedTableGeometry,
    findTextPanels,
    formulaLine,
    isolatedMathLabels,
    mergedFigures,
    piecewiseFormulaBounds,
    shadedTableRegions,
    tableRegions,
    type TextPanel,
} from './pdfRegionsAndMath';

export {
    extractPdfGraphicsShapes,
    joinPdfSourceLines,
    pdfLayoutLines,
    type PdfGraphicsOperators,
    type PdfGraphicsShape,
    type PdfLayoutAtom,
    type PdfLayoutBlock,
};

interface PageLayoutInput {
    atoms: readonly PdfLayoutAtom[];
    graphics: readonly PdfGraphicsShape[];
    width: number;
    height: number;
}

interface DraftBlock {
    lines: LayoutLine[];
    kind: NonNullable<PdfDocumentBlock['kind']>;
    region?: PdfPreservedRegion;
    bounds: Rectangle;
    panel?: TextPanel;
}

const CAPTION_START = /^(?:(?:[Ff]igure|FIGURE|[Tt]able|TABLE|[Ff]ig\.|FIG\.)\s+\d+[.:]|TABLE\s+[IVXLC]+$|[图表]\s*\d+(?:[-.．]\d+)*[\s:：.．])/u;

function resolveCellDividers(input: PageLayoutInput, tableDividers: readonly Rectangle[]): {
    verticalDividers: Rectangle[];
    horizontalCellDividers: Rectangle[];
} {
    const dividerCandidates = input.graphics.filter(shape => shape.kind === 'path' && shape.width <= 2 && shape.height >= 4);
    // 只索引细笔画的连接端点；无关路径或重复描边不参与逐项全表扫描。
    const pathEnds = new Map<string, Rectangle[]>();
    const pathStarts = new Map<string, Rectangle[]>();
    const seenPaths = new Set<string>();
    for (const shape of dividerCandidates.some(shape => shape.width > 0) ? input.graphics : []) {
        if (shape.kind !== 'path') continue;
        const {x, y, width, height} = shape;
        const index = height <= 1 ? pathStarts : width > 0 && width <= 5 && height >= 4 ? pathEnds : undefined;
        if (!index) continue;
        const key = `${x}:${y}:${width}:${height}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        const bucketKey = `${Math.floor(x)}:${Math.floor(index === pathStarts ? y : y + height)}`;
        const bucket = index.get(bucketKey);
        const value = {x, y, width, height};
        if (bucket) bucket.push(value);
        else index.set(bucketKey, [value]);
    }
    const nearPaths = (index: Map<string, Rectangle[]>, x: number, y: number) => {
        const nearby: Rectangle[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) nearby.push(...index.get(`${Math.floor(x) + dx}:${Math.floor(y) + dy}`) ?? []);
        }
        return nearby;
    };
    const verticalDividers = [
        ...dividerCandidates.filter(shape =>
            // 长根号也会有超过一字号的竖笔；相接的上升斜笔与上横线共同确认它，不借单条短边猜测。
            !(shape.width > 0 && nearPaths(pathEnds, right(shape), bottom(shape)).some(diagonal => diagonal.width >= shape.width * 1.4 && diagonal.width <= shape.width * 2.5
                && diagonal.height >= shape.height * 1.2 && diagonal.height <= shape.height * 1.6
                && Math.abs(diagonal.x - right(shape)) <= .5 && Math.abs(bottom(diagonal) - bottom(shape)) <= .5
                && nearPaths(pathStarts, right(diagonal), diagonal.y).some(top => top.width >= diagonal.width * 2
                    && Math.abs(top.x - right(diagonal)) <= .5 && Math.abs(top.y - diagonal.y) <= .5)))),
        ...tableDividers.filter(divider => divider.width <= 2),
    ];
    // 只有两端均有跨线竖边支撑的横线才限制单元格行；孤立分数线、根号横笔与装饰线不能成为行边界。
    let horizontalCellDividers: Rectangle[] = [];
    if (input.atoms.some(atom => largeOperator.test(atom.text))) {
        const starts = new Map<number, Rectangle[]>();
        const ends = new Map<number, Rectangle[]>();
        const addEdge = (index: Map<number, Rectangle[]>, x: number, edge: Rectangle) => {
            const key = Math.floor(x);
            const bucket = index.get(key);
            if (bucket) bucket.push(edge);
            else index.set(key, [edge]);
        };
        for (const edge of verticalDividers) {addEdge(starts, edge.x, edge); addEdge(ends, right(edge), edge);}
        const supported = (index: Map<number, Rectangle[]>, x: number, rule: Rectangle, end: boolean) => {
            const column = Math.floor(x);
            for (let offset = -2; offset <= 2; offset++) for (const edge of index.get(column + offset) ?? []) {
                const at = end ? right(edge) : edge.x;
                if (Math.abs(at - x) <= 2 && edge.y < rule.y - 2 && bottom(edge) > bottom(rule) + 2) return true;
            }
            return false;
        };
        horizontalCellDividers = input.graphics.filter(shape => shape.kind === 'path' && shape.width >= 6 && shape.height <= 2
            && supported(starts, shape.x, shape, false) && supported(ends, right(shape), shape, true));
    }
    return {verticalDividers, horizontalCellDividers};
}

function normalizeBulletsAndLeaders(
    rawLines: LayoutLine[],
    panelLines: Map<LayoutLine, TextPanel>,
): {
    lines: LayoutLine[];
    bulleted: Set<LayoutLine>;
    listMarkers: Map<LayoutLine, {text: string; run: PdfLayoutAtom}>;
    tocEntries: Set<LayoutLine>;
} {
    const bulletGlyph = (line: LayoutLine) => line.runs.length > 1 ? line.runs[0].text.trim() : '';
    const letterBullet = (line: LayoutLine) => {
        const [mark, next] = line.runs;
        return line.runs.length > 1 && /^[nlupqvw]$/u.test(mark.text.trim()) && next.x - right(mark) >= mark.fontSize * .15
            && Math.abs(mark.baseline - next.baseline) <= mark.fontSize * .2 && next.fontSize >= mark.fontSize * .85
            && !/^\s*\p{Ll}/u.test(next.text);
    };
    const letterBullets = new Map<string, number>();
    for (const line of rawLines) {
        const glyph = bulletGlyph(line);
        if (letterBullet(line)) letterBullets.set(glyph, (letterBullets.get(glyph) ?? 0) + 1);
    }
    const bulleted = new Set<LayoutLine>();
    const listMarkers = new Map<LayoutLine, {text: string; run: PdfLayoutAtom}>();
    // 目录行“标题……页码”里的引导点和页码留在原页上：这一行只算到标题文字为止，译文不会带着一串点，页码也不会被盖掉。
    const glyphWeight = (text: string) => Array.from(text).reduce((sum, character) =>
        sum + (/[.．·…‥\s]/u.test(character) ? 0.55 : cjkGlyph.test(character) || /[\uFF00-\uFFEF《》（）]/u.test(character) ? 2 : 1), 0);
    // 每个目录条目自成一段，不与上下条目合并。
    const tocEntries = new Set<LayoutLine>();
    const withoutLeader = (line: LayoutLine): LayoutLine => {
        const title = line.text.match(/^(.*?[^\s.．·…‥])\s*(?:[.．·…‥]\s?){6,}\s*\d{0,4}$/u)?.[1];
        if (!title) return line;
        let remaining = title.replace(/\s/gu, '').length;
        let end = line.x;
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
        const runs = line.runs.slice(1);
        const x = runs[0].x;
        const stripped = {...line, x, width: right(line) - x, runs, text: joinRuns(runs as PdfLayoutAtom[])};
        bulleted.add(stripped);
        listMarkers.set(stripped, {text: /^[•◦▪■□◆◇●○▶►➢➤❖·]$/u.test(glyph) ? glyph : '•', run: line.runs[0]});
        return stripped;
    }).map((line, index) => {
        const normalized = withoutLeader(line);
        const original = rawLines[index];
        const panel = panelLines.get(original);
        if (panel && normalized !== original) {panelLines.delete(original); panelLines.set(normalized, panel);}
        return normalized;
    });
    return {lines, bulleted, listMarkers, tocEntries};
}

function detectRegionsAndMath(
    input: PageLayoutInput,
    lines: readonly LayoutLine[],
    font: number,
    wrappers: readonly PdfGraphicsShape[],
    panelBackgrounds: ReadonlySet<PdfGraphicsShape>,
    panelLines: ReadonlyMap<LayoutLine, TextPanel>,
    bulleted: ReadonlySet<LayoutLine>,
    captionedTables: ReadonlyArray<{bounds: Rectangle; dividers: Rectangle[]}>,
): {
    regions: PdfPreservedRegion[];
    shadedTables: Rectangle[];
    inRegion: (region: PdfPreservedRegion, line: LayoutLine) => boolean;
    ordinary: LayoutLine[];
    mathLabels: Set<LayoutLine>;
    sentenceLine: (line: LayoutLine) => boolean;
} {
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
        // 教材的学习目标列表可有大片留白；宽框、正文项目和框顶大标题共同证明这是文字容器。
        const listLines = inside.filter(line => bulleted.has(line) && line.fontSize >= font * .85 && textUnits(line.text) >= 4);
        if (box.width >= input.width * .45 && listLines.length >= 2
            && inside.filter(line => textUnits(line.text) >= 4).length >= inside.length * .6
            && inside.some(line => !bulleted.has(line) && line.fontSize >= font * 1.2 && line.y <= box.y + font * 2.5
                && listLines.every(item => item.y >= bottom(line)))) return true;
        // 单个大字号标签不足以把整张图变成文字容器（嵌入图有时仍带被裁掉的标题文字层）。
        return area >= input.width * input.height * 0.35 && (inside.length >= 3 && median(inside.map(line => line.fontSize)) >= 12 || inside.filter(line => textUnits(line.text) >= 6).length >= inside.length / 2);
    };
    const shadedTables = shadedTableRegions(input.graphics, lines, input.width, font);
    const tableBackgrounds = [...shadedTables, ...captionedTables.map(table => table.bounds)];
    const figureShapes = input.graphics.filter(shape => shape.width >= 24 && shape.height >= 24
        && (shape.kind !== 'path' || shape.width * shape.height >= 900)
        && shape.width * shape.height < input.width * input.height * .94
        && !panelBackgrounds.has(shape)
        && !(shape.kind !== 'image' && wrappers.some(frame => Math.abs(frame.x - shape.x) <= 1
            && Math.abs(right(frame) - right(shape)) <= 1 && Math.abs(frame.y - shape.y) <= 1 && Math.abs(bottom(frame) - bottom(shape)) <= 1))
        && !tableBackgrounds.some(table => shape.kind === 'path' && shape.x >= table.x - 1
            && right(shape) <= right(table) + 1 && shape.y >= table.y - 1 && bottom(shape) <= bottom(table) + 1)
        && !container(shape));
    const figures = mergedFigures(figureShapes, container);
    // 图形对象的包围盒常把题注一并圈入，上下相邻的两张图还会连同中间的题注并成一个区域；题注是需要翻译的正文，图形在题注处断开。
    const attachedFigureLabels = new Set<LayoutLine>();
    for (let index = 0; index < figures.length; index += 1) {
        const figure = figures[index];
        const start = lines.find(line => CAPTION_START.test(line.text) && line.y > figure.y + 12 && bottom(line) <= bottom(figure) + 2
            && line.x >= figure.x - 2 && right(line) <= right(figure) + 2 && line.width >= figure.width * 0.4);
        if (!start) continue;
        let end = bottom(start);
        let baseline = start.baseline;
        for (const line of lines) {
            if (line.baseline <= baseline || line.baseline - baseline > start.fontSize * 1.5 || Math.abs(line.fontSize - start.fontSize) > 0.6 || line.x < start.x - 2 || right(line) > right(start) + start.fontSize * 2) continue;
            baseline = line.baseline;
            end = bottom(line);
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
            && !/^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.|[A-Z]\.)\s+(?:[|｜]\s*)?\p{Lu}/u.test(line.text)
            && !/^(?:Figure|Table)\s+\d/iu.test(line.text) && !/[.!?。！？]$/u.test(line.text) && !/[=∑∫√∈]/u.test(line.text));
        labels.sort((a, b) => b.baseline - a.baseline);
        if (labels.length) {figures[index] = union(figure, labels[0]); attachedFigureLabels.add(labels[0]);}
    }
    const tables = [...tableRegions(input.graphics, input.width, figures), ...shadedTables, ...captionedTables.map(table => table.bounds)];
    const regions: PdfPreservedRegion[] = [
        ...figures.map((box, index) => ({...box, id: `figure-${index + 1}`, kind: 'figure' as const})),
        ...tables.map((box, index) => ({...box, id: `table-${index + 1}`, kind: 'table' as const})),
    ];
    // 图形包围盒可能跨栏并圈入下方的正文：图内只有小字短标签属于图形，题注、成句的行、紧随成句行的续行以及幻灯片这类大字号页面上 12 磅以上的图内文字（流程图里的文字）仍是正文；论文页眉图里的期刊名等大字仍属于图。
    const directFigureLines = new Set(wrappers.length ? lines.filter(line => attachedFigureLabels.has(line)
        || figureShapes.some(shape => coversLine(shape, line))) : []);
    const sentenceLine = (line: LayoutLine) => textUnits(line.text) >= 7
        && (!directFigureLines.has(line) || /[,.!?;:，。！？；：]/u.test(line.text));
    const prose = new Set<LayoutLine>(panelLines.keys());
    for (const line of lines) {
        if (CAPTION_START.test(line.text) || sentenceLine(line)) prose.add(line);
        else if (lines.some(near => near.baseline < line.baseline && line.baseline - near.baseline <= near.fontSize * 1.5 && Math.abs(near.fontSize - line.fontSize) <= 0.6 && line.x >= near.x - 1 && line.x - near.x <= font * 2.2 && right(line) <= right(near) + 2 && sentenceLine(near))) prose.add(line);
    }
    const inRegion = (region: PdfPreservedRegion, line: LayoutLine) => coversLine(region, line)
        && !(region.kind === 'figure' && (prose.has(line) || wrappers.length > 0 && !directFigureLines.has(line)
            || (font >= 14 && line.fontSize >= 12 && readable(line.text))));
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
    return {regions, shadedTables, inRegion, ordinary, mathLabels, sentenceLine};
}

function orderReadingBlocksAndRegions(
    blocks: PdfLayoutBlock[],
    blockTables: ReadonlyMap<PdfLayoutBlock, PdfPreservedRegion>,
    borderlessTables: ReturnType<typeof findBorderlessTables>,
    borderlessCaptions: ReadonlySet<LayoutLine>,
    regions: PdfPreservedRegion[],
    pageWidth: number,
    font: number,
): {blocks: PdfLayoutBlock[]; preservedRegions: PdfPreservedRegion[]} {
    // 表格以完整区域参与分栏；内部按物理单元格行列展开，不能把较宽的描述列提前当成通栏正文。
    const tableGroups = new Map<PdfPreservedRegion, PdfLayoutBlock[]>();
    for (const block of blocks) {
        const table = blockTables.get(block);
        if (table) {const cells = tableGroups.get(table) ?? []; cells.push(block); tableGroups.set(table, cells);}
    }
    const tableUnits = new Map<PdfLayoutBlock, PdfLayoutBlock[]>();
    const tableCaptions = new Map<PdfLayoutBlock, PdfLayoutBlock>();
    const readingBlocks = blocks.filter(block => !blockTables.has(block));
    for (const [region, cells] of tableGroups) {
        const unit: PdfLayoutBlock = {...cells[0], ...region, source: '', kind: 'table'};
        const title = readingBlocks.find(block => block.lines!.some(line => borderlessCaptions.has(line as LayoutLine))
            && borderlessTables.some(table => table.bounds.x === region.x && table.bounds.y === region.y && table.caption.text === block.source));
        if (title) {
            readingBlocks.splice(readingBlocks.indexOf(title), 1);
            unit.y = Math.min(title.y, region.y);
            unit.height = bottom(region) - unit.y;
            tableCaptions.set(unit, title);
        }
        tableUnits.set(unit, cells);
        readingBlocks.push(unit);
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
        ordered.push(...band.sort((a, b) => a.kind === 'metadata' && b.kind === 'metadata' ? a.y - b.y || a.x - b.x : a.column! - b.column! || a.y - b.y));
        band = [];
    };
    for (const block of readingBlocks.sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (block.width > pageWidth * 0.58 || (block.kind === 'heading' && block.textAlign === 'center') || block.kind === 'footer') {flush(); block.column = 0; ordered.push(block);}
        else band.push(block);
    }
    flush();
    const reading = ordered.flatMap(block => {
        const cells = tableUnits.get(block);
        if (!cells) return [block];
        // 这些单元格均由 table 草稿创建，cellBounds 在登记 blockTables 前已经生成。
        const rows = uniqueEdges(cells.map(cell => cell.cellBounds!.y));
        const rowOf = new Map(cells.map(cell => [cell, rows.findIndex(y => Math.abs(y - cell.cellBounds!.y) < .6)]));
        const sorted = cells.sort((a, b) => rowOf.get(a)! - rowOf.get(b)!
            || a.cellBounds!.x - b.cellBounds!.x || a.y - b.y).map(cell => {cell.column = block.column; return cell;});
        const title = tableCaptions.get(block);
        return title ? [title, ...sorted] : sorted;
    });
    reading.forEach(block => {block.readingOrder = readingOrder++;});
    // 同一图带中的左右子图可能顶边不齐，按重叠高度识别同带后从左向右阅读。
    const regionBands: PdfPreservedRegion[][] = [];
    for (const region of regions.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const currentBand = regionBands.at(-1);
        if (region.kind === 'figure' && currentBand?.every(previous => previous.kind === 'figure')
            && currentBand.some(previous => Math.min(bottom(region), bottom(previous)) - Math.max(region.y, previous.y) > Math.min(region.height, previous.height) * .5)) {
            currentBand.push(region);
        } else regionBands.push([region]);
    }
    return {blocks: reading, preservedRegions: regionBands.flatMap(currentBand => currentBand.sort((a, b) => a.x - b.x))};
}

export function analyzePdfPageLayout(input: PageLayoutInput): {blocks: PdfLayoutBlock[]; preservedRegions: PdfPreservedRegion[]} {
    const borderlessTables = findBorderlessTables(input.atoms, input.graphics, input.width);
    const captionedTables = [...captionedTableGeometry(input.atoms, input.graphics, input.width), ...borderlessTables];
    const tableDividers = captionedTables.flatMap(table => table.dividers);
    const {verticalDividers, horizontalCellDividers} = resolveCellDividers(input, tableDividers);

    // 正文字号按字符数加权取中位数，标题、脚注和页眉不主导版面基准。
    const sized = input.atoms.filter(atom => atom.fontSize >= 6).sort((a, b) => a.fontSize - b.fontSize);
    let remaining = sized.reduce((sum, atom) => sum + atom.text.length, 0) / 2;
    const font = sized.find(atom => (remaining -= atom.text.length) <= 0)?.fontSize ?? 10;
    const wrappers = input.graphics.filter(shape => isPageWrapper(shape, input.width, input.height));
    const panelCandidates = wrappers.length ? findTextPanels(input, font) : [];
    const panelAtoms = new Set<PdfLayoutAtom>();
    const panelLines = new Map<LayoutLine, TextPanel>();
    for (const panel of panelCandidates) {
        if (panel.atoms.some(atom => panelAtoms.has(atom))) continue;
        for (const atom of panel.atoms) panelAtoms.add(atom);
        for (const line of panel.lines) panelLines.set(line, panel);
    }
    const panelBackgrounds = new Set(panelCandidates.filter(panel => panel.atoms.every(atom => panelAtoms.has(atom))).map(panel => panel.box));
    const rawLines = pdfLayoutLines(panelAtoms.size ? input.atoms.filter(atom => !panelAtoms.has(atom)) : input.atoms, verticalDividers, horizontalCellDividers);
    if (panelLines.size) {
        rawLines.push(...panelLines.keys());
        rawLines.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
    }

    const {lines, bulleted, listMarkers, tocEntries} = normalizeBulletsAndLeaders(rawLines, panelLines);
    // 正文行距：同栏、正文字号的上下相邻两行之间最常见的基线距离。文字处理软件导出的文档常用 1.5 到 2 倍行距，
    // 段落合并与标题折行的间距上限随它放宽；常见的单倍行距（不超过字号的 1.25 倍）保持原有上限。
    const bodyGaps: number[] = [];
    lines.forEach((line, index) => {
        if (Math.abs(line.fontSize - font) > 0.6) return;
        for (let next = index + 1; next < lines.length && lines[next].baseline - line.baseline <= font * 2.8; next += 1) {
            const below = lines[next];
            const gap = below.baseline - line.baseline;
            if (gap > font * 0.9 && Math.abs(below.fontSize - font) <= 0.6 && Math.min(right(line), right(below)) - Math.max(line.x, below.x) >= Math.min(line.width, below.width) * 0.5) {
                bodyGaps.push(gap);
                break;
            }
        }
    });
    const loose = bodyGaps.length >= 3 ? Math.max(1, median(bodyGaps) / (font * 1.25)) : 1;
    const borderlessCaptions = new Set(lines.filter(line => borderlessTables.some(table => line.text === table.caption.text
        && Math.abs(line.x - table.caption.x) <= 1 && Math.abs(line.y - table.caption.y) <= 1)));

    const {regions, shadedTables, inRegion, ordinary, mathLabels, sentenceLine} = detectRegionsAndMath(
        input, lines, font, wrappers, panelBackgrounds, panelLines, bulleted, captionedTables,
    );

    const authorRows = ordinary.filter(line => line.y < input.height * 0.45 && line.width < input.width * 0.35);
    const authorBuckets = new Map<number, LayoutLine[]>();
    for (const line of authorRows) {
        const key = Math.round(line.baseline / 2);
        const bucket = authorBuckets.get(key) || [];
        bucket.push(line);
        authorBuckets.set(key, bucket);
    }
    const nameLike = (line: LayoutLine) => /^[\p{Lu}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*){0,3}$/u.test(line.text);
    const gridRows = [...authorBuckets.values()].filter(bucket => bucket.length >= 3);
    const namedRows = gridRows.filter(bucket => bucket.every(nameLike) && lines.some(above => above.baseline < bucket[0].baseline && above.fontSize > bucket[0].fontSize * 1.3));
    const authorGrid = ordinary.some(line => line.text.includes('@')) ? gridRows.flat() : namedRows.length >= 2 ? namedRows.flat() : [];
    const authorStart = authorGrid.reduce((start, line) => Math.min(start, line.y), Infinity);
    const authorEnd = authorGrid.reduce((end, line) => Math.max(end, bottom(line)), -Infinity) + font * 4.5;

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
    const authorDetails = new Set<LayoutLine>();
    for (const [index, line] of ordinary.entries()) {
        if (line.y >= input.height * 0.45 || CAPTION_START.test(line.text) || bulleted.has(line) || tocEntries.has(line)) continue;
        const nameText = line.text.replace(/(?<=\p{L})\s*[´¨]\s*(?=\p{Ll})/gu, '');
        if (byline.test(nameText) && lines.some(above => above.baseline < line.baseline && above.fontSize > line.fontSize * 1.1)) {
            authorDetails.add(line);
            continue;
        }
        const previous = ordinary[index - 1];
        if (previous && authorDetails.has(previous) && line.text.length < 120
            && (contactLine.test(line.text) || !sentenceLine(line) && affiliationLine.test(line.text))
            && line.baseline > previous.baseline && line.baseline - previous.baseline <= previous.fontSize * 2.5
            && line.fontSize <= previous.fontSize * 1.05 && (Math.abs(line.x - previous.x) <= font
                || Math.abs(line.x + line.width / 2 - previous.x - previous.width / 2) <= font)) authorDetails.add(line);
    }

    const classify = (line: LayoutLine): DraftBlock['kind'] => {
        if (footnotes.has(line)) return 'text';
        if (line.y > input.height * 0.92 && /^\d{1,4}$/u.test(line.text.trim())) return 'footer';
        const header = bottom(line) < input.height * 0.065;
        const trailer = line.y > input.height * 0.945;
        if ((header || trailer) && line.fontSize <= font * 1.05 && line.text.length < 120
            && !lines.some(near => header ? near.y >= bottom(line) - 1 && near.y - bottom(line) < font * 1.2 : bottom(near) <= line.y + 1 && line.y - bottom(near) < font * 1.2)) return 'footer';
        if (CAPTION_START.test(line.text) || borderlessCaptions.has(line)) return 'caption';
        if (authorDetails.has(line)) return 'metadata';
        if (spacedSectionTitle(line) && !mathLabels.has(line) && !authorGrid.includes(line) && !regions.some(region => coversLine(region, line))
            && lines.some(near => near.baseline - line.baseline >= line.fontSize * .8 && near.baseline - line.baseline <= line.fontSize * 3.5
                && near.fontSize >= line.fontSize * .65 && near.fontSize <= line.fontSize * 1.15
                && near.x <= line.x + line.width / 2 && right(near) >= line.x + line.width / 2 && readable(near.text) && textUnits(near.text) >= 5)) return 'heading';
        if (mathLabels.has(line) || !readable(line.text)) return 'formula';
        const numbered = line.fontSize >= font * 0.95 && line.text.length < 120;
        const listItem = () => lines.some(near => near.baseline > line.baseline && near.baseline - line.baseline <= line.fontSize * 1.45 * loose
            && (near.x > line.x + 2 ? near.x - line.x <= font * 4 : Math.abs(near.x - line.x) <= 1 && near.width >= line.width * 0.9));
        const midParagraph = () => lines.some(near => near.baseline < line.baseline && line.baseline - near.baseline <= line.fontSize * 1.45 * loose
            && Math.abs(near.fontSize - line.fontSize) <= 0.6 && near.x <= line.x + 1 && right(near) >= right(line) - 2 && near.width >= line.width * 0.9 && !/[.!?:。！？：]$/u.test(near.text));
        if ((numbered && !/[-‐‑]$/u.test(line.text) && !midParagraph() && ((/^\d+(?:\.\d+)*\s+[A-Z]/u.test(line.text) && !(line.text.split(/\s+/u).length > 6 && listItem())) || (/^\d+(?:\.\d+)*\.\s+[A-Z]/u.test(line.text) && line.text.split(/\s+/u).length <= 9 && !/[.,;:]$/u.test(line.text) && !listItem())))
            || (line.text.length < 80 && sectionTitle.test(line.text))
            || (numbered && /^(?:[IVXLC]+|[A-Z])\.\s+[A-Z]/u.test(line.text) && line.text.split(/\s+/u).length <= 10 && !/[.,;:]$/u.test(line.text) && !/\s[A-Z]\.\s/u.test(line.text) && !midParagraph() && !listItem()) || (line.fontSize >= font * 1.32 && line.text.length < 100)) return 'heading';
        if (line.text.includes('@') || (line.y >= authorStart && line.y <= authorEnd && line.width < input.width * 0.35 && line.text.length < 100)) return 'metadata';
        return 'text';
    };

    const columnEdges = new Map<string, number>();
    const columnRight = (line: LayoutLine) => {
        const key = `${Math.round(line.x)}:${Math.round(line.fontSize * 2)}`;
        if (!columnEdges.has(key)) columnEdges.set(key, lines.reduce((edge, other) => Math.abs(other.x - line.x) <= font * 3 && Math.abs(other.fontSize - line.fontSize) <= 0.6 ? Math.max(edge, right(other)) : edge, 0));
        return columnEdges.get(key)!;
    };
    const tableEdges = new Map<PdfPreservedRegion, {xs: number[]; ys: number[]; rules: Rectangle[]}>();
    const cellBounds = (draft: DraftBlock): Rectangle | undefined => {
        if (draft.region?.kind !== 'table') return;
        const region = draft.region;
        if (!tableEdges.has(region)) {
            const rules = [...input.graphics, ...tableDividers.map(divider => ({...divider, kind: 'path'}))].filter(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
                && shape.y >= region.y - 2 && bottom(shape) <= bottom(region) + 2);
            const vertical = rules.filter(shape => shape.width <= 2 && shape.height >= 4);
            let xs = uniqueEdges([region.x, ...vertical.map(shape => shape.x), right(region)]);
            if (!vertical.length && shadedTables.some(table => Math.abs(table.y - region.y) < 1 && Math.abs(table.x - region.x) < 1)) {
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
        const first = draft.lines[0];
        const last = draft.lines.at(-1)!;
        const x = [...xs].reverse().find(edge => edge <= center) ?? region.x;
        const endX = xs.find(edge => edge > center) ?? right(region);
        const localRows = uniqueEdges(rules.filter(shape => shape.height <= 2 && shape.width >= 6 && shape.x <= x + 2 && right(shape) >= endX - 2)
            .flatMap(shape => [shape.y, bottom(shape)]));
        const shortEdges = rules.filter(shape => shape.width <= 2 && shape.height >= 4 && shape.height <= font * 1.5
            && (Math.abs(shape.x - x) <= 1 || Math.abs(shape.x - endX) <= 1)).flatMap(shape => [shape.y, bottom(shape)]);
        const rowEdges = localRows.length >= 2 ? uniqueEdges([...localRows, ...shortEdges]) : ys;
        const y = [...rowEdges].reverse().find(edge => edge < first.baseline) ?? region.y;
        const endY = rowEdges.find(edge => edge > last.baseline) ?? bottom(region);
        return {x, y, width: Math.max(1, endX - x), height: Math.max(1, endY - y)};
    };
    let singleLineCells: Map<PdfPreservedRegion, Map<LayoutLine, Rectangle | undefined>> | undefined;
    const singleLineCellBounds = (line: LayoutLine, region: PdfPreservedRegion): Rectangle | undefined => {
        const regionCells = singleLineCells ??= new Map();
        let cells = regionCells.get(region);
        if (!cells) {cells = new Map(); regionCells.set(region, cells);}
        if (!cells.has(line)) cells.set(line, cellBounds({lines: [line], kind: 'table', region, bounds: line}));
        return cells.get(line);
    };
    const sameGridCell = (last: LayoutLine, line: LayoutLine, region: PdfPreservedRegion) => {
        const first = singleLineCellBounds(last, region);
        const next = singleLineCellBounds(line, region);
        return !!first && !!next && tableEdges.get(region)!.rules.some(shape => shape.width <= 2 && shape.height >= 4)
            && first.x === next.x && first.y === next.y && first.width === next.width && first.height === next.height;
    };
    const newTableRow = (last: LayoutLine, line: LayoutLine, region: PdfPreservedRegion) => {
        if (sameGridCell(last, line, region)) {
            const cell = singleLineCellBounds(last, region)!;
            if (tableEdges.get(region)!.rules.some(shape => shape.height <= 2 && shape.width >= 6
                && shape.y > cell.y + 1 && bottom(shape) < bottom(cell) - 1
                && (shape.x >= right(cell) - 2 || right(shape) <= cell.x + 2))) return false;
        }
        const shaded = shadedTables.some(table => Math.abs(table.x - region.x) < 1 && Math.abs(table.y - region.y) < 1);
        if (input.graphics.some(shape => shape.kind === 'path' && shape.x >= region.x - 2 && right(shape) <= right(region) + 2
            && (shape.width >= region.width * 0.7 && (shape.height <= 2 || shaded) || shape.width <= 2 && shape.height <= line.fontSize * 1.5)
            && [shape.y, bottom(shape)].some(y => y > last.baseline + 1 && y < line.baseline - 1))) return true;
        const baselineSlack = captionedTables.some(table => Math.abs(table.bounds.x - region.x) < 1 && Math.abs(table.bounds.y - region.y) < 1) ? font * .35 : 1;
        return lines.some(other => coversLine(region, other) && Math.abs(other.baseline - line.baseline) <= baselineSlack
            && !readable(other.text) && /\d/u.test(other.text)
            && (!/\p{L}/u.test(other.text.replace(/(\d)[eE]([+\-−]?\d)/gu, '$1$2'))
                || /^[+\-−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+\-−]?\d+)?\s*°?\p{L}+\p{N}*(?:[\/·⋅*]°?\p{L}+\p{N}*)*$/u.test(other.text.trim())));
    };

    const drafts: DraftBlock[] = [];
    const panelDrafts = new Map<TextPanel, DraftBlock>();
    let active: DraftBlock[] = [];
    const lineIndexes = new Map(lines.map((line, index) => [line, index]));
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
    const unfinished = (draft: DraftBlock) => draft.kind === 'text' && !draft.region
        && !bulleted.has(draft.lines[0]) && !tocEntries.has(draft.lines[0])
        && !/^(?:[•●◦▪▫‣⁃]|\d+[.)])\s/u.test(draft.lines[0].text)
        && !/[.!?:;。！？：；]["')\]}]*$/u.test(draft.lines.at(-1)!.text);

    for (const [lineIndex, line] of lines.entries()) {
        active = active.filter(draft => {
            const last = draft.lines.at(-1)!;
            return line.baseline - last.baseline <= Math.max(Math.max(font, last.fontSize) * 1.7 * loose, unfinished(draft) ? last.fontSize * 2.4 : 0);
        });
        const region = regions.find(item => inRegion(item, line));
        const panel = panelLines.get(line);
        if (panel && !region) {
            const draft = panelDrafts.get(panel);
            if (draft) {draft.lines.push(line); draft.bounds = union(draft.bounds, line);}
            else {
                const next: DraftBlock = {lines: [line], kind: 'text', bounds: line, panel};
                panelDrafts.set(panel, next);
                drafts.push(next);
            }
            continue;
        }
        const kind = region ? region.kind === 'figure' ? 'figure-label' : region.kind : classify(line);
        let selected: DraftBlock | undefined;
        if (kind !== 'footer' && !/^\(\d+\)\s/u.test(line.text) && !bulleted.has(line) && !tocEntries.has(line)) {
            for (const draft of active) {
                const last = draft.lines.at(-1)!;
                if (tocEntries.has(last)) continue;
                const gap = line.baseline - last.baseline;
                if (gap > Math.max(font, last.fontSize) * 1.7 * loose && !(unfinished(draft) && kind === 'text'
                    && Math.abs(line.x - last.x) <= 1 && line.width < last.width * .8 && last.width >= last.fontSize * 20
                    && /^\p{Ll}/u.test(line.text) && gap <= last.fontSize * 2.4)) continue;
                const tightHeading = kind === 'heading' && Math.abs(line.fontSize - last.fontSize) <= 0.2
                    && Math.abs(line.x - last.x) <= 1 && gap <= last.fontSize * 1.05;
                const wrappedHeading = draft.kind === 'heading' && (kind === 'text' || kind === 'heading') && (draft.lines.length < 3 || tightHeading) && gap <= last.fontSize * 1.45 * loose
                    && (tightHeading || (Math.abs(line.x - last.x) <= 1 && line.width < last.width * 0.9) || (kind === 'heading' && Math.abs(line.fontSize - last.fontSize) <= 0.2 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= 2))
                    && !/[.!?。！？]$/u.test(last.text) && !/^\d+(?:\.\d+)*\.?\s/u.test(line.text);
                if (draft.region !== region || (kind === 'heading' ? !wrappedHeading : draft.kind !== kind && !(draft.kind === 'caption' && kind === 'text') && !wrappedHeading)) continue;
                if (draft.lines.length >= 2 && line.x < last.x - font * 0.8) continue;
                if (region?.kind === 'table' && (newTableRow(last, line, region) || !(/[-‐‑]$/u.test(last.text) || /^[\p{Ll}(]/u.test(line.text) || sameGridCell(last, line, region)))) continue;
                if (Math.abs(line.fontSize - last.fontSize) > Math.max(0.6, last.fontSize * 0.18)) continue;
                const overlap = Math.min(right(line), right(last)) - Math.max(line.x, last.x);
                const sameColumn = Math.abs(line.x - last.x) <= font * 2.2 || (overlap >= Math.min(line.width, last.width) * 0.72 && Math.abs(line.x + line.width / 2 - last.x - last.width / 2) <= font * 2);
                if (gap <= 0 || !sameColumn) continue;
                if (!region && (crossesColumnPeer(lineIndex, draft.bounds) || crossesColumnPeer(lineIndexes.get(last)!, line))) continue;
                const hangingContinuation = draft.lines.length === 1 && right(last) >= right(line) - 2 && line.x - last.x <= font * 3 && gap <= font * 1.32 * loose;
                if (/[.!?。！？]["')\]}]*$/u.test(last.text) && !hangingContinuation && (line.x - last.x > font * 0.8 || gap > font * 1.32 * loose)) continue;
                if ((cjkLine(last.text) || /[.!?。！？]$/u.test(last.text)) && !(hangingContinuation && line.x > last.x + 1) && right(last) < Math.max(right(line), columnRight(last)) - font * 2) continue;
                if (!selected || selected.lines.at(-1)!.baseline < last.baseline) selected = draft;
            }
        }
        if (selected) {selected.lines.push(line); selected.bounds = union(selected.bounds, line);}
        else {const draft = {lines: [line], kind, region, bounds: line}; drafts.push(draft); active.push(draft);}
    }

    for (let index = drafts.length - 1; index >= 0; index -= 1) {
        const draft = drafts[index];
        if (draft.region?.kind !== 'table' || draft.lines.length < 2 || !drafts.some(other => other !== draft && overlaps(draft.bounds, other.bounds, -1))) continue;
        drafts.splice(index, 1, ...draft.lines.map(line => ({...draft, lines: [line], bounds: line as Rectangle})));
    }
    for (const draft of drafts) {
        const line = draft.lines[0];
        if (draft.kind !== 'text' || draft.lines.length > 1 || textUnits(line.text) >= 4) continue;
        const centerX = line.x + line.width / 2;
        const centerY = line.y + line.height / 2;
        const loweredOperator = line.runs.find(run => /^[\p{L}\p{N}]$/u.test(run.text) && run.fontSize >= line.fontSize * 0.85
            && run.baseline - run.y <= line.fontSize * 0.25 && bottom(run) - run.baseline >= line.fontSize * 0.65);
        if (drafts.some(other => other !== draft && other.lines.length > 1 && (other.kind === 'text' || other.kind === 'caption')
            && (line.fontSize <= other.lines[0].fontSize * 0.85 || loweredOperator && other.lines.some(peer => peer.runs.some(run => /[=∑∫∏]/u.test(run.text)
                && loweredOperator.x >= right(run) && loweredOperator.x - right(run) <= run.fontSize * 1.5
                && Math.abs(run.y - loweredOperator.y) <= run.fontSize * 0.35)))
            && centerX >= other.bounds.x && centerX <= right(other.bounds) && centerY >= other.bounds.y && centerY <= bottom(other.bounds))) draft.kind = 'formula';
    }

    const blockTables = new Map<PdfLayoutBlock, PdfPreservedRegion>();
    const blocks: PdfLayoutBlock[] = drafts.map(draft => {
        const first = draft.lines[0];
        const source = joinPdfSourceLines(draft.lines, draft.kind);
        const leading = draft.lines.slice(1).map((line, index) => line.baseline - draft.lines[index].baseline);
        const center = draft.bounds.x + draft.bounds.width / 2;
        const centered = draft.panel?.centered || (draft.kind === 'heading' || draft.kind === 'metadata' || draft.kind === 'footer') && Math.abs(center - input.width / 2) <= input.width * 0.045;
        const cell = cellBounds(draft);
        const panel = draft.panel?.box;
        const marker = listMarkers.get(first);
        const block: PdfLayoutBlock = {
            ...draft.bounds,
            source,
            ...(marker ? {listMarker: marker.text, listMarkerRun: {...marker.run, text: marker.text}} : {}),
            ...(cell ? {cellBounds: cell} : {}),
            fontSize: median(draft.lines.map(line => line.fontSize)),
            lineHeight: leading.length ? median(leading) : first.fontSize,
            lineCount: draft.lines.length,
            fontFamily: first.fontFamily,
            fontWeight: draft.kind === 'heading' ? 700 : 400,
            textAlign: centered ? 'center' : 'left',
            kind: draft.kind,
            preserveSource: (draft.region ? draft.region.kind !== 'table' || !readable(source) : false) || draft.kind === 'metadata' || draft.kind === 'footer' || draft.kind === 'formula',
            lines: draft.lines,
        };
        if (panel) block.panelBounds = union(panel, {x: block.x - 1.5, y: block.y - 1.5, width: block.width + 3, height: block.height + 4});
        if (draft.region?.kind === 'table') blockTables.set(block, draft.region);
        return block;
    });

    return orderReadingBlocksAndRegions(blocks, blockTables, borderlessTables, borderlessCaptions, regions, input.width, font);
}
