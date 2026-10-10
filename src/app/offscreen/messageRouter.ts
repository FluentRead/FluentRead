/**
 * @file src/app/offscreen/messageRouter.ts
 * 文件职责：解析并分派发送到扩展自有 DOM 页面的可信运行时消息，为 Chrome 翻译、本地模型、TTS、远程图片读取、OCR 语言包、整图和区域翻译提供统一响应纪律。
 * 主要内容：智能高亮消息携带所选模型，模型下载与状态互相独立、推理共用单 Worker 预算；校验并传递单图本地识别方式；提供 ready 与 TTS 一次性许可握手，在播放器前拒绝失效 PLAY，校验文本、语言码、图片与 OCR 语言包请求并分派依赖；验证 TTS 播放控制来自同扩展且不属于网页 tab，以共用的可取消请求表管理取消与单次回复，校验本地语音句段时间并保留 Chrome 待准备语言对、模型不可用和本地 TTS 错误码。
 * 模块边界：路由器不创建 Audio/Worker、不调用 browser.offscreen，也不实现翻译算法；资源实例由 offscreen runtime 构造，具体能力来自 translation、ttsPlayback 和 feature services。
 */
import {parseSpeechCues} from '@/src/core/tts/speechProgress';
import type {AreaTranslationSelection} from '@/src/features/area-translation/protocol';
import {imageTranslationFailureResponse} from '@/src/features/image-translation/failure';
import {isLocalTranslationModel} from '@/src/core/config/localTranslation';
import {DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID, getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {
    IMAGE_OCR_LANGUAGE_PACKS,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from '@/src/features/image-translation/ocrLanguages';
import {localTtsErrorCode} from '@/src/features/local-tts/protocol';
import type {SelectionTtsPlayer} from './ttsPlayback';
import {createSelectionTtsPlaybackAdmission} from './ttsPlaybackAdmission';
import {isChromePreparationRequiredError, parseLanguageCode} from './translation';
import {
    OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE,
    OFFSCREEN_READY_MESSAGE_TYPE,
} from '@/src/platform/offscreen/client';

export type OffscreenSendResponse = (response: unknown) => void;

export interface OffscreenMessageDependencies {
    readonly informationHighlight?: {
        status(modelId?: InformationHighlightModelId): Promise<unknown>; prepare(modelId?: InformationHighlightModelId): Promise<unknown>; pause(modelId?: InformationHighlightModelId): Promise<unknown>; remove(modelId?: InformationHighlightModelId): Promise<unknown>;
        score(text: string, signal: AbortSignal, modelId?: InformationHighlightModelId): Promise<unknown>;
    };
    /** 生产组合根注入自身扩展 ID，TTS 播放控制仅接受同扩展且无 tab 的发送方。 */
    readonly runtimeId?: string;
    readonly translate: (data: unknown, signal: AbortSignal) => Promise<string>;
    readonly ttsPlayer: Pick<SelectionTtsPlayer, 'play' | 'stop' | 'seek'>;
    readonly fetchImage: (url: string, signal: AbortSignal) => Promise<unknown>;
    readonly translateImage: (
        image: string,
        sourceLanguage: string,
        title: string,
        signal: AbortSignal,
        requestId: string,
        manga?: boolean,
        ocrEngine?: 'tesseract' | 'paddle',
    ) => Promise<unknown>;
    readonly translateArea: (
        image: string,
        sourceLanguage: string,
        title: string,
        selection: AreaTranslationSelection,
        signal: AbortSignal,
        requestId: string,
    ) => Promise<unknown>;
    readonly cropArea?: (
        image: string,
        selection: AreaTranslationSelection,
        signal: AbortSignal,
        requestId: string,
    ) => Promise<unknown>;
    readonly removeOcrLanguages?: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly downloadOcrLanguages: (languages: ImageOcrLanguageCode[]) => Promise<void>;
    readonly mangaModelStatus?: () => Promise<unknown>;
    readonly removeMangaModels?: () => Promise<void>;
    readonly videoAi?: {
        removeModel?(request: Record<string, unknown>): Promise<void>;
        transcribe(request: Record<string, unknown>): Promise<unknown>;
        prepare(request: Record<string, unknown>): Promise<unknown>;
        cancel(streamId: string, reason?: 'cancel' | 'complete'): Promise<void>;
    };
    readonly localTranslation?: {
        translate(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
        prepare(request: Record<string, unknown>): Promise<unknown>;
        status(): Promise<unknown>;
        pause?(request: Record<string, unknown>): Promise<unknown>;
        removeModel(request: Record<string, unknown>): Promise<void>;
        dispose?(): void;
    };
    readonly localTts?: {
        synthesize(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
        prepare(request: Record<string, unknown>): Promise<unknown>;
        status(): Promise<unknown>;
        removeModel(request: Record<string, unknown>): Promise<void>;
        dispose?(): void;
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

function requiredLocalTranslationModel(value: unknown): string {
    const model = requiredString(value, 'model');
    if (!isLocalTranslationModel(model)) throw new Error('本地翻译模型标识无效');
    return model;
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

function requiredBoolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new TypeError(`Offscreen ${name} 必须是布尔值`);
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

function binaryToBase64(value: unknown, operation: string): string {
    const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
    if (!bytes) throw new Error(`${operation}音频结果无效`);
    // 数秒 WAV 即达数十万字节；按块转换避免逐字节拼接字符串，同时不超过函数参数上限。
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function serializeLocalTtsAudio(value: unknown): Record<string, unknown> {
    const record = resultRecord(value, '本地 TTS 合成');
    const {audio, ...metadata} = record;
    return {
        ...metadata,
        ...(record.timings === undefined ? {} : {timings: parseSpeechCues(record.timings)}),
        audioBase64: binaryToBase64(audio, '本地 TTS 合成'),
    };
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

/**
 * 在请求表中登记可取消操作：取消、成功与失败只回复一次，结束时只释放自己持有的槽位。
 * shape 抛出的结果校验错误与操作失败使用同一 failure 序列化。
 */
function runCancellableRequest(
    active: Map<string, AbortController>,
    requestId: string,
    sendResponse: OffscreenSendResponse,
    cancelledError: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
    shape: (result: unknown) => unknown,
    failure: (error: unknown) => unknown,
): void {
    const controller = new AbortController();
    active.set(requestId, controller);
    let settled = false;
    const finish = (response: unknown) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', handleAbort);
        if (active.get(requestId) === controller) active.delete(requestId);
        sendResponse(response);
    };
    const handleAbort = () => finish({success: false, cancelled: true, requestId, error: cancelledError});
    controller.signal.addEventListener('abort', handleAbort, {once: true});
    void Promise.resolve()
        .then(() => operation(controller.signal))
        .then((result) => finish(shape(result)), (error) => finish(failure(error)))
        .catch((error) => finish(failure(error)));
}

/** 校验 requestId 后中止在途请求；未登记时由 onMissing 决定是否记住“先取消后启动”。 */
function cancelRequest(
    active: Map<string, AbortController>,
    message: Record<string, unknown>,
    sendResponse: OffscreenSendResponse,
    onMissing?: (requestId: string) => void,
): void {
    try {
        const requestId = requiredRequestId(message.requestId);
        const controller = active.get(requestId);
        if (controller) controller.abort();
        else onMissing?.(requestId);
        sendResponse({success: true, cancelled: Boolean(controller), requestId});
    } catch (error) {
        sendResponse({success: false, error: errorMessage(error)});
    }
}

/** 静态路由 Offscreen 消息；未知或非对象消息不会占用其他 runtime listener。 */
export function createOffscreenMessageListener(dependencies: OffscreenMessageDependencies): OffscreenMessageListener {
    const ttsAdmission = createSelectionTtsPlaybackAdmission();
    const activeChromeTranslations = new Map<string, AbortController>();
    const activeLocalTranslations = new Map<string, AbortController>();
    const activeInformationHighlights = new Map<string, AbortController>();
    const cancelledInformationHighlights = new Set<string>();
    const activeLocalTts = new Map<string, AbortController>();
    let removingOcrModels = false;
    const activeImageOperations = new Map<string, AbortController>();
    const cancelledImageOperations = new Set<string>();
    let legacyImageRequestSequence = 0;

    const rememberImageCancellation = (requestId: string) => {
        if (cancelledImageOperations.has(requestId)) return;
        cancelledImageOperations.add(requestId);
        // Set 的插入顺序只包含尚未消费的取消；已消费 ID 的旧队列项
        // 不能在 ID 再用后误删新的取消，也不必维护重复历史或移动数组。
        if (cancelledImageOperations.size > 512) {
            cancelledImageOperations.delete(cancelledImageOperations.values().next().value!);
        }
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

        runCancellableRequest(activeImageOperations, requestId, sendResponse, '图片 OCR 请求已取消',
            (signal) => operation(signal, requestId), shape, imageTranslationFailureResponse);
    };

    return (message, sender, sendResponse) => {
        if (!isRecord(message) || typeof message.type !== 'string') return false;
        if (message.target !== 'offscreen') return false;
        if (typeof message.type === 'string' && message.type.startsWith('INFORMATION_HIGHLIGHT_')) {
            const source = sender as {id?: string; tab?: unknown};
            if (source?.id !== dependencies.runtimeId || source.tab || !dependencies.informationHighlight) {
                sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_UNTRUSTED_SENDER'}); return true;
            }
            const feature = dependencies.informationHighlight;
            const modelId = message.modelId === undefined ? DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID : getInformationHighlightModel(message.modelId).id;
            if (message.modelId !== undefined && modelId !== message.modelId) {
                sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'}); return true;
            }
            const commands: Record<string, () => Promise<unknown>> = {
                INFORMATION_HIGHLIGHT_STATUS_OFFSCREEN: () => feature.status(modelId), INFORMATION_HIGHLIGHT_PREPARE_OFFSCREEN: () => feature.prepare(modelId),
                INFORMATION_HIGHLIGHT_PAUSE_OFFSCREEN: () => feature.pause(modelId), INFORMATION_HIGHLIGHT_REMOVE_OFFSCREEN: () => feature.remove(modelId),
            };
            if (commands[message.type]) {respondWith(commands[message.type], sendResponse, status => ({success: true, status})); return true;}
            let requestId: string;
            try {requestId = requiredRequestId(message.requestId);}
            catch (error) {sendResponse({success: false, error: errorMessage(error)}); return true;}
            if (message.type === 'INFORMATION_HIGHLIGHT_CANCEL_OFFSCREEN') {
                cancelRequest(activeInformationHighlights, message, sendResponse, id => {
                    cancelledInformationHighlights.add(id);
                    if (cancelledInformationHighlights.size > 512) cancelledInformationHighlights.delete(cancelledInformationHighlights.values().next().value!);
                }); return true;
            }
            if (message.type !== 'INFORMATION_HIGHLIGHT_SCORE_OFFSCREEN' || typeof message.text !== 'string' || !message.text || message.text.length > 12_000
                || activeInformationHighlights.has(requestId)) {sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_REQUEST'}); return true;}
            if (cancelledInformationHighlights.delete(requestId)) {sendResponse({success: false, error: '信息高亮已取消'}); return true;}
            runCancellableRequest(activeInformationHighlights, requestId, sendResponse, '信息高亮已取消',
                signal => feature.score(message.text as string, signal, modelId), result => ({success: true, result}), error => ({success: false, error: errorMessage(error)}));
            return true;
        }
        if (dependencies.runtimeId !== undefined
            && ['READ_SELECTION_TTS_REVISION', 'RESERVE_SELECTION_TTS', 'PLAY_SELECTION_TTS', 'STOP_SELECTION_TTS', 'SEEK_SELECTION_TTS'].includes(message.type)
            && (!isRecord(sender) || sender.id !== dependencies.runtimeId || sender.tab !== undefined)) {
            sendResponse({success: false, error: 'TTS 播放控制发送方无效'});
            return true;
        }

        switch (message.type) {
            case OFFSCREEN_READY_MESSAGE_TYPE:
                sendResponse({success: true, ready: true});
                return true;
            case 'READ_SELECTION_TTS_REVISION':
                respondWith(async () => ttsAdmission.read(), sendResponse, (snapshot) => ({success: true, ...(snapshot as object)}));
                return true;
            case 'RESERVE_SELECTION_TTS':
                respondWith(async () => ttsAdmission.reserve(message), sendResponse, (playbackToken) =>
                    playbackToken === undefined ? {success: false, conflict: true} : {success: true, playbackToken});
                return true;
            case 'PLAY_SELECTION_TTS':
                respondWith(async () => {
                    // 消费许可与进入真实播放器连续执行；拒绝旧 PLAY 时尚未创建/停止 Audio。
                    if (!ttsAdmission.consume(message)) {
                        return {success: false, error: 'TTS 播放许可已失效',
                            errorCode: 'selection-tts-permit-invalid', receiverId: ttsAdmission.read().receiverId};
                    }
                    await dependencies.ttsPlayer.play(message);
                    return {success: true};
                }, sendResponse, (response) => response);
                return true;
            case 'STOP_SELECTION_TTS':
                respondWith(async () => {
                    ttsAdmission.stop(message);
                    return dependencies.ttsPlayer.stop(message);
                }, sendResponse, () => ({success: true}));
                return true;
            case 'SEEK_SELECTION_TTS':
                respondWith(async () => dependencies.ttsPlayer.seek(message), sendResponse, (seeked) => ({success: true, seeked}));
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

                runCancellableRequest(activeChromeTranslations, requestId, sendResponse, 'Chrome 翻译请求已取消',
                    (signal) => dependencies.translate(message.data, signal),
                    (result) => {
                        if (typeof result !== 'string') throw new Error('Chrome 翻译结果无效');
                        return {success: true, result, requestId};
                    },
                    (error) => ({...chromeTranslationErrorResponse(error), requestId}));
                return true;
            }
            case OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE:
                cancelRequest(activeChromeTranslations, message, sendResponse);
                return true;
            case 'LOCAL_TRANSLATION_PREPARE':
                if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
                respondWith(
                    () => dependencies.localTranslation!.prepare({
                        ...message,
                        model: requiredLocalTranslationModel(message.model),
                    }),
                    sendResponse,
                    (result) => ({success: true, ...resultRecord(result, '本地翻译模型')}),
                );
                return true;
            case 'LOCAL_TRANSLATION_PAUSE':
                if (!dependencies.localTranslation?.pause) { sendResponse({success: false, error: 'LOCAL_TRANSLATION_UNAVAILABLE'}); return true; }
                respondWith(
                    () => dependencies.localTranslation!.pause!({model: requiredLocalTranslationModel(message.model)}),
                    sendResponse,
                    (result) => ({success: true, ...resultRecord(result, 'local translation')}),
                );
                return true;
            case 'LOCAL_TRANSLATION_STATUS':
                if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
                respondWith(
                    () => dependencies.localTranslation!.status(),
                    sendResponse,
                    (result) => ({success: true, ...resultRecord(result, '本地翻译模型状态')}),
                );
                return true;
            case 'LOCAL_TRANSLATION_REMOVE_MODEL':
                if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
                respondWith(
                    () => dependencies.localTranslation!.removeModel({
                        ...message,
                        model: requiredLocalTranslationModel(message.model),
                    }),
                    sendResponse,
                    () => ({success: true}),
                );
                return true;
            case 'LOCAL_TRANSLATION_TRANSLATE': {
                if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
                let requestId: string;
                try {
                    requestId = requiredRequestId(message.requestId);
                    if (activeLocalTranslations.has(requestId)) throw new Error('Offscreen 本地翻译 requestId 正在执行');
                    requiredLocalTranslationModel(message.model);
                    requiredString(message.text, 'text');
                    requiredString(message.sourceLanguage, 'sourceLanguage');
                    requiredString(message.targetLanguage, 'targetLanguage');
                    if (message.sourceLanguageDetectionText !== undefined
                        && typeof message.sourceLanguageDetectionText !== 'string') {
                        throw new Error('Offscreen sourceLanguageDetectionText 必须为字符串');
                    }
                } catch (error) {
                    sendResponse({success: false, error: errorMessage(error)});
                    return true;
                }

                runCancellableRequest(activeLocalTranslations, requestId, sendResponse, '本地翻译请求已取消',
                    (signal) => dependencies.localTranslation!.translate(message, signal),
                    (result) => {
                        if (typeof result !== 'string') throw new Error('本地翻译结果无效');
                        return {success: true, result, requestId};
                    },
                    (error) => ({success: false, error: errorMessage(error), requestId}));
                return true;
            }
            case OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE:
                cancelRequest(activeLocalTranslations, message, sendResponse);
                return true;
            case 'LOCAL_TTS_PREPARE':
                if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
                respondWith(
                    () => dependencies.localTts!.prepare(message),
                    sendResponse,
                    (result) => ({success: true, ...resultRecord(result, '本地 TTS 模型')}),
                );
                return true;
            case 'LOCAL_TTS_STATUS':
                if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
                respondWith(
                    () => dependencies.localTts!.status(),
                    sendResponse,
                    (result) => ({success: true, ...resultRecord(result, '本地 TTS 模型状态')}),
                );
                return true;
            case 'LOCAL_TTS_REMOVE_MODEL':
                if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
                respondWith(
                    () => dependencies.localTts!.removeModel(message),
                    sendResponse,
                    () => ({success: true}),
                );
                return true;
            case 'LOCAL_TTS_SYNTHESIZE': {
                if (!dependencies.localTts) { sendResponse({success: false, error: '本地 TTS 未启用'}); return true; }
                let requestId: string;
                try {
                    requestId = requiredRequestId(message.requestId);
                    if (activeLocalTts.has(requestId)) throw new Error('Offscreen 本地 TTS requestId 正在执行');
                    requiredString(message.text, 'text');
                    requiredString(message.language, 'language');
                    requiredString(message.voice, 'voice');
                } catch (error) {
                    sendResponse({success: false, error: errorMessage(error)});
                    return true;
                }

                runCancellableRequest(activeLocalTts, requestId, sendResponse, '本地 TTS 请求已取消',
                    (signal) => dependencies.localTts!.synthesize(message, signal),
                    (result) => ({success: true, ...serializeLocalTtsAudio(result), requestId}),
                    // 错误码是本地模型不可用的跨消息契约；后台策略据此回退在线朗读。
                    (error) => ({success: false, error: errorMessage(error), errorCode: localTtsErrorCode(error), requestId}));
                return true;
            }
            case OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE:
                cancelRequest(activeLocalTts, message, sendResponse);
                return true;
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
            case 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN':
                startImageOperation(
                    message,
                    sendResponse,
                    (signal, requestId) => {
                        if (message.ocrEngine !== undefined && message.ocrEngine !== 'tesseract' && message.ocrEngine !== 'paddle') throw new Error('图片识别方式无效');
                        return dependencies.translateImage(
                            requiredImage(message.image),
                            requiredSourceLanguage(message.sourceLanguage),
                            optionalTitle(message.title),
                            signal,
                            requestId,
                            message.manga === undefined ? false : requiredBoolean(message.manga,'manga'),
                            message.ocrEngine === 'paddle' ? 'paddle' : 'tesseract',
                        );
                    },
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
            case 'FLUENT_READ_AREA_CROP_OFFSCREEN':
                if (!dependencies.cropArea) { sendResponse({success: false, error: '区域裁剪不可用'}); return true; }
                startImageOperation(
                    message,
                    sendResponse,
                    (signal, requestId) => dependencies.cropArea!(
                        requiredImage(message.image), parseSelection(message.selection), signal, requestId,
                    ),
                    (result) => ({...resultRecord(result, '区域裁剪'), success: true}),
                );
                return true;
            case OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE:
                cancelRequest(activeImageOperations, message, sendResponse, rememberImageCancellation);
                return true;
            case 'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN':
                respondWith(async () => {
                    if (!dependencies.removeOcrLanguages) throw new Error('语言包清除不可用');
                    if (activeImageOperations.size || removingOcrModels) throw new Error('图片识别正在运行，请完成后再清除语言包');
                    removingOcrModels = true;
                    try { await dependencies.removeOcrLanguages(parseOcrLanguages(message.languages)); }
                    finally { removingOcrModels = false; }
                }, sendResponse, () => ({success: true}));
                return true;
            case 'FLUENT_READ_MANGA_MODEL_STATUS_OFFSCREEN':
                respondWith(async()=>{
                    if(!dependencies.mangaModelStatus)throw new Error('漫画识别模型管理不可用');
                    return dependencies.mangaModelStatus();
                },sendResponse,result=>({...resultRecord(result,'漫画模型状态'),success:true}));
                return true;
            case 'FLUENT_READ_MANGA_MODEL_REMOVE_OFFSCREEN':
                respondWith(async()=>{
                    if(!dependencies.removeMangaModels)throw new Error('漫画识别模型管理不可用');
                    if(activeImageOperations.size || removingOcrModels)throw new Error('图片识别正在运行，请完成后再清除语言包');
                    removingOcrModels=true;
                    try {await dependencies.removeMangaModels();}finally{removingOcrModels=false;}
                },sendResponse,()=>({success:true}));
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
