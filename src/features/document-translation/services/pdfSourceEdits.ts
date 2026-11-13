/**
 * @file src/features/document-translation/services/pdfSourceEdits.ts
 * 文件职责：以不可变事务处理扫描 PDF 的逐行原文校订、撤销和显式重新识别后的人工内容保留。
 * 主要内容：校订沿用实际行框与原文拼接规则，仅使受影响译文失效；备份未校订文字和核对位置，旧译文及无译文的人工原文均保留到既有修订列表。重新识别只按同一文件、页和唯一几何匹配人工校订，未能对应的内容保留供复制，普通页面继续使用既有翻译迁移。
 * 模块边界：不渲染、识别、翻译或保存文件，不更改原始 PDF bytes、不修改输入对象；任务资格、界面操作和历史写入由现有应用工作流负责。
 */
import type {ParsedDocument, PdfDocumentBlock, PdfDocumentLine, PdfDocumentPage} from '../core/document';
import {joinPdfSourceLines} from '../core/pdfLayoutAnalysis';
import {normalizeDocumentRetainedRevisions, type DocumentRetainedRevision} from './history';
import {remapPdfTranslationState} from './pdfOcr';

export const PDF_SOURCE_EDIT_MAX_CHARS = 12_000;
export interface PdfSourceEditState {translations: readonly string[]; confirmedTranslationIds: readonly number[]; retainedRevisions?: readonly DocumentRetainedRevision[]}
export interface PdfSourceEditResult {document: ParsedDocument; translations: string[]; confirmedTranslationIds: number[]; retainedRevisions: DocumentRetainedRevision[]}
type Region = NonNullable<PdfDocumentPage['ocrReviewRegions']>[number];
const inside = (region: Region, block: PdfDocumentBlock) => region.x >= block.x && region.y >= block.y
    && region.x + region.width <= block.x + block.width && region.y + region.height <= block.y + block.height;
const sameGeometry = (a: PdfDocumentBlock, b: PdfDocumentBlock) => (['x', 'y', 'width', 'height'] as const).every(key => a[key] === b[key])
    && (a.segmentIndex >= 0) === (b.segmentIndex >= 0);
const sourceOf = (document: ParsedDocument, block: PdfDocumentBlock) => block.segmentIndex >= 0 ? document.segments[block.segmentIndex]?.source ?? '' : block.source ?? '';
const snapshot = (document: ParsedDocument, state: PdfSourceEditState): PdfSourceEditResult => ({document, translations: [...state.translations],
    confirmedTranslationIds: [...state.confirmedTranslationIds], retainedRevisions: normalizeDocumentRetainedRevisions(state.retainedRevisions ?? [])});

export function validPdfSourceEditLines(values: readonly string[], count: number): boolean {
    return values.length === count && !values.some(value => typeof value !== 'string' || /[\p{Cs}\u0000-\u001f\u007f-\u009f]/u.test(value))
        && values.reduce((total, value) => total + value.length, 0) <= PDF_SOURCE_EDIT_MAX_CHARS && values.some(value => value.trim());
}

export function pdfSourceEditTarget(document: ParsedDocument, pageNumber: number, blockIndex: number) {
    if (document.binary?.kind !== 'pdf' || !Number.isInteger(blockIndex) || blockIndex < 0) return;
    const page = document.binary.pages.find(page => page.pageNumber === pageNumber), block = page?.blocks[blockIndex];
    if (!page || page.scanned || !page.ocrRecognized && page.ocrReviewRegions === undefined || !block?.lines?.length) return;
    return {page, block, blockIndex, source: sourceOf(document, block)};
}

function retain(document: ParsedDocument, page: PdfDocumentPage, blockIndex: number, state: PdfSourceEditState): DocumentRetainedRevision[] {
    const block = page.blocks[blockIndex], translation = block.segmentIndex >= 0 ? state.translations[block.segmentIndex] ?? '' : '';
    if (!translation.trim() && !block.sourceCorrection) return [];
    return [{source: sourceOf(document, block), translation, ...(block.sourceCorrection ? {kind: 'source' as const} : {}), pageNumber: page.pageNumber, blockNumber: blockIndex + 1}];
}

function replaceBlock(document: ParsedDocument, page: PdfDocumentPage, blockIndex: number, block: PdfDocumentBlock, reviewRegions: Region[]): ParsedDocument {
    const binary = document.binary as Extract<ParsedDocument['binary'], {kind: 'pdf'}>;
    return {...document, segments: document.segments.map(segment => segment.id === block.segmentIndex ? {...segment, source: block.source!} : segment),
        binary: {...binary, pages: binary.pages.map(current => current === page ? {...page, blocks: page.blocks.map((old, index) => index === blockIndex ? block : old), ocrReviewRegions: reviewRegions} : current)}};
}

/** 一行对应一个原图框；不接受控制码、孤立代理项、空段落或无界输入。 */
export function correctPdfSourceLines(document: ParsedDocument, pageNumber: number, blockIndex: number, values: readonly string[], state: PdfSourceEditState): PdfSourceEditResult | null {
    const target = pdfSourceEditTarget(document, pageNumber, blockIndex);
    if (!target || !validPdfSourceEditLines(values, target.block.lines!.length)) return null;
    const {page, block, source: previousSource} = target;
    const lines: PdfDocumentLine[] = block.lines!.map((line, index) => line.text === values[index].trim() ? line : {...line, text: values[index].trim(), runs: [{
        text: values[index].trim(), x: line.x, y: line.y, width: line.width, height: line.height,
        fontSize: line.fontSize ?? block.fontSize, baseline: line.baseline ?? line.y + line.height, fontFamily: line.fontFamily ?? block.fontFamily,
    }]});
    const source = joinPdfSourceLines(lines, block.kind).trim();
    if (!source) return null;
    const review = page.ocrReviewRegions ?? [], remaining = review.filter(region => !inside(region, block));
    if (block.sourceCorrection && source === previousSource && lines.every((line, index) => line === block.lines![index]) && remaining.length === review.length) return snapshot(document, state);
    const nextBlock = {...block, source, lines, lineCount: lines.length,
        sourceCorrection: block.sourceCorrection ?? {source: previousSource, lines: block.lines!, reviewRegions: review.filter(region => inside(region, block))}};
    const result = snapshot(replaceBlock(document, page, blockIndex, nextBlock, remaining), state);
    if (source !== previousSource) {
        result.retainedRevisions = normalizeDocumentRetainedRevisions([...result.retainedRevisions, ...retain(document, page, blockIndex, state)]);
        if (block.segmentIndex >= 0) {result.translations[block.segmentIndex] = ''; result.confirmedTranslationIds = result.confirmedTranslationIds.filter(id => id !== block.segmentIndex);}
    }
    return result;
}

export function restorePdfSourceLines(document: ParsedDocument, pageNumber: number, blockIndex: number, state: PdfSourceEditState): PdfSourceEditResult | null {
    const target = pdfSourceEditTarget(document, pageNumber, blockIndex), backup = target?.block.sourceCorrection;
    if (!target || !backup || typeof backup.source !== 'string' || !Array.isArray(backup.lines) || !backup.lines.length || !Array.isArray(backup.reviewRegions)) return null;
    const {page, block} = target, {sourceCorrection: _correction, ...rest} = block;
    const review = [...(page.ocrReviewRegions ?? [])];
    for (const region of backup.reviewRegions) if (!review.some(value => (['x', 'y', 'width', 'height'] as const).every(key => value[key] === region[key]))) review.push(region);
    const result = snapshot(replaceBlock(document, page, blockIndex, {...rest, source: backup.source, lines: backup.lines, lineCount: backup.lines.length}, review), state);
    result.retainedRevisions = normalizeDocumentRetainedRevisions([...result.retainedRevisions, ...retain(document, page, blockIndex, state)]);
    if (target.source !== backup.source && block.segmentIndex >= 0) {result.translations[block.segmentIndex] = ''; result.confirmedTranslationIds = result.confirmedTranslationIds.filter(id => id !== block.segmentIndex);}
    return result;
}

/** 重新识别只替换指定页；唯一同框的人工原文优先，其余旧内容仍进入修订列表。 */
export function reconcilePdfRecognition(previous: ParsedDocument, recognized: ParsedDocument, pageNumber: number, state: PdfSourceEditState): PdfSourceEditResult | null {
    if (previous.binary?.kind !== 'pdf' || recognized.binary?.kind !== 'pdf' || previous.binary.bytes !== recognized.binary.bytes) return null;
    const previousBinary = previous.binary, recognizedBinary = recognized.binary;
    const page = previous.binary.pages.find(page => page.pageNumber === pageNumber), nextPage = recognized.binary.pages.find(page => page.pageNumber === pageNumber);
    if (!page || !nextPage || previous.binary.pages.length !== recognized.binary.pages.length) return null;
    if (previous === recognized) return snapshot(previous, state);
    if (previousBinary.pages.some(old => old.pageNumber !== pageNumber && !recognizedBinary.pages.some(next => next.pageNumber === old.pageNumber
        && old.blocks.length === next.blocks.length && old.blocks.every((block, index) => sameGeometry(block, next.blocks[index]) && sourceOf(previous, block) === sourceOf(recognized, next.blocks[index]))))) return null;
    let document = recognized;
    const blocks = [...nextPage.blocks];
    let review = [...(nextPage.ocrReviewRegions ?? [])];
    for (const block of page.blocks) {
        if (!block.sourceCorrection || !block.lines?.length || page.blocks.filter(other => sameGeometry(block, other)).length !== 1) continue;
        const candidates = blocks.flatMap((next, index) => sameGeometry(block, next) && next.lines?.length ? [index] : []);
        if (candidates.length !== 1) continue;
        const index = candidates[0], next = blocks[index];
        blocks[index] = {...next, source: sourceOf(previous, block), lines: block.lines, lineCount: block.lines.length,
            sourceCorrection: {source: sourceOf(recognized, next), lines: next.lines!, reviewRegions: review.filter(region => inside(region, next))}};
        review = review.filter(region => !inside(region, next));
    }
    document = {...recognized, segments: recognized.segments.map(segment => {
        const corrected = blocks.find(block => block.segmentIndex === segment.id && block.sourceCorrection);
        return corrected ? {...segment, source: corrected.source!} : segment;
    }), binary: {...recognized.binary, pages: recognized.binary.pages.map(page => page === nextPage ? {...nextPage, blocks, ocrReviewRegions: review} : page)}};
    const mapped = remapPdfTranslationState(previous, document, state.translations, state.confirmedTranslationIds);
    const targetIds = new Set(nextPage.segmentIndexes);
    for (const index of targetIds) mapped.translations[index] = '';
    mapped.confirmedTranslationIds = mapped.confirmedTranslationIds.filter(id => !targetIds.has(id));
    const retained = [...(state.retainedRevisions ?? [])], confirmed = new Set(state.confirmedTranslationIds);
    page.blocks.forEach((block, index) => {
        const matches = blocks.filter(next => sameGeometry(block, next) && sourceOf(previous, block) === sourceOf(document, next));
        const unique = page.blocks.filter(other => sameGeometry(block, other)).length === 1 && matches.length === 1;
        if (unique && block.segmentIndex >= 0) {
            const target = matches[0].segmentIndex, translation = state.translations[block.segmentIndex] ?? '';
            mapped.translations[target] = translation;
            if (translation.trim() && confirmed.has(block.segmentIndex)) mapped.confirmedTranslationIds.push(target);
        } else if (!unique) retained.push(...retain(previous, page, index, state));
    });
    return {document, ...mapped, retainedRevisions: normalizeDocumentRetainedRevisions(retained)};
}
