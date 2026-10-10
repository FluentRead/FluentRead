/**
 * @file src/services/translation/glossaryProtection.ts
 * 文件职责：在统一翻译调用边界保护术语，使机器翻译、AI 与批量请求共用相同的本地回填规则。
 * 主要内容：按冻结范围重新选取条目，文档入口自动保护地址和代码式名称，保持消息和内部槽协议，生成只含占位符的供应商术语约束，校验批量结果形状；纯术语判断统一比较 NFC 写法，实际回填保留原文 Unicode。
 * 模块边界：不自行调用网络或修改配置；缓存、取消、超时与最终结果验证仍由 broker 管理。
 */
import {GlossaryPlaceholderError, protectGlossaryText, resolveGlossaryEntries} from '@/src/core/glossary';
import {findDocumentLiteralTerms} from '@/src/core/translation/public';
import {attachTranslationProviderConfig, getTranslationGlossarySourceText} from './requestSnapshot';
import type {TranslationProviderConfigSnapshot, TranslationRequestMessage} from './types';

export function getGlossaryProtectionEntries(current: TranslationProviderConfigSnapshot, origin: string | string[]) {
    const context = current.glossaryMatchContext;
    if (!context) return [];
    const source = getTranslationGlossarySourceText(origin);
    const entries = current.glossaryTerms?.length ? resolveGlossaryEntries(current.glossaryLibraries ?? [], {...context,
        glossaryIds: context.glossaryIds ? [...context.glossaryIds] : null,
        text: source,
    }).terms : [];
    return context.context === 'document' ? [...entries, ...findDocumentLiteralTerms(source)] : entries;
}

export function prepareGlossaryRequest(message: TranslationRequestMessage, current: TranslationProviderConfigSnapshot) {
    const entries = ('summaryPrompt' in message && message.summaryPrompt) ? [] : getGlossaryProtectionEntries(current, message.origin);
    if (!entries.length) return {message, restore: (result: unknown) => result};
    const originals = Array.isArray(message.origin) ? message.origin : [message.origin];
    const packets = originals.map((text, index) => protectGlossaryText(text, entries, String(index)));
    const tokens = Object.freeze(packets.flatMap(packet => packet.tokens));
    const providerConfig = Object.freeze({...current, glossaryProtectedTokens: tokens});
    return {
        message: attachTranslationProviderConfig({...message,
            origin: Array.isArray(message.origin) ? packets.map(packet => packet.text) : packets[0].text,
            sourceLanguageDetectionText: message.sourceLanguageDetectionText ?? [getTranslationGlossarySourceText(message.origin)].flat().join("\n"),
        }, providerConfig),
        restore(result: unknown) {
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

/** 整段都是用户指定译法时，允许其保持原文或外语；规范化仅用于比较，不改写实际回填。 */
export function isGlossaryOnlyResult(current: TranslationProviderConfigSnapshot, origin: string, result: string): boolean {
    const entries = getGlossaryProtectionEntries(current, origin);
    if (!entries.length) return false;
    const packet = protectGlossaryText(origin, entries);
    let remainder = packet.text;
    for (const token of packet.tokens) remainder = remainder.replace(token, '');
    return !/[\p{L}\p{N}]/u.test(remainder) && packet.restore(packet.text).normalize('NFC') === result.normalize('NFC');
}
