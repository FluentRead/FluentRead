/**
 * @file src/providers/translation/free-web.ts
 * 文件职责：为免费翻译内部提供腾讯交互翻译、Yandex 与火山网页接口适配。
 * 主要内容：固定匿名端点与语言代码，校验 HTTP/业务状态、取消和有效译文；保留全文文本槽、换行和边缘空白，按码点限制请求长度。
 * 模块边界：只接受文本、语言与取消信号，不读取用户凭据、代理或存储，不注册独立服务；超时、冷却与并发由免费翻译编排负责。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {serializeTranslationSlots} from '@/src/core/translation/serialization';
import {getTranslationGlossarySourceText} from '@/src/services/translation/requestSnapshot';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export type FreeWebProvider = 'transmart' | 'yandexFree' | 'volcengineFree';
const endpoints: Record<FreeWebProvider, string> = {
    transmart: 'https://transmart.qq.com/api/imt',
    yandexFree: 'https://translate.yandex.net/api/v1/tr.json/translate',
    volcengineFree: 'https://translate.volcengine.com/crx/translate/v1/',
};
const MAX_CHUNK_CODEPOINTS = 1000;

function failure(statusCode = 502): Error {
    return Object.assign(new Error('免费网页翻译接口请求失败'), {statusCode});
}

function language(provider: FreeWebProvider, value: string, target: boolean): string {
    const code = normalizeChineseLanguageCode(value);
    if (target && code === 'auto') throw failure(400);
    if (code === 'zh-Hans') return 'zh';
    if (code === 'zh-Hant') {
        if (!target) return 'zh';
        // Yandex 仅有通用中文代码，不能把繁体请求静默降为简体。
        if (provider === 'yandexFree') throw failure(400);
        return provider === 'transmart' ? 'zh-tw' : 'zh-Hant';
    }
    return code;
}

function translationArray(value: unknown): string {
    if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) throw failure();
    return value.join('');
}

type WebResponse = {
    header?: {ret_code?: unknown}; auto_translation?: unknown;
    code?: unknown; text?: unknown;
    base_resp?: {status_code?: unknown}; translation?: unknown;
};

/** 每次尝试只使用临时随机请求标识；不复用固定客户端值或任何账号 Token。 */
async function translateChunk(provider: FreeWebProvider, text: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
    const init: RequestInit = {method: 'POST', credentials: 'omit', signal, headers: {'Content-Type': 'application/json'}};
    let url = endpoints[provider];
    if (provider === 'transmart') {
        init.body = JSON.stringify({
            header: {fn: 'auto_translation', client_key: `browser-chrome-110.0.0-Mac OS-${crypto.randomUUID()}-${Date.now()}`},
            type: 'plain', model_category: 'normal', source: {text_list: [text], lang: from}, target: {lang: to},
        });
    } else if (provider === 'yandexFree') {
        const params = new URLSearchParams({id: `${crypto.randomUUID().replaceAll('-', '')}-0-0`, srv: 'android', target_lang: to, text});
        if (from !== 'auto') params.set('source_lang', from);
        url += `?${params}`;
        init.body = '';
    } else {
        init.body = JSON.stringify({source_language: from, target_language: to, text});
    }
    let response: Response;
    try {
        response = await runtimeFetch(url, init);
    } catch (error) {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        if (provider === 'yandexFree' && error instanceof TypeError) {
            throw new Error('Yandex 网络连接失败，请检查网络后重试或停用此服务');
        }
        throw error;
    }
    if (signal?.aborted) throw abortErrorFromSignal(signal);
    if (!response.ok) throw createHttpStatusError(response, provider === 'yandexFree' ? 'Yandex 翻译请求失败' : '请求失败');
    const result = await readJsonResponse<WebResponse | null>(response);
    if (signal?.aborted) throw abortErrorFromSignal(signal);
    let value: unknown;
    if (provider === 'transmart') {
        if (result?.header?.ret_code !== 'succ') throw failure(result?.header?.ret_code === 'Auth-Failed' ? 403 : 502);
        value = translationArray(result.auto_translation);
    } else if (provider === 'yandexFree') {
        if (result?.code !== 200) {
            const code = result?.code;
            throw failure(typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502);
        }
        value = translationArray(result.text);
    } else {
        if (result?.base_resp?.status_code !== 0) throw failure();
        value = result.translation;
    }
    if (typeof value !== 'string' || !value.trim()) throw failure();
    return value.trim();
}

export async function translateFreeWebText(provider: FreeWebProvider, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    const check = () => { if (signal?.aborted) throw abortErrorFromSignal(signal); };
    check();
    if (typeof text !== 'string') throw failure(400);
    if (!text.trim()) return text;
    const from = language(provider, source, false);
    const to = language(provider, target, true);
    const translatePlain = async (plain: string): Promise<string> => {
        let result = '';
        for (const line of plain.split(/([\r\n]+)/u)) {
            const points = Array.from(line);
            for (let start = 0; start < points.length; start += MAX_CHUNK_CODEPOINTS) {
                check();
                const chunk = points.slice(start, start + MAX_CHUNK_CODEPOINTS).join('');
                const content = chunk.trim();
                if (!content) { result += chunk; continue; }
                const prefix = chunk.slice(0, chunk.indexOf(content));
                const suffix = chunk.slice(prefix.length + content.length);
                const translated = await translateChunk(provider, content, from, to, signal);
                check();
                result += prefix + translated + suffix;
            }
        }
        return result;
    };
    const slots = getTranslationGlossarySourceText(text);
    if (!Array.isArray(slots)) return translatePlain(text);
    const translated: string[] = [];
    for (const slot of slots) translated.push(await translatePlain(slot));
    const nonce = text.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu)![1]!;
    return serializeTranslationSlots(translated, nonce).payload;
}
