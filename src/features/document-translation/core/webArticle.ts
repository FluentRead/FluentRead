/**
 * @file src/features/document-translation/core/webArticle.ts
 * 文件职责：维护文档工作台中已保存的网页正文的读取契约。
 * 主要内容：定义历史正文的路由参数与内容身份，校验来源链接与续读位置。
 * 模块边界：仅处理值，不读取 DOM 或标签页，不访问网络，不写入历史。
 */
export const WEB_ARTICLE_PARAMETER = 'article';

export function normalizeWebArticleUrl(value: unknown, base?: string): string | null {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
    try {
        const url = new URL(value, base);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
            ? url.href : null;
    } catch {
        return null;
    }
}

/** 相同转载内容在不同网址各自保存原文链接及阅读位置。 */
export function webArticleIdentityBytes(sourceUrl: string, html: Uint8Array): Uint8Array {
    const prefix = new TextEncoder().encode(`fluentread:web-article\0${sourceUrl}\0`);
    const identity = new Uint8Array(prefix.length + html.length);
    identity.set(prefix);
    identity.set(html, prefix.length);
    return identity;
}

export function normalizeWebArticleProgress(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
