import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {describe, expect, it, vi} from 'vitest';
import {addBuiltinGlossary, BUILTIN_GLOSSARIES} from '@/src/core/glossary/builtins';
import {buildGlossaryRevision, createGlossaryLibrary, exportGlossary, GLOSSARY_LIMITS,
    normalizeGlossaryLibraries, parseGlossaryImport, protectGlossaryText, resolveGlossary, resolveGlossaryEntries,
    type GlossaryLibrary} from '@/src/core/glossary';
import {normalizeConfig} from '@/src/core/config/model';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {translate} from '@/src/core/i18n';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {createTranslationBroker} from '@/src/services/translation/broker';

vi.mock('@/src/services/config/store', () => ({config: {to: 'zh-Hans'}}));

function add(id = 'ai-en-zh-hans', libraries: GlossaryLibrary[] = []): GlossaryLibrary {
    const result = addBuiltinGlossary(id, libraries, `My ${id}`);
    expect(result.status).toBe('added');
    if (result.status !== 'added') throw new Error(result.status);
    return result.library;
}

describe('离线内置术语词库', () => {
    it('提供八套真实且唯一的规范词表，全部通过既有配置边界并有七语说明', () => {
        expect(BUILTIN_GLOSSARIES).toHaveLength(8);
        expect(new Set(BUILTIN_GLOSSARIES.map(preset => preset.id)).size).toBe(8);
        expect(BUILTIN_GLOSSARIES.map(preset => preset.terms.length)).toEqual([65, 60, 50, 40, 30, 30, 30, 30]);
        for (const preset of BUILTIN_GLOSSARIES) {
            const library = add(preset.id);
            expect(normalizeGlossaryLibraries([library])).toEqual([library]);
            expect(library.entries.length).toBeLessThanOrEqual(GLOSSARY_LIMITS.entriesPerLibrary);
            expect(new Set(library.entries.map(term => term.source.toLowerCase())).size).toBe(library.entries.length);
            expect(library.entries.every(term => term.source.trim() && !term.source.includes('?'))).toBe(true);
            for (const key of [preset.nameKey, preset.descriptionKey]) {
                for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
                    expect(translate(key, language)).not.toBe(key);
                }
            }
        }
    });

    it.each([
        ['hardware-en-zh-hans', 'Memory bandwidth and cache coherence matter.', '内存带宽 and 缓存一致性 matter.'],
        ['networking-en-zh-hans', 'Cloud computing uses object storage.', '云计算 uses 对象存储.'],
        ['mathematics-en-zh-hans', 'Linear algebra uses matrix multiplication.', '线性代数 uses 矩阵乘法.'],
    ])('新增 %s 沿真实匹配与保护链路采用完整短语，仅在指定语言范围生效', (id, text, restored) => {
        const library = add(id);
        const context = {text, sourceLanguage: 'en', targetLanguage: 'zh-CN'};
        const packet = protectGlossaryText(text, resolveGlossaryEntries([library], context).terms);
        expect(packet.tokens).toHaveLength(2); expect(packet.restore(packet.text)).toBe(restored);
        expect(resolveGlossaryEntries([library], {...context, targetLanguage: 'ja'}).terms).toEqual([]);
        expect(resolveGlossaryEntries([library], {...context, sourceLanguage: 'fr'}).terms).toEqual([]);
        library.enabled = false; expect(resolveGlossaryEntries([library], context).terms).toEqual([]);
    });

    it('仅追加可编辑副本，保留原顺序和独立对象，不修改目录或用户数据', () => {
        const existing = createGlossaryLibrary([]);
        const before = structuredClone(existing);
        const catalog = structuredClone(BUILTIN_GLOSSARIES);
        const result = addBuiltinGlossary('ai-en-zh-hans', [existing], 'AI 阅读');
        expect(result.status).toBe('added');
        if (result.status !== 'added') throw new Error(result.status);
        expect(result.libraries[0]).toEqual(before);
        expect(result.libraries[1]).toBe(result.library);
        expect(result.library.id).not.toBe(existing.id);
        expect(result.library).toMatchObject({name: 'AI 阅读', enabled: true, preset: {id: 'ai-en-zh-hans', version: 2}});
        result.library.entries[0].target = '用户自己的译法';
        result.library.domains.push('example.com');
        expect(BUILTIN_GLOSSARIES).toEqual(catalog);
        expect(existing).toEqual(before);
        expect(add().entries[0].target).toBe('人工智能');
    });

    it('重命名、编辑、停用及其他版本副本不会重复添加或被当前版本覆盖，删除后可重新添加', () => {
        const library = add();
        Object.assign(library, {name: '定制模型译法', enabled: false, entries: [], preset: {id: 'ai-en-zh-hans', version: 1}});
        const before = structuredClone(library);
        expect(addBuiltinGlossary('ai-en-zh-hans', [createGlossaryLibrary([]), library], '新名称')).toEqual({status: 'existing', library});
        expect(library).toEqual(before);
        expect(add().entries).toHaveLength(65);
        expect(addBuiltinGlossary('unknown', [], '未知')).toEqual({status: 'unknown'});
    });

    it('添加前检查词库和总词条容量，不靠截断数据静默成功，已有副本在满额时仍能查看', () => {
        const full = Array.from({length: 20}, (_, index) => ({...createGlossaryLibrary([]), id: `lib-${index}`}));
        expect(addBuiltinGlossary('ai-en-zh-hans', full, 'AI')).toEqual({status: 'capacity'});
        full[19] = add();
        expect(addBuiltinGlossary('ai-en-zh-hans', full, 'AI').status).toBe('existing');
        const dense = normalizeGlossaryLibraries(Array.from({length: 10}, (_, libraryIndex) => ({
            ...createGlossaryLibrary([]), id: `dense-${libraryIndex}`,
            entries: Array.from({length: libraryIndex < 9 ? 500 : 436}, (_, index) => ({
                id: `term-${index}`, source: `s${index}`, target: '', caseSensitive: false,
            })),
        })));
        expect(addBuiltinGlossary('ai-en-zh-hans', dense, 'AI')).toEqual({status: 'capacity'});
        dense[9].entries.pop();
        expect(addBuiltinGlossary('ai-en-zh-hans', dense, 'AI').status).toBe('added');
    });

    it('复用真实匹配器：领域词限定英语到简中，产品词按大小写保留，显式停用不生效', () => {
        const libraries = [add(), add('product-names')];
        const context = {text: 'GitHub uses a large language model; github and GitHubs do not match.', sourceLanguage: 'en', targetLanguage: 'zh-CN'};
        expect(resolveGlossary(libraries, context).terms).toEqual([
            {source: 'large language model', target: '大语言模型'}, {source: 'GitHub', target: 'GitHub'},
        ]);
        for (const language of ['zh-TW', 'ja', 'en']) {
            expect(resolveGlossary(libraries, {...context, targetLanguage: language}).terms).toEqual([{source: 'GitHub', target: 'GitHub'}]);
        }
        expect(resolveGlossary([libraries[0]], {...context, sourceLanguage: 'fr'}).terms).toEqual([]);
        libraries[0].enabled = false;
        expect(resolveGlossary(libraries, context).terms).toEqual([{source: 'GitHub', target: 'GitHub'}]);
        libraries[0].enabled = true; libraries[0].domains = ['example.com'];
        expect(resolveGlossary([libraries[0]], context).terms).toEqual([]);
        expect(resolveGlossary([libraries[0]], {...context, pageUrl: 'https://example.com/article'}).terms).toHaveLength(1);
    });

    it('新版 AI 副本保护真实注意力段落的模型名和完整术语，空译法保留每次原文大小写', () => {
        const library = add();
        const scope = {sourceLanguage: 'en', targetLanguage: 'zh-CN', glossaryIds: [library.id]};
        const examples = [
            ['The Transformer uses multi-head attention in three different ways:', 'The Transformer uses 多头注意力 in three different ways:'],
            ['3.2.1 Scaled Dot-Product Attention', '3.2.1 缩放点积注意力'],
            ['Transformer transformer TRANSFORMER softmax Softmax SOFTMAX', 'Transformer transformer TRANSFORMER softmax Softmax SOFTMAX'],
            ['Use dot-product attention and encoder-decoder attention.', 'Use 点积注意力 and 编码器-解码器注意力.'],
        ];
        for (const [source, restored] of examples) {
            const entries = resolveGlossaryEntries([library], {...scope, text: source}).terms;
            const packet = protectGlossaryText(source, entries);
            expect(packet.tokens.length).toBeGreaterThan(0);
            expect(packet.text).not.toMatch(/\b(?:Transformer|transformer|TRANSFORMER|softmax|Softmax|SOFTMAX)\b/u);
            expect(packet.restore(`译文:${packet.text}`)).toBe(`译文:${restored}`);
        }
        const text = 'A transformer uses softmax.';
        for (const override of [{glossaryIds: []}, {sourceLanguage: 'fr'}, {targetLanguage: 'zh-TW'}, {targetLanguage: 'ja'}]) {
            expect(resolveGlossaryEntries([library], {...scope, text, ...override}).terms).toEqual([]);
        }
        expect(resolveGlossaryEntries([library], {...scope, text: 'TransformerX xTransformer softmaxes softmax_value'}).terms).toEqual([]);
        library.enabled = false;
        expect(resolveGlossaryEntries([library], {...scope, text}).terms).toEqual([]);
    });

    it('用户库中的显式模型译法优先于新版 AI 的原样保留，不覆盖原词库副本', () => {
        const ai = add();
        const user = {...createGlossaryLibrary([ai]), name: '用户模型译法', entries: [
            {id: 'transformer', source: 'Transformer', target: '用户架构名', caseSensitive: false},
        ]};
        const libraries = [user, ai];
        const before = structuredClone(libraries);
        const source = 'Transformer and transformer use softmax.';
        const result = resolveGlossaryEntries(libraries, {text: source, sourceLanguage: 'en', targetLanguage: 'zh-CN', glossaryIds: [user.id, ai.id]});
        expect(result.conflicts).toEqual([{source: 'Transformer', keptTarget: '用户架构名', ignoredTarget: 'Transformer', libraryId: ai.id, entryId: 'term-61'}]);
        const packet = protectGlossaryText(source, result.terms);
        expect(packet.restore(packet.text)).toBe('用户架构名 and 用户架构名 use softmax.');
        expect(libraries).toEqual(before);
    });

    it('真实 AI 副本沿 broker 开关和文档选择保护术语，旧误译缓存不能绕过开启后的词库', async () => {
        const ai = add();
        const config = normalizeConfig({service: 'microsoft', from: 'en', to: 'zh-Hans', useCache: true,
            glossaryLibraries: [ai], documentGlossaryIds: [ai.id]});
        const before = structuredClone(config.glossaryLibraries);
        const cache = new Map<string, string>();
        const provider = vi.fn(async (message: TranslationProviderRequest) => {
            const response = (origin: string) => `译文:${origin.replace(/\bTransformer\b/gu, '变压器').replace(/\bsoftmax\b/gu, '软极大')}`;
            return Array.isArray(message.origin) ? message.origin.map(response) : response(String(message.origin));
        });
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => config, providers: {microsoft: provider},
            cache: {get: async key => cache.get(key) ?? null, set: async (key, value) => {cache.set(key, value); return true;},
                clear: async () => {cache.clear();}, cleanup: async () => {}},
            serviceTypes: servicesType, resolveConfiguredModel, getMissingCredentialMessage: () => null,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? 'en', targetLanguage: request?.targetLanguage ?? 'zh-Hans'}),
            buildTranslationCacheKey: identity => JSON.stringify(identity), logger: {warn: vi.fn()},
        });
        const source = 'Transformer softmax';
        expect(config.glossaryEnabled).toBe(false);
        await expect(broker.translateWithCache({origin: source, glossaryContext: 'document'})).resolves.toBe('译文:变压器 软极大');
        config.glossaryEnabled = true;
        await expect(broker.translateWithCache({origin: source, glossaryContext: 'document'})).resolves.toBe('译文:Transformer softmax');
        expect(provider.mock.calls[1][0].origin).not.toMatch(/Transformer|softmax/u);
        await expect(broker.translateWithCache({origin: source, glossaryContext: 'document'})).resolves.toBe('译文:Transformer softmax');
        expect(provider).toHaveBeenCalledTimes(2);
        await expect(broker.translateWithCache({origin: source, glossaryContext: 'document', glossaryIds: []})).resolves.toBe('译文:变压器 软极大');
        config.glossaryEnabled = false;
        await expect(broker.translateWithCache({origin: source, glossaryContext: 'document'})).resolves.toBe('译文:变压器 软极大');
        expect(config.glossaryLibraries).toEqual(before);
    });

    it('选中的词条及来源版本通过完整配置、公开配置和词库 JSON 往返，不自动改变默认开关', () => {
        const library = add();
        library.entries[0].target = '自定义人工智能';
        const config = normalizeConfig({glossaryLibraries: [library], documentGlossaryIds: [library.id]});
        expect(config.glossaryEnabled).toBe(false);
        // 完整备份与不含凭据的旧公开配置文件都必须保留术语库。
        for (const exported of [prepareConfigForExport(config), sanitizeConfigCredentials(JSON.parse(JSON.stringify(config)))]) {
            const restored = prepareConfigForImport(JSON.parse(JSON.stringify(exported)), normalizeConfig({}));
            expect(restored.glossaryLibraries).toEqual([library]);
            expect(restored.documentGlossaryIds).toEqual([library.id]);
            expect(restored.glossaryEnabled).toBe(false);
            expect(addBuiltinGlossary('ai-en-zh-hans', restored.glossaryLibraries, '不能覆盖').status).toBe('existing');
        }
        const imported = parseGlossaryImport(exportGlossary(library, 'json'), 'json');
        expect(imported.errors).toEqual([]);
        expect(imported.libraries).toEqual([library]);
        expect(buildGlossaryRevision([library], true)).toBe(buildGlossaryRevision([{...library, preset: undefined}], true));
    });

    it.each([undefined, null, false, [], {}, {id: 3, version: 1}, {id: '', version: 1}, {id: 'bad/id', version: 1},
        {id: 'ai-en-zh-hans', version: '1'}, {id: 'ai-en-zh-hans', version: 1.5}, {id: 'ai-en-zh-hans', version: 0},
        {id: 'ai-en-zh-hans', version: -1}, {id: 'ai-en-zh-hans', version: Infinity}])('非法来源标记只移除元数据，不损坏词条 %#', preset => {
        const library = add();
        const normalized = normalizeGlossaryLibraries([{...library, preset}])[0];
        expect(normalized).not.toHaveProperty('preset');
        expect(normalized.entries).toEqual(library.entries);
    });
});
