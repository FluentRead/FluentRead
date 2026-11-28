/**
 * @file src/providers/translation/aliyun-translation.ts
 *
 * 文件职责：适配阿里云机器翻译通用版 TranslateGeneral（2018-10-12），使用 AccessKey 与 RPC 1.0 HMAC-SHA1 签名调用官方接口。
 * 主要内容：从请求快照读取 token[aliyunTranslation]（AccessKey ID）、secret[aliyunTranslation]（AccessKey Secret）与所选地域，按 RFC 3986 规范化公共参数并计算 Signature，以表单 POST 调用地域域名，解析 Data.Translated，并将 HTTP 与业务错误转换为白名单内的错误码和操作提示。 可核对的公开符号包括 buildAliyunSignedForm、default:aliyunTranslation。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {resolveCloudRegion, services} from '@/src/core/config/catalog';
import {getAliyunTranslationEndpoint, method} from '@/src/core/config/constants';
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {runtimeFetch} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {resolveCloudLanguages} from './cloud/languages';
import {canonicalQueryString, hmacSha1, percentEncode, toBase64} from './cloud/signature';

type AliyunResponse = {
    Code?: unknown;
    Data?: {Translated?: string};
};

// 只回显已知错误码和本地提示；Message、Recommend 等字段可能带回原文、密钥或签名。
const aliyunErrorHints: Readonly<Record<string, string>> = {
    'InvalidAccessKeyId.NotFound': '未找到 AccessKey ID，请检查是否完整填写且仍处于启用状态',
    'InvalidAccessKeyId.Inactive': 'AccessKey 已停用，请在阿里云控制台检查密钥状态',
    SignatureDoesNotMatch: '签名校验失败，请确认 AccessKey ID 与 AccessKey Secret 来自同一组密钥并完整填写',
    SignatureNonceUsed: '请求标识已被使用，请重新点击检查连接',
    'InvalidTimeStamp.Expired': '请求时间已过期，请校准设备日期与时间后重试',
    'InvalidTimeStamp.Format': '请求时间格式无效，请更新插件后重试',
    MissingParameter: '请求缺少必要参数，请更新插件后重试',
    InvalidParameter: '请求参数无效，请检查语言设置并更新插件后重试',
    'InvalidParameter.Format': '请求参数格式无效，请检查语言设置并更新插件后重试',
    Forbidden: '当前账号无权调用机器翻译，请检查服务开通状态和 RAM 授权',
    'Forbidden.RAM': 'RAM 用户缺少机器翻译权限，请授权 alimt:TranslateGeneral 后重试',
    'NoPermission': '当前账号无权调用机器翻译，请检查 RAM 授权',
    'Throttling': '请求过于频繁，请稍后重试',
    'Throttling.User': '请求过于频繁，请稍后重试',
    'ServiceUnavailable': '阿里云服务暂时不可用，请稍后重试',
    '10001': '请求超时，请稍后重试',
    '10002': '阿里云服务发生错误，请稍后重试',
    '10003': '原文解码失败，请更新插件后重试',
    '10004': '请求缺少必要参数，请更新插件后重试',
    '10005': '暂不支持所选语言组合，请更换源语言或目标语言',
    '10006': '无法识别原文语言，请指定源语言后重试',
    '10007': '翻译失败，请稍后重试',
    '10008': '原文超过单次 5000 字符限制，请缩短文本后重试',
    '10009': 'RAM 用户缺少机器翻译权限，请授权 alimt:TranslateGeneral 后重试',
    '10010': '账号尚未开通机器翻译服务，请在阿里云控制台开通',
    '10011': 'RAM 用户调用服务失败，请检查授权和服务开通状态',
    '10012': '翻译服务调用失败，请稍后重试',
    '10013': '机器翻译服务未开通或账号欠费，请检查控制台的服务和账单状态',
};

function createAliyunError(code: unknown, response?: Response): Error {
    const error = response
        ? createHttpStatusError(response, '阿里云机器翻译请求失败')
        : createProviderCodeError('阿里云机器翻译错误', code);
    const knownCode = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
    if (Object.hasOwn(aliyunErrorHints, knownCode)) {
        // 保留 HTTP statusCode 和 Retry-After，避免影响上层重试策略。
        const label = response ? error.message : '阿里云机器翻译错误';
        error.message = `${label}（错误码 ${knownCode}）：${aliyunErrorHints[knownCode]}`;
    }
    return error;
}

export interface AliyunSignatureInput {
    accessKeyId: string;
    accessKeySecret: string;
    parameters: Record<string, string>;
    /** 便于测试注入固定时间与随机数。 */
    now?: Date;
    nonce?: string;
}

/** 生成带 Signature 的完整表单参数；签名串遵循 POP RPC 1.0：METHOD&%2F&encode(query)。 */
export async function buildAliyunSignedForm(input: AliyunSignatureInput): Promise<Record<string, string>> {
    const now = input.now ?? new Date();
    const parameters: Record<string, string> = {
        ...input.parameters,
        Format: 'JSON',
        Version: '2018-10-12',
        AccessKeyId: input.accessKeyId,
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        SignatureNonce: input.nonce ?? crypto.randomUUID(),
        Timestamp: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    };
    const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonicalQueryString(parameters))}`;
    const signature = toBase64(await hmacSha1(`${input.accessKeySecret}&`, stringToSign));
    return {...parameters, Signature: signature};
}

async function aliyunTranslation(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const accessKeyId = current.token[services.aliyunTranslation]?.trim();
    const accessKeySecret = current.secret[services.aliyunTranslation]?.trim();
    if (!accessKeyId || !accessKeySecret) {
        throw new Error('阿里云机器翻译尚未配置 AccessKey ID 与 AccessKey Secret，请先在设置中填写');
    }
    const region = resolveCloudRegion(services.aliyunTranslation, current.serviceRegion?.[services.aliyunTranslation]);

    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const {source, target} = resolveCloudLanguages('aliyunTranslation', sourceLanguage, targetLanguage);

    const form = await buildAliyunSignedForm({
        accessKeyId,
        accessKeySecret,
        parameters: {
            Action: 'TranslateGeneral',
            FormatType: 'text',
            Scene: 'general',
            SourceLanguage: source,
            TargetLanguage: target,
            SourceText: message.origin,
        },
    });

    const response = await runtimeFetch(getAliyunTranslationEndpoint(region), {
        method: method.POST,
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: new URLSearchParams(form).toString(),
        signal: message.abortSignal,
    });

    if (!response.ok) {
        const failure = await response.json().catch(() => undefined) as AliyunResponse | null | undefined;
        throw createAliyunError(failure?.Code, response);
    }

    const result = await readJsonResponse<AliyunResponse | null>(response, '阿里云机器翻译返回的不是有效 JSON');
    if (String(result?.Code ?? '') !== '200') {
        throw createAliyunError(result?.Code);
    }
    const translated = result?.Data?.Translated;
    if (typeof translated === 'string') return translated;
    throw new Error('阿里云机器翻译返回格式异常');
}

export default aliyunTranslation;
