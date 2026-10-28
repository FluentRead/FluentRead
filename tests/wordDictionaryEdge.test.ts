import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHash, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canCacheOptionalEcdict, downloadFullEcdict, readCachedFullEcdict} from '@/src/features/selection-translation/services/ecdictAsset';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {
    clearWordDictionaryCache,
    createDefaultWordDictionaryProviders,
    createWordDictionaryLookup,
    lookupWord,
    mergeWordCardData,
    normalizeEnglishWord,
    parseDatamuseWord,
    parseEcdictEntry,
    parseFreeDictionaryEntry,
    parseYoudaoResponse,
    parseWiktApiEntry,
    selectPronunciations,
    type WordCardData,
    type WordDictionaryProvider,
    type WordDictionaryProviderId,
} from '@/src/features/selection-translation/services/wordDictionary';

function response(payload: unknown, ok = true, status = ok ? 200 : 503): Response {
    return {ok, status, json: async () => payload} as Response;
}

function provider(providers: readonly WordDictionaryProvider[], id: WordDictionaryProviderId): WordDictionaryProvider {
    const match = providers.find((item) => item.id === id);
    if (!match) throw new Error(`missing provider ${id}`);
    return match;
}

function card(
    word: string,
    source: WordDictionaryProviderId = 'free-dictionary',
    options: {definition?: string; phonetic?: string} = {},
): WordCardData {
    return {
        word,
        normalizedWord: word,
        phonetics: options.phonetic === undefined ? [{text: '/test/'}] : options.phonetic ? [{text: options.phonetic}] : [],
        meanings: options.definition === undefined
            ? [{partOfSpeech: '名词', definitions: [{definition: 'an English definition'}]}]
            : options.definition
                ? [{partOfSpeech: '名词', definitions: [{definition: options.definition}]}]
                : [],
        sources: [{id: source, label: source, url: 'https://example.test/'}],
    };
}

afterEach(() => {
    clearWordDictionaryCache();
    setRuntimeFetch();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function optionalDictionaryCache() {
    const stored = new Map<string, Response>();
    const cache = {
        match: async (key: string) => stored.get(key)?.clone(),
        put: async (key: string, value: Response) => { stored.set(key, value.clone()); },
        delete: async (key: string) => stored.delete(key),
    };
    vi.stubGlobal('caches', {open: async () => cache});
    vi.stubGlobal('crypto', webcrypto);
    return {stored, cache};
}

const fullEcdictBytes = () => new Uint8Array(readFileSync(resolve(process.cwd(), 'assets/optional/ecdict-core-full.json')));

describe('optional full ECDICT asset', () => {
    it('does not download into a host page without an extension runtime', async () => {
        optionalDictionaryCache();
        const requested: string[] = [];
        setRuntimeFetch(async input => {
            requested.push(String(input));
            return new Response(fullEcdictBytes());
        });
        expect(await provider(createDefaultWordDictionaryProviders(), 'ecdict-local').lookup('puma')).toBeNull();
        expect(requested).toEqual([]);
    });

    it('does not start an optional download when persistent cache support is unavailable', async () => {
        vi.stubGlobal('caches', undefined);
        expect(canCacheOptionalEcdict()).toBe(false);
        expect(await readCachedFullEcdict()).toBeNull();
        await expect(downloadFullEcdict()).rejects.toThrow('cache unavailable');
    });

    it('validates the fixed asset, falls back to a second source and reuses the cached copy', async () => {
        const {stored} = optionalDictionaryCache();
        const bytes = fullEcdictBytes();
        const requested: string[] = [];
        setRuntimeFetch(async input => {
            requested.push(String(input));
            return new Response(requested.length === 1 ? new Uint8Array([1, 2, 3]) : bytes);
        });

        const rows = await downloadFullEcdict();
        expect(rows).toHaveLength(20_000);
        expect(rows.every(row => Array.isArray(row) && row.length === 4 && row.every(cell => typeof cell === 'string'))).toBe(true);
        expect(rows.at(-1)?.[0]).toBe('bis');
        expect(requested).toHaveLength(2);
        expect(requested.every(url => !url.includes('puma') && url.includes('ecdict-core.json'))).toBe(true);
        expect(stored.size).toBe(1);
        expect((await readCachedFullEcdict())?.at(-1)?.[0]).toBe('bis');
    });

    it('rejects a tampered cache entry and an oversized download before accepting a valid source', async () => {
        const {stored} = optionalDictionaryCache();
        const bytes = fullEcdictBytes();
        stored.set('https://fluentread.app/__optional_assets__/ecdict/b0f0768e6730dfd07b895527ff56169f4d44904c58532b4cdd750aa97374071a.json',
            new Response(new Uint8Array(bytes.length)));
        expect(await readCachedFullEcdict()).toBeNull();
        expect(stored.size).toBe(0);

        let attempts = 0;
        setRuntimeFetch(async () => new Response(++attempts === 1 ? new Uint8Array(bytes.length + 1) : bytes));
        expect(await downloadFullEcdict()).toHaveLength(20_000);
        expect(attempts).toBe(2);
    });

    it('releases HTTP failures, skips missing bodies and keeps validated rows when cache writes fail', async () => {
        const {cache} = optionalDictionaryCache();
        vi.spyOn(cache, 'put').mockRejectedValue(new Error('Cache quota exceeded'));
        const cancel = vi.fn(async () => {});
        const fetch = vi.fn().mockResolvedValueOnce({ok:false, status:503, body:{cancel}})
            .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(new Response(fullEcdictBytes()));
        setRuntimeFetch(fetch);
        expect(await downloadFullEcdict()).toHaveLength(20_000);
        expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(3);
        vi.stubGlobal('caches', {open: vi.fn(async () => {throw new Error('Cache blocked');})});
        expect(await readCachedFullEcdict()).toBeNull();
    });

    it('serves uncommon words after background download while keeping the first lookup nonblocking', async () => {
        const {stored} = optionalDictionaryCache();
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://fixture/ecdict-core.json'}});
        const core = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/ecdict-core.json')));
        const full = fullEcdictBytes();
        const requested: string[] = [];
        setRuntimeFetch(async input => {
            requested.push(String(input));
            return new Response(String(input).startsWith('moz-extension:') ? core : full);
        });
        const local = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');

        expect(await local.lookup('puma')).toBeNull();
        await vi.waitFor(() => expect(stored.size).toBe(1));
        await vi.waitFor(async () => expect((await local.lookup('puma'))?.word).toBe('puma'));
        expect(requested.filter(url => url.startsWith('moz-extension:'))).toHaveLength(1);
        expect(requested.filter(url => url.startsWith('https:'))).toHaveLength(1);

        const reopened = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');
        expect((await reopened.lookup('puma'))?.word).toBe('puma');
        expect(requested.filter(url => url.startsWith('https:'))).toHaveLength(1);
    });

    it('waits for connectivity and deduplicates an in-flight optional download', async () => {
        optionalDictionaryCache();
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://fixture/ecdict-core.json'}});
        vi.stubGlobal('navigator', {onLine: false});
        const core = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/ecdict-core.json')));
        const full = fullEcdictBytes();
        const pending: Array<(response: Response) => void> = [];
        setRuntimeFetch(async input => String(input).startsWith('moz-extension:')
            ? new Response(core)
            : new Promise<Response>(resolve => { pending.push(resolve); }));
        const local = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');

        expect(await local.lookup('puma')).toBeNull();
        expect(pending).toHaveLength(0);
        vi.stubGlobal('navigator', {onLine: true});
        expect(await local.lookup('puma')).toBeNull();
        expect(await local.lookup('bis')).toBeNull();
        expect(pending).toHaveLength(1);
        pending[0](new Response(full));
        await vi.waitFor(async () => expect((await local.lookup('bis'))?.word).toBe('bis'));
        expect(pending).toHaveLength(1);
    });

    it('backs off after all fixed asset mirrors fail', async () => {
        optionalDictionaryCache();
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://fixture/ecdict-core.json'}});
        const core = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/ecdict-core.json')));
        let remoteRequests = 0;
        setRuntimeFetch(async input => {
            if (String(input).startsWith('moz-extension:')) return new Response(core);
            remoteRequests += 1;
            return new Response('', {status: 503});
        });
        const local = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');

        expect(await local.lookup('puma')).toBeNull();
        await vi.waitFor(() => expect(remoteRequests).toBe(3));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(await local.lookup('bis')).toBeNull();
        expect(remoteRequests).toBe(3);
    });
});

describe('word dictionary Unicode and untrusted payload boundaries', () => {
    it('normalizes typographic punctuation but rejects empty, oversized and confusable input', () => {
        expect(normalizeEnglishWord("  Rockʼn’Roll  ")).toBe("rock'n'roll");
        expect(normalizeEnglishWord('mother–in‑law')).toBe('mother-in-law');
        expect(normalizeEnglishWord('a'.repeat(64))).toBe('a'.repeat(64));
        expect(normalizeEnglishWord('')).toBeNull();
        expect(normalizeEnglishWord(null as unknown as string)).toBeNull();
        expect(normalizeEnglishWord('a'.repeat(65))).toBeNull();
        expect(normalizeEnglishWord('paypa\u200bl')).toBeNull();
        expect(normalizeEnglishWord('раypal')).toBeNull();
        expect(normalizeEnglishWord('-word')).toBeNull();
    });

    it('accepts only credential-free HTTPS audio URLs and sanitizes dictionary markup', () => {
        const parsed = parseFreeDictionaryEntry({
            phonetics: [
                null,
                {},
                {audio: 'http://cdn.example.test/insecure.mp3'},
                {audio: 'https://user:secret@cdn.example.test/private.mp3'},
                {audio: 'not a url'},
                {audio: '//cdn.example.test/word-uk.mp3'},
                {text: '/us/', audio: 'https://cdn.example.test/word-us.mp3'},
                {text: '/plain/', audio: 'https://cdn.example.test/plain.mp3'},
            ],
            meanings: [
                null,
                {partOfSpeech: 'noun', definitions: 'invalid'},
                {partOfSpeech: 'custom.', definitions: [
                    null,
                    {definition: '<b>A&nbsp;word</b> &amp; sign &#39;x&#x27; &quot;y&quot;', example: '<i>Example</i>'},
                    {definition: '   '},
                ]},
            ],
            phonetic: '/fallback/',
            origin: '<strong>Old&nbsp;origin</strong>',
        }, 'word');

        expect(parsed.phonetics).toEqual([
            {audio: 'https://cdn.example.test/word-uk.mp3', label: '英式'},
            {text: '/us/', audio: 'https://cdn.example.test/word-us.mp3', label: '美式'},
            {text: '/plain/', audio: 'https://cdn.example.test/plain.mp3'},
            {text: '/fallback/'},
        ]);
        expect(parsed.meanings).toEqual([{
            partOfSpeech: 'custom.',
            definitions: [{definition: "A word & sign 'x' \"y\"", example: 'Example'}],
        }]);
        expect(parsed.origin).toBe('Old origin');
    });

    it('merges translations, examples, audio and labels without duplicate rows', () => {
        const base: WordCardData = {
            word: '', normalizedWord: '',
            phonetics: [{text: '/same/'}, {audio: 'https://cdn.example.test/audio.mp3'}],
            meanings: [{partOfSpeech: '名词', definitions: [
                {definition: 'same'},
                {definition: '中文释义'},
                {definition: 'English sense', translatedDefinition: '已有翻译'},
            ]}],
            sources: [],
        };
        const addition: WordCardData = {
            word: 'word', normalizedWord: 'word', origin: 'origin',
            phonetics: [
                {text: '/same/', audio: 'https://cdn.example.test/same.mp3', label: '美式'},
                {audio: 'https://cdn.example.test/audio.mp3', label: '英式'},
                {},
            ],
            meanings: [{partOfSpeech: 'noun', definitions: [{
                definition: 'same', example: 'An example', translatedDefinition: '相同', translatedExample: '一个例子',
            }]}, {partOfSpeech: '名词', definitions: [
                {definition: 'Replacement English', example: 'Replacement example', translatedExample: '替换例句'},
                {definition: '新增中文'},
                {definition: '已有翻译'},
            ]}],
            sources: [{id: 'wiktapi', label: 'WiktApi', url: 'https://wiktapi.dev/'}],
        };

        const merged = mergeWordCardData(base, addition);

        expect(merged).toMatchObject({word: 'word', normalizedWord: 'word', origin: 'origin'});
        expect(merged.phonetics).toEqual([
            {text: '/same/', audio: 'https://cdn.example.test/same.mp3', label: '美式'},
            {audio: 'https://cdn.example.test/audio.mp3', label: '英式'},
        ]);
        expect(merged.meanings[0]?.definitions[0]).toEqual({
            definition: 'same', example: 'An example',
            translatedDefinition: '相同；新增中文；已有翻译', translatedExample: '一个例子',
        });
        expect(merged.meanings[0]?.definitions[1]).toEqual({
            definition: 'Replacement English', example: 'Replacement example', translatedExample: '替换例句',
        });
        expect(merged.meanings[0]?.definitions[2]?.translatedDefinition).toBe('已有翻译');
        expect(merged.sources.map((source) => source.id)).toEqual(['wiktapi']);
        expect(mergeWordCardData(merged, {
            word: '', normalizedWord: '', phonetics: [], meanings: [], sources: [],
        }).normalizedWord).toBe('word');
    });

    it('enforces definition and meaning caps while preserving distinct senses', () => {
        const definitions = Array.from({length: 8}, (_, index) => ({definition: `sense ${index}`}));
        const initial = mergeWordCardData(null, {
            word: 'cap', normalizedWord: 'cap', phonetics: [],
            meanings: [{partOfSpeech: '', definitions}, {partOfSpeech: 'noun', definitions: []}],
            sources: [],
        });
        for (const partOfSpeech of ['verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'article']) {
            mergeWordCardData(initial, {
                word: 'cap', normalizedWord: 'cap', phonetics: [], sources: [],
                meanings: [{partOfSpeech, definitions: [{definition: partOfSpeech}]}],
            });
        }
        mergeWordCardData(initial, {
            word: 'cap', normalizedWord: 'cap', phonetics: [], sources: [],
            meanings: [{partOfSpeech: '其他', definitions: [{definition: 'sense 0'}, {definition: 'sense 9'}]}],
        });

        expect(initial.meanings).toHaveLength(6);
        expect(initial.meanings[0]?.partOfSpeech).toBe('其他');
        expect(initial.meanings[0]?.definitions).toHaveLength(6);
    });

    it('attaches a later Chinese gloss to an untranslated English sense', () => {
        const base = card('pair');
        const merged = mergeWordCardData(base, card('pair', 'youdao-web', {definition: '中文释义'}));
        expect(merged.meanings[0].definitions).toEqual([{definition: 'an English definition', translatedDefinition: '中文释义'}]);
    });

    it('selects at most two unlabelled pronunciations and handles a single regional row', () => {
        expect(selectPronunciations([{text: 'a'}, {text: 'b'}, {text: 'c'}])).toEqual([{text: 'a'}, {text: 'b'}]);
        expect(selectPronunciations([
            {text: '/weak/', label: '美式'},
            {text: '/ˈprimary/', label: '美式'},
        ])).toEqual([{text: '/ˈprimary/', label: '美式'}]);
        expect(selectPronunciations([
            {audio: 'https://cdn.example.test/plain.mp3', label: '美式'},
            {audio: 'https://cdn.example.test/primary.mp3', label: '美式'},
        ])).toEqual([{audio: 'https://cdn.example.test/primary.mp3', label: '美式'}]);
    });
});

describe('word dictionary defensive provider parsing', () => {
    it('covers empty and mismatched ECDICT rows and fallback translation pairing', () => {
        expect(parseEcdictEntry({}, 'empty')).toEqual({
            word: 'empty', normalizedWord: 'empty', phonetics: [], meanings: [],
            sources: [{id: 'ecdict-local', label: 'ECDICT 本地词库', url: 'https://github.com/skywind3000/ECDICT'}],
        });
        const parsed = parseEcdictEntry({
            w: 'Pair', p: '<i>peə</i>',
            d: 'n. first definition\nsecond definition\nv. third definition',
            t: 'v. 第三个定义\nn. 第一个定义', pos: 'n./v.',
        }, 'pair');

        expect(parsed.word).toBe('Pair');
        expect(parsed.phonetics).toEqual([{text: '/peə/'}]);
        expect(parsed.meanings).toEqual([
            {partOfSpeech: '名词', definitions: [
                {definition: 'first definition', translatedDefinition: '第一个定义'},
                {definition: 'second definition'},
            ]},
            {partOfSpeech: '动词', definitions: [{definition: 'third definition', translatedDefinition: '第三个定义'}]},
        ]);
    });

    it('handles alternate Youdao shapes, invalid rows and pronunciation candidates', () => {
        expect(parseYoudaoResponse(null, 'word').meanings).toEqual([]);
        expect(parseYoudaoResponse({ec: {word: 'invalid'}}, 'word').phonetics).toEqual([]);
        const parsed = parseYoudaoResponse({
            ec: {word: {ukphone: 'fallback; ignored', trs: [null, {pos: '', tran: '   '}, {pos: 'adj.', tran: '<b>可用</b>'}]}},
            simple: {word: [null, {multiPhone: {uk: [null, {}, {phone: 'wə'}, {phone: 'ˈwɜːd', speech: 'word&type=1'}]}}]},
        }, 'word');

        expect(parsed.phonetics).toEqual([{
            text: '/ˈwɜːd/', audio: 'https://dict.youdao.com/dictvoice?word&type=1', label: '英式',
        }]);
        expect(parsed.meanings[0]).toEqual({
            partOfSpeech: '形容词', definitions: [{definition: '可用', translatedDefinition: '可用'}],
        });
        expect(parseYoudaoResponse({ec: {word: {ukphone: 'uk'}}, simple: 'invalid'}, 'word').phonetics[0]?.audio)
            .toBe('https://dict.youdao.com/dictvoice?audio=word&type=1');
        expect(parseYoudaoResponse({
            ec: {word: {}},
            simple: [{multiPhone: {uk: [{phone: 'ˈnoaudio'}]}}],
        }, 'word').phonetics).toEqual([{
            text: '/ˈnoaudio/', audio: 'https://dict.youdao.com/dictvoice?audio=word&type=1', label: '英式',
        }]);
    });

    it('defensively parses Free Dictionary, WiktApi and Datamuse variants', () => {
        expect(parseFreeDictionaryEntry({word: 1, phonetics: 'invalid', meanings: 'invalid', origin: 1}, 'free'))
            .toMatchObject({word: 'free', phonetics: [], meanings: []});

        const wikt = parseWiktApiEntry({
            word: 'sound',
            senses: [null, {glosses: 'invalid'}, {glosses: [null, 'a sound'], examples: [null, {text: ''}, {text: 'Sound example.'}]}],
            sounds: [
                null,
                {enpr: 'saund', ogg_url: '//cdn.example.test/sound.ogg', tags: ['British']},
                {audio: 'https://cdn.example.test/sound.mp3', tags: ['US']},
                {ipa: '/other/', tags: 'invalid'},
            ],
        }, 'sound');
        expect(wikt.meanings[0]?.definitions).toEqual([{definition: 'a sound', example: 'Sound example.'}]);
        expect(wikt.phonetics.map((item) => item.label)).toEqual(['英式', '美式', undefined]);
        expect(parseWiktApiEntry({senses: 'invalid', sounds: 'invalid'}, 'empty')).toMatchObject({
            meanings: [], phonetics: [],
        });

        expect(parseDatamuseWord({word: 'other'}, 'word').meanings).toEqual([]);
        const datamuse = parseDatamuseWord({word: 'word', tags: 'invalid', defs: ['', 'A definition without tag', 'v\tto express', 'v\tto state']}, 'word');
        expect(datamuse.meanings).toEqual([
            {partOfSpeech: '其他', definitions: [{definition: 'A definition without tag'}]},
            {partOfSpeech: '动词', definitions: [{definition: 'to express'}, {definition: 'to state'}]},
        ]);
        expect(parseDatamuseWord({word: 'word', tags: ['pron:/wɜːd/'], defs: 'invalid'}, 'word').phonetics)
            .toEqual([{text: '/wɜːd/'}]);
    });
});

describe('word dictionary provider network adapters', () => {
    it('ships the first 3,000 frequency-ranked entries and preserves the full optional asset', () => {
        const core = JSON.parse(readFileSync(resolve(process.cwd(), 'public/ecdict-core.json'), 'utf8')) as string[][];
        const rows = JSON.parse(readFileSync(resolve(process.cwd(), 'assets/optional/ecdict-core-full.json'), 'utf8')) as string[][];
        expect(core).toHaveLength(3_000);
        expect(rows).toHaveLength(20_000);
        expect(rows.every(row => Array.isArray(row) && row.length === 4 && row.every(cell => typeof cell === 'string'))).toBe(true);
        expect(core).toEqual(rows.slice(0, 3_000));
        expect(rows.every(row => row.length === 4 && row.every(value => typeof value === 'string'))).toBe(true);
        const originalShape = rows.map(([w, p, d, t]) => ({w, p, d, t, pos: ''}));
        expect(createHash('sha256').update(JSON.stringify(originalShape)).digest('hex'))
            .toBe('e50fd32d4a859b184fd5bae15d0278e6bf2b621acbe5c854bf460817668c8822');
    });

    it('loads and memoizes the browser-local ECDICT index while filtering malformed rows', async () => {
        const getURL = vi.fn(() => 'moz-extension://fixture/ecdict-core.json');
        vi.stubGlobal('browser', {runtime: {getURL}});
        const fetchMock = vi.fn(async () => response([null, {}, {w: ''}, ['broken'], ['Local', 'ləʊkəl', 'adj. local', 'adj. 本地']]));
        vi.stubGlobal('fetch', fetchMock);
        const local = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');

        expect(await local.lookup('missing')).toBeNull();
        expect((await local.lookup('local'))?.meanings[0]?.definitions[0]).toEqual({definition: 'local', translatedDefinition: '本地'});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getURL).toHaveBeenCalledWith('ecdict-core.json');
    });

    it('supports chrome runtime, no runtime and throwing runtime access', async () => {
        vi.stubGlobal('chrome', {runtime: {getURL: () => 'chrome-extension://fixture/ecdict-core.json'}});
        vi.stubGlobal('fetch', vi.fn(async () => response('not-an-array')));
        expect(await provider(createDefaultWordDictionaryProviders(), 'ecdict-local').lookup('word')).toBeNull();

        vi.unstubAllGlobals();
        expect(await provider(createDefaultWordDictionaryProviders(), 'ecdict-local').lookup('word')).toBeNull();

        vi.stubGlobal('browser', {get runtime(): never { throw new Error('runtime unavailable'); }});
        expect(await provider(createDefaultWordDictionaryProviders(), 'ecdict-local').lookup('word')).toBeNull();
    });

    it('retries the local index after a transient response failure', async () => {
        vi.stubGlobal('browser', {runtime: {getURL: () => 'moz-extension://fixture/ecdict-core.json'}});
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({}, false, 500))
            .mockResolvedValueOnce(response([{w: 'recover', d: 'v. recover'}]));
        vi.stubGlobal('fetch', fetchMock);
        const local = provider(createDefaultWordDictionaryProviders(), 'ecdict-local');

        await expect(local.lookup('recover')).rejects.toThrow('local dictionary request failed: 500');
        expect((await local.lookup('recover'))?.meanings[0]?.definitions[0]?.definition).toBe('recover');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('validates each remote provider payload and merges only matching English entries', async () => {
        const providers = createDefaultWordDictionaryProviders();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('dict.youdao.com')) return response({ec: {word: {usphone: 'us', trs: [{pos: 'n', tran: '词'}]}}});
            if (url.includes('dictionaryapi.dev')) return response([null, {word: 'word', meanings: [{partOfSpeech: 'noun', definitions: [{definition: 'definition'}]}]}]);
            if (url.includes('api.datamuse.com')) return response([null, {word: 'other'}, {word: 'word', defs: ['n\tdefinition']}]);
            if (url.includes('en.wiktionary.org')) return response({en: [
                null,
                {partOfSpeech: 'verb', definitions: 'invalid'},
                {partOfSpeech: 'noun', definitions: [
                    null,
                    {definition: '<b>definition</b>', examples: [null, {example: ''}, {example: 'example'}]},
                    {definition: 'without example', examples: 'invalid'},
                ]},
            ]});
            if (url.includes('api.wiktapi.dev')) return response({entries: [null, {lang_code: 'fr', senses: [{glosses: ['French']}]}, {lang_code: '', pos: 'noun', senses: [{glosses: ['English']}]}]});
            throw new Error(`unexpected ${url}`);
        }));

        expect((await provider(providers, 'youdao-web').lookup('word'))?.phonetics).toHaveLength(1);
        expect((await provider(providers, 'free-dictionary').lookup('word'))?.meanings[0]?.definitions[0]?.definition).toBe('definition');
        expect((await provider(providers, 'datamuse').lookup('word'))?.meanings[0]?.definitions[0]?.definition).toBe('definition');
        expect((await provider(providers, 'wiktionary-rest').lookup('word'))?.meanings[0]?.definitions).toEqual([
            {definition: 'definition', example: 'example'},
            {definition: 'without example'},
        ]);
        expect((await provider(providers, 'wiktapi').lookup('word'))?.meanings[0]?.definitions[0]?.definition).toBe('English');
    });

    it.each([404, 429])('releases unused HTTP %s response bodies before finishing dictionary lookups', async status => {
        const cancel = vi.fn(async () => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status, body: {cancel}})));
        const pending = provider(createDefaultWordDictionaryProviders(), 'youdao-web').lookup('word');
        if (status === 404) expect(await pending).toBeNull();
        else await expect(pending).rejects.toThrow('dictionary request failed: 429');
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('returns null for structurally invalid remote payloads and rejects HTTP/JSON failures', async () => {
        const providers = createDefaultWordDictionaryProviders();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({}, false, 429))
            .mockResolvedValueOnce({ok: true, status: 200, json: async () => { throw new SyntaxError('secret'); }} as unknown as Response)
            .mockResolvedValue(response(null));
        vi.stubGlobal('fetch', fetchMock);

        await expect(provider(providers, 'youdao-web').lookup('word')).rejects.toThrow('dictionary request failed: 429');
        await expect(provider(providers, 'free-dictionary').lookup('word')).rejects.toThrow('dictionary response is not valid JSON');
        expect(await provider(providers, 'free-dictionary').lookup('word')).toBeNull();
        expect(await provider(providers, 'datamuse').lookup('word')).toBeNull();
        expect(await provider(providers, 'wiktionary-rest').lookup('word')).toBeNull();
        expect(await provider(providers, 'wiktapi').lookup('word')).toBeNull();
    });

    it('treats empty provider-specific containers as a clean miss', async () => {
        const providers = createDefaultWordDictionaryProviders();
        const payloads = [{}, {entries: 'invalid'}, {en: 'invalid'}];
        vi.stubGlobal('fetch', vi.fn(async () => response(payloads.shift())));

        expect(await provider(providers, 'youdao-web').lookup('word')).toBeNull();
        expect(await provider(providers, 'wiktapi').lookup('word')).toBeNull();
        expect(await provider(providers, 'wiktionary-rest').lookup('word')).toBeNull();
    });

    it('aborts a slow WiktApi request at its provider timeout', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })));
        const pending = provider(createDefaultWordDictionaryProviders(), 'wiktapi').lookup('slow');
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(1_200);
        await rejected;
    });
});

describe('word dictionary lookup orchestration', () => {
    it('validates cache capacity', () => {
        expect(() => createWordDictionaryLookup({cacheSize: 0})).toThrow('词典缓存容量必须是正整数');
        expect(() => createWordDictionaryLookup({cacheSize: 1.5})).toThrow('词典缓存容量必须是正整数');
    });

    it('caches positive and negative results and clearCache makes them queryable again', async () => {
        const lookup = vi.fn(async (word: string) => word === 'found' ? card(word) : null);
        const dictionary = createWordDictionaryLookup({providers: [{id: 'free-dictionary', lookup}], cacheSize: 2});

        expect(await dictionary.lookup('found')).not.toBeNull();
        expect(await dictionary.lookup('FOUND')).not.toBeNull();
        expect(await dictionary.lookup('missing')).toBeNull();
        expect(await dictionary.lookup('missing')).toBeNull();
        expect(lookup).toHaveBeenCalledTimes(2);
        dictionary.clearCache();
        expect(await dictionary.lookup('found')).not.toBeNull();
        expect(lookup).toHaveBeenCalledTimes(3);
    });

    it('deduplicates concurrent lookups and evicts the oldest cached result', async () => {
        let release: ((value: WordCardData) => void) | undefined;
        const slowLookup = vi.fn((_word: string) => new Promise<WordCardData>((resolve) => { release = resolve; }));
        const concurrent = createWordDictionaryLookup({providers: [{id: 'free-dictionary', lookup: slowLookup}], cacheSize: 1});
        const first = concurrent.lookup('same');
        const second = concurrent.lookup('same');
        release?.(card('same'));
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(slowLookup).toHaveBeenCalledTimes(1);

        const eagerLookup = vi.fn(async (word: string) => card(word));
        const eviction = createWordDictionaryLookup({providers: [{id: 'free-dictionary', lookup: eagerLookup}], cacheSize: 1});
        await eviction.lookup('one');
        await eviction.lookup('two');
        await eviction.lookup('one');
        expect(eagerLookup).toHaveBeenCalledTimes(3);
    });

    it('isolates local failures and returns local definitions without waiting for pronunciation or online backups', async () => {
        const warning = vi.fn();
        const neverReached = vi.fn(async () => card('word'));
        const dictionary = createWordDictionaryLookup({
            warn: warning,
            providers: [
                {id: 'ecdict-local', lookup: async () => { throw new Error('local failed'); }},
                {id: 'ecdict-local', lookup: async () => ({
                    word: 'word', normalizedWord: 'word', phonetics: [], meanings: [], sources: [],
                })},
                {id: 'ecdict-local', lookup: async () => card('word', 'ecdict-local', {phonetic: ''})},
                {id: 'youdao-web', lookup: async () => card('word', 'youdao-web', {definition: '中文', phonetic: ''})},
                {id: 'free-dictionary', lookup: async () => card('word', 'free-dictionary', {phonetic: ''})},
                {id: 'datamuse', lookup: async () => card('word', 'datamuse')},
                {id: 'wiktapi', lookup: neverReached},
            ],
        });

        const result = await dictionary.lookup('word');
        expect(result?.sources.map((source) => source.id)).toEqual(['ecdict-local']);
        expect(warning).toHaveBeenCalledOnce();
        expect(neverReached).not.toHaveBeenCalled();
    });

    it('uses the default warning sink and skips providers for invalid input', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const providerLookup = vi.fn(async () => { throw new Error('offline'); });
        const dictionary = createWordDictionaryLookup({providers: [{id: 'datamuse', lookup: providerLookup}]});

        expect(await dictionary.lookup('two words')).toBeNull();
        expect(providerLookup).not.toHaveBeenCalled();
        await expect(dictionary.lookup('valid')).rejects.toThrow('词典查询暂时不可用');
        expect(warning).toHaveBeenCalledOnce();
    });

    it('keeps the exported default lookup and cache reset operational', async () => {
        const fetchMock = vi.fn(async () => response({ec: {word: {usphone: 'v', trs: [{pos: 'n', tran: 'valid 有效'}]}}}));
        vi.stubGlobal('fetch', fetchMock);
        expect(await lookupWord('edgecache')).not.toBeNull();
        expect(await lookupWord('edgecache')).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(5);
        clearWordDictionaryCache();
        expect(await lookupWord('edgecache')).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it('returns a fast online definition and aborts a slower source instead of waiting for it', async () => {
        let slowSignal: AbortSignal | undefined;
        const slow = vi.fn((_word: string, signal?: AbortSignal) => {
            slowSignal = signal;
            return new Promise<WordCardData | null>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
            });
        });
        const fast = vi.fn(async () => card('uncommon'));
        const dictionary = createWordDictionaryLookup({providers: [
            {id: 'youdao-web', lookup: slow}, {id: 'free-dictionary', lookup: fast},
        ]});
        expect((await dictionary.lookup('uncommon'))?.meanings).toHaveLength(1);
        expect(slow).toHaveBeenCalledOnce();
        expect(fast).toHaveBeenCalledOnce();
        expect(slowSignal?.aborted).toBe(true);
    });

    it('bounds a hanging lookup at 2.5 seconds and does not cache the outage as a missing word', async () => {
        vi.useFakeTimers();
        const lookup = vi.fn<WordDictionaryProvider['lookup']>()
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValueOnce(card('recover'));
        const dictionary = createWordDictionaryLookup({providers: [{id: 'free-dictionary', lookup}]});
        const pending = dictionary.lookup('recover');
        const rejected = expect(pending).rejects.toThrow('词典查询暂时不可用');
        await vi.advanceTimersByTimeAsync(2_499);
        expect(lookup.mock.calls[0][1]?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(lookup.mock.calls[0][1]?.aborted).toBe(true);
        expect(await dictionary.lookup('recover')).not.toBeNull();
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('keeps a partial pronunciation if other sources time out and ignores their late response', async () => {
        vi.useFakeTimers();
        let release!: (data: WordCardData) => void;
        const dictionary = createWordDictionaryLookup({providers: [
            {id: 'youdao-web', lookup: async () => card('partial', 'youdao-web', {definition: ''})},
            {id: 'free-dictionary', lookup: () => new Promise(resolve => { release = resolve; })},
        ]});
        const pending = dictionary.lookup('partial');
        await vi.advanceTimersByTimeAsync(2_500);
        const result = await pending;
        expect(result?.phonetics).toHaveLength(1);
        expect(result?.meanings).toEqual([]);
        release(card('partial'));
        await Promise.resolve();
        expect(result?.meanings).toEqual([]);
    });

    it('ends a stuck local lookup without starting online requests after its deadline', async () => {
        vi.useFakeTimers();
        let release!: (data: null) => void;
        const online = vi.fn(async () => card('stuck'));
        const dictionary = createWordDictionaryLookup({providers: [
            {id: 'ecdict-local', lookup: () => new Promise(resolve => { release = resolve; })},
            {id: 'free-dictionary', lookup: online},
        ]});
        const rejected = expect(dictionary.lookup('stuck')).rejects.toThrow('词典查询暂时不可用');
        await vi.advanceTimersByTimeAsync(2_500);
        await rejected;
        release(null);
        await Promise.resolve();
        await Promise.resolve();
        expect(online).not.toHaveBeenCalled();
    });

    it('treats dictionary 404s as clean misses, without warnings or repeated requests for the same word', async () => {
        const warn = vi.fn();
        const fetchMock = vi.fn(async () => response({}, false, 404));
        vi.stubGlobal('fetch', fetchMock);
        const dictionary = createWordDictionaryLookup({warn});
        expect(await dictionary.lookup('zzqmissing')).toBeNull();
        expect(await dictionary.lookup('zzqmissing')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not retain negative results when any source failed and succeeds after recovery', async () => {
        const lookup = vi.fn<WordDictionaryProvider['lookup']>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(card('recovered'));
        const dictionary = createWordDictionaryLookup({warn: vi.fn(), providers: [
            {id: 'youdao-web', lookup}, {id: 'free-dictionary', lookup: async () => null},
        ]});
        await expect(dictionary.lookup('recovered')).rejects.toThrow('词典查询暂时不可用');
        expect(await dictionary.lookup('recovered')).not.toBeNull();
    });
});

it('falls back to the next dictionary source without waiting for an oversized stream cancellation handshake', async () => {
    optionalDictionaryCache();let release!:()=>void;
    const cancel=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(3_913_557));},cancel});
    const fetch=vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response(fullEcdictBytes()));
    setRuntimeFetch(fetch);
    const download=downloadFullEcdict();let settled=false;void download.then(()=>{settled=true;});
    await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());
    const promptly=await Promise.race([download.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
    release();await download;
    expect(promptly).toBe(true);expect(settled).toBe(true);expect(body.locked).toBe(false);expect(fetch).toHaveBeenCalledTimes(2);
});

it('removes an oversized cached dictionary without waiting for a late failing cancellation', async () => {
    const {cache}=optionalDictionaryCache();let fail!: (error:Error)=>void;
    const cancel=vi.fn(()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(3_913_557));},cancel});
    vi.spyOn(cache,'match').mockResolvedValueOnce(new Response(body));
    const remove=vi.spyOn(cache,'delete');const read=readCachedFullEcdict();
    await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());
    const promptly=await Promise.race([read.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
    fail(new Error('late cache stream cancellation failure'));await read;
    expect(promptly).toBe(true);expect(remove).toHaveBeenCalledOnce();expect(body.locked).toBe(false);
    await new Promise(resolve=>setTimeout(resolve,0));
});
