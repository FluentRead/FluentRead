/**
 * @file src/features/image-translation/services/offscreenImageIo.ts
 * 文件职责：封装 Offscreen 图片翻译的图像解码校验、取消信号让出、进度上报、跨上下文文本批译与选区裁剪 I/O 能力。
 * 主要内容：提供带尺寸和超时预算的图像加载器、事件循环取消检查、旁路进度通知、扩展后台文字翻译 RPC 及可取消的 Canvas 选区裁剪。
 * 模块边界：仅处理 Offscreen 侧基础图像与消息 I/O，不执行 OCR 推理、文本排版、Alpha 保护或像素修补算法。
 */
import {createImageTranslationFailure} from '../failure';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import type {OcrLine} from '@/src/features/image-translation/core';
import {areaRectToImageCrop, type AreaTranslationSelection} from '@/src/features/area-translation/protocol';
import {encodeImageCanvas} from './imageEncoding';

const IMAGE_TEXT_TRANSLATION_TIMEOUT_MS = 120_000;
const IMAGE_DECODE_TIMEOUT_MS = 30_000;
const MAX_RENDER_IMAGE_PIXELS = 16_777_216;
const MAX_RENDER_IMAGE_SIDE = 8192;
let legacyImageTextRequestSequence = 0;

export function createImageOperationAbortError(): Error {
    const error = new Error('图片翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

export function throwIfImageOperationAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw createImageOperationAbortError();
}

export function loadImage(dataUrl: string, signal?: AbortSignal): Promise<HTMLImageElement> {
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
export async function checkImageCancellation(signal?: AbortSignal): Promise<void> {
    throwIfImageOperationAborted(signal);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    throwIfImageOperationAborted(signal);
}

export function reportProgress(requestId: string | undefined, stage: ImageTranslationStage, progress?: number): void {
    if (!requestId) return;
    // 进度是旁路；页面已关闭时不得影响取消与 OCR 主链。
    try { chrome.runtime.sendMessage({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId, stage, progress}, () => void chrome.runtime.lastError); } catch { /* 扩展上下文可能已销毁。 */ }
}

export async function translateImageTextsInExtension(
    texts: string[],
    title: string,
    requestId: string | undefined,
    signal?: AbortSignal,
    imageLabelSlots?: number[],
): Promise<{translations: string[]; targetLanguage?: string}> {
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
                ...(imageLabelSlots?.length ? {imageLabelSlots} : {}),
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
    const targetLanguage = typeof response.targetLanguage === 'string' ? response.targetLanguage : undefined;
    return {translations: response.translations, targetLanguage};
}

export async function cropImage(dataUrl: string, selection: AreaTranslationSelection, signal?: AbortSignal): Promise<string> {
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
