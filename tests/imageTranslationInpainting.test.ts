import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {inpaintTextRegions} from '@/src/features/image-translation/services/inpainting';

function solidPixels(width: number, height: number, color = [180, 200, 220, 255]): Uint8ClampedArray {
    const result = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < result.length; index += 4) result.set(color, index);
    return result;
}

function line(x0: number, y0: number, x1: number, y1: number) {
    return {text: '文字', bbox: {x0, y0, x1, y1}};
}

afterEach(() => vi.unstubAllGlobals());

describe('图片文字背景修复', () => {
    it.each([
        ['分离和触图边', [[-2, -2, 8, 8], [60, 60, 72, 72], [30, 20, 40, 30]], '8eb6e03e85b61098bc3f80a55d308193350aa391e407bc441f34e1dbd4f8d034'],
        ['后来桥接', [[10, 10, 20, 20], [35, 10, 45, 20], [19, 10, 36, 20]], '70a03e5e598e7c03179856fbb641d13899201714c0a6e3fa12ce566e6a8ea7e5'],
        ['八邻域角相接', [[10, 10, 20, 20], [24, 24, 34, 34]], 'bdf0a4d17a937c881cc31a33483de88098b07443971d6ea16d603ccecf850545'],
    ] as const)('%s 的半透明渐变逐字节保留基线修补结果', (_name, coordinates, expected) => {
        const source = new Uint8ClampedArray(80 * 80 * 4);
        for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
            source.set([x * 3, y * 3, (x + y) * 2, (x + y) % 4 === 0 ? 0 : 128], (y * 80 + x) * 4);
        }
        const boxes = coordinates.map(([x0, y0, x1, y1]) => line(x0, y0, x1, y1));
        // 摘要来自性能修改前 55cb1513 的整图蒙版算法，防止局部坐标或簇边界改变颜色/透明度。
        const result = inpaintTextRegions(source, 80, 80, boxes);
        expect(createHash('sha256').update(result).digest('hex')).toBe(expected);
        expect(inpaintTextRegions(source.slice(), 80, 80, boxes, true)).toEqual(result);
    });

    it('可显式复用独占像素，默认仍保留输入；无框时也不复制独占缓冲', () => {
        const source = solidPixels(30, 20);
        source.set([0, 0, 0, 255], (8 * 30 + 12) * 4);
        const boxes = [line(5, 5, 15, 12)];
        const expected = inpaintTextRegions(source, 30, 20, boxes);
        const owned = source.slice();
        expect(inpaintTextRegions(owned, 30, 20, boxes, true)).toBe(owned);
        expect(owned).toEqual(expected);
        expect(source[(8 * 30 + 12) * 4]).toBe(0);
        expect(inpaintTextRegions(owned, 30, 20, [], true)).toBe(owned);
    });

    it('大图稀疏文字只分配局部蒙版，不分配整图蒙版或额外 RGBA 副本', () => {
        const source = solidPixels(1024, 1024);
        const boxes = [line(20, 20, 40, 30), line(900, 900, 920, 910)];
        source.set([0, 0, 0, 255], (25 * 1024 + 30) * 4);
        source.set([0, 0, 0, 255], (905 * 1024 + 910) * 4);
        const masks: number[] = [];
        const Mask = Uint8Array, Pixels = Uint8ClampedArray;
        vi.stubGlobal('Uint8Array', class extends Mask {
            constructor(size: number) {super(size); masks.push(size);}
        });
        const copies = vi.fn();
        vi.stubGlobal('Uint8ClampedArray', class extends Pixels {
            constructor(input: Uint8ClampedArray) {super(input); copies();}
        });
        const output = inpaintTextRegions(source, 1024, 1024, boxes, true);
        expect(output).toBe(source);
        expect(masks).toEqual([26 * 16, 26 * 16]);
        expect(copies).not.toHaveBeenCalled();
        expect(Array.from(output.slice((25 * 1024 + 30) * 4, (25 * 1024 + 30) * 4 + 4))).toEqual([180, 200, 220, 255]);
        expect(Array.from(output.slice((905 * 1024 + 910) * 4, (905 * 1024 + 910) * 4 + 4))).toEqual([180, 200, 220, 255]);
    });

    it('后来的文字桥接两个相邻修复区域，跨簇去重且不改变像素结果', () => {
        const source = solidPixels(60, 60);
        const boxes = [line(8, 8, 16, 16), line(32, 8, 40, 16), line(15, 8, 33, 16), line(8, 32, 16, 40)];
        for (const {bbox} of boxes) source.set([0, 0, 0, 255], (bbox.y0 * 60 + bbox.x0) * 4);
        expect(inpaintTextRegions(source, 60, 60, boxes)).toEqual(solidPixels(60, 60));
        expect(inpaintTextRegions(source, 60, 60, boxes.slice().reverse())).toEqual(solidPixels(60, 60));
    });
    it('小字两像素边缘清理覆盖 OCR 未含的链接下划线，不把绿色向背景扩散', () => {
        const source = solidPixels(60, 25, [255, 255, 255, 255]);
        for (let x = 10; x < 40; x++) source.set([0, 180, 70, 255], (16 * 60 + x) * 4);
        source.set([0, 180, 70, 255], (8 * 60 + 20) * 4);
        expect(inpaintTextRegions(source, 60, 25, [line(10, 6, 40, 15)])).toEqual(solidPixels(60, 25, [255, 255, 255, 255]));
    });
    it('整段排版只擦除源行框，行间图案与短末行旁的像素保持原样', () => {
        const source = solidPixels(60, 40);
        const boxes = [line(5, 5, 45, 13).bbox, line(5, 25, 25, 33).bbox];
        source.set([0, 0, 0, 255], (9 * 60 + 10) * 4);
        source.set([0, 0, 0, 255], (29 * 60 + 10) * 4);
        source.set([255, 0, 0, 255], (19 * 60 + 30) * 4);
        source.set([0, 255, 0, 255], (29 * 60 + 40) * 4);
        const result = inpaintTextRegions(source, 60, 40, [{...line(5, 5, 45, 33), sourceBoxes: boxes}]);
        const pixel = (x: number, y: number) => Array.from(result.slice((y * 60 + x) * 4, (y * 60 + x) * 4 + 4));
        expect(pixel(10, 9)).toEqual([180, 200, 220, 255]);
        expect(pixel(10, 29)).toEqual([180, 200, 220, 255]);
        expect(pixel(30, 19)).toEqual([255, 0, 0, 255]);
        expect(pixel(40, 29)).toEqual([0, 255, 0, 255]);
    });
    it('忽略不安全尺寸、无效边界和图片以外的识别框，始终保持独立输出', () => {
        const source = solidPixels(4, 4);
        for (const [width, height] of [[NaN, 4], [4, Infinity], [1.5, 4], [0, 4], [4, 0], [-1, 4], [10, 10]]) {
            const output = inpaintTextRegions(source, width, height, [line(0, 0, 1, 1)]);
            expect(output).toEqual(source);
            expect(output).not.toBe(source);
        }
        const invalid = [line(NaN, 0, 1, 1), line(2, 0, 1, 1), line(0, 2, 1, 1),
            line(-3, 0, -1, 1), line(0, -3, 1, -1), line(4, 0, 5, 1), line(0, 4, 1, 5)];
        expect(inpaintTextRegions(source, 4, 4, invalid)).toEqual(source);
        expect(inpaintTextRegions(source, 4, 4, [])).toEqual(source);
    });

    it('填满超过旧算法 96 层上限的大字区域，保留蒙版外像素和输入缓冲', () => {
        const width = 400;
        const height = 400;
        const source = solidPixels(width, height);
        for (let y = 75; y < 325; y += 1) {
            for (let x = 75; x < 325; x += 1) source.set([0, 0, 0, 255], (y * width + x) * 4);
        }
        const output = inpaintTextRegions(source, width, height, [line(75, 75, 325, 325)]);
        expect(Array.from(output.slice((200 * width + 200) * 4, (200 * width + 200) * 4 + 4)))
            .toEqual([180, 200, 220, 255]);
        const expected = solidPixels(width, height);
        expect(output.every((value, index) => value === expected[index])).toBe(true);
        expect(source[(200 * width + 200) * 4]).toBe(0);
    });

    it('重叠框只修复一次，输入顺序不影响修复结果', () => {
        const source = solidPixels(30, 20);
        const first = line(5, 5, 15, 12);
        const second = line(10, 6, 25, 13);
        source.set([0, 0, 0, 255], (8 * 30 + 12) * 4);
        const output = inpaintTextRegions(source, 30, 20, [first, second, first]);
        expect(output).toEqual(solidPixels(30, 20));
        expect(output).toEqual(inpaintTextRegions(source, 30, 20, [second, first]));
    });

    it('透明背景移除原文字的不透明度，预乘插值不会引入透明像素的杂色', () => {
        const transparent = solidPixels(12, 12, [255, 0, 0, 0]);
        transparent.set([0, 0, 0, 255], (6 * 12 + 6) * 4);
        const output = inpaintTextRegions(transparent, 12, 12, [line(4, 4, 8, 8)]);
        expect(Array.from(output.slice((6 * 12 + 6) * 4, (6 * 12 + 6) * 4 + 4))).toEqual([0, 0, 0, 0]);
        expect(Array.from(output.slice(0, 4))).toEqual([255, 0, 0, 0]);

        const translucent = solidPixels(12, 12, [0, 120, 240, 128]);
        translucent.set([0, 0, 0, 255], (6 * 12 + 6) * 4);
        const repaired = inpaintTextRegions(translucent, 12, 12, [line(4, 4, 8, 8)]);
        expect(Array.from(repaired.slice((6 * 12 + 6) * 4, (6 * 12 + 6) * 4 + 4))).toEqual([0, 120, 240, 128]);
    });

    it('图像边缘框仍能扩散，但完全没有已知边界时保留原图', () => {
        const source = solidPixels(12, 12);
        source.set([0, 0, 0, 255], 0);
        expect(inpaintTextRegions(source, 12, 12, [line(-1, -1, 3, 3)])).toEqual(solidPixels(12, 12));
        expect(inpaintTextRegions(source, 12, 12, [line(-1, -1, 13, 13)])).toEqual(source);
    });

    it('对称渐变保持对称，单层的左右处理顺序不会污染相邻像素', () => {
        const source = solidPixels(21, 21);
        for (let y = 0; y < 21; y += 1) {
            for (let x = 0; x < 21; x += 1) source.set([Math.abs(x - 10) * 20, y * 10, 100, 255], (y * 21 + x) * 4);
        }
        const output = inpaintTextRegions(source, 21, 21, [line(7, 7, 14, 14)]);
        for (let y = 6; y < 15; y += 1) {
            for (let x = 6; x < 15; x += 1) expect(output[(y * 21 + x) * 4]).toBe(output[(y * 21 + 20 - x) * 4]);
        }
    });
});
