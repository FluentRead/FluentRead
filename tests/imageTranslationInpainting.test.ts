import {describe, expect, it} from 'vitest';
import {inpaintTextRegions} from '@/src/features/image-translation/services/inpainting';

function solidPixels(width: number, height: number, color = [180, 200, 220, 255]): Uint8ClampedArray {
    const result = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < result.length; index += 4) result.set(color, index);
    return result;
}

function line(x0: number, y0: number, x1: number, y1: number) {
    return {text: '文字', bbox: {x0, y0, x1, y1}};
}

describe('图片文字背景修复', () => {
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
