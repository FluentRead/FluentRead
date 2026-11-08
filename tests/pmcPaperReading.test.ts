import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {isPmcPaperReadingPage, mountPmcPaperReading} from '@/src/app/content/pmcPaperReading';

const origin = 'https://pmc.ncbi.nlm.nih.gov';
const article = origin + '/articles/PMC7092803/';
const label = '双语翻译（流畅阅读）';
const marker = '[data-fluentread-paper-reading="inline"]';

function fixture(pdf = 'pdf/NEJMoa2001017.pdf', body = '<section class="main-article-body"><p>Article content</p></section>') {
    const {document, Event} = parseHTML(`<html><body>
        <div class="pmc-actions-bar">
            <div class="grid-row"><div><ul class="usa-list--horizontal">
                <li><a data-ga-label="pdf_download_mobile" href="${pdf}">Download PDF</a></li>
            </ul></div></div>
        </div>
        <main id="main-content">${body}</main>
        <section class="pmc-sidenav__container"><ul class="usa-list--actions">
            <li><a data-ga-label="pdf_download_desktop" href="${pdf}">PDF (918.9 KB)</a></li>
            <li><button type="button">Cite</button></li>
        </ul></section>
    </body></html>`);
    const controller = new AbortController();
    const startBilingual = vi.fn();
    const mount = (href = article) => mountPmcPaperReading(document as unknown as Document, href, controller.signal, {
        bilingualLabel: label, startBilingual,
    });
    return {document, Event, controller, startBilingual, mount};
}

describe('PMC paper reading entry', () => {
    it.each([article, article.slice(0, -1), article + '?query=1#sec1'])('recognizes the official paper route %s', url => {
        expect(isPmcPaperReadingPage(url)).toBe(true);
    });

    it.each([
        'not a URL', 'http://pmc.ncbi.nlm.nih.gov/articles/PMC7092803/',
        'https://pmc.ncbi.nlm.nih.gov:8443/articles/PMC7092803/',
        'https://user@pmc.ncbi.nlm.nih.gov/articles/PMC7092803/',
        'https://:secret@pmc.ncbi.nlm.nih.gov/articles/PMC7092803/',
        'https://pmc.ncbi.nlm.nih.gov.example.com/articles/PMC7092803/',
        article + 'pdf/NEJMoa2001017.pdf', origin + '/search/', origin + '/articles/PMCabc/',
    ])('leaves other routes alone: %s', url => {
        expect(isPmcPaperReadingPage(url)).toBe(false);
        const {document, mount} = fixture();
        mount(url);
        expect(document.querySelector(marker)).toBeNull();
    });

    it('mounts after the desktop PDF and the mobile action row, keeping site controls in place', () => {
        const {document, controller, mount} = fixture();
        mount();
        mount();
        const entries = Array.from(document.querySelectorAll<HTMLButtonElement>(marker));
        expect(entries).toHaveLength(2);
        expect(entries.every(button => button.tagName === 'BUTTON' && button.type === 'button'
            && button.textContent === label && button.getAttribute('translate') === 'no')).toBe(true);
        const originalMobile = document.querySelector('[data-ga-label="pdf_download_mobile"]')!;
        const originalDesktop = document.querySelector('[data-ga-label="pdf_download_desktop"]')!;
        expect(originalMobile.getAttribute('href')).toBe('pdf/NEJMoa2001017.pdf');
        expect(originalDesktop.getAttribute('href')).toBe('pdf/NEJMoa2001017.pdf');
        expect(entries[0]).toBe(originalMobile.closest('.grid-row')?.nextElementSibling);
        expect(entries[1]?.parentElement).toBe(originalDesktop.parentElement?.nextElementSibling);
        expect(entries[1]?.parentElement?.tagName).toBe('LI');
        controller.abort();
        mount();
        expect(document.querySelector(marker)).toBeNull();
        expect(originalMobile.isConnected && originalDesktop.isConnected).toBe(true);
    });

    it.each([
        'http://[', 'https://other.example/articles/PMC7092803/pdf/NEJMoa2001017.pdf',
        'https://user@pmc.ncbi.nlm.nih.gov/articles/PMC7092803/pdf/NEJMoa2001017.pdf',
        'https://:secret@pmc.ncbi.nlm.nih.gov/articles/PMC7092803/pdf/NEJMoa2001017.pdf',
        '/articles/PMC3531190/pdf/gks1195.pdf', '/articles/PMC7092803/bin/supplement.pdf', 'pdf/nested/not-paper.pdf',
        'pdf/not-a-pdf.html', '',
    ])('requires a same-paper PDF control: %s', url => {
        const {document, mount} = fixture(url);
        mount();
        expect(document.querySelector(marker)).toBeNull();
    });

    it('does not mount in a shell without the PMC full article', () => {
        const {document, mount} = fixture('pdf/NEJMoa2001017.pdf', '<h1>Checking your browser</h1>');
        mount();
        expect(document.querySelector(marker)).toBeNull();
    });

    it('only starts same-page bilingual translation for a trusted gesture while mounted', () => {
        const {document, Event, controller, startBilingual, mount} = fixture();
        mount();
        const button = document.querySelector(marker)!;
        const click = (trusted: boolean) => {
            const event = new Event('click', {bubbles: true, cancelable: true});
            Object.defineProperty(event, 'isTrusted', {value: trusted});
            button.dispatchEvent(event);
        };
        click(false);
        expect(startBilingual).not.toHaveBeenCalled();
        click(true);
        expect(startBilingual).toHaveBeenCalledOnce();
        controller.abort();
        click(true);
        expect(startBilingual).toHaveBeenCalledOnce();
    });
});
