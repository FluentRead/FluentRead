/**
 * @file tests/mangaDetectionHorizontalSplit.test.ts
 * 文件职责：验证水平 DBNet 检测框的 UI 边框拆分、背景阶跃拆分、宽死谷分栏拆分与前导下拉箭头裁切算法。
 * 主要内容：覆盖竖向边框延展、1px/2px 边框、无边框色阶、宽表列间距、多列连续拆分、缩放偏移映射，以及英文词距、I/l/| 字形、渐变背景和各类前导图标反例。
 * 模块边界：只测纯算法与像素只读不变量，不依赖 DOM、Canvas 或 ONNX 模型。
 */
import {describe, expect, it} from 'vitest';
import {
    splitHorizontalDetectionBox,
    splitHorizontalDetectionBoxWithBounds,
    type DetectionBBox,
    type HorizontalSplitPixels,
} from '@/src/features/image-translation/services/mangaDetectionHorizontalSplit';

function makeCanvas(width: number, height: number, fill: readonly [number, number, number] = [255, 255, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = fill[0];
        data[i + 1] = fill[1];
        data[i + 2] = fill[2];
        data[i + 3] = 255;
    }
    const paintRect = (x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number]) => {
        for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
            for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
                const offset = (y * width + x) * 4;
                data[offset] = color[0];
                data[offset + 1] = color[1];
                data[offset + 2] = color[2];
                data[offset + 3] = 255;
            }
        }
    };
    const pixels: HorizontalSplitPixels = {data, width, height};
    return {data, pixels, paintRect};
}

function makeProbMap(width: number, height: number, box: DetectionBBox, profile: (dx: number) => number): Float32Array {
    const probabilities = new Float32Array(width * height);
    for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) {
            probabilities[y * width + x] = profile(x - box.x0);
        }
    }
    return probabilities;
}

describe('水平检测框的 UI 边框与分栏拆分', () => {
    it('竖向 UI 边框拆开控件内外文本，并在右侧存在居中下拉箭头时裁去前导箭头', () => {
        const {data, pixels, paintRect} = makeCanvas(160, 60, [230, 230, 230]);
        // 右侧输入控件内部白底与 1px 灰色边框（上下延展超过文字框 >= 2px）
        paintRect(41, 12, 140, 44, [255, 255, 255]);
        paintRect(40, 12, 41, 44, [150, 150, 150]);
        // 左侧 "to" 笔画
        paintRect(14, 24, 28, 34, [30, 30, 30]);
        // 边框内紧邻居中下拉箭头 v（宽 6px，高 6px <= 0.55*16=9 且 <= 0.75*12=9，中心与框高中心一致）
        paintRect(45, 25, 51, 31, [90, 90, 90]);
        // >= max(4, round(16*0.28))=4px 空白后绘制正文 "End"（字符间内隙 2px，5 > 2*1.35）
        paintRect(56, 22, 66, 34, [25, 25, 25]);
        paintRect(68, 22, 78, 34, [25, 25, 25]);
        paintRect(80, 22, 95, 34, [25, 25, 25]);

        const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
        // DBNet 弱尾迹在边框处保持 0.28（< 0.35），箭头处为 0.55
        const probabilities = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            if (x >= 12 && x < 30) return 0.85;
            if (x >= 30 && x < 45) return 0.28;
            if (x >= 45 && x < 51) return 0.55;
            if (x >= 51 && x < 56) return 0.2;
            if (x >= 56 && x < 98) return 0.9;
            return 0.05;
        });
        const snapshot = data.slice();
        const withBounds = splitHorizontalDetectionBoxWithBounds(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels});
        expect(withBounds).toEqual([
            {bbox: {x0: 10, y0: 20, x1: 30, y1: 36}, hardBounds: {right: 40}},
            {bbox: {x0: 56, y0: 20, x1: 110, y1: 36}, hardBounds: {left: 52}},
        ]);
        const parts = splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels});
        expect(parts).toEqual([
            {x0: 10, y0: 20, x1: 30, y1: 36},
            {x0: 56, y0: 20, x1: 110, y1: 36},
        ]);
        expect(data).toEqual(snapshot);
    });

    it('2x Retina 控件内首字/首数字（| 14.75 g、| Infill、| 2 items）绝不被误裁为下拉箭头，真 2x 箭头与多边框硬边界正确保留', () => {
        const runRetina = (drawInside: (paint: ReturnType<typeof makeCanvas>['paintRect']) => void) => {
            const c = makeCanvas(280, 90, [230, 230, 230]);
            c.paintRect(61, 10, 260, 74, [255, 255, 255]);
            c.paintRect(60, 10, 61, 74, [140, 140, 140]);
            c.paintRect(16, 26, 46, 54, [25, 25, 25]);
            drawInside(c.paintRect);
            const box: DetectionBBox = {x0: 12, y0: 24, x1: 250, y1: 56}; // ph = 32
            const probs = makeProbMap(280, 90, box, dx => {
                const x = box.x0 + dx;
                return x < 48 || x >= 68 ? 0.9 : 0.25;
            });
            return splitHorizontalDetectionBoxWithBounds(box, {probabilities: probs, mapWidth: 280, mapHeight: 90, pixels: c.pixels});
        };

        // 2x Retina "| 14.75 g"：首字 '1' 高 22px（与后续数字同高），字距 4px -> 绝不裁去 '1'
        const numParts = runRetina(p => {
            p(68, 29, 76, 51, [20, 20, 20]); // '1'
            p(80, 29, 92, 51, [20, 20, 20]); // '4' (gap=4)
            p(96, 46, 100, 51, [20, 20, 20]); // '.' (gap=4)
            p(104, 29, 116, 51, [20, 20, 20]); // '7'
            p(120, 29, 132, 51, [20, 20, 20]); // '5'
        });
        expect(numParts[1]).toEqual({bbox: {x0: 68, y0: 24, x1: 250, y1: 56}, hardBounds: {left: 61}});

        // 2x Retina "| Infill"：首字 'I' 高 22px，字距 4px -> 绝不裁去 'I'
        const infillParts = runRetina(p => {
            p(68, 29, 73, 51, [20, 20, 20]); // 'I'
            p(77, 34, 90, 51, [20, 20, 20]); // 'n' (gap=4)
            p(93, 29, 102, 51, [20, 20, 20]); // 'f' (gap=3)
            p(105, 29, 110, 51, [20, 20, 20]); // 'i' (gap=3)
        });
        expect(infillParts[1]).toEqual({bbox: {x0: 68, y0: 24, x1: 250, y1: 56}, hardBounds: {left: 61}});

        // "| 2 items"：单个领先数字高 18px（即使后接 12px 大空格），高度与正文同高 -> 绝不裁去 '2'
        const twoItemsParts = runRetina(p => {
            p(68, 30, 80, 48, [20, 20, 20]); // '2' (h=18, > 0.55*32=18? 18<=18, but textInkHeight=18 -> 18 > 13.5!)
            p(92, 30, 100, 48, [20, 20, 20]); // 'i' (gap=12)
            p(103, 30, 114, 48, [20, 20, 20]); // 't' (gap=3)
        });
        expect(twoItemsParts[1]).toEqual({bbox: {x0: 68, y0: 24, x1: 250, y1: 56}, hardBounds: {left: 61}});

        // 小字号且等高首字（iconHeight=10 <= 0.55*32=18，但等于 textInkHeight=10 -> 10 > 7.5）绝不误裁
        const sameSmallHeight = runRetina(p => {
            p(68, 35, 76, 45, [20, 20, 20]);
            p(88, 35, 98, 45, [20, 20, 20]);
            p(101, 35, 112, 45, [20, 20, 20]);
        });
        expect(sameSmallHeight[1].bbox.x0).toBe(68);

        // 宽字距文本（gap=10 >= 9，但正文内隙中位数为 8px，10 <= 8*1.35=10.8）绝不误裁
        const wideTracked = runRetina(p => {
            p(68, 35, 76, 45, [20, 20, 20]); // h=10
            p(86, 28, 96, 52, [20, 20, 20]); // gap=10, textH=24
            p(104, 28, 114, 52, [20, 20, 20]); // inner gap=8
            p(122, 28, 132, 52, [20, 20, 20]); // inner gap=8
        });
        expect(wideTracked[1].bbox.x0).toBe(68);

        // 真 2x Retina 下拉箭头 "| v   End"：箭头居中且高 10px (<=18 且 <=22*0.75)，间距 10px (>=9 且 > 3*1.35) -> 精准裁切并带硬边界
        const retinaChevron = runRetina(p => {
            p(68, 35, 78, 45, [90, 90, 90]); // chevron v (w=10, h=10, center=39.5)
            p(88, 29, 102, 51, [20, 20, 20]); // 'E' (gap=10, h=22)
            p(105, 34, 118, 51, [20, 20, 20]); // 'n' (inner gap=3)
            p(121, 29, 134, 51, [20, 20, 20]); // 'd' (inner gap=3)
        });
        expect(retinaChevron).toEqual([
            {bbox: {x0: 12, y0: 24, x1: 48, y1: 56}, hardBounds: {right: 60}},
            {bbox: {x0: 88, y0: 24, x1: 250, y1: 56}, hardBounds: {left: 79}},
        ]);

        // 三段双边框 "A | B | C"：中间段同时携带左右硬边界
        const multi = makeCanvas(220, 60, [255, 255, 255]);
        multi.paintRect(60, 10, 61, 46, [120, 120, 120]);
        multi.paintRect(130, 10, 131, 46, [120, 120, 120]);
        const multiBox: DetectionBBox = {x0: 10, y0: 20, x1: 200, y1: 36};
        const multiProbs = makeProbMap(220, 60, multiBox, dx => {
            const x = multiBox.x0 + dx;
            if ((x >= 52 && x < 68) || (x >= 122 && x < 138)) return 0.25;
            return 0.9;
        });
        expect(splitHorizontalDetectionBoxWithBounds(multiBox, {probabilities: multiProbs, mapWidth: 220, mapHeight: 60, pixels: multi.pixels})).toEqual([
            {bbox: {x0: 10, y0: 20, x1: 52, y1: 36}, hardBounds: {right: 60}},
            {bbox: {x0: 68, y0: 20, x1: 122, y1: 36}, hardBounds: {left: 61, right: 130}},
            {bbox: {x0: 138, y0: 20, x1: 200, y1: 36}, hardBounds: {left: 131}},
        ]);
    });

    it('支持 2px 边框、单向向下或向上延展，以及无箭头时紧贴正文起点', () => {
        for (const direction of ['above', 'below'] as const) {
            const {pixels, paintRect} = makeCanvas(160, 60, [255, 255, 255]);
            const top = direction === 'above' ? 14 : 20;
            const bottom = direction === 'below' ? 42 : 36;
            paintRect(50, top, 52, bottom, [100, 100, 100]);
            paintRect(14, 22, 42, 34, [20, 20, 20]);
            paintRect(58, 22, 102, 34, [20, 20, 20]);
            const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
            const probabilities = makeProbMap(160, 60, box, dx => {
                const x = box.x0 + dx;
                return x < 44 || x >= 58 ? 0.88 : 0.22;
            });
            expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels})).toEqual([
                {x0: 10, y0: 20, x1: 44, y1: 36},
                {x0: 58, y0: 20, x1: 110, y1: 36},
            ]);
        }
    });

    it('无边框的背景色阶跃（含直接阶跃与 1px 抗锯齿过渡）可拆分，平滑渐变和微小色差不拆分', () => {
        const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
        const probabilities = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            return x < 45 || x >= 55 ? 0.9 : 0.28;
        });
        // 纯无边框直接阶跃（灰 -> 白，无中间边框列，走背景阶跃路径）
        const directStep = makeCanvas(160, 60, [224, 224, 224]);
        directStep.paintRect(50, 0, 160, 60, [255, 255, 255]);
        expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: directStep.pixels})).toEqual([
            {x0: 10, y0: 20, x1: 45, y1: 36},
            {x0: 55, y0: 20, x1: 110, y1: 36},
        ]);

        // 含 1px 抗锯齿过渡列的背景阶跃
        const step = makeCanvas(160, 60, [224, 224, 224]);
        step.paintRect(50, 0, 160, 60, [255, 255, 255]);
        step.paintRect(49, 0, 50, 60, [240, 240, 240]); // 1px AA 过渡
        const split = splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: step.pixels});
        expect(split).toEqual([
            {x0: 10, y0: 20, x1: 45, y1: 36},
            {x0: 55, y0: 20, x1: 110, y1: 36},
        ]);

        // 平滑线性渐变（每列变化 2，总体跨谷差 > 24 但无突变阶跃）不拆分
        const gradient = makeCanvas(160, 60, [200, 200, 200]);
        for (let x = 40; x < 65; x++) {
            const v = 200 + (x - 40) * 2;
            gradient.paintRect(x, 0, x + 1, 60, [v, v, v]);
        }
        gradient.paintRect(65, 0, 160, 60, [250, 250, 250]);
        expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: gradient.pixels})).toEqual([box]);

        // 框紧贴图像顶边 (y0=0) 与底边 (y1=height) 时，条带背景采样跳过越界行且正确拆分背景阶跃
        const edgeStep = makeCanvas(160, 16, [224, 224, 224]);
        edgeStep.paintRect(50, 0, 160, 16, [255, 255, 255]);
        const edgeBox: DetectionBBox = {x0: 10, y0: 0, x1: 110, y1: 16};
        const edgeProbs = makeProbMap(160, 16, edgeBox, dx => (edgeBox.x0 + dx < 45 || edgeBox.x0 + dx >= 55 ? 0.9 : 0.25));
        expect(splitHorizontalDetectionBox(edgeBox, {probabilities: edgeProbs, mapWidth: 160, mapHeight: 16, pixels: edgeStep.pixels})).toEqual([
            {x0: 10, y0: 0, x1: 45, y1: 16},
            {x0: 55, y0: 0, x1: 110, y1: 16},
        ]);

        // 背景色差不足 L1 < 24 不拆分
        const tiny = makeCanvas(160, 60, [250, 250, 250]);
        tiny.paintRect(50, 0, 160, 60, [255, 255, 255]);
        expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: tiny.pixels})).toEqual([box]);
    });

    it('宽 DBNet 死谷拆开多列表格栏，但绝不拆开正常英文词距', () => {
        // h = 16 -> minDeadWidth = max(5, round(16 * 0.65)) = 10
        const box: DetectionBBox = {x0: 10, y0: 20, x1: 190, y1: 36};
        // 三列：Flushed (10..50) | 18px 死谷 | Tower (68..110) | 16px 死谷 | Total (126..180)
        const tableProbs = makeProbMap(200, 60, box, dx => {
            const x = box.x0 + dx;
            if (x < 50 || (x >= 68 && x < 110) || x >= 126) return 0.92;
            return 0.05;
        });
        expect(splitHorizontalDetectionBox(box, {probabilities: tableProbs, mapWidth: 200, mapHeight: 60})).toEqual([
            {x0: 10, y0: 20, x1: 50, y1: 36},
            {x0: 68, y0: 20, x1: 110, y1: 36},
            {x0: 126, y0: 20, x1: 190, y1: 36},
        ]);

        // 正常英文词距（宽 6px < 10px，且无边框/背景阶跃）保持整行不拆
        const normalSpace = makeProbMap(200, 60, box, dx => {
            const x = box.x0 + dx;
            if (x >= 50 && x < 56) return 0.08;
            return 0.9;
        });
        expect(splitHorizontalDetectionBox(box, {probabilities: normalSpace, mapWidth: 200, mapHeight: 60})).toEqual([box]);

        // 弱谷但始终 >= 0.15 不满足死谷条件；多段 <0.15 子段中取最长段
        const shallowValley = makeProbMap(200, 60, box, dx => {
            const x = box.x0 + dx;
            if (x >= 50 && x < 80) return 0.2;
            return 0.9;
        });
        expect(splitHorizontalDetectionBox(box, {probabilities: shallowValley, mapWidth: 200, mapHeight: 60})).toEqual([box]);

        const twoSubDeadRuns = makeProbMap(200, 60, box, dx => {
            const x = box.x0 + dx;
            if (x >= 50 && x < 62) return 0.05; // 12px dead run (longest)
            if (x >= 62 && x < 65) return 0.2;  // bump inside valley
            if (x >= 65 && x < 70) return 0.05; // 5px dead run (shorter)
            return 0.9;
        });
        expect(splitHorizontalDetectionBox(box, {probabilities: twoSubDeadRuns, mapWidth: 200, mapHeight: 60})).toEqual([
            {x0: 10, y0: 20, x1: 50, y1: 36},
            {x0: 62, y0: 20, x1: 190, y1: 36},
        ]);
    });

    it('绝不把 I/l/| 等竖直字形或断裂伪竖线误判为 UI 边框', () => {
        const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
        const probabilities = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            return x < 46 || x >= 54 ? 0.9 : 0.2;
        });
        // 竖线仅在 [y0, y1) 内，不向上下延展 >= 2px（对应 I/l/| 字形）
        const glyphPipe = makeCanvas(160, 60, [255, 255, 255]);
        glyphPipe.paintRect(50, 20, 51, 36, [20, 20, 20]);
        expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: glyphPipe.pixels})).toEqual([box]);

        // 断裂竖线（框内连续覆盖不足 90%）不触发边框拆分
        const brokenLine = makeCanvas(160, 60, [255, 255, 255]);
        brokenLine.paintRect(50, 14, 51, 26, [20, 20, 20]);
        brokenLine.paintRect(50, 30, 51, 42, [20, 20, 20]);
        expect(splitHorizontalDetectionBox(box, {probabilities, mapWidth: 160, mapHeight: 60, pixels: brokenLine.pixels})).toEqual([box]);
    });

    it('前导图标裁切仅接受紧邻边框、居中、紧凑、与正文隔离 >= 3px 且保留强峰的图标', () => {
        const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
        const baseProbs = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            return x < 30 || x >= 45 ? 0.9 : 0.25;
        });
        const setup = (drawRight: (paint: ReturnType<typeof makeCanvas>['paintRect']) => void, probs = baseProbs) => {
            const c = makeCanvas(160, 60, [230, 230, 230]);
            c.paintRect(41, 12, 150, 44, [255, 255, 255]);
            c.paintRect(40, 12, 41, 44, [140, 140, 140]);
            c.paintRect(14, 24, 28, 34, [20, 20, 20]);
            drawRight(c.paintRect);
            return splitHorizontalDetectionBox(box, {probabilities: probs, mapWidth: 160, mapHeight: 60, pixels: c.pixels});
        };

        // 1px 噪点 (iconWidth < 2) 不裁
        expect(setup(p => { p(45, 26, 46, 30, [20, 20, 20]); p(55, 22, 90, 34, [20, 20, 20]); })[1].x0).toBe(45);
        // 离边框过远 (iconStart > max(8, ph*0.6)=10) 不裁
        expect(setup(p => { p(55, 26, 60, 30, [20, 20, 20]); p(68, 22, 95, 34, [20, 20, 20]); })[1].x0).toBe(45);
        // 全高字母 I (iconHeight > ph*0.75) 不裁
        expect(setup(p => { p(45, 21, 48, 35, [20, 20, 20]); p(55, 22, 90, 34, [20, 20, 20]); })[1].x0).toBe(45);
        // 偏离垂直中心（底部污点）不裁
        expect(setup(p => { p(45, 32, 50, 35, [20, 20, 20]); p(56, 22, 90, 34, [20, 20, 20]); })[1].x0).toBe(45);
        // 与正文间距 < 3px（正常字距）不裁
        expect(setup(p => { p(45, 26, 50, 30, [20, 20, 20]); p(52, 22, 90, 34, [20, 20, 20]); })[1].x0).toBe(45);
        // 仅有孤立图标无后续正文不裁
        expect(setup(p => { p(45, 26, 50, 30, [20, 20, 20]); })[1].x0).toBe(45);
        // 裁后无 >= 0.3 强峰不裁
        const weakTailProbs = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            if (x < 30 || (x >= 45 && x < 51)) return 0.9;
            return 0.2;
        });
        expect(setup(p => { p(45, 26, 50, 30, [20, 20, 20]); p(56, 22, 90, 34, [20, 20, 20]); }, weakTailProbs)[1].x0).toBe(45);
        // 右侧剩余宽度不足 8px 不进入图标裁切
        const shortRightBox: DetectionBBox = {x0: 10, y0: 20, x1: 47, y1: 36};
        const shortProbs = makeProbMap(160, 60, shortRightBox, dx => {
            const x = shortRightBox.x0 + dx;
            return x < 30 || x >= 44 ? 0.9 : 0.25;
        });
        const shortCanvas = makeCanvas(160, 60, [230, 230, 230]);
        shortCanvas.paintRect(41, 12, 150, 44, [255, 255, 255]);
        shortCanvas.paintRect(40, 12, 41, 44, [140, 140, 140]);
        expect(splitHorizontalDetectionBox(shortRightBox, {probabilities: shortProbs, mapWidth: 160, mapHeight: 60, pixels: shortCanvas.pixels})).toEqual([
            {x0: 10, y0: 20, x1: 30, y1: 36},
            {x0: 44, y0: 20, x1: 47, y1: 36},
        ]);
    });

    it('支持瓦片偏移与缩放像素映射，并安全忽略非法、非水平或单侧无峰输入', () => {
        // offset + scale 映射
        const scaled = makeCanvas(300, 120, [230, 230, 230]);
        scaled.paintRect(101, 20, 280, 100, [255, 255, 255]);
        scaled.paintRect(100, 20, 101, 100, [120, 120, 120]);
        const box: DetectionBBox = {x0: 10, y0: 20, x1: 110, y1: 36};
        const probs = makeProbMap(160, 60, box, dx => {
            const x = box.x0 + dx;
            return x < 35 || x >= 48 ? 0.9 : 0.25;
        });
        const scaledPixels: HorizontalSplitPixels = {
            data: scaled.data, width: 300, height: 120, offsetX: 20, offsetY: 10, scale: 2,
        };
        expect(splitHorizontalDetectionBox(box, {probabilities: probs, mapWidth: 160, mapHeight: 60, pixels: scaledPixels})).toEqual([
            {x0: 10, y0: 20, x1: 35, y1: 36},
            {x0: 48, y0: 20, x1: 110, y1: 36},
        ]);

        // 无效参数、竖框、细框、越界框、无双侧强峰、无效像素缓冲及贴边谷
        expect(splitHorizontalDetectionBox(box, {probabilities: new Float32Array(1), mapWidth: 160, mapHeight: 60})).toEqual([box]);
        expect(splitHorizontalDetectionBox(box, {probabilities: probs, mapWidth: 0, mapHeight: 60})).toEqual([box]);
        expect(splitHorizontalDetectionBox({x0: -1, y0: 20, x1: 50, y1: 36}, {probabilities: probs, mapWidth: 160, mapHeight: 60})).toEqual([{x0: -1, y0: 20, x1: 50, y1: 36}]);
        expect(splitHorizontalDetectionBox({x0: 10, y0: 20, x1: 30, y1: 36}, {probabilities: probs, mapWidth: 160, mapHeight: 60})).toEqual([{x0: 10, y0: 20, x1: 30, y1: 36}]);
        expect(splitHorizontalDetectionBox({x0: 10, y0: 20, x1: 50, y1: 23}, {probabilities: probs, mapWidth: 160, mapHeight: 60})).toEqual([{x0: 10, y0: 20, x1: 50, y1: 23}]);

        // 单侧无强峰不拆
        const oneSideProbs = makeProbMap(160, 60, box, dx => (dx < 20 ? 0.9 : 0.05));
        expect(splitHorizontalDetectionBox(box, {probabilities: oneSideProbs, mapWidth: 160, mapHeight: 60})).toEqual([box]);
        const rightOnlyProbs = makeProbMap(160, 60, box, dx => (dx > 60 ? 0.9 : 0.05));
        expect(splitHorizontalDetectionBox(box, {probabilities: rightOnlyProbs, mapWidth: 160, mapHeight: 60})).toEqual([box]);

        // 非法 pixels 回退为仅概率模式（不崩）
        expect(splitHorizontalDetectionBox(box, {
            probabilities: probs, mapWidth: 160, mapHeight: 60,
            pixels: {data: new Uint8ClampedArray(4), width: 10, height: 10},
        })).toEqual([box]);

        // 像素缩放后高度 < 4 或侧翼贴边跳过像素判定
        expect(splitHorizontalDetectionBox(box, {
            probabilities: probs, mapWidth: 160, mapHeight: 60,
            pixels: {data: scaled.data, width: 300, height: 120, offsetY: 118, scale: 1},
        })).toEqual([box]);
        expect(splitHorizontalDetectionBox(box, {
            probabilities: probs, mapWidth: 160, mapHeight: 60,
            pixels: {data: scaled.data, width: 300, height: 120, offsetX: -40, scale: 1},
        })).toEqual([box]);
        expect(splitHorizontalDetectionBox(box, {
            probabilities: probs, mapWidth: 160, mapHeight: 60,
            pixels: {data: scaled.data, width: 300, height: 120, offsetX: 260, scale: 1},
        })).toEqual([box]);
    });
});
