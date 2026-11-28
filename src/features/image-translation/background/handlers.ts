/**
 * @file src/features/image-translation/background/handlers.ts
 * 图片与漫画的后端偏好仅从后台当前配置读取，并随已有可取消任务发送。
 * 文件职责：定义跨域图片读取、整图翻译、文本批译、阶段进度、取消和语言包下载后台消息，并编排各项后台 handler 的入口分发。
 * 主要内容：组合任务取消登记表、OCR 语言包串行下载/移除队列及文本翻译流水线；按设置选择单图 OCR，标准字表之外的受支持源语走按需语言包，其他漫画走 PaddleOCR；将结构化错误与阶段进度转发给对应标签页。
 * 模块边界：可选漫画可见范围保留原值交给最终绘制端校验，不把异常空值降为缺省；本文件只负责协议入口与用例编排，不直接运行 Tesseract、Canvas、网络 fetch 或 Offscreen；参数校验归 operationRegistry，文本批译流水线归 imageTextTranslator。
 */
import {normalizeRemoteImageUrl} from '../services/remoteImage';
import type {ImageViewport} from '@/src/shared/image/types';
import {imageTranslationFailureCode, imageTranslationFailureResponse} from '../failure';
import {IMAGE_PROGRESS_MESSAGE_TYPE, isImageTranslationStage, normalizeImageProgress, type ImageTranslationStage} from '../progress';
import {
    getImageOcrEngine,
    type ImageOcrLanguageCode,
    type ImageOcrDownloadState,
} from '@/src/features/image-translation/ocrLanguages';
import {
    IMAGE_OPERATION_TIMEOUT_MS,
    createImageOperationRegistry,
    imageAbortError,
    parseDataImage,
    parseObjectResult,
    parseOcrLanguages,
    parseOptionalTitle,
    parseRequestId,
    parseRequiredString,
    parseTexts,
    type ImageOperationMessage,
    type ImageOperationOptions,
    type ImageOperationRegistry,
} from './operationRegistry';
import {
    IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
    IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
    translateImageTexts,
    type ImageTextTranslationDependencies,
    type ImageTranslateTextsMessage,
} from './imageTextTranslator';

export {
    IMAGE_OPERATION_TIMEOUT_MS,
    IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
    IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
    createImageOperationRegistry,
    type ImageOperationMessage,
    type ImageOperationOptions,
    type ImageOperationRegistry,
    type ImageTranslateTextsMessage,
};

export const IMAGE_TRANSLATE_MESSAGE_TYPE = 'fluentReadImageTranslate' as const;
export const IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE = 'fluentReadImageOcrDownload' as const;
export const IMAGE_CANCEL_MESSAGE_TYPE = 'fluentReadImageCancel' as const;
export const IMAGE_FETCH_MESSAGE_TYPE = 'fluentReadImageFetch' as const;

export interface ImageTranslateMessage {
    manga?: unknown;
    mangaViewport?: ImageViewport;
    type: typeof IMAGE_TRANSLATE_MESSAGE_TYPE;
    image?: unknown;
    sourceLanguage?: unknown;
    title?: unknown;
    requestId?: unknown;
    timeoutMs?: unknown;
}

export interface ImageCancelMessage {
    type: typeof IMAGE_CANCEL_MESSAGE_TYPE;
    requestId?: unknown;
}

export interface ImageOcrDownloadMessage {
    type: typeof IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE | 'fluentReadImageOcrRemove';
    languages?: unknown;
}

export interface ImageFetchMessage {
    type: typeof IMAGE_FETCH_MESSAGE_TYPE;
    url?: unknown;
    requestId?: unknown;
    timeoutMs?: unknown;
}

export interface ImageProgressContext {readonly sender?: {readonly tab?: {readonly id?: number}; readonly frameId?: number; readonly url?: string}}
export interface ImageProgressMessage {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId?: unknown; stage?: unknown; progress?: unknown}

export type ImageTranslationBackgroundMessage =
    | {type: 'fluentReadImageOcrStatus'}
    | {type: 'fluentReadMangaModelStatus' | 'fluentReadMangaModelRemove'}
    | ImageProgressMessage
    | ImageTranslateMessage
    | ImageTranslateTextsMessage
    | ImageOcrDownloadMessage
    | ImageFetchMessage
    | ImageCancelMessage;

export interface ImageTranslationBackgroundDependencies extends ImageTextTranslationDependencies {
    readonly getImageOcrEngine?: () => 'tesseract' | 'paddle';
    readonly getImageInferenceBackend?: () => 'auto' | 'cpu';
    readonly getMangaModelStatus?: () => Promise<{ready: boolean; bytes: number; inpaintingReady: boolean; segmentationReady?: boolean}>;
    readonly removeMangaModels?: () => Promise<void>;
    readonly assertLanguagesDownloaded: (sourceLanguage: string) => Promise<void>;
    readonly translateImage: (
        image: string,
        sourceLanguage: string,
        title: string,
        options: ImageOperationOptions,
    ) => Promise<unknown>;
    readonly fetchImage: (url: string, options: ImageOperationOptions) => Promise<unknown>;
    readonly assertImageSource?: (url: string, options: ImageOperationOptions, context: ImageProgressContext) => Promise<void>;
    readonly removeLanguages?: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly markLanguagesRemoved?: (languages: ImageOcrLanguageCode[]) => Promise<ImageOcrLanguageCode[]>;
    readonly getDownloadedLanguages?: () => Promise<ImageOcrLanguageCode[]>;
    readonly downloadLanguages: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly markLanguagesDownloaded: (languages: ImageOcrLanguageCode[]) => Promise<ImageOcrLanguageCode[]>;
    readonly sendProgress?: (context: ImageProgressContext, message: {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId: string; stage: ImageTranslationStage; progress?: number}) => Promise<void>;
    readonly isOffscreenSender?: (context: ImageProgressContext) => boolean;
}

export interface ImageTranslationBackgroundHandler<TMessage extends ImageTranslationBackgroundMessage> {
    readonly type: TMessage['type'];
    handle(message: TMessage, context?: ImageProgressContext): Promise<unknown>;
}

/** 创建图片 OCR/翻译/取消/语言包下载 handlers。 */
export function createImageTranslationBackgroundHandlers(
    dependencies: ImageTranslationBackgroundDependencies,
): ImageTranslationBackgroundHandler<ImageTranslationBackgroundMessage>[] {
    const operationRegistry = createImageOperationRegistry('image');
    const textOperationRegistry = createImageOperationRegistry('image-text');
    const progressOwners = new Map<string, {context: ImageProgressContext}>();

    // 语言包任务属于后台而非设置组件，关闭/重开设置仍可恢复真实排队状态。
    const modelStates = new Map<ImageOcrLanguageCode, ImageOcrDownloadState>();
    const pendingDownloads = new Map<ImageOcrLanguageCode, Promise<ImageOcrLanguageCode[]>>();
    let modelMutationTail: Promise<unknown> = Promise.resolve();
    const mutateModels = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = modelMutationTail.then(operation, operation);
        modelMutationTail = result.then(() => undefined, () => undefined);
        return result;
    };
    const downloadOne = (language: ImageOcrLanguageCode): Promise<ImageOcrLanguageCode[]> => {
        const existing = pendingDownloads.get(language);
        if (existing) return existing;
        modelStates.set(language, {phase: 'queued'});
        const pending = mutateModels(async () => {
            try {
                const downloaded = await dependencies.getDownloadedLanguages?.();
                if (downloaded?.includes(language)) {
                    modelStates.delete(language);
                    return downloaded;
                }
                modelStates.set(language, {phase: 'downloading'});
                await dependencies.downloadLanguages([language]);
                // 每个包单独落库，后续失败不会丢失已完成的进度。
                const languages = await dependencies.markLanguagesDownloaded([language]);
                modelStates.delete(language);
                return languages;
            } catch (error) {
                modelStates.set(language, {phase: 'error', error: error instanceof Error ? error.message : String(error)});
                throw error;
            }
        }).finally(() => {
            if (pendingDownloads.get(language) === pending) pendingDownloads.delete(language);
        });
        pendingDownloads.set(language, pending);
        return pending;
    };
    return [
        {
            type: 'fluentReadMangaModelStatus',
            async handle() {
                if (!dependencies.getMangaModelStatus) throw new Error('漫画识别模型管理不可用');
                return {success: true, ...await dependencies.getMangaModelStatus()};
            },
        },
        {
            type: 'fluentReadMangaModelRemove',
            async handle() {
                if (!dependencies.removeMangaModels) throw new Error('漫画识别模型管理不可用');
                await dependencies.removeMangaModels();
                return {success: true};
            },
        },
        {
            type: 'fluentReadImageOcrStatus',
            async handle() {
                const languages = await dependencies.getDownloadedLanguages?.() ?? [];
                return {success: true, languages, states: Object.fromEntries(modelStates)};
            },
        },
        {
            type: IMAGE_PROGRESS_MESSAGE_TYPE,
            async handle(message: ImageProgressMessage, context: ImageProgressContext = {}) {
                if (!dependencies.isOffscreenSender?.(context) || !isImageTranslationStage(message.stage)) return {success: false};
                const requestId = parseRequestId(message.requestId);
                const owner = progressOwners.get(requestId);
                if (owner) await dependencies.sendProgress?.(owner.context, {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId, stage: message.stage, progress: normalizeImageProgress(message.progress)});
                return {success: true};
            },
        },
        {
            type: IMAGE_TRANSLATE_MESSAGE_TYPE,
            async handle(message: ImageTranslateMessage, context: ImageProgressContext = {}) {
                const image = parseDataImage(message.image);
                const sourceLanguage = parseRequiredString(message.sourceLanguage, 'sourceLanguage');
                const title = parseOptionalTitle(message.title);
                if (message.manga !== undefined && typeof message.manga !== 'boolean') throw new TypeError('漫画翻译模式无效');
                try {
                    const result = parseObjectResult(
                        await operationRegistry.run(message, async (options) => {
                            const paddle = getImageOcrEngine(sourceLanguage, message.manga ? 'paddle' : dependencies.getImageOcrEngine?.()) === 'paddle';
                            if (!paddle) await dependencies.assertLanguagesDownloaded(sourceLanguage);
                            if (options.signal.aborted) throw imageAbortError(false);
                            const progressOwner = {context};
                            progressOwners.set(options.requestId, progressOwner);
                            const clearProgressOwner = () => {
                                if (progressOwners.get(options.requestId) === progressOwner) progressOwners.delete(options.requestId);
                            };
                            options.signal.addEventListener('abort', clearProgressOwner, {once: true});
                            try {
                                const scopedOptions = message.manga ? {...options, manga: true as const} : paddle ? {...options, ocrEngine: 'paddle' as const} : options;
                                const inferenceBackend = dependencies.getImageInferenceBackend?.();
                                return await dependencies.translateImage(image, sourceLanguage, title,
                                    {...scopedOptions, ...(inferenceBackend ? {inferenceBackend} : {}),
                                        ...(message.mangaViewport !== undefined ? {mangaViewport: message.mangaViewport} : {})});
                            } finally {
                                clearProgressOwner();
                                options.signal.removeEventListener('abort', clearProgressOwner);
                            }
                        }),
                        '图片翻译',
                    );
                    return {success: true, ...result};
                } catch (error) {
                    if (!imageTranslationFailureCode(error)) throw error;
                    return imageTranslationFailureResponse(error);
                }
            },
        },
        {
            type: IMAGE_FETCH_MESSAGE_TYPE,
            async handle(message: ImageFetchMessage, context: ImageProgressContext = {}) {
                const source = parseRequiredString(message.url, 'url');
                const url = normalizeRemoteImageUrl(source);
                const image = await operationRegistry.run(message, async options => {
                    if (!dependencies.assertImageSource) throw new Error('图片来源未授权');
                    await dependencies.assertImageSource(source, options, context);
                    if (options.signal.aborted) throw Object.assign(new Error('图片读取已取消'), {name: 'AbortError'});
                    return dependencies.fetchImage(url, {...options, ...(context.sender?.url ? {documentUrl: context.sender.url} : {})});
                });
                if (typeof image !== 'string' || !image.startsWith('data:image/')) {
                    throw new Error('远程图片结果无效');
                }
                return {success: true, image};
            },
        },
        {
            type: IMAGE_CANCEL_MESSAGE_TYPE,
            async handle(message: ImageCancelMessage) {
                const image = operationRegistry.cancel(message.requestId);
                const text = textOperationRegistry.cancel(message.requestId);
                return {...image, cancelled: image.cancelled || text.cancelled};
            },
        },
        {
            type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
            async handle(message: ImageTranslateTextsMessage) {
                const texts = parseTexts(message.texts);
                try {
                    const result = await textOperationRegistry.run(message, options => translateImageTexts(
                        texts, parseOptionalTitle(message.title), dependencies, options, message,
                    ));
                    return {success: true, ...result};
                } catch (error) {
                    if (!imageTranslationFailureCode(error)) throw error;
                    return imageTranslationFailureResponse(error);
                }
            },
        },
        {
            type: 'fluentReadImageOcrRemove',
            async handle(message: ImageOcrDownloadMessage) {
                const languages = parseOcrLanguages(message.languages);
                if (!dependencies.removeLanguages || !dependencies.markLanguagesRemoved) throw new Error('语言包清除不可用');
                // 删除后的新下载必须排在删除之后，不能复用删除之前尚在结束的任务。
                languages.forEach(language => pendingDownloads.delete(language));
                return mutateModels(async () => {
                    languages.forEach(language => modelStates.set(language, {phase: 'removing'}));
                    try {
                        await dependencies.removeLanguages!(languages);
                        const remaining = await dependencies.markLanguagesRemoved!(languages);
                        return {success: true, languages: remaining};
                    } finally {
                        languages.forEach(language => modelStates.delete(language));
                    }
                });
            },
        },
        {
            type: IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE,
            async handle(message: ImageOcrDownloadMessage) {
                const languages = parseOcrLanguages(message.languages);
                // 接住每个排队任务的失败并继续准备其他语言，调用方最后获得完整结果或明确错误。
                const results = await Promise.allSettled(languages.map(downloadOne));
                const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
                if (failed) throw failed.reason;
                const last = results[results.length - 1] as PromiseFulfilledResult<ImageOcrLanguageCode[]>;
                return {success: true, languages: await dependencies.getDownloadedLanguages?.() ?? last.value};
            },
        },
    ];
}
