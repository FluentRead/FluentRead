/**
 * @file src/features/document-translation/core/formats/markdown.ts
 * 文件职责：负责纯文本与 Markdown 文档的容器状态机解析、折行段落合并、行内语法占位保护及 CommonMark 强调边界译文还原。
 * 主要内容：识别 frontmatter、围栏与缩进代码块、数学块、GFM 表格、容器指令与行内链接/强调/代码；展开纯文本与 Markdown 软折行并在渲染时无损回填行内占位符。
 * 模块边界：仅处理 TXT 与 Markdown 的文本解析和片段还原，不处理 HTML/字幕/JSON 格式或二进制文件读写。
 */
import {normalizeDocumentInlineMarkers} from '@/src/core/translation/public';
import {markdownTableAlignments, splitMarkdownTableRow, type MarkdownTable} from '../markdownTable';
import {
    addLiteral,
    addSegment,
    findNextHtmlToken,
    splitWithEndings,
    trimSource,
    type DocumentFormat,
    type DocumentPart,
    type DocumentSegment,
    type MarkdownCodeBlock,
    type ParsedDocument,
    type SegmentOptions,
    type SegmentPart,
} from './shared';

const MARKDOWN_PROTECTED_PATTERN = /(`{1,3}[^`]+`{1,3}|<https?:\/\/[^>]+>|https?:\/\/[^\s)]+|\$[^$\r\n]+\$|%%[^%\r\n]+%%|(?:^|\s)#[\p{L}\p{N}_/-]+)/gu;
const MARKDOWN_PLACEHOLDER = /<\s*\/?\s*g\s*\d+\s*\/?\s*>/iu;
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。、；：！？（）《》“”‘’]/u;
const UNSPACED_WRAP_END = new RegExp(`${UNSPACED_SCRIPT.source}$`, 'u');
const UNSPACED_WRAP_START = new RegExp(`^${UNSPACED_SCRIPT.source}`, 'u');
const maxMarkdownParagraphLength = 3_500;

/** 链接的闭合位置只扫描一次，避免重复未闭合 `[` 的正则回溯；URL 括号按配对保护。 */
function markdownLinkRanges(value: string): Array<{start: number; end: number}> {
    const ranges: Array<{start: number; end: number}> = [];
    let bracketClose = value.indexOf(']');
    if (bracketClose < 0 || !value.includes('[')) return ranges;
    const roundCloses = new Map<number, number>();
    const stack: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '\\') {index += 1; continue;}
        if (value[index] === '(') stack.push(index);
        else if (value[index] === ')' && stack.length) roundCloses.set(stack.pop()!, index);
    }
    for (let index = 0; index < value.length; index += 1) {
        const open = value[index] === '!' && value[index + 1] === '[' ? index + 1 : index;
        if (value[open] !== '[') continue;
        while (bracketClose >= 0 && bracketClose <= open) bracketClose = value.indexOf(']', bracketClose + 1);
        if (bracketClose < 0) break;
        let end = 0;
        if (value[open + 1] === '[' && bracketClose > open + 2 && value[bracketClose + 1] === ']') {
            end = bracketClose + 2;
        } else if (value[bracketClose + 1] === '(') {
            const close = roundCloses.get(bracketClose + 1);
            if (close !== undefined) end = close + 1;
        }
        if (end) {
            ranges.push({start: index, end});
            index = end - 1;
        }
    }
    return ranges;
}

function addMarkdownProtectedText(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    bilingualGroup: number,
): void {
    const pattern = MARKDOWN_PROTECTED_PATTERN;
    pattern.lastIndex = 0;
    let cursor = 0;
    const atPosition = (offset: number): SegmentOptions => ({bilingualGroup, markdownLineStart: offset === 0});
    const links = markdownLinkRanges(value);
    let linkIndex = 0;
    let match = pattern.exec(value);
    while (match || linkIndex < links.length) {
        const link = links[linkIndex];
        const useLink = link && (!match || link.start <= match.index);
        const start = useLink ? link.start : match!.index;
        const end = useLink ? link.end : match!.index + match![0].length;
        if (useLink) linkIndex += 1;
        else match = pattern.exec(value);
        // 链接中的 URL 或代码中的链接由更早开始的外层语法整体保护。
        if (start < cursor) continue;
        addSegment(parts, segments, value.slice(cursor, start), atPosition(cursor));
        addLiteral(parts, value.slice(start, end), bilingualGroup);
        cursor = end;
    }
    addSegment(parts, segments, value.slice(cursor), atPosition(cursor));
}

/**
 * 一行或一个折行段落作为一个片段翻译：链接写成成对的编号占位符（链接文字仍然翻译，地址原样保留），
 * 行内代码、网址、公式与标签写成单个占位符。这样句子不会被行内语法拆散，受保护的内容也不会被改写。
 * 仅在调用方启用整句方式时使用；默认仍按受保护内容把一行切成多段。
 */
function addMarkdownSentence(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    bilingualGroup?: number,
    {rawValue = value, markdownTableCell}: {rawValue?: string; markdownTableCell?: SegmentPart['markdownTableCell']} = {},
): void {
    // 行首容器和标题语法留在本地：服务可能把 "# Heading" 改成 "#标题"，或擅自改动列表编号。
    const container = inspectMarkdownLine(value);
    const heading = container.content.match(/^#{1,6}[\t ]+/u)?.[0] ?? '';
    const checkbox = container.listIndent ? container.content.match(/^\[[ xX]\][\t ]+/u)?.[0] ?? '' : '';
    const prefixLength = markdownTableCell ? 0 : value.length - container.content.length + heading.length + checkbox.length;
    if (prefixLength) {
        addLiteral(parts, value.slice(0, prefixLength), bilingualGroup);
        value = value.slice(prefixLength);
        rawValue = rawValue.slice(prefixLength);
    }
    const pattern = MARKDOWN_PROTECTED_PATTERN;
    pattern.lastIndex = 0;
    let cursor = 0;
    const tokens: Array<{open: string; close?: string}> = [];
    let source = '';
    // 常见强调使用与链接相同的成对占位符，文字仍参与整句翻译；避免机器服务直接删掉 ** 或 _。
    // 两种分支各自止于下一个同类标记，不对未闭合的长行做跨标记回溯；代码与 URL 已由外层保护。
    const emphasis = (plain: string) => plain.replace(/(?<![\\*])(\*\*|\*)(?![\s*])([^*\n]*?\S)\1(?!\*)|(?<![\\\p{L}\p{N}])(__|_)(?![\s_])([^_\n]*?\S)\3(?![\p{L}\p{N}_])/gu,
        (_match, stars: string | undefined, starText: string | undefined, underscores: string | undefined, underscoreText: string | undefined) => {
            const marker = stars || underscores!;
            tokens.push({open: marker, close: marker});
            return `<g${tokens.length}>${starText ?? underscoreText}</g${tokens.length}>`;
        });
    const links = markdownLinkRanges(value);
    let linkIndex = 0;
    let match = pattern.exec(value);
    while (match || linkIndex < links.length) {
        const link = links[linkIndex];
        const useLink = link && (!match || link.start <= match.index);
        const start = useLink ? link.start : match!.index;
        const end = useLink ? link.end : match!.index + match![0].length;
        if (useLink) linkIndex += 1;
        else match = pattern.exec(value);
        // 链接中的 URL 或代码中的链接由更早开始的外层语法整体保护。
        if (start < cursor) continue;
        source += emphasis(value.slice(cursor, start));
        const raw = value.slice(start, end);
        // 只有“[文字](地址)”形式的链接文字参与翻译；图片与 [[双链]] 整体保护。
        const text = useLink && !raw.startsWith('!') && !raw.startsWith('[[') ? raw.slice(1, raw.indexOf('](')) : '';
        if (text.trim() && !MARKDOWN_PLACEHOLDER.test(text)) {
            tokens.push({open: '[', close: raw.slice(1 + text.length)});
            source += `<g${tokens.length}>${text}</g${tokens.length}>`;
        } else {
            tokens.push({open: raw});
            source += `<g${tokens.length}/>`;
        }
        cursor = end;
    }
    source += emphasis(value.slice(cursor));
    const options: SegmentOptions = {bilingualGroup, markdownLineStart: !markdownTableCell, markdownTableCell};
    // 没有行内语法，或文字本身含有占位符写法（无法区分真假占位符）时，整行按普通文字处理。
    if (!tokens.length || MARKDOWN_PLACEHOLDER.test(value)) {
        addSegment(parts, segments, rawValue, options, () => value.trim());
        return;
    }
    const trimmed = trimSource(rawValue)!;
    // 一行里只有受保护的内容（单独一个网址、一段行内代码）：没有可翻译的文字。
    if (!source.replace(/<g\d+\/>/gu, '').trim()) {addLiteral(parts, rawValue, bilingualGroup); return;}
    const segmentIndex = segments.length;
    const text = source.trim();
    segments.push({id: segmentIndex, source: text, markdownLineStart: !markdownTableCell});
    parts.push({kind: 'segment', segmentIndex, source: text, rawSource: trimmed.source, prefix: trimmed.prefix, suffix: trimmed.suffix,
        bilingualGroup, markdownTokens: tokens, ...(markdownTableCell ? {markdownTableCell} : {})});
}

/**
 * 把整句译文里的占位符还原成 Markdown 行内语法。每个占位符必须恰好出现一次、成对标记的开闭顺序正确；已知强调节点仅将 Unicode Zs 与 tab/LF/FF/CR 边缘空白移到分隔符之外，并按 CommonMark 的标点/符号和 underscore 词内边界补必要的外侧空格；空正文、链接和代码保持原样。
 * 翻译服务弄丢或弄乱占位符时，去掉全部占位符并把没能放回句中的代码、网址等原样补在句末，内容一个不少。
 */
export function renderMarkdownTranslation(part: SegmentPart, translation: string): string {
    const tokens = part.markdownTokens;
    if (!tokens) return translation;
    const normalized = normalizeDocumentInlineMarkers(translation);
    const pieces = normalized.split(/(<\s*\/?\s*g\s*\d+\s*\/?\s*>)/iu);
    const marker = (piece: string) => /^<\s*(\/?)\s*g\s*(\d+)\s*(\/?)\s*>$/iu.exec(piece);
    const seen = new Set<number>();
    const open: number[] = [];
    let valid = true;
    const renderPieces = [...pieces], output: string[] = [], blankEmphasis = new Set<number>();
    // 缺少相邻字符按空白处理；Unicode P/S 包括括号、数学符号和 emoji，不按 UTF-16 半个代理对判断。
    const firstCharacter = (value: string) => /^./su.exec(value)?.[0] ?? '';
    const lastCharacter = (value: string) => /.$/su.exec(value)?.[0] ?? '';
    const emphasisGap = (outside: string, inside: string, delimiter: string) => outside && !/[\p{Zs}\t\n\f\r\p{P}\p{S}]/u.test(outside)
        && (delimiter.startsWith('_') || /[\p{P}\p{S}]/u.test(inside)) ? ' ' : '';
    for (let index = 0; index < renderPieces.length; index += 1) {
        const piece = renderPieces[index]!, found = marker(piece);
        if (!found) {output.push(piece); continue;}
        const id = Number(found[2]), token = tokens[id - 1];
        if (!token) {valid = false; output.push(''); continue;}
        if (token.close === undefined) {
            // 单个占位符：有的服务会写成一对空标签，闭合的那一半直接忽略。
            if (found[1]) continue;
            if (seen.has(id)) valid = false;
            seen.add(id);
            output.push(token.open);
            continue;
        }
        const emphasis = /^(?:\*{1,2}|_{1,2})$/u.test(token.open) && token.close === token.open;
        if (!found[1]) {
            if (seen.has(id) || found[3]) valid = false;
            seen.add(id); open.push(id);
            // 不去掉词间空白或只含空白的正文；CommonMark 的边界空白不包括任意控制字符。
            const next = renderPieces[index + 1]!, closing = marker(renderPieces[index + 2] ?? '');
            if (emphasis && /^[\p{Zs}\t\n\f\r]*$/u.test(next) && closing?.[1] && Number(closing[2]) === id) blankEmphasis.add(id);
            const whitespace = emphasis && !blankEmphasis.has(id) ? next.match(/^[\p{Zs}\t\n\f\r]+/u)?.[0] ?? '' : '';
            renderPieces[index + 1] = next.slice(whitespace.length);
            let before = output.length - 1;
            while (before >= 0 && !output[before]) before -= 1;
            const gap = emphasis && !blankEmphasis.has(id) ? emphasisGap(lastCharacter(output[before] ?? ''), firstCharacter(renderPieces[index + 1]!), token.open) : '';
            output.push((whitespace || gap) + token.open);
            continue;
        }
        if (open.pop() !== id) valid = false;
        // split 始终先产生普通字符串（可为空），首轮已 push；后续只追加或覆盖，不会移除最后一项。
        const previous = output.at(-1)!;
        const whitespace = emphasis && !blankEmphasis.has(id) ? previous.match(/[\p{Zs}\t\n\f\r]+$/u)?.[0] ?? '' : '';
        if (whitespace) output[output.length - 1] = previous.slice(0, -whitespace.length);
        const nextMarker = marker(renderPieces[index + 2] ?? '');
        const next = renderPieces[index + 1] || (nextMarker ? tokens[Number(nextMarker[2]) - 1]?.[nextMarker[1] ? 'close' : 'open'] : '') || '';
        const gap = emphasis && !blankEmphasis.has(id) ? emphasisGap(firstCharacter(next), lastCharacter(output.at(-1)!), token.open) : '';
        output.push(token.close + (whitespace || gap));
    }
    if (valid && !open.length && seen.size === tokens.length) return output.join('');
    const plain = pieces.filter(piece => !marker(piece)).join('').replace(/[ \t]{2,}/gu, ' ').trim();
    const kept = tokens.filter(token => token.close === undefined && !plain.includes(token.open.trim())).map(token => token.open.trim());
    return [plain, ...kept].join(' ');
}

/** 只识别容器前缀，不改源行；解析代码时，达到容器内四列便停止解释代码自身的引用/列表符号。 */
export function inspectMarkdownLine(
    line: string,
    codeContainer?: {quoteDepth: number; listIndent: number},
): {content: string; quoteDepth: number; indent: number; listIndent: number; codeBaseIndent: number} {
    let cursor = 0;
    let quoteDepth = 0;
    let indent = 0;
    let listIndent = 0;
    let quoteIndent = 0;
    let checkedThematicBreak = false;
    while (cursor < line.length) {
        while (line[cursor] === ' ' || line[cursor] === '\t') {
            indent += line[cursor] === '\t' ? 4 - indent % 4 : 1;
            cursor += 1;
        }
        const codeBaseIndent = Math.max(quoteIndent, listIndent,
            codeContainer?.quoteDepth === quoteDepth ? codeContainer.listIndent : 0);
        if (codeContainer && indent >= codeBaseIndent + 4) break;
        if (line[cursor] === '>') {
            quoteDepth += 1;
            quoteIndent = indent;
            cursor += 1;
            if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
            continue;
        }
        if (!checkedThematicBreak) {
            checkedThematicBreak = true;
            if (/^(?:[-*_][ \t]*){3,}$/u.test(line.slice(cursor))) break;
        }
        const marker = line.slice(cursor).match(/^(?:[-*+]|\d{1,9}[.)])[ \t]+/u)?.[0];
        if (!marker) break;
        for (const character of marker) indent += character === '\t' ? 4 - indent % 4 : 1;
        cursor += marker.length;
        listIndent = indent;
    }
    return {
        content: line.slice(cursor), quoteDepth, indent, listIndent,
        codeBaseIndent: Math.max(quoteIndent, listIndent,
            codeContainer?.quoteDepth === quoteDepth ? codeContainer.listIndent : 0),
    };
}

function stripMarkdownCodeContainer(line: string, quoteDepth: number, indent: number): string {
    let cursor = 0;
    let quotes = 0;
    let columns = 0;
    while (cursor < line.length && (quotes < quoteDepth || columns < indent)) {
        if (line[cursor] === ' ' || line[cursor] === '\t') {
            const width = line[cursor] === '\t' ? 4 - columns % 4 : 1;
            if (quotes >= quoteDepth && columns + width > indent) {
                // 部分 tab 被围栏缩进消耗，剩余列仍属于代码自身的缩进。
                return ' '.repeat(columns + width - indent) + line.slice(cursor + 1);
            }
            columns += width;
            cursor += 1;
        } else if (line[cursor] === '>' && quotes < quoteDepth) {
            quotes += 1;
            cursor += 1;
            if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        } else break;
    }
    return line.slice(cursor);
}

/** 折行只在发给服务和阅读预览时展开，Markdown 受保护文本的末尾保留分隔，导出原文保留输入换行。 */
export function unwrapDocumentSoftLines(source: string, format?: DocumentFormat): string {
    const protectedEnds = new Set<number>();
    const codeBreaks = new Set<number>();
    if (format === 'markdown') {
        for (const mark of source.matchAll(new RegExp(MARKDOWN_PROTECTED_PATTERN))) {
            protectedEnds.add(mark.index + mark[0].length);
            if (!mark[0].startsWith('`')) continue;
            for (const lineBreak of mark[0].matchAll(/\r\n?|\n/gu)) codeBreaks.add(mark.index + lineBreak.index);
        }
    }
    return source.replace(/(?<![^\S\r\n])[^\S\r\n]*(?:\r\n?|\n)[^\S\r\n]*/gu, (wrap: string, offset: number, text: string) => {
        // CommonMark 只替换行内代码的行尾，保留行尾两侧已有空格。
        if (codeBreaks.size && codeBreaks.has(offset + wrap.search(/[\r\n]/u))) return wrap.replace(/\r\n?|\n/u, ' ');
        return !protectedEnds.has(offset) && UNSPACED_WRAP_END.test(text.slice(Math.max(0, offset - 2), offset))
            && UNSPACED_WRAP_START.test(text.slice(offset + wrap.length, offset + wrap.length + 2)) ? '' : ' ';
    });
}

function isMarkdownSoftParagraphLine(line: string): boolean {
    // shortcut: 只合并顶层正文；需要合并列表、表格或引用时，先支持容器内的双语导出。
    const blockStart = /^(?:#{1,6}(?:[ \t]|$)|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|`{3,}|~{3,}|[><]|:{3,}|\$\$|\[[^\]]+\]:|(?:[-*_][ \t]*){3,}$|(?:=+|-+)$)/u;
    const text = line.trimEnd();
    return /^ {0,3}\S/u.test(text) && !blockStart.test(text.trimStart()) && !text.includes('|')
        && !text.endsWith('\\') && !line.slice(text.length).includes('  ');
}

/**
 * 纯文本里按固定宽度折行的段落：哪些行在下一行接着写。只在把握较大时才认定——这一行接近全文的折行宽度、
 * 没有以句末标点结束、不是全大写的标题；下一行缩进相同、不是列表项或编号。认不出来时各行照旧单独翻译。
 */
function wrappedTextLines(lines: readonly string[]): boolean[] {
    const lengths = lines.map(line => line.trimEnd().length).filter(Boolean).sort((left, right) => left - right);
    // 取九成位的行长当作折行宽度，个别没有折行的超长行不影响判断。
    const width = lengths[Math.floor((lengths.length - 1) * 0.9)] ?? 0;
    const indent = (line: string) => line.length - line.trimStart().length;
    const nextBlocked = (next: string) => /^(?:[-*+•·▪◦]|\(?\w{1,3}[.)）]|（\w{1,3}）|[=_~#>|]|-{3,})(?:\s|$)/u.test(next);
    const eligible = lines.map((line, index) => {
        const text = line.trim(), next = lines[index + 1]?.trim();
        const wide = UNSPACED_SCRIPT.test(text);
        if (!next || text.length < Math.max(wide ? 16 : 40, width * 0.7)) return false;
        if (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text)) return false;
        return indent(line) === indent(lines[index + 1]) && !nextBlocked(next);
    });
    const joined = eligible.map((ok, index) => ok && !/[.!?:;。！？：；…][)\]"'’”）】》]*$/u.test(lines[index].trim()));
    // 同一连续折行段中若已有明确的句中折行，则在折行宽度附近且下一词放不下的句末/冒号行也属于同一段。
    for (let start = 0; start < lines.length; start += 1) {
        if (!lines[start].trim()) continue;
        let end = start;
        while (end + 1 < lines.length && lines[end + 1].trim() && indent(lines[end + 1]) === indent(lines[start])) end += 1;
        if (joined.slice(start, end).some(Boolean)) {
            for (let index = start; index < end; index += 1) {
                if (joined[index] || !eligible[index]) continue;
                const next = lines[index + 1].trim();
                const firstWordLength = UNSPACED_WRAP_START.test(next) ? 1 : next.match(/^\S+/u)![0].length;
                if (lines[index].trim().length + 1 + firstWordLength > width) joined[index] = true;
            }
        }
        start = end;
    }
    return joined;
}

function addMarkdownTableRow(parts: DocumentPart[], segments: DocumentSegment[], line: string, body: string, columnCount: number): void {
    const offset = line.length - body.length;
    let cursor = 0;
    for (const {start, end} of splitMarkdownTableRow(body).cells.slice(0, columnCount)) {
        addLiteral(parts, line.slice(cursor, offset + start));
        const cell = body.slice(start, end);
        if (/\p{L}/u.test(cell)) addMarkdownSentence(parts, segments, cell, undefined, {markdownTableCell: start === 0 ? 'withoutLeadingPipe' : 'delimited'});
        else addLiteral(parts, cell);
        cursor = offset + end;
    }
    addLiteral(parts, line.slice(cursor));
}

export function parseTextDocument(
    content: string,
    format: 'txt' | 'markdown',
    sentences = false,
): Pick<ParsedDocument, 'parts' | 'segments' | 'markdownCodeBlocks' | 'markdownTables'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);
    type CodeBlock = MarkdownCodeBlock & {contentLines: string[]};
    const markdownCodeBlocks: CodeBlock[] = [];
    type Container = {quoteDepth: number; listIndent: number};
    let fence: (Container & {marker: string; length: number; indent: number; block: CodeBlock}) | null = null;
    let math: Container | null = null;
    let list: Container | null = null;
    let indented: (Container & {indent: number; block: CodeBlock}) | null = null;
    let paragraph: Container | null = null;
    let table: (Container & {range: MarkdownTable}) | undefined;
    const markdownTables: MarkdownTable[] = [];
    let inFrontmatter = format === 'markdown' && /^\uFEFF?---\s*$/u.test(lines[0]?.text ?? '');
    const wrapped = format === 'txt' ? wrappedTextLines(lines.map(line => line.text)) : undefined;
    let wrapStart: number | undefined;
    let joinedThrough = -1;
    let unjoinedThrough = -1;

    lines.forEach((line, lineIndex) => {
        if (lineIndex <= joinedThrough) return;
        if (inFrontmatter) {
            addLiteral(parts, content.slice(line.start, line.end));
            if (lineIndex > 0 && /^(?:---|\.\.\.)\s*$/u.test(line.text)) inFrontmatter = false;
            return;
        }
        if (format === 'markdown') {
            const info = inspectMarkdownLine(line.text, indented ?? list ?? {quoteDepth: 0, listIndent: 0});
            // 容器内至少四列的块级缩进不能打断普通段落或列表正文续行。
            // 复用同一容器剥离和代码块元数据，导出仍由 literal 保持原字节与换行。
            if (indented) {
                if (info.quoteDepth === indented.quoteDepth && (!info.content || info.indent >= indented.indent)) {
                    if (info.content) {
                        for (let blank = indented.block.endLine; blank < lineIndex; blank += 1) indented.block.contentLines.push('');
                        indented.block.contentLines.push(stripMarkdownCodeContainer(line.text, indented.quoteDepth, indented.indent));
                        indented.block.endLine = lineIndex + 1;
                    }
                    addLiteral(parts, content.slice(line.start, line.end));
                    return;
                }
                indented = null;
            }
            if (!info.content || paragraph && (info.quoteDepth !== paragraph.quoteDepth || info.indent < paragraph.listIndent)) paragraph = null;
            if (!fence && !math && info.content && info.indent >= info.codeBaseIndent + 4 && !paragraph) {
                table = undefined;
                const indent = info.codeBaseIndent + 4;
                const block: CodeBlock = {
                    startLine: lineIndex, endLine: lineIndex + 1, info: '', closed: true,
                    contentLines: [stripMarkdownCodeContainer(line.text, info.quoteDepth, indent)],
                };
                markdownCodeBlocks.push(block);
                indented = {quoteDepth: info.quoteDepth, listIndent: list?.quoteDepth === info.quoteDepth ? list.listIndent : 0, indent, block};
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            const leaves = (container: Container) => info.quoteDepth < container.quoteDepth || (
                !!info.content && (info.indent < container.listIndent || (
                    container.listIndent > 0 && info.listIndent > 0 && info.listIndent <= container.listIndent
                ))
            );
            if (fence && leaves(fence)) {
                fence.block.endLine = lineIndex;
                fence = null;
            }
            if (math && leaves(math)) math = null;
            if (fence || math) {
                const container = fence ?? math!;
                const atContainer = info.quoteDepth === container.quoteDepth && info.listIndent === 0;
                if (fence && atContainer && info.indent <= fence.listIndent + 3) {
                    const close = info.content.match(/^(`{3,}|~{3,})\s*$/u)?.[1];
                    if (close && close[0] === fence.marker && close.length >= fence.length) {
                        fence.block.closed = true;
                        fence.block.endLine = lineIndex + 1;
                        fence = null;
                    } else {
                        fence.block.contentLines.push(stripMarkdownCodeContainer(line.text, fence.quoteDepth, fence.indent));
                    }
                } else if (fence) {
                    fence.block.contentLines.push(stripMarkdownCodeContainer(line.text, fence.quoteDepth, fence.indent));
                } else if (math && atContainer && /^\$\$\s*$/u.test(info.content)) math = null;
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            if (list && info.content && (info.quoteDepth !== list.quoteDepth || info.indent < list.listIndent)) list = null;
            if (info.listIndent) list = {quoteDepth: info.quoteDepth, listIndent: info.listIndent};
            const container = {quoteDepth: info.quoteDepth, listIndent: list?.listIndent ?? 0};
            const marker = info.indent <= container.listIndent + 3
                ? info.content.match(/^(`{3,}|~{3,})(.*)$/u)?.[1] : undefined;
            const isMathLine = /^\$\$\s*$/u.test(info.content);
            const horizontalRule = /^(?:[-*_]\s*){3,}$/u.test(info.content);
            const calloutHeader = info.quoteDepth > 0 && /^\[![^\]]+\]/u.test(info.content);
            // Markdown 扩展容器的类型、参数与闭合标记属于语法；双语下载不能复制一份译后的 ::: 开头。
            const directive = /^:{3,}(?:\s*[a-zA-Z][\w-]*(?:\s.*)?|\s*)$/u.test(info.content);
            // 单独成行的 HTML/组件标签也只负责结构，带引号的属性仍按 HTML 扫描器识别。
            const html = findNextHtmlToken(info.content, 0);
            const htmlOnly = html?.index === 0 && html.value.length === info.content.length;
            const structure = marker || isMathLine || horizontalRule || calloutHeader || directive || htmlOnly;
            const newBlock = /^(?:#{1,6}(?:\s|$)|\[[^\]]+\]:)/u.test(info.content);
            if (table && lineIndex === table.range.startLine + 1) {
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            if (table && info.content && !structure && !newBlock && !info.listIndent
                && info.quoteDepth === table.quoteDepth && info.indent >= table.listIndent) {
                addMarkdownTableRow(parts, segments, line.text, info.content, table.range.alignments.length);
                addLiteral(parts, content.slice(line.textEnd, line.end));
                table.range.endLine = lineIndex + 1;
                return;
            }
            table = undefined;
            if (structure) {
                paragraph = null;
                if (marker) {
                    const block: CodeBlock = {
                        startLine: lineIndex, endLine: lines.length, info: info.content.slice(marker.length),
                        closed: false, contentLines: [],
                    };
                    markdownCodeBlocks.push(block);
                    fence = {...container, marker: marker[0], length: marker.length, indent: info.indent, block};
                }
                else if (isMathLine) math = container;
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            if (!info.content) {
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            if (!newBlock && info.content.includes('|') && lineIndex + 1 < lines.length) {
                const delimiter = inspectMarkdownLine(lines[lineIndex + 1].text);
                const alignments = delimiter.quoteDepth === info.quoteDepth && delimiter.indent === info.indent
                    ? markdownTableAlignments(info.content, delimiter.content) : undefined;
                if (alignments) {
                    const range = {startLine: lineIndex, endLine: lineIndex + 2, alignments};
                    table = {...container, range};
                    markdownTables.push(range);
                    paragraph = null;
                    addMarkdownTableRow(parts, segments, line.text, info.content, alignments.length);
                    addLiteral(parts, content.slice(line.textEnd, line.end));
                    return;
                }
            }
            if (sentences && lineIndex > unjoinedThrough && !container.quoteDepth && !container.listIndent
                && isMarkdownSoftParagraphLine(line.text)) {
                let end = lineIndex;
                while (end + 1 < lines.length && isMarkdownSoftParagraphLine(lines[end + 1].text)) end += 1;
                const last = lines[end];
                if (last.textEnd - line.start > maxMarkdownParagraphLength
                    || /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[end + 1]?.text ?? '')) {
                    unjoinedThrough = end;
                } else if (end > lineIndex) {
                    const raw = content.slice(line.start, last.textEnd);
                    addMarkdownSentence(parts, segments, unwrapDocumentSoftLines(raw, 'markdown'), lineIndex, {rawValue: raw});
                    addLiteral(parts, content.slice(last.textEnd, last.end));
                    joinedThrough = end;
                    paragraph = container;
                    return;
                }
            }
            (sentences ? addMarkdownSentence : addMarkdownProtectedText)(parts, segments, line.text, lineIndex);
            if (info.content) paragraph = /^#{1,6}\s/u.test(info.content) ? null : container;
        } else if (wrapped?.[lineIndex]) {
            // 这一行在下一行接着写：攒起来，到段落的最后一行再一起处理。
            wrapStart ??= lineIndex;
            return;
        } else if (wrapStart !== undefined) {
            // 按固定宽度折行的一段话作为一个片段翻译；折行处在送翻的原文里是空格（中日韩文字之间不留空格）。
            // 相邻两个 UTF-16 单元足以容纳完整码点；锚定边缘，不能误用更前或更后的中日韩文字。
            addSegment(parts, segments, content.slice(lines[wrapStart].start, line.textEnd), {}, unwrapDocumentSoftLines);
            wrapStart = undefined;
        } else {
            addSegment(parts, segments, line.text);
        }
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments, ...(format === 'markdown' ? {markdownCodeBlocks, markdownTables} : {})};
}
