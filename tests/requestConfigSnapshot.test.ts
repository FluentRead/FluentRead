import {describe, expect, it, vi} from 'vitest';
import {
    TRANSLATION_MODEL_USAGE_OBSERVER,
    TRANSLATION_PROVIDER_CONFIG,
    TRANSLATION_REQUEST_CONTROL,
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    attachTranslationRequestScheduler,
    getTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
    getTranslationProviderConfig,
    getTranslationRequestControl,
    attachTranslationRouteObserver,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    reportTranslationRoute,
    TRANSLATION_ROUTE_OBSERVER,
    getTranslationGlossaryTerms,
    getTranslationGlossarySourceText,
} from '@/src/services/translation/requestSnapshot';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {serializeTranslationSlots} from '@/src/core/translation/public';
import type {TranslationConfigSource} from '@/src/services/translation/types';

function configSource(overrides: Partial<TranslationConfigSource> = {}): TranslationConfigSource {
    return {
        service: 'aiSdk',
        from: 'auto',
        to: 'zh-Hans',
        useCache: true,
        enableAIContext: true,
        model: {aiSdk: 'model-a'},
        customModel: {aiSdk: 'custom-model-a'},
        modelThinking: {aiSdk: {'model-a': true}},
        customOpenAIProviders: [{
            id: 'custom:1',
            name: 'provider-a',
            endpoint: 'https://provider-a.example/v1/chat/completions',
            models: ['provider-model-a'],
        }],
        proxy: {aiSdk: 'https://a.example/v1'},
        custom: 'https://custom-a.example/v1',
        deeplx: 'https://deeplx-a.example',
        newApiUrl: 'https://newapi-a.example',
        minimaxBillingPlan: 'payg',
        minimaxRegion: 'cn',
        mimoBillingPlan: 'payg',
        mimoRegion: 'cn',
        azureOpenaiEndpoint: 'https://azure-a.example/chat/completions',
        customBody: {aiSdk: '{"snapshot":"a"}'},
        customHeaders: {aiSdk: '{"x-session":"a"}'},
        system_role: {aiSdk: 'system-a'},
        user_role: {aiSdk: 'user-a'},
        deepseekApiType: 'chat',
        deepseekThinkingMode: 'disabled',
        ...overrides,
    };
}

describe('translation provider request config snapshot', () => {
    it('keeps service and model limit snapshots stable after settings are edited', () => {
        const source = configSource({
            serviceRequestLimits: {aiSdk: {enabled: true, limits: {maxConcurrentTranslations: 4, translationRequestsPerSecond: 2, translationRequestsPerMinute: 60}}},
            modelRequestLimits: {aiSdk: {'model-a': {enabled: false, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 20}}}},
        });
        const snapshot = createTranslationProviderConfigSnapshot(source);
        source.serviceRequestLimits!.aiSdk.enabled = false;
        source.serviceRequestLimits!.aiSdk.limits.maxConcurrentTranslations = 99;
        source.modelRequestLimits!.aiSdk['model-a'].enabled = true;
        source.modelRequestLimits!.aiSdk['model-a'].limits.translationRequestsPerSecond = 100;
        expect(snapshot.serviceRequestLimits!.aiSdk).toEqual({enabled: true, limits: {
            maxConcurrentTranslations: 4, translationRequestsPerSecond: 2, translationRequestsPerMinute: 60,
        }});
        expect(snapshot.modelRequestLimits!.aiSdk['model-a']).toEqual({enabled: false, limits: {
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 20,
        }});
        expect(createTranslationProviderConfigSnapshot(configSource({apiKeyRecoveryMs: 3 * 60_000})).apiKeyRecoveryMs)
            .toBe(3 * 60_000);
        expect(createTranslationProviderConfigSnapshot(configSource()).apiKeyRecoveryMs).toBe(60_000);
        expect([snapshot.serviceRequestLimits, snapshot.serviceRequestLimits!.aiSdk, snapshot.serviceRequestLimits!.aiSdk.limits,
            snapshot.modelRequestLimits, snapshot.modelRequestLimits!.aiSdk, snapshot.modelRequestLimits!.aiSdk['model-a'],
            snapshot.modelRequestLimits!.aiSdk['model-a'].limits].every(Object.isFrozen)).toBe(true);
        expect(createTranslationProviderConfigSnapshot(configSource()).serviceRequestLimits).toEqual({});
        expect(createTranslationProviderConfigSnapshot(configSource({modelRequestLimits: {aiSdk: null as never}})).modelRequestLimits).toEqual({aiSdk: {}});
    });

    it('keeps the scheduler and immutable request identity inside trusted process-local context', () => {
        const scheduler = createTranslationRequestScheduler(() => ({}));
        const identity = {service: 'aiSdk', model: 'model-a'};
        const request = attachTranslationRequestScheduler({origin: 'hello'}, scheduler, identity);
        identity.model = 'model-b';
        const context = getTranslationRequestScheduler(request)!;
        expect(context.scheduler).toBe(scheduler);
        expect(context.identity).toEqual({service: 'aiSdk', model: 'model-a'});
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.identity)).toBe(true);
        expect(JSON.stringify(request)).toBe('{"origin":"hello"}');
        expect(getTranslationRequestScheduler(attachTranslationRequestScheduler({}, scheduler))!.identity).toBeUndefined();
        for (const untrusted of [null, 'invalid', {}, {scheduler, identity}, JSON.parse(JSON.stringify(request))]) {
            expect(getTranslationRequestScheduler(untrusted)).toBeUndefined();
        }
    });

    it('freezes fallback order and official-provider options before asynchronous work', () => {
        const order = ['myMemory', 'google'];
        const source = configSource({freeTranslationOrder: order, myMemoryEmail: 'contact@example.test'});
        const snapshot = createTranslationProviderConfigSnapshot(source);
        order.reverse();
        source.myMemoryEmail = '';
        expect(snapshot.freeTranslationOrder).toEqual(['myMemory', 'google']);
        expect(Object.isFrozen(snapshot.freeTranslationOrder)).toBe(true);
        expect(snapshot.myMemoryEmail).toBe('contact@example.test');
    });
    it('freezes the selected DeepL API plan and normalizes missing legacy values', () => {
        const source = configSource({deeplApiPlan: 'free'});
        const snapshot = createTranslationProviderConfigSnapshot(source);
        source.deeplApiPlan = 'pro';

        expect(snapshot.deeplApiPlan).toBe('free');
        expect(createTranslationProviderConfigSnapshot(source).deeplApiPlan).toBe('pro');
        expect(createTranslationProviderConfigSnapshot(configSource()).deeplApiPlan).toBe('free');
    });

    it('matches pure source slots without protocol boundaries and leaves malformed or literal markers intact', () => {
        const packet = serializeTranslationSlots(['agent', 'An agent works.'], 'Case_1-x');
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(['agent', 'An agent works.']);
        expect(getTranslationGlossarySourceText(['plain', packet.payload])).toEqual(['plain', 'agent', 'An agent works.']);
        for (const text of [packet.payload.replace(packet.ends[0], ''), `${packet.payload} outside`,
            `literal ${packet.payload}`, '___FLUENTREAD_partial_0_BEGIN___agent']) {
            expect(getTranslationGlossarySourceText(text)).toBe(text);
        }
    });
    it('deep-freezes glossary rules, per-entry selections and resolved terms without sharing mutable arrays', () => {
        const libraries = [{id: 'one', name: 'One', enabled: true, sourceLanguage: '', targetLanguage: '', domains: [],
            entries: [{id: 'term', source: 'agent', target: '智能体', caseSensitive: false}]}];
        const ids = ['one'];
        const terms = [{source: 'agent', target: '智能体'}];
        const snapshot = createTranslationProviderConfigSnapshot(configSource({glossaryLibraries: libraries,
            glossaryTerms: terms, documentGlossaryIds: ids, videoGlossaryIds: [],
            glossaryMatchContext: {sourceLanguage: 'en', targetLanguage: 'zh-Hans', glossaryIds: ids}}));
        libraries[0].entries[0].target = 'changed'; ids.push('two'); terms[0].target = 'changed';
        expect(getTranslationGlossaryTerms(snapshot, 'agent')).toEqual([{source: 'agent', target: '智能体'}]);
        expect(getTranslationGlossaryTerms(snapshot, 'another word')).toEqual([]);
        expect(snapshot.documentGlossaryIds).toEqual(['one']);
        expect(snapshot.videoGlossaryIds).toEqual([]);
        expect(snapshot.glossaryTerms).toEqual([{source: 'agent', target: '智能体'}]);
        expect([snapshot.glossaryLibraries, snapshot.glossaryLibraries?.[0], snapshot.glossaryLibraries?.[0].domains,
            snapshot.glossaryLibraries?.[0].entries, snapshot.glossaryLibraries?.[0].entries[0],
            snapshot.glossaryMatchContext, snapshot.glossaryMatchContext?.glossaryIds,
            snapshot.glossaryTerms, snapshot.glossaryTerms?.[0]].every(Object.isFrozen)).toBe(true);
        const withoutSelection = createTranslationProviderConfigSnapshot(configSource({glossaryMatchContext: {sourceLanguage: 'en', targetLanguage: 'zh-Hans'}}));
        expect(withoutSelection.glossaryMatchContext?.glossaryIds).toBeNull();
        expect(getTranslationGlossaryTerms(withoutSelection, 'agent')).toEqual([]);
        expect(getTranslationGlossaryTerms({...snapshot, glossaryLibraries: undefined}, 'agent')).toEqual([]);
        expect(getTranslationGlossaryTerms({...snapshot, glossaryTerms: undefined}, 'agent')).toEqual([]);
        expect(getTranslationGlossaryTerms({...snapshot, glossaryMatchContext: undefined, glossaryTerms: undefined}, 'agent')).toEqual([]);
        expect(getTranslationGlossaryTerms({...snapshot, glossaryMatchContext: {...snapshot.glossaryMatchContext!, glossaryIds: null}}, 'agent')).toEqual([{source: 'agent', target: '智能体'}]);
    });
    it('clones and freezes every provider-visible nested map and credential', () => {
        const source = {
            ...configSource({
                token: {aiSdk: 'token-a'},
                requireApiKey: {'aiSdk:model-a': true},
                youdaoAppKey: 'youdao-key-a',
                youdaoAppSecret: 'youdao-secret-a',
                tencentSecretId: 'tencent-id-a',
                tencentSecretKey: 'tencent-key-a',
            }),
            customModels: {aiSdk: ['saved-ui-model']},
        } as TranslationConfigSource & {customModels: Record<string, string[]>};
        const snapshot = createTranslationProviderConfigSnapshot(source);

        source.model.aiSdk = 'model-b';
        source.customModel.aiSdk = 'custom-model-b';
        source.modelThinking!.aiSdk['model-a'] = false;
        source.customOpenAIProviders![0].name = 'provider-b';
        source.customOpenAIProviders![0].endpoint = 'https://provider-b.example/v1/chat/completions';
        source.customOpenAIProviders![0].models[0] = 'provider-model-b';
        source.proxy.aiSdk = 'https://b.example/v1';
        source.customBody.aiSdk = '{"snapshot":"b"}';
        source.customHeaders!.aiSdk = '{"x-session":"b"}';
        source.system_role.aiSdk = 'system-b';
        source.user_role.aiSdk = 'user-b';
        source.token!.aiSdk = 'token-b';
        source.requireApiKey!['aiSdk:model-a'] = false;
        source.customModels.aiSdk[0] = 'mutated-ui-model';

        expect(snapshot).toMatchObject({
            model: {aiSdk: 'model-a'},
            customModel: {aiSdk: 'custom-model-a'},
            modelThinking: {aiSdk: {'model-a': true}},
            customOpenAIProviders: [{
                id: 'custom:1',
                name: 'provider-a',
                endpoint: 'https://provider-a.example/v1/chat/completions',
                models: ['provider-model-a'],
            }],
            proxy: {aiSdk: 'https://a.example/v1'},
            customBody: {aiSdk: '{"snapshot":"a"}'},
            customHeaders: {aiSdk: '{"x-session":"a"}'},
            system_role: {aiSdk: 'system-a'},
            user_role: {aiSdk: 'user-a'},
            token: {aiSdk: 'token-a'},
            requireApiKey: {'aiSdk:model-a': true},
            youdaoAppKey: 'youdao-key-a',
            youdaoAppSecret: 'youdao-secret-a',
            tencentSecretId: 'tencent-id-a',
            tencentSecretKey: 'tencent-key-a',
        });
        expect(snapshot).not.toHaveProperty('customModels');
        expect([
            snapshot,
            snapshot.model,
            snapshot.customModel,
            snapshot.modelThinking,
            snapshot.modelThinking?.aiSdk,
            snapshot.customOpenAIProviders,
            snapshot.customOpenAIProviders?.[0],
            snapshot.customOpenAIProviders?.[0].models,
            snapshot.proxy,
            snapshot.customBody,
            snapshot.customHeaders,
            snapshot.system_role,
            snapshot.user_role,
            snapshot.token,
            snapshot.requireApiKey,
        ].every(Object.isFrozen)).toBe(true);
    });

    it('uses safe credential defaults and resolves attached context without trusting message JSON', () => {
        const snapshot = createTranslationProviderConfigSnapshot(configSource());
        const withoutThinking = createTranslationProviderConfigSnapshot(configSource({modelThinking: undefined}));
        const fallback = createTranslationProviderConfigSnapshot(configSource({service: 'fallback'}));
        const message = {origin: 'hello'};
        const attached = attachTranslationProviderConfig(message, snapshot);

        expect(attached).toBe(message);
        expect(attached[TRANSLATION_PROVIDER_CONFIG]).toBe(snapshot);
        expect(getTranslationProviderConfig(attached, fallback)).toBe(snapshot);
        expect(getTranslationProviderConfig({}, fallback)).toBe(fallback);
        expect(getTranslationProviderConfig(null, fallback)).toBe(fallback);
        expect(getTranslationProviderConfig('not-an-object', fallback)).toBe(fallback);
        expect(snapshot).toMatchObject({
            token: {},
            requireApiKey: {},
            youdaoAppKey: '',
            youdaoAppSecret: '',
            tencentSecretId: '',
            tencentSecretKey: '',
        });
        expect(withoutThinking.modelThinking).toEqual({});
        expect(Object.isFrozen(withoutThinking.modelThinking)).toBe(true);
        expect(Object.getOwnPropertySymbols(attached)).toEqual([TRANSLATION_PROVIDER_CONFIG]);
        expect(JSON.stringify(attached)).toBe('{"origin":"hello"}');
    });

    it('keeps abort ownership process-local and out of runtime JSON', () => {
        const controller = new AbortController();
        const message = attachTranslationRequestControl({origin: 'hello'}, {
            signal: controller.signal,
            ownershipKey: 'image:req-1',
        });

        expect(message[TRANSLATION_REQUEST_CONTROL]).toEqual({
            signal: controller.signal,
            ownershipKey: 'image:req-1',
        });
        expect(Object.isFrozen(message[TRANSLATION_REQUEST_CONTROL])).toBe(true);
        expect(getTranslationRequestControl(message)).toBe(message[TRANSLATION_REQUEST_CONTROL]);
        expect(getTranslationRequestControl({})).toBeUndefined();
        expect(getTranslationRequestControl(null)).toBeUndefined();
        expect(getTranslationRequestControl('forged-control')).toBeUndefined();
        expect(JSON.stringify(message)).toBe('{"origin":"hello"}');
        expect(() => attachTranslationRequestControl({}, {
            signal: controller.signal,
            ownershipKey: '  ',
        })).toThrow('ownershipKey');
    });

    it('keeps route observers process-local and isolates observer failures', () => {
        const observer = vi.fn();
        const message = attachTranslationRouteObserver({origin: 'hello'}, observer);
        const observation = {route: 'microsoft', outcome: 'success' as const, durationMs: 120, chars: 5};

        expect(message[TRANSLATION_ROUTE_OBSERVER]).toBe(observer);
        expect(JSON.stringify(message)).toBe('{"origin":"hello"}');
        reportTranslationRoute(message, observation);
        expect(observer).toHaveBeenCalledWith(observation);

        reportTranslationRoute(null, observation);
        reportTranslationRoute('not-an-object', observation);
        reportTranslationRoute({}, observation);
        expect(observer).toHaveBeenCalledOnce();

        const throwingMessage = attachTranslationRouteObserver({origin: 'safe'}, () => {
            throw new Error('route telemetry failed');
        });
        expect(() => reportTranslationRoute(throwingMessage, observation)).not.toThrow();
    });

    it('keeps model usage observers process-local and isolates observer failures', () => {
        const observer = vi.fn();
        const message = attachTranslationModelUsageObserver({origin: 'hello'}, observer);
        const observation = {usageAvailability: 'unreported' as const};

        expect(message[TRANSLATION_MODEL_USAGE_OBSERVER]).toBe(observer);
        expect(JSON.stringify(message)).toBe('{"origin":"hello"}');
        reportTranslationModelUsage(message, observation);
        expect(observer).toHaveBeenCalledWith(observation);

        reportTranslationModelUsage(null, observation);
        reportTranslationModelUsage('not-an-object', observation);
        reportTranslationModelUsage({}, observation);

        const throwingMessage = attachTranslationModelUsageObserver({origin: 'safe'}, () => {
            throw new Error('telemetry failed');
        });
        expect(() => reportTranslationModelUsage(throwingMessage, observation)).not.toThrow();
    });

    it('reports only safe transport failure metadata and classifies aborted attempts', () => {
        vi.spyOn(Date, 'now').mockReturnValue(160);
        const observer = vi.fn();
        const controller = new AbortController();
        const message = attachTranslationModelUsageObserver({
            origin: 'hello',
            abortSignal: controller.signal,
        }, observer);

        reportTranslationModelUsageFailure(message, {statusCode: 429}, 100, 'model-a');
        reportTranslationModelUsageFailure(message, undefined, 120, 'model-b', 408);
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        reportTranslationModelUsageFailure(message, abortError, 200, undefined, 999);
        controller.abort();
        reportTranslationModelUsageFailure(message, new Error('network'), 170);
        reportTranslationModelUsageFailure(message, 'plain failure', 160);

        expect(observer.mock.calls).toEqual([
            [expect.objectContaining({
                startedAt: 100,
                durationMs: 60,
                actualModel: 'model-a',
                outcome: 'error',
                statusCode: 429,
            })],
            [expect.objectContaining({
                startedAt: 120,
                durationMs: 40,
                actualModel: 'model-b',
                outcome: 'timeout',
                statusCode: 408,
            })],
            [expect.objectContaining({
                startedAt: 200,
                durationMs: 0,
                outcome: 'cancelled',
            })],
            [expect.objectContaining({
                startedAt: 170,
                durationMs: 0,
                outcome: 'cancelled',
            })],
            [expect.objectContaining({
                startedAt: 160,
                durationMs: 0,
                outcome: 'cancelled',
            })],
        ]);
        expect(observer.mock.calls[2][0]).not.toHaveProperty('statusCode');
        expect(observer.mock.calls[3][0]).not.toHaveProperty('actualModel');
    });
});
