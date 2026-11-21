/**
 * @file tests/pdfPaperLayouts.test.ts
 * 文件职责：用现场生成的典型论文版式 PDF 回归“真实解析 + 版面分析”的整条链路，防止后续调整分段规则时把常见论文格式改坏。
 * 主要内容：以 pdf-lib 按真实字体度量排出单栏 LaTeX 文章、双栏会议论文（罗马数字章节、图与图注、表与表题、脚注、页眉页码）、双倍行距投稿稿件和悬挂缩进的参考文献页，经 PDF.js 解析后逐项断言送翻片段的文字与顺序、标题与题注的归类、公式和页眉页脚保持原样、双栏先左后右的阅读顺序；另提供按环境变量启用的本地论文目录检查，只核对与内容无关的结构不变量。
 * 模块边界：夹具文字均为测试自拟，不含任何真实论文内容；不启动浏览器、不调用翻译服务，译文叠放与选区由真实浏览器脚本覆盖。
 */
import {readdirSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PDFDocument, PDFString, StandardFonts, degrees, rgb, type PDFFont, type PDFPage} from 'pdf-lib';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {ParsedDocument, PdfDocumentBlock} from '@/src/features/document-translation/core/document';
import {parseBinaryDocument} from '@/src/features/document-translation/services/binary';
import {configurePdfResources} from '@/src/features/document-translation/services/pdfResources';
import {buildPdfReadingPlan} from '@/src/features/document-translation/core/pdfReadingPlan';

interface Fonts {serif: PDFFont; bold: PDFFont; italic: PDFFont; sans: PDFFont}
interface Sheet {page: PDFPage; fonts: Fonts; height: number}

/** 按字体度量贪心分行。 */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(next, size) > width) {lines.push(line); line = word;} else line = next;
    }
    lines.push(line);
    return lines;
}

/**
 * 画一个两端对齐的段落：除末行外每行都用词间距撑满栏宽，与 LaTeX、Word 的正文排版一致。
 * baseline 以页面顶部为原点；返回下一行的基线位置。
 */
function paragraph(sheet: Sheet, text: string, x: number, baseline: number, width: number, options: {size?: number; leading?: number; font?: PDFFont; indent?: number; hang?: number} = {}): number {
    const size = options.size ?? 10, leading = options.leading ?? size * 1.2, font = options.font ?? sheet.fonts.serif;
    const indent = options.indent ?? 0, hang = options.hang ?? 0;
    const first = wrap(text, font, size, width - indent)[0];
    const rest = text.slice(first.length).trim();
    const lines = [first, ...(rest ? wrap(rest, font, size, width - hang) : [])];
    lines.forEach((line, index) => {
        const offset = index === 0 ? indent : hang;
        const gaps = line.split(' ').length - 1;
        const slack = width - offset - font.widthOfTextAtSize(line, size);
        sheet.page.drawText(line, {x: x + offset, y: sheet.height - baseline - index * leading, size, font,
            ...(index < lines.length - 1 && gaps ? {wordSpacing: slack / gaps} : {})});
    });
    return baseline + lines.length * leading;
}

function centered(sheet: Sheet, text: string, baseline: number, size: number, font: PDFFont, left = 0, width = sheet.page.getWidth()): void {
    sheet.page.drawText(text, {x: left + (width - font.widthOfTextAtSize(text, size)) / 2, y: sheet.height - baseline, size, font});
}

async function build(draw: (sheet: Sheet, addPage: () => Sheet) => void, size: [number, number] = [612, 792]): Promise<ParsedDocument> {
    const pdf = await PDFDocument.create();
    const fonts: Fonts = {serif: await pdf.embedFont(StandardFonts.TimesRoman), bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
        italic: await pdf.embedFont(StandardFonts.TimesRomanItalic), sans: await pdf.embedFont(StandardFonts.Helvetica)};
    const addPage = (): Sheet => ({page: pdf.addPage(size), fonts, height: size[1]});
    draw(addPage(), addPage);
    return parseBinaryDocument('paper.pdf', await pdf.save());
}

const sentence = (topic: string, count: number) => Array.from({length: count}, (_, index) =>
    `The ${topic} study reports result number ${index + 1} with enough ordinary words to fill a justified line of body text.`).join(' ');
const pages = (document: ParsedDocument) => document.binary?.kind === 'pdf' ? document.binary.pages : [];
const sources = (document: ParsedDocument) => document.segments.map(segment => segment.source);
const blockOf = (document: ParsedDocument, start: string, page = 0): PdfDocumentBlock & {source?: string} => {
    const found = pages(document)[page].blocks.find(block => (block.segmentIndex >= 0 ? document.segments[block.segmentIndex].source : (block as {source?: string}).source ?? '').startsWith(start));
    if (!found) throw new Error(`没有以“${start}”开头的版面块`);
    return found;
};
/** 与内容无关的结构不变量：可翻译块互不重叠、没有被拆散的碎片、片段文字非空且不重复出现在两个块里。 */
function expectSoundStructure(document: ParsedDocument): void {
    for (const page of pages(document)) {
        const translatable = page.blocks.filter(block => block.segmentIndex >= 0);
        translatable.forEach((block, index) => translatable.slice(index + 1).forEach(other => {
            const width = Math.min(block.x + block.width, other.x + other.width) - Math.max(block.x, other.x);
            const height = Math.min(block.y + block.height, other.y + other.height) - Math.max(block.y, other.y);
            const overlapping = width > 2 && height > 2 && width * height > 0.2 * Math.min(block.width * block.height, other.width * other.height);
            expect(overlapping, `第 ${page.pageNumber} 页有两个可翻译块互相重叠：${document.segments[block.segmentIndex].source.slice(0, 40)} / ${document.segments[other.segmentIndex].source.slice(0, 40)}`).toBe(false);
        }));
        expect(new Set(page.segmentIndexes).size).toBe(page.segmentIndexes.length);
    }
    for (const source of sources(document)) expect(source.trim().length).toBeGreaterThan(0);
}

describe('common paper layouts survive real PDF parsing', () => {
    beforeAll(() => {
        const resolve = createRequire(import.meta.url).resolve;
        configurePdfResources({assetRoot: dirname(resolve('pdfjs-dist/package.json')),
            workerUrl: pathToFileURL(resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href});
    });
    afterAll(() => configurePdfResources());

    it.each([90, 180, 270] as const)('recovers physically turned source text when the PDF display rotation is %i degrees', async rotation => {
        const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman), sheet = pdf.addPage([612, 792]);
        sheet.setRotation(degrees(rotation));
        const source = 'Source native report text remains complete in its displayed reading direction.';
        sheet.drawText(source, {x: rotation === 90 ? 100 : 500, y: rotation === 90 ? 50 : rotation === 180 ? 100 : 740, font, size: 10, rotate: degrees(rotation)});
        const document = await parseBinaryDocument('turned-report.pdf', await pdf.save());
        expect(sources(document)).toContain(source);
        expect(pages(document)[0]).toMatchObject({sourceRotation: rotation});
        expect(pages(document)[0].rotation).toBeUndefined();
        expect(pages(document)[0].blocks[0].width).toBeGreaterThan(pages(document)[0].blocks[0].height * 10);
        expect(buildPdfReadingPlan(document, pages(document)[0], []).entries.some(entry => entry.kind === 'text' && entry.text === source)).toBe(true);
    });
    it.each([0, 90, 180, 270] as const)('keeps ordinary horizontal source text in canonical coordinates when only display metadata is %i degrees', async rotation => {
        const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman), sheet = pdf.addPage([612, 792]);
        sheet.setRotation(degrees(rotation));
        const source = 'Ordinary source paragraph retains its original coordinates and complete words.';
        sheet.drawText(source, {x: 54, y: 700, font, size: 10});
        const document = await parseBinaryDocument('metadata-turn.pdf', await pdf.save());
        expect(sources(document)).toContain(source);
        expect(pages(document)[0].rotation ?? 0).toBe(rotation);
        expect(pages(document)[0].sourceRotation).toBeUndefined();
        expect(pages(document)[0].blocks[0].x).toBeCloseTo(54);
    });
    it('retains a detached bottom footnote and source-only byline through PDF.js and the canonical reading plan', async () => {
        const footnote = '1 This bottom footnote must remain available for translation and reading.';
        const document = await build(sheet => {
            centered(sheet, 'An Example Article for Source Preservation', 100, 17, sheet.fonts.serif);
            centered(sheet, 'Ada Example, Bo Sample', 130, 12, sheet.fonts.serif);
            paragraph(sheet, sentence('body', 4), 54, 200, 240);
            sheet.page.drawLine({start: {x: 54, y: sheet.height - 748}, end: {x: 134, y: sheet.height - 748}, thickness: .5});
            paragraph(sheet, footnote, 54, 765, 490, {size: 8, leading: 9});
            centered(sheet, '8', 785, 8, sheet.fonts.serif);
        });
        expect(sources(document)).toContain(footnote);
        expect(blockOf(document, footnote)).toMatchObject({kind: 'text', preserveSource: false});
        const plan = buildPdfReadingPlan(document, pages(document)[0], []);
        const text = plan.entries.filter(entry => entry.kind === 'text');
        expect(text.map(entry => entry.text)).toEqual(expect.arrayContaining(['Ada Example, Bo Sample', footnote, '8']));
        expect(new Set(plan.entries.map(entry => entry.id)).size).toBe(plan.entries.length);
        expectSoundStructure(document);
    });
    it('single-column LaTeX article: title, byline, abstract, numbered sections, display equation, footnote and page number', async () => {
        const abstract = sentence('abstract', 4), first = sentence('opening', 5), second = sentence('follow-up', 4);
        const document = await build(sheet => {
            const {fonts} = sheet;
            centered(sheet, 'A Careful Study of Layout Preserving Translation', 110, 17, fonts.serif);
            centered(sheet, 'Ada Example, Bo Sample, Cy Placeholder', 138, 12, fonts.serif);
            centered(sheet, 'Abstract', 180, 10, fonts.bold);
            paragraph(sheet, abstract, 126, 196, 360, {size: 9, leading: 11});
            sheet.page.drawText('1  Introduction', {x: 90, y: sheet.height - 290, size: 14, font: fonts.bold});
            let y = paragraph(sheet, first, 90, 312, 432);
            y = paragraph(sheet, second, 90, y, 432, {indent: 15});
            centered(sheet, 'E = mc2', y + 14, 10, fonts.italic);
            sheet.page.drawText('(1)', {x: 508, y: sheet.height - y - 14, size: 10, font: fonts.serif});
            sheet.page.drawText('2  Method', {x: 90, y: sheet.height - y - 50, size: 14, font: fonts.bold});
            paragraph(sheet, sentence('method', 3), 90, y + 72, 432);
            paragraph(sheet, 'This footnote explains a detail of the experimental protocol in small type.', 90, 700, 432, {size: 8, leading: 9.5});
            centered(sheet, '1', 752, 10, fonts.serif);
        });
        expect(sources(document)).toEqual(['A Careful Study of Layout Preserving Translation', 'Abstract', abstract, '1 Introduction', first, second, '2 Method', sentence('method', 3),
            'This footnote explains a detail of the experimental protocol in small type.']);
        expect(blockOf(document, 'A Careful Study').kind).toBe('heading');
        expect(blockOf(document, '1 Introduction').kind).toBe('heading');
        expect(blockOf(document, '2 Method').kind).toBe('heading');
        // 作者署名、独立公式和页码保持原样，不占用翻译请求。
        expect(blockOf(document, 'Ada Example')).toMatchObject({kind: 'metadata', segmentIndex: -1});
        expect(pages(document)[0].blocks.some(block => block.kind === 'formula' && block.segmentIndex === -1)).toBe(true);
        expect(pages(document)[0].blocks.filter(block => block.kind === 'footer')).toHaveLength(1);
        expect(document.segments.filter(segment => segment.role === 'heading').map(segment => segment.source)).toEqual(['A Careful Study of Layout Preserving Translation', 'Abstract', '1 Introduction', '2 Method']);
        expectSoundStructure(document);
    });
    it('keeps wrapped bylines with detached accents and adjacent affiliation details out of PDF headings', async () => {
        const title = 'Measuring Query Performance on Large Datasets';
        const authorRows = ['Ada Example, Dario Agui ´rre,', 'Émile Sample, J ¨org Writer'];
        const affiliation = ['Computing Systems Group', 'Example University', 'research@example.org', 'https://example.org/lab'];
        const document = await build(sheet => {
            const {fonts, page, height} = sheet;
            centered(sheet, title, 84, 18, fonts.bold);
            authorRows.forEach((row, index) => centered(sheet, row, 125 + 18 * index, 12, fonts.sans));
            affiliation.forEach((row, index) => centered(sheet, row, 167 + 12 * index, 11.5, fonts.sans));
            page.drawText('ABSTRACT', {x: 54, y: height - 226, size: 12, font: fonts.bold});
            paragraph(sheet, sentence('abstract', 4), 54, 241, 238, {size: 8.5, leading: 10});
            page.drawText('1. INTRODUCTION', {x: 54, y: height - 344, size: 12, font: fonts.bold});
            paragraph(sheet, sentence('opening', 4), 54, 359, 238, {size: 8.5, leading: 10});
            paragraph(sheet, sentence('comparison', 8), 320, 226, 238, {size: 8.5, leading: 10});
        });
        const [page] = pages(document);
        expect(page.blocks.filter(block => block.kind === 'heading').map(block => document.segments[block.segmentIndex].source))
            .toEqual([title, 'ABSTRACT', '1. INTRODUCTION']);
        expect(page.blocks.filter(block => block.kind === 'metadata').flatMap(block => block.lines!.map(line => line.text)))
            .toEqual([...authorRows, ...affiliation]);
        expect(page.blocks.filter(block => block.kind === 'metadata').every(block => block.preserveSource && block.segmentIndex === -1)).toBe(true);
        const plan = buildPdfReadingPlan(document, page, []);
        const metadata = plan.entries.flatMap(entry => entry.kind === 'text' && entry.role === 'metadata' ? [entry.source] : []);
        expect(metadata.join(' ')).toBe([...authorRows, ...affiliation].join(' '));
    });

    it('two-column conference paper: Roman-numeral sections, figure and table captions, reading order, footnote, running header', async () => {
        const left = 54, right = 318, column = 240;
        const abstract = `Abstract-${sentence('summary', 3)}`, intro = sentence('introduction', 6), related = sentence('related', 4), method = sentence('approach', 5), results = sentence('evaluation', 4);
        const document = await build(sheet => {
            const {fonts, page, height} = sheet;
            centered(sheet, 'Proceedings of the Example Workshop on Documents', 30, 8, fonts.serif);
            centered(sheet, 'Reading Order Recovery for Two-Column Papers', 84, 20, fonts.serif);
            let y = paragraph(sheet, abstract, left, 150, column, {size: 9, leading: 10.5, font: fonts.bold});
            centered(sheet, 'I. INTRODUCTION', y + 14, 10, fonts.serif, left, column);
            y = paragraph(sheet, intro, left, y + 30, column, {indent: 10});
            centered(sheet, 'II. RELATED WORK', y + 12, 10, fonts.serif, left, column);
            y = paragraph(sheet, related, left, y + 28, column, {indent: 10});
            page.drawLine({start: {x: left, y: height - 716}, end: {x: left + 80, y: height - 716}, thickness: 0.5});
            paragraph(sheet, 'Manuscript received on a test date; this note carries the funding statement.', left, 728, column, {size: 8, leading: 9});
            // 右栏：插图（外框、坐标轴与小字标注）及图注，接着是正文、表题和三线表。
            page.drawRectangle({x: right, y: height - 300, width: column, height: 150, borderColor: rgb(0, 0, 0), borderWidth: 1});
            page.drawLine({start: {x: right + 30, y: height - 280}, end: {x: right + 220, y: height - 280}, thickness: 1});
            page.drawLine({start: {x: right + 30, y: height - 280}, end: {x: right + 30, y: height - 170}, thickness: 1});
            page.drawText('Latency', {x: right + 36, y: height - 176, size: 6, font: fonts.sans});
            page.drawText('Batch size', {x: right + 110, y: height - 292, size: 6, font: fonts.sans});
            let ry = paragraph(sheet, 'Fig. 1. Latency grows slowly with the batch size in every tested configuration.', right, 316, column, {size: 8, leading: 9.5});
            centered(sheet, 'III. METHOD', ry + 12, 10, fonts.serif, right, column);
            ry = paragraph(sheet, method, right, ry + 28, column, {indent: 10});
            centered(sheet, 'TABLE I', ry + 14, 8, fonts.serif, right, column);
            centered(sheet, 'SUMMARY OF THE MEASURED SETTINGS', ry + 24, 8, fonts.serif, right, column);
            for (const offset of [32, 46, 76]) page.drawLine({start: {x: right, y: height - ry - offset}, end: {x: right + column, y: height - ry - offset}, thickness: 0.6});
            page.drawText('Setting', {x: right + 6, y: height - ry - 42, size: 8, font: fonts.serif});
            page.drawText('Score', {x: right + 150, y: height - ry - 42, size: 8, font: fonts.serif});
            page.drawText('Baseline system', {x: right + 6, y: height - ry - 58, size: 8, font: fonts.serif});
            page.drawText('71.4', {x: right + 150, y: height - ry - 58, size: 8, font: fonts.serif});
            page.drawText('Proposed system', {x: right + 6, y: height - ry - 70, size: 8, font: fonts.serif});
            page.drawText('88.2', {x: right + 150, y: height - ry - 70, size: 8, font: fonts.serif});
            paragraph(sheet, results, right, ry + 96, column, {indent: 10});
            centered(sheet, '2', 760, 9, fonts.serif);
        });
        const order = sources(document);
        // 左栏整栏在右栏之前：摘要 → 引言 → 相关工作 → 脚注，然后才是图注、方法、表和结果。
        const position = (start: string) => order.findIndex(source => source.startsWith(start));
        const sequence = ['Reading Order Recovery', 'Abstract-', 'I. INTRODUCTION', intro.slice(0, 30), 'II. RELATED WORK', related.slice(0, 30), 'Fig. 1.', 'III. METHOD', method.slice(0, 30), 'TABLE I', results.slice(0, 30)].map(position);
        expect(sequence.every(index => index >= 0), `缺少片段：${JSON.stringify(sequence)} ${JSON.stringify(order.map(source => source.slice(0, 24)))}`).toBe(true);
        expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
        // 每个正文段落是完整的一个片段，栏与栏之间没有串行。
        for (const body of [abstract, intro, related, method, results]) expect(order).toContain(body);
        for (const heading of ['I. INTRODUCTION', 'II. RELATED WORK', 'III. METHOD']) expect(blockOf(document, heading).kind, heading).toBe('heading');
        expect(blockOf(document, 'Fig. 1.')).toMatchObject({kind: 'caption'});
        expect(order).toContain('Fig. 1. Latency grows slowly with the batch size in every tested configuration.');
        expect(blockOf(document, 'TABLE I').kind).toBe('caption');
        // 图内的小字坐标标注保留原样；表格里的文字单元格翻译、数字单元格保留。
        expect(order).not.toContain('Latency');
        expect(order).toEqual(expect.arrayContaining(['Baseline system', 'Proposed system', 'Setting']));
        expect(order).not.toContain('71.4');
        // 页眉与页码不送翻。
        expect(order.some(source => source.startsWith('Proceedings of the Example'))).toBe(false);
        expect(pages(document)[0].blocks.filter(block => block.kind === 'footer').length).toBeGreaterThanOrEqual(2);
        expect(order).toContain('Manuscript received on a test date; this note carries the funding statement.');
        expectSoundStructure(document);
    });

    it('double-spaced submission manuscript: every paragraph stays whole and headings stay separate', async () => {
        const first = sentence('manuscript', 4), second = sentence('revision', 4);
        const document = await build(sheet => {
            const {fonts} = sheet;
            centered(sheet, 'Double Spaced Manuscript Title', 100, 14, fonts.bold);
            sheet.page.drawText('Introduction', {x: 72, y: sheet.height - 150, size: 12, font: fonts.bold});
            let y = paragraph(sheet, first, 72, 178, 468, {size: 12, leading: 27.6, indent: 36});
            y = paragraph(sheet, second, 72, y, 468, {size: 12, leading: 27.6, indent: 36});
            centered(sheet, '3', 750, 12, fonts.serif);
        });
        expect(sources(document)).toEqual(['Double Spaced Manuscript Title', 'Introduction', first, second]);
        expectSoundStructure(document);
    });

    it('reference list with hanging indents: one block per entry, across two columns', async () => {
        const entry = (number: number) => `[${number}] A. Author and B. Writer, An invented reference title number ${number} about document layout, Journal of Test Fixtures, vol. ${number}, pp. 1-9, 2020.`;
        const document = await build(sheet => {
            sheet.page.drawText('REFERENCES', {x: 54, y: sheet.height - 80, size: 10, font: sheet.fonts.bold});
            let y = 98;
            for (let number = 1; number <= 5; number += 1) y = paragraph(sheet, entry(number), 54, y, 240, {size: 8, leading: 9.5, hang: 14});
            let ry = 80;
            for (let number = 6; number <= 10; number += 1) ry = paragraph(sheet, entry(number), 318, ry, 240, {size: 8, leading: 9.5, hang: 14});
        });
        expect(sources(document)).toEqual(['REFERENCES', ...Array.from({length: 10}, (_, index) => entry(index + 1))]);
        expect(blockOf(document, 'REFERENCES').kind).toBe('heading');
        expectSoundStructure(document);
    });

    it('keeps dense references with short URLs, numeric tails and capitalized continuations on their own entries', async () => {
        const left = [
            ['[52] An author. Proceedings of the example conference.', '742–755.'],
            ['[53] A separate entry ends with a journal name.', '2023. Distributed storage for production workloads.', '(2023).'],
        ];
        const right = [
            ['[70] An author. Extension for the database system.', 'https://example.org/project.'],
            ['[71] A study of data lake storage. https://example.org/data-lake-', 'storage-query-acceleration'],
            ['[72] Example Software. A portable embedded', 'Database using a columnar layout.'],
            ['[73] Other Authors. Journal of Systems 6 (2023),', '97–105.'],
        ];
        const document = await build(sheet => {
            for (const [entries, x] of [[left, 54], [right, 318]] as const) {
                let y = 90;
                for (const entry of entries) for (const [line, text] of entry.entries()) {
                    sheet.page.drawText(text, {x: x + (line === 0 ? 0 : 16), y: sheet.height - y, size: 7, font: sheet.fonts.serif});
                    y += 8;
                }
            }
            centered(sheet, '5675', 760, 9, sheet.fonts.serif);
        });
        expect(sources(document)).toEqual([...left, ...right].map(lines => lines.join(' ').replace('data-lake- storage-', 'data-lake-storage-')));
        expect(pages(document)[0].blocks.map(block => block.kind)).toEqual(['text', 'text', 'text', 'text', 'text', 'text', 'footer']);
        expectSoundStructure(document);
    });

    it('keeps right-aligned values separate from the adjoining section of a ruled table', async () => {
        const document = await build(sheet => {
            for (const [x, width, operation] of [[322, 89, 'Read'], [417, 139, 'Write']] as const) {
                const rightAligned = (text: string, baseline: number) => sheet.page.drawText(text,
                    {x: x + width - sheet.fonts.serif.widthOfTextAtSize(text, 8), y: sheet.height - baseline, font: sheet.fonts.serif, size: 8});
                for (let row = 0; row <= 4; row++) {
                    const y = sheet.height - 240 - row * 13;
                    sheet.page.drawLine({start: {x, y}, end: {x: x + width, y}, thickness: 0.5});
                    if (row === 4) break;
                    sheet.page.drawText(row === 0 ? 'Operation' : `${row}. ${operation} item`, {x, y: y - 9, font: sheet.fonts.serif, size: 8});
                    rightAligned(row === 0 ? 'Lat (ms)' : String(86 + row * 31), 249 + row * 13);
                }
            }
            sheet.page.drawText('Table 3: Cost of operations.', {x: 318, y: sheet.height - 304, font: sheet.fonts.bold, size: 9});
        });
        const table = pages(document)[0].blocks.filter(block => block.kind === 'table');
        expect(table.filter(block => block.preserveSource).map(block => block.source).sort()).toEqual(['117', '117', '148', '148', '179', '179']);
        const headers = table.filter(block => document.segments[block.segmentIndex]?.source === 'Lat (ms)');
        expect(headers).toHaveLength(2);
        expect(headers.every(block => block.textAlign === 'right' && block.cellBounds!.x < block.x)).toBe(true);
        expect(sources(document).some(value => /^(?:Lat \(ms\) Operation|\d{2,} \d\.)/u.test(value))).toBe(false);
        expectSoundStructure(document);
    });

    it('uses native link targets to reconnect typeset URLs while keeping the following words separate', async () => {
        const document = await build(sheet => {
            const entries = [
                {first: '[10] Research manual. https://docs.example.', next: 'org/storage/index/ Accessed in 2025.', url: 'https://docs.example.org/storage/index/'},
                {first: '[11] Public code repository. https:', next: '//example.net/a/project. Project page.', url: 'https://example.net/a/project'},
                {first: '[12] Research website. https://example.edu/', next: 'Published in 2024.', url: 'https://example.edu/'},
            ];
            for (const [index, entry] of entries.entries()) {
                const y = sheet.height - 90 - index * 16;
                sheet.page.drawText(entry.first, {x: 54, y, font: sheet.fonts.serif, size: 7});
                sheet.page.drawText(entry.next, {x: 70, y: y - 8, font: sheet.fonts.serif, size: 7});
                const {context} = sheet.page.doc;
                sheet.page.node.addAnnot(context.register(context.obj({Type: 'Annot', Subtype: 'Link',
                    Rect: [70, y - 9, 158, y - 1], A: {S: 'URI', URI: PDFString.of(entry.url)}})));
            }
        });
        expect(sources(document)).toEqual([
            '[10] Research manual. https://docs.example.org/storage/index/ Accessed in 2025.',
            '[11] Public code repository. https://example.net/a/project. Project page.',
            '[12] Research website. https://example.edu/ Published in 2024.',
        ]);
    });

    it('keeps each wrapped header over its own numeric cell in a three-rule table', async () => {
        const columns = [
            {x: 323, title: 'Baseline', next: '(unfiltered)', value: '34.1 s'},
            {x: 377, title: 'Full', next: 'decode', value: '19.3 s'},
            {x: 412, title: '+Selective', next: 'decode', value: '13.1 s (-32%)'},
            {x: 465, title: '+Late', next: 'analysis.', value: '5.0 s (-61%)'},
            {x: 513, title: '+Eval on', next: 'records', value: '0.4 s (-91%)'},
        ];
        const document = await build(sheet => {
            const {page, fonts, height} = sheet;
            for (const baseline of [257, 283, 299]) {
                const y = height - baseline;
                page.drawLine({start: {x: 318, y}, end: {x: 559, y}, thickness: 0.5});
            }
            for (const {x, title, next, value} of columns) {
                for (const [text, baseline] of [[title, 268], [next, 279], [value, 294]] as const) {
                    page.drawText(text, {x, y: height - baseline, size: 8, font: fonts.serif});
                }
            }
            page.drawText('Table 2: Example runtime for five configurations.', {x: 318, y: height - 309, size: 9, font: fonts.bold});
        });
        const cells = pages(document)[0].blocks.filter(block => block.kind === 'table');
        const headers = cells.filter(cell => !cell.preserveSource);
        const data = cells.filter(cell => cell.preserveSource);
        expect(headers.map(cell => cell.source)).toEqual(columns.map(column => `${column.title} ${column.next}`));
        expect(data.map(cell => cell.source)).toEqual(columns.map(column => column.value));
        expect(headers.map(cell => cell.cellBounds!.x)).toEqual(data.map(cell => cell.cellBounds!.x));
        expect(new Set(data.map(cell => cell.cellBounds!.x)).size).toBe(5);
        expectSoundStructure(document);
    });
    it('keeps a framed legend and paired numeric labels with their chart and translates the main caption', async () => {
        const caption = 'Figure 8. Measured runtime across configurations.';
        const document = await build(sheet => {
            const {page, fonts, height} = sheet;
            page.drawRectangle({x: 64, y: height - 98, width: 236, height: 18, borderWidth: 0.5, borderColor: rgb(0, 0, 0)});
            page.drawRectangle({x: 64, y: height - 171, width: 236, height: 70, borderWidth: 0.5, borderColor: rgb(0, 0, 0)});
            for (const [x, label] of [[76, 'Primary series'], [206, 'Control series']] as const) {
                page.drawLine({start: {x, y: height - 91}, end: {x: x + 12, y: height - 91}, thickness: 0.5});
                page.drawText(label, {x: x + 15, y: height - 92, size: 6, font: fonts.serif});
            }
            for (const x of [64, 190]) {
                page.drawRectangle({x, y: height - 171, width: 110, height: 70, borderWidth: 0.5, borderColor: rgb(0, 0, 0)});
                page.drawLine({start: {x: x + 8, y: height - 161}, end: {x: x + 103, y: height - 116}, thickness: 1});
            }
            page.drawText('(a) 8-GPU', {x: 102, y: height - 184, size: 8, font: fonts.serif});
            page.drawText('(b) 32-GPU', {x: 240, y: height - 184, size: 8, font: fonts.serif});
            page.drawText(caption, {x: 64, y: height - 200, size: 9, font: fonts.bold});
        });
        expect(sources(document)).toEqual([caption]);
        const labels = pages(document)[0].blocks.filter(block => block.kind === 'figure-label').map(block => block.source).join(' ');
        for (const label of ['Primary series', 'Control series', '(a) 8-GPU', '(b) 32-GPU']) expect(labels).toContain(label);
        expect(pages(document)[0].preservedRegions?.some(region => region.kind === 'figure'
            && region.source?.includes('Primary series') && region.source.includes('(b) 32-GPU'))).toBe(true);
    });

    // 本地真实论文的结构检查：把 FLUENTREAD_PDF_CORPUS 指向一个放有 PDF 的目录即可启用；论文本身不进入仓库。
    it.runIf(Boolean(process.env.FLUENTREAD_PDF_CORPUS))('local paper corpus keeps the structural invariants', async () => {
        const directory = process.env.FLUENTREAD_PDF_CORPUS!;
        const papers = readdirSync(directory).filter(file => file.toLowerCase().endsWith('.pdf'));
        expect(papers.length, 'PDF corpus must contain at least one paper').toBeGreaterThan(0);
        for (const name of papers) {
            const document = await parseBinaryDocument(name, new Uint8Array(readFileSync(join(directory, name))));
            expectSoundStructure(document);
            // 被拆散的正文表现为大量一两个词的“正文段落”；正常论文里这种碎片远少于十分之一。
            const body = pages(document).flatMap(page => page.blocks).filter(block => block.segmentIndex >= 0 && (block.kind ?? 'text') === 'text').map(block => document.segments[block.segmentIndex].source);
            const fragments = body.filter(source => source.trim().split(/\s+/u).length <= 2 && source.trim().length <= 12);
            expect(fragments.length, `${name} 的碎片段落：${JSON.stringify(fragments.slice(0, 12))}`).toBeLessThanOrEqual(Math.max(3, body.length * 0.1));
        }
    }, 600_000);
});
