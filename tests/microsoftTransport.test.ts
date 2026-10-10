import {describe, expect, it, vi} from 'vitest';
import {translateMicrosoftTextsWithTransport} from '@/src/providers/translation/microsoftTransport';

function response(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {status});
}

describe('shared Microsoft translation transport', () => {
    it('skips empty batches without a network request', async () => {
        const transport = vi.fn();
        await expect(translateMicrosoftTextsWithTransport(transport, [], 'auto', 'zh-CN')).resolves.toEqual([]);
        expect(transport).not.toHaveBeenCalled();
    });

    it('escapes plain text, forwards cancellation, and restores every HTML entity in the response', async () => {
        const signal = new AbortController().signal;
        const transport = vi.fn(async () => response([{translations: [{text: '&amp;&lt;&gt;&quot;&#39;&#x27;'}]}]));
        const result = await translateMicrosoftTextsWithTransport(transport, ['&<>"\''], 'auto', 'sr', signal);
        expect(result).toEqual(['&<>"\'\'']);
        const [url, options] = transport.mock.calls[0] as unknown as [URL, RequestInit];
        expect(url.origin).toBe('https://edge.microsoft.com');
        expect(url.searchParams.get('from')).toBe('');
        expect(url.searchParams.get('to')).toBe('sr-Cyrl');
        expect(options).toMatchObject({method: 'POST', headers: {'Content-Type': 'application/json'}, signal});
        expect(options.body).toBe('["&amp;&lt;&gt;&quot;&#39;"]');
    });

    it('normalizes source language, keeps result order, and rejects invalid transport responses', async () => {
        const transport = vi.fn(async () => response([{translations: [{text: '一'}]}, {translations: [{text: '二'}]}]));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one', 'two'], 'sr', 'zh-Hans'))
            .resolves.toEqual(['一', '二']);
        const [url] = transport.mock.calls[0] as unknown as [URL];
        expect(url.searchParams.get('from')).toBe('sr-Cyrl');
        expect(url.searchParams.get('to')).toBe('zh-Hans');

        transport.mockImplementationOnce(async () => response([], 503));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one'], 'en', 'zh-CN')).rejects.toThrow();
        transport.mockImplementationOnce(async () => new Response('not-json'));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one'], 'en', 'zh-CN')).rejects.toThrow();
        for (const invalid of [null, {}, [], [null], [{translations: []}], [{translations: [{text: 4}]}],
            [{translations: {0: {text: '一'}}}], [{translations: [{text: '一'}, {text: '多余'}]}],
            [{translations: [{text: ''}]}], [{translations: [{text: '\u200b'}]}]]) {
            transport.mockImplementationOnce(async () => response(invalid));
            await expect(translateMicrosoftTextsWithTransport(transport, ['one'], 'en', 'zh-CN')).rejects.toThrow();
        }
    });

    it('preserves blank sources and validates every nonempty slot before returning', async () => {
        const transport = vi.fn(async () => response([{translations: [{text: '一'}]}, {translations: [{text: '二'}]}]));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one', '\n ', 'two'], 'en', 'zh-Hans'))
            .resolves.toEqual(['一', '\n ', '二']);
        expect(JSON.parse((transport.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string))
            .toEqual(['one', 'two']);
        transport.mockImplementationOnce(async () => response([{translations: [{text: '一'}]}, {translations: [{text: ''}]}]));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one', 'two'], 'en', 'zh-Hans'))
            .rejects.toMatchObject({kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false});
        transport.mockImplementationOnce(async () => new Response('[{"translations":'));
        await expect(translateMicrosoftTextsWithTransport(transport, ['one', 'two'], 'en', 'zh-Hans'))
            .rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
    });

    it('checks cancellation after transport and before returning any slot', async () => {
        const cancelled = new AbortController();cancelled.abort();
        const unopened = vi.fn();
        await expect(translateMicrosoftTextsWithTransport(unopened, ['one'], 'en', 'zh-Hans', cancelled.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(unopened).not.toHaveBeenCalled();
        const controller = new AbortController();
        const transport = vi.fn(async () => {controller.abort(); return response([{translations: [{text: '一'}]}]);});
        await expect(translateMicrosoftTextsWithTransport(transport, ['one'], 'en', 'zh-Hans', controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});
