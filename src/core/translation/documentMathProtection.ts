/**
 * @file src/core/translation/documentMathProtection.ts
 * 文件职责：将文档中相邻的自动数学字面值保护为一个有限表达式，降低免费翻译请求的占位符密度。
 * 主要内容：复用术语保护首次接受的范围与条目身份，仅跨有限数学连接字符合并；保留用户词条、正文、引号、格式标签、规范化及槽边界，限制表达式长度与词条数量；先验证代表标记，再展开原标记并执行原有严格恢复。
 * 模块边界：纯文本转换，不读取配置、不猜译法、不调用服务；仅由文档请求编排显式传入自动条目，网页术语保护不启用本规则。
 */
import {protectGlossaryText, validateGlossaryProtectedTokens, type GlossaryProtectedMatch, type GlossaryProtectionEntry} from '@/src/core/glossary';

const marker = /__FRTERM_[a-z0-9_]+?__/giu;
const gap = /^[ \t\u00a0\u2009\u202f()[\]{},′″=+*/^\-]*$/u;
const maxGap = 16, maxTokens = 16, maxOriginalChars = 192;

function isAutomaticMathLiteral(entry: GlossaryProtectionEntry): boolean {
    const source = entry.source;
    const operator = /^(?![\x00-\x7F])\p{Sm}\p{Variation_Selector}?$/u;
    const glyph = /[\u{1D400}-\u{1D7FF}]|(?=\p{Math})[\u2100-\u214F]/u;
    const identifier = /^(?:[\p{Script=Greek}\p{M}\u{1D400}-\u{1D7FF}0-9_]|(?!\p{Script=Greek})(?=\p{Math})[\u2100-\u214F])+$/u;
    return operator.test(source) || glyph.test(source) && identifier.test(source)
        || /^(?:\d{1,32}(?:\.\d{1,16})?|[A-Za-z\p{Script=Greek}])?[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋]{1,12}$/u.test(source)
        || /^√[A-Za-z][A-Za-z0-9_]*$/u.test(source)
        || /^[\[(][ \t]*[-+]?[\p{L}\p{N}\p{M}_.∞]{1,32}[ \t]*,[ \t]*[-+]?[\p{L}\p{N}\p{M}_.∞]{1,32}[ \t]*[\])]$/u.test(source);
}

/** 只跟踪组内 gap 的括号；已经保护的半开区间是原子，不能留下虚假的待闭合括号。 */
function advanceGroupBrackets(between: string, stack: string[]): boolean {
    for (const character of between) {
        if ('([{'.includes(character)) stack.push(character);
        else if (')]}'.includes(character)) {
            if ('([{'.indexOf(stack.at(-1)!) !== ')]}'.indexOf(character)) return false;
            stack.pop();
        }
    }
    return true;
}

/** 只吸收 Unicode prime，以及组内已经打开的匹配尾括号；ASCII 引号始终留在送翻正文中。 */
function groupEnd(text: string, end: number, value: string, stack: string[]): number | null {
    const originalDepth = stack.length;
    let suffix = '';
    while (end + suffix.length < text.length && suffix.length < 4) {
        const character = text[end + suffix.length]!;
        if (/[′″‴]/u.test(character)) suffix += character;
        else if (')]}'.includes(character) && stack.length && '([{'.indexOf(stack.at(-1)!) === ')]}'.indexOf(character)) {
            stack.pop(); suffix += character;
        } else break;
    }
    if (value.length + suffix.length > maxOriginalChars) return originalDepth ? null : end;
    return stack.length ? null : end + suffix.length;
}

export function protectDocumentMathText(original: string, entries: readonly GlossaryProtectionEntry[],
    automaticEntries: readonly GlossaryProtectionEntry[], namespace = '0', excludedRanges: readonly {start: number; end: number}[] = []) {
    const automaticMath = new Set(automaticEntries.filter(isAutomaticMathLiteral));
    // 这些边界由旧保护链处理，不能利用规范化、槽拆分或用户原有标记重建数学分组。
    if (!automaticMath.size || original.normalize('NFC') !== original
        || /___FLUENTREAD_[a-z0-9_-]+?_\d+_(?:BEGIN|END)___/iu.test(original)
        || /__FRTERM_[a-z0-9_]+?__/iu.test(original)) return protectGlossaryText(original, entries, namespace, excludedRanges);
    const matches: GlossaryProtectedMatch[] = [];
    const packet = protectGlossaryText(original, entries, namespace, excludedRanges, match => {matches.push(match);});
    const groups = new Map<string, string>(), tokens: string[] = [], output: string[] = [];
    let cursor = 0, index = 0;
    while (index < matches.length) {
        const first = matches[index]!;
        tokens.push(first.token);
        if (!automaticMath.has(first.entry)) {index++; continue;}
        let last = index, value = first.value;
        let brackets: string[] = [];
        while (last + 1 < matches.length && last - index + 1 < maxTokens) {
            const next = matches[last + 1]!;
            const between = packet.text.slice(matches[last]!.end, next.start);
            if (!automaticMath.has(next.entry) || between.length > maxGap || !gap.test(between)
                || value.length + between.length + next.value.length > maxOriginalChars) break;
            const nextBrackets = [...brackets];
            if (!advanceGroupBrackets(between, nextBrackets)) break;
            value += between + next.value;
            brackets = nextBrackets;
            last++;
        }
        if (last > index) {
            const end = groupEnd(packet.text, matches[last]!.end, value, brackets);
            // 预算或正文边界不能把开括号藏进代表标记、闭括号留给服务；整包保守沿用原保护。
            if (end === null) return packet;
            output.push(packet.text.slice(cursor, first.start), first.token);
            groups.set(first.token, packet.text.slice(first.start, end));
            cursor = end;
        }
        index = last + 1;
    }
    if (!groups.size) return packet;
    output.push(packet.text.slice(cursor));
    const text = output.join('');
    return {text, tokens, restore(translated: unknown): string {
        validateGlossaryProtectedTokens(text, translated, tokens);
        const expanded = (translated as string).replace(marker, token => groups.get(token) ?? token);
        return packet.restore(expanded);
    }};
}
