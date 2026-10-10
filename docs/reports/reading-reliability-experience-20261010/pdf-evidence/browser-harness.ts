import {PDFDocument, rgb} from 'pdf-lib';
import {createDocumentDownload, type PdfReadingRenderer} from '@/src/features/document-translation/services/binary';
import {renderPdfReadingPages, rasterizePdfTranslationPage} from '@/src/features/document-translation/ui/pdfPreview';
import type {ParsedDocument, PdfDocumentBlock} from '@/src/features/document-translation/core/document';
import {getDocument, TextLayer} from 'pdfjs-dist/legacy/build/pdf.mjs';

const compact = (value: string) => value.replace(/\s/gu, '');
const assert = (condition: boolean, message: string) => {if (!condition) throw new Error(message);};
(globalThis as any).runPdfEvidence = async () => {
    const source = await PDFDocument.create();
    const original = source.addPage([600, 800]);
    original.drawText('Original source page is selectable', {x: 42, y: 730, size: 16});
    original.drawRectangle({x: 60, y: 480, width: 260, height: 120, color: rgb(0.89, 0.95, 1), borderColor: rgb(0.2, 0.4, 0.6), borderWidth: 1});
    original.drawText('Preserved diagram: E = mc2', {x: 75, y: 540, size: 14});
    const document: ParsedDocument = {fileName: 'browser-fixture.pdf', format: 'pdf', label: 'PDF 文件', parts: [],
        segments: [{id: 0, source: 'Original title', contextLabel: '第 1 页', role: 'title'},
            {id: 1, source: 'Original caption', contextLabel: '第 1 页', role: 'paragraph'},
            {id: 2, source: 'Original paragraph', contextLabel: '第 1 页', role: 'paragraph'}],
        binary: {kind: 'pdf', bytes: await source.save(), pages: [{pageNumber: 1, width: 600, height: 800, segmentIndexes: [0, 1, 2],
            preservedRegions: [{id: 'diagram', kind: 'figure', x: 60, y: 200, width: 260, height: 120}],
            blocks: [0, 1, 2].map(segmentIndex => ({segmentIndex, readingOrder: segmentIndex, x: 42, y: [50, 330, 380][segmentIndex],
                width: 510, height: [40, 30, 360][segmentIndex], kind: ['heading', 'caption', 'text'][segmentIndex] as PdfDocumentBlock['kind'],
                fontSize: 14, lineHeight: 20, lineCount: segmentIndex === 2 ? 18 : 2, fontFamily: 'sans-serif', fontWeight: 400, textAlign: 'left'})),
        }]}};
    const body = '中文译文可复制、可搜索，中英混合 Mixed English 123；标点：“引号”《书名》？！①②。·•';
    const translations = ['可复制的中文 PDF 译文', '公式与图表保持原貌', body.repeat(100) + '唯一末尾：完整保留。'];
    const options = {pdfReadingRenderer: renderPdfReadingPages, pdfPageRasterizer: rasterizePdfTranslationPage};
    const files = [];
    let readingBytes: Uint8Array | undefined;
    let readingTexts: string[] = [];
    for (const [mode, presentation, fileName] of [['translated', 'readable', 'browser-readable.pdf'],
        ['bilingual', 'readable', 'browser-bilingual.pdf'], ['bilingual', 'layout', 'browser-bilingual-layout.pdf']] as const) {
        const progress: unknown[] = [];
        const download = await createDocumentDownload(document, translations, mode, {...options, pdfPresentation: presentation,
            onPdfProgress: value => progress.push(value)});
        const bytes = download.data as Uint8Array;
        const task = getDocument({data: bytes.slice(), isEvalSupported: false});
        const pdf = await task.promise;
        const texts = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            texts.push((await page.getTextContent()).items.filter(item => 'str' in item).map(item => (item as any).str).join('\n'));
            page.cleanup();
        }
        const offset = mode === 'bilingual' ? presentation === 'layout' ? 2 : 1 : 0;
        assert(compact(texts.slice(offset).join('')) === compact(translations.join('')), `${fileName}: Unicode tail/text mismatch`);
        if (mode === 'bilingual') assert(texts[0].includes('Original source page is selectable'), 'Original page lost');
        assert(pdf.numPages > offset + 2, 'Long translation did not continue');
        files.push({fileName, bytes: Array.from(bytes), pages: pdf.numPages, progress});
        if (mode === 'translated') {readingBytes = bytes; readingTexts = texts;}
        await task.destroy();
    }
    const controller = new AbortController();
    const cancellationCanvases: HTMLCanvasElement[] = [];
    const createElement = globalThis.document.createElement.bind(globalThis.document);
    (globalThis.document as any).createElement = (tag: string, settings?: any) => {
        const element = createElement(tag, settings);
        if (tag === 'canvas') cancellationCanvases.push(element as HTMLCanvasElement);
        return element;
    };
    let iteratorReleased = false;
    const cancelRenderer: PdfReadingRenderer = async function* (input) {
        try {
            for await (const rendered of renderPdfReadingPages(input)) {
                yield rendered;
                controller.abort(new Error('Controlled PDF cancellation'));
            }
        } finally {iteratorReleased = true;}
    };
    try {
        await createDocumentDownload(document, translations, 'translated', {...options, signal: controller.signal, pdfReadingRenderer: cancelRenderer});
        throw new Error('Cancellation unexpectedly created a download');
    } catch (error) {assert(String(error).includes('Controlled PDF cancellation'), 'Wrong cancellation error');}
    finally {(globalThis.document as any).createElement = createElement;}
    assert(iteratorReleased, 'Reading iterator did not release');
    assert(cancellationCanvases.length === 2 && cancellationCanvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Canceled export kept Canvas pixels');

    const task = getDocument({data: readingBytes!.slice(), isEvalSupported: false});
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({scale: 1.5});
    const canvas = globalThis.document.querySelector('canvas')!;
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({canvasContext: canvas.getContext('2d')!, viewport}).promise;
    const container = globalThis.document.querySelector('.textLayer') as HTMLElement;
    container.style.setProperty('--scale-factor', '1.5');
    await new TextLayer({textContentSource: await page.getTextContent(), container, viewport}).render();
    const selection = getSelection()!; selection.removeAllRanges();
    const range = globalThis.document.createRange(); range.selectNodeContents(container); selection.addRange(range);
    const selected = selection.toString();
    assert(compact(selected) === compact(readingTexts[0]), 'Browser selectable text differs from PDF Unicode content');
    assert(selected.includes('可复制的中文'), 'Chinese cannot be selected');
    await navigator.clipboard.writeText(selected);
    assert(await navigator.clipboard.readText() === selected, 'Clipboard round-trip mismatch');
    (globalThis as any).__pdfEvidenceTask = task;
    return {files, selectedText: selected, translations, cancellation: {iteratorReleased, canvasesReleased: cancellationCanvases.length}, browser: navigator.userAgent};
};
