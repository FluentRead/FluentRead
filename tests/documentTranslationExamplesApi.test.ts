import {beforeEach, describe, expect, it, vi} from 'vitest';
import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';

const mocks = vi.hoisted(() => ({
    config: {service: 'microsoft', model: {} as Record<string, string>, customModel: {} as Record<string, string>, enableAIMultiSegment: false},
    translateText: vi.fn(),
    translateTextBatch: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config,
    configReady: Promise.resolve(),
}));

vi.mock('@/src/app/translation/client', () => ({
    translateText: mocks.translateText,
    translateTextBatch: mocks.translateTextBatch,
}));

import {getDocumentFormat, parseDocument, renderDocument} from '@/src/features/document-translation/core/document';
import {createDocumentDownload, parseBinaryDocument, type PdfPageRasterizer} from '@/src/features/document-translation/services/binary';
import {translateDocumentSegments} from '@/src/app/document-translation/runtime';
import {
    DOCUMENT_BINARY_EXAMPLES,
    DOCUMENT_EXAMPLES,
    loadBinaryExample,
    loadExample,
} from './documentTranslationExamples';

const onePixelPng = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlY4AAAAASUVORK5CYII=',
    'base64',
));
const testRasterizer: PdfPageRasterizer = async () => onePixelPng;

beforeEach(() => {
    mocks.config.service = 'microsoft';
    mocks.config.model = {};
    mocks.config.customModel = {};
    mocks.config.enableAIMultiSegment = false;
    mocks.translateText.mockReset();
    mocks.translateTextBatch.mockReset();
    mocks.translateTextBatch.mockImplementation(async (origins: string[]) => origins.map((origin) => `Translated: ${origin}`));
});

describe('document translation examples API regression', () => {
    it('enables document AI batching without writing global settings and freezes the configured model', async () => {
        mocks.config.service = 'openai';
        mocks.config.model.openai = 'first-model';
        mocks.translateTextBatch.mockImplementation(async (origins: string[]) => {
            mocks.config.model.openai = 'next-model';
            return origins.map(origin => `Translated: ${origin}`);
        });
        const segments = Array.from({length: 33}, (_, id) => ({id, source: `Sentence ${id}`}));
        expect(await translateDocumentSegments(segments, {fileName: 'paper.pdf'})).toHaveLength(33);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0].length)).toEqual([16, 16, 1]);
        for (const call of mocks.translateTextBatch.mock.calls) expect(call[2]).toMatchObject({aiMultiSegment: true, modelOverride: 'first-model'});
        expect(mocks.config.enableAIMultiSegment).toBe(false);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it.each([
        ['tongyi', 'qwen-mt-plus'],
        ['doubao', 'doubao-seed-translation-250915'],
        ['huanYuanTranslation', ''],
    ])('keeps dedicated translation model %s/%s on single requests', async (service, model) => {
        mocks.config.service = service;
        mocks.config.model[service] = model;
        mocks.translateText.mockImplementation(async origin => `Translated: ${origin}`);
        await translateDocumentSegments([{id: 0, source: 'First'}, {id: 1, source: 'Second'}], {fileName: 'paper.pdf'});
        expect(mocks.translateText).toHaveBeenCalledTimes(2);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
    });

    it.each(DOCUMENT_EXAMPLES)('$fileName passes through translation and export', async (example) => {
        const source = loadExample(example.fileName);
        const parsed = parseDocument(example.fileName, source);
        const progress: number[] = [];

        expect(getDocumentFormat(example.fileName)).toBe(example.format);
        const translations = await translateDocumentSegments(parsed.segments, {
            fileName: example.fileName,
            onProgress: ({completed}) => progress.push(completed),
        });
        expect(translations).toHaveLength(parsed.segments.length);
        expect(progress.at(-1)).toBe(parsed.segments.length);

        const output = renderDocument(parsed, translations, 'translated');
        const reparsed = parseDocument(example.fileName, output);
        expect(reparsed.segments).toHaveLength(parsed.segments.length);
        for (const marker of example.markers) {
            expect(output, `${example.fileName} export must preserve ${marker}`).toContain(marker);
        }
    });

    it.each(DOCUMENT_BINARY_EXAMPLES)('$fileName passes through binary parse, translation, and same-format export', async (example) => {
        const parsed = await parseBinaryDocument(example.fileName, loadBinaryExample(example.fileName));
        const progress: number[] = [];
        expect(getDocumentFormat(example.fileName)).toBe(example.format);
        expect(parsed.segments.some((segment) => segment.source.includes(example.marker))).toBe(true);

        const translations = await translateDocumentSegments(parsed.segments, {
            fileName: example.fileName,
            onProgress: ({completed}) => progress.push(completed),
        });
        expect(translations).toHaveLength(parsed.segments.length);
        expect(progress.at(-1)).toBe(parsed.segments.length);

        const output = await createDocumentDownload(parsed, translations, 'translated', {
            pdfPageRasterizer: testRasterizer,
        });
        expect(output.fileName).toBe(example.fileName.replace(/(\.[^.]+)$/u, '.translated$1'));

        if (example.format === 'pdf') {
            const pdf = await PDFDocument.load(output.data as Uint8Array);
            expect(pdf.getPageCount()).toBe(2);
        } else if (example.format === 'epub') {
            const zip = await JSZip.loadAsync(output.data as Uint8Array);
            expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
            const reparsed = await parseBinaryDocument(output.fileName, output.data as Uint8Array);
            expect(reparsed.segments).toHaveLength(parsed.segments.length);
        } else {
            const zip = await JSZip.loadAsync(output.data as Uint8Array);
            expect(zip.file('word/document.xml')).not.toBeNull();
            const reparsed = await parseBinaryDocument(output.fileName, output.data as Uint8Array);
            expect(reparsed.segments).toHaveLength(parsed.segments.length);
        }
    });
});
