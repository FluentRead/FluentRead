/**
 * @file src/features/selection-translation/services/wordDictionaryParsers.ts
 * 文件职责：将 ECDICT、有道词典、Free Dictionary、WiktApi、Wiktionary REST 与 Datamuse 的原始响应解析为统一的 WordCardData 结构。
 * 主要内容：实现各在线与离线词典源的字段抽取、词性归类、音标与音频链接拼装及例句清理，复用 wordCardMerge 中的规范化辅助方法。
 * 模块边界：纯数据解析器集合，不发起网络请求、不管理缓存与超时预算，也不直接依赖浏览器扩展 API。
 */
import {
    SOURCE_INFO,
    addMeaning,
    addPronunciation,
    addPronunciations,
    createPartialCard,
    formatWiktApiInflections,
    normalizePartOfSpeech,
    safeHttpUrl,
    sourceWithWord,
    stripHtml,
    textValue,
    type WordCardData,
    type WordDefinition,
} from './wordCardMerge';

export interface FreeDictionaryEntry {
    word?: unknown;
    phonetic?: unknown;
    phonetics?: unknown;
    origin?: unknown;
    meanings?: unknown;
    sourceUrls?: unknown;
}

export interface WiktApiEntry {
    word?: unknown;
    lang_code?: unknown;
    pos?: unknown;
    etymology_text?: unknown;
    etymology?: unknown;
    forms?: unknown;
    senses?: unknown;
    sounds?: unknown;
}

export interface WiktApiResponse {
    word?: unknown;
    entries?: unknown;
}

export interface DatamuseWord {
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

export interface EcdictEntry {
    w?: unknown;
    p?: unknown;
    d?: unknown;
    t?: unknown;
    pos?: unknown;
}

export interface WiktionaryDefinitionEntry {
    partOfSpeech?: unknown;
    language?: unknown;
    definitions?: unknown;
}

function youdaoAudioUrl(word: string, type: 1 | 2): string {
    return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;
}

function firstPronunciation(value: unknown): string {
    return textValue(value).split(/[;；]/u, 1)[0].trim();
}

function chooseYoudaoVariant(value: unknown): {text: string; audio?: string} | null {
    const variants = Array.isArray(value) ? value : [];
    const candidates = variants.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const variant = item as Record<string, unknown>;
        const text = firstPronunciation(variant.phone);
        if (!text) return [];
        const speech = textValue(variant.speech);
        const score = (text.includes('ː') ? 2 : 0) + (text.includes('ˈ') ? 1 : 0) - (/[əɪʊ]$/u.test(text) ? 1 : 0);
        return [{text, speech, score}];
    });
    const selected = candidates.sort((left, right) => right.score - left.score)[0];
    if (!selected) return null;
    return {
        text: selected.text,
        ...(selected.speech ? {audio: `https://dict.youdao.com/dictvoice?${selected.speech}`} : {}),
    };
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
            if (!match) return {partOfSpeech: currentPartOfSpeech, text: line};
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
    if (phonetic) addPronunciation(card, {text: `/${phonetic}/`});

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
            ...(fallbackTranslationIndex >= 0 ? {translatedDefinition: translations[fallbackTranslationIndex].text} : {}),
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
    if (usphone) addPronunciation(card, {text: `/${firstPronunciation(usphone)}/`, audio: youdaoAudioUrl(normalizedWord, 2), label: '美式'});

    const simpleValue = response.simple;
    const simpleWords = Array.isArray(simpleValue)
        ? simpleValue
        : simpleValue && typeof simpleValue === 'object' && Array.isArray((simpleValue as {word?: unknown}).word)
            ? (simpleValue as {word: unknown[]}).word
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
        addMeaning(card, item.pos, [{definition: translatedDefinition, translatedDefinition}]);
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
        return [{text, audio, label}];
    }));
    const phonetic = textValue(entry.phonetic);
    if (phonetic) addPronunciation(card, {text: phonetic});

    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    for (const meaning of meanings) {
        if (!meaning || typeof meaning !== 'object') continue;
        const value = meaning as Record<string, unknown>;
        const definitions = Array.isArray(value.definitions) ? value.definitions : [];
        addMeaning(card, value.partOfSpeech, definitions.flatMap(definition => {
            if (!definition || typeof definition !== 'object') return [];
            const item = definition as Record<string, unknown>;
            return [{definition: textValue(item.definition), example: textValue(item.example)}];
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
        return [{text, audio, label}];
    }));
    const origin = stripHtml(entry.etymology_text) || stripHtml(entry.etymology);
    if (origin) card.origin = origin;
    const inflections = formatWiktApiInflections(entry.forms, normalizedWord);
    if (inflections) card.inflections = inflections;
    return card;
}

export function parseDatamuseWord(entry: DatamuseWord, normalizedWord: string): WordCardData {
    const source = sourceWithWord(SOURCE_INFO.datamuse, normalizedWord);
    const card = createPartialCard(normalizedWord, source);
    if (textValue(entry.word).toLowerCase() !== normalizedWord) return card;

    const tags = Array.isArray(entry.tags) ? entry.tags.map(textValue) : [];
    const pronunciation = tags.find(tag => tag.toLowerCase().startsWith('pron:'))?.slice(5).trim();
    if (pronunciation) addPronunciation(card, {text: pronunciation});
    const definitions = Array.isArray(entry.defs) ? entry.defs : [];
    const definitionsByPartOfSpeech = new Map<string, WordDefinition[]>();
    for (const item of definitions) {
        const value = textValue(item);
        if (!value) continue;
        const separator = value.indexOf('\t');
        const partOfSpeech = separator >= 0 ? value.slice(0, separator) : '其他';
        const definition = separator >= 0 ? value.slice(separator + 1) : value;
        const list = definitionsByPartOfSpeech.get(partOfSpeech) || [];
        list.push({definition});
        definitionsByPartOfSpeech.set(partOfSpeech, list);
    }
    for (const [partOfSpeech, definitionsForPart] of definitionsByPartOfSpeech) addMeaning(card, partOfSpeech, definitionsForPart);
    return card;
}

export function parseWiktionaryRestEntry(entry: WiktionaryDefinitionEntry, normalizedWord: string): WordCardData {
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
