import {IDBFactory} from 'fake-indexeddb';
import Defuddle from 'defuddle';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createWebArticleOpenHandler} from '@/src/app/background/webArticleRuntime';
import {extractWebArticle} from '@/src/features/document-translation/content/extractWebArticle';
import {getDocumentFormat, parseDocument} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {
    MAX_WEB_ARTICLE_BYTES, normalizeWebArticleProgress, normalizeWebArticleUrl, readWebArticleSnapshot, webArticleIdentityBytes,
} from '@/src/features/document-translation/core/webArticle';
import {createDocumentHistory, documentHistoryId} from '@/src/features/document-translation/services/history';
import {trackWebArticleReading} from '@/src/features/document-translation/ui/webArticleReading';

const sourceUrl = 'https://example.test/news/study?read=full#section';
const prose = 'Our research team spent several months exploring how the prototype behaves when reading an unfamiliar webpage in two languages.';
const popupUrl = 'chrome-extension://fixture/popup.html';
const documentUrl = 'chrome-extension://fixture/document.html';
const response = {status: 'ok', title: 'A field study', sourceUrl, html: `<article><h1>A field study</h1><p>${prose}</p></article>`};
const ctx = {sender: {id: 'fixture', url: popupUrl}};
const message = {type: 'openWebArticle', tabId: 9, expectedUrl: sourceUrl} as const;

function articlePage(body: string) {
    const page = parseHTML('<!doctype html><html><head><title>Field study</title></head><body>' + body + '</body></html>');
    Object.defineProperty(page.document, 'implementation', {value: {
        createHTMLDocument(title: string) {
            const {document} = parseHTML('<!doctype html><html><head><title></title></head><body></body></html>');
            document.title = title;
            return document;
        },
    }});
    return page.document as unknown as Document;
}

function navigation() {
    const history = createDocumentHistory(new IDBFactory());
    const source = {url: sourceUrl, windowId: 7, incognito: false, pendingUrl: undefined as string | undefined};
    const captureDocument = vi.fn(() => vi.fn(() => true));
    const isDisabled = vi.fn(() => false);
    const getTab = vi.fn(async () => source);
    const askForArticle = vi.fn(async (): Promise<unknown> => response);
    const openDocument = vi.fn(async (_url: string, _windowId?: number) => ({}));
    const handler = createWebArticleOpenHandler({
        ready: Promise.resolve(), extensionId: 'fixture', popupUrl, documentUrl, history,
        captureDocument, isDisabled, getTab, askForArticle, openDocument, now: () => 1710000000000,
    });
    return {history, source, captureDocument, isDisabled, getTab, askForArticle, openDocument,
        open: () => handler.handle(message, ctx), handler};
}

afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});

describe('Opening webpage content in the document workbench', () => {
    it('takes a full snapshot with headings, readable paragraphs and working links before yielding', async () => {
        const paragraphs = Array.from({length: 38}, (_, index) => `<p>Passage ${index + 1}. ${prose}</p>`).join('');
        const document = articlePage(`<nav>NavigationNoise</nav><article><h1>A field study</h1><h2>Methods</h2>
            ${paragraphs}<ul><li>Checklist for the study. ${prose}</li></ul>
            <p>Consult <a href="/technical/notes?q=read#method">the notes</a> and <code translate="no">fixed  spacing</code>.</p>
            <p>Read the attachment <a href="javascript:void(0)" onclick="unsafe()">alongside the report</a>.</p>
            <form><textarea>DraftNoise</textarea></form><p hidden>HiddenNoise</p>
            <p>Last passage. ${prose}<span class="fluent-read-bilingual-content">TranslatedNoise</span></p>
            </article><footer>FooterNoise</footer>`);
        const original = document.body.innerHTML;
        const promise = extractWebArticle(document, sourceUrl);
        expect(document.body.innerHTML).toBe(original);
        document.querySelector('article')!.append('AfterClickNoise');
        const extracted = await promise;
        expect(extracted).toMatchObject({status: 'ok', title: 'A field study', sourceUrl});
        if (extracted.status !== 'ok') throw new Error('Article extraction failed');
        expect(extracted.html).toContain('<h2>Methods</h2>');
        expect(extracted.html).toContain('Passage 38.');
        expect(extracted.html).toContain('Last passage.');
        expect(extracted.html).toContain('href="https://example.test/technical/notes?q=read#method"');
        expect(extracted.html).toContain('fixed  spacing');
        expect(extracted.html).toContain('alongside the report');
        expect(extracted.html).not.toMatch(/javascript:|onclick=|DraftNoise|HiddenNoise|NavigationNoise|FooterNoise|TranslatedNoise|AfterClickNoise/u);
        const workbench = parseDocument('A field study.html', extracted.html);
        expect(workbench.segments.some(item => item.source.includes('Last passage.'))).toBe(true);
        const preview = createDocumentPreviewHtml(workbench, [], 'source');
        expect(preview).toContain('href="https://example.test/technical/notes?q=read#method"');
    });

    it('keeps main-only documentation headings, expands details, and reports missing and oversized content', async () => {
        const docs = articlePage(`<main><h1><code>&lt;article&gt;</code> overview</h1><p>${prose}</p>
            <details><summary>Usage notes</summary><p>Supplemental content. ${prose}</p></details></main>`);
        const extracted = await extractWebArticle(docs, sourceUrl);
        expect(extracted).toMatchObject({status: 'ok', title: '<article> overview'});
        if (extracted.status !== 'ok') throw new Error('Documentation was not extracted');
        expect(extracted.html).toContain('<code>&lt;article&gt;</code> overview');
        expect(extracted.html).toContain('Supplemental content');
        expect(extracted.html).not.toContain('<details');
        await expect(extractWebArticle(articlePage('<form><input/><button>Continue</button></form>'), sourceUrl))
            .resolves.toEqual({status: 'no-article'});
        await expect(extractWebArticle(articlePage(`<article><p>${'a'.repeat(MAX_WEB_ARTICLE_BYTES + 1)}</p></article>`), sourceUrl))
            .resolves.toEqual({status: 'too-large'});
        await expect(extractWebArticle({} as Document, sourceUrl)).resolves.toEqual({status: 'no-article'});
    });

    it('checks HTTP URLs, source identity, UTF-8 limits and normalized progress', async () => {
        expect(normalizeWebArticleUrl('/note?query=true', sourceUrl)).toBe('https://example.test/note?query=true');
        for (const value of [null, '', ' ', 'https://user@example.test/', 'https://:secret@example.test/', 'file:///etc/file', ':/', 'x'.repeat(8193)]) {
            expect(normalizeWebArticleUrl(value)).toBeNull();
        }
        expect(readWebArticleSnapshot(response, sourceUrl)).toEqual({title: response.title, html: response.html, sourceUrl});
        for (const value of [null, 0, {...response, sourceUrl: 'https://other.test/'}, {...response, title: undefined},
            {...response, title: 'x'.repeat(513)}, {...response, html: 1}, {...response, html: ' '},
            {...response, html: 'a'.repeat(MAX_WEB_ARTICLE_BYTES + 1)}, {...response, html: '字'.repeat(MAX_WEB_ARTICLE_BYTES / 2)}]) {
            expect(readWebArticleSnapshot(value, sourceUrl)).toBeNull();
        }
        expect(readWebArticleSnapshot({...response, sourceUrl: 'file:///tmp/x'}, 'file:///tmp/x')).toBeNull();
        const bytes = new TextEncoder().encode(response.html);
        expect(await documentHistoryId(webArticleIdentityBytes(sourceUrl, bytes))).not.toEqual(
            await documentHistoryId(webArticleIdentityBytes(sourceUrl + '2', bytes)),
        );
        for (const invalid of [NaN, Infinity, -0.1, 1.1, null, '0.5']) expect(normalizeWebArticleProgress(invalid)).toBeUndefined();
        expect([0, 0.5, 1].map(normalizeWebArticleProgress)).toEqual([0, 0.5, 1]);
    });

    it('recovers source slots and a complete article within an oversized site shell', async () => {
        const shell = '<span></span>'.repeat(12001);
        const content = `<p><span data-fr-translation-segment="true">Original inline slot. ${prose}</span></p>
            <p><span translate="no" data-fr-translation-owned="true" class="fluent-read-single-slot" aria-label="TranslationOnlyNoise">Original single slot. ${prose}</span></p>
            <p>Final section. ${prose}</p>`;
        const html = await extractWebArticle(articlePage(`<div>${shell}</div><main><article>${content}</article></main>`), sourceUrl);
        expect(html).toMatchObject({status: 'ok', html: expect.stringContaining('Original single slot.')});
        expect(JSON.stringify(html)).not.toContain('TranslationOnlyNoise');
        expect(await extractWebArticle(articlePage(`<div>${shell}</div><div role="main">${content}</div>`), sourceUrl))
            .toMatchObject({status: 'ok', html: expect.stringContaining('Final section.')});
        expect(await extractWebArticle(articlePage(`<div>${shell}</div>${content}`), sourceUrl)).toEqual({status: 'too-large'});
        expect(await extractWebArticle(articlePage(`<div>${shell}</div><article hidden>${content}</article>`), sourceUrl)).toEqual({status: 'too-large'});
        const wrappers = '<div>'.repeat(193) + '<p>' + prose + '</p>' + '</div>'.repeat(193);
        expect(await extractWebArticle(articlePage(wrappers), sourceUrl)).toEqual({status: 'too-large'});
        const hidden = articlePage(`<article>${content}</article>`);
        hidden.body.setAttribute('hidden', '');
        expect(await extractWebArticle(hidden, sourceUrl)).toEqual({status: 'no-article'});
        const broken = parseHTML(`<html><body><article>${content}</article></body></html>`).document;
        expect(await extractWebArticle(broken as unknown as Document, sourceUrl)).toEqual({status: 'unavailable'});
    });

    it('bounds processor output and removes active markup while retaining typeset details', async () => {
        const document = articlePage(`<article class="article-body"><!-- Commentary --><reading-shell><p>${prose}</p></reading-shell>
            <math display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac><annotation encoding="application/x-tex">1/2</annotation><annotation-xml>Foreign math</annotation-xml></math></article>`);
        for (const element of document.querySelectorAll('math, math *')) {
            Object.defineProperty(element, 'namespaceURI', {value: 'http://www.w3.org/1998/Math/MathML'});
        }
        const other = document.createElement('foreign-namespace');
        Object.defineProperty(other, 'namespaceURI', {value: 'urn:foreign:'});
        other.textContent = 'Foreign node';
        document.body.append(other);
        const realParse = Defuddle.prototype.parse;
        const parse = vi.spyOn(Defuddle.prototype, 'parse');
        for (const content of ['x'.repeat(MAX_WEB_ARTICLE_BYTES * 4 + 1), '<span></span>'.repeat(12001),
            `<p>${'文'.repeat(180_000)}</p>`]) {
            parse.mockImplementationOnce(function (this: Defuddle) {return {...realParse.call(this), content};});
            expect(await extractWebArticle(document, sourceUrl)).toEqual({status: 'too-large'});
        }
        parse.mockImplementationOnce(function (this: Defuddle) {
            const result = realParse.call(this);
            expect(result.content).not.toMatch(/Foreign math|Foreign node/u);
            return {...result, title: '', content: `<p class="attacker-only">${prose}</p>
                <aside>Sidebar noise</aside><script>Active content</script>
                <div class="callout attacker-class" data-callout="tip"><p>Summary. ${prose}</p></div>
                <table><tr><td colspan="2">Table context</td></tr></table>
                <p><img src="https://images.test/probe" alt="Figure caption"></p>
                <reading-summary>Unwrapped text</reading-summary>
                <ol id="footnotes"><li id="fn:example">Reference context</li></ol>`};
        });
        const result = await extractWebArticle(document, sourceUrl);
        expect(result).toMatchObject({status: 'ok', html: expect.stringContaining('colspan="2"')});
        expect(JSON.stringify(result)).toMatch(/Unwrapped text/);
        expect(JSON.stringify(result)).not.toMatch(/Sidebar noise|Active content|attacker-class|images.test/);
    });

    it('recovers dropped titles, avoids duplicate titles over existing section headings and bounds link-heavy fragments', async () => {
        const original = Defuddle.prototype.parse;
        const parse = vi.spyOn(Defuddle.prototype, 'parse');
        const document = articlePage(`<article><h1>Article title</h1><p>${prose}</p></article>`);
        parse.mockImplementationOnce(function (this: Defuddle) {
            return {...original.call(this), title: 'Article title', content: `<p>${prose}</p>`};
        });
        expect(await extractWebArticle(document, sourceUrl)).toMatchObject({status: 'ok', html: expect.stringContaining('<h1>Article title</h1>')});
        parse.mockImplementationOnce(function (this: Defuddle) {
            return {...original.call(this), title: 'Saved title', content: `<h2>Existing heading</h2><p>${prose}</p>`};
        });
        const section = await extractWebArticle(articlePage(`<article><p>${prose}</p></article>`), sourceUrl);
        expect(section).toMatchObject({status: 'ok', title: 'Saved title'});
        expect(JSON.stringify(section)).not.toContain('<h1>');
        const link = `<a href="https://example.test/${'a'.repeat(8000)}">reference</a>`;
        const links = articlePage(`<article><p>${prose} ${link.repeat(70)}</p></article>`);
        expect(await extractWebArticle(links, sourceUrl)).toEqual({status: 'too-large'});
    });

    it('opens the exact saved source version, preserves edits and position on repeated opens, and cleans metadata', async () => {
        const x = navigation();
        expect(await x.open()).toEqual({status: 'opened'});
        expect(x.askForArticle).toHaveBeenCalledWith(9, sourceUrl);
        const [entry] = await x.history.list();
        expect(entry.sourceUrl).toBe(sourceUrl);
        expect(getDocumentFormat(entry.name)).toBe('html');
        const id = entry.id, readerUrl = documentUrl + '?article=' + id;
        expect(x.openDocument).toHaveBeenCalledWith(readerUrl, 7);
        expect(readerUrl).not.toContain(sourceUrl);
        const checked = await x.history.loadChecked(id);
        if (checked.status !== 'ok' || !checked.record) throw new Error('Article history missing');
        expect(await x.history.saveArticleProgress(id, .66)).toBe(true);
        expect(await x.history.loadArticleProgress(id)).toBe(.66);
        expect(await x.history.saveArticleProgress(id, 2)).toBe(false);
        expect(await x.history.saveArticleProgress('deleted', .7)).toBe(false);
        const updated = await x.history.saveChecked({...checked.record, translations: ['校订译文'], total: 1, completed: 1}, checked.version);
        expect(updated.status).toBe('saved');
        expect(await x.open()).toEqual({status: 'opened'});
        expect(x.openDocument).toHaveBeenLastCalledWith(readerUrl, 7);
        expect((await x.history.load(id))?.translations).toEqual(['校订译文']);
        expect(await x.history.loadArticleProgress(id)).toBe(.66);
        expect(await x.history.remove(id)).toBe(true);
        expect(await x.history.loadArticleProgress(id)).toBeUndefined();
        expect(await x.open()).toEqual({status: 'opened'});
        await x.history.saveArticleProgress(id, .55);
        expect(await x.history.clear()).toBe(true);
        expect(await x.history.loadArticleProgress(id)).toBeUndefined();
    });

    it('rejects stale or mismatched source pages and propagates extraction results without writing another record', async () => {
        const x = navigation();
        expect(await x.handler.handle(message, {sender: {id: 'foreign'}})).toEqual({status: 'unavailable'});
        expect(await x.handler.handle(message, {sender: {id: 'fixture', url: documentUrl}})).toEqual({status: 'unavailable'});
        expect(await x.handler.handle({...message, tabId: '9'}, ctx)).toEqual({status: 'unavailable'});
        expect(await x.handler.handle({...message, expectedUrl: 'chrome://settings/'}, ctx)).toEqual({status: 'unavailable'});
        expect(await x.handler.handle({...message, expectedUrl: 'https://example.test/source.pdf'}, ctx)).toEqual({status: 'unavailable'});
        x.isDisabled.mockReturnValueOnce(true);
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.source.incognito = true;
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.source.incognito = false;
        x.source.pendingUrl = 'https://elsewhere.test/';
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.source.pendingUrl = undefined;
        x.source.url += 'moved';
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.source.url = sourceUrl;
        expect(x.askForArticle).not.toHaveBeenCalled();
        for (const status of ['no-article', 'too-large']) {
            x.askForArticle.mockResolvedValueOnce({status});
            expect(await x.open()).toEqual({status});
        }
        x.askForArticle.mockImplementationOnce(async () => {x.source.url += 'moved';return response;});
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.source.url = sourceUrl;
        x.askForArticle.mockResolvedValueOnce(null);
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.askForArticle.mockResolvedValueOnce({...response, sourceUrl: 'https://elsewhere.test/'});
        expect(await x.open()).toEqual({status: 'unavailable'});
        x.askForArticle.mockRejectedValueOnce(new Error('Closed'));
        expect(await x.open()).toEqual({status: 'unavailable'});
        expect(x.openDocument).not.toHaveBeenCalled();
        expect(await x.history.list()).toEqual([]);
    });

    it('handles duplicate and expired requests without writing from an expired tab', async () => {
        vi.useFakeTimers();
        const x = navigation();
        x.captureDocument.mockReturnValueOnce(vi.fn(() => false));
        expect(await x.open()).toEqual({status: 'unavailable'});
        let deliver!: (value: unknown) => void;
        x.askForArticle.mockImplementationOnce(() => new Promise(resolve => {deliver = resolve;}));
        const pending = x.open();
        await vi.advanceTimersByTimeAsync(0);
        expect(x.askForArticle).toHaveBeenCalledOnce();
        expect(await x.open()).toEqual({status: 'unavailable'});
        await vi.advanceTimersByTimeAsync(12000);
        expect(await pending).toEqual({status: 'unavailable'});
        deliver(response);
        await Promise.resolve();
        expect(x.openDocument).not.toHaveBeenCalled();
    });

    it('opens only with authoritative history and reuses concurrent saves without overwriting', async () => {
        const x = navigation();
        const realSave = x.history.saveChecked;
        const read = vi.spyOn(x.history, 'loadChecked');
        const save = vi.spyOn(x.history, 'saveChecked');
        read.mockResolvedValueOnce({status: 'unavailable'});
        expect(await x.open()).toEqual({status: 'unavailable'});
        save.mockResolvedValueOnce({status: 'unavailable'});
        expect(await x.open()).toEqual({status: 'unavailable'});
        save.mockResolvedValueOnce({status: 'conflict'});
        expect(await x.open()).toEqual({status: 'unavailable'});
        save.mockImplementationOnce(async (record, version) => {
            const saved = await realSave(record, version);
            expect(saved.status).toBe('saved');
            return {status: 'conflict'};
        });
        expect(await x.open()).toEqual({status: 'opened'});
        const source = {...x.source};
        x.getTab.mockResolvedValueOnce(source).mockResolvedValueOnce(source).mockResolvedValueOnce({...source, pendingUrl: 'https://elsewhere.test/'});
        expect(await x.open()).toEqual({status: 'unavailable'});
        expect(x.openDocument).toHaveBeenCalledOnce();
    });

    it('uses the host for an empty title and stops before history when hashing is unavailable', async () => {
        const x = navigation();
        x.askForArticle.mockResolvedValue({...response, title: ' '});
        vi.stubGlobal('crypto', {});
        try {expect(await x.open()).toEqual({status: 'unavailable'});}
        finally {vi.unstubAllGlobals();}
        expect(await x.history.list()).toHaveLength(0);
        expect(await x.open()).toEqual({status: 'opened'});
        expect((await x.history.list())[0].name).toBe('example.test.html');
    });

    it('restores reading position, persists scroll without waiting for export, and opens safe links outside the preview', async () => {
        vi.useFakeTimers();
        const {document, window} = parseHTML('<html><body><a href="https://example.test/section"><span>Section link</span></a><a href="javascript:void(0)">Blocked</a></body></html>');
        const scroller = {scrollHeight: 2100, clientHeight: 100, scrollTop: 0};
        Object.defineProperty(document, 'scrollingElement', {value: scroller});
        const storage = {loadArticleProgress: vi.fn(async () => .6), saveArticleProgress: vi.fn(async () => true)};
        const openLink = vi.fn();
        const stop = trackWebArticleReading(document as unknown as Document, 'article', storage, openLink);
        await Promise.resolve();
        expect(scroller.scrollTop).toBe(1200);
        document.dispatchEvent(new window.Event('scroll'));
        expect(storage.saveArticleProgress).not.toHaveBeenCalled();
        scroller.scrollTop = 700;
        document.dispatchEvent(new window.Event('scroll'));
        await vi.advanceTimersByTimeAsync(250);
        expect(storage.saveArticleProgress).toHaveBeenCalledWith('article', .35);
        document.querySelector('span')!.dispatchEvent(new window.Event('click', {bubbles: true, cancelable: true}));
        document.querySelector('a:last-child')!.dispatchEvent(new window.Event('click', {bubbles: true, cancelable: true}));
        expect(openLink.mock.calls).toEqual([['https://example.test/section']]);
        scroller.scrollTop = 1000;
        document.dispatchEvent(new window.Event('scroll'));
        stop();
        expect(storage.saveArticleProgress).toHaveBeenLastCalledWith('article', .5);
    });

    it('lets active scrolling take priority over a pending restore and lets a missing preview go', async () => {
        const {document, window} = parseHTML('<html><body><p>Content</p></body></html>');
        const view = document as unknown as Document;
        const openLink = vi.fn();
        const saveArticleProgress = vi.fn(async () => true);
        let deliver!: (value?: number) => void;
        const loadArticleProgress = vi.fn(() => new Promise<number | undefined>(resolve => {deliver = resolve;}));
        const history = {loadArticleProgress, saveArticleProgress};
        trackWebArticleReading(view, 'empty', history, openLink)();
        expect(loadArticleProgress).not.toHaveBeenCalled();
        const scroller = {scrollHeight: 100, clientHeight: 100, scrollTop: 0};
        Object.defineProperty(document, 'scrollingElement', {value: scroller});
        const first = trackWebArticleReading(view, 'first', history, openLink);
        document.querySelector('p')!.dispatchEvent(new window.Event('click', {bubbles: true}));
        first();
        deliver(.45);
        await Promise.resolve();
        const second = trackWebArticleReading(view, 'second', history, openLink);
        scroller.scrollHeight = 1100; scroller.scrollTop = 700;
        document.dispatchEvent(new window.Event('scroll'));
        scroller.scrollTop = 900;
        document.dispatchEvent(new window.Event('scroll'));
        deliver(.25);
        await Promise.resolve();
        expect(scroller.scrollTop).toBe(900);
        second();
        const third = trackWebArticleReading(view, 'third', history, openLink);
        deliver(undefined);
        await Promise.resolve();
        third();
        expect(saveArticleProgress.mock.calls).toEqual([['second', .9]]);
    });
});
