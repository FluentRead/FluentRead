/**
 * @file src/features/document-translation/ui/readers/delimitedReader.ts
 *
 * 文件职责：为 CSV 与 TSV 文档构建二维电子表格视图模型，支持列字母标注、数值/公式识别、可译列筛选与按行分页。
 * 主要内容：提供 delimitedColumnLetter、buildDelimitedGrid 与 paginateDelimitedRows，完整保留非翻译列与表头检测，并只展示与原文有区别的有效译文。
 * 模块边界：纯函数数据转换层，依赖 core/delimited 与 core/document 的解析结果，不操作 DOM 或修改输入文档对象。
 */

import {hasDistinctTranslation} from '@/src/core/translation/result';
import {isSpreadsheetFormula, isTranslatableDelimitedCell, readDelimitedCells} from '../../core/delimited';
import {
    renderDocument,
    type DocumentSegment,
    type ParsedDocument,
} from '../../core/document';
import {clampPositiveInt} from './shared';

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
