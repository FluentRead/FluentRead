/**
 * @file tests/documentMarkdownSentences.test.ts
 * 文件职责：验证文档翻译页面的 Markdown 整句方式：一行作为一个片段翻译，链接文字参与翻译而地址保留，行内代码、网址与标签原样保护，并在导出时还原。
 * 主要内容：链接写成成对占位符、图片与双链等写成单个占位符；只有受保护内容的行不产生片段；占位符的各种返回写法都能还原；丢失、重复、错位或未知的占位符退回整句并把没放回句中的代码与网址补在句末；与原文相同的译文保留原行；默认方式（未启用整句）保持按受保护内容切分。
 * 模块边界：只测试纯解析与渲染；Obsidian 等其他调用方使用默认方式，由各自的测试覆盖。
 */
import {describe, expect, it} from 'vitest';
import {documentSegmentMarkupSources, parseDocument, renderDocument} from '@/src/features/document-translation/core/document';

const parse = (markdown: string) => parseDocument('note.md', markdown, {markdownSentences: true});
const sources = (markdown: string) => parse(markdown).segments.map(segment => segment.source);
const output = (markdown: string, translations: string[], mode: 'translated' | 'bilingual' = 'translated') => renderDocument(parse(markdown), translations, mode);

describe('Markdown whole-sentence translation', () => {
    const line = 'Read the [setup guide](https://example.com/setup) before `npm install` starts, and keep **bold** words.';

    it('gives the proofreading view the original markup of placeholder segments only', () => {
        expect([...documentSegmentMarkupSources(parse(`${line}\n\nPlain sentence.`))]).toEqual([[0, line]]);
        const html = parseDocument('page.html', '<p>Read the <a href="/g">guide</a> first.</p><p>Plain.</p>');
        expect([...documentSegmentMarkupSources(html)]).toEqual([[0, 'Read the <a href="/g">guide</a> first.']]);
    });

    it('keeps one segment per line and protects link targets, code, URLs and tags with placeholders', () => {
        expect(sources(line)).toEqual(['Read the <g1>setup guide</g1> before <g2/> starts, and keep <g3>bold</g3> words.']);
        expect(sources('- See <https://example.com> or #tag for details')).toEqual(['See <g1/> or<g2/> for details']);
        // 图片、双链和文字为空的链接整体保护。
        expect(sources('An ![alt text](a.png) image, a [[Wiki Link]] and an [](empty) here')).toEqual(['An <g1/> image, a <g2/> and an <g3/> here']);
        // 只有受保护内容的行没有可翻译的文字；没有行内语法的行与默认方式相同。
        expect(sources('`code only`\n\n<https://example.com>\n\nPlain sentence.')).toEqual(['Plain sentence.']);
        // 文字本身含有占位符写法时整行按普通文字处理；链接文字含有占位符写法时该链接整体保护。
        expect(sources('literal <g1> and `code` text')).toEqual(['literal <g1> and `code` text']);
        expect(sources('see [a <g9/> b](x) now')).toEqual(['see [a <g9/> b](x) now']);
        // 默认方式的双语行：同一行里有的片段被服务原样返回时，那一段保留原文，其余照常显示译文。
        expect(renderDocument(parseDocument('note.md', 'Use `npm install` now.'), ['使用', 'now.'], 'bilingual')).toBe('Use `npm install` now.\n> 使用 `npm install` now.');
        // 默认方式不变：按受保护内容切分。
        expect(parseDocument('note.md', line).segments.map(segment => segment.source)).toEqual(['Read the', 'before', 'starts, and keep **bold** words.']);
    });

    it('restores links, code and URLs inside the translated sentence', () => {
        const zh = '在 <g2/> 开始之前请阅读<g1>安装指南</g1>，并保留<g3>粗体</g3>。';
        const restored = '在 `npm install` 开始之前请阅读[安装指南](https://example.com/setup)，并保留**粗体**。';
        expect(output(line, [zh])).toBe(restored);
        expect(output(line, [zh], 'bilingual')).toBe(`${line}\n> ${restored}`);
        expect(output(`  ${line}  \nNext line.`, [zh, '下一行。'])).toBe(`  ${restored}  \n下一行。`);
        // 服务把占位符写成实体、全角或括号形式，或把单个占位符写成一对空标签。
        for (const variant of ['在 &lt;g2/&gt; 开始之前请阅读&lt;g1&gt;安装指南&lt;/g1&gt;，并保留&lt;g3&gt;粗体&lt;/g3&gt;。', '在 （g2/） 开始之前请阅读（g1）安装指南（/g1），并保留（g3）粗体（/g3）。', '在 <g2></g2> 开始之前请阅读< G1 >安装指南</ g1 >，并保留<g3>粗体</g3>。'])
            expect(output(line, [variant]), variant).toBe(restored);
        // 译文与原文相同（服务原样返回）时保留原行，不显示占位符。
        expect(output(line, [parse(line).segments[0].source])).toBe(line);
        expect(output(line, [parse(line).segments[0].source], 'bilingual')).toBe(line);
        expect(output(line, [])).toBe(line);
    });


    it('preserves bold and italic markers while translating their words, with code and escaped markers untouched', () => {
        const line = 'Keep **bold** and __strong__ with *italic* and _emphasis_, `**code**` and snake_case.';
        expect(sources(line)).toEqual(['Keep <g1>bold</g1> and <g2>strong</g2> with <g3>italic</g3> and <g4>emphasis</g4>, <g5/> and snake_case.']);
        expect(output(line, ['保留<g1>粗体</g1>和<g2>强调</g2>、<g3>斜体</g3>、<g4>重点</g4>，<g5/>与 snake_case。']))
            .toBe('保留**粗体**和__强调__、*斜体*、_重点_，`**code**`与 snake_case。');
        expect(sources(String.raw`Literal \*stars\* and unclosed **marker`)).toEqual([String.raw`Literal \*stars\* and unclosed **marker`]);
        const document = parse('Translate this paragraph and keep **bold** text.');
        expect(documentSegmentMarkupSources(document).get(0)).toBe('Translate this paragraph and keep **bold** text.');
        expect(output('**B**', ['<g1>粗</g1>'])).toBe('**粗**');
    });

    it('preserves guide container directives once while translating their body, including quoted and nested containers', () => {
        const guide = '::: tip Refreshing keeps your progress\nYour translation is saved.\n::: details More\nOpen the guide.\n::: \n:::\n> ::: note Extra\n> Keep reading.\n> :::';
        const parsed = parse(guide);
        expect(parsed.segments.map(({source}) => source)).toEqual(['Your translation is saved.', 'Open the guide.', 'Keep reading.']);
        const result = renderDocument(parsed, ['译文已保存。', '打开指南。', '继续阅读。'], 'bilingual');
        const directives = (value: string) => value.split('\n').filter(line => /^\s*(?:>\s*)*:::/u.test(line));
        expect(directives(result)).toEqual(directives(guide));
        expect(result).toContain('> 译文已保存。');
        expect(result).toContain('> 打开指南。');
        expect(renderDocument(parsed, [], 'translated')).toBe(guide);
    });

    it('keeps standalone HTML and component tags out of translation without hiding their body text', () => {
        const guide = '<GuideVisual kind="document" en />\n<details class="guide-details" title="a > b">\nRead the guide.\n<summary>More information</summary>\n</details>\n> <br/>\n<!-- keep this comment -->';
        const parsed = parse(guide);
        expect(parsed.segments.map(({source}) => source)).toEqual(['Read the guide.', '<summary>More information</summary>']);
        const result = renderDocument(parsed, ['阅读指南。', '<summary>更多信息</summary>'], 'bilingual');
        expect(result.match(/<details /gu)).toHaveLength(1);
        expect(result.match(/<\/details>/gu)).toHaveLength(1);
        expect(result.match(/<GuideVisual /gu)).toHaveLength(1);
        expect(result).toContain('> 阅读指南。');
        expect(renderDocument(parsed, [], 'translated')).toBe(guide);
    });

    it('keeps headings, list numbers, quotes and checkboxes locally while sending only the body for translation', () => {
        const markdown = '# Heading\n  ## Subheading\n3. Item\n- [x] Done\n> - Nested item';
        expect(sources(markdown)).toEqual(['Heading', 'Subheading', 'Item', 'Done', 'Nested item']);
        const zh = ['标题', '子标题', '条目', '完成', '嵌套条目'];
        expect(output(markdown, zh)).toBe('# 标题\n  ## 子标题\n3. 条目\n- [x] 完成\n> - 嵌套条目');
        expect(output(markdown, zh, 'bilingual')).toBe('# Heading\n> # 标题\n  ## Subheading\n>   ## 子标题\n3. Item\n> 3. 条目\n- [x] Done\n> - [x] 完成\n> - Nested item\n> > - 嵌套条目');
        expect(renderDocument(parse(markdown), [], 'translated')).toBe(markdown);
    });

    it('falls back to the whole sentence and re-appends protected content the service dropped', () => {
        const expectPlain = (translation: string, expected: string) => expect(output(line, [translation]), translation).toBe(expected);
        // 两个占位符都丢了：代码补在句末，链接地址无法安放，保留译文文字。
        expectPlain('开始之前请阅读安装指南。', '开始之前请阅读安装指南。 `npm install`');
        // 链接占位符只剩一半、顺序颠倒、重复、写成自闭合，或出现未知编号。
        expectPlain('在 <g2/> 之前阅读<g1>安装指南。', '在 之前阅读安装指南。 `npm install`');
        expectPlain('在 <g2/> 之前阅读</g1>安装指南<g1>。', '在 之前阅读安装指南。 `npm install`');
        expectPlain('<g1>安装</g1><g1>指南</g1> <g2/>', '安装指南 `npm install`');
        expectPlain('<g1/>安装指南 <g2/>', '安装指南 `npm install`');
        expectPlain('<g2/> <g2/> <g1>安装指南</g1>', '安装指南 `npm install`');
        expectPlain('<g1>安装指南</g1> <g2/> <g7/>', '安装指南 `npm install`');
        // 服务把代码原样写回句中而没有用占位符：不重复补写。
        expectPlain('在 `npm install` 之前阅读安装指南。', '在 `npm install` 之前阅读安装指南。');
    });
});
