import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {TextItem} from 'pdfjs-dist/types/src/display/api';
import {describe, expect, it, vi} from 'vitest';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';
import {createDocumentDownload, type PdfReadingRenderer} from '@/src/features/document-translation/services/binary';
import {embedPdfReadingFont, loadPdfReadingFontBytes, PDF_READING_FONT_BYTES} from '@/src/features/document-translation/services/pdfReadingFont';
import {renderPdfReadingPages} from '@/src/features/document-translation/ui/pdfPreview';

const fontBytes = new Uint8Array(readFileSync(new URL('../public/pdf-fonts/FluentReadNotoSansSC-Regular.woff2', import.meta.url)));
const textOnlyOptions = {pdfReadingRenderer: renderPdfReadingPages, pdfFontLoader: async () => fontBytes};
const compact = (text: string) => text.replace(/\s/gu, '');

async function fixture(): Promise<ParsedDocument> {
    const source = await PDFDocument.create();
    source.addPage([600, 800]).drawText('Original selectable source page', {x: 42, y: 720, size: 14});
    return {fileName: 'copyable.pdf', format: 'pdf', label: 'PDF 文件', parts: [],
        segments: [{id: 0, source: 'Original title', contextLabel: '第 1 页', role: 'title'},
            {id: 1, source: 'Original paragraph', contextLabel: '第 1 页', role: 'paragraph'}],
        binary: {kind: 'pdf', bytes: await source.save(), pages: [{pageNumber: 1, width: 600, height: 800,
            segmentIndexes: [0, 1], blocks: [0, 1].map(segmentIndex => ({segmentIndex,
                x: 42, y: 50 + segmentIndex * 60, width: 500, height: 40,
                kind: segmentIndex === 0 ? 'heading' as const : 'text' as const,
                fontSize: 14, lineHeight: 20, lineCount: 2, fontFamily: 'sans-serif', fontWeight: 400 as const, textAlign: 'left' as const,
            }))}]}};
}

async function extract(bytes: Uint8Array): Promise<string[]> {
    const task = getDocument({data: bytes.slice(), disableFontFace: true, isEvalSupported: false});
    const pdf = await task.promise;
    try {
        const texts: string[] = [];
        for (let index = 1; index <= pdf.numPages; index++) {
            const page = await pdf.getPage(index);
            texts.push((await page.getTextContent({disableNormalization: true})).items.filter((item): item is TextItem => 'str' in item).map(item => item.str).join('\n'));
            page.cleanup();
        }
        return texts;
    } finally {await task.destroy();}
}

function saveEvidence(name: string, bytes: Uint8Array): void {
    const directory = process.env.FLUENTREAD_PDF_EVIDENCE_DIR;
    if (!directory) return;
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, name), bytes);
}

describe('visible Unicode PDF reading export', () => {
    it('retains every visible glyph outline after subsetting, including odd-length Chinese/Latin records', async () => {
        const font = fontkit.create(fontBytes);
        const subset = font.createSubset();
        const glyphs = font.layout('中文译文标题 Mixed English 123，标点。éü①②', {liga: false}).glyphs;
        const pairs = glyphs.map(glyph => ({original: glyph, index: subset.includeGlyph(glyph)}));
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
            const parts: Uint8Array[] = [];
            const stream = subset.encodeStream() as unknown as import('node:stream').Readable;
            stream.on('data', part => parts.push(part)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
        });
        const embedded = fontkit.create(bytes);
        for (const {original, index} of pairs) expect(embedded.getGlyph(index).path.toSVG()).toBe(original.path.toSVG());
    });
    it('writes Chinese, Latin, punctuation and tabs as actual extractable text with a small font subset', async () => {
        const translations = ['中文译文标题', '中文译文可直接复制和搜索。Mixed English 123\t中英混合，标点：？！“引号”《书名》；①②。·• 兀兀'];
        const download = await createDocumentDownload(await fixture(), translations, 'translated', textOnlyOptions);
        const bytes = download.data as Uint8Array;
        const pages = await extract(bytes);
        expect(pages).toHaveLength(1);
        expect(compact(pages.join(''))).toBe(compact(translations.join('')));
        expect(bytes.byteLength).toBeLessThan(160_000);
        saveEvidence('chinese-mixed-selectable.pdf', bytes);
    });

    it('continues long Chinese text at a fixed readable size and keeps every paragraph including the tail', async () => {
        const paragraph = '长文译文自动续页，完整保留每一句中文及标点。';
        const translations = ['长文续页验证', paragraph.repeat(600) + '唯一末尾字符：完。'];
        const progress: string[] = [];
        const download = await createDocumentDownload(await fixture(), translations, 'translated', {...textOnlyOptions,
            onPdfProgress: value => progress.push(`${value.phase}:${value.completedPages}/${value.totalPages}`),
        });
        const bytes = download.data as Uint8Array;
        const pages = await extract(bytes);
        expect(pages.length).toBeGreaterThan(5);
        expect(compact(pages.join(''))).toBe(compact(translations.join('')));
        expect(pages.at(-1)).toContain('唯一末尾字符：完。');
        expect(progress).toEqual(['rendering:0/1', 'rendering:1/1', 'saving:1/1']);
        const pdf = await PDFDocument.load(bytes);
        expect(pdf.getPages().every(page => page.getWidth() === 612 && page.getHeight() === 792)).toBe(true);
        saveEvidence('chinese-long-continuation.pdf', bytes);
    });

    it('preserves selectable original pages in bilingual output and the optional layout preview alongside selectable translation', async () => {
        const translations = ['双语对照标题', '原论文页继续保留，译文页可以复制。'];
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
        const raster = vi.fn(async () => png);
        const download = await createDocumentDownload(await fixture(), translations, 'bilingual', {
            ...textOnlyOptions, pdfPresentation: 'layout', pdfPageRasterizer: raster,
        });
        const bytes = download.data as Uint8Array;
        const pages = await extract(bytes);
        expect(pages).toHaveLength(3);
        expect(pages[0]).toContain('Original selectable source page');
        expect(pages[1]).toBe('');
        expect(compact(pages[2])).toBe(compact(translations.join('')));
        expect(raster).toHaveBeenCalledOnce();
        saveEvidence('bilingual-original-and-translation.pdf', bytes);
    });

    it('does not load fonts for an unchanged bilingual document', async () => {
        const document = await fixture();
        const loader = vi.fn(async () => fontBytes);
        const download = await createDocumentDownload(document, document.segments.map(segment => segment.source), 'bilingual', {...textOnlyOptions, pdfFontLoader: loader});
        expect(loader).not.toHaveBeenCalled();
        expect((await extract(download.data as Uint8Array))[0]).toContain('Original selectable source page');
    });

    it('rejects missing glyphs explicitly instead of producing a broken downloadable PDF', async () => {
        await expect(createDocumentDownload(await fixture(), ['标题', '不支持的字符🦄'], 'translated', textOnlyOptions)).rejects.toThrow('U+1F984');
    });

    it('checks cancellation after font loading and closes a continuation iterator without changing translations', async () => {
        const controller = new AbortController();
        await expect(createDocumentDownload(await fixture(), ['标题', '译文'], 'translated', {...textOnlyOptions, signal: controller.signal,
            pdfFontLoader: async () => {controller.abort(new Error('Font loading canceled')); return fontBytes;},
        })).rejects.toThrow('Font loading canceled');
        const continuation = new AbortController();
        let released = false;
        const renderer: PdfReadingRenderer = async function* (input) {
            try {
                for await (const page of renderPdfReadingPages(input)) {
                    yield page;
                    continuation.abort(new Error('Continuation canceled'));
                }
            } finally {released = true;}
        };
        const translations = ['标题', '长文译文。'.repeat(1000)];
        await expect(createDocumentDownload(await fixture(), translations, 'translated', {...textOnlyOptions,
            pdfReadingRenderer: renderer, signal: continuation.signal,
        })).rejects.toThrow('Continuation canceled');
        expect(released).toBe(true);
        expect(translations).toEqual(['标题', '长文译文。'.repeat(1000)]);
    });

    it('loads the bundled font with cancellation and rejects truncated assets', async () => {
        const fetch = vi.fn(async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(10)}));
        vi.stubGlobal('fetch', fetch);
        try {
            const controller = new AbortController();
            await expect(loadPdfReadingFontBytes(controller.signal)).rejects.toThrow('字体不完整');
            expect(fetch).toHaveBeenCalledWith('/pdf-fonts/FluentReadNotoSansSC-Regular.woff2', {signal: controller.signal, cache: 'force-cache'});
            expect(fontBytes.byteLength).toBe(PDF_READING_FONT_BYTES);
        } finally {vi.unstubAllGlobals();}
    });

    it('returns complete bundled bytes and reports HTTP failure without decoding a broken response', async () => {
        const fetch = vi.fn(async () => ({ok: true, arrayBuffer: async () => fontBytes.slice().buffer}));
        vi.stubGlobal('fetch', fetch);
        try {
            const loaded = await loadPdfReadingFontBytes();
            expect(createHash('sha256').update(loaded).digest('hex')).toBe(createHash('sha256').update(fontBytes).digest('hex'));
            fetch.mockResolvedValueOnce({ok: false, arrayBuffer: async () => {throw new Error('Should not read HTTP error');}});
            await expect(loadPdfReadingFontBytes()).rejects.toThrow('字体加载失败');
        } finally {vi.unstubAllGlobals();}
    });

    it('cancels font fetching before the request and after a response read completes', async () => {
        const before = new AbortController();
        const reading = new AbortController();
        const fetch = vi.fn(async () => ({ok: true, arrayBuffer: async () => {
            reading.abort(new Error('Font response canceled')); return fontBytes.slice().buffer;
        }}));
        vi.stubGlobal('fetch', fetch);
        try {
            before.abort(new Error('Before font request'));
            await expect(loadPdfReadingFontBytes(before.signal)).rejects.toThrow('Before font request');
            expect(fetch).not.toHaveBeenCalled();
            await expect(loadPdfReadingFontBytes(reading.signal)).rejects.toThrow('Font response canceled');
        } finally {vi.unstubAllGlobals();}
    });

    it('cancels before fontkit initialization, during its lazy import, and after font embedding', async () => {
        const pdf = await PDFDocument.create();
        const before = new AbortController();
        before.abort(new Error('Before fontkit initialization'));
        await expect(embedPdfReadingFont(pdf, fontBytes, before.signal)).rejects.toThrow('Before fontkit initialization');
        const importing = new AbortController();
        const imported = embedPdfReadingFont(pdf, fontBytes, importing.signal);
        importing.abort(new Error('During fontkit initialization'));
        await expect(imported).rejects.toThrow('During fontkit initialization');
        const embedding = new AbortController();
        const embedFont = pdf.embedFont.bind(pdf);
        const spy = vi.spyOn(pdf, 'embedFont').mockImplementation(async (bytes, options) => {
            const font = await embedFont(bytes, options);
            embedding.abort(new Error('After embedding')); return font;
        });
        await expect(embedPdfReadingFont(pdf, fontBytes, embedding.signal)).rejects.toThrow('After embedding');
        spy.mockRestore();
        const ready = await embedPdfReadingFont(pdf, fontBytes);
        expect(() => ready.assertSupported('\n\r\t中文')).not.toThrow();
        expect(() => ready.assertSupported('')).not.toThrow();
    });
});
