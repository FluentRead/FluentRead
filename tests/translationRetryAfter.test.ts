import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {writeFileSync} from 'node:fs';

const state = vi.hoisted(() => ({
    areaDispatch: async (_request: any): Promise<any> => undefined,
    config: {
        service: 'custom', from: 'en', to: 'zh-Hans', useCache: false, enableAIContext: false,
        token: {custom: 'fixture-a', newapi: 'fixture-b', doubao: 'fixture-doubao'}, model: {custom: 'fixture-model', newapi: 'fixture-model', doubao: 'doubao-seed-1-6-250615'},
        customModel: {}, proxy: {}, custom: 'https://quota-a.test/v1', newApiUrl: 'https://healthy-b.test/v1',
        deeplx: '', azureOpenaiEndpoint: '', minimaxBillingPlan: 'payg', minimaxRegion: 'cn',
        mimoBillingPlan: 'payg', mimoRegion: 'cn', customBody: {}, customHeaders: {}, system_role: {}, user_role: {},
        deepseekApiType: 'auto', deepseekThinkingMode: 'disabled', requireApiKey: {}, secret: {},
        youdaoAppKey: '', youdaoAppSecret: '', tencentSecretId: '', tencentSecretKey: '',
        translationMaxRetries: 2, maxConcurrentTranslations: 6,
        translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
    },
    dispatch: async (_message: unknown): Promise<unknown> => undefined,
}));
vi.mock('@/src/services/config/store', () => ({
    config: state.config, requestConfigCountIncrement: async () => 0,
}));
vi.mock('@/src/app/translation/runtime', () => ({translateWithCache: (request: any) => state.areaDispatch(request)}));
vi.mock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: async () => ({})}}));
vi.mock('@/src/features/area-translation/background/offscreenAdapter', () => ({areaTranslationOffscreenAdapter: {cropArea: async () => ({image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mIAAAAASUVORK5CYII=', lines: []}), translateArea: async () => ({image: '', lines: []})}}));
vi.mock('@/src/features/image-translation/background/offscreenAdapter', () => ({imageTranslationProgressTransport: {sendProgress: async () => undefined}}));
vi.mock('@/src/app/background/handlers/areaTranslation', async importOriginal => ({...await importOriginal<any>(), createAreaTranslationBackgroundHandlers: (dependencies: any) => dependencies, createAreaCaptureOwnershipVerifier: () => async () => undefined}));
vi.mock('@/src/providers/translation/registry', async () => ({translationProviderRegistry: {custom: (await import('@/src/providers/translation/ai-sdk/openai-compatible')).translateWithOpenAICompatibleAiSdk}}));
vi.mock('webextension-polyfill', () => ({default: {
    runtime: {sendMessage: (message: unknown) => state.dispatch(message)}, extension: {inIncognitoContext: false},
}}));

import {createTranslationBroker} from '@/src/services/translation/broker';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {translateWithOpenAICompatibleAiSdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {AI_SDK_TRANSPORT_PROFILE, resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {createTranslationRequestFallback, createTranslationRequestRegistry, createTranslationCancelHandler, type TranslationRequestContext} from '@/src/app/background/handlers/translation';
import {createAreaTranslationBackgroundHandlers as createActualAreaHandlers, AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE} from '@/src/features/area-translation/background/handlers';
import {createInputBoxTranslationHandler} from '@/src/features/input-translation/background/handler';
import {createImageGlossaryContext} from '@/src/app/background/imageGlossaryContext';
import {createImageTranslationBackgroundHandlers, IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE} from '@/src/features/image-translation/background/handlers';
import {buildGlossaryRevision} from '@/src/core/glossary';
import {translationPrivacyContext, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {runTranslationServiceConnectionTest, CONNECTION_TEST_ORIGIN} from '@/src/providers/translation/connectionTest';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {servicesType, resolveConfiguredModel, customModelString} from '@/src/core/config/catalog';
import {translateText, cancelAllTranslations} from '@/src/app/translation/client';
import {setRuntimeFetch as installRuntimeFetch, type RuntimeFetch} from '@/src/platform/http/runtime';
import {attachTranslationRequestControl} from '@/src/services/translation/requestSnapshot';
import type {TranslationConfigSource} from '@/src/services/translation/types';

function setRuntimeFetch(transport?: RuntimeFetch) {
    installRuntimeFetch(transport ? async (input, init) => {
        if (!['https://quota-a.test/v1/chat/completions', 'https://quota-c.test/v1/chat/completions',
            'https://healthy-b.test/v1/chat/completions', 'https://doubao.test/api/v3/responses',
            'https://doubao.test/api/v3'].includes(String(input))) throw new Error('Unmatched runtime network prohibited');
        return transport(input, init);
    } : undefined);
}

function response(status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(status === 200 ? {
        choices: [{message: {role: 'assistant', content: '这是合成译文。'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 4, completion_tokens: 3, total_tokens: 7},
    } : {error: {message: 'synthetic response'}}), {status, headers: {'content-type': 'application/json', ...headers}});
}

function harness(provider?: (request: any) => Promise<any>, providerRegistry?: Record<string, any>) {
    const scheduler = createTranslationRequestScheduler(() => state.config);
    const writes: unknown[] = [];
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => state.config as TranslationConfigSource,
        providers: providerRegistry ?? {custom: (provider ?? translateWithOpenAICompatibleAiSdk) as never, newapi: (provider ?? translateWithOpenAICompatibleAiSdk) as never},
        cache: {get: async () => null, set: async (...args: unknown[]) => {writes.push(args); return true;}, clear: async () => undefined, cleanup: async () => undefined},
        serviceTypes: servicesType, endpointResolver: {resolveOpenAICompatibleEndpoint, aiSdkTransportProfile: AI_SDK_TRANSPORT_PROFILE},
        promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: () => ({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}),
        resolveConfiguredModel, buildTranslationCacheKey: JSON.stringify, requestScheduler: scheduler,
    });
    const registry = createTranslationRequestRegistry();
    const fallback = createTranslationRequestFallback<TranslationRequestContext>({translate: broker.translateWithCache, serializeError: serializeTranslationError, requestRegistry: registry});
    const cancel = createTranslationCancelHandler(registry);
    state.dispatch = (message) => {
        const context = {sender: {id: 'fixture-extension', tab: {id: 1, incognito: false}}};
        const candidate = message as Record<string, unknown>;
        return candidate.type ? Promise.resolve(cancel.handle(candidate as never, context))
            : fallback.handle(candidate as never, context) as Promise<unknown>;
    };
    return {scheduler, broker, writes, fallback};
}

async function flush() {
    // Node Response.clone() streams also settle through the real event loop.
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function client(origin: string, serviceOverride = 'custom', timeout = 125_000, signal = new AbortController().signal) {
    return translateText(origin, 'synthetic benchmark', {
        serviceOverride, timeout, signal, skipLanguageDetection: true, pageContext: '', enableAIContext: false, useCache: false,
    });
}

beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => {throw new Error('Unmatched real network prohibited');}));
    state.config.custom = 'https://quota-a.test/v1'; state.config.newApiUrl = 'https://healthy-b.test/v1';
    state.config.model.custom = 'fixture-model'; state.config.token.custom = 'fixture-a';
    state.config.translationRequestsPerSecond = 0; state.config.translationRequestsPerMinute = 0;
    (state.config as any).serviceRequestLimits = {}; (state.config as any).modelRequestLimits = {};
    state.config.proxy = {}; state.config.customBody = {};
    state.config.customHeaders = {}; (state.config as any).apiKeys = {}; (state.config as any).apiKeyRotationEnabled = {};
    state.config.translationMaxRetries = 2; state.config.maxConcurrentTranslations = 6;
    setRuntimeFetch(async () => {throw new Error('Unmatched runtime network prohibited');});
});
afterEach(async () => {cancelAllTranslations(); if (vi.isFakeTimers()) await vi.runAllTimersAsync(); await flush(); setRuntimeFetch(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('shared Retry-After real client/broker/SDK transport replay', () => {
    it('replays 30 fixed seeds with identical arrivals and server quota windows', async () => {
        const cases: unknown[] = [];
        for (let seed = 1; seed <= 30; seed += 1) {
            harness();
            const start = Date.now(); const delay = [2_000, 60_000, 90_000][(seed - 1) % 3]!;
            const attempts: Array<{scope: string; at: number; status: number; bodyBytes: number}> = [];
            let unmatched = 0;
            setRuntimeFetch(async (input, init) => {
                const url = String(input);
                const scope = url === 'https://quota-a.test/v1/chat/completions' ? 'A'
                    : url === 'https://healthy-b.test/v1/chat/completions' ? 'B' : '';
                if (!scope) {unmatched += 1; throw new Error('Unmatched network prohibited');}
                const at = Date.now() - start; const status = scope === 'A' && at < delay ? 429 : 200;
                attempts.push({scope, at, status, bodyBytes: new TextEncoder().encode(String(init?.body)).byteLength});
                return response(status, status === 429 ? {'retry-after': String(delay / 1000)} : {});
            });
            const jobs: Array<Promise<boolean>> = [];
            const add = (id: string, service: string) => jobs.push(client(id, service).then(() => true, () => false));
            add(`seed ${seed} original alpha`, 'custom');
            await vi.advanceTimersByTimeAsync(100 + seed % 13);
            add(`seed ${seed} next alpha`, 'custom');
            add(`seed ${seed} healthy beta`, 'newapi');
            await vi.advanceTimersByTimeAsync(100 + seed % 17);
            add(`seed ${seed} final alpha`, 'custom');
            await vi.runAllTimersAsync(); await flush();
            const outcomes = await Promise.all(jobs);
            expect(unmatched).toBe(0); expect(attempts.filter(x => x.scope === 'B')).toHaveLength(1);
            expect(outcomes[2]).toBe(true);
            if ((process.env.FLUENTREAD_COOLDOWN_VARIANT ?? 'C') === 'C') {
                expect(outcomes).toEqual([true, true, true, true]);
                expect(attempts.filter(x => x.scope === 'A' && x.at > 0 && x.at < delay)).toHaveLength(0);
            }
            cases.push({seed, delay, outcomes, attempts, successes: outcomes.filter(Boolean).length,
                healthyAttempts: attempts.filter(x => x.scope === 'B').length,
                healthyBodyBytes: attempts.filter(x => x.scope === 'B').reduce((sum, x) => sum + x.bodyBytes, 0),
                leakedDispatches: attempts.filter(x => x.scope === 'A' && x.at > 0 && x.at < delay).length});
        }
        const replay = {variant: process.env.FLUENTREAD_COOLDOWN_VARIANT ?? 'C', seeds: 30, cases};
        if (process.env.FLUENTREAD_COOLDOWN_EVIDENCE) writeFileSync(process.env.FLUENTREAD_COOLDOWN_EVIDENCE, JSON.stringify(replay, null, 2));
    }, 30_000);

    it.each([
        [429, {'retry-after': '2'}, 2000],
        [429, {'retry-after': '60'}, 60_000],
        [429, {'retry-after': '90'}, 90_000],
        [429, {'retry-after': 'Thu, 01 Jan 2026 00:00:02 GMT'}, 2000],
        [429, {'retry-after-ms': '250', 'retry-after': '90'}, 250],
        [503, {'retry-after': '2'}, 2000],
        [503, {'retry-after-ms': '125', 'retry-after': '90'}, 125],
        [503, {'retry-after-ms': 'invalid', 'retry-after': '2'}, 2000],
    ])('gates fresh calls and locked SDK retries on HTTP %s headers %j', async (status, headers, delay) => {
        harness(); const attempts: number[] = []; const start = Date.now();
        setRuntimeFetch(async input => {
            if (String(input) !== 'https://quota-a.test/v1/chat/completions') throw new Error('Unmatched network');
            attempts.push(Date.now() - start);
            return response(attempts.length === 1 ? status : 200, headers as Record<string, string>);
        });
        const original = client('original alpha').catch(() => 'failed');
        await vi.advanceTimersByTimeAsync(5);
        const next = client('second alpha').catch(() => 'failed');
        await vi.advanceTimersByTimeAsync(delay - 6);
        expect(attempts).toEqual([0]);
        await vi.runAllTimersAsync();
        expect(await original).toBe('这是合成译文。'); expect(await next).toBe('这是合成译文。');
        expect(attempts).toHaveLength(3); expect(attempts.slice(1).every(at => at >= delay)).toBe(true);
    });

    it.each([
        [503, {}, 0], [503, {'retry-after': '-1'}, 0], [503, {'retry-after': 'junk'}, 0],
        [503, {'retry-after': 'Infinity'}, 0], [503, {'retry-after': '2junk'}, 0],
        [503, {'retry-after': '0'}, 0], [503, {'retry-after-ms': '0'}, 0],
        [503, {'retry-after': 'Wed, 31 Dec 2025 23:59:00 GMT'}, 0],
        [503, {'retry-after': '9999999999'}, 7 * 86_400_000],
        [429, {}, 2000], [429, {'retry-after': '-1'}, 2000],
        [429, {'retry-after-ms': 'NaN'}, 2000],
        [401, {'retry-after': '90'}, 0], [403, {'retry-after': '90'}, 0], [200, {'retry-after': '90'}, 0],
    ])('bounds or ignores malformed/extreme signals %s %j', async (status, headers, delay) => {
        const {scheduler} = harness(); const identity = {service: 'custom', quotaScope: 'synthetic-scope'};
        scheduler.observeResponse(identity, response(status, headers as Record<string, string>));
        let started = false;
        const task = scheduler.scheduleAttempt(async () => {started = true;}, {identity});
        await flush(); expect(started).toBe(delay === 0);
        if (delay) {await vi.advanceTimersByTimeAsync(delay - 1); expect(started).toBe(false);}
        await vi.runAllTimersAsync(); await task; expect(started).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([503, 429, 401, 403])('preserves SDK retry responsibility/count on repeated HTTP %s', async status => {
        harness(); let attempts = 0;
        setRuntimeFetch(async input => {
            if (String(input) !== 'https://quota-a.test/v1/chat/completions') throw new Error('Unmatched network');
            attempts += 1;
            return response(status, status === 429 ? {'retry-after': '2'} : {});
        });
        const outcome = client('repeated error alpha').then(() => 'success', () => 'error');
        await vi.runAllTimersAsync(); expect(await outcome).toBe('error');
        expect(attempts).toBe(status === 401 || status === 403 ? 1 : 3);
    });

    it('stops over-deadline requests and cancels queued cooldown work without late dispatch', async () => {
        const {writes} = harness(); let attempts = 0;
        setRuntimeFetch(async input => {
            if (String(input) !== 'https://quota-a.test/v1/chat/completions') throw new Error('Unmatched network');
            attempts += 1; return response(429, {'retry-after': '90'});
        });
        const first = client('short deadline alpha', 'custom', 4000).then(() => 'success', () => 'error');
        await vi.advanceTimersByTimeAsync(10);
        const controller = new AbortController();
        const cancelled = client('cancelled queue alpha', 'custom', 125_000, controller.signal).then(() => 'success', () => 'cancelled');
        const short = client('queued short deadline alpha', 'custom', 4000).then(() => 'success', () => 'error');
        await vi.advanceTimersByTimeAsync(20); controller.abort();
        expect(await cancelled).toBe('cancelled');
        await vi.advanceTimersByTimeAsync(4000);
        expect(await first).toBe('error'); expect(await short).toBe('error'); expect(attempts).toBe(1);
        await vi.runAllTimersAsync(); expect(attempts).toBe(1); expect(writes).toEqual([]);
        setRuntimeFetch(async () => {attempts += 1; return response();});
        const afterExpiry = client('fresh after expiry alpha');
        await vi.runAllTimersAsync(); expect(await afterExpiry).toBe('这是合成译文。'); expect(attempts).toBe(2);
    });

    it.each(['private', 'endpoint', 'model', 'credential', 'header'])('separates trusted quota identity after %s changes', async change => {
        const {fallback, scheduler} = harness(); state.config.translationMaxRetries = 0;
        const observed = vi.spyOn(scheduler, 'observeResponse'); let attempts = 0;
        setRuntimeFetch(async input => {
            if (!['https://quota-a.test/v1/chat/completions', 'https://quota-c.test/v1/chat/completions'].includes(String(input))) throw new Error('Unmatched network');
            attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});
        });
        const first = client('first ordinary alpha').catch(() => 'error');
        await vi.advanceTimersByTimeAsync(10); expect(await first).toBe('error');
        if (change === 'endpoint') state.config.custom = 'https://quota-c.test/v1';
        if (change === 'model') state.config.model.custom = 'other-fixture-model';
        if (change === 'credential') state.config.token.custom = 'other-fixture-credential';
        if (change === 'header') (state.config.customHeaders as Record<string, string>).custom = '{"X-Synthetic-Quota":"other"}';
        const next = fallback.handle({origin: 'next alpha', useCache: false, requestTimeoutMs: 1000} as never,
            {sender: {tab: {id: 2, incognito: change === 'private'}}});
        await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(2); expect(await next).toBe('这是合成译文。');
        const scopes = observed.mock.calls.map(x => x[0]?.quotaScope);
        expect(scopes[0]).toMatch(/^[a-f0-9]{64}$/u); expect(scopes[1]).not.toBe(scopes[0]);
        expect(JSON.stringify(observed.mock.calls.map(x => x[0]))).not.toContain('fixture-credential');
        expect(JSON.stringify(observed.mock.calls.map(x => x[0]))).not.toContain('fixture-a');
    });

    it('rejects page-supplied quota/privacy fields while preserving trusted sender isolation', async () => {
        const {fallback} = harness(); state.config.translationMaxRetries = 0; let attempts = 0;
        setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const first = client('ordinary quota alpha').catch(() => undefined);
        await vi.advanceTimersByTimeAsync(10); await first;
        const forged = fallback.handle({origin: 'forged alpha', quotaScope: 'fresh', privateContext: true, requestTimeoutMs: 1000} as never,
            {sender: {tab: {id: 1, incognito: false}}});
        await vi.advanceTimersByTimeAsync(1100); await forged; expect(attempts).toBe(1);
        const privateCall = fallback.handle({origin: 'real private alpha', requestTimeoutMs: 1000} as never,
            {sender: {tab: {id: 2, incognito: true}}});
        await vi.advanceTimersByTimeAsync(10); expect(await privateCall).toBe('这是合成译文。'); expect(attempts).toBe(2);
    });

    it('keeps the physical attempt until a cancelled real transport actually settles', async () => {
        const {broker, writes} = harness(); state.config.maxConcurrentTranslations = 1; state.config.translationMaxRetries = 0;
        let settle!: (response: Response) => void; let attempts = 0;
        setRuntimeFetch(async () => {
            attempts += 1;
            return attempts === 1 ? new Promise<Response>(resolve => {settle = resolve;}) : response();
        });
        const controller = new AbortController();
        const first = broker.translateWithCache(attachTranslationRequestControl({origin: 'cancel in flight alpha', useCache: true, requestTimeoutMs: 5000},
            {signal: controller.signal, ownershipKey: 'synthetic-owner'})).catch(() => 'cancelled');
        await vi.advanceTimersByTimeAsync(10); controller.abort(); expect(await first).toBe('cancelled');
        const second = client('healthy queued beta', 'newapi');
        await vi.advanceTimersByTimeAsync(100); expect(attempts).toBe(1);
        settle(response()); await vi.runAllTimersAsync();
        expect(await second).toBe('这是合成译文。'); expect(attempts).toBe(2); expect(writes).toEqual([]);
    });

    it('uses a small real timer integration through the locked SDK and shared scheduler', async () => {
        vi.useRealTimers(); harness(); let attempts = 0; const started: number[] = [];
        setRuntimeFetch(async () => {
            started.push(Date.now()); attempts += 1;
            return response(attempts === 1 ? 429 : 200, {'retry-after-ms': '30'});
        });
        expect(await client('real timer integration alpha')).toBe('这是合成译文。');
        expect(attempts).toBe(2); expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(25);
    });
});


describe('review counterexamples: physical capacity and trusted pending identity', () => {
    it.each([1, 3])('releases all %s saturated logical leases during a 90-second quota wait', async cap => {
        state.config.maxConcurrentTranslations = cap; const {fallback} = harness(); const start = Date.now();
        // Independent pages have independent client queues; inject each trusted page at the real message boundary.
        const invoke = (origin: string, serviceOverride = 'custom', requestTimeoutMs = 125_000) => Promise.resolve(fallback.handle({origin, serviceOverride, requestTimeoutMs, useCache: false} as never, {sender: {tab: {id: origin.length, incognito: false}}}));
        const attempts: Array<{service: string; at: number}> = []; let active = 0; let peak = 0;
        setRuntimeFetch(async input => {
            active += 1; peak = Math.max(peak, active);
            const at = Date.now() - start; const service = String(input).includes('healthy-b') ? 'B' : 'A';
            attempts.push({service, at}); await Promise.resolve(); active -= 1;
            return response(service === 'A' && at < 90_000 ? 429 : 200, {'retry-after': '90'});
        });
        const alpha = Array.from({length: cap}, (_, i) => invoke(`saturated alpha ${i}`).catch(() => 'error'));
        await vi.advanceTimersByTimeAsync(10);
        const beta = invoke('healthy with 40-second deadline', 'newapi', 40_000).catch(() => 'error');
        await vi.advanceTimersByTimeAsync(10);
        expect(attempts.some(x => x.service === 'B' && x.at < 40_010), JSON.stringify(attempts)).toBe(true);
        expect(await beta).toBe('这是合成译文。');
        expect(attempts.filter(x => x.service === 'A' && x.at > 0 && x.at < 90_000)).toEqual([]);
        await vi.runAllTimersAsync(); expect(await Promise.all(alpha)).toEqual(Array(cap).fill('这是合成译文。'));
        expect(peak).toBeLessThanOrEqual(cap); expect(attempts.filter(x => x.service === 'A' && x.at >= 90_000)).toHaveLength(cap);
    });

    it.each(['single', 'batch', 'summary'].flatMap(kind => ['privacy', 'credential', 'key-set', 'rotation'].map(change => [kind, change])))('keeps concurrent same-text %s pending work separate after %s changes', async (kind, change) => {
        {
            state.config.token.custom = 'fixture-a'; (state.config as any).apiKeys = {}; (state.config as any).apiKeyRotationEnabled = {};
            if (change === 'key-set' || change === 'rotation') (state.config as any).apiKeys.custom = ['fixture-a', 'fixture-extra'];
            const waiting: Array<() => void> = []; let calls = 0;
            const {fallback} = harness(async request => {
                calls += 1; await new Promise<void>(resolve => waiting.push(resolve));
                return Array.isArray(request.origin) ? request.origin.map(() => '这是合成译文。') : '这是合成译文。';
            });
            const message = {origin: kind === 'batch' ? ['same alpha', 'same beta'] : 'same alpha', useCache: false,
                enableAIContext: kind === 'summary', pageContext: kind === 'summary' ? 'same synthetic paragraph' : '', requestTimeoutMs: 5000};
            const a = fallback.handle(message as never, {sender: {tab: {id: 1, incognito: false}}});
            await vi.advanceTimersByTimeAsync(10); expect(calls).toBe(1);
            if (change === 'credential') state.config.token.custom = 'other-fixture-credential';
            if (change === 'key-set') (state.config as any).apiKeys.custom = ['fixture-a', 'changed-fixture-extra'];
            if (change === 'rotation') (state.config as any).apiKeyRotationEnabled.custom = false;
            const b = fallback.handle(message as never, {sender: {tab: {id: 2, incognito: change === 'privacy'}}});
            await vi.advanceTimersByTimeAsync(10); expect(calls).toBe(2);
            for (const release of waiting.splice(0)) release();
            await vi.advanceTimersByTimeAsync(10);
            for (const release of waiting.splice(0)) release();
            await vi.runAllTimersAsync(); await Promise.all([a, b]);
        }
    });

    it.each([false, true])('binds typed input privacy from sender %s and rejects payload claims', async firstPrivate => {
        const {broker} = harness(); state.config.translationMaxRetries = 0; let attempts = 0;
        setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const input = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => state.config as never, translate: broker.translateWithCache});
        const invoke = (text: string, incognito: boolean) => (input.handle as any)({type: 'inputBoxTranslation', text, targetLang: 'zh-Hans', privateContext: !incognito, quotaScope: 'forged'}, {sender: {tab: {incognito}}});
        const a = invoke('typed first alpha', firstPrivate).catch(() => 'error'); await vi.advanceTimersByTimeAsync(10); await a;
        const b = invoke('typed other alpha', !firstPrivate).catch(() => 'error'); await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2); expect(await b).toEqual({success: true, translatedText: '这是合成译文。'});
    });

    it.each([false, true])('restores image offscreen privacy from the active transaction %s', async firstPrivate => {
        const {broker} = harness(); state.config.translationMaxRetries = 0; let attempts = 0;
        setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const offscreenUrl = 'chrome-extension://controlled/offscreen.html'; let handlers: any[];
        const image = createImageTranslationBackgroundHandlers({assertLanguagesDownloaded: async () => {}, fetchImage: async () => '',
            translateImage: async (_image: string, _source: string, _title: string, options: any) => {
                await handlers.find(h => h.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, requestId: options.requestId, texts: ['same alpha'], privateContext: !firstPrivate}, {sender: {url: offscreenUrl}});
                return {image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mIAAAAASUVORK5CYII='};
            }, getTranslationService: () => 'custom', supportsBatchTranslation: () => false, translateTexts: broker.translateWithCache,
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => []} as never);
        handlers = createImageGlossaryContext({ready: Promise.resolve(), offscreenUrl, getSourceLanguage: () => 'en', getGlossaryRevision: () => buildGlossaryRevision((state.config as any).glossaryLibraries, (state.config as any).glossaryEnabled)}).wrap(image as never);
        const invoke = (id: string, incognito: boolean) => handlers.find(h => h.type === IMAGE_TRANSLATE_MESSAGE_TYPE).handle({type: IMAGE_TRANSLATE_MESSAGE_TYPE, requestId: id, image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mIAAAAASUVORK5CYII=', sourceLanguage: 'en'}, {sender: {url: 'https://synthetic.test/', tab: {id: 1, incognito}}});
        const a = invoke('private-first', firstPrivate).catch(() => 'error'); await vi.advanceTimersByTimeAsync(10); await a;
        const b = invoke('private-second', !firstPrivate).catch(() => 'error'); await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(2); await b;
    });
});


describe('review counterexamples: area composition keeps trusted privacy', () => {
    it.each(['text', 'vision'].flatMap(mode => [false, true].map(privacy => [mode, privacy] as const)))('isolates area %s from trusted sender %s', async (mode, firstPrivate) => {
        const {broker} = harness(); state.areaDispatch = broker.translateWithCache; state.config.translationMaxRetries = 0;
        Object.assign(state.config, {areaTranslationMode: 'standard', areaTranslationService: 'custom'}); state.config.model.custom = 'gpt-4o';
        const {createAreaTranslationRuntime} = await import('@/src/app/background/areaRuntime');
        const dependencies = createAreaTranslationRuntime(async () => {}) as any;
        const handlers = createActualAreaHandlers({...dependencies,
            getDefaultSourceLanguage: () => 'en', getVisionRoute: () => ({mode: mode === 'vision' ? 'vision' : 'ocr'}), prepareVisionRoute: undefined,
            translateArea: async () => ({image: '', sourceText: 'same area alpha', lines: []})});
        let attempts = 0; setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const invoke = (id: string, incognito: boolean) => {
            const context = {sender: {url: 'https://synthetic.test/', tab: {id: 1, incognito}}};
            return handlers.find(h => h.type === AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE)!.handle({type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, requestId: id,
                image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mIAAAAASUVORK5CYII=',
                selection: {left: 0, top: 0, width: 20, height: 16, viewportWidth: 40, viewportHeight: 20},
                sourceLanguage: 'en', title: '', privateContext: !incognito, quotaScope: 'forged'} as never, context);
        };
        const a = invoke('area-first', firstPrivate).catch(e => `error:${(e as Error).message}`); await vi.advanceTimersByTimeAsync(10); const firstResult = await a; expect(attempts, String(firstResult)).toBe(1);
        const b = invoke('area-second', !firstPrivate).catch(() => 'error'); await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(mode === 'vision' ? 3 : 2); expect(await b).toMatchObject({success: true});
    });
});


describe('trusted ordinary/private/unknown boundary', () => {
    it.each([
        [{sender: {tab: {incognito: false}}}, false], [{sender: {tab: {incognito: true}}}, true],
        [{sender: {tab: {incognito: 'false'}}}, undefined], [{}, undefined],
        [{sender: {url: 'chrome-extension://controlled/options.html'}, extensionContext: {url: 'chrome-extension://controlled/', incognito: false}}, undefined],
        [{sender: {url: 'chrome-extension://controlled/options.html'}, extensionContext: {url: 'chrome-extension://controlled/', incognito: true}}, undefined],
        [{sender: {url: 'chrome-extension://other/options.html'}, extensionContext: {url: 'chrome-extension://controlled/', incognito: true}}, undefined],
        [{sender: {url: 'https://synthetic.test/'}}, undefined],
    ])('resolves only trusted sender tab metadata %j', (context, expected) => {
        expect(translationPrivacyContext(context as never).privateContext).toBe(expected);
    });
    it('separates an unknown typed source from an ordinary sender despite payload claims', async () => {
        const {broker} = harness(); state.config.translationMaxRetries = 0; let attempts = 0;
        setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const handler = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => state.config as never, translate: broker.translateWithCache});
        const first = handler.handle({type: 'inputBoxTranslation', text: 'ordinary alpha', targetLang: 'zh-Hans'}, {sender: {tab: {incognito: false}}}).catch(() => 'error');
        await vi.advanceTimersByTimeAsync(10); await first;
        const unknown = handler.handle({type: 'inputBoxTranslation', text: 'unknown alpha', targetLang: 'zh-Hans', privateContext: false, quotaScope: 'ordinary'} as never, {});
        await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(2); expect(await unknown).toEqual({success: true, translatedText: '这是合成译文。'});
    });
});


describe('physical attempt capacity, FIFO, and cancellation', () => {
    it.each([1, 3])('keeps %s real in-flight slots until ignored-abort transports settle', async cap => {
        state.config.maxConcurrentTranslations = cap; state.config.translationMaxRetries = 0;
        const {broker, writes} = harness(); const releases: Array<() => void> = []; let active = 0; let peak = 0; let attempts = 0;
        setRuntimeFetch(async () => {
            attempts += 1; active += 1; peak = Math.max(peak, active);
            if (attempts > cap) {active -= 1; return response();}
            return new Promise<Response>(resolve => releases.push(() => {active -= 1; resolve(response());}));
        });
        const controllers = Array.from({length: cap}, () => new AbortController());
        const jobs = controllers.map((controller, i) => broker.translateWithCache(attachTranslationRequestControl({origin: `in flight alpha ${i}`, useCache: false, requestTimeoutMs: 5000}, {signal: controller.signal, ownershipKey: `owner-${i}`})).catch(() => 'cancelled'));
        await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(cap); controllers[0]!.abort(); expect(await jobs[0]).toBe('cancelled');
        const beta = broker.translateWithCache({origin: 'healthy queued beta', serviceOverride: 'newapi', useCache: false, requestTimeoutMs: 4000});
        try {
            await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(cap); releases[0]!();
            await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(cap + 1); expect(await beta).toBe('这是合成译文。');
        } finally {for (const release of releases.slice(1)) release();}
        await vi.runAllTimersAsync(); await Promise.all(jobs); expect(peak).toBeLessThanOrEqual(cap); expect(writes).toEqual([]);
    });
    it('counts real attempts once and preserves FIFO under a global one-per-second bucket', async () => {
        state.config.maxConcurrentTranslations = 1; state.config.translationRequestsPerSecond = 1;
        const {broker} = harness(); const start = Date.now(); const calls: Array<{service: string; at: number}> = [];
        setRuntimeFetch(async input => {
            const service = String(input).includes('healthy-b') ? 'B' : 'A'; calls.push({service, at: Date.now() - start});
            return response(calls.length === 1 ? 429 : 200, {'retry-after-ms': '25'});
        });
        const a = broker.translateWithCache({origin: 'FIFO original alpha', useCache: false, requestTimeoutMs: 5000});
        await vi.advanceTimersByTimeAsync(10);
        const b = broker.translateWithCache({origin: 'FIFO queued beta', serviceOverride: 'newapi', useCache: false, requestTimeoutMs: 4000});
        await vi.runAllTimersAsync(); await Promise.all([a, b]); expect(calls).toEqual([{service: 'A', at: 0}, {service: 'B', at: 1000}, {service: 'A', at: 2000}]);
    });
    it.each([1, 3])('does not dispatch cancelled or expired saturated work at cap %s after cooldown', async cap => {
        state.config.maxConcurrentTranslations = cap; const {broker} = harness(); let alpha = 0;
        setRuntimeFetch(async input => {if (String(input).includes('healthy-b')) return response(); alpha += 1; return response(429, {'retry-after': '90'});});
        const controllers = Array.from({length: cap}, () => new AbortController());
        const jobs = controllers.map((controller, i) => broker.translateWithCache(attachTranslationRequestControl({origin: `expired alpha ${i}`, useCache: false, requestTimeoutMs: 4000}, {signal: controller.signal, ownershipKey: `expired-${i}`})).catch(() => 'ended'));
        await vi.advanceTimersByTimeAsync(10); const b = broker.translateWithCache({origin: 'healthy early beta', serviceOverride: 'newapi', useCache: false, requestTimeoutMs: 40_000});
        await vi.advanceTimersByTimeAsync(10); controllers[0]!.abort(); expect(await b).toBe('这是合成译文。');
        await vi.runAllTimersAsync(); expect(await Promise.all(jobs)).toEqual(Array(cap).fill('ended')); expect(alpha).toBe(cap);
    });
});


describe('image transaction identity cannot be borrowed by content payloads', () => {
    it('uses the ordinary caller identity for a forged active private requestId', async () => {
        const {broker, scheduler} = harness(); state.config.translationMaxRetries = 0; let attempts = 0;
        const scopes = vi.spyOn(scheduler, 'observeResponse'); const offscreenUrl = 'chrome-extension://controlled/offscreen.html';
        let finish!: () => void; let entered!: () => void; const ready = new Promise<void>(resolve => {entered = resolve;});
        setRuntimeFetch(async () => {attempts += 1; return response(attempts === 1 ? 429 : 200, {'retry-after': '90'});});
        const original = createImageTranslationBackgroundHandlers({assertLanguagesDownloaded: async () => {}, fetchImage: async () => '',
            translateImage: async () => {entered(); await new Promise<void>(resolve => {finish = resolve;}); return {image: ''};},
            getTranslationService: () => 'custom', supportsBatchTranslation: () => false, translateTexts: broker.translateWithCache,
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => []} as never);
        const handlers = createImageGlossaryContext({ready: Promise.resolve(), offscreenUrl, getSourceLanguage: () => 'en',
            getGlossaryRevision: () => buildGlossaryRevision((state.config as any).glossaryLibraries, (state.config as any).glossaryEnabled)}).wrap(original as never);
        const active = handlers.find(h => h.type === IMAGE_TRANSLATE_MESSAGE_TYPE)!.handle({type: IMAGE_TRANSLATE_MESSAGE_TYPE, requestId: 'private-active', sourceLanguage: 'en', title: '',
            image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mIAAAAASUVORK5CYII='} as never, {sender: {url: 'https://private.test/', tab: {id: 1, incognito: true}}});
        await ready;
        const text = handlers.find(h => h.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
        const first = Promise.resolve(text.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, requestId: 'private-active', texts: ['same alpha']} as never, {sender: {url: offscreenUrl}})).catch(() => 'error');
        await vi.advanceTimersByTimeAsync(10); await first;
        const forged = text.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, requestId: 'private-active', texts: ['same alpha'], privateContext: true, sender: {url: offscreenUrl}} as never,
            {sender: {url: 'https://ordinary.test/', tab: {id: 2, incognito: false}}});
        try {await vi.advanceTimersByTimeAsync(10); expect(attempts).toBe(2); await forged; expect(scopes.mock.calls[0]![0]!.quotaScope).not.toBe(scopes.mock.calls[1]![0]!.quotaScope);}
        finally {finish(); await active;}
        await expect(text.handle({type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, requestId: 'private-active', texts: ['same alpha']} as never, {sender: {url: offscreenUrl}})).rejects.toThrow('上下文已失效');
    });
});


describe('mixed real connection probe and counted broker attempts', () => {
    it.each(['global', 'service', 'model'].flatMap(bucket => ['success', 'cancel', 'deadline'].map(outcome => [bucket, outcome])))
    ('settles a held-slot probe retry before queued broker work in %s with %s', async (bucket, outcome) => {
        state.config.maxConcurrentTranslations = 1;
        // 检测指定非空 Key 会有意关闭 SDK 重试；无 Key 的 custom 路径才复现真实 SDK 退避。
        state.config.token.custom = ''; (state.config as any).requireApiKey.custom = false;
        if (bucket !== 'global') (state.config as any).serviceRequestLimits = {custom: {enabled: true, limits: {maxConcurrentTranslations: 1}}};
        if (bucket === 'model') (state.config as any).modelRequestLimits = {custom: {'fixture-model': {enabled: true, limits: {maxConcurrentTranslations: 1}}}};
        const {scheduler, broker} = harness(); const start = Date.now();
        const attempts: Array<{kind: string; at: number}> = []; let active = 0; let peak = 0; let probeCalls = 0;
        let releaseRetry: (() => void) | undefined;
        setRuntimeFetch(async (_input, init) => {
            const kind = String(init?.body).includes(CONNECTION_TEST_ORIGIN) ? 'probe' : 'broker';
            attempts.push({kind, at: Date.now() - start}); active += 1; peak = Math.max(peak, active);
            try {
                if (kind === 'probe' && ++probeCalls === 1) return response(429, {'retry-after': '2'});
                if (kind === 'probe') await new Promise<void>(resolve => {releaseRetry = resolve;});
                return response();
            } finally {active -= 1;}
        });
        const probe = runTranslationServiceConnectionTest('custom', {requestScheduler: scheduler,
            config: createTranslationProviderConfigSnapshot(state.config as never), countRate: false, effectiveModel: 'fixture-model'})
            .then(value => ({success: true, value})).catch(error => ({success: false, error}));
        await vi.advanceTimersByTimeAsync(10); expect(attempts).toEqual([{kind: 'probe', at: 0}]);
        const control = new AbortController();
        const request = attachTranslationRequestControl({origin: 'queued synthetic broker', serviceOverride: 'custom', requestTimeoutMs: outcome === 'deadline' ? 4_000 : 10_000, useCache: false}, {signal: control.signal, ownershipKey: 'mixed-' + bucket});
        const queued = broker.translateWithCache(request as never)
            .then(value => ({success: true, value})).catch(error => ({success: false, error}));
        await flush(); if (outcome === 'cancel') control.abort();
        await vi.advanceTimersByTimeAsync(outcome === 'deadline' ? 4_100 : 2_100);
        expect(attempts.filter(a => a.kind === 'probe'), JSON.stringify(attempts)).toEqual([{kind: 'probe', at: 0}, {kind: 'probe', at: 2_000}]);
        expect(attempts.filter(a => a.kind === 'broker')).toEqual([]); expect(peak).toBe(1);
        releaseRetry!(); await vi.advanceTimersByTimeAsync(100);
        expect((await probe).success).toBe(true);
        expect((await queued).success).toBe(outcome === 'success');
        expect(attempts.filter(a => a.kind === 'broker')).toHaveLength(outcome === 'success' ? 1 : 0);
        expect(peak).toBe(1); expect(active).toBe(0);
    });
});


describe('real registry Doubao route capacity', () => {
    const routes = ['seed-config', 'seed-override', 'seed-custom-model', 'seed-body-chat', 'sdk-config', 'sdk-override', 'sdk-body-seed'];
    it.each([1, 3].flatMap(cap => routes.map(route => [cap, route] as const)))
    ('holds %s slots through ignored abort for the actual %s route', async (cap, route) => {
        state.config.maxConcurrentTranslations = cap; (state.config.proxy as any).doubao = 'https://doubao.test/api/v3';
        const seedModel = 'doubao-seed-translation-250915'; const sdkModel = 'doubao-seed-1-6-250615';
        state.config.model.doubao = route.startsWith('seed') || route === 'sdk-override' ? seedModel : sdkModel;
        let modelOverride: string | undefined;
        if (route === 'seed-override') {state.config.model.doubao = sdkModel; modelOverride = seedModel;}
        if (route === 'sdk-override') modelOverride = sdkModel;
        if (route === 'seed-custom-model') {state.config.model.doubao = customModelString; (state.config.customModel as any).doubao = seedModel;}
        if (route === 'seed-body-chat') (state.config.customBody as any).doubao = JSON.stringify({model: sdkModel});
        if (route === 'sdk-body-seed') (state.config.customBody as any).doubao = JSON.stringify({model: seedModel});
        const {translationProviderRegistry} = await vi.importActual<typeof import('@/src/providers/translation/registry')>('@/src/providers/translation/registry');
        const {broker, writes, scheduler} = harness(undefined, translationProviderRegistry); const identities = vi.spyOn(scheduler, 'observeResponse');
        const endpoint = 'https://doubao.test/api/v3' + (route.startsWith('seed') ? '/responses' : '');
        const releases: Array<() => void> = []; const urls: string[] = []; let active = 0; let peak = 0;
        setRuntimeFetch(async input => {
            urls.push(String(input)); active += 1; peak = Math.max(peak, active);
            try {
                await new Promise<void>(resolve => {releases.push(resolve);});
                return route.startsWith('seed') ? new Response(JSON.stringify({model: seedModel, output_text: '这是合成译文。'}), {headers: {'content-type': 'application/json'}}) : response();
            } finally {active -= 1;}
        });
        const controllers = Array.from({length: cap + 1}, () => new AbortController());
        const tasks = controllers.map((controller, i) => broker.translateWithCache(attachTranslationRequestControl({origin: 'synthetic doubao ' + i, serviceOverride: 'doubao', modelOverride, useCache: i === 0, requestTimeoutMs: 90_000}, {signal: controller.signal, ownershipKey: 'doubao-' + i}) as never).catch(error => error));
        try {
            await vi.advanceTimersByTimeAsync(10); expect(urls).toHaveLength(cap); expect(urls.every(url => url === endpoint)).toBe(true); expect(peak).toBe(cap);
            controllers[0]!.abort(); await vi.advanceTimersByTimeAsync(10);
            expect(urls).toHaveLength(cap); expect(active).toBe(cap); expect(writes).toEqual([]);
            releases[0]!(); await vi.advanceTimersByTimeAsync(20);
            expect(urls).toHaveLength(cap + 1); expect(peak).toBeLessThanOrEqual(cap);
            for (const release of releases.slice(1)) release(); await vi.advanceTimersByTimeAsync(20); await Promise.all(tasks);
            expect(active).toBe(0); expect(writes).toEqual([]);
            expect(identities.mock.calls.every(([identity]) => Boolean(identity?.quotaScope) === !route.startsWith('seed'))).toBe(true);
        } finally {
            controllers.forEach(controller => controller.abort()); releases.forEach(release => release());
            await vi.advanceTimersByTimeAsync(100); await Promise.all(tasks);
        }
    });
});

describe('real probe raw transport outlives caller timeout', () => {
    it.each(['global', 'service', 'model'].flatMap(bucket => [false, true].map(retry => [bucket, retry] as const)))
    ('keeps the actual network slot in %s after timeout with prior 429=%s', async (bucket, retry) => {
        state.config.maxConcurrentTranslations = 1; state.config.token.custom = ''; (state.config as any).requireApiKey.custom = false;
        if (bucket !== 'global') (state.config as any).serviceRequestLimits = {custom: {enabled: true, limits: {maxConcurrentTranslations: 1}}};
        if (bucket === 'model') (state.config as any).modelRequestLimits = {custom: {'fixture-model': {enabled: true, limits: {maxConcurrentTranslations: 1}}}};
        const {scheduler, broker, writes} = harness(); const start = Date.now(); let active = 0; let peak = 0; let probeCalls = 0;
        let releaseRaw!: () => void; const attempts: Array<{kind: string; at: number}> = [];
        setRuntimeFetch(async (_input, init) => {
            const kind = String(init?.body).includes(CONNECTION_TEST_ORIGIN) ? 'probe' : 'broker';
            attempts.push({kind, at: Date.now() - start}); active += 1; peak = Math.max(peak, active);
            try {
                if (kind === 'probe') {
                    if (retry && ++probeCalls === 1) return response(429, {'retry-after': '2'});
                    await new Promise<void>(resolve => {releaseRaw = resolve;}); // 故意忽略 init.signal。
                }
                return response();
            } finally {active -= 1;}
        });
        const probe = runTranslationServiceConnectionTest('custom', {requestScheduler: scheduler, config: createTranslationProviderConfigSnapshot(state.config as never), countRate: false, effectiveModel: 'fixture-model'})
            .then(() => 'success').catch(error => error.message);
        await vi.advanceTimersByTimeAsync(10);
        const next = broker.translateWithCache({origin: 'healthy after probe timeout', serviceOverride: 'custom', useCache: false, requestTimeoutMs: 60_000}).catch(error => error);
        try {
            await vi.advanceTimersByTimeAsync(30_100);
            expect(await probe).toBe('翻译请求超时');
            expect(attempts.filter(a => a.kind === 'broker'), JSON.stringify(attempts)).toEqual([]);
            expect(active).toBe(1); expect(peak).toBe(1); expect(writes).toEqual([]);
            releaseRaw(); await vi.advanceTimersByTimeAsync(10); await next;
            expect(attempts.filter(a => a.kind === 'broker')).toHaveLength(1); expect(peak).toBe(1); expect(active).toBe(0); expect(writes).toEqual([]);
        } finally {releaseRaw?.(); await vi.advanceTimersByTimeAsync(100); await next; await probe;}
    });
});
