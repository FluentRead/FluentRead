/**
 * @file src/features/document-translation/core/preview.ts
 * 文件职责：把已解析文档与对应译文转换成安全、可阅读的预览 HTML，统一支持原文、双语和纯译文三种预览模式。
 * 主要内容：包含主动 HTML 剥离、HTML5 阅读器外壳、无原文占位符的 Markdown 渲染、围栏代码块及连续折行段落对齐，以及 HTML、Markdown 和纯文本的原译配对；相同译文保留原文且不重复展示。
 * 模块边界：本模块只生成展示字符串，不操作真实 DOM、不执行脚本也不修改文档模型；源文件解析由 document.ts 完成，二进制分页预览由 pdfPreview.ts 负责，页面样式由上层 UI 提供。
 * Markdown 表格使用解析器的行范围，对照文字放在各自单元格。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {stripDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import {
    inspectMarkdownLine,
    parseDocument,
    renderDocument,
    unwrapDocumentSoftLines,
    type DocumentRenderMode,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';
import {splitMarkdownTableRow, type MarkdownTable} from './markdownTable';

export type DocumentPreviewMode = DocumentRenderMode | 'source';

const PREVIEW_SOFT_BREAK = '\u2028';

const PREVIEW_STYLE = `
:root { color-scheme: light; font-family: Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #20242d; background: #fff; }
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; }
body { max-width: 900px; margin: 0 auto; padding: 54px 64px 80px; font-size: 17px; line-height: 1.78; overflow-wrap: anywhere; }
main, article { display: block; }
h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 .55em; color: #1f232b; letter-spacing: -.025em; line-height: 1.3; }
h1:first-child, h2:first-child { margin-top: 0; }
h1 { font-size: 2em; } h2 { font-size: 1.55em; } h3 { font-size: 1.28em; }
p { margin: 0 0 1.15em; }
ul, ol { margin: .2em 0 1.2em; padding-left: 1.5em; }
blockquote { margin: .8em 0 1.2em; padding: .1em 0 .1em 1em; border-left: 3px solid #ef4776; color: #596174; }
pre { margin: 1.1em 0; padding: 16px 18px; overflow: auto; border: 1px solid #e4e7ef; border-radius: 12px; background: #f7f8fb; font-size: 13px; line-height: 1.6; }
code { padding: .12em .34em; border-radius: 5px; background: #f1f3f7; font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre code { padding: 0; background: transparent; }
img { max-width: 100%; height: auto; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 8px 10px; border: 1px solid #dde2eb; text-align: left; }
table.markdown-preview-table { table-layout: fixed; margin: 0 0 1.35em; }
a, .reader-link { color: #d83160; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
[data-fluent-read-document-translation="true"], .fluentread-translation { display: block; margin-top: .3em; color: #232831; font-weight: 650; }
.reader-unit { margin: 0 0 1.35em; }
.reader-unit > :first-child { margin-bottom: .22em; }
.reader-unit > :last-child { margin-bottom: 0; }
.reader-source { color: #303640; font-weight: 440; }
.reader-translation { color: #20242d; font-weight: 700; }
.reader-unit.heading .reader-source, .reader-unit.heading .reader-translation { font-weight: 780; }
.reader-unit.list-item { position: relative; padding-left: 1.4em; }
.reader-unit.list-item::before { position: absolute; top: .22em; left: .15em; color: #ef4776; content: "•"; }
.reader-unit.horizontal-rule { height: 1px; margin: 2em 0; background: #e3e7ef; }
.document-security-note { margin: 0 0 24px; padding: 9px 12px; border-radius: 9px; color: #6c7485; background: #f7f8fb; font-size: 12px; }
@media (max-width: 680px) { body { padding: 30px 24px 56px; font-size: 15px; } }
@media (min-width: 860px) {
  body:has(article[data-reader-mode="bilingual"]) { max-width: 1480px; padding: 40px 48px 72px; }
  article[data-reader-mode="bilingual"] .reader-unit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 44px; align-items: start; }
  article[data-reader-mode="bilingual"] .reader-unit > * { margin-bottom: 0; }
  article[data-reader-mode="bilingual"] .reader-translation { margin-top: 0; font-weight: 500; }
  article[data-reader-mode="bilingual"] .reader-unit.heading .reader-translation { font-weight: 780; }
}
body[data-translating] article[data-reader-mode="bilingual"] .reader-unit:has(> .reader-source:only-child)::after { content: ""; width: 62%; height: .85em; margin-top: .5em; border-radius: 6px; background: linear-gradient(90deg, #eceff5 25%, #f7f8fb 50%, #eceff5 75%) 0 0 / 200% 100%; animation: reader-wait 1.3s linear infinite; }
@keyframes reader-wait { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { body[data-translating] .reader-unit::after { animation: none !important; } }
`;

function escapeHtml(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

function stripActiveHtml(value: string): string {
    return value
        .replace(/<\?xml[\s\S]*?\?>/giu, '')
        .replace(/<!doctype[\s\S]*?>/giu, '')
        .replace(/<(?:script|iframe|object|embed|form)\b[\s\S]*?<\/(?:script|iframe|object|embed|form)\s*>/giu, '')
        .replace(/<(?:script|iframe|object|embed|form|base)\b[^>]*\/?\s*>/giu, '')
        .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:["']?)(?:refresh|content-security-policy)[^>]*>/giu, '')
        .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '');
}

/** 只检查文档开头及所属 head；跳过前导注释，并保持属性中的引号和大于号完整。 */
function openingHtmlTagEnd(value: string, tag: 'html' | 'head', offset = 0): number | null {
    const whitespace = /\s*/uy;
    let start = offset;
    for (;;) {
        whitespace.lastIndex = start;
        start += whitespace.exec(value)![0].length;
        if (!value.startsWith('<!--', start)) break;
        const end = value.indexOf('-->', start + 4);
        if (end === -1) return null;
        start = end + 3;
    }
    const pattern = /<(html|head)\b(?:[^>"']|"[^"]*"|'[^']*')*>/iuy;
    pattern.lastIndex = start;
    const match = pattern.exec(value);
    return match?.[1].toLowerCase() === tag ? start + match[0].length : null;
}

function readerShell(content: string): string {
    const security = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${PREVIEW_STYLE}</style>`;
    const safeContent = stripActiveHtml(content);
    const rootEnd = openingHtmlTagEnd(safeContent, 'html');
    if (rootEnd !== null) {
        const headEnd = openingHtmlTagEnd(safeContent, 'head', rootEnd);
        const insertion = headEnd ?? rootEnd;
        const readerHead = headEnd === null ? `<head>${security}</head>` : security;
        return '<!doctype html>' + safeContent.slice(0, insertion) + readerHead + safeContent.slice(insertion);
    }
    return `<!doctype html><html><head>${security}</head><body><main>${safeContent}</main></body></html>`;
}

function inlineMarkdown(value: string): string {
    const protectedText = (text: string) => escapeHtml(text).replace(/[*_]/gu, (marker) => marker === '*' ? '&#42;' : '&#95;');
    const output: string[] = [];
    let offset = 0;
    // 直接拼接保护片段，不借用原文中可能存在的占位符，也不反复扫描整段文本。
    for (const match of value.matchAll(/\u2028|`([^`\n]+)`|!\[([^\[\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))+\)|\[([^\[\]\n]+)\]\((?:https?:\/\/|#)(?:[^()\n]|\([^()\n]*\))+\)/gu)) {
        output.push(escapeHtml(value.slice(offset, match.index)));
        output.push(match[0] === PREVIEW_SOFT_BREAK
            ? '<br>'
            : match[1] !== undefined
                ? `<code>${protectedText(match[1])}</code>`
                : `<span class="reader-link">${protectedText(match[2] !== undefined ? match[2] || '图片' : match[3])}</span>`);
        offset = match.index + match[0].length;
    }
    output.push(escapeHtml(value.slice(offset)));
    return output.join('')
        .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
        .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '<em>$1</em>');
}

function removeMarkdownMarker(value: string, kind: 'heading' | 'list-item' | 'quote' | 'paragraph'): string {
    if (kind === 'paragraph') return value;
    const content = inspectMarkdownLine(value).content;
    return kind === 'heading' ? content.replace(/^#{1,6}\s*/u, '') : content;
}

function pairedUnit(
    source: string,
    translation: string,
    mode: DocumentPreviewMode,
    kind: 'heading' | 'list-item' | 'quote' | 'paragraph',
    headingLevel = 2,
): string {
    const sourceContent = removeMarkdownMarker(source, kind);
    const translationContent = mode === 'source' ? '' : removeMarkdownMarker(translation, kind);
    const distinct = mode !== 'source' && hasDistinctTranslation(sourceContent, translationContent);
    const tag = kind === 'heading' ? `h${headingLevel}` : kind === 'quote' ? 'blockquote' : 'p';
    const sourceNode = mode === 'translated' && distinct
        ? '' : `<${tag} class="reader-source">${inlineMarkdown(sourceContent)}</${tag}>`;
    const translatedNode = distinct
        ? `<${tag} class="reader-translation fluentread-translation">${inlineMarkdown(translationContent)}</${tag}>` : '';
    const body = !distinct ? sourceNode : mode === 'translated' ? translatedNode : `${sourceNode}${translatedNode}`;
    return `<section class="reader-unit ${kind}" data-reader-unit>${body}</section>`;
}

function renderMarkdownTablePreview(
    table: MarkdownTable, source: readonly string[], translated: readonly string[], mode: DocumentPreviewMode, translatedLineOffset: number,
): string {
    const cells = (line: string) => {
        const value = inspectMarkdownLine(line).content;
        return splitMarkdownTableRow(value).cells.map(({start, end}) => value.slice(start, end).trim()
            .replace(/\\\|/gu, '|').replace(/<br\s*\/?>/giu, PREVIEW_SOFT_BREAK));
    };
    const row = (index: number, tag: 'td' | 'th') => {
        const original = cells(source[index]);
        const localized = mode === 'source' ? original : cells(translated[index - translatedLineOffset]);
        const values = original.slice(0, table.alignments.length).map((value, column) => {
            const translation = localized[column];
            const distinct = hasDistinctTranslation(value, translation);
            const content = distinct && mode === 'translated' ? inlineMarkdown(translation) : inlineMarkdown(value)
                + (distinct ? `<span class="reader-translation fluentread-translation">${inlineMarkdown(translation)}</span>` : '');
            const align = table.alignments[column];
            const style = align === 'left' || align === 'center' || align === 'right' ? ` style="text-align:${align}"` : '';
            return `<${tag}${style}>${content}</${tag}>`;
        });
        const missing = table.alignments.length - values.length;
        if (missing) values.push(`<${tag} colspan="${missing}"></${tag}>`);
        return `<tr>${values.join('')}</tr>`;
    };
    const body: string[] = [];
    for (let index = table.startLine + 2; index < table.endLine; index += 1) body.push(row(index, 'td'));
    return `<table class="markdown-preview-table" data-reader-unit><thead>${row(table.startLine, 'th')}</thead><tbody>${body.join('')}</tbody></table>`;
}

function renderMarkdownPreview(
    document: ParsedDocument, source: string, translated: string, translations: readonly string[], mode: DocumentPreviewMode,
): string {
    const sourceLines = source.replace(/\r\n?/gu, '\n').split('\n');
    const translatedLines = translated.replace(/\r\n?/gu, '\n').split('\n');
    const output: string[] = [];
    // 正常模型复用解析时的结果；外部构造的旧模型也通过同一解析器补齐，不另设围栏状态机。
    const codeBlocks = document.markdownCodeBlocks ?? parseDocument('preview.md', source).markdownCodeBlocks!;
    const tables = document.markdownTables ?? [];
    let codeBlockIndex = 0, tableIndex = 0;
    const wrapped = document.parts.flatMap(part => {
        if (part.kind !== 'segment' || part.bilingualGroup === undefined || !part.rawSource) return [];
        const wraps = part.rawSource.match(/\r\n?|\n/gu)?.length ?? 0;
        return wraps ? [{part, raw: part.rawSource, wraps}] : [];
    });
    let wrappedIndex = 0;
    let translatedLineOffset = 0;
    for (let index = 0; index < sourceLines.length; index += 1) {
        const block = codeBlocks[codeBlockIndex];
        if (block?.startLine === index) {
            output.push(`<pre data-reader-unit><code>${escapeHtml(block.contentLines.join('\n'))}</code></pre>`);
            index = block.endLine - 1;
            codeBlockIndex += 1;
            continue;
        }
        const table = tables[tableIndex];
        if (table?.startLine === index) {
            output.push(renderMarkdownTablePreview(table, sourceLines, translatedLines, mode, translatedLineOffset));
            index = table.endLine - 1;
            tableIndex += 1;
            continue;
        }
        const paragraph = wrapped[wrappedIndex];
        if (paragraph?.part.bilingualGroup === index) {
            const original = unwrapDocumentSoftLines(paragraph.raw, 'markdown');
            const translatedParagraph = mode !== 'source' && hasDistinctTranslation(paragraph.part.source, translations[paragraph.part.segmentIndex]);
            const translation = translatedParagraph ? translatedLines[index - translatedLineOffset] : undefined;
            output.push(pairedUnit(original, translation ?? original, mode, 'paragraph'));
            // 已翻译段落收为一行，待翻译和原样返回的段落仍保留源行数。
            if (translatedParagraph) translatedLineOffset += paragraph.wraps;
            index += paragraph.wraps;
            wrappedIndex += 1;
            continue;
        }
        const sourceLine = sourceLines[index];
        if (!sourceLine.trim()) continue;
        const info = inspectMarkdownLine(sourceLine);
        if (/^(?:[-*_]\s*){3,}$/u.test(info.content)) {
            output.push('<div class="reader-unit horizontal-rule" data-reader-unit></div>');
            continue;
        }
        const heading = info.content.match(/^(#{1,6})\s+/u);
        const kind = heading
            ? 'heading'
            : info.listIndent > 0
                ? 'list-item'
                : info.quoteDepth > 0
                    ? 'quote'
                    : 'paragraph';
        output.push(pairedUnit(sourceLine, translatedLines[index - translatedLineOffset] || sourceLine, mode, kind, heading?.[1].length || 2));
    }
    return readerShell(`<article class="markdown-article" data-reader-mode="${mode}">${output.join('')}</article>`);
}

function renderTextPreview(
    sourceBlocks: readonly string[],
    translatedBlocks: readonly string[],
    mode: DocumentPreviewMode,
): string {
    const body = sourceBlocks.map((sourceBlock, index) => pairedUnit(
        sourceBlock,
        mode === 'source' ? '' : translatedBlocks[index] || sourceBlock,
        mode,
        'paragraph',
    )).join('');
    return readerShell(`<article class="text-article" data-reader-mode="${mode}">${body}</article>`);
}

export function createDocumentPreviewHtml(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentPreviewMode,
): string {
    const previewTranslations = mode !== 'source' && ['markdown', 'txt', 'tex'].includes(document.format)
        ? Array.from({length: document.segments.length}, (_, index) => {
            const translation = translations[index];
            return translation === undefined
                ? document.segments[index].source
                : translation.replace(/\r\n?|\n/gu, PREVIEW_SOFT_BREAK);
        })
        : translations;
    if (document.format === 'html') {
        return readerShell(renderDocument(document, mode === 'source' ? [] : translations, mode === 'source' ? 'translated' : mode));
    }
    if (document.format === 'markdown') {
        const source = renderDocument(document, [], 'translated');
        const translated = mode === 'source' ? source : renderDocument(document, previewTranslations, 'translated');
        return renderMarkdownPreview(document, source, translated, previewTranslations, mode);
    }
    if (document.format === 'txt') {
        return renderTextPreview(
            document.segments.map((segment) => segment.source),
            previewTranslations,
            mode,
        );
    }
    if (document.format === 'tex') {
        const body = document.segments.map((segment, index) => {
            const kind = segment.role === 'title' || segment.role === 'heading'
                ? 'heading'
                : segment.role === 'list-item' ? 'list-item' : 'paragraph';
            const sourceText = stripDocumentInlineMarkers(segment.source);
            const translatedText = mode === 'source' ? '' : stripDocumentInlineMarkers(previewTranslations[index] || segment.source);
            return pairedUnit(sourceText, translatedText, mode, kind, segment.role === 'title' ? 1 : 2);
        }).join('');
        return readerShell(`<article class="text-article" data-reader-mode="${mode}">${body}</article>`);
    }
    throw new Error(`不支持为 ${document.format} 生成富文档预览`);
}
