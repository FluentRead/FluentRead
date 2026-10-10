/**
 * @file src/features/image-translation/background/handlers.ts
 * 文件职责：定义跨域图片读取、整图翻译、文本批译、阶段进度、取消和语言包下载后台消息，并对来自页面或扩展 UI 的未知输入执行严格校验。
 * 主要内容：按设置选择单图 OCR，漫画俄语和韩语要求既有语言包，其他漫画走 PaddleOCR；包含消息解析、OCR 语言白名单、阶段通知和取消预算，待启动取消只保留尚未消费的有界 ID，避免旧历史误删重复 ID 的新取消；逐包下载排队、去重、部分成功保存和跨页状态查询；图片文本冻结目标语言，统一过滤同目标正文与无需翻译的标识，保留显式术语覆盖；去重批量和有界并发翻译同时保留原行映射、可信页面范围与术语版本。
 * 模块边界：本文件只负责协议入口与用例编排，不直接运行 Tesseract、Canvas、网络 fetch 或 Offscreen；图像读取和运算能力均由 Offscreen adapter 与 services 实现并由 app 注入。
 */
import {normalizeRemoteImageUrl} from '../services/remoteImage';
import {createImageTranslationFailure, imageTranslationFailureCode, imageTranslationFailureResponse} from '../failure';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {segmentScriptWords} from '@/src/core/language/scripts';
import {hasTranslatableText} from '@/src/core/translation/resultValidation';
import {resolveGlossaryEntries, type GlossaryLibrary} from '@/src/core/glossary';
import {IMAGE_PROGRESS_MESSAGE_TYPE, isImageTranslationStage, normalizeImageProgress, type ImageTranslationStage} from '../progress';
import {
    IMAGE_OCR_LANGUAGE_PACKS,
    getMangaOcrEngine,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
    type ImageOcrDownloadState,
} from '@/src/features/image-translation/ocrLanguages';
import {
    attachTranslationRequestControl,
    attachTranslationGlossaryContext,
    getTranslationGlossaryContext,
    markTranslationRemainingBudget,
} from '@/src/services/translation/requestSnapshot';

export const IMAGE_TRANSLATE_MESSAGE_TYPE = 'fluentReadImageTranslate' as const;
export const IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE = 'fluentReadImageTranslateTexts' as const;
export const IMAGE_OCR_DOWNLOAD_MESSAGE_TYPE = 'fluentReadImageOcrDownload' as const;
export const IMAGE_CANCEL_MESSAGE_TYPE = 'fluentReadImageCancel' as const;
export const IMAGE_FETCH_MESSAGE_TYPE = 'fluentReadImageFetch' as const;
export const IMAGE_OPERATION_TIMEOUT_MS = 180_000;

export interface ImageTranslateMessage {
    manga?: unknown;
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

export interface ImageTranslateTextsMessage {
    type: typeof IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE;
    texts?: unknown;
    title?: unknown;
    requestId?: unknown;
    timeoutMs?: unknown;
    /** 仅在组合根附加的内部术语上下文存在时读取，普通 runtime 字段本身不构成信任。 */
    glossaryRevision?: unknown;
    sourceLanguage?: unknown;
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

type ImageTextTranslationRequestBase = {
    context: string;
    pageContext: '';
    useCache: true;
    serviceOverride: string;
    requestTimeoutMs: number;
    sourceLanguageDetectionText?: string;
    glossaryRevision?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
};

type ImageTextTranslationRequest = ImageTextTranslationRequestBase & (
    | {origin: string}
    | {origin: string[]}
);

export interface ImageTranslationBackgroundDependencies {
    readonly getImageOcrEngine?: () => 'tesseract' | 'paddle';
    readonly getMangaModelStatus?: () => Promise<{ready: boolean; bytes: number; inpaintingReady: boolean}>;
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
    readonly getTranslationService: () => string;
    readonly supportsBatchTranslation: (service: string) => boolean;
    /** 明确的用户固定译名优先于标识跳过策略；组合根只提供当前配置。 */
    readonly getGlossaryConfig?: () => {glossaryEnabled: boolean; glossaryLibraries: GlossaryLibrary[]; from: string; to: string};
    readonly translateTexts: (request: ImageTextTranslationRequest) => Promise<string | string[]>;
    readonly removeLanguages?: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly markLanguagesRemoved?: (languages: ImageOcrLanguageCode[]) => Promise<ImageOcrLanguageCode[]>;
    readonly getDownloadedLanguages?: () => Promise<ImageOcrLanguageCode[]>;
    readonly downloadLanguages: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly markLanguagesDownloaded: (languages: ImageOcrLanguageCode[]) => Promise<ImageOcrLanguageCode[]>;
    readonly now?: () => number;
    readonly sendProgress?: (context: ImageProgressContext, message: {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId: string; stage: ImageTranslationStage; progress?: number}) => Promise<void>;
    readonly isOffscreenSender?: (context: ImageProgressContext) => boolean;
}

export interface ImageOperationOptions {
    readonly ocrEngine?: 'paddle';
    /** 仅由已复核的消息 sender 提供，不接受消息体自报来源。 */
    readonly documentUrl?: string;
    readonly manga?: true;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
}

export interface ImageOperationMessage {
    readonly requestId?: unknown;
    readonly timeoutMs?: unknown;
}

export interface ImageOperationRegistry {
    run<T>(message: ImageOperationMessage, operation: (options: ImageOperationOptions) => Promise<T>): Promise<T>;
    cancel(requestId: unknown): {success: true; cancelled: boolean; requestId: string};
}

export interface ImageTranslationBackgroundHandler<TMessage extends ImageTranslationBackgroundMessage> {
    readonly type: TMessage['type'];
    handle(message: TMessage, context?: ImageProgressContext): Promise<unknown>;
}

const SUPPORTED_OCR_LANGUAGES = new Set(IMAGE_OCR_LANGUAGE_PACKS.map((pack) => pack.code));
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_IMAGE_OPERATION_TIMEOUT_MS = 300_000;
export const IMAGE_TEXT_TRANSLATION_TIMEOUT_MS = 120_000;

function parseDataImage(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('data:image/')) {
        throw new TypeError('图片数据无效');
    }
    return value;
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`图片翻译 ${field} 必须是非空字符串`);
    }
    return value;
}

function parseOptionalTitle(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new TypeError('图片翻译 title 必须是字符串');
    return value;
}

function parseRequestId(value: unknown): string {
    const requestId = parseRequiredString(value, 'requestId');
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError('图片翻译 requestId 格式无效');
    return requestId;
}

function parseTimeoutMs(value: unknown): number {
    if (value === undefined) return IMAGE_OPERATION_TIMEOUT_MS;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError('图片翻译 timeoutMs 必须是正数');
    }
    return Math.min(MAX_IMAGE_OPERATION_TIMEOUT_MS, Math.floor(value));
}

function imageAbortError(timedOut: boolean): Error {
    const error = new Error(timedOut ? '图片 OCR 请求超时' : '图片 OCR 请求已取消');
    error.name = timedOut ? 'TimeoutError' : 'AbortError';
    return error;
}

/** 图片与圈选 feature 共用的后台取消所有权，确保它们不会各自遗漏共享 OCR 队列。 */
export function createImageOperationRegistry(legacyPrefix = 'image'): ImageOperationRegistry {
    const activeOperations = new Map<string, AbortController>();
    const cancelledBeforeStart = new Set<string>();
    let legacyRequestSequence = 0;

    const rememberCancellation = (requestId: string) => {
        if (cancelledBeforeStart.has(requestId)) return;
        cancelledBeforeStart.add(requestId);
        // Set 只保留未消费的取消及其插入顺序，避免已消费 ID 的旧队列项误删后续取消。
        if (cancelledBeforeStart.size > 512) {
            cancelledBeforeStart.delete(cancelledBeforeStart.values().next().value!);
        }
    };

    return {
        async run<T>(
            message: ImageOperationMessage,
            operation: (options: ImageOperationOptions) => Promise<T>,
        ): Promise<T> {
            const requestId = message.requestId === undefined
                ? `legacy-${legacyPrefix}-${++legacyRequestSequence}`
                : parseRequestId(message.requestId);
            if (cancelledBeforeStart.delete(requestId)) throw imageAbortError(false);
            if (activeOperations.has(requestId)) throw new Error('图片 OCR requestId 正在执行');
            const timeoutMs = parseTimeoutMs(message.timeoutMs);
            const controller = new AbortController();
            activeOperations.set(requestId, controller);
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs);

            try {
                const pending = Promise.resolve().then(() => operation({
                    requestId,
                    signal: controller.signal,
                    timeoutMs,
                }));
                return await new Promise<T>((resolve, reject) => {
                    let settled = false;
                    const cleanup = () => controller.signal.removeEventListener('abort', handleAbort);
                    const finish = (callback: () => void) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        callback();
                    };
                    const handleAbort = () => finish(() => reject(imageAbortError(timedOut)));
                    controller.signal.addEventListener('abort', handleAbort, {once: true});
                    void pending.then(
                        result => finish(() => resolve(result)),
                        error => finish(() => reject(error)),
                    );
                });
            } finally {
                clearTimeout(timer);
                if (activeOperations.get(requestId) === controller) activeOperations.delete(requestId);
            }
        },
        cancel(requestIdValue) {
            const requestId = parseRequestId(requestIdValue);
            const controller = activeOperations.get(requestId);
            if (controller) controller.abort();
            else rememberCancellation(requestId);
            return {success: true, cancelled: Boolean(controller), requestId};
        },
    };
}

function parseTexts(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('图片中没有可翻译文字');
    if (!value.every((text): text is string => typeof text === 'string' && text.trim().length > 0)) {
        throw new TypeError('图片翻译 texts 只能包含非空字符串');
    }
    return [...value];
}

function parseOcrLanguages(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('OCR 语言包列表不能为空');
    if (!value.every((language): language is ImageOcrLanguageCode =>
        typeof language === 'string' && SUPPORTED_OCR_LANGUAGES.has(language as ImageOcrLanguageCode))) {
        throw new TypeError('OCR 语言包列表包含不支持的语言');
    }
    return normalizeImageOcrLanguageCodes(value);
}

function parseObjectResult(value: unknown, operation: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${operation}结果无效`);
    }
    return value as Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function translateImageTexts(
    texts: string[],
    title: string,
    dependencies: ImageTranslationBackgroundDependencies,
    options: ImageOperationOptions,
    message: ImageTranslateTextsMessage,
): Promise<string[]> {
    if (options.signal.aborted) throw imageAbortError(false);
    const glossaryContext = getTranslationGlossaryContext(message);
    const sourceLanguage = glossaryContext ? parseRequiredString(message.sourceLanguage, 'sourceLanguage') : undefined;
    const glossaryConfig = dependencies.getGlossaryConfig?.();
    const targetLanguage = glossaryConfig?.to;
    const uniqueTexts = [...new Set(texts)].filter(text => {
        const hasExplicitGlossary = glossaryConfig?.glossaryEnabled && resolveGlossaryEntries(glossaryConfig.glossaryLibraries, {
            text, sourceLanguage: sourceLanguage ?? glossaryConfig.from, targetLanguage: glossaryConfig.to,
            pageUrl: glossaryContext?.pageUrl,
        }).terms.length > 0;
        if (hasExplicitGlossary) return true;
        return hasTranslatableText(text)
            && (!targetLanguage || !shouldSkipTranslationForTarget(text, targetLanguage));
    });
    // 不删 OCR 行，阅读面板与图片坐标仍以原行对齐；纯标识整图无需外发请求。
    if (uniqueTexts.length === 0) return [...texts];
    const service = dependencies.getTranslationService();
    const imageDetectionText = uniqueTexts.join('\n');
    // 只借用可靠、单一文字体系的同图上下文；混合语种不能把短外语词误判成目标语言而漏译。
    const useImageDetectionText = service === 'localTranslation'
        && identifyTextLanguage(imageDetectionText).status === 'identified'
        && new Set(segmentScriptWords(imageDetectionText).map(word => word.script)).size === 1;
    const now = dependencies.now ?? (() => performance.now());
    const deadline = now() + Math.min(options.timeoutMs, IMAGE_TEXT_TRANSLATION_TIMEOUT_MS);
    const baseRequest = {
        context: title,
        pageContext: '' as const,
        useCache: true as const,
        serviceOverride: service,
        ...(targetLanguage ? {targetLanguage} : {}),
        ...(glossaryContext ? {
            glossaryRevision: parseRequiredString(message.glossaryRevision, 'glossaryRevision'),
            sourceLanguage: parseRequiredString(message.sourceLanguage, 'sourceLanguage'),
        } : {}),
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal.aborted) abort();
    options.signal.addEventListener('abort', abort, {once: true});
    const remainingBudget = () => {
        if (controller.signal.aborted) throw imageAbortError(false);
        const remaining = Math.floor(deadline - now());
        if (remaining <= 0) throw new Error('图片文字翻译总时间已耗尽');
        return remaining;
    };
    const controlledRequest = <T extends ImageTextTranslationRequest>(request: T) => {
        const controlled = attachTranslationRequestControl(markTranslationRemainingBudget(request), {
            signal: controller.signal, ownershipKey: `image:${options.requestId}`,
        });
        return glossaryContext ? attachTranslationGlossaryContext(controlled, glossaryContext) : controlled;
    };
    try {
        let translations: string[];
        if (dependencies.supportsBatchTranslation(service)) {
            try {
                const result = await dependencies.translateTexts(controlledRequest({
                    ...baseRequest, origin: uniqueTexts, requestTimeoutMs: remainingBudget(),
                }));
                if (!Array.isArray(result) || result.length !== uniqueTexts.length
                    || !result.every(value => typeof value === 'string' && value.trim())) {
                    throw new Error('provider 未返回等长非空字符串数组');
                }
                translations = result;
            } catch (error) {
                throw createImageTranslationFailure(`图片文字批量翻译失败：${getErrorMessage(error)}`, error);
            }
        } else {
            translations = new Array<string>(uniqueTexts.length);
            let cursor = 0;
            let failed = false;
            // 窗口最多三条，实际供应商并发仍由共享 broker 限流；保序且重复文案只翻译一次。
            const worker = async () => {
                while (cursor < uniqueTexts.length && !failed) {
                    const index = cursor++;
                    try {
                        const translation = await dependencies.translateTexts(controlledRequest({
                            ...baseRequest, origin: uniqueTexts[index], requestTimeoutMs: remainingBudget(),
                            ...(useImageDetectionText && identifyTextLanguage(uniqueTexts[index]).status === 'unknown'
                                ? {sourceLanguageDetectionText: imageDetectionText} : {}),
                        }));
                        if (typeof translation !== 'string') throw new Error('provider 未返回字符串译文');
                        if (!translation.trim()) throw new Error('provider 返回空白译文');
                        translations[index] = translation;
                    } catch (error) {
                        failed = true;
                        controller.abort();
                        throw createImageTranslationFailure(`图片第 ${texts.indexOf(uniqueTexts[index]) + 1} 段文字翻译失败：${getErrorMessage(error)}`, error);
                    }
                }
            };
            await Promise.all(Array.from({length: Math.min(3, uniqueTexts.length)}, worker));
        }
        if (controller.signal.aborted) throw imageAbortError(false);
        const byText = new Map(uniqueTexts.map((text, index) => [text, translations[index]]));
        return texts.map(text => byText.get(text) ?? text);
    } finally {
        options.signal.removeEventListener('abort', abort);
    }
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
                return {success:true, ...await dependencies.getMangaModelStatus()};
            },
        },
        {
            type: 'fluentReadMangaModelRemove',
            async handle() {
                if (!dependencies.removeMangaModels) throw new Error('漫画识别模型管理不可用');
                await dependencies.removeMangaModels();return {success:true};
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
                            const paddle = message.manga ? getMangaOcrEngine(sourceLanguage) === 'paddle'
                                : dependencies.getImageOcrEngine?.() === 'paddle';
                            if (!paddle) await dependencies.assertLanguagesDownloaded(sourceLanguage);
                            if (options.signal.aborted) throw imageAbortError(false);
                            const progressOwner = {context};
                            progressOwners.set(options.requestId, progressOwner);
                            const clearProgressOwner = () => {
                                if (progressOwners.get(options.requestId) === progressOwner) progressOwners.delete(options.requestId);
                            };
                            options.signal.addEventListener('abort', clearProgressOwner, {once: true});
                            try {
                                return await dependencies.translateImage(image, sourceLanguage, title, message.manga ? {...options, manga: true} : paddle ? {...options, ocrEngine: 'paddle'} : options);
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
                    return dependencies.fetchImage(url, {...options, ...(context.sender?.url ? {documentUrl:context.sender.url} : {})});
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
                    const translations = await textOperationRegistry.run(message, options => translateImageTexts(
                        texts, parseOptionalTitle(message.title), dependencies, options, message,
                    ));
                    return {success: true, translations};
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
