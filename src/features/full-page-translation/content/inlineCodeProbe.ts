/**
 * @file src/features/full-page-translation/content/inlineCodeProbe.ts
 * 文件职责：封装含受保护行内代码句子的整句试探翻译逻辑，校验字节预算、标记一致性、源语稳定性与术语保护边界。
 * 主要内容：在不读取 DOM 与页面上下文的前提下校验代码占位符序列，确认术语与语言识别不受标记干扰后发起单次校验翻译，遇内容结构不兼容错误安全回退为逐槽翻译。
 * 模块边界：仅提供无 DOM 副作用的整句试探函数，不持有会话槽缓存或修改网页节点；调用方负责骨架编码与解码校验。
 */
import {config} from '@/src/services/config/store';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {protectGlossaryText} from '@/src/core/glossary';
import {matchCommonWebTerms} from '@/src/core/glossary/commonWebTerms';
import {translateText} from '@/src/services/translation/client';
import {TranslationRequestError} from '@/src/services/translation/errors';
import {shouldSkipTranslationWithEvidence} from '@/src/services/translation/languagePreflight';
import {hasEmojiLiterals} from '@/src/core/translation/emojiLiterals';
import type {TranslationQueueSession} from '@/src/services/translation/queue';
import {copyFullPageTranslationConfigSnapshot, type FullPageTranslationConfigSnapshot} from './translationConfigSnapshot';
import {
    createSnapshotTranslateOptions,
    readGlossaryRevision,
    throwIfAborted,
} from './requestCache';

const INLINE_CODE_PROBE_MAX_BYTES = 450;

/**
 * 受保护行内代码的整句试探。只发送调用方提供的标记化正文，不读取 DOM、
 * 页面上下文或代码文字。结果必须经调用方的当前骨架与标记校验后才能使用。
 * 这条路径不参与会话槽缓存，后台只缓存经同一标记协议验证的结果；不符合条件时沿用逐槽路径。
 */
export async function tryTranslateInlineCodeSentence(
    source: string,
    decode: (result: string) => string[] | null,
    snapshot: FullPageTranslationConfigSnapshot,
    signal?: AbortSignal,
    queueSession?: TranslationQueueSession,
    isCurrent?: () => boolean,
): Promise<string[] | null> {
    throwIfAborted(signal);
    snapshot = copyFullPageTranslationConfigSnapshot(snapshot);
    // 隐式正文或篇章上下文可能包含受保护代码，不能用于这次试探。
    // 部分免费线路按 UTF-8 字节限制请求；保留 50 字节余量，避免试探被拆开标记。
    if (snapshot.enableAIContext || source.length > INLINE_CODE_PROBE_MAX_BYTES ||
        new TextEncoder().encode(source).length > INLINE_CODE_PROBE_MAX_BYTES || hasEmojiLiterals(source) ||
        (isCurrent && !isCurrent())) return null;
    const markerPattern = /__FRCODE_([a-f0-9]{16})_(0|[1-9]\d*)__/gu;
    const matches = [...source.matchAll(markerPattern)];
    if (!matches.length || matches.some((match, index) =>
        match[1] !== matches[0]![1] || Number(match[2]) !== index)) return null;
    const detectionText = source.replace(markerPattern, ' ');
    if (/__FRCODE/iu.test(detectionText) || !detectionText.trim()) return null;
    // 按叠加默认术语占位符后的载荷检查上游预算和 auto 识别，仍用原文构造实际请求。
    const terms = matchCommonWebTerms(detectionText);
    const providerSource = terms.length ? protectGlossaryText(source, terms).text : source;
    if (terms.length && new TextEncoder().encode(providerSource).length > INLINE_CODE_PROBE_MAX_BYTES) return null;

    // 部分 provider（如 MyMemory）会对标记化请求重新自动识别源语言。
    // 只有标记前后都可靠且一致时才试探，不能更改用户的 auto 设置来掩盖差异。
    if (snapshot.sourceLanguage.trim().toLowerCase() === 'auto') {
        const plainLanguage = identifyTextLanguage(detectionText);
        const taggedLanguage = identifyTextLanguage(providerSource);
        if (plainLanguage.status !== 'identified' || taggedLanguage.status !== 'identified' ||
            plainLanguage.languages.length !== 1 || taggedLanguage.languages.length !== 1 ||
            plainLanguage.languages[0] !== taggedLanguage.languages[0]) return null;
    }

    // 术语占位会扩张请求，可能使供应商拆开代码标记；若任一启用词条
    // 可能命中，保守沿用现有逐槽请求。版本变化同样禁止试探。
    const glossaryRequiresProtection = (): boolean => {
        if (!snapshot.glossaryRevision || snapshot.glossaryRevision !==
            readGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled)) return true;
        if (!config.glossaryEnabled) return false;
        const entries = config.glossaryLibraries.filter(library => library.enabled)
            .flatMap(library => library.entries.map(entry => ({source: entry.source, target: entry.target,
                caseSensitive: entry.caseSensitive})));
        // 为避免长词遮蔽，逐条使用后台相同的保护算法；大词库直接回退。
        if (entries.length > 64) return true;
        return entries.some(entry => protectGlossaryText(source, [entry]).tokens.length > 0);
    };
    if (glossaryRequiresProtection() || shouldSkipTranslationForTarget(detectionText, snapshot.targetLanguage, snapshot.excludedLanguages)) return null;
    if (await shouldSkipTranslationWithEvidence(detectionText, snapshot.targetLanguage, snapshot.excludedLanguages, signal)) {
        throwIfAborted(signal);
        return null;
    }
    throwIfAborted(signal);
    if ((isCurrent && !isCurrent()) || glossaryRequiresProtection()) return null;
    // 不复用普通 session 缓存；后台使用独立协议键并在读取与写入时验证结果。
    let translated: string;
    try {
        translated = await translateText(source, '', createSnapshotTranslateOptions(snapshot, {
            signal, queueSession, validateInlineCodeTranslation: true, skipLanguageDetection: true,
            sourceLanguageDetectionText: detectionText,
        }));
    } catch (error) {
        throwIfAborted(signal);
        // 仅已跨后台协议确认的内容校验错误可退回逐槽；网络、鉴权、配额、
        // 不明确的错误以及取消必须原样传播，不能伪装成结构不兼容。
        if (error instanceof TranslationRequestError && (
            (error.kind === 'response' && ['UNTRANSLATED_RESPONSE', 'WRONG_LANGUAGE_RESPONSE',
                'TRANSLATION_SLOT_RESPONSE_INVALID'].includes(error.code ?? '')) ||
            ((error.kind === 'unknown' || error.kind === 'response') && error.code === 'GLOSSARY_PLACEHOLDER_INVALID')
        )) return null;
        throw error;
    }
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) return null;
    return decode(translated);
}
