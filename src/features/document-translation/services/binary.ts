/**
 * @file src/features/document-translation/services/binary.ts
 * 文件职责：处理 PDF、EPUB 与 DOCX 二进制文档的受限解析和导出，把压缩包或页面文本转换为统一 ParsedDocument，并生成可下载的双语产物。
 * 主要内容：相同译文回退原文；Word 段落记下表格单元格供阅读视图排版；按实际字节限制导入、按需加载二进制依赖，包含归档安全上限、可取消 PDF 提取与译文回填；PDF 默认逐页原版左右对照，保留旋转裁剪、直接嵌入 JPEG 并保存溢出译文批注，显式重排端口才生成续页；ePub/DOCX 导出让出主线程并使用可取消归档流，ePub 保持首项 mimetype 无压缩。
 * 模块边界：此服务可以依赖 JSZip、pdf-lib 和二进制 I/O，但不负责调用翻译服务或渲染设置页；文本格式规则归 core/document，浏览器 Canvas 光栅实现由 ui/pdfPreview 通过接口注入。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type JSZip from 'jszip';
import type {PDFEmbeddedPage} from 'pdf-lib';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {generateDocumentArchive} from './archive';
import {analyzePdfPageLayout, extractPdfGraphicsShapes, type PdfLayoutAtom, type PdfLayoutBlock} from '../core/pdfLayoutAnalysis';
import {buildPdfReadingPlan, type PdfReadingPlan, type PdfReadingPresentation} from '../core/pdfReadingPlan';

import {
    getDocumentMaxBytes,
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
    baseline?: number;
    fontSize?: number;
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
    size?: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ParseDocumentFileOptions {
    signal?: AbortSignal;
    onPdfProgress?: (progress: {completed: number; total: number}) => void;
}

/** 停止等待；File/JSZip 底层读取仍可能完成，PDF 迟到页由调用方释放。 */
function awaitDocumentRead<T>(promise: Promise<T>, signal?: AbortSignal, releaseLateValue?: (value: T) => void): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        promise.then(value => {
            try {
                if (signal.aborted) releaseLateValue?.(value);
                resolve(value);
            } catch (error) {reject(error);}
        }, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function assertDocumentSize(size: number, fileName: string): void {
    const limit = getDocumentMaxBytes(fileName);
    if (!Number.isFinite(size) || size < 0 || size > limit) {
        throw new Error(`文件大小超过 ${Math.round(limit / 1024 / 1024)} MB，或文件大小无效，请先拆分文件后再翻译`);
    }
}

export interface DocumentDownload {
    data: string | Uint8Array;
    fileName: string;
    mimeType: string;
}

export interface PdfRasterPageInput {
    pageNumber: number;
    rotation?: PdfDocumentPage['rotation'];
    width: number;
    height: number;
    sourceBytes: Uint8Array;
    blocks: PdfDocumentBlock[];
    preservedRegions?: PdfDocumentPage['preservedRegions'];
    layoutBoundaries?: PdfDocumentPage['layoutBoundaries'];
    translations: readonly string[];
    signal?: AbortSignal;
    /** 下载优先直接嵌入 JPEG；预览和自定义渲染器仍可使用 PNG。 */
    imageFormat?: 'png' | 'jpeg';
}

export interface PdfOverflowNote {
    segmentIndex: number;
    text: string;
    /** 与文本块相同的未旋转内容坐标；服务边界负责换算到导出页。 */
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface PdfRasterPageResult {
    data: Uint8Array;
    format: 'png' | 'jpeg';
    overflowNotes?: PdfOverflowNote[];
}
export type PdfPageRasterizer = (input: PdfRasterPageInput) => Promise<Uint8Array | PdfRasterPageResult>;
export interface PdfReadingRasterPage {bytes: Uint8Array; width: number; height: number; format?: 'png' | 'jpeg'}
export type PdfReadingRasterizer = (input: PdfRasterPageInput & {plan: PdfReadingPlan}) => AsyncIterable<PdfReadingRasterPage>;

export interface CreateDocumentDownloadOptions {
    pdfPageRasterizer?: PdfPageRasterizer;
    pdfReadingRasterizer?: PdfReadingRasterizer;
    pdfPresentation?: PdfReadingPresentation;
    signal?: AbortSignal;
    onPdfProgress?: (progress: PdfExportProgress) => void;
    onArchiveProgress?: (percent: number) => void;
}
export interface PdfExportProgress {phase: 'rendering' | 'saving'; completedPages: number; totalPages: number}

const yieldDocumentTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return new Uint8Array(value.slice(0));
}

/** 在解压流上核对实际字节，避免伪造的中央目录大小绕过限制后先分配整份内容。 */
function readArchiveText(entry: JSZip.JSZipObject, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        // JSZip 3.10.1 的 file.internalStream 是公开接口，随包声明尚未包含它。
        const stream = (entry as JSZip.JSZipObject & {
            internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
        }).internalStream('uint8array');
        const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
        let chunks: string[] = [];
        let size = 0;
        let finished = false;
        const cleanup = () => {
            chunks = [];
            signal?.removeEventListener('abort', abort);
        };
        const fail = (error: unknown) => {
            if (finished) return;
            finished = true;
            stream.pause();
            cleanup();
            reject(error);
        };
        const abort = () => fail(signal!.reason);
        stream.on('data', chunk => {
            if (finished) return;
            size += chunk.byteLength;
            if (size > ARCHIVE_ENTRY_BYTES_LIMIT) {
                fail(new Error('压缩项实际解压内容过大，已停止解析'));
                return;
            }
            chunks.push(decoder.decode(chunk, {stream: true}));
        });
        stream.on('error', fail);
        stream.on('end', () => {
            if (finished) return;
            finished = true;
            const result = chunks.join('') + decoder.decode();
            cleanup();
            resolve(result);
        });
        signal?.addEventListener('abort', abort, {once: true});
        stream.resume();
    });
}

export function assertArchiveSafety(zip: JSZip, label: 'ePub' | 'DOCX'): void {
    const entries = Object.values(zip.files);
    if (entries.length > ARCHIVE_ENTRY_LIMIT) {
        throw new Error(`${label} 文件包含过多压缩项，已停止解析`);
    }
    let totalBytes = 0;
    entries.forEach((entry) => {
        const size = Number((entry as typeof entry & {_data?: {uncompressedSize?: number}})._data?.uncompressedSize ?? 0);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label} 文件中的内容项大小无效，已停止解析`);
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
    includeLineDetails = false,
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
        // 标准 Type 1 字体可能给出 NaN 指标；不能让有效正文因 y=NaN 被视口过滤掉。
        const ascent = typeof style.ascent === 'number' && Number.isFinite(style.ascent)
            ? style.ascent
            : typeof style.descent === 'number' && Number.isFinite(style.descent)
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
            ...(includeLineDetails ? {baseline: transform[5], fontSize: fontHeight} : {}),
        }];
    }).filter((atom) => atom.x < viewport.width && atom.y < viewport.height && atom.x + atom.width > 0 && atom.y + atom.height > 0);
}

export function pdfTextLines(atoms: PdfTextAtom[], pageWidth: number): PdfTextLine[] {
    const rows: PdfTextAtom[][] = [];
    let rowHeight = 0;
    [...atoms].sort((left, right) => left.y - right.y || left.x - right.x).forEach((atom) => {
        const row = rows.at(-1);
        // 全局排序保证当前 row 的 y 有序，直接取中位位置，避免每加入一项复制并排序整行。
        const middle = row ? Math.floor(row.length / 2) : 0;
        const rowY = row ? row.length % 2 === 0 ? (row[middle - 1].y + row[middle].y) / 2 : row[middle].y : 0;
        if (!row || Math.abs(atom.y - rowY) > Math.max(2, rowHeight * 0.42, atom.height * 0.42)) {
            rows.push([atom]);
            rowHeight = atom.height;
        } else {
            row.push(atom);
            rowHeight = Math.max(rowHeight, atom.height);
        }
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
        // PDF 文本层可包含超过引擎实参上限的碎片；二元归约保留 NaN、±0、Infinity 语义。
        let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
        ordered.forEach((entry) => {
            x = Math.min(x, entry.x);
            y = Math.min(y, entry.y);
            right = Math.max(right, entry.x + entry.width);
            bottom = Math.max(bottom, entry.y + entry.height);
        });
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

type PdfLineGeometry = Pick<PdfTextLine, 'x' | 'y' | 'width' | 'height'>;

interface PdfTextBlockDraft {
    order: number;
    inputIndex: number;
    geometry: PdfLineGeometry;
    lines: PdfTextLine[];
    bounds: {x: number; y: number; right: number; bottom: number};
}

/**
 * 按输入行的初始底边和横坐标组织平衡空间树，叶子保留建段身份，合并后更新祖先包围区间。
 * 查询只排除原 gap/对齐/重叠运算必定不合格的子树；不改输入处理顺序，也不丢弃旧段。
 * 非标题末行高度小于 maxHeight，横向对齐余量用末行宽度给出保守上界。
 * 区间变松时仍遍历所有可能候选，不截断正文；非有限几何沿用完整遍历的公共语义。
 */
function createPdfDraftIndex(lines: PdfLineGeometry[], maxHeight: number, bodyHeight: number) {
    const entries = lines.map((line, inputIndex) => ({inputIndex, bottom: line.y + line.height, x: line.x, right: line.x + line.width}));
    if (!Number.isFinite(maxHeight) || entries.some(entry => !Number.isFinite(entry.bottom) || !Number.isFinite(entry.x) || !Number.isFinite(entry.right))) return;
    entries.sort((left, right) => left.bottom - right.bottom || left.x - right.x);
    const positions: number[] = [];
    entries.forEach((entry, position) => {positions[entry.inputIndex] = position;});
    let size = 1;
    while (size < entries.length) size *= 2;
    const counts = new Uint32Array(size * 2);
    const minBottom = new Float64Array(size * 2).fill(Infinity);
    const maxBottom = new Float64Array(size * 2).fill(-Infinity);
    const minX = new Float64Array(size * 2).fill(Infinity);
    const maxRight = new Float64Array(size * 2).fill(-Infinity);
    const minLastX = new Float64Array(size * 2).fill(Infinity);
    const maxLastX = new Float64Array(size * 2).fill(-Infinity);
    const maxAlignment = new Float64Array(size * 2);
    const drafts: PdfTextBlockDraft[] = [];
    const add = (draft: PdfTextBlockDraft) => {
        const position = positions[draft.inputIndex];
        drafts[position] = draft;
        let node = size + position;
        const last = draft.geometry;
        counts[node] = 1;
        minBottom[node] = maxBottom[node] = draft.bounds.bottom;
        minX[node] = draft.bounds.x;
        maxRight[node] = draft.bounds.right;
        minLastX[node] = maxLastX[node] = last.x;
        maxAlignment[node] = Math.max(bodyHeight * 1.5, last.width * 0.12);
        while (node > 1) {
            node = Math.floor(node / 2);
            const left = node * 2, right = left + 1;
            counts[node] = counts[left] + counts[right];
            minBottom[node] = Math.min(minBottom[left], minBottom[right]);
            maxBottom[node] = Math.max(maxBottom[left], maxBottom[right]);
            minX[node] = Math.min(minX[left], minX[right]);
            maxRight[node] = Math.max(maxRight[left], maxRight[right]);
            minLastX[node] = Math.min(minLastX[left], minLastX[right]);
            maxLastX[node] = Math.max(maxLastX[left], maxLastX[right]);
            maxAlignment[node] = Math.max(maxAlignment[left], maxAlignment[right]);
        }
    };
    const forEach = (line: PdfLineGeometry, consume: (draft: PdfTextBlockDraft) => void) => {
        const y = line.y, x = line.x, right = x + line.width;
        const minimumGap = -Math.max(2, line.height * 0.2);
        const maximumGap = maxHeight * 0.95;
        const visit = (node: number): void => {
            // 保留原减法，避免将浮点边界改写为坐标加减 tolerance。
            if (!counts[node] || y - maxBottom[node] > maximumGap || y - minBottom[node] < minimumGap) return;
            const cannotOverlap = right <= minX[node] || x >= maxRight[node];
            const cannotAlign = x - maxLastX[node] > maxAlignment[node] || minLastX[node] - x > maxAlignment[node];
            if (cannotOverlap && cannotAlign) return;
            if (node >= size) {
                consume(drafts[node - size]);
                return;
            }
            visit(node * 2);
            visit(node * 2 + 1);
        };
        visit(1);
    };
    return {add, forEach};
}

export function pdfTextBlocks(lines: PdfTextLine[], pageWidth: number): Array<Omit<PdfDocumentBlock, 'segmentIndex'> & {source: string}> {
    if (lines.length === 0) return [];
    // 每行几何读取一次，索引和原评分共用，避免长合并段为了维护索引回退到重复属性读取。
    const geometries = lines.map(line => ({x: line.x, y: line.y, width: line.width, height: line.height}));
    const bodyHeight = Math.max(1, median(geometries.map((line) => line.height).filter((height) => height >= 4)));
    const drafts: PdfTextBlockDraft[] = [];
    const isHeading = (line: PdfLineGeometry) => line.height >= bodyHeight * 1.32;
    const index = createPdfDraftIndex(geometries, bodyHeight * 1.32, bodyHeight);

    lines.forEach((line, inputIndex) => {
        const geometry = geometries[inputIndex];
        let selected: PdfTextBlockDraft | undefined;
        let selectedGap = Number.POSITIVE_INFINITY;
        if (!isHeading(geometry)) {
            const consider = (draft: PdfTextBlockDraft) => {
                const last = draft.lines.at(-1)!;
                const lastGeometry = draft.geometry;
                if (!index && isHeading(lastGeometry)) return;
                const draftBounds = draft.bounds;
                const gap = geometry.y - draftBounds.bottom;
                if (gap < -Math.max(2, geometry.height * 0.2) || gap > Math.max(lastGeometry.height, geometry.height) * 0.95) return;
                const overlap = Math.max(0, Math.min(draftBounds.right, geometry.x + geometry.width) - Math.max(draftBounds.x, geometry.x));
                const overlapRatio = overlap / Math.max(1, Math.min(draftBounds.right - draftBounds.x, geometry.width));
                const aligned = Math.abs(geometry.x - lastGeometry.x) <= Math.max(bodyHeight * 1.5, Math.min(lastGeometry.width, geometry.width) * 0.12);
                const fontRatio = Math.max(lastGeometry.height, geometry.height) / Math.max(1, Math.min(lastGeometry.height, geometry.height));
                const startsIndentedParagraph = /[.!?。！？]["')\]}]*$/u.test(last.text)
                    && geometry.x - lastGeometry.x > bodyHeight * 0.9;
                if ((!aligned && overlapRatio < 0.48) || fontRatio > 1.28 || startsIndentedParagraph) return;
                const paragraphGap = /[.!?。！？]["')\]}]*$/u.test(last.text) && gap > lastGeometry.height * 0.62;
                if (paragraphGap) return;
                // 索引按底边遍历，平分时仍选择原 drafts 顺序里的第一段。
                if (gap < selectedGap || (selected && gap === selectedGap && draft.order < selected.order)) {
                    selected = draft;
                    selectedGap = gap;
                }
            };
            if (index) index.forEach(geometry, consider);
            else drafts.forEach(consider);
        }
        if (selected) {
            selected.lines.push(line);
            selected.geometry = geometry;
            selected.bounds.x = Math.min(selected.bounds.x, geometry.x);
            selected.bounds.y = Math.min(selected.bounds.y, geometry.y);
            selected.bounds.right = Math.max(selected.bounds.right, geometry.x + geometry.width);
            selected.bounds.bottom = Math.max(selected.bounds.bottom, geometry.y + geometry.height);
            index?.add(selected);
        } else {
            const draft = {order: drafts.length, inputIndex, geometry, lines: [line], bounds: {x: geometry.x, y: geometry.y, right: geometry.x + geometry.width, bottom: geometry.y + geometry.height}};
            drafts.push(draft);
            if (!isHeading(geometry)) index?.add(draft);
        }
    });

    return drafts.map((draft) => {
        const draftBounds = draft.bounds;
        const first = draft.lines[0];
        const source = draft.lines.reduce((value, line) => {
            if (!value) return line.text;
            if (/[-‐‑]$/u.test(value) && /^[a-z]/u.test(line.text)) return `${value.slice(0, -1)}${line.text}`;
            return `${value} ${line.text}`;
        }, '').replace(/\s+/gu, ' ').trim();
        const center = (draftBounds.x + draftBounds.right) / 2;
        const centered = Math.abs(center - pageWidth / 2) <= pageWidth * 0.045
            && draftBounds.right - draftBounds.x < pageWidth * 0.9;
        let fontSize = -Infinity;
        draft.lines.forEach(line => {fontSize = Math.max(fontSize, line.height);});
        return {
            source,
            x: Math.max(0, draftBounds.x),
            y: Math.max(0, draftBounds.y),
            width: Math.max(1, Math.min(pageWidth, draftBounds.right) - Math.max(0, draftBounds.x)),
            height: Math.max(1, draftBounds.bottom - draftBounds.y),
            fontSize,
            lineHeight: Math.max(1, median(draft.lines.map((line) => line.height))),
            lineCount: draft.lines.length,
            fontFamily: first.fontFamily,
            fontWeight: (isHeading(first) ? 700 : source.length <= 80 ? 600 : 400) as 400 | 600 | 700,
            textAlign: centered ? 'center' as const : 'left' as const,
        };
    }).filter((block) => block.source.length > 0)
        .sort((left, right) => left.y - right.y || left.x - right.x);
}

async function parsePdf(fileName: string, bytes: Uint8Array, signal?: AbortSignal, onProgress?: ParseDocumentFileOptions['onPdfProgress']): Promise<ParsedDocument> {
    if (new TextDecoder('latin1').decode(bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('PDF 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const segments: DocumentSegment[] = [];
    const pages: PdfDocumentPage[] = [];
    const pdfAssetRoot = typeof window !== 'undefined' ? `${window.location.origin}/pdfjs` : '';
    const pdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const {getDocument: getPdfDocument, GlobalWorkerOptions} = pdfJs;
    signal?.throwIfAborted();
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

    let destruction: Promise<void> | undefined;
    const destroy = () => destruction ??= loadingTask.destroy();
    const cancel = () => { void destroy().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        const pdf = await awaitDocumentRead(loadingTask.promise, signal);
        signal?.throwIfAborted();
        onProgress?.({completed: 0, total: pdf.numPages});
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            signal?.throwIfAborted();
            const page = await awaitDocumentRead(pdf.getPage(pageNumber), signal, latePage => {latePage.cleanup();});
            try {
                signal?.throwIfAborted();
                const displayViewport = page.getViewport({scale: 1});
                const rotation = (((displayViewport.rotation || 0) % 360 + 360) % 360) as NonNullable<PdfDocumentPage['rotation']>;
                // /Rotate 是页面展示元数据，不能让原本横排的正文被竖排过滤器误删。
                const viewport = rotation ? page.getViewport({scale: 1, rotation: 0}) : displayViewport;
                const textContent = await awaitDocumentRead(page.getTextContent(), signal);
                signal?.throwIfAborted();
                const atoms = pdfTextAtoms(
                    textContent.items.filter((item): item is PdfTextItem => 'str' in item),
                    textContent.styles as Record<string, PdfTextStyle>,
                    viewport,
                    true,
                ) as PdfLayoutAtom[];
                const graphics = typeof page.getOperatorList === 'function'
                    ? extractPdfGraphicsShapes(await awaitDocumentRead(page.getOperatorList(), signal), pdfJs.OPS, viewport) : [];
                signal?.throwIfAborted();
                const {blocks: layoutBlocks, preservedRegions} = analyzePdfPageLayout({atoms, graphics, width: viewport.width, height: viewport.height});
                const {blocks, segmentIndexes} = pdfPageSegments(layoutBlocks, pageNumber, segments);
                pages.push({
                    pageNumber,
                    width: displayViewport.width,
                    height: displayViewport.height,
                    ...(rotation ? {rotation} : {}),
                    segmentIndexes,
                    blocks,
                    preservedRegions,
                    layoutBoundaries: graphics.filter(shape => shape.kind === 'path' &&
                        (shape.width >= 12 && shape.height <= 5 || shape.height >= 12 && shape.width <= 5)),
                    // 没有任何文字、且有一张图像盖住半页以上：这是扫描页。空白页和只有矢量图形的页不算。
                    ...(atoms.length === 0 && graphics.some(shape => shape.kind === 'image' && shape.width * shape.height >= viewport.width * viewport.height * 0.5) ? {scanned: true} : {}),
                });
                onProgress?.({completed: pageNumber, total: pdf.numPages});
            } finally {
                page.cleanup();
            }
            // 为导入进度、取消按钮和输入事件留出绘制机会，不连续占满主线程。
            if (pageNumber % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`PDF 解析失败：${String(error)}`);
    } finally {
        signal?.removeEventListener('abort', cancel);
        await destroy();
    }

    // 没有文字层的扫描件照常打开：原页可以阅读，文字识别由页面在开始翻译时按页进行（见 services/pdfOcr）。

    return {
        fileName,
        format: 'pdf',
        label: getDocumentFormatLabel('pdf'),
        parts: [],
        segments,
        binary: {kind: 'pdf', bytes, pages},
    };
}

/**
 * 把一页的版面块登记为待翻译片段：表格里含词语的单元格作为独立片段翻译，数字、符号单元格与公式、图内文字保留原样；
 * 页眉页脚和作者信息在阅读与导出时都按原文显示，不占用翻译请求。片段追加到传入的列表末尾。
 */
export function pdfPageSegments(layoutBlocks: readonly PdfLayoutBlock[], pageNumber: number, segments: DocumentSegment[]): {blocks: PdfDocumentBlock[]; segmentIndexes: number[]} {
    const segmentIndexes: number[] = [];
    const blocks: PdfDocumentBlock[] = [];
    layoutBlocks.forEach((block, blockIndex) => {
        if (block.kind === 'formula' || (block.kind === 'table' && block.preserveSource) || block.kind === 'figure-label' || block.kind === 'footer' || block.kind === 'metadata') {
            blocks.push({...block, segmentIndex: -1});
            return;
        }
        const id = segments.length;
        segments.push({id, source: block.source, contextLabel: blockIndex === 0 ? `第 ${pageNumber} 页` : undefined, role: block.fontWeight === 700 ? 'heading' : 'paragraph'});
        segmentIndexes.push(id);
        blocks.push({...block, segmentIndex: id});
    });
    return {blocks, segmentIndexes};
}

export function chapterTitle(source: string, fallback: string): string {
    const rawTitle = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
    if (!rawTitle) return fallback;
    const title = xmlDecode(rawTitle.replace(/<[^>]+>/gu, '')).replace(/\s+/gu, ' ').trim();
    return title || fallback;
}

async function parseEpub(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await awaitDocumentRead(JSZip.loadAsync(bytes), signal);
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`ePub 解析失败：${String(error)}`);
    }
    signal?.throwIfAborted();
    assertArchiveSafety(zip, 'ePub');

    const mimetypeEntry = zip.file('mimetype');
    const containerEntry = zip.file('META-INF/container.xml');
    if (!mimetypeEntry || !containerEntry) {
        throw new Error('ePub 文件结构无效：缺少 mimetype 或 META-INF/container.xml');
    }
    const mimetype = (await readArchiveText(mimetypeEntry, signal)).trim();
    if (mimetype !== 'application/epub+zip') {
        throw new Error('ePub 文件签名无效，文件可能已损坏或扩展名不正确');
    }

    const containerXml = await readArchiveText(containerEntry, signal);
    const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?\s*>/iu);
    const opfPath = rootfileMatch ? parseXmlAttributes(rootfileMatch[1])['full-path'] : '';
    if (!opfPath || !zip.file(opfPath)) {
        throw new Error('ePub 文件结构无效：找不到内容清单 OPF');
    }

    const opfXml = await readArchiveText(zip.file(opfPath)!, signal);
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
        const source = await readArchiveText(entry, signal);
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

async function parseDocx(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
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
        binary: {kind: 'docx', bytes, parts},
    };
}

export async function parseBinaryDocument(fileName: string, input: ArrayBuffer | Uint8Array, options: ParseDocumentFileOptions = {}): Promise<ParsedDocument> {
    options.signal?.throwIfAborted();
    const format = getDocumentFormat(fileName);
    if (!format || !isBinaryDocumentFormat(format)) {
        throw new Error('该文件不是 PDF、ePub 或 DOCX 二进制文档');
    }
    assertDocumentSize(input.byteLength, fileName);
    const bytes = toUint8Array(input);
    const parsed = await (format === 'pdf' ? parsePdf(fileName, bytes, options.signal, options.onPdfProgress)
        : format === 'epub' ? parseEpub(fileName, bytes, options.signal) : parseDocx(fileName, bytes, options.signal));
    options.signal?.throwIfAborted();
    return parsed;
}

export async function parseDocumentFile(file: DocumentFileLike, options: ParseDocumentFileOptions = {}): Promise<ParsedDocument> {
    options.signal?.throwIfAborted();
    const format = getDocumentFormat(file.name);
    if (!format) {
        throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件');
    }
    if (file.size !== undefined) assertDocumentSize(file.size, file.name);
    if (isBinaryDocumentFormat(format)) return parseBinaryDocument(file.name, await awaitDocumentRead(file.arrayBuffer(), options.signal), options);
    const source = await awaitDocumentRead(file.text(), options.signal);
    options.signal?.throwIfAborted();
    assertDocumentSize(source.length, file.name);
    assertDocumentSize(new TextEncoder().encode(source).byteLength, file.name);
    // 文档翻译页面按整句翻译 Markdown：一句话不会被行内链接和代码拆散。
    return parseDocument(file.name, source, {markdownSentences: true});
}


async function renderPdf(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    const binary = document.binary as Extract<NonNullable<ParsedDocument['binary']>, {kind: 'pdf'}>;
    const {PDFDocument, PDFHexString, degrees} = await import('pdf-lib');
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
    const drawSourcePage = (target: ReturnType<typeof outputPdf.addPage>, source: PDFEmbeddedPage, pageData: PdfDocumentPage, offsetX = 0) => {
        const rotation = pageData.rotation ?? pageData.sourceRotation ?? 0;
        if (!rotation) {target.drawPage(source, {x: offsetX, y: 0, width: pageData.width, height: pageData.height}); return;}
        const quarterTurn = rotation === 90 || rotation === 270;
        // embedPage 只包含内容流，/Rotate 不会被嵌入；在 PDF 底部向上的坐标系中顺时针旋转并移回正象限。
        target.drawPage(source, {
            x: offsetX + (rotation === 180 || rotation === 270 ? pageData.width : 0),
            y: rotation === 90 || rotation === 180 ? pageData.height : 0,
            width: quarterTurn ? pageData.height : pageData.width,
            height: quarterTurn ? pageData.width : pageData.height,
            rotate: degrees(-rotation),
        });
    };
    // 默认下载与原版对照阅读一致，一张原页对应一张译页；重排续页仅供显式阅读导出端口使用。
    const readingExport = Boolean(options.pdfReadingRasterizer && (options.pdfPresentation === 'readable' || !options.pdfPageRasterizer));
    const changedPages = binary.pages.map(page => page.segmentIndexes.some(segmentIndex =>
        hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translations[segmentIndex])));
    if (mode === 'bilingual' || changedPages.some(changed => !changed)) {
        const sourcePdf = await awaitDocumentRead(PDFDocument.load(binary.bytes), options.signal);
        options.signal?.throwIfAborted();
        const required = new Set(binary.pages.filter((_page, index) => mode === 'bilingual' || !changedPages[index]).map(page => page.pageNumber));
        const pages = sourcePdf.getPages().map((page, index) => ({page, pageNumber: index + 1}))
            .filter(({page, pageNumber}) => required.has(pageNumber) && page.node.Contents());
        // 无内容流的空白页不需要嵌入；pdf-lib 会拒绝嵌入这类页。
        const normalizedBox = (box: {x: number; y: number; width: number; height: number}) => ({
            left: Math.min(box.x, box.x + box.width), bottom: Math.min(box.y, box.y + box.height),
            right: Math.max(box.x, box.x + box.width), top: Math.max(box.y, box.y + box.height),
        });
        const boundingBoxes = pages.map(({page}) => {
            const media = normalizedBox(page.getMediaBox()), crop = normalizedBox(page.getCropBox());
            const intersection = {left: Math.max(media.left, crop.left), bottom: Math.max(media.bottom, crop.bottom), right: Math.min(media.right, crop.right), top: Math.min(media.top, crop.top)};
            // 与 PDF.js Page.view 一致：使用 CropBox∩MediaBox，空交集退回 MediaBox。
            // pdf-lib 的默认嵌入矩阵已经将左下角移到原点，无需再次偏移绘制坐标。
            return intersection.right > intersection.left && intersection.top > intersection.bottom ? intersection : media;
        });
        const embedded = await awaitDocumentRead(outputPdf.embedPages(pages.map(({page}) => page), boundingBoxes), options.signal);
        pages.forEach(({pageNumber}, index) => sourcePages.set(pageNumber, embedded[index]));
    }
    const embedImage = async (data: Uint8Array, format?: 'png' | 'jpeg') => {
        options.signal?.throwIfAborted();
        const jpeg = format === 'jpeg' || (data[0] === 0xff && data[1] === 0xd8);
        // pdf-lib 的 JPEG 读取器按整个 buffer 建 DataView；只在外部端口传入切片时复制。
        const bytes = jpeg && (data.byteOffset || data.byteLength !== data.buffer.byteLength) ? data.slice() : data;
        const image = await (jpeg ? outputPdf.embedJpg(bytes) : outputPdf.embedPng(bytes));
        options.signal?.throwIfAborted();
        // PNG 兼容端口也逐页释放解码像素；JPEG 直接引用浏览器编码数据，不再解码并压缩 RGB。
        await image.embed();
        options.signal?.throwIfAborted();
        return image;
    };
    const addOverflowNotes = (target: ReturnType<typeof outputPdf.addPage>, pageData: PdfDocumentPage, notes: PdfOverflowNote[], offsetX: number) => {
        const rotation = pageData.rotation ?? 0;
        const displayRect = (rect: {x: number; y: number; width: number; height: number}) =>
            rotation === 90 ? {x: pageData.width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width}
                : rotation === 180 ? {x: pageData.width - rect.x - rect.width, y: pageData.height - rect.y - rect.height, width: rect.width, height: rect.height}
                    : rotation === 270 ? {x: rect.y, y: pageData.height - rect.x - rect.width, width: rect.height, height: rect.width} : rect;
        const occupied = [...pageData.blocks, ...(pageData.preservedRegions ?? []), ...(pageData.layoutBoundaries ?? [])].map(displayRect);
        const markers: Array<{x: number; y: number; width: number; height: number}> = [];
        const intersects = (left: typeof markers[number], right: typeof markers[number]) =>
            left.x < right.x + right.width + 2 && left.x + left.width + 2 > right.x && left.y < right.y + right.height + 2 && left.y + left.height + 2 > right.y;
        for (const note of notes) {
            const rect = displayRect(note);
            const top = Math.max(4, Math.min(pageData.height - 18, rect.y));
            // 批注入口放在页边空白，保持与段落相近；多个短块同高时分散图标，不遮表格数字或正文。
            const candidates = [];
            for (let step = 0; step <= Math.ceil(pageData.height / 18); step += 1) {
                for (const direction of step ? [1, -1] : [1]) {
                    const y = top + step * 18 * direction;
                    if (y < 4 || y > pageData.height - 18) continue;
                    candidates.push({x: pageData.width - 18, y, width: 14, height: 14}, {x: 4, y, width: 14, height: 14});
                }
            }
            let marker = candidates.find(candidate => ![...occupied, ...markers].some(other => intersects(candidate, other)));
            const gutter = offsetX - pageData.width;
            if (!marker && gutter > 2) marker = candidates.map(candidate => ({x: -gutter + 1, y: candidate.y, width: Math.min(14, gutter - 2), height: 14}))
                .find(candidate => !markers.some(other => intersects(candidate, other)));
            // 满幅单页没有留白时保留批注列表和段落处的点击区域，使用透明外观而非压住原图的图标。
            const visible = Boolean(marker);
            marker ??= {x: Math.max(0, Math.min(pageData.width - 14, rect.x)), y: top, width: 14, height: 14};
            markers.push(marker);
            const x = offsetX + marker.x, y = pageData.height - marker.y - marker.height;
            // PDF.js 等阅读器在没有外观流时会把 /Text 的图标强制扩大到 22pt；明确 14pt 外观才真正守住留白边界。
            const appearance = outputPdf.context.register(outputPdf.context.stream(visible
                ? 'q 1 .78 .18 rg 1 1 12 12 re f .45 .3 .08 RG 1 w 1 1 12 12 re S 3 9 m 11 9 l S 3 6 m 11 6 l S 3 3 m 8 3 l S Q' : '',
            {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 14, 14], Resources: {}}));
            target.node.addAnnot(outputPdf.context.register(outputPdf.context.obj({
                Type: 'Annot', Subtype: 'Text', Rect: [x, y, x + marker.width, y + marker.height], Name: 'Comment', AP: {N: appearance},
                Contents: PDFHexString.fromText(note.text), T: PDFHexString.fromText('FluentRead'),
                C: [1, 0.78, 0.18], F: 0, Open: false,
            })));
        }
    };
    // 导出进行中页面可能释放已解析的片段；找不到片段时按“没有原文”处理，不能让下载中断。
    const visibleTranslations = translations.map((translation, segmentIndex) =>
        hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translation) ? translation : '');
    for (const [index, pageData] of binary.pages.entries()) {
        options.signal?.throwIfAborted();
        const pageChanged = changedPages[index];
        const source = sourcePages.get(pageData.pageNumber);
        // 分散到每页嵌入，避免 save() 一次性解压并重压全部原页内容流，令进度和取消失去响应。
        if (source) await source.embed();
        options.signal?.throwIfAborted();
        const gap = Math.max(8, Math.min(24, pageData.width * 0.025));
        const offsetX = mode === 'bilingual' && !readingExport ? pageData.width + gap : 0;
        if (!pageChanged) {
            const page = outputPdf.addPage([offsetX ? pageData.width * 2 + gap : pageData.width, pageData.height]);
            if (source) drawSourcePage(page, source, pageData);
            if (source && offsetX) drawSourcePage(page, source, pageData, offsetX);
            options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
            await yieldToBrowser();
            continue;
        }
        const rasterInput = {
            ...pageData,
            sourceBytes: binary.bytes,
            translations: visibleTranslations,
            signal: options.signal,
            imageFormat: 'jpeg' as const,
        };
        if (readingExport) {
            // 双语下载保留原页内容流，后接固定字号的完整译文续页。
            if (mode === 'bilingual') {
                const page = outputPdf.addPage([pageData.width, pageData.height]);
                if (source) drawSourcePage(page, source, pageData);
            }
            const plan = buildPdfReadingPlan(document, pageData, translations);
            for await (const rendered of options.pdfReadingRasterizer!({...rasterInput, plan})) {
                options.signal?.throwIfAborted();
                const image = await embedImage(rendered.bytes, rendered.format);
                outputPdf.addPage([rendered.width, rendered.height]).drawImage(image, {x: 0, y: 0, width: rendered.width, height: rendered.height});
                await yieldToBrowser();
            }
            options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
            await yieldToBrowser();
            continue;
        }
        const rendered = await awaitDocumentRead(options.pdfPageRasterizer!(rasterInput), options.signal);
        const encoded = rendered instanceof Uint8Array ? {data: rendered} : rendered;
        const image = await embedImage(encoded.data, 'format' in encoded ? encoded.format : undefined);
        const page = outputPdf.addPage([offsetX ? pageData.width * 2 + gap : pageData.width, pageData.height]);
        if (source && mode === 'bilingual') drawSourcePage(page, source, pageData);
        page.drawImage(image, {x: offsetX, y: 0, width: pageData.width, height: pageData.height});
        if ('overflowNotes' in encoded && encoded.overflowNotes?.length) addOverflowNotes(page, pageData, encoded.overflowNotes, offsetX);
        options.onPdfProgress?.({phase: 'rendering', completedPages: index + 1, totalPages});
        await yieldToBrowser();
    }
    options.signal?.throwIfAborted();
    options.onPdfProgress?.({phase: 'saving', completedPages: totalPages, totalPages});
    await yieldToBrowser();
    options.signal?.throwIfAborted();
    const bytes = await awaitDocumentRead(outputPdf.save({useObjectStreams: true, objectsPerTick: 20}), options.signal);
    options.signal?.throwIfAborted();
    return bytes;
}

async function renderEpub(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode, options: CreateDocumentDownloadOptions): Promise<Uint8Array> {
    if (document.binary?.kind !== 'epub') throw new Error('ePub 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    const zip = await JSZip.loadAsync(document.binary.bytes);
    assertArchiveSafety(zip, 'ePub');
    for (const chapter of document.binary.chapters) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        const parsedChapter = parseDocument('chapter.html', chapter.source);
        const chapterTranslations = translations.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount);
        zip.file(chapter.path, renderDocument(parsedChapter, chapterTranslations, mode));
    }
    zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
    // 更新文件不会改变 JSZip 的键顺序；EPUB 要求 mimetype 是第一条本地记录。
    const {mimetype, ...resources} = zip.files;
    // 整数形资源名也会被普通对象枚举提前；显式枚举顺序保证 mimetype 始终第一。
    zip.files = new Proxy({mimetype, ...resources}, {ownKeys: files => ['mimetype', ...Reflect.ownKeys(files).filter(path => path !== 'mimetype')]});
    return generateDocumentArchive(zip, {
        mimeType: 'application/epub+zip',
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
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
        if (!hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translation)) return paragraph;
        return mode === 'bilingual'
            ? `${paragraph}${translatedDocxParagraph(translation)}`
            : replaceDocxParagraphText(paragraph, translation);
    });
}

async function renderDocx(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode, options: CreateDocumentDownloadOptions): Promise<Uint8Array> {
    if (document.binary?.kind !== 'docx') throw new Error('DOCX 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    const zip = await JSZip.loadAsync(document.binary.bytes);
    assertArchiveSafety(zip, 'DOCX');
    for (const part of document.binary.parts) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        zip.file(part.path, renderDocxPart(document, part, translations, mode));
    }
    return generateDocumentArchive(zip, {
        mimeType: getDocumentMimeType('docx'),
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
}

export async function createDocumentDownload(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions = {},
): Promise<DocumentDownload> {
    // 首次编码之前给下载进度、取消按钮和浏览器事件一个可执行的时间片。
    await yieldDocumentTask();
    options.signal?.throwIfAborted();
    // UI 的完成度按非空译文计算；各格式导出必须采用相同规则。
    const resolved = document.segments.map(segment => resolveDocumentTranslation(segment.source, translations[segment.id]));
    let data: string | Uint8Array;
    if (document.format === 'pdf') {
        if (document.binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
        if (!options.pdfPageRasterizer && !options.pdfReadingRasterizer) {
            throw new Error('当前环境未提供 PDF 页面渲染器，请在浏览器扩展中下载');
        }
        data = await renderPdf(document, resolved, mode, options);
    } else if (document.format === 'epub') {
        data = await renderEpub(document, resolved, mode, options);
    } else if (document.format === 'docx') {
        data = await renderDocx(document, resolved, mode, options);
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
