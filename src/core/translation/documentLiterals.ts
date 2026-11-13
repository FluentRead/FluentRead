/**
 * @file src/core/translation/documentLiterals.ts
 * 文件职责：识别文档正文中需要逐字保留的地址、行内语法、数学符号、代码式名称与组合模型名，防止机器翻译改写这些字面值。
 * 主要内容：扫描带引号属性的 HTML 标签、√ASCII、希腊字母接 ASCII 与 Unicode 数学样式标识、数学区间、数字上下标字面值、非 ASCII 数学运算符及其变体选择符、URL、邮箱、CamelCase 名称和 GNMT+RL 组合名，去重后交给现有术语占位符链；数学标识整词保留原码点，不截取普通文字中的半个标识；内部 g 标签原样送翻并独立验证结构，正文仍翻译，不推断领域术语的中文译名。
 * 模块边界：纯文本规则，不读取配置或调用翻译；调用方只在文档入口启用，语法标签不让给短词，其他字面值仍按既有用户词库规则优先匹配。
 */
import {findGlossaryMatches} from '@/src/core/glossary';

// 整词分支已限定字母/数字/组合标记；Letterlike Symbols 再要求 Math 属性，不把温度/电话符号当变量。
const mathGlyph = /[\u{1D400}-\u{1D7FF}]|(?=\p{Math})[\u2100-\u214F]/u;
const mathIdentifier = /^(?:[A-Za-z0-9_\p{Script=Greek}\p{M}\u{1D400}-\u{1D7FF}]|(?!\p{Script=Greek})(?=\p{Math})[\u2100-\u214F])+$/u;

export function findDocumentLiteralTerms(origin: string | readonly string[], userEntries: readonly {source: string; target: string; caseSensitive: boolean}[] = []): Array<{source: string; target: string; caseSensitive: true}> {
    const texts = typeof origin === 'string' ? [origin] : origin;
    const values = new Map<string, {source: string; target: string; caseSensitive: true}>();
    const entries = userEntries.map(entry => ({...entry, source: entry.source.normalize('NFC')}));
    // 标签分支的三种字符互斥；引号中的 > 不结束标签，也不把标签内部的名称/地址单独保护。
    const pattern = /<\/?[A-Za-z][\w:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|√[A-Za-z][A-Za-z0-9_]*|(?<![\p{L}\p{N}_])\p{Script=Greek}[A-Za-z][A-Za-z0-9_]*(?![\p{L}\p{N}_])|https?:\/\/[^\s<>"'`，。、；：！？（）【】《》「」“”‘’]+|(?<![\p{L}\p{N}_])[\w.+-]{1,64}@(?:[\w-]{1,63}\.){1,10}[A-Za-z]{2,63}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*(?:\s*\+\s*[A-Z][A-Z0-9]*)+)(?![\p{L}\p{N}_])|(?![\x00-\x7F])\p{Sm}\p{Variation_Selector}?|(?<script>(?<![\p{L}\p{N}_])(?:\d{1,32}(?:\.\d{1,16})?|[A-Za-z\p{Script=Greek}])[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋]{1,12}(?![\p{L}\p{N}_])|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋]{1,12})|(?<word>(?:(?!https?:\/\/|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋])[\p{L}\p{N}\p{M}_])+)/gu;
    const intervals = /(?<interval>[\[(][ \t]*[-+]?[\p{L}\p{N}\p{M}_.∞]{1,32}[ \t]*,[ \t]*[-+]?[\p{L}\p{N}\p{M}_.∞]{1,32}[ \t]*[\])])/gu;
    for (const text of texts) {
        const normalized = text.normalize('NFC');
        const occupied = entries.length ? findGlossaryMatches(normalized, entries) : [];
        const conflicts = new Map<string, boolean>();
        // 单独扫描区间：不符合数学端点的词对仍走原扫描；用户覆盖其中一个变量时，其余变量仍能自动保护。
        for (const match of [...text.matchAll(intervals), ...text.matchAll(pattern)]) {
            const source = match[0].replace(/[.,;!?，。；！？]+$/u, '');
            const word = match.groups!.word;
            const interval = match.groups!.interval;
            if (interval && !source.slice(1, -1).split(',').every(part => {
                const endpoint = part.trim().replace(/^[+-]/u, '');
                return /^(?:\d+(?:\.\d+)?|∞|[A-Za-z_\p{Script=Greek}])$/u.test(endpoint)
                    || (mathGlyph.test(endpoint) && mathIdentifier.test(endpoint));
            })) continue;
            // 整词分支一次消费候选，但在 URL scheme 前停下保留旧扫描契约；不保护因此切开的半个数学标识。
            if (word && (!mathGlyph.test(source) || !mathIdentifier.test(source)
                || text.startsWith('http', match.index + match[0].length))) continue;
            if (/^<\/?g[1-9]\d*\/?\s*>$/u.test(source)) continue;
            if (occupied.length && !source.startsWith('<')) {
                const key = source.normalize('NFC');
                if (!conflicts.has(key)) conflicts.set(key, findGlossaryMatches(normalized, [{source: key, target: source, caseSensitive: true}])
                    .some(range => occupied.some(user => range.start < user.end && user.start < range.end)));
                // 自动长标识不能占走用户指定的短词；比较用 NFC，实际 URL/名称的拼写原样保留。
                if (conflicts.get(key)) continue;
            }
            // 数学标识的 NFC 只用于匹配；空译法让保护链回填每次原文，NFD/NFC 并存也不改码点。
            const key = word || interval ? source.normalize('NFC') : source;
            values.set(key, {source: key, target: word || interval ? '' : source, caseSensitive: true});
        }
    }
    return [...values.values()];
}
