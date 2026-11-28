/**
 * @file tests/ttsMultiSourceAndControls.test.ts
 * 文件职责：验证多源在线 TTS（Edge、有道、Google、OpenAI）、浏览器语音选择、多源编排与缓存熔断、暂停/继续/倍速控制及本地 TTS 会话级 GPU 记忆与预热。
 * 主要内容：覆盖新服务协议、分段与超时边界、Edge 401 刷新与限流退避、多源回退与仅本地隐私隔离、Offscreen 播放器 pause/resume/setRate、后台消息路由及本地 TTS 预热与 speed 透传。
 * 模块边界：仅注入模拟 fetch/Worker/Audio 边界，不发起真实网络请求、不加载真实 ONNX 模型。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {TtsAudioCache} from '@/src/core/tts/audioCache';
import {TtsCircuitBreaker} from '@/src/core/tts/backoff';
import {
    edgeTtsVoiceCandidatesForLanguage,
    formatEdgeTtsRate,
    splitEdgeTtsText,
    splitTtsTextByChars,
} from '@/src/features/selection-translation/services/edgeTtsPolicy';
import {
    resetEdgeTtsStateForTests,
    synthesizeEdgeTts,
} from '@/src/features/selection-translation/services/edgeTts';
import {
    buildYoudaoTtsUrl,
    resolveYoudaoTtsLanguageSpec,
    synthesizeYoudaoTts,
} from '@/src/features/selection-translation/services/youdaoTts';
import {
    buildGoogleTtsUrl,
    normalizeGoogleTtsLanguage,
    splitGoogleTtsText,
    synthesizeGoogleTts,
} from '@/src/features/selection-translation/services/googleTts';
import {
    isLocalOpenAiTtsEndpoint,
    resolveOpenAiTtsUrl,
    synthesizeOpenAiTts,
} from '@/src/features/selection-translation/services/openAiTts';
import {
    inferWordSpeechLanguage,
    loadBrowserSpeechVoices,
    selectBrowserSpeechVoice,
} from '@/src/features/selection-translation/speech/public';
import {createSelectionTtsSynthesizer} from '@/src/features/selection-translation/background/selectionTtsSynthesis';
import {
    createSelectionTtsBackgroundHandlers,
    SELECTION_TTS_MESSAGE_TYPE,
    SELECTION_TTS_PAUSE_MESSAGE_TYPE,
    SELECTION_TTS_RESUME_MESSAGE_TYPE,
    SELECTION_TTS_SET_RATE_MESSAGE_TYPE,
    type SelectionTtsAudio,
} from '@/src/features/selection-translation/background/ttsHandler';
import {createSelectionTtsOffscreenAdapter} from '@/src/features/selection-translation/background/offscreenAdapter';
import {createSelectionTtsPlayer, parseSelectionTtsPlaybackRequest, type SelectionAudioPort} from '@/src/app/offscreen/ttsPlayback';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {createBackgroundMessageRouter} from '@/src/services/messaging/backgroundRouter';
import {createLocalTtsOffscreenAdapter} from '@/src/features/local-tts/background/offscreenAdapter';

function jwtWithExp(expSeconds: number): string {
    const payload = btoa(JSON.stringify({exp: expSeconds}))
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/gu, '');
    return `hdr.${payload}.sig`;
}

function audioBytes(bytes = [1, 2, 3, 4], contentType = 'audio/mpeg'): Response {
    return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {'content-type': contentType},
    });
}

afterEach(() => {
    setRuntimeFetch(undefined);
    resetEdgeTtsStateForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Edge TTS upgraded policy, session token cache, 401 refresh, backoff and concurrency', () => {
    it('supports expanded locales, dialect fallback for generic base language, rate formatting and punctuation splitting', () => {
        expect(edgeTtsVoiceCandidatesForLanguage('ru-RU')).toEqual(['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural']);
        expect(edgeTtsVoiceCandidatesForLanguage('zh-HK')).toEqual(['zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural']);
        expect(edgeTtsVoiceCandidatesForLanguage('en', ['en-GB-SoniaNeural'])[0]).toBe('en-GB-SoniaNeural');
        expect(edgeTtsVoiceCandidatesForLanguage('en-US', ['en-GB-SoniaNeural'])[0]).toBe('en-US-AvaMultilingualNeural');

        expect(formatEdgeTtsRate(undefined)).toBe('+0%');
        expect(formatEdgeTtsRate(1)).toBe('+0%');
        expect(formatEdgeTtsRate(1.25)).toBe('+25%');
        expect(formatEdgeTtsRate(0.75)).toBe('-25%');
        expect(formatEdgeTtsRate(0.1)).toBe('-50%');
        expect(formatEdgeTtsRate(5)).toBe('+100%');

        const clauseText = `${'甲'.repeat(500)}，${'乙'.repeat(400)}`;
        const chunks = splitEdgeTtsText(clauseText);
        expect(chunks.length).toBe(2);
        expect(chunks[0]?.endsWith('，')).toBe(true);

        const charChunks = splitTtsTextByChars('First sentence! Second sentence? Third.', 20, 4, () => new Error('too long'));
        expect(charChunks.length).toBeGreaterThanOrEqual(2);
        expect(() => splitTtsTextByChars('a'.repeat(50), 10, 2, () => new Error('too long'))).toThrow('too long');
    });

    it('reuses session-cached token, coalesces token fetch, refreshes once on 401 and handles 404 voice cooldown', async () => {
        const stored: Record<string, unknown> = {};
        const sessionStorage = {
            get: vi.fn(async (key: string) => ({[key]: stored[key]})),
            set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(stored, items); }),
            remove: vi.fn(async (key: string) => { delete stored[key]; }),
        };
        const validToken = jwtWithExp(Math.floor(Date.now() / 1000) + 3_600);
        const refreshedToken = jwtWithExp(Math.floor(Date.now() / 1000) + 7_200);
        let endpointCalls = 0;
        let synthCalls = 0;

        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.includes('dev.microsofttranslator.com')) {
                endpointCalls += 1;
                return new Response(JSON.stringify({t: endpointCalls === 1 ? validToken : refreshedToken, r: 'eastus'}), {
                    status: 200,
                    headers: {'content-type': 'application/json'},
                });
            }
            synthCalls += 1;
            const body = String(init?.body ?? '');
            if (synthCalls === 1) {
                return new Response('unauthorized', {status: 401});
            }
            if (body.includes('en-US-JennyNeural')) {
                return new Response('missing voice', {status: 404});
            }
            expect(body).toContain('rate="+25%"');
            return audioBytes([9, 8]);
        });

        const breaker = new TtsCircuitBreaker();
        const result = await synthesizeEdgeTts('Hello world', 'en-US', ['en-US-JennyNeural'], undefined, {
            rate: 1.25,
            breaker,
            sessionStorage,
            sleep: async () => undefined,
        });
        expect(result.source).toBe('edge');
        expect(result.voice).toBe('en-US-AvaMultilingualNeural');
        expect(endpointCalls).toBe(2);
        expect(sessionStorage.remove).toHaveBeenCalled();
        expect(breaker.isVoiceInCooldown('en-US-JennyNeural')).toBe(true);

        // Reset in-memory token; next request hydrates directly from sessionStorage without hitting endpoint!
        resetEdgeTtsStateForTests();
        const cachedEndpointBefore = endpointCalls;
        const second = await synthesizeEdgeTts('Second phrase', 'en-US', [], undefined, {
            rate: 1.25,
            breaker,
            sessionStorage,
            sleep: async () => undefined,
        });
        expect(second.voice).toBe('en-US-AvaMultilingualNeural');
        expect(endpointCalls).toBe(cachedEndpointBefore);
    });

    it('stops looping voices after bounded transient 429 retry and synthesizes multi-chunk audio concurrently in order', async () => {
        const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3_600);
        let rateLimitHits = 0;
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.includes('dev.microsofttranslator.com')) {
                return new Response(JSON.stringify({t: token, r: 'eastus'}), {status: 200});
            }
            rateLimitHits += 1;
            return new Response('limited', {status: 429, headers: {'retry-after': '1'}});
        });
        const sleeps: number[] = [];
        await expect(synthesizeEdgeTts('Hello', 'en-US', [], undefined, {
            sleep: async (ms) => { sleeps.push(ms); },
        })).rejects.toMatchObject({statusCode: 429});
        // Only 1 initial attempt + 1 bounded retry (not 4 voices hammered!)
        expect(rateLimitHits).toBe(2);
        expect(sleeps).toHaveLength(1);

        // Multi-chunk ordered concatenation.
        let chunkSeq = 0;
        setRuntimeFetch(async (input) => {
            const url = String(input);
            if (url.includes('dev.microsofttranslator.com')) {
                return new Response(JSON.stringify({t: token, r: 'eastus'}), {status: 200});
            }
            const id = ++chunkSeq;
            return audioBytes([id, id + 10]);
        });
        const longText = `${'a'.repeat(1_200)}. ${'b'.repeat(1_200)}.`;
        const combined = await synthesizeEdgeTts(longText, 'en-US');
        expect(new Uint8Array(combined.audio)).toEqual(new Uint8Array([1, 11, 2, 12]));
    });
});

describe('Youdao, Google and OpenAI TTS multi-source adapters', () => {
    it('resolves Youdao language specs, chunks text, rejects unsupported/long/bad responses and returns MP3', async () => {
        expect(resolveYoudaoTtsLanguageSpec('')).toMatchObject({paramKey: 'type', paramValue: '2'});
        expect(resolveYoudaoTtsLanguageSpec('auto')).toMatchObject({paramKey: 'type', paramValue: '2'});
        expect(resolveYoudaoTtsLanguageSpec('en-GB')).toMatchObject({paramKey: 'type', paramValue: '1', voice: 'Youdao (UK)'});
        expect(resolveYoudaoTtsLanguageSpec('en-UK')).toMatchObject({paramKey: 'type', paramValue: '1', voice: 'Youdao (UK)'});
        expect(resolveYoudaoTtsLanguageSpec('en-GB-oxendict')).toMatchObject({paramKey: 'type', paramValue: '1', voice: 'Youdao (UK)'});
        expect(resolveYoudaoTtsLanguageSpec('en-UK-test')).toMatchObject({paramKey: 'type', paramValue: '1', voice: 'Youdao (UK)'});
        expect(resolveYoudaoTtsLanguageSpec('en-AU')).toMatchObject({paramKey: 'type', paramValue: '2'});
        expect(resolveYoudaoTtsLanguageSpec('ja-JP')).toMatchObject({paramKey: 'le', paramValue: 'jap'});
        expect(resolveYoudaoTtsLanguageSpec('ko-KR')).toMatchObject({paramKey: 'le', paramValue: 'ko'});
        expect(resolveYoudaoTtsLanguageSpec('fr-FR')).toMatchObject({paramKey: 'le', paramValue: 'fr'});
        expect(resolveYoudaoTtsLanguageSpec('zh-CN')).toMatchObject({paramKey: 'le', paramValue: 'zh'});
        expect(resolveYoudaoTtsLanguageSpec('ru-RU')).toBeNull();
        expect(buildYoudaoTtsUrl('hello', resolveYoudaoTtsLanguageSpec('en-GB')!))
            .toBe('https://dict.youdao.com/dictvoice?audio=hello&type=1');

        const aborted = new AbortController();
        aborted.abort();
        await expect(synthesizeYoudaoTts('hi', 'en-US', aborted.signal)).rejects.toMatchObject({name: 'AbortError'});
        await expect(synthesizeYoudaoTts('   ', 'en-US')).rejects.toThrow('为空');
        await expect(synthesizeYoudaoTts('привет', 'ru-RU')).rejects.toMatchObject({code: 'tts-language-unsupported'});
        await expect(synthesizeYoudaoTts('a'.repeat(601), 'en-US')).rejects.toMatchObject({code: 'tts-language-unsupported'});

        let index = 0;
        setRuntimeFetch(async () => audioBytes([++index]));
        const multi = await synthesizeYoudaoTts(`${'hello '.repeat(35)}world`, 'en-GB');
        expect(multi.voice).toBe('Youdao (UK)');
        expect(multi.source).toBe('youdao');
        expect(new Uint8Array(multi.audio)).toEqual(new Uint8Array([1, 2]));

        setRuntimeFetch(async () => new Response('fail', {status: 503}));
        await expect(synthesizeYoudaoTts('hello', 'en-US')).rejects.toMatchObject({statusCode: 503});

        setRuntimeFetch(async () => new Response('<html>err</html>', {status: 200, headers: {'content-type': 'text/html'}}));
        await expect(synthesizeYoudaoTts('hello', 'en-US')).rejects.toThrow('non-audio');

        setRuntimeFetch(async () => new Response(new Uint8Array(0), {status: 200, headers: {'content-type': 'audio/mpeg'}}));
        await expect(synthesizeYoudaoTts('hello', 'en-US')).rejects.toThrow('empty');

        setRuntimeFetch(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new TextEncoder().encode('<!doctype html>').buffer,
        } as unknown as Response));
        await expect(synthesizeYoudaoTts('hello', 'en-US')).rejects.toThrow('non-audio');

        // Abort mid-flight in Youdao multi-chunk request.
        const abortYoudao = new AbortController();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
            abortYoudao.abort();
        }));
        await expect(synthesizeYoudaoTts(`${'hello '.repeat(35)}world`, 'en-US', abortYoudao.signal))
            .rejects.toMatchObject({name: 'AbortError'});

        vi.useFakeTimers();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        }));
        const timedOut = synthesizeYoudaoTts('hello', 'en-US', undefined, {timeoutMs: 50});
        const expectedTimeout = expect(timedOut).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(60);
        await expectedTimeout;
    });

    it('normalizes Google TTS languages, splits long text into chunks and validates responses', async () => {
        expect(normalizeGoogleTtsLanguage('auto')).toBe('en');
        expect(normalizeGoogleTtsLanguage('zh-Hans')).toBe('zh-CN');
        expect(normalizeGoogleTtsLanguage('zh-Hant')).toBe('zh-TW');
        expect(normalizeGoogleTtsLanguage('cmn')).toBe('zh-CN');
        expect(normalizeGoogleTtsLanguage('en-UK')).toBe('en-GB');
        expect(normalizeGoogleTtsLanguage('ru-RU')).toBe('ru');
        expect(normalizeGoogleTtsLanguage('12345')).toBe('en');
        expect(buildGoogleTtsUrl('hello', 'en-GB')).toContain('tl=en-GB');
        expect(splitGoogleTtsText('a'.repeat(350)).length).toBe(2);
        expect(() => splitGoogleTtsText('a'.repeat(2_000))).toThrow('too long');

        const aborted = new AbortController();
        aborted.abort();
        await expect(synthesizeGoogleTts('hi', 'en', aborted.signal)).rejects.toMatchObject({name: 'AbortError'});
        await expect(synthesizeGoogleTts('  ', 'en')).rejects.toThrow('为空');

        let calls = 0;
        setRuntimeFetch(async () => audioBytes([++calls, 99]));
        const result = await synthesizeGoogleTts(`${'sentence '.repeat(25)}end.`, 'fr-FR');
        expect(result.source).toBe('google');
        expect(result.voice).toBe('Google TTS');
        expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([1, 99, 2, 99]));

        setRuntimeFetch(async () => new Response('blocked', {status: 429}));
        await expect(synthesizeGoogleTts('hi', 'en')).rejects.toMatchObject({statusCode: 429});

        setRuntimeFetch(async () => new Response('<html>captcha</html>', {status: 200, headers: {'content-type': 'text/html'}}));
        await expect(synthesizeGoogleTts('hi', 'en')).rejects.toThrow('non-audio');

        setRuntimeFetch(async () => new Response(new Uint8Array(0), {status: 200, headers: {'content-type': 'audio/mpeg'}}));
        await expect(synthesizeGoogleTts('hi', 'en')).rejects.toThrow('empty');

        setRuntimeFetch(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new TextEncoder().encode('{"err":true}').buffer,
        } as unknown as Response));
        await expect(synthesizeGoogleTts('hi', 'en')).rejects.toThrow('non-audio');

        const abortGoogle = new AbortController();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
            abortGoogle.abort();
        }));
        await expect(synthesizeGoogleTts(`${'sentence '.repeat(25)}end.`, 'en', abortGoogle.signal))
            .rejects.toMatchObject({name: 'AbortError'});

        vi.useFakeTimers();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        }));
        const timedOut = synthesizeGoogleTts('hi', 'en', undefined, {timeoutMs: 50});
        const expectedTimeout = expect(timedOut).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(60);
        await expectedTimeout;
    });

    it('resolves OpenAI-compatible URLs, allows keyless localhost, enforces remote key and sends speed', async () => {
        expect(resolveOpenAiTtsUrl()).toBe('https://api.openai.com/v1/audio/speech');
        expect(resolveOpenAiTtsUrl('https://proxy.example.com/')).toBe('https://proxy.example.com/v1/audio/speech');
        expect(resolveOpenAiTtsUrl('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1/audio/speech');
        expect(resolveOpenAiTtsUrl('https://proxy.example.com/v1/chat/completions')).toBe('https://proxy.example.com/v1/audio/speech');
        expect(resolveOpenAiTtsUrl('https://proxy.example.com/custom')).toBe('https://proxy.example.com/custom/v1/audio/speech');
        expect(resolveOpenAiTtsUrl('http://localhost:8880/v1/audio/speech')).toBe('http://localhost:8880/v1/audio/speech');
        expect(() => resolveOpenAiTtsUrl('not a url')).toThrow('无效');
        expect(() => resolveOpenAiTtsUrl('ftp://example.com')).toThrow('HTTP/HTTPS');
        expect(isLocalOpenAiTtsEndpoint('http://127.0.0.1:8880/v1/audio/speech')).toBe(true);
        expect(isLocalOpenAiTtsEndpoint('https://api.openai.com/v1/audio/speech')).toBe(false);
        expect(isLocalOpenAiTtsEndpoint('bad')).toBe(false);

        const aborted = new AbortController();
        aborted.abort();
        await expect(synthesizeOpenAiTts('hi', {apiKey: 'k'}, aborted.signal)).rejects.toMatchObject({name: 'AbortError'});
        await expect(synthesizeOpenAiTts('   ', {apiKey: 'k'})).rejects.toThrow('为空');
        await expect(synthesizeOpenAiTts('hi', {})).rejects.toMatchObject({code: 'tts-openai-key-missing'});

        const requests: Array<{url: string; init?: RequestInit}> = [];
        setRuntimeFetch(async (url, init) => {
            requests.push({url: String(url), init});
            return audioBytes([7, 8, 9]);
        });

        // Keyless localhost allowed!
        const localRes = await synthesizeOpenAiTts('Local server', {
            baseUrl: 'http://localhost:8880',
            model: 'tts-1',
            voice: 'nova',
            rate: 1.5,
            customHeaders: {'X-Test': 'ok', ' ': 'skip'},
        });
        expect(localRes.voice).toBe('OpenAI · nova');
        expect(localRes.source).toBe('openai');
        expect(requests[0]?.url).toBe('http://localhost:8880/v1/audio/speech');
        expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
            model: 'tts-1',
            input: 'Local server',
            voice: 'nova',
            speed: 1.5,
            response_format: 'mp3',
        });

        // Remote with key sends Authorization Bearer.
        await synthesizeOpenAiTts('Cloud', {apiKey: 'sk-test'});
        expect((requests[1]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

        setRuntimeFetch(async () => new Response('err', {status: 401}));
        await expect(synthesizeOpenAiTts('Cloud', {apiKey: 'sk-bad'})).rejects.toMatchObject({statusCode: 401});

        setRuntimeFetch(async () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}}));
        await expect(synthesizeOpenAiTts('Cloud', {apiKey: 'sk-ok'})).rejects.toThrow('non-audio');

        setRuntimeFetch(async () => new Response(new Uint8Array(0), {status: 200, headers: {'content-type': 'audio/mpeg'}}));
        await expect(synthesizeOpenAiTts('Cloud', {apiKey: 'sk-ok'})).rejects.toThrow('empty');

        vi.useFakeTimers();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        }));
        const timedOut = synthesizeOpenAiTts('Cloud', {apiKey: 'sk-ok', timeoutMs: 50});
        const expectedTimeout = expect(timedOut).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.advanceTimersByTimeAsync(60);
        await expectedTimeout;
    });
});

describe('Browser speech helper: ranking, cold-start loading and word language inference', () => {
    it('ranks exact-locale neural/preferred voices first and loads voices across cold start', async () => {
        const makeVoice = (name: string, lang: string, isDefault = false): SpeechSynthesisVoice => ({
            name, lang, default: isDefault, localService: true, voiceURI: name,
        });
        expect(selectBrowserSpeechVoice([], 'en-US')).toBeUndefined();
        const voices = [
            makeVoice('Generic US', 'en-US'),
            makeVoice('Microsoft Ava Online (Natural)', 'en-US'),
            makeVoice('Daniel', 'en-GB'),
            makeVoice('Broken', ''),
        ];
        expect(selectBrowserSpeechVoice(voices, 'en-US')?.name).toBe('Microsoft Ava Online (Natural)');
        expect(selectBrowserSpeechVoice(voices, 'en-AU')?.name).toBe('Microsoft Ava Online (Natural)');
        expect(selectBrowserSpeechVoice([makeVoice('Plain', 'en-GB')], 'en-US')?.name).toBe('Plain');
        expect(selectBrowserSpeechVoice([makeVoice('Plain', 'en-US', true)], 'en-US')?.name).toBe('Plain');
        expect(selectBrowserSpeechVoice([makeVoice('Plain', 'fr-FR')], 'de-DE')).toBeUndefined();

        expect(await loadBrowserSpeechVoices(null)).toEqual([]);
        const immediateSynth = {
            getVoices: () => voices,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        expect(await loadBrowserSpeechVoices(immediateSynth)).toHaveLength(4);
        expect(immediateSynth.addEventListener).not.toHaveBeenCalled();

        // Cold start: resolves on voiceschanged and cleans up listener.
        let readyVoices: SpeechSynthesisVoice[] = [];
        let listener: (() => void) | undefined;
        const asyncSynth = {
            getVoices: () => readyVoices,
            addEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => { listener = cb as () => void; }),
            removeEventListener: vi.fn(),
        };
        const loading = loadBrowserSpeechVoices(asyncSynth as never, 200);
        readyVoices = [voices[0]!];
        listener?.();
        expect(await loading).toHaveLength(1);
        expect(asyncSynth.removeEventListener).toHaveBeenCalled();

        // Timeout fallback when voiceschanged never fires.
        vi.useFakeTimers();
        const emptySynth = {
            getVoices: () => [],
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        expect(await loadBrowserSpeechVoices(emptySynth as never, 0)).toEqual([]);
        const pendingTimeout = loadBrowserSpeechVoices(emptySynth as never, 50);
        await vi.advanceTimersByTimeAsync(60);
        expect(await pendingTimeout).toEqual([]);
        expect(emptySynth.removeEventListener).toHaveBeenCalled();
    });

    it('infers word speech language from UK/US labels, detected language and scripts', () => {
        expect(inferWordSpeechLanguage('colour', 'UK')).toBe('en-GB');
        expect(inferWordSpeechLanguage('colour', '英')).toBe('en-GB');
        expect(inferWordSpeechLanguage('color', '美')).toBe('en-US');
        expect(inferWordSpeechLanguage('bonjour', undefined, 'fr')).toBe('fr-FR');
        expect(inferWordSpeechLanguage('こんにちは', undefined, 'auto')).toBe('ja-JP');
        expect(inferWordSpeechLanguage('안녕하세요')).toBe('ko-KR');
        expect(inferWordSpeechLanguage('你好')).toBe('zh-CN');
        expect(inferWordSpeechLanguage('привет')).toBe('ru-RU');
        expect(inferWordSpeechLanguage('مرحبا')).toBe('ar-SA');
        expect(inferWordSpeechLanguage('नमस्ते')).toBe('hi-IN');
        expect(inferWordSpeechLanguage('สวัสดี')).toBe('th-TH');
        expect(inferWordSpeechLanguage('hello')).toBe('en-US');
    });
});

describe('Multi-source orchestrator, audio cache, pause/resume/rate controls and local prewarm', () => {
    it('routes across configured online sources with circuit breaker, fallback metadata, cache hits and local-only privacy', async () => {
        const breaker = new TtsCircuitBreaker();
        const cache = new TtsAudioCache();
        const edge = vi.fn(async (): Promise<SelectionTtsAudio> => {
            throw Object.assign(new Error('edge 429'), {statusCode: 429});
        });
        const youdao = vi.fn(async (): Promise<SelectionTtsAudio> => ({
            audio: new Uint8Array([5, 6]).buffer,
            contentType: 'audio/mpeg',
            voice: 'Youdao (US)',
            source: 'youdao',
        }));
        const local = vi.fn(async () => ({
            audio: new Uint8Array([7, 8]).buffer,
            contentType: 'audio/wav' as const,
            voice: 'af_maple',
        }));
        let mode = 'online-first';
        const synthesize = createSelectionTtsSynthesizer({
            getMode: () => mode,
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            getRate: () => 1.25,
            getOnlineSources: () => ['edge', 'youdao'],
            getExtraVoiceCacheKey: () => 'gpt-4o-mini-tts:alloy',
            synthesizeOnline: async () => { throw new Error('unused'); },
            onlineSynthesizers: {edge, youdao},
            synthesizeLocal: local,
            cache,
            breaker,
        });

        const first = await synthesize('hello', 'en-US', []);
        expect(first).toMatchObject({source: 'youdao', voice: 'Youdao (US)', fallbackFrom: 'edge'});
        expect(edge).toHaveBeenCalledOnce();
        expect(youdao).toHaveBeenCalledOnce();

        // Fallback response was NOT cached to avoid cache poisoning; next call skips cooled edge directly to youdao (now primary -> cached!).
        const second = await synthesize('hello', 'en-US', []);
        expect(second).toMatchObject({source: 'youdao'});
        expect(second.fallbackFrom).toBeUndefined();
        expect(edge).toHaveBeenCalledOnce();
        expect(youdao).toHaveBeenCalledTimes(2);

        // Third identical request hits LRU cache (0 additional network calls!).
        const cached = await synthesize('hello', 'en-US', []);
        expect(cached).toMatchObject({source: 'youdao', cached: true});
        expect(youdao).toHaveBeenCalledTimes(2);

        // modeOverride='local-only' forces Kokoro even while config mode is 'online-first' (for settings voice preview!).
        const previewLocal = await synthesize('hello', 'en-US', [], undefined, 1.25, 'local-only');
        expect(previewLocal).toMatchObject({source: 'local', voice: 'af_maple'});
        expect(local).toHaveBeenCalledWith('hello', 'en-US', 'auto', expect.any(AbortSignal), 1.25);

        // Local-only mode never touches online sources and forwards rate.
        mode = 'local-only';
        const localOnly = await synthesize('local phrase', 'en-US', []);
        expect(localOnly).toMatchObject({source: 'local', voice: 'af_maple'});

        // Local-first falls back to online chain on local synthesis crash.
        mode = 'local-first';
        local.mockRejectedValueOnce(new Error('worker boom'));
        const localFirstFallback = await synthesize('fallback text', 'en-US', []);
        expect(localFirstFallback).toMatchObject({source: 'youdao', fallbackFrom: 'local'});
    });

    it('supports pause, resume, setRate and rate validation across background handler, offscreen adapter, router and player', async () => {
        class FakeAudio implements SelectionAudioPort {
            currentTime: number | undefined = 1;
            duration: number | undefined = 10;
            playbackRate = 1;
            paused = false;
            preload = '';
            src = '';
            onended: ((event: Event) => void) | null = null;
            onerror: ((event: Event | string) => void) | null = null;
            pause = vi.fn(() => { this.paused = true; });
            load = vi.fn();
            play = vi.fn(async () => { this.paused = false; });
            removeAttribute = vi.fn();
        }

        const audioInstance = new FakeAudio();
        const player = createSelectionTtsPlayer({
            createAudio: () => audioInstance,
            decodeBase64: () => new Uint8Array([1, 2]),
            createObjectUrl: () => 'blob:1',
            revokeObjectUrl: vi.fn(),
            notify: vi.fn(),
            notifyProgress: vi.fn(),
        });

        expect(() => parseSelectionTtsPlaybackRequest({sourceUrl: 'https://a', tabId: 1, clientRequestId: 'r', rate: 5})).toThrow('rate');
        expect(parseSelectionTtsPlaybackRequest({sourceUrl: 'https://a', tabId: 1, clientRequestId: 'r', rate: 1.5}).rate).toBe(1.5);

        await player.play({audioBase64: 'AQI=', text: 'Hello world', rate: 1.25, tabId: 1, clientRequestId: 'req-1'});
        expect(audioInstance.playbackRate).toBe(1.25);
        expect(player.pause({tabId: 1, clientRequestId: 'other'})).toBe(false);
        expect(player.pause({tabId: 1, clientRequestId: 'req-1'})).toBe(true);
        expect(audioInstance.pause).toHaveBeenCalledOnce();
        expect(await player.resume({tabId: 1, clientRequestId: 'other'})).toBe(false);
        expect(await player.resume({tabId: 1, clientRequestId: 'req-1'})).toBe(true);
        expect(audioInstance.play).toHaveBeenCalledTimes(2);

        // Pause arriving while resume() awaits play() invalidates stale resume.
        let finishResumePlay!: () => void;
        audioInstance.play.mockImplementationOnce(() => new Promise<void>((resolve) => { finishResumePlay = resolve; }));
        const racingResume = player.resume({tabId: 1, clientRequestId: 'req-1'});
        expect(player.pause({tabId: 1, clientRequestId: 'req-1'})).toBe(true);
        finishResumePlay();
        expect(await racingResume).toBe(false);

        expect(player.setRate({tabId: 1, clientRequestId: 'other', rate: 1.5})).toBe(false);
        expect(player.setRate({tabId: 1, clientRequestId: 'req-1', rate: 1.5})).toBe(true);
        expect(audioInstance.playbackRate).toBe(1.5);
        expect(() => player.setRate({tabId: 1, clientRequestId: 'req-1', rate: 9})).toThrow('rate');
        player.dispose();

        // Offscreen router + adapter + background handler round-trip.
        const listener = createOffscreenMessageListener({
            runtimeId: 'ext-1',
            translate: vi.fn(),
            recognizeImage: vi.fn(),
            translateImage: vi.fn(),
            fetchImage: vi.fn(),
            ttsPlayer: {
                play: vi.fn(async () => undefined),
                stop: vi.fn(() => true),
                seek: vi.fn(() => true),
                pause: vi.fn(() => true),
                resume: vi.fn(async () => true),
                setRate: vi.fn(() => true),
            },
        } as never);
        const send = vi.fn((message: unknown) => new Promise((resolve) => {
            listener({...(message as Record<string, unknown>), target: 'offscreen'}, {id: 'ext-1'}, resolve);
        }));
        const adapter = createSelectionTtsOffscreenAdapter({
            send,
            sendIfPresent: send,
        } as never);
        expect(await adapter.pause({tabId: 1, clientRequestId: 'r1'})).toBe(true);
        expect(await adapter.resume({tabId: 1, clientRequestId: 'r1'})).toBe(true);
        expect(await adapter.setRate({tabId: 1, clientRequestId: 'r1'}, 1.5)).toBe(true);

        // Background handlers route pause/resume/setRate, prevent rate² double scaling, and enforce local-only on Google TTS.
        const playWithOffscreen = vi.fn<(request: unknown, signal?: AbortSignal) => Promise<void>>(async () => undefined);
        let currentMode = 'online-first';
        const synthMock = vi.fn(async () => ({
            audio: new Uint8Array([1, 2, 3]).buffer,
            contentType: 'audio/mpeg',
            voice: 'Youdao (US)',
            source: 'youdao' as const,
            cached: true,
            fallbackFrom: 'edge' as const,
        }));
        const handlers = createSelectionTtsBackgroundHandlers({
            getPreferredVoices: () => [],
            getMode: () => currentMode,
            getDefaultRate: () => 1.25,
            synthesize: synthMock,
            playWithOffscreen,
            stopWithOffscreen: vi.fn(async () => undefined),
            seekWithOffscreen: vi.fn(async () => true),
            pauseWithOffscreen: adapter.pause,
            resumeWithOffscreen: adapter.resume,
            setRateWithOffscreen: adapter.setRate,
            sendTabMessage: vi.fn(async () => undefined),
        });
        const router = createBackgroundMessageRouter(handlers as never);
        const sender = {sender: {tab: {id: 1}}};
        // Youdao does not bake speed into audio, so playWithOffscreen receives rate=1.5 and response reports synthesizedRate=1.
        await expect(router.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'hi', clientRequestId: 'r1', rate: 1.5}, sender))
            .resolves.toMatchObject({handled: true, response: {success: true, source: 'youdao', cached: true, fallbackFrom: 'edge', synthesizedRate: 1}});
        expect(playWithOffscreen).toHaveBeenLastCalledWith(expect.objectContaining({rate: 1.5}), expect.any(AbortSignal));

        // Edge already bakes speed into SSML waveform, so playWithOffscreen omits rate (no rate²!) and reports synthesizedRate=1.5.
        synthMock.mockResolvedValueOnce({
            audio: new Uint8Array([1, 2, 3]).buffer,
            contentType: 'audio/mpeg',
            voice: 'en-US-AvaMultilingualNeural',
            source: 'edge',
        } as never);
        await expect(router.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'hi', clientRequestId: 'r2', rate: 1.5}, sender))
            .resolves.toMatchObject({handled: true, response: {success: true, source: 'edge', synthesizedRate: 1.5}});
        expect((playWithOffscreen.mock.calls.at(-1)?.[0] as Record<string, unknown>).rate).toBeUndefined();

        // Extension page preview can pass modeOverride='local-only', while content tab cannot.
        await router.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'hi', clientRequestId: 'r-ext', modeOverride: 'local-only'}, {sender: {url: 'chrome-extension://ext/options.html'}});
        expect(synthMock).toHaveBeenLastCalledWith('hi', 'en-US', [], expect.any(AbortSignal), undefined, 'local-only');

        // Defense-in-depth: Google TTS handler refuses network calls when mode is local-only.
        currentMode = 'local-only';
        await expect(router.dispatch({type: 'selectionTtsGoogle', text: 'private', clientRequestId: 'r-priv'}, sender))
            .resolves.toEqual({handled: true, response: {success: false, error: '当前处于仅本地朗读模式'}});

        await expect(router.dispatch({type: SELECTION_TTS_PAUSE_MESSAGE_TYPE, clientRequestId: 'r1'}, sender))
            .resolves.toEqual({handled: true, response: {success: true}});
        await expect(router.dispatch({type: SELECTION_TTS_RESUME_MESSAGE_TYPE, clientRequestId: 'r1'}, sender))
            .resolves.toEqual({handled: true, response: {success: true}});
        await expect(router.dispatch({type: SELECTION_TTS_SET_RATE_MESSAGE_TYPE, clientRequestId: 'r1', rate: 1.5}, sender))
            .resolves.toEqual({handled: true, response: {success: true}});
        await expect(router.dispatch({type: SELECTION_TTS_SET_RATE_MESSAGE_TYPE, clientRequestId: 'r1', rate: 5}, sender))
            .rejects.toThrow('0.25 到 4.0');
        await expect(router.dispatch({type: SELECTION_TTS_SET_RATE_MESSAGE_TYPE, clientRequestId: 'r1'}, sender))
            .rejects.toThrow('0.25 到 4.0');
        await expect(router.dispatch({type: SELECTION_TTS_PAUSE_MESSAGE_TYPE, clientRequestId: 'r1'}, {})).resolves.toEqual({handled: true, response: {success: false}});
        await expect(router.dispatch({type: SELECTION_TTS_RESUME_MESSAGE_TYPE, clientRequestId: 'r1'}, {})).resolves.toEqual({handled: true, response: {success: false}});
        await expect(router.dispatch({type: SELECTION_TTS_SET_RATE_MESSAGE_TYPE, clientRequestId: 'r1', rate: 1.5}, {})).resolves.toEqual({handled: true, response: {success: false}});

        // Offscreen adapter error branches & retry-after propagation.
        const failingAdapter = createSelectionTtsOffscreenAdapter({
            send: vi.fn(async () => ({success: false, error: 'boom'})),
            sendIfPresent: vi.fn(async () => ({success: false, error: 'control failed'})),
        } as never);
        await expect(failingAdapter.pause({tabId: 1, clientRequestId: 'r1'})).rejects.toThrow('control failed');
        await expect(failingAdapter.resume({tabId: 1, clientRequestId: 'r1'})).rejects.toThrow('control failed');
        await expect(failingAdapter.setRate({tabId: 1, clientRequestId: 'r1'}, 1.2)).rejects.toThrow('control failed');
        const emptyAdapter = createSelectionTtsOffscreenAdapter({
            send: vi.fn(async () => ({success: false})),
            sendIfPresent: vi.fn(async () => ({success: false})),
        } as never);
        await expect(emptyAdapter.pause({tabId: 1, clientRequestId: 'r1'})).rejects.toThrow('语音暂停失败');
        await expect(emptyAdapter.resume({tabId: 1, clientRequestId: 'r1'})).rejects.toThrow('语音继续失败');
        await expect(emptyAdapter.setRate({tabId: 1, clientRequestId: 'r1'}, 1.2)).rejects.toThrow('语音倍速设置失败');
        setRuntimeFetch(async () => new Response('rate limited', {status: 429, headers: {'retry-after': '2'}}));
        await expect(emptyAdapter.fetchPageAudio('https://example.test/g', new AbortController().signal))
            .rejects.toMatchObject({statusCode: 429, retryAfterMs: 2_000});

        // Local TTS offscreen adapter forwards speed cleanly and handles prepare/status/remove failures.
        const localSend = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({success: true, audioBase64: 'AQI=', voice: 'af_maple'}));
        const localAdapter = createLocalTtsOffscreenAdapter({send: localSend, sendIfPresent: localSend} as never);
        await localAdapter.synthesize('hi', 'en-US', 'auto', undefined, 1.5);
        expect(localSend).toHaveBeenCalledWith(expect.objectContaining({type: 'LOCAL_TTS_SYNTHESIZE', speed: 1.5}), expect.any(Object));
        localSend.mockResolvedValueOnce({success: true, warm: false});
        await expect(localAdapter.prepare()).resolves.toMatchObject({success: true, warm: false});
        localSend.mockResolvedValueOnce({success: false, error: ''});
        await expect(localAdapter.prepare()).rejects.toThrow('下载失败');
        localSend.mockResolvedValueOnce({success: true, models: []});
        await expect(localAdapter.status()).resolves.toMatchObject({success: true});
        localSend.mockResolvedValueOnce({success: false, error: ''});
        await expect(localAdapter.status()).rejects.toThrow('无法读取');
        localSend.mockResolvedValueOnce({success: true});
        await expect(localAdapter.remove()).resolves.toBeUndefined();
        localSend.mockResolvedValueOnce({success: false, error: ''});
        await expect(localAdapter.remove()).rejects.toThrow('清除失败');
    });

    it('covers remaining edge branches across services, synthesizer, browser speech, local prewarm and background runtime', async () => {
        // Edge policy & OpenAI non-audio sniffing + char splitting edge cases.
        expect(edgeTtsVoiceCandidatesForLanguage('')).toContain('en-US-AvaMultilingualNeural');
        expect(splitTtsTextByChars('😀😀', 1, 4, () => new Error('too long'))).toEqual(['😀', '😀']);
        expect(normalizeGoogleTtsLanguage('')).toBe('en');
        expect(normalizeGoogleTtsLanguage('---')).toBe('en');
        setRuntimeFetch(async () => new Response('{"error":"bad"}', {status: 200, headers: {'content-type': 'application/octet-stream'}}));
        await expect(synthesizeOpenAiTts('hi', {apiKey: 'sk-test'})).rejects.toThrow('non-audio');
        const abortOpenAi = new AbortController();
        setRuntimeFetch((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
            abortOpenAi.abort();
        }));
        await expect(synthesizeOpenAiTts('hi', {apiKey: 'sk-test'}, abortOpenAi.signal)).rejects.toMatchObject({name: 'AbortError'});
        // OpenAI with missing content-type header still succeeds for valid binary audio.
        setRuntimeFetch(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as unknown as Response));
        await expect(synthesizeOpenAiTts('hi', {apiKey: 'sk-test'})).resolves.toMatchObject({source: 'openai'});
        // Google & Youdao concurrent multi-chunk failures exercise hasError=true on 2nd worker.
        setRuntimeFetch(async () => new Response('err', {status: 500}));
        await expect(synthesizeGoogleTts(`${'sentence '.repeat(25)}end.`, 'en', undefined, {concurrency: 2})).rejects.toMatchObject({statusCode: 500});
        await expect(synthesizeYoudaoTts(`${'hello '.repeat(35)}world`, 'en-US', undefined, {concurrency: 2})).rejects.toMatchObject({statusCode: 500});
        // Synthesizer cache with default rate/extraKey + local-first success with timings + source defaulting.
        const minimalCache = new TtsAudioCache();
        const minimalSynth = createSelectionTtsSynthesizer({
            getMode: () => 'local-first',
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            onlineSynthesizers: {edge: async () => ({audio: new Uint8Array([1]).buffer, contentType: 'audio/mpeg', voice: 'e'})},
            synthesizeLocal: async () => ({audio: new Uint8Array([2]).buffer, contentType: 'audio/wav', voice: 'af_maple', timings: [{startChar: 0, endChar: 2, startTime: 0, endTime: 1}]}),
            cache: minimalCache,
        });
        await expect(minimalSynth('hi', 'en-US', [])).resolves.toMatchObject({source: 'local', timings: [{startChar: 0, endChar: 2, startTime: 0, endTime: 1}]});
        await expect(minimalSynth('hi', 'en-US', [], undefined, undefined, 'online-only')).resolves.toMatchObject({source: 'edge'});
        const legacyCacheSynth = createSelectionTtsSynthesizer({
            getMode: () => 'local-first',
            getLocalVoice: () => '',
            getOnlineVoices: () => [],
            synthesizeOnline: async () => ({audio: new Uint8Array([1]).buffer, contentType: 'audio/mpeg', voice: 'legacy'}),
            synthesizeLocal: async () => { throw new Error('local fail'); },
            cache: new TtsAudioCache(),
        });
        await expect(legacyCacheSynth('hi', 'en-US', [])).resolves.toEqual({audio: new Uint8Array([1]).buffer, contentType: 'audio/mpeg', voice: 'legacy'});
        // Youdao chunk overflow with maxChars bypassed via chunk count.
        await expect(synthesizeYoudaoTts(`${'a'.repeat(199)}😀`.repeat(3) + 'z', 'en-US')).rejects.toMatchObject({code: 'tts-language-unsupported'});

        // Browser speech edge cases (duplicate voiceschanged firing, empty word, unrecognized label).
        const listeners: Array<() => void> = [];
        const dupSynth = {
            getVoices: () => [],
            addEventListener: (_t: string, cb: EventListenerOrEventListenerObject) => { listeners.push(cb as () => void); },
            removeEventListener: vi.fn(),
        };
        const dupPromise = loadBrowserSpeechVoices(dupSynth as never, 50);
        listeners[0]?.();
        listeners[0]?.();
        expect(await dupPromise).toEqual([]);
        expect(inferWordSpeechLanguage('', 'other', '')).toBe('en-US');

        // Synthesizer edge branches: fallback to synthesizeOnline when no configured onlineSynthesizers match, abort mid-chain, single-source error, online-first -> local fallback.
        const fallbackOnline = vi.fn(async () => ({audio: new Uint8Array([1]).buffer, contentType: 'audio/mpeg', voice: 'v'}));
        const noMatchSynth = createSelectionTtsSynthesizer({
            getMode: () => 'online-only',
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            getOnlineSources: () => ['edge'],
            synthesizeOnline: fallbackOnline,
            onlineSynthesizers: {youdao: async () => ({audio: new Uint8Array([2]).buffer, contentType: 'audio/mpeg', voice: 'y'})},
            synthesizeLocal: async () => ({audio: new Uint8Array([3]).buffer, contentType: 'audio/wav', voice: 'af_maple'}),
        });
        await expect(noMatchSynth('hi', 'en-US', [])).resolves.toMatchObject({voice: 'v'});
        await expect(noMatchSynth('hi', 'en-US', [], undefined, 1.5)).resolves.toMatchObject({voice: 'v'});

        const singleFail = createSelectionTtsSynthesizer({
            getMode: () => 'online-first',
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            getOnlineSources: () => ['youdao'],
            synthesizeOnline: fallbackOnline,
            onlineSynthesizers: {youdao: async () => { throw new Error('youdao down'); }},
            synthesizeLocal: async () => ({audio: new Uint8Array([3]).buffer, contentType: 'audio/wav', voice: 'af_maple'}),
        });
        await expect(singleFail('hi', 'en-US', [])).resolves.toMatchObject({source: 'local', fallbackFrom: 'youdao'});

        const abortController = new AbortController();
        const breaker = new TtsCircuitBreaker();
        const abortSynth = createSelectionTtsSynthesizer({
            getMode: () => 'online-only',
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            getOnlineSources: () => ['edge'],
            synthesizeOnline: fallbackOnline,
            onlineSynthesizers: {
                edge: async () => {
                    abortController.abort();
                    throw Object.assign(new Error('aborted'), {name: 'AbortError'});
                },
            },
            synthesizeLocal: async () => ({audio: new Uint8Array([3]).buffer, contentType: 'audio/wav', voice: 'af_maple'}),
            breaker,
        });
        await expect(abortSynth('hi', 'en-US', [], abortController.signal)).rejects.toMatchObject({name: 'AbortError'});

        const multiFail = createSelectionTtsSynthesizer({
            getMode: () => 'online-only',
            getLocalVoice: () => 'auto',
            getOnlineVoices: () => [],
            getOnlineSources: () => ['edge', 'youdao'],
            synthesizeOnline: fallbackOnline,
            onlineSynthesizers: {
                edge: async () => { throw new Error('edge err'); },
                youdao: async () => { throw 'youdao err'; },
            },
            synthesizeLocal: async () => ({audio: new Uint8Array([3]).buffer, contentType: 'audio/wav', voice: 'af_maple'}),
        });
        await expect(multiFail('hi', 'en-US', [])).rejects.toThrow('在线 TTS 多源均不可用');

        // Local TTS keepWarm=true + sessionGpuUnavailable + speed clamping.
        vi.resetModules();
        const fakeWorkers: Array<{postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: ErrorEvent) => void) | null}> = [];
        class PrewarmFakeWorker {
            onmessage: ((e: MessageEvent) => void) | null = null;
            onerror: ((e: ErrorEvent) => void) | null = null;
            postMessage = vi.fn();
            terminate = vi.fn();
            constructor() { fakeWorkers.push(this); }
        }
        vi.doMock('@/src/features/local-tts/offscreen/modelCache', () => ({
            cacheLocalTtsModelFiles: vi.fn(async () => undefined),
            isLocalTtsModelCached: vi.fn(async () => true),
            removeLocalTtsModelFiles: vi.fn(async () => undefined),
        }));
        vi.stubGlobal('Worker', PrewarmFakeWorker);
        vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout});
        const localOwner = await import('@/src/features/local-tts/offscreen/tts');
        try {
            const warmPromise = localOwner.prepareLocalTtsModel(true);
            await vi.waitFor(() => expect(fakeWorkers[0]?.postMessage).toHaveBeenCalled());
            fakeWorkers[0]!.onmessage?.({data: {requestId: fakeWorkers[0]!.postMessage.mock.calls[0]![0].requestId, success: true, backend: 'wasm'}} as MessageEvent);
            await expect(warmPromise).resolves.toMatchObject({warm: true, backend: 'wasm'});

            // Trigger GPU fallback on synthesis #1, then confirm synthesis #2 goes straight to device: 'wasm' with clamped speed.
            const s1 = localOwner.synthesizeLocalTts('hello', 'en-US', 'auto', undefined, 1.5);
            await vi.waitFor(() => expect(fakeWorkers[0]!.postMessage).toHaveBeenCalledTimes(2));
            fakeWorkers[0]!.onmessage?.({data: {requestId: fakeWorkers[0]!.postMessage.mock.calls[1]![0].requestId, success: false, retryWithCpu: true, error: 'gpu fail'}} as MessageEvent);
            await vi.waitFor(() => expect(fakeWorkers[1]?.postMessage).toHaveBeenCalled());
            expect(fakeWorkers[1]!.postMessage.mock.calls[0]![0]).toMatchObject({device: 'wasm', speed: 1.5});
            fakeWorkers[1]!.onmessage?.({data: {requestId: fakeWorkers[1]!.postMessage.mock.calls[0]![0].requestId, success: true, audio: new ArrayBuffer(4), backend: 'wasm'}} as MessageEvent);
            await expect(s1).resolves.toMatchObject({backend: 'wasm'});

            const s2 = localOwner.synthesizeLocalTts('again', 'en-US', 'auto', undefined, Number.NaN);
            await vi.waitFor(() => expect(fakeWorkers[1]!.postMessage).toHaveBeenCalledTimes(2));
            expect(fakeWorkers[1]!.postMessage.mock.calls[1]![0]).toMatchObject({device: 'wasm', speed: 1});
            fakeWorkers[1]!.onmessage?.({data: {requestId: fakeWorkers[1]!.postMessage.mock.calls[1]![0].requestId, success: true, audio: new ArrayBuffer(4), backend: 'wasm'}} as MessageEvent);
            await expect(s2).resolves.toMatchObject({backend: 'wasm'});

            // prepareLocalTtsModel(true) when worker dies (worker === null in finally).
            const dyingWarm = localOwner.prepareLocalTtsModel(true);
            await vi.waitFor(() => expect(fakeWorkers[1]!.postMessage).toHaveBeenCalledTimes(3));
            fakeWorkers[1]!.onerror?.({message: 'dead'} as ErrorEvent);
            await expect(dyingWarm).rejects.toThrow('dead');
        } finally {
            localOwner.disposeLocalTtsWorker();
            vi.doUnmock('@/src/features/local-tts/offscreen/modelCache');
        }

        // Background selectionTtsRuntime composition coverage.
        vi.resetModules();
        const sendTabMessage = vi.fn(async () => undefined);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const edgeMock = vi.fn(async () => ({audio: new Uint8Array([1]).buffer, contentType: 'audio/mpeg', voice: 'edge-v', source: 'edge' as const}));
        const youdaoMock = vi.fn(async () => ({audio: new Uint8Array([2]).buffer, contentType: 'audio/mpeg', voice: 'youdao-v', source: 'youdao' as const}));
        const googleMock = vi.fn(async () => ({audio: new Uint8Array([3]).buffer, contentType: 'audio/mpeg', voice: 'google-v', source: 'google' as const}));
        const openAiMock = vi.fn(async () => ({audio: new Uint8Array([4]).buffer, contentType: 'audio/mpeg', voice: 'openai-v', source: 'openai' as const}));
        const localMock = vi.fn(async () => ({audio: new Uint8Array([5]).buffer, contentType: 'audio/wav' as const, voice: 'af_maple'}));
        const offscreenPlayMock = vi.fn(async (): Promise<void> => { throw new Error('no offscreen'); });
        const mockConfig = {
            selectionTtsMode: 'online-first',
            selectionTtsLocalVoice: 'auto',
            selectionTtsVoices: ['en-US-AvaMultilingualNeural'],
            selectionTtsRate: 1.25,
            selectionTtsOnlineSources: ['edge', 'youdao', 'google', 'openai'],
            selectionTtsOpenAiModel: 'gpt-4o-mini-tts',
            selectionTtsOpenAiVoice: 'alloy',
            proxy: {openai: ''},
            token: {openai: 'sk-123'},
            apiKeys: {},
        };
        vi.doMock('webextension-polyfill', () => ({
            default: {
                runtime: {id: 'rt-1', getURL: (path: string) => `chrome-extension://rt-1${path}`},
                tabs: {sendMessage: sendTabMessage},
            },
        }));
        vi.doMock('@/src/services/config/store', () => ({config: mockConfig}));
        vi.doMock('@/src/features/selection-translation/services/edgeTts', () => ({synthesizeEdgeTts: edgeMock}));
        vi.doMock('@/src/features/selection-translation/services/youdaoTts', () => ({synthesizeYoudaoTts: youdaoMock}));
        vi.doMock('@/src/features/selection-translation/services/googleTts', () => ({synthesizeGoogleTts: googleMock}));
        vi.doMock('@/src/features/selection-translation/services/openAiTts', () => ({synthesizeOpenAiTts: openAiMock}));
        vi.doMock('@/src/features/local-tts/background/offscreenAdapter', () => ({localTtsOffscreenAdapter: {synthesize: localMock}}));
        vi.doMock('@/src/features/selection-translation/background/offscreenAdapter', () => ({
            selectionTtsOffscreenAdapter: {
                fetchPageAudio: vi.fn(),
                play: offscreenPlayMock,
                stop: vi.fn(async () => undefined),
                seek: vi.fn(async () => true),
                pause: vi.fn(async () => true),
                resume: vi.fn(async () => true),
                setRate: vi.fn(async () => true),
            },
        }));
        try {
            const {createSelectionTtsRuntimeHandlers} = await import('@/src/app/background/selectionTtsRuntime');
            const runtimeRouter = createBackgroundMessageRouter(createSelectionTtsRuntimeHandlers({
                browser: 'chrome',
                manifestVersion: 3,
                offscreenDocument: true,
                extensionDom: true,
                selectionTtsExtensionPlayback: true,
                areaTranslation: true,
                imageTranslation: true,
                chromeTranslation: false,
                sidePanel: true,
            } as never) as never);
            // Triggers edge + offscreen warn fallback -> page audio!
            await expect(runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'hello', clientRequestId: 'rt-a'}, {sender: {tab: {id: 1}}})).resolves.toMatchObject({handled: true, response: {success: true, transport: 'page', voice: 'edge-v'}});
            expect(warnSpy).toHaveBeenCalled();

            // Exercise youdao, google, openai, local, and playbackState tab forwarding.
            mockConfig.selectionTtsOnlineSources = ['youdao'];
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'y', clientRequestId: 'rt-b'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            mockConfig.selectionTtsOnlineSources = ['google'];
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'g', clientRequestId: 'rt-c'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            mockConfig.selectionTtsOnlineSources = ['openai'];
            mockConfig.proxy.openai = '';
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'o0', clientRequestId: 'rt-d0'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            mockConfig.proxy.openai = 'https://proxy.test';
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'o', clientRequestId: 'rt-d'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            mockConfig.token.openai = '';
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'o2', clientRequestId: 'rt-d2'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            mockConfig.selectionTtsMode = 'local-only';
            await runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'l', clientRequestId: 'rt-e'}, {sender: {url: 'chrome-extension://rt-1/options.html'}});
            await expect(runtimeRouter.dispatch({type: SELECTION_TTS_MESSAGE_TYPE, text: 'bad rate', clientRequestId: 'rt-bad-rate', rate: 5}, {sender: {tab: {id: 1}}}))
                .rejects.toThrow('TTS 语速必须在 0.5 到 2.0 之间');
            await expect(runtimeRouter.dispatch({type: 'selectionTtsGoogle', text: 'blocked', clientRequestId: 'rt-f'}, {sender: {tab: {id: 1}}}))
                .resolves.toEqual({handled: true, response: {success: false, error: '当前处于仅本地朗读模式'}});
            mockConfig.selectionTtsMode = 'online-first';
            offscreenPlayMock.mockResolvedValueOnce(undefined);
            await expect(runtimeRouter.dispatch({type: 'selectionTtsGoogle', text: 'fast google', clientRequestId: 'rt-g', rate: 1.5}, {sender: {tab: {id: 1}}}))
                .resolves.toEqual({handled: true, response: {success: true, transport: 'offscreen'}});
            await runtimeRouter.dispatch({type: 'selectionTtsPlaybackState', tabId: 1, clientRequestId: 'rt-a', state: 'ended'}, {sender: {id: 'rt-1', url: 'chrome-extension://rt-1/offscreen.html'}});
            expect(youdaoMock).toHaveBeenCalledOnce();
            expect(googleMock).toHaveBeenCalledOnce();
            expect(openAiMock).toHaveBeenCalledTimes(3);
            expect(localMock).toHaveBeenCalledOnce();
            expect(sendTabMessage).toHaveBeenCalledOnce();
        } finally {
            warnSpy.mockRestore();
            vi.doUnmock('webextension-polyfill');
            vi.doUnmock('@/src/services/config/store');
            vi.doUnmock('@/src/features/selection-translation/services/edgeTts');
            vi.doUnmock('@/src/features/selection-translation/services/youdaoTts');
            vi.doUnmock('@/src/features/selection-translation/services/googleTts');
            vi.doUnmock('@/src/features/selection-translation/services/openAiTts');
            vi.doUnmock('@/src/features/local-tts/background/offscreenAdapter');
            vi.doUnmock('@/src/features/selection-translation/background/offscreenAdapter');
        }
    });
});
