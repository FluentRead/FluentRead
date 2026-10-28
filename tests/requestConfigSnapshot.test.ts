import {describe, expect, it, vi} from 'vitest';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    attachTranslationRequestScheduler,
    getTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
    createTranslationRequestSnapshot,
    markTranslationRemainingBudget,
    getTranslationProviderConfig,
    requireTranslationProviderConfig,
    getTranslationProviderLanguages,
    getTranslationRequestControl,
    attachTranslationRouteObserver,
    reportTranslationModelUsage,
    reportTranslationModelUsageFailure,
    reportTranslationRoute,
    getTranslationGlossaryTerms,
    getTranslationGlossarySourceText,
    getTranslationGlossarySourceSlots,
    allowUnchangedTranslationResult,
    isUnchangedTranslationResultAllowed,
} from '@/src/services/translation/requestSnapshot';
import {TRANSLATION_MODEL_USAGE_OBSERVER, TRANSLATION_PROVIDER_CONFIG, TRANSLATION_REQUEST_CONTROL, TRANSLATION_REQUEST_SCHEDULER, TRANSLATION_ROUTE_OBSERVER, TRANSLATION_REMAINING_BUDGET} from '@/src/services/translation/types';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/public';
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
        requestHeaderRules: [{domain: 'api.example.com', removeOrigin: true, removeReferer: false}],
        customHeaders: {aiSdk: '{"x-session":"a"}'},
        system_role: {aiSdk: 'system-a'},
        user_role: {aiSdk: 'user-a'},
        deepseekApiType: 'chat',
        deepseekThinkingMode: 'disabled',
        ...overrides,
    };
}

describe('translation provider request config snapshot', () => {
    it('图片原样响应策略随内部快照和展开保留，公开字段与 JSON 无法附加策略', () => {
        const request = allowUnchangedTranslationResult({origin: 'Original English sentence.'});
        for (const internal of [request, {...request}, createTranslationRequestSnapshot(request)]) {
            expect(isUnchangedTranslationResultAllowed(internal)).toBe(true);
        }
        for (const publicRequest of [null, undefined, false, '', {acceptUnchangedResult: true}, JSON.parse(JSON.stringify(request))]) {
            expect(isUnchangedTranslationResultAllowed(publicRequest)).toBe(false);
        }
    });
    it.each(['chrome', 'userscript'])('保留 %s 的用户术语和严格槽原文，自动文档字面值仅用于扩展构建', browser => {
        vi.stubEnv('BROWSER', browser);
        try {
            const snapshot = createTranslationProviderConfigSnapshot(configSource({glossaryEnabled: true,
                glossaryLibraries: [{id: 'one', name: 'One', enabled: true, sourceLanguage: '', targetLanguage: '', domains: [],
                    entries: [{id: 'agent', source: 'agent', target: '智能体', caseSensitive: false}]}],
                glossaryTerms: [{source: 'agent', target: '智能体'}],
                glossaryMatchContext: {context: 'document', sourceLanguage: 'en', targetLanguage: 'zh-Hans', glossaryIds: ['one']},
            }));
            const origins = ['Use agent with 𝑛 ∈ ℎ.'];
            const slots = serializeTranslationSlots(origins, 'build_boundary');
            expect(getTranslationGlossarySourceText(slots.payload)).toEqual(origins);
            for (const source of [origins, slots.payload]) {
                expect(getTranslationGlossaryTerms(snapshot, source)).toEqual(browser === 'userscript'
                    ? [{source: 'agent', target: '智能体'}]
                    : [{source: 'agent', target: '智能体'}, {source: '𝑛', target: '𝑛'}, {source: '∈', target: '∈'}, {source: 'ℎ', target: 'ℎ'}]);
            }
            expect(getTranslationGlossaryTerms({...snapshot, glossaryMatchContext: {...snapshot.glossaryMatchContext!, context: 'page'}}, origins))
                .toEqual([{source: 'agent', target: '智能体'}]);
        } finally {vi.unstubAllEnvs();}
    });

    it('原生合批偏好在 provider 配置快照中默认开启并隔离后续编辑', () => {
        const preferences = {google: false, microsoft: true};
        const snapshot = createTranslationProviderConfigSnapshot(configSource({nativeBatchTranslationEnabled: preferences}));
        preferences.google = true;
        preferences.microsoft = false;
        expect(snapshot.nativeBatchTranslationEnabled).toMatchObject({google: false, microsoft: true, deepL: true});
        expect(Object.isFrozen(snapshot.nativeBatchTranslationEnabled)).toBe(true);
        expect(createTranslationProviderConfigSnapshot(configSource()).nativeBatchTranslationEnabled)
            .toMatchObject({google: true, microsoft: true, deepL: true, azureTranslator: true, googleCloudTranslation: true});
    });

    it('占位符约束按当前单条或批量片段筛选，不外发其他片段的标记', () => {
        const snapshot = {...createTranslationProviderConfigSnapshot(configSource()),
            glossaryProtectedTokens: ['__FRTERM_first__', '__FRTERM_second__']};
        expect(getTranslationGlossaryTerms(snapshot, 'Only __FRTERM_first__ here'))
            .toEqual([{source: '__FRTERM_first__', target: '__FRTERM_first__'}]);
        expect(getTranslationGlossaryTerms(snapshot, ['__FRTERM_second__', 'plain']))
            .toEqual([{source: '__FRTERM_second__', target: '__FRTERM_second__'}]);
        expect(getTranslationGlossaryTerms(snapshot, 'plain')).toEqual([]);
    });
    it('消息快照复制数组与标量，保留全部内部 symbol 的属性描述符', () => {
        const control = {signal: new AbortController().signal, ownershipKey: 'snapshot'};
        const original = attachTranslationRequestControl({origin: ['Before'], glossaryIds: ['library-a'], targetLanguage: 'zh-Hans'}, control);
        const snapshot = createTranslationRequestSnapshot(original);
        original.origin[0] = 'After';
        original.glossaryIds.push('library-b');
        original.targetLanguage = 'ja';
        expect(snapshot).toMatchObject({origin: ['Before'], glossaryIds: ['library-a'], targetLanguage: 'zh-Hans'});
        expect(getTranslationRequestControl(snapshot)).toEqual(control);
        expect(Object.getOwnPropertyDescriptor(snapshot, TRANSLATION_REQUEST_CONTROL)).toEqual(Object.getOwnPropertyDescriptor(original, TRANSLATION_REQUEST_CONTROL));
        expect(createTranslationRequestSnapshot({origin: 'Scalar', glossaryIds: null})).toEqual({origin: 'Scalar', glossaryIds: null});
        expect(createTranslationRequestSnapshot({origin: 'Scalar'})).toEqual({origin: 'Scalar'});
    });
    it('可读消息字段在入口只取值一次，getter 数组与标量不会继续读取外部状态', () => {
        const origins = ['Before'];
        const ids = ['library-a'];
        let target = 'zh-Hans';
        const reads = {origin: 0, glossaryIds: 0, targetLanguage: 0};
        const snapshot = createTranslationRequestSnapshot({
            get origin() { reads.origin += 1; return origins; },
            get glossaryIds() { reads.glossaryIds += 1; return ids; },
            get targetLanguage() { reads.targetLanguage += 1; return target; },
        });
        origins.push('After');
        ids.push('library-b');
        target = 'ja';
        expect(snapshot.origin).toEqual(['Before']);
        expect(snapshot.glossaryIds).toEqual(['library-a']);
        expect(snapshot.targetLanguage).toBe('zh-Hans');
        expect(reads).toEqual({origin: 1, glossaryIds: 1, targetLanguage: 1});
    });
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
        const lease = {holdUntil: vi.fn()};
        const request = attachTranslationRequestScheduler({origin: 'hello'}, scheduler, identity, lease);
        identity.model = 'model-b';
        const context = getTranslationRequestScheduler(request)!;
        expect(context.scheduler).toBe(scheduler);
        expect(context.lease).toBe(lease);
        expect(context.identity).toEqual({service: 'aiSdk', model: 'model-a'});
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.identity)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(request, TRANSLATION_REQUEST_SCHEDULER)?.enumerable).toBe(true);
        for (const copy of [createTranslationRequestSnapshot(request), {...request}]) {
            expect(getTranslationRequestScheduler(copy)).toBe(context);
            expect(getTranslationRequestScheduler(copy)!.lease).toBe(lease);
        }
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
        expect(getTranslationGlossarySourceSlots(packet.payload)).toEqual({packet, texts: ['agent', 'An agent works.']});
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(['agent', 'An agent works.']);
        expect(getTranslationGlossarySourceText(['plain', packet.payload])).toEqual(['plain', 'agent', 'An agent works.']);
        for (const text of [packet.payload.replace(packet.ends[0], ''), `${packet.payload} outside`,
            `literal ${packet.payload}`, '___FLUENTREAD_partial_0_BEGIN___agent']) {
            expect(getTranslationGlossarySourceSlots(text)).toBeUndefined();
            expect(getTranslationGlossarySourceText(text)).toBe(text);
        }
    });
    it('短命名空间的长正文不会分配按全文长度增长的边界表', () => {
        const text = 'readable words. '.repeat(15000);
        const packet = serializeTranslationSlots([text], 'short');
        const NativeArray = globalThis.Uint32Array;
        const allocations: number[] = [];
        vi.stubGlobal('Uint32Array', new Proxy(NativeArray, {
            construct(target, args) {
                if (typeof args[0] === 'number') allocations.push(args[0]);
                return Reflect.construct(target, args);
            },
        }));
        try {
            expect(getTranslationGlossarySourceSlots(packet.payload)).toEqual({packet, texts: [text]});
            expect(allocations.length).toBeGreaterThan(0);
            expect(Math.max(...allocations)).toBeLessThan(256);
        } finally { vi.unstubAllGlobals(); }
    });
    it('正文中的完整重复前缀不能冒充外层槽边界', () => {
        const start = '___FLUENTREAD_x_0_BEGIN___';
        const end = '___FLUENTREAD_x_0_END___';
        const malformed = `${start} ${start} text ${end}`;
        expect(getTranslationGlossarySourceSlots(malformed)).toBeUndefined();
        expect(getTranslationGlossarySourceText(malformed)).toBe(malformed);
    });
    it('当合法前缀覆盖长正文时仍正确恢复来源和字面重叠标记', () => {
        const texts = ['a'.repeat(5000), '___FLUENTREAD_literal_999_BEGIN___ and readable source'];
        const packet = serializeTranslationSlots(texts, 'literal');
        expect(getTranslationGlossarySourceSlots(packet.payload)).toEqual({packet, texts});
    });

    it('keeps out-of-range and nonstandard literal markers inside their source slots', () => {
        const sources = ['An agent reads ___FLUENTREAD_literal_999_BEGIN___example___FLUENTREAD_literal_999_END___ and ___FLUENTREAD_literal_01_BEGIN___text___FLUENTREAD_literal_01_END___.',
            'The next source explains translation settings.'];
        const packet = serializeTranslationSlots(sources, 'literal');
        expect(packet.starts[0]).toBe('___FLUENTREAD_literal_0_BEGIN___');
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it('uses the final outer slot boundary when the last source contains the next index as a literal marker', () => {
        const sources = ['An agent reads.', 'The final source contains ___FLUENTREAD_literal_2_BEGIN___example___FLUENTREAD_literal_2_END___ and continues.'];
        const packet = serializeTranslationSlots(sources, 'literal');
        expect(packet.starts[0]).toBe('___FLUENTREAD_literal_0_BEGIN___');
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it.each(['duplicate', 'gap', 'reversed'] as const)('rejects %s real slot markers instead of inferring a valid source packet', variant => {
        const packet = serializeTranslationSlots(['An agent reads.', 'The next source explains settings.'], 'invalid');
        const malformed = variant === 'duplicate' ? packet.payload.replace('An agent reads.', `${packet.starts[0]}An agent reads.`)
            : variant === 'gap' ? packet.payload.replaceAll('_1_', '_2_')
            : `${packet.starts[1]}The next source explains settings.${packet.ends[1]}\n${packet.starts[0]}An agent reads.${packet.ends[0]}`;
        expect(getTranslationGlossarySourceText(malformed)).toBe(malformed);
    });
    it('preserves a different namespace literal BEGIN at the very start of the first source', () => {
        const sources = ['___FLUENTREAD_literal_0_BEGIN___ The software reads the document and translates the language on this page.', 'The second paragraph explains the settings for the computer network.'];
        const packet = serializeTranslationSlots(sources);
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it.each(['Case_1-x', 'Case_0_BEGIN___tail', 'x_0_BEGIN______FLUENTREAD_x'])('preserves serializer nonce compatibility for %s', nonce => {
        const sources = ['___FLUENTREAD_literal_0_BEGIN___ An agent reads.', 'The settings explain the computer network.'];
        const packet = serializeTranslationSlots(sources, nonce);
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it('restores plain source terms for a nonce containing a complete nested marker prefix', () => {
        const sources = ['agent', 'An agent works.'];
        const packet = serializeTranslationSlots(sources, 'x_0_BEGIN______FLUENTREAD_x');
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it('preserves a valid source sharing marker underscores across the first boundary', () => {
        const sources = ['FLUENTREAD_x_0_BEGIN'];
        const packet = serializeTranslationSlots(sources, 'x');
        expect(packet.starts[0]).toBe('___FLUENTREAD_x_0_BEGIN___');
        expect(parseTranslationSlots(packet, packet.payload)).toEqual(sources);
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it.each(['collision', 'x_0_BEGIN______FLUENTREAD_x'])('restores source after serializer avoids a real marker collision in %s', nonce => {
        const sources = [`___FLUENTREAD_${nonce}_0_BEGIN___ An agent reads.`, 'The settings explain the computer network.'];
        const packet = serializeTranslationSlots(sources, nonce);
        expect(packet.starts[0]).toBe(`___FLUENTREAD_${nonce}_1_0_BEGIN___`);
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it('keeps an incomplete source with thousands of possible nonce delimiters intact', () => {
        const text = '___FLUENTREAD_x' + '_0_BEGIN___'.repeat(5000) + ' source';
        expect(getTranslationGlossarySourceText(text)).toBe(text);
    });
    it.each([
        '___FLUENTREAD_invalid_1_BEGIN___source___FLUENTREAD_invalid_0_END___',
        '___FLUENTREAD_invalid_0_BEGIN___ plain source___FLUENTREAD_invalid_0_BEGIN___ plain _0_END___',
        '___FLUENTREAD_0_END___',
        '___FLUENTREAD_!_0_END___',
    ])('rejects malformed outer namespace boundaries: %s', text => {
        expect(getTranslationGlossarySourceText(text)).toBe(text);
    });
    it('preserves a long valid nonce containing many possible BEGIN delimiters', () => {
        const sources = ['agent', 'An agent works.'];
        const packet = serializeTranslationSlots(sources, 'x' + '_0_BEGIN___'.repeat(512) + 'tail');
        expect(getTranslationGlossarySourceText(packet.payload)).toEqual(sources);
    });
    it('keeps a long malformed source with a final ordinal but no matching namespace intact', () => {
        const text = '___FLUENTREAD_x' + '_0_BEGIN___'.repeat(5000) + ' source___FLUENTREAD_wrong_0_END___';
        expect(getTranslationGlossarySourceText(text)).toBe(text);
    });
    it('does not allocate slots from an unsafe integer in a malformed final marker', () => {
        const malformed = '___FLUENTREAD_invalid_0_BEGIN___source___FLUENTREAD_invalid_999999999999999999999_END___';
        expect(getTranslationGlossarySourceText(malformed)).toBe(malformed);
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
        source.requestHeaderRules![0].removeOrigin = false;
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
            requestHeaderRules: [{domain: 'api.example.com', removeOrigin: true, removeReferer: false}],
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
            snapshot.requestHeaderRules,
            snapshot.requestHeaderRules![0],
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

    it('沿用附着对象身份而不执行 lazy fallback，消息复制仍保留可信 symbol', () => {
        const snapshot = createTranslationProviderConfigSnapshot(configSource());
        const fallback = vi.fn(() => {throw new Error('unused fallback');});
        const message = attachTranslationProviderConfig({origin: 'hello'}, snapshot);

        expect(getTranslationProviderConfig(message, fallback)).toBe(snapshot);
        expect(getTranslationProviderConfig(createTranslationRequestSnapshot(message), fallback)).toBe(snapshot);
        expect(fallback).not.toHaveBeenCalled();
        expect(JSON.stringify(message)).toBe('{"origin":"hello"}');
    });

    it('仅在缺失可信 symbol 时同步调用一次 factory，不接受同名 JSON 字段或跨调用保存结果', () => {
        const snapshot = createTranslationProviderConfigSnapshot(configSource());
        for (const message of [undefined, null, 'not-an-object', {}, {TRANSLATION_PROVIDER_CONFIG: snapshot}]) {
            const fallback = vi.fn(() => snapshot);
            const result = getTranslationProviderConfig(message, fallback);
            expect(fallback).toHaveBeenCalledOnce();
            expect(result).toBe(snapshot);
        }
        const next = createTranslationProviderConfigSnapshot(configSource({service: 'next'}));
        const changingFallback = vi.fn().mockReturnValueOnce(snapshot).mockReturnValueOnce(next);
        expect(getTranslationProviderConfig({}, changingFallback)).toBe(snapshot);
        expect(getTranslationProviderConfig({}, changingFallback)).toBe(next);
        expect(changingFallback).toHaveBeenCalledTimes(2);
    });

    it('同步原样抛出 miss factory 的异常而不替换或重复调用', () => {
        const failure = new Error('snapshot unavailable');
        const fallback = vi.fn(() => {throw failure;});
        let thrown: unknown;
        try {getTranslationProviderConfig({}, fallback);} catch (error) {thrown = error;}
        expect(thrown).toBe(failure);
        expect(fallback).toHaveBeenCalledOnce();
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


describe('provider 显式配置边界', () => {
    it.each([undefined, null, 'invalid', {}, {origin: 'Hello'}])('缺少快照时明确拒绝 %j', message => {
        expect(() => requireTranslationProviderConfig(message)).toThrow('缺少配置快照');
        try {
            requireTranslationProviderConfig(message);
        } catch (error) {
            expect(error).toMatchObject({code: 'TRANSLATION_PROVIDER_CONFIG_REQUIRED'});
        }
    });

    it('保留调用边界的原快照并从同一快照解析语言缺省及请求覆盖', () => {
        const source = configSource({from: 'en', to: 'zh-Hant'});
        const snapshot = createTranslationProviderConfigSnapshot(source);
        const request = attachTranslationProviderConfig({origin: 'Hello'}, snapshot);
        source.from = 'ja';
        source.to = 'en';
        expect(requireTranslationProviderConfig(request)).toBe(snapshot);
        expect(getTranslationProviderLanguages(request)).toEqual({sourceLanguage: 'en', targetLanguage: 'zh-Hant'});
        expect(getTranslationProviderLanguages(attachTranslationProviderConfig({sourceLanguage: 'fr', targetLanguage: 'zh-CN'}, snapshot)))
            .toEqual({sourceLanguage: 'fr', targetLanguage: 'zh-Hans'});
    });
});


it('请求快照保留进程内剩余预算标记，runtime/JSON 投影不会伪造该权限', () => {
    const marked = markTranslationRemainingBudget({origin: 'Source', requestTimeoutMs: 125});
    const copied = createTranslationRequestSnapshot(marked);
    expect(copied.requestTimeoutMs).toBe(125);
    expect(copied[TRANSLATION_REMAINING_BUDGET]).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copied, TRANSLATION_REMAINING_BUDGET))
        .toEqual(Object.getOwnPropertyDescriptor(marked, TRANSLATION_REMAINING_BUDGET));
    expect(JSON.parse(JSON.stringify(marked))).toEqual({origin: 'Source', requestTimeoutMs: 125});
    expect(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(marked)))).toEqual([]);
});

it('组合请求的成员与策略在捕获后不受设置页原地编辑影响', () => {
    const source = configSource({compositeTranslationProviders: [{
        id: 'composite:study', name: '学习组合', strategy: 'sequential',
        services: ['google', 'aiSdk'], timeoutMs: 30_000,
    }]});
    const snapshot = createTranslationProviderConfigSnapshot(source);
    const profile = source.compositeTranslationProviders![0];
    profile.services.reverse();
    profile.services.push('microsoft');
    profile.name = '改名';
    profile.timeoutMs = 60_000;
    expect(snapshot.compositeTranslationProviders![0]).toEqual({
        id: 'composite:study', name: '学习组合', strategy: 'sequential',
        services: ['google', 'aiSdk'], timeoutMs: 30_000,
    });
    expect(Object.isFrozen(snapshot.compositeTranslationProviders![0])).toBe(true);
    expect(Object.isFrozen(snapshot.compositeTranslationProviders![0].services)).toBe(true);
});
