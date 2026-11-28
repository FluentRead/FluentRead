/**
 * @file src/app/offscreen/routes/imageRoutes.ts
 *
 * 文件职责：路由 Offscreen 远程图片拉取、整图与区域 OCR 翻译、区域裁剪、漫画模型与 OCR 语言包下载清除消息。
 * 主要内容：导出 createImageRoutes，统一管理图片操作在途表与先取消后启动队列（上限 512），校验 OCR 引擎与推理后端枚举并在清除模型期间互斥新任务。
 * 模块边界：仅负责图片/区域消息的准入、取消与结果契约校验，不直接执行 Canvas 渲染或 OCR 推理。
 */

import type {ImageViewport} from '@/src/shared/image/types';
import {imageTranslationFailureResponse} from '@/src/features/image-translation/failure';
import {OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE} from '@/src/platform/offscreen/client';
import {
    cancelRequest,
    errorMessage,
    optionalTitle,
    parseOcrLanguages,
    parseSelection,
    requiredBoolean,
    requiredImage,
    requiredImageUrl,
    requiredRequestId,
    requiredSourceLanguage,
    respondWith,
    resultRecord,
    runCancellableRequest,
    type OffscreenMessageDependencies,
    type OffscreenRouteMap,
    type OffscreenSendResponse,
} from './shared';

export function createImageRoutes(dependencies: OffscreenMessageDependencies): OffscreenRouteMap {
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

        runCancellableRequest(
            activeImageOperations,
            requestId,
            sendResponse,
            '图片 OCR 请求已取消',
            (signal) => operation(signal, requestId),
            shape,
            imageTranslationFailureResponse,
        );
    };

    return {
        FLUENT_READ_IMAGE_FETCH_OFFSCREEN: (message, _sender, sendResponse) => {
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
        },
        FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN: (message, _sender, sendResponse) => {
            startImageOperation(
                message,
                sendResponse,
                (signal, requestId) => {
                    if (message.ocrEngine !== undefined && message.ocrEngine !== 'tesseract' && message.ocrEngine !== 'paddle') {
                        throw new Error('图片识别方式无效');
                    }
                    if (message.inferenceBackend !== undefined && message.inferenceBackend !== 'auto' && message.inferenceBackend !== 'cpu') {
                        throw new Error('图片处理后端无效');
                    }
                    const inferenceOptions: [mangaViewport?: ImageViewport, inferenceBackend?: 'auto' | 'cpu'] = message.inferenceBackend !== undefined
                        ? [message.mangaViewport as ImageViewport | undefined, message.inferenceBackend]
                        : message.mangaViewport === undefined ? [] : [message.mangaViewport as ImageViewport];
                    return dependencies.translateImage(
                        requiredImage(message.image),
                        requiredSourceLanguage(message.sourceLanguage),
                        optionalTitle(message.title),
                        signal,
                        requestId,
                        message.manga === undefined ? false : requiredBoolean(message.manga, 'manga'),
                        message.ocrEngine === 'paddle' ? 'paddle' : 'tesseract',
                        ...inferenceOptions,
                    );
                },
                (result) => ({...resultRecord(result, '图片翻译'), success: true}),
            );
            return true;
        },
        FLUENT_READ_AREA_TRANSLATE_OFFSCREEN: (message, _sender, sendResponse) => {
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
        },
        FLUENT_READ_AREA_CROP_OFFSCREEN: (message, _sender, sendResponse) => {
            if (!dependencies.cropArea) { sendResponse({success: false, error: '区域裁剪不可用'}); return true; }
            startImageOperation(
                message,
                sendResponse,
                (signal, requestId) => dependencies.cropArea!(
                    requiredImage(message.image),
                    parseSelection(message.selection),
                    signal,
                    requestId,
                ),
                (result) => ({...resultRecord(result, '区域裁剪'), success: true}),
            );
            return true;
        },
        [OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE]: (message, _sender, sendResponse) => {
            cancelRequest(activeImageOperations, message, sendResponse, rememberImageCancellation);
            return true;
        },
        FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN: (message, _sender, sendResponse) => {
            respondWith(async () => {
                if (!dependencies.removeOcrLanguages) throw new Error('语言包清除不可用');
                if (activeImageOperations.size || removingOcrModels) throw new Error('图片识别正在运行，请完成后再清除语言包');
                removingOcrModels = true;
                try { await dependencies.removeOcrLanguages(parseOcrLanguages(message.languages)); }
                finally { removingOcrModels = false; }
            }, sendResponse, () => ({success: true}));
            return true;
        },
        FLUENT_READ_MANGA_MODEL_STATUS_OFFSCREEN: (_message, _sender, sendResponse) => {
            respondWith(async () => {
                if (!dependencies.mangaModelStatus) throw new Error('漫画识别模型管理不可用');
                return dependencies.mangaModelStatus();
            }, sendResponse, result => ({...resultRecord(result, '漫画模型状态'), success: true}));
            return true;
        },
        FLUENT_READ_MANGA_MODEL_REMOVE_OFFSCREEN: (_message, _sender, sendResponse) => {
            respondWith(async () => {
                if (!dependencies.removeMangaModels) throw new Error('漫画识别模型管理不可用');
                if (activeImageOperations.size || removingOcrModels) throw new Error('图片识别正在运行，请完成后再清除语言包');
                removingOcrModels = true;
                try { await dependencies.removeMangaModels(); }
                finally { removingOcrModels = false; }
            }, sendResponse, () => ({success: true}));
            return true;
        },
        FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN: (message, _sender, sendResponse) => {
            respondWith(
                () => dependencies.downloadOcrLanguages(parseOcrLanguages(message.languages)),
                sendResponse,
                () => ({success: true}),
            );
            return true;
        },
    };
}
