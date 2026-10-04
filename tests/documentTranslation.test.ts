import {describe, expect, it} from 'vitest';

import {
    createDocumentDownloadName,
    getDocumentFormat,
    getDocumentMimeType,
    parseDocument,
    renderDocument,
} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';

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
        expect(getDocumentMimeType('markdown')).toBe('text/plain;charset=utf-8');
        expect(() => parseDocument('paper.pdf', '%PDF-')).toThrow('需要按二进制文件解析');
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

        const ass = parseDocument('episode.ass', '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello');
        expect(ass.segments.map((segment) => segment.source)).toEqual(['{\\i1}Hello']);
        expect(ass.segments[0]).toMatchObject({timeStart: '0:00:01.00', timeEnd: '0:00:02.00'});
        const output = renderDocument(ass, ['你好'], 'bilingual');
        expect(output).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello\\N{\\i1}你好');
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
        expect(sourcePreview).toContain('Hello\u00a0world &amp; friends');
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
