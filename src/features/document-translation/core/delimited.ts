/**
 * @file src/features/document-translation/core/delimited.ts
 * 文件职责：按原始字段边界读取和回填 CSV/TSV，使译文留在其所在的单元格。
 * 主要内容：支持双引号、转义引号、嵌入换行、空字段、不同的行结束符与 UTF-8 BOM；识别数字、日期、链接和公式等原始字段。
 * 模块边界：只处理字段边界和编码，不读取文件或调用翻译服务；文档模型与选列范围由 core/document 管理。
 */

type Delimiter = ',' | '\t';

export interface DelimitedColumn {index: number; label: string}

export function* readDelimitedCells(source: string, delimiter: Delimiter) {
    let cursor = source.startsWith('\ufeff') ? 1 : 0;
    let row = 0;
    let column = 0;
    const endsCell = (character: string) => character === delimiter || character === '\r' || character === '\n';
    while (cursor < source.length) {
        const start = cursor;
        const quoted = source[start] === '"';
        let value: string;
        if (quoted) {
            let closing = source.indexOf('"', start + 1);
            while (closing >= 0 && source[closing + 1] === '"') closing = source.indexOf('"', closing + 2);
            if (closing < 0 || closing + 1 < source.length && !endsCell(source[closing + 1])) {
                throw new Error(`CSV/TSV 引号不完整（R${row + 1}C${column + 1}）`);
            }
            value = source.slice(start + 1, closing).replace(/""/gu, '"');
            cursor = closing + 1;
        } else {
            while (cursor < source.length && !endsCell(source[cursor])) cursor += 1;
            value = source.slice(start, cursor);
        }
        yield {start, end: cursor, value, row, column, quoted};
        // 末尾空列或整行末尾换行都保留在未改写的字面片段中。
        if (source[cursor] === delimiter) {
            cursor += 1;
            column += 1;
        } else {
            cursor += source[cursor] === '\r' && source[cursor + 1] === '\n' ? 2 : 1;
            row += 1;
            column = 0;
        }
    }
}

/** 表格程序可能把以这些字符开始的 CSV/TSV 字段解释为公式，即便字段有引号。 */
export function isSpreadsheetFormula(value: string): boolean {
    return /^[\s\u0000-\u001f]*[=+@＝＋＠－-]/u.test(value);
}

export function isTranslatableDelimitedCell(value: string): boolean {
    return /\p{L}/u.test(value) && !isSpreadsheetFormula(value)
        && !/^(?:true|false|null|NaN|[\d.]+e[+-]?\d+|\d{4}-\d{2}-\d{2}[Tt]\d.*|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(value)
        && !/^(?:[a-z][\w+.-]*:\/\/|mailto:|www\.)\S+$|^[^@\s]+@[^@\s]+\.[^@\s]+$/iu.test(value);
}

export function encodeDelimitedCell(value: string, delimiter: Delimiter, quoted: boolean): string {
    return quoted || value.includes(delimiter) || /["\r\n]/u.test(value)
        ? `"${value.replace(/"/gu, '""')}"` : value;
}
