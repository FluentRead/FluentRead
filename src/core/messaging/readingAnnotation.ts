/**
 * @file src/core/messaging/readingAnnotation.ts
 * 文件职责：定义视频字幕读音标注在内容脚本、后台、离屏页面与 Worker 之间的纯数据契约。
 * 主要内容：关联原文、语言、请求标识及罗马音结果，限制文本和标识长度，并校验成功、失败、空结果与 Worker 回包。
 * 模块边界：仅包含可序列化 DTO 与纯校验，不加载词典、转写引擎、浏览器或业务配置。
 */
import {inferenceResponse, type InferenceResponse} from './inference';
import {isMessageRecord, isNonEmptyString, isPositiveSafeInteger, parseMessage, shape, type Validator} from './validation';

const READING_ANNOTATION_LANGUAGES = ['ja', 'ko', 'zh', 'ru', 'el', 'ar', 'hi', 'th'] as const;
export interface VideoReadingAnnotation {text: string; language: string; scheme: string}
export interface ReadingAnnotationInput {text: string; language: string}
export interface ReadingAnnotationRequest extends ReadingAnnotationInput {requestId: string}
export type ReadingAnnotationCancellation = {requestId: string};
export type ReadingAnnotationResponse = InferenceResponse<{result: VideoReadingAnnotation | null}>;
export interface ReadingAnnotationWorkerRequest extends ReadingAnnotationInput {id: number}
export type ReadingAnnotationWorkerResponse = {id: number; ok: true; result: VideoReadingAnnotation | null} | {id: number; ok: false; error: string};

const language: Validator<string> = (value): value is string => typeof value === 'string' && READING_ANNOTATION_LANGUAGES.some(item => item === value);
const text: Validator<string> = (value): value is string => isNonEmptyString(value) && value.length <= 3_000;
const resultText: Validator<string> = (value): value is string => isNonEmptyString(value) && value.length <= 12_000;
const scheme: Validator<string> = (value): value is string => isNonEmptyString(value) && value.length <= 64;
const requestId: Validator<string> = (value): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
const isVideoReadingAnnotation = shape<VideoReadingAnnotation>({text: resultText, language, scheme});
export const isReadingAnnotationResult: Validator<VideoReadingAnnotation | null> = (value): value is VideoReadingAnnotation | null => value === null || isVideoReadingAnnotation(value);
export const isReadingAnnotationRequest = shape<ReadingAnnotationRequest>({text, language, requestId});
export const isReadingAnnotationCancellation = shape<ReadingAnnotationCancellation>({requestId});
export const isReadingAnnotationResponse = inferenceResponse(shape<{result: VideoReadingAnnotation | null}>({result: isReadingAnnotationResult}));
export const isReadingAnnotationWorkerRequest = shape<ReadingAnnotationWorkerRequest>({id: isPositiveSafeInteger, text, language});
export const isReadingAnnotationWorkerResponse: Validator<ReadingAnnotationWorkerResponse> = (value): value is ReadingAnnotationWorkerResponse =>
  isMessageRecord(value) && isPositiveSafeInteger(value.id)
  && (value.ok === true ? isReadingAnnotationResult(value.result) : value.ok === false && typeof value.error === 'string');
export function parseReadingAnnotationResponse(value: unknown): ReadingAnnotationResponse {
  return parseMessage(value, isReadingAnnotationResponse, '读音标注响应');
}
