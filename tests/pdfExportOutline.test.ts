import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {describe, expect, it, vi} from 'vitest';
import type {ParsedDocument, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {createPdfExportOutline} from '@/src/features/document-translation/services/pdfOutline';
import {createDocumentDownload} from '@/src/features/document-translation/services/binary';

const name = PDFName.of;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=', 'base64'));
async function fixture() {
    const source = await PDFDocument.create();
    for (let index = 0; index < 2; index++) source.addPage([600, 800]).drawText(`Original chapter ${index + 1}`);
    const pages: PdfDocumentPage[] = [0, 1].map(index => ({pageNumber: index + 1, width: 600, height: 800, segmentIndexes: index ? [2] : [0, 1],
        blocks: (index ? [2] : [0, 1]).map((segmentIndex, row) => ({segmentIndex, kind: 'heading', x: 40, y: 50 + row * 100, width: 300, height: 30,
            fontSize: 20, lineHeight: 24, lineCount: 1, fontFamily: 'sans-serif', fontWeight: 700, textAlign: 'left'}))}));
    const document: ParsedDocument = {fileName: 'chapters.pdf', format: 'pdf', label: 'PDF', parts: [],
        segments: ['1 Introduction', '1.1 Details', '2 Conclusion'].map((text, id) => ({id, source: text})),
        binary: {kind: 'pdf', bytes: await source.save(), pages}};
    return {source, document, pages};
}
const evidence = (file: string, data: Uint8Array) => {
    const directory = process.env.FLUENTREAD_PDF_EVIDENCE_DIR;
    if (directory) {mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, file), data);}
};
async function readOutline(bytes: Uint8Array) {
    const task = getDocument({data: bytes.slice(), isEvalSupported: false});
    try {
        const pdf = await task.promise;
        const read = async (items: NonNullable<Awaited<ReturnType<typeof pdf.getOutline>>>): Promise<any[]> => Promise.all(items.map(async item => {
            const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
            if (!destination) throw new Error('Expected an internal bookmark destination');
            return {title: item.title, page: await pdf.getPageIndex(destination[0]) + 1, x: destination[2], y: destination[3], children: await read(item.items)};
        }));
        return {pageCount: pdf.numPages, items: await read(await pdf.getOutline() ?? [])};
    } finally {await task.destroy();}
}

describe('downloaded PDF chapter outlines', () => {
    it('retains fully translated raster export when optional source-bookmark extraction encounters encryption', async () => {
        const {document} = await fixture();
        const load = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(new EncryptedPDFError());
        try {
            const result = await createDocumentDownload(document, ['导言', '细节', '总结'], 'translated', {pdfPageRasterizer: async () => png});
            expect((await readOutline(result.data as Uint8Array)).items.map(item => item.title)).toEqual(['导言', '总结']);
            const sourceError = new EncryptedPDFError(); load.mockRejectedValueOnce(sourceError);
            await expect(createDocumentDownload(document, ['导言', '细节', '总结'], 'bilingual', {pdfPageRasterizer: async () => png})).rejects.toBe(sourceError);
            const unexpected = new Error('Unrelated source failure'); load.mockRejectedValueOnce(unexpected);
            await expect(createDocumentDownload(document, ['导言', '细节', '总结'], 'translated', {pdfPageRasterizer: async () => png})).rejects.toBe(unexpected);
            load.mockRejectedValueOnce('Non-error source failure');
            await expect(createDocumentDownload(document, ['导言', '细节', '总结'], 'translated', {pdfPageRasterizer: async () => png})).rejects.toBe('Non-error source failure');
        } finally {load.mockRestore();}
    });
    it.each(['translated', 'bilingual'] as const)('writes translated hierarchical headings with source fallback in %s layout', async mode => {
        const {document} = await fixture();
        const result = await createDocumentDownload(document, ['第一章 导言', '', '第二章 总结'], mode, {pdfPageRasterizer: async () => png});
        const outline = await readOutline(result.data as Uint8Array), offset = mode === 'bilingual' ? 615 : 0;
        expect(outline).toEqual({pageCount: 2, items: [
            {title: '第一章 导言', page: 1, x: 40 + offset, y: 750, children: [{title: '1.1 Details', page: 1, x: 40 + offset, y: 650, children: []}]},
            {title: '第二章 总结', page: 2, x: 40 + offset, y: 750, children: []},
        ]});
        evidence(`outline-layout-${mode}.pdf`, result.data as Uint8Array);
    });

    it('maps headings to actual reflow pages after source pages, including a heading on a later continuation', async () => {
        const {document} = await fixture();
        const result = await createDocumentDownload(document, ['导言', '细节', '总结'], 'bilingual', {
            pdfPresentation: 'readable', pdfReadingRasterizer: async function* (input) {
                for (const segmentIndex of input.pageNumber === 1 ? [0, 1] : [2]) yield {bytes: png, width: 612, height: 792,
                    textItems: [{segmentIndex, text: input.translations[segmentIndex], x: 42, y: 70, width: 80, fontSize: 16}]};
            },
        });
        const outline = await readOutline(result.data as Uint8Array);
        expect(outline.pageCount).toBe(5);
        expect(outline.items.map(item => [item.title, item.page])).toEqual([['导言', 2], ['总结', 5]]);
        expect(outline.items[0].children[0]).toMatchObject({title: '细节', page: 3, x: 42, y: 722});
    });

    it('preserves original native bookmarks, nested names, legacy destinations and internal GoTo actions', async () => {
        const {source, document, pages} = await fixture();
        const root = source.context.obj({Type: 'Outlines'}), rootRef = source.context.register(root);
        const parent = source.context.obj({Title: PDFHexString.fromText('1 Introduction'), Parent: rootRef, Dest: [source.getPage(0).ref, name('Fit')]}), parentRef = source.context.register(parent);
        const child = source.context.obj({Title: PDFString.of('Custom native child'), Parent: parentRef, A: {S: 'GoTo', D: PDFString.of('chapter-two')}}), childRef = source.context.register(child);
        const last = source.context.obj({Title: PDFHexString.fromText('原有附录 📖'), Parent: rootRef, Dest: name('legacy')}), lastRef = source.context.register(last);
        root.set(name('First'), parentRef); root.set(name('Last'), lastRef); root.set(name('Count'), PDFNumber.of(3));
        parent.set(name('First'), childRef); parent.set(name('Last'), childRef); parent.set(name('Count'), PDFNumber.of(1)); parent.set(name('Next'), lastRef);
        source.catalog.set(name('Outlines'), rootRef);
        source.catalog.set(name('Names'), source.context.obj({Dests: {Kids: [{Names: [PDFString.of('chapter-two'), {D: [source.getPage(1).ref, name('Fit')]}]}]}}));
        source.catalog.set(name('Dests'), source.context.obj({legacy: [source.getPage(1).ref, name('Fit')]}));
        if (document.binary?.kind !== 'pdf') throw new Error('PDF expected');
        document.binary.bytes = await source.save();
        const output = await PDFDocument.create(), outline = createPdfExportOutline(source, output, document, ['导言', '', '总结']);
        outline.layoutPage(pages[0], output.addPage([600, 800]));
        output.addPage(); // An inserted overflow page must not shift chapter destinations to the wrong page.
        outline.layoutPage(pages[1], output.addPage([600, 800])); outline.write();
        const bytes = await output.save();
        const saved = await PDFDocument.load(bytes), savedRoot = saved.catalog.lookup(name('Outlines'), PDFDict);
        const first = savedRoot.lookup(name('First'), PDFDict), savedLast = savedRoot.lookup(name('Last'), PDFDict);
        expect(savedRoot.lookup(name('Count'), PDFNumber).asNumber()).toBe(3);
        expect(first.lookup(name('Count'), PDFNumber).asNumber()).toBe(1);
        expect(first.lookup(name('Dest'), PDFArray).get(0)).toBe(saved.getPage(0).ref);
        expect(savedLast.get(name('Prev'))).toBe(savedRoot.get(name('First')));
        expect(first.lookup(name('First'), PDFDict).get(name('Parent'))).toBe(savedRoot.get(name('First')));
        expect((await readOutline(bytes)).items).toEqual([
            {title: '导言', page: 1, x: 40, y: 750, children: [{title: 'Custom native child', page: 3, x: 0, y: 800, children: []}]},
            {title: '原有附录 📖', page: 3, x: 0, y: 800, children: []},
        ]);
        evidence('outline-native-hierarchy.pdf', bytes);
    });

    it.each([0, 90, 180, 270] as const)('rotates layout destinations with the actual translated page at %s degrees', async rotation => {
        const {source, document, pages} = await fixture();
        const pageData = {...pages[0], rotation, width: rotation === 90 || rotation === 270 ? 800 : 600, height: rotation === 90 || rotation === 270 ? 600 : 800};
        const output = await PDFDocument.create(), page = output.addPage([pageData.width * 2 + 20, pageData.height]);
        const outline = createPdfExportOutline(source, output, document, []);
        outline.layoutPage(pageData, page, pageData.width + 20); outline.write();
        const first = (await readOutline(await output.save())).items[0];
        const expected = {0: [40, 750], 90: [720, 560], 180: [260, 80], 270: [50, 340]}[rotation];
        expect([first.x, first.y]).toEqual([expected[0] + pageData.width + 20, expected[1]]);
    });

    it('keeps native chapters without translating ambiguous repeated headings and never copies external actions', async () => {
        const {source, document, pages} = await fixture();
        pages[0].blocks.push({...pages[0].blocks[0], segmentIndex: 1}); document.segments[1].source = document.segments[0].source;
        const root = source.context.obj({Type: 'Outlines'}), rootRef = source.context.register(root);
        const item = source.context.obj({Title: PDFString.of('1 Introduction'), Dest: [source.getPage(0).ref, name('Fit')]}), ref = source.context.register(item);
        const external = source.context.obj({Title: PDFString.of('External'), A: {S: 'URI', URI: PDFString.of('https://example.com')}});
        item.set(name('Next'), source.context.register(external)); external.set(name('Next'), ref); // cyclic corrupt sibling chain
        root.set(name('First'), ref); source.catalog.set(name('Outlines'), rootRef);
        const output = await PDFDocument.create(), outline = createPdfExportOutline(source, output, document, ['不猜测标题']);
        outline.layoutPage(pages[0], output.addPage()); outline.write();
        expect((await readOutline(await output.save())).items.map(item => item.title)).toEqual(['1 Introduction']);
    });

    it('omits invalid and unrendered headings and leaves plain PDFs without an artificial outline', async () => {
        const {source, document, pages} = await fixture();
        const output = await PDFDocument.create(), page = output.addPage();
        document.segments[0].source = ''; document.segments[1].source = 'x'.repeat(141); pages[1].blocks[0].kind = 'text';
        const outline = createPdfExportOutline(source, output, document, []);
        outline.readingPage(pages[0], page, [{segmentIndex: -1, x: 0, y: 0}]); outline.write();
        expect(output.catalog.get(name('Outlines'))).toBeUndefined();
        expect((await readOutline(await output.save())).items).toEqual([]);
        const unrendered = createPdfExportOutline(source, output, {...document, binary: undefined}, []); unrendered.write();
        expect(output.catalog.get(name('PageMode'))).toBeUndefined();
    });

    it('ignores broken native destination objects and falls back to detected headings', async () => {
        const {source, document, pages} = await fixture();
        document.segments[0].source = 'Introduction';
        const root = source.context.obj({First: {Title: PDFString.of('Broken'), Dest: [], Next: {Title: PDFString.of('Invalid numeric page'), Dest: [0, name('Fit')]}}});
        source.catalog.set(name('Outlines'), root);
        source.catalog.set(name('Names'), source.context.obj({Dests: {Names: [PDFString.of('odd')], Kids: [PDFNumber.of(1), PDFRef.of(999999)]}}));
        const output = await PDFDocument.create(), outline = createPdfExportOutline(source, output, document, []);
        const page = output.addPage(); outline.layoutPage(pages[0], page); outline.layoutPage(pages[0], page); outline.write();
        const result = await readOutline(await output.save());
        expect(result.items).toHaveLength(1); expect(result.items[0].title).toBe('Introduction'); expect(result.items[0].children[0].title).toBe('1.1 Details');
    });

    it('preserves a native chapter group without a destination by using its first valid child', async () => {
        const {source, document, pages} = await fixture();
        const root = source.context.obj({First: {Title: PDFString.of('Part One'), First: {
            Title: PDFString.of('Broken child'), Dest: [], Next: {Title: PDFString.of('Native section'), Dest: [source.getPage(1).ref, name('Fit')]},
        }}});
        source.catalog.set(name('Outlines'), root);
        const output = await PDFDocument.create(), outline = createPdfExportOutline(source, output, document, []);
        outline.layoutPage(pages[1], output.addPage([600, 800])); outline.write();
        const items = (await readOutline(await output.save())).items;
        expect(items).toEqual([{title: 'Part One', page: 1, x: 0, y: 800, children: [{title: 'Native section', page: 1, x: 0, y: 800, children: []}]}]);
    });
});
