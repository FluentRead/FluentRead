/**
 * @file src/features/document-translation/ui/pdfScanPreview.ts
 * 文件职责：为扫描 PDF 的现有页面识别流程提供有界图形预览，补足图像页面缺少矢量边界的问题。
 * 主要内容：从已渲染原页生成最长 1600 像素、最多 180 万像素的临时预览，读取一次像素并分批执行纯图形分析；网格候选在总像素不超过一页的临时裁剪中移除表线，原图不变，超出预算的区域显式留待核对；按两个轴分别回映到原图像素坐标，完成、失败或取消均释放临时 Canvas 和分析迭代器。
 * 模块边界：只负责 Canvas 与事件循环适配，不载入 PDF、不发起 OCR、不保存图像和页面状态；图形/表格判断由 core/pdfScanGraphics 及原有版面分析负责。
 */
import {detectPdfScanGraphics, PDF_SCAN_GRAPHICS_MAX_EDGE, PDF_SCAN_GRAPHICS_MAX_PIXELS, type PdfScanGraphic} from '../core/pdfScanGraphics';

export interface PdfScanRegionImage {graphicIndex: number; x: number; y: number; image?: string}

/** 表线只从临时识别裁剪中擦除；原页像素不变，裁剪总像素不超过一页，超出预算的区域留给核对。 */
export function cropPdfScanRegions(source: HTMLCanvasElement, graphics: readonly PdfScanGraphic[], pageWidth: number, signal?: AbortSignal): PdfScanRegionImage[] {
    const regions: PdfScanRegionImage[] = [];
    let canvas: HTMLCanvasElement | undefined, remaining = source.width * source.height;
    const padding = Math.ceil(source.width / pageWidth * 2), stroke = Math.max(2, source.width / pageWidth * 1.6);
    try {
        for (const [graphicIndex, graphic] of graphics.entries()) {
            signal?.throwIfAborted();
            if (!graphic.rules.length) continue;
            const x = Math.max(0, Math.floor(graphic.x) - padding), y = Math.max(0, Math.floor(graphic.y) - padding);
            const width = Math.min(source.width, Math.ceil(graphic.x + graphic.width) + padding) - x;
            const height = Math.min(source.height, Math.ceil(graphic.y + graphic.height) + padding) - y;
            if (width * height > remaining) {regions.push({graphicIndex, x, y}); continue;}
            remaining -= width * height;
            canvas ??= document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {alpha: false});
            if (!context) throw new Error('浏览器 Canvas 初始化失败');
            context.drawImage(source, x, y, width, height, 0, 0, width, height);
            context.fillStyle = '#ffffff';
            for (const rule of graphic.rules) {
                if (rule.width > 0) context.fillRect(rule.x - x, rule.y - y - stroke / 2, rule.width, stroke);
                else context.fillRect(rule.x - x - stroke / 2, rule.y - y, stroke, rule.height);
            }
            regions.push({graphicIndex, x, y, image: canvas.toDataURL('image/png')});
        }
        signal?.throwIfAborted();
        return regions;
    } finally {if (canvas) canvas.width = canvas.height = 0;}
}

export async function readPdfScanGraphics(source: HTMLCanvasElement, pageWidth: number, signal?: AbortSignal): Promise<PdfScanGraphic[]> {
    signal?.throwIfAborted();
    const ratio = Math.min(1, PDF_SCAN_GRAPHICS_MAX_EDGE / source.width, PDF_SCAN_GRAPHICS_MAX_EDGE / source.height,
        Math.sqrt(PDF_SCAN_GRAPHICS_MAX_PIXELS / (source.width * source.height)));
    const canvas = document.createElement('canvas');
    let steps: ReturnType<typeof detectPdfScanGraphics> | undefined;
    try {
        canvas.width = Math.max(1, Math.floor(source.width * ratio)); canvas.height = Math.max(1, Math.floor(source.height * ratio));
        const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
        if (!context) throw new Error('浏览器 Canvas 初始化失败');
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        steps = detectPdfScanGraphics({width: canvas.width, height: canvas.height, data: pixels.data}, pageWidth / canvas.width, signal);
        let step = steps.next();
        while (!step.done) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            signal?.throwIfAborted();
            step = steps.next();
        }
        const x = source.width / canvas.width, y = source.height / canvas.height;
        const mapped = <T extends {x: number; y: number; width: number; height: number}>(box: T): T => ({...box,
            x: box.x * x, y: box.y * y, width: box.width * x, height: box.height * y});
        return step.value.map(({rules, ...box}) => ({...mapped(box), rules: rules.map(mapped)}));
    } finally {
        steps?.return([]);
        canvas.width = canvas.height = 0;
    }
}
