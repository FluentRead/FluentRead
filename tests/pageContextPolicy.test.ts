import {describe, expect, it} from 'vitest';
import {buildPageSummaryReference, COMPACT_PAGE_REFERENCE_LIMIT} from '@/src/core/translation/pageSummaryReference';
import {
    buildPageTranslationContext,
    getPageTranslationMaterialIdentity,
    normalizePageMarkdown,
    normalizePageText,
    pageContextLimits,
    shouldUseBoundedPageCapture,
} from '@/src/services/translation/context/policy';

describe('compact page summary references', () => {
    it('keeps exact relevant facts from a later paragraph instead of replaying the full article', () => {
        const irrelevant = 'Unrelated navigation and announcements.\n'.repeat(35);
        const fact = 'TLS session resumption reduces latency to 40 ms under the stated conditions.';
        const source = `Page title: Network protocol study\n${irrelevant}\n${fact}`;
        const result = buildPageSummaryReference('Page summary: A study of network performance.', source, ['How does TLS resumption affect latency?']);
        expect(result).toContain(fact);
        expect(result).toContain('Page title: Network protocol study');
        expect(result).not.toContain('Unrelated navigation');
        expect(result.length).toBeLessThan(source.length / 2);
    });

    it('matches Chinese terminology and omits unrelated or already supplied text', () => {
        const result = buildPageSummaryReference('摘要：讲解翻译系统。', '普通导航。\n术语库保留用户确认的译法。\n当前要翻译的句子。', ['如何使用术语库？', '当前要翻译的句子。']);
        expect(result).toContain('术语库保留用户确认的译法。');
        expect(result).not.toContain('普通导航');
        expect(result).not.toContain('当前要翻译的句子。');
        expect(buildPageSummaryReference('Short summary.', 'Unrelated paragraph.', ['TLS latency'])).toBe('Short summary.');
    });

    it('bounds long summary and source references while retaining a relevant excerpt', () => {
        const result = buildPageSummaryReference('摘要。'.repeat(500), `Page title: ${'标题'.repeat(150)}\nTLS latency is limited to 40 ms.\n${'unrelated '.repeat(400)}`, ['TLS latency']);
        expect(result.length).toBeLessThanOrEqual(COMPACT_PAGE_REFERENCE_LIMIT);
        expect(result).toContain('TLS latency is limited to 40 ms.');
        const emoji = buildPageSummaryReference('😀'.repeat(1000), '', []);
        expect(emoji).not.toMatch(/[\ud800-\udbff]$/u);
    });

    it('handles empty queries and clips deep matches without splitting emoji or repeating source lines', () => {
        expect(buildPageSummaryReference('Summary.', 'Unread context.', ['!?'])).toBe('Summary.');
        const line = `${'x'.repeat(500)} TLS latency is 40 ms ${'z'.repeat(400)}`;
        const result = buildPageSummaryReference('Summary.', `${line}\n${line}`, ['TLS latency']);
        expect(result).toContain('…');
        expect(result).toContain('TLS latency is 40 ms');
        expect(result.split('TLS latency is 40 ms')).toHaveLength(2);
        const emojiBoundary = `😀${'x'.repeat(99)}TLS ${'z'.repeat(400)}`;
        const unicode = buildPageSummaryReference('Summary.', emojiBoundary, ['TLS']);
        expect(unicode).toContain('😀');
        expect(unicode).toContain('TLS');
        expect(unicode).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    });
});

describe('page translation context policy', () => {
    it.each([
        ['https://example.com/article', 'https://example.com/article'],
        ['https://example.com/article#contents', 'https://example.com/article'],
        ['https://example.com/article#', 'https://example.com/article'],
        ['https://example.com/article#%2Fcontents', 'https://example.com/article'],
        ['https://example.com/article#/chapter/2', 'https://example.com/article#/chapter/2'],
        ['https://example.com/article#!/chapter/2', 'https://example.com/article#!/chapter/2'],
        ['https://example.com/article?language=en#contents', 'https://example.com/article?language=en'],
        ['https://example.com/next?language=en', 'https://example.com/next?language=en'],
        ['not a URL#contents', 'not a URL'],
        ['/relative/path#contents', '/relative/path'],
        ['', ''],
        ['#contents', ''],
    ])('uses the expected material identity for %j', (href, identity) => {
        expect(getPageTranslationMaterialIdentity(href)).toBe(identity);
    });

    it('keeps route, query and path changes distinct from ordinary reading anchors', () => {
        const article = getPageTranslationMaterialIdentity('https://example.com/article');
        expect(getPageTranslationMaterialIdentity('https://example.com/article#contents')).toBe(article);
        for (const next of [
            'https://example.com/article#/next',
            'https://example.com/article#!/next',
            'https://example.com/article?next=true',
            'https://example.com/next',
        ]) expect(getPageTranslationMaterialIdentity(next)).not.toBe(article);
    });

    it('normalizes plain text and Markdown without erasing paragraph boundaries', () => {
        expect(normalizePageText('  A\n\tB\u3000 C  ')).toBe('A B C');
        expect(normalizePageMarkdown('  A\r\n\tB\r\n\r\n\r\n C  ')).toBe('A\n\tB\n\n C');
    });

    it('保留嵌套列表与续行缩进，避免改变正文的父子关系', () => {
        const markdown = '- Parent\r\n\t- Child\r\n\t\t1. Grandchild\r\n    continued   text\r\n\r\n> Quote';
        const normalized = normalizePageMarkdown(markdown);
        expect(normalized).toBe('- Parent\n\t- Child\n\t\t1. Grandchild\n    continued text\n\n> Quote');
        expect(buildPageTranslationContext({readableText: normalized})).toContain('\n\t\t1. Grandchild');
    });

    it('保留行尾两个空格的 Markdown 硬换行，同时折叠普通行内间隔', () => {
        expect(normalizePageMarkdown('First   line  \r\nSecond\t  line\r\n\r\nThird line'))
            .toBe('First line  \nSecond line\n\nThird line');
    });

    it('处理预算内长行尾空白时保留硬换行，不反复回溯', () => {
        const trailing = ' '.repeat(pageContextLimits.defuddleText);
        expect(normalizePageMarkdown(`First line${trailing}\nSecond line`))
            .toBe('First line  \nSecond line');
        expect(normalizePageMarkdown(`First${trailing}line`)).toBe('First line');
    });

    it('switches to bounded capture when any detached-DOM budget is exceeded', () => {
        const withinBudget = {
            elements: pageContextLimits.defuddleElements,
            textCharacters: pageContextLimits.defuddleText,
            markupCharacters: pageContextLimits.defuddleMarkup,
            visitedNodes: pageContextLimits.captureNodes,
        };
        expect(shouldUseBoundedPageCapture(withinBudget)).toBe(false);

        for (const key of Object.keys(withinBudget) as Array<keyof typeof withinBudget>) {
            expect(shouldUseBoundedPageCapture({
                ...withinBudget,
                [key]: withinBudget[key] + 1,
            })).toBe(true);
        }
    });

    it('builds a bounded reference block and normalizes untrusted metadata', () => {
        const context = buildPageTranslationContext({
            title: '  Article\n title ',
            description: ' Short\u3000description ',
            readableText: 'x'.repeat(pageContextLimits.content + 100),
        });

        expect(context).toContain('Page title: Article title');
        expect(context).toContain('Page description: Short description');
        expect(context).toContain(`Readable page content (Markdown):\n${'x'.repeat(pageContextLimits.content)}`);
        expect(context).not.toContain('x'.repeat(pageContextLimits.content + 1));
        expect(context.length).toBeLessThanOrEqual(pageContextLimits.total);
    });

    it('omits absent sections and enforces the final request budget', () => {
        expect(buildPageTranslationContext({})).toBe('');
        expect(buildPageTranslationContext({title: '', description: '', readableText: ''})).toBe('');

        const oversizedMetadata = buildPageTranslationContext({
            title: 't'.repeat(pageContextLimits.total),
            description: 'description',
            readableText: 'content',
        });
        expect(oversizedMetadata).toHaveLength(pageContextLimits.total);
        expect(oversizedMetadata.startsWith('Page title: ')).toBe(true);
    });
});
