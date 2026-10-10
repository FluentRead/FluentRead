/**
 * @file src/providers/translation/google-cloud-translation.ts
 *
 * 文件职责：适配 Google Cloud Translation v2 原生文本数组 API，与免费网页端点 google.ts 独立。
 * 主要内容：通过 x-goog-api-key 请求头鉴权，以 format=text 和 q 数组分包发送原文，完整校验 translations 的数量、类型和非空值；保留源槽序号与空白，全部成功后返回对应形状。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {services} from '@/src/core/config/catalog';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {method, urls} from '@/src/core/config/constants';
import {config} from '@/src/services/config/store';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError, createProviderCodeError} from '@/src/platform/http/errors';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {getTranslationProviderConfig, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {resolveCloudLanguages} from './cloud/languages';
import {readNativeBatchJson, translateNativeTextBatch} from './native-batch';

export const GOOGLE_CLOUD_TRANSLATION_URL: string = urls[services.googleCloudTranslation];

type GoogleCloudResponse = {
    data?: {translations?: Array<{translatedText?: string}>};
    error?: {code?: unknown; message?: unknown};
};

async function googleCloudTranslation(message: TranslationProviderRequest<string | string[]>) {
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const current = getTranslationProviderConfig(message, config);
    const enableNativeBatch = message.enableNativeBatch
        ?? isNativeTranslationBatchEnabled(services.googleCloudTranslation, current.nativeBatchTranslationEnabled);
    const apiKey = current.token[services.googleCloudTranslation]?.trim();
    if (!apiKey) {
        throw new Error('谷歌云翻译尚未配置 API Key，请先在设置中填写');
    }

    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    const {source, target} = resolveCloudLanguages('googleCloudTranslation', sourceLanguage, targetLanguage);

    return translateNativeTextBatch(message.origin, async origins => {
        const response = await runtimeFetch(GOOGLE_CLOUD_TRANSLATION_URL, {
            method: method.POST,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                // 密钥走请求头而不是查询串，避免出现在代理日志、历史记录或错误回显里。
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                q: origins,
                target,
                format: 'text',
                ...(source ? {source} : {}),
            }),
            signal: message.abortSignal,
        });
        if (!response.ok) throw createHttpStatusError(response, '谷歌云翻译请求失败');
        const result = await readNativeBatchJson<GoogleCloudResponse | null>(response, '谷歌云翻译返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        if (result?.error) throw createProviderCodeError('谷歌云翻译错误', result.error.code);
        return Array.isArray(result?.data?.translations)
            ? result.data.translations.map(item => item?.translatedText) : undefined;
    }, message.abortSignal, '谷歌云翻译返回格式异常', enableNativeBatch);
}

export default googleCloudTranslation;
