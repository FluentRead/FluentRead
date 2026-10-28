/**
 * @file src/providers/translation/tongyi.ts
 *
 * 文件职责：适配阿里云通义千问 OpenAI 兼容接口，并根据模型选择常规或 token-plan 计费端点。
 * 主要内容：从配置快照解析服务、模型、proxy 和 token，使用 tongyiMsgTemplate 生成 payload，通过 runtimeFetch 请求，旁路上报 OpenAI-compatible 用量并读取 choices 译文。 可核对的公开符号包括 default:tongyi。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {currentModelIds, resolveConfiguredModel, services} from "@/src/core/config/catalog";
import {method, tongyiTokenPlanUrl, urls} from "@/src/core/config/constants";
import {tongyiMsgTemplate} from '@/src/services/translation/templates';
import {appendOptionalBearer} from './auth';
import {createHttpStatusError, createImageInputHttpError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {
    requireTranslationProviderConfig,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    getTranslationImageInput,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {normalizeOpenAICompatibleUsage} from './usage';

// 文档：https://help.aliyun.com/zh/dashscope/developer-reference/tongyi-thousand-questions-metering-and-billing
async function tongyi(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || services.tongyi;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    // 构建请求头
    let headers = new Headers();
    headers.append('Content-Type', 'application/json');
    appendOptionalBearer(headers, current.token[service]);

    // 判断是否使用代理
    const selectedModel = message.modelOverride || current.model[service];
    const configuredModel = resolveConfiguredModel(selectedModel, current.customModel[service]);
    const officialUrl = configuredModel === currentModelIds.tongyiTokenPlan
        ? tongyiTokenPlanUrl
        : urls[services.tongyi];
    const url: string = current.proxy[service] || officialUrl;

    const body = tongyiMsgTemplate({
        origin: message.origin,
        context: message.pageContext,
        prompt: message.summaryPrompt,
        systemPrompt: message.summarySystemPrompt,
        serviceOverride: service,
        targetLanguage: message.targetLanguage,
        modelOverride: message.modelOverride,
        current,
        thinkingOverride: message.thinkingOverride,
        sourceLanguage: message.sourceLanguage,
        imageInput: getTranslationImageInput(message),
    });
    const startedAt = Date.now();
    let attemptReported = false;
    try {
        const resp = await runtimeFetch(url, {
            method: method.POST,
            headers: headers,
            body,
            signal: message.abortSignal,
        });
        if (!resp.ok) {
            reportTranslationModelUsageFailure(message, undefined, startedAt, configuredModel, resp.status);
            attemptReported = true;
            const error = getTranslationImageInput(message) ? await createImageInputHttpError(resp, '翻译失败') : createHttpStatusError(resp, '翻译失败');
            cancelUnreadResponseBody(resp);
            throw error;
        }
        const result = await readJsonResponse<any>(resp, '通义千问返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const translatedText = result?.choices?.[0]?.message?.content;
        if (typeof translatedText !== 'string' || !translatedText.trim()) {
            throw new Error('通义千问返回数据格式异常：缺少文本内容');
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
        if (!attemptReported) {
            reportTranslationModelUsageFailure(message, error, startedAt, configuredModel);
        }
        throw error;
    }
}

export default tongyi;


//
