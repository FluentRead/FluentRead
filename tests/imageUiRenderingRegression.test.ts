/** @file tests/imageUiRenderingRegression.test.ts 真实 UI 截图场景回归：彩色按钮白字保色与无缺口修补、细边框按钮无灰晕居中、兄弟 UI 字号协调、相邻 guardOnly 夹紧保留与脏矩形上传。 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    getImageSourceInkFontSize,
    getImageTextColor,
    harmonizeImageSiblingFontSizes,
    isAcceptableImageSourceInk,
} from '@/src/features/image-translation/services/rendering';
import {observeImageSourceInk} from '@/src/features/image-translation/services/sourceInk';
import {observeImageSourceAppearances} from '@/src/features/image-translation/services/sourceAppearance';
import {getInpaintDirtyRects, inpaintTextRegions} from '@/src/features/image-translation/services/inpainting';
import {detectImageSingleLineAlignment} from '@/src/features/image-translation/services/sourceAlignment';
import type {ImageTextRegion} from '@/src/features/image-translation/paragraphs';

const mocks = vi.hoisted(() => ({
    recognize: vi.fn(),
    mangaRecognize: vi.fn(),
    encode: vi.fn(),
    draw: vi.fn(),
    setBackend: vi.fn(),
}));

vi.mock('@/src/features/image-translation/services/ocrRuntime', () => ({recognizeImage: mocks.recognize}));
vi.mock('@/src/features/image-translation/services/mangaOcr', () => ({mangaOcrRuntime: {recognize: mocks.mangaRecognize}}));
vi.mock('@/src/features/image-translation/services/imageEncoding', () => ({encodeImageCanvas: mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaInferenceClient', () => ({
    mangaInferenceClient: {prepareTextSegmentation: vi.fn(async () => false), segmentText: vi.fn(), setBackend: mocks.setBackend},
}));
vi.mock('@/src/features/image-translation/services/rendering', async importOriginal => ({
    ...await importOriginal<typeof import('@/src/features/image-translation/services/rendering')>(),
    drawTranslatedImageText: mocks.draw,
}));

import {translateImageInOffscreen} from '@/src/features/image-translation/services/offscreenRuntime';

function makeImage(width: number, height: number, fill: readonly [number, number, number, number] = [255, 255, 255, 255]): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(fill, i);
    return pixels;
}

function fillRect(
    pixels: Uint8ClampedArray,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number, number],
): void {
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) pixels.set(color, (y * width + x) * 4);
    }
}

function strokeBorder(
    pixels: Uint8ClampedArray,
    width: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number, number],
): void {
    for (let x = x0; x < x1; x++) {
        pixels.set(color, (y0 * width + x) * 4);
        pixels.set(color, ((y1 - 1) * width + x) * 4);
    }
    for (let y = y0; y < y1; y++) {
        pixels.set(color, (y * width + x0) * 4);
        pixels.set(color, (y * width + (x1 - 1)) * 4);
    }
}

function pixelAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number[] {
    const p = (y * width + x) * 4;
    return [pixels[p], pixels[p + 1], pixels[p + 2], pixels[p + 3]];
}

describe('UI 截图视觉渲染、修补、对齐与字号协调回归', () => {
    it('绿色 #00AE42 胶囊按钮保留白字、无白缺口修补并自动居中', () => {
        const width = 200, height = 100;
        const green: readonly [number, number, number, number] = [0, 174, 66, 255];
        const white: readonly [number, number, number, number] = [255, 255, 255, 255];
        const pixels = makeImage(width, height, white);
        // 绿色胶囊按钮 [60..140, 36..62)
        fillRect(pixels, width, 60, 36, 140, 62, green);
        // 居中白色文字 "OK" 墨迹 [88..112, 43..55)
        fillRect(pixels, width, 88, 43, 98, 55, white);
        fillRect(pixels, width, 102, 43, 112, 55, white);

        const okBox = {x0: 87, y0: 41, x1: 113, y1: 57};
        const region: ImageTextRegion = {text: 'OK', bbox: okBox, fontSize: 16};

        // 1. 源色与对照规则：#00AE42 上白字保留，浅粉绿/纯荧光绿回退深字
        expect(isAcceptableImageSourceInk([255, 255, 255], [0, 174, 66])).toBe(true);
        expect(isAcceptableImageSourceInk([255, 255, 255], [200, 245, 215])).toBe(false);
        expect(isAcceptableImageSourceInk([255, 255, 255], [0, 255, 0])).toBe(false);
        expect(getImageTextColor('rgb(0,174,66)')).toBe('#ffffff');
        expect(getImageTextColor('rgb(200,245,215)')).toBe('#111827');

        // 2. 外扩跨越紧凑胶囊时仍保留白色前景与绿色背景
        const appearances = observeImageSourceAppearances(pixels, width, height, [region], () => ({x0: 85, y0: 34, x1: 115, y1: 64}));
        expect(appearances.get(region)).toMatchObject({
            foreground: 'rgb(255,255,255)',
            background: [0, 174, 66, 255],
        });
        expect(observeImageSourceInk(pixels, width, height, {x0: 85, y0: 34, x1: 115, y1: 64}, [okBox])).toMatchObject({
            foreground: 'rgb(255,255,255)',
            background: [0, 174, 66, 255],
        });

        // 3. 紧贴胶囊上下沿的 OCR 框修补后整个按钮内部仍为纯 #00AE42，零白色缺口且不破坏外部白底
        const tightOk: ImageTextRegion = {text: 'OK', bbox: {x0: 87, y0: 36, x1: 113, y1: 62}};
        const repaired = inpaintTextRegions(pixels, width, height, [tightOk]);
        for (let y = 36; y < 62; y++) {
            for (let x = 60; x < 140; x++) {
                expect(pixelAt(repaired, width, x, y)).toEqual([0, 174, 66, 255]);
            }
        }
        expect(pixelAt(repaired, width, 100, 35)).toEqual([255, 255, 255, 255]);
        expect(pixelAt(repaired, width, 100, 62)).toEqual([255, 255, 255, 255]);

        // 4. 自动检测为胶囊居中对齐
        expect(detectImageSingleLineAlignment(pixels, width, height, okBox)).toBe('center');
    });

    it('一像素细灰边框白色 Cancel 按钮修补无灰晕、边框完整且自动居中', () => {
        const width = 220, height = 100;
        const white: readonly [number, number, number, number] = [255, 255, 255, 255];
        const border: readonly [number, number, number, number] = [200, 200, 200, 255];
        const dark: readonly [number, number, number, number] = [50, 50, 50, 255];
        const pixels = makeImage(width, height, white);
        // 按钮外框 [60..160, 36..62)，1px 灰色边框
        strokeBorder(pixels, width, 60, 36, 160, 62, border);
        // 居中文字 "Cancel" 墨迹 [86..134, 43..55)
        fillRect(pixels, width, 86, 43, 134, 55, dark);

        // 即使 OCR 框贴到内沿（y0=37, y1=61），扩边被夹紧在 1px 边框内，修补内部全白无灰晕
        const cancelBox = {x0: 84, y0: 37, x1: 136, y1: 61};
        const repaired = inpaintTextRegions(pixels, width, height, [{text: 'Cancel', bbox: cancelBox}]);

        // 1px 灰边框逐像素完整保留
        for (let x = 60; x < 160; x++) {
            expect(pixelAt(repaired, width, x, 36)).toEqual([200, 200, 200, 255]);
            expect(pixelAt(repaired, width, x, 61)).toEqual([200, 200, 200, 255]);
        }
        // 按钮内部全纯白，无灰边渗入或弧形污迹
        for (let y = 37; y < 61; y++) {
            for (let x = 61; x < 159; x++) {
                expect(pixelAt(repaired, width, x, y)).toEqual([255, 255, 255, 255]);
            }
        }
        expect(detectImageSingleLineAlignment(pixels, width, height, {x0: 86, y0: 42, x1: 134, y1: 56})).toBe('center');
    });

    it('下拉框右侧相邻 chevron 图标在存在干净背景缝隙时不被修补掩码截断', () => {
        const width = 180, height = 60;
        const white: readonly [number, number, number, number] = [255, 255, 255, 255];
        const dark: readonly [number, number, number, number] = [40, 40, 40, 255];
        const pixels = makeImage(width, height, white);
        // 下拉文字 [20..80, 20..36)
        fillRect(pixels, width, 24, 24, 76, 32, dark);
        // 右侧留 1px 白缝 (x=80)，x=81..82 画暗色下拉箭头 v
        fillRect(pixels, width, 81, 24, 83, 32, dark);

        const repaired = inpaintTextRegions(pixels, width, height, [{text: 'Auto', bbox: {x0: 20, y0: 20, x1: 80, y1: 36}}]);
        expect(pixelAt(repaired, width, 50, 28)).toEqual([255, 255, 255, 255]);
        expect(pixelAt(repaired, width, 81, 28)).toEqual([40, 40, 40, 255]);
        expect(pixelAt(repaired, width, 82, 28)).toEqual([40, 40, 40, 255]);
    });

    it('一像素细笔画下拉箭头 v（每列仅 1~2 墨迹像素）与 1x 窄双字胶囊 OK 均完整保形无缺口', () => {
        // 1. 1px 细笔画 7×4px 下拉箭头 v（每列仅 1px 暗色）紧邻白缝右侧，左侧放 1px 细箭头 <
        const width = 160, height = 60;
        const white: readonly [number, number, number, number] = [255, 255, 255, 255];
        const dark: readonly [number, number, number, number] = [40, 40, 40, 255];
        const pixels = makeImage(width, height, white);
        fillRect(pixels, width, 34, 24, 76, 32, dark);
        // 右侧 x=80 为干净 1px 白缝；x=81..87 为 1px 细笔画 v（每列仅 1 像素）
        const rightChevron: Array<[number, number]> = [[81, 26], [82, 27], [83, 28], [84, 29], [85, 28], [86, 27], [87, 26]];
        for (const [cx, cy] of rightChevron) pixels.set(dark, (cy * width + cx) * 4);
        // 左侧 x=29 为干净 1px 白缝；x=28 为单像素细笔画
        pixels.set(dark, (28 * width + 28) * 4);

        const repaired = inpaintTextRegions(pixels, width, height, [{text: 'Auto', bbox: {x0: 30, y0: 20, x1: 80, y1: 36}}]);
        expect(pixelAt(repaired, width, 55, 28)).toEqual([255, 255, 255, 255]);
        for (const [cx, cy] of rightChevron) expect(pixelAt(repaired, width, cx, cy)).toEqual([40, 40, 40, 255]);
        expect(pixelAt(repaired, width, 28, 28)).toEqual([40, 40, 40, 255]);

        // 2. 1x 窄双字绿色胶囊按钮（宽 10px < 16px）贴边修补零白缺口
        const pillW = 80, pillH = 50;
        const green: readonly [number, number, number, number] = [0, 174, 66, 255];
        const narrow = makeImage(pillW, pillH, white);
        fillRect(narrow, pillW, 24, 18, 56, 30, green);
        fillRect(narrow, pillW, 36, 21, 44, 27, white);
        const narrowRepaired = inpaintTextRegions(narrow, pillW, pillH, [{text: 'OK', bbox: {x0: 35, y0: 18, x1: 45, y1: 30}}]);
        for (let y = 18; y < 30; y++) {
            for (let x = 24; x < 56; x++) expect(pixelAt(narrowRepaired, pillW, x, y)).toEqual([0, 174, 66, 255]);
        }
    });

    it('兄弟字号协调禁止传递高度链漂移压扁大标题，并对大页有界提前退出', () => {
        // 传递链 20px -> 17px -> 14.5px -> 12.2px：相邻比均 <= 1.2，但首尾 20/12.2 = 1.64 > 1.2，大标题不得被拖进小字组
        const chain = harmonizeImageSiblingFontSizes([
            {bbox: {x0: 20, y0: 10, x1: 140, y1: 30}, fontSize: 20, effectiveFontSize: 20},
            {bbox: {x0: 20, y0: 36, x1: 140, y1: 53}, fontSize: 17, effectiveFontSize: 17},
            {bbox: {x0: 20, y0: 59, x1: 140, y1: 73.5}, fontSize: 14.5, effectiveFontSize: 14.5},
            {bbox: {x0: 20, y0: 79, x1: 140, y1: 91.2}, fontSize: 12.2, effectiveFontSize: 12.2},
        ]);
        expect(chain[0]).toBeGreaterThanOrEqual(17);

        // 超出 512 项上限与超出 65536 次比较上限均安全返回原字号
        const tooMany = Array.from({length: 513}, (_, i) => ({
            bbox: {x0: 10, y0: i * 20, x1: 80, y1: i * 20 + 16}, fontSize: i === 0 ? 12 : 20,
        }));
        expect(harmonizeImageSiblingFontSizes(tooMany)).toEqual(tooMany.map(item => item.fontSize));

        const capCompare = Array.from({length: 400}, (_, i) => ({
            bbox: {x0: 10 + (i % 20) * 60, y0: Math.floor(i / 20) * 30, x1: 50 + (i % 20) * 60, y1: Math.floor(i / 20) * 30 + 16},
            fontSize: i === 0 ? 12 : 20,
        }));
        expect(harmonizeImageSiblingFontSizes(capCompare)).toEqual(capCompare.map(item => item.fontSize));
    });

    it('单行非 Arial UI 字体宽比落在 1.12..1.28 时采用实测墨高，兄弟 UI 标签协调字号并保留大标题', () => {
        const ctx = {
            font: '', textAlign: 'left', textBaseline: 'alphabetic', direction: 'ltr',
            save: vi.fn(), restore: vi.fn(),
            measureText: vi.fn(() => ({
                width: 400, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 400,
                actualBoundingBoxAscent: 75, actualBoundingBoxDescent: 0,
            })),
        };
        // 实测墨迹 92×15：byWidth = 92/400*100 = 23, byHeight = 15/75*100 = 20 -> ratio = 1.15 (在 1.12..1.28 之间)
        const line: ImageTextRegion = {text: 'Auto', fontSize: 28, bbox: {x0: 10, y0: 10, x1: 120, y1: 38}};
        expect(getImageSourceInkFontSize(ctx as never, line, [{x0: 16, y0: 16, x1: 108, y1: 31}])).toBeCloseTo(20, 6);

        // 兄弟行协调：Auto / Customize 向同栏 Same as Global Plate Type 对齐，标题 Plate Settings 高度 > 1.28x 保持原字号
        const harmonized = harmonizeImageSiblingFontSizes([
            {bbox: {x0: 20, y0: 10, x1: 180, y1: 38}, fontSize: 24, effectiveFontSize: 24}, // Plate Settings (h=28)
            {bbox: {x0: 200, y0: 60, x1: 380, y1: 78}, fontSize: 21.6, effectiveFontSize: 13.5}, // Same as Global Plate Type (h=18)
            {bbox: {x0: 200, y0: 95, x1: 270, y1: 113}, fontSize: 21.6, effectiveFontSize: 21.6}, // Auto (h=18)
            {bbox: {x0: 200, y0: 130, x1: 295, y1: 148}, fontSize: 21.6, effectiveFontSize: 21.6}, // Customize (h=18)
        ]);
        expect(harmonized[0]).toBe(24);
        expect(harmonized[1]).toBeCloseTo(13.5 * 1.12, 4);
        expect(harmonized[2]).toBeCloseTo(13.5 * 1.12, 4);
        expect(harmonized[3]).toBeCloseTo(13.5 * 1.12, 4);
    });

    it('drawTranslatedImageText 在饱和绿底无显式前景时仍选白字且局部采样不翻黑', async () => {
        const {drawTranslatedImageText: realDraw} = await vi.importActual<typeof import('@/src/features/image-translation/services/rendering')>(
            '@/src/features/image-translation/services/rendering',
        );
        const width = 120, height = 50;
        const pixels = makeImage(width, height, [0, 174, 66, 255]);
        const fillStyles: string[] = [];
        const ctx: Record<string, unknown> = {
            font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: 'round',
            textAlign: 'left', textBaseline: 'alphabetic', direction: 'ltr',
            save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), transform: vi.fn(),
            measureText: vi.fn(() => ({
                width: 28, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 28,
                actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2,
            })),
            strokeText: vi.fn(),
            fillText: vi.fn(() => fillStyles.push(ctx.fillStyle as string)),
        };
        realDraw(
            ctx as unknown as CanvasRenderingContext2D,
            '确定', 30, 10, 60, 30, 'rgb(0,174,66)', 14, 'center',
            {lines: ['确定'], fontSize: 14, lineHeight: 16},
            undefined, undefined, undefined, undefined,
            {pixels, width, height, remaining: 8192},
        );
        expect(fillStyles).toEqual(['#ffffff']);
    });
});

describe('Offscreen 端到端 UI 截图编排：guardOnly 夹紧、胶囊居中、兄弟字号与脏矩形上传', () => {
    const sendMessage = vi.fn();
    let activePixels: Uint8ClampedArray;
    let activeWidth = 400;
    let activeHeight = 300;
    let lastCanvas: {
        width: number;
        height: number;
        lang: string;
        getContext: ReturnType<typeof vi.fn>;
        context: {
            font: string;
            textAlign: string;
            textBaseline: string;
            save: ReturnType<typeof vi.fn>;
            restore: ReturnType<typeof vi.fn>;
            measureText: ReturnType<typeof vi.fn>;
            drawImage: ReturnType<typeof vi.fn>;
            getImageData: ReturnType<typeof vi.fn>;
            putImageData: ReturnType<typeof vi.fn>;
        };
    };

    class MockImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        width = activeWidth;
        height = activeHeight;
        naturalWidth = activeWidth;
        naturalHeight = activeHeight;
        private _src = '';
        get src() { return this._src; }
        set src(value: string) {
            this._src = value;
            if (value) queueMicrotask(() => this.onload?.());
        }
    }

    beforeEach(() => {
        vi.resetAllMocks();
        mocks.encode.mockResolvedValue('data:image/png;base64,ui');
        vi.stubGlobal('Image', MockImage);
        vi.stubGlobal('chrome', {runtime: {sendMessage}});
        vi.stubGlobal('document', {
            createElement: vi.fn(() => {
                const context = {
                    font: '', textAlign: 'left', textBaseline: 'alphabetic',
                    save: vi.fn(), restore: vi.fn(),
                    measureText: vi.fn((text: string) => {
                        const size = Number(/^400 ([\d.e+-]+)px/u.exec(context.font)?.[1] ?? 12);
                        const w = text.length * size * 0.85;
                        const middle = context.textBaseline === 'middle';
                        return {
                            width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
                            actualBoundingBoxAscent: size * (middle ? 0.45 : 0.75),
                            actualBoundingBoxDescent: size * (middle ? 0.45 : 0.15),
                        };
                    }),
                    drawImage: vi.fn(),
                    getImageData: vi.fn(() => ({data: activePixels})),
                    putImageData: vi.fn(),
                };
                lastCanvas = {
                    width: 0, height: 0, lang: '',
                    getContext: vi.fn(() => context),
                    context,
                };
                return lastCanvas;
            }),
        });
    });

    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('Layer 紧邻 guardOnly("2") 时仅夹紧扩边而不丢弃，同时绿色 OK 居中保白、Auto 字号协调且走局部脏矩形上传', async () => {
        activeWidth = 420;
        activeHeight = 280;
        const white: readonly [number, number, number, number] = [255, 255, 255, 255];
        const green: readonly [number, number, number, number] = [0, 174, 66, 255];
        const dark: readonly [number, number, number, number] = [30, 30, 30, 255];
        activePixels = makeImage(activeWidth, activeHeight, white);

        // 绿色 OK 按钮 [300..380, 220..248)，白字 OK 在 [328..352, 227..241)
        fillRect(activePixels, activeWidth, 300, 220, 380, 248, green);
        fillRect(activePixels, activeWidth, 330, 229, 350, 239, white);

        // Layer [20..54, 40..56) 与 guardOnly("2") [57..68, 40..56)：原框分离（54 < 55），仅扩边碰撞
        fillRect(activePixels, activeWidth, 24, 43, 50, 53, dark);
        fillRect(activePixels, activeWidth, 58, 43, 66, 53, [20, 20, 20, 255]);

        // 同栏 UI 兄弟标签：Same as Global Plate Type 与 Auto
        fillRect(activePixels, activeWidth, 184, 83, 330, 93, dark);
        fillRect(activePixels, activeWidth, 184, 118, 220, 128, dark);

        const recognized: ImageTextRegion[] = [
            {text: 'Layer', bbox: {x0: 20, y0: 40, x1: 54, y1: 56}, fontSize: 16},
            {text: '', bbox: {x0: 57, y0: 40, x1: 68, y1: 56}, guardOnly: true},
            {text: 'Same as Global Plate Type', bbox: {x0: 180, y0: 80, x1: 340, y1: 98}, fontSize: 18},
            {text: 'Auto', bbox: {x0: 180, y0: 115, x1: 235, y1: 133}, fontSize: 18},
            {text: 'OK', bbox: {x0: 328, y0: 227, x1: 352, y1: 241}, fontSize: 14},
        ];
        mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message, callback) => callback(
            message.type === 'fluentReadImageTranslateTexts'
                ? {success: true, translations: ['图层', '与全局打印板类型完全相同', '自动', '确定']}
                : undefined,
        ));

        const result = await translateImageInOffscreen('ui-dialog', 'en', 'Dialog', undefined, 'ui-dialog', false, 'paddle');

        // 1. Layer 未被丢弃，且 "2" 的像素完好无损
        const layerLine = result.lines.find(line => line.sourceText === 'Layer');
        expect(layerLine).toMatchObject({text: '图层'});
        expect(layerLine?.renderSkipped).toBeUndefined();
        expect(pixelAt(activePixels, activeWidth, 60, 48)).toEqual([20, 20, 20, 255]);

        // Layer 绘制框右边界被夹紧在 protectedBox.x0 (55) 之前，绝不覆盖 "2"
        const layerCall = mocks.draw.mock.calls.find(call => call[1] === '图层')!;
        expect(layerCall[2] + layerCall[4]).toBeLessThanOrEqual(54);

        // 2. 绿色 OK 按钮保留白字且自动居中
        const okCall = mocks.draw.mock.calls.find(call => call[1] === '确定')!;
        expect(okCall[8]).toBe('center');
        expect(okCall[10]).toBe('rgb(255,255,255)');
        expect(pixelAt(activePixels, activeWidth, 340, 234)).toEqual([0, 174, 66, 255]);

        // 3. Auto 字号被同栏兄弟 Same as Global Plate Type 协调下压，不再按 21.6px 放大
        const autoCall = mocks.draw.mock.calls.find(call => call[1] === '自动')!;
        expect(autoCall[7]).toBeLessThan(18);

        // 4. willReadFrequently 开启，且稀疏 UI 图使用 7 参数局部脏矩形 putImageData 上传
        expect(lastCanvas.getContext).toHaveBeenCalledWith('2d', {willReadFrequently: true});
        expect(lastCanvas.context.putImageData.mock.calls.length).toBeGreaterThanOrEqual(3);
        for (const call of lastCanvas.context.putImageData.mock.calls) {
            expect(call).toHaveLength(7);
        }
        expect(getInpaintDirtyRects(recognized.filter(r => !r.guardOnly), activeWidth, activeHeight).length).toBeGreaterThanOrEqual(3);
    });

    it('半透明保护图同时启用 maskClamps 保护相邻数字，且紧凑表格表头紧邻 SI 数值（4.87 m）时夹紧而不丢弃', async () => {
        activeWidth = 320;
        activeHeight = 160;
        const darkBg: readonly [number, number, number, number] = [34, 38, 46, 255];
        const lightInk: readonly [number, number, number, number] = [235, 238, 245, 255];
        const siInk: readonly [number, number, number, number] = [200, 220, 240, 255];
        activePixels = makeImage(activeWidth, activeHeight, darkBg);

        // 1. 紧凑表格表头 Model [20..76, 20..34) 位于高置信 SI 数值 "4.87 m" [20..76, 38..52) 上方 4px（仅扩边碰撞，原框不相交）
        fillRect(activePixels, activeWidth, 24, 23, 72, 31, lightInk);
        fillRect(activePixels, activeWidth, 24, 41, 72, 49, siInk);

        // 2. 带透明孔的区域 Layer [140..210, 40..64) 紧邻 guardOnly("2") [213..228, 40..64)
        fillRect(activePixels, activeWidth, 144, 46, 172, 58, lightInk);
        fillRect(activePixels, activeWidth, 215, 46, 226, 58, siInk);
        // 在 Layer 绘字范围内放置低 alpha 孔，激活 alpha protection 路径同时验证 activeClamps 透传给 inpaintTextRegions
        activePixels.set([17, 53, 191, 96], (52 * activeWidth + 158) * 4);

        const recognized: ImageTextRegion[] = [
            {text: 'Model', bbox: {x0: 20, y0: 20, x1: 76, y1: 34}, fontSize: 14},
            {text: '4.87 m', bbox: {x0: 20, y0: 38, x1: 76, y1: 52}, fontSize: 14},
            {text: 'Layer', bbox: {x0: 140, y0: 40, x1: 210, y1: 64}, fontSize: 14},
            {text: '', bbox: {x0: 213, y0: 40, x1: 228, y1: 64}, guardOnly: true},
        ];
        mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message, callback) => callback(
            message.type === 'fluentReadImageTranslateTexts'
                ? {success: true, translations: ['模型', '层']}
                : undefined,
        ));

        const result = await translateImageInOffscreen('si-and-alpha-clamp', 'en', 'Slicing', undefined, 'si-and-alpha-clamp', false, 'paddle');

        // Model 未因相邻 SI 数值 "4.87 m" 的扩边碰撞被丢弃，且 "4.87 m" 原像素与保护边界完好
        const modelLine = result.lines.find(line => line.sourceText === 'Model');
        expect(modelLine).toMatchObject({text: '模型'});
        expect(modelLine?.renderSkipped).toBeUndefined();
        const modelDraw = mocks.draw.mock.calls.find(call => call[1] === '模型')!;
        expect(modelDraw[3] + modelDraw[5]).toBeLessThanOrEqual(35);
        expect(pixelAt(activePixels, activeWidth, 40, 45)).toEqual([200, 220, 240, 255]);

        // 带 alpha 保护的 Layer 既保留低 alpha 孔，又通过 activeClamps 不擦碰相邻 "2"
        const layerLine = result.lines.find(line => line.sourceText === 'Layer');
        expect(layerLine).toMatchObject({text: '层'});
        expect(layerLine?.renderSkipped).toBeUndefined();
        expect(pixelAt(activePixels, activeWidth, 158, 52)).toEqual([17, 53, 191, 96]);
        expect(pixelAt(activePixels, activeWidth, 218, 52)).toEqual([200, 220, 240, 255]);
    });
});
