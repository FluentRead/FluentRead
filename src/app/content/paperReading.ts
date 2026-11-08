/**
 * @file src/app/content/paperReading.ts
 * 文件职责：把 FluentRead 的阅读入口放入已适配论文站的原生访问区，并识别 arXiv 的一次性正文翻译意图。
 * 主要内容：等待静态论文标记解析完毕，保留 arXiv 的 HTML 优先和窄屏布局；对只有 PDF 的论文复用受控导航入口，修复 Hugging Face 客户端接管后的入口丢失，PMC 在当前正文中启动双语翻译。
 * 模块边界：仅处理页面 DOM 和导航意图；论文身份校验由共享地址模块负责，打开扩展页与开始翻译由调用方注入。
 */
import {isSameArxivPaper, readArxivPaperUrl} from '@/src/features/document-translation/core/arxivPaperUrl';
import {getPaperPdfSite, resolvePaperPdfUrl} from '@/src/features/document-translation/core/paperPdfSites';
import {isPmcPaperReadingPage, mountPmcPaperReading} from './pmcPaperReading';

const readingHash = '#fluentread-bilingual';
const readingAttribute = 'data-fluentread-paper-reading';
const pdfAnchors = '.full-text a.download-pdf[href], #abs a.mobile-submission-download[href]';
const htmlAnchors = '.full-text a#latexml-download-link[href], #abs a.mobile-submission-download[href]';
const externalPdfControls = {
    huggingface: {selector: 'main section a.btn[href]', classes: 'btn'},
    acl: {selector: '#main .acl-paper-link-block > a.btn.btn-primary[href]', classes: 'btn btn-outline-primary'},
    cvf: {selector: '#content a[href]', classes: 'fluentread-paper-pdf-link'},
    neurips: {selector: '.paper-actions a.btn[href]', classes: 'btn btn-light btn-spacer'},
};

type ArxivPaper = NonNullable<ReturnType<typeof readArxivPaperUrl>>;

function readPaperLink(anchor: HTMLAnchorElement, source: ArxivPaper, kind: 'html' | 'pdf'): ArxivPaper | null {
    const href = anchor.getAttribute('href')!;
    try {
        const target = readArxivPaperUrl(new URL(href, source.url));
        return target?.kind === kind && isSameArxivPaper(source, target) ? target : null;
    } catch { return null; }
}

interface PaperReadingPorts {
    bilingualLabel: string;
    pdfLabel: string;
    openPdf(url: string): Promise<boolean>;
    onPdfOpenFailed(): void;
    startBilingual(): void;
}

/** 内容脚本可能在浏览器刚创建 body 时启动，论文按钮和正文还在解析。 */
export function waitForPaperReadingDom(document: Document, href: string, signal: AbortSignal): Promise<boolean> | undefined {
    if (document.readyState !== 'loading' || signal.aborted) return;
    const paper = readArxivPaperUrl(href);
    if (!getPaperPdfSite(href) && !isPmcPaperReadingPage(href)
        && (paper?.kind !== 'html' || paper.url.hash !== readingHash)) return;

    return new Promise(resolve => {
        const finish = (ready: boolean) => {
            document.removeEventListener('readystatechange', onReady);
            signal.removeEventListener('abort', onAbort);
            resolve(ready);
        };
        const onReady = () => { if (document.readyState !== 'loading') finish(true); };
        const onAbort = () => finish(false);
        document.addEventListener('readystatechange', onReady);
        signal.addEventListener('abort', onAbort, {once: true});
    });
}

function createPdfReadingLink(document: Document, href: string, signal: AbortSignal, ports: PaperReadingPorts): HTMLAnchorElement {
    // 保留原 PDF 地址供复制链接等浏览器操作，普通点击转交扩展阅读器。
    const entry = document.createElement('a');
    entry.href = href;
    entry.textContent = ports.pdfLabel;
    entry.setAttribute(readingAttribute, 'pdf');
    entry.setAttribute('translate', 'no');
    entry.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        event.preventDefault();
        if (entry.hasAttribute('aria-busy')) return;
        entry.setAttribute('aria-busy', 'true');
        let opened = false;
        try { opened = await ports.openPdf(href); }
        catch { /* 扩展重载或标签页创建失败时仍允许用户重试。 */ }
        if (signal.aborted) return;
        entry.removeAttribute('aria-busy');
        if (!opened) ports.onPdfOpenFailed();
    }, {signal});
    return entry;
}

function mountArxivPaperReading(document: Document, source: ArxivPaper, signal: AbortSignal, ports: PaperReadingPorts): void {

    const html = Array.from(document.querySelectorAll<HTMLAnchorElement>(htmlAnchors), anchor => readPaperLink(anchor, source, 'html'))
        .find(target => target !== null);
    for (const nativePdf of document.querySelectorAll<HTMLAnchorElement>(pdfAnchors)) {
        const pdf = readPaperLink(nativePdf, source, 'pdf');
        if (!pdf) continue;
        const desktopItem = nativePdf.closest('.full-text li');
        const insertionPoint = desktopItem ?? nativePdf;
        if (insertionPoint.nextElementSibling?.matches(`[${readingAttribute}], :has(> [${readingAttribute}])`)) continue;

        const entry = html ? document.createElement('a') : createPdfReadingLink(document, pdf.url.href, signal, ports);
        if (html) {
            const destination = new URL(html.url);
            destination.hash = readingHash;
            entry.href = destination.href;
            entry.textContent = ports.bilingualLabel;
            entry.setAttribute(readingAttribute, 'html');
            entry.setAttribute('translate', 'no');
        }
        entry.className = desktopItem ? 'abs-button' : 'mobile-submission-download';
        const item = desktopItem ? document.createElement('li') : entry;
        if (desktopItem) item.append(entry);
        insertionPoint.after(item);
        signal.addEventListener('abort', () => item.remove(), {once: true});
    }
}

export function mountPaperReading(document: Document, href: string, signal: AbortSignal, ports: PaperReadingPorts): void {
    if (signal.aborted) return;
    if (isPmcPaperReadingPage(href)) {
        mountPmcPaperReading(document, href, signal, ports);
        return;
    }
    const site = getPaperPdfSite(href);
    if (!site) return;
    if (site === 'arxiv') {
        mountArxivPaperReading(document, readArxivPaperUrl(href)!, signal, ports);
        return;
    }
    if (document.querySelector(`[${readingAttribute}]`)) return;
    const {selector, classes} = externalPdfControls[site];
    const placeEntry = () => {
        for (const anchor of document.querySelectorAll<HTMLAnchorElement>(selector)) {
            let target: URL;
            try { target = new URL(anchor.getAttribute('href')!, href); }
            catch { continue; }
            const pdf = resolvePaperPdfUrl(href, target.href);
            if (!pdf) continue;
            const entry = createPdfReadingLink(document, pdf, signal, ports);
            entry.className = classes;
            // CVF 用文本括号包住原站链接，末尾插入可保留每个原站链接的完整边界。
            if (site === 'cvf') anchor.parentElement!.append(entry);
            else anchor.after(entry);
            return entry;
        }
    };
    let entry = placeEntry();
    let observer: MutationObserver | undefined;
    const hydratedSection = site === 'huggingface' ? document.querySelector('main section') : null;
    if (hydratedSection) {
        // Svelte 接管 SSR 节点时会重建原站操作组。只在此论文区内恢复消失的入口。
        observer = new document.defaultView!.MutationObserver(() => {
            if (!entry?.isConnected) entry = placeEntry();
        });
        observer.observe(hydratedSection, {childList: true, subtree: true});
    }
    signal.addEventListener('abort', () => { observer?.disconnect(); entry?.remove(); }, {once: true});
}

export function consumeArxivPaperReading(window: Window, document: Document): boolean {
    if (window.location.hash !== readingHash) return false;
    const paper = readArxivPaperUrl(window.location.href);
    const referrer = readArxivPaperUrl(document.referrer);
    // 仅允许从同一篇论文的原站摘要页进入真实正文后启动，拒绝外站构造的自动翻译导航。
    if (paper?.kind !== 'html' || referrer?.kind !== 'abs' || !isSameArxivPaper(referrer, paper)
        || !document.querySelector('article.ltx_document')) return false;
    paper.url.hash = '';
    window.history.replaceState(window.history.state, '', paper.url.href);
    return true;
}
