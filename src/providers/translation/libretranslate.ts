/**
 * @file src/providers/translation/libretranslate.ts
 * 文件职责：接入用户指定的 LibreTranslate 实例，支持自建免密钥翻译。
 * 主要内容：读取冻结实例地址与可选密钥，映射中文简繁代码，调用纯文本 JSON 协议并验证有效译文。
 * 模块边界：不选择第三方公共实例或参与匿名后备链；配置沿用现有代理地址和凭据存储，不管理页面 DOM。
 */
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {config} from '@/src/services/config/store';
import {getTranslationProviderConfig, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {translateStructuredText} from './structuredText';

export default async function libreTranslate(message: TranslationProviderRequest): Promise<string | string[]> {
    const current = getTranslationProviderConfig(message, config);
    let endpoint: URL;
    try {
        endpoint = new URL(current.proxy.libreTranslate);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
    } catch {
        throw Object.assign(new Error('请填写有效的 LibreTranslate 实例地址（完整 /translate 地址）'), {statusCode: 400});
    }
    const languages = resolveTranslationLanguages(message, {sourceLanguage: current.from, targetLanguage: current.to});
    const language = (code: string) => ({'zh-Hans': 'zh', 'zh-Hant': 'zt'}[code] || code);
    const key = current.token.libreTranslate?.trim();
    return translateStructuredText(message.origin, async q => {
        const response = await runtimeFetch(endpoint, {
            method: 'POST', credentials: 'omit', signal: message.abortSignal,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({q, source: language(languages.sourceLanguage), target: language(languages.targetLanguage), format: 'text', ...(key ? {api_key: key} : {})}),
        });
        if (!response.ok) throw createHttpStatusError(response, 'LibreTranslate 翻译失败');
        const result = await readJsonResponse<{translatedText?: unknown; error?: unknown} | null>(response, 'LibreTranslate 返回的不是有效 JSON');
        if (result?.error) throw new Error('LibreTranslate 翻译失败，请检查实例的语言支持、密钥和额度');
        return result?.translatedText as string;
    }, message.abortSignal);
}
