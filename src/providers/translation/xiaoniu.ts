/**
 * @file src/providers/translation/xiaoniu.ts
 *
 * 文件职责：适配小牛翻译 REST API，处理目标语言映射、代理选择和 token 参数。
 * 主要内容：从请求级配置获得 service 与语言，将简体中文代码转换为接口格式，构造表单请求，通过 runtimeFetch 校验状态并提取目标文本。 可核对的公开符号包括 default:xiaoniu。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {method, urls} from "@/src/core/config/constants";
import {services} from "@/src/core/config/catalog";
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/types';

async function xiaoniu(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || current.service;
    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const niutransLanguage = (code: string): string => {
        const normalized = normalizeChineseLanguageCode(code);
        const codes: Record<string, string> = {'zh-Hans': 'zh', 'zh-Hant': 'cht', nb: 'no'};
        return Object.hasOwn(codes, normalized) ? codes[normalized] : normalized;
    };
    const sourceLang = niutransLanguage(sourceLanguage);
    const targetLang = niutransLanguage(targetLanguage);

    // 判断是否使用代理
    let url: string = current.proxy[service] ? current.proxy[service] : urls[services.xiaoniu]

    const resp = await runtimeFetch(url, {
        method: method.POST,
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
            from: sourceLang, to: targetLang, apikey: current.token[service], src_text: message.origin,
        }).toString(),
        signal: message.abortSignal,
    });

    if (resp.ok) {
        const result = await readJsonResponse<any>(resp, '小牛翻译返回的不是有效 JSON');
        if (typeof result?.tgt_text !== 'string' || !result.tgt_text.trim()) {
            throw createProviderCodeError('小牛翻译未返回译文，请检查语言对、额度或 API Key', result?.error_code);
        }
        return result.tgt_text
    } else {
        cancelUnreadResponseBody(resp);
        throw createHttpStatusError(resp, '翻译失败');
    }
}

export default xiaoniu;
