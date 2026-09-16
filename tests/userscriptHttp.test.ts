import {afterEach, describe, expect, it} from 'vitest';
import {userscriptFetch} from '@/userscript/http';

describe('userscript HTTP transport', () => {
    afterEach(() => {
        globalThis.GM_xmlhttpRequest = undefined;
    });

    it('wraps Via-compatible responseText as a fetch Response', async () => {
        let captured: UserscriptXmlHttpRequestDetails | undefined;
        globalThis.GM_xmlhttpRequest = (details) => {
            captured = details;
            queueMicrotask(() => details.onload?.({
                status: 200,
                statusText: 'OK',
                responseText: '{"translation":"你好"}',
                responseHeaders: 'content-type: application/json\r\nx-test: userscript',
            }));
            return {abort() {}};
        };

        const response = await userscriptFetch('https://api.example.test/translate', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: '{"text":"hello"}',
        });

        expect(captured?.method).toBe('POST');
        expect(captured?.data).toBe('{"text":"hello"}');
        expect(captured).not.toHaveProperty('responseType');
        expect(captured).not.toHaveProperty('anonymous');
        expect(response.headers.get('x-test')).toBe('userscript');
        expect(await response.json()).toEqual({translation: '你好'});
    });

    it('settles null-body statuses and non-ByteString manager metadata instead of stalling', async () => {
        const responses: UserscriptXmlHttpResponse[] = [
            {status: 204, statusText: 'No Content', responseText: ''},
            {
                status: 200,
                statusText: '成功',
                responseText: '{"ok":true}',
                responseHeaders: 'x y: invalid-name\r\nx-provider: 有道\r\ncontent-type: application/json',
            },
        ];
        globalThis.GM_xmlhttpRequest = (details) => {
            const response = responses.shift()!;
            queueMicrotask(() => details.onload?.(response));
            return {abort() {}};
        };
        // 回调内构造 Response 抛错时，旧实现已经关闭完成门，调用方和后续 abort 都无法结算。
        const withinDeadline = (pending: Promise<Response>) => Promise.race([
            pending,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request stalled')), 200)),
        ]);

        const noContent = await withinDeadline(userscriptFetch('https://api.example.test/usage', {method: 'POST'}));
        expect(noContent.status).toBe(204);
        expect(await noContent.text()).toBe('');

        const translated = await withinDeadline(userscriptFetch('https://api.example.test/translate'));
        expect(translated.statusText).toBe('');
        expect(translated.headers.get('content-type')).toBe('application/json');
        expect(translated.headers.has('x-provider')).toBe(false);
        expect(await translated.json()).toEqual({ok: true});

        // 无法转换的回调载荷也必须结算为失败，而不是让 provider 永久等待。
        globalThis.GM_xmlhttpRequest = (details) => {
            queueMicrotask(() => details.onload?.(undefined as unknown as UserscriptXmlHttpResponse));
            return {abort() {}};
        };
        await expect(withinDeadline(userscriptFetch('https://api.example.test/broken')))
            .rejects.toBeInstanceOf(TypeError);
    });

    it('propagates AbortSignal to the GM request handle', async () => {
        let aborted = false;
        globalThis.GM_xmlhttpRequest = () => ({abort() { aborted = true; }});
        const controller = new AbortController();
        const pending = userscriptFetch('https://api.example.test/slow', {signal: controller.signal});
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        controller.abort();

        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(aborted).toBe(true);
    });
});
