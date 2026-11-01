/**
 * @file src/features/selection-translation/services/wordDictionary.ts
 * 文件职责：实现划词英文词典的本地优先查询、在线限时补充、数据清洗、发音选择和缓存，让已有释义及时返回。
 * 主要内容：支持 ECDICT 内置及可选词库与五种在线词典，默认本地优先、在线并发，也可只查询指定来源；缓存和在途请求按来源隔离，共用截止时间并清理剩余请求，区分未命中与网络不可用。
 * 模块边界：本服务只获取和规范化词典数据，不渲染词卡、不翻译释义或加入词书；后台 wordLookupHandler 编排翻译，SelectionTranslator.vue 展示，HTTP 统一经过 platform/runtimeFetch。
 */
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';
import {normalizeWordDictionarySource, type WordDictionaryProviderId, type WordDictionarySourceSetting} from '@/src/core/config/selectionDictionary';
import {readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {canCacheOptionalEcdict, downloadFullEcdict, readCachedFullEcdict, type EcdictCompactRow} from './ecdictAsset';
import {normalizeEnglishWord} from './wordNormalization';

export {isSingleEnglishWord, normalizeEnglishWord} from './wordNormalization';

export type {WordDictionaryProviderId} from '@/src/core/config/selectionDictionary';

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
    id: WordDictionaryProviderId;
    label: string;
    url: string;
}

export interface WordCardData {
    word: string;
    normalizedWord: string;
    phonetics: WordPronunciation[];
    meanings: WordMeaning[];
    origin?: string;
    sources: WordDictionarySource[];
}

interface FreeDictionaryEntry {
    word?: unknown;
    phonetic?: unknown;
    phonetics?: unknown;
    origin?: unknown;
    meanings?: unknown;
    sourceUrls?: unknown;
}

interface WiktApiEntry {
    word?: unknown;
    lang_code?: unknown;
    pos?: unknown;
    senses?: unknown;
    sounds?: unknown;
}

interface WiktApiResponse {
    word?: unknown;
    entries?: unknown;
}

interface DatamuseWord {
    word?: unknown;
    tags?: unknown;
    defs?: unknown;
}

interface YoudaoWord {
    usphone?: unknown;
    ukphone?: unknown;
    usspeech?: unknown;
    ukspeech?: unknown;
    trs?: unknown;
}

interface YoudaoSimpleWord extends YoudaoWord {
    multiPhone?: {
        uk?: unknown;
        us?: unknown;
    };
}

interface YoudaoResponse {
    ec?: {
        word?: YoudaoWord;
    };
    simple?: unknown;
}

interface YoudaoTranslation {
    pos?: unknown;
    tran?: unknown;
}

interface EcdictEntry {
    w?: unknown;
    p?: unknown;
    d?: unknown;
    t?: unknown;
    pos?: unknown;
}

interface WiktionaryDefinitionEntry {
    partOfSpeech?: unknown;
    language?: unknown;
    definitions?: unknown;
}

const LOOKUP_TIMEOUT_MS = 4_000;
const LOOKUP_BUDGET_MS = 2_500;
const CHINA_PROVIDER_TIMEOUT_MS = 1_800;
const WIKTAPI_TIMEOUT_MS = 1_200;
const MAX_DEFINITIONS_PER_MEANING = 6;
const MAX_MEANINGS = 6;

const SOURCE_INFO: Record<WordDictionaryProviderId, WordDictionarySource> = {
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

function textValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function safeHttpUrl(value: unknown): string | undefined {
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

function stripHtml(value: unknown): string {
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

function normalizePartOfSpeech(value: unknown): string {
    return describePartOfSpeech(value).label;
}

function createPartialCard(normalizedWord: string, source: WordDictionarySource): WordCardData {
    return {
        word: normalizedWord,
        normalizedWord,
        phonetics: [],
        meanings: [],
        sources: [source],
    };
}

function addSource(card: WordCardData, source: WordDictionarySource): void {
    if (!card.sources.some(item => item.id === source.id)) card.sources.push(source);
}

function addMeaning(card: WordCardData, partOfSpeech: unknown, definitions: WordDefinition[]): void {
    const cleanDefinitions = definitions
        .map(definition => {
            const definitionText = stripHtml(definition.definition);
            const example = stripHtml(definition.example);
            const translatedDefinition = stripHtml(definition.translatedDefinition);
            const translatedExample = stripHtml(definition.translatedExample);
            return {
                definition: definitionText,
                ...(example ? { example } : {}),
                ...(translatedDefinition ? { translatedDefinition } : {}),
                ...(translatedExample ? { translatedExample } : {}),
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

    if (card.meanings.length < MAX_MEANINGS) card.meanings.push({ partOfSpeech: label, definitions: cleanDefinitions });
}

function addPronunciation(card: WordCardData, pronunciation: WordPronunciation): void {
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
        ...(text ? { text } : {}),
        ...(audio ? { audio } : {}),
        ...(pronunciation.label ? { label: pronunciation.label } : {}),
    });
}

function addPronunciations(card: WordCardData, pronunciations: WordPronunciation[]): void {
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

function hasUsefulData(card: WordCardData | null): card is WordCardData {
    return Boolean(card && (card.meanings.length > 0 || card.phonetics.length > 0));
}

function hasEnglishDefinition(definition: WordDefinition): boolean {
    return /[A-Za-z]/u.test(definition.definition);
}

export function mergeWordCardData(base: WordCardData | null, addition: WordCardData): WordCardData {
    const card = base || createPartialCard(addition.normalizedWord, addition.sources[0] || SOURCE_INFO['free-dictionary']);
    card.word = card.word || addition.word;
    card.normalizedWord = addition.normalizedWord || card.normalizedWord;
    if (!card.origin && addition.origin) card.origin = addition.origin;
    addPronunciations(card, addition.phonetics);
    for (const meaning of addition.meanings) addMeaning(card, meaning.partOfSpeech, meaning.definitions);
    for (const source of addition.sources) addSource(card, source);
    return card;
}

function sourceWithWord(source: WordDictionarySource, normalizedWord: string): WordDictionarySource {
    const sourceUrl = source.id === 'wiktionary-rest'
        ? `https://en.wiktionary.org/wiki/${encodeURIComponent(normalizedWord)}`
        : source.id === 'youdao-web'
            ? `https://dict.youdao.com/result?word=${encodeURIComponent(normalizedWord)}&lang=en`
            : source.url;
    return { ...source, url: sourceUrl };
}

function youdaoAudioUrl(word: string, type: 1 | 2): string {
    return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;
}

function firstPronunciation(value: unknown): string {
    return textValue(value).split(/[;；]/u, 1)[0].trim();
}

function chooseYoudaoVariant(value: unknown): { text: string; audio?: string } | null {
    const variants = Array.isArray(value) ? value : [];
    const candidates = variants.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const variant = item as Record<string, unknown>;
        const text = firstPronunciation(variant.phone);
        if (!text) return [];
        const speech = textValue(variant.speech);
        const score = (text.includes('ː') ? 2 : 0) + (text.includes('ˈ') ? 1 : 0) - (/[əɪʊ]$/u.test(text) ? 1 : 0);
        return [{ text, speech, score }];
    });
    const selected = candidates.sort((left, right) => right.score - left.score)[0];
    if (!selected) return null;
    return {
        text: selected.text,
        ...(selected.speech ? { audio: `https://dict.youdao.com/dictvoice?${selected.speech}` } : {}),
    };
}

function localDictionaryUrl(): string | null {
    try {
        const extensionGlobal = globalThis as typeof globalThis & {
            browser?: { runtime?: { getURL?: (path: string) => string } };
            chrome?: { runtime?: { getURL?: (path: string) => string } };
        };
        const runtime = extensionGlobal.browser?.runtime || extensionGlobal.chrome?.runtime;
        return typeof runtime?.getURL === 'function' ? runtime.getURL('ecdict-core.json') : null;
    } catch {
        return null;
    }
}

function normalizeEcdictText(value: unknown): string {
    return stripHtml(textValue(value).replace(/\\n/gu, ' '));
}

function normalizeEcdictPartOfSpeech(value: unknown): string {
    const first = textValue(value).split(/[&/]/u)[0]?.trim();
    return normalizePartOfSpeech(first || '其他');
}

interface EcdictLine {
    partOfSpeech: string;
    text: string;
}

function parseEcdictLines(value: unknown, fallbackPartOfSpeech = '其他'): EcdictLine[] {
    let currentPartOfSpeech = fallbackPartOfSpeech;
    return textValue(value)
        .split(/\\n|\r?\n/u)
        .map(normalizeEcdictText)
        .filter(Boolean)
        .map(line => {
            const match = line.match(/^([A-Za-z]{1,8}\.(?:\s*&\s*[A-Za-z]{1,8}\.)*)\s+(.+)$/u);
            if (!match) return { partOfSpeech: currentPartOfSpeech, text: line };
            currentPartOfSpeech = normalizeEcdictPartOfSpeech(match[1]);
            return {
                partOfSpeech: currentPartOfSpeech,
                text: match[2].trim(),
            };
        });
}

/** 将一条紧凑的本地 ECDICT 记录解析为统一的学习卡片结构。 */
export function parseEcdictEntry(entry: EcdictEntry, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO['ecdict-local'], normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    const word = textValue(entry.w);
    const phonetic = normalizeEcdictText(entry.p);
    if (word) card.word = word;
    if (phonetic) addPronunciation(card, { text: `/${phonetic}/` });

    const fallbackPartOfSpeech = normalizeEcdictPartOfSpeech(entry.pos);
    const definitions = parseEcdictLines(entry.d, fallbackPartOfSpeech);
    const translations = parseEcdictLines(entry.t);
    const usedTranslations = new Set<number>();
    for (const [definitionIndex, definition] of definitions.entries()) {
        const translationIndex = translations.findIndex((translation, index) => (
            !usedTranslations.has(index) && translation.partOfSpeech === definition.partOfSpeech
        ));
        const futurePartOfSpeech = new Set(
            definitions.slice(definitionIndex + 1).map((item) => item.partOfSpeech),
        );
        const fallbackTranslationIndex = translationIndex >= 0
            ? translationIndex
            : translations.findIndex((translation, index) => (
                !usedTranslations.has(index) && !futurePartOfSpeech.has(translation.partOfSpeech)
            ));
        if (fallbackTranslationIndex >= 0) usedTranslations.add(fallbackTranslationIndex);
        addMeaning(card, definition.partOfSpeech, [{
            definition: definition.text,
            ...(fallbackTranslationIndex >= 0 ? { translatedDefinition: translations[fallbackTranslationIndex].text } : {}),
        }]);
    }
    return card;
}

/** 解析中国大陆优先回退链路所用的免密公开词典响应。 */
export function parseYoudaoResponse(payload: unknown, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO['youdao-web'], normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    if (!payload || typeof payload !== 'object') return card;
    const response = payload as YoudaoResponse;
    const word = response.ec?.word;
    if (!word || typeof word !== 'object') return card;

    const usphone = textValue(word.usphone);
    if (usphone) addPronunciation(card, { text: `/${firstPronunciation(usphone)}/`, audio: youdaoAudioUrl(normalizedWord, 2), label: '美式' });

    const simpleValue = response.simple;
    const simpleWords = Array.isArray(simpleValue)
        ? simpleValue
        : simpleValue && typeof simpleValue === 'object' && Array.isArray((simpleValue as { word?: unknown }).word)
            ? (simpleValue as { word: unknown[] }).word
            : [];
    const simpleWord = simpleWords.find(item => item && typeof item === 'object') as YoudaoSimpleWord | undefined;
    const multiPhoneUk = chooseYoudaoVariant(simpleWord?.multiPhone?.uk);
    const ukphone = multiPhoneUk?.text || firstPronunciation(word.ukphone);
    if (ukphone) {
        addPronunciation(card, {
            text: `/${ukphone}/`,
            audio: multiPhoneUk?.audio || youdaoAudioUrl(normalizedWord, 1),
            label: '英式',
        });
    }

    const translations = Array.isArray(word.trs) ? word.trs : [];
    for (const translation of translations) {
        if (!translation || typeof translation !== 'object') continue;
        const item = translation as YoudaoTranslation;
        const translatedDefinition = stripHtml(item.tran);
        if (!translatedDefinition) continue;
        addMeaning(card, item.pos, [{ definition: translatedDefinition, translatedDefinition }]);
    }
    return card;
}

export function parseFreeDictionaryEntry(entry: FreeDictionaryEntry, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO['free-dictionary'], normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    const entryWord = textValue(entry.word);
    if (entryWord) card.word = entryWord;

    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    addPronunciations(card, phonetics.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        const audio = safeHttpUrl(value.audio);
        const text = textValue(value.text);
        if (!text && !audio) return [];
        const label = audio?.toLowerCase().includes('-uk') ? '英式' : audio?.toLowerCase().includes('-us') ? '美式' : undefined;
        return [{ text, audio, label }];
    }));
    const phonetic = textValue(entry.phonetic);
    if (phonetic) addPronunciation(card, { text: phonetic });

    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    for (const meaning of meanings) {
        if (!meaning || typeof meaning !== 'object') continue;
        const value = meaning as Record<string, unknown>;
        const definitions = Array.isArray(value.definitions) ? value.definitions : [];
        addMeaning(card, value.partOfSpeech, definitions.flatMap(definition => {
            if (!definition || typeof definition !== 'object') return [];
            const item = definition as Record<string, unknown>;
            return [{ definition: textValue(item.definition), example: textValue(item.example) }];
        }));
    }
    const origin = stripHtml(entry.origin);
    if (origin) card.origin = origin;
    return card;
}

export function parseWiktApiEntry(entry: WiktApiEntry, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO.wiktapi, normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    const entryWord = textValue(entry.word);
    if (entryWord) card.word = entryWord;

    const senses = Array.isArray(entry.senses) ? entry.senses : [];
    for (const sense of senses) {
        if (!sense || typeof sense !== 'object') continue;
        const value = sense as Record<string, unknown>;
        const glosses = Array.isArray(value.glosses) ? value.glosses.map(textValue) : [];
        const examples = Array.isArray(value.examples) ? value.examples : [];
        const example = examples.find(item => item && typeof item === 'object' && textValue((item as Record<string, unknown>).text));
        addMeaning(card, entry.pos, glosses.map(definition => ({
            definition,
            example: example && typeof example === 'object' ? textValue((example as Record<string, unknown>).text) : undefined,
        })));
    }

    const sounds = Array.isArray(entry.sounds) ? entry.sounds : [];
    addPronunciations(card, sounds.flatMap(sound => {
        if (!sound || typeof sound !== 'object') return [];
        const value = sound as Record<string, unknown>;
        const text = textValue(value.ipa) || textValue(value.enpr);
        const audio = safeHttpUrl(value.mp3_url) || safeHttpUrl(value.ogg_url) || safeHttpUrl(value.audio);
        const tags = Array.isArray(value.tags) ? value.tags.map(textValue).join(' ') : '';
        const label = /received-pronunciation|british|uk/i.test(tags) ? '英式' : /general-american|american|us/i.test(tags) ? '美式' : undefined;
        return [{ text, audio, label }];
    }));
    return card;
}

export function parseDatamuseWord(entry: DatamuseWord, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO.datamuse, normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    if (textValue(entry.word).toLowerCase() !== normalizedWord) return card;

    const tags = Array.isArray(entry.tags) ? entry.tags.map(textValue) : [];
    const pronunciation = tags.find(tag => tag.toLowerCase().startsWith('pron:'))?.slice(5).trim();
    if (pronunciation) addPronunciation(card, { text: pronunciation });
    const definitions = Array.isArray(entry.defs) ? entry.defs : [];
    const definitionsByPartOfSpeech = new Map<string, WordDefinition[]>();
    for (const item of definitions) {
        const value = textValue(item);
        if (!value) continue;
        const separator = value.indexOf('\t');
        const partOfSpeech = separator >= 0 ? value.slice(0, separator) : '其他';
        const definition = separator >= 0 ? value.slice(separator + 1) : value;
        const list = definitionsByPartOfSpeech.get(partOfSpeech) || [];
        list.push({ definition });
        definitionsByPartOfSpeech.set(partOfSpeech, list);
    }
    for (const [partOfSpeech, definitionsForPart] of definitionsByPartOfSpeech) addMeaning(card, partOfSpeech, definitionsForPart);
    return card;
}

function parseWiktionaryRestEntry(entry: WiktionaryDefinitionEntry, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO['wiktionary-rest'], normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    const definitions = Array.isArray(entry.definitions) ? entry.definitions : [];
    for (const definition of definitions) {
        if (!definition || typeof definition !== 'object') continue;
        const value = definition as Record<string, unknown>;
        const text = stripHtml(value.definition);
        const examples = Array.isArray(value.examples) ? value.examples : [];
        const example = examples.find(item => item && typeof item === 'object' && stripHtml((item as Record<string, unknown>).example));
        addMeaning(card, entry.partOfSpeech, [{
            definition: text,
            example: example && typeof example === 'object' ? stripHtml((example as Record<string, unknown>).example) : undefined,
        }]);
    }
    return card;
}

async function fetchJson(url: string, timeoutMs = LOOKUP_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const response = await runtimeFetch(url, {
            credentials: 'omit',
            headers: { Accept: 'application/json' },
            signal: abortContext.signal,
        });
        if (response.status === 404 || !response.ok) {
            cancelUnreadResponseBody(response);
            if (response.status === 404) return null;
            throw new Error(`dictionary request failed: ${response.status}`);
        }
        return await readJsonResponse(response, 'dictionary response is not valid JSON');
    } finally {
        abortContext.cleanup();
    }
}

export interface WordDictionaryProvider {
    readonly id: WordDictionaryProviderId;
    readonly lookup: (word: string, signal?: AbortSignal) => Promise<WordCardData | null>;
}

function createEcdictProvider(): WordDictionaryProvider {
    type EcdictIndex = Map<string, EcdictEntry | EcdictCompactRow>;
    let indexPromise: Promise<EcdictIndex> | null = null;
    let optionalIndexPromise: Promise<EcdictIndex | null> | null = null;
    let optionalDownload: Promise<void> | null = null;
    let nextDownloadAt = 0;

    const indexRows = (entries: unknown[]): EcdictIndex => {
        const index: EcdictIndex = new Map();
        for (const entry of entries) {
            if (Array.isArray(entry)) {
                if (entry.length !== 4 || entry.some(value => typeof value !== 'string')) continue;
                const word = entry[0].toLowerCase();
                if (word) index.set(word, entry as unknown as EcdictCompactRow);
            } else if (entry && typeof entry === 'object') {
                const word = textValue((entry as EcdictEntry).w).toLowerCase();
                if (word) index.set(word, entry as EcdictEntry);
            }
        }
        return index;
    };

    const loadIndex = async (url: string): Promise<EcdictIndex> => {
        if (indexPromise) return indexPromise;

        // 步骤 1：同一后台生命周期只解析一次本地词库；若读取失败则清掉失败 Promise，
        // 让浏览器资源短暂不可用后的下一次查询能够自动恢复。
        indexPromise = (async () => {
            const response = await runtimeFetch(url, {credentials: 'omit'});
            if (!response.ok) {cancelUnreadResponseBody(response); throw new Error(`local dictionary request failed: ${response.status}`);}
            const payload = await readJsonResponse(response, 'local dictionary response is not valid JSON');
            const entries = Array.isArray(payload) ? payload : [];
            return indexRows(entries);
        })();
        try {
            return await indexPromise;
        } catch (error) {
            indexPromise = null;
            throw error;
        }
    };

    const loadOptionalIndex = (): Promise<EcdictIndex | null> => {
        if (!optionalIndexPromise) {
            optionalIndexPromise = readCachedFullEcdict().then(rows => rows ? indexRows(rows) : null);
        }
        return optionalIndexPromise;
    };

    const startOptionalDownload = (): void => {
        if (optionalDownload || Date.now() < nextDownloadAt
            || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        // 当前词立即交给线上 provider；完整词库在后台准备好，后续查询从本地命中。
        optionalDownload = downloadFullEcdict()
            .then(rows => { optionalIndexPromise = Promise.resolve(indexRows(rows)); })
            .catch(() => { nextDownloadAt = Date.now() + 30 * 60_000; })
            .finally(() => { optionalDownload = null; });
    };

    return {
        id: 'ecdict-local',
        async lookup(normalizedWord) {
            // Userscript 没有打包扩展词库；不能在宿主页面上下文中下载可选资源。
            const url = localDictionaryUrl();
            if (!url) return null;
            const coreIndex = await loadIndex(url);
            let entry = coreIndex.get(normalizedWord);
            if (!entry && canCacheOptionalEcdict()) {
                const optionalIndex = await loadOptionalIndex();
                entry = optionalIndex?.get(normalizedWord);
                if (!optionalIndex) startOptionalDownload();
            }
            if (!entry) return null;
            const parsed: EcdictEntry = Array.isArray(entry)
                ? {w: entry[0], p: entry[1], d: entry[2], t: entry[3]}
                : entry as EcdictEntry;
            return parseEcdictEntry(parsed, normalizedWord);
        },
    };
}

async function lookupFreeDictionary(normalizedWord: string, signal?: AbortSignal): Promise<WordCardData | null> {
    const payload = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalizedWord)}`, LOOKUP_TIMEOUT_MS, signal);
    if (!Array.isArray(payload)) return null;
    return payload.reduce<WordCardData | null>((card, entry) => {
        if (!entry || typeof entry !== 'object') return card;
        return mergeWordCardData(card, parseFreeDictionaryEntry(entry as FreeDictionaryEntry, normalizedWord));
    }, null);
}

async function lookupYoudao(normalizedWord: string, signal?: AbortSignal): Promise<WordCardData | null> {
    const url = `https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=${encodeURIComponent(normalizedWord)}&le=eng`;
    const payload = await fetchJson(url, CHINA_PROVIDER_TIMEOUT_MS, signal);
    const card = parseYoudaoResponse(payload, normalizedWord);
    return hasUsefulData(card) ? card : null;
}

async function lookupWiktApi(normalizedWord: string, signal?: AbortSignal): Promise<WordCardData | null> {
    const payload = await fetchJson(`https://api.wiktapi.dev/v1/en/word/${encodeURIComponent(normalizedWord)}`, WIKTAPI_TIMEOUT_MS, signal);
    if (!payload || typeof payload !== 'object') return null;
    const rawEntries = (payload as WiktApiResponse).entries;
    const entries: unknown[] = Array.isArray(rawEntries) ? rawEntries : [];
    return entries.reduce<WordCardData | null>((card, entry) => {
        if (!entry || typeof entry !== 'object') return card;
        const item = entry as WiktApiEntry;
        if (textValue(item.lang_code) && textValue(item.lang_code) !== 'en') return card;
        return mergeWordCardData(card, parseWiktApiEntry(item, normalizedWord));
    }, null);
}

async function lookupWiktionaryRest(normalizedWord: string, signal?: AbortSignal): Promise<WordCardData | null> {
    const payload = await fetchJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(normalizedWord)}`, LOOKUP_TIMEOUT_MS, signal);
    if (!payload || typeof payload !== 'object') return null;
    const rawEnglishEntries = (payload as Record<string, unknown>).en;
    const englishEntries: unknown[] = Array.isArray(rawEnglishEntries) ? rawEnglishEntries : [];
    return englishEntries.reduce<WordCardData | null>((card, entry) => {
        if (!entry || typeof entry !== 'object') return card;
        return mergeWordCardData(card, parseWiktionaryRestEntry(entry as WiktionaryDefinitionEntry, normalizedWord));
    }, null);
}

async function lookupDatamuse(normalizedWord: string, signal?: AbortSignal): Promise<WordCardData | null> {
    const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(normalizedWord)}&md=dpr&ipa=1&max=8`;
    const payload = await fetchJson(url, LOOKUP_TIMEOUT_MS, signal);
    if (!Array.isArray(payload)) return null;
    return payload.reduce<WordCardData | null>((card, entry) => {
        if (!entry || typeof entry !== 'object') return card;
        const item = parseDatamuseWord(entry as DatamuseWord, normalizedWord);
        return item.meanings.length > 0 || item.phonetics.length > 0 ? mergeWordCardData(card, item) : card;
    }, null);
}

/** 构造默认 provider registry，便于在单测和未来插件中逐个替换网络适配器。 */
export function createDefaultWordDictionaryProviders(): WordDictionaryProvider[] {
    return [
        createEcdictProvider(),
        {id: 'youdao-web', lookup: lookupYoudao},
        {id: 'free-dictionary', lookup: lookupFreeDictionary},
        {id: 'datamuse', lookup: lookupDatamuse},
        {id: 'wiktionary-rest', lookup: lookupWiktionaryRest},
        // WiktApi 在中国大陆可能不可达，因此保持最短来源超时。
        {id: 'wiktapi', lookup: lookupWiktApi},
    ];
}

function finalizeWordCard(card: WordCardData | null): WordCardData | null {
    if (!card) return null;
    card.phonetics = selectPronunciations(card.phonetics);
    return card;
}

export interface WordDictionaryLookupOptions {
    readonly providers?: readonly WordDictionaryProvider[];
    readonly cacheSize?: number;
    readonly warn?: (message: string, error: unknown) => void;
}

export interface WordDictionaryLookup {
    lookup(value: string, source?: WordDictionarySourceSetting): Promise<WordCardData | null>;
    clearCache(): void;
}

const DEFAULT_WORD_LOOKUP_CACHE_SIZE = 80;

/**
 * 创建可注入 provider 的词典查询服务。
 * 本地释义立即返回，在线来源并发竞争首份释义，整次查询最多等待 2.5 秒。
 * 指定来源时只请求该词典；确定结果（包括所选来源正常返回的未命中）会缓存；网络失败不写入负缓存，同来源同词查询共享请求。
 */
export function createWordDictionaryLookup(options: WordDictionaryLookupOptions = {}): WordDictionaryLookup {
    const providers = options.providers ? [...options.providers] : createDefaultWordDictionaryProviders();
    const cacheSize = options.cacheSize ?? DEFAULT_WORD_LOOKUP_CACHE_SIZE;
    if (!Number.isInteger(cacheSize) || cacheSize <= 0) throw new RangeError('词典缓存容量必须是正整数');
    const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));
    const resultCache = new Map<string, WordCardData | null>();
    const inFlight = new Map<string, Promise<WordCardData | null>>();

    const cacheResult = (word: string, result: WordCardData | null): WordCardData | null => {
        if (resultCache.size >= cacheSize) {
            const oldestWord = resultCache.keys().next().value as string;
            resultCache.delete(oldestWord);
        }
        resultCache.set(word, result);
        return result;
    };

    const performLookup = (normalizedWord: string, source: WordDictionarySourceSetting): Promise<WordCardData | null> => new Promise((resolve, reject) => {
        const selectedProviders = source === 'auto' ? providers : providers.filter(provider => provider.id === source);
        const controller = new AbortController();
        let merged: WordCardData | null = null;
        let settled = false;
        let failed = false;
        const finish = (unavailable = false): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controller.abort();
            if (unavailable && !merged) reject(new Error('词典查询暂时不可用'));
            else resolve(finalizeWordCard(merged));
        };
        const timer = setTimeout(() => finish(true), LOOKUP_BUDGET_MS);
        const query = async (provider: WordDictionaryProvider): Promise<void> => {
            try {
                const result = await provider.lookup(normalizedWord, controller.signal);
                if (settled) return;
                if (hasUsefulData(result)) merged = mergeWordCardData(merged, result);
                if (merged?.meanings.length) finish();
            } catch (error) {
                if (settled) return;
                failed = true;
                warn(`[FluentRead] word provider ${provider.id} unavailable`, error);
            }
        };
        void (async () => {
            for (const provider of selectedProviders.filter(item => item.id === 'ecdict-local')) {
                await query(provider);
                if (settled) return;
            }
            await Promise.all(selectedProviders.filter(item => item.id !== 'ecdict-local').map(query));
            finish(failed);
        })();
    });

    return {
        async lookup(value, source) {
            const normalizedWord = normalizeEnglishWord(value);
            if (!normalizedWord) return null;
            const dictionarySource = normalizeWordDictionarySource(source);
            const cacheKey = `${dictionarySource}:${normalizedWord}`;
            if (resultCache.has(cacheKey)) return resultCache.get(cacheKey) ?? null;
            const activeLookup = inFlight.get(cacheKey);
            if (activeLookup) return activeLookup;

            const pending = performLookup(normalizedWord, dictionarySource);
            inFlight.set(cacheKey, pending);
            try {
                return cacheResult(cacheKey, await pending);
            } finally {
                inFlight.delete(cacheKey);
            }
        },
        clearCache() {
            resultCache.clear();
        },
    };
}

const defaultWordDictionaryLookup = createWordDictionaryLookup();

/** 按配置来源查询英语单词，缺省时保持本地优先的自动策略。 */
export function lookupWord(value: string, source?: WordDictionarySourceSetting): Promise<WordCardData | null> {
    return defaultWordDictionaryLookup.lookup(value, source);
}

/** 清理默认查询实例的正/负结果缓存，不会中断已经发出的请求。 */
export function clearWordDictionaryCache(): void {
    defaultWordDictionaryLookup.clearCache();
}
