/**
 * @file src/features/document-translation/core/formats/jsonAndDelimited.ts
 * 文件职责：负责 JSON 结构的有界非递归遍历/深拷贝/路径读写以及 CSV/TSV 表格单元格解析与列索引提取。
 * 主要内容：过滤程序标识符/网址/颜色值仅抽取可译 JSON 字符串叶节点，提供原型安全的非递归深拷贝与路径格式化，并基于 delimited 解析器生成表格单元格片段。
 * 模块边界：仅处理 JSON 与分隔符表格的数据结构解析与路径读写，不承担双语渲染编排或二进制文件 I/O。
 */
import {isTranslatableDelimitedCell, readDelimitedCells} from '../delimited';
import {
    addLiteral,
    trimSource,
    type DocumentPart,
    type DocumentSegment,
    type JsonSegmentEntry,
    type ParsedDocument,
} from './shared';

const MAX_JSON_DEPTH = 1_000;

export function cloneJsonValue(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : {};
    const copies = new WeakMap<object, Record<string, unknown> | unknown[]>([[value, output]]);
    const stack = [{source: value, target: output, depth: 0}];
    while (stack.length) {
        const {source, target, depth} = stack.pop()!;
        if (depth > MAX_JSON_DEPTH) throw new Error('JSON 文件嵌套过深，请拆分后重试');
        for (const [key, item] of Object.entries(source)) {
            let copy = item;
            if (item && typeof item === 'object') {
                copy = copies.get(item);
                if (!copy) {
                    copy = Array.isArray(item) ? new Array(item.length) : {};
                    copies.set(item, copy);
                    stack.push({source: item, target: copy, depth: depth + 1});
                }
            }
            // JSON 的 __proto__ 是普通键；不能通过赋值触发对象原型 setter。
            Object.defineProperty(target, key, {value: copy, enumerable: true, writable: true, configurable: true});
        }
    }
    return output;
}

/**
 * JSON 里给程序看的字符串不送去翻译，原样留在文件里：没有任何文字的值（版本号、日期、数字）、网址与邮箱链接、
 * 十六进制颜色，以及不含空格却带数字的标识符（ID、哈希、带编号的键名）。单个普通单词仍然翻译。
 */
function jsonMachineValue(value: string): boolean {
    return !/\p{L}/u.test(value)
        || /^(?:https?:\/\/|mailto:|www\.)\S+$/iu.test(value)
        || /^#[0-9a-f]{3,8}$/iu.test(value)
        || (/\d/u.test(value) && /^[\w.\-:/+]+$/u.test(value));
}

export function formatJsonPath(path: Array<string | number>): string {
    return path.reduce<string>((value, part) => {
        if (typeof part === 'number') return `${value}[${part}]`;
        return /^[A-Za-z_$][\w$]*$/u.test(part)
            ? `${value}.${part}`
            : `${value}[${JSON.stringify(part)}]`;
    }, '$');
}

export function parseJsonDocument(content: string): Pick<ParsedDocument, 'segments' | 'jsonValue' | 'jsonEntries'> {
    let jsonValue: unknown;
    try {
        jsonValue = JSON.parse(content);
    } catch (error) {
        // JSON.parse 按规范只会抛 SyntaxError；统一字符串化后移除类型前缀，避免不可达的错误类型分支。
        const message = String(error).replace(/^SyntaxError:\s*/u, '');
        throw new Error(`JSON 文件格式无效：${message}`);
    }

    const segments: DocumentSegment[] = [];
    const jsonEntries: JsonSegmentEntry[] = [];
    // 只把字符串叶节点送去翻译（给程序看的值除外），并记录路径与首尾空白；渲染时在深拷贝上回填，原对象始终不变。
    const stack: Array<{value: unknown; path: Array<string | number>}> = [{value: jsonValue, path: []}];
    while (stack.length) {
        const {value, path} = stack.pop()!;
        if (path.length > MAX_JSON_DEPTH) throw new Error('JSON 文件嵌套过深，请拆分后重试');
        if (typeof value === 'string') {
            const trimmed = trimSource(value);
            if (!trimmed || jsonMachineValue(trimmed.source)) continue;
            const segmentIndex = segments.length;
            const pathLabel = formatJsonPath(path);
            segments.push({id: segmentIndex, source: trimmed.source, pathLabel});
            jsonEntries.push({path: [...path], segmentIndex, prefix: trimmed.prefix, suffix: trimmed.suffix});
            continue;
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const [key, item] = entries[index];
                stack.push({value: item, path: [...path, Array.isArray(value) ? Number(key) : key]});
            }
        }
    }
    return {segments, jsonValue, jsonEntries};
}

export function parseDelimitedDocument(content: string, delimiter: ',' | '\t'): Pick<ParsedDocument, 'parts' | 'segments' | 'delimitedColumns'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const labels = new Map<number, string>();
    const columns = new Set<number>();
    let last = 0;
    for (const cell of readDelimitedCells(content, delimiter)) {
        const trimmed = trimSource(cell.value);
        if (cell.row === 0 && trimmed) labels.set(cell.column, trimmed.source.replace(/\s+/gu, ' ').slice(0, 80));
        if (!trimmed || !isTranslatableDelimitedCell(trimmed.source)) continue;
        addLiteral(parts, content.slice(last, cell.start));
        last = cell.end;
        const id = segments.length;
        segments.push({id, source: trimmed.source, pathLabel: `R${cell.row + 1}C${cell.column + 1}`, delimitedCell: {row: cell.row, column: cell.column}});
        parts.push({
            kind: 'segment', segmentIndex: id, ...trimmed, rawSource: content.slice(cell.start, cell.end),
            delimitedCell: {delimiter, quoted: cell.quoted},
        });
        columns.add(cell.column);
    }
    addLiteral(parts, content.slice(last));
    const delimitedColumns = [...columns].sort((left, right) => left - right).map(index => ({index, label: labels.get(index) ?? ''}));
    return {parts, segments, delimitedColumns};
}

export function getAtPath(value: unknown, path: Array<string | number>): unknown {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

export function setAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
    if (path.length === 0) return value;
    let current = root as Record<string | number, unknown>;
    path.slice(0, -1).forEach((key) => {
        current = current[key] as Record<string | number, unknown>;
    });
    current[path[path.length - 1]] = value;
    return root;
}
