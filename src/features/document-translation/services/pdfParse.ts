/**
 * @file src/features/document-translation/services/pdfParse.ts
 * 文件职责：负责 PDF 文档的可取消加载、字形与数学轮廓边界提取、文本行与段落空间索引聚类、扫描页判定及待翻译片段登记。
 * 主要内容：按需加载 PDF.js 并在未旋转与展示坐标间自动恢复有效字形，复用已加载数学字体轮廓收紧包围盒，基于扫描线精确计算扫描图面积并集并输出结构化 PdfDocumentPage。
 * 模块边界：仅承担 PDF 输入解析与页面几何提取，不执行 PDF 译文导出、光栅渲染或翻译服务请求。
 */
import {getPdfResources, hasCustomPdfAssetRoot} from './pdfResources';
import {createPdfBinaryDataFactory, type PdfBinaryDataFactoryConstructor} from './pdfBinaryDataFactory';
import {analyzePdfPageLayout, extractPdfGraphicsShapes, type PdfGraphicsShape, type PdfLayoutAtom, type PdfLayoutBlock} from '../core/pdfLayoutAnalysis';
import {
    getDocumentFormatLabel,
    type DocumentSegment,
    type ParsedDocument,
    type PdfDocumentBlock,
    type PdfDocumentPage,
} from '@/src/features/document-translation/core/document';
import {
    awaitDocumentRead,
    median,
    type ParseDocumentFileOptions,
    type PdfTextAtom,
    type PdfTextItem,
    type PdfTextLine,
    type PdfTextStyle,
} from './binaryShared';

/** 数学字体常以整套字库极值声明 ascent/descent；短数学项使用已加载轮廓，普通长正文不额外解析路径。 */
const MATH_GLYPH_TOKEN = /^[A-Za-z\d\p{Script=Greek}\p{Sm}\p{P}\s]{1,32}$/u;

export function pdfTextAtoms(
    items: PdfTextItem[],
    styles: Record<string, PdfTextStyle>,
    viewport: {width: number; height: number; transform: number[]},
    includeLineDetails = false,
): PdfTextAtom[] {
    return items.flatMap((item, index) => {
        const text = item.str.replace(/\u0000/gu, '').replace(/[\t\u00a0 ]+/gu, ' ').trim();
        if (!text) return [];
        // 六元仿射矩阵相乘；坐标处理保持同步，无需为这一纯运算加载整个 PDF.js。
        const a = viewport.transform;
        const b = item.transform as number[];
        const transform = [
            a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
        ];
        const angle = Math.atan2(transform[1], transform[0]);
        if (Math.abs(angle) > 0.12) return [];
        const style = styles[item.fontName] || {};
        const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]) || item.height || 1);
        // Type 1 字体可能给出 NaN 或全零指标；零 ascent 会把字形顶部误放到基线，遮罩漏掉正文。
        // 保留数学字体合法的小正 ascent；仅无效时采用有限负 descent 或既有的 0.8em 回退。
        const ascent = typeof style.ascent === 'number' && Number.isFinite(style.ascent) && style.ascent > 0
            ? style.ascent
            : typeof style.descent === 'number' && Number.isFinite(style.descent) && style.descent < 0 && style.descent > -1
                ? 1 + style.descent
                : 0.8;
        const x = transform[4];
        let y = transform[5] - fontHeight * ascent;
        // 高 ascent 字体的一个 em 不一定覆盖 p/g 降部；按声明的负 descent 补足字形下界。
        // 只扩展边界，保留既有最小高度；字号、基线、advance 和遮罩 padding 不变。
        let height = typeof style.descent === 'number' && Number.isFinite(style.descent) && style.descent < 0
            ? fontHeight * Math.max(1, ascent - style.descent)
            : fontHeight;
        let width = Math.max(fontHeight * 0.2, Math.abs(item.width));
        const fontWidth = Math.hypot(transform[0], transform[1]);
        const stretchedDelimiter = fontWidth > 0 && fontHeight > fontWidth * 1.4 && /^[|¦∥()[\]{}=+\-−?.,;:!\s]+$/u.test(text);
        let layoutFontSize: number | undefined;
        if (style.glyphBounds && Math.abs(transform[1]) < .01 && Math.abs(transform[2]) < .01) {
            const bounds = Array.from(text.replace(/\s/gu, ''), character => style.glyphBounds!.get(character));
            if (bounds.every((value): value is readonly [number, number] => !!value)) {
                const top = Math.max(...bounds.map(value => value[1])), bottom = Math.min(...bounds.map(value => value[0]));
                y = transform[5] - fontHeight * top;
                height = fontHeight * (top - bottom);
                width = Math.max(fontWidth * 0.2, Math.abs(item.width));
                // 原始纵向字号供导出矩阵使用；已证实的非剪切拉伸字形按横向字号参与基线与脚标归组。
                if (stretchedDelimiter && Math.abs(transform[1]) < .01 && Math.abs(transform[2]) < .01) layoutFontSize = fontWidth;
            }
        }
        if (!Number.isFinite(item.width) || item.width === 0) {
            // PDF.js 的多码点字形（如含 variation selector 的数学字母）可能丢失 advance。
            // 只在此时估算：组合/格式字符不占额外 em；孤立组合符沿用原来的小矩形。
            width = fontHeight * Math.max(0.2, Array.from(text.replace(/[\p{M}\p{Cf}\s]/gu, '')).length);
            // 前后各四项的物理右邻起点给出更紧的范围，兼容 RTL 提取顺序；不跨行或借用远栏。
            for (let neighbour = Math.max(0, index - 4); neighbour <= Math.min(items.length - 1, index + 4); neighbour += 1) {
                if (neighbour === index) continue;
                const next = items[neighbour];
                if (!next.str.replace(/[\p{M}\p{Cf}\u0000\s]/gu, '')
                    && !(/^\s+$/u.test(next.str) && Number.isFinite(next.width) && next.width !== 0)) continue;
                const matrix = next.transform as number[];
                if (matrix.length < 6 || !matrix.slice(0, 6).every(Number.isFinite)) continue;
                if (Math.abs(Math.atan2(a[1] * matrix[0] + a[3] * matrix[1], a[0] * matrix[0] + a[2] * matrix[1])) > 0.12) continue;
                const gap = a[0] * matrix[4] + a[2] * matrix[5] + a[4] - x;
                const baseline = a[1] * matrix[4] + a[3] * matrix[5] + a[5];
                if (gap > fontHeight * 0.2 && gap < width && Math.abs(baseline - transform[5]) <= fontHeight * 0.6) width = gap;
            }
        }
        return [{
            text,
            x,
            y,
            width,
            height,
            fontFamily: style.fontFamily || 'sans-serif',
            ...(includeLineDetails ? {baseline: transform[5], fontSize: fontHeight, ...(layoutFontSize ? {layoutFontSize} : {})} : {}),
        }];
    }).filter((atom) => atom.x < viewport.width && atom.y < viewport.height && atom.x + atom.width > 0 && atom.y + atom.height > 0);
}

/**
 * /Rotate 通常只改变展示方向，仍优先使用未旋转内容坐标。
 * 少数实际报告先把文字物理转向再设 /Rotate：未旋转提取会删掉整页字形。
 * 只有展示坐标能恢复四分之三以上文字、且明显优于原坐标时才采用它；沿用扫描页已有 sourceRotation 契约，原页导出方向与文字坐标分别保留。
 */
export function pdfPageTextGeometry(items: PdfTextItem[], styles: Record<string, PdfTextStyle>,
    display: {width: number; height: number; transform: number[]; rotation?: number},
    canonical: {width: number; height: number; transform: number[]}) {
    const rotation = (((display.rotation || 0) % 360 + 360) % 360) as NonNullable<PdfDocumentPage['rotation']>;
    const atoms = pdfTextAtoms(items, styles, canonical, true) as PdfLayoutAtom[];
    if (rotation) {
        const characters = (values: readonly {text: string}[]) => values.reduce((sum, item) => sum + item.text.replace(/\s/gu, '').length, 0);
        const total = items.reduce((sum, item) => sum + item.str.replace(/[\s\u0000]/gu, '').length, 0), count = characters(atoms);
        if (count < total * .5) {
            const visible = pdfTextAtoms(items, styles, display, true) as PdfLayoutAtom[], recovered = characters(visible);
            if (recovered > 0 && recovered >= total * .75 && recovered > count * 2) return {viewport: display, atoms: visible, sourceRotation: rotation};
        }
    }
    return {viewport: canonical, atoms, ...(rotation ? {rotation} : {})};
}

export function pdfTextLines(atoms: PdfTextAtom[], pageWidth: number): PdfTextLine[] {
    const rows: PdfTextAtom[][] = [];
    let rowHeight = 0;
    [...atoms].sort((left, right) => left.y - right.y || left.x - right.x).forEach((atom) => {
        const row = rows.at(-1);
        // 全局排序保证当前 row 的 y 有序，直接取中位位置，避免每加入一项复制并排序整行。
        const middle = row ? Math.floor(row.length / 2) : 0;
        const rowY = row ? row.length % 2 === 0 ? (row[middle - 1].y + row[middle].y) / 2 : row[middle].y : 0;
        if (!row || Math.abs(atom.y - rowY) > Math.max(2, rowHeight * 0.42, atom.height * 0.42)) {
            rows.push([atom]);
            rowHeight = atom.height;
        } else {
            row.push(atom);
            rowHeight = Math.max(rowHeight, atom.height);
        }
    });

    const lines: PdfTextLine[] = [];
    const addLine = (entries: PdfTextAtom[]) => {
        const ordered = [...entries].sort((left, right) => left.x - right.x);
        let text = '';
        let endX: number | undefined;
        ordered.forEach((entry) => {
            const gap = endX === undefined ? 0 : entry.x - endX;
            if (text && gap > Math.max(1.2, entry.height * 0.08)
                && !/[\s\-–—/]$/u.test(text)
                && !/^[,.;:!?，。；：！？)\]}]/u.test(entry.text)) text += ' ';
            text += entry.text;
            endX = Math.max(endX ?? entry.x, entry.x + entry.width);
        });
        // PDF 文本层可包含超过引擎实参上限的碎片；二元归约保留 NaN、±0、Infinity 语义。
        let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
        ordered.forEach((entry) => {
            x = Math.min(x, entry.x);
            y = Math.min(y, entry.y);
            right = Math.max(right, entry.x + entry.width);
            bottom = Math.max(bottom, entry.y + entry.height);
        });
        const dominant = [...ordered].sort((left, rightEntry) => rightEntry.width - left.width)[0];
        const normalized = text.replace(/[\t\u00a0 ]+/gu, ' ').trim();
        if (normalized) lines.push({
            text: normalized,
            x,
            y,
            width: Math.max(1, right - x),
            height: Math.max(1, bottom - y),
            fontFamily: dominant.fontFamily,
        });
    };

    rows.forEach((row) => {
        const ordered = [...row].sort((left, right) => left.x - right.x);
        let group: PdfTextAtom[] = [];
        let endX: number | undefined;
        ordered.forEach((atom) => {
            const gap = endX === undefined ? 0 : atom.x - endX;
            const splitGap = Math.max(atom.height * 3.2, pageWidth * 0.055);
            if (group.length > 0 && gap > splitGap) {
                addLine(group);
                group = [];
            }
            group.push(atom);
            endX = Math.max(endX ?? atom.x, atom.x + atom.width);
        });
        addLine(group);
    });
    return lines.sort((left, right) => left.y - right.y || left.x - right.x);
}

type PdfLineGeometry = Pick<PdfTextLine, 'x' | 'y' | 'width' | 'height'>;

interface PdfTextBlockDraft {
    order: number;
    inputIndex: number;
    geometry: PdfLineGeometry;
    lines: PdfTextLine[];
    bounds: {x: number; y: number; right: number; bottom: number};
}

/**
 * 按输入行的初始底边和横坐标组织平衡空间树，叶子保留建段身份，合并后更新祖先包围区间。
 * 查询只排除原 gap/对齐/重叠运算必定不合格的子树；不改输入处理顺序，也不丢弃旧段。
 * 非标题末行高度小于 maxHeight，横向对齐余量用末行宽度给出保守上界。
 * 区间变松时仍遍历所有可能候选，不截断正文；非有限几何沿用完整遍历的公共语义。
 */
function createPdfDraftIndex(lines: PdfLineGeometry[], maxHeight: number, bodyHeight: number) {
    const entries = lines.map((line, inputIndex) => ({inputIndex, bottom: line.y + line.height, x: line.x, right: line.x + line.width}));
    if (!Number.isFinite(maxHeight) || entries.some(entry => !Number.isFinite(entry.bottom) || !Number.isFinite(entry.x) || !Number.isFinite(entry.right))) return;
    entries.sort((left, right) => left.bottom - right.bottom || left.x - right.x);
    const positions: number[] = [];
    entries.forEach((entry, position) => {positions[entry.inputIndex] = position;});
    let size = 1;
    while (size < entries.length) size *= 2;
    const counts = new Uint32Array(size * 2);
    const minBottom = new Float64Array(size * 2).fill(Infinity);
    const maxBottom = new Float64Array(size * 2).fill(-Infinity);
    const minX = new Float64Array(size * 2).fill(Infinity);
    const maxRight = new Float64Array(size * 2).fill(-Infinity);
    const minLastX = new Float64Array(size * 2).fill(Infinity);
    const maxLastX = new Float64Array(size * 2).fill(-Infinity);
    const maxAlignment = new Float64Array(size * 2);
    const drafts: PdfTextBlockDraft[] = [];
    const add = (draft: PdfTextBlockDraft) => {
        const position = positions[draft.inputIndex];
        drafts[position] = draft;
        let node = size + position;
        const last = draft.geometry;
        counts[node] = 1;
        minBottom[node] = maxBottom[node] = draft.bounds.bottom;
        minX[node] = draft.bounds.x;
        maxRight[node] = draft.bounds.right;
        minLastX[node] = maxLastX[node] = last.x;
        maxAlignment[node] = Math.max(bodyHeight * 1.5, last.width * 0.12);
        while (node > 1) {
            node = Math.floor(node / 2);
            const left = node * 2, right = left + 1;
            counts[node] = counts[left] + counts[right];
            minBottom[node] = Math.min(minBottom[left], minBottom[right]);
            maxBottom[node] = Math.max(maxBottom[left], maxBottom[right]);
            minX[node] = Math.min(minX[left], minX[right]);
            maxRight[node] = Math.max(maxRight[left], maxRight[right]);
            minLastX[node] = Math.min(minLastX[left], minLastX[right]);
            maxLastX[node] = Math.max(maxLastX[left], maxLastX[right]);
            maxAlignment[node] = Math.max(maxAlignment[left], maxAlignment[right]);
        }
    };
    const forEach = (line: PdfLineGeometry, consume: (draft: PdfTextBlockDraft) => void) => {
        const y = line.y, x = line.x, right = x + line.width;
        const minimumGap = -Math.max(2, line.height * 0.2);
        const maximumGap = maxHeight * 0.95;
        const visit = (node: number): void => {
            // 保留原减法，避免将浮点边界改写为坐标加减 tolerance。
            if (!counts[node] || y - maxBottom[node] > maximumGap || y - minBottom[node] < minimumGap) return;
            const cannotOverlap = right <= minX[node] || x >= maxRight[node];
            const cannotAlign = x - maxLastX[node] > maxAlignment[node] || minLastX[node] - x > maxAlignment[node];
            if (cannotOverlap && cannotAlign) return;
            if (node >= size) {
                consume(drafts[node - size]);
                return;
            }
            visit(node * 2);
            visit(node * 2 + 1);
        };
        visit(1);
    };
    return {add, forEach};
}

export function pdfTextBlocks(lines: PdfTextLine[], pageWidth: number): Array<Omit<PdfDocumentBlock, 'segmentIndex'> & {source: string}> {
    if (lines.length === 0) return [];
    // 每行几何读取一次，索引和原评分共用，避免长合并段为了维护索引回退到重复属性读取。
    const geometries = lines.map(line => ({x: line.x, y: line.y, width: line.width, height: line.height}));
    const bodyHeight = Math.max(1, median(geometries.map((line) => line.height).filter((height) => height >= 4)));
    const drafts: PdfTextBlockDraft[] = [];
    const isHeading = (line: PdfLineGeometry) => line.height >= bodyHeight * 1.32;
    const index = createPdfDraftIndex(geometries, bodyHeight * 1.32, bodyHeight);

    lines.forEach((line, inputIndex) => {
        const geometry = geometries[inputIndex];
        let selected: PdfTextBlockDraft | undefined;
        let selectedGap = Number.POSITIVE_INFINITY;
        if (!isHeading(geometry)) {
            const consider = (draft: PdfTextBlockDraft) => {
                const last = draft.lines.at(-1)!;
                const lastGeometry = draft.geometry;
                if (!index && isHeading(lastGeometry)) return;
                const draftBounds = draft.bounds;
                const gap = geometry.y - draftBounds.bottom;
                if (gap < -Math.max(2, geometry.height * 0.2) || gap > Math.max(lastGeometry.height, geometry.height) * 0.95) return;
                const overlap = Math.max(0, Math.min(draftBounds.right, geometry.x + geometry.width) - Math.max(draftBounds.x, geometry.x));
                const overlapRatio = overlap / Math.max(1, Math.min(draftBounds.right - draftBounds.x, geometry.width));
                const aligned = Math.abs(geometry.x - lastGeometry.x) <= Math.max(bodyHeight * 1.5, Math.min(lastGeometry.width, geometry.width) * 0.12);
                const fontRatio = Math.max(lastGeometry.height, geometry.height) / Math.max(1, Math.min(lastGeometry.height, geometry.height));
                const startsIndentedParagraph = /[.!?。！？]["')\]}]*$/u.test(last.text)
                    && geometry.x - lastGeometry.x > bodyHeight * 0.9;
                if ((!aligned && overlapRatio < 0.48) || fontRatio > 1.28 || startsIndentedParagraph) return;
                const paragraphGap = /[.!?。！？]["')\]}]*$/u.test(last.text) && gap > lastGeometry.height * 0.62;
                if (paragraphGap) return;
                // 索引按底边遍历，平分时仍选择原 drafts 顺序里的第一段。
                if (gap < selectedGap || (selected && gap === selectedGap && draft.order < selected.order)) {
                    selected = draft;
                    selectedGap = gap;
                }
            };
            if (index) index.forEach(geometry, consider);
            else drafts.forEach(consider);
        }
        if (selected) {
            selected.lines.push(line);
            selected.geometry = geometry;
            selected.bounds.x = Math.min(selected.bounds.x, geometry.x);
            selected.bounds.y = Math.min(selected.bounds.y, geometry.y);
            selected.bounds.right = Math.max(selected.bounds.right, geometry.x + geometry.width);
            selected.bounds.bottom = Math.max(selected.bounds.bottom, geometry.y + geometry.height);
            index?.add(selected);
        } else {
            const draft = {order: drafts.length, inputIndex, geometry, lines: [line], bounds: {x: geometry.x, y: geometry.y, right: geometry.x + geometry.width, bottom: geometry.y + geometry.height}};
            drafts.push(draft);
            if (!isHeading(geometry)) index?.add(draft);
        }
    });

    return drafts.map((draft) => {
        const draftBounds = draft.bounds;
        const first = draft.lines[0];
        // 只检查末行片段，最后一次合并全文；避免长段反复正则检查累计字符串时复制整段。
        const sourceParts: string[] = [];
        draft.lines.forEach((line) => {
            const previous = sourceParts.at(-1);
            if (previous === undefined) {
                if (line.text) sourceParts.push(line.text);
                return;
            }
            if (/[-‐‑]$/u.test(previous) && /^[a-z]/u.test(line.text)) {
                sourceParts[sourceParts.length - 1] = previous.slice(0, -1);
            } else {
                sourceParts.push(' ');
            }
            sourceParts.push(line.text);
        });
        const source = sourceParts.join('').replace(/\s+/gu, ' ').trim();
        const center = (draftBounds.x + draftBounds.right) / 2;
        const centered = Math.abs(center - pageWidth / 2) <= pageWidth * 0.045
            && draftBounds.right - draftBounds.x < pageWidth * 0.9;
        let fontSize = -Infinity;
        draft.lines.forEach(line => {fontSize = Math.max(fontSize, line.height);});
        return {
            source,
            x: Math.max(0, draftBounds.x),
            y: Math.max(0, draftBounds.y),
            width: Math.max(1, Math.min(pageWidth, draftBounds.right) - Math.max(0, draftBounds.x)),
            height: Math.max(1, draftBounds.bottom - draftBounds.y),
            fontSize,
            lineHeight: Math.max(1, median(draft.lines.map((line) => line.height))),
            lineCount: draft.lines.length,
            fontFamily: first.fontFamily,
            fontWeight: (isHeading(first) ? 700 : source.length <= 80 ? 600 : 400) as 400 | 600 | 700,
            textAlign: centered ? 'center' as const : 'left' as const,
        };
    }).filter((block) => block.source.length > 0)
        .sort((left, right) => left.y - right.y || left.x - right.x);
}

/** 少量原生页眉页脚不代表扫描图内已有文字层；原生正文与图表题注仍优先保留，重叠图像只计一次面积。 */
function isScannedPdfPage(atoms: readonly PdfLayoutAtom[], blocks: readonly PdfLayoutBlock[], graphics: readonly PdfGraphicsShape[], width: number, height: number): boolean {
    const pageNumber = /^(?:\d{1,4}|(?:page\s+)?\d{1,4}\s*(?:\/|of)\s*\d{1,4})$/iu;
    const images = graphics.filter(shape => shape.kind === 'image').map(shape => ({
        left: Math.max(0, shape.x), right: Math.min(width, shape.x + shape.width),
        top: Math.max(0, shape.y), bottom: Math.min(height, shape.y + shape.height),
    })).filter(image => image.right > image.left && image.bottom > image.top);
    const onlyPageNumbers = blocks.length > 0 && blocks.every(block => block.kind === 'footer'
        && block.y > height * .92 && pageNumber.test(block.source.trim()));
    if (atoms.length && !onlyPageNumbers) {
        // 公报、合同等会在扫描附件外再排一个原生标题或发布页脚。只有边缘少量文字、且与图像完全分离时才放行；
        // 不因一张大照片、图表的标题/题注，或被版面保护器归为 figure-label 的原生正文而覆盖现有文字层。
        const nativeBodyKinds: readonly PdfLayoutBlock['kind'][] = ['caption', 'metadata', 'formula', 'table'];
        if (!blocks.length || blocks.reduce((length, block) => length + block.source.length, 0) > 160
            || blocks.some(block => nativeBodyKinds.includes(block.kind)
                || /^(?:(?:fig(?:ure)?\.?|table|chart|plate|diagram|photo(?:graph)?|image)\s*(?:\d|[ivx]+\b|[:.])|[图表圖図]\s*[\d一二三四五六七八九十])/iu.test(block.source.trim()))) return false;
        let headerLines = 0, footerLines = 0;
        for (const block of blocks) {
            if (block.y + block.height <= height * .15) headerLines += block.lineCount;
            else if (block.y >= height * .85) footerLines += block.lineCount;
            else return false;
        }
        if (headerLines > 2 || footerLines > 2 || atoms.some(atom =>
            !(atom.y + atom.height <= height * .15 || atom.y >= height * .85)
            || images.some(image => atom.x < image.right && atom.x + atom.width > image.left
                && atom.y < image.bottom && atom.y + atom.height > image.top))) return false;
    }

    const target = width * height * .5;
    if (images.some(image => (image.right - image.left) * (image.bottom - image.top) >= target)) return true;
    if (images.length < 2) return false;

    // 扫描线配合区间覆盖计数，精确求图像并集；分块扫描件不要求单张图达到半页，重叠水印不会重复累加。
    const ys = [...new Set(images.flatMap(image => [image.top, image.bottom]))].sort((a, b) => a - b);
    const positions = new Map(ys.map((y, index) => [y, index]));
    const events = images.flatMap(image => [
        {x: image.left, from: positions.get(image.top)!, to: positions.get(image.bottom)!, delta: 1},
        {x: image.right, from: positions.get(image.top)!, to: positions.get(image.bottom)!, delta: -1},
    ]).sort((a, b) => a.x - b.x);
    const counts = new Int32Array(ys.length * 4), lengths = new Float64Array(ys.length * 4);
    const update = (node: number, left: number, right: number, from: number, to: number, delta: number): void => {
        if (from <= left && right <= to) counts[node] += delta;
        else {
            const middle = (left + right) >>> 1;
            if (from < middle) update(node * 2, left, middle, from, to, delta);
            if (to > middle) update(node * 2 + 1, middle, right, from, to, delta);
        }
        lengths[node] = counts[node] > 0 ? ys[right] - ys[left] : right - left > 1 ? lengths[node * 2] + lengths[node * 2 + 1] : 0;
    };
    let area = 0, previous = events[0].x;
    for (const event of events) {
        area += (event.x - previous) * lengths[1];
        if (area >= target) return true;
        update(1, 0, ys.length - 1, event.from, event.to, event.delta);
        previous = event.x;
    }
    return false;
}

/** PDF.js 6 FontPathInfo.path 按 DrawOPS 交错操作码和绝对坐标；只读取有限的包围盒数据。 */
function pdfGlyphYBounds(outline: unknown): readonly [number, number] | undefined {
    if (typeof outline !== 'object' || !outline || !('path' in outline)) return;
    const path = outline.path;
    if (!ArrayBuffer.isView(path) || !('length' in path)) return;
    const points = path as unknown as ArrayLike<number>;
    if (points.length > 4096 || points[0] !== 0) return; // moveTo
    const coordinateCounts = [2, 2, 6, 4, 0]; // moveTo, lineTo, curveTo, quadraticCurveTo, closePath
    let low = Infinity, high = -Infinity;
    for (let index = 0; index < points.length;) {
        const count = coordinateCounts[points[index++]];
        if (count === undefined || index + count > points.length) return;
        for (const end = index + count; index < end; index += 2) {
            const x = points[index], y = points[index + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            low = Math.min(low, y);
            high = Math.max(high, y);
        }
    }
    if (low >= -4 && high <= 4 && high > low) return [low, high];
}

/** 解析阶段本已禁用 FontFace；复用 PDF.js 已加载的数学分隔符、括号组件和重音轮廓，不保留额外字库或解析普通字体。 */
function pdfMathGlyphStyles(items: readonly PdfTextItem[], styles: Record<string, PdfTextStyle>,
    operators: {fnArray: readonly number[]; argsArray: readonly any[]}, ops: Record<string, number>,
    objects?: {has(key: string): boolean; get(key: string): any}): Record<string, PdfTextStyle> {
    if (!objects) return styles;
    const requested = new Map<string, Set<string>>();
    for (const item of items) {
        const matrix = item.transform as number[];
        const style = styles[item.fontName];
        if (style?.vertical) continue;
        if (!/^[⎛⎜⎝⎞⎟⎠⎡⎢⎣⎤⎥⎦⎧⎨⎩⎫⎬⎭→^\s]+$/u.test(item.str)
            && !(style && (style.ascent ?? 0) - (style.descent ?? 0) >= 1.25 && MATH_GLYPH_TOKEN.test(item.str))
            && (!/^[|¦∥()[\]{}=+\-−\s]+$/u.test(item.str) || Math.hypot(matrix[2], matrix[3]) <= Math.hypot(matrix[0], matrix[1]) * 1.4)) continue;
        let characters = requested.get(item.fontName);
        if (!characters) requested.set(item.fontName, characters = new Set());
        for (const character of item.str.replace(/\s/gu, '')) characters.add(character);
    }
    if (!requested.size) return styles;
    const result = {...styles};
    const boundsByFont = new Map<string, Map<string, readonly [number, number]>>();
    const visited = new Set<string>();
    const unsupported = new Map<string, Set<string>>();
    const fontStack: string[] = [];
    let font = '';
    for (let index = 0; index < operators.fnArray.length; index++) {
        const args = operators.argsArray[index];
        if (operators.fnArray[index] === ops.save || operators.fnArray[index] === ops.paintFormXObjectBegin) {fontStack.push(font); continue;}
        if (operators.fnArray[index] === ops.restore || operators.fnArray[index] === ops.paintFormXObjectEnd) {font = fontStack.pop() ?? font; continue;}
        if (operators.fnArray[index] === ops.setFont) {font = args[0]; continue;}
        if (operators.fnArray[index] !== ops.showText || !requested.has(font)) continue;
        for (const glyph of args[0]) {
            if (!glyph || typeof glyph.unicode !== 'string') continue;
            if (glyph.accent || glyph.vmetric || Array.from(glyph.unicode).length !== 1) {
                let characters = unsupported.get(font);
                if (!characters) unsupported.set(font, characters = new Set());
                for (const character of glyph.unicode) characters.add(character);
                continue;
            }
            if (!requested.get(font)!.has(glyph.unicode)) continue;
            const id = `${font}_path_${glyph.fontChar}`;
            if (visited.has(id)) continue;
            visited.add(id);
            try {
                if (!objects.has(id)) continue;
                const limits = pdfGlyphYBounds(objects.get(id));
                if (!limits) continue;
                const [low, high] = limits;
                let bounds = boundsByFont.get(font);
                if (!bounds) {boundsByFont.set(font, bounds = new Map()); result[font] = {...styles[font], glyphBounds: bounds};}
                const previous = bounds.get(glyph.unicode);
                // 同一 Unicode 可映射多种字体字形；取并集，不能只按首个较小字形裁切后续变体。
                bounds.set(glyph.unicode, previous ? [Math.min(previous[0], low), Math.max(previous[1], high)] : [low, high]);
            } catch { /* 缺失或不可读轮廓保持原字体边界，不能使整页导入失败。 */ }
        }
    }
    // 未解析组合重音位移、竖排指标及连字映射时，整项回退原字体范围，不能借其它同Unicode轮廓代替。
    for (const [font, characters] of unsupported) for (const character of characters) boundsByFont.get(font)?.delete(character);
    return result;
}

/**
 * 把一页的版面块登记为待翻译片段：表格里含词语的单元格作为独立片段翻译，数字、符号单元格与公式、图内文字保留原样；
 * 页眉页脚和作者信息在阅读与导出时都按原文显示，不占用翻译请求。片段追加到传入的列表末尾。
 */
export function pdfPageSegments(layoutBlocks: readonly PdfLayoutBlock[], pageNumber: number, segments: DocumentSegment[]): {blocks: PdfDocumentBlock[]; segmentIndexes: number[]} {
    const segmentIndexes: number[] = [];
    const blocks: PdfDocumentBlock[] = [];
    layoutBlocks.forEach((block, blockIndex) => {
        if (block.kind === 'formula' || (block.kind === 'table' && block.preserveSource) || block.kind === 'figure-label' || block.kind === 'footer' || block.kind === 'metadata') {
            blocks.push({...block, segmentIndex: -1});
            return;
        }
        const id = segments.length;
        segments.push({id, source: block.source, contextLabel: blockIndex === 0 ? `第 ${pageNumber} 页` : undefined, role: block.fontWeight === 700 ? 'heading' : 'paragraph'});
        segmentIndexes.push(id);
        blocks.push({...block, segmentIndex: id});
    });
    return {blocks, segmentIndexes};
}

export async function parsePdf(fileName: string, bytes: Uint8Array, signal?: AbortSignal, onProgress?: ParseDocumentFileOptions['onPdfProgress']): Promise<ParsedDocument> {
    if (new TextDecoder('latin1').decode(bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('PDF 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const segments: DocumentSegment[] = [];
    const pages: PdfDocumentPage[] = [];
    const {assetRoot: pdfAssetRoot, workerUrl} = getPdfResources();
    const pdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const {getDocument: getPdfDocument, GlobalWorkerOptions} = pdfJs;
    signal?.throwIfAborted();
    if (typeof window !== 'undefined') GlobalWorkerOptions.workerSrc = workerUrl;
    const binaryDataFactoryOptions: {BinaryDataFactory?: PdfBinaryDataFactoryConstructor} = pdfAssetRoot
        ? {BinaryDataFactory: createPdfBinaryDataFactory({preferLocalDataAssets: hasCustomPdfAssetRoot()})}
        : {};
    const loadingTask = getPdfDocument({
        data: new Uint8Array(bytes),
        disableFontFace: true,
        disableWorkerRendering: true,
        useWorkerFetch: false,
        ...(pdfAssetRoot ? {
            cMapPacked: true,
            cMapUrl: `${pdfAssetRoot}/cmaps/`,
            standardFontDataUrl: `${pdfAssetRoot}/standard_fonts/`,
            wasmUrl: `${pdfAssetRoot}/wasm/`,
        } : {}),
        ...binaryDataFactoryOptions,
    } as Parameters<typeof getPdfDocument>[0]);

    let destruction: Promise<void> | undefined;
    const destroy = () => destruction ??= loadingTask.destroy();
    const cancel = () => { void destroy().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        const pdf = await awaitDocumentRead(loadingTask.promise, signal);
        signal?.throwIfAborted();
        onProgress?.({completed: 0, total: pdf.numPages});
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            signal?.throwIfAborted();
            const page = await awaitDocumentRead(pdf.getPage(pageNumber), signal, latePage => {latePage.cleanup();});
            try {
                signal?.throwIfAborted();
                const displayViewport = page.getViewport({scale: 1});
                // /Rotate 是页面展示元数据，不能让原本横排的正文被竖排过滤器误删。
                const textContent = await awaitDocumentRead(page.getTextContent(), signal);
                signal?.throwIfAborted();
                const items = textContent.items.filter((item): item is PdfTextItem => 'str' in item);
                const operators = typeof page.getOperatorList === 'function' ? await awaitDocumentRead(page.getOperatorList(), signal) : undefined;
                const styles = operators ? pdfMathGlyphStyles(items, textContent.styles as Record<string, PdfTextStyle>, operators, pdfJs.OPS, page.commonObjs) : textContent.styles as Record<string, PdfTextStyle>;
                const {viewport, atoms, ...orientation} = pdfPageTextGeometry(
                    items,
                    styles,
                    displayViewport,
                    displayViewport.rotation ? page.getViewport({scale: 1, rotation: 0}) : displayViewport,
                );
                const graphics = operators ? extractPdfGraphicsShapes(operators, pdfJs.OPS, viewport) : [];
                signal?.throwIfAborted();
                const {blocks: layoutBlocks, preservedRegions} = analyzePdfPageLayout({atoms, graphics, width: viewport.width, height: viewport.height});
                const {blocks, segmentIndexes} = pdfPageSegments(layoutBlocks, pageNumber, segments);
                pages.push({
                    pageNumber,
                    width: displayViewport.width,
                    height: displayViewport.height,
                    ...orientation,
                    segmentIndexes,
                    blocks,
                    preservedRegions,
                    layoutBoundaries: graphics.filter(shape => shape.kind === 'path' &&
                        (shape.width >= 12 && shape.height <= 5 || shape.height >= 12 && shape.width <= 5)),
                    // 至少半页的图像并集，且没有原生正文（容许独立页码及图像外少量边缘文字）；空白页与正文配图不算扫描页。
                    ...(isScannedPdfPage(atoms, layoutBlocks, graphics, viewport.width, viewport.height) ? {scanned: true} : {}),
                });
                onProgress?.({completed: pageNumber, total: pdf.numPages});
            } finally {
                page.cleanup();
            }
            // 为导入进度、取消按钮和输入事件留出绘制机会，不连续占满主线程。
            if (pageNumber % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`PDF 解析失败：${String(error)}`);
    } finally {
        signal?.removeEventListener('abort', cancel);
        await destroy();
    }

    // 没有文字层的扫描件照常打开：原页可以阅读，文字识别由页面在开始翻译时按页进行（见 services/pdfOcr）。

    return {
        fileName,
        format: 'pdf',
        label: getDocumentFormatLabel('pdf'),
        parts: [],
        segments,
        binary: {kind: 'pdf', bytes, pages},
    };
}
