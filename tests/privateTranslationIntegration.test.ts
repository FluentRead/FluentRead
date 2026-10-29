import {createInputBoxTranslationHandler} from '@/src/features/input-translation/background/handler';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {serializeTranslationError, TRANSLATION_ERROR_MARKER, unwrapTranslationResponse} from '@/src/services/translation/errors';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {buildPageSummaryPrompt, buildPageSummarySystemPrompt} from '@/src/core/translation/prompts';
import {translateWithOpenAICompatibleAiSdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {createTranslationRequestFallback, type TranslationRequestContext} from '@/src/app/background/handlers/translation';
import {attachTranslationGlossaryContext, attachTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

import {serializeTranslationSlots, rebuildTranslationSlots} from '@/src/core/translation/slotProtocol';
import {createDocumentSegmentTranslator, type DocumentTranslationRequestOptions} from '@/src/features/document-translation/services/translation';

const customId = 'custom:private';
function sdkResponse(model: string, content: string): Response {
    return new Response(JSON.stringify({id: 'test', object: 'chat.completion', created: 1, model,
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}), {headers: {'content-type': 'application/json'}});
}
const privateDocumentSender = {sender: {url: 'chrome-extension://fluentread/document.html', tab: {incognito: true}}};
function expectPrivateOutbound(h: ReturnType<typeof harness>, count: number): void {
    expect(h.fetch).toHaveBeenCalledTimes(count);
    for (const [url, init] of h.fetch.mock.calls) {
        expect(String(url)).toBe('https://private.invalid/v1/chat/completions');
        expect(JSON.parse(String(init?.body)).model).toBe('private-model');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-private');
    }
    expect(h.cacheGet).not.toHaveBeenCalled();
    expect(h.cacheSet).not.toHaveBeenCalled();
    expect(h.cache.size).toBe(0);
}

afterEach(() => {setRuntimeFetch();vi.restoreAllMocks();});
function harness() {
    const current = new Config();
    Object.assign(current, {service: 'openai', enableAIContext: false, translationMaxRetries: 0,
        maxConcurrentTranslations: 4, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0});
    current.model.openai = 'normal-model';current.token.openai = 'test-normal';current.apiKeys.openai = ['test-normal'];
    current.proxy.openai = 'https://normal.invalid/v1/chat/completions';
    current.privateTranslation = {enabled: true, service: customId, model: 'private-model'};
    current.customOpenAIProviders = [{id: customId, name: 'Private', endpoint: 'https://private.invalid/v1/chat/completions', models: ['private-model']}];
    current.token[customId] = 'test-private';current.apiKeys[customId] = ['test-private'];
    const cache = new Map<string, string>();
    const cacheGet = vi.fn(async (key: string) => cache.get(key) ?? null);
    const cacheSet = vi.fn(async (key: string, value: string) => {cache.set(key, value);return true;});
    const keys = vi.fn((identity: unknown) => JSON.stringify(identity));
    const stats = vi.fn();const usage = vi.fn(async () => undefined);
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return sdkResponse(body.model, '译文');
    });
    setRuntimeFetch(fetch);
    const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => current,
        providers: {openai: translateWithOpenAICompatibleAiSdk, custom: translateWithOpenAICompatibleAiSdk},
        cache: {get: cacheGet, set: cacheSet,
            clear: async () => {cache.clear();}, cleanup: async () => undefined},
        serviceTypes: servicesType, endpointResolver: {resolveOpenAICompatibleEndpoint, aiSdkTransportProfile: 'ai-sdk'},
        promptBuilder: {buildPageSummaryPrompt, buildPageSummarySystemPrompt}, getMissingCredentialMessage,
        getTranslationLanguages: override => resolveTranslationLanguages(override, {sourceLanguage: current.from, targetLanguage: current.to}),
        resolveConfiguredModel, buildTranslationCacheKey: keys, recordTranslationRequest: stats, recordModelUsage: usage,
    });
    const fallback = createTranslationRequestFallback<TranslationRequestContext>({translate: broker.translateWithCache, serializeError: serializeTranslationError});
    return {current, fetch, cache, cacheGet, cacheSet, keys, stats, usage, broker, fallback};
}
describe('trusted sender to real OpenAI SDK request body private model integration', () => {
    it.each(['openai', 'google'])('binds input prompts to the private route from %s and freezes in-flight settings', async (normalService) => {
        const h = harness();
        h.current.inputBoxTranslationService = normalService;
        h.current.inputBoxTranslationSystemPrompt = 'INPUT SYSTEM ORIGINAL';
        h.current.inputBoxTranslationPrompt = 'INPUT USER ORIGINAL {{text}} -> {{to}}';
        let release!: () => void;
        const translate = vi.fn(h.broker.translateWithCache).mockImplementationOnce(async request => {
            await new Promise<void>(resolve => {release = resolve;});
            return h.broker.translateWithCache(request);
        });
        const handler = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => h.current, translate});
        const context = {sender: {tab: {incognito: true}}};
        const message = {type: 'inputBoxTranslation' as const, text: 'A useful input sentence', targetLang: 'zh-CN'};
        const first = handler.handle(message, context);
        await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
        expect(h.fetch).not.toHaveBeenCalled();
        h.current.inputBoxTranslationSystemPrompt = 'INPUT SYSTEM LATER';
        h.current.inputBoxTranslationPrompt = 'INPUT USER LATER {{text}} -> {{to}}';
        h.current.privateTranslation.model = 'later-model';
        h.current.apiKeys[customId] = ['test-later'];h.current.token[customId] = 'test-later';
        h.current.customOpenAIProviders[0].endpoint = 'https://later.invalid/v1/chat/completions';
        release();await expect(first).resolves.toEqual({success: true, translatedText: '译文'});
        await handler.handle(message, context);
        const calls = h.fetch.mock.calls.map(([url, init]) => ({url: String(url),
            authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body))}));
        expect(calls[0]).toMatchObject({url: 'https://private.invalid/v1/chat/completions', authorization: 'Bearer test-private', body: {model: 'private-model'}});
        expect(calls[1]).toMatchObject({url: 'https://later.invalid/v1/chat/completions', authorization: 'Bearer test-later', body: {model: 'later-model'}});
        for (const [index, marker] of ['ORIGINAL', 'LATER'].entries()) {
            expect(calls[index].body.messages).toEqual(expect.arrayContaining([
                expect.objectContaining({role: 'system', content: expect.stringContaining(`INPUT SYSTEM ${marker}`)}),
                expect.objectContaining({role: 'user', content: expect.stringContaining(`INPUT USER ${marker}`)}),
            ]));
            expect(JSON.stringify(calls[index].body.messages)).toContain('A useful input sentence');
            expect(JSON.stringify(calls[index].body.messages)).not.toContain(index === 0 ? 'LATER' : 'ORIGINAL');
        }
        expect(h.current.system_role[customId] ?? '').not.toContain('INPUT SYSTEM');
        expect(h.cache.size).toBe(0);
    });
    it('keeps ordinary input prompts and rejects unknown input identity rather than trusting payload', async () => {
        const h = harness();h.current.inputBoxTranslationService = 'openai';
        h.current.inputBoxTranslationSystemPrompt = 'ORDINARY INPUT SYSTEM';
        h.current.inputBoxTranslationPrompt = 'ORDINARY INPUT USER {{text}}';
        const handler = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => h.current,
            translate: h.broker.translateWithCache});
        const message = {type: 'inputBoxTranslation' as const, text: 'Ordinary input sentence', targetLang: 'zh-CN', privateContext: true, incognito: true};
        await expect(handler.handle(message, {})).rejects.toMatchObject({code: 'PRIVATE_TRANSLATION_UNAVAILABLE'});
        expect(h.fetch).not.toHaveBeenCalled();
        await handler.handle(message, {sender: {tab: {incognito: false}}});
        const [url, init] = h.fetch.mock.calls[0];const body = JSON.parse(String(init?.body));
        expect(String(url)).toContain('normal.invalid');expect(body.model).toBe('normal-model');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-normal');
        expect(body.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({role: 'system', content: expect.stringContaining('ORDINARY INPUT SYSTEM')}),
            expect.objectContaining({role: 'user', content: expect.stringContaining('ORDINARY INPUT USER')}),
        ]));
    });
    it('isolates normal and private credentials, endpoint, model, cache and stats without mutating the global config', async () => {
        const h = harness();
        const payload = {origin: 'A useful sentence', serviceOverride: 'openai', modelOverride: 'normal-model', privateContext: true, incognito: true};
        const normal = {sender: {tab: {incognito: false}, url: 'https://example.test'}};
        const privateTab = {sender: {tab: {incognito: true}, url: 'https://example.test'}};
        await expect(h.fallback.handle(payload, normal)).resolves.toBe('译文');
        await expect(h.fallback.handle(payload, privateTab)).resolves.toBe('译文');
        await expect(h.fallback.handle(payload, normal)).resolves.toBe('译文');
        await expect(h.fallback.handle(payload, privateTab)).resolves.toBe('译文');
        expect(h.fetch).toHaveBeenCalledTimes(3);
        const calls = h.fetch.mock.calls.map(([url, init]) => ({url: String(url), model: JSON.parse(String(init?.body)).model,
            authorization: new Headers(init?.headers).get('authorization')}));
        expect(calls).toEqual([
            {url: 'https://normal.invalid/v1/chat/completions', model: 'normal-model', authorization: 'Bearer test-normal'},
            {url: 'https://private.invalid/v1/chat/completions', model: 'private-model', authorization: 'Bearer test-private'},
            {url: 'https://private.invalid/v1/chat/completions', model: 'private-model', authorization: 'Bearer test-private'},
        ]);
        expect(h.stats.mock.calls.map(([event]) => [event.serviceId, event.model, event.source])).toEqual([
            ['openai', 'normal-model', 'network'], [customId, 'private-model', 'network'],
            ['openai', 'normal-model', 'cache'], [customId, 'private-model', 'network'],
        ]);
        expect(h.cache.size).toBe(1);
        expect(h.current.service).toBe('openai');expect(h.current.model.openai).toBe('normal-model');
    });
    it('rejects unknown enabled sender even with forged payload while explicit false and true take their trusted routes', async () => {
        const h = harness();
        const payload = {origin: 'Unknown origin', privateContext: true, incognito: true};
        const result = await h.fallback.handle(payload, {});
        expect(result).toMatchObject({marker: TRANSLATION_ERROR_MARKER, kind: 'bad-request', retryable: false, code: 'PRIVATE_TRANSLATION_UNAVAILABLE'});expect((result as {message: string}).message).toContain('无法确认窗口隐私身份');
        expect(h.stats).toHaveBeenLastCalledWith(expect.objectContaining({serviceId: 'private-identity-unknown', outcome: 'error'}), expect.anything());
        expect(h.fetch).not.toHaveBeenCalled();
        await h.fallback.handle(payload, {sender: {tab: {incognito: false}}});
        expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe('normal-model');
        await h.fallback.handle({...payload, privateContext: false, incognito: false}, {sender: {tab: {incognito: true}}});
        expect(JSON.parse(String(h.fetch.mock.calls[1][1]?.body)).model).toBe('private-model');
        h.current.privateTranslation.enabled = false;
        await h.fallback.handle({origin: 'Disabled unknown'}, {});
        expect(JSON.parse(String(h.fetch.mock.calls[2][1]?.body)).model).toBe('normal-model');
    });
    it('rejects missing credentials, removed providers, custom bodies and unavailable models with no normal fallback', async () => {
        const h = harness();
        const request = () => attachTranslationGlossaryContext({origin: 'Private sentence'}, {privateContext: true});
        h.current.apiKeys[customId] = [];h.current.token[customId] = '';
        await expect(h.broker.translateWithCache(request())).rejects.toThrow();expect(h.fetch).not.toHaveBeenCalled();
        h.current.apiKeys[customId] = ['test-private'];h.current.token[customId] = 'test-private';
        h.current.customBody[customId] = '{"model":"normal-model"}';
        await expect(h.broker.translateWithCache(request())).rejects.toThrow('标准请求体');expect(h.fetch).not.toHaveBeenCalled();
        h.current.customBody[customId] = '';
        h.current.customOpenAIProviders = [];
        await expect(h.broker.translateWithCache(request())).rejects.toThrow('不可用');expect(h.fetch).not.toHaveBeenCalled();
        h.current.customOpenAIProviders = [{id: customId, name: 'Private', endpoint: 'https://private.invalid/v1/chat/completions', models: []}];
        h.fetch.mockImplementation(async () => new Response(JSON.stringify({error: {message: 'model unavailable'}}), {status: 404, headers: {'content-type': 'application/json'}}));
        await expect(h.broker.translateWithCache(request())).rejects.toThrow();
        expect(h.fetch).toHaveBeenCalledTimes(1);expect(String(h.fetch.mock.calls[0][0])).toContain('private.invalid');
    });
    it('keeps concurrent same-service requests separate and never stores private results', async () => {
        const h = harness();h.current.privateTranslation.service = 'openai';
        const normal = {sender: {tab: {incognito: false}}}, privateTab = {sender: {tab: {incognito: true}}};
        await Promise.all([
            h.fallback.handle({origin: 'Same source'}, normal),
            h.fallback.handle({origin: 'Same source'}, privateTab),
        ]);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model).sort()).toEqual(['normal-model', 'private-model']);
        expect(h.cache.size).toBe(1);
        h.current.privateTranslation.model = 'second-private-model';
        await h.fallback.handle({origin: 'Same source'}, privateTab);
        expect(h.fetch).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(h.fetch.mock.calls[2][1]?.body)).model).toBe('second-private-model');
        await h.fallback.handle({origin: 'Same source'}, normal);
        expect(h.fetch).toHaveBeenCalledTimes(3);
    });
    it('routes every batch item through the private model and retains batch statistics', async () => {
        const h = harness();
        await expect(h.fallback.handle({origin: ['First source', 'Second source'], serviceOverride: 'openai', modelOverride: 'normal-model'},
            {sender: {tab: {incognito: true}}})).resolves.toEqual(['译文', '译文']);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(['private-model', 'private-model']);
        expect(h.stats).toHaveBeenLastCalledWith(expect.objectContaining({serviceId: customId, model: 'private-model', mode: 'batch', segmentCount: 2}), expect.anything());
    });
    it.each(['page', 'document'] as const)('routes %s AI multi-segment batches through the private SDK without shared cache', async glossaryContext => {
        const h = harness();
        const origin = ['First paragraph', 'Second paragraph'];
        const translated = ['第一段', '第二段'];
        const content = rebuildTranslationSlots(serializeTranslationSlots(origin), translated)!;
        h.fetch.mockImplementation(async (_url, init) => sdkResponse(JSON.parse(String(init?.body)).model, content));
        const payload = {origin, aiMultiSegment: true, documentBatch: true, glossaryContext,
            serviceOverride: 'openai', modelOverride: 'normal-model', useCache: true, sourceLanguage: 'en', targetLanguage: 'zh-CN'};
        const sender = glossaryContext === 'document' ? privateDocumentSender
            : {sender: {url: 'https://example.test', tab: {incognito: true}}};
        await expect(h.fallback.handle(payload, sender)).resolves.toEqual(translated);
        await expect(h.fallback.handle(payload, sender)).resolves.toEqual(translated);
        expectPrivateOutbound(h, 2);
        for (const [, init] of h.fetch.mock.calls) {
            expect(JSON.stringify(JSON.parse(String(init?.body)).messages)).toContain(serializeTranslationSlots(origin).starts[0]);
        }
        expect(h.stats).toHaveBeenLastCalledWith(expect.objectContaining({serviceId: customId, model: 'private-model',
            mode: 'batch', segmentCount: 2, source: 'network', cachedSegments: 0}), expect.anything());
    });

    it('retains the private SDK identity while recovering only the wrong-language document slot', async () => {
        const h = harness();
        const origin = ['There are also restrictions on the first character of this file.', 'The next paragraph explains another point.'];
        const translated = ['这个文件的首字母也有限制。', '下一段说明另一点。'];
        const japanese = 'このファイルの最初の文字にも制限があります。簡単にするために、最初の文字として文字を使用できます。';
        h.fetch.mockImplementationOnce(async (_url, init) => sdkResponse(JSON.parse(String(init?.body)).model,
            rebuildTranslationSlots(serializeTranslationSlots(origin), [japanese, translated[1]])!));
        h.fetch.mockImplementationOnce(async (_url, init) => sdkResponse(JSON.parse(String(init?.body)).model, translated[0]));
        await expect(h.fallback.handle({origin, aiMultiSegment: true, documentBatch: true, glossaryContext: 'document',
            serviceOverride: 'openai', modelOverride: 'normal-model', useCache: true, sourceLanguage: 'en', targetLanguage: 'zh-CN'},
        privateDocumentSender)).resolves.toEqual(translated);
        expectPrivateOutbound(h, 2);
        const recoveryMessages = JSON.stringify(JSON.parse(String(h.fetch.mock.calls[1][1]?.body)).messages);
        expect(recoveryMessages).toContain(origin[0]);
        expect(recoveryMessages).not.toContain(origin[1]);
        expect(recoveryMessages).not.toContain(serializeTranslationSlots(origin).starts[0]);
    });

    it('keeps document malformed-batch fallback on the private SDK for every recovered segment', async () => {
        const h = harness();
        h.fetch.mockImplementationOnce(async (_url, init) => sdkResponse(JSON.parse(String(init?.body)).model, '缺少槽标记的响应'));
        const dispatch = async <T extends string | string[]>(origin: T, context: string, options: DocumentTranslationRequestOptions): Promise<T> =>
            unwrapTranslationResponse<T>(await h.fallback.handle({...options, origin, context}, privateDocumentSender));
        const translateText = vi.fn((origin: string, context: string, options: DocumentTranslationRequestOptions) => dispatch(origin, context, options));
        const translateTextBatch = vi.fn((origin: string[], context: string, options: DocumentTranslationRequestOptions) => dispatch(origin, context, options));
        const translate = createDocumentSegmentTranslator({waitUntilReady: () => Promise.resolve(),
            getDefaultService: () => 'openai', getDefaultModel: () => 'normal-model',
            supportsBatch: () => false, supportsAIMultiSegment: () => true, translateText, translateTextBatch});
        const origin = ['First paragraph', 'Second paragraph'];
        await expect(translate(origin.map((source, id) => ({id, source})), {fileName: 'paper.pdf', batchTranslation: true,
            batchConcurrency: 1, maxRetries: 0, useCache: true, sourceLanguage: 'en', targetLanguage: 'zh-CN'})).resolves.toEqual(['译文', '译文']);
        expect(translateTextBatch).toHaveBeenCalledTimes(1);
        expect(translateTextBatch.mock.calls[0][2]).toMatchObject({documentBatch: true, aiMultiSegment: true, useCache: true});
        expect(translateText).toHaveBeenCalledTimes(2);
        expect(translateText.mock.calls.map(([source]) => source)).toEqual(origin);
        for (const [, , options] of translateText.mock.calls) {
            expect(options).toMatchObject({enableNativeBatch: false, serviceOverride: 'openai', modelOverride: 'normal-model', useCache: true});
            expect(options.documentBatch).toBeUndefined();
        }
        expectPrivateOutbound(h, 3);
        expect(h.stats.mock.calls.map(([event]) => [event.mode, event.outcome])).toEqual([
            ['batch', 'error'], ['single', 'success'], ['single', 'success'],
        ]);
    });

    it('records rejected private configuration against its attempted identity, not the normal model', async () => {
        const h = harness();h.current.privateTranslation.service = '';
        await expect(h.broker.translateWithCache(attachTranslationGlossaryContext({origin: 'Source'}, {privateContext: true}))).rejects.toThrow();
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.stats).toHaveBeenLastCalledWith(expect.objectContaining({serviceId: 'private-translation', outcome: 'error'}), expect.anything());
    });

    it('preserves cancellation through the effective snapshot and never falls back after abort', async () => {
        const h = harness();const controller = new AbortController();let providerSignal: AbortSignal | undefined;
        h.fetch.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            providerSignal = init?.signal ?? undefined;
            providerSignal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
        }));
        const result = h.broker.translateWithCache(attachTranslationRequestControl(attachTranslationGlossaryContext({origin: 'Cancel source'},
            {privateContext: true}), {signal: controller.signal, ownershipKey: 'private-owner'}));
        const assertion = expect(result).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
        controller.abort();await assertion;
        expect(providerSignal?.aborted).toBe(true);expect(h.fetch).toHaveBeenCalledTimes(1);expect(h.cache.size).toBe(0);
    });
    it('discards a late private SDK success when the transport ignores abort', async () => {
        const h = harness();const controller = new AbortController();let release!: () => void;
        const standardFetch = h.fetch.getMockImplementation()!;
        h.fetch.mockImplementationOnce(async (url, init) => {
            await new Promise<void>(resolve => {release = resolve;});
            return standardFetch(url, init);
        });
        const result = h.broker.translateWithCache(attachTranslationRequestControl(attachTranslationGlossaryContext({origin: 'Late private source'},
            {privateContext: true}), {signal: controller.signal, ownershipKey: 'late-private-owner'}));
        const assertion = expect(result).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
        controller.abort();await assertion;
        release();await new Promise(resolve => setTimeout(resolve, 20));
        expect(h.fetch).toHaveBeenCalledTimes(1);expect(h.cache.size).toBe(0);
        expect(String(h.fetch.mock.calls[0][0])).toContain('private.invalid');
        expect(h.stats.mock.calls.every(([event]) => event.outcome !== 'success')).toBe(true);
    });
    it('freezes an in-flight private model and credentials while a later request uses new settings', async () => {
        const h = harness();let release!: () => void;
        const standardFetch = h.fetch.getMockImplementation()!;
        h.fetch.mockImplementationOnce(async (url, init) => {
            await new Promise<void>(resolve => {release = resolve;});return standardFetch(url, init);
        });
        const request = () => attachTranslationGlossaryContext({origin: 'Frozen source'}, {privateContext: true});
        const first = h.broker.translateWithCache(request());
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
        h.current.privateTranslation.model = 'later-model';h.current.apiKeys[customId] = ['test-later'];h.current.token[customId] = 'test-later';
        release();await expect(first).resolves.toBe('译文');
        await expect(h.broker.translateWithCache(request())).resolves.toBe('译文');
        expect(h.fetch.mock.calls.map(([, init]) => [JSON.parse(String(init?.body)).model, new Headers(init?.headers).get('authorization')]))
            .toEqual([['private-model', 'Bearer test-private'], ['later-model', 'Bearer test-later']]);
    });
    it('does not read or write normal cache even when private service, credentials, model and source match', async () => {
        const h = harness();h.current.privateTranslation = {enabled: true, service: 'openai', model: 'normal-model'};
        await Promise.all([
            h.fallback.handle({origin: 'Identical source'}, {sender: {tab: {incognito: false}}}),
            h.fallback.handle({origin: 'Identical source'}, {sender: {tab: {incognito: true}}}),
        ]);
        expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.cache.size).toBe(1);
        await h.fallback.handle({origin: 'Identical source', useCache: true}, {sender: {tab: {incognito: true}}});
        expect(h.fetch).toHaveBeenCalledTimes(3);expect(h.cache.size).toBe(1);
        await h.fallback.handle({origin: 'Identical source'}, {sender: {tab: {incognito: false}}});
        expect(h.fetch).toHaveBeenCalledTimes(3);
    });

    it.each([true, false])('never reuses or persists normal page-summary cache for private requests, private model enabled=%s', async enabled => {
        const h = harness();h.current.enableAIContext = true;
        h.current.privateTranslation = {enabled, service: 'openai', model: 'normal-model'};
        const payload = {origin: 'A useful source', pageContext: 'An article with relevant context for translating the source.', useCache: true};
        const normal = {sender: {tab: {incognito: false}}}, privateTab = {sender: {tab: {incognito: true}}};
        await h.fallback.handle(payload, normal);expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.cache.size).toBe(2);
        await h.fallback.handle(payload, privateTab);expect(h.fetch).toHaveBeenCalledTimes(4);expect(h.cache.size).toBe(2);
        await h.fallback.handle(payload, privateTab);expect(h.fetch).toHaveBeenCalledTimes(6);expect(h.cache.size).toBe(2);
        await h.fallback.handle(payload, normal);expect(h.fetch).toHaveBeenCalledTimes(6);
    });

});
