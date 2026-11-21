/**
 * @file src/features/image-translation/resultReadiness.ts
 * 文件职责：校验普通图片在可选文字分割资源就绪后可重试的结果标记。
 * 主要内容：有未绘制译文的原图保留结果，或有可读译文的临时 PNG 结果，才可携带此标记。
 * 模块边界：只核对消息数据，不探测模型、不调度重试，也不解析 PNG 或漫画图块。
 */

interface RetryableImageResult {
    retryWhenSegmentationReady?: unknown;
    image?: unknown;
    imageUnchanged?: unknown;
    mangaPatches?: unknown;
    lines?: unknown;
}

export function canRetryImageAfterSegmentationImport(
    result: RetryableImageResult | undefined, unchanged: boolean, manga: boolean,
): boolean {
    if (manga || result?.retryWhenSegmentationReady !== true || result.mangaPatches !== undefined || !Array.isArray(result.lines)) {
        return false;
    }
    if (unchanged) return result.lines.some(line => line && typeof line === 'object' && line.renderSkipped === true);
    if (result.imageUnchanged !== undefined || typeof result.image !== 'string' || !result.image.startsWith('data:image/png;base64,')) {
        return false;
    }
    return result.lines.some(line => line && typeof line === 'object' && typeof line.text === 'string' && line.text.trim().length > 0);
}
