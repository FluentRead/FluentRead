import {IDBFactory} from 'fake-indexeddb';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseDocument} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {normalizeWebArticleProgress, normalizeWebArticleUrl, webArticleIdentityBytes} from '@/src/features/document-translation/core/webArticle';
import {createDocumentHistory} from '@/src/features/document-translation/services/history';
import {trackWebArticleReading} from '@/src/features/document-translation/ui/webArticleReading';

afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});

describe('Reading saved webpage articles in the document workbench', () => {
    it('validates the original webpage URL and reading position of a saved article', () => {
        const sourceUrl = 'https://example.test/news/study';
        expect(normalizeWebArticleUrl(sourceUrl)).toBe(sourceUrl);
        for (const invalid of [undefined, '', 'file:///tmp/x', 'javascript:void(0)', 'https://user:secret@example.test']) {
            expect(normalizeWebArticleUrl(invalid)).toBeNull();
        }
        for (const invalid of [NaN, Infinity, -0.1, 1.1, null, '0.5']) expect(normalizeWebArticleProgress(invalid)).toBeUndefined();
        expect([0, 0.5, 1].map(normalizeWebArticleProgress)).toEqual([0, 0.5, 1]);
    });

    it('reads the saved HTML, source, edits and scroll position from history', async () => {
        const history = createDocumentHistory(new IDBFactory());
        const id = 'a'.repeat(64);
        const name = 'A field study.html';
        const sourceUrl = 'https://example.test/news/study';
        const html = '<article><p>A saved paragraph from the field study.</p><a href="' + sourceUrl + '">Field study</a></article>';
        const bytes = new TextEncoder().encode(html);
        expect(new TextDecoder().decode(webArticleIdentityBytes(sourceUrl, bytes))).toBe(`fluentread:web-article\0${sourceUrl}\0${html}`);
        const initial = await history.loadChecked(id);
        if (initial.status !== 'ok') throw new Error('Article history is unavailable');
        expect(initial.record).toBeNull();
        const saved = await history.saveChecked({
            id, name, bytes, format: 'html', mimeType: 'text/html', sourceUrl, size: bytes.byteLength,
            translations: ['已校订的译文'], fingerprint: '', updatedAt: 1710000000000, total: 1, completed: 1,
        }, initial.version);
        expect(saved.status).toBe('saved');
        expect(await history.saveArticleProgress(id, .66)).toBe(true);
        expect(await history.list()).toMatchObject([{id, name, sourceUrl, completed: 1}]);
        const record = await history.load(id);
        expect(record).toMatchObject({sourceUrl, translations: ['已校订的译文']});
        expect(await history.loadArticleProgress(id)).toBe(.66);
        const document = parseDocument(name, new TextDecoder().decode(record?.bytes));
        const preview = createDocumentPreviewHtml(document, [], 'source');
        expect(preview).toContain('A saved paragraph from the field study.');
        expect(preview).toContain('href="' + sourceUrl + '"');
        expect(await history.remove(id)).toBe(true);
        expect(await history.loadArticleProgress(id)).toBeUndefined();
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
