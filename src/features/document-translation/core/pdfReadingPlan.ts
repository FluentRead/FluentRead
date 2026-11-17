/**
 * @file src/features/document-translation/core/pdfReadingPlan.ts
 * 空页边界：没有可重排文字或图形区域的页面保留完整原图，使扫描件在识别前可阅读；使用未旋转的内容坐标供统一裁剪。
 * 文件职责：把 PDF 的阅读顺序、完整译文和需要保留的原图区域组织为阅读器与导出共用的纯数据计划。
 * 主要内容：保持稳定的页与片段标识，为没有翻译片段的作者及页脚保留原文与独立块标识，优先采用解析器的多栏顺序；完整段落不缩小、不截断；公式、表格、图形及含不可显示控制编码的未译源块以原坐标区域保留，再把空间相连的数学区域合为完整原图，区域中的有效译文仍作为独立段落呈现；裁剪无效或越界几何并避免相同原图重复输出。
 * 模块边界：不测量字体、不创建 DOM 或 Canvas、不调用翻译和文件 I/O；浏览器阅读与分页导出分别消费相同的文字及原图条目。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type {ParsedDocument, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {groupPdfReadingRegions} from './pdfReadingRegions';
import type {PdfReadingEntry, PdfReadingRect, PdfReadingRegionEntry, PdfReadingTextEntry} from './pdfReadingRegions';
export type {PdfReadingEntry, PdfReadingRect, PdfReadingRegionEntry, PdfReadingTextEntry} from './pdfReadingRegions';

export type PdfReadingPresentation = 'readable' | 'layout';
export interface PdfReadingPlan {pageNumber: number; entries: PdfReadingEntry[]; hasTranslation: boolean}

type PreservedRegion = PdfReadingRect & {id?: string; kind: string};
// C0（保留 TAB/LF/CR）、DEL 与 C1 可能来自原 PDF 的特殊字形编码；不猜测它对应哪个 Unicode 符号。
const SOURCE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/** 区域始终采用 rotation=0 的内容坐标，展示和导出在各自边界处理页面旋转。 */
function boundedRect(rect: PdfReadingRect, page: PdfDocumentPage): PdfReadingRect | undefined {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    const rotated = page.rotation === 90 || page.rotation === 270;
    const pageWidth = rotated ? page.height : page.width;
    const pageHeight = rotated ? page.width : page.height;
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(pageWidth, rect.x + rect.width), bottom = Math.min(pageHeight, rect.y + rect.height);
    if (right <= x || bottom <= y) return;
    return {x, y, width: right - x, height: bottom - y};
}

function containsRect(container: PdfReadingRect, rect: PdfReadingRect): boolean {
    return rect.x >= container.x - 1 && rect.y >= container.y - 1
        && rect.x + rect.width <= container.x + container.width + 1
        && rect.y + rect.height <= container.y + container.height + 1;
}

export function buildPdfReadingPlan(document: ParsedDocument, page: PdfDocumentPage, translations: readonly string[]): PdfReadingPlan {
    const blocks = page.blocks.map((block, index) => ({block, index, order: block.readingOrder ?? index})).sort((a, b) => a.order - b.order || a.index - b.index);
    // 非翻译块的 segmentIndex 为 -1；解析器仍在块上保留完整 source，不能因此漏掉作者、机构和页码。
    const sourceOf = (block: PdfDocumentPage['blocks'][number]) => document.segments[block.segmentIndex]?.source
        ?? block.source ?? (block.lines ?? []).map(line => line.text).join(' ');
    const regions: Array<{entry: PdfReadingRegionEntry; order: number}> = [];
    const sourceControlIndexes = new Set<number>();
    const addRegion = (input: PreservedRegion, order: number, indexes: number[]) => {
        const rect = boundedRect(input, page);
        if (!rect || regions.some(({entry}) => containsRect(entry.sourceRect, rect))) return;
        const role = input.kind;
        regions.push({order, entry: {kind: 'region', id: `pdf-${page.pageNumber}-region-${input.id ?? regions.length}`, pageNumber: page.pageNumber, role, sourceRect: rect, segmentIndexes: [...new Set(indexes.filter(index => index >= 0))]}});
    };
    for (const region of page.preservedRegions ?? []) {
        const linked = blocks.filter(({block}) => containsRect(region, block));
        const next = blocks.find(({block}) => block.y >= region.y);
        const order = linked[0]?.order ?? next?.order ?? blocks.length;
        addRegion(region, order - 0.25, linked.map(({block}) => block.segmentIndex));
    }
    for (const {block, order} of blocks) {
        const source = sourceOf(block);
        const preserveControlSource = SOURCE_CONTROL.test(source) && !hasDistinctTranslation(source, translations[block.segmentIndex]);
        if (preserveControlSource && block.segmentIndex >= 0) sourceControlIndexes.add(block.segmentIndex);
        if ((block.kind === 'metadata' || block.kind === 'footer') && !preserveControlSource) continue;
        if (block.preserveSource || block.kind === 'formula' || block.kind === 'table' || block.kind === 'figure-label' || preserveControlSource) {
            addRegion({...block, kind: block.kind ?? 'figure'}, order - 0.2, [block.segmentIndex]);
        }
    }
    let hasTranslation = false;
    const text = blocks.flatMap(({block, index, order}) => {
        const source = sourceOf(block);
        const literal = block.kind === 'metadata' || block.kind === 'footer';
        const translated = !literal && hasDistinctTranslation(source, translations[block.segmentIndex]);
        if (translated) hasTranslation = true;
        const protectedSource = (!literal || SOURCE_CONTROL.test(source)) && regions.some(({entry}) => containsRect(entry.sourceRect, block));
        // 公式与表格的未译源内容已经完整保留在原图中，不能再次串成普通段落。
        if ((!source && !translated) || (protectedSource && !translated)) return [];
        const sourceRect = boundedRect(block, page) ?? {x: 0, y: 0, width: 1, height: 1};
        const entry: PdfReadingTextEntry = {kind: 'text', id: `pdf-${page.pageNumber}-${block.segmentIndex >= 0 ? `segment-${block.segmentIndex}` : `block-${index}`}`, pageNumber: page.pageNumber, segmentIndex: block.segmentIndex,
            role: block.kind ?? document.segments[block.segmentIndex]?.role ?? 'paragraph', source,
            text: `${block.listMarker ? `${block.listMarker} ` : ''}${translated ? translations[block.segmentIndex] : source}`.replace(/\u00AD/gu, ''), translated, sourceRect};
        return [{entry, order}];
    });
    // 原保护规则先确定全部文字；合并后的图片范围不能再参与文字删减。
    const entries = groupPdfReadingRegions(page, [...regions, ...text].sort((left, right) => left.order - right.order).map(({entry}) => entry), sourceControlIndexes);
    // 扫描页或没有可提取内容的页面仍可先读原图，不能在原文重排时变成空白页。
    if (!entries.length) entries.push({kind: 'region', id: `pdf-${page.pageNumber}-region-page`, pageNumber: page.pageNumber, role: 'figure', segmentIndexes: [],
        sourceRect: {x: 0, y: 0, width: page.rotation === 90 || page.rotation === 270 ? page.height : page.width,
            height: page.rotation === 90 || page.rotation === 270 ? page.width : page.height}});
    return {pageNumber: page.pageNumber, entries, hasTranslation};
}
