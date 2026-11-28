/**
 * @file src/features/document-translation/core/xlsxXml.ts
 * 文件职责：为 Excel OOXML 工作簿、共享字符串表与工作表提供无副作用的解析与安全回填算法。
 * 主要内容：按工作簿声明顺序解析工作表与关系映射并支持无清单回退，解析共享字符串及富文本运行并忽略日语注音节点，区分共享字符串与行内字符串单元格而严格跳过公式、数字、布尔与日期单元格，导出时以追加去重方式更新共享字符串表并同步维护计数属性。
 * 模块边界：仅操作 SpreadsheetML XML 字符串与单元格坐标，不依赖 JSZip、File 或浏览器环境；复用 delimited 的公式与可译单元格判定，归档读写与取消由 services/binary 承担。
 */
import {SaxesParser} from 'saxes';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {isSpreadsheetFormula, isTranslatableDelimitedCell} from './delimited';

export interface XlsxSheetDescriptor {
    name: string;
    path: string;
}

export interface XlsxExtractedCell {
    cellRef: string;
    kind: 'shared' | 'inline';
    sharedIndex?: number;
    source: string;
    rawText: string;
}

export interface XlsxRenderCellRef {
    cellRef: string;
    kind: 'shared' | 'inline';
    sharedIndex?: number;
    segmentIndex: number;
}

function stripInvalidXmlChars(value: string): string {
    return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '');
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}

export function resolveXlsxTargetPath(baseFile: string, target: string): string {
    const clean = target.replace(/\\/gu, '/');
    const combined = clean.startsWith('/')
        ? clean.slice(1)
        : `${baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : ''}${clean}`;
    const result: string[] = [];
    for (const part of combined.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') result.pop();
        else result.push(part);
    }
    return result.join('/');
}

export function parseXlsxWorkbookSheets(
    workbookXml: string | undefined,
    relsXml: string | undefined,
    availablePaths: readonly string[],
): XlsxSheetDescriptor[] {
    const available = new Set(availablePaths);
    const rels = new Map<string, string>();
    if (relsXml) {
        const relParser = new SaxesParser({xmlns: false as const});
        relParser.on('opentag', tag => {
            if (tag.name === 'Relationship' && tag.attributes.Id && tag.attributes.Target) {
                rels.set(String(tag.attributes.Id), resolveXlsxTargetPath('xl/workbook.xml', String(tag.attributes.Target)));
            }
        });
        try {relParser.write(relsXml).close();} catch {rels.clear();}
    }

    const sheets: XlsxSheetDescriptor[] = [];
    if (workbookXml && rels.size > 0) {
        const wbParser = new SaxesParser({xmlns: false as const});
        wbParser.on('opentag', tag => {
            if (tag.name !== 'sheet') return;
            const name = String(tag.attributes.name ?? '').trim();
            const relId = String(tag.attributes['r:id'] ?? tag.attributes.id ?? '');
            const path = relId ? rels.get(relId) : undefined;
            if (path && available.has(path)) sheets.push({name: name || `Sheet ${sheets.length + 1}`, path});
        });
        try {wbParser.write(workbookXml).close();} catch {sheets.length = 0;}
    }

    if (sheets.length > 0) return sheets;

    return availablePaths
        .map(path => ({path, match: /^xl\/worksheets\/sheet(\d+)\.xml$/iu.exec(path)}))
        .filter((entry): entry is {path: string; match: RegExpExecArray} => Boolean(entry.match))
        .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
        .map(({path, match}) => ({name: `Sheet ${Number(match[1])}`, path}));
}

export function parseXlsxSharedStrings(sharedStringsXml: string): string[] {
    const strings: string[] = [];
    const parser = new SaxesParser({xmlns: false as const});
    let inSi = false;
    let phoneticDepth = 0;
    let inText = false;
    let current = '';

    parser.on('opentag', tag => {
        if (tag.name === 'si') {inSi = true; current = '';}
        else if (inSi && tag.name === 'rPh') phoneticDepth += 1;
        else if (inSi && phoneticDepth === 0 && tag.name === 't') inText = true;
    });
    parser.on('closetag', tag => {
        if (tag.name === 't') inText = false;
        else if (tag.name === 'rPh' && phoneticDepth > 0) phoneticDepth -= 1;
        else if (tag.name === 'si' && inSi) {
            strings.push(current);
            inSi = false;
        }
    });
    const append = (text: string) => {if (inText) current += text;};
    parser.on('text', append);
    parser.on('cdata', append);
    try {
        parser.write(sharedStringsXml).close();
    } catch {
        return [];
    }
    return strings;
}

export function parseXlsxWorksheetXml(sheetXml: string, sharedStrings: readonly string[]): XlsxExtractedCell[] {
    const cells: XlsxExtractedCell[] = [];
    const parser = new SaxesParser({xmlns: false as const});
    let cellRef = '';
    let cellType = '';
    let inCell = false;
    let hasFormula = false;
    let inValue = false;
    let inInline = false;
    let phoneticDepth = 0;
    let inText = false;
    let valueText = '';
    let inlineText = '';

    parser.on('opentag', tag => {
        if (tag.name === 'c') {
            inCell = true;
            cellRef = String(tag.attributes.r ?? '');
            cellType = String(tag.attributes.t ?? '');
            hasFormula = false;
            valueText = '';
            inlineText = '';
        } else if (!inCell) {
            return;
        } else if (tag.name === 'f') {
            hasFormula = true;
        } else if (tag.name === 'v') {
            inValue = true;
        } else if (tag.name === 'is') {
            inInline = true;
        } else if (inInline && tag.name === 'rPh') {
            phoneticDepth += 1;
        } else if (inInline && phoneticDepth === 0 && tag.name === 't') {
            inText = true;
        }
    });
    parser.on('closetag', tag => {
        if (tag.name === 'v') inValue = false;
        else if (tag.name === 't') inText = false;
        else if (tag.name === 'rPh' && phoneticDepth > 0) phoneticDepth -= 1;
        else if (tag.name === 'is') inInline = false;
        else if (tag.name === 'c' && inCell) {
            inCell = false;
            if (hasFormula || !cellRef) return;
            if (cellType === 's') {
                const sharedIndex = Number.parseInt(valueText.trim(), 10);
                const rawText = Number.isInteger(sharedIndex) && sharedIndex >= 0 ? sharedStrings[sharedIndex] : undefined;
                if (rawText !== undefined) {
                    const trimmed = rawText.trim();
                    if (trimmed && isTranslatableDelimitedCell(trimmed)) {
                        cells.push({cellRef, kind: 'shared', sharedIndex, source: trimmed, rawText});
                    }
                }
            } else if (cellType === 'inlineStr') {
                const trimmed = inlineText.trim();
                if (trimmed && isTranslatableDelimitedCell(trimmed)) {
                    cells.push({cellRef, kind: 'inline', source: trimmed, rawText: inlineText});
                }
            }
        }
    });
    const append = (text: string) => {
        if (inValue) valueText += text;
        else if (inText) inlineText += text;
    };
    parser.on('text', append);
    parser.on('cdata', append);
    try {
        parser.write(sheetXml).close();
    } catch {
        return [];
    }
    return cells;
}

export function renderXlsxWorksheetXml(
    sheetXml: string,
    cellSegments: ReadonlyArray<XlsxRenderCellRef>,
    segments: ReadonlyArray<{source: string}>,
    translations: readonly string[],
    sharedStrings: readonly string[],
    mode: 'bilingual' | 'translated',
    appendSharedString: (value: string) => number,
): string {
    const byCellRef = new Map(cellSegments.map(entry => [entry.cellRef, entry]));
    const replacements: Array<{start: number; end: number; value: string}> = [];
    const parser = new SaxesParser({xmlns: false as const});

    let activeEntry: XlsxRenderCellRef | undefined;
    let targetTagStart = -1;
    let targetTagName = '';
    let inlineText = '';
    let phoneticDepth = 0;
    let inInlineText = false;

    parser.on('opentag', tag => {
        if (tag.name === 'c') {
            const ref = String(tag.attributes.r ?? '');
            activeEntry = ref ? byCellRef.get(ref) : undefined;
            targetTagStart = -1;
            targetTagName = '';
            inlineText = '';
            phoneticDepth = 0;
            inInlineText = false;
            return;
        }
        if (!activeEntry) return;
        if (activeEntry.kind === 'shared' && tag.name === 'v') {
            targetTagStart = sheetXml.lastIndexOf('<', parser.position - 1);
            targetTagName = 'v';
        } else if (activeEntry.kind === 'inline' && tag.name === 'is') {
            targetTagStart = sheetXml.lastIndexOf('<', parser.position - 1);
            targetTagName = 'is';
        } else if (targetTagName === 'is' && tag.name === 'rPh') {
            phoneticDepth += 1;
        } else if (targetTagName === 'is' && phoneticDepth === 0 && tag.name === 't') {
            inInlineText = true;
        }
    });
    parser.on('closetag', tag => {
        if (tag.name === 't') inInlineText = false;
        else if (tag.name === 'rPh' && phoneticDepth > 0) phoneticDepth -= 1;
        else if (activeEntry && tag.name === targetTagName && targetTagStart >= 0) {
            const segment = segments[activeEntry.segmentIndex];
            const translation = translations[activeEntry.segmentIndex] ?? '';
            if (segment && hasDistinctTranslation(segment.source, translation)) {
                const rawOriginal = activeEntry.kind === 'shared'
                    ? (sharedStrings[activeEntry.sharedIndex!] ?? segment.source)
                    : inlineText;
                const rendered = mode === 'bilingual'
                    ? `${rawOriginal}\n${translation}`
                    : translation;
                if (!isSpreadsheetFormula(rendered)) {
                    const clean = stripInvalidXmlChars(rendered);
                    if (activeEntry.kind === 'shared') {
                        const newIndex = appendSharedString(clean);
                        replacements.push({start: targetTagStart, end: parser.position, value: `<v>${newIndex}</v>`});
                    } else {
                        replacements.push({
                            start: targetTagStart,
                            end: parser.position,
                            value: `<is><t xml:space="preserve">${xmlEscape(clean)}</t></is>`,
                        });
                    }
                }
            }
            targetTagStart = -1;
            targetTagName = '';
        } else if (tag.name === 'c') {
            activeEntry = undefined;
        }
    });
    const append = (text: string) => {if (inInlineText) inlineText += text;};
    parser.on('text', append);
    parser.on('cdata', append);
    try {
        parser.write(sheetXml).close();
    } catch {
        return sheetXml;
    }

    if (replacements.length === 0) return sheetXml;
    const output: string[] = [];
    let cursor = 0;
    for (const item of replacements) {
        output.push(sheetXml.slice(cursor, item.start), item.value);
        cursor = item.end;
    }
    output.push(sheetXml.slice(cursor));
    return output.join('');
}

export function appendXlsxSharedStringsXml(
    sharedStringsXml: string,
    appendedStrings: readonly string[],
    originalUniqueCount: number,
): string {
    if (appendedStrings.length === 0) return sharedStringsXml;
    const entriesXml = appendedStrings
        .map(value => `<si><t xml:space="preserve">${xmlEscape(stripInvalidXmlChars(value))}</t></si>`)
        .join('');
    const newUniqueCount = originalUniqueCount + appendedStrings.length;
    const updateCounts = (openTag: string) => {
        let updated = openTag;
        if (/\buniqueCount=["']\d+["']/u.test(updated)) {
            updated = updated.replace(/\buniqueCount=["']\d+["']/u, `uniqueCount="${newUniqueCount}"`);
        } else {
            updated = updated.replace(/(\s*\/?>)$/u, ` uniqueCount="${newUniqueCount}"$1`);
        }
        if (/\bcount=["'](\d+)["']/u.test(updated)) {
            updated = updated.replace(/\bcount=["'](\d+)["']/u, (_, prev: string) =>
                `count="${Math.max(Number(prev), originalUniqueCount) + appendedStrings.length}"`);
        } else {
            updated = updated.replace(/(\s*\/?>)$/u, ` count="${newUniqueCount}"$1`);
        }
        return updated;
    };
    const sstOpenMatch = /<sst\b[^>]*>/u.exec(sharedStringsXml);
    if (!sstOpenMatch) return sharedStringsXml;
    const openTag = sstOpenMatch[0];
    if (openTag.endsWith('/>')) {
        const expandedOpen = updateCounts(openTag.slice(0, -2) + '>');
        return `${sharedStringsXml.slice(0, sstOpenMatch.index)}${expandedOpen}${entriesXml}</sst>${sharedStringsXml.slice(sstOpenMatch.index + openTag.length)}`;
    }
    const closingIndex = sharedStringsXml.lastIndexOf('</sst>');
    if (closingIndex < 0) return sharedStringsXml;
    const updatedOpen = updateCounts(openTag);
    return `${sharedStringsXml.slice(0, sstOpenMatch.index)}${updatedOpen}${sharedStringsXml.slice(sstOpenMatch.index + openTag.length, closingIndex)}${entriesXml}${sharedStringsXml.slice(closingIndex)}`;
}
