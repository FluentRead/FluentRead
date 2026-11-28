/**
 * @file src/features/document-translation/services/binary.ts
 * 文件职责：作为 PDF、EPUB、DOCX 二进制文档与纯文本文件的统一导入导出门面，校验字节大小与编码并按格式分发到各独立子服务。
 * 主要内容：提供 parseBinaryDocument、parseDocumentFile 与 createDocumentDownload 公共入口，识别 UTF-8 与带 BOM 的 UTF-16 文本并统一导出 PDF、EPUB、DOCX 辅助函数与类型定义。
 * 模块边界：仅负责格式分发、编码解码与公共契约导出，具体二进制解析与导出实现分别归属 binaryShared、pdfParse、pdfExport、epubBinary 与 docxBinary。
 */
import {
    createDocumentDownloadName,
    getDocumentFormat,
    getDocumentMimeType,
    parseDocument,
    renderDocument,
    resolveDocumentTranslation,
    type DocumentRenderMode,
    type ParsedDocument,
} from '@/src/features/document-translation/core/document';
import {
    assertArchiveSafety,
    assertDocumentSize,
    awaitDocumentRead,
    isBinaryDocumentFormat,
    median,
    normalizeZipPath,
    parseXmlAttributes,
    resolveZipPath,
    toUint8Array,
    xmlDecode,
    xmlEscape,
    yieldDocumentTask,
    type CreateDocumentDownloadOptions,
    type DocumentDownload,
    type DocumentFileLike,
    type ParseDocumentFileOptions,
    type PdfExportProgress,
    type PdfOverflowNote,
    type PdfPageRasterizer,
    type PdfRasterPageInput,
    type PdfRasterPageResult,
    type PdfRasterTextItem,
    type PdfReadingRasterPage,
    type PdfReadingRasterizer,
    type PdfReadingRenderedPage,
    type PdfReadingRenderer,
    type PdfTextAtom,
    type PdfTextItem,
    type PdfTextLine,
    type PdfTextStyle,
} from './binaryShared';
import {
    parsePdf,
    pdfPageSegments,
    pdfPageTextGeometry,
    pdfTextAtoms,
    pdfTextBlocks,
    pdfTextLines,
} from './pdfParse';
import {renderPdf} from './pdfExport';
import {chapterTitle, parseEpub, renderEpub} from './epubBinary';
import {
    docxParagraphRole,
    docxParagraphText,
    docxPartTitle,
    docxTextNodes,
    parseDocx,
    renderDocx,
    renderDocxPart,
} from './docxBinary';

export {
    assertArchiveSafety,
    chapterTitle,
    docxParagraphRole,
    docxParagraphText,
    docxPartTitle,
    docxTextNodes,
    isBinaryDocumentFormat,
    median,
    normalizeZipPath,
    parseXmlAttributes,
    pdfPageSegments,
    pdfPageTextGeometry,
    pdfTextAtoms,
    pdfTextBlocks,
    pdfTextLines,
    renderDocxPart,
    resolveZipPath,
    xmlDecode,
    xmlEscape,
    type CreateDocumentDownloadOptions,
    type DocumentDownload,
    type DocumentFileLike,
    type ParseDocumentFileOptions,
    type PdfExportProgress,
    type PdfOverflowNote,
    type PdfPageRasterizer,
    type PdfRasterPageInput,
    type PdfRasterPageResult,
    type PdfRasterTextItem,
    type PdfReadingRasterPage,
    type PdfReadingRasterizer,
    type PdfReadingRenderedPage,
    type PdfReadingRenderer,
    type PdfTextAtom,
    type PdfTextItem,
    type PdfTextLine,
    type PdfTextStyle,
};

export async function parseBinaryDocument(
    fileName: string,
    input: ArrayBuffer | Uint8Array,
    options: ParseDocumentFileOptions = {},
): Promise<ParsedDocument> {
    options.signal?.throwIfAborted();
    const format = getDocumentFormat(fileName);
    if (!format || !isBinaryDocumentFormat(format)) {
        throw new Error('该文件不是 PDF、ePub 或 DOCX 二进制文档');
    }
    assertDocumentSize(input.byteLength, fileName);
    const bytes = toUint8Array(input);
    const parsed = await (format === 'pdf'
        ? parsePdf(fileName, bytes, options.signal, options.onPdfProgress)
        : format === 'epub'
            ? parseEpub(fileName, bytes, options.signal)
            : parseDocx(fileName, bytes, options.signal));
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
    // 原生 File.text() 固定按 UTF-8 解码，读不到旧字幕和笔记的 UTF-16 BOM。已有文本适配器继续提供解码后的字符串。
    const input = file instanceof Blob
        ? await awaitDocumentRead(file.arrayBuffer(), options.signal)
        : await awaitDocumentRead(file.text(), options.signal);
    options.signal?.throwIfAborted();
    let source: string;
    if (typeof input === 'string') {
        source = input;
        assertDocumentSize(source.length, file.name);
        assertDocumentSize(new TextEncoder().encode(source).byteLength, file.name);
    } else {
        assertDocumentSize(input.byteLength, file.name);
        const [first, second] = new Uint8Array(input, 0, Math.min(2, input.byteLength));
        const encoding = first === 0xff && second === 0xfe ? 'utf-16le'
            : first === 0xfe && second === 0xff ? 'utf-16be' : 'utf-8';
        try {
            source = new TextDecoder(encoding, {fatal: true, ignoreBOM: format === 'csv' || format === 'tsv'}).decode(input);
        } catch (error) {
            throw new Error('文件编码无效，请另存为 UTF-8 后重试', {cause: error});
        }
    }
    // 文档翻译页面按整句翻译 Markdown：一句话不会被行内链接和代码拆散。
    return parseDocument(file.name, source, {markdownSentences: true});
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
    const resolved = isBinaryDocumentFormat(document.format)
        ? document.segments.map(segment => resolveDocumentTranslation(segment.source, translations[segment.id]))
        : translations;
    let data: string | Uint8Array;
    if (document.format === 'pdf') {
        if (document.binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
        if (!options.pdfPageRasterizer && !options.pdfReadingRasterizer && !options.pdfReadingRenderer) {
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
