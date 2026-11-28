/**
 * @file src/shared/text/htmlEntities.ts
 * 文件职责：以纯文本解码 HTML 字符引用，并保留 textarea 片段解析的兼容语义。
 * 主要内容：使用完整 HTML 字符引用表，并复现 textarea 片段解析与 value 的换行、空字符规范化。
 * 模块边界：只解码文本，不解析输入为标签、不加载资源，也不替代既有无 DOM 环境的降级规则。
 */
import {decodeHTML} from 'entities/lib/decode.js';

/** 按 textarea.innerHTML 后读取 value 的文本语义执行一次 HTML 字符引用解码。 */
export function decodeTextareaHtml(value: string, ownerDocument?: Document): string {
    let input = value.replace(/\r\n?/gu, '\n');
    if (/(<(?:\/[A-Za-z]*)?)\0/u.test(input)) {
        // Firefox 会忽略 RCDATA 小于号／结束标签状态中的 NUL，Chromium 会将它替换为 U+FFFD。
        // 特性探针只解析固定常量，不能把用户输入交给 HTML 解析器。
        const doc = ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
        if (doc && typeof doc.createElement === 'function') {
            const probe = doc.createElement('textarea');
            probe.innerHTML = '<\0';
            if (probe.value === '<�') input = input.replace(/(<(?:\/[A-Za-z]*)?)\0/gu, '$1�');
        }
    }
    // 原始 NUL 必须在实体扫描之后丢弃：删除得过早会把 &am\0p; 意外拼成 &amp;。
    // 数字实体 &#0; 则由 HTML 解码规则替换为 U+FFFD，不会被此处的 NUL 清理删除。
    return decodeHTML(input).replace(/\0/gu, '').replace(/\r\n?/gu, '\n');
}
