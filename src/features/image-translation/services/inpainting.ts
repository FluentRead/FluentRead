/**
 * @file src/features/image-translation/services/inpainting.ts
 * 文件职责：依据有效 OCR 文本框在像素缓冲区中修复原文字，保留修复区域以外的图像内容。
 * 主要内容：按源行框及有界边缘修补，非透明保护路径先感知不透明按钮/输入框锐利边沿、一像素细边框与相邻图标缝隙，将扩边夹紧在控件内部，避免切坏胶囊边角或下拉箭头；提供与实际蒙版一致的碰撞判断和最小脏矩形归并，保留行间图案；相接簇用链表连接成员后一次展开，避免重复复制和参数展开；已确认低 alpha 行段既不可写也不可作为扩散背景，隔离无种子的原字岛时显式拒绝；纯色边界省去队列，紧凑控件在成对内边纯色且外边触及边框跳变时直接平滑填满内底色，消除彩色按钮缺口与白底按钮灰晕；独立不透明矩形在完整边界符合平滑渐变时重建渐变，避免扩散造成条纹；共享渐变规划只在完整外周匹配且内部不含透明像素时冻结颜色，失败不写入，供漫画按原清字框复用；默认保留输入，也可显式复用调用方独占的像素缓冲。
 * 模块边界：本模块是无 DOM、无网络的轻量像素算法，不进行 OCR 或译文绘制，也不宣称能够重建复杂纹理；输入和输出保持原图尺寸，无保护参数时保持原有无边界行为；保护路径失败由调用方在发布前撤回。
 * 细线背景：在原纯色与渐变规则之后，按单次修补共享的预付面积预算验证细线背景；只在完整不透明蒙版内采用源线条与横截面计划，保留已确认背景，少量跨度外像素仍走原扩散；透明保护路径保持原样。
 * 旋转短标签：独立物理字框可先验证书脊的逐列底色和真实墨迹，原清字蒙版与保护规则继续生效。
 * 斜向背景：独立窄横排框中的不透明背景经原图四边确认方向后沿斜边修补，整图共享独立工作预算。
 * 普通扩散：窄横排框外沿的突变色只在相邻三层底色一致、且突变未向框内连续延伸时用作替换采样候选。仅改变扩散读取的颜色，不写外沿，避免被识别框切到的描边在框内扩散成色带。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {ImageTextRegion} from '../paragraphs';
import {ImageAlphaProtectionUnavailableError,type MangaAlphaProtection} from './mangaAlphaProtection';
import {IMAGE_RULED_REPAIR_LIMITS,planImageRuledTextRepair} from './ruledTextRepair';
import {planImageFlatTextRepair} from './flatTextRepair';
import {IMAGE_DIRECTIONAL_REPAIR_BUDGET,repairDirectionalImageBackground} from './directionalTextRepair';

interface MaskRectangle {
    left: number;
    top: number;
    right: number;
    bottom: number;
    rotatedSource?: OcrLine['bbox'];
}

interface BoundarySampleBudget {
    readonly rectangles: MaskRectangle[];
    pixels: number;
    comparisons: number;
}

interface BoundarySampleRows {
    top?: Uint8ClampedArray;
    bottom?: Uint8ClampedArray;
}

function rgbDistance(pixels: Uint8ClampedArray, a: number, b: number): number {
    return Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1])
        + Math.abs(pixels[a + 2] - pixels[b + 2]);
}

/** 外沿单点颜色不足以作证。只在同一侧有多处薄突变，且外侧颜色能互证时冻结采样行。 */
function sampleBoundaryRow(pixels: Uint8ClampedArray, start: number, width: number, step: number): Uint8ClampedArray | undefined {
    let samples: Uint8ClampedArray | undefined;
    let count = 0;
    for (let x = 0; x < width; x++) {
        const first = start + x * 4;
        const a = first + step, b = a + step, c = b + step;
        if (rgbDistance(pixels, a, b) > 36 || rgbDistance(pixels, b, c) > 36 || rgbDistance(pixels, a, c) > 36
            || rgbDistance(pixels, first, a) < 108 || rgbDistance(pixels, first, b) < 108 || rgbDistance(pixels, first, c) < 108
            || (rgbDistance(pixels, first, first - step) < 72 && rgbDistance(pixels, first, first - step * 2) < 72)) continue;
        // 两侧角点照读原图，便于扩散循环沿用局部横坐标。
        samples ??= pixels.slice(start - 4, start + (width + 1) * 4);
        for (let channel = 0; channel < 3; channel++) {
            const p = pixels[a + channel], q = pixels[b + channel], r = pixels[c + channel];
            samples[(x + 1) * 4 + channel] = p + q + r - Math.min(p, q, r) - Math.max(p, q, r);
        }
        count++;
    }
    return count >= 4 ? samples : undefined;
}

function planBoundarySampleRows(pixels: Uint8ClampedArray, imageWidth: number, imageHeight: number, box: MaskRectangle,
    budget: BoundarySampleBudget): BoundarySampleRows | undefined {
    const width = box.right - box.left, height = box.bottom - box.top;
    if (width < 16 || width > 512 || height < 8 || height > 64 || width < height || width * height > 16_384) return;
    const left = box.left - 4, top = box.top - 4, right = box.right + 4, bottom = box.bottom + 4;
    const area = (right - left) * (bottom - top);
    if (left < 0 || top < 0 || right > imageWidth || bottom > imageHeight || area > budget.pixels) return;
    // 原位修补允许其他框已改变；所有外侧取样必须避开任何其他待擦除框。
    for (const other of budget.rectangles) {
        if (--budget.comparisons < 0) return;
        if (other !== box && other.left < right && other.right > left && other.top < bottom && other.bottom > top) return;
    }
    budget.pixels -= area;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        if (pixels[(y * imageWidth + x) * 4 + 3] !== 255) return;
    }
    const step = imageWidth * 4;
    const upper = sampleBoundaryRow(pixels, ((box.top - 1) * imageWidth + box.left) * 4, width, -step);
    const lower = sampleBoundaryRow(pixels, (box.bottom * imageWidth + box.left) * 4, width, step);
    return upper || lower ? {top: upper, bottom: lower} : undefined;
}

function union(a: MaskRectangle, b: MaskRectangle): MaskRectangle {
    return {left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)};
}

function clusters(rectangles: MaskRectangle[]): MaskRectangle[][] {
    type Member = {rectangle: MaskRectangle; next?: Member};
    const groups: Array<{bounds: MaskRectangle; head: Member; tail: Member}> = [];
    for (const rect of rectangles) {
        let bounds = rect;
        const head: Member = {rectangle: rect};
        let tail = head;
        // 相接区域共享扩散层；中间有已知像素的独立区域可分别处理。
        for (let i = 0; i < groups.length;) {
            const group = groups[i], b = group.bounds;
            if (bounds.left > b.right || bounds.right < b.left || bounds.top > b.bottom || bounds.bottom < b.top) {
                i++;
                continue;
            }
            bounds = union(bounds, b);
            // 保留原成员顺序，只接已有链；密集行不再反复复制整个已合并簇。
            tail.next = group.head;
            tail = group.tail;
            groups.splice(i, 1);
            i = 0;
        }
        groups.push({bounds, head, tail});
    }
    return groups.map(group => {
        const members: MaskRectangle[] = [];
        for (let member: Member | undefined = group.head; member; member = member.next) members.push(member.rectangle);
        return members;
    });
}

function getMaskRectangle(line: OcrLine, width: number, height: number): MaskRectangle | undefined {
    const { x0, y0, x1, y1 } = line.bbox;
    if (![x0, y0, x1, y1].every(Number.isFinite)
        || x1 <= x0 || y1 <= y0 || x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) return;

    // 扩张仅用于清除字形的抗锯齿边缘，避免大字号把邻近图案和其他行一并抹掉。
    const padding = Math.max(2, Math.min(4, Math.round((y1 - y0) * 0.1)));
    return {
        left: Math.max(0, Math.floor(x0 - padding)),
        top: Math.max(0, Math.floor(y0 - padding)),
        right: Math.min(width, Math.ceil(x1 + padding)),
        bottom: Math.min(height, Math.ceil(y1 + padding)),
    };
}

function pixelL1(pixels: Uint8ClampedArray, offset: number, r: number, g: number, b: number): number {
    return Math.abs(pixels[offset] - r) + Math.abs(pixels[offset + 1] - g) + Math.abs(pixels[offset + 2] - b);
}

/** 采样原始 OCR 框内周不透明主底色；任意透明点或缺乏共识时返回 undefined。 */
function sampleInteriorBackground(pixels: Uint8ClampedArray, imageWidth: number,
    left: number, top: number, right: number, bottom: number): [number, number, number] | undefined {
    const buckets = new Map<number, [number, number, number, number]>();
    let total = 0;
    const add = (x: number, y: number): boolean => {
        const p = (y * imageWidth + x) * 4;
        if (pixels[p + 3] !== 255) return false;
        const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
        const key = ((r & 0xf0) << 4) | (g & 0xf0) | (b >>> 4);
        let group = buckets.get(key);
        if (!group) { group = [0, 0, 0, 0]; buckets.set(key, group); }
        group[0] += r; group[1] += g; group[2] += b; group[3]++; total++;
        return true;
    };
    for (let x = left; x < right; x++) {
        if (!add(x, top) || !add(x, bottom - 1)) return;
    }
    for (let y = top + 1; y < bottom - 1; y++) {
        if (!add(left, y) || !add(right - 1, y)) return;
    }
    let best: [number, number, number, number] = [0, 0, 0, 0];
    for (const group of buckets.values()) if (group[3] > best[3]) best = group;
    if (best[3] < total * 0.45) return;
    return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
}

/** 外扩前逐边检查不透明控件边框与独立图标缝隙，防止掩码切过按钮边沿或下拉箭头。 */
function clampMaskRectangleToInterior(pixels: Uint8ClampedArray, imageWidth: number, imageHeight: number,
    bbox: OcrLine['bbox'], expanded: MaskRectangle): MaskRectangle {
    const baseLeft = Math.max(0, Math.min(imageWidth, Math.floor(bbox.x0)));
    const baseTop = Math.max(0, Math.min(imageHeight, Math.floor(bbox.y0)));
    const baseRight = Math.max(baseLeft, Math.min(imageWidth, Math.ceil(bbox.x1)));
    const baseBottom = Math.max(baseTop, Math.min(imageHeight, Math.ceil(bbox.y1)));
    if (baseRight - baseLeft < 6 || baseBottom - baseTop < 6) return expanded;
    const bg = sampleInteriorBackground(pixels, imageWidth, baseLeft, baseTop, baseRight, baseBottom);
    if (!bg) return expanded;
    const [bgR, bgG, bgB] = bg;
    const isDiff = (x: number, y: number): boolean => {
        if (x < 0 || x >= imageWidth || y < 0 || y >= imageHeight) return false;
        const p = (y * imageWidth + x) * 4;
        return pixels[p + 3] === 255 && pixelL1(pixels, p, bgR, bgG, bgB) >= 45;
    };
    const rowDiffs = (y: number): number => {
        let count = 0;
        for (let x = baseLeft; x < baseRight; x++) if (isDiff(x, y)) count++;
        return count;
    };
    const colDiffs = (x: number): number => {
        let count = 0;
        for (let y = baseTop; y < baseBottom; y++) if (isDiff(x, y)) count++;
        return count;
    };
    const spanW = baseRight - baseLeft, spanH = baseBottom - baseTop;
    let top = baseTop;
    for (let y = baseTop - 1; y >= expanded.top; y--) {
        if (rowDiffs(y) >= spanW * 0.6 && ((y > 0 && rowDiffs(y - 1) >= spanW * 0.6)
            || isDiff(baseLeft - 2, y) || isDiff(baseRight + 1, y))) break;
        top = y;
    }
    let bottom = baseBottom;
    for (let y = baseBottom; y < expanded.bottom; y++) {
        if (rowDiffs(y) >= spanW * 0.6 && ((y + 1 < imageHeight && rowDiffs(y + 1) >= spanW * 0.6)
            || isDiff(baseLeft - 2, y) || isDiff(baseRight + 1, y))) break;
        bottom = y + 1;
    }
    let left = baseLeft, sawCleanLeft = false;
    for (let x = baseLeft - 1; x >= expanded.left; x--) {
        const diffs = colDiffs(x);
        if (diffs >= spanH * 0.6 && ((x > 0 && colDiffs(x - 1) >= spanH * 0.6)
            || isDiff(x, baseTop - 2) || isDiff(x, baseBottom + 1))) break;
        if (sawCleanLeft && diffs >= 1) break;
        if (diffs === 0) sawCleanLeft = true;
        left = x;
    }
    let right = baseRight, sawCleanRight = false;
    for (let x = baseRight; x < expanded.right; x++) {
        const diffs = colDiffs(x);
        if (diffs >= spanH * 0.6 && ((x + 1 < imageWidth && colDiffs(x + 1) >= spanH * 0.6)
            || isDiff(x, baseTop - 2) || isDiff(x, baseBottom + 1))) break;
        if (sawCleanRight && diffs >= 1) break;
        if (diffs === 0) sawCleanRight = true;
        right = x + 1;
    }
    return { ...expanded, left, top, right, bottom };
}

/** 紧凑按钮或输入框的蒙版贴边时，用成对均匀内侧边确认控件底色，防止外部底色或边框渗入形成缺口与灰晕。 */
function planCompactInteriorFill(pixels: Uint8ClampedArray, imageWidth: number,
    bounds: MaskRectangle): [number, number, number] | undefined {
    const w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
    if (w < 8 || w > 512 || h < 8 || h > 96 || w * h > 32_768) return;
    for (let x = bounds.left - 1; x <= bounds.right; x++) {
        if (pixels[((bounds.top - 1) * imageWidth + x) * 4 + 3] !== 255
            || pixels[(bounds.bottom * imageWidth + x) * 4 + 3] !== 255) return;
    }
    for (let y = bounds.top; y < bounds.bottom; y++) {
        if (pixels[(y * imageWidth + bounds.left - 1) * 4 + 3] !== 255
            || pixels[(y * imageWidth + bounds.right) * 4 + 3] !== 255) return;
    }
    const uniformPair = (horizontal: boolean): [number, number, number] | undefined => {
        const firstOffset = horizontal
            ? (bounds.top * imageWidth + bounds.left - 1) * 4
            : ((bounds.top - 1) * imageWidth + bounds.left) * 4;
        const r0 = pixels[firstOffset], g0 = pixels[firstOffset + 1], b0 = pixels[firstOffset + 2];
        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        const check = (x: number, y: number): boolean => {
            const p = (y * imageWidth + x) * 4;
            if (pixelL1(pixels, p, r0, g0, b0) > 6) return false;
            sumR += pixels[p]; sumG += pixels[p + 1]; sumB += pixels[p + 2]; count++;
            return true;
        };
        if (horizontal) {
            for (let y = bounds.top; y < bounds.bottom; y++) {
                if (!check(bounds.left - 1, y) || !check(bounds.right, y)) return;
            }
        } else {
            for (let x = bounds.left; x < bounds.right; x++) {
                if (!check(x, bounds.top - 1) || !check(x, bounds.bottom)) return;
            }
        }
        return [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)];
    };
    const lr = uniformPair(true);
    if (lr) {
        const [r, g, b] = lr;
        let topInner = 0, bottomInner = 0, outerJumps = 0;
        for (let x = bounds.left; x < bounds.right; x++) {
            if (pixelL1(pixels, (bounds.top * imageWidth + x) * 4, r, g, b) <= 12) topInner++;
            if (pixelL1(pixels, ((bounds.bottom - 1) * imageWidth + x) * 4, r, g, b) <= 12) bottomInner++;
            if (pixelL1(pixels, ((bounds.top - 1) * imageWidth + x) * 4, r, g, b) >= 45
                || pixelL1(pixels, (bounds.bottom * imageWidth + x) * 4, r, g, b) >= 45) outerJumps++;
        }
        if (outerJumps >= w * 0.5 && topInner >= w * 0.5 && bottomInner >= w * 0.5) return lr;
    }
    const tb = uniformPair(false);
    if (tb) {
        const [r, g, b] = tb;
        let leftInner = 0, rightInner = 0, outerJumps = 0;
        for (let y = bounds.top; y < bounds.bottom; y++) {
            if (pixelL1(pixels, (y * imageWidth + bounds.left) * 4, r, g, b) <= 12) leftInner++;
            if (pixelL1(pixels, (y * imageWidth + bounds.right - 1) * 4, r, g, b) <= 12) rightInner++;
            if (pixelL1(pixels, (y * imageWidth + bounds.left - 1) * 4, r, g, b) >= 45
                || pixelL1(pixels, (y * imageWidth + bounds.right) * 4, r, g, b) >= 45) outerJumps++;
        }
        if (outerJumps >= h * 0.5 && leftInner >= h * 0.5 && rightInner >= h * 0.5) return tb;
    }
}

function applyMaskClamp(rectangle: MaskRectangle, clamp: OcrLine['bbox'] | undefined): MaskRectangle | undefined {
    if (!clamp) return rectangle;
    const left = Math.max(rectangle.left, Math.floor(clamp.x0));
    const top = Math.max(rectangle.top, Math.floor(clamp.y0));
    const right = Math.min(rectangle.right, Math.ceil(clamp.x1));
    const bottom = Math.min(rectangle.bottom, Math.ceil(clamp.y1));
    if (right <= left || bottom <= top) return;
    return { ...rectangle, left, top, right, bottom };
}

/** 仅导出普通图原有修补几何，供低 alpha 保护使用；不套用漫画字号描边余量。 */
export function imageMaskBoxes(line: ImageTextRegion, width: number, height: number): OcrLine['bbox'][] {
    return (line.sourceBoxes ?? [line.bbox]).flatMap(bbox => {
        const rectangle = getMaskRectangle({text: line.text, bbox}, width, height);
        return rectangle ? [{x0:rectangle.left,y0:rectangle.top,x1:rectangle.right,y1:rectangle.bottom}] : [];
    });
}

/** 归并待修补区域的最小脏矩形集合，供 Canvas 局部 putImageData 上传使用。 */
export function getInpaintDirtyRects(
    lines: readonly ImageTextRegion[],
    width: number,
    height: number,
    clamps?: ReadonlyMap<ImageTextRegion, OcrLine['bbox']>,
): OcrLine['bbox'][] {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || lines.length === 0) return [];
    const rectangles = lines.flatMap(line => {
        const clamp = clamps?.get(line);
        return (line.sourceBoxes ?? [line.bbox]).map(bbox => {
            const rectangle = getMaskRectangle({text: line.text, bbox}, width, height);
            return rectangle ? applyMaskClamp(rectangle, clamp) : undefined;
        });
    }).filter((rectangle): rectangle is MaskRectangle => rectangle !== undefined);
    return clusters(rectangles).map(group => {
        const bounds = group.reduce(union);
        return {x0: bounds.left, y0: bounds.top, x1: bounds.right, y1: bounds.bottom};
    });
}

/** 使用与实际修补相同的逐行扩边判断是否会碰到需要保留的原文。 */
export function imageMaskBoxIntersects(box: OcrLine['bbox'], width: number, height: number, target: OcrLine['bbox']): boolean {
    const rectangle = getMaskRectangle({text: '', bbox: box}, width, height);
    return !!rectangle && rectangle.left < target.x1 && target.x0 < rectangle.right
        && rectangle.top < target.y1 && target.y0 < rectangle.bottom;
}

/** 使用八邻域边界扩散修复文字区域；默认不修改输入，inPlace 仅适用于调用方独占的缓冲。 */
export function inpaintTextRegions(
    source: Uint8ClampedArray,
    width: number,
    height: number,
    lines: ImageTextRegion[],
    inPlace = false,
    protection?: MangaAlphaProtection,
    clamps?: ReadonlyMap<ImageTextRegion, OcrLine['bbox']>,
): Uint8ClampedArray {
    const result = inPlace ? source : new Uint8ClampedArray(source);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || source.length < width * height * 4 || lines.length === 0) return result;

    const rectangles = lines.flatMap(line => {
        const sources=line.sourceBoxes??[line.bbox];
        const clamp=clamps?.get(line);
        return sources.map(bbox=>{
            const expanded=getMaskRectangle({text:line.text,bbox},width,height);
            if(!expanded)return;
            let rectangle=protection?expanded:clampMaskRectangleToInterior(result,width,height,bbox,expanded);
            const clamped=applyMaskClamp(rectangle,clamp);
            if(!clamped)return;
            rectangle=clamped;
            if(line.quarterTurn&&sources.length===1)rectangle.rotatedSource=bbox;
            return rectangle;
        });
    })
        .filter((rectangle): rectangle is MaskRectangle => rectangle !== undefined);
    if (rectangles.length === 0) return result;

    const ruleBudget={remaining:IMAGE_RULED_REPAIR_LIMITS.pagePixels};
    const directionBudget={remaining:IMAGE_DIRECTIONAL_REPAIR_BUDGET};
    const boundaryBudget: BoundarySampleBudget = {rectangles, pixels:262_144, comparisons:65_536};
    for (const group of clusters(rectangles)) repairCluster(result, width, height, group, protection,ruleBudget,directionBudget,boundaryBudget);
    return result;
}

function repairCluster(result: Uint8ClampedArray, imageWidth: number, imageHeight: number, rectangles: MaskRectangle[],
    protection: MangaAlphaProtection|undefined,ruleBudget:{remaining:number},directionBudget:{remaining:number},boundaryBudget:BoundarySampleBudget): void {
    const bounds = rectangles.reduce(union);
    if(!protection&&rectangles.length===1&&bounds.rotatedSource){
        const source=bounds.rotatedSource,mask={x0:bounds.left,y0:bounds.top,x1:bounds.right,y1:bounds.bottom};
        const repair=planImageFlatTextRepair(result,imageWidth,imageHeight,{mask,source,fontSize:source.x1-source.x0,rotatedLabel:true},ruleBudget);
        if(repair){repair(result);return;}
    }
    // 一像素已知边界保留原八邻域；触图边时不引入不存在的外围像素。
    const left = Math.max(0, bounds.left - 1), top = Math.max(0, bounds.top - 1);
    const width = Math.min(imageWidth, bounds.right + 1) - left;
    const height = Math.min(imageHeight, bounds.bottom + 1) - top;

    // 0 = 已知背景，1 = 待修复，2 = 已进入队列但本层尚未完成，3 = 不可写且不可采样的保护点。
    const mask = new Uint8Array(width * height);
    let maskedCount = 0;
    for (const rectangle of rectangles) {
        for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
            for (let x = rectangle.left; x < rectangle.right; x += 1) {
                const index = (y - top) * width + x - left;
                if (mask[index] === 0) {
                    mask[index] = 1;
                    maskedCount += 1;
                }
            }
        }
    }

    let dividesMask = false;
    if (protection) {
        const {runs,rowStarts} = protection;
        // 每行二分跳过左侧行段；仅访问局部蒙版及其一像素采样上下文相交的保护段。
        for (let y = top; y < top + height; y += 1) {
            let low = rowStarts[y], high = rowStarts[y + 1];
            const end = high;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (runs[middle * 3 + 2] <= left) low = middle + 1;
                else high = middle;
            }
            for (let run = low; run < end && runs[run * 3 + 1] < left + width; run += 1) {
                const start = Math.max(left,runs[run * 3 + 1]), stop = Math.min(left + width,runs[run * 3 + 2]);
                for (let x = start; x < stop; x += 1) {
                    const index = (y - top) * width + x - left;
                    if (mask[index] === 1) {maskedCount -= 1;dividesMask = true;}
                    mask[index] = 3;
                }
            }
        }
        if (maskedCount === 0) return;
    }

    // 仅接受完整的实际扩散边界；触图边或全透明边界继续原路，避免补造像素或改变隐藏 RGB 规范化。
    // 内部保护可能封死原字岛；此时先由队列证明可达，再使用已确认纯色，不能跨环填充。
    const uniform = bounds.left > 0 && bounds.top > 0 && bounds.right < imageWidth && bounds.bottom < imageHeight
        ? uniformKnownBoundary(result, imageWidth, mask, left, top, width, rectangles) : undefined;
    if (uniform !== undefined && !dividesMask) {
        // 只扫描去重后的局部蒙版一次；不扩张、不填行间孔洞，也不为纯色簇分配逐像素队列。
        for (let index = 0; index < mask.length; index += 1) {
            if (mask[index] !== 1) continue;
            const offset = ((Math.floor(index / width) + top) * imageWidth + index % width + left) * 4;
            for (let channel = 0; channel < 4; channel += 1) result[offset + channel] = uniform[channel];
        }
        return;
    }

    // 只使用真实四边，且逐像素验证；边缘被裁切、透明孔、相接多框和纹理继续原来的扩散路径。
    const hasFullBorder = rectangles.length === 1 && bounds.left > 0 && bounds.top > 0
        && bounds.right < imageWidth && bounds.bottom < imageHeight;
    if (!protection && hasFullBorder) {
        const repair = planImageGradientRepair(result, imageWidth, left, top, width, height);
        if (repair) {repair(result); return;}
    }

    let boundaryRows: BoundarySampleRows | undefined;
    if(!protection){
        const ruled=planImageRuledTextRepair(result,imageWidth,imageHeight,{left,top,width,height,mask},ruleBudget);
        if(ruled){
            for(let index=0;index<mask.length;index++){
                if(mask[index]!==1||!ruled.kind[index])continue;
                if(ruled.kind[index]===2){
                    const offset=((Math.floor(index/width)+top)*imageWidth+index%width+left)*4;
                    for(let channel=0;channel<3;channel++)result[offset+channel]=ruled.colors[index*3+channel];
                }
                mask[index]=0;maskedCount--;
            }
            if(maskedCount===0)return;
        } else if (hasFullBorder && !bounds.rotatedSource) {
            if (repairDirectionalImageBackground(result,imageWidth,left,top,width,height,directionBudget)) return;
            const compactFill = planCompactInteriorFill(result, imageWidth, bounds);
            if (compactFill) {
                for (let y = bounds.top; y < bounds.bottom; y++) {
                    for (let x = bounds.left; x < bounds.right; x++) {
                        const offset = (y * imageWidth + x) * 4;
                        result[offset] = compactFill[0];
                        result[offset + 1] = compactFill[1];
                        result[offset + 2] = compactFill[2];
                        result[offset + 3] = 255;
                    }
                }
                return;
            }
            boundaryRows = planBoundarySampleRows(result,imageWidth,imageHeight,bounds,boundaryBudget);
        }
    }

    const queue = new Uint32Array(maskedCount);
    let tail = 0;
    for (const rectangle of rectangles) {
        for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
            for (let x = rectangle.left; x < rectangle.right; x += 1) {
                const index = (y - top) * width + x - left;
                if (mask[index] !== 1) continue;
                let hasBoundary = false;
                for (let ny = Math.max(0, y - top - 1); ny <= Math.min(height - 1, y - top + 1) && !hasBoundary; ny += 1) {
                    for (let nx = Math.max(0, x - left - 1); nx <= Math.min(width - 1, x - left + 1); nx += 1) {
                        if (mask[ny * width + nx] === 0) {
                            hasBoundary = true;
                            break;
                        }
                    }
                }
                if (hasBoundary) {
                    mask[index] = 2;
                    queue[tail++] = index;
                }
            }
        }
    }

    if (uniform !== undefined) {
        // 透明纯色页只做连通性检查，不重复逐像素RGBA加权；未确认全部可达前不擦写。
        for (let head = 0; head < tail; head += 1) {
            const index = queue[head], x = index % width, y = Math.floor(index / width);
            for (let ny = Math.max(0,y-1); ny <= Math.min(height-1,y+1); ny += 1) {
                for (let nx = Math.max(0,x-1); nx <= Math.min(width-1,x+1); nx += 1) {
                    const neighbour = ny * width + nx;
                    if (mask[neighbour] !== 1) continue;
                    mask[neighbour] = 2;
                    queue[tail++] = neighbour;
                }
            }
        }
        if (tail !== maskedCount) throw new ImageAlphaProtectionUnavailableError('透明保护区隔离了无法修补的原文字，已保留原图');
        for (let position = 0; position < tail; position += 1) {
            const index = queue[position], offset = ((Math.floor(index / width)+top)*imageWidth+index%width+left)*4;
            for (let channel = 0; channel < 4; channel += 1) result[offset+channel] = uniform[channel];
        }
        return;
    }

    let head = 0;
    while (head < tail) {
        const layerEnd = tail;
        for (let position = head; position < layerEnd; position += 1) {
            const index = queue[position];
            const x = index % width;
            const y = Math.floor(index / width);
            let red = 0;
            let green = 0;
            let blue = 0;
            let alpha = 0;
            let weightTotal = 0;
            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
                const row = boundaryRows && (ny === 0 ? boundaryRows.top : ny === height - 1 ? boundaryRows.bottom : undefined);
                const colors = row ?? result;
                const rowOffset = ((ny + top) * imageWidth + left) * 4;
                const colorStart = row ? 0 : rowOffset;
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
                    const neighbour = ny * width + nx;
                    if (mask[neighbour] !== 0) continue;
                    const offset = rowOffset + nx * 4;
                    const weight = nx === x || ny === y ? 2 : 1;
                    const alphaWeight = result[offset + 3] * weight;
                    const colorOffset = colorStart + nx * 4;
                    red += colors[colorOffset] * alphaWeight;
                    green += colors[colorOffset + 1] * alphaWeight;
                    blue += colors[colorOffset + 2] * alphaWeight;
                    alpha += alphaWeight;
                    weightTotal += weight;
                }
            }
            const offset = ((y + top) * imageWidth + x + left) * 4;
            // 队列中的像素一定接壤上一层已知背景；透明边界也能清除原字形的不透明度。
            result[offset] = alpha ? Math.round(red / alpha) : 0;
            result[offset + 1] = alpha ? Math.round(green / alpha) : 0;
            result[offset + 2] = alpha ? Math.round(blue / alpha) : 0;
            result[offset + 3] = Math.round(alpha / weightTotal);
        }

        // 完成本层后才公开像素，防止从左到右的处理顺序造成颜色偏斜。
        for (let position = head; position < layerEnd; position += 1) mask[queue[position]] = 0;
        for (; head < layerEnd; head += 1) {
            const index = queue[head];
            const x = index % width;
            const y = Math.floor(index / width);
            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
                    const neighbour = ny * width + nx;
                    if (mask[neighbour] !== 1) continue;
                    mask[neighbour] = 2;
                    queue[tail++] = neighbour;
                }
            }
        }
    }
    if (protection && tail !== maskedCount) throw new ImageAlphaProtectionUnavailableError('透明保护区隔离了无法修补的原文字，已保留原图');
}

/** 完整外周验证双线性背景后冻结颜色；只返回内部蒙版的写入计划，验证失败不修改像素。 */
export function planImageGradientRepair(pixels: Uint8ClampedArray, imageWidth: number,
    left: number, top: number, width: number, height: number, requireGradient = false): ((target: Uint8ClampedArray) => void) | undefined {
    if (![imageWidth,left,top,width,height].every(Number.isSafeInteger) || imageWidth <= 0 || left < 0 || top < 0
        || width < 3 || height < 3 || left + width > imageWidth || top + height > pixels.length / (imageWidth * 4)) return;
    const offset = (x: number, y: number) => ((top + y) * imageWidth + left + x) * 4;
    const corners = [offset(0, 0), offset(width - 1, 0), offset(0, height - 1), offset(width - 1, height - 1)];
    if (corners.some(index => pixels[index + 3] !== 255)) return;
    const colors = corners.map(index => [pixels[index], pixels[index + 1], pixels[index + 2]]);
    // 漫画已判为复杂的区域不能只凭一圈同色边界重新降为纯色；这里只补充有实际变化的渐变。
    if (requireGradient && colors.every(color => color.every((value, channel) => value === colors[0][channel]))) return;
    const value = (x: number, y: number, channel: number) => {
        const u = x / (width - 1), v = y / (height - 1);
        return (colors[0][channel] * (1 - u) + colors[1][channel] * u) * (1 - v)
            + (colors[2][channel] * (1 - u) + colors[3][channel] * u) * v;
    };
    const matches = (x: number, y: number) => {
        const index = offset(x, y);
        if (pixels[index + 3] !== 255) return false;
        for (let channel = 0; channel < 3; channel++) {
            if (Math.abs(pixels[index + channel] - value(x, y, channel)) > 1) return false;
        }
        return true;
    };
    for (let x = 0; x < width; x++) if (!matches(x, 0) || !matches(x, height - 1)) return;
    for (let y = 1; y < height - 1; y++) if (!matches(0, y) || !matches(width - 1, y)) return;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        if (pixels[offset(x, y) + 3] !== 255) return;
    }
    const length = pixels.length;
    return target => {
        if (target.length !== length) throw new RangeError('背景修补缓冲尺寸不一致');
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
            const index = offset(x, y);
            for (let channel = 0; channel < 3; channel++) target[index + channel] = Math.round(value(x, y, channel));
            target[index + 3] = 255;
        }
    };
}

/** 并集的八邻域边界等于成员矩形一像素外周扣除并集；跳过重叠周、保留内孔，仅按周长检查相同 RGBA。 */
function uniformKnownBoundary(result: Uint8ClampedArray, imageWidth: number, mask: Uint8Array,
    left: number, top: number, width: number, rectangles: MaskRectangle[]): [number, number, number, number] | undefined {
    let color: [number, number, number, number] | undefined;
    const matches = (x: number, y: number) => {
        if (mask[(y - top) * width + x - left] !== 0) return true;
        const offset = (y * imageWidth + x) * 4;
        if (color === undefined) {
            if (result[offset + 3] === 0) return false;
            color = [result[offset], result[offset + 1], result[offset + 2], result[offset + 3]];
        } else {
            for (let channel = 0; channel < 4; channel += 1) {
                if (result[offset + channel] !== color[channel]) return false;
            }
        }
        return true;
    };
    for (const rectangle of rectangles) {
        for (let x = rectangle.left - 1; x <= rectangle.right; x += 1) {
            if (!matches(x, rectangle.top - 1) || !matches(x, rectangle.bottom)) return;
        }
        for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
            if (!matches(rectangle.left - 1, y) || !matches(rectangle.right, y)) return;
        }
    }
    return color;
}
