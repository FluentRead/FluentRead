import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    abortErrorFromSignal,
    createRuntimeAbortContext,
    cancelResponseReader, cancelUnreadResponseBody,
    runtimeFetch,
    setRuntimeFetch,
} from '@/src/platform/http/runtime';

describe('runtime HTTP transport', () => {
    afterEach(() => {
        setRuntimeFetch();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses an installed fetch-compatible transport', async () => {
        const response = new Response('{"ok":true}', {
            status: 201,
            headers: {'content-type': 'application/json'},
        });
        const transport = vi.fn(async () => response);
        setRuntimeFetch(transport);

        const result = await runtimeFetch('https://example.com/translate', {
            method: 'POST',
            body: 'hello',
        });

        expect(transport).toHaveBeenCalledWith('https://example.com/translate', {
            method: 'POST',
            body: 'hello',
        });
        expect(result.status).toBe(201);
        expect(await result.json()).toEqual({ok: true});
    });

    it('passes an explicit local error-body policy only to the installed transport', async () => {
        const transport = vi.fn(async () => new Response('ok'));
        setRuntimeFetch(transport);
        const policy = {errorBodyLimit: {maxBytes: 32, replacement: 'bounded'}};
        await runtimeFetch('https://example.com/translate', {method: 'POST'}, policy);
        expect(transport).toHaveBeenCalledWith('https://example.com/translate', {method: 'POST'}, policy);
        const native = vi.fn(async () => new Response('native'));
        vi.spyOn(globalThis, 'fetch').mockImplementation(native);
        setRuntimeFetch();
        await runtimeFetch('https://example.com/translate', {method: 'POST'}, policy);
        expect(native).toHaveBeenCalledWith('https://example.com/translate', {method: 'POST'});
    });

    it('reset 后恢复调用运行环境的原生 fetch', async () => {
        const originalFetch = globalThis.fetch;
        const nativeFetch = vi.fn(async () => new Response('native'));
        globalThis.fetch = nativeFetch;
        setRuntimeFetch();

        try {
            const response = await runtimeFetch(new URL('https://example.com/native'));
            expect(await response.text()).toBe('native');
            expect(nativeFetch).toHaveBeenCalledOnce();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('局部 timeout 到期后中止合并 signal，并标记为超时来源', async () => {
        vi.useFakeTimers();
        const context = createRuntimeAbortContext(500);
        expect(context.signal.aborted).toBe(false);
        expect(context.didTimeout()).toBe(false);

        await vi.advanceTimersByTimeAsync(500);
        expect(context.signal.aborted).toBe(true);
        expect(context.didTimeout()).toBe(true);
        context.cleanup();
        vi.useRealTimers();
    });

    it('透传调用方的 Error 取消原因，cleanup 后移除监听', () => {
        const caller = new AbortController();
        const context = createRuntimeAbortContext(1_000, caller.signal);
        const reason = new Error('caller deadline');
        caller.abort(reason);

        expect(context.signal.aborted).toBe(true);
        expect(context.didTimeout()).toBe(false);
        expect(abortErrorFromSignal(context.signal)).toBe(reason);
        context.cleanup();

        const detachedCaller = new AbortController();
        const detached = createRuntimeAbortContext(1_000, detachedCaller.signal);
        detached.cleanup();
        detachedCaller.abort(new Error('too late'));
        expect(detached.signal.aborted).toBe(false);
    });

    it('调用前已取消且原因非 Error 时统一生成标准 AbortError', () => {
        const caller = new AbortController();
        caller.abort('stop');
        const context = createRuntimeAbortContext(1_000, caller.signal);

        expect(context.signal.aborted).toBe(true);
        expect(abortErrorFromSignal(context.signal)).toMatchObject({name: 'AbortError'});
        context.cleanup();
    });

    it('调用方先取消时，即使 transport 迟迟未结束也不会改判为局部超时', async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const context = createRuntimeAbortContext(500, caller.signal);
        const reason = new DOMException('user cancelled', 'AbortError');

        caller.abort(reason);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(context.signal.reason).toBe(reason);
        expect(context.didTimeout()).toBe(false);
        context.cleanup();
    });

    it('已取消的调用不再建立 timeout，局部超时也立即释放调用方监听', async () => {
        vi.useFakeTimers();
        const aborted = new AbortController();
        aborted.abort();
        const cancelled = createRuntimeAbortContext(500, aborted.signal);
        expect(vi.getTimerCount()).toBe(0);
        cancelled.cleanup();

        const caller = new AbortController();
        const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
        const context = createRuntimeAbortContext(500, caller.signal);
        await vi.advanceTimersByTimeAsync(500);
        expect(context.didTimeout()).toBe(true);
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        caller.abort(new Error('late caller cancellation'));
        expect(context.didTimeout()).toBe(true);
        context.cleanup();
    });
});


describe('unused HTTP response disposal', () => {
    it('cancels the original unread body without tee clones or waiting for its handshake', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const response = new Response(new ReadableStream({cancel}));
        const clone = vi.spyOn(response, 'clone');
        expect(cancelUnreadResponseBody(response)).toBeUndefined();
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.bodyUsed).toBe(true);
        expect(clone).not.toHaveBeenCalled();
    });

    it('keeps consumed responses and tolerates missing bodies, throws and rejected cleanup', async () => {
        const consumed = new Response('completed');
        await consumed.text();
        const cancel = vi.spyOn(consumed.body!, 'cancel');
        cancelUnreadResponseBody(consumed);
        expect(cancel).not.toHaveBeenCalled();
        cancelUnreadResponseBody(new Response(null, {status: 204}));
        cancelUnreadResponseBody({});
        for (const cancel of [() => {throw new Error('sync cleanup');}, () => Promise.reject(new Error('async cleanup'))]) {
            const body = new ReadableStream();
            vi.spyOn(body, 'cancel').mockImplementation(cancel);
            expect(() => cancelUnreadResponseBody({body})).not.toThrow();
        }
        await Promise.resolve();
    });
});

describe('abandoned HTTP reader disposal', () => {
    it('releases a locked stream without waiting for cancellation', () => {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const body = new ReadableStream({cancel});
        expect(cancelResponseReader(body.getReader())).toBeUndefined();
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });

    it('preserves the caller error and releases the lock for throwing or rejected cancellation', async () => {
        for (const cancel of [() => {throw new Error('sync cleanup');}, () => Promise.reject(new Error('async cleanup'))]) {
            const body = new ReadableStream();
            const reader = body.getReader();
            vi.spyOn(reader, 'cancel').mockImplementation(cancel);
            expect(() => cancelResponseReader(reader)).not.toThrow();
            expect(body.locked).toBe(false);
        }
        const reader = new ReadableStream().getReader();
        vi.spyOn(reader, 'releaseLock').mockImplementation(() => {throw new Error('lock cleanup');});
        expect(() => cancelResponseReader(reader)).not.toThrow();
        await Promise.resolve();
    });
});
