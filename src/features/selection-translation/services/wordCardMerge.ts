/**
 * @file src/features/selection-translation/services/wordCardMerge.ts
 * 文件职责：提供划词词典卡片数据结构定义、文本/链接清洗、释义配对去重、发音评分筛选与多源词卡合并逻辑。
 * 主要内容：维护词典来源元信息、HTML 实体清理、中英文释义同行配对合并、美式/英式主发音择优、词形变化去重拼接及安全 HTTPS 链接校验。
 * 模块边界：纯数据结构与合并变换模块，不发起任何网络请求、不读写缓存也不依赖浏览器扩展运行时。
 */
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';
import type {WordDictionaryProviderId} from '@/src/core/config/selectionDictionary';
import type {DictionaryEntry} from '../dictionary/model';

export interface WordPronunciation {
    text?: string;
    audio?: string;
    label?: string;
}

export interface WordDefinition {
    definition: string;
    example?: string;
    translatedDefinition?: string;
    translatedExample?: string;
}

export interface WordMeaning {
    partOfSpeech: string;
    definitions: WordDefinition[];
}

export interface WordDictionarySource {
    id: WordDictionaryProviderId | `recipe:${string}`;
    label: string;
    url: string;
}

export interface WordCardData {
    dictionaryEntry?: DictionaryEntry;
    word: string;
    normalizedWord: string;
    phonetics: WordPronunciation[];
    meanings: WordMeaning[];
    origin?: string;
    inflections?: string;
    sources: WordDictionarySource[];
}

const MAX_DEFINITIONS_PER_MEANING = 6;
const MAX_MEANINGS = 6;
const MAX_INFLECTIONS = 8;
const IGNORED_WIKTAPI_FORM_TAGS = new Set([
    'table-tags',
    'inflection-template',
    'class',
    'canonical',
    'romanization',
]);

export const SOURCE_INFO: Record<WordDictionaryProviderId, WordDictionarySource> = {
    'ecdict-local': {
        id: 'ecdict-local',
        label: 'ECDICT 本地词库',
        url: 'https://github.com/skywind3000/ECDICT',
    },
    'youdao-web': {
        id: 'youdao-web',
        label: '有道词典',
        url: 'https://dict.youdao.com/',
    },
    'free-dictionary': {
        id: 'free-dictionary',
        label: 'Free Dictionary API',
        url: 'https://dictionaryapi.dev/',
    },
    wiktapi: {
        id: 'wiktapi',
        label: 'WiktApi / Wiktionary',
        url: 'https://wiktapi.dev/',
    },
    'wiktionary-rest': {
        id: 'wiktionary-rest',
        label: 'Wiktionary',
        url: 'https://en.wiktionary.org/',
    },
    datamuse: {
        id: 'datamuse',
        label: 'Datamuse',
        url: 'https://www.datamuse.com/api/',
    },
};

export function textValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function safeHttpUrl(value: unknown): string | undefined {
    const candidate = textValue(value);
    if (!candidate) return undefined;
    try {
        const url = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}

export function stripHtml(value: unknown): string {
    const raw = textValue(value);
    if (!raw) return '';
    return raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizePartOfSpeech(value: unknown): string {
    return describePartOfSpeech(value).label;
}

export function createPartialCard(normalizedWord: string, source: WordDictionarySource): WordCardData {
    return {
        word: normalizedWord,
        normalizedWord,
        phonetics: [],
        meanings: [],
        sources: [source],
    };
}

export function addSource(card: WordCardData, source: WordDictionarySource): void {
    if (!card.sources.some(item => item.id === source.id)) card.sources.push(source);
}

function hasEnglishDefinition(definition: WordDefinition): boolean {
    return /[A-Za-z]/u.test(definition.definition);
}

export function addMeaning(card: WordCardData, partOfSpeech: unknown, definitions: WordDefinition[]): void {
    const cleanDefinitions = definitions
        .map(definition => {
            const definitionText = stripHtml(definition.definition);
            const example = stripHtml(definition.example);
            const translatedDefinition = stripHtml(definition.translatedDefinition);
            const translatedExample = stripHtml(definition.translatedExample);
            return {
                definition: definitionText,
                ...(example ? {example} : {}),
                ...(translatedDefinition ? {translatedDefinition} : {}),
                ...(translatedExample ? {translatedExample} : {}),
            };
        })
        .filter(definition => definition.definition)
        .slice(0, MAX_DEFINITIONS_PER_MEANING);
    if (cleanDefinitions.length === 0) return;

    const label = normalizePartOfSpeech(partOfSpeech);
    const existing = card.meanings.find(meaning => meaning.partOfSpeech === label);
    if (existing) {
        const seen = new Set(existing.definitions.map(definition => definition.definition.toLocaleLowerCase()));
        for (const definition of cleanDefinitions) {
            const definitionKey = definition.definition.toLocaleLowerCase();
            const exact = existing.definitions.find(item => item.definition.toLocaleLowerCase() === definitionKey);
            if (exact) {
                if (!exact.translatedDefinition && definition.translatedDefinition) exact.translatedDefinition = definition.translatedDefinition;
                if (!exact.translatedExample && definition.translatedExample) exact.translatedExample = definition.translatedExample;
                if (!exact.example && definition.example) exact.example = definition.example;
                continue;
            }

            // 中国区优先 provider 可能先返回中文释义；后续英文 provider 到达时，
            // 将两者配成同一行，避免卡片展示重复释义。
            const translationOnly = existing.definitions.find(item => !hasEnglishDefinition(item) && item.definition !== definition.definition);
            if (translationOnly && hasEnglishDefinition(definition)) {
                translationOnly.definition = definition.definition;
                if (definition.example) translationOnly.example = definition.example;
                if (definition.translatedExample) translationOnly.translatedExample = definition.translatedExample;
                seen.add(definitionKey);
                continue;
            }

            // 后到的中文释义应附加到已有英文 sense，而不是新增中文-only 重复行。
            if (!hasEnglishDefinition(definition)) {
                const englishDefinition = existing.definitions.find(item => hasEnglishDefinition(item));
                if (englishDefinition) {
                    if (!englishDefinition.translatedDefinition) {
                        englishDefinition.translatedDefinition = definition.definition;
                    } else if (!englishDefinition.translatedDefinition.includes(definition.definition)) {
                        englishDefinition.translatedDefinition += `；${definition.definition}`;
                    }
                    continue;
                }
            }

            if (!seen.has(definitionKey) && existing.definitions.length < MAX_DEFINITIONS_PER_MEANING) {
                existing.definitions.push(definition);
                seen.add(definitionKey);
            }
        }
        return;
    }

    if (card.meanings.length < MAX_MEANINGS) card.meanings.push({partOfSpeech: label, definitions: cleanDefinitions});
}

export function addPronunciation(card: WordCardData, pronunciation: WordPronunciation): void {
    const text = textValue(pronunciation.text);
    const audio = safeHttpUrl(pronunciation.audio);
    if (!text && !audio) return;
    const existing = card.phonetics.find(item => {
        const sameValue = text
            ? textValue(item.text).toLocaleLowerCase() === text.toLocaleLowerCase()
            : safeHttpUrl(item.audio) === audio;
        if (!sameValue) return false;
        // 同一 IPA 可能同时属于美式与英式；标签不同的两行都要保留。
        return !(item.label && pronunciation.label && item.label !== pronunciation.label);
    });
    if (existing) {
        if (!existing.audio && audio) existing.audio = audio;
        if (!existing.label && pronunciation.label) existing.label = pronunciation.label;
        return;
    }
    card.phonetics.push({
        ...(text ? {text} : {}),
        ...(audio ? {audio} : {}),
        ...(pronunciation.label ? {label: pronunciation.label} : {}),
    });
}

export function addPronunciations(card: WordCardData, pronunciations: WordPronunciation[]): void {
    for (const pronunciation of pronunciations.slice(0, 8)) addPronunciation(card, pronunciation);
}

function pronunciationRegion(pronunciation: WordPronunciation): '美式' | '英式' | null {
    if (pronunciation.label === '美式' || pronunciation.label === '英式') return pronunciation.label;
    return null;
}

function pronunciationScore(pronunciation: WordPronunciation): number {
    const metadata = `${pronunciation.audio || ''} ${pronunciation.text || ''}`.toLowerCase();
    let score = pronunciation.audio ? 2 : 0;
    if (/stressed|primary|strong/.test(metadata)) score += 4;
    if (/unstressed|weak/.test(metadata)) score -= 2;
    if (pronunciation.text?.includes('ˈ')) score += 1;
    return score;
}

/** 每个地区只保留评分最高的主发音，避免把 provider 的所有弱读变体堆到卡片中。 */
export function selectPronunciations(pronunciations: WordPronunciation[]): WordPronunciation[] {
    const regional = new Map<'美式' | '英式', WordPronunciation>();
    const unlabelled: WordPronunciation[] = [];

    for (const pronunciation of pronunciations) {
        const region = pronunciationRegion(pronunciation);
        if (!region) {
            unlabelled.push(pronunciation);
            continue;
        }
        const current = regional.get(region);
        if (!current || pronunciationScore(pronunciation) > pronunciationScore(current)) regional.set(region, pronunciation);
    }

    if (regional.size > 0) {
        return (['美式', '英式'] as const).flatMap(region => {
            const pronunciation = regional.get(region);
            return pronunciation ? [pronunciation] : [];
        });
    }

    return unlabelled.slice(0, 2);
}

export function hasUsefulData(card: WordCardData | null): card is WordCardData {
    return Boolean(card && (card.meanings.length > 0 || card.phonetics.length > 0));
}

function mergeInflections(current: string | undefined, addition: string): string {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const raw of current ? [current, addition] : [addition]) {
        for (const part of raw.split(';')) {
            const value = part.trim();
            const key = value.toLocaleLowerCase();
            if (value && !seen.has(key)) {
                seen.add(key);
                merged.push(value);
                if (merged.length >= MAX_INFLECTIONS) return merged.join('; ');
            }
        }
    }
    return merged.join('; ');
}

export function formatWiktApiInflections(forms: unknown, normalizedWord: string): string {
    if (!Array.isArray(forms)) return '';
    const items: string[] = [];
    const seen = new Set<string>();
    for (const raw of forms) {
        if (!raw || typeof raw !== 'object') continue;
        const value = raw as Record<string, unknown>;
        const form = textValue(value.form);
        if (!form || form === '-') continue;
        const tags = Array.isArray(value.tags) ? value.tags.map(textValue).filter(Boolean) : [];
        if (tags.some(tag => IGNORED_WIKTAPI_FORM_TAGS.has(tag.toLowerCase()))) continue;
        if (tags.length === 0 && form.toLowerCase() === normalizedWord) continue;
        const formatted = tags.length > 0 ? `${form} (${tags.slice(0, 3).join(', ')})` : form;
        const key = formatted.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(formatted);
        if (items.length >= MAX_INFLECTIONS) break;
    }
    return items.join('; ');
}

export function mergeWordCardData(base: WordCardData | null, addition: WordCardData): WordCardData {
    const card = base || createPartialCard(addition.normalizedWord, addition.sources[0] || SOURCE_INFO['free-dictionary']);
    card.word = card.word || addition.word;
    card.normalizedWord = addition.normalizedWord || card.normalizedWord;
    if (!card.origin && addition.origin) card.origin = addition.origin;
    if (addition.inflections) card.inflections = mergeInflections(card.inflections, addition.inflections);
    addPronunciations(card, addition.phonetics);
    for (const meaning of addition.meanings) addMeaning(card, meaning.partOfSpeech, meaning.definitions);
    for (const source of addition.sources) addSource(card, source);
    return card;
}

export function sourceWithWord(source: WordDictionarySource, normalizedWord: string): WordDictionarySource {
    const sourceUrl = source.id === 'wiktionary-rest'
        ? `https://en.wiktionary.org/wiki/${encodeURIComponent(normalizedWord)}`
        : source.id === 'youdao-web'
            ? `https://dict.youdao.com/result?word=${encodeURIComponent(normalizedWord)}&lang=en`
            : source.url;
    return {...source, url: sourceUrl};
}
