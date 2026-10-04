/**
 * @file src/features/image-translation/services/inpainting.ts
 * 文件职责：依据有效 OCR 文本框在像素缓冲区中修复原文字，保留修复区域以外的图像内容。
 * 主要内容：整段译文仍仅按原始文字行框修补，保留行间及短行旁图案；约束文字边缘扩张、构造去重蒙版，并使用分层边界队列和预乘透明度插值完成局部背景扩散，每个蒙版像素只入队一次。
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

/** 使用八邻域边界扩散修复文字区域；复杂背景仍会产生模糊，原始像素不会被修改。 */
export function inpaintTextRegions(
    source: Uint8ClampedArray,
    width: number,
    height: number,
    lines: ImageTextRegion[],
): Uint8ClampedArray {
    const result = new Uint8ClampedArray(source);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0 || source.length < width * height * 4 || lines.length === 0) return result;

    const rectangles = lines.flatMap(line => (line.sourceBoxes ?? [line.bbox])
        .map(bbox => getMaskRectangle({text: line.text, bbox}, width, height)))
        .filter((rectangle): rectangle is MaskRectangle => rectangle !== undefined);
    if (rectangles.length === 0) return result;

    // 0 = 已知背景，1 = 待修复，2 = 已进入队列但本层尚未完成。
    const mask = new Uint8Array(width * height);
    let maskedCount = 0;
    for (const rectangle of rectangles) {
        for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
            for (let x = rectangle.left; x < rectangle.right; x += 1) {
                const index = y * width + x;
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
                const index = y * width + x;
                if (mask[index] !== 1) continue;
                let hasBoundary = false;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1) && !hasBoundary; ny += 1) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
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
                    const offset = neighbour * 4;
                    const weight = nx === x || ny === y ? 2 : 1;
                    const alphaWeight = result[offset + 3] * weight;
                    red += result[offset] * alphaWeight;
                    green += result[offset + 1] * alphaWeight;
                    blue += result[offset + 2] * alphaWeight;
                    alpha += alphaWeight;
                    weightTotal += weight;
                }
            }
            const offset = index * 4;
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
    return result;
}
