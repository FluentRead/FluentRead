/**
 * @file src/features/image-translation/services/alphaMatteRenderer.ts
 * 文件职责：提供图片翻译几何边界计算、透明通道保护与全页救援渲染、可选分割辅助及漫画局部图块并发编码。
 * 主要内容：计算单图绘制与采样夹紧框、执行透明重排字形度量预检、在严格 alpha 准入失败后执行完整 RGBA 救援上传、过滤视口外漫画段落并使用复用画布并发编码漫画图块。
 * 模块边界：仅承担几何、Alpha 救援与图块编码子阶段，不负责 OCR 识别、文本批译或整体图片重绘编排。
 */
import type {OcrLine} from '@/src/features/image-translation/core';
import type {ImageViewport} from '@/src/shared/image/types';
import {getInpaintDirtyRects, imageMaskBoxes} from './inpainting';
import {
    proposeImageMattePage,
    getImageMatteProposalDrawings,
    authorizeImageMatteProposal,
    discardImageMatteProposal,
    applyImageMattePage,
} from './imageMattePage';
import type {ImageDetectionSupport} from './imageDetectionEvidence';
import {createImageTextSegmentationSupport, type ImageTextSegmentationSupport} from './imageTextSegmentation';
import {mangaInferenceClient} from './mangaInferenceClient';
import {
    drawTranslatedImageText,
    getImageTextDirection,
    layoutImageTranslationText,
    type ImageTranslationTextLayout,
} from './rendering';
import {IMAGE_TEXT_FONT} from './imageTextFont';
import type {ImageTextRegion} from '../paragraphs';
import {
    ImageAlphaProtectionUnavailableError,
    MangaAlphaProtectionLimitError,
    mangaAlphaClearRects,
} from './mangaAlphaProtection';
import {encodeImageCanvas} from './imageEncoding';
import {mangaPatchRects, type MangaPatchPacket} from '../mangaPatchResult';
import {checkImageCancellation, throwIfImageOperationAborted} from './offscreenImageIo';

export type OffscreenImageTranslationLine = OcrLine & {
    backgroundColor: string;
    sourceText?: string;
    renderSkipped?: true;
    numericUncertain?: true;
};

export interface OffscreenImageTranslationResult {
    image: string;
    imageUnchanged?: true;
    retryWhenSegmentationReady?: true;
    mangaPatches?: MangaPatchPacket;
    lines: OffscreenImageTranslationLine[];
}

const PATCH_ENCODE_CONCURRENCY = 4;

/** 单图译文裁剪框既决定绘制范围，也用于保护附近保留的原文。 */
export function imageDrawBounds(line: ImageTextRegion, width: number, height: number): OcrLine['bbox'] {
    if (line.quarterTurn) return line.bbox;
    const sourceHeight = line.fontSize ?? line.bbox.y1 - line.bbox.y0;
    const paddingX = line.vertical ? 3 : 2;
    const paddingY = line.vertical ? 2 : Math.max(2, Math.round(sourceHeight * 0.18));
    const left = Math.max(0, line.bbox.x0 - paddingX), top = Math.max(0, line.bbox.y0 - paddingY);
    const drawWidth = Math.max(1, Math.min(width - left, line.bbox.x1 - line.bbox.x0 + paddingX * 2));
    const drawHeight = Math.max(1, Math.min(height - top, line.bbox.y1 - line.bbox.y0 + paddingY * 2));
    return {x0: left, y0: top, x1: left + drawWidth, y1: top + drawHeight};
}

export function boxesIntersect(a: OcrLine['bbox'], b: OcrLine['bbox']): boolean {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** 仅当原框与保护框分离时，把扩边面向保护框的一侧夹紧到保护框外 1px（同时完整保留原框）。 */
export function clampBoxAwayFromProtected(box: OcrLine['bbox'], raw: OcrLine['bbox'], protectedBox: OcrLine['bbox']): OcrLine['bbox'] {
    let {x0, y0, x1, y1} = box;
    if (raw.x1 <= protectedBox.x0) x1 = Math.min(x1, Math.max(raw.x1, protectedBox.x0 - 1));
    if (raw.x0 >= protectedBox.x1) x0 = Math.max(x0, Math.min(raw.x0, protectedBox.x1 + 1));
    if (raw.y1 <= protectedBox.y0) y1 = Math.min(y1, Math.max(raw.y1, protectedBox.y0 - 1));
    if (raw.y0 >= protectedBox.y1) y0 = Math.max(y0, Math.min(raw.y0, protectedBox.y1 + 1));
    return {x0, y0, x1, y1};
}

/** 透明度证明覆盖修补的一像素采样上下文及绘字足迹；不扩张实际擦除或绘字范围。 */
export function imageAlphaSamplingAndWriteBoxes(
    line: ImageTextRegion,
    width: number,
    height: number,
    drawOverride?: OcrLine['bbox'],
    maskClamp?: OcrLine['bbox'],
): OcrLine['bbox'][] {
    const draw = drawOverride ?? imageDrawBounds(line, width, height);
    if (![draw.x0, draw.y0, draw.x1, draw.y1].every(Number.isFinite)) throw new ImageAlphaProtectionUnavailableError();
    const box = {
        x0: Math.max(0, Math.min(width, Math.floor(draw.x0))),
        y0: Math.max(0, Math.min(height, Math.floor(draw.y0))),
        x1: Math.max(0, Math.min(width, Math.ceil(draw.x1))),
        y1: Math.max(0, Math.min(height, Math.ceil(draw.y1))),
    };
    if (box.x1 <= box.x0 || box.y1 <= box.y0) throw new ImageAlphaProtectionUnavailableError();
    // 完整包含的修补框外周只是写入并集内部，不能把内部孔误当成未知外部边界。
    const masks = maskClamp ? getInpaintDirtyRects([line], width, height, new Map([[line, maskClamp]])) : imageMaskBoxes(line, width, height);
    const repair = masks.map(mask => ({
        x0: Math.max(0, mask.x0 - 1),
        y0: Math.max(0, mask.y0 - 1),
        x1: Math.min(width, mask.x1 + 1),
        y1: Math.min(height, mask.y1 + 1),
    })).filter(mask =>
        box.x0 > mask.x0 || box.y0 > mask.y0 || box.x1 < mask.x1 || box.y1 < mask.y1);
    return [...repair, box];
}

/** 验证透明重排的单个框；不能把非空矩形或完整元数据当作完整字形的证明。 */
export function prepareImageAlphaTextLayout(
    context: CanvasRenderingContext2D,
    text: string,
    bounds: OcrLine['bbox'],
    maxFontSize: number,
    textAlign: 'left' | 'center' | 'right',
    budget?: {remaining: number; characters: number},
): ImageTranslationTextLayout | undefined {
    const width = bounds.x1 - bounds.x0, height = bounds.y1 - bounds.y0;
    const paddingX = Math.min(2, width * .03), paddingY = Math.min(1, height * .05);
    const contentWidth = width - paddingX * 2, contentHeight = height - paddingY * 2;
    context.save();
    try {
        context.direction = getImageTextDirection(text);
        // 词拆分及每次原生度量均预付UTF-16工作量，不能以巨长译文绕过调用次数上限。
        if (budget && (--budget.remaining < 0 || (budget.characters -= text.length) < 0)) throw new MangaAlphaProtectionLimitError();
        const layout = layoutImageTranslationText(text, contentWidth, contentHeight, (line, size) => {
            if (budget && (--budget.remaining < 0 || (budget.characters -= line.length) < 0)) throw new MangaAlphaProtectionLimitError();
            context.font = '400 ' + size + 'px ' + IMAGE_TEXT_FONT;
            return context.measureText(line).width;
        }, maxFontSize);
        if (!layout.lines.length || !Number.isFinite(layout.fontSize) || layout.fontSize <= 0
            || !Number.isFinite(layout.lineHeight) || layout.lines.length * layout.lineHeight > contentHeight) return;
        context.font = '400 ' + layout.fontSize + 'px ' + IMAGE_TEXT_FONT;
        context.textAlign = textAlign;
        context.textBaseline = 'middle';
        // 原描边半径另加一个像素保守抗锯齿余量；不通过时不尝试裁字或换小段发布。
        const bleed = Math.max(.35, layout.fontSize * .06) / 2 + 1;
        const first = textAlign === 'center' ? (height - layout.lineHeight * layout.lines.length) / 2 + layout.lineHeight / 2 : paddingY + layout.lineHeight / 2;
        const x = textAlign === 'left' ? paddingX : textAlign === 'right' ? width - paddingX : width / 2;
        for (let index = 0; index < layout.lines.length; index++) {
            if (!layout.lines[index].trim()) continue;
            if (budget && (--budget.remaining < 0 || (budget.characters -= layout.lines[index].length) < 0)) throw new MangaAlphaProtectionLimitError();
            const metrics = context.measureText(layout.lines[index]), y = first + index * layout.lineHeight;
            if (![metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent].every(Number.isFinite)
                || metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight <= 0 || metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent <= 0
                || metrics.width > contentWidth || x - metrics.actualBoundingBoxLeft - bleed < 0
                || x + metrics.actualBoundingBoxRight + bleed > width || y - metrics.actualBoundingBoxAscent - bleed < 0
                || y + metrics.actualBoundingBoxDescent + bleed > height) return;
        }
        return layout;
    } finally { context.restore(); }
}

/** 已知 alpha 准入失败仍返回完整文本，原子保留源位图；未知失败不使用此结果。 */
export function imageAlphaUnchanged(lines: OffscreenImageTranslationLine[]): OffscreenImageTranslationResult {
    return {
        image: '',
        imageUnchanged: true,
        lines: lines.map(line => ({
            ...line,
            ...(line.text !== line.sourceText ? {renderSkipped: true as const} : {}),
        })),
    };
}

export async function segmentImageMatte(
    sourcePixels: ImageData,
    width: number,
    height: number,
    signal?: AbortSignal,
): Promise<ImageTextSegmentationSupport | undefined> {
    const ready = await mangaInferenceClient.prepareTextSegmentation(signal);
    await checkImageCancellation(signal);
    if (!ready) return;
    const seg = await mangaInferenceClient.segmentText(() => {
        throwIfImageOperationAborted(signal);
        return {pixels: sourcePixels.data, width, height};
    }, signal);
    throwIfImageOperationAborted(signal);
    return createImageTextSegmentationSupport(seg, width, height);
}

/** 严格 alpha 准入失败时才尝试完整 RGBA 证明；全页预检通过前不更改像素或上传。 */
export async function renderImageMatteRescue(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    sourcePixels: ImageData,
    translated: ImageTextRegion[],
    retained: ImageTextRegion[],
    reading: OffscreenImageTranslationLine[],
    support: ImageDetectionSupport,
    signal?: AbortSignal,
): Promise<OffscreenImageTranslationResult | undefined> {
    if (translated.some(line => line.quarterTurn)) return;
    const proposal = proposeImageMattePage(sourcePixels.data, canvas.width, canvas.height, translated, retained, imageDrawBounds);
    if (!proposal) return;
    try {
        const view = getImageMatteProposalDrawings(proposal)!;
        let plan = authorizeImageMatteProposal(proposal, support);
        const drawing: Array<{line: ImageTextRegion; bounds: OcrLine['bbox']; prepared: ImageTranslationTextLayout; background: string}> = [];
        const layoutBudget = {remaining: 1_048_576}, measureBudget = {remaining: 8192, characters: 4_194_304};
        try {
            for (const item of view.drawings) {
                throwIfImageOperationAborted(signal);
                const available = mangaAlphaClearRects(view, item.bounds, layoutBudget).sort((a, b) =>
                    (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
                let chosen: {bounds: OcrLine['bbox']; prepared: ImageTranslationTextLayout} | undefined;
                const maxFontSize = item.line.vertical ? Infinity : (item.line.fontSize ?? item.line.bbox.y1 - item.line.bbox.y0) * 1.2;
                for (const bounds of available) {
                    const prepared = prepareImageAlphaTextLayout(context, item.line.text, bounds, maxFontSize, item.line.vertical ? 'center' : item.line.textAlign ?? 'left', measureBudget);
                    if (prepared) { chosen = {bounds, prepared}; break; }
                }
                if (!chosen) return;
                const [red, green, blue, alpha] = item.background;
                const background = alpha < 128 ? 'rgb(255,255,255)' : `rgba(${red},${green},${blue},${alpha / 255})`;
                drawing.push({line: item.line, ...chosen, background});
            }
        } catch (error) {
            if (!(error instanceof MangaAlphaProtectionLimitError)) throw error;
            return;
        }
        await checkImageCancellation(signal);
        if (!plan) {
            // 无缓存时不下载、不构造张量；所有颜色、归属与完整字形均已通过才准备可选会话。
            const segmentation = await segmentImageMatte(sourcePixels, canvas.width, canvas.height, signal);
            if (!segmentation) {
                return {...imageAlphaUnchanged(reading), retryWhenSegmentationReady: true};
            }
            try { plan = authorizeImageMatteProposal(proposal, segmentation); }
            finally { segmentation.dispose(); }
            if (!plan) return;
        }
        await checkImageCancellation(signal);
        applyImageMattePage(sourcePixels.data, canvas.width, canvas.height, plan);
        // 每个脏矩形仅含原墨迹，不让未修改的半透明图案经历整页读回后的再次量化。
        for (let index = 0; index < plan.uploads.length; index++) {
            if ((index & 127) === 0) await checkImageCancellation(signal);
            const box = plan.uploads[index];
            context.putImageData(sourcePixels, 0, 0, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
        }
        for (const item of drawing) {
            throwIfImageOperationAborted(signal);
            const b = item.bounds;
            drawTranslatedImageText(context, item.line.text, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, item.background,
                item.line.vertical ? Infinity : (item.line.fontSize ?? item.line.bbox.y1 - item.line.bbox.y0) * 1.2,
                item.line.vertical ? 'center' : item.line.textAlign ?? 'left', item.prepared);
        }
        await checkImageCancellation(signal);
        const image = await encodeImageCanvas(canvas, signal);
        throwIfImageOperationAborted(signal);
        return {image, lines: reading};
    } finally { discardImageMatteProposal(proposal); }
}

export function isValidBox(box: OcrLine['bbox'] | null | undefined): box is OcrLine['bbox'] {
    return !!box && Number.isFinite(box.x0) && Number.isFinite(box.y0)
        && Number.isFinite(box.x1) && Number.isFinite(box.y1) && box.x1 > box.x0 && box.y1 > box.y0;
}

/** 显示窗口只收窄新增气泡补绘；非法值不应退回整图补绘权限，也不改变正常译文清字。 */
export function mangaPlacementBounds(viewport: ImageViewport | undefined, width: number, height: number): OcrLine['bbox'] | null | undefined {
    if (viewport === undefined) return;
    if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) return null;
    const {x, y, width: w, height: h} = viewport;
    if (![x, y, w, h].every(Number.isSafeInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) return null;
    return {x0: x, y0: y, x1: x + w, y1: y + h};
}

function boxStrictlyOutsideViewport(box: OcrLine['bbox'] | null | undefined, viewport: OcrLine['bbox']): boolean {
    return isValidBox(box) && (box.x1 <= viewport.x0 || box.x0 >= viewport.x1 || box.y1 <= viewport.y0 || box.y0 >= viewport.y1);
}

/** 仅当整段及全部物理源框均严格落在可见窗口外时才降级为保护框，边界相交一律保留。 */
export function isRegionOutsideViewport(line: ImageTextRegion, viewport: OcrLine['bbox']): boolean {
    return boxStrictlyOutsideViewport(line.bbox, viewport)
        && (!line.sourceBoxes || line.sourceBoxes.every(box => boxStrictlyOutsideViewport(box, viewport)));
}

/** 使用至多 4 个复用临时画布并发编码漫画图块，保持原顺序、取消优先和异常全量清理。 */
export async function encodeMangaPatches(
    canvas: HTMLCanvasElement,
    rects: ReturnType<typeof mangaPatchRects>,
    signal?: AbortSignal,
): Promise<MangaPatchPacket['patches']> {
    const patches: MangaPatchPacket['patches'] = new Array(rects.length);
    const workerCount = Math.min(PATCH_ENCODE_CONCURRENCY, rects.length);
    let nextIndex = 0;
    let failed = false;
    const worker = async () => {
        const patchCanvas = document.createElement('canvas');
        try {
            const patchContext = patchCanvas.getContext('2d');
            if (!patchContext) throw new Error('浏览器不支持图片处理');
            while (!failed && nextIndex < rects.length) {
                throwIfImageOperationAborted(signal);
                const index = nextIndex++;
                const rect = rects[index];
                patchCanvas.width = rect.width;
                patchCanvas.height = rect.height;
                patchContext.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
                const image = await encodeImageCanvas(patchCanvas, signal);
                throwIfImageOperationAborted(signal);
                patches[index] = {...rect, image};
            }
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            patchCanvas.width = 0;
            patchCanvas.height = 0;
        }
    };
    const results = await Promise.allSettled(Array.from({length: workerCount}, worker));
    throwIfImageOperationAborted(signal);
    for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
    }
    return patches;
}
