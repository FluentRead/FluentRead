/**
 * @file src/features/document-translation/core/formats/shared.ts
 * 文件职责：定义文档翻译核心领域模型、多格式片段数据结构、文本切分与字面量归并辅助函数及基础 HTML 扫描/转义工具。
 * 主要内容：声明 PDF/ePub/DOCX/JSON/Markdown/字幕/表格的统一解析产物类型与字节上限常量，提供去空白片段登记、按行尾切分及受引号保护的 HTML 标签扫描。
 * 模块边界：作为 core/formats/* 各格式解析与渲染模块的共享底座，不依赖具体格式实现，也不涉及文件读写或翻译网络调用。
 */
import type {MarkdownTable} from '../markdownTable';
import type {DelimitedColumn} from '../delimited';
import type {LatexToken} from '../latex';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 带插图的论文与扫描件常超过 10 MB；PDF 按页解析、译文量只取决于文字，单独放宽上限。 */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
/** 演示文稿常包含高分辨率图片与媒体资源，单独放宽至与 PDF 相同的上限。 */
export const PPTX_MAX_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
    'pdf',
    'epub',
    'docx',
    'pptx',
    'xlsx',
    'html',
    'htm',
    'txt',
    'md',
    'markdown',
    'tex',
    'srt',
    'vtt',
    'ass',
    'ssa',
    'lrc',
    'json',
    'csv',
    'tsv',
] as const;

export type DocumentFormat =
    | 'pdf'
    | 'epub'
    | 'docx'
    | 'pptx'
    | 'xlsx'
    | 'html'
    | 'txt'
    | 'markdown'
    | 'tex'
    | 'srt'
    | 'vtt'
    | 'ass'
    | 'lrc'
    | 'json'
    | 'csv'
    | 'tsv';

export type DocumentRenderMode = 'bilingual' | 'translated';

/** EPUB 2 使用 XHTML 1.1，只允许标准属性标记译文。 */
export type DocumentHtmlOutput = boolean | 'epub2';

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
    /** Word 正文中具有需要回填的生成标记，字面标签不使用此标志。 */
    docxInline?: true;
    /** 零基源表格行列号，列选择与历史定位使用同一坐标。 */
    delimitedCell?: {row: number; column: number};
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
    /** 不进入翻译分段的原文（作者、页眉、公式等）仍供重排阅读和文本导出保全。 */
    source?: string;
    /** 从原文字形单独识别的列表前缀；不送去翻译，重排文字保留其列表语义。 */
    listMarker?: string;
    /** 列表前缀的原始位置，供扫描页的透明选择层保留圆点及其与正文的顺序。 */
    listMarkerRun?: PdfDocumentRun;
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
    /** 图文卡片底框约束译文和遮罩范围；原文字形位置仍来自 lines。 */
    panelBounds?: Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>;
    lines?: PdfDocumentLine[];
    /** 用户逐行核对后的原文；备份最近一次未校订的识别文字、行位置及核对框，供显式撤销。 */
    sourceCorrection?: {source: string; lines: PdfDocumentLine[]; reviewRegions: Array<Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>>};
}

export interface PdfDocumentPage {
    pageNumber: number;
    /** 保留 PDF 页面的实际展示方向；旧模型与未旋转页面可以省略。 */
    rotation?: 0 | 90 | 180 | 270;
    /** 已按展示方向解析的旋转原生页或扫描识别页：版面块不再带 rotation；记录原页旋转角供导出摆正嵌入的原页。 */
    sourceRotation?: 90 | 180 | 270;
    /** 展示方向的尺寸；90/270 度时，内容坐标系的宽高与这里交换。 */
    width: number;
    height: number;
    segmentIndexes: number[];
    blocks: PdfDocumentBlock[];
    preservedRegions?: PdfPreservedRegion[];
    /** 细分隔线只限制原位译文的可用空白，不作为重排阅读的图形区域。 */
    layoutBoundaries?: Array<Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>>;
    /** 整页是一张图像且没有任何文字（扫描页），等待文字识别；成功识别后取消标记，空结果和失败仍保留以便重试。 */
    scanned?: boolean;
    /** 文字与版面来自扫描识别；用于原文选择和显式重新识别，原始 PDF bytes 仍保持不变。 */
    ocrRecognized?: boolean;
    /** 需要核对的脚标、低分数字或表格原图区域，使用页面展示坐标，供阅读时定位核对。 */
    ocrReviewRegions?: Array<Pick<PdfDocumentRun, 'x' | 'y' | 'width' | 'height'>>;
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

export interface PptxDocumentPart {
    path: string;
    source: string;
    kind: 'slide' | 'notes';
    slideNumber: number;
    paragraphSegments: Array<{paragraphIndex: number; segmentIndex: number}>;
}

export interface XlsxSheetSegment {
    cellRef: string;
    kind: 'shared' | 'inline';
    sharedIndex?: number;
    segmentIndex: number;
}

export interface XlsxDocumentSheet {
    name: string;
    path: string;
    source: string;
    cellSegments: XlsxSheetSegment[];
}

export type BinaryDocumentData =
    | {kind: 'pdf'; bytes: Uint8Array; pages: PdfDocumentPage[]}
    | {kind: 'epub'; bytes: Uint8Array; chapters: EpubDocumentChapter[]}
    | {kind: 'docx'; bytes: Uint8Array; parts: DocxDocumentPart[]; inlineFormatting?: true}
    | {kind: 'pptx'; bytes: Uint8Array; parts: PptxDocumentPart[]}
    | {kind: 'xlsx'; bytes: Uint8Array; sheets: XlsxDocumentSheet[]; sharedStringsPath?: string; sharedStringsSource?: string};

export interface LiteralPart {
    kind: 'literal';
    value: string;
    /** Markdown 源行分组，用于让受保护的行内语法保持原位。 */
    bilingualGroup?: number;
}

export interface SegmentPart {
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
    /** 表格单元格的译文回填在当前列内。 */
    markdownTableCell?: 'withoutLeadingPipe' | 'delimited';
    /** Markdown 整行片段里行内语法的原文：链接是成对的占位符（有 close），代码、网址等是单个占位符。 */
    markdownTokens?: Array<{open: string; close?: string}>;
    /** HTML 整句片段里行内标签的原文：送翻时写成编号占位符 `<gN>…</gN>`，渲染时按编号还原。 */
    htmlTags?: Array<{open: string; close: string}>;
    /** LaTeX 片段中的行内公式、引用和格式化命令：以编号占位符保护，回填时还原。 */
    latexTokens?: LatexToken[];
    /** LaTeX 双语输出方式：命令参数单换行，正文与列表项空行分段。 */
    latexBilingual?: 'paragraph' | 'command';
    /** 表格字段的 rawSource 包含原始引号与空白。 */
    delimitedCell?: {delimiter: ',' | '\t'; quoted: boolean};
}

export type DocumentPart = LiteralPart | SegmentPart;

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
    /** 旧解析快照没有表格范围，刷新时会从原文件补齐。 */
    markdownTables?: readonly MarkdownTable[];
    delimitedColumns?: readonly DelimitedColumn[];
    binary?: BinaryDocumentData;
}

export interface ParseDocumentOptions {
    /** Markdown 的一行作为一个片段整句翻译（链接、行内代码等写成占位符）；默认按受保护内容把一行切成多段。 */
    markdownSentences?: boolean;
}

export type SegmentOptions = Pick<SegmentPart, 'bilingualPrefix' | 'bilingualGroup' | 'markdownTableCell'>
    & Omit<Partial<DocumentSegment>, 'id' | 'source'>;

export function trimSource(value: string): {prefix: string; source: string; suffix: string} | null {
    const source = value.trim();
    if (!source) return null;
    const start = value.length - value.trimStart().length;
    return {prefix: value.slice(0, start), source, suffix: value.slice(start + source.length)};
}

export function addLiteral(parts: DocumentPart[], value: string, bilingualGroup?: number): void {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'literal' && last.bilingualGroup === bilingualGroup) {
        last.value += value;
        return;
    }
    parts.push({kind: 'literal', value, bilingualGroup});
}

export function addSegment(
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
    const {bilingualPrefix, bilingualGroup, markdownTableCell, ...segmentOptions} = options;
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
        ...(markdownTableCell ? {markdownTableCell} : {}),
    });
}

export function splitWithEndings(value: string): Array<{start: number; end: number; textEnd: number; text: string}> {
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

export interface HtmlToken {
    index: number;
    value: string;
}

/** 查找下一个 HTML token，带引号属性中的 `>` 不应被误判为标签边界。 */
export function findNextHtmlToken(content: string, from: number): HtmlToken | null {
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

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
