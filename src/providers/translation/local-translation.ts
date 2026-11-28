/**
 * @file src/providers/translation/local-translation.ts
 *
 * 文件职责：把统一翻译请求适配到浏览器内本地模型翻译服务。
 * 主要内容：解析当前模型和语言对，通过 Offscreen Worker 执行本地翻译并保留稳定失败原因供图片恢复入口使用；不把本地模型请求发送到云端。
 * 模块边界：只负责 provider 输入转换，模型缓存、Worker 生命周期和取消由 local-translation feature 管理。
 */
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {resolveConfiguredModel, services} from '@/src/core/config/catalog';
import {normalizeLocalTranslationModel, localTranslationErrorKey} from '@/src/core/config/localTranslation';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {localTranslationOffscreenAdapter} from '@/src/platform/offscreen/localTranslation';

async function localTranslation(message: TranslationProviderRequest<string>): Promise<string> {
    if (import.meta.env.BROWSER === 'userscript' || !browserCapabilities.extensionDom) {
        throw Object.assign(new Error('当前浏览器不支持本地模型翻译，请切换到其他翻译服务'), {localTranslationErrorKey: 'settings.localTranslation.error.browser'});
    }

    const current = requireTranslationProviderConfig(message);
    const model = normalizeLocalTranslationModel(resolveConfiguredModel(
        message.modelOverride || current.model[services.localTranslation],
        current.customModel[services.localTranslation],
    ));
    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const timeoutMs = typeof message.requestTimeoutMs === 'number' && Number.isFinite(message.requestTimeoutMs)
        ? Math.max(1, message.requestTimeoutMs)
        : 120_000;
    return localTranslationOffscreenAdapter.translate({
        model,
        text: message.origin,
        sourceLanguage,
        targetLanguage,
        ...(sourceLanguage === 'auto' && typeof message.sourceLanguageDetectionText === 'string'
            && message.sourceLanguageDetectionText.trim()
            ? {sourceLanguageDetectionText: message.sourceLanguageDetectionText}
            : {}),
    }, {
        signal: message.abortSignal,
        timeoutMs,
    }).catch(async (error) => {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const language = normalizeUiLanguage(current.uiLanguage);
        await ensureUiLanguageBundle(language);
        const errorKey = localTranslationErrorKey(error);
        throw Object.assign(new Error(translate(errorKey, language)), {localTranslationErrorKey: errorKey});
    });
}

export default localTranslation;
