/** 验证私有基本希伯来/ASCII 单行原型的身份与 reader 兼容边界；真实回读另由导出测试验收。 */
import {afterEach, describe, expect, it, vi} from 'vitest';
const fault = vi.hoisted(() => ({kind: ''}));
vi.mock('bidi-js', async original => {
    const actual = await original<typeof import('bidi-js')>();
    return {default: () => {
        const bidi = actual.default();
        return {...bidi, getEmbeddingLevels: (text: string) => {
            const value = bidi.getEmbeddingLevels(text);
            if (fault.kind === 'paragraphs') value.paragraphs.push({...value.paragraphs[0]});
            if (fault.kind === 'missing') value.paragraphs = [];
            if (fault.kind === 'sparse paragraph') value.paragraphs = new Array(1);
            if (fault.kind === 'start') value.paragraphs[0].start = 1;
            if (fault.kind === 'end') value.paragraphs[0].end--;
            if (fault.kind === 'level') value.paragraphs[0].level = 2;
            return value;
        }, getReorderedIndices: (...args: Parameters<typeof bidi.getReorderedIndices>) => {
            const result = bidi.getReorderedIndices(...args);
            if (fault.kind === 'length') result.pop();
            if (fault.kind === 'duplicate') result[1] = result[0];
            if (fault.kind === 'negative') result[0] = -1;
            if (fault.kind === 'outside') result[0] = args[0].length;
            if (fault.kind === 'fraction') result[0] = .5;
            return result;
        }};
    }};
});
import {pdfFallbackBidiLine, withPdfFallbackBidiDirection} from '@/src/features/document-translation/core/pdfFallbackBidi';
import {projectPdfReaderBidi} from 'virtual:fluentread-pdfjs-bidi';
afterEach(() => {fault.kind = '';});

describe('bounded complete-line fallback bidi', () => {
    const rtl = 'מחקר 2026 משווה GPU A100 מול H100; השיפור 12.5% (ניסוי 3), וההסבר נשמר.';
    const ltr = 'English שלום עולם sentence GPU A100 and H100 in 2026 (12.5%).';
    it.each([['שלום', 'rtl', 'םולש'], ['א aa', 'rtl', 'aa א'],
        ['English explanation שלום עולם GPU', 'ltr', 'English explanation םלוע םולש GPU']] as const)
    ('uses the public UBA visual ordering for %s without changing Unicode identities', (source, direction, visualText) => {
        expect(pdfFallbackBidiLine(source, source)).toMatchObject({direction, visualText, advance: .5});
    });
    it.each([rtl, ltr])('retains every source UTF16 occurrence, ordinary space and punctuation for the real complete target', source => {
        const result = pdfFallbackBidiLine(source, source)!;
        expect(result.direction).toBe(source === rtl ? 'rtl' : 'ltr');
        expect(result.visualIndices).toHaveLength(source.length);
        expect(new Set(result.visualIndices).size).toBe(source.length);
        const logical = Array<string>(source.length);
        result.visualIndices.forEach((original, visual) => {logical[original] = result.visualText[visual];});
        expect(logical.join('')).toBe(source);
        expect(result.visualText.split(' ').length).toBe(source.split(' ').length);
        expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.visualIndices)).toBe(true);
    });
    it.each(['', 'ASCII GPU A100 12.5%.', '中文 Ω ∑', ' שלום', 'שלום ', 'שלום  עולם', 'שלום\tעולם', 'שלום\u00a0עולם',
        'שלום\nעולם', 'שלום\r\nעולם', 'שלום\u2003עולם', 'שָלום', 'שלום\u200d', 'שלום\ufe0f', 'שלום😀', 'שלום\ud800', 'שלום\u0003',
        'שלום 가', 'שלום 각', 'שלום Ω', 'שלום مرحبا', 'שלום ױ', 'א <>', 'שלום <GPU>', 'שלום'.repeat(2049)])
    ('keeps unsupported or ordinary source on the legacy path: %j', source => {
        expect(pdfFallbackBidiLine(source, source)).toBeUndefined();
    });
    it('accepts the bounded UTF16 limit without truncating any occurrence', () => {
        const source = 'A'.repeat(8188) + 'שלום';
        expect(pdfFallbackBidiLine(source, source)?.visualIndices).toHaveLength(8192);
    });
    it('does not borrow a full paragraph identity for one wrapped or clipped line', () => {
        expect(pdfFallbackBidiLine('שלום', 'שלום עולם')).toBeUndefined();
        expect(pdfFallbackBidiLine('שלום…', 'שלום עולם')).toBeUndefined();
    });
    it.each(['א hello world', 'English שלום שלום שלום שלום'])
    ('declines when the canonical first-strong paragraph base disagrees with pinned stock reader: %s', source => {
        expect(pdfFallbackBidiLine(source, source)).toBeUndefined();
    });
    it.each(['English א 2026', 'מחקר 2026 GPU'])
    ('declines matching bases when the actual reader projection still changes the complete logical target: %s', source => {
        expect(pdfFallbackBidiLine(source, source)).toBeUndefined();
    });
    it('declines symmetric text when unchanged projected characters hide a conflicting paragraph direction', () => {
        const source = 'א aaaaaaaa א';
        expect(projectPdfReaderBidi(source)).toEqual({str: source, dir: 'ltr'});
        expect(pdfFallbackBidiLine(source, source)).toBeUndefined();
    });
    it.each(['paragraphs', 'missing', 'sparse paragraph', 'start', 'end', 'level', 'length', 'duplicate', 'negative', 'outside', 'fraction'])
    ('fails closed if the opaque UBA result loses occurrence integrity: %s', kind => {
        fault.kind = kind; expect(pdfFallbackBidiLine('שלום', 'שלום')).toBeUndefined();
    });
    it('restores the original direction after successful measurement and after paint throws', () => {
        const context = {direction: 'inherit'};
        expect(withPdfFallbackBidiDirection(context, 'rtl', () => {expect(context.direction).toBe('rtl'); return 42;})).toBe(42);
        expect(context.direction).toBe('inherit');
        const error = new Error('actual paint failed');
        expect(() => withPdfFallbackBidiDirection(context, 'ltr', () => {throw error;})).toThrow(error);
        expect(context.direction).toBe('inherit');
    });
});
