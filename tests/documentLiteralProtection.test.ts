/**
 * @file tests/documentLiteralProtection.test.ts
 * 文件职责：验证真实文档中行内语法、根号标识、URL、邮箱、代码式专名及 GNMT+RL 的自动原样保护边界。
 * 主要内容：检验带引号的 HTML/g 标签、嵌套与自闭合、重复、数组、标点、用户短词及空输入，沿用严格术语占位符恢复及缺项拒绝，不把模型术语猜成中文译名。
 * 模块边界：纯规则及保护链测试，实际免费服务结果由隔离浏览器测试另行验证。
 */
import {describe, expect, it, vi} from 'vitest';
import {findDocumentLiteralTerms} from '@/src/core/translation/public';
import {validateGlossaryProtectedTokens} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {prepareGlossaryRequest, getGlossaryProtectionEntries} from '@/src/services/translation/glossaryProtection';
import {createTranslationProviderConfigSnapshot, getTranslationGlossaryTerms, getTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {parseDocument, renderDocument} from '@/src/features/document-translation/core/document';

vi.mock('@/src/services/config/store', () => ({config: {to: 'zh-Hans'}}));

const documentConfig = () => ({...createTranslationProviderConfigSnapshot(new Config()),
    glossaryMatchContext: {context: 'document' as const, sourceLanguage: 'en', targetLanguage: 'zh-hans'}});

describe('document literal protection', () => {
    it('keeps paired, nested and self-closing syntax exactly while leaving the words between tags translatable', () => {
        const tag = `<details title="1 > 0" data-kind='a > b'>`;
        const source = `${tag}Expand <g1>nested <g2>bold</g2></g1><g3/> now.</details>`;
        const syntax = [tag, '<g1>', '<g2>', '</g2>', '</g1>', '<g3/>', '</details>'];
        expect(findDocumentLiteralTerms(source).map(term => term.source)).toEqual(syntax);
        expect(findDocumentLiteralTerms('a < b > c; unclosed <summary title="not closed; <!-- comment -->')).toEqual([]);
        const current = documentConfig();
        const packet = prepareGlossaryRequest({origin: source}, current);
        expect(packet.message.origin).not.toMatch(/<\/?(?:g\d|details)/u);
        expect(packet.message.origin).toContain('nested');
        expect(packet.restore(String(packet.message.origin).replace('Expand', '展开').replace('nested', '嵌套').replace('bold', '粗体')))
            .toBe(`${tag}展开 <g1>嵌套 <g2>粗体</g2></g1><g3/> now.</details>`);
        expect(getTranslationGlossaryTerms(current, source)).toEqual(syntax.map(source => ({source, target: source})));
        const page = {...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page' as const}};
        expect(getGlossaryProtectionEntries(page, source)).toEqual([]);
        expect(prepareGlossaryRequest({origin: source}, page).message.origin).toBe(source);
    });

    it('does not let short glossary words change tag syntax, but still applies those words in prose', () => {
        const current = {...documentConfig(), glossaryEnabled: true, glossaryTerms: [{source: 'g1', target: '用户编号'}, {source: 'summary', target: '摘要'}],
            glossaryLibraries: [{id: 'user', name: 'User', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'g', source: 'g1', target: '用户编号', caseSensitive: false}, {id: 'summary', source: 'summary', target: '摘要', caseSensitive: false}]}]};
        const source = '<summary><g1>g1 summary</g1></summary>';
        const entries = getGlossaryProtectionEntries(current, source);
        expect(entries.filter(entry => entry.source.startsWith('<')).map(entry => entry.source))
            .toEqual(['<summary>', '<g1>', '</g1>', '</summary>']);
        const packet = prepareGlossaryRequest({origin: source}, current);
        expect(packet.restore(packet.message.origin)).toBe('<summary><g1>用户编号 摘要</g1></summary>');
        expect(getTranslationGlossaryTerms(current, source)).toEqual(entries.map(({source, target}) => ({source, target})));
    });

    it('preserves only the confirmed radical identifier and lets explicit user spelling take priority', () => {
        expect(findDocumentLiteralTerms('Multiply by √dmodel, √dk and √hidden_2; √2 + 3 stays mathematical prose.').map(term => term.source))
            .toEqual(['√dmodel', '√dk', '√hidden_2']);
        const source = 'Multiply by √dmodel.';
        const packet = prepareGlossaryRequest({origin: source}, documentConfig());
        expect(packet.message.origin).not.toContain('dmodel');
        expect(packet.restore(String(packet.message.origin).replace('Multiply by', '乘以'))).toBe('乘以 √dmodel.');
        expect(findDocumentLiteralTerms(source, [{source: 'dmodel', target: '用户符号', caseSensitive: true}])).toEqual([]);
    });

    it('restores Markdown emphasis/code/links and nested HTML after the same protected translation chain', () => {
        const markdown = parseDocument('sample.md', 'Read **bold**, use `npm install`, and [link](https://example.com).', {markdownSentences: true});
        const html = parseDocument('sample.html', '<p>Read <strong><em>bold</em></strong> now.</p>');
        for (const [document, replacements, expected] of [
            [markdown, [['Read', '阅读'], ['bold', '粗体'], ['use', '运行'], ['and', '并看'], ['link', '链接']], '阅读 **粗体**, 运行 `npm install`, 并看 [链接](https://example.com).'],
            [html, [['Read', '阅读'], ['bold', '粗体'], ['now.', '。']], '<p>阅读 <strong><em>粗体</em></strong> 。</p>'],
        ] as const) {
            const packet = prepareGlossaryRequest({origin: document.segments[0].source}, documentConfig());
            expect(String(packet.message.origin)).not.toMatch(/<\/?g\d/u);
            let translated = String(packet.message.origin);
            for (const [source, target] of replacements) translated = translated.replace(source, target);
            expect(renderDocument(document, [packet.restore(translated) as string], 'translated')).toBe(expected);
        }
    });

    it('gives every occurrence its own token and rejects lost, repeated and foreign paragraph syntax', () => {
        const origins = ['<g1>bold</g1> then <g1>again</g1>', '<summary>More</summary><g2/>'];
        const packet = prepareGlossaryRequest({origin: origins}, documentConfig());
        const protectedOrigins = packet.message.origin as string[];
        const tokens = getTranslationProviderConfig(packet.message, documentConfig()).glossaryProtectedTokens!;
        expect(tokens).toHaveLength(7);
        expect(packet.restore(protectedOrigins)).toEqual(origins);
        for (const first of [protectedOrigins[0].replace(tokens[0], ''), protectedOrigins[0] + tokens[0], protectedOrigins[0] + tokens[4]]) {
            expect(() => validateGlossaryProtectedTokens(protectedOrigins[0], first, tokens)).toThrow('未完整保留术语');
            expect(() => packet.restore([first, protectedOrigins[1]])).toThrow('未完整保留术语');
        }
    });

    it('keeps URLs, emails, code-style product names and compound model names with exact spelling', () => {
        const terms = findDocumentLiteralTerms('Use FluentRead with GNMT+RL and https://github.com/tensorflow/tensor2tensor. Email ai+docs@example.org!');
        expect(terms.map(term => term.source)).toEqual(['FluentRead', 'GNMT+RL', 'https://github.com/tensorflow/tensor2tensor', 'ai+docs@example.org']);
        expect(terms.every(term => term.target === term.source && term.caseSensitive)).toBe(true);
        expect(findDocumentLiteralTerms('访问 https://example.com。请继续翻译后面的说明。参阅（https://example.org）后继续。'))
            .toEqual(['https://example.com', 'https://example.org'].map(source => ({source, target: source, caseSensitive: true})));
        expect(findDocumentLiteralTerms('https://example.com、下一项需要翻译'))
            .toEqual([{source: 'https://example.com', target: 'https://example.com', caseSensitive: true}]);
    });
    it('deduplicates repeated literals across paragraphs and leaves normal prose and incomplete identifiers alone', () => {
        expect(findDocumentLiteralTerms(['FluentRead and DeepSeek', 'FluentRead again', 'ABSTRACT Transformer line structure snake_case', 'GNMT+ and no@address']))
            .toEqual(['FluentRead', 'DeepSeek'].map(source => ({source, target: source, caseSensitive: true})));
        expect(findDocumentLiteralTerms([])).toEqual([]);
        expect(findDocumentLiteralTerms('')).toEqual([]);
    });
    it('rejects missing, duplicate, unknown and foreign paragraph tokens before a free route wins', () => {
        const token = '__FRTERM_123456789abc_0__', other = '__FRTERM_123456789abc_1__';
        expect(() => validateGlossaryProtectedTokens('plain', null)).not.toThrow();
        expect(() => validateGlossaryProtectedTokens('plain', null, [])).not.toThrow();
        expect(() => validateGlossaryProtectedTokens(token, `译文${token}`, [token, other])).not.toThrow();
        for (const result of [null, '丢失', `${token}${token}`, `${token}${other}`, `${token}__FRTERM_unknown_0__`])
            expect(() => validateGlossaryProtectedTokens(token, result, [token, other])).toThrow('未完整保留术语');
        expect(() => validateGlossaryProtectedTokens(`${token} __FRTERM_literal_0__`, `${token} __FRTERM_literal_0__`, [token])).not.toThrow();
    });
    it('protects only document requests and gives provider and cache the same identity terms without global glossary changes', () => {
        const current = documentConfig();
        const origin = 'Use FluentRead and GNMT+RL at https://github.com/tensorflow/tensor2tensor.';
        const entries = getGlossaryProtectionEntries(current, origin);
        expect(entries).toEqual(findDocumentLiteralTerms(origin));
        expect(getTranslationGlossaryTerms(current, origin)).toEqual(entries.map(({source, target}) => ({source, target})));
        const packet = prepareGlossaryRequest({origin}, current);
        expect(packet.message.origin).not.toContain('tensorflow');
        expect(packet.restore(packet.message.origin)).toBe(origin);
        expect(() => packet.restore('模型名称已经丢失')).toThrow('未完整保留术语');
        expect(getGlossaryProtectionEntries({...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page'}}, origin)).toEqual([]);
        expect(getTranslationGlossaryTerms({...current, glossaryMatchContext: {...current.glossaryMatchContext, context: 'page'}}, origin)).toEqual([]);
    });

    it('lets explicit short user terms win over automatic long names with the same boundaries, case and NFC rules', () => {
        const term = {source: 'GNMT', target: '用户译法', caseSensitive: true};
        expect(findDocumentLiteralTerms('GNMT+RL GNMT+RL FluentRead', [term]))
            .toEqual([{source: 'FluentRead', target: 'FluentRead', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('GNMT+RL', [{...term, source: 'gnmt', caseSensitive: false}])).toEqual([]);
        for (const source of ['gnmt', 'NMT', 'unrelated'])
            expect(findDocumentLiteralTerms('GNMT+RL', [{...term, source}]))
                .toEqual([{source: 'GNMT+RL', target: 'GNMT+RL', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('GNMT+RL model GNMT+RL', [{...term, source: 'model'}]))
            .toEqual([{source: 'GNMT+RL', target: 'GNMT+RL', caseSensitive: true}]);
        expect(findDocumentLiteralTerms('https://example.com/Cafe\u0301', [{source: 'Café', target: '用户拼写', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('https://example.com/Café', [{source: 'Cafe\u0301', target: '用户拼写', caseSensitive: true}])).toEqual([]);
        expect(findDocumentLiteralTerms('https://example.com/Cafe\u0301', [{source: 'different', target: '', caseSensitive: true}]))
            .toEqual([{source: 'https://example.com/Cafe\u0301', target: 'https://example.com/Cafe\u0301', caseSensitive: true}]);
    });

    it('restores GNMT user spelling through broker, provider tokens and cache without changing page requests', async () => {
        const config = Object.assign(new Config(), {service: 'microsoft', from: 'en', to: 'zh-Hans', useCache: true, glossaryEnabled: true,
            glossaryLibraries: [{id: 'user', name: 'User terms', enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
                entries: [{id: 'gnmt', source: 'GNMT', target: '用户译法', caseSensitive: true}]}]});
        const before = JSON.stringify(config.glossaryLibraries);
        const cache = new Map<string, string>(), identities: Record<string, unknown>[] = [];
        const provider = vi.fn(async (message: Record<string, unknown>) => {
            const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
            expect(snapshot.glossaryProtectedTokens).toHaveLength(2);
            expect(message.origin).not.toContain('GNMT'); expect(message.origin).not.toContain('FluentRead');
            expect(message.origin).toContain('+RL');
            return `译文:${message.origin}`;
        });
        const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config, providers: {microsoft: provider},
            cache: {get: async key => cache.get(key) ?? null, set: async (key, value) => {cache.set(key, value); return true;}, clear: async () => {cache.clear();}, cleanup: async () => {}},
            serviceTypes: servicesType, resolveConfiguredModel, getMissingCredentialMessage: () => null,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? 'en', targetLanguage: request?.targetLanguage ?? 'zh-Hans'}),
            buildTranslationCacheKey: identity => {identities.push(identity); return JSON.stringify(identity);}, logger: {warn: vi.fn()},
        });
        const origin = 'Use GNMT+RL with FluentRead.';
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('译文:Use 用户译法+RL with FluentRead.');
        expect(identities[0]).toMatchObject({glossaryTerms: [{source: 'GNMT', target: '用户译法'}, {source: 'FluentRead', target: 'FluentRead'}],
            glossaryProtection: {entries: [{source: 'GNMT', target: '用户译法', caseSensitive: true}, {source: 'FluentRead', target: 'FluentRead', caseSensitive: true}]}});
        await expect(broker.translateWithCache({origin, glossaryContext: 'document'})).resolves.toBe('译文:Use 用户译法+RL with FluentRead.');
        expect(provider).toHaveBeenCalledOnce();
        expect(JSON.stringify(config.glossaryLibraries)).toBe(before);

        const current = {...documentConfig(), glossaryTerms: [{source: 'GNMT', target: 'GNMT'}],
            glossaryLibraries: [{...config.glossaryLibraries[0], entries: [{id: 'gnmt', source: 'GNMT', target: '', caseSensitive: true}]}]};
        const entries = getGlossaryProtectionEntries(current, origin);
        expect(entries.map(entry => entry.source)).toEqual(['GNMT', 'FluentRead']);
        expect(getTranslationGlossaryTerms(current, origin)).toEqual(entries.map(({source, target}) => ({source, target: target || source})));
        const packet = prepareGlossaryRequest({origin}, current);
        expect(packet.restore(packet.message.origin)).toBe(origin);
    });
});
