/**
 * @file src/app/offscreen/routes/shared.ts
 *
 * 文件职责：定义 Offscreen 消息路由共享依赖契约、字段校验守卫、统一响应包装与可取消请求生命周期管理工具。
 * 主要内容：导出 OffscreenMessageDependencies、OffscreenRouteMap、基础字段与 OCR/选区解析器、respondWith、runCancellableRequest 和 cancelRequest。
 * 模块边界：仅服务于 src/app/offscreen/messageRouter.ts 及同目录 routes/* 子路由器，不直接创建 Audio/Worker 或调用 browser.offscreen API。
 */

import type {OffscreenRequestMap, VideoTranscriptionResult, VideoPreparationResult, LocalTtsPreparation, LocalTtsStatus, LocalTranslationStatus} from '@/src/core/messaging/offscreen';
import type {Validator} from '@/src/core/messaging/validation';
import type {ImageViewport} from '@/src/shared/image/types';
import type {ReadingAnnotationInput, VideoReadingAnnotation} from '@/src/core/messaging/readingAnnotation';
import type {LocalTranslationDownloadSnapshot} from '@/src/core/config/localTranslation';
import type {LocalTtsAudio} from '@/src/features/local-tts/protocol';
import type {AreaTranslationSelection} from '@/src/features/area-translation/protocol';
import {isLocalTranslationModel} from '@/src/core/config/localTranslation';
import type {InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {
    IMAGE_OCR_LANGUAGE_PACKS,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from '@/src/features/image-translation/ocrLanguages';
import type {SelectionTtsPlayer} from '../ttsPlayback';
import {parseLanguageCode} from '../translation';

export type OffscreenSendResponse = (response: unknown) => void;

export type OffscreenRouteHandler = (
    message: Record<string, unknown>,
    sender: unknown,
    sendResponse: OffscreenSendResponse,
) => boolean;

export type OffscreenRouteMap = Record<string, OffscreenRouteHandler>;

export interface OffscreenMessageDependencies {
    readonly readingAnnotation?: {annotate(input: ReadingAnnotationInput, signal?: AbortSignal): Promise<VideoReadingAnnotation | null>};
    readonly informationHighlight?: {
        status(modelId?: InformationHighlightModelId): Promise<unknown>;
        prepare(modelId?: InformationHighlightModelId): Promise<unknown>;
        pause(modelId?: InformationHighlightModelId): Promise<unknown>;
        remove(modelId?: InformationHighlightModelId): Promise<unknown>;
        score(text: string, signal: AbortSignal, modelId?: InformationHighlightModelId): Promise<unknown>;
    };
    /** 生产组合根注入自身扩展 ID，TTS 播放控制仅接受同扩展且无 tab 的发送方。 */
    readonly runtimeId?: string;
    readonly translate: (data: unknown, signal: AbortSignal) => Promise<string>;
    readonly ttsPlayer: Pick<SelectionTtsPlayer, 'play' | 'stop' | 'seek'>
        & Partial<Pick<SelectionTtsPlayer, 'pause' | 'resume' | 'setRate'>>;
    readonly fetchImage: (url: string, signal: AbortSignal) => Promise<unknown>;
    readonly translateImage: (
        image: string,
        sourceLanguage: string,
        title: string,
        signal: AbortSignal,
        requestId: string,
        manga?: boolean,
        ocrEngine?: 'tesseract' | 'paddle',
        mangaViewport?: ImageViewport,
        inferenceBackend?: 'auto' | 'cpu',
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
        removeModel?(request: OffscreenRequestMap['VIDEO_AI_REMOVE_MODEL']): Promise<void>;
        shareModel?(request: OffscreenRequestMap['VIDEO_AI_SHARE_MODEL']): Promise<void>;
        transcribe(request: OffscreenRequestMap['VIDEO_AI_TRANSCRIBE']): Promise<VideoTranscriptionResult>;
        prepare(request: OffscreenRequestMap['VIDEO_AI_PREPARE']): Promise<VideoPreparationResult>;
        cancel(streamId: string, reason?: 'cancel' | 'complete'): Promise<void>;
    };
    readonly localTranslation?: {
        translate(request: OffscreenRequestMap['LOCAL_TRANSLATION_TRANSLATE'], signal: AbortSignal): Promise<string>;
        prepare(request: OffscreenRequestMap['LOCAL_TRANSLATION_PREPARE']): Promise<LocalTranslationDownloadSnapshot>;
        status(): Promise<LocalTranslationStatus>;
        pause?(request: OffscreenRequestMap['LOCAL_TRANSLATION_PAUSE']): Promise<LocalTranslationDownloadSnapshot>;
        removeModel(request: OffscreenRequestMap['LOCAL_TRANSLATION_REMOVE_MODEL']): Promise<void>;
        dispose?(): void;
    };
    readonly localTts?: {
        synthesize(request: OffscreenRequestMap['LOCAL_TTS_SYNTHESIZE'], signal: AbortSignal): Promise<LocalTtsAudio>;
        prepare(request: OffscreenRequestMap['LOCAL_TTS_PREPARE']): Promise<LocalTtsPreparation>;
        status(): Promise<LocalTtsStatus>;
        removeModel(request: OffscreenRequestMap['LOCAL_TTS_REMOVE_MODEL']): Promise<void>;
        dispose?(): void;
    };
}

const SUPPORTED_OCR_LANGUAGES = new Set(IMAGE_OCR_LANGUAGE_PACKS.map((pack) => pack.code));
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Offscreen ${field} 必须是非空字符串`);
    return value;
}

export function requiredLocalTranslationModel(value: unknown): string {
    const model = requiredString(value, 'model');
    if (!isLocalTranslationModel(model)) throw new Error('本地翻译模型标识无效');
    return model;
}

export function requiredRequestId(value: unknown): string {
    const requestId = requiredString(value, 'requestId');
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError('Offscreen requestId 格式无效');
    return requestId;
}

export function requiredImage(value: unknown): string {
    const image = requiredString(value, 'image');
    if (!image.startsWith('data:image/')) throw new TypeError('Offscreen image 必须是 data:image URL');
    return image;
}

export function requiredImageUrl(value: unknown): string {
    return requiredString(value, 'url');
}

export function requiredSourceLanguage(value: unknown): string {
    return parseLanguageCode(value, 'sourceLanguage', true);
}

export function optionalTitle(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new TypeError('Offscreen title 必须是字符串');
    return value;
}

export function requiredBoolean(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') throw new TypeError(`Offscreen ${name} 必须是布尔值`);
    return value;
}

export function parseSelection(value: unknown): AreaTranslationSelection {
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

export function parseOcrLanguages(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('Offscreen OCR languages 必须是非空数组');
    if (!value.every((language): language is ImageOcrLanguageCode =>
        typeof language === 'string' && SUPPORTED_OCR_LANGUAGES.has(language as ImageOcrLanguageCode))) {
        throw new TypeError('Offscreen OCR languages 包含不支持的语言');
    }
    return normalizeImageOcrLanguageCodes(value);
}

export function validatedResult<T>(value: unknown, validator: Validator<T>, operation: string): T {
    if (!validator(value)) throw new Error(`${operation}结果无效`);
    return value;
}

export function resultRecord(value: unknown, operation: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${operation}结果无效`);
    return value;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function respondWith<T>(
    operation: () => Promise<T>,
    sendResponse: OffscreenSendResponse,
    shape: (result: T) => unknown,
): void {
    void Promise.resolve()
        .then(operation)
        .then((result) => sendResponse(shape(result)))
        .catch((error) => sendResponse({success: false, error: errorMessage(error)}));
}

/**
 * 在请求表中登记可取消操作：取消、成功与失败只回复一次，结束时只释放自己持有的槽位。
 * 取消后跳过迟到结果与错误的序列化；shape 抛出的结果校验错误与操作失败使用同一 failure 序列化。
 */
export function runCancellableRequest<T>(
    active: Map<string, AbortController>,
    requestId: string,
    sendResponse: OffscreenSendResponse,
    cancelledError: string,
    operation: (signal: AbortSignal) => Promise<T>,
    shape: (result: T) => unknown,
    failure: (error: unknown) => unknown,
): void {
    const controller = new AbortController();
    active.set(requestId, controller);
    let settled = false;
    const finish = (response: unknown) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', handleAbort);
        // 准入拒绝重复身份，Map 只在这里释放；settled 阻止迟到结果清理复用该身份的新任务。
        active.delete(requestId);
        sendResponse(response);
    };
    const handleAbort = () => finish({success: false, cancelled: true, requestId, error: cancelledError});
    controller.signal.addEventListener('abort', handleAbort, {once: true});
    void Promise.resolve()
        .then(() => operation(controller.signal))
        .then((result) => {if (!settled) finish(shape(result));}, (error) => {if (!settled) finish(failure(error));})
        .catch((error) => {if (!settled) finish(failure(error));});
}

/** 校验 requestId 后中止在途请求；未登记时由 onMissing 决定是否记住“先取消后启动”。 */
export function cancelRequest(
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
