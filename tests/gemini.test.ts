import {withProviderSnapshot} from './helpers/providerSnapshot';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockConfig} = vi.hoisted(() => ({
    mockConfig: {
        service: 'gemini',
        aiRequestTimeoutMs: undefined as number | undefined,
        to: 'zh-Hans',
        token: {gemini: 'google-secret-key'} as Record<string, string>,
        model: {gemini: 'gemini-2.5-flash'} as Record<string, string>,
        customModel: {} as Record<string, string>,
        customBody: {} as Record<string, string>,
        proxy: {} as Record<string, string>,
        user_role: {gemini: 'Translate to {{to}}: {{origin}}'} as Record<string, string>,
    },
}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import gemini from '@/src/providers/translation/gemini';
import {customModelString} from '@/src/core/config/catalog';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {prepareConfigForImport} from '@/src/core/config/transfer';
import {
    attachTranslationImageInput,
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';

const fetchMock = vi.fn<typeof fetch>();

function mockResponse(body: unknown, overrides: Partial<Response> = {}): Response {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockResolvedValue(body),
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
        ...overrides,
    } as unknown as Response;
}

beforeEach(() => {
    fetchMock.mockReset();
        mockConfig.aiRequestTimeoutMs = undefined;
    mockConfig.token.gemini = 'google-secret-key';
    mockConfig.model.gemini = 'gemini-2.5-flash';
    mockConfig.customModel = {};
    mockConfig.proxy = {};
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
        vi.unstubAllGlobals();
});

describe('Gemini adapter credential transport', () => {
    it('sends a direct Google API key in x-goog-api-key without putting it in the URL', async () => {
        fetchMock.mockResolvedValue(mockResponse({
            candidates: [{content: {parts: [{text: '译文'}]}}],
        }));

        await expect(gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig))).resolves.toBe('译文');

        const [requestUrl, init] = fetchMock.mock.calls[0]!;
        expect(requestUrl).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        );
        expect(String(requestUrl)).not.toContain('google-secret-key');
        const headers = init?.headers as Headers;
        expect(headers.get('x-goog-api-key')).toBe('google-secret-key');
        expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('does not add the Google API key to a custom proxy without a key placeholder', async () => {
        mockConfig.proxy.gemini = 'https://proxy.example/v1/generate';
        fetchMock.mockResolvedValue(mockResponse({
            candidates: [{content: {parts: [{text: '代理译文'}]}}],
        }));

        await expect(gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig))).resolves.toBe('代理译文');

        const [requestUrl, init] = fetchMock.mock.calls[0]!;
        expect(requestUrl).toBe('https://proxy.example/v1/generate');
        const headers = init?.headers as Headers;
        expect(headers.has('x-goog-api-key')).toBe(false);
        expect(JSON.stringify([...headers.entries()])).not.toContain('google-secret-key');
    });

    it('PR #495: expands proxy model and key placeholders and encodes reserved characters', async () => {
        mockConfig.model.gemini = 'custom/model +中文';
        mockConfig.token.gemini = 'key&extra=value?# +/%';
        mockConfig.proxy.gemini = '  https://proxy.example/v1beta/models/{model}:generateContent?key={key}&tenant=reader  ';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '代理译文'}]}}]}));

        await expect(gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig))).resolves.toBe('代理译文');

        expect(fetchMock).toHaveBeenCalledOnce();
        const [requestUrl, init] = fetchMock.mock.calls[0]!;
        const url = new URL(String(requestUrl));
        expect(url.pathname).toBe('/v1beta/models/custom%2Fmodel%20%2B%E4%B8%AD%E6%96%87:generateContent');
        expect([...url.searchParams.entries()]).toEqual([
            ['key', 'key&extra=value?# +/%'], ['tenant', 'reader'],
        ]);
        expect(url.hash).toBe('');
        expect((init?.headers as Headers).has('x-goog-api-key')).toBe(false);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body)).contents).toBeDefined();
    });

    it.each([
        {override: undefined, expected: 'configured/custom-model'},
        {override: 'request/model', expected: 'request/model'},
    ])('uses the effective custom model in a proxy template with override=$override', async ({override, expected}) => {
        mockConfig.model.gemini = customModelString;
        mockConfig.customModel.gemini = 'configured/custom-model';
        mockConfig.proxy.gemini = 'https://proxy.example/models/{model}:generateContent';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini', modelOverride: override}, mockConfig));

        expect(fetchMock.mock.calls[0]![0]).toBe(`https://proxy.example/models/${encodeURIComponent(expected)}:generateContent`);
        expect(String(fetchMock.mock.calls[0]![0])).not.toContain('google-secret-key');
    });

    it.each(['', undefined])('replaces a key placeholder with an empty value when the key is %s', async key => {
        if (key === undefined) delete mockConfig.token.gemini;
        else mockConfig.token.gemini = key;
        mockConfig.proxy.gemini = 'https://proxy.example/generate?key={key}';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig));

        const [requestUrl, init] = fetchMock.mock.calls[0]!;
        expect(requestUrl).toBe('https://proxy.example/generate?key=');
        expect((init?.headers as Headers).has('x-goog-api-key')).toBe(false);
    });

    it('keeps a complete proxy URL and its inline key unchanged', async () => {
        mockConfig.proxy.gemini = 'https://proxy.example/models/fixed:generateContent?key=inline%2Bkey';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini', modelOverride: 'another-model'}, mockConfig));

        expect(fetchMock.mock.calls[0]![0]).toBe(mockConfig.proxy.gemini);
    });

    it('treats a whitespace-only proxy as the official endpoint', async () => {
        mockConfig.proxy.gemini = ' \n\t ';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig));

        const [requestUrl, init] = fetchMock.mock.calls[0]!;
        expect(requestUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
        expect((init?.headers as Headers).get('x-goog-api-key')).toBe('google-secret-key');
    });

    it('uses frozen model, proxy and key values when global configuration changes', async () => {
        const source = normalizeConfig({...new Config(), service: 'gemini',
            model: {gemini: 'snapshot-model'}, token: {gemini: 'snapshot-key'},
            proxy: {gemini: 'https://snapshot.example/models/{model}?key={key}'},
        });
        const request = attachTranslationProviderConfig({origin: 'source', serviceOverride: 'gemini'},
            createTranslationProviderConfigSnapshot(source));
        source.token.gemini = 'changed-source-key';
        mockConfig.proxy.gemini = 'https://changed.example/generate';
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot(request, mockConfig));

        expect(fetchMock.mock.calls[0]![0]).toBe('https://snapshot.example/models/snapshot-model?key=snapshot-key');
    });

    it('uses the retained Gemini key when an imported proxy template explicitly contains {key}', async () => {
        const current = normalizeConfig({...new Config(), service: 'gemini', token: {gemini: 'saved-test-key'}});
        const imported = prepareConfigForImport({on: true, service: 'gemini', display: 1, from: 'auto', to: 'zh-Hans',
            proxy: {gemini: 'https://imported.example/models/{model}?key={key}'},
        }, current);
        const request = attachTranslationProviderConfig({origin: 'source', serviceOverride: 'gemini'},
            createTranslationProviderConfigSnapshot(imported));
        fetchMock.mockResolvedValue(mockResponse({candidates: [{content: {parts: [{text: '译文'}]}}]}));

        await gemini(withProviderSnapshot(request, mockConfig));

        expect(imported.token.gemini).toBe('saved-test-key');
        const url = new URL(String(fetchMock.mock.calls[0]![0]));
        expect(url.origin).toBe('https://imported.example');
        expect(url.searchParams.get('key')).toBe('saved-test-key');
    });

    it('surfaces only HTTP status metadata when a provider body contains a sentinel', async () => {
        const responseBody = vi.fn().mockResolvedValue('SENSITIVE_RESPONSE_SENTINEL');
        fetchMock.mockResolvedValue(mockResponse({}, {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            text: responseBody,
        }));

        const error = await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig)).catch(cause => cause);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('翻译失败: 403');
        expect((error as Error).message).not.toContain('SENSITIVE_RESPONSE_SENTINEL');
        expect(responseBody).not.toHaveBeenCalled();
    });

    it('does not reflect a malformed successful response in JSON parser errors', async () => {
        fetchMock.mockResolvedValue(mockResponse({}, {
            json: vi.fn().mockRejectedValue(
                new SyntaxError('Unexpected token S in SENSITIVE_SUCCESS_RESPONSE_SENTINEL'),
            ),
        }));

        const error = await gemini(withProviderSnapshot({origin: 'source', serviceOverride: 'gemini'}, mockConfig)).catch(cause => cause);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Gemini 返回的不是有效 JSON');
        expect((error as Error).message).not.toContain('SENSITIVE_SUCCESS_RESPONSE_SENTINEL');
    });
});


describe('gemini AI 请求超时预算', () => {
    it('直接调用默认允许 60 秒响应，完成后清理超时计时器', async () => {
        vi.useFakeTimers();
        let resolve!: (value: Response) => void;
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise<Response>(done => {resolve = done;});
        });
        const result = gemini(withProviderSnapshot({origin: 'Slow native AI source'}, mockConfig));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(signal.aborted).toBe(false);
        resolve(mockResponse({candidates: [{content: {parts: [{text: '缓慢模型译文'}]}}]}));
        await expect(result).resolves.toBe('缓慢模型译文');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        {configured: 10_000, explicit: undefined, deadline: 10_000},
        {configured: 600_000, explicit: 500, deadline: 500},
        {configured: 10_000, explicit: 180_000, deadline: 180_000},
    ])('配置与显式剩余预算在精确截止 abort：$deadline 毫秒', async ({configured, explicit, deadline}) => {
        vi.useFakeTimers();
        mockConfig.aiRequestTimeoutMs = configured;
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise((_, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
        });
        const outcome = gemini(withProviderSnapshot({origin: 'Native AI deadline source', requestTimeoutMs: explicit}, mockConfig)).catch(error => error);
        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(outcome).resolves.toMatchObject({kind: 'timeout', retryable: true});
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('用户取消立即传播，与延长后的等待时间无关', async () => {
        vi.useFakeTimers();
        mockConfig.aiRequestTimeoutMs = 600_000;
        const controller = new AbortController();
        let signal!: AbortSignal;
        fetchMock.mockImplementation((_input, init) => {
            signal = init!.signal!;
            return new Promise((_, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('aborted', 'AbortError')), {once: true}));
        });
        const outcome = gemini(withProviderSnapshot({origin: 'Cancelled native AI source', abortSignal: controller.signal}, mockConfig)).catch(error => error);
        controller.abort();
        await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});


it('未结束的超大图片错误返回安全 HTTP 状态并释放原始流', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(stream) {controller = stream; stream.enqueue(new Uint8Array(128 * 1024));}});
    fetchMock.mockResolvedValue(new Response(body, {status: 400}));
    const request = withProviderSnapshot(attachTranslationImageInput({origin: 'source', serviceOverride: 'gemini'}, 'data:image/png;base64,AAAA'), mockConfig);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            gemini(request).catch(error => error),
            new Promise<'unsettled'>(resolve => {timer = setTimeout(() => resolve('unsettled'), 300);}),
        ]);
        expect(result).toMatchObject({statusCode: 400}); expect((result as Error).message).not.toContain('google-secret-key');
    } finally {clearTimeout(timer); try {controller.close();} catch { /* provider 已取消原流 */ }}
});

describe('Gemini 响应读取期间的取消', () => {
    it('正文读取截止时仍区分超时和用户取消', async () => {
        vi.useFakeTimers();
        let notifyRead!: () => void;
        const readStarted = new Promise<void>(resolve => {notifyRead = resolve;});
        fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
            start(stream) {init!.signal!.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), {once: true});},
            pull() {notifyRead();},
        }, {highWaterMark: 0})));
        const outcome = gemini(withProviderSnapshot({origin: 'hello', requestTimeoutMs: 10}, mockConfig)).catch(error => error);
        await readStarted;
        await vi.advanceTimersByTimeAsync(10);
        await expect(outcome).resolves.toMatchObject({name: 'TimeoutError', kind: 'timeout', retryable: true});
        expect(vi.getTimerCount()).toBe(0);
    });

    it('取消后不合作的传输返回完整正文也不发布译文', async () => {
        const owner = new AbortController();
        const stream = new ReadableStream<Uint8Array>({
            pull(output) {
                owner.abort();
                output.enqueue(new TextEncoder().encode(JSON.stringify({candidates: [{content: {parts: [{text: '迟到译文'}]}}]})));
                output.close();
            },
        }, {highWaterMark: 0});
        fetchMock.mockResolvedValue(new Response(stream));
        await expect(gemini(withProviderSnapshot({origin: 'hello', abortSignal: owner.signal}, mockConfig)))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('用户取消已返回的响应流应返回 AbortError 而非格式错误', async () => {
        const owner = new AbortController();
        let notifyRead!: () => void;
        const readStarted = new Promise<void>(resolve => {notifyRead = resolve;});
        fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
            start(stream) {init!.signal!.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), {once: true});},
            pull() {notifyRead();},
        }, {highWaterMark: 0})));
        const observed = vi.fn();
        const message = withProviderSnapshot(attachTranslationModelUsageObserver(
            {origin: 'private text', abortSignal: owner.signal}, observed,
        ), mockConfig);
        const outcome = gemini(message).catch(error => error);
        await readStarted;
        owner.abort();
        await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0]?.[0]).toMatchObject({outcome: 'cancelled', usageAvailability: 'unreported'});
    });
});
