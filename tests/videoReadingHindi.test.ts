import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHindiEngine} from '@/src/features/video-subtitle/reading/hindiEngine';
import fixture from './fixtures/video-reading-hindi-parity.json';

afterEach(() => {vi.doUnmock('@/src/features/video-subtitle/reading/assetStore'); vi.resetModules(); vi.restoreAllMocks();});

describe('Hindi static engine compatibility with pinned gomanize 1.2.1', () => {
  it('matches 2472 frozen original WASM results across lexicon, unknown words, schwa, nukta, mixed text and punctuation', () => {
    const engine = createHindiEngine(fixture.data);
    for (const [text, expected] of fixture.cases) expect(engine(text), text).toBe(expected);
  });

  it('preserves parser boundaries and independent vowels, conjuncts, format marks and native numerals', () => {
    const engine = createHindiEngine({...fixture.data, lexiconTsv:'नमस्ते\tnamaste'});
    expect(engine('गई कऋ कृ दरअसल')).toBe('gai kari kri darasal');
    expect(engine('ज्ञ ज्ञान यज्ञ ज्‍ञ ज्‌ञ')).toBe('gy gyaan yagya gy gy');
    expect(engine('क़िला क़िला')).toBe('qila qila');
    expect(engine('भारत! Hello, १२३। काम\tहै\nमाँ')).toBe('bharat! Hello, 123। kaam\thai\nmaa');
    expect(engine('ऩ ऱ ऴ')).toBe('nh rh lh');
    expect(engine('वालक मां में करें गांव गांवक')).toBe('walak maa mein karein gaon ganvak');
    expect(engine('İकमला')).toBe('İkamla');
  });

  it('uses attested lexicon spellings before either candidate and keeps lexical nasal exceptions', () => {
    const engine = createHindiEngine({...fixture.data, lexiconTsv:'अंकल\tuncle\nनमस्ते\tnamaste\r\ninvalid\n\tbad\nempty\t'});
    expect(engine('अंकल')).toBe('uncle');
    expect(engine('माँ हाँ इहाँ चाँद पाँच कहाँ')).toBe('maa haan ihaan chaand paanch kahaan');
  });

  it('keeps the original default candidate when both normalized scores tie, and accepts model candidate only on a strict win', () => {
    const grams = (words: string[]) => {
      const keys = new Set<string>();
      for (const word of words) {
        const text = '^' + word + '$';
        for (let i = 0; i < text.length; i++) for (let length = 1; length <= 4; length++) keys.add(text.slice(i, i + length));
      }
      return [...keys].map(key => key + '\t1').join('\n');
    };
    // Matching numerator and context counts make both normalized scores exactly zero.
    const data = {lexiconTsv:'नमस्ते\tnamaste',romanNgramsTsv:grams(['kamla','kmla']),schwaTreeJson:'{"tree":{"leaf":1}}'};
    expect(createHindiEngine(data)('कमला')).toBe('kamla');
    expect(createHindiEngine({...data,romanNgramsTsv:grams(['kmla'])})('कमला')).toBe('kmla');
  });

  it('rejects malformed model trees and unusable data rather than silently reducing reading quality', () => {
    for (const schwaTreeJson of ['null','{}','{"tree":null}','{"tree":{"leaf":3}}','{"tree":{"f":"eval","v":"x","yes":{"leaf":0},"no":{"leaf":1}}}',
      '{"tree":{"f":"cons","v":3,"yes":{"leaf":0},"no":{"leaf":1}}}', '{"tree":{"f":"cons","v":"too-long-value","yes":{"leaf":0},"no":{"leaf":1}}}']) {
      expect(() => createHindiEngine({...fixture.data, schwaTreeJson})).toThrow('Hindi');
    }
    for (const romanNgramsTsv of ['', 'a\tnot-a-count','a\t0','ab\t2']) expect(() => createHindiEngine({...fixture.data, romanNgramsTsv})).toThrow('Hindi lexicon data');
    expect(() => createHindiEngine({...fixture.data, lexiconTsv:''})).toThrow('Hindi lexicon data');
  });

  it('rejects trees exceeding the fixed traversal depth', () => {
    let tree: unknown = {leaf:0};
    for (let i = 0; i < 66; i++) tree = {f:'cons',v:'क',yes:tree,no:{leaf:1}};
    expect(() => createHindiEngine({...fixture.data,schwaTreeJson:JSON.stringify({tree})})).toThrow('Hindi schwa tree');
  });
});

describe('Hindi data asset boundary', () => {
  it('prepares only the three pinned pure-data assets and routes through the static engine', async () => {
    const encoder = new TextEncoder();
    const ensure = vi.fn(async () => new Map([
      ['lexicon.tsv',encoder.encode(fixture.data.lexiconTsv).buffer],
      ['roman_ngrams.tsv',encoder.encode(fixture.data.romanNgramsTsv).buffer],
      ['schwa_tree.json',encoder.encode(fixture.data.schwaTreeJson).buffer],
    ]));
    const create = vi.fn(() => ({ensure}));
    vi.doMock('@/src/features/video-subtitle/reading/assetStore', () => ({createReadingAssetStore:create}));
    const {loadHindiReadingEngine,HINDI_READING_ASSETS,HINDI_READING_REVISION} = await import('@/src/features/video-subtitle/reading/hindiAssets');
    const engine = await loadHindiReadingEngine();
    expect(engine('नमस्ते दुनिया')).toBe('namaste duniya');
    expect(create).toHaveBeenCalledWith({cacheName:'fluentread-reading-hi-v1',files:HINDI_READING_ASSETS});
    expect(HINDI_READING_ASSETS.reduce((sum,file) => sum + file.size,0)).toBe(472254);
    for (const file of HINDI_READING_ASSETS) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.name).toMatch(/\.(?:tsv|json)$/u);
      expect(file.urls).toHaveLength(4);
      for (const url of file.urls) expect(url).toContain(HINDI_READING_REVISION);
    }
    const {createHindiRomanizer} = await import('@/src/features/video-subtitle/reading/hindi');
    await expect(createHindiRomanizer()('नमस्ते','https://attacker.test/code.wasm')).resolves.toBe('namaste');
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
