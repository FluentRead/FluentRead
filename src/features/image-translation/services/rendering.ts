/**
 * @file src/features/image-translation/services/rendering.ts
 * 文件职责：采样 OCR 框周边背景并在有限图片区域中排版、绘制完整译文，避免混合语言空格损坏、强制横向压缩和行数截断。
 * 主要内容：按周长采样不透明主色、依据相对亮度选择文字颜色、按单词与字素换行，通过字号二分适配区域、保留正文对齐和字号上限并隔离 Canvas 绘图状态。
 * 模块边界：颜色和排版算法无浏览器副作用；绘制函数仅操作调用方传入的 Canvas context，不读取配置、不请求翻译、不修补背景或修改宿主图片元素。
 */
import type { OcrLine } from '@/src/shared/image/types';

/** 从 OCR 框外围采样主色，忽略透明像素且不遍历框内面积。 */
export function getImageTextBackgroundColor(
    pixels: Uint8ClampedArray,
    imageWidth: number,
    imageHeight: number,
    bbox: OcrLine['bbox'],
): string {
    if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight)
        || ![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
        || imageWidth <= 0 || imageHeight <= 0 || pixels.length < imageWidth * imageHeight * 4) {
        return 'rgb(255,255,255)';
    }
    const x0 = Math.max(0, Math.min(imageWidth, Math.floor(bbox.x0)));
    const y0 = Math.max(0, Math.min(imageHeight, Math.floor(bbox.y0)));
    const x1 = Math.max(x0, Math.min(imageWidth, Math.ceil(bbox.x1)));
    const y1 = Math.max(y0, Math.min(imageHeight, Math.ceil(bbox.y1)));
    const colors = new Map<string, number>();
    const sample = (x: number, y: number) => {
        const offset = (y * imageWidth + x) * 4;
        if (pixels[offset + 3] < 128) return;
        const red = Math.min(255, Math.round(pixels[offset] / 16) * 16);
        const green = Math.min(255, Math.round(pixels[offset + 1] / 16) * 16);
        const blue = Math.min(255, Math.round(pixels[offset + 2] / 16) * 16);
        const key = `${red},${green},${blue}`;
        colors.set(key, (colors.get(key) || 0) + 1);
    };
    const left = Math.max(0, x0 - 4);
    const right = Math.min(imageWidth, x1 + 4);
    const top = Math.max(0, y0 - 4);
    const bottom = Math.min(imageHeight, y1 + 4);
    for (let y = top; y < bottom; y += 1) {
        if (y < y0 || y >= y1) {
            for (let x = left; x < right; x += 1) sample(x, y);
        } else {
            for (let x = left; x < x0; x += 1) sample(x, y);
            for (let x = x1; x < right; x += 1) sample(x, y);
        }
    }
    let best = '255,255,255';
    let bestCount = 0;
    colors.forEach((count, color) => {
        if (count > bestCount) {
            best = color;
            bestCount = count;
        }
    });
    return `rgb(${best})`;
}

function relativeLuminance(channels: number[]): number {
    const linear = channels.map(channel => {
        const value = Math.max(0, Math.min(255, channel)) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** 选择与背景对比度较高的深色或白色，避免饱和色被简单灰度阈值误判。 */
export function getImageTextColor(backgroundColor: string): string {
    const channels = backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number);
    const luminance = relativeLuminance(channels && channels.length >= 3 ? channels.slice(0, 3) : [255, 255, 255]);
    const dark = relativeLuminance([17, 24, 39]);
    const darkContrast = (Math.max(luminance, dark) + 0.05) / (Math.min(luminance, dark) + 0.05);
    const lightContrast = 1.05 / (luminance + 0.05);
    return darkContrast >= lightContrast ? '#111827' : '#ffffff';
}

export interface ImageTranslationTextLayout {
    lines: string[];
    fontSize: number;
    lineHeight: number;
}

const IMAGE_TEXT_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const CJK_TOKENS = /\s+|[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]\p{Mark}*|[^\s\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function graphemes(text: string): string[] {
    return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), part => part.segment) : Array.from(text);
}

/** 保留单词、显式换行和混排空格；过长单词才按字素拆分，不截断译文。 */
export function layoutImageTranslationText(
    text: string,
    width: number,
    height: number,
    measure: (text: string, fontSize: number) => number,
    maxFontSize = Infinity,
): ImageTranslationTextLayout {
    const normalized = text.replace(/\r\n?/g, '\n').trim();
    if (!normalized || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { lines: [], fontSize: 0, lineHeight: 0 };
    }
    const paragraphs = normalized.split('\n').map(paragraph => paragraph.trim());
    const tokens = paragraphs.map(paragraph => paragraph.match(CJK_TOKENS) || []);
    const lineSpacing = 1.18;
    const wrap = (fontSize: number): ImageTranslationTextLayout => {
        const lines: string[] = [];
        for (const paragraph of tokens) {
            let current = '';
            let space = '';
            for (const token of paragraph) {
                if (/^\s+$/u.test(token)) {
                    space = ' ';
                    continue;
                }
                const candidate = current + space + token;
                space = '';
                if (measure(candidate, fontSize) <= width) {
                    current = candidate;
                    continue;
                }
                if (current) {
                    lines.push(current);
                    current = '';
                }
                for (const part of graphemes(token)) {
                    if (current && measure(current + part, fontSize) > width) {
                        lines.push(current);
                        current = '';
                    }
                    current += part;
                }
            }
            lines.push(current);
        }
        return { lines, fontSize, lineHeight: fontSize * lineSpacing };
    };
    const fits = (layout: ImageTranslationTextLayout) => layout.lines.length * layout.lineHeight <= height
        && layout.lines.every(line => measure(line, layout.fontSize) <= width);

    let high = Math.min(height / lineSpacing, maxFontSize);
    const largest = wrap(high);
    if (fits(largest)) return largest;
    // 根据完整段落在 1px 字号的宽度推导可容纳下限；极长译文可缩小但始终保留全部文字。
    const paragraphWidth = Math.max(1, ...paragraphs.map(paragraph => measure(paragraph, 1)));
    let low = Math.min(1, width / paragraphWidth, height / (paragraphs.length * lineSpacing)) * 0.99;
    let best = wrap(low);
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const candidate = wrap((low + high) / 2);
        if (fits(candidate)) {
            best = candidate;
            low = candidate.fontSize;
        } else {
            high = candidate.fontSize;
        }
    }
    return best;
}

/** 在原区域内绘制完整译文；使用真实字号适配而非 Canvas maxWidth 横向压扁。 */
export function drawTranslatedImageText(
    context: CanvasRenderingContext2D,
    text: string,
    left: number,
    top: number,
    width: number,
    height: number,
    backgroundColor: string,
    maxFontSize = Infinity,
    textAlign: 'left' | 'center' | 'right' = 'center',
): void {
    const paddingX = Math.min(2, width * 0.03);
    const paddingY = Math.min(1, height * 0.05);
    context.save();
    try {
        let measuredFont = 0;
        const layout = layoutImageTranslationText(text, width - paddingX * 2, height - paddingY * 2, (line, fontSize) => {
            if (fontSize !== measuredFont) {
                context.font = `400 ${fontSize}px ${IMAGE_TEXT_FONT}`;
                measuredFont = fontSize;
            }
            return context.measureText(line).width;
        }, maxFontSize);
        if (layout.lines.length === 0) return;
        context.beginPath();
        context.rect(left, top, width, height);
        context.clip();
        context.font = `400 ${layout.fontSize}px ${IMAGE_TEXT_FONT}`;
        context.textAlign = textAlign;
        context.textBaseline = 'middle';
        context.fillStyle = getImageTextColor(backgroundColor);
        context.strokeStyle = backgroundColor;
        context.lineWidth = Math.max(0.35, layout.fontSize * 0.06);
        context.lineJoin = 'round';
        const firstLine = textAlign === 'center'
            ? top + (height - layout.lineHeight * layout.lines.length) / 2 + layout.lineHeight / 2
            : top + paddingY + layout.lineHeight / 2;
        const x = textAlign === 'left' ? left + paddingX : textAlign === 'right' ? left + width - paddingX : left + width / 2;
        layout.lines.forEach((line, index) => {
            const y = firstLine + index * layout.lineHeight;
            context.strokeText(line, x, y);
            context.fillText(line, x, y);
        });
    } finally {
        context.restore();
    }
}
