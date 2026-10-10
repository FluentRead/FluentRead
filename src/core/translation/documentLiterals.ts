/**
 * @file src/core/translation/documentLiterals.ts
 * 文件职责：识别文档正文中需要逐字保留的地址、代码式名称与组合模型名，防止机器翻译改写这些字面值。
 * 主要内容：线性扫描 URL、邮箱、CamelCase 名称及 GNMT+RL 一类标识，去重后交给现有术语占位符链原位保护；不推断领域术语的中文译名。
 * 模块边界：纯文本规则，不读取配置或调用翻译；调用方只在文档入口启用，用户词库仍按既有规则优先匹配。
 */
import {findGlossaryMatches} from '@/src/core/glossary';

export function findDocumentLiteralTerms(origin: string | readonly string[], userEntries: readonly {source: string; target: string; caseSensitive: boolean}[] = []): Array<{source: string; target: string; caseSensitive: true}> {
    const texts = typeof origin === 'string' ? [origin] : origin;
    const values = new Set<string>();
    const entries = userEntries.map(entry => ({...entry, source: entry.source.normalize('NFC')}));
    const pattern = /https?:\/\/[^\s<>"'`，。、；：！？（）【】《》「」“”‘’]+|(?<![\p{L}\p{N}_])[\w.+-]{1,64}@(?:[\w-]{1,63}\.){1,10}[A-Za-z]{2,63}(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*(?:\+[A-Z][A-Z0-9]*)+)(?![\p{L}\p{N}_])/gu;
    for (const text of texts) {
        const normalized = text.normalize('NFC');
        const occupied = entries.length ? findGlossaryMatches(normalized, entries) : [];
        const conflicts = new Map<string, boolean>();
        for (const match of text.matchAll(pattern)) {
            const source = match[0].replace(/[.,;!?，。；！？]+$/u, '');
            if (occupied.length) {
                const key = source.normalize('NFC');
                if (!conflicts.has(key)) conflicts.set(key, findGlossaryMatches(normalized, [{source: key, target: source, caseSensitive: true}])
                    .some(range => occupied.some(user => range.start < user.end && user.start < range.end)));
                // 自动长标识不能占走用户指定的短词；比较用 NFC，实际 URL/名称的拼写原样保留。
                if (conflicts.get(key)) continue;
            }
            values.add(source);
        }
    }
    return [...values].map(source => ({source, target: source, caseSensitive: true}));
}
