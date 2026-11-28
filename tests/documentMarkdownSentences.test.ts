/**
 * @file tests/documentMarkdownSentences.test.ts
 * 文件职责：验证文档翻译页面的 Markdown 整句方式：一行作为一个片段翻译，链接文字参与翻译而地址保留，行内代码、网址与标签原样保护，并在导出时还原。
 * 主要内容：通过项目已有 VitePress 内的标准 markdown-it 验证服务边缘空白移到强调分隔符之外后实际产生 strong/em 节点，已确认的指南括号+CJK、underscore 词内与 Unicode 符号边界只补必要空格，保留内部空白、空正文、链接/代码、嵌套和 invalid fallback；链接写成成对占位符、图片与双链等写成单个占位符；只有受保护内容的行不产生片段；占位符的各种返回写法都能还原；丢失、重复、错位或未知的占位符退回整句并把没放回句中的代码与网址补在句末；与原文相同的译文保留原行；默认方式（未启用整句）保持按受保护内容切分。
 * 模块边界：只测试纯解析与渲染；Obsidian 等其他调用方使用默认方式，由各自的测试覆盖。
 */
import {beforeAll, describe, expect, it} from 'vitest';
import {createMarkdownRenderer} from 'vitepress';
import {documentSegmentMarkupSources, parseDocument, renderDocument} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';

let standardMarkdown: Awaited<ReturnType<typeof createMarkdownRenderer>>;
beforeAll(async () => {standardMarkdown = await createMarkdownRenderer(process.cwd(), {highlight: value => value});});

const parse = (markdown: string) => parseDocument('note.md', markdown, {markdownSentences: true});
const sources = (markdown: string) => parse(markdown).segments.map(segment => segment.source);
const output = (markdown: string, translations: string[], mode: 'translated' | 'bilingual' = 'translated') => renderDocument(parse(markdown), translations, mode);

describe('Markdown soft-wrapped paragraphs', () => {
    it.each([
        ['变量\n说明', '变量 说明'],
        ['变量 \r\n 说明', '变量   说明'],
        ['变量\r说明', '变量 说明'],
    ])('preserves CommonMark whitespace inside a wrapped code span %j', (wrapped, normalized) => {
        const source = 'This contains `' + wrapped + '` in a code span.';
        const document = parse(source);
        const translated = renderDocument(document, ['译文保留 <g1/>。'], 'translated');
        const code = /<code>([^<]*)<\/code>/u;
        const originalCode = standardMarkdown.render(source).match(code)?.[1];
        expect(originalCode).toBe(normalized);
        expect(standardMarkdown.render(translated).match(code)?.[1]).toBe(originalCode);
    });

    it.each(['\n', '\r\n', '\r'])('sends each prose paragraph once and preserves original %j line endings', ending => {
        const first = ['The source is read one line at a time.', 'Its paragraph continues on the next line.'];
        const second = ['Keep the original code in', '`calculate_bounds()` while translating the prose.'];
        const source = [...first, '', ...second].join(ending);
        const document = parse(source);
        expect(document.segments.map(segment => segment.source)).toEqual([
            first.join(' '), 'Keep the original code in <g1/> while translating the prose.',
        ]);
        const translations = ['这一段一起翻译。', '翻译正文时保留 <g1/>。'];
        expect(renderDocument(document, [])).toBe(source);
        expect(renderDocument(document, translations, 'translated')).toBe('这一段一起翻译。' + ending.repeat(2) + '翻译正文时保留 `calculate_bounds()`。');
        expect(renderDocument(document, translations)).toBe(first.join(ending) + '\n> 这一段一起翻译。' + ending.repeat(2)
            + second.join(ending) + '\n> 翻译正文时保留 `calculate_bounds()`。');
    });

    it.each([['https://example.com/帮助', ' '], ['#翻译', '']])(
        'keeps the CJK prose after %s outside the protected token', (token, separator) => {
            const source = '请参阅 ' + token + '\r\n然后继续阅读。';
            const document = parse(source);
            expect(document.segments.map(segment => segment.source)).toEqual(['请参阅' + separator + '<g1/> 然后继续阅读。']);
            expect(renderDocument(document, ['See' + separator + '<g1/> then continue reading.'], 'translated'))
                .toBe('See ' + token + ' then continue reading.');
            expect(createDocumentPreviewHtml(document, [], 'source')).toContain(token + ' 然后继续阅读。');
        });

    it('preserves Markdown hard breaks and structural lines', () => {
        const source = 'A heading\ncontinued\n===\n\nFirst line  \nSecond line\\\nThird line\n\n'
            + '- One item\n- Another item\n\n> Quoted text\n> Next quote line\n\n'
            + '| Column |\n| --- |\n| Cell |\n\n' + '~~~text\nnot prose\nnor this\n~~~';
        expect(sources(source)).toEqual([
            'A heading', 'continued', '===', 'First line', 'Second line\\', 'Third line',
            'One item', 'Another item', 'Quoted text', 'Next quote line', 'Column', 'Cell',
        ]);
        expect(output(source, [])).toBe(source);
        expect(sources('Another heading\ncontinued\n--')).toEqual(['Another heading', 'continued', '--']);
        const longLines = ['abc '.repeat(700).trim(), 'def '.repeat(700).trim(), 'Last line.'];
        expect(sources(longLines.join('\n'))).toEqual(longLines);
        const internalSpaces = ['Words' + ' '.repeat(1800) + 'within a line.', 'The paragraph continues.'];
        expect(sources(internalSpaces.join('\n'))).toEqual([internalSpaces.join(' ')]);
    });

    it('keeps each preview translation with its own paragraph when another paragraph is pending', () => {
        const document = parse('First line\ncontinues.\n\nPending line\nstill waiting.\n\n~~~\nkeep this block\n~~~\n\nLast line\ncontinues.');
        const preview = createDocumentPreviewHtml(document, ['第一段。\n补充。', '', '最后一段。'], 'bilingual');
        expect(preview).toContain('>First line continues.</p><p class="reader-translation fluentread-translation">第一段。<br>补充。</p>');
        expect(preview).toContain('>Pending line still waiting.</p></section>');
        expect(preview).toContain('<pre data-reader-unit><code>keep this block</code></pre>');
        expect(preview).toContain('>Last line continues.</p><p class="reader-translation fluentread-translation">最后一段。</p>');
    });

    it('keeps GFM table translations and following prose aligned after a translated soft-wrapped paragraph', () => {
        const source = 'First line\r\ncontinues.\r\n\r\n| Title | Note |\r\n| :--- | ---: |\r\n| Read | Pending |\r\n\r\nLast line\r\ncontinues.';
        const document = parse(source);
        const translations = ['第一段。', '标题', '备注', '阅读', '', '最后一段。'];
        const preview = createDocumentPreviewHtml(document, translations, 'bilingual');
        expect(preview).toContain('>First line continues.</p><p class="reader-translation fluentread-translation">第一段。</p>');
        expect(preview).toContain('<th style="text-align:left">Title<span class="reader-translation fluentread-translation">标题</span></th>');
        expect(preview).toContain('<td style="text-align:right">Pending</td>');
        expect(preview).toContain('>Last line continues.</p><p class="reader-translation fluentread-translation">最后一段。</p>');
        const exported = renderDocument(document, translations, 'bilingual');
        expect(exported).toContain('First line\r\ncontinues.\n> 第一段。');
        expect(exported).toContain('| Read<br>阅读 | Pending |');
    });

    it('keeps legacy previews usable and leaves table delimiters in a different block quote alone', () => {
        const source = 'Left | Right\n> --- | ---';
        const document = parse(source);
        expect(document.markdownTables).toEqual([]);
        expect(renderDocument(document, [])).toBe(source);
        const legacy = {...parse('## Heading\n\nA paragraph.'), markdownTables: undefined};
        const preview = createDocumentPreviewHtml(legacy, ['标题', '一段文字。'], 'bilingual');
        expect(preview).toContain('>Heading</h2><h2 class="reader-translation fluentread-translation">标题</h2>');
        expect(preview).toContain('>A paragraph.</p><p class="reader-translation fluentread-translation">一段文字。</p>');
    });
});

describe('Markdown whole-sentence translation', () => {
    const line = 'Read the [setup guide](https://example.com/setup) before `npm install` starts, and keep **bold** words.';

    it('translates GFM table cells while preserving alignment, links and row boundaries', () => {
        const source = [
            '| Feature | Guide | Count |',
            '| :--- | ---: | :---: |',
            '| Retry \\| Continue | [Read more](https://example.com/guide) | 42 |',
            '| Logging | `a\\|b` | |',
            '',
            'After the table.',
        ].join('\r\n');
        const doc = parse(source);
        expect(doc.segments.map(segment => segment.source)).toEqual([
            'Feature', 'Guide', 'Count', 'Retry \\| Continue', '<g1>Read more</g1>', 'Logging', 'After the table.',
        ]);
        const translations = ['功能', '指南', '次数', '重试 | 继续\n下一行', '<g1>阅读更多</g1>', '日志', '表格之后。'];
        for (const mode of ['bilingual', 'translated'] as const) {
            const markdown = renderDocument(doc, translations, mode);
            const html = standardMarkdown.render(markdown);
            expect(html.match(/<table\b[^>]*>/gu)).toHaveLength(1);
            expect(html.match(/<th(?:\s[^>]*)?>/gu)).toHaveLength(3);
            expect(html.match(/<td(?:\s[^>]*)?>/gu)).toHaveLength(6);
            expect(html).toMatch(/重试\s*\|\s*继续<br\s*\/?\s*>下一行/u);
            expect(html).toMatch(/<a href="https:\/\/example\.com\/guide"[^>]*>阅读更多<\/a>/u);
            expect(html).toContain('<code>a|b</code>');
            expect(markdown.split('\r\n')[1]).toBe('| :--- | ---: | :---: |');
            expect(markdown).toContain(mode === 'bilingual' ? 'Feature<br>功能' : '| 功能 | 指南 | 次数 |');
        }
        expect(renderDocument(doc, [], 'bilingual')).toBe(source);
        const preview = createDocumentPreviewHtml(doc, translations, 'bilingual');
        expect(preview).toContain('<table class="markdown-preview-table"');
        expect(preview).toContain('<th style="text-align:left">Feature<span class="reader-translation fluentread-translation">功能</span></th>');
        expect(preview).toContain('重试 | 继续<br>下一行');
    });

    it('keeps short rows, nested tables and following blocks in their original containers', () => {
        const source = ['> Item | Value', '> --- | ---', '> Without second cell', '> Quantity | 42 | hidden column',
            '> # Next heading', '', '- | Item | Value |', '  | --- | --- |', '  | Read more | [Read](guide.md) |',
            '- Next item', '', '```md', '| Example | Row |', '| --- | --- |', '```'].join('\n');
        const doc = parse(source);
        const inputs = doc.segments.map(segment => segment.source);
        expect(inputs).toEqual(['Item', 'Value', 'Without second cell', 'Quantity', 'Next heading',
            'Item', 'Value', 'Read more', '<g1>Read</g1>', 'Next item']);
        const translations = inputs.map((input, index) => index === 0 ? '# 标题'
            : index === 2 ? '缺列' : index === 3 ? '数量\\' : input);
        const markdown = renderDocument(doc, translations, 'translated');
        expect(markdown).toContain('> | # 标题 | Value\n> --- | ---');
        expect(markdown).toContain('> | 缺列\n> | 数量\\\\ | 42 | hidden column');
        const rendered = standardMarkdown.render(markdown);
        expect(rendered.match(/<table\b/gu)).toHaveLength(2);
        expect(rendered).toContain('<th># 标题</th>');
        expect(rendered).toContain('缺列</td>');
        expect(rendered).toContain('Next heading');
        expect(rendered).toContain('>Next item</li>');
        for (const mode of ['source', 'translated'] as const) {
            const preview = createDocumentPreviewHtml(doc, translations, mode);
            expect(preview.match(/<table\b/gu)).toHaveLength(2);
            expect(preview).toContain('<td colspan="1"></td>');
            expect(preview).toContain(mode === 'source' ? '<th>Item</th>' : '<th># 标题</th>');
        }
    });

    it('preserves GFM escape parity and ignores a mismatched or non-delimiter row', () => {
        const samples = ['A \\| escaped\n| --- | --- |', '| A | B |\n| --- |', '| A | B |\n| --- | prose |'];
        for (const source of samples) expect(parse(source).markdownTables).toEqual([]);
        const source = '| A | B |\n| --- | --- |\n| x | y |';
        const markdown = renderDocument(parse(source), ['一', '二', '甲\\|乙\\\\|丙', '丁'], 'translated');
        expect(markdown).toContain('| 甲\\|乙\\\\\\|丙 | 丁 |');
        expect(standardMarkdown.render(markdown).match(/<td>/gu)).toHaveLength(2);
    });

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
            .toBe('保留**粗体**和 __强调__、*斜体*、_重点_，`**code**`与 snake_case。');
        expect(sources(String.raw`Literal \*stars\* and unclosed **marker`)).toEqual([String.raw`Literal \*stars\* and unclosed **marker`]);
        const document = parse('Translate this paragraph and keep **bold** text.');
        expect(documentSegmentMarkupSources(document).get(0)).toBe('Translate this paragraph and keep **bold** text.');
        expect(output('**B**', ['<g1>粗</g1>'])).toBe('**粗**');
    });

    it.each(['**', '__', '*', '_'])('adds only necessary CommonMark flanking gaps for %s, including the real guide ZIP label', marker => {
        const tag = marker.length === 2 ? 'strong' : 'em';
        const line = `Click ${marker}Download completed files (ZIP)${marker} to continue.`;
        const translated = output(line, ['点击<g1>下载已完成文件（ZIP）</g1>即可继续。']);
        const before = marker.startsWith('_') ? ' ' : '';
        expect(translated).toBe(`点击${before}${marker}下载已完成文件（ZIP）${marker} 即可继续。`);
        expect(standardMarkdown.renderInline(translated)).toContain(`<${tag}>下载已完成文件（ZIP）</${tag}>`);
        for (const symbol of ['（', '$', '😀', '\u{10100}']) {
            const withSymbols = output(line, [`甲<g1>${symbol}内容${symbol}</g1>乙`]);
            expect(withSymbols).toBe(`甲 ${marker}${symbol}内容${symbol}${marker} 乙`);
            expect(standardMarkdown.renderInline(withSymbols)).toContain(`<${tag}>${symbol}内容${symbol}</${tag}>`);
        }
        // 已有外侧空白/标点、文件首尾边界无需再补；丢标记时退回的正文也不带新增间隔。
        expect(output(line, ['甲 <g1>（内容）</g1> 乙'])).toBe(`甲 ${marker}（内容）${marker} 乙`);
        expect(output(line, ['（<g1>（内容）</g1>）'])).toBe(`（${marker}（内容）${marker}）`);
        expect(output(line, ['<g1>（内容）</g1>'])).toBe(`${marker}（内容）${marker}`);
        expect(output(line, ['甲<g1>（内容）</g1>乙<g99/>'])).toBe('甲（内容）乙');
    });

    it.each(['**', '__', '*', '_'])('moves provider edge whitespace outside %s so standard Markdown parses the translated style', marker => {
        const line = `Read ${marker}bold words${marker} now.`;
        const translated = output(line, ['阅读 <g1> \t正文  内部\u00a0 </g1>。']);
        expect(translated).toBe(`阅读  \t${marker}正文  内部${marker}\u00a0 。`);
        const tag = marker.length === 2 ? 'strong' : 'em';
        expect(standardMarkdown.renderInline(`${marker} 粗体 ${marker}`)).not.toContain(`<${tag}>`);
        expect(standardMarkdown.renderInline(translated)).toContain(`<${tag}>正文  内部</${tag}>`);
        expect(output(line, ['阅读 <g1>正文  内部</g1>。'])).toBe(`阅读 ${marker}正文  内部${marker}。`);
        for (const blank of ['', ' \t\u00a0']) expect(output(line, [`阅读 <g1>${blank}</g1>。`])).toBe(`阅读 ${marker}${blank}${marker}。`);
        expect(output(line, ['阅读 <g1>\n\f\r正文\n\f\r</g1>。'])).toBe(`阅读 \n\f\r${marker}正文${marker}\n\f\r。`);
    });

    it('preserves non-emphasis whitespace, source nesting and invalid fallback while moving emphasis boundaries conservatively', () => {
        // 实际解析器只生成外层 g，内层使用另一种原生强调语法；不允许服务把原先平级的 g 改成嵌套。
        const line = 'Read **outer _inner_**, [link](https://example.com), and `**code**`.';
        const document = parse(line);
        expect(document.segments[0].source).toBe('Read <g1>outer _inner_</g1>, <g2>link</g2>, and <g3/>.');
        const nested = '阅读<g1> 外层 _内层_ </g1>、<g2> 链接 </g2>与<g3/>。';
        const translated = renderDocument(document, [nested], 'translated');
        expect(translated).toBe('阅读 **外层 _内层_** 、[ 链接 ](https://example.com)与`**code**`。');
        expect(standardMarkdown.renderInline(translated)).toContain('<strong>外层 <em>内层</em></strong>');
        expect(output('Use **bold** and `code` now.', ['甲<g1> 乙 </g1>丙<g99/> <g2/>']))
            .toBe('甲 乙 丙 `code`');
        expect(output('Use **bold** now.', ['甲<g1> 乙'])).toBe('甲 乙');
        expect(output('Use **bold** now.', ['甲<g1/>乙'])).toBe('甲乙');
        expect(output('Use **bold** now.', ['甲<g1> 外层<g99> 内层 </g99> </g1>。'])).toBe('甲 外层 内层 。');
        expect(output('Use **bold** now.', ['甲<g1> 乙 </g1><g1> 丙 </g1>。'])).toBe('甲 乙 丙 。');
        expect(output('Read [link](https://example.com).', ['阅读<g1> 链接 </g1>。']))
            .toBe('阅读[ 链接 ](https://example.com)。');
        expect(output('Read <strong>bold</strong>.', ['阅读<strong> 粗体 </strong>。']))
            .toBe('阅读<strong> 粗体 </strong>。');
        const punctuation = output('Read **bold**.', ['阅读（<g1> 粗体 </g1>）。']);
        expect(punctuation).toBe('阅读（ **粗体** ）。');
        expect(standardMarkdown.renderInline(punctuation)).toContain('<strong>粗体</strong>');
        // VT 不属于 CommonMark 空白：保留控制字符，而不是用 JavaScript \s 全部去掉。
        expect(output('Read **bold**.', ['阅读<g1>\v粗体\v</g1>。'])).toBe('阅读**\v粗体\v**。');
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
