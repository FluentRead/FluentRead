/**
 * @file tests/documentLiteralProtection.test.ts
 * 文件职责：验证真实文档中 URL、邮箱、代码式专名及 GNMT+RL 的自动原样保护边界。
 * 主要内容：检验重复、数组、标点、普通词与空输入，沿用严格术语占位符恢复及缺项拒绝，不把模型术语猜成中文译名。
 * 模块边界：纯规则及保护链测试，实际免费服务结果由隔离浏览器测试另行验证。
 */
import {describe, expect, it} from 'vitest';
import {findDocumentLiteralTerms} from '@/src/core/translation/public';
import {validateGlossaryProtectedTokens} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {prepareGlossaryRequest, getGlossaryProtectionEntries} from '@/src/services/translation/glossaryProtection';
import {createTranslationProviderConfigSnapshot, getTranslationGlossaryTerms} from '@/src/services/translation/requestSnapshot';

const documentConfig = () => ({...createTranslationProviderConfigSnapshot(new Config()),
    glossaryMatchContext: {context: 'document' as const, sourceLanguage: 'en', targetLanguage: 'zh-hans'}});

describe('document literal protection', () => {
    it('keeps URLs, emails, code-style product names and compound model names with exact spelling', () => {
        const terms = findDocumentLiteralTerms('Use FluentRead with GNMT+RL and https://github.com/tensorflow/tensor2tensor. Email ai+docs@example.org!');
        expect(terms.map(term => term.source)).toEqual(['FluentRead', 'GNMT+RL', 'https://github.com/tensorflow/tensor2tensor', 'ai+docs@example.org']);
        expect(terms.every(term => term.target === term.source && term.caseSensitive)).toBe(true);
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
});
