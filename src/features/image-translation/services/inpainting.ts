/**
 * @file src/features/image-translation/services/inpainting.ts
 * 文件职责：依据有效 OCR 文本框在像素缓冲区中修复原文字，保留修复区域以外的图像内容。
 * 主要内容：按源行框及有界边缘修补，保留行间图案；仅为相接区域的局部范围分配去重蒙版和分层队列，按预乘透明度扩散；默认保留输入，也可显式复用调用方独占的像素缓冲，减少整图复制。
 * 模块边界：本模块是无 DOM、无网络的轻量像素算法，不进行 OCR 或译文绘制，也不宣称能够重建复杂纹理；输入和输出保持原图尺寸，无法取得已知边界时保留原像素。
 */
import type { OcrLine } from '@/src/shared/image/types';
import type {ImageTextRegion} from '../paragraphs';

interface MaskRectangle {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

function union(a: MaskRectangle, b: MaskRectangle): MaskRectangle {
    return {left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)};
}

function clusters(rectangles: MaskRectangle[]): MaskRectangle[][] {
    const groups: Array<{bounds: MaskRectangle; members: MaskRectangle[]}> = [];
    for (const rect of rectangles) {
        let bounds = rect;
        const members = [rect];
        // 相接区域共享扩散层；中间有已知像素的独立区域可分别处理。
        for (let i = 0; i < groups.length;) {
            const group = groups[i], b = group.bounds;
            if (bounds.left > b.right || bounds.right < b.left || bounds.top > b.bottom || bounds.bottom < b.top) {
                i++;
                continue;
            }
            bounds = union(bounds, b);
            members.push(...group.members);
            groups.splice(i, 1);
            i = 0;
        }
        groups.push({bounds, members});
    }
    return groups.map(group => group.members);
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

/** 使用八邻域边界扩散修复文字区域；默认不修改输入，inPlace 仅适用于调用方独占的缓冲。 */
export function inpaintTextRegions(
    source: Uint8ClampedArray,
    width: number,
    height: number,
    lines: ImageTextRegion[],
    inPlace = false,
): Uint8ClampedArray {
    const result = inPlace ? source : new Uint8ClampedArray(source);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || source.length < width * height * 4 || lines.length === 0) return result;

    const rectangles = lines.flatMap(line => (line.sourceBoxes ?? [line.bbox])
        .map(bbox => getMaskRectangle({text: line.text, bbox}, width, height)))
        .filter((rectangle): rectangle is MaskRectangle => rectangle !== undefined);
    if (rectangles.length === 0) return result;

    for (const group of clusters(rectangles)) repairCluster(result, width, height, group);
    return result;
}

function repairCluster(result: Uint8ClampedArray, imageWidth: number, imageHeight: number, rectangles: MaskRectangle[]): void {
    const bounds = rectangles.reduce(union);
    // 一像素已知边界保留原八邻域；触图边时不引入不存在的外围像素。
    const left = Math.max(0, bounds.left - 1), top = Math.max(0, bounds.top - 1);
    const width = Math.min(imageWidth, bounds.right + 1) - left;
    const height = Math.min(imageHeight, bounds.bottom + 1) - top;

    // 0 = 已知背景，1 = 待修复，2 = 已进入队列但本层尚未完成。
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
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
                    const neighbour = ny * width + nx;
                    if (mask[neighbour] !== 0) continue;
                    const offset = ((ny + top) * imageWidth + nx + left) * 4;
                    const weight = nx === x || ny === y ? 2 : 1;
                    const alphaWeight = result[offset + 3] * weight;
                    red += result[offset] * alphaWeight;
                    green += result[offset + 1] * alphaWeight;
                    blue += result[offset + 2] * alphaWeight;
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
}
