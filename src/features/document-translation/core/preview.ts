/**
 * @file src/features/document-translation/core/preview.ts
 * 文件职责：把已解析文档与对应译文转换成安全、可阅读的隔离预览 HTML，统一支持原文、双语和纯译文阅读，以及多种主题、字体与双语版式。
 * 主要内容：提供主动 HTML 剥离、HTML5 阅读器外壳、阅读外观样式与无障碍轻量等待动画；纯文本原样转义并识别多空行场景分隔、水平分割线及中英文章节标题；Markdown 支持 YAML frontmatter 折叠卡片、块级/行内数学公式、带语言标头的代码块、嵌套列表与任务复选框、连续引用与 GitHub Callout、删除线/单下划线斜体/安全外链/内联图片与可横向滚动表格，并为每个片段标注 data-segment-id 供增量补丁同步。
 * 模块边界：本模块只生成展示字符串，不操作真实 DOM、不执行脚本也不修改文档模型；源文件解析由 document.ts 完成，原位增量同步由 ui/richPreviewSync.ts 负责，二进制分页预览由 pdfPreview.ts 负责。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
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
export type DocumentBilingualLayout = 'split' | 'stacked';
export type DocumentReadingTheme = 'auto' | 'light' | 'sepia' | 'green' | 'dark';
export type DocumentReadingFontFamily = 'sans' | 'serif';

export interface DocumentPreviewOptions {
    bilingualLayout?: DocumentBilingualLayout;
    readingTheme?: DocumentReadingTheme;
    fontFamily?: DocumentReadingFontFamily;
    lineHeight?: number;
}

const PREVIEW_SOFT_BREAK = '\u2028';

const PREVIEW_STYLE = `
:root { color-scheme: light; --reader-bg: #fff; --reader-ink: #20242d; --reader-source: #303640; --reader-muted: #596174; --reader-surface: #f7f8fb; --reader-code-bg: #f1f3f7; --reader-border: #e4e7ef; --reader-accent: #d83160; --reader-pending: #e6eaf2; --reader-font: Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; font-family: var(--reader-font); color: var(--reader-ink); background: var(--reader-bg); }
* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; background: var(--reader-bg); color: var(--reader-ink); }
body { max-width: 900px; margin: 0 auto; padding: 54px 64px 80px; font-size: 17px; line-height: 1.78; overflow-wrap: anywhere; }
main, article { display: block; }
h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 .55em; color: var(--reader-ink); letter-spacing: -.025em; line-height: 1.3; }
h1:first-child, h2:first-child { margin-top: 0; }
h1 { font-size: 2em; } h2 { font-size: 1.55em; } h3 { font-size: 1.28em; }
p { margin: 0 0 1.15em; }
ul, ol { margin: .2em 0 1.2em; padding-left: 1.5em; }
blockquote { margin: .8em 0 1.2em; padding: .1em 0 .1em 1em; border-left: 3px solid var(--reader-accent); color: var(--reader-muted); }
pre { margin: 1.1em 0; padding: 16px 18px; overflow: auto; border: 1px solid var(--reader-border); border-radius: 12px; background: var(--reader-surface); font-size: 13px; line-height: 1.6; }
code { padding: .12em .34em; border-radius: 5px; background: var(--reader-code-bg); font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre code { padding: 0; background: transparent; }
img { max-width: 100%; height: auto; }
.reader-inline-image { display: inline-block; vertical-align: middle; border-radius: 6px; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 8px 10px; border: 1px solid var(--reader-border); text-align: left; }
.reader-table-scroll { overflow-x: auto; margin: 0 0 1.35em; content-visibility: auto; contain-intrinsic-size: auto 48px; }
table.markdown-preview-table { width: max-content; min-width: 100%; margin: 0; }
a, .reader-link { color: var(--reader-accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
[data-fluent-read-document-translation="true"], .fluentread-translation { display: block; margin-top: .35em; color: var(--reader-ink); font-weight: 600; }
[data-fluent-read-document-translation="true"] { padding: .18em 0 .18em .75em; border-left: 2px solid color-mix(in srgb, var(--reader-accent) 45%, transparent); }
.reader-unit { margin: 0 0 1.35em; content-visibility: auto; contain-intrinsic-size: auto 48px; }
.reader-unit > :first-child { margin-bottom: .22em; }
.reader-unit > :last-child { margin-bottom: 0; }
.reader-source { color: var(--reader-source); font-weight: 440; }
.reader-translation { color: var(--reader-ink); font-weight: 650; }
.reader-unit.heading .reader-source, .reader-unit.heading .reader-translation { font-weight: 780; }
.reader-unit.list-item { position: relative; padding-left: calc(1.4em + var(--list-depth, 0) * 1.25em); }
.reader-unit.list-item::before { position: absolute; top: .22em; left: calc(.15em + var(--list-depth, 0) * 1.25em); color: var(--reader-accent); content: "•"; }
.reader-unit.list-item.ordered-item::before { content: attr(data-list-marker); font-variant-numeric: tabular-nums; font-size: .92em; }
.reader-unit.list-item.task-item::before { content: none; }
.reader-checkbox { display: inline-flex; align-items: center; justify-content: center; width: 1.05em; height: 1.05em; margin-right: .45em; border: 1.5px solid var(--reader-border); border-radius: 4px; font-size: .8em; line-height: 1; vertical-align: -.08em; }
.reader-checkbox.is-checked { border-color: var(--reader-accent); background: var(--reader-accent); color: #fff; }
.reader-unit.quote[data-quote-depth="2"] { padding-left: 1em; }
.reader-unit.quote[data-quote-depth="3"] { padding-left: 2em; }
.reader-unit.horizontal-rule { height: 1px; margin: 2em 0; background: var(--reader-border); }
.reader-unit.scene-break { margin: 1.6em 0; text-align: center; color: var(--reader-muted); letter-spacing: .45em; }
.reader-unit.scene-break::before { content: "· · ·"; }
.reader-frontmatter { margin: 0 0 1.4em; padding: 10px 14px; border: 1px solid var(--reader-border); border-radius: 10px; background: var(--reader-surface); font-size: 13px; }
.reader-frontmatter summary { cursor: pointer; font-weight: 600; color: var(--reader-muted); }
.reader-frontmatter pre { margin: 8px 0 0; padding: 10px 12px; border: 0; background: transparent; }
.reader-code { margin: 1.1em 0; border: 1px solid var(--reader-border); border-radius: 12px; overflow: hidden; background: var(--reader-surface); }
.reader-code figcaption { padding: 6px 14px; border-bottom: 1px solid var(--reader-border); font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--reader-muted); }
.reader-code pre { margin: 0; border: 0; border-radius: 0; }
.reader-math { border-left: 3px solid var(--reader-accent); }
.reader-inline-math { font-style: italic; }
.reader-callout { margin: 1em 0 1.35em; padding: 12px 16px; border-left: 4px solid var(--callout-color, #2f81f7); border-radius: 0 10px 10px 0; background: var(--reader-surface); }
.reader-callout-title { margin-bottom: .45em; font-size: .88em; font-weight: 700; letter-spacing: .02em; color: var(--callout-color, #2f81f7); }
.reader-callout-note { --callout-color: #2f81f7; }
.reader-callout-tip { --callout-color: #2da44e; }
.reader-callout-important { --callout-color: #8250df; }
.reader-callout-warning { --callout-color: #d29922; }
.reader-callout-caution { --callout-color: #cf222e; }
.document-security-note { margin: 0 0 24px; padding: 9px 12px; border-radius: 9px; color: var(--reader-muted); background: var(--reader-surface); font-size: 12px; }
@media (max-width: 680px) { body { padding: 30px 24px 56px; font-size: 15px; } }
@media (min-width: 860px) {
  body:has(article[data-reader-mode="bilingual"]:not([data-bilingual-layout="stacked"])) { max-width: 1480px; padding: 40px 48px 72px; }
  article[data-reader-mode="bilingual"]:not([data-bilingual-layout="stacked"]) .reader-unit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 44px; align-items: start; }
  article[data-reader-mode="bilingual"]:not([data-bilingual-layout="stacked"]) .reader-unit > * { margin-bottom: 0; }
  article[data-reader-mode="bilingual"]:not([data-bilingual-layout="stacked"]) .reader-translation { margin-top: 0; font-weight: 500; }
  article[data-reader-mode="bilingual"]:not([data-bilingual-layout="stacked"]) .reader-unit.heading .reader-translation { font-weight: 780; }
}
body[data-translating] article[data-reader-mode="bilingual"] .reader-unit.is-pending::after { content: ""; display: block; width: 62%; height: .85em; margin-top: .5em; border-radius: 6px; background: var(--reader-pending); will-change: opacity; animation: reader-wait 1.2s ease-in-out infinite; }
@keyframes reader-wait { 0%, 100% { opacity: .35; } 50% { opacity: .85; } }
@media (prefers-reduced-motion: reduce) { body[data-translating] .reader-unit.is-pending::after { animation: none !important; } }
`;

const THEME_OVERRIDES: Record<Exclude<DocumentReadingTheme, 'auto'>, string> = {
    light: ':root { color-scheme: light; --reader-bg: #fff; --reader-ink: #20242d; --reader-source: #303640; --reader-muted: #596174; --reader-surface: #f7f8fb; --reader-code-bg: #f1f3f7; --reader-border: #e4e7ef; --reader-accent: #d83160; --reader-pending: #e6eaf2; }',
    sepia: ':root { color-scheme: light; --reader-bg: #f6f0e4; --reader-ink: #3b2f21; --reader-source: #4d3e2d; --reader-muted: #705e49; --reader-surface: #ede3d0; --reader-code-bg: #e5d8c0; --reader-border: #d8c6aa; --reader-accent: #b5452e; --reader-pending: #dfd1b8; } body, main, article, section, div, p, li, td, th { background-color: transparent !important; color: var(--reader-ink) !important; } html, body { background-color: var(--reader-bg) !important; }',
    green: ':root { color-scheme: light; --reader-bg: #e9f3eb; --reader-ink: #1f3326; --reader-source: #2c4535; --reader-muted: #4b6756; --reader-surface: #dcebe0; --reader-code-bg: #cfe3d5; --reader-border: #b8d3c0; --reader-accent: #1d7a49; --reader-pending: #c5dccb; } body, main, article, section, div, p, li, td, th { background-color: transparent !important; color: var(--reader-ink) !important; } html, body { background-color: var(--reader-bg) !important; }',
    dark: ':root { color-scheme: dark; --reader-bg: #1c212b; --reader-ink: #e8edf7; --reader-source: #cfd7e6; --reader-muted: #9ea8bd; --reader-surface: #252c39; --reader-code-bg: #2e3748; --reader-border: #3d475b; --reader-accent: #ff8bad; --reader-pending: #313b4e; } body, main, article, section, div, p, li, td, th, h1, h2, h3, h4, h5, h6 { color: var(--reader-ink) !important; } body, main, article, section, div, p, li, td, th { background-color: transparent !important; } html, body { background-color: var(--reader-bg) !important; } pre, code, .reader-frontmatter, .reader-code, .reader-callout { background-color: var(--reader-surface) !important; } a, .reader-link { color: var(--reader-accent) !important; }',
};

const FONT_OVERRIDES: Record<DocumentReadingFontFamily, string> = {
    sans: ':root { --reader-font: Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }',
    serif: ':root { --reader-font: "Noto Serif SC", "Songti SC", Georgia, "Times New Roman", serif; }',
};

const HTML_SPLIT_BILINGUAL_CSS = '@media (min-width: 860px) { body { max-width: 1380px; } p:has(> [data-fluent-read-document-translation="true"]), li:has(> [data-fluent-read-document-translation="true"]), blockquote:has(> [data-fluent-read-document-translation="true"]) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 32px; align-items: start; } p:has(> [data-fluent-read-document-translation="true"]) > br, li:has(> [data-fluent-read-document-translation="true"]) > br, blockquote:has(> [data-fluent-read-document-translation="true"]) > br { display: none; } }';
const HTML_STACKED_BILINGUAL_CSS = '[data-fluent-read-document-translation="true"] { margin-top: .45em; padding: .35em .8em; border-radius: 6px; background: var(--reader-surface); }';

function buildAppearanceCss(options: DocumentPreviewOptions | undefined, isHtmlDocument: boolean): string {
    if (!options) return '';
    const rules: string[] = [];
    if (options.readingTheme && options.readingTheme !== 'auto') rules.push(THEME_OVERRIDES[options.readingTheme]);
    if (options.fontFamily) rules.push(FONT_OVERRIDES[options.fontFamily]);
    if (typeof options.lineHeight === 'number' && Number.isFinite(options.lineHeight) && options.lineHeight > 0) {
        const clamped = Math.round(Math.min(2.6, Math.max(1.2, options.lineHeight)) * 100) / 100;
        rules.push(`body { line-height: ${clamped}; }`);
    }
    if (isHtmlDocument && options.bilingualLayout === 'split') rules.push(HTML_SPLIT_BILINGUAL_CSS);
    if (isHtmlDocument && options.bilingualLayout === 'stacked') rules.push(HTML_STACKED_BILINGUAL_CSS);
    return rules.join('\n');
}

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

function readerShell(content: string, options?: DocumentPreviewOptions, isHtmlDocument = false): string {
    const extraCss = buildAppearanceCss(options, isHtmlDocument);
    const style = extraCss ? `${PREVIEW_STYLE}\n${extraCss}` : PREVIEW_STYLE;
    const security = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${style}</style>`;
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

function isSafeInlineImageUrl(url: string): boolean {
    return /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon);base64,/iu.test(url) || /^blob:/iu.test(url);
}

function plainTextHtml(value: string): string {
    return escapeHtml(value).replace(/\u2028/gu, '<br>');
}

function inlineMarkdown(value: string): string {
    const protectedText = (text: string) => escapeHtml(text)
        .replace(/[*_~$]/gu, (marker) => marker === '*' ? '&#42;' : marker === '_' ? '&#95;' : marker === '~' ? '&#126;' : '&#36;');
    const output: string[] = [];
    let offset = 0;
    // 直接拼接保护片段，不借用原文中可能存在的占位符，也不反复扫描整段文本。
    const pattern = /\u2028|`([^`\n]+)`|(?<!\$)\$(?!\s)([^$\n]*?\S)\$(?!\$)|!\[([^\[\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)|\[([^\[\]\n]+)\]\(((?:https?:\/\/|#)(?:[^()\n]|\([^()\n]*\))+)\)/gu;
    for (const match of value.matchAll(pattern)) {
        output.push(escapeHtml(value.slice(offset, match.index)));
        if (match[0] === PREVIEW_SOFT_BREAK) {
            output.push('<br>');
        } else if (match[1] !== undefined) {
            output.push(`<code>${protectedText(match[1])}</code>`);
        } else if (match[2] !== undefined) {
            output.push(`<code class="reader-inline-math">${protectedText(match[2])}</code>`);
        } else if (match[3] !== undefined) {
            const alt = match[3];
            const src = match[4].trim();
            output.push(isSafeInlineImageUrl(src)
                ? `<img class="reader-inline-image" src="${protectedText(src)}" alt="${protectedText(alt)}">`
                : `<span class="reader-link">${protectedText(alt || '[image]')}</span>`);
        } else {
            const label = match[5];
            const href = match[6];
            const external = href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
            output.push(`<a class="reader-link" href="${protectedText(href)}"${external}>${protectedText(label)}</a>`);
        }
        offset = match.index + match[0].length;
    }
    output.push(escapeHtml(value.slice(offset)));
    return output.join('')
        .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
        .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
        .replace(/~~([^~\n]+)~~/gu, '<del>$1</del>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '<em>$1</em>')
        .replace(/(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])/gu, '<em>$1</em>');
}

function removeMarkdownMarker(value: string, kind: 'heading' | 'list-item' | 'quote' | 'paragraph'): string {
    if (kind === 'paragraph') return value;
    const content = inspectMarkdownLine(value).content;
    return kind === 'heading' ? content.replace(/^#{1,6}\s*/u, '') : content;
}

interface PairedUnitOptions {
    headingLevel?: number;
    segmentId?: number;
    plainText?: boolean;
    headingClass?: string;
    extraClasses?: string;
    extraAttributes?: string;
    prefixHtml?: string;
    stripTaskPrefix?: boolean;
}

function stripTaskMarker(value: string, strip: boolean): string {
    return strip ? value.replace(/^\[[ xX]\][ \t]+/u, '') : value;
}

function pairedUnit(
    source: string,
    translation: string,
    mode: DocumentPreviewMode,
    kind: 'heading' | 'list-item' | 'quote' | 'paragraph',
    options: PairedUnitOptions = {},
): string {
    const {
        headingLevel = 2,
        segmentId,
        plainText = false,
        headingClass = '',
        extraClasses = '',
        extraAttributes = '',
        prefixHtml = '',
        stripTaskPrefix = false,
    } = options;
    const format = plainText ? plainTextHtml : inlineMarkdown;
    const rawSource = plainText ? source : stripTaskMarker(removeMarkdownMarker(source, kind), stripTaskPrefix);
    const rawTranslation = mode === 'source'
        ? ''
        : plainText
            ? translation
            : stripTaskMarker(removeMarkdownMarker(translation, kind), stripTaskPrefix);
    const distinct = mode !== 'source' && hasDistinctTranslation(rawSource, rawTranslation);
    const pending = mode !== 'source' && !distinct;
    const tag = kind === 'heading' ? `h${headingLevel}` : kind === 'quote' ? 'blockquote' : 'p';
    const classSuffix = headingClass ? ` ${headingClass}` : '';
    const sourceNode = mode === 'translated' && distinct
        ? ''
        : `<${tag} class="reader-source${classSuffix}">${prefixHtml}${format(rawSource)}</${tag}>`;
    const translatedNode = distinct
        ? `<${tag} class="reader-translation fluentread-translation${classSuffix}">${prefixHtml}${format(rawTranslation)}</${tag}>`
        : '';
    const body = !distinct ? sourceNode : mode === 'translated' ? translatedNode : `${sourceNode}${translatedNode}`;
    const classes = `reader-unit ${kind}${extraClasses ? ` ${extraClasses}` : ''}${pending ? ' is-pending' : ''}`;
    const segmentAttr = segmentId !== undefined ? ` data-segment-id="${segmentId}"` : '';
    return `<section class="${classes}" data-reader-unit${segmentAttr}${extraAttributes}>${body}</section>`;
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
    return `<div class="reader-table-scroll" data-reader-unit><table class="markdown-preview-table" data-reader-unit><thead>${row(table.startLine, 'th')}</thead><tbody>${body.join('')}</tbody></table></div>`;
}

function inspectMarkdownListMeta(sourceLine: string, content: string): {
    extraClasses: string;
    extraAttributes: string;
    prefixHtml: string;
    stripTaskPrefix: boolean;
} {
    const match = sourceLine.match(/^(?:\s*>\s*)*([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+/u)!;
    let leading = 0;
    for (const ch of match[1]) leading += ch === '\t' ? 4 : 1;
    const depth = Math.min(6, Math.floor(leading / 2));
    const marker = match[2];
    const ordered = /^\d/u.test(marker);
    const task = content.match(/^\[([ xX])\][ \t]+/u);
    const classes: string[] = [];
    const attrs: string[] = [];
    if (depth > 0) attrs.push(` style="--list-depth:${depth}"`);
    if (task) {
        const checked = task[1].toLowerCase() === 'x';
        classes.push('task-item');
        return {
            extraClasses: classes.join(' '),
            extraAttributes: attrs.join(''),
            prefixHtml: `<span class="reader-checkbox${checked ? ' is-checked' : ''}" aria-hidden="true">${checked ? '✓' : ''}</span>`,
            stripTaskPrefix: true,
        };
    }
    if (ordered) {
        classes.push('ordered-item');
        attrs.push(` data-list-marker="${escapeHtml(marker)}"`);
    }
    return {
        extraClasses: classes.join(' '),
        extraAttributes: attrs.join(''),
        prefixHtml: '',
        stripTaskPrefix: false,
    };
}

function buildMarkdownLineSegmentIds(document: ParsedDocument): Map<number, number> {
    const map = new Map<number, number>();
    for (const part of document.parts) {
        if (part.kind === 'segment' && part.bilingualGroup !== undefined && !map.has(part.bilingualGroup)) {
            map.set(part.bilingualGroup, part.segmentIndex);
        }
    }
    return map;
}

function renderMarkdownPreview(
    document: ParsedDocument,
    source: string,
    translated: string,
    translations: readonly string[],
    mode: DocumentPreviewMode,
    options?: DocumentPreviewOptions,
): string {
    const sourceLines = source.replace(/\r\n?/gu, '\n').split('\n');
    const translatedLines = translated.replace(/\r\n?/gu, '\n').split('\n');
    const output: string[] = [];
    // 正常模型复用解析时的结果；外部构造的旧模型也通过同一解析器补齐，不另设围栏状态机。
    const codeBlocks = document.markdownCodeBlocks ?? parseDocument('preview.md', source).markdownCodeBlocks!;
    const tables = document.markdownTables ?? [];
    const lineSegmentIds = buildMarkdownLineSegmentIds(document);
    let codeBlockIndex = 0, tableIndex = 0;
    const wrapped = document.parts.flatMap(part => {
        if (part.kind !== 'segment' || part.bilingualGroup === undefined || !part.rawSource) return [];
        const wraps = part.rawSource.match(/\r\n?|\n/gu)?.length ?? 0;
        return wraps ? [{part, raw: part.rawSource, wraps}] : [];
    });
    let wrappedIndex = 0;
    let translatedLineOffset = 0;
    let startIndex = 0;

    if (/^\uFEFF?---\s*$/u.test(sourceLines[0])) {
        const closeIndex = sourceLines.findIndex((line, lineIndex) => lineIndex > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
        if (closeIndex > 0) {
            const yamlBody = sourceLines.slice(1, closeIndex).join('\n').trim();
            output.push(`<details class="reader-frontmatter" data-reader-unit><summary>Frontmatter</summary><pre><code>${escapeHtml(yamlBody)}</code></pre></details>`);
            startIndex = closeIndex + 1;
        }
    }

    const translatedLineAt = (lineIndex: number): string => translatedLines[lineIndex - translatedLineOffset] || sourceLines[lineIndex];

    const isPureQuoteLine = (lineIndex: number) => {
        if (codeBlocks[codeBlockIndex]?.startLine === lineIndex || tables[tableIndex]?.startLine === lineIndex) return null;
        const line = sourceLines[lineIndex];
        if (!line.trim()) return null;
        const lineInfo = inspectMarkdownLine(line);
        if (!lineInfo.content || lineInfo.quoteDepth === 0 || lineInfo.listIndent > 0
            || /^#{1,6}\s+/u.test(lineInfo.content)
            || /^(?:[-*_]\s*){3,}$/u.test(lineInfo.content)
            || /^\$\$/u.test(lineInfo.content)) return null;
        return lineInfo;
    };

    for (let index = startIndex; index < sourceLines.length; index += 1) {
        const block = codeBlocks[codeBlockIndex];
        if (block?.startLine === index) {
            const codeHtml = `<pre data-reader-unit><code>${escapeHtml(block.contentLines.join('\n'))}</code></pre>`;
            const lang = block.info.trim().split(/\s+/u)[0];
            output.push(lang
                ? `<figure class="reader-code" data-reader-unit><figcaption class="reader-code-lang">${escapeHtml(lang)}</figcaption>${codeHtml}</figure>`
                : codeHtml);
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
            output.push(pairedUnit(original, translation ?? original, mode, 'paragraph', {segmentId: paragraph.part.segmentIndex}));
            // 已翻译段落收为一行，待翻译和原样返回的段落仍保留源行数。
            if (translatedParagraph) translatedLineOffset += paragraph.wraps;
            index += paragraph.wraps;
            wrappedIndex += 1;
            continue;
        }
        const sourceLine = sourceLines[index];
        if (!sourceLine.trim()) continue;
        const info = inspectMarkdownLine(sourceLine);
        if (!info.content) continue;
        if (/^\$\$\s*$/u.test(info.content)) {
            const mathLines: string[] = [];
            let cursor = index + 1;
            while (cursor < sourceLines.length) {
                const nextInfo = inspectMarkdownLine(sourceLines[cursor]);
                if (/^\$\$\s*$/u.test(nextInfo.content)) break;
                mathLines.push(nextInfo.quoteDepth >= info.quoteDepth ? nextInfo.content : sourceLines[cursor]);
                cursor += 1;
            }
            output.push(`<pre class="reader-math" data-reader-unit><code>${escapeHtml(mathLines.join('\n'))}</code></pre>`);
            index = cursor;
            continue;
        }
        const singleMath = info.content.match(/^\$\$(.+)\$\$\s*$/u);
        if (singleMath) {
            output.push(`<pre class="reader-math" data-reader-unit><code>${escapeHtml(singleMath[1].trim())}</code></pre>`);
            continue;
        }
        if (/^(?:[-*_]\s*){3,}$/u.test(info.content)) {
            output.push('<div class="reader-unit horizontal-rule" data-reader-unit></div>');
            continue;
        }
        const heading = info.content.match(/^(#{1,6})\s+/u);
        if (heading) {
            output.push(pairedUnit(sourceLine, translatedLineAt(index), mode, 'heading', {
                headingLevel: heading[1].length,
                segmentId: lineSegmentIds.get(index),
            }));
            continue;
        }
        if (info.listIndent > 0) {
            const listMeta = inspectMarkdownListMeta(sourceLine, info.content);
            output.push(pairedUnit(sourceLine, translatedLineAt(index), mode, 'list-item', {
                segmentId: lineSegmentIds.get(index),
                ...listMeta,
            }));
            continue;
        }
        if (info.quoteDepth > 0) {
            const callout = info.content.match(/^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\](?:\s+(.*))?$/iu);
            if (callout) {
                const calloutType = callout[1].toLowerCase();
                const calloutTitle = callout[2]?.trim() || callout[1].toUpperCase();
                const calloutBody: string[] = [];
                let cursor = index + 1;
                while (cursor < sourceLines.length) {
                    const nextQuote = isPureQuoteLine(cursor);
                    if (!nextQuote || nextQuote.quoteDepth < info.quoteDepth) break;
                    calloutBody.push(pairedUnit(
                        nextQuote.content,
                        inspectMarkdownLine(translatedLineAt(cursor)).content,
                        mode,
                        'paragraph',
                        {segmentId: lineSegmentIds.get(cursor)},
                    ));
                    cursor += 1;
                }
                output.push(`<aside class="reader-callout reader-callout-${calloutType}" data-callout="${calloutType}" data-reader-unit><div class="reader-callout-title">${escapeHtml(calloutTitle)}</div>${calloutBody.join('')}</aside>`);
                index = cursor - 1;
                continue;
            }
            const sourceParts = [info.content];
            const translatedParts = [inspectMarkdownLine(translatedLineAt(index)).content];
            const firstSegmentId = lineSegmentIds.get(index);
            let cursor = index + 1;
            while (cursor < sourceLines.length) {
                const nextQuote = isPureQuoteLine(cursor);
                if (!nextQuote || nextQuote.quoteDepth !== info.quoteDepth || /^\[!(?:NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]/iu.test(nextQuote.content)) break;
                sourceParts.push(nextQuote.content);
                translatedParts.push(inspectMarkdownLine(translatedLineAt(cursor)).content);
                cursor += 1;
            }
            const depthAttr = ` data-quote-depth="${Math.min(3, info.quoteDepth)}"${sourceParts.length > 1 ? ' data-multi-segment="true"' : ''}`;
            output.push(pairedUnit(
                sourceParts.join(PREVIEW_SOFT_BREAK),
                translatedParts.join(PREVIEW_SOFT_BREAK),
                mode,
                'quote',
                {segmentId: firstSegmentId, extraAttributes: depthAttr},
            ));
            index = cursor - 1;
            continue;
        }
        output.push(pairedUnit(sourceLine, translatedLineAt(index), mode, 'paragraph', {
            segmentId: lineSegmentIds.get(index),
        }));
    }
    const layoutAttr = options?.bilingualLayout ? ` data-bilingual-layout="${options.bilingualLayout}"` : '';
    return readerShell(`<article class="markdown-article" data-reader-mode="${mode}"${layoutAttr}>${output.join('')}</article>`, options);
}

const TXT_DIVIDER_PATTERN = /^(?:[-=*]\s*){3,}$/u;
const TXT_CHAPTER_HEADING_PATTERN = /^(?:第[一二三四五六七八九十百千万零〇两\d]+[章节回卷节](?:[\s：:、.—\-–].*)?|(?:Chapter|Part|Section)\s+[\dIVXLCDM]+(?:[\s:：.—\-–].*)?)$/iu;

function detectTxtSceneBreaks(document: ParsedDocument): Set<number> {
    const breaks = new Set<number>();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'parts');
    if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value)) return breaks;
    const parts = descriptor.value as ParsedDocument['parts'];
    let seenSegment = false;
    let pendingBreak = false;
    for (const part of parts) {
        if (part.kind === 'literal') {
            if (seenSegment && /(?:\r\n?|\n){3,}/u.test(part.value)) pendingBreak = true;
            continue;
        }
        if (pendingBreak) {
            breaks.add(part.segmentIndex);
            pendingBreak = false;
        }
        seenSegment = true;
    }
    return breaks;
}

function renderTextPreview(
    document: ParsedDocument,
    translatedBlocks: readonly string[],
    mode: DocumentPreviewMode,
    options?: DocumentPreviewOptions,
): string {
    const sceneBreaks = detectTxtSceneBreaks(document);
    const body = document.segments.map((segment, index) => {
        const prefix = sceneBreaks.has(segment.id)
            ? '<div class="reader-unit scene-break" data-reader-unit aria-hidden="true"></div>'
            : '';
        const source = segment.source;
        if (TXT_DIVIDER_PATTERN.test(source.trim())) {
            return `${prefix}<div class="reader-unit horizontal-rule" data-reader-unit data-segment-id="${segment.id}"></div>`;
        }
        const isHeading = source.length <= 120
            && !source.includes('\n')
            && !source.includes(PREVIEW_SOFT_BREAK)
            && TXT_CHAPTER_HEADING_PATTERN.test(source.trim());
        const translation = mode === 'source' ? '' : translatedBlocks[index] || source;
        return prefix + pairedUnit(source, translation, mode, isHeading ? 'heading' : 'paragraph', {
            headingLevel: 2,
            headingClass: isHeading ? 'reader-heading' : '',
            segmentId: segment.id,
            plainText: true,
        });
    }).join('');
    const layoutAttr = options?.bilingualLayout ? ` data-bilingual-layout="${options.bilingualLayout}"` : '';
    return readerShell(`<article class="text-article" data-reader-mode="${mode}"${layoutAttr}>${body}</article>`, options);
}

function annotateHtmlBilingualSegments(html: string, document: ParsedDocument, translations: readonly string[]): string {
    const translatedIds: number[] = [];
    for (const part of document.parts) {
        if (part.kind === 'segment' && hasDistinctTranslation(part.source, translations[part.segmentIndex])) {
            translatedIds.push(part.segmentIndex);
        }
    }
    let cursor = 0;
    return html.replace(/<span data-fluent-read-document-translation="true">/gu, (match) => {
        const id = translatedIds[cursor++];
        return id !== undefined
            ? `<span data-fluent-read-document-translation="true" data-segment-id="${id}">`
            : match;
    });
}

export function createDocumentPreviewHtml(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentPreviewMode,
    options?: DocumentPreviewOptions,
): string {
    const previewTranslations = mode !== 'source' && ['markdown', 'txt'].includes(document.format)
        ? Array.from({length: document.segments.length}, (_, index) => {
            const translation = translations[index];
            return translation === undefined
                ? document.segments[index].source
                : translation.replace(/\r\n?|\n/gu, PREVIEW_SOFT_BREAK);
        })
        : translations;
    if (document.format === 'html') {
        const rendered = renderDocument(document, mode === 'source' ? [] : translations, mode === 'source' ? 'translated' : mode);
        const annotated = mode === 'bilingual' ? annotateHtmlBilingualSegments(rendered, document, translations) : rendered;
        return readerShell(annotated, options, true);
    }
    if (document.format === 'markdown') {
        const source = renderDocument(document, [], 'translated');
        const translated = mode === 'source' ? source : renderDocument(document, previewTranslations, 'translated');
        return renderMarkdownPreview(document, source, translated, previewTranslations, mode, options);
    }
    if (document.format === 'txt') {
        return renderTextPreview(document, previewTranslations, mode, options);
    }
    throw new Error(`不支持为 ${document.format} 生成富文档预览`);
}
