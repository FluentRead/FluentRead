/**
 * @file src/features/document-translation/core/pdfScanGraphics.ts
 * 文件职责：从有界扫描页缩略像素中提取图形连通区域和候选表格线，让扫描论文复用原有 PDF 图表与段落分析。
 * 主要内容：按页面背景亮度分离墨迹，八邻域遍历保留跨箭头连接的图示；忽略单字大小的连通块、整页外框和噪声，分批让出执行权并响应取消；候选网格还须由跨行跨列的真实文字单元格确认，避免把坐标网格直接当成表格；所有边界保留在输入像素坐标，交由应用适配器换算为页面坐标。
 * 模块边界：纯像素和几何算法，不创建 Canvas、不解码图片、不执行 OCR、不改写文字、不自行决定译文；输出交给既有 pdfLayoutAnalysis，缩略图的预算与生命周期由 PDF 预览层管理。
 */
import type {PdfGraphicsShape, PdfLayoutAtom} from './pdfLayoutAnalysis';

type Rectangle = Pick<PdfGraphicsShape, 'x' | 'y' | 'width' | 'height'>;
export interface PdfScanGraphic extends Rectangle {rules: PdfGraphicsShape[]}
export interface PdfScanPixels {width: number; height: number; data: Uint8ClampedArray}
export const PDF_SCAN_GRAPHICS_MAX_PIXELS = 1_800_000;
export const PDF_SCAN_GRAPHICS_MAX_EDGE = 1600;
const workPixels = 131072;

/** 连续深色横/竖带的边界也是表线；深色表头可有厚填充，不把它当成一根很粗的线。 */
function gridRules(gray: Uint8Array, imageWidth: number, box: Rectangle, dark: number, pointsPerPixel: number): PdfGraphicsShape[] {
    const bands = (horizontal: boolean) => {
        const count = horizontal ? box.height : box.width, span = horizontal ? box.width : box.height;
        const result: number[] = [];
        let first = -1;
        for (let at = 0; at <= count; at++) {
            let ink = 0;
            if (at < count) for (let position = 0; position < span; position++) {
                const x = box.x + (horizontal ? position : at), y = box.y + (horizontal ? at : position);
                if (gray[y * imageWidth + x] < dark) ink++;
            }
            if (ink >= span * .85) {if (first < 0) first = at;}
            else if (first >= 0) {
                if ((at - first) * pointsPerPixel <= 2) result.push((first + at - 1) / 2);
                else result.push(first, at - 1);
                first = -1;
            }
        }
        return result;
    };
    const horizontal = bands(true), vertical = bands(false);
    if (horizontal.length < 3 || vertical.length < 2) return [];
    return [...horizontal.map(y => ({kind: 'path' as const, x: box.x, y: box.y + y, width: box.width, height: 0})),
        ...vertical.map(x => ({kind: 'path' as const, x: box.x + x, y: box.y, width: 0, height: box.height}))];
}

/** 让出点由调用方接入现有事件循环；取消时不返回部分图形清单。 */
export function* detectPdfScanGraphics(image: PdfScanPixels, pointsPerPixel: number, signal?: AbortSignal): Generator<void, PdfScanGraphic[]> {
    signal?.throwIfAborted();
    const {width, height, data} = image, size = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || size > PDF_SCAN_GRAPHICS_MAX_PIXELS
        || data.length !== size * 4 || !Number.isFinite(pointsPerPixel) || pointsPerPixel <= 0) throw new Error('扫描页版面预览尺寸无效');
    const gray = new Uint8Array(size), histogram = new Uint32Array(256);
    for (let at = 0; at < size; at++) {
        const pixel = at * 4;
        const value = Math.round(255 + (Math.min(data[pixel], data[pixel + 1], data[pixel + 2]) - 255) * data[pixel + 3] / 255);
        gray[at] = value; histogram[value]++;
        if (at % workPixels === 0) {yield; signal?.throwIfAborted();}
    }
    let background = 0, seen = 0;
    while (background < 255 && seen + histogram[background] < size * .9) seen += histogram[background++];
    const cutoff = Math.max(0, background - 16), mask = new Uint8Array(size);
    for (let at = 0; at < size; at++) mask[at] = gray[at] < cutoff ? 1 : 0;
    const queue = new Uint32Array(size), graphics: PdfScanGraphic[] = [];
    for (let start = 0; start < size; start++) {
        if (start % workPixels === 0) {yield; signal?.throwIfAborted();}
        if (!mask[start]) continue;
        let head = 0, tail = 1;
        queue[0] = start; mask[start] = 0;
        let left = start % width, right = left, top = Math.floor(start / width), bottom = top;
        while (head < tail) {
            const at = queue[head++], x = at % width, y = Math.floor(at / width);
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
            for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
                for (let column = Math.max(0, x - 1); column <= Math.min(width - 1, x + 1); column++) {
                    const next = row * width + column;
                    if (mask[next]) {mask[next] = 0; queue[tail++] = next;}
                }
            }
            if (head % workPixels === 0) {yield; signal?.throwIfAborted();}
        }
        const box = {x: left, y: top, width: right - left + 1, height: bottom - top + 1};
        if (box.width * pointsPerPixel < 24 || box.height * pointsPerPixel < 24
            || box.width * box.height * pointsPerPixel ** 2 < 900 || box.width * box.height >= size * .94) continue;
        graphics.push({...box, rules: gridRules(gray, width, box, Math.min(cutoff, 128), pointsPerPixel)});
    }
    signal?.throwIfAborted();
    return graphics;
}

/** 有文字单元格证据的网格提供原始线段；其它连通区域沿用插图判断，不把坐标网格当成表格。 */
export function pdfScanLayoutGraphics(graphics: readonly PdfScanGraphic[], atoms: readonly PdfLayoutAtom[]): PdfGraphicsShape[] {
    return graphics.flatMap(({rules, ...box}) => {
        const horizontal = rules.filter(rule => rule.width > 0).map(rule => rule.y).sort((a, b) => a - b);
        const vertical = rules.filter(rule => rule.height > 0).map(rule => rule.x).sort((a, b) => a - b);
        const cells = new Set<string>(), labels = new Set<string>(), rows = new Set<number>(), columns = new Set<number>();
        if (horizontal.length >= 3 && vertical.length >= 2) for (const atom of atoms) {
            if (!/[\p{L}\p{N}]/u.test(atom.text)) continue;
            const x = atom.x + atom.width / 2, y = atom.y + atom.height / 2;
            const column = vertical.findIndex((edge, index) => index + 1 < vertical.length && x > edge && x < vertical[index + 1]);
            const row = horizontal.findIndex((edge, index) => index + 1 < horizontal.length && y > edge && y < horizontal[index + 1]);
            if (row >= 0 && column >= 0 && atom.x >= vertical[column] - 1 && atom.x + atom.width <= vertical[column + 1] + 1) {
                cells.add(`${row}:${column}`); rows.add(row); columns.add(column);
                if (/\p{L}/u.test(atom.text)) labels.add(`${row}:${column}`);
            }
        }
        return cells.size >= 4 && labels.size >= 2 && rows.size >= 2 && columns.size >= 2 ? rules : [{...box, kind: 'image' as const}];
    });
}
