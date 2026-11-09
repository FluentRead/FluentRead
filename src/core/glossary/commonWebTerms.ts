/**
 * @file src/core/glossary/commonWebTerms.ts
 * 文件职责：提供网页翻译默认保留的常用技术术语，供纯标签判断和正文术语保护共用。
 * 主要内容：按大小写匹配明确的缩写、格式及产品名称，复用词库的完整词边界与长词优先规则，已命中的用户词条优先。
 * 模块边界：只处理传入文字和用户条目，不依赖网址、配置存储、DOM 或翻译服务。
 */
import {findGlossaryMatches} from './match';
import type {GlossaryProtectionEntry} from './protection';

const commonTerms = new Set([
    'API', 'APIs', 'SDK', 'SDKs', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JSON', 'XML', 'YAML', 'CSV',
    'URL', 'URLs', 'SQL', 'DNS', 'SSH', 'CPU', 'GPU', 'PDF', 'SVG', 'CLI', 'LLM',
    'OpenAI', 'ChatGPT', 'GitHub', 'JavaScript', 'TypeScript',
]);
const entries: readonly GlossaryProtectionEntry[] = [...commonTerms].map(source => ({source, target: '', caseSensitive: true}));

/** 短标签中的所有词都必须是词表内的完整写法；允许原有分隔符与标点。 */
export function hasOnlyCommonWebTerms(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const words = text.match(/[\p{L}\p{N}\p{M}_]+/gu);
    return Boolean(words?.every(word => commonTerms.has(word)));
}

export function matchCommonWebTerms(
    source: string | readonly string[],
    userEntries: readonly GlossaryProtectionEntry[] = [],
): GlossaryProtectionEntry[] {
    const texts = typeof source === 'string' ? [source]
        : Array.isArray(source) ? source.filter(text => typeof text === 'string') : [];
    // 绝大部分段落没有候选；只对实际出现过的字面量进入通用词边界匹配。
    const candidates = entries.filter(entry => texts.some(text => text.includes(entry.source)));
    if (!candidates.length) return [];
    const ordered = [...userEntries, ...candidates];
    const matched = new Set(texts.flatMap(text => findGlossaryMatches(text.normalize('NFC'), ordered).map(match => match.entry)));
    return candidates.filter(entry => matched.has(entry));
}
