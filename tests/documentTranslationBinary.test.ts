import {readFileSync} from 'node:fs';

import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {PDFArray, PDFDict, PDFDocument, PDFHexString, PDFImage, PDFName, PDFNumber, PDFRawStream} from 'pdf-lib';
import {describe, expect, it, vi} from 'vitest';

import {
    getDocumentAcceptAttribute,
    getDocumentMaxBytes,
    getDocumentFormat,
    getDocumentMimeType,
    parseDocument,
} from '@/src/features/document-translation/core/document';
import {
    createDocumentDownload,
    parseBinaryDocument,
    parseDocumentFile,
    type PdfPageRasterizer,
} from '@/src/features/document-translation/services/binary';
import {pdfPagesNeedingOcr} from '@/src/features/document-translation/services/pdfOcr';

const exampleRoot = new URL('../examples/document-translation/', import.meta.url);
const onePixelPng = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=',
    'base64',
));
const testRasterizer: PdfPageRasterizer = async () => onePixelPng;
const onePixelJpeg = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AA//Z', 'base64'));

it('reports PDF import page progress, yields to input, and supports page-boundary cancellation', async () => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 10; index += 1) pdf.addPage().drawText(`Page ${index + 1} text`);
    const bytes = await pdf.save();
    const progress: Array<{completed: number; total: number}> = [];
    let yielded = false;
    const timer = setTimeout(() => {yielded = true;}, 0);
    await parseBinaryDocument('progress.pdf', bytes, {onPdfProgress: value => progress.push(value)});
    clearTimeout(timer);
    expect(progress.map(value => value.completed)).toEqual(Array.from({length: 11}, (_, index) => index));
    expect(progress.every(value => value.total === 10)).toBe(true);
    expect(yielded).toBe(true);
    const controller = new AbortController();
    const completed: number[] = [];
    await expect(parseBinaryDocument('cancel.pdf', bytes, {signal: controller.signal, onPdfProgress: ({completed: page}) => {
        completed.push(page);
        if (page === 3) controller.abort(new Error('Import canceled'));
    }})).rejects.toThrow('Import canceled');
    expect(completed).toEqual([0, 1, 2, 3]);
});

function loadBytes(fileName: string): Uint8Array {
    return Uint8Array.from(readFileSync(new URL(fileName, exampleRoot)));
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}

describe('binary document translation formats', () => {
    it.each(['bilingual', 'translated'] as const)('exports one original-layout %s page per source page without reflow snapshots', async mode => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const raster = vi.fn(testRasterizer);
        const reading = vi.fn(async function* () {yield {bytes: onePixelPng, width: 612, height: 792};});
        const download = await createDocumentDownload(parsed, parsed.segments.map(() => '完整译文'), mode, {
            pdfPageRasterizer: raster, pdfReadingRasterizer: reading, pdfPresentation: 'layout',
        });
        const result = await PDFDocument.load(download.data as Uint8Array);
        const binary = parsed.binary;
        const sourcePages = binary?.kind === 'pdf' ? binary.pages : [];
        expect(result.getPageCount()).toBe(sourcePages.length);
        expect(result.getPages().map(page => page.getSize())).toEqual(sourcePages.map(page => ({
            width: mode === 'bilingual' ? page.width * 2 + Math.max(8, Math.min(24, page.width * 0.025)) : page.width, height: page.height,
        })));
        expect(raster.mock.calls.map(([page]) => page.pageNumber)).toEqual([1, 2]);
        expect(raster.mock.calls.every(([page]) => page.imageFormat === 'jpeg')).toBe(true);
        expect(reading).not.toHaveBeenCalled();
    });

    it.each([0, 90, 180, 270] as const)('embeds JPEG data directly and preserves full Unicode overflow notes on the translated side at %s degrees', async rotation => {
        const source = await PDFDocument.create();
        source.addPage([400, 600]).drawText('First page', {x: 40, y: 300});
        const parsed = await parseBinaryDocument('notes.pdf', await source.save());
        if (parsed.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const quarter = rotation === 90 || rotation === 270;
        const pageData = {...parsed.binary.pages[0], rotation, width: quarter ? 600 : 400, height: quarter ? 400 : 600};
        const model = {...parsed, binary: {...parsed.binary, pages: [pageData]}};
        const full = '全文 中文 👩‍💻 beyond the visible excerpt '.repeat(40);
        const png = vi.spyOn(PDFDocument.prototype, 'embedPng');
        const jpeg = vi.spyOn(PDFDocument.prototype, 'embedJpg');
        try {
            // 外部端口可返回共享 buffer 的切片；JPEG 解析仍必须从切片开头读取。
            const backing = new Uint8Array(onePixelJpeg.length + 4); backing.set(onePixelJpeg, 2);
            const download = await createDocumentDownload(model, parsed.segments.map(() => full), 'bilingual', {
                pdfPageRasterizer: async () => ({data: backing.subarray(2, -2), format: 'jpeg', overflowNotes: [{segmentIndex: 0, text: full, x: 40, y: 60, width: 200, height: 80}]}),
            });
            expect(jpeg).toHaveBeenCalledOnce(); expect(png).not.toHaveBeenCalled();
            const result = await PDFDocument.load(download.data as Uint8Array);
            expect(result.getPageCount()).toBe(1);
            const page = result.getPage(0);
            const annotation = page.node.Annots()!.lookup(0, PDFDict);
            expect(annotation.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Text');
            expect(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe(full);
            expect(annotation.lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(0);
            const rect = annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString()));
            const offset = pageData.width + Math.max(8, Math.min(24, pageData.width * 0.025));
            expect(rect[0]).toBeGreaterThanOrEqual(offset);
            expect([offset + 4, offset + pageData.width - 18]).toContain(rect[0]);
            expect(rect[2]).toBeLessThanOrEqual(page.getWidth());
            expect(rect[1]).toBeGreaterThanOrEqual(0); expect(rect[3]).toBeLessThanOrEqual(page.getHeight());
        } finally {png.mockRestore(); jpeg.mockRestore();}
    });

    it.each(['bilingual', 'translated'] as const)('keeps full-bleed overflow annotations accessible without painting icons on source content in %s output', async mode => {
        const source = await PDFDocument.create();
        source.addPage([400, 600]).drawText('Original', {x: 40, y: 300, size: 12});
        const parsed = await parseBinaryDocument('full-bleed.pdf', await source.save());
        if (parsed.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const pageData = parsed.binary.pages[0];
        const model = {...parsed, binary: {...parsed.binary, pages: [{...pageData, blocks: [{...pageData.blocks[0], x: 0, y: 0, width: 400, height: 600}]}]}};
        const full = 'Full long translation 中文';
        const download = await createDocumentDownload(model, [full], mode, {pdfPageRasterizer: async () => ({data: onePixelJpeg, format: 'jpeg', overflowNotes: [
            {segmentIndex: 0, text: full, x: 0, y: 0, width: 400, height: 600}, {segmentIndex: 1, text: full, x: 0, y: 0, width: 400, height: 600},
        ]})});
        const result = await PDFDocument.load(download.data as Uint8Array);
        const annotations = result.getPage(0).node.Annots()!;
        expect(annotations.size()).toBe(2);
        const rectangles = [];
        for (let index = 0; index < annotations.size(); index += 1) {
            const note = annotations.lookup(index, PDFDict);
            expect(note.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe(full);
            expect(note.lookup(PDFName.of('F'), PDFNumber).asNumber() & 4).toBe(0);
            const appearance = note.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
            if (!(appearance instanceof PDFRawStream)) throw new Error('Appearance stream expected');
            const rect = note.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString()));
            rectangles.push(rect);
            if (mode === 'bilingual') {
                expect(rect[0]).toBeGreaterThanOrEqual(400); expect(rect[2]).toBeLessThanOrEqual(410);
                expect(appearance.getContentsSize()).toBeGreaterThan(0);
            } else expect(appearance.getContentsSize()).toBe(0);
        }
        if (mode === 'bilingual') expect(Math.abs(rectangles[0][1] - rectangles[1][1])).toBeGreaterThanOrEqual(18);
    });

    it('cancels a pending custom rasterizer and an active PDF save promptly', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const translations = parsed.segments.map(() => '译文');
        const controller = new AbortController();
        let resolveRaster!: (value: Uint8Array) => void;
        const raster = vi.fn(() => new Promise<Uint8Array>(resolve => {resolveRaster = resolve;}));
        const pending = createDocumentDownload(parsed, translations, 'translated', {pdfPageRasterizer: raster, signal: controller.signal});
        void pending.catch(() => undefined);
        await vi.waitFor(() => expect(raster).toHaveBeenCalledOnce());
        controller.abort(new Error('raster canceled'));
        await expect(pending).rejects.toThrow('raster canceled');
        resolveRaster(onePixelPng);
        const savingController = new AbortController();
        let resolveSave!: (value: Uint8Array) => void;
        const save = vi.spyOn(PDFDocument.prototype, 'save').mockImplementationOnce(() => new Promise<Uint8Array>(resolve => {resolveSave = resolve;}));
        try {
            const saving = createDocumentDownload(parsed, translations, 'translated', {pdfPageRasterizer: testRasterizer, signal: savingController.signal});
            void saving.catch(() => undefined);
            await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
            savingController.abort(new Error('save canceled'));
            await expect(saving).rejects.toThrow('save canceled');
            resolveSave(new Uint8Array([1]));
        } finally {save.mockRestore();}
    });

    it.each(['bilingual', 'translated'] as const)('streams complete reading continuation pages in %s output', async mode => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const translations = parsed.segments.map(segment => `完整译文 ${segment.source} 尾文`);
        const received: Array<{pageNumber: number; text: string}> = [];
        const download = await createDocumentDownload(parsed, translations, mode, {
            pdfReadingRasterizer: async function* ({pageNumber, plan}) {
                received.push({pageNumber, text: plan.entries.filter(entry => entry.kind === 'text').map(entry => entry.text).join('')});
                yield {bytes: onePixelPng, width: 612, height: 792};
                yield {bytes: onePixelPng, width: 612, height: 792};
            },
        });
        const result = await PDFDocument.load(download.data as Uint8Array);
        expect(result.getPageCount()).toBe(mode === 'bilingual' ? 6 : 4);
        expect(received.map(page => page.pageNumber)).toEqual([1, 2]);
        const expected = parsed.binary!.kind === 'pdf' ? parsed.binary!.pages.flatMap(page => page.blocks)
            .filter(block => block.segmentIndex >= 0)
            .map(block => block.kind === 'metadata' || block.kind === 'footer' ? parsed.segments[block.segmentIndex].source : translations[block.segmentIndex]).join('') : '';
        expect(received.map(page => page.text).join('')).toBe(expected);
        expect(result.getPages().filter(page => page.getWidth() === 612).every(page => page.getHeight() === 792)).toBe(true);
    });

    it('closes an explicitly requested reading iterator on cancellation without adding a layout snapshot', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const translations = parsed.segments.map(() => '完整尾文');
        const raster = vi.fn(testRasterizer);
        const controller = new AbortController();
        let released = false;
        await expect(createDocumentDownload(parsed, translations, 'translated', {
            pdfPresentation: 'readable', pdfPageRasterizer: raster, signal: controller.signal,
            pdfReadingRasterizer: async function* () {
                try {yield {bytes: onePixelPng, width: 612, height: 792}; controller.abort(new Error('canceled')); yield {bytes: onePixelPng, width: 612, height: 792};}
                finally {released = true;}
            },
        })).rejects.toThrow('canceled');
        expect(released).toBe(true); expect(raster).not.toHaveBeenCalled();
        const download = await createDocumentDownload(parsed, translations, 'translated', {
            pdfPresentation: 'readable', pdfPageRasterizer: raster,
            pdfReadingRasterizer: async function* () {yield {bytes: onePixelPng, width: 612, height: 792};},
        });
        expect((await PDFDocument.load(download.data as Uint8Array)).getPageCount()).toBe(2);
        expect(translations.every(value => value === '完整尾文')).toBe(true);
    });

    it.each(['sample.epub', 'sample.docx'])('%s can cancel active compression and retry while preserving contents', async name => {
        const parsed = await parseBinaryDocument(name, loadBytes(name));
        const controller = new AbortController();
        await expect(createDocumentDownload(parsed, [], 'translated', {
            signal: controller.signal, onArchiveProgress: () => controller.abort(),
        })).rejects.toMatchObject({name: 'AbortError'});
        const progress = vi.fn();
        const download = await createDocumentDownload(parsed, [], 'translated', {
            signal: new AbortController().signal, onArchiveProgress: progress,
        });
        expect(progress).toHaveBeenLastCalledWith(100);
        expect((await parseBinaryDocument(download.fileName, download.data as Uint8Array)).segments).toHaveLength(parsed.segments.length);
    });

    it('preserves blank pages in a bilingual PDF without failing to embed them', async () => {
        const source = await PDFDocument.create();
        source.addPage([400, 600]).drawText('First page');
        source.addPage([400, 600]);
        source.addPage([400, 600]).drawText('Last page');
        const parsed = await parseBinaryDocument('blank-page.pdf', await source.save());
        const download = await createDocumentDownload(parsed, [], 'bilingual', {pdfPageRasterizer: testRasterizer});
        expect((await PDFDocument.load(download.data as Uint8Array)).getPageCount()).toBe(3);
    });

    it.each(['bilingual', 'translated'] as const)('exports 40 PDF pages in %s mode with ordered progress', async mode => {
        const source = await PDFDocument.create();
        // 正文位置的一句话；页面边缘的孤立短行是页眉页脚，按原样保留而不参与翻译。
        for (let page = 1; page <= 40; page += 1) source.addPage([400, 600]).drawText(`Page ${page}`, {x: 50, y: 300});
        const parsed = await parseBinaryDocument('long.pdf', await source.save());
        const progress: Array<{phase: string; completedPages: number; totalPages: number}> = [];
        const rasterizer = vi.fn(testRasterizer);
        const download = await createDocumentDownload(parsed, parsed.segments.map(segment => `Translated ${segment.source}`), mode, {
            pdfPageRasterizer: rasterizer, onPdfProgress: value => progress.push(value),
        });
        const result = await PDFDocument.load(download.data as Uint8Array);
        expect(result.getPageCount()).toBe(40);
        expect(result.getPages().every(page => page.getHeight() === 600 && page.getWidth() === (mode === 'bilingual' ? 810 : 400))).toBe(true);
        expect(rasterizer.mock.calls.map(([input]) => input.pageNumber)).toEqual(Array.from({length: 40}, (_, index) => index + 1));
        expect(progress.slice(0, -1).map(value => value.completedPages)).toEqual(Array.from({length: 41}, (_, index) => index));
        expect(progress.at(-1)).toEqual({phase: 'saving', completedPages: 40, totalPages: 40});
    });

    it('reports progress for untouched bilingual pages and for reading pages, and tolerates a page index that has no segment', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const binary = parsed.binary as Extract<NonNullable<typeof parsed.binary>, {kind: 'pdf'}>;
        // 页面引用了一个不存在的片段：按“没有原文”处理，不影响其余页面。
        const loose = {...parsed, binary: {...binary, pages: binary.pages.map((page, index) => index ? page : {...page, segmentIndexes: [999, ...page.segmentIndexes]})}};
        // 没有任何译文：双语下载逐页保留原页，并逐页上报进度。
        const untouchedProgress: number[] = [];
        const untouched = await createDocumentDownload(loose, [], 'bilingual', {pdfPageRasterizer: testRasterizer, onPdfProgress: value => {if (value.phase === 'rendering') untouchedProgress.push(value.completedPages);}});
        expect((await PDFDocument.load(untouched.data as Uint8Array)).getPageCount()).toBe(2);
        expect(untouchedProgress).toEqual(expect.arrayContaining([1, 2]));
        // 固定字号续页的下载同样逐页上报进度。
        const readingProgress: number[] = [];
        const reading = await createDocumentDownload(parsed, parsed.segments.map(segment => `译 ${segment.source}`), 'translated', {
            pdfReadingRasterizer: async function* () {yield {bytes: onePixelPng, width: 612, height: 792};},
            onPdfProgress: value => {if (value.phase === 'rendering') readingProgress.push(value.completedPages);},
        });
        expect((await PDFDocument.load(reading.data as Uint8Array)).getPageCount()).toBe(2);
        expect(readingProgress).toEqual(expect.arrayContaining([1, 2]));
    });

    it('cancels between PDF pages and retries without changing translations', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const controller = new AbortController();
        const translations = parsed.segments.map(() => '译文');
        const rasterizer = vi.fn(testRasterizer);
        await expect(createDocumentDownload(parsed, translations, 'translated', {
            pdfPageRasterizer: rasterizer, signal: controller.signal,
            onPdfProgress: value => { if (value.completedPages === 1) controller.abort(); },
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(rasterizer).toHaveBeenCalledOnce();
        expect(translations.every(value => value === '译文')).toBe(true);
        const download = await createDocumentDownload(parsed, translations, 'translated', {
            pdfPageRasterizer: testRasterizer, signal: new AbortController().signal,
        });
        expect((await PDFDocument.load(download.data as Uint8Array)).getPageCount()).toBe(2);
    });

    it('releases decoded PNG pixels before rendering the next PDF page', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const images: PDFImage[] = [];
        const embed = PDFDocument.prototype.embedPng;
        const spy = vi.spyOn(PDFDocument.prototype, 'embedPng').mockImplementation(async function (this: PDFDocument, bytes) {
            const image = await embed.call(this, bytes);
            images.push(image);
            return image;
        });
        try {
            await createDocumentDownload(parsed, parsed.segments.map(() => '译文'), 'translated', {
                pdfPageRasterizer: async () => {
                    // pdf-lib clears its PNG embedder only after embed(), releasing RGB pixels.
                    for (const image of images) expect((image as any).embedder).toBeUndefined();
                    return onePixelPng;
                },
            });
            expect(images).toHaveLength(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('识别 PDF、ePub、DOCX 并提供正确 MIME 与上传 accept', () => {
        expect(getDocumentFormat('paper.PDF')).toBe('pdf');
        expect(getDocumentFormat('book.epub')).toBe('epub');
        expect(getDocumentFormat('brief.docx')).toBe('docx');
        expect(getDocumentMimeType('pdf')).toBe('application/pdf');
        expect(getDocumentMimeType('epub')).toBe('application/epub+zip');
        expect(getDocumentMimeType('docx')).toContain('wordprocessingml.document');
        expect(getDocumentAcceptAttribute()).toContain('.pdf');
        // PDF 单独放宽到 50 MB，其余格式（含无法识别的扩展名）沿用 10 MB。
        expect(getDocumentMaxBytes('paper.PDF')).toBe(50 * 1024 * 1024);
        expect([getDocumentMaxBytes('book.epub'), getDocumentMaxBytes('notes.md'), getDocumentMaxBytes('unknown.bin')]).toEqual([10 * 1024 * 1024, 10 * 1024 * 1024, 10 * 1024 * 1024]);
        expect(getDocumentAcceptAttribute()).toContain('.epub');
        expect(getDocumentAcceptAttribute()).toContain('.docx');
    });

    it('按 PDF 页解析版面文本块、坐标和页码上下文', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));

        expect(parsed.format).toBe('pdf');
        expect(parsed.binary?.kind).toBe('pdf');
        expect(parsed.binary?.kind === 'pdf' && parsed.binary.pages).toHaveLength(2);
        const firstPage = parsed.binary?.kind === 'pdf' ? parsed.binary.pages[0] : undefined;
        expect(firstPage?.blocks.length).toBeGreaterThan(2);
        expect(firstPage?.blocks.every((block) => block.width > 0 && block.height > 0)).toBe(true);
        expect(firstPage?.blocks.every((block) => block.lineCount >= 1 && block.lineHeight > 0)).toBe(true);
        expect(firstPage?.blocks.some((block) => block.lineCount > 1)).toBe(true);
        expect(firstPage?.blocks.every((block) => block.x >= 0 && block.y >= 0)).toBe(true);
        expect(firstPage?.blocks.some((block) => block.x < (firstPage?.width || 0) * 0.42)).toBe(true);
        expect(firstPage?.blocks.some((block) => block.x > (firstPage?.width || 0) * 0.5)).toBe(true);
        expect(parsed.segments.some((segment) => segment.source.includes('Document Translation Example'))).toBe(true);
        expect(parsed.segments.some((segment) => segment.contextLabel === '第 1 页')).toBe(true);
        expect(parsed.segments.some((segment) => segment.contextLabel === '第 2 页')).toBe(true);
    });

    it.each(['sample.epub', 'sample.docx'])('%s partial export retains blank reviewed segments and translates the rest', async name => {
        const parsed = await parseBinaryDocument(name, loadBytes(name));
        const translations = parsed.segments.map(segment => segment.id === 0 ? '  ' : `译文 ${segment.id}`);
        const download = await createDocumentDownload(parsed, translations, 'translated');
        const reparsed = await parseBinaryDocument(download.fileName, download.data as Uint8Array);
        expect(reparsed.segments[0].source).toBe(parsed.segments[0].source);
        expect(reparsed.segments[1].source).toBe('译文 1');
    });

    it('PDF partial export uses source for an empty reviewed block', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const translations = parsed.segments.map(segment => segment.id === 0 ? '' : `译文 ${segment.id}`);
        const captured: readonly string[][] = [];
        await createDocumentDownload(parsed, translations, 'translated', {
            pdfPageRasterizer: async input => {
                (captured as string[][]).push([...input.translations]);
                return onePixelPng;
            },
        });
        // 空结果保留原图文字，不覆盖成重新绘制的原文。
        expect(captured[0][0]).toBe('');
        expect(captured[0][1]).toBe('译文 1');
    });

    it('按 ePub spine 章节提取 XHTML，并导出仍可读取的双语 ePub', async () => {
        const parsed = await parseBinaryDocument('sample.epub', loadBytes('sample.epub'));
        expect(parsed.format).toBe('epub');
        expect(parsed.binary?.kind === 'epub' && parsed.binary.chapters).toHaveLength(2);
        expect(parsed.segments.some((segment) => segment.contextLabel === 'Fluent reading')).toBe(true);

        const translations = parsed.segments.map((segment) => `译文：${segment.source}`);
        const download = await createDocumentDownload(parsed, translations, 'bilingual');
        const zip = await JSZip.loadAsync(download.data as Uint8Array);
        expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
        const chapter = await zip.file('OEBPS/chapter-1.xhtml')!.async('string');
        expect(chapter).toContain('Fluent reading for local books');
        expect(chapter).toContain('译文：Fluent reading for local books');
        expect(chapter).toContain('data-fluent-read-document-translation="true"');
        const linkedChapter = await zip.file('OEBPS/chapter-2.xhtml')!.async('string');
        for (const source of [chapter, linkedChapter]) expect(() => new SaxesParser({xmlns: true}).write(source).close()).not.toThrow();
        expect(linkedChapter).toContain('href="chapter-1.xhtml"');
        expect(linkedChapter.match(/<title>/gu)).toHaveLength(1);
        expect(linkedChapter).not.toContain('<title>译文：');
    });

    it('exports strict XHTML line breaks without rewriting namespaces, styles, resources or literal script text', async () => {
        const zip = new JSZip();
        zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
        zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
        zip.file('OEBPS/content.opf', '<package><manifest><item id="xml" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="html" href="legacy.html" media-type="text/html"/></manifest><spine><itemref idref="xml"/><itemref idref="html"/></spine></package>');
        const script = '<script type="text/javascript"><![CDATA[var literal = \'<br><span data-fluent-read-document-translation="true">\';]]></script>';
        const style = '<link rel="stylesheet" href="styles.css"/>';
        const image = '<img src="images/sample.png" alt="original"/>';
        zip.file('OEBPS/chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title>${style}${script}</head><body><p>Original <strong>important</strong> text</p>${image}</body></html>`);
        zip.file('OEBPS/legacy.html', '<html><body><p>Legacy HTML text</p></body></html>');
        zip.file('OEBPS/styles.css', 'body { color: blue; }', {compression: 'STORE'});
        zip.file('OEBPS/images/sample.png', onePixelPng, {compression: 'STORE'});
        const parsed = await parseBinaryDocument('strict.epub', await zip.generateAsync({type: 'uint8array'}));
        expect(parsed.binary?.kind === 'epub' && parsed.binary.chapters.map(chapter => chapter.mediaType)).toEqual(['application/xhtml+xml', 'text/html']);
        for (const mode of ['bilingual', 'translated'] as const) {
            const download = await createDocumentDownload(parsed, ['原文中的 <g1>重点</g1> 内容', 'HTML译文'], mode);
            const output = await JSZip.loadAsync(download.data as Uint8Array);
            const chapter = await output.file('OEBPS/chapter.xhtml')!.async('string');
            expect(() => new SaxesParser({xmlns: true}).write(chapter).close()).not.toThrow();
            expect(chapter).toContain('xmlns="http://www.w3.org/1999/xhtml"');
            expect(chapter).toContain(script); expect(chapter).toContain(style); expect(chapter).toContain(image);
            expect(chapter).toContain('<strong>重点</strong>');
            expect(await output.file('OEBPS/styles.css')!.async('string')).toBe('body { color: blue; }');
            expect(await output.file('OEBPS/images/sample.png')!.async('uint8array')).toEqual(onePixelPng);
            if (mode === 'bilingual') {
                expect(chapter).toContain('<br/><span data-fluent-read-document-translation="true">');
                expect(await output.file('OEBPS/legacy.html')!.async('string')).toContain('<br><span data-fluent-read-document-translation="true">');
            }
        }
        // Existing history records without media type infer XML from the source namespace.
        if (parsed.binary?.kind === 'epub') parsed.binary.chapters[0].mediaType = undefined;
        const legacy = await createDocumentDownload(parsed, ['已翻译', 'HTML译文'], 'bilingual');
        const legacyChapter = await (await JSZip.loadAsync(legacy.data as Uint8Array)).file('OEBPS/chapter.xhtml')!.async('string');
        expect(() => new SaxesParser({xmlns: true}).write(legacyChapter).close()).not.toThrow();
    });

    it.each(['sample.html', 'sample.md', 'sample.txt', 'sample.srt', 'sample.json'])('text export retains pending, unchanged and reviewed blank results in %s', async name => {
        const parsed = parseDocument(name, readFileSync(new URL(name, exampleRoot), 'utf8'), {markdownSentences: true});
        for (const fallback of ['', parsed.segments[0].source, undefined]) for (const mode of ['bilingual', 'translated'] as const) {
            const translations = parsed.segments.map((segment, index) => index === 0 ? fallback : '译文：' + segment.source);
            const download = await createDocumentDownload(parsed, translations as string[], mode);
            const output = parseDocument(name, download.data as string, {markdownSentences: true});
            expect(output.segments.some(entry => entry.source.includes(parsed.segments[0].source))).toBe(true);
            expect(download.data).toContain('译文：');
        }
    });

    it('ePub 章节的文本实体以可读文本翻译并保留原 XHTML 表达', async () => {
        const zip = new JSZip();
        zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});
        zip.file('META-INF/container.xml', [
            '<container><rootfiles>',
            '<rootfile full-path="OEBPS/content.opf"/>',
            '</rootfiles></container>',
        ].join(''));
        zip.file('OEBPS/content.opf', [
            '<package><manifest>',
            '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>',
            '</manifest><spine><itemref idref="chapter"/></spine></package>',
        ].join(''));
        zip.file('OEBPS/chapter.xhtml', [
            '<html><head><title>Entities</title></head><body>',
            '<p>Hello&#160;world &amp; friends</p>',
            '</body></html>',
        ].join(''));
        const bytes = await zip.generateAsync({type: 'uint8array'});

        const parsed = await parseBinaryDocument('entities.epub', bytes);
        expect(parsed.segments.map((segment) => segment.source)).toEqual(['Hello\u00a0world & friends']);

        const download = await createDocumentDownload(parsed, ['你好世界与朋友'], 'bilingual');
        const exportedZip = await JSZip.loadAsync(download.data as Uint8Array);
        const chapter = await exportedZip.file('OEBPS/chapter.xhtml')!.async('string');
        expect(chapter).toContain('Hello&#160;world &amp; friends');
        expect(chapter).not.toContain('Hello&amp;#160;world');
        expect(chapter).toContain('你好世界与朋友');
    });

    it('提取 DOCX 正文、页眉和页脚，并保持 OOXML 包可重新解析', async () => {
        const parsed = await parseBinaryDocument('sample.docx', loadBytes('sample.docx'));
        expect(parsed.format).toBe('docx');
        expect(parsed.binary?.kind).toBe('docx');
        expect(parsed.segments.some((segment) => segment.source.includes('Document Translation Example'))).toBe(true);
        expect(parsed.segments.some((segment) => segment.contextLabel === '页眉')).toBe(true);
        expect(parsed.segments.some((segment) => segment.role === 'heading')).toBe(true);
        expect(parsed.segments.some((segment) => segment.pathLabel === '正文')).toBe(true);

        const translations = parsed.segments.map((segment) => `Translated ${segment.id + 1}: ${segment.source}`);
        const download = await createDocumentDownload(parsed, translations, 'bilingual');
        const zip = await JSZip.loadAsync(download.data as Uint8Array);
        expect(zip.file('[Content_Types].xml')).not.toBeNull();
        const documentXml = await zip.file('word/document.xml')!.async('string');
        expect(documentXml).toContain('Document Translation Example');
        expect(documentXml).toContain('Translated');
        const headerXml = await zip.file('word/header1.xml')!.async('string');
        const footerXml = await zip.file('word/footer1.xml')!.async('string');
        expect(headerXml).toContain('Translated');
        expect(footerXml).toContain('Translated');

        const reparsed = await parseBinaryDocument('sample.bilingual.docx', download.data as Uint8Array);
        expect(reparsed.segments.length).toBeGreaterThan(parsed.segments.length);
    });

    it('DOCX 段落记下所在的表格、行与单元格，嵌套表格归到外层那一格', async () => {
        const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
        const cell = (...content: string[]) => `<w:tc><w:tcPr/>${content.join('')}</w:tc>`;
        const zip = new JSZip();
        zip.file('[Content_Types].xml', '<Types/>');
        zip.file('word/document.xml', [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
            // 文档开头多出来的闭合标签不影响后面的定位。
            '</w:tbl>', p('Before'),
            '<w:tbl><w:tblPr/><w:tblGrid/>',
            `<w:tr><w:trPr/>${cell(p('Name'))}${cell(p('Status'))}</w:tr>`,
            `<w:tr>${cell(p('Migration'), p('Second line'))}${cell(p(''))}${cell(`<w:tbl><w:tr>${cell(p('Nested'))}</w:tr></w:tbl>`, p('After nested'))}</w:tr>`,
            '</w:tbl>', p('Between'),
            `<w:tbl><w:tr>${cell(p('Other table'))}</w:tr></w:tbl>`,
            p('End'), '</w:body></w:document>',
        ].join(''));
        const parsed = await parseBinaryDocument('table.docx', await zip.generateAsync({type: 'uint8array'}));
        if (parsed.binary?.kind !== 'docx') throw new Error('Expected parsed DOCX');
        const places = parsed.binary.parts[0].paragraphSegments.map(entry => [parsed.segments[entry.segmentIndex].source, entry.table ? `${entry.table.table}:${entry.table.row}:${entry.table.cell}` : '-']);
        expect(places).toEqual([
            ['Before', '-'], ['Name', '0:0:0'], ['Status', '0:0:1'], ['Migration', '0:1:0'], ['Second line', '0:1:0'],
            ['Nested', '0:1:2'], ['After nested', '0:1:2'], ['Between', '-'], ['Other table', '1:0:0'], ['End', '-'],
        ]);
    });

    it('DOCX 仅译文导出不会重复原段落的换行和制表符', async () => {
        const zip = new JSZip();
        zip.file('[Content_Types].xml', '<Types/>');
        zip.file('word/document.xml', [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r>',
            '<w:t>Hello</w:t><w:br/><w:t>World</w:t><w:cr/><w:t>More</w:t><w:tab/><w:t>Again</w:t>',
            '</w:r></w:p></w:body></w:document>',
        ].join(''));
        const bytes = await zip.generateAsync({type: 'uint8array'});
        const parsed = await parseBinaryDocument('line-breaks.docx', bytes);

        expect(parsed.segments[0].source).toBe('Hello\nWorld\nMore\tAgain');
        const download = await createDocumentDownload(parsed, ['你好\n世界\n更多\t继续'], 'translated');
        const exportedZip = await JSZip.loadAsync(download.data as Uint8Array);
        const documentXml = await exportedZip.file('word/document.xml')!.async('string');

        expect(documentXml.match(/<w:br\s*\/>/gu)).toHaveLength(2);
        expect(documentXml).not.toContain('<w:cr');
        expect(documentXml.match(/<w:tab\s*\/>/gu)).toHaveLength(1);
        expect(documentXml).toMatch(/更多<\/w:t><w:tab\/><w:t xml:space="preserve">继续/u);
        expect(documentXml).not.toContain('Hello');
        expect(documentXml).not.toContain('World');
        expect(documentXml).not.toContain('More');
        expect(documentXml).not.toContain('Again');
    });

    it('PDF 双语导出将每张原页和保留版式的译页并排放在同一页', async () => {
        const parsed = await parseBinaryDocument('sample.pdf', loadBytes('sample.pdf'));
        const translations = parsed.segments.map((segment) => `Translated: ${segment.source}`);
        const download = await createDocumentDownload(parsed, translations, 'bilingual', {
            pdfPageRasterizer: testRasterizer,
        });

        expect(download.fileName).toBe('sample.bilingual.pdf');
        const exported = await PDFDocument.load(download.data as Uint8Array);
        expect(exported.getPageCount()).toBe(2);
        const sourcePage = parsed.binary?.kind === 'pdf' ? parsed.binary.pages[0] : undefined;
        const exportedSize = exported.getPage(0).getSize();
        expect(exportedSize.width).toBeGreaterThan((sourcePage?.width || 0) * 2);
        expect(exportedSize.height).toBeCloseTo(sourcePage?.height || 0, 2);
    });

    it('统一文件入口根据扩展名选择文本或二进制解析器', async () => {
        const bytes = loadBytes('sample.epub');
        const parsed = await parseDocumentFile({
            name: 'sample.epub',
            text: async () => 'not used',
            arrayBuffer: async () => copyArrayBuffer(bytes),
        });
        expect(parsed.format).toBe('epub');
        expect(parsed.segments.length).toBeGreaterThan(0);
    });

    it('拒绝扩展名伪装或损坏的二进制文件', async () => {
        await expect(parseBinaryDocument('broken.pdf', new TextEncoder().encode('not a pdf'))).rejects.toThrow('PDF 文件签名无效');
        await expect(parseBinaryDocument('broken.epub', new TextEncoder().encode('not a zip'))).rejects.toThrow('ePub 解析失败');
        await expect(parseBinaryDocument('broken.docx', new TextEncoder().encode('not a zip'))).rejects.toThrow('DOCX 解析失败');
    });

    it('扫描版或空白 PDF 照常打开且不产生空译文，等待页面在开始翻译时识别文字', async () => {
        const pdf = await PDFDocument.create();
        pdf.addPage([320, 480]);
        // 第二页是一张盖满整页的图像：这才是扫描页；空白页和只有一小块图像的页不是。
        const picture = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
        pdf.addPage([320, 480]).drawImage(picture, {x: 0, y: 0, width: 320, height: 480});
        pdf.addPage([320, 480]).drawImage(picture, {x: 20, y: 20, width: 60, height: 60});

        const parsed = await parseBinaryDocument('scanned.pdf', await pdf.save());
        expect(parsed.segments).toEqual([]);
        expect(parsed.binary?.kind === 'pdf' && parsed.binary.pages.map(page => [page.width, page.height, page.blocks.length, page.scanned])).toEqual([[320, 480, 0, undefined], [320, 480, 0, true], [320, 480, 0, undefined]]);
        expect(pdfPagesNeedingOcr(parsed)).toEqual([1]);
    });

    it('拒绝解压后单项过大的 ePub/DOCX 压缩包', async () => {
        const zip = new JSZip();
        zip.file('oversized.txt', 'x'.repeat(24 * 1024 * 1024 + 1));
        const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});

        await expect(parseBinaryDocument('oversized.epub', bytes)).rejects.toThrow('单个内容项过大');
        await expect(parseBinaryDocument('oversized.docx', bytes)).rejects.toThrow('单个内容项过大');
    });
});

it('全页译文相同的双语 PDF 保留左右对照尺寸并跳过光栅重绘', async () => {
    const source = await PDFDocument.create(); source.addPage([400, 600]).drawText('Same original page');
    const parsed = await parseBinaryDocument('same.pdf', await source.save());
    const rasterizer = vi.fn(testRasterizer);
    const output = await createDocumentDownload(parsed, parsed.segments.map(segment => ` ${segment.source} `), 'bilingual', {pdfPageRasterizer: rasterizer});
    expect(rasterizer).not.toHaveBeenCalled();
    const result = await PDFDocument.load(output.data as Uint8Array);
    expect(result.getPageCount()).toBe(1); expect(result.getPage(0).getSize()).toEqual({width: 810, height: 600});
});

it('相同 DOCX 译文在双语和仅译文导出均保留原有结构', async () => {
    const parsed = await parseBinaryDocument('sample.docx', loadBytes('sample.docx'));
    for (const mode of ['bilingual', 'translated'] as const) {
        const output = await createDocumentDownload(parsed, parsed.segments.map(segment => ` ${segment.source} `), mode);
        const source = await JSZip.loadAsync(parsed.binary!.bytes), result = await JSZip.loadAsync(output.data as Uint8Array);
        for (const path of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) {
            expect(await result.file(path)!.async('string')).toBe(await source.file(path)!.async('string'));
        }
    }
});
