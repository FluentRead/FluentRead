/**
 * @file src/features/selection-translation/background/wordLookupHandler.ts
 * 文件职责：处理划词词典查询消息，支持先返回词典原文、再限时补充目标语言辅助释义，失败时保留可读词卡。
 * 主要内容：定义 selectionWordLookup 协议和依赖，校验单词与查询阶段，隔离不匹配目标语言的辅助内容，深拷贝词卡并只翻译缺失的可见释义，按位置回填；补充翻译共用短时预算。
 * 模块边界：该文件不直接请求任何词典站点或翻译 provider；词典 lookup 和 translateTexts 由后台注入，数据解析/缓存归 services/wordDictionary，组件只消费返回词卡。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import type {WordCardData} from '../services/wordDictionary';

export type {
    WordCardData,
} from '../services/wordDictionary';

export const SELECTION_WORD_LOOKUP_MESSAGE_TYPE = 'selectionWordLookup' as const;
const WORD_SUPPORT_TIMEOUT_MS = 2_500;

export interface SelectionWordLookupMessage {
    type: typeof SELECTION_WORD_LOOKUP_MESSAGE_TYPE;
    word?: unknown;
    targetLanguage?: unknown;
    /** false 先返回可读词卡；缺省兼容既有的一次性查询。 */
    translateFields?: unknown;
}

export interface WordCardTranslationRequest {
    origin: string[];
    context: '';
    pageContext: '';
    useCache: true;
    targetLanguage: string;
    requestTimeoutMs: number;
}

export interface SelectionWordLookupDependencies {
    readonly lookupWord: (word: string) => Promise<WordCardData | null>;
    readonly getDefaultTargetLanguage: () => string;
    readonly translate: (request: WordCardTranslationRequest) => Promise<string | string[]>;
    readonly warn: (message: string, error: unknown) => void;
}

export interface SelectionWordLookupHandler {
    readonly type: typeof SELECTION_WORD_LOOKUP_MESSAGE_TYPE;
    handle(message: SelectionWordLookupMessage): Promise<{success: true; data: WordCardData | null}>;
}

interface WordDefinitionTranslationSlot {
    meaningIndex: number;
    definitionIndex: number;
    field: 'translatedDefinition' | 'translatedExample';
    original: string;
}

function parseWord(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('单词查询 word 必须是字符串');
    return value;
}

function parseTargetLanguage(value: unknown, fallback: string): string {
    const candidate = value === undefined ? fallback : value;
    if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new TypeError('单词查询 targetLanguage 必须是非空字符串');
    }
    return candidate;
}

function cloneWordCard(card: WordCardData): WordCardData {
    return {
        ...card,
        phonetics: card.phonetics.map((pronunciation) => ({...pronunciation})),
        meanings: card.meanings.map((meaning) => ({
            ...meaning,
            definitions: meaning.definitions.map((definition) => ({...definition})),
        })),
        sources: card.sources.map((source) => ({...source})),
    };
}

function prepareWordCardForTarget(card: WordCardData, targetLanguage: string): WordCardData {
    if (normalizeChineseLanguageCode(targetLanguage) === 'zh-Hans') return card;
    const result = cloneWordCard(card);
    for (const meaning of result.meanings) {
        for (const definition of meaning.definitions) {
            delete definition.translatedDefinition;
            delete definition.translatedExample;
        }
    }
    return result;
}

/**
 * 只翻译学习卡片中实际展示的前四组释义/例句；失败时保留词典原文。
 */
export async function translateVisibleWordCardFields(
    card: WordCardData,
    targetLanguage: string,
    translate: SelectionWordLookupDependencies['translate'],
    warn: SelectionWordLookupDependencies['warn'],
): Promise<WordCardData> {
    const normalizedTargetLanguage = normalizeChineseLanguageCode(targetLanguage);
    // 公共词典的既有辅助字段没有目标语言元数据，通常为简体；不能将它们
    // 当作繁体翻译失败后的译文。仅清除克隆上的辅助字段，原词典内容保持可读。
    const fallbackCard = prepareWordCardForTarget(card, normalizedTargetLanguage);
    const slots: WordDefinitionTranslationSlot[] = [];
    for (const [meaningIndex, meaning] of fallbackCard.meanings.slice(0, 4).entries()) {
        for (const [definitionIndex, definition] of meaning.definitions.slice(0, 4).entries()) {
            if (definition.definition && !definition.translatedDefinition) {
                slots.push({meaningIndex, definitionIndex, field: 'translatedDefinition', original: definition.definition});
            }
            if (definition.example && !definition.translatedExample) {
                slots.push({meaningIndex, definitionIndex, field: 'translatedExample', original: definition.example});
            }
        }
    }
    if (slots.length === 0) return fallbackCard;

    const uniqueOrigins = [...new Set(slots.map((slot) => slot.original))];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let translated: string | string[] | null = null;
    try {
        translated = await Promise.race([translate({
            origin: uniqueOrigins,
            context: '',
            pageContext: '',
            useCache: true,
            targetLanguage: normalizedTargetLanguage,
            requestTimeoutMs: WORD_SUPPORT_TIMEOUT_MS,
        }), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('词典辅助释义翻译超时')), WORD_SUPPORT_TIMEOUT_MS);
        })]);
    } catch (error) {
        warn('[FluentRead] word definition translation unavailable; keeping dictionary text', error);
    } finally {
        clearTimeout(timer);
    }
    if (!Array.isArray(translated) || translated.length !== uniqueOrigins.length) return fallbackCard;

    // 只有 provider 返回与请求一一对应的批量结果时才克隆并写入卡片。
    const translatedByOrigin = new Map(uniqueOrigins.map((origin, index) => [origin, translated[index]]));
    const result = fallbackCard === card ? cloneWordCard(card) : fallbackCard;
    for (const slot of slots) {
        const value = translatedByOrigin.get(slot.original);
        if (typeof value !== 'string' || !value.trim() || value.trim() === slot.original) continue;
        const definition = result.meanings[slot.meaningIndex].definitions[slot.definitionIndex];
        definition[slot.field] = value.trim();
    }
    return result;
}

/** 创建划词词典查询 handler；词典 provider 与翻译 broker 由 app 层注入。 */
export function createSelectionWordLookupHandler(
    dependencies: SelectionWordLookupDependencies,
): SelectionWordLookupHandler {
    return {
        type: SELECTION_WORD_LOOKUP_MESSAGE_TYPE,
        async handle(message) {
            const word = parseWord(message.word);
            const targetLanguage = parseTargetLanguage(
                message.targetLanguage,
                dependencies.getDefaultTargetLanguage(),
            );
            if (message.translateFields !== undefined && typeof message.translateFields !== 'boolean') {
                throw new TypeError('单词查询 translateFields 必须是布尔值');
            }
            const card = await dependencies.lookupWord(word);
            return {
                success: true,
                data: card
                    ? message.translateFields === false || card.dictionaryEntry
                        ? prepareWordCardForTarget(card, targetLanguage)
                        : await translateVisibleWordCardFields(card, targetLanguage, dependencies.translate, dependencies.warn)
                    : null,
            };
        },
    };
}
