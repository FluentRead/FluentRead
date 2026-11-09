import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {getGlossaryProtectionEntries, isGlossaryOnlyResult, prepareGlossaryRequest} from '@/src/services/translation/glossaryProtection';
import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {buildGlossaryRevision, type GlossaryLibrary} from '@/src/core/glossary';
import {hasOnlyCommonWebTerms, matchCommonWebTerms} from '@/src/core/glossary/commonWebTerms';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/public';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {supportsTranslationGlossary} from '@/src/services/translation/capabilities';
import {
    attachTranslationGlossaryContext,
    attachTranslationRequestControl,
    attachTranslationProviderConfig,
    createTranslationProviderConfigSnapshot,
    getTranslationGlossaryTerms,
    getTranslationProviderConfig,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestMessage, TranslationProviderConfigSnapshot} from '@/src/services/translation/types';

type GlossaryResolutionEvent = {
    api: 'resolveGlossary' | 'resolveGlossaryEntries';
    text: string | string[];
    terms: Array<{source: string; target: string; caseSensitive?: boolean}>;
};
const glossaryResolutionTrace = vi.hoisted(() => ({events: [] as GlossaryResolutionEvent[]}));
vi.mock('@/src/core/glossary', async importOriginal => {
    const actual = await importOriginal<typeof import('@/src/core/glossary')>();
    return {...actual,
        resolveGlossary: (...args: Parameters<typeof actual.resolveGlossary>) => {
            const result = actual.resolveGlossary(...args);
            glossaryResolutionTrace.events.push({api: 'resolveGlossary', text: args[1].text,
                terms: result.terms.map(term => ({...term}))});
            return result;
        },
        resolveGlossaryEntries: (...args: Parameters<typeof actual.resolveGlossaryEntries>) => {
            const result = actual.resolveGlossaryEntries(...args);
            glossaryResolutionTrace.events.push({api: 'resolveGlossaryEntries', text: args[1].text,
                terms: result.terms.map(term => ({...term}))});
            return result;
        },
    };
});

vi.mock('@/src/services/config/store', () => ({config: {to: 'zh-Hans'}}));
import {
    commonMsgTemplate, deepseekMsgTemplate, deepseekResponsesMsgTemplate,
    geminiMsgTemplate, claudeMsgTemplate, tongyiMsgTemplate,
} from '@/src/services/translation/templates';

function library(id = 'technical', target = '智能体', domains: string[] = []): GlossaryLibrary {
    return {id, name: id, enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains,
        entries: [
            {id: 'agent', source: 'agent', target, caseSensitive: false},
            {id: 'unrelated', source: 'unrelated', target: '此条不该发送', caseSensitive: false},
        ]};
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
    return {promise, resolve};
}

function harness(service = 'openai', model = 'model-fixture', now?: () => number) {
    const config = Object.assign(new Config(), {
        service, from: 'en', to: 'zh-Hans', useCache: true,
        glossaryEnabled: true, glossaryLibraries: [library()],
    });
    config.model[service] = model;
    const cache = new Map<string, string>();
    const identities: Record<string, unknown>[] = [];
    const resolutionCaptures: Array<{identity: Record<string, unknown>; eventEnd: number; providerCalls: number}> = [];
    const calls: Array<{message: TranslationProviderRequest; snapshot: TranslationProviderConfigSnapshot; body: any}> = [];
    const provider = vi.fn(async (message: TranslationProviderRequest): Promise<unknown> => {
        const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
        const translate = (origin: string) => {
            const body = JSON.parse(commonMsgTemplate({origin, context: message.pageContext as string | undefined, prompt: message.summaryPrompt as string | undefined, systemPrompt: message.summarySystemPrompt as string | undefined, serviceOverride: service, targetLanguage: 'zh-Hans', modelOverride: message.modelOverride ?? model, current: snapshot}));
            calls.push({message, snapshot, body});
            if (message.summaryPrompt) return 'This page explains translation systems.';
            return snapshot.glossaryProtectedTokens?.some(token => origin.includes(token)) ? origin : `译文:${origin}`;
        };
        return Array.isArray(message.origin) ? message.origin.map(origin => translate(String(origin))) : translate(String(message.origin));
    });
    const get = vi.fn(async (key: string) => cache.get(key) ?? null);
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => config, now,
        providers: {openai: provider, microsoft: provider, tongyi: provider, custom: provider, siliconCloud: provider},
        cache: {get, set: async (key, value) => {cache.set(key, value); return true;}, clear: async () => {cache.clear();}, cleanup: async () => {}},
        serviceTypes: servicesType,
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}),
            aiSdkTransportProfile: 'fixture'},
        promptBuilder: {buildPageSummaryPrompt: text => `summarize ${text}`, buildPageSummarySystemPrompt: () => 'summary only'},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? 'en', targetLanguage: request?.targetLanguage ?? 'zh-Hans'}),
        resolveConfiguredModel,
        buildTranslationCacheKey: identity => {
            identities.push(identity);
            resolutionCaptures.push({identity, eventEnd: glossaryResolutionTrace.events.length, providerCalls: provider.mock.calls.length});
            return JSON.stringify(identity);
        },
        logger: {warn: vi.fn()},
    });
    const request = (message: TranslationRequestMessage) => broker.translateWithCache(attachTranslationGlossaryContext(message,
        {pageUrl: 'https://docs.example.com/article', context: 'page'}));
    return {config, calls, identities, resolutionCaptures, provider, cache, get, broker, request};
}

// Checkpoints stop at the real cache-key dependency, before provider protection and quality validation.
// The public request's first full-source selection is validated separately from each key's local work.
function resolutionCheckpoint(h: ReturnType<typeof harness>) {
    return {eventStart: glossaryResolutionTrace.events.length, captureStart: h.resolutionCaptures.length,
        providerCalls: h.provider.mock.calls.length};
}

function keyResolutionRows(h: ReturnType<typeof harness>, start: ReturnType<typeof resolutionCheckpoint>,
    text: string | string[], initialTerms: Array<{source: string; target: string}>) {
    expect(glossaryResolutionTrace.events[start.eventStart]).toEqual({api: 'resolveGlossary', text, terms: initialTerms});
    let cursor = start.eventStart + 1;
    return h.resolutionCaptures.slice(start.captureStart).map(capture => {
        expect(capture.providerCalls).toBe(start.providerCalls);
        const events = glossaryResolutionTrace.events.slice(cursor, capture.eventEnd);
        cursor = capture.eventEnd;
        return {identity: capture.identity, events};
    });
}

describe('术语库与真实翻译编排协作', () => {
    const hunyuanModel = 'tencent/Hunyuan-MT-7B';
    const avengers = 'Avengers Tower has shown up in Shanghai.';
    const avengersTranslation = '复仇者大厦出现在上海。';

    it('默认词表仅匹配完整技术词及原有大小写，用户短语先占用匹配位置', () => {
        expect(hasOnlyCommonWebTerms(' API / SDK · JSON ')).toBe(true);
        for (const text of ['—', 'api', 'Use the API', 'API_v2', 'PHP API', 'API 2026']) {
            expect(hasOnlyCommonWebTerms(text), text).toBe(false);
        }
        expect(matchCommonWebTerms('API JSON OpenAI API_v2 mySDK github')).toEqual([
            {source: 'API', target: '', caseSensitive: true},
            {source: 'JSON', target: '', caseSensitive: true},
            {source: 'OpenAI', target: '', caseSensitive: true},
        ]);
        expect(matchCommonWebTerms('SDK-based and API-ready.', [
            {source: 'API-ready', target: '接口已就绪', caseSensitive: true},
        ]).map(term => term.source)).toEqual(['SDK']);
        expect(matchCommonWebTerms(['ordinary words', 'myAPI and api_v2'])).toEqual([]);
        expect(matchCommonWebTerms('用API访问，再读取JSON。').map(term => term.source)).toEqual(['API', 'JSON']);
    });

    it.each(['microsoft', 'openai'])('%s 按原位置保留独立词槽，正文中的术语经保护后回填', async service => {
        const h = harness(service);
        h.config.glossaryEnabled = false;
        const record = h.provider.getMockImplementation()!;
        h.provider.mockImplementation(async message => {
            await record(message);
            const translate = (source: string) => source.replace('Use the ', '使用 ').replace(' to read ', ' 读取 ').replace(/\.$/u, '。');
            return Array.isArray(message.origin) ? message.origin.map(translate) : translate(message.origin);
        });
        await expect(h.request({origin: ' API / SDK · JSON '})).resolves.toBe(' API / SDK · JSON ');
        await expect(h.request({origin: ['SDK', 'API', 'JSON']})).resolves.toEqual(['SDK', 'API', 'JSON']);
        expect(h.provider).not.toHaveBeenCalled();
        expect(h.get).not.toHaveBeenCalled();

        const prose = 'Use the API to read JSON.';
        const origin = ['API', prose, ' SDK ', prose];
        for (const pageUrl of ['https://docs.example.net/guide', 'https://forum.example.org/discussion']) {
            await expect(h.broker.translateWithCache(attachTranslationGlossaryContext({origin}, {pageUrl, context: 'page'})))
                .resolves.toEqual(['API', '使用 API 读取 JSON。', ' SDK ', '使用 API 读取 JSON。']);
        }
        expect(h.provider).toHaveBeenCalledTimes(1);
        expect(h.calls[0].message.origin).toEqual([expect.stringMatching(/^Use the __FRTERM_.* to read __FRTERM_/u)]);
        expect(h.calls[0].snapshot.glossaryProtectedTokens).toHaveLength(2);
        expect(h.identities).toEqual(expect.arrayContaining([expect.objectContaining({
            glossaryTerms: [{source: 'API', target: 'API'}, {source: 'JSON', target: 'JSON'}],
        })]));
    });

    it('站点范围内的用户译法覆盖默认词表，其他站点保留原写法', async () => {
        const h = harness();
        const custom = library('overrides', '智能体', ['docs.example.com']);
        custom.entries = [{id: 'api', source: 'api', target: '接口', caseSensitive: false}];
        h.config.glossaryLibraries = [custom];
        await expect(h.request({origin: 'API'})).resolves.toBe('接口');
        await expect(h.broker.translateWithCache(attachTranslationGlossaryContext({origin: 'API'},
            {pageUrl: 'https://forum.example.org/discussion', context: 'page'}))).resolves.toBe('API');
        expect(h.provider).toHaveBeenCalledTimes(1);
        expect(h.calls[0].snapshot.glossaryProtectedTokens).toHaveLength(1);
    });

    it('纯术语富文本直接原样返回，混合槽中的独立术语忽略供应商扩写', async () => {
        const h = harness();
        h.config.glossaryEnabled = false;
        const label = serializeTranslationSlots(['API', ' / ', 'SDK']);
        await expect(h.request({origin: label.payload, validateTranslationSlots: true})).resolves.toBe(label.payload);
        expect(h.provider).not.toHaveBeenCalled();
        const source = 'Select a date to read the latest records.';
        const mixed = serializeTranslationSlots(['API', source]);
        h.provider.mockImplementationOnce(async message => String(message.origin)
            .replace(/__FRTERM_[a-z0-9_]+?__/u, '$&（应用程序编程接口）')
            .replace(source, '选择日期以查看最新记录。'));
        for (let attempt = 0; attempt < 2; attempt++) {
            const translated = await h.request({origin: mixed.payload, validateTranslationSlots: true});
            expect(parseTranslationSlots(mixed, translated as string)).toEqual(['API', '选择日期以查看最新记录。']);
        }
        expect(h.provider).toHaveBeenCalledTimes(1);
    });

    it('保护正文的词条参与缓存身份，字幕结果与已保存的无保护结果隔离', async () => {
        const h = harness();
        h.config.glossaryEnabled = false;
        const origin = 'Call the API to fetch the latest records.';
        h.provider.mockResolvedValueOnce('调用应用程序编程接口读取最新记录。');
        h.provider.mockImplementationOnce(async message =>
            `调用 ${String(message.origin).match(/__FRTERM_[a-z0-9_]+?__/u)![0]} 读取最新记录。`);
        await expect(h.broker.translateWithCache({origin, glossaryContext: 'video'})).resolves.toContain('应用程序编程接口');
        await expect(h.request({origin})).resolves.toBe('调用 API 读取最新记录。');
        await expect(h.request({origin})).resolves.toBe('调用 API 读取最新记录。');
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.identities[0]).not.toHaveProperty('glossaryTerms');
        expect(h.identities[1]).toMatchObject({glossaryTerms: [{source: 'API', target: 'API'}]});
    });

    it('Hunyuan emoji 字面重试仍核对常用术语的字形和次数', async () => {
        const origin = 'Call the API to retrieve the records. 🥹';
        for (const result of ['调用 API 读取记录。🥹', '调用接口读取记录。🥹']) {
            const h = harness('siliconCloud', hunyuanModel);
            h.config.glossaryEnabled = false;
            h.provider.mockResolvedValueOnce('调用接口读取记录。').mockResolvedValueOnce(result);
            const pending = h.request({origin});
            if (result.includes('API')) await expect(pending).resolves.toBe(result);
            else await expect(pending).rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID'});
            expect(h.provider).toHaveBeenCalledTimes(2);
        }
    });

    it.each([
        ['A', `${avengers} 🥹`, true],
        ['B', `${avengers} 🥹 #avengers #ironman #spiderman #hulk💚 #captainamerica`, false],
        ['C', `${avengers} 🥹 avengers ironman spiderman hulk💚 captainamerica`, false],
        ['D', avengers, false],
        ['E', `🥹 ${avengers}`, true],
    ] as const)('硅基流动 Hunyuan emoji 复现样例 %s', async (_label, origin, losesMarker) => {
        const h = harness('siliconCloud', hunyuanModel);
        h.config.glossaryEnabled = false;
        h.config.user_role.siliconCloud = 'Translate into {{to}}. Preserve emoji. {{origin}}';
        const record = h.provider.getMockImplementation()!;
        h.provider.mockImplementation(async message => {
            await record(message);
            const translated = String(message.origin).replace(avengers, avengersTranslation);
            return losesMarker ? translated.replace(/__FRTERM_[a-z0-9_]+?__/giu, '').trim() : translated;
        });
        const expected = origin.replace(avengers, avengersTranslation);
        await expect(h.request({origin})).resolves.toBe(expected);
        expect(h.provider).toHaveBeenCalledTimes(losesMarker ? 2 : 1);
        if (losesMarker) {
            expect(h.calls[0].body.messages[1].content).toContain('__FRTERM_');
            expect(h.calls[1].message.origin).toBe(origin);
            expect(h.calls[1].body.messages[1].content).toContain(`Preserve emoji. ${origin}`);
            expect(h.calls[1].body.messages[1].content).not.toContain('__FRTERM_');
            expect(h.calls[1].body.messages[0]).toEqual(h.calls[0].body.messages[0]);
        }
        await expect(h.request({origin})).resolves.toBe(expected);
        expect(h.provider).toHaveBeenCalledTimes(losesMarker ? 2 : 1);
    });

    it.each(['已翻译。', '🥹', '已翻译。 🥹 🥹', '已翻译。 🧪', '已翻译。 🥹 __FRTERM_unknown_0__', null])(
        '硅基流动 Hunyuan emoji 重试拒绝无效结果 %s 且不缓存',
        async second => {
            const h = harness('siliconCloud', hunyuanModel);
            h.config.glossaryEnabled = false;
            h.provider.mockResolvedValueOnce('已翻译。').mockResolvedValueOnce(second);
            await expect(h.request({origin: `${avengers} 🥹`})).rejects.toMatchObject({
                code: 'GLOSSARY_PLACEHOLDER_INVALID', retryable: false, message: expect.stringContaining('表情符号'),
            });
            expect(h.provider).toHaveBeenCalledTimes(2);
            expect(h.cache.size).toBe(0);
        },
    );

    it.each([
        ['agent 🥹', hunyuanModel],
        ['Read 🥹.\nContinue here.', hunyuanModel],
        [serializeTranslationSlots(['Read 🥹.', 'Continue.'], 'hunyuan-emoji').payload, hunyuanModel],
        ['Read 🥹.', 'another-model'],
    ])('匹配术语、结构标记、多行或其他模型时维持原校验 %s', async (origin, model) => {
        const h = harness('siliconCloud', model);
        h.provider.mockResolvedValue('已翻译。');
        await expect(h.request({origin})).rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID'});
        expect(h.provider).toHaveBeenCalledTimes(1);
        expect(h.cache.size).toBe(0);
    });

    it('字面 emoji 重试沿用剩余预算且取消后不发布迟到结果', async () => {
        let time = 0;
        const h = harness('siliconCloud', hunyuanModel, () => time);
        const retry = deferred<TranslationProviderRequest>();
        const reply = deferred<string>();
        const controller = new AbortController();
        h.provider.mockImplementationOnce(async () => {
            time += 200;
            return '已翻译。';
        }).mockImplementationOnce(message => {
            retry.resolve(message);
            return reply.promise;
        });
        const pending = h.request(attachTranslationRequestControl({origin: `${avengers} 🥹`, requestTimeoutMs: 1000}, {
            signal: controller.signal, ownershipKey: 'hunyuan-emoji-retry',
        }));
        const cancelled = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        const second = await retry.promise;
        expect(second.requestTimeoutMs).toBe(800);
        controller.abort();
        reply.resolve(`${avengersTranslation} 🥹`);
        await cancelled;
        expect(second.abortSignal?.aborted).toBe(true);
        expect(h.cache.size).toBe(0);
    });

    it('无词库时按完整字素保护正文，旧丢失 emoji 缓存不会命中新身份', async () => {
        const h = harness();h.config.glossaryEnabled = false;
        const origin = 'Deliver 🚚 then Gate1️⃣ and 👩🏽‍🔬.';
        const record = h.provider.getMockImplementation()!;
        h.provider.mockImplementation(async message => String(await record(message)).replace('Deliver', '运送'));
        await expect(h.request({origin})).resolves.toBe(origin.replace('Deliver', '运送'));
        expect(h.calls[0].snapshot.glossaryProtectedTokens).toHaveLength(3);
        expect(h.calls[0].message.origin).not.toContain('🚚');expect(h.calls[0].message.origin).not.toContain('1️⃣');
        expect(h.identities[0]).toMatchObject({emojiLiteralProtection: {version: 1}});
        const previous = {...h.identities[0]};delete previous.emojiLiteralProtection;
        h.cache.clear();h.cache.set(JSON.stringify(previous), '送达然后离开。');
        await expect(h.request({origin})).resolves.toBe(origin.replace('Deliver', '运送'));
        expect(h.provider).toHaveBeenCalledTimes(2);
        await expect(h.request({origin: 'Plain text.'})).resolves.toBe('译文:Plain text.');
        expect(h.identities.at(-1)).not.toHaveProperty('emojiLiteralProtection');
    });
    it('emoji 与用户术语共用严格恢复，重复、外来或跨段标记不能显示或缓存', async () => {
        const h = harness();
        h.config.glossaryLibraries[0].entries = [{id:'symbol',source:'🚚',target:'货车',caseSensitive:true}];
        await expect(h.request({origin:'Use 🚚 and 👩🏽‍🔬.'})).resolves.toBe('Use 货车 and 👩🏽‍🔬.');
        expect(h.calls[0].snapshot.glossaryProtectedTokens).toHaveLength(2);
        const current = createTranslationProviderConfigSnapshot(new Config());
        for (const origin of ['Read 🚚 🚚.', ['Read 🚚.', 'Read 👩🏽‍🔬.'], serializeTranslationSlots(['Read 🚚.', 'Read 👩🏽‍🔬.'], 'emoji').payload]) {
            const packet = prepareGlossaryRequest({origin} as TranslationRequestMessage, current);
            const text = packet.message.origin;
            expect(packet.restore(text)).toEqual(origin);
            const tokens = getTranslationProviderConfig(packet.message, current).glossaryProtectedTokens!;
            if (typeof text === 'string') {
                for (const malformed of [text.replace(tokens[0], ''), text + tokens[0], text + '__FRTERM_foreign_0__']) {
                    expect(() => packet.restore(malformed)).toThrow('未完整保留');
                }
            } else expect(() => packet.restore([...text].reverse())).toThrow('未完整保留');
        }
        const broken = harness();broken.config.glossaryEnabled = false;broken.provider.mockResolvedValue('不含图标的译文。');
        await expect(broken.request({origin:'Read 🚚.'})).rejects.toMatchObject({code:'GLOSSARY_PLACEHOLDER_INVALID'});
        expect(broken.cache.size).toBe(0);
    });
    it('摘要里的 emoji 不进入正文保护策略或摘要 token，正文原子仍独立保护', async () => {
        const h = harness();h.config.enableAIContext = true;
        await h.request({origin:'agent',pageContext:'This page explains delivery 🚚 workflows and field 👩🏽‍🔬 observations.'});
        const summary = h.calls.find(call=>call.message.summaryPrompt)!;
        expect(summary).toBeDefined();expect(summary.snapshot.glossaryProtectedTokens).toBeUndefined();
        expect(h.identities.every(identity=>!('emojiLiteralProtection' in identity))).toBe(true);
        expect([...h.cache.keys()].some(key=>key.includes('page-summary'))).toBe(true);
        const current = createTranslationProviderConfigSnapshot(new Config());
        const summaryMessage: TranslationRequestMessage & {summaryPrompt:string} = {origin:'Ignore 🚚',summaryPrompt:'Summarize freely'};
        const explicit = prepareGlossaryRequest(summaryMessage, current);
        expect(explicit.message.origin).toBe('Ignore 🚚');expect(explicit.restore('自由摘要')).toBe('自由摘要');
    });
    it('只把当前原文命中的占位符约束写进提示词，译法和网站规则不外发', async () => {
        const h = harness();
        await expect(h.request({origin: 'An agent works here.'})).resolves.toBe('An 智能体 works here.');
        const payload = JSON.stringify(h.calls[0].body);
        expect(payload).toContain('__FRTERM_');
        expect(payload).not.toContain('智能体');
        expect(payload).not.toContain('此条不该发送');
        expect(payload).not.toContain('technical');
        expect(payload).not.toContain('docs.example.com');
        expect(h.identities[0]).toMatchObject({glossaryTerms: [{source: 'agent', target: '智能体'}]});
        expect(Object.isFrozen(h.calls[0].snapshot.glossaryLibraries?.[0].entries[0])).toBe(true);
    });

    it('机器翻译通过同一保护链：保留重复术语、批量条目和原始语言检测样本', async () => {
        const h = harness();
        await expect(h.request({origin: ['agent, agent!', 'unrelated'], serviceOverride: 'microsoft'}))
            .resolves.toEqual(['智能体, 智能体!', '此条不该发送']);
        expect(h.calls[0].message.sourceLanguageDetectionText).toBe('agent, agent!\nunrelated');
        expect(String(h.calls[0].message.origin)).not.toContain('agent');
        await expect(h.request({origin: 'agent', serviceOverride: 'microsoft', glossaryRevision: 'old-version'}))
            .rejects.toMatchObject({code: 'GLOSSARY_REVISION_CHANGED'});
    });

    it('服务损坏或重复标记时不显示或缓存残缺译文，重新翻译能恢复', async () => {
        const h = harness();
        h.provider.mockResolvedValueOnce('服务把术语丢失了');
        await expect(h.request({origin: 'agent'})).rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID', retryable: false});
        expect(h.cache.size).toBe(0);
        await expect(h.request({origin: 'agent'})).resolves.toBe('智能体');
        expect([...h.cache.values()]).toEqual(['智能体']);
    });

    it('批量结果不能把另一个片段的标记串入本条或返回错误形状', async () => {
        for (const result of ['wrong shape', ['missing'], [null, null]]) {
            const h = harness();
            h.provider.mockResolvedValue(result);
            await expect(h.request({origin: ['agent', 'unrelated'], serviceOverride: 'microsoft'}))
                .rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID'});
            expect(h.cache.size).toBe(0);
        }
        const h = harness();
        h.provider.mockImplementation(async message => [...message.origin as string[]].reverse());
        await expect(h.request({origin: ['agent', 'unrelated'], serviceOverride: 'microsoft'}))
            .rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID'});
    });

    it('未命中片段不能混入相邻片段的标记，原片段即使保留标记也拒绝整包', async () => {
        const h = harness();
        h.provider.mockImplementation(async message => {
            const origins = message.origin as string[];
            return [origins[0], `其他译文 ${origins[0]}`];
        });
        await expect(h.request({origin: ['agent', 'no match'], serviceOverride: 'microsoft'}))
            .rejects.toMatchObject({code: 'GLOSSARY_PLACEHOLDER_INVALID'});
        expect(h.cache.size).toBe(0);
    });

    it('同一原词的大小写规则改变后不复用旧缓存', async () => {
        const h = harness();
        await expect(h.request({origin: 'Agent agent'})).resolves.toBe('智能体 智能体');
        h.config.glossaryLibraries[0].entries[0].caseSensitive = true;
        await expect(h.request({origin: 'Agent agent'})).resolves.toBe('Agent 智能体');
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('用户指定整句保留原文不会被回显校验拒绝，缓存仍可复用', async () => {
        const h = harness();
        h.config.glossaryLibraries[0].entries = [{id: 'phrase', source: 'large language model', target: '', caseSensitive: false}];
        for (let i = 0; i < 2; i++) await expect(h.request({origin: 'large language model'})).resolves.toBe('large language model');
        expect(h.provider).toHaveBeenCalledTimes(1);
    });

    it('错语种重试后尊重整句术语的保留原文规则，不继续重试或误报失败', async () => {
        const h = harness();
        h.config.glossaryLibraries[0].entries = [{id: 'phrase', source: 'これは日本語の文章です。翻訳結果を確認してください。', target: '', caseSensitive: false}];
        h.provider.mockImplementationOnce(async message => `${message.origin} これは日本語の文章です。翻訳結果を確認してください。`);
        await expect(h.request({origin: 'これは日本語の文章です。翻訳結果を確認してください。'})).resolves.toBe('これは日本語の文章です。翻訳結果を確認してください。');
        expect(h.provider).toHaveBeenCalledTimes(2);
        await expect(h.request({origin: 'これは日本語の文章です。翻訳結果を確認してください。'})).resolves.toBe('これは日本語の文章です。翻訳結果を確認してください。');
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('缺失词库或当前片段无实际词条时不能豁免回显检查', () => {
        const snapshot = createTranslationProviderConfigSnapshot(new Config());
        const missing = {...snapshot, glossaryLibraries: undefined, glossaryTerms: [{source: 'agent', target: '智能体'}],
            glossaryMatchContext: {sourceLanguage: 'en', targetLanguage: 'zh-hans'}};
        expect(getGlossaryProtectionEntries(missing, 'agent')).toEqual([]);
        expect(isGlossaryOnlyResult(missing, 'agent', 'agent')).toBe(false);
    });

    it('文档的地址、代码式产品名与组合模型名自动保护，缓存与普通网页请求隔离', async () => {
        const h = harness();
        h.config.glossaryEnabled = false;
        const origin = 'FluentRead GNMT+RL https://github.com/tensorflow/tensor2tensor';
        await expect(h.broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe(origin);
        const identity = h.identities[0];
        expect(identity).toMatchObject({glossaryTerms: [
            {source: 'FluentRead', target: 'FluentRead'}, {source: 'GNMT+RL', target: 'GNMT+RL'},
            {source: 'https://github.com/tensorflow/tensor2tensor', target: 'https://github.com/tensorflow/tensor2tensor'},
        ]});
        expect(h.calls[0].snapshot.glossaryProtectedTokens).toHaveLength(3);
        expect(String(h.calls[0].message.origin)).not.toContain('tensorflow');
        await expect(h.broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe(origin);
        expect(h.provider).toHaveBeenCalledTimes(1);
        await expect(h.broker.translateWithCache({origin, glossaryContext: 'page'})).resolves.toBe(`译文:${origin}`);
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.config.glossaryLibraries).toEqual([library()]);
    });

    it('网站范围只采用内部真实来源，原文上下文和同名payload不能冒充网站', async () => {
        const h = harness();
        h.config.glossaryLibraries = [library('private', '内部代理', ['private.example'])];
        await expect(h.request({origin: 'agent', pageContext: 'https://private.example',
            ...{pageUrl: 'https://private.example'}})).resolves.toBe('译文:agent');
        await expect(h.broker.translateWithCache(attachTranslationGlossaryContext({origin: 'agent'},
            {pageUrl: 'https://private.example/path', context: 'page'}))).resolves.toBe('内部代理');
    });

    it('显式空选择和关闭总开关不干预原来的翻译结果', async () => {
        const h = harness();
        await expect(h.request({origin: 'agent', glossaryIds: []})).resolves.toBe('译文:agent');
        h.config.glossaryEnabled = false;
        await expect(h.request({origin: 'agent'})).resolves.toBe('译文:agent');
        expect(h.calls.every(call => !JSON.stringify(call.body).includes('fluentread_glossary'))).toBe(true);
        expect(h.identities.every(identity => !Object.hasOwn(identity, 'glossaryTerms'))).toBe(true);
    });

    it('文档和视频继承各自默认选择，显式空数组仍关闭', async () => {
        const h = harness();
        h.config.glossaryLibraries = [library(), library('video', '视频代理'), library('document', '文档代理')];
        h.config.videoGlossaryIds = ['video'];
        h.config.documentGlossaryIds = ['document'];
        await expect(h.broker.translateWithCache({origin: 'agent', glossaryContext: 'video'})).resolves.toBe('视频代理');
        await expect(h.broker.translateWithCache({origin: 'agent', glossaryContext: 'document'})).resolves.toBe('文档代理');
        await expect(h.broker.translateWithCache({origin: 'agent', glossaryContext: 'video', glossaryIds: []})).resolves.toBe('译文:agent');
    });

    it('编辑命中词后隔离缓存；编辑未命中词仍可复用相同译文', async () => {
        const h = harness();
        await h.request({origin: 'agent'});
        h.config.glossaryLibraries[0].entries[1].target = '无关修改';
        await h.request({origin: 'agent'});
        expect(h.provider).toHaveBeenCalledTimes(1);
        h.config.glossaryLibraries[0].entries[0].target = '代理人';
        await expect(h.request({origin: 'agent'})).resolves.toBe('代理人');
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('慢缓存读取期间编辑配置不会改变旧请求词对，且并发新版本不会复用旧pending', async () => {
        const h = harness();
        const gate = deferred<string | null>();
        const entered = deferred<void>();
        h.get.mockImplementationOnce(async () => {entered.resolve(); return gate.promise;});
        const oldRequest = h.request({origin: 'agent'});
        await entered.promise;
        h.config.glossaryLibraries[0].entries[0].target = '代理人';
        const newRequest = h.request({origin: 'agent'});
        await expect(newRequest).resolves.toBe('代理人');
        gate.resolve(null);
        await expect(oldRequest).resolves.toBe('智能体');
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.calls.map(call => call.snapshot.glossaryTerms?.[0].target)).toEqual(['代理人', '智能体']);
    });

    it('长任务携带的旧revision报不可重试错误，新任务使用新词库正常完成', async () => {
        const h = harness();
        const revision = buildGlossaryRevision(h.config.glossaryLibraries, true);
        h.config.glossaryLibraries[0].entries[0].target = '代理人';
        await expect(h.request({origin: 'agent', glossaryRevision: revision})).rejects.toMatchObject({
            code: 'GLOSSARY_REVISION_CHANGED', retryable: false, message: '术语库已更新，请重新翻译',
        });
        expect(h.provider).not.toHaveBeenCalled();
        await expect(h.request({origin: 'agent', glossaryRevision: buildGlossaryRevision(h.config.glossaryLibraries, true)})).resolves.toBe('代理人');
    });

    it('批量provider逐条发上游时不会把另一个片段才命中的词一起发送', async () => {
        const h = harness();
        await expect(h.request({origin: ['agent', 'unrelated']})).resolves.toEqual(['智能体', '此条不该发送']);
        expect(JSON.stringify(h.calls[0].body)).toContain('__FRTERM_');
        expect(JSON.stringify(h.calls[0].body)).not.toContain('此条不该发送');
        expect(JSON.stringify(h.calls[1].body)).toContain('__FRTERM_');
        expect(JSON.stringify(h.calls[1].body)).not.toContain('智能体');
    });

    it('AI多段真实broker协议保留首尾英文术语，哨兵本身不作为词条外发', async () => {
        const h = harness();
        const origins = ['agent', 'Use agent'];
        const packet = serializeTranslationSlots(origins);
        h.config.glossaryLibraries[0].entries.push({id: 'protocol', source: packet.starts[0], target: '内部标记不外发', caseSensitive: true});
        const originalProvider = h.provider.getMockImplementation()!;
        h.provider.mockImplementation(async message => {
            await originalProvider(message);
            const snapshot = h.calls.at(-1)!.snapshot;
            let translated = String(message.origin);
            for (const term of getTranslationGlossaryTerms(snapshot, translated)) {
                translated = translated.replaceAll(term.source, term.target);
            }
            return translated;
        });
        await expect(h.request({origin: origins, aiMultiSegment: true})).resolves.toEqual(['智能体', 'Use 智能体']);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].message.origin).toContain(packet.starts[0]);
        expect(h.calls[0].message.origin).toContain('__FRTERM_');
        const body = JSON.stringify(h.calls[0].body);
        expect(body).toContain('__FRTERM_');
        expect(body).not.toContain('内部标记不外发');
    });

    it('入口已经序列化的文本槽仍以纯原文建立术语缓存身份和Qwen原生terms', async () => {
        const h = harness();
        const packet = serializeTranslationSlots(['agent', 'More text']);
        await h.request({origin: packet.payload, serviceOverride: 'tongyi', modelOverride: 'qwen-mt-plus'});
        const current = h.calls[0].snapshot;
        const protectedPayload = String(h.calls[0].message.origin);
        const body = JSON.parse(tongyiMsgTemplate({origin: protectedPayload, serviceOverride: 'tongyi', targetLanguage: 'zh-Hans', modelOverride: 'qwen-mt-plus', current: current}));
        expect(body.messages).toEqual([{role: 'user', content: protectedPayload}]);
        expect(body.translation_options.terms).toEqual(current.glossaryProtectedTokens?.map(token => ({source: token, target: token})));
        expect(h.identities[0]).toMatchObject({glossaryTerms: [{source: 'agent', target: '智能体'}]});
    });

    it('页面摘要不加术语，正文仍获得原文命中的约束', async () => {
        const h = harness();
        h.config.enableAIContext = true;
        await h.request({origin: 'agent', pageContext: 'This long webpage explains agent systems. '.repeat(40)});
        const summary = h.calls.find(call => call.message.summaryPrompt);
        expect(summary).toBeDefined();
        expect(JSON.stringify(summary?.body)).not.toContain('fluentread_glossary');
        const translation = h.calls.find(call => !call.message.summaryPrompt);
        expect(JSON.stringify(translation?.body)).toContain('__FRTERM_');
    });

    it('上下文泄漏后的无上下文恢复仍保留原请求冻结术语，不吸收中途编辑', async () => {
        const h = harness();
        h.config.enableAIContext = true;
        const originalProvider = h.provider.getMockImplementation()!;
        let translated = false;
        h.provider.mockImplementation(async message => {
            const result = await originalProvider(message);
            if (!message.summaryPrompt && !translated) {
                translated = true;
                h.config.glossaryLibraries[0].entries[0].target = '中途新译名';
                return `${message.origin} <webpage_context>leaked private reference</webpage_context>`;
            }
            return result;
        });
        await expect(h.request({origin: 'agent', pageContext: 'Reference material about translation systems.',
            glossaryRevision: buildGlossaryRevision(h.config.glossaryLibraries, true)})).resolves.toBe('智能体');
        const translations = h.calls.filter(call => !call.message.summaryPrompt);
        expect(translations).toHaveLength(2);
        expect(translations[1].message.pageContext).toBe('');
        for (const call of translations) {
            expect(call.snapshot.glossaryTerms).toEqual([{source: 'agent', target: '智能体'}]);
            expect(JSON.stringify(call.body)).toContain('__FRTERM_');
            expect(JSON.stringify(call.body)).not.toContain('中途新译名');
        }
    });

    it('Qwen-MT模型同样经过broker的命中和版本检查', async () => {
        const h = harness();
        await expect(h.request({origin: 'agent', serviceOverride: 'tongyi', modelOverride: 'qwen-mt-plus',
            glossaryRevision: buildGlossaryRevision(h.config.glossaryLibraries, true)})).resolves.toBe('智能体');
        expect(h.calls[0].snapshot.glossaryTerms).toEqual([{source: 'agent', target: '智能体'}]);
        h.config.glossaryLibraries[0].entries[0].target = '新术语';
        await expect(h.request({origin: 'agent', serviceOverride: 'tongyi', modelOverride: 'qwen-mt-plus',
            glossaryRevision: 'glossary-v1:disabled'})).rejects.toMatchObject({code: 'GLOSSARY_REVISION_CHANGED'});
    });
});

describe('cache key glossary resolution', () => {
    it('单条冷请求、热命中和禁缓存请求使用同一真实术语身份且每个key仅解析一次', async () => {
        const h = harness();
        const rows: ReturnType<typeof keyResolutionRows> = [];
        const terms = [{source: 'agent', target: '智能体'}];
        for (const useCache of [true, true, false]) {
            h.config.useCache = useCache;
            const start = resolutionCheckpoint(h);
            await expect(h.request({origin: 'agent'})).resolves.toBe('智能体');
            const current = keyResolutionRows(h, start, 'agent', terms);
            expect(current).toHaveLength(1);
            expect(current[0].identity).toMatchObject({requestMode: 'single', sourceText: 'agent', glossaryTerms: terms,
                glossaryProtection: {version: 1, entries: [{source: 'agent', target: '智能体', caseSensitive: false}]}});
            rows.push(...current);
        }
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.get).toHaveBeenCalledTimes(2);
        expect(rows.map(row => row.identity)).toEqual([rows[0].identity, rows[0].identity, rows[0].identity]);
        expect(rows.map(row => row.events.length)).toEqual([1, 1, 1]);
        expect(rows.map(row => row.events[0].api)).toEqual(['resolveGlossaryEntries', 'resolveGlossaryEntries', 'resolveGlossaryEntries']);
    });

    it('批量实际复用已缓存分项，未命中术语的分项不增加扫描，命中key复用raw条目', async () => {
        const h = harness();
        await expect(h.request({origin: ['agent']})).resolves.toEqual(['智能体']);
        const start = resolutionCheckpoint(h);
        const origin = ['agent', 'no match', 'unrelated'];
        const allTerms = [{source: 'unrelated', target: '此条不该发送'}, {source: 'agent', target: '智能体'}];
        await expect(h.request({origin})).resolves.toEqual(['智能体', '译文:no match', '此条不该发送']);
        const rows = keyResolutionRows(h, start, origin, allTerms);
        expect(rows.map(row => row.identity.sourceText)).toEqual([origin, ...origin]);
        expect(rows[0].identity).toMatchObject({glossaryTerms: allTerms, glossaryProtection: {version: 1,
            entries: [{source: 'unrelated', target: '此条不该发送', caseSensitive: false}, {source: 'agent', target: '智能体', caseSensitive: false}]}});
        expect(rows[1].identity).toMatchObject({glossaryTerms: [{source: 'agent', target: '智能体'}]});
        expect(rows[2].identity).not.toHaveProperty('glossaryTerms');
        expect(rows[2].identity).not.toHaveProperty('glossaryProtection');
        expect(rows[3].identity).toMatchObject({glossaryTerms: [{source: 'unrelated', target: '此条不该发送'}]});
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.calls.slice(1).map(call => call.message.sourceLanguageDetectionText)).toEqual(['no match\nunrelated', 'no match\nunrelated']);
        expect(h.calls.slice(1).map(call => String(call.message.origin))).not.toContain('agent');
        expect(rows[2].events).toHaveLength(1);
        expect(rows[2].events[0]).toMatchObject({text: 'no match', terms: []});
        expect([rows[0], rows[1], rows[3]].map(row => row.events.length)).toEqual([1, 1, 1]);
        expect([rows[0], rows[1], rows[3]].map(row => row.events[0].api)).toEqual(['resolveGlossaryEntries', 'resolveGlossaryEntries', 'resolveGlossaryEntries']);
    });

    it.each([
        ['hit', ['manual-token'], 'agent manual-token', '智能体 manual-token', 1],
        ['miss', ['manual-token'], 'agent', '智能体', 0],
        ['empty', [], 'agent', '智能体', 0],
    ] as const)('protectedTokens %s保持现有分支、输出与key局部扫描', async (_label, tokens, origin, result, scans) => {
        const h = harness();
        const snapshot = createTranslationProviderConfigSnapshot({...h.config, glossaryProtectedTokens: tokens});
        const start = resolutionCheckpoint(h);
        await expect(h.request(attachTranslationProviderConfig({origin}, snapshot))).resolves.toBe(result);
        const rows = keyResolutionRows(h, start, origin, [{source: 'agent', target: '智能体'}]);
        expect(rows).toHaveLength(1);
        if (scans) {
            expect(rows[0].identity).toMatchObject({glossaryTerms: [{source: 'manual-token', target: 'manual-token'}],
                glossaryProtection: {version: 1, entries: [{source: 'agent', target: '智能体', caseSensitive: false}]}});
        } else {
            expect(rows[0].identity).not.toHaveProperty('glossaryTerms');
            expect(rows[0].identity).not.toHaveProperty('glossaryProtection');
        }
        expect(h.provider).toHaveBeenCalledTimes(1);
        expect(rows[0].events.length).toBe(scans);
        if (scans) expect(rows[0].events[0].api).toBe('resolveGlossaryEntries');
    });

    it('长词优先、大小写敏感与空target保护保持raw身份而提示词terms回退source', async () => {
        const h = harness();
        h.config.glossaryLibraries[0].entries = [
            {id: 'short', source: 'agent', target: '短词', caseSensitive: false},
            {id: 'long', source: 'agent system', target: '', caseSensitive: false},
            {id: 'case', source: 'Token', target: '词元', caseSensitive: true},
        ];
        const origin = 'AGENT SYSTEM / Token / token / agent';
        const terms = [{source: 'agent system', target: 'agent system'}, {source: 'agent', target: '短词'}, {source: 'Token', target: '词元'}];
        const start = resolutionCheckpoint(h);
        await expect(h.request({origin})).resolves.toBe('AGENT SYSTEM / 词元 / token / 短词');
        const rows = keyResolutionRows(h, start, origin, terms);
        expect(rows).toHaveLength(1);
        expect(rows[0].identity).toMatchObject({glossaryTerms: terms, glossaryProtection: {version: 1,
            entries: [{source: 'agent system', target: '', caseSensitive: false}, {source: 'agent', target: '短词', caseSensitive: false},
                {source: 'Token', target: '词元', caseSensitive: true}]}});
        expect(h.calls[0].snapshot.glossaryTerms).toEqual(terms);
        expect(rows[0].events.length).toBe(1);
        expect(rows[0].events[0].api).toBe('resolveGlossaryEntries');
    });

    it('完整槽协议按解包原文匹配而保留完整缓存source与原生槽校验', async () => {
        const h = harness();
        const sources = ['agent', 'Use agent'];
        const packet = serializeTranslationSlots(sources);
        h.config.glossaryLibraries[0].entries.push({id: 'protocol', source: packet.starts[0], target: '内部标记不外发', caseSensitive: true});
        const start = resolutionCheckpoint(h);
        const result = await h.request({origin: packet.payload, validateTranslationSlots: true});
        expect(result).toBe(packet.payload.replaceAll('agent', '智能体'));
        expect(parseTranslationSlots(packet, String(result))).toEqual(['智能体', 'Use 智能体']);
        const terms = [{source: 'agent', target: '智能体'}];
        const rows = keyResolutionRows(h, start, sources, terms);
        expect(rows).toHaveLength(1);
        expect(rows[0].identity).toMatchObject({requestMode: 'slot-protocol', sourceText: packet.payload, glossaryTerms: terms,
            glossaryProtection: {version: 1, entries: [{source: 'agent', target: '智能体', caseSensitive: false}]}});
        expect(JSON.stringify(h.calls[0].body)).not.toContain('内部标记不外发');
        expect(rows[0].events.length).toBe(1);
        expect(rows[0].events[0].api).toBe('resolveGlossaryEntries');
    });
});

describe('术语模板与服务协议', () => {
    it('高级请求体保留普通字段的覆盖语义，Qwen-MT 的 translation_options 保留未覆盖字段', () => {
        const config = Object.assign(new Config(), {glossaryTerms: [{source: 'agent', target: '智能体'}]});
        config.customBody.openai = JSON.stringify({messages: [{role: 'user', content: 'custom task'}]});
        config.customBody.tongyi = JSON.stringify({translation_options: {source_lang: 'auto', target_lang: 'English'}});
        const current = createTranslationProviderConfigSnapshot(config);
        const common = JSON.parse(commonMsgTemplate({origin: 'agent', serviceOverride: 'openai', targetLanguage: 'zh-Hans', current: current}));
        expect(common.messages).toEqual([{role: 'user', content: 'custom task'}]);
        const mt = JSON.parse(tongyiMsgTemplate({origin: 'agent', serviceOverride: 'tongyi', targetLanguage: 'zh-Hans', modelOverride: 'qwen-mt-plus', current: current}));
        expect(mt.translation_options).toEqual({source_lang: 'auto', target_lang: 'English', terms: [{source: 'agent', target: '智能体'}]});
    });

    it('Qwen-MT 自定义 terms 不覆盖自动生成的语言参数，并优先于词库术语', () => {
        const config = Object.assign(new Config(), {glossaryTerms: [{source: 'Token', target: '词元'}]});
        config.customBody.tongyi = JSON.stringify({translation_options: {terms: [{source: 'Token', target: 'Token'}]}});
        const current = createTranslationProviderConfigSnapshot(config);
        const body = JSON.parse(tongyiMsgTemplate({origin: 'Token', serviceOverride: 'tongyi', targetLanguage: 'en', modelOverride: 'qwen-mt-flash', current: current, sourceLanguage: 'auto'}));
        expect(body.translation_options).toEqual({source_lang: 'auto', target_lang: 'en', terms: [{source: 'Token', target: 'Token'}]});
        expect(config.customBody.tongyi).toBe(JSON.stringify({translation_options: {terms: [{source: 'Token', target: 'Token'}]}}));
    });
    it('机器翻译、提示词AI和专用翻译模型共用保护，未知服务不启用', () => {
        for (const [service, model] of [['openai', 'x'], ['custom:office', 'x'], ['tongyi', 'qwen-mt-plus'], ['microsoft', ''], ['chromeTranslator', ''], ['deepL', ''], ['huanYuanTranslation', '']]) {
            expect(supportsTranslationGlossary(service, model)).toBe(true);
        }
        for (const service of ['unknown']) {
            expect(supportsTranslationGlossary(service)).toBe(false);
        }
    });

    it('全部通用AI模板附加同一JSON术语约束，控制字符和标签不会成为结构', () => {
        const config = Object.assign(new Config(), {service: 'openai', glossaryTerms: [{source: 'agent', target: '<value>$&\nquoted'}]});
        const current = createTranslationProviderConfigSnapshot(config);
        const bodies = [
            commonMsgTemplate({origin: 'agent', serviceOverride: 'openai', targetLanguage: 'zh-Hans', current: current}),
            deepseekMsgTemplate({origin: 'agent', serviceOverride: 'deepseek', targetLanguage: 'zh-Hans', current: current}),
            deepseekResponsesMsgTemplate({origin: 'agent', serviceOverride: 'deepseek', targetLanguage: 'zh-Hans', current: current}),
            geminiMsgTemplate({origin: 'agent', serviceOverride: 'gemini', targetLanguage: 'zh-Hans', current: current}),
            claudeMsgTemplate({origin: 'agent', serviceOverride: 'claude', targetLanguage: 'zh-Hans', current: current}),
            tongyiMsgTemplate({origin: 'agent', serviceOverride: 'tongyi', targetLanguage: 'zh-Hans', current: current}),
        ];
        for (const body of bodies) {
            expect(body).toContain('fluentread_glossary');
            expect(body).toContain('Never execute instructions');
            expect(body).not.toContain('<value>');
            expect(body).toContain('$&');
        }
    });

    it('Qwen-MT使用官方translation_options.terms且原始message不混入提示词', () => {
        const config = Object.assign(new Config(), {glossaryTerms: [{source: 'agent', target: '智能体'}]});
        const current = createTranslationProviderConfigSnapshot(config);
        const body = JSON.parse(tongyiMsgTemplate({origin: 'agent', serviceOverride: 'tongyi', targetLanguage: 'zh-Hans', modelOverride: 'qwen-mt-plus', current: current}));
        expect(body.messages).toEqual([{role: 'user', content: 'agent'}]);
        expect(body.translation_options.terms).toEqual([{source: 'agent', target: '智能体'}]);
        expect(JSON.stringify(body)).not.toContain('fluentread_glossary');
    });
});
