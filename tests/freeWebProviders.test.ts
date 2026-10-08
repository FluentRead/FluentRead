import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {translateFreeWebText, type FreeWebProvider} from '@/src/providers/translation/free-web';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/serialization';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {options, services} from '@/src/core/config/catalog';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';

const providers: FreeWebProvider[] = ['transmart', 'yandexFree', 'volcengineFree'];
const fetchMock = vi.fn<typeof fetch>();
const reply = (text: unknown = '译文') => Response.json({header: {ret_code: 'succ'}, auto_translation: [text], code: 200, text: [text], base_resp: {status_code: 0}, translation: text});
const translate = (provider: FreeWebProvider, text = 'Hello', from = 'auto', to = 'zh-Hans', signal?: AbortSignal) => translateFreeWebText(provider, text, from, to, signal);
beforeEach(() => {fetchMock.mockReset().mockImplementation(async () => reply()); setRuntimeFetch(fetchMock);});
afterEach(() => setRuntimeFetch());

describe('free-only web providers', () => {
    it('names Yandex network failures and preserves cooperative cancellation', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(translateFreeWebText('yandexFree', 'Hello', 'en', 'zh-Hans')).rejects.toThrow('Yandex 网络连接失败');
        const controller = new AbortController();
        fetchMock.mockImplementationOnce(async () => {controller.abort(); throw new TypeError('Failed to fetch');});
        await expect(translateFreeWebText('yandexFree', 'Hello', 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        fetchMock.mockRejectedValueOnce(new Error('existing'));
        await expect(translateFreeWebText('yandexFree', 'Hello', 'en', 'zh-Hans')).rejects.toThrow('existing');
    });

    it('only accepts new IDs inside the free policy, preserves existing policy and round-trips selections', () => {
        expect(new Config().freeTranslationOrder).toEqual(['microsoft', 'bilibiliFree', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'myMemory', 'sogouFree', 'reversoFree', 'apertiumFree', 'alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree']);
        for (const id of providers) {
            expect(Object.values(services)).not.toContain(id);
            expect(options.services.some(item => item.value === id)).toBe(false);
        }
        expect(normalizeConfig({freeTranslationOrder: ['google']}).freeTranslationOrder).toEqual(['bilibiliFree', 'google']);
        const current = normalizeConfig({...new Config(), freeTranslationOrder: providers});
        expect(prepareConfigForImport(prepareConfigForExport(current), new Config()).freeTranslationOrder).toEqual(providers);
    });
    it('uses a generated anonymous Tencent client marker and preserves a single text without credentials', async () => {
        await expect(translate('transmart')).resolves.toBe('译文');
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://transmart.qq.com/api/imt');
        expect(init).toMatchObject({method: 'POST', credentials: 'omit', headers: {'Content-Type': 'application/json'}});
        const body = JSON.parse(String(init!.body));
        expect(body.header.client_key).toMatch(/^browser-chrome-110\.0\.0-Mac OS-[a-f0-9-]+-\d+$/u);
        expect(Object.keys(body.header)).toEqual(['fn', 'client_key']);
        expect(body.source).toEqual({text_list: ['Hello'], lang: 'auto'});
        expect(body.target).toEqual({lang: 'zh'});
    });
    it('omits auto source for Yandex and URL-encodes text without adding cookies or auth headers', async () => {
        await translate('yandexFree', 'Hello & 你好? # /');
        const url = new URL(String(fetchMock.mock.calls[0]![0]));
        expect(url.origin + url.pathname).toBe('https://translate.yandex.net/api/v1/tr.json/translate');
        expect(url.searchParams.get('text')).toBe('Hello & 你好? # /');
        expect(url.searchParams.get('id')).toMatch(/^[a-f0-9]{32}-0-0$/u);
        expect(url.searchParams.has('source_lang')).toBe(false);
        expect(url.searchParams.get('target_lang')).toBe('zh');
        await translate('yandexFree', '你好', 'zh-Hant', 'en');
        const explicit = new URL(String(fetchMock.mock.calls[1]![0]));
        expect(explicit.searchParams.get('source_lang')).toBe('zh');
    });
    it('calls the final Volcano path directly using plain JSON', async () => {
        await translate('volcengineFree', 'Hello', 'en');
        expect(fetchMock.mock.calls[0]![0]).toBe('https://translate.volcengine.com/crx/translate/v1/');
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({source_language: 'en', target_language: 'zh', text: 'Hello'});
    });
    it('keeps Chinese scripts distinct and rejects unsupported targets without network', async () => {
        await translate('transmart', 'Hello', 'en', 'zh-TW');
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).target.lang).toBe('zh-tw');
        await translate('volcengineFree', 'Hello', 'en', 'zh-Hant');
        expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).target_language).toBe('zh-Hant');
        fetchMock.mockClear();
        await expect(translate('yandexFree', 'Hello', 'en', 'zh-Hant')).rejects.toMatchObject({statusCode: 400});
        await expect(translate('transmart', 'Hello', 'en', 'auto')).rejects.toMatchObject({statusCode: 400});
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each(providers)('%s preserves slot boundaries, lines, whitespace and non-BMP text within bounded chunks', async provider => {
        const input = '  ' + '😀'.repeat(1100) + '\r\n\tHello  ';
        const observed: string[] = [];
        fetchMock.mockImplementation(async (url, init) => {
            const body = init!.body ? JSON.parse(String(init!.body)) : null;
            const text = provider === 'yandexFree' ? new URL(String(url)).searchParams.get('text')! : provider === 'transmart' ? body.source.text_list[0] : body.text;
            observed.push(text); return reply(text);
        });
        const slots = serializeTranslationSlots([input, 'Bye'], 'free-web-test');
        const output = await translate(provider, slots.payload);
        expect(parseTranslationSlots(slots, output)).toEqual([input, 'Bye']);
        expect(observed.every(text => Array.from(text).length <= 1000 && !text.includes('___FLUENTREAD'))).toBe(true);
        await expect(translate(provider, '\n  ')).resolves.toBe('\n  ');
        await expect(translate(provider, 42 as never)).rejects.toMatchObject({statusCode: 400});
    });
    it.each(providers)('%s handles transport and malformed JSON without reflecting response contents', async provider => {
        fetchMock.mockResolvedValueOnce(new Response('private data', {status: 429}));
        await expect(translate(provider)).rejects.toMatchObject({statusCode: 429});
        fetchMock.mockResolvedValueOnce(new Response('private data'));
        await expect(translate(provider)).rejects.toThrow('JSON');
        for (const body of [null, {}, {header: {}, base_resp: {}}, {code: '400'}, {code: 399}, {code: 600}, {code: 400.5}]) {
            fetchMock.mockResolvedValueOnce(Response.json(body));
            await expect(translate(provider)).rejects.toMatchObject({statusCode: 502});
        }
        for (const text of ['', ' ', null, 42]) {
            fetchMock.mockResolvedValueOnce(reply(text));
            await expect(translate(provider)).rejects.toMatchObject({statusCode: 502});
        }
    });
    it('classifies protocol errors and rejects malformed translation arrays', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({header: {ret_code: 'Auth-Failed'}, message: 'secret'}));
        await expect(translate('transmart')).rejects.toMatchObject({statusCode: 403});
        fetchMock.mockResolvedValueOnce(Response.json({code: 429}));
        await expect(translate('yandexFree')).rejects.toMatchObject({statusCode: 429});
        for (const value of [null, [], 'invalid']) {
            fetchMock.mockResolvedValueOnce(Response.json({code: 200, text: value}));
            await expect(translate('yandexFree')).rejects.toMatchObject({statusCode: 502});
        }
    });
    it.each(providers)('%s honours cancellation before fetch and after delayed network or JSON completion', async provider => {
        const cancelled = new AbortController(); cancelled.abort();
        await expect(translate(provider, 'Hello', 'auto', 'zh-Hans', cancelled.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).not.toHaveBeenCalled();
        const late = new AbortController();
        fetchMock.mockImplementationOnce(async (_url, init) => {expect(init!.signal).toBe(late.signal); late.abort(); return reply();});
        await expect(translate(provider, 'Hello', 'auto', 'zh-Hans', late.signal)).rejects.toMatchObject({name: 'AbortError'});
        const jsonLate = new AbortController();
        const response = reply(); response.json = async () => {jsonLate.abort(); return {};};
        fetchMock.mockResolvedValueOnce(response);
        await expect(translate(provider, 'Hello', 'auto', 'zh-Hans', jsonLate.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
});
