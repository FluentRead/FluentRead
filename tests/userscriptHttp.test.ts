import {afterEach, describe, expect, it, vi} from 'vitest';
import {userscriptFetch} from '@/userscript/http';
import {OPENAI_ERROR_BODY_LIMIT} from '@/src/providers/translation/ai-sdk/boundedErrorResponse';
import {DOUBAO_GUEST_HEADER} from '@/src/platform/http/doubaoGuest';

describe('userscript HTTP transport', () => {
    afterEach(() => {
        globalThis.GM_xmlhttpRequest = undefined;
        globalThis.GM = undefined;
        globalThis.GM_info = undefined;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['callback', 'promise'] as const)('bounds only opted-in failed GM responses before constructing Response (%s)', async mode => {
        const long = 'x'.repeat(4 * 1024 * 1024);
        const payload = {status: 429, statusText: 'Too Many Requests', responseText: long,
            responseHeaders: 'content-type: text/plain\r\ncontent-length: 4194304\r\ncontent-encoding: gzip\r\nretry-after: 7\r\nx-request-id: fixture'};
        const detailsSeen: UserscriptXmlHttpRequestDetails[] = [];
        if (mode === 'callback') globalThis.GM_xmlhttpRequest = details => {
            detailsSeen.push(details); queueMicrotask(() => details.onload?.(payload)); return {abort() {}};
        };
        else globalThis.GM = {xmlHttpRequest: details => {detailsSeen.push(details); return Promise.resolve(payload);}};
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        const response = await userscriptFetch('https://api.example.test/openai', {method: 'POST', body: '{}'}, {errorBodyLimit: OPENAI_ERROR_BODY_LIMIT});
        expect(response.status).toBe(429);
        expect(response.statusText).toBe('Too Many Requests');
        expect(response.headers.get('retry-after')).toBe('7');
        expect(response.headers.get('x-request-id')).toBe('fixture');
        expect(response.headers.has('content-length')).toBe(false);
        expect(response.headers.has('content-encoding')).toBe(false);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(await response.text()).toBe(OPENAI_ERROR_BODY_LIMIT.replacement);
        expect(encode.mock.calls.some(([text]) => text === long)).toBe(false);
        expect(detailsSeen[0].headers).not.toHaveProperty('errorBodyLimit');
    });

    it.each([
        ['a'.repeat(32_768), false],
        ['a'.repeat(32_769), true],
        ['中'.repeat(10_922) + 'ab', false],
        ['中'.repeat(10_923), true],
        ['😀'.repeat(8_192), false],
        ['😀'.repeat(8_192) + 'x', true],
        ['\ud800'.repeat(10_923), true],
    ])('preserves or bounds opted-in errors at the UTF-8 byte limit', async (body, oversized) => {
        globalThis.GM_xmlhttpRequest = details => {queueMicrotask(() => details.onload?.({status: 400, responseText: body}));};
        const result = await userscriptFetch('https://api.example.test/utf8', undefined, {errorBodyLimit: OPENAI_ERROR_BODY_LIMIT});
        expect(await result.text()).toBe(oversized ? OPENAI_ERROR_BODY_LIMIT.replacement : new TextDecoder().decode(new TextEncoder().encode(body)));
    });

    it('does not limit success, unrelated GM callers, null bodies, or invalid policies', async () => {
        const long = 'x'.repeat(32_769); let status = 200;
        globalThis.GM_xmlhttpRequest = details => {queueMicrotask(() => details.onload?.({status, responseText: long}));};
        const policy = {errorBodyLimit: OPENAI_ERROR_BODY_LIMIT};
        expect(await (await userscriptFetch('https://api.example.test/success', undefined, policy)).text()).toBe(long);
        status = 400;
        expect(await (await userscriptFetch('https://api.example.test/unrelated')).text()).toBe(long);
        expect(await (await userscriptFetch('https://api.example.test/bad-policy', undefined, {errorBodyLimit: {maxBytes: -1, replacement: 'bad'}})).text()).toBe(long);
        status = 304;
        expect(await (await userscriptFetch('https://api.example.test/empty', undefined, policy)).text()).toBe('');
    });

    it('preserves caller cancellation when abort synchronously delivers a late oversized response', async () => {
        const controller = new AbortController(); const long = 'x'.repeat(1024 * 1024);
        let ready!: () => void; const started = new Promise<void>(resolve => {ready = resolve;});
        globalThis.GM_xmlhttpRequest = details => {
            ready(); return {abort() {details.onload?.({status: 400, responseText: long}); details.onabort?.({status: 0});}};
        };
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        const pending = userscriptFetch('https://api.example.test/cancel', {signal: controller.signal}, {errorBodyLimit: OPENAI_ERROR_BODY_LIMIT});
        const rejection = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await started; controller.abort(); await rejection;
        expect(encode.mock.calls.some(([text]) => text === long)).toBe(false);
    });

    it('uses Safari Userscripts promise-only GM.xmlHttpRequest without falling back to page fetch', async () => {
        let calls = 0;
        globalThis.GM = {
            xmlHttpRequest(details) {
                calls += 1;
                expect(details.url).toBe('https://api.example.test/safari');
                return Promise.resolve({
                    status: 200,
                    statusText: 'OK',
                    responseText: '{"translation":"你好"}',
                    responseHeaders: 'content-type: application/json',
                });
            },
        };

        const response = await userscriptFetch('https://api.example.test/safari');
        expect(calls).toBe(1);
        expect(await response.json()).toEqual({translation: '你好'});
    });

    it('propagates cancellation to a modern GM promise handle', async () => {
        let aborted = false;
        globalThis.GM = {
            xmlHttpRequest() {
                const pending = new Promise<UserscriptXmlHttpResponse>(() => undefined) as
                    Promise<UserscriptXmlHttpResponse> & {abort?: () => void};
                pending.abort = () => { aborted = true; };
                return pending;
            },
        };
        const controller = new AbortController();
        const request = userscriptFetch('https://api.example.test/slow', {signal: controller.signal});
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        controller.abort();
        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(aborted).toBe(true);
    });

    it.each(['before', 'during'] as const)('cancels %s reading a streaming Request body without dispatching GM', async timing => {
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({start(controller) {source = controller; controller.enqueue(new Uint8Array([1]));}});
        const controller = new AbortController();
        const request = new Request('https://api.example.test/stream', {method: 'POST', body, duplex: 'half'} as RequestInit);
        const dispatch = vi.fn();
        globalThis.GM_xmlhttpRequest = dispatch;
        if (timing === 'before') controller.abort();
        const pending = userscriptFetch(request, {signal: controller.signal}).then(() => null, error => error);
        if (timing === 'during') {await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();}
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([pending, new Promise(resolve => {timer = setTimeout(() => resolve('body read stalled'), 150);})]);
        clearTimeout(timer);
        source.close();
        await pending;
        expect(result).toMatchObject({name: 'AbortError'});
        expect(dispatch).not.toHaveBeenCalled();
        // Preparing a GM upload must not consume the caller's reusable original Request.
        expect(request.bodyUsed).toBe(false);
    });

    it('passes a streaming Request directly to native fetch when GM is unavailable', async () => {
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({start(controller) {source = controller;}});
        const request = new Request('https://api.example.test/native', {method: 'POST', body, duplex: 'half'} as RequestInit);
        const clone = vi.spyOn(request, 'clone');
        const response = new Response('native');
        const native = vi.fn(async () => response);
        vi.stubGlobal('fetch', native);
        const pending = userscriptFetch(request);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([pending, new Promise(resolve => {timer = setTimeout(() => resolve('unnecessary body read'), 150);})]);
        clearTimeout(timer);
        source.close();
        await pending;
        expect(result).toBe(response);
        expect(clone).not.toHaveBeenCalled();
        expect(native).toHaveBeenCalledWith(request, undefined);
    });

    it('preserves empty uploads and URL objects through the GM transport', async () => {
        const captured: UserscriptXmlHttpRequestDetails[] = [];
        globalThis.GM_xmlhttpRequest = details => {
            captured.push(details);
            details.onload?.({status: 200, response: 'fallback body', responseHeaders: 'broken\r\n : skip\r\nx-valid: yes'});
        };
        const response = await userscriptFetch(new Request('https://api.example.test/empty', {method: 'POST'}));
        expect(captured[0].data).toBeInstanceOf(ArrayBuffer);
        expect((captured[0].data as ArrayBuffer).byteLength).toBe(0);
        expect(await response.text()).toBe('fallback body');
        expect(response.headers.get('x-valid')).toBe('yes');
        await userscriptFetch(new URL('https://api.example.test/url'));
        expect(captured[1].url).toBe('https://api.example.test/url');
    });

    it.each([
        ['onerror', {status: 503}, 'HTTP 503'],
        ['onerror', {status: 0, statusText: 'disconnected'}, 'disconnected'],
        ['ontimeout', undefined, 'unknown error'],
    ] as const)('settles manager %s failures with bounded response metadata', async (event, metadata, expected) => {
        globalThis.GM_xmlhttpRequest = details => {details[event]?.(metadata as UserscriptXmlHttpResponse);};
        await expect(userscriptFetch('https://api.example.test/failure')).rejects.toThrow(expected);
    });

    it('keeps cancellation authoritative when the manager handle throws and refuses already-cancelled URL requests', async () => {
        const controller = new AbortController();
        let started!: () => void;
        const ready = new Promise<void>(resolve => {started = resolve;});
        globalThis.GM_xmlhttpRequest = () => {started(); return {abort() {throw new Error('expired handle');}};};
        const pending = userscriptFetch('https://api.example.test/abort', {signal: controller.signal});
        const rejection = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await ready;
        controller.abort();
        await rejection;
        const dispatch = vi.fn();
        globalThis.GM_xmlhttpRequest = dispatch;
        await expect(userscriptFetch('https://api.example.test/abort', {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('reports synchronous manager failure and delegates invalid native URLs without masking native errors', async () => {
        globalThis.GM_xmlhttpRequest = () => {throw new Error('manager unavailable');};
        await expect(userscriptFetch('https://api.example.test/failure')).rejects.toThrow('manager unavailable');
        const failure = new TypeError('invalid native URL');
        const native = vi.fn(async () => {throw failure;});
        vi.stubGlobal('fetch', native);
        await expect(userscriptFetch('http://[')).rejects.toBe(failure);
        expect(native).toHaveBeenCalledWith('http://[', undefined);
    });

    it('reports a manager-originated abort without requiring a caller AbortSignal', async () => {
        globalThis.GM_xmlhttpRequest = details => {details.onabort?.({status: 0, statusText: 'Aborted', responseText: ''});};
        await expect(userscriptFetch('https://api.example.test/manager-abort')).rejects.toMatchObject({name: 'AbortError'});
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

    it('honors credentials omit from Request or RequestInit without changing ordinary GM credentials', async () => {
        const captured: UserscriptXmlHttpRequestDetails[] = [];
        globalThis.GM_xmlhttpRequest = details => {
            captured.push(details);
            queueMicrotask(() => details.onload?.({status: 200, responseText: 'ok'}));
            return {abort() {}};
        };
        const endpoint = 'https://oneshot-free.www.deepl.com/v1/translate';
        await userscriptFetch(endpoint, {credentials: 'omit'});
        await userscriptFetch(new Request(endpoint, {credentials: 'omit'}));
        await userscriptFetch(new Request(endpoint, {credentials: 'include'}), {credentials: 'omit'});
        await userscriptFetch(new Request(endpoint, {credentials: 'omit'}), {credentials: 'include'});
        await userscriptFetch(endpoint, {credentials: 'same-origin'});
        expect(captured.slice(0, 3).every(request => request.anonymous === true)).toBe(true);
        expect(captured[3]).not.toHaveProperty('anonymous');
        expect(captured[4]).not.toHaveProperty('anonymous');

        globalThis.GM_xmlhttpRequest = undefined;
        globalThis.GM = {
            xmlHttpRequest(details) {
                expect(details.anonymous).toBe(true);
                return Promise.resolve({status: 200, responseText: 'ok'});
            },
        };
        await expect(userscriptFetch(endpoint, {credentials: 'omit'})).resolves.toBeInstanceOf(Response);
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

    it('does not turn missing or zero GM HTTP statuses into successful translations', async () => {
        globalThis.GM_xmlhttpRequest = (details) => {
            queueMicrotask(() => details.onload?.({status: 0, statusText: '', responseText: ''}));
            return {abort() {}};
        };
        await expect(userscriptFetch('https://api.example.test/network-failure'))
            .rejects.toThrow('invalid HTTP status: 0');

        globalThis.GM_xmlhttpRequest = undefined;
        globalThis.GM = {
            xmlHttpRequest: () => Promise.resolve({
                statusText: 'OK',
                responseText: '{"translation":"false success"}',
            } as UserscriptXmlHttpResponse),
        };
        await expect(userscriptFetch('https://api.example.test/missing-status'))
            .rejects.toThrow('invalid HTTP status: missing');
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

    it('isolates Doubao anonymous requests and consumes the internal guest header', async () => {
        globalThis.GM_info = {scriptHandler: 'Tampermonkey', version: '5.6.6239', platform: {browserName: 'chrome', os: 'mac'}};
        const captured: UserscriptXmlHttpRequestDetails[] = [];
        globalThis.GM_xmlhttpRequest = details => {
            captured.push(details);
            queueMicrotask(() => details.onload?.({status: 200, responseText: 'ok'}));
            return {abort() {}};
        };
        await userscriptFetch('https://www.doubao.com/');
        await userscriptFetch('https://ttwid.bytedance.com/ttwid/union/register/', {method: 'POST'});
        await userscriptFetch('https://www.doubao.com/samantha/plugin/stream_article_translate?tea_uuid=123456789012345678', {
            method: 'POST', headers: {[DOUBAO_GUEST_HEADER]: 'anonymous-test-token', Cookie: 'personal=secret'},
        });
        expect(captured.every(request => request.anonymous === true)).toBe(true);
        expect(captured[2].headers).toMatchObject({cookie: 'ttwid=anonymous-test-token', origin: 'https://www.doubao.com', referer: 'https://www.doubao.com/'});
        expect(captured[2].redirect).toBe('error');
        expect(captured[2].headers).not.toHaveProperty(DOUBAO_GUEST_HEADER.toLowerCase());
    });

    it('rejects guest requests without a privileged manager or to another endpoint', async () => {
        await expect(userscriptFetch('https://www.doubao.com/samantha/plugin/stream_article_translate', {
            method: 'POST', headers: {[DOUBAO_GUEST_HEADER]: 'anonymous-test-token'},
        })).rejects.toThrow('需要脚本管理器');
        await expect(userscriptFetch('https://other.test/', {
            method: 'POST', headers: {[DOUBAO_GUEST_HEADER]: 'anonymous-test-token'},
        })).rejects.toThrow('无法发送豆包匿名');
    });

    it('refuses Doubao bootstrap before managers with unknown or unsupported anonymity can send cookies', async () => {
        let calls = 0;
        globalThis.GM_xmlhttpRequest = () => {calls++; return {abort() {}};};
        for (const info of [undefined,
            {scriptHandler: 'Userscripts', version: '6.0', platform: {browserName: 'safari', os: 'mac'}},
            {scriptHandler: 'Tampermonkey', version: '5.4.0', platform: {browserName: 'chrome', os: 'mac'}},
            {scriptHandler: 'Tampermonkey', version: '5.6.6239', platform: {browserName: 'chrome', os: 'android'}},
            {scriptHandler: 'Tampermonkey', version: '5.6.6239', platform: {os: 'mac'}},
            {scriptHandler: 'Tampermonkey', version: '5.6.6239', platform: {browserName: 'chrome'}},
        ]) {
            globalThis.GM_info = info;
            await expect(userscriptFetch('https://www.doubao.com/', {credentials: 'omit'})).rejects.toThrow('无法发送豆包匿名');
        }
        expect(calls).toBe(0);
    });

    it('uses modern GM metadata when classic metadata is absent', async () => {
        globalThis.GM = {info: {scriptHandler: 'Tampermonkey', version: '6.0', platform: {browserName: 'chrome', os: 'mac'}},
            xmlHttpRequest: details => {expect(details.anonymous).toBe(true); return Promise.resolve({status: 200});}};
        const response = await userscriptFetch('https://www.doubao.com/');
        expect(await response.text()).toBe('');
    });
});
