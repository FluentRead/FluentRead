/**
 * @file tests/documentPdfRotation.test.ts
 * 文件职责：以真实 PDF.js 解析验证旋转和页面裁剪在 PDF 导入、光栅端口与矢量原页导出之间保持一致。
 * 主要内容：四种页面旋转、有效 CropBox 与 MediaBox 交集、非零原点、空交集回退；识别过的旋转扫描页只用原页旋转角摆正嵌入的原页；验证原始字节不变、裁掉的字形不可见以及显示尺寸和字形矩阵精确保持。
 * 模块边界：实际生成并读取 PDF 文件，不以 Canvas 端口模拟原页字形几何，不调用浏览器或翻译服务。
 */
import {degrees, PDFDocument} from 'pdf-lib';
import {describe, expect, it, vi} from 'vitest';

import {
    createDocumentDownload,
    parseBinaryDocument,
    type PdfRasterPageInput,
} from '@/src/features/document-translation/services/binary';

const rotations = [0, 90, 180, 270] as const;
const heading = 'Rotated source heading';
const firstParagraph = 'First source paragraph has useful words.';
const secondParagraph = 'Second paragraph is still readable.';
const onePixelPng = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=',
    'base64',
));

async function rotatedPdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    for (const rotation of rotations) {
        const page = pdf.addPage([420, 640]);
        page.drawText(heading, {x: 48, y: 540, size: 18});
        page.drawText(firstParagraph, {x: 48, y: 476, size: 12});
        page.drawText(secondParagraph, {x: 48, y: 452, size: 12});
        page.setRotation(degrees(rotation));
    }
    return pdf.save();
}

async function outputText(bytes: Uint8Array): Promise<Array<Array<{str: string; transform: number[]}>>> {
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({data: bytes.slice(), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false});
    try {
        const pdf = await task.promise;
        const pages: Array<Array<{str: string; transform: number[]}>> = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
            const page = await pdf.getPage(number);
            try {
                const text = await page.getTextContent();
                pages.push(text.items.flatMap(item => 'str' in item && item.str.trim()
                    ? [{str: item.str, transform: item.transform}]
                    : []));
            } finally {
                page.cleanup();
            }
        }
        return pages;
    } finally {
        await task.destroy();
    }
}

async function displayedText(bytes: Uint8Array): Promise<Array<{width: number; height: number; text: Array<{str: string; transform: number[]}>}>> {
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({data: bytes.slice(), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false});
    try {
        const pdf = await task.promise;
        const pages = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
            const page = await pdf.getPage(number);
            try {
                const viewport = page.getViewport({scale: 1}), content = await page.getTextContent();
                const [a, b, c, d, e, f] = viewport.transform;
                pages.push({width: viewport.width, height: viewport.height, text: content.items.flatMap(item => {
                    if (!('str' in item) || !item.str.trim()) return [];
                    const [A, B, C, D, E, F] = item.transform;
                    return [{str: item.str, transform: [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f]}];
                })});
            } finally {page.cleanup();}
        }
        return pages;
    } finally {await task.destroy();}
}

async function croppedPdf(box: 'inside' | 'intersection' | 'empty'): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    for (const rotation of rotations) {
        const page = pdf.addPage([600, 800]);
        if (box === 'inside') page.setCropBox(100, 100, 400, 600);
        else if (box === 'intersection') {page.setMediaBox(100, 200, 600, 800); page.setCropBox(-100, 400, 500, 800);}
        else page.setCropBox(800, 900, 100, 100);
        page.drawText('Visible source target', {x: 200, y: 500, size: 12});
        page.drawText('Outside cropped page', {x: box === 'intersection' ? 650 : 20, y: box === 'intersection' ? 500 : 20, size: 12});
        page.setRotation(degrees(rotation));
    }
    return pdf.save();
}

function expectRotatedSources(pages: Awaited<ReturnType<typeof outputText>>): void {
    const headingTransforms = [
        [18, 0, 0, 18, 48, 540],
        [0, -18, 18, 0, 540, 372],
        [-18, 0, 0, -18, 372, 100],
        [0, 18, -18, 0, 100, 48],
    ];
    expect(pages).toHaveLength(4);
    for (const [index, items] of pages.entries()) {
        expect(items.map(item => item.str)).toEqual([heading, firstParagraph, secondParagraph]);
        const sourceHeading = items.find(item => item.str === heading)!;
        for (const [coordinate, expected] of headingTransforms[index].entries()) {
            expect(sourceHeading.transform[coordinate]).toBeCloseTo(expected, 6);
        }
    }
}

describe('real rotated PDF import and download', () => {
    it('extracts every page rotation with unchanged content coordinates and rotated display dimensions', async () => {
        const bytes = await rotatedPdf();
        const originalBytes = bytes.slice();
        const parsed = await parseBinaryDocument('rotated.pdf', bytes);
        expect(parsed.binary?.kind).toBe('pdf');
        if (parsed.binary?.kind !== 'pdf') throw new Error('Expected parsed PDF');
        const baseline = parsed.binary.pages[0];
        expect(baseline.blocks.length).toBeGreaterThan(1);
        const baselineGeometry = baseline.blocks.map(({segmentIndex: _segmentIndex, ...block}) => block);
        const baselineText = baseline.segmentIndexes.map(index => parsed.segments[index].source);
        expect(baselineText.join(' ')).toContain(heading);
        expect(baselineText.join(' ')).toContain(firstParagraph);
        expect(baselineText.join(' ')).toContain(secondParagraph);
        expect(parsed.binary.pages).toHaveLength(4);
        for (const [index, page] of parsed.binary.pages.entries()) {
            const quarterTurn = index === 1 || index === 3;
            expect(page).toMatchObject({pageNumber: index + 1, width: quarterTurn ? 640 : 420, height: quarterTurn ? 420 : 640});
            expect(page.rotation ?? 0).toBe(rotations[index]);
            expect(page.blocks.map(({segmentIndex: _segmentIndex, ...block}) => block)).toEqual(baselineGeometry);
            expect(page.segmentIndexes.map(segmentIndex => parsed.segments[segmentIndex].source)).toEqual(baselineText);
            expect(parsed.segments[page.segmentIndexes[0]].contextLabel).toBe(`第 ${index + 1} 页`);
        }
        expect(bytes).toEqual(originalBytes);
        expect(parsed.binary.bytes).toEqual(originalBytes);
        expect(parsed.binary.bytes).not.toBe(bytes);
    });

    it.each(['bilingual', 'translated'] as const)('passes native rotation to the rasterizer and preserves the displayed page shape in %s downloads', async mode => {
        const bytes = await rotatedPdf();
        const originalBytes = bytes.slice();
        const parsed = await parseBinaryDocument('rotated.pdf', bytes);
        if (parsed.binary?.kind !== 'pdf') throw new Error('Expected parsed PDF');
        const translations = parsed.segments.map(segment => `Translated: ${segment.source}`);
        const captured: PdfRasterPageInput[] = [];
        const rasterizer = vi.fn(async (input: PdfRasterPageInput) => {
            captured.push(input);
            return onePixelPng;
        });
        const download = await createDocumentDownload(parsed, translations, mode, {pdfPageRasterizer: rasterizer});
        const output = await PDFDocument.load(download.data as Uint8Array);
        expect(output.getPageCount()).toBe(4);
        expect(captured).toHaveLength(4);
        for (const [index, input] of captured.entries()) {
            const quarterTurn = index === 1 || index === 3;
            expect(input).toMatchObject({pageNumber: index + 1, width: quarterTurn ? 640 : 420, height: quarterTurn ? 420 : 640});
            expect(input.rotation ?? 0).toBe(rotations[index]);
            expect(input.blocks).toEqual(parsed.binary.pages[index].blocks);
            expect(input.translations).toEqual(translations);
            expect(input.sourceBytes).toEqual(originalBytes);
            expect(output.getPage(index).getSize()).toEqual({
                width: mode === 'bilingual' ? (quarterTurn ? 1296 : 850.5) : (quarterTurn ? 640 : 420),
                height: quarterTurn ? 420 : 640,
            });
        }
        const text = await outputText(download.data as Uint8Array);
        if (mode === 'bilingual') expectRotatedSources(text);
        else expect(text).toEqual([[], [], [], []]);
        expect(bytes).toEqual(originalBytes);
        expect(parsed.binary.bytes).toEqual(originalBytes);
    });

    it('keeps recognised rotated scans upright in bilingual downloads: display-space blocks for the rasterizer, the page angle only for the embedded original', async () => {
        const parsed = await parseBinaryDocument('rotated.pdf', await rotatedPdf());
        if (parsed.binary?.kind !== 'pdf') throw new Error('Expected parsed PDF');
        // 文字识别之后的旋转扫描页：版面块已是展示坐标，rotation 换成 sourceRotation。
        const pages = parsed.binary.pages.map(({rotation, ...page}) => ({...page, ...(rotation ? {sourceRotation: rotation} : {})}));
        const recognised = {...parsed, binary: {...parsed.binary, pages}} as typeof parsed;
        const captured: PdfRasterPageInput[] = [];
        const download = await createDocumentDownload(recognised, parsed.segments.map(segment => `Translated: ${segment.source}`), 'bilingual', {
            pdfPageRasterizer: async input => {captured.push(input); return onePixelPng;},
        });
        expect(captured.map(input => input.rotation ?? 0)).toEqual([0, 0, 0, 0]);
        expect(captured.map(input => [input.width, input.height])).toEqual([[420, 640], [640, 420], [420, 640], [640, 420]]);
        const output = await PDFDocument.load(download.data as Uint8Array);
        expect(output.getPages().map(page => page.getSize().height)).toEqual([640, 420, 640, 420]);
        expectRotatedSources(await outputText(download.data as Uint8Array));
    });

    it('keeps unchanged rotated bilingual pages as correctly oriented originals without rasterizing', async () => {
        const bytes = await rotatedPdf();
        const originalBytes = bytes.slice();
        const parsed = await parseBinaryDocument('rotated.pdf', bytes);
        const rasterizer = vi.fn(async () => onePixelPng);
        const download = await createDocumentDownload(parsed, parsed.segments.map(segment => segment.source), 'bilingual', {pdfPageRasterizer: rasterizer});
        expect(rasterizer).not.toHaveBeenCalled();
        const output = await PDFDocument.load(download.data as Uint8Array);
        expect(output.getPages().map(page => page.getSize())).toEqual([
            {width: 850.5, height: 640}, {width: 1296, height: 420},
            {width: 850.5, height: 640}, {width: 1296, height: 420},
        ]);
        const paired = await outputText(download.data as Uint8Array);
        expectRotatedSources(paired.map(items => items.slice(0, 3)));
        expect(paired.every(items => items.map(item => item.str).join('|') === [heading, firstParagraph, secondParagraph, heading, firstParagraph, secondParagraph].join('|'))).toBe(true);
        expect(bytes).toEqual(originalBytes);
        expect(parsed.binary?.bytes).toEqual(originalBytes);
    });

    it.each(['inside', 'intersection', 'empty'] as const)('preserves effective %s crop geometry and visible glyphs at all rotations without changing source bytes', async box => {
        const bytes = await croppedPdf(box), originalBytes = bytes.slice();
        const parsed = await parseBinaryDocument('cropped.pdf', bytes), rasterizer = vi.fn(async () => onePixelPng);
        const download = await createDocumentDownload(parsed, [], 'bilingual', {pdfPageRasterizer: rasterizer});
        expect(rasterizer).not.toHaveBeenCalled();
        const readableDownload = await createDocumentDownload(parsed, parsed.segments.map(segment => `Translated: ${segment.source}`), 'bilingual', {
            pdfReadingRasterizer: async function* () {yield {bytes: onePixelPng, width: 612, height: 792};},
        });
        const original = await displayedText(bytes);
        for (const result of [download, readableDownload]) {
            const exported = (await displayedText(result.data as Uint8Array)).filter(page => page.text.length > 0);
            expect(exported).toHaveLength(rotations.length);
            for (const [index, page] of exported.entries()) {
                const paired = result === download;
                const expectedWidth = paired ? original[index].width * 2 + Math.max(8, Math.min(24, original[index].width * 0.025)) : original[index].width;
                expect([page.width, page.height]).toEqual([expectedWidth, original[index].height]);
                const left = paired ? page.text.slice(0, original[index].text.length) : page.text;
                expect(left.map(item => item.str)).toEqual(original[index].text.map(item => item.str));
                expect(left.some(item => item.str === 'Outside cropped page')).toBe(box === 'empty');
                expect(left.some(item => item.str === 'Visible source target')).toBe(true);
                for (const [textIndex, item] of left.entries()) {
                    for (const [coordinate, value] of item.transform.entries()) expect(value).toBeCloseTo(original[index].text[textIndex].transform[coordinate], 6);
                }
            }
        }
        expect(bytes).toEqual(originalBytes); expect(parsed.binary?.bytes).toEqual(originalBytes);
    });
});
