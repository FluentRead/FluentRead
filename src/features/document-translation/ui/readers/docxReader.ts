/**
 * @file src/features/document-translation/ui/readers/docxReader.ts
 *
 * 文件职责：解析 DOCX XML 的外链关系、有序列表编号、标题层级、行内格式 runs 与合并单元格表格，提供不拆表分页与多级目录构造器。
 * 主要内容：导出 parseDocxRelationshipsXml、parseDocxOrderedNumberingXml、buildDocxRichBlocks、paginateDocxBlocks、findDocxBlockPage 与 buildDocxOutline，将 DOCX 文档部件转换为富文本阅读块。
 * 模块边界：无浏览器副作用的纯数据转换模块，不解压 ZIP 压缩包、不操作 DOM，仅消费已解析的 DocxDocumentPart 与片段译文数组。
 */

import {hasDistinctTranslation} from '@/src/core/translation/result';
import {stripDocumentInlineMarkers, validateDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import {analyzeDocxInlineParagraph} from '../../core/docxInline';
import type {DocxDocumentPart, DocumentSegment} from '../../core/document';
import {clampPositiveInt} from './shared';

export interface DocxInlineRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    href?: string;
}

export interface DocxRichParagraph {
    segmentIndex: number;
    paragraphIndex: number;
    role: NonNullable<DocumentSegment['role']>;
    headingLevel?: number;
    listLevel?: number;
    listOrdered?: boolean;
    sourceText: string;
    translationText: string;
    hasDistinctTranslation: boolean;
    sourceRuns: DocxInlineRun[];
    translationRuns: DocxInlineRun[];
}

export interface DocxRichTableCell {
    colspan: number;
    paragraphs: DocxRichParagraph[];
}

export interface DocxRichTableRow {
    rowIndex: number;
    isHeader: boolean;
    cells: DocxRichTableCell[];
}

export type DocxRichBlock =
    | {kind: 'paragraph'; key: string; paragraph: DocxRichParagraph}
    | {kind: 'table'; key: string; tableIndex: number; rows: DocxRichTableRow[]; segmentCount: number};

export type DocxRelationshipMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface BuildDocxRichBlocksOptions {
    rels?: DocxRelationshipMap;
    orderedNumIds?: ReadonlySet<string>;
}

export interface PaginatedDocxBlocks {
    page: number;
    pageSize: number;
    totalPages: number;
    totalBlocks: number;
    blocks: DocxRichBlock[];
    pageRanges: Array<{page: number; startBlock: number; endBlock: number}>;
}

export interface DocxOutlineItem {
    partIndex: number;
    segmentIndex: number;
    level: number;
    source: string;
    translation: string;
}

const DOCX_PARAGRAPH_PATTERN = /<w:p(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/w:p\s*>)/gu;
const SAFE_DOCX_HREF_PATTERN = /^(?:https?:\/\/|mailto:|#)/iu;
const SAFE_DOCX_EXTERNAL_HREF_PATTERN = /^(?:https?:\/\/|mailto:)/iu;
const MAX_DOCX_GRID_SPAN = 100;

function extractDocxParagraphXmlList(source: string): string[] {
    const paragraphs: string[] = [];
    DOCX_PARAGRAPH_PATTERN.lastIndex = 0;
    let match = DOCX_PARAGRAPH_PATTERN.exec(source);
    while (match) {
        paragraphs.push(match[0]);
        match = DOCX_PARAGRAPH_PATTERN.exec(source);
    }
    return paragraphs;
}

function isDocxToggleOn(properties: string, tagName: string): boolean {
    const match = properties.match(new RegExp(`<w:${tagName}(?=[\\s/>])([^>]*)>`, 'iu'));
    if (!match) return false;
    return !/\bw:val=["'](?:0|false|off)["']/iu.test(match[1]);
}

type DocxRunStyle = Omit<DocxInlineRun, 'text'>;

function parseDocxRunStyle(properties: string): DocxRunStyle {
    const style: DocxRunStyle = {};
    if (isDocxToggleOn(properties, 'b')) style.bold = true;
    if (isDocxToggleOn(properties, 'i')) style.italic = true;
    const underline = properties.match(/<w:u(?=[\s/>])([^>]*)>/iu);
    if (underline && !/\bw:val=["']none["']/iu.test(underline[1])) style.underline = true;
    if (isDocxToggleOn(properties, 'strike') || isDocxToggleOn(properties, 'dstrike')) style.strike = true;
    if (/(?:consolas|courier|menlo|monaco|monospace|fira\s*code|jetbrains\s*mono)/iu.test(properties)
        || /<w:rStyle\b[^>]*\bw:val=["'][^"']*code[^"']*["']/iu.test(properties)) {
        style.code = true;
    }
    return style;
}

function decodeBasicXmlEntities(value: string): string {
    return value
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&amp;/gu, '&');
}

function parseXmlTagAttributes(attrSource: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of attrSource.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        attrs[match[1].toLowerCase()] = decodeBasicXmlEntities(match[2] ?? match[3]!);
    }
    return attrs;
}

/**
 * 解析 DOCX 的 `*.rels` XML，提取安全的外链与书签关系映射（`Id -> Target`）。
 * 支持双引号/单引号和任意属性顺序，自动过滤内部部件与不安全协议。
 */
export function parseDocxRelationshipsXml(xml: string): Record<string, string> {
    const rels: Record<string, string> = {};
    for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/giu)) {
        const attrs = parseXmlTagAttributes(match[1]);
        const id = attrs.id?.trim();
        const target = attrs.target?.trim();
        if (!id || !target || id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
        const isExternal = attrs.targetmode?.toLowerCase() === 'external';
        if (!SAFE_DOCX_HREF_PATTERN.test(target)) continue;
        if (!isExternal && !SAFE_DOCX_EXTERNAL_HREF_PATTERN.test(target)) continue;
        rels[id] = target;
    }
    return rels;
}

/**
 * 解析 DOCX 的 `word/numbering.xml`，找出所有非项目符号/非空格式（如 decimal/lowerLetter/upperRoman 等）的有序列表 `w:numId` 集合。
 */
export function parseDocxOrderedNumberingXml(xml: string): ReadonlySet<string> {
    const orderedAbstractIds = new Set<string>();
    for (const match of xml.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum\s*>/giu)) {
        const abstractId = match[1].match(/\bw:abstractNumId=["']([^"']+)["']/iu)?.[1];
        if (!abstractId) continue;
        const body = match[2];
        const level0 = body.match(/<w:lvl\b[^>]*\bw:ilvl=["']0["'][^>]*>([\s\S]*?)<\/w:lvl\s*>/iu)?.[1];
        const numFmt = (level0 ?? body).match(/<w:numFmt\b[^>]*\bw:val=["']([^"']+)["']/iu)?.[1]?.toLowerCase();
        if (numFmt && numFmt !== 'bullet' && numFmt !== 'none') orderedAbstractIds.add(abstractId);
    }

    const orderedNumIds = new Set<string>();
    for (const match of xml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num\s*>/giu)) {
        const numId = match[1].match(/\bw:numId=["']([^"']+)["']/iu)?.[1];
        const abstractRef = match[2].match(/<w:abstractNumId\b[^>]*\bw:val=["']([^"']+)["']/iu)?.[1];
        if (numId && abstractRef && orderedAbstractIds.has(abstractRef)) orderedNumIds.add(numId);
    }
    return orderedNumIds;
}

function lookupDocxRelationship(rels: DocxRelationshipMap, id: string): string | undefined {
    return rels instanceof Map ? rels.get(id) : (rels as Readonly<Record<string, string>>)[id];
}

function extractDocxHyperlinkHref(openTag: string, rels?: DocxRelationshipMap): string | undefined {
    const relId = openTag.match(/\br:id=["']([^"']+)["']/iu)?.[1];
    if (relId && rels) {
        const target = lookupDocxRelationship(rels, relId)?.trim();
        if (target && SAFE_DOCX_HREF_PATTERN.test(target)) return target;
    }
    const anchor = openTag.match(/\bw:anchor=["']([^"']+)["']/iu)?.[1]?.trim();
    return anchor ? `#${anchor}` : undefined;
}

function sameDocxRunStyle(left: DocxInlineRun, right: DocxRunStyle): boolean {
    return Boolean(left.bold) === Boolean(right.bold)
        && Boolean(left.italic) === Boolean(right.italic)
        && Boolean(left.underline) === Boolean(right.underline)
        && Boolean(left.strike) === Boolean(right.strike)
        && Boolean(left.code) === Boolean(right.code)
        && left.href === right.href;
}

function pushDocxRun(runs: DocxInlineRun[], text: string, style: DocxRunStyle): void {
    if (!text) return;
    const prev = runs.at(-1);
    if (prev && sameDocxRunStyle(prev, style)) {
        prev.text += text;
        return;
    }
    runs.push({text, ...style});
}

function buildDocxRuns(
    paragraphXml: string | undefined,
    text: string,
    isTranslated: boolean,
    rels?: DocxRelationshipMap,
): DocxInlineRun[] {
    if (!text.trim()) return [];
    if (paragraphXml) {
        const inline = analyzeDocxInlineParagraph(paragraphXml);
        if (inline.kind === 'free') {
            const baseStyle = parseDocxRunStyle(inline.properties);
            if (!inline.spans.length) {
                return [{text: stripDocumentInlineMarkers(text).trim(), ...baseStyle}];
            }
            let marked: string | undefined;
            if (!isTranslated) {
                marked = inline.source;
            } else {
                try {
                    marked = validateDocumentInlineMarkers(inline.source, text, {}) as string;
                } catch {
                    marked = undefined;
                }
            }
            if (!marked) {
                return [{text: stripDocumentInlineMarkers(text).trim(), ...baseStyle}];
            }
            const runs: DocxInlineRun[] = [];
            const stack: Array<{style: DocxRunStyle; href?: string}> = [];
            const activeStyle = (): DocxRunStyle => {
                const top = stack.at(-1);
                const merged: DocxRunStyle = top ? {...top.style} : {...baseStyle};
                for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
                    if (stack[idx].href) {
                        merged.href = stack[idx].href;
                        break;
                    }
                }
                return merged;
            };
            let cursor = 0;
            for (const match of marked.matchAll(/<(\/?)g(\d+)>/gu)) {
                pushDocxRun(runs, marked.slice(cursor, match.index), activeStyle());
                cursor = match.index + match[0].length;
                if (match[1]) {
                    stack.pop();
                } else {
                    const span = inline.spans[Number(match[2]) - 1];
                    const style = parseDocxRunStyle(span.properties || inline.properties);
                    const href = span.kind === 'link' ? extractDocxHyperlinkHref(span.open, rels) : undefined;
                    stack.push({style, href});
                }
            }
            pushDocxRun(runs, marked.slice(cursor), activeStyle());
            return runs;
        }
    }
    return [{text: stripDocumentInlineMarkers(text).trim()}];
}

function inspectDocxHeadingLevel(paragraphXml: string | undefined): number | undefined {
    if (!paragraphXml) return undefined;
    const pPr = paragraphXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/iu)?.[1];
    if (!pPr) return undefined;
    const pStyle = pPr.match(/<w:pStyle\b[^>]*\bw:val=["']([^"']+)["']/iu)?.[1] ?? '';
    const numbered = pStyle.match(/(?:heading|标题)\s*([1-6])/iu);
    if (numbered) return Number(numbered[1]);
    if (/subtitle|副标题/iu.test(pStyle)) return 2;
    if (/title|标题/iu.test(pStyle)) return 1;
    const outlineLvl = pPr.match(/<w:outlineLvl\b[^>]*\bw:val=["'](\d+)["']/iu)?.[1];
    if (outlineLvl !== undefined) {
        const level = Number(outlineLvl) + 1;
        if (level >= 1 && level <= 6) return level;
    }
    return undefined;
}

function inspectDocxListMeta(
    paragraphXml: string | undefined,
    orderedNumIds?: ReadonlySet<string>,
): {listLevel?: number; listOrdered?: boolean} {
    if (!paragraphXml) return {};
    const pPr = paragraphXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/iu)?.[1];
    if (!pPr) return {};
    const numPrMatch = pPr.match(/<w:numPr\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:numPr>)/iu);
    if (!numPrMatch) return {};
    const numPr = numPrMatch[1] ?? '';
    const listLevel = Number(numPr.match(/<w:ilvl\b[^>]*\bw:val=["'](\d+)["']/iu)?.[1] ?? 0);
    const numId = numPr.match(/<w:numId\b[^>]*\bw:val=["']([^"']+)["']/iu)?.[1];
    const pStyle = pPr.match(/<w:pStyle\b[^>]*\bw:val=["']([^"']+)["']/iu)?.[1] ?? '';
    const listOrdered = Boolean((numId && orderedNumIds?.has(numId)) || /number|ordered|编号/iu.test(pStyle));
    return {listLevel, listOrdered};
}

interface DocxTableXmlMeta {
    headerRows: Set<string>;
    colspans: Map<string, number>;
    tablesWithExplicitHeader: Set<number>;
}

function parseDocxTableXmlMeta(source: string): DocxTableXmlMeta {
    const headerRows = new Set<string>();
    const colspans = new Map<string, number>();
    const tablesWithExplicitHeader = new Set<number>();
    const pattern = /<w:(tbl|tr|tc|tblHeader|gridSpan)(?=[\s>/])([^>]*?)(\/?)>|<\/w:tbl\s*>/gu;
    let depth = 0;
    let table = -1;
    let row = -1;
    let cell = -1;
    for (const match of source.matchAll(pattern)) {
        const tag = match[1];
        if (!tag) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (tag === 'tbl') {
            if (match[3]) {
                if (depth === 0) table += 1;
                continue;
            }
            depth += 1;
            if (depth === 1) {
                table += 1;
                row = -1;
                cell = -1;
            }
            continue;
        }
        if (depth !== 1) continue;
        if (tag === 'tr') {
            row += 1;
            cell = -1;
        } else if (tag === 'tc') {
            cell += 1;
        } else if (tag === 'tblHeader' && row >= 0) {
            if (!/\bw:val=["'](?:0|false|off)["']/iu.test(match[2])) {
                headerRows.add(`${table}:${row}`);
                tablesWithExplicitHeader.add(table);
            }
        } else {
            const val = match[2].match(/\bw:val=["'](\d+)["']/iu)?.[1];
            const span = val ? Math.min(MAX_DOCX_GRID_SPAN, Number(val)) : 1;
            if (row >= 0 && cell >= 0 && span > 1) colspans.set(`${table}:${row}:${cell}`, span);
        }
    }
    return {headerRows, colspans, tablesWithExplicitHeader};
}

export function buildDocxRichBlocks(
    part: DocxDocumentPart,
    segments: readonly DocumentSegment[],
    translations: readonly string[],
    options?: BuildDocxRichBlocksOptions,
): DocxRichBlock[] {
    const paragraphXmlList = extractDocxParagraphXmlList(part.source);
    const tableMeta = parseDocxTableXmlMeta(part.source);
    const blocks: DocxRichBlock[] = [];
    const tableStates: Array<{
        tableIdx: number;
        blockIndex: number;
        rows: Array<Array<{cellIndex: number; paragraphs: DocxRichParagraph[]}>>;
    }> = [];

    for (const entry of part.paragraphSegments) {
        const segment = segments[entry.segmentIndex];
        if (!segment) continue;
        const xml = paragraphXmlList[entry.paragraphIndex];
        const rawTranslation = translations[entry.segmentIndex] ?? '';
        const sourceText = stripDocumentInlineMarkers(segment.source).trim();
        const translationText = stripDocumentInlineMarkers(rawTranslation).trim();
        const distinct = hasDistinctTranslation(sourceText, translationText);
        const headingLevel = inspectDocxHeadingLevel(xml)
            ?? (segment.role === 'title' ? 1 : segment.role === 'heading' ? 2 : undefined);
        const listMeta = inspectDocxListMeta(xml, options?.orderedNumIds);
        const paragraph: DocxRichParagraph = {
            segmentIndex: entry.segmentIndex,
            paragraphIndex: entry.paragraphIndex,
            role: segment.role ?? 'paragraph',
            ...(headingLevel !== undefined ? {headingLevel} : {}),
            ...listMeta,
            sourceText,
            translationText: distinct ? translationText : '',
            hasDistinctTranslation: distinct,
            sourceRuns: buildDocxRuns(xml, segment.source, false, options?.rels),
            translationRuns: distinct ? buildDocxRuns(xml, rawTranslation, true, options?.rels) : [],
        };

        if (!entry.table) {
            blocks.push({kind: 'paragraph', key: `p-${entry.segmentIndex}`, paragraph});
            continue;
        }

        const {table: tableIdx, row: rowIdx, cell: cellIdx} = entry.table;
        const lastBlock = blocks.at(-1);
        let state = lastBlock?.kind === 'table' && lastBlock.tableIndex === tableIdx ? tableStates.at(-1) : undefined;
        if (!state) {
            const blockIndex = blocks.length;
            blocks.push({kind: 'table', key: `t-${tableIdx}-${entry.segmentIndex}`, tableIndex: tableIdx, rows: [], segmentCount: 0});
            state = {tableIdx, blockIndex, rows: []};
            tableStates.push(state);
        }
        const tableBlock = blocks[state.blockIndex] as Extract<DocxRichBlock, {kind: 'table'}>;
        tableBlock.segmentCount += 1;
        const rowCells = (state.rows[rowIdx] ??= []);
        let cellEntry = rowCells[cellIdx];
        if (!cellEntry) {
            cellEntry = {cellIndex: cellIdx, paragraphs: []};
            rowCells[cellIdx] = cellEntry;
        }
        cellEntry.paragraphs.push(paragraph);
    }

    for (const state of tableStates) {
        const {tableIdx} = state;
        const tableBlock = blocks[state.blockIndex] as Extract<DocxRichBlock, {kind: 'table'}>;
        const nonEmptyRows = state.rows
            .map((cells, rowIndex) => ({rowIndex, cells}))
            .filter((item) => Boolean(item.cells));
        const hasExplicitHeader = tableMeta.tablesWithExplicitHeader.has(tableIdx);
        tableBlock.rows = nonEmptyRows.map(({rowIndex, cells}, displayIndex) => ({
            rowIndex,
            isHeader: hasExplicitHeader
                ? tableMeta.headerRows.has(`${tableIdx}:${rowIndex}`)
                : nonEmptyRows.length > 1 && displayIndex === 0,
            cells: Array.from(cells, (cell, cellIndex) => ({
                colspan: tableMeta.colspans.get(`${tableIdx}:${rowIndex}:${cellIndex}`) ?? 1,
                paragraphs: cell ? cell.paragraphs : [],
            })),
        }));
    }

    return blocks;
}

function computeDocxPageRanges(
    blocks: readonly DocxRichBlock[],
    pageSize: number,
): Array<{page: number; startBlock: number; endBlock: number}> {
    const safeSize = clampPositiveInt(pageSize, 50);
    if (blocks.length === 0) return [{page: 1, startBlock: 0, endBlock: 0}];
    const ranges: Array<{page: number; startBlock: number; endBlock: number}> = [];
    let startBlock = 0;
    let load = 0;
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const cost = block.kind === 'table' ? Math.max(1, block.segmentCount) : 1;
        if (load > 0 && load + cost > safeSize) {
            ranges.push({page: ranges.length + 1, startBlock, endBlock: index});
            startBlock = index;
            load = cost;
        } else {
            load += cost;
        }
    }
    ranges.push({page: ranges.length + 1, startBlock, endBlock: blocks.length});
    return ranges;
}

/** 按逻辑块分页：整张表格作为原子块绝不跨页截断。 */
export function paginateDocxBlocks(
    blocks: readonly DocxRichBlock[],
    page: number,
    pageSize: number,
): PaginatedDocxBlocks {
    const safeSize = clampPositiveInt(pageSize, 50);
    const pageRanges = computeDocxPageRanges(blocks, safeSize);
    const totalPages = pageRanges.length;
    const clampedPage = Math.min(totalPages, clampPositiveInt(page, 1));
    const range = pageRanges[clampedPage - 1];
    return {
        page: clampedPage,
        pageSize: safeSize,
        totalPages,
        totalBlocks: blocks.length,
        blocks: blocks.slice(range.startBlock, range.endBlock),
        pageRanges,
    };
}

function docxBlockContainsSegment(block: DocxRichBlock, segmentIndex: number): boolean {
    if (block.kind === 'paragraph') return block.paragraph.segmentIndex === segmentIndex;
    return block.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((p) => p.segmentIndex === segmentIndex)));
}

/** 查找指定 DOCX 片段在表感知分页中的 1-based 页码；未找到返回 1。 */
export function findDocxBlockPage(
    blocks: readonly DocxRichBlock[],
    segmentIndex: number,
    pageSize: number,
): number {
    const blockIndex = blocks.findIndex((block) => docxBlockContainsSegment(block, segmentIndex));
    if (blockIndex < 0) return 1;
    const ranges = computeDocxPageRanges(blocks, pageSize);
    return ranges.find((range) => blockIndex >= range.startBlock && blockIndex < range.endBlock)!.page;
}

export function buildDocxOutline(
    parts: readonly DocxDocumentPart[],
    segments: readonly DocumentSegment[],
    translations: readonly string[],
): DocxOutlineItem[] {
    const items: DocxOutlineItem[] = [];
    parts.forEach((part, partIndex) => {
        const paragraphXmlList = extractDocxParagraphXmlList(part.source);
        for (const {paragraphIndex, segmentIndex} of part.paragraphSegments) {
            const segment = segments[segmentIndex];
            if (!segment) continue;
            const xmlLevel = inspectDocxHeadingLevel(paragraphXmlList[paragraphIndex]);
            const level = xmlLevel ?? (segment.role === 'title' ? 1 : segment.role === 'heading' ? 2 : undefined);
            if (level === undefined) continue;
            const source = stripDocumentInlineMarkers(segment.source).trim();
            const rawTranslation = stripDocumentInlineMarkers(translations[segmentIndex] ?? '').trim();
            items.push({
                partIndex,
                segmentIndex,
                level,
                source,
                translation: hasDistinctTranslation(source, rawTranslation) ? rawTranslation : '',
            });
        }
    });
    return items;
}
