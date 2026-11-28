/**
 * @file src/features/document-translation/core/document.ts
 * 文件职责：作为文档翻译核心领域模型的统一入口，提供格式识别、MIME 与大小上限元数据、多格式文本解析分发（含 LaTeX `.tex`）及双语/纯译文无损渲染，并承载 PDF/EPUB/DOCX/PPTX/XLSX 二进制文档的类型契约。
 * 主要内容：聚合导出核心数据结构与辅助方法，协调 Markdown/TXT、HTML、LaTeX、字幕、JSON 与 CSV/TSV 格式解析子模块，并实现按列筛选、有界长度渲染与下载文件命名。
 * 模块边界：该文件不读取 File、不解析 PDF/EPUB/DOCX/PPTX/XLSX 二进制，也不发起翻译请求；具体格式解析下沉至 ./formats/* 与 ./latex 子模块，文件 I/O 归 services/binary。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {escapeMarkdownTableTranslation} from './markdownTable';
import {encodeDelimitedCell, isSpreadsheetFormula} from './delimited';
import {parseLatexDocument, renderLatexTranslation, sanitizeLatexCommandText} from './latex';
import {
    DOCUMENT_MAX_BYTES,
    PDF_MAX_BYTES,
    PPTX_MAX_BYTES,
    SUPPORTED_DOCUMENT_EXTENSIONS,
    type BinaryDocumentData,
    type DocumentFormat,
    type DocumentHtmlOutput,
    type DocumentPart,
    type DocumentRenderMode,
    type DocumentSegment,
    type DocxDocumentPart,
    type EpubDocumentChapter,
    type JsonSegmentEntry,
    type MarkdownCodeBlock,
    type ParseDocumentOptions,
    type ParsedDocument,
    type PdfDocumentBlock,
    type PdfDocumentLine,
    type PdfDocumentPage,
    type PdfDocumentRun,
    type PdfPreservedRegion,
    type PptxDocumentPart,
    type SegmentPart,
    type XlsxDocumentSheet,
    type XlsxSheetSegment,
} from './formats/shared';
import {
    inspectMarkdownLine,
    parseTextDocument,
    renderMarkdownTranslation,
    unwrapDocumentSoftLines,
} from './formats/markdown';
import {parseHtmlDocument, renderHtmlTranslation} from './formats/html';
import {
    formatSubtitleExport,
    parseAssDocument,
    parseLrcDocument,
    parseTimedSubtitleDocument,
    restoreSubtitleTags,
} from './formats/subtitle';
import {
    cloneJsonValue,
    formatJsonPath,
    getAtPath,
    parseDelimitedDocument,
    parseJsonDocument,
    setAtPath,
} from './formats/jsonAndDelimited';

export type {DelimitedColumn} from './delimited';
export {
    DOCUMENT_MAX_BYTES,
    PDF_MAX_BYTES,
    PPTX_MAX_BYTES,
    SUPPORTED_DOCUMENT_EXTENSIONS,
    formatJsonPath,
    inspectMarkdownLine,
    restoreSubtitleTags,
    unwrapDocumentSoftLines,
    type BinaryDocumentData,
    type DocumentFormat,
    type DocumentRenderMode,
    type DocumentSegment,
    type DocxDocumentPart,
    type EpubDocumentChapter,
    type JsonSegmentEntry,
    type MarkdownCodeBlock,
    type ParseDocumentOptions,
    type ParsedDocument,
    type PdfDocumentBlock,
    type PdfDocumentLine,
    type PdfDocumentPage,
    type PdfDocumentRun,
    type PdfPreservedRegion,
    type PptxDocumentPart,
    type XlsxDocumentSheet,
    type XlsxSheetSegment,
};

/** 列号取自源文件，非法或过期的存储项不会影响其它格式，也不会留下空选择。 */
export function normalizeDelimitedColumns(document: ParsedDocument, input: unknown): number[] | undefined {
    if (!document.delimitedColumns || !Array.isArray(input)) return undefined;
    const requested = new Set(input);
    const selected = document.delimitedColumns.filter(column => requested.has(column.index)).map(column => column.index);
    return selected.length && selected.length !== document.delimitedColumns.length ? selected : undefined;
}

export function documentSegmentsInColumns(document: ParsedDocument, columns?: readonly number[]): readonly DocumentSegment[] {
    if (!document.delimitedColumns || !columns) return document.segments;
    const selected = new Set(columns);
    return document.segments.filter(segment => selected.has(segment.delimitedCell!.column));
}

export function documentTranslationsInColumns(document: ParsedDocument, translations: readonly string[], columns?: readonly number[]): readonly string[] {
    if (!document.delimitedColumns || !columns) return translations;
    const selected = new Set(columns);
    return document.segments.map(segment => selected.has(segment.delimitedCell!.column) ? translations[segment.id] ?? '' : '');
}

const FORMAT_LABELS: Record<DocumentFormat, string> = {
    pdf: 'PDF 文件',
    epub: 'ePub 电子书',
    docx: 'DOCX 文档',
    pptx: 'PPTX 演示文稿',
    xlsx: 'XLSX 电子表格',
    html: 'HTML 文件',
    txt: 'TXT 文件',
    markdown: 'Markdown 文件',
    tex: 'LaTeX 文档',
    srt: 'SRT 字幕',
    vtt: 'VTT 字幕',
    ass: 'ASS 字幕',
    lrc: 'LRC 歌词',
    json: 'JSON 文件',
    csv: 'CSV',
    tsv: 'TSV',
};

function extensionOf(fileName: string): string {
    const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/u);
    return match?.[1] || '';
}

export function getDocumentFormat(fileName: string): DocumentFormat | null {
    const extension = extensionOf(fileName);
    if (extension === 'pdf') return 'pdf';
    if (extension === 'epub') return 'epub';
    if (extension === 'docx') return 'docx';
    if (extension === 'pptx') return 'pptx';
    if (extension === 'xlsx') return 'xlsx';
    if (extension === 'html' || extension === 'htm') return 'html';
    if (extension === 'txt') return 'txt';
    if (extension === 'md' || extension === 'markdown') return 'markdown';
    if (extension === 'tex') return 'tex';
    if (extension === 'srt') return 'srt';
    if (extension === 'vtt') return 'vtt';
    if (extension === 'ass' || extension === 'ssa') return 'ass';
    if (extension === 'lrc') return 'lrc';
    if (extension === 'json') return 'json';
    if (extension === 'csv' || extension === 'tsv') return extension;
    return null;
}

/** 一个文件允许的最大字节数：PDF 与 PPTX 使用更宽的上限，其余格式沿用通用上限。 */
export function getDocumentMaxBytes(fileName: string): number {
    const format = getDocumentFormat(fileName);
    if (format === 'pdf') return PDF_MAX_BYTES;
    if (format === 'pptx') return PPTX_MAX_BYTES;
    return DOCUMENT_MAX_BYTES;
}

export function getDocumentAcceptAttribute(): string {
    return SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');
}

export function getDocumentFormatLabel(format: DocumentFormat): string {
    return FORMAT_LABELS[format];
}

export function getDocxPartLabel(path: string): string {
    if (path === 'word/document.xml') return '正文';
    if (/header/iu.test(path)) return '页眉';
    if (/footer/iu.test(path)) return '页脚';
    if (/footnotes/iu.test(path)) return '脚注';
    if (/endnotes/iu.test(path)) return '尾注';
    return '文档内容';
}

export function getDocumentMimeType(format: DocumentFormat): string {
    if (format === 'pdf') return 'application/pdf';
    if (format === 'epub') return 'application/epub+zip';
    if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (format === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (format === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (format === 'html') return 'text/html;charset=utf-8';
    if (format === 'json') return 'application/json;charset=utf-8';
    if (format === 'csv') return 'text/csv;charset=utf-8';
    if (format === 'tsv') return 'text/tab-separated-values;charset=utf-8';
    if (format === 'tex') return 'application/x-tex;charset=utf-8';
    return 'text/plain;charset=utf-8';
}

export function parseDocument(fileName: string, content: string, options: ParseDocumentOptions = {}): ParsedDocument {
    const format = getDocumentFormat(fileName);
    if (!format) {
        throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件');
    }
    if (format === 'pdf' || format === 'epub' || format === 'docx' || format === 'pptx' || format === 'xlsx') {
        throw new Error(`${getDocumentFormatLabel(format)}需要按二进制文件解析，请重新打开该文件`);
    }

    if (format === 'json') {
        return {
            fileName,
            format,
            label: getDocumentFormatLabel(format),
            parts: [],
            ...parseJsonDocument(content),
        };
    }
    if (format === 'csv' || format === 'tsv') {
        return {fileName, format, label: getDocumentFormatLabel(format), ...parseDelimitedDocument(content, format === 'csv' ? ',' : '\t')};
    }
    if (format === 'tex') {
        return {fileName, format, label: getDocumentFormatLabel(format), ...parseLatexDocument(content)};
    }

    const parsed = format === 'html'
        ? parseHtmlDocument(content)
        : format === 'txt' || format === 'markdown'
            ? parseTextDocument(content, format, Boolean(options.markdownSentences))
            : format === 'ass'
                ? parseAssDocument(content)
                : format === 'lrc'
                    ? parseLrcDocument(content)
                    : parseTimedSubtitleDocument(content, format);

    return {fileName, format, label: getDocumentFormatLabel(format), ...parsed};
}

function originalPartSource(part: SegmentPart): string {
    return part.rawSource ?? part.source;
}

/**
 * 整句送翻的片段，原文里的行内标签和 Markdown 语法已换成编号占位符；这里给出这些片段未替换前的原文，
 * 供校订视图显示读者认得出的文字。没有占位符的片段不在结果里。
 */
export function documentSegmentMarkupSources(document: ParsedDocument): Map<number, string> {
    const sources = new Map<number, string>();
    for (const part of document.parts) {
        if (part.kind === 'segment' && (part.htmlTags || part.markdownTokens || part.latexTokens)) sources.set(part.segmentIndex, originalPartSource(part));
    }
    return sources;
}

/** 字幕样式标记不属于可见正文，服务省略标记时仍按相同文字处理。 */
function hasDistinctPartTranslation(document: ParsedDocument, source: string, translation: string): boolean {
    if (['srt', 'vtt', 'ass'].includes(document.format)) {
        const text = (value: string) => value.replace(/<[^>]+>/gu, '').replace(/\{\\[^}]+\}/gu, '');
        return hasDistinctTranslation(text(source), text(translation));
    }
    return hasDistinctTranslation(source, translation);
}

/** 空白、相同结果与尚未翻译均保留原文，避免部分导出吞字或重复显示。 */
export function resolveDocumentTranslation(source: string, translation: string | undefined): string {
    return hasDistinctTranslation(source, translation) ? translation! : source;
}

function formatBilingualTranslation(document: ParsedDocument, part: SegmentPart, translation: string, xhtml: DocumentHtmlOutput): string {
    const source = originalPartSource(part);
    const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
        ? formatSubtitleExport(document.format, part.source, translation)
        : translation;
    if (document.format === 'html') {
        const marker = xhtml === 'epub2' ? 'class="fluentread-document-translation"' : 'data-fluent-read-document-translation="true"';
        return `${part.prefix}${source}${part.suffix}${xhtml ? '<br/>' : '<br>'}<span ${marker}>${renderHtmlTranslation(part, translation)}</span>`;
    }
    if (document.format === 'markdown') {
        return `${part.prefix}${source}${part.suffix}\n> ${renderMarkdownTranslation(part, translation)}`;
    }
    if (document.format === 'tex') {
        const rendered = renderLatexTranslation(part.latexTokens, translation);
        if (part.latexBilingual === 'command') {
            const safeSource = sanitizeLatexCommandText(source).replace(/\n+$/u, '');
            const safeRendered = sanitizeLatexCommandText(rendered).replace(/^\n+/u, '');
            return `${part.prefix}${safeSource}\n${safeRendered}${part.suffix}`;
        }
        return `${part.prefix}${source}\n\n${rendered}${part.suffix}`;
    }
    if (document.format === 'ass') {
        return `${part.prefix}${source}${part.suffix}\\N${formattedTranslation}`;
    }
    if (part.bilingualPrefix) {
        return `${part.prefix}${source}${part.suffix}\n${part.bilingualPrefix}${formattedTranslation}`;
    }
    return `${part.prefix}${source}${part.suffix}\n${formattedTranslation}`;
}

function renderParts(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode, maxLength: number, xhtml: DocumentHtmlOutput): string {
    const output: string[] = [];
    let length = 0;
    const append = (value: string) => {
        const text = value.slice(0, maxLength - length);
        output.push(text);
        length += text.length;
    };
    for (let index = 0; index < document.parts.length && length < maxLength; index += 1) {
        const part = document.parts[index];
        if (mode === 'bilingual' && document.format === 'markdown' && part.bilingualGroup !== undefined) {
            // 行内链接或代码会被切成多个 part；双语模式按源行重组，避免把一行引用拆成多段。
            const group = part.bilingualGroup;
            const groupParts: DocumentPart[] = [];
            let hasSegment = false;
            while (index < document.parts.length && document.parts[index].bilingualGroup === group) {
                if (document.parts[index].kind === 'segment') hasSegment = true;
                groupParts.push(document.parts[index]);
                index += 1;
            }
            index -= 1;
            // 有界摘录先逐片写原文，达到上限后不再构造整行或读取无用译文。
            for (const entry of groupParts) {
                append(entry.kind === 'literal' ? entry.value : `${entry.prefix}${originalPartSource(entry)}${entry.suffix}`);
                if (length >= maxLength) break;
            }
            if (length >= maxLength) break;
            if (!hasSegment || !groupParts.some(entry => entry.kind === 'segment' &&
                hasDistinctTranslation(entry.source, translations[entry.segmentIndex]))) continue;
            append('\n> ');
            let trailingCR = false;
            for (const entry of groupParts) {
                if (length >= maxLength) break;
                const text = entry.kind === 'literal' ? entry.value
                    : `${entry.prefix}${hasDistinctTranslation(entry.source, translations[entry.segmentIndex]) ? renderMarkdownTranslation(entry, translations[entry.segmentIndex]) : originalPartSource(entry)}${entry.suffix}`;
                if (!text) continue;
                const value = trailingCR && text.startsWith('\n') ? text.slice(1) : text;
                trailingCR = text.endsWith('\r');
                append(value.slice(0, maxLength - length).replace(/\r\n?|\n/gu, '\n> '));
            }
            continue;
        }
        if (part.kind === 'literal') {
            append(part.value);
            continue;
        }
        const translation = resolveDocumentTranslation(part.source, translations[part.segmentIndex]);
        if (part.delimitedCell) {
            if (!hasDistinctTranslation(part.source, translation) || isSpreadsheetFormula(translation)) append(part.rawSource!);
            else {
                const value = mode === 'bilingual' ? `${part.source}\n${translation}` : translation;
                append(encodeDelimitedCell(`${part.prefix}${value}${part.suffix}`, part.delimitedCell.delimiter, part.delimitedCell.quoted));
            }
            continue;
        }
        if (!hasDistinctPartTranslation(document, part.source, translation)) {
            append(`${part.prefix}${originalPartSource(part)}${part.suffix}`);
            continue;
        }
        if (part.markdownTableCell) {
            const cell = escapeMarkdownTableTranslation(renderMarkdownTranslation(part, translation));
            const value = mode === 'bilingual' ? `${originalPartSource(part)}<br>${cell}`
                : part.markdownTableCell === 'withoutLeadingPipe' ? `| ${cell}` : cell;
            append(`${part.prefix}${value}${part.suffix}`);
            continue;
        }
        if (mode === 'bilingual') {
            append(formatBilingualTranslation(document, part, translation, xhtml));
            continue;
        }
        if (document.format === 'html') {
            append(`${part.prefix}${renderHtmlTranslation(part, translation)}${part.suffix}`);
            continue;
        }
        if (document.format === 'tex') {
            const rendered = renderLatexTranslation(part.latexTokens, translation);
            const safeRendered = part.latexBilingual === 'command' ? sanitizeLatexCommandText(rendered) : rendered;
            append(`${part.prefix}${safeRendered}${part.suffix}`);
            continue;
        }
        const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
            ? formatSubtitleExport(document.format, part.source, translation)
            : renderMarkdownTranslation(part, translation);
        append(`${part.prefix}${formattedTranslation}${part.suffix}`);
    }
    return output.join('');
}

export function renderDocument(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode = 'bilingual',
    maxLength = Infinity,
    options: {xhtml?: DocumentHtmlOutput} = {},
): string {
    maxLength = Number.isNaN(maxLength) ? 0 : Math.max(0, Math.trunc(maxLength));
    if (maxLength === 0) return '';
    if (document.format !== 'json') return renderParts(document, translations, mode, maxLength, options.xhtml ?? false);

    let output = cloneJsonValue(document.jsonValue);
    document.jsonEntries?.forEach((entry) => {
        const original = getAtPath(output, entry.path);
        if (typeof original !== 'string') return;
        const translation = resolveDocumentTranslation(original.trim(), translations[entry.segmentIndex]);
        if (!hasDistinctTranslation(original, translation)) return;
        const value = mode === 'bilingual'
            ? `${entry.prefix}${original.trim()}\n${translation}${entry.suffix}`
            : `${entry.prefix}${translation}${entry.suffix}`;
        output = setAtPath(output, entry.path, value);
    });
    return JSON.stringify(output, null, 2).slice(0, maxLength);
}

export function createDocumentDownloadName(fileName: string, mode: DocumentRenderMode): string {
    const suffix = mode === 'bilingual' ? '.bilingual' : '.translated';
    // 正则始终匹配完整字符串；用非空断言表达该不变量，避免把不可达分支伪装成容错。
    const match = fileName.match(/^([\s\S]*?)(\.[^.]+)?$/u)!;
    return `${match[1] || fileName}${suffix}${match[2] || ''}`;
}
