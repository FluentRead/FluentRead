/**
 * @file tests/pdfOcr.test.ts
 * 文件职责：验证扫描版 PDF 的逐页文字识别结果能重建成可翻译的段落，并与已有文字的页一起得到连续的片段编号。
 * 主要内容：只识别标记为扫描页的页（含旋转扫描页，空白页不识别），识别后取消标记，从阅读位置开始并回绕；识别行经版面分析合并成段落；已有文字页的块与片段原样保留并重排编号；空白与无效识别行被丢弃；进度逐页上报；取消与识别失败不改动原文档；没有可识别的页或不是 PDF 时原样返回。
 * 模块边界：识别器由测试注入，不渲染页面也不加载识别引擎；版面规则本身由版面分析测试覆盖。
 */
import {describe, expect, it, vi} from 'vitest';
import type {ParsedDocument, PdfDocumentBlock, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {pdfPagesNeedingOcr, recognizePdfDocument, remapPdfTranslationState, type PdfOcrLine} from '@/src/features/document-translation/services/pdfOcr';

const block = (segmentIndex: number, overrides: Partial<PdfDocumentBlock> = {}): PdfDocumentBlock => ({segmentIndex, x: 50, y: 60, width: 300, height: 12, fontSize: 10, lineHeight: 12, lineCount: 1, fontFamily: 'serif', fontWeight: 400, textAlign: 'left', ...overrides});
// 没有版面块的页默认是扫描页；需要空白页时显式传入 scanned: false。
const page = (pageNumber: number, blocks: PdfDocumentBlock[] = [], extra: Partial<PdfDocumentPage> = {}): PdfDocumentPage => ({pageNumber, width: 600, height: 800, segmentIndexes: blocks.filter(entry => entry.segmentIndex >= 0).map(entry => entry.segmentIndex), blocks, ...(blocks.length ? {} : {scanned: true}), ...extra});
const pdf = (pages: PdfDocumentPage[], sources: string[] = []): ParsedDocument => ({fileName: 'scan.pdf', format: 'pdf', label: 'PDF', parts: [],
    segments: sources.map((source, id) => ({id, source, role: 'paragraph' as const})), binary: {kind: 'pdf', bytes: new Uint8Array([1, 2, 3]), pages}} as unknown as ParsedDocument);
const paragraph = (tag: string): PdfOcrLine[] => [0, 1, 2].map(row => ({text: `${tag} line ${row} is a complete recognised line of ordinary body text`, x: 60, y: 100 + row * 14, width: 440, height: 12}));

describe('scanned PDF recognition', () => {
    it.each([true, false])('keeps column paragraphs whole despite ink-height variation and orders separated small footnotes after body (note=%s)', async note => {
        const left = ['The method preserves local structure and separates', 'adjacent columns. Paragraph boundaries matter because a', 'translation must preserve the relationship between', 'observations and conclusions.'];
        const right = ['Right column begins with independent results and', 'compares experiments under several conditions.', 'The measurements remain available for inspection.', 'Future studies will examine different populations.'];
        const lines: PdfOcrLine[] = [left, right].flatMap((text, column) => text.map((text, row) => ({text,
            x: 48 + column * 264, y: 150 + row * 14, width: row === 3 ? 120 : 230, height: column === 0 && row === 3 ? 7 : 9,
            fontSize: 9, baseline: 158 + row * 14,
        })));
        if (note) lines.push({text: 'Small footnote describes the experimental setting.', x: 48, y: 750, width: 220, height: 7, fontSize: 7, baseline: 756});
        const result = await recognizePdfDocument(pdf([page(1)]), async () => lines);
        const sources = result.segments.map(segment => segment.source);
        expect(sources).toEqual([left.join(' '), right.join(' '), ...(note ? ['Small footnote describes the experimental setting.'] : [])]);
    });

    it('keeps valid page checkpoints across a later failure and retries only unfinished pages', async () => {
        const source = pdf([page(1), page(2), page(3, [block(0)])], ['Native source']);
        let checkpoint = source;
        const onCheckpoint = vi.fn((value: ParsedDocument) => {checkpoint = value;});
        const recognize = vi.fn(async ({pageNumber}: {pageNumber: number}) => {
            if (pageNumber === 2) throw new Error('page two unavailable');
            return paragraph('First');
        });
        await expect(recognizePdfDocument(source, recognize, {onCheckpoint})).rejects.toThrow('page two unavailable');
        expect(onCheckpoint).toHaveBeenCalledOnce();
        expect(pdfPagesNeedingOcr(checkpoint)).toEqual([1]);
        expect(pdfPagesNeedingOcr(source)).toEqual([0, 1]);
        const before = JSON.stringify(checkpoint);
        const retry = vi.fn(async (_input: unknown) => paragraph('Second'));
        const complete = await recognizePdfDocument(checkpoint, retry);
        expect(retry).toHaveBeenCalledOnce();
        expect(retry.mock.calls[0][0]).toMatchObject({pageNumber: 2});
        expect(complete.segments.map(segment => segment.source.split(' ')[0])).toEqual(['First', 'Second', 'Native']);
        expect(JSON.stringify(checkpoint)).toBe(before);
        expect(remapPdfTranslationState(checkpoint, complete, ['OCR correction', 'Native correction'], [0, 1]))
            .toEqual({translations: ['OCR correction', '', 'Native correction'], confirmedTranslationIds: [0, 2]});
    });

    it('publishes no canceled or invalid page, preserves empty pages and still reports attempted progress', async () => {
        const source = pdf([page(1), page(2), page(3)]);
        const progress = vi.fn(), checkpoint = vi.fn();
        const result = await recognizePdfDocument(source, async ({pageNumber}) => pageNumber === 2 ? paragraph('Middle') : [
            {text: 'bad', x: NaN, y: 0, width: 20, height: 10},
            {text: 'bad', x: 0, y: 0, width: Infinity, height: 10},
            {text: 'outside', x: 900, y: 900, width: 20, height: 10},
        ], {onCheckpoint: checkpoint, onProgress: progress});
        expect(pdfPagesNeedingOcr(result)).toEqual([0, 2]);
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(result).toBe(checkpoint.mock.calls[0][0]);
        expect(progress.mock.calls.map(([value]) => value.completed)).toEqual([0, 1, 2, 3]);
        const abort = new AbortController();
        await expect(recognizePdfDocument(source, async () => {abort.abort(); return paragraph('Late');},
            {signal: abort.signal, onCheckpoint: checkpoint})).rejects.toMatchObject({name: 'AbortError'});
        expect(checkpoint).toHaveBeenCalledOnce();
        const blank = await recognizePdfDocument(source, async () => []);
        expect(blank).toBe(source);
    });

    it('clips edge OCR geometry and keeps native margin corrections on still-empty scan pages', async () => {
        const source = pdf([page(1), page(2, [block(0)], {scanned: true})], ['Native heading']);
        const result = await recognizePdfDocument(source, async ({pageNumber}) => pageNumber === 1
            ? [{text: 'Edge paragraph remains within its page', x: -5, y: -2, width: 610, height: 20}] : []);
        const first = (result.binary as {pages: PdfDocumentPage[]}).pages[0].blocks[0];
        expect(first.x).toBeGreaterThanOrEqual(0);
        expect(first.x + first.width).toBeLessThanOrEqual(600);
        expect(pdfPagesNeedingOcr(result)).toEqual([1]);
        expect(remapPdfTranslationState(source, result, ['Confirmed heading'], [0]))
            .toEqual({translations: ['Confirmed heading'], confirmedTranslationIds: [0]});
    });
    it('lists scanned PDF pages, rotated ones included', () => {
        // 文字页和空白页不识别；夹在文字页之间的扫描页、旋转的扫描页都要识别。
        expect(pdfPagesNeedingOcr(pdf([page(1, [block(0)]), page(2), page(3, [], {rotation: 90}), page(4), page(5, [], {scanned: false})], ['kept']))).toEqual([1, 2, 3]);
        expect(pdfPagesNeedingOcr({fileName: 'a.txt', format: 'txt', segments: [], parts: []} as unknown as ParsedDocument)).toEqual([]);
        expect(pdfPagesNeedingOcr(null)).toEqual([]);
    });

    it('recognises from the reading position, rebuilds paragraphs and renumbers every segment in page order', async () => {
        const source = pdf([page(1), page(2, [block(0), block(-1, {kind: 'formula', preserveSource: true}), block(1, {y: 200})]), page(3), page(4, [], {rotation: 180, scanned: false})], ['existing first', 'existing second']);
        const before = JSON.stringify(source);
        const recognize = vi.fn(async ({pageNumber}: {pageNumber: number}) => pageNumber === 1
            ? [...paragraph('First'), {text: '   ', x: 60, y: 300, width: 40, height: 12}, {text: 'ghost', x: 60, y: 320, width: 0, height: 12}, {text: 'flat', x: 60, y: 340, width: 40, height: 0}]
            : [{text: 'A  short\nheading', x: 60, y: 80, width: 120, height: 22}, ...paragraph('Third')]);
        const progress: Array<[number, number]> = [];
        const result = await recognizePdfDocument(source, recognize, {startPage: 2, onProgress: ({completed, total}) => progress.push([completed, total])});
        // 从第 3 页（下标 2）开始，回绕到第 1 页；已有文字的页和空白页不识别。
        expect(recognize.mock.calls.map(([input]) => input.pageNumber)).toEqual([3, 1]);
        expect(recognize.mock.calls[0][0]).toMatchObject({width: 600, height: 800, bytes: new Uint8Array([1, 2, 3])});
        expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
        expect(result.segments.map(segment => [segment.id, segment.source.slice(0, 22)])).toEqual([
            [0, 'First line 0 is a comp'], [1, 'existing first'], [2, 'existing second'], [3, 'A short heading'], [4, 'Third line 0 is a comp'],
        ]);
        const pages = (result.binary as {pages: PdfDocumentPage[]}).pages;
        expect(pages.map(entry => entry.segmentIndexes)).toEqual([[0], [1, 2], [3, 4], []]);
        // 三行识别结果并成一个段落；已有文字页保留公式块与原来的几何。
        expect(pages[0].blocks).toHaveLength(1);
        expect(pages[0].blocks[0]).toMatchObject({segmentIndex: 0, lineCount: 3});
        expect(pages[1].blocks.map(entry => [entry.segmentIndex, entry.kind, entry.y])).toEqual([[1, undefined, 60], [-1, 'formula', 60], [2, undefined, 200]]);
        expect(pages[2].blocks.find(entry => entry.segmentIndex === 3)?.kind).toBe('heading');
        // 识别过的页不再是扫描页，已有文字的页与空白页的标记不变。
        expect(pages.map(entry => entry.scanned)).toEqual([false, undefined, false, false]);
        expect(pages.map(entry => [entry.rotation, entry.sourceRotation])).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined], [180, undefined]]);
        expect(pdfPagesNeedingOcr(result)).toEqual([]);
        expect(JSON.stringify(source)).toBe(before);
    });

    it('recognises a rotated scan in its display orientation and keeps the page angle only for export', async () => {
        // 展示方向是 800×600 的横页；识别器收到展示尺寸，返回的也是展示坐标。
        const source = pdf([{...page(1, [], {rotation: 90}), width: 800, height: 600}]);
        const recognize = vi.fn(async (_input: unknown) => paragraph('Sideways'));
        const result = await recognizePdfDocument(source, recognize);
        expect((recognize.mock.calls as any[])[0][0]).toMatchObject({pageNumber: 1, width: 800, height: 600});
        const [recognised] = (result.binary as {pages: PdfDocumentPage[]}).pages;
        expect(recognised).toMatchObject({width: 800, height: 600, sourceRotation: 90, scanned: false, segmentIndexes: [0]});
        expect('rotation' in recognised).toBe(false);
        expect(recognised.blocks[0]).toMatchObject({segmentIndex: 0, lineCount: 3, x: 60});
        expect(pdfPagesNeedingOcr(result)).toEqual([]);
    });

    it('starts from the first empty page by default and returns the same document when nothing needs recognition', async () => {
        const recognize = vi.fn(async () => paragraph('Only'));
        const result = await recognizePdfDocument(pdf([page(1), page(2)]), recognize);
        expect(recognize.mock.calls.map(([input]: any) => input.pageNumber)).toEqual([1, 2]);
        expect(result.segments).toHaveLength(2);
        // 阅读位置在所有待识别页之后时，从头开始。
        const late = vi.fn(async () => paragraph('Late'));
        await recognizePdfDocument(pdf([page(1), page(2), page(3, [block(0)])], ['kept']), late, {startPage: 2});
        expect(late.mock.calls.map(([input]: any) => input.pageNumber)).toEqual([1, 2]);
        const complete = pdf([page(1, [block(0)])], ['kept']);
        expect(await recognizePdfDocument(complete, recognize)).toBe(complete);
        const text = {fileName: 'a.txt', format: 'txt', segments: [], parts: []} as unknown as ParsedDocument;
        expect(await recognizePdfDocument(text, recognize)).toBe(text);
    });

    it('stops on cancellation or a recogniser failure', async () => {
        const controller = new AbortController();
        const recognize = vi.fn(async ({pageNumber, signal}: {pageNumber: number; signal?: AbortSignal}) => {expect(signal).toBe(controller.signal); if (pageNumber === 1) controller.abort(); return paragraph('Any');});
        await expect(recognizePdfDocument(pdf([page(1), page(2)]), recognize, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(recognize).toHaveBeenCalledTimes(1);
        const aborted = new AbortController(); aborted.abort();
        await expect(recognizePdfDocument(pdf([page(1)]), recognize, {signal: aborted.signal})).rejects.toMatchObject({name: 'AbortError'});
        await expect(recognizePdfDocument(pdf([page(1)]), async () => {throw new Error('engine missing');})).rejects.toThrow('engine missing');
    });

    it('remaps retained translations by native page and block through inserted OCR segments, including repeated source text', async () => {
        const source = pdf([page(1), page(2, [block(0), block(-1), block(1, {y: 200})]), page(3),
            page(4, [block(2), block(3, {y: 200})])], ['Repeated passage', 'Repeated passage', 'Repeated passage', 'Untranslated']);
        const translations = ['First human correction', 'Existing machine translation', 'Second human correction'];
        const confirmed = [0, 2, 3, 99];
        const recognized = await recognizePdfDocument(source, async () => [{text: 'Repeated passage', x: 60, y: 100, width: 300, height: 12}]);
        const before = JSON.stringify({source, recognized, translations, confirmed});
        expect(remapPdfTranslationState(source, recognized, translations, confirmed)).toEqual({
            translations: ['', 'First human correction', 'Existing machine translation', '', 'Second human correction', ''],
            confirmedTranslationIds: [1, 4],
        });
        expect(JSON.stringify({source, recognized, translations, confirmed})).toBe(before);
    });

    it.each(['previous-kind', 'next-kind', 'previous-missing', 'next-missing'] as const)('does not apply PDF IDs to %s documents', kind => {
        const source = pdf([page(1, [block(0)])], ['source']);
        const next = structuredClone(source);
        if (kind === 'previous-kind') source.binary = {kind: 'docx'} as any;
        if (kind === 'next-kind') next.binary = {kind: 'docx'} as any;
        if (kind === 'previous-missing') source.binary = undefined;
        if (kind === 'next-missing') next.binary = undefined;
        expect(remapPdfTranslationState(source, next, ['human'], [0])).toEqual({translations: [], confirmedTranslationIds: []});
    });

    it.each([0, 1, 2])('retains native identities with an OCR page before, between or after native pages (index %s)', async position => {
        const pages = [page(0, [block(0)]), page(0, [block(1)])];
        pages.splice(position, 0, page(0));
        pages.forEach((entry, index) => {entry.pageNumber = index + 1;});
        const source = pdf(pages, ['Same original', 'Same original']);
        const recognized = await recognizePdfDocument(source, async () => paragraph('Inserted'));
        const translations = ['First human correction', 'Existing machine translation'];
        translations.splice(position, 0, '');
        expect(remapPdfTranslationState(source, recognized, ['First human correction', 'Existing machine translation'], [0]))
            .toEqual({translations, confirmedTranslationIds: [position === 0 ? 1 : 0]});
    });

    it.each(['missing-page', 'missing-block', 'preserved-target', 'missing-source', 'missing-target', 'changed-source', 'changed-geometry'] as const)(
        'does not transfer a correction when the native identity has %s', mismatch => {
            const source = pdf([page(1, [block(0)])], ['source']);
            const next = structuredClone(source);
            const oldPage = (source.binary as any).pages[0];
            const nextPage = (next.binary as any).pages[0];
            if (mismatch === 'missing-page') nextPage.pageNumber = 2;
            if (mismatch === 'missing-block') nextPage.blocks = [];
            if (mismatch === 'preserved-target') nextPage.blocks[0].segmentIndex = -1;
            if (mismatch === 'missing-source') oldPage.blocks[0].segmentIndex = 99;
            if (mismatch === 'missing-target') nextPage.blocks[0].segmentIndex = 99;
            if (mismatch === 'changed-source') next.segments[0].source = 'different';
            if (mismatch === 'changed-geometry') nextPage.blocks[0].x += 1;
            expect(remapPdfTranslationState(source, next, ['human'], [0])).toEqual({translations: [''], confirmedTranslationIds: []});
        },
    );
});
