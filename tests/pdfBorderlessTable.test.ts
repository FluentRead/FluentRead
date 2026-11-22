import {describe, expect, it} from 'vitest';
import {findBorderlessTables, findRuledTableDividers} from '@/src/features/document-translation/core/pdfBorderlessTable';
import {analyzePdfPageLayout, type PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
import fixture from './fixtures/pdf-borderless-cjk-table.json';
const line = (text: string, x: number, y: number, width = 45): PdfLayoutAtom => ({text, x, y, width, height: 10, fontSize: 10, baseline: y + 9, fontFamily: 'sans-serif'});
const sample = () => [line('Table 1. Measurements', 40, 100, 160), ...Array.from({length: 4}, (_, row) =>
    ['Method', 'Count', 'Error'].map((text, column) => line(row ? [String.fromCharCode(64 + row), String(128 * row), `0.${row}`][column] : text, [45, 170, 280][column], 135 + row * 25))).flat()];

describe('captioned borderless numeric tables', () => {
    it.each(fixture.pages.map((page, index) => [index, page] as const))('replays actual Chinese scan %i as sixteen ordered cells after both body columns', (index, page) => {
        const before = structuredClone(page.atoms), tables = findBorderlessTables(page.atoms, [], page.width);
        expect(tables).toHaveLength(1);
        const layout = analyzePdfPageLayout({...page, graphics: []});
        const cells = layout.blocks.filter(block => block.kind === 'table');
        expect(cells).toHaveLength(16);
        expect(cells.slice(0, 4).map(block => block.source)).toEqual(['方法', '样本数量', '平均误差', index === 2 ? 'FE (ms)' : '耗时(ms)']);
        expect(cells.filter(block => /^\d/u.test(block.source)).map(block => block.source)).toEqual(['128','0.12','25.4','128','0.18','20.1','256','0.09','38.6']);
        expect(cells.filter(block => /^\d/u.test(block.source)).every(block => block.preserveSource)).toBe(true);
        // 100 dpi 的最后一个表头仍是 OCR 的 FE (ms)，布局推断不得擅自修正文案。
        if (index === 2) expect(cells[3].preserveSource).toBe(true);
        expect(cells.every(block => block.cellBounds && block.x >= block.cellBounds.x && block.x + block.width <= block.cellBounds.x + block.cellBounds.width)).toBe(true);
        const caption = layout.blocks.findIndex(block => block.source.startsWith('表1'));
        expect(layout.blocks[caption].kind).toBe('caption');
        expect(layout.blocks.indexOf(cells[0])).toBe(caption + 1);
        expect(layout.blocks.findIndex(block => block.source.startsWith('结果显示'))).toBeLessThan(caption);
        expect(page.atoms).toEqual(before);
    });
    it('infers logical cell edges without adding source characters or mutating input', () => {
        const atoms = sample(), before = structuredClone(atoms), result = findBorderlessTables(atoms, [], 612);
        expect(result).toHaveLength(1); expect(result[0].caption).toBe(atoms[0]);
        expect(result[0].dividers.filter(box => box.width === 0)).toHaveLength(2);
        expect(result[0].dividers.filter(box => box.height === 0)).toHaveLength(5); expect(atoms).toEqual(before);
    });
    it.each(['noCaption','badFont','empty','distant','short','columns','wide','header','missing','misaligned','largeGap','tightGap','font','prose','digits','spacing','adjacentCaption','graphic','duplicate'])('rejects unsupported %s evidence or keeps a single confirmed table', reason => {
        let atoms = sample(); let graphics: Array<{x: number; y: number; width: number; height: number}> = [];
        if (reason === 'noCaption') atoms[0].text = 'Ordinary paragraph';
        if (reason === 'badFont') atoms[0].fontSize = NaN;
        if (reason === 'empty') atoms = [atoms[0]];
        if (reason === 'distant') atoms.slice(1).forEach(atom => {atom.y += 100; atom.baseline += 100;});
        if (reason === 'short') atoms.splice(-3);
        if (reason === 'columns') atoms = atoms.filter((_, index) => index === 0 || index % 3 !== 0);
        if (reason === 'wide') atoms.splice(1, 0, ...Array.from({length: 6}, (_, i) => line('Extra', 330 + i * 40, 135, 20)));
        if (reason === 'header') atoms[1].text = '128';
        if (reason === 'missing') atoms.splice(7, 1);
        if (reason === 'misaligned') atoms[5].x += 30;
        if (reason === 'largeGap') atoms.slice(4).forEach(atom => {atom.y += 80; atom.baseline += 80;});
        if (reason === 'tightGap') atoms.slice(4, 7).forEach(atom => {atom.y -= 16; atom.baseline -= 16;});
        if (reason === 'font') atoms[5].fontSize = 30;
        if (reason === 'prose') atoms[4].text = 'A'.repeat(51);
        if (reason === 'digits') atoms[6].text = 'unknown';
        if (reason === 'spacing') atoms[2].width = 100;
        if (reason === 'adjacentCaption') atoms.push(line('Table 2. Other', 250, 100));
        if (reason === 'graphic') graphics = [{x: 40, y: 130, width: 300, height: 100}];
        if (reason === 'duplicate') atoms.push({...atoms[0]});
        expect(findBorderlessTables(atoms, graphics, 612)).toHaveLength(reason === 'duplicate' ? 1 : 0);
    });
    it('bounds work and does not borrow a neighboring caption or following paragraph as table cells', () => {
        const atoms = sample(); atoms.push(line('Following ordinary prose.', 40, 260, 400));
        expect(findBorderlessTables(atoms, [], 612)).toHaveLength(1);
        expect(findBorderlessTables([...sample(), ...Array.from({length: 513}, (_, i) => line('extra', 45, 250 + i * .01))], [], 612)).toEqual([]);
    });
});

describe('ruled three-line table dividers set below their caption', () => {
    const rules = () => [{x: 40, y: 40, width: 300, height: 0}, {x: 40, y: 65, width: 300, height: 0}, {x: 40, y: 90, width: 300, height: 0}];
    // 表题在下、三线在上：表头与首条记录以相同列起点重复对齐，且首条记录含两个数值。
    const ruled = () => [line('表1 测量结果', 40, 100, 120), line('方法', 40, 45, 40), line('数量', 140, 45, 40), line('误差', 250, 45, 40),
        line('A', 40, 70, 40), line('128', 140, 70, 40), line('0.12', 250, 70, 40)];
    it('places one logical boundary in the blank between each aligned column', () => {
        expect(findRuledTableDividers(ruled(), rules(), 612)).toEqual([
            {x: 110, y: 40, width: 0, height: 50}, {x: 215, y: 40, width: 0, height: 50},
        ]);
    });
    it.each(['twoRules', 'unevenRules', 'narrowRuleGap', 'noHeader', 'noData', 'narrowRow', 'wideRow', 'noNumbers', 'misaligned', 'tightGap'])('rejects %s evidence without deriving cells', reason => {
        const atoms = ruled(), lines = rules();
        if (reason === 'twoRules') lines[0].x = 45;
        if (reason === 'unevenRules') {lines[0].y = 50; lines[1].y = 55;}
        if (reason === 'narrowRuleGap') lines[1].y = 85;
        if (reason === 'noHeader') atoms.slice(1, 4).forEach(atom => {atom.y = 66; atom.baseline = 75;});
        if (reason === 'noData') atoms.slice(4).forEach(atom => {atom.y = 50; atom.baseline = 59;});
        if (reason === 'narrowRow') {atoms[6].y = 100; atoms[6].baseline = 109;}
        if (reason === 'wideRow') atoms.push(...Array.from({length: 11}, (_, i) => line(i % 2 ? '7' : 'extra', 60 + i * 18, 70, 16)));
        if (reason === 'noNumbers') {atoms[5].text = 'B'; atoms[6].text = 'C';}
        if (reason === 'misaligned') atoms[5].x = 100;
        if (reason === 'tightGap') {atoms[2].x = 81; atoms[5].x = 81;}
        expect(findRuledTableDividers(atoms, lines, 612)).toEqual([]);
    });
});
