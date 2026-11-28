/**
 * @file src/providers/translation/baidu-translation.ts
 *
 * 文件职责：适配百度翻译开放平台通用文本翻译接口，使用 APP ID 与密钥按 MD5 签名调用官方接口。
 * 主要内容：从请求快照读取 token[baiduTranslation]（APP ID）与 secret[baiduTranslation]（密钥），计算 sign=md5(appid+q+salt+key)，以表单 POST 请求，并把多行 trans_result 按原顺序拼回一段译文，同时回显安全错误码。 可核对的公开符号包括 buildBaiduSignedForm、default:baiduTranslation。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {services} from '@/src/core/config/catalog';
import {method, urls} from '@/src/core/config/constants';
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {resolveCloudLanguages} from './cloud/languages';
import {md5Hex} from './cloud/signature';

const BAIDU_TRANSLATION_URL: string = urls[services.baiduTranslation];

type BaiduResponse = {
    error_code?: unknown;
    error_msg?: unknown;
    trans_result?: Array<{src?: string; dst?: string}>;
};

/** 百度签名参与字段固定为 appid + q + salt + 密钥，其中 q 使用原文而非编码后的值。 */
export function buildBaiduSignedForm(input: {
    appId: string;
    secretKey: string;
    query: string;
    from: string;
    to: string;
    salt?: string;
}): Record<string, string> {
    const salt = input.salt ?? String(Date.now());
    return {
        q: input.query,
        from: input.from,
        to: input.to,
        appid: input.appId,
        salt,
        sign: md5Hex(`${input.appId}${input.query}${salt}${input.secretKey}`),
    };
}

async function baiduTranslation(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const appId = current.token[services.baiduTranslation]?.trim();
    const secretKey = current.secret[services.baiduTranslation]?.trim();
    if (!appId || !secretKey) {
        throw new Error('百度翻译尚未配置 APP ID 与密钥，请先在设置中填写');
    }

    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const {source, target} = resolveCloudLanguages('baiduTranslation', sourceLanguage, targetLanguage);

    const form = buildBaiduSignedForm({
        appId,
        secretKey,
        query: message.origin,
        from: source,
        to: target,
    });

    const response = await runtimeFetch(BAIDU_TRANSLATION_URL, {
        method: method.POST,
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: new URLSearchParams(form).toString(),
        signal: message.abortSignal,
    });

    if (!response.ok) {
        cancelUnreadResponseBody(response);
        throw createHttpStatusError(response, '百度翻译请求失败');
    }

    const result = await readJsonResponse<BaiduResponse>(response, '百度翻译返回的不是有效 JSON');
    // 52000 表示成功；其余错误码按官方文档为纯数字，可安全回显。
    if (result?.error_code !== undefined && String(result.error_code) !== '52000') {
        throw createProviderCodeError('百度翻译错误', result.error_code);
    }
    const segments = result?.trans_result;
    if (Array.isArray(segments) && segments.length > 0 && segments.every((item) => typeof item?.dst === 'string')) {
        // 百度会按换行拆分原文并逐段返回，这里按原顺序拼回，保持段落结构。
        return segments.map((item) => item.dst as string).join('\n');
    }
    throw new Error('百度翻译返回格式异常');
}

export default baiduTranslation;
