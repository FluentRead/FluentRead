/**
 * @file src/features/image-translation/services/offscreenRuntime.ts
 * 后台选择的本地后端在加载图片前交给已有推理客户端，在串行任务边界生效。
 * 文件职责：在隔离 Offscreen 文档中编排图片重绘翻译、漫画局部修补及圈选文本识别主入口。
 * 主要内容：组合基础图像 I/O、Alpha 保护与全页救援渲染以及 OCR/修补运行时；将候选原文保护传播、漫画空白气泡补绘及普通图排版修补拆分为清晰阶段，保持原子回退与画布全量释放。
 * 模块边界：该运行时只在具备 Canvas/DOM 的 Offscreen 环境执行，不直接接收 browser.runtime 事件；图像加载/裁剪/消息 I/O 归 offscreenImageIo，透明保护几何与救援渲染归 alphaMatteRenderer。
 */
import {selectChangedTranslations, type OcrLine} from '@/src/features/image-translation/core';
import type {ImageViewport} from '@/src/shared/image/types';
import type {AreaTranslationSelection, AreaRecognitionResult} from '@/src/features/area-translation/protocol';
import {getInpaintDirtyRects, imageMaskBoxIntersects, inpaintTextRegions} from './inpainting';
import {
    proposeImageMattePage,
    getImageMatteProposalDrawings,
    authorizeImageMatteProposal,
    authorizeImageMatteDecorationFringe,
    authorizeImageMatteWithinExistingMasks,
    discardImageMatteProposal,
    applyImageMattePage,
} from './imageMattePage';
import {getImageDetectionEvidence, type ImageDetectionSupport} from './imageDetectionEvidence';
import {getImageParagraphGapEvidence} from './imageParagraphGapEvidence';
import {isSingleFrameImageData} from './imageDetectionSnapshot';
import type {ImageTextSegmentationSupport} from './imageTextSegmentation';
import {mangaInferenceClient} from './mangaInferenceClient';
import {recognizeImage} from './ocrRuntime';
import {
    getImageTextBackgroundColor,
    drawTranslatedImageText,
    canDrawTranslatedImageText,
    getImageSourceTextStyle,
    getImageSourceTypographyStyle,
    getImageSingleLineHeight,
    harmonizeImageSiblingFontSizes,
    type ImageTranslationTextLayout,
    type ImageTextMeasureBudget,
} from './rendering';
import {IMAGE_TEXT_FONT, mightNeedRareImageFont, prepareRareImageFont} from './imageTextFont';
import {observeImageSourceTypographyGeometry, type ImageSourceTypographyGeometry} from './sourceTypographyGeometry';
import {observeImageSourceAppearances, expandImageTextBounds} from './sourceAppearance';
import {detectImageSingleLineAlignment} from './sourceAlignment';
import {hasUncoveredImageInk} from './imageEraseCoverage';
import {observeImageMatteDecoration, type ImageMatteDecoration} from './imageMatteDecoration';
import {groupImageParagraphs, type ImageTextRegion} from '../paragraphs';
import {getAlignedImageLabelSlots} from '../labelContext';
import {mangaOcrRuntime} from './mangaOcr';
import {
    createMangaBlankLayoutBudget,
    drawMangaTranslations,
    planMangaBlankTranslation,
    sampleMangaBackgrounds,
} from './mangaRendering';
import {getMangaBubblePlacement} from './mangaBubblePlacement';
import {findMangaBlankSpaces} from './mangaBlankSpaces';
import {
    ImageAlphaProtectionUnavailableError,
    MangaAlphaProtectionLimitError,
    mangaAlphaClearRects,
    planMangaAlphaProtection,
    planMaskAlphaProtection,
} from './mangaAlphaProtection';
import {groupMangaOcrLines, type MangaRegion} from './mangaRegions';
import {numericEvidenceKey, numericProtection} from './mangaNumeric';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {mangaMaskBoxes, mangaMaskBoxIntersects, createMangaMaskFontResolver, mangaPatchRects} from '../mangaPatchResult';
import {getImageOcrEngine} from '../ocrLanguages';
import {
    checkImageCancellation,
    cropAreaInOffscreen,
    cropImage,
    loadImage,
    reportProgress,
    throwIfImageOperationAborted,
    translateImageTextsInExtension,
} from './offscreenImageIo';
import {
    boxesIntersect,
    clampBoxAwayFromProtected,
    encodeMangaPatches,
    imageAlphaSamplingAndWriteBoxes,
    imageAlphaUnchanged,
    imageDrawBounds,
    isRegionOutsideViewport,
    isValidBox,
    mangaPlacementBounds,
    prepareImageAlphaTextLayout,
    renderImageMatteRescue,
    segmentImageMatte,
    type OffscreenImageTranslationLine,
    type OffscreenImageTranslationResult,
} from './alphaMatteRenderer';

export {cropAreaInOffscreen, translateImageTextsInExtension};
export type {OffscreenImageTranslationLine, OffscreenImageTranslationResult};

interface CandidateEntry {
    index: number;
    original: ImageTextRegion;
    translated: ImageTextRegion;
    maskFont?: ReturnType<typeof createMangaMaskFontResolver>;
}

interface CandidateProtectionResult {
    candidates: CandidateEntry[];
    skipped: Set<number>;
    protectionExhausted: boolean;
    clampedDrawBounds: Map<ImageTextRegion, OcrLine['bbox']>;
    maskClamps: Map<ImageTextRegion, OcrLine['bbox']>;
}

async function resolveProtectedCandidates(
    lines: ImageTextRegion[],
    translations: string[],
    width: number,
    height: number,
    manga: boolean,
    targetLanguage: string | undefined,
    signal?: AbortSignal,
): Promise<CandidateProtectionResult> {
    const skipped = new Set<number>();
    let protectionExhausted = false;
    const candidates: CandidateEntry[] = [];
    const originals: ImageTextRegion[] = [];
    lines.forEach((line, index) => {
        const changed = line.guardOnly || numericProtection(line.text) ? [] : selectChangedTranslations([line], [translations[index]]);
        if (changed.length) candidates.push({index, original: line, translated: changed[0]});
        if (!changed.length || line.preserveSource) {
            originals.push(line);
            if (changed.length) skipped.add(index);
        }
    });
    const rotated = candidates.filter(candidate => candidate.original.quarterTurn && !skipped.has(candidate.index));
    if (rotated.length) {
        if (rotated.some(({translated}) => mightNeedRareImageFont(translated.text))) await prepareRareImageFont(signal);
        throwIfImageOperationAborted(signal);
        const scratch = document.createElement('canvas');
        try {
            scratch.width = scratch.height = 1;
            if (targetLanguage) scratch.lang = targetLanguage;
            const context = scratch.getContext('2d');
            if (!context) throw new Error('浏览器不支持图片处理');
            const budget = {remaining: 2048, characters: 262_144};
            for (const {index, original, translated} of rotated) {
                const b = original.bbox, {fontSize, orientation} = getImageSourceTextStyle(context, original);
                if (canDrawTranslatedImageText(budget, context, translated.text, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, '#000',
                    fontSize, 'center', undefined, undefined, undefined, undefined, orientation)) continue;
                skipped.add(index);
                originals.push(original);
            }
        } finally { scratch.width = scratch.height = 0; }
    }
    const clampedDrawBounds = new Map<ImageTextRegion, OcrLine['bbox']>();
    const maskClamps = new Map<ImageTextRegion, OcrLine['bbox']>();
    if (candidates.length && originals.length) {
        // 所有保留原文（含碰撞后未绘制的译文）都必须避开后续修补和排版。
        const protectedBoxes: Array<{box: OcrLine['bbox']; clampEligible: boolean}> = [];
        const seen = new Map<string, {box: OcrLine['bbox']; clampEligible: boolean}>();
        let work = 0, exhausted = false;
        const protect = async (line: ImageTextRegion) => {
            const sources = line.sourceBoxes ?? [];
            const isClampEligible = line.guardOnly === true || numericProtection(line.text);
            for (let index = -1; index < sources.length; index++) {
                const box = index < 0 ? line.bbox : sources[index];
                if (++work > 1_000_000 || !isValidBox(box)) { exhausted = true; return; }
                if ((work & 32767) === 0) await checkImageCancellation(signal);
                const rect = {
                    x0: Math.max(0, Math.floor(box.x0) - 2),
                    y0: Math.max(0, Math.floor(box.y0) - 2),
                    x1: Math.min(width, Math.ceil(box.x1) + 2),
                    y1: Math.min(height, Math.ceil(box.y1) + 2),
                };
                if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) continue;
                const key = `${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
                const existing = seen.get(key);
                if (!existing) {
                    if (protectedBoxes.length >= 8192) { exhausted = true; return; }
                    const entry = {box: rect, clampEligible: isClampEligible};
                    seen.set(key, entry);
                    protectedBoxes.push(entry);
                } else if (!isClampEligible) {
                    existing.clampEligible = false;
                }
            }
        };
        for (const line of originals) { await protect(line); if (exhausted) break; }
        // 对新保留的原文继续传播；只对尚未跳过的候选比较，达到预算时不绘制任何候选。
        for (let cursor = 0; cursor < protectedBoxes.length && !exhausted && skipped.size < candidates.length; cursor++) {
            const {box: protectedBox, clampEligible} = protectedBoxes[cursor];
            for (const candidate of candidates) {
                if (++work > 1_000_000) { exhausted = true; break; }
                if ((work & 32767) === 0) await checkImageCancellation(signal);
                if (skipped.has(candidate.index)) continue;
                const region = candidate.translated, box = region.bbox;
                if (++work > 1_000_000 || !isValidBox(box) || ((manga || region.fontSize !== undefined) && !Number.isFinite(region.fontSize))) { exhausted = true; break; }
                if ((work & 32767) === 0) await checkImageCancellation(signal);
                const drawBox = manga ? box : clampedDrawBounds.get(candidate.original) ?? imageDrawBounds(region, width, height);
                if (!isValidBox(drawBox)) { exhausted = true; break; }
                let hit = boxesIntersect(drawBox, protectedBox);
                const sources = region.sourceBoxes;
                const currentMaskClamp = maskClamps.get(region);
                for (let index = 0; !hit && index < (sources?.length ?? 1); index++) {
                    const source = sources ? sources[index] : box;
                    if (++work > 1_000_000 || !isValidBox(source)) { exhausted = true; break; }
                    if ((work & 32767) === 0) await checkImageCancellation(signal);
                    if (manga) {
                        hit = mangaMaskBoxIntersects(source, (candidate.maskFont ??= createMangaMaskFontResolver(region as MangaRegion))(source), width, height, protectedBox);
                    } else if (currentMaskClamp) {
                        const probe = {...region, sourceBoxes: [source]};
                        const clampedBoxes = getInpaintDirtyRects([probe], width, height, new Map([[probe, currentMaskClamp]]));
                        hit = clampedBoxes.some(clamped => boxesIntersect(clamped, protectedBox));
                    } else {
                        hit = imageMaskBoxIntersects(source, width, height, protectedBox);
                    }
                }
                if (hit && !manga && clampEligible) {
                    let rawUnion = box;
                    let invalidSource = false;
                    if (sources) {
                        for (const source of sources) {
                            if (!isValidBox(source)) { invalidSource = true; break; }
                            rawUnion = {
                                x0: Math.min(rawUnion.x0, source.x0), y0: Math.min(rawUnion.y0, source.y0),
                                x1: Math.max(rawUnion.x1, source.x1), y1: Math.max(rawUnion.y1, source.y1),
                            };
                        }
                    }
                    if (!invalidSource && !boxesIntersect(rawUnion, protectedBox)) {
                        clampedDrawBounds.set(candidate.original, clampBoxAwayFromProtected(drawBox, box, protectedBox));
                        const baseMask = currentMaskClamp ?? {x0: 0, y0: 0, x1: width, y1: height};
                        maskClamps.set(region, clampBoxAwayFromProtected(baseMask, rawUnion, protectedBox));
                        hit = false;
                    }
                }
                if (hit) { skipped.add(candidate.index); await protect(candidate.original); }
                if (exhausted) break;
            }
        }
        if (exhausted) {
            protectionExhausted = true;
            for (const candidate of candidates) skipped.add(candidate.index);
        }
    }
    return {candidates, skipped, protectionExhausted, clampedDrawBounds, maskClamps};
}

async function renderMangaTranslatedCanvas(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    sourcePixels: ImageData,
    lines: ImageTextRegion[],
    selected: CandidateEntry[],
    translatedLines: ImageTextRegion[],
    blankCandidates: Array<{candidate: CandidateEntry; owner: NonNullable<ReturnType<typeof getMangaBubblePlacement>>}>,
    readingLines: OffscreenImageTranslationLine[],
    placementImage: string | undefined,
    placementBounds: OcrLine['bbox'] | null | undefined,
    targetLanguage: string | undefined,
    requestId: string | undefined,
    signal?: AbortSignal,
): Promise<OffscreenImageTranslationResult> {
    const width = canvas.width, height = canvas.height;
    const backgrounds = translatedLines.length ? sampleMangaBackgrounds(sourcePixels.data, width, height, selected.map(candidate => candidate.original as MangaRegion), context) : [];
    if (targetLanguage) canvas.lang = targetLanguage;
    const placed: Array<{index: number; region: MangaRegion}> = [];
    if (blankCandidates.length) {
        const obstacles: OcrLine['bbox'][] = [], seen = new Set<string>();
        let valid = true;
        const add = (box: OcrLine['bbox'], margin = 0) => {
            // 原框已由未耗尽的保护阶段核对；清字框再次夹紧，完全位于图外的范围不参与补绘。
            const b = {
                x0: Math.max(0, Math.floor(box.x0) - margin), y0: Math.max(0, Math.floor(box.y0) - margin),
                x1: Math.min(width, Math.ceil(box.x1) + margin), y1: Math.min(height, Math.ceil(box.y1) + margin),
            };
            if (b.x1 <= b.x0 || b.y1 <= b.y0) return;
            const key = [b.x0, b.y0, b.x1, b.y1].join(',');
            if (seen.has(key)) return;
            if (obstacles.length >= 8192) { valid = false; return; }
            seen.add(key);
            obstacles.push(b);
        };
        if (placementBounds) {
            if (placementBounds.x0 > 0) add({x0: 0, y0: 0, x1: placementBounds.x0, y1: height});
            if (placementBounds.y0 > 0) add({x0: 0, y0: 0, x1: width, y1: placementBounds.y0});
            if (placementBounds.x1 < width) add({x0: placementBounds.x1, y0: 0, x1: width, y1: height});
            if (placementBounds.y1 < height) add({x0: 0, y0: placementBounds.y1, x1: width, y1: height});
        }
        // 保留所有源段、数值、源行清字余量与正常译文的范围；不能只排除这一次碰撞框。
        for (const line of lines) {
            add(line.bbox, 2);
            if (line.fontSize !== undefined) {
                if (!Number.isFinite(line.fontSize) || line.fontSize <= 0) { valid = false; break; }
                for (const box of mangaMaskBoxes(line as MangaRegion, width, height)) add(box);
            }
            if (!valid) break;
        }
        const budget = {remainingPixels: 2_000_000};
        const layoutBudget = createMangaBlankLayoutBudget();
        if (valid) for (const {candidate, owner} of blankCandidates) {
            await checkImageCancellation(signal);
            if (!getMangaBubblePlacement(candidate.original as MangaRegion, placementImage!, width, height)) continue;
            const spaces = findMangaBlankSpaces(sourcePixels.data, width, height, owner, obstacles, budget, () => throwIfImageOperationAborted(signal));
            const region = planMangaBlankTranslation(context, candidate.translated as MangaRegion, width, height, spaces, layoutBudget);
            if (!region) continue;
            // 下一个补绘仍须避开此处，原 skipped 集合和原文传播保持有效。
            placed.push({index: candidate.index, region});
            add(region.bbox, 2);
            if (!valid) break;
        }
    }
    const protection = translatedLines.length ? planMangaAlphaProtection(sourcePixels.data, width, height, translatedLines as MangaRegion[]) : undefined;
    const pixels = translatedLines.length ? await mangaInpaintingRuntime.repair(sourcePixels.data, width, height, translatedLines as MangaRegion[], signal,
        (percent, initializing) => reportProgress(requestId, initializing ? 'initializing' : 'preparing', percent),
        (done, total) => reportProgress(requestId, 'cleaning', Math.floor(done * 100 / total)), backgrounds, {
            reuseUniformPixels: true, protection,
            ...(translatedLines.some(line => line.quarterTurn) ? {onRotatedLabelRestored: (index: number) => {
                backgrounds[index] = {...backgrounds[index], uniform: false};
            }} : {}),
        }) : sourcePixels.data;
    if (pixels !== sourcePixels.data) sourcePixels.data.set(pixels);
    if (translatedLines.length) {
        const dirtyRegions = translatedLines.filter((_, index) => !backgrounds[index]?.uniform);
        for (const rect of mangaPatchRects(dirtyRegions as MangaRegion[], width, height)) {
            context.putImageData(sourcePixels, 0, 0, rect.x, rect.y, rect.width, rect.height);
        }
    }
    reportProgress(requestId, 'rendering');
    if (translatedLines.length) drawMangaTranslations(context, sourcePixels.data, width, height, translatedLines as MangaRegion[], true, backgrounds, protection);
    if (placed.length) {
        // 已逐像素证明的原纯白区域不需要修补模型，也不清除任何原文。
        drawMangaTranslations(context, sourcePixels.data, width, height, placed.map(item => item.region), true,
            placed.map(() => ({color: 'rgb(255,255,255)', uniform: true})));
        const visible = new Set(placed.map(item => item.index));
        let readingIndex = 0;
        for (const [index, line] of lines.entries()) if (!line.guardOnly) {
            if (visible.has(index)) delete readingLines[readingIndex].renderSkipped;
            readingIndex++;
        }
    }
    await checkImageCancellation(signal);
    const patches = await encodeMangaPatches(
        canvas,
        mangaPatchRects([...translatedLines as MangaRegion[], ...placed.map(item => item.region)], width, height),
        signal,
    );
    return {image: '', mangaPatches: {width, height, patches}, lines: readingLines};
}

async function prepareTranslatedImage(
    source: HTMLImageElement,
    lines: ImageTextRegion[],
    translations: string[],
    signal?: AbortSignal,
    manga = false,
    requestId?: string,
    support?: ImageDetectionSupport,
    placementImage?: string,
    placementBounds?: OcrLine['bbox'] | null,
    targetLanguage?: string,
): Promise<OffscreenImageTranslationResult> {
    await checkImageCancellation(signal);
    const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
    const {candidates, skipped, protectionExhausted, clampedDrawBounds, maskClamps} = await resolveProtectedCandidates(
        lines, translations, width, height, manga, targetLanguage, signal,
    );
    throwIfImageOperationAborted(signal);
    const selected = candidates.filter(candidate => !skipped.has(candidate.index));
    const translatedLines = selected.map(candidate => candidate.translated);
    // 不撤回原文保护。只有实际局部气泡、同源对象和尺寸仍有效的横排候选可尝试在空白处另画完整译文。
    const blankCandidates = manga && placementImage && !protectionExhausted && placementBounds !== null ? candidates.flatMap(candidate => {
        if (!skipped.has(candidate.index) || candidate.original.vertical || candidate.original.quarterTurn || candidate.original.preserveSource) return [];
        const owner = getMangaBubblePlacement(candidate.original as MangaRegion, placementImage, width, height);
        if (!owner) return [];
        if (placementBounds) {
            const within = (box: OcrLine['bbox']) => box.x0 >= placementBounds.x0 && box.y0 >= placementBounds.y0
                && box.x1 <= placementBounds.x1 && box.y1 <= placementBounds.y1;
            // padding 中的全文不能搬进邻段；跨可见边界的源段仍保留原有未绘制状态。
            if (!within(candidate.original.bbox) || candidate.original.sourceBoxes?.some(box => !within(box))) return [];
        }
        return [{candidate, owner}];
    }).slice(0, 32) : [];
    const readingLines = lines.flatMap((line, index) => line.guardOnly ? [] : [{
        ...line,
        sourceText: line.text,
        text: translations[index]?.trim() || line.text,
        backgroundColor: 'transparent',
        ...(skipped.has(index) ? {renderSkipped: true as const} : {}),
    }]);
    // 品牌名或已经是目标语言的文字仍可阅读/复制，不应把识别成功显示为错误。
    if (translatedLines.length === 0 && !blankCandidates.length) {
        return manga
            ? {image: '', mangaPatches: {width, height, patches: []}, lines: readingLines}
            : {image: '', imageUnchanged: true, lines: readingLines};
    }
    if (translatedLines.some(line => mightNeedRareImageFont(line.text))
        || blankCandidates.some(({candidate}) => mightNeedRareImageFont(candidate.translated.text))) {
        await prepareRareImageFont(signal);
        throwIfImageOperationAborted(signal);
    }
    const canvas = document.createElement('canvas');
    try {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('浏览器不支持图片处理');

        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height);
        throwIfImageOperationAborted(signal);
        if (manga) {
            return await renderMangaTranslatedCanvas(
                context, canvas, sourcePixels, lines, selected, translatedLines, blankCandidates,
                readingLines, placementImage, placementBounds, targetLanguage, requestId, signal,
            );
        }
        let sourceUnchanged = true;
        try {
            // 先在原图上准入整个擦字/绘字足迹。undefined在严格模式下仅表示已确认无需保护。
            const translatedToOriginal = new Map(selected.map(c => [c.translated, c.original]));
            const protection = planMaskAlphaProtection(sourcePixels.data, canvas.width, canvas.height, translatedLines,
                (line, w, h) => imageAlphaSamplingAndWriteBoxes(line, w, h, clampedDrawBounds.get(translatedToOriginal.get(line)!), maskClamps.get(line)),
                {requireConfirmedTransparency: true});
            const baseBounds = new Map(lines.map(line => [line, clampedDrawBounds.get(line) ?? imageDrawBounds(line, canvas.width, canvas.height)]));
            const appearances = observeImageSourceAppearances(sourcePixels.data, canvas.width, canvas.height, selected.map(c => c.original), line => baseBounds.get(line)!);
            const fontStyles = new Map(selected.map(candidate => [candidate.translated, getImageSourceTextStyle(context, candidate.original, appearances.get(candidate.original)?.inkBoxes)]));
            const orientations = observeImageSourceTypographyGeometry(sourcePixels.data, canvas.width, canvas.height,
                selected.filter(candidate => !candidate.original.quarterTurn && !fontStyles.get(candidate.translated)!.inkBounds).map(candidate => candidate.original));
            for (const candidate of selected) {
                const style = getImageSourceTypographyStyle(context, candidate.original, orientations.get(candidate.original));
                if (style) fontStyles.set(candidate.translated, style);
            }
            if (targetLanguage) canvas.lang = targetLanguage;
            if (selected.length >= 2) {
                const siblingCandidates = selected.map(candidate => {
                    const original = candidate.original, style = fontStyles.get(candidate.translated)!, bounds = baseBounds.get(original)!;
                    const eligible = !original.vertical && !original.quarterTurn && !style.orientation && (!original.sourceBoxes || original.sourceBoxes.length === 1);
                    let effectiveFontSize = style.fontSize;
                    if (eligible && Number.isFinite(style.fontSize) && style.fontSize > 0) {
                        const contentWidth = bounds.x1 - bounds.x0 - Math.min(2, (bounds.x1 - bounds.x0) * .03) * 2;
                        context.save();
                        try {
                            context.font = `400 ${style.fontSize}px ${IMAGE_TEXT_FONT}`;
                            const measured = context.measureText(candidate.translated.text).width;
                            if (Number.isFinite(measured) && measured > contentWidth) effectiveFontSize = style.fontSize * (contentWidth / measured);
                        } finally { context.restore(); }
                    }
                    return {bbox: original.bbox, fontSize: style.fontSize, effectiveFontSize, eligible};
                });
                const harmonized = harmonizeImageSiblingFontSizes(siblingCandidates);
                selected.forEach((candidate, idx) => {
                    const style = fontStyles.get(candidate.translated)!;
                    if (harmonized[idx] < style.fontSize) fontStyles.set(candidate.translated, {...style, fontSize: harmonized[idx]});
                });
            }
            const drawing = new Map<ImageTextRegion, {bounds: OcrLine['bbox']; alignment: 'left' | 'center' | 'right'; prepared?: ImageTranslationTextLayout; foreground?: string; background?: string; outline?: string; sourceInkBounds?: OcrLine['bbox']; orientation?: ImageSourceTypographyGeometry}>();
            const expansionBudget = {remaining: 262_144};
            function* otherTextBoxes(owner: ImageTextRegion) {
                for (const line of lines) if (line !== owner) {
                    yield baseBounds.get(line)!;
                    for (let index = -1; index < (line.sourceBoxes?.length ?? 0); index++) {
                        const box = index < 0 ? line.bbox : line.sourceBoxes![index];
                        yield {
                            x0: Math.max(0, Math.floor(box.x0) - 2), y0: Math.max(0, Math.floor(box.y0) - 2),
                            x1: Math.min(canvas.width, Math.ceil(box.x1) + 2), y1: Math.min(canvas.height, Math.ceil(box.y1) + 2),
                        };
                    }
                }
            }
            for (const candidate of selected) {
                const original = candidate.original, appearance = appearances.get(original), style = fontStyles.get(candidate.translated)!, limit = style.fontSize;
                let bounds = baseBounds.get(original)!;
                if (!style.orientation && appearance?.background && !original.vertical && !original.ruby?.length && (!original.sourceBoxes || original.sourceBoxes.length === 1)
                    && limit !== (original.fontSize ?? original.bbox.y1 - original.bbox.y0) * 1.2) {
                    const required = getImageSingleLineHeight(context, candidate.translated.text, bounds.x1 - bounds.x0, limit);
                    if (required !== undefined && required > bounds.y1 - bounds.y0) bounds = expandImageTextBounds(sourcePixels.data, canvas.width, canvas.height, bounds, required, appearance,
                        otherTextBoxes(original), expansionBudget);
                }
                const detectedAlign = !original.vertical && !original.quarterTurn && candidate.translated.textAlign === undefined
                    && (!original.sourceBoxes || original.sourceBoxes.length === 1)
                    ? detectImageSingleLineAlignment(sourcePixels.data, canvas.width, canvas.height, original.bbox) : undefined;
                const alignment = candidate.translated.vertical ? 'center' : candidate.translated.textAlign ?? detectedAlign ?? 'left';
                baseBounds.set(original, bounds);
                drawing.set(candidate.translated, {
                    bounds, alignment, sourceInkBounds: style.inkBounds, orientation: style.orientation,
                    ...(appearance?.background ? {background: `rgb(${appearance.background.slice(0, 3).join(',')})`} : {}),
                    ...(appearance?.foreground ? {foreground: appearance.foreground} : {}),
                    ...(appearance?.outline ? {outline: appearance.outline} : {}),
                });
            }
            if (protection) {
                const budget = {remaining: 1_048_576};
                for (const line of translatedLines) {
                    throwIfImageOperationAborted(signal);
                    const plan = drawing.get(line)!, original = plan.bounds, available = mangaAlphaClearRects(protection, original, budget);
                    let bounds: OcrLine['bbox'] | undefined, area = 0;
                    for (const candidate of available) { const size = (candidate.x1 - candidate.x0) * (candidate.y1 - candidate.y0); if (size > area) { bounds = candidate; area = size; } }
                    if (!bounds) throw new ImageAlphaProtectionUnavailableError();
                    const changed = bounds.x0 !== original.x0 || bounds.y0 !== original.y0 || bounds.x1 !== original.x1 || bounds.y1 !== original.y1;
                    if (changed && line.quarterTurn) throw new ImageAlphaProtectionUnavailableError();
                    const maxFontSize = fontStyles.get(line)!.fontSize;
                    const prepared = changed ? prepareImageAlphaTextLayout(context, line.text, bounds, maxFontSize, plan.alignment) : undefined;
                    if (changed && !prepared) throw new ImageAlphaProtectionUnavailableError();
                    drawing.set(line, {...plan, bounds, prepared});
                }
            }
            // 单行边饰先借静区几何提出候选，完整复核后在旧擦除框内保留其原像素。
            const single = selected.length === 1 && lines.length === 1 ? selected[0].original : undefined;
            let decoration = !protection && single && !single.vertical && !single.quarterTurn
                ? observeImageMatteDecoration(sourcePixels.data, canvas.width, single.text, appearances.get(single)) : undefined;
            const uncovered = !protection && hasUncoveredImageInk(sourcePixels.data, canvas.width, canvas.height, appearances);
            repairClippedInk: if ((decoration || uncovered) && isSingleFrameImageData(source.currentSrc || source.src)) {
                const owners = new Set(selected.map(candidate => candidate.original));
                const retained = lines.filter(line => !owners.has(line));
                const propose = (hint?: ImageMatteDecoration) => proposeImageMattePage(sourcePixels.data, canvas.width, canvas.height, translatedLines,
                    retained, line => {
                        const bounds = drawing.get(line)!.bounds;
                        if (!hint) return bounds;
                        return hint.side === 'left' ? {...bounds, x0: Math.max(bounds.x0, hint.gap + 1)} : {...bounds, x1: Math.min(bounds.x1, hint.gap)};
                    }, hint, Boolean(!hint && support && single));
                let proposal = decoration && propose(decoration);
                if (!proposal && uncovered) { decoration = undefined; proposal = propose(); }
                if (proposal) try {
                    const retainSource = async () => { await checkImageCancellation(signal); return imageAlphaUnchanged(readingLines); };
                    const view = getImageMatteProposalDrawings(proposal)!;
                    // 旧范围内没有保护孔，不代表其他段落或新墨迹范围的底色全不透明。
                    if (view.drawings.some(item => item.background[3] !== 255)) break repairClippedInk;
                    const args: Array<Parameters<typeof drawTranslatedImageText>> = [];
                    let overlapsArt = false;
                    for (const item of view.drawings) {
                        const plan = drawing.get(item.line)!, b = item.bounds;
                        // 至多128个绘字框与4096个图案矩形；保留原排版，不以裁字或移动译文绕过保护。
                        if (view.rectangles.some(art => b.x0 < art.x1 && art.x0 < b.x1 && b.y0 < art.y1 && art.y0 < b.y1)) {
                            overlapsArt = true;
                            break;
                        }
                        args.push([context, item.line.text, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0,
                            `rgb(${item.background.slice(0, 3).join(',')})`, fontStyles.get(item.line)!.fontSize,
                            plan.alignment, plan.prepared, plan.foreground, plan.outline, plan.sourceInkBounds, plan.orientation]);
                    }
                    // 同页两轮预检共用度量预算，不因模型等待而重置；水平预检排版结果供同步绘字直接复用。
                    const budget: ImageTextMeasureBudget = {remaining: 8192, characters: 4_194_304};
                    let preflightLayouts: Array<ImageTranslationTextLayout | undefined> = [];
                    const preflight = () => {
                        const layouts: Array<ImageTranslationTextLayout | undefined> = [];
                        for (const item of args) {
                            budget.layout = undefined;
                            if (!canDrawTranslatedImageText(budget, ...item)) return false;
                            layouts.push(budget.layout);
                        }
                        preflightLayouts = layouts;
                        return true;
                    };
                    if (overlapsArt || !preflight()) {
                        if (view.requiresGlyphProof) break repairClippedInk;
                        return await retainSource();
                    }
                    await checkImageCancellation(signal);
                    let retryWhenSegmentationReady = false;
                    let plan = !decoration && support
                        ? authorizeImageMatteProposal(proposal, support, new Map(selected.map(item => [item.translated, item.original.text]))) : undefined;
                    if (!plan) {
                        if (view.requiresGlyphProof) break repairClippedInk;
                        if (!decoration || view.hasDecorationFringe) {
                            let segmentation: ImageTextSegmentationSupport | undefined;
                            try {
                                segmentation = await segmentImageMatte(sourcePixels, canvas.width, canvas.height, signal);
                                retryWhenSegmentationReady = !segmentation;
                            } catch (error) {
                                throwIfImageOperationAborted(signal);
                                if (!decoration || (error instanceof Error && error.name === 'AbortError')) throw error;
                                // 边饰已具备旧框内的修补证明，可选模型失败时仍交付该结果。
                            }
                            if (segmentation) {
                                try { plan = decoration ? authorizeImageMatteDecorationFringe(proposal, segmentation) : authorizeImageMatteProposal(proposal, segmentation); }
                                finally { segmentation.dispose(); }
                            }
                        }
                        if (!plan && (decoration || retryWhenSegmentationReady)) plan = authorizeImageMatteWithinExistingMasks(proposal);
                        if (!plan) return await retainSource();
                    }
                    await checkImageCancellation(signal);
                    // 等待模型期间字体可能就绪；在同一同步段重新预检、应用并绘制，失败不发布局部译图。
                    if (!preflight()) {
                        if (view.requiresGlyphProof) break repairClippedInk;
                        return await retainSource();
                    }
                    sourceUnchanged = false;
                    applyImageMattePage(sourcePixels.data, canvas.width, canvas.height, plan);
                    for (const box of plan.uploads) context.putImageData(sourcePixels, 0, 0, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
                    for (let idx = 0; idx < args.length; idx++) {
                        const item = args[idx];
                        item[9] = preflightLayouts[idx];
                        drawTranslatedImageText(...item);
                    }
                    await checkImageCancellation(signal);
                    const image = await encodeImageCanvas(canvas, signal);
                    throwIfImageOperationAborted(signal);
                    return {image, lines: readingLines, ...(retryWhenSegmentationReady ? {retryWhenSegmentationReady: true as const} : {})};
                } finally { discardImageMatteProposal(proposal); }
            }
            // 全文布局先全部通过才擦除；保护点不可写也不可当作已知背景，无法完整修补时撤回。
            sourceUnchanged = false;
            const activeClamps = maskClamps.size ? maskClamps : undefined;
            const pixels = activeClamps ? inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true, protection, activeClamps)
                : protection ? inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true, protection)
                : inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true);
            await checkImageCancellation(signal);
            const dirtyRects = getInpaintDirtyRects(translatedLines, canvas.width, canvas.height, activeClamps);
            const dirtyArea = dirtyRects.reduce((sum, box) => sum + (box.x1 - box.x0) * (box.y1 - box.y0), 0);
            if (dirtyRects.length && dirtyArea < canvas.width * canvas.height * .5) {
                for (const box of dirtyRects) context.putImageData(sourcePixels, 0, 0, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
            } else {
                context.putImageData(sourcePixels, 0, 0);
            }

            const background = protection ? undefined : {pixels, width: canvas.width, height: canvas.height, remaining: 8192};
            for (const line of translatedLines) {
                throwIfImageOperationAborted(signal);
                const plan = drawing.get(line)!, bounds = plan.bounds;
                const color = plan.background ?? getImageTextBackgroundColor(pixels, canvas.width, canvas.height, line.bbox);
                drawTranslatedImageText(context, line.text, bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0,
                    color, fontStyles.get(line)!.fontSize, plan.alignment, plan.prepared, plan.foreground, plan.outline, plan.sourceInkBounds, plan.orientation,
                    plan.background ? undefined : background);
            }
            await checkImageCancellation(signal);
            const image = await encodeImageCanvas(canvas, signal);
            throwIfImageOperationAborted(signal);
            return {image, lines: readingLines};
        } catch (error) {
            if (!(error instanceof MangaAlphaProtectionLimitError) && !(error instanceof ImageAlphaProtectionUnavailableError)) throw error;
            if (sourceUnchanged && error instanceof ImageAlphaProtectionUnavailableError && support && isSingleFrameImageData(source.currentSrc || source.src)) {
                if (targetLanguage) canvas.lang = targetLanguage;
                const selectedOriginals = new Set(candidates.filter(candidate => !skipped.has(candidate.index)).map(candidate => candidate.original));
                const rescued = await renderImageMatteRescue(context, canvas, sourcePixels, translatedLines, lines.filter(line => !selectedOriginals.has(line)), readingLines, support, signal);
                if (rescued) return rescued;
            }
            await checkImageCancellation(signal);
            return imageAlphaUnchanged(readingLines);
        }
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

export async function translateImageInOffscreen(
    image: string,
    sourceLanguage: string,
    title: string,
    signal?: AbortSignal,
    requestId?: string,
    manga = false,
    ocrEngine: 'tesseract' | 'paddle' = 'tesseract',
    mangaViewport?: ImageViewport,
    inferenceBackend?: 'auto' | 'cpu',
): Promise<OffscreenImageTranslationResult> {
    if (inferenceBackend !== undefined) mangaInferenceClient.setBackend(inferenceBackend);
    // 提前验证输出预算，避免巨大输入完成 OCR 和付费翻译后才在生成译图时失败。
    const source = await loadImage(image, signal);
    try {
        throwIfImageOperationAborted(signal);
        const usePaddle = getImageOcrEngine(sourceLanguage, manga ? 'paddle' : ocrEngine) === 'paddle';
        if (!usePaddle) reportProgress(requestId, 'recognizing');
        const recognized = usePaddle ? await mangaOcrRuntime.recognize(image, sourceLanguage, source.naturalWidth || source.width,
            source.naturalHeight || source.height, signal,
            (stage, percent) => { if (!signal?.aborted) reportProgress(requestId, stage, percent); }, source, manga ? 'manga' : 'image') : await recognizeImage(image, sourceLanguage, signal, {
            decodedImage: source,
            includeMangaNumericConfidence: true,
            onProgress: percent => { if (!signal?.aborted) reportProgress(requestId, 'recognizing', percent); },
        });
        throwIfImageOperationAborted(signal);
        const guards: ImageTextRegion[] = [], guardKeys = new Map<string, {text?: string; conflict?: true; bbox: OcrLine['bbox']}>();
        const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
        const detectionSupport = manga ? undefined : getImageDetectionEvidence(recognized, image, width, height);
        const eligible = recognized.filter(line => {
            const numericConfidence = 'numericConfidence' in line ? line.numericConfidence : undefined;
            const suspected = line.guardOnly || (!usePaddle && numericProtection(line.text)
                && !(typeof numericConfidence === 'number' && Number.isFinite(numericConfidence) && numericConfidence >= 90 && numericConfidence <= 100));
            if (!suspected) return true;
            const b = line.bbox;
            if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) || b.x1 <= b.x0 || b.y1 <= b.y0)
                throw new Error('图片数字保护位置无效，已保留原图');
            const bbox = {x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(width, b.x1), y1: Math.min(height, b.y1)};
            if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return false;
            const key = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].join(',');
            const evidence = 'numericGuardText' in line ? line.numericGuardText : line.text || undefined;
            const text = evidence === undefined ? undefined : numericEvidenceKey(evidence);
            const conflict = 'numericGuardConflict' in line && line.numericGuardConflict === true;
            const previous = guardKeys.get(key);
            if (previous) { if (conflict || previous.text !== text) previous.conflict = true; return false; }
            if (guards.length >= 4096) throw new Error('图片数字保护区域过于复杂，已保留原图');
            guardKeys.set(key, {bbox, text, ...(conflict ? {conflict: true as const} : {})});
            guards.push({text: '', bbox, guardOnly: true});
            return false;
        });
        const readable: ImageTextRegion[] = manga ? usePaddle ? eligible : groupMangaOcrLines(eligible, sourceLanguage, width, height)
            : groupImageParagraphs(eligible.map(line => numericProtection(line.text) ? {...line, sourceBoxes: [line.bbox]} : line),
                usePaddle ? getImageParagraphGapEvidence(recognized, image, width, height) : undefined);
        if (!usePaddle) {
            // 原始数值证据仅用于本地提示，不进入阅读结果或翻译请求。
            const numbers = readable.filter(line => numericProtection(line.text)).map(line => ({line, key: numericEvidenceKey(line.text)}));
            let comparisons = 0, exhausted = false;
            for (const guard of guardKeys.values()) {
                const guardKey = guard.text;
                for (const number of numbers) {
                    const {line, key} = number;
                    if (++comparisons > 1_000_000) { exhausted = true; break; }
                    const a = guard.bbox, b = line.bbox;
                    if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
                        && (guard.conflict || guardKey !== key))
                        line.numericUncertain = true;
                }
                if (exhausted) break;
            }
            // 原始同值框可能已被可信结果覆盖而省略，但其他可信结果仍可能与其冲突。
            for (let i = 0; !exhausted && i < numbers.length; i++) for (let j = i + 1; j < numbers.length; j++) {
                if (++comparisons > 1_000_000) { exhausted = true; break; }
                const left = numbers[i], right = numbers[j], a = left.line.bbox, b = right.line.bbox;
                if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
                    && left.key !== right.key)
                    left.line.numericUncertain = right.line.numericUncertain = true;
            }
            if (exhausted) numbers.forEach(({line}) => line.numericUncertain = true);
        }
        if (readable.length === 0) {
            if (manga) return {image, lines: []};
            if (recognized.length === 0) return {image: '', imageUnchanged: true, lines: []};
            throw new Error('没有识别到图片文字');
        }
        const placementBounds = manga ? mangaPlacementBounds(mangaViewport, width, height) : undefined;
        const scopedReadable = placementBounds
            ? readable.filter(line => !isRegionOutsideViewport(line, placementBounds))
            : readable;
        const lines: ImageTextRegion[] = [...scopedReadable, ...guards];
        const translatable = lines.map((line, index) => ({line, index})).filter(({line}) => !line.guardOnly && !numericProtection(line.text));
        const translations = lines.map(line => line.text);
        let targetLanguage: string | undefined;
        if (translatable.length) {
            reportProgress(requestId, 'translating');
            const labels = manga ? undefined : getAlignedImageLabelSlots(translatable);
            const result = await translateImageTextsInExtension(translatable.map(({line}) => line.text), title, requestId, signal, labels);
            targetLanguage = result.targetLanguage;
            translatable.forEach(({index}, position) => { translations[index] = result.translations[position] ?? lines[index].text; });
        }
        throwIfImageOperationAborted(signal);
        reportProgress(requestId, manga ? 'cleaning' : 'rendering');
        return await prepareTranslatedImage(source, lines, translations, signal, manga, requestId, detectionSupport, manga ? image : undefined, placementBounds, targetLanguage);
    } finally {
        source.src = '';
    }
}

export async function translateAreaInOffscreen(
    image: string,
    sourceLanguage: string,
    _title: string,
    selection: AreaTranslationSelection,
    signal?: AbortSignal,
    _requestId?: string,
): Promise<AreaRecognitionResult> {
    const croppedImage = await cropImage(image, selection, signal);
    throwIfImageOperationAborted(signal);
    const lines = await recognizeImage(croppedImage, sourceLanguage, signal, {profile: 'area'});
    throwIfImageOperationAborted(signal);
    if (lines.length === 0) throw new Error('没有识别到圈选区域文字');
    return {image: croppedImage, lines};
}
