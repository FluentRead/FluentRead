/**
 * @file src/providers/translation/claude.ts
 *
 * 文件职责：适配 Anthropic Claude Messages API，将 FluentRead 翻译消息转换为 Claude 请求并解析文本响应。
 * 主要内容：从配置快照选择模型、代理和 x-api-key，使用 claudeMsgTemplate 构建 body，把调用方取消与显式剩余预算或 AI 配置默认截止合并后通过 runtimeFetch 发起请求，统一处理 HTTP/JSON 数据并旁路上报 Claude token 用量。 可核对的公开符号包括 default:claude。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {resolveConfiguredModel, services} from "@/src/core/config/catalog";
import {method, urls} from "@/src/core/config/constants";
import {claudeMsgTemplate} from '@/src/services/translation/templates';
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
import {normalizeClaudeUsage} from './usage';

async function claude(message: TranslationProviderRequest<string>) {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || services.claude;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const configuredModel = resolveConfiguredModel(
        message.modelOverride || current.model[service],
        current.customModel[service],
    );
    // 构建请求头
    let headers = new Headers();
    headers.append('Content-Type', 'application/json');
    appendOptionalHeader(headers, 'x-api-key', current.token[service]);
    headers.append('anthropic-version', '2023-06-01');
    headers.append('anthropic-dangerous-direct-browser-access', 'true');

    const url = current.proxy[service] || urls[services.claude];

    const body = claudeMsgTemplate({
        origin: message.origin,
        context: message.pageContext,
        prompt: message.summaryPrompt,
        systemPrompt: message.summarySystemPrompt,
        serviceOverride: service,
        targetLanguage: message.targetLanguage,
        modelOverride: message.modelOverride,
        current,
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
            reportTranslationModelUsageFailure(message, undefined, startedAt, configuredModel, resp.status);
            attemptReported = true;
            const error = getTranslationImageInput(message) ? await createImageInputHttpError(resp, '请求失败') : createHttpStatusError(resp, '请求失败');
            cancelUnreadResponseBody(resp);
            throw error;
        }

        const result = await readJsonResponse<any>(resp, 'Claude 返回的不是有效 JSON', abortContext.signal);
        if (abortContext.signal.aborted) throw abortErrorFromSignal(abortContext.signal);
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const translatedText = Array.isArray(result?.content)
            ? result.content
                .filter((item: unknown): item is {type?: string; text: string} => Boolean(
                    item && typeof item === 'object' && typeof (item as {text?: unknown}).text === 'string'
                        && (!(item as {type?: unknown}).type || (item as {type?: unknown}).type === 'text'),
                ))
                .map((item: {text: string}) => item.text)
                .join('')
            : '';
        if (!translatedText.trim()) throw new Error('Claude 返回数据格式异常：缺少文本内容');
        reportTranslationModelUsage(message, {
            ...normalizeClaudeUsage(result?.usage, actualModel),
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

export default claude;
