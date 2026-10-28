/**
 * @file src/providers/translation/gemini.ts
 *
 * 文件职责：适配 Google Gemini generateContent 协议，支持官方 endpoint、代理、自定义模型与 API Key 头部差异。
 * 主要内容：从配置快照选取模型和 URL，使用 geminiMsgTemplate 构造 contents，把调用方取消与显式剩余预算或 AI 配置默认截止合并后通过 runtimeFetch 请求，校验并拼接 candidates 的最终文本、忽略思考块，再旁路归一 usageMetadata。 可核对的公开符号包括 default:gemini。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {method} from "@/src/core/config/constants";
import {geminiMsgTemplate} from '@/src/services/translation/templates';
import {customModelString} from "@/src/core/config/catalog";
import {appendOptionalHeader} from './auth';
import {createHttpStatusError, createImageInputHttpError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, cancelUnreadResponseBody, createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {
    requireTranslationProviderConfig,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    getTranslationImageInput,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {normalizeGeminiUsage} from './usage';


async function gemini(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || current.service;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);

    const model = message.modelOverride
        || (current.model[service] === customModelString ? current.customModel[service] : current.model[service]);
    const rawProxyUrl = current.proxy[service]?.trim() || "";
    const proxyUrl = rawProxyUrl
        .replace("{model}", encodeURIComponent(model))
        .replace("{key}", encodeURIComponent(current.token[service] || ""));

    const usesOfficialEndpoint = !rawProxyUrl;
    const url = proxyUrl
        || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const headers = new Headers({'Content-Type': 'application/json'});
    // 官方 Gemini REST 请求使用 x-goog-api-key；代理不自动追加该头部，
    // 需要 URL 凭据的代理由用户通过 {key} 占位符显式配置。
    if (usesOfficialEndpoint) {
        appendOptionalHeader(headers, 'x-goog-api-key', current.token[service]);
    }

    const body = geminiMsgTemplate({
        origin: message.origin,
        context: message.pageContext,
        prompt: message.summaryPrompt,
        systemPrompt: message.summarySystemPrompt,
        serviceOverride: service,
        targetLanguage: message.targetLanguage,
        current,
        modelOverride: message.modelOverride,
        thinkingOverride: message.thinkingOverride,
        imageInput: getTranslationImageInput(message),
    });
    // broker 数值是扣除排队/摘要后的预算；直接 provider 调用才使用冻结配置默认值。
    const timeoutMs = typeof message.requestTimeoutMs === 'number' && Number.isFinite(message.requestTimeoutMs)
        ? Math.max(1, Math.floor(message.requestTimeoutMs)) : normalizeAiRequestTimeoutMs(current.aiRequestTimeoutMs);
    const abortContext = createRuntimeAbortContext(timeoutMs, message.abortSignal);
    const startedAt = Date.now();
    let attemptReported = false;
    try {
        const resp = await runtimeFetch(url, {
            method: method.POST,
            headers,
            body,
            signal: abortContext.signal,
        });
        if (!resp.ok) {
            reportTranslationModelUsageFailure(message, undefined, startedAt, model, resp.status);
            attemptReported = true;
            const error = getTranslationImageInput(message) ? await createImageInputHttpError(resp, '翻译失败') : createHttpStatusError(resp, '翻译失败');
            cancelUnreadResponseBody(resp);
            throw error;
        }
        const result = await readJsonResponse<any>(resp, 'Gemini 返回的不是有效 JSON', abortContext.signal);
        if (abortContext.signal.aborted) throw abortErrorFromSignal(abortContext.signal);
        const actualModel = typeof result?.modelVersion === 'string' && result.modelVersion.trim()
            ? result.modelVersion
            : model;
        const parts = result?.candidates?.[0]?.content?.parts;
        const translatedText = Array.isArray(parts)
            ? parts.filter((part: unknown): part is {text: string} => Boolean(
                part && typeof part === 'object' && typeof (part as {text?: unknown}).text === 'string'
                    && (part as {thought?: unknown}).thought !== true,
            )).map((part: {text: string}) => part.text).join('')
            : '';
        if (!translatedText.trim()) throw new Error('Gemini 返回数据格式异常：缺少文本内容');
        reportTranslationModelUsage(message, {
            ...normalizeGeminiUsage(result?.usageMetadata, actualModel),
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
        if (!attemptReported) reportTranslationModelUsageFailure(message, failure, startedAt, model);
        throw failure;
    } finally {
        abortContext.cleanup();
    }
}

export default gemini;
