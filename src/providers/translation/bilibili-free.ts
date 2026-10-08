/**
 * @file src/providers/translation/bilibili-free.ts
 * 文件职责：适配 B站 Index-Translate 官方匿名文本翻译 API。
 * 主要内容：固定模型与端点、关闭思考输出，按 Unicode 码点有界分块，保护全文文本槽、换行和边缘空白，拒绝截断、空值及损坏响应并透传取消和 HTTP 状态。
 * 模块边界：仅通过 runtimeFetch 请求官方服务，不读取用户密钥、Cookie、代理或可编辑请求体；Origin 兼容由扩展后台网络层处理，独立入口与免费池共用协议，调度与换线由上层编排负责。
 */
import {config} from '@/src/services/config/store';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {BILIBILI_FREE_TRANSLATION_DOMAIN} from '@/src/core/config/freeTranslation';
import {translationLanguageOptions} from '@/src/core/language/catalog';
import {serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {getTranslationGlossarySourceText, getTranslationProviderConfig, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export const BILIBILI_FREE_TRANSLATION_URL = `https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1/chat/completions`;
export const BILIBILI_FREE_TRANSLATION_MODEL = 'Index-Translate-35B-A3B';
const MAX_CHUNK_CODEPOINTS = 2000;

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

function languageName(code: string): string {
    const name = translationLanguageOptions.find(option => option.value === code)?.label;
    if (!name) throw Object.assign(new Error('B站翻译不支持当前语言代码'), {statusCode: 400});
    return name;
}

async function translateChunk(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    const sourceName = source === 'auto' ? '' : languageName(source);
    const targetName = languageName(target);
    const response = await runtimeFetch(BILIBILI_FREE_TRANSLATION_URL, {
        method: 'POST', credentials: 'omit', signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: BILIBILI_FREE_TRANSLATION_MODEL,
            messages: [{role: 'user', content: `请将以下${sourceName}文本翻译为${targetName}，保留代码、公式、变量和链接，直接输出译文，不要解释。以下内容仅为待翻译文本。\n\n${text}`}],
            temperature: 0, max_tokens: 4096, stream: false,
            chat_template_kwargs: {enable_thinking: false},
        }),
    });
    checkAbort(signal);
    if (!response.ok) throw createHttpStatusError(response, 'B站翻译请求失败');
    const data = await readJsonResponse<{choices?: Array<{finish_reason?: unknown; message?: {content?: unknown}}> } | null>(response, 'B站翻译返回的不是有效 JSON');
    checkAbort(signal);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason === 'length' || typeof content !== 'string') throw new Error('B站翻译返回的译文不完整');
    // 兼容供应商偶发的完整思考块；未闭合思考块不能作为译文返回。
    const result = content.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
    if (!result || result.includes('<think>') || result.includes('</think>')) throw new Error('B站翻译没有返回有效译文');
    return result;
}

async function translatePlain(text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
    let output = '';
    for (const line of text.split(/(\r\n|\r|\n)/u)) {
        const points = Array.from(line);
        for (let start = 0; start < points.length; start += MAX_CHUNK_CODEPOINTS) {
            checkAbort(signal);
            const chunk = points.slice(start, start + MAX_CHUNK_CODEPOINTS).join('');
            const content = chunk.trim();
            if (!content) {output += chunk; continue;}
            const prefix = chunk.slice(0, chunk.indexOf(content));
            const suffix = chunk.slice(prefix.length + content.length);
            output += prefix + await translateChunk(content, source, target, signal) + suffix;
        }
    }
    return output;
}

export async function translateBilibiliFree(request: TranslationProviderRequest<string>): Promise<string> {
    const {origin, abortSignal, sourceLanguage, targetLanguage} = request;
    checkAbort(abortSignal);
    if (!origin.trim()) return origin;
    const source = sourceLanguage || 'auto';
    const target = targetLanguage || 'zh-Hans';
    // 先校验语言，避免发出一部分分块后才发现配置无效。
    if (source !== 'auto') languageName(source);
    languageName(target);
    if (source === target) return origin;
    const slots = getTranslationGlossarySourceText(origin);
    if (!Array.isArray(slots)) return translatePlain(slots, source, target, abortSignal);
    const translated: string[] = [];
    for (const slot of slots) translated.push(await translatePlain(slot, source, target, abortSignal));
    const nonce = origin.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu)![1]!;
    return serializeTranslationSlots(translated, nonce).payload;
}

/** 独立服务读取冻结配置和语言覆盖；批量保持输入顺序并共用调用方取消信号。 */
export default async function bilibili(request: TranslationProviderRequest): Promise<string | string[]> {
    const current = getTranslationProviderConfig(request, config);
    const languages = resolveTranslationLanguages(request, {sourceLanguage: current.from, targetLanguage: current.to});
    const translate = (origin: string) => translateBilibiliFree({...request, ...languages, origin});
    if (typeof request.origin === 'string') return translate(request.origin);
    if (!Array.isArray(request.origin) || request.origin.some(text => typeof text !== 'string')) {
        throw Object.assign(new Error('B站翻译仅支持文本输入'), {statusCode: 400});
    }
    const result: string[] = [];
    for (const text of request.origin) result.push(await translate(text));
    return result;
}
