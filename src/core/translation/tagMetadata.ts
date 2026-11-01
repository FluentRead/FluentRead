/**
 * @file src/core/translation/tagMetadata.ts
 * 文件职责：识别网站明确标记的话题标签，作为全文、悬浮和文本快照共用的原文保护边界。
 * 主要内容：匹配标准 rel=tag 链接、Discourse 标签及常见博客和问答标签链接；只核对完整类名与链接语义，不按正文词汇或 URL 片段猜测标签。
 * 模块边界：仅同步读取传入元素，不搜索整页、不缓存可变 DOM、不访问配置或站点目录，也不修改宿主节点。
 */
const tagMetadataSelector = [
    '.discourse-tags',
    '.discourse-tag',
    'a[href][rel~="tag" i]',
    'a[href].post-tag',
    'a[href].s-tag',
    'a[href].tag',
    ':is(.post-tags, .entry-tags, .tag-list, .tags) > a[href]',
    ':is(.post-tags, .entry-tags, .tag-list, .tags) > li > a[href]',
].join(',');

/** 只识别当前元素；后代和开放 ShadowRoot 的继承由现有 composed-tree 守卫负责。 */
export function isTagMetadataElement(element: Element): boolean {
    return element.matches(tagMetadataSelector);
}
