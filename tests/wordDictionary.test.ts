import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearWordDictionaryCache,
    isSingleEnglishWord,
    lookupWord,
    mergeWordCardData,
    normalizeEnglishWord,
    parseDatamuseWord,
    parseEcdictEntry,
    parseFreeDictionaryEntry,
    parseYoudaoResponse,
    parseWiktApiEntry,
    selectPronunciations,
} from '@/src/features/selection-translation/services/wordDictionary';

function response(payload: unknown, ok = true, status = ok ? 200 : 503): Response {
    return {
        ok,
        status,
        json: async () => payload,
    } as Response;
}

afterEach(() => {
    clearWordDictionaryCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('word selection normalization', () => {
    it('accepts one English word and normalizes smart apostrophes', () => {
        expect(normalizeEnglishWord('  Don’t  ')).toBe("don't");
        expect(isSingleEnglishWord('mother-in-law')).toBe(true);
        expect(isSingleEnglishWord('hello world')).toBe(false);
        expect(isSingleEnglishWord('hello!')).toBe(false);
        expect(isSingleEnglishWord('你好')).toBe(false);
    });
});

describe('word dictionary provider adapters', () => {
    it('normalizes Free Dictionary fields including IPA, audio, meanings and examples', () => {
        const card = parseFreeDictionaryEntry({
            word: 'hello',
            phonetics: [{ text: '/həˈloʊ/', audio: 'https://api.example.test/hello-us.mp3' }],
            meanings: [{
                partOfSpeech: 'noun',
                definitions: [{ definition: 'a greeting', example: 'Hello, everyone.' }],
            }],
            sourceUrls: ['https://en.wiktionary.org/wiki/hello'],
        }, 'hello');

        expect(card.phonetics).toEqual([{ text: '/həˈloʊ/', audio: 'https://api.example.test/hello-us.mp3', label: '美式' }]);
        expect(card.meanings).toEqual([{
            partOfSpeech: '名词',
            definitions: [{ definition: 'a greeting', example: 'Hello, everyone.' }],
        }]);
        expect(card.sources[0]?.url).toBe('https://dictionaryapi.dev/');
    });

    it('collapses duplicate IPA rows while keeping the first playable audio', () => {
        const card = parseFreeDictionaryEntry({
            word: 'single',
            phonetics: [
                { text: '/ˈsɪŋɡəl/', audio: 'https://api.example.test/single-us.mp3' },
                { text: '/ˈsɪŋɡəl/', audio: 'https://api.example.test/single-us-alt.mp3' },
            ],
        }, 'single');

        expect(card.phonetics).toHaveLength(1);
        expect(card.phonetics[0]?.audio).toBe('https://api.example.test/single-us.mp3');
    });

    it('keeps one preferred stressed pronunciation for each regional variety', () => {
        const pronunciations = selectPronunciations([
            { text: '/jə/', audio: 'https://api.example.test/you-au-us-unstressed.mp3', label: '美式' },
            { text: '/ju/', audio: 'https://api.example.test/you-us-stressed.mp3', label: '美式' },
            { text: '/juː/', audio: 'https://api.example.test/you-uk-stressed.mp3', label: '英式' },
            { text: '/jʉː/' },
        ]);

        expect(pronunciations.map(pronunciation => pronunciation.label)).toEqual(['美式', '英式']);
        expect(pronunciations.map(pronunciation => pronunciation.text)).toEqual(['/ju/', '/juː/']);
    });

    it('normalizes structured WiktApi senses and Wikimedia audio', () => {
        const card = parseWiktApiEntry({
            word: 'hello',
            pos: 'interjection',
            lang_code: 'en',
            senses: [{ glosses: ['a greeting'], examples: [{ text: 'Hello there.' }] }],
            sounds: [{ ipa: '/həˈloʊ/', mp3_url: 'https://upload.wikimedia.org/hello.mp3', tags: ['General-American'] }],
        }, 'hello');

        expect(card.meanings[0]?.partOfSpeech).toBe('感叹词');
        expect(card.meanings[0]?.definitions[0]).toEqual({ definition: 'a greeting', example: 'Hello there.' });
        expect(card.phonetics[0]).toEqual({ text: '/həˈloʊ/', audio: 'https://upload.wikimedia.org/hello.mp3', label: '美式' });
    });

    it('parses Datamuse definitions and pronunciation metadata', () => {
        const card = parseDatamuseWord({
            word: 'hello',
            tags: ['n', 'pron:/həˈloʊ/'],
            defs: ['n\tA greeting. ', 'n\tA salutation. '],
        }, 'hello');

        expect(card.phonetics[0]?.text).toBe('/həˈloʊ/');
        expect(card.meanings[0]).toEqual({
            partOfSpeech: '名词',
            definitions: [{ definition: 'A greeting.' }, { definition: 'A salutation.' }],
        });
    });

    it('parses the no-key China-first dictionary response with bilingual glosses', () => {
        const card = parseYoudaoResponse({
            ec: {
                word: {
                    usphone: 'həˈloʊ',
                    ukphone: 'həˈləʊ',
                    trs: [{ pos: 'int.', tran: '喂，你好' }],
                },
            },
            simple: [{
                multiPhone: {
                    uk: [{
                        phone: 'həˈləʊ',
                        speech: 'hello&phonetic=həˈləʊ&type=1',
                    }],
                },
            }],
        }, 'hello');

        expect(card.phonetics).toEqual([
            { text: '/həˈloʊ/', audio: 'https://dict.youdao.com/dictvoice?audio=hello&type=2', label: '美式' },
            { text: '/həˈləʊ/', audio: 'https://dict.youdao.com/dictvoice?hello&phonetic=h%C9%99%CB%88l%C9%99%CA%8A&type=1', label: '英式' },
        ]);
        expect(card.meanings[0]).toEqual({
            partOfSpeech: '感叹词',
            definitions: [{ definition: '喂，你好', translatedDefinition: '喂，你好' }],
        });
    });

    it('keeps both regional rows when American and British IPA are identical', () => {
        const card = parseYoudaoResponse({
            ec: {
                word: {
                    usphone: 'juː; jʊ',
                    ukphone: 'juː; jʊ',
                },
            },
            simple: [{
                multiPhone: {
                    uk: [{
                        phone: 'juː',
                        speech: 'you&phonetic=juː&type=1',
                    }],
                },
            }],
        }, 'you');

        expect(card.phonetics).toEqual([
            { text: '/juː/', audio: 'https://dict.youdao.com/dictvoice?audio=you&type=2', label: '美式' },
            { text: '/juː/', audio: 'https://dict.youdao.com/dictvoice?you&phonetic=ju%CB%90&type=1', label: '英式' },
        ]);
    });

    it('parses a local ECDICT entry without requiring network data', () => {
        const card = parseEcdictEntry({
            w: 'you',
            p: 'ju:',
            d: 'dat. & obj. The pronoun of the second person.\\n   dative, and objective case.',
            t: 'pron. 你, 你们',
            pos: 'pron.',
        }, 'you');

        expect(card.meanings[0]).toEqual({
            partOfSpeech: '代词',
            definitions: [
                { definition: 'The pronoun of the second person.', translatedDefinition: '你, 你们' },
                { definition: 'dative, and objective case.' },
            ],
        });
        expect(card.phonetics[0]?.text).toBe('/ju:/');
        expect(card.sources[0]?.id).toBe('ecdict-local');
    });
});

describe('word dictionary online backups', () => {
    it('queries no-key backups together and accepts WiktApi when the other sources fail', async () => {
        const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('dict.youdao.com')) return response({ message: 'unavailable' }, false);
            if (url.includes('dictionaryapi.dev')) return response({ message: 'unavailable' }, false);
            if (url.includes('api.datamuse.com')) return response({ message: 'unavailable' }, false);
            if (url.includes('en.wiktionary.org')) return response({ message: 'unavailable' }, false);
            if (url.includes('api.wiktapi.dev')) {
                return response({
                    word: 'fallbackword',
                    entries: [{
                        lang_code: 'en',
                        pos: 'noun',
                        senses: [{ glosses: ['a fallback definition'] }],
                        sounds: [{ ipa: '/ˈfɔːlbæk/' }],
                    }],
                });
            }
            throw new Error('unexpected provider: ' + url);
        });
        vi.stubGlobal('fetch', fetchMock);

        const card = await lookupWord('fallbackword');

        expect(card?.meanings[0]?.definitions[0]?.definition).toBe('a fallback definition');
        expect(card?.phonetics[0]?.text).toBe('/ˈfɔːlbæk/');
        expect(card?.sources.map(item => item.id)).toEqual(['wiktapi']);
        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(warningSpy).toHaveBeenCalledTimes(4);
    });

    it('merges missing pronunciation fields from a backup without duplicating definitions', () => {
        const first = parseFreeDictionaryEntry({
            word: 'hello',
            phonetics: [{ text: '/həˈloʊ/' }],
            meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a greeting' }] }],
        }, 'hello');
        const second = parseWiktApiEntry({
            word: 'hello',
            pos: 'noun',
            senses: [{ glosses: ['a greeting'] }],
            sounds: [{ ipa: '/həˈləʊ/', mp3_url: 'https://upload.wikimedia.org/hello-uk.mp3' }],
        }, 'hello');

        const merged = mergeWordCardData(first, second);

        expect(merged.meanings).toHaveLength(1);
        expect(merged.meanings[0]?.definitions).toHaveLength(1);
        expect(merged.phonetics).toHaveLength(2);
        expect(merged.sources.map(item => item.id)).toEqual(['free-dictionary', 'wiktapi']);
    });

    it('requests English WiktApi entries and extracts etymology and inflections', async () => {
        const requestedUrls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            requestedUrls.push(url);
            if (url.includes('api.wiktapi.dev')) {
                return response({
                    word: 'run',
                    entries: [
                        {
                            pos: 'noun',
                            etymology_text: 'From Middle English <i>runnen</i>',
                            senses: [{ glosses: ['An act of running.'] }],
                            forms: [
                                null,
                                { form: '' },
                                { form: '-', tags: ['plural'] },
                                { form: 'no-table-tags', tags: ['table-tags'] },
                                { form: 'en-noun', tags: ['inflection-template'] },
                                { form: 'run' },
                                { form: 'runs', tags: ['plural'] },
                                { form: 'runs', tags: ['plural'] },
                            ],
                        },
                        {
                            pos: 'verb',
                            etymology: 'Fallback etymology ignored when origin exists.',
                            senses: [{ glosses: ['To move swiftly on foot.'] }],
                            forms: [
                                { form: 'running', tags: ['present', 'participle'] },
                                { form: 'ran', tags: ['past'] },
                                { form: 'run', tags: ['participle', 'past'] },
                                { form: 'runneth' },
                            ],
                        },
                    ],
                });
            }
            throw new Error('unexpected provider: ' + url);
        }));

        const card = await lookupWord('run', 'wiktapi');

        expect(requestedUrls).toEqual(['https://api.wiktapi.dev/v1/en/word/run?lang=en']);
        expect(card?.origin).toBe('From Middle English runnen');
        expect(card?.inflections).toBe('runs (plural); running (present, participle); ran (past); run (participle, past); runneth');
    });

    it('falls back to WiktApi etymology field and caps merged inflections cleanly', () => {
        const first = parseWiktApiEntry({
            word: 'go',
            pos: 'verb',
            etymology: 'From Old English <b>gān</b>',
            senses: [{ glosses: ['To move.'] }],
            forms: [
                { form: 'goes', tags: ['present', 'singular', 'third-person', 'extra'] },
                { form: 'going', tags: ['participle', 'present'] },
                { form: 'went', tags: ['past'] },
                { form: 'gone', tags: ['participle', 'past'] },
                { form: 'goest', tags: ['second-person'] },
                { form: 'goeth', tags: ['third-person'] },
                { form: 'gan', tags: ['past'] },
                { form: 'yede', tags: ['past'] },
                { form: 'overflow', tags: ['past'] },
            ],
        }, 'go');
        expect(first.origin).toBe('From Old English gān');
        expect(first.inflections?.split('; ')).toHaveLength(8);
        expect(first.inflections).not.toContain('overflow');
        expect(first.inflections).toContain('goes (present, singular, third-person)');

        const merged = mergeWordCardData(
            { word: 'go', normalizedWord: 'go', phonetics: [], meanings: [], inflections: 'goes (present); ; went (past)', sources: [] },
            { word: 'go', normalizedWord: 'go', phonetics: [], meanings: [], inflections: 'went (past); gone (past); f3; f4; f5; f6; f7; f8; f9', sources: [] },
        );
        expect(merged.inflections).toBe('goes (present); went (past); gone (past); f3; f4; f5; f6; f7');
    });
});
