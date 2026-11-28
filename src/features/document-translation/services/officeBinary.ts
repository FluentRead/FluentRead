/**
 * @file src/features/document-translation/services/officeBinary.ts
 * 文件职责：负责 PowerPoint PPTX 与 Excel XLSX 二进制压缩包文档的受限解析、文本提取、译文回填与流式归档打包。
 * 主要内容：按演示清单或编号解析幻灯片与演讲者备注，按工作簿顺序解析多工作表与共享/行内字符串，并在导出时安全追加共享字符串表同时保留未改资源压缩方式。
 * 模块边界：仅承担 PPTX/XLSX 二进制解析与导出，XML 节点解析委托 core/pptxXml 与 core/xlsxXml，压缩包安全校验复用 binaryShared。
 */
import type JSZip from 'jszip';
import {generateDocumentArchive, preserveStoredDocumentEntries} from './archive';
import {
    getDocumentFormatLabel,
    getDocumentMimeType,
    type DocumentRenderMode,
    type DocumentSegment,
    type ParsedDocument,
    type PptxDocumentPart,
    type XlsxDocumentSheet,
} from '@/src/features/document-translation/core/document';
import {
    assertArchiveSafety,
    awaitDocumentRead,
    readArchiveText,
    yieldDocumentTask,
    type CreateDocumentDownloadOptions,
} from './binaryShared';

export async function parsePptx(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await awaitDocumentRead(JSZip.loadAsync(bytes), signal);
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`PPTX 解析失败：${String(error)}`);
    }
    signal?.throwIfAborted();
    assertArchiveSafety(zip, 'PPTX');

    const availablePaths = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([path]) => path);
    const hasSlide = availablePaths.some(path => /^ppt\/slides\/slide\d+\.xml$/iu.test(path));
    if (!zip.file('[Content_Types].xml') || (!zip.file('ppt/presentation.xml') && !hasSlide)) {
        throw new Error('PPTX 文件结构无效，文件可能已损坏或扩展名不正确');
    }

    const {parsePptxPartXml, parsePptxPresentationSlides, parsePptxSlideNotesTarget, resolveOpcTargetPath} = await import('../core/pptxXml');
    const presentationEntry = zip.file('ppt/presentation.xml');
    const presentationRelsEntry = zip.file('ppt/_rels/presentation.xml.rels');
    const presentationXml = presentationEntry ? await readArchiveText(presentationEntry, signal) : undefined;
    const presentationRelsXml = presentationRelsEntry ? await readArchiveText(presentationRelsEntry, signal) : undefined;
    const slideEntries = parsePptxPresentationSlides(presentationXml, presentationRelsXml, availablePaths);

    const explicitNotesBySlide = new Map<string, string>();
    const claimedNotes = new Set<string>();
    for (const {path} of slideEntries) {
        const slash = path.lastIndexOf('/');
        const relsPath = `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
        const relsEntry = zip.file(relsPath);
        if (!relsEntry) continue;
        const target = parsePptxSlideNotesTarget(await readArchiveText(relsEntry, signal));
        if (!target) continue;
        const resolved = resolveOpcTargetPath(path, target);
        if (zip.file(resolved) && !claimedNotes.has(resolved)) {
            explicitNotesBySlide.set(path, resolved);
            claimedNotes.add(resolved);
        }
    }

    const orderedParts: Array<{path: string; kind: 'slide' | 'notes'; slideNumber: number}> = [];
    const seenNotes = new Set<string>();

    for (const {path, slideNumber} of slideEntries) {
        orderedParts.push({path, kind: 'slide', slideNumber});
        let notesPath = explicitNotesBySlide.get(path);
        if (!notesPath) {
            const fileNumber = /^ppt\/slides\/slide(\d+)\.xml$/iu.exec(path)?.[1];
            const fallbackNotes = fileNumber ? `ppt/notesSlides/notesSlide${fileNumber}.xml` : undefined;
            if (fallbackNotes && !claimedNotes.has(fallbackNotes) && zip.file(fallbackNotes)) notesPath = fallbackNotes;
        }
        if (notesPath && !seenNotes.has(notesPath)) {
            seenNotes.add(notesPath);
            orderedParts.push({path: notesPath, kind: 'notes', slideNumber});
        }
    }

    const extraNotes = availablePaths
        .map(path => ({path, match: /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/iu.exec(path)}))
        .filter((item): item is {path: string; match: RegExpExecArray} => Boolean(item.match) && !seenNotes.has(item.path))
        .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    for (const {path, match} of extraNotes) {
        orderedParts.push({path, kind: 'notes', slideNumber: Number(match[1])});
    }

    const segments: DocumentSegment[] = [];
    const parts: PptxDocumentPart[] = [];
    for (const entry of orderedParts) {
        signal?.throwIfAborted();
        const source = await readArchiveText(zip.file(entry.path)!, signal);
        const extracted = parsePptxPartXml(source, entry.kind);
        if (extracted.length === 0) continue;
        const label = entry.kind === 'notes' ? `Slide ${entry.slideNumber} Notes` : `Slide ${entry.slideNumber}`;
        const paragraphSegments: PptxDocumentPart['paragraphSegments'] = [];
        extracted.forEach((paragraph, index) => {
            const segmentIndex = segments.length;
            segments.push({
                id: segmentIndex,
                source: paragraph.text,
                contextLabel: index === 0 ? label : undefined,
                pathLabel: label,
                role: paragraph.role,
            });
            paragraphSegments.push({paragraphIndex: paragraph.paragraphIndex, segmentIndex});
        });
        parts.push({path: entry.path, source, kind: entry.kind, slideNumber: entry.slideNumber, paragraphSegments});
    }

    if (segments.length === 0) throw new Error('PPTX 中没有找到可翻译的幻灯片文字');
    return {
        fileName,
        format: 'pptx',
        label: getDocumentFormatLabel('pptx'),
        parts: [],
        segments,
        binary: {kind: 'pptx', bytes, parts},
    };
}

export async function parseXlsx(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
        const {default: JSZip} = await import('jszip');
        zip = await awaitDocumentRead(JSZip.loadAsync(bytes), signal);
    } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`XLSX 解析失败：${String(error)}`);
    }
    signal?.throwIfAborted();
    assertArchiveSafety(zip, 'XLSX');

    const availablePaths = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([path]) => path);
    const hasWorksheet = availablePaths.some(path => /^xl\/worksheets\/sheet\d+\.xml$/iu.test(path));
    if (!zip.file('[Content_Types].xml') || (!zip.file('xl/workbook.xml') && !hasWorksheet)) {
        throw new Error('XLSX 文件结构无效，文件可能已损坏或扩展名不正确');
    }

    const {parseXlsxSharedStrings, parseXlsxWorkbookSheets, parseXlsxWorksheetXml} = await import('../core/xlsxXml');
    const workbookEntry = zip.file('xl/workbook.xml');
    const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
    const workbookXml = workbookEntry ? await readArchiveText(workbookEntry, signal) : undefined;
    const relsXml = relsEntry ? await readArchiveText(relsEntry, signal) : undefined;
    const descriptors = parseXlsxWorkbookSheets(workbookXml, relsXml, availablePaths);

    const sharedStringsEntry = zip.file('xl/sharedStrings.xml');
    const sharedStringsSource = sharedStringsEntry ? await readArchiveText(sharedStringsEntry, signal) : undefined;
    const sharedStrings = sharedStringsSource ? parseXlsxSharedStrings(sharedStringsSource) : [];

    const segments: DocumentSegment[] = [];
    const sheets: XlsxDocumentSheet[] = [];
    for (const descriptor of descriptors) {
        signal?.throwIfAborted();
        const source = await readArchiveText(zip.file(descriptor.path)!, signal);
        const cells = parseXlsxWorksheetXml(source, sharedStrings);
        if (cells.length === 0) continue;
        const cellSegments: XlsxDocumentSheet['cellSegments'] = [];
        for (const cell of cells) {
            const segmentIndex = segments.length;
            const label = `${descriptor.name}!${cell.cellRef}`;
            segments.push({
                id: segmentIndex,
                source: cell.source,
                contextLabel: label,
                pathLabel: label,
            });
            cellSegments.push({
                cellRef: cell.cellRef,
                kind: cell.kind,
                ...(cell.sharedIndex !== undefined ? {sharedIndex: cell.sharedIndex} : {}),
                segmentIndex,
            });
        }
        sheets.push({name: descriptor.name, path: descriptor.path, source, cellSegments});
    }

    if (segments.length === 0) throw new Error('XLSX 中没有找到可翻译的单元格文字');
    return {
        fileName,
        format: 'xlsx',
        label: getDocumentFormatLabel('xlsx'),
        parts: [],
        segments,
        binary: {
            kind: 'xlsx',
            bytes,
            sheets,
            ...(sharedStringsSource !== undefined ? {sharedStringsPath: 'xl/sharedStrings.xml', sharedStringsSource} : {}),
        },
    };
}

export async function renderPptx(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    if (document.binary?.kind !== 'pptx') throw new Error('PPTX 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    options.signal?.throwIfAborted();
    const zip = await awaitDocumentRead(JSZip.loadAsync(document.binary.bytes), options.signal);
    options.signal?.throwIfAborted();
    assertArchiveSafety(zip, 'PPTX');
    const {renderPptxPartXml} = await import('../core/pptxXml');
    preserveStoredDocumentEntries(zip, document.binary.bytes, new Set(document.binary.parts.map(part => part.path)));
    for (const part of document.binary.parts) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        const updated = renderPptxPartXml(part.source, part.paragraphSegments, document.segments, translations, mode);
        zip.file(part.path, updated, {createFolders: false});
    }
    return generateDocumentArchive(zip, {
        mimeType: getDocumentMimeType('pptx'),
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
}

export async function renderXlsx(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode,
    options: CreateDocumentDownloadOptions,
): Promise<Uint8Array> {
    if (document.binary?.kind !== 'xlsx') throw new Error('XLSX 文档状态无效，请重新打开文件');
    const {default: JSZip} = await import('jszip');
    options.signal?.throwIfAborted();
    const zip = await awaitDocumentRead(JSZip.loadAsync(document.binary.bytes), options.signal);
    options.signal?.throwIfAborted();
    assertArchiveSafety(zip, 'XLSX');
    const {appendXlsxSharedStringsXml, parseXlsxSharedStrings, renderXlsxWorksheetXml} = await import('../core/xlsxXml');
    const sharedStringsSource = document.binary.sharedStringsSource;
    const sharedStrings = sharedStringsSource ? parseXlsxSharedStrings(sharedStringsSource) : [];
    const appendedStrings: string[] = [];
    const appendedIndexByValue = new Map<string, number>();
    const appendSharedString = (value: string): number => {
        const existing = appendedIndexByValue.get(value);
        if (existing !== undefined) return existing;
        const index = sharedStrings.length + appendedStrings.length;
        appendedStrings.push(value);
        appendedIndexByValue.set(value, index);
        return index;
    };

    const changedPaths = new Set<string>();
    for (const sheet of document.binary.sheets) {
        await yieldDocumentTask();
        options.signal?.throwIfAborted();
        const updated = renderXlsxWorksheetXml(
            sheet.source,
            sheet.cellSegments,
            document.segments,
            translations,
            sharedStrings,
            mode,
            appendSharedString,
        );
        if (updated !== sheet.source) {
            zip.file(sheet.path, updated, {createFolders: false});
            changedPaths.add(sheet.path);
        }
    }
    if (appendedStrings.length > 0 && document.binary.sharedStringsPath && sharedStringsSource !== undefined) {
        const updatedShared = appendXlsxSharedStringsXml(sharedStringsSource, appendedStrings, sharedStrings.length);
        zip.file(document.binary.sharedStringsPath, updatedShared, {createFolders: false});
        changedPaths.add(document.binary.sharedStringsPath);
    }
    preserveStoredDocumentEntries(zip, document.binary.bytes, changedPaths);
    return generateDocumentArchive(zip, {
        mimeType: getDocumentMimeType('xlsx'),
        compression: 'DEFLATE',
        compressionOptions: {level: 3},
    }, {signal: options.signal, onProgress: options.onArchiveProgress});
}
