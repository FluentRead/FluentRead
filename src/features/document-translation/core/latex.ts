/**
 * @file src/features/document-translation/core/latex.ts
 * 文件职责：为 LaTeX 源文件提供无副作用的解析与译文还原算法，在不破坏可编译语法的前提下提取标题、段落、图注与列表项。
 * 主要内容：忽略注释并精确扫描文档起止环境边界，完整保护数学环境、代码与绘图环境及行内 `\verb` 片段，使用编号占位符保护行内公式、引用、链接地址、格式化命令与行尾注释，回填时确保注释后保留换行不吞掉后续闭合花括号并校验嵌套与兜底保留受保护片段。
 * 模块边界：仅操作纯文本字符串与共享编号占位符归一化函数，不读取文件、不依赖 DOM 或压缩包库，文档总调度由 core/document 负责。
 */
import {normalizeDocumentInlineMarkers} from '@/src/core/translation/public';

export interface LatexToken {
    open: string;
    close?: string;
}

export interface LatexLiteralPart {
    kind: 'literal';
    value: string;
}

export interface LatexSegmentPart {
    kind: 'segment';
    segmentIndex: number;
    source: string;
    rawSource?: string;
    prefix: string;
    suffix: string;
    latexTokens?: LatexToken[];
    latexBilingual?: 'paragraph' | 'command';
}

export type LatexPart = LatexLiteralPart | LatexSegmentPart;

export interface LatexSegment {
    id: number;
    source: string;
    contextLabel?: string;
    role?: 'title' | 'heading' | 'paragraph' | 'list-item';
}

const PROTECTED_ENVS = new Set([
    'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
    'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'math', 'displaymath',
    'verbatim', 'verbatim*', 'lstlisting', 'minted', 'tikzpicture', 'Verbatim', 'BVerbatim', 'LVerbatim',
    'comment', 'filecontents', 'filecontents*',
]);

const PREAMBLE_COMMANDS = new Set(['title', 'subtitle']);
const HEADING_COMMANDS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);
const BODY_TRANSLATABLE_COMMANDS = new Set(['title', 'subtitle', 'caption', ...HEADING_COMMANDS]);

const INLINE_FORMAT_COMMANDS = new Set([
    'textbf', 'textit', 'emph', 'underline', 'textsc', 'textsf', 'textrm', 'textsl',
    'textsuperscript', 'textsubscript',
]);

const BLOCK_LITERAL_COMMANDS = new Set([
    'documentclass', 'usepackage', 'newcommand', 'renewcommand', 'providecommand', 'DeclareMathOperator',
    'author', 'date', 'institute', 'affiliation', 'email', 'keywords',
    'label', 'includegraphics', 'bibliography', 'bibliographystyle', 'addbibresource', 'input', 'include',
    'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'appendix',
    'centering', 'raggedright', 'raggedleft', 'newpage', 'clearpage', 'cleardoublepage', 'pagebreak',
    'noindent', 'medskip', 'bigskip', 'smallskip', 'vspace', 'hspace', 'setlength', 'setcounter',
    'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'multicolumn', 'pagestyle', 'thispagestyle',
]);

const LATEX_PLACEHOLDER_PATTERN = /<\s*\/?\s*g\s*\d+\s*\/?\s*>/iu;

function findCommentEnd(source: string, start: number): number {
    const newline = source.indexOf('\n', start);
    return newline < 0 ? source.length : newline;
}

function findMatchingBrace(source: string, openIndex: number): number {
    let depth = 1;
    let index = openIndex + 1;
    while (index < source.length) {
        const ch = source[index];
        if (ch === '\\') {index += 2; continue;}
        if (ch === '%') {index = findCommentEnd(source, index); continue;}
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
        index += 1;
    }
    return -1;
}

function findMatchingBracket(source: string, openIndex: number): number {
    let bracketDepth = 1;
    let braceDepth = 0;
    let index = openIndex + 1;
    while (index < source.length) {
        const ch = source[index];
        if (ch === '\\') {index += 2; continue;}
        if (ch === '%') {index = findCommentEnd(source, index); continue;}
        if (ch === '{') braceDepth += 1;
        else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
        else if (braceDepth === 0) {
            if (ch === '[') bracketDepth += 1;
            else if (ch === ']') {
                bracketDepth -= 1;
                if (bracketDepth === 0) return index;
            }
        }
        index += 1;
    }
    return -1;
}

function skipHorizontalSpaces(source: string, index: number): number {
    while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index += 1;
    return index;
}

function readCommandName(source: string, slashIndex: number): {name: string; end: number} {
    let end = slashIndex + 1;
    if (end < source.length && /[A-Za-z]/u.test(source[end])) {
        while (end < source.length && /[A-Za-z]/u.test(source[end])) end += 1;
        return {name: source.slice(slashIndex + 1, end), end};
    }
    return {name: source.slice(slashIndex + 1, Math.min(source.length, slashIndex + 2)), end: Math.min(source.length, slashIndex + 2)};
}

function consumeVerbEnd(source: string, nameEnd: number): number {
    let cursor = nameEnd;
    if (source[cursor] === '*') cursor += 1;
    const delimiter = source[cursor];
    if (!delimiter || delimiter === '\n' || delimiter === '\r') return nameEnd;
    const close = source.indexOf(delimiter, cursor + 1);
    return close >= 0 ? close + 1 : nameEnd;
}

function consumeCommandTail(source: string, start: number, maxBraces: number): number {
    let cursor = start;
    if (source[cursor] === '*') cursor += 1;
    while (cursor < source.length) {
        const next = skipHorizontalSpaces(source, cursor);
        if (source[next] === '[') {
            const close = findMatchingBracket(source, next);
            if (close < 0) break;
            cursor = close + 1;
            continue;
        }
        break;
    }
    for (let count = 0; count < maxBraces; count += 1) {
        const next = skipHorizontalSpaces(source, cursor);
        if (source[next] !== '{') break;
        const close = findMatchingBrace(source, next);
        if (close < 0) break;
        cursor = close + 1;
    }
    return cursor;
}

function findInlineDollarEnd(source: string, start: number): number {
    let index = start + 1;
    while (index < source.length) {
        const ch = source[index];
        if (ch === '\\') {index += 2; continue;}
        if (ch === '%') {index = findCommentEnd(source, index); continue;}
        if (ch === '$') return index;
        index += 1;
    }
    return -1;
}

function findSequenceEnd(source: string, start: number, marker: string): number {
    let index = start;
    while (index < source.length) {
        if (source.startsWith(marker, index)) return index + marker.length;
        if (source[index] === '\\') {index += 2; continue;}
        if (source[index] === '%') {index = findCommentEnd(source, index); continue;}
        index += 1;
    }
    return source.length;
}

function encodeInlineLatex(input: string, tokens: LatexToken[]): string {
    let output = '';
    let index = 0;
    const addAtom = (raw: string) => {
        tokens.push({open: raw});
        output += `<g${tokens.length}/>`;
    };
    while (index < input.length) {
        const ch = input[index];
        if (ch === '%') {
            const end = findCommentEnd(input, index);
            addAtom(input.slice(index, end));
            index = end;
            continue;
        }
        if (ch === '~') {
            addAtom('~');
            index += 1;
            continue;
        }
        if (ch === '$' && input[index + 1] !== '$') {
            const close = findInlineDollarEnd(input, index);
            if (close > index) {
                addAtom(input.slice(index, close + 1));
                index = close + 1;
                continue;
            }
            output += ch;
            index += 1;
            continue;
        }
        if (ch === '\\') {
            if (input[index + 1] === '(') {
                const end = findSequenceEnd(input, index + 2, '\\)');
                addAtom(input.slice(index, end));
                index = end;
                continue;
            }
            const {name, end: nameEnd} = readCommandName(input, index);
            if (name === 'verb') {
                const end = consumeVerbEnd(input, nameEnd);
                addAtom(input.slice(index, end));
                index = end;
                continue;
            }
            if (name === 'href') {
                const urlOpen = skipHorizontalSpaces(input, nameEnd);
                const urlClose = input[urlOpen] === '{' ? findMatchingBrace(input, urlOpen) : -1;
                const textOpen = urlClose >= 0 ? skipHorizontalSpaces(input, urlClose + 1) : -1;
                const textClose = textOpen >= 0 && input[textOpen] === '{' ? findMatchingBrace(input, textOpen) : -1;
                if (textClose > textOpen) {
                    const inner = input.slice(textOpen + 1, textClose);
                    if (/\p{L}/u.test(inner) && !LATEX_PLACEHOLDER_PATTERN.test(inner)) {
                        const id = tokens.length + 1;
                        tokens.push({open: input.slice(index, textOpen + 1), close: '}'});
                        output += `<g${id}>${encodeInlineLatex(inner, tokens)}</g${id}>`;
                        index = textClose + 1;
                        continue;
                    }
                    addAtom(input.slice(index, textClose + 1));
                    index = textClose + 1;
                    continue;
                }
            }
            if (INLINE_FORMAT_COMMANDS.has(name)) {
                const argOpen = skipHorizontalSpaces(input, nameEnd);
                const argClose = input[argOpen] === '{' ? findMatchingBrace(input, argOpen) : -1;
                if (argClose > argOpen) {
                    const inner = input.slice(argOpen + 1, argClose);
                    if (/\p{L}/u.test(inner) && !LATEX_PLACEHOLDER_PATTERN.test(inner)) {
                        const id = tokens.length + 1;
                        tokens.push({open: input.slice(index, argOpen + 1), close: '}'});
                        output += `<g${id}>${encodeInlineLatex(inner, tokens)}</g${id}>`;
                        index = argClose + 1;
                        continue;
                    }
                    addAtom(input.slice(index, argClose + 1));
                    index = argClose + 1;
                    continue;
                }
            }
            const end = /[A-Za-z]/u.test(name)
                ? consumeCommandTail(input, nameEnd, 2)
                : name === '\\' ? consumeCommandTail(input, nameEnd, 0) : nameEnd;
            addAtom(input.slice(index, end));
            index = end;
            continue;
        }
        output += ch;
        index += 1;
    }
    return output;
}

function addLiteral(parts: LatexPart[], value: string): void {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === 'literal') {last.value += value; return;}
    parts.push({kind: 'literal', value});
}

function addLatexSegment(
    parts: LatexPart[],
    segments: LatexSegment[],
    raw: string,
    role: LatexSegment['role'],
    bilingual: 'paragraph' | 'command',
): void {
    const trimmed = raw.trim();
    if (!trimmed) {addLiteral(parts, raw); return;}
    const start = raw.length - raw.trimStart().length;
    const prefix = raw.slice(0, start);
    const suffix = raw.slice(start + trimmed.length);
    const tokens: LatexToken[] = [];
    const encoded = encodeInlineLatex(trimmed, tokens);
    const visible = encoded.replace(/<\/?g\d+\/?>/gu, '').trim();
    if (!/\p{L}/u.test(visible)) {addLiteral(parts, raw); return;}
    const useTokens = tokens.length > 0 && !LATEX_PLACEHOLDER_PATTERN.test(trimmed);
    const source = useTokens ? encoded.trim() : trimmed;
    const id = segments.length;
    segments.push({id, source, role});
    parts.push({
        kind: 'segment',
        segmentIndex: id,
        source,
        ...(source === trimmed ? {} : {rawSource: trimmed}),
        prefix,
        suffix,
        ...(useTokens ? {latexTokens: tokens} : {}),
        latexBilingual: bilingual,
    });
}

function matchBeginEnv(source: string, index: number): {env: string; tagEnd: number} | null {
    if (!source.startsWith('\\begin', index)) return null;
    const open = skipHorizontalSpaces(source, index + 6);
    if (source[open] !== '{') return null;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    const env = source.slice(open + 1, close).trim();
    const tagEnd = consumeCommandTail(source, close + 1, 1);
    return {env, tagEnd};
}

function matchEndEnv(source: string, index: number): {env: string; tagEnd: number} | null {
    if (!source.startsWith('\\end', index)) return null;
    const open = skipHorizontalSpaces(source, index + 4);
    if (source[open] !== '{') return null;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    return {env: source.slice(open + 1, close).trim(), tagEnd: close + 1};
}

function findBeginDocument(source: string): {index: number; end: number} | null {
    let cursor = 0;
    while (cursor < source.length) {
        const ch = source[cursor];
        if (ch === '%') {cursor = findCommentEnd(source, cursor); continue;}
        if (ch === '\\') {
            const env = matchBeginEnv(source, cursor);
            if (env?.env === 'document') return {index: cursor, end: env.tagEnd};
            cursor += 2;
            continue;
        }
        cursor += 1;
    }
    return null;
}

function matchTranslatableCommand(
    source: string,
    index: number,
    allowed: ReadonlySet<string>,
): {name: string; contentStart: number; contentEnd: number; commandEnd: number} | null {
    if (source[index] !== '\\') return null;
    const {name, end: nameEnd} = readCommandName(source, index);
    if (!allowed.has(name)) return null;
    let cursor = nameEnd;
    if (source[cursor] === '*') cursor += 1;
    const optStart = skipHorizontalSpaces(source, cursor);
    if (source[optStart] === '[') {
        const optEnd = findMatchingBracket(source, optStart);
        if (optEnd < 0) return null;
        cursor = optEnd + 1;
    }
    const argStart = skipHorizontalSpaces(source, cursor);
    if (source[argStart] !== '{') return null;
    const argEnd = findMatchingBrace(source, argStart);
    if (argEnd < 0) return null;
    return {name, contentStart: argStart + 1, contentEnd: argEnd, commandEnd: argEnd + 1};
}

function startsBlockConstruct(source: string, index: number): boolean {
    if (source[index] === '%' || source.startsWith('$$', index) || source.startsWith('\\[', index)) return true;
    if (matchBeginEnv(source, index) || matchEndEnv(source, index)) return true;
    if (source[index] !== '\\') return false;
    const {name} = readCommandName(source, index);
    return name === 'item' || BODY_TRANSLATABLE_COMMANDS.has(name) || BLOCK_LITERAL_COMMANDS.has(name);
}

function parsePreamble(preamble: string, parts: LatexPart[], segments: LatexSegment[]): void {
    let cursor = 0;
    const end = preamble.length;
    while (cursor < end) {
        const ch = preamble[cursor];
        if (ch === '%') {
            const commentEnd = findCommentEnd(preamble, cursor);
            addLiteral(parts, preamble.slice(cursor, commentEnd));
            cursor = commentEnd;
            continue;
        }
        if (ch === '\\') {
            const command = matchTranslatableCommand(preamble, cursor, PREAMBLE_COMMANDS);
            if (command) {
                addLiteral(parts, preamble.slice(cursor, command.contentStart));
                addLatexSegment(parts, segments, preamble.slice(command.contentStart, command.contentEnd), 'title', 'command');
                addLiteral(parts, '}');
                cursor = command.commandEnd;
                continue;
            }
            const next = Math.min(end, cursor + 2);
            addLiteral(parts, preamble.slice(cursor, next));
            cursor = next;
            continue;
        }
        const nextSlash = preamble.indexOf('\\', cursor);
        const nextPercent = preamble.indexOf('%', cursor);
        const stop = Math.min(
            end,
            nextSlash >= 0 ? nextSlash : end,
            nextPercent >= 0 ? nextPercent : end,
        );
        addLiteral(parts, preamble.slice(cursor, stop));
        cursor = stop;
    }
}

export function parseLatexDocument(content: string): {parts: LatexPart[]; segments: LatexSegment[]} {
    const parts: LatexPart[] = [];
    const segments: LatexSegment[] = [];
    const beginDoc = findBeginDocument(content);
    let cursor = 0;

    if (beginDoc) {
        parsePreamble(content.slice(0, beginDoc.index), parts, segments);
        addLiteral(parts, content.slice(beginDoc.index, beginDoc.end));
        cursor = beginDoc.end;
    }

    while (cursor < content.length) {
        const ch = content[cursor];
        if (/\s/u.test(ch)) {
            let end = cursor + 1;
            while (end < content.length && /\s/u.test(content[end])) end += 1;
            addLiteral(parts, content.slice(cursor, end));
            cursor = end;
            continue;
        }
        if (ch === '%') {
            const end = findCommentEnd(content, cursor);
            addLiteral(parts, content.slice(cursor, end));
            cursor = end;
            continue;
        }
        if (content.startsWith('$$', cursor)) {
            const close = content.indexOf('$$', cursor + 2);
            const end = close >= 0 ? close + 2 : content.length;
            addLiteral(parts, content.slice(cursor, end));
            cursor = end;
            continue;
        }
        if (content.startsWith('\\[', cursor)) {
            const end = findSequenceEnd(content, cursor + 2, '\\]');
            addLiteral(parts, content.slice(cursor, end));
            cursor = end;
            continue;
        }
        const beginEnv = matchBeginEnv(content, cursor);
        if (beginEnv) {
            if (PROTECTED_ENVS.has(beginEnv.env)) {
                const endMarker = `\\end{${beginEnv.env}}`;
                const close = content.indexOf(endMarker, beginEnv.tagEnd);
                const end = close >= 0 ? close + endMarker.length : content.length;
                addLiteral(parts, content.slice(cursor, end));
                cursor = end;
                continue;
            }
            addLiteral(parts, content.slice(cursor, beginEnv.tagEnd));
            cursor = beginEnv.tagEnd;
            continue;
        }
        const endEnv = matchEndEnv(content, cursor);
        if (endEnv) {
            if (endEnv.env === 'document') {
                addLiteral(parts, content.slice(cursor));
                break;
            }
            addLiteral(parts, content.slice(cursor, endEnv.tagEnd));
            cursor = endEnv.tagEnd;
            continue;
        }
        const command = matchTranslatableCommand(content, cursor, BODY_TRANSLATABLE_COMMANDS);
        if (command) {
            const role: LatexSegment['role'] = PREAMBLE_COMMANDS.has(command.name)
                ? 'title'
                : HEADING_COMMANDS.has(command.name) ? 'heading' : 'paragraph';
            addLiteral(parts, content.slice(cursor, command.contentStart));
            addLatexSegment(parts, segments, content.slice(command.contentStart, command.contentEnd), role, 'command');
            addLiteral(parts, '}');
            cursor = command.commandEnd;
            continue;
        }
        if (ch === '\\') {
            const {name, end: nameEnd} = readCommandName(content, cursor);
            if (name === 'item') {
                let itemEnd = nameEnd;
                const opt = skipHorizontalSpaces(content, itemEnd);
                if (content[opt] === '[') {
                    const close = findMatchingBracket(content, opt);
                    if (close >= 0) itemEnd = close + 1;
                }
                while (itemEnd < content.length && (content[itemEnd] === ' ' || content[itemEnd] === '\t')) itemEnd += 1;
                addLiteral(parts, content.slice(cursor, itemEnd));
                cursor = itemEnd;
                const paraEnd = consumeParagraphEnd(content, cursor);
                addLatexSegment(parts, segments, content.slice(cursor, paraEnd), 'list-item', 'paragraph');
                cursor = paraEnd;
                continue;
            }
            if (BLOCK_LITERAL_COMMANDS.has(name)) {
                const end = consumeCommandTail(content, nameEnd, 2);
                addLiteral(parts, content.slice(cursor, end));
                cursor = end;
                continue;
            }
        }
        const paraEnd = consumeParagraphEnd(content, cursor);
        addLatexSegment(parts, segments, content.slice(cursor, paraEnd), 'paragraph', 'paragraph');
        cursor = paraEnd;
    }

    return {parts, segments};
}

function consumeParagraphEnd(content: string, start: number): number {
    let cursor = start;
    while (cursor < content.length) {
        const ch = content[cursor];
        if (ch === '\\') {
            if (content.startsWith('\\[', cursor)) break;
            if (cursor > start && (matchBeginEnv(content, cursor) || matchEndEnv(content, cursor))) break;
            const {name, end: nameEnd} = readCommandName(content, cursor);
            if (name === 'verb') {
                cursor = consumeVerbEnd(content, nameEnd);
                continue;
            }
            cursor = Math.min(content.length, cursor + 2);
            continue;
        }
        if (ch === '$' && content[cursor + 1] === '$') break;
        if (ch === '%') {
            cursor = findCommentEnd(content, cursor);
            continue;
        }
        if (ch === '\n' || ch === '\r') {
            const nextLine = ch === '\r' && content[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
            const afterSpaces = skipHorizontalSpaces(content, nextLine);
            if (afterSpaces >= content.length || content[afterSpaces] === '\n' || content[afterSpaces] === '\r'
                || startsBlockConstruct(content, afterSpaces)) {
                return cursor;
            }
            cursor = nextLine;
            continue;
        }
        cursor += 1;
    }
    return cursor;
}

/** 折叠 LaTeX 命令参数中的空行，防止编译期出现 Paragraph ended before \@sect/\@caption 语法错误。 */
export function sanitizeLatexCommandText(value: string): string {
    return value.replace(/\r\n?/gu, '\n').replace(/\n(?:[ \t]*\n)+/gu, '\n');
}

/**
 * 校验并还原 LaTeX 片段中的编号占位符。还原 `%` 行内注释时确保其后保留换行，防止吞掉后续正文或命令闭合 `}`；
 * 若翻译服务破坏或遗漏占位符，则剥离残留占位符并把丢失的自闭合公式/引用/注释安全附在末尾。
 */
export function renderLatexTranslation(tokens: readonly LatexToken[] | undefined, translation: string): string {
    if (!tokens?.length) return translation;
    const normalized = normalizeDocumentInlineMarkers(translation);
    const pieces = normalized.split(/(<\s*\/?\s*g\s*\d+\s*\/?\s*>)/iu);
    const marker = (piece: string) => /^<\s*(\/?)\s*g\s*(\d+)\s*(\/?)\s*>$/iu.exec(piece);
    const seen = new Set<number>();
    const open: number[] = [];
    let valid = true;
    const output: string[] = [];
    let pendingCommentNewline = false;

    const pushChunk = (chunk: string, startsComment = false) => {
        if (!chunk) return;
        if (pendingCommentNewline && chunk[0] !== '\n' && chunk[0] !== '\r') output.push('\n');
        output.push(chunk);
        pendingCommentNewline = startsComment;
    };

    for (const piece of pieces) {
        const found = marker(piece);
        if (!found) {pushChunk(piece); continue;}
        const id = Number(found[2]);
        const token = tokens[id - 1];
        if (!token) {valid = false; continue;}
        if (token.close === undefined) {
            if (found[1]) continue;
            if (seen.has(id)) valid = false;
            seen.add(id);
            pushChunk(token.open, token.open.startsWith('%'));
            continue;
        }
        if (!found[1]) {
            if (seen.has(id) || found[3]) valid = false;
            seen.add(id);
            open.push(id);
            pushChunk(token.open);
            continue;
        }
        if (open.pop() !== id) valid = false;
        pushChunk(token.close);
    }

    if (pendingCommentNewline) output.push('\n');
    if (valid && !open.length && seen.size === tokens.length) return output.join('');

    const plain = pieces.filter(piece => !marker(piece)).join('').replace(/[ \t]{2,}/gu, ' ').trim();
    const kept = tokens
        .filter(token => token.close === undefined && !plain.includes(token.open.trim()))
        .map(token => {
            const raw = token.open.trim();
            return raw.startsWith('%') ? `${raw}\n` : raw;
        });
    if (!kept.length) return plain;
    return kept.reduce((result, item) => result.endsWith('\n') ? `${result}${item}` : `${result} ${item}`, plain);
}
