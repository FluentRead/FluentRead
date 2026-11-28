/**
 * @file src/providers/translation/deeplx.ts
 *
 * 文件职责：默认通过浏览器可用的 DeepLX core 直连 DeepL，失败后回退公共端点；自定义端点保留有序故障转移。
 * 主要内容：规范化语言、按 UTF-16 预算切分长文本并保护术语和空白；所有线路共享总预算、单次预算及取消信号，自建地址、代理与令牌配置保持原有边界。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {services} from "@/src/core/config/catalog";
import {DEFAULT_DEEPLX_ENDPOINT, getDeepLXEndpoints, parseDeepLXEndpoints} from "@/src/core/config/deeplx";
import {translate, MAX_FREE_TEXT_LENGTH, type SourceLanguage, type TargetLanguage} from '@deeplx/core';
import {translateFreeTextChunks} from './freeTextChunks';
import {getTranslationProviderLanguages, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationLanguageOverride} from '@/src/core/translation/languages';
import {createHttpStatusError, createProviderCodeError} from '@/src/platform/http/errors';
import {
    abortErrorFromSignal,
    createRuntimeAbortContext,
    cancelUnreadResponseBody,
    runtimeFetch,
} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest, TranslationProviderRequestContext} from '@/src/services/translation/types';

const DEEPLX_TOTAL_TIMEOUT_MS = 20_000;
const DEEPLX_ATTEMPT_TIMEOUT_MS = 8_000;

function normalizeLanguage(language: string): string {
    const normalized = normalizeChineseLanguageCode(language).toLowerCase();
    if (normalized === "auto") {
        return "AUTO";
    }
    if (normalized === "zh-hans" || normalized === "zh-cn") {
        return "ZH";
    }
    if (normalized === "zh-tw" || normalized === "zh-hant") {
        return "ZH-HANT";
    }
    if (normalized === 'fil') return 'TL';
    return normalized.toUpperCase();
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 统一归类直连失败，保留取消原因和合法 HTTP 状态，不透传 core 的响应正文。 */
function directFailure(error: unknown, timeoutMs: number, callerSignal: AbortSignal | undefined, didTimeout: () => boolean): Error {
    if (callerSignal?.aborted) return abortErrorFromSignal(callerSignal);
    if (didTimeout()) return new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    const code = (error as {cause?: {code?: unknown}})?.cause?.code;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) {
        return createHttpStatusError({status: code, statusText: ''}, 'DeepL 直连失败');
    }
    return new Error('DeepL 直连失败');
}

async function translateDirectly(
    text: string,
    sourceLang: string,
    targetLang: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
): Promise<string> {
    const abortContext = createRuntimeAbortContext(timeoutMs, callerSignal);
    let directError: Error;
    try {
        return await translateFreeTextChunks(text, MAX_FREE_TEXT_LENGTH, async chunk => {
            // 使用数组形状，要求 core 严格检查响应条数；skipWarm 避免浏览器不可用的手工 Cookie 预热。
            const result = await translate([chunk], targetLang as TargetLanguage, sourceLang as SourceLanguage, {
                signal: abortContext.signal,
                skipWarm: true,
            });
            if (typeof result[0] !== 'string' || !result[0].trim()) throw new Error('缺少译文');
            return result[0];
        }, abortContext.signal, true, {utf16: true, splitLines: false});
    } catch (error) {
        directError = directFailure(error, timeoutMs, callerSignal, abortContext.didTimeout);
    } finally {
        abortContext.cleanup();
    }
    throw directError;
}

async function fetchDeepLX(
    url: string,
    requestInit: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
): Promise<{response: Response; responseBody: string}> {
    const abortContext = createRuntimeAbortContext(timeoutMs, callerSignal);
    let response: Response | undefined;

    try {
        try {
            response = await runtimeFetch(url, {...requestInit, signal: abortContext.signal});
        } catch {
            if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
            if (abortContext.didTimeout()) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
            throw new Error('网络请求失败');
        }

        if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
        if (abortContext.didTimeout()) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
        if (!response.ok) return {response, responseBody: ''};
        try {
            const responseBody = await response.text();
            if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
            if (abortContext.didTimeout()) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
            return {response, responseBody};
        } catch {
            if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
            if (abortContext.didTimeout()) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
            throw new Error('响应读取失败');
        }
    } finally {
        if (response) cancelUnreadResponseBody(response);
        abortContext.cleanup();
    }
}

async function translateFromDeepLX(
    url: string,
    text: string,
    sourceLang: string,
    targetLang: string,
    token: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
): Promise<string> {
    const headers: HeadersInit = {
        "Content-Type": "application/json",
    };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const {response, responseBody} = await fetchDeepLX(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            text,
            source_lang: sourceLang,
            target_lang: targetLang,
        }),
    }, timeoutMs, callerSignal);

    if (!response.ok) {
        throw createHttpStatusError(response);
    }

    let result: unknown;
    try {
        result = JSON.parse(responseBody);
    } catch {
        throw new Error('返回的不是 JSON');
    }

    if (!result || typeof result !== "object") {
        throw new Error("返回格式异常");
    }

    const responseData = result as {code?: unknown; data?: unknown; message?: unknown};
    if (responseData.code !== undefined && responseData.code !== 200) {
        throw createProviderCodeError('DeepLX 返回错误', responseData.code);
    }
    if (typeof responseData.data !== "string" || responseData.data.trim().length === 0) {
        throw new Error("返回格式异常：缺少译文");
    }

    return responseData.data;
}

export function getDeepLXRequestLanguages(from: string, to: string): {sourceLang: string; targetLang: string} {
    return {
        sourceLang: normalizeLanguage(from),
        targetLang: normalizeLanguage(to),
    };
}

export async function translateDeepLXText(
    text: string,
    serviceKey: string = services.deeplx,
    languageOverride?: TranslationLanguageOverride & TranslationProviderRequestContext,
): Promise<string> {
    if (typeof text !== "string") {
        throw new Error("DeepLX 翻译仅支持单条文本");
    }

    const current = requireTranslationProviderConfig(languageOverride);
    const token = current.token[serviceKey]?.trim() || "";
    const endpoints = getDeepLXEndpoints(
        current.deeplx,
        current.proxy[serviceKey],
        token,
    );
    const {sourceLanguage, targetLanguage} = getTranslationProviderLanguages(languageOverride);
    const {sourceLang, targetLang} = getDeepLXRequestLanguages(sourceLanguage, targetLanguage);
    const deadline = Date.now() + DEEPLX_TOTAL_TIMEOUT_MS;
    const failures: string[] = [];
    const failureStatuses: Array<number | undefined> = [];
    const abortSignal = languageOverride?.abortSignal;
    const configuredEndpoints = parseDeepLXEndpoints(current.deeplx);

    // 兼容已保存的默认公共地址；显式自建/多端点/代理或令牌配置不改变收件方。
    if (!token && parseDeepLXEndpoints(current.proxy[serviceKey]).length === 0
        && (configuredEndpoints.length === 0
            || configuredEndpoints.length === 1 && configuredEndpoints[0] === DEFAULT_DEEPLX_ENDPOINT)
        && endpoints.length === 1 && endpoints[0] === DEFAULT_DEEPLX_ENDPOINT) {
        if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
        try {
            return await translateDirectly(text, sourceLang, targetLang, DEEPLX_ATTEMPT_TIMEOUT_MS, abortSignal);
        } catch (error) {
            if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
            failures.push(`DeepL 直连: ${getErrorMessage(error)}`);
            failureStatuses.push((error as {statusCode?: number}).statusCode);
        }
    }

    for (const [index, endpoint] of endpoints.entries()) {
        if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
            break;
        }

        try {
            return await translateFromDeepLX(
                endpoint,
                text,
                sourceLang,
                targetLang,
                token,
                Math.min(DEEPLX_ATTEMPT_TIMEOUT_MS, remainingTime),
                abortSignal,
            );
        } catch (error) {
            if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
            failures.push(`备用站点 ${index + 1}: ${getErrorMessage(error)}`);
            failureStatuses.push((error as {statusCode?: number}).statusCode);
        }
    }

    const failureSummary = failures.length > 0 ? failures.join("；") : "总请求时间已耗尽";
    const aggregate = new Error(`DeepLX 所有备用站点均失败：${failureSummary}`);
    const firstStatus = failureStatuses[0];
    const requestErrors = new Set([400, 404, 413, 415, 422]);
    // 保留标准 HTTP 分类供外层免费链判断；语言/参数错误不应熔断其他文本。
    // 混合网络故障不能被其中一次 400 掩盖，因此只传递一致状态或全部请求错误。
    if (firstStatus !== undefined && failureStatuses.every(status => status === firstStatus
        || (requestErrors.has(firstStatus) && status !== undefined && requestErrors.has(status)))) {
        Object.assign(aggregate, {statusCode: firstStatus});
    }
    throw aggregate;
}

async function deeplx(message: TranslationProviderRequest<string>) {
    if (typeof message.origin !== "string") {
        throw new Error("DeepLX 翻译仅支持单条文本");
    }

    return translateDeepLXText(message.origin, services.deeplx, message);
}

export default deeplx;
