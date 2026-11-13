import {describe, expect, it} from 'vitest';
import type {Block, Line, Word} from 'tesseract.js';
import {normalizeOcrLines} from '@/src/features/image-translation/core';
import {retainDocumentOcrNumbers} from '@/src/features/image-translation/services/documentOcrNumbers';
import lowScoreNumber from './fixtures/pdf-scanned-low-score-number.json';

const number = () => structuredClone(lowScoreNumber.word) as unknown as Word;
const source = (words: Word[] = [number()]): Block[] => [{paragraphs: [{lines: [{text: words.map(word => word.text).join(' '), words,
    bbox: {x0: 1900, y0: 800, x1: 2400, y1: 850}}]}]}] as Block[];
const row = (blocks: Block[]) => blocks[0].paragraphs[0].lines[0];
const read = (blocks: Block[] | null) => retainDocumentOcrNumbers(blocks, normalizeOcrLines(blocks));

describe('document OCR numeric source integrity', () => {
    it('retains the exact paper token with a review marker and leaves its low score unchanged', () => {
        const blocks = source(), before = structuredClone(blocks);
        expect(normalizeOcrLines(blocks)).toEqual([]);
        expect(read(blocks)).toEqual([{text: '3,700', bbox: number().bbox}, {text: '', bbox: number().bbox, documentReview: true}]);
        expect(blocks).toEqual(before);
        expect(read(blocks).some(line => line.text.includes('×'))).toBe(false);
    });

    it('preserves surrounding prose and separate same-valued occurrences without changing image or manga confidence', () => {
        const left = number(), right = number();
        right.bbox.x0 += 180; right.bbox.x1 += 180;
        right.symbols.forEach(symbol => {symbol.bbox.x0 += 180; symbol.bbox.x1 += 180;});
        const between = {text: 'and', confidence: 99, bbox: {x0: 2100, y0: 814, x1: 2150, y1: 840}} as Word;
        const blocks = source([left, between, right]);
        expect(read(blocks)).toEqual([{text: '3,700 and 3,700', bbox: {x0: 1982, y0: 814, x1: 2272, y1: 844}},
            {text: '', bbox: left.bbox, documentReview: true}, {text: '', bbox: right.bbox, documentReview: true}]);
        expect(normalizeOcrLines(blocks).map(line => line.text)).toEqual(['and']);
        const explicit = source();
        expect(normalizeOcrLines(explicit, true, new Set([row(explicit).words[0]]))[0].numericConfidence).toBe(17);
    });

    it.each([0, 24])('retains score %s without inflating it', confidence => {
        const word = number(); word.confidence = confidence;
        expect(read(source([word]))[0].text).toBe('3,700'); expect(word.confidence).toBe(confidence);
    });

    it.each([25, 100, undefined])('leaves an ordinary accepted score %s unchanged', confidence => {
        const word = number(); word.confidence = confidence as number;
        const blocks = source([word]), ordinary = normalizeOcrLines(blocks);
        expect(retainDocumentOcrNumbers(blocks, ordinary)).toBe(ordinary);
    });

    it.each([-1, NaN, Infinity])('marks an invalid word score %s for review without retaining text', confidence => {
        const word = number(); word.confidence = confidence;
        expect(read(source([word]))).toEqual([{text: '', bbox: word.bbox, documentReview: true}]);
    });

    it.each([84, -1, NaN, Infinity, 101])('does not trust a digit whose glyph confidence is %s', confidence => {
        const word = number(); word.symbols[4].confidence = confidence;
        expect(read(source([word]))).toEqual([{text: '', bbox: word.bbox, documentReview: true}]);
    });

    it.each([
        (word: Word) => {word.symbols = undefined!;},
        (word: Word) => {word.symbols = [];},
        (word: Word) => {word.symbols[4].text = '8';},
        (word: Word) => {word.symbols[0].text = ''; word.symbols[1].text = '3,';},
        (word: Word) => {word.symbols[4].bbox.x0 = 2035;},
        (word: Word) => {word.symbols[4].bbox.x1 = 2093;},
        (word: Word) => {word.symbols[4].bbox.x1 = NaN;},
        (word: Word) => {word.symbols[4].bbox.y1 = word.symbols[4].bbox.y0;},
        (word: Word) => {word.symbols[4].bbox = undefined!;},
    ])('rejects missing, conflicting, overlapping or invalid glyph evidence (%#)', change => {
        const word = number(); change(word);
        expect(read(source([word]))).toEqual([{text: '', bbox: word.bbox, documentReview: true}]);
    });

    it.each([
        (line: Line) => {line.text = 'unmapped ' + line.text;},
        (line: Line) => {line.text += ' unmapped';},
        (line: Line) => {line.text = 'different';},
        (line: Line) => {line.words.unshift({text: '', bbox: line.bbox} as Word);},
    ])('requires exact occurrence correspondence with the whole line (%#)', change => {
        const blocks = source(); change(row(blocks));
        expect(read(blocks)).toEqual([{text: '', bbox: number().bbox, documentReview: true}]);
    });

    it.each([
        (word: Word) => {word.bbox.x0 = NaN;},
        (word: Word) => {word.bbox.x0 = 1800;},
        (word: Word) => {word.bbox.y0 = 700;},
        (word: Word) => {word.bbox.x1 = 2500;},
        (word: Word) => {word.bbox.y1 = 900;},
        (word: Word) => {word.bbox.x1 = word.bbox.x0;},
    ])('uses the valid enclosing line for malformed word geometry (%#)', change => {
        const blocks = source(); change(row(blocks).words[0]);
        expect(read(blocks)).toEqual([{text: '', bbox: row(blocks).bbox, documentReview: true}]);
    });

    it('ignores invalid line geometry, nonnumeric noise and absent hierarchies', () => {
        const blocks = source(); row(blocks).bbox.y1 = NaN;
        expect(read(blocks)).toEqual([]);
        const noise = number(); noise.text = 'noise';
        expect(read(source([noise]))).toEqual([]);
        expect(read(null)).toEqual([]);
        expect(read([{}, {paragraphs: [{}]}, {paragraphs: [{lines: [{text: '', bbox: number().bbox}]}]}] as Block[])).toEqual([]);
    });

    it('retains punctuation only as originally observed and accepts exact whitespace around mapped words', () => {
        const blocks = source(); row(blocks).text = '\t3,700 \n';
        expect(read(blocks)[0].text).toBe('3,700');
    });
});
