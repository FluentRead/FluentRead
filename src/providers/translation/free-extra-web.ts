/**
 * @file src/providers/translation/free-extra-web.ts
 * 文件职责：适配搜狗、Reverso、Lingva 和 Apertium 四个匿名网页翻译候选。
 * 主要内容：读取搜狗网页参数并识别内层业务错误，构造 Reverso 请求，明确 Lingva 公共实例的访问限制，调用 Apertium 动态语言对；保留文本槽/换行/边缘空白并响应取消。
 * 模块边界：不读取用户 Cookie、凭据或代理；免费链的超时、冷却和并发由上层编排负责。
 */
import MD5 from 'crypto-js/md5';
import {serializeTranslationSlots} from '@/src/core/translation/serialization';
import {getTranslationGlossarySourceText} from '@/src/services/translation/requestSnapshot';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export type ExtraFreeWebProvider =
    | 'sogouFree'
    | 'reversoFree'
    | 'lingvaFree'
    | 'apertiumFree';

export type FreeFailure = 'rate-limit' | 'quota' | 'blocked' | 'unavailable' | 'request';

const SOGOU_HOME = 'https://translate.sogou.com/';
const SOGOU_ENDPOINT = 'https://translate.sogou.com/api/transpc/text/result';
const REVERSO_ENDPOINT = 'https://api.reverso.net/translate/v1/translation';
const LINGVA_INSTANCE = 'https://lingva.ml';
const APERTIUM_ENDPOINT = 'https://apertium.org/apy';
const MAX_CHUNK_CODEPOINTS = 1000;

function failure(message = '免费网页翻译接口请求失败', statusCode = 502, freeFailure: FreeFailure = 'unavailable'): Error {
    return Object.assign(new Error(message), {statusCode, freeFailure});
}

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

function language(value: string, target: boolean): string {
    const code = value.trim().replaceAll('_', '-').toLowerCase();
    if (target && code === 'auto') throw failure('搜狗翻译不接受自动目标语言', 400, 'request');
    if (code === 'zh' || code === 'zh-cn' || code === 'zh-hans' || code === 'zh-chs') return 'zh-CHS';
    if (code === 'zh-tw' || code === 'zh-hk' || code === 'zh-mo' || code === 'zh-hant' || code === 'zh-cht') return 'zh-CHT';
    return code === 'auto' ? 'auto' : code;
}

function uuid(): string {
    return crypto.randomUUID();
}

async function getSogouSecret(signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    const response = await runtimeFetch(SOGOU_HOME, {method: 'GET', credentials: 'omit', signal});
    checkAbort(signal);
    if (!response.ok) throw createHttpStatusError(response, '搜狗翻译首页请求失败');
    const html = await response.text();
    checkAbort(signal);
    const match = html.match(/"secretCode"\s*:\s*(\d+)/u);
    if (!match?.[1]) throw failure('搜狗翻译首页缺少匿名参数', 502, 'unavailable');
    return match[1];
}

type SogouResponse = {
    status?: unknown;
    data?: {translate?: {dit?: unknown; errorCode?: unknown}};
};

async function translateSogouChunk(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    const secret = await getSogouSecret(signal);
    const requestUuid = uuid();
    const signature = MD5(source + target + text + secret).toString();
    const response = await runtimeFetch(SOGOU_ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        signal,
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*'},
        body: JSON.stringify({client: 'pc', exchange: false, fr: 'browser_pc', from: source, needQc: 1, s: signature, text, to: target, uuid: requestUuid}),
    });
    checkAbort(signal);
    if (!response.ok) throw createHttpStatusError(response, '搜狗翻译请求失败');
    const result = await readJsonResponse<SogouResponse | null>(response, '搜狗翻译返回的不是有效 JSON');
    checkAbort(signal);
    if (result?.status !== 0 && result?.status !== '0') throw failure('搜狗翻译业务请求失败');
    const translated = result.data?.translate?.dit;
    const errorCode = result.data?.translate?.errorCode;
    // 官方外层 status=0 仍可能返回空译文；只展示短格式内层错误码，不回显第三方正文。
    if (typeof translated !== 'string' || !translated.trim()) {
        if (typeof errorCode === 'string' && /^s\d{1,6}$/u.test(errorCode)) {
            throw failure(`搜狗翻译未返回译文（错误码 ${errorCode}）；请稍后重试或停用此服务`);
        }
        throw failure('搜狗翻译结果为空');
    }
    return translated.trim();
}

function genericLanguage(value: string, _target: boolean): string {
    const code = value.trim().replaceAll('_', '-').toLowerCase();
    if (code === 'zh-hans' || code === 'zh-chs' || code === 'zh-cn') return 'zh';
    if (code === 'zh-hant' || code === 'zh-cht' || code === 'zh-tw' || code === 'zh-hk') throw failure('该匿名服务不区分繁体中文', 400, 'request');
    return code;
}

async function translateReversoChunk(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    const response = await runtimeFetch(REVERSO_ENDPOINT, {
        method: 'POST', credentials: 'omit', signal,
        headers: {'Content-Type': 'application/json', Accept: 'application/json', 'x-reverso-origin': 'translation.web'},
        body: JSON.stringify({format: 'text', from: reversoLanguage(source, false), to: reversoLanguage(target, true), input: text, options: {languageDetection: true, contextResults: true, origin: 'translation.web'}}),
    });
    checkAbort(signal);
    if (!response.ok) throw createHttpStatusError(response, 'Reverso 翻译请求失败');
    const result = await readJsonResponse<{translation?: unknown} | null>(response, 'Reverso 返回的不是有效 JSON');
    checkAbort(signal);
    const value = result?.translation;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || !value.length || !value.join('').trim()) throw failure('Reverso 翻译结果为空');
    return value.join('').trim();
}

const reversoCodes: Record<string, string> = {en: 'eng', 'zh-hans': 'chi', 'zh-chs': 'chi', zh: 'chi', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', ru: 'rus', ar: 'ara', nl: 'nld', pl: 'pol', tr: 'tur'};
function reversoLanguage(value: string, target: boolean): string {
    const code = genericLanguage(value, target);
    return reversoCodes[code] || code;
}

const apertiumCodes: Record<string, string> = {
    en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ca: 'cat', gl: 'glg', ro: 'ron',
    eo: 'epo', oc: 'oci', cy: 'cym', nb: 'nob', no: 'nob', sv: 'swe', da: 'dan', is: 'isl',
    uk: 'ukr', ru: 'rus', pl: 'pol', cs: 'ces', sk: 'slk', sl: 'slv', hr: 'hrv', sr: 'srp',
};
function apertiumLanguage(value: string, target: boolean): string {
    const code = genericLanguage(value, target);
    return apertiumCodes[code] || code;
}

async function translateLingvaChunk(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    const from = genericLanguage(source, false);
    const to = genericLanguage(target, true);
    const url = `${LINGVA_INSTANCE}/api/v1/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(text)}`;
    const response = await runtimeFetch(url, {method: 'GET', credentials: 'omit', signal, headers: {Accept: 'application/json'}});
    checkAbort(signal);
    if (!response.ok) {
        const label = response.status === 403
            ? 'Lingva 公共实例拒绝自动访问，请稍后重试或停用此服务'
            : response.status === 429
                ? 'Lingva 公共实例限流，请稍后重试'
                : 'Lingva 公共实例暂时不可用，请稍后重试';
        throw createHttpStatusError(response, label);
    }
    const result = await readJsonResponse<{translation?: unknown; error?: unknown} | null>(response, 'Lingva 返回的不是有效 JSON');
    checkAbort(signal);
    if (result?.error) throw failure('Lingva 翻译业务请求失败');
    if (typeof result?.translation !== 'string' || !result.translation.trim()) throw failure('Lingva 翻译结果为空');
    return result.translation.trim();
}

async function translateApertiumChunk(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    const pair = `${apertiumLanguage(source, false)}|${apertiumLanguage(target, true)}`;
    const listResponse = await runtimeFetch(`${APERTIUM_ENDPOINT}/listPairs`, {method: 'GET', credentials: 'omit', signal, headers: {Accept: 'application/json'}});
    checkAbort(signal);
    if (!listResponse.ok) throw createHttpStatusError(listResponse, 'Apertium 语言列表请求失败');
    const pairs = await readJsonResponse<unknown>(listResponse, 'Apertium 语言列表不是有效 JSON');
    const body = pairs && typeof pairs === 'object' && 'responseData' in pairs ? (pairs as {responseData?: unknown}).responseData : pairs;
    const hasPair = Array.isArray(body) && body.some(item => {
        if (typeof item === 'string') return item === pair || item.replace('-', '|') === pair;
        if (!item || typeof item !== 'object') return false;
        const value = item as {sourceLanguage?: unknown; targetLanguage?: unknown; langpair?: unknown};
        return value.langpair === pair || (typeof value.langpair === 'string' && value.langpair.replace('-', '|') === pair)
            || `${value.sourceLanguage}|${value.targetLanguage}` === pair;
    }) || !!body && typeof body === 'object' && Object.keys(body).some(key => key === pair || key.replace('-', '|') === pair);
    if (!hasPair) throw failure('Apertium 不支持当前语言方向', 400, 'request');
    const query = new URLSearchParams({langpair: pair, q: text, format: 'txt'});
    const response = await runtimeFetch(`${APERTIUM_ENDPOINT}/translate?${query}`, {method: 'GET', credentials: 'omit', signal, headers: {Accept: 'application/json'}});
    checkAbort(signal);
    if (!response.ok) throw createHttpStatusError(response, 'Apertium 翻译请求失败');
    const result = await readJsonResponse<{responseStatus?: unknown; responseData?: {translatedText?: unknown}} | null>(response, 'Apertium 返回的不是有效 JSON');
    checkAbort(signal);
    const translated = result?.responseData?.translatedText;
    if (result?.responseStatus !== 200 || typeof translated !== 'string' || !translated.trim()) throw failure('Apertium 翻译结果为空');
    return translated.trim();
}

type ChunkTranslator = (text: string, source: string, target: string, signal?: AbortSignal) => Promise<string>;

async function translatePlain(text: string, source: string, target: string, signal: AbortSignal | undefined, translator: ChunkTranslator): Promise<string> {
    let result = '';
    for (const line of text.split(/([\r\n]+)/u)) {
        const points = Array.from(line);
        for (let start = 0; start < points.length; start += MAX_CHUNK_CODEPOINTS) {
            checkAbort(signal);
            const chunk = points.slice(start, start + MAX_CHUNK_CODEPOINTS).join('');
            const content = chunk.trim();
            if (!content) { result += chunk; continue; }
            const prefix = chunk.slice(0, chunk.indexOf(content));
            const suffix = chunk.slice(prefix.length + content.length);
            const translated = await translator(content, source, target, signal);
            result += prefix + translated + suffix;
        }
    }
    return result;
}

export async function translateExtraFreeWebText(
    id: ExtraFreeWebProvider,
    text: string,
    source: string,
    target: string,
    signal?: AbortSignal,
): Promise<string> {
    checkAbort(signal);
    if (typeof text !== 'string') throw failure('免费网页翻译仅支持文本输入', 400, 'unavailable');
    if (!text.trim()) return text;
    const from = language(source, false);
    const to = language(target, true);
    const translator: ChunkTranslator = id === 'sogouFree' ? translateSogouChunk : id === 'reversoFree' ? translateReversoChunk : id === 'lingvaFree' ? translateLingvaChunk : translateApertiumChunk;
    const slots = getTranslationGlossarySourceText(text);
    if (!Array.isArray(slots)) return translatePlain(text, from, to, signal, translator);
    const translated: string[] = [];
    for (const slot of slots) translated.push(await translatePlain(slot, from, to, signal, translator));
    const nonce = text.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu)![1]!;
    return serializeTranslationSlots(translated, nonce).payload;
}
