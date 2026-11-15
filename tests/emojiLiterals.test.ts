import {afterEach, describe, expect, it, vi} from 'vitest';
import {findEmojiLiteralRanges, hasEmojiLiterals} from '@/src/core/translation/emojiLiterals';
import {protectGlossaryText} from '@/src/core/glossary/protection';
import {splitFreeTextChunks, translateFreeTextChunks} from '@/src/providers/translation/freeTextChunks';
import {createTranslationIdentityPolicy} from '@/src/services/translation/requestIdentity';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {Config} from '@/src/core/config/model';
import {servicesType, resolveConfiguredModel} from '@/src/core/config/catalog';

afterEach(() => vi.unstubAllGlobals());
const symbols = ['🚚', '👩🏽‍🔬', '🇫🇷', '1️⃣', '#️⃣', '♥️', '✋🏿', '©︎', '🏴\u{E0067}\u{E0062}\u{E007F}'];

describe('complete translation emoji literals', () => {
    it('does not protect a prepend sign that an older native Unicode segmenter treats as a separate grapheme', () => {
        vi.stubGlobal('Intl',Object.create(Intl,{Segmenter:{value:class {
            segment(){return [{index:0,segment:'\u{113D1}'},{index:2,segment:'😀'}];}
        }}}));
        expect(findEmojiLiteralRanges('\u{113D1}😀')).toEqual([{start:2,end:4}]);
    });
    it('avoids native segmenter construction for complete single-codepoint emoji and shares one within a complex scan', () => {
        const NativeSegmenter = Intl.Segmenter;
        const construct = vi.fn(function(...args: ConstructorParameters<typeof Intl.Segmenter>) {
            return new NativeSegmenter(...args);
        });
        vi.stubGlobal('Intl', Object.create(Intl, {Segmenter: {value: construct}}));
        for (let index = 0; index < 1000; index++) {
            const text = `Read 🚚 😀 © on page ${index}.`;
            expect(findEmojiLiteralRanges(text).map(({start, end}) => text.slice(start, end))).toEqual(['🚚', '😀', '©']);
        }
        expect(construct.mock.calls.length).toBe(0);
        const complex = 'Keep 👩🏽‍🔬, 1️⃣ and 🇫🇷 together.';
        expect(findEmojiLiteralRanges(complex).map(({start, end}) => complex.slice(start, end))).toEqual(['👩🏽‍🔬', '1️⃣', '🇫🇷']);
        expect(construct).toHaveBeenCalledOnce();
    });
    it('direct provider identity retains its endpoint and isolates only emoji source inputs', () => {
        const config = createTranslationProviderConfigSnapshot(Object.assign(new Config(), {deeplx:'https://fixture.invalid/translate'}));
        const policy = createTranslationIdentityPolicy({resolveConfiguredModel,serviceTypes:servicesType,
            endpointResolver:{resolveOpenAICompatibleEndpoint:()=>({endpoint:''}),aiSdkTransportProfile:''},
            buildTranslationCacheKey:identity=>JSON.stringify(identity)});
        const execution = {config,service:'deeplx',sourceLanguage:'en',targetLanguage:'zh-Hans',enableAIContext:false,nativeBatchEnabled:false,thinking:false};
        const plain = JSON.parse(policy.buildCacheKey(execution,'Read the label.','','','single'));
        expect(plain.endpoint).toBe('https://fixture.invalid/translate');expect(plain).not.toHaveProperty('emojiLiteralProtection');
        const emoji = JSON.parse(policy.buildCacheKey(execution,'Read 🚚.','','','single'));
        expect(emoji.endpoint).toBe(plain.endpoint);expect(emoji.emojiLiteralProtection).toEqual({version:1});
        const cloud = {...execution, service:'aliyunTranslation',
            config:createTranslationProviderConfigSnapshot(Object.assign(new Config(), {serviceRegion:{aliyunTranslation:'cn-hangzhou'}}))};
        const cloudKey = JSON.parse(policy.buildCacheKey(cloud,'Read 🚚.','','','single'));
        expect(cloudKey.endpoint).toBe('https://mt.cn-hangzhou.aliyuncs.com/');
        expect(cloudKey.emojiLiteralProtection).toEqual({version:1});
        // 兼容未登记地域的旧快照；emoji 策略不能影响既有默认端点。
        const legacy = JSON.parse(policy.buildCacheKey({...cloud,config:{...cloud.config,serviceRegion:undefined}},'Read 🚚.','','','single'));
        expect(legacy.endpoint).toBe(cloudKey.endpoint);
    });
    it.each([false, true])('preserves whole original clusters with fallback=%s, without matching ordinary digits', fallback => {
        if (fallback) vi.stubGlobal('Intl', Object.create(Intl, {Segmenter: {value: undefined}}));
        const text = `cafe\u0301 123 # * ${symbols.join(' ')} Gate1️⃣end`;
        expect(findEmojiLiteralRanges(text).map(({start, end}) => text.slice(start, end))).toEqual([...symbols, '1️⃣']);
        expect(findEmojiLiteralRanges('普通文字 cafe\u0301 123 # *')).toEqual([]);
        expect(hasEmojiLiterals(['plain', text])).toBe(true);
        expect(hasEmojiLiterals('plain')).toBe(false);
        expect(hasEmojiLiterals([])).toBe(false);
        expect(hasEmojiLiterals(undefined as unknown as string)).toBe(false);
        expect(hasEmojiLiterals([undefined, 'plain'] as unknown as string[])).toBe(false);
    });
    it('literal ranges bypass glossary word boundaries while configured terms and slot grammar win', () => {
        const source = 'Gate1️⃣ 🚚 API';
        const ranges = findEmojiLiteralRanges(source);
        const packet = protectGlossaryText(source, [{source: 'Gate1️⃣', target: '门一', caseSensitive: true}], 'literal', [], undefined,
            [...ranges, ranges[1], {start: -1, end: 2}, {start: 0, end: 0}, {start: 0, end: 999}, {start: 1.5, end: 3}]);
        expect(packet.tokens).toHaveLength(2);
        expect(packet.restore(packet.text)).toBe('门一 🚚 API');
        const keycap = protectGlossaryText('Gate1️⃣', [], 'keycap', [], undefined, [{start: 4, end: 7}]);
        expect(keycap.tokens).toHaveLength(1);expect(keycap.restore(keycap.text)).toBe('Gate1️⃣');
        const excluded = protectGlossaryText(source, [], 'excluded', [ranges[0]], undefined, ranges);
        expect(excluded.tokens).toHaveLength(1);expect(excluded.restore(excluded.text)).toBe(source);
        const slotted = '___FLUENTREAD_a_0_BEGIN___🚚___FLUENTREAD_a_0_END___';
        const slots = protectGlossaryText(slotted, [], 'slots', [], undefined, [{start: 0, end: slotted.length}, ...findEmojiLiteralRanges(slotted)]);
        expect(slots.tokens).toHaveLength(1);expect(slots.restore(slots.text)).toBe(slotted);
        expect(() => slots.restore(slots.text.replace(slots.tokens[0], ''))).toThrow('未完整保留');
    });
    it('fallback agrees with native emoji graphemes for VS15, dangling joins, spacing marks and prepend signs', () => {
        const source = ['1\uFE0E\u20E3', '🚚\u200d', '🚚ि', '\u0600🚚', '👩🏽‍🔬', '🚚\u200d\u200d', '🇫🇷🇺', '🇫🇷\u200d🚚', '🚚ि\u200d🚚'].join(' ');
        const expected = findEmojiLiteralRanges(source);
        vi.stubGlobal('Intl', Object.create(Intl, {Segmenter: {value: undefined}}));
        expect(findEmojiLiteralRanges(source)).toEqual(expected);
    });
    it('user terms may replace whole emoji but cannot rewrite an isolated modifier or half of a ZWJ cluster', () => {
        for (const source of ['👩', '🏽', '\u200d', '🔬']) {
            const packet = protectGlossaryText('Use 👩🏽‍🔬 now.', [{source,target:'REPLACED',caseSensitive:true}]);
            expect(packet.tokens).toHaveLength(0);expect(packet.restore(packet.text)).toBe('Use 👩🏽‍🔬 now.');
        }
        const whole = protectGlossaryText('Use 👩🏽‍🔬 now.', [{source:'👩🏽‍🔬',target:'研究员',caseSensitive:true}]);
        expect(whole.restore(whole.text)).toBe('Use 研究员 now.');
        const phrase = protectGlossaryText('Use 👩🏽‍🔬 now.', [{source:'Use 👩🏽‍🔬',target:'请研究员',caseSensitive:true}]);
        expect(phrase.restore(phrase.text)).toBe('请研究员 now.');
    });
    it('punctuation with a combining keycap cannot stall chunk iteration', () => {
        for (const utf16 of [false, true]) {
            const chunks = splitFreeTextChunks('x。\u20e3y', 2, true, utf16);
            const values: string[] = [];
            for (let step = 0; step < 5; step++) {
                const result = chunks.next();
                if (result.done) break;
                expect(result.value.length).toBeGreaterThan(0);values.push(result.value);
            }
            expect(values.join('')).toBe('x。\u20e3y');expect(chunks.next().done).toBe(true);
        }
    });
    it.each([false, true])('hard budgets never cut complete emoji with UTF16=%s', utf16 => {
        for (const symbol of symbols) {
            const size = utf16 ? symbol.length : [...symbol].length;
            const limit = size + 3, source = 'x'.repeat(limit - 1) + symbol + 'tail';
            for (const words of [false, true]) {
                const chunks = [...splitFreeTextChunks(source, limit, words, utf16)];
                expect(chunks.join('')).toBe(source);
                expect(chunks.filter(chunk => chunk.includes(symbol))).toHaveLength(1);
                expect(chunks.every(chunk => chunk.length > 0 && (utf16 ? chunk.length : [...chunk].length) <= limit)).toBe(true);
            }
            if (size > 1) expect(() => [...splitFreeTextChunks(symbol, size - 1, true, utf16)]).toThrow('完整 emoji 字素');
        }
    });
    it('rejects an oversized grapheme before any request and leaves ordinary hard cuts unchanged', async () => {
        const request = vi.fn(async (text: string) => text);
        await expect(translateFreeTextChunks('x'.repeat(20) + '👩🏽‍🔬', 3, request)).rejects.toMatchObject({freeFailure: 'request'});
        expect(request).not.toHaveBeenCalled();
        expect([...splitFreeTextChunks('abcdefghijkl', 5, true)]).toEqual(['abcde', 'fghij', 'kl']);
        // 非 emoji 的补充平面字母仍须遵守 UTF-16 硬预算，沿用原码点不足的明确错误。
        expect(() => [...splitFreeTextChunks('𐐀', 1, true, true)]).toThrow('容纳一个 Unicode 码点');
        await expect(translateFreeTextChunks('A🚚\r\nB👩🏽‍🔬 ', 20, request)).resolves.toBe('A🚚\r\nB👩🏽‍🔬 ');
    });
});
