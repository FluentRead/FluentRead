/**
 * @file src/features/document-translation/ui/readers/jsonReader.ts
 *
 * 文件职责：为 JSON 结构化翻译文档提供占位符分词、顶层命名空间目录、按父路径分组分页表格及迭代式可折叠语法树节点构造器。
 * 主要内容：导出 tokenizeJsonInterpolation、buildJsonOutline、buildJsonGroupedRows 与 buildJsonTreeNodes，支持按需节点上限裁剪避免超大 JSON 树卡顿。
 * 模块边界：无副作用的纯数据模型层，仅读取 ParsedDocument 与译文数组，不触碰浏览器 DOM 或修改原始 JSON 数据。
 */

import {hasDistinctTranslation} from '@/src/core/translation/result';
import {formatJsonPath, type ParsedDocument} from '../../core/document';
import {clampPositiveInt} from './shared';

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

export interface BuildJsonTreeNodesOptions {
    maxNodes?: number;
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
