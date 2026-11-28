/**
 * @file tests/videoLocalMediaTranscription.test.ts
 * 文件职责：验证本地音视频导入校验、Web Audio 16 kHz PCM 解码切片、离线 Whisper/Qwen3 转写会话、并发翻译及多格式导出。
 * 主要内容：覆盖 mediaValidation、audioDecoder 与 transcriptionService 全部正常与异常分支，验证取消信号释放后台推理流、防迟到回写、失败补译以及 SRT/WebVTT/Markdown 导出契约。
 * 模块边界：仅注入解码、消息传输与翻译端口，不依赖真实浏览器音频硬件或远程翻译接口。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    classifyLocalMediaKind,
    formatMediaBytes,
    formatMediaTimestamp,
    MAX_LOCAL_MEDIA_DURATION_SECONDS,
    MAX_LOCAL_MEDIA_FILE_BYTES,
    validateLocalMediaFile,
} from '@/src/features/video-subtitle/local-media/mediaValidation';
import {
    decodeLocalMediaToPcm16k,
    sliceLocalMediaWindows,
} from '@/src/features/video-subtitle/local-media/audioDecoder';
import {
    buildLocalMediaExport,
    LocalMediaTranscriptionSession,
    type LocalMediaSessionSnapshot,
} from '@/src/features/video-subtitle/local-media/transcriptionService';
import {VIDEO_AI_SAMPLE_RATE} from '@/src/features/video-subtitle/content/video-ai/audioWindow';

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeSpeechPcm(seconds: number, sampleRate = VIDEO_AI_SAMPLE_RATE): Float32Array {
    const length = Math.round(seconds * sampleRate);
    const pcm = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
        pcm[i] = Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 0.25;
    }
    return pcm;
}

function makeAudioBuffer(pcm: Float32Array, sampleRate = VIDEO_AI_SAMPLE_RATE, channels = 1, durationOverride?: number): AudioBuffer {
    const duration = durationOverride ?? pcm.length / sampleRate;
    return {
        duration,
        length: pcm.length,
        numberOfChannels: channels,
        sampleRate,
        getChannelData: () => pcm,
    } as unknown as AudioBuffer;
}

describe('本地音视频格式校验与格式化', () => {
    it('校验支持的音视频扩展名、MIME、空文件与体积上限', () => {
        expect(classifyLocalMediaKind({name: 'talk.MP4', type: 'video/mp4'})).toBe('video');
        expect(classifyLocalMediaKind({name: 'clip.webm', type: 'audio/webm'})).toBe('audio');
        expect(classifyLocalMediaKind({name: 'podcast.m4a', type: ''})).toBe('audio');
        expect(classifyLocalMediaKind({name: 'noext', type: 'audio/flac; codecs=flac'})).toBe('audio');
        expect(classifyLocalMediaKind({name: 'noext', type: 'text/plain'})).toBeNull();
        expect(classifyLocalMediaKind({name: 'doc.pdf', type: 'application/pdf'})).toBeNull();

        expect(validateLocalMediaFile({name: 'a.mp3', type: 'audio/mpeg', size: 0})).toEqual({
            ok: false,
            code: 'empty',
            maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES,
        });
        expect(validateLocalMediaFile({name: 'a.mp3', type: 'audio/mpeg', size: MAX_LOCAL_MEDIA_FILE_BYTES + 1})).toEqual({
            ok: false,
            code: 'tooLarge',
            maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES,
        });
        expect(validateLocalMediaFile({name: 'a.txt', type: 'text/plain', size: 12})).toEqual({
            ok: false,
            code: 'unsupportedFormat',
            maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES,
        });
        expect(validateLocalMediaFile({name: 'lecture.flac', type: '', size: 1024})).toEqual({
            ok: true,
            kind: 'audio',
            extension: '.flac',
            baseName: 'lecture',
        });
        expect(validateLocalMediaFile({name: 'untitled', type: 'audio/ogg', size: 2048})).toEqual({
            ok: true,
            kind: 'audio',
            extension: '',
            baseName: 'untitled',
        });
        expect(validateLocalMediaFile({name: '   ', type: 'audio/wav', size: 64})).toEqual({
            ok: true,
            kind: 'audio',
            extension: '',
            baseName: 'local-media',
        });
    });

    it('正确格式化字节大小与时间戳', () => {
        expect(formatMediaBytes(0)).toBe('0 B');
        expect(formatMediaBytes(NaN)).toBe('0 B');
        expect(formatMediaBytes(512)).toBe('512 B');
        expect(formatMediaBytes(2048)).toBe('2.0 KB');
        expect(formatMediaBytes(5 * 1024 * 1024)).toBe('5.0 MB');

        expect(formatMediaTimestamp(-100)).toBe('00:00');
        expect(formatMediaTimestamp(NaN)).toBe('00:00');
        expect(formatMediaTimestamp(65_000)).toBe('01:05');
        expect(formatMediaTimestamp(3_661_000)).toBe('1:01:01');
    });
});

describe('本地音视频 Web Audio 解码与窗口切片', () => {
    it('支持默认 Web Audio、webkitAudioContext、降采样与取消清理', async () => {
        const speech = makeSpeechPcm(2, 16_000);
        const close = vi.fn(async () => { throw new Error('close ignored'); });
        const decodeAudioData = vi.fn(async () => makeAudioBuffer(speech, 16_000, 1));
        vi.stubGlobal('AudioContext', class {
            state = 'running';
            decodeAudioData = decodeAudioData;
            close = close;
        });

        const file = {arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer};
        const result = await decodeLocalMediaToPcm16k(file, new AbortController().signal);
        expect(result.durationMs).toBe(2000);
        expect(result.pcm.length).toBe(speech.length);
        expect(close).toHaveBeenCalledOnce();

        // 立体声 48 kHz 重采样为 16 kHz 单声道，且处理已关闭上下文和 webkitAudioContext 回退
        const stereo = makeSpeechPcm(1, 48_000);
        vi.stubGlobal('AudioContext', undefined);
        vi.stubGlobal('webkitAudioContext', class {
            state = 'closed';
            decodeAudioData = async () => makeAudioBuffer(stereo, 48_000, 2);
            close = vi.fn();
        });
        const resampled = await decodeLocalMediaToPcm16k(file, new AbortController().signal);
        expect(resampled.durationMs).toBe(1000);
        expect(resampled.pcm.length).toBe(16_000);

        // 浏览器缺少 AudioContext 时报错
        vi.stubGlobal('webkitAudioContext', undefined);
        await expect(decodeLocalMediaToPcm16k(file, new AbortController().signal)).rejects.toThrow('Web Audio');
    });

    it('拒绝空字节、异常时长、超 20 分钟、无声道、静音及各阶段取消', async () => {
        const preAborted = new AbortController();
        preAborted.abort(new Error('already aborted'));
        await expect(decodeLocalMediaToPcm16k({arrayBuffer: async () => new ArrayBuffer(4)}, preAborted.signal)).rejects.toThrow('already aborted');

        const midRead = new AbortController();
        await expect(decodeLocalMediaToPcm16k({
            arrayBuffer: async () => {
                midRead.abort('plain-reason');
                return new ArrayBuffer(4);
            },
        }, midRead.signal)).rejects.toMatchObject({name: 'AbortError'});

        await expect(decodeLocalMediaToPcm16k({arrayBuffer: async () => new ArrayBuffer(0)}, new AbortController().signal)).rejects.toThrow('为空');

        const midDecode = new AbortController();
        let decodeStarted!: () => void;
        const decodeStartedPromise = new Promise<void>(resolve => { decodeStarted = resolve; });
        const pendingDecode = decodeLocalMediaToPcm16k(
            {arrayBuffer: async () => new ArrayBuffer(8)},
            midDecode.signal,
            {
                decodeAudioData: () => {
                    decodeStarted();
                    return new Promise<AudioBuffer>(() => undefined);
                },
            },
        );
        await decodeStartedPromise;
        midDecode.abort();
        await expect(pendingDecode).rejects.toMatchObject({name: 'AbortError'});

        const postDecodeAbort = new AbortController();
        await expect(decodeLocalMediaToPcm16k(
            {arrayBuffer: async () => new ArrayBuffer(8)},
            postDecodeAbort.signal,
            {
                decodeAudioData: async () => {
                    const fakeSignal = postDecodeAbort.signal;
                    Object.defineProperty(fakeSignal, 'aborted', {value: true, configurable: true});
                    return makeAudioBuffer(makeSpeechPcm(1));
                },
            },
        )).rejects.toMatchObject({name: 'AbortError'});

        const file = {arrayBuffer: async () => new ArrayBuffer(8)};
        await expect(decodeLocalMediaToPcm16k(file, new AbortController().signal, {
            decodeAudioData: async () => makeAudioBuffer(makeSpeechPcm(1), 16_000, 1, 0),
        })).rejects.toThrow('音频轨');

        await expect(decodeLocalMediaToPcm16k(file, new AbortController().signal, {
            decodeAudioData: async () => makeAudioBuffer(makeSpeechPcm(1), 16_000, 1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1),
        })).rejects.toThrow('20 分钟');

        await expect(decodeLocalMediaToPcm16k(file, new AbortController().signal, {
            decodeAudioData: async () => makeAudioBuffer(makeSpeechPcm(1), 16_000, 0, 2),
        })).rejects.toThrow('声道');

        await expect(decodeLocalMediaToPcm16k(file, new AbortController().signal, {
            decodeAudioData: async () => makeAudioBuffer(new Float32Array(16_000), 16_000, 1, 1),
        })).rejects.toThrow('有效语音');
    });

    it('按模型窗口长度切片，处理静音段、停顿边界与短尾窗口', () => {
        expect(sliceLocalMediaWindows(new Float32Array(), 'small')).toEqual([]);

        // 15 秒语音：tiny 10 秒窗切 2 段，small 14 秒窗切 2 段
        const continuous = makeSpeechPcm(15);
        expect(sliceLocalMediaWindows(continuous, 'tiny').length).toBeGreaterThanOrEqual(2);
        expect(sliceLocalMediaWindows(continuous, 'small').length).toBeGreaterThanOrEqual(2);

        // 含长停顿的 15 秒语音：命中停顿边界并产生 overlapMs = 0 的下一段
        const withPause = new Float32Array(15 * VIDEO_AI_SAMPLE_RATE);
        withPause.set(makeSpeechPcm(7), 0);
        withPause.set(makeSpeechPcm(5), 9 * VIDEO_AI_SAMPLE_RATE);
        const pausedWindows = sliceLocalMediaWindows(withPause, 'tiny');
        expect(pausedWindows.length).toBeGreaterThanOrEqual(2);
        expect(pausedWindows.some(w => w.overlapMs === 0)).toBe(true);

        // 全静音窗被跳过，仅保留尾部有效语音窗
        const leadingSilence = new Float32Array(10.5 * VIDEO_AI_SAMPLE_RATE);
        leadingSilence.set(makeSpeechPcm(0.4), 10 * VIDEO_AI_SAMPLE_RATE);
        const tailOnly = sliceLocalMediaWindows(leadingSilence, 'tiny');
        expect(tailOnly.length).toBe(1);

        // 末尾纯静音尾窗被跳过
        const trailingSilence = new Float32Array(11 * VIDEO_AI_SAMPLE_RATE);
        trailingSilence.set(makeSpeechPcm(5), 0);
        const noSilentTail = sliceLocalMediaWindows(trailingSilence, 'tiny');
        expect(noSilentTail.length).toBe(1);
    });
});

describe('本地音视频离线转写与导出会话', () => {
    function createSessionFixture(overrides: Partial<{
        provider: 'browser' | 'native-qwen';
        model: 'tiny' | 'base' | 'small';
        target: string;
        pcmSeconds: number;
    }> = {}) {
        const snapshots: LocalMediaSessionSnapshot[] = [];
        const speech = makeSpeechPcm(overrides.pcmSeconds ?? 5);
        const send = vi.fn<(msg: unknown) => Promise<unknown>>(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return {success: true, models: ['small', 'tiny'], available: {tiny: true, base: false, small: true}};
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return {
                    success: true,
                    text: 'This is a complete English sentence for testing subtitles. And here is another full English sentence.',
                    segments: [
                        {startMs: 0, endMs: 1400, text: 'This is a complete English sentence for testing subtitles.'},
                        {startMs: 2800, endMs: 4600, text: 'And here is another full English sentence.'},
                    ],
                };
            }
            return {success: true};
        });
        const translate = vi.fn(async (text: string) => `译:${text}`);
        const session = new LocalMediaTranscriptionSession({
            send,
            translate,
            getModel: () => overrides.model ?? 'small',
            getSourceLanguage: () => 'en',
            getTargetLanguage: () => overrides.target ?? 'zh-Hans',
            getProvider: () => overrides.provider ?? 'browser',
            getNativeBaseUrl: () => 'http://127.0.0.1:8000',
            decode: {decodeAudioData: async () => makeAudioBuffer(speech)},
            onUpdate: snap => snapshots.push(snap),
        });
        const file = {arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer};
        return {session, send, translate, snapshots, file};
    }

    it('完成 Whisper 离线转写、并发翻译、目标语言跳过及多格式导出', async () => {
        const f = createSessionFixture();
        const ok = await f.session.transcribe(f.file, true);
        expect(ok).toBe(true);
        const final = f.session.getSnapshot();
        expect(final.phase).toBe('ready');
        expect(final.totalCues).toBe(2);
        expect(final.translatedCount).toBe(2);
        expect(final.cues[0].translation).toBe('译:This is a complete English sentence for testing subtitles.');
        expect(f.send).toHaveBeenCalledWith(expect.objectContaining({
            type: 'fluentReadCancelLocalVideoTranscription',
            reason: 'complete',
        }));

        // 测试 buildLocalMediaExport 的三种模式与三种格式
        const bilingualSrt = buildLocalMediaExport('My Talk (1)', final.cues, 'bilingual', 'srt');
        expect(bilingualSrt.filename).toBe('My Talk (1)-bilingual.srt');
        expect(bilingualSrt.text).toContain('This is a complete English sentence for testing subtitles.\n译:This is a complete English sentence for testing subtitles.');

        const origVtt = buildLocalMediaExport('My Talk', final.cues, 'original', 'vtt');
        expect(origVtt.filename).toBe('My Talk-original.vtt');
        expect(origVtt.text).toContain('WEBVTT');

        const transMd = buildLocalMediaExport('My Talk', [
            ...final.cues,
            {startMs: 4000, durationMs: 1000, text: 'Same', translation: 'Same'},
            {startMs: 5000, durationMs: 1000, text: 'Missing'},
        ], 'translated', 'md');
        expect(transMd.filename).toBe('My Talk-translated.md');
        expect(transMd.text).not.toContain('Missing');

        const dedupBilingual = buildLocalMediaExport('Dedup', [{startMs: 0, durationMs: 1000, text: '中文', translation: '中文'}], 'bilingual', 'srt');
        expect(dedupBilingual.text).not.toContain('中文\n中文');
    });

    it('支持本机 Qwen3 ASR、多窗重置与仅原文模式，并可后续补译与失败重试', async () => {
        const withPause = new Float32Array(15 * VIDEO_AI_SAMPLE_RATE);
        withPause.set(makeSpeechPcm(7), 0);
        withPause.set(makeSpeechPcm(5), 9 * VIDEO_AI_SAMPLE_RATE);

        const f = createSessionFixture({provider: 'native-qwen', model: 'tiny'});
        let call = 0;
        f.send.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                call += 1;
                return {
                    success: true,
                    text: call === 1 ? 'Window one first. Window one second.' : 'Window two final.',
                    segments: call === 1
                        ? [
                            {startMs: 0, endMs: 1800, text: 'Window one first.'},
                            {startMs: 2200, endMs: 4200, text: 'Window one second.'},
                        ]
                        : [{startMs: 0, endMs: 2500, text: 'Window two final.'}],
                };
            }
            return {success: true};
        });
        const session = new LocalMediaTranscriptionSession({
            send: f.send,
            translate: vi.fn()
                .mockRejectedValueOnce(new Error('rate limit'))
                .mockRejectedValueOnce('plain failure')
                .mockResolvedValue('补译完成'),
            getModel: () => 'tiny',
            getSourceLanguage: () => 'en',
            getTargetLanguage: () => 'zh-Hans',
            getProvider: () => 'native-qwen',
            getNativeBaseUrl: () => 'http://127.0.0.1:8000',
            decode: {decodeAudioData: async () => makeAudioBuffer(withPause)},
            onUpdate: snap => f.snapshots.push(snap),
        });

        expect(await session.transcribe(f.file, false)).toBe(true);
        expect(session.getSnapshot().translatedCount).toBe(0);

        // 首次补译遇到错误，记录失败计数；再次补译全部成功
        expect(await session.translatePending()).toBe(true);
        expect(session.getSnapshot().failedTranslationCount).toBeGreaterThan(0);

        expect(await session.translatePending()).toBe(true);
        expect(session.getSnapshot().failedTranslationCount).toBe(0);
        expect(session.getSnapshot().translatedCount).toBe(session.getSnapshot().totalCues);

        // 全部已译时再调 translatePending 直接完成
        expect(await session.translatePending()).toBe(true);
    });

    it('跳过目标语言字幕翻译、拦截未下载模型/空识别/后台错误/被跳过请求', async () => {
        const sameLang = createSessionFixture({target: 'en'});
        expect(await sameLang.session.transcribe(sameLang.file, true)).toBe(true);
        expect(sameLang.translate).not.toHaveBeenCalled();

        // 未下载所选模型
        const missingModel = createSessionFixture({model: 'base'});
        expect(await missingModel.session.transcribe(missingModel.file, true)).toBe(false);
        expect(missingModel.session.getSnapshot().phase).toBe('error');
        expect(missingModel.session.getSnapshot().error).toContain('Whisper');

        // 后台返回失败
        const failed = createSessionFixture();
        failed.send.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') return {success: false, error: ''};
            return {success: true};
        });
        expect(await failed.session.transcribe(failed.file, true)).toBe(false);
        expect(failed.session.getSnapshot().error).toContain('离线识别失败');

        // 后台返回 skipped
        const skipped = createSessionFixture();
        skipped.send.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') return {success: true, text: '', skipped: true};
            return {success: true};
        });
        expect(await skipped.session.transcribe(skipped.file, true)).toBe(false);
        expect(skipped.session.getSnapshot().error).toContain('打断');

        // 空字幕
        const empty = createSessionFixture();
        empty.send.mockImplementation(async (msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') return {success: true, text: '   ', segments: []};
            return {success: true};
        });
        expect(await empty.session.transcribe(empty.file, true)).toBe(false);
        expect(empty.session.getSnapshot().error).toContain('未识别出可读字幕');

        // 非 Error 异常走默认文案
        const nonError = createSessionFixture();
        nonError.send.mockImplementationOnce(async () => ({success: true, models: ['small'], available: {tiny: false, base: false, small: true}}));
        nonError.send.mockRejectedValueOnce('network down');
        expect(await nonError.session.transcribe(nonError.file, true)).toBe(false);
        expect(nonError.session.getSnapshot().error).toBe('本地音视频转写失败');
    });

    it('取消、重置与销毁均中止在途任务并拒绝迟到回写', async () => {
        const f = createSessionFixture();
        expect(await f.session.translatePending()).toBe(false);

        let resolveTranscribe!: (v: unknown) => void;
        f.send.mockImplementation((msg: unknown) => {
            const payload = msg as {type: string};
            if (payload.type === 'fluentReadGetLocalVideoModelState') {
                return Promise.resolve({success: true, models: ['small'], available: {tiny: false, base: false, small: true}});
            }
            if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                return new Promise(resolve => { resolveTranscribe = resolve; });
            }
            return Promise.reject(new Error('cancel message failed'));
        });

        const running = f.session.transcribe(f.file, true);
        await vi.waitFor(() => expect(resolveTranscribe).toBeTypeOf('function'));
        f.session.cancel();
        expect(f.session.getSnapshot().phase).toBe('idle');
        resolveTranscribe({success: true, text: 'Late text'});
        expect(await running).toBe(false);

        // 在检查模型阶段被取消
        let resolveModel!: (v: unknown) => void;
        f.send.mockImplementationOnce(() => new Promise(resolve => { resolveModel = resolve; }));
        const checking = f.session.transcribe(f.file, true);
        await vi.waitFor(() => expect(resolveModel).toBeTypeOf('function'));
        f.session.reset();
        resolveModel({success: true, models: ['small'], available: {tiny: false, base: false, small: true}});
        expect(await checking).toBe(false);

        // 在翻译阶段被取消（保留已有原文字幕并恢复 ready）
        const f2 = createSessionFixture();
        const resolvers: Array<(v: string) => void> = [];
        f2.translate.mockImplementation(() => new Promise<string>(resolve => { resolvers.push(resolve); }));
        const translating = f2.session.transcribe(f2.file, true);
        await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
        f2.session.cancel();
        expect(f2.session.getSnapshot().phase).toBe('ready');
        resolvers.splice(0).forEach(resolve => resolve('late translation'));
        expect(await translating).toBe(false);

        // 在独立 translatePending 期间被取消并拒绝 AbortError
        const rejectors: Array<(reason: unknown) => void> = [];
        f2.translate.mockImplementation(() => new Promise<string>((_res, rej) => { rejectors.push(rej); }));
        const pendingRetry = f2.session.translatePending();
        await vi.waitFor(() => expect(rejectors.length).toBeGreaterThan(0));
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        f2.session.cancel();
        rejectors.splice(0).forEach(reject => reject(abortErr));
        expect(await pendingRetry).toBe(false);

        // 在解码阶段被取消（触发 AbortError 捕获分支）
        let startDecode!: () => void;
        const decodeStarted = new Promise<void>(resolve => { startDecode = resolve; });
        const fDecodeAbort = new LocalMediaTranscriptionSession({
            send: async () => ({success: true, models: ['small'], available: {tiny: false, base: false, small: true}}),
            translate: async text => text,
            getModel: () => 'small',
            getSourceLanguage: () => 'en',
            getTargetLanguage: () => 'zh-Hans',
            getProvider: () => 'browser',
            getNativeBaseUrl: () => 'http://127.0.0.1:8000',
            decode: {
                decodeAudioData: () => {
                    startDecode();
                    return new Promise<AudioBuffer>(() => undefined);
                },
            },
            onUpdate: () => undefined,
        });
        const decodingTask = fDecodeAbort.transcribe(f.file, true);
        await decodeStarted;
        fDecodeAbort.cancel();
        expect(await decodingTask).toBe(false);

        // 在进入识别循环和翻译循环前立即取消（通过 onUpdate 钩子覆盖循环入口与解码后守卫）
        for (const cancelPhase of ['decoding', 'transcribing', 'translating'] as const) {
            let sessionRef!: LocalMediaTranscriptionSession;
            let triggered = false;
            sessionRef = new LocalMediaTranscriptionSession({
                send: async (msg: unknown) => {
                    const payload = msg as {type: string};
                    if (payload.type === 'fluentReadGetLocalVideoModelState') {
                        return {success: true, models: ['small'], available: {tiny: false, base: false, small: true}};
                    }
                    if (payload.type === 'fluentReadTranscribeLocalVideoAudio') {
                        return {success: true, text: 'Hello world.', segments: [{startMs: 0, endMs: 1500, text: 'Hello world.'}]};
                    }
                    return {success: true};
                },
                translate: async text => `译:${text}`,
                getModel: () => 'small',
                getSourceLanguage: () => 'en',
                getTargetLanguage: () => 'zh-Hans',
                getProvider: () => 'browser',
                getNativeBaseUrl: () => 'http://127.0.0.1:8000',
                decode: {
                    decodeAudioData: async () => {
                        const buf = makeAudioBuffer(makeSpeechPcm(3));
                        if (cancelPhase === 'decoding' && !triggered) {
                            triggered = true;
                            queueMicrotask(() => sessionRef.cancel());
                        }
                        return buf;
                    },
                },
                onUpdate: snap => {
                    if (!triggered && snap.phase === cancelPhase && cancelPhase !== 'decoding') {
                        triggered = true;
                        sessionRef.cancel();
                    }
                },
            });
            expect(await sessionRef.transcribe(f.file, true)).toBe(false);
        }

        // destroy 后所有操作均安全忽略
        f2.session.destroy();
        f2.session.cancel();
        f2.session.reset();
        expect(await f2.session.transcribe(f2.file, true)).toBe(false);
        expect(await f2.session.translatePending()).toBe(false);
    });
});
