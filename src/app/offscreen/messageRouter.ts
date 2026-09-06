/**
 * @file src/app/offscreen/messageRouter.ts
 * 文件职责：解析并分派发送到 Offscreen Document 的可信运行时消息，为 Chrome 翻译、TTS、远程图片读取、OCR、整图和区域翻译提供统一响应纪律。
 * 主要内容：提供 ready 握手，校验文本、语言码、图片与 OCR 请求并分派依赖；验证响应形状，保留 Chrome 待准备语言对和模型不可用错误码，并保持取消及异步 listener 语义。
 * 模块边界：路由器不创建 Audio/Worker、不调用 browser.offscreen，也不实现翻译算法；资源实例由 offscreen runtime 构造，具体能力来自 translation、ttsPlayback 和 feature services。
 */
import type {AreaTranslationSelection} from '@/src/features/area-translation/protocol';
import {
    IMAGE_OCR_LANGUAGE_PACKS,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from '@/src/features/image-translation/ocrLanguages';
import type {SelectionTtsPlayer} from './ttsPlayback';
import {isChromePreparationRequiredError, parseLanguageCode} from './translation';
import {
    OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    OFFSCREEN_READY_MESSAGE_TYPE,
} from '@/src/platform/offscreen/client';

export type OffscreenSendResponse = (response: unknown) => void;

export interface OffscreenMessageDependencies {
    readonly translate: (data: unknown, signal: AbortSignal) => Promise<string>;
    readonly ttsPlayer: Pick<SelectionTtsPlayer, 'play' | 'stop'>;
    readonly recognizeImage: (image: string, sourceLanguage: string, signal: AbortSignal) => Promise<unknown>;
    readonly fetchImage: (url: string, signal: AbortSignal) => Promise<unknown>;
    readonly translateImage: (
        image: string,
        sourceLanguage: string,
        title: string,
        signal: AbortSignal,
        requestId: string,
    ) => Promise<unknown>;
    readonly translateArea: (
        image: string,
        sourceLanguage: string,
        title: string,
        selection: AreaTranslationSelection,
        signal: AbortSignal,
        requestId: string,
    ) => Promise<unknown>;
    readonly removeOcrLanguages?: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly downloadOcrLanguages: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly videoAi?: {
        removeModel?(request: Record<string, unknown>): Promise<void>;
        transcribe(request: Record<string, unknown>): Promise<unknown>;
        prepare(request: Record<string, unknown>): Promise<unknown>;
        cancel(streamId: string, reason?: 'cancel' | 'complete'): Promise<void>;
    };
}

type OffscreenMessageListener = (
    message: unknown,
    sender: unknown,
    sendResponse: OffscreenSendResponse,
) => boolean;

const SUPPORTED_OCR_LANGUAGES = new Set(IMAGE_OCR_LANGUAGE_PACKS.map((pack) => pack.code));
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Offscreen ${field} 必须是非空字符串`);
    return value;
}

function requiredRequestId(value: unknown): string {
    const requestId = requiredString(value, 'requestId');
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError('Offscreen requestId 格式无效');
    return requestId;
}

function requiredImage(value: unknown): string {
    const image = requiredString(value, 'image');
    if (!image.startsWith('data:image/')) throw new TypeError('Offscreen image 必须是 data:image URL');
    return image;
}

function requiredImageUrl(value: unknown): string {
    return requiredString(value, 'url');
}

function requiredSourceLanguage(value: unknown): string {
    return parseLanguageCode(value, 'sourceLanguage', true);
}

function optionalTitle(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new TypeError('Offscreen title 必须是字符串');
    return value;
}

function parseSelection(value: unknown): AreaTranslationSelection {
    if (!isRecord(value)) throw new TypeError('Offscreen selection 必须是对象');
    const fields = ['left', 'top', 'width', 'height', 'viewportWidth', 'viewportHeight'] as const;
    const numbers = Object.fromEntries(fields.map((field) => {
        const fieldValue = value[field];
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
            throw new TypeError(`Offscreen selection.${field} 必须是有限数字`);
        }
        return [field, fieldValue];
    })) as unknown as AreaTranslationSelection;
    if (numbers.left < 0 || numbers.top < 0 || numbers.width <= 0 || numbers.height <= 0
        || numbers.viewportWidth <= 0 || numbers.viewportHeight <= 0) {
        throw new TypeError('Offscreen selection 尺寸无效');
    }
    return numbers;
}

function parseOcrLanguages(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('Offscreen OCR languages 必须是非空数组');
    if (!value.every((language): language is ImageOcrLanguageCode =>
        typeof language === 'string' && SUPPORTED_OCR_LANGUAGES.has(language as ImageOcrLanguageCode))) {
        throw new TypeError('Offscreen OCR languages 包含不支持的语言');
    }
    return normalizeImageOcrLanguageCodes(value);
}

function resultRecord(value: unknown, operation: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${operation}结果无效`);
    return value;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function chromeTranslationErrorResponse(error: unknown): Record<string, unknown> {
    const response: Record<string, unknown> = {success: false, error: errorMessage(error)};
    if (isChromePreparationRequiredError(error)) {
        response.errorCode = error.code;
        response.errorName = error.name;
        response.sourceLanguage = error.sourceLanguage;
        response.targetLanguage = error.targetLanguage;
    } else if (error instanceof Error && error.name === 'ChromeModelUnavailableError') {
        response.errorCode = 'model-unavailable';
        response.errorName = error.name;
    }
    return response;
}

function respondWith(
    operation: () => Promise<unknown>,
    sendResponse: OffscreenSendResponse,
    shape: (result: unknown) => unknown,
): void {
    void Promise.resolve()
        .then(operation)
        .then((result) => sendResponse(shape(result)))
        .catch((error) => sendResponse({success: false, error: errorMessage(error)}));
}

/** 静态路由 Offscreen 消息；未知或非对象消息不会占用其他 runtime listener。 */
export function createOffscreenMessageListener(dependencies: OffscreenMessageDependencies): OffscreenMessageListener {
    const activeChromeTranslations = new Map<string, AbortController>();
    let removingOcrModels = false;
    const activeImageOperations = new Map<string, AbortController>();
    const cancelledImageOperations = new Set<string>();
    const cancellationOrder: string[] = [];
    let legacyImageRequestSequence = 0;

    const rememberImageCancellation = (requestId: string) => {
        if (cancelledImageOperations.has(requestId)) return;
        cancelledImageOperations.add(requestId);
        cancellationOrder.push(requestId);
        if (cancellationOrder.length <= 512) return;
        cancelledImageOperations.delete(cancellationOrder.shift()!);
    };

    const startImageOperation = (
        message: Record<string, unknown>,
        sendResponse: OffscreenSendResponse,
        operation: (signal: AbortSignal, requestId: string) => Promise<unknown>,
        shape: (result: unknown) => unknown,
    ): void => {
        let requestId: string;
        try {
            if (removingOcrModels) throw new Error('正在清除语言包，请稍后重试');
            requestId = message.requestId === undefined
                ? `legacy-image-${++legacyImageRequestSequence}`
                : requiredRequestId(message.requestId);
            if (cancelledImageOperations.delete(requestId)) {
                sendResponse({success: false, cancelled: true, requestId, error: '图片 OCR 请求已取消'});
                return;
            }
            if (activeImageOperations.has(requestId)) {
                throw new Error('Offscreen 图片 requestId 正在执行');
            }
        } catch (error) {
            sendResponse({success: false, error: errorMessage(error)});
            return;
        }

        const controller = new AbortController();
        activeImageOperations.set(requestId, controller);
        let settled = false;
        const finish = (response: unknown) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', handleAbort);
            if (activeImageOperations.get(requestId) === controller) activeImageOperations.delete(requestId);
            sendResponse(response);
        };
        const handleAbort = () => finish({
            success: false,
            cancelled: true,
            requestId,
            error: '图片 OCR 请求已取消',
        });
        controller.signal.addEventListener('abort', handleAbort, {once: true});
        void Promise.resolve()
            .then(() => operation(controller.signal, requestId))
            .then(
                result => finish(shape(result)),
                error => finish({success: false, error: errorMessage(error)}),
            )
            .catch(error => finish({success: false, error: errorMessage(error)}));
    };

    return (message, _sender, sendResponse) => {
        if (!isRecord(message) || typeof message.type !== 'string') return false;
        if (message.target !== 'offscreen') return false;

        switch (message.type) {
            case OFFSCREEN_READY_MESSAGE_TYPE:
                sendResponse({success: true, ready: true});
                return true;
            case 'PLAY_SELECTION_TTS':
                respondWith(() => dependencies.ttsPlayer.play(message), sendResponse, () => ({success: true}));
                return true;
            case 'STOP_SELECTION_TTS':
                respondWith(async () => dependencies.ttsPlayer.stop(message), sendResponse, () => ({success: true}));
                return true;
            case 'VIDEO_AI_TRANSCRIBE':
                if (!dependencies.videoAi) { sendResponse({success: false, error: '视频 AI 未启用'}); return true; }
                respondWith(() => dependencies.videoAi!.transcribe(message), sendResponse, (result) => ({success: true, ...resultRecord(result, '视频 AI 转写')}));
                return true;
            case 'VIDEO_AI_REMOVE_MODEL':
                respondWith(async () => {
                    if (!dependencies.videoAi?.removeModel) throw new Error('模型清除不可用');
                    await dependencies.videoAi.removeModel(message);
                }, sendResponse, () => ({success: true}));
                return true;
            case 'VIDEO_AI_PREPARE':
                if (!dependencies.videoAi) { sendResponse({success: false, error: '视频 AI 未启用'}); return true; }
                respondWith(() => dependencies.videoAi!.prepare(message), sendResponse, (result) => ({success: true, ...resultRecord(result, '视频 AI 模型')}));
                return true;
            case 'VIDEO_AI_CANCEL':
                if (!dependencies.videoAi) { sendResponse({success: true}); return true; }
                respondWith(() => dependencies.videoAi!.cancel(requiredString(message.streamId, 'streamId'), message.reason === 'complete' ? 'complete' : 'cancel'), sendResponse, () => ({success: true}));
                return true;
            case 'CHROME_TRANSLATE_OFFSCREEN': {
                let requestId: string;
                try {
                    requestId = requiredRequestId(message.requestId);
                    if (activeChromeTranslations.has(requestId)) {
                        throw new Error('Offscreen Chrome 翻译 requestId 正在执行');
                    }
                } catch (error) {
                    sendResponse({success: false, error: errorMessage(error)});
                    return true;
                }

                const controller = new AbortController();
                activeChromeTranslations.set(requestId, controller);
                let settled = false;
                const finish = (response: unknown) => {
                    if (settled) return;
                    settled = true;
                    controller.signal.removeEventListener('abort', handleAbort);
                    if (activeChromeTranslations.get(requestId) === controller) {
                        activeChromeTranslations.delete(requestId);
                    }
                    sendResponse(response);
                };
                const handleAbort = () => finish({
                    success: false,
                    cancelled: true,
                    requestId,
                    error: 'Chrome 翻译请求已取消',
                });
                controller.signal.addEventListener('abort', handleAbort, {once: true});
                void Promise.resolve()
                    .then(() => dependencies.translate(message.data, controller.signal))
                    .then(
                        (result) => {
                            if (typeof result !== 'string') throw new Error('Chrome 翻译结果无效');
                            finish({success: true, result, requestId});
                        },
                        (error) => finish({...chromeTranslationErrorResponse(error), requestId}),
                    )
                    .catch((error) => finish({...chromeTranslationErrorResponse(error), requestId}));
                return true;
            }
            case OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE: {
                try {
                    const requestId = requiredRequestId(message.requestId);
                    const controller = activeChromeTranslations.get(requestId);
                    controller?.abort();
                    sendResponse({success: true, cancelled: Boolean(controller), requestId});
                } catch (error) {
                    sendResponse({success: false, error: errorMessage(error)});
                }
                return true;
            }
            case 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN':
                startImageOperation(
                    message,
                    sendResponse,
                    signal => dependencies.fetchImage(requiredImageUrl(message.url), signal),
                    (image) => {
                        if (typeof image !== 'string' || !image.startsWith('data:image/')) {
                            throw new Error('远程图片结果无效');
                        }
                        return {success: true, image};
                    },
                );
                return true;
            case 'FLUENT_READ_IMAGE_OCR_OFFSCREEN':
                startImageOperation(
                    message,
                    sendResponse,
                    signal => dependencies.recognizeImage(
                        requiredImage(message.image),
                        requiredSourceLanguage(message.sourceLanguage),
                        signal,
                    ),
                    (lines) => {
                        if (!Array.isArray(lines)) throw new Error('图片 OCR 结果无效');
                        return {success: true, lines};
                    },
                );
                return true;
            case 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN':
                startImageOperation(
                    message,
                    sendResponse,
                    (signal, requestId) => dependencies.translateImage(
                        requiredImage(message.image),
                        requiredSourceLanguage(message.sourceLanguage),
                        optionalTitle(message.title),
                        signal,
                        requestId,
                    ),
                    (result) => ({...resultRecord(result, '图片翻译'), success: true}),
                );
                return true;
            case 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN':
                startImageOperation(
                    message,
                    sendResponse,
                    (signal, requestId) => dependencies.translateArea(
                        requiredImage(message.image),
                        requiredSourceLanguage(message.sourceLanguage),
                        optionalTitle(message.title),
                        parseSelection(message.selection),
                        signal,
                        requestId,
                    ),
                    (result) => ({...resultRecord(result, '区域翻译'), success: true}),
                );
                return true;
            case OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE: {
                try {
                    const requestId = requiredRequestId(message.requestId);
                    const controller = activeImageOperations.get(requestId);
                    if (controller) controller.abort();
                    else rememberImageCancellation(requestId);
                    sendResponse({success: true, cancelled: Boolean(controller), requestId});
                } catch (error) {
                    sendResponse({success: false, error: errorMessage(error)});
                }
                return true;
            }
            case 'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN':
                respondWith(async () => {
                    if (!dependencies.removeOcrLanguages) throw new Error('语言包清除不可用');
                    if (activeImageOperations.size || removingOcrModels) throw new Error('图片识别正在运行，请完成后再清除语言包');
                    removingOcrModels = true;
                    try { await dependencies.removeOcrLanguages(parseOcrLanguages(message.languages)); }
                    finally { removingOcrModels = false; }
                }, sendResponse, () => ({success: true}));
                return true;
            case 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN':
                respondWith(
                    () => dependencies.downloadOcrLanguages(parseOcrLanguages(message.languages)),
                    sendResponse,
                    () => ({success: true}),
                );
                return true;
            default:
                return false;
        }
    };
}
