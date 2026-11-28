/**
 * @file src/providers/translation/volc-translation.ts
 *
 * 文件职责：适配火山引擎机器翻译 TranslateText（2020-06-01），使用 Access Key 与 HMAC-SHA256 V4 签名调用官方接口。
 * 主要内容：从请求快照读取 token[volcTranslation]（Access Key ID）、secret[volcTranslation]（Secret Access Key）与所选地域，构造规范请求、凭证范围与派生签名密钥生成 Authorization，解析 TranslationList[0].Translation 并回显安全错误码。 可核对的公开符号包括 buildVolcAuthorization、default:volcTranslation。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {resolveCloudRegion, services} from '@/src/core/config/catalog';
import {method, VOLC_TRANSLATION_ENDPOINT} from '@/src/core/config/constants';
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {resolveCloudLanguages} from './cloud/languages';
import {canonicalQueryString, hmacSha256, sha256Hex, toHex} from './cloud/signature';

const VOLC_SERVICE = 'translate';
const VOLC_QUERY = {Action: 'TranslateText', Version: '2020-06-01'} as const;

type VolcResponse = {
    ResponseMetadata?: {Error?: {Code?: unknown; CodeN?: unknown; Message?: unknown}};
    TranslationList?: Array<{Translation?: string}>;
};

export interface VolcSignatureInput {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    host: string;
    query: Record<string, string>;
    body: string;
    /** 便于测试注入固定时间。 */
    now?: Date;
}

/** 生成 X-Date、X-Content-Sha256 与 Authorization 三个签名请求头。 */
export async function buildVolcAuthorization(input: VolcSignatureInput): Promise<Record<string, string>> {
    const now = input.now ?? new Date();
    const xDate = now.toISOString().replace(/[-:]|\.\d{3}/gu, '');
    const shortDate = xDate.slice(0, 8);
    const payloadHash = await sha256Hex(input.body);
    const contentType = 'application/json; charset=utf-8';

    const signedHeaders = 'content-type;host;x-content-sha256;x-date';
    const canonicalHeaders = [
        `content-type:${contentType}`,
        `host:${input.host}`,
        `x-content-sha256:${payloadHash}`,
        `x-date:${xDate}`,
    ].join('\n');
    const canonicalRequest = [
        'POST',
        '/',
        canonicalQueryString(input.query),
        `${canonicalHeaders}\n`,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${shortDate}/${input.region}/${VOLC_SERVICE}/request`;
    const stringToSign = ['HMAC-SHA256', xDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

    const kDate = await hmacSha256(input.secretAccessKey, shortDate);
    const kRegion = await hmacSha256(kDate, input.region);
    const kService = await hmacSha256(kRegion, VOLC_SERVICE);
    const kSigning = await hmacSha256(kService, 'request');
    const signature = toHex(await hmacSha256(kSigning, stringToSign));

    return {
        'Content-Type': contentType,
        'X-Date': xDate,
        'X-Content-Sha256': payloadHash,
        'Authorization': `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}

async function volcTranslation(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const accessKeyId = current.token[services.volcTranslation]?.trim();
    const secretAccessKey = current.secret[services.volcTranslation]?.trim();
    if (!accessKeyId || !secretAccessKey) {
        throw new Error('火山引擎翻译尚未配置 Access Key ID 与 Secret Access Key，请先在设置中填写');
    }
    const region = resolveCloudRegion(services.volcTranslation, current.serviceRegion?.[services.volcTranslation]);

    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const {source, target} = resolveCloudLanguages('volcTranslation', sourceLanguage, targetLanguage);

    const body = JSON.stringify({
        TargetLanguage: target,
        TextList: [message.origin],
        ...(source ? {SourceLanguage: source} : {}),
    });
    const url = new URL(VOLC_TRANSLATION_ENDPOINT);
    for (const [key, value] of Object.entries(VOLC_QUERY)) url.searchParams.set(key, value);

    const headers = await buildVolcAuthorization({
        accessKeyId,
        secretAccessKey,
        region,
        host: url.host,
        query: {...VOLC_QUERY},
        body,
    });

    const response = await runtimeFetch(url.toString(), {
        method: method.POST,
        headers,
        body,
        signal: message.abortSignal,
    });

    if (!response.ok) {
        cancelUnreadResponseBody(response);
        throw createHttpStatusError(response, '火山引擎翻译请求失败');
    }

    const result = await readJsonResponse<VolcResponse>(response, '火山引擎翻译返回的不是有效 JSON');
    const error = result?.ResponseMetadata?.Error;
    if (error) {
        throw createProviderCodeError('火山引擎翻译错误', error.CodeN);
    }
    const translated = result?.TranslationList?.[0]?.Translation;
    if (typeof translated === 'string') return translated;
    throw new Error('火山引擎翻译返回格式异常');
}

export default volcTranslation;
