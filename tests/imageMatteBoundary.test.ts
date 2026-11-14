import { describe, expect, it, vi } from 'vitest';
import { traceImageMatteBoundary, IMAGE_MATTE_BOUNDARY_STEPS } from '@/src/features/image-translation/services/imageMatteBoundary';
function grid(width: number, height: number, inside: (x: number, y: number) => boolean) {
    const values = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            values[y * width + x] = Number(inside(x, y));
    const read = (x: number, y: number) => { if (x < 0 || y < 0 || x >= width || y >= height)
        throw new Error('Out-of-source read'); return values[y * width + x] === 1; };
    return { width, height, values, read };
}
function component(g: ReturnType<typeof grid>, seed: number) {
    const points = new Set([seed]), queue = [seed];
    for (let head = 0; head < queue.length; head++) {
        const p = queue[head], x = p % g.width, y = Math.floor(p / g.width);
        for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
            const next = yy * g.width + xx;
            if (xx >= 0 && yy >= 0 && xx < g.width && yy < g.height && g.read(xx, yy) && !points.has(next)) {
                points.add(next);
                queue.push(next);
            }
        }
    }
    const xs = [...points].map(p => p % g.width), ys = [...points].map(p => Math.floor(p / g.width));
    return { points, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 } };
}
describe('四连通背景外边界', () => {
    it('穷举全部4乘4二值图案，外边界与独立广度优先连通域一致', () => {
        let mismatch: unknown;
        for (let bits = 1; bits < 65536; bits++) {
            const g = grid(6, 6, (x, y) => x > 0 && x < 5 && y > 0 && y < 5 && !!(bits & (1 << ((y - 1) * 4 + x - 1))));
            const seed = g.values.findIndex(v => v === 1), expected = component(g, seed);
            const actual = traceImageMatteBoundary(6, 6, seed % 6, Math.floor(seed / 6), g.read);
            if (!actual || JSON.stringify(actual.box) !== JSON.stringify(expected.box) || [...actual.points].some(p => !expected.points.has(p))) {
                mismatch = { bits, actual, expected: expected.box };
                break;
            }
        }
        expect(mismatch).toBeUndefined();
    });
    it('对角接触的同色卡片不成为同一owner', () => {
        const g = grid(12, 12, (x, y) => x >= 2 && x < 5 && y >= 2 && y < 5 || x >= 5 && x < 9 && y >= 5 && y < 9);
        expect(traceImageMatteBoundary(12, 12, 2, 2, g.read)?.box).toEqual({ x0: 2, y0: 2, x1: 5, y1: 5 });
        expect(traceImageMatteBoundary(12, 12, 5, 5, g.read)?.box).toEqual({ x0: 5, y0: 5, x1: 9, y1: 9 });
    });
    it('向右先碰到内部孔洞时不把内轮廓当成外边界', () => {
        const g = grid(16, 16, (x, y) => x >= 2 && x < 14 && y >= 2 && y < 14 && !(x >= 7 && x < 10 && y >= 6 && y < 10));
        expect(traceImageMatteBoundary(16, 16, 3, 7, g.read)).toBeUndefined();
        expect(traceImageMatteBoundary(16, 16, 3, 3, g.read)?.box).toEqual({ x0: 2, y0: 2, x1: 14, y1: 14 });
    });
    it.each(['left', 'right', 'top', 'bottom'] as const)('背景接触%s图边时不制造封闭证明', edge => {
        const g = grid(16, 16, (x, y) => x >= (edge === 'left' ? 0 : 2) && x < (edge === 'right' ? 16 : 14) && y >= (edge === 'top' ? 0 : 2) && y < (edge === 'bottom' ? 16 : 14));
        expect(traceImageMatteBoundary(16, 16, 5, 5, g.read)).toBeUndefined();
    });
    it('形状虽有包络，封闭背景里的独立岛仍只是不同连通域', () => {
        const g = grid(20, 20, (x, y) => (x >= 2 && x < 18 && y >= 2 && y < 18 && !(x >= 6 && x < 14 && y >= 6 && y < 14)) || (x >= 9 && x < 11 && y >= 9 && y < 11));
        const outer = traceImageMatteBoundary(20, 20, 3, 3, g.read)!;
        expect(outer.box).toEqual({ x0: 2, y0: 2, x1: 18, y1: 18 });
        expect([...outer.points]).not.toContain(9 * 20 + 9);
        expect(traceImageMatteBoundary(20, 20, 9, 9, g.read)?.box).toEqual({ x0: 9, y0: 9, x1: 11, y1: 11 });
    });
    it('不合法输入在读取前退出，非背景seed也不追踪', () => {
        const read = vi.fn(() => true);
        for (const input of [[2, 20, 1, 1], [20, 2, 1, 1], [8193, 20, 1, 1], [20, 8193, 1, 1], [8192, 8192, 1, 1], [20, 20, 0, 1], [20, 20, 1, 0], [20, 20, 19, 1], [20, 20, 1, 19], [20, 20, NaN, 1], [20, 20, 1.5, 1]])
            expect(traceImageMatteBoundary(input[0], input[1], input[2], input[3], read)).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
        expect(traceImageMatteBoundary(20, 20, 2, 2, () => false)).toBeUndefined();
    });
    it('取消和读取异常原样传播，不发布部分边界', () => {
        const g = grid(300, 300, (x, y) => x >= 2 && x < 298 && y >= 2 && y < 298), error = new Error('cancelled');
        let checks = 0;
        expect(() => traceImageMatteBoundary(300, 300, 3, 3, g.read, () => { if (++checks === 3)
            throw error; })).toThrow(error);
        expect(checks).toBe(3);
        const readError = new Error('read failed');
        expect(() => traceImageMatteBoundary(20, 20, 2, 2, () => { throw readError; })).toThrow(readError);
    });
    it('seed确认后颜色变化或下一条边消失时不发布残缺证明', () => {
        let seedReads = 0;
        expect(traceImageMatteBoundary(8, 8, 2, 2, (x, y) => x === 2 && y === 2 && ++seedReads === 1)).toBeUndefined();
        let outsideReads = 0, changed = false;
        expect(traceImageMatteBoundary(8, 8, 2, 2, (x, y) => {
            if (x === 3 && y === 2 && ++outsideReads === 2)
                changed = true;
            return !changed && x === 2 && y === 2;
        })).toBeUndefined();
    });
    it('高曲折边界在固定步数内停止，不分配与整页面积相同的队列', () => {
        const g = grid(300, 300, (x, y) => x >= 2 && x < 298 && y >= 2 && y < 298 && (x < 4 || y % 2 === 0));
        let reads = 0;
        expect(traceImageMatteBoundary(g.width, g.height, 2, 2, (x, y) => { reads++; return g.read(x, y); })).toBeUndefined();
        expect(reads).toBeGreaterThan(IMAGE_MATTE_BOUNDARY_STEPS);
        expect(reads).toBeLessThan(IMAGE_MATTE_BOUNDARY_STEPS * 9 + g.width);
    });
});
