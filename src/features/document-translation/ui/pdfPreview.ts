/**
 * @file src/features/document-translation/ui/pdfPreview.ts
 * 文件职责：在浏览器 Canvas 环境中生成 PDF 位置预览与公式图表图像；完整译文按嵌入字体测量分页，由二进制服务绘制可复制的 PDF 文字。
 * 主要内容：空或相同译文仅保留原文；按需加载 PDF.js，限制页面像素与边长并复用单页 Canvas；采样映射到实际旋转像素，位置预览只绘制可读字号下能完整容纳的译文，保护公式图表并按字形区域擦除；完整阅读输出按统一计划续页且逐页释放像素；阅读器通过租约共用文档加载并阻止单页取消销毁仍在阅读的文件；取消、卸载或显式释放时销毁加载任务，迟到加载不得复活缓存；预览与导出 PNG 编码可取消，并在成功、失败或取消时释放画布。
 * 模块边界：这里负责视觉光栅化而不决定片段翻译或文件结构；PDF 文本块来自 binary 服务，领域类型来自 core，Canvas/PDF.js 仅应在文档 UI 环境调用，不能进入通用纯算法层。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type {PDFDocumentProxy, PDFPageProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
    ParsedDocument,
    PdfDocumentBlock,
} from '@/src/features/document-translation/core/document';
import type {
    PdfPageRasterizer,
    PdfRasterPageInput,
    PdfReadingRasterizer,
    PdfReadingRenderer,
} from '@/src/features/document-translation/services/binary';
import {paginatePdfReadingPlan, wrapPdfReadingText, type PdfReadingRegionDraw} from '../core/pdfTextLayout';

export type {PdfPageRasterizer, PdfRasterPageInput};

export interface PdfPagePreview {
    original: Uint8Array;
    translated?: Uint8Array;
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function canvasToPng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error: unknown, bytes?: Uint8Array) => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', abort);
            if (bytes) resolve(bytes);
            else reject(error);
        };
        const abort = () => finish(signal!.reason);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {abort(); return;}
        try {
            canvas.toBlob((blob) => {
                if (finished) return;
                if (!blob) {
                    finish(new Error('浏览器无法生成 PDF 译文页面'));
                    return;
                }
                try {
                    void blob.arrayBuffer().then((buffer) => finish(undefined, new Uint8Array(buffer)), error => finish(error));
                } catch (error) {finish(error);}
            }, 'image/png');
        } catch (error) {finish(error);}
    });
}

interface BrowserPdfResource {
    promise: Promise<PDFDocumentProxy>;
    task?: ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>;
    controller: AbortController;
    users: number;
    unload: () => void;
}
const browserPdfCache = new WeakMap<Uint8Array, BrowserPdfResource>();

/** 文件移除时由组合根调用；pagehide 也会释放。缓存删除发生在销毁前，迟到加载无法重新占有它。 */
export function releasePdfDocument(bytes: Uint8Array, reason?: unknown): void {
    const resource = browserPdfCache.get(bytes);
    if (!resource) return;
    browserPdfCache.delete(bytes);
    window.removeEventListener?.('pagehide', resource.unload);
    resource.controller.abort(reason);
    void resource.task?.destroy?.().catch(() => undefined);
}

function browserPdfDocument(bytes: Uint8Array): BrowserPdfResource {
    const cached = browserPdfCache.get(bytes);
    if (cached) return cached;
    const pdfAssetRoot = `${window.location.origin}/pdfjs`;
    const resource: BrowserPdfResource = {
        promise: undefined!, controller: new AbortController(), users: 0,
        unload: () => releasePdfDocument(bytes),
    };
    const promise = import('pdfjs-dist/legacy/build/pdf.mjs').then(({getDocument, GlobalWorkerOptions}) => {
        resource.controller.signal.throwIfAborted();
        GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        resource.task = getDocument({
            data: new Uint8Array(bytes),
            disableFontFace: false,
            isEvalSupported: false,
            useWorkerFetch: false,
            cMapPacked: true,
            cMapUrl: `${pdfAssetRoot}/cmaps/`,
            standardFontDataUrl: `${pdfAssetRoot}/standard_fonts/`,
        });
        return resource.task.promise;
    }).catch((error) => {
        // 加载失败不能固化为永久失败，下次预览允许重试。
        if (browserPdfCache.get(bytes) === resource) releasePdfDocument(bytes, error);
        throw error;
    });
    resource.promise = promise;
    browserPdfCache.set(bytes, resource);
    window.addEventListener?.('pagehide', resource.unload, {once: true});
    return resource;
}

/** 阅读器持有文档而单页任务可以取消；最后一个阅读租约关闭时释放不再使用的缓存。 */
export function acquirePdfDocument(bytes: Uint8Array): {
    promise: Promise<PDFDocumentProxy>;
    signal: AbortSignal;
    release: () => void;
} {
    const resource = browserPdfDocument(bytes);
    resource.users += 1;
    let released = false;
    return {
        promise: resource.promise,
        signal: resource.controller.signal,
        release: () => {
            if (released) return;
            released = true;
            resource.users -= 1;
            if (resource.users === 0 && browserPdfCache.get(bytes) === resource) releasePdfDocument(bytes);
        },
    };
}

function awaitPdfTask<T>(promise: Promise<T>, signal: AbortSignal, releaseLateValue?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        promise.then(value => {
            try {
                if (signal.aborted) releaseLateValue?.(value);
                resolve(value);
            } catch (error) {reject(error);}
        }, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

async function renderPdfSourceCanvas(bytes: Uint8Array, pageNumber: number, width: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
    if (typeof globalThis.document === 'undefined' || typeof globalThis.window === 'undefined') {
        throw new Error('当前环境无法渲染 PDF 页面，请在浏览器扩展中打开');
    }
    signal?.throwIfAborted();
    const resource = browserPdfDocument(bytes);
    resource.users += 1;
    const controller = new AbortController();
    const cancelLoad = () => controller.abort(signal!.reason);
    const unload = () => controller.abort(resource.controller.signal.reason);
    signal?.addEventListener('abort', cancelLoad, {once: true});
    resource.controller.signal.addEventListener('abort', unload, {once: true});
    let page: PDFPageProxy | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let failed = false;
    try {
        const pdf = await awaitPdfTask(resource.promise, controller.signal);
        page = await awaitPdfTask(pdf.getPage(pageNumber), controller.signal, latePage => latePage.cleanup());
        controller.signal.throwIfAborted();
        canvas = globalThis.document.createElement('canvas');
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
        const task = page.render({canvasContext: context, viewport});
        const cancel = () => task.cancel();
        controller.signal.addEventListener('abort', cancel, {once: true});
        if (controller.signal.aborted) cancel();
        try {
            await task.promise;
            controller.signal.throwIfAborted();
        } finally {
            controller.signal.removeEventListener('abort', cancel);
        }
        return canvas;
    } catch (error) {
        failed = true;
        if (canvas) canvas.width = canvas.height = 0;
        throw error;
    } finally {
        try {
            page?.cleanup();
        } catch (error) {
            if (canvas) canvas.width = canvas.height = 0;
            releasePdfDocument(bytes, error);
            if (!failed) throw error;
        } finally {
            signal?.removeEventListener('abort', cancelLoad);
            resource.controller.signal.removeEventListener('abort', unload);
            resource.users -= 1;
            if (controller.signal.aborted && resource.users === 0 && browserPdfCache.get(bytes) === resource) releasePdfDocument(bytes);
        }
    }
}

export function sampledBackgroundRgb(
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

export function sampledForegroundColor(
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

export function paintPdfTranslation(
    sourceCanvas: HTMLCanvasElement,
    input: PdfRasterPageInput,
): HTMLCanvasElement {
    // 原图编码完毕后可以原位绘制；导出不再同时保留两张全尺寸画布。
    const canvas = sourceCanvas;
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('浏览器 Canvas 初始化失败');
    const rotation = input.rotation ?? 0;
    const quarterTurn = rotation === 90 || rotation === 270;
    const virtualWidth = quarterTurn ? canvas.height : canvas.width;
    const virtualHeight = quarterTurn ? canvas.width : canvas.height;
    const scaleX = virtualWidth / (quarterTurn ? input.height : input.width);
    const scaleY = virtualHeight / (quarterTurn ? input.width : input.height);
    // getImageData 不应用 Canvas 当前矩阵，采样必须显式映射到实际旋转后的画布。
    const sampleRectangle = (x: number, y: number, width: number, height: number) => {
        if (rotation === 90) return {x: canvas.width - y - height, y: x, width: height, height: width};
        if (rotation === 180) return {x: canvas.width - x - width, y: canvas.height - y - height, width, height};
        if (rotation === 270) return {x: y, y: canvas.height - x - width, width: height, height: width};
        return {x, y, width, height};
    };

    if (rotation) context.save();
    try {
        const paintedBlocks = input.blocks.flatMap((block) => {
            const translation = input.translations[block.segmentIndex] || '';
            if (!translation.trim()) return [];
            if (block.preserveSource || ['formula', 'table', 'figure-label'].includes(block.kind ?? '')) return [];
            if (input.preservedRegions?.some(region => block.x < region.x + region.width && block.x + block.width > region.x && block.y < region.y + region.height && block.y + block.height > region.y)) return [];
            const x = Math.max(0, Math.min(virtualWidth - 1, block.x * scaleX));
            const y = Math.max(0, Math.min(virtualHeight - 1, block.y * scaleY));
            const width = Math.max(1, Math.min(virtualWidth - x, Math.max(8, block.width * scaleX)));
            const height = Math.max(1, Math.min(virtualHeight - y, Math.max(8, block.height * scaleY)));
            // 步骤 1：只遮盖文字块，保留周围图表和分隔线，再用采样到的前景色绘制译文。
            const padding = Math.max(2, Math.min(scaleX, scaleY) * 1.2);
            const sample = sampleRectangle(x, y, width, height);
            const background = sampledBackgroundRgb(context, sample.x, sample.y, sample.width, sample.height);
            const foreground = sampledForegroundColor(context, sample.x, sample.y, sample.width, sample.height, background);
            return [{block, translation, x, y, width, height, padding, background, foreground}];
        });

        const familyForBlock = (block: PdfDocumentBlock): string => /serif/iu.test(block.fontFamily) && !/sans/iu.test(block.fontFamily)
            ? '"Noto Serif CJK SC", "Songti SC", Georgia, "Times New Roman", serif'
            : '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';

        type MeasuredBlock = (typeof paintedBlocks)[number] & {
            fontSize: number;
            lines: string[];
            lineHeight: number;
        };

        const layout: MeasuredBlock[] = paintedBlocks.flatMap((painted) => {
            const family = familyForBlock(painted.block);
            const maxWidth = Math.max(0, painted.width - painted.padding * 1.5);
            if (!maxWidth) return [];
            const maxHeight = Math.max(0, painted.height - painted.padding * 0.55);
            const floor = 8.5 * Math.min(scaleX, scaleY);
            let fontSize = Math.max(floor, painted.block.fontSize * Math.min(scaleX, scaleY));
            let lines: string[] = [];
            let lineHeight = Math.max(4, fontSize * 1.14);
            while (fontSize >= floor) {
                context.font = `${painted.block.fontWeight} ${fontSize}px ${family}`;
                lines = wrapPdfReadingText(painted.translation, maxWidth, {size: fontSize, weight: painted.block.fontWeight, lineHeight}, text => context.measureText(text).width);
                lineHeight = Math.max(4, fontSize * 1.14);
                if (lines.length * lineHeight <= maxHeight && lines.every(line => context.measureText(line).width <= maxWidth)) break;
                if (fontSize === floor) return [];
                fontSize = Math.max(floor, fontSize - Math.max(0.5, fontSize * 0.12));
            }
            return [{...painted, fontSize, lines, lineHeight}];
        });

        if (rotation === 90) context.transform(0, 1, -1, 0, canvas.width, 0);
        else if (rotation === 180) context.transform(-1, 0, 0, -1, canvas.width, canvas.height);
        else if (rotation === 270) context.transform(0, -1, 1, 0, 0, canvas.height);
        // 步骤 2：先统一擦除全部原文字块，避免重叠块把已绘制的译文再次遮住。
        layout.forEach(({block, x, y, width, height, padding, background}) => {
            context.fillStyle = `rgb(${background[0]}, ${background[1]}, ${background[2]})`;
            const rectangles = block.lines?.flatMap(line => line.runs?.length ? line.runs : [line]);
            const erase = rectangles?.length ? rectangles.map(rect => ({x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY})) : [{x, y, width, height}];
            erase.forEach(rect => {
                const left = Math.max(0, rect.x - padding);
                const top = Math.max(0, rect.y - padding);
                const right = Math.min(virtualWidth, rect.x + rect.width + padding);
                const bottom = Math.min(virtualHeight, rect.y + rect.height + padding);
                context.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
            });
        });

        // 步骤 3：在裁剪后的原坐标区域中绘制译文，保证多栏与图文混排不串位。
        layout.forEach(({block, x, y, width, height, padding, foreground, fontSize, lines, lineHeight}) => {
            const family = familyForBlock(block);
            const maxWidth = Math.max(6, width - padding * 1.5);
            context.save();
            try {
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
            } finally {context.restore();}
        });
    } finally {if (rotation) context.restore();}
    return canvas;
}

export async function createPdfPagePreview(
    document: ParsedDocument,
    pageNumber: number,
    translations?: readonly string[],
    signal?: AbortSignal,
): Promise<PdfPagePreview> {
    if (document.binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
    const page = document.binary.pages.find((entry) => entry.pageNumber === pageNumber);
    if (!page) throw new Error(`PDF 第 ${pageNumber} 页不存在`);
    const sourceCanvas = await renderPdfSourceCanvas(document.binary.bytes, pageNumber, page.width, signal);
    try {
        const original = await canvasToPng(sourceCanvas, signal);
        const visibleTranslations = translations?.map((translation, segmentIndex) =>
            hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translation) ? translation : '');
        if (!visibleTranslations || !page.segmentIndexes.some(index => visibleTranslations[index])) return {original};
        const translatedCanvas = paintPdfTranslation(sourceCanvas, {
            ...page,
            sourceBytes: document.binary.bytes,
            translations: visibleTranslations,
        });
        return {original, translated: await canvasToPng(translatedCanvas, signal)};
    } finally {
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}

/** 把一页渲染成图像供文字识别使用；画布用完立即释放，只返回编码后的图像与它的像素尺寸。 */
export async function renderPdfPageImage(bytes: Uint8Array, pageNumber: number, width: number, signal?: AbortSignal): Promise<{image: string; width: number; height: number}> {
    const canvas = await renderPdfSourceCanvas(bytes, pageNumber, width, signal);
    try {
        return {image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height};
    } finally {
        canvas.width = canvas.height = 0;
    }
}

export async function rasterizePdfTranslationPage(input: PdfRasterPageInput): Promise<Uint8Array> {
    if (typeof globalThis.document === 'undefined') {
        throw new Error('当前环境无法生成 PDF 译文页面，请在浏览器扩展中下载');
    }
    const sourceCanvas = await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
    try {
        input.signal?.throwIfAborted();
        const png = await canvasToPng(paintPdfTranslation(sourceCanvas, input), input.signal);
        input.signal?.throwIfAborted();
        return png;
    } finally {
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}

/** 固定字号逐页编码；只保留一张源图和一张输出 Canvas，译文长短不会扩大画布。 */
export const rasterizePdfReadingPages: PdfReadingRasterizer = async function* (input) {
    if (typeof globalThis.document === 'undefined') throw new Error('当前环境无法生成 PDF 译文页面，请在浏览器扩展中下载');
    input.signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    let source: HTMLCanvasElement | undefined;
    try {
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) throw new Error('浏览器 Canvas 初始化失败');
        const family = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
        const pages = paginatePdfReadingPlan(input.plan, (text, font) => {
            context.font = `${font.weight} ${font.size}px ${family}`;
            return context.measureText(text).width;
        });
        if (pages.some(page => page.items.some(item => item.kind === 'region'))) {
            source = await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
        }
        for (const page of pages) {
            input.signal?.throwIfAborted();
            canvas.width = page.width * 2;
            canvas.height = page.height * 2;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.save();
            try {
                context.scale(2, 2);
                context.textBaseline = 'top';
                context.textAlign = 'left';
                context.fillStyle = '#18212f';
                for (const item of page.items) {
                    if (item.kind === 'text') {
                        context.font = `${item.font.weight} ${item.font.size}px ${family}`;
                        context.fillText(item.text, item.x, item.y);
                    } else if (source) {
                        const r = item.sourceRect, rotation = input.rotation ?? 0;
                        const sx = source.width / input.width, sy = source.height / input.height;
                        const sample = rotation === 90 ? {x: input.width - r.y - r.height, y: r.x, width: r.height, height: r.width}
                            : rotation === 180 ? {x: input.width - r.x - r.width, y: input.height - r.y - r.height, width: r.width, height: r.height}
                                : rotation === 270 ? {x: r.y, y: input.height - r.x - r.width, width: r.height, height: r.width} : r;
                        context.save();
                        try {
                            context.translate(item.x, item.y);
                            if (rotation === 90) {context.translate(0, item.height); context.rotate(-Math.PI / 2);}
                            else if (rotation === 180) {context.translate(item.width, item.height); context.rotate(-Math.PI);}
                            else if (rotation === 270) {context.translate(item.width, 0); context.rotate(Math.PI / 2);}
                            const quarterTurn = rotation === 90 || rotation === 270;
                            context.drawImage(source, sample.x * sx, sample.y * sy, sample.width * sx, sample.height * sy,
                                0, 0, quarterTurn ? item.height : item.width, quarterTurn ? item.width : item.height);
                        } finally {context.restore();}
                    }
                }
            } finally {context.restore();}
            const bytes = await canvasToPng(canvas, input.signal);
            input.signal?.throwIfAborted();
            yield {bytes, width: page.width, height: page.height};
            input.signal?.throwIfAborted();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } finally {
        canvas.width = canvas.height = 0;
        if (source) source.width = source.height = 0;
    }
};

function paintPdfReadingRegion(context: CanvasRenderingContext2D, source: HTMLCanvasElement, item: PdfReadingRegionDraw, input: PdfRasterPageInput): void {
    const r = item.sourceRect, rotation = input.rotation ?? 0;
    const sx = source.width / input.width, sy = source.height / input.height;
    const sample = rotation === 90 ? {x: input.width - r.y - r.height, y: r.x, width: r.height, height: r.width}
        : rotation === 180 ? {x: input.width - r.x - r.width, y: input.height - r.y - r.height, width: r.width, height: r.height}
            : rotation === 270 ? {x: r.y, y: input.height - r.x - r.width, width: r.height, height: r.width} : r;
    context.save();
    try {
        context.translate(item.x, item.y);
        if (rotation === 90) {context.translate(0, item.height); context.rotate(-Math.PI / 2);}
        else if (rotation === 180) {context.translate(item.width, item.height); context.rotate(Math.PI);}
        else if (rotation === 270) {context.translate(item.width, 0); context.rotate(Math.PI / 2);}
        const quarterTurn = rotation === 90 || rotation === 270;
        context.drawImage(source, sample.x * sx, sample.y * sy, sample.width * sx, sample.height * sy,
            0, 0, quarterTurn ? item.height : item.width, quarterTurn ? item.width : item.height);
    } finally {context.restore();}
}

/** 可见文字保留为 PDF 布局数据，仅公式/图表经过 Canvas；每次最多一张源页和一张图像页。 */
export const renderPdfReadingPages: PdfReadingRenderer = async function* (input) {
    input.signal?.throwIfAborted();
    const pages = paginatePdfReadingPlan(input.plan, input.measureText);
    let canvas: HTMLCanvasElement | undefined;
    let source: HTMLCanvasElement | undefined;
    try {
        for (const page of pages) {
            input.signal?.throwIfAborted();
            const regions = page.items.filter((item): item is PdfReadingRegionDraw => item.kind === 'region');
            let regionImage: Uint8Array | undefined;
            if (regions.length) {
                if (typeof globalThis.document === 'undefined') throw new Error('当前环境无法保留 PDF 公式图表，请在浏览器扩展中下载');
                source ??= await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
                canvas ??= document.createElement('canvas');
                canvas.width = page.width * 2;
                canvas.height = page.height * 2;
                const context = canvas.getContext('2d', {alpha: false});
                if (!context) throw new Error('浏览器 Canvas 初始化失败');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.save();
                try {
                    context.scale(2, 2);
                    for (const item of regions) paintPdfReadingRegion(context, source, item, input);
                } finally {context.restore();}
                regionImage = await canvasToPng(canvas, input.signal);
                input.signal?.throwIfAborted();
                canvas.width = canvas.height = 0;
            }
            yield {...page, ...(regionImage ? {regionImage} : {})};
            input.signal?.throwIfAborted();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } finally {
        if (canvas) canvas.width = canvas.height = 0;
        if (source) source.width = source.height = 0;
    }
};
