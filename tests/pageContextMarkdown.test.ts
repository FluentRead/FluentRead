import {describe, expect, it} from 'vitest';
import {parseHTML} from 'linkedom';

import {createReadablePageMarkdown} from '@/src/services/translation/context/markdown';

function convertSanitizedArticle(content: string) {
    const {document} = parseHTML('<!doctype html><html><head></head><body></body></html>');
    // This adapter accepts the detached, sanitized extraction result; privacy is exercised by the browser adapter tests.
    return createReadablePageMarkdown(content, document as unknown as Document);
}

describe('readable Markdown from sanitized article structures', () => {
    it('preserves multiline footnote definitions and removes only their return links', () => {
        const markdown = convertSanitizedArticle('<p>Observation<sup id="fnref:detail">1</sup>.</p><div id="footnotes"><ol><li id="fn:detail"><p>First explanation.</p><p>Second explanation.</p><a class="footnote-backref">Return to text</a></li></ol></div>');
        expect(markdown).toContain('[^detail]: First explanation.\n    \n    Second explanation.');
        expect(markdown).toContain('Observation[^detail]'); expect(markdown).not.toContain('Return to text');
    });
    it('keeps unconvertible MathML inside a complex table instead of discarding its structure', () => {
        const formula = '<math><mfrac><mi>x</mi></mfrac></math>';
        const markdown = convertSanitizedArticle(`<table><tr><th colspan="2">Ratio</th></tr><tr><td>${formula}</td><td>Explanation</td></tr></table>`);
        expect(markdown).toContain(formula); expect(markdown).toContain('colspan="2"'); expect(markdown).toContain('Explanation');
    });
    it('优先使用 TeX annotation 的完整公式，保留视觉 MathML 未表达的语义', () => {
        const markdown = convertSanitizedArticle(
            '<p>The supplied expression <math data-latex="fallback"><semantics><mi>x</mi><annotation encoding="application/x-tex">\\frac{x}{2} + y^{3}</annotation></semantics></math> stays complete.</p>',
        );

        expect(markdown).toContain('$\\frac{x}{2} + y^{3}$');
        expect(markdown).not.toContain('$fallback$');
    });

    it('转换失败时仍优先保留有效的 TeX annotation', () => {
        const markdown = convertSanitizedArticle(
            '<p>The supplied incomplete fraction <math><semantics><mfrac><mi>x</mi></mfrac><annotation encoding="application/x-tex">\\frac{x}{2}</annotation></semantics></math> has an explicit formula.</p>',
        );

        expect(markdown).toContain('$\\frac{x}{2}$');
        expect(markdown).not.toContain('<mfrac>');
    });

    it('注释缺少 TeX 表达式且无法转换时保留原始 MathML', () => {
        const formula = '<math><semantics><mfrac><mi>x</mi></mfrac><annotation encoding="application/x-tex"> </annotation></semantics></math>';

        expect(convertSanitizedArticle(`<p>Unavailable formula ${formula} remains inspectable.</p>`)).toContain(formula);
    });

    it.each(['my-note', 'mynote'])('保留 %s 脚注 id 的完整引用及重复引用与定义配对', (id) => {
        const markdown = convertSanitizedArticle(
            `<p>A cited observation <sup id="fnref:${id}"><a>1</a></sup> and its repeat <sup id="fnref:${id}-2"><a>1</a></sup>.</p><div id="footnotes"><ol><li id="fn:${id}"><p>A complete explanatory footnote.</p></li></ol></div>`,
        );

        expect(markdown.split(`[^${id}]`)).toHaveLength(4);
        expect(markdown).toContain(`[^${id}]: A complete explanatory footnote.`);
        expect(markdown).not.toContain('[^my]');
        expect(markdown).not.toContain(`[^${id}-2]`);
    });

    it('真实完整脚注 id 优先于相似的数字重复引用后缀', () => {
        const markdown = convertSanitizedArticle(
            '<p>One cited observation <sup id="fnref:my-note"><a>1</a></sup> and a distinct note <sup id="fnref:my-note-2"><a>2</a></sup>.</p><div id="footnotes"><ol><li id="fn:my-note"><p>The first explanation.</p></li><li id="fn:my-note-2"><p>The second independent explanation.</p></li></ol></div>',
        );

        expect(markdown).toContain('distinct note [^my-note-2]');
        expect(markdown).toContain('[^my-note]: The first explanation.');
        expect(markdown).toContain('[^my-note-2]: The second independent explanation.');
    });

    it('只有 display block 公式的单元格保持行内公式和有效表格列', () => {
        const markdown = convertSanitizedArticle(
            '<table><tr><th>Formula</th><th>Explanation</th></tr><tr><td><p><math display="block"><mi>x</mi></math></p></td><td>A ratio remains associated with its explanation.</td></tr></table>',
        );

        expect(markdown).toContain('| $x$ | A ratio remains associated with its explanation. |');
        expect(markdown).not.toContain('$$');
    });

    it('转换不可用时使用 core 生成的 TeX 载体表达式', () => {
        const markdown = convertSanitizedArticle('<p>A formula carrier <math data-latex="x^{2}">x squared</math> retains its expression.</p>');

        expect(markdown).toContain('$x^{2}$');
        expect(markdown).toContain('retains its expression.');
    });

    it('图片仅贡献说明文字，生成的资源地址不进入复杂表格', () => {
        const markdown = convertSanitizedArticle(
            '<table><tr><td rowspan="2"><a href="https://example.com/synthetic-generated-resource" title="synthetic-resource-title">Public explanation</a><img src="https://example.com/synthetic-generated-image" alt="Diagram description"><img></td><td>First observation</td></tr><tr><td>Second observation</td></tr></table><p>Outside the table <img alt="Supporting diagram" src="https://example.com/synthetic-generated-image"><img></p>',
        );

        expect(markdown).toContain('Diagram description');
        expect(markdown).toContain('Supporting diagram');
        expect(markdown).toContain('Public explanation');
        expect(markdown).not.toContain('synthetic-generated-resource');
        expect(markdown).not.toContain('synthetic-generated-image');
        expect(markdown).not.toContain('synthetic-resource-title');
    });

    it.each([
        ['', 'note'],
        ['#?', 'note'],
        ['warning', 'warning'],
    ])('提示块缺少标题与专用内容容器时保留正文和有效类型：%j', (type, expectedType) => {
        const markdown = convertSanitizedArticle(`<div class="callout" data-callout="${type}"><p>A supporting exception remains distinct from the article.</p></div>`);

        expect(markdown).toContain(`> [!${expectedType}] ${expectedType}`);
        expect(markdown).toContain('> A supporting exception remains distinct from the article.');
    });

    it.each(['+', '-'])('折叠提示块保留状态 %s 与标题语义', (fold) => {
        const markdown = convertSanitizedArticle(`<div class="callout" data-callout="note" data-callout-fold="${fold}"><div class="callout-title">Supporting note</div><div class="callout-content"><p>A meaningful note remains readable.</p></div></div>`);

        expect(markdown).toContain(`> [!note]${fold} Supporting note`);
        expect(markdown).toContain('> A meaningful note remains readable.');
    });

    it('没有列表的脚注区域保留可读原始结构', () => {
        const markdown = convertSanitizedArticle('<div id="footnotes"><p>A supplementary note has no numbered list.</p></div>');

        expect(markdown).toContain('<div id="footnotes">');
        expect(markdown).toContain('A supplementary note has no numbered list.');
    });

    it('脚注列表为空但附有说明时保留说明与结构', () => {
        const markdown = convertSanitizedArticle('<div id="footnotes"><ol></ol><p>A residual note explanation remains available.</p></div>');

        expect(markdown).toContain('<ol></ol>');
        expect(markdown).toContain('A residual note explanation remains available.');
    });

    it('缺少可配对 id 的脚注定义不变成伪造的 Markdown 引用', () => {
        const markdown = convertSanitizedArticle('<div id="footnotes"><ol><li id="unpaired"><p>An unpaired explanatory note.</p></li></ol></div>');

        expect(markdown).toContain('<li id="unpaired">');
        expect(markdown).toContain('An unpaired explanatory note.');
        expect(markdown).not.toContain('[^');
    });

    it('直接编号列表作为脚注容器时仍生成定义', () => {
        const markdown = convertSanitizedArticle('<ol id="footnotes"><li id="fn:direct"><p>A directly listed explanatory note.</p></li></ol>');

        expect(markdown).toContain('[^direct]: A directly listed explanatory note.');
    });

    it('缺少可用行的表格保留已有文字与 HTML', () => {
        const markdown = convertSanitizedArticle('<table>A table residual contains explanatory text.</table>');

        expect(markdown).toContain('<table>A table residual contains explanatory text.</table>');
        expect(markdown).not.toContain('| --- |');
    });

    it('保留未能转换的分式原始 MathML，避免丢失或伪造分母', () => {
        const formula = '<math display="inline"><mfrac><mi>x</mi></mfrac></math>';

        const markdown = convertSanitizedArticle(`<p>The incomplete fraction ${formula} needs its original structure.</p>`);

        expect(markdown).toContain(formula);
        expect(markdown).toContain('The incomplete fraction');
        expect(markdown).toContain('needs its original structure.');
        expect(markdown).not.toContain('undefined');
    });

    it('保留无可转换子元素的公式内容', () => {
        const formula = '<math>Unconverted expression</math>';

        expect(convertSanitizedArticle(`<p>A formula remains inspectable: ${formula}.</p>`)).toContain(formula);
    });

    it('真实公式转换保留分子表达式与分母关系', () => {
        const markdown = convertSanitizedArticle(
            '<p>Scaled fraction <math><mfrac><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><mn>2</mn></mfrac></math> remains a ratio.</p>',
        );

        expect(markdown).toContain('$\\frac{x + 1}{2}$');
        expect(markdown).toContain('remains a ratio.');
    });

    it('保留带标题的复杂表格及其标题关联', () => {
        const content = '<table><caption>Related measurements</caption><tr><th>Observation</th><th>Value</th></tr><tr><td>First sample</td><td>12</td></tr></table>';

        const markdown = convertSanitizedArticle(content);

        const table = parseHTML(`<html><body>${markdown}</body></html>`).document.querySelector('table');
        expect(table?.querySelector('caption')?.textContent).toBe('Related measurements');
        expect(table?.querySelectorAll('tr')).toHaveLength(2);
        expect(table?.textContent).toContain('First sample');
    });

    it('保留首行为空的单列布局数据，不生成虚构表头', () => {
        const content = '<table><tr></tr><tr><td>Available observation</td></tr></table>';

        const markdown = convertSanitizedArticle(content);

        expect(markdown).toContain('Available observation');
        expect(markdown).not.toContain('| --- |');
    });

    it('有表头的嵌套数据表保留外层与内层的对应关系', () => {
        const markdown = convertSanitizedArticle(
            '<table><tr><th>Group</th><th>Nested measurements</th></tr><tr><td>First group</td><td><table><tr><th>Sample</th><th>Value</th></tr><tr><td>Initial sample</td><td>12</td></tr></table></td></tr></table>',
        );

        const document = parseHTML(`<html><body>${markdown}</body></html>`).document;
        expect(document.querySelectorAll('table')).toHaveLength(2);
        expect(document.querySelector('table > tr > td:nth-child(2) table')?.textContent).toContain('Initial sample');
        expect(document.querySelector('table > tr > td')?.textContent).toBe('First group');
    });

    it('普通表格保持单元格文本中的管道符与多段关系', () => {
        const markdown = convertSanitizedArticle(
            '<table><tr><th>Group</th><th>Notes</th></tr><tr><td>A | B</td><td><p>First note.</p><p>Second note.</p></td></tr></table>',
        );

        expect(markdown).toContain('| Group | Notes |');
        expect(markdown).toContain('A \\| B');
        expect(markdown).toMatch(/First note\. +Second note\./u);
    });

    it('转义正文中的 HTML 外形文本，不让可见文本伪装成结构', () => {
        const markdown = convertSanitizedArticle('<p>The literal &lt;study-note&gt; marker stays visible beside &lt;/study-note&gt;.</p>');

        expect(markdown).toMatch(/(?:\\<study-note>|<study-note\\>)/u);
        expect(markdown).toMatch(/(?:\\<\/study-note>|<\/study-note\\>)/u);
        expect(markdown).not.toContain('<study-note>');
        expect(markdown).not.toContain('</study-note>');
    });

    it.each(['', '   ', '<article></article>'])('空的已清洗正文不引入额外内容：%j', (content) => {
        expect(convertSanitizedArticle(content)).toBe('');
    });
});
