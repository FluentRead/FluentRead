/**
 * @file src/features/image-translation/services/imageClippedGlyphs.ts
 * 文件职责：复核纯色不透明底上的单行字形是否被识别框裁去上缘或下缘。
 * 主要内容：在闭环墨迹蒙版中逐个复核八邻域连通字形，允许互不连接的字形横向投影重叠。要求字形与识别字符数量、公共字高、同帧检测支持吻合，检测缺口仅可发生在同一裁切边或行两端的窄边缘。
 * 模块边界：只读取已验证的局部墨迹和本次检测，不生成像素蒙版，不推断相连装饰的语义，不运行模型。调用方仍须校验图案碰撞和全页独占写入。
 */
import type {ImageMatteRepair} from './imageMatteRepair';

/** 原框必须只裁到一侧的共同字高；字形分离后才能逐个复核。 */
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
    if (clippedTop === (below > 0) || Math.max(above, below) > Math.min(6, inkHeight / 3)
        || inkHeight < 8 || ink.x0 < x0 - 3 || ink.x1 > x1 + 3) return false;
    if ((budget.remaining -= mask.length) < 0) return false;

    // 闭环准入已排除接触观察区外缘的墨迹，八邻域不会跨越行尾或相邻图案。
    const neighbors = [-width - 1, -width, 1 - width, -1, 1, width - 1, width, width + 1];
    const visited = new Uint8Array(mask.length);
    const queue = new Uint32Array(mask.length);
    let glyphs = 0, clippedGlyphs = 0;
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || visited[start]) continue;
        if (++glyphs > characters) return false;

        queue[0] = start;
        visited[start] = 1;
        let length = 1;
        let firstX = ink.x1, lastX = ink.x0;
        let firstY = ink.y1, lastY = ink.y0, supported = 0, missedAtCut = false;
        let needsLeftEdge = false, needsRightEdge = false;
        for (let cursor = 0; cursor < length; cursor++) {
            const index = queue[cursor];
            const x = left + index % width, y = top + Math.floor(index / width);
            firstX = Math.min(firstX, x);
            lastX = Math.max(lastX, x);
            firstY = Math.min(firstY, y);
            lastY = Math.max(lastY, y);
            if (supportAt(x, y) === true) {
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
                if (mask[next] && !visited[next]) {
                    visited[next] = 1;
                    queue[length++] = next;
                }
            }
        }
        if ((lastX - firstX + 1) * 2 > inkHeight * 3 || firstY > ink.y0 + 1 || lastY < ink.y1 - 2
            || supported * 2 <= length || (needsLeftEdge && firstX >= x0) || (needsRightEdge && lastX < x1)) return false;
        if (missedAtCut) clippedGlyphs++;
    }
    return glyphs === characters && clippedGlyphs * 2 >= characters;
}
