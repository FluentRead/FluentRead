/**
 * @file src/core/translation/emojiLiterals.ts
 * 文件职责：识别翻译正文中必须逐字保留的完整 emoji 字素范围。
 * 主要内容：普通文字快速跳过，单码点 emoji 直接返回范围；首次遇到复杂图形字素时才构造分段器，同次扫描复用 Intl.Segmenter 边界保留肤色、ZWJ、旗帜、键帽和变体选择符，旧环境使用相同 emoji 结构的 Unicode 后备扫描；分离段首段尾位置明确的完整 emoji 与间距，供翻译边界本地保留。
 * 模块边界：纯文本范围算法，偏移使用原文 UTF-16，不改写 Unicode、不访问配置或服务；保护与供应商预算由调用方处理。
 */

export interface EmojiLiteralRange {readonly start: number; readonly end: number}

const emojiSignal = /[\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*0-9][\uFE0E\uFE0F]?\u20E3/u;
const emojiAtom = '(?:\\p{Regional_Indicator}{1,2}|[#*0-9][\\uFE0E\\uFE0F]?\\u20E3|\\p{Extended_Pictographic})';
const emojiExtension = '[\\p{Grapheme_Extend}\\p{Spacing_Mark}\\p{Emoji_Modifier}]*';
// Unicode 16 Grapheme_Cluster_Break=Prepend；这些前置字形与后面的 emoji 属于同一字素。
// https://www.unicode.org/Public/16.0.0/ucd/auxiliary/GraphemeBreakProperty.txt
const prepend = '[\\u0600-\\u0605\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u0D4E\\u{110BD}\\u{110CD}\\u{111C2}-\\u{111C3}\\u{113D1}\\u{1193F}\\u{11941}\\u{11A3A}\\u{11A84}-\\u{11A89}\\u{11D46}\\u{11F02}]*';
const fallbackPattern = new RegExp(`${prepend}${emojiAtom}${emojiExtension}(?:\\u200D${emojiAtom}${emojiExtension})*(?:\\u200D${emojiExtension})*`, 'gu');
const prependCharacter = new RegExp(`^(?:${prepend})$`, 'u');
const extending = (value: string) => /[\p{Grapheme_Extend}\p{Emoji_Modifier}]/u.test(value);

/** 候选扫描可包含多个相邻字素；按 GB9/9a/9b、GB11、GB12/13 分开，避免后备模式把旗帜+ZWJ等误并成超大原子。 */
function fallbackRanges(value: string): EmojiLiteralRange[] {
    const points = Array.from(value), ranges: EmojiLiteralRange[] = [];
    let start = 0, offset = points[0]!.length, regionalRun = /\p{Regional_Indicator}/u.test(points[0]!) ? 1 : 0;
    for (let index = 1; index < points.length; index++) {
        const current = points[index]!, previous = points[index - 1]!;
        let linkedPicture = false;
        if (previous === '\u200d' && /\p{Extended_Pictographic}/u.test(current)) {
            let lookBehind = index - 2;
            while (lookBehind >= 0 && extending(points[lookBehind]!)) lookBehind--;
            linkedPicture = lookBehind >= 0 && /\p{Extended_Pictographic}/u.test(points[lookBehind]!);
        }
        const regional = /\p{Regional_Indicator}/u.test(current);
        const attached = extending(current) || /\p{Spacing_Mark}/u.test(current) || current === '\u200d'
            || prependCharacter.test(previous) || linkedPicture || regional && regionalRun % 2 === 1;
        if (!attached) {ranges.push({start, end: offset});start = offset;}
        regionalRun = regional ? regionalRun + 1 : 0;
        offset += current.length;
    }
    ranges.push({start, end: offset});
    return ranges;
}

/** 原文范围不进行 NFC/NFKC 规范化，保护后必须恢复完全相同的字符序列。 */
export function findEmojiLiteralRanges(text: string): EmojiLiteralRange[] {
    if (!emojiSignal.test(text)) return [];
    const result: EmojiLiteralRange[] = [];
    let segmenter: Intl.Segmenter | undefined;
    // 先扫描可能含 emoji 的局部范围，避免原生分段器为长正文每个字符反复处理整篇字符串。
    // 单码点原子已是完整字素；复杂候选再由原生边界核对，旧环境沿完整后备范围处理。
    for (const match of text.matchAll(fallbackPattern)) {
        if (match[0].length === String.fromCodePoint(match[0].codePointAt(0)!).length) {
            result.push({start: match.index, end: match.index + match[0].length});
            continue;
        }
        if (typeof Intl.Segmenter === 'function') segmenter ??= new Intl.Segmenter(undefined, {granularity: 'grapheme'});
        const ranges = segmenter ? Array.from(segmenter.segment(match[0]), ({segment, index}) => ({start: index, end: index + segment.length}))
            : fallbackRanges(match[0]);
        for (const range of ranges) {
            if (emojiSignal.test(match[0].slice(range.start, range.end))) result.push({start: match.index + range.start, end: match.index + range.end});
        }
    }
    return result;
}

/** 缓存只隔离实际含受保护字素的输入；普通正文的身份保持原样。 */
export function hasEmojiLiterals(text: string | readonly string[]): boolean {
    return typeof text === 'string' ? emojiSignal.test(text)
        : Array.isArray(text) && text.some(value => typeof value === 'string' && emojiSignal.test(value));
}

/** 两端图形字素由本地原位保留；正文中的 emoji、多行及没有文字的标签仍沿用原协议。 */
export function splitBoundaryEmojiLiterals(text: string, ranges = findEmojiLiteralRanges(text)) {
    const unchanged = {text, prefix: '', suffix: ''};
    if (!ranges.length || /[\r\n]/u.test(text)) return unchanged;
    let start = 0, end = text.length;
    for (const range of ranges) {
        if (text.slice(start, range.start).trim()) break;
        start = range.end;
    }
    for (let index = ranges.length - 1; index >= 0; index--) {
        const range = ranges[index]!;
        if (range.start < start || text.slice(range.end, end).trim()) break;
        end = range.start;
    }
    if ((!start && end === text.length) || !/\p{L}/u.test(text.slice(start, end))) return unchanged;
    if (start) start += text.slice(start, end).match(/^\s*/u)![0].length;
    if (end < text.length) end -= text.slice(start, end).match(/\s*$/u)![0].length;
    return {text: text.slice(start, end), prefix: text.slice(0, start), suffix: text.slice(end)};
}
