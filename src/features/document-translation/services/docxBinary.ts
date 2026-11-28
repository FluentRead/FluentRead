/**
 * @file src/features/document-translation/services/docxBinary.ts
 * 文件职责：负责 Word DOCX 文档压缩包的受限解析、段落与表格单元格定位、行内样式译文回填及双语文档流式打包。
 * 主要内容：解析正文/页眉/页脚/脚注 XML 段落并识别角色与表格位置，导出时协调 core/docxInline 保留链接与字符样式或追加双语段落，并维持原有未改资源压缩方式。
 * 模块边界：仅承担 DOCX 二进制文档解析与导出，行内标记解析委托 core/docxInline，压缩包安全校验复用 binaryShared。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {stripDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import type JSZip from 'jszip';
import {generateDocumentArchive, preserveStoredDocumentEntries} from './archive';
import {
    getDocumentFormatLabel,
    getDocxPartLabel as docxPartTitle,
    getDocumentMimeType,
    type DocxDocumentPart,
    type DocumentRenderMode,
    type DocumentSegment,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';
import {
    assertArchiveSafety,
    awaitDocumentRead,
    readArchiveText,
    xmlDecode,
    xmlEscape,
    yieldDocumentTask,
    type CreateDocumentDownloadOptions,
} from './binaryShared';

export {docxPartTitle};

const DOCX_PARAGRAPH_PATTERN = /<w:p(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/w:p\s*>)/gu;
const DOCX_TEXT_TOKEN_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/gu;
const DOCX_TRANSLATED_PROPERTIES = '<w:rPr><w:color w:val="E83B6B"/></w:rPr>';
const DOCX_TRANSLATED_PARAGRAPH = '<w:p><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr>';

/**
 * 按文档顺序回答“这个位置在哪个表格的第几行第几格”。位置必须递增地询问；嵌套表格里的段落归到外层表格的那一格。
 */
function docxTableLocator(source: string): (position: number) => {table: number; row: number; cell: number} | undefined {
    const tags = /<w:(tbl|tr|tc)(?=[\s>/])|<\/w:tbl>/gu;
    let next = tags.exec(source), depth = 0, table = -1, row = -1, cell = -1;
    return position => {
        for (; next && next.index < position; next = tags.exec(source)) {
            if (!next[1]) depth = Math.max(0, depth - 1);
            else if (next[1] === 'tbl') {
                depth += 1;
                if (depth === 1) {table += 1; row = -1;}
            } else if (depth === 1) {
                if (next[1] === 'tr') {row += 1; cell = -1;} else cell += 1;
            }
        }
        return depth > 0 ? {table, row, cell} : undefined;
    };
}

export function docxParagraphText(paragraph: string): string {
    const tokens: string[] = [];
    DOCX_TEXT_TOKEN_PATTERN.lastIndex = 0;
    let match = DOCX_TEXT_TOKEN_PATTERN.exec(paragraph);
    while (match) {
        if (match[1] !== undefined) tokens.push(xmlDecode(match[1]));
        else if (/w:tab/iu.test(match[0])) tokens.push('\t');
        else tokens.push('\n');
        match = DOCX_TEXT_TOKEN_PATTERN.exec(paragraph);
    }
    return tokens.join('').replace(/\u0000/gu, '').trim();
}

export function docxParagraphRole(paragraph: string, path: string): NonNullable<DocumentSegment['role']> {
    if (/header/iu.test(path)) return 'header';
    if (/footer/iu.test(path)) return 'footer';
    if (/(?:footnotes|endnotes)/iu.test(path)) return 'note';
    const style = paragraph.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/iu)?.[1] || '';
    if (/title/iu.test(style)) return 'title';
    if (/heading|标题/iu.test(style)) return 'heading';
    if (/<w:numPr\b/iu.test(paragraph)) return 'list-item';
    return 'paragraph';
}

export async function parseDocx(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await awaitDocumentRead(JSZip.loadAsync(bytes), signal);
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`DOCX 解析失败：${String(error)}`);
    }
    signal?.throwIfAborted();
    assertArchiveSafety(zip, 'DOCX');
    if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
        throw new Error('DOCX 文件结构无效，文件可能已损坏或扩展名不正确');
    }
    const {analyzeDocxInlineParagraph} = await import('../core/docxInline');

    const partPaths = Object.keys(zip.files)
        .filter((path) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(path))
        .sort((left, right) => {
            const rank = (path: string) => path === 'word/document.xml'
                ? 0
                : /header/iu.test(path)
                    ? 1
                    : /footer/iu.test(path)
                        ? 2
                        : /footnotes/iu.test(path)
                            ? 3
                            : 4;
            if (rank(left) !== rank(right)) return rank(left) - rank(right);
            return left.localeCompare(right);
        });
    const segments: DocumentSegment[] = [];
    const parts: DocxDocumentPart[] = [];

    for (const path of partPaths) {
        const source = await readArchiveText(zip.file(path)!, signal);
        const paragraphSegments: DocxDocumentPart['paragraphSegments'] = [];
        const tableAt = docxTableLocator(source);
        let paragraphIndex = 0;
        let partSegmentIndex = 0;
        DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
        let paragraphMatch = DOCX_PARAGRAPH_PATTERN.exec(source);
        while (paragraphMatch) {
            const inline = analyzeDocxInlineParagraph(paragraphMatch[0]);
            const text = inline.kind === 'free' ? inline.source : docxParagraphText(paragraphMatch[0]);
            if (text) {
                const segmentIndex = segments.length;
                segments.push({
                    id: segmentIndex,
                    source: text,
                    contextLabel: partSegmentIndex === 0 ? docxPartTitle(path) : undefined,
                    pathLabel: docxPartTitle(path),
                    role: docxParagraphRole(paragraphMatch[0], path),
                    ...(inline.kind === 'free' && inline.spans.length ? {docxInline: true as const} : {}),
                });
                const table = tableAt(paragraphMatch.index);
                paragraphSegments.push({paragraphIndex, segmentIndex, ...(table ? {table} : {})});
                partSegmentIndex += 1;
            }
            paragraphIndex += 1;
            paragraphMatch = DOCX_PARAGRAPH_PATTERN.exec(source);
        }
        if (paragraphSegments.length > 0) parts.push({path, source, paragraphSegments});
    }

    if (segments.length === 0) throw new Error('DOCX 中没有找到可翻译的段落文字');
    return {
        fileName,
        format: 'docx',
        label: getDocumentFormatLabel('docx'),
        parts: [],
        segments,
        binary: {kind: 'docx', bytes, parts, inlineFormatting: true},
    };
}

export function docxTextNodes(value: string): string {
    const tokens = value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '').replace(/\r\n?/gu, '\n').split(/(\n|\t)/u);
    const content = tokens.map((token) => {
        if (token === '\n') return '<w:br/>';
        if (token === '\t') return '<w:tab/>';
        return token ? `<w:t xml:space="preserve">${xmlEscape(token)}</w:t>` : '';
    }).join('');
    return content || '<w:t></w:t>';
}

export async function renderDocxPart(
    document: ParsedDocument,
    part: DocxDocumentPart,
    translations: readonly string[],
    mode: DocumentRenderMode,
): Promise<string> {
    const {analyzeDocxInlineParagraph, renderDocxInlineRuns} = await import('../core/docxInline');
    const segmentByParagraph = new Map(part.paragraphSegments.map((entry) => [entry.paragraphIndex, entry.segmentIndex]));
    let paragraphIndex = 0;
    DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
    return part.source.replace(DOCX_PARAGRAPH_PATTERN, (paragraph) => {
        const segmentIndex = segmentByParagraph.get(paragraphIndex);
        paragraphIndex += 1;
        if (segmentIndex === undefined) return paragraph;
        const segment = document.segments[segmentIndex];
        const translation = translations[segmentIndex] ?? '';
        if (!segment || !hasDistinctTranslation(segment.source, translation)) return paragraph;
        const inline = analyzeDocxInlineParagraph(paragraph);
        if (inline.kind === 'invalid') return paragraph;
        const isBilingual = mode === 'bilingual';
        if (inline.kind === 'free') {
            const runs = renderDocxInlineRuns(inline, translation, docxTextNodes, isBilingual ? DOCX_TRANSLATED_PROPERTIES : '');
            if (runs !== undefined) return isBilingual
                ? `${paragraph}${DOCX_TRANSLATED_PARAGRAPH}${runs}</w:p>`
                : `${inline.prefix}${runs}</w:p>`;
        }
        const plain = inline.kind === 'free' ? stripDocumentInlineMarkers(translation) : translation;
        return hasDistinctTranslation(inline.kind === 'free' ? stripDocumentInlineMarkers(inline.source) : segment.source, plain)
            ? `${paragraph}${DOCX_TRANSLATED_PARAGRAPH}<w:r>${DOCX_TRANSLATED_PROPERTIES}${docxTextNodes(plain)}</w:r></w:p>`
            : paragraph;
    });
}

export async function renderDocx(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    if (document.binary?.kind !== 'docx') throw new Error('DOCX 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    options.signal?.throwIfAborted();
    const zip = await awaitDocumentRead(JSZip.loadAsync(document.binary.bytes), options.signal);
    options.signal?.throwIfAborted();
    assertArchiveSafety(zip, 'DOCX');
    preserveStoredDocumentEntries(zip, document.binary.bytes, new Set(document.binary.parts.map(part => part.path)));
    for (const part of document.binary.parts) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        zip.file(part.path, await renderDocxPart(document, part, translations, mode), {createFolders: false});
    }
    return generateDocumentArchive(zip, {
        mimeType: getDocumentMimeType('docx'),
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
}
