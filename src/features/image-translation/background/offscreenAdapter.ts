/**
 * @file src/features/image-translation/background/offscreenAdapter.ts
 * 文件职责：把跨域图片读取、图片识别、整图翻译和 OCR 语言包下载请求适配为平台 Offscreen 消息，并校验隔离文档返回的结构后交还后台 handlers。
 * 主要内容：包含 OffscreenResponse 解析、data:image 与 lines 数组验证、译图 image/lines 结果收窄，以及 createImageTranslationOffscreenAdapter 和默认 chromeOffscreenClient 实例。
 * 模块边界：适配器不创建 Offscreen document、不执行 OCR/绘制，也不读取配置；文档生命周期属于 platform/offscreen，实际运算在 services/offscreenRuntime 与 ocrRuntime 中完成。
 */
import type {ImageProgressContext} from './handlers';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import type {OcrLine} from '@/src/features/image-translation/core';
import type {ImageOcrLanguageCode} from '@/src/features/image-translation/ocrLanguages';
import type {OffscreenImageTranslationResult} from '@/src/features/image-translation/services/offscreenRuntime';
import {
    chromeOffscreenClient,
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    type OffscreenClient,
} from '@/src/platform/offscreen/client';

interface OffscreenResponse {
    readonly success?: boolean;
    readonly error?: string;
    readonly image?: unknown;
    readonly lines?: unknown;
}

export interface ImageOffscreenOperationOptions {
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
}

function sendOptions(options: ImageOffscreenOperationOptions) {
    return {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        cancelMessage: {
            type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
            requestId: options.requestId,
        },
    };
}

function errorMessage(response: OffscreenResponse | undefined, fallback: string): string {
    return typeof response?.error === 'string' && response.error ? response.error : fallback;
}

function parseTranslationResult(
    response: OffscreenResponse | undefined,
    fallback: string,
): OffscreenImageTranslationResult {
    if (!response?.success || typeof response.image !== 'string' || !Array.isArray(response.lines)) {
        throw new Error(errorMessage(response, fallback));
    }
    return {image: response.image, lines: response.lines as OffscreenImageTranslationResult['lines']};
}

function parseImageDataResult(response: OffscreenResponse | undefined, fallback: string): string {
    if (!response?.success || typeof response.image !== 'string' || !response.image.startsWith('data:image/')) {
        throw new Error(errorMessage(response, fallback));
    }
    return response.image;
}

/** 图片 feature 对平台 Offscreen client 的唯一适配器。 */
export function createImageTranslationOffscreenAdapter(client: OffscreenClient = chromeOffscreenClient) {
    return {
        async recognizeImage(
            image: string,
            sourceLanguage: string,
            options?: ImageOffscreenOperationOptions,
        ): Promise<OcrLine[]> {
            const message = {
                type: 'FLUENT_READ_IMAGE_OCR_OFFSCREEN',
                image,
                sourceLanguage,
                ...(options ? {requestId: options.requestId} : {}),
            } as const;
            const response = options
                ? await client.send<OffscreenResponse>(message, sendOptions(options))
                : await client.send<OffscreenResponse>(message);
            if (!response?.success || !Array.isArray(response.lines)) {
                throw new Error(errorMessage(response, '图片 OCR 失败'));
            }
            return response.lines as OcrLine[];
        },

        async translateImage(
            image: string,
            sourceLanguage: string,
            title: string,
            options?: ImageOffscreenOperationOptions,
        ): Promise<OffscreenImageTranslationResult> {
            const message = {
                type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
                image,
                sourceLanguage,
                title,
                ...(options ? {requestId: options.requestId} : {}),
            } as const;
            const response = options
                ? await client.send<OffscreenResponse>(message, sendOptions(options))
                : await client.send<OffscreenResponse>(message);
            return parseTranslationResult(response, '图片翻译失败');
        },

        async fetchImage(
            url: string,
            options?: ImageOffscreenOperationOptions,
        ): Promise<string> {
            const message = {
                type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
                url,
                ...(options ? {requestId: options.requestId} : {}),
            } as const;
            const response = options
                ? await client.send<OffscreenResponse>(message, sendOptions(options))
                : await client.send<OffscreenResponse>(message);
            return parseImageDataResult(response, '远程图片读取失败');
        },

        async removeLanguages(languages: ImageOcrLanguageCode[]): Promise<void> {
            const response = await client.send<OffscreenResponse>({type: 'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN', languages});
            if (!response?.success) throw new Error(errorMessage(response, '图片 OCR 语言包清除失败'));
        },
        async downloadLanguages(languages: ImageOcrLanguageCode[]): Promise<void> {
            const response = await client.send<OffscreenResponse>({
                type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN',
                languages,
            });
            if (!response?.success) throw new Error(errorMessage(response, '图片 OCR 语言包下载失败'));
        },
    };
}

export const imageTranslationOffscreenAdapter = createImageTranslationOffscreenAdapter();

/** 只把可信 Offscreen 阶段发送给发起任务的 frame，导航后的无接收端是正常清理。 */
export const imageTranslationProgressTransport = {
    isOffscreenSender(context: ImageProgressContext): boolean {
        return context.sender?.url === browser.runtime.getURL('/offscreen.html');
    },
    async sendProgress(context: ImageProgressContext, message: {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId: string; stage: ImageTranslationStage}): Promise<void> {
        const tabId = context.sender?.tab?.id;
        if (typeof tabId !== 'number') return;
        await browser.tabs.sendMessage(tabId, message, {frameId: context.sender?.frameId ?? 0}).catch(() => undefined);
    },
};
