/**
 * @file tests/ttsBackoffAndCache.test.ts
 * 文件职责：验证 TTS 纯领域退避分类、熔断器冷却、LRU 音频缓存与并发去重，以及扩展音色/语速/多源配置归一化。
 * 主要内容：覆盖 classifyTtsError 全部分支、computeTtsBackoffMs 抖动与 Retry-After、TtsCircuitBreaker 开关与半开探测及音色隔离、TtsAudioCache 字节与条数淘汰/TTL/并发去重与单等待者取消、以及 selectionTts 新配置规则。
 * 模块边界：只测试纯 core 模块，不触碰浏览器 API、Offscreen 或网络传输。
 */

import {describe, expect, it, vi} from 'vitest';
import {
    classifyTtsError,
    computeTtsBackoffMs,
    DEFAULT_TTS_CIRCUIT_POLICY,
    TtsCircuitBreaker,
} from '@/src/core/tts/backoff';
import {
    buildTtsAudioCacheKey,
    TtsAudioCache,
    type TtsCachedAudioPayload,
} from '@/src/core/tts/audioCache';
import {
    DEFAULT_SELECTION_TTS_ONLINE_SOURCES,
    DEFAULT_SELECTION_TTS_OPENAI_MODEL,
    DEFAULT_SELECTION_TTS_OPENAI_VOICE,
    DEFAULT_SELECTION_TTS_RATE,
    nextSelectionTtsRatePreset,
    normalizeSelectionTtsOnlineSources,
    normalizeSelectionTtsOpenAiModel,
    normalizeSelectionTtsOpenAiVoice,
    normalizeSelectionTtsRate,
    normalizeSelectionTtsVoiceOrder,
    SELECTION_TTS_VOICE_OPTIONS,
    selectionTtsPreviewText,
    selectionTtsVoiceLocale,
} from '@/src/core/config/selectionTts';
import {boundarySpeechProgress, speechTextTokens} from '@/src/core/tts/speechProgress';

function makePayload(size = 8, voice = 'en-US-AvaMultilingualNeural'): TtsCachedAudioPayload {
    return {
        audio: new Uint8Array(size).buffer,
        contentType: 'audio/mpeg',
        voice,
        source: 'edge',
    };
}

describe('TTS error classification and backoff policy', () => {
    it('classifies abort, timeout, unsupported, HTTP statuses, network and unknown errors', () => {
        const abort = Object.assign(new Error('cancelled'), {name: 'AbortError'});
        expect(classifyTtsError(abort)).toEqual({
            kind: 'abort', retryable: false, tripsSource: false, tripsVoice: false,
        });

        const timeoutByName = Object.assign(new Error('slow'), {name: 'TimeoutError'});
        expect(classifyTtsError(timeoutByName)).toMatchObject({kind: 'timeout', retryable: true, tripsSource: true});
        expect(classifyTtsError(new Error('请求超时'))).toMatchObject({kind: 'timeout', retryable: true});
        expect(classifyTtsError('request timed out')).toMatchObject({kind: 'timeout', retryable: true});

        expect(classifyTtsError(Object.assign(new Error('missing'), {code: 'local-tts-model-not-downloaded'})))
            .toMatchObject({kind: 'unsupported', retryable: false, tripsSource: false});
        expect(classifyTtsError(Object.assign(new Error('lang'), {code: 'local-tts-language-unsupported'})))
            .toMatchObject({kind: 'unsupported', tripsSource: false});
        expect(classifyTtsError(Object.assign(new Error('lang'), {code: 'tts-language-unsupported'})))
            .toMatchObject({kind: 'unsupported', tripsSource: false});
        expect(classifyTtsError(Object.assign(new Error('key'), {code: 'tts-openai-key-missing'})))
            .toMatchObject({kind: 'unsupported', tripsSource: false});
        expect(classifyTtsError(Object.assign(new Error('long'), {code: 'tts-text-too-long'})))
            .toMatchObject({kind: 'unsupported', tripsSource: false});
        expect(classifyTtsError(new Error('Google TTS text is too long')))
            .toMatchObject({kind: 'unsupported', tripsSource: false});
        expect(classifyTtsError(new Error('Edge TTS voice is unavailable for this language')))
            .toMatchObject({kind: 'unsupported', tripsSource: false});

        expect(classifyTtsError(Object.assign(new Error('429'), {statusCode: 429, retryAfterMs: 3_000})))
            .toEqual({kind: 'rate-limit', statusCode: 429, retryAfterMs: 3_000, retryable: true, tripsSource: true, tripsVoice: false});
        expect(classifyTtsError(Object.assign(new Error('401'), {statusCode: 401})))
            .toMatchObject({kind: 'auth', statusCode: 401, retryable: false, tripsSource: true});
        expect(classifyTtsError(Object.assign(new Error('403'), {statusCode: 403})))
            .toMatchObject({kind: 'auth', statusCode: 403, retryable: false, tripsSource: true});
        expect(classifyTtsError(Object.assign(new Error('503'), {statusCode: 503})))
            .toMatchObject({kind: 'server', statusCode: 503, retryable: true, tripsSource: true});
        expect(classifyTtsError(Object.assign(new Error('404'), {statusCode: 404})))
            .toMatchObject({kind: 'client', statusCode: 404, retryable: false, tripsSource: false, tripsVoice: true});

        expect(classifyTtsError(new TypeError('Failed to fetch'))).toMatchObject({kind: 'network', retryable: true, tripsSource: true});
        expect(classifyTtsError(new Error('ECONNRESET'))).toMatchObject({kind: 'network', retryable: true});
        expect(classifyTtsError(new Error('mystery failure'))).toMatchObject({kind: 'unknown', retryable: false, tripsSource: true});
        expect(classifyTtsError(Object.assign(new Error('redirect'), {statusCode: 302}))).toMatchObject({kind: 'unknown', statusCode: 302});
        expect(classifyTtsError(null)).toMatchObject({kind: 'unknown', retryable: false, tripsSource: true});
        expect(classifyTtsError({statusCode: -1, retryAfterMs: Number.NaN, name: '   ', code: ' '}))
            .toMatchObject({kind: 'unknown', statusCode: undefined, retryAfterMs: undefined});
    });

    it('computes jittered exponential backoff and respects bounded Retry-After', () => {
        expect(computeTtsBackoffMs(0, 'abort')).toBe(0);
        expect(computeTtsBackoffMs(0, 'auth')).toBe(0);
        expect(computeTtsBackoffMs(0, 'client')).toBe(0);
        expect(computeTtsBackoffMs(0, 'unsupported')).toBe(0);
        expect(computeTtsBackoffMs(0, 'unknown')).toBe(0);

        expect(computeTtsBackoffMs(0, 'rate-limit', 1_234.6)).toBe(1_235);
        expect(computeTtsBackoffMs(0, 'rate-limit', 99_999)).toBe(DEFAULT_TTS_CIRCUIT_POLICY.maxBackoffMs);
        expect(computeTtsBackoffMs(0, 'server', undefined, () => 0)).toBe(125);
        expect(computeTtsBackoffMs(0, 'server', undefined, () => 1)).toBe(250);
        expect(computeTtsBackoffMs(2, 'timeout', undefined, () => 1)).toBe(1_000);
        expect(computeTtsBackoffMs(10, 'network', undefined, () => 1)).toBe(DEFAULT_TTS_CIRCUIT_POLICY.maxBackoffMs);
        expect(computeTtsBackoffMs(Number.NaN, 'network', undefined, () => 0.5)).toBe(188);
        expect(computeTtsBackoffMs(0, 'network')).toBeGreaterThanOrEqual(125);
    });

    it('manages source cooldowns, half-open probes, EWMA latency, voice isolation and fallback selection', () => {
        let current = 1_000;
        const breaker = new TtsCircuitBreaker({now: () => current});

        expect(breaker.selectSources([])).toEqual([]);
        expect(breaker.canAttemptSource('edge')).toBe(true);
        expect(breaker.getSnapshot(['edge'])[0]).toEqual({
            source: 'edge',
            state: 'closed',
            consecutiveFailures: 0,
            cooldownRemainingMs: 0,
            ewmaLatencyMs: null,
            lastFailureKind: null,
        });

        // Non-tripping failures (abort / client / unsupported) do not open source circuit.
        breaker.recordSourceFailure('edge', Object.assign(new Error('400'), {statusCode: 400}));
        expect(breaker.canAttemptSource('edge')).toBe(true);

        // First server failure stays closed (threshold = 2), second trips cooldown.
        breaker.recordSourceFailure('edge', Object.assign(new Error('500'), {statusCode: 500}));
        expect(breaker.canAttemptSource('edge')).toBe(true);
        breaker.recordSourceFailure('edge', Object.assign(new Error('503'), {statusCode: 503}));
        expect(breaker.canAttemptSource('edge')).toBe(false);
        expect(breaker.getSnapshot(['edge'])[0]).toMatchObject({
            state: 'open',
            consecutiveFailures: 2,
            cooldownRemainingMs: 15_000,
            lastFailureKind: 'server',
        });

        // Rate-limit with Retry-After immediately trips with respected cooldown.
        breaker.recordSourceFailure('google', Object.assign(new Error('429'), {statusCode: 429, retryAfterMs: 45_000}));
        expect(breaker.canAttemptSource('google')).toBe(false);
        expect(breaker.getSnapshot(['google'])[0]?.cooldownRemainingMs).toBe(45_000);

        // Select skips open sources; when all open, sorts non-probing sources by ascending remaining cooldown.
        expect(breaker.selectSources(['edge', 'youdao', 'google'])).toEqual(['youdao']);
        breaker.recordSourceFailure('youdao', Object.assign(new Error('401'), {statusCode: 401}));
        expect(breaker.selectSources(['google', 'edge'])).toEqual(['edge', 'google']);
        expect(breaker.selectSources(['edge', 'google'])).toEqual(['edge', 'google']);
        expect(breaker.selectSources(['google', 'openai'])).toEqual(['openai']);

        // Half-open probe in flight is excluded from cooled fallback unless all sources are probing.
        current += 15_000;
        expect(breaker.getSnapshot(['edge'])[0]?.state).toBe('half-open');
        expect(breaker.canAttemptSource('edge')).toBe(true);
        breaker.beginAttempt('edge');
        expect(breaker.canAttemptSource('edge')).toBe(false);
        expect(breaker.selectSources(['edge', 'google'])).toEqual(['google']);
        expect(breaker.selectSources(['edge'])).toEqual(['edge']);
        // While edge is probing, cooled fallback sorts remaining non-probing sources by ascending remaining cooldown.
        current -= 10_000;
        expect(breaker.selectSources(['google', 'edge', 'youdao'])).toEqual(['youdao', 'google']);
        current += 10_000;
        breaker.cancelAttempt('edge');
        expect(breaker.canAttemptSource('edge')).toBe(true);
        breaker.beginAttempt('edge');
        breaker.recordSourceSuccess('edge', 200);
        breaker.recordSourceSuccess('edge', 100);
        breaker.recordSourceSuccess('edge');
        expect(breaker.getSnapshot(['edge'])[0]).toMatchObject({
            state: 'closed',
            consecutiveFailures: 0,
            cooldownRemainingMs: 0,
            ewmaLatencyMs: 170,
        });

        // Voice-level cooldown deprioritizes bad voice, expires cleanly, and falls back if all cooled.
        breaker.recordVoiceFailure('   ');
        breaker.recordVoiceFailure('en-US-AriaNeural');
        expect(breaker.orderVoices(['en-US-AriaNeural', 'en-US-AvaMultilingualNeural']))
            .toEqual(['en-US-AvaMultilingualNeural', 'en-US-AriaNeural']);
        expect(breaker.orderVoices(['en-US-AriaNeural'])).toEqual(['en-US-AriaNeural']);
        current += DEFAULT_TTS_CIRCUIT_POLICY.voiceCooldownMs;
        expect(breaker.isVoiceInCooldown('en-US-AriaNeural')).toBe(false);

        // Cancel on unseen source is safe, and reset clears everything.
        breaker.cancelAttempt('openai');
        breaker.reset();
        expect(breaker.canAttemptSource('google')).toBe(true);
        expect(new TtsCircuitBreaker().canAttemptSource('edge')).toBe(true);
    });
});

describe('TTS bounded LRU audio cache and in-flight coalescing', () => {
    it('builds deterministic cache keys and enforces LRU, byte budget, max entry size and TTL', () => {
        let now = 10_000;
        const cache = new TtsAudioCache({
            maxEntries: 2,
            maxBytes: 20,
            maxEntryBytes: 12,
            ttlMs: 1_000,
            now: () => now,
        });

        const keyA = buildTtsAudioCacheKey({
            mode: 'online-first',
            sourceScope: 'edge,youdao',
            language: 'en_US',
            voiceKey: 'auto',
            rate: 1.25,
            text: '  Hello  ',
        });
        expect(keyA).toBe('online-first|edge,youdao|en-us|auto|r125|Hello');

        expect(cache.set('empty', makePayload(0))).toBe(false);
        expect(cache.set('too-big', makePayload(13))).toBe(false);
        expect(cache.get('missing')).toBeUndefined();

        expect(cache.set('a', makePayload(10, 'voice-a'))).toBe(true);
        expect(cache.set('b', makePayload(10, 'voice-b'))).toBe(true);
        // Touch 'a' so 'b' becomes LRU.
        expect(cache.get('a')?.voice).toBe('voice-a');
        // Adding 'c' evicts 'b' by entry & byte budget.
        expect(cache.set('c', makePayload(10, 'voice-c'))).toBe(true);
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')?.voice).toBe('voice-a');
        expect(cache.get('c')?.voice).toBe('voice-c');

        // Updating an existing key replaces bytes cleanly.
        expect(cache.set('c', makePayload(8, 'voice-c2'))).toBe(true);
        expect(cache.stats()).toMatchObject({entries: 2, bytes: 18});

        // TTL expiry purges on get and stats.
        now += 1_000;
        expect(cache.get('a')).toBeUndefined();
        expect(cache.stats().entries).toBe(0);

        cache.clear();
        expect(new TtsAudioCache().stats().entries).toBe(0);
    });

    it('coalesces concurrent synthesis and only aborts shared work when all waiters abort', async () => {
        const cache = new TtsAudioCache();
        let resolveFirst!: (payload: TtsCachedAudioPayload) => void;
        let sharedSignal: AbortSignal | undefined;
        const producer = vi.fn((signal: AbortSignal) => {
            sharedSignal = signal;
            return new Promise<TtsCachedAudioPayload>((resolve) => { resolveFirst = resolve; });
        });

        const preAborted = new AbortController();
        preAborted.abort();
        await expect(cache.getOrSynthesize('k', producer, preAborted.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(producer).not.toHaveBeenCalled();

        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = cache.getOrSynthesize('k', producer, firstController.signal);
        const second = cache.getOrSynthesize('k', producer, secondController.signal);
        expect(producer).toHaveBeenCalledOnce();
        expect(cache.stats().coalesced).toBe(1);

        // First waiter cancels, but second waiter keeps shared synthesis alive.
        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(sharedSignal?.aborted).toBe(false);

        const payload = makePayload(6, 'shared');
        resolveFirst(payload);
        await expect(second).resolves.toEqual({payload, cached: false});
        // Subsequent call hits cache with 0 producer calls.
        await expect(cache.getOrSynthesize('k', producer)).resolves.toEqual({payload, cached: true});
        expect(producer).toHaveBeenCalledOnce();

        // Single waiter aborting cancels underlying producer signal.
        let soloSignal: AbortSignal | undefined;
        const soloController = new AbortController();
        const solo = cache.getOrSynthesize('k2', (signal) => {
            soloSignal = signal;
            return new Promise<TtsCachedAudioPayload>(() => undefined);
        }, soloController.signal);
        soloController.abort();
        await expect(solo).rejects.toMatchObject({name: 'AbortError'});
        expect(soloSignal?.aborted).toBe(true);

        // Producer failure (async, sync, and with caller AbortSignal) rejects waiter and does not cache.
        await expect(cache.getOrSynthesize('k3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(cache.getOrSynthesize('k3-sync', () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
        await expect(cache.getOrSynthesize('k3-sig', async () => { throw new Error('sig boom'); }, new AbortController().signal)).rejects.toThrow('sig boom');
        expect(cache.get('k3')).toBeUndefined();

        // Waiter with AbortSignal resolves normally when producer resolves first.
        const okController = new AbortController();
        await expect(cache.getOrSynthesize('k-ok', async () => makePayload(4, 'ok'), okController.signal))
            .resolves.toMatchObject({cached: false});
        okController.abort();

        // Fallback audio is NOT cached so degraded output never poisons the primary cache key.
        await expect(cache.getOrSynthesize('k-fallback', async () => ({
            ...makePayload(4, 'Youdao'),
            source: 'youdao',
            fallbackFrom: 'edge',
        }))).resolves.toMatchObject({cached: false});
        expect(cache.get('k-fallback')).toBeUndefined();

        // clear() aborts in-flight tasks cleanly and prevents late resolves from repopulating cache.
        let lateResolve!: (payload: TtsCachedAudioPayload) => void;
        const lateTask = cache.getOrSynthesize('k-late', () => new Promise<TtsCachedAudioPayload>((resolve) => { lateResolve = resolve; }));
        cache.clear();
        lateResolve(makePayload(4, 'stale'));
        await expect(lateTask).resolves.toMatchObject({cached: false});
        expect(cache.get('k-late')).toBeUndefined();

        let clearSignal: AbortSignal | undefined;
        const clearing = cache.getOrSynthesize('k4', (signal) => {
            clearSignal = signal;
            return new Promise<TtsCachedAudioPayload>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(Object.assign(new Error('cleared'), {name: 'AbortError'})));
            });
        });
        cache.clear();
        expect(clearSignal?.aborted).toBe(true);
        await expect(clearing).rejects.toMatchObject({name: 'AbortError'});
    });
});

describe('expanded selection TTS config normalization and boundary tokens reuse', () => {
    it('normalizes rate, online source order, OpenAI model/voice and preview samples', () => {
        expect(normalizeSelectionTtsRate(undefined)).toBe(DEFAULT_SELECTION_TTS_RATE);
        expect(normalizeSelectionTtsRate('')).toBe(DEFAULT_SELECTION_TTS_RATE);
        expect(normalizeSelectionTtsRate('1.25')).toBe(1.25);
        expect(normalizeSelectionTtsRate(0.1)).toBe(0.5);
        expect(normalizeSelectionTtsRate(5)).toBe(2);
        expect(normalizeSelectionTtsRate(1.333)).toBe(1.33);

        expect(nextSelectionTtsRatePreset(0.75)).toBe(1);
        expect(nextSelectionTtsRatePreset(1)).toBe(1.25);
        expect(nextSelectionTtsRatePreset(2)).toBe(0.75);

        expect(normalizeSelectionTtsOnlineSources(null)).toEqual(DEFAULT_SELECTION_TTS_ONLINE_SOURCES);
        expect(normalizeSelectionTtsOnlineSources([])).toEqual(DEFAULT_SELECTION_TTS_ONLINE_SOURCES);
        expect(normalizeSelectionTtsOnlineSources(['openai', 'edge', 'edge', 'bad', 123])).toEqual(['openai', 'edge']);

        expect(normalizeSelectionTtsOpenAiModel('tts-1-hd')).toBe('tts-1-hd');
        expect(normalizeSelectionTtsOpenAiModel('invalid')).toBe(DEFAULT_SELECTION_TTS_OPENAI_MODEL);
        expect(normalizeSelectionTtsOpenAiVoice('nova')).toBe('nova');
        expect(normalizeSelectionTtsOpenAiVoice('invalid')).toBe(DEFAULT_SELECTION_TTS_OPENAI_VOICE);

        expect(SELECTION_TTS_VOICE_OPTIONS.some((v) => v.locale === 'ru-RU')).toBe(true);
        expect(normalizeSelectionTtsVoiceOrder(['ru-RU-SvetlanaNeural', 'unknown'])).toEqual(['ru-RU-SvetlanaNeural']);
        expect(selectionTtsVoiceLocale('ru-RU-SvetlanaNeural')).toBe('ru-RU');

        expect(selectionTtsPreviewText('zh-TW')).toContain('語音');
        expect(selectionTtsPreviewText('zh-CN')).toContain('语音');
        expect(selectionTtsPreviewText('ru-RU')).toContain('FluentRead');
        expect(selectionTtsPreviewText('xx-ZZ')).toContain('FluentRead');
        expect(selectionTtsPreviewText('')).toContain('FluentRead');

        const text = 'Hello world';
        const tokens = speechTextTokens(text);
        expect(boundarySpeechProgress(text, 6, 5, tokens)).toEqual({start: 6, end: 11, fraction: 1, estimated: false});
    });
});
