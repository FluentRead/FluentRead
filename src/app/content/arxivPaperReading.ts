/**
 * @file src/app/content/arxivPaperReading.ts
 * 文件职责：把 FluentRead 的阅读入口放入 arXiv 摘要页的原生论文访问区，并识别一次性的网页双语阅读意图。
 * 主要内容：等待静态论文标记解析完毕，按原站桌面和窄屏结构挂载；优先使用同一论文版本的官方 HTML 链接，缺少时把 PDF 交给扩展阅读器，并随页面功能停用清理入口。
 * 模块边界：仅处理页面 DOM 和导航意图；版本校验由共享地址模块负责，打开扩展页与开始翻译由调用方注入。
 */
import {isSameArxivPaper, readArxivPaperUrl} from '@/src/features/document-translation/core/arxivPaperUrl';

const readingHash = '#fluentread-bilingual';
const readingAttribute = 'data-fluentread-paper-reading';
const pdfAnchors = '.full-text a.download-pdf[href], #abs a.mobile-submission-download[href]';
const htmlAnchors = '.full-text a#latexml-download-link[href], #abs a.mobile-submission-download[href]';

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
}

/** 内容脚本可能在浏览器刚创建 body 时启动，论文按钮和正文还在解析。 */
export function waitForArxivPaperDom(document: Document, href: string, signal: AbortSignal): Promise<boolean> | undefined {
    if (document.readyState !== 'loading' || signal.aborted) return;
    const paper = readArxivPaperUrl(href);
    if (paper?.kind !== 'abs' && (paper?.kind !== 'html' || paper.url.hash !== readingHash)) return;

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

export function mountArxivPaperReading(document: Document, href: string, signal: AbortSignal, ports: PaperReadingPorts): void {
    const source = readArxivPaperUrl(href);
    if (source?.kind !== 'abs' || signal.aborted) return;

    const html = Array.from(document.querySelectorAll<HTMLAnchorElement>(htmlAnchors), anchor => readPaperLink(anchor, source, 'html'))
        .find(target => target !== null);
    for (const nativePdf of document.querySelectorAll<HTMLAnchorElement>(pdfAnchors)) {
        const pdf = readPaperLink(nativePdf, source, 'pdf');
        if (!pdf) continue;
        const desktopItem = nativePdf.closest('.full-text li');
        const insertionPoint = desktopItem ?? nativePdf;
        if (insertionPoint.nextElementSibling?.matches(`[${readingAttribute}], :has(> [${readingAttribute}])`)) continue;

        const entry = document.createElement('a');
        if (html) {
            const destination = new URL(html.url);
            destination.hash = readingHash;
            entry.href = destination.href;
            entry.textContent = ports.bilingualLabel;
        } else {
            // 原站移动样式仅作用于链接；保留原 PDF 地址供浏览器原生的复制链接等操作使用。
            entry.href = pdf.url.href;
            entry.textContent = ports.pdfLabel;
            entry.addEventListener('click', async event => {
                if (!event.isTrusted) return;
                event.preventDefault();
                if (entry.hasAttribute('aria-busy')) return;
                entry.setAttribute('aria-busy', 'true');
                let opened = false;
                try { opened = await ports.openPdf(pdf.url.href); }
                catch { /* 扩展重载或标签页创建失败时仍允许用户重试。 */ }
                if (signal.aborted) return;
                entry.removeAttribute('aria-busy');
                if (!opened) ports.onPdfOpenFailed();
            }, {signal});
        }
        entry.className = desktopItem ? 'abs-button' : 'mobile-submission-download';
        entry.setAttribute(readingAttribute, html ? 'html' : 'pdf');
        entry.setAttribute('translate', 'no');
        const item = desktopItem ? document.createElement('li') : entry;
        if (desktopItem) item.append(entry);
        insertionPoint.after(item);
        signal.addEventListener('abort', () => item.remove(), {once: true});
    }
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
