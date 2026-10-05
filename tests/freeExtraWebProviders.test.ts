import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {translateExtraFreeWebText} from '@/src/providers/translation/free-extra-web';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/serialization';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); setRuntimeFetch(fetchMock); });
afterEach(() => setRuntimeFetch());

function home() { return new Response('<script>window.__INITIAL_STATE__={"common":{"CONFIG":{"secretCode":109984457}}}</script>'); }
function result(text: string) { return Response.json({status: 0, data: {translate: {dit: `译:${text}`}}}); }

describe('extra anonymous web providers', () => {
    it('uses the current Sogou page secret and signed text protocol', async () => {
        fetchMock.mockResolvedValueOnce(home()).mockResolvedValueOnce(result('Hello'));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).resolves.toBe('译:Hello');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const init = fetchMock.mock.calls[1]![1]!;
        expect(init).toMatchObject({method: 'POST', credentials: 'omit'});
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({from: 'en', to: 'zh-CHS', text: 'Hello', client: 'pc', fr: 'browser_pc', needQc: 1});
        expect(body.s).toMatch(/^[a-f0-9]{32}$/u);
        expect(body.uuid).toMatch(/^[0-9a-f-]{36}$/u);
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(result('Auto'));
        await translateExtraFreeWebText('sogouFree', 'Hello', 'auto', 'zh-Hans');
        expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)).from).toBe('auto');
    });

    it('preserves whitespace, line breaks and serialized slots', async () => {
        fetchMock.mockImplementation(async (url) => String(url) === 'https://translate.sogou.com/' ? home() : result(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).text));
        const input = '  Hello\r\nBye  ';
        await expect(translateExtraFreeWebText('sogouFree', input, 'en', 'zh-Hans')).resolves.toBe('  译:Hello\r\n译:Bye  ');
        fetchMock.mockReset();
        fetchMock.mockImplementation(async (url, init) => String(url) === 'https://translate.sogou.com/' ? home() : result(JSON.parse(String(init?.body)).text));
        const slots = serializeTranslationSlots(['Hello', 'Bye'], 'extra-test');
        const output = await translateExtraFreeWebText('sogouFree', slots.payload, 'en', 'zh-Hans');
        expect(parseTranslationSlots(slots, output)).toEqual(['译:Hello', '译:Bye']);
    });

    it('rejects unsupported candidates explicitly and honors pre-abort', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', {status: 403}));
        await expect(translateExtraFreeWebText('reversoFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 403});
        fetchMock.mockClear();
        const controller = new AbortController(); controller.abort();
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['reversoFree', Response.json({translation: ['translated']})],
        ['lingvaFree', Response.json({translation: 'translated'})],
    ] as const)('%s accepts its public response shape', async (id, response) => {
        fetchMock.mockResolvedValueOnce(response);
        await expect(translateExtraFreeWebText(id, 'Hello', 'en', 'zh-Hans')).resolves.toBe('translated');
        expect(fetchMock.mock.calls[0]![1]).toMatchObject({credentials: 'omit'});
    });

    it('Apertium checks its dynamic language-pair list before translating', async () => {
        fetchMock.mockResolvedValueOnce(Response.json(['eng-spa'])).mockResolvedValueOnce(Response.json({responseStatus: 200, responseData: {translatedText: 'Hola'}}));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'es')).resolves.toBe('Hola');
        expect(String(fetchMock.mock.calls[0]![0])).toContain('/apy/listPairs');
        expect(String(fetchMock.mock.calls[1]![0])).toContain('langpair=eng%7Cspa');
        fetchMock.mockReset().mockResolvedValueOnce(Response.json({responseData: {['eng-spa']: {}}})).mockResolvedValueOnce(Response.json({responseStatus: 200, responseData: {translatedText: 'Hola'}}));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'es')).resolves.toBe('Hola');
        fetchMock.mockReset().mockResolvedValueOnce(Response.json([{sourceLanguage: 'eng', targetLanguage: 'spa'}])).mockResolvedValueOnce(Response.json({responseStatus: 200, responseData: {translatedText: 'Hola'}}));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'es')).resolves.toBe('Hola');
        fetchMock.mockReset().mockResolvedValueOnce(Response.json([null, {langpair: 'eng-spa'}])).mockResolvedValueOnce(Response.json({responseStatus: 200, responseData: {translatedText: 'Hola'}}));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'es')).resolves.toBe('Hola');
    });

    it.each(['reversoFree', 'lingvaFree', 'apertiumFree'] as const)('%s rejects malformed or failed business responses', async id => {
        if (id === 'apertiumFree') {
            fetchMock.mockResolvedValueOnce(Response.json(['eng-spa'])).mockResolvedValueOnce(Response.json({responseStatus: 500}));
            await expect(translateExtraFreeWebText(id, 'Hello', 'en', 'es')).rejects.toMatchObject({statusCode: 502});
        } else {
            fetchMock.mockResolvedValueOnce(Response.json(id === 'lingvaFree' ? {error: 'failed'} : {translation: []}));
            await expect(translateExtraFreeWebText(id, 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 502});
        }
    });

    it.each(['reversoFree', 'lingvaFree', 'apertiumFree'] as const)('%s propagates HTTP failures', async id => {
        if (id === 'apertiumFree') fetchMock.mockResolvedValueOnce(new Response('', {status: 503}));
        else fetchMock.mockResolvedValueOnce(new Response('', {status: 403}));
        await expect(translateExtraFreeWebText(id, 'Hello', 'en', id === 'apertiumFree' ? 'es' : 'zh-Hans')).rejects.toMatchObject({statusCode: id === 'apertiumFree' ? 503 : 403});
    });

    it('rejects unsupported Apertium pairs before the translation request', async () => {
        fetchMock.mockResolvedValueOnce(Response.json(['eng-spa']));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 400, freeFailure: 'request'});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps language codes and rejects auto targets without network', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({translation: ['ok']}));
        await translateExtraFreeWebText('reversoFree', 'Hello', 'en', 'zh-CN');
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({from: 'eng', to: 'chi', options: {languageDetection: true, contextResults: true, origin: 'translation.web'}});
        expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({'x-reverso-origin': 'translation.web'});
        fetchMock.mockClear();
        await expect(translateExtraFreeWebText('lingvaFree', 'Hello', 'en', 'auto')).rejects.toMatchObject({statusCode: 400, freeFailure: 'request'});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('classifies HTTP failures and malformed Sogou bootstrap/results', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', {status: 429}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 429});
        fetchMock.mockReset().mockResolvedValueOnce(new Response('<html>no secret</html>'));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 502, freeFailure: 'unavailable'});
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(Response.json({status: 0, data: {translate: {dit: ''}}}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 502});
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(new Response('', {status: 503}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 503});
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(Response.json({status: 1}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
    });

    it('reports Sogou inner business errors even when its outer status is successful', async () => {
        fetchMock.mockResolvedValueOnce(home()).mockResolvedValueOnce(Response.json({status: 0, data: {translate: {errorCode: 's10', dit: ''}}}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toThrow('错误码 s10');
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(Response.json({status: '0', data: {translate: {errorCode: 's0', dit: '你好'}}}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).resolves.toBe('你好');
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(Response.json({status: 0, data: {translate: {errorCode: 'secret arbitrary body', dit: ''}}}));
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans')).rejects.toThrow('结果为空');
    });

    it('distinguishes Lingva access restrictions, rate limits and instance outages', async () => {
        for (const [status, message] of [[403, '拒绝自动访问'], [429, '限流'], [503, '暂时不可用']] as const) {
            fetchMock.mockReset().mockResolvedValueOnce(new Response('', {status, headers: {'Retry-After': '60'}}));
            await expect(translateExtraFreeWebText('lingvaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({message: expect.stringContaining(message), statusCode: status, retryAfterMs: 60000});
        }
    });

    it('covers provider language mappings and empty results', async () => {
        fetchMock.mockReset().mockResolvedValueOnce(home()).mockResolvedValueOnce(result('繁'));
        await translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-TW');
        fetchMock.mockReset().mockResolvedValueOnce(Response.json({translation: ['ok']}));
        await translateExtraFreeWebText('reversoFree', 'Hello', 'xx', 'en');
        fetchMock.mockReset().mockResolvedValueOnce(Response.json({translation: []}));
        await expect(translateExtraFreeWebText('reversoFree', 'Hello', 'en', 'zh-Hant')).rejects.toMatchObject({statusCode: 400, freeFailure: 'request'});
        fetchMock.mockReset().mockResolvedValueOnce(Response.json({translation: ''}));
        await expect(translateExtraFreeWebText('lingvaFree', 'Hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
        fetchMock.mockReset().mockResolvedValueOnce(Response.json(['eng-spa'])).mockResolvedValueOnce(new Response('', {status: 503}));
        await expect(translateExtraFreeWebText('apertiumFree', 'Hello', 'en', 'es')).rejects.toMatchObject({statusCode: 503});
    });

    it('handles blank and invalid top-level input', async () => {
        await expect(translateExtraFreeWebText('sogouFree', 1 as unknown as string, 'en', 'zh-Hans')).rejects.toMatchObject({statusCode: 400});
        await expect(translateExtraFreeWebText('sogouFree', ' \r\n ', 'en', 'zh-Hans')).resolves.toBe(' \r\n ');
    });

    it('cancels during a response and chunks long text for each protocol', async () => {
        const controller = new AbortController();
        fetchMock.mockResolvedValueOnce(home()).mockImplementationOnce(async () => { controller.abort(); return result('late'); });
        await expect(translateExtraFreeWebText('sogouFree', 'Hello', 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        for (const id of ['reversoFree', 'lingvaFree'] as const) {
            fetchMock.mockReset().mockImplementation(async (_url, init) => {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                return id === 'reversoFree' ? Response.json({translation: [body.input]}) : Response.json({translation: body ? undefined : 'chunk'});
            });
            const output = await translateExtraFreeWebText(id, 'x'.repeat(1001), 'en', 'zh-Hans');
            expect(output.length).toBeGreaterThan(0);
            expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
        }
    });
});
