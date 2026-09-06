/**
 * @file src/features/image-translation/services/offscreenRuntime.ts
 * 文件职责：在隔离 Offscreen 文档中编排图片重绘翻译，并为圈选文本翻译提供仅裁剪和本地 OCR 的独立入口。
 * 主要内容：图片解码时前置尺寸校验和取消/超时清理，复用解码位图完成真实阶段通知、OCR 与完整译文绘制；导出图片和圈选入口，在完成或失败后释放临时图像与画布。
 * 模块边界：该运行时只在具备 Canvas/DOM 的 Offscreen 环境执行，不直接接收 browser.runtime 事件；消息入口由 app/offscreen 组装，翻译函数由依赖注入，几何算法来自 area feature。
 */
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import { selectChangedTranslations, type OcrLine } from '@/src/features/image-translation/core';
import { areaRectToImageCrop, type AreaTranslationSelection, type AreaRecognitionResult } from '@/src/features/area-translation/protocol';
import { inpaintTextRegions } from './inpainting';
import { recognizeImage } from './ocrRuntime';
import { getImageTextBackgroundColor, drawTranslatedImageText } from './rendering';

export type OffscreenImageTranslationLine = OcrLine & { backgroundColor: string };

export interface OffscreenImageTranslationResult {
    image: string;
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
        throw new Error(response?.error || '图片文字翻译失败');
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
        const image = canvas.toDataURL('image/png');
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

async function prepareTranslatedImage(
    source: HTMLImageElement,
    lines: OcrLine[],
    translations: string[],
    signal?: AbortSignal,
): Promise<OffscreenImageTranslationResult> {
    await checkImageCancellation(signal);
    const translatedLines = selectChangedTranslations(lines, translations);
    if (translatedLines.length === 0) throw new Error('图片中没有需要翻译的文字');
    const canvas = document.createElement('canvas');
    try {
        canvas.width = source.naturalWidth || source.width;
        canvas.height = source.naturalHeight || source.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');

        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height);
        throwIfImageOperationAborted(signal);
        const pixels = inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines);
        sourcePixels.data.set(pixels);
        await checkImageCancellation(signal);
        context.putImageData(sourcePixels, 0, 0);

        const renderedLines = translatedLines.map(line => ({
            ...line,
            backgroundColor: getImageTextBackgroundColor(pixels, canvas.width, canvas.height, line.bbox),
        }));
        renderedLines.forEach(line => {
            throwIfImageOperationAborted(signal);
            const paddingX = Math.max(3, Math.round((line.bbox.y1 - line.bbox.y0) * 0.14));
            const paddingY = Math.max(2, Math.round((line.bbox.y1 - line.bbox.y0) * 0.18));
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
            );
        });

        await checkImageCancellation(signal);
        const image = canvas.toDataURL('image/png');
        throwIfImageOperationAborted(signal);
        return { image, lines: renderedLines };
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
): Promise<OffscreenImageTranslationResult> {
    // 提前验证输出预算，避免巨大输入完成 OCR 和付费翻译后才在生成译图时失败。
    const source = await loadImage(image, signal);
    try {
        throwIfImageOperationAborted(signal);
        reportProgress(requestId, 'recognizing');
        const lines = await recognizeImage(image, sourceLanguage, signal, {
            onProgress: percent => { if (!signal?.aborted) reportProgress(requestId, 'recognizing', percent); },
        });
        throwIfImageOperationAborted(signal);
        if (lines.length === 0) throw new Error('没有识别到图片文字');
        reportProgress(requestId, 'translating');
        const translations = await translateImageTextsInExtension(
            lines.map(line => line.text), title, requestId, signal,
        );
        throwIfImageOperationAborted(signal);
        reportProgress(requestId, 'rendering');
        return await prepareTranslatedImage(source, lines, translations, signal);
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
