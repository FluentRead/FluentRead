import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {consumeArxivPaperReading, mountPaperReading, waitForPaperReadingDom} from '@/src/app/content/paperReading';
import {translate, UI_LANGUAGE_OPTIONS} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();

const abstract = 'https://arxiv.org/abs/1706.03762v1';
const pdf = 'https://arxiv.org/pdf/1706.03762v1';
const html = 'https://arxiv.org/html/1706.03762v1#fluentread-bilingual';
const marker = '[data-fluentread-paper-reading]';

function mountFixture(markup: string, href = abstract) {
    const {document, Event} = parseHTML(`<html><body>${markup}</body></html>`);
    const controller = new AbortController();
    const ports = {bilingualLabel: translate('document.paperReading.bilingual', 'zh-CN'), pdfLabel: translate('document.paperReading.pdf', 'zh-CN'), startBilingual: vi.fn(), openPdf: vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true), onPdfOpenFailed: vi.fn()};
    const mount = () => mountPaperReading(document as unknown as Document, href, controller.signal, ports);
    return {document, Event, controller, ports, mount};
}

const desktop = '<div class="full-text"><ul><li><a class="download-pdf" href="/pdf/1706.03762v1">View PDF</a></li></ul></div>';
const mobile = '<div id="abs"><a class="mobile-submission-download" href="/pdf/1706.03762v1">View PDF</a></div>';

describe('paper parser readiness', () => {
    it('waits past body creation on paper entry pages and removes listeners after the parser finishes', async () => {
        const {document, Event} = parseHTML('<html><body></body></html>');
        const parsed = document as unknown as Document;
        let readyState: DocumentReadyState = 'loading';
        Object.defineProperty(parsed, 'readyState', {get: () => readyState});
        const controller = new AbortController();
        const detach = vi.spyOn(parsed, 'removeEventListener');
        const done = vi.fn();
        const ready = waitForPaperReadingDom(parsed, abstract, controller.signal)!.then(done);
        parsed.dispatchEvent(new Event('readystatechange'));
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        readyState = 'interactive';
        parsed.dispatchEvent(new Event('readystatechange'));
        await ready;
        expect(done.mock.calls).toEqual([[true]]);
        expect(detach).toHaveBeenCalledWith('readystatechange', expect.any(Function));
        expect(waitForPaperReadingDom(parsed, abstract, controller.signal)).toBeUndefined();
    });

    it('also waits for explicit HTML reading, but leaves ordinary navigation and aborted documents alone', async () => {
        const {document} = parseHTML('<html><body></body></html>');
        const parsed = document as unknown as Document;
        Object.defineProperty(parsed, 'readyState', {value: 'loading'});
        const controller = new AbortController();
        for (const href of [html.replace('#fluentread-bilingual', ''), pdf, 'https://example.com/', 'https://arxiv.org/list/cs']) {
            expect(waitForPaperReadingDom(parsed, href, controller.signal), href).toBeUndefined();
        }
        const pending = waitForPaperReadingDom(parsed, html, controller.signal);
        expect(pending).toBeInstanceOf(Promise);
        controller.abort();
        await expect(pending).resolves.toBe(false);
        expect(waitForPaperReadingDom(parsed, html, controller.signal)).toBeUndefined();
    });

    it.each(['https://huggingface.co/papers/1706.03762', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7092803/'])('waits for a supported paper page at %s', async href => {
        const {document} = parseHTML('<html><body></body></html>');
        const parsed = document as unknown as Document;
        Object.defineProperty(parsed, 'readyState', {value: 'loading'});
        const controller = new AbortController();
        const pending = waitForPaperReadingDom(parsed, href, controller.signal);
        expect(pending).toBeInstanceOf(Promise);
        controller.abort();
        await expect(pending).resolves.toBe(false);
    });
});

describe('arXiv paper reading entry', () => {
    it('includes the brand in all localized labels with each language’s own action text', () => {
        const labels = UI_LANGUAGE_OPTIONS.map(({value}) => translate('document.paperReading.bilingual', value));
        expect(new Set(labels).size).toBe(UI_LANGUAGE_OPTIONS.length);
        expect(translate('document.paperReading.bilingual', 'zh-CN')).toBe('双语翻译（流畅阅读）');
        expect(translate('document.paperReading.bilingual', 'en-US')).toBe('Bilingual translation (FluentRead)');
        expect(labels.filter(label => /[（(]FluentRead[）)]$/u.test(label))).toHaveLength(UI_LANGUAGE_OPTIONS.length - 1);
        const pdfLabels = UI_LANGUAGE_OPTIONS.map(({value}) => translate('document.paperReading.pdf', value));
        expect(translate('document.paperReading.pdf', 'zh-CN')).toBe('PDF 阅读（流畅阅读）');
        expect(pdfLabels.filter(label => /[（(]FluentRead[）)]$/u.test(label))).toHaveLength(UI_LANGUAGE_OPTIONS.length - 1);
    });

    it('uses the original HTML version in both responsive locations and removes the entries on cleanup', () => {
        const {document, ports, mount, controller} = mountFixture(desktop.replace('</ul>', '<li><a id="latexml-download-link" href="/html/1706.03762v1">HTML</a></li></ul>') + mobile);
        mount();
        mount();
        const entries = Array.from(document.querySelectorAll(marker));
        expect(entries.map(entry => [entry.textContent, entry.getAttribute('href'), entry.getAttribute('translate')]))
            .toEqual([['双语翻译（流畅阅读）', html, 'no'], ['双语翻译（流畅阅读）', html, 'no']]);
        expect(document.querySelector('.download-pdf')?.getAttribute('href')).toBe('/pdf/1706.03762v1');
        expect(document.querySelector('#latexml-download-link')?.getAttribute('href')).toBe('/html/1706.03762v1');
        expect(entries[0]?.parentElement?.tagName).toBe('LI');
        expect(entries[1]?.className).toBe('mobile-submission-download');
        expect(ports.openPdf).not.toHaveBeenCalled();
        controller.abort();
        mount();
        expect(document.querySelectorAll(marker)).toHaveLength(0);
        expect(document.querySelectorAll('.full-text li')).toHaveLength(2);
    });

    it('uses the desktop or mobile official HTML link even if its other responsive copy is missing', () => {
        const {document, mount} = mountFixture(desktop + mobile.replace('</div>', '<a class="mobile-submission-download" href="/html/1706.03762v1">HTML</a></div>'));
        mount();
        expect(document.querySelector('.full-text [data-fluentread-paper-reading="html"]')?.getAttribute('href')).toBe(html);
    });

    it('ignores mismatched and malformed native links and leaves unsupported pages alone', () => {
        const links = desktop.replace('</ul>', '<li><a id="latexml-download-link" href="http://[">Bad</a></li></ul>')
            + mobile.replace('</div>', '<a class="mobile-submission-download" href="https://arxiv.org/html/1706.03762v2">Other version</a></div>')
            + '<a href="/pdf/9999.00001">Unrelated PDF</a>';
        const samePaper = mountFixture(links);
        samePaper.mount();
        expect(samePaper.document.querySelectorAll('[data-fluentread-paper-reading="pdf"]')).toHaveLength(2);
        for (const href of ['https://example.com/abs/1706.03762v1', 'https://arxiv.org/list/cs/recent', 'https://arxiv.org/html/1706.03762v1', 'https://arxiv.org/abs/1706.03762v2']) {
            const {document, mount} = mountFixture(links, href);
            mount();
            expect(document.querySelector(marker), href).toBeNull();
        }
    });

    it('opens PDF only on a real gesture, coalesces pending clicks and permits retry', async () => {
        const {document, mount, ports, Event, controller} = mountFixture(desktop);
        let resolveOpen!: (result: boolean) => void;
        ports.openPdf.mockImplementationOnce(() => new Promise(resolve => {resolveOpen = resolve;}));
        mount();
        const entry = document.querySelector(marker)!;
        expect(entry.getAttribute('href')).toBe(pdf);
        const click = (trusted: boolean) => {
            const event = new Event('click', {bubbles: true, cancelable: true});
            Object.defineProperty(event, 'isTrusted', {value: trusted});
            entry.dispatchEvent(event);
            return event;
        };
        expect(click(false).defaultPrevented).toBe(false);
        expect(ports.openPdf).not.toHaveBeenCalled();
        expect(click(true).defaultPrevented).toBe(true);
        expect(click(true).defaultPrevented).toBe(true);
        expect(ports.openPdf.mock.calls).toEqual([[pdf]]);
        expect(entry.getAttribute('aria-busy')).toBe('true');
        resolveOpen(false);
        await Promise.resolve();
        expect(ports.onPdfOpenFailed).toHaveBeenCalledTimes(1);
        expect(entry.hasAttribute('aria-busy')).toBe(false);
        click(true);
        await Promise.resolve();
        expect(ports.openPdf).toHaveBeenCalledTimes(2);
        expect(ports.onPdfOpenFailed).toHaveBeenCalledTimes(1);
        ports.openPdf.mockRejectedValueOnce(new Error('Extension unloaded'));
        click(true);
        await Promise.resolve();
        expect(ports.onPdfOpenFailed).toHaveBeenCalledTimes(2);
        ports.openPdf.mockResolvedValueOnce(false);
        click(true);
        controller.abort();
        await Promise.resolve();
        expect(ports.onPdfOpenFailed).toHaveBeenCalledTimes(2);
        expect(document.querySelector(marker)).toBeNull();
    });
});

describe('publisher PDF entries', () => {
    const sample = '3f5ee243547dee91fbd053c1c4a845aa';
    it.each([
        ['https://huggingface.co/papers/1706.03762', '<main><section><div>{{links}}</div></section></main>', 'https://arxiv.org/pdf/1706.03762', 'https://arxiv.org/pdf/9999.00001', 'btn'],
        ['https://aclanthology.org/2024.acl-long.1/', '<section id="main"><div class="acl-paper-link-block">{{links}}</div></section>', '/2024.acl-long.1.pdf', '/2024.acl-long.2.pdf', 'btn btn-outline-primary'],
        ['https://openaccess.thecvf.com/content_cvpr_2016/html/He_Deep_Residual_Learning_CVPR_2016_paper.html', '<div id="content">{{links}}</div>', '../papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf', '../supplemental/He_Deep_Residual_Learning_CVPR_2016_supplemental.pdf', 'fluentread-paper-pdf-link'],
        [`https://proceedings.neurips.cc/paper_files/paper/2017/hash/${sample}-Abstract.html`, '<div class="paper-actions">{{links}}</div>', `/paper_files/paper/2017/file/${sample}-Paper.pdf`, `/paper_files/paper/2018/file/${sample}-Paper.pdf`, 'btn btn-light btn-spacer'],
    ])('adds one reader link beside the matching native PDF at %s', (href, shell, nativePdf, unrelated, classes) => {
        const link = (address: string) => `<a class="btn btn-primary" href="${address}">Native link</a>`;
        const fixture = mountFixture(shell.replace('{{links}}', link('http://[') + link(unrelated) + link(nativePdf) + link(nativePdf)), href);
        fixture.mount();
        fixture.mount();
        const entries = fixture.document.querySelectorAll(marker);
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.textContent).toBe('PDF 阅读（流畅阅读）');
        expect(entry.getAttribute('href')).toBe(new URL(nativePdf, href).href);
        expect(entry.getAttribute('translate')).toBe('no');
        expect(entry.className).toBe(classes);
        expect(entry.previousElementSibling?.getAttribute('href')).toBe(nativePdf);
        expect(fixture.ports.openPdf).not.toHaveBeenCalled();
        fixture.controller.abort();
        expect(fixture.document.querySelectorAll(marker)).toHaveLength(0);
        expect(fixture.document.querySelectorAll('a')).toHaveLength(4);
    });

    it('leaves metadata-only pages and links outside the native action group alone', () => {
        const href = 'https://aclanthology.org/2024.acl-long.1/';
        const {document, mount} = mountFixture('<section id="main"><a class="btn btn-primary" href="/2024.acl-long.1.pdf">Metadata</a></section>', href);
        mount();
        expect(document.querySelector(marker)).toBeNull();
    });

    it('keeps CVF’s brackets around their original links', () => {
        const href = 'https://openaccess.thecvf.com/content/ICCV2023/html/Kirillov_Segment_Anything_ICCV_2023_paper.html';
        const fixture = mountFixture('<div id="content"><dl><dd>[<a href="../papers/Kirillov_Segment_Anything_ICCV_2023_paper.pdf">pdf</a>] [<a href="../supplemental/extra.pdf">supp</a>]</dd></dl></div>', href);
        fixture.mount();
        expect(fixture.document.querySelector('dd')?.textContent).toBe('[pdf] [supp]PDF 阅读（流畅阅读）');
    });

    it('restores the Hugging Face entry after hydration replaces the action group and disconnects on cleanup', async () => {
        const href = 'https://huggingface.co/papers/1706.03762';
        const nativeLink = '<a class="btn" href="https://arxiv.org/pdf/1706.03762">View PDF</a>';
        const fixture = mountFixture(`<main><section><div>${nativeLink}</div></section></main>`, href);
        fixture.mount();
        const section = fixture.document.querySelector('section')!;
        section.innerHTML = `<div class="hydrated">${nativeLink}</div>`;
        await vi.waitFor(() => expect(section.querySelectorAll(marker)).toHaveLength(1));
        section.querySelector('.hydrated')!.append('New site content');
        await Promise.resolve();
        expect(section.querySelectorAll(marker)).toHaveLength(1);
        fixture.controller.abort();
        section.innerHTML = `<div>${nativeLink}</div>`;
        await Promise.resolve();
        expect(section.querySelector(marker)).toBeNull();
    });

    it('delegates PMC to the full-text control without inserting PDF links in its metadata', () => {
        const fixture = mountFixture('<main><a href="/articles/PMC7092803/pdf/paper.pdf">Unrelated control</a></main>', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7092803/');
        fixture.mount();
        expect(fixture.document.querySelector(marker)).toBeNull();
        expect(fixture.ports.startBilingual).not.toHaveBeenCalled();
    });
});

describe('arXiv HTML reading intent', () => {
    function consume(href: string, referrer: string, article: boolean) {
        const location = new URL(href);
        const history = {state: {arxiv: true}, replaceState: vi.fn((_state, _title, next) => {location.href = next;})};
        const {document} = parseHTML(article ? '<article class="ltx_document"></article>' : '<p>HTML unavailable</p>');
        Object.defineProperty(document, 'referrer', {value: referrer});
        return {location, history, consume: () => consumeArxivPaperReading({location, history} as unknown as Window, document as unknown as Document)};
    }

    it('consumes the same-paper navigation once and keeps the existing history state', () => {
        const request = consume(html, abstract, true);
        expect(request.consume()).toBe(true);
        expect(request.location.href).toBe('https://arxiv.org/html/1706.03762v1');
        expect(request.history.replaceState.mock.calls).toEqual([[{arxiv: true}, '', request.location.href]]);
        expect(request.consume()).toBe(false);
    });

    it.each([
        [html.replace('fluentread-bilingual', 'S1'), abstract, true],
        [html.replace('/html/', '/abs/'), abstract, true],
        [html.replace('arxiv.org', 'arxiv.org.example.com'), abstract, true],
        [html, '', true],
        [html, 'https://example.com/abs/1706.03762v1', true],
        [html, 'https://arxiv.org/abs/1706.03762v2', true],
        [html, abstract, false],
    ] as const)('does not consume an ordinary, unexpected or unavailable page (%s from %s)', (href, referrer, article) => {
        const request = consume(href, referrer, article);
        expect(request.consume()).toBe(false);
        expect(request.history.replaceState).not.toHaveBeenCalled();
    });
});
