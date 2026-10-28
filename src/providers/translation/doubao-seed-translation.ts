/**
 * @file src/providers/translation/doubao-seed-translation.ts
 *
 * 文件职责：适配火山方舟 Doubao-Seed-Translation 翻译专用模型，把统一翻译请求转换为 Responses API 的 translation_options 协议。
 * 主要内容：buildDoubaoSeedTranslationRequestBody 生成 input/translation_options 载荷，provider 解析端点与语言对、逐条执行批量原文、校验 HTTP 与 JSON、读取 Responses 输出文本并上报 token 用量。 可核对的公开符号包括 buildDoubaoSeedTranslationRequestBody、resolveDoubaoSeedTranslationEndpoint、default:doubaoSeedTranslation。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {method, urls} from '@/src/core/config/constants';
import {mergeCustomBody} from '@/src/core/config/customBody';
import {services} from '@/src/core/config/catalog';
import {resolveDoubaoSeedTranslationLanguage} from '@/src/core/config/doubaoSeedTranslation';
import {currentConfiguredModel} from '@/src/services/translation/templates';
import {getTranslationProviderLanguages} from '@/src/services/translation/requestSnapshot';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {appendOptionalBearer} from './auth';
import {buildOpenAIApiEndpoint, readResponsesApiText} from './responses-api';
import {requireTranslationProviderConfig, reportTranslationModelUsage, reportTranslationModelUsageFailure} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import type {TranslationProviderConfigSnapshot} from '@/src/services/translation/types';
import {normalizeDeepSeekResponsesUsage as normalizeResponsesApiUsage} from './usage';

/**
 * 翻译模型不接受 system/user 提示词，译文风格由 translation_options 决定；
 * source_language 省略即由模型自动识别源语言。
 */
export function buildDoubaoSeedTranslationRequestBody(
    text: string,
    targetLanguage: string,
    sourceLanguage: string | undefined,
    model: string,
    customBody?: unknown,
) {
    return mergeCustomBody({
        model,
        input: [{
            role: 'user',
            content: [{
                type: 'input_text',
                text,
                translation_options: {
                    ...(sourceLanguage ? {source_language: sourceLanguage} : {}),
                    target_language: targetLanguage,
                },
            }],
        }],
    }, customBody);
}

/** 方舟只在 /responses 上提供翻译模型；用户填写的 chat/completions 代理地址会被改写。 */
export function resolveDoubaoSeedTranslationEndpoint(
    current: TranslationProviderConfigSnapshot,
    service: string,
): string {
    const endpoint = current.proxy[service]?.trim() || urls[service];
    if (!endpoint) throw new Error('未找到翻译服务接口: 字节豆包');
    return buildOpenAIApiEndpoint(endpoint, 'responses');
}

async function translateSingle(
    message: TranslationProviderRequest<string | string[]>,
    current: TranslationProviderConfigSnapshot,
    service: string,
    origin: string,
    url: string,
    configuredModel: string,
    targetLanguage: string,
    sourceLanguage: string | undefined,
): Promise<string> {
    const headers = new Headers({'Content-Type': 'application/json'});
    appendOptionalBearer(headers, current.token[service]);

    const startedAt = Date.now();
    let attemptReported = false;
    try {
        const response = await runtimeFetch(url, {
            method: method.POST,
            headers,
            body: JSON.stringify(buildDoubaoSeedTranslationRequestBody(
                origin,
                targetLanguage,
                sourceLanguage,
                configuredModel,
                current.customBody?.[service],
            )),
            signal: message.abortSignal,
        });

        if (!response.ok) {
            reportTranslationModelUsageFailure(message, undefined, startedAt, configuredModel, response.status);
            attemptReported = true;
            cancelUnreadResponseBody(response);
            throw createHttpStatusError(response, '火山方舟翻译请求失败');
        }

        const result = await readJsonResponse<any>(response, '火山方舟返回的不是有效 JSON', message.abortSignal);
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        const actualModel = typeof result?.model === 'string' && result.model.trim()
            ? result.model
            : configuredModel;
        const text = readResponsesApiText(result);
        reportTranslationModelUsage(message, {
            ...normalizeResponsesApiUsage(result?.usage, actualModel),
            startedAt,
            durationMs: Math.max(0, Date.now() - startedAt),
            outcome: text.trim() ? 'success' : 'error',
            statusCode: response.status,
        });
        attemptReported = true;
        if (!text.trim()) throw new Error('火山方舟返回数据格式异常：缺少 Responses API 输出文本');
        return text;
    } catch (error) {
        if (!attemptReported) {
            reportTranslationModelUsageFailure(message, error, startedAt, configuredModel);
        }
        throw error;
    }
}

async function doubaoSeedTranslation(
    message: TranslationProviderRequest<string | string[]>,
): Promise<string | string[]> {
    const current = requireTranslationProviderConfig(message);
    const service = message.serviceOverride || services.doubao;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    const configuredModel = currentConfiguredModel(current, service, message.modelOverride);
    if (!configuredModel) throw new Error('模型尚未配置，请前往设置页面进行检查。');

    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(message);
    const target = resolveDoubaoSeedTranslationLanguage(targetLanguage);
    if (!target) throw new Error('Doubao-Seed-Translation 不支持该目标语言，请更换目标语言或翻译模型');
    // 源语言留空即交给模型自动识别；未收录的源语言同样走自动识别，不阻断翻译。
    const source = resolveDoubaoSeedTranslationLanguage(sourceLanguage);
    if (source && source === target) return message.origin;

    const url = resolveDoubaoSeedTranslationEndpoint(current, service);
    const translateOne = (origin: string) => translateSingle(
        message, current, service, origin, url, configuredModel, target, source,
    );

    // 翻译模型每次只接受一段原文；图片等批量入口的多段原文按顺序串行，保持等长数组契约。
    if (!Array.isArray(message.origin)) return translateOne(message.origin);
    const translations: string[] = [];
    for (const origin of message.origin) translations.push(await translateOne(origin));
    return translations;
}

export default doubaoSeedTranslation;
