/**
 * @file src/features/image-translation/background/offscreenAdapter.ts
 * 文件职责：把跨域图片读取、图片识别、整图翻译和 OCR 语言包下载请求适配为平台 Offscreen 消息，并校验隔离文档返回的结构后交还后台 handlers。
 * 主要内容：回查原页面当前图片任务的短期授权；透传单图本地识别方式，包含 OffscreenResponse 解析、data:image 与 lines 数组验证、译图 image/lines 结果收窄，以及 createImageTranslationOffscreenAdapter 和默认 extensionDomClient 实例。
 * 模块边界：适配器不创建 Offscreen document、不执行 OCR/绘制，也不读取配置；文档生命周期属于 platform/offscreen，实际运算在 services/offscreenRuntime 与 ocrRuntime 中完成。
 */
import {createImageTranslationFailure} from '../failure';
import {extensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {withPixivImageReferrer} from './pixivImageReferrer';
import type {MangaDownloadState, MangaModelSource} from '../services/mangaOcrAssets';
import type {ImageProgressContext} from './handlers';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import type {ImageOcrLanguageCode} from '@/src/features/image-translation/ocrLanguages';
import type {OffscreenImageTranslationResult} from '@/src/features/image-translation/services/offscreenRuntime';
import {
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    type OffscreenClient,
} from '@/src/platform/offscreen/client';

import {parseMangaPatchPacket} from '../mangaPatchResult';

interface OffscreenResponse {
    readonly mangaPatches?: unknown;
    readonly imageUnchanged?: unknown;
    readonly success?: boolean;
    readonly error?: string;
    readonly errorCode?: unknown;
    readonly image?: unknown;
    readonly lines?: unknown;
}

export interface ImageOffscreenOperationOptions {
    readonly ocrEngine?: 'paddle';
    readonly documentUrl?: string;
    readonly manga?: true;
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
    manga = false,
): OffscreenImageTranslationResult {
    const unchanged = response?.imageUnchanged === true && !manga && response.image === '' && response.mangaPatches === undefined;
    if (!response?.success || (response.imageUnchanged !== undefined && !unchanged)
        || (typeof response.image !== 'string' && response.mangaPatches === undefined) || !Array.isArray(response.lines)
        || (unchanged && response.lines.length === 0)) {
        throw createImageTranslationFailure(errorMessage(response, fallback), response);
    }
    return {image: typeof response.image === 'string' ? response.image : '', lines: response.lines as OffscreenImageTranslationResult['lines'],
        ...(unchanged ? {imageUnchanged: true as const} : {}),
        ...(response.mangaPatches === undefined ? {} : {mangaPatches: parseMangaPatchPacket(response.mangaPatches)})};
}

function parseImageDataResult(response: OffscreenResponse | undefined, fallback: string): string {
    if (!response?.success || typeof response.image !== 'string' || !response.image.startsWith('data:image/')) {
        throw new Error(errorMessage(response, fallback));
    }
    return response.image;
}

/** 图片 feature 对平台 Offscreen client 的唯一适配器。 */
export function createImageTranslationOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    return {
        async getMangaModelStatus() {
            const response = await client.send<{success?:boolean;ready?:boolean;bytes?:number;inpaintingReady?:boolean;error?:string;source?:MangaModelSource;download?:MangaDownloadState}>({type:'FLUENT_READ_MANGA_MODEL_STATUS_OFFSCREEN'});
            if (!response?.success || typeof response.ready !== 'boolean' || typeof response.inpaintingReady !== 'boolean'
                || typeof response.bytes !== 'number' || !Number.isSafeInteger(response.bytes) || response.bytes < 0) throw new Error(errorMessage(response,'漫画识别模型状态读取失败'));
            return {ready:response.ready,bytes:response.bytes,inpaintingReady:response.inpaintingReady,
                ...(response.source ? {source:response.source} : {}),...(response.download ? {download:response.download} : {})};
        },
        async removeMangaModels() {
            const response = await client.send<OffscreenResponse>({type:'FLUENT_READ_MANGA_MODEL_REMOVE_OFFSCREEN'});
            if (!response?.success) throw new Error(errorMessage(response,'漫画识别模型清除失败'));
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
                ...(options?.manga ? {manga: true} : {}),
                ...(options?.ocrEngine ? {ocrEngine: options.ocrEngine} : {}),
                ...(options ? {requestId: options.requestId} : {}),
            } as const;
            const response = options
                ? await client.send<OffscreenResponse>(message, sendOptions(options))
                : await client.send<OffscreenResponse>(message);
            return parseTranslationResult(response, '图片翻译失败', options?.manga === true);
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
            return withPixivImageReferrer(url, options?.documentUrl, async () => {
                const response = options
                    ? await client.send<OffscreenResponse>(message, sendOptions(options))
                    : await client.send<OffscreenResponse>(message);
                return parseImageDataResult(response, '远程图片读取失败');
            });
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
    async sendProgress(context: ImageProgressContext, message: {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId: string; stage: ImageTranslationStage; progress?: number}): Promise<void> {
        const tabId = context.sender?.tab?.id;
        if (typeof tabId !== 'number') return;
        await browser.tabs.sendMessage(tabId, message, {frameId: context.sender?.frameId ?? 0}).catch(() => undefined);
    },
};

/** 后台回查同一 frame 的短期请求授权，扩展 UI 或任意 URL 消息不能直接发起远程抓图。 */
export function createImageSourceVerifier(
    sendTabMessage: (tabId: number, message: object, options: {frameId: number}) => Promise<unknown>,
) {
    return async (url: string, options: ImageOffscreenOperationOptions, context: ImageProgressContext): Promise<void> => {
        const sender = context.sender;
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId ?? 0;
        if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0
            || !Number.isSafeInteger(frameId) || frameId < 0 || typeof sender?.url !== 'string'
            || !/^(?:https?:|file:)\/\//u.test(sender.url)) throw new Error('图片来源未授权');
        if (options.signal.aborted) throw new Error('图片读取已取消');
        let response: unknown;
        try {
            response = await sendTabMessage(tabId, {
                type: 'fluentReadImageValidateSource', requestId: options.requestId, url, documentUrl: sender.url,
            }, {frameId});
        } catch { throw new Error('图片来源已失效，请重试'); }
        if (options.signal.aborted) throw new Error('图片读取已取消');
        if (!response || typeof response !== 'object' || (response as {valid?: unknown}).valid !== true) {
            throw new Error('图片来源已失效，请重试');
        }
    };
}

export const imageTranslationSourceTransport = {
    assertImageSource: createImageSourceVerifier((tabId, message, options) => browser.tabs.sendMessage(tabId, message, options)),
};
