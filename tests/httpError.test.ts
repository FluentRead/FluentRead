import {describe, expect, it, vi} from 'vitest';

import {
    createHttpStatusError,
    createProviderCodeError,
    getSafeProviderErrorCode,
    readJsonResponse,
} from '@/src/platform/http/errors';

describe('safe provider error formatting', () => {
    it('surfaces only the numeric HTTP status and ignores a third-party statusText', () => {
        const error = createHttpStatusError({
            status: 403,
            statusText: 'SENSITIVE_STATUS_SENTINEL',
        }, '翻译失败');

        expect(error.message).toBe('翻译失败: 403');
        expect(error).toMatchObject({statusCode: 403});
        expect(error.message).not.toContain('SENSITIVE_STATUS_SENTINEL');
        expect(createHttpStatusError({status: 500, statusText: ''}).message).toBe('请求失败: 500');
    });

    it('allows bounded numeric provider codes', () => {
        expect(getSafeProviderErrorCode(2049)).toBe('2049');
        expect(getSafeProviderErrorCode('401')).toBe('401');
        expect(createProviderCodeError('服务返回错误', '2049').message)
            .toBe('服务返回错误（错误码 2049）');
    });

    it('rejects arbitrary strings and oversized numeric fields', () => {
        expect(getSafeProviderErrorCode(null)).toBeUndefined();
        expect(getSafeProviderErrorCode('   ')).toBeUndefined();
        expect(getSafeProviderErrorCode('AuthFailure.SENSITIVE_SENTINEL')).toBeUndefined();
        expect(getSafeProviderErrorCode('12abc')).toBeUndefined();
        expect(getSafeProviderErrorCode('1'.repeat(17))).toBeUndefined();
        expect(createProviderCodeError('服务返回错误', 'SENSITIVE_SENTINEL').message)
            .toBe('服务返回错误');
    });

    it('returns valid JSON without changing the parsed value', async () => {
        const payload = {choices: [{message: {content: '译文'}}]};
        const response = {json: vi.fn().mockResolvedValue(payload)};

        await expect(readJsonResponse(response)).resolves.toBe(payload);
        expect(response.json).toHaveBeenCalledOnce();
    });

    it('only a confirmed signal may replace a private JSON read error with its cancellation reason', async () => {
        const response = {json: vi.fn().mockRejectedValue(new DOMException('private-body', 'AbortError'))};
        const owner = new AbortController();
        const failure = await readJsonResponse(response, '安全错误', owner.signal).catch(error => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('安全错误');
        const reason = new Error('caller reason');
        owner.abort(reason);
        await expect(readJsonResponse(response, '安全错误', owner.signal)).rejects.toBe(reason);
        const second = new AbortController(); second.abort('non-error reason');
        await expect(readJsonResponse(response, '安全错误', second.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('does not reflect malformed third-party JSON in parser errors', async () => {
        const response = {
            json: vi.fn().mockRejectedValue(
                new SyntaxError('Unexpected token S in SENSITIVE_RESPONSE_SENTINEL'),
            ),
        };

        const error = await readJsonResponse(response).catch(cause => cause);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('返回的不是有效 JSON');
        expect((error as Error).message).not.toContain('SENSITIVE_RESPONSE_SENTINEL');
    });
});

it('preserves bounded Retry-After durations without reflecting raw headers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 12));
    try {
        for (const [header, expected] of [
            ['120', 120000], ['0.5', 500], [' 60 ', 60000], ['999999999999', 604800000],
            ['Sat, 12 Sep 2026 00:02:00 GMT', 120000],
            [null, undefined], ['', undefined], ['  ', undefined], ['0', undefined], ['-2', undefined],
            ['private-original-secret', undefined], ['1e1000', undefined],
            ['Thu, 01 Jan 1970 00:00:00 GMT', undefined],
        ] as const) {
            const error = createHttpStatusError({status: 429, statusText: 'secret', headers: {get: () => header}});
            expect((error as Error & {retryAfterMs?: number}).retryAfterMs).toBe(expected);
            expect(error.message).toBe('请求失败: 429');
        }
    } finally { vi.restoreAllMocks(); }
});

it('图片输入错误正文过大时限量分类，不等待第三方响应完成', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(stream) {controller = stream; stream.enqueue(new Uint8Array(128 * 1024));}});
    const response = new Response(body, {status: 400});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const {createImageInputHttpError} = await import('@/src/platform/http/errors');
        const outcome = await Promise.race([
            createImageInputHttpError(response),
            new Promise<'unsettled'>(resolve => {timer = setTimeout(() => resolve('unsettled'), 300);}),
        ]);
        expect(outcome).toMatchObject({statusCode: 400});
    } finally {clearTimeout(timer); controller.close();}
});

it.each([400, 422])('图片不支持的短错误 %s 仍能识别，原始正文可供 SDK 读取', async status => {
    const {createImageInputHttpError} = await import('@/src/platform/http/errors');
    const text = JSON.stringify({error: {message: 'image_url is not supported by this model'}});
    const response = new Response(text, {status});
    const error = await createImageInputHttpError(response, '请求失败');
    expect(error).toMatchObject({statusCode: status, imageInputUnsupported: true});
    expect(response.bodyUsed).toBe(false); expect(await response.text()).toBe(text);
});

it('超限内容不猜测能力，原始正文仍可读取且不会泄露到错误中', async () => {
    const {createImageInputHttpError} = await import('@/src/platform/http/errors');
    const text = JSON.stringify({padding: 'SENSITIVE_SENTINEL'.repeat(2500), message: 'image_url is not supported by this model'});
    const response = new Response(text, {status: 400});
    const error = await createImageInputHttpError(response);
    expect(error).toMatchObject({statusCode: 400}); expect(error).not.toHaveProperty('imageInputUnsupported');
    expect(error.message).not.toContain('SENSITIVE_SENTINEL'); expect(await response.text()).toBe(text);
});

it('错误正文停滞时一秒内按 HTTP 状态返回，非阻塞取消读锁且消费迟到拒绝', async () => {
    vi.useFakeTimers();
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {rejectRead = reject;}));
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed')); const releaseLock = vi.fn();
    const response = {status: 400, statusText: '', clone: () => ({body: {getReader: () => ({read, cancel, releaseLock})}})} as unknown as Response;
    try {
        const {createImageInputHttpError} = await import('@/src/platform/http/errors');
        const outcome = createImageInputHttpError(response);
        await vi.advanceTimersByTimeAsync(999); expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); expect(await outcome).toMatchObject({statusCode: 400});
        expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
        rejectRead(new Error('late rejection')); await Promise.resolve(); await Promise.resolve();
    } finally {vi.useRealTimers();}
});

it('无正文、无关状态、克隆失败和无效 JSON 均只保留安全状态', async () => {
    const {createImageInputHttpError} = await import('@/src/platform/http/errors');
    const clone = vi.fn(() => {throw new Error('secret');});
    for (const response of [new Response(null, {status: 400}), new Response('{PRIVATE_BROKEN', {status: 400}),
        {status: 400, statusText: '', clone}, {status: 403, statusText: '', clone}] as Response[]) {
        const error = await createImageInputHttpError(response); expect(error).not.toHaveProperty('imageInputUnsupported');
        expect(error.message).not.toMatch(/PRIVATE|secret/);
    }
    expect(clone).toHaveBeenCalledOnce();
});

it.each([32_768, 32_769])('多块正文 %s 字节严格按阈值分类，不消耗原流', async length => {
    const {createImageInputHttpError} = await import('@/src/platform/http/errors');
    const prefix = '{"message":"image_url is not supported by this model","padding":"';
    const suffix = '"}';
    const text = prefix + 'a'.repeat(length - prefix.length - suffix.length) + suffix;
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({start(stream) {
        stream.enqueue(bytes.subarray(0, 13_000)); stream.enqueue(bytes.subarray(13_000)); stream.close();
    }});
    const response = new Response(body, {status: 400}); const error = await createImageInputHttpError(response);
    expect(Boolean((error as Error & {imageInputUnsupported?: boolean}).imageInputUnsupported)).toBe(length === 32_768);
    expect(await response.text()).toBe(text);
});

it('第三方读取失败与同步取消异常不会覆盖状态，始终尝试释放锁', async () => {
    const {createImageInputHttpError} = await import('@/src/platform/http/errors');
    const releaseLock = vi.fn(() => {throw new Error('release failed');});
    const cancel = vi.fn(() => {throw new Error('cancel failed');});
    const response = {status: 400, statusText: '', clone: () => ({body: {getReader: () => ({
        read: () => Promise.reject(new Error('private response')), cancel, releaseLock,
    })}})} as unknown as Response;
    const error = await createImageInputHttpError(response);
    expect(error.message).toBe('请求失败: 400'); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
