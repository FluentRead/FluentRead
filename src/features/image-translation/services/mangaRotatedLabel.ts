/**
 * @file src/features/image-translation/services/mangaRotatedLabel.ts
 * 文件职责：复核漫画和普通图片中被长书脊框包住的旋转小字，确定原图上的实际文字范围与阅读方向。
 * 主要内容：从同帧原图限定深色连续带及紧凑的亮色字迹，在原检测框内比较两个直角方向的 OCR，再把可信的独立行框映回原图。无法消除方向或范围歧义时保留粗框原图。
 * 模块边界：只处理像素、坐标与 OCR 结果。推理和裁图由调用方提供，不直接运行模型、翻译或修改图片。
 */
import type {MangaOcrItem} from './mangaRegions';
import {numericProtection} from './mangaNumeric';

type Box = MangaOcrItem['box'];
export type MangaLabelTurn = NonNullable<MangaOcrItem['quarterTurn']>;
export const rotatedLabelPadding = {x: 20, y: 32};
const MAX_PARENT_PIXELS = 131_072;
const MAX_PAGE_PIXELS = MAX_PARENT_PIXELS * 4;

function insideImage(box: Box, width: number, height: number): boolean {
    return [box.x, box.y, box.width, box.height].every(Number.isSafeInteger)
        && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
        && box.x + box.width <= width && box.y + box.height <= height;
}

export function isMangaRotatedLabelParent(box: Box, width: number, height: number): boolean {
    return insideImage(box, width, height) && box.width >= 24 && box.width <= 128
        && box.height >= Math.max(256, 4 * box.width) && box.width * box.height <= MAX_PARENT_PIXELS;
}

function overlap(a: Box, b: Box): number {
    return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function sameParent(a: Box, b: Box): boolean {
    return overlap(a, b) >= Math.max(a.width * a.height, b.width * b.height) * .8;
}

function luma(pixels: Uint8ClampedArray, offset: number): number {
    return (77 * pixels[offset] + 150 * pixels[offset + 1] + 29 * pixels[offset + 2]) / 256;
}

/** 连续暗带既排除白底长竖列，也让检测框边缘的纸面亮边不能充当字迹。 */
function observeLabelInk(pixels: Uint8ClampedArray, width: number, parent: Box): Box | undefined {
    let left = 0, darkWidth = 0, run = 0;
    for (let col = 0; col < parent.width; col++) {
        let dark = 0;
        for (let row = 0; row < parent.height; row++) {
            const offset = ((parent.y + row) * width + parent.x + col) * 4;
            if (pixels[offset + 3] !== 255) return;
            if (luma(pixels, offset) <= 108) dark++;
        }
        run = dark >= parent.height * .8 ? run + 1 : 0;
        if (run > darkWidth) { left = col - run + 1; darkWidth = run; }
    }
    if (darkWidth < Math.max(18, parent.width * .25)) return;
    const inset = Math.max(3, Math.floor(darkWidth * .13));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, area = 0;
    for (let row = 8; row < parent.height - 8; row++) {
        let first = Infinity, last = -Infinity, count = 0;
        for (let col = left + inset; col < left + darkWidth - inset; col++) {
            if (luma(pixels, ((parent.y + row) * width + parent.x + col) * 4) < 190) continue;
            first = Math.min(first, col); last = col; count++;
        }
        if (count < 2) continue;
        x0 = Math.min(x0, first); x1 = Math.max(x1, last + 1);
        y0 = Math.min(y0, row); y1 = row + 1; area += count;
    }
    const w = x1 - x0, h = y1 - y0;
    if (area < 48 || w < 7 || h < Math.max(26, w * 1.5) || h > Math.min(224, parent.height / 2)
        || area / (w * h) > .8) return;
    return {x: parent.x + x0, y: parent.y + y0, width: w, height: h};
}

function readingsForTurn(parent: Box, ink: Box, turn: MangaLabelTurn, items: readonly MangaOcrItem[]): MangaOcrItem[] {
    return items.flatMap(item => {
        const text = item.text.trim();
        if (!Number.isFinite(item.confidence) || item.confidence < .65 || item.confidence > 1 || !text || text.length > 64) return [];
        const b = item.box, u = b.x - rotatedLabelPadding.x, v = b.y - rotatedLabelPadding.y;
        if (!insideImage({x: u, y: v, width: b.width, height: b.height}, parent.height, parent.width)) return [];
        const mapped = turn === 1
            ? {x: parent.x + v, y: parent.y + parent.height - u - b.width, width: b.height, height: b.width}
            : {x: parent.x + parent.width - v - b.height, y: parent.y + u, width: b.height, height: b.width};
        if (overlap(ink, mapped) !== ink.width * ink.height || mapped.width > ink.width + 22 || mapped.height > ink.height + 34) return [];
        return [{...item, text, box: mapped, quarterTurn: turn}];
    });
}

function isLatinLabel(text:string):boolean {
    const compact=text.replace(/[^a-z0-9]/giu,'');
    return compact.length>=4&&compact.length<=32&&/[a-z]{3}/iu.test(text)
        &&/^[a-z0-9][a-z0-9 .,'’&()!?:\-]*$/iu.test(text);
}

/** 反向识别相近时不猜方向。只替换能追溯到长父框的粗结果，其他物理行和数值证据保留。 */
export async function recoverMangaRotatedLabels(
    pixels: Uint8ClampedArray, width: number, height: number, parents: readonly Box[],
    results: readonly MangaOcrItem[], protectedItems: readonly MangaOcrItem[],
    recognizeBothTurns: (parent: Box) => Promise<readonly [readonly MangaOcrItem[], readonly MangaOcrItem[]]>,
    checkActive: () => void,
): Promise<MangaOcrItem[]> {
    const output = [...results], tried: Box[] = [];
    if (!parents.length || pixels.length !== width * height * 4) return output;
    let pixelBudget = MAX_PAGE_PIXELS;
    for (const parent of parents) {
        checkActive();
        if (tried.length === 2) break;
        if (!isMangaRotatedLabelParent(parent, width, height) || tried.some(previous => sameParent(parent, previous))) continue;
        pixelBudget -= parent.width * parent.height;
        if (pixelBudget < 0) break;
        const ink = observeLabelInk(pixels, width, parent);
        if (!ink) continue;
        const coarse = output.filter(item => sameParent(parent, item.box) && !numericProtection(item.text));
        const collides = (box: Box) => protectedItems.some(item => overlap(box, item.box) > 0)
            || output.some(item => !coarse.includes(item) && overlap(box, item.box) > 0);
        tried.push(parent);
        const [clockwise, counterclockwise] = collides(ink) ? [[], []] : await recognizeBothTurns(parent);
        checkActive();
        const [best, alternative] = [...readingsForTurn(parent, ink, 1, clockwise), ...readingsForTurn(parent, ink, -1, counterclockwise)]
            .sort((a, b) => b.confidence - a.confidence);
        if (best && best.confidence >= .97 && best.confidence - (alternative?.confidence ?? 0) >= .12
            && isLatinLabel(best.text) && !collides(best.box)) {
            for (const original of coarse) output.splice(output.indexOf(original), 1);
            output.push(best);
        } else {
            for (const original of coarse) output[output.indexOf(original)] = {...original, preserveSource: true};
        }
    }
    return output;
}
