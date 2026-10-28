import {ttsPreparation} from './helpers/localInferenceFixtures';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {LOCAL_TTS_MODEL, LOCAL_TTS_MODEL_ID, LOCAL_TTS_MODEL_STATE_KEY} from '@/src/core/config/localTts';
import {
    createLocalTtsBackgroundHandlers,
    LOCAL_TTS_MODEL_PREPARE_MESSAGE,
    LOCAL_TTS_MODEL_REMOVE_MESSAGE,
    LOCAL_TTS_MODEL_STATE_MESSAGE,
} from '@/src/features/local-tts/background/handlers';
import {createLocalTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {LocalTtsLanguageUnsupportedError, localTtsErrorCode} from '@/src/features/local-tts/protocol';
import type {OffscreenClient} from '@/src/platform/offscreen/client';

vi.mock('@/src/features/local-tts/offscreen/modelCache', () => ({
    cacheLocalTtsModelFiles: vi.fn(async () => undefined),
    isLocalTtsModelCached: vi.fn(async () => true),
    removeLocalTtsModelFiles: vi.fn(async () => undefined),
}));
const inferenceBudget = vi.hoisted(() => ({run: vi.fn()}));
// metadata 用例默认直通；idle 回归则注入真实 budget，模拟其他推理占满并行槽。
vi.mock('@/src/shared/onnx/resources', async original => ({
    ...await original<typeof import('@/src/shared/onnx/resources')>(),
    withLocalInferenceBudget: inferenceBudget.run,
}));

function createStore(initial: Record<string, unknown> = {}) {
    const data = {...initial};
    return {
        data,
        get: vi.fn(async (key: string) => (key in data ? {[key]: data[key]} : {})),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); }),
    };
}

function handlersFor(offscreen: Partial<Parameters<typeof createLocalTtsBackgroundHandlers>[0]['offscreen']>, store = createStore()) {
    const handlers = createLocalTtsBackgroundHandlers({
        offscreen: {
            prepare: vi.fn(async () => ttsPreparation()),
            status: vi.fn(async () => ({models: []})),
            remove: vi.fn(async () => undefined),
            ...offscreen,
        },
        storage: store,
    });
    const byType = new Map(handlers.map((handler) => [handler.type, handler]));
    return {
        store,
        run: (type: string) => byType.get(type)!.handle({type}, undefined),
    };
}

const defaultState = {model: LOCAL_TTS_MODEL_ID, downloaded: false, downloadSizeMb: LOCAL_TTS_MODEL.downloadSizeMb};

describe('本地 TTS 模型后台消息', () => {
    it('状态查询优先采用 Offscreen 实测结果，其次是已保存状态，最后回落到未下载', async () => {
        const reported = {model: LOCAL_TTS_MODEL_ID, downloaded: true, downloadSizeMb: 170, revision: 'r1'};
        const live = handlersFor({status: vi.fn(async () => ({models: [reported]}))});
        await expect(live.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toEqual({success: true, model: LOCAL_TTS_MODEL_ID, downloaded: true, models: [reported]});
        expect(live.store.data[LOCAL_TTS_MODEL_STATE_KEY]).toEqual(reported);

        const saved = {model: LOCAL_TTS_MODEL_ID, downloaded: true, downloadSizeMb: 170};
        const fromStorage = handlersFor({status: vi.fn(async () => ({models: [{model: 'other', downloaded: true}]}))},
            createStore({[LOCAL_TTS_MODEL_STATE_KEY]: saved}));
        await expect(fromStorage.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toMatchObject({downloaded: true, models: [saved]});

        for (const models of [undefined, [null], [['array']], [{model: LOCAL_TTS_MODEL_ID, downloaded: 'yes'}]]) {
            const empty = handlersFor({status: vi.fn(async () => ({models} as never))}, createStore({[LOCAL_TTS_MODEL_STATE_KEY]: 'corrupt'}));
            await expect(empty.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toEqual({
                success: true, model: LOCAL_TTS_MODEL_ID, downloaded: false, models: [defaultState],
            });
        }
    });

    it.each([undefined, '170', Number.NaN, Number.POSITIVE_INFINITY, -1])('canonicalizes stored model size %s and discards malformed optional metadata', async downloadSizeMb => {
        const record = {model: LOCAL_TTS_MODEL_ID, downloaded: true, downloadSizeMb, dtype: 7, revision: {value: 'bad'}, unrelated: 'discard'};
        const original = structuredClone(record);
        const subject = handlersFor({}, createStore({[LOCAL_TTS_MODEL_STATE_KEY]: record}));
        const expected = {...defaultState, downloaded: true};
        await expect(subject.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toEqual({success: true, model: LOCAL_TTS_MODEL_ID, downloaded: true, models: [expected]});
        expect(subject.store.data[LOCAL_TTS_MODEL_STATE_KEY]).toStrictEqual(expected);
        expect(record).toStrictEqual(original);
    });
    it('retains a legacy receipt without a size, valid string metadata, and a finite reported size', async () => {
        const legacy = {model: LOCAL_TTS_MODEL_ID, downloaded: true, dtype: 'q4', revision: 'pinned-revision'};
        const stored = handlersFor({}, createStore({[LOCAL_TTS_MODEL_STATE_KEY]: legacy}));
        const expected = {...legacy, downloadSizeMb: LOCAL_TTS_MODEL.downloadSizeMb};
        await expect(stored.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toMatchObject({models: [expected]});
        expect(stored.store.data[LOCAL_TTS_MODEL_STATE_KEY]).toStrictEqual(expected);
        const current = handlersFor({status: vi.fn(async () => ({models: [{...legacy, downloadSizeMb: 0}]}))});
        await expect(current.run(LOCAL_TTS_MODEL_STATE_MESSAGE)).resolves.toMatchObject({models: [{...legacy, downloadSizeMb: 0}]});
    });
    it('下载完成后始终记为已下载，并保留 Offscreen 返回的版本信息', async () => {
        const described = handlersFor({prepare: vi.fn(async () => ({...ttsPreparation(), dtype: 'q4f16', revision: 'abc', backend: 'wasm' as const}))});
        const response = await described.run(LOCAL_TTS_MODEL_PREPARE_MESSAGE);
        expect(response).toMatchObject({success: true, backend: 'wasm', model: LOCAL_TTS_MODEL_ID, downloaded: true});
        expect(described.store.data[LOCAL_TTS_MODEL_STATE_KEY]).toEqual({...defaultState, downloaded: true, dtype: 'q4f16', revision: 'abc'});

        const reported = {model: LOCAL_TTS_MODEL_ID, downloaded: false, downloadSizeMb: 170};
        const listed = handlersFor({prepare: vi.fn(async () => ({...ttsPreparation(), models: [reported], dtype: 7} as never))});
        await expect(listed.run(LOCAL_TTS_MODEL_PREPARE_MESSAGE)).resolves.toMatchObject({models: [{...reported, downloaded: true}]});

        const bare = handlersFor({prepare: vi.fn(async () => ({...ttsPreparation(), dtype: 1, revision: 2} as never))});
        await bare.run(LOCAL_TTS_MODEL_PREPARE_MESSAGE);
        expect(bare.store.data[LOCAL_TTS_MODEL_STATE_KEY]).toEqual({...defaultState, downloaded: true, dtype: undefined, revision: undefined});
    });

    it('清除期间拒绝重复清除和下载，失败后释放锁；状态写入按顺序串行且失败不阻塞后续写入', async () => {
        let finishRemove!: () => void;
        const remove = vi.fn(() => new Promise<void>((resolve) => { finishRemove = resolve; }));
        const store = createStore();
        store.set.mockRejectedValueOnce(new Error('quota'));
        const subject = handlersFor({remove, prepare: vi.fn(async () => ttsPreparation())}, store);

        const removing = subject.run(LOCAL_TTS_MODEL_REMOVE_MESSAGE);
        await expect(subject.run(LOCAL_TTS_MODEL_REMOVE_MESSAGE)).rejects.toThrow('正在清除本地 TTS 模型');
        await expect(subject.run(LOCAL_TTS_MODEL_PREPARE_MESSAGE)).rejects.toThrow('正在清除本地 TTS 模型');
        finishRemove();
        await expect(removing).rejects.toThrow('quota');

        remove.mockImplementationOnce(async () => undefined);
        await expect(subject.run(LOCAL_TTS_MODEL_REMOVE_MESSAGE)).resolves.toEqual({
            success: true, model: LOCAL_TTS_MODEL_ID, downloaded: false, models: [defaultState],
        });
        expect(store.data[LOCAL_TTS_MODEL_STATE_KEY]).toEqual(defaultState);
    });
});

describe('本地 TTS Offscreen 适配器', () => {
    function clientWith(send: (message: Record<string, unknown>, options?: unknown) => Promise<unknown>) {
        return {send: vi.fn(send)} as unknown as OffscreenClient & {send: ReturnType<typeof vi.fn>};
    }

    it('合成请求携带可取消 requestId 与超时，并解码 WAV 音频', async () => {
        const client = clientWith(async () => ({success: true, audioBase64: btoa('RIFF'), voice: 'zm_009', backend: 'wasm'}));
        const adapter = createLocalTtsOffscreenAdapter(client);
        const controller = new AbortController();
        const audio = await adapter.synthesize('你好', 'zh-CN', 'auto', controller.signal);

        expect(new TextDecoder().decode(audio.audio)).toBe('RIFF');
        expect(audio).toMatchObject({contentType: 'audio/wav', voice: 'zm_009', backend: 'wasm'});
        const [message, options] = client.send.mock.calls[0]!;
        expect(message).toMatchObject({type: 'LOCAL_TTS_SYNTHESIZE', text: '你好', language: 'zh-CN', voice: 'auto'});
        expect(options).toEqual({
            signal: controller.signal,
            timeoutMs: 120_000,
            cancelMessage: {type: expect.any(String), requestId: (message as {requestId: string}).requestId},
        });

        const fallbackVoice = createLocalTtsOffscreenAdapter(clientWith(async () => ({success: true, audioBase64: btoa('x'), voice: ''})));
        await expect(fallbackVoice.synthesize('hi', 'en-US', 'af_sol')).resolves.toMatchObject({voice: 'af_sol'});
    });

    it('失败响应重建为带稳定错误码的 Error，供后台策略跨消息边界识别', async () => {
        const unsupported = new LocalTtsLanguageUnsupportedError('fr-FR');
        const adapter = createLocalTtsOffscreenAdapter(clientWith(async (message) => {
            if (message.type === 'LOCAL_TTS_SYNTHESIZE') return {success: false, error: unsupported.message, errorCode: unsupported.code};
            return undefined;
        }));
        const error = await adapter.synthesize('bonjour', 'fr-FR', 'auto').catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LocalTtsLanguageUnsupportedError);
        expect(localTtsErrorCode(error)).toBe('local-tts-language-unsupported');
        expect((error as Error).message).toBe('本地 TTS 暂不支持语言：fr-FR');

        for (const response of [{success: true, audioBase64: ''}, {success: true}, {success: false, error: ''}]) {
            const empty = createLocalTtsOffscreenAdapter(clientWith(async () => response));
            await expect(empty.synthesize('x', 'zh-CN', 'auto')).rejects.toThrow(response.success ? 'Offscreen LOCAL_TTS_SYNTHESIZE响应消息格式无效' : '本地 TTS 合成失败');
        }
        await expect(adapter.prepare()).rejects.toThrow('Offscreen LOCAL_TTS_PREPARE响应消息格式无效');
        await expect(adapter.status()).rejects.toThrow('Offscreen LOCAL_TTS_STATUS响应消息格式无效');
        await expect(adapter.remove()).rejects.toThrow('Offscreen LOCAL_TTS_REMOVE_MODEL响应消息格式无效');
        expect(localTtsErrorCode(await adapter.remove().catch((reason: unknown) => reason))).toBeUndefined();
        expect(new LocalTtsLanguageUnsupportedError('').message).toBe('本地 TTS 暂不支持语言：未知语言');
    });

    it('模型管理请求使用各自的超时并原样返回成功响应', async () => {
        const client = clientWith(async (message) => ({success: true, type: message.type, ...(message.type === 'LOCAL_TTS_PREPARE' ? ttsPreparation() : {models: []})}));
        const adapter = createLocalTtsOffscreenAdapter(client);
        await expect(adapter.prepare(true)).resolves.toEqual({success: true, type: 'LOCAL_TTS_PREPARE', ...ttsPreparation()});
        await expect(adapter.status()).resolves.toEqual({success: true, type: 'LOCAL_TTS_STATUS', models: []});
        await expect(adapter.remove()).resolves.toBeUndefined();
        expect(client.send.mock.calls.map(([message, options]) => [message, options])).toEqual([
            [{type: 'LOCAL_TTS_PREPARE', keepWarm: true}, {timeoutMs: 300_000}],
            [{type: 'LOCAL_TTS_STATUS'}, {timeoutMs: 30_000}],
            [{type: 'LOCAL_TTS_REMOVE_MODEL'}, {timeoutMs: 30_000}],
        ]);
        await adapter.prepare();
        expect(client.send.mock.calls.at(-1)?.[0]).toEqual({type: 'LOCAL_TTS_PREPARE', keepWarm: false});
    });

    it.each([
        ['missing', {}, undefined],
        ['explicit undefined', {timings: undefined}, undefined],
        ['empty', {timings: []}, []],
        ['null', {timings: null}, []],
        ['object', {timings: {}}, []],
        ['malformed cue', {timings: [{startChar: 0, endChar: 1, startTime: 1, endTime: 0}]}, []],
    ])('keeps valid audio with %s timing metadata and uses the backward-compatible result shape', async (_kind, metadata, expected) => {
        const adapter = createLocalTtsOffscreenAdapter(clientWith(async () => ({
            success: true, audioBase64: btoa('RIFF'), voice: 'zm_009', backend: 'wasm', ...(metadata as object),
        })));
        const result = await adapter.synthesize('你好', 'zh-CN', 'auto');
        expect(new TextDecoder().decode(result.audio)).toBe('RIFF');
        expect(result).toEqual({
            audio: new TextEncoder().encode('RIFF').buffer, contentType: 'audio/wav', voice: 'zm_009', backend: 'wasm',
            ...(expected === undefined ? {} : {timings: expected}),
        });
        if (expected === undefined) expect(result).not.toHaveProperty('timings');
    });

    it('validates timing order and copies only timing fields before exposing decoded audio', async () => {
        const cues = [
            {startChar: 0, endChar: 2, startTime: 0, endTime: 1, internal: 'discard'},
            {startChar: 3, endChar: 5, startTime: 1.5, endTime: 3},
        ];
        const client = clientWith(async () => ({success: true, audioBase64: btoa('RIFF'), timings: cues}));
        const result = await createLocalTtsOffscreenAdapter(client).synthesize('你好 世界', 'zh-CN', 'zf_001');
        expect(result.timings).toEqual([
            {startChar: 0, endChar: 2, startTime: 0, endTime: 1}, cues[1],
        ]);
        expect(result.timings).not.toBe(cues);
        expect(result.timings?.[0]).not.toBe(cues[0]);
        expect(cues[0].internal).toBe('discard');
    });
});

describe('local TTS Worker response metadata boundary', () => {
    let runtime: typeof import('@/src/features/local-tts/offscreen/tts');
    let metadata: Record<string, unknown>;
    const audio = new Uint8Array([82, 73, 70, 70]).buffer;
    const workers: Array<{postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>}> = [];
    const cue = {startChar: 0, endChar: 2, startTime: 0, endTime: 1};

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.stubGlobal('navigator', {});
        inferenceBudget.run.mockReset().mockImplementation((operation: () => Promise<unknown>) => operation());
        metadata = {};
        workers.length = 0;
        vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'chrome-extension://test/offscreen.html'}});
        vi.stubGlobal('Worker', class {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror = null;
            terminate = vi.fn();
            postMessage = vi.fn((request: {requestId: number}) => {
                void Promise.resolve().then(() => this.onmessage?.({
                    data: {requestId: request.requestId, success: true, audio, backend: 'wasm', ...metadata},
                } as MessageEvent));
            });
            constructor() { workers.push(this); }
        });
        runtime = await import('@/src/features/local-tts/offscreen/tts');
    });
    afterEach(() => {
        runtime?.disposeLocalTtsWorker();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it.each([
        ['missing', {}, undefined], ['empty', {timings: []}, []], ['null', {timings: null}, []],
        ['valid', {timings: [{...cue, workerPrivate: true}]}, [cue]],
        ['invalid', {timings: [{...cue, endTime: 0}]}, []],
        ['out of order', {timings: [cue, cue]}, []],
    ])('returns WAV and validated %s timings from the actual runtime', async (_kind, input, expected) => {
        metadata = input as Record<string, unknown>;
        const result = await runtime.synthesizeLocalTts('你好', 'zh-CN', 'zf_001');
        expect(result).toEqual({audio, contentType: 'audio/wav', voice: 'zf_001', backend: 'wasm',
            ...(expected === undefined ? {} : {timings: expected})});
        if (expected === undefined) expect(result).not.toHaveProperty('timings');
        expect(workers).toHaveLength(1);
        expect(workers[0].postMessage).toHaveBeenCalledWith({requestId: 1, type: 'synthesize', text: '你好', voice: 'zf_001', speed: 1});
        expect(vi.getTimerCount()).toBe(1);
        runtime.disposeLocalTtsWorker();
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    async function occupyBudget() {
        const {createLocalInferenceBudget} = await vi.importActual<typeof import('@/src/shared/onnx/resources')>('@/src/shared/onnx/resources');
        const budget = createLocalInferenceBudget(1);
        inferenceBudget.run.mockImplementation(budget);
        await runtime.synthesizeLocalTts('第一次', 'zh-CN', 'zf_001');
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const competing = budget(() => gate);
        return {release, competing};
    }

    it('clears the previous idle timer before waiting for budget and reuses the worker after its old 120-second deadline', async () => {
        const occupied = await occupyBudget();
        const controller = new AbortController();
        const pending = runtime.synthesizeLocalTts('第二次', 'zh-CN', 'zf_001', controller.signal)
            .then(result => ({result, error: undefined}), error => ({result: undefined, error}));
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(inferenceBudget.run).toHaveBeenCalledTimes(2);
            expect(inferenceBudget.run).toHaveBeenLastCalledWith(expect.any(Function), expect.any(AbortSignal));
            expect(inferenceBudget.run.mock.calls.at(-1)?.[1].aborted).toBe(false);
            expect(workers[0].postMessage).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
            // t=10s 发起第二次请求，预算在 t=145s 才放行，跨过旧 idle 的 t=120s。
            await vi.advanceTimersByTimeAsync(135_000);
            expect(workers[0].terminate).not.toHaveBeenCalled();
            expect(workers[0].postMessage).toHaveBeenCalledOnce();
            occupied.release();
            await occupied.competing;
            const completed = await pending;
            expect(completed.error).toBeUndefined();
            expect(completed.result).toMatchObject({audio, contentType: 'audio/wav', backend: 'wasm'});
            expect(workers).toHaveLength(1);
            expect(workers[0].postMessage).toHaveBeenLastCalledWith({requestId: 2, type: 'synthesize', text: '第二次', voice: 'zf_001', speed: 1});
            expect(inferenceBudget.run).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(119_999);
            expect(workers[0].terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(workers[0].terminate).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            occupied.release();
            await occupied.competing;
            await pending;
        }
    });

    it('explicit disposal during a budget wait invalidates the queued generation without restarting or posting to the worker', async () => {
        const occupied = await occupyBudget();
        const pending = runtime.synthesizeLocalTts('排队后卸载', 'zh-CN', 'zf_001')
            .then(result => ({result, error: undefined}), error => ({result: undefined, error}));
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(inferenceBudget.run).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
            runtime.disposeLocalTtsWorker();
            expect(workers[0].terminate).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(25_000);
            occupied.release();
            await occupied.competing;
            const completed = await pending;
            expect(completed.result).toBeUndefined();
            expect(completed.error).toMatchObject({name: 'AbortError', message: '本地 TTS 请求已取消'});
            expect(workers).toHaveLength(1);
            expect(workers[0].postMessage).toHaveBeenCalledOnce();
            expect(workers[0].terminate).toHaveBeenCalledOnce();
            expect(inferenceBudget.run).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            occupied.release();
            await occupied.competing;
            await pending;
        }
    });
});
