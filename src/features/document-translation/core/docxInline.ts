/**
 * @file src/features/document-translation/core/docxInline.ts
 * 文件职责：让 Word 段落中的链接和字符样式随整句译文移动，按段落实际结构回填。
 * 主要内容：读取普通文字、换行、制表符和超链接，把相邻同样式文字合并为编号片段；验证译文片段的嵌套后使用源文的链接属性和字符样式重建段落；遇到域、绘图、修订等复杂结构时交由调用方保留原段落。
 * 模块边界：只读取单段 WordprocessingML 片段与编号译文，不读取压缩包、不写历史记录或发起翻译。
 */
import {SaxesParser} from 'saxes';
import {stripDocumentInlineMarkers, validateDocumentInlineMarkers} from '@/src/core/translation/documentInlineMarkers';

interface XmlElement {
    name: string;
    start: number;
    openEnd: number;
    end: number;
    attributes: Record<string, string>;
    children: XmlElement[];
    text: string;
}

interface StyledText {text: string; properties: string}
interface Hyperlink {open: string; runs: StyledText[]}
type InlineSpan = {kind: 'style'; properties: string} | {kind: 'link'; open: string; properties: string};
type DocxInlineParagraph = {kind: 'invalid' | 'preserve'} | {
    kind: 'free';
    source: string;
    prefix: string;
    properties: string;
    spans: InlineSpan[];
};

function readParagraph(xml: string): XmlElement | undefined {
    const parser = new SaxesParser({fragment: true, xmlns: false as const});
    const stack: XmlElement[] = [];
    const roots: XmlElement[] = [];
    parser.on('opentag', tag => {
        const start = xml.lastIndexOf('<', parser.position - 1);
        const element = {name: tag.name, start, openEnd: parser.position, end: parser.position, attributes: tag.attributes, children: [], text: ''};
        const parent = stack.at(-1);
        (parent ? parent.children : roots).push(element);
        stack.push(element);
    });
    parser.on('closetag', () => {stack.pop()!.end = parser.position;});
    const writeText = (text: string) => {const element = stack.at(-1); if (element) element.text += text;};
    parser.on('text', writeText);
    parser.on('cdata', writeText);
    try {
        parser.write(xml).close();
    } catch {
        return undefined;
    }
    return roots.length === 1 && roots[0].name === 'w:p' ? roots[0] : undefined;
}

function readRun(element: XmlElement, xml: string): StyledText | undefined {
    if (element.name !== 'w:r' || element.text.trim()) return undefined;
    const properties = element.children[0]?.name === 'w:rPr' ? element.children[0] : undefined;
    const style = properties ? xml.slice(properties.start, properties.end) : '';
    if (/<w:rPrChange\b/u.test(style)) return undefined;
    let text = '';
    for (const child of element.children.slice(properties ? 1 : 0)) {
        if (child.children.length) return undefined;
        if (child.name === 'w:t') text += child.text;
        else if (child.name === 'w:tab' && !child.text.trim()) text += '\t';
        else if ((child.name === 'w:br' || child.name === 'w:cr') && !child.text.trim() &&
            Object.keys(child.attributes).every(name => name === 'w:type' && child.attributes[name] === 'textWrapping')) text += '\n';
        else return undefined;
    }
    return {text, properties: style};
}

function defaultProperties(runs: readonly StyledText[]): string {
    return (runs.find(run => !run.properties) ?? runs.find(run => run.text.trim()))?.properties ?? '';
}

function encodeRuns(runs: readonly StyledText[], base: string, mark: (span: InlineSpan, text: string) => string): string {
    const groups: StyledText[] = [];
    for (const run of runs) {
        if (!run.text) continue;
        const previous = groups.at(-1);
        if (previous?.properties === run.properties) previous.text += run.text;
        else groups.push({...run});
    }
    return groups.map(({properties, text}) => properties === base || !text.trim() ? text : mark({kind: 'style', properties}, text)).join('');
}

export function analyzeDocxInlineParagraph(xml: string): DocxInlineParagraph {
    const paragraph = readParagraph(xml);
    if (!paragraph) return {kind: 'invalid'};
    if (paragraph.text.trim()) return {kind: 'preserve'};
    const pPr = paragraph.children[0]?.name === 'w:pPr' ? paragraph.children[0] : undefined;
    const runs: Array<StyledText | Hyperlink> = [];
    for (const element of paragraph.children.slice(pPr ? 1 : 0)) {
        if (element.name !== 'w:hyperlink') {
            const run = readRun(element, xml);
            if (!run) return {kind: 'preserve'};
            runs.push(run);
            continue;
        }
        const linkRuns = element.children.map(child => readRun(child, xml));
        if (element.text.trim() || linkRuns.some(run => !run) || !linkRuns.some(run => run?.text.trim())) return {kind: 'preserve'};
        runs.push({open: xml.slice(element.start, element.openEnd), runs: linkRuns as StyledText[]});
    }
    if (runs.some(run => ('runs' in run ? run.runs : [run]).some(item => stripDocumentInlineMarkers(item.text) !== item.text))) return {kind: 'preserve'};
    const spans: InlineSpan[] = [];
    let nextId = 0;
    const mark = (span: InlineSpan, text: string) => {
        spans.push(span);
        const id = ++nextId;
        return `<g${id}>${text}</g${id}>`;
    };
    const properties = defaultProperties(runs.filter((run): run is StyledText => 'text' in run));
    const pending: StyledText[] = [];
    let source = '';
    for (const run of runs) {
        if ('runs' in run) {
            source += encodeRuns(pending.splice(0), properties, mark);
            const linkProperties = defaultProperties(run.runs);
            const id = ++nextId;
            spans.push({kind: 'link', open: run.open, properties: linkProperties});
            source += `<g${id}>${encodeRuns(run.runs, linkProperties, mark)}</g${id}>`;
        } else pending.push(run);
    }
    source += encodeRuns(pending, properties, mark);
    return {kind: 'free', source: source.trim(), prefix: xml.slice(0, pPr?.end ?? paragraph.openEnd), properties, spans};
}

/** 空译文标记或人工校订丢失的标记不足以确定应回填到哪个样式，交给段落级回退。 */
export function renderDocxInlineRuns(
    paragraph: Extract<DocxInlineParagraph, {kind: 'free'}>,
    translation: string,
    textNodes: (text: string) => string,
    plainProperties: string,
): string | undefined {
    const run = (text: string, properties: string) => text ? `<w:r>${properties}${textNodes(text)}</w:r>` : '';
    if (!paragraph.spans.length) return run(translation, paragraph.properties || plainProperties);
    let normalized: string;
    try {
        normalized = validateDocumentInlineMarkers(paragraph.source, translation, {}) as string;
    } catch {
        return undefined;
    }
    let rendered = '';
    let cursor = 0;
    const stack: InlineSpan[] = [];
    const activeProperties = () => stack.at(-1)?.properties ?? (paragraph.properties || plainProperties);
    for (const match of normalized.matchAll(/<(\/?)g(\d+)>/gu)) {
        rendered += run(normalized.slice(cursor, match.index), activeProperties());
        cursor = match.index + match[0].length;
        if (match[1]) {
            if (stack.pop()!.kind === 'link') rendered += '</w:hyperlink>';
        } else {
            const span = paragraph.spans[Number(match[2]) - 1];
            stack.push(span);
            if (span.kind === 'link') rendered += span.open;
        }
    }
    return rendered + run(normalized.slice(cursor), activeProperties());
}
