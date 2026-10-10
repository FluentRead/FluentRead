import {getGlossaryProtectionEntries, isGlossaryOnlyResult} from '@/src/services/translation/glossaryProtection';
import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {buildGlossaryRevision, type GlossaryLibrary} from '@/src/core/glossary';
import {serializeTranslationSlots} from '@/src/core/translation/public';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {supportsTranslationGlossary} from '@/src/services/translation/capabilities';
import {
    attachTranslationGlossaryContext,
    createTranslationProviderConfigSnapshot,
    getTranslationGlossaryTerms,
    getTranslationProviderConfig,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestMessage, TranslationProviderConfigSnapshot} from '@/src/services/translation/types';

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

function harness() {
    const config = Object.assign(new Config(), {
        service: 'openai', from: 'en', to: 'zh-Hans', useCache: true,
        glossaryEnabled: true, glossaryLibraries: [library()],
    });
    config.model.openai = 'model-fixture';
    const cache = new Map<string, string>();
    const identities: Record<string, unknown>[] = [];
    const calls: Array<{message: Record<string, unknown>; snapshot: TranslationProviderConfigSnapshot; body: any}> = [];
    const provider = vi.fn(async (message: Record<string, unknown>): Promise<unknown> => {
        const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
        const translate = (origin: string) => {
            const body = JSON.parse(commonMsgTemplate(origin, message.pageContext as string | undefined,
                message.summaryPrompt as string | undefined, message.summarySystemPrompt as string | undefined,
                'openai', 'zh-Hans', 'model-fixture', snapshot));
            calls.push({message, snapshot, body});
            if (message.summaryPrompt) return 'This page explains translation systems.';
            return snapshot.glossaryProtectedTokens?.some(token => origin.includes(token)) ? origin : `译文:${origin}`;
        };
        return Array.isArray(message.origin) ? message.origin.map(origin => translate(String(origin))) : translate(String(message.origin));
    });
    const get = vi.fn(async (key: string) => cache.get(key) ?? null);
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => config,
        providers: {openai: provider, microsoft: provider, tongyi: provider, custom: provider},
        cache: {get, set: async (key, value) => {cache.set(key, value); return true;}, clear: async () => {cache.clear();}, cleanup: async () => {}},
        serviceTypes: servicesType,
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}),
            aiSdkTransportProfile: 'fixture'},
        promptBuilder: {buildPageSummaryPrompt: text => `summarize ${text}`, buildPageSummarySystemPrompt: () => 'summary only'},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? 'en', targetLanguage: request?.targetLanguage ?? 'zh-Hans'}),
        resolveConfiguredModel,
        buildTranslationCacheKey: identity => {identities.push(identity); return JSON.stringify(identity);},
        logger: {warn: vi.fn()},
    });
    const request = (message: TranslationRequestMessage) => broker.translateWithCache(attachTranslationGlossaryContext(message,
        {pageUrl: 'https://docs.example.com/article', context: 'page'}));
    return {config, calls, identities, provider, cache, get, broker, request};
}

describe('术语库与真实翻译编排协作', () => {
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
        const body = JSON.parse(tongyiMsgTemplate(protectedPayload, undefined, undefined, undefined,
            'tongyi', 'zh-Hans', 'qwen-mt-plus', current));
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

describe('术语模板与服务协议', () => {
    it('高级请求体保留普通字段的覆盖语义，Qwen-MT 的 translation_options 保留未覆盖字段', () => {
        const config = Object.assign(new Config(), {glossaryTerms: [{source: 'agent', target: '智能体'}]});
        config.customBody.openai = JSON.stringify({messages: [{role: 'user', content: 'custom task'}]});
        config.customBody.tongyi = JSON.stringify({translation_options: {source_lang: 'auto', target_lang: 'English'}});
        const current = createTranslationProviderConfigSnapshot(config);
        const common = JSON.parse(commonMsgTemplate('agent', undefined, undefined, undefined, 'openai', 'zh-Hans', undefined, current));
        expect(common.messages).toEqual([{role: 'user', content: 'custom task'}]);
        const mt = JSON.parse(tongyiMsgTemplate('agent', undefined, undefined, undefined, 'tongyi', 'zh-Hans', 'qwen-mt-plus', current));
        expect(mt.translation_options).toEqual({source_lang: 'auto', target_lang: 'English', terms: [{source: 'agent', target: '智能体'}]});
    });

    it('Qwen-MT 自定义 terms 不覆盖自动生成的语言参数，并优先于词库术语', () => {
        const config = Object.assign(new Config(), {glossaryTerms: [{source: 'Token', target: '词元'}]});
        config.customBody.tongyi = JSON.stringify({translation_options: {terms: [{source: 'Token', target: 'Token'}]}});
        const current = createTranslationProviderConfigSnapshot(config);
        const body = JSON.parse(tongyiMsgTemplate('Token', undefined, undefined, undefined, 'tongyi', 'en', 'qwen-mt-flash', current, undefined, 'auto'));
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
            commonMsgTemplate('agent', undefined, undefined, undefined, 'openai', 'zh-Hans', undefined, current),
            deepseekMsgTemplate('agent', undefined, undefined, undefined, 'deepseek', 'zh-Hans', undefined, current),
            deepseekResponsesMsgTemplate('agent', undefined, undefined, undefined, 'deepseek', 'zh-Hans', undefined, current),
            geminiMsgTemplate('agent', undefined, undefined, undefined, 'gemini', 'zh-Hans', current),
            claudeMsgTemplate('agent', undefined, undefined, undefined, 'claude', 'zh-Hans', undefined, current),
            tongyiMsgTemplate('agent', undefined, undefined, undefined, 'tongyi', 'zh-Hans', undefined, current),
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
        const body = JSON.parse(tongyiMsgTemplate('agent', undefined, undefined, undefined, 'tongyi', 'zh-Hans', 'qwen-mt-plus', current));
        expect(body.messages).toEqual([{role: 'user', content: 'agent'}]);
        expect(body.translation_options.terms).toEqual([{source: 'agent', target: '智能体'}]);
        expect(JSON.stringify(body)).not.toContain('fluentread_glossary');
    });
});
