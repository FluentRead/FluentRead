/**
 * @file src/providers/translation/zhipu.ts
 *
 * 文件职责：适配智谱 BigModel 聊天接口，支持 apiKey.secret 生成 JWT、凭据校验和模型翻译请求。
 * 主要内容：维护短期 JWT 缓存，使用 commonMsgTemplate 生成消息，从配置快照选择模型和端点，通过 runtimeFetch 归一用量并校验 choices 后返回译文。 可核对的公开符号包括 default:zhipu。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {method, urls} from "@/src/core/config/constants";
import {resolveConfiguredModel, services} from "@/src/core/config/catalog";
import {commonMsgTemplate} from '@/src/services/translation/templates';
import hmacSha256 from 'crypto-js/hmac-sha256';
import base64 from 'crypto-js/enc-base64';
import {config} from "@/src/services/config/store";
import {isApiKeyRequired} from "@/src/core/config/validation";
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {
    getTranslationProviderConfig,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    type TranslationProviderRequest,
} from '@/src/services/translation/requestSnapshot';
import {normalizeOpenAICompatibleUsage} from './usage';


const JWT_CACHE_DURATION_MS = 3600000 * 24;
const jwtCache = new Map<string, {apiKey: string; secret: string; expiration: number}>();

// 文档参考：https://open.bigmodel.cn/dev/api#nosdk
async function zhipu(message: TranslationProviderRequest<string>) {
    const current = getTranslationProviderConfig(message, config);
    const service = message.serviceOverride || services.zhipu;
    const configuredModel = resolveConfiguredModel(
        message.modelOverride || current.model[service],
        current.customModel[service],
    );
    // 智谱根据 token 获取 secret（签名密钥） 和 expiration
    const token = current.token[service];
    const cached = jwtCache.get(service);
    let secret = cached?.apiKey === token && cached.expiration > Date.now()
        ? cached.secret
        : undefined;
    if (!token?.trim() && !isApiKeyRequired(service, current)) {
        secret = undefined;
        jwtCache.delete(service);
    } else if (!secret) {
        secret = generateToken(token);
        if (!secret) throw new Error('无法生成令牌');
        // JWT 是可复算的派生凭据，只在当前后台进程内缓存，不进入 Config/storage/history/export。
        jwtCache.set(service, {apiKey: token, secret, expiration: Date.now() + JWT_CACHE_DURATION_MS});
    }

    // 构建请求头
    let headers = new Headers();
    headers.append('Content-Type', 'application/json');
    if (secret) headers.append('Authorization', `Bearer ${secret}`);

    const body = commonMsgTemplate(message.origin, message.pageContext, message.summaryPrompt, message.summarySystemPrompt, service, message.targetLanguage, message.modelOverride, current, message.thinkingOverride);
    const startedAt = Date.now();
    let attemptReported = false;
    try {
        // 发起 fetch 请求
        const resp = await runtimeFetch(urls[services.zhipu], {
            method: method.POST,
            headers: headers,
            body,
            signal: message.abortSignal,
        });
        if (!resp.ok) {
            reportTranslationModelUsageFailure(message, undefined, startedAt, configuredModel, resp.status);
            attemptReported = true;
            throw createHttpStatusError(resp, '翻译失败');
        }
        const result = await readJsonResponse<any>(resp, '智谱返回的不是有效 JSON');
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const translatedText = result.choices[0].message.content;
        reportTranslationModelUsage(message, {
            ...normalizeOpenAICompatibleUsage(result?.usage, actualModel),
            startedAt,
            durationMs: Math.max(0, Date.now() - startedAt),
            outcome: 'success',
            statusCode: resp.status,
        });
        attemptReported = true;
        return translatedText;
    } catch (error) {
        if (!attemptReported) {
            reportTranslationModelUsageFailure(message, error, startedAt, configuredModel);
        }
        throw error;
    }
}

function generateToken(APIKey: string) {
    if (!APIKey || !APIKey.includes('.')) {
        return;
    }
    const duration = JWT_CACHE_DURATION_MS; // 生成的 token 默认24小时后过期
    const [key, secret] = APIKey.split('.');

    return generateJWT(secret, {alg: "HS256", sign_type: "SIGN", typ: "JWT"}, {
        api_key: key,
        exp: Math.floor(Date.now() / 1000) + (duration / 1000),
        timestamp: Math.floor(Date.now() / 1000)
    });
}

// 生成JWT（JSON Web Token）
function generateJWT(secret: string, header: any, payload: any) {
    // 对header和payload部分进行UTF-8编码，然后转换为Base64URL格式
    const encodedHeader = base64UrlSafe(btoa(JSON.stringify(header)));
    const encodedPayload = base64UrlSafe(btoa(JSON.stringify(payload)));
    // 生成 jwt 签名
    let hmacsha256 = base64UrlSafe(hmacSha256(encodedHeader + "." + encodedPayload, secret).toString(base64))
    return `${encodedHeader}.${encodedPayload}.${hmacsha256}`;
}

// 将Base64字符串转换为Base64URL格式的函数
function base64UrlSafe(base64String: string) {
    return base64String.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default zhipu;
