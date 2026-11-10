/**
 * @file src/providers/translation/bilibili-free.ts
 * 文件职责：适配 B站 Index-Translate 官方匿名文本翻译 API。
 * 主要内容：固定模型与端点、关闭思考输出；预算内的多行文本优先整段翻译并恢复原换行，行数不匹配、译文为空或截断时回退到保留术语标记的有界分块。保护文本槽和边缘空白，透传取消和 HTTP 状态，主动终止未读的错误正文。
 * 模块边界：仅通过 runtimeFetch 请求官方服务，不读取用户密钥、Cookie、代理或可编辑请求体；Origin 兼容由扩展后台网络层处理，独立入口与免费池共用协议，调度与换线由上层编排负责。
 */
import {translateFreeTextChunks} from './freeTextChunks';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {BILIBILI_FREE_TRANSLATION_DOMAIN, BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation';
import {translationLanguageOptions} from '@/src/core/language/catalog';
import {rebuildTranslationSlots} from '@/src/core/translation/slotProtocol';
import {getTranslationGlossarySourceSlots, requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {abortErrorFromSignal, cancelUnreadResponseBody, runtimeFetch} from '@/src/platform/http/runtime';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';

export const BILIBILI_FREE_TRANSLATION_URL = `https://${BILIBILI_FREE_TRANSLATION_DOMAIN}/v1/chat/completions`;
export {BILIBILI_FREE_TRANSLATION_MODEL};
const MAX_CHUNK_CODEPOINTS = 2000;

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

function languageName(code: string): string {
    const name = translationLanguageOptions.find(option => option.value === code)?.label;
    if (!name) throw Object.assign(new Error('B站翻译不支持当前语言代码'), {statusCode: 400});
    return name;
}

async function translateChunk(text: string, sourceName: string, targetName: string, signal?: AbortSignal, allowLayoutFallback = false): Promise<string> {
    checkAbort(signal);
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
    try {
        checkAbort(signal);
        if (!response.ok) throw createHttpStatusError(response, 'B站翻译请求失败');
        const data = await readJsonResponse<{choices?: Array<{finish_reason?: unknown; message?: {content?: unknown}}> } | null>(response, 'B站翻译返回的不是有效 JSON');
        checkAbort(signal);
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        // 合并请求达到输出上限时由逐行路径恢复，不使用已截断的译文。
        if (allowLayoutFallback && choice?.finish_reason === 'length') return '';
        if (choice?.finish_reason === 'length' || typeof content !== 'string') throw new Error('B站翻译返回的译文不完整');
        // 兼容供应商偶发的完整思考块；未闭合思考块不能作为译文返回。
        const result = content.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
        if ((!result && !allowLayoutFallback) || result.includes('<think>') || result.includes('</think>')) throw new Error('B站翻译没有返回有效译文');
        return result;
    } finally {
        cancelUnreadResponseBody(response);
    }
}

async function translatePlain(text: string, sourceName: string, targetName: string, signal?: AbortSignal): Promise<string> {
    const content = text.trim();
    if (/[\r\n]/u.test(content) && Array.from(content).length <= MAX_CHUNK_CODEPOINTS) {
        const translation = await translateChunk(content, sourceName, targetName, signal, true);
        const nonemptyLine = /\S[^\r\n]*/gu;
        const translatedLines = translation.match(nonemptyLine);
        if (translatedLines && translatedLines.length === content.match(nonemptyLine)?.length) {
            // 用同一条逐行回填路径恢复源文本空白，不把模型生成的空行写回。
            let index = 0;
            return translateFreeTextChunks(text, text.length, async () => translatedLines[index++]!.trimEnd(), signal);
        }
    }
    return translateFreeTextChunks(text, MAX_CHUNK_CODEPOINTS, chunk => translateChunk(chunk, sourceName, targetName, signal), signal);
}

export async function translateBilibiliFree(request: TranslationProviderRequest<string>): Promise<string> {
    const {origin, abortSignal, sourceLanguage, targetLanguage} = request;
    checkAbort(abortSignal);
    if (!origin.trim()) return origin;
    const source = sourceLanguage || 'auto';
    const target = targetLanguage || 'zh-Hans';
    // 先校验语言，避免发出一部分分块后才发现配置无效。
    const sourceName = source === 'auto' ? '' : languageName(source);
    const targetName = languageName(target);
    if (source === target) return origin;
    const slots = getTranslationGlossarySourceSlots(origin);
    if (!slots) return translatePlain(origin, sourceName, targetName, abortSignal);
    const translated: string[] = [];
    for (const slot of slots.texts) translated.push(await translatePlain(slot, sourceName, targetName, abortSignal));
    const result = rebuildTranslationSlots(slots.packet, translated);
    if (result === null) throw new Error('B站翻译返回的文本槽结构无效');
    return result;
}

/** 独立服务读取冻结配置和语言覆盖；批量保持输入顺序并共用调用方取消信号。 */
export default async function bilibili(request: TranslationProviderRequest): Promise<string | string[]> {
    const current = requireTranslationProviderConfig(request);
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
