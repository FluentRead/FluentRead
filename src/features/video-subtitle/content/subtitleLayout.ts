/**
 * @file src/features/video-subtitle/content/subtitleLayout.ts
 * 文件职责：在有限画面内计算字幕可用区域，并适配用户选择的大字号。
 * 主要内容：移动控件避让只按已知控件矩形切分和合并候选，保留最多八个可读宽度的空区；既有字号适配保持最多八轮二分，不修改已保存偏好。
 * 模块边界：只处理几何或调用注入的字体测量函数，不读取配置、播放器或浏览器全局对象。
 */
export type VideoSubtitleRect = {left: number; top: number; width: number; height: number};

export function videoSubtitleRectsOverlap(a: VideoSubtitleRect, b: VideoSubtitleRect): boolean {
    return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

/** 已知少量控件的空区候选；外缘留 6px、控件留 4px，避免用整行上推撞上另一组控件。 */
export function getVideoSubtitleFreeRegions(viewport: VideoSubtitleRect, obstacles: readonly VideoSubtitleRect[]): VideoSubtitleRect[] {
    let regions = [{left: viewport.left + 6, top: viewport.top + 6, width: Math.max(0, viewport.width - 12), height: Math.max(0, viewport.height - 12)}];
    for (const obstacle of obstacles.slice(0, 16)) {
        const block = {left: obstacle.left - 4, top: obstacle.top - 4, width: obstacle.width + 8, height: obstacle.height + 8};
        regions = regions.flatMap(area => {
            if (!videoSubtitleRectsOverlap(area, block)) return [area];
            return [
                {...area, height: block.top - area.top},
                {...area, top: block.top + block.height, height: area.top + area.height - block.top - block.height},
                {...area, width: block.left - area.left},
                {...area, left: block.left + block.width, width: area.left + area.width - block.left - block.width},
            ].filter(candidate => candidate.width > 0 && candidate.height > 0);
        });
        regions = regions.filter((area, index) => !regions.some((other, otherIndex) => otherIndex !== index
            && other.left <= area.left && other.top <= area.top && other.left + other.width >= area.left + area.width
            && other.top + other.height >= area.top + area.height && (otherIndex < index || other.width * other.height > area.width * area.height)))
            .sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 32);
    }
    // 极窄边角不适合作为字幕列；无宽区域时仍保留最宽区域供可滚动字幕使用。
    const readable = regions.filter(area => area.width >= Math.min(160, viewport.width - 12));
    return (readable.length ? readable : regions).sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8);
}

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
