/**
 * @file src/features/image-translation/services/imageClippedGlyphs.ts
 * 文件职责：复核纯色不透明底上的单行字形是否被识别框裁去字高。
 * 主要内容：在闭环墨迹中复核八邻域连通字形，要求数量、公共字高和同帧支持吻合。单侧裁切允许分离字形横向投影重叠；双侧裁切用九成覆盖的核心区分抗锯齿相接的字形，同时复核完整墨迹的中央区域及逐字占比。
 * 模块边界：只读取已验证的局部墨迹和本次检测，不生成像素蒙版，不推断相连装饰的语义，不运行模型。调用方仍须校验图案碰撞和全页独占写入。
 */
import type {ImageMatteRepair} from './imageMatteRepair';

/** 字形必须逐个分离，并与原框和本次检测的裁切位置吻合。 */
export function coversClippedImageGlyphs(
    repair: ImageMatteRepair, sourceText: string, supportAt: (x: number, y: number) => boolean,
    budget: {remaining: number} = {remaining: 262_144},
): boolean {
    if (repair.background[3] !== 255 || !/^[A-Z0-9]+(?: +[A-Z0-9]+)*$/u.test(sourceText)) return false;
    const characters = sourceText.replaceAll(' ', '').length;
    if (characters < 4 || characters > 48) return false;

    const {width, left, top, mask, sourceBox, supportBox: ink} = repair;
    const x0 = Math.floor(sourceBox.x0), x1 = Math.ceil(sourceBox.x1);
    const y0 = Math.floor(sourceBox.y0), y1 = Math.ceil(sourceBox.y1);
    const above = y0 - ink.y0, below = ink.y1 - y1;
    const clippedTop = above > 0;
    const inkHeight = ink.y1 - ink.y0;
    const bothEdges = clippedTop && below > 0;
    const glyphMask = bothEdges ? repair.inkCore : mask;
    const horizontalLimit = bothEdges ? 6 : 3;
    if (!glyphMask || Math.max(above, below) <= 0 || inkHeight < 8
        || Math.max(above, below) > (bothEdges ? Math.min(4, inkHeight / 5) : Math.min(6, inkHeight / 3))
        || ink.x0 < x0 - horizontalLimit || ink.x1 > x1 + horizontalLimit) return false;
    if ((budget.remaining -= mask.length * (bothEdges ? 2 : 1)) < 0) return false;

    if (bothEdges) {
        if ((y1 - y0 - 3) * 2 < inkHeight) return false;
        const innerLeft = ink.x0 < x0 ? x0 + 5 : x0;
        const innerRight = ink.x1 > x1 ? x1 - 5 : x1;
        if (innerRight <= innerLeft) return false;
        // 只借两端实际被裁的窄边。上下裁切相邻的 SDK 留白行可以缺失，中央每个原墨像素仍须有检测支持。
        for (let y = y0 + 1; y < y1 - 2; y++) for (let x = innerLeft; x < innerRight; x++) {
            const index = (y - top) * width + x - left;
            if (mask[index] && supportAt(x,y) !== true) return false;
        }
    }

    // 闭环准入已排除接触观察区外缘的墨迹，八邻域不会跨越行尾或相邻图案。
    const neighbors = [-width - 1, -width, 1 - width, -1, 1, width - 1, width, width + 1];
    const visited = new Uint8Array(mask.length);
    const queue = new Uint32Array(mask.length);
    let glyphs = 0, clippedGlyphs = 0;
    for (let start = 0; start < glyphMask.length; start++) {
        if (!glyphMask[start] || visited[start]) continue;
        if (++glyphs > characters) return false;

        queue[0] = start;
        visited[start] = 1;
        let length = 1;
        let firstX = ink.x1, lastX = ink.x0;
        let firstY = ink.y1, lastY = ink.y0, supported = 0, inside = 0, missedAtCut = false;
        let needsLeftEdge = false, needsRightEdge = false;
        for (let cursor = 0; cursor < length; cursor++) {
            const index = queue[cursor];
            const x = left + index % width, y = top + Math.floor(index / width);
            firstX = Math.min(firstX, x);
            lastX = Math.max(lastX, x);
            firstY = Math.min(firstY, y);
            lastY = Math.max(lastY, y);
            if (bothEdges) {
                if (x >= x0 && x < x1 && y >= y0 && y < y1) {
                    inside++;
                    if (supportAt(x, y) === true) supported++;
                }
            } else if (supportAt(x, y) === true) {
                supported++;
            } else if (clippedTop ? y <= y0 : y >= y1 - 1) {
                missedAtCut = true;
            } else if (x === x0 + 4) {
                needsLeftEdge = true;
            } else if (x === x1 - 5) {
                needsRightEdge = true;
            } else if (x > x0 + 4 && x < x1 - 5) {
                return false;
            }
            for (const offset of neighbors) {
                const next = index + offset;
                if (glyphMask[next] && !visited[next]) {
                    visited[next] = 1;
                    queue[length++] = next;
                }
            }
        }
        if ((lastX - firstX + 1) * 2 > inkHeight * (bothEdges ? 4 : 3)
            || firstY > ink.y0 + 1 || lastY < ink.y1 - 2) return false;
        if (bothEdges) {
            // 几何上至少过半核心在原框内，框内证明至少覆盖五分之四；每个字自己的两端都确实被裁到。
            if (inside * 2 <= length || supported * 5 < inside * 4 || firstY >= y0 || lastY < y1) return false;
        } else if (supported * 2 <= length || (needsLeftEdge && firstX >= x0) || (needsRightEdge && lastX < x1)) {
            return false;
        }
        if (missedAtCut) clippedGlyphs++;
    }
    return glyphs === characters && (bothEdges || clippedGlyphs * 2 >= characters);
}
