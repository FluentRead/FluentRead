/**
 * @file src/app/background/areaRuntime.ts
 * 文件职责：为圈选翻译装配浏览器截图、图片裁剪、识别配置与共享翻译服务。
 * 主要内容：连接真实标签归属校验、OCR 语言包检查、能力路由、保留可信普通/私密/未知来源的冻结识图和文字翻译事务及进度通知。
 * 模块边界：本文件仅注入依赖，不实现模型能力、截图裁剪、OCR 或翻译算法；消息安装由 messageRuntime 统一负责。
 */
import {translationPrivacyContext} from '@/src/services/translation/requestSnapshot';
import {config} from '@/src/services/config/store';
import {translateWithCache} from '@/src/app/translation/runtime';
import {resolveAreaRecognitionRoute} from '@/src/core/config/vision';
import {modelVisionProbe} from '@/src/app/translation/visionProbeRuntime';
import {prepareModelVisionRoute} from '@/src/services/translation/visionProbe';
import {createAreaTranslationBackgroundHandlers, createAreaCaptureOwnershipVerifier} from './handlers/areaTranslation';
import {prepareAreaTextTranslation, prepareAreaVisionRecognition} from '@/src/features/area-translation/services/textTranslation';
import {areaTranslationOffscreenAdapter} from '@/src/features/area-translation/background/offscreenAdapter';
import {imageTranslationProgressTransport} from '@/src/features/image-translation/background/offscreenAdapter';

export function createAreaTranslationRuntime(assertLanguagesDownloaded: (language: string) => Promise<void>) {
    return createAreaTranslationBackgroundHandlers({
        captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, {format: 'png'}),
        assertCaptureOwner: createAreaCaptureOwnershipVerifier(tabId => browser.tabs.get(tabId)),
        getDefaultSourceLanguage: () => config.from,
        assertLanguagesDownloaded,
        translateArea: areaTranslationOffscreenAdapter.translateArea,
        getVisionRoute: () => resolveAreaRecognitionRoute(config),
        prepareVisionRoute: () => prepareModelVisionRoute(config, modelVisionProbe.resolve),
        prepareVisionTranslation: (language, title, context) => prepareAreaVisionRecognition(config, language, title,
            areaTranslationOffscreenAdapter.cropArea, translateWithCache, Date.now, translationPrivacyContext(context)),
        prepareTextTranslation: (language, title, context) => prepareAreaTextTranslation(config, language, title,
            {pageUrl: context.sender?.url, context: 'page', ...translationPrivacyContext(context)}, translateWithCache),
        sendProgress: imageTranslationProgressTransport.sendProgress,
    });
}
