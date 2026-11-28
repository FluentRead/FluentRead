/**
 * @file src/providers/translation/tencent.ts
 *
 * 文件职责：适配腾讯云机器翻译 API，负责语言代码、TC3-HMAC-SHA256 签名、请求头和结果解析。
 * 主要内容：从请求快照读取 SecretId/SecretKey 与语言，构造规范请求和授权签名，通过 runtimeFetch 调用 TMT endpoint，并校验 Response.Error 与 TargetText。 可核对的公开符号包括 default:tencent。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import { method } from "@/src/core/config/constants";
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {hmacSha256, sha256Hex, toHex} from './cloud/signature';

// 腾讯云机器翻译语言代码映射
const languageMap: Record<string, string> = {
    'zh-Hans': 'zh',
    'zh-Hant': 'zh-TW',
    'en': 'en',
    'ja': 'ja',
    'ko': 'ko',
    'fr': 'fr',
    'ru': 'ru',
    'de': 'de',
    'es': 'es',
    'it': 'it',
    'tr': 'tr',
    'th': 'th',
    'ar': 'ar',
    'pt': 'pt',
    'auto': 'auto'
};

// 生成腾讯云API签名
async function createTencentSignature(requestPayload: string, timestamp: number, secretId: string, secretKey: string): Promise<string> {
    const date = new Date(timestamp * 1000).toISOString().substring(0, 10);
    
    // 步骤1：拼接规范请求串
    const httpRequestMethod = "POST";
    const canonicalUri = "/";
    const canonicalQueryString = "";
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\n`;
    const signedHeaders = "content-type;host";
    const hashedPayloadHex = await sha256Hex(requestPayload);
    const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayloadHex}`;
    
    // 步骤2：拼接待签名字符串
    const algorithm = "TC3-HMAC-SHA256";
    const credentialScope = `${date}/tmt/tc3_request`;
    const hashedCanonicalRequestHex = await sha256Hex(canonicalRequest);
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequestHex}`;
    
    // 步骤3：计算签名
    const kDate = await hmacSha256(`TC3${secretKey}`, date);
    const kService = await hmacSha256(kDate, "tmt");
    const kSigning = await hmacSha256(kService, "tc3_request");
    const signature = toHex(await hmacSha256(kSigning, stringToSign));
    
    // 步骤4：拼接 Authorization
    return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function tencent(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    // 从配置中获取 SecretId 和 SecretKey
    const secretId = current.tencentSecretId?.trim();
    const secretKey = current.tencentSecretKey?.trim();

    if (!secretId || !secretKey) {
        throw new Error('腾讯云机器翻译密钥未配置，请在设置中配置SecretId和SecretKey');
    }

    // 基本格式验证
    if (secretId.length < 10 || secretKey.length < 10) {
        throw new Error('SecretId或SecretKey格式不正确，请检查是否完整复制了密钥信息');
    }

    // 转换语言代码
    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const normalizedSource = normalizeChineseLanguageCode(sourceLanguage);
    const normalizedTarget = normalizeChineseLanguageCode(targetLanguage);
    const sourceLang = (Object.hasOwn(languageMap, normalizedSource) ? languageMap[normalizedSource] : sourceLanguage);
    const targetLang = (Object.hasOwn(languageMap, normalizedTarget) ? languageMap[normalizedTarget] : targetLanguage);

    if (!targetLang || targetLang === 'auto') {
        throw new Error('腾讯云机器翻译不支持目标语言自动检测');
    }

    // 构建 JSON 请求体
    const requestBody = JSON.stringify({
        SourceText: message.origin,
        Source: sourceLang,
        Target: targetLang,
        ProjectId: 0,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = await createTencentSignature(requestBody, timestamp, secretId, secretKey);
    const service = message.serviceOverride || current.service;
    const url = current.proxy[service] || 'https://tmt.tencentcloudapi.com/';

    const response = await runtimeFetch(url, {
        method: method.POST,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Host': 'tmt.tencentcloudapi.com',
            'Authorization': authorization,
            'X-TC-Action': 'TextTranslate',
            'X-TC-Version': '2018-03-21',
            'X-TC-Region': 'ap-beijing',
            'X-TC-Timestamp': timestamp.toString(),
        },
        body: requestBody,
        signal: message.abortSignal,
    });

    if (!response.ok) {
        cancelUnreadResponseBody(response);
        throw createHttpStatusError(response, '腾讯云机器翻译请求失败');
    }

    const result = await readJsonResponse<any>(response, '腾讯云机器翻译返回的不是有效 JSON');
    if (result?.Response?.Error) {
        throw createProviderCodeError('腾讯云机器翻译错误', result.Response.Error.Code);
    }
    if (typeof result?.Response?.TargetText === 'string' && result.Response.TargetText) {
        return result.Response.TargetText;
    }
    throw new Error('腾讯云机器翻译返回格式异常');
}

export default tencent;
