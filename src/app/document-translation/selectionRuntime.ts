/**
 * @file src/app/document-translation/selectionRuntime.ts
 * 文件职责：在扩展自有文档页中按需复用划词卡片，接受 PDF.js 原文选区；存在文档模型适配器时也接受当前原版译文与重排段落选区。
 * 主要内容：等待配置水合和首个 PDF 文字层再加载卡片，提供跨页来源校验、排版换行清理、文件标题与页内上下文；在 closed Shadow Root 中复用 Vue、i18n 和构建样式，并在禁用、原文视图消失、页面卸载或异步挂载过期时释放所有资源。
 * 模块边界：本文件是扩展页面组合适配器，不伪造 ContentScriptContext、不实现翻译或朗读协议、不读取或转发凭据；原生批注动作经组合层回调交给文档阅读器，不修改 PDF 原文与浏览器原生选区。
 */
import {createApp, type App, type Component} from 'vue';
import browser from 'webextension-polyfill';
import {addRuntimeMessageListener} from '@/src/platform/browser/runtimeMessages';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {createUiI18nPlugin} from '@/src/ui/i18n';
import {summarizeSelectionContext} from '@/src/features/selection-translation/core';
import {sentenceAroundSelection} from '@/src/features/reading-assistant/selectionContext';
import type {ReadingSelection} from '@/src/features/reading-assistant/public';
import type {MaterialSelection} from '@/src/features/vocabulary/material/protocol';

export const PDF_SOURCE_TEXT_SELECTOR = '[data-fluentread-pdf-text]';
const PDF_MATERIAL_TEXT_SELECTOR = `${PDF_SOURCE_TEXT_SELECTOR},.pdf-reading-paragraph[data-pdf-segment-index],.pdf-translation-text`;
const selectionSelector = (translated: boolean) => translated ? PDF_MATERIAL_TEXT_SELECTOR : PDF_SOURCE_TEXT_SELECTOR;
const selectionExcluded = (translated: boolean) => translated ? EXCLUDED_SOURCE.replace('[data-fluentread-pdf-translation],', '') : EXCLUDED_SOURCE;
export const PDF_SELECTION_RANGE_CHANGE = 'fluentread-pdf-selection-range-change';
const EXCLUDED_SOURCE = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-fluentread-pdf-translation],[data-notranslate="true"],[hidden],[inert],[aria-hidden="true"]';

interface PdfSelectionContext {text: string; title: string; sourceUrl: string;}
interface PdfSelectionAdapter {
    acceptsRange(range: Range): boolean;
    extractText(range: Range, nativeText: string): string;
    normalizeText(text: string): string;
    context(range: Range, text: string, limit: number): PdfSelectionContext;
    captureReading(range: Range, text: string, limit: number): ReadingSelection;
    captureMaterial?(range: Range, quote: string): MaterialSelection | undefined;
    markSelection?: DocumentSelectionRuntimeOptions['markSelection'];
    canMarkSelection?: (range: Range) => boolean;
    subscribeInvalidation(listener: () => void): () => void;
    invalidate(): void;
}
interface SelectionOverlay {dispose(): void; translateSelection?(): boolean;}
interface OverlayMountOptions {
    root: HTMLElement;
    adapter: PdfSelectionAdapter;
    isCurrent(): boolean;
    onSelectionRangeChange(range: Range | null): void;
}
export interface DocumentSelectionRuntimeOptions {
    root: HTMLElement;
    captureMaterial?: (range: Range, quote: string) => MaterialSelection | undefined;
    markSelection?: (range: Range, kind: 'highlight' | 'underline') => boolean;
    onSelectionRangeChange?: (range: Range | null) => void;
}
export interface DocumentSelectionRuntimeDependencies {
    ready: PromiseLike<unknown>;
    enabled(): boolean;
    subscribe(listener: () => void): () => void;
    mountOverlay(options: OverlayMountOptions): Promise<SelectionOverlay | null>;
    onError(error: unknown): void;
    installContextMenu?: (translate: () => Promise<boolean>) => () => void;
}

interface ContextMenuRuntimePort {
    id?: string;
    getURL?(path: string): string;
    onMessage?: {addListener(listener: (...args: any[]) => any): void; removeListener(listener: (...args: any[]) => any): void};
}
export interface DocumentSelectionContextMenuDependencies {
    runtime: ContextMenuRuntimePort | undefined;
    getCurrentTab(): Promise<{id?: number} | undefined>;
}

/** 仅处理发给当前文档标签的后台右键指令，扩展 UI 页面和普通网页均不能借此调用卡片。 */
export function installDocumentSelectionContextMenu(
    translate: () => Promise<boolean>,
    dependencies: DocumentSelectionContextMenuDependencies = {
        runtime: browser.runtime,
        getCurrentTab: () => browser.tabs.getCurrent(),
    },
): () => void {
    let disposed = false;
    let unsubscribe = () => {};
    const runtime = dependencies.runtime;
    void Promise.resolve().then(dependencies.getCurrentTab).then(tab => {
        const tabId = tab?.id;
        if (disposed || !runtime?.id || !Number.isInteger(tabId) || Number(tabId) < 0) return;
        const listener = (message: unknown, sender: {id?: string; url?: string; tab?: unknown}, sendResponse: (response: unknown) => void) => {
            if (!message || typeof message !== 'object') return undefined;
            const request = message as {type?: unknown; tabId?: unknown};
            if (disposed || request.type !== 'documentSelectionTranslate' || request.tabId !== tabId
                || sender?.id !== runtime.id || sender.tab !== undefined) return undefined;
            if (sender.url !== undefined) {
                try {
                    const url = new URL(sender.url);
                    const extensionUrl = new URL(runtime.getURL?.('/') || '');
                    if (url.origin !== extensionUrl.origin || url.host !== extensionUrl.host || url.protocol !== extensionUrl.protocol
                        || !['/background.js', '/background.html', '/_generated_background_page.html'].includes(url.pathname)) return undefined;
                } catch {return undefined;}
            }
            void translate().then(shown => {if (!disposed) sendResponse({status: shown ? 'success' : 'disabled'});})
                .catch(() => {if (!disposed) sendResponse({status: 'failed'});});
            return true;
        };
        unsubscribe = addRuntimeMessageListener(runtime, listener);
    }).catch(() => undefined);
    return () => {if (disposed) return; disposed = true; unsubscribe();};
}

/** 清理 PDF 排版产生的空白与软连字符；可见的作者连字符保留，避免猜测改变词义。 */
export function normalizePdfSelectionText(text: string): string {
    return text.replace(/\u00ad/gu, '')
        .replace(/([\p{L}\p{N}])-\s*\r?\n\s*(?=[\p{L}\p{N}])/gu, '$1-')
        .replace(/[\s\u00a0]+/gu, ' ').trim();
}

function boundaryElement(node: Node): Element | null {
    return node.nodeType === 1 ? node as Element : node.parentElement;
}

function sourceForNode(node: Node, root: HTMLElement, translated = false): HTMLElement | null {
    const element = boundaryElement(node);
    const source = element?.closest<HTMLElement>(selectionSelector(translated));
    if (!source || !root.contains(source) || element?.closest(selectionExcluded(translated))) return null;
    let current: HTMLElement | null = source;
    while (current && current !== root) {
        if (current.style?.display === 'none' || current.style?.visibility === 'hidden') return null;
        current = current.parentElement;
    }
    return source;
}

function firstSource(root: HTMLElement, translated = false): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>(selectionSelector(translated))).find(source => sourceForNode(source, root, translated)) ?? null;
}

function sourceOwner(source: HTMLElement | null): {element: Element | null; identity: string} {
    const element = source?.closest('[data-fluentread-pdf-document-id],[data-fluentread-pdf-title]') ?? null;
    return {element, identity: [element?.getAttribute('data-fluentread-pdf-document-id'),
        element?.getAttribute('data-fluentread-pdf-title'), element?.getAttribute('data-fluentread-pdf-source-url')].join('|')};
}

/** 跨页选区可以经过 PDF 画布和页面空白，但不能包含文件控件、校订输入；只有持有模型的适配器可接受译文。 */
export function acceptsPdfSourceRange(range: Range, root: HTMLElement, translated = false): boolean {
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false;
    const startSource = sourceForNode(range.startContainer, root, translated);
    const endSource = sourceForNode(range.endContainer, root, translated);
    if (!startSource || !endSource) return false;
    if (startSource === endSource) return true;
    const fragment = range.cloneContents();
    const walker = root.ownerDocument.createTreeWalker(fragment, 4);
    let node: Node | null;
    let visited = 0;
    while ((node = walker.nextNode())) {
        if (++visited > 5000) return false;
        if (!node.textContent?.trim()) continue;
        const element = boundaryElement(node);
        if (element?.closest('[data-fluentread-pdf-decoration]') && !element.closest(selectionExcluded(translated))) continue;
        if (!element?.closest(selectionSelector(translated)) || element.closest(selectionExcluded(translated))) return false;
    }
    return true;
}

/** 单页保留浏览器按字形生成的空白；跨页仅收集克隆选区中的原文，排除页码与阅读工具说明。 */
export function extractPdfSelectionText(range: Range, nativeText: string, root: HTMLElement, translated = false): string {
    const startSource = sourceForNode(range.startContainer, root, translated);
    const endSource = sourceForNode(range.endContainer, root, translated);
    if (!startSource || !endSource) return '';
    if (startSource === endSource) return nativeText;
    const fragment = range.cloneContents();
    const walker = root.ownerDocument.createTreeWalker(fragment, 5);
    const parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const element = boundaryElement(node);
        if (!element?.closest(selectionSelector(translated)) || element.closest(selectionExcluded(translated))
            || element.closest('[data-fluentread-pdf-decoration]')) continue;
        if (node.nodeType === 3) parts.push((node as Text).data);
        else if (element.tagName === 'BR' || element.matches(selectionSelector(translated))) parts.push('\n');
    }
    return parts.join('');
}

function sourceContext(range: Range, text: string, limit: number, root: HTMLElement, translated = false): PdfSelectionContext {
    const source = sourceForNode(range.startContainer, root, translated);
    const metadata = source?.closest<HTMLElement>('[data-fluentread-pdf-title]');
    const title = metadata?.getAttribute('data-fluentread-pdf-title')?.trim().slice(0, 512) || '';
    const rawUrl = source?.closest('[data-fluentread-pdf-source-url]')?.getAttribute('data-fluentread-pdf-source-url');
    let sourceUrl = '';
    if (rawUrl) {
        try {
            const url = new URL(rawUrl);
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                url.username = ''; url.password = ''; url.search = ''; url.hash = '';
                sourceUrl = url.href;
            }
        } catch { /* 导入文件没有公网来源；不把内部扩展网址冒充文件网址。 */ }
    }
    const pageText = limit > 0 && source
        ? normalizePdfSelectionText(source.getAttribute('data-fluentread-pdf-page-text') || source.innerText || source.textContent || '').slice(0, 32_000) : '';
    return {title, sourceUrl, text: summarizeSelectionContext(pageText, text, Math.min(4000, Math.max(0, limit)))};
}

export function createPdfSelectionAdapter(root: HTMLElement, captureMaterial?: DocumentSelectionRuntimeOptions['captureMaterial'], markSelection?: DocumentSelectionRuntimeOptions['markSelection']): PdfSelectionAdapter {
    const translated = Boolean(captureMaterial);
    const invalidations = new Set<() => void>();
    return {
        acceptsRange: range => acceptsPdfSourceRange(range, root, translated),
        extractText: (range, nativeText) => extractPdfSelectionText(range, nativeText, root, translated),
        normalizeText: normalizePdfSelectionText,
        context: (range, text, limit) => sourceContext(range, text, limit, root, translated),
        captureMaterial: captureMaterial ? (range, quote) => acceptsPdfSourceRange(range, root, true) ? captureMaterial(range, quote) : undefined : undefined,
        markSelection: markSelection ? (range, kind) => acceptsPdfSourceRange(range, root, translated) && markSelection(range, kind) : undefined,
        canMarkSelection: markSelection ? range => {
            const source = sourceForNode(range.startContainer, root, translated);
            return Boolean(source && source === sourceForNode(range.endContainer, root, translated)
                && source.matches(`${PDF_SOURCE_TEXT_SELECTOR},.pdf-reading-paragraph`));
        } : undefined,
        captureReading(range, text, limit) {
            const context = sourceContext(range, text, limit, root, translated).text;
            return {text, context, sentence: context ? sentenceAroundSelection(context, text) : text};
        },
        subscribeInvalidation(listener) {invalidations.add(listener); return () => invalidations.delete(listener);},
        invalidate() {invalidations.forEach(listener => listener());},
    };
}

/** 扩展页面中已有的同源构建样式同时放进 Shadow Root，包含卡片和阅读子组件的 scoped CSS。 */
function mirrorPageStyles(document: Document, shadow: ShadowRoot): () => void {
    const copies = new Map<Element, Element>();
    const sync = () => {
        const originals = new Set(Array.from(document.head.querySelectorAll('link[rel="stylesheet"],style')));
        for (const [original, copy] of copies) {
            if (!originals.has(original)) {copy.remove(); copies.delete(original);}
        }
        for (const original of originals) {
            const previous = copies.get(original);
            if (previous?.isEqualNode(original)) continue;
            previous?.remove();
            const copy = original.cloneNode(true) as Element;
            copies.set(original, copy);
            shadow.append(copy);
        }
    };
    sync();
    // 只重建实际发生变化的样式；追加按需组件 CSS 时保留其他已加载链接。
    const observer = new MutationObserver(sync);
    observer.observe(document.head, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel', 'media', 'disabled']});
    return () => {observer.disconnect(); for (const copy of copies.values()) copy.remove(); copies.clear();};
}

async function mountPdfSelectionOverlay(options: OverlayMountOptions): Promise<SelectionOverlay | null> {
    const [{default: SelectionTranslator}, {translateSelectionFromContextMenu}] = await Promise.all([
        import('@/src/features/selection-translation/ui/SelectionTranslator.vue'),
        import('@/src/features/selection-translation/content/contextMenuBridge'),
    ]);
    if (!options.isCurrent()) return null;
    const document = options.root.ownerDocument;
    const host = document.createElement('div');
    host.id = 'fluent-read-selection-translator-container';
    host.setAttribute('data-fluent-read-ui', 'pdf-selection-translator');
    host.style.cssText = 'position:static!important;display:block!important;width:0!important;height:0!important;overflow:visible!important;';
    const shadow = host.attachShadow({mode: 'closed'});
    const foundation = document.createElement('style');
    foundation.textContent = ':host{all:initial!important;display:block!important;width:0!important;height:0!important;overflow:visible!important;color-scheme:light dark}*,*::before,*::after{box-sizing:border-box}';
    const container = document.createElement('div');
    shadow.append(foundation, container);
    const stopStyles = mirrorPageStyles(document, shadow);
    const isolateKeyboard = (event: Event) => event.stopPropagation();
    for (const type of ['keydown', 'keyup', 'keypress']) shadow.addEventListener(type, isolateKeyboard);
    const app: App = createApp(SelectionTranslator as Component, {
        selectionAdapter: options.adapter,
        onSelectionRangeChange: options.onSelectionRangeChange,
    });
    let disposed = false;
    const overlay: SelectionOverlay = {translateSelection: translateSelectionFromContextMenu, dispose() {
        if (disposed) return;
        disposed = true;
        try {app.unmount();} finally {
            stopStyles();
            for (const type of ['keydown', 'keyup', 'keypress']) shadow.removeEventListener(type, isolateKeyboard);
            host.remove();
        }
    }};
    try {
        app.use(createUiI18nPlugin());
        document.body.append(host);
        app.mount(container);
        if (!options.isCurrent()) {overlay.dispose(); return null;}
        return overlay;
    } catch (error) {
        overlay.dispose();
        throw error;
    }
}

/** 生命周期依赖可注入以执行真实的取消/迟到挂载测试；生产入口始终使用默认协议客户端。 */
export function mountDocumentSelectionTranslation(
    options: DocumentSelectionRuntimeOptions,
    dependencies: DocumentSelectionRuntimeDependencies = {
        ready: configReady,
        enabled: () => config.on !== false && config.disableSelectionTranslator !== true && config.selectionTranslatorMode !== 'disabled',
        subscribe: listener => subscribeConfig(listener),
        mountOverlay: mountPdfSelectionOverlay,
        onError: error => console.error('[FluentRead] PDF 划词卡片挂载失败', error),
        installContextMenu: installDocumentSelectionContextMenu,
    },
): {dispose(): void; refresh(): void} {
    let disposed = false;
    let ready = false;
    let generation = 0;
    let overlay: SelectionOverlay | null = null;
    let pending: Promise<unknown> | null = null;
    let selectedRange: Range | null = null;
    let selectedText = '';
    let selectedOwner: ReturnType<typeof sourceOwner> | null = null;
    const translated = Boolean(options.captureMaterial);
    const adapter = createPdfSelectionAdapter(options.root, options.captureMaterial, options.markSelection);
    const notifyRange = (range: Range | null) => {
        if (!range && !selectedRange) return;
        selectedRange = range;
        selectedText = range ? adapter.normalizeText(adapter.extractText(range, range.toString())) : '';
        selectedOwner = range ? sourceOwner(sourceForNode(range.startContainer, options.root, translated)) : null;
        options.onSelectionRangeChange?.(range);
        options.root.dispatchEvent(new CustomEvent(PDF_SELECTION_RANGE_CHANGE, {detail: {range}}));
    };
    const removeOverlay = () => {
        generation += 1;
        pending = null;
        overlay?.dispose();
        overlay = null;
        notifyRange(null);
    };
    const refresh = () => {
        if (disposed) return;
        if (selectedRange) {
            const owner = sourceOwner(sourceForNode(selectedRange.startContainer, options.root, translated));
            if (!adapter.acceptsRange(selectedRange) || owner.element !== selectedOwner?.element
                || owner.identity !== selectedOwner?.identity || adapter.normalizeText(adapter.extractText(selectedRange, selectedRange.toString())) !== selectedText) {
                adapter.invalidate();
                notifyRange(null);
            }
        }
        if (!ready || !dependencies.enabled() || !firstSource(options.root, translated)) {
            if (overlay || pending) removeOverlay();
            return;
        }
        if (overlay || pending) return;
        const owner = ++generation;
        const isCurrent = () => !disposed && generation === owner && dependencies.enabled()
            && Boolean(firstSource(options.root, translated));
        pending = dependencies.mountOverlay({root: options.root, adapter, isCurrent,
            onSelectionRangeChange: range => {if (isCurrent() && (!range || adapter.acceptsRange(range))) notifyRange(range);},
        }).then(mounted => {
            if (isCurrent()) overlay = mounted;
            else mounted?.dispose();
        }).catch(error => {if (isCurrent()) dependencies.onError(error);})
            .finally(() => {if (generation === owner) pending = null;});
    };
    const observer = new MutationObserver(refresh);
    observer.observe(options.root, {childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['data-pdf-source-text', 'data-pdf-segment-index', 'data-fluentread-pdf-text', 'data-fluentread-pdf-document-id', 'data-fluentread-pdf-title', 'data-fluentread-pdf-source-url', 'style', 'hidden', 'inert']});
    const unsubscribe = dependencies.subscribe(refresh);
    const stopContextMenu = dependencies.installContextMenu?.(async () => {
        await dependencies.ready;
        refresh();
        await pending;
        return !disposed && dependencies.enabled() && overlay?.translateSelection?.() === true;
    });
    const onPageHide = () => dispose();
    const view = options.root.ownerDocument.defaultView;
    view?.addEventListener('pagehide', onPageHide, {once: true});
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        unsubscribe();
        stopContextMenu?.();
        view?.removeEventListener('pagehide', onPageHide);
        removeOverlay();
    };
    void Promise.resolve(dependencies.ready).then(() => {ready = true; refresh();})
        .catch(error => {if (!disposed) dependencies.onError(error);});
    return {dispose, refresh};
}
