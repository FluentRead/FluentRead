/**
 * @file src/features/document-translation/services/binaryShared.ts
 * 文件职责：提供 PDF、EPUB、DOCX、PPTX 与 XLSX 二进制文档解析与导出共用的协议类型、文件大小与归档安全校验、流式解压读取及 XML/ZIP 路径工具函数。
 * 主要内容：定义二进制文档导入与 PDF 光栅/阅读导出接口；实现可取消的异步读取包装、防炸弹压缩项检查、XML 实体编解码与属性解析、ZIP 相对路径规范化及中位数计算。
 * 模块边界：仅提供二进制文档服务层共用的基础契约与纯工具函数，不加载 PDF.js/pdf-lib，也不承担具体文档格式的解析或导出编排。
 */
import type JSZip from 'jszip';
import type {PdfReadingPlan, PdfReadingPresentation} from '../core/pdfReadingPlan';
import type {PdfReadingOutputPage, PdfTextMeasure} from '../core/pdfTextLayout';
import {
    getDocumentMaxBytes,
    type DocumentFormat,
    type PdfDocumentBlock,
    type PdfDocumentPage,
} from '@/src/features/document-translation/core/document';

const BINARY_DOCUMENT_FORMATS = new Set<DocumentFormat>(['pdf', 'epub', 'docx', 'pptx', 'xlsx']);
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
    glyphBounds?: ReadonlyMap<string, readonly [number, number]>;
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
    layoutFontSize?: number;
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
    /** 与实际光栅绘制一致的行；存在此字段的端口支持可搜索文字及完整溢出续页。 */
    textItems?: PdfRasterTextItem[];
}

/** 行左上角与实际绘制宽度使用未旋转的 PDF 点；对齐锚点已由光栅端口转换为左边缘。 */
export interface PdfRasterTextItem {
    /** 仅完整单行实际以该基方向测量并绘制时提供；服务仍独立核对完整目标身份。 */
    direction?: 'ltr' | 'rtl';
    segmentIndex: number;
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
}

export type PdfPageRasterizer = (input: PdfRasterPageInput) => Promise<Uint8Array | PdfRasterPageResult>;

export interface PdfReadingRasterPage {
    bytes: Uint8Array;
    width: number;
    height: number;
    format?: 'png' | 'jpeg';
    textItems?: PdfRasterTextItem[];
    /** 与光栅页一致的重排坐标，供原图区域中的文字投影到可搜索层。 */
    items?: PdfReadingOutputPage['items'];
}

export type PdfReadingRasterizer = (input: PdfRasterPageInput & {plan: PdfReadingPlan; footerLabel?: string}) => AsyncIterable<PdfReadingRasterPage>;

/** 可见文字由 PDF 字体绘制；PNG 只承载公式/图表等需要保留的原图区域。 */
export interface PdfReadingRenderedPage extends PdfReadingOutputPage {regionImage?: Uint8Array}

export type PdfReadingRenderer = (input: PdfRasterPageInput & {plan: PdfReadingPlan; measureText: PdfTextMeasure}) => AsyncIterable<PdfReadingRenderedPage>;

export interface PdfExportProgress {
    phase: 'rendering' | 'saving';
    completedPages: number;
    totalPages: number;
}

export interface CreateDocumentDownloadOptions {
    pdfPageRasterizer?: PdfPageRasterizer;
    pdfReadingRasterizer?: PdfReadingRasterizer;
    pdfReadingRenderer?: PdfReadingRenderer;
    pdfFontLoader?: (signal?: AbortSignal) => Promise<Uint8Array>;
    pdfPresentation?: PdfReadingPresentation;
    signal?: AbortSignal;
    onPdfProgress?: (progress: PdfExportProgress) => void;
    onArchiveProgress?: (percent: number) => void;
}

/** 停止等待；File/JSZip 底层读取仍可能完成，PDF 迟到页由调用方释放。 */
export function awaitDocumentRead<T>(promise: Promise<T>, signal?: AbortSignal, releaseLateValue?: (value: T) => void): Promise<T> {
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

export function assertDocumentSize(size: number, fileName: string): void {
    const limit = getDocumentMaxBytes(fileName);
    if (!Number.isFinite(size) || size < 0 || size > limit) {
        throw new Error(`文件大小超过 ${Math.round(limit / 1024 / 1024)} MB，或文件大小无效，请先拆分文件后再翻译`);
    }
}

export const yieldDocumentTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return new Uint8Array(value.slice(0));
}

/** 在解压流上核对实际字节，避免伪造的中央目录大小绕过限制后先分配整份内容。 */
export function readArchiveText(entry: JSZip.JSZipObject, signal?: AbortSignal): Promise<string> {
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

export function assertArchiveSafety(zip: JSZip, label: 'ePub' | 'DOCX' | 'PPTX' | 'XLSX'): void {
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

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    amp: '&',
};

export function xmlDecode(value: string): string {
    return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));/giu, (match, hex?: string, decimal?: string, named?: string) => {
        if (named) return XML_NAMED_ENTITIES[named.toLowerCase()]!;
        const codePoint = Number.parseInt((hex || decimal)!, hex ? 16 : 10);
        return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    });
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
