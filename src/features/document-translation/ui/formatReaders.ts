/**
 * @file src/features/document-translation/ui/formatReaders.ts
 * 文件职责：为 CSV/TSV 二维电子表格、DOCX 富文本与表格分页、JSON 结构化大纲/树形阅读，以及字幕时长/说话人/时间轴导航提供纯函数视图模型构造器。
 * 主要内容：重建含非翻译列与数值对齐的 CSV/TSV 二维网格及按行分页；从 DOCX XML 提取标题层级、列表缩进、行内粗斜下划线/删除线/代码/超链接 runs 与合并单元格表格，并提供不拆表分页与多级目录；构建 JSON 命名空间目录、占位符高亮分组表格与迭代式可折叠语法树；解析多格式字幕时间戳、计算时长与每秒字数、提取 LRC 头标签与 ASS 样式/角色并生成时间桶侧栏导航。
 * 模块边界：本文件为纯数据转换层，不读写浏览器 DOM、不访问网络或压缩包 I/O、也不修改传入的 ParsedDocument；文件解析由 core/document 与 services/binary 负责，界面渲染由 DocumentApp.vue 消费。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {stripDocumentInlineMarkers, validateDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';
import {isSpreadsheetFormula, isTranslatableDelimitedCell, readDelimitedCells} from '../core/delimited';
import {analyzeDocxInlineParagraph} from '../core/docxInline';
import {
    formatJsonPath,
    renderDocument,
    type DocxDocumentPart,
    type DocumentSegment,
    type ParsedDocument,
} from '../core/document';

/* -------------------------------------------------------------------------- */
/*  1. CSV / TSV 2D Spreadsheet Grid                                          */
/* -------------------------------------------------------------------------- */

export interface DelimitedGridColumn {
    index: number;
    letter: string;
    label: string;
    translatable: boolean;
    selected: boolean;
    segmentCount: number;
}

export interface DelimitedGridCell {
    row: number;
    column: number;
    raw: string;
    translation: string;
    segmentId?: number;
    translatable: boolean;
    selected: boolean;
    isNumeric: boolean;
    isFormula: boolean;
}

export interface DelimitedGridRow {
    rowIndex: number;
    isHeader: boolean;
    cells: DelimitedGridCell[];
}

export interface DelimitedGrid {
    delimiter: ',' | '\t';
    columns: DelimitedGridColumn[];
    headerRow: DelimitedGridRow | null;
    rows: DelimitedGridRow[];
    allRows: DelimitedGridRow[];
    hasHeader: boolean;
    totalRows: number;
    totalColumns: number;
}

export interface BuildDelimitedGridOptions {
    selectedColumns?: readonly number[];
    hasHeader?: boolean;
}

export interface PaginatedDelimitedRows {
    page: number;
    pageSize: number;
    totalPages: number;
    totalRows: number;
    startRow: number;
    endRow: number;
    rows: DelimitedGridRow[];
}

const NUMERIC_CELL_PATTERN = /^(?:[$€£¥]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/u;

function isNumericCell(value: string): boolean {
    const trimmed = value.trim();
    return Boolean(trimmed) && NUMERIC_CELL_PATTERN.test(trimmed);
}

/** 把零基列索引转换成电子表格列字母（0 → A，25 → Z，26 → AA）。 */
export function delimitedColumnLetter(index: number): string {
    let current = Math.max(0, Math.floor(index));
    let label = '';
    for (;;) {
        label = String.fromCharCode(65 + (current % 26)) + label;
        current = Math.floor(current / 26) - 1;
        if (current < 0) return label;
    }
}

export function buildDelimitedGrid(
    document: ParsedDocument,
    translations: readonly string[],
    options?: BuildDelimitedGridOptions,
): DelimitedGrid {
    const delimiter: ',' | '\t' = document.format === 'tsv' ? '\t' : ',';
    const rawSource = renderDocument(document, [], 'translated');
    const segmentByCell = new Map<string, DocumentSegment>();
    const columnSegmentCounts = new Map<number, number>();
    for (const segment of document.segments) {
        if (!segment.delimitedCell) continue;
        const {row, column} = segment.delimitedCell;
        segmentByCell.set(`${row}:${column}`, segment);
        columnSegmentCounts.set(column, (columnSegmentCounts.get(column) ?? 0) + 1);
    }

    const matrix: string[][] = [];
    let totalColumns = 0;
    for (const cell of readDelimitedCells(rawSource, delimiter)) {
        const row = (matrix[cell.row] ??= []);
        row[cell.column] = cell.value;
        if (cell.column + 1 > totalColumns) totalColumns = cell.column + 1;
    }
    const rawRows = matrix;
    const selectedSet = options?.selectedColumns?.length ? new Set(options.selectedColumns) : null;
    const hasHeader = rawRows.length > 0 && (options?.hasHeader !== undefined
        ? options.hasHeader
        : rawRows.length > 1 && rawRows[0].some((value) => Boolean(value?.trim()) && !isNumericCell(value)));

    const columns: DelimitedGridColumn[] = Array.from({length: totalColumns}, (_, columnIndex) => {
        const letter = delimitedColumnLetter(columnIndex);
        const headerText = hasHeader ? (rawRows[0][columnIndex] ?? '').replace(/\s+/gu, ' ').trim() : '';
        const segmentCount = columnSegmentCounts.get(columnIndex) ?? 0;
        const translatable = segmentCount > 0;
        return {
            index: columnIndex,
            letter,
            label: headerText || `Col ${letter}`,
            translatable,
            selected: translatable && (!selectedSet || selectedSet.has(columnIndex)),
            segmentCount,
        };
    });

    const allRows: DelimitedGridRow[] = rawRows.map((rowValues, rowIndex) => ({
        rowIndex,
        isHeader: hasHeader && rowIndex === 0,
        cells: Array.from({length: totalColumns}, (_, columnIndex) => {
            const raw = rowValues[columnIndex] ?? '';
            const segment = segmentByCell.get(`${rowIndex}:${columnIndex}`);
            const selected = columns[columnIndex].selected;
            const rawTranslation = segment && selected ? translations[segment.id] : undefined;
            const translation = segment && hasDistinctTranslation(segment.source, rawTranslation) ? rawTranslation! : '';
            const numeric = isNumericCell(raw);
            return {
                row: rowIndex,
                column: columnIndex,
                raw,
                translation,
                ...(segment ? {segmentId: segment.id} : {}),
                translatable: Boolean(segment) || isTranslatableDelimitedCell(raw.trim()),
                selected,
                isNumeric: numeric,
                isFormula: !numeric && isSpreadsheetFormula(raw),
            };
        }),
    }));

    const headerRow = hasHeader ? allRows[0] : null;
    const rows = hasHeader ? allRows.slice(1) : allRows;
    return {
        delimiter,
        columns,
        headerRow,
        rows,
        allRows,
        hasHeader,
        totalRows: rows.length,
        totalColumns,
    };
}

function clampPositiveInt(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export function paginateDelimitedRows(
    grid: DelimitedGrid,
    page: number,
    pageSize: number,
): PaginatedDelimitedRows {
    const safeSize = clampPositiveInt(pageSize, 50);
    const totalRows = grid.rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / safeSize));
    const clampedPage = Math.min(totalPages, clampPositiveInt(page, 1));
    const startRow = (clampedPage - 1) * safeSize;
    const rows = grid.rows.slice(startRow, startRow + safeSize);
    return {
        page: clampedPage,
        pageSize: safeSize,
        totalPages,
        totalRows,
        startRow,
        endRow: startRow + rows.length,
        rows,
    };
}

/* -------------------------------------------------------------------------- */
/*  2. DOCX Rich Blocks, Table-Aware Pagination & Nested Outline              */
/* -------------------------------------------------------------------------- */

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

const SAFE_DOCX_EXTERNAL_HREF_PATTERN = /^(?:https?:\/\/|mailto:)/iu;

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

const MAX_DOCX_GRID_SPAN = 100;

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

/* -------------------------------------------------------------------------- */
/*  3. JSON Structured Reader, Interpolation Tokens & Collapsible Tree        */
/* -------------------------------------------------------------------------- */

export interface JsonTextToken {
    kind: 'text' | 'placeholder';
    text: string;
}

export interface JsonOutlineEntry {
    key: string;
    path: string;
    startSegmentIndex: number;
    endSegmentIndex: number;
    page: number;
    total: number;
    completed: number;
}

export interface JsonGroupedRow {
    segmentId: number;
    pathLabel: string;
    parentPath: string;
    leafKey: string;
    source: string;
    translation: string;
    hasDistinctTranslation: boolean;
    sourceTokens: JsonTextToken[];
    translationTokens: JsonTextToken[];
}

export interface JsonRowGroup {
    parentPath: string;
    rows: JsonGroupedRow[];
}

export interface PaginatedJsonGroupedRows {
    page: number;
    pageSize: number;
    totalPages: number;
    totalRows: number;
    groups: JsonRowGroup[];
}

export type JsonValueKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonTreeNode {
    path: string;
    key: string;
    depth: number;
    kind: JsonValueKind;
    childCount: number;
    expanded: boolean;
    valueText: string;
    segmentId?: number;
    translation?: string;
    translatable: boolean;
    muted: boolean;
}

const JSON_INTERPOLATION_PATTERN = /\{\{[^}\r\n]+\}\}|\{[A-Za-z0-9_.$:-]+\}|%(?:\d+\$)?[sdifoxX%]|\\[ntr]|\n/gu;

export function tokenizeJsonInterpolation(value: string): JsonTextToken[] {
    if (!value) return [];
    const tokens: JsonTextToken[] = [];
    let cursor = 0;
    for (const match of value.matchAll(JSON_INTERPOLATION_PATTERN)) {
        if (match.index > cursor) tokens.push({kind: 'text', text: value.slice(cursor, match.index)});
        tokens.push({kind: 'placeholder', text: match[0] === '\n' ? '\\n' : match[0]});
        cursor = match.index + match[0].length;
    }
    if (cursor < value.length) tokens.push({kind: 'text', text: value.slice(cursor)});
    return tokens;
}

function splitJsonPathLabel(pathLabel: string): {parentPath: string; leafKey: string} {
    if (!pathLabel || pathLabel === '$') return {parentPath: '$', leafKey: '$'};
    let inQuote = false;
    let escaped = false;
    let lastDot = -1;
    let lastBracketStart = -1;
    for (let index = 0; index < pathLabel.length; index += 1) {
        const ch = pathLabel[index];
        if (inQuote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inQuote = false;
            continue;
        }
        if (ch === '"') inQuote = true;
        else if (ch === '.') lastDot = index;
        else if (ch === '[') lastBracketStart = index;
    }
    if (pathLabel.endsWith(']') && lastBracketStart >= 0) {
        return {
            parentPath: pathLabel.slice(0, lastBracketStart) || '$',
            leafKey: pathLabel.slice(lastBracketStart),
        };
    }
    if (lastDot < 0) return {parentPath: '$', leafKey: pathLabel};
    return {
        parentPath: pathLabel.slice(0, lastDot) || '$',
        leafKey: pathLabel.slice(lastDot + 1),
    };
}

export function buildJsonOutline(
    document: ParsedDocument,
    translations: readonly string[],
    pageSize = 50,
): JsonOutlineEntry[] {
    const safeSize = clampPositiveInt(pageSize, 50);
    const entries: JsonOutlineEntry[] = [];
    const byNamespace = new Map<string, JsonOutlineEntry>();
    const jsonEntries = document.jsonEntries ?? [];

    document.segments.forEach((segment, rowIndex) => {
        const path = jsonEntries[rowIndex]?.path;
        const firstPart = path?.[0];
        const key = firstPart === undefined
            ? '$'
            : typeof firstPart === 'number'
                ? `[${firstPart}]`
                : firstPart;
        const namespacePath = firstPart === undefined ? '$' : formatJsonPath([firstPart]);
        const done = hasDistinctTranslation(segment.source, translations[segment.id]);
        const existing = byNamespace.get(namespacePath);
        if (existing) {
            existing.endSegmentIndex = segment.id;
            existing.total += 1;
            if (done) existing.completed += 1;
            return;
        }
        const entry: JsonOutlineEntry = {
            key,
            path: namespacePath,
            startSegmentIndex: segment.id,
            endSegmentIndex: segment.id,
            page: Math.floor(rowIndex / safeSize) + 1,
            total: 1,
            completed: done ? 1 : 0,
        };
        byNamespace.set(namespacePath, entry);
        entries.push(entry);
    });

    return entries;
}

export function buildJsonGroupedRows(
    document: ParsedDocument,
    translations: readonly string[],
    page: number,
    pageSize: number,
): PaginatedJsonGroupedRows {
    const safeSize = clampPositiveInt(pageSize, 50);
    const totalRows = document.segments.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / safeSize));
    const clampedPage = Math.min(totalPages, clampPositiveInt(page, 1));
    const start = (clampedPage - 1) * safeSize;
    const slice = document.segments.slice(start, start + safeSize);

    const entryPathBySegment = new Map<number, readonly (string | number)[]>();
    for (const entry of document.jsonEntries ?? []) {
        entryPathBySegment.set(entry.segmentIndex, entry.path);
    }

    const groups: JsonRowGroup[] = [];
    for (const segment of slice) {
        const pathLabel = segment.pathLabel ?? '$';
        const structuredPath = entryPathBySegment.get(segment.id);
        let parentPath: string;
        let leafKey: string;
        if (structuredPath && structuredPath.length > 0) {
            parentPath = formatJsonPath(structuredPath.slice(0, -1) as Array<string | number>);
            const leaf = structuredPath[structuredPath.length - 1];
            leafKey = typeof leaf === 'number' ? `[${leaf}]` : leaf;
        } else {
            ({parentPath, leafKey} = splitJsonPathLabel(pathLabel));
        }
        const rawTranslation = translations[segment.id] ?? '';
        const distinct = hasDistinctTranslation(segment.source, rawTranslation);
        const translation = distinct ? rawTranslation : '';
        const row: JsonGroupedRow = {
            segmentId: segment.id,
            pathLabel,
            parentPath,
            leafKey,
            source: segment.source,
            translation,
            hasDistinctTranslation: distinct,
            sourceTokens: tokenizeJsonInterpolation(segment.source),
            translationTokens: distinct ? tokenizeJsonInterpolation(translation) : [],
        };
        const lastGroup = groups.at(-1);
        if (lastGroup && lastGroup.parentPath === parentPath) lastGroup.rows.push(row);
        else groups.push({parentPath, rows: [row]});
    }

    return {
        page: clampedPage,
        pageSize: safeSize,
        totalPages,
        totalRows,
        groups,
    };
}

function classifyJsonValue(value: unknown): JsonValueKind {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const type = typeof value;
    if (type === 'object') return 'object';
    if (type === 'string') return 'string';
    if (type === 'number') return 'number';
    return 'boolean';
}

export interface BuildJsonTreeNodesOptions {
    maxNodes?: number;
}

export function buildJsonTreeNodes(
    document: ParsedDocument,
    translations: readonly string[],
    expandedPaths: ReadonlySet<string>,
    options?: BuildJsonTreeNodesOptions,
): JsonTreeNode[] {
    if (document.jsonValue === undefined) return [];
    const limit = options?.maxNodes !== undefined
        ? clampPositiveInt(options.maxNodes, Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
    const segmentByPath = new Map<string, number>();
    for (const entry of document.jsonEntries ?? []) {
        segmentByPath.set(formatJsonPath(entry.path), entry.segmentIndex);
    }

    const nodes: JsonTreeNode[] = [];
    const stack: Array<{value: unknown; key: string; path: Array<string | number>; depth: number}> = [
        {value: document.jsonValue, key: '$', path: [], depth: 0},
    ];

    while (stack.length > 0 && nodes.length < limit) {
        const current = stack.pop()!;
        const pathString = formatJsonPath(current.path);
        const kind = classifyJsonValue(current.value);

        if (kind === 'object' || kind === 'array') {
            const entries = Array.isArray(current.value)
                ? current.value.map((item, idx) => [idx, item] as const)
                : Object.entries(current.value as Record<string, unknown>);
            const expanded = expandedPaths.has(pathString);
            nodes.push({
                path: pathString,
                key: current.key,
                depth: current.depth,
                kind,
                childCount: entries.length,
                expanded,
                valueText: kind === 'array' ? `[${entries.length}]` : `{${entries.length}}`,
                translatable: false,
                muted: false,
            });
            if (expanded) {
                for (let index = entries.length - 1; index >= 0; index -= 1) {
                    const [childKey, childValue] = entries[index];
                    stack.push({
                        value: childValue,
                        key: typeof childKey === 'number' ? `[${childKey}]` : childKey,
                        path: [...current.path, childKey],
                        depth: current.depth + 1,
                    });
                }
            }
            continue;
        }

        const segmentId = kind === 'string' ? segmentByPath.get(pathString) : undefined;
        const segment = segmentId !== undefined ? document.segments[segmentId] : undefined;
        const rawTranslation = segment ? translations[segment.id] : undefined;
        const translation = segment && hasDistinctTranslation(segment.source, rawTranslation) ? rawTranslation! : undefined;
        nodes.push({
            path: pathString,
            key: current.key,
            depth: current.depth,
            kind,
            childCount: 0,
            expanded: false,
            valueText: String(current.value),
            ...(segmentId !== undefined ? {segmentId} : {}),
            ...(translation !== undefined ? {translation} : {}),
            translatable: segmentId !== undefined,
            muted: kind === 'string' && segmentId === undefined,
        });
    }

    return nodes;
}

/* -------------------------------------------------------------------------- */
/*  4. Subtitle Timing, Metadata & Timeline Outline                           */
/* -------------------------------------------------------------------------- */

export interface SubtitleTimingMetrics {
    startMs: number | null;
    endMs: number | null;
    durationMs: number | null;
    durationLabel: string;
    cps: number | null;
}

export interface SubtitleLrcMeta {
    title?: string;
    artist?: string;
    album?: string;
    by?: string;
    offset?: string;
}

export interface SubtitleCueMeta {
    style?: string;
    actor?: string;
}

export interface SubtitleDocumentMetadata {
    lrc: SubtitleLrcMeta;
    cues: ReadonlyMap<number, SubtitleCueMeta>;
}

export interface SubtitleTimelineBucket {
    id: string;
    label: string;
    startMs: number;
    endMs: number;
    firstSegmentId: number;
    page: number;
    total: number;
    completed: number;
}

/** 解析 SRT / VTT / ASS / LRC 时间戳为毫秒；格式无效时返回 null。 */
export function parseSubtitleTimestampMs(value?: string): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    const hms = trimmed.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/u);
    if (hms) {
        const hours = Number(hms[1]);
        const minutes = Number(hms[2]);
        const seconds = Number(hms[3]);
        const frac = hms[4] ?? '';
        const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac || 0);
        return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
    }
    const msOnly = trimmed.match(/^(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/u);
    if (msOnly) {
        const minutes = Number(msOnly[1]);
        const seconds = Number(msOnly[2]);
        const frac = msOnly[3] ?? '';
        const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac || 0);
        return (minutes * 60 + seconds) * 1000 + ms;
    }
    return null;
}

export function formatSubtitleDuration(
    timeStart?: string,
    timeEnd?: string,
    text?: string,
): SubtitleTimingMetrics {
    const startMs = parseSubtitleTimestampMs(timeStart);
    const endMs = parseSubtitleTimestampMs(timeEnd);
    if (startMs === null || endMs === null || endMs < startMs) {
        return {startMs, endMs, durationMs: null, durationLabel: '', cps: null};
    }
    const durationMs = endMs - startMs;
    const totalSeconds = durationMs / 1000;
    const durationLabel = totalSeconds >= 60
        ? `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toFixed(1)}s`
        : `${totalSeconds.toFixed(1)}s`;
    const visibleLength = text ? text.replace(/\s+/gu, '').length : 0;
    const cps = durationMs > 0 && visibleLength > 0
        ? Math.round((visibleLength / totalSeconds) * 10) / 10
        : null;
    return {startMs, endMs, durationMs, durationLabel, cps};
}

export function extractSubtitleMetadata(document: ParsedDocument): SubtitleDocumentMetadata {
    const lrc: SubtitleLrcMeta = {};
    const cues = new Map<number, SubtitleCueMeta>();

    if (document.format === 'lrc') {
        const tagMap: Record<string, keyof SubtitleLrcMeta> = {
            ti: 'title',
            ar: 'artist',
            al: 'album',
            by: 'by',
            offset: 'offset',
        };
        for (const part of document.parts) {
            if (part.kind !== 'literal') continue;
            for (const match of part.value.matchAll(/\[(ti|ar|al|by|offset):([^\]\r\n]+)\]/giu)) {
                const field = tagMap[match[1].toLowerCase()];
                const content = match[2].trim();
                if (content && !lrc[field]) lrc[field] = content;
            }
        }
        return {lrc, cues};
    }

    if (document.format === 'ass') {
        for (let index = 0; index < document.parts.length; index += 1) {
            const part = document.parts[index];
            if (part.kind !== 'segment') continue;
            const prev = document.parts[index - 1];
            if (!prev || prev.kind !== 'literal') continue;
            const lastLine = prev.value.slice(prev.value.lastIndexOf('\n') + 1);
            const dialogueMatch = lastLine.match(/^\s*Dialogue\s*:(.*)$/iu);
            if (!dialogueMatch) continue;
            const fields = dialogueMatch[1].split(',');
            const style = fields[3]?.trim() || undefined;
            const actor = fields[4]?.trim() || undefined;
            if (style || actor) cues.set(part.segmentIndex, {...(style ? {style} : {}), ...(actor ? {actor} : {})});
        }
    }

    return {lrc, cues};
}

function formatClockLabel(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:00`
        : `${String(minutes).padStart(2, '0')}:00`;
}

export function buildSubtitleTimelineOutline(
    segments: readonly DocumentSegment[],
    translations: readonly string[],
    options?: {bucketMinutes?: number; pageSize?: number},
): SubtitleTimelineBucket[] {
    const timed = segments
        .map((segment, rowIndex) => ({segment, rowIndex, ms: parseSubtitleTimestampMs(segment.timeStart)}))
        .filter((entry): entry is {segment: DocumentSegment; rowIndex: number; ms: number} => entry.ms !== null);
    if (timed.length === 0) return [];

    const maxMs = timed.reduce((max, item) => Math.max(max, item.ms), 0);
    const bucketMinutes = options?.bucketMinutes !== undefined
        ? clampPositiveInt(options.bucketMinutes, 5)
        : maxMs > 60 * 60_000 ? 10 : 5;
    const bucketMs = bucketMinutes * 60_000;
    const pageSize = clampPositiveInt(options?.pageSize ?? 50, 50);

    const buckets: SubtitleTimelineBucket[] = [];
    const byBucket = new Map<number, SubtitleTimelineBucket>();
    for (const {segment, rowIndex, ms} of timed) {
        const bucketIndex = Math.floor(ms / bucketMs);
        const done = hasDistinctTranslation(segment.source, translations[segment.id]);
        const existing = byBucket.get(bucketIndex);
        if (existing) {
            existing.total += 1;
            if (done) existing.completed += 1;
            continue;
        }
        const startMs = bucketIndex * bucketMs;
        const endMs = startMs + bucketMs;
        const bucket: SubtitleTimelineBucket = {
            id: `t-${bucketIndex}`,
            label: `${formatClockLabel(startMs)} – ${formatClockLabel(endMs)}`,
            startMs,
            endMs,
            firstSegmentId: segment.id,
            page: Math.floor(rowIndex / pageSize) + 1,
            total: 1,
            completed: done ? 1 : 0,
        };
        byBucket.set(bucketIndex, bucket);
        buckets.push(bucket);
    }

    return buckets;
}
