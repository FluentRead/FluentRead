/**
 * @file src/providers/translation/free-official-web.ts
 * 文件职责：直连阿里翻译、ModernMT、Lara 与 Lingvanex 的官方匿名网页服务。
 * 主要内容：按码点预算且不切术语标记，按供应商协议处理临时网页参数、公开校验签名、语言映射与安全错误，保留文本槽、换行和空白；所有请求省略 Cookie，官网参数仅在本次调用中使用，失败或迟到取消时直接取消未读正文，避免等待错误页 EOF。
 * 模块边界：只访问固定供应商官方端点，不读取用户凭据、代理或存储；超时、并发、竞争和冷却由免费翻译编排层负责。
 */
import {md5Hex} from '@/src/shared/crypto/lightCrypto';
import {translateFreeTextChunks} from './freeTextChunks';
import {rebuildTranslationSlots} from '@/src/core/translation/slotProtocol';
import {getTranslationGlossarySourceSlots} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {abortErrorFromSignal, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export type OfficialFreeWebProvider = 'alibabaFree' | 'modernMtFree' | 'laraFree' | 'lingvanexFree';
const ALIBABA_BASE = 'https://translate.alibaba.com/api/translate';
const MODERNMT_URL = 'https://webapi.modernmt.com/translate';
const LARA_URL = 'https://webapi.laratranslate.com/translate/segmented';
const LINGVANEX_HOME = 'https://lingvanex.com/en/translate/';
const LINGVANEX_URL = 'https://api-b2b.backenster.com/b1/api/v3/translate';
const MAX_CHUNK_CODEPOINTS = 1000;
interface WebResponse {
    token?: unknown;
    headerName?: unknown;
    success?: unknown;
    httpStatusCode?: unknown;
    status?: unknown;
    data?: {translateText?: unknown; translation?: unknown};
    content?: {translations?: unknown};
    err?: {code?: unknown};
    result?: unknown;
}
const LINGVANEX_LANGUAGES: Record<string, string> = {
    en: 'en_GB', zh: 'zh-Hans_CN', 'zh-cn': 'zh-Hans_CN', 'zh-tw': 'zh-Hant_TW',
    ja: 'ja_JP', ko: 'ko_KR', de: 'de_DE', fr: 'fr_FR', es: 'es_ES', ru: 'ru_RU',
    pt: 'pt_PT', it: 'it_IT', ar: 'ar_SA', hi: 'hi_IN', tr: 'tr_TR', uk: 'uk_UA', vi: 'vi_VN', nl: 'nl_NL',
};

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}


function failure(statusCode = 502): Error {
    const freeFailure = statusCode === 429 ? 'rate-limit'
        : statusCode === 402 || statusCode === 456 ? 'quota'
            : statusCode === 401 || statusCode === 403 ? 'blocked'
                : statusCode >= 400 && statusCode < 500 ? 'request' : 'unavailable';
    return Object.assign(new Error(`官方网页翻译请求失败: ${statusCode}`), {statusCode, freeFailure});
}

function language(value: string, target: boolean): string {
    const code = value.trim().replaceAll('_', '-').toLowerCase();
    if (code === 'auto' && !target) return code;
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(code) || code === 'auto') throw failure(400);
    if (['zh-hans', 'zh-chs', 'zh-cn'].includes(code)) return 'zh-cn';
    if (['zh-hant', 'zh-cht', 'zh-tw', 'zh-hk', 'zh-mo'].includes(code)) return 'zh-tw';
    return code;
}

function providerLanguage(provider: OfficialFreeWebProvider, code: string): string {
    if (provider === 'lingvanexFree') {
        if (code === 'auto') return '';
        const mapped = LINGVANEX_LANGUAGES[code] ?? LINGVANEX_LANGUAGES[code.split('-')[0]!];
        if (!mapped) throw failure(400);
        return mapped;
    }
    if (provider === 'alibabaFree') return code === 'zh-cn' ? 'zh' : code;
    if (code === 'auto') return '';
    if (code === 'zh' || code === 'zh-cn') return 'zh-CN';
    if (code === 'zh-tw') return 'zh-TW';
    return code;
}

async function json(url: string, init: RequestInit, signal?: AbortSignal): Promise<WebResponse | null> {
    checkAbort(signal);
    const response = await runtimeFetch(url, {...init, credentials: 'omit', signal});
    try {
        checkAbort(signal);
        if (!response.ok) throw createHttpStatusError(response, '官方网页翻译请求失败');
        const result = await readJsonResponse<WebResponse | null>(response, '官方网页翻译返回的不是有效 JSON');
        checkAbort(signal);
        return result;
    } finally {cancelUnreadResponseBody(response);}
}

async function translateChunk(provider: OfficialFreeWebProvider, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    let result: WebResponse | null;
    let translated: unknown;
    if (provider === 'alibabaFree') {
        const csrf = await json(`${ALIBABA_BASE}/csrftoken`, {method: 'GET'}, signal);
        if (typeof csrf?.token !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(csrf.token)
            || csrf.headerName !== 'X-XSRF-TOKEN_PROPERTY_ITEM') throw failure();
        const body = new FormData();
        for (const [key, value] of Object.entries({query: text, srcLang: source, tgtLang: target, domain: 'general', _csrf: csrf.token})) body.append(key, value);
        result = await json(`${ALIBABA_BASE}/text`, {method: 'POST', headers: {[csrf.headerName]: csrf.token}, body}, signal);
        if (result?.success !== true) throw failure(businessStatus(result?.httpStatusCode));
        translated = result.data?.translateText;
    } else if (provider === 'modernMtFree') {
        const ts = Date.now();
        // 官网页面公开的请求校验前缀，不是用户的 API Key。
        const verify = md5Hex(`webkey_E3sTuMjpP8Jez49GcYpDVH7r#${ts}#${text}`);
        result = await json(MODERNMT_URL, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'GET'},
            body: JSON.stringify({q: text, source, target, ts, verify, hints: '', multiline: 'true'})}, signal);
        if (result?.status !== 200) throw failure(businessStatus(result?.status));
        translated = result.data?.translation;
    } else if (provider === 'laraFree') {
        result = await json(LARA_URL, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lara-Client': 'Webapp'},
            body: JSON.stringify({q: text, source, target, source_hint: '', style: 'faithful', content_type: 'text/plain', adapt_to: [], glossaries: [], instructions: []})}, signal);
        if (result?.status !== 200) throw failure(businessStatus(result?.status));
        const translations = result.content?.translations;
        if (!Array.isArray(translations) || !translations.length || translations.some(item => typeof item?.translation !== 'string' || !item.translation.trim())) throw failure();
        translated = translations.map(item => item.translation).join('');
    } else {
        checkAbort(signal);
        const response = await runtimeFetch(LINGVANEX_HOME, {method: 'GET', credentials: 'omit', signal});
        let auth: string;
        try {
            checkAbort(signal);
            if (!response.ok) throw createHttpStatusError(response, 'Lingvanex 官网请求失败');
            const html = await response.text();
            checkAbort(signal);
            const match = html.match(/const\s+API_BEARER_TOKEN\s*=\s*"(Bearer [a-zA-Z0-9_-]{1,256})"/u)?.[1];
            if (!match) throw failure();
            auth = match;
        } finally {cancelUnreadResponseBody(response);}
        result = await json(LINGVANEX_URL, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: auth},
            body: JSON.stringify({...(source ? {from: source} : {}), to: target, text, platform: 'dp'})}, signal);
        if (result?.err) throw failure(businessStatus(result.err?.code));
        translated = result?.result;
    }
    if (typeof translated !== 'string' || !translated.trim()) throw failure();
    return translated.trim();
}

function businessStatus(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : 502;
}

async function translatePlain(provider: OfficialFreeWebProvider, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    return translateFreeTextChunks(text, MAX_CHUNK_CODEPOINTS, chunk => translateChunk(provider, chunk, source, target, signal), signal);
}

export async function translateOfficialFreeWebText(provider: OfficialFreeWebProvider, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (typeof text !== 'string') throw failure(400);
    if (!text.trim()) return text;
    const from = providerLanguage(provider, language(source, false));
    const to = providerLanguage(provider, language(target, true));
    if (from && from === to) return text;
    const slots = getTranslationGlossarySourceSlots(text);
    if (!slots) return translatePlain(provider, text, from, to, signal);
    const translated: string[] = [];
    for (const slot of slots.texts) translated.push(await translatePlain(provider, slot, from, to, signal));
    const result = rebuildTranslationSlots(slots.packet, translated);
    if (result === null) throw failure();
    return result;
}

/** 沿用免费池已冻结的语言和取消上下文，不读取独立服务配置。 */
export function translateOfficialFreeWebProvider(provider: OfficialFreeWebProvider, request: TranslationProviderRequest<string>): Promise<string> {
    return translateOfficialFreeWebText(provider, request.origin, request.sourceLanguage!, request.targetLanguage!, request.abortSignal);
}
