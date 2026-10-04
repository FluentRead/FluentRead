/**
 * @file src/features/document-translation/core/preview.ts
 * 文件职责：把已解析文档与对应译文转换成安全、可阅读的预览 HTML，统一支持原文、双语和纯译文三种预览模式。
 * 主要内容：包含主动 HTML 剥离、阅读器外壳、行内 Markdown 渲染、标题/列表/引用标记处理、原译配对单元，以及针对 Markdown、HTML、字幕、JSON 和普通文本的预览分派，按所需格式生成内容，避免构建未使用的整份导出字符串。
 * 模块边界：本模块只生成展示字符串，不操作真实 DOM、不执行脚本也不修改文档模型；源文件解析由 document.ts 完成，二进制分页预览由 pdfPreview.ts 负责，页面样式由上层 UI 提供。
 */
import {
    renderDocument,
    type DocumentRenderMode,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';

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

function readerShell(content: string): string {
    const security = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${PREVIEW_STYLE}</style>`;
    const safeContent = stripActiveHtml(content);
    if (/<html\b/iu.test(safeContent)) {
        if (/<head\b[^>]*>/iu.test(safeContent)) {
            return safeContent.replace(/<head\b[^>]*>/iu, (head) => `${head}${security}`);
        }
        return safeContent.replace(/<html\b[^>]*>/iu, (html) => `${html}<head>${security}</head>`);
    }
    return `<!doctype html><html><head>${security}</head><body><main>${safeContent}</main></body></html>`;
}

function inlineMarkdown(value: string): string {
    const tokens: string[] = [];
    const token = (html: string) => {
        const index = tokens.push(html) - 1;
        return `\u0000${index}\u0000`;
    };
    let working = value.replace(new RegExp(PREVIEW_SOFT_BREAK, 'gu'), () => token('<br>'));
    working = working.replace(/`([^`\n]+)`/gu, (_, code: string) => token(`<code>${escapeHtml(code)}</code>`));
    working = working.replace(/!\[([^\]]*)\]\([^)]+\)/gu, (_, alt: string) => token(`<span class="reader-link">${escapeHtml(alt || '图片')}</span>`));
    working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|#[^)]+)\)/gu, (_, label: string) => token(`<span class="reader-link">${escapeHtml(label)}</span>`));
    working = escapeHtml(working)
        .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
        .replace(/__([^_]+)__/gu, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '<em>$1</em>');
    return working.replace(/\u0000(\d+)\u0000/gu, (_, index: string) => tokens[Number(index)]!);
}

function removeMarkdownMarker(value: string, kind: 'heading' | 'list-item' | 'quote' | 'paragraph'): string {
    if (kind === 'heading') return value.replace(/^\s{0,3}#{1,6}\s*/u, '');
    if (kind === 'list-item') return value.replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, '');
    if (kind === 'quote') return value.replace(/^\s*>\s?/u, '');
    return value;
}

function pairedUnit(
    source: string,
    translation: string,
    mode: DocumentPreviewMode,
    kind: 'heading' | 'list-item' | 'quote' | 'paragraph',
    headingLevel = 2,
): string {
    const sourceText = inlineMarkdown(removeMarkdownMarker(source, kind));
    const translatedText = inlineMarkdown(removeMarkdownMarker(translation, kind));
    const tag = kind === 'heading' ? `h${headingLevel}` : kind === 'quote' ? 'blockquote' : 'p';
    const sourceNode = `<${tag} class="reader-source">${sourceText}</${tag}>`;
    const translatedNode = `<${tag} class="reader-translation fluentread-translation">${translatedText}</${tag}>`;
    const body = mode === 'source' ? sourceNode : mode === 'translated' ? translatedNode : `${sourceNode}${translatedNode}`;
    return `<section class="reader-unit ${kind}" data-reader-unit>${body}</section>`;
}

function renderMarkdownPreview(source: string, translated: string, mode: DocumentPreviewMode): string {
    const sourceLines = source.replace(/\r\n?/gu, '\n').split('\n');
    const translatedLines = translated.replace(/\r\n?/gu, '\n').split('\n');
    const output: string[] = [];
    let fence = '';
    let codeLines: string[] = [];

    const flushCode = () => {
        if (codeLines.length === 0) return;
        output.push(`<pre data-reader-unit><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
    };

    sourceLines.forEach((sourceLine, index) => {
        const fenceMatch = sourceLine.match(/^\s*(`{3,}|~{3,})/u)?.[1] || '';
        if (fence) {
            if (fenceMatch && fenceMatch[0] === fence[0] && fenceMatch.length >= fence.length) {
                flushCode();
                fence = '';
            } else {
                codeLines.push(sourceLine);
            }
            return;
        }
        if (fenceMatch) {
            fence = fenceMatch;
            return;
        }
        if (!sourceLine.trim()) return;
        if (/^\s*(?:[-*_]\s*){3,}$/u.test(sourceLine)) {
            output.push('<div class="reader-unit horizontal-rule" data-reader-unit></div>');
            return;
        }
        const heading = sourceLine.match(/^\s{0,3}(#{1,6})\s+/u);
        const kind = heading
            ? 'heading'
            : /^\s*(?:[-+*]|\d+[.)])\s+/u.test(sourceLine)
                ? 'list-item'
                : /^\s*>\s?/u.test(sourceLine)
                    ? 'quote'
                    : 'paragraph';
        output.push(pairedUnit(sourceLine, translatedLines[index] || sourceLine, mode, kind, heading?.[1].length || 2));
    });
    flushCode();
    return readerShell(`<article class="markdown-article">${output.join('')}</article>`);
}

function renderTextPreview(
    sourceBlocks: readonly string[],
    translatedBlocks: readonly string[],
    mode: DocumentPreviewMode,
): string {
    const body = sourceBlocks.map((sourceBlock, index) => pairedUnit(
        sourceBlock,
        translatedBlocks[index]!,
        mode,
        'paragraph',
    )).join('');
    return readerShell(`<article class="text-article">${body}</article>`);
}

export function createDocumentPreviewHtml(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentPreviewMode,
): string {
    const previewTranslations = ['markdown', 'txt'].includes(document.format)
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
        return renderMarkdownPreview(source, translated, mode);
    }
    if (document.format === 'txt') {
        return renderTextPreview(
            document.segments.map((segment) => segment.source),
            previewTranslations,
            mode,
        );
    }
    throw new Error(`不支持为 ${document.format} 生成富文档预览`);
}
