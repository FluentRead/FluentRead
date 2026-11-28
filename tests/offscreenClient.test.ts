import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    chromeOffscreenClient,
    createOffscreenClient,
    OFFSCREEN_READY_MESSAGE_TYPE,
    type OffscreenDocumentApi,
    type OffscreenRuntimeApi,
} from '@/src/platform/offscreen/client';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

function createRuntime(options: {
    contexts?: unknown[];
    response?: unknown;
    runtimeError?: {message?: string};
} = {}) {
    let runtimeError = options.runtimeError;
    const getContexts = vi.fn(async () => options.contexts ?? []);
    const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
        callback((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE
            ? {success: true, ready: true}
            : options.response);
    });
    const runtime: OffscreenRuntimeApi = {
        get lastError() {
            return runtimeError;
        },
        getContexts,
        sendMessage,
    };
    return {
        getContexts,
        runtime,
        sendMessage,
        setRuntimeError(error: {message?: string} | undefined) {
            runtimeError = error;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Offscreen platform client', () => {
    it('does not restart shared forced recovery for another caller that was also cancelled', async () => {
        vi.useFakeTimers();
        const firstController = new AbortController();
        const secondController = new AbortController();
        const query = deferred<unknown[]>();
        const callbacks = new Map<string, (response: unknown) => void>();
        let queries = 0;
        let runtimeError: {message: string} | undefined;
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const runtime: OffscreenRuntimeApi = {
            getContexts: async () => ++queries === 2 ? query.promise : [{}],
            get lastError() {return runtimeError;},
            sendMessage(message, callback) {
                const type = (message as {type: string}).type;
                if (type === OFFSCREEN_READY_MESSAGE_TYPE) callback({success: true, ready: true});
                else callbacks.set(type, callback);
            },
        };
        const client = createOffscreenClient({getRuntime: () => runtime,
            getOffscreen: () => ({closeDocument, createDocument})});
        const first = client.send({type: 'FIRST'}, {signal: firstController.signal}).catch(error => error);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        const second = client.send({type: 'SECOND'}, {signal: secondController.signal}).catch(error => error);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(callbacks.size).toBe(2);
        for (const type of ['FIRST', 'SECOND']) {
            runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
            callbacks.get(type)!(undefined);
            runtimeError = undefined;
            for (let i = 0; i < 96; i++) await Promise.resolve();
        }
        expect(queries).toBe(2);
        secondController.abort();
        firstController.abort();
        expect(await first).toMatchObject({name: 'AbortError'});
        expect(await second).toMatchObject({name: 'AbortError'});
        query.resolve([{}]);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(queries).toBe(2);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])('does not retry a shared native AbortError without owner cancellation, forced=%s', async forced => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const query = deferred<unknown[]>();
        let queries = 0;
        let runtimeError: {message: string} | undefined;
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const runtime: OffscreenRuntimeApi = {
            getContexts: async () => ++queries === (forced ? 2 : 1) ? query.promise : [{}],
            get lastError() {return runtimeError;},
            sendMessage(message, callback) {
                if ((message as {type: string}).type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                    return;
                }
                runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
                runtimeError = undefined;
            },
        };
        const client = createOffscreenClient({getRuntime: () => runtime,
            getOffscreen: () => ({closeDocument, createDocument})});
        const first = client.send({type: 'MISSING'}, {signal: controller.signal}).catch(error => error);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        const second = client.ensureDocument().catch(error => error);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        const nativeError = new Error('Native document operation aborted');
        nativeError.name = 'AbortError';
        query.reject(nativeError);
        expect(await first).toBe(nativeError);
        expect(await second).toBe(nativeError);
        expect(controller.signal.aborted).toBe(false);
        expect(queries).toBe(forced ? 2 : 1);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start a queued forced rebuild after its caller cancels behind a live ordinary probe', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const ordinaryQuery = deferred<unknown[]>();
        let queries = 0;
        let runtimeError: {message: string} | undefined;
        let missingCallback: ((response: unknown) => void) | undefined;
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const runtime: OffscreenRuntimeApi = {
            getContexts: async () => ++queries === 2 ? ordinaryQuery.promise : [{}],
            get lastError() {return runtimeError;},
            sendMessage(message, callback) {
                if ((message as {type: string}).type === OFFSCREEN_READY_MESSAGE_TYPE) callback({success: true, ready: true});
                else missingCallback = callback;
            },
        };
        const client = createOffscreenClient({getRuntime: () => runtime,
            getOffscreen: () => ({closeDocument, createDocument})});
        const old = client.send({type: 'MISSING'}, {signal: controller.signal}).catch(error => error);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(missingCallback).toBeTypeOf('function');
        const current = client.ensureDocument();
        for (let i = 0; i < 96; i++) await Promise.resolve();
        runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
        missingCallback!(undefined);
        runtimeError = undefined;
        for (let i = 0; i < 96; i++) await Promise.resolve();
        controller.abort();
        expect(await old).toMatchObject({name: 'AbortError'});
        ordinaryQuery.resolve([{}]);
        await expect(current).resolves.toBeUndefined();
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(queries).toBe(2);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a live caller usable when the request owning its shared forced preparation is cancelled', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const query = deferred<unknown[]>();
        let queries = 0;
        let runtimeError: {message: string} | undefined;
        const attempts: string[] = [];
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const runtime: OffscreenRuntimeApi = {
            getContexts: async () => ++queries === 2 ? query.promise : [{}],
            get lastError() {return runtimeError;},
            sendMessage(message, callback) {
                const type = (message as {type: string}).type;
                if (type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                    return;
                }
                attempts.push(type);
                if (type === 'CANCELLED_OWNER') {
                    runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true});
            },
        };
        const client = createOffscreenClient({getRuntime: () => runtime,
            getOffscreen: () => ({closeDocument, createDocument})});
        const old = client.send({type: 'CANCELLED_OWNER'}, {signal: controller.signal})
            .then(response => ({response}), error => ({error}));
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(queries).toBe(2);
        const current = client.send({type: 'LIVE_CALLER'})
            .then(response => ({response}), error => ({error}));
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(queries).toBe(2);
        controller.abort();
        const oldResult = await old;
        const currentResult = await current;
        query.resolve([{}]);
        for (let i = 0; i < 96; i++) await Promise.resolve();
        expect(oldResult).toMatchObject({error: {name: 'AbortError'}});
        expect(currentResult).toEqual({response: {success: true}});
        expect(attempts).toEqual(['CANCELLED_OWNER', 'LIVE_CALLER']);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports document presence without creating it', async () => {
        const missingOffscreen = createRuntime({contexts: [{}]});
        const missingClient = createOffscreenClient({
            getRuntime: () => missingOffscreen.runtime,
            getOffscreen: () => undefined,
        });
        await expect(missingClient.hasDocument()).resolves.toBe(false);
        expect(missingOffscreen.getContexts).not.toHaveBeenCalled();

        const missingGetContextsRuntime: OffscreenRuntimeApi = {
            sendMessage: vi.fn(),
        };
        const missingGetContextsClient = createOffscreenClient({
            getRuntime: () => missingGetContextsRuntime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        await expect(missingGetContextsClient.hasDocument()).resolves.toBe(false);

        const absent = createRuntime();
        const absentClient = createOffscreenClient({
            getRuntime: () => absent.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        await expect(absentClient.hasDocument()).resolves.toBe(false);
        expect(absent.getContexts).toHaveBeenCalledWith({contextTypes: ['OFFSCREEN_DOCUMENT']});

        const present = createRuntime({contexts: [{contextType: 'OFFSCREEN_DOCUMENT'}]});
        const presentClient = createOffscreenClient({
            getRuntime: () => present.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        await expect(presentClient.hasDocument()).resolves.toBe(true);
    });

    it('rejects unsupported creation APIs and wraps context lookup failures', async () => {
        const runtime = createRuntime();
        await expect(createOffscreenClient({
            getRuntime: () => runtime.runtime,
            getOffscreen: () => undefined,
        }).ensureDocument()).rejects.toThrow('当前浏览器不支持扩展 Offscreen 文档');

        await expect(createOffscreenClient({
            getRuntime: () => runtime.runtime,
            getOffscreen: () => ({}) as OffscreenDocumentApi,
        }).ensureDocument()).rejects.toThrow('当前浏览器不支持扩展 Offscreen 文档');

        const noLookupRuntime: OffscreenRuntimeApi = {sendMessage: vi.fn()};
        await expect(createOffscreenClient({
            getRuntime: () => noLookupRuntime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        }).ensureDocument()).rejects.toThrow('无法创建 Offscreen 文档：当前浏览器不支持查询 Offscreen 文档');

        const stringFailure = createRuntime();
        stringFailure.getContexts.mockRejectedValueOnce('lookup failed');
        await expect(createOffscreenClient({
            getRuntime: () => stringFailure.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        }).ensureDocument()).rejects.toThrow('无法创建 Offscreen 文档：lookup failed');
    });

    it('reuses an existing document and deduplicates concurrent creation', async () => {
        const existing = createRuntime({contexts: [{}]});
        const existingCreate = vi.fn(async () => undefined);
        await expect(createOffscreenClient({
            getRuntime: () => existing.runtime,
            getOffscreen: () => ({createDocument: existingCreate}),
        }).ensureDocument()).resolves.toBeUndefined();
        expect(existingCreate).not.toHaveBeenCalled();

        const contextLookup = deferred<unknown[]>();
        const creation = deferred<void>();
        const concurrentRuntime = createRuntime();
        concurrentRuntime.getContexts
            .mockImplementationOnce(() => contextLookup.promise);
        const createDocument = vi.fn(() => creation.promise);
        const client = createOffscreenClient({
            getRuntime: () => concurrentRuntime.runtime,
            getOffscreen: () => ({createDocument}),
            documentUrl: 'pages/offscreen.html',
        });

        const first = client.ensureDocument();
        const second = client.ensureDocument();
        contextLookup.resolve([]);
        await vi.waitFor(() => expect(createDocument).toHaveBeenCalledOnce());
        expect(concurrentRuntime.getContexts).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledWith({
            url: 'pages/offscreen.html',
            reasons: ['DOM_SCRAPING', 'AUDIO_PLAYBACK', 'WORKERS'],
            justification: 'FluentRead needs an extension-owned DOM for Translation API, OCR, local video transcription workers, and CSP-independent TTS playback',
        });
        creation.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    });

    it('requires a ready receiver and rebuilds a context that has no message listener once', async () => {
        let runtimeError: {message?: string} | undefined;
        let readyAttempts = 0;
        const getContexts = vi.fn(async () => [{}]);
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                readyAttempts += 1;
                if (readyAttempts === 1) {
                    runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true, ready: true});
                return;
            }
            callback({success: true, value: 7});
        });
        const runtime: OffscreenRuntimeApi = {
            get lastError() {
                return runtimeError;
            },
            getContexts,
            sendMessage,
        };
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
            readyRetryDelay: vi.fn(async () => undefined),
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 7});
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
        expect(readyAttempts).toBe(2);
        expect(sendMessage).toHaveBeenLastCalledWith(
            {type: 'PING', target: 'offscreen'},
            expect.any(Function),
        );
    });

    it('waits through a non-ready handshake before accepting the receiver', async () => {
        let readyAttempts = 0;
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    readyAttempts += 1;
                    callback(readyAttempts === 1
                        ? {success: true, ready: false}
                        : {success: true, ready: true});
                    return;
                }
                callback({success: true});
            }),
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });

        await expect(client.ensureDocument()).resolves.toBeUndefined();
        expect(readyAttempts).toBe(2);
    });

    it('reports a failed receiver rebuild and preserves a non-receiver business error', async () => {
        let missingRuntimeError: {message?: string} | undefined;
        const missingRuntime: OffscreenRuntimeApi = {
            get lastError() {
                return missingRuntimeError;
            },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
                missingRuntimeError = {message: 'Could not establish connection.'};
                callback(undefined);
                missingRuntimeError = undefined;
            }),
        };
        const missingClient = createOffscreenClient({
            getRuntime: () => missingRuntime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
            readyRetryAttempts: 1,
        });
        await expect(missingClient.ensureDocument())
            .rejects.toThrow('无法创建 Offscreen 文档：当前浏览器无法重建失去接收端的 Offscreen 文档');

        let businessRuntimeError: {message?: string} | undefined;
        const businessRuntime: OffscreenRuntimeApi = {
            get lastError() {
                return businessRuntimeError;
            },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                    return;
                }
                businessRuntimeError = {message: 'port closed'};
                callback(undefined);
                businessRuntimeError = undefined;
            }),
        };
        const businessClient = createOffscreenClient({
            getRuntime: () => businessRuntime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        await expect(businessClient.send({type: 'PING'})).rejects.toThrow('port closed');
    });

    it('rebuilds and retries one business message when the ready receiver disappears', async () => {
        let runtimeError: {message?: string} | undefined;
        let businessAttempts = 0;
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                callback({success: true, ready: true});
                return;
            }
            businessAttempts += 1;
            if (businessAttempts === 1) {
                runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
                runtimeError = undefined;
                return;
            }
            callback({success: true, value: 9});
        });
        const runtime: OffscreenRuntimeApi = {
            get lastError() {
                return runtimeError;
            },
            getContexts: vi.fn(async () => [{}]),
            sendMessage,
        };
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 9});
        expect(businessAttempts).toBe(2);
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('does not let an in-flight ordinary probe consume a forced rebuild', async () => {
        let runtimeError: {message?: string} | undefined;
        let readyAttempts = 0;
        let businessAttempts = 0;
        let concurrentEnsure: Promise<void> | undefined;
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        let client: ReturnType<typeof createOffscreenClient>;
        const runtime: OffscreenRuntimeApi = {
            get lastError() {
                return runtimeError;
            },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    readyAttempts += 1;
                    if (readyAttempts === 2) {
                        runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                        callback(undefined);
                        runtimeError = undefined;
                        return;
                    }
                    callback({success: true, ready: true});
                    return;
                }

                businessAttempts += 1;
                if (businessAttempts === 1) concurrentEnsure = client.ensureDocument();
                if (closeDocument.mock.calls.length === 0) {
                    runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true, value: 11});
            }),
        };
        client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 11});
        await expect(concurrentEnsure).resolves.toBeUndefined();
        expect(readyAttempts).toBe(3);
        expect(businessAttempts).toBe(2);
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('still forces a rebuild after an in-flight ordinary probe succeeds', async () => {
        let runtimeError: {message?: string} | undefined;
        let readyAttempts = 0;
        let businessAttempts = 0;
        let concurrentEnsure: Promise<void> | undefined;
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        let client: ReturnType<typeof createOffscreenClient>;
        const runtime: OffscreenRuntimeApi = {
            get lastError() {
                return runtimeError;
            },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    readyAttempts += 1;
                    callback({success: true, ready: true});
                    return;
                }

                businessAttempts += 1;
                if (businessAttempts === 1) concurrentEnsure = client.ensureDocument();
                if (closeDocument.mock.calls.length === 0) {
                    runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true, value: 13});
            }),
        };
        client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 13});
        await expect(concurrentEnsure).resolves.toBeUndefined();
        expect(readyAttempts).toBe(3);
        expect(businessAttempts).toBe(2);
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('reuses a fresh document created by an in-flight ordinary probe', async () => {
        let runtimeError: {message?: string} | undefined;
        let readyAttempts = 0;
        let businessAttempts = 0;
        let concurrentEnsure: Promise<void> | undefined;
        const getContexts = vi.fn()
            .mockResolvedValueOnce([{}])
            .mockResolvedValueOnce([]);
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        let client: ReturnType<typeof createOffscreenClient>;
        const runtime: OffscreenRuntimeApi = {
            get lastError() {
                return runtimeError;
            },
            getContexts,
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    readyAttempts += 1;
                    callback({success: true, ready: true});
                    return;
                }

                businessAttempts += 1;
                if (businessAttempts === 1) concurrentEnsure = client.ensureDocument();
                if (createDocument.mock.calls.length === 0) {
                    runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true, value: 17});
            }),
        };
        client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 17});
        await expect(concurrentEnsure).resolves.toBeUndefined();
        expect(getContexts).toHaveBeenCalledTimes(2);
        expect(readyAttempts).toBe(2);
        expect(businessAttempts).toBe(2);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('clears a failed creation promise so a later default-url attempt can retry', async () => {
        const runtime = createRuntime();
        const createDocument = vi.fn()
            .mockRejectedValueOnce(new Error('creation denied'))
            .mockResolvedValueOnce(undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime.runtime,
            getOffscreen: () => ({createDocument}),
            documentUrl: '',
        });

        await expect(client.ensureDocument()).rejects.toThrow('无法创建 Offscreen 文档：creation denied');
        await expect(client.ensureDocument()).resolves.toBeUndefined();
        expect(createDocument).toHaveBeenCalledTimes(2);
        expect(createDocument).toHaveBeenLastCalledWith(expect.objectContaining({url: 'offscreen.html'}));
    });

    it('sends a targeted message after ensuring a document and surfaces runtime callback errors', async () => {
        const runtime = createRuntime({contexts: [{}], response: {success: true, value: 1}});
        const client = createOffscreenClient({
            getRuntime: () => runtime.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });

        await expect(client.send<{success: boolean; value: number}>({type: 'PING'}))
            .resolves.toEqual({success: true, value: 1});
        expect(runtime.sendMessage).toHaveBeenCalledWith(
            {type: 'PING', target: 'offscreen'},
            expect.any(Function),
        );

        runtime.setRuntimeError({message: 'port closed'});
        await expect(client.send({type: 'PING'})).rejects.toThrow('port closed');
        await expect(client.ensureDocument()).rejects.toThrow('无法创建 Offscreen 文档：port closed');
        runtime.setRuntimeError({});
        await expect(client.send({type: 'PING'})).rejects.toThrow('Offscreen 消息发送失败');
    });

    it('AbortSignal 会立即拒绝悬挂 callback、发送一次纯数据取消消息并忽略迟到响应', async () => {
        let businessCallback: ((response: unknown) => void) | undefined;
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            const type = (message as {type?: unknown}).type;
            if (type === OFFSCREEN_READY_MESSAGE_TYPE) callback({success: true, ready: true});
            else if (type === 'PING') businessCallback = callback;
            else callback({success: true});
        });
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage,
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        const controller = new AbortController();
        const pending = client.send({type: 'PING', requestId: 'request-1'}, {
            signal: controller.signal,
            timeoutMs: 5_000,
            cancelMessage: {type: 'CANCEL', requestId: 'request-1'},
        });
        await vi.waitFor(() => expect(businessCallback).toBeTypeOf('function'));

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenCalledWith(
            {type: 'CANCEL', requestId: 'request-1', target: 'offscreen'},
            expect.any(Function),
        );
        businessCallback?.({success: true, value: '迟到'});
        await Promise.resolve();
        expect(sendMessage.mock.calls.filter(([message]) =>
            (message as {type?: unknown}).type === 'CANCEL')).toHaveLength(1);
    });

    it('已取消请求不会启动 prepare，但仍尽力发送取消协议', async () => {
        const runtime = createRuntime({contexts: [{}]});
        const client = createOffscreenClient({
            getRuntime: () => runtime.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        const controller = new AbortController();
        controller.abort();

        await expect(client.send({type: 'PING'}, {
            signal: controller.signal,
            cancelMessage: {type: 'CANCEL', requestId: 'pre-aborted'},
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(runtime.getContexts).not.toHaveBeenCalled();
        expect(runtime.sendMessage).toHaveBeenCalledWith(
            {type: 'CANCEL', requestId: 'pre-aborted', target: 'offscreen'},
            expect.any(Function),
        );
    });

    it('显式绝对预算会截止消息，未传 options 的兼容调用保持原有无业务 deadline 语义', async () => {
        vi.useFakeTimers();
        let longCallback: ((response: unknown) => void) | undefined;
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown}).type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                } else if ((message as {type?: unknown}).type === 'LONG_OCR') {
                    longCallback = callback;
                }
            }),
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });

        const explicit = client.send({type: 'PING'}, {timeoutMs: 25})
            .then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(25);
        await expect(explicit).resolves.toMatchObject({message: 'Offscreen 消息响应超时'});

        const compatible = client.send({type: 'LONG_OCR'});
        let settled = false;
        void compatible.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(settled).toBe(false);
        longCallback?.({success: true, value: '完成'});
        await expect(compatible).resolves.toEqual({success: true, value: '完成'});
    });

    it('既有十分钟预算保持原边界，过大显式预算在十分钟加三十秒处截止', async () => {
        vi.useFakeTimers();
        let callback: ((response: unknown) => void) | undefined;
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, respond: (response: unknown) => void) => {
                if ((message as {type: string}).type === OFFSCREEN_READY_MESSAGE_TYPE) respond({success: true, ready: true});
                else callback = respond;
            }),
        };
        const client = createOffscreenClient({getRuntime: () => runtime, getOffscreen: () => ({createDocument: vi.fn()})});
        const first = client.send({type: 'LARGE_MODEL_DOWNLOAD'}, {timeoutMs: 600_000});
        let settled = false;
        void first.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(599_999);
        expect(settled).toBe(false);
        callback?.({success: true});
        await expect(first).resolves.toEqual({success: true});
        const bounded = client.send({type: 'LARGE_MODEL_DOWNLOAD'}, {timeoutMs: Number.MAX_SAFE_INTEGER})
            .then(() => null, error => error);
        let boundedSettled = false;
        void bounded.then(() => { boundedSettled = true; });
        await vi.advanceTimersByTimeAsync(629_999);
        expect(boundedSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(bounded).resolves.toMatchObject({message: 'Offscreen 消息响应超时'});
    });

    it('十分钟模型下载结束后的错误回包仍能在显式三十秒收尾预算内返回', async () => {
        vi.useFakeTimers();
        let callback: ((response: unknown) => void) | undefined;
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, respond: (response: unknown) => void) => {
                if ((message as {type: string}).type === OFFSCREEN_READY_MESSAGE_TYPE) respond({success: true, ready: true});
                else callback = respond;
            }),
        };
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({getRuntime: () => runtime, getOffscreen: () => ({createDocument})});
        let settled = false;
        const request = client.send({type: 'VIDEO_AI_PREPARE', model: 'small', keepWarm: false}, {timeoutMs: 630_000})
            .then(value => { settled = true; return value; }, error => { settled = true; return error; });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        callback?.({success: false, error: '模型下载超过总等待时限'});
        await expect(request).resolves.toEqual({success: false, error: '模型下载超过总等待时限'});
        expect(createDocument).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('短预算 Chrome caller 不会缩短共享 prepare，后加入的长预算调用仍可成功', async () => {
        vi.useFakeTimers();
        const contexts = deferred<unknown[]>();
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(() => contexts.promise),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown}).type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                }
            }),
        };
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument}),
            preparationTimeoutMs: 100,
        });

        const short = client.send({type: 'CHROME_TRANSLATE_OFFSCREEN'}, {timeoutMs: 1})
            .then(() => null, (error: unknown) => error);
        const long = client.ensureDocument({timeoutMs: 100});
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect((await short as Error).message).toContain('Offscreen 文档准备超时');

        contexts.resolve([]);
        await expect(long).resolves.toBeUndefined();
        expect(runtime.getContexts).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('准备超时会清空 preparingDocument，后续请求可以重新创建并成功', async () => {
        vi.useFakeTimers();
        const never = deferred<unknown[]>();
        const getContexts = vi.fn()
            .mockImplementationOnce(() => never.promise)
            .mockResolvedValueOnce([]);
        const runtime: OffscreenRuntimeApi = {
            getContexts,
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown}).type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                }
            }),
        };
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument}),
            preparationTimeoutMs: 20,
        });

        const timedOut = client.ensureDocument().then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(20);
        await expect(timedOut).resolves.toMatchObject({message: '无法创建 Offscreen 文档：Offscreen 文档准备超时'});
        await expect(client.ensureDocument()).resolves.toBeUndefined();
        expect(getContexts).toHaveBeenCalledTimes(2);
        expect(createDocument).toHaveBeenCalledOnce();
        never.resolve([]);
        await Promise.resolve();
        await Promise.resolve();
    });

    it('绝对截止时间已过时不会启动操作，ready delay 同步失败也会释放准备所有权', async () => {
        const expiredRuntime = createRuntime({contexts: [{}]});
        const expiredClient = createOffscreenClient({
            getRuntime: () => expiredRuntime.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
            messageTimeoutMs: 1,
        });
        const now = vi.spyOn(Date, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValue(2);
        await expect(expiredClient.send({type: 'PING'})).rejects.toThrow('Offscreen 文档准备超时');
        expect(expiredRuntime.getContexts).not.toHaveBeenCalled();
        now.mockRestore();

        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
                callback({success: true, ready: false});
            }),
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
            readyRetryAttempts: 2,
            readyRetryDelay: () => { throw new Error('delay failed'); },
        });
        await expect(client.ensureDocument()).rejects.toThrow('delay failed');
        await expect(client.ensureDocument()).rejects.toThrow('delay failed');
        expect(runtime.getContexts).toHaveBeenCalledTimes(2);
    });

    it('取消消息同步发送失败不会阻止本地 AbortSignal 结束等待', async () => {
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            const type = (message as {type?: unknown}).type;
            if (type === OFFSCREEN_READY_MESSAGE_TYPE) callback({success: true, ready: true});
            else if (type === 'CANCEL') throw new Error('cancel transport gone');
        });
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage,
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        const controller = new AbortController();
        const pending = client.send({type: 'PING'}, {
            signal: controller.signal,
            cancelMessage: {type: 'CANCEL'},
        });
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
            {type: 'PING', target: 'offscreen'}, expect.any(Function),
        ));
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    });

    it('接收端丢失后的强制重建可由调用方 AbortSignal 立即终止', async () => {
        let runtimeError: {message?: string} | undefined;
        const runtime: OffscreenRuntimeApi = {
            get lastError() { return runtimeError; },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
                runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
                runtimeError = undefined;
            }),
        };
        const closing = deferred<void>();
        const closeDocument = vi.fn(() => closing.promise);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined), closeDocument}),
            readyRetryAttempts: 1,
        });
        const controller = new AbortController();
        const pending = client.ensureDocument({signal: controller.signal});
        await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledOnce());

        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        closing.resolve();
    });

    it('does not create for optional sends and propagates synchronous messaging failures', async () => {
        const absent = createRuntime();
        const absentCreate = vi.fn(async () => undefined);
        const absentClient = createOffscreenClient({
            getRuntime: () => absent.runtime,
            getOffscreen: () => ({createDocument: absentCreate}),
        });
        await expect(absentClient.sendIfPresent({type: 'STOP'})).resolves.toBeUndefined();
        expect(absentCreate).not.toHaveBeenCalled();
        expect(absent.sendMessage).not.toHaveBeenCalled();

        const present = createRuntime({contexts: [{}], response: {success: true}});
        const presentClient = createOffscreenClient({
            getRuntime: () => present.runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
        });
        await expect(presentClient.sendIfPresent({type: 'STOP'})).resolves.toEqual({success: true});
        await expect(presentClient.sendIfPresent({type: 'STOP'}, {timeoutMs: 100}))
            .resolves.toEqual({success: true});

        present.sendMessage.mockImplementationOnce(() => {
            throw new TypeError('send failed');
        });
        await expect(presentClient.sendIfPresent({type: 'STOP'})).rejects.toThrow('send failed');
    });

    it('已就绪文档后续 send 跳过重复 getContexts 与 READY 探测，接收端消失时自动重建并恢复快路径', async () => {
        let runtimeError: {message?: string} | undefined;
        let readyCount = 0;
        let disappearOnNextPing = false;
        const getContexts = vi.fn(async () => [{}]);
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            const type = (message as {type?: unknown}).type;
            if (type === OFFSCREEN_READY_MESSAGE_TYPE) {
                readyCount += 1;
                callback({success: true, ready: true});
                return;
            }
            if (disappearOnNextPing) {
                disappearOnNextPing = false;
                runtimeError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
                runtimeError = undefined;
                return;
            }
            callback({success: true, type});
        });
        const runtime: OffscreenRuntimeApi = {
            get lastError() { return runtimeError; },
            getContexts,
            sendMessage,
        };
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({closeDocument, createDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send({type: 'FIRST'})).resolves.toEqual({success: true, type: 'FIRST'});
        expect(getContexts).toHaveBeenCalledTimes(1);
        expect(readyCount).toBe(1);

        await expect(client.send({type: 'SECOND'})).resolves.toEqual({success: true, type: 'SECOND'});
        await expect(client.send({type: 'THIRD'})).resolves.toEqual({success: true, type: 'THIRD'});
        expect(getContexts).toHaveBeenCalledTimes(1);
        expect(readyCount).toBe(1);

        // ensureDocument 始终执行权威探测。
        await expect(client.ensureDocument()).resolves.toBeUndefined();
        expect(getContexts).toHaveBeenCalledTimes(2);
        expect(readyCount).toBe(2);

        // 已就绪状态下接收端突然消失，单次重建后继续恢复快路径。
        disappearOnNextPing = true;
        await expect(client.send({type: 'RECOVER'})).resolves.toEqual({success: true, type: 'RECOVER'});
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
        expect(getContexts).toHaveBeenCalledTimes(3);
        expect(readyCount).toBe(3);

        await expect(client.send({type: 'AFTER_RECOVER'})).resolves.toEqual({success: true, type: 'AFTER_RECOVER'});
        expect(getContexts).toHaveBeenCalledTimes(3);
        expect(readyCount).toBe(3);

        // 已就绪状态下预取消的 send 仍立即发送取消消息且不触发 getContexts 或业务消息。
        const aborted = new AbortController();
        aborted.abort();
        await expect(client.send({type: 'SKIPPED'}, {
            signal: aborted.signal,
            cancelMessage: {type: 'CANCEL_FAST'},
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(getContexts).toHaveBeenCalledTimes(3);
        expect(sendMessage).toHaveBeenLastCalledWith(
            {type: 'CANCEL_FAST', target: 'offscreen'},
            expect.any(Function),
        );
    });

    it('已就绪文档遇到在途准备、空上下文查询、sendIfPresent 或跨 epoch 迟到 READY 时均保持安全串行', async () => {
        vi.useFakeTimers();
        const probeQuery = deferred<unknown[]>();
        const creation = deferred<void>();
        let contextsResult: unknown[] = [{}];
        let readyCallbacks: Array<(response: unknown) => void> = [];
        let holdReady = false;
        let readyCount = 0;
        const sentTypes: string[] = [];
        const getContexts = vi.fn(() => {
            if (contextsResult === probeQueryResultSentinel) return probeQuery.promise;
            return Promise.resolve(contextsResult);
        });
        const probeQueryResultSentinel: unknown[] = [];
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            const type = (message as {type: string}).type;
            sentTypes.push(type);
            if (type === OFFSCREEN_READY_MESSAGE_TYPE) {
                readyCount += 1;
                if (holdReady) readyCallbacks.push(callback);
                else callback({success: true, ready: true});
            } else {
                callback({success: true, type});
            }
        });
        const createDocument = vi.fn(() => creation.promise);
        const client = createOffscreenClient({
            getRuntime: () => ({getContexts, sendMessage}),
            getOffscreen: () => ({createDocument}),
            preparationTimeoutMs: 20,
            readyRetryAttempts: 1,
        });

        // 1. sendIfPresent 不会把未握手文档提升为就绪态；随后的 send 仍执行 READY 握手。
        await expect(client.sendIfPresent({type: 'OPTIONAL_BEFORE_READY'}))
            .resolves.toEqual({success: true, type: 'OPTIONAL_BEFORE_READY'});
        expect(readyCount).toBe(0);
        await expect(client.send({type: 'WARM'})).resolves.toEqual({success: true, type: 'WARM'});
        expect(readyCount).toBe(1);

        // 2. documentReady=true 但 preparingDocument 在途时，send 必须等待当前准备完成。
        contextsResult = probeQueryResultSentinel;
        const probing = client.ensureDocument();
        await Promise.resolve();
        const behindProbe = client.send({type: 'BEHIND_PROBE'});
        await Promise.resolve();
        expect(sentTypes).not.toContain('BEHIND_PROBE');
        probeQuery.resolve([{}]);
        await expect(probing).resolves.toBeUndefined();
        await expect(behindProbe).resolves.toEqual({success: true, type: 'BEHIND_PROBE'});
        expect(readyCount).toBe(2);

        // 3. hasDocument 观察到空文档集合时会立即失效 documentReady 并递增 epoch。
        contextsResult = [];
        await expect(client.hasDocument()).resolves.toBe(false);
        contextsResult = [{}];
        await expect(client.send({type: 'AFTER_EMPTY'})).resolves.toEqual({success: true, type: 'AFTER_EMPTY'});
        expect(readyCount).toBe(3);

        // 4. 在途 READY 握手期间 hasDocument([]) 递增 epoch 时，即使该 READY 随后返回成功也不得置位 documentReady。
        holdReady = true;
        const staleReadyEnsure = client.ensureDocument();
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
        expect(readyCallbacks).toHaveLength(1);
        contextsResult = [];
        await expect(client.hasDocument()).resolves.toBe(false);
        const staleEpochCallback = readyCallbacks.shift()!;
        staleEpochCallback({success: true, ready: true});
        await expect(staleReadyEnsure).resolves.toBeUndefined();

        holdReady = false;
        contextsResult = [{}];
        await expect(client.send({type: 'AFTER_STALE_EPOCH'})).resolves.toEqual({success: true, type: 'AFTER_STALE_EPOCH'});
        expect(readyCount).toBe(5);

        // 5. prepare 在 mutateDocument 期间超时后，滞留的创建操作仍由 documentReady=false 保护，send 必须等待变更结束。
        contextsResult = [];
        const mutatingEnsure = client.ensureDocument().catch(error => error);
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
        expect(createDocument).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(20);
        await expect(mutatingEnsure).resolves.toMatchObject({message: '无法创建 Offscreen 文档：Offscreen 文档准备超时'});

        contextsResult = [{}];
        const behindMutation = client.send({type: 'BEHIND_MUTATION'});
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
        expect(sentTypes).not.toContain('BEHIND_MUTATION');
        creation.resolve();
        await expect(behindMutation).resolves.toEqual({success: true, type: 'BEHIND_MUTATION'});
    });

    it('binds the production singleton lazily to the Chrome globals', async () => {
        const runtime = createRuntime();
        vi.stubGlobal('chrome', {
            runtime: runtime.runtime,
            offscreen: {createDocument: vi.fn(async () => undefined)},
        });

        await expect(chromeOffscreenClient.hasDocument()).resolves.toBe(false);
        expect(runtime.getContexts).toHaveBeenCalledWith({contextTypes: ['OFFSCREEN_DOCUMENT']});
    });

    it('rebuilds once when the message port closes before a response is received', async () => {
        let runtimeError: {message?: string} | undefined;
        let businessAttempts = 0;
        const runtime: OffscreenRuntimeApi = {
            get lastError() { return runtimeError; },
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    callback({success: true, ready: true});
                    return;
                }
                businessAttempts += 1;
                if (businessAttempts === 1) {
                    runtimeError = {message: 'The message port closed before a response was received.'};
                    callback(undefined);
                    runtimeError = undefined;
                    return;
                }
                callback({success: true, recovered: true});
            }),
        };
        const closeDocument = vi.fn(async () => undefined);
        const createDocument = vi.fn(async () => undefined);
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument, closeDocument}),
            readyRetryAttempts: 1,
        });

        await expect(client.send<{success: boolean; recovered: boolean}>({type: 'PING'}))
            .resolves.toEqual({success: true, recovered: true});
        expect(closeDocument).toHaveBeenCalledOnce();
        expect(createDocument).toHaveBeenCalledOnce();
    });

    it('uses capped exponential backoff for ready polling and cleans timers when deadline expires', async () => {
        vi.useFakeTimers();
        const attemptTimes: number[] = [];
        const startedAt = Date.now();
        let readyAttempts = 0;
        const runtime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
                if ((message as {type?: unknown})?.type === OFFSCREEN_READY_MESSAGE_TYPE) {
                    attemptTimes.push(Date.now() - startedAt);
                    readyAttempts += 1;
                    callback({success: true, ready: readyAttempts >= 7});
                }
            }),
        };
        const client = createOffscreenClient({
            getRuntime: () => runtime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
            readyRetryAttempts: 10,
            preparationTimeoutMs: 5_000,
        });

        const ensure = client.ensureDocument();
        await vi.advanceTimersByTimeAsync(1_200);
        await expect(ensure).resolves.toBeUndefined();
        expect(attemptTimes).toEqual([0, 25, 75, 175, 375, 775, 1175]);
        expect(vi.getTimerCount()).toBe(0);

        const timeoutRuntime: OffscreenRuntimeApi = {
            getContexts: vi.fn(async () => [{}]),
            sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
                callback({success: true, ready: false});
            }),
        };
        const timeoutClient = createOffscreenClient({
            getRuntime: () => timeoutRuntime,
            getOffscreen: () => ({createDocument: vi.fn(async () => undefined)}),
            readyRetryAttempts: 10,
            preparationTimeoutMs: 60,
        });
        const failing = timeoutClient.ensureDocument().then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60);
        await expect(failing).resolves.toMatchObject({message: '无法创建 Offscreen 文档：Offscreen 文档准备超时'});
        expect(vi.getTimerCount()).toBe(0);
    });
});
