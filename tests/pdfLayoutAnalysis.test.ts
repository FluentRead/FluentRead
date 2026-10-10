/**
 * @file tests/pdfLayoutAnalysis.test.ts
 * 文件职责：验证 PDF 阅读分析不会把分栏、表格、公式、上下标或插图误当作一个可覆盖的正文框。
 * 主要内容：使用真实绘图操作语义和可复现字形几何验证矩阵、裁剪、行关联、语义边界与阅读顺序，并覆盖长文的几何读取上限。
 * 模块边界：测试纯分析模块；真实 PDF 提取和来源字节不变由 PDF 解析集成测试补充。
 */
import {describe, expect, it} from 'vitest';
import {analyzePdfPageLayout, extractPdfGraphicsShapes, pdfLayoutLines, type PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';

const atom = (text: string, x: number, baseline: number, width = text.length * 5, fontSize = 10): PdfLayoutAtom => ({text, x, y: baseline - fontSize * .8, width, height: fontSize, baseline, fontSize, fontFamily: 'sans-serif'});
const analyze = (atoms: PdfLayoutAtom[], graphics: Parameters<typeof analyzePdfPageLayout>[0]['graphics'] = [], width = 612, height = 792) => analyzePdfPageLayout({atoms, graphics, width, height});
const ops = Object.fromEntries(['save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'constructPath', 'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'endPath'].map((name, index) => [name, index + 1]));

describe('PDF visible graphics geometry', () => {
    it('tracks saves, nested form matrices, image unit squares, visible paths and viewport orientation', () => {
        const functions = ['restore', 'save', 'transform', 'paintImageXObject', 'paintFormXObjectBegin', 'paintInlineImageXObject', 'paintFormXObjectEnd', 'paintImageMaskXObject', 'restore', 'constructPath', 'constructPath', 'stroke', 'constructPath', 'endPath', 'fill', 'paintFormXObjectBegin', 'paintFormXObjectEnd'];
        const args = [null, null, [100, 0, 0, 80, 10, 20], ['image', 200, 300], [[1, 0, 0, 1, .1, .1], [0, 0, .5, .5]], [{}], null, [{}], null, [[], [], [20, 30, 40, 50]], [[], [], [10, 20, 25, 35]], null, [[], [], [10, 10, 20, 20]], null, null, [null, null], null];
        const shapes = extractPdfGraphicsShapes({fnArray: functions.map(name => ops[name]), argsArray: args}, ops, {width: 300, height: 300, transform: [1, 0, 0, -1, 0, 300]});
        expect(shapes).toEqual([
            {kind: 'image', x: 10, y: 200, width: 100, height: 80},
            {kind: 'form', x: 20, y: 232, width: 50, height: 40},
            {kind: 'image', x: 20, y: 192, width: 100, height: 80},
            {kind: 'image', x: 10, y: 200, width: 100, height: 80},
            {kind: 'path', x: 10, y: 250, width: 30, height: 30},
        ]);
    });
    it('clips page edges, rejects invalid/outside/empty drawings, and handles absent operands', () => {
        const list = {fnArray: [ops.transform, ops.paintImageXObject, ops.restore, ops.transform, ops.paintImageXObject, ops.restore, ops.constructPath, ops.fill, ops.constructPath, ops.stroke, ops.transform, ops.paintFormXObjectBegin, 999], argsArray: [[20, 0, 0, 20, -10, -10], [], null, [1, 0, 0, 1, 400, 400], [], null, [[], [], [NaN, 0, 1, 1]], null, [[], [], [1, 1, 1, 1]], null, null, null, null]};
        expect(extractPdfGraphicsShapes(list, ops, {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]})).toEqual([{kind: 'image', x: 0, y: 0, width: 10, height: 10}]);
    });
});

describe('PDF baseline and structural reading analysis', () => {
    it('keeps superscripts with their baseline and rejoins numbered section headings', () => {
        const lines = pdfLayoutLines([atom('h', 50, 50, 5), atom('t', 55, 53, 3, 7), atom('=', 62, 50, 5), atom('value', 70, 50, 25), atom('1', 50, 80, 5, 12), atom('Introduction', 69, 80, 90, 12)]);
        expect(lines).toHaveLength(2); expect(lines[0].text).toBe('ht = value'); expect(lines[0].fontSize).toBe(10); expect(lines[0].runs).toHaveLength(4);
        expect(lines[1].text).toBe('1 Introduction');
        const result = analyze([atom('1 Introduction', 50, 50, 120, 12), atom('Body sentence continues', 50, 75, 400), atom('on the next source line.', 50, 86, 400)]);
        expect(result.blocks.map(block => block.kind)).toEqual(['heading', 'text']);
        expect(result.blocks[1]).toMatchObject({textAlign: 'left', lineHeight: 11, fontSize: 10, lineCount: 2, preserveSource: false});
    });
    it('preserves display equations and their scripts/numbers while translating surrounding and inline prose', () => {
        const result = analyze([atom('We use Q = K and compare the values.', 108, 100, 396), atom('Attention(Q,K,V) = softmax(', 200, 140, 170), atom('QK', 340, 133, 15), atom('T', 355, 130, 4, 7), atom('dk', 353, 151, 8, 7), atom('(1)', 493, 140, 11), atom('The following paragraph is ordinary prose.', 108, 180, 396)]);
        expect(result.preservedRegions).toHaveLength(1); expect(result.preservedRegions[0]).toMatchObject({kind: 'formula'});
        expect(result.preservedRegions[0].source).toContain('Attention'); expect(result.preservedRegions[0].source).toContain('(1)');
        expect(result.blocks.filter(block => block.kind === 'text').map(block => block.source)).toEqual(['We use Q = K and compare the values.', 'The following paragraph is ordinary prose.']);
        expect(result.blocks.filter(block => block.kind === 'formula').every(block => block.preserveSource)).toBe(true);
    });
    it('preserves table cells and image/vector regions but keeps captions and adjacent prose editable', () => {
        const atoms = [atom('Table 1: measured results', 108, 80, 300), atom('Model', 110, 110, 45), atom('Score', 320, 110, 45), atom('Baseline', 110, 125, 60), atom('24.9', 320, 125, 25), atom('A paragraph after the table.', 108, 170, 396), atom('Image label', 180, 230, 80), atom('Figure 1: original graphic', 108, 290, 300)];
        const graphics = [{kind: 'path' as const, x: 108, y: 96, width: 396, height: 0}, {kind: 'path' as const, x: 108, y: 138, width: 396, height: 0}, {kind: 'image' as const, x: 170, y: 200, width: 150, height: 60}, {kind: 'form' as const, x: 180, y: 205, width: 160, height: 60}, {kind: 'path' as const, x: 170, y: 220, width: 100, height: 40}, {kind: 'image' as const, x: 0, y: 0, width: 612, height: 792}];
        const result = analyze(atoms, graphics);
        expect(result.preservedRegions.map(region => region.kind)).toEqual(['table', 'figure']);
        expect(result.preservedRegions[1]).toMatchObject({x: 170, y: 200, width: 170, height: 65});
        // 含词语的单元格各自成段并可翻译；纯数字单元格保留原样。
        expect(result.blocks.filter(block => block.kind === 'table').map(block => [block.source, block.preserveSource])).toEqual([['Model', false], ['Baseline', false], ['Score', false], ['24.9', true]]);
        expect(result.blocks.find(block => block.source === 'Image label')?.kind).toBe('figure-label');
        expect(result.blocks.filter(block => block.kind === 'caption').every(block => !block.preserveSource)).toBe(true);
        expect(result.blocks.find(block => block.source === 'A paragraph after the table.')?.textAlign).toBe('left');
    });
    it('uses actual table dividers to separate tight cells and prevents lowercase records from wrapping across rows', () => {
        const graphics = [94, 105, 149].map(y => ({kind: 'path' as const, x: 145, y, width: 322, height: 0}));
        for (const x of [296.58, 408.5]) for (const y of [94, 105, 116, 127, 138]) graphics.push({kind: 'path', x, y, width: 0, height: 11});
        const atoms = [atom('Parser', 206, 102, 28), atom('Training', 334, 102, 37), atom('Score', 429, 102, 20),
            atom('A. Model et al. (2014) [37]', 151, 113, 140), atom('WSJ only, discriminative', 302.5, 113, 100), atom('good', 429, 113, 20),
            atom('Second Model', 172, 124, 96), atom('semi-supervised', 320, 124, 65), atom('good', 429, 124, 20),
            atom('Third Model', 177, 135, 87), atom('multi-task', 332, 135, 40), atom('good', 429, 135, 20),
            atom('Final Model', 178, 146, 86), atom('generative', 332, 146, 41), atom('good', 429, 146, 20)];
        const before = structuredClone(atoms);
        const cells = analyze(atoms, graphics).blocks;
        expect(cells).toHaveLength(15);
        expect(cells.every(cell => cell.kind === 'table' && cell.lineCount === 1 && !cell.preserveSource)).toBe(true);
        expect(cells.some(cell => cell.source.includes('[37] WSJ'))).toBe(false);
        expect(cells.filter(cell => cell.x >= 296.58 && cell.x < 408.5).map(cell => cell.source)).toEqual(['Training', 'WSJ only, discriminative', 'semi-supervised', 'multi-task', 'generative']);
        expect(cells.filter(cell => cell.x < 296.58).every(cell => cell.cellBounds && cell.cellBounds.x + cell.cellBounds.width === 296.58)).toBe(true);
        expect(cells.filter(cell => cell.source === 'good').every(cell => cell.cellBounds!.height <= 11)).toBe(true);
        expect(atoms).toEqual(before);
    });
    it('recognizes shaded table rows and a shallow abstract box without treating real diagram labels as body text', () => {
        const graphics = [100, 125, 150, 175].map(y => ({kind: 'path' as const, x: 0, y, width: 508, height: 25}));
        const atoms = [100, 125, 150, 175].flatMap((y, row) => [atom(row ? 'Page dimensions' : 'Capability', 8, y + 16, 70, 8),
            atom(row ? 'Preserved' : 'Expected', 163, y + 16, 40, 8), atom(row ? 'Non-text graphics stay in place' : 'Evidence', 268, y + 16, 160, 8)]);
        const table = analyze(atoms, graphics);
        expect(table.preservedRegions).toMatchObject([{kind: 'table', x: 0, y: 100, width: 508, height: 100}]);
        expect(table.blocks).toHaveLength(12); expect(table.blocks.every(cell => cell.kind === 'table' && !cell.preserveSource)).toBe(true);
        expect(table.blocks.find(cell => cell.source === 'Capability')!.cellBounds).toEqual({x: 0, y: 100, width: 155, height: 25});
        const summary = analyze([atom('ABSTRACT', 60, 105, 46, 8.5), atom('A document translator should preserve columns and ordinary words while retaining source graphics.', 60, 119, 480, 9),
            atom('Parse', 340, 220, 22, 8), atom('Translate', 417, 220, 36, 8)],
        [{kind: 'path', x: 48, y: 89, width: 516, height: 51}, {kind: 'path', x: 318, y: 201, width: 66, height: 38}, {kind: 'path', x: 402, y: 201, width: 66, height: 38}]);
        expect(summary.blocks.find(block => block.source === 'ABSTRACT')).toMatchObject({kind: 'heading', preserveSource: false});
        expect(summary.blocks.filter(block => block.kind === 'figure-label').map(block => block.source)).toEqual(['Parse', 'Translate']);
    });
    it('associates the raised radical with its adjacent radicand instead of the preceding prose line', () => {
        const items = [atom('the two embedding layers and the pre-softmax', 108, 709.091, 396, 9.9626),
            atom('linear transformation; we multiply those weights by', 108, 720, 361.5, 9.9626),
            {...atom('√', 471.882, 712.292, 8.30183458, 9.9626), y: 704.82005},
            atom('d', 480.185, 720, 5.1855, 9.9626), atom('model', 485.37, 721.494, 17.4345, 6.9738), atom('.', 503.303, 720, 2.44, 9.9626)];
        const before = structuredClone(items), result = analyze(items);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].source).toBe('the two embedding layers and the pre-softmax linear transformation; we multiply those weights by √dmodel.');
        expect(result.blocks[0]).toMatchObject({kind: 'text', preserveSource: false, lineCount: 2});
        expect(result.blocks[0].lines![1].runs!.find(run => run.text === '√')).toMatchObject({x: 471.882, y: 704.82005});
        const equation = analyze([atom('f(x) =', 200, 120, 40), atom('√', 243, 120, 8), atom('x', 251, 120, 5)]);
        expect(equation.blocks[0]).toMatchObject({source: 'f(x) = √x', kind: 'formula', preserveSource: true});
        expect(items).toEqual(before);
    });
    it('keeps author/email columns independent and reads regular column bands left to right', () => {
        const authors = [atom('Alice', 60, 100, 40), atom('Bob', 230, 100, 30), atom('Carol', 400, 100, 40), atom('alice@example.org', 50, 112, 110), atom('bob@example.org', 210, 112, 100), atom('carol@example.org', 380, 112, 110)];
        const result = analyze(authors);
        expect(result.blocks).toHaveLength(3); expect(result.blocks.every(block => block.kind === 'metadata' && block.preserveSource)).toBe(true);
        expect(result.blocks.map(block => block.source)).toEqual(['Alice alice@example.org', 'Bob bob@example.org', 'Carol carol@example.org']);
        const columns = analyze([atom('1 Heading', 40, 50, 150, 14), atom('Left first line', 40, 100, 220), atom('Right first line', 330, 100, 220), atom('Left continuation.', 40, 111, 220), atom('Right continuation.', 330, 111, 220), atom('Left second paragraph.', 40, 145, 220), atom('Right second paragraph.', 330, 145, 220), atom('2', 300, 750, 5)]);
        expect(columns.blocks.map(block => block.source)).toEqual(['1 Heading', 'Left first line Left continuation.', 'Left second paragraph.', 'Right first line Right continuation.', 'Right second paragraph.', '2']);
        expect(columns.blocks.map(block => block.readingOrder)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(columns.blocks.at(-1)).toMatchObject({kind: 'footer', preserveSource: true});
    });
    it('retains explicit hyphens, paragraph boundaries, varied leading and empty pages', () => {
        expect(analyze([])).toEqual({blocks: [], preservedRegions: []});
        const result = analyze([atom('An unfinished trans-', 50, 50, 400), atom('lation line.', 50, 62, 400), atom('Indented paragraph starts.', 65, 78, 385), atom('Second continuation', 65, 90, 300), atom('not attached across columns', 400, 92, 150), atom('Prose ends before caption.', 50, 118, 350), atom('Figure 2: caption begins', 50, 130, 350), atom('and ends here.', 50, 141, 350), atom('Abstract', 280, 180, 50, 12)]);
        expect(result.blocks[0].source).toBe('An unfinished translation line.');
        expect(result.blocks.some(block => block.source === 'Indented paragraph starts. Second continuation')).toBe(true);
        expect(result.blocks.find(block => block.kind === 'caption')?.source).toBe('Figure 2: caption begins and ends here.');
        expect(result.blocks.find(block => block.source === 'Prose ends before caption.')?.kind).toBe('text');
        expect(result.blocks.find(block => block.source === 'Abstract')?.textAlign).toBe('center');
    });
    it('keeps narrow column headings within their column while a centered page title separates bands', () => {
        const result = analyze([atom('Page title', 260, 40, 92, 20), atom('2 Left section', 40, 80, 140, 14), atom('4 Right section', 330, 80, 150, 14), atom('Left ordinary paragraph.', 40, 110, 220), atom('Right ordinary paragraph.', 330, 110, 220), atom('3 Left next section', 40, 160, 160, 14), atom('Left final paragraph.', 40, 190, 220), atom('Right final paragraph.', 330, 150, 220)]);
        expect(result.blocks.map(block => block.source)).toEqual(['Page title', '2 Left section', 'Left ordinary paragraph.', '3 Left next section', 'Left final paragraph.', '4 Right section', 'Right ordinary paragraph.', 'Right final paragraph.']);
        expect(result.blocks.slice(1, 5).every(block => block.column === 0)).toBe(true);
        expect(result.blocks.slice(5).every(block => block.column === 1)).toBe(true);
    });
    it('processes a fragmented long row without repeated geometry scans or argument-list overflow', () => {
        let reads = 0;
        const count = 20000;
        const atoms = Array.from({length: count}, (_, index) => new Proxy(atom('a', index, 20, 1), {get(target, key, receiver) {if (key === 'baseline' || key === 'fontSize') reads += 1; return Reflect.get(target, key, receiver);}}));
        const lines = pdfLayoutLines(atoms);
        expect(lines).toHaveLength(1); expect(lines[0].text).toHaveLength(count); expect(reads).toBeLessThan(count * 30);
        let geometryReads = 0;
        const paragraphs = Array.from({length: 3000}, (_, index) => new Proxy(atom('Independent paragraph.', 50, 50 + index * 30, 400), {get(target, key, receiver) {if (key === 'x' || key === 'baseline') geometryReads += 1; return Reflect.get(target, key, receiver);}}));
        expect(analyze(paragraphs, [], 612, 100000).blocks).toHaveLength(paragraphs.length);
        expect(geometryReads).toBeLessThan(paragraphs.length * 40);
    });
    it('recognizes side equations and large headings, merges related equations, and orders separate drawings', () => {
        const result = analyze([atom('Large title', 240, 50, 130, 18), atom('A regular sentence is not an equation.', 50, 80, 400), atom('F(x) = 1', 10, 120, 50), atom('G(x) = 2', 10, 133, 50), atom('∑x', 10, 190, 30), atom('Figure 3: x = y', 250, 230, 100)], [{kind: 'image', x: 300, y: 300, width: 50, height: 50}, {kind: 'form', x: 100, y: 300, width: 50, height: 50}]);
        expect(result.blocks[0].kind).toBe('heading');
        expect(result.preservedRegions.filter(region => region.kind === 'formula')).toHaveLength(1);
        expect(result.blocks.find(block => block.source === '∑x')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source === 'Figure 3: x = y')?.kind).toBe('caption');
        expect(result.preservedRegions.filter(region => region.kind === 'figure').map(region => region.x)).toEqual([100, 300]);
    });
    it('chooses the most recent eligible baseline when small source labels visually overlap larger lines', () => {
        const result = analyze([atom('Earlier small label', 50, 100, 150, 5), atom('Current larger row.', 50, 112, 350, 21), atom('Next line continues', 60, 124, 350, 20), atom('Body reference', 50, 200, 400, 20), atom('Another body reference', 50, 225, 400, 20)]);
        const block = result.blocks.find(block => block.source.includes('Next line continues'))!;
        expect(block.source).toBe('Current larger row. Next line continues');
        expect(block.lines).toHaveLength(2);
    });
    it('reads offset side-by-side graphics left to right without combining distinct vertical figure bands', () => {
        const graphics = [
            {kind: 'image' as const, x: 300, y: 84, width: 120, height: 185},
            {kind: 'image' as const, x: 100, y: 96, width: 64, height: 127},
            {kind: 'image' as const, x: 300, y: 350, width: 60, height: 100},
            {kind: 'image' as const, x: 100, y: 410, width: 60, height: 100},
        ];
        const result = analyze([], graphics);
        expect(result.preservedRegions.map(region => [region.x, region.y])).toEqual([[100, 96], [300, 84], [300, 350], [100, 410]]);
    });
    it('keeps nearby centered diagram titles inside the source crop without absorbing captions or ordinary prose', () => {
        const result = analyze([atom('Diagram title', 110, 70, 80), atom('Figure 1: caption', 100, 60, 100), atom('Ordinary prose.', 300, 70, 100), atom('Full width body continues', 108, 242, 396)], [
            {kind: 'image', x: 100, y: 84, width: 100, height: 100},
            {kind: 'image', x: 300, y: 84, width: 100, height: 100},
            {kind: 'image', x: 108, y: 250, width: 396, height: 70},
        ]);
        const left = result.preservedRegions.find(region => region.kind === 'figure' && region.x === 100)!;
        expect(left).toMatchObject({y: 62, height: 122}); expect(left.source).toBe('Diagram title');
        expect(result.blocks.find(block => block.source === 'Diagram title')?.kind).toBe('figure-label');
        expect(result.blocks.find(block => block.source === 'Figure 1: caption')?.kind).toBe('caption');
        expect(result.blocks.find(block => block.source === 'Ordinary prose.')?.preserveSource).toBe(false);
        expect(result.blocks.find(block => block.source === 'Full width body continues')?.preserveSource).toBe(false);
        const math = analyze([atom('F(x) = QK', 310, 70, 80)], [{kind: 'image', x: 300, y: 84, width: 100, height: 100}]);
        expect(math.preservedRegions.find(region => region.kind === 'figure')?.y).toBe(84);
    });
    it('keeps the two clipped embedded titles in Attention page fifteen inside its preserved diagram', () => {
        // 实际源图的两个 Form 上下接在一起；文字层含大字号 Input-Input 标题，但它们被图形裁掉，不能重新印到图内竖排标签上。
        const first = {...atom('Input-Input Layer5', 106.973484208, 127.7375646, 171.135371154, 19.618866348), y: 112.042471529};
        const second = {...atom('Input-Input Layer5', 106.765759931, 345.994745345, 171.219290714, 19.628486841), y: 330.291955873};
        const result = analyze([first, second,
            atom('Figure 5: Many of the attention heads exhibit behaviour that seems related to the structure of the sentence.', 108, 611.169, 396, 9.9626),
            atom('We give two such examples above, from two different heads from the encoder self-attention', 108, 622.079, 396, 9.9626),
            atom('at layer 5 of 6. The heads clearly learned to perform different tasks.', 108, 632.989, 396, 9.9626),
        ], [{kind: 'form', x: 108, y: 158.07028396, width: 396.0208858, height: 218.93571604},
            {kind: 'form', x: 108, y: 377.006, width: 396.0208858, height: 218.93571604}]);
        expect(result.blocks.filter(block => block.source === 'Input-Input Layer5')).toHaveLength(2);
        expect(result.blocks.filter(block => block.source === 'Input-Input Layer5').every(block => block.kind === 'figure-label' && block.preserveSource)).toBe(true);
        expect(result.blocks.find(block => block.source.startsWith('Figure 5:'))).toMatchObject({kind: 'caption', preserveSource: false});
        const section = analyze([atom('2 Results', 108, 90, 80), atom('Ordinary text anchors the body font.', 108, 400, 396)],
            [{kind: 'image', x: 108, y: 104, width: 396, height: 150}]);
        expect(section.blocks.find(block => block.source === '2 Results')).toMatchObject({kind: 'heading', preserveSource: false});
    });
    it('preserves the equivalence display equation from the actual ninety-two-page paper', () => {
        const result = analyze([atom('The theorem establishes the following recovery equation.', 70.86614, 100, 453.5433, 11),
            atom('𝑔𝑢(𝛾𝑢) ≃ (Ψ𝑡𝑙 ∘ ⋯ ∘ Ψ𝑡1)(𝛾𝑏) (55)', 225.24985, 127.10103, 299.15959, 11),
            atom('That is, applying the accumulator leaves every table where those same steps would have left it.', 70.86614, 151.37996, 453.5433, 11)]);
        expect(result.blocks.find(block => block.source.includes('(55)'))).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.filter(block => block.kind === 'text')).toHaveLength(2);
    });
    it('keeps raised and lowered scripts with the real page-forty-six body line instead of manufacturing overlapping tail blocks', () => {
        const real = (text: string, x: number, y: number, width: number, fontSize: number, baseline: number) => ({...atom(text, x, baseline, width, fontSize), y});
        const atoms = [
            real('outside the two declarations, and the instantiating iteration is the case where the two states', 70.86614, 454.3126, 453.543307536, 11, 462.2986),
            real('differ in an entry with an empty table that', 70.86614, 467.9746, 207.699113072, 11, 475.9606),
            real('≃', 281.80164, 467.0946, 8.558, 11, 475.9606),
            real('𝐾', 290.35965, 472.4714, 7.392, 7.7, 478.6776),
            real('does not compare. Since', 301.965939134, 467.9746, 118.543167402, 11, 475.9606),
            real('𝑔', 423.74548, 467.0946, 5.247, 11, 475.9606),
            real('𝑢', 429.2675, 465.7614, 5.1975, 7.7, 471.9676),
            real('𝑛', 428.9925, 472.4714, 5.4362, 7.7, 478.6776),
            real('carries', 438.317389134, 467.9746, 32.164, 11, 475.9606),
            real('≃', 473.71777, 467.0946, 8.558, 11, 475.9606),
            real('𝐾', 482.27576, 472.4714, 7.392, 7.7, 478.6776),
            real('by the', 493.882049134, 467.9746, 30.527389134, 11, 475.9606),
            real('paragraph above,', 70.86614, 481.6366, 84.623, 11, 489.6226),
        ];
        const lines = pdfLayoutLines(atoms);
        expect(lines).toHaveLength(3);
        expect(lines[1].text).toContain('does not compare. Since');
        expect(lines[1].text).toContain('carries ≃𝐾 by the');
        expect(lines[1].runs).toHaveLength(11);
        const result = analyze(atoms, [], 595.2756, 841.8898);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({kind: 'text', lineCount: 3, preserveSource: false});
        expect(result.blocks[0].source).toContain('does not compare. Since');
    });
});

describe('PDF layout analysis on real paper typography', () => {
    const words = (text: string, x: number, baseline: number, gap: number, fontSize = 10) => {let at = x; return text.split(' ').map(word => {const item = atom(word, at, baseline, word.length * 5, fontSize); at += word.length * 5 + gap; return item;});};
    it('keeps a loosely justified line whole between dense neighbours while still splitting real column gutters', () => {
        const dense = (baseline: number) => atom('dense line of ordinary body text that fills the entire column', 50, baseline, 240);
        const lines = pdfLayoutLines([dense(100), ...words('only reading times but also neural responses', 50, 112, 11), dense(124)]);
        expect(lines.map(line => line.text)).toEqual(['dense line of ordinary body text that fills the entire column', 'only reading times but also neural responses', 'dense line of ordinary body text that fills the entire column']);
        // 左栏松散、右栏正常：只有被上下行共同让出的栏间距才断开。
        const columns = pdfLayoutLines([dense(100), atom('right column line one', 330, 100, 220), ...words('only reading times but also neural', 50, 112, 11), ...words('right column line two has many small gaps', 330, 112, 3), dense(124), atom('right column line three', 330, 124, 220)]);
        expect(columns.filter(line => line.baseline === 112).map(line => line.text)).toEqual(['only reading times but also neural', 'right column line two has many small gaps']);
    });
    it('does not split an isolated numbered example at a small gap but splits isolated rows at wide gaps', () => {
        const lines = pdfLayoutLines([atom('(2)', 45, 60, 11), atom('The children went outside to. . .', 65, 60, 120), atom('Running header', 200, 30, 140, 6), atom('303', 500, 30, 12, 6)]);
        expect(lines.map(line => line.text)).toEqual(['Running header', '303', '(2) The children went outside to. . .']);
        // 一侧被上方通栏内容占用、另一侧没有邻行：宽间距仍按栏间距处理，窄间距不拆。
        const band = pdfLayoutLines([atom('A full width paragraph line that crosses the gutter completely here', 50, 100, 500), atom('Left start', 50, 112, 200), atom('Right start', 330, 112, 200)]);
        expect(band.map(line => line.text)).toEqual(['A full width paragraph line that crosses the gutter completely here', 'Left start', 'Right start']);
        const narrow = pdfLayoutLines([atom('A full width paragraph line that crosses the gutter completely here', 50, 100, 500), atom('word', 50, 112, 20), atom('next', 82, 112, 20)]);
        expect(narrow.at(-1)!.text).toBe('word next');
    });
    it('classifies running headers and footers only when they are detached from the text block', () => {
        const page = analyze([atom('N.J. Smith / Cognition 128 (2013)', 200, 36, 150, 6.4), atom('303', 500, 36, 12, 6.4), atom('Body paragraph starts well below the running header.', 40, 70, 400), atom('It continues on the next line of the same paragraph.', 40, 82, 400), atom('Downloaded from example.org', 40, 780, 150, 6.4)]);
        expect(page.blocks.filter(block => block.kind === 'footer').map(block => block.source)).toEqual(['N.J. Smith / Cognition 128 (2013)', '303', 'Downloaded from example.org']);
        expect(page.blocks.find(block => block.source.startsWith('Body'))).toMatchObject({kind: 'text', readingOrder: 2});
        // 贴近页顶的正文首行、以及页顶的大号幻灯片标题都不是页眉。
        const attached = analyze([atom('First body line sits near the top edge', 40, 40, 300), atom('and continues right below it.', 40, 52, 300)]);
        expect(attached.blocks.map(block => block.kind)).toEqual(['text']);
        const slide = analyze([atom('Slide title', 40, 40, 200, 24), atom('Body copy of the slide is much smaller than its title text.', 40, 200, 400), atom('Second line of body copy keeps the body font dominant.', 40, 212, 400)]);
        expect(slide.blocks[0]).toMatchObject({kind: 'heading', source: 'Slide title'});
    });
    it('recognises dotted section numbers, appendix and acknowledgement headings, and rejects numbered list items and mid-paragraph numbers', () => {
        const body = (text: string, baseline: number, x = 40, width = 240) => atom(text, x, baseline, width);
        const result = analyze([atom('1. Introduction', 40, 100, 70), body('Making predictions about the future is a necessary part.', 121), body('It continues for another complete line of running text here', 133),
            atom('2. Theories relating word predictability and reading', 40, 170, 230), atom('time', 40, 182, 20), body('The simplest curve relates the two quantities directly today.', 203),
            atom('Acknowledgments', 40, 240, 80), body('This work was supported by a grant from a public agency.', 261),
            atom('Appendix A. Supplementary material', 40, 300, 160), body('Supplementary data are available online for this article now.', 321),
            atom('1. Omitting them could induce overconfidence in the', 44, 360, 236), atom('parametric form of the model.', 54, 372, 150),
            body('We retrieved the trace and compared the durations of the', 420), atom('4 PP stages within the same group of ranks across', 40, 432, 236), body('PP group, as shown in the figure. The timeline exhibits', 444),
            atom('1 Note that the term refers to something specific here', 40, 500, 200, 6.4), atom('10 MB to 2.7 KB per rank per step. Its progressive diagno-', 300, 100, 240), atom('sis framework isolates anomalous windows automatically.', 300, 112, 240)]);
        const headings = result.blocks.filter(block => block.kind === 'heading').map(block => block.source);
        expect(headings).toEqual(['1. Introduction', '2. Theories relating word predictability and reading time', 'Acknowledgments', 'Appendix A. Supplementary material']);
        expect(result.blocks.find(block => block.source.startsWith('1. Omitting'))).toMatchObject({kind: 'text', lineCount: 2});
        expect(result.blocks.find(block => block.source.includes('4 PP stages'))).toMatchObject({kind: 'text', lineCount: 3});
        expect(result.blocks.find(block => block.source.startsWith('1 Note'))?.kind).toBe('text');
        expect(result.blocks.find(block => block.source.startsWith('10 MB'))).toMatchObject({kind: 'text', lineCount: 2});
    });
    it('joins wrapped titles, including centred ones, without absorbing the next numbered heading or a full first body line', () => {
        const left = analyze([atom('The effect of word predictability on reading time', 40, 100, 300, 14), atom('is logarithmic', 40, 117, 90, 14), atom('Nathaniel Smith, Roger Levy', 40, 140, 170, 10.6), atom('Department of Cognitive Science, University of California', 40, 156, 250, 6.4), atom('Department of Linguistics, University of California too', 40, 164, 250, 6.4),
            ...Array.from({length: 6}, (_, index) => atom('Ordinary body text keeps the dominant font size of the page.', 40, 300 + index * 12, 300, 8))]);
        expect(left.blocks[0]).toMatchObject({kind: 'heading', source: 'The effect of word predictability on reading time is logarithmic', lineCount: 2});
        expect(left.blocks[1]).toMatchObject({source: 'Nathaniel Smith, Roger Levy', lineCount: 1});
        expect(left.blocks[2]).toMatchObject({kind: 'text', lineCount: 2, fontSize: 6.4});
        const centred = analyze([atom('ARGUS: Production-Scale Tracing and Performance', 150, 100, 312, 14), atom('Diagnosis for over 10,000-GPU Clusters', 186, 117, 240, 14), atom('2 Motivation and Design Space', 40, 200, 180, 12), atom('2.1 Motivation', 40, 216, 80, 12),
            ...Array.from({length: 6}, (_, index) => atom('Ordinary body text keeps the dominant font size of the page.', 40, 300 + index * 12, 300, 8))]);
        expect(centred.blocks.filter(block => block.kind === 'heading').map(block => block.source)).toEqual(['ARGUS: Production-Scale Tracing and Performance Diagnosis for over 10,000-GPU Clusters', '2 Motivation and Design Space', '2.1 Motivation']);
    });
    it('separates numbered examples and hanging-indent entries while keeping their continuation lines', () => {
        const result = analyze([atom('(3) After the show, a performer who had really', 45, 100, 200), atom('impressed the audience bowed.', 65, 112, 130), atom('(4) After the show, a performer bowed who had', 45, 124, 200), atom('really impressed the audience.', 65, 136, 130),
            atom('Frost, R. (1998). Toward a strong phonological theory of words.', 300, 100, 240), atom('Psychological Bulletin, 123(1), 71-99.', 312, 112, 160), atom('Genzel, D., and Charniak, E. (2002). Entropy rate constancy.', 300, 124, 240), atom('In Proceedings of the annual meeting of the association.', 312, 136, 228), atom('Hale, J. (2001). A probabilistic Earley parser as a model.', 300, 148, 240)]);
        expect(result.blocks.map(block => block.source)).toEqual(['(3) After the show, a performer who had really impressed the audience bowed.', '(4) After the show, a performer bowed who had really impressed the audience.',
            'Frost, R. (1998). Toward a strong phonological theory of words. Psychological Bulletin, 123(1), 71-99.', 'Genzel, D., and Charniak, E. (2002). Entropy rate constancy. In Proceedings of the annual meeting of the association.', 'Hale, J. (2001). A probabilistic Earley parser as a model.']);
    });
    it('preserves symbol-font equations and wordless fragments but keeps justified prose containing an equals sign', () => {
        const prose = (text: string, baseline: number) => atom(text, 40, baseline, 240);
        const result = analyze([prose('conditional probability then let us decompose the lexical', 100), atom('PðwhojCÞ ¼ Pðrel: clausejCÞ', 40, 124, 190), prose('The first term measures the syntactic predictability here', 148),
            prose('processed as /kan-/, /-di/ then k = 2; processing it as /k-/,', 160), prose('uously gives k = 1.) And, let f(x) be the function that gives', 172), atom('lim', 300, 200, 14), atom('k!1', 300, 208, 14, 6), atom('Xk', 330, 200, 12), atom('续文', 300, 260, 24)]);
        expect(result.preservedRegions.filter(region => region.kind === 'formula').map(region => region.source)).toEqual(['PðwhojCÞ ¼ Pðrel: clausejCÞ']);
        expect(result.blocks.find(block => block.source.includes('processed as'))).toMatchObject({kind: 'text', preserveSource: false});
        expect(result.blocks.filter(block => ['lim', 'k!1', 'Xk'].includes(block.source)).every(block => block.kind === 'formula' && block.preserveSource)).toBe(true);
        expect(result.blocks.find(block => block.source === '续文')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('cuts figures at their captions, keeps the picture below as its own figure and treats sentences inside a figure box as prose', () => {
        const atoms = [atom('axis label', 120, 140, 50, 6), atom('Figure 12. Case 2: trace of communication kernels. Rank 7', 100, 212, 300, 9), atom('shows longer operations in its own group.', 100, 223, 220, 9), atom('PP Stage 0', 110, 300, 50, 6),
            atom('Figure 13. Case 3: a short caption.', 100, 362, 180, 9), atom('We further verified this through the trace, as shown in the figure above and', 100, 390, 300), atom('It reveals a gap.', 100, 402, 80)];
        const result = analyze(atoms, [{kind: 'image', x: 100, y: 100, width: 300, height: 310}]);
        expect(result.preservedRegions.map(region => [region.kind, Math.round(region.y), Math.round(region.height)])).toEqual([['figure', 100, 103], ['figure', 227, 126], ['figure', 366, 44]]);
        expect(result.blocks.filter(block => block.kind === 'caption').map(block => block.source)).toEqual(['Figure 12. Case 2: trace of communication kernels. Rank 7 shows longer operations in its own group.', 'Figure 13. Case 3: a short caption.']);
        expect(result.blocks.filter(block => block.kind === 'figure-label').map(block => block.source).sort()).toEqual(['PP Stage 0', 'axis label']);
        expect(result.blocks.find(block => block.source.startsWith('We further verified'))).toMatchObject({kind: 'text', preserveSource: false, lineCount: 2});
        // 题注下方不足一行高的残余不是另一张图。
        const tail = analyze([atom('Figure 2. The caption sits at the very bottom of the box.', 100, 190, 280, 9)], [{kind: 'image', x: 100, y: 100, width: 300, height: 100}]);
        expect(tail.preservedRegions).toHaveLength(1);
    });
    it('turns worded table cells into separate translatable cells and joins only hyphenated or lower-case continuations', () => {
        const rules = [80, 100, 190].map(y => ({kind: 'path' as const, x: 40, y, width: 500, height: 0}));
        const result = analyze([atom('Category', 50, 94, 50), atom('Symptom', 300, 94, 50), atom('PCIe bandwidth degrada-', 50, 114, 120), atom('tion', 50, 126, 20), atom('Hidden size', 50, 138, 60), atom('Sequence length', 50, 150, 80),
            atom('Straggler rank identified', 300, 114, 130), atom('(via compute kernels)', 300, 126, 110), atom('2048', 300, 138, 20), atom('4096', 300, 150, 20)], rules);
        expect(result.blocks.filter(block => block.kind === 'table').map(block => [block.source, block.preserveSource])).toEqual([['Category', false], ['PCIe bandwidth degradation', false], ['Hidden size', false], ['Sequence length', false], ['Symptom', false], ['Straggler rank identified (via compute kernels)', false], ['2048', true], ['4096', true]]);
    });
    it('splits a narrow but consistent gutter, rejoins a section number with its title and tolerates zero-size glyphs', () => {
        // 栏间距只有 1.4 个字宽，但明显大于词距且上下行都让出这条竖带。
        const row = (baseline: number) => [...words('left column words here', 50, baseline, 3), ...words('right column words here', 168, baseline, 3)];
        const narrow = pdfLayoutLines([...row(100), ...row(112), ...row(124)]);
        expect(narrow.filter(line => line.baseline === 112).map(line => line.text)).toEqual(['left column words here', 'right column words here']);
        // 相邻两行的编号与标题之间都留白：先按竖带断开，再把编号并回标题。
        const numbered = pdfLayoutLines([atom('1', 50, 80, 5, 12), atom('Introduction', 69, 80, 90, 12), atom('2', 50, 100, 5, 12), atom('Methods', 69, 100, 60, 12)]);
        expect(numbered.map(line => line.text)).toEqual(['1 Introduction', '2 Methods']);
        expect(pdfLayoutLines([atom('x', 0, 0, 5, 0)])).toHaveLength(1);
    });
    it('attaches a line to the most recent of two eligible paragraphs and rejects a long numbered line that continues below', () => {
        const result = analyze([atom('First paragraph ends here.', 50, 100, 200), atom('indented note keeps going', 60, 106, 200), atom('and this line continues the note', 50, 112, 200)]);
        expect(result.blocks.map(block => block.source)).toEqual(['First paragraph ends here.', 'indented note keeps going and this line continues the note']);
        const footnote = analyze([atom('1 Note that the term frequency refers to something specific', 40, 100, 260), atom('and it continues on a second full line of the same footnote.', 40, 112, 260)]);
        expect(footnote.blocks).toHaveLength(1); expect(footnote.blocks[0]).toMatchObject({kind: 'text', lineCount: 2});
    });
    it('does not chain two lines of one column into a row through a line of the other column with a different leading', () => {
        // 右栏 6.4 号字、行距 8；左栏 8 号字的一行基线落在右栏两行之间。
        const lines = pdfLayoutLines([atom('Learning and Verbal Behavior, 12, 335-359.', 294, 370.2, 130, 6.4), atom('left column line in a larger size', 41, 374.4, 220, 8), atom('Dahan, D., and Tanenhaus, M. K. (2004). Continuous mapping', 282, 378.2, 221, 6.4)]);
        expect(lines.map(line => line.text)).toEqual(['Learning and Verbal Behavior, 12, 335-359.', 'left column line in a larger size', 'Dahan, D., and Tanenhaus, M. K. (2004). Continuous mapping']);
    });
    it('treats slide frames, title bands and filled text boxes as containers while real figures keep their small labels', () => {
        // 幻灯片：占页面大半的内容框里是大字号的短要点，全部是正文。
        const slide = analyze([atom('可靠性', 60, 120, 78, 26), atom('性能', 60, 170, 52, 26), atom('成本', 60, 220, 52, 26)], [{kind: 'image', x: 30, y: 60, width: 660, height: 440}], 720, 540);
        expect(slide.preservedRegions).toEqual([]);
        expect(slide.blocks.every(block => !block.preserveSource && block.kind !== 'figure-label')).toBe(true);
        // 标题色带：一行成句的标题几乎填满色带。
        const band = analyze([atom('嵌入式软件的应用与特点', 43, 60, 430, 39), atom('Body sentence under the title band.', 43, 140, 300, 20)], [{kind: 'path', x: 29, y: 17, width: 649, height: 49}], 720, 540);
        expect(band.preservedRegions).toEqual([]);
        expect(band.blocks.find(block => block.source.startsWith('嵌入式'))?.preserveSource).toBe(false);
        // 带边框的报告页：框内多半是成句的正文行，短行不是小字号标注。
        const framed = analyze([atom('Section', 60, 100, 40), atom('This framed report page keeps ordinary body sentences inside a border.', 60, 130, 420), atom('Another complete sentence continues the framed report body text here.', 60, 160, 420)], [{kind: 'path', x: 40, y: 60, width: 520, height: 600}]);
        expect(framed.preservedRegions).toEqual([]);
        // 许多相接的小底框并成一个大区域时，合并之后同样按容器处理。
        const chained = analyze([atom('第一段说明文字写在底框里面', 50, 80, 300, 14), atom('第二段说明文字也写在底框里面', 50, 330, 300, 14)], [{kind: 'path', x: 40, y: 40, width: 500, height: 262}, {kind: 'path', x: 40, y: 300, width: 500, height: 300}]);
        expect(chained.preservedRegions).toEqual([]);
        // 真正的插图：包围盒圈入了正文，但图内成批的小字短标注说明它仍是插图。
        const labels = ['Kernel', 'Vector', 'Grafana', 'Perfetto', 'Storage'].map((text, index) => atom(text, 60 + index * 90, 100, 30, 6));
        const figure = analyze([...labels, atom('A body sentence that the figure bounding box happens to swallow completely.', 60, 250, 420), atom('It continues with another full sentence of ordinary body text right here.', 60, 262, 420)], [{kind: 'form', x: 0, y: 40, width: 600, height: 400}]);
        expect(figure.preservedRegions.some(region => region.kind === 'figure')).toBe(true);
        expect(figure.blocks.filter(block => block.kind === 'figure-label')).toHaveLength(5);
        // 小插图里只有零星短标注：不够容器的任何一条。
        const small = analyze([atom('Axis', 120, 150, 20, 7), atom('Body text outside the figure stays body text for this page.', 60, 400, 400)], [{kind: 'image', x: 100, y: 100, width: 200, height: 150}]);
        expect(small.preservedRegions.some(region => region.kind === 'figure')).toBe(true);
    });
    it('reads text that is painted twice in place once, and counts CJK sentences inside figures as prose', () => {
        const doubled = pdfLayoutLines([atom('关系数据库标准语言', 190, 280, 252, 28), atom('SQL', 442, 280, 53, 28), atom('关系数据库标准语言', 190.1, 280, 252, 28), atom('SQL', 442.1, 280, 53, 28), atom('  ', 500, 280, 4, 28), atom('SQL', 600, 280, 53, 28)]);
        expect(doubled.map(line => line.text).join(' ')).toBe('关系数据库标准语言SQL SQL');
        // 同一位置但字号不同的同一个字不是重复描字（例如上标与正文字符重叠的排版）。
        expect(pdfLayoutLines([atom('x', 0, 0, 5, 10), atom('x', 0, 0, 5, 10.6)]).map(line => line.text).join('')).toBe('xx');
        const prose = analyze([atom('这是一句写在插图范围里面的完整中文说明', 60, 120, 200, 8), atom('A', 70, 200, 5, 5), atom('B', 140, 200, 5, 5), atom('C', 210, 200, 5, 5), atom('D', 280, 200, 5, 5), atom('Body text below the figure is long enough to set the page body size here.', 60, 500, 420), atom('More body text follows so that the median body font stays at ten points.', 60, 512, 420)], [{kind: 'image', x: 40, y: 100, width: 300, height: 200}]);
        expect(prose.blocks.find(block => block.source.startsWith('这是一句'))).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('keeps loosely spaced word-processor paragraphs together and ends a paragraph at a line that does not reach the column edge', () => {
        const wide = '本课程是计算机大类基础课其作用是将大一新生对计算机已有的感性认识提升';
        const body = (text: string, x: number, baseline: number, width: number) => atom(text, x, baseline, width, 10.5);
        const result = analyze([
            body('1）成绩评定总则', 111, 100, 79),
            body(wide, 111, 119.5, 394), body(wide, 90, 139, 415), body('以闭卷笔试为主。总成绩按以下公式计算：', 90, 158.5, 199),
            body('总成绩＝平时成绩×20%＋实验成绩×20%＋期末成绩×60%', 111, 178, 265),
            body('2）平时成绩评定', 111, 197.5, 79),
            body('This course is a basic course of the computer major and its function', 90, 300, 415), body('is to lift perceptual knowledge into rational knowledge.', 90, 319.5, 300),
            body('A second English paragraph starts right below the short closing line', 90, 339, 415), body('and it continues on a second full line of the very same paragraph here', 90, 358.5, 415),
        ]);
        expect(result.blocks.map(block => block.lineCount)).toEqual([1, 3, 1, 1, 2, 2]);
        // 中文折行处不补空格。
        expect(result.blocks[1].source).toBe(`${wide}${wide}以闭卷笔试为主。总成绩按以下公式计算：`);
        expect(result.blocks[4].source).toContain('function is to lift');
        // 悬挂缩进的条目：首行排满，缩进的续行即使更短也仍属于同一条目。
        const hanging = analyze([atom('[1] A reference entry whose first line fills the whole column width.', 60, 100, 420), atom('Its continuation is indented.', 75, 112, 150), atom('[2] The next reference entry starts back at the left margin again.', 60, 124, 420)]);
        expect(hanging.blocks.map(block => block.lineCount)).toEqual([2, 1]);
    });
    it('removes the spaces of letter-spaced CJK lines but keeps ordinary spacing', () => {
        const spaced = analyze([atom('院 级 党 课 结 业 心 得', 200, 100, 200, 16), atom('学 院： 计 算 机 学 院', 200, 200, 200, 16)]);
        expect(spaced.blocks.map(block => block.source)).toEqual(['院级党课结业心得', '学院：计算机学院']);
        expect(analyze([atom('建议教材 吕云翔 傅尔也 译', 60, 100, 200)]).blocks[0].source).toBe('建议教材 吕云翔 傅尔也 译');
        expect(analyze([atom('第 4 页', 60, 100, 60)]).blocks[0].source).toBe('第 4 页');
    });
    it('keeps an author byline out of the headings and drops a raised footnote mark from the end of a title', () => {
        const mark = {...atom('q', 130, 94, 8, 9), baseline: 94};
        const page = [atom('The effect of word predictability is logarithmic', 41, 100, 88, 13.4), mark, atom('Nathaniel J. Smith a,⇑, Roger Levy b', 41, 130, 168, 10.6),
            atom('Body text sets the page size and is long enough to be a real sentence here.', 41, 300, 420, 8), atom('More body text follows on the next line of the very same body paragraph.', 41, 310, 420, 8), atom('Kernel Activity and Trace Analysis', 41, 200, 200, 10.6)];
        const result = analyze(page, [], 544, 742);
        expect(result.blocks.find(block => block.source.startsWith('The effect'))).toMatchObject({kind: 'heading', source: 'The effect of word predictability is logarithmic'});
        expect(result.blocks.find(block => block.source.startsWith('Nathaniel'))).toMatchObject({kind: 'metadata', preserveSource: true});
        // 只用 and 连接的标题仍是标题；页面下半部分或上方没有更大标题时，逗号分隔的词组也不算署名。
        expect(result.blocks.find(block => block.source.startsWith('Kernel'))?.kind).toBe('heading');
        expect(analyze([atom('Ashish Vaswani, Noam Shazeer, Niki Parmar', 41, 130, 300, 14), atom('Body text sets the page size and is long enough to be a real sentence here.', 41, 300, 420, 8), atom('More body text follows on the next line of the very same body paragraph.', 41, 310, 420, 8)]).blocks[0].kind).toBe('heading');
        // 标题末尾同一基线上的普通字母不是脚注标记。
        expect(analyze([atom('Appendix', 41, 100, 60, 14), atom('B', 105, 100, 8, 9), atom('Body text sets the page size and is long enough to be a real sentence here.', 41, 300, 420, 8), atom('More body text follows on the next line of the very same body paragraph.', 41, 310, 420, 8)]).blocks[0].source).toBe('Appendix B');
    });
    it('leaves bullet glyphs on the page, starts a block at every bullet and translates large text inside slide diagrams', () => {
        const slide = analyze([
            atom('u', 60, 100, 10, 22), atom('Compiler and linker', 75, 100, 200, 22), atom('u', 60, 130, 10, 22), atom('Debugger', 75, 130, 100, 22),
            atom('n', 40, 200, 10, 26), atom('典型的开发环境', 60, 200, 180, 26), atom('•', 60, 260, 6, 22), atom('real-time kernel', 75, 260, 160, 22),
            atom('源程序', 494, 400, 54, 18), atom('n', 60, 320, 10, 22), atom('is the number of tasks', 75, 320, 220, 22),
        ], [{kind: 'path', x: 480, y: 380, width: 87, height: 60}, {kind: 'path', x: 560, y: 380, width: 87, height: 60}], 720, 540);
        expect(slide.blocks.map(block => block.source)).toEqual(['Compiler and linker', 'Debugger', '典型的开发环境', 'real-time kernel', 'n is the number of tasks', '源程序']);
        expect(slide.blocks.find(block => block.source === 'Compiler and linker')).toMatchObject({x: 75, width: 200});
        expect(slide.blocks.find(block => block.source === '源程序')).toMatchObject({kind: 'text', preserveSource: false});
        // 只出现一次、后面跟小写英文的单个字母是变量而不是项目符号；两行都以它开头时才是。
        const twice = analyze([atom('n', 60, 100, 6), atom('First point', 75, 100, 100), atom('n', 60, 112, 6), atom('Second point', 75, 112, 100)]);
        expect(twice.blocks.map(block => block.source)).toEqual(['First point', 'Second point']);
    });
    it('orders two columns by their body paragraphs: narrow labels join the column that covers them and a straddling block does not merge the columns', () => {
        const body = (tag: string, x: number, top: number) => [0, 1, 2].map(row => atom(`${tag} body line ${row} is a full justified line of ordinary column text`, x, top + row * 12, 240));
        const label = (tag: string, x: number) => [atom(`${tag} upper`, x, 70, 40, 8), atom(`${tag} lower`, x, 79, 40, 8)];
        // 右栏顶部并排的两个两行小标注都被下方的正文段落盖住：它们属于右栏，按上下顺序排在段落之前。
        const absorbed = analyze([...body('Left', 54, 100), ...label('Alpha', 330), ...label('Beta', 420), ...body('Right', 318, 110)]);
        expect(absorbed.blocks.map(block => block.source.split(' ').slice(0, 2).join(' '))).toEqual(['Left body', 'Alpha upper', 'Beta upper', 'Right body']);
        // 横跨两栏的两行说明只碰到两栏各一部分：归入左栏，两栏仍然先左后右。
        const straddling = analyze([atom('A two line note that straddles the gutter between both of the columns', 150, 60, 310), atom('and continues on a second line of exactly the same width as before', 150, 72, 310), ...body('Left', 54, 100), ...body('Right', 318, 100), ...body('Left again', 54, 160), ...body('Right again', 318, 160)]);
        expect(straddling.blocks.map(block => block.source.split(' ').slice(0, 2).join(' '))).toEqual(['A two', 'Left body', 'Left again', 'Right body', 'Right again']);
    });
    it('keeps radical-bar ligature runs as formula fragments and splits merged table cells that collide with a neighbour', () => {
        const radical = analyze([atom('pkffiffiffiffiffiffiffiffi', 60, 100, 60), atom('Body text sets the page size and is long enough to be a real sentence here.', 60, 300, 420), atom('More body text follows on the next line of the very same body paragraph.', 60, 312, 420)]);
        expect(radical.blocks.find(block => block.source.startsWith('pkffi'))).toMatchObject({kind: 'formula', preserveSource: true});
        // 散落的上下标同样不是句子；带空格的中文单字和普通短语不受影响。
        expect(analyze([atom('i k k 1 k word', 60, 100, 60)]).blocks[0]).toMatchObject({kind: 'formula', preserveSource: true});
        expect(analyze([atom('a b', 60, 100, 20), atom('Plan B is ready', 60, 200, 80)]).blocks.map(block => block.kind)).toEqual(['formula', 'text']);
        // 落在段落矩形里的小字号孤立短词是没有并回行内的下标；段落外的同样短词仍是正文。
        const stray = analyze([atom('It will be easier to work with this after taking the logarithm of both', 60, 100, 420), atom('sides of the equation and moving the constant term over to the left', 60, 112, 420), atom('so that every remaining term of the model is a simple linear function.', 60, 124, 420), atom('word', 300, 106, 14, 6), atom('word', 300, 400, 14, 6)]);
        expect(stray.blocks.filter(block => block.source === 'word').map(block => block.kind).sort()).toEqual(['formula', 'text']);
        // 表头第一行“Diagnostic”与下一行以小写开头的“analysis”会并成一个两行单元格，它的矩形压到了旁边的“Always”，于是退回一行一个单元格。
        const rules = [{kind: 'path' as const, x: 50, y: 90, width: 400, height: 0}, {kind: 'path' as const, x: 50, y: 150, width: 400, height: 0}];
        const table = analyze([atom('Diagnostic', 200, 106, 60, 6), atom('analysis', 205, 115, 40, 6), atom('Always', 230, 111, 50, 6), atom('Body text sets the page size and is long enough to be a real sentence here.', 50, 300, 420), atom('More body text follows on the next line of the very same body paragraph.', 50, 312, 420)], rules);
        expect(table.blocks.filter(block => block.kind === 'table').map(block => block.source).sort()).toEqual(['Always', 'Diagnostic', 'analysis']);
        // 没有压到别的块时，续行仍并入同一个单元格。
        const kept = analyze([atom('Diagnostic', 200, 106, 60, 6), atom('analysis', 205, 115, 40, 6), atom('Body text sets the page size and is long enough to be a real sentence here.', 50, 300, 420), atom('More body text follows on the next line of the very same body paragraph.', 50, 312, 420)], rules);
        expect(kept.blocks.filter(block => block.kind === 'table').map(block => block.source)).toEqual(['Diagnostic analysis']);
    });
    it('keeps an author grid without e-mail addresses as source when names and affiliations sit in columns under the title', () => {
        const row = (texts: string[], baseline: number, size: number) => texts.map((text, index) => atom(text, 150 + index * 130, baseline, 70, size));
        const body = [atom('Abstract', 100, 300, 50, 12), atom('Large scale training needs always-on observability for effective diagnosis of slow jobs.', 100, 320, 240), atom('Coarse monitors cannot localise root causes and fine profilers cost far too much to keep.', 100, 332, 240)];
        const grid = analyze([atom('A Production Scale Tracing System', 150, 100, 320, 20), ...row(['Jia Zhou', 'Long Zeng', 'Clavis Chen'], 140, 12), ...row(['Tencent', 'Tencent', 'Tencent'], 154, 10), atom('Ray Ying', 215, 180, 70, 12), atom('Key Zhang', 345, 180, 70, 12), ...body]);
        // 姓名与紧贴其下的单位并成一个作者块；整块保留原样，网格下方落单的两位作者同样属于作者区。
        expect(grid.blocks.filter(block => block.kind === 'metadata').map(block => block.source).sort()).toEqual(['Clavis Chen Tencent', 'Jia Zhou Tencent', 'Key Zhang', 'Long Zeng Tencent', 'Ray Ying']);
        expect(grid.blocks.filter(block => block.kind === 'metadata').every(block => block.preserveSource)).toBe(true);
        expect(grid.blocks.find(block => block.source === 'Abstract')?.preserveSource).toBe(false);
        // 只有一行三列的短词，或者上方没有更大的标题，都不是作者区。
        const single = analyze([atom('A Production Scale Tracing System', 150, 100, 320, 20), ...row(['Reliability', 'Performance', 'Cost'], 140, 12), ...body]);
        expect(single.blocks.some(block => block.kind === 'metadata')).toBe(false);
        const untitled = analyze([...row(['Jia Zhou', 'Long Zeng', 'Clavis Chen'], 140, 12), ...row(['Tencent', 'Tencent', 'Tencent'], 154, 12), ...body.map(entry => ({...entry, fontSize: 12}))]);
        expect(untitled.blocks.some(block => block.kind === 'metadata')).toBe(false);
    });
    it('keeps table-of-contents leaders and page numbers on the page and translates only the entry title', () => {
        const dots = '.'.repeat(40);
        // 标题与引导点在同一个字形片段里：行宽收到标题文字为止；页码是单独的片段，不再进入任何版面块。
        const single = analyze([atom(`《计算机导论》${dots}`, 100, 100, 400, 10.5), atom('12', 505, 100, 10, 10.5), atom(`Chapter 2 Data Structures ${dots}`, 100, 120, 400, 10.5), atom('34', 505, 120, 10, 10.5)]);
        expect(single.blocks.map(block => block.source)).toEqual(['《计算机导论》', 'Chapter 2 Data Structures']);
        expect(single.blocks[0].width).toBeGreaterThan(60); expect(single.blocks[0].width).toBeLessThan(200);
        expect(single.blocks[1].width).toBeGreaterThan(90); expect(single.blocks[1].width).toBeLessThan(260);
        // 标题、引导点分属不同片段：整段标题片段保留，引导点片段丢弃。
        const split = analyze([atom('Introduction', 100, 100, 60), atom(dots, 162, 100, 300), atom('7', 465, 100, 5)]);
        expect(split.blocks).toHaveLength(1);
        expect(split.blocks[0]).toMatchObject({source: 'Introduction', x: 100, width: 60});
        // 行距宽松的目录里，相邻条目各自成段；带项目符号的条目同样如此，条目后面的普通行也不并入条目。
        const listed = analyze([atom('•', 88, 100, 6, 10.5), ...[0, 1, 2, 3].map(row => atom(`《课程名称之${row}》${dots}`, 100, 100 + row * 18, 400, 10.5)), atom('附注说明', 100, 172, 42, 10.5)]);
        expect(listed.blocks.map(block => block.source)).toEqual(['《课程名称之0》', '《课程名称之1》', '《课程名称之2》', '《课程名称之3》', '附注说明']);
        // 句末的省略号和少量的点不是引导点。
        expect(analyze([atom('He paused for a while...', 100, 100, 120)]).blocks[0].source).toBe('He paused for a while...');
    });
    it('keeps a large journal name inside a paper header figure as part of the figure', () => {
        const paper = analyze([atom('Cognition', 243, 95, 65, 13.9), atom('Body text sets the page size and is long enough to be a real sentence here.', 41, 300, 420, 8), atom('More body text follows on the next line of the very same body paragraph.', 41, 310, 420, 8)], [{kind: 'image', x: 41, y: 35, width: 466, height: 100}]);
        expect(paper.blocks.find(block => block.source === 'Cognition')).toMatchObject({kind: 'figure-label', preserveSource: true});
    });
    it('falls back to a default body size when a page only has tiny glyphs', () => {
        expect(analyze([atom('tiny', 40, 100, 20, 4)]).blocks).toHaveLength(1);
    });
});
