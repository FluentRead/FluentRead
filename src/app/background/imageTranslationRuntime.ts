/**
 * @file src/app/background/imageTranslationRuntime.ts
 * 文件职责：为图片翻译装配当前服务、OCR 资源、可信图片来源及共享翻译端口。
 * 主要内容：沿用用户 AI 上下文开关，按直连模型或组合中的可用 AI 成员决定是否附带同图邻文；连接既有语言仓库、Offscreen 和进度端口，按当前配置读取图片推理后端。
 * 模块边界：仅注入依赖，不处理 OCR、邻文内容、供应商协议或缓存；消息生命周期由 messageRuntime 和图片 feature 管理。
 */
import {config} from '@/src/services/config/store';
import {translateWithCache} from '@/src/app/translation/runtime';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {hasCompositeTranslationAIContext} from '@/src/core/config/compositeTranslation';
import {supportsTranslationBatch} from '@/src/services/translation/capabilities';
import {createImageTranslationBackgroundHandlers, type ImageOcrLanguageRepository} from './handlers/imageTranslation';
import {imageTranslationOffscreenAdapter, imageTranslationProgressTransport, imageTranslationSourceTransport} from '@/src/features/image-translation/background/offscreenAdapter';

export function createImageTranslationRuntime(languages: ImageOcrLanguageRepository) {
    return createImageTranslationBackgroundHandlers({
        assertLanguagesDownloaded: languages.assertDownloaded, getDownloadedLanguages: languages.getDownloaded,
        ...imageTranslationOffscreenAdapter, ...imageTranslationSourceTransport,
        translateTexts: translateWithCache,
        getTranslationService: () => config.imageTranslationService || config.service, getGlossaryConfig: () => config,
        getImageOcrEngine: () => config.imageTranslationOcrEngine, getImageInferenceBackend: () => config.imageTranslationInferenceBackend,
        supportsBatchTranslation: supportsTranslationBatch,
        isTextContextEnabled: service => config.enableAIContext && (servicesType.isUseAIContext(service,
            resolveConfiguredModel(config.model?.[service], config.customModel?.[service])) || hasCompositeTranslationAIContext(config, service)),
        markLanguagesDownloaded: languages.markDownloaded, markLanguagesRemoved: languages.markRemoved,
        ...imageTranslationProgressTransport,
    });
}
