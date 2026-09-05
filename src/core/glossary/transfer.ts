/**
 * @file src/core/glossary/transfer.ts
 * 文件职责：把 CSV、TSV 和 JSON 术语文件转换为可确认的导入预览，并输出可在表格软件中安全打开且精确回导的文件。
 * 主要内容：解析引号、多行、BOM 和中英文列名，按目标语言 tgt_lng 分组，并在表格导出中保留源目标语言；对格式错误、范围错误和容量超限给出阻止性错误，防止静默丢词。
 * 模块边界：本文件只转换字符串和领域对象，不打开文件、不修改配置、不触发下载；导入确认与持久化由设置界面承担。
 */
import {cleanGlossaryText, glossaryRecord, GLOSSARY_LIMITS, normalizeGlossaryDomain,
    normalizeGlossaryLanguage, normalizeGlossaryLibraries, type GlossaryLibrary} from './model';

export type GlossaryImportFormat = 'csv' | 'tsv' | 'json';
export interface GlossaryImportPreview {
    libraries: GlossaryLibrary[];
    warnings: string[];
    errors: string[];
    totalEntries: number;
    acceptedEntries: number;
}

/** RFC 4180 的引号状态机同样用于 TSV，确保引号内的换行与分隔符不会产生伪条目。 */
function parseRows(text: string, separator: string, errors: string[]): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let closed = false;
    const finishField = () => { row.push(field); field = ''; closed = false; };
    const finishRow = () => {
        finishField();
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
    };
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') { field += '"'; index += 1; }
                else { quoted = false; closed = true; }
            } else field += char;
        } else if (char === separator) finishField();
        else if (char === '\r' || char === '\n') {
            if (char === '\r' && text[index + 1] === '\n') index += 1;
            finishRow();
        } else if (char === '"' && !field && !closed) quoted = true;
        else if (char === '"' || (closed && char.trim())) {
            errors.push(`第 ${rows.length + 1} 行引号格式错误。`);
            return [];
        } else if (!closed) field += char;
    }
    if (quoted) { errors.push('文件有未闭合的引号。'); return []; }
    finishRow();
    return rows;
}

const HEADER_NAMES: Record<string, string> = {
    source: 'source', sourceterm: 'source', 原文: 'source', 原词: 'source', 源术语: 'source', 术语: 'source',
    target: 'target', targetterm: 'target', 译文: 'target', 译词: 'target', 目标术语: 'target', 翻译: 'target',
    casesensitive: 'caseSensitive', 区分大小写: 'caseSensitive', 大小写敏感: 'caseSensitive',
    tgtlng: 'targetLanguage', targetlanguage: 'targetLanguage', 目标语言: 'targetLanguage',
    srclng: 'sourceLanguage', sourcelanguage: 'sourceLanguage', 源语言: 'sourceLanguage',
    fluentreadescaped: 'escaped',
};

function headerName(value: string): string {
    const key = value.trim().toLowerCase().replace(/[\s_-]/gu, '');
    return Object.hasOwn(HEADER_NAMES, key) ? HEADER_NAMES[key] : '';
}

function tableLibraries(rows: string[][], preview: GlossaryImportPreview): unknown[] {
    if (!rows.length) return [];
    const possible = rows[0].map(headerName);
    const hasHeader = possible.includes('source') && possible.includes('target');
    const headers = hasHeader ? possible : ['source', 'target'];
    if (hasHeader && new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
        preview.errors.push('表头包含重复列，无法确定应使用哪一列。'); return [];
    }
    if (hasHeader && headers.includes('')) preview.warnings.push('未识别的表格列不会导入。');
    const groups = new Map<string, {name: string; sourceLanguage: string; targetLanguage: string; entries: unknown[]}>();
    rows.slice(hasHeader ? 1 : 0).forEach((row, index) => {
        preview.totalEntries += 1;
        const line = index + (hasHeader ? 2 : 1);
        if (row.length !== headers.length) { preview.errors.push(`第 ${line} 行列数与表头不一致。`); return; }
        const values: Record<string, string> = {};
        headers.forEach((header, column) => { values[header] = row[column]; });
        for (const field of ['source', 'target']) {
            if (values.escaped?.split('|').includes(field) && values[field].startsWith("'")) values[field] = values[field].slice(1);
        }
        const flag = (values.caseSensitive ?? '').trim().toLowerCase();
        if (!['', 'false', 'true', '0', '1', 'yes', 'no', '是', '否'].includes(flag)) {
            preview.errors.push(`第 ${line} 行“区分大小写”须为 true 或 false。`); return;
        }
        const sourceLanguage = normalizeGlossaryLanguage(values.sourceLanguage);
        const targetLanguage = normalizeGlossaryLanguage(values.targetLanguage);
        for (const field of ['sourceLanguage', 'targetLanguage']) {
            if (values[field]?.trim() && values[field].toLowerCase().trim() !== 'auto' && !normalizeGlossaryLanguage(values[field])) {
                preview.errors.push(`第 ${line} 行语言代码无效：${values[field]}。`);
            }
        }
        const key = `${sourceLanguage}:${targetLanguage}`;
        if (!groups.has(key)) groups.set(key, {
            name: `导入的术语库${targetLanguage ? ` (${targetLanguage})` : ''}`,
            sourceLanguage, targetLanguage, entries: [],
        });
        groups.get(key)!.entries.push({source: values.source, target: values.target,
            caseSensitive: ['true', '1', 'yes', '是'].includes(flag)});
    });
    if (groups.size > 1) preview.warnings.push(`已按语言分成 ${groups.size} 个术语库，请分别确认适用语言。`);
    return [...groups.values()];
}

function jsonLibraries(text: string, preview: GlossaryImportPreview): unknown[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { preview.errors.push('JSON 格式无效，请检查文件。'); return []; }
    const record = glossaryRecord(parsed);
    if (record?.version !== undefined && record.version !== 1) {
        preview.errors.push('不支持此术语文件版本。'); return [];
    }
    if (Array.isArray(parsed)) {
        return parsed.every((entry) => glossaryRecord(entry)?.source !== undefined)
            ? [{name: '导入的术语库', entries: parsed}] : parsed;
    }
    if (record && Array.isArray(record.libraries)) return record.libraries;
    if (record?.library !== undefined) return [record.library];
    if (record && Array.isArray(record.entries)) return [record];
    preview.errors.push('JSON 需要包含术语库或术语条目数组。');
    return [];
}

function validateLibraries(raw: unknown[], preview: GlossaryImportPreview, countEntries: boolean): void {
    if (raw.length > GLOSSARY_LIMITS.libraries) preview.errors.push(`最多导入 ${GLOSSARY_LIMITS.libraries} 个术语库，请拆分文件。`);
    raw.forEach((value, libraryIndex) => {
        const library = glossaryRecord(value);
        if (!library || !Array.isArray(library.entries)) {
            preview.errors.push(`第 ${libraryIndex + 1} 个术语库缺少条目数组。`); return;
        }
        if (countEntries) preview.totalEntries += library.entries.length;
        if (library.entries.length > GLOSSARY_LIMITS.entriesPerLibrary) {
            preview.errors.push(`第 ${libraryIndex + 1} 个术语库超过 ${GLOSSARY_LIMITS.entriesPerLibrary} 条，请拆分词表。`);
        }
        if (library.name !== undefined && Array.from(cleanGlossaryText(library.name)).length > GLOSSARY_LIMITS.nameLength) {
            preview.warnings.push(`第 ${libraryIndex + 1} 个术语库名称将截短至 ${GLOSSARY_LIMITS.nameLength} 字。`);
        }
        if (library.domains != null) {
            if (!Array.isArray(library.domains) || library.domains.some((domain) => !normalizeGlossaryDomain(domain))) {
                preview.errors.push(`第 ${libraryIndex + 1} 个术语库的网站规则无效，请使用 example.com 或 *.example.com。`);
            } else if (library.domains.length > GLOSSARY_LIMITS.domainsPerLibrary) {
                preview.errors.push(`每个术语库最多 ${GLOSSARY_LIMITS.domainsPerLibrary} 条网站规则。`);
            }
        }
        for (const field of ['sourceLanguage', 'targetLanguage']) {
            const language = library[field];
            if (language != null && language !== '' && language !== 'auto' && !normalizeGlossaryLanguage(language)) {
                preview.errors.push(`第 ${libraryIndex + 1} 个术语库的语言代码无效。`);
            }
        }
        library.entries.forEach((rawEntry, entryIndex) => {
            const entry = glossaryRecord(rawEntry);
            if (!entry || typeof entry.source !== 'string' || !cleanGlossaryText(entry.source)
                || (entry.target !== undefined && typeof entry.target !== 'string')) {
                preview.errors.push(`术语库 ${libraryIndex + 1} 的第 ${entryIndex + 1} 条需要非空原文及文本译文。`); return;
            }
            if (entry.caseSensitive !== undefined && typeof entry.caseSensitive !== 'boolean') {
                preview.errors.push(`术语库 ${libraryIndex + 1} 的第 ${entryIndex + 1} 条大小写选项需要布尔值。`);
            }
            if ([entry.source, entry.target].some((term) => Array.from(cleanGlossaryText(term)).length > GLOSSARY_LIMITS.termLength)) {
                preview.errors.push(`术语库 ${libraryIndex + 1} 的第 ${entryIndex + 1} 条超过 ${GLOSSARY_LIMITS.termLength} 字。`);
            }
            if ([entry.source, entry.target].some((term) => typeof term === 'string' && cleanGlossaryText(term) !== term)) {
                preview.warnings.push('部分术语已统一 Unicode 写法，并清理首尾空白或无效控制字符，请检查预览。');
            }
        });
    });
    if (preview.totalEntries > GLOSSARY_LIMITS.totalEntries) preview.errors.push(`一次最多导入 ${GLOSSARY_LIMITS.totalEntries} 条术语。`);
}

export function parseGlossaryImport(text: string, format: GlossaryImportFormat): GlossaryImportPreview {
    const preview: GlossaryImportPreview = {libraries: [], warnings: [], errors: [], totalEntries: 0, acceptedEntries: 0};
    if (text.length > GLOSSARY_LIMITS.importBytes || new TextEncoder().encode(text).length > GLOSSARY_LIMITS.importBytes) {
        preview.errors.push('文件超过 2 MB，请拆分后再导入。'); return preview;
    }
    const content = text.replace(/^\uFEFF/u, '');
    const raw = format === 'json' ? jsonLibraries(content, preview)
        : tableLibraries(parseRows(content, format === 'csv' ? ',' : '\t', preview.errors), preview);
    validateLibraries(raw, preview, format === 'json');
    preview.libraries = normalizeGlossaryLibraries(raw);
    preview.acceptedEntries = preview.libraries.reduce((sum, library) => sum + library.entries.length, 0);
    if (!preview.acceptedEntries && !preview.errors.length) preview.errors.push('文件中没有可导入的术语。');
    // 错误仍保留有限预览方便修复，但调用方必须在 errors 非空时禁用确认操作。
    preview.errors = [...new Set(preview.errors)].slice(0, 50);
    preview.warnings = [...new Set(preview.warnings)];
    return preview;
}

/** 仅对会被表格软件解释为公式的字段加前缀，并记录字段名；普通文件中的原生单引号绝不被猜测移除。 */
export function exportGlossary(library: GlossaryLibrary, format: GlossaryImportFormat): string {
    if (format === 'json') return JSON.stringify({version: 1, library}, null, 2);
    const separator = format === 'csv' ? ',' : '\t';
    const encode = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = library.entries.map((entry) => {
        const escaped: string[] = [];
        const fields = (['source', 'target'] as const).map((field) => {
            const value = entry[field];
            if (/^\s*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)) {
                escaped.push(field); return `'${value}`;
            }
            return value;
        });
        return [...fields, String(entry.caseSensitive), escaped.join('|'), library.sourceLanguage, library.targetLanguage]
            .map(encode).join(separator);
    });
    return `\uFEFF${['source', 'target', 'caseSensitive', 'fluentreadEscaped', 'src_lng', 'tgt_lng'].join(separator)}\r\n${rows.join('\r\n')}`;
}
