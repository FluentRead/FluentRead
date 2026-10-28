/**
 * @file src/features/image-translation/services/offscreenRuntime.ts
 * 文件职责：在隔离 Offscreen 文档中编排图片重绘翻译，并为圈选文本翻译提供仅裁剪和本地 OCR 的独立入口。
 * 主要内容：单图可选与漫画共用的 PaddleOCR，两种引擎均按普通段落合行翻译、限制字号并保留对齐，擦除只使用原始行框；独立数字保留原图与可读原文，不发送翻译，碰撞的文字只显示于阅读面板；保留单图完整译图与原文对照，不自动加载漫画修补模型；图片解码时前置尺寸校验和取消/超时清理，普通修补复用独占像素，完整译图、漫画局部图块和圈选裁剪共用可取消的异步 PNG 编码；漫画在原始像素尚未回写前计算全局透明孔保护，与背景分类一起交给修补及绘字，避免重叠写入破坏已保护的画面；确认整页均匀时复用本次独占 ImageData 并跳过同一数组的拷回，复杂页仍分离输入与输出，完成或失败后释放临时图像与画布。
 * 模块边界：该运行时只在具备 Canvas/DOM 的 Offscreen 环境执行，不直接接收 browser.runtime 事件；消息入口由 app/offscreen 组装，翻译函数由依赖注入，几何算法来自 area feature。
 */
import {createImageTranslationFailure} from '../failure';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import { selectChangedTranslations, type OcrLine } from '@/src/features/image-translation/core';
import { areaRectToImageCrop, type AreaTranslationSelection, type AreaRecognitionResult } from '@/src/features/area-translation/protocol';
import { inpaintTextRegions } from './inpainting';
import { recognizeImage } from './ocrRuntime';
import { getImageTextBackgroundColor, drawTranslatedImageText } from './rendering';
import {groupImageParagraphs, type ImageTextRegion} from '../paragraphs';
import {mangaOcrRuntime} from './mangaOcr';
import {drawMangaTranslations, sampleMangaBackgrounds} from './mangaRendering';
import {planMangaAlphaProtection} from './mangaAlphaProtection';
import {groupMangaOcrLines, type MangaRegion} from './mangaRegions';
import {numericEvidenceKey,numericProtection} from './mangaNumeric';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {mangaMaskBoxes, mangaPatchRects, type MangaPatchPacket} from '../mangaPatchResult';
import {getMangaOcrEngine} from '../ocrLanguages';

export type OffscreenImageTranslationLine = OcrLine & { backgroundColor: string; sourceText?: string; renderSkipped?: true; numericUncertain?: true };

export interface OffscreenImageTranslationResult {
    image: string;
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

async function prepareTranslatedImage(
    source: HTMLImageElement,
    lines: ImageTextRegion[],
    translations: string[],
    signal?: AbortSignal,
    manga = false,
    requestId?: string,
): Promise<OffscreenImageTranslationResult> {
    await checkImageCancellation(signal);
    const numeric = lines.filter(line => line.guardOnly || numericProtection(line.text));
    const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
    const protectedBoxes = numeric.map(({bbox}) => ({x0: Math.max(0, Math.floor(bbox.x0) - 2), y0: Math.max(0, Math.floor(bbox.y0) - 2),
        x1: Math.min(width, Math.ceil(bbox.x1) + 2), y1: Math.min(height, Math.ceil(bbox.y1) + 2)}));
    const intersects = (a: OcrLine['bbox'], b: OcrLine['bbox']) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    let comparisons = 0;
    const skipped = new Set<number>();
    const translatedLines = lines.flatMap((line, index) => {
        if (line.guardOnly || numericProtection(line.text)) return [];
        const changed = selectChangedTranslations([line], [translations[index]]);
        if (!changed.length) return [];
        if (protectedBoxes.length) {
            const region = changed[0];
            const pad = Math.max(4, Math.ceil((region.fontSize ?? region.bbox.y1 - region.bbox.y0) * .18));
            const expand = (box: OcrLine['bbox'], margin: number) => ({x0:box.x0-margin,y0:box.y0-margin,x1:box.x1+margin,y1:box.y1+margin});
            // 单图译文裁切框会在页边夹紧后扩大至多两倍余量；清字对每个源框最多外扩四像素。
            const touched = manga ? [region.bbox, ...mangaMaskBoxes(region as MangaRegion, width, height)]
                : [expand(region.bbox,pad*2),...(region.sourceBoxes ?? [region.bbox]).map(box=>expand(box,4))];
            for (const box of touched) for (const protectedBox of protectedBoxes) {
                if (++comparisons > 1_000_000 || ![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)
                    || intersects(box, protectedBox)) { skipped.add(index); return []; }
            }
        }
        return changed;
    });
    const readingLines = lines.flatMap((line, index) => line.guardOnly ? [] : [{...line, sourceText: line.text, text: translations[index]?.trim() || line.text, backgroundColor: 'transparent',
        ...(skipped.has(index) ? {renderSkipped: true as const} : {})}]);
    // 品牌名或已经是目标语言的文字仍可阅读/复制，不应把识别成功显示为错误。
    if (translatedLines.length === 0) return manga ? {image: '', mangaPatches: {width: source.naturalWidth || source.width, height: source.naturalHeight || source.height, patches: []}, lines: readingLines} : {image: source.src, lines: readingLines};
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
            const paddingX = line.vertical ? 3 : 2;
            const paddingY = line.vertical ? 2 : Math.max(2, Math.round(sourceHeight * 0.18));
            const left = Math.max(0, line.bbox.x0 - paddingX);
            const top = Math.max(0, line.bbox.y0 - paddingY);
            const width = Math.min(canvas.width - left, line.bbox.x1 - line.bbox.x0 + paddingX * 2);
            const height = Math.min(canvas.height - top, line.bbox.y1 - line.bbox.y0 + paddingY * 2);
            drawTranslatedImageText(
                context,
                line.text,
                left,
                top,
                Math.max(1, width),
                Math.max(1, height),
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
            includeMangaNumericConfidence: true,
            onProgress: percent => { if (!signal?.aborted) reportProgress(requestId, 'recognizing', percent); },
        });
        throwIfImageOperationAborted(signal);
        const guards:ImageTextRegion[]=[],guardKeys=new Map<string,{text?:string;conflict?:true; bbox:OcrLine['bbox']}>();
        const width=source.naturalWidth || source.width,height=source.naturalHeight || source.height;
        const eligible=recognized.filter(line=>{
            const numericConfidence='numericConfidence' in line ? line.numericConfidence : undefined;
            const suspected=line.guardOnly || (!usePaddle && numericProtection(line.text)
                && !(typeof numericConfidence==='number' && Number.isFinite(numericConfidence) && numericConfidence>=90 && numericConfidence<=100));
            if(!suspected)return true;
            const b=line.bbox;
            if(!b||![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x1<=b.x0||b.y1<=b.y0)
                throw new Error('图片数字保护位置无效，已保留原图');
            const bbox={x0:Math.max(0,b.x0),y0:Math.max(0,b.y0),x1:Math.min(width,b.x1),y1:Math.min(height,b.y1)};
            if(bbox.x1<=bbox.x0||bbox.y1<=bbox.y0)return false;
            const key=[bbox.x0,bbox.y0,bbox.x1,bbox.y1].join(',');
            const evidence='numericGuardText' in line ? line.numericGuardText : line.text || undefined;
            const text=evidence===undefined?undefined:numericEvidenceKey(evidence);
            const conflict='numericGuardConflict' in line && line.numericGuardConflict === true;
            const previous=guardKeys.get(key);
            if(previous){if(conflict || previous.text!==text)previous.conflict=true;return false;}
            if(guards.length>=4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
            guardKeys.set(key,{bbox,text,...(conflict?{conflict:true as const}:{})});guards.push({text:'',bbox,guardOnly:true});return false;
        });
        const readable:ImageTextRegion[] = manga ? usePaddle ? eligible : groupMangaOcrLines(eligible, sourceLanguage,
            source.naturalWidth || source.width, source.naturalHeight || source.height)
            : groupImageParagraphs(eligible.map(line => numericProtection(line.text) ? {...line,sourceBoxes:[line.bbox]} : line));
        if (!usePaddle) {
            // 原始数值证据仅用于本地提示，不进入阅读结果或翻译请求。
            const numbers=readable.filter(line=>numericProtection(line.text)).map(line=>({line,key:numericEvidenceKey(line.text)}));
            let comparisons=0,exhausted=false;
            for(const guard of guardKeys.values()) {
                const guardKey=guard.text;
                for(const number of numbers) {
                    const {line,key}=number;
                    if(++comparisons>1_000_000){exhausted=true;break;}
                    const a=guard.bbox,b=line.bbox;
                    if(a.x0<b.x1 && b.x0<a.x1 && a.y0<b.y1 && b.y0<a.y1
                        && (guard.conflict || guardKey!==key))
                        line.numericUncertain=true;
                }
                if(exhausted)break;
            }
            // 原始同值框可能已被可信结果覆盖而省略，但其他可信结果仍可能与其冲突。
            for(let i=0;!exhausted && i<numbers.length;i++) for(let j=i+1;j<numbers.length;j++) {
                if(++comparisons>1_000_000){exhausted=true;break;}
                const left=numbers[i],right=numbers[j],a=left.line.bbox,b=right.line.bbox;
                if(a.x0<b.x1 && b.x0<a.x1 && a.y0<b.y1 && b.y0<a.y1
                    && left.key!==right.key)
                    left.line.numericUncertain=right.line.numericUncertain=true;
            }
            if(exhausted)numbers.forEach(({line})=>line.numericUncertain=true);
        }
        if (readable.length === 0) {
            if (manga) return {image,lines:[]};
            throw new Error('没有识别到图片文字');
        }
        const lines:ImageTextRegion[]=[...readable,...guards];
        const translatable = lines.map((line, index) => ({line, index})).filter(({line}) => !line.guardOnly && !numericProtection(line.text));
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
