/**
 * @file src/providers/translation/azure-translator.ts
 *
 * 文件职责：适配 Azure Translator v3 原生文本数组 API，与 Edge 免费翻译和 Azure OpenAI 独立。
 * 主要内容：冻结密钥、区域和语言，以 plain 文本项分包发送，验证每个源槽对应的 translations 译文；空白槽本地保留，取消或任一响应异常均不返回半批结果。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {resolveCloudRegion, services} from '@/src/core/config/catalog';
import {AZURE_TRANSLATOR_ENDPOINT, method} from '@/src/core/config/constants';
import {config} from '@/src/services/config/store';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError, createProviderCodeError} from '@/src/platform/http/errors';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {getTranslationProviderConfig, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {resolveCloudLanguages} from './cloud/languages';
import {readNativeBatchJson, translateNativeTextBatch} from './native-batch';

type AzureTranslatorResponse =
    | Array<{translations?: Array<{text?: string}>}>
    | {error?: {code?: unknown; message?: unknown}};

async function azureTranslator(message: TranslationProviderRequest<string | string[]>) {
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const current = getTranslationProviderConfig(message, config);
    const apiKey = current.token[services.azureTranslator]?.trim();
    if (!apiKey) {
        throw new Error('Azure 翻译尚未配置密钥，请先在设置中填写');
    }
    const region = resolveCloudRegion(services.azureTranslator, current.serviceRegion?.[services.azureTranslator]);

    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    const {source, target} = resolveCloudLanguages('azureTranslator', sourceLanguage, targetLanguage);

    const url = new URL(AZURE_TRANSLATOR_ENDPOINT);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', target);
    url.searchParams.set('textType', 'plain');
    if (source) url.searchParams.set('from', source);

    return translateNativeTextBatch(message.origin, async origins => {
        const response = await runtimeFetch(url.toString(), {
            method: method.POST,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Ocp-Apim-Subscription-Key': apiKey,
                // 全球资源不需要区域头；区域资源缺少该头会返回 401。
                ...(region === 'global' ? {} : {'Ocp-Apim-Subscription-Region': region}),
            },
            body: JSON.stringify(origins.map(Text => ({Text}))),
            signal: message.abortSignal,
        });
        if (!response.ok) throw createHttpStatusError(response, 'Azure 翻译请求失败');
        const result = await readNativeBatchJson<AzureTranslatorResponse | null>(response, 'Azure 翻译返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        if (!Array.isArray(result) && result?.error) {
            throw createProviderCodeError('Azure 翻译错误', result.error.code);
        }
        return Array.isArray(result) ? result.map(item =>
            Array.isArray(item?.translations) && item.translations.length === 1
                ? item.translations[0]?.text : undefined) : undefined;
    }, message.abortSignal, 'Azure 翻译返回格式异常');
}

export default azureTranslator;
