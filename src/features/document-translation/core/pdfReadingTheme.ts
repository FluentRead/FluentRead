/**
 * @file src/features/document-translation/core/pdfReadingTheme.ts
 * 文件职责：计算 PDF 阅读配色、像素颜色映射与需要保留原色的插图区域。
 * 主要内容：在原页与重排阅读间共用纸张、薄荷、深色和自定义配色；通过有界的 SVG 滤镜分别指定白纸与黑色文字的目标颜色；从解析器确认的插图区取得有限、有效的原页矩形，扫描整页或过密图形保留原图。
 * 模块边界：纯数据计算，不创建 Canvas、SVG、DOM 或网络请求，不修改原始 PDF 或导出配色。
 */
import type {PdfDocumentPage} from './document';
import type {PdfReadingRect} from './pdfReadingPlan';

export const PDF_READING_THEMES = ['auto', 'sepia', 'mint', 'dark', 'invert', 'custom'] as const;
export type PdfReadingTheme = typeof PDF_READING_THEMES[number];
export interface PdfReadingColors {background: string; text: string}

export function pdfReadingThemeColors(theme: PdfReadingTheme, background: string, text: string): PdfReadingColors | undefined {
    if (theme === 'auto') return;
    if (theme === 'sepia') return {background: '#f5ecd8', text: '#3d3428'};
    if (theme === 'mint') return {background: '#e8f1ea', text: '#243b30'};
    if (theme === 'dark') return {background: '#20242b', text: '#e5e7eb'};
    if (theme === 'invert') return {background: '#000000', text: '#ffffff'};
    const color = (value: string, fallback: string) => /^#[\da-f]{6}$/iu.test(value) ? value : fallback;
    return {background: color(background, '#fff7e6'), text: color(text, '#302b24')};
}

/** SVG sRGB 分量映射：黑色对应文字色，白色对应背景色，避免显示器色彩空间影响混色端点。 */
export function pdfReadingThemeTransfer(colors: PdfReadingColors): Array<{slope: number; intercept: number}> {
    return [1, 3, 5].map(offset => {
        const background = parseInt(colors.background.slice(offset, offset + 2), 16) / 255;
        const foreground = parseInt(colors.text.slice(offset, offset + 2), 16) / 255;
        return {slope: background - foreground, intercept: foreground};
    });
}

/** 原图坐标在 rotation=0 的内容空间中；渲染边界复用阅读器的统一旋转变换。 */
export function pdfReadingThemeRegions(page: PdfDocumentPage): PdfReadingRect[] {
    const quarterTurn = page.rotation === 90 || page.rotation === 270;
    const width = quarterTurn ? page.height : page.width, height = quarterTurn ? page.width : page.height;
    const whole = {x: 0, y: 0, width, height};
    if (page.scanned || !page.blocks.length && !page.preservedRegions?.length) return [whole];
    const figures = (page.preservedRegions ?? []).filter(region => region.kind === 'figure');
    // 复杂矢量图不生成成千上万个 GPU 遮罩；整页保留原色，避免只保护一半插图。
    if (figures.length > 128) return [whole];
    const seen = new Set<string>();
    return figures.flatMap(region => {
        if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return [];
        const x = Math.max(0, region.x), y = Math.max(0, region.y), right = Math.min(width, region.x + region.width), bottom = Math.min(height, region.y + region.height);
        if (right <= x || bottom <= y) return [];
        const rect = {x, y, width: right - x, height: bottom - y}, key = JSON.stringify(rect);
        if (seen.has(key)) return [];
        seen.add(key);
        return [rect];
    });
}
