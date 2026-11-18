import {withProviderSnapshot} from './helpers/providerSnapshot';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {APICallError, RetryError} from 'ai';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import AES from 'crypto-js/aes';
import encUtf8 from 'crypto-js/enc-utf8';
import modeECB from 'crypto-js/mode-ecb';
import padPkcs7 from 'crypto-js/pad-pkcs7';

const {config} = vi.hoisted(() => ({config: {} as Record<string, any>}));
vi.mock('@/src/services/config/store', () => ({config}));
vi.mock('webextension-polyfill', () => ({default: {
    runtime: {id: 'controlled-audit', getURL: (path: string) => path},
    storage: {session: {get: async () => ({}), set: async () => undefined}, onChanged: {addListener: vi.fn()}},
}}));

import {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {normalizeAiSdkError} from '@/src/providers/translation/ai-sdk/errors';
import {createChromeTranslator} from '@/src/providers/translation/chrome-translator';
import {translateFreeChineseWebText} from '@/src/providers/translation/free-chinese-web';
import {translateExtraFreeWebText} from '@/src/providers/translation/free-extra-web';
import {translateMyMemoryText} from '@/src/providers/translation/mymemory';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/serialization';
import gemini from '@/src/providers/translation/gemini';
import tongyi from '@/src/providers/translation/tongyi';
import zhipu from '@/src/providers/translation/zhipu';
import deepseek from '@/src/providers/translation/deepseek';
import deepl from '@/src/providers/translation/deepl';
import claude from '@/src/providers/translation/claude';
import doubaoSeedTranslation from '@/src/providers/translation/doubao-seed-translation';
import {translateMicrosoftTextsWithTransport} from '@/src/providers/translation/microsoftTransport';
import {createOffscreenClient} from '@/src/platform/offscreen/client';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {translateWithChromeApi, disposeChromeTranslationModels} from '@/src/app/offscreen/translation';
import {runTranslationServiceConnectionTest} from '@/src/providers/translation/connectionTest';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {translateDeepLXText} from '@/src/providers/translation/deeplx';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationModelUsageObservation} from '@/src/services/translation/types';

const fetchPort = vi.fn<typeof fetch>();
const observations: TranslationModelUsageObservation[] = [];
const json = (body: unknown) => Response.json(body);
function request(service: string) {
    config.service = service;
    return attachTranslationModelUsageObserver({origin: 'Hello', serviceOverride: service}, event => observations.push(event));
}
beforeEach(() => {
    Object.keys(config).forEach(key => delete config[key]);
    Object.assign(config, new Config(), {from: 'en', to: 'zh-Hans', translationMaxRetries: 0,
        token: {[services.zhipu]: 'fixture-id.fixture-secret'},
    });
    fetchPort.mockReset();
    observations.length = 0;
    setRuntimeFetch(fetchPort);
});
afterEach(() => {setRuntimeFetch(); vi.restoreAllMocks(); vi.useRealTimers();});

describe('audit48F: public frozen language defaults', () => {
    it('DeepL public entry retains frozen defaults after the live language configuration changes', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(config as Config);
        const message = attachTranslationProviderConfig({origin: 'hello', serviceOverride: 'deepL'}, snapshot);
        config.from = 'fr'; config.to = 'ja';
        fetchPort.mockResolvedValue(json({translations: [{text: 'fixture'}]}));
        await expect(deepl(withProviderSnapshot(message, config))).resolves.toBe('fixture');
        const outgoing = JSON.parse(String(fetchPort.mock.calls[0]![1]?.body));
        if (process.env.AUDIT_F_SNAPSHOT) writeFileSync(process.env.AUDIT_F_SNAPSHOT, JSON.stringify({
            snapshotLanguages: {from: snapshot.from, to: snapshot.to},
            currentLanguages: {from: config.from, to: config.to}, outgoing,
        }, null, 2));
        expect(outgoing).toMatchObject({source_lang: 'EN', target_lang: 'ZH-HANS'});
    });
    it('explicit provider language overrides retain priority over the frozen defaults', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(config as Config);
        config.from = 'fr'; config.to = 'ja';
        const message = attachTranslationProviderConfig({origin: 'hello', serviceOverride: 'deepL',
            sourceLanguage: 'de', targetLanguage: 'zh-Hant'}, snapshot);
        fetchPort.mockResolvedValue(json({translations: [{text: 'fixture'}]}));
        await expect(deepl(withProviderSnapshot(message, config))).resolves.toBe('fixture');
        expect(JSON.parse(String(fetchPort.mock.calls[0]![1]?.body))).toMatchObject({source_lang: 'DE', target_lang: 'ZH-HANT'});
    });
    it('missing request snapshots continue to use live defaults and explicit overrides', () => {
        config.from = 'fr'; config.to = 'ja';
        expect(getTranslationLanguages()).toEqual({sourceLanguage: 'fr', targetLanguage: 'ja'});
        expect(getTranslationLanguages(null)).toEqual({sourceLanguage: 'fr', targetLanguage: 'ja'});
        expect(getTranslationLanguages({sourceLanguage: 'en'})).toEqual({sourceLanguage: 'en', targetLanguage: 'ja'});
    });
    it('queued public connection tests retain the snapshot languages when configuration changes before dispatch', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(config as Config);
        const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1}));
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>(resolve => {started = resolve;});
        const blocking = scheduler.schedule(async () => {started(); await new Promise<void>(resolve => {release = resolve;});});
        await entered;
        fetchPort.mockResolvedValue(json({translations: [{text: 'fixture'}]}));
        const pending = runTranslationServiceConnectionTest('deepL', {config: snapshot, requestScheduler: scheduler});
        config.from = 'fr'; config.to = 'ja';
        release();
        try {
            await expect(pending).resolves.toMatchObject({durationMs: expect.any(Number)});
            await blocking;
            expect(fetchPort).toHaveBeenCalledOnce();
            expect(JSON.parse(String(fetchPort.mock.calls[0]![1]?.body))).toMatchObject({source_lang: 'EN', target_lang: 'ZH-HANS'});
        } finally {release(); await Promise.allSettled([blocking, pending]);}
    });
});

describe('audit48F: actual provider response parsing', () => {
    it('Claude rejects whitespace-only final text before recording success', async () => {
        fetchPort.mockResolvedValue(json({content: [{type: 'text', text: ' \n '}] }));
        await expect(claude(withProviderSnapshot(request('claude'), config))).rejects.toThrow('Claude 返回数据格式异常');
        expect(observations[0]?.outcome).toBe('error');
    });
    it('Doubao translation model rejects whitespace-only Responses text and reports error', async () => {
        config.model.doubao = 'doubao-seed-translation';
        fetchPort.mockResolvedValue(json({output_text: ' \n '}));
        await expect(doubaoSeedTranslation(withProviderSnapshot(request('doubao'), config))).rejects.toThrow('火山方舟返回数据格式异常');
        expect(observations[0]?.outcome).toBe('error');
    });
    it.each(['youdaoFree', 'icibaFree'] as const)('%s classifies null JSON as an unavailable response', async provider => {
        fetchPort.mockResolvedValue(json(null));
        await expect(translateFreeChineseWebText(provider, 'hello', 'en', 'zh-Hans')).rejects.toMatchObject({freeFailure: 'unavailable'});
    });
    it('Gemini returns every final text part and omits thought and binary parts', async () => {
        fetchPort.mockResolvedValue(json({modelVersion: 'gemini-runtime-version', candidates: [{content: {parts: [
            {thought: true, text: 'private reasoning'}, {inlineData: {data: 'binary'}},
            {text: '甲'}, {text: '乙'}, null,
        ]}}, {content: {parts: [{text: 'alternative'}]}}],
        usageMetadata: {promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1}}));
        await expect(gemini(withProviderSnapshot(request('gemini'), config))).resolves.toBe('甲乙');
        expect(observations).toEqual([expect.objectContaining({outcome: 'success', actualModel: 'gemini-runtime-version', inputTokens: 3, outputTokens: 3, reasoningTokens: 1})]);
    });
    it.each([
        null, {}, {candidates: []}, {candidates: [{content: {parts: []}}]},
        {candidates: [{content: {parts: [{thought: true, text: 'private'}]}}]},
        {candidates: [{content: {parts: [{text: 4}]}}]},
        {candidates: [{content: {parts: [{text: ' \n '}]}}]},
    ])('Gemini rejects empty, blocked or malformed final content %#', async body => {
        fetchPort.mockResolvedValue(json(body));
        await expect(gemini(withProviderSnapshot(request('gemini'), config))).rejects.toThrow('Gemini 返回数据格式异常：缺少文本内容');
        expect(observations).toEqual([expect.objectContaining({outcome: 'error'})]);
    });
    it.each([
        ['tongyi', tongyi], ['zhipu', zhipu], ['deepseek', deepseek],
    ] as const)('%s rejects non-text chat content before recording success', async (service, provider) => {
        for (const content of [null, 42, {secret: 'malformed'}, '', '  ']) {
            observations.length = 0;
            fetchPort.mockResolvedValue(json({choices: [{message: {content}}]}));
            await expect(provider(withProviderSnapshot(request(service), config))).rejects.toThrow('返回数据格式异常');
            expect(observations).toEqual([expect.objectContaining({outcome: 'error'})]);
        }
    });
    it('DeepSeek rejects a response containing only stripped reasoning', async () => {
        fetchPort.mockResolvedValue(json({choices: [{message: {content: '<think>private</think>'}}]}));
        await expect(deepseek(withProviderSnapshot(request('deepseek'), config))).rejects.toThrow('返回数据格式异常');
        expect(observations[0]?.outcome).toBe('error');
    });
    it.each([null, {}, {translations: []}, {translations: [{text: 4}]}, {translations: [{text: '  '}]}])
    ('DeepL rejects malformed translation payload %#', async body => {
        fetchPort.mockResolvedValue(json(body));
        await expect(deepl(withProviderSnapshot(request('deepL'), config))).rejects.toThrow('DeepL 返回数据格式异常：缺少译文');
    });
    it('preserves whitespace in valid final text for every direct chat adapter', async () => {
        for (const [service, provider] of [['tongyi', tongyi], ['zhipu', zhipu], ['deepseek', deepseek]] as const) {
            fetchPort.mockResolvedValue(json({model: 'runtime-model-version', choices: [{message: {content: '  译文\n'}}]}));
            await expect(provider(withProviderSnapshot(request(service), config))).resolves.toBe(service === 'deepseek' ? '译文' : '  译文\n');
            expect(observations.at(-1)).toMatchObject({outcome: 'success', actualModel: 'runtime-model-version'});
        }
        fetchPort.mockResolvedValue(json({translations: [{text: '  译文\n'}]}));
        await expect(deepl(withProviderSnapshot(request('deepL'), config))).resolves.toBe('  译文\n');
    });
});

describe('audit48F: error public normalization', () => {
    it.each([
        [new TypeError('Failed to fetch'), false, 'network', true],
        [Object.assign(new Error('deadline'), {name: 'TimeoutError'}), false, 'timeout', true],
        [Object.assign(new Error('stopped'), {name: 'AbortError'}), true, 'timeout', false],
        [Object.assign(new Error('schema'), {name: 'AI_TypeValidationError'}), false, 'bad-request', false],
    ] as const)('classifies the last non-HTTP RetryError cause %#', (last, aborted, kind, retryable) => {
        const wrapped = new RetryError({message: 'Retries exhausted', reason: 'maxRetriesExceeded', errors: [new Error('first'), last]});
        expect(normalizeAiSdkError('custom', wrapped, undefined, aborted)).toMatchObject({kind, retryable});
    });
    it('reads case-insensitive retry and request-id headers while redacting metadata', () => {
        const error = new APICallError({message: 'rate limited', url: 'https://fixture.invalid', requestBodyValues: {}, statusCode: 429,
            responseHeaders: {'Retry-After-Ms': '1500', 'Retry-After': '9', 'X-Request-ID': 'req fixture-secret'}, isRetryable: true});
        expect(normalizeAiSdkError('custom', error, 'fixture-secret')).toMatchObject({retryAfterMs: 1500, requestId: 'req [已隐藏的密钥]'});
    });
    it('untrusted header whitespace is sanitized without throwing during normalization', () => {
        const error = new APICallError({message: 'upstream', url: 'https://fixture.invalid', requestBodyValues: {},
            responseHeaders: {'X-Request-ID': 'req\nfixture-secret'}});
        expect(normalizeAiSdkError('custom', error, 'fixture-secret').requestId).toBe('req [已隐藏的密钥]');
    });
});

describe('audit48F: cancellation at controlled external boundaries', () => {
    it('Chrome actual client/router/API keeps the source and target override after a pre-cancelled request', async () => {
        const destroy = vi.fn();
        const translate = vi.fn(async () => '繁體譯文');
        const create = vi.fn(async (_options: unknown) => ({translate, destroy}));
        const environment = {Translator: {availability: async () => 'available', create}};
        const unexpected = async () => {throw new Error('unexpected unrelated offscreen port');};
        const listener = createOffscreenMessageListener({translate: (data, signal) => translateWithChromeApi(data, environment, signal),
            ttsPlayer: {play: unexpected, stop: () => {throw new Error('unexpected unrelated offscreen port');}, seek: () => {throw new Error('unexpected unrelated offscreen port');}}, fetchImage: unexpected, translateImage: unexpected,
            translateArea: () => {throw new Error('unexpected unrelated offscreen port');}, downloadOcrLanguages: unexpected,
        });
        const sent: Array<Record<string, unknown>> = [];
        const sendMessage = vi.fn((message: unknown, callback: (response: unknown) => void) => {
            sent.push(message as Record<string, unknown>);
            listener(message, {}, callback);
        });
        const client = createOffscreenClient({getRuntime: () => ({getContexts: async () => [{}], sendMessage}),
            getOffscreen: () => ({createDocument: unexpected}), readyRetryAttempts: 1, preparationTimeoutMs: 1000});
        const provider = createChromeTranslator({capabilities: {browserTranslation: true}, offscreenClient: client,
            createRequestId: () => 'contract-request', preparationStore: {set: vi.fn()},
        });
        const controller = new AbortController(); controller.abort();
        await expect(provider(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, config))).rejects.toThrow();
        expect(sent.filter(message => message.type === 'CHROME_TRANSLATE_OFFSCREEN')).toEqual([]);
        expect(create).not.toHaveBeenCalled();
        await expect(provider(withProviderSnapshot({origin: '简体中文', sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hant'}, config))).resolves.toBe('繁體譯文');
        expect(sent.find(message => message.type === 'CHROME_TRANSLATE_OFFSCREEN')).toMatchObject({
            target: 'offscreen', data: {text: '简体中文', from: 'zh-Hans', to: 'zh-Hant'},
        });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({sourceLanguage: 'zh', targetLanguage: 'zh-Hant'}));
        expect(translate).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled();
        disposeChromeTranslationModels(environment); expect(destroy).toHaveBeenCalledOnce();
        if (process.env.AUDIT_F_CHROME_CONTRACT) writeFileSync(process.env.AUDIT_F_CHROME_CONTRACT,
            JSON.stringify({runtimeMessages: sent, apiOptions: create.mock.calls[0]?.[0], translateCalls: translate.mock.calls.length, destroyCalls: destroy.mock.calls.length}, null, 2));
    });
    it('Microsoft injectable transport refuses a late JSON result and prevents pre-cancelled transport', async () => {
        const controller = new AbortController();
        fetchPort.mockResolvedValue({ok: true, json: async () => {controller.abort(); return [{translations: [{text: 'late'}]}];}} as Response);
        await expect(translateMicrosoftTextsWithTransport(fetchPort, ['hello'], 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        fetchPort.mockClear();
        await expect(translateMicrosoftTextsWithTransport(fetchPort, ['hello'], 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchPort).not.toHaveBeenCalled();
    });
    it('Doubao translation batch stops after its first body completes after cancellation', async () => {
        config.model.doubao = 'doubao-seed-translation';
        const controller = new AbortController();
        fetchPort.mockResolvedValue({ok: true, json: async () => {controller.abort(); return {output_text: 'late'};}} as Response);
        await expect(doubaoSeedTranslation(withProviderSnapshot({...request('doubao'), origin: ['one', 'two'], abortSignal: controller.signal}, config))).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchPort).toHaveBeenCalledOnce();
        expect(observations[0]?.outcome).toBe('cancelled');
        fetchPort.mockClear();
        await expect(doubaoSeedTranslation(withProviderSnapshot({...request('doubao'), abortSignal: controller.signal}, config))).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchPort).not.toHaveBeenCalled();
    });
    it.each([
        ['gemini', gemini, {candidates: [{content: {parts: [{text: 'late'}]}}]}],
        ['claude', claude, {content: [{type: 'text', text: 'late'}]}],
        ['tongyi', tongyi, {choices: [{message: {content: 'late'}}]}],
        ['zhipu', zhipu, {choices: [{message: {content: 'late'}}]}],
        ['deepseek', deepseek, {choices: [{message: {content: 'late'}}]}],
        ['deepL', deepl, {translations: [{text: 'late'}]}],
    ] as const)('%s rejects late JSON after cancellation and prevents pre-cancelled transport', async (service, provider, body) => {
        const controller = new AbortController(), reason = new Error('owner left while reading');
        let finish!: () => void;
        const received = new Response(new ReadableStream<Uint8Array>({start(stream) {
            finish = () => {controller.abort(reason);stream.enqueue(new TextEncoder().encode(JSON.stringify(body)));stream.close();};
        }}));
        const fetched = new Promise<void>(resolve => fetchPort.mockImplementation(async () => {resolve();return received;}));
        const message = {...request(service), abortSignal: controller.signal};
        const pending = provider(withProviderSnapshot(message, config));
        const rejected = expect(pending).rejects.toBe(reason);
        await fetched;finish();await rejected;
        expect(received.bodyUsed).toBe(true);
        if (service !== 'deepL') expect(observations).toEqual([expect.objectContaining({outcome: 'cancelled'})]);
        fetchPort.mockClear(); observations.length = 0;
        await expect(provider(withProviderSnapshot(message, config))).rejects.toBe(reason);
        expect(fetchPort).not.toHaveBeenCalled();
        expect(observations).toEqual([]);
    });
    it('Chrome preserves caller cancellation after an offscreen port resolves late', async () => {
        const controller = new AbortController();
        const send = vi.fn(async (payload: {requestId: string}) => {
            controller.abort();
            return {success: true, result: 'late', requestId: payload.requestId};
        });
        const provider = createChromeTranslator({capabilities: {browserTranslation: true}, offscreenClient: {send} as never, createRequestId: () => 'audit-request'});
        await expect(provider(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, config))).rejects.toMatchObject({name: 'AbortError'});
        expect(send).toHaveBeenCalledOnce();
    });
    it('Chrome does not send an already cancelled request', async () => {
        const controller = new AbortController(); controller.abort();
        const send = vi.fn();
        const provider = createChromeTranslator({capabilities: {browserTranslation: true}, offscreenClient: {send}, createRequestId: () => 'audit-request'});
        await expect(provider(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, config))).rejects.toMatchObject({name: 'AbortError'});
        expect(send).not.toHaveBeenCalled();
    });
    it('Chrome retains model-unavailable identity from offscreen', async () => {
        const send = vi.fn(async () => ({success: false, requestId: 'audit-request', errorCode: 'model-unavailable', error: 'offline'}));
        const provider = createChromeTranslator({capabilities: {browserTranslation: true}, offscreenClient: {send} as never, createRequestId: () => 'audit-request'});
        await expect(provider(withProviderSnapshot({origin: 'hello'}, config))).rejects.toMatchObject({name: 'ChromeModelUnavailableError', message: 'offline', code: 'browser-translation-unavailable', retryable: false});
    });
    it('DeepLX refuses a body read that completes after cancellation and does not fail over', async () => {
        config.deeplx = 'https://fixture.invalid/one\nhttps://fixture.invalid/two';
        const controller = new AbortController();
        fetchPort.mockResolvedValue({ok: true, text: async () => {controller.abort(); return JSON.stringify({code: 200, data: 'late'});}} as Response);
        await expect(translateDeepLXText('hello', 'deeplx', withProviderSnapshot({sourceLanguage: 'en', targetLanguage: 'zh-Hans', abortSignal: controller.signal}, config)))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(fetchPort).toHaveBeenCalledOnce();
    });
    it.each(['youdaoFree', 'icibaFree'] as const)('%s rejects cancellation during the last JSON read', async provider => {
        const controller = new AbortController();
        const body = provider === 'youdaoFree' ? {fanyi: {tran: 'late'}} : {content: AES.encrypt(JSON.stringify({err_no: 0, out: 'late'}), encUtf8.parse('aahc3TfyfCEmER33'), {mode: modeECB, padding: padPkcs7}).toString()};
        fetchPort.mockResolvedValue({ok: true, json: async () => {controller.abort(); return body;}} as Response);
        await expect(translateFreeChineseWebText(provider, 'hello', 'en', 'zh-Hans', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
});

describe('audit48F: bounded production performance and output contracts', () => {
    it('MyMemory preserves UTF-8 chunk boundaries without allocating one encoded array per codepoint', async () => {
        if (process.env.AUDIT_F_PROBE) console.log('AUDIT_F_PROBE_LOADED: production MyMemory public entry');
        const text = `  ${'aé中😀, '.repeat(process.env.AUDIT_F_PROBE ? 10000 : 240)}\r\n${'😀'.repeat(127)}\n`;
        const requests: string[] = [];
        fetchPort.mockImplementation(async input => {
            const q = new URL(String(input)).searchParams.get('q')!;
            requests.push(q);
            return json({responseStatus: 200, responseData: {translatedText: q}});
        });
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        const start = performance.now();
        const output = await translateMyMemoryText(text, withProviderSnapshot({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, config));
        const durationMs = performance.now() - start;
        const allocations = encode.mock.calls.filter(([value]) => typeof value === 'string' && value.length <= 2).length;
        encode.mockRestore();
        expect(output).toBe(text);
        expect(requests.every(q => Buffer.byteLength(q) <= 500)).toBe(true);
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        if (process.env.AUDIT_F_PERF) writeFileSync(process.env.AUDIT_F_PERF, JSON.stringify({inputCodeUnits: text.length, durationMs, codepointEncodedArrayAllocations: allocations, outputSHA256: hash(output), requestTextsSHA256: hash(JSON.stringify(requests)), requestCount: requests.length}, null, 2));
        expect(allocations).toBe(0);
    });
    it('MyMemory counts isolated surrogate replacement bytes at the 500-byte boundary', async () => {
        const requests: string[] = [];
        fetchPort.mockImplementation(async input => {
            const q = new URL(String(input)).searchParams.get('q')!; requests.push(q);
            return json({responseStatus: 200, responseData: {translatedText: q}});
        });
        const input = 'a'.repeat(499) + '\ud800' + 'é'.repeat(249) + '\udc00';
        const output = await translateMyMemoryText(input, withProviderSnapshot({sourceLanguage: 'en', targetLanguage: 'zh-Hans'}, config));
        const expected = 'a'.repeat(499) + '\ufffd' + 'é'.repeat(249) + '\ufffd';
        if (process.env.AUDIT_F_SURROGATE) writeFileSync(process.env.AUDIT_F_SURROGATE, JSON.stringify({
            inputCodePoints: Array.from(input, character => character.codePointAt(0)),
            expectedCodePoints: Array.from(expected, character => character.codePointAt(0)),
            outputCodePoints: Array.from(output, character => character.codePointAt(0)),
            requestByteLengths: requests.map(q => Buffer.byteLength(q)),
        }, null, 2));
        expect(output).toBe(expected);
        expect(requests.map(q => Buffer.byteLength(q))).toEqual([499, 499, 5]);
    });
    it('Reverso preserves chunk and slot boundaries without shared bootstrap state', async () => {
        fetchPort.mockImplementation(async (_url, init) => json({translation: ['译:' + JSON.parse(String(init?.body)).input]}));
        const slots = serializeTranslationSlots(['a'.repeat(1001), '  b\r\nc  '], 'audit-f');
        const output = await translateExtraFreeWebText('reversoFree', slots.payload, 'en', 'zh-Hans');
        expect(parseTranslationSlots(slots, output)).toEqual(['译:' + 'a'.repeat(1000) + '译:a', '  译:b\r\n译:c  ']);
        expect(fetchPort).toHaveBeenCalledTimes(4);
        await translateExtraFreeWebText('reversoFree', 'next request', 'en', 'zh-Hans');
        expect(fetchPort).toHaveBeenCalledTimes(5);
    });
    it('Apertium reuses the validated pair only within one request across chunks', async () => {
        const list = vi.fn(() => json(['eng-spa']));
        const texts: string[] = [];
        fetchPort.mockImplementation(async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/listPairs')) return list();
            const q = url.searchParams.get('q')!; texts.push(q);
            return json({responseStatus: 200, responseData: {translatedText: q}});
        });
        const input = 'a'.repeat(1001) + '\r\n  b  ';
        const start = performance.now();
        const output = await translateExtraFreeWebText('apertiumFree', input, 'en', 'es');
        if (process.env.AUDIT_F_APERTIUM_PERF) writeFileSync(process.env.AUDIT_F_APERTIUM_PERF, JSON.stringify({inputCodeUnits: input.length, durationMs: performance.now() - start, pairListRequests: list.mock.calls.length, totalRequests: fetchPort.mock.calls.length, outputSHA256: createHash('sha256').update(output).digest('hex'), requestTextsSHA256: createHash('sha256').update(JSON.stringify(texts)).digest('hex')}, null, 2));
        expect(output).toBe(input);
        expect(texts).toEqual(['a'.repeat(1000), 'a', 'b']);
        expect(list).toHaveBeenCalledOnce();
        await translateExtraFreeWebText('apertiumFree', 'another', 'en', 'es');
        expect(list).toHaveBeenCalledTimes(2);
    });
    it('empty extra-web text performs no bootstrap work', async () => {
        await expect(translateExtraFreeWebText('reversoFree', ' \r\n ', 'en', 'zh-Hans')).resolves.toBe(' \r\n ');
        expect(fetchPort).not.toHaveBeenCalled();
    });
    it('Apertium pair-list failure remains visible and a later request can retry', async () => {
        fetchPort.mockResolvedValueOnce(new Response('', {status: 503}));
        await expect(translateExtraFreeWebText('apertiumFree', 'hello', 'en', 'es')).rejects.toMatchObject({statusCode: 503});
        fetchPort.mockResolvedValueOnce(json(['eng-spa'])).mockResolvedValueOnce(json({responseStatus: 200, responseData: {translatedText: 'Hola'}}));
        await expect(translateExtraFreeWebText('apertiumFree', 'hello', 'en', 'es')).resolves.toBe('Hola');
    });
    it('a cancelled Apertium list read cannot start the translation request', async () => {
        const controller = new AbortController();
        fetchPort.mockResolvedValue({ok: true, json: async () => {controller.abort(); return ['eng-spa'];}} as Response);
        await expect(translateExtraFreeWebText('apertiumFree', 'hello', 'en', 'es', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetchPort).toHaveBeenCalledOnce();
    });
    it('Gemini endpoint, model and credential remain tied to a frozen snapshot', async () => {
        config.service = 'gemini'; config.model.gemini = 'fixture-model'; config.token.gemini = 'fixture-key';
        config.proxy.gemini = 'https://fixture.invalid/{model}?key={key}';
        const snapshot = createTranslationProviderConfigSnapshot(config as Config);
        config.proxy.gemini = 'https://different.invalid'; config.token.gemini = 'changed';
        fetchPort.mockResolvedValue(json({candidates: [{content: {parts: [{text: '译文'}]}}]}));
        await expect(gemini(withProviderSnapshot(attachTranslationProviderConfig({origin: 'hello', serviceOverride: 'gemini'}, snapshot), config))).resolves.toBe('译文');
        expect(fetchPort.mock.calls[0]![0]).toBe('https://fixture.invalid/fixture-model?key=fixture-key');
    });
});
