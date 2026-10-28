/**
 * @file src/features/document-translation/ui/pdfReader.ts
 * 文件职责：为 PDF 阅读器提供有界页面调度和浏览器原页渲染，使用锁定版本的 PDF.js TextLayer 让文字选择与原版面一致。
 * 主要内容：按可见页优先维护五页窗口与两项并发；离屏、缩放和卸载取消迟到任务；重排裁剪使用界面当前的原图区域，仅区域标识或几何变化使缓存失效，普通译文更新不重绘；译文页只复制一次原页像素，译文文字由阅读器叠加；直接绘制 Canvas 而不编码 PNG，单页总像素与边长有上限；共享 PDF 加载租约，失败可重试且资源只释放一次。
 * 模块边界：调度器只调用注入的渲染端口；浏览器渲染端口依赖 PDF.js 和文档预览资源，不发起翻译请求、不修改原始文件或负责入口挂载。
 */
import type {PDFPageProxy, TextLayer} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {DocumentRenderMode, ParsedDocument, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {acquirePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import {buildPdfReadingPlan, type PdfReadingPresentation, type PdfReadingRect, type PdfReadingRegionEntry} from '@/src/features/document-translation/core/pdfReadingPlan';

export type PdfReaderMode = 'source' | DocumentRenderMode;
export const PDF_READER_MAX_RESIDENT_PAGES = 5;
/** 一页的全部画布（对照阅读时是原文与译文两张）合计的像素上限：足够在高分屏上按 2 倍像素比渲染整页，又只有 PDF.js 默认单页上限的一半。 */
export const PDF_READER_MAX_PAGE_PIXELS = 8_000_000;
export const PDF_READER_MAX_CANVAS_EDGE = 8192;
export const PDF_READER_RENDER_CONCURRENCY = 2;
let pdfJsModule: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>;

export interface PdfReaderSettings {
    scale: number;
    mode: PdfReaderMode;
    presentation?: PdfReadingPresentation;
    /** 与界面同页计划一致的裁剪范围；显式空数组表示当前没有原图区域，未提供才使用兼容源计划。 */
    regionEntries?: readonly PdfReadingRegionEntry[];
    /** 缩放、阅读方式或原图区域变化才使该页失效；普通译文更新不触发重绘。 */
    key: string;
}

export interface PdfReaderRenderedPage {
    sourceCanvas?: HTMLCanvasElement;
    sourceText?: HTMLElement;
    translatedCanvas?: HTMLCanvasElement;
    regions?: ReadonlyMap<string, HTMLCanvasElement>;
    dispose: () => void;
}

export type PdfReaderPageState =
    | {status: 'loading'}
    | {status: 'ready'; output: PdfReaderRenderedPage}
    | {status: 'error'; message: string};

export interface PdfReaderRenderPort {
    render: (page: PdfDocumentPage, settings: PdfReaderSettings, signal: AbortSignal) => Promise<PdfReaderRenderedPage>;
    dispose: () => void;
}

/** 把视口附近页按距离排序，可见页面始终排在预取页前。 */
export function pdfReaderPageWindow(pageCount: number, currentIndex: number, visibleIndexes: readonly number[] = []): number[] {
    if (pageCount <= 0) return [];
    const current = Math.max(0, Math.min(pageCount - 1, currentIndex));
    const visible = [...new Set(visibleIndexes)].filter(index => index >= 0 && index < pageCount);
    visible.sort((left, right) => Math.abs(left - current) - Math.abs(right - current));
    const candidates = [...visible, current];
    for (let distance = 1; distance <= PDF_READER_MAX_RESIDENT_PAGES; distance += 1) {
        if (current + distance < pageCount) candidates.push(current + distance);
        if (current - distance >= 0) candidates.push(current - distance);
    }
    return [...new Set(candidates)].slice(0, PDF_READER_MAX_RESIDENT_PAGES);
}

/** 画布像素限制在源文与译文的合计预算中；预算内固定按 2 倍像素比渲染，CSS 缩放与文本层不受影响。 */
export function pdfReaderCanvasSize(width: number, height: number, _devicePixelRatio: number, canvasCount = 1, pixelBudget = PDF_READER_MAX_PAGE_PIXELS): {width: number; height: number; outputScale: number} {
    if (!Number.isFinite(pixelBudget) || pixelBudget < 1) throw new RangeError('PDF 页面像素预算不足');
    const pixelLimit = Math.floor(pixelBudget);
    const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
    const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
    const outputScale = Math.min(
        // 至少按 2 倍超采样：1 倍屏上细小的论文字形经缩小后更锐利，窗口报告的像素比偏低时也不会发虚。
        2,
        Math.sqrt(pixelLimit / Math.max(1, canvasCount) / safeWidth / safeHeight),
        PDF_READER_MAX_CANVAS_EDGE / Math.max(safeWidth, safeHeight),
        pixelLimit / Math.max(safeWidth, safeHeight),
    );
    return {width: Math.max(1, Math.floor(safeWidth * outputScale)), height: Math.max(1, Math.floor(safeHeight * outputScale)), outputScale};
}

/** 原图区域身份和坐标变更才重裁剪；键不含译文、角色或片段关联，区域插入顺序变化也不重绘原像素。 */
export function pdfReaderPageKey(page: PdfDocumentPage, scale: number, mode: PdfReaderMode, presentation?: PdfReadingPresentation, regionEntries?: readonly PdfReadingRegionEntry[]): string {
    if (presentation === 'readable') {
        const regions = regionEntries?.map(entry => ({id: entry.id, rect: [entry.sourceRect.x, entry.sourceRect.y, entry.sourceRect.width, entry.sourceRect.height]}))
            .sort((left, right) => left.id.localeCompare(right.id));
        return JSON.stringify([scale, mode, presentation, page.blocks, (page as PdfDocumentPage & {preservedRegions?: unknown}).preservedRegions, ...(regions === undefined ? [] : [regions])]);
    }
    return JSON.stringify([scale, mode]);
}

/** 原坐标裁剪映射到实际展示旋转，不改变原画布或源文件。 */
export function pdfReaderDisplayRect(rect: PdfReadingRect, page: PdfDocumentPage): PdfReadingRect {
    if (page.rotation === 90) return {x: page.width - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width};
    if (page.rotation === 180) return {x: page.width - rect.x - rect.width, y: page.height - rect.y - rect.height, width: rect.width, height: rect.height};
    if (page.rotation === 270) return {x: rect.y, y: page.height - rect.x - rect.width, width: rect.height, height: rect.width};
    return rect;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, releaseLate?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        promise.then(value => {
            if (signal.aborted) {releaseLate?.(value); return;}
            resolve(value);
        }, reject).catch(reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** 原页 Canvas 与 PDF.js 文本流同时渲染；任何取消都会立即释放像素与 DOM。 */
export function createPdfReaderRenderPort(document: ParsedDocument): PdfReaderRenderPort {
    const binary = document.binary;
    if (binary?.kind !== 'pdf') throw new Error('PDF 文档状态无效，请重新打开文件');
    let lease: ReturnType<typeof acquirePdfDocument> | undefined;
    let disposed = false;
    const activeControllers = new Set<AbortController>();
    const resource = () => {
        if (lease?.signal.aborted) {lease.release(); lease = undefined;}
        if (!lease) {
            const next = acquirePdfDocument(binary.bytes);
            lease = next;
            void next.promise.catch(() => {if (lease === next) {next.release(); lease = undefined;}});
        }
        return lease;
    };
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            activeControllers.forEach(controller => controller.abort());
            lease?.release();
            lease = undefined;
        },
        render: async (model, settings, signal) => {
            if (disposed) throw new DOMException('PDF 阅读器已关闭', 'AbortError');
            signal.throwIfAborted();
            const shared = resource();
            const controller = new AbortController();
            activeControllers.add(controller);
            const abort = () => controller.abort(signal.reason);
            const unload = () => controller.abort(shared.signal.reason);
            signal.addEventListener('abort', abort, {once: true});
            shared.signal.addEventListener('abort', unload, {once: true});
            let page: PDFPageProxy | undefined;
            let canvas: HTMLCanvasElement | undefined;
            let translatedCanvas: HTMLCanvasElement | undefined;
            let text: HTMLElement | undefined;
            let textLayer: TextLayer | undefined;
            const regions = new Map<string, HTMLCanvasElement>();
            let renderTask: ReturnType<PDFPageProxy['render']> | undefined;
            let released = false;
            let completed = false;
            const dispose = () => {
                if (released) return;
                released = true;
                renderTask?.cancel();
                textLayer?.cancel();
                text?.replaceChildren();
                text?.remove();
                for (const entry of [canvas, translatedCanvas, ...regions.values()]) {
                    if (!entry) continue;
                    entry.width = entry.height = 0;
                    entry.remove();
                }
            };
            controller.signal.addEventListener('abort', dispose, {once: true});
            try {
                const pdf = await abortable(shared.promise, controller.signal);
                page = await abortable(pdf.getPage(model.pageNumber), controller.signal, late => {late.cleanup();});
                controller.signal.throwIfAborted();
                const module = await abortable(pdfJsModule ||= import('pdfjs-dist/legacy/build/pdf.mjs'), controller.signal);
                controller.signal.throwIfAborted();
                const viewport = page.getViewport({scale: settings.scale});
                const readable = settings.presentation === 'readable';
                const showSource = settings.mode !== 'translated';
                const regionEntries = readable && settings.mode !== 'source'
                    ? settings.regionEntries ?? buildPdfReadingPlan(document, model, []).entries.filter(entry => entry.kind === 'region') : [];
                const regionArea = regionEntries.reduce((sum, entry) => sum + entry.sourceRect.width * entry.sourceRect.height * settings.scale ** 2, 0);
                const canvasCount = readable ? 1 + regionArea / Math.max(1, viewport.width * viewport.height) : settings.mode === 'bilingual' ? 2 : 1;
                // 每个原图至少占一个像素；先预留，防止超细区域的向上取整累积突破上限。
                const size = pdfReaderCanvasSize(viewport.width, viewport.height, window.devicePixelRatio, canvasCount, PDF_READER_MAX_PAGE_PIXELS - regionEntries.length);
                canvas = globalThis.document.createElement('canvas');
                canvas.width = size.width;
                canvas.height = size.height;
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;
                canvas.setAttribute('aria-hidden', 'true');
                canvas.setAttribute('data-pdf-resource', 'source');
                // 仅译文原版排版直接从此画布逐段取色；其他源画布无需牺牲绘制加速。
                const context = canvas.getContext('2d', {alpha: false, ...(!readable && !showSource ? {willReadFrequently: true} : {})});
                if (!context) throw new Error('浏览器 Canvas 初始化失败');
                renderTask = page.render({canvasContext: context, viewport, transform: [size.outputScale, 0, 0, size.outputScale, 0, 0], background: '#ffffff'});
                const work = [abortable(renderTask.promise, controller.signal)];
                if (showSource) {
                    text = globalThis.document.createElement('div');
                    text.className = 'fluentread-pdf-text-layer';
                    text.setAttribute('data-fluentread-pdf-text', '');
                    text.setAttribute('data-pdf-page-number', String(model.pageNumber));
                    text.style.setProperty('--scale-factor', String(viewport.scale));
                    textLayer = new module.TextLayer({textContentSource: page.streamTextContent(), container: text, viewport});
                    work.push(abortable(textLayer.render(), controller.signal));
                }
                await Promise.all(work);
                controller.signal.throwIfAborted();
                if (text && textLayer) text.setAttribute('data-fluentread-pdf-page-text', textLayer.textContentItemsStr.join(' '));
                if (readable) {
                    let remainingPixels = PDF_READER_MAX_PAGE_PIXELS - canvas.width * canvas.height;
                    for (const [index, entry] of regionEntries.entries()) {
                        controller.signal.throwIfAborted();
                        const rect = pdfReaderDisplayRect(entry.sourceRect, model);
                        const crop = globalThis.document.createElement('canvas');
                        regions.set(entry.id, crop);
                        const width = Math.max(1, Math.floor(entry.sourceRect.width * settings.scale * size.outputScale));
                        const height = Math.max(1, Math.floor(entry.sourceRect.height * settings.scale * size.outputScale));
                        const availablePixels = remainingPixels - (regionEntries.length - index - 1);
                        const limit = Math.min(1, Math.sqrt(availablePixels / (width * height)), availablePixels / Math.max(width, height));
                        crop.width = Math.max(1, Math.floor(width * limit));
                        crop.height = Math.max(1, Math.floor(height * limit));
                        remainingPixels -= crop.width * crop.height;
                        const cropContext = crop.getContext('2d', {alpha: false});
                        if (!cropContext) throw new Error('浏览器 Canvas 初始化失败');
                        // 原页维持 PDF 的展示旋转，阅读流与导出把公式、图表恢复到解析时的正常朝向。
                        cropContext.save();
                        try {
                            if (model.rotation === 90) {cropContext.translate(0, crop.height); cropContext.rotate(-Math.PI / 2);}
                            else if (model.rotation === 180) {cropContext.translate(crop.width, crop.height); cropContext.rotate(-Math.PI);}
                            else if (model.rotation === 270) {cropContext.translate(crop.width, 0); cropContext.rotate(Math.PI / 2);}
                            const quarterTurn = model.rotation === 90 || model.rotation === 270;
                            cropContext.drawImage(canvas, rect.x * settings.scale * size.outputScale, rect.y * settings.scale * size.outputScale,
                                rect.width * settings.scale * size.outputScale, rect.height * settings.scale * size.outputScale,
                                0, 0, quarterTurn ? crop.height : crop.width, quarterTurn ? crop.width : crop.height);
                        } finally {cropContext.restore();}
                        crop.style.width = '100%'; crop.style.height = 'auto';
                        crop.setAttribute('role', 'img');
                        crop.setAttribute('data-pdf-resource', 'region');
                        crop.setAttribute('data-pdf-region-id', entry.id);
                        crop.setAttribute('data-pdf-source-rect', JSON.stringify(entry.sourceRect));
                    }
                    if (!showSource) canvas.width = canvas.height = 0;
                } else if (settings.mode !== 'source') {
                    // 译文页以原页像素为底：图表、公式和尚未翻译的段落保持原样，译文段落由阅读器的文字层覆盖。
                    if (showSource) {
                        translatedCanvas = globalThis.document.createElement('canvas');
                        translatedCanvas.width = canvas.width;
                        translatedCanvas.height = canvas.height;
                        translatedCanvas.style.width = canvas.style.width;
                        translatedCanvas.style.height = canvas.style.height;
                        translatedCanvas.setAttribute('aria-hidden', 'true');
                        const translatedContext = translatedCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
                        if (!translatedContext) throw new Error('浏览器 Canvas 初始化失败');
                        translatedContext.drawImage(canvas, 0, 0);
                    } else translatedCanvas = canvas;
                    translatedCanvas.setAttribute('data-pdf-resource', 'translation');
                }
                controller.signal.throwIfAborted();
                completed = true;
                return {sourceCanvas: showSource ? canvas : undefined, sourceText: text, translatedCanvas, ...(readable ? {regions} : {}), dispose};
            } finally {
                controller.signal.removeEventListener('abort', dispose);
                signal.removeEventListener('abort', abort);
                shared.signal.removeEventListener('abort', unload);
                activeControllers.delete(controller);
                if (!completed) dispose();
                try {page?.cleanup();} catch (error) {dispose(); throw error;}
            }
        },
    };
}

interface ReaderEntry {
    settings: PdfReaderSettings;
    controller?: AbortController;
    state: PdfReaderPageState;
}

/** 任务拥有自己的代次；取消后即使端口晚到成功，也只能释放结果，不能占有当前页面。 */
export class PdfReaderScheduler {
    private readonly entries = new Map<number, ReaderEntry>();
    private wanted: number[] = [];
    private settings!: (index: number) => PdfReaderSettings;
    private running = 0;
    private disposed = false;

    constructor(
        private readonly pages: readonly PdfDocumentPage[],
        private readonly port: PdfReaderRenderPort,
        private readonly onChange: (pageNumber: number, state?: PdfReaderPageState) => void,
    ) {}

    update(priorityIndexes: readonly number[], settings: (index: number) => PdfReaderSettings): void {
        if (this.disposed) return;
        this.wanted = [...new Set(priorityIndexes)].filter(index => this.pages[index]).slice(0, PDF_READER_MAX_RESIDENT_PAGES);
        this.settings = settings;
        for (const [index, entry] of this.entries) {
            if (!this.wanted.includes(index) || entry.settings.key !== settings(index).key) this.evict(index, entry);
        }
        this.pump();
    }

    retry(index: number): void {
        const entry = this.entries.get(index);
        if (entry?.state.status === 'error') this.evict(index, entry);
        this.pump();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.wanted = [];
        for (const [index, entry] of this.entries) this.evict(index, entry);
        this.port.dispose();
    }

    private evict(index: number, entry: ReaderEntry): void {
        this.entries.delete(index);
        entry.controller?.abort();
        if (entry.state.status === 'ready') entry.state.output.dispose();
        this.onChange(this.pages[index].pageNumber);
    }

    private pump(): void {
        if (this.disposed) return;
        for (const index of this.wanted) {
            if (this.running >= PDF_READER_RENDER_CONCURRENCY) break;
            if (this.entries.has(index)) continue;
            const controller = new AbortController();
            const entry: ReaderEntry = {settings: this.settings(index), controller, state: {status: 'loading'}};
            this.entries.set(index, entry);
            this.running += 1;
            this.onChange(this.pages[index].pageNumber, entry.state);
            void this.port.render(this.pages[index], entry.settings, controller.signal).then(output => {
                if (this.disposed || controller.signal.aborted || this.entries.get(index) !== entry) {output.dispose(); return;}
                entry.state = {status: 'ready', output};
                entry.controller = undefined;
                this.onChange(this.pages[index].pageNumber, entry.state);
            }, error => {
                if (this.disposed || controller.signal.aborted || this.entries.get(index) !== entry) return;
                entry.state = {status: 'error', message: error instanceof Error ? error.message : String(error)};
                entry.controller = undefined;
                this.onChange(this.pages[index].pageNumber, entry.state);
            }).finally(() => {this.running -= 1; this.pump();});
        }
    }
}
