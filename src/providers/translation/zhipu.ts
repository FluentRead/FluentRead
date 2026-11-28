/**
 * @file src/providers/translation/zhipu.ts
 * 字幕参考：将后台规范化的相邻 cue 标记交给共用提示模板，供应商协议与返回结构保持原契约。
 *
 * 文件职责：适配智谱 BigModel 聊天接口，支持代理地址、多 Key 独立短期 JWT 缓存、轻量 JSON 批次截断识别与推理标签清理。
 * 主要内容：按服务与 Key 隔离缓存派生 JWT，使用 commonMsgTemplate 生成消息，从配置快照选择模型、代理与超时预算，通过 runtimeFetch 归一用量、拒绝截断批次并清洗推理内容后返回译文。 可核对的公开符号包括 default:zhipu。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {method, urls} from "@/src/core/config/constants";
import {resolveConfiguredModel, services} from "@/src/core/config/catalog";
import {commonMsgTemplate} from '@/src/services/translation/templates';
import {stripTranslationReasoning as contentPostHandler} from '@/src/core/translation/prompts';
import {hmacSha256Base64Url} from '@/src/shared/crypto/lightCrypto';
import {isApiKeyRequired} from "@/src/core/config/validation";
import {createHttpStatusError, createImageInputHttpError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, cancelUnreadResponseBody, createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {
    requireTranslationProviderConfig,
    observeTranslationHttpResponse,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    getTranslationImageInput,
} from '@/src/services/translation/requestSnapshot';
import {TRANSLATION_COMPACT_BATCH, type TranslationProviderRequest} from '@/src/services/translation/types';
import {normalizeOpenAICompatibleUsage} from './usage';


const JWT_CACHE_DURATION_MS = 3600000 * 24;
const JWT_CACHE_MAX_ENTRIES = 64;
const jwtCache = new Map<string, {secret: string; expiration: number}>();

// 文档参考：https://open.bigmodel.cn/dev/api#nosdk
async function zhipu(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || services.zhipu;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const configuredModel = resolveConfiguredModel(
        message.modelOverride || current.model[service],
        current.customModel[service],
    );
    // 智谱按 service + apiKey 缓存派生 JWT，避免多 Key 轮询时反复重签。
    const token = current.token[service];
    const cacheKey = `${service}\u0000${token ?? ''}`;
    const cached = jwtCache.get(cacheKey);
    let secret = cached && cached.expiration > Date.now()
        ? cached.secret
        : undefined;
    if (!token?.trim() && !isApiKeyRequired(service, current)) {
        secret = undefined;
    } else if (!secret) {
        secret = generateToken(token);
        if (!secret) throw new Error('无法生成令牌');
        // JWT 是可复算的派生凭据，只在当前后台进程内缓存，不进入 Config/storage/history/export。
        jwtCache.delete(cacheKey);
        jwtCache.set(cacheKey, {secret, expiration: Date.now() + JWT_CACHE_DURATION_MS});
        if (jwtCache.size > JWT_CACHE_MAX_ENTRIES) {
            jwtCache.delete(jwtCache.keys().next().value!);
        }
    }

    // 构建请求头
    const headers = new Headers();
    headers.append('Content-Type', 'application/json');
    if (secret) headers.append('Authorization', `Bearer ${secret}`);

    const url = current.proxy?.[service]?.trim() || urls[services.zhipu];
    const body = commonMsgTemplate({
        origin: message.origin,
        context: message.pageContext,
        subtitleContext: message.subtitleContext,
        prompt: message.summaryPrompt,
        systemPrompt: message.summarySystemPrompt,
        serviceOverride: service,
        targetLanguage: message.targetLanguage,
        modelOverride: message.modelOverride,
        current,
        thinkingOverride: message.thinkingOverride,
        imageInput: getTranslationImageInput(message),
    });
    const timeoutMs = typeof message.requestTimeoutMs === 'number' && Number.isFinite(message.requestTimeoutMs)
        ? Math.max(1, Math.floor(message.requestTimeoutMs)) : normalizeAiRequestTimeoutMs(current.aiRequestTimeoutMs);
    const abortContext = createRuntimeAbortContext(timeoutMs, message.abortSignal);
    const startedAt = Date.now();
    let attemptReported = false;
    try {
        // 发起 fetch 请求
        const resp = await runtimeFetch(url, {
            method: method.POST,
            headers: headers,
            body,
            signal: abortContext.signal,
        });
        observeTranslationHttpResponse(message, resp);
        if (!resp.ok) {
            reportTranslationModelUsageFailure(message, undefined, startedAt, configuredModel, resp.status);
            attemptReported = true;
            const error = getTranslationImageInput(message) ? await createImageInputHttpError(resp, '翻译失败') : createHttpStatusError(resp, '翻译失败');
            cancelUnreadResponseBody(resp);
            throw error;
        }
        const result = await readJsonResponse<any>(resp, '智谱返回的不是有效 JSON', abortContext.signal);
        if (abortContext.signal.aborted) throw abortErrorFromSignal(abortContext.signal);
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const choice = result?.choices?.[0];
        const compactBatch = current[TRANSLATION_COMPACT_BATCH] === true;
        if (compactBatch && choice?.finish_reason === 'length') {
            const error = Object.assign(new Error('批量翻译返回格式异常'), {
                kind: 'response', retryable: false, code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID', statusCode: resp.status,
            });
            attemptReported = true;
            reportTranslationModelUsage(message, {
                ...normalizeOpenAICompatibleUsage(result?.usage, actualModel),
                startedAt,
                durationMs: Math.max(0, Date.now() - startedAt),
                outcome: 'error',
                statusCode: resp.status,
            });
            throw error;
        }
        const rawText = choice?.message?.content;
        const translatedText = typeof rawText === 'string'
            ? (!compactBatch && /<think>/i.test(rawText) ? contentPostHandler(rawText) : rawText)
            : '';
        if (!translatedText.trim()) {
            throw new Error('智谱返回数据格式异常：缺少文本内容');
        }
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
        const failure = abortContext.didTimeout()
            ? Object.assign(new Error('当前翻译服务请求超时，请稍后重试。'), {name: 'TimeoutError', kind: 'timeout', retryable: true})
            : error;
        if (!attemptReported) {
            reportTranslationModelUsageFailure(message, failure, startedAt, configuredModel);
        }
        throw failure;
    } finally {
        abortContext.cleanup();
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
    const hmacsha256 = hmacSha256Base64Url(`${encodedHeader}.${encodedPayload}`, secret);
    return `${encodedHeader}.${encodedPayload}.${hmacsha256}`;
}

// 将Base64字符串转换为Base64URL格式的函数
function base64UrlSafe(base64String: string) {
    return base64String.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default zhipu;
