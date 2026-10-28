import {parseHTML} from 'linkedom';
import {translationSnapshot, ttsPreparation} from './helpers/localInferenceFixtures';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createFirefoxBackgroundDocument} from '@/src/platform/offscreen/firefoxDocument';
import {createExtensionDomClient} from '@/src/platform/offscreen/extensionClient';
import {chromeOffscreenClient, type OffscreenRuntimeApi} from '@/src/platform/offscreen/client';
import {createOffscreenMessageListener, type OffscreenMessageDependencies} from '@/src/app/offscreen/messageRouter';
import {createImageTranslationOffscreenAdapter} from '@/src/features/image-translation/background/offscreenAdapter';
import {createAreaTranslationOffscreenAdapter} from '@/src/features/area-translation/background/offscreenAdapter';
import {createSelectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';

const firefox = {browser: 'firefox', manifestVersion: 2 as const};
const getURL = (path: string) => `moz-extension://test/${path.replace(/^\//u, '')}`;
const documentOptions = {url: 'offscreen.html', reasons: [], justification: 'test'};

function makeDocument(): Document {
    return parseHTML('<html><body></body></html>').document as unknown as Document;
}

function createSubject(overrides: Partial<OffscreenMessageDependencies> = {}) {
    const document = makeDocument();
    const dependencies: OffscreenMessageDependencies = {
        translate: vi.fn(async () => 'translated'),
        ttsPlayer: {play: vi.fn(async () => undefined), stop: vi.fn(), seek: vi.fn(() => true)},
        fetchImage: vi.fn(async () => 'data:image/png;base64,AA=='),
        translateImage: vi.fn(async () => ({image: 'data:image/png;base64,AA==', lines: []})),
        translateArea: vi.fn(async () => ({image: 'data:image/png;base64,AA==', lines: []})),
        downloadOcrLanguages: vi.fn(async () => undefined),
        videoAi: {
            transcribe: vi.fn(async () => ({text: 'hello', cues: []})),
            prepare: vi.fn(async () => ({model: 'tiny' as const, ready: true})),
            cancel: vi.fn(async () => undefined),
        },
        ...overrides,
    };
    const listener = createOffscreenMessageListener(dependencies);
    let lastError: {message: string} | undefined;
    let failNextBusinessMessage = false;
    const runtime: OffscreenRuntimeApi & {getURL: typeof getURL} = {
        getURL,
        get lastError() { return lastError; },
        sendMessage: vi.fn((message, callback) => {
            const type = (message as {type: string}).type;
            if (failNextBusinessMessage && type === 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN') {
                failNextBusinessMessage = false;
                lastError = {message: 'Could not establish connection. Receiving end does not exist.'};
                callback(undefined);
                lastError = undefined;
                return;
            }
            expect(document.querySelectorAll('iframe')).toHaveLength(1);
            expect(listener(message, {}, callback)).toBe(true);
        }),
    };
    const client = createExtensionDomClient(firefox, () => runtime, () => document);
    return {document, runtime, client, dependencies, loseReceiver: () => { failNextBusinessMessage = true; }};
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/src/platform/browser/capabilities');
    vi.doUnmock('@/src/app/offscreen/imageTranslation');
    vi.doUnmock('@/src/app/offscreen/translation');
    for (const id of ['@/src/features/local-translation/offscreen/translation', '@/src/features/local-tts/offscreen/tts', '@/src/features/video-subtitle/offscreen/transcription', '@/src/features/information-highlight/offscreen/runtime']) vi.doUnmock(id);
    vi.resetModules();
});

describe('Firefox shared DOM runtime', () => {
    it('releases ordinary OCR and cached Chrome models when the shared runtime page exits', async () => {
        const disposeOcr = vi.fn(), disposeChrome = vi.fn();
        vi.doMock('@/src/app/offscreen/imageTranslation', async importOriginal => ({
            ...await importOriginal<typeof import('@/src/app/offscreen/imageTranslation')>(),
            disposeImageOcrWorker: disposeOcr,
        }));
        vi.doMock('@/src/app/offscreen/translation', async importOriginal => ({
            ...await importOriginal<typeof import('@/src/app/offscreen/translation')>(),
            disposeChromeTranslationModels: disposeChrome,
        }));
        const addEventListener = vi.fn();
        const environment = {};
        vi.stubGlobal('self', environment);
        vi.stubGlobal('window', {addEventListener});
        vi.stubGlobal('chrome', {runtime: {
            id: 'exit-test', onMessage: {addListener: vi.fn()},
            sendMessage: vi.fn(),
        }});
        const {startOffscreenApp} = await import('@/src/app/offscreen/runtime');
        startOffscreenApp();
        expect(addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function), {once: true});
        addEventListener.mock.calls[0][1]();
        expect(disposeOcr).toHaveBeenCalledOnce();
        expect(disposeChrome).toHaveBeenCalledWith(environment);
    });
    it('owns one hidden extension frame and recreates it after removal without touching unrelated nodes', async () => {
        const document = makeDocument();
        const unrelated = document.createElement('div');
        document.body.append(unrelated);
        const host = createFirefoxBackgroundDocument(() => document, getURL);
        await expect(host.getContexts()).resolves.toEqual([]);
        await host.closeDocument!();
        await host.createDocument(documentOptions);
        const frame = document.querySelector('iframe')!;
        expect(frame.hidden).toBe(true);
        expect(frame.src).toBe(getURL('offscreen.html'));
        await host.createDocument(documentOptions);
        expect(document.querySelector('iframe')).toBe(frame);
        await expect(host.getContexts()).resolves.toEqual([{url: frame.src}]);
        frame.remove();
        await expect(host.getContexts()).resolves.toEqual([]);
        await host.createDocument(documentOptions);
        expect(document.querySelector('iframe')).not.toBe(frame);
        await host.closeDocument!();
        expect(document.querySelector('iframe')).toBeNull();
        expect(unrelated.isConnected).toBe(true);
        await expect(host.getContexts()).resolves.toEqual([]);
    });

    it('reports unavailable Firefox background DOM before starting any business request', async () => {
        const host = createFirefoxBackgroundDocument(() => undefined, getURL);
        await expect(host.createDocument(documentOptions)).rejects.toThrow('Firefox 后台页面尚未就绪');
        const empty = createFirefoxBackgroundDocument(() => ({body: null}) as unknown as Document, getURL);
        await expect(empty.createDocument(documentOptions)).rejects.toThrow('Firefox 后台页面尚未就绪');
    });

    it('reuses the native client outside Firefox MV2 without reading document or runtime globals', () => {
        const getRuntime = vi.fn();
        const getDocument = vi.fn();
        for (const target of [{browser: 'chrome', manifestVersion: 3 as const}, {browser: 'firefox', manifestVersion: 3 as const}]) {
            expect(createExtensionDomClient(target, getRuntime, getDocument)).toBe(chromeOffscreenClient);
        }
        expect(getRuntime).not.toHaveBeenCalled();
        expect(getDocument).not.toHaveBeenCalled();
    });

    it('uses the existing image, area, TTS and video protocols through one shared receiver and frame', async () => {
        const {client, document, dependencies} = createSubject();
        const image = createImageTranslationOffscreenAdapter(client);
        const area = createAreaTranslationOffscreenAdapter(client);
        const tts = createSelectionTtsOffscreenAdapter(client);
        await expect(client.sendIfPresent({type: 'STOP_SELECTION_TTS'})).resolves.toBeUndefined();
        expect(document.querySelector('iframe')).toBeNull();
        await Promise.all([client.ensureDocument(), client.ensureDocument()]);
        await expect(image.fetchImage('https://example.test/a.png')).resolves.toBe('data:image/png;base64,AA==');
        await expect(image.translateImage('data:image/png;base64,AA==', 'en', 'image')).resolves.toMatchObject({lines: []});
        const selection = {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100};
        await expect(area.translateArea('data:image/png;base64,AA==', 'en', 'area', selection)).resolves.toMatchObject({lines: []});
        await tts.play({audioBase64: 'AA==', contentType: 'audio/wav', tabId: 7, clientRequestId: 'tts-a'});
        await tts.stop({tabId: 7, clientRequestId: 'tts-a'});
        await expect(client.send({type: 'VIDEO_AI_PREPARE', model: 'tiny'})).resolves.toMatchObject({ready: true});
        await expect(client.send({type: 'VIDEO_AI_TRANSCRIBE', streamId: 'stream-a', audioPcm16Base64: 'AAAA'})).resolves.toMatchObject({text: 'hello'});
        await client.sendIfPresent({type: 'VIDEO_AI_CANCEL', streamId: 'stream-a'});
        expect(dependencies.fetchImage).toHaveBeenCalledOnce();
        expect(dependencies.translateArea).toHaveBeenCalledWith('data:image/png;base64,AA==', 'en', 'area', selection, expect.any(AbortSignal), expect.any(String));
        expect(dependencies.ttsPlayer.play).toHaveBeenCalledOnce();
        expect(dependencies.ttsPlayer.stop).toHaveBeenCalledOnce();
        expect(dependencies.videoAi!.cancel).toHaveBeenCalledWith('stream-a', 'cancel');
        expect(document.querySelectorAll('iframe')).toHaveLength(1);
        await expect(client.hasDocument()).resolves.toBe(true);
    });

    it('uses the shared receiver-loss recovery to replace only its own iframe', async () => {
        const {client, document, loseReceiver} = createSubject();
        await client.ensureDocument();
        const firstFrame = document.querySelector('iframe');
        loseReceiver();
        await expect(createImageTranslationOffscreenAdapter(client).fetchImage('https://pbs.twimg.com/media/image.png'))
            .resolves.toBe('data:image/png;base64,AA==');
        expect(firstFrame!.isConnected).toBe(false);
        expect(document.querySelectorAll('iframe')).toHaveLength(1);
        expect(document.querySelector('iframe')).not.toBe(firstFrame);
    });

    it('delivers caller cancellation to the existing image router and rejects late work', async () => {
        let resolveImage!: (value: string) => void;
        const fetchImage = vi.fn((_url: string, _signal: AbortSignal) => new Promise<string>(resolve => { resolveImage = resolve; }));
        const {client, document} = createSubject({fetchImage});
        const controller = new AbortController();
        const pending = createImageTranslationOffscreenAdapter(client).fetchImage('https://pbs.twimg.com/media/image.png', {
            requestId: 'image-cancel', signal: controller.signal, timeoutMs: 5_000,
        });
        await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());
        const failure = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        controller.abort();
        await failure;
        expect(fetchImage.mock.calls[0][1].aborted).toBe(true);
        resolveImage('data:image/png;base64,AA==');
        await Promise.resolve();
        expect(document.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('binds the production Firefox selector lazily to its background document and native messaging', async () => {
        vi.doMock('@/src/platform/browser/capabilities', () => ({browserCapabilities: firefox}));
        const subject = createSubject();
        vi.stubGlobal('document', subject.document);
        vi.stubGlobal('chrome', {runtime: subject.runtime});
        const {extensionDomClient} = await import('@/src/platform/offscreen/extensionClient');
        expect(subject.document.querySelector('iframe')).toBeNull();
        await extensionDomClient.ensureDocument();
        await expect(extensionDomClient.hasDocument()).resolves.toBe(true);
    });

    it('finishes and stops shared audio when native messaging returns void instead of a Promise', async () => {
        const audios: any[] = [];
        class Audio {
            src = '';
            preload = '';
            onended: (() => void) | null = null;
            onerror: (() => void) | null = null;
            pause = vi.fn();
            load = vi.fn();
            play = vi.fn(async () => undefined);
            removeAttribute() { this.src = ''; }
            constructor() { audios.push(this); }
        }
        const notifications: unknown[] = [];
        const readLastError = vi.fn(() => ({message: 'The receiving tab has closed'}));
        let listener!: ReturnType<typeof createOffscreenMessageListener>;
        vi.stubGlobal('Audio', Audio);
        vi.stubGlobal('window', {addEventListener: vi.fn()});
        const runtimeId = 'controlled-firefox-extension';
        vi.stubGlobal('chrome', {runtime: {
            id: runtimeId,
            onMessage: {addListener: (value: typeof listener) => { listener = value; }},
            sendMessage: (message: unknown, callback?: () => void) => {
                notifications.push(message);
                callback?.();
                // Firefox's chrome API deliberately returns undefined.
            },
            get lastError() { return readLastError(); },
        }});
        const {startOffscreenApp} = await import('@/src/app/offscreen/runtime');
        startOffscreenApp();
        const send = (message: Record<string, unknown>, sender: unknown = {id: runtimeId}) => new Promise(resolve => {
            listener({target: 'offscreen', ...message}, sender, resolve);
        });
        const route = {tabId: 7, clientRequestId: 'firefox-audio', frameId: 0, ownerUrl: 'https://controlled.example/read'};
        const play = {type: 'PLAY_SELECTION_TTS', audioBase64: 'AA==', contentType: 'audio/wav', ...route};
        for (const sender of [{}, {id: 'other-extension'}, {id: runtimeId, tab: {id: 7}}]) {
            await expect(send(play, sender)).resolves.toMatchObject({success: false});
        }
        expect(audios).toHaveLength(0);
        const revision = await send({type: 'READ_SELECTION_TTS_REVISION'}) as {revision: string};
        const permit = await send({type: 'RESERVE_SELECTION_TTS', ...route, expectedRevision: revision.revision}) as {playbackToken: string};
        await expect(send({...play, playbackToken: permit.playbackToken})).resolves.toEqual({success: true});
        for (const type of ['STOP_SELECTION_TTS', 'SEEK_SELECTION_TTS']) {
            await expect(send({type, ...route, offsetSeconds: 5}, {id: runtimeId, tab: {id: 7}}))
                .resolves.toMatchObject({success: false});
        }
        expect(audios[0].pause).not.toHaveBeenCalled();
        expect(() => audios[0].onended()).not.toThrow();
        const nextRevision = await send({type: 'READ_SELECTION_TTS_REVISION'}) as {revision: string};
        const nextPermit = await send({type: 'RESERVE_SELECTION_TTS', ...route, expectedRevision: nextRevision.revision}) as {playbackToken: string};
        await expect(send({...play, playbackToken: nextPermit.playbackToken})).resolves.toEqual({success: true});
        await expect(send({type: 'STOP_SELECTION_TTS', ...route})).resolves.toEqual({success: true});
        expect(audios[1].pause).toHaveBeenCalledOnce();
        expect(notifications).toEqual([
            expect.objectContaining({...route, state: 'ended'}),
            expect.objectContaining({...route, state: 'stopped'}),
        ]);
        expect(readLastError).toHaveBeenCalledTimes(2);
    });
});


describe('shared offscreen composition through actual message routing', () => {
    it('routes model preparation, inference, progress, cancellation and teardown through the composed public ports', async () => {
        const translation = {configureLocalTranslationDownloadNotifications: vi.fn(), disposeLocalTranslationWorker: vi.fn(),
            prepareLocalTranslationModel: vi.fn(async () => translationSnapshot()), pauseLocalTranslationModelDownload: vi.fn(async () => translationSnapshot('paused')),
            getLocalTranslationModelStatus: vi.fn(async () => ({...translationSnapshot('ready'), models: []})), removeLocalTranslationModel: vi.fn(async () => {}), translateLocalText: vi.fn(async () => '本地译文')};
        const speech = {disposeLocalTtsWorker: vi.fn(), getLocalTtsModelStatus: vi.fn(async () => ({models: []})),
            prepareLocalTtsModel: vi.fn(async (_warm: boolean, report: (value: any) => void) => {report({loaded: 5, total: 10}); return ttsPreparation();}),
            removeLocalTtsModel: vi.fn(async () => {}), synthesizeLocalTts: vi.fn(async () => ({audio: new Uint8Array([1, 2]).buffer, contentType: 'audio/wav', voice: 'fixture'}))};
        const video = {cancelLocalVideoTranscription: vi.fn(async () => {}), removeLocalVideoTranscriptionModel: vi.fn(async () => {}),
            transcribeLocalVideoAudio: vi.fn(async () => ({text: 'Video speech', model: 'tiny'})),
            prepareLocalVideoTranscriptionModel: vi.fn(async (model: string, options: any) => {options.onProgress?.({loaded: 7, total: 10}); return {model};})};
        const downloadOcr = vi.fn(async (_languages: string[], _signal: unknown, progress: (value: any) => void) => progress({loaded: 2, total: 4}));
        const translateChrome = vi.fn(async () => 'Chrome译文'), disposeChrome = vi.fn(), disposeOcr = vi.fn();
        vi.doMock('@/src/features/local-translation/offscreen/translation', () => translation);
        vi.doMock('@/src/features/local-tts/offscreen/tts', () => speech);
        vi.doMock('@/src/features/video-subtitle/offscreen/transcription', () => video);
        vi.doMock('@/src/app/offscreen/imageTranslation', async original => ({...await original<typeof import('@/src/app/offscreen/imageTranslation')>(), downloadImageOcrLanguages: downloadOcr, disposeImageOcrWorker: disposeOcr}));
        vi.doMock('@/src/app/offscreen/translation', async original => ({...await original<typeof import('@/src/app/offscreen/translation')>(), translateWithChromeApi: translateChrome, disposeChromeTranslationModels: disposeChrome}));
        let informationPorts: any; const disposeInformation = vi.fn();
        vi.doMock('@/src/features/information-highlight/offscreen/runtime', () => ({probeInformationHighlightWebGpu: vi.fn(async () => ({supported: true})), createInformationHighlightModelsRuntime: (ports: any) => {
            informationPorts = ports; return {status: async () => ({phase: 'ready'}), prepare: async (id: string) => {ports.createWorker(); ports.notify({loaded: 3, total: 6}, id); ports.notify(undefined, id); return {phase: 'ready'};},
                pause: async () => ({}), remove: async () => ({}), score: async () => ({}), dispose: disposeInformation};
        }}));
        const workers: any[] = [];
        class WorkerPort {onmessage: ((event: any) => void) | null = null; onerror = null; onmessageerror = null; terminate = vi.fn();
            constructor(readonly url: string, readonly options: unknown) {workers.push(this);}
            postMessage(message: any) {queueMicrotask(() => this.onmessage?.({data: {id: message.id, ok: true, result: {text: 'nihongo', language: 'ja', scheme: 'romaji'}}}));}}
        const audios: any[] = [];
        class AudioPort {src = ''; preload = ''; currentTime = 1; duration = 10; onended = null; onerror: (() => void) | null = null; pause = vi.fn(); load = vi.fn(); play = vi.fn(async () => {}); removeAttribute() {this.src = '';} constructor() {audios.push(this);}}
        vi.stubGlobal('Audio', AudioPort);
        vi.stubGlobal('Worker', WorkerPort); const windowPort = new EventTarget(); vi.stubGlobal('window', windowPort); vi.stubGlobal('self', windowPort);
        let listener!: ReturnType<typeof createOffscreenMessageListener>; const sent: any[] = [];
        const readLastError = vi.fn(() => undefined), runtimeId = 'composed-offscreen';
        vi.stubGlobal('chrome', {runtime: {id: runtimeId, getURL: (path: string) => `chrome-extension://fixture/${path}`,
            onMessage: {addListener: (value: typeof listener) => {listener = value;}},
            sendMessage: (value: any, callback: () => void) => {sent.push(value); callback();}, get lastError() {return readLastError();}}});
        (await import('@/src/app/offscreen/runtime')).startOffscreenApp();
        const send = (type: string, data: Record<string, unknown> = {}) => new Promise<any>(resolve => {expect(listener({target: 'offscreen', type, ...data}, {id: runtimeId}, resolve)).toBe(true);});
        try {
            expect(await send('READING_ANNOTATION', {requestId: 'reading', text: '日本語', language: 'ja'})).toMatchObject({success: true, result: {text: 'nihongo'}});
            expect(workers[0].url).toBe('chrome-extension://fixture/readingAnnotationWorker.js'); expect(workers[0].options).toEqual({type: 'module'});
            expect(await send('CHROME_TRANSLATE_OFFSCREEN', {requestId: 'chrome', data: {text: 'Original'}})).toMatchObject({success: true, result: 'Chrome译文'});
            expect(translateChrome).toHaveBeenCalledWith({text: 'Original'}, windowPort, expect.any(AbortSignal));
            const model = LOCAL_TRANSLATION_MODEL_IDS.m2m100;
            expect(await send('LOCAL_TRANSLATION_TRANSLATE', {requestId: 'translate', model, text: 'Original', sourceLanguage: 'en', targetLanguage: 'zh'})).toMatchObject({success: true, result: '本地译文'});
            expect(translation.translateLocalText).toHaveBeenCalledWith(expect.objectContaining({model, text: 'Original'}), expect.any(AbortSignal));
            for (const type of ['LOCAL_TRANSLATION_PREPARE', 'LOCAL_TRANSLATION_STATUS', 'LOCAL_TRANSLATION_PAUSE', 'LOCAL_TRANSLATION_REMOVE_MODEL']) expect(await send(type, {model})).toMatchObject({success: true});
            expect(translation.prepareLocalTranslationModel).toHaveBeenCalledWith(model); expect(translation.pauseLocalTranslationModelDownload).toHaveBeenCalledWith(model); expect(translation.removeLocalTranslationModel).toHaveBeenCalledWith(model);
            await translation.configureLocalTranslationDownloadNotifications.mock.calls[0][0](translationSnapshot());
            expect(sent).toContainEqual({type: 'fluentReadLocalTranslationDownloadProgress', snapshot: translationSnapshot()});
            expect(await send('LOCAL_TTS_SYNTHESIZE', {requestId: 'speech', text: 'Original', language: 'en', voice: 'fixture'})).toMatchObject({success: true, audioBase64: 'AQI='});
            expect(speech.synthesizeLocalTts).toHaveBeenCalledWith('Original', 'en', 'fixture', expect.any(AbortSignal));
            for (const keepWarm of [true, false]) expect(await send('LOCAL_TTS_PREPARE', {keepWarm})).toMatchObject({success: true});
            for (const type of ['LOCAL_TTS_STATUS', 'LOCAL_TTS_REMOVE_MODEL']) expect(await send(type)).toMatchObject({success: true});
            expect(speech.prepareLocalTtsModel).toHaveBeenNthCalledWith(1, true, expect.any(Function)); expect(speech.prepareLocalTtsModel).toHaveBeenNthCalledWith(2, false, expect.any(Function));
            expect(await send('VIDEO_AI_TRANSCRIBE', {model: 'tiny', audioPcm16Base64: 'AA=='})).toMatchObject({success: true, text: 'Video speech'});
            expect(await send('VIDEO_AI_PREPARE', {model: 'tiny', keepWarm: true, streamId: 'warm'})).toMatchObject({success: true});
            expect(video.prepareLocalVideoTranscriptionModel).toHaveBeenLastCalledWith('tiny', {keepWarm: true, streamId: 'warm'});
            expect(await send('VIDEO_AI_PREPARE', {model: 'small', preference: 'mirror'})).toMatchObject({success: true});
            expect(video.prepareLocalVideoTranscriptionModel).toHaveBeenLastCalledWith('small', {keepWarm: false, preference: 'mirror', onProgress: expect.any(Function)});
            expect(await send('VIDEO_AI_CANCEL', {streamId: 'warm', reason: 'complete'})).toMatchObject({success: true});
            expect(await send('VIDEO_AI_REMOVE_MODEL', {model: 'tiny'})).toMatchObject({success: true}); expect(video.removeLocalVideoTranscriptionModel).toHaveBeenCalledWith('tiny');
            expect(await send('FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', {languages: ['eng']})).toMatchObject({success: true});
            expect(downloadOcr).toHaveBeenCalledWith(['eng'], undefined, expect.any(Function));
            for (const modelId of ['qwen2.5-0.5b']) expect(await send('INFORMATION_HIGHLIGHT_PREPARE_OFFSCREEN', {modelId})).toMatchObject({success: true});
            expect(workers.filter(worker => worker.url.endsWith('informationHighlightWorker.js'))).toHaveLength(1);
            expect(informationPorts.probe).toBeTypeOf('function'); expect(informationPorts.budget).toBeTypeOf('function');
            expect(sent.some(message => message.type === 'fluentReadDownloadProgress')).toBe(true); expect(readLastError).toHaveBeenCalled();
            const route = {tabId: 7, clientRequestId: 'speech-playback', frameId: 2, ownerUrl: 'https://fixture.invalid/reader'};
            const revision = await send('READ_SELECTION_TTS_REVISION');
            const reservation = await send('RESERVE_SELECTION_TTS', {...route, expectedRevision: revision.revision});
            expect(await send('PLAY_SELECTION_TTS', {...route, text: 'This text is spoken aloud.', audioBase64: 'AA==', contentType: 'audio/wav', playbackToken: reservation.playbackToken})).toEqual({success: true});
            expect(sent).toContainEqual(expect.objectContaining({...route, type: 'selectionTtsPlaybackState', state: 'progress', position: {currentTime: 1, duration: 10}}));
            audios[0].onerror(); expect(sent).toContainEqual(expect.objectContaining({...route, state: 'error', error: '扩展音频解码或播放失败'}));
        } finally {windowPort.dispatchEvent(new Event('pagehide'));}
        expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(disposeInformation).toHaveBeenCalledOnce(); expect(disposeChrome).toHaveBeenCalledWith(windowPort);
        expect(disposeOcr).toHaveBeenCalledOnce(); expect(translation.disposeLocalTranslationWorker).toHaveBeenCalledOnce(); expect(speech.disposeLocalTtsWorker).toHaveBeenCalledOnce();
    });
});

describe('offscreen 本地模型进度通知边界', () => {
    it.each(['send-throws', 'last-error-throws'])('通知 %s 不阻止本地状态路径', async failure => {
        const configure = vi.fn();
        vi.doMock('@/src/features/local-translation/offscreen/translation', async original => ({
            ...await original<typeof import('@/src/features/local-translation/offscreen/translation')>(),
            configureLocalTranslationDownloadNotifications: configure,
        }));
        const page = new EventTarget(); vi.stubGlobal('window', page); vi.stubGlobal('self', page);
        const runtime = {id: 'fixture', onMessage: {addListener: vi.fn()},
            sendMessage: (_value: unknown, callback: () => void) => {if (failure === 'send-throws') throw new Error('fixture'); callback();},
            get lastError() {if (failure === 'last-error-throws') throw new Error('fixture'); return undefined;}};
        vi.stubGlobal('chrome', {runtime});
        (await import('@/src/app/offscreen/runtime')).startOffscreenApp();
        const notify = configure.mock.calls[0][0] as (snapshot: unknown) => Promise<void>;
        await expect(notify(translationSnapshot())).resolves.toBeUndefined();
        page.dispatchEvent(new Event('pagehide'));
    });
});
