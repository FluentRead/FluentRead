/**
 * @file src/providers/translation/deepl.ts
 *
 * 文件职责：适配 DeepL 原生文本数组 API，处理语言映射、纯文本传输、代理选择与完整响应校验。
 * 主要内容：以 text 数组分包发送单条或多条原文，不启用 HTML 标签解析；保留重复槽、字面标签和内部换行，空白槽本地返回，所有分包成功才发布完整结果。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {isNativeTranslationBatchEnabled} from '@/src/core/config/nativeBatch';
import {method} from "@/src/core/config/constants";
import {getDeepLEndpoint} from '@/src/core/config/deepl';
import {config} from "@/src/services/config/store";
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError} from '@/src/platform/http/errors';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {
    getTranslationProviderConfig,
    type TranslationProviderRequest,
} from '@/src/services/translation/requestSnapshot';
import {readNativeBatchJson, translateNativeTextBatch} from './native-batch';

async function deepl(message: TranslationProviderRequest<string | string[]>) {
    const current = getTranslationProviderConfig(message, config);
    const service = message.serviceOverride || current.service;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    // DeepL 的目标语言区分书写系统，源语言参数仅接受基础 ZH。
    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    // 2026-09-08 官方语言表：Filipino 使用 TL；KN / SI 尚未提供文本翻译。
    // 不替换成其他语言，也不修改用户保存的选择；允许切换到其他服务重试。
    const normalizeDeepLLanguage = (code: string): string => {
        const normalized = normalizeChineseLanguageCode(code);
        if (normalized === 'kn' || normalized === 'si') {
            throw new Error(`DeepL 暂不支持此语言（${normalized}），请选择其他翻译服务`);
        }
        return normalized === 'fil' ? 'TL' : normalized.toUpperCase();
    };
    const targetLang = normalizeDeepLLanguage(targetLanguage);
    const normalizedSource = normalizeChineseLanguageCode(sourceLanguage);
    const sourceLang = normalizedSource.startsWith('zh-') ? 'ZH' : normalizeDeepLLanguage(normalizedSource);

    // 判断是否使用代理
    const url = getDeepLEndpoint(current.deeplApiPlan, current.proxy[service]);
    const authorization = 'DeepL-Auth-Key ' + current.token[service];
    const context = message.context;
    const enableNativeBatch = message.enableNativeBatch
        ?? isNativeTranslationBatchEnabled(service, current.nativeBatchTranslationEnabled);

    return translateNativeTextBatch(message.origin, async origins => {
        const resp = await runtimeFetch(url, {
            method: method.POST,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authorization
            },
            body: JSON.stringify({
                text: origins,
                target_lang: targetLang,
                ...(sourceLanguage === 'auto' ? {} : {source_lang: sourceLang}),
                context,
                preserve_formatting: true
            }),
            signal: message.abortSignal,
        });
        if (!resp.ok) throw createHttpStatusError(resp, '翻译失败');
        const result = await readNativeBatchJson<{translations?: Array<{text?: unknown}>} | null>(resp, 'DeepL 返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        return Array.isArray(result?.translations) ? result.translations.map(item => item?.text) : undefined;
    }, message.abortSignal, 'DeepL 返回数据格式异常：缺少译文', enableNativeBatch);
}

export default deepl;
