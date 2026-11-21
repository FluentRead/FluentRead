/**
 * @file src/features/document-translation/core/markdownTable.ts
 * 文件职责：识别 GFM 表格行的分隔符、单元格范围与对齐方式，并保护回填译文里的竖线和换行。
 * 主要内容：按转义奇偶识别竖线，保留原始列边界及可选的首尾竖线；表内译文用行内换行，避免结束表格行。
 * 模块边界：只处理单行语法和表格的展示元数据；所在的 Markdown 容器及翻译片段由 document.ts 管理。
 */
export type MarkdownTableAlignment = 'left' | 'center' | 'right' | null;

export interface MarkdownTable {
    startLine: number;
    endLine: number;
    alignments: readonly MarkdownTableAlignment[];
}

/** GFM 要求表内的竖线都经过转义，包括反引号里的竖线。 */
export function splitMarkdownTableRow(value: string): {hasPipe: boolean; cells: Array<{start: number; end: number}>} {
    const pipes = Array.from(value.matchAll(/(?<!\\)(?:\\\\)*\|/gu), match => match.index + match[0].length - 1);
    const hasPipe = pipes.length > 0;
    const cells: Array<{start: number; end: number}> = [];
    let start = pipes[0] === value.length - value.trimStart().length ? pipes.shift()! + 1 : 0;
    const end = pipes.at(-1) === value.trimEnd().length - 1 ? pipes.pop()! : value.length;
    for (const pipe of pipes) {
        cells.push({start, end: pipe});
        start = pipe + 1;
    }
    cells.push({start, end});
    return {hasPipe, cells};
}

export function markdownTableAlignments(header: string, delimiter: string): MarkdownTableAlignment[] | undefined {
    const headings = splitMarkdownTableRow(header);
    const columns = splitMarkdownTableRow(delimiter);
    if (!headings.hasPipe || headings.cells.length !== columns.cells.length) return undefined;
    const alignments: MarkdownTableAlignment[] = [];
    for (const {start, end} of columns.cells) {
        const cell = delimiter.slice(start, end).trim();
        if (!/^:?-+:?$/u.test(cell)) return undefined;
        const left = cell.startsWith(':'), right = cell.endsWith(':');
        alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    }
    return alignments;
}

export function escapeMarkdownTableTranslation(value: string): string {
    return value.replace(/(?<!\\)(?:\\\\)*\|/gu, token => token.slice(0, -1) + '\\|')
        .replace(/(?:\r\n?|\n)/gu, '<br>')
        // 译文末尾的未配对反斜线不能吃掉紧接着的列分隔符。
        .replace(/(?<!\\)(?:\\\\)*\\$/u, token => token + '\\');
}
