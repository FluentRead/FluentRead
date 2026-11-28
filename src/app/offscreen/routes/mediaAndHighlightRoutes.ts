/**
 * @file src/app/offscreen/routes/mediaAndHighlightRoutes.ts
 *
 * 文件职责：路由 Offscreen 视频语音转写模型、视频读音标注与智能信息高亮模型管理及推理评分消息。
 * 主要内容：导出 createMediaAndHighlightRoutes 与 createInformationHighlightHandler，严格校验后台发送方身份，处理读音标注与高亮评分的先取消后启动队列与结果校验。
 * 模块边界：仅协调消息准入、模型枚举检查与取消表状态，不实现 ASR 转写、分词注音或信息高亮打分算法。
 */

import {
    DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID,
    getInformationHighlightModel,
} from '@/src/core/config/informationHighlightModel';
import {
    isVideoPreparationResult,
    isVideoTranscriptionResult,
    parseOffscreenRequest,
} from '@/src/core/messaging/offscreen';
import {isReadingAnnotationResult} from '@/src/core/messaging/readingAnnotation';
import {
    cancelRequest,
    errorMessage,
    isRecord,
    requiredRequestId,
    respondWith,
    runCancellableRequest,
    validatedResult,
    type OffscreenMessageDependencies,
    type OffscreenRouteHandler,
    type OffscreenRouteMap,
} from './shared';

export function createInformationHighlightHandler(
    dependencies: OffscreenMessageDependencies,
): OffscreenRouteHandler {
    const activeInformationHighlights = new Map<string, AbortController>();
    const cancelledInformationHighlights = new Set<string>();

    return (message, sender, sendResponse) => {
        const source = sender as {id?: string; tab?: unknown};
        if (source?.id !== dependencies.runtimeId || source.tab || !dependencies.informationHighlight) {
            sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_UNTRUSTED_SENDER'});
            return true;
        }
        const feature = dependencies.informationHighlight;
        const modelId = message.modelId === undefined
            ? DEFAULT_INFORMATION_HIGHLIGHT_MODEL_ID
            : getInformationHighlightModel(message.modelId).id;
        if (message.modelId !== undefined && modelId !== message.modelId) {
            sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'});
            return true;
        }
        const commands: Record<string, () => Promise<unknown>> = {
            INFORMATION_HIGHLIGHT_STATUS_OFFSCREEN: () => feature.status(modelId),
            INFORMATION_HIGHLIGHT_PREPARE_OFFSCREEN: () => feature.prepare(modelId),
            INFORMATION_HIGHLIGHT_PAUSE_OFFSCREEN: () => feature.pause(modelId),
            INFORMATION_HIGHLIGHT_REMOVE_OFFSCREEN: () => feature.remove(modelId),
        };
        const type = message.type as string;
        if (commands[type]) {
            respondWith(commands[type], sendResponse, status => ({success: true, status}));
            return true;
        }
        let requestId: string;
        try {
            requestId = requiredRequestId(message.requestId);
        } catch (error) {
            sendResponse({success: false, error: errorMessage(error)});
            return true;
        }
        if (type === 'INFORMATION_HIGHLIGHT_CANCEL_OFFSCREEN') {
            cancelRequest(activeInformationHighlights, message, sendResponse, id => {
                cancelledInformationHighlights.add(id);
                if (cancelledInformationHighlights.size > 512) {
                    cancelledInformationHighlights.delete(cancelledInformationHighlights.values().next().value!);
                }
            });
            return true;
        }
        if (type !== 'INFORMATION_HIGHLIGHT_SCORE_OFFSCREEN'
            || typeof message.text !== 'string'
            || !message.text
            || message.text.length > 12_000
            || activeInformationHighlights.has(requestId)) {
            sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_INVALID_REQUEST'});
            return true;
        }
        if (cancelledInformationHighlights.delete(requestId)) {
            sendResponse({success: false, error: '信息高亮已取消'});
            return true;
        }
        runCancellableRequest(
            activeInformationHighlights,
            requestId,
            sendResponse,
            '信息高亮已取消',
            signal => feature.score(message.text as string, signal, modelId),
            result => ({success: true, result}),
            error => ({success: false, error: errorMessage(error)}),
        );
        return true;
    };
}

export function createMediaAndHighlightRoutes(dependencies: OffscreenMessageDependencies): OffscreenRouteMap {
    const activeReadingAnnotations = new Map<string, AbortController>();
    const cancelledReadingAnnotations = new Set<string>();

    const readingAnnotationGuard = (handler: OffscreenRouteHandler): OffscreenRouteHandler =>
        (message, sender, sendResponse) => {
            if (!dependencies.readingAnnotation || !isRecord(sender) || sender.id !== dependencies.runtimeId || sender.tab !== undefined) {
                sendResponse({success: false, error: '读音标注发送方无效'});
                return true;
            }
            return handler(message, sender, sendResponse);
        };

    return {
        READING_ANNOTATION_CANCEL: readingAnnotationGuard((message, _sender, sendResponse) => {
            cancelRequest(activeReadingAnnotations, message, sendResponse, id => {
                cancelledReadingAnnotations.add(id);
                if (cancelledReadingAnnotations.size > 256) {
                    cancelledReadingAnnotations.delete(cancelledReadingAnnotations.values().next().value!);
                }
            });
            return true;
        }),
        READING_ANNOTATION: readingAnnotationGuard((message, _sender, sendResponse) => {
            try {
                const request = parseOffscreenRequest('READING_ANNOTATION', message);
                if (cancelledReadingAnnotations.delete(request.requestId)) {
                    sendResponse({success: false, error: '读音标注已取消'});
                    return true;
                }
                if (activeReadingAnnotations.has(request.requestId)) throw new Error('读音标注请求标识重复');
                runCancellableRequest(
                    activeReadingAnnotations,
                    request.requestId,
                    sendResponse,
                    '读音标注已取消',
                    signal => dependencies.readingAnnotation!.annotate(request, signal),
                    result => {
                        if (!isReadingAnnotationResult(result)) throw new Error('读音标注结果无效');
                        return {success: true, result};
                    },
                    error => ({success: false, error: errorMessage(error)}),
                );
            } catch (error) {
                sendResponse({success: false, error: errorMessage(error)});
            }
            return true;
        }),
        VIDEO_AI_TRANSCRIBE: (message, _sender, sendResponse) => {
            if (!dependencies.videoAi) { sendResponse({success: false, error: '视频 AI 未启用'}); return true; }
            respondWith(
                () => dependencies.videoAi!.transcribe(parseOffscreenRequest('VIDEO_AI_TRANSCRIBE', message)),
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isVideoTranscriptionResult, '视频 AI 转写')}),
            );
            return true;
        },
        VIDEO_AI_REMOVE_MODEL: (message, _sender, sendResponse) => {
            respondWith(async () => {
                if (!dependencies.videoAi?.removeModel) throw new Error('模型清除不可用');
                await dependencies.videoAi.removeModel(parseOffscreenRequest('VIDEO_AI_REMOVE_MODEL', message));
            }, sendResponse, () => ({success: true}));
            return true;
        },
        VIDEO_AI_SHARE_MODEL: (message, _sender, sendResponse) => {
            respondWith(async () => {
                if (!dependencies.videoAi?.shareModel) throw new Error('共享模型迁移不可用');
                await dependencies.videoAi.shareModel(parseOffscreenRequest('VIDEO_AI_SHARE_MODEL', message));
            }, sendResponse, () => ({success: true}));
            return true;
        },
        VIDEO_AI_PREPARE: (message, _sender, sendResponse) => {
            if (!dependencies.videoAi) { sendResponse({success: false, error: '视频 AI 未启用'}); return true; }
            respondWith(
                () => dependencies.videoAi!.prepare(parseOffscreenRequest('VIDEO_AI_PREPARE', message)),
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isVideoPreparationResult, '视频 AI 模型')}),
            );
            return true;
        },
        VIDEO_AI_CANCEL: (message, _sender, sendResponse) => {
            if (!dependencies.videoAi) { sendResponse({success: true}); return true; }
            respondWith(
                () => {
                    const request = parseOffscreenRequest('VIDEO_AI_CANCEL', message);
                    return dependencies.videoAi!.cancel(request.streamId, request.reason || 'cancel');
                },
                sendResponse,
                () => ({success: true}),
            );
            return true;
        },
    };
}
