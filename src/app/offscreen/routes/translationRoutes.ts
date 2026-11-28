/**
 * @file src/app/offscreen/routes/translationRoutes.ts
 *
 * 文件职责：路由 Offscreen Chrome 内置翻译与本地神经网络翻译（模型准备、暂停、状态、清除与可取消翻译）消息。
 * 主要内容：导出 createTranslationRoutes，维护独立的在途请求取消表，并保留 Chrome 待准备语言对、模型不可用及 API 不可用结构化错误码。
 * 模块边界：仅做参数校验、取消协调与错误格式化，不实现具体翻译推理或模型下载。
 */

import {
    isLocalTranslationSnapshot,
    isLocalTranslationStatus,
    parseOffscreenRequest,
} from '@/src/core/messaging/offscreen';
import {
    OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE,
} from '@/src/platform/offscreen/client';
import {isChromePreparationRequiredError} from '../translation';
import {
    cancelRequest,
    errorMessage,
    requiredLocalTranslationModel,
    requiredRequestId,
    requiredString,
    respondWith,
    runCancellableRequest,
    validatedResult,
    type OffscreenMessageDependencies,
    type OffscreenRouteMap,
} from './shared';

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
    } else if (error instanceof Error && error.name === 'BrowserTranslationApiUnavailableError') {
        response.errorCode = 'api-unavailable';
        response.errorName = error.name;
    }
    return response;
}

export function createTranslationRoutes(dependencies: OffscreenMessageDependencies): OffscreenRouteMap {
    const activeChromeTranslations = new Map<string, AbortController>();
    const activeLocalTranslations = new Map<string, AbortController>();

    return {
        CHROME_TRANSLATE_OFFSCREEN: (message, _sender, sendResponse) => {
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

            runCancellableRequest(
                activeChromeTranslations,
                requestId,
                sendResponse,
                'Chrome 翻译请求已取消',
                (signal) => dependencies.translate(message.data, signal),
                (result) => {
                    if (typeof result !== 'string') throw new Error('Chrome 翻译结果无效');
                    return {success: true, result, requestId};
                },
                (error) => ({...chromeTranslationErrorResponse(error), requestId}),
            );
            return true;
        },
        [OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE]: (message, _sender, sendResponse) => {
            cancelRequest(activeChromeTranslations, message, sendResponse);
            return true;
        },
        LOCAL_TRANSLATION_PREPARE: (message, _sender, sendResponse) => {
            if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
            respondWith(
                () => {
                    requiredLocalTranslationModel(message.model);
                    return dependencies.localTranslation!.prepare(parseOffscreenRequest('LOCAL_TRANSLATION_PREPARE', message));
                },
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isLocalTranslationSnapshot, '本地翻译模型')}),
            );
            return true;
        },
        LOCAL_TRANSLATION_PAUSE: (message, _sender, sendResponse) => {
            if (!dependencies.localTranslation?.pause) { sendResponse({success: false, error: 'LOCAL_TRANSLATION_UNAVAILABLE'}); return true; }
            respondWith(
                () => {
                    requiredLocalTranslationModel(message.model);
                    return dependencies.localTranslation!.pause!(parseOffscreenRequest('LOCAL_TRANSLATION_PAUSE', {model: message.model}));
                },
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isLocalTranslationSnapshot, 'local translation')}),
            );
            return true;
        },
        LOCAL_TRANSLATION_STATUS: (_message, _sender, sendResponse) => {
            if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
            respondWith(
                () => dependencies.localTranslation!.status(),
                sendResponse,
                (result) => ({success: true, ...validatedResult(result, isLocalTranslationStatus, '本地翻译模型状态')}),
            );
            return true;
        },
        LOCAL_TRANSLATION_REMOVE_MODEL: (message, _sender, sendResponse) => {
            if (!dependencies.localTranslation) { sendResponse({success: false, error: '本地翻译未启用'}); return true; }
            respondWith(
                () => {
                    requiredLocalTranslationModel(message.model);
                    return dependencies.localTranslation!.removeModel(parseOffscreenRequest('LOCAL_TRANSLATION_REMOVE_MODEL', message));
                },
                sendResponse,
                () => ({success: true}),
            );
            return true;
        },
        LOCAL_TRANSLATION_TRANSLATE: (message, _sender, sendResponse) => {
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

            runCancellableRequest(
                activeLocalTranslations,
                requestId,
                sendResponse,
                '本地翻译请求已取消',
                (signal) => dependencies.localTranslation!.translate(parseOffscreenRequest('LOCAL_TRANSLATION_TRANSLATE', message), signal),
                (result) => {
                    if (typeof result !== 'string') throw new Error('本地翻译结果无效');
                    return {success: true, result, requestId};
                },
                (error) => ({success: false, error: errorMessage(error), requestId}),
            );
            return true;
        },
        [OFFSCREEN_CANCEL_LOCAL_TRANSLATION_MESSAGE_TYPE]: (message, _sender, sendResponse) => {
            cancelRequest(activeLocalTranslations, message, sendResponse);
            return true;
        },
    };
}
