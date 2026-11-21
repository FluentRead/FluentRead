import {describe, expect, it} from 'vitest';

import {
    createDocumentDownloadName,
    documentSegmentsInColumns,
    documentTranslationsInColumns,
    getDocumentFormat,
    getDocumentMimeType,
    normalizeDelimitedColumns,
    parseDocument,
    renderDocument,
} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {readDelimitedCells} from '@/src/features/document-translation/core/delimited';

describe('document translation parser', () => {
    it('识别首批支持的文件格式并生成下载文件名', () => {
        expect(getDocumentFormat('guide.HTML')).toBe('html');
        expect(getDocumentFormat('paper.PDF')).toBe('pdf');
        expect(getDocumentFormat('book.epub')).toBe('epub');
        expect(getDocumentFormat('brief.docx')).toBe('docx');
        expect(getDocumentFormat('notes.markdown')).toBe('markdown');
        expect(getDocumentFormat('episode.ass')).toBe('ass');
        expect(getDocumentFormat('lyrics.lrc')).toBe('lrc');
        expect(getDocumentFormat('data.yaml')).toBeNull();
        expect(createDocumentDownloadName('episode.srt', 'bilingual')).toBe('episode.bilingual.srt');
        expect(createDocumentDownloadName('episode.srt', 'translated')).toBe('episode.translated.srt');
        expect(getDocumentMimeType('html')).toBe('text/html;charset=utf-8');
        expect(getDocumentMimeType('json')).toBe('application/json;charset=utf-8');
        expect(getDocumentFormat('catalog.CSV')).toBe('csv');
        expect(getDocumentFormat('catalog.tsv')).toBe('tsv');
        expect(getDocumentMimeType('csv')).toBe('text/csv;charset=utf-8');
        expect(getDocumentMimeType('tsv')).toBe('text/tab-separated-values;charset=utf-8');
        expect(getDocumentMimeType('markdown')).toBe('text/plain;charset=utf-8');
        expect(() => parseDocument('paper.pdf', '%PDF-')).toThrow('需要按二进制文件解析');
    });

    it('preserves CSV field positions, quotes, embedded line breaks, protected values, and original row endings', () => {
        const input = '\ufeffID,Description,Price,Link,Formula\r\n0123,"  Read, ""save""\r\nthen go  ",-2.50,https://example.com,=SUM(A2)\r\n999,Update,42,,\rTrailing text,https://example.com/support,\n';
        const document = parseDocument('inventory.csv', input);
        expect(document.segments.map(segment => [segment.pathLabel, segment.source])).toEqual([
            ['R1C1', 'ID'], ['R1C2', 'Description'], ['R1C3', 'Price'], ['R1C4', 'Link'], ['R1C5', 'Formula'],
            ['R2C2', 'Read, "save"\r\nthen go'], ['R3C2', 'Update'], ['R4C1', 'Trailing text'],
        ]);
        expect(document.delimitedColumns).toEqual(['ID', 'Description', 'Price', 'Link', 'Formula'].map((label, index) => ({index, label})));
        const translations = ['', '介绍', '', '', '', '阅读，"保存"\n再继续', '更新,可用', ''];
        expect(renderDocument(document, [], 'bilingual')).toBe(input);
        expect(renderDocument(document, translations, 'translated')).toBe(input.replace('Description', '介绍')
            .replace('  Read, ""save""\r\nthen go  ', '  阅读，""保存""\n再继续  ').replace('999,Update,', '999,"更新,可用",'));
        const bilingual = renderDocument(document, translations, 'bilingual');
        expect([...readDelimitedCells(bilingual, ',')].find(cell => cell.row === 1 && cell.column === 1)?.value)
            .toBe('  Read, "save"\r\nthen go\n阅读，"保存"\n再继续  ');
        expect(bilingual).toContain('999,"Update\n更新,可用",42,,\rTrailing text,');
        expect(renderDocument(document, translations, 'bilingual', 6)).toBe(bilingual.slice(0, 6));
    });

    it('selects TSV columns with stable coordinates and preserves stale translations outside the selected columns', () => {
        const input = '\tMemo\tExample\nKeep me\tA note\t"quoted\tvalue"\r\n\t\tEnd\tExtra';
        const document = parseDocument('inventory.tsv', input);
        const columns = normalizeDelimitedColumns(document, [2, 0, 2, -1, '0']);
        expect(columns).toEqual([0, 2]);
        expect(document.delimitedColumns).toEqual([{index: 0, label: ''}, {index: 1, label: 'Memo'}, {index: 2, label: 'Example'}, {index: 3, label: ''}]);
        expect(documentSegmentsInColumns(document, columns).map(segment => segment.pathLabel)).toEqual(['R1C3', 'R2C1', 'R2C3', 'R3C3']);
        const saved = ['便笺', '示例', '保留', '说明', '有\t引号', '末尾', '额外'];
        const chosen = documentTranslationsInColumns(document, saved, columns);
        expect(chosen).toEqual(['', '示例', '保留', '', '有\t引号', '末尾', '']);
        expect(renderDocument(document, chosen, 'translated')).toBe('\tMemo\t示例\n保留\tA note\t"有\t引号"\r\n\t\t末尾\tExtra');
        expect(documentTranslationsInColumns(document, ['只有表头'], columns)).toEqual(new Array(document.segments.length).fill(''));
        expect(documentSegmentsInColumns(document)).toBe(document.segments);
        expect(documentTranslationsInColumns(document, saved)).toBe(saved);
        expect(normalizeDelimitedColumns(document, [3, 2, 1, 0])).toBeUndefined();
        expect(normalizeDelimitedColumns(document, ['0'])).toBeUndefined();
        expect(normalizeDelimitedColumns(document, null)).toBeUndefined();
        const txt = parseDocument('plain.txt', 'Hello world');
        expect(normalizeDelimitedColumns(txt, [0])).toBeUndefined();
        expect(documentSegmentsInColumns(txt, [0])).toBe(txt.segments);
        expect(documentTranslationsInColumns(txt, saved, [0])).toBe(saved);
    });

    it('retains spreadsheet literals and rejects ambiguous quoting or formula-like results', () => {
        const input = 'Keep,TRUE,false,null,NaN,1.2e-5,2026-11-21T16:00:00Z,123e4567-e89b-12d3-a456-426614174000,docs@example.com,+SUM(A1),＠SUM(A1),""\n';
        const document = parseDocument('data.csv', input);
        expect(document.segments.map(segment => segment.source)).toEqual(['Keep']);
        expect(renderDocument(document, ['\t =1+2'], 'translated')).toBe(input);
        expect(renderDocument(document, ['@INVALID'], 'bilingual')).toBe(input);
        expect(renderDocument(document, ['Keep'], 'translated')).toBe(input);
        expect(renderDocument(parseDocument('data.tsv', 'Use "quotes"\t"short"'), ['使用引号', '译文'], 'translated')).toBe('使用引号\t"译文"');
        expect(parseDocument('empty.csv', '\ufeff').segments).toEqual([]);
        expect(() => parseDocument('open.csv', 'a,"unterminated')).toThrow('R1C2');
        expect(() => parseDocument('tail.csv', 'a,"closed"bad')).toThrow('R1C2');
    });

    it('保留 HTML 标签、属性和脚本内容，只替换可见文本', () => {
        const source = '<article><h1>Hello world</h1><a href="https://example.com">Read guide</a><script>const title = "Keep me";</script></article>';
        const document = parseDocument('guide.html', source);
        expect(document.segments.map((segment) => segment.source)).toEqual(['Hello world', 'Read guide']);

        const output = renderDocument(document, ['你好世界', '阅读指南'], 'translated');
        expect(output).toContain('<h1>你好世界</h1>');
        expect(output).toContain('href="https://example.com"');
        expect(output).toContain('>阅读指南</a>');
        expect(output).toContain('const title = "Keep me";');
    });

    it('HTML 仅译文导出会转义翻译服务返回的标签，避免注入文档结构', () => {
        const document = parseDocument('guide.html', '<p>Hello</p>');
        expect(renderDocument(document, ['<script>alert(1)</script>'], 'translated')).toBe(
            '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
        );
    });

    it('保留 TXT 换行，并支持 Markdown 代码块和链接保护', () => {
        const txt = parseDocument('notes.txt', 'First line\n\nSecond line\n');
        expect(txt.segments.map((segment) => segment.source)).toEqual(['First line', 'Second line']);
        expect(renderDocument(txt, ['第一行', '第二行'], 'translated')).toBe('第一行\n\n第二行\n');

        const markdown = parseDocument('guide.md', '# Install\n\nUse `npm install` now.\n\n```js\nconst value = 1;\n```\n\n[Guide](https://example.com)');
        expect(markdown.segments.map((segment) => segment.source)).toEqual(['# Install', 'Use', 'now.']);
        const output = renderDocument(markdown, ['# 安装', '使用', '现在。'], 'translated');
        expect(output).toContain('`npm install`');
        expect(output).toContain('const value = 1;');
        expect(output).toContain('[Guide](https://example.com)');
    });

    it('Markdown 空文件、frontmatter 和代码围栏内的数学标记保持原始结构', () => {
        expect(parseDocument('empty.md', '').segments).toEqual([]);
        const markdown = '---\ntitle: Private metadata\n---\n```text\n$$\n```\nVisible prose\n';
        const parsed = parseDocument('notes.md', markdown);
        expect(parsed.segments.map(segment => segment.source)).toEqual(['Visible prose']);
        expect(renderDocument(parsed, ['可见正文'], 'translated')).toBe(markdown.replace('Visible prose', '可见正文'));
        const math = parseDocument('math.md', '$$\nx^2 + y^2\n$$\nRegular text');
        expect(math.segments.map(segment => segment.source)).toEqual(['Regular text']);
    });

    it('Markdown 双语导出按原始行组合内联代码前后的译文', () => {
        const document = parseDocument('guide.md', 'Use `npm install` now.\n');

        expect(renderDocument(document, ['使用', '现在。'], 'bilingual')).toBe(
            'Use `npm install` now.\n> 使用 `npm install` 现在。\n',
        );
    });

    it('保留 SRT 时间轴、字幕标签和双语行', () => {
        const source = '1\n00:00:01,000 --> 00:00:03,000\n<i>Hello</i> world\n\n2\n00:00:04,000 --> 00:00:05,000\nNext line';
        const document = parseDocument('episode.srt', source);
        expect(document.segments.map((segment) => segment.source)).toEqual(['<i>Hello</i> world', 'Next line']);
        expect(document.segments[0]).toMatchObject({timeStart: '00:00:01,000', timeEnd: '00:00:03,000'});
        const output = renderDocument(document, ['<i>你好</i> 世界', '下一行'], 'bilingual');
        expect(output).toContain('00:00:01,000 --> 00:00:03,000');
        expect(output).toContain('<i>Hello</i> world\n<i>你好</i> 世界');
        expect(output).toContain('2\n00:00:04,000 --> 00:00:05,000');
    });

    it('无空行分隔的 SRT 不会把下一条序号吞进上一段译文', () => {
        const source = [
            '1',
            '00:00:01,000 --> 00:00:03,000',
            'First cue',
            '2',
            '00:00:04,000 --> 00:00:05,000',
            'Second cue',
        ].join('\n');
        const document = parseDocument('episode.srt', source);

        expect(document.segments.map((segment) => segment.source)).toEqual(['First cue', 'Second cue']);
        expect(renderDocument(document, ['第一条', '第二条'], 'translated')).toBe([
            '1',
            '00:00:01,000 --> 00:00:03,000',
            '第一条',
            '2',
            '00:00:04,000 --> 00:00:05,000',
            '第二条',
        ].join('\n'));
    });

    it('保留 VTT 头部和 ASS 对话字段', () => {
        const vtt = parseDocument('episode.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
        expect(vtt.segments.map((segment) => segment.source)).toEqual(['Hello']);
        expect(renderDocument(vtt, ['你好'], 'translated')).toContain('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n');

        // 翻译服务把样式标签转成实体返回时还原成标签并去掉标签内侧的空格；原文没有的标签、正文里的“&lt;”不动。
        const cue = (text: string) => parseDocument('talk.vtt', `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${text}\n`);
        const restored = (text: string, translation: string) => renderDocument(cue(text), [translation], 'translated').split('\n').at(-2);
        expect(restored('Today we build a <i>small</i> weather station.', '今天我们搭一个 &lt;i&gt; 小 &lt;/i&gt; 气象站。')).toBe('今天我们搭一个 <i>小</i> 气象站。');
        expect(restored('<v Host>Welcome <b>back</b>.</v>', '&lt;v Host&gt;欢迎&lt;B&gt;回来&lt;/B&gt;。&lt;/v&gt;')).toBe('<v Host>欢迎<B>回来</B>。</v>');
        expect(restored('Keep it under <i>five</i> degrees.', '温度要 &lt; 5 度，&lt;u&gt;务必&lt;/u&gt; &lt;i&gt;五&lt;/i&gt;。')).toBe('温度要 &lt; 5 度，&lt;u&gt;务必&lt;/u&gt; <i>五</i>。');
        // 括号写法只有在同名标签的闭合形式也出现时才还原；列表里的 (i)、(a) 不动。
        expect(restored('Today we build a <i>small</i> weather station.', '今天我们搭一个 (i)small(/i) 气象站。')).toBe('今天我们搭一个 <i>small</i> 气象站。');
        expect(restored('Today we build a <i>small</i> weather station.', '今天我们搭一个（i）小（／i）气象站。')).toBe('今天我们搭一个<i>小</i>气象站。');
        expect(restored('Choose <i>one</i>: tea or coffee.', '选<i>一个</i>：(i) 茶 (a) 咖啡')).toBe('选<i>一个</i>：(i) 茶 (a) 咖啡');
        expect(restored('Read <c.highlight>this</c> now.', '现在读(c.highlight)这段(/c)。')).toBe('现在读<c.highlight>这段</c>。');
        expect(restored('Read <c.highlight>this</c> now.', '现在读(c.highlight)这段(/cXhighlight)。')).toBe('现在读(c.highlight)这段(/cXhighlight)。');
        // 翻译服务丢掉硬换行时，按原文的行数把译文重新断开；服务保留了换行、原文没有换行或找不到断点时不动。
        const line = (text: string) => parseDocument('breaks.ass', `[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${text}`);
        const rebroken = (text: string, translation: string) => renderDocument(line(text), [translation], 'translated').split(',,').at(-1);
        expect(rebroken('Today we build a small\\Nweather station.', '今天我们搭一个小型气象站。')).toBe('今天我们搭一个\\N小型气象站。');
        expect(rebroken('Is the power off,\\Nor should I check again?', '电源关了吗，还是要我再检查一下？')).toBe('电源关了吗，\\N还是要我再检查一下？');
        expect(rebroken('First line\\Nsecond line\\Nthird line', 'Erste Zeile zweite Zeile dritte Zeile')).toBe('Erste Zeile\\Nzweite Zeile\\Ndritte Zeile');
        expect(rebroken('{\\i1}Today{\\i0} we build\\Na station.', '{\\i1}今天{\\i0}我们搭{\\b1}一个{\\b0}站。')).toBe('{\\i1}今天{\\i0}我们\\N搭{\\b1}一个{\\b0}站。');
        expect(rebroken('{\\an8}Check\\Nagain', '再查')).toBe('{\\an8}再\\N查');
        expect(rebroken('Keep\\Nthis', '保留\\N这个')).toBe('保留\\N这个');
        expect(rebroken('One\\Ntwo\\Nthree', 'Unbreakable')).toBe('Unbreakable');
        expect(rebroken('Broken\\Nstyle', '样{\\i1式 }}{坏')).toBe('样{\\i1式 }}{坏');
        expect(rebroken('No break here', '这里没有换行')).toBe('这里没有换行');
        // 环境没有分词能力时，中日韩文字退回在最接近均分的位置断开。
        const segmenter = Intl.Segmenter;
        try {
            (Intl as {Segmenter?: unknown}).Segmenter = undefined;
            expect(rebroken('Today we build a small\\Nweather station.', '今天我们搭一个小型气象站。')).toBe('今天我们搭一\\N个小型气象站。');
        } finally {(Intl as {Segmenter?: unknown}).Segmenter = segmenter;}
        const ass = parseDocument('episode.ass', '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello');
        expect(ass.segments.map((segment) => segment.source)).toEqual(['{\\i1}Hello']);
        expect(ass.segments[0]).toMatchObject({timeStart: '0:00:01.00', timeEnd: '0:00:02.00'});
        const output = renderDocument(ass, ['你好'], 'bilingual');
        expect(output).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello\\N{\\i1}你好');
    });

    it.each(['srt', 'vtt'] as const)('keeps generated paragraphs and arrows inside their %s cue', format => {
        const ending = '\r\n';
        const ms = format === 'srt' ? ',' : '.';
        const firstTiming = `00:00:01${ms}000 --> 00:00:02${ms}500`;
        const secondTiming = `00:00:03${ms}000 --> 00:00:04${ms}000`;
        const source = [format === 'vtt' ? 'WEBVTT\r\n\r\nfirst' : '1', firstTiming + (format === 'vtt' ? ' align:start' : ''),
            'First line', '', format === 'vtt' ? 'second' : '2', secondTiming, 'Next line', ''].join(ending);
        const doc = parseDocument(`clip.${format}`, source);
        for (const mode of ['bilingual', 'translated'] as const) {
            const result = renderDocument(doc, [`译文第一行\n \n第二行\r\n${firstTiming}\n末尾`, '下一条'], mode);
            const reparsed = parseDocument(`clip.${format}`, result);
            expect(reparsed.segments.map(({timeStart, timeEnd}) => [timeStart, timeEnd])).toEqual(doc.segments.map(({timeStart, timeEnd}) => [timeStart, timeEnd]));
            expect(reparsed.segments[0].source).toContain('第二行');
            expect(reparsed.segments[0].source).toContain('末尾');
            expect(reparsed.segments[1].source).toContain('下一条');
            expect(result.split(firstTiming)).toHaveLength(2);
            expect(result).toContain(firstTiming + (format === 'vtt' ? ' align:start' : '') + ending);
        }
    });

    it('writes provider line breaks as ASS/SSA drawing-safe line markers in both exports', () => {
        const doc = parseDocument('clip.ssa', '[Events]\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Original\n');
        for (const mode of ['bilingual', 'translated'] as const) {
            const result = renderDocument(doc, ['第一行\r第二行\n第三行'], mode);
            expect(result.match(/^Dialogue:.*$/gmu)).toHaveLength(1);
            expect(result).toContain(mode === 'bilingual' ? 'Original\\N第一行\\N第二行\\N第三行' : ',,第一行\\N第二行\\N第三行');
        }
    });

    it('保留 LRC 时间标签，并将 JSON 字符串值重组为合法 JSON', () => {
        const lrc = parseDocument('song.lrc', '[00:01.00]Hello\n[00:02.00]World');
        expect(lrc.segments.map((segment) => segment.source)).toEqual(['Hello', 'World']);
        expect(lrc.segments[0].timeStart).toBe('00:01.00');
        expect(renderDocument(lrc, ['你好', '世界'], 'bilingual')).toContain('[00:01.00]Hello\n[00:01.00]你好');

        const json = parseDocument('data.json', '{"title":"Hello","items":[{"label":"World"}],"keep":42}');
        expect(json.segments.map((segment) => segment.source)).toEqual(['Hello', 'World']);
        expect(json.segments.map((segment) => segment.pathLabel)).toEqual(['$.title', '$.items[0].label']);
        const output = JSON.parse(renderDocument(json, ['你好', '世界'], 'translated')) as {title: string; items: Array<{label: string}>; keep: number};
        expect(output).toEqual({title: '你好', items: [{label: '世界'}], keep: 42});
        // 给程序看的值不产生片段，导出时原样保留；单个普通单词、带占位符的句子照常翻译。
        const machine = {version: '2.4.1', date: '2026-10-10', home: 'https://example.com/trail', mail: 'mailto:hi@example.com', site: 'WWW.example.com', colour: '#ff8800', short: '#FFF', id: 'a8f3-22b1', key: 'btn_primary_2', path: 'v2/api:8080+x',
            word: 'Light', sentence: 'Welcome back, {name}!', count: '%d kilometres remaining', tag: '#general', mixed: 'Route 66'};
        const settings = parseDocument('en.json', JSON.stringify(machine));
        expect(settings.segments.map(segment => segment.source)).toEqual(['Light', 'Welcome back, {name}!', '%d kilometres remaining', '#general', 'Route 66']);
        expect(JSON.parse(renderDocument(settings, ['浅色', '欢迎回来，{name}！', '还剩 %d 公里', '#综合', '66 号公路'], 'translated'))).toEqual({...machine, word: '浅色', sentence: '欢迎回来，{name}！', count: '还剩 %d 公里', tag: '#综合', mixed: '66 号公路'});
        expect(() => parseDocument('broken.json', '{')).toThrow('JSON 文件格式无效');
    });

    it('按 Markdown、HTML 与 TXT 的原生阅读结构生成隔离预览', () => {
        const markdown = parseDocument('guide.md', '# Install\n\nUse `npm install` now.');
        const markdownPreview = createDocumentPreviewHtml(markdown, ['# 安装', '使用', '现在。'], 'bilingual');
        expect(markdownPreview).toContain('class="reader-unit heading"');
        expect(markdownPreview).toContain('<h1 class="reader-source">Install</h1>');
        expect(markdownPreview).toContain('<h1 class="reader-translation fluentread-translation">安装</h1>');
        expect(markdownPreview).toContain('<code>npm install</code>');

        const html = parseDocument('page.html', '<article><h1>Hello</h1><script>alert(1)</script><p>World</p></article>');
        const htmlPreview = createDocumentPreviewHtml(html, ['你好', '世界'], 'bilingual');
        expect(htmlPreview).toContain('Content-Security-Policy');
        expect(htmlPreview).toContain('data-fluent-read-document-translation="true"');
        expect(htmlPreview).not.toContain('alert(1)');

        const text = parseDocument('notes.txt', 'First paragraph\n\nSecond paragraph');
        const textPreview = createDocumentPreviewHtml(text, ['第一段', '第二段'], 'translated');
        expect(textPreview).toContain('第一段');
        expect(textPreview).not.toContain('First paragraph');
    });

    it('Markdown 译文包含换行时仍与原始行一一对应', () => {
        const document = parseDocument('guide.md', '# One\n\nTwo');
        const preview = createDocumentPreviewHtml(document, ['# 一\n额外行', '二'], 'translated');

        expect(preview).toContain('<h1 class="reader-translation fluentread-translation">一<br>额外行</h1>');
        expect(preview).toContain('<p class="reader-translation fluentread-translation">二</p>');
        expect(preview).not.toContain('>Two<');
    });

    it('TXT 译文内的空行保留在当前段落而不会挤占下一段', () => {
        const document = parseDocument('notes.txt', 'First\n\nSecond');
        const preview = createDocumentPreviewHtml(document, ['第一\n\n补充', '第二'], 'translated');

        expect(preview).toContain('<p class="reader-translation fluentread-translation">第一<br><br>补充</p>');
        expect(preview).toContain('<p class="reader-translation fluentread-translation">第二</p>');
        expect(preview).not.toContain('>First<');
        expect(preview).not.toContain('>Second<');
    });

    it('TXT reading preview does not generate unused whole-file export strings', () => {
        const document = parseDocument('notes.txt', 'First\n\nSecond');
        Object.defineProperty(document, 'parts', {get: () => {throw new Error('unused full export');}});
        expect(createDocumentPreviewHtml(document, ['第一', '第二'], 'translated')).toContain('第一');
    });

    it('Markdown source preview retains readable text without requiring translated output', () => {
        const document = parseDocument('source.md', '# A title\n\nA paragraph');
        const preview = createDocumentPreviewHtml(document, ['# 译文', '译文'], 'source');
        expect(preview).toContain('A title');
        expect(preview).toContain('A paragraph');
        expect(preview).not.toContain('译文');
    });

    it('falls back to a source line when a multiline Markdown fragment has fewer translated lines', () => {
        const document = parseDocument('fragment.md', 'First');
        document.parts = [{kind: 'segment', source: 'First\nSecond', segmentIndex: 0, prefix: '', suffix: ''}];
        expect(createDocumentPreviewHtml(document, ['第一'], 'bilingual')).toContain('Second');
    });

    it('HTML 文本实体以可读文本翻译且预览不会双重转义', () => {
        const document = parseDocument('guide.html', '<p>Hello&nbsp;world &amp; friends</p>');

        expect(document.segments.map((segment) => segment.source)).toEqual(['Hello\u00a0world & friends']);
        const sourcePreview = createDocumentPreviewHtml(document, [], 'source');
        expect(sourcePreview).toContain('Hello&nbsp;world &amp; friends');
        expect(sourcePreview).not.toContain('&amp;nbsp;');
        expect(sourcePreview).not.toContain('&amp;amp; friends');

        const bilingual = renderDocument(document, ['你好世界与朋友'], 'bilingual');
        expect(bilingual).toContain('Hello&nbsp;world &amp; friends');
        expect(bilingual).toContain('你好世界与朋友');
    });

    it('HTML 属性值中的大于号不会被当作标签结束位置', () => {
        const source = '<p title="1 > 0" data-note="> stays quoted">Hello</p>';
        const document = parseDocument('guide.html', source);

        expect(document.segments.map((segment) => segment.source)).toEqual(['Hello']);
        expect(renderDocument(document, ['你好'], 'translated')).toBe(
            '<p title="1 > 0" data-note="> stays quoted">你好</p>',
        );
    });

    it('HTML 嵌套受保护标签不会让 pre 剩余内容进入翻译队列', () => {
        const document = parseDocument(
            'guide.html',
            '<pre>before<code>const value = 1;</code>after</pre><p>Translate me</p>',
        );

        expect(document.segments.map((segment) => segment.source)).toEqual(['Translate me']);
        expect(renderDocument(document, ['翻译我'], 'translated')).toBe(
            '<pre>before<code>const value = 1;</code>after</pre><p>翻译我</p>',
        );
    });
});
