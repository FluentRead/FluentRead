/**
 * @file tests/imageRuledTextRepair.test.ts
 * 文件职责：验证普通图片修补在有细线的纸面上保留背景，避免按颜色误留浅色文字。
 * 主要内容：用原始设计独立重建的无字参考评估实际照片裁图，并保留同色横线/文字反例。
 * 模块边界：参考只参与结果评价，不传入生产修补函数；不运行OCR模型或在线翻译。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { imageMaskBoxes, inpaintTextRegions } from '@/src/features/image-translation/services/inpainting';
import { IMAGE_RULED_REPAIR_LIMITS, planImageRuledTextRepair } from '@/src/features/image-translation/services/ruledTextRepair';
import type { ImageTextRegion } from '@/src/features/image-translation/paragraphs';
const metadata = JSON.parse(readFileSync(new URL('./fixtures/image-translation/ruled-paper.json', import.meta.url), 'utf8'));
const sha = (data: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
function pixels(kind: 'source' | 'reference') {
    const info = metadata.files[kind], compressed = readFileSync(new URL('./fixtures/image-translation/' + info.file, import.meta.url));
    expect(sha(compressed)).toBe(info.gzipSha256);
    const data = new Uint8ClampedArray(gunzipSync(compressed, { maxOutputLength: metadata.width * metadata.height * 4 }));
    expect(sha(data)).toBe(info.rgbaSha256);
    return data;
}
function maskFor(line: ImageTextRegion, width: number, height: number) {
    const mask = new Uint8Array(width * height);
    for (const box of imageMaskBoxes(line, width, height))
        for (let y = box.y0; y < box.y1; y++)
            for (let x = box.x0; x < box.x1; x++)
                mask[y * width + x] = 1;
    return mask;
}
function syntheticPaper(options: {
    dash?: boolean;
    vary?: boolean;
    curve?: boolean;
    cross?: boolean;
    spacing?: readonly number[];
    width?: number;
    height?: number;
} = {}) {
    const width = options.width ?? 256, height = options.height ?? 128, source = new Uint8ClampedArray(width * height * 4), reference = source.slice(), mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let value = 0;
            for (const center of options.spacing ?? [24, 64, 104]) {
                const bend = options.curve ? 8 * Math.sin(x / 50) : 0, d = Math.abs(y - center - bend);
                if (options.dash && x >= 96 && x < 128)
                    continue;
                value = Math.max(value, d < .5 ? 1 : d < 1.5 ? .5 : 0);
            }
            if (options.vary && x > 128)
                value *= .5;
            if (options.cross && Math.abs(x - 190) < 2)
                value = 1;
            const p = y * width + x;
            source.set([245 - 37 * value, 240 - 26 * value, 221 - 18 * value, 255], p * 4);
            if (x >= 4 && x < width - 4 && y >= 4 && y < height - 4)
                mask[p] = 1;
        }
    reference.set(source);
    for (const left of [40, 80, 140])
        for (let y = 48; y < 82; y++)
            for (let x = left; x < left + 15; x++)
                source.set([30, 36, 34, 255], (y * width + x) * 4);
    return { source, reference, width, height, frame: { left: 0, top: 0, width, height, mask } };
}
function plan(data: ReturnType<typeof syntheticPaper>, remaining: number = IMAGE_RULED_REPAIR_LIMITS.pagePixels) {
    return planImageRuledTextRepair(data.source, data.width, data.height, data.frame, { remaining });
}
function fill(data: ReturnType<typeof syntheticPaper>, x0: number, y0: number, x1: number, y1: number, color: number[]) {
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
            data.source.set([...color, 255], (y * data.width + x) * 4);
}
describe('细线纸面修补', () => {
    it('保留完整细线背景，并在原有蒙版内重建被字遮住的连续线条', () => {
        const data = syntheticPaper(), copy = data.source.slice(), mask = data.frame.mask.slice(), result = plan(data);
        expect(result).toBeDefined();
        let repaired = 0;
        for (let p = 0; p < mask.length; p++) {
            if (!mask[p])
                expect(result!.kind[p]).toBe(0);
            if (result!.kind[p] !== 2)
                continue;
            repaired++;
            for (let c = 0; c < 3; c++)
                expect(Math.abs(result!.colors[p * 3 + c] - data.reference[p * 4 + c])).toBeLessThanOrEqual(1);
        }
        expect(repaired).toBeGreaterThan(1000);
        expect(data.source).toEqual(copy);
        expect(data.frame.mask).toEqual(mask);
    });
    it('非零原图坐标只读取局部 ROI，图外透明内容不参与纸面判断', () => {
        const data = syntheticPaper(), width = 400, height = 240, left = 37, top = 51;
        const source = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < data.height; y++)
            source.set(data.source.subarray(y * data.width * 4, (y + 1) * data.width * 4), ((y + top) * width + left) * 4);
        const copy = source.slice();
        const result = planImageRuledTextRepair(source, width, height, {...data.frame, left, top}, {remaining: IMAGE_RULED_REPAIR_LIMITS.pagePixels});
        expect(result).toEqual(plan(data));
        expect(source).toEqual(copy);
    });
    it.each([
        ['虚线', { dash: true }], ['沿线明暗变化', { vary: true }], ['曲线', { curve: true }], ['交叉图案', { cross: true }], ['不规则行距', { spacing: [24, 64, 114] }],
    ] as const)('拒绝%s，不把不充分的背景模型写入源图', (_name, options) => {
        const data = syntheticPaper(options), copy = data.source.slice(), mask = data.frame.mask.slice();
        expect(plan(data)).toBeUndefined();
        expect(data.source).toEqual(copy);
        expect(data.frame.mask).toEqual(mask);
    });
    it.each([1, 2, 3])('真实裁图旋转 %i 个直角后仍按图像方向恢复细线', (turns) => {
        let source = pixels('source'), reference = pixels('reference'), width = metadata.width, height = metadata.height;
        let mask = maskFor(metadata.line, width, height);
        for (let turn = 0; turn < turns; turn++) {
            const rotated = source.slice(), expected = reference.slice(), nextMask = mask.slice();
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const from = y * width + x, to = x * height + height - y - 1;
                    rotated.set(source.subarray(from * 4, from * 4 + 4), to * 4);
                    expected.set(reference.subarray(from * 4, from * 4 + 4), to * 4);
                    nextMask[to] = mask[from];
                }
            [width, height] = [height, width];
            source = rotated;
            reference = expected;
            mask = nextMask;
        }
        const result = planImageRuledTextRepair(source, width, height, { left: 0, top: 0, width, height, mask }, { remaining: IMAGE_RULED_REPAIR_LIMITS.pagePixels });
        expect(result).toBeDefined();
        let squared = 0, samples = 0, unsupported = 0;
        for (let p = 0; p < mask.length; p++) {
            if (!mask[p]) {
                expect(result!.kind[p]).toBe(0);
                continue;
            }
            if (result!.kind[p] === 0) {
                unsupported++;
                continue;
            }
            for (let c = 0; c < 3; c++) {
                const value = result!.kind[p] === 1 ? source[p * 4 + c] : result!.colors[p * 3 + c];
                squared += (value - reference[p * 4 + c]) ** 2;
                samples++;
            }
        }
        expect(unsupported).toBeLessThanOrEqual(64);
        expect(Math.sqrt(squared / samples)).toBeLessThan(1);
    });
    it('拒绝透明或越界的证据，失败观察也消耗页面预算', () => {
        const data = syntheticPaper(), budget = { remaining: data.width * data.height };
        data.source[(10 * data.width + 10) * 4 + 3] = 254;
        expect(planImageRuledTextRepair(data.source, data.width, data.height, data.frame, budget)).toBeUndefined();
        expect(budget.remaining).toBe(0);
        data.source[(10 * data.width + 10) * 4 + 3] = 255;
        expect(planImageRuledTextRepair(data.source, data.width, data.height, data.frame, budget)).toBeUndefined();
        for (const frame of [{ ...data.frame, left: -1 }, { ...data.frame, width: 257 }, { ...data.frame, mask: new Uint8Array(0) }]) {
            expect(planImageRuledTextRepair(data.source, data.width, data.height, frame, { remaining: 100000 })).toBeUndefined();
        }
        data.frame.mask[0] = 1;
        expect(plan(data)).toBeUndefined();
    });
    it('预付面积有界，非法尺寸和不足预算在读取前退出', () => {
        const data = syntheticPaper(), budget = { remaining: IMAGE_RULED_REPAIR_LIMITS.pagePixels };
        const large = { ...data, width: 1024, height: 300, source: new Uint8ClampedArray(1024 * 300 * 4), frame: { left: 0, top: 0, width: 1024, height: 300, mask: new Uint8Array(1024 * 300) } };
        expect(planImageRuledTextRepair(large.source, large.width, large.height, large.frame, budget)).toBeUndefined();
        expect(budget.remaining).toBe(IMAGE_RULED_REPAIR_LIMITS.pagePixels);
        for (const remaining of [0, NaN, -1, 1.5])
            expect(plan(data, remaining)).toBeUndefined();
        for (const [width, height] of [[0, 128], [256, -1], [256.5, 128], [Number.MAX_SAFE_INTEGER, 128]])
            expect(planImageRuledTextRepair(data.source, width, height, data.frame, budget)).toBeUndefined();
        expect(planImageRuledTextRepair(new Uint8ClampedArray(0), 256, 128, data.frame, budget)).toBeUndefined();
        data.frame.mask[5000] = 2;
        expect(plan(data)).toBeUndefined();
    });
    it('空蒙版、小边界或没有可恢复前景均不产生写入计划', () => {
        const empty = syntheticPaper();
        empty.frame.mask.fill(0);
        expect(plan(empty)).toBeUndefined();
        empty.frame.mask[5000] = 1;
        expect(plan(empty)).toBeUndefined();
        const noInk = syntheticPaper();
        noInk.source.set(noInk.reference);
        expect(plan(noInk)).toBeUndefined();
        const covered = syntheticPaper();
        fill(covered, 4, 4, 252, 124, [30, 36, 34]);
        expect(plan(covered)).toBeUndefined();
    });
    it('拒绝邻边杂色、过量色板和超出已知色轴的明亮反光', () => {
        const noise = syntheticPaper();
        let n = 0;
        for (let y = 3; y <= 124; y++)
            for (let x = 3; x <= 252; x++)
                if (x === 3 || x === 252 || y === 3 || y === 124) {
                    noise.source.set([n % 256, Math.floor(n / 256), 100, 255], (y * 256 + x) * 4);
                    n++;
                }
        expect(n).toBeGreaterThan(512);
        expect(plan(noise)).toBeUndefined();
        const mixed = syntheticPaper();
        fill(mixed, 3, 8, 4, 9, [245, 215, 220]);
        expect(plan(mixed)).toBeUndefined();
        const bright = syntheticPaper();
        fill(bright, 3, 8, 4, 9, [255, 247, 226]);
        expect(plan(bright)).toBeUndefined();
    });
    it('大量线点与分散噪点在独立资源上限内停止', () => {
        const dense = syntheticPaper({ width: 512, height: 400, spacing: Array.from({ length: 39 }, (_, i) => 10 + i * 10) });
        expect(plan(dense)).toBeUndefined();
        const speckles = syntheticPaper();
        for (let y = 8; y < 120; y += 6)
            for (let x = 8; x < 248; x += 6)
                fill(speckles, x, y, x + 1, y + 1, [208, 214, 203]);
        expect(plan(speckles)).toBeUndefined();
        expect(plan(syntheticPaper({ spacing: Array.from({ length: 12 }, (_, i) => 8 + i * 10) }))).toBeUndefined();
    });
    it('短线、孤立标记和拥挤线条不能为背景续线提供依据', () => {
        const broken = syntheticPaper();
        for (let x = 0; x < 256; x++)
            if (x % 48 >= 20)
                for (const y of [24, 64, 104])
                    fill(broken, x, y - 1, x + 1, y + 2, [245, 240, 221]);
        expect(plan(broken)).toBeUndefined();
        const dot = syntheticPaper();
        fill(dot, 30, 36, 31, 37, [208, 214, 203]);
        expect(plan(dot)).toBeUndefined();
        const short = syntheticPaper();
        fill(short, 8, 39, 39, 40, [208, 214, 203]);
        expect(plan(short)).toBeUndefined();
        expect(plan(syntheticPaper({ spacing: [24, 30, 36] }))).toBeUndefined();
    });
    it('宽条纹或只有一条跨边界参考线时拒绝模型', () => {
        const thick = syntheticPaper();
        for (const y of [24, 64, 104])
            fill(thick, 0, y - 2, 256, y + 3, [208, 214, 203]);
        expect(plan(thick)).toBeUndefined();
        const isolated = syntheticPaper();
        for (const y of [64, 104]) {
            fill(isolated, 0, y - 1, 10, y + 2, [245, 240, 221]);
            fill(isolated, 246, y - 1, 256, y + 2, [245, 240, 221]);
        }
        expect(plan(isolated)).toBeUndefined();
    });
    it('大量擦除像素落在线条观测跨度之外时原子拒绝', () => {
        const data = syntheticPaper();
        fill(data, 121, 61, 256, 68, [245, 240, 221]);
        fill(data, 121, 61, 252, 68, [30, 36, 34]);
        const copy = data.source.slice(), mask = data.frame.mask.slice();
        expect(plan(data)).toBeUndefined();
        expect(data.source).toEqual(copy);
        expect(data.frame.mask).toEqual(mask);
    });
    it('完整计划通过普通图片入口应用，副本与原位修补均保护蒙版外像素', () => {
        const data = syntheticPaper(), line = { text: '新文字', sourceText: 'OLD', bbox: { x0: 8, y0: 8, x1: 248, y1: 120 }, fontSize: 34 };
        const mask = maskFor(line, data.width, data.height), copy = data.source.slice(), result = inpaintTextRegions(data.source, data.width, data.height, [line]);
        let difference = 0;
        for (let p = 0; p < mask.length; p++)
            for (let c = 0; c < 4; c++) {
                if (!mask[p] || c === 3)
                    expect(result[p * 4 + c]).toBe(copy[p * 4 + c]);
                else
                    difference = Math.max(difference, Math.abs(result[p * 4 + c] - data.reference[p * 4 + c]));
            }
        expect(difference).toBeLessThanOrEqual(1);
        expect(data.source).toEqual(copy);
        expect(inpaintTextRegions(copy, data.width, data.height, [line], true)).toEqual(result);
    });
    it('近竖直细线的亚像素横截面失配时原子回退，不放宽颜色一致性', () => {
        const data = syntheticPaper();
        fill(data, 0, 0, 256, 128, [245, 240, 221]);
        for (let y = 0; y < 128; y++)
            for (let x = 0; x < 256; x++) {
                let value = 0;
                for (const [center, slope] of [[64, -.01], [128, 0], [192, .01]])
                    value = Math.max(value, Math.max(0, 1 - Math.abs(x - center - (y - 64) * slope)));
                data.source.set([245 - 37 * value, 240 - 26 * value, 221 - 18 * value, 255], (y * 256 + x) * 4);
            }
        data.reference.set(data.source);
        fill(data, 55, 48, 74, 82, [30, 36, 34]);
        fill(data, 120, 48, 137, 82, [30, 36, 34]);
        // Geometry alone agrees, but this raster's observed cross-sections do
        // not fit one shared profile within two RGB levels. Keep the source.
        const copy = data.source.slice(), mask = data.frame.mask.slice();
        expect(plan(data)).toBeUndefined();
        expect(data.source).toEqual(copy);
        expect(data.frame.mask).toEqual(mask);
    });
    it('细线横截面相互接近时保留原算法，避免使用重叠支持带', () => {
        const data = syntheticPaper({ spacing: [] });
        for (const y of [24, 30, 36])
            fill(data, 0, y, 256, y + 1, [208, 214, 203]);
        expect(plan(data)).toBeUndefined();
    });
    it('远弱于横线的浅色笔画也不能被低强度阈值隐藏', () => {
        const data = syntheticPaper();
        fill(data, 18, 33, 21, 43, [242, 238, 220]);
        fill(data, 18, 33, 30, 35, [242, 238, 220]);
        fill(data, 18, 37, 28, 39, [242, 238, 220]);
        expect(plan(data)).toBeUndefined();
    });
    it('独立原始设计参考约束真实两框纸张裁图，不再把横线扩散成大面积色斑', () => {
        expect(sha(readFileSync(new URL('../' + metadata.sourcePath, import.meta.url)))).toBe(metadata.sourcePngSha256);
        expect(sha(readFileSync(new URL('../' + metadata.provenance.generatorPath, import.meta.url)))).toBe(metadata.provenance.generatorSha256);
        const source = pixels('source'), copy = source.slice(), reference = pixels('reference'), line = structuredClone(metadata.line) as ImageTextRegion;
        const { width, height } = metadata, mask = maskFor(line, width, height);
        // Reference is deliberately unavailable to the production call.
        const result = inpaintTextRegions(source, width, height, [line]);
        let squared = 0, samples = 0, outside = 0, alpha = 0, strongTextUnchanged = 0;
        for (let i = 0; i < mask.length; i++) {
            const p = i * 4;
            let same = true, textDifference = 0;
            for (let c = 0; c < 4; c++)
                same &&= result[p + c] === source[p + c];
            if (result[p + 3] !== source[p + 3])
                alpha++;
            if (!mask[i]) {
                if (!same)
                    outside++;
                continue;
            }
            for (let c = 0; c < 3; c++) {
                squared += (result[p + c] - reference[p + c]) ** 2;
                samples++;
                textDifference = Math.max(textDifference, Math.abs(source[p + c] - reference[p + c]));
            }
            if (same && textDifference > 2)
                strongTextUnchanged++;
        }
        expect(source).toEqual(copy);
        expect(outside).toBe(0);
        expect(alpha).toBe(0);
        expect(strongTextUnchanged).toBe(0);
        expect(Math.sqrt(squared / samples)).toBeLessThan(1);
    });
    it('与纸面横线同色的浅字仍是原文，不能当成已知背景保留', () => {
        const width = 256, height = 96, source = new Uint8ClampedArray(width * height * 4), faint = new Uint8Array(width * height);
        const base = [245, 240, 221], rule = [208, 214, 203], ink = [30, 36, 34];
        for (let i = 0; i < width * height; i++)
            source.set([...base, 255], i * 4);
        for (const y of [24, 68])
            for (let x = 0; x < width; x++)
                source.set([...rule, 255], (y * width + x) * 4);
        const glyphs: Record<string, string[]> = { N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'], I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'] };
        const paint = (text: string, left: number, color: number[], mark: boolean) => {
            for (const letter of text) {
                glyphs[letter].forEach((row, y) => [...row].forEach((on, x) => {
                    if (on !== '1')
                        return;
                    for (let yy = 0; yy < 3; yy++)
                        for (let xx = 0; xx < 3; xx++) {
                            const i = (34 + y * 3 + yy) * width + left + x * 3 + xx;
                            source.set([...color, 255], i * 4);
                            if (mark)
                                faint[i] = 1;
                        }
                }));
                left += 18;
            }
        };
        paint('NOTE', 24, ink, false);
        paint('EXIT', 142, rule, true);
        const line = { text: '记录出口', sourceText: 'NOTE EXIT', bbox: { x0: 12, y0: 16, x1: 244, y1: 78 }, fontSize: 21 };
        const result = inpaintTextRegions(source, width, height, [line]);
        let retained = 0;
        for (let i = 0; i < faint.length; i++)
            if (faint[i]) {
                const p = i * 4;
                if (Math.max(...rule.map((v, c) => Math.abs(result[p + c] - v))) <= 2)
                    retained++;
            }
        expect(faint.reduce((a, b) => a + b, 0)).toBe(513);
        expect(retained).toBe(0);
    });
});
