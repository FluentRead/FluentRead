/**
 * @file src/core/translation/wrappedParagraphs.ts
 * 文件职责：在送翻前自动展开手动折行的多行段落（如 Markdown 正文与 git commit message），同时保留空行分段、硬换行、代码块与结构化行。
 * 主要内容：提供面向普通流文本的软换行展开（unwrapSoftLineBreaks）以及面向预格式/纯文本/Markdown 的多行折行段落合并（unwrapWrappedParagraphs）；按显示宽度、中日韩无空格边界、句末折行宽度证据、缩进、引用前缀、列表续行、围栏代码、数学块、提交 trailer 与显式硬换行判定合并边界。
 * 模块边界：本文件属于无 DOM、无配置、无网络副作用的 core 纯文本算法模块，经 src/core/translation/public.ts 对外暴露；不修改宿主页面节点，不持久化用户文本，也不承担文档导出还原。
 */

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。、；：！？（）《》“”‘’]/u;
const UNSPACED_WRAP_END = new RegExp(`${UNSPACED_SCRIPT.source}$`, 'u');
const UNSPACED_WRAP_START = new RegExp(`^${UNSPACED_SCRIPT.source}`, 'u');
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u;

const SENTENCE_END = /[.!?。！？…][)\]"'’”）】》]*$/u;
const CLAUSE_END = /[:;：；][)\]"'’”）】》]*$/u;
const BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const MATH_FENCE = /^ {0,3}\$\$\s*$/u;
const BLOCKQUOTE_PREFIX = /^( {0,3}(?:>[ \t]?)+)(.*)$/u;
const LIST_ITEM = /^( {0,3}(?:[-*+•·▪◦]|\(?\d{1,9}[.)）]|\(?[a-zA-Z][.)）]|（[\da-zA-Z]{1,3}）)[ \t]+)(.*)$/u;
const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|(?:=+|-+|(?:[-*_][ \t]*){3,})$|:{3,}|\[[^\]]+\]:|<(?:!--|\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>)\s*$)/u;
const TABLE_LINE = /^(?:\|.*|.*\|[ \t]*|:?-{3,}:?(?:[ \t]*\|[ \t]*:?-{3,}:?)+)$/u;
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9_-]{1,31}:[ \t]+\S/u;
const CODE_LIKE_LINE = /^(?:[$#][ \t]+\S|\/\*|\*\/|\/\/|(?:import|export|const|let|var|function|class|return|def|async|if|for|while|switch|case|try|catch)\b)|[;{}]\s*$/u;
const MARKDOWN_URL_OR_TAG_END = /(?:https?:\/\/\S+|#[\p{L}\p{N}_/-]+)$/u;

const MIN_WRAP_WIDTH = 36;
const MIN_EARLY_WRAP_WIDTH = 20;
const MIN_EARLY_WRAP_COMBINED = 50;
const MIN_BLOCK_WRAP_WIDTH = 44;

interface RawLine {
    raw: string;
    ending: string;
    indent: number;
    trimmed: string;
}

function displayWidth(value: string): number {
    let width = 0;
    for (const char of value) width += WIDE_CHAR.test(char) ? 2 : 1;
    return width;
}

function firstTokenWidth(trimmed: string): number {
    if (UNSPACED_WRAP_START.test(trimmed)) return 2;
    return displayWidth(trimmed.match(/^\S+/u)![0]);
}

function indentWidth(line: string): number {
    let columns = 0;
    for (const char of line) {
        if (char === ' ') columns += 1;
        else if (char === '\t') columns += 4 - columns % 4;
        else break;
    }
    return columns;
}

function splitLinesWithEndings(value: string): RawLine[] {
    const lines: RawLine[] = [];
    const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
    let match = pattern.exec(value);
    while (match) {
        if (match[0] === '' && match.index === value.length) break;
        const segment = match[0];
        const endingLength = segment.endsWith('\r\n') ? 2 : segment.endsWith('\n') || segment.endsWith('\r') ? 1 : 0;
        const raw = segment.slice(0, segment.length - endingLength);
        lines.push({
            raw,
            ending: segment.slice(segment.length - endingLength),
            indent: indentWidth(raw),
            trimmed: raw.trim(),
        });
        match = pattern.exec(value);
    }
    return lines;
}

function joinPair(left: string, right: string): string {
    const leftTrimmed = left.trimEnd();
    const rightTrimmed = right.trimStart();
    const needsSpace = MARKDOWN_URL_OR_TAG_END.test(leftTrimmed)
        || !UNSPACED_WRAP_END.test(leftTrimmed)
        || !UNSPACED_WRAP_START.test(rightTrimmed);
    return needsSpace ? `${leftTrimmed} ${rightTrimmed}` : `${leftTrimmed}${rightTrimmed}`;
}

function isMarkdownHardBreak(raw: string): boolean {
    const trimmedEnd = raw.trimEnd();
    return trimmedEnd.endsWith('\\') || raw.slice(trimmedEnd.length).includes('  ');
}

function isAllCapsHeading(trimmed: string): boolean {
    return /\p{Lu}.*\p{Lu}/u.test(trimmed) && !/\p{Ll}/u.test(trimmed);
}

function isStandaloneStructure(trimmed: string): boolean {
    return BLOCK_START.test(trimmed)
        || TABLE_LINE.test(trimmed)
        || TRAILER_LINE.test(trimmed)
        || CODE_LIKE_LINE.test(trimmed)
        || isAllCapsHeading(trimmed);
}

function isSetextUnderline(trimmed: string): boolean {
    return /^(?:=+|-+)$/u.test(trimmed);
}

function hasOpenInlineCodeSpan(text: string): boolean {
    let openLength = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '`') continue;
        let run = 1;
        while (text[index + run] === '`') run += 1;
        index += run - 1;
        if (openLength === 0) openLength = run;
        else if (openLength === run) openLength = 0;
    }
    return openLength > 0;
}

function joinProseRun(lines: readonly RawLine[]): string {
    if (lines.length === 1) return lines[0]!.raw + lines[0]!.ending;
    const widths = lines.map(line => displayWidth(line.trimmed));
    const nonFinalWidths = widths.slice(0, -1).sort((a, b) => a - b);
    const wrapWidth = nonFinalWidths[Math.floor((nonFinalWidths.length - 1) * 0.9)]!;

    const midSentence = lines.slice(0, -1).map((line, index) => {
        if (isMarkdownHardBreak(line.raw)) return false;
        if (SENTENCE_END.test(line.trimmed)) return false;
        const nextWidth = firstTokenWidth(lines[index + 1]!.trimmed);
        if (CLAUSE_END.test(line.trimmed)) {
            return widths[index]! >= MIN_WRAP_WIDTH && /^[a-z]/u.test(lines[index + 1]!.trimmed);
        }
        return widths[index]! >= MIN_WRAP_WIDTH
            || (widths[index]! >= MIN_EARLY_WRAP_WIDTH && widths[index]! + 1 + nextWidth >= MIN_EARLY_WRAP_COMBINED);
    });
    const hasMidSentenceWrap = midSentence.some(Boolean);

    const joinAfter = lines.slice(0, -1).map((line, index) => {
        if (midSentence[index]) return true;
        if (!hasMidSentenceWrap || isMarkdownHardBreak(line.raw) || wrapWidth < MIN_BLOCK_WRAP_WIDTH) return false;
        const nextWidth = firstTokenWidth(lines[index + 1]!.trimmed);
        return widths[index]! >= Math.max(MIN_WRAP_WIDTH, wrapWidth * 0.72)
            && widths[index]! + 1 + nextWidth >= wrapWidth - 2;
    });

    let output = '';
    let current = lines[0]!.raw;
    for (let index = 0; index < lines.length - 1; index += 1) {
        if (joinAfter[index]) {
            const next = lines[index + 1]!;
            current = hasOpenInlineCodeSpan(current)
                ? `${current} ${next.raw.trimStart()}`
                : joinPair(current, next.raw);
        } else {
            output += current + lines[index]!.ending;
            current = lines[index + 1]!.raw;
        }
    }
    return output + current + lines[lines.length - 1]!.ending;
}

/** 展开普通 HTML 流文本中的软换行（white-space: normal），中日韩文字间不额外插空格。 */
export function unwrapSoftLineBreaks(text: string): string {
    if (!/[\r\n]/u.test(text)) return text;
    return text.replace(/(?<![^\S\r\n])[^\S\r\n]*(?:\r\n?|\n)[^\S\r\n]*/gu, (wrap: string, offset: number, source: string) => {
        const before = source.slice(Math.max(0, offset - 2), offset);
        const after = source.slice(offset + wrap.length, offset + wrap.length + 2);
        return UNSPACED_WRAP_END.test(before) && UNSPACED_WRAP_START.test(after) ? '' : ' ';
    });
}

/** 按宿主空白策略规范化送翻段落：普通流展开软换行，预格式文本自动合并手动折行段落。 */
export function normalizeParagraphTranslationSource(text: string, preserveNewlines: boolean): string {
    if (!/[\r\n]/u.test(text)) return text;
    return preserveNewlines ? unwrapWrappedParagraphs(text) : unwrapSoftLineBreaks(text);
}

/**
 * 自动展开 Markdown 多行段落和 git commit message 中的手动硬换行，保留空行分段、
 * 显式硬换行、代码块、标题、列表、表格、提交 trailer 与短行结构。
 */
export function unwrapWrappedParagraphs(text: string): string {
    if (!/[\r\n]/u.test(text)) return text;
    const lines = splitLinesWithEndings(text);
    const result: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index]!;

        // 围栏代码块与数学块原样保留。
        const fence = line.raw.match(BLOCK_FENCE)?.[1];
        if (fence) {
            result.push(line.raw + line.ending);
            index += 1;
            while (index < lines.length) {
                const inner = lines[index]!;
                result.push(inner.raw + inner.ending);
                index += 1;
                const close = inner.raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/u)?.[1];
                if (close && close[0] === fence[0] && close.length >= fence.length) break;
            }
            continue;
        }
        if (MATH_FENCE.test(line.raw)) {
            result.push(line.raw + line.ending);
            index += 1;
            while (index < lines.length) {
                const inner = lines[index]!;
                result.push(inner.raw + inner.ending);
                index += 1;
                if (MATH_FENCE.test(inner.raw)) break;
            }
            continue;
        }

        if (!line.trimmed) {
            result.push(line.raw + line.ending);
            index += 1;
            continue;
        }

        // 连续同级引用块：剥离相同前缀后递归展开正文，保留 callout 头与结构行。
        const quote = line.raw.match(BLOCKQUOTE_PREFIX);
        if (quote) {
            const prefix = quote[1]!;
            const innerLines: string[] = [];
            let end = index;
            while (end < lines.length) {
                const candidate = lines[end]!;
                if (!candidate.raw.startsWith(prefix)) break;
                const body = candidate.raw.slice(prefix.length);
                if (/^[ \t]*>/u.test(body) || /^\[![^\]]+\]/u.test(body.trim())) break;
                innerLines.push(body + candidate.ending);
                end += 1;
            }
            if (end > index + 1) {
                const unwrapped = unwrapWrappedParagraphs(innerLines.join(''));
                const restored = splitLinesWithEndings(unwrapped).map(part => `${prefix}${part.raw}${part.ending}`).join('');
                result.push(restored);
                index = end;
                continue;
            }
            result.push(line.raw + line.ending);
            index += 1;
            continue;
        }

        // 列表项：绝不并入上一行；若后续紧跟缩进续行则合并到当前列表项内。
        const list = line.raw.match(LIST_ITEM);
        if (list) {
            const marker = list[1]!;
            const firstBody = list[2]!;
            const minContinuationIndent = indentWidth(line.raw) + 1;
            const maxContinuationIndent = indentWidth(marker) + 3;
            const run: RawLine[] = [{...line, raw: firstBody, trimmed: firstBody.trim()}];
            let end = index + 1;
            while (end < lines.length) {
                const next = lines[end]!;
                if (!next.trimmed || next.indent < minContinuationIndent || next.indent > maxContinuationIndent) break;
                if (BLOCK_FENCE.test(next.raw) || MATH_FENCE.test(next.raw) || BLOCKQUOTE_PREFIX.test(next.raw)
                    || LIST_ITEM.test(next.raw) || isStandaloneStructure(next.trimmed)) break;
                run.push(next);
                end += 1;
            }
            if (run.length > 1) {
                const joined = joinProseRun(run);
                result.push(marker + joined);
            } else {
                result.push(line.raw + line.ending);
            }
            index = end;
            continue;
        }

        // 缩进代码块或结构化单行原样保留。
        if (line.indent >= 4 || isStandaloneStructure(line.trimmed)) {
            result.push(line.raw + line.ending);
            index += 1;
            continue;
        }

        // 收集同一缩进的连续普通正文行。
        const run: RawLine[] = [line];
        let end = index + 1;
        while (end < lines.length) {
            const next = lines[end]!;
            if (!next.trimmed || next.indent !== line.indent) break;
            if (BLOCK_FENCE.test(next.raw) || MATH_FENCE.test(next.raw) || BLOCKQUOTE_PREFIX.test(next.raw)
                || LIST_ITEM.test(next.raw) || isStandaloneStructure(next.trimmed)) break;
            run.push(next);
            end += 1;
        }
        // Setext 标题行后紧跟 === 或 ---：最后一行属于标题，不参与折行合并。
        const nextLine = lines[end];
        if (nextLine && isSetextUnderline(nextLine.trimmed)) {
            for (const entry of run) result.push(entry.raw + entry.ending);
        } else {
            result.push(joinProseRun(run));
        }
        index = end;
    }

    return result.join('');
}
