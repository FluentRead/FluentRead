import {afterEach, describe, expect, it, vi} from 'vitest';
import {createVideoSubtitleBackgroundHandlers, releaseVideoSubtitleOwnerForTab} from '@/src/features/video-subtitle/background/handlers';
import {getVideoAiModelFileUrl, VIDEO_AI_Q4_MODEL_FILES, VIDEO_AI_SMALL_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';

afterEach(() => vi.unstubAllGlobals());
function installModelKeys(models: string[]) {
    const urls = new Set(models.flatMap(model => (model === 'small' ? VIDEO_AI_SMALL_MODEL_FILES : VIDEO_AI_Q4_MODEL_FILES).map(file => getVideoAiModelFileUrl(model, file))));
    const keys = vi.fn(async () => [...urls].map(url => new Request(url)));
    const open = vi.fn(async () => ({keys}));
    vi.stubGlobal('caches', {has: async () => true, open});
    return {urls, keys, open};
}

function setup(response: unknown = {success: true, model: 'tiny', text: '', backend: 'wasm'}) {
    const offscreen = {
        hasDocument: vi.fn(async () => true),
        ensureDocument: vi.fn(async () => undefined),
        send: vi.fn(async <TResponse>() => response as TResponse),
        sendIfPresent: vi.fn(async <TResponse>() => ({success: true} as TResponse)),
    };
    const offscreenClient = offscreen as unknown as import('@/src/platform/offscreen/client').OffscreenClient;
    const storage = {get: vi.fn(async () => ({fluentReadVideoLocalTranscriptionModels: [] as string[]})), set: vi.fn(async () => undefined)};
    const handlers = createVideoSubtitleBackgroundHandlers({offscreen: offscreenClient, storage});
    return {offscreen, storage, handlers};
}
const context = (id: number) => ({sender: {tab: {id}}});
const find = (handlers: readonly {type: string; handle: Function}[], type: string) => handlers.find((item) => item.type === type)!;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}

const ownedEntryTypes = ['fluentReadTranscribeLocalVideoAudio', 'fluentReadPrepareLocalVideoModel'] as const;
function waitingForPreviousCancellation(type: typeof ownedEntryTypes[number]) {
    const previousResponse = deferred<{success: boolean; text: string; model: 'tiny'}>();
    const previousCancel = deferred<{success: boolean}>();
    const fixture = setup({success: true, text: 'current owner response', model: 'tiny', backend: 'wasm'});
    fixture.offscreen.send.mockReturnValueOnce(previousResponse.promise);
    fixture.offscreen.sendIfPresent.mockReturnValueOnce(previousCancel.promise);
    const start = fixture.handlers.find(handler => handler.type === type)!;
    const cancel = fixture.handlers.find(handler => handler.type === 'fluentReadCancelLocalVideoTranscription')!;
    return {
        ...fixture, previousResponse, previousCancel,
        start(generation: number, tab = 1, streamId = 'handoff') {
            const message = {type, streamId, generation, model: 'tiny', keepWarm: true, audioPcm16Base64: 'AAAAAA=='};
            return start.handle(message, context(tab));
        },
        cancel(generation: number, tab = 1, streamId = 'handoff') {
            const message = {type: cancel.type, streamId, generation};
            return cancel.handle(message, context(tab));
        },
    };
}

describe('video subtitle background ownership', () => {
    it('composes browser storage, local model preparation and sender-bound readings through the production runtime', async () => {
        const fixture = setup(); installModelKeys(['tiny']);
        const values: Record<string, unknown> = {fluentReadVideoLocalTranscriptionModels: []};
        const get = vi.fn(async (key: string) => ({[key]: values[key]}));
        const set = vi.fn(async (patch: Record<string, unknown>) => {Object.assign(values, patch);});
        vi.stubGlobal('browser', {runtime: {id: 'fixture-extension'}, storage: {local: {get, set}}});
        fixture.offscreen.send.mockImplementation(async <T>(message?: unknown) => (
            (message as {type: string}).type === 'READING_ANNOTATION'
                ? {success: true, result: {text: 'nihon', language: 'ja', scheme: 'hepburn-ipadic-v1'}}
                : {success: true, model: 'tiny', backend: 'wasm'}
        ) as T);
        vi.doMock('@/src/platform/offscreen/extensionClient', () => ({extensionDomClient: fixture.offscreen}));
        vi.doMock('@/src/services/config/store', () => ({
            config: {on: true, videoTranslationEnabled: true, videoTranscriptionProvider: 'browser'},
            configReady: Promise.resolve(),
            getConfigHydrationStatus: () => 'ready',
        }));
        try {
            const {createVideoSubtitleBackgroundRuntime} = await import('@/src/features/video-subtitle/background/runtime');
            const handlers = createVideoSubtitleBackgroundRuntime();
            const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
            await expect(prepare.handle({type: prepare.type, model: 'tiny', keepWarm: false}, context(14))).resolves.toMatchObject({success: true, model: 'tiny'});
            expect(get).toHaveBeenCalledWith('fluentReadVideoLocalTranscriptionModels');
            expect(set).toHaveBeenCalledWith({fluentReadVideoLocalTranscriptionModels: ['tiny']});
            const reading = find(handlers, 'fluentReadAnnotateVideoReading');
            const request = {type: reading.type, requestId: 'assembly-reading', text: '日本', language: 'ja'};
            await expect(reading.handle(request, {sender: {id: 'fixture-extension', tab: {id: 14}, frameId: 2}})).resolves.toMatchObject({success: true, result: {text: 'nihon'}});
            expect(fixture.offscreen.send).toHaveBeenCalledWith(expect.objectContaining({type: 'READING_ANNOTATION', text: '日本', language: 'ja'}), expect.any(Object));
            await expect(reading.handle(request, {sender: {id: 'other-extension', tab: {id: 14}}})).rejects.toThrow('发送方无效');
            const cache = handlers.find(handler => handler.type === 'fluentReadGetVideoAiSubtitleCache')!;
            const cacheRequest = {type: cache.type, source: {}, model: 'tiny'};
            await expect(cache.handle(cacheRequest, {})).resolves.toMatchObject({success: true, hit: false, cues: []});
        } finally {
            vi.doUnmock('@/src/platform/offscreen/extensionClient');
            vi.doUnmock('@/src/services/config/store');
        }
    });
    it.each(ownedEntryTypes)('%s does not dispatch after its cancellation was acknowledged while the previous cancellation is pending', async type => {
        const f = waitingForPreviousCancellation(type);
        const first = f.start(1);
        const firstRejected = expect(first).rejects.toThrow('generation 已取消');
        const second = f.start(2);
        const secondRejected = expect(second).rejects.toThrow('generation 已取消');
        expect(f.offscreen.send).toHaveBeenCalledOnce();
        expect(f.offscreen.sendIfPresent).toHaveBeenCalledWith(
            {type: 'VIDEO_AI_CANCEL', streamId: 'tab:1:handoff:generation:1'}, {timeoutMs: 5_000});

        await expect(f.cancel(2)).resolves.toEqual({success: true});
        f.previousCancel.resolve({success: true});
        await secondRejected;
        expect(f.offscreen.send).toHaveBeenCalledOnce();
        expect(f.storage.set).not.toHaveBeenCalled();
        f.previousResponse.resolve({success: true, text: 'obsolete first response', model: 'tiny'});
        await firstRejected;
    });
    it.each(ownedEntryTypes)('%s rejects an obsolete waiting generation after a third generation takes ownership', async type => {
        const f = waitingForPreviousCancellation(type);
        const first = f.start(1);
        const firstRejected = expect(first).rejects.toThrow('generation 已取消');
        const second = f.start(2);
        const secondRejected = expect(second).rejects.toThrow('generation 已取消');
        await expect(f.start(3)).resolves.toMatchObject({success: true, text: 'current owner response'});

        f.previousCancel.resolve({success: true});
        await secondRejected;
        expect(f.offscreen.send).toHaveBeenCalledTimes(2);
        expect(f.offscreen.send).not.toHaveBeenCalledWith(
            expect.objectContaining({streamId: 'tab:1:handoff:generation:2'}), expect.anything());
        await expect(f.start(4, 2, 'another-tab')).rejects.toThrow('另一个标签页');
        f.previousResponse.resolve({success: true, text: 'obsolete first response', model: 'tiny'});
        await firstRejected;
        await expect(f.cancel(3)).resolves.toEqual({success: true});
    });
    it.each(ownedEntryTypes)('%s dispatches the current generation only after the previous cancellation completes successfully', async type => {
        const f = waitingForPreviousCancellation(type);
        const first = f.start(1);
        const firstRejected = expect(first).rejects.toThrow('generation 已取消');
        const second = f.start(2);
        expect(f.offscreen.send).toHaveBeenCalledOnce();
        f.previousCancel.resolve({success: true});
        await expect(second).resolves.toMatchObject({success: true, text: 'current owner response'});
        expect(f.offscreen.send).toHaveBeenCalledTimes(2);
        expect(f.offscreen.send).toHaveBeenLastCalledWith(
            expect.objectContaining({streamId: 'tab:1:handoff:generation:2'}), expect.anything());
        f.previousResponse.resolve({success: true, text: 'obsolete first response', model: 'tiny'});
        await firstRejected;
        await expect(f.cancel(2)).resolves.toEqual({success: true});
    });
    it.each(ownedEntryTypes)('%s preserves a previous cancellation failure and releases only its current owner', async type => {
        const f = waitingForPreviousCancellation(type);
        const first = f.start(1);
        const firstRejected = expect(first).rejects.toThrow('generation 已取消');
        const second = f.start(2);
        const failure = new Error('controlled previous cancellation failed');
        const secondRejected = expect(second).rejects.toBe(failure);
        f.previousCancel.reject(failure);
        await secondRejected;
        expect(f.offscreen.send).toHaveBeenCalledOnce();
        await expect(f.start(1, 2, 'another-tab')).resolves.toMatchObject({success: true});
        f.previousResponse.resolve({success: true, text: 'obsolete first response', model: 'tiny'});
        await firstRejected;
        await expect(f.cancel(1, 2, 'another-tab')).resolves.toEqual({success: true});
    });
    it.each(['official', 'mirror', 'auto', 'https://untrusted.invalid', undefined])('validates cache-download source preference %s before forwarding', async preference => {
        const {handlers, offscreen} = setup();
        await find(handlers, 'fluentReadPrepareLocalVideoModel').handle({model: 'small', preference}, context(1));
        expect(offscreen.send).toHaveBeenCalledWith({type: 'VIDEO_AI_PREPARE', model: 'small', keepWarm: false, preference: preference === 'official' || preference === 'mirror' ? preference : 'auto'}, {timeoutMs: 630_000});
    });
    it.each(['tiny', 'base'])('gives %s the downloader total budget plus cleanup time', async model => {
        const {handlers, offscreen} = setup();
        await find(handlers, 'fluentReadPrepareLocalVideoModel').handle({model}, context(1));
        expect(offscreen.send).toHaveBeenCalledWith({type: 'VIDEO_AI_PREPARE', model, keepWarm: false, preference: 'auto'}, {timeoutMs: 630_000});
    });
    it.each([
        ['tiny', 'tiny', 40_000], ['base', 'base', 40_000], ['small', 'small', 200_000], ['unknown', 'small', 200_000],
    ])('transcription request %s uses its bounded model budget without enlarging invalid models', async (model, normalized, timeoutMs) => {
        const {handlers, offscreen} = setup({success: true, text: 'bounded result'});
        await find(handlers, 'fluentReadTranscribeLocalVideoAudio').handle({model, streamId: 'budget', generation: 1, audioPcm16Base64: 'AAAAAA=='}, context(1));
        expect(offscreen.send).toHaveBeenCalledWith(expect.objectContaining({type: 'VIDEO_AI_TRANSCRIBE', model: normalized}), expect.objectContaining({timeoutMs, cancelMessage: expect.objectContaining({type: 'VIDEO_AI_CANCEL'})}));
    });
    it('cache prepare does not require stream/generation', async () => {
        const {handlers, storage} = setup();
        const result = await find(handlers, 'fluentReadPrepareLocalVideoModel').handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: false}, context(1));
        expect(result.success).toBe(true);
        expect(storage.set).toHaveBeenCalledTimes(1);
    });
    it('returns normalized downloaded model state through a background-only query', async () => {
        const {handlers} = setup();
        const result = await find(handlers, 'fluentReadGetLocalVideoModelState').handle({type: 'fluentReadGetLocalVideoModelState'}, context(1));
        expect(result).toEqual({success: true, models: [], available: {tiny: false, base: false, small: false}});
    });
    it('filters a missing model file from availability while keeping its receipt and avoiding Offscreen or network', async () => {
        const {urls} = installModelKeys(['tiny', 'base', 'small']);
        urls.delete(getVideoAiModelFileUrl('tiny', 'tokenizer.json'));
        const {handlers, offscreen, storage} = setup();
        storage.get.mockResolvedValue({fluentReadVideoLocalTranscriptionModels: ['tiny', 'base', 'small']});
        const fetcher = vi.fn(), worker = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('Worker', worker);
        await expect(find(handlers, 'fluentReadGetLocalVideoModelState').handle({}, context(1))).resolves.toEqual({success: true, models: ['base', 'small'], available: {tiny: false, base: true, small: true}});
        expect(storage.set).not.toHaveBeenCalled(); expect(offscreen.send).not.toHaveBeenCalled(); expect(offscreen.ensureDocument).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    });
    it('propagates cache-read failure without deleting download receipts or starting Offscreen', async () => {
        const {handlers, offscreen, storage} = setup();
        storage.get.mockResolvedValue({fluentReadVideoLocalTranscriptionModels: ['tiny']});
        vi.stubGlobal('caches', {has: async () => {throw new Error('storage failed');}});
        await expect(find(handlers, 'fluentReadGetLocalVideoModelState').handle({}, context(1))).rejects.toThrow('无法读取模型缓存');
        expect(storage.set).not.toHaveBeenCalled(); expect(offscreen.send).not.toHaveBeenCalled();
    });
    it('does not erase a later successful download receipt while an older cache-key read is pending', async () => {
        const {keys} = installModelKeys(['base']);
        let resolveKeys!: (keys: Request[]) => void;
        keys.mockReturnValueOnce(new Promise(resolve => {resolveKeys = resolve;}));
        const state: Record<string, unknown> = {fluentReadVideoLocalTranscriptionModels: ['tiny']};
        const {offscreen} = setup();
        const storage = {get: async () => ({...state}), set: vi.fn(async (next: Record<string, unknown>) => {Object.assign(state, next);})};
        const handlers = createVideoSubtitleBackgroundHandlers({offscreen: offscreen as any, storage});
        const status = find(handlers, 'fluentReadGetLocalVideoModelState');
        const older = status.handle({}, context(1));
        for (let n = 0; n < 8; n++) await Promise.resolve();
        await find(handlers, 'fluentReadPrepareLocalVideoModel').handle({model: 'base'}, context(1));
        resolveKeys([]); await expect(older).resolves.toMatchObject({models: []});
        expect(state.fluentReadVideoLocalTranscriptionModels).toEqual(['tiny', 'base']);
        expect(storage.set).toHaveBeenCalledOnce();
        await expect(status.handle({}, context(1))).resolves.toMatchObject({models: ['base']});
    });

    it('serializes concurrent cache writes so Tiny and Base state are merged', async () => {
        const stored: Record<string, unknown> = {fluentReadVideoLocalTranscriptionModels: []};
        const offscreen = {
            send: vi.fn(async () => ({success: true, model: 'tiny'})),
            sendIfPresent: vi.fn(async () => ({success: true})),
        } as any;
        const storage = {
            get: vi.fn(async () => ({...stored})),
            set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); }),
        };
        const handlers = createVideoSubtitleBackgroundHandlers({offscreen, storage});
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        const [tiny, base, small] = await Promise.all([
            prepare.handle({model: 'tiny'}, context(1)),
            prepare.handle({model: 'base'}, context(1)),
            prepare.handle({model: 'small'}, context(1)),
        ]);
        expect(tiny.models).toEqual(['tiny']);
        expect(base.models).toEqual(['tiny', 'base']);
        expect(small.models).toEqual(['tiny', 'base', 'small']);
        expect(stored.fluentReadVideoLocalTranscriptionModels).toEqual(['tiny', 'base', 'small']);
    });
    it.each(['tiny', 'small'])('does not mark failed %s prepare as downloaded', async model => {
        const {handlers, storage} = setup({success: false, error: 'failed'});
        const result = await find(handlers, 'fluentReadPrepareLocalVideoModel').handle({type: 'fluentReadPrepareLocalVideoModel', model}, context(1));
        expect(result.success).toBe(false);
        expect(storage.set).not.toHaveBeenCalled();
    });
    it('Small prepares use ten minutes, expose availability, and delete only their state receipt', async () => {
        installModelKeys(['tiny', 'base', 'small']);
        const state: Record<string, unknown> = {fluentReadVideoLocalTranscriptionModels: ['tiny', 'base']};
        const {offscreen} = setup();
        const storage = {get: async () => ({...state}), set: async (value: Record<string, unknown>) => {Object.assign(state, value);}};
        const handlers = createVideoSubtitleBackgroundHandlers({offscreen: offscreen as any, storage});
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        await prepare.handle({model: 'small'}, context(1));
        expect(offscreen.send).toHaveBeenLastCalledWith(expect.objectContaining({model: 'small', keepWarm: false}), {timeoutMs: 630_000});
        await expect(find(handlers, 'fluentReadGetLocalVideoModelState').handle({}, context(1))).resolves.toMatchObject({available: {tiny: true, base: true, small: true}});
        await prepare.handle({model: 'small', keepWarm: true, streamId: 'small-owner', generation: 1}, context(1));
        expect(offscreen.send).toHaveBeenLastCalledWith(expect.objectContaining({model: 'small', keepWarm: true}), expect.objectContaining({timeoutMs: 600_000}));
        await find(handlers, 'fluentReadCancelLocalVideoTranscription').handle({streamId: 'small-owner', generation: 1}, context(1));
        await expect(find(handlers, 'fluentReadRemoveLocalVideoModel').handle({model: 'small'})).resolves.toMatchObject({models: ['tiny', 'base']});
        expect(offscreen.send).toHaveBeenLastCalledWith({type: 'VIDEO_AI_REMOVE_MODEL', model: 'small'}, {timeoutMs: 30_000});
    });
    it('rejects another tab while an owner is warm', async () => {
        const {handlers} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        await prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 1}, context(1));
        await expect(prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's2', generation: 1}, context(2))).rejects.toThrow('另一个标签页');
    });
    it('cancellation uses sendIfPresent and releases the matching generation', async () => {
        const {handlers, offscreen} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        const cancel = find(handlers, 'fluentReadCancelLocalVideoTranscription');
        await prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 1}, context(1));
        await cancel.handle({type: 'fluentReadCancelLocalVideoTranscription', streamId: 's', generation: 1}, context(1));
        expect(offscreen.sendIfPresent).toHaveBeenCalled();
    });
    it('tab release cancels the owner and allows another tab to acquire it', async () => {
        const {handlers, offscreen} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        await prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 1}, context(1));
        releaseVideoSubtitleOwnerForTab(1);
        await expect(prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's2', generation: 1}, context(2))).resolves.toMatchObject({success: true});
        expect(offscreen.sendIfPresent).toHaveBeenCalled();
    });
    it('rejects malformed warm and cancel messages', async () => {
        const {handlers} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        const cancel = find(handlers, 'fluentReadCancelLocalVideoTranscription');
        await expect(prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true}, context(1))).rejects.toThrow('缺少流标识');
        await expect(cancel.handle({type: 'fluentReadCancelLocalVideoTranscription', streamId: '', generation: 1}, context(1))).rejects.toThrow('缺少流标识');
    });
    it('forwards successful transcription and cancels the previous generation', async () => {
        const {handlers, offscreen} = setup({success: true, text: 'ok', segments: []});
        const transcribe = find(handlers, 'fluentReadTranscribeLocalVideoAudio');
        const first = await transcribe.handle({type: 'fluentReadTranscribeLocalVideoAudio', streamId: 's', generation: 1, audioPcm16Base64: 'AAAAAA=='}, context(1));
        expect(first).toMatchObject({success: true, text: 'ok'});
        const second = await transcribe.handle({type: 'fluentReadTranscribeLocalVideoAudio', streamId: 's', generation: 2, audioPcm16Base64: 'AAAAAA=='}, context(1));
        expect(second.success).toBe(true);
        expect(offscreen.sendIfPresent).toHaveBeenCalled();
    });
    it('rejects cancelled and conflicting generations without touching Offscreen', async () => {
        const {handlers, offscreen} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        const cancel = find(handlers, 'fluentReadCancelLocalVideoTranscription');
        await prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 1}, context(1));
        await cancel.handle({type: 'fluentReadCancelLocalVideoTranscription', streamId: 's', generation: 1}, context(1));
        const calls = offscreen.sendIfPresent.mock.calls.length;
        await expect(prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 1}, context(1))).rejects.toThrow('已取消');
        await expect(prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 'other', generation: 1}, context(2))).resolves.toMatchObject({success: true});
        releaseVideoSubtitleOwnerForTab(999);
        expect(offscreen.sendIfPresent.mock.calls.length).toBeGreaterThanOrEqual(calls);
    });
    it('ignores a stale cancel so it cannot terminate a newer generation', async () => {
        const {handlers, offscreen} = setup();
        const prepare = find(handlers, 'fluentReadPrepareLocalVideoModel');
        const cancel = find(handlers, 'fluentReadCancelLocalVideoTranscription');
        await prepare.handle({type: 'fluentReadPrepareLocalVideoModel', model: 'tiny', keepWarm: true, streamId: 's', generation: 2}, context(1));
        offscreen.sendIfPresent.mockClear();
        const result = await cancel.handle({type: 'fluentReadCancelLocalVideoTranscription', streamId: 's', generation: 1}, context(1));
        expect(result).toMatchObject({success: true, stale: true});
        expect(offscreen.sendIfPresent).not.toHaveBeenCalled();
        await cancel.handle({type: 'fluentReadCancelLocalVideoTranscription', streamId: 's', generation: 2}, context(1));
    });
});

describe('native video background ownership', () => {
    const selection = {provider: 'native-qwen' as const, model: 'Qwen/Qwen3-ASR-1.7B',
        nativeBaseUrl: 'http://127.0.0.1:8000', sourceLanguage: 'en', streamId: 'native', generation: 1};
    function nativeFixture() {
        const f = setup();
        const settings = {enabled: true, provider: 'native-qwen' as const, baseUrl: selection.nativeBaseUrl, sourceLanguage: 'en'};
        const nativeTranscribe = vi.fn(async () => ({text: 'native result', model: selection.model, audioDurationMs: 0.0625}));
        const handlers = createVideoSubtitleBackgroundHandlers({offscreen: f.offscreen as any, storage: f.storage,
            readNativeSettings: () => settings, nativeTranscribe});
        return {...f, settings, nativeTranscribe, handlers,
            prepare: (patch = {}, tab = 71) => find(handlers, 'fluentReadPrepareLocalVideoModel').handle({...selection, keepWarm: true, ...patch}, context(tab)),
            transcribe: (patch = {}, tab = 71) => find(handlers, 'fluentReadTranscribeLocalVideoAudio').handle({...selection, audioPcm16Base64: 'AAA=', ...patch}, context(tab)),
            cancel: (reason?: string, tab = 71) => find(handlers, 'fluentReadCancelLocalVideoTranscription').handle({...selection, reason}, context(tab))};
    }
    it('warms only client ownership and transcribes without Offscreen or downloads', async () => {
        const f = nativeFixture();
        await expect(f.prepare()).resolves.toEqual({success: true, model: selection.model, provider: 'native-qwen', preparation: 'client-only'});
        await expect(f.transcribe()).resolves.toMatchObject({success: true, text: 'native result', provider: 'native-qwen', timingSource: 'audio-window'});
        expect(f.nativeTranscribe).toHaveBeenCalledWith('AAA=', expect.objectContaining({baseUrl: selection.nativeBaseUrl, sourceLanguage: 'en'}));
        expect(f.offscreen.send).not.toHaveBeenCalled();
        expect(f.storage.set).not.toHaveBeenCalled();
        await expect(f.cancel('complete')).resolves.toEqual({success: true, completed: true});
        expect(f.offscreen.sendIfPresent).not.toHaveBeenCalled();
    });
    it.each([undefined, 'complete'])('cancels prepared native ownership without transport: %s', async reason => {
        const f = nativeFixture();
        await f.prepare();
        await expect(f.cancel(reason)).resolves.toEqual(reason === 'complete' ? {success: true, completed: true} : {success: true});
        expect(f.nativeTranscribe).not.toHaveBeenCalled();
        expect(f.offscreen.sendIfPresent).not.toHaveBeenCalled();
        await expect(f.prepare({}, 72)).resolves.toMatchObject({preparation: 'client-only'});
    });
    it('rejects native browser downloads, wrong models, missing audio and changed selection', async () => {
        const f = nativeFixture();
        await expect(f.prepare({keepWarm: false})).rejects.toThrow('不通过浏览器下载');
        await expect(f.prepare({model: 'tiny'})).rejects.toThrow('模型与请求不一致');
        await f.prepare();
        await expect(f.prepare({sourceLanguage: 'ja'})).rejects.toThrow('识别配置已改变');
        await expect(f.transcribe({audioPcm16Base64: undefined})).rejects.toThrow('需要 PCM16');
        expect(f.nativeTranscribe).not.toHaveBeenCalled();
        await expect(f.prepare({}, 72)).resolves.toMatchObject({preparation: 'client-only'});
    });
    it.each(['enabled', 'provider', 'baseUrl', 'sourceLanguage'])('fails closed on changed native setting %s', async field => {
        const f = nativeFixture();
        Object.assign(f.settings, {[field]: field === 'enabled' ? false : 'changed'});
        await expect(f.prepare()).rejects.toThrow('本机转写选择');
        Object.assign(f.settings, {enabled: true, provider: 'native-qwen', baseUrl: selection.nativeBaseUrl, sourceLanguage: 'en'});
        await expect(f.prepare({}, 72)).resolves.toMatchObject({preparation: 'client-only'});
        expect(f.offscreen.send).not.toHaveBeenCalled();
    });
    it.each([undefined, 'complete'])('waits for deferred native transport after cancel: %s', async reason => {
        const f = nativeFixture();
        const transport = deferred<{text: string; model: string; audioDurationMs: number}>();
        f.nativeTranscribe.mockReturnValue(transport.promise);
        const work = f.transcribe();
        const rejected = expect(work).rejects.toThrow('generation 已取消');
        await Promise.resolve(); await Promise.resolve();
        expect(f.nativeTranscribe).toHaveBeenCalledOnce();
        await expect(f.transcribe()).rejects.toThrow('仍在进行');
        let settled = false;
        const cancel = f.cancel(reason).then((value: unknown) => {settled = true; return value;});
        const signal = (f.nativeTranscribe.mock.calls[0] as unknown as [string, {signal: AbortSignal}])[1].signal;
        expect(signal.aborted).toBe(reason !== 'complete');
        await Promise.resolve();
        expect(settled).toBe(false);
        transport.resolve({text: 'obsolete', model: selection.model, audioDurationMs: 0.0625});
        await rejected;
        await expect(cancel).resolves.toEqual(reason === 'complete' ? {success: true, completed: true} : {success: true});
        expect(f.offscreen.sendIfPresent).not.toHaveBeenCalled();
    });
    it('allows a new generation only after old native cancellation settles', async () => {
        const f = nativeFixture();
        const transport = deferred<{text: string; model: string; audioDurationMs: number}>();
        f.nativeTranscribe.mockReturnValueOnce(transport.promise);
        const old = expect(f.transcribe()).rejects.toThrow('controlled rejection');
        await Promise.resolve(); await Promise.resolve();
        const next = f.prepare({generation: 2});
        transport.reject(new Error('controlled rejection'));
        await old;
        await expect(next).resolves.toMatchObject({preparation: 'client-only'});
        expect(f.offscreen.sendIfPresent).not.toHaveBeenCalled();
    });
});

describe('native video runtime hydration gate', () => {
    it.each(['ready', 'not-ready', 'rejected'])('checks hydration without weakening browser ports: %s', async state => {
        vi.resetModules();
        const ready = deferred<void>();
        let status = 'loading';
        const config = {on: true, videoTranslationEnabled: true, videoTranscriptionProvider: 'native-qwen',
            videoNativeAsrBaseUrl: 'http://127.0.0.1:8000', videoSourceLanguage: 'en'};
        let readSettings!: () => {enabled: boolean; provider: string; baseUrl: string; sourceLanguage: string};
        vi.stubGlobal('browser', {runtime: {id: 'fixture-extension'}, storage: {local: {get: vi.fn(), set: vi.fn()}}});
        vi.doMock('@/src/services/config/store', () => ({config, configReady: ready.promise, getConfigHydrationStatus: () => status}));
        vi.doMock('@/src/platform/offscreen/extensionClient', () => ({extensionDomClient: {}}));
        vi.doMock('@/src/features/video-subtitle/background/handlers', () => ({
            createVideoSubtitleBackgroundHandlers: (deps: {readNativeSettings: typeof readSettings}) => {readSettings = deps.readNativeSettings; return [];},
        }));
        try {
            const {createVideoSubtitleBackgroundRuntime} = await import('@/src/features/video-subtitle/background/runtime');
            createVideoSubtitleBackgroundRuntime();
            expect(() => readSettings()).toThrow('尚未安全加载');
            if (state === 'rejected') ready.reject(new Error('controlled hydration failure')); else ready.resolve();
            await Promise.resolve();
            status = state === 'ready' ? 'ready' : 'failed';
            if (state !== 'ready') {
                expect(() => readSettings()).toThrow('尚未安全加载');
            } else {
                expect(readSettings()).toEqual({enabled: true, provider: 'native-qwen', baseUrl: config.videoNativeAsrBaseUrl, sourceLanguage: 'en'});
                config.on = false;
                expect(readSettings().enabled).toBe(false);
                config.on = true; config.videoTranslationEnabled = false;
                expect(readSettings().enabled).toBe(false);
                config.videoSourceLanguage = '';
                expect(readSettings().sourceLanguage).toBe('auto');
            }
        } finally {
            vi.doUnmock('@/src/services/config/store');
            vi.doUnmock('@/src/platform/offscreen/extensionClient');
            vi.doUnmock('@/src/features/video-subtitle/background/handlers');
            vi.resetModules();
        }
    });
});
