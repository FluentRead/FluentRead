/**
 * @file src/features/document-translation/services/binary.ts
 * 文件职责：处理 PDF、EPUB 与 DOCX 二进制文档的受限解析和导出，把压缩包或页面文本转换为统一 ParsedDocument，并生成可下载的双语产物。
 * 主要内容：按需加载二进制依赖，包含归档安全上限、文本提取与译文回填；PDF 导出逐页压缩释放解码像素，支持进度回调和取消。
 * 模块边界：此服务可以依赖 JSZip、pdf-lib 和二进制 I/O，但不负责调用翻译服务或渲染设置页；文本格式规则归 core/document，浏览器 Canvas 光栅实现由 ui/pdfPreview 通过接口注入。
 */
import type JSZip from 'jszip';
import type {PDFEmbeddedPage} from 'pdf-lib';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import {
    createDocumentDownloadName,
    getDocumentFormat,
    getDocumentFormatLabel,
    getDocumentMimeType,
    parseDocument,
    renderDocument,
    resolveDocumentTranslation,
    type DocxDocumentPart,
    type DocumentFormat,
    type DocumentRenderMode,
    type DocumentSegment,
    type EpubDocumentChapter,
    type ParsedDocument,
    type PdfDocumentBlock,
    type PdfDocumentPage,
} from '@/src/features/document-translation/core/document';

const BINARY_DOCUMENT_FORMATS = new Set<DocumentFormat>(['pdf', 'epub', 'docx']);
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu;
const DOCX_TEXT_TOKEN_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/gu;
const ARCHIVE_ENTRY_LIMIT = 4_000;
const ARCHIVE_ENTRY_BYTES_LIMIT = 24 * 1024 * 1024;
const ARCHIVE_TOTAL_BYTES_LIMIT = 96 * 1024 * 1024;

export interface PdfTextItem {
    str: string;
    dir: string;
    transform: Array<unknown>;
    width: number;
    height: number;
    fontName: string;
    hasEOL: boolean;
}

export interface PdfTextStyle {
    ascent?: number;
    descent?: number;
    fontFamily?: string;
    vertical?: boolean;
}

export interface PdfTextAtom {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontFamily: string;
}

export interface PdfTextLine {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontFamily: string;
}

export interface DocumentFileLike {
    name: string;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DocumentDownload {
    data: string | Uint8Array;
    fileName: string;
    mimeType: string;
}

export interface PdfRasterPageInput {
    pageNumber: number;
    width: number;
    height: number;
    sourceBytes: Uint8Array;
    blocks: PdfDocumentBlock[];
    translations: readonly string[];
    signal?: AbortSignal;
}

export type PdfPageRasterizer = (input: PdfRasterPageInput) => Promise<Uint8Array>;

export interface CreateDocumentDownloadOptions {
    pdfPageRasterizer?: PdfPageRasterizer;
    signal?: AbortSignal;
    onPdfProgress?: (progress: {phase: 'rendering' | 'saving'; completedPages: number; totalPages: number}) => void;
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return new Uint8Array(value.slice(0));
}

export function assertArchiveSafety(zip: JSZip, label: 'ePub' | 'DOCX'): void {
    const entries = Object.values(zip.files);
    if (entries.length > ARCHIVE_ENTRY_LIMIT) {
        throw new Error(`${label} 文件包含过多压缩项，已停止解析`);
    }
    let totalBytes = 0;
    entries.forEach((entry) => {
        const size = Number((entry as typeof entry & {_data?: {uncompressedSize?: number}})._data?.uncompressedSize || 0);
        if (size > ARCHIVE_ENTRY_BYTES_LIMIT) {
            throw new Error(`${label} 文件中的单个内容项过大，已停止解析`);
        }
        totalBytes += size;
    });
    if (totalBytes > ARCHIVE_TOTAL_BYTES_LIMIT) {
        throw new Error(`${label} 文件解压后内容过大，已停止解析`);
    }
}

export function isBinaryDocumentFormat(format: DocumentFormat): boolean {
    return BINARY_DOCUMENT_FORMATS.has(format);
}

export function xmlDecode(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#([0-9]+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&amp;/gu, '&');
}

export function xmlEscape(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}

export function parseXmlAttributes(source: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    let match = pattern.exec(source);
    while (match) {
        attributes[match[1]] = xmlDecode(match[2] ?? match[3]!);
        match = pattern.exec(source);
    }
    return attributes;
}

export function normalizeZipPath(value: string): string {
    const result: string[] = [];
    value.replace(/\\/gu, '/').split('/').forEach((part) => {
        if (!part || part === '.') return;
        if (part === '..') result.pop();
        else result.push(part);
    });
    return result.join('/');
}

export function resolveZipPath(baseFile: string, href: string): string {
    const cleanHref = href.split(/[?#]/u)[0];
    const baseDirectory = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
    const normalized = normalizeZipPath(`${baseDirectory}${cleanHref}`);
    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}

export function median(values: number[]): number {
    if (values.length === 0) return 1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function pdfTextAtoms(
    items: PdfTextItem[],
    styles: Record<string, PdfTextStyle>,
    viewport: {width: number; height: number; transform: number[]},
): PdfTextAtom[] {
    return items.flatMap((item) => {
        const text = item.str.replace(/\u0000/gu, '').replace(/[\t\u00a0 ]+/gu, ' ').trim();
        if (!text) return [];
        // 六元仿射矩阵相乘；坐标处理保持同步，无需为这一纯运算加载整个 PDF.js。
        const a = viewport.transform;
        const b = item.transform as number[];
        const transform = [
            a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
        ];
        const angle = Math.atan2(transform[1], transform[0]);
        if (Math.abs(angle) > 0.12) return [];
        const style = styles[item.fontName] || {};
        const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]) || item.height || 1);
        const ascent = typeof style.ascent === 'number'
            ? style.ascent
            : typeof style.descent === 'number'
                ? 1 + style.descent
                : 0.8;
        const x = transform[4];
        const y = transform[5] - fontHeight * ascent;
        return [{
            text,
            x,
            y,
            width: Math.max(fontHeight * 0.2, Math.abs(item.width || 0)),
            height: fontHeight,
            fontFamily: style.fontFamily || 'sans-serif',
        }];
    }).filter((atom) => atom.x < viewport.width && atom.y < viewport.height && atom.x + atom.width > 0 && atom.y + atom.height > 0);
}

export function pdfTextLines(atoms: PdfTextAtom[], pageWidth: number): PdfTextLine[] {
    const rows: PdfTextAtom[][] = [];
    [...atoms].sort((left, right) => left.y - right.y || left.x - right.x).forEach((atom) => {
        const row = rows.at(-1);
        const rowHeight = row ? Math.max(...row.map((entry) => entry.height)) : 0;
        const rowY = row ? median(row.map((entry) => entry.y)) : 0;
        if (!row || Math.abs(atom.y - rowY) > Math.max(2, rowHeight * 0.42, atom.height * 0.42)) rows.push([atom]);
        else row.push(atom);
    });

    const lines: PdfTextLine[] = [];
    const addLine = (entries: PdfTextAtom[]) => {
        const ordered = [...entries].sort((left, right) => left.x - right.x);
        let text = '';
        let endX: number | undefined;
        ordered.forEach((entry) => {
            const gap = endX === undefined ? 0 : entry.x - endX;
            if (text && gap > Math.max(1.2, entry.height * 0.08)
                && !/[\s\-–—/]$/u.test(text)
                && !/^[,.;:!?，。；：！？)\]}]/u.test(entry.text)) text += ' ';
            text += entry.text;
            endX = Math.max(endX ?? entry.x, entry.x + entry.width);
        });
        const x = Math.min(...ordered.map((entry) => entry.x));
        const y = Math.min(...ordered.map((entry) => entry.y));
        const right = Math.max(...ordered.map((entry) => entry.x + entry.width));
        const bottom = Math.max(...ordered.map((entry) => entry.y + entry.height));
        const dominant = [...ordered].sort((left, rightEntry) => rightEntry.width - left.width)[0];
        const normalized = text.replace(/[\t\u00a0 ]+/gu, ' ').trim();
        if (normalized) lines.push({
            text: normalized,
            x,
            y,
            width: Math.max(1, right - x),
            height: Math.max(1, bottom - y),
            fontFamily: dominant.fontFamily,
        });
    };

    rows.forEach((row) => {
        const ordered = [...row].sort((left, right) => left.x - right.x);
        let group: PdfTextAtom[] = [];
        let endX: number | undefined;
        ordered.forEach((atom) => {
            const gap = endX === undefined ? 0 : atom.x - endX;
            const splitGap = Math.max(atom.height * 3.2, pageWidth * 0.055);
            if (group.length > 0 && gap > splitGap) {
                addLine(group);
                group = [];
            }
            group.push(atom);
            endX = Math.max(endX ?? atom.x, atom.x + atom.width);
        });
        addLine(group);
    });
    return lines.sort((left, right) => left.y - right.y || left.x - right.x);
}

interface PdfTextBlockDraft {
    lines: PdfTextLine[];
}

export function pdfTextBlocks(lines: PdfTextLine[], pageWidth: number): Array<Omit<PdfDocumentBlock, 'segmentIndex'> & {source: string}> {
    if (lines.length === 0) return [];
    const bodyHeight = Math.max(1, median(lines.map((line) => line.height).filter((height) => height >= 4)));
    const drafts: PdfTextBlockDraft[] = [];
    const isHeading = (line: PdfTextLine) => line.height >= bodyHeight * 1.32;
    const bounds = (draft: PdfTextBlockDraft) => {
        const x = Math.min(...draft.lines.map((line) => line.x));
        const y = Math.min(...draft.lines.map((line) => line.y));
        const right = Math.max(...draft.lines.map((line) => line.x + line.width));
        const bottom = Math.max(...draft.lines.map((line) => line.y + line.height));
        return {x, y, right, bottom};
    };

    lines.forEach((line) => {
        let selected: PdfTextBlockDraft | undefined;
        let selectedGap = Number.POSITIVE_INFINITY;
        if (!isHeading(line)) {
            drafts.forEach((draft) => {
                const last = draft.lines.at(-1)!;
                if (isHeading(last)) return;
                const draftBounds = bounds(draft);
                const gap = line.y - draftBounds.bottom;
                if (gap < -Math.max(2, line.height * 0.2) || gap > Math.max(last.height, line.height) * 0.95) return;
                const overlap = Math.max(0, Math.min(draftBounds.right, line.x + line.width) - Math.max(draftBounds.x, line.x));
                const overlapRatio = overlap / Math.max(1, Math.min(draftBounds.right - draftBounds.x, line.width));
                const aligned = Math.abs(line.x - last.x) <= Math.max(bodyHeight * 1.5, Math.min(last.width, line.width) * 0.12);
                const fontRatio = Math.max(last.height, line.height) / Math.max(1, Math.min(last.height, line.height));
                const startsIndentedParagraph = /[.!?。！？]["')\]}]*$/u.test(last.text)
                    && line.x - last.x > bodyHeight * 0.9;
                if ((!aligned && overlapRatio < 0.48) || fontRatio > 1.28 || startsIndentedParagraph) return;
                const paragraphGap = /[.!?。！？]["')\]}]*$/u.test(last.text) && gap > last.height * 0.62;
                if (paragraphGap) return;
                if (gap < selectedGap) {
                    selected = draft;
                    selectedGap = gap;
                }
            });
        }
        if (selected) selected.lines.push(line);
        else drafts.push({lines: [line]});
    });

    return drafts.map((draft) => {
        const draftBounds = bounds(draft);
        const first = draft.lines[0];
        const source = draft.lines.reduce((value, line) => {
            if (!value) return line.text;
            if (/[-‐‑]$/u.test(value) && /^[a-z]/u.test(line.text)) return `${value.slice(0, -1)}${line.text}`;
            return `${value} ${line.text}`;
        }, '').replace(/\s+/gu, ' ').trim();
        const center = (draftBounds.x + draftBounds.right) / 2;
        const centered = Math.abs(center - pageWidth / 2) <= pageWidth * 0.045
            && draftBounds.right - draftBounds.x < pageWidth * 0.9;
        return {
            source,
            x: Math.max(0, draftBounds.x),
            y: Math.max(0, draftBounds.y),
            width: Math.max(1, Math.min(pageWidth, draftBounds.right) - Math.max(0, draftBounds.x)),
            height: Math.max(1, draftBounds.bottom - draftBounds.y),
            fontSize: Math.max(...draft.lines.map((line) => line.height)),
            lineHeight: Math.max(1, median(draft.lines.map((line) => line.height))),
            lineCount: draft.lines.length,
            fontFamily: first.fontFamily,
            fontWeight: (isHeading(first) ? 700 : source.length <= 80 ? 600 : 400) as 400 | 600 | 700,
            textAlign: centered ? 'center' as const : 'left' as const,
        };
    }).filter((block) => block.source.length > 0)
        .sort((left, right) => left.y - right.y || left.x - right.x);
}

async function parsePdf(fileName: string, bytes: Uint8Array): Promise<ParsedDocument> {
    if (new TextDecoder('latin1').decode(bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('PDF 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const segments: DocumentSegment[] = [];
    const pages: PdfDocumentPage[] = [];
    const pdfAssetRoot = typeof window !== 'undefined' ? `${window.location.origin}/pdfjs` : '';
    const {getDocument: getPdfDocument, GlobalWorkerOptions} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof window !== 'undefined') GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const loadingTask = getPdfDocument({
        data: new Uint8Array(bytes),
        disableFontFace: true,
        isEvalSupported: false,
        useWorkerFetch: false,
        ...(pdfAssetRoot ? {
            cMapPacked: true,
            cMapUrl: `${pdfAssetRoot}/cmaps/`,
            standardFontDataUrl: `${pdfAssetRoot}/standard_fonts/`,
        } : {}),
    });

    try {
        const pdf = await loadingTask.promise;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({scale: 1});
            const textContent = await page.getTextContent();
            const atoms = pdfTextAtoms(
                textContent.items.filter((item): item is PdfTextItem => 'str' in item),
                textContent.styles as Record<string, PdfTextStyle>,
                viewport,
            );
            const layoutBlocks = pdfTextBlocks(pdfTextLines(atoms, viewport.width), viewport.width);
            const segmentIndexes: number[] = [];
            const blocks: PdfDocumentBlock[] = [];
            layoutBlocks.forEach((block, blockIndex) => {
                const id = segments.length;
                segments.push({
                    id,
                    source: block.source,
                    contextLabel: blockIndex === 0 ? `第 ${pageNumber} 页` : undefined,
                    role: block.fontWeight === 700 ? 'heading' : 'paragraph',
                });
                segmentIndexes.push(id);
                blocks.push({...block, segmentIndex: id});
            });
            pages.push({
                pageNumber,
                width: viewport.width,
                height: viewport.height,
                segmentIndexes,
                blocks,
            });
            page.cleanup();
        }
    } catch (error) {
        throw new Error(`PDF 解析失败：${String(error)}`);
    } finally {
        await loadingTask.destroy();
    }

    if (segments.length === 0) {
        throw new Error('PDF 中没有可提取的文字；扫描版 PDF 暂不支持 OCR，请上传包含文本层的 PDF');
    }

    return {
        fileName,
        format: 'pdf',
        label: getDocumentFormatLabel('pdf'),
        parts: [],
        segments,
        binary: {kind: 'pdf', bytes, pages},
    };
}

export function chapterTitle(source: string, fallback: string): string {
    const rawTitle = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
    if (!rawTitle) return fallback;
    const title = xmlDecode(rawTitle.replace(/<[^>]+>/gu, '')).replace(/\s+/gu, ' ').trim();
    return title || fallback;
}

async function parseEpub(fileName: string, bytes: Uint8Array): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await JSZip.loadAsync(bytes);
    } catch (error) {
        throw new Error(`ePub 解析失败：${String(error)}`);
    }
    assertArchiveSafety(zip, 'ePub');

    const mimetypeEntry = zip.file('mimetype');
    const containerEntry = zip.file('META-INF/container.xml');
    if (!mimetypeEntry || !containerEntry) {
        throw new Error('ePub 文件结构无效：缺少 mimetype 或 META-INF/container.xml');
    }
    const mimetype = (await mimetypeEntry.async('string')).trim();
    if (mimetype !== 'application/epub+zip') {
        throw new Error('ePub 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const containerXml = await containerEntry.async('string');
    const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?\s*>/iu);
    const opfPath = rootfileMatch ? parseXmlAttributes(rootfileMatch[1])['full-path'] : '';
    if (!opfPath || !zip.file(opfPath)) {
        throw new Error('ePub 文件结构无效：找不到内容清单 OPF');
    }

    const opfXml = await zip.file(opfPath)!.async('string');
    const manifest = new Map<string, {path: string; mediaType: string}>();
    const itemPattern = /<item\b([^>]*)\/?\s*>/giu;
    let itemMatch = itemPattern.exec(opfXml);
    while (itemMatch) {
        const attributes = parseXmlAttributes(itemMatch[1]);
        if (attributes.id && attributes.href) {
            manifest.set(attributes.id, {
                path: resolveZipPath(opfPath, attributes.href),
                mediaType: attributes['media-type'] || '',
            });
        }
        itemMatch = itemPattern.exec(opfXml);
    }

    const orderedPaths: string[] = [];
    const itemrefPattern = /<itemref\b([^>]*)\/?\s*>/giu;
    let itemrefMatch = itemrefPattern.exec(opfXml);
    while (itemrefMatch) {
        const idref = parseXmlAttributes(itemrefMatch[1]).idref;
        const entry = idref ? manifest.get(idref) : undefined;
        if (entry && /^(?:application\/xhtml\+xml|text\/html)$/iu.test(entry.mediaType)) orderedPaths.push(entry.path);
        itemrefMatch = itemrefPattern.exec(opfXml);
    }
    if (orderedPaths.length === 0) {
        manifest.forEach((entry) => {
            if (/^(?:application\/xhtml\+xml|text\/html)$/iu.test(entry.mediaType)) orderedPaths.push(entry.path);
        });
    }

    const segments: DocumentSegment[] = [];
    const chapters: EpubDocumentChapter[] = [];
    for (const [chapterIndex, path] of orderedPaths.entries()) {
        const entry = zip.file(path);
        if (!entry) continue;
        const source = await entry.async('string');
        const parsed = parseDocument('chapter.html', source);
        if (parsed.segments.length === 0) continue;
        const title = chapterTitle(source, `第 ${chapterIndex + 1} 章`);
        const segmentOffset = segments.length;
        parsed.segments.forEach((segment, segmentIndex) => {
            segments.push({
                id: segments.length,
                source: segment.source,
                contextLabel: segmentIndex === 0 ? title : undefined,
            });
        });
        chapters.push({path, source, segmentOffset, segmentCount: parsed.segments.length, title});
    }

    if (segments.length === 0) throw new Error('ePub 中没有找到可翻译的章节文字');
    return {
        fileName,
        format: 'epub',
        label: getDocumentFormatLabel('epub'),
        parts: [],
        segments,
        binary: {kind: 'epub', bytes, chapters},
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

export function docxPartTitle(path: string): string {
    if (path === 'word/document.xml') return '正文';
    if (/header/iu.test(path)) return '页眉';
    if (/footer/iu.test(path)) return '页脚';
    if (/footnotes/iu.test(path)) return '脚注';
    if (/endnotes/iu.test(path)) return '尾注';
    return '文档内容';
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

async function parseDocx(fileName: string, bytes: Uint8Array): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await JSZip.loadAsync(bytes);
    } catch (error) {
        throw new Error(`DOCX 解析失败：${String(error)}`);
    }
    assertArchiveSafety(zip, 'DOCX');
    if (!zip.file('[Content_Types].xml') || !zip.file('word/document.xml')) {
        throw new Error('DOCX 文件结构无效，文件可能已损坏或扩展名不正确');
    }

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
        const source = await zip.file(path)!.async('string');
        const paragraphSegments: Array<{paragraphIndex: number; segmentIndex: number}> = [];
        let paragraphIndex = 0;
        let partSegmentIndex = 0;
        DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
        let paragraphMatch = DOCX_PARAGRAPH_PATTERN.exec(source);
        while (paragraphMatch) {
            const text = docxParagraphText(paragraphMatch[0]);
            if (text) {
                const segmentIndex = segments.length;
                segments.push({
                    id: segmentIndex,
                    source: text,
                    contextLabel: partSegmentIndex === 0 ? docxPartTitle(path) : undefined,
                    pathLabel: docxPartTitle(path),
                    role: docxParagraphRole(paragraphMatch[0], path),
                });
                paragraphSegments.push({paragraphIndex, segmentIndex});
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
        binary: {kind: 'docx', bytes, parts},
    };
}

export async function parseBinaryDocument(fileName: string, input: ArrayBuffer | Uint8Array): Promise<ParsedDocument> {
    const format = getDocumentFormat(fileName);
    if (!format || !isBinaryDocumentFormat(format)) {
        throw new Error('该文件不是 PDF、ePub 或 DOCX 二进制文档');
    }
    const bytes = toUint8Array(input);
    if (format === 'pdf') return parsePdf(fileName, bytes);
    if (format === 'epub') return parseEpub(fileName, bytes);
    return parseDocx(fileName, bytes);
}

export async function parseDocumentFile(file: DocumentFileLike): Promise<ParsedDocument> {
    const format = getDocumentFormat(file.name);
    if (!format) {
        throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件');
    }
    if (isBinaryDocumentFormat(format)) return parseBinaryDocument(file.name, await file.arrayBuffer());
    return parseDocument(file.name, await file.text());
}


async function renderPdf(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    const binary = document.binary as Extract<NonNullable<ParsedDocument['binary']>, {kind: 'pdf'}>;
    const {PDFDocument} = await import('pdf-lib');
    options.signal?.throwIfAborted();
    const outputPdf = await PDFDocument.create();
    outputPdf.setTitle(`${document.fileName} - FluentRead`);
    outputPdf.setProducer('FluentRead document translation');

    const totalPages = binary.pages.length;
    options.onPdfProgress?.({phase: 'rendering', completedPages: 0, totalPages});
    // 让浏览器绘制进度并处理取消，避免仅等待已解决的 Promise 连续占用主线程。
    const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    await yieldToBrowser();
    options.signal?.throwIfAborted();
    // 一次复制共享资源；逐页 embedPage 会反复复制同一套字体与图片。
    const sourcePages = new Map<number, PDFEmbeddedPage>();
    if (mode === 'bilingual') {
        const sourcePdf = await PDFDocument.load(binary.bytes);
        const pages = sourcePdf.getPages().map((page, index) => ({page, pageNumber: index + 1}))
            .filter(({page}) => page.node.Contents());
        // 无内容流的空白页不需要嵌入；pdf-lib 会拒绝嵌入这类页。
        const embedded = await outputPdf.embedPages(pages.map(({page}) => page));
        pages.forEach(({pageNumber}, index) => sourcePages.set(pageNumber, embedded[index]));
    }
    for (const [index, pageData] of binary.pages.entries()) {
        options.signal?.throwIfAborted();
        const png = await options.pdfPageRasterizer!({
            ...pageData,
            sourceBytes: binary.bytes,
            translations,
            signal: options.signal,
        });
        options.signal?.throwIfAborted();
        const image = await outputPdf.embedPng(png);
        // embedPng 只解码，默认等到 save 才压缩；提前 embed 释放每页 RGB 像素。
        await image.embed();
        if (mode === 'bilingual') {
            const embeddedSource = sourcePages.get(pageData.pageNumber);
            if (embeddedSource) await embeddedSource.embed();
            const gap = Math.max(8, Math.min(24, pageData.width * 0.025));
            const page = outputPdf.addPage([pageData.width * 2 + gap, pageData.height]);
            if (embeddedSource) page.drawPage(embeddedSource, {x: 0, y: 0, width: pageData.width, height: pageData.height});
            page.drawImage(image, {
                x: pageData.width + gap,
                y: 0,
                width: pageData.width,
                height: pageData.height,
            });
        } else {
            const page = outputPdf.addPage([pageData.width, pageData.height]);
            page.drawImage(image, {x: 0, y: 0, width: pageData.width, height: pageData.height});
        }
        options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
        await yieldToBrowser();
    }
    options.signal?.throwIfAborted();
    options.onPdfProgress?.({phase: 'saving', completedPages: totalPages, totalPages});
    await yieldToBrowser();
    options.signal?.throwIfAborted();
    const bytes = await outputPdf.save({useObjectStreams: true, objectsPerTick: 20});
    options.signal?.throwIfAborted();
    return bytes;
}

async function renderEpub(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode): Promise<Uint8Array> {
    if (document.binary?.kind !== 'epub') throw new Error('ePub 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    const zip = await JSZip.loadAsync(document.binary.bytes);
    assertArchiveSafety(zip, 'ePub');
    for (const chapter of document.binary.chapters) {
        const parsedChapter = parseDocument('chapter.html', chapter.source);
        const chapterTranslations = translations.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount);
        zip.file(chapter.path, renderDocument(parsedChapter, chapterTranslations, mode));
    }
    zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
    return zip.generateAsync({
        type: 'uint8array',
        mimeType: 'application/epub+zip',
        compression: 'DEFLATE',
        compressionOptions: {level: 6},
    });
}

export function docxTextNodes(value: string): string {
    const tokens = value.replace(/\r\n?/gu, '\n').split(/(\n|\t)/u);
    const content = tokens.map((token) => {
        if (token === '\n') return '<w:br/>';
        if (token === '\t') return '<w:tab/>';
        return token ? `<w:t xml:space="preserve">${xmlEscape(token)}</w:t>` : '';
    }).join('');
    return content || '<w:t></w:t>';
}

function translatedDocxParagraph(value: string): string {
    return `<w:p><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr><w:r><w:rPr><w:color w:val="E83B6B"/></w:rPr>${docxTextNodes(value)}</w:r></w:p>`;
}

function replaceDocxParagraphText(paragraph: string, value: string): string {
    let replaced = false;
    return paragraph.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/gu, () => {
        if (replaced) return '';
        replaced = true;
        return docxTextNodes(value);
    });
}

export function renderDocxPart(
    document: ParsedDocument,
    part: DocxDocumentPart,
    translations: readonly string[],
    mode: DocumentRenderMode,
): string {
    const segmentByParagraph = new Map(part.paragraphSegments.map((entry) => [entry.paragraphIndex, entry.segmentIndex]));
    let paragraphIndex = 0;
    DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
    return part.source.replace(DOCX_PARAGRAPH_PATTERN, (paragraph) => {
        const segmentIndex = segmentByParagraph.get(paragraphIndex);
        paragraphIndex += 1;
        if (segmentIndex === undefined) return paragraph;
        const translation = translations[segmentIndex] ?? document.segments[segmentIndex]?.source ?? '';
        return mode === 'bilingual'
            ? `${paragraph}${translatedDocxParagraph(translation)}`
            : replaceDocxParagraphText(paragraph, translation);
    });
}

async function renderDocx(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode): Promise<Uint8Array> {
    if (document.binary?.kind !== 'docx') throw new Error('DOCX 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    const zip = await JSZip.loadAsync(document.binary.bytes);
    assertArchiveSafety(zip, 'DOCX');
    document.binary.parts.forEach((part) => {
        zip.file(part.path, renderDocxPart(document, part, translations, mode));
    });
    return zip.generateAsync({
        type: 'uint8array',
        mimeType: getDocumentMimeType('docx'),
        compression: 'DEFLATE',
        compressionOptions: {level: 6},
    });
}

export async function createDocumentDownload(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions = {},
): Promise<DocumentDownload> {
    options.signal?.throwIfAborted();
    // UI 的完成度按非空译文计算；各格式导出必须采用相同规则。
    const resolved = document.segments.map(segment => resolveDocumentTranslation(segment.source, translations[segment.id]));
    let data: string | Uint8Array;
    if (document.format === 'pdf') {
        if (document.binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
        if (!options.pdfPageRasterizer) {
            throw new Error('当前环境未提供 PDF 页面渲染器，请在浏览器扩展中下载');
        }
        data = await renderPdf(document, resolved, mode, options);
    } else if (document.format === 'epub') {
        data = await renderEpub(document, resolved, mode);
    } else if (document.format === 'docx') {
        data = await renderDocx(document, resolved, mode);
    } else {
        data = renderDocument(document, resolved, mode);
    }
    options.signal?.throwIfAborted();
    return {
        data,
        fileName: createDocumentDownloadName(document.fileName, mode),
        mimeType: getDocumentMimeType(document.format),
    };
}
