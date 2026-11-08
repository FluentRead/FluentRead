/**
 * @file src/app/content/pmcPaperReading.ts
 * 文件职责：在 PubMed Central 的全文页安装页内双语入口，并与原生 PDF 控件保持同一阅读上下文。
 * 主要内容：校验官方论文地址、正文和同篇 PDF 控件，在桌面侧栏与窄屏操作区分别挂载原生风格的按钮；只响应可信点击，随页面停用清除。
 * 模块边界：本文件只读原站链接并管理扩展按钮，不发起 PDF 请求或修改原站控件；全文翻译由内容运行时注入。
 */
const pmcOrigin = 'https://pmc.ncbi.nlm.nih.gov';
const desktopPdf = '.pmc-sidenav__container .usa-list--actions > li > a[data-ga-label="pdf_download_desktop"][href]';
const mobilePdf = '.pmc-actions-bar > .grid-row .usa-list--horizontal > li > a[data-ga-label="pdf_download_mobile"][href]';
const inlineEntry = '[data-fluentread-paper-reading="inline"]';

function readPmcPaperPage(href: string): URL | null {
    try {
        const url = new URL(href);
        return url.origin === pmcOrigin && !url.username && !url.password
            && /^\/articles\/PMC\d+\/?$/u.test(url.pathname) ? url : null;
    } catch {
        return null;
    }
}

export function isPmcPaperReadingPage(href: string): boolean {
    return readPmcPaperPage(href) !== null;
}

function isSamePmcPdf(anchor: HTMLAnchorElement, paper: URL): boolean {
    try {
        const pdf = new URL(anchor.getAttribute('href')!, paper);
        const prefix = paper.pathname.replace(/\/$/u, '') + '/pdf/';
        return pdf.origin === paper.origin && !pdf.username && !pdf.password
            && pdf.pathname.startsWith(prefix) && /^[^/]+\.pdf$/iu.test(pdf.pathname.slice(prefix.length));
    } catch {
        return false;
    }
}

interface PmcPaperReadingPorts {
    bilingualLabel: string;
    startBilingual(): void;
}

export function mountPmcPaperReading(document: Document, href: string, signal: AbortSignal, ports: PmcPaperReadingPorts): void {
    const paper = readPmcPaperPage(href);
    if (!paper || signal.aborted || !document.querySelector('main#main-content section.main-article-body')) return;

    for (const nativePdf of document.querySelectorAll<HTMLAnchorElement>(`${desktopPdf}, ${mobilePdf}`)) {
        if (!isSamePmcPdf(nativePdf, paper)) continue;
        const mobile = nativePdf.matches(mobilePdf);
        const insertionPoint = mobile ? nativePdf.closest('.pmc-actions-bar > .grid-row')! : nativePdf.parentElement!;
        const next = insertionPoint.nextElementSibling;
        if (next?.matches(inlineEntry) || next?.querySelector(inlineEntry)) continue;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = mobile ? 'usa-button usa-button--outline fluentread-pmc-reading-mobile'
            : 'usa-button usa-button--outline width-24';
        button.textContent = ports.bilingualLabel;
        button.setAttribute('data-fluentread-paper-reading', 'inline');
        button.setAttribute('translate', 'no');
        button.addEventListener('click', event => {
            if (event.isTrusted && !signal.aborted) ports.startBilingual();
        }, {signal});
        const item = mobile ? button : document.createElement('li');
        if (!mobile) item.append(button);
        insertionPoint.after(item);
        signal.addEventListener('abort', () => item.remove(), {once: true});
    }
}
