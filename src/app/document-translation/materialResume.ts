/**
 * @file src/app/document-translation/materialResume.ts
 * 文件职责：在文档组合根将文件内容身份、精确原文引用与材料位置连接，输出可明确展示的恢复结果。
 * 主要内容：精确引用调用文档公共解析契约，覆盖 PDF 页码、ePub 章节、DOCX 部分与 XLSX 工作表分页定位；旧记录只提供粗略页码或章节，失配引用不跨页寻找相同文字，也不建议自动覆盖旧定位。
 * 模块边界：不访问 DOM、Vue、数据库和网络，不控制阅读器初始化；调用方仍拥有恢复代次、挂载时序和用户确认。
 */
import {createDocumentMaterialReference, normalizeDocumentMaterialReference, resolveDocumentMaterialReference} from '@/src/features/document-translation/material/public';
import type {ParsedDocument} from '@/src/features/document-translation/public';
import type {MaterialLocator} from '@/src/features/vocabulary/materialProtocol';

export type DocumentMaterialResume =
    | {status: 'exact'; page: number; section?: string; segmentIndex: number; allowAutomaticPositionCapture: true}
    | {status: 'coarse'; page: number; section?: string; reason: 'page-or-section-hint'; allowAutomaticPositionCapture: false}
    | {status: 'unlocated'; reason: 'no-position' | 'invalid-position'; allowAutomaticPositionCapture: false}
    | {status: 'unresolved'; reason: 'file-identity' | 'invalid-reference' | 'source-changed-or-ambiguous'; allowAutomaticPositionCapture: false};

function segmentLocation(document: ParsedDocument, index: number, pageSize: number): {page: number; section?: string} | undefined {
    const binary = document.binary;
    if (binary?.kind === 'pdf') {
        const pages = binary.pages.filter(page => page.segmentIndexes.includes(index));
        return pages.length === 1 ? {page: pages[0].pageNumber} : undefined;
    }
    if (binary?.kind === 'epub') {
        const chapters = binary.chapters.flatMap((chapter, at) => index >= chapter.segmentOffset && index < chapter.segmentOffset + chapter.segmentCount ? [at] : []);
        return chapters.length === 1 ? {page: 1, section: `epub:${chapters[0]}`} : undefined;
    }
    if (binary?.kind === 'docx') {
        const paragraphs = binary.parts.flatMap((part, at) => part.paragraphSegments.flatMap((paragraph, paragraphIndex) => paragraph.segmentIndex === index ? [{at, paragraphIndex}] : []));
        return paragraphs.length === 1 ? {page: Math.floor(paragraphs[0].paragraphIndex / pageSize) + 1, section: `docx:${paragraphs[0].at}`} : undefined;
    }
    if (binary?.kind === 'xlsx') {
        const cells = binary.sheets.flatMap((sheet, at) => sheet.cellSegments.flatMap((cell, cellIndex) => cell.segmentIndex === index ? [{at, cellIndex}] : []));
        return cells.length === 1 ? {page: Math.floor(cells[0].cellIndex / pageSize) + 1, section: `xlsx:${cells[0].at}`} : undefined;
    }
    return {page: Math.floor(index / pageSize) + 1};
}

/** 片段索引仅用于当前模型采集；保存的是文件摘要与稳定原文引用。预算过大的原文保持可见粗略位置。 */
export function captureDocumentMaterialLocator(historyId: string, document: ParsedDocument, segmentIndex: number, pageSize = 80): MaterialLocator | undefined {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(segmentIndex) || segmentIndex < 0) return;
    const reference = createDocumentMaterialReference(historyId, document, segmentIndex);
    const location = reference && segmentLocation(document, segmentIndex, pageSize);
    if (!reference || !location) return;
    const exact = normalizeDocumentMaterialReference(reference, historyId);
    return {kind: 'document', fingerprint: historyId, ...location, quote: reference.locator.source.slice(0, 6000), ...(exact ? {documentReference: exact} : {})};
}

/** 文件内容摘要必须来自 task.historyId/history.id；history.fingerprint 只描述翻译配置，不能传入。 */
export function resolveMaterialDocumentResume(locator: MaterialLocator | undefined, historyId: string, document: ParsedDocument, pageSize = 80): DocumentMaterialResume {
    const unresolved = (reason: Extract<DocumentMaterialResume, {status: 'unresolved'}>['reason']): DocumentMaterialResume => ({status: 'unresolved', reason, allowAutomaticPositionCapture: false});
    const unlocated = (reason: 'no-position' | 'invalid-position'): DocumentMaterialResume => ({status: 'unlocated', reason, allowAutomaticPositionCapture: false});
    if (!/^[a-f\d]{32}$/u.test(historyId) || locator?.fingerprint && locator.fingerprint !== historyId) return unresolved('file-identity');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || locator && locator.kind !== 'document') return unlocated('invalid-position');
    if (locator?.documentReference !== undefined) {
        const reference = normalizeDocumentMaterialReference(locator.documentReference, historyId);
        if (!reference) return unresolved('invalid-reference');
        const index = resolveDocumentMaterialReference(reference, historyId, document);
        const position = index === undefined ? undefined : segmentLocation(document, index, pageSize);
        return index !== undefined && position ? {status: 'exact', ...position, segmentIndex: index, allowAutomaticPositionCapture: true}
            : unresolved('source-changed-or-ambiguous');
    }
    if (!locator || locator.page === undefined && locator.section === undefined) return unlocated('no-position');
    const binary = document.binary;
    let section: string | undefined, maxPage: number;
    if (binary?.kind === 'epub' || binary?.kind === 'docx' || binary?.kind === 'xlsx') {
        const prefix = binary.kind;
        const input = locator.section;
        const pattern = prefix === 'epub' ? /^(?:epub:)?(\d+)$/u : prefix === 'docx' ? /^docx:(\d+)$/u : /^xlsx:(\d+)$/u;
        const match = typeof input === 'string' ? pattern.exec(input) : undefined;
        if (!match) return unlocated('invalid-position');
        const at = Number(match[1]);
        const count = binary.kind === 'epub' ? binary.chapters.length : binary.kind === 'docx' ? binary.parts.length : binary.sheets.length;
        if (!Number.isSafeInteger(at) || at >= count) return unlocated('invalid-position');
        section = `${prefix}:${at}`;
        maxPage = binary.kind === 'epub'
            ? 1
            : binary.kind === 'docx'
                ? Math.max(1, Math.ceil(binary.parts[at].paragraphSegments.length / pageSize))
                : Math.max(1, Math.ceil(binary.sheets[at].cellSegments.length / pageSize));
    } else {
        if (locator.section !== undefined) return unlocated('invalid-position');
        maxPage = binary?.kind === 'pdf' ? binary.pages.length : Math.max(1, Math.ceil(document.segments.length / pageSize));
    }
    const page = locator.page ?? (section ? 1 : undefined);
    if (page === undefined || !Number.isSafeInteger(page) || page < 1 || page > maxPage) return unlocated('invalid-position');
    return {status: 'coarse', page, ...(section ? {section} : {}), reason: 'page-or-section-hint', allowAutomaticPositionCapture: false};
}
