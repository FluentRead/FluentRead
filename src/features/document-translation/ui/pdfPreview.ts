/**
 * @file src/features/document-translation/ui/pdfPreview.ts
 * 文件职责：在浏览器 Canvas 环境中生成 PDF 预览和原版译页；显式重排导出按嵌入字体分页，仅公式图表编码为图像，由二进制服务绘制可复制文字。
 * 主要内容：共用 PDF.js 与有界单页 Canvas；扫描文档使用独立的 300 dpi、九百万像素渲染预算；导出每页一次像素读回，阅读器每个新段只读回包含取样边缘的局部快照；重排的光栅与文字导出共用原图旋转裁剪，复用保护筛选、表格裁剪和有界拟合，超长译文返回完整批注与逐行搜索层，缺字或离线时可用带相同 Unicode 文字层的有界光栅续页；下载分批绘制并优先 JPEG 编码，预览和重排图表使用 PNG；取消、失败与完成释放画布，租约隔离阅读器与导出，迟到加载不能复活已释放资源。
 * 模块边界：这里负责视觉光栅化而不决定片段翻译或文件结构；单元格与图文卡片沿用解析边界，PDF 文本块来自 binary 服务，静态地址来自 pdfResources，Canvas/PDF.js 仅在文档 UI 环境调用。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {pdfFallbackBidiLine, withPdfFallbackBidiDirection} from '../core/pdfFallbackBidi';
import {getPdfResources} from '../services/pdfResources';
import type {PDFDocumentProxy, PDFPageProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
    ParsedDocument,
    PdfDocumentBlock,
} from '@/src/features/document-translation/core/document';
import type {
    PdfPageRasterizer,
    PdfRasterPageInput,
    PdfReadingRasterizer,
    PdfOverflowNote,
    PdfRasterPageResult,
    PdfRasterTextItem,
    PdfReadingRenderer,
} from '@/src/features/document-translation/services/binary';
import {paginatePdfReadingPlan, type PdfReadingRegionDraw} from '../core/pdfTextLayout';
import {fitPdfBlockText, pdfOverlayBlocks} from '../core/pdfBlockFit';

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

function canvasToImageBytes(canvas: HTMLCanvasElement, signal?: AbortSignal, format: 'png' | 'jpeg' = 'png'): Promise<Uint8Array> {
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
            }, format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? 0.95 : undefined);
        } catch (error) {finish(error);}
    });
}

interface PdfPixelSnapshot {data: Uint8ClampedArray; width: number; height: number; x?: number; y?: number}

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
    const {assetRoot: pdfAssetRoot, workerUrl} = getPdfResources();
    const resource: BrowserPdfResource = {
        promise: undefined!, controller: new AbortController(), users: 0,
        unload: () => releasePdfDocument(bytes),
    };
    const promise = import('pdfjs-dist/legacy/build/pdf.mjs').then(({getDocument, GlobalWorkerOptions}) => {
        resource.controller.signal.throwIfAborted();
        GlobalWorkerOptions.workerSrc = workerUrl;
        resource.task = getDocument({
            data: new Uint8Array(bytes),
            disableFontFace: false,
            disableWorkerRendering: true,
            useWorkerFetch: false,
            cMapPacked: true,
            cMapUrl: `${pdfAssetRoot}/cmaps/`,
            standardFontDataUrl: `${pdfAssetRoot}/standard_fonts/`,
            wasmUrl: `${pdfAssetRoot}/wasm/`,
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

async function renderPdfSourceCanvas(bytes: Uint8Array, pageNumber: number, width: number, signal?: AbortSignal, forOcr = false): Promise<HTMLCanvasElement> {
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
            forOcr ? 300 / 72 : Math.min(2.4, Math.max(1.45, 1440 / Math.max(1, width))),
            Math.sqrt((forOcr ? 9_000_000 : 4_000_000) / Math.max(1, base.width * base.height)),
            (forOcr ? 4096 : 8192) / Math.max(1, base.width, base.height),
        );
        const viewport = page.getViewport({scale});
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) throw new Error('浏览器 Canvas 初始化失败');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const task = page.render({canvas: null, canvasContext: context, viewport});
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
    snapshot?: PdfPixelSnapshot,
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
        const offset = snapshot ? ((safeY - (snapshot.y ?? 0)) * snapshot.width + safeX - (snapshot.x ?? 0)) * 4 : 0;
        const pixel = snapshot ? snapshot.data.subarray(offset, offset + 4) : context.getImageData(safeX, safeY, 1, 1).data;
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
    snapshot?: PdfPixelSnapshot,
): string {
    const safeX = Math.max(0, Math.floor(x));
    const safeY = Math.max(0, Math.floor(y));
    const safeWidth = Math.max(1, Math.min(context.canvas.width - safeX, Math.ceil(width)));
    const safeHeight = Math.max(1, Math.min(context.canvas.height - safeY, Math.ceil(height)));
    const pixels = snapshot?.data ?? context.getImageData(safeX, safeY, safeWidth, safeHeight).data;
    const stride = Math.max(1, Math.ceil(Math.sqrt((safeWidth * safeHeight) / 3200)));
    const candidates: Array<{color: [number, number, number]; distance: number}> = [];
    for (let pointY = 0; pointY < safeHeight; pointY += stride) {
        for (let pointX = 0; pointX < safeWidth; pointX += stride) {
            const localX = safeX + pointX - (snapshot?.x ?? 0), localY = safeY + pointY - (snapshot?.y ?? 0);
            if (snapshot && (localX < 0 || localY < 0 || localX >= snapshot.width || localY >= snapshot.height)) continue;
            const offset = snapshot ? (localY * snapshot.width + localX) * 4 : (pointY * safeWidth + pointX) * 4;
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

/** 阅读器按段落一次读回局部像素；边界包含背景的两像素外沿与原有前景裁剪，不保存整页快照。 */
export function sampledPdfBlockColors(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): {background: [number, number, number]; foreground: string} {
    const foregroundX = Math.max(0, Math.floor(x)), foregroundY = Math.max(0, Math.floor(y));
    const foregroundRight = foregroundX + Math.max(1, Math.min(context.canvas.width - foregroundX, Math.ceil(width)));
    const foregroundBottom = foregroundY + Math.max(1, Math.min(context.canvas.height - foregroundY, Math.ceil(height)));
    const left = Math.max(0, Math.min(context.canvas.width - 1, Math.floor(x - 2)));
    const top = Math.max(0, Math.min(context.canvas.height - 1, Math.floor(y - 2)));
    const right = Math.max(left + 1, Math.min(context.canvas.width, Math.ceil(Math.max(x + width + 2, foregroundRight - 1)) + 1));
    const bottom = Math.max(top + 1, Math.min(context.canvas.height, Math.ceil(Math.max(y + height + 2, foregroundBottom - 1)) + 1));
    const snapshot: PdfPixelSnapshot = {data: context.getImageData(left, top, right - left, bottom - top).data,
        width: right - left, height: bottom - top, x: left, y: top};
    const background = sampledBackgroundRgb(context, x, y, width, height, snapshot);
    return {background, foreground: sampledForegroundColor(context, x, y, width, height, background, snapshot)};
}

function* paintPdfTranslationSteps(
    sourceCanvas: HTMLCanvasElement,
    input: PdfRasterPageInput,
): Generator<void, {canvas: HTMLCanvasElement; overflowNotes: PdfOverflowNote[]; textItems: PdfRasterTextItem[]}> {
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

    const overflowNotes: PdfOverflowNote[] = [];
    const textItems: PdfRasterTextItem[] = [];
    if (rotation) context.save();
    try {
        const overlays = pdfOverlayBlocks({...input, segmentIndexes: input.blocks.map(block => block.segmentIndex)});
        // 一页只读回一次像素；每段几十次 getImageData 会反复同步 GPU 并分配整个段落的像素副本。
        let snapshot: PdfPixelSnapshot | undefined;
        const paintedBlocks = [];
        for (const {block, spaceBelow, spaceRight} of overlays) {
            input.signal?.throwIfAborted();
            const translation = input.translations[block.segmentIndex] || '';
            if (!translation.trim() || ![block.x, block.y, block.width, block.height, block.fontSize].every(Number.isFinite)) continue;
            const x = Math.max(0, Math.min(virtualWidth - 1, block.x * scaleX));
            const y = Math.max(0, Math.min(virtualHeight - 1, block.y * scaleY));
            const width = Math.max(1, Math.min(virtualWidth - x, (block.width + (block.lineCount <= 1 ? spaceRight : 0)) * scaleX));
            const height = Math.max(1, Math.min(virtualHeight - y, (block.height + spaceBelow) * scaleY));
            // 步骤 1：只遮盖文字块，保留周围图表和分隔线，再用采样到的前景色绘制译文。
            const padding = Math.max(2, Math.min(scaleX, scaleY) * 1.2);
            const sample = sampleRectangle(x, y, block.width * scaleX, block.height * scaleY);
            if (!snapshot) {
                const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                snapshot = {data, width: canvas.width, height: canvas.height};
            }
            const background = sampledBackgroundRgb(context, sample.x, sample.y, sample.width, sample.height, snapshot);
            const foreground = sampledForegroundColor(context, sample.x, sample.y, sample.width, sample.height, background, snapshot);
            paintedBlocks.push({block, translation, x, y, width, height, padding, background, foreground});
            if (paintedBlocks.length % 8 === 0) yield;
        }

        const familyForBlock = (block: PdfDocumentBlock): string => /serif|roman|times|song|ming/iu.test(block.fontFamily) && !/sans/iu.test(block.fontFamily)
            ? '"Noto Serif CJK SC", "Songti SC", Georgia, "Times New Roman", serif'
            : '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';

        type MeasuredBlock = (typeof paintedBlocks)[number] & {
            fontSize: number;
            lines: string[];
            lineHeight: number;
            direction?: 'ltr' | 'rtl';
        };

        const layout: MeasuredBlock[] = [];
        for (const painted of paintedBlocks) {
            input.signal?.throwIfAborted();
            const family = familyForBlock(painted.block);
            const maxWidth = Math.max(1, painted.width * 0.985);
            const scale = Math.min(scaleX, scaleY);
            const fitting = () => fitPdfBlockText({
                text: painted.translation, width: maxWidth, height: painted.height,
                fontSize: painted.block.fontSize * scale,
                lineHeight: (painted.block.lineCount <= 1 ? painted.block.fontSize : painted.block.lineHeight) * scale,
                minFontSize: Math.max(6 * scale, painted.block.fontSize * scale * 0.5), weight: painted.block.fontWeight,
            }, (text, size, weight) => {context.font = `${weight} ${size}px ${family}`; return context.measureText(text).width;});
            let fit = fitting(), direction: 'ltr' | 'rtl' | undefined;
            if (!fit.overflow && fit.lines.length === 1) {
                const bidi = pdfFallbackBidiLine(fit.lines[0], painted.translation);
                if (bidi) {
                    const directed = withPdfFallbackBidiDirection(context, bidi.direction, fitting);
                    if (!directed.overflow && directed.lines.length === 1 && directed.lines[0] === painted.translation) {fit = directed; direction = bidi.direction;}
                }
            }
            let lines = fit.lines;
            if (fit.overflow) {
                overflowNotes.push({segmentIndex: painted.block.segmentIndex, text: painted.translation,
                    x: painted.block.x, y: painted.block.y, width: painted.width / scaleX, height: painted.height / scaleY});
                const visibleLines = Math.max(1, Math.floor((painted.height + fit.lineHeight * 0.25) / fit.lineHeight));
                lines = lines.slice(0, visibleLines);
                const characters = Array.from(lines.at(-1) ?? '');
                let low = 0, high = characters.length;
                context.font = `${painted.block.fontWeight} ${fit.fontSize}px ${family}`;
                while (low < high) {
                    const mid = Math.ceil((low + high) / 2);
                    if (context.measureText(characters.slice(0, mid).join('') + '…').width <= maxWidth) low = mid;
                    else high = mid - 1;
                }
                lines[lines.length - 1] = characters.slice(0, low).join('') + '…';
            }
            layout.push({...painted, fontSize: fit.fontSize, lines, lineHeight: fit.lineHeight, ...(direction ? {direction} : {})});
            if (layout.length % 8 === 0) yield;
        }

        if (rotation === 90) context.transform(0, 1, -1, 0, canvas.width, 0);
        else if (rotation === 180) context.transform(-1, 0, 0, -1, canvas.width, canvas.height);
        else if (rotation === 270) context.transform(0, -1, 1, 0, 0, canvas.height);
        // 步骤 2：先统一擦除全部原文字块，避免重叠块把已绘制的译文再次遮住。
        for (const [index, {block, x, y, padding, background}] of layout.entries()) {
            input.signal?.throwIfAborted();
            context.fillStyle = `rgb(${background[0]}, ${background[1]}, ${background[2]})`;
            const rectangles = block.lines?.flatMap(line => line.runs?.length ? line.runs : [line]);
            const erase = rectangles?.length ? rectangles.map(rect => ({x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY})) : [{x, y, width: block.width * scaleX, height: block.height * scaleY}];
            const boundary = block.cellBounds ?? block.panelBounds;
            erase.forEach(rect => {
                // 擦除向外覆盖整像素，遇到单元格或卡片边界时向内约束。
                const left = Math.max(0, Math.floor(rect.x - padding), boundary ? Math.ceil((boundary.x + 0.5) * scaleX) : 0);
                const top = Math.max(0, Math.floor(rect.y - padding), boundary ? Math.ceil((boundary.y + 0.5) * scaleY) : 0);
                const right = Math.min(virtualWidth, Math.ceil(rect.x + rect.width + padding), boundary ? Math.floor((boundary.x + boundary.width - 0.5) * scaleX) : virtualWidth);
                const bottom = Math.min(virtualHeight, Math.ceil(rect.y + rect.height + padding), boundary ? Math.floor((boundary.y + boundary.height - 0.5) * scaleY) : virtualHeight);
                if (right > left && bottom > top) context.fillRect(left, top, right - left, bottom - top);
            });
            if ((index + 1) % 16 === 0) yield;
        }

        // 步骤 3：在裁剪后的原坐标区域中绘制译文，保证多栏与图文混排不串位。
        for (const [index, {block, x, y, width, height, foreground, fontSize, lines, lineHeight, direction}] of layout.entries()) {
            input.signal?.throwIfAborted();
            const family = familyForBlock(block);
            const maxWidth = Math.max(1, width * 0.985);
            context.save();
            try {
                context.beginPath();
                context.rect(x, y, width, height);
                context.clip();
                context.fillStyle = foreground;
                context.textBaseline = 'top';
                if (direction) context.direction = direction;
                context.textAlign = block.textAlign;
                context.font = `${block.fontWeight} ${fontSize}px ${family}`;
                const textX = block.textAlign === 'center' ? x + width / 2 : block.textAlign === 'right' ? x + width : x;
                let textY = y;
                lines.forEach((line) => {
                    context.fillText(line, textX, textY, maxWidth);
                    if (line.trim()) {
                        const measuredWidth = Math.min(context.measureText(line).width, maxWidth);
                        const left = block.textAlign === 'center' ? textX - measuredWidth / 2 : block.textAlign === 'right' ? textX - measuredWidth : textX;
                        textItems.push({segmentIndex: block.segmentIndex, text: line, x: left / scaleX, y: textY / scaleY,
                            width: measuredWidth / scaleX, fontSize: fontSize / Math.min(scaleX, scaleY), ...(direction ? {direction} : {})});
                    }
                    textY += lineHeight;
                });
            } finally {context.restore();}
            if ((index + 1) % 16 === 0) yield;
        }
    } finally {if (rotation) context.restore();}
    return {canvas, overflowNotes, textItems};
}

/** 同步预览端口；下载端口分批推进相同绘制步骤，允许处理输入与取消。 */
export function paintPdfTranslation(sourceCanvas: HTMLCanvasElement, input: PdfRasterPageInput): HTMLCanvasElement {
    const steps = paintPdfTranslationSteps(sourceCanvas, input);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value.canvas;
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
        const original = await canvasToImageBytes(sourceCanvas, signal);
        const visibleTranslations = translations?.map((translation, segmentIndex) =>
            hasDistinctTranslation(document.segments[segmentIndex]?.source ?? '', translation) ? translation : '');
        if (!visibleTranslations || !page.segmentIndexes.some(index => visibleTranslations[index])) return {original};
        const translatedCanvas = paintPdfTranslation(sourceCanvas, {
            ...page,
            sourceBytes: document.binary.bytes,
            translations: visibleTranslations,
        });
        return {original, translated: await canvasToImageBytes(translatedCanvas, signal)};
    } finally {
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}

/** 以 300 dpi 渲染论文小字，限制九百万像素及 4096 长边；用完释放画布，只返回图像与像素尺寸。 */
export async function renderPdfPageImage(bytes: Uint8Array, pageNumber: number, width: number, signal?: AbortSignal): Promise<{image: string; width: number; height: number}> {
    const canvas = await renderPdfSourceCanvas(bytes, pageNumber, width, signal, true);
    try {
        // 渲染 Promise 结算后仍可能收到取消，避免继续同步编码数百万像素的过期页面。
        signal?.throwIfAborted();
        return {image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height};
    } finally {
        canvas.width = canvas.height = 0;
    }
}

export async function rasterizePdfTranslationPage(input: PdfRasterPageInput): Promise<Uint8Array | PdfRasterPageResult> {
    if (typeof globalThis.document === 'undefined') {
        throw new Error('当前环境无法生成 PDF 译文页面，请在浏览器扩展中下载');
    }
    const sourceCanvas = await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
    const steps = paintPdfTranslationSteps(sourceCanvas, input);
    try {
        input.signal?.throwIfAborted();
        let step = steps.next();
        while (!step.done) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            input.signal?.throwIfAborted();
            step = steps.next();
        }
        const format = input.imageFormat ?? 'png';
        const data = await canvasToImageBytes(sourceCanvas, input.signal, format);
        input.signal?.throwIfAborted();
        return {data, format, overflowNotes: step.value.overflowNotes, textItems: step.value.textItems};
    } finally {
        steps.return({canvas: sourceCanvas, overflowNotes: [], textItems: []});
        sourceCanvas.width = sourceCanvas.height = 0;
    }
}

/** 固定字号逐页编码；原版译文续页按最后一张的内容缩短页高，只保留一张源图和一张输出 Canvas。 */
export const rasterizePdfReadingPages: PdfReadingRasterizer = async function* (input) {
    if (typeof globalThis.document === 'undefined') throw new Error('当前环境无法生成 PDF 译文页面，请在浏览器扩展中下载');
    input.signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    let source: HTMLCanvasElement | undefined;
    let sourceLease: ReturnType<typeof acquirePdfDocument> | undefined;
    try {
        const context = canvas.getContext('2d', {alpha: false});
        if (!context) throw new Error('浏览器 Canvas 初始化失败');
        const family = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
        const pages = paginatePdfReadingPlan(input.plan, (text, font) => {
            context.font = `${font.weight} ${font.size}px ${family}`;
            return context.measureText(text).width;
        }, {compactLastPage: Boolean(input.footerLabel)});
        const lineCounts = new Map<number, number>();
        for (const page of pages) for (const item of page.items) if (item.kind === 'text') lineCounts.set(item.segmentIndex, (lineCounts.get(item.segmentIndex) ?? 0) + 1);
        if (pages.some(page => page.items.some(item => item.kind === 'region'))) {
            // 外部自定义 renderer 也可能因缺字进入内建回退；回退自身必须持有并释放源文档，不能依赖组合根的默认租约。
            sourceLease = acquirePdfDocument(input.sourceBytes);
            source = await renderPdfSourceCanvas(input.sourceBytes, input.pageNumber, input.width, input.signal);
        }
        for (const [pageIndex, page] of pages.entries()) {
            input.signal?.throwIfAborted();
            canvas.width = page.width * 2;
            canvas.height = page.height * 2;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.save();
            const textItems: PdfRasterTextItem[] = [];
            try {
                context.scale(2, 2);
                context.textBaseline = 'top';
                context.textAlign = 'left';
                context.fillStyle = '#18212f';
                for (const item of page.items) {
                    if (item.kind === 'text') {
                        context.font = `${item.font.weight} ${item.font.size}px ${family}`;
                        const candidate = lineCounts.get(item.segmentIndex) === 1 ? pdfFallbackBidiLine(item.text, input.translations[item.segmentIndex] ?? '') : undefined;
                        const measured = candidate ? withPdfFallbackBidiDirection(context, candidate.direction, () => context.measureText(item.text).width) : undefined;
                        const bidi = candidate && measured !== undefined && Number.isFinite(measured) && measured <= item.width ? candidate : undefined;
                        const paint = () => {context.fillText(item.text, item.x, item.y); return context.measureText(item.text).width;};
                        const width = bidi ? withPdfFallbackBidiDirection(context, bidi.direction, paint) : paint();
                        textItems.push({segmentIndex: item.segmentIndex, text: item.text,
                            x: item.x, y: item.y, width, fontSize: item.font.size, ...(bidi ? {direction: bidi.direction} : {})});
                    } else if (source) {
                        paintPdfReadingRegion(context, source, item, input);
                    }
                }
                if (input.footerLabel) {
                    const label = `${input.footerLabel} · ${pageIndex + 1}/${pages.length}`;
                    context.font = `400 9px ${family}`;
                    context.fillStyle = '#6b7280';
                    context.fillText(label, 44, page.height - 25);
                    textItems.push({segmentIndex: -1, text: label, x: 44, y: page.height - 25,
                        width: context.measureText(label).width, fontSize: 9});
                }
            } finally {context.restore();}
            const format = input.imageFormat ?? 'png';
            const bytes = await canvasToImageBytes(canvas, input.signal, format);
            input.signal?.throwIfAborted();
            yield {bytes, width: page.width, height: page.height, format, textItems, items: page.items};
            input.signal?.throwIfAborted();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } finally {
        canvas.width = canvas.height = 0;
        if (source) source.width = source.height = 0;
        sourceLease?.release();
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
                regionImage = await canvasToImageBytes(canvas, input.signal);
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
