import {parseHTML} from 'linkedom';
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
        ttsPlayer: {play: vi.fn(async () => undefined), stop: vi.fn()},
        recognizeImage: vi.fn(async () => [{text: 'hello'}]),
        fetchImage: vi.fn(async () => 'data:image/png;base64,AA=='),
        translateImage: vi.fn(async () => ({image: 'data:image/png;base64,AA==', lines: []})),
        translateArea: vi.fn(async () => ({image: 'data:image/png;base64,AA==', lines: []})),
        downloadOcrLanguages: vi.fn(async () => undefined),
        videoAi: {
            transcribe: vi.fn(async () => ({text: 'hello', cues: []})),
            prepare: vi.fn(async () => ({ready: true})),
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
    vi.resetModules();
});

describe('Firefox shared DOM runtime', () => {
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
        await expect(image.recognizeImage('data:image/png;base64,AA==', 'en')).resolves.toEqual([{text: 'hello'}]);
        await expect(image.translateImage('data:image/png;base64,AA==', 'en', 'image')).resolves.toMatchObject({lines: []});
        const selection = {left: 0, top: 0, width: 20, height: 20, viewportWidth: 100, viewportHeight: 100};
        await expect(area.translateArea('data:image/png;base64,AA==', 'en', 'area', selection)).resolves.toMatchObject({lines: []});
        await tts.play({audioBase64: 'AA==', contentType: 'audio/wav', tabId: 7, clientRequestId: 'tts-a'});
        await tts.stop({tabId: 7, clientRequestId: 'tts-a'});
        await expect(client.send({type: 'VIDEO_AI_PREPARE', model: 'whisper-tiny'})).resolves.toMatchObject({ready: true});
        await expect(client.send({type: 'VIDEO_AI_TRANSCRIBE', streamId: 'stream-a'})).resolves.toMatchObject({text: 'hello'});
        await client.sendIfPresent({type: 'VIDEO_AI_CANCEL', streamId: 'stream-a'});
        expect(dependencies.recognizeImage).toHaveBeenCalledOnce();
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
        vi.stubGlobal('chrome', {runtime: {
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
        const send = (message: Record<string, unknown>) => new Promise(resolve => {
            listener({target: 'offscreen', ...message}, {}, resolve);
        });
        const route = {tabId: 7, clientRequestId: 'firefox-audio'};
        const play = {type: 'PLAY_SELECTION_TTS', audioBase64: 'AA==', contentType: 'audio/wav', ...route};
        await expect(send(play)).resolves.toEqual({success: true});
        expect(() => audios[0].onended()).not.toThrow();
        await expect(send(play)).resolves.toEqual({success: true});
        await expect(send({type: 'STOP_SELECTION_TTS', ...route})).resolves.toEqual({success: true});
        expect(audios[1].pause).toHaveBeenCalledOnce();
        expect(notifications).toEqual([
            expect.objectContaining({...route, state: 'ended'}),
            expect.objectContaining({...route, state: 'stopped'}),
        ]);
        expect(readLastError).toHaveBeenCalledTimes(2);
    });
});
