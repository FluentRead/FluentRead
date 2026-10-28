import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    fetchImageInOffscreen,
    fetchPageImageForOcr,
    fetchRemoteImageForOcr,
    imageBufferToDataUrl,
    MAX_REMOTE_IMAGE_BYTES,
    normalizeRemoteImageMimeType,
    normalizeRemoteImageUrl,
    REMOTE_IMAGE_TIMEOUT_MS,
    type RemoteImageResponse,
} from '@/src/features/image-translation/services/remoteImage';

function response(options: {
    ok?: boolean;
    status?: number;
    contentType?: string | null;
    contentLength?: string | null;
    bytes?: number[];
    url?: string;
    body?: ReadableStream<Uint8Array> | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
} = {}): RemoteImageResponse {
    const headers = new Map<string, string>();
    if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'image/png');
    if (options.contentLength !== null) headers.set('content-length', options.contentLength ?? '2');
    return {
        ok: options.ok ?? true,
        status: options.status ?? 200,
        url: options.url,
        headers: {get: (name) => headers.get(name) ?? null},
        body: options.body,
        arrayBuffer: options.arrayBuffer ?? (async () => new Uint8Array(options.bytes ?? [1, 2]).buffer),
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Offscreen 远程图片读取', () => {
    it('多分块读取时及时释放取消监听并保留图片字节', async () => {
        let remaining = 2048;
        const body = new ReadableStream<Uint8Array>({
            pull(stream) {
                if (remaining-- > 0) stream.enqueue(new Uint8Array([7]));
                else stream.close();
            },
        });
        const nativeRace = Promise.race.bind(Promise), registrations = new WeakMap<object, number>();
        let mostRegistrations = 0;
        const race = vi.spyOn(Promise, 'race').mockImplementation(values => {
            const inputs = Array.from(values);
            if (inputs.length === 2 && inputs[1] instanceof Promise) {
                const count = (registrations.get(inputs[1]) ?? 0) + 1;
                registrations.set(inputs[1], count); mostRegistrations = Math.max(mostRegistrations, count);
            }
            return nativeRace(inputs);
        });
        try {
            const result = await fetchRemoteImageForOcr('https://pbs.twimg.com/media/demo.png', async () => response({body}));
            expect(result).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(2048).fill(7)))}`);
            expect(mostRegistrations).toBe(1);
        } finally {
            race.mockRestore();
        }
    });
    it('收到响应后取消时不会开始读取图片流', async () => {
        const caller = new AbortController();
        const read = vi.fn();
        const item = response({body: {getReader: () => ({read, cancel: vi.fn(async () => {}), releaseLock: vi.fn()})} as never});
        const get = item.headers.get;
        item.headers.get = name => {
            const value = get(name);
            if (name === 'content-type') caller.abort();
            return value;
        };
        await expect(fetchRemoteImageForOcr('https://pbs.twimg.com/media/demo.png', async () => item, caller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(read).not.toHaveBeenCalled();
    });
    it('网页 CORS 端口保留网页重定向策略、拒绝网络失败且取消后不再读取', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(response({bytes: [1]})).mockRejectedValueOnce(new TypeError('CORS denied'));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        await expect(fetchPageImageForOcr('https://cdn.example.com/page.png', controller.signal)).resolves.toBe('data:image/png;base64,AQ==');
        expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/page.png', expect.objectContaining({mode: 'cors', credentials: 'omit', redirect: 'follow', signal: expect.any(AbortSignal)}));
        await expect(fetchPageImageForOcr('https://cdn.example.com/denied.png')).rejects.toThrow('CORS denied');
        controller.abort();
        await expect(fetchPageImageForOcr('https://cdn.example.com/page.png', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('接受公网 HTTPS 图片域，拒绝非 HTTPS、凭据、端口和内网目标', () => {
        expect(normalizeRemoteImageUrl('https://pbs.twimg.com/media/demo.png?format=png'))
            .toBe('https://pbs.twimg.com/media/demo.png?format=png');
        expect(normalizeRemoteImageUrl('https://twimg.com/media/demo.png'))
            .toBe('https://twimg.com/media/demo.png');
        expect(normalizeRemoteImageUrl('https://pbs.twimg.com./media/demo.png'))
            .toBe('https://pbs.twimg.com./media/demo.png');

        for (const source of ['https://z-cdn-media.chatglm.cn/chart.png', 'https://images.unsplash.com/a', 'https://cdn.example.com/image?id=1']) {
            expect(normalizeRemoteImageUrl(source)).toBe(source);
        }
        expect(normalizeRemoteImageUrl('https://cdn.example.com/a.png#view')).toBe('https://cdn.example.com/a.png');
        for (const source of ['https://cdn.example.com:443/a.png']) expect(normalizeRemoteImageUrl(source)).toBe('https://cdn.example.com/a.png');

        for (const source of [
            '',
            'not a URL',
            'http://pbs.twimg.com/media/demo.png',
            'https://user:pass@pbs.twimg.com/media/demo.png',
            'https://pbs.twimg.com:8443/media/demo.png',
            'https://localhost/a.png', 'https://localhost./a.png', 'https://a.localhost/a.png',
            'https://machine/a.png', 'https://machine.local/a.png', 'https://machine.internal/a.png',
            'https://machine.home.arpa/a.png', 'https://example.test/a.png',
            'https://127.0.0.1/a.png', 'https://2130706433/a.png', 'https://0x7f000001/a.png',
            'https://10.0.0.1/a.png', 'https://192.168.0.1/a.png', 'https://169.254.169.254/a.png',
            'https://[::1]/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'file:///tmp/a.png',
            'data:image/png,abc', 'javascript:alert(1)',

        ]) {
            expect(() => normalizeRemoteImageUrl(source)).toThrow();
        }
    });

    it('规范化图片 MIME、编码字节，并拒绝非图片和超大 buffer', () => {
        expect(normalizeRemoteImageMimeType('IMAGE/PNG; charset=binary')).toBe('image/png');
        expect(imageBufferToDataUrl(new Uint8Array([0, 255]).buffer, 'image/png'))
            .toBe('data:image/png;base64,AP8=');
        expect(() => normalizeRemoteImageMimeType('text/html')).toThrow('远程地址不是图片');
        expect(() => imageBufferToDataUrl(new ArrayBuffer(MAX_REMOTE_IMAGE_BYTES + 1), 'image/png'))
            .toThrow('图片文件过大');
    });

    it('省略凭据、拒绝重定向并把无 body 响应转成 data URL', async () => {
        const request = vi.fn(async () => response({contentLength: null, bytes: [0, 255]}));
        await expect(fetchRemoteImageForOcr('https://pbs.twimg.com/media/demo.png', request))
            .resolves.toBe('data:image/png;base64,AP8=');
        expect(request).toHaveBeenCalledWith(
            'https://pbs.twimg.com/media/demo.png',
            {
                credentials: 'omit',
                redirect: 'error',
                signal: expect.any(AbortSignal),
            },
        );

        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/redirect.png',
            async () => { throw new TypeError('redirect mode is error'); },
        )).rejects.toThrow('redirect mode is error');
    });

    it('拒绝 HTTP、非 2xx、过大响应、非图片响应和不安全最终 URL，并释放响应体', async () => {
        const failedBodyCancel = vi.fn(async () => undefined);
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/failed.png',
            async () => response({ok: false, status: 403, body: {cancel: failedBodyCancel} as never}),
        )).rejects.toThrow('图片服务器返回 403');
        expect(failedBodyCancel).toHaveBeenCalledOnce();

        const largeBodyCancel = vi.fn(async () => undefined);
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/large.png',
            async () => response({contentLength: String(MAX_REMOTE_IMAGE_BYTES + 1), body: {cancel: largeBodyCancel} as never}),
        )).rejects.toThrow('图片文件过大');
        expect(largeBodyCancel).toHaveBeenCalledOnce();

        const mimeBodyCancel = vi.fn(async () => undefined);
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        const getReader = vi.fn();
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/html.png',
            async () => response({contentType: 'text/html', body: {getReader, cancel: mimeBodyCancel} as never, arrayBuffer}),
        )).rejects.toThrow('远程地址不是图片');
        expect(mimeBodyCancel).toHaveBeenCalledOnce();
        expect(getReader).not.toHaveBeenCalled();
        expect(arrayBuffer).not.toHaveBeenCalled();

        const missingMimeBodyCancel = vi.fn(async () => undefined);
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/missing-mime.png',
            async () => response({contentType: null, body: {cancel: missingMimeBodyCancel} as never}),
        )).rejects.toThrow('远程地址不是图片');
        expect(missingMimeBodyCancel).toHaveBeenCalledOnce();

        const redirectBodyCancel = vi.fn(async () => undefined);
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/redirect.png',
            async () => response({url: 'https://cdn.twimg.com/media/redirect.png', body: {cancel: redirectBodyCancel} as never}),
        )).rejects.toThrow('不允许重定向');
        expect(redirectBodyCancel).toHaveBeenCalledOnce();

        const unsafeBodyCancel = vi.fn(async () => undefined);
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/unsafe.png',
            async () => response({url: 'https://127.0.0.1/unsafe.png', body: {cancel: unsafeBodyCancel} as never}),
        )).rejects.toThrow('内网图片地址');
        expect(unsafeBodyCancel).toHaveBeenCalledOnce();
    });

    it('流式 body 忽略空块并按顺序合并字节，超限时取消 reader', async () => {
        const reader = {
            read: vi.fn()
                .mockResolvedValueOnce({done: false, value: new Uint8Array()})
                .mockResolvedValueOnce({done: false, value: new Uint8Array([0])})
                .mockResolvedValueOnce({done: false, value: new Uint8Array([255])})
                .mockResolvedValueOnce({done: true, value: undefined}),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
        };
        const body = {getReader: () => reader} as unknown as ReadableStream<Uint8Array>;
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/stream.png',
            async () => response({contentLength: null, body}),
        )).resolves.toBe('data:image/png;base64,AP8=');
        expect(reader.cancel).not.toHaveBeenCalled();
        expect(reader.releaseLock).toHaveBeenCalledOnce();

        const oversizedReader = {
            read: vi.fn().mockResolvedValueOnce({
                done: false,
                value: {byteLength: MAX_REMOTE_IMAGE_BYTES + 1} as Uint8Array,
            }),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(() => { throw new Error('pending read'); }),
        };
        const oversizedBody = {getReader: () => oversizedReader} as unknown as ReadableStream<Uint8Array>;
        const oversizedArrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/stream-large.png',
            async () => response({contentLength: null, body: oversizedBody, arrayBuffer: oversizedArrayBuffer}),
        )).rejects.toThrow('图片文件过大');
        expect(oversizedReader.cancel).toHaveBeenCalledOnce();
        expect(oversizedReader.releaseLock).toHaveBeenCalledOnce();
        expect(oversizedArrayBuffer).not.toHaveBeenCalled();
    });

    it('流式 reader 失败时取消 reader，并处理没有 releaseLock 的异常分支', async () => {
        const reader = {
            read: vi.fn(async () => { throw new Error('stream failed'); }),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(() => { throw new Error('release failed'); }),
        };
        const body = {getReader: () => reader} as unknown as ReadableStream<Uint8Array>;
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/stream-error.png',
            async () => response({contentLength: null, body}),
        )).rejects.toThrow('stream failed');
        expect(reader.cancel).toHaveBeenCalledOnce();
        expect(reader.releaseLock).toHaveBeenCalledOnce();
    });

    it('调用方预取消、取消中的 fetch 和内部 deadline 都会中止底层请求', async () => {
        const preCancelled = new AbortController();
        preCancelled.abort();
        const preRequest = vi.fn(async () => response());
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/pre-cancel.png', preRequest, preCancelled.signal,
        )).rejects.toMatchObject({name: 'AbortError'});
        expect(preRequest).not.toHaveBeenCalled();

        const caller = new AbortController();
        let callerSignal!: AbortSignal;
        let resolveCaller!: (value: RemoteImageResponse) => void;
        const lateCallerCancel = vi.fn(async () => undefined);
        const callerBody = {cancel: lateCallerCancel} as never;
        const callerRequest = vi.fn((_url: string, init: {signal: AbortSignal}) => {
            callerSignal = init.signal;
            return new Promise<RemoteImageResponse>(resolve => { resolveCaller = resolve; });
        });
        const callerPending = fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/caller-cancel.png', callerRequest, caller.signal,
        );
        caller.abort();
        await expect(callerPending).rejects.toMatchObject({name: 'AbortError'});
        expect(callerSignal.aborted).toBe(true);
        resolveCaller(response({body: callerBody}));
        await Promise.resolve();
        expect(lateCallerCancel).toHaveBeenCalledOnce();

        let notifyCallerAbort!: () => void;
        const repeatedCallerSignal = {
            aborted: false,
            addEventListener: vi.fn((_type: string, listener: EventListener) => {
                notifyCallerAbort = listener as unknown as () => void;
            }),
            removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        const repeatedCallerPending = fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/repeated-cancel.png',
            () => new Promise<RemoteImageResponse>(() => undefined),
            repeatedCallerSignal,
        );
        notifyCallerAbort();
        notifyCallerAbort();
        await expect(repeatedCallerPending).rejects.toMatchObject({name: 'AbortError'});

        vi.useFakeTimers();
        let timeoutSignal!: AbortSignal;
        let resolveTimeout!: (value: RemoteImageResponse) => void;
        const lateTimeoutCancel = vi.fn(async () => undefined);
        const timeoutRequest = vi.fn((_url: string, init: {signal: AbortSignal}) => {
            timeoutSignal = init.signal;
            return new Promise<RemoteImageResponse>(resolve => { resolveTimeout = resolve; });
        });
        const timeoutPending = fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/timeout.png', timeoutRequest,
        );
        const timeoutRejection = expect(timeoutPending).rejects.toThrow('图片读取超时');
        await vi.advanceTimersByTimeAsync(REMOTE_IMAGE_TIMEOUT_MS);
        await timeoutRejection;
        expect(timeoutSignal.aborted).toBe(true);
        resolveTimeout(response({body: {cancel: lateTimeoutCancel} as never}));
        await Promise.resolve();
        expect(lateTimeoutCancel).toHaveBeenCalledOnce();
    });

    it('响应体读取悬挂时也遵守 deadline，并覆盖同步 request 错误和大 buffer', async () => {
        vi.useFakeTimers();
        const reader = {
            read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
        };
        let signal!: AbortSignal;
        const body = {getReader: () => reader} as unknown as ReadableStream<Uint8Array>;
        const request = vi.fn(async (_url: string, init: {signal: AbortSignal}) => {
            signal = init.signal;
            return response({contentLength: null, body});
        });
        const pending = fetchRemoteImageForOcr('https://pbs.twimg.com/media/hanging.png', request);
        const rejection = expect(pending).rejects.toThrow('图片读取超时');
        await vi.advanceTimersByTimeAsync(REMOTE_IMAGE_TIMEOUT_MS);
        await rejection;
        expect(signal.aborted).toBe(true);
        expect(reader.cancel).toHaveBeenCalledOnce();

        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/request-error.png',
            () => { throw new Error('request failed'); },
        )).rejects.toThrow('request failed');
        await expect(fetchRemoteImageForOcr(
            'https://pbs.twimg.com/media/array-large.png',
            async () => response({contentLength: null, body: null, arrayBuffer: async () => new ArrayBuffer(MAX_REMOTE_IMAGE_BYTES + 1)}),
        )).rejects.toThrow('图片文件过大');
    });

    it('响应体最后清理时取消也不交付旧图片，非 Error 的流错误保留可读说明', async () => {
        const caller = new AbortController();
        const reader = {read: vi.fn(async () => ({done: true, value: undefined})), cancel: vi.fn(async () => {}), releaseLock: vi.fn(() => caller.abort())};
        await expect(fetchRemoteImageForOcr('https://cdn.example.com/cancel.png',
            async () => response({body: {getReader: () => reader} as never}), caller.signal)).rejects.toMatchObject({name: 'AbortError'});
        await expect(fetchRemoteImageForOcr('https://cdn.example.com/broken.png',
            async () => response({body: null, arrayBuffer: async () => {throw 'stream unavailable';}}))).rejects.toThrow('图片数据读取失败');
    });

    it('Offscreen 网络端口委托真实 fetch，并保留 signal', async () => {
        const fetchMock = vi.fn(async () => response({contentLength: null, bytes: [1]}));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        await expect(fetchImageInOffscreen('https://pbs.twimg.com/media/wrapper.png', controller.signal))
            .resolves.toBe('data:image/png;base64,AQ==');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://pbs.twimg.com/media/wrapper.png',
            expect.objectContaining({credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal)}),
        );
    });
});
