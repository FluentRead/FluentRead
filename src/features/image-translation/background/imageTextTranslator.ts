/**
 * @file src/features/image-translation/background/imageTextTranslator.ts
 * 文件职责：封装图片 OCR 识别文本的语种识别、语境构造、有界分批与并发回退翻译流水线。
 * 主要内容：实现整图源语判定、邻近区域语境与篇章上下文组装、AI 多段切分与异常降级至有界并发工作池、原生批量翻译及严格原行位置回填。
 * 模块边界：通过注入的翻译与术语依赖执行文本翻译编排，不直接访问浏览器扩展存储、Offscreen 文档或后台消息路由。
 */
import {createImageTranslationFailure} from '../failure';
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {FUNCTION_WORDS} from '@/src/core/language/lexicon';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {segmentScriptWords, type ScriptWord} from '@/src/core/language/scripts';
import {hasTranslatableText} from '@/src/core/translation/resultValidation';
import {buildGlossaryRevision, resolveGlossaryEntries, type GlossaryLibrary} from '@/src/core/glossary';
import {
    attachTranslationRequestControl,
    attachTranslationGlossaryContext,
    getTranslationGlossaryContext,
    markTranslationRemainingBudget,
    allowUnchangedTranslationResult,
    markImageTextBatch,
} from '@/src/services/translation/requestSnapshot';
import {
    getErrorMessage,
    imageAbortError,
    parseRequiredString,
    type ImageOperationOptions,
} from './operationRegistry';

export const IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE = 'fluentReadImageTranslateTexts' as const;
export const IMAGE_TEXT_TRANSLATION_TIMEOUT_MS = 120_000;

export interface ImageTranslateTextsMessage {
    type: typeof IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE;
    texts?: unknown;
    /** 仅接收组合根验证过的 Offscreen 同栏标签位置。 */
    imageLabelSlots?: unknown;
    title?: unknown;
    requestId?: unknown;
    timeoutMs?: unknown;
    /** 仅在组合根附加的内部术语上下文存在时读取，普通 runtime 字段本身不构成信任。 */
    glossaryRevision?: unknown;
    sourceLanguage?: unknown;
    manga?: unknown;
}

type ImageTextTranslationRequestBase = {
    context: string;
    pageContext: string;
    useCache: true;
    serviceOverride: string;
    requestTimeoutMs: number;
    sourceLanguageDetectionText?: string;
    glossaryRevision?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    discourseContext?: string;
    enableAIContext?: true;
    aiMultiSegment?: true;
    mangaContext?: true;
};

export type ImageTextTranslationRequest = ImageTextTranslationRequestBase & (
    | {origin: string}
    | {origin: string[]}
);

export interface ImageTextTranslationDependencies {
    readonly getTranslationService: () => string;
    readonly supportsBatchTranslation: (service: string) => boolean;
    readonly supportsNativeBatch?: (service: string) => boolean;
    readonly supportsAIMultiSegment?: (service: string) => boolean;
    readonly isTextContextEnabled?: (service: string) => boolean;
    readonly getGlossaryConfig?: () => {glossaryEnabled: boolean; glossaryLibraries: GlossaryLibrary[]; from: string; to: string};
    readonly translateTexts: (request: ImageTextTranslationRequest) => Promise<string | string[]>;
    readonly now?: () => number;
}

/** 单段供应商保留同图相邻段落作为有界参考；不拼入待译正文，也不触发额外摘要请求。 */
function imageTextContext(texts: string[], index: number, title: string): string {
    const start = Math.max(0, index - 2);
    const nearby = texts.slice(start, index + 3)
        .filter((_value, offset) => start + offset !== index).map(value => value.slice(0, 480));
    if (!nearby.length) return title;
    return [title.slice(0, 320), 'Other text from the same image (reference only):', ...nearby].filter(Boolean).join('\n');
}

/** 每个邻段同时限制原文长度和 JSON 编码长度，保留完整 Unicode 码点。 */
function imageContextSnippet(text: string): string {
    let value = '', encodedLength = 0;
    for (const character of text) {
        const encoded = JSON.stringify(character).length - 2;
        if (value.length + character.length > 240 || encodedLength + encoded > 384) break;
        value += character;
        encodedLength += encoded;
    }
    return value;
}

/** 使用原图位置选邻文；同一句话在不同气泡出现时不得复用第一次出现处的语境。 */
function imageTextDiscourse(texts: string[], sourceIndex: number, manga = false): string {
    const neighbors = [];
    for (let index = Math.max(0, sourceIndex - 2); index <= Math.min(texts.length - 1, sourceIndex + 2); index++) {
        if (index !== sourceIndex) neighbors.push({region: index + 1, text: imageContextSnippet(texts[index])});
    }
    return neighbors.length
        ? JSON.stringify({source: manga ? 'neighboring manga OCR' : 'neighboring image OCR', currentRegion: sourceIndex + 1, neighbors})
        : '';
}

const NUMBERED_UPPERCASE_LABEL_PATTERN = /^[A-Z]{4,40}(?:[ \t]{1,8}[A-Z]{4,40}){1,5}[ \t]{1,8}\d{1,4}$/u;
const NUMBERED_TITLE_LABEL_PATTERN = /^[A-Z][a-z]{2,19}[ \t]{1,4}\d{1,3}$/u;
const IMAGE_PAGE_CONTEXT_PREFIX = 'Page title: ';
const IMAGE_PAGE_CONTEXT_LIMIT = 240;
const AI_MULTI_SEGMENT_MAX_REGIONS = 24;
const AI_MULTI_SEGMENT_MAX_CHARS = 3500;
const AI_MULTI_SEGMENT_FALLBACK_CODES = new Set([
    'AI_MULTI_SEGMENT_RESPONSE_INVALID',
    'AI_MULTI_SEGMENT_REPAIR_FAILED',
    'TRANSLATION_SLOT_RESPONSE_INVALID',
]);

/** 两至六个较长全大写词和独立编号，或首字母大写常用标签加独立序号整数也可能是界面/文档说明；语法不能证明它是型号。
 * 保留短缩写、连写/带连接符或小数版本的原过滤，仅放行这一有界歧义；不猜词义或改写源文字。
 */
function hasImageTranslationText(text: string): boolean {
    const trimmed = text.trim();
    return hasTranslatableText(text)
        || NUMBERED_UPPERCASE_LABEL_PATTERN.test(trimmed)
        || NUMBERED_TITLE_LABEL_PATTERN.test(trimmed);
}

/** 构造严格不超过 broker 直接透传上限（240 字符）的页面标题语境，不触发额外页面摘要请求。 */
function formatImagePageContext(title: string): string {
    const normalized = title.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
    if (!normalized) return '';
    let value = IMAGE_PAGE_CONTEXT_PREFIX;
    for (const character of normalized) {
        if (value.length + character.length > IMAGE_PAGE_CONTEXT_LIMIT) break;
        value += character;
    }
    return value;
}

/** 将有序图片区域切分为有界的 AI 多段批次，使常见对话框在单次连贯调用中完成。 */
function chunkImageMultiSegmentRegions(texts: readonly string[]): Array<{start: number; texts: string[]}> {
    const chunks: Array<{start: number; texts: string[]}> = [];
    let current: {start: number; texts: string[]; chars: number} | undefined;
    for (let index = 0; index < texts.length; index++) {
        const text = texts[index]!;
        if (!current || current.texts.length >= AI_MULTI_SEGMENT_MAX_REGIONS
            || current.chars + text.length > AI_MULTI_SEGMENT_MAX_CHARS) {
            current = {start: index, texts: [], chars: 0};
            chunks.push(current);
        }
        current.texts.push(text);
        current.chars += text.length;
    }
    return chunks;
}

function isAIMultiSegmentFallbackError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {name?: unknown; code?: unknown};
    return candidate.name === 'AIMultiSegmentResponseError'
        || (typeof candidate.code === 'string' && AI_MULTI_SEGMENT_FALLBACK_CODES.has(candidate.code));
}

const NON_ENGLISH_LATIN_LEXICONS = Object.entries(FUNCTION_WORDS.Latin)
    .filter(([language]) => language !== 'en')
    .map(([, lexicon]) => lexicon);

function isCompatibleImageWritingFamily(words: readonly ScriptWord[]): boolean {
    const scripts = new Set(words.map(word => word.script));
    if (scripts.size === 1) return true;
    return scripts.size === 2 && scripts.has('Han') && (scripts.has('Kana') || scripts.has('Hangul'));
}

function isConservativeEnglishUiFallback(words: readonly ScriptWord[]): boolean {
    if (words.length < 4 || words.some(word => /[^A-Za-z']/u.test(word.text))) return false;
    const asciiLetters = words.reduce((sum, word) => sum + word.letters, 0);
    if (asciiLetters < 20) return false;
    const lowered = new Set(words.map(word => word.text.toLowerCase()));
    let enHits = 0;
    for (const word of lowered) {
        if (FUNCTION_WORDS.Latin.en.has(word)) enHits += 1;
    }
    return !NON_ENGLISH_LATIN_LEXICONS.some(lexicon => {
        let nonEnHits = 0;
        for (const word of lowered) {
            if (!FUNCTION_WORDS.Latin.en.has(word) && lexicon.has(word)) nonEnHits += 1;
        }
        return nonEnHits > enHits;
    });
}

/** 识别兼容书写体系的整图源语；auto 模式下为所有服务固定可靠源语（含纯 ASCII 英文界面短语兜底），防止孤立短词被误判。 */
function detectImageSourceLanguage(
    imageDetectionText: string,
    configuredSourceLanguage: string | undefined,
    targetLanguage: string | undefined,
): {identified: boolean; pinned?: string} {
    const words = segmentScriptWords(imageDetectionText)
        .filter(word => !(word.script === 'Greek' && word.text.length === 1));
    if (!isCompatibleImageWritingFamily(words)) return {identified: false};
    const imageLanguage = identifyTextLanguage(imageDetectionText);
    const identified = imageLanguage.status === 'identified';
    if (configuredSourceLanguage !== 'auto') return {identified};
    const normalizedTarget = targetLanguage ? normalizeChineseLanguageCode(targetLanguage) : undefined;
    if (identified) {
        const pinned = !normalizedTarget || !imageLanguage.languages.includes(normalizedTarget)
            ? imageLanguage.languages[0] : undefined;
        return {identified: true, pinned};
    }
    const pinned = imageLanguage.status === 'unknown'
        && imageLanguage.bestGuess === 'en'
        && normalizedTarget !== 'en'
        && isConservativeEnglishUiFallback(words)
        ? 'en' : undefined;
    return {identified: false, pinned};
}

export async function translateImageTexts(
    texts: string[],
    title: string,
    dependencies: ImageTextTranslationDependencies,
    options: ImageOperationOptions,
    message: ImageTranslateTextsMessage,
): Promise<{translations: string[]; targetLanguage?: string}> {
    if (options.signal.aborted) throw imageAbortError(false);
    const glossaryContext = getTranslationGlossaryContext(message);
    const isManga = Boolean(glossaryContext) && message.manga === true;
    const sourceLanguage = glossaryContext ? parseRequiredString(message.sourceLanguage, 'sourceLanguage') : undefined;
    const glossaryConfig = dependencies.getGlossaryConfig?.();
    const targetLanguage = glossaryConfig?.to;
    // 返回用于这次翻译的目标语言。排版阶段不再读取可能已被修改的设置。
    const language = targetLanguage ? {targetLanguage} : {};
    const glossaryRevision = glossaryContext ? parseRequiredString(message.glossaryRevision, 'glossaryRevision') : undefined;
    // OCR 事务冻结的词库版本仍须经过 broker 校验；期间关闭或删除词库不能被同目标早退吞掉。
    const glossaryChanged = glossaryRevision !== undefined && glossaryConfig !== undefined
        && glossaryRevision !== buildGlossaryRevision(glossaryConfig.glossaryLibraries, glossaryConfig.glossaryEnabled);
    const uniqueTexts = [...new Set(texts)].filter(text => {
        const hasExplicitGlossary = glossaryConfig?.glossaryEnabled && resolveGlossaryEntries(glossaryConfig.glossaryLibraries, {
            text, sourceLanguage: sourceLanguage ?? glossaryConfig.from, targetLanguage: glossaryConfig.to,
            pageUrl: glossaryContext?.pageUrl,
        }).terms.length > 0;
        if (hasExplicitGlossary) return true;
        return hasImageTranslationText(text)
            && (!targetLanguage || glossaryChanged || !shouldSkipTranslationForTarget(text, targetLanguage));
    });
    // 不删 OCR 行，阅读面板与图片坐标仍以原行对齐；纯标识整图无需外发请求。
    if (uniqueTexts.length === 0) return {translations: [...texts], ...language};
    const service = dependencies.getTranslationService();
    const useImageContext = dependencies.isTextContextEnabled?.(service) === true;
    const useAIMultiSegment = dependencies.supportsAIMultiSegment?.(service) === true;
    const useNativeBatch = dependencies.supportsNativeBatch
        ? dependencies.supportsNativeBatch(service)
        : dependencies.supportsBatchTranslation(service);
    const batchTranslation = !useAIMultiSegment && useNativeBatch && !useImageContext;
    const orderedRegions = useAIMultiSegment || useImageContext || (service === 'google' && batchTranslation);
    const workerConcurrency = dependencies.supportsNativeBatch || dependencies.supportsAIMultiSegment
        ? 6
        : (isManga && useImageContext ? 4 : 3);
    const imagePageContext = useImageContext && dependencies.supportsAIMultiSegment !== undefined
        ? formatImagePageContext(title)
        : '';
    const translatedSources = new Set(uniqueTexts);
    const sourceIndexes = orderedRegions ? texts.flatMap((text, index) => translatedSources.has(text) ? [index] : []) : [];
    const requestTexts = orderedRegions ? sourceIndexes.map(index => texts[index]) : uniqueTexts;
    const slots = message.imageLabelSlots;
    const candidates = service === 'google' && Array.isArray(slots) && slots.length <= texts.length ? new Set(slots) : undefined;
    const imageLabelSlots = candidates && sourceIndexes.flatMap((index, position) => {
        if (!candidates.has(index)) return [];
        const hasPrev = sourceIndexes[position - 1] === index - 1;
        const hasNext = sourceIndexes[position + 1] === index + 1;
        return (hasPrev && hasNext) || (hasPrev && candidates.has(index - 1)) || (hasNext && candidates.has(index + 1))
            ? [position] : [];
    });
    const imageDetectionText = uniqueTexts.join('\n');
    // 只借用可靠、单一文字体系的同图上下文；混合语种不能把短外语词误判成目标语言而漏译。
    const imageSourceLanguage = detectImageSourceLanguage(imageDetectionText, sourceLanguage ?? glossaryConfig?.from, targetLanguage);
    const useImageDetectionText = service === 'localTranslation' && imageSourceLanguage.identified;
    const effectiveSourceLanguage = imageSourceLanguage.pinned ?? sourceLanguage;
    const now = dependencies.now ?? (() => performance.now());
    const deadline = now() + Math.min(options.timeoutMs, IMAGE_TEXT_TRANSLATION_TIMEOUT_MS);
    const baseRequest = {
        context: title,
        pageContext: '',
        useCache: true as const,
        serviceOverride: service,
        ...language,
        ...(effectiveSourceLanguage ? {sourceLanguage: effectiveSourceLanguage} : {}),
        ...(glossaryContext ? {glossaryRevision} : {}),
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal.aborted) abort();
    options.signal.addEventListener('abort', abort, {once: true});
    const remainingBudget = () => {
        if (controller.signal.aborted) throw imageAbortError(false);
        const remaining = Math.floor(deadline - now());
        if (remaining <= 0) throw new Error('图片文字翻译总时间已耗尽');
        return remaining;
    };
    const controlledRequest = <T extends ImageTextTranslationRequest>(request: T) => {
        if ((service === 'google' || service === 'freeTranslation') && Array.isArray(request.origin)) {
            markImageTextBatch(request, service === 'google' ? imageLabelSlots : undefined);
        }
        const controlled = attachTranslationRequestControl(allowUnchangedTranslationResult(markTranslationRemainingBudget(request)), {
            signal: controller.signal, ownershipKey: `image:${options.requestId}`,
        });
        return glossaryContext ? attachTranslationGlossaryContext(controlled, glossaryContext) : controlled;
    };
    const translateRegionsWithWorkers = async (
        regionIndexes: readonly number[], target: string[], withDiscourseContext: boolean,
    ) => {
        let cursor = 0;
        let failed = false;
        // 并发窗口受限于 workerConcurrency，实际供应商并发仍由共享 broker 限流；有语境的重复文本按位置处理。
        const worker = async () => {
            while (cursor < regionIndexes.length && !failed) {
                const index = regionIndexes[cursor++]!;
                const sourceIndex = orderedRegions ? sourceIndexes[index] : texts.indexOf(requestTexts[index]);
                try {
                    const translation = await dependencies.translateTexts(controlledRequest({
                        ...baseRequest, origin: requestTexts[index], requestTimeoutMs: remainingBudget(),
                        context: imageTextContext(texts, sourceIndex, title),
                        ...(withDiscourseContext ? {
                            pageContext: imagePageContext,
                            enableAIContext: true as const,
                            discourseContext: imageTextDiscourse(texts, sourceIndex, isManga),
                            ...(isManga ? {mangaContext: true as const} : {}),
                        } : {}),
                        ...(useImageDetectionText && identifyTextLanguage(requestTexts[index]).status === 'unknown'
                            ? {sourceLanguageDetectionText: imageDetectionText} : {}),
                    }));
                    if (typeof translation !== 'string') throw new Error('provider 未返回字符串译文');
                    if (!translation.trim()) throw new Error('provider 返回空白译文');
                    target[index] = translation;
                } catch (error) {
                    failed = true;
                    controller.abort();
                    throw createImageTranslationFailure(`图片第 ${sourceIndex + 1} 段文字翻译失败：${getErrorMessage(error)}`, error);
                }
            }
        };
        await Promise.all(Array.from({length: Math.min(workerConcurrency, regionIndexes.length)}, worker));
    };
    try {
        let translations: string[];
        if (useAIMultiSegment) {
            translations = new Array<string>(requestTexts.length);
            for (const chunk of chunkImageMultiSegmentRegions(requestTexts)) {
                try {
                    const result = await dependencies.translateTexts(controlledRequest({
                        ...baseRequest,
                        origin: chunk.texts,
                        pageContext: imagePageContext,
                        aiMultiSegment: true as const,
                        ...(useImageContext ? {enableAIContext: true as const, ...(isManga ? {mangaContext: true as const} : {})} : {}),
                        requestTimeoutMs: remainingBudget(),
                    }));
                    if (!Array.isArray(result) || result.length !== chunk.texts.length
                        || !result.every(value => typeof value === 'string' && value.trim())) {
                        throw Object.assign(new Error('provider 未返回等长非空字符串数组'), {code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});
                    }
                    result.forEach((value, offset) => {translations[chunk.start + offset] = value;});
                } catch (error) {
                    if (!controller.signal.aborted && isAIMultiSegmentFallbackError(error)) {
                        const chunkIndexes = Array.from({length: chunk.texts.length}, (_, offset) => chunk.start + offset);
                        await translateRegionsWithWorkers(chunkIndexes, translations, useImageContext);
                        continue;
                    }
                    throw createImageTranslationFailure(`图片文字批量翻译失败：${getErrorMessage(error)}`, error);
                }
            }
        } else if (batchTranslation) {
            try {
                const result = await dependencies.translateTexts(controlledRequest({
                    ...baseRequest, origin: requestTexts, requestTimeoutMs: remainingBudget(),
                }));
                if (!Array.isArray(result) || result.length !== requestTexts.length
                    || !result.every(value => typeof value === 'string' && value.trim())) {
                    throw new Error('provider 未返回等长非空字符串数组');
                }
                translations = result;
            } catch (error) {
                throw createImageTranslationFailure(`图片文字批量翻译失败：${getErrorMessage(error)}`, error);
            }
        } else {
            translations = new Array<string>(requestTexts.length);
            const allIndexes = Array.from({length: requestTexts.length}, (_, index) => index);
            await translateRegionsWithWorkers(allIndexes, translations, useImageContext);
        }
        if (controller.signal.aborted) throw imageAbortError(false);
        if (orderedRegions) {
            const result = [...texts];
            sourceIndexes.forEach((sourceIndex, index) => {result[sourceIndex] = translations[index];});
            return {translations: result, ...language};
        }
        const byText = new Map(uniqueTexts.map((text, index) => [text, translations[index]]));
        return {translations: texts.map(text => byText.get(text) ?? text), ...language};
    } finally {
        options.signal.removeEventListener('abort', abort);
    }
}
