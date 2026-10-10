/**
 * @file tests/targetLanguageReleaseCorpus.test.ts
 * 独立发行说明语料的回归检查：覆盖 52 个目录目标的自然语言段落和短标题，对每段检查所有
 * 目标与排除语言，防止把真实外语误跳过；保持技术标记、空白、Unicode 变体和相近语言混合
 * 的结论稳定。明确中文发布说明必须在请求前跳过；其余留出语料只测量覆盖率，不要求短歧义
 * 文本有唯一归属。语料不 mock franc-min，不使用页面 lang 或已选择目标作为识别提示。
 */
import {describe, expect, it} from 'vitest';
import corpus from './fixtures/target-language-release-corpus.json';
import {translationLanguageOptions} from '@/src/core/language/catalog';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {identifyTextLanguage} from '@/src/core/language/identify';

interface ReleaseCorpusCase {
    id: string;
    text: string;
    languages: string[];
    tags: string[];
    requireSkip?: boolean;
    empty?: boolean;
}

const targets = translationLanguageOptions.map(option => option.value);
const cases = corpus.cases as ReleaseCorpusCase[];
const nativeBodies = cases.filter(item => item.tags.includes('native-body'));
const envelopeVariants = nativeBodies.flatMap(item => [
    {
        ...item,
        id: `${item.id}-identifiers`,
        text: ['v0.0.37 · 4f92c0a', item.text, '`src/core/reader.ts` https://example.invalid/download'].join('\n'),
        tags: [...item.tags, 'identifier-envelope'],
    },
    {
        ...item,
        id: `${item.id}-unicode-whitespace`,
        text: item.text.normalize('NFD').replace(/ /gu, '\u00a0\u2009'),
        tags: [...item.tags, 'unicode-whitespace'],
    },
]);
const allCases = [...cases, ...envelopeVariants];

function measureCoverage(items: readonly ReleaseCorpusCase[]) {
    const missed = items.filter(item => !item.languages.some(target => shouldSkipTranslationForTarget(item.text, target)));
    return {total: items.length, skipped: items.length - missed.length, recall: 1 - missed.length / items.length,
        missed: missed.map(item => item.id)};
}

describe('目标语言发行说明语料', () => {
    it('独立语料覆盖全部目录目标，短标题和自然段落各有一例，id 与语言标注有效', () => {
        expect(targets).toHaveLength(52);
        expect(new Set(allCases.map(item => item.id)).size).toBe(allCases.length);
        for (const target of targets) {
            expect(cases.some(item => item.languages.includes(target) && item.tags.includes('native-body')), target).toBe(true);
            expect(cases.some(item => item.languages.includes(target) && item.tags.includes('native-title')), target).toBe(true);
        }
        for (const item of allCases) {
            for (const language of item.languages) expect(targets).toContain(language);
            if (item.empty) expect(/\p{L}/u.test(item.text), item.id).toBe(false);
        }
    });

    it.each(allCases.map(item => [item.id, item] as const))('%s：只跳过允许目标，目标与排除语言结论一致', (_id, item) => {
        const identification = identifyTextLanguage(item.text);
        if (item.empty) expect(identification.status).toBe('empty');
        const wrongTargets: string[] = [];
        for (const target of targets) {
            const skipped = shouldSkipTranslationForTarget(item.text, target);
            if (!item.empty && !item.languages.includes(target) && skipped) wrongTargets.push(target);
            expect(shouldSkipTranslationForTarget(item.text, 'und', [target]), `${item.id} excluded ${target}`).toBe(skipped);
            if (item.requireSkip && item.languages.includes(target)) {
                expect(skipped, `${item.id} → ${target}: ${JSON.stringify(identification)}`).toBe(true);
            }
        }
        expect(wrongTargets, `${item.id}: ${JSON.stringify(identification)}`).toEqual([]);
    });

    it('留出自然段落与技术标记变体的同目标跳过率分别至少 85%', () => {
        const native = measureCoverage(nativeBodies);
        const envelope = measureCoverage(envelopeVariants.filter(item => item.tags.includes('identifier-envelope')));
        expect(native.recall, JSON.stringify(native)).toBeGreaterThanOrEqual(0.85);
        expect(envelope.recall, JSON.stringify(envelope)).toBeGreaterThanOrEqual(0.85);
    });

    it('结构化标记与 Unicode 空白变体不改变已可信识别的目标', () => {
        const differences: string[] = [];
        for (const item of nativeBodies) {
            for (const variant of envelopeVariants.filter(candidate => candidate.id.startsWith(`${item.id}-`))) {
                for (const target of item.languages) {
                    if (shouldSkipTranslationForTarget(item.text, target)
                        && !shouldSkipTranslationForTarget(variant.text, target)) differences.push(variant.id);
                }
            }
        }
        expect(differences).toEqual([]);
    });

    it.each(['cs', 'sk', 'nb'])('补齐共用封闭语法词后，%s 的完整母语操作段落不得退回未知或混合', target => {
        const item = nativeBodies.find(item => item.languages.includes(target))!;
        expect(shouldSkipTranslationForTarget(item.text, target), JSON.stringify(identifyTextLanguage(item.text))).toBe(true);
    });
});

describe('语言混合与书写体系边界', () => {
    const relatedPairs = [
        ['en', 'fr'], ['en', 'de'], ['fr', 'es'], ['es', 'pt'], ['it', 'fr'],
        ['id', 'ms'], ['cs', 'sk'], ['da', 'sv'], ['nb', 'da'], ['hr', 'sl'],
        ['sr', 'ru'], ['ru', 'uk'], ['uk', 'bg'], ['ar', 'fa'], ['fa', 'ur'],
        ['hi', 'mr'], ['mr', 'ne'], ['zh-Hans', 'ja'], ['zh-Hant', 'ko'], ['ja', 'ko'],
    ];

    it.each(relatedPairs)('%s 与 %s 两个完整自然段落组合，不能按任一目标漏译另一段', (left, right) => {
        const source = [left, right].map(language => nativeBodies.find(item => item.languages.includes(language))!.text);
        for (const text of [`${source[0]}\n${source[1]}`, `${source[1]}\n${source[0]}`]) {
            expect(shouldSkipTranslationForTarget(text, left), `${left}+${right}`).toBe(false);
            expect(shouldSkipTranslationForTarget(text, right), `${right}+${left}`).toBe(false);
        }
    });

    it('中文简繁转换仍交给供应商，不能用“都是中文”吞掉有字形变化的请求', () => {
        const simplified = cases.find(item => item.id === 'hans-conversion')!.text;
        const traditional = cases.find(item => item.id === 'hant-conversion')!.text;
        expect(shouldSkipTranslationForTarget(simplified, 'zh-Hant')).toBe(false);
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hans')).toBe(false);
        expect(shouldSkipTranslationForTarget(simplified, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(traditional, 'zh-Hant')).toBe(true);
    });

    it('近似的英语否定句与肯定句，中文目标必须保留翻译', () => {
        for (const id of ['english-negative-not', 'english-positive']) {
            const text = cases.find(item => item.id === id)!.text;
            expect(shouldSkipTranslationForTarget(text, 'zh-Hans')).toBe(false);
            expect(shouldSkipTranslationForTarget(text, 'en')).toBe(true);
        }
    });
});
