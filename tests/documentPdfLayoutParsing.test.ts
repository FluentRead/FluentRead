/**
 * @file tests/documentPdfLayoutParsing.test.ts
 * 文件职责：用实际 PDF.js 提取验证可读 PDF 解析合同和源文件不变，避免仅测试人工拼接的分析对象。
 * 主要内容：生成含分栏、上下标、独立公式、表格规则、位图与矢量图的 PDF；检查正文和标题顺序、原始行几何以及保护区域不进入翻译片段；使用随仓库示例与真实标准字体验证衬线正文不因非有限字体指标被删掉、标题空白受正文约束。
 * 模块边界：真实运行 pdf-lib/PDF.js 和二进制解析，不需要浏览器、翻译服务或图片截图。
 */
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {PDFDocument, rgb, StandardFonts} from 'pdf-lib';
import {parseBinaryDocument, pdfPageSegments, pdfTextAtoms, type PdfTextStyle} from '@/src/features/document-translation/services/binary';
import {analyzePdfPageLayout, extractPdfGraphicsShapes, type PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
import {pdfOverlayBlocks} from '@/src/features/document-translation/core/pdfBlockFit';
import type {DocumentSegment, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {restoreDocumentHistoryTranslations} from '@/src/features/document-translation/services/history';

async function fixture(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([612, 792]);
    first.drawText('1 Introduction', {x: 40, y: 735, size: 14, font});
    first.drawText('4 Right section', {x: 330, y: 735, size: 14, font});
    for (const [x, prefix] of [[40, 'Left'], [330, 'Right']] as const) {
        first.drawText(`${prefix} column begins with ordinary prose`, {x, y: 690, size: 10, font});
        first.drawText(`${prefix} column continues on its own line.`, {x, y: 679, size: 10, font});
        first.drawText(`${prefix} second paragraph stays independent.`, {x, y: 650, size: 10, font});
    }
    first.drawText('2 Left next section', {x: 40, y: 620, size: 14, font});
    first.drawText('A representation h', {x: 40, y: 590, size: 10, font});
    first.drawText('t', {x: 124, y: 587, size: 7, font});
    first.drawText(' is used in the next step.', {x: 128, y: 590, size: 10, font});
    const second = pdf.addPage([612, 792]);
    second.drawText('Table 1: unchanged measurements', {x: 40, y: 740, size: 10, font});
    for (const y of [715, 685, 645]) second.drawLine({start: {x: 40, y}, end: {x: 560, y}, thickness: .5});
    second.drawText('Model', {x: 50, y: 697, size: 10, font}); second.drawText('Value', {x: 330, y: 697, size: 10, font});
    second.drawText('Baseline', {x: 50, y: 667, size: 10, font}); second.drawText('24.9', {x: 330, y: 667, size: 10, font});
    second.drawText('The prose after the table remains translatable.', {x: 40, y: 615, size: 10, font});
    second.drawText('F(x) = QK', {x: 220, y: 560, size: 12, font}); second.drawText('(1)', {x: 530, y: 560, size: 10, font});
    const png = await pdf.embedPng(new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4QAAAAASUVORK5CYII=', 'base64')));
    second.drawImage(png, {x: 400, y: 380, width: 100, height: 80});
    second.drawText('Figure 1: original diagram', {x: 400, y: 365, size: 10, font});
    const third = pdf.addPage([612, 792]);
    third.drawRectangle({x: 100, y: 500, width: 180, height: 100, color: rgb(.9, .7, .6)});
    third.drawText('Vector diagram label', {x: 110, y: 550, size: 10, font});
    third.drawText('Figure 2: vector geometry is retained', {x: 100, y: 480, size: 10, font});
    return pdf.save();
}

describe('real PDF structural parsing', () => {
    it('keeps real standard-font serif paragraphs and bounds their preceding heading in the repository sample', async () => {
        const bytes = new Uint8Array(readFileSync(new URL('../examples/document-translation/sample.pdf', import.meta.url)));
        const before = bytes.slice();
        const loadedFonts: string[] = [];
        // 与浏览器读取同一套标准字体；不依赖 Node 20 缺失的 process.getBuiltinModule 读取路径。
        class StandardFontDataFactory {
            async fetch({filename}: {filename: string}): Promise<Uint8Array> {
                loadedFonts.push(filename);
                return new Uint8Array(readFileSync(new URL(`../node_modules/pdfjs-dist/standard_fonts/${filename}`, import.meta.url)));
            }
        }
        const {getDocument, OPS} = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loading = getDocument({data: bytes.slice(), disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, StandardFontDataFactory});
        try {
            const pdf = await loading.promise;
            const page = await pdf.getPage(1);
            try {
                const viewport = page.getViewport({scale: 1});
                const content = await page.getTextContent();
                expect(loadedFonts).toEqual(expect.arrayContaining(['FoxitSerif.pfb', 'FoxitSerifItalic.pfb']));
                const atoms = pdfTextAtoms(content.items.filter(item => 'str' in item), content.styles as Record<string, PdfTextStyle>, viewport, true) as PdfLayoutAtom[];
                const graphics = extractPdfGraphicsShapes(await page.getOperatorList(), OPS, viewport);
                const layout = analyzePdfPageLayout({atoms, graphics, width: viewport.width, height: viewport.height});
                const segments: DocumentSegment[] = [];
                const pageData: PdfDocumentPage = {pageNumber: 1, width: viewport.width, height: viewport.height,
                    ...pdfPageSegments(layout.blocks, 1, segments), preservedRegions: layout.preservedRegions};
                for (const source of ['FluentRead parses the PDF text layer', 'The reader presents the untouched source page',
                    'A bilingual download contains one wide page', 'Regression evidence must prove', 'Text extraction is an internal step']) {
                    expect(segments.some(segment => segment.source.startsWith(source))).toBe(true);
                }
                const heading = pdfOverlayBlocks(pageData).find(entry => segments[entry.block.segmentIndex]?.source === '4 VISUAL INVARIANTS')!;
                const paragraph = pageData.blocks.find(block => segments[block.segmentIndex]?.source.startsWith('Regression evidence must prove'))!;
                expect(heading).toBeDefined(); expect(paragraph).toBeDefined();
                expect(heading.block.y + heading.block.height + heading.spaceBelow).toBeLessThan(paragraph.y);
                expect(heading.spaceBelow).toBeLessThan(12);
                expect(pageData.blocks.every(block => [block.x, block.y, block.width, block.height].every(Number.isFinite))).toBe(true);
                // v7 缺正文的旧快照在 v8 重解析后，新增正文不能抢占未变标题的人工校订。
                const oldSegments = segments.filter(segment => segment.source === 'Document Translation Example' || /^\d+\s/u.test(segment.source))
                    .map((segment, id) => ({...segment, id}));
                const translations = oldSegments.map(segment => `校订：${segment.source}`);
                const restored = restoreDocumentHistoryTranslations({parsed: {segments: oldSegments}, parsedVersion: 7, total: oldSegments.length, translations},
                    {fileName: 'sample.pdf', format: 'pdf', label: 'PDF', parts: [], segments}, 8);
                expect(restored[heading.block.segmentIndex]).toBe('校订：4 VISUAL INVARIANTS');
                expect(restored[paragraph.segmentIndex]).toBe('');
                expect(bytes).toEqual(before);
            } finally {page.cleanup();}
        } finally {await loading.destroy();}
    });

    it('retains source bytes, correct column reading order, headings and baseline superscripts', async () => {
        const bytes = await fixture(); const before = new Uint8Array(bytes);
        const parsed = await parseBinaryDocument('layout.pdf', bytes);
        expect(bytes).toEqual(before); expect(parsed.binary?.kind).toBe('pdf');
        if (parsed.binary?.kind !== 'pdf') return;
        expect(parsed.binary.bytes).toEqual(before);
        const page = parsed.binary.pages[0];
        const sources = page.segmentIndexes.map(index => parsed.segments[index].source);
        expect(sources[0]).toBe('1 Introduction');
        expect(sources.findIndex(source => source.startsWith('Left second'))).toBeLessThan(sources.findIndex(source => source.startsWith('Right column')));
        expect(sources.findIndex(source => source === '2 Left next section')).toBeLessThan(sources.findIndex(source => source === '4 Right section'));
        const text = page.blocks.filter(block => block.kind === 'text'); expect(text.every(block => block.textAlign === 'left')).toBe(true);
        expect(page.blocks[0]).toMatchObject({kind: 'heading', readingOrder: 0});
        const script = page.blocks.find(block => parsed.segments[block.segmentIndex]?.source.includes('representation'))!;
        expect(script.lines?.[0].runs?.some(run => run.text === 't' && (run.fontSize || 0) < script.fontSize)).toBe(true);
        expect(script.fontSize).toBeCloseTo(10);
    });
    it('uses actual graphics bounds for protected tables/images/formulas while retaining captions and prose', async () => {
        const parsed = await parseBinaryDocument('layout.pdf', await fixture());
        if (parsed.binary?.kind !== 'pdf') throw new Error('Expected actual PDF model');
        const page = parsed.binary.pages[1];
        expect(page.preservedRegions?.find(region => region.kind === 'table')).toMatchObject({x: 40, width: 520});
        expect(page.preservedRegions?.find(region => region.kind === 'figure')).toMatchObject({x: 400, y: 332, width: 100, height: 80});
        expect(page.preservedRegions?.find(region => region.kind === 'formula')?.source).toContain('F(x) = QK');
        const preserved = page.blocks.filter(block => ['formula', 'figure-label'].includes(block.kind || '') || (block.kind === 'table' && block.preserveSource));
        expect(preserved.length).toBeGreaterThan(0); expect(preserved.every(block => block.segmentIndex === -1 && block.preserveSource)).toBe(true);
        // 表头与文字单元格进入翻译队列，数字单元格不进入。
        const cells = page.blocks.filter(block => block.kind === 'table' && !block.preserveSource).map(block => parsed.segments[block.segmentIndex].source);
        expect(cells).toEqual(expect.arrayContaining(['Model', 'Value', 'Baseline']));
        const segments = page.segmentIndexes.map(index => parsed.segments[index].source);
        expect(segments.some(source => source.includes('24.9') || source.includes('F(x)'))).toBe(false);
        expect(segments).toContain('Table 1: unchanged measurements'); expect(segments).toContain('The prose after the table remains translatable.'); expect(segments).toContain('Figure 1: original diagram');
        const vector = parsed.binary.pages[2];
        expect(vector.preservedRegions?.find(region => region.kind === 'figure')).toMatchObject({x: 100, y: 192, width: 180, height: 100});
        expect(vector.blocks.find(block => block.kind === 'figure-label')?.segmentIndex).toBe(-1);
        expect(vector.segmentIndexes.map(index => parsed.segments[index].source)).toContain('Figure 2: vector geometry is retained');
    });
    it('opens a valid math-only text layer for source reading without creating provider segments, and opens graphic-only scans with nothing to translate yet', async () => {
        const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
        const page = pdf.addPage([612, 792]);
        page.drawText('F(x) = QK', {x: 220, y: 560, size: 12, font});
        const bytes = await pdf.save(); const before = new Uint8Array(bytes);
        const parsed = await parseBinaryDocument('formula.pdf', bytes);
        expect(parsed.segments).toEqual([]); expect(bytes).toEqual(before);
        if (parsed.binary?.kind !== 'pdf') throw new Error('Expected source-only PDF');
        expect(parsed.binary.pages[0].blocks).toMatchObject([{kind: 'formula', preserveSource: true, segmentIndex: -1}]);
        expect(parsed.binary.pages[0].preservedRegions?.[0].source).toBe('F(x) = QK');
        const scan = await PDFDocument.create(); scan.addPage([612, 792]).drawRectangle({x: 100, y: 500, width: 180, height: 100, color: rgb(.9, .7, .6)});
        // 只有图形的扫描页照常打开：没有片段也没有版面块，文字识别留给页面在开始翻译时进行。
        const scanned = await parseBinaryDocument('scanned.pdf', await scan.save());
        expect(scanned.segments).toEqual([]);
        expect(scanned.binary?.kind === 'pdf' && scanned.binary.pages[0].blocks).toEqual([]);
    });
});
