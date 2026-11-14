/**
 * @file src/features/image-translation/services/imageMatteBoundary.ts
 * 文件职责：沿同色背景的四邻外边界验证封闭归属，避免为取得背景包络遍历整块纸面。
 * 主要内容：已知背景点向右接到有向格边，始终核对边内背景与边外非背景；对角歧义优先沿当前四连通分支转向。
 * 只接受回到同一有向边且面积方向为外轮廓的闭环，触图边、内孔轮廓、失配或超过32768步均撤回；最多借用128KiB边界索引。
 * 模块边界：颜色查询及其预付像素预算由调用方提供，本模块不读取或修改RGBA、不生成擦除权限、不证明包络内所有像素属于同一区域。
 * 第二个文字端点仍须另证与此边界存在真实背景路径；取消和读取错误原样传播，失败不会发布部分边界。
 */
import type { OcrLine } from '@/src/shared/image/types';
export const IMAGE_MATTE_BOUNDARY_STEPS = 32768;
export interface ImageMatteBoundary {
    box: OcrLine['bbox'];
    /** 有界自有数组视图；只含已核对边界内侧的背景像素，允许转角重复。 */
    points: Uint32Array;
}
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
// For each directed grid edge: inner pixel x/y, then outer pixel x/y.
const cells = [[0, 0, 0, -1], [-1, 0, 0, 0], [-1, -1, -1, 0], [0, -1, -1, -1]] as const;
export function traceImageMatteBoundary(width: number, height: number, seedX: number, seedY: number, isBackground: (x: number, y: number) => boolean, checkActive: () => void = () => { }): ImageMatteBoundary | undefined {
    checkActive();
    if (![width, height, seedX, seedY].every(Number.isSafeInteger) || width < 3 || height < 3 || width > 8192 || height > 8192
        || width * height > 16777216 || seedX < 1 || seedY < 1 || seedX >= width - 1 || seedY >= height - 1)
        return;
    if (!isBackground(seedX, seedY))
        return;
    let right = seedX;
    while (right < width - 1 && isBackground(right + 1, seedY))
        right++;
    if (right === width - 1)
        return;
    const limit = Math.min(IMAGE_MATTE_BOUNDARY_STEPS, width * height * 4);
    const startX = right + 1, startY = seedY, points = new Uint32Array(limit);
    let x = startX, y = startY, direction = 1, signedArea = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    const matches = (vx: number, vy: number, d: number) => {
        const c = cells[d], ix = vx + c[0], iy = vy + c[1], ox = vx + c[2], oy = vy + c[3];
        return ix >= 0 && iy >= 0 && ix < width && iy < height && ox >= 0 && oy >= 0 && ox < width && oy < height
            && isBackground(ix, iy) && !isBackground(ox, oy);
    };
    for (let count = 0; count < limit; count++) {
        if ((count & 255) === 0)
            checkActive();
        if (!matches(x, y, direction))
            return;
        const [cx, cy] = cells[direction], ix = x + cx, iy = y + cy;
        if (ix === 0 || iy === 0 || ix === width - 1 || iy === height - 1)
            return;
        points[count] = iy * width + ix;
        x0 = Math.min(x0, ix);
        y0 = Math.min(y0, iy);
        x1 = Math.max(x1, ix + 1);
        y1 = Math.max(y1, iy + 1);
        const [dx, dy] = directions[direction], nx = x + dx, ny = y + dy;
        signedArea += x * ny - nx * y;
        let next = -1;
        for (const turn of [1, 0, 3]) {
            const candidate = (direction + turn) % 4;
            if (matches(nx, ny, candidate)) {
                next = candidate;
                break;
            }
        }
        if (next < 0)
            return;
        x = nx;
        y = ny;
        direction = next;
        if (x === startX && y === startY && direction === 1) {
            checkActive();
            if (signedArea <= 0)
                return;
            return { box: { x0, y0, x1, y1 }, points: points.subarray(0, count + 1) };
        }
    }
    return;
}
