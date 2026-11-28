/**
 * @file src/core/messaging/offscreen.ts
 * 文件职责：定义本地视频、翻译与语音跨后台和离屏页面的唯一数据契约。
 * 主要内容：按现有 wire type 关联请求与响应，以字段完整的守卫校验外部消息及成功、失败回包；公开推理结果类型供 Worker 与组合根共用。
 * 模块边界：仅包含纯 DTO 和校验，不导入 feature、浏览器 API、模型运行时或配置存储。
 */
import {inferenceResponse as response, type InferenceBackend, type InferenceResponse} from './inference';
import {isVideoTranscriptionInput, isVideoPreparationResult, isVideoTranscriptionResult, type VideoTranscriptionModel, type VideoTranscriptionCancelReason, type VideoTranscriptionInput, type VideoPrepareInput, type VideoTranscriptionResult, type VideoPreparationResult} from './video';
import {isReadingAnnotationRequest, isReadingAnnotationCancellation, isReadingAnnotationResponse, type ReadingAnnotationRequest, type ReadingAnnotationCancellation, type ReadingAnnotationResponse} from './readingAnnotation';
export type {InferenceBackend, InferenceFailure, InferenceSuccess, InferenceResponse} from './inference';
export type {VideoTranscriptionModel, VideoTranscriptionCancelReason, VideoRecognitionMetadata, VideoTranscriptionSegment, VideoTranscriptionResult, VideoPreparationResult, VideoTranscriptionInput, VideoPrepareInput, VideoBackgroundInput, VideoBackgroundRequestMap, VideoBackgroundResponseMap, VideoBackgroundRequestType, VideoBackgroundRequest} from './video';
export {isVideoPreparationResult, isVideoTranscriptionResult} from './video';
import {isLocalTranslationModel, normalizeLocalTranslationDownloadSnapshot, type LocalTranslationModelId, type LocalTranslationDownloadSnapshot, type LocalTranslationDownloadState} from '@/src/core/config/localTranslation';
import {parseSpeechCues, type SpeechCue} from '@/src/core/tts/speechProgress';
import {arrayOf, isBoolean, isFiniteNumber, isMessageRecord, isNonEmptyString, isString, oneOf, optional, parseMessage, shape, type Validator} from './validation';

export interface ModelState {model: string; downloaded: boolean; downloadSizeMb?: number; dtype?: string; revision?: string}
export interface LocalTtsPreparation {model?: string; dtype?: string; revision?: string; warm: boolean; backend?: InferenceBackend; models?: ModelState[]}
export interface LocalTtsStatus {models: ModelState[]}
export interface LocalTranslationStatus {models: ModelState[]; version?: 2; tasks?: LocalTranslationDownloadSnapshot['tasks']}
export interface LocalTtsSerializedAudio {audioBase64: string; timings?: SpeechCue[]; contentType?: string; voice?: string; backend?: InferenceBackend}
export interface LocalTranslationInput {model: LocalTranslationModelId; text: string; sourceLanguage: string; targetLanguage: string; sourceLanguageDetectionText?: string}
export interface OffscreenRequestMap {
    READING_ANNOTATION: ReadingAnnotationRequest;
    READING_ANNOTATION_CANCEL: ReadingAnnotationCancellation;
    VIDEO_AI_TRANSCRIBE: VideoTranscriptionInput;
    VIDEO_AI_PREPARE: VideoPrepareInput;
    VIDEO_AI_CANCEL: {streamId: string; reason?: VideoTranscriptionCancelReason};
    VIDEO_AI_REMOVE_MODEL: {model?: VideoTranscriptionModel};
    VIDEO_AI_SHARE_MODEL: {model?: VideoTranscriptionModel};
    LOCAL_TRANSLATION_TRANSLATE: LocalTranslationInput & {requestId: string};
    LOCAL_TRANSLATION_PREPARE: {model: LocalTranslationModelId; keepWarm?: boolean};
    LOCAL_TRANSLATION_STATUS: object;
    LOCAL_TRANSLATION_PAUSE: {model: LocalTranslationModelId};
    LOCAL_TRANSLATION_REMOVE_MODEL: {model: LocalTranslationModelId};
    CANCEL_LOCAL_TRANSLATION_OFFSCREEN: {requestId: string};
    LOCAL_TTS_SYNTHESIZE: {requestId: string; text: string; language: string; voice: string; speed?: number};
    LOCAL_TTS_PREPARE: {keepWarm?: boolean};
    LOCAL_TTS_STATUS: object;
    LOCAL_TTS_REMOVE_MODEL: object;
    CANCEL_LOCAL_TTS_OFFSCREEN: {requestId: string};
}
export interface OffscreenResponseMap {
    READING_ANNOTATION: ReadingAnnotationResponse;
    READING_ANNOTATION_CANCEL: InferenceResponse<{cancelled: boolean}>;
    VIDEO_AI_TRANSCRIBE: InferenceResponse<VideoTranscriptionResult>;
    VIDEO_AI_PREPARE: InferenceResponse<VideoPreparationResult>;
    VIDEO_AI_CANCEL: InferenceResponse;
    VIDEO_AI_REMOVE_MODEL: InferenceResponse;
    VIDEO_AI_SHARE_MODEL: InferenceResponse;
    LOCAL_TRANSLATION_TRANSLATE: InferenceResponse<{result: string; requestId?: string}>;
    LOCAL_TRANSLATION_PREPARE: InferenceResponse<LocalTranslationDownloadSnapshot>;
    LOCAL_TRANSLATION_STATUS: InferenceResponse<LocalTranslationStatus>;
    LOCAL_TRANSLATION_PAUSE: InferenceResponse<LocalTranslationDownloadSnapshot>;
    LOCAL_TRANSLATION_REMOVE_MODEL: InferenceResponse;
    CANCEL_LOCAL_TRANSLATION_OFFSCREEN: InferenceResponse<{cancelled?: boolean; requestId?: string}>;
    LOCAL_TTS_SYNTHESIZE: InferenceResponse<LocalTtsSerializedAudio & {requestId?: string}>;
    LOCAL_TTS_PREPARE: InferenceResponse<LocalTtsPreparation>;
    LOCAL_TTS_STATUS: InferenceResponse<LocalTtsStatus>;
    LOCAL_TTS_REMOVE_MODEL: InferenceResponse;
    CANCEL_LOCAL_TTS_OFFSCREEN: InferenceResponse<{cancelled?: boolean; requestId?: string}>;
}
export type OffscreenRequestType = keyof OffscreenRequestMap;
export type KnownOffscreenRequest<K extends OffscreenRequestType = OffscreenRequestType> = {[T in K]: {type: T} & OffscreenRequestMap[T]}[K];
const backend = oneOf('webgpu', 'wasm');
const videoModel = oneOf('tiny', 'base', 'small');
const requestId: Validator<string> = (value): value is string => isString(value) && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
const noFields = shape<object>({});
const cueArray = arrayOf(shape<SpeechCue>({startChar: isFiniteNumber, endChar: isFiniteNumber, startTime: isFiniteNumber, endTime: isFiniteNumber}));
const speechCues: Validator<SpeechCue[]> = (value): value is SpeechCue[] => cueArray(value) && parseSpeechCues(value).length === value.length;
const modelState = shape<ModelState>({model: isString, downloaded: isBoolean, downloadSizeMb: optional(isFiniteNumber), dtype: optional(isString), revision: optional(isString)});
export const isLocalTtsPreparation = shape<LocalTtsPreparation>({model: optional(isString), dtype: optional(isString), revision: optional(isString), warm: isBoolean, backend: optional(backend), models: optional(arrayOf(modelState))});
export const isLocalTtsStatus = shape<LocalTtsStatus>({models: arrayOf(modelState)});
const translationTask = shape<LocalTranslationDownloadState>({
    model: isLocalTranslationModel, phase: oneOf('idle', 'queued', 'downloading', 'verifying', 'paused', 'ready', 'error', 'removing'),
    downloadedBytes: isFiniteNumber, totalBytes: isFiniteNumber, bytesPerSecond: isFiniteNumber, updatedAt: isFiniteNumber,
    error: optional(oneOf('network', 'storage', 'integrity', 'unknown')),
});
const translationSnapshot = shape<LocalTranslationDownloadSnapshot>({version: oneOf(2), tasks: arrayOf(translationTask)});
export const isLocalTranslationSnapshot: Validator<LocalTranslationDownloadSnapshot> = (value): value is LocalTranslationDownloadSnapshot => translationSnapshot(value) && normalizeLocalTranslationDownloadSnapshot(value) !== undefined;
export const isLocalTranslationStatus = shape<LocalTranslationStatus>({models: arrayOf(modelState), version: optional(oneOf(2)), tasks: optional((value): value is LocalTranslationDownloadSnapshot['tasks'] => isLocalTranslationSnapshot({version: 2, tasks: value}))});
const responses: {[K in OffscreenRequestType]: Validator<OffscreenResponseMap[K]>} = {
    READING_ANNOTATION: isReadingAnnotationResponse,
    READING_ANNOTATION_CANCEL: response(shape<{cancelled: boolean}>({cancelled: isBoolean})),
    VIDEO_AI_TRANSCRIBE: response(isVideoTranscriptionResult), VIDEO_AI_PREPARE: response(isVideoPreparationResult), VIDEO_AI_CANCEL: response(noFields), VIDEO_AI_REMOVE_MODEL: response(noFields), VIDEO_AI_SHARE_MODEL: response(noFields),
    LOCAL_TRANSLATION_TRANSLATE: response(shape<{result: string; requestId?: string}>({result: isString, requestId: optional(requestId)})),
    LOCAL_TRANSLATION_PREPARE: response(isLocalTranslationSnapshot), LOCAL_TRANSLATION_STATUS: response(isLocalTranslationStatus), LOCAL_TRANSLATION_PAUSE: response(isLocalTranslationSnapshot), LOCAL_TRANSLATION_REMOVE_MODEL: response(noFields),
    CANCEL_LOCAL_TRANSLATION_OFFSCREEN: response(shape<{cancelled?: boolean; requestId?: string}>({cancelled: optional(isBoolean), requestId: optional(requestId)})),
    LOCAL_TTS_SYNTHESIZE: response(shape<LocalTtsSerializedAudio & {requestId?: string}>({audioBase64: isNonEmptyString, timings: optional(speechCues), contentType: optional(isString), voice: optional(isString), backend: optional(backend), requestId: optional(requestId)})),
    LOCAL_TTS_PREPARE: response(isLocalTtsPreparation), LOCAL_TTS_STATUS: response(isLocalTtsStatus), LOCAL_TTS_REMOVE_MODEL: response(noFields),
    CANCEL_LOCAL_TTS_OFFSCREEN: response(shape<{cancelled?: boolean; requestId?: string}>({cancelled: optional(isBoolean), requestId: optional(requestId)})),
};
const requests: {[K in OffscreenRequestType]: Validator<OffscreenRequestMap[K]>} = {
    READING_ANNOTATION: isReadingAnnotationRequest,
    READING_ANNOTATION_CANCEL: isReadingAnnotationCancellation,
    VIDEO_AI_TRANSCRIBE: isVideoTranscriptionInput,
    VIDEO_AI_PREPARE: shape<VideoPrepareInput>({model: optional(videoModel), streamId: optional(isString), keepWarm: optional(isBoolean), preference: optional(oneOf('official', 'mirror', 'auto'))}),
    VIDEO_AI_CANCEL: shape<OffscreenRequestMap['VIDEO_AI_CANCEL']>({streamId: isNonEmptyString, reason: optional(oneOf('cancel', 'complete'))}),
    VIDEO_AI_REMOVE_MODEL: shape<OffscreenRequestMap['VIDEO_AI_REMOVE_MODEL']>({model: optional(videoModel)}),
    VIDEO_AI_SHARE_MODEL: shape<OffscreenRequestMap['VIDEO_AI_SHARE_MODEL']>({model: optional(videoModel)}),
    LOCAL_TRANSLATION_TRANSLATE: shape<OffscreenRequestMap['LOCAL_TRANSLATION_TRANSLATE']>({requestId, model: isLocalTranslationModel, text: isNonEmptyString, sourceLanguage: isNonEmptyString, targetLanguage: isNonEmptyString, sourceLanguageDetectionText: optional(isString)}),
    LOCAL_TRANSLATION_PREPARE: shape<OffscreenRequestMap['LOCAL_TRANSLATION_PREPARE']>({model: isLocalTranslationModel, keepWarm: optional(isBoolean)}),
    LOCAL_TRANSLATION_STATUS: noFields, LOCAL_TRANSLATION_PAUSE: shape<OffscreenRequestMap['LOCAL_TRANSLATION_PAUSE']>({model: isLocalTranslationModel}), LOCAL_TRANSLATION_REMOVE_MODEL: shape<OffscreenRequestMap['LOCAL_TRANSLATION_REMOVE_MODEL']>({model: isLocalTranslationModel}),
    CANCEL_LOCAL_TRANSLATION_OFFSCREEN: shape<OffscreenRequestMap['CANCEL_LOCAL_TRANSLATION_OFFSCREEN']>({requestId}),
    LOCAL_TTS_SYNTHESIZE: shape<OffscreenRequestMap['LOCAL_TTS_SYNTHESIZE']>({requestId, text: isNonEmptyString, language: isNonEmptyString, voice: isNonEmptyString, speed: optional(isFiniteNumber)}),
    LOCAL_TTS_PREPARE: shape<OffscreenRequestMap['LOCAL_TTS_PREPARE']>({keepWarm: optional(isBoolean)}), LOCAL_TTS_STATUS: noFields, LOCAL_TTS_REMOVE_MODEL: noFields,
    CANCEL_LOCAL_TTS_OFFSCREEN: shape<OffscreenRequestMap['CANCEL_LOCAL_TTS_OFFSCREEN']>({requestId}),
};
export function parseOffscreenRequest<K extends OffscreenRequestType>(type: K, value: unknown): OffscreenRequestMap[K] {
    return parseMessage(value, requests[type], `Offscreen ${type}`);
}
export function parseOffscreenResponse<K extends OffscreenRequestType>(type: K, value: unknown): OffscreenResponseMap[K] {
    // 旧端传来的可选句段损坏不影响有效音频；规范化后对外只暴露真实 SpeechCue。
    if (type === 'LOCAL_TTS_SYNTHESIZE' && isMessageRecord(value) && value.timings !== undefined) {
        value = {...value, timings: parseSpeechCues(value.timings)};
    }
    return parseMessage(value, responses[type], `Offscreen ${type}响应`);
}
