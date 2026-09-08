import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const {mockConfig} = vi.hoisted(() => ({mockConfig: {from: 'en', to: 'es', proxy: {} as Record<string, string>, token: {} as Record<string, string>}}));
vi.mock('@/src/services/config/store', () => ({config: mockConfig}));
import apertium from '@/src/providers/translation/apertium';
import libreTranslate from '@/src/providers/translation/libretranslate';
import {translateStructuredText} from '@/src/providers/translation/structuredText';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/serialization';
import {attachTranslationProviderConfig, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {servicesType, options} from '@/src/core/config/catalog';
const fetchMock = vi.fn<typeof fetch>();
const reply = () => Response.json({responseStatus: 200, responseData: {translatedText: 'Hola'}, translatedText: 'Hola'});
beforeEach(() => {
    mockConfig.from = 'en'; mockConfig.to = 'es';
    mockConfig.proxy = {libreTranslate: 'http://localhost:5000/translate'}; mockConfig.token = {};
    fetchMock.mockReset().mockImplementation(async () => reply()); setRuntimeFetch(fetchMock);
});
afterEach(() => setRuntimeFetch());

describe('open translation providers', () => {
    it('registers independent machine services with optional credentials and preserves saved fallback choices', () => {
        for (const service of ['apertium', 'libreTranslate']) {
            expect(servicesType.isMachine(service)).toBe(true);
            expect(options.services.some(item => item.value === service)).toBe(true);
            expect(getMissingCredentialMessage(service, new Config())).toBeNull();
            expect(normalizeConfig({service}).service).toBe(service);
        }
        expect(normalizeConfig({freeTranslationOrder: ['apertium', 'google']}).freeTranslationOrder).toEqual(['apertium', 'google']);
        expect(normalizeConfig({freeTranslationOrder: ['google']}).freeTranslationOrder).toEqual(['google']);
    });
    it('sends anonymous APY text format without unrelated keys or proxy overrides', async () => {
        mockConfig.proxy.apertium = 'https://unrelated.test'; mockConfig.token.apertium = 'secret';
        await expect(apertium({origin: ' Hello <3 & world. '})).resolves.toBe(' Hola ');
        expect(fetchMock.mock.calls[0]![0]).toBe('https://apertium.org/apy/translate');
        const init = fetchMock.mock.calls[0]![1]!;
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({q: 'Hello <3 & world.', langpair: 'eng|spa', format: 'txt', markUnknown: 'no'});
        expect(init.credentials).toBe('omit'); expect(JSON.stringify(init)).not.toContain('secret');
    });
    it('detects long English locally, accepts three-letter source codes and rejects unsupported or uncertain languages before network', async () => {
        await expect(apertium({origin: 'This is an English paragraph with enough words to identify its language reliably.', sourceLanguage: 'auto'})).resolves.toBe('Hola');
        await expect(apertium({origin: 'Hello', sourceLanguage: 'eng'})).resolves.toBe('Hola');
        await expect(apertium({origin: ['Hello', 'World']})).resolves.toEqual(['Hola', 'Hola']);
        fetchMock.mockClear();
        for (const request of [{targetLanguage: 'zh-Hans'}, {sourceLanguage: 'ja'}, {sourceLanguage: 'auto'}]) {
            await expect(apertium({origin: 'Hi', ...request})).rejects.toMatchObject({statusCode: 400});
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('uses frozen LibreTranslate endpoint, language scripts and only that instances optional key', async () => {
        const snapshot = createTranslationProviderConfigSnapshot({...new Config(), from: 'auto', to: 'zh-Hant', proxy: {libreTranslate: 'https://instance.test/translate'}, token: {libreTranslate: ' optional-key ', openai: 'never-send'}});
        await libreTranslate(attachTranslationProviderConfig({origin: 'Hello'}, snapshot));
        expect(String(fetchMock.mock.calls[0]![0])).toBe('https://instance.test/translate');
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({q: 'Hello', source: 'auto', target: 'zt', format: 'text', api_key: 'optional-key'});
        await libreTranslate({origin: '你好', sourceLanguage: 'zh-Hans', targetLanguage: 'en'});
        expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({q: '你好', source: 'zh', target: 'en', format: 'text'});
    });
    it.each(['', 'invalid', 'file:///tmp/translate', 'https://user:pass@example.com/translate', 'https://example.com/translate#key'])('rejects invalid instance address %s', async endpoint => {
        mockConfig.proxy.libreTranslate = endpoint;
        await expect(libreTranslate({origin: 'Hello'})).rejects.toMatchObject({statusCode: 400});
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([apertium, libreTranslate])('preserves HTTP failures, rejects non-JSON and missing translations %#', async provider => {
        fetchMock.mockResolvedValueOnce(new Response('', {status: 429}));
        await expect(provider({origin: 'Hello'})).rejects.toMatchObject({statusCode: 429});
        fetchMock.mockResolvedValueOnce(new Response('<html>error</html>'));
        await expect(provider({origin: 'Hello'})).rejects.toThrow('JSON');
        for (const value of [null, {}, {responseStatus: 200}, {responseStatus: 200, responseData: {}, translatedText: ' '}]) {
            fetchMock.mockResolvedValueOnce(Response.json(value));
            await expect(provider({origin: 'Hello'})).rejects.toThrow();
        }
    });
    it('maps APY protocol status to request errors or service failures and does not expose remote error bodies', async () => {
        for (const [code, statusCode] of [[400, 400], [503, 503], ['nonsense', 502]]) {
            fetchMock.mockResolvedValueOnce(Response.json({responseStatus: code}));
            await expect(apertium({origin: 'Hi'})).rejects.toMatchObject({statusCode});
        }
        fetchMock.mockResolvedValueOnce(Response.json({error: 'secret input'}));
        await expect(libreTranslate({origin: 'Hi'})).rejects.toThrow('请检查实例');
    });
});

describe('structured text for open translation APIs', () => {
    it('preserves slots, arrays, whitespace and code points while bounding long requests', async () => {
        const call = vi.fn(async (s: string) => s);
        const text = '  ' + '😀'.repeat(1100) + '\r\n\tHello  ';
        expect(await translateStructuredText([text, '', '  '], call)).toEqual([text, '', '  ']);
        expect(call.mock.calls.every(([s]) => Array.from(s).length <= 1000)).toBe(true);
        const slots = serializeTranslationSlots(['  Hello\nWorld ', 'Bye'], 'test');
        const translated = await translateStructuredText(slots.payload, async s => s.toUpperCase());
        expect(parseTranslationSlots(slots, translated as string)).toEqual(['  HELLO\nWORLD ', 'BYE']);
    });
    it.each([null, {}, 42, ['ok', null]])('rejects non-text input %#', async origin => {
        await expect(translateStructuredText(origin, async s => s)).rejects.toMatchObject({statusCode: 400});
    });
    it.each([null, 42, '', ' '])('rejects invalid translated content %#', async value => {
        await expect(translateStructuredText('Hi', async () => value as string)).rejects.toThrow('有效译文');
    });
    it('cancels before network, after a late response and between array items', async () => {
        const controller = new AbortController(); controller.abort();
        const call = vi.fn(async (s: string) => s);
        await expect(translateStructuredText('Hi', call, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        await expect(translateStructuredText([], call, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(call).not.toHaveBeenCalled();
        const late = new AbortController();
        await expect(translateStructuredText(['Hi', 'Bye'], async () => {late.abort(); return 'Hola';}, late.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
    it.each([apertium, libreTranslate])('passes cancellation through the network and prevents late results %#', async provider => {
        const controller = new AbortController();
        fetchMock.mockImplementationOnce(async (_url, init) => {expect(init!.signal).toBe(controller.signal); controller.abort(); return reply();});
        await expect(provider({origin: 'Hi', abortSignal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    });
});
