/**
 * @file src/features/image-translation/services/mangaDetectionHorizontalSplit.ts
 * 文件职责：在 DBNet 检测框后处理阶段，结合概率谷值与同帧 RGBA 像素证据拆分被弱尾迹误合并的水平控件与分栏框。
 * 主要内容：对宽长水平原始框逐列计算检测概率峰谷，仅在两侧均有强检测峰且谷内具备竖向 UI 边框线、背景色阶跃或宽死谷证据时拆分；在竖向边框或背景阶跃拆分后，仅当右侧紧邻边框存在垂直居中、高度显著低于正文且与正文按比例宽距隔离的小型下拉箭头或图标时才裁去前导图标，并输出左右硬边界供留白阶段夹紧，防止回扩吞入边框或箭头。
 * 模块边界：纯几何与像素只读算法，不创建 Canvas、不调用模型、不改动输入概率或像素缓冲，不依赖站点特征或语言词表。
 */

export interface DetectionBBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface HorizontalSplitHardBounds {
    left?: number;
    right?: number;
}

export interface HorizontalSplitPart {
    bbox: DetectionBBox;
    hardBounds?: HorizontalSplitHardBounds;
}

export interface HorizontalSplitPixels {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
    scale?: number;
}

export interface HorizontalSplitContext {
    probabilities: Float32Array;
    mapWidth: number;
    mapHeight: number;
    pixels?: HorizontalSplitPixels;
}

interface ValleySplit {
    leftEnd: number;
    rightStart: number;
    tightStart: number;
    isUiBoundary: boolean;
    hardRight?: number;
    hardLeft?: number;
}

interface ChevronTrimResult {
    newRel: number;
    hardLeftRel: number;
}

type Rgb = readonly [number, number, number];

function medianChannel(values: number[]): number {
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
}

function rgbL1(a: Rgb, b: Rgb): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function pixelRgbL1(data: Uint8ClampedArray, offset: number, color: Rgb): number {
    return Math.abs(data[offset] - color[0]) + Math.abs(data[offset + 1] - color[1]) + Math.abs(data[offset + 2] - color[2]);
}

function clampInt(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

function hasPeak(colMax: Float32Array, start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
        if (colMax[i] >= 0.3) return true;
    }
    return false;
}

function columnMedianRgb(pixels: HorizontalSplitPixels, px: number, py0: number, py1: number): Rgb {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const {data, width} = pixels;
    for (let py = py0; py < py1; py++) {
        const offset = (py * width + px) * 4;
        rs.push(data[offset]);
        gs.push(data[offset + 1]);
        bs.push(data[offset + 2]);
    }
    return [medianChannel(rs), medianChannel(gs), medianChannel(bs)];
}

function regionBackgroundRgb(pixels: HorizontalSplitPixels, pxStart: number, pxEnd: number, py0: number, py1: number): Rgb {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const {data, width, height} = pixels;
    // 优先采样字框上下边缘与框外 1-2px 条带，避免侧翼列中的正文笔画淹没真实底色中位数。
    const rows = [py0 - 2, py0 - 1, py0, py1 - 1, py1, py1 + 1];
    for (const py of rows) {
        if (py < 0 || py >= height) continue;
        for (let px = pxStart; px < pxEnd; px++) {
            const offset = (py * width + px) * 4;
            rs.push(data[offset]);
            gs.push(data[offset + 1]);
            bs.push(data[offset + 2]);
        }
    }
    return [medianChannel(rs), medianChannel(gs), medianChannel(bs)];
}

function isVerticalBorderColumn(
    pixels: HorizontalSplitPixels,
    px: number,
    py0: number,
    py1: number,
    leftBg: Rgb,
    rightBg: Rgb,
): boolean {
    const ph = py1 - py0;
    const stroke = columnMedianRgb(pixels, px, py0, py1);
    if (rgbL1(stroke, leftBg) < 24 || rgbL1(stroke, rightBg) < 24) return false;
    const nearLeft = columnMedianRgb(pixels, Math.max(0, px - 2), py0, py1);
    const nearRight = columnMedianRgb(pixels, Math.min(pixels.width - 1, px + 2), py0, py1);
    if (Math.max(rgbL1(stroke, nearLeft), rgbL1(stroke, nearRight)) < 24) return false;
    const {data, width, height} = pixels;
    const matches = (py: number) => pixelRgbL1(data, (py * width + px) * 4, stroke) <= 24;
    let bestRun = 0;
    let bestStart = py0;
    let bestEnd = py0;
    let runStart = -1;
    for (let py = py0; py < py1; py++) {
        if (matches(py)) {
            if (runStart < 0) runStart = py;
            const len = py - runStart + 1;
            if (len > bestRun) {
                bestRun = len;
                bestStart = runStart;
                bestEnd = py + 1;
            }
        } else {
            runStart = -1;
        }
    }
    if (bestRun < Math.ceil(ph * 0.9)) return false;
    const extendsAbove = bestStart === py0 && py0 >= 2 && matches(py0 - 1) && matches(py0 - 2);
    const extendsBelow = bestEnd === py1 && py1 + 2 <= height && matches(py1) && matches(py1 + 1);
    return extendsAbove || extendsBelow;
}

function findUiBoundaryInValley(
    box: DetectionBBox,
    vStart: number,
    vEnd: number,
    pixels: HorizontalSplitPixels,
): ValleySplit | undefined {
    const offsetX = pixels.offsetX ?? 0;
    const offsetY = pixels.offsetY ?? 0;
    const scale = pixels.scale ?? 1;
    const py0 = clampInt(offsetY + Math.round(box.y0 * scale), 0, pixels.height - 1);
    const py1 = clampInt(offsetY + Math.round(box.y1 * scale), py0 + 1, pixels.height);
    if (py1 - py0 < 4) return;
    const pxLeft = clampInt(offsetX + Math.round((box.x0 + vStart) * scale), 0, pixels.width - 1);
    const pxRight = clampInt(offsetX + Math.round((box.x0 + vEnd - 1) * scale), pxLeft, pixels.width - 1);
    const leftFlankStart = Math.max(0, pxLeft - 4);
    const rightFlankEnd = Math.min(pixels.width, pxRight + 5);
    if (leftFlankStart >= pxLeft || pxRight + 1 >= rightFlankEnd) return;
    const leftBg = regionBackgroundRgb(pixels, leftFlankStart, pxLeft, py0, py1);
    const rightBg = regionBackgroundRgb(pixels, pxRight + 1, rightFlankEnd, py0, py1);

    let borderFirst = -1;
    let borderLast = -1;
    for (let px = pxLeft; px <= pxRight; px++) {
        if (isVerticalBorderColumn(pixels, px, py0, py1, leftBg, rightBg)) {
            if (borderFirst < 0) borderFirst = px;
            borderLast = px;
        }
    }
    if (borderFirst >= 0) {
        const hardRight = clampInt(Math.floor((borderFirst - offsetX) / scale) - box.x0, vStart, box.x1 - box.x0);
        const rightStart = clampInt(Math.ceil((borderLast + 1 - offsetX) / scale) - box.x0, vStart, box.x1 - box.x0 - 1);
        return {
            leftEnd: vStart,
            rightStart,
            tightStart: Math.max(rightStart, vEnd),
            isUiBoundary: true,
            hardRight,
            hardLeft: rightStart,
        };
    }

    if (rgbL1(leftBg, rightBg) < 24) return;
    const scanStart = Math.max(0, pxLeft - 1);
    const scanEnd = Math.min(pixels.width - 1, pxRight + 1);
    const colBgs: Rgb[] = [];
    for (let px = scanStart; px <= scanEnd; px++) {
        colBgs.push(columnMedianRgb(pixels, px, py0, py1));
    }
    let maxJump = 0;
    let bestIndex = 0;
    for (let i = 0; i + 1 < colBgs.length; i++) {
        const next = Math.min(colBgs.length - 1, i + 2);
        const jump = rgbL1(colBgs[i], colBgs[next]);
        if (jump > maxJump) {
            maxJump = jump;
            bestIndex = i;
        }
    }
    if (maxJump < 24) return;
    const stepPx = scanStart + bestIndex + 1;
    const stepRel = clampInt(Math.round((stepPx - offsetX) / scale) - box.x0, vStart, vEnd);
    return {
        leftEnd: vStart,
        rightStart: stepRel,
        tightStart: Math.max(stepRel, vEnd),
        isUiBoundary: true,
        hardRight: stepRel,
        hardLeft: stepRel,
    };
}

function findWideDeadValley(colMax: Float32Array, h: number, vStart: number, vEnd: number): ValleySplit | undefined {
    const minDeadWidth = Math.max(5, Math.round(h * 0.65));
    let bestLen = 0;
    let bestStart = vStart;
    let bestEnd = vStart;
    let runStart = -1;
    for (let dx = vStart; dx < vEnd; dx++) {
        if (colMax[dx] < 0.15) {
            if (runStart < 0) runStart = dx;
            const len = dx - runStart + 1;
            if (len > bestLen) {
                bestLen = len;
                bestStart = runStart;
                bestEnd = dx + 1;
            }
        } else {
            runStart = -1;
        }
    }
    if (bestLen < minDeadWidth) return;
    return {leftEnd: bestStart, rightStart: bestEnd, tightStart: bestEnd, isUiBoundary: false};
}

function trimLeadingChevron(
    box: DetectionBBox,
    relStart: number,
    colMax: Float32Array,
    pixels: HorizontalSplitPixels,
): ChevronTrimResult | undefined {
    const offsetX = pixels.offsetX ?? 0;
    const offsetY = pixels.offsetY ?? 0;
    const scale = pixels.scale ?? 1;
    const sx0 = box.x0 + relStart;
    const px0 = clampInt(offsetX + Math.round(sx0 * scale), 0, pixels.width - 1);
    const px1 = clampInt(offsetX + Math.round(box.x1 * scale), px0 + 1, pixels.width);
    const py0 = clampInt(offsetY + Math.round(box.y0 * scale), 0, pixels.height - 1);
    const py1 = clampInt(offsetY + Math.round(box.y1 * scale), py0 + 1, pixels.height);
    const pw = px1 - px0;
    const ph = py1 - py0;
    if (pw < 8 || ph < 4) return;

    const {data, width} = pixels;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let cx = 0; cx < pw; cx++) {
        for (const py of [py0, py1 - 1]) {
            const offset = (py * width + px0 + cx) * 4;
            rs.push(data[offset]);
            gs.push(data[offset + 1]);
            bs.push(data[offset + 2]);
        }
    }
    const bg: Rgb = [medianChannel(rs), medianChannel(gs), medianChannel(bs)];

    const colHasInk = new Uint8Array(pw);
    const colMinY = new Int32Array(pw);
    const colMaxY = new Int32Array(pw);
    for (let cx = 0; cx < pw; cx++) {
        let minY = ph;
        let maxY = -1;
        for (let cy = 0; cy < ph; cy++) {
            const offset = ((py0 + cy) * width + px0 + cx) * 4;
            if (pixelRgbL1(data, offset, bg) >= 36) {
                if (cy < minY) minY = cy;
                maxY = cy;
            }
        }
        if (maxY >= 0) {
            colHasInk[cx] = 1;
            colMinY[cx] = minY;
            colMaxY[cx] = maxY;
        }
    }

    let cx = 0;
    while (cx < pw && !colHasInk[cx]) cx++;
    const iconStart = cx;
    if (iconStart >= pw || iconStart > Math.max(8, Math.round(ph * 0.6))) return;

    let iconMinY = ph;
    let iconMaxY = -1;
    while (cx < pw && colHasInk[cx]) {
        if (colMinY[cx] < iconMinY) iconMinY = colMinY[cx];
        if (colMaxY[cx] > iconMaxY) iconMaxY = colMaxY[cx];
        cx++;
    }
    const iconEnd = cx;
    const iconWidth = iconEnd - iconStart;
    const iconHeight = iconMaxY - iconMinY + 1;
    if (iconWidth < 2 || iconWidth > Math.max(12, Math.round(ph * 0.85))) return;
    if (iconHeight > Math.round(ph * 0.55)) return;
    const iconCenter = (iconMinY + iconMaxY) / 2;
    const boxCenter = (ph - 1) / 2;
    if (Math.abs(iconCenter - boxCenter) > ph * 0.25) return;

    while (cx < pw && !colHasInk[cx]) cx++;
    const textStart = cx;
    const gap = textStart - iconEnd;
    if (textStart >= pw || gap < Math.max(4, Math.round(ph * 0.28))) return;

    let textMinY = ph;
    let textMaxY = -1;
    const innerGaps: number[] = [];
    let cursor = textStart;
    while (cursor < pw) {
        while (cursor < pw && colHasInk[cursor]) {
            if (colMinY[cursor] < textMinY) textMinY = colMinY[cursor];
            if (colMaxY[cursor] > textMaxY) textMaxY = colMaxY[cursor];
            cursor++;
        }
        const gapStart = cursor;
        while (cursor < pw && !colHasInk[cursor]) cursor++;
        if (cursor < pw) innerGaps.push(cursor - gapStart);
    }
    const textInkHeight = textMaxY - textMinY + 1;
    if (iconHeight > textInkHeight * 0.75) return;
    if (innerGaps.length > 0 && gap <= medianChannel(innerGaps) * 1.35) return;

    const newRel = Math.floor((px0 + textStart - offsetX) / scale) - box.x0;
    const w = box.x1 - box.x0;
    if (newRel <= relStart || newRel >= w - 1 || !hasPeak(colMax, newRel, w)) return;
    const hardLeftRel = Math.min(newRel, Math.ceil((px0 + iconEnd + 1 - offsetX) / scale) - box.x0);
    return {newRel, hardLeftRel};
}

function validPixels(pixels: HorizontalSplitPixels | undefined): HorizontalSplitPixels | undefined {
    if (!pixels || pixels.width <= 0 || pixels.height <= 0 || pixels.data.length !== pixels.width * pixels.height * 4) return;
    return pixels;
}

/** 拆分过宽水平检测框并返回每段对应的硬边界（边框或被裁前导图标右侧），防止留白阶段回扩吞回控件边界。 */
export function splitHorizontalDetectionBoxWithBounds(box: DetectionBBox, context: HorizontalSplitContext): HorizontalSplitPart[] {
    const {probabilities, mapWidth, mapHeight} = context;
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (
        mapWidth <= 0 || mapHeight <= 0 || probabilities.length !== mapWidth * mapHeight
        || box.x0 < 0 || box.y0 < 0 || box.x1 > mapWidth || box.y1 > mapHeight
        || h < 4 || w <= h * 1.5
    ) {
        return [{bbox: box}];
    }

    const colMax = new Float32Array(w);
    for (let dx = 0; dx < w; dx++) {
        let maxP = 0;
        const x = box.x0 + dx;
        for (let y = box.y0; y < box.y1; y++) {
            const p = probabilities[y * mapWidth + x];
            if (p > maxP) maxP = p;
        }
        colMax[dx] = maxP;
    }

    const pixels = validPixels(context.pixels);
    const parts: HorizontalSplitPart[] = [];
    let segStart = 0;
    let segHardLeft: number | undefined;
    let dx = 0;
    while (dx < w) {
        if (colMax[dx] >= 0.35) {
            dx++;
            continue;
        }
        const vStart = dx;
        while (dx < w && colMax[dx] < 0.35) dx++;
        const vEnd = dx;
        if (!hasPeak(colMax, segStart, vStart) || !hasPeak(colMax, vEnd, w)) continue;

        const split = (pixels ? findUiBoundaryInValley(box, vStart, vEnd, pixels) : undefined)
            ?? findWideDeadValley(colMax, h, vStart, vEnd);
        if (!split) continue;

        const leftEnd = Math.max(segStart + 1, split.leftEnd);
        const hardBounds: HorizontalSplitHardBounds = {};
        if (segHardLeft !== undefined) hardBounds.left = box.x0 + segHardLeft;
        if (split.hardRight !== undefined) hardBounds.right = box.x0 + split.hardRight;
        parts.push({
            bbox: {x0: box.x0 + segStart, y0: box.y0, x1: box.x0 + leftEnd, y1: box.y1},
            ...(hardBounds.left !== undefined || hardBounds.right !== undefined ? {hardBounds} : {}),
        });

        const trimmed = split.isUiBoundary && pixels
            ? trimLeadingChevron(box, split.rightStart, colMax, pixels)
            : undefined;
        segStart = trimmed ? trimmed.newRel : Math.min(w - 1, Math.max(leftEnd, split.tightStart));
        segHardLeft = trimmed ? trimmed.hardLeftRel : split.hardLeft;
        dx = Math.max(dx, segStart);
    }

    if (!parts.length) return [{bbox: box}];
    parts.push({
        bbox: {x0: box.x0 + segStart, y0: box.y0, x1: box.x1, y1: box.y1},
        ...(segHardLeft !== undefined ? {hardBounds: {left: box.x0 + segHardLeft}} : {}),
    });
    return parts;
}

/** 仅在有明确 UI 边框、背景阶跃或宽概率死谷支撑时拆分过宽的水平检测框。 */
export function splitHorizontalDetectionBox(box: DetectionBBox, context: HorizontalSplitContext): DetectionBBox[] {
    return splitHorizontalDetectionBoxWithBounds(box, context).map(part => part.bbox);
}
