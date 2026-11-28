/**
 * @file src/features/document-translation/core/pptxXml.ts
 * 文件职责：为 PowerPoint OOXML 幻灯片与备注 XML 提供无副作用的段落提取、标题角色识别与样式保留回填能力。
 * 主要内容：使用 SaxesParser 解析 DrawingML 段落中的字符运行、换行与域元素，识别标题占位符和大字号标题并跳过纯数字、代码或链接段落，支持双语追加段落与仅译文替换两种导出模式，并解析幻灯片备注关系目标路径。
 * 模块边界：仅操作单个 XML 字符串与译文数组，不接触 JSZip、File 或任何浏览器 API；压缩包读写、安全上限和取消控制归 services/binary 管理。
 */
import {SaxesParser} from 'saxes';
import {hasDistinctTranslation} from '@/src/core/translation/result';

const PPTX_PARAGRAPH_PATTERN = /<a:p(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*?(?:\/>|>[\s\S]*?<\/a:p\s*>)/gu;
const PPTX_SHAPE_PATTERN = /<p:sp(?=[\s>])[\s\S]*?<\/p:sp\s*>/gu;
const PPTX_TITLE_PLACEHOLDER_PATTERN = /<p:ph\b[^>]*\btype=["'](?:title|ctrTitle|subTitle)["']/iu;

interface XmlNode {
    name: string;
    start: number;
    openEnd: number;
    end: number;
    attributes: Record<string, string>;
    children: XmlNode[];
    text: string;
}

export interface PptxExtractedParagraph {
    paragraphIndex: number;
    text: string;
    role: 'heading' | 'paragraph';
}

interface AnalyzedPptxParagraph {
    openTag: string;
    pPr: string;
    endParaRPr: string;
    firstRunRPr: string;
    fontSize: number;
    text: string;
    fieldsXml: string;
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

function readXmlRoot(xml: string): XmlNode | undefined {
    const parser = new SaxesParser({fragment: true, xmlns: false as const});
    const stack: XmlNode[] = [];
    const roots: XmlNode[] = [];
    parser.on('opentag', tag => {
        const start = xml.lastIndexOf('<', parser.position - 1);
        const node: XmlNode = {
            name: tag.name,
            start,
            openEnd: parser.position,
            end: parser.position,
            attributes: tag.attributes,
            children: [],
            text: '',
        };
        const parent = stack.at(-1);
        (parent ? parent.children : roots).push(node);
        stack.push(node);
    });
    parser.on('closetag', () => {stack.pop()!.end = parser.position;});
    const append = (text: string) => {stack.at(-1)!.text += text;};
    parser.on('text', append);
    parser.on('cdata', append);
    try {
        parser.write(xml).close();
    } catch {
        return undefined;
    }
    return roots[0];
}

/** 过滤幻灯片中纯数字、版本号、网址、邮箱与代码标识符，避免无意义送翻或破坏编号占位。 */
export function isTranslatablePptxText(value: string): boolean {
    const trimmed = value.trim();
    return /\p{L}/u.test(trimmed)
        && !/^(?:[a-z][\w+.-]*:\/\/|mailto:|www\.)\S+$|^[^@\s]+@[^@\s]+\.[^@\s]+$/iu.test(trimmed)
        && !/^(?:true|false|null|NaN|#[0-9a-f]{3,8}|v?\d+(?:\.\d+)+[\w.-]*|[\d.]+e[+-]?\d+|\d{4}-\d{2}-\d{2}[Tt]\d.*|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu.test(trimmed);
}

function analyzePptxParagraph(xml: string): AnalyzedPptxParagraph | undefined {
    const paragraph = readXmlRoot(xml);
    if (!paragraph || paragraph.end === paragraph.openEnd) return undefined;
    let pPr = '';
    let endParaRPr = '';
    let firstRunRPr = '';
    let fontSize = 0;
    let fieldsXml = '';
    const tokens: string[] = [];

    for (const child of paragraph.children) {
        if (child.name === 'a:pPr') {
            pPr = xml.slice(child.start, child.end);
        } else if (child.name === 'a:endParaRPr') {
            endParaRPr = xml.slice(child.start, child.end);
        } else if (child.name === 'a:fld') {
            fieldsXml += xml.slice(child.start, child.end);
        } else if (child.name === 'a:br') {
            tokens.push('\n');
        } else if (child.name === 'a:r') {
            const rPrNode = child.children.find(item => item.name === 'a:rPr');
            const textNode = child.children.find(item => item.name === 'a:t');
            const runText = textNode?.text ?? '';
            if (rPrNode && (!firstRunRPr || (runText.trim() && !tokens.some(part => part.trim())))) {
                firstRunRPr = xml.slice(rPrNode.start, rPrNode.end);
                const size = Number(rPrNode.attributes.sz);
                if (Number.isFinite(size) && size > 0) fontSize = size;
            }
            if (runText) tokens.push(runText);
        }
    }

    const text = tokens.join('').replace(/\u0000/gu, '').trim();
    return {
        openTag: xml.slice(paragraph.start, paragraph.openEnd),
        pPr,
        endParaRPr,
        firstRunRPr,
        fontSize,
        text,
        fieldsXml,
    };
}

function findTitleShapeRanges(source: string): Array<{start: number; end: number}> {
    const ranges: Array<{start: number; end: number}> = [];
    PPTX_SHAPE_PATTERN.lastIndex = 0;
    let match = PPTX_SHAPE_PATTERN.exec(source);
    while (match) {
        if (PPTX_TITLE_PLACEHOLDER_PATTERN.test(match[0])) {
            ranges.push({start: match.index, end: match.index + match[0].length});
        }
        match = PPTX_SHAPE_PATTERN.exec(source);
    }
    return ranges;
}

export function parsePptxPartXml(source: string, kind: 'slide' | 'notes'): PptxExtractedParagraph[] {
    const titleRanges = kind === 'slide' ? findTitleShapeRanges(source) : [];
    const results: PptxExtractedParagraph[] = [];
    let paragraphIndex = 0;
    PPTX_PARAGRAPH_PATTERN.lastIndex = 0;
    let match = PPTX_PARAGRAPH_PATTERN.exec(source);
    while (match) {
        const analyzed = analyzePptxParagraph(match[0]);
        if (analyzed && isTranslatablePptxText(analyzed.text)) {
            const inTitleShape = titleRanges.some(range => match!.index >= range.start && match!.index < range.end);
            const role: 'heading' | 'paragraph' = kind === 'slide' && (inTitleShape || analyzed.fontSize >= 2400)
                ? 'heading' : 'paragraph';
            results.push({paragraphIndex, text: analyzed.text, role});
        }
        paragraphIndex += 1;
        match = PPTX_PARAGRAPH_PATTERN.exec(source);
    }
    return results;
}

function buildPptxRuns(value: string, rPr: string): string {
    const lines = stripInvalidXmlChars(value).replace(/\r\n?/gu, '\n').split('\n');
    return lines
        .map(line => `<a:r>${rPr}<a:t>${xmlEscape(line)}</a:t></a:r>`)
        .join('<a:br/>');
}

export function renderPptxPartXml(
    source: string,
    paragraphSegments: ReadonlyArray<{paragraphIndex: number; segmentIndex: number}>,
    segments: ReadonlyArray<{source: string}>,
    translations: readonly string[],
    mode: 'bilingual' | 'translated',
): string {
    const segmentByParagraph = new Map(paragraphSegments.map(entry => [entry.paragraphIndex, entry.segmentIndex]));
    let paragraphIndex = 0;
    PPTX_PARAGRAPH_PATTERN.lastIndex = 0;
    return source.replace(PPTX_PARAGRAPH_PATTERN, paragraph => {
        const segmentIndex = segmentByParagraph.get(paragraphIndex);
        paragraphIndex += 1;
        if (segmentIndex === undefined) return paragraph;
        const segment = segments[segmentIndex];
        const translation = translations[segmentIndex] ?? '';
        if (!segment || !hasDistinctTranslation(segment.source, translation)) return paragraph;
        const analyzed = analyzePptxParagraph(paragraph);
        if (!analyzed) return paragraph;
        const runs = buildPptxRuns(translation, analyzed.firstRunRPr);
        if (mode === 'bilingual') {
            return `${paragraph}<a:p>${analyzed.pPr}${runs}${analyzed.endParaRPr}</a:p>`;
        }
        return `${analyzed.openTag}${analyzed.pPr}${runs}${analyzed.fieldsXml}${analyzed.endParaRPr}</a:p>`;
    });
}

/** 从幻灯片关系 XML 提取关联备注页的相对路径。 */
export function parsePptxSlideNotesTarget(relsXml: string): string | undefined {
    const parser = new SaxesParser({xmlns: false as const});
    let target: string | undefined;
    parser.on('opentag', tag => {
        if (target || tag.name !== 'Relationship') return;
        const type = String(tag.attributes.Type ?? '');
        const candidate = String(tag.attributes.Target ?? '');
        if (/\/notesSlide$/iu.test(type) && candidate) target = candidate;
    });
    try {
        parser.write(relsXml).close();
    } catch {
        return undefined;
    }
    return target;
}
