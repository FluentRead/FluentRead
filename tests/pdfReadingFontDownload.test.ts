import {createHash, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {resetPreferredMirrorOrigins} from '@/src/core/assets/mirrors';
import {
    createPdfReadingFontLoader, getPdfReadingFontSources, loadPdfReadingFontBytes,
    PDF_READING_FONT_BYTES, PDF_READING_FONT_CACHE, PDF_READING_FONT_CACHE_KEY,
    PDF_READING_FONT_PATH, PDF_READING_FONT_REVISION, PDF_READING_FONT_SHA256,
    type PdfReadingFontLoaderDependencies,
} from '@/src/features/document-translation/services/pdfReadingFont';

const fontBytes = new Uint8Array(readFileSync(new URL('../assets/pdf-fonts/FluentReadNotoSansSC-Regular.woff2', import.meta.url)));
const response = (bytes = fontBytes, headers: Record<string, string> = {}) => new Response(bytes.slice(), {headers});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
function harness(overrides: Partial<PdfReadingFontLoaderDependencies> = {}) {
    const entries = new Map<string, Response>();
    const cache = {
        match: vi.fn(async (key: RequestInfo | URL) => entries.get(String(key))?.clone()),
        put: vi.fn(async (key: RequestInfo | URL, value: Response) => {entries.set(String(key), value.clone());}),
        delete: vi.fn(async (key: RequestInfo | URL) => entries.delete(String(key))),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const digest = vi.fn(async (bytes: ArrayBuffer) => webcrypto.subtle.digest('SHA-256', bytes));
    const openCache = vi.fn(async () => cache);
    const deps = {fetch, digest, openCache, locale: () => 'en-US', timeoutMs: 5_000, ...overrides};
    return {entries, cache, fetch, digest, openCache, deps, load: createPdfReadingFontLoader(deps)};
}
afterEach(() => {resetPreferredMirrorOrigins(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('PDF reading font data download', () => {
    it('releases rejected source bodies before fallback and unlocks the verified font stream', async () => {
        const h = harness();
        const cancellation = deferred<void>();
        const cancel = vi.fn(() => cancellation.promise);
        const rejected = new Response(new ReadableStream({cancel}), {headers: {'Content-Type': 'text/html'}});
        const verified = response();
        h.fetch.mockResolvedValueOnce(rejected).mockResolvedValueOnce(verified);
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(cancel).toHaveBeenCalledOnce();
        expect(rejected.body!.locked).toBe(false);
        expect(verified.body!.locked).toBe(false);
        cancellation.reject(new Error('Late font cancellation failure'));
        await Promise.resolve();
    });
    it('pins an immutable source revision containing the maintained supplemental font', () => {
        expect(PDF_READING_FONT_REVISION).toMatch(/^[a-f0-9]{40}$/u);
        const pinned = execFileSync('git', ['show', `${PDF_READING_FONT_REVISION}:public${PDF_READING_FONT_PATH}`], {cwd: process.cwd(), maxBuffer: 6_000_000});
        expect(pinned.byteLength).toBe(PDF_READING_FONT_BYTES);
        expect(hash(pinned)).toBe(PDF_READING_FONT_SHA256);
        expect(Buffer.compare(pinned, Buffer.from(fontBytes))).toBe(0);
    });

    it('pins the same real bytes as the maintained font, persists them, and reopens offline', async () => {
        const h = harness();
        const downloaded = await h.load();
        expect(Buffer.compare(Buffer.from(downloaded), Buffer.from(fontBytes))).toBe(0);
        expect(downloaded.byteLength).toBe(PDF_READING_FONT_BYTES);
        expect(hash(downloaded)).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.fetch).toHaveBeenCalledWith(getPdfReadingFontSources('en-US')[0], {
            signal: expect.any(AbortSignal), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        });
        expect(h.cache.put).toHaveBeenCalledWith(PDF_READING_FONT_CACHE_KEY, expect.any(Response));
        expect(h.entries.get(PDF_READING_FONT_CACHE_KEY)?.headers.get('Content-Type')).toBe('font/woff2');
        h.fetch.mockRejectedValue(new Error('offline'));
        const reopened = createPdfReadingFontLoader(h.deps);
        expect(hash(await reopened())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.digest).toHaveBeenCalledTimes(2);
    });

    it.each(['zh', 'zh-CN', 'zh-Hans', 'ZH-hans-CN'])('tries domestic sources first for browser locale %s', async locale => {
        const h = harness({locale: () => locale});
        await h.load();
        expect(h.fetch.mock.calls[0][0]).toContain('cdn.jsdmirror.com');
    });

    it.each(['en-US', 'ja-JP', 'de-DE', 'fr-FR', 'zh-TW', ''])('keeps global sources first for browser locale %s', locale => {
        const sources = getPdfReadingFontSources(locale);
        expect(sources[0]).toContain('cdn.jsdelivr.net');
        expect(sources[1]).toContain('raw.githubusercontent.com');
        expect(sources[2]).toContain('cdn.jsdmirror.com');
        expect(sources[3]).toContain('jsd.onmicrosoft.cn');
        expect(new Set(sources).size).toBe(4);
        for (const source of sources) {
            expect(source).toContain(PDF_READING_FONT_REVISION);
            expect(source).toContain(`public${PDF_READING_FONT_PATH}`);
            expect(source).toMatch(/^https:\/\//);
        }
    });

    it.each(['http', 'body', 'html', 'network', 'short', 'oversize-header', 'oversize-stream', 'hash', 'digest', 'stream'])
    ('falls back after a %s source failure and only caches verified bytes', async failure => {
        const h = harness();
        if (failure === 'http') h.fetch.mockResolvedValueOnce(new Response('HTTP error', {status: 503}));
        if (failure === 'body') h.fetch.mockResolvedValueOnce(new Response(null));
        if (failure === 'html') h.fetch.mockResolvedValueOnce(new Response('<html>error</html>', {headers: {'Content-Type': 'text/html'}}));
        if (failure === 'network') h.fetch.mockRejectedValueOnce(new Error('unreachable'));
        if (failure === 'short') h.fetch.mockResolvedValueOnce(response(new Uint8Array(5)));
        if (failure === 'oversize-header') h.fetch.mockResolvedValueOnce(response(fontBytes, {'Content-Length': String(PDF_READING_FONT_BYTES + 1)}));
        if (failure === 'oversize-stream') h.fetch.mockResolvedValueOnce(response(new Uint8Array(PDF_READING_FONT_BYTES + 1)));
        if (failure === 'hash') {
            const corrupt = fontBytes.slice(); corrupt[100] ^= 1;
            h.fetch.mockResolvedValueOnce(response(corrupt));
        }
        if (failure === 'digest') h.digest.mockRejectedValueOnce(new Error('crypto busy'));
        if (failure === 'stream') h.fetch.mockResolvedValueOnce(new Response(new ReadableStream({start(controller) {controller.error(new Error('broken stream'));}})));
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.cache.put).toHaveBeenCalledTimes(1);
    });

    it('accepts compressed transfer metadata and multiple bounded stream chunks', async () => {
        const h = harness();
        h.fetch.mockResolvedValueOnce(new Response(new ReadableStream({start(controller) {
            controller.enqueue(fontBytes.slice(0, 11)); controller.enqueue(fontBytes.slice(11)); controller.close();
        }}), {headers: {'Content-Encoding': 'br', 'Content-Length': String(PDF_READING_FONT_BYTES + 200)}}));
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['open', 'put'])('continues a verified export when cache %s is unavailable', async failure => {
        const h = harness();
        if (failure === 'open') h.openCache.mockRejectedValue(new Error('CacheStorage blocked'));
        else h.cache.put.mockRejectedValue(new Error('QuotaExceededError'));
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.entries.size).toBe(0);
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it.each(['short', 'hash', 'match', 'delete'])('repairs or bypasses a bad cached entry (%s)', async failure => {
        const h = harness();
        const corrupt = fontBytes.slice(); corrupt[10] ^= 1;
        h.entries.set(PDF_READING_FONT_CACHE_KEY, response(failure === 'short' ? new Uint8Array(4) : corrupt));
        if (failure === 'match') h.cache.match.mockRejectedValueOnce(new Error('cache read failed'));
        if (failure === 'delete') h.cache.delete.mockRejectedValueOnce(new Error('cache delete failed'));
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.cache.delete).toHaveBeenCalledWith(PDF_READING_FONT_CACHE_KEY);
        expect(h.cache.put).toHaveBeenCalledTimes(1);
    });

    it.each(['fetch', 'read', 'digest'])('times out even when %s ignores abort and switches sources', async stage => {
        vi.useFakeTimers();
        const h = harness({timeoutMs: 100});
        const never = new Promise<never>(() => {});
        if (stage === 'fetch') h.fetch.mockImplementationOnce(() => never);
        if (stage === 'read') h.fetch.mockResolvedValueOnce(new Response(new ReadableStream({pull() {return never;}})));
        if (stage === 'digest') h.digest.mockImplementationOnce(() => never);
        const loading = h.load();
        const done = expect(loading.then(hash)).resolves.toBe(PDF_READING_FONT_SHA256);
        await vi.advanceTimersByTimeAsync(101);
        await done;
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('fails after all sources and can retry the same loader without poisoned in-flight state', async () => {
        const h = harness();
        h.fetch.mockRejectedValue(new Error('offline'));
        await expect(h.load()).rejects.toThrow('PDF 导出字体下载失败');
        expect(h.fetch).toHaveBeenCalledTimes(4);
        h.fetch.mockResolvedValue(response());
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(5);
    });

    it('rejects an already canceled caller before accessing cache or network', async () => {
        const h = harness(); const controller = new AbortController();
        controller.abort(new Error('export canceled'));
        await expect(h.load(controller.signal)).rejects.toThrow('export canceled');
        expect(h.openCache).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    });

    it('deduplicates parallel exports while one caller cancellation leaves another download alive', async () => {
        const h = harness(); const connection = deferred<Response>(); const started = deferred<void>();
        let downloadSignal!: AbortSignal;
        h.fetch.mockImplementationOnce(async (_url, options) => {
            downloadSignal = options!.signal as AbortSignal; started.resolve(); return connection.promise;
        });
        const controller = new AbortController();
        const first = h.load(controller.signal); const cancelled = expect(first).rejects.toThrow('only first canceled');
        const second = h.load();
        await started.promise;
        controller.abort(new Error('only first canceled')); await cancelled;
        expect(downloadSignal.aborted).toBe(false);
        connection.resolve(response());
        expect(hash(await second)).toBe(PDF_READING_FONT_SHA256); expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['fetch', 'read', 'digest', 'cache-open', 'cache-match', 'cache-put'])
    ('cancels an uncooperative %s stage without fallback and permits immediate retry', async stage => {
        const entered = deferred<void>(); const never = new Promise<never>(() => {});
        const h = harness();
        if (stage === 'fetch') h.fetch.mockImplementationOnce(async () => {entered.resolve(); return never;});
        if (stage === 'read') h.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({pull() {entered.resolve(); return never;}})));
        if (stage === 'digest') h.digest.mockImplementationOnce(async () => {entered.resolve(); return never;});
        if (stage === 'cache-open') h.openCache.mockImplementationOnce(async () => {entered.resolve(); return never;});
        if (stage === 'cache-match') h.cache.match.mockImplementationOnce(async () => {entered.resolve(); return never;});
        if (stage === 'cache-put') h.cache.put.mockImplementationOnce(async () => {entered.resolve(); return never;});
        const controller = new AbortController(); const loading = h.load(controller.signal);
        const canceled = expect(loading).rejects.toThrow('canceled stage');
        await entered.promise; const callsBefore = h.fetch.mock.calls.length;
        controller.abort(new Error('canceled stage')); await canceled;
        expect(h.fetch).toHaveBeenCalledTimes(callsBefore);
        expect(hash(await h.load())).toBe(PDF_READING_FONT_SHA256);
        expect(h.fetch).toHaveBeenCalledTimes(callsBefore + 1);
    });

    it('handles cancellation before an asynchronous operation starts', async () => {
        const h = harness(); const controller = new AbortController();
        const loading = h.load(controller.signal); const canceled = expect(loading).rejects.toThrow('early cancel');
        controller.abort(new Error('early cancel')); await canceled;
        expect(h.fetch).not.toHaveBeenCalled(); expect(h.openCache).not.toHaveBeenCalled();
    });

    it.each([undefined, 'zh-CN'])('uses browser defaults and persistent cache without downloading a script (locale %s)', async locale => {
        const h = harness();
        vi.stubGlobal('fetch', h.fetch); vi.stubGlobal('caches', {open: h.openCache}); vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('navigator', locale === undefined ? undefined : {language: locale});
        const downloaded = locale === undefined ? await loadPdfReadingFontBytes() : await createPdfReadingFontLoader()();
        expect(hash(downloaded)).toBe(PDF_READING_FONT_SHA256);
        expect(h.openCache).toHaveBeenCalledWith(PDF_READING_FONT_CACHE);
        expect(h.fetch.mock.calls[0][0]).toContain(locale ? 'cdn.jsdmirror.com' : 'cdn.jsdelivr.net');
    });
});
