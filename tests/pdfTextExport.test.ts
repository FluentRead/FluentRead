import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {PDFDict, PDFDocument, PDFName, PDFRawStream} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {TextItem} from 'pdfjs-dist/types/src/display/api';
import {afterAll, describe, expect, it, vi} from 'vitest';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';
import {createDocumentDownload, parseBinaryDocument, type PdfReadingRenderer, type PdfReadingRasterizer} from '@/src/features/document-translation/services/binary';
import {embedPdfReadingFont} from '@/src/features/document-translation/services/pdfReadingFont';
import {renderPdfReadingPages} from '@/src/features/document-translation/ui/pdfPreview';
import {paginatePdfReadingPlan, type PdfReadingOutputPage} from '@/src/features/document-translation/core/pdfTextLayout';

const fontBytes = new Uint8Array(readFileSync(new URL('../assets/pdf-fonts/FluentReadNotoSansSC-Regular.woff2', import.meta.url)));
const textOnlyOptions = {pdfReadingRenderer: renderPdfReadingPages, pdfFontLoader: async () => fontBytes};
const compact = (text: string) => text.replace(/\s/gu, '');
const layoutPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));

// These integration tests parse and subset the bundled font and render real PDF
// pages; slower CI runners can take several seconds even when they succeed.
vi.setConfig({testTimeout: 20_000});
afterAll(() => vi.resetConfig());

function nativeCanvas() {
    const require = createRequire(import.meta.url), pdfjsRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
    return pdfjsRequire('@napi-rs/canvas') as {
        createCanvas(width: number, height: number): {width: number; height: number; getContext(type: '2d'): CanvasRenderingContext2D; toBuffer(type: 'image/png'): Uint8Array};
        loadImage(path: string): Promise<CanvasImageSource & {width: number; height: number}>;
    };
}

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

async function pageLabels(bytes: Uint8Array): Promise<string[] | null> {
    const task = getDocument({data: bytes.slice(), disableFontFace: true, isEvalSupported: false});
    try {return await (await task.promise).getPageLabels();}
    finally {await task.destroy();}
}

function saveEvidence(name: string, bytes: Uint8Array): void {
    const directory = process.env.FLUENTREAD_PDF_EVIDENCE_DIR;
    if (!directory) return;
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, name), bytes);
}

describe('visible Unicode PDF reading export', () => {
    it('exports a full reading page without a blank second page caused by trailing newlines', async () => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        document.segments = [{...document.segments[1], id: 0}];
        document.binary.pages[0].blocks = [{...document.binary.pages[0].blocks[1], segmentIndex: 0}];
        document.binary.pages[0].segmentIndexes = [0];
        const text = '译文\n'.repeat(36) + ' \t\r\n\r\n';
        const download = await createDocumentDownload(document, [text], 'translated', {...textOnlyOptions, pdfPresentation: 'readable'});
        const pages = await extract(download.data as Uint8Array);
        expect(pages).toHaveLength(1);
        expect(compact(pages[0])).toBe('译文'.repeat(36));
        saveEvidence('readable-no-trailing-blank-page.pdf', download.data as Uint8Array);
    });
    it.each([0, 90, 180, 270] as const)('keeps original-layout translated lines extractable in their rotated translated-side bounds at %s degrees', async rotation => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const data = document.binary.pages[0];
        data.rotation = rotation;
        if (rotation === 90 || rotation === 270) {data.width = 800; data.height = 600;}
        const loader = vi.fn(async (): Promise<Uint8Array> => {throw new Error('Offline: layout text must not request a font');});
        const translations = ['原版标题可搜索', '原版译文可复制 Mixed English 123 数学 ∑∫≠ 𝒱︀'];
        const download = await createDocumentDownload(document, translations, 'bilingual', {pdfFontLoader: loader,
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: translations.map((text, index) => ({
                segmentIndex: index, text, x: 42, y: 50 + index * 60, width: index ? 360 : 120, fontSize: 12,
            }))}),
        });
        expect(loader).not.toHaveBeenCalled();
        const result = await extract(download.data as Uint8Array);
        expect(result).toHaveLength(1);
        expect(await pageLabels(download.data as Uint8Array)).toEqual(['1']);
        expect(result[0]).toContain('Original selectable source page');
        expect(compact(result[0])).toContain(compact(translations.join('')));
        const task = getDocument({data: (download.data as Uint8Array).slice(), disableFontFace: true, isEvalSupported: false});
        try {
            const pdf = await task.promise, page = await pdf.getPage(1);
            const items = (await page.getTextContent({disableNormalization: true})).items.filter((item): item is TextItem => 'str' in item);
            const translated = items.filter(item => /原版|Mixed|数学/u.test(item.str));
            expect(translated.length).toBeGreaterThanOrEqual(2);
            const offsetX = data.width + Math.max(8, Math.min(24, data.width * 0.025));
            for (const item of translated) {
                expect(item.transform[4]).toBeGreaterThanOrEqual(offsetX);
                expect(item.transform[4]).toBeLessThanOrEqual(offsetX + data.width);
                expect(item.transform[5]).toBeGreaterThanOrEqual(0);
                expect(item.transform[5]).toBeLessThanOrEqual(data.height);
            }
            page.cleanup();
        } finally {await task.destroy();}
        saveEvidence(`layout-selectable-rotation-${rotation}.pdf`, download.data as Uint8Array);
    });

    it('preserves unpainted metadata, formula characters and untranslated blocks without indexing erased source text', async () => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const page = document.binary.pages[0];
        page.blocks.push({...page.blocks[0], segmentIndex: -1, source: 'Author metadata 独立作者', kind: 'metadata', y: 25},
            {...page.blocks[0], segmentIndex: -1, source: 'Formula 🦄 ∑ x_i', kind: 'formula', y: 180});
        const download = await createDocumentDownload(document, ['替换后的标题', '未实际绘制的译文'], 'translated', {pdfFontLoader: async () => fontBytes,
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [
                {segmentIndex: 0, text: '替换后的标题', x: 42, y: 50, width: 160, fontSize: 14},
                {segmentIndex: 1, text: '非法零宽行', x: 42, y: 110, width: 0, fontSize: 14},
                {segmentIndex: 1, text: '', x: 42, y: 110, width: 160, fontSize: 14},
                {segmentIndex: 1, text: '非法坐标行', x: NaN, y: 110, width: 160, fontSize: 14},
            ]}),
        });
        const text = compact((await extract(download.data as Uint8Array)).join(''));
        expect(text).toContain('替换后的标题');
        expect(text).toContain(compact('Original paragraph'));
        expect(text).toContain(compact('Author metadata 独立作者'));
        expect(text).toContain(compact('Formula 🦄 ∑ x_i'));
        expect(text).not.toContain(compact('Original title'));
        expect(text).not.toContain('非法');
        saveEvidence('layout-source-preservation.pdf', download.data as Uint8Array);
    });

    it.each([['layout', 'missing-glyph'], ['layout', 'offline'], ['readable', 'missing-glyph'], ['readable', 'offline']] as const)
    ('falls back to searchable raster pages for %s/%s without losing Unicode or the tail', async (presentation, failure) => {
        const document = await fixture(), full = '复杂字符 🦄 🔬 数学 𝒱︀ 中文尾部。'.repeat(90) + '最终完整尾部';
        const progress: Array<{phase: string; completedPages: number}> = [];
        const rasterize = vi.fn(async function* (input: Parameters<PdfReadingRasterizer>[0]) {
            const pages = paginatePdfReadingPlan(input.plan, (text, font) => Array.from(text).length * font.size);
            for (const page of pages) yield {bytes: layoutPng, format: 'png' as const, width: page.width, height: page.height,
                textItems: page.items.filter(item => item.kind === 'text').map(item => ({segmentIndex: item.segmentIndex, text: item.text,
                    x: item.x, y: item.y, width: Math.max(1, Array.from(item.text).length * item.font.size), fontSize: item.font.size})),
            };
        });
        const download = await createDocumentDownload(document, ['短标题', full], 'translated', {
            signal: new AbortController().signal,
            onPdfProgress: value => progress.push(value),
            pdfPresentation: presentation, ...(presentation === 'readable' ? {pdfReadingRenderer: renderPdfReadingPages} : {}),
            pdfFontLoader: async () => {if (failure === 'offline') throw new Error('Font unavailable offline'); return fontBytes;},
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [],
                overflowNotes: [{segmentIndex: 1, text: full, x: 42, y: 110, width: 500, height: 40}]}),
            pdfReadingRasterizer: rasterize,
        });
        const pages = await extract(download.data as Uint8Array);
        const text = compact((presentation === 'layout' ? pages.slice(1) : pages).join(''));
        expect(text.replace(compact(presentation === 'layout' ? '第 1 页 · 段落 2 · 完整译文' : '短标题'), '')).toBe(compact(full));
        expect(rasterize).toHaveBeenCalledOnce();
        expect(rasterize.mock.calls[0][0].footerLabel).toBe(presentation === 'layout' ? '原文第 1 页 · 译文续页' : undefined);
        expect(progress).toContainEqual({phase: 'rendering', completedPages: 1, totalPages: 1});
    });

    it('attempts an unavailable continuation font only once per multi-page export and closes raster fallback on cancellation', async () => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const source = await PDFDocument.load(document.binary.bytes);
        source.addPage([600, 800]).drawText('Second source page', {x: 42, y: 720, size: 14});
        document.binary.bytes = await source.save();
        document.binary.pages.push({...document.binary.pages[0], pageNumber: 2});
        const loader = vi.fn(async (): Promise<Uint8Array> => {throw new Error('offline');});
        const rasterize: PdfReadingRasterizer = async function* () {yield {bytes: layoutPng, width: 612, height: 792, textItems: [
            {segmentIndex: 1, text: '完整离线尾部', x: 42, y: 42, width: 140, fontSize: 12},
        ]};};
        const raster = async () => ({data: layoutPng, format: 'png' as const, textItems: [],
            overflowNotes: [{segmentIndex: 1, text: '完整离线尾部', x: 42, y: 110, width: 500, height: 40}]});
        const result = await createDocumentDownload(document, ['标题', '完整离线尾部'], 'translated', {
            pdfFontLoader: loader, pdfPageRasterizer: raster, pdfReadingRasterizer: rasterize,
        });
        expect(loader).toHaveBeenCalledOnce();
        expect(await extract(result.data as Uint8Array)).toHaveLength(4);
        expect(await pageLabels(result.data as Uint8Array)).toEqual(['1', '1 · 译文续页 1', '2', '2 · 译文续页 1']);
        const controller = new AbortController();
        let released = false;
        await expect(createDocumentDownload(document, ['标题', '完整离线尾部'], 'translated', {
            pdfFontLoader: loader, pdfPageRasterizer: raster, signal: controller.signal,
            pdfReadingRasterizer: async function* (input) {
                try {
                    for await (const page of rasterize(input)) yield page;
                    controller.abort(new Error('Fallback canceled'));
                    yield {bytes: layoutPng, width: 612, height: 792, textItems: []};
                } finally {released = true;}
            },
        })).rejects.toThrow('Fallback canceled');
        expect(released).toBe(true);
        await expect(createDocumentDownload(document, ['标题', '完整离线尾部'], 'translated', {
            pdfFontLoader: loader, pdfPageRasterizer: raster,
            pdfReadingRasterizer: async function* () {yield {bytes: layoutPng, width: 612, height: 792};},
        })).rejects.toThrow('未提供可搜索文字');
        await expect(createDocumentDownload(document, ['标题', '完整离线尾部'], 'translated', {
            pdfFontLoader: loader, pdfPageRasterizer: raster,
            pdfReadingRasterizer: async function* () {},
        })).rejects.toThrow('没有生成完整译文续页');
    });

    it('appends only overflowing paragraphs as visible searchable continuations, preserving exact tail and source-page labels', async () => {
        const document = await fixture();
        const full = '长译文完整保留。Mixed English with search and copy 123。'.repeat(180) + '唯一尾部完整结束。';
        const loader = vi.fn(async () => fontBytes);
        const download = await createDocumentDownload(document, ['短标题', full], 'translated', {pdfFontLoader: loader, signal: new AbortController().signal,
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [
                {segmentIndex: 0, text: '短标题', x: 42, y: 50, width: 60, fontSize: 14},
                {segmentIndex: 1, text: '长译文完整保留…', x: 42, y: 110, width: 140, fontSize: 8},
            ], overflowNotes: [{segmentIndex: 1, text: full, x: 42, y: 110, width: 500, height: 40}]}),
        });
        const texts = await extract(download.data as Uint8Array);
        expect(texts.length).toBeGreaterThan(3);
        expect(texts[0]).toContain('长译文完整保留…');
        expect(texts[1]).toContain('第 1 页 · 段落 2 · 完整译文');
        expect(compact(texts.slice(1).join('').replace(/原文第 1 页 · 译文续页 \d+\/\d+/gu, '')).replace(compact('第 1 页 · 段落 2 · 完整译文'), '')).toBe(compact(full));
        expect(texts.at(-1)).toContain('唯一尾部完整结束。');
        expect(texts.slice(1).join('')).not.toContain('短标题');
        expect(loader).toHaveBeenCalledOnce();
        expect(await pageLabels(download.data as Uint8Array)).toEqual(['1', ...texts.slice(1).map((_page, index) => `1 · 译文续页 ${index + 1}`)]);
        const pdf = await PDFDocument.load(download.data as Uint8Array);
        for (const page of pdf.getPages().slice(1)) {
            const link = page.node.Annots()!.lookup(0, PDFDict);
            expect(link.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
            expect(link.get(PDFName.of('Dest'))!.toString()).toContain(pdf.getPage(0).ref.toString());
        }
        saveEvidence('layout-overflow-searchable-continuations.pdf', download.data as Uint8Array);
    });

    it('keeps source line geometry, explicit order and source-only text after progress releases translation segments', async () => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const page = document.binary.pages[0];
        page.blocks[0].source = 'Original title';
        page.blocks[0].readingOrder = 1;
        page.blocks[1].source = 'Original paragraph';
        page.blocks[1].lines = [{text: 'Original first line', x: 42, y: 110, width: 140, height: 14, fontSize: 14},
            {text: 'Original second line', x: 42, y: 128, width: 150, height: 14}];
        page.blocks.push({...page.blocks[0], source: undefined, segmentIndex: -1, readingOrder: 0,
            lines: [{text: 'Source-only author', x: 42, y: 20, width: 160, height: 12}, {text: '', x: 42, y: 35, width: 0, height: 12}]});
        const before = JSON.stringify(page);
        const download = await createDocumentDownload(document, ['译文标题', ''], 'translated', {
            onPdfProgress: progress => {if (progress.completedPages === 0) document.segments = [];},
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [{segmentIndex: 0, text: '译文标题', x: 42, y: 50, width: 80, fontSize: 14}]}),
        });
        const text = compact((await extract(download.data as Uint8Array))[0]);
        expect(text).toContain(compact('Original first line')); expect(text).toContain(compact('Original second line'));
        expect(text.indexOf(compact('Source-only author'))).toBeLessThan(text.indexOf('译文标题'));
        expect(text).not.toContain(compact('Original title')); expect(JSON.stringify(page)).toBe(before);
        saveEvidence('layout-source-lines-after-release.pdf', download.data as Uint8Array);
    });

    it('uses the default font adapter, deduplicates overflow paragraphs and labels a port-supplied paragraph without a source block', async () => {
        const fontModule = await import('@/src/features/document-translation/services/pdfReadingFont');
        const loader = vi.spyOn(fontModule, 'loadPdfReadingFontBytes').mockResolvedValue(fontBytes);
        const note = {segmentIndex: 8, text: '独立校订的完整尾部。\n\n第二段保留。', x: 42, y: 110, width: 500, height: 40};
        try {
            const download = await createDocumentDownload(await fixture(), ['译文标题', '译文正文'], 'translated', {
                signal: new AbortController().signal,
                pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [], overflowNotes: [note, note]}),
            });
            const texts = await extract(download.data as Uint8Array);
            expect(texts.slice(1).join('')).toContain('第 1 页 · 段落 9 · 完整译文');
            expect(texts.join('').match(/独立校订的完整尾部。/gu)).toHaveLength(1);
            expect(loader).toHaveBeenCalledOnce();
        } finally {loader.mockRestore();}
        await expect(createDocumentDownload(await fixture(), ['标题', '含🦄的完整尾部'], 'translated', {
            pdfFontLoader: async () => fontBytes, signal: new AbortController().signal,
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [], overflowNotes: [{...note, text: '含🦄的完整尾部'}]}),
        })).rejects.toThrow('U+1F984');
    });

    it('rejects a malformed raster text alphabet exceeding CID capacity instead of saving truncated search data', async () => {
        const text = Array.from({length: 65_536}, (_unused, index) => String.fromCodePoint(0x10000 + index)).join('');
        await expect(createDocumentDownload(await fixture(), ['标题', '译文'], 'translated', {
            pdfPageRasterizer: async () => ({data: layoutPng, format: 'png', textItems: [{segmentIndex: 0, text, x: 42, y: 50, width: 500, fontSize: 14}]}),
        })).rejects.toThrow('过多独立字形');
    });

    it.each(['vector', 'raster', 'fallback'] as const)('keeps original region characters searchable once at split boundaries in %s readable export', async adapter => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const block = document.binary.pages[0].blocks[1];
        block.kind = 'table'; block.preserveSource = true; block.readingOrder = 1;
        block.x = 40; block.y = 100; block.width = 300; block.height = 40;
        block.lines = [
            {text: 'LEFT SOURCE', x: 42, y: 100, width: 120, height: 20,
                runs: [{text: 'LEFT SOURCE', x: 42, y: 100, width: 120, height: 20, fontSize: 12}]},
            {text: 'BOUNDARY SOURCE', x: 42, y: 110, width: 160, height: 20, fontSize: 14},
            {text: 'WXYZ', x: 20, y: 100, width: 40, height: 12},
            {text: 'OUTSIDE SOURCE', x: 400, y: 100, width: 120, height: 12},
            {text: '', x: 42, y: 100, width: 0, height: 12},
            {text: 'INVALID SOURCE', x: NaN, y: 100, width: 100, height: 12},
        ];
        document.binary.pages[0].blocks.push({...block, segmentIndex: -1, kind: 'metadata', source: 'ORPHAN SOURCE', readingOrder: 0,
            x: 200, y: 100, width: 110, height: 10, lines: undefined},
        {...block, segmentIndex: -1, kind: 'metadata', source: undefined, x: 200, y: 130, width: 110, height: 10, lines: undefined});
        const pages: PdfReadingOutputPage[] = [100, 120].map((y, index) => ({width: 612, height: 792, items: [
            {kind: 'region', entryId: `table-${index}`, sourceRect: {x: 40, y, width: 300, height: 20}, x: 42, y: 42, width: 300, height: 20},
            {kind: 'region', entryId: `invalid-${index}`, sourceRect: {x: 40, y, width: 0, height: 20}, x: 42, y: 42, width: 0, height: 20},
            {kind: 'text', entryId: `translated-${index}`, segmentIndex: 1, text: `本页译文${index}${adapter === 'fallback' ? '🦄' : ''}`, x: 42, y: 100, width: 120, font: {size: 12, weight: 400, lineHeight: 19.2}},
        ]}));
        const rasterize: PdfReadingRasterizer = async function* () {for (const page of pages) yield {bytes: layoutPng, width: page.width, height: page.height, items: page.items,
            textItems: page.items.filter(item => item.kind === 'text').map(item => ({segmentIndex: item.segmentIndex, text: item.text, x: item.x, y: item.y, width: 120, fontSize: 12})),
        };};
        const download = await createDocumentDownload(document, ['标题译文', `表格译文${adapter === 'fallback' ? '🦄' : ''}`], 'translated', adapter === 'vector' ? {
            pdfFontLoader: async () => fontBytes, pdfReadingRenderer: async function* () {for (const page of pages) yield {...page, regionImage: layoutPng};},
        } : {pdfReadingRasterizer: rasterize, ...(adapter === 'fallback' ? {
            pdfPresentation: 'readable', pdfReadingRenderer: renderPdfReadingPages, pdfFontLoader: async () => fontBytes,
        } : {})});
        const text = (await extract(download.data as Uint8Array)).map(compact);
        expect(text[0]).toContain('LEFTSOURCE'); expect(text[0]).toContain('YZ');
        expect(text[0]).toContain('ORPHANSOURCE');
        expect(text[0].indexOf('ORPHANSOURCE')).toBeLessThan(text[0].indexOf('LEFTSOURCE'));
        expect(text[0]).not.toContain('BOUNDARYSOURCE'); expect(text[1]).toContain('BOUNDARYSOURCE');
        expect(text.join('').match(/BOUNDARYSOURCE/gu)).toHaveLength(1);
        expect(text.join('')).not.toContain('OUTSIDESOURCE'); expect(text.join('')).not.toContain('INVALIDSOURCE');
        expect(text[0]).toContain('本页译文0'); expect(text[1]).toContain('本页译文1');
        if (adapter === 'fallback') expect(text.join('')).toContain('🦄');
    });

    it('closes a readable Unicode fallback iterator on cancellation without committing a partial download', async () => {
        const controller = new AbortController();
        let released = false;
        const renderer = vi.fn(renderPdfReadingPages);
        await expect(createDocumentDownload(await fixture(), ['标题', '含🦄的完整译文'], 'translated', {
            pdfFontLoader: async () => fontBytes, pdfReadingRenderer: renderer, pdfPresentation: 'readable', signal: controller.signal,
            pdfReadingRasterizer: async function* () {
                try {
                    yield {bytes: layoutPng, width: 612, height: 792, textItems: [{segmentIndex: 1, text: '含🦄的完整译文', x: 42, y: 42, width: 160, fontSize: 12}]};
                    controller.abort(new Error('Readable fallback canceled'));
                    yield {bytes: layoutPng, width: 612, height: 792, textItems: []};
                } finally {released = true;}
            },
        })).rejects.toThrow('Readable fallback canceled');
        expect(released).toBe(true); expect(renderer).not.toHaveBeenCalled();
    });

    it.each(['vector', 'raster', 'fallback-glyph', 'fallback-offline'] as const)
    ('keeps a real text page followed by a text-free figure page in %s readable export', async adapter => {
        const native = nativeCanvas(), document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const data = document.binary.pages[0], graphic = {x: 100, y: 250, width: 300, height: 470};
        const source = await PDFDocument.create(), original = source.addPage([600, 800]);
        original.drawText('Original title', {x: 42, y: 730, size: 14});
        original.drawRectangle({x: graphic.x, y: 80, width: 150, height: graphic.height, color: (await import('pdf-lib')).rgb(220 / 255, 40 / 255, 50 / 255)});
        original.drawRectangle({x: graphic.x + 150, y: 80, width: 150, height: graphic.height, color: (await import('pdf-lib')).rgb(35 / 255, 90 / 255, 210 / 255)});
        document.binary.bytes = await source.save(); document.segments = document.segments.slice(0, 1);
        data.blocks = data.blocks.slice(0, 1); data.segmentIndexes = [0];
        data.preservedRegions = [{id: 'text-free-figure', kind: 'figure', ...graphic}];
        const translation = adapter === 'fallback-glyph' ? '含🦄的可搜索译文\n\n' : 'Searchable translated text';
        const render = (output: PdfReadingOutputPage, includeText: boolean) => {
            const canvas = native.createCanvas(output.width * 2, output.height * 2), context = canvas.getContext('2d');
            context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.scale(2, 2); context.textBaseline = 'top';
            const textItems: Array<{segmentIndex: number; text: string; x: number; y: number; width: number; fontSize: number}> = [];
            for (const item of output.items) {
                if (item.kind === 'region') {
                    context.fillStyle = 'rgb(220,40,50)'; context.fillRect(item.x, item.y, item.width / 2, item.height);
                    context.fillStyle = 'rgb(35,90,210)'; context.fillRect(item.x + item.width / 2, item.y, item.width / 2, item.height);
                } else if (includeText) {
                    context.font = `${item.font.size}px sans-serif`; context.fillStyle = '#18212f'; context.fillText(item.text, item.x, item.y);
                    textItems.push({segmentIndex: item.segmentIndex, text: item.text, x: item.x, y: item.y, width: context.measureText(item.text).width, fontSize: item.font.size});
                }
            }
            const bytes = canvas.toBuffer('image/png'); canvas.width = canvas.height = 0;
            return {bytes, textItems};
        };
        const renderer: PdfReadingRenderer = async function* (input) {
            for (const output of paginatePdfReadingPlan(input.plan, input.measureText)) yield {...output,
                ...(output.items.some(item => item.kind === 'region') ? {regionImage: render(output, false).bytes} : {})};
        };
        const rasterizer: PdfReadingRasterizer = async function* (input) {
            const measure = native.createCanvas(1, 1).getContext('2d');
            for (const output of paginatePdfReadingPlan(input.plan, (text, font) => {measure.font = `${font.size}px sans-serif`; return measure.measureText(text).width;})) {
                const rendered = render(output, true);
                yield {width: output.width, height: output.height, format: 'png', items: output.items, textItems: rendered.textItems, bytes: rendered.bytes};
            }
        };
        const download = await createDocumentDownload(document, [translation], 'translated', {
            pdfPresentation: 'readable', ...(adapter === 'raster' ? {} : {pdfReadingRenderer: renderer}),
            pdfReadingRasterizer: rasterizer, pdfFontLoader: async () => {if (adapter === 'fallback-offline') throw new Error('Offline font'); return fontBytes;},
        });
        const text = await extract(download.data as Uint8Array);
        expect(text).toHaveLength(2); expect(compact(text[0])).toBe(compact(translation)); expect(text[1].trim()).toBe('');
        const pdf = await PDFDocument.load(download.data as Uint8Array), second = pdf.getPage(1);
        const resources = second.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
        const image = resources.values().map(ref => pdf.context.lookup(ref)).find(value => value instanceof PDFRawStream && value.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) as PDFRawStream;
        expect(image).toBeDefined();
        const pixels = inflateSync(image.getContents());
        let red = 0, blue = 0;
        for (let index = 0; index < pixels.length; index += 3) {
            if (pixels[index] === 220 && pixels[index + 1] === 40 && pixels[index + 2] === 50) red++;
            if (pixels[index] === 35 && pixels[index + 1] === 90 && pixels[index + 2] === 210) blue++;
        }
        expect(red).toBeGreaterThan(100_000); expect(blue).toBeGreaterThan(100_000);
        saveEvidence(`readable-pure-figure-${adapter}.pdf`, download.data as Uint8Array);
    });

    it.each(['missing-body', 'wrong-body', 'zero-width-text', 'zero-font-text', 'nonfinite-text', 'blank-page', 'unknown-region',
        'zero-output-width', 'zero-output-height', 'zero-source-width', 'zero-source-height',
        'outside-left', 'outside-top', 'outside-right', 'outside-bottom'] as const)
    ('rejects %s fallback metadata instead of accepting an incomplete or empty page', async failure => {
        const document = await fixture();
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        const graphic = {x: 100, y: 250, width: 300, height: 470};
        document.binary.pages[0].preservedRegions = failure === 'unknown-region' ? [] : [{id: 'original-figure', kind: 'figure', ...graphic}];
        const region: Extract<PdfReadingOutputPage['items'][number], {kind: 'region'}> = {
            kind: 'region', entryId: 'original-figure', sourceRect: {...graphic}, x: 42, y: 42, width: 450, height: 705,
        };
        if (failure === 'zero-output-width') region.width = 0;
        if (failure === 'zero-output-height') region.height = 0;
        if (failure === 'zero-source-width') region.sourceRect.width = 0;
        if (failure === 'zero-source-height') region.sourceRect.height = 0;
        if (failure === 'outside-left') region.sourceRect.x -= 1;
        if (failure === 'outside-top') region.sourceRect.y -= 1;
        if (failure === 'outside-right') region.sourceRect.width += 1;
        if (failure === 'outside-bottom') region.sourceRect.height += 1;
        const body = {kind: 'text' as const, entryId: 'body', segmentIndex: 0, text: 'Required translated body',
            x: 42, y: 42, width: 450, font: {size: 12, weight: 400 as const, lineHeight: 19.2}};
        const needsBody = ['missing-body', 'wrong-body', 'zero-width-text', 'zero-font-text', 'nonfinite-text'].includes(failure);
        const textItems = ['wrong-body', 'zero-width-text', 'zero-font-text', 'nonfinite-text'].includes(failure) ? [{
            segmentIndex: 0, text: failure === 'wrong-body' ? 'Only a footer' : body.text,
            x: failure === 'nonfinite-text' ? NaN : 42, y: 42, width: failure === 'zero-width-text' ? 0 : 180,
            fontSize: failure === 'zero-font-text' ? 0 : 12,
        }] : [];
        await expect(createDocumentDownload(document, [body.text, 'Translated paragraph'], 'translated', {
            pdfPresentation: 'readable', pdfReadingRenderer: renderPdfReadingPages, pdfFontLoader: async () => {throw new Error('Offline font');},
            pdfReadingRasterizer: async function* () {
                yield {bytes: layoutPng, format: 'png', width: 612, height: 792, textItems,
                    items: failure === 'blank-page' ? [] : needsBody ? [body, region] : [region]};
            },
        })).rejects.toThrow('未提供可搜索文字');
    });

    // 使用公开 NASA 教材的原始第 29–31 页；没有显式提供语料时不把受控夹具冒充真实表格验收。
    it.runIf(Boolean(process.env.FLUENTREAD_NASA_PDF))('keeps every contained original NASA table run searchable in a real rendered readable export (source pages 29–31)', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'fluentread-nasa-readable-'));
        try {
            const source = await PDFDocument.load(new Uint8Array(readFileSync(process.env.FLUENTREAD_NASA_PDF!)));
            const excerpt = await PDFDocument.create();
            for (const page of await excerpt.copyPages(source, [28, 29, 30])) excerpt.addPage(page);
            const bytes = await excerpt.save();
            const inputPath = join(directory, 'nasa-pages-29-31.pdf');
            writeFileSync(inputPath, bytes);
            execFileSync('pdftoppm', ['-r', '144', '-png', inputPath, join(directory, 'source')], {timeout: 60_000, stdio: 'pipe'});
            const native = nativeCanvas();
            const images = await Promise.all([1, 2, 3].map(page => native.loadImage(join(directory, `source-${page}.png`))));
            const document = await parseBinaryDocument('nasa-original-pages-29-31.pdf', bytes);
            if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
            const sourcePages = document.binary.pages;
            const translations = document.segments.map((_segment, index) => `受控译文第${index + 1}段。`);
            const expected = new Map<number, Set<string>>(), outputRanges = new Map<number, number[]>();
            let outputIndex = 0;
            const renderer: PdfReadingRenderer = async function* (input) {
                const sourcePage = sourcePages[input.pageNumber - 1], sourceImage = images[input.pageNumber - 1];
                for (const output of paginatePdfReadingPlan(input.plan, input.measureText)) {
                    const canvas = native.createCanvas(output.width * 2, output.height * 2), context = canvas.getContext('2d');
                    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.scale(2, 2);
                    for (const item of output.items) if (item.kind === 'region') {
                        const r = item.sourceRect;
                        // 这些 NASA 横向页已由解析器恢复为展示坐标；裁剪真实 Poppler 源像素，不用白图替代表格。
                        expect(sourcePage.rotation ?? 0).toBe(0);
                        context.drawImage(sourceImage, r.x * sourceImage.width / sourcePage.width, r.y * sourceImage.height / sourcePage.height,
                            r.width * sourceImage.width / sourcePage.width, r.height * sourceImage.height / sourcePage.height,
                            item.x, item.y, item.width, item.height);
                        const runs = sourcePage.blocks.flatMap(block => (block.lines ?? []).flatMap(line => line.runs?.length ? line.runs : [line]));
                        const required = expected.get(input.pageNumber) ?? new Set<string>();
                        for (const run of runs) if (run.text.trim() && run.x >= r.x && run.y >= r.y
                            && run.x + run.width <= r.x + r.width && run.y + run.height <= r.y + r.height) required.add(run.text);
                        expected.set(input.pageNumber, required);
                    }
                    const indexes = outputRanges.get(input.pageNumber) ?? []; indexes.push(outputIndex++); outputRanges.set(input.pageNumber, indexes);
                    const regionImage = canvas.toBuffer('image/png'); canvas.width = canvas.height = 0;
                    yield {...output, regionImage};
                }
            };
            const download = await createDocumentDownload(document, translations, 'translated', {pdfFontLoader: async () => fontBytes,
                pdfReadingRenderer: renderer, signal: new AbortController().signal});
            const text = await extract(download.data as Uint8Array);
            const normalized = (value: string) => value.normalize('NFKC').replace(/[\s\u0000\p{Cf}]/gu, '');
            const anchors = ['Technical Performance Measures', 'Transitioning the verified and validated product', 'configuration audits'];
            for (const [index, anchor] of anchors.entries()) {
                const value = normalized((outputRanges.get(index + 1) ?? []).map(page => text[page]).join(''));
                expect(value).toContain(normalized(anchor));
                expect(expected.get(index + 1)!.size).toBeGreaterThan(10);
                for (const run of expected.get(index + 1)!) expect(value).toContain(normalized(run));
            }
            saveEvidence('nasa-29-31-source.pdf', bytes);
            saveEvidence('nasa-29-31-readable-searchable.pdf', download.data as Uint8Array);
        } finally {rmSync(directory, {recursive: true, force: true});}
    }, 60_000);

    it('cancels visible overflow font work promptly and retries using unchanged model and translations', async () => {
        const document = await fixture(), translations = ['标题', '译文'];
        const controller = new AbortController();
        const raster = vi.fn(async () => ({data: layoutPng, format: 'png' as const, textItems: [{segmentIndex: 0, text: translations[0], x: 42, y: 50, width: 60, fontSize: 14}],
            overflowNotes: [{segmentIndex: 1, text: translations[1], x: 42, y: 110, width: 500, height: 40}]}));
        await expect(createDocumentDownload(document, translations, 'translated', {pdfPageRasterizer: raster, signal: controller.signal,
            pdfFontLoader: async () => {controller.abort(new Error('Layout font canceled')); return new Promise<Uint8Array>(() => {});},
        })).rejects.toThrow('Layout font canceled');
        const retry = await createDocumentDownload(document, translations, 'translated', {pdfPageRasterizer: raster, pdfFontLoader: async () => fontBytes});
        expect((await extract(retry.data as Uint8Array))[0]).toContain('标题');
        expect(document.segments[0].source).toBe('Original title');
        expect(translations).toEqual(['标题', '译文']);
    });

    it('retains every visible glyph outline after subsetting, including odd-length Chinese/Latin records', async () => {
        const font = fontkit.create(fontBytes);
        const subset = font.createSubset();
        const glyphs = font.layout('中文译文标题 Mixed English 123，标点。éü①② ∗ϵŁłĐđɃɐἀὯ∀∑∫≠⊗⋆⨀⩽𝒜𝜖𝟟 ‣⌀⟶⟺ 、︁。︁！︁', {liga: false}).glyphs;
        const pairs = glyphs.map(glyph => ({original: glyph, index: subset.includeGlyph(glyph)}));
        const bytes = await new Promise<Uint8Array>((resolve, reject) => {
            const parts: Uint8Array[] = [];
            const stream = subset.encodeStream() as unknown as import('node:stream').Readable;
            stream.on('data', part => parts.push(part)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
        });
        const embedded = fontkit.create(bytes);
        for (const {original, index} of pairs) expect(embedded.getGlyph(index).path.toSVG()).toBe(original.path.toSVG());
    });
    it('covers complete Latin Extended A/B and mathematical operator ranges and retains Unicode identities when copied', async () => {
        const font = fontkit.create(fontBytes);
        const supported = new Set(font.characterSet);
        const full = [[0x0100, 0x024F], [0x2200, 0x22FF], [0x2A00, 0x2AFF]].flatMap(([lo, hi]) =>
            Array.from({length: hi - lo + 1}, (_, index) => String.fromCodePoint(lo + index)));
        expect(full.every(character => supported.has(character.codePointAt(0)!))).toBe(true);
        const reviewed = ['‣', '⌀', '⟶', '⟺'];
        expect(reviewed.every(character => supported.has(character.codePointAt(0)!))).toBe(true);
        expect(reviewed.every(character => {
            const glyph = font.layout(character).glyphs[0];
            return glyph.id !== 0 && glyph.path.toSVG();
        })).toBe(true);
        const translations = ['扩展字符与数学符号', full.join('') + ' ∗ϵŁł ἀὯ𝒜𝜖𝟟 ‣ ⌀ ⟶ ⟺ 中文唯一尾部：完。'];
        const download = await createDocumentDownload(await fixture(), translations, 'translated', textOnlyOptions);
        const extracted = await extract(download.data as Uint8Array);
        expect(compact(extracted.join(''))).toBe(compact(translations.join('')));
        expect(extracted.at(-1)).toContain('中文唯一尾部：完。');
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

    it.each([
        '𝒱 𝒱︀ 𝒱 𝒞 𝒞︀ 𝒞 𝒮 𝒮︀ 𝒮 C C︀ C S S︀ S 葛 葛\u{E0100} 葛 𝒱\uFE0F 葛\u{E01EF} 𝒱︀ 。 。︁ 。',
        '𝒱︀ 𝒱 𝒱︀ 𝒞︀ 𝒞 𝒞︀ 𝒮︀ 𝒮 𝒮︀ C︀ C C︀ S︀ S S︀ 葛\u{E0100} 葛 葛\u{E0100} 𝒱\uFE0F 葛\u{E01EF} 𝒱 。︁ 。 。︁',
    ])('preserves bare and variant sequence copying in either order without assigning selectors to bare same-gid glyphs: %s', async text => {
        const translations = ['数学变体复制验证', text + ' 完整尾部。'];
        const download = await createDocumentDownload(await fixture(), translations, 'translated', textOnlyOptions);
        const extracted = await extract(download.data as Uint8Array);
        expect(compact(extracted.join(''))).toBe(compact(translations.join('')));
    }, 90_000);

    it('uses a separate cached subset per exact variant sequence and measures and draws identical runs', async () => {
        const pdf = await PDFDocument.create();
        const embed = vi.spyOn(pdf, 'embedFont');
        const embedded = await embedPdfReadingFont(pdf, fontBytes);
        const text = 'C C︀ C︀ S︀ 𝒱︀ 葛\u{E0100} C';
        await embedded.prepareText(text);
        await embedded.prepareText('C︀ S︀');
        expect(embed).toHaveBeenCalledTimes(5);
        const page = pdf.addPage();
        const draw = vi.spyOn(page, 'drawText');
        embedded.drawText(page, text, {x: 42, y: 700, size: 12});
        expect(draw.mock.calls.map(call => call[0]).join('')).toBe(text);
        expect(draw.mock.calls[1][1]!.font).toBe(draw.mock.calls[3][1]!.font);
        expect(draw.mock.calls[1][1]!.font).not.toBe(embedded.font);
        const expectedWidth = draw.mock.calls.reduce((sum, [run, options]) => sum + options!.font!.widthOfTextAtSize(run, 12), 0);
        expect(embedded.measureText(text, 12)).toBe(expectedWidth);
        expect(draw.mock.calls.at(-1)![1]!.x! + embedded.font.widthOfTextAtSize(' C', 12)).toBeCloseTo(42 + expectedWidth);
        expect(embedded.measureText('', 12)).toBe(0);
        const count = draw.mock.calls.length;
        embedded.drawText(page, '', {x: 42, y: 700, size: 12});
        expect(draw).toHaveBeenCalledTimes(count);
        expect(() => embedded.measureText('Q︀', 12)).toThrow('尚未准备');
        expect(compact((await extract(await pdf.save())).join(''))).toBe(compact(text));
    }, 60_000);

    it('retains the bundled font base outlines for unsupported variation mappings while keeping each full sequence identity', () => {
        // 数学补充字形未携带其 donor 的变体映射；这些序列按该字体回退到基础轮廓，仍保留选择符。
        // fontkit 按 glyph id 缓存首次 codePoints；普通字形与变体须分开解析，仅在本用例各自复用只读布局。
        const baseFont = fontkit.create(fontBytes), variationFont = fontkit.create(fontBytes);
        for (const sequence of ['𝒱︀', '𝒞︀', '𝒮︀', 'C︀', 'S︀', '葛\u{E0100}']) {
            const base = Array.from(sequence)[0];
            const normal = baseFont.layout(base, {liga: false}).glyphs;
            const variant = variationFont.layout(sequence, {liga: false}).glyphs;
            expect(variant).toHaveLength(1);
            expect(variant[0].codePoints).toEqual(Array.from(sequence, character => character.codePointAt(0)!));
            expect(variant[0].path.toSVG()).toBe(normal[0].path.toSVG());
        }
    });

    it('retains genuinely different CJK punctuation variation outlines supplied by the bundled font', () => {
        const baseFont = fontkit.create(fontBytes), variationFont = fontkit.create(fontBytes);
        for (const sequence of ['、︁', '。︁', '！︁']) {
            const base = Array.from(sequence)[0];
            const normal = baseFont.layout(base, {liga: false}).glyphs[0];
            const variant = variationFont.layout(sequence, {liga: false}).glyphs[0];
            expect(variant.id).not.toBe(normal.id);
            expect(variant.path.toSVG()).not.toBe(normal.path.toSVG());
            expect(variant.codePoints).toEqual(Array.from(sequence, character => character.codePointAt(0)!));
        }
    });

    it('rejects genuinely missing bases and isolated or repeated selectors without dropping real text', async () => {
        const embedded = await embedPdfReadingFont(await PDFDocument.create(), fontBytes);
        for (const text of ['︀C', '\u{E0100}葛', 'C ︀', 'C\t︀', 'C\n︀', 'C︀︁']) {
            expect(() => embedded.assertSupported(text)).toThrow('孤立变体选择符');
        }
        await expect(embedded.prepareText('🦄︀')).rejects.toThrow('U+1F984');
        expect(() => embedded.assertSupported('C\uFFFE')).toThrow('U+FFFE');
        expect(() => embedded.assertSupported('\u0093idΓ')).toThrow('U+93');
    });

    it('checks cancellation before variant preparation and after a distinct sequence subset is embedded', async () => {
        const controller = new AbortController();
        const pdf = await PDFDocument.create();
        const embedded = await embedPdfReadingFont(pdf, fontBytes, controller.signal);
        const embedFont = pdf.embedFont.bind(pdf);
        const spy = vi.spyOn(pdf, 'embedFont').mockImplementation(async (bytes, options) => {
            const font = await embedFont(bytes, options);
            controller.abort(new Error('Variant embedding canceled'));
            return font;
        });
        await expect(embedded.prepareText('C︀')).rejects.toThrow('Variant embedding canceled');
        expect(spy).toHaveBeenCalledOnce();
        await expect(embedded.prepareText('S︀')).rejects.toThrow('Variant embedding canceled');
        expect(spy).toHaveBeenCalledOnce();
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

    it('preserves selectable original pages followed by selectable translation only for explicit readable output', async () => {
        const translations = ['双语对照标题', '原论文页继续保留，译文页可以复制。'];
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
        const raster = vi.fn(async () => png);
        const download = await createDocumentDownload(await fixture(), translations, 'bilingual', {
            ...textOnlyOptions, pdfPresentation: 'readable', pdfPageRasterizer: raster,
        });
        const bytes = download.data as Uint8Array;
        const pages = await extract(bytes);
        expect(pages).toHaveLength(2);
        expect(pages[0]).toContain('Original selectable source page');
        expect(compact(pages[1])).toBe(compact(translations.join('')));
        expect(raster).not.toHaveBeenCalled();
        expect(await pageLabels(bytes)).toBeNull();
        saveEvidence('bilingual-original-and-translation.pdf', bytes);
    });

    it('embeds a renderer region image alongside selectable translated text on the same reading page', async () => {
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
        const source = await PDFDocument.create();
        const page = source.addPage([600, 800]);
        page.drawText('Original paragraph before the figure.', {x: 42, y: 700, size: 12});
        page.drawImage(await source.embedPng(png), {x: 42, y: 500, width: 120, height: 80});
        page.drawText('Figure 1. Original retained illustration', {x: 42, y: 480, size: 10});
        page.drawText('Original paragraph after the figure.', {x: 42, y: 440, size: 12});
        const document = await parseBinaryDocument('figure.pdf', await source.save());
        const translations = document.segments.map((_segment, index) => `中文译文第${index + 1}段。`);
        let renderedRegions = 0;
        const renderer: PdfReadingRenderer = async function* (input) {
            // 控制浏览器 PNG 端口，分页、字体、PDF 嵌入和文本导出仍执行真实生产模块。
            for (const output of paginatePdfReadingPlan(input.plan, input.measureText)) {
                if (output.items.some(item => item.kind === 'region')) {renderedRegions++;yield {...output, regionImage: png};}
                else yield output;
            }
        };
        const download = await createDocumentDownload(document, translations, 'translated', {...textOnlyOptions, pdfReadingRenderer: renderer});
        expect(renderedRegions).toBe(1);
        const bytes = download.data as Uint8Array;
        expect(compact((await extract(bytes)).join(''))).toBe(compact(translations.join('')));
        const output = await PDFDocument.load(bytes);
        expect(output.getPageCount()).toBe(1);
        const images = output.getPages()[0].node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
        expect(images.values().some(value => {
            const object = output.context.lookup(value);
            return object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image');
        })).toBe(true);
        expect(document.segments.map(segment => segment.source).join('')).toContain('Original paragraph before the figure.');
    });

    it('keeps the default layout paired on one page even when a readable renderer is available', async () => {
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
        const raster = vi.fn(async () => png);
        const renderer = vi.fn(renderPdfReadingPages);
        const loader = vi.fn(async () => fontBytes);
        const download = await createDocumentDownload(await fixture(), ['对照标题', '原版排版译文'], 'bilingual', {
            pdfPageRasterizer: raster, pdfReadingRenderer: renderer, pdfFontLoader: loader,
        });
        const pdf = await PDFDocument.load(download.data as Uint8Array);
        expect(pdf.getPageCount()).toBe(1);
        expect(pdf.getPage(0).getSize()).toEqual({width: 1215, height: 800});
        expect((await extract(download.data as Uint8Array))[0]).toContain('Original selectable source page');
        expect(raster).toHaveBeenCalledOnce();
        expect(renderer).not.toHaveBeenCalled();
        expect(loader).not.toHaveBeenCalled();
    });

    it('cancels a font loader that remains pending without waiting for its completion', async () => {
        const controller = new AbortController();
        await expect(createDocumentDownload(await fixture(), ['标题', '译文'], 'translated', {...textOnlyOptions,
            signal: controller.signal, pdfFontLoader: async () => {
                controller.abort(new Error('Pending font canceled'));
                return new Promise<Uint8Array>(() => {});
            },
        })).rejects.toThrow('Pending font canceled');
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
