import {describe, expect, it} from 'vitest';
import {flattenOcrAlpha,getOcrAlphaBackground,getOcrAlphaProfile} from '@/src/features/image-translation/services/ocrPixels';

describe('OCR 独占像素的透明通道与文字对比', () => {
    it('无效RGBA长度安全返回空coverage，按半透明阈值统计真实洞像素',()=>{
        expect(getOcrAlphaProfile(new Uint8ClampedArray([1,2,3]))).toEqual({background:undefined,transparentPixels:0,totalPixels:0});
        const pixels=new Uint8ClampedArray([255,255,255,0,20,20,20,127,240,240,240,128,240,240,240,255]);
        expect(getOcrAlphaProfile(pixels)).toEqual({background:0,transparentPixels:2,totalPixels:4});
    });
    it('只读选择透明画布的对比底色，不改写可供旁证复用的原像素',()=>{
        const dark=new Uint8ClampedArray([20,30,40,255,0,0,0,0]);
        expect(getOcrAlphaBackground(dark)).toBe(255);expect(Array.from(dark)).toEqual([20,30,40,255,0,0,0,0]);
        const light=new Uint8ClampedArray([240,240,240,255,0,0,0,0]);
        expect(getOcrAlphaBackground(light)).toBe(0);expect(Array.from(light)).toEqual([240,240,240,255,0,0,0,0]);
        expect(getOcrAlphaBackground(new Uint8ClampedArray([20,30,40,255]))).toBeUndefined();
    });
    it('透明黑字合成白底，保留原始黑色文字', () => {
        const pixels = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    });

    it('透明白字合成黑底，避免白底使文字消失', () => {
        const pixels = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    });

    it.each([
        {name: '黑色抗锯齿', input: [0, 0, 0, 128, 0, 0, 0, 64, 30, 80, 120, 0], output: [127, 127, 127, 255, 191, 191, 191, 255, 255, 255, 255, 255]},
        {name: '白色抗锯齿', input: [255, 255, 255, 128, 255, 255, 255, 64, 30, 80, 120, 0], output: [128, 128, 128, 255, 64, 64, 64, 255, 0, 0, 0, 255]},
    ])('$name 的半透明边缘按 alpha 合成且保持明暗层次', ({input, output}) => {
        const pixels = new Uint8ClampedArray(input);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual(output);
    });

    it('低 alpha 的亮色噪声不会压过较不透明的暗色前景', () => {
        const pixels = new Uint8ClampedArray([255, 255, 255, 1, 0, 0, 0, 254, 0, 0, 0, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 1, 1, 1, 255, 255, 255, 255, 255]);
    });

    it('低 alpha 的暗色噪声不会压过较不透明的亮色前景', () => {
        const pixels = new Uint8ClampedArray([0, 0, 0, 1, 255, 255, 255, 254, 255, 255, 255, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([0, 0, 0, 255, 254, 254, 254, 255, 0, 0, 0, 255]);
    });

    it.each([
        {name: '红', color: [255, 0, 0], background: 255},
        {name: '绿', color: [0, 255, 0], background: 0},
        {name: '蓝', color: [0, 0, 255], background: 255},
    ])('$name 色文字依据感知亮度权重选择对比底色', ({color, background}) => {
        const pixels = new Uint8ClampedArray([...color, 255, 90, 130, 240, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([...color, 255, background, background, background, 255]);
    });

    it.each([
        {brightness: 127, background: 255},
        {brightness: 128, background: 0},
    ])('可见灰阶亮度 $brightness 在 128 阈值处选择正确底色', ({brightness, background}) => {
        const pixels = new Uint8ClampedArray([brightness, brightness, brightness, 255, 255, 255, 255, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([brightness, brightness, brightness, 255, background, background, background, 255]);
    });

    it('全透明 RGB 无论多亮都不参与前景亮度，没有前景时选择白底', () => {
        const pixels = new Uint8ClampedArray([255, 255, 255, 0, 255, 0, 128, 0, 0, 0, 0, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    });

    it('全透明隐藏白色不会改变可见暗色前景选择的白底', () => {
        const pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0, 255, 255, 255, 0]);
        expect(flattenOcrAlpha(pixels)).toBe(true);
        expect(Array.from(pixels)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    });

    it('不透明输入仅扫描 alpha，不读取 RGB 或写入任何像素', () => {
        const pixels = new Uint8ClampedArray([0, 15, 30, 255, 128, 255, 1, 255, 10, 20, 30, 255]);
        const readIndices: number[] = [];
        const guarded = new Proxy(pixels, {
            get(target, property) {
                if (typeof property === 'string' && /^\d+$/u.test(property)) {
                    const index = Number(property);
                    readIndices.push(index);
                    if (index % 4 !== 3) throw new Error('不透明输入不应读取 RGB');
                }
                return Reflect.get(target, property, target);
            },
            set() {throw new Error('不透明输入不应写入像素');},
        });
        expect(flattenOcrAlpha(guarded)).toBe(false);
        expect(readIndices).toEqual([3, 7, 11]);
        expect(Array.from(pixels)).toEqual([0, 15, 30, 255, 128, 255, 1, 255, 10, 20, 30, 255]);
    });

    it('空 RGBA 缓冲区无需写回', () => {
        const pixels = new Uint8ClampedArray(0);
        expect(flattenOcrAlpha(pixels)).toBe(false);
        expect(pixels).toHaveLength(0);
    });
});
