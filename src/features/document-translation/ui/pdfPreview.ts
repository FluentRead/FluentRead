/**
 * @file src/features/document-translation/ui/pdfPreview.ts
 * 文件职责：在浏览器 Canvas 环境中为 PDF 文档生成页面预览，并把译文按原页面文本块位置绘制成可嵌入导出 PDF 的 PNG 光栅页。
 * 主要内容：按需加载 PDF.js，限制页面像素与边长、复用单页 Canvas 绘制译文，并在成功、失败或取消时释放画布；生成预览及注入式 PDF 导出光栅页。
 * 模块边界：这里负责视觉光栅化而不决定片段翻译或文件结构；PDF 文本块来自 binary 服务，领域类型来自 core，Canvas/PDF.js 仅应在文档 UI 环境调用，不能进入通用纯算法层。
 */
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import type {
    ParsedDocument,
    PdfDocumentBlock,
} from '@/src/features/document-translation/core/document';
import type {
    PdfPageRasterizer,
    PdfRasterPageInput,
} from '@/src/features/document-translation/services/binary';

export type {PdfPageRasterizer, PdfRasterPageInput};

export interface PdfPagePreview {
    original: Uint8Array;
    translated?: Uint8Array;
}

function median(values: number[]): number {
    if (values.length === 0) return 1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function wrapCanvasText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
    const lines: string[] = [];
    value.replace(/\r\n?/gu, '\n').split('\n').forEach((paragraph) => {
        if (!paragraph) {
            lines.push('');
            return;
        }
        let current = '';
        const flush = () => {
            if (current.trim()) lines.push(current.trimEnd());
            current = '';
        };
        const words = paragraph.match(/\S+/gu) || [];
        words.forEach((word) => {
            const candidate = current ? `${current} ${word}` : word;
            if (context.measureText(candidate).width <= maxWidth) {
                current = candidate;
                return;
            }
            flush();
            if (context.measureText(word).width <= maxWidth) {
                current = word;
                return;
            }
            Array.from(word).forEach((character) => {
                const characterCandidate = current + character;
                if (current && context.measureText(characterCandidate).width > maxWidth) flush();
                current += character;
            });
        });
        flush();
    });
    return lines.length > 0 ? lines : [''];
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('浏览器无法生成 PDF 译文页面'));
                return;
            }
            void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        }, 'image/png');
    });
}

const browserPdfCache = new WeakMap<Uint8Array, Promise<any>>();

function browserPdfDocument(bytes: Uint8Array): Promise<any> {
    const cached = browserPdfCache.get(bytes);
    if (cached) return cached;
    const pdfAssetRoot = `${window.location.origin}/pdfjs`;
    const promise = import('pdfjs-dist/legacy/build/pdf.mjs').then(({getDocument, GlobalWorkerOptions}) => {
        GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        return getDocument({
            data: new Uint8Array(bytes),
            disableFontFace: false,
            isEvalSupported: false,
            useWorkerFetch: false,
            cMapPacked: true,
            cMapUrl: `${pdfAssetRoot}/cmaps/`,
            standardFontDataUrl: `${pdfAssetRoot}/standard_fonts/`,
        }).promise;
    }).catch((error) => {
        // 加载失败不能固化为永久失败，下次预览允许重试。
        if (browserPdfCache.get(bytes) === promise) browserPdfCache.delete(bytes);
        throw error;
    });
    browserPdfCache.set(bytes, promise);
    return promise;
}

async function renderPdfSourceCanvas(bytes: Uint8Array, pageNumber: number, width: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
    if (typeof globalThis.document === 'undefined' || typeof globalThis.window === 'undefined') {
        throw new Error('当前环境无法渲染 PDF 页面，请在浏览器扩展中打开');
    }
    signal?.throwIfAborted();
    const pdf = await browserPdfDocument(bytes);
    signal?.throwIfAborted();
    const page = await pdf.getPage(pageNumber);
    const canvas = globalThis.document.createElement('canvas');
    try {
        signal?.throwIfAborted();
        const base = page.getViewport({scale: 1});
        // 常规 A4 保持原有清晰度；海报/超长页不能按最低 1.45 倍无限分配像素。
        const scale = Math.min(
            Math.min(2.4, Math.max(1.45, 1440 / Math.max(1, width))),
            Math.sqrt(4_000_000 / Math.max(1, base.width * base.height)),
            8192 / Math.max(1, base.width, base.height),
        );
        const viewport = page.getViewport({scale});
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) throw new Error('浏览器 Canvas 初始化失败');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const task = page.render({canvas, canvasContext: context, viewport});
        const cancel = () => task.cancel();
        signal?.addEventListener('abort', cancel, {once: true});
        try {
            await task.promise;
            signal?.throwIfAborted();
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
        return canvas;
    } catch (error) {
        canvas.width = canvas.height = 0;
        throw error;
    } finally {
        page.cleanup();
    }
}

function sampledBackgroundRgb(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
): [number, number, number] {
    const points: Array<[number, number]> = [];
    const steps = 8;
    for (let index = 0; index <= steps; index += 1) {
        const ratio = index / steps;
        points.push([x + width * ratio, y - 2], [x + width * ratio, y + height + 2]);
        points.push([x - 2, y + height * ratio], [x + width + 2, y + height * ratio]);
    }
    const colors: Array<[number, number, number]> = [];
    points.forEach(([pointX, pointY]) => {
        const safeX = Math.max(0, Math.min(context.canvas.width - 1, Math.round(pointX)));
        const safeY = Math.max(0, Math.min(context.canvas.height - 1, Math.round(pointY)));
        const pixel = context.getImageData(safeX, safeY, 1, 1).data;
        if (pixel[3] > 0) colors.push([pixel[0], pixel[1], pixel[2]]);
    });
    if (colors.length === 0) return [255, 255, 255];
    const channelMedian = (channel: 0 | 1 | 2) => median(colors.map((color) => color[channel]));
    return [
        Math.round(channelMedian(0)),
        Math.round(channelMedian(1)),
        Math.round(channelMedian(2)),
    ];
}

function sampledForegroundColor(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    background: [number, number, number],
): string {
    const safeX = Math.max(0, Math.floor(x));
    const safeY = Math.max(0, Math.floor(y));
    const safeWidth = Math.max(1, Math.min(context.canvas.width - safeX, Math.ceil(width)));
    const safeHeight = Math.max(1, Math.min(context.canvas.height - safeY, Math.ceil(height)));
    const pixels = context.getImageData(safeX, safeY, safeWidth, safeHeight).data;
    const stride = Math.max(1, Math.ceil(Math.sqrt((safeWidth * safeHeight) / 3200)));
    const candidates: Array<{color: [number, number, number]; distance: number}> = [];
    for (let pointY = 0; pointY < safeHeight; pointY += stride) {
        for (let pointX = 0; pointX < safeWidth; pointX += stride) {
            const offset = (pointY * safeWidth + pointX) * 4;
            if (pixels[offset + 3] === 0) continue;
            const color: [number, number, number] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
            const distance = Math.hypot(
                color[0] - background[0],
                color[1] - background[1],
                color[2] - background[2],
            );
            if (distance >= 48) candidates.push({color, distance});
        }
    }
    if (candidates.length === 0) return '#111827';
    candidates.sort((left, right) => right.distance - left.distance);
    const strongest = candidates.slice(0, Math.max(3, Math.ceil(candidates.length * 0.22)));
    const channel = (index: 0 | 1 | 2) => Math.round(median(strongest.map((entry) => entry.color[index])));
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function paintPdfTranslation(
    sourceCanvas: HTMLCanvasElement,
    input: PdfRasterPageInput,
): HTMLCanvasElement {
    // 原图编码完毕后可以原位绘制；导出不再同时保留两张全尺寸画布。
    const canvas = sourceCanvas;
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('浏览器 Canvas 初始化失败');
    const scaleX = canvas.width / input.width;
    const scaleY = canvas.height / input.height;

    const paintedBlocks = input.blocks.flatMap((block) => {
        const translation = input.translations[block.segmentIndex] || '';
        if (!translation.trim()) return [];
        const x = Math.max(0, block.x * scaleX);
        const y = Math.max(0, block.y * scaleY);
        const width = Math.max(8, Math.min(canvas.width - x, block.width * scaleX));
        const height = Math.max(8, Math.min(canvas.height - y, block.height * scaleY));
        // 步骤 1：只遮盖文字块，保留周围图表和分隔线，再用采样到的前景色绘制译文。
        const padding = Math.max(2, Math.min(scaleX, scaleY) * 1.2);
        const background = sampledBackgroundRgb(context, x, y, width, height);
        const foreground = sampledForegroundColor(context, x, y, width, height, background);
        return [{block, translation, x, y, width, height, padding, background, foreground}];
    });

    const familyForBlock = (block: PdfDocumentBlock): string => /serif/iu.test(block.fontFamily)
        ? '"Noto Serif CJK SC", "Songti SC", Georgia, "Times New Roman", serif'
        : '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';

    type MeasuredBlock = (typeof paintedBlocks)[number] & {
        fontSize: number;
        lines: string[];
        lineHeight: number;
    };

    const layout: MeasuredBlock[] = paintedBlocks.map((painted) => {
        const family = familyForBlock(painted.block);
        const maxWidth = Math.max(6, painted.width - painted.padding * 1.5);
        const maxHeight = Math.max(
            6,
            painted.height - painted.padding * 0.55,
            painted.block.lineHeight * scaleY * Math.max(1, painted.block.lineCount) - painted.padding * 0.4,
        );
        let fontSize = Math.max(5, painted.block.fontSize * Math.min(scaleX, scaleY));
        let lines: string[] = [];
        let lineHeight = Math.max(4, fontSize * 1.14);
        while (fontSize >= 3.5) {
            context.font = `${painted.block.fontWeight} ${fontSize}px ${family}`;
            lines = wrapCanvasText(context, painted.translation, maxWidth);
            lineHeight = Math.max(4, fontSize * 1.14);
            if (lines.length * lineHeight <= maxHeight * 1.02) break;
            fontSize -= Math.max(0.35, fontSize * 0.045);
        }
        return {...painted, fontSize, lines, lineHeight};
    });

    // 步骤 2：先统一擦除全部原文字块，避免重叠块把已绘制的译文再次遮住。
    paintedBlocks.forEach(({x, y, width, height, padding, background}) => {
        context.fillStyle = `rgb(${background[0]}, ${background[1]}, ${background[2]})`;
        const left = Math.max(0, x - padding);
        const top = Math.max(0, y - padding);
        const right = Math.min(canvas.width, x + width + padding);
        const bottom = Math.min(canvas.height, y + height + padding);
        context.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
    });

    // 步骤 3：在裁剪后的原坐标区域中绘制译文，保证多栏与图文混排不串位。
    layout.forEach(({block, x, y, width, height, padding, foreground, fontSize, lines, lineHeight}) => {
        const family = familyForBlock(block);
        const maxWidth = Math.max(6, width - padding * 1.5);
        context.save();
        context.beginPath();
        context.rect(x, y, width, height);
        context.clip();
        context.fillStyle = foreground;
        context.textBaseline = 'top';
        context.textAlign = block.textAlign;
        context.font = `${block.fontWeight} ${fontSize}px ${family}`;
        const textX = block.textAlign === 'center' ? x + width / 2 : block.textAlign === 'right' ? x + width : x;
        const contentHeight = lines.length * lineHeight;
        let textY = y + Math.max(padding * 0.2, (height - contentHeight) / 2);
        lines.forEach((line) => {
            context.fillText(line, textX, textY, maxWidth);
            textY += lineHeight;
        });
        context.restore();
    });
    return canvas;
}

export async function createPdfPagePreview(
    document: ParsedDocument,
    pageNumber: number,
    translations?: readonly string[],
): Promise<PdfPagePreview> {
    if (document.binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
    const page = document.binary.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new Error(`PDF 第 ${pageNumber} 页不存在`);
    const sourceCanvas = await renderPdfSourceCanvas(document.binary.bytes, pageNumber, page.width);
    try {
        const original = await canvasToPng(sourceCanvas);
        if (!translations) return {original};
        const translatedCanvas = paintPdfTranslation(sourceCanvas, {
            ...page,
            sourceBytes: document.binary.bytes,
            translations,
        });
        return {original, translated: await canvasToPng(translatedCanvas)};
    } finally {
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}

export async function rasterizePdfTranslationPage(input: PdfRasterPageInput): Promise<Uint8Array> {
    if (typeof globalThis.document === 'undefined') {
        throw new Error('当前环境无法生成 PDF 译文页面，请在浏览器扩展中下载');
    }
    const sourceCanvas = await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
    try {
        input.signal?.throwIfAborted();
        const png = await canvasToPng(paintPdfTranslation(sourceCanvas, input));
        input.signal?.throwIfAborted();
        return png;
    } finally {
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}
