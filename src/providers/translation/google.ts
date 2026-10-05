/**
 * @file src/providers/translation/google.ts
 *
 * 文件职责：适配无需用户密钥的 Google 浏览器批量接口与网页 RPC，在统一截止时间内合批、换线和冷却失败入口。
 * 主要内容：编码 translateHtml、translate_a/t 与带编号的 batchexecute 批次，严格校验结果数量与槽位，保护纯文本、换行及取消所有权；短时间合并同语言请求，按近期可靠性、延迟和在途负载动态排序，定期探索备用入口并单独探测冷却恢复，避免每个段落重复访问失效入口。公开符号包括 parseGoogleBatchResponse、translateGoogleTexts、translateGoogleText、default:google。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError} from '@/src/platform/http/errors';
import {
    getDynamicFreeProviderWeight,
    observeFreeProviderPerformance,
    type FreeProviderPerformance,
} from '@/src/services/translation/freeRoutingPolicy';
import {
    abortErrorFromSignal,
    createRuntimeAbortContext,
    runtimeFetch,
} from '@/src/platform/http/runtime';
import type {TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';

const GOOGLE_TRANSLATE_RPC_ID = 'MkEWBc';
const GOOGLE_TRANSLATE_BATCH_URLS = [
    `https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?rpcids=${GOOGLE_TRANSLATE_RPC_ID}`,
    `https://translate.google.co.uk/_/TranslateWebserverUi/data/batchexecute?rpcids=${GOOGLE_TRANSLATE_RPC_ID}`,
] as const;
const GOOGLE_TRANSLATE_HTML_URL = 'https://translate-pa.googleapis.com/v1/translateHtml';
const GOOGLE_TRANSLATE_LIST_URL = 'https://translate.googleapis.com/translate_a/t';
// Google 网页组件随浏览器脚本分发的公开协议标识，不是用户的 Google Cloud 凭据。
// 同一标识可在 read-frog main、kiss-translator master/dev 与 Google 网页组件中核对。
const GOOGLE_BROWSER_PUBLIC_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
const GOOGLE_TRANSLATE_TOTAL_TIMEOUT_MS = 8_000;
const GOOGLE_TRANSLATE_ATTEMPT_TIMEOUT_MS = 2_000;
const GOOGLE_CAPTCHA_HINT = '可能触发了 CAPTCHA，请稍后重试';
const GOOGLE_BLOCKED_COOLDOWN_MS = 300_000;
const GOOGLE_FAILURE_COOLDOWN_MS = 30_000;
const GOOGLE_BATCH_MAX_ITEMS = 32;
const GOOGLE_BATCH_MAX_CHARACTERS = 4_000;
const GOOGLE_BATCH_WINDOW_MS = 10;
const GOOGLE_EXPLORATION_INTERVAL = 10;

type EndpointHealth = {
    retryAt: number; failures: number; version: number; statusCode?: number; probing: boolean;
    active: number; observations: number; lastAttemptAt: number; performance?: FreeProviderPerformance;
};
// 仅保存固定入口的状态；不保存用户原文、密钥或服务端响应。
const endpointHealth = new Map<string, EndpointHealth>();
let googleSelectionSequence = 0;
type GoogleProvider = {
    name: string;
    endpoint: string;
    baseWeight: number;
    translate: (timeoutMs: number) => Promise<string[]>;
};

function getEndpointHealth(endpoint: string): EndpointHealth {
    let state = endpointHealth.get(endpoint);
    if (!state) {
        state = {retryAt: 0, failures: 0, version: 0, probing: false, active: 0, observations: 0, lastAttemptAt: 0};
        endpointHealth.set(endpoint, state);
    }
    return state;
}

function prioritizeGoogleProviders(providers: readonly GoogleProvider[], explore: boolean): GoogleProvider[] {
    const now = Date.now();
    const eligible = providers.filter(provider => {
        const state = getEndpointHealth(provider.endpoint);
        return state.retryAt <= now && !state.probing;
    });
    const scores = new Map(providers.map(provider => {
        const state = getEndpointHealth(provider.endpoint);
        return [provider.endpoint, getDynamicFreeProviderWeight(provider.baseWeight, state.performance, now) / (1 + state.active)];
    }));
    // 冷却到期的入口先获得一次受控恢复机会，不能因历史失败一直排在最后。
    const recovery = eligible.find(provider => getEndpointHealth(provider.endpoint).retryAt > 0);
    const exploratory = explore ? [...eligible].sort((left, right) => {
        const a = getEndpointHealth(left.endpoint), b = getEndpointHealth(right.endpoint);
        return a.observations - b.observations || a.lastAttemptAt - b.lastAttemptAt;
    })[0] : undefined;
    const probe = recovery ?? exploratory;
    const ranked = [...providers].sort((left, right) => {
        const a = getEndpointHealth(left.endpoint), b = getEndpointHealth(right.endpoint);
        const unavailableA = a.retryAt > now || a.probing;
        const unavailableB = b.retryAt > now || b.probing;
        return Number(unavailableA) - Number(unavailableB) || scores.get(right.endpoint)! - scores.get(left.endpoint)!;
    });
    // 探索消费这一批的真实请求，不额外发送后台测试，也不绕过冷却窗口。
    return probe ? [probe, ...ranked.filter(provider => provider !== probe)] : ranked;
}

function createGoogleBatchRequest(texts: readonly string[], fromLang: string, toLang: string): string {
    return JSON.stringify([texts.map((text, index) => [
        GOOGLE_TRANSLATE_RPC_ID,
        JSON.stringify([[text, fromLang, toLang, true], [null]]),
        null,
        String(index),
    ])]);
}

function googleLanguage(code: string): string {
    const normalized = normalizeChineseLanguageCode(code);
    return ({'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', nb: 'no', fil: 'tl'} as Record<string, string>)[normalized] ?? normalized;
}

function escapeGoogleText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeGoogleText(text: string): string {
    const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
    // 单次解码，避免把原文中的字面量 &lt; 再解释成标签；无需 DOMParser。
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
        if (!code.startsWith('#')) return entities[code.toLowerCase()]!;
        const value = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
            ? String.fromCodePoint(value) : entity;
    });
}

function requireGoogleTexts(value: unknown, expectedLength: number): string[] {
    if (!Array.isArray(value) || value.length !== expectedLength
        || value.some(text => typeof text !== 'string' || !text.trim())) {
        throw new Error('返回格式或译文数量异常');
    }
    return value as string[];
}

function getArrayItem(value: unknown, index: number): unknown {
    return Array.isArray(value) ? value[index] : undefined;
}

function joinTranslationSegments(value: unknown): string | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const translatedText = value
        .map(segment => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')
        .join('');
    return translatedText.length > 0 ? translatedText : null;
}

function getGoogleBatchSegments(payload: unknown): unknown {
    const translationGroups = getArrayItem(payload, 1);
    const firstGroup = getArrayItem(translationGroups, 0);
    const firstTranslation = getArrayItem(firstGroup, 0);
    return getArrayItem(firstTranslation, 5);
}

export function parseGoogleBatchResponse(responseBody: string): string {
    const lines = responseBody
        .replace(/^\)\]\}'(?:\r?\n)?/, '')
        .split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('[')) {
            continue;
        }

        let records: unknown;
        try {
            records = JSON.parse(trimmedLine);
        } catch {
            continue;
        }

        if (!Array.isArray(records)) {
            continue;
        }

        for (const record of records) {
            if (
                !Array.isArray(record)
                || record[0] !== 'wrb.fr'
                || record[1] !== GOOGLE_TRANSLATE_RPC_ID
                || typeof record[2] !== 'string'
            ) {
                continue;
            }

            let payload: unknown;
            try {
                payload = JSON.parse(record[2]);
            } catch {
                continue;
            }

            const translatedText = joinTranslationSegments(getGoogleBatchSegments(payload));
            if (translatedText !== null) {
                return translatedText;
            }
        }
    }

    throw new Error('返回格式异常');
}

function isHtmlResponse(responseBody: string): boolean {
    return /<!doctype html|<html[\s>]/i.test(responseBody);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createGoogleParseError(error: unknown, responseBody: string): Error {
    const message = getErrorMessage(error);
    return new Error(isHtmlResponse(responseBody) ? `${message}（${GOOGLE_CAPTCHA_HINT}）` : message);
}

async function fetchGoogleResponse(
    url: string | URL,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
): Promise<{responseBody: string}> {
    const abortContext = createRuntimeAbortContext(timeoutMs, callerSignal);

    try {
        let response: Response;
        try {
            response = await runtimeFetch(url, {...init, signal: abortContext.signal});
        } catch {
            if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
            if (abortContext.didTimeout()) {
                throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
            }
            throw new Error('网络请求失败');
        }

        let responseBody: string;
        try {
            responseBody = await response.text();
        } catch {
            if (callerSignal?.aborted) throw abortErrorFromSignal(callerSignal);
            if (abortContext.didTimeout()) {
                throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
            }
            throw new Error('响应读取失败');
        }
        if (!response.ok) {
            const statusError = createHttpStatusError(response);
            if (response.status === 400 && /"xsrf"/u.test(responseBody)) {
                Object.assign(statusError, {googleXsrfRejected: true});
            }
            if (response.status === 429 || isHtmlResponse(responseBody)) {
                // CAPTCHA 提示只扩展安全文案，保留标准 HTTP 状态供外层判断冷却。
                statusError.message = `${statusError.message}（${GOOGLE_CAPTCHA_HINT}）`;
            }
            throw statusError;
        }
        return {responseBody};
    } finally {
        abortContext.cleanup();
    }
}

async function translateGoogleBatch(
    endpoint: string,
    texts: readonly string[],
    fromLang: string,
    toLang: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
): Promise<string[]> {
    const {responseBody} = await fetchGoogleResponse(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
        body: new URLSearchParams({'f.req': createGoogleBatchRequest(texts, fromLang, toLang)}).toString(),
    }, timeoutMs, callerSignal);
    try {
        // RPC 响应可能乱序；只按请求编号还原，不按服务端返回顺序猜测文本槽。
        const translations = new Array<string>(texts.length);
        const seen = new Set<number>();
        for (const line of responseBody.replace(/^\)\]\}'(?:\r?\n)?/, '').split(/\r?\n/)) {
            if (!line.trim().startsWith('[')) continue;
            let records: unknown;
            try { records = JSON.parse(line); } catch { continue; }
            if (!Array.isArray(records)) continue;
            for (const record of records) {
                if (!Array.isArray(record) || record[0] !== 'wrb.fr' || record[1] !== GOOGLE_TRANSLATE_RPC_ID) continue;
                const id = typeof record[6] === 'string' && /^(0|[1-9][0-9]*)$/.test(record[6]) ? Number(record[6]) : -1;
                if (id < 0 || id >= texts.length || seen.has(id)) throw new Error('返回槽位编号异常');
                translations[id] = parseGoogleBatchResponse(JSON.stringify([record]));
                seen.add(id);
            }
        }
        if (seen.size !== texts.length) throw new Error('返回译文数量异常');
        return requireGoogleTexts(translations, texts.length);
    } catch (error) {
        throw createGoogleParseError(error, responseBody);
    }
}

async function translateGoogleHtml(
    texts: readonly string[], fromLang: string, toLang: string, timeoutMs: number, signal?: AbortSignal,
): Promise<string[]> {
    const {responseBody} = await fetchGoogleResponse(GOOGLE_TRANSLATE_HTML_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': GOOGLE_BROWSER_PUBLIC_KEY},
        // pre 保留换行、缩进和空行；原文始终作为转义后的纯文本，不执行任意 HTML。
        body: JSON.stringify([[texts.map(text => `<pre>${escapeGoogleText(text)}</pre>`), fromLang, toLang], 'wt_lib']),
    }, timeoutMs, signal);
    try {
        const translations = requireGoogleTexts(getArrayItem(JSON.parse(responseBody), 0), texts.length);
        return requireGoogleTexts(translations.map(text => decodeGoogleText(text.replace(/^<pre(?:\s[^>]*)?>([\s\S]*)<\/pre>$/i, '$1'))), texts.length);
    } catch (error) {
        throw createGoogleParseError(new Error('返回格式或译文数量异常'), responseBody);
    }
}

async function translateGoogleList(
    texts: readonly string[], fromLang: string, toLang: string, timeoutMs: number, signal?: AbortSignal,
): Promise<string[]> {
    const url = new URL(GOOGLE_TRANSLATE_LIST_URL);
    url.search = new URLSearchParams({client: 'gtx', sl: fromLang, tl: toLang, dt: 't'}).toString();
    const body = new URLSearchParams();
    for (const text of texts) body.append('q', text);
    const {responseBody} = await fetchGoogleResponse(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
        body: body.toString(),
    }, timeoutMs, signal);
    try {
        const result: unknown = JSON.parse(responseBody);
        // auto 源语言时服务端可返回 [译文, 检测语言]，显式源语言时返回字符串。
        return requireGoogleTexts(Array.isArray(result) ? result.map(item => Array.isArray(item) ? item[0] : item) : result, texts.length);
    } catch (error) {
        throw createGoogleParseError(new Error('返回格式或译文数量异常'), responseBody);
    }
}

async function executeGoogleTexts(texts: readonly string[], fromLang: string, toLang: string, signal: AbortSignal): Promise<string[]> {
    const providers: GoogleProvider[] = [
        {name: '浏览器批量接口', endpoint: GOOGLE_TRANSLATE_HTML_URL, baseWeight: 1.2,
            translate: timeout => translateGoogleHtml(texts, fromLang, toLang, timeout, signal)},
        {name: '网页批量接口', endpoint: GOOGLE_TRANSLATE_LIST_URL, baseWeight: 1,
            translate: timeout => translateGoogleList(texts, fromLang, toLang, timeout, signal)},
        ...GOOGLE_TRANSLATE_BATCH_URLS.map((endpoint, index) => ({
            name: index === 0 ? '主网页 RPC' : '备用网页 RPC', endpoint, baseWeight: index === 0 ? 0.8 : 0.7,
            translate: (timeout: number) => translateGoogleBatch(endpoint, texts, fromLang, toLang, timeout, signal),
        })),
    ];
    const deadline = Date.now() + GOOGLE_TRANSLATE_TOTAL_TIMEOUT_MS;
    const failures: string[] = [];
    const failureStatuses: Array<number | undefined> = [];
    const ranked = prioritizeGoogleProviders(providers, ++googleSelectionSequence % GOOGLE_EXPLORATION_INTERVAL === 0);
    for (const provider of ranked) {
        if (signal.aborted) throw abortErrorFromSignal(signal);
        const health = getEndpointHealth(provider.endpoint);
        if (health.retryAt > Date.now() || health.probing) {
            failures.push(`${provider.name}: 入口暂时冷却`);
            failureStatuses.push(health.statusCode);
            continue;
        }
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) break;
        const version = health.version;
        const recovering = health.retryAt > 0;
        if (recovering) health.probing = true;
        const startedAt = Date.now();
        health.lastAttemptAt = startedAt;
        health.active += 1;
        try {
            const result = await provider.translate(Math.min(GOOGLE_TRANSLATE_ATTEMPT_TIMEOUT_MS, remainingTime));
            // 较早的在途成功不能清掉后来请求记录的故障。
            if (health.version === version) {
                health.performance = observeFreeProviderPerformance(health.performance, true, Date.now() - startedAt, Date.now());
                health.observations += 1;
                health.retryAt = 0;
                health.failures = 0;
                health.statusCode = undefined;
            }
            return result;
        } catch (error) {
            if (signal.aborted) throw abortErrorFromSignal(signal);
            const statusCode = (error as {statusCode?: number}).statusCode;
            const xsrfRejected = (error as {googleXsrfRejected?: boolean}).googleXsrfRejected;
            // 参数、语言或过大输入错误属于这次请求，不应淘汰正常接口。
            if (xsrfRejected || ![400, 413, 415, 422].includes(statusCode ?? 0)) {
                const failureCount = health.failures + 1;
                const blocked = xsrfRejected || statusCode === 403 || statusCode === 429;
                const cooldown = blocked ? GOOGLE_BLOCKED_COOLDOWN_MS
                    : Math.min(GOOGLE_BLOCKED_COOLDOWN_MS, GOOGLE_FAILURE_COOLDOWN_MS * 2 ** Math.min(failureCount - 1, 4));
                health.performance = observeFreeProviderPerformance(health.performance, false, Date.now() - startedAt, Date.now());
                health.observations += 1;
                health.retryAt = Date.now() + cooldown;
                health.failures = failureCount;
                health.version += 1;
                health.statusCode = statusCode;
            }
            failures.push(`${provider.name}: ${getErrorMessage(error)}`);
            failureStatuses.push(statusCode);
        } finally {
            health.active -= 1;
            if (recovering) health.probing = false;
        }
    }
    const summary = failures.length > 0 ? failures.join('；') : '总请求时间已耗尽';
    const aggregate = new Error(`谷歌翻译所有匿名接口均失败：${summary}`);
    const firstStatus = failureStatuses[0];
    const requestErrors = new Set([400, 404, 413, 415, 422]);
    if (firstStatus !== undefined && failureStatuses.every(status => status === firstStatus
        || (requestErrors.has(firstStatus) && status !== undefined && requestErrors.has(status)))) {
        Object.assign(aggregate, {statusCode: firstStatus});
    }
    throw aggregate;
}

type PendingGoogleText = {
    text: string; fromLang: string; toLang: string; signal?: AbortSignal;
    settled: boolean; resolve: (text: string) => void; reject: (error: unknown) => void;
    removeAbortListener: () => void; cancelBatch?: () => void;
};
let pendingTexts: PendingGoogleText[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function settleGoogleText(task: PendingGoogleText, result: string | Error, failed: boolean): void {
    if (task.settled) return;
    task.settled = true;
    task.removeAbortListener();
    if (failed) task.reject(result);
    else task.resolve(result as string);
}

function dispatchGoogleBatch(tasks: PendingGoogleText[]): void {
    const controller = new AbortController();
    for (const task of tasks) task.cancelBatch = () => {
        // 独立调用者取消只移除自身；全部调用者离开后才终止共享网络请求。
        if (tasks.every(item => item.settled)) controller.abort();
    };
    void executeGoogleTexts(tasks.map(task => task.text), tasks[0]!.fromLang, tasks[0]!.toLang, controller.signal)
        .then(results => tasks.forEach((task, index) => settleGoogleText(task, results[index]!, false)),
            error => tasks.forEach(task => settleGoogleText(task, error, true)));
}

function flushGoogleTexts(): void {
    flushTimer = undefined;
    const tasks = pendingTexts;
    pendingTexts = [];
    const groups = new Map<string, {tasks: PendingGoogleText[]; characters: number}>();
    for (const task of tasks) {
        if (task.settled) continue;
        const key = JSON.stringify([task.fromLang, task.toLang]);
        let group = groups.get(key);
        const characters = escapeGoogleText(task.text).length + 11;
        if (group && (group.tasks.length >= GOOGLE_BATCH_MAX_ITEMS || group.characters + characters > GOOGLE_BATCH_MAX_CHARACTERS)) {
            dispatchGoogleBatch(group.tasks);
            group = undefined;
        }
        if (!group) {
            group = {tasks: [], characters: 0};
            groups.set(key, group);
        }
        group.tasks.push(task);
        group.characters += characters;
    }
    for (const group of groups.values()) dispatchGoogleBatch(group.tasks);
}

function enqueueGoogleText(
    text: string, fromLang: string, toLang: string, signal: AbortSignal,
    subscribeAbort: (callback: VoidFunction) => VoidFunction,
): Promise<string> {
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal));
    if (!text.trim()) return Promise.resolve(text);
    return new Promise((resolve, reject) => {
        const task: PendingGoogleText = {text, fromLang, toLang, signal, settled: false, resolve, reject, removeAbortListener: () => undefined};
        const onAbort = () => {
            settleGoogleText(task, abortErrorFromSignal(signal), true);
            task.cancelBatch?.();
        };
        task.removeAbortListener = subscribeAbort(onAbort);
        pendingTexts.push(task);
        flushTimer ??= setTimeout(flushGoogleTexts, GOOGLE_BATCH_WINDOW_MS);
    });
}

export async function translateGoogleTexts(texts: readonly string[], fromLang: string, toLang: string, signal?: AbortSignal): Promise<string[]> {
    const controller = new AbortController();
    const abortCallbacks = new Set<VoidFunction>();
    const cancelTasks = () => { for (const callback of [...abortCallbacks]) callback(); };
    controller.signal.addEventListener('abort', cancelTasks, {once: true});
    const subscribeAbort = (callback: VoidFunction): VoidFunction => {
        abortCallbacks.add(callback);
        return () => { abortCallbacks.delete(callback); };
    };
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, {once: true});
    try {
        return await Promise.all(texts.map(text => enqueueGoogleText(text, googleLanguage(fromLang), googleLanguage(toLang), controller.signal, subscribeAbort)));
    } catch (error) {
        controller.abort(error);
        throw error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', cancelTasks);
    }
}

export async function translateGoogleText(text: string, fromLang: string, toLang: string, signal?: AbortSignal): Promise<string> {
    return (await translateGoogleTexts([text], fromLang, toLang, signal))[0]!;
}

async function google(message: TranslationProviderRequest) {
    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    const texts = typeof message.origin === 'string' ? [message.origin] : message.origin;
    const results = await translateGoogleTexts(texts, sourceLanguage, targetLanguage, message.abortSignal);
    return typeof message.origin === 'string' ? results[0]! : results;
}

export default google;
