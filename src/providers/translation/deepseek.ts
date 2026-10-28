/**
 * @file src/providers/translation/deepseek.ts
 *
 * 文件职责：适配 DeepSeek 官方或代理端点，并根据配置选择 Chat Completions 或 Responses 协议进行翻译。
 * 主要内容：从快照解析 thinking/API 模式和 endpoint，将受信选区图片传给 Chat/Responses 多模态模板，执行 Bearer 请求、HTTP/JSON 校验、上报协议对应的 token 用量并清理模型推理标记；路由改写与 Responses 输出读取复用 responses-api 共享模块。 可核对的公开符号包括 buildDeepSeekEndpoint、default:deepseek。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import { method, urls } from "@/src/core/config/constants";
import {
    deepseekMsgTemplate,
    deepseekResponsesMsgTemplate,
    getCurrentModel,
} from '@/src/services/translation/templates';
import {stripTranslationReasoning as contentPostHandler} from '@/src/core/translation/prompts';
import { appendOptionalBearer } from './auth';
import {createHttpStatusError, createImageInputHttpError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {
    requireTranslationProviderConfig,
    getTranslationImageInput,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {normalizeDeepSeekResponsesUsage, normalizeOpenAICompatibleUsage} from './usage';
import {buildOpenAIApiEndpoint, readResponsesApiText} from './responses-api';

// 官方已支持 Chat Completion 和 Responses；保留用户所选协议，auto 继续使用 Chat。
function useResponsesApi(current: TranslationProviderConfigSnapshot) {
    const apiType = current.deepseekApiType;
    if (apiType === 'responses') return true;
    return false;
}

async function deepseek(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || current.service;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const headers = new Headers({'Content-Type': 'application/json'});
    appendOptionalBearer(headers, current.token[service]);

    const endpoint = current.proxy[service] || urls[service];
    const isResponses = useResponsesApi(current);
    const url = buildDeepSeekEndpoint(endpoint, isResponses);
    const configuredModel = getCurrentModel({serviceOverride: service, modelOverride: message.modelOverride, current});
    const imageInput = getTranslationImageInput(message);

    const body = isResponses
        ? deepseekResponsesMsgTemplate({
            origin: message.origin,
            context: message.pageContext,
            prompt: message.summaryPrompt,
            systemPrompt: message.summarySystemPrompt,
            serviceOverride: service,
            targetLanguage: message.targetLanguage,
            modelOverride: message.modelOverride,
            current,
            thinkingOverride: message.thinkingOverride,
            imageInput,
        })
        : deepseekMsgTemplate({
            origin: message.origin,
            context: message.pageContext,
            prompt: message.summaryPrompt,
            systemPrompt: message.summarySystemPrompt,
            serviceOverride: service,
            targetLanguage: message.targetLanguage,
            modelOverride: message.modelOverride,
            current,
            thinkingOverride: message.thinkingOverride,
            imageInput,
        });
    const startedAt = Date.now();
    let attemptReported = false;
    try {
        const resp = await runtimeFetch(url, {
            method: method.POST,
            headers,
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

        const result = await readJsonResponse<any>(resp, 'DeepSeek 返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const translatedText = isResponses
            ? extractResponsesContent(result)
            : extractChatContent(result);
        reportTranslationModelUsage(message, {
            ...(isResponses
                ? normalizeDeepSeekResponsesUsage(result?.usage, actualModel)
                : normalizeOpenAICompatibleUsage(result?.usage, actualModel)),
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

function extractChatContent(result: any): string {
    const content = result?.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
        throw new Error('DeepSeek 返回数据格式异常：缺少 choices[0].message.content');
    }

    // 页面只渲染最终的 message.content；reasoning_content 等 DeepSeek 思考字段会被
    // 主动忽略，绝不能进入页面。
    const text = contentPostHandler(content);
    if (!text) throw new Error('DeepSeek 返回数据格式异常：缺少有效文本内容');
    return text;
}

function extractResponsesContent(result: any): string {
    const text = readResponsesApiText(result);

    const translated = contentPostHandler(text);
    if (!translated) {
        throw new Error('DeepSeek 返回数据格式异常：缺少 Responses API 输出文本');
    }

    return translated;
}

export function buildDeepSeekEndpoint(endpoint: string, isResponses: boolean): string {
    return buildOpenAIApiEndpoint(endpoint, isResponses ? 'responses' : 'chat');
}

export default deepseek;
