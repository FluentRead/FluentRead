/**
 * @file src/providers/translation/free-chinese-web.ts
 * 文件职责：适配有道网页普通翻译和金山词霸匿名网页翻译接口。
 * 主要内容：生成公开网页协议所需签名，解密词霸响应，限制支持的中英方向；有道按安全长度分块，避免匿名接口静默截去长段落末尾，同时保留文本槽、换行、边缘空白、取消和结构化失败分类。
 * 模块边界：本文件只负责固定匿名 HTTP provider；不读取账号、Cookie、用户密钥、代理或存储，不负责免费服务编排、重试和并发。
 */
import AES from 'crypto-js/aes';
import encUtf8 from 'crypto-js/enc-utf8';
import MD5 from 'crypto-js/md5';
import modeECB from 'crypto-js/mode-ecb';
import padPkcs7 from 'crypto-js/pad-pkcs7';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {detectChineseScript} from '@/src/core/language/detect';
import {serializeTranslationSlots} from '@/src/core/translation/serialization';
import {getTranslationGlossarySourceText} from '@/src/services/translation/requestSnapshot';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export type FreeChineseWebProvider = 'youdaoFree' | 'icibaFree';

type FreeFailure = 'rate-limit' | 'quota' | 'blocked' | 'unavailable' | 'request';
type FreeError = Error & {statusCode?: number; freeFailure?: FreeFailure; retryAfterMs?: number};

const YOUDAO_URL = 'https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4';
const YOUDAO_KEYFROM = 'webfanyi.webmain';
const YOUDAO_CLIENT = 'webmain';
const YOUDAO_SECRET = 't2he2k4m2g6QKRigK0KAmSpXKgAezyWg';
const ICIBA_URL = 'https://ifanyi.iciba.com/index.php?c=trans&m=fyV2';
const ICIBA_CLIENT = '6';
const ICIBA_AUTH_USER = 'key_web_new_fanyi';
const ICIBA_SIGN_PREFIX = '6key_web_new_fanyi6dVjYLFyzfkFkk';
const ICIBA_SIGN_KEY = 'L4fBtD5fLC9FQw22';
const ICIBA_RESPONSE_KEY = 'aahc3TfyfCEmER33';
// 有道匿名接口会静默截断约 600 字符后的内容；低于该边界分块以保留长段落末尾。
const YOUDAO_MAX_CHUNK_CODEPOINTS = 500;
const ICIBA_MAX_CHUNK_CODEPOINTS = 1000;

function failure(message: string, freeFailure: FreeFailure, statusCode?: number): FreeError {
    return Object.assign(new Error(message), {freeFailure, ...(statusCode === undefined ? {} : {statusCode})});
}

function classifyStatus(statusCode: number): FreeFailure {
    if (statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410) return 'blocked';
    if (statusCode === 402 || statusCode === 456) return 'quota';
    if (statusCode === 429) return 'rate-limit';
    if (statusCode >= 500) return 'unavailable';
    if (statusCode === 408) return 'unavailable';
    return 'request';
}

function ensureLanguage(value: string, target: boolean, text: string): string {
    const normalized = normalizeChineseLanguageCode(value);
    if (normalized === 'auto') {
        const script = detectChineseScript(text);
        if (script === 'Hans') return target ? 'en' : 'zh-CHS';
        if (script === 'Hant') throw failure('免费网页翻译不支持繁体中文方向', 'request', 400);
        return ['en', 'zh-CHS'][Number(target)]!;
    }
    if (normalized === 'en') return 'en';
    if (normalized === 'zh-Hans') return 'zh-CHS';
    throw failure('免费网页翻译不支持该语言方向', 'request', 400);
}

function direction(source: string, target: string, text: string): {from: string; to: string} {
    const from = ensureLanguage(source, false, text);
    const to = ensureLanguage(target, true, text);
    if (from === to) throw failure('免费网页翻译不支持相同语言方向', 'request', 400);
    return {from, to};
}

function youdaoTimestamp(query: string): string {
    return String(Date.now() + ((query + YOUDAO_KEYFROM).length % 10));
}

function youdaoSign(query: string, timestamp: string): string {
    const queryDigest = MD5(query + YOUDAO_KEYFROM).toString();
    return MD5(`${YOUDAO_CLIENT}${query}${timestamp}${YOUDAO_SECRET}${queryDigest}`).toString();
}

function decryptIciba(content: unknown): Record<string, unknown> {
    if (typeof content !== 'string' || !content) throw failure('词霸返回内容无效', 'unavailable');
    try {
        const plain = AES.decrypt(content, encUtf8.parse(ICIBA_RESPONSE_KEY), {
            mode: modeECB,
            padding: padPkcs7,
        }).toString(encUtf8);
        const value: unknown = JSON.parse(plain);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch {
        throw failure('词霸返回内容无效', 'unavailable');
    }
}

async function fetchJson(provider: FreeChineseWebProvider, query: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
    const init: RequestInit = {method: 'POST', credentials: 'omit', signal};
    let url: string;
    if (provider === 'youdaoFree') {
        const timestamp = youdaoTimestamp(query);
        const params = new URLSearchParams({q: query, from, to, t: timestamp, client: YOUDAO_CLIENT, sign: youdaoSign(query, timestamp), keyfrom: YOUDAO_KEYFROM});
        url = `${YOUDAO_URL}&${params}`;
        init.method = 'GET';
    } else {
        const digest = MD5(ICIBA_SIGN_PREFIX + query).toString().slice(0, 16);
        const encryptedSign = AES.encrypt(digest, encUtf8.parse(ICIBA_SIGN_KEY), {mode: modeECB, padding: padPkcs7}).toString();
        const params = new URLSearchParams({from: from === 'zh-CHS' ? 'zh' : from, to: to === 'zh-CHS' ? 'zh' : to, q: query, client: ICIBA_CLIENT, auth_user: ICIBA_AUTH_USER, sign: encryptedSign});
        url = ICIBA_URL;
        init.headers = {'Content-Type': 'application/x-www-form-urlencoded'};
        init.body = params.toString();
    }
    let response: Response;
    try {
        response = await runtimeFetch(url, init);
    } catch (error) {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        throw failure('免费网页翻译请求失败', 'unavailable');
    }
    if (signal?.aborted) throw abortErrorFromSignal(signal);
    if (!response.ok) {
        const statusError = createHttpStatusError(response, '免费网页翻译请求失败');
        throw Object.assign(statusError, {freeFailure: classifyStatus(response.status)});
    }
    if (provider === 'youdaoFree') {
        const result = await readJsonResponse<{fanyi?: {tran?: unknown}} | null>(response, '有道返回的不是有效 JSON');
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        const translated = result?.fanyi?.tran;
        if (typeof translated !== 'string' || !translated.trim()) throw failure('有道返回内容无效', 'unavailable');
        return translated;
    }
    const envelope = await readJsonResponse<{content?: unknown} | null>(response, '词霸返回的不是有效 JSON');
    if (signal?.aborted) throw abortErrorFromSignal(signal);
    const result = decryptIciba(envelope?.content);
    if (result.err_no !== 0) {
        const code = Number(result.err_no);
        const kind: FreeFailure = code === 429 ? 'rate-limit' : code === 403 ? 'blocked' : code === 402 ? 'quota' : 'request';
        throw failure('词霸翻译业务请求失败', kind, Number.isInteger(code) ? code : undefined);
    }
    if (typeof result.out !== 'string' || !result.out.trim()) throw failure('词霸返回内容无效', 'unavailable');
    return result.out;
}

async function translatePlain(provider: FreeChineseWebProvider, text: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
    let output = '';
    const maxChunkCodepoints = provider === 'youdaoFree' ? YOUDAO_MAX_CHUNK_CODEPOINTS : ICIBA_MAX_CHUNK_CODEPOINTS;
    for (const line of text.split(/([\r\n]+)/u)) {
        const points = Array.from(line);
        for (let start = 0; start < points.length;) {
            if (signal?.aborted) throw abortErrorFromSignal(signal);
            const end = provider === 'youdaoFree' ? youdaoChunkEnd(points, start) : Math.min(points.length, start + maxChunkCodepoints);
            const chunk = points.slice(start, end).join('');
            start = end;
            const content = chunk.trim();
            if (!content) { output += chunk; continue; }
            const prefix = chunk.slice(0, chunk.indexOf(content));
            const suffix = chunk.slice(prefix.length + content.length);
            output += prefix + await fetchJson(provider, content, from, to, signal) + suffix;
        }
    }
    return output;
}

/** 在安全长度后半段优先句末、其次空白，避免把英文单词切成两次独立翻译；无边界时仍按完整码点推进。 */
function youdaoChunkEnd(points: readonly string[], start: number): number {
    const end = Math.min(points.length, start + YOUDAO_MAX_CHUNK_CODEPOINTS);
    if (end === points.length) return end;
    let sentence = 0;
    let word = 0;
    for (let index = start + YOUDAO_MAX_CHUNK_CODEPOINTS / 2; index < end; index++) {
        const point = points[index]!;
        if (/\s/u.test(point)) {
            word = index + 1;
            if (/[.!?]/u.test(points[index - 1]!)) sentence = word;
        } else if (/[。！？]/u.test(point)) sentence = index + 1;
    }
    return sentence || word || end;
}

export async function translateFreeChineseWebText(provider: FreeChineseWebProvider, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
    if (typeof text !== 'string') throw failure('免费网页翻译仅支持文本输入', 'request', 400);
    if (!text.trim()) return text;
    const {from, to} = direction(source, target, text);
    const slots = getTranslationGlossarySourceText(text);
    if (!Array.isArray(slots)) return translatePlain(provider, slots, from, to, signal);
    const translated: string[] = [];
    for (const slot of slots) translated.push(await translatePlain(provider, slot, from, to, signal));
    // slots 只有在完整槽协议解析成功时才会是数组，因此首个标记必然存在。
    const nonce = text.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu)![1]!;
    return serializeTranslationSlots(translated, nonce).payload;
}
