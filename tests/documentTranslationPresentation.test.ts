import {describe, expect, it} from 'vitest';

import type {BinaryDocumentData, DocumentFormat, ParsedDocument} from '@/src/features/document-translation/core/document';
import {
    formatDocumentReaderText,
    getDocumentEmptyReaderHint,
    getDocumentFormatTone,
    getDocumentPreviewMeta,
    getDocumentReaderSourceClass,
    getDocxPartLabel,
    isRichDocumentFormat,
    isSubtitleDocumentFormat,
} from '@/src/features/document-translation/ui/presentation';

function parsed(format: DocumentFormat, binary?: BinaryDocumentData): ParsedDocument {
    return {
        fileName: `sample.${format}`,
        format,
        label: format,
        parts: [],
        segments: [],
        binary,
    };
}

describe('document translation presentation', () => {
    it('按文档类型返回稳定的阅读器说明', () => {
        const pdf = parsed('pdf', {kind: 'pdf', bytes: new Uint8Array(), pages: []});
        const epub = parsed('epub', {kind: 'epub', bytes: new Uint8Array(), chapters: []});
        const docx = parsed('docx', {kind: 'docx', bytes: new Uint8Array(), parts: []});

        expect(getDocumentPreviewMeta(pdf).title).toBe('PDF 原页与译页');
        expect(getDocumentPreviewMeta(epub).title).toBe('ePub 章节双语阅读');
        expect(getDocumentPreviewMeta(docx).title).toBe('Word 文档原文与译文');
        expect(getDocumentPreviewMeta(parsed('srt')).title).toBe('字幕时间轴与译文');
        expect(getDocumentPreviewMeta(parsed('json')).title).toBe('JSON 路径与字符串译文');
        expect(getDocumentPreviewMeta(parsed('markdown')).title).toBe('Markdown 双语文章');
        expect(getDocumentPreviewMeta(parsed('html')).title).toBe('HTML 双语排版预览');
        expect(getDocumentPreviewMeta(null).title).toBe('原文与译文');
    });

    it('区分格式族、空态提示和视觉色调', () => {
        expect(isSubtitleDocumentFormat('vtt')).toBe(true);
        expect(isSubtitleDocumentFormat('txt')).toBe(false);
        expect(isSubtitleDocumentFormat()).toBe(false);
        expect(isRichDocumentFormat('epub')).toBe(true);
        expect(isRichDocumentFormat('pdf')).toBe(false);
        expect(isRichDocumentFormat()).toBe(false);

        expect(getDocumentEmptyReaderHint(parsed('pdf', {kind: 'pdf', bytes: new Uint8Array(), pages: []}))).toContain('原页面坐标');
        expect(getDocumentEmptyReaderHint(parsed('ass'))).toContain('时间轴');
        expect(getDocumentEmptyReaderHint(parsed('json'))).toContain('JSON 路径');
        expect(getDocumentEmptyReaderHint(null)).toContain('阅读结构');

        expect(getDocumentFormatTone('pdf')).toBe('coral');
        expect(getDocumentFormatTone('json')).toBe('teal');
        expect(getDocumentFormatTone('lrc')).toBe('violet');
        expect(getDocumentFormatTone('markdown')).toBe('sand');
        expect(getDocumentFormatTone()).toBe('slate');
    });

    it('把 DOCX 部件路径映射为中文阅读标签', () => {
        expect(getDocxPartLabel('word/document.xml')).toBe('正文');
        expect(getDocxPartLabel('word/header1.xml')).toBe('页眉');
        expect(getDocxPartLabel('word/footer1.xml')).toBe('页脚');
        expect(getDocxPartLabel('word/footnotes.xml')).toBe('脚注');
        expect(getDocxPartLabel('word/endnotes.xml')).toBe('尾注');
        expect(getDocxPartLabel('word/comments.xml')).toBe('文档内容');
    });

    it('把预览片段清理为可读文本并识别 Markdown 标题', () => {
        expect(formatDocumentReaderText('html', ' <b>Hello</b> ')).toBe('Hello');
        expect(formatDocumentReaderText('markdown', ' # **Read** [guide](https://example.com) `now` ![cover](x) '))
            .toBe('Read guide now cover');
        expect(formatDocumentReaderText('ass', ' {\\i1}<i>Hello</i> ')).toBe('Hello');
        expect(formatDocumentReaderText(undefined, '  Plain text  ')).toBe('Plain text');
        expect(getDocumentReaderSourceClass('markdown', '## Heading')).toBe('reader-heading');
        expect(getDocumentReaderSourceClass('markdown', 'Paragraph')).toBe('');
        expect(getDocumentReaderSourceClass('html', '## Heading')).toBe('');
    });
});
