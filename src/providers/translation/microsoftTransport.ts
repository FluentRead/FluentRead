/**
 * @file src/providers/translation/microsoftTransport.ts
 * 文件职责：提供可跨浏览器扩展与 Obsidian 复用的微软免费翻译 HTTP 协议。
 * 主要内容：构造批量请求、转义纯文本、校验响应数量并还原译文；实体字面值须在解码后保持原有身份和数量，否则整批拒收，避免服务删改内容后进入展示或缓存。
 * 模块边界：只接收注入的 HTTP 端口，不读取扩展配置或持久化状态；字面值损坏仅抛原生响应错误，由 broker 统一恢复，不在传输层重试或猜测修补。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {createHttpStatusError} from '@/src/platform/http/errors';
import {abortErrorFromSignal, type RuntimeFetch} from '@/src/platform/http/runtime';
import {readNativeBatchJson, translateNativeTextBatch} from './native-batch';
import {NativeBatchResponseError} from '@/src/core/translation/nativeBatch';

const MICROSOFT_TRANSLATE_URL = 'https://edge.microsoft.com/translate/translatetext';

type MicrosoftTranslation = {translations?: Array<{text?: string}>};

function escapeHtmlText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function decodeHtmlText(text: string): string {
    return text
        .replace(/&#(?:0*39);|&#x0*27;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&gt;/gi, '>')
        .replace(/&lt;/gi, '<')
        .replace(/&amp;/gi, '&');
}

function literalEntityCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const match of text.matchAll(/&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/gu)) {
        const entity = match[0];
        counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
    return counts;
}

/** Edge 会把实体名当作正文删改；不能靠再次解码恢复已经丢失的字母。 */
function requireLiteralEntities(source: string, translation: string): void {
    const expected = literalEntityCounts(source);
    if (expected.size === 0) return;
    const actual = literalEntityCounts(translation);
    for (const [entity, count] of expected) {
        if (actual.get(entity) !== count) {
            throw new NativeBatchResponseError('微软翻译未完整保留原文中的实体字面文本');
        }
    }
}

export async function translateMicrosoftTextsWithTransport(
    transport: RuntimeFetch,
    texts: string[],
    fromLang: string,
    toLang: string,
    abortSignal?: AbortSignal,
    enableNativeBatch = true,
): Promise<string[]> {
    if (texts.length === 0) return [];
    if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);

    fromLang = normalizeChineseLanguageCode(fromLang);
    toLang = normalizeChineseLanguageCode(toLang);
    const url = new URL(MICROSOFT_TRANSLATE_URL);
    url.searchParams.set('from', fromLang === 'auto' ? '' : fromLang === 'sr' ? 'sr-Cyrl' : fromLang);
    url.searchParams.set('to', toLang === 'sr' ? 'sr-Cyrl' : toLang);
    url.searchParams.set('isEnterpriseClient', 'false');

    return await translateNativeTextBatch(texts, async sources => {
        const response = await transport(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            // 端点始终运行 HTML 标签对齐器，必须先转义纯文本中的标记字符。
            body: JSON.stringify(sources.map(escapeHtmlText)),
            signal: abortSignal,
        });

        if (!response.ok) throw createHttpStatusError(response, '翻译失败');
        const result = await readNativeBatchJson<MicrosoftTranslation[]>(response, '微软翻译返回的不是有效 JSON', abortSignal);
        if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
        if (!Array.isArray(result) || result.length !== sources.length) return result;
        return result.map((item, index) => {
            const translatedText = Array.isArray(item?.translations) && item.translations.length === 1
                ? item.translations[0]?.text : undefined;
            if (typeof translatedText !== 'string') return translatedText;
            const decoded = decodeHtmlText(translatedText);
            requireLiteralEntities(sources[index]!, decoded);
            return decoded;
        });
    }, abortSignal, '微软翻译返回的批量结果不完整', enableNativeBatch) as string[];
}
