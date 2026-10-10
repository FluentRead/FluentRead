/**
 * @file src/features/video-subtitle/content/subtitleLayout.ts
 * 文件职责：在有限画面内适配用户选择的大字号，避免双语长字幕被高度裁剪。
 * 主要内容：先应用请求字号，仅在溢出时检查下界并进行最多八轮二分，接近可容纳的最大字号；换句或画面扩大时从用户字号重新计算，不修改已保存偏好。
 * 模块边界：只调用注入的字体应用与测量函数，不读取配置、播放器或浏览器全局对象。
 */
export function fitVideoSubtitleFontSize(requested: number, maximumHeight: number,
    apply: (fontSize: number) => void, measure: () => number): number {
    let size = Number.isFinite(requested) && requested > 0 ? requested : 16;
    apply(size);
    if (!Number.isFinite(maximumHeight) || maximumHeight <= 0) return size;
    const initialHeight = measure();
    if (!Number.isFinite(initialHeight) || initialHeight <= maximumHeight || size <= 8) return size;
    let lower = 8, upper = size;
    apply(lower);
    const minimumHeight = measure();
    // 测量失效时还原偏好；下界仍溢出时保留最低字号，不伪造可容纳结果。
    if (!Number.isFinite(minimumHeight)) { apply(size); return size; }
    if (minimumHeight > maximumHeight) return lower;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        size = (lower + upper) / 2;
        apply(size);
        const height = measure();
        if (!Number.isFinite(height)) { apply(lower); return lower; }
        if (height <= maximumHeight) lower = size;
        else upper = size;
    }
    size = Math.floor(lower * 100) / 100;
    apply(size);
    return size;
}
