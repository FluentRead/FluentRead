import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {createSelectionTtsPlayer, type SelectionAudioPort} from '@/src/app/offscreen/ttsPlayback';
import {createBackgroundMessageRouter, type BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {createSelectionTtsBackgroundHandlers, type SelectionTtsContext} from '@/src/features/selection-translation/background/ttsHandler';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {createSelectionTtsContentController} from '@/src/features/selection-translation/content/selectionTtsContentController';
import {createAreaTranslationOffscreenAdapter} from '@/src/features/area-translation/background/offscreenAdapter';
import {createImageTranslationOffscreenAdapter} from '@/src/features/image-translation/background/offscreenAdapter';
import {createLocalTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';
import {createSelectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE,
    type OffscreenClient,
} from '@/src/platform/offscreen/client';

const send = vi.fn();
const sendIfPresent = vi.fn();
const client = {
    ensureDocument: vi.fn(async () => undefined),
    hasDocument: vi.fn(async () => false),
    send,
    sendIfPresent,
} as unknown as OffscreenClient;

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    setRuntimeFetch();
});

describe('area translation Offscreen adapter', () => {
    const adapter = createAreaTranslationOffscreenAdapter(client);
    const selection = {left: 1, top: 2, width: 3, height: 4, viewportWidth: 100, viewportHeight: 80};

    it('sends crop-only request and preserves metadata fields', async () => {
        send.mockResolvedValueOnce({success: true, image: 'crop', lines: [], recognitionMethod: 'vision'});
        await expect(adapter.cropArea('data:image/png,area', selection, {requestId: 'crop-1', signal: new AbortController().signal, timeoutMs: 5000}))
            .resolves.toEqual({image: 'crop', lines: []});
        expect(send).toHaveBeenCalledWith(expect.objectContaining({type: 'FLUENT_READ_AREA_CROP_OFFSCREEN', requestId: 'crop-1'}), expect.any(Object));
        send.mockResolvedValueOnce({success: true, image: 1, lines: []});
        await expect(adapter.cropArea('image', selection)).rejects.toThrow('圈选裁剪失败');
    });

    it('sends the complete feature payload and returns a validated result', async () => {
        send.mockResolvedValueOnce({success: true, image: 'translated-area', lines: [{text: 'line'}]});
        await expect(adapter.translateArea('data:image/png,area', 'en', 'Page', selection)).resolves.toEqual({
            image: 'translated-area',
            lines: [{text: 'line'}],
        });
        expect(send).toHaveBeenCalledWith({
            type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN',
            image: 'data:image/png,area',
            sourceLanguage: 'en',
            title: 'Page',
            selection,
        });
    });

    it('rejects failed and structurally invalid results with custom or fallback errors', async () => {
        send.mockResolvedValueOnce({success: false, error: 'area custom'});
        await expect(adapter.translateArea('image', 'en', '', selection)).rejects.toThrow('area custom');

        send.mockResolvedValueOnce({success: true, image: 1, lines: []});
        await expect(adapter.translateArea('image', 'en', '', selection)).rejects.toThrow('圈选翻译失败');

        send.mockResolvedValueOnce({success: true, image: 'image', lines: {}});
        await expect(adapter.translateArea('image', 'en', '', selection)).rejects.toThrow('圈选翻译失败');

        send.mockResolvedValueOnce(undefined);
        await expect(adapter.translateArea('image', 'en', '', selection)).rejects.toThrow('圈选翻译失败');
    });

    it('把圈选 requestId、取消信号与超时预算传给共享 Offscreen OCR 路由', async () => {
        const controller = new AbortController();
        send.mockResolvedValueOnce({success: true, image: 'translated-area', lines: []});

        await expect(adapter.translateArea('data:image/png,area', 'en', 'Page', selection, {
            requestId: 'area-1', signal: controller.signal, timeoutMs: 5_000,
        })).resolves.toEqual({image: 'translated-area', lines: []});
        expect(send).toHaveBeenCalledWith({
            type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN',
            image: 'data:image/png,area',
            sourceLanguage: 'en',
            title: 'Page',
            selection,
            requestId: 'area-1',
        }, {
            signal: controller.signal,
            timeoutMs: 5_000,
            cancelMessage: {
                type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
                requestId: 'area-1',
            },
        });
    });
});

describe('image translation Offscreen adapter', () => {
    const adapter = createImageTranslationOffscreenAdapter(client);
    it('仅普通图的非空文字结果可标记为保留宿主原图',async()=>{
        const lines=[{text:'你好',sourceText:'Hello',renderSkipped:true}];
        send.mockResolvedValueOnce({success:true,image:'',imageUnchanged:true,lines});
        await expect(adapter.translateImage('source','en','Page')).resolves.toEqual({image:'',imageUnchanged:true,lines});
        for (const response of [
            {success:true,image:'encoded',imageUnchanged:true,lines},
            {success:true,image:'',imageUnchanged:false,lines},
            {success:true,image:'',imageUnchanged:true,lines:[]},
            {success:true,image:'',imageUnchanged:true,lines,mangaPatches:{width:1,height:1,patches:[]}},
        ]) {send.mockResolvedValueOnce(response);await expect(adapter.translateImage('source','en','Page')).rejects.toThrow();}
        send.mockResolvedValueOnce({success:true,image:'',imageUnchanged:true,lines});
        await expect(adapter.translateImage('source','en','Page',{manga:true,requestId:'m',signal:new AbortController().signal,timeoutMs:1000})).rejects.toThrow();
    });
    it('单图识别选择透传到 Offscreen，不把普通图片变成漫画模式', async () => {
        send.mockResolvedValueOnce({success:true,image:'translated',lines:[]});
        await adapter.translateImage('source','ja','Page',{ocrEngine:'paddle',requestId:'single-paddle',signal:new AbortController().signal,timeoutMs:5000});
        expect(send).toHaveBeenCalledWith({type:'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',image:'source',sourceLanguage:'ja',title:'Page',ocrEngine:'paddle',requestId:'single-paddle'},expect.any(Object));
    });
    it('验证并透传漫画局部结果，拒绝非法图块',async()=>{
        const mangaPatches={width:100,height:100,patches:[{x:0,y:0,width:20,height:20,image:'data:image/png;base64,AQID'}]};
        for(const image of ['',undefined]){send.mockResolvedValueOnce({success:true,image,lines:[],mangaPatches});await expect(adapter.translateImage('source','en','Page')).resolves.toEqual({image:'',lines:[],mangaPatches});}
        send.mockResolvedValueOnce({success:true,lines:[],mangaPatches:null});await expect(adapter.translateImage('source','en','Page')).rejects.toThrow('无效');
    });
    it('校验漫画模型状态和清理结果，并把专用模式传到 Offscreen',async()=>{
        send.mockResolvedValueOnce({success:true,ready:true,bytes:123,inpaintingReady:false});
        expect(await adapter.getMangaModelStatus()).toEqual({ready:true,bytes:123,inpaintingReady:false});
        const download={assetId:'detector',receivedBytes:40,totalBytes:100};
        send.mockResolvedValueOnce({success:true,ready:false,bytes:0,inpaintingReady:false,source:'mirror',download});
        expect(await adapter.getMangaModelStatus()).toEqual({ready:false,bytes:0,inpaintingReady:false,source:'mirror',download});
        for(const response of [undefined,{success:true,ready:true,bytes:-1,inpaintingReady:false},{success:true,ready:true,bytes:0.5,inpaintingReady:false},
            {success:true,ready:true,bytes:0},{success:false,error:'bad cache'}]){
            send.mockResolvedValueOnce(response);await expect(adapter.getMangaModelStatus()).rejects.toThrow();
        }
        send.mockResolvedValueOnce({success:false});await expect(adapter.removeMangaModels()).rejects.toThrow('清除失败');
        send.mockResolvedValueOnce({success:true});await adapter.removeMangaModels();
        send.mockResolvedValueOnce({success:true,image:'translated',lines:[]});
        await adapter.translateImage('data:image/png,x','en','',{manga:true,requestId:'manga',signal:new AbortController().signal,timeoutMs:1000});
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({manga:true,type:'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN'}),expect.any(Object));
    });

    it('translates images and validates success, image and line fields independently', async () => {
        send.mockResolvedValueOnce({success: true, image: 'translated', lines: []});
        await expect(adapter.translateImage('data:image/png,image', 'en', 'Page')).resolves.toEqual({
            image: 'translated', lines: [],
        });
        expect(send).toHaveBeenCalledWith({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
            image: 'data:image/png,image',
            sourceLanguage: 'en',
            title: 'Page',
        });

        send.mockResolvedValueOnce({success:false,error:'local model not ready',errorCode:'notDownloaded'});
        await expect(adapter.translateImage('image','en','')).rejects.toMatchObject({errorCode:'notDownloaded'});
        send.mockResolvedValueOnce({success: false, error: 'translation custom'});
        await expect(adapter.translateImage('image', 'en', '')).rejects.toThrow('translation custom');
        send.mockResolvedValueOnce({success: true, image: null, lines: [], error: 1});
        await expect(adapter.translateImage('image', 'en', '')).rejects.toThrow('图片翻译失败');
        send.mockResolvedValueOnce({success: true, image: 'translated', lines: null});
        await expect(adapter.translateImage('image', 'en', '')).rejects.toThrow('图片翻译失败');
    });

    it('把跨域图片 URL 交给 Offscreen，并只接受 data:image 返回值', async () => {
        send.mockResolvedValueOnce({success: true, image: 'data:image/png;base64,remote'});
        await expect(adapter.fetchImage('https://pbs.twimg.com/media/demo.png')).resolves
            .toBe('data:image/png;base64,remote');
        expect(send).toHaveBeenCalledWith({
            type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
            url: 'https://pbs.twimg.com/media/demo.png',
        });

        send.mockResolvedValueOnce({success: true, image: 'not-data'});
        await expect(adapter.fetchImage('https://pbs.twimg.com/media/demo.png')).rejects.toThrow('远程图片读取失败');
        send.mockResolvedValueOnce({success: false, error: 'media custom'});
        await expect(adapter.fetchImage('https://pbs.twimg.com/media/demo.png')).rejects.toThrow('media custom');
    });

    it('把图片 requestId、取消信号与超时预算传给 Offscreen client', async () => {
        const controller = new AbortController();
        send
            .mockResolvedValueOnce({success: true, image: 'translated', lines: []})
            .mockResolvedValueOnce({success: true, image: 'data:image/png;base64,remote'});

        await expect(adapter.translateImage('data:image/png,image', 'en', 'Page', {
            requestId: 'image-1',
            signal: controller.signal,
            timeoutMs: 5_000,
        })).resolves.toEqual({image: 'translated', lines: []});
        expect(send).toHaveBeenNthCalledWith(1, {
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
            image: 'data:image/png,image',
            sourceLanguage: 'en',
            title: 'Page',
            requestId: 'image-1',
        }, {
            signal: controller.signal,
            timeoutMs: 5_000,
            cancelMessage: {
                type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
                requestId: 'image-1',
            },
        });

        await expect(adapter.fetchImage('https://pbs.twimg.com/media/demo.png', {
            requestId: 'fetch-1',
            signal: controller.signal,
            timeoutMs: 3_000,
        })).resolves.toBe('data:image/png;base64,remote');
        expect(send).toHaveBeenNthCalledWith(2, {
            type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
            url: 'https://pbs.twimg.com/media/demo.png',
            requestId: 'fetch-1',
        }, {
            signal: controller.signal,
            timeoutMs: 3_000,
            cancelMessage: {
                type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
                requestId: 'fetch-1',
            },
        });
    });

    it('downloads OCR languages and reports custom, empty and fallback failures', async () => {
        send.mockResolvedValueOnce({success: true});
        await expect(adapter.downloadLanguages(['eng', 'jpn'])).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN',
            languages: ['eng', 'jpn'],
        });

        send.mockResolvedValueOnce({success: false, error: 'download custom'});
        await expect(adapter.downloadLanguages(['eng'])).rejects.toThrow('download custom');
        send.mockResolvedValueOnce({success: false, error: ''});
        await expect(adapter.downloadLanguages(['eng'])).rejects.toThrow('图片 OCR 语言包下载失败');
        send.mockResolvedValueOnce(undefined);
        await expect(adapter.downloadLanguages(['eng'])).rejects.toThrow('图片 OCR 语言包下载失败');
    });
});

describe('selection TTS Offscreen adapter', () => {
    const preparePermit = () => {
        send.mockResolvedValueOnce({success: true, revision: 'revision', receiverId: 'receiver'})
            .mockResolvedValueOnce({success: true, playbackToken: 'permit'});
    };
    const adapter = createSelectionTtsOffscreenAdapter(client);

    it('fetches Google audio through the platform transport and preserves its response metadata', async () => {
        const transport = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {'content-type': 'audio/ogg'},
        }));
        const controller = new AbortController();
        setRuntimeFetch(transport);

        await expect(adapter.fetchPageAudio('https://example.test/audio', controller.signal)).resolves.toEqual({
            audio: new Uint8Array([1, 2, 3]).buffer,
            contentType: 'audio/ogg',
        });
        expect(transport).toHaveBeenCalledWith('https://example.test/audio', {signal: controller.signal});
    });

    it.each([
        {statusText: 'Service Unavailable', expected: 'Google TTS failed: 503 Service Unavailable'},
        {statusText: '', expected: 'Google TTS failed: 503'},
    ])('reports Google HTTP errors with or without a status label: $statusText', async ({statusText, expected}) => {
        setRuntimeFetch(async () => new Response('unavailable', {status: 503, statusText}));
        await expect(adapter.fetchPageAudio('https://example.test/audio', new AbortController().signal)).rejects.toThrow(expected);
    });

    it('cancels an unread Google error body before reporting the HTTP failure', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({cancel});
        setRuntimeFetch(async () => new Response(body, {status: 503}));
        await expect(adapter.fetchPageAudio('https://example.test/audio', new AbortController().signal)).rejects.toThrow('Google TTS failed: 503');
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('uses the MPEG content type when Google omits the response header', async () => {
        setRuntimeFetch(async () => new Response(new Uint8Array([7])));
        await expect(adapter.fetchPageAudio('https://example.test/audio', new AbortController().signal)).resolves.toMatchObject({
            contentType: 'audio/mpeg',
        });
    });

    it.each([
        {errorCode: 'selection-tts-permit-invalid', receiverId: 'receiver'},
        {errorCode: 'selection-tts-permit-invalid'},
        {errorCode: 'selection-tts-permit-invalid', receiverId: 1},
        {errorCode: 'different-error', receiverId: 'replacement'},
    ])('does not retry same-instance revocation or unverified playback failure %j', async failure => {
        preparePermit();
        send.mockResolvedValueOnce({success: false, error: 'revoked', ...failure});
        await expect(adapter.play({tabId: 7, clientRequestId: 'revoked', sourceUrl: 'https://example.test/audio'}))
            .rejects.toThrow('revoked');
        expect(send).toHaveBeenCalledTimes(3);
    });

    it('bounds repeated verified receiver replacement without accepting any old permit', async () => {
        for (let i = 0; i < 3; i++) {
            send.mockResolvedValueOnce({success: true, revision: `revision-${i}`, receiverId: `receiver-${i}`})
                .mockResolvedValueOnce({success: true, playbackToken: `permit-${i}`})
                .mockResolvedValueOnce({success: false, errorCode: 'selection-tts-permit-invalid', receiverId: `receiver-${i + 1}`});
        }
        await expect(adapter.play({tabId: 7, clientRequestId: 'replaced', sourceUrl: 'https://example.test/audio'}))
            .rejects.toThrow('语音播放未能启动，请重试');
        expect(send).toHaveBeenCalledTimes(9);
    });

    it.each([undefined, {success: false}, {success: false, error: 'read-error'},
        {success: true}, {success: true, revision: 1}, {success: true, revision: 'v', receiverId: 1}])('rejects malformed snapshot %j before reserving or sending audio', async response => {
        send.mockResolvedValueOnce(response);
        await expect(adapter.play({tabId: 7, clientRequestId: 'invalid-snapshot', sourceUrl: 'https://example.test/audio'})).rejects.toThrow();
        expect(send).toHaveBeenCalledOnce();
    });

    it.each([undefined, {success: false}, {success: false, error: 'reserve-error'},
        {success: true}, {success: true, playbackToken: 1}])('rejects malformed reservation %j without sending PLAY', async response => {
        send.mockResolvedValueOnce({success: true, revision: 'version', receiverId: 'receiver'}).mockResolvedValueOnce(response);
        await expect(adapter.play({tabId: 7, clientRequestId: 'invalid-reserve', sourceUrl: 'https://example.test/audio'})).rejects.toThrow();
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('retries a compare-and-swap conflict with the same local signal and stops after three conflicts', async () => {
        const controller = new AbortController(), route = {tabId: 7, clientRequestId: 'conflict'};
        send.mockResolvedValueOnce({success: true, revision: 'v1', receiverId: 'receiver'})
            .mockResolvedValueOnce({success: false, conflict: true})
            .mockResolvedValueOnce({success: true, revision: 'v2', receiverId: 'receiver'})
            .mockResolvedValueOnce({success: true, playbackToken: 'permit'})
            .mockResolvedValueOnce({success: true});
        await adapter.play({...route, sourceUrl: 'https://example.test/audio'}, controller.signal);
        for (const [message, options] of send.mock.calls) {
            expect(options.signal).toBe(controller.signal); expect(message).not.toHaveProperty('signal');
            expect(options.cancelMessage).toEqual({type: 'STOP_SELECTION_TTS', ...route});
        }
        send.mockClear();
        for (let i = 0; i < 3; i++) send.mockResolvedValueOnce({success: true, revision: `v${i}`, receiverId: 'receiver'})
            .mockResolvedValueOnce({success: false, conflict: true});
        await expect(adapter.play({...route, sourceUrl: 'https://example.test/audio'}, controller.signal)).rejects.toThrow('语音播放未能启动，请重试');
        expect(send).toHaveBeenCalledTimes(6);
    });

    it('does not start preparation or delivery for a pre-cancelled signal', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(adapter.play({tabId: 0, clientRequestId: 'cancelled', sourceUrl: 'https://example.test/audio'}, controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(send).not.toHaveBeenCalled();
    });

    it('seeks only an existing document and returns whether its current route accepted the jump', async () => {
        sendIfPresent.mockResolvedValueOnce({success:true,seeked:true});
        await expect(adapter.seek(route,5)).resolves.toBe(true);
        expect(sendIfPresent).toHaveBeenLastCalledWith({type:'SEEK_SELECTION_TTS',...route,offsetSeconds:5});
        for(const response of [undefined,{success:true},{success:true,seeked:false}]){
            sendIfPresent.mockResolvedValueOnce(response);await expect(adapter.seek(route,-5)).resolves.toBe(false);
        }
        sendIfPresent.mockResolvedValueOnce({success:false,error:'seek custom'});await expect(adapter.seek(route,5)).rejects.toThrow('seek custom');
        sendIfPresent.mockResolvedValueOnce({success:false});await expect(adapter.seek(route,5)).rejects.toThrow('语音跳转失败');
        expect(send).not.toHaveBeenCalled();
    });
    const route = {tabId: 7, clientRequestId: 'request-1'};

    it('plays audio/source payloads and rejects unsuccessful playback', async () => {
        preparePermit();
        send.mockResolvedValueOnce({success: true});
        await expect(adapter.play({...route, sourceUrl: 'https://example.test/audio'})).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith({
            type: 'PLAY_SELECTION_TTS',
            ...route,
            sourceUrl: 'https://example.test/audio', playbackToken: 'permit',
        }, {signal: undefined, cancelMessage: {type: 'STOP_SELECTION_TTS', ...route}});

        preparePermit();
        send.mockResolvedValueOnce({success: false, error: 'play custom'});
        await expect(adapter.play({...route, audioBase64: 'AA==', contentType: 'audio/mpeg'}))
            .rejects.toThrow('play custom');
        preparePermit();
        send.mockResolvedValueOnce(undefined);
        await expect(adapter.play({...route, audioBase64: 'AA==', contentType: 'audio/mpeg'}))
            .rejects.toThrow('Offscreen TTS 播放失败');
    });

    it('uses optional delivery for stop and accepts missing or successful documents', async () => {
        sendIfPresent.mockResolvedValueOnce(undefined);
        await expect(adapter.stop(route)).resolves.toBeUndefined();
        expect(sendIfPresent).toHaveBeenCalledWith({type: 'STOP_SELECTION_TTS', ...route});

        sendIfPresent.mockResolvedValueOnce({success: true});
        await expect(adapter.stop(route)).resolves.toBeUndefined();

        sendIfPresent.mockResolvedValueOnce({success: false, error: 'stop custom'});
        await expect(adapter.stop(route)).rejects.toThrow('stop custom');
        sendIfPresent.mockResolvedValueOnce({success: false});
        await expect(adapter.stop(route)).rejects.toThrow('Offscreen TTS 停止失败');
    });

    it('forwards text and timings without mutation for both generated audio and legacy URL playback', async () => {
        const timings = [{startChar: 0, endChar: 5, startTime: 0, endTime: 1}];
        for (const payload of [
            {...route, audioBase64: 'AA==', contentType: 'audio/wav' as const, text: 'Hello', timings},
            {...route, sourceUrl: 'https://example.test/audio', text: 'Hello'},
        ]) {
            preparePermit(); send.mockResolvedValueOnce({success: true});
            await adapter.play(payload);
            expect(send).toHaveBeenLastCalledWith({type: 'PLAY_SELECTION_TTS', ...payload, playbackToken: 'permit'},
                {signal: undefined, cancelMessage: {type: 'STOP_SELECTION_TTS', ...route}});
        }
        expect(timings).toEqual([{startChar: 0, endChar: 5, startTime: 0, endTime: 1}]);
    });
});

describe('local TTS Offscreen adapter', () => {
    const adapter = createLocalTtsOffscreenAdapter(client);

    it('decodes Base64 audio returned across the runtime message boundary', async () => {
        const controller = new AbortController();
        send.mockResolvedValueOnce({
            success: true,
            audioBase64: 'UklG',
            contentType: 'audio/wav' as const,
            voice: 'zf_001',
            backend: 'wasm',
        });

        await expect(adapter.synthesize('你好', 'zh-CN', 'zf_001', controller.signal)).resolves.toEqual({
            audio: new Uint8Array([82, 73, 70, 70]).buffer,
            contentType: 'audio/wav' as const,
            voice: 'zf_001',
            backend: 'wasm',
        });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            type: 'LOCAL_TTS_SYNTHESIZE',
            text: '你好',
            language: 'zh-CN',
            voice: 'zf_001',
            requestId: expect.any(String),
        }), expect.objectContaining({
            signal: controller.signal,
            timeoutMs: 120_000,
            cancelMessage: {
                type: OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE,
                requestId: expect.any(String),
            },
        }));
    });

    it('rejects missing or unsuccessful local audio responses', async () => {
        send.mockResolvedValueOnce({success: false, error: 'local custom'});
        await expect(adapter.synthesize('hello', 'en-US', 'af_maple')).rejects.toThrow('local custom');

        send.mockResolvedValueOnce({success: true, audioBase64: ''});
        await expect(adapter.synthesize('hello', 'en-US', 'af_maple')).rejects.toThrow('Offscreen LOCAL_TTS_SYNTHESIZE响应消息格式无效');
    });
});

it('OCR 清除经离屏端确认且透传失败', async () => {
 const adapter=createImageTranslationOffscreenAdapter(client);
 send.mockResolvedValueOnce({success:true}); await adapter.removeLanguages(['eng']);
 expect(send).toHaveBeenCalledWith({type:'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN',languages:['eng']});
 send.mockResolvedValueOnce({success:false,error:'busy'}); await expect(adapter.removeLanguages(['eng'])).rejects.toThrow('busy');
});

describe('TTS metadata across local synthesis, adapters and routed playback', () => {
    let player: ReturnType<typeof createSelectionTtsPlayer> | undefined;
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { player?.dispose(); player = undefined; vi.useRealTimers(); });
    const timings = [
        {startChar: 0, endChar: 5, startTime: 0, endTime: 1},
        {startChar: 6, endChar: 11, startTime: 1, endTime: 5},
    ];

    it.each([
        ['timed', {timings}, timings], ['legacy', {}, undefined], ['invalid', {timings: [{...timings[0], endTime: 0}]}, []],
    ])('plays %s local metadata through the actual cross-layer path and keeps progress cancellable', async (kind, metadata, expectedTimings) => {
        const audios: Array<SelectionAudioPort & {currentTime: number; duration: number}> = [];
        const messages: Record<string, unknown>[] = [];
        const received: unknown[] = [];
        const controller = createSelectionTtsContentController({
            createClientRequestId: () => 'flow-client', stopRemote: vi.fn(async () => undefined),
        });
        const request = controller.beginRemoteRequest();
        const notify = (audioRequest: {tabId: number; clientRequestId: string}, state: string, progress?: unknown) => {
            void background.dispatch({type: 'selectionTtsPlaybackState', ...audioRequest, state, progress}, {});
        };
        player = createSelectionTtsPlayer({
            createAudio: () => {
                const audio = {currentTime: 0, duration: 5, preload: '', src: '', onended: null, onerror: null,
                    play: vi.fn(async () => undefined), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn()};
                audios.push(audio);
                return audio;
            },
            decodeBase64: value => Uint8Array.from(atob(value), char => char.charCodeAt(0)),
            createObjectUrl: () => 'blob:cross-layer', revokeObjectUrl: vi.fn(),
            notify: (audioRequest, state) => notify(audioRequest, state),
            notifyProgress: (audioRequest, progress) => notify(audioRequest, 'progress', progress),
        });
        const synthesizeLocal = vi.fn(async () => ({
            audio: new Uint8Array([82, 73, 70, 70]).buffer, contentType: 'audio/wav' as const, voice: 'zf_001', ...(metadata as object),
        }));
        const offscreen = createOffscreenMessageListener({
            ttsPlayer: player, translate: vi.fn(), fetchImage: vi.fn(), translateImage: vi.fn(), translateArea: vi.fn(), downloadOcrLanguages: vi.fn(),
            localTts: {synthesize: synthesizeLocal, prepare: vi.fn(), status: vi.fn(), removeModel: vi.fn()},
        });
        const routeMessage = async (message: Record<string, unknown>) => {
            messages.push(message);
            return new Promise(resolve => expect(offscreen({...message, target: 'offscreen'}, {}, resolve)).toBe(true));
        };
        const localClient = {send: vi.fn(routeMessage), sendIfPresent: vi.fn(routeMessage)} as unknown as OffscreenClient;
        const local = createLocalTtsOffscreenAdapter(localClient);
        const playback = createSelectionTtsOffscreenAdapter(localClient);
        const synthesize = createSelectionTtsSynthesizer({
            getMode: () => 'local-only', getLocalVoice: () => 'zf_001', getOnlineVoices: () => [],
            synthesizeLocal: local.synthesize, synthesizeOnline: vi.fn(),
        });
        const background = createBackgroundMessageRouter<SelectionTtsContext>(createSelectionTtsBackgroundHandlers({
            getPreferredVoices: () => [], synthesize, playWithOffscreen: playback.play, stopWithOffscreen: playback.stop, seekWithOffscreen: playback.seek,
            sendTabMessage: vi.fn(async (tabId, message) => {
                expect(tabId).toBe(0);
                expect(controller.matchRemoteState(message)).not.toBeNull();
                received.push(message);
            }),
        }) as Array<BackgroundMessageHandler<SelectionTtsContext>>);
        const result = await background.dispatch({type: 'selectionTts', text: ' Hello world ', language: 'en-US', clientRequestId: request.clientRequestId}, {sender: {tab: {id: 0}}});
        if (!result.handled) throw new Error('Expected selection TTS to be handled by the background router');
        expect(result.response).toEqual({success: true, transport: 'offscreen', voice: 'zf_001'});
        expect(controller.completeRemoteRequest(request, result.response as {success: boolean; transport: string})).toBe('offscreen');
        expect(messages.find(message => message.type === 'PLAY_SELECTION_TTS')).toEqual({
            type: 'PLAY_SELECTION_TTS', playbackToken: expect.any(String), audioBase64: 'UklGRg==', contentType: 'audio/wav' as const, text: 'Hello world', tabId: 0, clientRequestId: request.clientRequestId,
            ...(expectedTimings === undefined ? {} : {timings: expectedTimings}),
        });
        expect(synthesizeLocal).toHaveBeenCalledWith(expect.objectContaining({text: 'Hello world', language: 'en-US', voice: 'zf_001'}), expect.any(AbortSignal));
        audios[0].currentTime = 3;
        await vi.advanceTimersByTimeAsync(100);
        const progress = (received.at(-1) as {progress: {start: number; end: number; fraction: number; estimated: boolean}}).progress;
        expect(progress).toMatchObject({start: 6, end: 11, estimated: true});
        expect(progress.fraction).toBeCloseTo(kind === 'timed' ? 0.5 : 0.12);
        expect(controller.getState().activeClientRequestId).toBe(request.clientRequestId);
        await background.dispatch({type: 'selectionTtsStop', clientRequestId: request.clientRequestId}, {sender: {tab: {id: 0}}});
        expect(messages.at(-1)).toEqual({type: 'STOP_SELECTION_TTS', tabId: 0, clientRequestId: request.clientRequestId});
        expect(audios[0].pause).toHaveBeenCalledOnce();
        expect(received.at(-1)).toMatchObject({state: 'stopped', clientRequestId: request.clientRequestId});
        expect(vi.getTimerCount()).toBe(0);
    });
});
