import {describe, expect, it, vi} from 'vitest';
import type {Block, Line} from 'tesseract.js';
import {normalizeOcrLines, type OcrLine} from '@/src/features/image-translation/core';
import {isDocumentBulletPixels, recoverDocumentOcrBullets, type DocumentBulletPixels} from '@/src/features/image-translation/services/documentOcrBullets';
import {recognizePdfDocument} from '@/src/features/document-translation/services/pdfOcr';
import shape from './fixtures/pdf-scanned-bullet-pixels.json';

const pixels = (): DocumentBulletPixels => ({width: 15, height: 15, data: Uint8ClampedArray.from(shape.rows.flatMap(row => Array.from(row).flatMap(value => value === '#' ? [0, 0, 0, 255] : [255, 255, 255, 255])))});
const box = (x0: number, y0: number, x1: number, y1: number) => ({x0, y0, x1, y1});
const row = (y: number, confidence = 10): Line => ({text: 'e We examine the observations.', bbox: box(1327, y - 11, 2327, y + 28),
    words: [{text: 'e', confidence, bbox: box(1327, y, 1342, y + 15)}, {text: 'We', confidence: 99, bbox: box(1360, y - 9, 1414, y + 18)},
        {text: 'examine the observations.', confidence: 99, bbox: box(1430, y - 11, 2327, y + 28)}]}) as Line;
const blocks = (rows = [row(323), row(622, 43)]): Block[] => [{paragraphs: [{lines: rows}]}] as Block[];
const ordinary = (source: Block[]): OcrLine[] => normalizeOcrLines(source).map(line => ({...line, fontSize: 33.15, baseline: line.bbox.y0 + 29}));

describe('scanned list source geometry', () => {
    it('confirms the actual paper circle while rejecting hollow letters and solid rectangles', () => {
        expect(isDocumentBulletPixels(pixels())).toBe(true);
        const hollow = pixels(); for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) hollow.data.fill(255, (y * 15 + x) * 4, (y * 15 + x) * 4 + 3);
        expect(isDocumentBulletPixels(hollow)).toBe(false);
        const square = pixels(); square.data.fill(0); for (let at = 3; at < square.data.length; at += 4) square.data[at] = 255;
        expect(isDocumentBulletPixels(square)).toBe(false);
        const corners = pixels(); for (const [x, y] of [[0, 0], [0, 14], [14, 0], [14, 14]]) corners.data.fill(0, (y * 15 + x) * 4, (y * 15 + x) * 4 + 3);
        expect(isDocumentBulletPixels(corners)).toBe(false);
        const transparent = pixels(); for (let at = 3; at < transparent.data.length; at += 4) transparent.data[at] = 0;
        expect(isDocumentBulletPixels(transparent)).toBe(false);
    });

    it.each([{width: 5}, {height: 65}, {width: 6.5}, {width: 10, height: 15}, {width: 15, height: 10}, {data: new Uint8ClampedArray(1)}])('rejects insufficient pixel evidence (%j)', patch => {
        const sample = {...pixels(), ...patch};
        if (!('data' in patch) && Number.isInteger(sample.width)) sample.data = new Uint8ClampedArray(sample.width * sample.height * 4).fill(255);
        expect(isDocumentBulletPixels(sample)).toBe(false);
    });

    it('restores filtered and letter-shaped markers as separate atoms without changing the source or scores', async () => {
        const source = blocks(), lines = ordinary(source), before = structuredClone(source), previous = structuredClone(lines), read = vi.fn(async () => pixels());
        const result = await recoverDocumentOcrBullets(source, lines, read);
        expect(result.map(line => line.text)).toEqual(['•', 'We examine the observations.', '•', 'We examine the observations.']);
        expect(result[0].bbox).toEqual(source[0].paragraphs[0].lines[0].words[0].bbox);
        expect(result[1].bbox.x0).toBe(1360); expect(read).toHaveBeenCalledTimes(2);
        expect(source).toEqual(before); expect(lines).toEqual(previous);
    });

    it.each(['a', 'n', '0', '\uE000', '𝑜'])('uses pixel shape rather than one particular OCR character (%s)', async label => {
        const source = blocks();
        for (const row of source[0].paragraphs[0].lines) {row.words[0].text = label; row.text = `${label} We examine the observations.`;}
        expect((await recoverDocumentOcrBullets(source, ordinary(source), async () => pixels())).filter(line => line.text === '•')).toHaveLength(2);
    });

    it('clears only review boxes belonging to confirmed bullet pixels and avoids duplicate unresolved markers', async () => {
        const source = blocks(), lines = ordinary(source), marker = source[0].paragraphs[0].lines[0].words[0].bbox;
        lines.push({text: '', bbox: {...marker}, documentReview: true}, {text: '', bbox: box(1600, 700, 1630, 730), documentReview: true});
        const result = await recoverDocumentOcrBullets(source, lines, async () => pixels());
        expect(result.filter(line => line.documentReview)).toEqual([lines[3]]);
        const white = pixels(); white.data.fill(255);
        expect((await recoverDocumentOcrBullets(source, lines, async () => white)).filter(line => line.documentReview)).toHaveLength(3);
    });

    it.each([undefined, NaN, 338, 338.5, 360])('does not mistake a baseline letter or a raised annotation for a bullet (%s)', baseline => {
        const source = blocks(), lines = ordinary(source), read = vi.fn(async () => pixels());
        lines[0].baseline = baseline;
        return recoverDocumentOcrBullets(source, lines, read).then(result => {expect(result).toBe(lines); expect(read).not.toHaveBeenCalled();});
    });

    it('feeds confirmed circle and body atoms into the existing PDF list segmentation', async () => {
        const first = row(323), second = row(473, 43);
        first.text = 'e We examine the observations,'; first.words[2].text = 'examine the observations,';
        const continuation = {...row(373, 99), text: 'continued measurements are compared.', bbox: box(1360, 362, 2327, 401), words: [{text: 'continued measurements are compared.', confidence: 99, bbox: box(1360, 362, 2327, 401)}]} as Line;
        const source = blocks([first, continuation, second]);
        const result = await recoverDocumentOcrBullets(source, ordinary(source), async () => pixels());
        const document = await recognizePdfDocument({fileName: 'list.pdf', format: 'pdf', label: 'PDF', parts: [], segments: [], binary: {kind: 'pdf', bytes: new Uint8Array([1]),
            pages: [{pageNumber: 1, width: 612, height: 792, scanned: true, blocks: [], segmentIndexes: []}]}}, async () => result.map(line => ({text: line.text,
                x: line.bbox.x0 * .24, y: line.bbox.y0 * .24, width: (line.bbox.x1 - line.bbox.x0) * .24, height: (line.bbox.y1 - line.bbox.y0) * .24,
                fontSize: line.fontSize! * .24, baseline: line.baseline! * .24})));
        const page = document.binary?.kind === 'pdf' && document.binary.pages[0];
        expect(page && page.blocks.map(block => block.listMarker)).toEqual(['•', '•']);
        expect(document.segments.map(segment => segment.source)).toEqual(['We examine the observations, continued measurements are compared.', 'We examine the observations.']);
    });

    it('requires distinct aligned items and deduplicates repeated observations', async () => {
        const one = row(323), source = blocks([one, one]), lines = ordinary(source), read = vi.fn(async () => pixels());
        expect(await recoverDocumentOcrBullets(source, lines, read)).toBe(lines); expect(read).not.toHaveBeenCalled();
        const two = blocks([one, one, row(622)]);
        expect((await recoverDocumentOcrBullets(two, ordinary(two), read)).filter(line => line.text === '•')).toHaveLength(2);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('marks ambiguous pixels for review without removing letters or changing the normalized text', async () => {
        const source = blocks(), lines = ordinary(source), white = pixels(); white.data.fill(255);
        const result = await recoverDocumentOcrBullets(source, lines, async () => white);
        expect(result.slice(0, 2)).toEqual(lines); expect(result.slice(2).every(line => line.documentReview && !line.text)).toBe(true);
    });

    it('bounds pixel reads and flags supported candidates that exceed the page budget', async () => {
        const source = blocks(Array.from({length: 129}, (_, index) => row(100 + index * 100))), read = vi.fn(async () => pixels());
        const result = await recoverDocumentOcrBullets(source, ordinary(source), read);
        expect(read).toHaveBeenCalledTimes(128); expect(result.filter(line => line.text === '•')).toHaveLength(128);
        expect(result.at(-1)?.documentReview).toBe(true);
    });

    it('publishes no partial transformation on cancellation or pixel-read failure', async () => {
        const source = blocks(), lines = ordinary(source), before = structuredClone(lines), controller = new AbortController();
        await expect(recoverDocumentOcrBullets(source, lines, async () => {controller.abort(); return pixels();}, controller.signal)).rejects.toThrow();
        const read = vi.fn(async () => pixels());
        await expect(recoverDocumentOcrBullets(source, lines, read, controller.signal)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
        await expect(recoverDocumentOcrBullets(source, lines, vi.fn().mockResolvedValueOnce(pixels()).mockRejectedValueOnce(new Error('pixels failed')))).rejects.toThrow('pixels failed');
        expect(lines).toEqual(before);
    });

    it.each([
        (line: Line) => {line.words = [];}, (line: Line) => {line.words.pop(); line.words.pop();},
        (line: Line) => {line.words[1].text = '';}, (line: Line) => {line.words[0].text = 'ab';},
        (line: Line) => {line.bbox.x0 = NaN;}, (line: Line) => {line.words[0].bbox = undefined!;},
        (line: Line) => {line.words[1].bbox.x1 = line.words[1].bbox.x0;},
        (line: Line) => {line.bbox.x0--;}, (line: Line) => {line.words[0].bbox.y0 = line.bbox.y0 - 1;},
        (line: Line) => {line.words[0].bbox.y1 = line.bbox.y1 + 1;}, (line: Line) => {line.words[1].bbox.y0 = line.bbox.y0 - 1;},
        (line: Line) => {line.words[1].bbox.y1 = line.bbox.y1 + 1;}, (line: Line) => {line.words[1].bbox.x1 = line.bbox.x1 + 1;},
        (line: Line) => {line.words[0].bbox.y1 = line.words[0].bbox.y0 + 5;},
        (line: Line) => {line.words[0].bbox.y0 -= 5; line.words[0].bbox.y1 += 5;},
        (line: Line) => {line.words[0].bbox.x1 = line.words[0].bbox.x0 + 5;},
        (line: Line) => {line.words[0].bbox.x1 = line.words[0].bbox.x0 + 30;},
        (line: Line) => {line.words[1].bbox.x0 = line.words[0].bbox.x1 + 1;},
        (line: Line) => {line.words[1].bbox.x0 += 100; line.words[1].bbox.x1 += 100;},
        (line: Line) => {line.words[0].bbox.y0 -= 9; line.words[0].bbox.y1 -= 9;},
        (line: Line) => {line.text += ' unmapped';},
    ])('does not infer a list from invalid, unrelated or ordinary-letter geometry (%#)', change => {
        const first = row(323), source = blocks([first, row(622)]), lines = ordinary(source); change(first);
        const read = vi.fn(async () => pixels());
        return recoverDocumentOcrBullets(source, lines, read).then(result => {expect(result).toBe(lines); expect(read).not.toHaveBeenCalled();});
    });

    it('keeps absent OCR hierarchies and unmatched normalized lines unchanged', async () => {
        const lines: OcrLine[] = [];
        expect(await recoverDocumentOcrBullets(null, lines, async () => pixels())).toBe(lines);
        expect(await recoverDocumentOcrBullets([{}, {paragraphs: [{}]}, {paragraphs: [{lines: [{}]}]}] as Block[], lines, async () => pixels())).toBe(lines);
        const source = blocks(), normal = ordinary(source), read = vi.fn(async () => pixels());
        normal[0].text = 'unrelated'; expect(await recoverDocumentOcrBullets(source, normal, read)).toBe(normal); expect(read).not.toHaveBeenCalled();
    });
});
