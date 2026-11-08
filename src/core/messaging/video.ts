/**
 * @file src/core/messaging/video.ts
 * 文件职责：定义字幕播放器、后台与视频推理共享的纯消息数据契约。
 * 主要内容：按实际 wire 名称关联转写、预热、取消和模型管理的字段与回复，完整校验序列化输入与推理诊断。
 * 模块边界：仅处理视频数据，不加载其它本地翻译或 TTS 的模型目录和校验表，不访问浏览器或读取配置。
 */
import type {InferenceBackend, InferenceResponse} from './inference';
import type {VideoTranscriptionProvider} from '@/src/core/config/model';
import {inferenceResponse as response} from './inference';
import {arrayOf, isBoolean, isFiniteNumber, isNonEmptyString, isString, oneOf, optional, parseMessage, shape, type Validator} from './validation';
const backend = oneOf('webgpu', 'wasm');
const videoModel = oneOf('tiny', 'base', 'small');
export type VideoTranscriptionModel = 'tiny' | 'base' | 'small';
export const NATIVE_QWEN_ASR_MODEL = 'Qwen/Qwen3-ASR-1.7B' as const;
export type VideoTranscriptionCancelReason = 'cancel' | 'complete';
export interface VideoRecognitionMetadata {
    detectedLanguage?: string;
    languageConfidence?: number;
    languageDetectionMs?: number;
    encoderReuse?: boolean;
    encoderDtype?: 'fp32' | 'q4' | 'q8';
    decoderDtype?: 'fp32' | 'q4' | 'q8';
}
export interface VideoTranscriptionSegment {startMs: number; endMs: number; text: string}
export interface VideoTranscriptionResult extends VideoRecognitionMetadata {
    provider?: VideoTranscriptionProvider;
    timingSource?: 'audio-window';
    text: string;
    segments?: VideoTranscriptionSegment[];
    model?: string;
    backend?: InferenceBackend;
    gpuInfo?: string;
    skipped?: boolean;
    decodeMs?: number;
    inferenceMs?: number;
    audioDurationMs?: number;
    threads?: number;
    dtype?: 'q4' | 'q8';
}
export interface VideoPreparationResult extends VideoRecognitionMetadata {
    model: VideoTranscriptionModel;
    backend?: InferenceBackend;
    gpuInfo?: string;
    threads?: number;
    dtype?: 'q4' | 'q8';
}
export interface VideoBackgroundPreparationResult extends Omit<VideoPreparationResult, 'model'> {
    model: VideoTranscriptionModel | typeof NATIVE_QWEN_ASR_MODEL;
    models?: VideoTranscriptionModel[];
    provider?: VideoTranscriptionProvider;
    preparation?: 'client-only';
}
export interface VideoTranscriptionInput {
    streamId?: string;
    model?: VideoTranscriptionModel;
    sourceLanguage?: string;
    audioPcm16Base64?: string;
    audioBase64?: string;
}
export interface VideoPrepareInput {model?: VideoTranscriptionModel; streamId?: string; keepWarm?: boolean; preference?: 'official' | 'mirror' | 'auto'}
const videoTranscriptionInput = shape<VideoTranscriptionInput>({streamId: optional(isNonEmptyString), model: optional(videoModel), sourceLanguage: optional(isString), audioPcm16Base64: optional(isString), audioBase64: optional(isString)});
/** 缺音频的请求不进入模型队列；旧的编码音频后备字段继续可用。 */
export const isVideoTranscriptionInput: Validator<VideoTranscriptionInput> = (value): value is VideoTranscriptionInput => videoTranscriptionInput(value) && (isNonEmptyString(value.audioPcm16Base64) || isNonEmptyString(value.audioBase64));

const metadata = {
    detectedLanguage: optional(isString), languageConfidence: optional(isFiniteNumber), languageDetectionMs: optional(isFiniteNumber), encoderReuse: optional(isBoolean),
    encoderDtype: optional(oneOf('fp32', 'q4', 'q8')), decoderDtype: optional(oneOf('fp32', 'q4', 'q8')),
};
export const isVideoTranscriptionResult = shape<VideoTranscriptionResult>({
    provider: optional(oneOf('browser', 'native-qwen')), timingSource: optional(oneOf('audio-window')),
    ...metadata, text: isString, segments: optional(arrayOf(shape<VideoTranscriptionSegment>({startMs: isFiniteNumber, endMs: isFiniteNumber, text: isString}))),
    model: optional(isString), backend: optional(backend), gpuInfo: optional(isString), skipped: optional(isBoolean), decodeMs: optional(isFiniteNumber), inferenceMs: optional(isFiniteNumber),
    audioDurationMs: optional(isFiniteNumber), threads: optional(isFiniteNumber), dtype: optional(oneOf('q4', 'q8')),
});
export const isVideoPreparationResult = shape<VideoPreparationResult>({...metadata, model: videoModel, backend: optional(backend), gpuInfo: optional(isString), threads: optional(isFiniteNumber), dtype: optional(oneOf('q4', 'q8'))});
/** 网页到后台沿用既有名称；旧配置的模型和来源默认值由视频 handler 明确规范化。 */
export interface VideoBackgroundInput {
    provider?: VideoTranscriptionProvider;
    nativeBaseUrl?: string;
    streamId?: string;
    generation?: number;
    model?: string;
    sourceLanguage?: string;
    audioPcm16Base64?: string;
    audioBase64?: string;
    keepWarm?: boolean;
    preference?: string;
    reason?: string;
}
export const isVideoBackgroundInput = shape<VideoBackgroundInput>({
    provider: optional(oneOf('browser', 'native-qwen')), nativeBaseUrl: optional(isString),
    streamId: optional(isString), generation: optional(isFiniteNumber), model: optional(isString), sourceLanguage: optional(isString),
    audioPcm16Base64: optional(isString), audioBase64: optional(isString), keepWarm: optional(isBoolean), preference: optional(isString), reason: optional(isString),
});
export interface VideoBackgroundRequestMap {
    fluentReadTranscribeLocalVideoAudio: Omit<VideoTranscriptionInput, 'model'> & {model?: string; streamId: string; generation: number; provider?: VideoTranscriptionProvider; nativeBaseUrl?: string};
    fluentReadPrepareLocalVideoModel: Omit<VideoPrepareInput, 'model'> & {model?: string; generation?: number; provider?: VideoTranscriptionProvider; nativeBaseUrl?: string; sourceLanguage?: string};
    fluentReadCancelLocalVideoTranscription: {streamId: string; generation: number; reason?: string};
    fluentReadGetLocalVideoModelState: object;
    fluentReadRemoveLocalVideoModel: {model: VideoTranscriptionModel};
}
export interface VideoBackgroundResponseMap {
    fluentReadTranscribeLocalVideoAudio: InferenceResponse<VideoTranscriptionResult>;
    fluentReadPrepareLocalVideoModel: InferenceResponse<VideoBackgroundPreparationResult>;
    fluentReadCancelLocalVideoTranscription: InferenceResponse;
    fluentReadGetLocalVideoModelState: InferenceResponse<{models: VideoTranscriptionModel[]; available: {tiny: boolean; base: boolean; small: boolean}}>;
    fluentReadRemoveLocalVideoModel: InferenceResponse<{models: VideoTranscriptionModel[]}>;
}
export type VideoBackgroundRequestType = keyof VideoBackgroundRequestMap;
export type VideoBackgroundRequest<K extends VideoBackgroundRequestType = VideoBackgroundRequestType> = {[T in K]: {type: T} & VideoBackgroundRequestMap[T]}[K];
const videoResponses: {[K in VideoBackgroundRequestType]: Validator<VideoBackgroundResponseMap[K]>} = {
    fluentReadTranscribeLocalVideoAudio: response(isVideoTranscriptionResult),
    fluentReadPrepareLocalVideoModel: response((value): value is VideoBackgroundPreparationResult =>
        (isVideoPreparationResult(value) && shape({models: optional(arrayOf(videoModel)), provider: optional(oneOf('browser')), preparation: (item): item is undefined => item === undefined})(value))
        || shape<VideoBackgroundPreparationResult>({...metadata, model: oneOf(NATIVE_QWEN_ASR_MODEL), provider: oneOf('native-qwen'), preparation: oneOf('client-only'),
            models: (item): item is undefined => item === undefined, backend: (item): item is undefined => item === undefined,
            gpuInfo: (item): item is undefined => item === undefined, threads: (item): item is undefined => item === undefined, dtype: (item): item is undefined => item === undefined})(value)),
    fluentReadCancelLocalVideoTranscription: response(shape<object>({})),
    fluentReadGetLocalVideoModelState: response(shape<{models: VideoTranscriptionModel[]; available: {tiny: boolean; base: boolean; small: boolean}}>({models: arrayOf(videoModel), available: shape({tiny: isBoolean, base: isBoolean, small: isBoolean})})),
    fluentReadRemoveLocalVideoModel: response(shape<{models: VideoTranscriptionModel[]}>({models: arrayOf(videoModel)})),
};
export function parseVideoBackgroundResponse<K extends VideoBackgroundRequestType>(type: K, value: unknown): VideoBackgroundResponseMap[K] {
    return parseMessage(value, videoResponses[type], `视频 ${type}响应`);
}
