/**
 * @file src/services/translation/glossaryProtection.ts
 * 文件职责：在统一翻译调用边界保护术语，使机器翻译、AI 与批量请求共用相同的本地回填规则。
 * 主要内容：按冻结范围选取用户与自动条目，网页保留常用技术术语，文档保护地址、代码式名称及有限相邻数学表达式；内部 g 标签原样送翻并避开用户短词匹配，保持消息和内部槽协议，按实际目标语言校验批量形状、行内结构和未翻译正文；纯术语判断比较 NFC 写法，实际回填保留原文 Unicode；userscript 编译时移除不支持的文档专属路径。
 * 模块边界：不自行调用网络或修改配置；缓存、取消、超时与最终结果验证仍由 broker 管理。
 * 字素保护：先处理用户与自动术语，再对剩余完整 emoji 叠加同一占位符协议；摘要不强制保留，用户译法优先且未配置词库的翻译也受保护。兼容重试仅接受无用户术语和结构标记的单行正文，检查 emoji 字素顺序及默认术语的原写法和次数。
 */
import {findGlossaryMatches, GlossaryPlaceholderError, protectGlossaryText, resolveGlossaryEntries, type GlossaryProtectionEntry} from '@/src/core/glossary';
import {hasOnlyCommonWebTerms, matchCommonWebTerms} from '@/src/core/glossary/commonWebTerms';
import {DocumentInlineMarkerError, documentInlineMarkerRanges, normalizeDocumentInlineMarkers, validateDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import {findDocumentLiteralTerms} from '@/src/core/translation/documentLiterals';
import {protectDocumentMathText} from '@/src/core/translation/documentMathProtection';
import {findEmojiLiteralRanges, hasEmojiLiterals} from '@/src/core/translation/emojiLiterals';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {attachTranslationProviderConfig, getTranslationGlossarySourceSlots, getTranslationGlossarySourceText} from './requestSnapshot';
import type {TranslationProviderConfigSnapshot, TranslationRequestMessage} from './types';

function getGlossaryProtectionPlan(current: TranslationProviderConfigSnapshot, origin: string | string[]): {
    entries: GlossaryProtectionEntry[]; automatic: GlossaryProtectionEntry[];
} {
    const context = current.glossaryMatchContext;
    if (!context) return {entries: [], automatic: []};
    const source = getTranslationGlossarySourceText(origin);
    const entries = current.glossaryTerms?.length ? resolveGlossaryEntries(current.glossaryLibraries ?? [], {...context,
        glossaryIds: context.glossaryIds ? [...context.glossaryIds] : null,
        text: source,
    }).terms : [];
    const automatic = context.preserveCommonWebTerms ? matchCommonWebTerms(source, entries)
        : import.meta.env.BROWSER !== 'userscript' && context.context === 'document'
            ? findDocumentLiteralTerms(source, entries) : [];
    return {entries: [...entries, ...automatic], automatic};
}

export function getGlossaryProtectionEntries(current: TranslationProviderConfigSnapshot, origin: string | string[]) {
    return getGlossaryProtectionPlan(current, origin).entries;
}

/** 独立术语直接复用原文；显式用户译法仍走原有翻译路径。 */
export function shouldKeepCommonWebTermLabel(current: TranslationProviderConfigSnapshot, origin: string): boolean {
    return Boolean(current.glossaryMatchContext?.preserveCommonWebTerms && hasOnlyCommonWebTerms(origin)
        && (!current.glossaryTerms?.length || isGlossaryOnlyResult(current, origin, origin)));
}

export function prepareGlossaryRequest(message: TranslationRequestMessage, current: TranslationProviderConfigSnapshot) {
    const targetLanguage = message.targetLanguage?.trim() || current.to;
    const documentContext = import.meta.env.BROWSER !== 'userscript' && current.glossaryMatchContext?.context === 'document';
    const summary = Boolean('summaryPrompt' in message && message.summaryPrompt);
    const plan = summary ? {entries: [], automatic: []} : getGlossaryProtectionPlan(current, message.origin);
    if (!plan.entries.length && (summary || !hasEmojiLiterals(message.origin))) return {message: documentContext
        ? attachTranslationProviderConfig({...message}, current) : message,
        restore: (result: unknown) => validateDocumentTranslationResult(current, message.origin, result, targetLanguage)};
    const originals = Array.isArray(message.origin) ? message.origin : [message.origin];
    const packets = originals.map((text, index) => {
        const terms = documentContext
            ? protectDocumentMathText(text, plan.entries, plan.automatic, String(index), documentInlineMarkerRanges(text))
            : protectGlossaryText(text, plan.entries, String(index));
        const ranges = findEmojiLiteralRanges(terms.text);
        if (!ranges.length) return terms;
        const literals = protectGlossaryText(terms.text, [], `emoji-${index}`, [], undefined, ranges);
        return {text: literals.text, tokens: [...terms.tokens, ...literals.tokens],
            restore: (result: unknown) => terms.restore(literals.restore(result))};
    });
    const tokens = Object.freeze(packets.flatMap(packet => packet.tokens));
    const providerConfig = Object.freeze({...current, glossaryProtectedTokens: tokens});
    return {
        message: attachTranslationProviderConfig({...message,
            origin: Array.isArray(message.origin) ? packets.map(packet => packet.text) : packets[0].text,
            sourceLanguageDetectionText: message.sourceLanguageDetectionText ?? [getTranslationGlossarySourceText(message.origin)].flat().join("\n"),
        }, providerConfig),
        restore(result: unknown) {
            result = validateDocumentTranslationResult(current, message.origin, result, targetLanguage, tokens);
            if (!Array.isArray(message.origin)) return packets[0].restore(result);
            if (!Array.isArray(result) || result.length !== packets.length) throw new GlossaryPlaceholderError();
            return result.map((value, index) => {
                if (typeof value === 'string' && tokens.some(token => !packets[index].tokens.includes(token) && value.includes(token))) {
                    throw new GlossaryPlaceholderError();
                }
                return packets[index].restore(value);
            });
        },
    };
}

const reservedProtectionMarker = /FRTERM|FRCODE|___FLUENTREAD_|<\/?g[1-9]\d*(?:\s|\/?>)/iu;

/** 占位符校验失败时只允许普通正文使用原始 emoji 再试，结构与术语仍走原有严格校验。 */
export function prepareLiteralEmojiRetry(message: TranslationRequestMessage, current: TranslationProviderConfigSnapshot) {
    const {origin} = message;
    if (typeof origin !== 'string' || current.glossaryMatchContext?.context === 'document'
        || /[\r\n]/u.test(origin) || reservedProtectionMarker.test(origin)) return undefined;
    const original = findEmojiLiteralRanges(origin).map(range => origin.slice(range.start, range.end));
    if (!original.length || !/\p{L}/u.test(origin)) return undefined;
    const {entries, automatic} = getGlossaryProtectionPlan(current, origin);
    if (entries.length !== automatic.length) return undefined;
    const commonTerms = (value: string) => automatic.length
        ? findGlossaryMatches(value, automatic).map(match => match.entry.source).sort().join(' ') : '';
    const expectedTerms = commonTerms(origin);
    return (result: unknown): string => {
        if (typeof result !== 'string' || !/\p{L}/u.test(result) || reservedProtectionMarker.test(result)) {
            throw new GlossaryPlaceholderError();
        }
        const actual = findEmojiLiteralRanges(result);
        if (actual.length !== original.length
            || actual.some((range, index) => result.slice(range.start, range.end) !== original[index])
            || commonTerms(result) !== expectedTerms) {
            throw new GlossaryPlaceholderError();
        }
        return result;
    };
}

/** 免费候选与所有 provider 的最终恢复共用同一文档契约；序列化批次按原槽分别验证编号。 */
export function validateDocumentTranslationResult(current: TranslationProviderConfigSnapshot, origin: string | string[], result: unknown,
    targetLanguage = current.to, protectedTokens = current.glossaryProtectedTokens): unknown {
    if (import.meta.env.BROWSER === 'userscript' || current.glossaryMatchContext?.context !== 'document') return result;
    if (Array.isArray(origin)) {
        if (!Array.isArray(result) || result.length !== origin.length) throw new DocumentInlineMarkerError();
        return result.map((value, index) => validateDocumentTranslationResult(current, origin[index]!, value, targetLanguage, protectedTokens));
    }
    const slots = getTranslationGlossarySourceSlots(origin);
    const inlineContext = {targetLanguage, protectedTokens};
    if (!slots || !slots.texts.some(text => documentInlineMarkerRanges(text).length)) return validateDocumentInlineMarkers(origin, result, inlineContext);
    if (typeof result !== 'string') throw new DocumentInlineMarkerError();
    const values = parseTranslationSlots(slots.packet, normalizeDocumentInlineMarkers(result));
    if (!values) throw new DocumentInlineMarkerError();
    const translated = values.map((value, index) => validateDocumentInlineMarkers(slots.texts[index]!, value, inlineContext) as string);
    const nonce = slots.packet.starts[0]!.slice('___FLUENTREAD_'.length, -'_0_BEGIN___'.length);
    return serializeTranslationSlots(translated, nonce).payload;
}

/** 整段都是用户指定译法时，允许其保持原文或外语；规范化仅用于比较，不改写实际回填。 */
export function isGlossaryOnlyResult(current: TranslationProviderConfigSnapshot, origin: string, result: string): boolean {
    const entries = getGlossaryProtectionEntries(current, origin);
    if (!entries.length) return false;
    const packet = protectGlossaryText(origin, entries, '0', import.meta.env.BROWSER !== 'userscript'
        && current.glossaryMatchContext?.context === 'document' ? documentInlineMarkerRanges(origin) : []);
    let remainder = packet.text;
    for (const token of packet.tokens) remainder = remainder.replace(token, '');
    // g 是本地恢复的格式语法；不能把标签名当成用户指定词之外尚未翻译的英文正文。
    if (import.meta.env.BROWSER !== 'userscript' && current.glossaryMatchContext?.context === 'document') remainder = remainder.replace(/<\/?g[1-9]\d*\/?\s*>/gu, '');
    return !/[\p{L}\p{N}]/u.test(remainder) && packet.restore(packet.text).normalize('NFC') === result.normalize('NFC');
}
