/**
 * @file src/features/image-translation/services/offscreenRuntime.ts
 * 文件职责：在隔离 Offscreen 文档中编排图片重绘翻译，并为圈选文本翻译提供仅裁剪和本地 OCR 的独立入口。
 * 主要内容：单图可选与漫画共用的 PaddleOCR，两种引擎均按普通段落合行翻译、限制字号并保留对齐，擦除只使用原始行框；单图与漫画按各自修补和绘制边界对保留原文做有界碰撞传递检查；保留单图完整译图与原文对照，不自动加载漫画修补模型；图片解码时前置尺寸校验和取消/超时清理，普通修补复用独占像素，完整译图、漫画局部图块和圈选裁剪共用可取消的异步 PNG 编码；漫画在原始像素尚未回写前计算全局透明孔保护，与背景分类一起交给修补及绘字；确认整页均匀时复用本次独占 ImageData 并跳过同一数组的拷回，复杂页仍分离输入与输出，完成或失败后释放临时图像与画布。
 * 模块边界：该运行时只在具备 Canvas/DOM 的 Offscreen 环境执行，不直接接收 browser.runtime 事件；消息入口由 app/offscreen 组装，翻译函数由依赖注入，几何算法来自 area feature。
 */
import {createImageTranslationFailure} from '../failure';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import { selectChangedTranslations, type OcrLine } from '@/src/features/image-translation/core';
import { areaRectToImageCrop, type AreaTranslationSelection, type AreaRecognitionResult } from '@/src/features/area-translation/protocol';
import { imageMaskBoxIntersects, inpaintTextRegions } from './inpainting';
import { recognizeImage } from './ocrRuntime';
import { getImageTextBackgroundColor, drawTranslatedImageText } from './rendering';
import {groupImageParagraphs, type ImageTextRegion} from '../paragraphs';
import {mangaOcrRuntime} from './mangaOcr';
import {drawMangaTranslations, sampleMangaBackgrounds} from './mangaRendering';
import {planMangaAlphaProtection} from './mangaAlphaProtection';
import {groupMangaOcrLines, type MangaRegion} from './mangaRegions';
import {numericInformation} from './mangaNumeric';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {mangaMaskBoxIntersects, mangaPatchRects, type MangaPatchPacket} from '../mangaPatchResult';
import {getMangaOcrEngine} from '../ocrLanguages';

export type OffscreenImageTranslationLine = OcrLine & { backgroundColor: string; sourceText?: string; renderSkipped?: true };

export interface OffscreenImageTranslationResult {
    image: string;
    imageUnchanged?: true;
    mangaPatches?: MangaPatchPacket;
    lines: OffscreenImageTranslationLine[];
}

const IMAGE_TEXT_TRANSLATION_TIMEOUT_MS = 120_000;
const IMAGE_DECODE_TIMEOUT_MS = 30_000;
const MAX_RENDER_IMAGE_PIXELS = 16_777_216;
const MAX_RENDER_IMAGE_SIDE = 8192;
let legacyImageTextRequestSequence = 0;

function createImageOperationAbortError(): Error {
    const error = new Error('图片翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfImageOperationAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw createImageOperationAbortError();
}

function loadImage(dataUrl: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createImageOperationAbortError());
            return;
        }
        const source = new Image();
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            source.onload = null;
            source.onerror = null;
            signal?.removeEventListener('abort', handleAbort);
            callback();
        };
        const fail = (error: Error) => finish(() => {
            source.src = '';
            reject(error);
        });
        const handleAbort = () => fail(createImageOperationAbortError());
        source.onload = () => {
            const width = source.naturalWidth || source.width;
            const height = source.naturalHeight || source.height;
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
                fail(new Error('图片尺寸无效'));
            } else if (width * height > MAX_RENDER_IMAGE_PIXELS || Math.max(width, height) > MAX_RENDER_IMAGE_SIDE) {
                fail(new Error('图片过大，请缩小图片或使用圈选翻译'));
            } else finish(() => resolve(source));
        };
        source.onerror = () => fail(new Error('图片数据无法解码'));
        signal?.addEventListener('abort', handleAbort, {once: true});
        timeout = setTimeout(() => fail(new Error('图片解码超时，请重试')), IMAGE_DECODE_TIMEOUT_MS);
        try {
            source.src = dataUrl;
        } catch {
            fail(new Error('图片数据无法解码'));
        }
    });
}

/** 在像素阶段让出事件循环，使已发送的取消消息有机会在编码和返回结果前生效。 */
async function checkImageCancellation(signal?: AbortSignal): Promise<void> {
    throwIfImageOperationAborted(signal);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    throwIfImageOperationAborted(signal);
}

function reportProgress(requestId: string | undefined, stage: ImageTranslationStage, progress?: number): void {
    if (!requestId) return;
    // 进度是旁路；页面已关闭时不得影响取消与 OCR 主链。
    try { chrome.runtime.sendMessage({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId, stage, progress}, () => void chrome.runtime.lastError); } catch { /* 扩展上下文可能已销毁。 */ }
}

export async function translateImageTextsInExtension(
    texts: string[],
    title: string,
    requestId: string | undefined,
    signal?: AbortSignal,
): Promise<string[]> {
    const operationId = requestId || `legacy-image-text-${++legacyImageTextRequestSequence}`;
    const response = await new Promise<any>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', handleAbort);
            callback();
        };
        const notifyCancellation = () => {
            try {
                chrome.runtime.sendMessage({
                    type: 'fluentReadImageCancel',
                    requestId: operationId,
                }, () => void chrome.runtime.lastError);
            } catch {
                // Offscreen 正在销毁时取消消息可能无法投递；本地等待仍必须立即结束。
            }
        };
        const handleAbort = () => finish(() => {
            notifyCancellation();
            reject(createImageOperationAbortError());
        });
        if (signal?.aborted) {
            handleAbort();
            return;
        }
        signal?.addEventListener('abort', handleAbort, {once: true});
        timeout = setTimeout(() => finish(() => {
            notifyCancellation();
            reject(new Error('图片文字翻译超时，请重试'));
        }), IMAGE_TEXT_TRANSLATION_TIMEOUT_MS);
        try {
            chrome.runtime.sendMessage({
                type: 'fluentReadImageTranslateTexts',
                texts,
                title,
                requestId: operationId,
                timeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
            }, result => finish(() => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
            }));
        } catch (error) {
            finish(() => reject(error));
        }
    });
    throwIfImageOperationAborted(signal);
    if (!response?.success || !Array.isArray(response.translations)) {
        throw createImageTranslationFailure(response?.error || '图片文字翻译失败', response);
    }
    return response.translations;
}

async function cropImage(dataUrl: string, selection: AreaTranslationSelection, signal?: AbortSignal): Promise<string> {
    const source = await loadImage(dataUrl, signal);
    let canvas: HTMLCanvasElement | undefined;
    try {
        throwIfImageOperationAborted(signal);
        const imageWidth = source.naturalWidth || source.width;
        const imageHeight = source.naturalHeight || source.height;
        const crop = areaRectToImageCrop(selection, imageWidth, imageHeight);
        canvas = document.createElement('canvas');
        canvas.width = crop.width;
        canvas.height = crop.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持区域截图处理');
        context.drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
        throwIfImageOperationAborted(signal);
        // 画布已拥有裁剪像素；等待编码时不继续持有整张解码截图。
        source.src = '';
        const image = await encodeImageCanvas(canvas, signal);
        throwIfImageOperationAborted(signal);
        return image;
    } finally {
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        source.src = '';
    }
}

/** 仅裁剪选区供视觉模型使用；此路径不加载 OCR 语言包，也不执行本地识别。 */
export async function cropAreaInOffscreen(
    image: string,
    selection: AreaTranslationSelection,
    signal?: AbortSignal,
): Promise<{image: string; lines: OcrLine[]}> {
    const croppedImage = await cropImage(image, selection, signal);
    throwIfImageOperationAborted(signal);
    return {image: croppedImage, lines: []};
}

/** 单图译文裁剪框既决定绘制范围，也用于保护附近保留的原文。 */
function imageDrawBounds(line: ImageTextRegion, width: number, height: number): OcrLine['bbox'] {
    const sourceHeight = line.fontSize ?? line.bbox.y1 - line.bbox.y0;
    const paddingX = line.vertical ? 3 : 2;
    const paddingY = line.vertical ? 2 : Math.max(2, Math.round(sourceHeight * 0.18));
    const left = Math.max(0, line.bbox.x0 - paddingX), top = Math.max(0, line.bbox.y0 - paddingY);
    const drawWidth = Math.max(1, Math.min(width - left, line.bbox.x1 - line.bbox.x0 + paddingX * 2));
    const drawHeight = Math.max(1, Math.min(height - top, line.bbox.y1 - line.bbox.y0 + paddingY * 2));
    return {x0:left,y0:top,x1:left+drawWidth,y1:top+drawHeight};
}

async function prepareTranslatedImage(
    source: HTMLImageElement,
    lines: ImageTextRegion[],
    translations: string[],
    signal?: AbortSignal,
    manga = false,
    requestId?: string,
): Promise<OffscreenImageTranslationResult> {
    await checkImageCancellation(signal);
    const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
    const skipped = new Set<number>();
    const candidates: Array<{index: number; original: ImageTextRegion; translated: ImageTextRegion}> = [];
    const originals: ImageTextRegion[] = [];
    lines.forEach((line,index) => {
        const changed = manga && numericInformation(line.text) ? [] : selectChangedTranslations([line], [translations[index]]);
        if (changed.length) candidates.push({index,original:line,translated:changed[0]});
        else originals.push(line);
    });
    if (candidates.length && originals.length) {
        // 所有保留原文（含碰撞后未绘制的译文）都必须避开后续修补和排版。
        const protectedBoxes: OcrLine['bbox'][] = [], seen = new Set<string>();
        let work = 0, exhausted = false;
        const validBox = (box:OcrLine['bbox'] | null | undefined): box is OcrLine['bbox'] => !!box && Number.isFinite(box.x0) && Number.isFinite(box.y0)
            && Number.isFinite(box.x1) && Number.isFinite(box.y1);
        const protect = async (line: ImageTextRegion) => {
            const sources = line.sourceBoxes ?? [];
            for (let index=-1;index<sources.length;index++) {
                const box = index<0 ? line.bbox : sources[index];
                if (++work > 1_000_000 || !validBox(box)) {exhausted = true;return;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                const rect = {x0:Math.max(0,Math.floor(box.x0)-2),y0:Math.max(0,Math.floor(box.y0)-2),
                    x1:Math.min(width,Math.ceil(box.x1)+2),y1:Math.min(height,Math.ceil(box.y1)+2)};
                if (rect.x1<=rect.x0 || rect.y1<=rect.y0) continue;
                const key = `${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
                if (!seen.has(key)) {
                    if (protectedBoxes.length>=8192) {exhausted=true;return;}
                    seen.add(key);protectedBoxes.push(rect);
                }
            }
        };
        for (const line of originals) {await protect(line);if (exhausted) break;}
        // 对新保留的原文继续传播；只对尚未跳过的候选比较，达到预算时不绘制任何候选。
        for (let cursor=0;cursor<protectedBoxes.length && !exhausted && skipped.size<candidates.length;cursor++) {
            const protectedBox = protectedBoxes[cursor];
            for (const candidate of candidates) {
                if (++work>1_000_000) {exhausted=true;break;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                if (skipped.has(candidate.index)) continue;
                const region = candidate.translated, box = region.bbox;
                if (++work>1_000_000 || !validBox(box) || (manga && !Number.isFinite(region.fontSize))) {exhausted=true;break;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                const drawBox = manga ? box : imageDrawBounds(region,width,height);
                let hit = drawBox.x0<protectedBox.x1 && protectedBox.x0<drawBox.x1 && drawBox.y0<protectedBox.y1 && protectedBox.y0<drawBox.y1;
                const sources = region.sourceBoxes;
                for (let index=0;!hit && index<(sources?.length ?? 1);index++) {
                    const source = sources ? sources[index] : box;
                    if (++work>1_000_000 || !validBox(source)) {exhausted=true;break;}
                    if ((work & 32767)===0) await checkImageCancellation(signal);
                    hit=manga ? mangaMaskBoxIntersects(source,region.fontSize!,width,height,protectedBox)
                        : imageMaskBoxIntersects(source,width,height,protectedBox);
                }
                if (hit) {skipped.add(candidate.index);await protect(candidate.original);}
                if (exhausted) break;
            }
        }
        if (exhausted) for (const candidate of candidates) skipped.add(candidate.index);
    }
    throwIfImageOperationAborted(signal);
    const translatedLines = candidates.filter(candidate=>!skipped.has(candidate.index)).map(candidate=>candidate.translated);
    const readingLines = lines.map((line, index) => ({...line, sourceText: line.text, text: translations[index]?.trim() || line.text, backgroundColor: 'transparent',
        ...(skipped.has(index) ? {renderSkipped: true as const} : {})}));
    // 品牌名或已经是目标语言的文字仍可阅读/复制，不应把识别成功显示为错误。
    if (translatedLines.length === 0) return manga ? {image: '', mangaPatches: {width: source.naturalWidth || source.width, height: source.naturalHeight || source.height, patches: []}, lines: readingLines} : {image: '', imageUnchanged: true, lines: readingLines};
    const canvas = document.createElement('canvas');
    try {
        canvas.width = source.naturalWidth || source.width;
        canvas.height = source.naturalHeight || source.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');

        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height);
        throwIfImageOperationAborted(signal);
        if (manga) {
            const backgrounds = sampleMangaBackgrounds(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[]);
            const protection = planMangaAlphaProtection(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[]);
            const pixels = await mangaInpaintingRuntime.repair(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[],signal,
                (percent,initializing)=>reportProgress(requestId,initializing?'initializing':'preparing',percent),
                (done,total)=>reportProgress(requestId,'cleaning',Math.floor(done*100/total)),backgrounds,{reuseUniformPixels:true,protection});
            if(pixels!==sourcePixels.data)sourcePixels.data.set(pixels);
            context.putImageData(sourcePixels,0,0);
            reportProgress(requestId,'rendering');
            drawMangaTranslations(context, sourcePixels.data, canvas.width, canvas.height, translatedLines as MangaRegion[],true,backgrounds,protection);
            await checkImageCancellation(signal);
            const patches: MangaPatchPacket['patches'] = [];
            for (const rect of mangaPatchRects(translatedLines as MangaRegion[], canvas.width, canvas.height)) {
                const patchCanvas = document.createElement('canvas');
                try {
                    patchCanvas.width = rect.width; patchCanvas.height = rect.height;
                    const patchContext = patchCanvas.getContext('2d');
                    if (!patchContext) throw new Error('浏览器不支持图片处理');
                    patchContext.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
                    patches.push({...rect, image: await encodeImageCanvas(patchCanvas, signal)});
                    throwIfImageOperationAborted(signal);
                } finally {patchCanvas.width = 0; patchCanvas.height = 0;}
            }
            return {image: '', mangaPatches: {width: canvas.width, height: canvas.height, patches}, lines: readingLines};
        }
        // ImageData 仅归本次 Canvas 所有，直接修补以避免复制整图 RGBA 后再拷回。
        const pixels = inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true);
        await checkImageCancellation(signal);
        context.putImageData(sourcePixels, 0, 0);

        const renderedLines = translatedLines.map(line => ({
            ...line,
            backgroundColor: getImageTextBackgroundColor(pixels, canvas.width, canvas.height, line.bbox),
        }));
        renderedLines.forEach(line => {
            throwIfImageOperationAborted(signal);
            // 使用源行字形高度而非段落总高留白，竖排继续保持最小边距。
            const sourceHeight = line.fontSize ?? line.bbox.y1 - line.bbox.y0;
            const bounds = imageDrawBounds(line,canvas.width,canvas.height);
            drawTranslatedImageText(
                context,
                line.text,
                bounds.x0,
                bounds.y0,
                bounds.x1 - bounds.x0,
                bounds.y1 - bounds.y0,
                line.backgroundColor,
                line.vertical ? Infinity : sourceHeight * 1.2,
                line.vertical ? 'center' : line.textAlign ?? 'left',
            );
        });

        await checkImageCancellation(signal);
        const image = await encodeImageCanvas(canvas, signal);
        throwIfImageOperationAborted(signal);
        return { image, lines: readingLines };
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
): Promise<OffscreenImageTranslationResult> {
    // 提前验证输出预算，避免巨大输入完成 OCR 和付费翻译后才在生成译图时失败。
    const source = await loadImage(image, signal);
    try {
        throwIfImageOperationAborted(signal);
        const usePaddle = (manga ? getMangaOcrEngine(sourceLanguage) : ocrEngine) === 'paddle';
        if (!usePaddle) reportProgress(requestId, 'recognizing');
        const recognized = usePaddle ? await mangaOcrRuntime.recognize(image, sourceLanguage, source.naturalWidth || source.width,
            source.naturalHeight || source.height, signal,
            (stage, percent) => {if (!signal?.aborted) reportProgress(requestId, stage, percent);}, source, manga ? 'manga' : 'image') : await recognizeImage(image, sourceLanguage, signal, {
            decodedImage: source,
            ...(manga ? {includeMangaNumericConfidence: true} : {}),
            onProgress: percent => { if (!signal?.aborted) reportProgress(requestId, 'recognizing', percent); },
        });
        throwIfImageOperationAborted(signal);
        const lines = manga ? usePaddle ? recognized : groupMangaOcrLines(recognized, sourceLanguage,
            source.naturalWidth || source.width, source.naturalHeight || source.height) : groupImageParagraphs(recognized);
        if (lines.length === 0) {
            if (manga) return {image,lines:[]};
            throw new Error('没有识别到图片文字');
        }
        const translatable = lines.map((line, index) => ({line, index})).filter(({line}) => !manga || !numericInformation(line.text));
        const translations = lines.map(line => line.text);
        if (translatable.length) {
            reportProgress(requestId, 'translating');
            const translated = await translateImageTextsInExtension(translatable.map(({line}) => line.text), title, requestId, signal);
            translatable.forEach(({index}, position) => {translations[index] = translated[position] ?? lines[index].text;});
        }
        throwIfImageOperationAborted(signal);
        reportProgress(requestId, manga ? 'cleaning' : 'rendering');
        return await prepareTranslatedImage(source, lines, translations, signal, manga, requestId);
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
