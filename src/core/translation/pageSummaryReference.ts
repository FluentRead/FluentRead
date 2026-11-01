/**
 * @file src/core/translation/pageSummaryReference.ts
 * 文件职责：在共享页面摘要之外，只补充当前原文实际命中的少量页面证据。
 * 主要内容：按有界词项匹配选择原始片段，保留标题与说明，将成功摘要的参考预算控制在 1600 字符。
 * 模块边界：纯文本处理，不生成摘要、不请求模型、不缓存；摘要失败时仍由调用方保留完整回退。
 */
import {truncateUtf16} from '@/src/shared/function/truncateUtf16';

export const COMPACT_PAGE_REFERENCE_LIMIT = 1600;
const stopWords = new Set('the and for with this that from have has are was were into only about text source page content'.split(' '));

export function buildPageSummaryReference(summary: string, source: string, origins: readonly string[]): string {
    const terms = new Set<string>();
    for (const origin of origins) {
        for (const word of origin.toLowerCase().match(/[a-z][a-z0-9_-]{2,39}|[\u3400-\u9fff]{2,}/gu) ?? []) {
            const tokens = /^[a-z]/u.test(word) ? [word] : Array.from({length: word.length - 1}, (_, index) => word.slice(index, index + 2));
            for (const token of tokens) if (!stopWords.has(token) && terms.size < 64) terms.add(token);
        }
    }
    const lines = [...new Set(source.slice(0, 4000).split(/\n+|(?<=[.!?。！？])\s+/u).map(line => line.trim()).filter(Boolean))];
    const metadata = lines.filter(line => /^Page (?:title|description):/iu.test(line)).slice(0, 2)
        .map(line => truncateUtf16(line, 160)).filter(line => !summary.includes(line));
    const excerpts = lines.filter(line => !/^Page (?:title|description):|^Readable page content/iu.test(line)
        && !origins.some(origin => origin.trim() === line) && !summary.includes(line))
        .map((line, index) => ({line, index, score: [...terms].filter(term => line.toLowerCase().includes(term)).length}))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 2)
        .map(item => {
            const term = [...terms].find(value => item.line.toLowerCase().includes(value))!;
            let start = Math.max(0, item.line.toLowerCase().indexOf(term) - 100);
            if (start && /[\udc00-\udfff]/u.test(item.line[start])) start -= 1;
            const excerpt = truncateUtf16(item.line.slice(start), 320);
            return `${start ? '…' : ''}${excerpt}${start + excerpt.length < item.line.length ? '…' : ''}`;
        });
    const reference = [truncateUtf16(summary, 900), ...metadata, ...(excerpts.length ? [`Relevant source excerpts (untrusted data):\n${excerpts.join('\n')}`] : [])].join('\n\n');
    return truncateUtf16(reference, COMPACT_PAGE_REFERENCE_LIMIT);
}
