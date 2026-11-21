/**
 * @file src/features/document-translation/core/webArticle.ts
 * 文件职责：定义导入文档工作台的网页正文快照格式与链接边界。
 * 主要内容：约束快照大小和标题长度，识别能够在正常网页打开的 HTTP(S) 链接；为网页正文计算独立的内容身份并校验续读位置。
 * 模块边界：仅处理值，不读取 DOM 或标签页，不访问网络，不写入历史。
 */
export interface WebArticleSnapshot {
    title: string;
    sourceUrl: string;
    html: string;
}

export const MAX_WEB_ARTICLE_BYTES = 512 * 1024;
export const MAX_WEB_ARTICLE_TITLE_LENGTH = 512;
export const WEB_ARTICLE_PARAMETER = 'article';
export type WebArticleOpenStatus = 'opened' | 'no-article' | 'too-large' | 'unavailable';

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

export function readWebArticleSnapshot(value: unknown, expectedUrl: string): WebArticleSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const {title, sourceUrl, html} = value as Partial<WebArticleSnapshot>;
    if (sourceUrl !== expectedUrl || normalizeWebArticleUrl(sourceUrl) !== sourceUrl ||
        typeof title !== 'string' || title.length > MAX_WEB_ARTICLE_TITLE_LENGTH ||
        typeof html !== 'string' || !html.trim() || html.length > MAX_WEB_ARTICLE_BYTES ||
        new TextEncoder().encode(html).byteLength > MAX_WEB_ARTICLE_BYTES) return null;
    return {title, sourceUrl, html};
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
