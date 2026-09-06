/**
 * @file src/features/writing-assistant/markdown.ts
 * 文件职责：把写作草稿的安全 Markdown 转成 Gmail 可直接插入或复制的可读纯文本。
 * 主要内容：复用阅读回答的块与行内解析，保留段落、列表编号、代码和表格单元格；链接保留文字与地址，图片只保留说明与地址。
 * 模块边界：仅转换字符串，不操作 DOM、不生成 HTML、不访问链接；沿用安全 Markdown 子集，不扩展共享预览解析器。
 */
import {readingAnswerBlocks, readingAnswerSpans} from '@/src/features/reading-assistant/public';

// 先保护代码、转义字符和链接地址，防止把 URL 中的下划线等内容当作强调语法。
const inlineLiteral = /\\([\\`*{}\[\]()#+.!_>~-])|`([^`\n]+)`|!?\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\n]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu;
const unescapePunctuation = (text: string) => text.replace(/\\([\\`*{}\[\]()#+.!_>~-])/gu, '$1');
const plainSpans = (text: string) => readingAnswerSpans(text).map(span => span.text).join('');

function plainInline(text: string): string {
    const literals: string[] = [];
    let marker = '\uE000';
    while (text.includes(marker)) marker += '\uE000';
    // 不含输入字符的占位符让外层强调仍可成对解析，恢复时不会误替换用户原文。
    const protectedText = text.replace(inlineLiteral, (_match, escaped: string | undefined, code: string | undefined, label: string, destination: string) => {
        let literal: string;
        if (escaped !== undefined) literal = escaped;
        else if (code !== undefined) literal = code;
        else {
            const title = plainInline(label);
            const url = unescapePunctuation(destination.startsWith('<') ? destination.slice(1, -1) : destination);
            literal = title && url && title !== url ? `${title} (${url})` : title || url;
        }
        const placeholder = `${marker}${literals.length}${marker}`;
        literals.push(literal);
        return placeholder;
    });
    return plainSpans(protectedText).replace(new RegExp(`${marker}(\\d+)${marker}`, 'gu'), (_match, index: string) => literals[Number(index)]);
}

/** 代码原样保留，普通块移除显示标记；表格用制表符分列，链接地址始终只是文本。 */
export function writingPlainText(markdown: string): string {
    return readingAnswerBlocks(markdown).map(block => {
        if (block.kind === 'code') return block.text;
        if (block.kind === 'list') return block.items.map((item, index) => (
            `${block.ordered ? `${block.start + index}.` : '•'} ${plainInline(item)}`
        )).join('\n');
        if (block.kind === 'table') return [block.headers, ...block.rows].map(row => row.map(plainInline).join('\t')).join('\n');
        return plainInline(block.text);
    }).filter(text => text !== '').join('\n\n');
}
