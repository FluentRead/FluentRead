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
        const reading = new AbortController();
        const duringBody = vi.fn(async () => ({ok: true, json: async () => {
            reading.abort();
            return [{translations: [{text: '一'}]}];
        }} as unknown as Response));
        await expect(translateMicrosoftTextsWithTransport(duringBody, ['one'], 'en', 'zh-Hans', reading.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('accepts unchanged named and numeric entity literals after one transport decoding pass', async () => {
        const sources = ['Use <b>66</b> & &lt; in the manual.', 'Keep &amp; &AMP; &#60; &#x3c; &#X3C; &custom42; &a;.'];
        const transport = vi.fn(async () => response([
            {translations: [{text: '在手册中使用 &lt;b&gt;66&lt;/b&gt; &amp; &amp;lt;。'}]},
            {translations: [{text: '保留 &amp;amp; &amp;AMP; &amp;#60; &amp;#x3c; &amp;#X3C; &amp;custom42; &amp;a;。'}]},
        ]));
        await expect(translateMicrosoftTextsWithTransport(transport, sources, 'en', 'zh-Hans'))
            .resolves.toEqual(['在手册中使用 <b>66</b> & &lt;。', '保留 &amp; &AMP; &#60; &#x3c; &#X3C; &custom42; &a;。']);
        expect(transport).toHaveBeenCalledOnce();
        const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
        expect(url.searchParams.get('from')).toBe('en');
        expect(JSON.parse(init.body as string)[0]).toBe('Use &lt;b&gt;66&lt;/b&gt; &amp; &amp;lt; in the manual.');
    });

    it.each([
        {source: 'Use &lt; in the manual.', raw: '使用 &amp;;。', reason: '服务删除实体名'},
        {source: 'Use &lt; in the manual.', raw: '使用 &lt;。', reason: '服务把字面实体解释为符号'},
        {source: 'Use &lt; in the manual.', raw: '使用 &amp;LT;。', reason: '实体大小写被改写'},
        {source: 'Use &#60; in the manual.', raw: '使用 &amp;#x3c;。', reason: '数字写法被改写'},
        {source: 'Use &lt; in the manual.', raw: '使用 &amp;lt; 和 &amp;lt;。', reason: '实体重复'},
        {source: 'Use &lt; &lt; in the manual.', raw: '使用 &amp;lt;。', reason: '重复来源只返回一次'},
        {source: 'Use &lt; in the manual.', raw: '\u200b', reason: '实体槽为空译文'},
        {source: 'Use &lt; in the manual.', raw: '使用 &amp;l\u200bt;。', reason: '实体名插入零宽字符'},
    ])('rejects $reason without a provider retry', async ({source, raw}) => {
        const transport = vi.fn(async () => response([{translations: [{text: raw}]}]));
        await expect(translateMicrosoftTextsWithTransport(transport, [source], 'en', 'zh-Hans'))
            .rejects.toMatchObject({kind: 'response', code: 'NATIVE_BATCH_RESPONSE_INVALID', retryable: false});
        expect(transport).toHaveBeenCalledOnce();
    });

    it('checks literal counts independently for each slot and rejects the entire native response', async () => {
        const valid = vi.fn(async () => response([
            {translations: [{text: '两次 &amp;lt; &amp;lt;，另一次 &amp;amp;。'}]},
            {translations: [{text: '另一个源槽 &amp;lt;。'}]},
        ]));
        await expect(translateMicrosoftTextsWithTransport(valid, ['Keep &lt; &lt; and &amp;.', 'Keep &lt;.'], 'en', 'zh-Hans'))
            .resolves.toEqual(['两次 &lt; &lt;，另一次 &amp;。', '另一个源槽 &lt;。']);
        const shifted = vi.fn(async () => response([
            {translations: [{text: '第一条没有实体。'}]},
            {translations: [{text: '第二条 &amp;lt; &amp;lt;。'}]},
        ]));
        await expect(translateMicrosoftTextsWithTransport(shifted, ['First &lt;.', 'Second &lt;.'], 'en', 'zh-Hans'))
            .rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        expect(shifted).toHaveBeenCalledOnce();
        const laterBroken = vi.fn(async () => response([
            {translations: [{text: '正常译文。'}]},
            {translations: [{text: '使用 &amp;;。'}]},
        ]));
        await expect(translateMicrosoftTextsWithTransport(laterBroken, ['Ordinary text.', 'Use &lt;.'], 'en', 'zh-Hans'))
            .rejects.toMatchObject({code: 'NATIVE_BATCH_RESPONSE_INVALID'});
        expect(laterBroken).toHaveBeenCalledOnce();
    });

    it('does not upload blank or zero-width sources or interpret incomplete entities as protected tokens', async () => {
        const transport = vi.fn(async () => response([{translations: [{text: '原样 &amp;lt;。'}]}, {translations: [{text: '普通译文。'}]}]));
        await expect(translateMicrosoftTextsWithTransport(transport, ['\u200b', ' ', 'Keep &lt;.', 'Use & and &lt without semicolon.'], 'en', 'zh-Hans'))
            .resolves.toEqual(['\u200b', ' ', '原样 &lt;。', '普通译文。']);
        expect(JSON.parse((transport.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string))
            .toEqual(['Keep &amp;lt;.', 'Use &amp; and &amp;lt without semicolon.']);
        expect(transport).toHaveBeenCalledOnce();
    });
});
