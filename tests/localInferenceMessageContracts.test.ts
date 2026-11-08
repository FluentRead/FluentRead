import {parseVideoBackgroundResponse} from '@/src/core/messaging/video';
/** Real shared Offscreen client → message router → controlled execution ports; malformed serialized data stays at the boundary. */
import {describe, expect, expectTypeOf, it, vi} from 'vitest';
import {createOffscreenClient, type OffscreenMessage} from '@/src/platform/offscreen/client';
import {sendOffscreenRequest, sendOffscreenRequestIfPresent} from '@/src/platform/offscreen/requests';
import {createOffscreenMessageListener, type OffscreenMessageDependencies} from '@/src/app/offscreen/messageRouter';
import {createVideoSubtitleBackgroundHandlers} from '@/src/features/video-subtitle/background/handlers';
import {createBackgroundMessageRouter, createBackgroundRuntimeMessageListener} from '@/src/services/messaging/backgroundRouter';
import {createLocalTranslationBackgroundHandlers} from '@/src/features/local-translation/background/handlers';
import {createLocalTranslationOffscreenAdapter} from '@/src/platform/offscreen/localTranslation';
import {createLocalTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {sendVideoSubtitleRequest} from '@/src/features/video-subtitle/content/backgroundClient';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import {parseOffscreenRequest, parseOffscreenResponse, type KnownOffscreenRequest, type OffscreenRequestMap, type OffscreenResponseMap, type VideoTranscriptionResult, type VideoPreparationResult, type VideoTranscriptionModel} from '@/src/core/messaging/offscreen';
import {translationSnapshot, ttsPreparation} from './helpers/localInferenceFixtures';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => {resolve = yes;});
    return {promise, resolve};
}
function executionPorts() {
    return {
        videoAi: {
            transcribe: vi.fn(async (): Promise<VideoTranscriptionResult> => ({text: 'spoken', model: 'tiny', segments: [{startMs: 0, endMs: 1000, text: 'spoken'}]})),
            prepare: vi.fn(async (): Promise<VideoPreparationResult> => ({model: 'tiny' as VideoTranscriptionModel})),
            cancel: vi.fn(async () => undefined), removeModel: vi.fn(async () => undefined),
        },
        localTranslation: {
            translate: vi.fn(async (_request: OffscreenRequestMap['LOCAL_TRANSLATION_TRANSLATE'], _signal: AbortSignal) => 'translated'),
            prepare: vi.fn(async () => translationSnapshot()), pause: vi.fn(async () => translationSnapshot('paused')),
            status: vi.fn(async () => ({models: [], ...translationSnapshot()})), removeModel: vi.fn(async () => undefined),
        },
        localTts: {
            synthesize: vi.fn(async () => ({audio: new Uint8Array([82, 73, 70, 70]).buffer, contentType: 'audio/wav' as const, voice: 'zf_001', backend: 'wasm' as const})),
            prepare: vi.fn(async () => ttsPreparation()), status: vi.fn(async () => ({models: []})), removeModel: vi.fn(async () => undefined),
        },
    };
}
function connect(ports = executionPorts(), intercept = (_message: OffscreenMessage, response: unknown): unknown => response) {
    const listener = createOffscreenMessageListener({
        ...ports, translate: async () => 'chrome', fetchImage: async () => '', translateImage: async () => ({}), translateArea: async () => ({}), downloadOcrLanguages: async () => undefined,
        ttsPlayer: {play: async () => undefined, stop: () => false, seek: () => false},
    } satisfies OffscreenMessageDependencies);
    const messages: unknown[] = [];
    const document = vi.fn(async () => undefined);
    const client = createOffscreenClient({
        getOffscreen: () => ({createDocument: document}),
        getRuntime: () => ({getContexts: async () => [{}], sendMessage(message, callback) {
            messages.push(message);
            if (!listener(message, {}, response => callback(intercept(message as OffscreenMessage, response)))) callback(undefined);
        }}),
    });
    const dispatch = (message: unknown) => new Promise<unknown>(resolve => {
        expect(listener(message, {}, resolve)).toBe(true);
    });
    return {client, messages, document, ports, dispatch};
}
const model = LOCAL_TRANSLATION_MODEL_IDS.m2m100;
const requests = [
    {type: 'VIDEO_AI_TRANSCRIBE', model: 'tiny', streamId: 'video-stream', audioPcm16Base64: 'AAAA', sourceLanguage: 'en'},
    {type: 'VIDEO_AI_PREPARE', model: 'tiny', keepWarm: false, preference: 'mirror'},
    {type: 'VIDEO_AI_CANCEL', streamId: 'video-stream', reason: 'complete'},
    {type: 'VIDEO_AI_REMOVE_MODEL', model: 'tiny'},
    {type: 'LOCAL_TRANSLATION_TRANSLATE', requestId: 'text-1', model, text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh', sourceLanguageDetectionText: 'English context'},
    {type: 'LOCAL_TRANSLATION_PREPARE', model, keepWarm: false},
    {type: 'LOCAL_TRANSLATION_PAUSE', model},
    {type: 'LOCAL_TRANSLATION_STATUS'}, {type: 'LOCAL_TRANSLATION_REMOVE_MODEL', model},
    {type: 'CANCEL_LOCAL_TRANSLATION_OFFSCREEN', requestId: 'text-1'},
    {type: 'LOCAL_TTS_SYNTHESIZE', requestId: 'tts-1', text: '你好', language: 'zh', voice: 'zf_001'},
    {type: 'LOCAL_TTS_PREPARE', keepWarm: false}, {type: 'LOCAL_TTS_STATUS'}, {type: 'LOCAL_TTS_REMOVE_MODEL'},
    {type: 'CANCEL_LOCAL_TTS_OFFSCREEN', requestId: 'tts-1'},
] as const satisfies readonly KnownOffscreenRequest[];

describe('known local inference wire contracts', () => {
    it.each(requests)('uses the real client and router for $type', async request => {
        const f = connect();
        const response = await sendOffscreenRequest(f.client, request);
        expect(response.success).toBe(true);
        expect(f.messages.at(-1)).toEqual({...request, target: 'offscreen'});
        expect(f.document).not.toHaveBeenCalled();
        if (request.type === 'VIDEO_AI_CANCEL') expect(f.ports.videoAi.cancel).toHaveBeenCalledWith('video-stream', 'complete');
        if (request.type === 'LOCAL_TRANSLATION_TRANSLATE') {
            expect(response).toMatchObject({result: 'translated', requestId: 'text-1'});
            expect(f.ports.localTranslation.translate).toHaveBeenCalledWith({...request, target: 'offscreen'}, expect.any(AbortSignal));
        }
        if (request.type === 'LOCAL_TTS_SYNTHESIZE') expect(response).toMatchObject({audioBase64: 'UklGRg==', voice: 'zf_001'});
    });
    it('retains the encoded-audio legacy field and model defaults through the actual route', async () => {
        const f = connect();
        const request = {type: 'VIDEO_AI_TRANSCRIBE' as const, streamId: 'legacy-audio', audioBase64: 'data:audio/wav;base64,UklGRg=='};
        await expect(sendOffscreenRequest(f.client, request)).resolves.toMatchObject({success: true, text: 'spoken'});
        expect(f.ports.videoAi.transcribe).toHaveBeenCalledWith({...request, target: 'offscreen'});
        expect(f.messages.at(-1)).not.toHaveProperty('audioPcm16Base64');
    });
    it('retains type-associated responses without a caller-provided response cast', async () => {
        const f = connect();
        const reply = await sendOffscreenRequest(f.client, {type: 'LOCAL_TRANSLATION_TRANSLATE', requestId: 'typed-1', model, text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh'});
        expectTypeOf(reply).toEqualTypeOf<OffscreenResponseMap['LOCAL_TRANSLATION_TRANSLATE']>();
        if (reply.success) expectTypeOf(reply.result).toEqualTypeOf<string>();
        // The serialized input is rejected before any runtime API is touched; this is also a compile-time negative.
        // @ts-expect-error Voice is a wire string, never a model option object.
        await expect(sendOffscreenRequest(f.client, {type: 'LOCAL_TTS_SYNTHESIZE', requestId: 'typed-2', text: 'hi', language: 'en', voice: {name: 'wrong'}})).rejects.toThrow('消息格式无效');
        expect(f.messages).toHaveLength(2); // ready and the single valid translation
    });
    it.each([
        ['VIDEO_AI_TRANSCRIBE', {audioPcm16Base64: 4}], ['VIDEO_AI_TRANSCRIBE', {audioPcm16Base64: undefined, audioBase64: undefined}], ['VIDEO_AI_PREPARE', {keepWarm: 'yes'}], ['VIDEO_AI_PREPARE', {preference: 'https://untrusted.invalid'}],
        ['VIDEO_AI_REMOVE_MODEL', {model: 'unlisted'}], ['VIDEO_AI_CANCEL', {streamId: ''}],
        ['LOCAL_TRANSLATION_TRANSLATE', {text: 42}], ['LOCAL_TRANSLATION_TRANSLATE', {sourceLanguageDetectionText: {text: 'private'}}],
        ['LOCAL_TRANSLATION_PREPARE', {model: 'unlisted'}], ['LOCAL_TRANSLATION_PAUSE', {model: 2}], ['LOCAL_TRANSLATION_REMOVE_MODEL', {model: null}],
        ['CANCEL_LOCAL_TRANSLATION_OFFSCREEN', {requestId: 'bad id'}], ['LOCAL_TTS_SYNTHESIZE', {voice: 4}], ['LOCAL_TTS_PREPARE', {keepWarm: 1}], ['CANCEL_LOCAL_TTS_OFFSCREEN', {requestId: ''}],
    ] as const)('rejects malformed %s before execution', async (type, fields) => {
        const f = connect();
        const request = requests.find(value => value.type === type)!;
        const reply = await f.dispatch({...request, ...fields, target: 'offscreen'});
        expect(reply).toMatchObject({success: false, error: expect.any(String)});
        expect(Object.values(f.ports.videoAi).every(port => port.mock.calls.length === 0)).toBe(true);
        expect(Object.values(f.ports.localTranslation).every(port => port.mock.calls.length === 0)).toBe(true);
        expect(Object.values(f.ports.localTts).every(port => port.mock.calls.length === 0)).toBe(true);
    });
    it.each(requests)('rejects corrupted serialized $type replies', async request => {
        const f = connect(undefined, (message, reply) => message.type === request.type ? {success: 'true', payload: reply} : reply);
        await expect(sendOffscreenRequest(f.client, request)).rejects.toThrow('响应消息格式无效');
    });
    it('preserves actual language, precision and timing diagnostics through the serialized route', async () => {
        const f = connect();
        const diagnostic: VideoTranscriptionResult = {text: 'spoken', segments: [{startMs: 0, endMs: 200, text: 'spoken'}], model: 'small', backend: 'wasm', gpuInfo: 'cpu',
            skipped: false, decodeMs: 1, inferenceMs: 2, audioDurationMs: 200, threads: 1, dtype: 'q8', detectedLanguage: 'en', languageConfidence: 0.9,
            languageDetectionMs: 1, encoderReuse: true, encoderDtype: 'fp32', decoderDtype: 'q8'};
        f.ports.videoAi.transcribe.mockResolvedValueOnce(diagnostic);
        await expect(sendOffscreenRequest(f.client, requests[0])).resolves.toEqual({success: true, ...diagnostic});
        const ready: VideoPreparationResult = {model: 'small', backend: 'wasm', gpuInfo: 'cpu', threads: 1, dtype: 'q4', encoderDtype: 'fp32', decoderDtype: 'q4'};
        f.ports.videoAi.prepare.mockResolvedValueOnce(ready);
        await expect(sendOffscreenRequest(f.client, requests[1])).resolves.toEqual({success: true, ...ready});
        // A malformed optional cancellation payload is caught before it can be stored as a cleanup action.
        // @ts-expect-error Cancellation stream IDs are strings, including options nested inside known requests.
        await expect(sendOffscreenRequest(f.client, requests[0], {cancelMessage: {type: 'VIDEO_AI_CANCEL', streamId: 2}})).rejects.toThrow('消息格式无效');
        expect(f.ports.videoAi.transcribe).toHaveBeenCalledOnce();
    });
    it('validates matching-model snapshots and rejects forged task and speech metadata', () => {
        const snapshot = translationSnapshot();
        expect(parseOffscreenResponse('LOCAL_TRANSLATION_PREPARE', {success: true, ...snapshot})).toMatchObject(snapshot);
        for (const change of [{error: 'not-a-code'}, {downloadedBytes: Infinity}, {downloadedBytes: -1}, {downloadedBytes: 101}, {model: 'unlisted'}, {phase: 'invented'}]) {
            expect(() => parseOffscreenResponse('LOCAL_TRANSLATION_PREPARE', {success: true, version: 2, tasks: [{...snapshot.tasks[0], ...change}]})).toThrow('响应消息格式无效');
        }
        const timings = [{startChar: 0, endChar: 1, startTime: 0, endTime: 1}];
        expect(parseOffscreenResponse('LOCAL_TTS_SYNTHESIZE', {success: true, audioBase64: 'UklGRg==', timings})).toMatchObject({timings});
        expect(parseOffscreenResponse('LOCAL_TTS_SYNTHESIZE', {success: true, audioBase64: 'UklGRg==', timings: {broken: true}})).toMatchObject({timings: []});
        expect(() => parseOffscreenRequest('LOCAL_TTS_STATUS', [])).toThrow('消息格式无效');
        expect(() => parseOffscreenResponse('VIDEO_AI_TRANSCRIBE', {success: true, text: 42})).toThrow('响应消息格式无效');
        expect(() => parseOffscreenResponse('VIDEO_AI_PREPARE', {success: true, model: 'unlisted'})).toThrow('响应消息格式无效');
        expect(() => parseOffscreenResponse('LOCAL_TRANSLATION_STATUS', {success: true, models: [{model, downloaded: 'yes'}]})).toThrow('响应消息格式无效');
    });
    it('does not create a document for absent cancellation and still validates a present cancellation ACK', async () => {
        const noDocument = createOffscreenClient({getOffscreen: () => ({createDocument: vi.fn()}), getRuntime: () => ({getContexts: async () => [], sendMessage: vi.fn()})});
        await expect(sendOffscreenRequestIfPresent(noDocument, {type: 'VIDEO_AI_CANCEL', streamId: 'gone'})).resolves.toBeUndefined();
        const f = connect();
        await expect(sendOffscreenRequestIfPresent(f.client, {type: 'VIDEO_AI_CANCEL', streamId: 'present'})).resolves.toEqual({success: true});
        const corrupt = connect(undefined, () => ({success: 1}));
        await expect(sendOffscreenRequestIfPresent(corrupt.client, {type: 'VIDEO_AI_CANCEL', streamId: 'present'})).rejects.toThrow('响应消息格式无效');
    });
    it('cancels the real routed request and prevents a late result from replying into a same-ID retry', async () => {
        const f = connect();
        const first = deferred<string>(), started = deferred<AbortSignal>();
        f.ports.localTranslation.translate.mockImplementationOnce(async (_request, signal) => {started.resolve(signal); return first.promise;});
        const controller = new AbortController();
        const request = requests[4];
        const outcome = sendOffscreenRequest(f.client, request, {signal: controller.signal, cancelMessage: {type: 'CANCEL_LOCAL_TRANSLATION_OFFSCREEN', requestId: request.requestId}});
        const rejected = expect(outcome).rejects.toMatchObject({name: 'AbortError'});
        const signal = await started.promise;
        controller.abort();
        await rejected;
        // This awaited public cancellation acknowledges the actual router before reusing the identifier.
        await sendOffscreenRequestIfPresent(f.client, {type: 'CANCEL_LOCAL_TRANSLATION_OFFSCREEN', requestId: request.requestId});
        expect(signal.aborted).toBe(true);
        await expect(sendOffscreenRequest(f.client, request)).resolves.toMatchObject({success: true, result: 'translated'});
        first.resolve('late obsolete text');
        await first.promise;
        expect(f.ports.localTranslation.translate).toHaveBeenCalledTimes(2);
    });
    it.each(['prepare', 'status', 'remove'] as const)('preserves local TTS %s failure details and its existing empty-error fallback', async operation => {
        const wireTypes = {prepare: 'LOCAL_TTS_PREPARE', status: 'LOCAL_TTS_STATUS', remove: 'LOCAL_TTS_REMOVE_MODEL'};
        const fallback = {prepare: '本地 TTS 模型下载失败', status: '无法读取本地 TTS 模型状态', remove: '本地 TTS 模型清除失败'};
        for (const error of ['controlled model command failed', '']) {
            const f = connect(undefined, (message, value) => message.type === wireTypes[operation] ? {success: false, error} : value);
            const adapter = createLocalTtsOffscreenAdapter(f.client);
            await expect(adapter[operation]()).rejects.toThrow(error || fallback[operation]);
        }
    });
    it('routes local model pause, rejects malformed and duplicate trials, and acknowledges cancellation through the typed port', async () => {
        const f = connect();
        const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)};
        const router = createBackgroundMessageRouter(createLocalTranslationBackgroundHandlers({
            offscreen: createLocalTranslationOffscreenAdapter(f.client), storage, isTrustedProgress: context => context === 'offscreen',
        }));
        const listener = createBackgroundRuntimeMessageListener(router, sender => sender);
        const request = {type: 'fluentReadTryLocalTranslation', requestId: 'trial-1', text: 'hello', model, targetLanguage: 'zh'};
        for (const patch of [{model: 'unlisted'}, {requestId: 'bad id'}, {text: ''}, {text: 'x'.repeat(2001)}, {targetLanguage: null}]) {
            await expect(listener({...request, ...patch}, {})).resolves.toMatchObject({success: false, error: expect.stringContaining('LOCAL_TRANSLATION_INVALID')});
        }
        expect(f.ports.localTranslation.translate).not.toHaveBeenCalled();
        const pending = deferred<string>(), started = deferred<AbortSignal>();
        f.ports.localTranslation.translate.mockImplementationOnce(async (_request, signal) => {started.resolve(signal); return pending.promise;});
        const trial = listener(request, {});
        const signal = await started.promise;
        await expect(listener(request, {})).resolves.toMatchObject({success: false, error: 'LOCAL_TRANSLATION_INVALID_REQUEST'});
        await expect(listener({type: 'fluentReadCancelLocalTranslationTrial', requestId: 'trial-1'}, {})).resolves.toEqual({success: true});
        await expect(trial).resolves.toMatchObject({success: false, error: expect.stringContaining('已取消')});
        expect(signal.aborted).toBe(true);
        pending.resolve('late obsolete trial');
        await pending.promise;
        await expect(listener({type: 'fluentReadPauseLocalTranslationModel', model}, {})).resolves.toEqual({success: true, ...translationSnapshot('paused')});
        await expect(listener({type: 'fluentReadLocalTranslationDownloadProgress', snapshot: {version: 999, tasks: []}}, 'offscreen')).resolves.toEqual({success: false});
        expect(storage.set).not.toHaveBeenCalled();
    });
    it('narrows malformed background messages before reading fields and never cancels a trial through an invalid identifier', async () => {
        const f = connect();
        const storage = {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined)};
        const router = createBackgroundMessageRouter(createLocalTranslationBackgroundHandlers({
            offscreen: createLocalTranslationOffscreenAdapter(f.client), storage, isTrustedProgress: context => context === 'offscreen',
        }));
        const listener = createBackgroundRuntimeMessageListener(router, sender => sender);
        await expect(listener(Object.assign([], {type: 'fluentReadTryLocalTranslation', model}), {})).resolves.toMatchObject({success: false, error: 'LOCAL_TRANSLATION_INVALID_REQUEST'});
        await expect(listener(Object.assign([], {type: 'fluentReadPrepareLocalTranslationModel', model}), {})).resolves.toMatchObject({success: false, error: 'LOCAL_TRANSLATION_INVALID_MODEL'});
        await expect(listener(Object.assign([], {type: 'fluentReadLocalTranslationDownloadProgress', snapshot: translationSnapshot()}), 'offscreen')).resolves.toEqual({success: false});
        expect(f.ports.localTranslation.translate).not.toHaveBeenCalled();
        expect(f.ports.localTranslation.prepare).not.toHaveBeenCalled();
        expect(storage.set).not.toHaveBeenCalled();
        const pending = deferred<string>(), started = deferred<{signal: AbortSignal; requestId: string}>();
        f.ports.localTranslation.translate.mockImplementationOnce(async (request, signal) => {started.resolve({signal, requestId: request.requestId}); return pending.promise;});
        const request = {type: 'fluentReadTryLocalTranslation', requestId: 'owned-trial', model, text: 'hello', targetLanguage: 'zh'};
        const trial = listener(request, {});
        const routed = await started.promise;
        for (const bad of [{requestId: ['owned-trial']}, {requestId: 1}, {}, {requestId: ''}]) {
            await expect(listener({type: 'fluentReadCancelLocalTranslationTrial', ...bad}, {})).resolves.toEqual({success: true});
            expect(routed.signal.aborted).toBe(false);
        }
        await expect(listener(Object.assign([], {type: 'fluentReadCancelLocalTranslationTrial', requestId: 'owned-trial'}), {})).resolves.toEqual({success: true});
        expect(routed.signal.aborted).toBe(false);
        await listener({type: 'fluentReadCancelLocalTranslationTrial', requestId: 'owned-trial'}, {});
        await expect(trial).resolves.toMatchObject({success: false, error: expect.stringContaining('已取消')});
        await sendOffscreenRequestIfPresent(f.client, {type: 'CANCEL_LOCAL_TRANSLATION_OFFSCREEN', requestId: routed.requestId});
        expect(routed.signal.aborted).toBe(true);
        pending.resolve('late after validated cancellation');
        await pending.promise;
    });
    it('connects typed video content requests through the background owner to the real Offscreen router', async () => {
        const f = connect();
        const storage = {get: async () => ({}), set: vi.fn(async () => undefined)};
        const router = createBackgroundMessageRouter(createVideoSubtitleBackgroundHandlers({offscreen: f.client, storage}));
        const listener = createBackgroundRuntimeMessageListener(router, () => ({sender: {tab: {id: 7}}}));
        const send = (message: unknown) => listener(message, {});
        const identity = {streamId: 'content-stream', generation: 1, model: 'tiny'};
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadGetLocalVideoModelState'})).resolves.toEqual({success: true, models: [], available: {tiny: false, base: false, small: false}});
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadPrepareLocalVideoModel', ...identity, keepWarm: true})).resolves.toMatchObject({success: true, model: 'tiny', models: ['tiny']});
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadTranscribeLocalVideoAudio', ...identity, audioPcm16Base64: 'AAAA'})).resolves.toMatchObject({success: true, text: 'spoken'});
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadCancelLocalVideoTranscription', ...identity})).resolves.toEqual({success: true});
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadTranscribeLocalVideoAudio', ...identity, audioPcm16Base64: 'AAAA'})).resolves.toMatchObject({success: false, error: expect.stringContaining('已取消')});
        expect(f.ports.videoAi.transcribe).toHaveBeenCalledOnce();
        expect(f.ports.videoAi.cancel).toHaveBeenCalledWith('tab:7:content-stream:generation:1', 'cancel');
        await expect(sendVideoSubtitleRequest(send, {type: 'fluentReadRemoveLocalVideoModel', model: 'tiny'})).resolves.toEqual({success: true, models: []});
        expect(f.ports.videoAi.removeModel).toHaveBeenCalledWith({type: 'VIDEO_AI_REMOVE_MODEL', model: 'tiny', target: 'offscreen'});
        await expect(sendVideoSubtitleRequest(async () => ({success: true, text: 42}), {type: 'fluentReadTranscribeLocalVideoAudio', ...identity, audioPcm16Base64: 'AAAA'})).rejects.toThrow('响应消息格式无效');
    });
});

describe('native ASR response claims stay bounded', () => {
    const prepareType = 'fluentReadPrepareLocalVideoModel' as const;
    const native = {success: true, model: 'Qwen/Qwen3-ASR-1.7B', provider: 'native-qwen', preparation: 'client-only'};
    it('accepts client-only preparation without claiming inference hardware', () => {
        expect(parseVideoBackgroundResponse(prepareType, native)).toEqual(native);
        const browser = {success: true, model: 'tiny', models: ['tiny'], provider: 'browser'};
        expect(parseVideoBackgroundResponse(prepareType, browser)).toEqual(browser);
        expect(() => parseVideoBackgroundResponse(prepareType, {...browser, preparation: 'client-only'})).toThrow();
    });
    it.each([{models: ['tiny']}, {backend: 'wasm'}, {gpuInfo: 'claimed GPU'}, {threads: 4}, {dtype: 'q4'},
        {provider: undefined}, {preparation: undefined}, {model: 'tiny'}])('rejects unsupported native claims %#', patch => {
        expect(() => parseVideoBackgroundResponse(prepareType, {...native, ...patch})).toThrow();
    });
});
