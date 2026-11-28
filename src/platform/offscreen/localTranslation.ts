/**
 * @file src/platform/offscreen/localTranslation.ts
 *
 * 文件职责：提供本地翻译 provider 与后台设置 handler 共用的 Offscreen 消息端口。
 * 主要内容：通过已知 type 关联的 DTO 校验真实序列化消息，转发文本翻译、模型准备、状态查询和清除请求，并把取消信号绑定到对应 requestId。
 * 模块边界：只连接平台 Offscreen client，不读取配置、不初始化模型，也不访问宿主网页 DOM。
 */
import {
    type LocalTranslationDownloadOptions,
    type LocalTranslationDownloadSnapshot,
    type LocalTranslationModelId,
} from '@/src/core/config/localTranslation';
import type {LocalTranslationStatus, InferenceSuccess, InferenceFailure} from '@/src/core/messaging/offscreen';
import {sendOffscreenRequest} from './requests';
import {OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE, type OffscreenClient} from './client';
import {extensionDomClient} from './extensionClient';

export interface LocalTranslationRequest {
    readonly model: LocalTranslationModelId;
    readonly text: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sourceLanguageDetectionText?: string;
}

export interface LocalTranslationOffscreenOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

function requestId(): string {
    return crypto.randomUUID();
}

function errorMessage(response: InferenceFailure, fallback: string): string {
    return response.error || fallback;
}

export function createLocalTranslationOffscreenAdapter(client: OffscreenClient = extensionDomClient) {
    return {
        async translate(request: LocalTranslationRequest, options: LocalTranslationOffscreenOptions = {}): Promise<string> {
            const id = requestId();
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TRANSLATION_TRANSLATE',
                requestId: id,
                model: request.model,
                text: request.text,
                sourceLanguage: request.sourceLanguage,
                targetLanguage: request.targetLanguage,
                ...(request.sourceLanguageDetectionText !== undefined
                    ? {sourceLanguageDetectionText: request.sourceLanguageDetectionText}
                    : {}),
            }, {
                signal: options.signal,
                timeoutMs: options.timeoutMs ?? 120_000,
                cancelMessage: {type: OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE, requestId: id},
            });
            if (!response.success) {
                throw new Error(errorMessage(response, '本地翻译失败'));
            }
            return response.result;
        },
        async prepare(
            model: LocalTranslationModelId,
            keepWarm = false,
            options?: LocalTranslationDownloadOptions,
        ): Promise<InferenceSuccess<LocalTranslationDownloadSnapshot>> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TRANSLATION_PREPARE',
                model,
                keepWarm,
                ...(options?.preference ? {preference: options.preference} : {}),
                ...(options?.mirrorUrl ? {mirrorUrl: options.mirrorUrl} : {}),
            }, {timeoutMs: 30_000});
            if (!response.success) throw new Error(errorMessage(response, '本地翻译模型下载失败'));
            return response;
        },
        async status(): Promise<InferenceSuccess<LocalTranslationStatus>> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TRANSLATION_STATUS',
            }, {timeoutMs: 30_000});
            if (!response.success) throw new Error(errorMessage(response, '无法读取本地翻译模型状态'));
            return response;
        },
        async pause(model: LocalTranslationModelId): Promise<InferenceSuccess<LocalTranslationDownloadSnapshot>> {
            const response = await sendOffscreenRequest(client, {type: 'LOCAL_TRANSLATION_PAUSE', model}, {timeoutMs: 30_000});
            if (!response.success) throw new Error(errorMessage(response, 'LOCAL_TRANSLATION_PAUSE_FAILED'));
            return response;
        },
        async remove(model: LocalTranslationModelId): Promise<void> {
            const response = await sendOffscreenRequest(client, {
                type: 'LOCAL_TRANSLATION_REMOVE_MODEL',
                model,
            }, {timeoutMs: 30_000});
            if (!response.success) throw new Error(errorMessage(response, '本地翻译模型清除失败'));
        },
    };
}

export const localTranslationOffscreenAdapter = /* @__PURE__ */ createLocalTranslationOffscreenAdapter();
