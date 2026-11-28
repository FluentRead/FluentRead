/**
 * @file src/features/document-translation/core/formats/html.ts
 * 文件职责：负责 HTML 与 XHTML 章节文档的文本抽取、行内标签与代码占位封装、实体解码及译文内联标签安全还原。
 * 主要内容：跳过 head/script/style/pre/code/textarea 受保护区块，将句内链接和强调标签配对编码为编号占位符，渲染时验证嵌套完整性并安全回退纯文本。
 * 模块边界：纯 HTML 字符串解析与片段回填模块，不操作真实 DOM 树，公共扫描与转义工具复用 formats/shared。
 */
import {decodeTextareaHtml} from '@/src/shared/text/htmlEntities';
import {normalizeDocumentInlineMarkers} from '@/src/core/translation/public';
import {
    addLiteral,
    addSegment,
    escapeHtml,
    findNextHtmlToken,
    type DocumentPart,
    type DocumentSegment,
    type ParsedDocument,
    type SegmentPart,
} from './shared';

const PROTECTED_HTML_TAGS = new Set(['head', 'script', 'style', 'pre', 'code', 'textarea']);
/** 不打断句子的行内标签：它们两侧的文字属于同一句话，应当作为一个片段整体翻译。 */
const INLINE_HTML_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var']);
const HTML_PLACEHOLDER = /<\s*(\/?)\s*g\s*(\d+)\s*>/giu;

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
        return decodeTextareaHtml(value);
    }

    return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));/giu, (entity, hex, decimal, name) => {
        if (name) return HTML_ENTITY_FALLBACKS[String(name).toLowerCase()] ?? entity;
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : '\uFFFD';
    });
}

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

export function parseHtmlDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
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
export function renderHtmlTranslation(part: SegmentPart, translation: string): string {
    const tags = part.htmlTags;
    if (!tags) return escapeHtml(translation);
    // 有的翻译服务会把占位符的尖括号转成实体（&lt;g1&gt;）、全角尖括号或括号（（g1）、(g1)）再返回，先还原成占位符。
    const pieces = normalizeDocumentInlineMarkers(translation).split(/(<\s*\/?\s*g\s*\d+\s*>)/iu);
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
