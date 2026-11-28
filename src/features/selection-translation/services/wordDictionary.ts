/**
 * @file src/features/selection-translation/services/wordDictionary.ts
 * 文件职责：实现划词英文词典的本地优先查询、在线限时并发补充、来源隔离缓存与默认查询入口。
 * 主要内容：组合 ECDICT 本地可选词库与五种在线词典适配器，按总预算竞争首份释义并在结算后取消剩余请求，统一导出词卡合并与各源解析函数。
 * 模块边界：本服务只编排词典查询与结果缓存，不渲染词卡、不翻译释义或加入词书；数据结构与合并归 wordCardMerge，原始响应解析归 wordDictionaryParsers。
 */
import {normalizeWordDictionarySource, type WordDictionaryProviderId, type WordDictionarySourceSetting} from '@/src/core/config/selectionDictionary';
import {readJsonResponse} from '@/src/platform/http/errors';
import {cancelUnreadResponseBody, createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {canCacheOptionalEcdict, downloadFullEcdict, readCachedFullEcdict, type EcdictCompactRow} from './ecdictAsset';
import {normalizeEnglishWord} from './wordNormalization';
import {
    hasUsefulData,
    mergeWordCardData,
    selectPronunciations,
    textValue,
    type WordCardData,
    type WordDefinition,
    type WordDictionarySource,
    type WordMeaning,
    type WordPronunciation,
} from './wordCardMerge';
import {
    parseDatamuseWord,
    parseEcdictEntry,
    parseFreeDictionaryEntry,
    parseWiktApiEntry,
    parseWiktionaryRestEntry,
    parseYoudaoResponse,
    type DatamuseWord,
    type FreeDictionaryEntry,
    type WiktApiEntry,
    type WiktApiResponse,
    type WiktionaryDefinitionEntry,
} from './wordDictionaryParsers';

export type {WordDictionaryProviderId} from '@/src/core/config/selectionDictionary';
export {
    mergeWordCardData,
    parseDatamuseWord,
    parseEcdictEntry,
    parseFreeDictionaryEntry,
    parseWiktApiEntry,
    parseYoudaoResponse,
    selectPronunciations,
    type WordCardData,
    type WordDefinition,
    type WordDictionarySource,
    type WordMeaning,
    type WordPronunciation,
};

const LOOKUP_TIMEOUT_MS = 4_000;
const LOOKUP_BUDGET_MS = 2_500;
const CHINA_PROVIDER_TIMEOUT_MS = 1_800;
const WIKTAPI_TIMEOUT_MS = 1_200;

function hasExtensionRuntime(): boolean {
    try {
        const extensionGlobal = globalThis as typeof globalThis & {
            browser?: {runtime?: {getURL?: (path: string) => string}};
            chrome?: {runtime?: {getURL?: (path: string) => string}};
        };
        const runtime = extensionGlobal.browser?.runtime || extensionGlobal.chrome?.runtime;
        return typeof runtime?.getURL === 'function';
    } catch {
        return false;
    }
}

async function fetchJson(url: string, timeoutMs = LOOKUP_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const abortContext = createRuntimeAbortContext(timeoutMs, signal);
    try {
        const response = await runtimeFetch(url, {
            credentials: 'omit',
            headers: {Accept: 'application/json'},
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
    type EcdictIndex = Map<string, EcdictCompactRow>;
    let optionalIndexPromise: Promise<EcdictIndex | null> | null = null;
    let optionalDownload: Promise<void> | null = null;
    let nextDownloadAt = 0;

    const indexRows = (entries: readonly EcdictCompactRow[]): EcdictIndex => {
        const index: EcdictIndex = new Map();
        for (const entry of entries) {
            index.set(entry[0].toLowerCase(), entry);
        }
        return index;
    };

    const loadOptionalIndex = (): Promise<EcdictIndex | null> => {
        if (!optionalIndexPromise) {
            optionalIndexPromise = readCachedFullEcdict()
                .then(rows => (rows ? indexRows(rows) : null))
                .catch(() => {
                    optionalIndexPromise = null;
                    return null;
                });
        }
        return optionalIndexPromise;
    };

    const startOptionalDownload = (): void => {
        if (optionalDownload || Date.now() < nextDownloadAt
            || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        // 当前词立即交给线上 provider；完整 20,000 词离线词库在后台经国内外多镜像校验缓存，后续查询本地命中。
        optionalDownload = downloadFullEcdict()
            .then(rows => { optionalIndexPromise = Promise.resolve(indexRows(rows)); })
            .catch(() => { nextDownloadAt = Date.now() + 30 * 60_000; })
            .finally(() => { optionalDownload = null; });
    };

    return {
        id: 'ecdict-local',
        async lookup(normalizedWord) {
            // Userscript 没有扩展运行时上下文；不能在宿主页面上下文中下载或缓存可选词库资产。
            if (!hasExtensionRuntime() || !canCacheOptionalEcdict()) return null;
            const optionalIndex = await loadOptionalIndex();
            if (!optionalIndex) {
                startOptionalDownload();
                return null;
            }
            const entry = optionalIndex.get(normalizedWord);
            if (!entry) return null;
            return parseEcdictEntry({w: entry[0], p: entry[1], d: entry[2], t: entry[3]}, normalizedWord);
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
    const payload = await fetchJson(`https://api.wiktapi.dev/v1/en/word/${encodeURIComponent(normalizedWord)}?lang=en`, WIKTAPI_TIMEOUT_MS, signal);
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
