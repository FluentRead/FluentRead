/**
 * @file src/core/config/nativeAsr.ts
 * 文件职责：规范化本机字幕转写服务地址，提供持久化与传输共享的回环边界。
 * 主要内容：限制协议、主机、路径与长度，拒绝凭据、查询参数及控制字符。
 * 模块边界：仅处理纯配置字符串，不探测服务、不发起网络请求、不替调用方恢复无效配置。
 */
export const DEFAULT_NATIVE_ASR_BASE_URL = 'http://127.0.0.1:8000';

/** Invalid explicit input stays disabled; only the caller may apply a missing-field default. */
export function normalizeNativeAsrBaseUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 512) return '';
    const input = value.trim();
    if (!input || /[\u0000-\u0020\u007f]/u.test(input)) return '';
    try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol)
            || !['127.0.0.1', '[::1]'].includes(url.hostname)
            || url.username || url.password || url.search || url.hash
            || !['', '/', '/v1', '/v1/'].includes(url.pathname)) return '';
        return url.origin;
    } catch {
        return '';
    }
}
