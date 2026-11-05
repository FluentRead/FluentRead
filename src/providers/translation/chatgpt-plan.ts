/**
 * @file src/providers/translation/chatgpt-plan.ts
 * 文件职责：通过本机 OAuth 助手把统一翻译请求转换为 ChatGPT 套餐的 Responses 文本或图片请求。
 * 主要内容：复用冻结配置与公共提示词模板，限制请求字段为 model/input/instructions，逐条执行等长数组，严格读取 SSE 完成响应、清理推理文本并上报无敏感信息用量，保留共享取消、截止时间和并发租约。
 * 模块边界：本文件只适配 provider 协议，不接触 OAuth/配对凭据、UI、存储或会话状态；本机 HTTP 边界由 platform bridge 提供，缓存、术语保护与路由由 translation broker 负责。
 */

import {services} from '@/src/core/config/catalog';
import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {stripTranslationReasoning} from '@/src/core/translation/prompts';
import {commonMsgTemplate} from '@/src/services/translation/templates';
import {
    requireTranslationProviderConfig,
    getTranslationImageInput,
    getTranslationRequestScheduler,
    reportTranslationModelUsage,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {createRuntimeAbortContext, abortErrorFromSignal} from '@/src/platform/http/runtime';
import {requestChatGPTPlanResponse} from '@/src/platform/chatgpt-plan/bridge';
import {readChatGPTPlanStream} from '@/src/platform/chatgpt-plan/events';
import {normalizeDeepSeekResponsesUsage} from './usage';
import {LlmTransportError} from './ai-sdk/errors';
import {readResponsesApiText} from './responses-api';

type ChatGPTPlanRequest = TranslationProviderRequest<string | string[]> & {
    summaryPrompt?: string;
    summarySystemPrompt?: string;
    thinkingOverride?: boolean;
};

/** 共用模板保留用户提示词与页面/术语上下文，但套餐协议不接受任意附加字段。 */
export function buildChatGPTPlanPayload(request: ChatGPTPlanRequest, origin: string, current: TranslationProviderConfigSnapshot): {
    model: string; input: unknown[]; instructions?: string;
} {
    const safeConfig = {...current, customBody: {...current.customBody, [services.chatgptPlan]: ''}};
    const payload = JSON.parse(commonMsgTemplate({
        origin,
        context: request.pageContext,
        subtitleContext: request.subtitleContext,
        prompt: request.summaryPrompt,
        systemPrompt: request.summarySystemPrompt,
        serviceOverride: services.chatgptPlan,
        targetLanguage: request.targetLanguage || current.to,
        modelOverride: request.modelOverride,
        current: safeConfig,
        thinkingOverride: request.thinkingOverride,
        imageInput: getTranslationImageInput(request),
    })) as {
            model: string; messages: [{role: 'system'; content: string}, {role: 'user'; content: string | Array<
                {type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}}> }];
        };
    const model = payload.model.trim();
    if (!model) throw new LlmTransportError('请先登录 ChatGPT 并从账户可用列表选择模型。', {kind: 'bad-request', retryable: false});
    const instructions = payload.messages[0].content;
    const userContent = payload.messages[1].content;
    const input = [{role: 'user', content: typeof userContent === 'string'
        ? [{type: 'input_text', text: userContent}]
        : userContent.map(part => part.type === 'image_url'
            ? {type: 'input_image', image_url: part.image_url.url}
            : {type: 'input_text', text: part.text}),
    }];
    return {model, input, instructions};
}

async function translateSingle(request: ChatGPTPlanRequest, origin: string, current: TranslationProviderConfigSnapshot,
    budgetMs: number, additionalAttempt = false): Promise<string> {
    const payload = buildChatGPTPlanPayload(request, origin, current);
    const abortContext = createRuntimeAbortContext(budgetMs, request.abortSignal);
    const startedAt = Date.now();
    let reported = false;
    const operation = async () => {
        const response = await requestChatGPTPlanResponse(payload, abortContext.signal);
        const completed = await readChatGPTPlanStream(response, abortContext.signal);
        if (abortContext.signal.aborted) throw abortErrorFromSignal(abortContext.signal);
        const text = stripTranslationReasoning(readResponsesApiText(completed));
        reportTranslationModelUsage(request, {...normalizeDeepSeekResponsesUsage(completed.usage, completed.model ?? payload.model),
            startedAt, durationMs: Math.max(0, Date.now() - startedAt), outcome: text ? 'success' : 'error', statusCode: response.status});
        reported = true;
        if (!text) throw new LlmTransportError('ChatGPT 已完成请求，但没有返回有效译文。', {kind: 'response', retryable: false});
        return text;
    };
    let translated: string;
    try {
        const schedulerContext = getTranslationRequestScheduler(request);
        const attempt = () => {
            const settlement = operation();
            schedulerContext?.lease?.holdUntil(settlement);
            return settlement;
        };
        // 非 AI SDK 服务的首条速率由 broker 外层计数；数组后续真实请求单独计数。
        translated = schedulerContext && additionalAttempt ? await schedulerContext.scheduler.scheduleAttempt(attempt, {
            signal: abortContext.signal, identity: {service: services.chatgptPlan, model: payload.model},
        }) : await attempt();
    } catch (error) {
        if (!reported) reportTranslationModelUsage(request, {startedAt, durationMs: Math.max(0, Date.now() - startedAt),
            actualModel: payload.model, outcome: abortContext.didTimeout() ? 'timeout' : request.abortSignal?.aborted ? 'cancelled' : 'error',
            usageAvailability: 'unreported', statusCode: (error as {statusCode?: number})?.statusCode});
        if (request.abortSignal?.aborted) throw abortErrorFromSignal(request.abortSignal);
        if (abortContext.didTimeout()) throw new LlmTransportError('ChatGPT 套餐请求超时，请稍后重试。', {kind: 'timeout', retryable: true});
        throw error;
    } finally {
        abortContext.cleanup();
    }
    return translated;
}

/** 数组逐条执行并共享剩余预算，完整成功才返回等长结果；外部槽协议仍保持为单条文本。 */
export default async function chatgptPlan(request: ChatGPTPlanRequest): Promise<string | string[]> {
    const current = createTranslationProviderConfigSnapshot(requireTranslationProviderConfig(request));
    const configured = normalizeAiRequestTimeoutMs(current.aiRequestTimeoutMs);
    const budget = typeof request.requestTimeoutMs === 'number' && Number.isFinite(request.requestTimeoutMs)
        ? Math.max(1, Math.floor(request.requestTimeoutMs)) : configured;
    if (!Array.isArray(request.origin)) return translateSingle(request, request.origin, current, budget);
    const deadline = Date.now() + budget;
    const translated: string[] = [];
    for (const origin of request.origin) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new LlmTransportError('ChatGPT 套餐请求超时，请稍后重试。', {kind: 'timeout', retryable: true});
        translated.push(await translateSingle(request, origin, current, remaining, translated.length > 0));
    }
    return translated;
}
