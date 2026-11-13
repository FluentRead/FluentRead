import {describe, expect, it, vi} from 'vitest';
import type {Bbox, Block, Line, Symbol as OcrSymbol, Word} from 'tesseract.js';
import letterScript from './fixtures/pdf-scanned-letter-script.json';
import {recoverDocumentOcrScripts} from '@/src/features/image-translation/services/documentOcrScripts';

const box = (x0: number, y0: number, x1: number, y1: number): Bbox => ({x0, y0, x1, y1});
const glyph = (text: string, bbox: Bbox, confidence = 99) => ({text, bbox, confidence}) as OcrSymbol;
const bounds = (symbols: OcrSymbol[]): Bbox => ({x0: Math.min(...symbols.map(s => s.bbox.x0)), y0: Math.min(...symbols.map(s => s.bbox.y0)), x1: Math.max(...symbols.map(s => s.bbox.x1)), y1: Math.max(...symbols.map(s => s.bbox.y1))});
const word = (symbols: OcrSymbol[], confidence = 99) => ({text: symbols.map(s => s.text).join(''), symbols, bbox: bounds(symbols), confidence}) as Word;
const line = (words: Word[], baseline = 40, rowHeight = 30): Line => ({text: words.map(w => w.text).join(' '), words, bbox: bounds(words as unknown as OcrSymbol[]), baseline: box(0, baseline, 1000, baseline), rowAttributes: {rowHeight}}) as Line;
const blocks = (lines: Line[]): Block[] => [{paragraphs: [{lines}]}] as Block[];
const reads = (text = '4', confidence = 95) => vi.fn(async () => ({text, confidence}));
const sampleWord = () => word([glyph('1', box(10, 15, 20, 40)), glyph('0', box(23, 15, 35, 40)), glyph('%', box(38, 6, 51, 25))]);
const resultLine = (result: Awaited<ReturnType<typeof recoverDocumentOcrScripts>>) => result.blocks![0].paragraphs[0].lines[0];

describe('document OCR script recovery', () => {
    it('marks the actual misread raised letter cluster without inventing a reading or sending numeric crop requests', async () => {
        const source = blocks([structuredClone(letterScript.line) as unknown as Line]), before = structuredClone(source), recognize = reads();
        const result = await recoverDocumentOcrScripts(source, recognize);
        expect(result.blocks).toBe(source); expect(source).toEqual(before); expect(recognize).not.toHaveBeenCalled();
        expect(result.unresolved).toEqual([box(446, 1720, 490, 1734)]);
    });
    it.each(['trusted','invalid','single','ordinary','tiny','large','wideGap','backwards','notVariable','wordPrefix'])('does not flag %s punctuation as an unknown letter script', async reason => {
        const base = glyph('x', box(10, 20, 30, 40)), a = glyph('™', box(31, 8, 43, 22)), b = glyph('"', box(44, 8, 56, 22));
        let symbols = [base, a, b], confidence = 53;
        if (reason === 'trusted') confidence = 95;
        if (reason === 'invalid') confidence = NaN;
        if (reason === 'single') symbols = [base, a];
        if (reason === 'ordinary') {a.bbox.y0 = 25; a.bbox.y1 = 39;}
        if (reason === 'tiny') a.bbox.y1 = 10;
        if (reason === 'large') a.bbox.y0 = 0;
        if (reason === 'wideGap') {a.bbox.x0 += 20; a.bbox.x1 += 20; b.bbox.x0 += 20; b.bbox.x1 += 20;}
        if (reason === 'backwards') a.bbox.x0 = 29;
        if (reason === 'notVariable') base.text = '2';
        if (reason === 'wordPrefix') symbols = [glyph('a', box(0,20,8,40)), ...symbols];
        const source = blocks([line([word(symbols, confidence)], 40, 30)]), recognize = reads();
        const result = await recoverDocumentOcrScripts(source, recognize);
        expect(result.unresolved).toEqual([]); expect(result.blocks).toBe(source); expect(recognize).not.toHaveBeenCalled();
    });

    it('recovers real paper glyph geometry without copying or guessing its surrounding prose', async () => {
        const first = word([glyph('1', box(948, 1350, 960, 1375)), glyph('0', box(965, 1350, 980, 1375)), glyph('%', box(983, 1341, 996, 1360), 96)]);
        const second = word([glyph('1', box(1057, 1350, 1069, 1375)), glyph('0', box(1074, 1350, 1089, 1375)), glyph('°', box(1094, 1341, 1104, 1360))]);
        const source = blocks([line([first, second], 1375, 34)]), before = structuredClone(source);
        const recognize = vi.fn(async (bbox: Bbox) => ({text: bbox.x0 === 983 ? '4\n' : '5', confidence: 89}));
        const result = await recoverDocumentOcrScripts(source, recognize);
        expect(resultLine(result).text).toBe('10⁴ 10⁵');
        expect(recognize.mock.calls.map(([bbox]) => bbox)).toEqual([first.symbols[2].bbox, first.symbols[2].bbox, second.symbols[2].bbox, second.symbols[2].bbox]);
        expect(source).toEqual(before); expect(result.unresolved).toEqual([]);
    });

    it('binds equal-looking occurrences by coordinates and keeps surrounding text and whitespace', async () => {
        const first = sampleWord(), second = sampleWord();
        second.symbols = second.symbols.map(s => ({...s, bbox: {...s.bbox, x0: s.bbox.x0 + 100, x1: s.bbox.x1 + 100}})); second.bbox = bounds(second.symbols);
        const row = line([first, second]); row.text = '  10%\t10%\n';
        const result = await recoverDocumentOcrScripts(blocks([row]), async b => ({text: b.x0 < 100 ? '4' : '5', confidence: 90}));
        expect(resultLine(result).text).toBe('  10⁴\t10⁵\n');
    });

    it('retains ordinary words beside corrections and does not convert a baseline hyphen into a script sign', async () => {
        const unchanged = word([glyph('A', box(0, 15, 8, 40))]);
        const source = blocks([line([unchanged, sampleWord()])]);
        const result = await recoverDocumentOcrScripts(source, reads());
        expect(resultLine(result).text).toBe('A 10⁴'); expect(resultLine(result).words[0]).toBe(unchanged);
        const ordinary = blocks([line([word([glyph('x', box(10, 15, 30, 40)), glyph('-', box(33, 25, 42, 27)), glyph('2', box(44, 15, 56, 40))])])]);
        const recognize = reads(); expect((await recoverDocumentOcrScripts(ordinary, recognize)).blocks).toBe(ordinary); expect(recognize).not.toHaveBeenCalled();
    });

    it.each(['sup', 'sub'] as const)('keeps every digit of a multi-digit %s together', async kind => {
        const symbols = [glyph('x', box(10, 15, 30, 40)), ...Array.from('128', (text, index) => glyph(text, box(32 + 15 * index, kind === 'sup' ? 6 : 30, 44 + 15 * index, kind === 'sup' ? 25 : 49)))];
        const recognize = reads('128');
        const result = await recoverDocumentOcrScripts(blocks([line([word(symbols)])]), recognize);
        expect(resultLine(result).text).toBe(kind === 'sup' ? 'x¹²⁸' : 'x₁₂₈');
        expect(recognize).toHaveBeenCalledTimes(2);
        expect(recognize.mock.calls[0]).toEqual([box(32, kind === 'sup' ? 6 : 30, 74, kind === 'sup' ? 25 : 49), 2]);
    });

    it.each(['sup', 'sub'] as const)('includes a small sign before a %s digit', async kind => {
        const y = kind === 'sup' ? 11 : 39;
        const w = word([glyph('x', box(10, 15, 30, 40)), glyph('-', box(33, y, 42, y + 2)), glyph('2', box(44, kind === 'sup' ? 6 : 30, 56, kind === 'sup' ? 25 : 49))]);
        const result = await recoverDocumentOcrScripts(blocks([line([w])]), vi.fn().mockResolvedValueOnce({text: '−2', confidence: 95}).mockResolvedValueOnce({text: '-2', confidence: 90}));
        expect(resultLine(result).text).toBe(kind === 'sup' ? 'x⁻²' : 'x₋₂');
    });

    it('preserves range separators and rescues a low-score word only with evidence for every remaining glyph', async () => {
        const w = word([glyph('1', box(910, 2596, 922, 2621)), glyph('0', box(928, 2596, 944, 2621)), glyph('3', box(947, 2588, 959, 2606), 84), glyph('~', box(964, 2609, 983, 2611), 93), glyph('1', box(989, 2596, 1001, 2621)), glyph('0', box(1007, 2596, 1023, 2621)), glyph('%', box(1026, 2587, 1038, 2606)), glyph('.', box(1043, 2617, 1048, 2621))], 0);
        const result = await recoverDocumentOcrScripts(blocks([line([w], 2621, 34)]), async b => ({text: b.x0 === 947 ? '3' : '4', confidence: 89}));
        expect(resultLine(result).text).toBe('10³~10⁴.');
        expect(resultLine(result).words[0].confidence).toBe(89); expect(result.unresolved).toEqual([]);
    });

    it.each([20, NaN])('does not promote a word whose remaining glyph confidence is %s', async confidence => {
        const w = sampleWord(); w.confidence = 0; w.symbols[0].confidence = confidence;
        const result = await recoverDocumentOcrScripts(blocks([line([w])]), reads());
        expect(resultLine(result).words[0].confidence).toBe(0);
        expect(result.unresolved).toEqual([w.bbox]);
    });

    it.each([
        [{text: '4', confidence: 95}, {text: '5', confidence: 95}],
        [{text: 'x', confidence: 99}, {text: 'x', confidence: 99}],
        [{text: '', confidence: 99}, {text: '', confidence: 99}],
        [{text: '1234567', confidence: 99}, {text: '1234567', confidence: 99}],
        ...[84, NaN, Infinity, 101].map(confidence => [{text: '4', confidence}, {text: '4', confidence}]),
    ])('retains unconfirmed glyphs with exact review geometry (%j / %j)', async (first, second) => {
        const w = sampleWord(), source = blocks([line([w])]);
        const result = await recoverDocumentOcrScripts(source, vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second));
        expect(result.blocks).toBe(source); expect(result.unresolved).toEqual([w.symbols[2].bbox]);
    });

    it('does not reinterpret a degree as zero even when crop reads agree', async () => {
        const w = sampleWord(); w.symbols[2].text = '°'; w.text = '10°';
        const source = blocks([line([w])]), result = await recoverDocumentOcrScripts(source, reads('0'));
        expect(result.blocks).toBe(source); expect(result.unresolved).toEqual([w.symbols[2].bbox]);
    });

    it('checks an asterisk-shaped engine result against the actual raised digit crop', async () => {
        const w = sampleWord(); w.symbols[2].text = '*'; w.text = '10*';
        const source = blocks([line([w])]), recognize = reads('4');
        expect(resultLine(await recoverDocumentOcrScripts(source, recognize)).text).toBe('10⁴');
        expect(recognize).toHaveBeenCalledTimes(2);
    });

    it('does not mistake a descender comma after a normal word for a subscript', async () => {
        const source = blocks([line([word([glyph('n', box(10, 20, 24, 40)), glyph(',', box(27, 31, 32, 44))])])]);
        const recognize = reads(); expect(await recoverDocumentOcrScripts(source, recognize)).toEqual({blocks: source, unresolved: []});
        expect(recognize).not.toHaveBeenCalled();
    });

    it('keeps a letter exponent for review instead of applying a numeric interpretation', async () => {
        const w = word([glyph('x', box(10, 15, 30, 40)), glyph('n', box(33, 6, 45, 25))]);
        const source = blocks([line([w])]), recognize = reads('9', 99);
        expect(await recoverDocumentOcrScripts(source, recognize)).toEqual({blocks: source, unresolved: [w.symbols[1].bbox]});
        expect(recognize).not.toHaveBeenCalled();
    });

    it.each([
        box(38, 15, 51, 40), // baseline percentage
        box(38, 6, 46, 14), // small degree
        box(38, 4, 60, 29), // full-sized raised text
        box(33, 6, 46, 25), // overlaps base
        box(100, 6, 113, 25), // distant annotation
        box(38, 15, 51, 34), // small but not raised or lowered
    ])('leaves ordinary punctuation and unrelated geometry unchanged: %j', async bbox => {
        const w = sampleWord(); w.symbols[2].bbox = bbox; w.bbox = bounds(w.symbols);
        const recognize = reads(), source = blocks([line([w])]);
        expect((await recoverDocumentOcrScripts(source, recognize)).blocks).toBe(source);
        expect(recognize).not.toHaveBeenCalled();
    });

    it.each([
        (row: Line) => {row.rowAttributes = undefined!;},
        (row: Line) => {row.baseline = undefined!;},
        (row: Line) => {row.rowAttributes.rowHeight = NaN;},
        (row: Line) => {row.rowAttributes.rowHeight = -1;},
        (row: Line) => {row.baseline.y1 = 60;},
        (row: Line) => {row.bbox.x1 = NaN;},
        (row: Line) => {row.words = [];},
        (row: Line) => {row.text = 'missing';},
        (row: Line) => {row.text = 'unmapped ' + row.text;},
        (row: Line) => {row.text += ' unmapped';},
        (row: Line) => {row.words[0].text = '';},
        (row: Line) => {row.words[0].bbox.x1++;},
        (row: Line) => {row.words[0].bbox = undefined!;},
        (row: Line) => {row.words[0].symbols = undefined!;},
        (row: Line) => {row.words[0].symbols[0].text = 'mismatch';},
        (row: Line) => {row.words[0].symbols[0].bbox.y0 = 0;},
        (row: Line) => {row.words[0].symbols[1].bbox.x0 = 9; row.words[0].bbox.x0 = row.bbox.x0 = 9;},
    ])('rejects malformed or misaligned engine evidence without guessing (%#)', async alter => {
        const row = line([sampleWord()]); alter(row);
        const source = blocks([row]), recognize = reads();
        expect((await recoverDocumentOcrScripts(source, recognize)).blocks).toBe(source);
        expect(recognize).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2])('cancels atomically after %i crop reads', async after => {
        const controller = new AbortController(), source = blocks([line([sampleWord()])]), before = structuredClone(source);
        let count = 0;
        const recognize = vi.fn(async () => {if (++count === after) controller.abort(); return {text: '4', confidence: 95};});
        if (!after) controller.abort();
        await expect(recoverDocumentOcrScripts(source, recognize, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(source).toEqual(before); expect(recognize).toHaveBeenCalledTimes(after);
    });

    it('does not publish partial corrections after a crop failure', async () => {
        const source = blocks([line([sampleWord()]), line([sampleWord()])]), before = structuredClone(source);
        const recognize = reads().mockResolvedValueOnce({text: '4', confidence: 95}).mockResolvedValueOnce({text: '4', confidence: 95}).mockRejectedValueOnce(new Error('decode failed'));
        await expect(recoverDocumentOcrScripts(source, recognize)).rejects.toThrow('decode failed'); expect(source).toEqual(before);
    });

    it('bounds crop work per page and retains positions for unprocessed candidates', async () => {
        const source = blocks(Array.from({length: 129}, () => line([sampleWord()]))), recognize = reads();
        const result = await recoverDocumentOcrScripts(source, recognize);
        expect(recognize).toHaveBeenCalledTimes(256); expect(result.unresolved).toHaveLength(1);
        expect(result.blocks![0].paragraphs[0].lines[128].text).toBe('10%');
    });

    it('accepts empty engine structures and preserves unaffected lines in a changed block', async () => {
        const recognize = reads();
        expect(await recoverDocumentOcrScripts(null, recognize)).toEqual({blocks: null, unresolved: []});
        const untouched = line([word([glyph('a', box(0, 15, 20, 40))])]);
        const source = [...blocks([line([sampleWord()]), untouched]), {paragraphs: [{}]}, {}] as Block[];
        const result = await recoverDocumentOcrScripts(source, recognize);
        expect(result.blocks![0].paragraphs[0].lines[1]).toBe(untouched);
        expect(resultLine(result).text).toBe('10⁴');
    });
});
