/**
 * @file src/features/document-translation/core/document.ts
 * 文件职责：定义文档翻译的纯领域模型，并负责把多种文本格式解析为可翻译片段，再按双语或纯译文模式无损还原原格式结构。
 * 主要内容：覆盖文本格式识别、片段切分、HTML 中被链接或强调等行内标签隔开的文字合成整句并以编号占位符保留标签（句中的行内代码整个保留、不翻译）、给出带占位符片段替换前的原文供校订显示、字幕译文丢了硬换行时按原文行数重新断行、被翻译服务转成实体的字幕样式标签还原成标签、纯文本里按固定宽度折行的段落合成一个片段、Markdown 可选地把一行作为一个片段整句翻译并以成对占位符保护强调和链接，以单占位符保护行内代码与网址、Markdown 容器围栏及受控缩进代码与行内位置保护、字幕标签保留、有界深度的非递归 JSON 遍历、空译文回退、MIME 信息、按格式区分的文件大小上限和下载文件命名；文本导出支持有界编码，下载摘录无需处理全文；相同译文保留原文且不重复展示。
 * 模块边界：该文件不读取 File、不解析 PDF/EPUB/DOCX 二进制，也不发起翻译请求；文件 I/O 与压缩包处理归 services/binary，批处理归 services/translation，展示归 preview/presentation。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 带插图的论文与扫描件常超过 10 MB；PDF 按页解析、译文量只取决于文字，单独放宽上限。 */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
    'pdf',
    'epub',
    'docx',
    'html',
    'htm',
    'txt',
    'md',
    'markdown',
    'srt',
    'vtt',
    'ass',
    'ssa',
    'lrc',
    'json',
] as const;

export type DocumentFormat =
    | 'pdf'
    | 'epub'
    | 'docx'
    | 'html'
    | 'txt'
    | 'markdown'
    | 'srt'
    | 'vtt'
    | 'ass'
    | 'lrc'
    | 'json';

export type DocumentRenderMode = 'bilingual' | 'translated';

export interface DocumentSegment {
    id: number;
    source: string;
    /** 可选的阅读上下文，例如 PDF 页码或 ePub 章节。 */
    contextLabel?: string;
    /** 字幕原生时间轴元数据。 */
    timeStart?: string;
    timeEnd?: string;
    /** 结构化文档中的原生位置，例如 `$.items[0].label`。 */
    pathLabel?: string;
    /** 页面或文章预览使用的原生文档角色。 */
    role?: 'title' | 'heading' | 'paragraph' | 'list-item' | 'header' | 'footer' | 'note';
    /** Markdown 片段是否从原始行首开始；false 表示链接/代码后的行内文本，不能剥离列表等前缀。 */
    markdownLineStart?: boolean;
}

export interface PdfDocumentRun {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    baseline?: number;
    fontSize?: number;
    fontFamily?: string;
}

export interface PdfDocumentLine extends PdfDocumentRun {
    runs?: PdfDocumentRun[];
}

export interface PdfPreservedRegion {
    id: string;
    kind: 'figure' | 'table' | 'formula';
    x: number;
    y: number;
    width: number;
    height: number;
    source?: string;
}

export interface PdfDocumentBlock {
    segmentIndex: number;
    /** PDF 在缩放比例 1、页面旋转 0 下的左上角内容坐标；页面展示旋转由 PdfDocumentPage.rotation 决定。 */
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
    /** 以 PDF 视口单位表示的源文本行高中位数。 */
    lineHeight: number;
    /** 此段落块包含的源文本行数。 */
    lineCount: number;
    fontFamily: string;
    fontWeight: 400 | 600 | 700;
    textAlign: 'left' | 'center' | 'right';
    kind?: 'text' | 'heading' | 'caption' | 'metadata' | 'formula' | 'table' | 'figure-label' | 'footer';
    column?: number;
    readingOrder?: number;
    preserveSource?: boolean;
    /** 表格单元格的原始边界，供译文拟合与文字擦除使用；原字形矩形仍保留在 lines 中。 */
    cellBounds?: Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>;
    lines?: PdfDocumentLine[];
}

export interface PdfDocumentPage {
    pageNumber: number;
    /** 保留 PDF 页面的实际展示方向；旧模型与未旋转页面可以省略。 */
    rotation?: 0 | 90 | 180 | 270;
    /** 文字识别过的旋转扫描页：版面块已经按展示方向给出（因此不再带 rotation），这里只记下原页的旋转角，供导出时摆正嵌入的原页。 */
    sourceRotation?: 90 | 180 | 270;
    /** 展示方向的尺寸；90/270 度时，内容坐标系的宽高与这里交换。 */
    width: number;
    height: number;
    segmentIndexes: number[];
    blocks: PdfDocumentBlock[];
    preservedRegions?: PdfPreservedRegion[];
    /** 细分隔线只限制原位译文的可用空白，不作为重排阅读的图形区域。 */
    layoutBoundaries?: Array<Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>>;
    /** 整页是一张图像且没有任何文字（扫描页），等待文字识别；识别之后不再标记。 */
    scanned?: boolean;
}

export interface EpubDocumentChapter {
    path: string;
    source: string;
    segmentOffset: number;
    segmentCount: number;
    title: string;
    /** OPF content type; older saved chapters may not have this field. */
    mediaType?: string;
}

export interface DocxDocumentPart {
    path: string;
    source: string;
    /** table：段落位于表格里时，它所在的表格、行与单元格序号（从 0 开始），供阅读视图按表格排版；旧模型没有这项。 */
    paragraphSegments: Array<{paragraphIndex: number; segmentIndex: number; table?: {table: number; row: number; cell: number}}>;
}

export type BinaryDocumentData =
    | {kind: 'pdf'; bytes: Uint8Array; pages: PdfDocumentPage[]}
    | {kind: 'epub'; bytes: Uint8Array; chapters: EpubDocumentChapter[]}
    | {kind: 'docx'; bytes: Uint8Array; parts: DocxDocumentPart[]};

interface LiteralPart {
    kind: 'literal';
    value: string;
    /** Markdown 源行分组，用于让受保护的行内语法保持原位。 */
    bilingualGroup?: number;
}

interface SegmentPart {
    kind: 'segment';
    segmentIndex: number;
    source: string;
    /** 双语显示源文时使用的原始编码 HTML 文本。 */
    rawSource?: string;
    prefix: string;
    suffix: string;
    /** 双语行需要第二个提示时重复使用的结构前缀。 */
    bilingualPrefix?: string;
    /** Markdown 源行分组，用于渲染一条结构完整的双语行。 */
    bilingualGroup?: number;
    /** Markdown 整行片段里行内语法的原文：链接是成对的占位符（有 close），代码、网址等是单个占位符。 */
    markdownTokens?: Array<{open: string; close?: string}>;
    /** HTML 整句片段里行内标签的原文：送翻时写成编号占位符 `<gN>…</gN>`，渲染时按编号还原。 */
    htmlTags?: Array<{open: string; close: string}>;
}

type DocumentPart = LiteralPart | SegmentPart;

export interface JsonSegmentEntry {
    path: Array<string | number>;
    segmentIndex: number;
    prefix: string;
    suffix: string;
}

export interface MarkdownCodeBlock {
    /** 零基源行范围，左闭右开；围栏块包含围栏，缩进块只包含代码及内部空行。 */
    startLine: number;
    endLine: number;
    /** 开启围栏后未经解释的信息字符串。 */
    info: string;
    closed: boolean;
    /** 仅供展示：剥除开启容器和围栏缩进，保留代码自身的符号及额外缩进。 */
    contentLines: readonly string[];
}

export interface ParsedDocument {
    fileName: string;
    format: DocumentFormat;
    label: string;
    parts: readonly DocumentPart[];
    segments: readonly DocumentSegment[];
    jsonValue?: unknown;
    jsonEntries?: readonly JsonSegmentEntry[];
    /** Markdown 围栏与受控缩进代码由解析器统一判定，预览无需复制容器状态机。 */
    markdownCodeBlocks?: readonly MarkdownCodeBlock[];
    binary?: BinaryDocumentData;
}

const FORMAT_LABELS: Record<DocumentFormat, string> = {
    pdf: 'PDF 文件',
    epub: 'ePub 电子书',
    docx: 'DOCX 文档',
    html: 'HTML 文件',
    txt: 'TXT 文件',
    markdown: 'Markdown 文件',
    srt: 'SRT 字幕',
    vtt: 'VTT 字幕',
    ass: 'ASS 字幕',
    lrc: 'LRC 歌词',
    json: 'JSON 文件',
};

const PROTECTED_HTML_TAGS = new Set(['head', 'script', 'style', 'pre', 'code', 'textarea']);
const MARKDOWN_PROTECTED_PATTERN = /(`{1,3}[^`\n]+`{1,3}|<https?:\/\/[^>]+>|https?:\/\/[^\s)]+|\$[^$\r\n]+\$|%%[^%\r\n]+%%|(?:^|\s)#[\p{L}\p{N}_/-]+)/gu;
const TIMED_SUBTITLE_PATTERN = /^\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?$/u;
const LRC_TIME_PATTERN = /^(\s*(?:\[[^\]\r\n]+\])+)/u;

function extensionOf(fileName: string): string {
    const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/u);
    return match?.[1] || '';
}

export function getDocumentFormat(fileName: string): DocumentFormat | null {
    const extension = extensionOf(fileName);
    if (extension === 'pdf') return 'pdf';
    if (extension === 'epub') return 'epub';
    if (extension === 'docx') return 'docx';
    if (extension === 'html' || extension === 'htm') return 'html';
    if (extension === 'txt') return 'txt';
    if (extension === 'md' || extension === 'markdown') return 'markdown';
    if (extension === 'srt') return 'srt';
    if (extension === 'vtt') return 'vtt';
    if (extension === 'ass' || extension === 'ssa') return 'ass';
    if (extension === 'lrc') return 'lrc';
    if (extension === 'json') return 'json';
    return null;
}

/** 一个文件允许的最大字节数：PDF 使用更宽的上限，其余格式沿用通用上限。 */
export function getDocumentMaxBytes(fileName: string): number {
    return getDocumentFormat(fileName) === 'pdf' ? PDF_MAX_BYTES : DOCUMENT_MAX_BYTES;
}

export function getDocumentAcceptAttribute(): string {
    return SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');
}

export function getDocumentFormatLabel(format: DocumentFormat): string {
    return FORMAT_LABELS[format];
}

export function getDocumentMimeType(format: DocumentFormat): string {
    if (format === 'pdf') return 'application/pdf';
    if (format === 'epub') return 'application/epub+zip';
    if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (format === 'html') return 'text/html;charset=utf-8';
    if (format === 'json') return 'application/json;charset=utf-8';
    return 'text/plain;charset=utf-8';
}

function trimSource(value: string): {prefix: string; source: string; suffix: string} | null {
    const source = value.trim();
    if (!source) return null;
    const start = value.length - value.trimStart().length;
    return {prefix: value.slice(0, start), source, suffix: value.slice(start + source.length)};
}

type SegmentOptions = Pick<SegmentPart, 'bilingualPrefix' | 'bilingualGroup'>
    & Omit<Partial<DocumentSegment>, 'id' | 'source'>;

function addLiteral(parts: DocumentPart[], value: string, bilingualGroup?: number): void {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'literal' && last.bilingualGroup === bilingualGroup) {
        last.value += value;
        return;
    }
    parts.push({kind: 'literal', value, bilingualGroup});
}

function addSegment(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    options: SegmentOptions = {},
    transformSource?: (source: string) => string,
): void {
    const trimmed = trimSource(value);
    if (!trimmed) {
        addLiteral(parts, value, options.bilingualGroup);
        return;
    }

    const segmentIndex = segments.length;
    const {bilingualPrefix, bilingualGroup, ...segmentOptions} = options;
    const source = transformSource ? transformSource(trimmed.source) : trimmed.source;
    segments.push({id: segmentIndex, source, ...segmentOptions});
    parts.push({
        kind: 'segment',
        segmentIndex,
        source,
        ...(source === trimmed.source ? {} : {rawSource: trimmed.source}),
        prefix: trimmed.prefix,
        suffix: trimmed.suffix,
        bilingualPrefix,
        bilingualGroup,
    });
}

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
 * 一行 Markdown 作为一个片段整句翻译：链接写成成对的编号占位符（链接文字仍然翻译，地址原样保留），
 * 行内代码、网址、公式与标签写成单个占位符。这样句子不会被行内语法拆散，受保护的内容也不会被改写。
 * 仅在调用方启用整句方式时使用；默认仍按受保护内容把一行切成多段。
 */
function addMarkdownSentence(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    bilingualGroup: number,
): void {
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
    const options: SegmentOptions = {bilingualGroup, markdownLineStart: true};
    // 没有行内语法，或文字本身含有占位符写法（无法区分真假占位符）时，整行按普通文字处理。
    if (!tokens.length || MARKDOWN_PLACEHOLDER.test(value)) {addSegment(parts, segments, value, options); return;}
    const trimmed = trimSource(value)!;
    // 一行里只有受保护的内容（单独一个网址、一段行内代码）：没有可翻译的文字。
    if (!source.replace(/<g\d+\/>/gu, '').trim()) {addLiteral(parts, value, bilingualGroup); return;}
    const segmentIndex = segments.length;
    const text = source.trim();
    segments.push({id: segmentIndex, source: text, markdownLineStart: true});
    parts.push({kind: 'segment', segmentIndex, source: text, rawSource: trimmed.source, prefix: trimmed.prefix, suffix: trimmed.suffix, bilingualGroup, markdownTokens: tokens});
}

const MARKDOWN_PLACEHOLDER = /<\s*\/?\s*g\s*\d+\s*\/?\s*>/iu;

/**
 * 把整句译文里的占位符还原成 Markdown 行内语法。每个占位符必须恰好出现一次、链接的开闭顺序正确；
 * 翻译服务弄丢或弄乱占位符时，去掉全部占位符并把没能放回句中的代码、网址等原样补在句末，内容一个不少。
 */
function renderMarkdownTranslation(part: SegmentPart, translation: string): string {
    const tokens = part.markdownTokens;
    if (!tokens) return translation;
    const normalized = translation.replace(/(?:&lt;|[＜〈（(])\s*([\/／]?)\s*g\s*(\d+)\s*([\/／]?)\s*(?:&gt;|[＞〉）)])/giu,
        (_, open: string, id: string, close: string) => `<${open ? '/' : ''}g${id}${close ? '/' : ''}>`);
    const pieces = normalized.split(/(<\s*\/?\s*g\s*\d+\s*\/?\s*>)/iu);
    const marker = (piece: string) => /^<\s*(\/?)\s*g\s*(\d+)\s*(\/?)\s*>$/iu.exec(piece);
    const seen = new Set<number>();
    const open: number[] = [];
    let valid = true;
    const output = pieces.map(piece => {
        const found = marker(piece);
        if (!found) return piece;
        const id = Number(found[2]), token = tokens[id - 1];
        if (!token) {valid = false; return '';}
        if (token.close === undefined) {
            // 单个占位符：有的服务会写成一对空标签，闭合的那一半直接忽略。
            if (found[1]) return '';
            if (seen.has(id)) valid = false;
            seen.add(id);
            return token.open;
        }
        if (!found[1]) {
            if (seen.has(id) || found[3]) valid = false;
            seen.add(id); open.push(id);
            return token.open;
        }
        if (open.pop() !== id) valid = false;
        return token.close;
    });
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
    return {content: line.slice(cursor), quoteDepth, indent, listIndent,
        codeBaseIndent: Math.max(quoteIndent, listIndent,
            codeContainer?.quoteDepth === quoteDepth ? codeContainer.listIndent : 0)};
}

function splitWithEndings(value: string): Array<{start: number; end: number; textEnd: number; text: string}> {
    const lines: Array<{start: number; end: number; textEnd: number; text: string}> = [];
    const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
    let match = pattern.exec(value);
    while (match) {
        if (match[0] === '' && match.index === value.length) break;
        const raw = match[0];
        const endingLength = raw.endsWith('\r\n') ? 2 : raw.endsWith('\n') || raw.endsWith('\r') ? 1 : 0;
        const start = match.index;
        const end = start + raw.length;
        lines.push({
            start,
            end,
            textEnd: end - endingLength,
            text: raw.slice(0, raw.length - endingLength),
        });
        match = pattern.exec(value);
    }
    return lines;
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

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。、；：！？（）《》“”‘’]/u;

/**
 * 纯文本里按固定宽度折行的段落：哪些行在下一行接着写。只在把握较大时才认定——这一行接近全文的折行宽度、
 * 没有以句末标点结束、不是全大写的标题；下一行缩进相同、不是列表项或编号。认不出来时各行照旧单独翻译。
 */
function wrappedTextLines(lines: readonly string[]): boolean[] {
    const lengths = lines.map(line => line.trimEnd().length).filter(Boolean).sort((left, right) => left - right);
    // 取九成位的行长当作折行宽度，个别没有折行的超长行不影响判断。
    const width = lengths[Math.floor((lengths.length - 1) * 0.9)] ?? 0;
    const indent = (line: string) => line.length - line.trimStart().length;
    return lines.map((line, index) => {
        const text = line.trim(), next = lines[index + 1]?.trim();
        const wide = UNSPACED_SCRIPT.test(text);
        if (!next || text.length < Math.max(wide ? 16 : 40, width * 0.7)) return false;
        if (/[.!?:;。！？：；…][)\]"'’”）】》]*$/u.test(text) || (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text))) return false;
        return indent(line) === indent(lines[index + 1]) && !/^(?:[-*+•·▪◦]|\(?\w{1,3}[.)）]|（\w{1,3}）|[=_~#>|]|-{3,})(?:\s|$)/u.test(next);
    });
}

function parseTextDocument(content: string, format: 'txt' | 'markdown', sentences = false): Pick<ParsedDocument, 'parts' | 'segments' | 'markdownCodeBlocks'> {
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
    let inFrontmatter = format === 'markdown' && /^\uFEFF?---\s*$/u.test(lines[0]?.text ?? '');
    const wrapped = format === 'txt' ? wrappedTextLines(lines.map(line => line.text)) : undefined;
    let wrapStart: number | undefined;

    lines.forEach((line, lineIndex) => {
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
            if (marker || isMathLine || horizontalRule || calloutHeader) {
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
            (sentences ? addMarkdownSentence : addMarkdownProtectedText)(parts, segments, line.text, lineIndex);
            if (info.content) paragraph = /^#{1,6}\s/u.test(info.content) ? null : container;
        } else if (wrapped?.[lineIndex]) {
            // 这一行在下一行接着写：攒起来，到段落的最后一行再一起处理。
            wrapStart ??= lineIndex;
            return;
        } else if (wrapStart !== undefined) {
            // 按固定宽度折行的一段话作为一个片段翻译；折行处在送翻的原文里是空格（中日韩文字之间不留空格）。
            addSegment(parts, segments, content.slice(lines[wrapStart].start, line.textEnd), {}, source => source.replace(/[^\S\r\n]*\r?\n[^\S\r\n]*/gu, (_, offset: number, text: string) =>
                UNSPACED_SCRIPT.test(text[offset - 1]) && UNSPACED_SCRIPT.test(text.slice(offset).trimStart()[0]) ? '' : ' '));
            wrapStart = undefined;
        } else {
            addSegment(parts, segments, line.text);
        }
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments, ...(format === 'markdown' ? {markdownCodeBlocks} : {})};
}

const HTML_ENTITY_FALLBACKS: Record<string, string> = {
    amp: '&',
    apos: "'",
    bull: '•',
    cent: '¢',
    copy: '©',
    emsp: ' ',
    ensp: ' ',
    euro: '€',
    gt: '>',
    hellip: '…',
    laquo: '«',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    middot: '·',
    ndash: '–',
    nbsp: ' ',
    pound: '£',
    quot: '"',
    raquo: '»',
    rdquo: '”',
    reg: '®',
    rsquo: '’',
    thinsp: ' ',
    trade: '™',
    yen: '¥',
};

function decodeHtmlEntities(value: string): string {
    if (!value.includes('&')) return value;
    if (typeof globalThis.document !== 'undefined') {
        const textarea = globalThis.document.createElement('textarea');
        textarea.innerHTML = value;
        return textarea.value;
    }

    return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));/giu, (entity, hex, decimal, name) => {
        if (name) return HTML_ENTITY_FALLBACKS[String(name).toLowerCase()] ?? entity;
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : '�';
    });
}

interface HtmlToken {
    index: number;
    value: string;
}

/** 查找下一个 HTML token，带引号属性中的 `>` 不应被误判为标签边界。 */
function findNextHtmlToken(content: string, from: number): HtmlToken | null {
    let index = content.indexOf('<', from);
    while (index >= 0) {
        const next = content[index + 1];
        if (next && (next === '!' || next === '?' || next === '/' || /[a-z]/iu.test(next))) {
            if (content.startsWith('<!--', index)) {
                const commentEnd = content.indexOf('-->', index + 4);
                const end = commentEnd >= 0 ? commentEnd + 3 : content.length;
                return {index, value: content.slice(index, end)};
            }

            let quote = '';
            for (let cursor = index + 1; cursor < content.length; cursor += 1) {
                const character = content[cursor];
                if (quote) {
                    if (character === quote) quote = '';
                    continue;
                }
                if (character === '"' || character === "'") {
                    quote = character;
                    continue;
                }
                if (character === '>') {
                    return {index, value: content.slice(index, cursor + 1)};
                }
            }
            return null;
        }
        index = content.indexOf('<', index + 1);
    }
    return null;
}

/** 不打断句子的行内标签：它们两侧的文字属于同一句话，应当作为一个片段整体翻译。 */
const INLINE_HTML_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var']);
const HTML_PLACEHOLDER = /<\s*(\/?)\s*g\s*(\d+)\s*>/giu;
/** atom：句子里的行内代码，整个元素原样保留；它的文字写进占位符之间给翻译服务当上下文，还原时一律换回原来的元素。 */
type HtmlRunToken = {tag?: string; name?: string; closing?: boolean; text?: string; atom?: string};

/**
 * 处理一段只被行内标签隔开的连续文字。句子内部的行内标签（链接、强调）换成编号占位符后整句送翻；
 * 包在整段文字外面的标签、无法配对的标签，或文字本身就含有占位符写法时，退回逐段文字翻译。
 */
function addHtmlRun(parts: DocumentPart[], segments: DocumentSegment[], run: HtmlRunToken[]): void {
    const literal = (token: HtmlRunToken) => addLiteral(parts, token.atom ?? token.tag ?? token.text!);
    const blank = (token: HtmlRunToken) => token.atom === undefined && (token.tag !== undefined || !token.text!.trim());
    let start = 0, end = run.length;
    while (start < end && blank(run[start])) start += 1;
    while (end > start && blank(run[end - 1])) end -= 1;
    const core = run.slice(start, end);
    const plain = (token: HtmlRunToken) => token.tag === undefined && token.atom === undefined;
    const separately = () => run.forEach(token => plain(token) ? addSegment(parts, segments, token.text!, {}, decodeHtmlEntities) : literal(token));
    // 没有行内标签，或除了行内代码之外没有别的文字时，不需要合并。
    if (core.every(plain) || !core.some(token => plain(token) && token.text!.trim())) {separately(); return;}
    // 按开闭顺序给行内标签配对编号；出现无法配对的标签就不合并。
    const tags: Array<{open: string; close: string}> = [];
    const open: Array<{name: string; id: number}> = [];
    let source = '';
    for (const token of core) {
        if (token.atom !== undefined) {
            tags.push({open: token.atom, close: ''});
            source += `<g${tags.length}>${decodeHtmlEntities(token.text!)}</g${tags.length}>`;
            continue;
        }
        if (token.tag === undefined) {source += decodeHtmlEntities(token.text!); continue;}
        if (!token.closing) {
            tags.push({open: token.tag, close: ''});
            open.push({name: token.name!, id: tags.length});
            source += `<g${tags.length}>`;
            continue;
        }
        const last = open.pop();
        if (!last || last.name !== token.name) {separately(); return;}
        tags[last.id - 1].close = token.tag;
        source += `</g${last.id}>`;
    }
    if (open.length || core.some(token => token.tag === undefined && HTML_PLACEHOLDER.test(decodeHtmlEntities(token.text!)))) {HTML_PLACEHOLDER.lastIndex = 0; separately(); return;}
    HTML_PLACEHOLDER.lastIndex = 0;
    run.slice(0, start).forEach(literal);
    // 句首或句末是行内代码时，句子两端没有需要留在外面的空白。
    const first = core[0].atom === undefined ? core[0].text! : '', last = core.at(-1)!.atom === undefined ? core.at(-1)!.text! : '';
    const prefix = first.slice(0, first.length - first.trimStart().length), suffix = last.slice(last.trimEnd().length);
    const raw = core.map(token => token.atom ?? token.tag ?? token.text!).join('');
    const segmentIndex = segments.length;
    const trimmed = source.trim();
    segments.push({id: segmentIndex, source: trimmed});
    parts.push({kind: 'segment', segmentIndex, source: trimmed, rawSource: raw.slice(prefix.length, raw.length - suffix.length), prefix, suffix, htmlTags: tags});
    run.slice(end).forEach(literal);
}

function parseHtmlDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    let cursor = 0;
    let protectedTag = '';
    let run: HtmlRunToken[] = [];
    const flush = () => {if (run.length) addHtmlRun(parts, segments, run); run = [];};

    let match = findNextHtmlToken(content, 0);
    while (match) {
        const tag = match.value;
        const text = content.slice(cursor, match.index);
        if (protectedTag) addLiteral(parts, text);
        else if (text) run.push({text});

        const closing = tag.match(/^<\s*\/\s*([a-z0-9-]+)/iu)?.[1]?.toLowerCase();
        const opening = closing ? undefined : tag.match(/^<\s*([a-z0-9-]+)/iu)?.[1]?.toLowerCase();
        const name = closing ?? opening;
        // 行内标签留在当前这句话里；其余标签（块级、换行、图片、注释）结束这句话。
        // 句子里的行内代码（不在 pre 里的 code）整个留在这句话里，文字不翻译。
        const codeEnd = !protectedTag && opening === 'code' && !/\/\s*>$/u.test(tag) ? /<\s*\/\s*code\s*>/iu.exec(content.slice(match.index + tag.length)) : null;
        if (codeEnd) {
            const inner = content.slice(match.index + tag.length, match.index + tag.length + codeEnd.index);
            const whole = tag + inner + codeEnd[0];
            run.push({atom: whole, text: inner.replace(/<[^>]*>/gu, '')});
            cursor = match.index + whole.length;
            match = findNextHtmlToken(content, cursor);
            continue;
        }
        if (!protectedTag && name && INLINE_HTML_TAGS.has(name) && !/\/\s*>$/u.test(tag)) run.push({tag, name, closing: Boolean(closing)});
        else {
            flush();
            addLiteral(parts, tag);
            if (closing && closing === protectedTag) protectedTag = '';
            else if (opening && !protectedTag && PROTECTED_HTML_TAGS.has(opening) && !/\/\s*>$/u.test(tag)) protectedTag = opening;
        }

        cursor = match.index + tag.length;
        match = findNextHtmlToken(content, cursor);
    }

    if (cursor < content.length) {
        if (protectedTag) addLiteral(parts, content.slice(cursor));
        else run.push({text: content.slice(cursor)});
    }
    flush();
    return {parts, segments};
}

/**
 * 把整句译文里的编号占位符还原成原来的行内标签。占位符必须每个恰好开闭一次且嵌套正确；
 * 翻译服务弄丢或弄乱占位符时去掉全部占位符，输出不带行内标签的整句译文，文字一个不少。
 */
function renderHtmlTranslation(part: SegmentPart, translation: string): string {
    const tags = part.htmlTags;
    if (!tags) return escapeHtml(translation);
    // 有的翻译服务会把占位符的尖括号转成实体（&lt;g1&gt;）、全角尖括号或括号（（g1）、(g1)）再返回，先还原成占位符。
    const pieces = translation.replace(/(?:&lt;|[＜〈（(])\s*([\/／]?)\s*g\s*(\d+)\s*(?:&gt;|[＞〉）)])/giu, (_, slash: string, id: string) => `<${slash ? '/' : ''}g${id}>`).split(/(<\s*\/?\s*g\s*\d+\s*>)/iu);
    const stack: number[] = [];
    const seen = new Set<number>();
    let valid = true;
    // 行内代码（close 为空）：占位符之间无论服务返回了什么，都换回原来的整个元素。
    const atom = () => stack.length > 0 && tags[stack.at(-1)! - 1].close === '';
    const output = pieces.map(piece => {
        const marker = /^<\s*(\/?)\s*g\s*(\d+)\s*>$/iu.exec(piece);
        if (!marker) return atom() ? '' : escapeHtml(piece);
        const id = Number(marker[2]);
        if (!tags[id - 1]) {valid = false; return '';}
        if (!marker[1]) {
            if (seen.has(id) || atom()) valid = false;
            seen.add(id); stack.push(id);
            return tags[id - 1].open;
        }
        if (stack.pop() !== id) valid = false;
        return tags[id - 1].close;
    });
    if (valid && !stack.length && seen.size === tags.length) return output.join('');
    // 退回纯文字时，行内代码的文字以原文补在句末，避免留下被服务改写过的命令。
    const code = tags.filter(tag => tag.close === '').map(tag => tag.open).join(' ');
    const text = escapeHtml(pieces.filter(piece => !/^<\s*\/?\s*g\s*\d+\s*>$/iu.test(piece)).join(''));
    return code ? `${text} ${code}` : text;
}

function parseTimedSubtitleDocument(content: string, format: 'srt' | 'vtt'): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);
    let cursorLine = 0;

    while (cursorLine < lines.length) {
        const timestampLine = lines[cursorLine];
        if (format === 'vtt' && /^NOTE(?:[ \t].*)?$/u.test(timestampLine.text)) {
            const start = timestampLine.start;
            while (cursorLine < lines.length && lines[cursorLine].text.trim()) cursorLine += 1;
            addLiteral(parts, content.slice(start, lines[cursorLine - 1].end));
            continue;
        }
        if (!timestampLine || !TIMED_SUBTITLE_PATTERN.test(timestampLine.text)) {
            addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
            cursorLine += 1;
            continue;
        }

        const timeMatch = timestampLine.text.match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})/u);
        addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
        cursorLine += 1;
        const textStartLine = cursorLine;
        while (cursorLine < lines.length && lines[cursorLine].text.trim() && !TIMED_SUBTITLE_PATTERN.test(lines[cursorLine].text)) {
            const nextLineStartsCue = format === 'srt'
                && /^\s*\d+\s*$/u.test(lines[cursorLine].text)
                && TIMED_SUBTITLE_PATTERN.test(lines[cursorLine + 1]?.text || '');
            if (nextLineStartsCue) break;
            cursorLine += 1;
        }

        if (cursorLine === textStartLine) continue;
        const textStart = lines[textStartLine].start;
        const textEnd = lines[cursorLine - 1].textEnd;
        const source = content.slice(textStart, textEnd);
        // 将完整字幕提示作为一个翻译单元，使服务能保留 `<i>...</i>` 等行内标签或 ASS
        // 覆盖代码，同时不把时间戳和提示边界发送给翻译请求。
        addSegment(parts, segments, source, {
            timeStart: timeMatch?.[1],
            timeEnd: timeMatch?.[2],
        });

        if (cursorLine < lines.length) {
            addLiteral(parts, content.slice(textEnd, lines[cursorLine].start));
        } else {
            addLiteral(parts, content.slice(textEnd));
        }
    }

    return {parts, segments};
}

function parseAssDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        if (!/^\s*Dialogue\s*:/iu.test(line.text)) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const colon = line.text.indexOf(':');
        const prefix = line.text.slice(0, colon + 1);
        const dialogue = line.text.slice(colon + 1);
        let commaCount = 0;
        let textStart = -1;
        for (let index = 0; index < dialogue.length; index += 1) {
            if (dialogue[index] !== ',') continue;
            commaCount += 1;
            if (commaCount === 9) {
                textStart = index + 1;
                break;
            }
        }

        if (textStart < 0) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const fields = dialogue.slice(0, textStart - 1).split(',');
        addLiteral(parts, prefix + dialogue.slice(0, textStart));
        addSegment(parts, segments, dialogue.slice(textStart), {
            timeStart: fields[1]?.trim(),
            timeEnd: fields[2]?.trim(),
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

function parseLrcDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        const match = line.text.match(LRC_TIME_PATTERN);
        if (!match) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const prefix = match[1];
        addLiteral(parts, prefix);
        const firstTimestamp = prefix.match(/\[((?:\d{1,3}:)?\d{2}(?:\.\d{1,3})?)\]/u)?.[1];
        addSegment(parts, segments, line.text.slice(prefix.length), {
            bilingualPrefix: prefix,
            timeStart: firstTimestamp,
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

const MAX_JSON_DEPTH = 1_000;

function cloneJsonValue(value: unknown): unknown {
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

function parseJsonDocument(content: string): Pick<ParsedDocument, 'segments' | 'jsonValue' | 'jsonEntries'> {
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

export function formatJsonPath(path: Array<string | number>): string {
    return path.reduce<string>((value, part) => {
        if (typeof part === 'number') return `${value}[${part}]`;
        return /^[A-Za-z_$][\w$]*$/u.test(part)
            ? `${value}.${part}`
            : `${value}[${JSON.stringify(part)}]`;
    }, '$');
}

export interface ParseDocumentOptions {
    /** Markdown 的一行作为一个片段整句翻译（链接、行内代码等写成占位符）；默认按受保护内容把一行切成多段。 */
    markdownSentences?: boolean;
}

export function parseDocument(fileName: string, content: string, options: ParseDocumentOptions = {}): ParsedDocument {
    const format = getDocumentFormat(fileName);
    if (!format) {
        throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件');
    }
    if (format === 'pdf' || format === 'epub' || format === 'docx') {
        throw new Error(`${getDocumentFormatLabel(format)}需要按二进制文件解析，请重新打开该文件`);
    }

    if (format === 'json') {
        return {
            fileName,
            format,
            label: getDocumentFormatLabel(format),
            parts: [],
            ...parseJsonDocument(content),
        };
    }

    const parsed = format === 'html'
        ? parseHtmlDocument(content)
        : format === 'txt' || format === 'markdown'
            ? parseTextDocument(content, format, Boolean(options.markdownSentences))
            : format === 'ass'
                ? parseAssDocument(content)
                : format === 'lrc'
                    ? parseLrcDocument(content)
                    : parseTimedSubtitleDocument(content, format);

    return {fileName, format, label: getDocumentFormatLabel(format), ...parsed};
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 原文用 \N 硬换行分成几行、而翻译服务把换行丢掉时，按同样的行数把译文重新断开：优先断在标点或空格之后，
 * 中日韩文字之间在词的边界也可以断；不在样式代码 {…} 里面断，也不拆开一个拉丁单词。找不到合适的位置就保持一行。
 */
function restoreSubtitleBreaks(source: string, translation: string): string {
    const breaks = source.split('\\N').length - 1;
    if (!breaks || /\\[Nn]/u.test(translation)) return translation;
    const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    // 中日韩文字之间只在词的边界断开；环境不提供分词时退回任意两个字之间。
    const words = typeof Intl.Segmenter === 'function' ? new Set(Array.from(new Intl.Segmenter(undefined, {granularity: 'word'}).segment(translation), entry => entry.index)) : undefined;
    // 候选断点：断在这个下标之前；值越小越好（标点后 0，空格处 1，中日韩文字之间 2）。
    const candidates: Array<{index: number; cost: number}> = [];
    let depth = 0;
    for (let index = 1; index < translation.length; index += 1) {
        const previous = translation[index - 1], current = translation[index];
        if (previous === '{') depth += 1;
        if (previous === '}') depth = Math.max(0, depth - 1);
        if (depth || current === '{' && translation.indexOf('}', index) < 0) continue;
        if (/[，。！？；、,.!?;:：]/u.test(previous) && !/[\s，。！？；、,.!?;:：]/u.test(current)) candidates.push({index, cost: 0});
        else if (/\s/u.test(previous) && !/\s/u.test(current)) candidates.push({index, cost: 1});
        else if (wide.test(previous) && wide.test(current) && (words?.has(index) ?? true)) candidates.push({index, cost: 2});
    }
    const chosen: number[] = [];
    for (let line = 1; line <= breaks; line += 1) {
        const target = translation.length * line / (breaks + 1), floor = chosen.at(-1) ?? 0;
        // 偏离理想位置越远越差；标点和空格可以多偏离几个字。
        const best = candidates.filter(candidate => candidate.index > floor)
            .sort((left, right) => Math.abs(left.index - target) + left.cost * 2 - (Math.abs(right.index - target) + right.cost * 2))[0];
        if (!best) return translation;
        chosen.push(best.index);
    }
    return chosen.reduceRight((text, index) => `${text.slice(0, index).trimEnd()}\\N${text.slice(index)}`, translation);
}

/**
 * 有的翻译服务把字幕里的样式标签改写后再返回：转成实体（&lt;i&gt; … &lt;/i&gt;），或换成括号（(i) … (/i)、（i）…（/i））。
 * 原文里确实有同名标签时还原成标签，并去掉服务加在标签内侧的空格；括号写法还要求译文里同时有它的闭合形式，
 * 原文没有的写法不动，避免把正文里的“&lt;”或“(a)”误当成标签。
 */
export function restoreSubtitleTags(source: string, translation: string): string {
    if (!/&lt;|[(（＜]\s*\/?\s*[a-z]/iu.test(translation)) return translation;
    const names = new Set(Array.from(source.matchAll(/<\s*\/?\s*([a-z][\w.]*)/giu), match => match[1].toLowerCase()));
    const closed = (name: string) => new RegExp(`[(（＜]\\s*[/／]\\s*${name}\\s*[)）＞]`, 'iu').test(translation);
    return translation.replace(/(\s?)(&lt;|[(（＜])\s*([\/／]?)\s*([a-z][\w.]*)([^&<>()（）＜＞]*?)\s*(?:&gt;|[)）＞])(\s?)/giu,
        (whole, before: string, open: string, slash: string, name: string, rest: string, after: string) =>
            names.has(name.toLowerCase()) && (open === '&lt;' || closed(name)) ? `${slash ? '' : before}<${slash ? '/' : ''}${name}${rest}>${slash ? after : ''}` : whole);
}

function preserveSubtitleMarkup(source: string, received: string): string {
    const translation = restoreSubtitleTags(source, received);
    const assPrefix = source.match(/^(?:\{[^}]*\})+/u)?.[0];
    if (assPrefix && !translation.startsWith(assPrefix)) return restoreSubtitleBreaks(source, `${assPrefix}${translation}`);

    const htmlOpen = source.match(/^(?:<([a-z][a-z0-9-]*)\b[^>]*>)+/iu)?.[0];
    const htmlClose = source.match(/(?:<\/([a-z][a-z0-9-]*)>)+(?=\s|$)/iu)?.[0];
    if (htmlOpen && htmlClose && !translation.includes(htmlOpen)) {
        return `${htmlOpen}${translation}${htmlClose}`;
    }
    return restoreSubtitleBreaks(source, translation);
}

function originalPartSource(part: SegmentPart): string {
    return part.rawSource ?? part.source;
}

/**
 * 整句送翻的片段，原文里的行内标签和 Markdown 语法已换成编号占位符；这里给出这些片段未替换前的原文，
 * 供校订视图显示读者认得出的文字。没有占位符的片段不在结果里。
 */
export function documentSegmentMarkupSources(document: ParsedDocument): Map<number, string> {
    const sources = new Map<number, string>();
    for (const part of document.parts) {
        if (part.kind === 'segment' && (part.htmlTags || part.markdownTokens)) sources.set(part.segmentIndex, originalPartSource(part));
    }
    return sources;
}

/** 字幕样式标记不属于可见正文，服务省略标记时仍按相同文字处理。 */
function hasDistinctPartTranslation(document: ParsedDocument, source: string, translation: string): boolean {
    if (['srt', 'vtt', 'ass'].includes(document.format)) {
        const text = (value: string) => value.replace(/<[^>]+>/gu, '').replace(/\{\\[^}]+\}/gu, '');
        return hasDistinctTranslation(text(source), text(translation));
    }
    return hasDistinctTranslation(source, translation);
}

/** 空白、相同结果与尚未翻译均保留原文，避免部分导出吞字或重复显示。 */
export function resolveDocumentTranslation(source: string, translation: string | undefined): string {
    return hasDistinctTranslation(source, translation) ? translation! : source;
}

function formatBilingualTranslation(document: ParsedDocument, part: SegmentPart, translation: string, xhtml: boolean): string {
    const source = originalPartSource(part);
    const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
        ? preserveSubtitleMarkup(part.source, translation)
        : translation;
    if (document.format === 'html') {
        return `${part.prefix}${source}${part.suffix}${xhtml ? '<br/>' : '<br>'}<span data-fluent-read-document-translation="true">${renderHtmlTranslation(part, translation)}</span>`;
    }
    if (document.format === 'markdown') {
        return `${part.prefix}${source}${part.suffix}\n> ${renderMarkdownTranslation(part, translation)}`;
    }
    if (document.format === 'ass') {
        return `${part.prefix}${source}${part.suffix}\\N${formattedTranslation.replace(/\r?\n/gu, '\\N')}`;
    }
    if (part.bilingualPrefix) {
        return `${part.prefix}${source}${part.suffix}\n${part.bilingualPrefix}${formattedTranslation}`;
    }
    return `${part.prefix}${source}${part.suffix}\n${formattedTranslation}`;
}

function renderParts(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode, maxLength: number, xhtml: boolean): string {
    const output: string[] = [];
    let length = 0;
    const append = (value: string) => {
        const text = value.slice(0, maxLength - length);
        output.push(text);
        length += text.length;
    };
    for (let index = 0; index < document.parts.length && length < maxLength; index += 1) {
        const part = document.parts[index];
        if (mode === 'bilingual' && document.format === 'markdown' && part.bilingualGroup !== undefined) {
            // 行内链接或代码会被切成多个 part；双语模式按源行重组，避免把一行引用拆成多段。
            const group = part.bilingualGroup;
            const groupParts: DocumentPart[] = [];
            let hasSegment = false;
            while (index < document.parts.length && document.parts[index].bilingualGroup === group) {
                if (document.parts[index].kind === 'segment') hasSegment = true;
                groupParts.push(document.parts[index]);
                index += 1;
            }
            index -= 1;
            // 有界摘录先逐片写原文，达到上限后不再构造整行或读取无用译文。
            for (const entry of groupParts) {
                append(entry.kind === 'literal' ? entry.value : `${entry.prefix}${originalPartSource(entry)}${entry.suffix}`);
                if (length >= maxLength) break;
            }
            if (length >= maxLength) break;
            if (!hasSegment || !groupParts.some(entry => entry.kind === 'segment' &&
                hasDistinctTranslation(entry.source, translations[entry.segmentIndex]))) continue;
            append('\n> ');
            let trailingCR = false;
            for (const entry of groupParts) {
                if (length >= maxLength) break;
                const text = entry.kind === 'literal' ? entry.value
                    : `${entry.prefix}${hasDistinctTranslation(entry.source, translations[entry.segmentIndex]) ? renderMarkdownTranslation(entry, translations[entry.segmentIndex]) : originalPartSource(entry)}${entry.suffix}`;
                if (!text) continue;
                const value = trailingCR && text.startsWith('\n') ? text.slice(1) : text;
                trailingCR = text.endsWith('\r');
                append(value.slice(0, maxLength - length).replace(/\r\n?|\n/gu, '\n> '));
            }
            continue;
        }
        if (part.kind === 'literal') {
            append(part.value);
            continue;
        }
        const translation = resolveDocumentTranslation(part.source, translations[part.segmentIndex]);
        if (!hasDistinctPartTranslation(document, part.source, translation)) {
            append(`${part.prefix}${originalPartSource(part)}${part.suffix}`);
            continue;
        }
        if (mode === 'bilingual') {
            append(formatBilingualTranslation(document, part, translation, xhtml));
            continue;
        }
        if (document.format === 'html') {
            append(`${part.prefix}${renderHtmlTranslation(part, translation)}${part.suffix}`);
            continue;
        }
        const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
            ? preserveSubtitleMarkup(part.source, translation)
            : renderMarkdownTranslation(part, translation);
        append(`${part.prefix}${formattedTranslation}${part.suffix}`);
    }
    return output.join('');
}

function getAtPath(value: unknown, path: Array<string | number>): unknown {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

function setAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
    if (path.length === 0) return value;
    let current = root as Record<string | number, unknown>;
    path.slice(0, -1).forEach((key) => {
        current = current[key] as Record<string | number, unknown>;
    });
    current[path[path.length - 1]] = value;
    return root;
}

export function renderDocument(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode = 'bilingual',
    maxLength = Infinity,
    options: {xhtml?: boolean} = {},
): string {
    maxLength = Number.isNaN(maxLength) ? 0 : Math.max(0, Math.trunc(maxLength));
    if (maxLength === 0) return '';
    if (document.format !== 'json') return renderParts(document, translations, mode, maxLength, options.xhtml ?? false);

    let output = cloneJsonValue(document.jsonValue);
    document.jsonEntries?.forEach((entry) => {
        const original = getAtPath(output, entry.path);
        if (typeof original !== 'string') return;
        const translation = resolveDocumentTranslation(original.trim(), translations[entry.segmentIndex]);
        if (!hasDistinctTranslation(original, translation)) return;
        const value = mode === 'bilingual'
            ? `${entry.prefix}${original.trim()}\n${translation}${entry.suffix}`
            : `${entry.prefix}${translation}${entry.suffix}`;
        output = setAtPath(output, entry.path, value);
    });
    return JSON.stringify(output, null, 2).slice(0, maxLength);
}

export function createDocumentDownloadName(fileName: string, mode: DocumentRenderMode): string {
    const suffix = mode === 'bilingual' ? '.bilingual' : '.translated';
    // 正则始终匹配完整字符串；用非空断言表达该不变量，避免把不可达分支伪装成容错。
    const match = fileName.match(/^([\s\S]*?)(\.[^.]+)?$/u)!;
    return `${match[1] || fileName}${suffix}${match[2] || ''}`;
}
