/**
 * @file src/features/document-translation/ui/pdfHypothesis.ts
 * 文件职责：把虚拟化 PDF 阅读器适配到官方 Hypothesis 的 PDF.js 契约。
 * 主要内容：复用文档租约并有界取得真实页面代理，按需创建未渲染页定位占位；原版使用标准 PDF 指纹，重排按可见文字生成独立指纹，避免不同文本顺序或译文混用位置选择器。
 * 模块边界：不渲染额外 Canvas、不请求批注服务、不上传文件；DOM 与页面状态由阅读器端口提供，关闭时撤销全局适配和自身占位。
 */
import type {PDFDocumentProxy, PDFPageProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {pdfHypothesisUrl} from '../core/pdfAnnotations';

export interface PdfHypothesisPorts {
    window: Window;
    viewport: HTMLElement;
    viewer: HTMLElement;
    container: HTMLElement;
    sourceUrl: string;
    /** 重排文字快照包括当前视图的原文与译文，须与文字层 textContent 一致。 */
    text?: readonly string[];
    acquire(): {promise: Promise<PDFDocumentProxy>; release(): void};
    page(index: number): {frame: HTMLElement; text?: HTMLElement} | undefined;
    top(index: number): number;
}
export async function installPdfHypothesisAdapter(ports: PdfHypothesisPorts, signal: AbortSignal): Promise<() => void> {
    const lease = ports.acquire();
    const placeholders = new Map<number, HTMLElement>();
    const ownedClasses = new Map<HTMLElement, string[]>();
    const previousId = ports.viewport.id;
    const previousContainerId = ports.container.id, previousViewerId = ports.viewer.id, previousHeight = ports.container.style.height;
    const scope = ports.window as Window & {PDFViewerApplication?: unknown};
    const previous = scope.PDFViewerApplication;
    function cleanup(): void {
        placeholders.forEach(element => element.remove()); placeholders.clear();
        ownedClasses.forEach((classes, element) => classes.forEach(name => element.classList.remove(name)));
        ports.viewport.id = previousId;
        ports.container.id = previousContainerId; ports.viewer.id = previousViewerId;
        ports.container.style.height = previousHeight;
        ports.container.style.width = previousWidth;
        if (previous === undefined) delete scope.PDFViewerApplication; else scope.PDFViewerApplication = previous;
        lease.release();
    }
    const previousWidth = ports.container.style.width;
    try {
        const pdf = await lease.promise;
        signal.throwIfAborted();
        const pages: PDFPageProxy[] = new Array(pdf.numPages);
        let next = 0;
        await Promise.all(Array.from({length: Math.min(4, pdf.numPages)}, async () => {
            while (next < pages.length) {
                const index = next++;
                signal.throwIfAborted(); pages[index] = await pdf.getPage(index + 1); signal.throwIfAborted();
            }
        }));
        const fingerprint = ports.text ? `${pdf.fingerprints[0]}-fr-${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ports.text.join('\n')))), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}` : undefined;
        signal.throwIfAborted();
        function classes(element: HTMLElement, values: string[]): void {
            const owned = ownedClasses.get(element) ?? [];
            for (const name of values) if (!element.classList.contains(name)) {element.classList.add(name); owned.push(name);}
            ownedClasses.set(element, owned);
        }
        function frame(index: number): HTMLElement {
            const resident = ports.page(index);
            if (resident) {
                placeholders.get(index)?.remove(); placeholders.delete(index);
                classes(resident.frame, ['page']);
                if (resident.text) classes(resident.text, ['textLayer']);
                return resident.frame;
            }
            let placeholder = placeholders.get(index);
            if (!placeholder) {
                placeholder = ports.viewer.ownerDocument.createElement('div');
                placeholder.dataset.fluentreadHypothesisPlaceholder = '';
                placeholder.style.cssText = 'position:absolute;left:50%;width:1px;height:1px;pointer-events:none';
                ports.viewer.append(placeholder); placeholders.set(index, placeholder);
            }
            placeholder.style.top = `${ports.top(index)}px`;
            return placeholder;
        }
        const views = pages.map((page, index) => ({
            get div() {return frame(index);},
            get textLayer() {
                const value = ports.page(index)?.text;
                if (value) frame(index);
                return value ? {div: value, renderingDone: true} : null;
            },
            get renderingState() {return ports.page(index)?.text ? 3 : 0;},
            pdfPage: ports.text ? new Proxy(page, {get(target, key) {
                if (key === 'getTextContent') return async () => ({items: [{str: ports.text![index]}]});
                const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
            }}) : page,
        }));
        const document = fingerprint ? new Proxy(pdf, {get(target, key) {
            if (key === 'fingerprints') return [fingerprint];
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        }}) : pdf;
        pages.forEach((_page, index) => {if (ports.page(index)) frame(index);});
        ports.viewport.id = 'viewerContainer';
        ports.container.id = 'outerContainer'; ports.viewer.id = 'viewer';
        scope.PDFViewerApplication = {initializedPromise: Promise.resolve(), downloadComplete: true,
            // 带访问令牌的地址、局域网地址与本地路径不交给协作服务。
            url: fingerprint ? '' : pdfHypothesisUrl(ports.sourceUrl)?.replace('https://via.hypothes.is/', '') ?? '',
            appConfig: {appContainer: ports.container}, pdfDocument: document,
            pdfViewer: {viewer: ports.viewer, pagesCount: pdf.numPages, getPageView: (index: number) => views[index],
                currentScaleValue: 'custom', update() {placeholders.forEach((element, index) => {element.style.top = `${ports.top(index)}px`;});}},
        };
        return cleanup;
    } catch (error) {cleanup(); throw error;}
}
