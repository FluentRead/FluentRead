import {describe, expect, it} from 'vitest';
import {
    documentSegmentMarkupSources,
    getDocumentAcceptAttribute,
    getDocumentFormat,
    getDocumentFormatLabel,
    getDocumentMaxBytes,
    getDocumentMimeType,
    parseDocument,
    renderDocument,
    DOCUMENT_MAX_BYTES,
} from '@/src/features/document-translation/core/document';
import {parseLatexDocument, renderLatexTranslation} from '@/src/features/document-translation/core/latex';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {formatDocumentReaderText, isRichDocumentFormat} from '@/src/features/document-translation/ui/presentation';

describe('LaTeX (.tex) document translation', () => {
    it('recognizes .tex metadata, MIME type, size limit, and rich format classification', () => {
        expect(getDocumentFormat('paper.TEX')).toBe('tex');
        expect(getDocumentFormatLabel('tex')).toBe('LaTeX 文档');
        expect(getDocumentMimeType('tex')).toBe('application/x-tex;charset=utf-8');
        expect(getDocumentMaxBytes('paper.tex')).toBe(DOCUMENT_MAX_BYTES);
        expect(getDocumentAcceptAttribute()).toContain('.tex');
        expect(isRichDocumentFormat('tex')).toBe(true);
        expect(formatDocumentReaderText('tex', 'Read <g1>important</g1> note <g2/>')).toBe('Read important note');
    });

    it('preserves preamble directives, math/verbatim environments, and comments while translating titles, headings, captions, abstract, and lists', () => {
        const source = [
            '\\documentclass[11pt]{article}',
            '% Preamble comment about packages',
            '\\usepackage{amsmath,graphicx}',
            '\\newcommand{\\R}{\\mathbb{R}}',
            '\\title[Short {Title}]{A Comprehensive {Study} on Neural Translation}',
            '\\subtitle{Draft Version}',
            '\\author{Ada Lovelace}',
            '\\date{2026}',
            '\\begin{document}',
            '\\maketitle',
            '\\begin{abstract}',
            'This paper studies $x^2 + y^2 = z^2$ and \\(a + b\\) with \\textbf{strong \\emph{emphasis}} and \\href{https://example.org}{our dataset}~\\cite{vaswani2017}.',
            '\\end{abstract}',
            '\\section{Introduction}',
            '\\label{sec:intro}',
            'See Section~\\ref{sec:intro} and \\verb|code_snippet| for details\\% % inline note',
            'spanning two lines with \\\\ and \\LaTeX{} macro.',
            '$$',
            'E = mc^2',
            '$$',
            '\\[',
            '\\int_0^1 f(x)\\,dx',
            '\\]',
            '\\begin{equation}',
            'a^2 + b^2 = c^2',
            '\\end{equation}',
            '\\begin{align*}',
            'u &= v + w',
            '\\end{align*}',
            '\\begin{verbatim}',
            'raw \\section{Not a heading} text',
            '\\end{verbatim}',
            '\\begin{lstlisting}[language=Python]',
            'def translate(x): return x',
            '\\end{lstlisting}',
            '\\begin{minted}{ts}',
            'const keep = true;',
            '\\end{minted}',
            '\\begin{tikzpicture}',
            '\\draw (0,0) -- (1,1);',
            '\\end{tikzpicture}',
            '\\subsection*{Key Contributions}',
            '\\begin{itemize}',
            '  \\item[First] We protect \\url{https://example.com} cleanly.',
            '  \\item Second item with \\textit{italic text}.',
            '\\end{itemize}',
            '\\begin{figure}[htbp]',
            '  \\centering',
            '  \\includegraphics[width=0.8\\linewidth]{arch.png}',
            '  \\caption{System overview for \\emph{fast} decoding.}',
            '\\end{figure}',
            '\\end{document}',
            '% Trailing comment after document',
        ].join('\n');

        const parsed = parseDocument('paper.tex', source);
        expect(parsed.format).toBe('tex');
        expect(parsed.segments.map(s => [s.role, s.source])).toEqual([
            ['title', 'A Comprehensive {Study} on Neural Translation'],
            ['title', 'Draft Version'],
            ['paragraph', 'This paper studies <g1/> and <g2/> with <g3>strong <g4>emphasis</g4></g3> and <g5>our dataset</g5><g6/><g7/>.'],
            ['heading', 'Introduction'],
            ['paragraph', 'See Section<g1/><g2/> and <g3/> for details<g4/> <g5/>\nspanning two lines with <g6/> and <g7/> macro.'],
            ['heading', 'Key Contributions'],
            ['list-item', 'We protect <g1/> cleanly.'],
            ['list-item', 'Second item with <g1>italic text</g1>.'],
            ['paragraph', 'System overview for <g1>fast</g1> decoding.'],
        ]);

        const markupSources = documentSegmentMarkupSources(parsed);
        expect(markupSources.get(2)).toContain('\\href{https://example.org}{our dataset}');
        expect(markupSources.get(0)).toBeUndefined();

        const translations = [
            '神经翻译的全面{研究}',
            '草稿版本',
            '本文研究 <g1/> 与 <g2/>，带有<g3>强烈的<g4>强调</g4></g3>和<g5>我们的数据集</g5><g6/><g7/>。',
            '引言',
            '详见第<g1/><g2/>节与 <g3/> 的详情<g4/> <g5/>\n跨两行并带有 <g6/> 和 <g7/> 宏。',
            '主要贡献',
            '我们干净地保护了 <g1/>。',
            '第二项包含<g1>斜体文字</g1>。',
            '用于<g1>快速</g1>解码的系统概览。',
        ];

        const translated = renderDocument(parsed, translations, 'translated');
        expect(translated).toContain('\\usepackage{amsmath,graphicx}');
        expect(translated).toContain('\\newcommand{\\R}{\\mathbb{R}}');
        expect(translated).toContain('\\author{Ada Lovelace}');
        expect(translated).toContain('\\title[Short {Title}]{神经翻译的全面{研究}}');
        expect(translated).toContain('\\subtitle{草稿版本}');
        expect(translated).toContain('本文研究 $x^2 + y^2 = z^2$ 与 \\(a + b\\)，带有\\textbf{强烈的\\emph{强调}}和\\href{https://example.org}{我们的数据集}~\\cite{vaswani2017}。');
        expect(translated).toContain('\\section{引言}');
        expect(translated).toContain('\\label{sec:intro}');
        expect(translated).toContain('\\verb|code_snippet|');
        expect(translated).toContain('% inline note');
        expect(translated).toContain('raw \\section{Not a heading} text');
        expect(translated).toContain('def translate(x): return x');
        expect(translated).toContain('const keep = true;');
        expect(translated).toContain('\\draw (0,0) -- (1,1);');
        expect(translated).toContain('\\subsection*{主要贡献}');
        expect(translated).toContain('\\item[First] 我们干净地保护了 \\url{https://example.com}。');
        expect(translated).toContain('\\item 第二项包含\\textit{斜体文字}。');
        expect(translated).toContain('\\caption{用于\\emph{快速}解码的系统概览。}');
        expect(translated).toContain('% Trailing comment after document');

        const bilingual = renderDocument(parsed, translations, 'bilingual');
        expect(bilingual).toContain('\\section{Introduction\n引言}');
        expect(bilingual).toContain('This paper studies $x^2 + y^2 = z^2$');
        expect(bilingual).toContain('\n\n本文研究 $x^2 + y^2 = z^2$');
        expect(bilingual).toContain('\\item[First] We protect \\url{https://example.com} cleanly.\n\n我们干净地保护了 \\url{https://example.com}。');
        expect(bilingual).toContain('\\caption{System overview for \\emph{fast} decoding.\n用于\\emph{快速}解码的系统概览。}');

        // Untranslated returns original lossless source
        expect(renderDocument(parsed, [], 'bilingual')).toBe(source);
        expect(renderDocument(parsed, [], 'translated')).toBe(source);

        // Rich preview HTML
        const sourcePreview = createDocumentPreviewHtml(parsed, [], 'source');
        expect(sourcePreview).toContain('data-reader-mode="source"');
        expect(sourcePreview).toContain('<h1 class="reader-source">A Comprehensive {Study} on Neural Translation</h1>');
        expect(sourcePreview).toContain('<h2 class="reader-source">Introduction</h2>');
        expect(sourcePreview).toContain('reader-unit list-item');

        const bilingualPreview = createDocumentPreviewHtml(parsed, translations, 'bilingual');
        expect(bilingualPreview).toContain('data-reader-mode="bilingual"');
        expect(bilingualPreview).toContain('引言');
        expect(bilingualPreview).not.toContain('<g1>');

        const translatedPreview = createDocumentPreviewHtml(parsed, translations, 'translated');
        expect(translatedPreview).toContain('data-reader-mode="translated"');
        expect(translatedPreview).toContain('主要贡献');
    });

    it('handles LaTeX edge cases: fragments, comments inside braces, unclosed constructs, non-translatable commands, and placeholder recovery', () => {
        // Fragment without \begin{document}, CRLF endings, nested brackets, non-translatable runs, nested comments inside braces/brackets, unclosed constructs
        const fragment = [
            '\\chapter[Outer [inner] % comment\nwith {nested [bracket]}]{Chapter % inner comment\nOne with \\{escaped\\}}',
            '',
            'Plain paragraph with lone $5 price, \\verb*+a+b+, \\verb|unclosed',
            '',
            'Another paragraph with \\href{https://x.test}{123}, \\textbf{456}, \\href no-brace, \\href{https://y.test}, \\textbf no-brace, \\verb',
            '',
            'Line two stops before $$x$$',
            '$$unclosed math',
        ].join('\r\n');
        const parsedFrag = parseDocument('chapter.tex', fragment);
        expect(parsedFrag.segments.length).toBe(4);
        expect(parsedFrag.segments[0].role).toBe('heading');
        expect(parsedFrag.segments[1].source).toContain('lone $5 price');

        // Preamble without commands or comments, plus body \title, empty \item, non-letter paragraph, \begin/\end without braces, starred block command, trailing comment without newline
        const preamblePlain = 'plain preamble\n\\begin{document}\n\\title{Body Title}\n\\vspace*{1cm}\n\\item\n\\item Next item\n\n12345 $x+y$ \\cite{a}\n\n\\begin plain and \\end plain\n\\end{document}\n% trailing comment without newline';
        const parsedPlain = parseLatexDocument(preamblePlain);
        expect(parsedPlain.segments.map(s => [s.role, s.source])).toEqual([
            ['title', 'Body Title'],
            ['list-item', 'Next item'],
            ['paragraph', '<g1/> plain and <g2/> plain'],
        ]);

        // Unclosed brackets/braces/environments/inline math/comments, literal <g1>, and non-letter paragraphs
        const tricky = [
            '\\title[unclosed bracket{Ignored}',
            '\\title{unclosed brace',
            '\\begin{document}',
            '% comment line',
            '\\begin{unclosed',
            '\\end{unclosed',
            '\\begin{equation}',
            'x = 1',
        ].join('\n');
        const parsedTricky = parseLatexDocument(tricky);
        expect(parsedTricky.segments.map(s => s.source)).toEqual(['<g1/>{unclosed\n<g2/>{unclosed']);

        const inlineEdge = [
            '\\begin{document}',
            '\\section{   }',
            '',
            '12345 $x+y$ \\cite{a}',
            '',
            'Paragraph before \\begin{quote}quoted text\\end{quote}',
            'Paragraph before \\[display\\]',
            'Inline with \\(unclosed % comment\nmath',
            '',
            'Literal <g1> keeps plain text with $a$ intact.',
            '',
            'Paragraph with \\unknown[opt]{arg1}{arg2} and \\unknownOpt[unclosed and \\unknownBrace{unclosed and \\\\.',
            '\\item[unclosed bracket item text',
            '\\end{document}',
        ].join('\n');
        const parsedInline = parseDocument('edge.tex', inlineEdge);
        expect(parsedInline.segments.some(s => s.source.includes('Literal <g1>'))).toBe(true);
        expect(parsedInline.segments.some(s => s.source.includes('quoted text'))).toBe(true);
        expect(parsedInline.segments.some(s => s.source.includes('item text'))).toBe(true);
        expect(renderDocument(parsedInline, [], 'translated')).toBe(inlineEdge);

        // Comment at EOF without trailing newline inside body
        expect(parseLatexDocument('Hello world\n% comment at eof').segments.map(s => s.source)).toEqual(['Hello world']);

        // Unclosed math \[ at EOF and inline $ with \% comment inside
        const mathEdge = 'Text with $a \\% b % comment\n+ c$ and \\[x = 1';
        const parsedMath = parseLatexDocument(mathEdge);
        expect(parsedMath.segments).toHaveLength(1);
        expect(parsedMath.segments[0].source).toBe('Text with <g1/> and');

        // Command with no { after \section
        const badCmd = '\\section no brace here';
        expect(parseLatexDocument(badCmd).segments).toHaveLength(1);

        // renderLatexTranslation edge branches: empty tokens, valid pair + self-closing + extra closing on self-closing, duplicate, unknown id, self-closing on pair, mismatched close, fallback with/without kept tokens
        expect(renderLatexTranslation(undefined, 'hello')).toBe('hello');
        const tokens = [{open: '$x$'}, {open: '\\textbf{', close: '}'}];
        expect(renderLatexTranslation(tokens, '<g1/></g1> <g2>文本</g2>')).toBe('$x$ \\textbf{文本}');
        // Unknown token id -> fallback keeping $x$
        expect(renderLatexTranslation(tokens, '<g9>未知</g9> 译文')).toBe('未知 译文 $x$');
        // Duplicate self-closing & self-closing on pair & mismatched close -> fallback
        expect(renderLatexTranslation(tokens, '<g1/><g1/><g2/>译文')).toBe('译文 $x$');
        expect(renderLatexTranslation(tokens, '<g2>译文</g1>')).toBe('译文 $x$');
        // Mismatched nested paired close triggers open.pop() !== id
        expect(renderLatexTranslation([{open: '\\textbf{', close: '}'}, {open: '\\emph{', close: '}'}], '<g1><g2>错配</g1></g2>')).toBe('错配');
        // Fallback when only paired token exists (no self-closing tokens to append)
        expect(renderLatexTranslation([{open: '\\emph{', close: '}'}], '<g1>缺少闭合')).toBe('缺少闭合');
        // Preview with empty translation entry falls back to source
        const shortDoc = parseDocument('short.tex', 'Hello $x$ world.');
        expect(createDocumentPreviewHtml(shortDoc, [''], 'bilingual')).toContain('Hello  world.');
    });
});
